// validators/vault.ak — Vault spending validator (SnapshotGen focus)
// Normative: §8 SnapshotGen, §4.2 Snapshot decay, §5.8 Vault constraints
// PlutusV3 / Aiken ≥ 1.1.x
//
// Key differences from InstantGen:
//  - No LAMP transfer (no Treasury output needed)
//  - No UM reference input (T16: Snapshot is UM-independent)
//  - Uses FULL lamp_balance including locked (C-SS-5, L3)
//  - 5-multiplier formula: L × R_snap × LF × OAC × PM × B
//  - Catch-up: Δe epochs → one batch at current_epoch

use aiken/collection/list
use aiken/crypto
use aiken/primitive/bytearray
use cardano/address.{Address}
use cardano/assets.{PolicyId}
use cardano/transaction.{
  Input, Output, OutputReference, ScriptContext, Transaction,
}

use magiclamp/snapshotgen/lib/types.{
  ActivityProfile, Snapshot, VaultDatum, VaultRedeemer, MagicBatch,
}
use magiclamp/snapshotgen/lib/constants.{
  max_batches_per_vault, max_loyalty_holdings, q,
}
use magiclamp/snapshotgen/lib/lf_oac.{
  compute_lf_q, compute_oac_q, prune_stale_activity,
}
use magiclamp/snapshotgen/lib/snapshot.{
  compute_snapshot_magic, compute_catchup_magic,
  can_add_batch, create_snapshot_batch,
  prune_expired_batches,
}
use magiclamp/snapshotgen/lib/decay.{is_snapshot_expired}

