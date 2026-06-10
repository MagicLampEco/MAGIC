// validators/vault.ak — Vault + Shard validators (ScheduleGen)
// Normative: §11, C-SCH-*, C-FIRE-*, C-SCH-FIRE-PERMISSION, C-SCH-FIRE-SHARD,
//            D1 (BurnBatch datum-consume), SetDelegate, value-preservation.
// PlutusV3 / Aiken ≥ 1.1.x
//
// TWO-PHASE:
//   ScheduleCommit: user signs, locks L×λ, creates GenSchedule, updates shard
//   ScheduleFire:   permissionless, fires ≤8 orders, updates vault+shard+treasury
//
// SHARD BIND (HIGH fix, option (c)): the VAULT is the SINGLE authority on the
// shard datum transition. validate_commit / validate_fire assert the full shard
// output delta (locked/active/cumulative + cap + immutable fields) against the
// real vault delta. The `shard` validator no longer re-derives the delta from a
// redeemer it cannot trust; it only proves a matching vault co-spends in the
// same tx (a VaultDatum input whose compute_shard_id(owner) == shard_id). This
// removes the value-leak where shard state could desync from vault state, and
// avoids a param hash-cycle (shard takes NO vault hash; vault takes only the
// shard NFT policy id).

use aiken/builtin
use aiken/collection/list
use aiken/interval.{Finite, IntervalBoundType}
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Spend, Transaction, placeholder,
}

use magiclamp/protocol/types.{
  ActivityState, BurnBatch, DelegationCertificate, Flame, GenSchedule,
  LoyaltyHolding, MagicBatch, Schedule, ScheduleAggregateShardDatum,
  ScheduleCommit, ScheduleFire, SetDelegate, ShardRedeemer, ShardUpdateCommit,
  ShardUpdateFire, StreakState, VaultAttribution, VaultDatum, VaultRedeemer,
  WithdrawLamp,
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

const lamp_asset_name: ByteArray = #"744c414d50"   // "tLAMP"
const shard_asset_name: ByteArray = #"5348415244"  // "SHARD"

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
                        lamp_policy_id, shard_policy_id, tx)

      ScheduleFire { schedule_id } ->
        validate_fire(datum, schedule_id, current_epoch, own_ref, vault_addr,
                      lamp_policy_id, treasury_addr, shard_policy_id, tx)

      // ── BurnBatch (D1 datum-consume) ─────────────────────────
      BurnBatch { burns } ->
        validate_burn_batch(datum, burns, current_epoch, vault_addr,
                            lamp_policy_id, tx)

      // ── WithdrawLamp (SPEC_V1 §1) ────────────────────────────
      WithdrawLamp { amount } ->
        validate_withdraw_lamp(datum, amount, current_epoch, vault_addr,
                               lamp_policy_id, tx)

      // ── SetDelegate: owner sets/changes consume-delegate ─────
      SetDelegate { new_delegate } ->
        validate_set_delegate(datum, new_delegate, current_epoch, vault_addr,
                              lamp_policy_id, tx)
    }
  }
}

