// lib/lf_oac.ak — Loyalty Factor + OAC (spec §6.3, §6.4)
// Both are inputs to M_snapshot; neither depends on UM (T16, P10).

use aiken/collection/list
use magiclamp/protocol/constants.{
  q, oac_base_q, oac_increment_q, oac_cap_apps, drm_lookback,
  lf_cap_age,
}
use magiclamp/protocol/types.{LoyaltyHolding, ActivityState}

// ══════════════════════════════════════════════════════════════
// §6.3 Loyalty Factor
// ══════════════════════════════════════════════════════════════
//
// LF(age) piecewise linear:
//   age ≤ 0          → 1.00
//   0  < age ≤ 6     → 1.00 + 0.10 × age/6
//   6  < age ≤ 12    → 1.10 + 0.10 × (age-6)/6
//   12 < age ≤ 24    → 1.20 + 0.30 × (age-12)/12
//   age > 24         → 1.50 (cap)
//
// Weighted average across ALL holdings (locked + free) (L3).
// Q-format with floor at each step.

/// LF for a single holding age (Q-format). TV-LF-01, TV-LF-02.
pub fn lf_pwl_q(age: Int) -> Int {
  if age <= 0 {
    q                                                   // 1.00
  } else if age <= 6 {
    q + q / 10 * age / 6                               // 1.00..1.10
  } else if age <= 12 {
    q + q / 10 + q / 10 * ( age - 6 ) / 6             // 1.10..1.20
  } else if age <= lf_cap_age {
    q + q / 5  + 3 * q / 10 * ( age - 12 ) / 12       // 1.20..1.50
  } else {
    q + q / 2                                           // 1.50 cap
  }
}

/// Weighted LF across all holdings (locked + free). TV-LF-03.
/// C-SS-5: uses full lamp_balance which includes locked.
pub fn compute_lf_q(holdings: List<LoyaltyHolding>, current_epoch: Int) -> Int {
  let total = list.foldl(holdings, 0, fn(h, acc) { acc + h.amount })
  if total == 0 {
    q  // default: LF = 1.00
  } else {
    let weighted_sum =
      list.foldl(holdings, 0, fn(h, acc) {
        let age = current_epoch - h.acquired_epoch
        acc + h.amount * lf_pwl_q(age)
      })
    weighted_sum / total
  }
}

// ══════════════════════════════════════════════════════════════
// §6.4 OAC — On-chain Activity Coefficient
// ══════════════════════════════════════════════════════════════
//
// OAC = 0.80 + 0.05 × min(active_apps, 4)
//
// active_apps = |{ app_id | ∃ epoch ∈ [current-12, current) :
//                  burn(app_id, epoch) ≥ MIN_BURN_FOR_OAC }|
//
// Boundary: [current-12, current) — burns AT current epoch count for NEXT epoch's OAC.
// TV-OAC-BOUNDARY: burn at epoch 103, current=103 → NOT counted now ✓

/// Count distinct apps with burns in the OAC lookback window.
pub fn count_active_apps(
  activity_state : ActivityState,
  current_epoch  : Int,
) -> Int {
  let window_start = current_epoch - drm_lookback  // current - 12
  // Collect distinct app_ids with burn epoch in [window_start, current)
  // Aiken doesn't have a Set, so we use list with duplicate filtering.
  let active =
    list.filter(activity_state.recent_burn_epochs, fn(entry) {
      let (_, ep) = entry
      ep >= window_start && ep < current_epoch
    })
  // Count distinct app_ids (simple: filter keeps all, count unique)
  count_distinct_apps(active)
}

/// Count distinct app_ids in a list of (app_id, epoch) pairs.
fn count_distinct_apps(entries: List<(ByteArray, Int)>) -> Int {
  list.foldl(entries, [], fn(entry, acc_ids) {
    let (app_id, _) = entry
    if list.has(acc_ids, app_id) { acc_ids }
    else { [app_id, ..acc_ids] }
  })
    |> list.length
}

/// Compute OAC in Q-format.
pub fn compute_oac_q(activity_state: ActivityState, current_epoch: Int) -> Int {
  let n = count_active_apps(activity_state, current_epoch)
  oac_base_q + oac_increment_q * ( if n > oac_cap_apps { oac_cap_apps } else { n } )
}

// ── Prune stale activity_state entries (§15.1 step 7) ────────
// Called AFTER computing OAC in the same epoch (sets are disjoint).
pub fn prune_stale_activity(
  activity_state : ActivityState,
  current_epoch  : Int,
) -> ActivityState {
  let cutoff = current_epoch - drm_lookback
  let fresh =
    list.filter(
      activity_state.recent_burn_epochs,
      fn(entry) {
        let (_, ep) = entry
        ep >= cutoff
      },
    )
  ActivityState { ..activity_state, recent_burn_epochs: fresh }
}
