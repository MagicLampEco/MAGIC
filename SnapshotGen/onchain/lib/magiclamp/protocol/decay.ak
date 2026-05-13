// lib/decay.ak — Snapshot batch decay + scale-back burn (§4.2, §6.2, §6.6)
// Normative: TV-SS-01..04, C-DECAY-1..5, T17

use magiclamp/protocol/types.{MagicBatch, ActivityProfile, Ember, Flame, Lantern}
use magiclamp/protocol/constants.{
  r_ember, r_flame, r_lantern,
  n_ember, n_flame, n_lantern,
}

// ══════════════════════════════════════════════════════════════
// §4.2 / §6.2 Snapshot batch balance
// ══════════════════════════════════════════════════════════════
//
// balance(k) = ⌊ m₀ × (10-r)ᵏ / 10ᵏ ⌋    k < N(P)
// balance(k) = 0                             k ≥ N(P)
//
// L1: error ≤ N(P) nanogic over N steps (floor accumulation)
// L2: balance(k+1) ≤ balance(k) (monotone)

/// Get decay rate r for a profile.
pub fn get_r(profile: ActivityProfile) -> Int {
  when profile is {
    Ember   -> r_ember
    Flame   -> r_flame
    Lantern -> r_lantern
  }
}

/// Get lifetime N for a profile.
pub fn get_n(profile: ActivityProfile) -> Int {
  when profile is {
    Ember   -> n_ember
    Flame   -> n_flame
    Lantern -> n_lantern
  }
}

/// Get decay_window (= N) for a Snapshot batch at creation.
pub fn snapshot_decay_window(profile: ActivityProfile) -> Int {
  get_n(profile)
}

/// Compute Snapshot batch balance at age k.
/// TV-SS-01: Lantern k=0..9  TV-SS-02: Flame  TV-SS-03: Ember
pub fn snapshot_balance(m0: Int, profile: ActivityProfile, k: Int) -> Int {
  let r = get_r(profile)
  let n = get_n(profile)
  if k < 0 {
    fail @"C-DECAY-2: negative batch age"
  } else if k >= n {
    0  // hard cutoff (T2)
  } else if k == 0 {
    m0
  } else {
    // ⌊ m0 × (10-r)^k / 10^k ⌋
    pow_ratio(m0, 10 - r, 10, k)
  }
}

/// Compute ⌊ x × num^k / den^k ⌋ using integer arithmetic.
/// Aiken's Int is arbitrary precision — no overflow.
fn pow_ratio(x: Int, num: Int, den: Int, k: Int) -> Int {
  let num_k = int_pow(num, k)
  let den_k = int_pow(den, k)
  x * num_k / den_k
}

/// Integer power x^n (n ≥ 0).
fn int_pow(x: Int, n: Int) -> Int {
  if n == 0 { 1 }
  else { x * int_pow(x, n - 1) }
}

// ══════════════════════════════════════════════════════════════
// §6.6 Scale-back burn for Snapshot batches
// ══════════════════════════════════════════════════════════════
//
// When burning `b` nanogic from a Snapshot batch at age k:
//   initial_scale_burn = ⌊ b × 10ᵏ / (10-r)ᵏ ⌋
//   new_initial        = m₀ - initial_scale_burn
//
// Post-condition (T17): new_balance = ⌊ new_initial × (10-r)ᵏ / 10ᵏ ⌋
//   |new_balance − (current − b)| ≤ 1 nanogic; new_balance ≥ current − b (user-favorable)
//
// TV-SS-04: Lantern k=3, m₀=10⁹, burn=200M → new_initial=725_651_578; diff=0 ✓

pub type BurnResult {
  new_initial_amount : Int,
  new_balance        : Int,   // for verification
}

pub fn burn_snapshot(
  batch  : MagicBatch,
  burn_b : Int,
  k      : Int,
) -> BurnResult {
  expect Some(profile) = batch.profile_at_creation

  let r       = get_r(profile)
  let current = snapshot_balance(batch.initial_amount, profile, k)

  expect burn_b <= current   // cannot burn more than current balance
  expect burn_b > 0

  let isb         = pow_ratio(burn_b, 10, 10 - r, k)  // ⌊ b × 10^k / (10-r)^k ⌋
  let new_initial = batch.initial_amount - isb
  let new_balance = snapshot_balance(new_initial, profile, k)

  // T17: new_balance ≥ current - b (user-favorable)
  expect new_balance >= current - burn_b

  BurnResult { new_initial_amount: new_initial, new_balance }
}

// ══════════════════════════════════════════════════════════════
// Prune expired Snapshot batches (C-PRUNE-1)
// ══════════════════════════════════════════════════════════════

pub fn is_snapshot_expired(batch: MagicBatch, current_epoch: Int) -> Bool {
  let k = current_epoch - batch.created_epoch
  k >= batch.decay_window
}
