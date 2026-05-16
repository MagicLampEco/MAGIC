// lib/snapshot.ak — SnapshotGen core logic (§8)
// Normative: C-SS-1..C-SS-8, T16 (no UM), L3 (full lamp_balance incl. locked)

use aiken/collection/list
use aiken/crypto
use aiken/primitive/bytearray
use cardano/transaction.{OutputReference}
use magiclamp/protocol/constants.{
  q, snapshot_base_rate_q,
  pm_q_ember, pm_q_flame, pm_q_lantern,
  b_q_ember, b_q_flame, b_q_lantern,
  max_batches_per_vault,
}
use magiclamp/protocol/types.{
  MagicBatch, VaultDatum, ActivityProfile,
  Ember, Flame, Lantern, Snapshot,
}
use magiclamp/protocol/lf_oac.{compute_lf_q, compute_oac_q}
use magiclamp/protocol/decay.{snapshot_decay_window, is_snapshot_expired}

// ══════════════════════════════════════════════════════════════
// §8.1 SnapshotGen formula — 5 multiplications, no UM (T16)
// ══════════════════════════════════════════════════════════════
//
// M_snapshot = ⌊ L × R_snap × LF × OAC × PM × B ⌋ / Q⁵
//
// C-SS-5: L = lamp_balance (FULL, including locked) — L3
// T16: UM does NOT appear here (P10: Snapshot is UM-independent)
// L4: ≤ 5 nanogic error; M_actual ≤ M_true
//
// TV-SNAPGEN-01: 1000 LAMP, Flame, LF=1.0, OAC=0.8, PM=1.05, B=1.1 → ≈4.62 MAGIC
//   L = 10^9 oil
//   s1 = 10^9 × 5×10^9 / Q = 5×10^9
//   s2 = 5×10^9 × 1×10^9 / Q = 5×10^9    (LF=1.0)
//   s3 = 5×10^9 × 8×10^8 / Q = 4×10^9    (OAC=0.8)
//   s4 = 4×10^9 × 1.05×10^9 / Q = 4.2×10^9
//   s5 = 4.2×10^9 × 1.1×10^9 / Q = 4_620_000_000 ✓

pub fn get_pm_q(profile: ActivityProfile) -> Int {
  when profile is {
    Ember   -> pm_q_ember
    Flame   -> pm_q_flame
    Lantern -> pm_q_lantern
  }
}

pub fn get_b_q(profile: ActivityProfile) -> Int {
  when profile is {
    Ember   -> b_q_ember
    Flame   -> b_q_flame
    Lantern -> b_q_lantern
  }
}

pub fn compute_snapshot_magic(
  lamp_balance  : Int,    // C-SS-5: full balance (oil), locked included
  lf_q          : Int,    // Q-format Loyalty Factor
  oac_q         : Int,    // Q-format OAC
  profile       : ActivityProfile,
) -> Int {
  let pm_q = get_pm_q(profile)
  let b_q  = get_b_q(profile)
  let s1 = lamp_balance * snapshot_base_rate_q / q   // step 1: × R_snap
  let s2 = s1 * lf_q / q                             // step 2: × LF
  let s3 = s2 * oac_q / q                            // step 3: × OAC
  let s4 = s3 * pm_q / q                             // step 4: × PM
  s4 * b_q / q                                       // step 5: × B
}

// ══════════════════════════════════════════════════════════════
// §8.2 Catch-up (C-SS-6)
// ══════════════════════════════════════════════════════════════
//
// If Δe = current_epoch - last_updated_epoch > 1 (vault not touched for Δe epochs):
//   M_catchup = Δe × M_snapshot(current_state)
//   ONE batch created at current_epoch with initial_amount = M_catchup
//
// Note: uses CURRENT state (LF, OAC at current_epoch) — nearly always user-favorable
// because LF increases with age. Exception: OAC can decrease if user stopped burning.

pub fn compute_catchup_magic(
  vault         : VaultDatum,
  current_epoch : Int,
) -> Int {
  let delta_e = current_epoch - vault.last_updated_epoch
  let lf_q    = compute_lf_q(vault.loyalty_holdings, current_epoch)
  let oac_q   = compute_oac_q(vault.activity_state, current_epoch)
  let m_one   = compute_snapshot_magic(
    vault.lamp_balance,  // C-SS-5: full balance
    lf_q, oac_q, vault.profile,
  )
  delta_e * m_one  // C-SS-6: current state for all missed epochs
}

// ══════════════════════════════════════════════════════════════
// C-SS-7/8: batch slot check
// ══════════════════════════════════════════════════════════════
//
// C-SS-7: |batches| + 1 ≤ 32 (must have room)
// C-SS-8: If |batches| ≥ 32 → SKIP; last_updated_epoch still updates;
//          generation is LOST PERMANENTLY (no backfill).

pub fn can_add_batch(batches: List<MagicBatch>) -> Bool {
  list.length(batches) < max_batches_per_vault
}

// ══════════════════════════════════════════════════════════════
// Create new Snapshot batch (C-SS-3, C-SS-4, C-DECAY-4)
// ══════════════════════════════════════════════════════════════

pub fn create_snapshot_batch(
  own_ref        : OutputReference,
  next_index     : Int,
  profile        : ActivityProfile,
  magic_amount   : Int,
  current_epoch  : Int,
) -> MagicBatch {
  let batch_id = compute_batch_id(own_ref, next_index)
  MagicBatch {
    batch_id,
    source:              Snapshot,
    created_epoch:       current_epoch,
    initial_amount:      magic_amount,
    current_amount:      magic_amount,
    decay_window:        snapshot_decay_window(profile),  // C-SS-3: N(P)
    profile_at_creation: Some(profile),                   // C-SS-4, C-DECAY-4
    contract_id:         None,
    halved:              False,                           // C-DECAY-6
  }
}

fn compute_batch_id(
  own_ref : OutputReference,
  index   : Int,
) -> ByteArray {
  let OutputReference { transaction_id, output_index } = own_ref
  let ref_bytes = bytearray.concat(transaction_id, encode_int(output_index))
  let idx_bytes = encode_int(index)
  crypto.blake2b_256(bytearray.concat(ref_bytes, idx_bytes))
}

fn encode_int(n: Int) -> ByteArray {
  bytearray.from_int_big_endian(n, 8)
}

// ══════════════════════════════════════════════════════════════
// Prune expired Snapshot batches (C-PRUNE-1)
// ══════════════════════════════════════════════════════════════
// Note: Snapshot batches have no halving (C-DECAY-6).
// Prune only — no halving step needed for Snapshot.

pub fn prune_expired_batches(
  batches       : List<MagicBatch>,
  current_epoch : Int,
) -> List<MagicBatch> {
  list.filter(batches, fn(b) { !is_snapshot_expired(b, current_epoch) })
}