// ── Parameterized validator ───────────────────────────────────
validator vault {
  spend(
    datum_opt : Option<VaultDatum>,
    redeemer  : VaultRedeemer,
    own_ref   : OutputReference,
    ctx       : ScriptContext,
  ) {
    expect Some(input_datum) = datum_opt
    let tx = ctx.transaction

    // Current epoch from tx validity range lower bound
    let current_epoch = get_current_epoch(tx)

    when redeemer is {

      // ── TriggerSnapshot ─────────────────────────────────────
      TriggerSnapshot ->
        validate_snapshot(input_datum, current_epoch, own_ref, tx)

      // ── BurnBatch (stub) ────────────────────────────────────
      BurnBatch { .. } -> {
        expect list.has(tx.extra_signatories, input_datum.owner)
        True
      }

      // ── UpdateProfile (stub) ─────────────────────────────────
      UpdateProfile { .. } -> {
        expect list.has(tx.extra_signatories, input_datum.owner)
        True
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// validate_snapshot — all C-SS-* constraints
// ═══════════════════════════════════════════════════════════════
fn validate_snapshot(
  input_datum   : VaultDatum,
  current_epoch : Int,
  own_ref       : OutputReference,
  tx            : Transaction,
) -> Bool {

  // ── C-SS-1: Must be at a new epoch ─────────────────────────
  expect current_epoch > input_datum.last_updated_epoch

  // ── Owner must sign ─────────────────────────────────────────
  // (SnapshotGen is owner-triggered; keeper-triggered variant is out of scope for v1)
  expect list.has(tx.extra_signatories, input_datum.owner)

  // ── C-VAULT-DS-1: exactly one vault input ───────────────────
  let vault_addr = find_own_address(own_ref, tx.inputs)
  let vault_input_count =
    list.count(tx.inputs, fn(i) { i.output.address == vault_addr })
  expect vault_input_count == 1

  // ── C-SS-5: Use FULL lamp_balance (including locked) — L3 ───
  let lamp_balance = input_datum.lamp_balance   // NOT L_avail

  // ── Compute LF and OAC ─────────────────────────────────────
  let lf_q  = compute_lf_q(input_datum.loyalty_holdings, current_epoch)
  let oac_q = compute_oac_q(input_datum.activity_state, current_epoch)

  // ── C-SS-2: Compute M_snapshot ─────────────────────────────
  // With catch-up: Δe × M_snapshot(current_state)
  let delta_e = current_epoch - input_datum.last_updated_epoch
  let m_one   = compute_snapshot_magic(lamp_balance, lf_q, oac_q, input_datum.profile)
  let m_total = delta_e * m_one   // C-SS-6

  // ── Prune expired batches (C-PRUNE-1) ───────────────────────
  // Snapshot has no halving — prune directly.
  let pruned_batches = prune_expired_batches(input_datum.magic_batches, current_epoch)

  // ── C-SS-7/8: Batch slot check ──────────────────────────────
  let (expected_batches, batch_added) =
    if can_add_batch(pruned_batches) && m_total > 0 {
      // C-SS-3: source=Snapshot, decay_window=N(profile)
      // C-SS-4: profile_at_creation = vault.profile
      let new_batch = create_snapshot_batch(
        own_ref, input_datum.next_batch_index,
        input_datum.profile, m_total, current_epoch,
      )
      (list.concat(pruned_batches, [new_batch]), True)
    } else {
      // C-SS-8: SKIP — vault full OR M=0; generation lost permanently
      (pruned_batches, False)
    }

  // ── A02: Field-by-field output datum validation ─────────────
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  // Unchanged fields (no LAMP movement in SnapshotGen)
  expect output_datum.owner == input_datum.owner
  expect output_datum.lamp_balance == input_datum.lamp_balance
  expect output_datum.lamp_locked == input_datum.lamp_locked
  expect output_datum.loyalty_holdings == input_datum.loyalty_holdings
  expect output_datum.vacuum_orders == input_datum.vacuum_orders
  expect output_datum.gen_schedules == input_datum.gen_schedules
  expect output_datum.profile == input_datum.profile
  expect output_datum.profile_changed_epoch == input_datum.profile_changed_epoch
  expect output_datum.pending_profile == input_datum.pending_profile
  expect output_datum.delegation_cert == input_datum.delegation_cert
  expect output_datum.streak_state == input_datum.streak_state
  expect output_datum.personal_delegate == input_datum.personal_delegate

  // Changed: magic_batches
  expect output_datum.magic_batches == expected_batches

  // C-VAULT-1: batch count limit
  expect list.length(output_datum.magic_batches) <= max_batches_per_vault

  // Changed: next_batch_index increments only if batch was added
  if batch_added {
    expect output_datum.next_batch_index == input_datum.next_batch_index + 1
  } else {
    expect output_datum.next_batch_index == input_datum.next_batch_index
  }

  // Changed: last_updated_epoch = current (C-SS-8: update even on SKIP)
  expect output_datum.last_updated_epoch == current_epoch

  // Changed: activity_state pruned (§15.1 step 7)
  // Pruning AFTER OAC is computed — sets are disjoint (TV-ACTIVITY-PRUNE)
  let expected_activity = prune_stale_activity(input_datum.activity_state, current_epoch)
  expect output_datum.activity_state == expected_activity

  // Attribution (C-ATT-2: total_events increments if batch added)
  if batch_added {
    expect output_datum.attribution.total_events == input_datum.attribution.total_events + 1
    expect output_datum.attribution.last_event_epoch == current_epoch
  } else {
    // C-SS-8: skip — no event logged for skipped generation
    expect output_datum.attribution == input_datum.attribution
  }

  True
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

fn get_current_epoch(tx: Transaction) -> Int {
  expect Some(lower_slot) =
    tx.validity_range.lower_bound.bound_type
    |> get_finite_slot
  lower_slot / 432_000
}

fn get_finite_slot(
  bound_type: cardano/interval.IntervalBoundType<Int>,
) -> Option<Int> {
  when bound_type is {
    cardano/interval.Finite(s) -> Some(s)
    _ -> None
  }
}

fn find_own_address(own_ref: OutputReference, inputs: List<Input>) -> Address {
  expect Some(own_input) = list.find(inputs, fn(i) { i.output_reference == own_ref })
  own_input.output.address
}

fn find_vault_output_datum(outputs: List<Output>, vault_addr: Address) -> VaultDatum {
  expect Some(vault_output) = list.find(outputs, fn(o) { o.address == vault_addr })
  expect cardano/transaction.InlineDatum(datum_data) = vault_output.datum
  expect datum: VaultDatum = datum_data
  datum
}
