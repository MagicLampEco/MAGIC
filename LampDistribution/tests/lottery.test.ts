import { describe, it, expect } from "vitest";
import {
  ceilDiv, winThreshold, ticketWins, runLottery, bytesToBigIntBE,
} from "../offchain/src/lottery.js";
import { Q, TARGET_RATE_Q, P_GENESIS } from "../offchain/src/constants.js";
import { hexToBytes } from "../offchain/src/merkle.js";
import type { LotteryAccount } from "../offchain/src/types.js";

const NONCE = "00".repeat(32);  // 32-byte test nonce

describe("ceilDiv (matches onchain ceil_div)", () => {
  it("exact / round-up / one / zero", () => {
    expect(ceilDiv(200n, 100n)).toBe(2n);
    expect(ceilDiv(243n, 100n)).toBe(3n);
    expect(ceilDiv(1n, 100n)).toBe(1n);
    expect(ceilDiv(0n, 100n)).toBe(0n);
  });
  it("rejects bad divisor", () => {
    expect(() => ceilDiv(10n, 0n)).toThrow();
  });
});

describe("win threshold", () => {
  it("threshold = target_rate × 2^256 / Q", () => {
    expect(winThreshold()).toBe((TARGET_RATE_Q * (1n << 256n)) / Q);
  });
  it("p=0 → never wins; p=Q(100%) → always wins", () => {
    const tZero = winThreshold(0n);
    const tFull = winThreshold(Q);
    expect(tZero).toBe(0n);
    // full = 2^256 → mọi seed (< 2^256) đều thắng
    expect(tFull).toBe(1n << 256n);
  });
});

describe("ticketWins determinism", () => {
  it("same input → same output", () => {
    const th = winThreshold();
    const a = ticketWins(hexToBytes(NONCE), "aabb", 0n, th);
    const b = ticketWins(hexToBytes(NONCE), "aabb", 0n, th);
    expect(a).toBe(b);
  });
  it("p=100% always wins, p=0 never", () => {
    expect(ticketWins(hexToBytes(NONCE), "aabb", 5n, winThreshold(Q))).toBe(true);
    expect(ticketWins(hexToBytes(NONCE), "aabb", 5n, winThreshold(0n))).toBe(false);
  });
  it("bytesToBigIntBE big-endian", () => {
    expect(bytesToBigIntBE(hexToBytes("0000000000000001"))).toBe(1n);
    expect(bytesToBigIntBE(hexToBytes("0100"))).toBe(256n);
  });
});

describe("runLottery core (§5.4)", () => {
  const accounts: LotteryAccount[] = [
    { owner: "a1", claimedCum: 243_000_000n, wonCumPrev: 0n },  // 243 LAMP
    { owner: "b2", claimedCum: 1_000_000_000n, wonCumPrev: 0n }, // 1000 LAMP
  ];

  it("p=100% → won = full remaining (capped, §5.4 min)", () => {
    // p=Q → mọi ticket thắng → d=D → min(D×P, remaining)=remaining
    const res = runLottery(accounts, { nonceHex: NONCE, P: P_GENESIS, targetRateQ: Q });
    const a = res.find(r => r.owner === "a1")!;
    expect(a.wonThis).toBe(243_000_000n);       // toàn bộ remaining
    expect(a.wonCumNew).toBe(243_000_000n);
    expect(a.tickets).toBe(3n);                  // ceil(243/100)=3
    expect(a.wins).toBe(3n);
  });

  it("p=0 → won = 0", () => {
    const res = runLottery(accounts, { nonceHex: NONCE, P: P_GENESIS, targetRateQ: 0n });
    expect(res.every(r => r.wonThis === 0n)).toBe(true);
    expect(res.every(r => r.wonCumNew === r.wonThis + 0n)).toBe(true);
  });

  it("won never exceeds remaining (invariant)", () => {
    const res = runLottery(accounts, { nonceHex: NONCE, P: P_GENESIS, targetRateQ: Q });
    for (const r of res) {
      const acc = accounts.find(a => a.owner === r.owner)!;
      expect(r.wonThis).toBeLessThanOrEqual(acc.claimedCum - acc.wonCumPrev);
    }
  });

  it("monotonic: wonCumNew ≥ wonCumPrev", () => {
    const prev: LotteryAccount[] = [{ owner: "a1", claimedCum: 500_000_000n, wonCumPrev: 100_000_000n }];
    const res = runLottery(prev, { nonceHex: NONCE, P: P_GENESIS, targetRateQ: Q });
    expect(res[0]!.wonCumNew).toBeGreaterThanOrEqual(100_000_000n);
  });

  it("fully-won wallet (remaining=0) → no change", () => {
    const done: LotteryAccount[] = [{ owner: "a1", claimedCum: 500_000_000n, wonCumPrev: 500_000_000n }];
    const res = runLottery(done, { nonceHex: NONCE, P: P_GENESIS, targetRateQ: Q });
    expect(res[0]!.wonThis).toBe(0n);
    expect(res[0]!.wonCumNew).toBe(500_000_000n);
    expect(res[0]!.tickets).toBe(0n);
  });

  it("rejects bad nonce length + huge ticket count", () => {
    expect(() => runLottery(accounts, { nonceHex: "00", P: P_GENESIS })).toThrow();
    expect(() => runLottery(
      [{ owner: "a1", claimedCum: 10n ** 16n, wonCumPrev: 0n }],
      { nonceHex: NONCE, P: P_GENESIS, maxTicketsPerWallet: 10n },
    )).toThrow();
  });

  it("statistical sanity: ~target_rate win fraction on many tickets", () => {
    // 1 wallet, P=1 oil, remaining=2000 oil → 2000 tickets. p=10% → ~200 wins ±sai số.
    const big: LotteryAccount[] = [{ owner: "57a7", claimedCum: 2000n, wonCumPrev: 0n }];
    const res = runLottery(big, { nonceHex: "11".repeat(32), P: 1n, targetRateQ: 100_000_000n }); // 10%
    const r = res[0]!;
    expect(r.tickets).toBe(2000n);
    // 10% của 2000 = 200; cho phép biên ±40%
    expect(Number(r.wins)).toBeGreaterThan(120);
    expect(Number(r.wins)).toBeLessThan(280);
  });
});
