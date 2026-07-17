// tests/um.test.ts — UM Keeper unit tests
import { describe, it, expect } from "vitest";
import {
  computeUMRaw, clampUM, appendHistory,
  computeSMA, computeNewUM,
} from "../offchain/src/math.js";

const Q        = 1_000_000_000n;
const UM_MIN_Q = 500_000_000n;
const UM_MAX_Q = 2_000_000_000n;

// ── TV-UM-SPLIT (reused from InstantGen) ─────────────────────
describe("computeUMRaw — §14.1 C-UM-1", () => {
  it("burns=mints → raw=Q (neutral 1.0)", () => {
    expect(computeUMRaw(1_000_000_000n, 1_000_000_000n)).toBe(Q);
  });
  it("burns > mints → raw > Q (demand high)", () => {
    expect(computeUMRaw(2_000_000_000n, 1_000_000_000n)).toBe(2_000_000_000n);
  });
  it("burns < mints → raw < Q (demand low)", () => {
    expect(computeUMRaw(500_000_000n, 1_000_000_000n)).toBe(500_000_000n);
  });
  it("mints=0 → denominator=1 (no division by zero)", () => {
    const result = computeUMRaw(1_000_000_000n, 0n);
    expect(result).toBe(1_000_000_000n * Q / 1n);   // very large but valid
  });
});

describe("clampUM — §14.1 C-UM-3", () => {
  it("Within range → unchanged", () => {
    expect(clampUM(Q)).toBe(Q);
    expect(clampUM(UM_MIN_Q)).toBe(UM_MIN_Q);
    expect(clampUM(UM_MAX_Q)).toBe(UM_MAX_Q);
  });
  it("Below MIN → clamped to MIN", () => {
    expect(clampUM(100_000_000n)).toBe(UM_MIN_Q);
  });
  it("Above MAX → clamped to MAX", () => {
    expect(clampUM(5_000_000_000n)).toBe(UM_MAX_Q);
  });
});

describe("appendHistory — §14.1 C-UM-2", () => {
  it("Empty history → [new_raw]", () => {
    expect(appendHistory([], Q)).toEqual([Q]);
  });
  it("History < 6 → append", () => {
    const h = [Q, Q, Q];
    expect(appendHistory(h, UM_MIN_Q)).toHaveLength(4);
  });
  it("History = 6 → drop oldest, append new (sliding window)", () => {
    const h = [1n, 2n, 3n, 4n, 5n, 6n];
    const result = appendHistory(h, 7n);
    expect(result).toEqual([2n, 3n, 4n, 5n, 6n, 7n]);  // 1n dropped ✓
    expect(result).toHaveLength(6);
  });
  it("TV-UM-SPLIT: smoothed=2B, last_updated=98, history=[2B,2B,2B,2B,2B,2B]", () => {
    const h = Array(6).fill(2_000_000_000n);
    const result = appendHistory(h, Q);  // new raw = Q (1.0)
    expect(result).toHaveLength(6);
    // SMA drops one 2B, adds one Q
    const sma = computeSMA(result);
    expect(sma).toBeLessThan(2_000_000_000n);
    expect(sma).toBeGreaterThan(Q);
  });
});

describe("computeSMA — §14.1 C-UM-1", () => {
  it("Single value → that value", () => {
    expect(computeSMA([1_500_000_000n])).toBe(1_500_000_000n);
  });
  it("All same → that value", () => {
    expect(computeSMA([Q, Q, Q, Q])).toBe(Q);
  });
  it("Mix → floor average", () => {
    // [500M, 1B, 1.5B, 2B] → sum=5B / 4 = 1.25B
    expect(computeSMA([500_000_000n, 1_000_000_000n, 1_500_000_000n, 2_000_000_000n]))
      .toBe(1_250_000_000n);
  });
  it("Empty history → Q (neutral)", () => {
    expect(computeSMA([])).toBe(Q);
  });
});

describe("computeNewUM — full update", () => {
  it("Neutral epoch (burns=mints) → smoothed converges toward Q", () => {
    const datum = {
      smoothed_q: 1_500_000_000n,
      last_updated_epoch: 99n,
      history: [1_500_000_000n, 1_500_000_000n, 1_500_000_000n],
    };
    const { newSmoothed, newHistory, newRaw } = computeNewUM(datum, 1_000_000_000n, 1_000_000_000n);
    expect(newRaw).toBe(Q);           // burns=mints → raw=Q
    expect(newHistory).toHaveLength(4);
    expect(newSmoothed).toBeLessThan(1_500_000_000n);  // converging down ✓
    expect(newSmoothed).toBeGreaterThanOrEqual(UM_MIN_Q);
    expect(newSmoothed).toBeLessThanOrEqual(UM_MAX_Q);
  });

  it("High demand (burns >> mints) → smoothed approaches UM_MAX", () => {
    const datum = { smoothed_q: Q, last_updated_epoch: 99n, history: [] };
    const { newSmoothed } = computeNewUM(datum, 10_000_000_000_000n, 1_000_000_000n);
    expect(newSmoothed).toBe(UM_MAX_Q);  // clamped at 2.0 ✓
  });

  it("No burns → raw clamped to UM_MIN, smoothed falls", () => {
    const datum = { smoothed_q: 1_500_000_000n, last_updated_epoch: 99n, history: [1_500_000_000n] };
    const { newSmoothed } = computeNewUM(datum, 0n, 1_000_000_000n);
    expect(newSmoothed).toBeLessThan(1_500_000_000n);
    expect(newSmoothed).toBeGreaterThanOrEqual(UM_MIN_Q);
  });

  it("History stays ≤ 6 entries after 10 updates", () => {
    let datum = { smoothed_q: Q, last_updated_epoch: 90n, history: [] as bigint[] };
    for (let i = 0; i < 10; i++) {
      const { newSmoothed, newHistory } = computeNewUM(datum, 1_000_000_000n, 1_000_000_000n);
      datum = { smoothed_q: newSmoothed, last_updated_epoch: BigInt(91 + i), history: newHistory };
      expect(newHistory.length).toBeLessThanOrEqual(6);  // C-UM-2 ✓
    }
  });

  it("Smoothed always in [UM_MIN_Q, UM_MAX_Q] — C-UM-3", () => {
    const cases = [
      { burns: 0n,              mints: 1_000_000_000n },
      { burns: 1_000_000_000n,  mints: 0n },
      { burns: 10_000_000_000n, mints: 1n },
      { burns: 1n,              mints: 10_000_000_000n },
    ];
    const datum = { smoothed_q: Q, last_updated_epoch: 0n, history: [] as bigint[] };
    for (const { burns, mints } of cases) {
      const { newSmoothed } = computeNewUM(datum, burns, mints);
      expect(newSmoothed).toBeGreaterThanOrEqual(UM_MIN_Q);
      expect(newSmoothed).toBeLessThanOrEqual(UM_MAX_Q);
    }
  });
});