// ══════════════════════════════════════════════════════════════
// Shard validator
// ══════════════════════════════════════════════════════════════
// The shard datum TRANSITION is enforced authoritatively by the vault
// (validate_commit / validate_fire). The shard validator only guarantees that
// it cannot be spent UNLESS a matching vault co-spends in the same tx — i.e. an
// input carrying a VaultDatum whose compute_shard_id(owner) == this shard_id.
// Without this, a shard could be spent standalone (no vault) and its aggregate
// state corrupted. The redeemer carries the intended delta purely as an audit
// hint; correctness is bound by the vault, not by trusting this redeemer.
validator shard(shard_policy_id_param: PolicyId) {
  spend(
    datum_opt : Option<ScheduleAggregateShardDatum>,
    _redeemer : ShardRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(shard_datum) = datum_opt
    let shard_addr = own_addr(own_ref, tx.inputs)

    // SHARD-DS-1: exactly one shard input + one shard output (this shard).
    expect list.count(tx.inputs,  fn(i) { i.output.address == shard_addr }) == 1
    let output_shard = find_shard_output(tx.outputs, shard_addr, shard_datum.shard_id)

    // SHARD-NFT: this UTxO must actually carry the shard NFT (anti-forgery).
    let own_input = own_input(own_ref, tx.inputs)
    expect assets.quantity_of(own_input.output.value, shard_policy_id_param, shard_asset_name) == 1
    expect assets.quantity_of(output_shard_value(tx.outputs, shard_addr), shard_policy_id_param, shard_asset_name) == 1

    // SHARD-COSPEND: a matching vault must co-spend in this tx UNDER
    // ScheduleCommit (constr 0) or ScheduleFire (constr 1). Find a vault input
    // whose datum's owner hashes to this shard_id AND whose Spend redeemer is
    // Commit/Fire. The vault validator (validate_commit / validate_fire) does
    // the authoritative delta check. Without the redeemer gate, a vault spent
    // under BurnBatch/WithdrawLamp/SetDelegate (which read NO shard) would
    // satisfy the co-spend and let the shard datum be rewritten arbitrarily.
    expect vault_cospend_matches(tx, shard_addr, shard_datum.shard_id)

    // shard_id and shard_cap are immutable (defense-in-depth; vault also checks).
    expect output_shard.shard_id  == shard_datum.shard_id
    expect output_shard.shard_cap == shard_datum.shard_cap
    True
  }
}

