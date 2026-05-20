// validators/um_datum.ak — UM Datum Validator (§14)
// Normative: C-UM-1..4, §14.1, §14.3
//
// UM datum là UTxO riêng (không phải vault).
// Update là permissionless — bất kỳ ai (keeper) có thể trigger.
// Validator verify toán học SMA, không trust raw value từ keeper.

use aiken/collection/list
use aiken/interval.{Finite, IntervalBoundType}
use cardano/address.{Address}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction}

// ── Constants ────────────────────────────────────────────────
const q : Int = 1_000_000_000
const um_min_q : Int = 500_000_000    // [Constitutional]
const um_max_q : Int = 2_000_000_000  // [Constitutional]
const um_window : Int = 6             // [Significant]

// ── Types ─────────────────────────────────────────────────────
pub type UMDatum {
  smoothed_q         : Int,
  last_updated_epoch : Int,
  history            : List<Int>,   // last ≤ 6 raw values
}

pub type UMRedeemer {
  // Keeper submits new raw UM value (computed off-chain from epoch stats).
  // Validator verifies SMA math is correct — cannot verify raw value itself.
  UMUpdate { new_raw: Int }
}

// ── Validator ─────────────────────────────────────────────────
// `ms_per_epoch` is applied per-network (Plutus validity_range is POSIX ms):
//   Mainnet:        432_000_000
//   Preview/Preprod: 86_400_000
validator um_datum_validator(ms_per_epoch: Int) {
  spend(
    datum_opt : Option<UMDatum>,
    redeemer  : UMRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(datum) = datum_opt
    let current_epoch = get_epoch(tx, ms_per_epoch)
    let own_addr      = get_own_addr(own_ref, tx.inputs)

    when redeemer is {
      UMUpdate { new_raw } -> {
        // ── C-UM-4: Update at epoch boundary ────────────────
        expect current_epoch > datum.last_updated_epoch

        // ── Clamp raw value ──────────────────────────────────
        let clamped_raw = clamp(new_raw, um_min_q, um_max_q)

        // ── C-UM-2: history cap ≤ 6 ─────────────────────────
        let old_history = datum.history
        let new_history = append_capped(old_history, clamped_raw, um_window)

        // ── C-UM-1: SMA computation ──────────────────────────
        let new_smoothed = compute_sma(new_history)

        // ── C-UM-3: Clamp smoothed to [UM_MIN, UM_MAX] ──────
        let new_smoothed_clamped = clamp(new_smoothed, um_min_q, um_max_q)

        // ── A02: Verify output datum ─────────────────────────
        let output_datum = get_output_datum(tx.outputs, own_addr)
        expect output_datum.smoothed_q == new_smoothed_clamped
        expect output_datum.last_updated_epoch == current_epoch
        expect output_datum.history == new_history
        expect list.length(output_datum.history) <= um_window

        True
      }
    }
  }
}

// ── Math helpers ──────────────────────────────────────────────

// SMA = sum(history) / len(history)
fn compute_sma(history: List<Int>) -> Int {
  let len = list.length(history)
  if len == 0 { q }  // neutral fallback (never happens after first update)
  else {
    let total = list.foldl(history, 0, fn(x, acc) { acc + x })
    total / len
  }
}

// Append new value, keep only last `cap` entries
fn append_capped(history: List<Int>, new_val: Int, cap: Int) -> List<Int> {
  let appended = list.concat(history, [new_val])
  let len = list.length(appended)
  if len <= cap { appended }
  else { list.drop(appended, len - cap) }
}

fn clamp(x: Int, lo: Int, hi: Int) -> Int {
  if x < lo { lo } else if x > hi { hi } else { x }
}

fn get_epoch(tx: Transaction, ms_per_epoch: Int) -> Int {
  expect Some(s) = tx.validity_range.lower_bound.bound_type |> get_finite
  s / ms_per_epoch
}

fn get_finite(bt: IntervalBoundType) -> Option<Int> {
  when bt is {
    Finite(s) -> Some(s)
    _ -> None
  }
}

fn get_own_addr(own_ref: OutputReference, inputs: List<Input>) -> Address {
  expect Some(i) = list.find(inputs, fn(x) { x.output_reference == own_ref })
  i.output.address
}

fn get_output_datum(outputs: List<Output>, addr: Address) -> UMDatum {
  expect Some(o) = list.find(outputs, fn(x) { x.address == addr })
  expect InlineDatum(d) = o.datum
  expect datum: UMDatum = d
  datum
}
