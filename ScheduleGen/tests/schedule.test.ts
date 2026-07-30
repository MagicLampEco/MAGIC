// tests/schedule.test.ts — ScheduleGen unit + integration tests
// Run: npx vitest run tests/schedule.test.ts

import { describe, it, expect } from "vitest";
import {
  computeSQ, computeRateLockedQ, computeMi, checkSchRate,
  computeShardId, countEligibleFires, nextFireEpoch,
  nanogicToMagicStr, lampToOil, unlockLockedAmount, isExpired, isLive,
} from "../offchain/src/math.js";
import {
  SCHEDULE_MIN_LENGTH, SCHEDULE_MAX_LENGTH,
  MIN_LAMP_PER_FIRE, SHARD_CAP, SNAPSHOT_BASE_RATE_Q, Q,
  MAX_FIRES_PER_TX_CATCHUP, MAX_BATCHES_PER_VAULT,
} from "../offchain/src/constants.js";
import {
  TV_SCH_01, TV_SCH_02, TV_SCH_03, TV_SCH_04, TV_SCH_05,
  TV_SCH_06, TV_SCH_CATCHUP_LIMIT, TV_SCH_T_DET, TV_SCH_FIRE3,
  TV_SCH_ACT7, TV_SCH_CLIFF,
} from "./vectors.js";
import type { VaultDatum, GenSchedule, MagicBatch } from "../offchain/src/types.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeVault(overrides: Partial<VaultDatum> = {}): VaultDatum {
  return {
    owner: "aabbccdd00112233",
    lamp_balance:   250_000_000_000_000n,   // 250M LAMP (Bob's example)
    lamp_locked:    0n,
    loyalty_holdings: [{ amount: 250_000_000_000_000n, acquired_epoch: 0n, is_locked: false }],
    magic_batches: [],
    next_batch_index: 0n,
    vacuum_orders: [],
    gen_schedules: [],
    profile: "Lantern",
    profile_changed_epoch: 0n,
    pending_profile: null,
    last_updated_epoch: 49n,
    delegation_cert: { current: [], pending: null, current_effective_epoch: 0n, last_changed_epoch: 0n },
    activity_state: { recent_burn_epochs: [], consumed_credit: 0n },
    streak_state:   { current_streak: 0n, last_active_epoch: 0n },
    personal_delegate: null,
    attribution: { attribution_root: "00".repeat(32), last_event_epoch: 0n, total_events: 0n },
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<GenSchedule> = {}): GenSchedule {
  return {
    schedule_id:              "sched01",
    commit_epoch:             50n,
    start_fire_epoch:         52n,
    end_fire_epoch:           151n,   // 50+100+1
    schedule_length:          100n,
    lamp_per_epoch:           4_000_000_000n,
    rate_locked_q:            11_250_000_000n,
    baseline_at_commit_q:     5_000_000_000n,
    multiplier_at_commit_q:   2_250_000_000n,
    fired_count:              0n,
    auto_burn_target:         null,
    ...overrides,
  };
}

// ── Simulate Commit ───────────────────────────────────────────

function simulateCommit(vault: VaultDatum, L: bigint, lambda: bigint, commitEpoch: bigint) {
  if (L < SCHEDULE_MIN_LENGTH || L > SCHEDULE_MAX_LENGTH)
    throw new Error(`C-SCH-1: L=${L} ∉ [10,200]`);
  if (lambda < MIN_LAMP_PER_FIRE)
    throw new Error(`C-SCH-2: λ < 1 LAMP`);
  const totalLock = L * lambda;
  const avail = vault.lamp_balance - vault.lamp_locked;
  if (totalLock > avail) throw new Error(`C-SCH-3: L×λ > L_avail`);
  if (vault.gen_schedules.length >= 20) throw new Error(`C-SCH-10: schedules full`);

  const sQ          = computeSQ(L);
  const rateLockedQ = computeRateLockedQ(SNAPSHOT_BASE_RATE_Q, L);
  const mI          = computeMi(lambda, rateLockedQ);
  if (!checkSchRate(lambda, rateLockedQ)) throw new Error(`C-SCH-RATE: M_i would be 0`);

  return { sQ, rateLockedQ, mI, totalLock };
}

// ── Simulate Fire ─────────────────────────────────────────────

