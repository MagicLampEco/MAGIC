// validators/vault.ak — Vault spending validator (InstantGen focus)
// Normative: §9 InstantGen, §4 Decay, §5.8 Vault constraints
// PlutusV3 / Aiken ≥ 1.1.x
//
// Parameterized by:
//   lamp_policy_id   : PolicyId of LAMP native asset
//   treasury_addr    : Address of Treasury UTxO
//   um_nft_policy    : PolicyId of UM datum NFT (identifies the UM UTxO)
//   um_script_hash   : ByteArray = applied UMKeeper validator hash. Pins the UM
//                      reference input to the canonical UM script address. Without
//                      this, a forged UTxO at an attacker address carrying a fake
//                      UMD NFT + fake UMDatum could be used as ref input (the UM
//                      NFT alone is not a global singleton). MAINNET-BLOCK fix,
//                      defense-in-depth layer (b).
//
// Build on testnet:
//   aiken build
//   # applies the 4 parameters, producing the script hash

use aiken/collection/list
use aiken/crypto
use aiken/primitive/bytearray
use aiken/interval.{Finite, after, between}
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, placeholder,
}

use magiclamp/protocol/types.{
  ActivityProfile, ActivityState, ApplyHalving, BurnBatch, DelegationCertificate,
  Ember, Flame, Instant, InstantGen, Lantern, LoyaltyHolding, MagicBatch,
  PendingProfile, SetDelegate, StreakState, UMDatum, UpdateProfile,
  VaultAttribution, VaultDatum, VaultRedeemer, WithdrawLamp,
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
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,  // LAMP asset name per network (deploy-applied)
  treasury_addr   : Address,
  um_nft_policy   : PolicyId,
  um_script_hash  : ByteArray,
  ms_per_epoch    : Int,
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
          own_ref, lamp_policy_id, lamp_asset_name, treasury_addr, um_nft_policy,
          um_script_hash, tx,
        )

      // ── ApplyHalving — permissionless pending-profile apply ─
      ApplyHalving ->
        validate_apply_halving(
          input_datum, current_epoch, own_ref, lamp_policy_id, lamp_asset_name, tx,
        )

      // ── BurnBatch — datum-consume (D1, no token, no mint) ──
      // Consuming MAGIC = subtracting from magic_batches[].current_amount in
      // the vault datum. MAGIC never leaves the vault as a token. Auth is
      // owner-OR-consume-delegate (paymaster). The price/`required` match
      // (Σburns == required) is enforced by the ConsumeMAGIC validator in the
      // co-spend tx; the vault enforces the safe datum mutation + value lock.
      BurnBatch { burns } ->
        validate_burn_batch(
          input_datum, burns, current_epoch, own_ref, lamp_policy_id, lamp_asset_name, tx,
        )

      // ── UpdateProfile (full impl — SPEC_V1 §2/§3) ────────
      UpdateProfile { new_profile } ->
        validate_update_profile(
          input_datum, new_profile, current_epoch, own_ref, lamp_policy_id, lamp_asset_name, tx,
        )

      // ── WithdrawLamp (SPEC_V1 §1) ────────────────────────
      WithdrawLamp { amount } ->
        validate_withdraw_lamp(
          input_datum, amount, current_epoch, own_ref, lamp_policy_id, lamp_asset_name, tx,
        )

      // ── SetDelegate — set/clear consume-delegate (D1) ────
      SetDelegate { new_delegate } ->
        validate_set_delegate(
          input_datum, new_delegate, current_epoch, own_ref, lamp_policy_id, lamp_asset_name, tx,
        )
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// validate_instant_gen — all C-INST-* and related constraints
// ═══════════════════════════════════════════════════════════════
fn validate_instant_gen(
  input_datum     : VaultDatum,
  lamp_paid       : Int,
  current_epoch   : Int,
  own_ref         : OutputReference,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  treasury_addr   : Address,
  um_nft_policy   : PolicyId,
  um_script_hash  : ByteArray,
  tx              : Transaction,
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

  // ── MONOTONIC EPOCH guard (MAINNET-BLOCK — epoch gaming) ──
  // Even with the validity-range-in-one-epoch fix, a vault could be spent in a
  // tx whose validity range legitimately sits in an epoch EARLIER than the
  // vault's own last_updated_epoch (e.g. clock skew / a long-pending vault).
  // Decay, halving and UM staleness all assume time only moves forward; a
  // backwards epoch would let an attacker burn at a stale current_amount or
  // skip halving. Enforce epoch monotonicity against the vault's own clock.
  expect current_epoch >= input_datum.last_updated_epoch

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
  let um_datum = find_um_datum(tx.reference_inputs, um_nft_policy, um_script_hash)
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
  // Treasury must be a SCRIPT custody address (PR #11 review pt3). A free
  // verification-key (wallet) treasury_addr is a honeypot: pointing it at the
  // owner's own wallet, or co-locating another wallet output in the tx, makes
  // the `≥ lamp_paid` aggregate check vacuously satisfiable (Treasury/CONTRACT.md:66).
  expect Script(_) = treasury_addr.payment_credential
  expect treasury_receives_lamp(tx.outputs, treasury_addr, lamp_policy_id, lamp_asset_name, lamp_paid)

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

  // ── VALUE PRESERVATION (CRIT value-leak fix, symmetric to W-6) ──
  // The A02 datum check above asserts the *claimed* new lamp_balance, but
  // nothing tied that claim to the LAMP actually sitting in the vault output.
  // Without this, an attacker forges output_datum.lamp_balance = X while the
  // output value carries < X LAMP — draining LAMP out of the vault while the
  // datum lies. Bind datum to value: vault output LAMP == new lamp_balance.
  let inst_vault_output = find_vault_output(tx.outputs, vault_addr)
  let inst_vault_lamp =
    assets.quantity_of(inst_vault_output.value, lamp_policy_id, lamp_asset_name)
  expect inst_vault_lamp == output_datum.lamp_balance

  // ── ADA / token-set preservation (MAINNET-BLOCK) ──────────
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), inst_vault_output)

  True
}

