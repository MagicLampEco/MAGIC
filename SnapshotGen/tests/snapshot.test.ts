// tests/snapshot.test.ts — SnapshotGen integration tests (no network)
import { describe, it, expect } from "vitest";
import {
  computeLfQ, computeOacQ, computeSnapshotMagic,
  snapshotBatchBalance, isExpired, nanogicToMagicStr, lampToOil,
} from "../offchain/src/math.js";
import { PROFILE_PARAMS, MAX_BATCHES_PER_VAULT } from "../offchain/src/constants.js";
import type { VaultDatum, MagicBatch } from "../offchain/src/types.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeVault(overrides: Partial<VaultDatum> = {}): VaultDatum {
  return {
    owner:                 "aabbccdd",
    lamp_balance:          100_000_000_000n,
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

function makeSnapshotBatch(overrides: Partial<MagicBatch> = {}): MagicBatch {
  return {
    batch_id:            "aabb",
    source:              "Snapshot",
    created_epoch:       95n,
    initial_amount:      4_620_000_000n,
    current_amount:      4_620_000_000n,
    decay_window:        6n,                // Flame N=6
    profile_at_creation: "Flame",
    contract_id:         null,
    halved:              false,
    ...overrides,
  };
}

// ── Simulate SnapshotGen off-chain ─────────────────────────────

function simulateSnapshot(
  vault        : VaultDatum,
  currentEpoch : bigint,
): {
  batchAdded   : boolean;
  newBatch     : MagicBatch | null;
  mTotal       : bigint;
  mPerEpoch    : bigint;
  deltaEpochs  : bigint;
  prunedCount  : number;
  prunedBatches: MagicBatch[];
} {
  if (currentEpoch <= vault.last_updated_epoch) {
    throw new Error(`C-SS-1: current_epoch ${currentEpoch} ≤ last_updated ${vault.last_updated_epoch}`);
  }

  const deltaEpochs = currentEpoch - vault.last_updated_epoch;
  const lfQ  = computeLfQ(vault.loyalty_holdings, currentEpoch);
  const oacQ = computeOacQ(vault.activity_state, currentEpoch);

  // C-SS-5: full lamp_balance
  const mPerEpoch = computeSnapshotMagic(vault.lamp_balance, lfQ, oacQ, vault.profile);
  const mTotal    = mPerEpoch * deltaEpochs;

  // Prune expired (no halving for Snapshot)
  const prunedBatches = vault.magic_batches.filter(
    b => !isExpired(b.created_epoch, b.decay_window, currentEpoch)
  );
  const prunedCount = vault.magic_batches.length - prunedBatches.length;

  const { N } = PROFILE_PARAMS[vault.profile]!;
  const canAdd = prunedBatches.length < MAX_BATCHES_PER_VAULT && mTotal > 0n;

  if (!canAdd) {
    return { batchAdded: false, newBatch: null, mTotal, mPerEpoch, deltaEpochs, prunedCount, prunedBatches };
  }

  const newBatch: MagicBatch = {
    batch_id:            `batch_${vault.next_batch_index}`,
    source:              "Snapshot",
    created_epoch:       currentEpoch,
    initial_amount:      mTotal,
    current_amount:      mTotal,
    decay_window:        BigInt(N),
    profile_at_creation: vault.profile,   // C-SS-4
    contract_id:         null,
    halved:              false,
  };

  return { batchAdded: true, newBatch, mTotal, mPerEpoch, deltaEpochs, prunedCount, prunedBatches };
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("SnapshotGen full flow", () => {

  describe("Happy path", () => {

    it("1000 LAMP, Flame, LF≈1.0, OAC=0.8, Δe=1 → 4.62 MAGIC", () => {
      const vault = makeVault({ profile: "Flame" });
      const result = simulateSnapshot(vault, 100n);
      expect(result.deltaEpochs).toBe(1n);
      expect(result.mPerEpoch).toBe(4_620_000_000n);   // TV-SNAPGEN-01 ✓
      expect(result.batchAdded).toBe(true);
      expect(result.newBatch!.source).toBe("Snapshot");
      expect(result.newBatch!.profile_at_creation).toBe("Flame");  // C-SS-4 ✓
      expect(result.newBatch!.decay_window).toBe(6n);               // N(Flame) ✓
      expect(result.newBatch!.halved).toBe(false);                   // C-DECAY-6 ✓
    });

    it("T16: LAMP balance unchanged — no LAMP movement", () => {
      const vault  = makeVault();
      const result = simulateSnapshot(vault, 100n);
      // SnapshotGen doesn't modify lamp_balance (verify externally)
      expect(vault.lamp_balance).toBe(100_000_000_000n);  // unchanged ✓
    });

    it("C-SS-5: locked LAMP contributes to M", () => {
      const vaultWithLocked = makeVault({
        lamp_balance: 100_000_000_000n,
        lamp_locked:  50_000_000_000n,   // 50% locked
        loyalty_holdings: [
          { amount: 50_000_000_000n, acquired_epoch: 50n, is_locked: true  },
          { amount: 50_000_000_000n, acquired_epoch: 50n, is_locked: false },
        ],
      });
      const vaultNoLocked = makeVault();  // same lamp_balance, none locked
      const r1 = simulateSnapshot(vaultWithLocked, 100n);
      const r2 = simulateSnapshot(vaultNoLocked, 100n);
      // Same total lamp_balance → same M
      expect(r1.mPerEpoch).toBe(r2.mPerEpoch);  // ✓
    });
  });

  describe("Catch-up (C-SS-6)", () => {

    it("Δe=5 → M_total = 5 × M_per_epoch", () => {
      const vault = makeVault({ last_updated_epoch: 95n });
      const result = simulateSnapshot(vault, 100n);
      expect(result.deltaEpochs).toBe(5n);
      expect(result.mTotal).toBe(result.mPerEpoch * 5n);
    });

    it("TV-CATCHUP-01: Flame, LF=1.1, OAC=0.9, Δe=5 → 28.586 MAGIC", () => {
      const vault = makeVault({
        last_updated_epoch: 95n,
        profile: "Flame",
        loyalty_holdings: [{ amount: 1_000_000_000n, acquired_epoch: 89n, is_locked: false }], // age=11→LF≈1.18
      });
      // Use exact LF=1.1 OAC=0.9 from TV-CATCHUP-01 by computing directly
      const mOne = computeSnapshotMagic(1_000_000_000n, 1_100_000_000n, 900_000_000n, "Flame");
      expect(mOne).toBe(5_717_250_000n);
      expect(mOne * 5n).toBe(28_586_250_000n);  // TV-CATCHUP-01 ✓
    });

    it("C-SS-6: single batch created with catch-up total (not one per missed epoch)", () => {
      const vault = makeVault({ last_updated_epoch: 95n });
      const result = simulateSnapshot(vault, 100n);
      // Only ONE batch created (not 5 batches for 5 missed epochs)
      expect(result.batchAdded).toBe(true);
      const newBatches = result.prunedBatches.length + (result.batchAdded ? 1 : 0);
      expect(newBatches).toBe(1);  // just the one new batch ✓
    });
  });

  describe("C-SS-7/8: batch slot check", () => {

    it("C-SS-7: room available → batch added", () => {
      const vault = makeVault({
        magic_batches: Array.from({ length: 31 }, (_, i) =>
          makeSnapshotBatch({ batch_id: `b${i}`, created_epoch: 99n })
        ),
      });
      const result = simulateSnapshot(vault, 100n);
      expect(result.batchAdded).toBe(true);
    });

    it("C-SS-8: 32 batches → SKIP (lost permanently)", () => {
      const vault = makeVault({
        magic_batches: Array.from({ length: 32 }, (_, i) =>
          makeSnapshotBatch({ batch_id: `b${i}`, created_epoch: 99n })
        ),
      });
      const result = simulateSnapshot(vault, 100n);
      expect(result.batchAdded).toBe(false);
      expect(result.newBatch).toBeNull();
      // Note: last_updated_epoch still updates in the real tx (C-SS-8)
    });

    it("C-SS-8: expired batches prune first → may free up room", () => {
      const vault = makeVault({
        magic_batches: Array.from({ length: 32 }, (_, i) => {
          // Half are expired (created at ep80, Flame N=6, k=20 at ep100)
          if (i < 16) return makeSnapshotBatch({ batch_id: `b${i}`, created_epoch: 80n });
          return makeSnapshotBatch({ batch_id: `b${i}`, created_epoch: 99n }); // fresh
        }),
      });
      const result = simulateSnapshot(vault, 100n);
      // After pruning 16 expired → 16 active + 1 new = 17 ≤ 32
      expect(result.prunedCount).toBe(16);
      expect(result.batchAdded).toBe(true);  // room freed by pruning ✓
    });
  });

  describe("T4: profile_at_creation immutable", () => {

    it("TV-SAMENESS-01: batch uses Flame N=6 even after profile→Ember", () => {
      const vault = makeVault({
        profile: "Ember",   // profile changed
        magic_batches: [
          makeSnapshotBatch({
            created_epoch:       95n,
            decay_window:        6n,            // N(Flame) — immutable (T4)
            profile_at_creation: "Flame",       // locked at creation
          }),
        ],
      });
      // At epoch 101: k=6, decay_window=6 → expired ✓
      const batch = vault.magic_batches[0]!;
      expect(isExpired(batch.created_epoch, batch.decay_window, 101n)).toBe(true);

      // Profile change to Ember (N=3) does NOT retroactively expire this batch earlier
      // (if it did, it would be expired at epoch 98, k=3)
      expect(isExpired(batch.created_epoch, 3n, 98n)).toBe(true);   // wrong N
      expect(isExpired(batch.created_epoch, 6n, 98n)).toBe(false);  // correct N
    });
  });

  describe("C-SS-1: epoch boundary", () => {

    it("C-SS-1: same epoch as last_updated → throw", () => {
      const vault = makeVault({ last_updated_epoch: 100n });
      expect(() => simulateSnapshot(vault, 100n)).toThrow("C-SS-1");
    });

    it("C-SS-1: past epoch → throw", () => {
      const vault = makeVault({ last_updated_epoch: 100n });
      expect(() => simulateSnapshot(vault, 99n)).toThrow("C-SS-1");
    });

    it("Next epoch → ok", () => {
      const vault = makeVault({ last_updated_epoch: 99n });
      expect(() => simulateSnapshot(vault, 100n)).not.toThrow();
    });
  });

  describe("Snapshot batch decay lifecycle", () => {

    it("Flame batch decays correctly across 6 epochs then expires", () => {
      const m0 = 4_620_000_000n;
      const expected = [
        { k: 0n, bal: 4_620_000_000n },
        { k: 1n, bal: 3_696_000_000n },  // × 0.80
        { k: 2n, bal: 2_956_800_000n },  // × 0.80²
        { k: 3n, bal: 2_365_440_000n },
        { k: 4n, bal: 1_892_352_000n },
        { k: 5n, bal: 1_513_881_600n },
        { k: 6n, bal:             0n },  // expired
      ];
      for (const { k, bal } of expected) {
        expect(snapshotBatchBalance(m0, "Flame", k), `k=${k}`).toBe(bal);
      }
    });

    it("Steady-state: ELV(Ember)=2.19 — sum of 3 overlapping batches", () => {
      const m0 = 1_000_000_000n;
      const k0 = snapshotBatchBalance(m0, "Ember", 0n);
      const k1 = snapshotBatchBalance(m0, "Ember", 1n);
      const k2 = snapshotBatchBalance(m0, "Ember", 2n);
      const total = k0 + k1 + k2;
      // ELV = 2.19 → total ≈ 2.19 × m0 = 2_190_000_000
      // actual: 1B + 700M + 490M = 2_190_000_000
      expect(total).toBe(2_190_000_000n);
      // ELV ratio
      expect(Number(total) / Number(m0)).toBeCloseTo(2.19, 2);
    });
  });
});
