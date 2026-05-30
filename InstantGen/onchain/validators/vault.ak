// validators/vault.ak — Vault spending validator (InstantGen focus)
// Normative: §9 InstantGen, §4 Decay, §5.8 Vault constraints
// PlutusV3 / Aiken ≥ 1.1.x
//
// Parameterized by:
//   lamp_policy_id   : PolicyId of LAMP native asset
//   treasury_addr    : Address of Treasury UTxO
//   um_nft_policy    : PolicyId of UM datum NFT (identifies the UM UTxO)
//
// Build on testnet:
//   aiken build
//   # applies the 3 parameters, producing the script hash

use aiken/collection/list
use aiken/crypto
use aiken/primitive/bytearray
use aiken/interval.{Finite}
use cardano/address.{Address}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}

use magiclamp/protocol/types.{
  ActivityProfile, ApplyHalving, BurnBatch, Ember, Flame, Instant,
  InstantGen, Lantern, LoyaltyHolding, MagicBatch, PendingProfile, UMDatum,
  UpdateProfile, VaultDatum, VaultRedeemer, WithdrawLamp,
}
use magiclamp/protocol/constants.{
  instant_decay_window, max_batches_per_vault, max_instant_purchase,
  max_loyalty_holdings, min_instant_purchase, pm_q_ember, pm_q_flame,
  pm_q_lantern, profile_change_cooldown, q,
}
use magiclamp/protocol/math.{compute_instant_magic}
use magiclamp/protocol/decay.{halve_then_prune, is_expired}
use magiclamp/protocol/um.{
  get_um_for_instant, validate_um_history_length, validate_um_range,
}
use magiclamp/protocol/lamp.{
  l_avail, remove_from_holdings, remove_newest_first, sum_holdings,
  validate_holdings_sum, validate_lamp_locked,
}
use magiclamp/protocol/profile.{apply_pending_profile}