// ═══════════════════════════════════════════════════════════════
// validate_apply_halving — H-1..H-6
// Semantics: standalone tx that applies pending_profile (if due) and
// lazily halves Instant batches at age k=1.  Permissionless — no owner
// signature required (H-5).
// ═══════════════════════════════════════════════════════════════
fn validate_apply_halving(
  input_datum    : VaultDatum,
  current_epoch  : Int,
  own_ref         : OutputReference,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {

  // ── H-1: exactly one vault input (C-VAULT-DS-1) ─────────────
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

  // ── H-2: lazy profile apply (SPEC_V1 §2) ─────────────────────
  // Must use applied_input for BOTH the batch computation (PM) AND the
  // A02 output datum check so that pending_profile clears on the output.
  let applied_input = apply_pending_profile(input_datum, current_epoch)

  // ── H-3: apply halving across all batches ────────────────────
  // halve_then_prune = apply_halving_all then prune_expired (C-PRUNE-2).
  let expected_batches = halve_then_prune(applied_input.magic_batches, current_epoch)

  // ── A02: field-by-field output datum check ────────────────────
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  // H-4: LAMP balance and all LAMP-related fields UNCHANGED
  expect output_datum.owner == applied_input.owner
  expect output_datum.lamp_balance == applied_input.lamp_balance
  expect output_datum.lamp_locked == applied_input.lamp_locked
  expect output_datum.loyalty_holdings == applied_input.loyalty_holdings

  // H-6: magic_batches = halve_then_prune(applied_input.magic_batches)
  expect output_datum.magic_batches == expected_batches

  // C-VAULT-1: batch count ≤ 32
  expect list.length(output_datum.magic_batches) <= max_batches_per_vault

  // next_batch_index UNCHANGED (no new batch created)
  expect output_datum.next_batch_index == applied_input.next_batch_index

  // last_updated_epoch PRESERVED (griefing fix, symmetric to WithdrawLamp W-5/
  // PR #11 pt4). ApplyHalving is PERMISSIONLESS (H-5, no signature) — if it
  // advanced last_updated_epoch, any third party could call it on a victim's
  // vault every epoch, zeroing the SnapshotGen catch-up window
  // (delta_e = current_epoch - last_updated_epoch) and forfeiting the victim's
  // accrued Snapshot MAGIC. Halving correctness depends only on each batch's
  // created_epoch (see halve_then_prune), never on last_updated_epoch, so
  // preserving it is safe and closes the griefing vector.
  expect output_datum.last_updated_epoch == applied_input.last_updated_epoch

  // Remaining fields UNCHANGED
  expect output_datum.vacuum_orders == applied_input.vacuum_orders
  expect output_datum.gen_schedules == applied_input.gen_schedules
  expect output_datum.profile == applied_input.profile
  expect output_datum.profile_changed_epoch == applied_input.profile_changed_epoch
  expect output_datum.pending_profile == applied_input.pending_profile
  expect output_datum.delegation_cert == applied_input.delegation_cert
  expect output_datum.activity_state == applied_input.activity_state
  expect output_datum.streak_state == applied_input.streak_state
  expect output_datum.personal_delegate == applied_input.personal_delegate
  expect output_datum.attribution == applied_input.attribution

  // ── VALUE PRESERVATION (CRIT value-leak fix, symmetric to W-6) ──
  // ApplyHalving never moves LAMP; bind the output value to the (unchanged)
  // lamp_balance so a forged datum cannot be paired with a drained value.
  let halve_vault_output = find_vault_output(tx.outputs, vault_addr)
  let halve_vault_lamp =
    assets.quantity_of(halve_vault_output.value, lamp_policy_id, lamp_asset_name)
  expect halve_vault_lamp == output_datum.lamp_balance

  // ── ADA / token-set preservation (MAINNET-BLOCK) ──────────
  // CRITICAL on this path: ApplyHalving is permissionless (H-5), so without
  // this a third party builds a valid ApplyHalving tx that keeps LAMP correct
  // but reroutes the victim's surplus ADA into their own output, or stuffs
  // dust tokens to brick the vault. Bind lovelace >= input and policy-set ≤ 2.
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), halve_vault_output)

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