// ══════════════════════════════════════════════════════════════
// validate_commit — C-SCH-1..12, C-SCH-CAP, C-SCH-AGG, C-SCH-SHARD-BIND
// ══════════════════════════════════════════════════════════════
fn validate_commit(
  datum           : VaultDatum,
  l               : Int,             // schedule_length
  lambda          : Int,             // lamp_per_epoch (oil)
  current_epoch   : Int,
  own_ref         : OutputReference,
  vault_addr      : Address,
  lamp_policy_id  : PolicyId,
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

  // ── SHARD BIND (option c): vault is the authority ───────────
  // Find shard INPUT and OUTPUT (both carry the NFT, matched by shard_id), then
  // assert the FULL delta against the real lock amount. C-SCH-CAP enforced here.
  let shard_id_val = compute_shard_id(datum.owner)
  let shard_in  = find_shard_input(tx.inputs, shard_policy_id, shard_id_val)
  let shard_out = find_shard_output_by_policy(tx.outputs, shard_policy_id, shard_id_val)

  expect shard_out.shard_locked_lamp == shard_in.shard_locked_lamp + total_lock
  expect shard_out.shard_locked_lamp <= shard_in.shard_cap            // C-SCH-CAP (T13)
  expect shard_out.shard_active_count == shard_in.shard_active_count + 1
  expect shard_out.shard_cumulative_committed
       == shard_in.shard_cumulative_committed + total_lock
  expect shard_out.shard_cumulative_fired == shard_in.shard_cumulative_fired
  expect shard_out.shard_id  == shard_in.shard_id
  expect shard_out.shard_cap == shard_in.shard_cap
  expect shard_out.last_updated_epoch == current_epoch

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
  expect output.next_batch_index      == datum.next_batch_index
  expect output.vacuum_orders         == datum.vacuum_orders
  expect output.gen_schedules         == list.concat(datum.gen_schedules, [new_sched])
  expect output.profile               == datum.profile
  expect output.profile_changed_epoch == datum.profile_changed_epoch
  expect output.pending_profile       == datum.pending_profile
  expect output.delegation_cert       == datum.delegation_cert
  expect output.activity_state        == datum.activity_state
  expect output.streak_state          == datum.streak_state
  expect output.personal_delegate     == datum.personal_delegate
  expect output.attribution           == datum.attribution
  expect output.last_updated_epoch    == current_epoch
  expect sum_holdings(output.loyalty_holdings) == output.lamp_balance  // C-VAULT-10

  // VALUE PRESERVATION: vault LAMP value == lamp_balance (commit moves no LAMP).
  expect vault_output_lamp_with(tx.outputs, vault_addr, lamp_policy_id) == output.lamp_balance

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
  let fires_in_tx = count_eligible_fires(sched, current_epoch, datum.magic_batches)
  expect fires_in_tx > 0   // at least one fire must occur

  // M_i for each fire (T-DET: all identical)
  let m_i = compute_m_i(sched.lamp_per_epoch, sched.rate_locked_q)

  // Total LAMP to transfer: fires_in_tx × λ
  let lamp_transfer = fires_in_tx * sched.lamp_per_epoch

  // C-FIRE-3: LAMP transfer atomic; treasury must be SCRIPT custody (PR #11 pt3)
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

  // ── SHARD BIND (option c): vault is the authority on the delta ──
  let shard_id_val = compute_shard_id(datum.owner)
  let shard_in  = find_shard_input(tx.inputs, shard_policy_id, shard_id_val)
  let shard_out = find_shard_output_by_policy(tx.outputs, shard_policy_id, shard_id_val)
  let schedule_completes = new_fired == sched.schedule_length

  expect shard_out.shard_id == shard_id_val                          // correct shard ✓
  expect shard_out.shard_locked_lamp == shard_in.shard_locked_lamp - lamp_transfer
  expect shard_out.shard_cumulative_fired
       == shard_in.shard_cumulative_fired + lamp_transfer
  // active_count decrements iff schedule just completed, else unchanged
  expect shard_out.shard_active_count
       == if schedule_completes { shard_in.shard_active_count - 1 }
          else { shard_in.shard_active_count }
  expect shard_out.shard_cumulative_committed == shard_in.shard_cumulative_committed
  expect shard_out.shard_cap == shard_in.shard_cap
  expect shard_out.last_updated_epoch == current_epoch

  // A02: output datum
  let output = get_vault_output(tx.outputs, vault_addr)
  expect output.owner              == datum.owner
  expect output.lamp_balance       == datum.lamp_balance - lamp_transfer
  expect output.lamp_locked        == datum.lamp_locked  - lamp_transfer
  expect output.loyalty_holdings   == new_holdings
  expect output.magic_batches      == updated_batches
  expect output.next_batch_index   == datum.next_batch_index + fires_in_tx
  expect output.vacuum_orders      == datum.vacuum_orders
  expect output.gen_schedules      == updated_schedules
  expect output.profile            == datum.profile
  expect output.profile_changed_epoch == datum.profile_changed_epoch
  expect output.pending_profile    == datum.pending_profile
  expect output.delegation_cert    == datum.delegation_cert
  expect output.activity_state     == datum.activity_state
  expect output.streak_state       == datum.streak_state
  expect output.personal_delegate  == datum.personal_delegate
  expect output.attribution        == datum.attribution
  expect output.last_updated_epoch == current_epoch
  expect sum_holdings(output.loyalty_holdings) == output.lamp_balance

  // VALUE PRESERVATION: vault LAMP value == new lamp_balance.
  expect vault_output_lamp_with(tx.outputs, vault_addr, lamp_policy_id) == output.lamp_balance

  True
}

