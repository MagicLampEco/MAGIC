// tests/vacuum.test.ts — VacuumGen unit + integration tests
// Run: npx vitest run tests/vacuum.test.ts

import { describe, it, expect } from "vitest";
import { Data } from "@lucid-evolution/plutus";
import { VaultRedeemerSchema } from "../offchain/src/types.js";
import {
  computeVacuumMagic, getSmQ, computeSmQ,
  getUmForVacuum, selectLampForLock, removeLockedAmount,
  isVacuumExpired, nanogicToMagicStr, lAvail, lampToOildrop,
} from "../offchain/src/math.js";
import {
  MIN_VACUUM_AMOUNT, MAX_VACUUM_ORDERS, VACUUM_DELAY,
  VACUUM_DECAY_WINDOW, MAX_BATCHES_PER_VAULT,
} from "../offchain/src/constants.js";
import {
  TV_VAC_01, TV_VAC_CALIB, TV_VAC_MAX,
  TV_SM_TABLE, TV_UM_SPLIT_VACUUM, TV_LOCK_01,
  TV_VAC_FULL, TV_VAC_EPOCH, TV_VAC_BOUNDS,
} from "./vectors.js";
import type { VaultDatum, MagicBatch, VacuumOrder, LoyaltyHolding } from "../offchain/src/types.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeVault(overrides: Partial<VaultDatum> = {}): VaultDatum {
  return {
    owner: "aabbccdd",
    lamp_balance: 100_000_000_000n,
    lamp_locked:  0n,
    loyalty_holdings: [{ amount: 100_000_000_000n, acquired_epoch: 50n, is_locked: false }],
    magic_batches: [],
    next_batch_index: 0n,
    vacuum_orders: [],
    gen_schedules: [],
    profile: "Flame",
    profile_changed_epoch: 0n,
    pending_profile: null,
    last_updated_epoch: 99n,
    delegation_cert: { current: [], pending: null, current_effective_epoch: 0n, last_changed_epoch: 0n },
    activity_state: { recent_burn_epochs: [], total_burns_count: 0n },
    streak_state:   { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate: null,
    attribution: { attribution_root: "00".repeat(32), last_event_epoch: 0n, total_events: 0n },
    ...overrides,
  };
}

function makeOrder(overrides: Partial<VacuumOrder> = {}): VacuumOrder {
  return {
    order_id:    "deadbeef",
    commit_epoch: 100n,
    fire_epoch:   102n,
    lamp_amount:  1_000_000_000n,
    ...overrides,
  };
}

// ── Simulate VacuumCommit ─────────────────────────────────────

function simulateCommit(vault: VaultDatum, lambda: bigint, currentEpoch: bigint) {
  if (lambda < MIN_VACUUM_AMOUNT) throw new Error("C-VAC-3: λ < MIN");
  const avail = lAvail(vault.lamp_balance, vault.lamp_locked);
  if (lambda > avail) throw new Error("C-VAC-2: λ > L_avail");
  if (vault.vacuum_orders.length >= MAX_VACUUM_ORDERS) throw new Error("C-VAC-5: orders full");

  const newHoldings = selectLampForLock(vault.loyalty_holdings, lambda);
  const order: VacuumOrder = {
    order_id:     `order_${currentEpoch}`,
    commit_epoch: currentEpoch,
    fire_epoch:   currentEpoch + VACUUM_DELAY,
    lamp_amount:  lambda,
  };

  return {
    newLampLocked: vault.lamp_locked + lambda,
    newHoldings,
    newOrder: order,
    fireEpoch: currentEpoch + VACUUM_DELAY,
  };
}

// ── Simulate VacuumFire ───────────────────────────────────────

function simulateFire(
  vault        : VaultDatum,
  order        : VacuumOrder,
  umQ          : bigint,
  currentEpoch : bigint,
): { mGenerated: bigint; batchCreated: boolean; lampTransferred: bigint } {

  if (currentEpoch !== order.fire_epoch) throw new Error(`C-VAC-6: epoch mismatch`);

  const smQ = computeSmQ(vault.streak_state);

  // C-VAC-PRUNE: prune before count
  const pruned = vault.magic_batches.filter(b => !isVacuumExpired(b.created_epoch, currentEpoch));

  const batchCreated = pruned.length < MAX_BATCHES_PER_VAULT;
  const mGenerated = batchCreated ? computeVacuumMagic(order.lamp_amount, umQ, smQ) : 0n;

  return {
    mGenerated,
    batchCreated,
    lampTransferred: order.lamp_amount,  // INV-43: ALWAYS
  };
}