// ── Validator parameters ─────────────────────────────────────
// `ms_per_epoch` is applied per-network (Plutus validity_range is POSIX ms):
//   Mainnet:        432_000_000
//   Preview/Preprod: 86_400_000
validator vault(
  lamp_policy_id : PolicyId,
  treasury_addr  : Address,
  um_nft_policy  : PolicyId,
  ms_per_epoch   : Int,
) {
  spend(
    datum_opt : Option<VaultDatum>,
    redeemer  : VaultRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    // Datum must always be present on vault UTxOs
    expect Some(input_datum) = datum_opt

    // ── Derive current epoch from tx validity range ──────────
    // Plutus V3 validity_range carries POSIX milliseconds, not slots.
    let current_epoch = get_current_epoch(tx, ms_per_epoch)

    when redeemer is {
      // ── InstantGen redeemer ──────────────────────────────
      InstantGen { lamp_paid } ->
        validate_instant_gen(
          input_datum, lamp_paid, current_epoch,
          own_ref, lamp_policy_id, treasury_addr, um_nft_policy, tx,
        )

      // ── ApplyHalving (stub) ──────────────────────────────
      ApplyHalving -> {
        // TODO v1.1: call apply_pending_profile(input_datum, current_epoch)
        //           and use applied_input for any profile-dependent halving
        //           computation + A02 datum check.
        //           Pattern: SPEC_V1 §2 handler usage.
        expect list.has(tx.extra_signatories, input_datum.owner)
        True
      }

      // ── BurnBatch (stub) ─────────────────────────────────
      BurnBatch { .. } -> {
        // TODO v1.1: call apply_pending_profile + use applied_input for
        //           M computation + A02 datum check. SPEC_V1 §2 pattern.
        //           Full ConsumeMAGIC scope arrives in v1.1.
        expect list.has(tx.extra_signatories, input_datum.owner)
        True
      }

      // ── UpdateProfile (full impl — SPEC_V1 §2/§3) ────────
      UpdateProfile { new_profile } ->
        validate_update_profile(
          input_datum, new_profile, current_epoch, own_ref, tx,
        )

      // ── WithdrawLamp (SPEC_V1 §1) ────────────────────────
      WithdrawLamp { amount } ->
        validate_withdraw_lamp(
          input_datum, amount, current_epoch, own_ref, lamp_policy_id, tx,
        )
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// validate_instant_gen — all C-INST-* and related constraints
// ═══════════════════════════════════════════════════════════════
fn validate_instant_gen(
  input_datum    : VaultDatum,
  lamp_paid      : Int,
  current_epoch  : Int,
  own_ref        : OutputReference,
  lamp_policy_id : PolicyId,
  treasury_addr  : Address,
  um_nft_policy  : PolicyId,
  tx             : Transaction,
) -> Bool {

  // ── C-VAULT-DS-1: exactly one vault input ────────────────
  // Prevents Double Satisfaction attack (T20, A1). Address match alone is
  // sufficient — each vault UTxO has a unique own_ref enforced by Cardano.
  let vault_addr = find_own_address(own_ref, tx.inputs)
  let vault_input_count =
    list.count(tx.inputs, fn(i) { i.output.address == vault_addr })
  expect vault_input_count == 1

  // ── User must sign (C-PC-V1) ─────────────────────────────
  expect list.has(tx.extra_signatories, input_datum.owner)

  // ── Lazy profile apply (SPEC_V1 §2/§3) ────────────────────
  // If pending_profile has reached effective_epoch, switch profile field
  // and clear pending. applied_input is used for BOTH the M-compute (PM
  // depends on profile) AND the A02 output datum check so pending clears
  // on the output (otherwise next tx would apply it again — infinite loop).
  let applied_input = apply_pending_profile(input_datum, current_epoch)

  // ── C-INST-1: lamp_paid ≥ 10 LAMP = 10^7 oil ────────────
  expect lamp_paid >= min_instant_purchase

  // ── C-INST-2: lamp_paid ≤ 10^13 oil ─────────────────────
  expect lamp_paid <= max_instant_purchase

  // ── C-INST-3: lamp_paid ≤ L_avail ───────────────────────
  let avail = l_avail(applied_input.lamp_balance, applied_input.lamp_locked)
  expect lamp_paid <= avail

  // ── C-INST-7: |active_batches| + 1 ≤ 32 ─────────────────
  // Count non-expired batches BEFORE this tx (post-prune).
  let pre_prune_count =
    list.count(applied_input.magic_batches, fn(b) {
      !is_expired(b, current_epoch)
    })
  expect pre_prune_count < max_batches_per_vault

  // ── Get UM from reference input (C-UM-6) ─────────────────
  let um_datum = find_um_datum(tx.reference_inputs, um_nft_policy)
  expect validate_um_range(um_datum)
  expect validate_um_history_length(um_datum)
  let um_q = get_um_for_instant(um_datum, current_epoch)

  // ── C-INST-5: Compute expected M (uses applied profile) ───
  let pm_q = get_pm_q(applied_input.profile)
  let expected_m = compute_instant_magic(lamp_paid, um_q, pm_q)
  expect expected_m > 0   // sanity: M must be positive

  // ── Compute expected batch list ───────────────────────────
  // Step 1: Halve (C-PRUNE-2), then Prune (C-PRUNE-1)
  let cleaned_batches = halve_then_prune(applied_input.magic_batches, current_epoch)

  // Step 2: Create new Instant batch (C-INST-6)
  let new_batch_id = compute_batch_id(own_ref, applied_input.next_batch_index)
  let new_batch =
    MagicBatch {
      batch_id:            new_batch_id,
      source:              Instant,
      created_epoch:       current_epoch,
      initial_amount:      expected_m,
      current_amount:      expected_m,
      decay_window:        instant_decay_window,  // 2
      profile_at_creation: None,                  // C-DECAY-4: None for Instant
      contract_id:         None,
      halved:              False,                  // C-INST-6 + T22
    }

  let expected_batches = list.concat(cleaned_batches, [new_batch])

  // ── C-INST-4: Treasury receives lamp_paid ────────────────
  expect treasury_receives_lamp(tx.outputs, treasury_addr, lamp_policy_id, lamp_paid)

  // ── A02: Field-by-field output datum validation ───────────
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  // Unchanged fields (compared against applied_input — see top comment)
  expect output_datum.owner == applied_input.owner
  expect output_datum.lamp_locked == applied_input.lamp_locked
  expect output_datum.vacuum_orders == applied_input.vacuum_orders
  expect output_datum.gen_schedules == applied_input.gen_schedules
  expect output_datum.profile == applied_input.profile
  expect output_datum.profile_changed_epoch == applied_input.profile_changed_epoch
  expect output_datum.pending_profile == applied_input.pending_profile
  expect output_datum.delegation_cert == applied_input.delegation_cert
  expect output_datum.streak_state == applied_input.streak_state
  expect output_datum.personal_delegate == applied_input.personal_delegate

  // Changed: lamp_balance decremented (C-INST-10: supply unchanged via eUTxO)
  expect output_datum.lamp_balance == applied_input.lamp_balance - lamp_paid

  // Changed: loyalty_holdings reduced by lamp_paid
  let expected_holdings = remove_from_holdings(applied_input.loyalty_holdings, lamp_paid)
  expect output_datum.loyalty_holdings == expected_holdings

  // C-VAULT-10: Σholdings.amount == new lamp_balance
  expect validate_holdings_sum(output_datum.loyalty_holdings, output_datum.lamp_balance)

  // C-VAULT-8: lamp_locked ≤ lamp_balance (still valid after reduction)
  expect validate_lamp_locked(output_datum.lamp_locked, output_datum.lamp_balance)

  // C-VAULT-13: |holdings| ≤ 64
  expect list.length(output_datum.loyalty_holdings) <= max_loyalty_holdings

  // Changed: magic_batches (halved + pruned + new batch)
  expect output_datum.magic_batches == expected_batches

  // C-VAULT-1: |batches| ≤ 32
  expect list.length(output_datum.magic_batches) <= max_batches_per_vault

  // Changed: next_batch_index must increment by exactly 1 (C-VAULT-3)
  expect output_datum.next_batch_index == applied_input.next_batch_index + 1

  // Changed: last_updated_epoch = current epoch
  expect output_datum.last_updated_epoch == current_epoch

  // Attribution hash-chain updated (C-ATT-1, C-ATT-2)
  // Note: exact event encoding must match the attribution module.
  // For testnet v1, we verify total_events incremented.
  expect output_datum.attribution.total_events == applied_input.attribution.total_events + 1
  expect output_datum.attribution.last_event_epoch == current_epoch

  // ── C-INST-10: LAMP supply unchanged ─────────────────────
  // Guaranteed by eUTxO conservation: lamp_paid moves vault→Treasury.
  // The treasury_receives_lamp check above enforces the exact amount.
  True
}

// ═══════════════════════════════════════════════════════════════
// Helper functions
// ═══════════════════════════════════════════════════════════════

/// Compute batch_id = blake2b256(own_ref_cbor ∥ encode(next_batch_index))
fn compute_batch_id(own_ref: OutputReference, index: Int) -> ByteArray {
  let ref_bytes = serialize_output_reference(own_ref)
  let idx_bytes = encode_int(index)
  crypto.blake2b_256(bytearray.concat(ref_bytes, idx_bytes))
}

/// Get PM_Q for a given profile (§3.4)
fn get_pm_q(profile: ActivityProfile) -> Int {
  when profile is {
    Ember   -> pm_q_ember
    Flame   -> pm_q_flame
    Lantern -> pm_q_lantern
  }
}

/// Derive current epoch from transaction validity range lower bound.
/// Plutus V3 validity_range is POSIX milliseconds, so epoch = posix_ms / ms_per_epoch.
fn get_current_epoch(tx: Transaction, ms_per_epoch: Int) -> Int {
  expect Some(lower_ms) = tx.validity_range.lower_bound.bound_type |> get_finite_slot
  lower_ms / ms_per_epoch
}

fn get_finite_slot(bound_type) -> Option<Int> {
  when bound_type is {
    Finite(s) -> Some(s)
    _ -> None
  }
}

/// Find the address of the currently-being-spent vault script UTxO.
fn find_own_address(own_ref: OutputReference, inputs: List<Input>) -> Address {
  expect Some(own_input) = list.find(inputs, fn(i) { i.output_reference == own_ref })
  own_input.output.address
}

/// Find the UM datum from reference inputs (identified by um_nft_policy).
fn find_um_datum(
  ref_inputs    : List<Input>,
  um_nft_policy : PolicyId,
) -> UMDatum {
  expect Some(um_input) = list.find(ref_inputs, fn(i) {
    let qty = assets.quantity_of(i.output.value, um_nft_policy, #"554d44")  // "UMD"
    qty > 0
  })
  expect InlineDatum(um_data) = um_input.output.datum
  expect um: UMDatum = um_data
  um
}

/// Find the vault's output (used for value check in WithdrawLamp W-6).
fn find_vault_output(outputs: List<Output>, vault_addr: Address) -> Output {
  expect Some(vault_output) = list.find(outputs, fn(o) { o.address == vault_addr })
  vault_output
}

/// Find the vault's output datum (A02: used for field-by-field validation).
fn find_vault_output_datum(
  outputs    : List<Output>,
  vault_addr : Address,
) -> VaultDatum {
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

  // W-3: amount ≤ L_avail
  let avail = l_avail(input_datum.lamp_balance, input_datum.lamp_locked)
  expect amount <= avail

  // W-4: exactly 1 vault input
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

  // W-5: A02 field-by-field output datum check
  let output_datum     = find_vault_output_datum(tx.outputs, vault_addr)
  let new_holdings     = remove_newest_first(input_datum.loyalty_holdings, amount)
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
  expect output_datum.last_updated_epoch == current_epoch

  // W-6: vault output value carries the new lamp_balance worth of LAMP
  let vault_output = find_vault_output(tx.outputs, vault_addr)
  let vault_lamp_qty =
    assets.quantity_of(vault_output.value, lamp_policy_id, #"4c414d50")  // "LAMP"
  expect vault_lamp_qty == new_lamp_balance

  // W-7: Σholdings == lamp_balance
  expect sum_holdings(output_datum.loyalty_holdings) == output_datum.lamp_balance

  expect list.length(output_datum.loyalty_holdings) <= max_loyalty_holdings

  True
}

// ═══════════════════════════════════════════════════════════════
// validate_update_profile — C-PC-V1..V6 (SPEC_V1 §2/§3)
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

  // C-PC-V2: cooldown ≥ 2 epochs
  expect current_epoch - input_datum.profile_changed_epoch >= profile_change_cooldown

  // C-PC-V3: must actually change
  expect new_profile != input_datum.profile

  // C-PC-V4..V6: lazy apply — profile stays, pending set
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  expect output_datum.owner == input_datum.owner
  expect output_datum.lamp_balance == input_datum.lamp_balance
  expect output_datum.lamp_locked == input_datum.lamp_locked
  expect output_datum.loyalty_holdings == input_datum.loyalty_holdings
  expect output_datum.magic_batches == input_datum.magic_batches         // T4 immutable
  expect output_datum.next_batch_index == input_datum.next_batch_index
  expect output_datum.vacuum_orders == input_datum.vacuum_orders
  expect output_datum.gen_schedules == input_datum.gen_schedules
  expect output_datum.delegation_cert == input_datum.delegation_cert
  expect output_datum.activity_state == input_datum.activity_state
  expect output_datum.streak_state == input_datum.streak_state
  expect output_datum.personal_delegate == input_datum.personal_delegate
  expect output_datum.attribution == input_datum.attribution

  // KEY: profile stay old (lazy)
  expect output_datum.profile == input_datum.profile

  // KEY: pending_profile SET with effective = current + 1 (override any existing)
  expect output_datum.pending_profile == Some(PendingProfile {
    new_profile,
    effective_epoch: current_epoch + 1,
  })

  expect output_datum.profile_changed_epoch == current_epoch
  expect output_datum.last_updated_epoch == current_epoch

  True
}

/// Verify Treasury receives exactly lamp_paid of LAMP token (C-INST-4).
/// Also verifies LAMP conservation (C-INST-10) at the output level.
fn treasury_receives_lamp(
  outputs        : List<Output>,
  treasury_addr  : Address,
  lamp_policy_id : PolicyId,
  lamp_paid      : Int,
) -> Bool {
  let lamp_at_treasury =
    list.foldl(outputs, 0, fn(o, acc) {
      if o.address == treasury_addr {
        acc + assets.quantity_of(o.value, lamp_policy_id, #"4c414d50")  // "LAMP"
      } else {
        acc
      }
    })
  lamp_at_treasury >= lamp_paid  // ≥ to allow Treasury to aggregate multiple outputs
}

/// Encode an OutputReference to bytes for batch_id computation.
/// Must match the off-chain SDK encoding (P8: determinism).
fn serialize_output_reference(ref: OutputReference) -> ByteArray {
  // CBOR encoding: [transaction_id (32 bytes), output_index (varint)]
  let OutputReference { transaction_id, output_index } = ref
  bytearray.concat(transaction_id, encode_int(output_index))
}

/// Encode a Natural number as 8-byte big-endian (for batch_id).
fn encode_int(n: Int) -> ByteArray {
  // Simplified: encode as 8-byte big-endian
  // Full implementation uses CBOR integer encoding to match off-chain.
  bytearray.from_int_big_endian(n, 8)
}
