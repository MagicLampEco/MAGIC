// validators/vault.ak — Vault validator (VacuumGen focus)
// Normative §10, C-VAC-1..12, C-VAC-FIRE-PERMISSION, C-VAC-PRUNE, C-VAC-FIRE-FULL-VAULT
// PlutusV3 / Aiken ≥ 1.1.x
//
// TWO-PHASE PROTOCOL:
//   Phase 1 — VacuumCommit: user signs, locks LAMP, adds VacuumOrder
//   Phase 2 — VacuumFire:   permissionless, transfers LAMP, creates batch (or M=0)

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
  Instant, MagicBatch, UMDatum, Vacuum, VacuumCommit, VacuumFire,
  VacuumOrder, VaultDatum, VaultRedeemer,
}
use magiclamp/protocol/constants.{
  max_batches_per_vault, max_vacuum_orders, min_vacuum_amount,
  vacuum_delay, vacuum_decay_window, q,
}
use magiclamp/protocol/math.{
  compute_vacuum_magic, compute_sm_q, get_um_for_vacuum, validate_um_range,
}
use magiclamp/protocol/lock.{
  select_lamp_for_lock, remove_locked_amount, l_avail, sum_holdings, sum_locked,
}

// ── Parameterized validator ───────────────────────────────────
validator vault(
  lamp_policy_id : PolicyId,
  treasury_addr  : Address,
  um_nft_policy  : PolicyId,
) {
  spend(
    datum_opt : Option<VaultDatum>,
    redeemer  : VaultRedeemer,
    own_ref   : OutputReference,
    ctx       : ScriptContext,
  ) {
    expect Some(input_datum) = datum_opt
    let tx            = ctx.transaction
    let current_epoch = get_current_epoch(tx)

    when redeemer is {
      VacuumCommit { lambda } ->
        validate_vacuum_commit(input_datum, lambda, current_epoch, own_ref, tx)

      VacuumFire { order_id } ->
        validate_vacuum_fire(input_datum, order_id, current_epoch, own_ref,
                             lamp_policy_id, treasury_addr, um_nft_policy, tx)

      _ -> fail @"unimplemented redeemer for VacuumGen module"
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Phase 1: VacuumCommit
// Constraints: C-VAC-1..5, C-VAULT-DS-1
// ═══════════════════════════════════════════════════════════════
fn validate_vacuum_commit(
  input_datum   : VaultDatum,
  lambda        : Int,              // oil to lock (λ)
  current_epoch : Int,
  own_ref       : OutputReference,
  tx            : Transaction,
) -> Bool {

  // ── C-VAULT-DS-1: one vault input ────────────────────────────
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

  // ── C-VAC-1: User signs ──────────────────────────────────────
  expect list.has(tx.extra_signatories, input_datum.owner)

  // ── C-VAC-3: λ ≥ 1 LAMP (10^6 oil) ─────────────────────────
  expect lambda >= min_vacuum_amount

  // ── C-VAC-2: λ ≤ L_avail ────────────────────────────────────
  let avail = l_avail(input_datum.lamp_balance, input_datum.lamp_locked)
  expect lambda <= avail

  // ── C-VAC-5: |orders| < 10 ───────────────────────────────────
  expect list.length(input_datum.vacuum_orders) < max_vacuum_orders

  // ── Build expected new order ──────────────────────────────────
  let order_id = compute_order_id(own_ref, current_epoch, lambda)
  let new_order = VacuumOrder {
    order_id,
    commit_epoch: current_epoch,
    fire_epoch:   current_epoch + vacuum_delay,   // C-VAC-4: = commit + 2
    lamp_amount:  lambda,
  }

  // ── Lock youngest holdings (T5, §6.8) ────────────────────────
  let new_holdings = select_lamp_for_lock(input_datum.loyalty_holdings, lambda)

  // ── A02: Output datum validation ─────────────────────────────
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  expect output_datum.owner == input_datum.owner
  expect output_datum.lamp_balance == input_datum.lamp_balance  // no transfer yet
  expect output_datum.lamp_locked  == input_datum.lamp_locked + lambda
  expect output_datum.loyalty_holdings == new_holdings
  expect output_datum.magic_batches == input_datum.magic_batches  // unchanged
  expect output_datum.next_batch_index == input_datum.next_batch_index
  expect output_datum.vacuum_orders == list.concat(input_datum.vacuum_orders, [new_order])
  expect output_datum.gen_schedules == input_datum.gen_schedules
  expect output_datum.profile == input_datum.profile
  expect output_datum.profile_changed_epoch == input_datum.profile_changed_epoch
  expect output_datum.pending_profile == input_datum.pending_profile
  expect output_datum.last_updated_epoch == current_epoch
  expect output_datum.delegation_cert == input_datum.delegation_cert
  expect output_datum.activity_state == input_datum.activity_state
  expect output_datum.streak_state == input_datum.streak_state
  expect output_datum.personal_delegate == input_datum.personal_delegate

  // C-VAULT-9: lamp_locked consistency
  let expected_locked = sum_locked(new_holdings)
  expect output_datum.lamp_locked == expected_locked  // includes λ just added

  // C-VAULT-10: Σholdings = lamp_balance
  expect sum_holdings(output_datum.loyalty_holdings) == output_datum.lamp_balance

  // C-VAC-12: No cancel redeemer exists — enforced by absence of cancel handler
  True
}

// ═══════════════════════════════════════════════════════════════
// Phase 2: VacuumFire
// Constraints: C-VAC-6..7, C-VAC-11, C-VAC-FIRE-PERMISSION,
//              C-VAC-PRUNE, C-VAC-FIRE-FULL-VAULT, INV-43
// ═══════════════════════════════════════════════════════════════
fn validate_vacuum_fire(
  input_datum    : VaultDatum,
  order_id       : ByteArray,
  current_epoch  : Int,
  own_ref        : OutputReference,
  lamp_policy_id : PolicyId,
  treasury_addr  : Address,
  um_nft_policy  : PolicyId,
  tx             : Transaction,
) -> Bool {

  let vault_addr = find_own_address(own_ref, tx.inputs)

  // ── C-VAULT-DS-1 ─────────────────────────────────────────────
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

  // ── C-VAC-FIRE-PERMISSION: NO owner signature required ────────
  // (any keeper or third party may trigger fire)

  // ── Find the specific order ───────────────────────────────────
  expect Some(order) = list.find(input_datum.vacuum_orders, fn(o) { o.order_id == order_id })

  // ── C-VAC-6: current_epoch = fire_epoch (EXACT match, not ≥) ─
  expect current_epoch == order.fire_epoch

  // ── Get UM (C-UM-7: always smoothed, no stale check) ─────────
  let um_datum = find_um_datum(tx.reference_inputs, um_nft_policy)
  expect validate_um_range(um_datum)
  let um_q = get_um_for_vacuum(um_datum)   // C-UM-7

  // ── SM from streak_state ──────────────────────────────────────
  let sm_q = compute_sm_q(input_datum.streak_state)

  // ── C-VAC-PRUNE: Force prune BEFORE batch count check ────────
  let pruned_batches = list.filter(input_datum.magic_batches, fn(b) {
    current_epoch - b.created_epoch < b.decay_window
  })

  // ── C-VAC-FIRE-FULL-VAULT: vault full after prune? ───────────
  let (expected_batches, batch_created) =
    if list.length(pruned_batches) < max_batches_per_vault {
      let m_v = compute_vacuum_magic(order.lamp_amount, um_q, sm_q)
      let batch_id = compute_batch_id(own_ref, input_datum.next_batch_index)
      let new_batch = MagicBatch {
        batch_id,
        source:              Vacuum,
        created_epoch:       current_epoch,
        initial_amount:      m_v,
        current_amount:      m_v,
        decay_window:        vacuum_decay_window,   // 1 (cliff)
        profile_at_creation: None,
        contract_id:         None,
        halved:              False,
      }
      (list.concat(pruned_batches, [new_batch]), True)
    } else {
      // C-VAC-FIRE-FULL-VAULT: M=0; order still removed; LAMP still transfers (INV-43)
      (pruned_batches, False)
    }

  // ── C-VAC-7 / INV-43: LAMP ALWAYS transfers (even M=0) ───────
  expect treasury_receives_lamp(tx.outputs, treasury_addr, lamp_policy_id, order.lamp_amount)

  // ── Remove order from list ────────────────────────────────────
  let remaining_orders = list.filter(input_datum.vacuum_orders, fn(o) { o.order_id != order_id })

  // ── Remove locked amount from holdings ───────────────────────
  let new_holdings = remove_locked_amount(input_datum.loyalty_holdings, order.lamp_amount)

  // ── A02: Output datum validation ─────────────────────────────
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  expect output_datum.owner == input_datum.owner
  expect output_datum.lamp_balance == input_datum.lamp_balance - order.lamp_amount
  expect output_datum.lamp_locked  == input_datum.lamp_locked  - order.lamp_amount
  expect output_datum.loyalty_holdings == new_holdings
  expect output_datum.magic_batches == expected_batches
  expect output_datum.vacuum_orders == remaining_orders
  expect output_datum.gen_schedules == input_datum.gen_schedules
  expect output_datum.profile == input_datum.profile
  expect output_datum.profile_changed_epoch == input_datum.profile_changed_epoch
  expect output_datum.pending_profile == input_datum.pending_profile
  expect output_datum.last_updated_epoch == current_epoch
  expect output_datum.delegation_cert == input_datum.delegation_cert
  expect output_datum.streak_state == input_datum.streak_state
  expect output_datum.personal_delegate == input_datum.personal_delegate

  // next_batch_index: increments only if batch was created
  if batch_created {
    expect output_datum.next_batch_index == input_datum.next_batch_index + 1
  } else {
    expect output_datum.next_batch_index == input_datum.next_batch_index
  }

  // C-VAULT-10
  expect sum_holdings(output_datum.loyalty_holdings) == output_datum.lamp_balance

  True
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

fn get_current_epoch(tx: Transaction) -> Int {
  expect Some(lower_slot) =
    tx.validity_range.lower_bound.bound_type |> get_finite_slot
  lower_slot / 432_000
}

fn get_finite_slot(bt: IntervalBoundType<Int>) -> Option<Int> {
  when bt is {
    Finite(s) -> Some(s)
    _ -> None
  }
}

fn find_own_address(own_ref: OutputReference, inputs: List<Input>) -> Address {
  expect Some(i) = list.find(inputs, fn(x) { x.output_reference == own_ref })
  i.output.address
}

fn find_vault_output_datum(outputs: List<Output>, vault_addr: Address) -> VaultDatum {
  expect Some(o) = list.find(outputs, fn(x) { x.address == vault_addr })
  expect InlineDatum(d) = o.datum
  expect datum: VaultDatum = d
  datum
}

fn find_um_datum(ref_inputs: List<Input>, um_nft_policy: PolicyId) -> UMDatum {
  expect Some(i) = list.find(ref_inputs, fn(x) {
    assets.quantity_of(x.output.value, um_nft_policy, #"554d44") > 0
  })
  expect InlineDatum(d) = i.output.datum
  expect um: UMDatum = d
  um
}

fn treasury_receives_lamp(
  outputs       : List<Output>,
  treasury_addr : Address,
  lamp_policy   : PolicyId,
  amount        : Int,
) -> Bool {
  let received = list.foldl(outputs, 0, fn(o, acc) {
    if o.address == treasury_addr {
      acc + assets.quantity_of(o.value, lamp_policy, #"4c414d50")
    } else { acc }
  })
  received >= amount
}

// batch_id = blake2b256(own_ref ∥ next_batch_index)
fn compute_batch_id(own_ref: OutputReference, index: Int) -> ByteArray {
  let OutputReference { transaction_id, output_index } = own_ref
  let preimage = bytearray.concat(
    bytearray.concat(transaction_id, bytearray.from_int_big_endian(output_index, 8)),
    bytearray.from_int_big_endian(index, 8),
  )
  crypto.blake2b_256(preimage)
}

// order_id = blake2b256(own_ref ∥ commit_epoch ∥ lambda)
fn compute_order_id(own_ref: OutputReference, commit_epoch: Int, lambda: Int) -> ByteArray {
  let OutputReference { transaction_id, output_index } = own_ref
  let preimage = bytearray.concat(
    bytearray.concat(transaction_id, bytearray.from_int_big_endian(output_index, 8)),
    bytearray.concat(
      bytearray.from_int_big_endian(commit_epoch, 8),
      bytearray.from_int_big_endian(lambda, 8),
    ),
  )
  crypto.blake2b_256(preimage)
}