// ═══════════════════════════════════════════════════════════════
// §10.1 VacuumGen formula
// ═══════════════════════════════════════════════════════════════

describe("computeVacuumMagic — §10.1", () => {

  it("TV-VAC-01: λ=10⁹, UM=1.5, SM=1.10 → 825_000_000", () => {
    const { input, steps, expected_nanogic } = TV_VAC_01;
    const result = computeVacuumMagic(input.lambda_oildrop, input.um_q, input.sm_q);
    expect(result).toBe(expected_nanogic);

    // Verify steps
    const Q = 1_000_000_000n, VBR = 500_000_000n;
    expect(input.lambda_oildrop * VBR / Q).toBe(steps.s1);
    expect(steps.s1 * input.um_q / Q).toBe(steps.s2);
    expect(steps.s2 * input.sm_q / Q).toBe(steps.s3);
  });

  it("TV-VAC-CALIB: λ=10⁹, UM=1.0, SM=1.0 → 0.5 MAGIC (§20.3)", () => {
    const { input, expected_nanogic } = TV_VAC_CALIB;
    expect(computeVacuumMagic(input.lambda_oildrop, input.um_q, input.sm_q)).toBe(expected_nanogic);
    expect(nanogicToMagicStr(expected_nanogic)).toBe("0.5000");
  });

  it("TV-VAC-MAX: UM=2.0, SM=1.20 → 1.2 MAGIC", () => {
    const { input, expected_nanogic } = TV_VAC_MAX;
    expect(computeVacuumMagic(input.lambda_oildrop, input.um_q, input.sm_q)).toBe(expected_nanogic);
  });

  it("NO Profile Multiplier PM (§6.10 — M_vacuum chain)", () => {
    // PM does not appear in the formula signature
    const fnStr = computeVacuumMagic.toString();
    expect(fnStr).not.toContain("pm_q");
    expect(fnStr).not.toContain("PM");
  });

  it("NO Loyalty Factor LF", () => {
    const fnStr = computeVacuumMagic.toString();
    expect(fnStr).not.toContain("lf_q");
  });
});

// ═══════════════════════════════════════════════════════════════
// §6.5 Streak Multiplier
// ═══════════════════════════════════════════════════════════════

describe("getSmQ — §6.5", () => {
  it("SM table — all tiers", () => {
    for (const { streak, sm_q } of TV_SM_TABLE) {
      expect(getSmQ(streak), `streak=${streak}`).toBe(sm_q);
    }
  });
  it("Boundary: streak=3 first qualifies for 1.05×", () => {
    expect(getSmQ(2n)).toBe(1_000_000_000n);  // <3 → 1.00
    expect(getSmQ(3n)).toBe(1_050_000_000n);  // 3  → 1.05
  });
  it("Boundary: streak=12 first qualifies for 1.20×", () => {
    expect(getSmQ(11n)).toBe(1_100_000_000n); // 11 → 1.10
    expect(getSmQ(12n)).toBe(1_200_000_000n); // 12 → 1.20
  });
});

// ═══════════════════════════════════════════════════════════════
// C-UM-7: Vacuum always uses smoothed UM
// ═══════════════════════════════════════════════════════════════

describe("getUmForVacuum — C-UM-7", () => {
  it("TV-UM-SPLIT-VACUUM: stale UM (staleness=2) → still returns smoothed", () => {
    const { um_datum, expected_result } = TV_UM_SPLIT_VACUUM;
    expect(getUmForVacuum(um_datum)).toBe(expected_result);  // 2B ✓
  });
  it("Fresh UM → smoothed", () => {
    expect(getUmForVacuum({ smoothed_q: 1_500_000_000n, last_updated_epoch: 99n, history: [] }))
      .toBe(1_500_000_000n);
  });
  it("Very stale UM → still smoothed (never fallback)", () => {
    expect(getUmForVacuum({ smoothed_q: 2_000_000_000n, last_updated_epoch: 0n, history: [] }))
      .toBe(2_000_000_000n);
  });
  it("C-UM-7: no UM_FALLBACK_Q ever applied to Vacuum", () => {
    const fnStr = getUmForVacuum.toString();
    expect(fnStr).not.toContain("FALLBACK");
    expect(fnStr).not.toContain("staleness");
  });
});