/// Derive current epoch from transaction validity range.
///
/// MAINNET-BLOCK fix — validity-range epoch gaming. The epoch is derived from
/// `lower_bound`, but the caller picks the validity range freely. Without an
/// `upper_bound` constraint the caller could set `lower_bound` to ANY past or
/// future epoch (the tx is still valid on-chain as long as the node clock is
/// inside the range), letting them:
///   (a) replay a stale UM datum as if `staleness ≤ 1` → inflate UM,
///   (b) dodge halving / extend a batch's lifetime by stamping a chosen epoch,
///   (c) burn at an old `current_amount` by claiming a past epoch.
///
/// Fix: require the WHOLE validity range to sit inside ONE epoch:
///   epoch*P ≤ lower_ms   AND   upper_ms < (epoch+1)*P
/// so `lower_ms / P == upper_ms / P == epoch`. The on-chain clock then forces
/// `current_epoch` to be the real epoch of the slot the tx lands in — the
/// caller can no longer choose it. The `lower_ms / ms_per_epoch` definition of
/// `epoch` already gives `epoch*P ≤ lower_ms`; we only need the upper bound.
fn get_current_epoch(tx: Transaction, ms_per_epoch: Int) -> Int {
  expect Some(lower_ms) = tx.validity_range.lower_bound.bound_type |> get_finite_slot
  let epoch = lower_ms / ms_per_epoch
  // upper_bound must be finite AND in the same epoch as lower_bound.
  expect Some(upper_ms) = tx.validity_range.upper_bound.bound_type |> get_finite_slot
  expect upper_ms < ( epoch + 1 ) * ms_per_epoch
  epoch
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

/// Find the currently-being-spent vault Input (used for value preservation).
fn find_own_input(own_ref: OutputReference, inputs: List<Input>) -> Input {
  expect Some(own_input) = list.find(inputs, fn(i) { i.output_reference == own_ref })
  own_input
}

/// VALUE-PRESERVATION guard (MAINNET-BLOCK — ADA drain / token-set stuffing).
///
/// Every handler already binds the vault output's LAMP quantity to the new
/// lamp_balance, but nothing constrained the rest of the output value. Two
/// distinct attacks remain, and the second one is exploitable WITHOUT the
/// owner's signature because ApplyHalving is permissionless (H-5):
///
///   1. ADA drain: build an output whose datum + LAMP are correct but whose
///      lovelace is set to the bare min-ADA, pocketing the vault's surplus ADA.
///   2. Token-set bloat: stuff arbitrary dust tokens into the vault output,
///      growing it past the eUTXO size / exec-unit limit so the vault can
///      never be spent again (permanent griefing).
///
/// Fix (applied to ALL handlers, symmetric to the LAMP value lock):
///   - lovelace(out) >= lovelace(in)        → no ADA siphoned ( `>=` lets an
///     honest caller top up ADA, never let it shrink).
///   - |policies(out)| <= 2                  → at most {ADA, LAMP}; rejects any
///     extra policy. (`policies` lists ada_policy_id "" when lovelace > 0, so a
///     normal vault has exactly 2.) This bounds the output token-set so dust
///     stuffing cannot bloat the UTxO.
/// The per-handler LAMP-quantity check still pins the LAMP amount itself.
fn validate_vault_value(vault_input: Input, vault_output: Output) -> Bool {
  expect assets.lovelace_of(vault_output.value) >= assets.lovelace_of(vault_input.output.value)
  expect list.length(assets.policies(vault_output.value)) <= 2
  True
}

/// Find the UM datum from reference inputs.
///
/// MAINNET-BLOCK defense-in-depth (b): the ref input must satisfy BOTH
///   1. carry the UM NFT (um_nft_policy, "UMD"), AND
///   2. sit at the canonical UM script address (payment credential ==
///      Script(um_script_hash)).
/// The UM NFT policy is not a guaranteed global singleton, so condition (1)
/// alone is forgeable. Pinning the script address rejects any forged UM UTxO
/// living at an attacker-controlled address even if the NFT is duplicated.
fn find_um_datum(
  ref_inputs     : List<Input>,
  um_nft_policy  : PolicyId,
  um_script_hash : ByteArray,
) -> UMDatum {
  expect Some(um_input) = list.find(ref_inputs, fn(i) {
    let has_nft =
      assets.quantity_of(i.output.value, um_nft_policy, #"554d44") > 0  // "UMD"
    let at_um_script =
      i.output.address.payment_credential == Script(um_script_hash)
    has_nft && at_um_script
  })
  expect InlineDatum(um_data) = um_input.output.datum
  expect um: UMDatum = um_data
  um
}

/// Find the vault's output (used for value check in WithdrawLamp W-6).
fn find_vault_output(outputs: List<Output>, vault_addr: Address) -> Output {
  // C-VAULT-OUT-1 (PR #11 review): exactly one continuing vault output, symmetric
  // to the input==1 check. Blocks a phantom 2nd vault output carrying a forged datum.
  expect list.count(outputs, fn(o) { o.address == vault_addr }) == 1
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
  _current_epoch : Int,
  own_ref         : OutputReference,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
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
  // last_updated_epoch PRESERVED (PR #11 review pt4): withdraw must NOT advance
  // it — doing so would reset the Snapshot catch-up window and forfeit MAGIC
  // accrued over elapsed epochs. Withdraw is LAMP-only, orthogonal to snapshot.
  expect output_datum.last_updated_epoch == input_datum.last_updated_epoch

  // W-6: vault output value carries the new lamp_balance worth of LAMP
  let vault_output = find_vault_output(tx.outputs, vault_addr)
  let vault_lamp_qty =
    assets.quantity_of(vault_output.value, lamp_policy_id, lamp_asset_name)  // "tLAMP"
  expect vault_lamp_qty == new_lamp_balance

  // W-7: Σholdings == lamp_balance
  expect sum_holdings(output_datum.loyalty_holdings) == output_datum.lamp_balance

  expect list.length(output_datum.loyalty_holdings) <= max_loyalty_holdings

  // ── ADA / token-set preservation (MAINNET-BLOCK) ──────────
  // Owner-signed (self-harm for ADA), but the policy-set ≤ 2 bound still blocks
  // dust-stuffing that would permanently brick the vault.
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), vault_output)

  True
}

