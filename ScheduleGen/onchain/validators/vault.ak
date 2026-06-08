// validators/vault.ak — Vault + Shard validators (ScheduleGen)
// Normative: §11, C-SCH-*, C-FIRE-*, C-SCH-FIRE-PERMISSION, C-SCH-FIRE-SHARD
// PlutusV3 / Aiken ≥ 1.1.x
//
// TWO-PHASE:
//   ScheduleCommit: user signs, locks L×λ, creates GenSchedule, updates shard
//   ScheduleFire:   permissionless, fires ≤8 orders, updates vault+shard+treasury

use aiken/collection/list
use aiken/interval.{Finite, IntervalBoundType}
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, placeholder,
}

use magiclamp/protocol/types.{
  ActivityState, BurnBatch, DelegationCertificate, Flame, GenSchedule,
  LoyaltyHolding, MagicBatch, Schedule, ScheduleAggregateShardDatum,
  ScheduleCommit, ScheduleFire, ShardRedeemer, ShardUpdateCommit, ShardUpdateFire,
  StreakState, VaultAttribution, VaultDatum, VaultRedeemer, WithdrawLamp,
}
use magiclamp/protocol/constants.{
  q, snapshot_base_rate_q, schedule_min_length, schedule_max_length,
  min_lamp_per_fire, schedule_delay, schedule_decay_window,
  max_fires_per_tx_catchup, max_gen_schedules, max_batches_per_vault,
  max_loyalty_holdings, shard_count,
}
use magiclamp/protocol/math.{
  compute_s_q, compute_rate_locked_q, compute_m_i,
  check_sch_rate, compute_shard_id, next_fire_epoch,
  compute_schedule_id, compute_batch_id,
}
use magiclamp/protocol/lock.{
  select_lamp_for_lock, remove_locked_amount, remove_newest_first,
  sum_holdings, l_avail,
}

// ══════════════════════════════════════════════════════════════
// Vault validator
// ══════════════════════════════════════════════════════════════
// `ms_per_epoch` is applied per-network (Plutus validity_range is POSIX ms):
//   Mainnet:        432_000_000
//   Preview/Preprod: 86_400_000
validator vault(
  lamp_policy_id    : PolicyId,
  treasury_addr     : Address,
  shard_policy_id   : PolicyId,  // identifies shard UTxOs by NFT
  ms_per_epoch      : Int,
) {
  spend(
    datum_opt : Option<VaultDatum>,
    redeemer  : VaultRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(datum) = datum_opt
    let current_epoch = get_epoch(tx, ms_per_epoch)
    let vault_addr    = own_addr(own_ref, tx.inputs)

    // C-VAULT-DS-1
    expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

    when redeemer is {
      ScheduleCommit { schedule_length, lamp_per_epoch } ->
        validate_commit(datum, schedule_length, lamp_per_epoch,
                        current_epoch, own_ref, vault_addr,
                        shard_policy_id, tx)

      ScheduleFire { schedule_id } ->
        validate_fire(datum, schedule_id, current_epoch, own_ref, vault_addr,
                      lamp_policy_id, treasury_addr, shard_policy_id, tx)

      // ── BurnBatch (stub) ─────────────────────────────────────
      BurnBatch { .. } -> {
        // v1.0 SECURITY LOCK (PR #11 review): BurnBatch (claim MAGIC) is
        // unimplemented. The old `expect owner_sign; True` stub let an
        // owner-signed spend rewrite the vault datum with NO output constraint
        // (LAMP-drain / state-forge vector). Lock until v1.1 wires ConsumeMAGIC
        // with full A02 + apply_pending_profile (SPEC_V1 §2).
        fail @"BurnBatch locked until v1.1 (ConsumeMAGIC)"
      }

      // ── WithdrawLamp (SPEC_V1 §1) ────────────────────────────
      WithdrawLamp { amount } ->
        validate_withdraw_lamp(datum, amount, current_epoch, vault_addr,
                               lamp_policy_id, tx)
    }
  }
}