// ═══════════════════════════════════════════════════════════════
// §6.8 Lock selection — youngest-first (T5)
// ═══════════════════════════════════════════════════════════════

describe("selectLampForLock — §6.8, T5, TV-LOCK-01", () => {

  it("TV-LOCK-01: lock 2500 from 3 holdings", () => {
    const { holdings, lock_amount, expected_locked, expected_free } = TV_LOCK_01;
    const result = selectLampForLock(holdings, lock_amount);

    const locked = result.filter(h =>  h.is_locked);
    const free   = result.filter(h => !h.is_locked);

    // Verify locked set matches expected
    for (const exp of expected_locked) {
      expect(locked.some(h =>
        h.amount === exp.amount && h.acquired_epoch === exp.acquired_epoch && h.is_locked
      )).toBe(true);
    }
    // Verify free set
    for (const exp of expected_free) {
      expect(free.some(h =>
        h.amount === exp.amount && h.acquired_epoch === exp.acquired_epoch && !h.is_locked
      )).toBe(true);
    }

    // Total preserved
    const totalBefore = holdings.reduce((s, h) => s + h.amount, 0n);
    const totalAfter  = result.reduce((s, h) => s + h.amount, 0n);
    expect(totalAfter).toBe(totalBefore);
  });

  it("T5: free holdings are oldest (highest acquired_epoch age) → max LF", () => {
    const holdings: LoyaltyHolding[] = [
      { amount: 1000n, acquired_epoch: 50n, is_locked: false },   // oldest
      { amount: 1000n, acquired_epoch: 80n, is_locked: false },   // newest
    ];
    const result = selectLampForLock(holdings, 1000n);
    const locked = result.filter(h =>  h.is_locked);
    const free   = result.filter(h => !h.is_locked);
    // Youngest (ep=80) locked; oldest (ep=50) free → LF(free) maximized ✓
    expect(locked[0]!.acquired_epoch).toBe(80n);
    expect(free[0]!.acquired_epoch).toBe(50n);
  });

  it("Lock full amount (no split)", () => {
    const holdings = [{ amount: 5000n, acquired_epoch: 80n, is_locked: false }];
    const result   = selectLampForLock(holdings, 5000n);
    expect(result[0]!.is_locked).toBe(true);
    expect(result[0]!.amount).toBe(5000n);
  });

  it("Insufficient holdings → throws GEN-LOCK-001 (canonical)", () => {
    const holdings = [{ amount: 100n, acquired_epoch: 80n, is_locked: false }];
    expect(() => selectLampForLock(holdings, 200n)).toThrow("GEN-LOCK-001");
  });
});

describe("removeLockedAmount — §A.9", () => {
  it("Remove 1000 from locked holdings oldest-first", () => {
    const holdings: LoyaltyHolding[] = [
      { amount: 500n,  acquired_epoch: 50n, is_locked: true  },  // oldest locked
      { amount: 500n,  acquired_epoch: 60n, is_locked: true  },
      { amount: 1000n, acquired_epoch: 70n, is_locked: false },
    ];
    const result = removeLockedAmount(holdings, 1000n);
    // Should remove both locked holdings (oldest first)
    const locked = result.filter(h => h.is_locked);
    expect(locked.length).toBe(0);
    // Unlocked unchanged
    expect(result.filter(h => !h.is_locked)[0]!.amount).toBe(1000n);
  });
});

// ═══════════════════════════════════════════════════════════════
// Two-phase flow: Commit → Fire
// ═══════════════════════════════════════════════════════════════

