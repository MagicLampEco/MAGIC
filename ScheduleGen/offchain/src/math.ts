// src/math.ts — ScheduleGen BigInt Math Engine
// ALL arithmetic uses BigInt. No Number for oildrop/nanogic/Q-format (C-OVERFLOW).

import {
  Q, SNAPSHOT_BASE_RATE_Q,
  S_SEG1_INTERCEPT_Q, S_SEG1_SLOPE_Q,
  S_SEG2_KNEE, S_SEG2_INTERCEPT_Q, S_SEG2_SLOPE_Q,
  S_SEG3_KNEE, S_SEG3_INTERCEPT_Q, S_SEG3_SLOPE_Q,
} from "./constants.js";
import {
  slotToEpoch, lampToOildrop, lAvail, nanogicToMagicStr, qToStr,
  selectLampForLock, removeLockedAmount,
} from "@magiclamp/protocol-utils";
import { blake2b } from "@noble/hashes/blake2b";

export { slotToEpoch, lampToOildrop, lAvail, nanogicToMagicStr, qToStr };
export { selectLampForLock, removeLockedAmount };

// ══════════════════════════════════════════════════════════════
// §11.3 S(L) — Schedule bonus multiplier (piecewise, T11, T12)
// ══════════════════════════════════════════════════════════════
//
// TV-SCH-01 values (must be bit-identical):
//   L=10  → 1_600_000_000   L=50  → 2_000_000_000
//   L=100 → 2_250_000_000   L=150 → 2_500_000_000
//   L=200 → 2_625_000_000
//
// T11: Continuous at L=50 and L=150 (C.3 proof)
// T12: dS/dL strictly decreasing (C.4 proof)

export function computeSQ(L: bigint): bigint {
  if (L <= S_SEG2_KNEE) {
    return S_SEG1_INTERCEPT_Q + S_SEG1_SLOPE_Q * L;                 // seg 1
  } else if (L <= S_SEG3_KNEE) {
    return S_SEG2_INTERCEPT_Q + S_SEG2_SLOPE_Q * (L - S_SEG2_KNEE); // seg 2
  } else {
    return S_SEG3_INTERCEPT_Q + S_SEG3_SLOPE_Q * (L - S_SEG3_KNEE); // seg 3
  }
}

// ══════════════════════════════════════════════════════════════
// §11.2 rate_locked_q — immutable, locked at commit (T8)
// ══════════════════════════════════════════════════════════════
//
// rate_locked_q = ⌊ R_snap_c × S_Q(L) / Q ⌋
//
// T8: Stored in GenSchedule.rate_locked_q; never recomputed at fire.
//   DAO may update R_snap → only affects FUTURE commits.
//   Fire always reads the STORED rate_locked_q.
//
// TV-SCH-02: L=100, R_snap=5B → S_Q=2.25B → rate_locked_q=11_250_000_000 ✓
// TV-SCH-03: Rate immutability — same rate after DAO update ✓

export function computeRateLockedQ(
  rSnapQ : bigint = SNAPSHOT_BASE_RATE_Q,
  L      : bigint,
): bigint {
  return rSnapQ * computeSQ(L) / Q;
}

// ══════════════════════════════════════════════════════════════
// §11.4 M_i — MAGIC per fire (T-DET: all orders identical)
// ══════════════════════════════════════════════════════════════
//
// M_i = ⌊ λ × rate_locked_q / Q ⌋
//
// T-DET: rate_locked_q immutable + same λ → every fire gets identical M_i
// T19:   C-SCH-RATE ensures M_i ≥ 1
//
// TV-SCH-02: λ=4000 LAMP=4×10⁹ oildrop, rate_locked_q=11_250_000_000
//   M_i = ⌊4×10⁹ × 11_250_000_000 / Q⌋ = 45_000_000_000 = 45 MAGIC ✓

export function computeMi(lambdaOildrop: bigint, rateLockedQ: bigint): bigint {
  return lambdaOildrop * rateLockedQ / Q;
}

// ── C-SCH-RATE: M_i ≥ 1 guarantee (T19) ─────────────────────
export function checkSchRate(lambdaOildrop: bigint, rateLockedQ: bigint): boolean {
  return lambdaOildrop * rateLockedQ >= Q;
}

// ══════════════════════════════════════════════════════════════
// §5.5 shard_id — deterministic from owner PKH (C-SCH-FIRE-SHARD)
// ══════════════════════════════════════════════════════════════
//
// shard_id(owner) = first_byte(blake2b256(owner)) % 16
// MUST match onchain/lib/math.ak: compute_shard_id (P8)

export function computeShardId(ownerPkh: string): number {
  const hash = blake2b(Buffer.from(ownerPkh, "hex"), { dkLen: 32 });
  return hash[0]! % 16;
}

// ══════════════════════════════════════════════════════════════
// Fire epoch for next eligible order
// ══════════════════════════════════════════════════════════════

export function nextFireEpoch(startFireEpoch: bigint, firedCount: bigint): bigint {
  return startFireEpoch + firedCount;   // e_i = start + fired_count (before this fire)
}

export function countEligibleFires(
  startFireEpoch : bigint,
  firedCount     : bigint,
  scheduleLength : bigint,
  currentEpoch   : bigint,
  currentBatches : number,
): number {
  const remaining    = Number(scheduleLength - firedCount);
  const batchBudget  = MAX_BATCHES_PER_VAULT - currentBatches;
  let fires = 0;
  while (
    fires < 8 &&                                              // MAX_FIRES_PER_TX_CATCHUP
    fires < remaining &&
    fires < batchBudget &&
    startFireEpoch + firedCount + BigInt(fires) <= currentEpoch
  ) {
    fires++;
  }
  return fires;
}

import { MAX_BATCHES_PER_VAULT } from "./constants.js";

// Utility + lock helpers are re-exported from @magiclamp/protocol-utils
// (single source of truth, P8). See imports/re-exports at top of file.
