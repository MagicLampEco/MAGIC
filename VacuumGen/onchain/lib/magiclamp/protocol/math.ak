// lib/math.ak — VacuumGen formula + SM + UM (C-UM-7)
// Normative §10.1, §6.5, §14.4 C-UM-7

use magiclamp/protocol/constants.{
  q, vbr_q, sm_q_base, sm_q_3_5, sm_q_6_11, sm_q_12_plus,
  um_min_q, um_max_q,
}
use magiclamp/protocol/types.{UMDatum, StreakState}

// ══════════════════════════════════════════════════════════════
// §6.5 Streak Multiplier (SM)
// ══════════════════════════════════════════════════════════════
//
// streak <3  → SM = 1.00
// streak 3-5 → SM = 1.05
// streak 6-11→ SM = 1.10
// streak ≥12 → SM = 1.20

pub fn get_sm_q(streak: Int) -> Int {
  if streak >= 12 { sm_q_12_plus }
  else if streak >= 6 { sm_q_6_11 }
  else if streak >= 3 { sm_q_3_5 }
  else { sm_q_base }
}

pub fn compute_sm_q(streak_state: StreakState) -> Int {
  get_sm_q(streak_state.current_streak)
}

// ══════════════════════════════════════════════════════════════
// §14.4 C-UM-7: UM for VacuumFire — ALWAYS smoothed, NO stale check
// ══════════════════════════════════════════════════════════════
//
// Rationale: fire_epoch is predetermined 2 epochs before commit.
// User cannot choose timing → stale fallback would be unjust.
// Also prevents griefing: attacker firing early would get same UM.
//
// TV-UM-SPLIT: Vacuum always gets smoothed=2B regardless of staleness ✓

pub fn get_um_for_vacuum(um: UMDatum) -> Int {
  um.smoothed_q   // C-UM-7: always smoothed, no stale check
}

pub fn validate_um_range(um: UMDatum) -> Bool {
  um.smoothed_q >= um_min_q && um.smoothed_q <= um_max_q
}

// ══════════════════════════════════════════════════════════════
// §10.1 VacuumGen formula — 3 multiplications
// ══════════════════════════════════════════════════════════════
//
// M_vacuum = ⌊ λ × VBR × UM_smoothed × SM ⌋ / Q³
//
// Note: NO Profile Multiplier PM (§6.10 M_vacuum chain has no PM)
// Note: NO Loyalty Factor LF
// Note: UM_smoothed via C-UM-7 (no stale check)
//
// TV-VAC-01: λ=10⁹, UM=1.5, streak=8 → SM=1.10
//   step1 = 10⁹ × 500M / Q = 500M
//   step2 = 500M × 1.5B / Q = 750M
//   step3 = 750M × 1.1B / Q = 825_000_000 ✓
//
// §20.3 calibration: λ=10⁹, UM=1.0, streak=0 → 500M = 0.5 MAGIC ✓

pub fn compute_vacuum_magic(
  lambda : Int,   // in oildrop
  um_q   : Int,   // Q-format UM_smoothed (C-UM-7)
  sm_q   : Int,   // Q-format Streak Multiplier
) -> Int {
  let s1 = lambda * vbr_q / q   // × VBR (0.5)
  let s2 = s1 * um_q / q        // × UM_smoothed
  s2 * sm_q / q                  // × SM
}