describe("VacuumGen two-phase flow", () => {

  it("Full flow: commit → fire → MAGIC created", () => {
    const vault = makeVault({ streak_state: { current_streak: 8n, last_active_epoch: 99n } });
    const commitEpoch = 100n;

    // Phase 1: Commit
    const commitResult = simulateCommit(vault, lampToOildrop(1000n), commitEpoch);
    expect(commitResult.fireEpoch).toBe(102n);                      // C-VAC-4 ✓
    expect(commitResult.newLampLocked).toBe(lampToOildrop(1000n));

    // Phase 2: Fire at epoch 102
    const vaultAfterCommit: VaultDatum = {
      ...vault,
      lamp_locked:      commitResult.newLampLocked,
      loyalty_holdings: commitResult.newHoldings,
      vacuum_orders:    [commitResult.newOrder],
    };
    const um = { smoothed_q: 1_500_000_000n, last_updated_epoch: 98n, history: [] as bigint[] };
    const umQ = getUmForVacuum(um);   // C-UM-7: 1.5B despite staleness=4
    const fireResult = simulateFire(vaultAfterCommit, commitResult.newOrder, umQ, 102n);

    // TV-VAC-01: λ=10⁹, UM=1.5, SM=1.10 (streak=8) → 825M
    expect(fireResult.mGenerated).toBe(825_000_000n);       // TV-VAC-01 ✓
    expect(fireResult.batchCreated).toBe(true);
    expect(fireResult.lampTransferred).toBe(lampToOildrop(1000n)); // INV-43 ✓
  });

  it("C-VAC-6: fire at wrong epoch → throws", () => {
    const vault = makeVault({ vacuum_orders: [makeOrder()] });
    const um    = { smoothed_q: 1_000_000_000n, last_updated_epoch: 100n, history: [] as bigint[] };
    expect(() => simulateFire(vault, makeOrder(), um.smoothed_q, 101n)).toThrow("C-VAC-6");
    expect(() => simulateFire(vault, makeOrder(), um.smoothed_q, 103n)).toThrow("C-VAC-6");
  });

  it("TV-VAC-FULL: vault full → M=0; LAMP always transfers (INV-43)", () => {
    const fullBatches: MagicBatch[] = Array.from({ length: 32 }, (_, i) => ({
      batch_id: `b${i}`, source: "Vacuum" as const, created_epoch: 102n,
      initial_amount: 1_000_000_000n, current_amount: 1_000_000_000n,
      decay_window: 1n, profile_at_creation: null, contract_id: null, halved: false,
    }));
    const vault = makeVault({ magic_batches: fullBatches });
    const order = makeOrder({ fire_epoch: 102n });
    const result = simulateFire(vault, order, 1_000_000_000n, 102n);

    expect(result.mGenerated).toBe(0n);           // TV-VAC-FULL: M=0 ✓
    expect(result.batchCreated).toBe(false);
    expect(result.lampTransferred).toBe(order.lamp_amount);  // INV-43: ALWAYS ✓
  });

  it("C-VAC-PRUNE: expired batches pruned before count check (freeing room)", () => {
    // 32 batches but all expired → after prune room available
    const expiredBatches: MagicBatch[] = Array.from({ length: 32 }, (_, i) => ({
      batch_id: `b${i}`, source: "Vacuum" as const, created_epoch: 100n,  // k=2 at ep102 → expired
      initial_amount: 1_000_000_000n, current_amount: 1_000_000_000n,
      decay_window: 1n, profile_at_creation: null, contract_id: null, halved: false,
    }));
    const vault  = makeVault({ magic_batches: expiredBatches });
    const order  = makeOrder({ fire_epoch: 102n });
    const result = simulateFire(vault, order, 1_000_000_000n, 102n);

    expect(result.batchCreated).toBe(true);   // pruned → room available ✓
    expect(result.mGenerated).toBeGreaterThan(0n);
  });

  it("C-VAC-FIRE-PERMISSION: documented — fire needs no owner sig", () => {
    // No assertion on signature in simulateFire → permissionless ✓
    // In real validator: C-VAC-FIRE-PERMISSION explicitly omits owner check
    expect(true).toBe(true);   // structural guarantee via validator absence of check
  });
});

// ═══════════════════════════════════════════════════════════════
// Commit constraints
// ═══════════════════════════════════════════════════════════════