// ══════════════════════════════════════════════════════════════
// validate_burn_batch — D1 datum-consume (MAGIC accounting, NO mint)
// ══════════════════════════════════════════════════════════════
// Burns reduce current_amount of targeted batches. `required` (the price) is
// bound by the ConsumeMAGIC validator co-spend (which reads this redeemer and
// the PriceParam beacon); the vault enforces ACCOUNTING correctness + auth +
// value preservation. total_burned is the sum of the burns; over-burn is
// FORBIDDEN in the accounting model (would destroy user MAGIC for free).
fn validate_burn_batch(
  input_datum    : VaultDatum,
  burns          : List<(ByteArray, Int)>,
  current_epoch  : Int,
  vault_addr     : Address,
  lamp_policy_id : PolicyId,
  tx             : Transaction,
) -> Bool {

  // ── AUTH: owner OR consume-delegate (personal_delegate) signs ──
  let authed =
    list.has(tx.extra_signatories, input_datum.owner) || when input_datum.personal_delegate is {
      Some(d) -> list.has(tx.extra_signatories, d)
      None    -> False
    }
  expect authed

  // ── burns must be non-empty and each amount > 0 ──────────────
  expect list.length(burns) > 0

  // ── Apply burns to batches: reduce current_amount, prune zero ──
  let expected_batches = apply_burns(input_datum.magic_batches, burns)

  // ── A02: field-by-field output datum (17 fields) ─────────────
  let output_datum = get_vault_output(tx.outputs, vault_addr)
  expect output_datum.owner                 == input_datum.owner
  expect output_datum.lamp_balance          == input_datum.lamp_balance   // BurnBatch ≠ LAMP
  expect output_datum.lamp_locked           == input_datum.lamp_locked
  expect output_datum.loyalty_holdings      == input_datum.loyalty_holdings
  expect output_datum.magic_batches         == expected_batches            // ← only MAGIC change
  expect output_datum.next_batch_index      == input_datum.next_batch_index
  expect output_datum.vacuum_orders         == input_datum.vacuum_orders
  expect output_datum.gen_schedules         == input_datum.gen_schedules
  expect output_datum.profile               == input_datum.profile
  expect output_datum.profile_changed_epoch == input_datum.profile_changed_epoch
  expect output_datum.pending_profile       == input_datum.pending_profile
  expect output_datum.delegation_cert       == input_datum.delegation_cert
  expect output_datum.activity_state        == input_datum.activity_state
  expect output_datum.streak_state          == input_datum.streak_state
  expect output_datum.personal_delegate     == input_datum.personal_delegate
  expect output_datum.last_updated_epoch    == current_epoch
  expect output_datum.attribution.attribution_root == input_datum.attribution.attribution_root
  expect output_datum.attribution.total_events     == input_datum.attribution.total_events + 1
  expect output_datum.attribution.last_event_epoch == current_epoch

  // ── VALUE PRESERVATION (anti value-leak) ─────────────────────
  expect vault_output_lamp_with(tx.outputs, vault_addr, lamp_policy_id) == output_datum.lamp_balance

  expect list.length(output_datum.magic_batches) <= max_batches_per_vault
  True
}

// apply_burns: for each (batch_id, amt): find exactly one matching batch,
// amt ∈ (0, current_amount]; set current_amount -= amt; prune at zero; all
// other fields immutable; order preserved for untouched batches.
fn apply_burns(
  batches : List<MagicBatch>,
  burns   : List<(ByteArray, Int)>,
) -> List<MagicBatch> {
  when burns is {
    [] -> batches
    [(bid, amt), ..rest] -> {
      expect amt > 0
      // exactly one batch with this id
      expect list.count(batches, fn(b) { b.batch_id == bid }) == 1
      let reduced =
        list.filter_map(batches, fn(b) {
          if b.batch_id == bid {
            expect amt <= b.current_amount
            let na = b.current_amount - amt
            if na == 0 { None }
            else { Some(MagicBatch { ..b, current_amount: na }) }
          } else {
            Some(b)
          }
        })
      apply_burns(reduced, rest)
    }
  }
}

