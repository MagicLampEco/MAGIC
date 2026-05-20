// MagicSDK/tests/withdrawLamp.test.ts — unit tests for newest-first selection.

import { describe, it, expect } from "vitest";
import { removeNewestFirst } from "../src/withdrawLamp.js";

type Holding = { amount: bigint; acquired_epoch: bigint; is_locked: boolean };

const h = (amount: bigint, epoch: bigint, locked = false): Holding =>
  ({ amount, acquired_epoch: epoch, is_locked: locked });

const sumFree = (hs: Holding[]) => hs.filter(x => !x.is_locked).reduce((s, x) => s + x.amount, 0n);
const sumAll  = (hs: Holding[]) => hs.reduce((s, x) => s + x.amount, 0n);

describe("removeNewestFirst — LF-preserving selection", () => {
  it("removes from youngest holding first", () => {
    const before = [h(100n, 10n), h(200n, 20n), h(50n, 30n)];   // oldest=10, newest=30
    const after  = removeNewestFirst(before, 50n);
    // Should consume the entire epoch-30 holding (50 oil)
    expect(sumFree(after)).toBe(300n);
    expect(after.find(x => x.acquired_epoch === 30n)).toBeUndefined();
    expect(after.find(x => x.acquired_epoch === 20n)?.amount).toBe(200n);
    expect(after.find(x => x.acquired_epoch === 10n)?.amount).toBe(100n);
  });

  it("partial consumes newest when remainder > newest amount", () => {
    const before = [h(100n, 10n), h(200n, 20n), h(50n, 30n)];
    const after  = removeNewestFirst(before, 120n);
    // 50 from epoch-30, 70 from epoch-20 → epoch-20 left with 130, epoch-10 untouched
    expect(sumFree(after)).toBe(230n);
    expect(after.find(x => x.acquired_epoch === 30n)).toBeUndefined();
    expect(after.find(x => x.acquired_epoch === 20n)?.amount).toBe(130n);
    expect(after.find(x => x.acquired_epoch === 10n)?.amount).toBe(100n);
  });

  it("preserves OLDEST when partial — maximizes future LF", () => {
    const before = [h(1000n, 5n), h(1000n, 100n)];  // 5 = very old, 100 = recent
    const after  = removeNewestFirst(before, 800n);
    // Consume 800 from epoch-100, oldest (epoch-5) untouched
    expect(after.find(x => x.acquired_epoch === 5n)?.amount).toBe(1000n);
    expect(after.find(x => x.acquired_epoch === 100n)?.amount).toBe(200n);
  });

  it("never touches locked holdings", () => {
    const before = [
      h(500n, 10n, true),    // locked — must NOT be touched
      h(300n, 30n, false),   // newest free
      h(200n, 20n, false),   // older free
    ];
    const after = removeNewestFirst(before, 400n);
    // Consume 300 from epoch-30, 100 from epoch-20. Locked epoch-10 unchanged.
    const locked = after.filter(x => x.is_locked);
    expect(locked).toHaveLength(1);
    expect(locked[0]!.amount).toBe(500n);
    expect(locked[0]!.acquired_epoch).toBe(10n);

    const free = after.filter(x => !x.is_locked);
    expect(sumFree(after)).toBe(100n);
    expect(free.find(x => x.acquired_epoch === 30n)).toBeUndefined();
    expect(free.find(x => x.acquired_epoch === 20n)?.amount).toBe(100n);
  });

  it("conservation: sum_all(before) - amount == sum_all(after)", () => {
    const before = [h(100n, 1n), h(200n, 2n), h(300n, 3n)];
    const after  = removeNewestFirst(before, 150n);
    expect(sumAll(after)).toBe(sumAll(before) - 150n);
  });

  it("throws if amount > total unlocked", () => {
    const before = [h(100n, 10n, true), h(50n, 20n)];   // free = 50, locked = 100
    expect(() => removeNewestFirst(before, 60n)).toThrow("WITHDRAW-003");
  });

  it("amount=0 preserves holdings (content + sum)", () => {
    const before = [h(100n, 10n), h(200n, 20n)];
    const after  = removeNewestFirst(before, 0n);
    // Order may differ (we sort newest-first internally). Compare as sets.
    expect(sumAll(after)).toBe(sumAll(before));
    expect(after).toHaveLength(2);
    expect(after.find(x => x.acquired_epoch === 10n)?.amount).toBe(100n);
    expect(after.find(x => x.acquired_epoch === 20n)?.amount).toBe(200n);
  });

  it("fully drains all unlocked when amount == total free", () => {
    const before = [h(100n, 10n), h(200n, 20n), h(50n, 30n, true)];
    const after  = removeNewestFirst(before, 300n);
    // All unlocked gone; locked remains
    expect(after.filter(x => !x.is_locked)).toEqual([]);
    expect(after.filter(x => x.is_locked)).toHaveLength(1);
  });
});