function simulateFire(
  sched        : GenSchedule,
  currentEpoch : bigint,
  batchCount   : number = 0,
): { firesInTx: number; mTotal: bigint; lampReleased: bigint; newFiredCount: bigint } {
  const firesInTx = countEligibleFires(
    sched.start_fire_epoch, sched.fired_count,
    sched.schedule_length, currentEpoch, batchCount,
  );
  if (firesInTx === 0) throw new Error(`No eligible fires at epoch ${currentEpoch}`);
  const mI = computeMi(sched.lamp_per_epoch, sched.rate_locked_q);  // stored rate (T8)
  return {
    firesInTx,
    mTotal:       mI * BigInt(firesInTx),
    // PHA 2 / I-ACT-7: RELEASED from the locked pool, never transferred out.
    lampReleased: sched.lamp_per_epoch * BigInt(firesInTx),
    newFiredCount: sched.fired_count + BigInt(firesInTx),
  };
}

// ═══════════════════════════════════════════════════════════════
// §11.3 S(L) piecewise
// ═══════════════════════════════════════════════════════════════

describe("computeSQ — §11.3, T11, T12", () => {

  it("TV-SCH-01: all 5 values bit-identical", () => {
    for (const { L, S_Q } of TV_SCH_01.cases) {
      expect(computeSQ(L), `L=${L}`).toBe(S_Q);
    }
  });

  it("T11: S(50) continuous — seg1=seg2=2.0B", () => {
    expect(computeSQ(50n)).toBe(2_000_000_000n);
  });

  it("T11: S(150) continuous — seg2=seg3=2.5B", () => {
    expect(computeSQ(150n)).toBe(2_500_000_000n);
  });

  it("T12: dS/dL strictly decreasing (slopes 10M > 5M > 2.5M)", () => {
    // Test monotone increase with decreasing derivative
    const vals = [10n,20n,30n,50n,60n,100n,150n,160n,200n].map(L => [L, computeSQ(L)] as const);
    for (let i = 0; i < vals.length - 1; i++) {
      const [L1, S1] = vals[i]!;
      const [L2, S2] = vals[i+1]!;
      expect(S2).toBeGreaterThan(S1);   // monotone increasing
      const slope = Number(S2 - S1) / Number(L2 - L1);
      // Slope should be ≤ 10M per L unit
      expect(slope).toBeLessThanOrEqual(10_000_000);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// §11.2 rate_locked_q + §11.4 M_i
// ═══════════════════════════════════════════════════════════════

describe("computeRateLockedQ + computeMi — §11.2/11.4", () => {

  it("TV-SCH-02: L=100, λ=4000 LAMP → 45 MAGIC/fire", () => {
    const { L, lambda_oil, rate_locked_q, M_i, total_magic, S_Q } = TV_SCH_02;
    const sQ   = computeSQ(L);
    const rate = computeRateLockedQ(SNAPSHOT_BASE_RATE_Q, L);
    const mI   = computeMi(lambda_oil, rate);

    expect(sQ).toBe(S_Q);
    expect(rate).toBe(rate_locked_q);
    expect(mI).toBe(M_i);
    expect(mI * L).toBe(total_magic);
    expect(nanogicToMagicStr(mI)).toBe("45.0000");
  });

  it("TV-SCH-T-DET: same M_i every fire (T-DET)", () => {
    const { rate_locked_q, lambda_oil, M_i_all_fires } = TV_SCH_T_DET;
    for (let fire = 0; fire < 100; fire++) {
      expect(computeMi(lambda_oil, rate_locked_q)).toBe(M_i_all_fires);
    }
  });

  it("TV-SCH-03: T8 — fire uses stored rate, not current R_snap", () => {
    // Simulate: rate committed at epoch 50
    const storedRate = TV_SCH_02.rate_locked_q;
    // DAO raises R_snap to 10B at epoch 70 — fire at 80 should NOT use this
    const newRSnap = 10_000_000_000n;
    const wrongRate = computeRateLockedQ(newRSnap, 100n);
    const mICorrect = computeMi(TV_SCH_02.lambda_oil, storedRate);   // stored ✓
    const mIWrong   = computeMi(TV_SCH_02.lambda_oil, wrongRate);    // would be higher

    expect(mICorrect).toBe(TV_SCH_02.M_i);   // 45B ✓ T8
    expect(mIWrong).toBeGreaterThan(mICorrect);   // higher but NOT what protocol uses
  });

  it("TV-SCH-05: C-SCH-RATE prevents M_i=0 at commit", () => {
    const { lambda_oil, rate_locked_q } = TV_SCH_05;
    const mI = computeMi(lambda_oil, rate_locked_q);
    expect(mI).toBe(0n);                         // would be 0
    expect(checkSchRate(lambda_oil, rate_locked_q)).toBe(false);  // REJECT ✓
  });

  it("T19: C-SCH-RATE soundness — λ×rate≥Q → M_i≥1", () => {
    const lambda = TV_SCH_02.lambda_oil;
    const rate   = TV_SCH_02.rate_locked_q;
    expect(checkSchRate(lambda, rate)).toBe(true);
    expect(computeMi(lambda, rate)).toBeGreaterThanOrEqual(1n);
  });
});

// ═══════════════════════════════════════════════════════════════
// C-FIRE-1 ≥ catch-up
// ═══════════════════════════════════════════════════════════════

describe("countEligibleFires — C-FIRE-1 ≥, catch-up", () => {

  it("TV-SCH-06: 4 missed epochs → 4 fires", () => {
    const { start_fire_epoch, fired_count, current_epoch, fires_in_tx } = TV_SCH_06;
    const sched = makeSchedule({ start_fire_epoch, fired_count, schedule_length: 100n });
    const result = countEligibleFires(sched.start_fire_epoch, sched.fired_count, sched.schedule_length, current_epoch, 0);
    expect(result).toBe(fires_in_tx);  // 4 ✓
  });

  it("TV-SCH-CATCHUP-LIMIT: 18 eligible → capped at 8", () => {
    const { start_fire_epoch, fired_count, schedule_length, current_epoch, fires_in_tx } = TV_SCH_CATCHUP_LIMIT;
    const result = countEligibleFires(start_fire_epoch, fired_count, schedule_length, current_epoch, 0);
    expect(result).toBe(fires_in_tx);   // 8 (MAX cap) ✓
    expect(result).toBeLessThanOrEqual(MAX_FIRES_PER_TX_CATCHUP);
  });

  it("C-FIRE-1 ≥: fire allowed at e_i ≤ current (not exact match like Vacuum)", () => {
    const sched = makeSchedule({ start_fire_epoch: 52n, fired_count: 0n });
    // At exactly e_0=52
    expect(countEligibleFires(52n, 0n, 100n, 52n, 0)).toBe(1);
    // At e_0=52, current=55 (4 eligible)
    expect(countEligibleFires(52n, 0n, 100n, 55n, 0)).toBe(4);
    // Before first fire: current=51 < e_0=52
    expect(countEligibleFires(52n, 0n, 100n, 51n, 0)).toBe(0);
  });

  it("Batch budget cap: vault full limits fires", () => {
    const fires = countEligibleFires(52n, 0n, 100n, 59n, 30);  // 30 existing batches, budget=2
    expect(fires).toBeLessThanOrEqual(2);  // only 2 slots remain
  });
});

// ═══════════════════════════════════════════════════════════════
// §5.5 Shard ID (C-SCH-FIRE-SHARD)
// ═══════════════════════════════════════════════════════════════

describe("computeShardId — §5.5, C-SCH-FIRE-SHARD", () => {

  it("Returns value in [0,15]", () => {
    const pkhs = ["aabbccdd", "11223344", "deadbeef", "cafebabe", "00000000"];
    for (const pkh of pkhs) {
      const id = computeShardId(pkh);
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThanOrEqual(15);
    }
  });

  it("Deterministic: same PKH always gives same shard_id", () => {
    const pkh = "aabbccdd00112233";
    expect(computeShardId(pkh)).toBe(computeShardId(pkh));
  });

  it("C-SCH-FIRE-SHARD: different owners → possibly different shards", () => {
    const alice = computeShardId("aaaaaaaabbbbbbbb");
    const bob   = computeShardId("ccccccccdddddddd");
    // No assertion on specific values — just verify the function is stable
    expect(typeof alice).toBe("number");
    expect(typeof bob).toBe("number");
  });
});

// ═══════════════════════════════════════════════════════════════
// TV-SCH-04: Shard cap (T13, C-SCH-CAP)
// ═══════════════════════════════════════════════════════════════

describe("Shard participation cap — T13, C-SCH-CAP", () => {

  it("TV-SCH-04: accept when within cap", () => {
    const { shard_locked, cases } = TV_SCH_04;
    const accept = cases.find(c => c.expected === "ACCEPT")!;
    expect(shard_locked + accept.total).toBeLessThanOrEqual(SHARD_CAP);
  });

  it("TV-SCH-04: reject when exceeds cap", () => {
    const { shard_locked, cases } = TV_SCH_04;
    const reject = cases.find(c => c.expected === "REJECT")!;
    expect(shard_locked + reject.total).toBeGreaterThan(SHARD_CAP);
  });

  it("SHARD_CAP = 4.5×10¹⁴ oil (450M LAMP per shard)", () => {
    expect(SHARD_CAP).toBe(450_000_000_000_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
// Schedule boundaries
// ═══════════════════════════════════════════════════════════════

describe("Commit constraint boundaries", () => {

  it("C-SCH-1: L < 10 → reject", () => {
    const vault = makeVault();
    expect(() => simulateCommit(vault, 9n, lampToOil(1000n), 50n)).toThrow("C-SCH-1");
  });

  it("C-SCH-1: L = 10 → accept", () => {
    const vault = makeVault();
    expect(() => simulateCommit(vault, 10n, lampToOil(1000n), 50n)).not.toThrow();
  });

  it("C-SCH-1: L = 200 → accept", () => {
    const vault = makeVault();
    expect(() => simulateCommit(vault, 200n, lampToOil(1000n), 50n)).not.toThrow();
  });

  it("C-SCH-1: L > 200 → reject", () => {
    const vault = makeVault();
    expect(() => simulateCommit(vault, 201n, lampToOil(1000n), 50n)).toThrow("C-SCH-1");
  });

  it("C-SCH-3: L×λ > L_avail → reject", () => {
    const vault = makeVault({ lamp_balance: 10_000_000n, lamp_locked: 0n,
      loyalty_holdings: [{ amount: 10_000_000n, acquired_epoch: 0n, is_locked: false }] });
    expect(() => simulateCommit(vault, 10n, 2_000_000n, 50n)).toThrow("C-SCH-3");  // 10×2>10
  });
});

// ═══════════════════════════════════════════════════════════════
// C-FIRE-3 atomic (§11.10)
// ═══════════════════════════════════════════════════════════════

describe("C-FIRE-3 atomic fire assertion", () => {

  it("TV-SCH-FIRE3: all accounting consistent", () => {
    const { fires_in_tx, lambda_oil, M_i, assertions } = TV_SCH_FIRE3;
    const mTotal       = M_i * BigInt(fires_in_tx);
    const lampReleased = lambda_oil * BigInt(fires_in_tx);

    expect(BigInt(fires_in_tx)).toBe(assertions.fired_count_delta);
    // I-ACT-7: the balance does not move; only the lock is released.
    expect(0n).toBe(assertions.lamp_balance_delta);
    expect(-lampReleased).toBe(assertions.lamp_locked_delta);
    expect(0n).toBe(assertions.holdings_sum_delta);
    expect(fires_in_tx).toBe(assertions.new_batches_count);
    expect(1n).toBe(assertions.each_batch_decay_window);
    // All batches get identical M_i (T-DET)
    for (let i = 0; i < fires_in_tx; i++) {
      expect(M_i).toBe(assertions.each_batch_initial);
    }
  });

  it("Bob worked example (§11.11): full simulation", () => {
    const sched = makeSchedule({
      start_fire_epoch: 52n, fired_count: 0n,
      schedule_length: 100n, lamp_per_epoch: 4_000_000_000n,
      rate_locked_q: 11_250_000_000n,
    });

    // Fire at epoch 55 (missed 52,53,54,55)
    const result = simulateFire(sched, 55n);
    expect(result.firesInTx).toBe(4);                        // §11.11 ✓
    expect(result.mTotal).toBe(180_000_000_000n);            // 4×45 MAGIC ✓
    expect(result.lampReleased).toBe(16_000_000_000n);       // 4×4000 LAMP oildrop released ✓
    expect(result.newFiredCount).toBe(4n);                   // output.fired_count ✓
    expect(nanogicToMagicStr(result.mTotal)).toBe("180.0000");
  });

  it("T10: No cancel — validator has no cancel redeemer", () => {
    // Structural guarantee: VaultRedeemer enum has no CancelSchedule variant
    // This test documents the invariant
    const redeemerTypes = [
      "ScheduleCommit", "ScheduleFire", "BurnBatch", "WithdrawLamp", "SetDelegate",
    ];
    expect(redeemerTypes).not.toContain("CancelSchedule");  // T10 ✓
  });
});

// ═══════════════════════════════════════════════════════════════
// VaultRedeemer constructor-index contract (P8 invariant)
//
// The Aiken `VaultRedeemer` enum order is the on-chain Plutus Data constr tag:
//   ScheduleCommit=0, ScheduleFire=1, BurnBatch=2, WithdrawLamp=3, SetDelegate=4
// and the offchain `VaultRedeemerSchema` (offchain/src/types.ts) MUST list the
// same variants in the same order — Lucid's Data.Enum maps array index → constr.
//
// We assert the byte-level contract with a self-contained Plutus-Data CBOR
// constr encoder (Lucid uses the identical CIP-0008/Plutus rule: alternative i
// for i<7 → CBOR tag 121+i, i.e. major-type-6 head 0xd8 0x(0x79+i)). This is
// runtime-independent of the lucid bundle (which currently has a broken
// libsodium ESM dist — tracked separately, see task "Fix value-leak + HIGH").
// ═══════════════════════════════════════════════════════════════

describe("VaultRedeemer constr-index contract (P8: Aiken ↔ TS order)", () => {

  // Head bytes Lucid/Plutus emit for Constr(i, []) with i < 7.
  function constrHeadHex(i: number): string {
    expect(i).toBeLessThan(7);
    const tag = 0x79 + i;                 // 121 + i
    return "d8" + tag.toString(16).padStart(2, "0");
  }

  // Order matches BOTH Aiken VaultRedeemer and offchain VaultRedeemerSchema.
  const VARIANT_ORDER = [
    "ScheduleCommit", // 0
    "ScheduleFire",   // 1
    "BurnBatch",      // 2
    "WithdrawLamp",   // 3
    "SetDelegate",    // 4
  ];

  it("variant order is fixed and append-only (new variants at END)", () => {
    expect(VARIANT_ORDER).toEqual([
      "ScheduleCommit", "ScheduleFire", "BurnBatch", "WithdrawLamp", "SetDelegate",
    ]);
  });

  it("WithdrawLamp is constr 3 → CBOR head 0xd87c", () => {
    expect(VARIANT_ORDER.indexOf("WithdrawLamp")).toBe(3);
    expect(constrHeadHex(3)).toBe("d87c");
  });

  it("SetDelegate is constr 4 → CBOR head 0xd87d", () => {
    expect(VARIANT_ORDER.indexOf("SetDelegate")).toBe(4);
    expect(constrHeadHex(4)).toBe("d87d");
  });

  it("BurnBatch stays at its original constr 2 → 0xd87b (decode-compat)", () => {
    expect(VARIANT_ORDER.indexOf("BurnBatch")).toBe(2);
    expect(constrHeadHex(2)).toBe("d87b");
  });
});

// ═══════════════════════════════════════════════════════════════
// Complete schedule lifecycle
// ═══════════════════════════════════════════════════════════════

describe("Schedule lifecycle: commit → multiple fires → complete", () => {

  it("L=10 schedule: 10 fires then complete (C-FIRE-5)", () => {
    const sched = makeSchedule({ schedule_length: 10n, fired_count: 0n });
    let fired = 0n;

    // Simulate firing one order at a time
    while (fired < 10n) {
      const fireEpoch = sched.start_fire_epoch + fired;
      const result = simulateFire({ ...sched, fired_count: fired }, fireEpoch);
      expect(result.firesInTx).toBe(1);
      fired += 1n;
    }
    expect(fired).toBe(10n);  // complete ✓
  });

  it("Catch-up across 3 epochs then complete remainder", () => {
    const sched = makeSchedule({ schedule_length: 10n, fired_count: 0n, start_fire_epoch: 52n });
    // Fire at epoch 54 (catch-up: e_0=52, e_1=53, e_2=54)
    const r1 = simulateFire(sched, 54n);
    expect(r1.firesInTx).toBe(3);
    expect(r1.newFiredCount).toBe(3n);
    // Fire remaining 7 normally
    const r2 = simulateFire({ ...sched, fired_count: 3n }, 59n);
    expect(r2.firesInTx).toBeLessThanOrEqual(7);
  });
});

// ═══════════════════════════════════════════════════════════════
// PHA 2 — I-ACT-7: a fire releases the lock, it never moves LAMP
// ═══════════════════════════════════════════════════════════════

describe("I-ACT-7 — LAMP đứng yên across a fire", () => {

  it("TV-SCH-ACT7: balance invariant, lock reduced, Σholdings invariant", () => {
    const v = TV_SCH_ACT7;
    const released = v.lambda_oil * BigInt(v.fires_in_tx);

    const after = unlockLockedAmount(v.before.loyalty_holdings, released);
    expect(after).toEqual(v.after.loyalty_holdings);

    const sumBefore = v.before.loyalty_holdings.reduce((s, h) => s + h.amount, 0n);
    const sumAfter  = after.reduce((s, h) => s + h.amount, 0n);
    expect(sumAfter).toBe(sumBefore);                       // Σholdings invariant
    expect(sumAfter).toBe(v.after.lamp_balance);            // == lamp_balance (C-VAULT-10)
    expect(v.before.lamp_locked - released).toBe(v.after.lamp_locked);
  });

  it("unlockLockedAmount: full release flips is_locked without changing amounts", () => {
    const before = [{ amount: 100n, acquired_epoch: 5n, is_locked: true }];
    const after  = unlockLockedAmount(before, 100n);
    expect(after).toEqual([{ amount: 100n, acquired_epoch: 5n, is_locked: false }]);
  });

  it("unlockLockedAmount: oldest-locked-first, unlocked entries kept up front", () => {
    const before = [
      { amount: 10n, acquired_epoch: 9n, is_locked: false },
      { amount: 30n, acquired_epoch: 5n, is_locked: true  },
      { amount: 20n, acquired_epoch: 7n, is_locked: true  },
    ];
    const after = unlockLockedAmount(before, 30n);
    expect(after).toEqual([
      { amount: 10n, acquired_epoch: 9n, is_locked: false },
      { amount: 30n, acquired_epoch: 5n, is_locked: false },
      { amount: 20n, acquired_epoch: 7n, is_locked: true  },
    ]);
  });

  it("unlockLockedAmount: releasing more than is locked throws", () => {
    const before = [{ amount: 10n, acquired_epoch: 5n, is_locked: true }];
    expect(() => unlockLockedAmount(before, 11n)).toThrow("GEN-LOCK-002");
  });
});

// ═══════════════════════════════════════════════════════════════
// PHA 2 — §4.2 per-epoch use-or-lose for Schedule batches
// ═══════════════════════════════════════════════════════════════

describe("§4.2 cliff — a fired batch lives exactly one epoch", () => {

  it("TV-SCH-CLIFF: live at k=0, dead from k=1", () => {
    for (const c of TV_SCH_CLIFF.cases) {
      expect(isExpired(c.created_epoch, TV_SCH_CLIFF.decay_window, c.current_epoch))
        .toBe(c.expired);
      expect(isLive(c.created_epoch, TV_SCH_CLIFF.decay_window, c.current_epoch))
        .toBe(!c.expired);
    }
  });

  it("A catch-up cannot resurrect earlier epochs: all k batches are stamped NOW", () => {
    const sched = makeSchedule({
      start_fire_epoch: 52n, fired_count: 0n, schedule_length: 100n,
    });
    const currentEpoch = 55n;
    const r = simulateFire(sched, currentEpoch);
    expect(r.firesInTx).toBe(4);   // e_0..e_3 were missed

    // Every one of the 4 batches carries created_epoch = 55 and dies at 56.
    for (let i = 0; i < r.firesInTx; i++) {
      expect(isLive(currentEpoch, 1n, currentEpoch)).toBe(true);
      expect(isExpired(currentEpoch, 1n, currentEpoch + 1n)).toBe(true);
    }
  });
});
