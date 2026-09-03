// lib/decay.ak — MAGIC batch lifetime (§4.2 per-epoch use-or-lose CLIFF)
//
// The multi-epoch decay / halving machinery is GONE. A batch has exactly one
// live epoch — its own `created_epoch`:
//
//   k = current_epoch − created_epoch
//   k = 0            → LIVE   (full current_amount, burnable)
//   k ≥ decay_window → DEAD   (value 0, NOT burnable, garbage-collectable)
//
// with `decay_window = 1` for every source (constants.magic_decay_window).
// The generic `k ≥ decay_window` form is kept so the helpers stay usable if a
// future source ever gets a different window; today every batch is a 1-epoch
// cliff, and there is no halving step at any k.

use aiken/collection/list
use magiclamp/protocol/types.{MagicBatch}

// ── Liveness ─────────────────────────────────────────────────

/// Is this batch DEAD at current_epoch? (k ≥ decay_window)
/// A dead batch contributes 0 and may not be burned.
pub fn is_expired(batch: MagicBatch, current_epoch: Int) -> Bool {
  current_epoch - batch.created_epoch >= batch.decay_window
}

/// Is this batch LIVE at current_epoch? (exactly its own created_epoch)
pub fn is_live(batch: MagicBatch, current_epoch: Int) -> Bool {
  !is_expired(batch, current_epoch)
}

// ── Garbage collection (§7.4 PruneExpired) ───────────────────

/// Drop every DEAD batch. Removes bytes only — a dead batch already counts as
/// zero, so pruning never changes any live value.
pub fn prune_expired(
  batches       : List<MagicBatch>,
  current_epoch : Int,
) -> List<MagicBatch> {
  list.filter(batches, fn(b) { !is_expired(b, current_epoch) })
}

/// Number of DEAD batches in the list (used to reject a no-op prune).
pub fn count_expired(batches: List<MagicBatch>, current_epoch: Int) -> Int {
  list.count(batches, fn(b) { is_expired(b, current_epoch) })
}

// ── Balance ──────────────────────────────────────────────────

/// Live balance of a batch at current_epoch. 0 once the cliff has passed.
pub fn batch_balance(batch: MagicBatch, current_epoch: Int) -> Int {
  let k = current_epoch - batch.created_epoch
  if k < 0 {
    fail @"negative batch age (C-DECAY-2)"
  } else if k >= batch.decay_window {
    0
  } else {
    batch.current_amount
  }
}

/// Total live MAGIC across a batch list (S-side accounting, off-chain mirror).
pub fn live_total(batches: List<MagicBatch>, current_epoch: Int) -> Int {
  list.foldl(batches, 0, fn(b, acc) { acc + batch_balance(b, current_epoch) })
}

// ── `halved` is a dead field under the cliff model ────────────
//
// `MagicBatch.halved` is kept only so the Plutus Data shape stays compatible.
// No code path may ever set it: a batch is created with halved=False and never
// mutated. Validators call this on every batch they emit.
pub fn halved_must_be_false(batch: MagicBatch) -> Bool {
  !batch.halved
}
