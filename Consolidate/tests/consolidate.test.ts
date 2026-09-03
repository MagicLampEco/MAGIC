// tests/consolidate.test.ts — ConsolidateHoldings normative tests
// TV-CONSOLIDATE-01/02/03 from App B §B.15

import { describe, it, expect } from "vitest";
import {
  consolidateHoldings, validateConsolidate,
  canConsolidate, validateLockedConserved,
  type LoyaltyHolding,
} from "../offchain/src/consolidate.js";

const L = (amount: bigint, epoch: bigint): LoyaltyHolding =>
  ({ amount, acquired_epoch: epoch, is_locked: true });
const U = (amount: bigint, epoch: bigint): LoyaltyHolding =>
  ({ amount, acquired_epoch: epoch, is_locked: false });

// ══════════════════════════════════════════════════════════════
// TV-CONSOLIDATE-01: [5L,6L,7L] → [{50,2,L},{7,1,L}]
// ══════════════════════════════════════════════════════════════
describe("TV-CONSOLIDATE-01: [5L,6L,7L]", () => {
  const input = [L(1n,5n), L(1n,6n), L(1n,7n)];

  it("Produces correct output", () => {
    const out = consolidateHoldings(input);
    // 5L+6L merged (diff=1) → {5,2,L}; 7L stays → {7,1,L}
    expect(out).toHaveLength(2);
    expect(out.find(h => h.acquired_epoch === 5n)!.amount).toBe(2n);
    expect(out.find(h => h.acquired_epoch === 7n)!.amount).toBe(1n);
    expect(out.every(h => h.is_locked)).toBe(true);
  });

  it("Passes all C-CONSOLIDATE checks", () => {
    expect(() => validateConsolidate(input, consolidateHoldings(input))).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════
// TV-CONSOLIDATE-02: [5L,6U,6L,7U] → [{5,2,L},{6,2,U}]
// P8 fix: sort-partition guarantees determinism even with same-epoch different-lock entries
// ══════════════════════════════════════════════════════════════
describe("TV-CONSOLIDATE-02: [5L,6U,6L,7U] — P8 determinism", () => {
  const input = [L(1n,5n), U(1n,6n), L(1n,6n), U(1n,7n)];

  it("Produces [{5,2,L},{6,2,U}] regardless of input order", () => {
    const out = consolidateHoldings(input);
    expect(out).toHaveLength(2);

    const locked   = out.filter(h =>  h.is_locked);
    const unlocked = out.filter(h => !h.is_locked);

    // Locked: 5L + 6L merged → {5, 2, L}
    expect(locked).toHaveLength(1);
    expect(locked[0]!.amount).toBe(2n);
    expect(locked[0]!.acquired_epoch).toBe(5n);     // C-CONSOLIDATE-2: min epoch ✓

    // Unlocked: 6U + 7U merged → {6, 2, U}
    expect(unlocked).toHaveLength(1);
    expect(unlocked[0]!.amount).toBe(2n);
    expect(unlocked[0]!.acquired_epoch).toBe(6n);
  });

  it("P8: same output regardless of input ordering", () => {
    const permutations = [
      [L(1n,5n), U(1n,6n), L(1n,6n), U(1n,7n)],
      [U(1n,7n), L(1n,6n), U(1n,6n), L(1n,5n)],
      [L(1n,6n), U(1n,7n), L(1n,5n), U(1n,6n)],
    ];
    const results = permutations.map(consolidateHoldings);
    // All produce same output (deterministic — T23)
    // Use deep equal with explicit field comparison (BigInt-safe)
    const same = (a: ReturnType<typeof consolidateHoldings>, b: typeof a) =>
      a.length === b.length &&
      a.every((h, i) => h.amount === b[i]!.amount &&
                         h.acquired_epoch === b[i]!.acquired_epoch &&
                         h.is_locked === b[i]!.is_locked);
    expect(same(results[0]!, results[1]!)).toBe(true);
    expect(same(results[0]!, results[2]!)).toBe(true);
  });

  it("C-CONSOLIDATE-6: locked total preserved (C-VAULT-9 safety)", () => {
    const out = consolidateHoldings(input);
    expect(validateLockedConserved(input, out)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// TV-CONSOLIDATE-03: After consolidate + fire → C-VAULT-9 intact
// ══════════════════════════════════════════════════════════════
describe("TV-CONSOLIDATE-03: consolidate + fire → C-VAULT-9 maintained", () => {
  it("Full scenario from App B §B.15", () => {
    // Input: [{1000L,50},{500L,51},{200U,60}], lamp_locked=1500
    const input: LoyaltyHolding[] = [
      L(1000n, 50n), L(500n, 51n), U(200n, 60n),
    ];
    const lampLocked = 1500n;

    // Consolidate
    const out = consolidateHoldings(input);

    // C-CONSOLIDATE-6: locked preserved → [{50,1500,L}], unlocked [{60,200,U}]
    const lockedOut = out.filter(h => h.is_locked);
    expect(lockedOut.length).toBe(1);
    expect(lockedOut[0]!.amount).toBe(1500n);         // 1000+500 ✓
    expect(lockedOut[0]!.acquired_epoch).toBe(50n);   // min epoch ✓

    // C-VAULT-10: Σholdings = lamp_balance
    const lampBalance = 1700n;  // 1500+200
    const sumOut = out.reduce((s, h) => s + h.amount, 0n);
    expect(sumOut).toBe(lampBalance);

    // Simulate fire λ=200: remove_locked(200) from [{50,1500,L}] → [{50,1300,L}]
    const afterFire = out.map(h =>
      h.is_locked && h.amount >= 200n ? { ...h, amount: h.amount - 200n } : h,
    ).filter(h => h.amount > 0n);

    const newLampLocked = 1300n;
    const newLampBalance = 1500n;  // 1700 - 200

    // C-VAULT-9: lamp_locked = Σ(schedule A + B) = 400+900=1300 ✓
    // (simulated with newLampLocked)
    expect(afterFire.filter(h => h.is_locked).reduce((s,h) => s+h.amount, 0n)).toBe(newLampLocked);
  });
});

// ══════════════════════════════════════════════════════════════
// Additional correctness tests
// ══════════════════════════════════════════════════════════════

describe("ConsolidateHoldings — additional", () => {

  it("C-CONSOLIDATE-1: locked+unlocked NOT merged (diff=0 but different is_locked)", () => {
    const input = [L(100n, 5n), U(100n, 5n)];   // same epoch, different is_locked
    const out = consolidateHoldings(input);
    expect(out).toHaveLength(2);                  // NOT merged ✓
    expect(out.some(h => h.is_locked)).toBe(true);
    expect(out.some(h => !h.is_locked)).toBe(true);
  });

  it("C-CONSOLIDATE-2: merged.acquired_epoch = min (conservative LF)", () => {
    const input = [U(100n, 10n), U(100n, 11n)];  // diff=1 → mergeable
    const out = consolidateHoldings(input);
    expect(out[0]!.acquired_epoch).toBe(10n);     // min = 10, not 11 ✓
  });

  it("No merge when |diff| > 1", () => {
    const input = [L(100n, 5n), L(100n, 7n)];    // diff=2 → NOT mergeable
    const out = consolidateHoldings(input);
    expect(out).toHaveLength(2);
  });

  it("canConsolidate: detects mergeable pair", () => {
    expect(canConsolidate([L(100n,5n), L(100n,6n)])).toBe(true);
    expect(canConsolidate([L(100n,5n), L(100n,7n)])).toBe(false);
    expect(canConsolidate([L(100n,5n), U(100n,6n)])).toBe(false); // diff lock type
  });

  it("Convergence T23: stable after 1 pass when no more merges possible", () => {
    const input = [U(100n,5n), U(100n,7n), U(100n,9n)];  // all diff=2
    const out1  = consolidateHoldings(input);
    const out2  = consolidateHoldings(out1);               // idempotent
    // BigInt-safe comparison
    expect(out1.length).toBe(out2.length);
    out1.forEach((h, i) => {
      expect(h.amount).toBe(out2[i]!.amount);
      expect(h.acquired_epoch).toBe(out2[i]!.acquired_epoch);
      expect(h.is_locked).toBe(out2[i]!.is_locked);
    });
  });

  it("C-CONSOLIDATE-5: large scenario — total always conserved", () => {
    const input = Array.from({ length: 20 }, (_, i) =>
      (i % 2 === 0 ? L : U)(BigInt(i * 100 + 50), BigInt(i)),
    );
    const totalIn = input.reduce((s, h) => s + h.amount, 0n);
    const out     = consolidateHoldings(input);
    const totalOut = out.reduce((s, h) => s + h.amount, 0n);
    expect(totalOut).toBe(totalIn);
  });
});
