// src/math.ts — BigInt math engine (§6.1, §6.3, §11)
//
// ALL arithmetic uses BigInt. NEVER use Number for oildrop/nanogic/Q-format
// (C-OVERFLOW) — TV-OVERFLOW-01/02 exist precisely to catch a Number regression.
//
// P8: every function here mirrors onchain/lib/magiclamp/protocol/{math,decay}.ak
// bit-for-bit. Change one side ⟹ change the other side in the same commit.

import {
  Q, INSTANT_REWARD_RATE_Q, BR_SAFE_Q, F_CAP_SURPLUS_Q,
  UM_FALLBACK_Q, UM_MAX_STALENESS,
} from "./constants.js";
import {
  slotToEpoch, nanogicToMagicStr, qToStr, lampToOil, oilToLamp,
} from "@magiclamp/protocol-utils";
import type { UMDatum, GenSchedule } from "./types.js";

// Re-export shared primitives to preserve module's public API
export { slotToEpoch, nanogicToMagicStr, qToStr, lampToOil, oilToLamp };

// ── §6.1 Q-format operations ─────────────────────────────────

/** ⌊x × m_q / Q⌋ — error ≤ 1 nanogic per call (L4) */
export function applyMultiplier(x: bigint, mQ: bigint): bigint {
  return x * mQ / Q;
}

/** ⌊a_q × b_q / Q⌋ — multiply two Q-format values */
export function multiplyQ(aQ: bigint, bQ: bigint): bigint {
  return aQ * bQ / Q;
}

