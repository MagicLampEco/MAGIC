// tests/instant.test.ts — InstantGen flow simulation (no network)
//
// Mirrors validate_instant_gen in onchain/validators/vault.ak step for step, so
// a divergence between the off-chain builder and the validator shows up here
// (P8). Run: npx vitest run ../tests/instant.test.ts

import { describe, it, expect } from "vitest";
import {
  computeInstantGrant, computeRewardFromConsumed, computeCapSurplus,
  computeCapPp, getUmForInstant, isExpired, nanogicToMagicStr,
} from "../offchain/src/math.js";
import {
  PM_Q, MAGIC_DECAY_WINDOW, MIN_INSTANT_HOLDING, MAX_BACKING_STALE,
  MAX_BATCHES_PER_VAULT, UM_FALLBACK_Q,
} from "../offchain/src/constants.js";
import type {
  VaultDatum, MagicBatch, UMDatum, BackingBeaconDatum, GenSchedule,
} from "../offchain/src/types.js";
import { TV_ACT_7, TV_IG_ELIGIBILITY } from "./vectors.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeBatch(overrides: Partial<MagicBatch> = {}): MagicBatch {
  return {
    batch_id:            "deadbeef",
    source:              "Instant",
    created_epoch:       100n,
    initial_amount:      1_000_000_000n,
    current_amount:      1_000_000_000n,
    decay_window:        MAGIC_DECAY_WINDOW,
    profile_at_creation: null,
    contract_id:         null,
    halved:              false,
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<GenSchedule> = {}): GenSchedule {
  return {
    schedule_id:            "5c4ed0",
    commit_epoch:           90n,
    start_fire_epoch:       92n,
    end_fire_epoch:         190n,
    schedule_length:        100n,
    lamp_per_epoch:         4_000_000_000n,     // 4000 LAMP
    rate_locked_q:          11_250_000_000n,    // pp = 45 MAGIC / epoch
    baseline_at_commit_q:   5_000_000_000n,
    multiplier_at_commit_q: 2_250_000_000n,
    fired_count:            0n,
    auto_burn_target:       null,
    ...overrides,
  };
}