// ══════════════════════════════════════════════════════════════
// Shard validator
// ══════════════════════════════════════════════════════════════
validator shard {
  spend(
    datum_opt : Option<ScheduleAggregateShardDatum>,
    redeemer  : ShardRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(shard_datum) = datum_opt
    let shard_addr = own_addr(own_ref, tx.inputs)
    let output_shard = find_shard_output(tx.outputs, shard_addr, shard_datum.shard_id)

    when redeemer is {
      ShardUpdateCommit { delta_locked, delta_committed } -> {
        expect output_shard.shard_locked_lamp  == shard_datum.shard_locked_lamp + delta_locked
        expect output_shard.shard_locked_lamp  <= shard_datum.shard_cap    // C-SCH-CAP (T13)
        expect output_shard.shard_active_count == shard_datum.shard_active_count + 1
        expect output_shard.shard_cumulative_committed == shard_datum.shard_cumulative_committed + delta_committed
        expect output_shard.shard_cumulative_fired == shard_datum.shard_cumulative_fired
        expect output_shard.shard_id  == shard_datum.shard_id
        expect output_shard.shard_cap == shard_datum.shard_cap
        True
      }

      ShardUpdateFire { fires_in_tx, lambda } -> {
        let delta = fires_in_tx * lambda
        expect output_shard.shard_locked_lamp     == shard_datum.shard_locked_lamp - delta
        expect output_shard.shard_cumulative_fired == shard_datum.shard_cumulative_fired + delta
        expect output_shard.shard_active_count     <= shard_datum.shard_active_count  // may decrement if schedule complete
        expect output_shard.shard_id  == shard_datum.shard_id
        expect output_shard.shard_cap == shard_datum.shard_cap
        True
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════
// validate_commit — C-SCH-1..12, C-SCH-CAP, C-SCH-AGG
// ══════════════════════════════════════════════════════════════
fn validate_commit(
  datum           : VaultDatum,
  l               : Int,             // schedule_length
  lambda          : Int,             // lamp_per_epoch (oil)
  current_epoch   : Int,
  own_ref         : OutputReference,
  vault_addr      : Address,
  shard_policy_id : PolicyId,
  tx              : Transaction,
) -> Bool {

  // C-VAC-1 equivalent: user signs
  expect list.has(tx.extra_signatories, datum.owner)

  // C-SCH-1: L ∈ [10,200]
  expect l >= schedule_min_length && l <= schedule_max_length

  // C-SCH-2: λ ≥ 1 LAMP
  expect lambda >= min_lamp_per_fire

  // C-SCH-3: L_avail ≥ L×λ
  let total_lock = l * lambda
  let avail = l_avail(datum.lamp_balance, datum.lamp_locked)
  expect total_lock <= avail

  // C-SCH-10: |gen_schedules| < 20
  expect list.length(datum.gen_schedules) < max_gen_schedules

  // Compute rate_locked_q from CURRENT R_snap (locked at commit — T8)
  let s_q           = compute_s_q(l)
  let rate_locked_q = compute_rate_locked_q(snapshot_base_rate_q, l)
  let m_i           = compute_m_i(lambda, rate_locked_q)

  // C-SCH-5 / C-SCH-RATE: λ × rate_locked_q ≥ Q → M_i ≥ 1 (T19)
  expect check_sch_rate(lambda, rate_locked_q)

  // C-SCH-CAP via shard UTxO: check shard.locked + L×λ ≤ shard_cap
  let shard_id_val = compute_shard_id(datum.owner)
  let shard_datum  = find_shard_input(tx.inputs, shard_policy_id, shard_id_val)
  expect shard_datum.shard_locked_lamp + total_lock <= shard_datum.shard_cap

  // Build new schedule
  let schedule_id = compute_schedule_id_from_ref(own_ref, list.length(datum.gen_schedules))
  let new_sched = GenSchedule {
    schedule_id,
    commit_epoch:           current_epoch,
    start_fire_epoch:       current_epoch + schedule_delay,   // C-SCH-7
    end_fire_epoch:         current_epoch + l + 1,
    schedule_length:        l,
    lamp_per_epoch:         lambda,
    rate_locked_q,          // T8: immutable from here
    baseline_at_commit_q:   snapshot_base_rate_q,   // C-SCH-11 audit
    multiplier_at_commit_q: s_q,                     // C-SCH-11 audit
    fired_count:            0,
    auto_burn_target:       None,
  }

  // Lock youngest-first (C-SCH-8, T5)
  let new_holdings = select_lamp_for_lock(datum.loyalty_holdings, total_lock)

  // A02: output datum
  let output = get_vault_output(tx.outputs, vault_addr)
  expect output.owner                 == datum.owner
  expect output.lamp_balance          == datum.lamp_balance         // no transfer yet
  expect output.lamp_locked           == datum.lamp_locked + total_lock  // C-SCH-9
  expect output.loyalty_holdings      == new_holdings
  expect output.magic_batches         == datum.magic_batches
  expect output.gen_schedules         == list.concat(datum.gen_schedules, [new_sched])
  expect output.profile               == datum.profile
  expect output.last_updated_epoch    == current_epoch
  expect sum_holdings(output.loyalty_holdings) == output.lamp_balance  // C-VAULT-10

  True
}

// ══════════════════════════════════════════════════════════════
// validate_fire — C-FIRE-1..8, C-SCH-FIRE-PERMISSION, C-SCH-FIRE-SHARD
// ══════════════════════════════════════════════════════════════
fn validate_fire(
  datum           : VaultDatum,
  schedule_id     : ByteArray,
  current_epoch   : Int,
  own_ref         : OutputReference,
  vault_addr      : Address,
  lamp_policy_id  : PolicyId,
  treasury_addr   : Address,
  shard_policy_id : PolicyId,
  tx              : Transaction,
) -> Bool {

  // C-SCH-FIRE-PERMISSION: NO owner signature required
  // (any keeper, user, or third party may trigger fire)

  // Find the schedule
  expect Some(sched) = list.find(datum.gen_schedules, fn(s) { s.schedule_id == schedule_id })

  // Compute fires_in_tx (C-FIRE-1 ≥ catch-up logic)
  // Count how many orders are eligible: e_i = start_fire_epoch + fired_count ≤ current_epoch
  let fires_in_tx = count_eligible_fires(sched, current_epoch, datum.magic_batches)
  expect fires_in_tx > 0   // at least one fire must occur

  // M_i for each fire (T-DET: all identical)
  let m_i = compute_m_i(sched.lamp_per_epoch, sched.rate_locked_q)

  // Total LAMP to transfer: fires_in_tx × λ
  let lamp_transfer = fires_in_tx * sched.lamp_per_epoch

  // C-FIRE-3: LAMP transfer atomic
  // Treasury must be a SCRIPT custody address (PR #11 review pt3) — a wallet
  // treasury_addr makes the `≥` aggregate check vacuously satisfiable.
  expect Script(_) = treasury_addr.payment_credential
  expect treasury_lamp_received(tx.outputs, treasury_addr, lamp_policy_id, lamp_transfer)

  // Create new batches (one per fire)
  let new_batches = create_fire_batches(own_ref, datum.next_batch_index,
                                         fires_in_tx, m_i, schedule_id, current_epoch)
  let updated_batches = list.concat(datum.magic_batches, new_batches)
  expect list.length(updated_batches) <= max_batches_per_vault

  // Update or remove schedule
  let new_fired = sched.fired_count + fires_in_tx
  let updated_schedules =
    if new_fired == sched.schedule_length {
      // C-FIRE-5: remove schedule when complete
      list.filter(datum.gen_schedules, fn(s) { s.schedule_id != schedule_id })
    } else {
      list.map(datum.gen_schedules, fn(s) {
        if s.schedule_id == schedule_id {
          GenSchedule { ..s, fired_count: new_fired }
        } else { s }
      })
    }

  // Remove locked amount (C-FIRE-6)
  let new_holdings = remove_locked_amount(datum.loyalty_holdings, lamp_transfer)

  // C-SCH-FIRE-SHARD: verify correct shard updated (A19)
  let shard_id_val = compute_shard_id(datum.owner)
  let shard_datum  = find_shard_input(tx.inputs, shard_policy_id, shard_id_val)
  expect shard_datum.shard_id == shard_id_val   // correct shard ✓

  // A02: output datum
  let output = get_vault_output(tx.outputs, vault_addr)
  expect output.owner              == datum.owner
  expect output.lamp_balance       == datum.lamp_balance - lamp_transfer
  expect output.lamp_locked        == datum.lamp_locked  - lamp_transfer
  expect output.loyalty_holdings   == new_holdings
  expect output.magic_batches      == updated_batches
  expect output.next_batch_index   == datum.next_batch_index + fires_in_tx
  expect output.gen_schedules      == updated_schedules
  expect output.profile            == datum.profile
  expect output.last_updated_epoch == current_epoch
  expect sum_holdings(output.loyalty_holdings) == output.lamp_balance

  True
}

// ── Count eligible fires (C-FIRE-1 ≥, MAX_FIRES_PER_TX_CATCHUP=8) ───
fn count_eligible_fires(
  sched         : GenSchedule,
  current_epoch : Int,
  batches       : List<MagicBatch>,
) -> Int {
  let remaining    = sched.schedule_length - sched.fired_count
  let batch_budget = max_batches_per_vault - list.length(batches)
  let eligible     = remaining
  // Count eligible orders: e_i ≤ current_epoch
  let max_by_time = count_by_time(sched.start_fire_epoch, sched.fired_count, current_epoch, 0)
  // Apply all caps
  min4(max_by_time, max_fires_per_tx_catchup, batch_budget, eligible)
}

fn count_by_time(start: Int, offset: Int, current: Int, acc: Int) -> Int {
  let e_i = start + offset + acc
  if e_i <= current && acc < max_fires_per_tx_catchup { count_by_time(start, offset, current, acc + 1) }
  else { acc }
}

fn min4(a: Int, b: Int, c: Int, d: Int) -> Int {
  let ab = if a < b { a } else { b }
  let cd = if c < d { c } else { d }
  if ab < cd { ab } else { cd }
}

// ── Create fire batches ───────────────────────────────────────
fn create_fire_batches(
  own_ref     : OutputReference,
  start_idx   : Int,
  count       : Int,
  m_i         : Int,
  schedule_id : ByteArray,
  epoch       : Int,
) -> List<MagicBatch> {
  create_batches_rec(own_ref, start_idx, count, m_i, schedule_id, epoch, [])
}

fn create_batches_rec(
  own_ref     : OutputReference,
  idx         : Int,
  remaining   : Int,
  m_i         : Int,
  schedule_id : ByteArray,
  epoch       : Int,
  acc         : List<MagicBatch>,
) -> List<MagicBatch> {
  if remaining <= 0 { acc }
  else {
    let tx_hash = own_ref.transaction_id
    let out_idx = own_ref.output_index
    let batch = MagicBatch {
      batch_id:            compute_batch_id(tx_hash, out_idx, idx),
      source:              Schedule,
      created_epoch:       epoch,
      initial_amount:      m_i,
      current_amount:      m_i,
      decay_window:        schedule_decay_window,   // 1 (cliff)
      profile_at_creation: None,
      contract_id:         Some(schedule_id),       // track which contract
      halved:              False,
    }
    create_batches_rec(own_ref, idx + 1, remaining - 1, m_i, schedule_id, epoch,
                       list.concat(acc, [batch]))
  }
}

// ── Helpers ───────────────────────────────────────────────────

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

fn own_addr(own_ref: OutputReference, inputs: List<Input>) -> Address {
  expect Some(i) = list.find(inputs, fn(x) { x.output_reference == own_ref })
  i.output.address
}

fn get_vault_output(outputs: List<Output>, vault_addr: Address) -> VaultDatum {
  let o = find_vault_output_raw(outputs, vault_addr)
  expect InlineDatum(d) = o.datum
  expect datum: VaultDatum = d
  datum
}

fn find_vault_output_raw(outputs: List<Output>, vault_addr: Address) -> Output {
  // C-VAULT-OUT-1 (PR #11 review): exactly one continuing vault output, symmetric
  // to the input==1 check. Blocks a phantom 2nd vault output carrying a forged datum.
  expect list.count(outputs, fn(x) { x.address == vault_addr }) == 1
  expect Some(o) = list.find(outputs, fn(x) { x.address == vault_addr })
  o
}

// ═══════════════════════════════════════════════════════════════
// validate_withdraw_lamp — W-1..W-7 (SPEC_V1 §1)
// ═══════════════════════════════════════════════════════════════
fn validate_withdraw_lamp(
  input_datum    : VaultDatum,
  amount         : Int,
  _current_epoch : Int,
  vault_addr     : Address,
  lamp_policy_id : PolicyId,
  tx             : Transaction,
) -> Bool {

  // W-1
  expect amount > 0
  // W-2
  expect list.has(tx.extra_signatories, input_datum.owner)
  // W-3
  let avail = l_avail(input_datum.lamp_balance, input_datum.lamp_locked)
  expect amount <= avail
  // W-4 — already enforced at top of validator (C-VAULT-DS-1)

  // W-5: A02 field-by-field
  let output_datum     = get_vault_output(tx.outputs, vault_addr)
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
  let vault_output = find_vault_output_raw(tx.outputs, vault_addr)
  let vault_lamp_qty =
    assets.quantity_of(vault_output.value, lamp_policy_id, #"4c414d50")
  expect vault_lamp_qty == new_lamp_balance

  // W-7: Σholdings == lamp_balance
  expect sum_holdings(output_datum.loyalty_holdings) == output_datum.lamp_balance

  expect list.length(output_datum.loyalty_holdings) <= max_loyalty_holdings

  True
}

fn find_shard_input(
  inputs          : List<Input>,
  shard_policy_id : PolicyId,
  shard_id        : Int,
) -> ScheduleAggregateShardDatum {
  // Find shard UTxO by NFT policy and shard_id datum field
  expect Some(i) = list.find(inputs, fn(x) {
    assets.quantity_of(x.output.value, shard_policy_id, #"5348415244") > 0  // "SHARD"
  })
  expect InlineDatum(d) = i.output.datum
  expect sd: ScheduleAggregateShardDatum = d
  expect sd.shard_id == shard_id
  sd
}

fn find_shard_output(
  outputs   : List<Output>,
  shard_addr: Address,
  shard_id  : Int,
) -> ScheduleAggregateShardDatum {
  expect Some(o) = list.find(outputs, fn(x) { x.address == shard_addr })
  expect InlineDatum(d) = o.datum
  expect sd: ScheduleAggregateShardDatum = d
  expect sd.shard_id == shard_id
  sd
}

fn treasury_lamp_received(
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

fn compute_schedule_id_from_ref(own_ref: OutputReference, index: Int) -> ByteArray {
  let tx_hash = own_ref.transaction_id
  let out_idx = own_ref.output_index
  compute_schedule_id(tx_hash, out_idx, index)
}

// ═══════════════════════════════════════════════════════════════
// Tests — WithdrawLamp (PR #11 review pt5). ScheduleGen has no UpdateProfile.
// Negatives use the `fail` annotation: test passes iff the body errors.
// validate_withdraw_lamp takes vault_addr directly (input==1 is enforced in
// the spend block, not the handler), so tests pass t_vault_addr().
// ═══════════════════════════════════════════════════════════════

const t_owner: ByteArray =
  #"00000000000000000000000000000000000000000000000000000000"
const t_vault_hash: ByteArray =
  #"11111111111111111111111111111111111111111111111111111111"
const t_lamp_policy: ByteArray =
  #"22222222222222222222222222222222222222222222222222222222"
const t_tx_id: ByteArray =
  #"3333333333333333333333333333333333333333333333333333333333333333"

fn t_vault_addr() -> Address {
  address.from_script(t_vault_hash)
}

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
    address: t_vault_addr(),
    value: assets.from_asset(t_lamp_policy, #"4c414d50", balance),
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
  validate_withdraw_lamp(din, 5, 0, t_vault_addr(), t_lamp_policy, tx)
}

test w_amount_zero() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(din, 100)], [t_owner])
  validate_withdraw_lamp(din, 0, 0, t_vault_addr(), t_lamp_policy, tx)
}

test w_over_avail() fail {
  let din = t_datum(100, 100, [t_holding(100, 5, True)])
  let dout = t_datum(95, 100, [t_holding(95, 5, True)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner])
  validate_withdraw_lamp(din, 5, 0, t_vault_addr(), t_lamp_policy, tx)
}

test w_no_owner_sig() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [])
  validate_withdraw_lamp(din, 5, 0, t_vault_addr(), t_lamp_policy, tx)
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
  validate_withdraw_lamp(din, 5, 0, t_vault_addr(), t_lamp_policy, tx)
}

test w_advance_last_updated_rejected() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout =
    VaultDatum {
      ..t_datum(95, 0, [t_holding(95, 5, False)]),
      last_updated_epoch: 5,
    }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner])
  validate_withdraw_lamp(din, 5, 0, t_vault_addr(), t_lamp_policy, tx)
}