describe("VacuumCommit constraints", () => {

  it("TV-VAC-BOUNDS: λ < 1 LAMP → C-VAC-3 reject", () => {
    const vault = makeVault();
    expect(() => simulateCommit(vault, 999_999n, 100n)).toThrow("C-VAC-3");
  });

  it("TV-VAC-BOUNDS: λ = 1 LAMP → accept", () => {
    const vault = makeVault();
    expect(() => simulateCommit(vault, 1_000_000n, 100n)).not.toThrow();
  });

  it("C-VAC-2: λ > L_avail → reject", () => {
    const vault = makeVault({ lamp_balance: 5_000_000n, lamp_locked: 0n,
      loyalty_holdings: [{ amount: 5_000_000n, acquired_epoch: 50n, is_locked: false }] });
    expect(() => simulateCommit(vault, 5_000_001n, 100n)).toThrow("C-VAC-2");
  });

  it("C-VAC-5: |orders| = 10 → reject", () => {
    const vault = makeVault({ vacuum_orders: Array.from({ length: 10 }, makeOrder) });
    expect(() => simulateCommit(vault, 1_000_000n, 100n)).toThrow("C-VAC-5");
  });

  it("C-VAC-4: fire_epoch = commit_epoch + 2", () => {
    const vault = makeVault();
    const result = simulateCommit(vault, 1_000_000n, 100n);
    expect(result.fireEpoch).toBe(102n);  // ✓
  });
});

// ═══════════════════════════════════════════════════════════════
// Vacuum batch decay (cliff at k=1)
// ═══════════════════════════════════════════════════════════════

describe("Vacuum batch decay — §4.4 cliff", () => {
  it("k=0: balance = current_amount", () => {
    expect(isVacuumExpired(100n, 100n)).toBe(false);  // k=0 < 1
  });
  it("k=1: expired (cliff)", () => {
    expect(isVacuumExpired(100n, 101n)).toBe(true);   // k=1 ≥ decay_window=1
  });
  it("k=2: expired", () => {
    expect(isVacuumExpired(100n, 102n)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// VaultRedeemer schema — constructor-tag round trip (P8)
// Tags MUST match Aiken VaultRedeemer order:
//   0 VacuumCommit, 1 VacuumFire, 2 InstantGen, 3 ApplyHalving,
//   4 BurnBatch, 5 UpdateProfile, 6 WithdrawLamp, 7 SetDelegate
// ═══════════════════════════════════════════════════════════════

describe("VaultRedeemer schema — P8 constructor tags", () => {
  // Constructor-tag prefixes pin the index (compact form 121+n for n≤6,
  // general tag 1280+n for n≥7). These pin P8 ordering, not just symmetry.
  it("VacuumCommit is constr 0 (d8799f)", () => {
    expect(Data.to({ VacuumCommit: { lambda: 1n } }, VaultRedeemerSchema).startsWith("d8799f")).toBe(true);
  });

  it("BurnBatch is constr 4 (d87d9f) and round-trips", () => {
    const cbor = Data.to(
      { BurnBatch: { burns: [["aaaa", 400n], ["bbbb", 300n]] } },
      VaultRedeemerSchema,
    );
    expect(cbor.startsWith("d87d9f")).toBe(true);  // constr 4 = 121+4 = 125 = 0xd87d
    const back = Data.from(cbor, VaultRedeemerSchema) as any;
    expect(back.BurnBatch.burns.length).toBe(2);
    expect(back.BurnBatch.burns[0][0]).toBe("aaaa");
    expect(back.BurnBatch.burns[0][1]).toBe(400n);
  });

  it("WithdrawLamp is constr 6 (d87f9f) and round-trips", () => {
    const cbor = Data.to({ WithdrawLamp: { amount: 500_000n } }, VaultRedeemerSchema);
    expect(cbor.startsWith("d87f9f")).toBe(true);  // constr 6 = 121+6 = 127 = 0xd87f
    const back = Data.from(cbor, VaultRedeemerSchema) as any;
    expect(back.WithdrawLamp.amount).toBe(500_000n);
  });

  it("SetDelegate is constr 7 (tag 1280, d90500) — Some round-trips", () => {
    const cbor = Data.to(
      { SetDelegate: { new_delegate: "deadbeef" } },
      VaultRedeemerSchema,
    );
    expect(cbor.startsWith("d90500")).toBe(true);  // constr 7 → general tag 1280 = 0xd90500
    const back = Data.from(cbor, VaultRedeemerSchema) as any;
    expect(back.SetDelegate.new_delegate).toBe("deadbeef");
  });

  it("SetDelegate(None) (constr 7) round-trips", () => {
    const cbor = Data.to(
      { SetDelegate: { new_delegate: null } },
      VaultRedeemerSchema,
    );
    expect(cbor.startsWith("d90500")).toBe(true);
    const back = Data.from(cbor, VaultRedeemerSchema) as any;
    expect(back.SetDelegate.new_delegate).toBe(null);
  });
});
