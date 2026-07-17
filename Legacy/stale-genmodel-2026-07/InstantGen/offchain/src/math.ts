// src/math.ts — BigInt Math Engine (spec §6)
// ALL arithmetic uses BigInt. NEVER use Number for oildrop/nanogic/Q-format (C-OVERFLOW).
// TV-OVERFLOW-01/02: Number fails for large values. BigInt required.

import {
  Q, INSTANT_BASE_RATE_Q, PM_Q, UM_FALLBACK_Q, UM_MAX_STALENESS,
} from "./constants.js";
import {
  slotToEpoch, nanogicToMagicStr, qToStr, lampToOildrop, oildropToLamp,
} from "@magiclamp/protocol-utils";
import type { UMDatum } from "./types.js";

// Re-export shared primitives to preserve module's public API
export { slotToEpoch, nanogicToMagicStr, qToStr, lampToOildrop, oildropToLamp };

// ── §6.1 Q-format operations ─────────────────────────────────

/** ⌊x × m_q / Q⌋ — error ≤ 1 nanogic per call (L4) */
export function applyMultiplier(x: bigint, mQ: bigint): bigint {
  return x * mQ / Q;
}

/** ⌊a_q × b_q / Q⌋ — multiply two Q-format values */
export function multiplyQ(aQ: bigint, bQ: bigint): bigint {
  return aQ * bQ / Q;
}

// ── Epoch helpers ────────────────────────────────────────────

/** Batch age k = current_epoch - created_epoch */
export function batchAge(createdEpoch: bigint, currentEpoch: bigint): bigint {
  const k = currentEpoch - createdEpoch;
  if (k < 0n) throw new Error(`Negative batch age: created=${createdEpoch}, current=${currentEpoch}`);
  return k;
}

// ── §9.1 InstantGen formula ───────────────────────────────────
//
// M_instant = ⌊ L_paid × R_inst × UM_checked × PM ⌋ / Q³
//
// Applied as 3 sequential floor multiplications (L4: ≤ 3 nanogic error):
//   step1 = ⌊ L_paid × R_inst / Q ⌋
//   step2 = ⌊ step1 × UM_q / Q ⌋
//   step3 = ⌊ step2 × PM_q / Q ⌋
//
// TV-SNAPGEN-01 equivalent for Instant:
//   Instant 1000 LAMP, Flame, UM=1.0 → ≈ 3.15 MAGIC (§20.3)
//
// Verify:
//   L = 1000 × 10^6 = 10^9 oildrop
//   step1 = 10^9 × 3_000_000_000 / Q = 3_000_000_000
//   step2 = 3_000_000_000 × Q / Q    = 3_000_000_000  (UM=1.0)
//   step3 = 3_000_000_000 × 1_050_000_000 / Q = 3_150_000_000  (PM_Flame)
//   Result: 3_150_000_000 nanogic = 3.15 MAGIC ✓

export function computeInstantMagic(
  lampPaid : bigint,  // in oildrop
  umQ      : bigint,  // Q-format UM (after stale check)
  pmQ      : bigint,  // Q-format PM for the vault's profile
): bigint {
  const s1 = lampPaid * INSTANT_BASE_RATE_Q / Q;  // step 1
  const s2 = s1 * umQ / Q;                         // step 2
  const s3 = s2 * pmQ / Q;                         // step 3
  return s3;
}

// ── §14.4 C-UM-6: UM for Instant ─────────────────────────────
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

// ── §4.3 Instant batch halving ───────────────────────────────
//
// C-DECAY-7: k=1 ∧ halved=False → current=⌊current/2⌋; halved=True
// C-DECAY-8: halved immutable in all other txs (TV-HALVED-INJECT)
// T18: halved=True prevents inter-block double-halving (C.9)

/** Should this Instant batch be halved at current_epoch? */
export function shouldHalve(
  source       : string,
  createdEpoch : bigint,
  currentEpoch : bigint,
  halved       : boolean,
): boolean {
  const k = currentEpoch - createdEpoch;
  return source === "Instant" && k === 1n && !halved;
}

/** Apply halving (floor division by 2) and set halved=True. */
export function applyHalving(currentAmount: bigint): bigint {
  return currentAmount / 2n; // floor
}

// ── §4.3 Instant batch balance ───────────────────────────────
//
// k=0: current_amount (pre-halving)
// k=1: current_amount (halved=True in datum already if applied)
// k≥2: 0 (expired)

export function instantBatchBalance(
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

// ── §4 Prune check ───────────────────────────────────────────

export function isExpired(
  createdEpoch : bigint,
  decayWindow  : bigint,
  currentEpoch : bigint,
): boolean {
  return (currentEpoch - createdEpoch) >= decayWindow;
}

// (unit conversions and display helpers are re-exported from
// @magiclamp/protocol-utils — see top of file)