// ══════════════════════════════════════════════════════════════
// validate_set_delegate — owner sets/changes consume-delegate
// ══════════════════════════════════════════════════════════════
fn validate_set_delegate(
  input_datum    : VaultDatum,
  new_delegate   : Option<ByteArray>,
  current_epoch  : Int,
  vault_addr     : Address,
  lamp_policy_id : PolicyId,
  tx             : Transaction,
) -> Bool {

  // ONLY owner may change the delegate (a delegate cannot re-delegate).
  expect list.has(tx.extra_signatories, input_datum.owner)

  let output_datum = get_vault_output(tx.outputs, vault_addr)

  // A02: every field unchanged EXCEPT personal_delegate + last_updated_epoch.
  expect output_datum.owner                 == input_datum.owner
  expect output_datum.lamp_balance          == input_datum.lamp_balance
  expect output_datum.lamp_locked           == input_datum.lamp_locked
  expect output_datum.loyalty_holdings      == input_datum.loyalty_holdings
  expect output_datum.magic_batches         == input_datum.magic_batches
  expect output_datum.next_batch_index      == input_datum.next_batch_index
  expect output_datum.vacuum_orders         == input_datum.vacuum_orders
  expect output_datum.gen_schedules         == input_datum.gen_schedules
  expect output_datum.profile               == input_datum.profile
  expect output_datum.profile_changed_epoch == input_datum.profile_changed_epoch
  expect output_datum.pending_profile       == input_datum.pending_profile
  expect output_datum.delegation_cert       == input_datum.delegation_cert
  expect output_datum.activity_state        == input_datum.activity_state
  expect output_datum.streak_state          == input_datum.streak_state
  expect output_datum.personal_delegate     == new_delegate              // ← the change
  expect output_datum.attribution           == input_datum.attribution
  expect output_datum.last_updated_epoch    == current_epoch

  // VALUE PRESERVATION: LAMP untouched.
  expect vault_output_lamp_with(tx.outputs, vault_addr, lamp_policy_id) == input_datum.lamp_balance

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
  let max_by_time = count_by_time(sched.start_fire_epoch, sched.fired_count, current_epoch, 0)
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

fn own_input(own_ref: OutputReference, inputs: List<Input>) -> Input {
  expect Some(i) = list.find(inputs, fn(x) { x.output_reference == own_ref })
  i
}

fn get_vault_output(outputs: List<Output>, vault_addr: Address) -> VaultDatum {
  let o = find_vault_output_raw(outputs, vault_addr)
  expect InlineDatum(d) = o.datum
  expect datum: VaultDatum = d
  datum
}

fn find_vault_output_raw(outputs: List<Output>, vault_addr: Address) -> Output {
  // C-VAULT-OUT-1: exactly one continuing vault output.
  expect list.count(outputs, fn(x) { x.address == vault_addr }) == 1
  expect Some(o) = list.find(outputs, fn(x) { x.address == vault_addr })
  o
}

fn vault_output_lamp_with(
  outputs        : List<Output>,
  vault_addr     : Address,
  lamp_policy_id : PolicyId,
) -> Int {
  let o = find_vault_output_raw(outputs, vault_addr)
  assets.quantity_of(o.value, lamp_policy_id, lamp_asset_name)
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
  // last_updated_epoch PRESERVED (PR #11 review pt4)
  expect output_datum.last_updated_epoch == input_datum.last_updated_epoch

  // W-6: vault output LAMP value
  let vault_output = find_vault_output_raw(tx.outputs, vault_addr)
  let vault_lamp_qty =
    assets.quantity_of(vault_output.value, lamp_policy_id, lamp_asset_name)
  expect vault_lamp_qty == new_lamp_balance

  // W-7: Σholdings == lamp_balance
  expect sum_holdings(output_datum.loyalty_holdings) == output_datum.lamp_balance

  expect list.length(output_datum.loyalty_holdings) <= max_loyalty_holdings

  True
}

// ── Shard helpers ─────────────────────────────────────────────

fn find_shard_input(
  inputs          : List<Input>,
  shard_policy_id : PolicyId,
  shard_id        : Int,
) -> ScheduleAggregateShardDatum {
  expect Some(i) = list.find(inputs, fn(x) {
    assets.quantity_of(x.output.value, shard_policy_id, shard_asset_name) > 0
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

fn output_shard_value(outputs: List<Output>, shard_addr: Address) -> assets.Value {
  expect Some(o) = list.find(outputs, fn(x) { x.address == shard_addr })
  o.value
}

// Find the continuing shard output by NFT policy + shard_id (vault-side check).
fn find_shard_output_by_policy(
  outputs         : List<Output>,
  shard_policy_id : PolicyId,
  shard_id        : Int,
) -> ScheduleAggregateShardDatum {
  expect Some(o) = list.find(outputs, fn(x) {
    assets.quantity_of(x.value, shard_policy_id, shard_asset_name) > 0
  })
  expect InlineDatum(d) = o.datum
  expect sd: ScheduleAggregateShardDatum = d
  expect sd.shard_id == shard_id
  sd
}

// Shard-side co-spend proof: there exists a vault input whose owner hashes to
// this shard_id AND that vault is spent under ScheduleCommit (constr 0) or
// ScheduleFire (constr 1). Only those two redeemers run the authoritative
// shard-delta check in the vault validator; BurnBatch/WithdrawLamp/SetDelegate
// touch no shard state, so co-spending the shard under one of them would let
// the shard datum be rewritten freely (HIGH authority-bypass). We decode the
// vault's Spend redeemer constructor index via builtin (no VaultRedeemer
// coupling needed — same approach as ConsumeMAGIC.read_vault_burns).
fn vault_cospend_matches(
  tx         : Transaction,
  shard_addr : Address,
  shard_id   : Int,
) -> Bool {
  list.any(tx.inputs, fn(i) {
    if i.output.address == shard_addr { False }
    else {
      when i.output.datum is {
        InlineDatum(d) ->
          when decode_vault(d) is {
            Some(vd) ->
              compute_shard_id(vd.owner) == shard_id && vault_redeemer_is_commit_or_fire(
                tx,
                i.output_reference,
              )
            None -> False
          }
        _ -> False
      }
    }
  })
}

// True iff the Spend redeemer for `vault_ref` is ScheduleCommit (constr 0) or
// ScheduleFire (constr 1). Fails closed: if no Spend redeemer is found for the
// ref, returns False.
fn vault_redeemer_is_commit_or_fire(
  tx        : Transaction,
  vault_ref : OutputReference,
) -> Bool {
  when
    list.find(tx.redeemers, fn(p) {
      let Pair(purpose, _) = p
      purpose == Spend(vault_ref)
    })
  is {
    Some(Pair(_, rd_data)) -> {
      let Pair(idx, _fields) = builtin.un_constr_data(rd_data)
      idx == 0 || idx == 1
    }
    None -> False
  }
}

fn decode_vault(d: Data) -> Option<VaultDatum> {
  if d is vd: VaultDatum { Some(vd) } else { None }
}

fn treasury_lamp_received(
  outputs       : List<Output>,
  treasury_addr : Address,
  lamp_policy   : PolicyId,
  amount        : Int,
) -> Bool {
  let received = list.foldl(outputs, 0, fn(o, acc) {
    if o.address == treasury_addr {
      acc + assets.quantity_of(o.value, lamp_policy, lamp_asset_name)
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
// Tests
// ═══════════════════════════════════════════════════════════════

const t_owner: ByteArray =
  #"00000000000000000000000000000000000000000000000000000000"
const t_delegate: ByteArray =
  #"99999999999999999999999999999999999999999999999999999999"
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

fn t_batch(id: ByteArray, amt: Int) -> MagicBatch {
  MagicBatch {
    batch_id:            id,
    source:              Schedule,
    created_epoch:       0,
    initial_amount:      amt,
    current_amount:      amt,
    decay_window:        1,
    profile_at_creation: None,
    contract_id:         None,
    halved:              False,
  }
}

// A batch whose current_amount has been reduced by a burn: initial_amount
// stays at the original (immutable), only current_amount drops to `cur`.
fn t_batch_reduced(id: ByteArray, initial: Int, cur: Int) -> MagicBatch {
  MagicBatch { ..t_batch(id, initial), current_amount: cur }
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
    value: assets.from_asset(t_lamp_policy, lamp_asset_name, balance),
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

// ── WithdrawLamp tests ────────────────────────────────────────

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

// ── BurnBatch (D1) tests ──────────────────────────────────────

fn t_datum_b(batches: List<MagicBatch>) -> VaultDatum {
  VaultDatum { ..t_datum(100, 0, [t_holding(100, 5, False)]), magic_batches: batches }
}

fn t_out_b(batches: List<MagicBatch>, total_events: Int, epoch: Int) -> VaultDatum {
  let base = t_datum_b(batches)
  VaultDatum {
    ..base,
    last_updated_epoch: epoch,
    attribution: VaultAttribution {
      attribution_root: #"", last_event_epoch: epoch, total_events,
    },
  }
}

test bb_partial_reduce() {
  let din = t_datum_b([t_batch(#"aa", 100), t_batch(#"bb", 50)])
  let dout = t_out_b([t_batch_reduced(#"aa", 100, 60), t_batch(#"bb", 50)], 1, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 40)], 7, t_vault_addr(), t_lamp_policy, tx)
}

test bb_full_prune() {
  let din = t_datum_b([t_batch(#"aa", 100), t_batch(#"bb", 50)])
  let dout = t_out_b([t_batch(#"bb", 50)], 1, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 100)], 7, t_vault_addr(), t_lamp_policy, tx)
}

test bb_multi_burn() {
  let din = t_datum_b([t_batch(#"aa", 100), t_batch(#"bb", 50)])
  let dout = t_out_b([t_batch_reduced(#"aa", 100, 90), t_batch_reduced(#"bb", 50, 30)], 1, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 10), (#"bb", 20)], 7, t_vault_addr(), t_lamp_policy, tx)
}

test bb_delegate_can_burn() {
  let base = t_datum_b([t_batch(#"aa", 100)])
  let din  = VaultDatum { ..base, personal_delegate: Some(t_delegate) }
  let doutb = t_out_b([t_batch_reduced(#"aa", 100, 60)], 1, 7)
  let dout  = VaultDatum { ..doutb, personal_delegate: Some(t_delegate) }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_burn_batch(din, [(#"aa", 40)], 7, t_vault_addr(), t_lamp_policy, tx)
}

test bb_no_auth() fail {
  let din = t_datum_b([t_batch(#"aa", 100)])
  let dout = t_out_b([t_batch(#"aa", 60)], 1, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_burn_batch(din, [(#"aa", 40)], 7, t_vault_addr(), t_lamp_policy, tx)
}

test bb_over_burn() fail {
  // amount > current_amount → reject (cannot burn more than batch holds)
  let din = t_datum_b([t_batch(#"aa", 100)])
  let dout = t_out_b([], 1, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 150)], 7, t_vault_addr(), t_lamp_policy, tx)
}

test bb_zero_amount() fail {
  let din = t_datum_b([t_batch(#"aa", 100)])
  let dout = t_out_b([t_batch(#"aa", 100)], 1, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 0)], 7, t_vault_addr(), t_lamp_policy, tx)
}

test bb_empty_burns() fail {
  let din = t_datum_b([t_batch(#"aa", 100)])
  let dout = t_out_b([t_batch(#"aa", 100)], 1, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [], 7, t_vault_addr(), t_lamp_policy, tx)
}

test bb_lamp_leak_rejected() fail {
  // output datum claims lamp_balance 100 but only 80 LAMP in the output value
  let din = t_datum_b([t_batch(#"aa", 100)])
  let dout = t_out_b([t_batch_reduced(#"aa", 100, 60)], 1, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 80)], [t_owner])
  validate_burn_batch(din, [(#"aa", 40)], 7, t_vault_addr(), t_lamp_policy, tx)
}

test bb_attribution_not_incremented() fail {
  let din = t_datum_b([t_batch(#"aa", 100)])
  let dout = t_out_b([t_batch_reduced(#"aa", 100, 60)], 0, 7)   // total_events stayed 0
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 40)], 7, t_vault_addr(), t_lamp_policy, tx)
}

// ── SetDelegate tests ─────────────────────────────────────────

test sd_set() {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout =
    VaultDatum { ..din, personal_delegate: Some(t_delegate), last_updated_epoch: 9 }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_set_delegate(din, Some(t_delegate), 9, t_vault_addr(), t_lamp_policy, tx)
}

test sd_clear() {
  let din =
    VaultDatum {
      ..t_datum(100, 0, [t_holding(100, 5, False)]),
      personal_delegate: Some(t_delegate),
    }
  let dout =
    VaultDatum { ..din, personal_delegate: None, last_updated_epoch: 9 }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_set_delegate(din, None, 9, t_vault_addr(), t_lamp_policy, tx)
}

test sd_only_owner() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout =
    VaultDatum { ..din, personal_delegate: Some(t_delegate), last_updated_epoch: 9 }
  // signed by the prospective delegate, NOT the owner → reject
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_set_delegate(din, Some(t_delegate), 9, t_vault_addr(), t_lamp_policy, tx)
}

test sd_no_other_field_change() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  // attacker also bumps lamp_balance while "setting delegate"
  let dout =
    VaultDatum {
      ..din,
      personal_delegate: Some(t_delegate),
      last_updated_epoch: 9,
      lamp_balance: 200,
    }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 200)], [t_owner])
  validate_set_delegate(din, Some(t_delegate), 9, t_vault_addr(), t_lamp_policy, tx)
}

// ── Shard co-spend redeemer-gate tests (HIGH authority-bypass fix) ─────
// vault_cospend_matches must accept a co-spending vault ONLY when that vault is
// spent under ScheduleCommit (constr 0) or ScheduleFire (constr 1). A vault
// co-spent under SetDelegate/WithdrawLamp/BurnBatch must NOT authorize a shard
// spend, else its aggregate datum could be rewritten with zero shard logic.

const t_shard_hash: ByteArray =
  #"44444444444444444444444444444444444444444444444444444444"

fn t_shard_addr() -> Address {
  address.from_script(t_shard_hash)
}

// A tx carrying one vault input (at t_own_ref) plus a single Spend redeemer for
// that vault with the given VaultRedeemer (coerced to the Data-typed Redeemer).
fn t_tx_redeemer(vault_datum: VaultDatum, rd: VaultRedeemer) -> Transaction {
  let vin = t_vault_input(vault_datum, 100)
  let rd_data: Data = rd
  Transaction {
    ..placeholder,
    inputs: [vin],
    redeemers: [Pair(Spend(t_own_ref()), rd_data)],
  }
}

// PASS: vault co-spends under ScheduleCommit (constr 0).
test shard_cospend_commit_ok() {
  let vd = t_datum(100, 0, [t_holding(100, 5, False)])
  let sid = compute_shard_id(vd.owner)
  let tx = t_tx_redeemer(vd, ScheduleCommit { schedule_length: 10, lamp_per_epoch: 1 })
  vault_cospend_matches(tx, t_shard_addr(), sid)
}

// PASS: vault co-spends under ScheduleFire (constr 1).
test shard_cospend_fire_ok() {
  let vd = t_datum(100, 0, [t_holding(100, 5, False)])
  let sid = compute_shard_id(vd.owner)
  let tx = t_tx_redeemer(vd, ScheduleFire { schedule_id: #"aa" })
  vault_cospend_matches(tx, t_shard_addr(), sid)
}

// FAIL: vault co-spends under SetDelegate (constr 4) — the exact authority
// bypass. Shard spend must NOT be authorized.
test shard_cospend_setdelegate_rejected() {
  let vd = t_datum(100, 0, [t_holding(100, 5, False)])
  let sid = compute_shard_id(vd.owner)
  let tx = t_tx_redeemer(vd, SetDelegate { new_delegate: Some(t_delegate) })
  !vault_cospend_matches(tx, t_shard_addr(), sid)
}

// FAIL: vault co-spends under WithdrawLamp (constr 3).
test shard_cospend_withdraw_rejected() {
  let vd = t_datum(100, 0, [t_holding(100, 5, False)])
  let sid = compute_shard_id(vd.owner)
  let tx = t_tx_redeemer(vd, WithdrawLamp { amount: 5 })
  !vault_cospend_matches(tx, t_shard_addr(), sid)
}

// FAIL: vault co-spends under BurnBatch (constr 2).
test shard_cospend_burnbatch_rejected() {
  let vd = t_datum(100, 0, [t_holding(100, 5, False)])
  let sid = compute_shard_id(vd.owner)
  let tx = t_tx_redeemer(vd, BurnBatch { burns: [(#"aa", 1)] })
  !vault_cospend_matches(tx, t_shard_addr(), sid)
}

// FAIL: matching vault input present but NO redeemer entry for it → fail-closed.
test shard_cospend_no_redeemer_rejected() {
  let vd = t_datum(100, 0, [t_holding(100, 5, False)])
  let sid = compute_shard_id(vd.owner)
  let tx = t_tx([t_vault_input(vd, 100)], [], [])
  !vault_cospend_matches(tx, t_shard_addr(), sid)
}
