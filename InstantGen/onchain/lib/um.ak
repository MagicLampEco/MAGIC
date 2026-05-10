// lib/um.ak — Network Demand Multiplier (§14)
// C-UM-6: Instant staleness check. C-UM-7: Vacuum uses smoothed always (different file).
// This file implements ONLY the Instant path.

use magiclamp/instantgen/lib/types.{UMDatum}
use magiclamp/instantgen/lib/constants.{
  um_min_q, um_max_q, um_max_staleness, um_fallback_q, um_smoothing_window,
}

// ── C-UM-6: Instant staleness check ──────────────────────────
//
// staleness = current_epoch − UM_datum.last_updated_epoch
// staleness ≤ 1 → use UM_datum.smoothed_q
// staleness > 1 → use UM_FALLBACK_Q = UM_MIN_Q = 500_000_000
//
// Rationale: User chooses Instant timing → can wait for keeper update.
// Stale fallback is fair deterrent (not a tx rejection).
// TV-UM-SPLIT: UM_datum.smoothed=2B, last_updated=98, current=100
//   → staleness=2 > 1 → result = 500_000_000 (UM_MIN_Q) ✓

pub fn get_um_for_instant(um: UMDatum, current_epoch: Int) -> Int {
  let staleness = current_epoch - um.last_updated_epoch
  if staleness <= um_max_staleness {
    um.smoothed_q
  } else {
    um_fallback_q
  }
}

// ── C-UM-3: UM range invariant ───────────────────────────────
// Smoothed UM must be in [UM_MIN_Q, UM_MAX_Q] at all times.
// The validator checks this on the UM datum reference input.
pub fn validate_um_range(um: UMDatum) -> Bool {
  um.smoothed_q >= um_min_q && um.smoothed_q <= um_max_q
}

// ── C-UM-1: Smoothed UM computation (for off-chain reference) ─
// Not validated on-chain in InstantGen (UM is updated in a separate tx).
// Included here for completeness and off-chain mirror.
//
// um_raw       = ⌊ epoch_burns × Q / max(epoch_mints, 1) ⌋
// um_smoothed  = clamp(sum(last_6_raw) / len(history), UM_MIN_Q, UM_MAX_Q)

pub fn compute_um_smoothed(history: List<Int>) -> Int {
  let len = list.length(history)
  if len == 0 {
    // No history: neutral UM = Q
    1_000_000_000
  } else {
    let raw_sum = list.foldl(history, 0, fn(acc, x) { acc + x })
    let avg = raw_sum / len
    if avg < um_min_q { um_min_q }
    else if avg > um_max_q { um_max_q }
    else { avg }
  }
}

// ── C-UM-2: History cap ──────────────────────────────────────
// |history| ≤ UM_SMOOTHING_WINDOW = 6
pub fn validate_um_history_length(um: UMDatum) -> Bool {
  list.length(um.history) <= um_smoothing_window
}

use aiken/list