// ═══════════════════════════════════════════════════════════════
// validate_burn_batch — datum-consume of MAGIC (D1)
//
// Consuming MAGIC = subtracting `amount` (nanogic) from the matching batch's
// current_amount. No tx.mint, no token. The vault is the ONLY place MAGIC is
// reduced. Auth = owner OR consume-delegate (personal_delegate). The price
// match (Σburns == required) is enforced by the co-spending ConsumeMAGIC
// validator that reads the PriceParam beacon + this BurnBatch redeemer; the
// vault enforces the safe per-batch mutation, A02, and LAMP value lock.
// ═══════════════════════════════════════════════════════════════
fn validate_burn_batch(
  input_datum    : VaultDatum,
  burns          : List<(ByteArray, Int)>,
  current_epoch  : Int,
  own_ref         : OutputReference,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {

  // ── DS-1: exactly one vault input (no double-satisfaction) ──
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

  // ── AUTH: owner OR consume-delegate signs ─────────────────
  let authed =
    list.has(tx.extra_signatories, input_datum.owner) || when input_datum.personal_delegate is {
      Some(d) -> list.has(tx.extra_signatories, d)
      None -> False
    }
  expect authed

  // ── MONOTONIC EPOCH guard (MAINNET-BLOCK — epoch gaming) ──
  // The delegate path means a non-owner can call this; a backwards epoch would
  // skip halving (halve_then_prune keys on created_epoch vs current_epoch) and
  // let the delegate burn at an inflated current_amount. Pin forward-only time.
  expect current_epoch >= input_datum.last_updated_epoch

  // ── Lazy profile apply (like every handler) ───────────────
  let applied = apply_pending_profile(input_datum, current_epoch)

  // ── Decay first, then subtract burns ──────────────────────
  // halve_then_prune runs on ALL batches (decay never skipped); burns are
  // applied to the post-decay list so current_amount cannot be inflated.
  let decayed = halve_then_prune(applied.magic_batches, current_epoch)
  let expected_batches = apply_burns(decayed, burns)

  // ── A02: field-by-field output datum check (17 fields) ────
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  expect output_datum.owner == applied.owner
  expect output_datum.lamp_balance == applied.lamp_balance       // BurnBatch never touches LAMP
  expect output_datum.lamp_locked == applied.lamp_locked
  expect output_datum.loyalty_holdings == applied.loyalty_holdings
  expect output_datum.magic_batches == expected_batches          // the only MAGIC change
  expect output_datum.next_batch_index == applied.next_batch_index
  expect output_datum.vacuum_orders == applied.vacuum_orders
  expect output_datum.gen_schedules == applied.gen_schedules
  expect output_datum.profile == applied.profile
  expect output_datum.profile_changed_epoch == applied.profile_changed_epoch
  expect output_datum.pending_profile == applied.pending_profile
  expect output_datum.delegation_cert == applied.delegation_cert
  expect output_datum.activity_state == applied.activity_state
  expect output_datum.streak_state == applied.streak_state
  expect output_datum.personal_delegate == applied.personal_delegate  // delegate unchanged here
  expect output_datum.last_updated_epoch == current_epoch
  expect output_datum.attribution.total_events == applied.attribution.total_events + 1
  expect output_datum.attribution.last_event_epoch == current_epoch

  // ── VALUE PRESERVATION (chống value-leak) ─────────────────
  let vault_output = find_vault_output(tx.outputs, vault_addr)
  let vault_lamp_qty =
    assets.quantity_of(vault_output.value, lamp_policy_id, lamp_asset_name)  // "tLAMP"
  expect vault_lamp_qty == output_datum.lamp_balance

  // ── ADA / token-set preservation (MAINNET-BLOCK) ──────────
  // Delegate-callable path: bind ADA + policy-set so a delegate cannot siphon
  // the victim's ADA or brick the vault with dust while burning their MAGIC.
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), vault_output)

  expect list.length(output_datum.magic_batches) <= max_batches_per_vault
  True
}

/// Subtract `burns` from a (decayed) batch list.
/// For each (batch_id, amount): there must be EXACTLY one matching batch;
/// 0 < amount ≤ current_amount; every other field stays immutable (T4); a
/// batch whose result is 0 is pruned. List order is preserved for untouched
/// batches. Over-burn (amount > current_amount) and unknown batch_id fail.
fn apply_burns(
  batches : List<MagicBatch>,
  burns   : List<(ByteArray, Int)>,
) -> List<MagicBatch> {
  when burns is {
    [] -> batches
    [burn, ..rest] -> {
      let (bid, amt) = burn
      expect amt > 0
      // exactly one batch with this id (prevents ambiguous/duplicate targeting)
      expect list.count(batches, fn(b) { b.batch_id == bid }) == 1
      let updated =
        list.filter_map(batches, fn(b) {
          if b.batch_id == bid {
            expect amt <= b.current_amount   // over-burn forbidden (== model, not ≥)
            let new_amount = b.current_amount - amt
            if new_amount == 0 {
              None   // prune fully-consumed batch
            } else {
              Some(MagicBatch { ..b, current_amount: new_amount })
            }
          } else {
            Some(b)
          }
        })
      apply_burns(updated, rest)
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// validate_set_delegate — set/clear consume-delegate (D1)
//
// Owner-ONLY. No cooldown (changing a delegate is cheap, no economic effect).
// Reuses personal_delegate (field 15); only that field + last_updated_epoch
// may change. MAGIC and LAMP are untouched; value is locked to lamp_balance.
// ═══════════════════════════════════════════════════════════════
fn validate_set_delegate(
  input_datum    : VaultDatum,
  new_delegate   : Option<ByteArray>,
  current_epoch  : Int,
  own_ref         : OutputReference,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {

  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

  // ONLY owner may change the delegate (a delegate cannot re-delegate itself)
  expect list.has(tx.extra_signatories, input_datum.owner)

  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  // Every field immutable EXCEPT personal_delegate + last_updated_epoch
  expect output_datum.owner == input_datum.owner
  expect output_datum.lamp_balance == input_datum.lamp_balance
  expect output_datum.lamp_locked == input_datum.lamp_locked
  expect output_datum.loyalty_holdings == input_datum.loyalty_holdings
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
  expect output_datum.attribution == input_datum.attribution

  // KEY: delegate set to new value; epoch advanced
  expect output_datum.personal_delegate == new_delegate
  expect output_datum.last_updated_epoch == current_epoch

  // Value lock: LAMP in vault output unchanged
  let vault_output = find_vault_output(tx.outputs, vault_addr)
  let vault_lamp_qty =
    assets.quantity_of(vault_output.value, lamp_policy_id, lamp_asset_name)
  expect vault_lamp_qty == input_datum.lamp_balance

  // ── ADA / token-set preservation (MAINNET-BLOCK) ──────────
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), vault_output)

  True
}

// ═══════════════════════════════════════════════════════════════
// validate_update_profile — C-PC-V1..V6 (SPEC_V1 §2/§3)
// ═══════════════════════════════════════════════════════════════
fn validate_update_profile(
  input_datum    : VaultDatum,
  new_profile    : ActivityProfile,
  current_epoch  : Int,
  own_ref         : OutputReference,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
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

  // ── VALUE preservation: LAMP qty + ADA / token-set (MAINNET-BLOCK) ──
  // UpdateProfile is owner-signed and LAMP-neutral, but previously bound NO
  // output value at all (only the datum's lamp_balance). Bind LAMP to the
  // unchanged balance and ADA/policy-set so the output cannot be drained or
  // dust-stuffed.
  let vault_output = find_vault_output(tx.outputs, vault_addr)
  let vault_lamp_qty =
    assets.quantity_of(vault_output.value, lamp_policy_id, lamp_asset_name)
  expect vault_lamp_qty == input_datum.lamp_balance
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), vault_output)

  True
}

