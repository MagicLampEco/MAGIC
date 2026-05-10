// lib/math.ak — Q-format arithmetic (spec §6.1)
// All operations use integer floor division (Aiken `/` = floor div) ✓
// L4: chain of n multiplications → ≤ n nanogic error; M_actual ≤ M_true

use magiclamp/instantgen/lib/constants.{q}

// ── §6.1 Core Q operations ───────────────────────────────────

/// apply_multiplier: multiply x by a Q-format multiplier
/// Error: ≤ 1 nanogic per call (L4)
pub fn apply_multiplier(x: Int, m_q: Int) -> Int {
  x * m_q / q
}

/// multiply_q: multiply two Q-format values
/// Result is also Q-format.
pub fn multiply_q(a_q: Int, b_q: Int) -> Int {
  a_q * b_q / q
}

// ── Epoch helpers ────────────────────────────────────────────

/// Convert slot number to epoch (Cardano: 1 epoch = 432,000 slots)
pub fn slot_to_epoch(slot: Int) -> Int {
  slot / 432_000
}

/// Compute batch age k = current_epoch - created_epoch
/// Fails if current_epoch < created_epoch (C-DECAY-2)
pub fn batch_age(created_epoch: Int, current_epoch: Int) -> Int {
  let k = current_epoch - created_epoch
  expect k >= 0
  k
}

// ── Clamp ────────────────────────────────────────────────────

/// Clamp value to [lo, hi] inclusive
pub fn clamp(x: Int, lo: Int, hi: Int) -> Int {
  if x < lo { lo }
  else if x > hi { hi }
  else { x }
}

// ── Instant generation formula (§9.1) ────────────────────────
//
// M_instant = ⌊ L_paid × R_inst × UM_checked × PM ⌋ / Q³
//
// Applied as 3 sequential floor multiplications (M_instant chain, §6.10):
//   step1 = ⌊ L_paid × R_inst / Q ⌋
//   step2 = ⌊ step1 × UM_q / Q ⌋
//   step3 = ⌊ step2 × PM_q / Q ⌋
// Error: ≤ 3 nanogic total (L4)

pub fn compute_instant_magic(
  lamp_paid : Int,  // in oil
  um_q      : Int,  // Q-format UM (after stale check)
  pm_q      : Int,  // Q-format Profile Multiplier
) -> Int {
  use magiclamp/instantgen/lib/constants.{instant_base_rate_q}
  let s = lamp_paid * instant_base_rate_q / q   // step 1
  let s2 = s * um_q / q                          // step 2
  s2 * pm_q / q                                  // step 3
}

// ── blake2b_256 batch ID (§4.1) ──────────────────────────────
// batch_id = blake2b256(vault_utxo_ref ∥ encode(next_batch_index))
// Implementation note: call this from the validator where builtin is available.
