// validators/vault.ak — Vault + Shard validators (ScheduleGen)
// Normative: §11, C-SCH-*, C-FIRE-*, C-SCH-FIRE-PERMISSION, C-SCH-FIRE-SHARD
// PlutusV3 / Aiken ≥ 1.1.x
//
// TWO-PHASE:
//   ScheduleCommit: user signs, locks L×λ, creates GenSchedule, updates shard
//   ScheduleFire:   permissionless, fires ≤8 orders, updates vault+shard+treasury

use aiken/collection/list
use cardano/address.{Address}
use cardano/assets.{PolicyId}
use cardano/transaction.{
  Input, Output, OutputReference, ScriptContext, Transaction,
}

use magiclamp/schedulegen/lib/types.{
  MagicBatch, Schedule, GenSchedule, ScheduleAggregateShardDatum,
  VaultDatum, VaultRedeemer, ShardRedeemer,
}
use magiclamp/schedulegen/lib/constants.{
  q, snapshot_base_rate_q, schedule_min_length, schedule_max_length,
  min_lamp_per_fire, schedule_delay, schedule_decay_window,
  max_fires_per_tx_catchup, max_gen_schedules, max_batches_per_vault,
  shard_count,
}
use magiclamp/schedulegen/lib/math.{
  compute_s_q, compute_rate_locked_q, compute_m_i,
  check_sch_rate, compute_shard_id, next_fire_epoch,
  compute_schedule_id, compute_batch_id,
}
use magiclamp/schedulegen/lib/lock.{
  select_lamp_for_lock, remove_locked_amount, sum_holdings, l_avail,
}

// ══════════════════════════════════════════════════════════════
// Vault validator
// ══════════════════════════════════════════════════════════════
validator vault(
  lamp_policy_id    : PolicyId,
  treasury_addr     : Address,
  shard_policy_id   : PolicyId,  // identifies shard UTxOs by NFT
) {
  spend(
    datum_opt : Option<VaultDatum>,
    redeemer  : VaultRedeemer,
    own_ref   : OutputReference,
    ctx       : ScriptContext,
  ) {
    expect Some(datum) = datum_opt
    let tx            = ctx.transaction
    let current_epoch = get_epoch(tx)
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

      BurnBatch { .. } -> {
        expect list.has(tx.extra_signatories, datum.owner)
        True
      }
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
    ctx       : ScriptContext,
  ) {
    expect Some(shard_datum) = datum_opt
    let tx         = ctx.transaction
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

fn get_epoch(tx: Transaction) -> Int {
  expect Some(s) = tx.validity_range.lower_bound.bound_type |> get_finite
  s / 432_000
}

fn get_finite(bt: cardano/interval.IntervalBoundType<Int>) -> Option<Int> {
  when bt is { cardano/interval.Finite(s) -> Some(s) | _ -> None }
}

fn own_addr(own_ref: OutputReference, inputs: List<Input>) -> Address {
  expect Some(i) = list.find(inputs, fn(x) { x.output_reference == own_ref })
  i.output.address
}

fn get_vault_output(outputs: List<Output>, vault_addr: Address) -> VaultDatum {
  expect Some(o) = list.find(outputs, fn(x) { x.address == vault_addr })
  expect cardano/transaction.InlineDatum(d) = o.datum
  expect datum: VaultDatum = d
  datum
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
  expect cardano/transaction.InlineDatum(d) = i.output.datum
  expect shard: ScheduleAggregateShardDatum = d
  expect shard.shard_id == shard_id
  shard
}

fn find_shard_output(
  outputs   : List<Output>,
  shard_addr: Address,
  shard_id  : Int,
) -> ScheduleAggregateShardDatum {
  expect Some(o) = list.find(outputs, fn(x) { x.address == shard_addr })
  expect cardano/transaction.InlineDatum(d) = o.datum
  expect shard: ScheduleAggregateShardDatum = d
  expect shard.shard_id == shard_id
  shard
}

fn treasury_lamp_received(
  outputs       : List<Output>,
  treasury_addr : Address,
  lamp_policy   : PolicyId,
  amount        : Int,
) -> Bool {
  let received = list.foldl(outputs, 0, fn(acc, o) {
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