export function min2(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function min3(a: bigint, b: bigint, c: bigint): bigint {
  return min2(min2(a, b), c);
}

// ── Epoch helpers ────────────────────────────────────────────

/** Batch age k = current_epoch - created_epoch */
export function batchAge(createdEpoch: bigint, currentEpoch: bigint): bigint {
  const k = currentEpoch - createdEpoch;
  if (k < 0n) throw new Error(`Negative batch age: created=${createdEpoch}, current=${currentEpoch}`);
  return k;
}

// ══════════════════════════════════════════════════════════════
// §6.3 InstantGen — magnitude keyed to MAGIC ALREADY CONSUMED
// ══════════════════════════════════════════════════════════════
//
//   cấp thực = min( reward(consumed), cap_surplus(br), 0.5 × pp_schedule )
//
// Holding LAMP only OPENS the door; it no longer sizes the grant, and no LAMP
// moves (I-ACT-7).

/**
 * reward(consumed) = ⌊ ⌊ ⌊ consumed × R_reward / Q ⌋ × UM / Q ⌋ × PM / Q ⌋
 *
 * 3 sequential floor steps (≤ 3 nanogic total error, result ≤ true value).
 * INV-CASHBACK-BOUND holds by parameter construction:
 *   R_reward × UM_MAX × PM_MAX = 0.20 × 2.00 × 1.15 = 0.46 < 1
 *
 * Mirrors math.ak: compute_reward_from_consumed.
 */
export function computeRewardFromConsumed(
  consumed: bigint,  // nanogic already burned and not yet rewarded
  umQ     : bigint,  // Q-format UM (after the C-UM-6 stale check)
  pmQ     : bigint,  // Q-format profile multiplier (tư-cách, §6.2)
): bigint {
  const s1 = consumed * INSTANT_REWARD_RATE_Q / Q;  // step 1
  const s2 = s1 * umQ / Q;                           // step 2
  const s3 = s2 * pmQ / Q;                           // step 3
  return s3;
}

/**
 * cap_surplus(br):
 *   xanh (br >  br_safe):  f · S · (br − br_safe) / br_safe
 *   đỏ   (br ≤  br_safe):  0  (khoá Gen)
 *
 * Sequential floors:
 *   s1 = ⌊ S  × f_q       / Q ⌋
 *   s2 = ⌊ s1 × (br−safe) / Q ⌋
 *   s3 = ⌊ s2 × Q / br_safe_q ⌋
 *
 * `brQ`/`magicSupply` come from the BackingBeacon reference input. There is NO
 * default: a missing/stale/depegged beacon must stop the tx before this call.
 *
 * Mirrors math.ak: compute_cap_surplus.
 */
export function computeCapSurplus(brQ: bigint, magicSupply: bigint): bigint {
  if (brQ <= BR_SAFE_Q) return 0n;
  const excessQ = brQ - BR_SAFE_Q;
  const s1 = magicSupply * F_CAP_SURPLUS_Q / Q;
  const s2 = s1 * excessQ / Q;
  return s2 * Q / BR_SAFE_Q;
}

/**
 * pp_schedule = Σ ⌊ λ_i × rate_locked_q_i / Q ⌋ over the vault's live
 * ScheduleGen contracts — the per-epoch MAGIC guaranteed by §6.4.
 *
 * Mirrors math.ak: compute_pp_schedule.
 */
export function computePpSchedule(
  schedules: ReadonlyArray<Pick<GenSchedule, "lamp_per_epoch" | "rate_locked_q">>,
): bigint {
  let acc = 0n;
  for (const s of schedules) acc += s.lamp_per_epoch * s.rate_locked_q / Q;
  return acc;
}

/** 0.5 × pp_schedule (floor). Empty schedules ⟹ 0 ⟹ InstantGen SHUT. */
export function computeCapPp(
  schedules: ReadonlyArray<Pick<GenSchedule, "lamp_per_epoch" | "rate_locked_q">>,
): bigint {
  return computePpSchedule(schedules) / 2n;
}

/** The whole §6.3 gate. Mirrors math.ak: compute_instant_grant. */
export function computeInstantGrant(
  consumed    : bigint,
  umQ         : bigint,
  pmQ         : bigint,
  brQ         : bigint,
  magicSupply : bigint,
  schedules   : ReadonlyArray<Pick<GenSchedule, "lamp_per_epoch" | "rate_locked_q">>,
): bigint {
  return min3(
    computeRewardFromConsumed(consumed, umQ, pmQ),
    computeCapSurplus(brQ, magicSupply),
    computeCapPp(schedules),
  );
}

// ── C-UM-6: UM for Instant ───────────────────────────────────
//
// staleness = current_epoch − UM_datum.last_updated_epoch
// ≤ 1 → use smoothed; > 1 → UM_FALLBACK_Q = 500_000_000
//
// TV-UM-SPLIT: smoothed=2B, last_updated=98, current=100
//   → staleness=2 > 1 → result = 500_000_000 ✓

export function getUmForInstant(um: UMDatum, currentEpoch: bigint): bigint {
  const staleness = currentEpoch - um.last_updated_epoch;
  if (staleness <= UM_MAX_STALENESS) {
    return um.smoothed_q;
  }
  return UM_FALLBACK_Q;
}

// ── §4.2 batch lifetime (CLIFF) ──────────────────────────────
//
// k = 0            → LIVE (full current_amount, burnable)
// k ≥ decay_window → DEAD (worth 0, NOT burnable, garbage-collectable)
//
// with decay_window = 1 for every source. There is no halving step at any k.

export function isExpired(
  createdEpoch: bigint,
  decayWindow : bigint,
  currentEpoch: bigint,
): boolean {
  return (currentEpoch - createdEpoch) >= decayWindow;
}

export function isLive(
  createdEpoch: bigint,
  decayWindow : bigint,
  currentEpoch: bigint,
): boolean {
  return !isExpired(createdEpoch, decayWindow, currentEpoch);
}

/** Live balance of a batch — 0 once the cliff has passed. */
export function batchBalance(
  currentAmount: bigint,
  decayWindow  : bigint,
  createdEpoch : bigint,
  currentEpoch : bigint,
): bigint {
  const k = currentEpoch - createdEpoch;
  if (k < 0n) throw new Error("Negative batch age");
  if (k >= decayWindow) return 0n;
  return currentAmount;
}

// (unit conversions and display helpers are re-exported from
// @magiclamp/protocol-utils — see top of file)