function makeVault(overrides: Partial<VaultDatum> = {}): VaultDatum {
  return {
    owner:                 "aabbccdd",
    lamp_balance:          100_000_000_000n,  // 100,000 LAMP — eligibility only
    lamp_locked:           0n,
    loyalty_holdings:      [{ amount: 100_000_000_000n, acquired_epoch: 50n, is_locked: false }],
    magic_batches:         [],
    next_batch_index:      0n,
    vacuum_orders:         [],
    gen_schedules:         [makeSchedule()],
    profile:               "Flame",
    profile_changed_epoch: 0n,
    pending_profile:       null,
    last_updated_epoch:    99n,
    delegation_cert:       { current: [], pending: null, current_effective_epoch: 0n, last_changed_epoch: 0n },
    activity_state:        { recent_burn_epochs: [], consumed_credit: 1_000_000_000n },
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

function makeBeacon(overrides: Partial<BackingBeaconDatum> = {}): BackingBeaconDatum {
  return {
    br_q:               2_000_000_000n,       // br = 2.0 (xanh)
    magic_supply:       1_000_000_000_000n,   // S = 1000 MAGIC
    depeg:              false,
    last_updated_epoch: 100n,
    ...overrides,
  };
}

// ── Simulate InstantGen off-chain (mirrors the validator) ─────

interface SimResult {
  newBatch      : MagicBatch;
  updatedBatches: MagicBatch[];
  grant         : bigint;
  ceilings      : { reward: bigint; capSurplus: bigint; capPp: bigint };
  umUsed        : bigint;
  prunedCount   : number;
  lampBalanceAfter : bigint;
  lampLockedAfter  : bigint;
  holdingsAfter    : VaultDatum["loyalty_holdings"];
  consumedCreditAfter: bigint;
}

function simulateInstantGen(
  vault       : VaultDatum,
  umDatum     : UMDatum,
  beacon      : BackingBeaconDatum | null,
  currentEpoch: bigint,
): SimResult {
  // C-INST-1: LAMP must SIT in the vault (eligibility, never spent)
  if (vault.lamp_balance < MIN_INSTANT_HOLDING)
    throw new Error("C-INST-1: lamp_balance < MIN_INSTANT_HOLDING");

  // C-INST-3: the eligible LAMP must be unencumbered
  if (vault.lamp_balance - vault.lamp_locked < MIN_INSTANT_HOLDING)
    throw new Error("C-INST-3: L_avail < MIN_INSTANT_HOLDING");

  // §4.2 cliff: only LIVE batches survive
  const live = vault.magic_batches.filter(
    b => !isExpired(b.created_epoch, b.decay_window, currentEpoch),
  );
  const prunedCount = vault.magic_batches.length - live.length;

  // C-INST-7
  if (live.length >= MAX_BATCHES_PER_VAULT)
    throw new Error("C-INST-7: vault full");

  // C-UM-6
  const umUsed = getUmForInstant(umDatum, currentEpoch);

  // §6.3 backing gate — FAIL-CLOSED
  if (beacon === null)
    throw new Error("GEN-INST-BEACON: no BackingBeacon reference input → Gen shut");
  if (beacon.depeg)
    throw new Error("GEN-INST-006: depeg → cap_surplus = 0");
  const age = currentEpoch - beacon.last_updated_epoch;
  if (age < 0n || age > MAX_BACKING_STALE)
    throw new Error("GEN-INST-007: BackingBeacon stale → treated as absent");

  // C-INST-5
  const pmQ = PM_Q[vault.profile]!;
  const consumed = vault.activity_state.consumed_credit;
  const ceilings = {
    reward:     computeRewardFromConsumed(consumed, umUsed, pmQ),
    capSurplus: computeCapSurplus(beacon.br_q, beacon.magic_supply),
    capPp:      computeCapPp(vault.gen_schedules),
  };
  const grant = computeInstantGrant(
    consumed, umUsed, pmQ, beacon.br_q, beacon.magic_supply, vault.gen_schedules,
  );
  if (grant <= 0n) throw new Error("GEN-INST-005: grant = 0 → nothing to mint");

  const newBatch: MagicBatch = {
    batch_id:            `batch_${vault.next_batch_index}`,
    source:              "Instant",
    created_epoch:       currentEpoch,
    initial_amount:      grant,
    current_amount:      grant,
    decay_window:        MAGIC_DECAY_WINDOW,
    profile_at_creation: null,
    contract_id:         null,
    halved:              false,
  };

  return {
    newBatch,
    updatedBatches: [...live, newBatch],
    grant,
    ceilings,
    umUsed,
    prunedCount,
    // I-ACT-7 — copied verbatim, by construction
    lampBalanceAfter: vault.lamp_balance,
    lampLockedAfter:  vault.lamp_locked,
    holdingsAfter:    vault.loyalty_holdings,
    // INV-CASHBACK-BOUND — the credit is spent
    consumedCreditAfter: 0n,
  };
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("InstantGen full flow simulation (PHA 2)", () => {

  describe("I-ACT-7 — LAMP đứng yên", () => {

    it("TV-ACT-7: every LAMP-bearing field is byte-identical after the grant", () => {
      const vault = makeVault();
      const r = simulateInstantGen(vault, makeUM(), makeBeacon(), 100n);

      expect(r.lampBalanceAfter).toBe(vault.lamp_balance);
      expect(r.lampLockedAfter).toBe(vault.lamp_locked);
      expect(r.holdingsAfter).toEqual(vault.loyalty_holdings);
      expect(r.lampBalanceAfter).toBe(TV_ACT_7.after.vault_lamp_balance);
    });

    it("Generating MAGIC never reduces the vault's LAMP, whatever the grant is", () => {
      for (const credit of [1_000_000_000n, 50_000_000_000n, 900_000_000_000n]) {
        const vault = makeVault({
          activity_state: { recent_burn_epochs: [], consumed_credit: credit },
        });
        const r = simulateInstantGen(vault, makeUM(), makeBeacon(), 100n);
        expect(r.lampBalanceAfter).toBe(vault.lamp_balance);
      }
    });
  });

  describe("§6.3 — magnitude keyed to MAGIC consumed", () => {

    it("1 MAGIC consumed, Flame, UM=1.0 → 0.21 MAGIC granted", () => {
      const vault = makeVault({ profile: "Flame" });
      const r = simulateInstantGen(vault, makeUM(), makeBeacon(), 100n);

      expect(r.grant).toBe(210_000_000n);
      expect(nanogicToMagicStr(r.grant)).toBe("0.2100");
      expect(r.newBatch.source).toBe("Instant");
      expect(r.newBatch.decay_window).toBe(1n);            // §4.2 cliff
      expect(r.newBatch.halved).toBe(false);               // dead field
      expect(r.newBatch.profile_at_creation).toBeNull();   // C-DECAY-4
      expect(r.consumedCreditAfter).toBe(0n);              // credit spent
    });

    it("More LAMP does NOT buy more MAGIC — only consumption does", () => {
      const poorHolder = makeVault({
        lamp_balance: 10_000_000n,
        loyalty_holdings: [{ amount: 10_000_000n, acquired_epoch: 50n, is_locked: false }],
        activity_state: { recent_burn_epochs: [], consumed_credit: 5_000_000_000n },
      });
      const whaleHolder = makeVault({
        lamp_balance: 10_000_000_000_000n,
        loyalty_holdings: [{ amount: 10_000_000_000_000n, acquired_epoch: 50n, is_locked: false }],
        activity_state: { recent_burn_epochs: [], consumed_credit: 1_000_000_000n },
      });
      const poor  = simulateInstantGen(poorHolder,  makeUM(), makeBeacon(), 100n);
      const whale = simulateInstantGen(whaleHolder, makeUM(), makeBeacon(), 100n);

      // The spec's own example: 1000 MAGIC holder who consumed 900 beats a
      // 2000 MAGIC holder who consumed 500. Same shape here, LAMP-wise inverted.
      expect(poor.grant).toBeGreaterThan(whale.grant);
    });

    it("Zero consumption → the tx cannot be built at all", () => {
      const vault = makeVault({
        activity_state: { recent_burn_epochs: [], consumed_credit: 0n },
      });
      expect(() => simulateInstantGen(vault, makeUM(), makeBeacon(), 100n))
        .toThrow("GEN-INST-005");
    });

    it("Profile (tư-cách) scales the rate: Ember > Flame > Lantern", () => {
      const grants = (["Ember", "Flame", "Lantern"] as const).map(p =>
        simulateInstantGen(makeVault({ profile: p }), makeUM(), makeBeacon(), 100n).grant,
      );
      expect(grants[0]!).toBeGreaterThan(grants[1]!);
      expect(grants[1]!).toBeGreaterThan(grants[2]!);
    });
  });

  describe("§6.3 — the three ceilings", () => {

    it("The whale's reward is clipped by 0.5 × pp_schedule", () => {
      const vault = makeVault({
        activity_state: { recent_burn_epochs: [], consumed_credit: 1_000_000_000_000n },
      });
      const r = simulateInstantGen(vault, makeUM(), makeBeacon(), 100n);
      expect(r.ceilings.reward).toBe(210_000_000_000n);
      expect(r.ceilings.capPp).toBe(22_500_000_000n);
      expect(r.grant).toBe(22_500_000_000n);
    });

    it("A vault with no ScheduleGen contract cannot InstantGen at all", () => {
      const vault = makeVault({ gen_schedules: [] });
      expect(() => simulateInstantGen(vault, makeUM(), makeBeacon(), 100n))
        .toThrow("GEN-INST-005");
    });

    it("Red backing (br ≤ br_safe) locks the door", () => {
      const beacon = makeBeacon({ br_q: 1_400_000_000n });
      expect(() => simulateInstantGen(makeVault(), makeUM(), beacon, 100n))
        .toThrow("GEN-INST-005");
    });
  });

  describe("Backing beacon — fail-closed (§6.3)", () => {

    it("No beacon at all → REJECT, never a default br", () => {
      expect(() => simulateInstantGen(makeVault(), makeUM(), null, 100n))
        .toThrow("GEN-INST-BEACON");
    });

    it("Stale beacon is treated as ABSENT", () => {
      const beacon = makeBeacon({ last_updated_epoch: 98n });   // age 2 > 1
      expect(() => simulateInstantGen(makeVault(), makeUM(), beacon, 100n))
        .toThrow("GEN-INST-007");
    });

    it("Depeg flag shuts the door regardless of br", () => {
      const beacon = makeBeacon({ br_q: 9_000_000_000n, depeg: true });
      expect(() => simulateInstantGen(makeVault(), makeUM(), beacon, 100n))
        .toThrow("GEN-INST-006");
    });

    it("Beacon from the future (negative age) is rejected", () => {
      const beacon = makeBeacon({ last_updated_epoch: 101n });
      expect(() => simulateInstantGen(makeVault(), makeUM(), beacon, 100n))
        .toThrow("GEN-INST-007");
    });
  });

  describe("Eligibility — LAMP opens the door, nothing more", () => {

    it("TV-IG-ELIGIBILITY: threshold, boundary and locked-LAMP cases", () => {
      for (const c of TV_IG_ELIGIBILITY.cases) {
        const vault = makeVault({
          lamp_balance: c.lamp_balance,
          lamp_locked:  c.lamp_locked,
          loyalty_holdings: [
            { amount: c.lamp_balance, acquired_epoch: 50n, is_locked: c.lamp_locked > 0n },
          ],
        });
        if (c.expected === "ACCEPT") {
          expect(() => simulateInstantGen(vault, makeUM(), makeBeacon(), 100n)).not.toThrow();
        } else {
          expect(() => simulateInstantGen(vault, makeUM(), makeBeacon(), 100n)).toThrow();
        }
      }
    });
  });

  describe("C-UM-6 — UM stale check", () => {

    it("Stale UM halves the grant (penalty, not rejection)", () => {
      const vault = makeVault({ profile: "Flame" });
      const um    = makeUM({ smoothed_q: 2_000_000_000n, last_updated_epoch: 98n });
      const r = simulateInstantGen(vault, um, makeBeacon(), 100n);

      expect(r.umUsed).toBe(UM_FALLBACK_Q);
      expect(r.grant).toBe(105_000_000n);   // 0.20 × 0.5 × 1.05 × 1 MAGIC
    });

    it("Fresh UM uses the smoothed value", () => {
      const vault = makeVault({ profile: "Flame" });
      const um    = makeUM({ smoothed_q: 1_500_000_000n, last_updated_epoch: 99n });
      const r = simulateInstantGen(vault, um, makeBeacon(), 100n);

      expect(r.umUsed).toBe(1_500_000_000n);
      expect(r.grant).toBe(315_000_000n);   // 0.20 × 1.5 × 1.05
    });
  });

  describe("§4.2 — cliff behaviour inside the tx", () => {

    it("A batch from the previous epoch is collected, not halved", () => {
      const stale = makeBatch({ created_epoch: 99n, current_amount: 800_000_000n });
      const vault = makeVault({ magic_batches: [stale] });
      const r = simulateInstantGen(vault, makeUM(), makeBeacon(), 100n);

      expect(r.prunedCount).toBe(1);
      expect(r.updatedBatches.length).toBe(1);              // only the new one
      expect(r.updatedBatches.find(b => b.batch_id === "deadbeef")).toBeUndefined();
    });

    it("A batch created this epoch survives alongside the new one", () => {
      const fresh = makeBatch({ created_epoch: 100n });
      const vault = makeVault({ magic_batches: [fresh] });
      const r = simulateInstantGen(vault, makeUM(), makeBeacon(), 100n);

      expect(r.prunedCount).toBe(0);
      expect(r.updatedBatches.length).toBe(2);
    });

    it("Full lifecycle: granted at epoch 100, worth zero at epoch 101", () => {
      const r = simulateInstantGen(makeVault(), makeUM(), makeBeacon(), 100n);
      const b = r.newBatch;
      expect(isExpired(b.created_epoch, b.decay_window, 100n)).toBe(false);
      expect(isExpired(b.created_epoch, b.decay_window, 101n)).toBe(true);
    });
  });

  describe("Vault limits", () => {

    it("32 live batches → GEN-VAULT-001 (C-INST-7)", () => {
      const batches = Array.from({ length: 32 }, (_, i) =>
        makeBatch({ batch_id: `batch_${i}`, created_epoch: 100n }),
      );
      const vault = makeVault({ magic_batches: batches });
      expect(() => simulateInstantGen(vault, makeUM(), makeBeacon(), 100n))
        .toThrow("C-INST-7");
    });

    it("32 DEAD batches do not block a new grant — they are collected", () => {
      const batches = Array.from({ length: 32 }, (_, i) =>
        makeBatch({ batch_id: `batch_${i}`, created_epoch: 99n }),
      );
      const vault = makeVault({ magic_batches: batches });
      const r = simulateInstantGen(vault, makeUM(), makeBeacon(), 100n);
      expect(r.prunedCount).toBe(32);
      expect(r.updatedBatches.length).toBe(1);
    });
  });
});
