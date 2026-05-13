// lib/decay.ak — Batch decay, halving, and pruning
// Normative: §4 (C-DECAY-*), §4.3 (Instant halving), C-PRUNE-1/2

use aiken/collection/list
use magiclamp/protocol/types.{MagicBatch, BatchSource, Instant}

// ── §4.3 Instant batch: lazy halving ─────────────────────────
//
// C-DECAY-7: Instant ∧ k=1 ∧ halved=False → current=⌊current/2⌋; halved=True
// C-DECAY-8: In any tx that is NOT a halving operation,
//             output.batch.halved MUST equal input.batch.halved (T22)

/// Should this batch be halved in the current epoch?
/// True only for Instant batches at age k=1 that have not yet been halved.
pub fn should_halve(batch: MagicBatch, current_epoch: Int) -> Bool {
  let k = current_epoch - batch.created_epoch
  batch.source == Instant && k == 1 && !batch.halved
}

/// Apply halving to a batch (C-DECAY-7).
/// MUST only be called when should_halve returns True.
pub fn apply_halving(batch: MagicBatch) -> MagicBatch {
  MagicBatch {
    ..batch,
    current_amount: batch.current_amount / 2,   // floor division ✓
    halved: True,
  }
}

/// Apply lazy halving across all batches in a vault (C-PRUNE-2 ordering: halve BEFORE prune).
pub fn apply_halving_all(
  batches       : List<MagicBatch>,
  current_epoch : Int,
) -> List<MagicBatch> {
  list.map(batches, fn(b) {
    if should_halve(b, current_epoch) { apply_halving(b) }
    else { b }
  })
}

// ── §4 Prune expired batches ─────────────────────────────────
//
// C-PRUNE-1: magic_batches output must NOT contain expired batches.
// C-PRUNE-2: Halving BEFORE prune in the same tx (P12).
// A batch is expired when k ≥ decay_window.

/// Is this batch expired at current_epoch?
pub fn is_expired(batch: MagicBatch, current_epoch: Int) -> Bool {
  current_epoch - batch.created_epoch >= batch.decay_window
}

/// Remove all expired batches from the list.
/// MUST be called AFTER apply_halving_all in the same tx (C-PRUNE-2).
pub fn prune_expired(
  batches       : List<MagicBatch>,
  current_epoch : Int,
) -> List<MagicBatch> {
  list.filter(batches, fn(b) { !is_expired(b, current_epoch) })
}

/// Combined: apply halving then prune. Use this in every tx that touches the vault.
/// Returns the cleaned batch list.
pub fn halve_then_prune(
  batches       : List<MagicBatch>,
  current_epoch : Int,
) -> List<MagicBatch> {
  batches
    |> apply_halving_all(current_epoch)  // C-PRUNE-2: halving first
    |> prune_expired(current_epoch)
}

// ── §4.3 balance of an Instant batch ─────────────────────────
//
// k=0 → current_amount (before any halving in current tx)
// k=1 → current_amount (halved already applied lazily)
// k≥2 → 0

/// Compute the current balance of any batch at current_epoch.
/// For non-Snapshot sources, balance = current_amount if not expired.
/// For Snapshot, balance requires the initial_amount + formula (handled separately).
pub fn instant_batch_balance(batch: MagicBatch, current_epoch: Int) -> Int {
  let k = current_epoch - batch.created_epoch
  if k < 0 { fail @"negative batch age (C-DECAY-2)" }
  else if k >= batch.decay_window { 0 }
  else { batch.current_amount }
}

// ── C-DECAY-6: halved=False at creation for non-Instant ─────
pub fn validate_halved_at_creation(batch: MagicBatch) -> Bool {
  when batch.source is {
    Instant -> True               // halved=False checked in C-INST-6
    _       -> !batch.halved      // C-DECAY-6: must be False
  }
}

// ── C-DECAY-8: halved immutable in non-halving txs ───────────
//
// For any pair (input_batch, output_batch) where the tx is NOT
// a halving operation for that batch, halved must be unchanged.
// This prevents the TV-HALVED-INJECT attack.

/// Verify halved field unchanged between input and output batch.
/// Call this for every batch that is NOT being halved in this tx.
pub fn halved_unchanged(input_batch: MagicBatch, output_batch: MagicBatch) -> Bool {
  input_batch.halved == output_batch.halved
}
