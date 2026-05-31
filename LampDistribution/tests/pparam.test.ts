import { describe, it, expect } from "vitest";
import { computeNextP, infraWeight } from "../offchain/src/pparam.js";
import { Q, P_MIN, P_MAX, P_GENESIS, MAX_P_DELTA_Q } from "../offchain/src/constants.js";
import type { PSignals } from "../offchain/src/types.js";

function sig(consumed: bigint, generated: bigint, util = 0n): PSignals {
  return { magicConsumed: consumed, magicGenerated: generated, lampnetUtil: util, claimedUnredeemed: 0n };
}

describe("computeNextP (§4)", () => {
  it("balanced demand=supply → P unchanged", () => {
    const r = computeNextP(P_GENESIS, sig(1000n, 1000n), 0n);
    expect(r.ratioQ).toBe(Q);
    expect(r.rawDeltaQ).toBe(0n);
    expect(r.pNext).toBe(P_GENESIS);
  });

  it("demand +8% (within bound) → EMA halves first step", () => {
    // ratio=1.08; raw=0.08Q; ema=(0.08Q+0)/2=0.04Q; bounded=0.04Q; P=100×1.04=104 LAMP
    const r = computeNextP(P_GENESIS, sig(1080n, 1000n), 0n);
    expect(r.rawDeltaQ).toBe(80_000_000n);     // 0.08Q
    expect(r.emaNew).toBe(40_000_000n);        // 0.04Q
    expect(r.boundedQ).toBe(40_000_000n);
    expect(r.pNext).toBe(104_000_000n);        // 104 LAMP
  });

  it("demand +50% → bounded clamps at +10%", () => {
    // ratio=1.5; raw=0.5Q; với ema_prev cao để vượt 10%: ema=(0.5Q+0.5Q)/2=0.5Q→clamp 0.10Q
    const r = computeNextP(P_GENESIS, sig(1500n, 1000n), 0n, );
    // first step ema=0.25Q > 0.10Q → clamp +10% → P=110 LAMP
    expect(r.boundedQ).toBe(MAX_P_DELTA_Q);
    expect(r.pNext).toBe(110_000_000n);
  });

  it("oversupply −20% → bounded clamps at −10%", () => {
    // demand 800, supply 1000 → ratio 0.8 → raw −0.2Q → ema −0.1Q → bounded −0.1Q → P=90
    const r = computeNextP(P_GENESIS, sig(800n, 1000n), 0n);
    expect(r.boundedQ).toBe(-MAX_P_DELTA_Q);
    expect(r.pNext).toBe(90_000_000n);
  });

  it("hard floor P_MIN", () => {
    let p = 11_000_000n;  // 11 LAMP, gần floor 10
    // liên tục oversupply → giảm 10%/epoch nhưng không dưới P_MIN
    for (let i = 0; i < 10; i++) p = computeNextP(p, sig(0n, 1000n), -MAX_P_DELTA_Q).pNext;
    expect(p).toBe(P_MIN);
  });

  it("hard ceiling P_MAX", () => {
    let p = 9_500_000_000n;  // 9500 LAMP, gần ceiling 10000
    for (let i = 0; i < 10; i++) p = computeNextP(p, sig(10000n, 1000n), MAX_P_DELTA_Q).pNext;
    expect(p).toBe(P_MAX);
  });

  it("S2=0 → P unchanged (no div-by-zero)", () => {
    const r = computeNextP(P_GENESIS, sig(1000n, 0n), 0n);
    expect(r.pNext).toBe(P_GENESIS);
    expect(r.boundedQ).toBe(0n);
  });

  it("infra weight folds into demand (S3 raises P)", () => {
    const noInfra = computeNextP(P_GENESIS, sig(1000n, 1000n, 0n), 0n);
    const withInfra = computeNextP(P_GENESIS, sig(1000n, 1000n, 200n), 0n);
    expect(withInfra.ratioQ).toBeGreaterThan(noInfra.ratioQ);
    expect(infraWeight(200n)).toBe(200n);
  });

  it("rejects bad pCurrent", () => {
    expect(() => computeNextP(0n, sig(1n, 1n), 0n)).toThrow();
  });

  it("EMA smoothing dampens oscillation over 3 epochs", () => {
    // demand spike rồi giảm → EMA làm mượt, P không nhảy mạnh
    let ema = 0n;
    let p = P_GENESIS;
    const r1 = computeNextP(p, sig(1200n, 1000n), ema); ema = r1.emaNew; p = r1.pNext;
    const r2 = computeNextP(p, sig(1000n, 1000n), ema); ema = r2.emaNew; p = r2.pNext;
    // sau khi demand về cân bằng, ema vẫn dương nhưng nhỏ dần (mượt)
    expect(r2.emaNew).toBeLessThan(r1.emaNew);
    expect(r2.emaNew).toBeGreaterThanOrEqual(0n);
  });
});
