// src/math.ts — VacuumGen BigInt Math Engine
// ALL arithmetic uses BigInt. No Number for oil/nanogic/Q-format (C-OVERFLOW).

import {
  Q, VBR_Q, SM_Q, UM_MIN_Q, UM_MAX_Q, VACUUM_DECAY_WINDOW,
  SLOTS_PER_EPOCH, OIL_PER_LAMP, NANOGIC_PER_MAGIC,
} from "./constants.js";
import type { LoyaltyHolding, UMDatum, StreakState } from "./types.js";

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
  lambdaOil : bigint,  // in oil
  umQ       : bigint,  // C-UM-7: always smoothed
  smQ       : bigint,
): bigint {
  const s1 = lambdaOil * VBR_Q / Q;   // × VBR (0.5)
  const s2 = s1 * umQ / Q;             // × UM_smoothed
  return s2 * smQ / Q;                 // × SM
}

// ══════════════════════════════════════════════════════════════
// §6.8 LAMP lock — youngest-first (T5, C.6)
// ══════════════════════════════════════════════════════════════
//
// Locks youngest holdings first → free = oldest → LF(free) maximized.
// TV-LOCK-01: [{1000,50},{2000,80},{1500,60}], lock=2500
//   Sorted: [2000@80, 1500@60, 1000@50]
//   Lock 2000@80 (rem=500); Lock 500@60+Free 1000@60; Free 1000@50 ✓
//
// MUST match onchain/lib/lock.ak: select_lamp_for_lock (P8)

export function selectLampForLock(
  holdings : LoyaltyHolding[],
  amount   : bigint,
): LoyaltyHolding[] {
  // Sort youngest-first (desc acquired_epoch)
  const sorted = [...holdings].sort((a, b) =>
    Number(b.acquired_epoch - a.acquired_epoch),
  );

  let remaining = amount;
  const result: LoyaltyHolding[] = [];

  for (const h of sorted) {
    if (remaining <= 0n) {
      result.push(h);
    } else if (remaining >= h.amount) {
      result.push({ ...h, is_locked: true });
      remaining -= h.amount;
    } else {
      result.push({ amount: remaining,           acquired_epoch: h.acquired_epoch, is_locked: true  });
      result.push({ amount: h.amount - remaining, acquired_epoch: h.acquired_epoch, is_locked: false });
      remaining = 0n;
    }
  }

  if (remaining > 0n) throw new Error(`GEN-VAC-001: insufficient L_avail (remaining=${remaining})`);
  return result;
}

// ══════════════════════════════════════════════════════════════
// §A.9 remove_locked_amount — oldest-locked-first
// ══════════════════════════════════════════════════════════════
// Called at fire time: remove λ from locked holdings.
// MUST match onchain/lib/lock.ak: remove_locked_amount (P8)

export function removeLockedAmount(
  holdings : LoyaltyHolding[],
  amount   : bigint,
): LoyaltyHolding[] {
  const unlocked = holdings.filter(h => !h.is_locked);
  const locked   = holdings.filter(h =>  h.is_locked)
    .sort((a, b) => Number(a.acquired_epoch - b.acquired_epoch)); // oldest first

  let remaining = amount;
  const resultLocked: LoyaltyHolding[] = [];

  for (const h of locked) {
    if (remaining <= 0n) {
      resultLocked.push(h);
    } else if (remaining >= h.amount) {
      remaining -= h.amount;
    } else {
      resultLocked.push({ ...h, amount: h.amount - remaining });
      remaining = 0n;
    }
  }

  if (remaining > 0n) throw new Error(`removeLockedAmount: insufficient locked (remaining=${remaining})`);
  return [...unlocked, ...resultLocked];
}

// ── Expiry check ─────────────────────────────────────────────
// Vacuum decay_window = 1 → cliff at k=1
export function isVacuumExpired(createdEpoch: bigint, currentEpoch: bigint): boolean {
  return (currentEpoch - createdEpoch) >= VACUUM_DECAY_WINDOW;
}

// ── Utility ──────────────────────────────────────────────────
export function slotToEpoch(slot: bigint): bigint { return slot / SLOTS_PER_EPOCH; }
export function lampToOil(lamp: bigint): bigint   { return lamp * OIL_PER_LAMP; }
export function lAvail(balance: bigint, locked: bigint): bigint { return balance - locked; }

export function nanogicToMagicStr(ng: bigint, dec = 4): string {
  if (ng <= 0n) return "0." + "0".repeat(dec);
  return `${ng / NANOGIC_PER_MAGIC}.${(ng % NANOGIC_PER_MAGIC).toString().padStart(9, "0").slice(0, dec)}`;
}

export function qToStr(q_val: bigint, dec = 2): string {
  return (Number(q_val) / 1e9).toFixed(dec);
}
