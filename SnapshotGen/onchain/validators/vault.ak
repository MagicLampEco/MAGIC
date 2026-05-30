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
use aiken/interval.{Finite, IntervalBoundType}
use aiken/primitive/bytearray
use cardano/address.{Address}
use cardano/assets.{PolicyId}
use cardano/script_context.{ScriptContext}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}

use magiclamp/protocol/types.{
  ActivityProfile, BurnBatch, MagicBatch, PendingProfile, Snapshot,
  TriggerSnapshot, UpdateProfile, VaultDatum, VaultRedeemer, WithdrawLamp,
}
use magiclamp/protocol/constants.{
  max_batches_per_vault, max_loyalty_holdings, profile_change_cooldown, q,
}
use magiclamp/protocol/lf_oac.{
  compute_lf_q, compute_oac_q, prune_stale_activity,
}
use magiclamp/protocol/snapshot.{
  compute_snapshot_magic, compute_catchup_magic,
  can_add_batch, create_snapshot_batch,
  prune_expired_batches,
}
use magiclamp/protocol/decay.{is_snapshot_expired}
use magiclamp/protocol/lock.{remove_newest_first, sum_holdings}
use magiclamp/protocol/profile.{apply_pending_profile}

// ── Parameterized validator ───────────────────────────────────
// Parameter `ms_per_epoch` is applied at deploy time per-network:
//   Mainnet:        432_000_000  (slot_length 1s × 432_000 slots)
//   Preview/Preprod: 86_400_000  (slot_length 1s ×  86_400 slots)
// See ProtocolUtils MS_PER_EPOCH_BY_NETWORK for the offchain mirror.
// Plutus validity_range is in POSIX milliseconds since 1970-01-01 — see
// aiken-lang/stdlib transaction.ak comment on ValidityRange.
// Epoch numbering becomes POSIX-derived (not Cardano-genesis-relative); both
// validator and SDK use the same formula `posix_ms / ms_per_epoch` so deltas
// and ordering are consistent.
validator vault(lamp_policy_id: PolicyId, ms_per_epoch: Int) {
  spend(
    datum_opt : Option<VaultDatum>,
    redeemer  : VaultRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(input_datum) = datum_opt

    // Current epoch from tx validity range lower bound (POSIX ms)
    let current_epoch = get_current_epoch(tx, ms_per_epoch)

    when redeemer is {

      // ── TriggerSnapshot ─────────────────────────────────────
      TriggerSnapshot ->
        validate_snapshot(input_datum, current_epoch, own_ref, tx)

      // ── BurnBatch (stub) ────────────────────────────────────
      BurnBatch { .. } -> {
        // TODO v1.1: call apply_pending_profile(input_datum, current_epoch)
        //           and use applied_input for M computation + A02 datum check.
        //           Pattern: SPEC_V1 §2 handler usage.
        expect list.has(tx.extra_signatories, input_datum.owner)
        True
      }

      // ── UpdateProfile (full impl — SPEC_V1 §2) ───────────────
      UpdateProfile { new_profile } ->
        validate_update_profile(
          input_datum, new_profile, current_epoch, own_ref, tx,
        )

      // ── WithdrawLamp (SPEC_V1 §1) ────────────────────────────
      WithdrawLamp { amount } ->
        validate_withdraw_lamp(
          input_datum, amount, current_epoch, own_ref, lamp_policy_id, tx,
        )
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

  // ── Lazy profile apply (SPEC_V1 §2) ─────────────────────────
  // If pending_profile has reached effective_epoch, switch profile field
  // and clear pending. applied_input is used for BOTH M-compute and the
  // A02 output datum check below (otherwise pending would never clear).
  let applied_input = apply_pending_profile(input_datum, current_epoch)

  // ── C-SS-5: Use FULL lamp_balance (including locked) — L3 ───
  let lamp_balance = applied_input.lamp_balance   // NOT L_avail

  // ── Compute LF and OAC ─────────────────────────────────────
  let lf_q  = compute_lf_q(applied_input.loyalty_holdings, current_epoch)
  let oac_q = compute_oac_q(applied_input.activity_state, current_epoch)

  // ── C-SS-2: Compute M_snapshot ─────────────────────────────
  // With catch-up: Δe × M_snapshot(current_state)
  // Use applied_input.profile so the new profile (if pending fired this tx)
  // takes effect immediately for the catch-up window.
  let delta_e = current_epoch - applied_input.last_updated_epoch
  let m_one   = compute_snapshot_magic(lamp_balance, lf_q, oac_q, applied_input.profile)
  let m_total = delta_e * m_one   // C-SS-6

  // ── Prune expired batches (C-PRUNE-1) ───────────────────────
  // Snapshot has no halving — prune directly.
  let pruned_batches = prune_expired_batches(applied_input.magic_batches, current_epoch)

  // ── C-SS-7/8: Batch slot check ──────────────────────────────
  let (expected_batches, batch_added) =
    if can_add_batch(pruned_batches) && m_total > 0 {
      // C-SS-3: source=Snapshot, decay_window=N(profile)
      // C-SS-4 + T4: profile_at_creation = applied_input.profile
      // (frozen at batch creation; subsequent UpdateProfile cannot mutate)
      let new_batch = create_snapshot_batch(
        own_ref, applied_input.next_batch_index,
        applied_input.profile, m_total, current_epoch,
      )
      (list.concat(pruned_batches, [new_batch]), True)
    } else {
      // C-SS-8: SKIP — vault full OR M=0; generation lost permanently
      (pruned_batches, False)
    }

  // ── A02: Field-by-field output datum validation ─────────────
  // Compare against applied_input so that pending_profile clears on the
  // output if it fired (avoids infinite pending bug).
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  // Unchanged fields (no LAMP movement in SnapshotGen)
  expect output_datum.owner == applied_input.owner
  expect output_datum.lamp_balance == applied_input.lamp_balance
  expect output_datum.lamp_locked == applied_input.lamp_locked
  expect output_datum.loyalty_holdings == applied_input.loyalty_holdings
  expect output_datum.vacuum_orders == applied_input.vacuum_orders
  expect output_datum.gen_schedules == applied_input.gen_schedules
  expect output_datum.profile == applied_input.profile
  expect output_datum.profile_changed_epoch == applied_input.profile_changed_epoch
  expect output_datum.pending_profile == applied_input.pending_profile
  expect output_datum.delegation_cert == applied_input.delegation_cert
  expect output_datum.streak_state == applied_input.streak_state
  expect output_datum.personal_delegate == applied_input.personal_delegate

  // Changed: magic_batches
  expect output_datum.magic_batches == expected_batches

  // C-VAULT-1: batch count limit
  expect list.length(output_datum.magic_batches) <= max_batches_per_vault

  // Changed: next_batch_index increments only if batch was added
  if batch_added {
    expect output_datum.next_batch_index == applied_input.next_batch_index + 1
  } else {
    expect output_datum.next_batch_index == applied_input.next_batch_index
  }

  // Changed: last_updated_epoch = current (C-SS-8: update even on SKIP)
  expect output_datum.last_updated_epoch == current_epoch

  // Changed: activity_state pruned (§15.1 step 7)
  // Pruning AFTER OAC is computed — sets are disjoint (TV-ACTIVITY-PRUNE)
  let expected_activity = prune_stale_activity(applied_input.activity_state, current_epoch)
  expect output_datum.activity_state == expected_activity

  // Attribution (C-ATT-2: total_events increments if batch added)
  if batch_added {
    expect output_datum.attribution.total_events == applied_input.attribution.total_events + 1
    expect output_datum.attribution.last_event_epoch == current_epoch
  } else {
    // C-SS-8: skip — no event logged for skipped generation
    expect output_datum.attribution == applied_input.attribution
  }

  True
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

// Plutus validity_range carries POSIX MILLISECONDS, not slots. Both validator
// and SDK divide by `ms_per_epoch` to obtain a monotonic epoch counter.
fn get_current_epoch(tx: Transaction, ms_per_epoch: Int) -> Int {
  expect Some(lower_ms) =
    tx.validity_range.lower_bound.bound_type
    |> get_finite_slot
  lower_ms / ms_per_epoch
}

fn get_finite_slot(
  bound_type: IntervalBoundType,
) -> Option<Int> {
  when bound_type is {
    Finite(s) -> Some(s)
    _ -> None
  }
}

fn find_own_address(own_ref: OutputReference, inputs: List<Input>) -> Address {
  expect Some(own_input) = list.find(inputs, fn(i) { i.output_reference == own_ref })
  own_input.output.address
}

fn find_vault_output(outputs: List<Output>, vault_addr: Address) -> Output {
  expect Some(vault_output) = list.find(outputs, fn(o) { o.address == vault_addr })
  vault_output
}

fn find_vault_output_datum(outputs: List<Output>, vault_addr: Address) -> VaultDatum {
  let vault_output = find_vault_output(outputs, vault_addr)
  expect InlineDatum(datum_data) = vault_output.datum
  expect datum: VaultDatum = datum_data
  datum
}

// ═══════════════════════════════════════════════════════════════
// validate_withdraw_lamp — W-1..W-7 (SPEC_V1 §1)
// ═══════════════════════════════════════════════════════════════
fn validate_withdraw_lamp(
  input_datum    : VaultDatum,
  amount         : Int,
  current_epoch  : Int,
  own_ref        : OutputReference,
  lamp_policy_id : PolicyId,
  tx             : Transaction,
) -> Bool {

  // W-1: amount > 0
  expect amount > 0

  // W-2: owner signs
  expect list.has(tx.extra_signatories, input_datum.owner)

  // W-3: amount ≤ L_avail (only unlocked is withdrawable)
  let avail = input_datum.lamp_balance - input_datum.lamp_locked
  expect amount <= avail

  // W-4: exactly 1 vault input (C-VAULT-DS-1)
  let vault_addr = find_own_address(own_ref, tx.inputs)
  let vault_input_count =
    list.count(tx.inputs, fn(i) { i.output.address == vault_addr })
  expect vault_input_count == 1

  // W-5: A02 field-by-field output datum check
  let output_datum   = find_vault_output_datum(tx.outputs, vault_addr)
  let new_holdings   = remove_newest_first(input_datum.loyalty_holdings, amount)
  let new_lamp_balance = input_datum.lamp_balance - amount

  expect output_datum.owner == input_datum.owner
  expect output_datum.lamp_balance == new_lamp_balance
  expect output_datum.lamp_locked == input_datum.lamp_locked
  expect output_datum.loyalty_holdings == new_holdings
  expect output_datum.magic_batches == input_datum.magic_batches
  expect output_datum.next_batch_index == input_datum.next_batch_index
  expect output_datum.vacuum_orders == input_datum.vacuum_orders
  expect output_datum.gen_schedules == input_datum.gen_schedules
  expect output_datum.profile == input_datum.profile
  expect output_datum.profile_changed_epoch == input_datum.profile_changed_epoch
  expect output_datum.pending_profile == input_datum.pending_profile
  expect output_datum.delegation_cert == input_datum.delegation_cert
  expect output_datum.activity_state == input_datum.activity_state
  expect output_datum.streak_state == input_datum.streak_state
  expect output_datum.personal_delegate == input_datum.personal_delegate
  expect output_datum.attribution == input_datum.attribution
  // last_updated_epoch advances (Q2: no event log into datum)
  expect output_datum.last_updated_epoch == current_epoch

  // W-6: vault output value carries the new lamp_balance worth of LAMP
  let vault_output = find_vault_output(tx.outputs, vault_addr)
  let vault_lamp_qty =
    assets.quantity_of(vault_output.value, lamp_policy_id, #"4c414d50")  // "LAMP"
  expect vault_lamp_qty == new_lamp_balance

  // W-7: Σholdings == lamp_balance
  expect sum_holdings(output_datum.loyalty_holdings) == output_datum.lamp_balance

  // C-VAULT-13: |holdings| ≤ 64 (defensive — shouldn't grow on withdraw)
  expect list.length(output_datum.loyalty_holdings) <= max_loyalty_holdings

  True
}

// ═══════════════════════════════════════════════════════════════
// validate_update_profile — C-PC-V1..V6 (SPEC_V1 §2)
// ═══════════════════════════════════════════════════════════════
fn validate_update_profile(
  input_datum   : VaultDatum,
  new_profile   : ActivityProfile,
  current_epoch : Int,
  own_ref       : OutputReference,
  tx            : Transaction,
) -> Bool {

  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

  // C-PC-V1: owner signs
  expect list.has(tx.extra_signatories, input_datum.owner)

  // C-PC-V2: cooldown ≥ 2 epochs (counted from previous profile_changed_epoch)
  expect current_epoch - input_datum.profile_changed_epoch >= profile_change_cooldown

  // C-PC-V3: must actually change profile
  expect new_profile != input_datum.profile

  // C-PC-V4..V6: lazy apply — profile stays, pending set
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  // Balances + holdings + batches UNCHANGED
  expect output_datum.owner == input_datum.owner
  expect output_datum.lamp_balance == input_datum.lamp_balance
  expect output_datum.lamp_locked == input_datum.lamp_locked
  expect output_datum.loyalty_holdings == input_datum.loyalty_holdings
  expect output_datum.magic_batches == input_datum.magic_batches             // T4: profile_at_creation immutable
  expect output_datum.next_batch_index == input_datum.next_batch_index
  expect output_datum.vacuum_orders == input_datum.vacuum_orders
  expect output_datum.gen_schedules == input_datum.gen_schedules
  expect output_datum.delegation_cert == input_datum.delegation_cert
  expect output_datum.activity_state == input_datum.activity_state
  expect output_datum.streak_state == input_datum.streak_state
  expect output_datum.personal_delegate == input_datum.personal_delegate
  expect output_datum.attribution == input_datum.attribution

  // KEY C-PC-V6: profile field STAY old (lazy)
  expect output_datum.profile == input_datum.profile

  // KEY C-PC-V6: pending_profile SET with effective = current + 1
  // Override: any existing pending is replaced — no `if pending == None` branch
  expect output_datum.pending_profile == Some(PendingProfile {
    new_profile,
    effective_epoch: current_epoch + 1,
  })

  // profile_changed_epoch = current (enforces cooldown for next change)
  expect output_datum.profile_changed_epoch == current_epoch

  // last_updated_epoch = current
  expect output_datum.last_updated_epoch == current_epoch

  True
}
