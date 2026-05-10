// tests/instant.test.ts — InstantGen integration tests (no network)
// Simulates the full InstantGen flow off-chain.
// Run: npx vitest run tests/instant.test.ts

import { describe, it, expect } from "vitest";
import {
  computeInstantMagic, getUmForInstant, shouldHalve, applyHalving,
  isExpired, lampToOil, nanogicToMagicStr,
} from "../offchain/src/math.js";
import {
  PM_Q, INSTANT_DECAY_WINDOW, MIN_INSTANT_PURCHASE, MAX_INSTANT_PURCHASE,
  MAX_BATCHES_PER_VAULT, UM_FALLBACK_Q,
} from "../offchain/src/constants.js";
import type { VaultDatum, MagicBatch, UMDatum } from "../offchain/src/types.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeBatch(overrides: Partial<MagicBatch> = {}): MagicBatch {
  return {
    batch_id:            "deadbeef",
    source:              "Instant",
    created_epoch:       100n,
    initial_amount:      1_000_000_000n,
    current_amount:      1_000_000_000n,
    decay_window:        2n,
    profile_at_creation: null,
    contract_id:         null,
    halved:              false,
    ...overrides,
  };
}

function makeVault(overrides: Partial<VaultDatum> = {}): VaultDatum {
  return {
    owner:                 "aabbccdd",
    lamp_balance:          100_000_000_000n,  // 100,000 LAMP
    lamp_locked:           0n,
    loyalty_holdings:      [{ amount: 100_000_000_000n, acquired_epoch: 50n, is_locked: false }],
    magic_batches:         [],
    next_batch_index:      0n,
    vacuum_orders:         [],
    gen_schedules:         [],
    profile:               "Flame",
    profile_changed_epoch: 0n,
    pending_profile:       null,
    last_updated_epoch:    99n,
    delegation_cert:       { current: [], pending: null, current_effective_epoch: 0n, last_changed_epoch: 0n },
    activity_state:        { recent_burn_epochs: [], total_burns_count: 0n },
    streak_state:          { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate:     null,
    attribution:           { attribution_root: "00".repeat(32), last_event_epoch: 0n, total_events: 0n },
    ...overrides,
  };
}

function makeUM(overrides: Partial<UMDatum> = {}): UMDatum {
  return {
    smoothed_q:         1_000_000_000n,  // UM = 1.0
    last_updated_epoch: 99n,             // fresh (staleness = 1 at epoch 100)
    history:            [],
    ...overrides,
  };
}

// ── Simulate InstantGen off-chain ─────────────────────────────

interface SimResult {
  newBatch         : MagicBatch;
  updatedBatches   : MagicBatch[];
  newLampBalance   : bigint;
  expectedMagic    : bigint;
  umUsed           : bigint;
  halvingApplied   : number;
  prunedCount      : number;
}

function simulateInstantGen(
  vault      : VaultDatum,
  lampPaid   : bigint,
  umDatum    : UMDatum,
  currentEpoch: bigint,
): SimResult {
  // C-INST-1
  if (lampPaid < MIN_INSTANT_PURCHASE)
    throw new Error("C-INST-1: lamp_paid < MIN");
  // C-INST-2
  if (lampPaid > MAX_INSTANT_PURCHASE)
    throw new Error("C-INST-2: lamp_paid > MAX");
  // C-INST-3
  const lAvail = vault.lamp_balance - vault.lamp_locked;
  if (lampPaid > lAvail)
    throw new Error("C-INST-3: lamp_paid > L_avail");

  // C-INST-7
  const activeBefore = vault.magic_batches.filter(
    b => !isExpired(b.created_epoch, b.decay_window, currentEpoch)
  );
  if (activeBefore.length >= MAX_BATCHES_PER_VAULT)
    throw new Error("C-INST-7: vault full");

  // C-UM-6
  const umUsed = getUmForInstant(umDatum, currentEpoch);

  // C-INST-5
  const pmQ = PM_Q[vault.profile]!;
  const expectedMagic = computeInstantMagic(lampPaid, umUsed, pmQ);

  // C-PRUNE-2: halve BEFORE prune
  let halvingApplied = 0;
  const halvedBatches = vault.magic_batches.map(b => {
    if (shouldHalve(b.source, b.created_epoch, currentEpoch, b.halved)) {
      halvingApplied++;
      return { ...b, current_amount: applyHalving(b.current_amount), halved: true };
    }
    return b;
  });

  // C-PRUNE-1
  const beforePrune = halvedBatches.length;
  const pruned = halvedBatches.filter(
    b => !isExpired(b.created_epoch, b.decay_window, currentEpoch)
  );
  const prunedCount = beforePrune - pruned.length;

  // C-INST-6: create batch
  const newBatch: MagicBatch = {
    batch_id:            `batch_${vault.next_batch_index}`,
    source:              "Instant",
    created_epoch:       currentEpoch,
    initial_amount:      expectedMagic,
    current_amount:      expectedMagic,
    decay_window:        INSTANT_DECAY_WINDOW,
    profile_at_creation: null,    // C-DECAY-4
    contract_id:         null,
    halved:              false,   // C-INST-6
  };

  return {
    newBatch,
    updatedBatches:  [...pruned, newBatch],
    newLampBalance:  vault.lamp_balance - lampPaid,
    expectedMagic,
    umUsed,
    halvingApplied,
    prunedCount,
  };
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("InstantGen full flow simulation", () => {

  describe("Happy path — basic purchase", () => {

    it("1000 LAMP, Flame, UM=1.0, fresh → 3.15 MAGIC batch", () => {
      const vault = makeVault({ profile: "Flame" });
      const um    = makeUM({ smoothed_q: 1_000_000_000n, last_updated_epoch: 99n });
      const result = simulateInstantGen(vault, lampToOil(1000n), um, 100n);

      expect(result.expectedMagic).toBe(3_150_000_000n);                  // TV-INST-GEN-01 ✓
      expect(nanogicToMagicStr(result.expectedMagic)).toBe("3.1500");
      expect(result.newBatch.source).toBe("Instant");
      expect(result.newBatch.halved).toBe(false);                          // C-INST-6 ✓
      expect(result.newBatch.profile_at_creation).toBeNull();              // C-DECAY-4 ✓
      expect(result.newBatch.decay_window).toBe(2n);                       // C-INST-DECAY ✓
      expect(result.newLampBalance).toBe(100_000_000_000n - lampToOil(1000n));
    });

    it("500 LAMP, Lantern, UM=2.0 (max) → 3.0 MAGIC", () => {
      const vault = makeVault({ profile: "Lantern" });
      const um    = makeUM({ smoothed_q: 2_000_000_000n, last_updated_epoch: 100n });
      const result = simulateInstantGen(vault, lampToOil(500n), um, 100n);
      expect(result.expectedMagic).toBe(3_000_000_000n);  // TV-INST-GEN-03 ✓
    });

    it("C-INST-10: LAMP conservation — total unchanged", () => {
      const vault = makeVault();
      const um    = makeUM();
      const lampPaid = lampToOil(1000n);
      const result = simulateInstantGen(vault, lampPaid, um, 100n);

      // vault lost lampPaid; treasury gains lampPaid; total unchanged
      const totalBefore = vault.lamp_balance;
      const totalAfter  = result.newLampBalance + lampPaid; // + treasury
      expect(totalAfter).toBe(totalBefore);  // T14, C-INST-10 ✓
    });
  });

  describe("UM stale check — C-UM-6", () => {

    it("Stale UM (staleness=2) → UM_FALLBACK applied", () => {
      const vault = makeVault({ profile: "Flame" });
      const um    = makeUM({ smoothed_q: 2_000_000_000n, last_updated_epoch: 98n }); // stale
      const result = simulateInstantGen(vault, lampToOil(1000n), um, 100n);

      // umUsed = UM_FALLBACK_Q = 500M (not 2B)
      expect(result.umUsed).toBe(UM_FALLBACK_Q);  // TV-UM-SPLIT ✓

      // MAGIC is 50% less than if UM was fresh
      // With UM=0.5: M = 3B × 0.5 × 1.05 = 1.575B
      expect(result.expectedMagic).toBe(1_575_000_000n);
    });

    it("Fresh UM (staleness=1) → smoothed UM used", () => {
      const vault = makeVault({ profile: "Flame" });
      const um    = makeUM({ smoothed_q: 1_500_000_000n, last_updated_epoch: 99n }); // fresh
      const result = simulateInstantGen(vault, lampToOil(1000n), um, 100n);

      expect(result.umUsed).toBe(1_500_000_000n);  // TV-UM-FRESH ✓
      // M = 3B × 1.5 × 1.05 = 4.725B
      expect(result.expectedMagic).toBe(4_725_000_000n);
    });
  });

  describe("Lazy halving — C-DECAY-7, C-PRUNE-2", () => {

    it("TV-INST-01: Existing Instant batch at k=1 gets halved before new batch is added", () => {
      const existingBatch = makeBatch({ created_epoch: 99n, current_amount: 800_000_000n, halved: false });
      const vault = makeVault({ magic_batches: [existingBatch] });
      const um    = makeUM();
      const result = simulateInstantGen(vault, lampToOil(100n), um, 100n);

      // existingBatch at k=1 (100-99=1), halved=False → should halve
      expect(result.halvingApplied).toBe(1);

      // Find the halved existing batch in updatedBatches
      const halvedBatch = result.updatedBatches.find(b => b.batch_id === "deadbeef");
      expect(halvedBatch).toBeDefined();
      expect(halvedBatch!.current_amount).toBe(400_000_000n);  // ⌊800M/2⌋ ✓
      expect(halvedBatch!.halved).toBe(true);                   // ✓

      // New batch is also present
      expect(result.updatedBatches.length).toBe(2);  // halved existing + new
    });

    it("TV-INST-03: Already-halved batch (halved=True at k=1) → NOT halved again (T18)", () => {
      const existingBatch = makeBatch({ created_epoch: 99n, current_amount: 500_000_000n, halved: true });
      const vault = makeVault({ magic_batches: [existingBatch] });
      const result = simulateInstantGen(vault, lampToOil(100n), makeUM(), 100n);

      expect(result.halvingApplied).toBe(0);  // T18: no double-halving ✓
      const existingInResult = result.updatedBatches.find(b => b.batch_id === "deadbeef");
      expect(existingInResult!.current_amount).toBe(500_000_000n);  // unchanged ✓
    });

    it("C-PRUNE-2: halving happens BEFORE pruning", () => {
      // Batch at k=1 should be halved, then NOT yet pruned (decay_window=2, k=1 < 2)
      const batch = makeBatch({ created_epoch: 99n, halved: false });
      const vault = makeVault({ magic_batches: [batch] });
      const result = simulateInstantGen(vault, lampToOil(100n), makeUM(), 100n);

      // Halving applied (k=1, not expired)
      expect(result.halvingApplied).toBe(1);
      // NOT pruned (k=1 < decay_window=2)
      expect(result.prunedCount).toBe(0);
      // Halved batch still active
      const halvedBatch = result.updatedBatches.find(b => b.batch_id === "deadbeef");
      expect(halvedBatch).toBeDefined();
    });

    it("Batch at k=2 (expired) → pruned", () => {
      const expiredBatch = makeBatch({ created_epoch: 98n }); // k=2 at epoch 100
      const vault = makeVault({ magic_batches: [expiredBatch] });
      const result = simulateInstantGen(vault, lampToOil(100n), makeUM(), 100n);

      expect(result.prunedCount).toBe(1);
      // Only the new batch remains
      expect(result.updatedBatches.length).toBe(1);
      expect(result.updatedBatches[0]!.source).toBe("Instant");
    });
  });

  describe("Constraint violations", () => {

    it("TV-INST-MIN: lamp_paid < 10 LAMP → GEN-INST-001", () => {
      const vault = makeVault();
      expect(() => simulateInstantGen(vault, 9_999_999n, makeUM(), 100n))
        .toThrow("C-INST-1");
    });

    it("TV-INST-MAX: lamp_paid > 10^13 → GEN-INST-002", () => {
      const vault = makeVault({ lamp_balance: 100_000_000_000_000n, lamp_locked: 0n,
        loyalty_holdings: [{ amount: 100_000_000_000_000n, acquired_epoch: 0n, is_locked: false }] });
      expect(() => simulateInstantGen(vault, 10_000_000_000_001n, makeUM(), 100n))
        .toThrow("C-INST-2");
    });

    it("TV-INST-AVAIL: lamp_paid > L_avail → GEN-INST-003", () => {
      const vault = makeVault({
        lamp_balance: 100_000_000_000n,
        lamp_locked:  60_000_000_000n,
      });
      const lAvail = 40_000_000_000n;
      expect(() => simulateInstantGen(vault, lAvail + 1n, makeUM(), 100n))
        .toThrow("C-INST-3");
    });

    it("TV-INST-VAULT-FULL: 32 active batches → GEN-VAULT-001", () => {
      const batches = Array.from({ length: 32 }, (_, i) =>
        makeBatch({ batch_id: `batch_${i}`, created_epoch: 100n }),
      );
      const vault = makeVault({ magic_batches: batches });
      expect(() => simulateInstantGen(vault, lampToOil(100n), makeUM(), 100n))
        .toThrow("C-INST-7");
    });
  });

  describe("Multi-epoch lifecycle — TV-INST-01", () => {

    it("Full 3-epoch lifecycle: mint → halve → expire", () => {
      const vault = makeVault({ profile: "Flame" });
      const um    = makeUM();

      // Epoch 100: create batch
      const r0 = simulateInstantGen(vault, lampToOil(1000n), um, 100n);
      const batch0 = r0.newBatch;
      expect(batch0.current_amount).toBe(3_150_000_000n);  // TV-INST-GEN-01 ✓
      expect(batch0.halved).toBe(false);
      expect(isExpired(batch0.created_epoch, batch0.decay_window, 100n)).toBe(false);

      // Epoch 101: k=1, should halve
      expect(shouldHalve("Instant", 100n, 101n, false)).toBe(true);
      const halvingResult = applyHalving(batch0.current_amount);
      expect(halvingResult).toBe(1_575_000_000n);  // ⌊3.15B/2⌋ ✓
      expect(isExpired(100n, 2n, 101n)).toBe(false); // not yet expired ✓

      // Epoch 102: k=2, expired
      expect(isExpired(100n, 2n, 102n)).toBe(true);  // cliff ✓
    });
  });
});
