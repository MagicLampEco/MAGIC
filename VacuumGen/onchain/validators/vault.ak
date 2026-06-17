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
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, placeholder,
}

use magiclamp/protocol/types.{
  ActivityState, DelegationCertificate, Flame, Instant, LoyaltyHolding,
  MagicBatch, StreakState, UMDatum, Vacuum, VacuumCommit, VacuumFire,
  VacuumOrder, VaultAttribution, VaultDatum, VaultRedeemer, WithdrawLamp,
}
use magiclamp/protocol/constants.{
  max_batches_per_vault, max_loyalty_holdings, max_vacuum_orders,
  min_vacuum_amount, vacuum_delay, vacuum_decay_window, q,
}
use magiclamp/protocol/math.{
  compute_vacuum_magic, compute_sm_q, get_um_for_vacuum, validate_um_range,
}
use magiclamp/protocol/lock.{
  select_lamp_for_lock, remove_locked_amount, remove_newest_first,
  l_avail, sum_holdings, sum_locked,
}

// ── Parameterized validator ───────────────────────────────────
// `ms_per_epoch` is applied per-network (Plutus validity_range is POSIX ms):
//   Mainnet:        432_000_000
//   Preview/Preprod: 86_400_000
validator vault(
  lamp_policy_id : PolicyId,
  lamp_asset_name: ByteArray,
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
    expect Some(input_datum) = datum_opt
    let current_epoch = get_current_epoch(tx, ms_per_epoch)

    when redeemer is {
      VacuumCommit { lambda } ->
        validate_vacuum_commit(input_datum, lambda, current_epoch, own_ref, tx)

      VacuumFire { order_id } ->
        validate_vacuum_fire(input_datum, order_id, current_epoch, own_ref,
                             lamp_policy_id, lamp_asset_name, treasury_addr,
                             um_nft_policy, tx)

      WithdrawLamp { amount } ->
        validate_withdraw_lamp(input_datum, amount, current_epoch, own_ref,
                               lamp_policy_id, lamp_asset_name, tx)

      // Other shared redeemers (InstantGen / ApplyHalving / BurnBatch /
      // UpdateProfile) are intentionally rejected by VacuumGen — those flows
      // live on their respective module's vault. Catch-all stays as a hard
      // anti-tamper guard.
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
  input_datum     : VaultDatum,
  order_id        : ByteArray,
  current_epoch   : Int,
  own_ref         : OutputReference,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  treasury_addr   : Address,
  um_nft_policy   : PolicyId,
  tx              : Transaction,
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
  // Treasury must be a SCRIPT custody address (PR #11 review pt3) — a wallet
  // treasury_addr makes the `≥` aggregate check vacuously satisfiable.
  expect Script(_) = treasury_addr.payment_credential
  expect treasury_receives_lamp(tx.outputs, treasury_addr, lamp_policy_id, lamp_asset_name, order.lamp_amount)

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
  expect output_datum.activity_state == input_datum.activity_state
  expect output_datum.streak_state == input_datum.streak_state
  expect output_datum.personal_delegate == input_datum.personal_delegate
  expect output_datum.attribution == input_datum.attribution

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

fn get_current_epoch(tx: Transaction, ms_per_epoch: Int) -> Int {
  expect Some(lower_ms) =
    tx.validity_range.lower_bound.bound_type |> get_finite_slot
  lower_ms / ms_per_epoch
}

fn get_finite_slot(bt: IntervalBoundType) -> Option<Int> {
  when bt is {
    Finite(s) -> Some(s)
    _ -> None
  }
}

fn find_own_address(own_ref: OutputReference, inputs: List<Input>) -> Address {
  expect Some(i) = list.find(inputs, fn(x) { x.output_reference == own_ref })
  i.output.address
}

fn find_vault_output(outputs: List<Output>, vault_addr: Address) -> Output {
  // C-VAULT-OUT-1 (PR #11 review): exactly one continuing vault output, symmetric
  // to the input==1 check. Blocks a phantom 2nd vault output carrying a forged datum.
  expect list.count(outputs, fn(x) { x.address == vault_addr }) == 1
  expect Some(o) = list.find(outputs, fn(x) { x.address == vault_addr })
  o
}

fn find_vault_output_datum(outputs: List<Output>, vault_addr: Address) -> VaultDatum {
  let o = find_vault_output(outputs, vault_addr)
  expect InlineDatum(d) = o.datum
  expect datum: VaultDatum = d
  datum
}

// ═══════════════════════════════════════════════════════════════
// validate_withdraw_lamp — W-1..W-7 (SPEC_V1 §1)
// ═══════════════════════════════════════════════════════════════
fn validate_withdraw_lamp(
  input_datum     : VaultDatum,
  amount          : Int,
  _current_epoch  : Int,
  own_ref         : OutputReference,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {

  // W-1
  expect amount > 0
  // W-2
  expect list.has(tx.extra_signatories, input_datum.owner)
  // W-3
  let avail = l_avail(input_datum.lamp_balance, input_datum.lamp_locked)
  expect amount <= avail
  // W-4
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

  // W-5: A02 field-by-field
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

  // W-6: vault output LAMP value
  let vault_output = find_vault_output(tx.outputs, vault_addr)
  let vault_lamp_qty =
    assets.quantity_of(vault_output.value, lamp_policy_id, lamp_asset_name)
  expect vault_lamp_qty == new_lamp_balance

  // W-7: Σholdings == lamp_balance
  expect sum_holdings(output_datum.loyalty_holdings) == output_datum.lamp_balance

  expect list.length(output_datum.loyalty_holdings) <= max_loyalty_holdings

  True
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
  outputs         : List<Output>,
  treasury_addr   : Address,
  lamp_policy     : PolicyId,
  lamp_asset_name : ByteArray,
  amount          : Int,
) -> Bool {
  let received = list.foldl(outputs, 0, fn(o, acc) {
    if o.address == treasury_addr {
      acc + assets.quantity_of(o.value, lamp_policy, lamp_asset_name)
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

// ═══════════════════════════════════════════════════════════════
// Tests — WithdrawLamp (PR #11 review pt5). VacuumGen has no UpdateProfile.
// Negatives use the `fail` annotation: test passes iff the body errors.
// ═══════════════════════════════════════════════════════════════

const t_owner: ByteArray =
  #"00000000000000000000000000000000000000000000000000000000"
const t_vault_hash: ByteArray =
  #"11111111111111111111111111111111111111111111111111111111"
const t_lamp_policy: ByteArray =
  #"22222222222222222222222222222222222222222222222222222222"
const t_lamp_name: ByteArray =
  #"744c414d50"
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
    value: assets.from_asset(t_lamp_policy, t_lamp_name, balance),
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
