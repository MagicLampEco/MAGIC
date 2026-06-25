// src/math.ts — VacuumGen BigInt Math Engine
// ALL arithmetic uses BigInt. No Number for oildrop/nanogic/Q-format (C-OVERFLOW).

import {
  Q, VBR_Q, SM_Q, UM_MIN_Q, UM_MAX_Q, VACUUM_DECAY_WINDOW,
} from "./constants.js";
import {
  slotToEpoch, lampToOildrop, lAvail, nanogicToMagicStr, qToStr,
  selectLampForLock, removeLockedAmount,
} from "@magiclamp/protocol-utils";
import type { LoyaltyHolding, UMDatum, StreakState } from "./types.js";

export { slotToEpoch, lampToOildrop, lAvail, nanogicToMagicStr, qToStr };
export { selectLampForLock, removeLockedAmount };

// ══════════════════════════════════════════════════════════════
// §6.5 Streak Multiplier
// ══════════════════════════════════════════════════════════════

export function getSmQ(streak: bigint): bigint {
  if (streak >= 12n) return SM_Q["12plus"]!;
  if (streak >= 6n)  return SM_Q["6_11"]!;
  if (streak >= 3n)  return SM_Q["3_5"]!;
  return SM_Q["base"]!;
}

export function computeSmQ(streakState: StreakState): bigint {
  return getSmQ(streakState.current_streak);
}

// ══════════════════════════════════════════════════════════════
// §14.4 C-UM-7: UM for VacuumFire — ALWAYS smoothed, NO stale check
// ══════════════════════════════════════════════════════════════
//
// Rationale: fire_epoch = commit_epoch + 2 (predetermined).
// User cannot avoid stale UM → stale penalty would be unjust.
// Also blocks griefing: A fires early → same UM, zero griefing incentive (§10.2).
//
// TV-UM-SPLIT: smoothed=2B, last_updated=98, current=100
//   Instant: staleness=2 > 1 → UM_FALLBACK=500M ✓
//   Vacuum:  always smoothed=2_000_000_000 ✓

export function getUmForVacuum(um: UMDatum): bigint {
  return um.smoothed_q;   // C-UM-7: always smoothed, never fallback
}

export function validateUmRange(um: UMDatum): boolean {
  return um.smoothed_q >= UM_MIN_Q && um.smoothed_q <= UM_MAX_Q;
}

// ══════════════════════════════════════════════════════════════
// §10.1 VacuumGen formula — 3 multiplications
// ══════════════════════════════════════════════════════════════
//
// M_vacuum = ⌊ λ × VBR × UM_smoothed × SM ⌋ / Q³
//
// NO Profile Multiplier PM (§6.10 — M_vacuum chain)
// NO Loyalty Factor LF
//
// TV-VAC-01: λ=10⁹, UM=1.5, streak=8 → SM_Q=1.1B → 825_000_000 ✓
//   step1 = 10⁹ × 500M / Q = 500_000_000
//   step2 = 500M × 1.5B / Q = 750_000_000
//   step3 = 750M × 1.1B / Q = 825_000_000
//
// §20.3: λ=10⁹, UM=1.0, streak=0 → 500_000_000 = 0.5 MAGIC ✓

export function computeVacuumMagic(
  lambdaOildrop : bigint,  // in oildrop
  umQ       : bigint,  // C-UM-7: always smoothed
  smQ       : bigint,
): bigint {
  const s1 = lambdaOildrop * VBR_Q / Q;   // × VBR (0.5)
  const s2 = s1 * umQ / Q;             // × UM_smoothed
  return s2 * smQ / Q;                 // × SM
}

// §6.8 selectLampForLock + §A.9 removeLockedAmount — re-exported from
// @magiclamp/protocol-utils (single source of truth, P8).

// ── Expiry check ─────────────────────────────────────────────
// Vacuum decay_window = 1 → cliff at k=1
export function isVacuumExpired(createdEpoch: bigint, currentEpoch: bigint): boolean {
  return (currentEpoch - createdEpoch) >= VACUUM_DECAY_WINDOW;
}

// (slotToEpoch, lampToOildrop, lAvail, nanogicToMagicStr, qToStr re-exported
// from @magiclamp/protocol-utils — see top of file)