/// Verify Treasury receives exactly lamp_paid of LAMP token (C-INST-4).
/// Also verifies LAMP conservation (C-INST-10) at the output level.
fn treasury_receives_lamp(
  outputs         : List<Output>,
  treasury_addr   : Address,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  lamp_paid       : Int,
) -> Bool {
  let lamp_at_treasury =
    list.foldl(outputs, 0, fn(o, acc) {
      if o.address == treasury_addr {
        acc + assets.quantity_of(o.value, lamp_policy_id, lamp_asset_name)  // "tLAMP"
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

// ═══════════════════════════════════════════════════════════════
// Tests — WithdrawLamp + UpdateProfile (PR #11 review pt5)
// Negatives use the `fail` annotation: test passes iff the body errors.
// ═══════════════════════════════════════════════════════════════

const t_owner: ByteArray =
  #"00000000000000000000000000000000000000000000000000000000"
const t_vault_hash: ByteArray =
  #"11111111111111111111111111111111111111111111111111111111"
const t_lamp_policy: ByteArray =
  #"22222222222222222222222222222222222222222222222222222222"
const t_lamp_name: ByteArray = #"744c414d50"   // "tLAMP" (tests only)
const t_tx_id: ByteArray =
  #"3333333333333333333333333333333333333333333333333333333333333333"

fn t_own_ref() -> OutputReference {
  OutputReference { transaction_id: t_tx_id, output_index: 0 }
}

fn t_holding(amount: Int, epoch: Int, locked: Bool) -> LoyaltyHolding {
  LoyaltyHolding { amount, acquired_epoch: epoch, is_locked: locked }
}

fn t_datum(balance: Int, locked: Int, holdings: List<LoyaltyHolding>) -> VaultDatum {
  VaultDatum {
    owner: t_owner,
    lamp_balance: balance,
    lamp_locked: locked,
    loyalty_holdings: holdings,
    magic_batches: [],
    next_batch_index: 0,
    vacuum_orders: [],
    gen_schedules: [],
    profile: Flame,
    profile_changed_epoch: 0,
    pending_profile: None,
    last_updated_epoch: 0,
    delegation_cert: DelegationCertificate {
      current: [], pending: None,
      current_effective_epoch: 0, last_changed_epoch: 0,
    },
    activity_state: ActivityState {
      recent_burn_epochs: [], total_burns_count: 0,
    },
    streak_state: StreakState { current_streak: 0, last_active_epoch: 0 },
    personal_delegate: None,
    attribution: VaultAttribution {
      attribution_root: #"", last_event_epoch: 0, total_events: 0,
    },
  }
}

fn t_vault_output(datum: VaultDatum, balance: Int) -> Output {
  Output {
    address: address.from_script(t_vault_hash),
    value: assets.from_asset(t_lamp_policy, #"744c414d50", balance),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn t_vault_input(datum: VaultDatum, balance: Int) -> Input {
  Input { output_reference: t_own_ref(), output: t_vault_output(datum, balance) }
}

fn t_tx(ins: List<Input>, outs: List<Output>, signers: List<ByteArray>) -> Transaction {
  Transaction { ..placeholder, inputs: ins, outputs: outs, extra_signatories: signers }
}

// ── WithdrawLamp ──────────────────────────────────────────────

test w_positive_partial() {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

test w_amount_zero() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(din, 100)], [t_owner])
  validate_withdraw_lamp(din, 0, 0, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

test w_over_avail() fail {
  let din = t_datum(100, 100, [t_holding(100, 5, True)])
  let dout = t_datum(95, 100, [t_holding(95, 5, True)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

test w_no_owner_sig() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

test w_phantom_second_output() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx =
    t_tx(
      [t_vault_input(din, 100)],
      [t_vault_output(dout, 95), t_vault_output(dout, 95)],
      [t_owner],
    )
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

test w_advance_last_updated_rejected() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout =
    VaultDatum {
      ..t_datum(95, 0, [t_holding(95, 5, False)]),
      last_updated_epoch: 5,
    }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// ── UpdateProfile ─────────────────────────────────────────────

fn up_output(din: VaultDatum, new_profile: ActivityProfile, current: Int) -> VaultDatum {
  VaultDatum {
    ..din,
    pending_profile: Some(PendingProfile { new_profile, effective_epoch: current + 1 }),
    profile_changed_epoch: current,
    last_updated_epoch: current,
  }
}

test up_positive() {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = up_output(din, Ember, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_update_profile(din, Ember, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

test up_cooldown_not_met() fail {
  let din =
    VaultDatum {
      ..t_datum(100, 0, [t_holding(100, 5, False)]),
      profile_changed_epoch: 10,
    }
  let dout = up_output(din, Ember, 11)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_update_profile(din, Ember, 11, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

test up_bypass_lazy() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = VaultDatum { ..up_output(din, Ember, 10), profile: Ember }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_update_profile(din, Ember, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

test up_same_profile() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = up_output(din, Flame, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_update_profile(din, Flame, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// ── ApplyHalving ──────────────────────────────────────────────

fn t_instant_batch(epoch_created: Int, amount: Int, halved: Bool) -> MagicBatch {
  MagicBatch {
    batch_id:            #"aabbcc",
    source:              Instant,
    created_epoch:       epoch_created,
    initial_amount:      amount,
    current_amount:      amount,
    decay_window:        2,
    profile_at_creation: None,
    contract_id:         None,
    halved:              halved,
  }
}

fn t_datum_with_batches(batches: List<MagicBatch>) -> VaultDatum {
  VaultDatum {
    ..t_datum(100, 0, [t_holding(100, 5, False)]),
    magic_batches: batches,
  }
}

// H-POS-1: batch at k=1 (not yet halved) — current_amount halves; halved=True
// last_updated_epoch PRESERVED (griefing fix): input=0 → output stays 0.
test ah_positive_halves_k1() {
  let batch_in  = t_instant_batch(9, 1000, False)   // created_epoch=9, current=10 → k=1
  let batch_out = MagicBatch { ..batch_in, current_amount: 500, halved: True }
  let din  = t_datum_with_batches([batch_in])
  let dout = t_datum_with_batches([batch_out])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_apply_halving(din, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// H-POS-2: batch at k=0 (fresh this epoch) — not halved, not pruned
test ah_positive_k0_unchanged() {
  let batch_in = t_instant_batch(10, 1000, False)   // created_epoch=10, current=10 → k=0
  let din  = t_datum_with_batches([batch_in])
  let dout = t_datum_with_batches([batch_in])   // last_updated_epoch preserved (0)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_apply_halving(din, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// H-POS-3: batch at k=2 (decay_window=2 → expired) — pruned from output
test ah_positive_expired_pruned() {
  let batch_in = t_instant_batch(8, 1000, True)   // created_epoch=8, current=10 → k=2 ≥ decay_window
  let din  = t_datum_with_batches([batch_in])
  let dout = t_datum_with_batches([])   // last_updated_epoch preserved (0)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_apply_halving(din, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// H-POS-4: permissionless — no signature required (empty signers)
test ah_positive_no_signature_needed() {
  let batch_in  = t_instant_batch(9, 800, False)
  let batch_out = MagicBatch { ..batch_in, current_amount: 400, halved: True }
  let din  = t_datum_with_batches([batch_in])
  let dout = t_datum_with_batches([batch_out])   // last_updated_epoch preserved (0)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  // Note: no signers — permissionless
  validate_apply_halving(din, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// H-NEG-1: output retains un-halved batch (should have been halved at k=1)
test ah_neg_halving_not_applied() fail {
  let batch_in = t_instant_batch(9, 1000, False)
  let din  = t_datum_with_batches([batch_in])
  // output keeps the un-halved batch — validator must reject
  let dout = t_datum_with_batches([batch_in])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_apply_halving(din, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// H-NEG-2: expired batch NOT pruned from output
test ah_neg_expired_not_pruned() fail {
  let batch_in = t_instant_batch(8, 500, True)   // k=2 → should be pruned
  let din  = t_datum_with_batches([batch_in])
  // output incorrectly keeps the expired batch
  let dout = t_datum_with_batches([batch_in])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_apply_halving(din, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// H-NEG-3: lamp_balance mutated during ApplyHalving
test ah_neg_lamp_balance_mutated() fail {
  let batch_in  = t_instant_batch(9, 1000, False)
  let batch_out = MagicBatch { ..batch_in, current_amount: 500, halved: True }
  let din = t_datum_with_batches([batch_in])
  // tamper: reduce lamp_balance by 10
  let dout = VaultDatum {
    ..t_datum_with_batches([batch_out]),
    lamp_balance: 90,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_apply_halving(din, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// H-NEG-4: GRIEFING — last_updated_epoch ADVANCED to current_epoch.
// ApplyHalving is permissionless; advancing last_updated_epoch would let a
// third party zero a victim's SnapshotGen catch-up window. The validator now
// requires last_updated_epoch PRESERVED, so an advanced value must be rejected.
test ah_neg_epoch_advanced_griefing() fail {
  let batch_in  = t_instant_batch(9, 1000, False)
  let batch_out = MagicBatch { ..batch_in, current_amount: 500, halved: True }
  let din  = t_datum_with_batches([batch_in])
  let dout = VaultDatum {
    ..t_datum_with_batches([batch_out]),
    last_updated_epoch: 10,   // advanced — must be rejected (griefing vector)
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_apply_halving(din, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// H-NEG-5: phantom second vault output
test ah_neg_phantom_second_output() fail {
  let batch_in  = t_instant_batch(9, 1000, False)
  let batch_out = MagicBatch { ..batch_in, current_amount: 500, halved: True }
  let din  = t_datum_with_batches([batch_in])
  let dout = t_datum_with_batches([batch_out])
  let tx =
    t_tx(
      [t_vault_input(din, 100)],
      [t_vault_output(dout, 100), t_vault_output(dout, 100)],
      [],
    )
  validate_apply_halving(din, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// H-POS-5: apply pending_profile when it fires (epoch 10 >= effective 10)
test ah_positive_applies_pending_profile() {
  let din_base = t_datum(100, 0, [t_holding(100, 5, False)])
  let din = VaultDatum {
    ..din_base,
    pending_profile: Some(PendingProfile { new_profile: Ember, effective_epoch: 10 }),
  }
  // After apply_pending_profile: profile=Ember, pending=None.
  // last_updated_epoch PRESERVED (input=0) — griefing fix.
  let dout = VaultDatum {
    ..din,
    profile:         Ember,
    pending_profile: None,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_apply_halving(din, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// ── BurnBatch — datum-consume (D1) ────────────────────────────

const t_delegate: ByteArray =
  #"44444444444444444444444444444444444444444444444444444444"

/// Batch with explicit id + current amount, source=Instant, k=0 at
/// current_epoch=10 (created_epoch=10 → not halved, not pruned by decay) so
/// the test isolates burn arithmetic from decay. initial_amount is fixed at
/// 1000 (immutable) so partial-burn expected outputs keep the same initial.
fn t_burn_batch(id: ByteArray, current: Int) -> MagicBatch {
  MagicBatch {
    batch_id:            id,
    source:              Instant,
    created_epoch:       10,
    initial_amount:      1000,
    current_amount:      current,
    decay_window:        2,
    profile_at_creation: None,
    contract_id:         None,
    halved:              False,
  }
}

/// Vault input/output datum carrying batches; attribution starts at total=0.
fn t_burn_din(batches: List<MagicBatch>, delegate: Option<ByteArray>) -> VaultDatum {
  VaultDatum {
    ..t_datum(100, 0, [t_holding(100, 5, False)]),
    magic_batches: batches,
    personal_delegate: delegate,
  }
}

/// Expected output datum after a burn: batches set, attribution incremented,
/// last_updated_epoch = current.
fn t_burn_dout(
  din: VaultDatum, out_batches: List<MagicBatch>, current: Int,
) -> VaultDatum {
  VaultDatum {
    ..din,
    magic_batches: out_batches,
    last_updated_epoch: current,
    attribution: VaultAttribution {
      attribution_root: #"",
      last_event_epoch: current,
      total_events: din.attribution.total_events + 1,
    },
  }
}

const bid_a: ByteArray = #"a1a1a1"
const bid_b: ByteArray = #"b2b2b2"

// BB-POS-1: partial burn of one batch (current 1000 → 600)
test bb_positive_partial() {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 600)], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 400)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-POS-2: full burn prunes the batch
test bb_positive_full_prunes() {
  let din = t_burn_din([t_burn_batch(bid_a, 1000), t_burn_batch(bid_b, 500)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_b, 500)], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 1000)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-POS-3: multi-batch burn in one tx
test bb_positive_multi() {
  let din = t_burn_din([t_burn_batch(bid_a, 1000), t_burn_batch(bid_b, 500)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700), t_burn_batch(bid_b, 200)], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 300), (bid_b, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-POS-4: consume-delegate (paymaster) can trigger burn; owner did NOT sign
test bb_positive_delegate_signs() {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate))
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-1: nobody authorized (no owner, no delegate signature)
test bb_neg_no_auth() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-2: delegate not set but a stranger signs → reject
test bb_neg_stranger_no_delegate() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-3: over-burn (amount > current_amount) forbidden
test bb_neg_over_burn() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 1001)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-4: unknown batch_id
test bb_neg_unknown_id() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 1000)], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_b, 100)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-5: output forges a lower lamp_balance (value-leak) → reject
test bb_neg_lamp_balance_forged() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = VaultDatum {
    ..t_burn_dout(din, [t_burn_batch(bid_a, 700)], 10),
    lamp_balance: 50,   // datum claims 50 but value carries 100
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-6: value drained below claimed lamp_balance → reject
test bb_neg_value_drained() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 10)
  // output value carries only 60 LAMP while datum claims 100
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 60)], [t_owner])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-7: attribution not incremented → reject
test bb_neg_attribution_not_bumped() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = VaultDatum {
    ..din,
    magic_batches: [t_burn_batch(bid_a, 700)],
    last_updated_epoch: 10,
    // attribution left untouched (total_events not +1)
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-8: batch other field mutated (initial_amount tampered) → reject
test bb_neg_other_field_mutated() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let tampered = MagicBatch { ..t_burn_batch(bid_a, 700), initial_amount: 999 }
  let dout = t_burn_dout(din, [tampered], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// ── SetDelegate (D1) ──────────────────────────────────────────

// SD-POS-1: owner sets delegate from None → Some
test sd_positive_set() {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = VaultDatum {
    ..din,
    personal_delegate: Some(t_delegate),
    last_updated_epoch: 10,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_set_delegate(din, Some(t_delegate), 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// SD-POS-2: owner clears delegate Some → None
test sd_positive_clear() {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate))
  let dout = VaultDatum {
    ..din,
    personal_delegate: None,
    last_updated_epoch: 10,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_set_delegate(din, None, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// SD-NEG-1: owner did not sign → reject
test sd_neg_no_owner_sig() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = VaultDatum {
    ..din,
    personal_delegate: Some(t_delegate),
    last_updated_epoch: 10,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_set_delegate(din, Some(t_delegate), 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// SD-NEG-2: delegate tries to set itself (not owner) → reject
test sd_neg_delegate_cannot_set() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate))
  let dout = VaultDatum {
    ..din,
    personal_delegate: Some(t_owner),
    last_updated_epoch: 10,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_set_delegate(din, Some(t_owner), 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// SD-NEG-3: output datum mutates MAGIC alongside delegate change → reject
test sd_neg_mutates_magic() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = VaultDatum {
    ..din,
    magic_batches: [t_burn_batch(bid_a, 500)],   // illicit MAGIC change
    personal_delegate: Some(t_delegate),
    last_updated_epoch: 10,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_set_delegate(din, Some(t_delegate), 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// SD-NEG-4: output delegate != redeemer new_delegate → reject
test sd_neg_delegate_mismatch() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = VaultDatum {
    ..din,
    personal_delegate: Some(t_owner),   // mismatch vs redeemer Some(t_delegate)
    last_updated_epoch: 10,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_set_delegate(din, Some(t_delegate), 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// ═══════════════════════════════════════════════════════════════
// Tests — VALUE preservation (MAINNET-BLOCK: ADA drain / token-set)
// and epoch monotonicity (MAINNET-BLOCK: validity-range gaming).
//
// `t_vault_output`/`t_vault_input` carry NO lovelace and exactly one policy
// (LAMP), so the default tests above satisfy validate_vault_value vacuously
// (0 >= 0, 1 ≤ 2). These tests use lovelace-carrying / extra-token outputs to
// exercise the new guard directly.
// ═══════════════════════════════════════════════════════════════

const t_other_policy: ByteArray =
  #"55555555555555555555555555555555555555555555555555555555"

/// Vault output with explicit lovelace + LAMP balance.
fn t_vault_output_ada(datum: VaultDatum, lovelace: Int, balance: Int) -> Output {
  Output {
    address: address.from_script(t_vault_hash),
    value: assets.from_lovelace(lovelace)
      |> assets.add(t_lamp_policy, #"744c414d50", balance),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn t_vault_input_ada(datum: VaultDatum, lovelace: Int, balance: Int) -> Input {
  Input { output_reference: t_own_ref(), output: t_vault_output_ada(datum, lovelace, balance) }
}

/// Vault output that smuggles an extra dust token under a 3rd policy.
fn t_vault_output_dust(datum: VaultDatum, lovelace: Int, balance: Int) -> Output {
  Output {
    address: address.from_script(t_vault_hash),
    value: assets.from_lovelace(lovelace)
      |> assets.add(t_lamp_policy, #"744c414d50", balance)
      |> assets.add(t_other_policy, #"6475737400", 1),  // "dust"
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

// VAL-POS-1: ApplyHalving preserves ADA (in 2 ADA, out 2 ADA) → ok.
test val_pos_ah_ada_preserved() {
  let batch_in  = t_instant_batch(9, 1000, False)
  let batch_out = MagicBatch { ..batch_in, current_amount: 500, halved: True }
  let din  = t_datum_with_batches([batch_in])
  let dout = t_datum_with_batches([batch_out])
  let tx =
    t_tx(
      [t_vault_input_ada(din, 2_000_000, 100)],
      [t_vault_output_ada(dout, 2_000_000, 100)],
      [],
    )
  validate_apply_halving(din, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// VAL-NEG-1: ApplyHalving (permissionless) drains ADA — out lovelace < in → reject.
test val_neg_ah_ada_drained() fail {
  let batch_in  = t_instant_batch(9, 1000, False)
  let batch_out = MagicBatch { ..batch_in, current_amount: 500, halved: True }
  let din  = t_datum_with_batches([batch_in])
  let dout = t_datum_with_batches([batch_out])
  let tx =
    t_tx(
      [t_vault_input_ada(din, 5_000_000, 100)],   // vault held 5 ADA
      [t_vault_output_ada(dout, 2_000_000, 100)], // attacker pockets 3 ADA
      [],
    )
  validate_apply_halving(din, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// VAL-NEG-2: ApplyHalving stuffs a 3rd-policy dust token (UTxO bloat) → reject.
test val_neg_ah_dust_stuffed() fail {
  let batch_in  = t_instant_batch(9, 1000, False)
  let batch_out = MagicBatch { ..batch_in, current_amount: 500, halved: True }
  let din  = t_datum_with_batches([batch_in])
  let dout = t_datum_with_batches([batch_out])
  let tx =
    t_tx(
      [t_vault_input_ada(din, 2_000_000, 100)],
      [t_vault_output_dust(dout, 2_000_000, 100)],  // 3 policies: ADA+LAMP+dust
      [],
    )
  validate_apply_halving(din, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// VAL-NEG-3: BurnBatch drains ADA on the delegate path → reject.
test val_neg_burn_ada_drained() fail {
  let din  = t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate))
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 10)
  let tx =
    t_tx(
      [t_vault_input_ada(din, 5_000_000, 100)],
      [t_vault_output_ada(dout, 2_000_000, 100)],
      [t_delegate],
    )
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// VAL-POS-2: ADA top-up (out > in) is allowed (honest min-ADA bump).
test val_pos_ada_topup_ok() {
  let din  = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 10)
  let tx =
    t_tx(
      [t_vault_input_ada(din, 2_000_000, 100)],
      [t_vault_output_ada(dout, 3_000_000, 100)],  // owner adds ADA — fine
      [t_owner],
    )
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// EPOCH-NEG-1: BurnBatch with current_epoch < last_updated_epoch (backwards
// time, delegate path) → reject by the monotonicity guard.
test epoch_neg_burn_backwards() fail {
  let din_base = t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate))
  // vault already at epoch 20; attacker claims epoch 10 to dodge decay.
  let din = VaultDatum { ..din_base, last_updated_epoch: 20 }
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// EPOCH-POS-1: get_current_epoch accepts a range inside ONE epoch and
// derives the right epoch.
test epoch_pos_range_in_one_epoch() {
  let p = 86_400_000   // Preview ms_per_epoch
  // epoch 10: [10*p, 11*p). lower=10*p, upper=11*p-1 → both in epoch 10.
  let tx =
    Transaction {
      ..placeholder,
      validity_range: interval.between(10 * p, 11 * p - 1),
    }
  get_current_epoch(tx, p) == 10
}

// EPOCH-NEG-2: upper_bound spills into the next epoch → reject (cannot pin
// a single epoch, so the caller could otherwise game which epoch is "current").
test epoch_neg_range_spans_two_epochs() fail {
  let p = 86_400_000
  let tx =
    Transaction {
      ..placeholder,
      validity_range: interval.between(10 * p, 11 * p),  // upper == 11*p → epoch 11
    }
  get_current_epoch(tx, p) == 10
}

// EPOCH-NEG-3: unbounded upper (no finite upper_bound) → reject.
test epoch_neg_unbounded_upper() fail {
  let p = 86_400_000
  let tx =
    Transaction {
      ..placeholder,
      validity_range: interval.after(10 * p),  // upper = +inf
    }
  get_current_epoch(tx, p) == 10
}
