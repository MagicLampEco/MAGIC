// validators/vault.ak — Vault + Shard validators (ScheduleGen)
// Normative: §11, C-SCH-*, C-FIRE-*, C-SCH-FIRE-PERMISSION, C-SCH-FIRE-SHARD,
//            D1 (BurnBatch datum-consume), SetDelegate, value-preservation.
// PlutusV3 / Aiken ≥ 1.1.x
//
// TWO-PHASE:
//   ScheduleCommit: user signs, locks L×λ, creates GenSchedule, updates shard
//   ScheduleFire:   permissionless, fires ≤8 orders, updates vault + shard
//
// PHA 2 — I-ACT-7 (LAMP ĐỨNG YÊN):
//   A fire no longer transfers LAMP to a Treasury. It only RELEASES the lock:
//   `lamp_balance` and the real LAMP inside the vault UTxO are byte-identical
//   across a fire; `lamp_locked` drops by fires×λ and the matching holdings
//   flip `is_locked` to False. The `treasury_addr` apply-parameter is gone —
//   no handler in this validator moves LAMP any more.
//
// PHA 2 — §4.2 per-epoch use-or-lose:
//   Every batch is a 1-epoch cliff. `apply_burns` refuses to burn a batch
//   outside its `created_epoch`, and dead batches are collected on the way out.
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
use aiken/cbor
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto
use aiken/interval.{Finite, IntervalBoundType}
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Spend, Transaction,
  placeholder,
}

use magiclamp/protocol/types.{
  ActivityState, BurnBatch, DelegationCertificate, Flame, GenSchedule,
  LoyaltyHolding, MagicBatch, Schedule, ScheduleAggregateShardDatum,
  ScheduleCommit, ScheduleFire, SetDelegate, ShardRedeemer,
  StreakState, VaultAttribution, VaultDatum, VaultRedeemer,
  WithdrawLamp,
}
use magiclamp/protocol/constants.{
  snapshot_base_rate_q, schedule_min_length, schedule_max_length,
  min_lamp_per_fire, schedule_delay, schedule_decay_window,
  max_fires_per_tx_catchup, max_gen_schedules, max_batches_per_vault,
  max_loyalty_holdings, shard_cap,
}
use magiclamp/protocol/math.{
  compute_s_q, compute_rate_locked_q, compute_m_i,
  check_sch_rate, compute_shard_id,
  compute_schedule_id, compute_batch_id, shard_asset_name,
}
use magiclamp/protocol/lock.{
  select_lamp_for_lock, unlock_locked_amount, remove_newest_first,
  sum_holdings, l_avail,
}

// LAMP native-asset name is now a VALIDATOR PARAMETER (`lamp_asset_name`), NOT a
// hardcoded literal — the asset name is a per-network PARAM (tLAMP testnet / LAMP
// mainnet), so it must never be baked as a constant.
//
// Shard NFT asset name is PER-SHARD: shard_asset_name(shard_id) from math.ak
// ("SHARD" ∥ byte(id)). Each shard carries a distinct one-shot NFT, so identity
// is bound by asset name, not by the self-declared `shard_id` datum field.

// ══════════════════════════════════════════════════════════════
// VAULT-IDENTITY STATE-THREAD NFT — genesis-clean anchor (MAINNET-BLOCK)
//
// THE HOLE: Cardano runs a validator only when a UTxO is SPENT, never when it is
// CREATED. The vault script address is public (= hash of this validator + params).
// An attacker parks a UTxO at the vault address with a FABRICATED inline datum
// (`gen_schedules` full of fake locks, `magic_batches` full of fake amounts,
// `consumed_credit = 10^18`, `owner = attacker`) and spends it via
// ScheduleCommit/ScheduleFire/BurnBatch to mint MAGIC (or pay a ConsumeMAGIC
// co-spend) from 100%-fabricated state. Nothing validated the datum at creation.
//
// THE FIX: a state-thread NFT whose ONLY way into existence runs the `mint`
// handler below — which PROVES the vault started clean — and whose presence is
// REQUIRED on every spend (`validate_vault_value`). A fabricated vault (no NFT)
// cannot be spent by ANY handler.
//
// WHY MULTI-PURPOSE (spend + mint in ONE validator): the mint policy must bind
// the genesis NFT to THIS vault's script address (else an attacker mints a clean
// NFT to a wallet, then in a plain tx re-homes it to the vault address with a
// DIRTY datum — no script runs on that creation, reopening the hole). Binding
// needs the vault hash inside the mint policy while the spend side needs the mint
// policy id — a MUTUAL apply-param fixed point (`vault_hash = H(…,policy)`,
// `policy = H(…,vault_hash)`) that is undeployable. Folding the mint handler INTO
// the vault validator breaks the cycle: `policy_id (mint) == script_hash == the
// Script credential of the spend address`, all known via self-reference, no param,
// no cycle. The single script hash IS the vault_id policy id.
//
// NOTE — this is a DISTINCT anchor from the 16-shard NFT system: the shard NFT
// (shard_nft.ak) protects the shard aggregate UTxOs, NOT the vault. `vault_id_nft`
// protects the vault UTxO itself. The vault output carries {ADA, LAMP, vault_id
// NFT} — NEVER a shard NFT — so its policy-set is bounded at 3.
//
// The asset name is `blake2b_256(cbor.serialise(seed))` so each vault is a
// distinct N-instance one-shot (permissionless, unique per spent seed UTxO).
pub type VaultIdRedeemer {
  // Mint a fresh vault-identity NFT + park a genesis-clean vault UTxO.
  MintVaultId { seed: OutputReference }
  // Burn the NFT (qty < 0 only). A spend that also burns the NFT still fails
  // `validate_vault_value` (NFT must survive on the continuing output), so under
  // the current handler set the NFT is permanent. Kept for forward-compat.
  BurnVaultId
}

// ══════════════════════════════════════════════════════════════
// Vault validator
// ══════════════════════════════════════════════════════════════
// `ms_per_epoch` is applied per-network (Plutus validity_range is POSIX ms):
//   Mainnet:        432_000_000
//   Preview/Preprod: 86_400_000
validator vault(
  lamp_policy_id    : PolicyId,
  lamp_asset_name   : ByteArray,  // per-network PARAM (tLAMP testnet / LAMP mainnet)
  shard_policy_id   : PolicyId,   // identifies shard UTxOs by NFT
  ms_per_epoch      : Int,
) {
  // ── mint: vault-identity NFT policy (policy_id == this script hash) ──────
  mint(redeemer: VaultIdRedeemer, policy_id: PolicyId, tx: Transaction) {
    when redeemer is {
      MintVaultId { seed } ->
        validate_mint_vault_id(seed, policy_id, lamp_policy_id, lamp_asset_name, tx)
      BurnVaultId ->
        validate_burn_vault_id(policy_id, tx)
    }
  }

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
                        lamp_policy_id, lamp_asset_name, shard_policy_id, tx)

      ScheduleFire { schedule_id } ->
        validate_fire(datum, schedule_id, current_epoch, own_ref, vault_addr,
                      lamp_policy_id, lamp_asset_name, shard_policy_id, tx)

      // ── BurnBatch (D1 datum-consume) ─────────────────────────
      BurnBatch { burns } ->
        validate_burn_batch(datum, burns, current_epoch, vault_addr,
                            lamp_policy_id, lamp_asset_name, tx)

      // ── WithdrawLamp (SPEC_V1 §1) ────────────────────────────
      WithdrawLamp { amount } ->
        validate_withdraw_lamp(datum, amount, current_epoch, vault_addr,
                               lamp_policy_id, lamp_asset_name, tx)

      // ── SetDelegate: owner sets/changes consume-delegate ─────
      SetDelegate { new_delegate } ->
        validate_set_delegate(datum, new_delegate, current_epoch, vault_addr,
                              lamp_policy_id, lamp_asset_name, tx)
    }
  }

  // Any other script purpose fails closed.
  else(_) {
    fail
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
    let name = shard_asset_name(shard_datum.shard_id)

    // SHARD-DS-1: exactly one shard input at this address.
    expect list.count(tx.inputs,  fn(i) { i.output.address == shard_addr }) == 1

    // SHARD-OUT-1: exactly ONE output carries THIS shard's distinct NFT, so the
    // aggregate state cannot be split/duplicated across outputs.
    expect
      list.count(tx.outputs, fn(o) {
        assets.quantity_of(o.value, shard_policy_id_param, name) == 1
      }) == 1
    let output_shard = find_shard_output_by_policy(tx.outputs, shard_policy_id_param, shard_datum.shard_id)

    // SHARD-NFT: this UTxO must actually carry THIS shard's NFT (anti-forgery,
    // bound by the distinct one-shot asset name).
    let own_input = own_input(own_ref, tx.inputs)
    expect assets.quantity_of(own_input.output.value, shard_policy_id_param, name) == 1

    // SHARD-NOMINT: no shard-policy token minted/burned (defence in depth).
    expect no_shard_mint(tx, shard_policy_id_param)

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
  lamp_asset_name : ByteArray,
  shard_policy_id : PolicyId,
  tx              : Transaction,
) -> Bool {

  // ── VAULT-IDENTITY NFT (MAINNET-BLOCK) — fail-fast on a fabricated vault ──
  // A UTxO parked at the vault address with a forged datum but NO vault_id NFT
  // dies here before any schedule/shard logic runs.
  expect validate_vault_value(
    find_vault_input_raw(tx.inputs, vault_addr),
    find_vault_output_raw(tx.outputs, vault_addr),
  )

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

  // C-SCH-5 / C-SCH-RATE: λ × rate_locked_q ≥ Q → M_i ≥ 1 (T19)
  expect check_sch_rate(lambda, rate_locked_q)

  // ── SHARD BIND (option c): vault is the authority ───────────
  // Find shard INPUT and OUTPUT (both carry the NFT, matched by shard_id), then
  // assert the FULL delta against the real lock amount. C-SCH-CAP enforced here.
  let shard_id_val = compute_shard_id(datum.owner)
  let shard_in  = find_shard_input(tx.inputs, shard_policy_id, shard_id_val)
  let shard_out = find_shard_output_by_policy(tx.outputs, shard_policy_id, shard_id_val)

  // No shard NFT may be minted/burned in a commit tx (defence in depth: the
  // one-shot policy already prevents re-mint, but the validator does not assume
  // it; this also blocks any spoofed companion token under the shard policy).
  expect no_shard_mint(tx, shard_policy_id)

  // C-SCH-CAP genesis-pin (T13): the shard cap is a Constitutional constant. Pin
  // it to the canonical value so a mis-deployed shard UTxO carrying an oversized
  // cap can never relax the participation ceiling.
  expect shard_in.shard_cap == shard_cap

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
  expect vault_output_lamp_with(tx.outputs, vault_addr, lamp_policy_id, lamp_asset_name) == output.lamp_balance

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
  lamp_asset_name : ByteArray,
  shard_policy_id : PolicyId,
  tx              : Transaction,
) -> Bool {

  // ── VAULT-IDENTITY NFT (MAINNET-BLOCK) — fail-fast on a fabricated vault ──
  // ScheduleFire is PERMISSIONLESS, so this is the sole gate stopping a forged
  // vault (no NFT) from being fired into fabricated MAGIC batches.
  expect validate_vault_value(
    find_vault_input_raw(tx.inputs, vault_addr),
    find_vault_output_raw(tx.outputs, vault_addr),
  )

  // C-SCH-FIRE-PERMISSION: NO owner signature required
  // (any keeper, user, or third party may trigger fire)

  // Find the schedule
  expect Some(sched) = list.find(datum.gen_schedules, fn(s) { s.schedule_id == schedule_id })

  // Compute fires_in_tx (C-FIRE-1 ≥ catch-up logic)
  let fires_in_tx = count_eligible_fires(sched, current_epoch, datum.magic_batches)
  expect fires_in_tx > 0   // at least one fire must occur

  // M_i for each fire (T-DET: all identical)
  let m_i = compute_m_i(sched.lamp_per_epoch, sched.rate_locked_q)

  // C-FIRE-3 (PHA 2): LAMP to RELEASE — fires_in_tx × λ leaves the locked pool
  // but stays in the vault. NOTHING is transferred anywhere (I-ACT-7).
  let lamp_released = fires_in_tx * sched.lamp_per_epoch

  // Create new batches (one per fire), then collect the dead ones (§4.2).
  // A catch-up fire of k orders stamps ALL k batches with the CURRENT epoch, so
  // they live for exactly this epoch — the catch-up cannot resurrect MAGIC the
  // owner failed to consume in earlier epochs.
  let new_batches = create_fire_batches(own_ref, datum.next_batch_index,
                                         fires_in_tx, m_i, schedule_id, current_epoch)
  let updated_batches =
    list.concat(prune_expired(datum.magic_batches, current_epoch), new_batches)
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

  // C-FIRE-6 (PHA 2): RELEASE the lock — holdings keep their amount, only
  // is_locked flips. Σholdings is invariant, so lamp_balance stays untouched.
  let new_holdings = unlock_locked_amount(datum.loyalty_holdings, lamp_released)

  // ── SHARD BIND (option c): vault is the authority on the delta ──
  let shard_id_val = compute_shard_id(datum.owner)
  let shard_in  = find_shard_input(tx.inputs, shard_policy_id, shard_id_val)
  let shard_out = find_shard_output_by_policy(tx.outputs, shard_policy_id, shard_id_val)
  let schedule_completes = new_fired == sched.schedule_length

  // No shard NFT minted/burned during a fire tx (defence in depth).
  expect no_shard_mint(tx, shard_policy_id)
  // C-SCH-CAP genesis-pin (T13): cap stays the Constitutional constant.
  expect shard_in.shard_cap == shard_cap

  expect shard_out.shard_id == shard_id_val                          // correct shard ✓
  expect shard_out.shard_locked_lamp == shard_in.shard_locked_lamp - lamp_released
  expect shard_out.shard_cumulative_fired
       == shard_in.shard_cumulative_fired + lamp_released
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
  // I-ACT-7: the balance does NOT move — only the lock is released.
  expect output.lamp_balance       == datum.lamp_balance
  expect output.lamp_locked        == datum.lamp_locked - lamp_released
  expect output.loyalty_holdings   == new_holdings
  expect list.length(output.loyalty_holdings) <= max_loyalty_holdings
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
  expect vault_output_lamp_with(tx.outputs, vault_addr, lamp_policy_id, lamp_asset_name) == output.lamp_balance

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
  input_datum     : VaultDatum,
  burns           : List<(ByteArray, Int)>,
  current_epoch   : Int,
  vault_addr      : Address,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {

  // ── VAULT-IDENTITY NFT (MAINNET-BLOCK) — fail-fast on a fabricated vault ──
  // The delegate path lets a non-owner call this; a forged vault (no NFT) full
  // of fabricated batches dies here before any consume accounting runs.
  expect validate_vault_value(
    find_vault_input_raw(tx.inputs, vault_addr),
    find_vault_output_raw(tx.outputs, vault_addr),
  )

  // ── AUTH: owner OR consume-delegate (personal_delegate) signs ──
  let authed =
    list.has(tx.extra_signatories, input_datum.owner) || when input_datum.personal_delegate is {
      Some(d) -> list.has(tx.extra_signatories, d)
      None    -> False
    }
  expect authed

  // ── burns must be non-empty and each amount > 0 ──────────────
  expect list.length(burns) > 0

  // ── Apply burns to LIVE batches, then collect the dead ────────
  // §4.2 use-or-lose: apply_burns rejects any burn aimed at a batch outside its
  // created_epoch; surviving dead batches are pruned so the output carries no
  // zero-value bytes.
  let burned = apply_burns(input_datum.magic_batches, burns, current_epoch)
  let expected_batches = prune_expired(burned, current_epoch)

  // ── §6.3 consumed accounting ──────────────────────────────────
  // Credit every consumed nanogic; InstantGen converts this into the reward
  // (INV-MAGIC-CITIZEN: reward keyed to MAGIC CONSUMED, never to MAGIC held).
  let total_burned = sum_burns(burns)
  expect total_burned > 0

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
  expect output_datum.activity_state ==
    ActivityState {
      ..input_datum.activity_state,
      consumed_credit: input_datum.activity_state.consumed_credit + total_burned,
    }
  expect output_datum.streak_state          == input_datum.streak_state
  expect output_datum.personal_delegate     == input_datum.personal_delegate
  expect output_datum.last_updated_epoch    == current_epoch
  expect output_datum.attribution.attribution_root == input_datum.attribution.attribution_root
  expect output_datum.attribution.total_events     == input_datum.attribution.total_events + 1
  expect output_datum.attribution.last_event_epoch == current_epoch

  // ── VALUE PRESERVATION (anti value-leak) ─────────────────────
  expect vault_output_lamp_with(tx.outputs, vault_addr, lamp_policy_id, lamp_asset_name) == output_datum.lamp_balance

  expect list.length(output_datum.magic_batches) <= max_batches_per_vault
  True
}

// apply_burns: for each (batch_id, amt): find exactly one matching batch, which
// must still be LIVE at current_epoch (§4.2 cliff — a batch outside its
// created_epoch is worth zero and may not be consumed); amt ∈ (0,
// current_amount]; set current_amount -= amt; prune at zero; all other fields
// immutable; order preserved for untouched batches.
fn apply_burns(
  batches       : List<MagicBatch>,
  burns         : List<(ByteArray, Int)>,
  current_epoch : Int,
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
            expect !is_expired(b, current_epoch)   // §4.2 dead batch → reject
            expect amt <= b.current_amount
            let na = b.current_amount - amt
            if na == 0 { None }
            else { Some(MagicBatch { ..b, current_amount: na }) }
          } else {
            Some(b)
          }
        })
      apply_burns(reduced, rest, current_epoch)
    }
  }
}

/// Σ of the burn amounts in a BurnBatch redeemer (nanogic actually consumed).
fn sum_burns(burns: List<(ByteArray, Int)>) -> Int {
  list.foldl(burns, 0, fn(b, acc) { let (_bid, amt) = b
    acc + amt })
}

// ── §4.2 batch liveness (cliff) ───────────────────────────────
//
// k = current_epoch − created_epoch ; k ≥ decay_window (= 1) ⟹ DEAD.

fn is_expired(batch: MagicBatch, current_epoch: Int) -> Bool {
  current_epoch - batch.created_epoch >= batch.decay_window
}

/// Drop every DEAD batch. Removes bytes only — a dead batch already counts as
/// zero, so pruning never changes any live value.
fn prune_expired(batches: List<MagicBatch>, current_epoch: Int) -> List<MagicBatch> {
  list.filter(batches, fn(b) { !is_expired(b, current_epoch) })
}

// ══════════════════════════════════════════════════════════════
// validate_set_delegate — owner sets/changes consume-delegate
// ══════════════════════════════════════════════════════════════
fn validate_set_delegate(
  input_datum     : VaultDatum,
  new_delegate    : Option<ByteArray>,
  current_epoch   : Int,
  vault_addr      : Address,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {

  // ── VAULT-IDENTITY NFT (MAINNET-BLOCK) — fail-fast on a fabricated vault ──
  expect validate_vault_value(
    find_vault_input_raw(tx.inputs, vault_addr),
    find_vault_output_raw(tx.outputs, vault_addr),
  )

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
  expect vault_output_lamp_with(tx.outputs, vault_addr, lamp_policy_id, lamp_asset_name) == input_datum.lamp_balance

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

// SEC-02: upper_bound constraint prevents epoch gaming.
// Reading lower_bound only lets an attacker set lower=start_of(E) with an
// open/infinite upper, get included at a real epoch E+k, yet have the
// validator believe current_epoch == E — enabling count_eligible_fires to
// count up to k extra fires and claim k× MAGIC in a single tx.
// Fix: require BOTH bounds Finite AND the tx to sit inside ONE epoch
// (e_lo == e_hi), so `current_epoch` is unambiguous. Mirrors VacuumGen.
fn get_epoch(tx: Transaction, ms_per_epoch: Int) -> Int {
  expect Some(lower_ms) =
    tx.validity_range.lower_bound.bound_type |> get_finite
  expect Some(upper_ms) =
    tx.validity_range.upper_bound.bound_type |> get_finite
  let e_lo = lower_ms / ms_per_epoch
  let e_hi = upper_ms / ms_per_epoch
  expect e_lo == e_hi
  e_lo
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

/// The single vault INPUT at `vault_addr` (used for the vault-identity value
/// check). The spend-level C-VAULT-DS-1 guarantees exactly one such input.
fn find_vault_input_raw(inputs: List<Input>, vault_addr: Address) -> Input {
  expect Some(i) = list.find(inputs, fn(x) { x.output.address == vault_addr })
  i
}

fn vault_output_lamp_with(
  outputs         : List<Output>,
  vault_addr      : Address,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
) -> Int {
  let o = find_vault_output_raw(outputs, vault_addr)
  assets.quantity_of(o.value, lamp_policy_id, lamp_asset_name)
}

// ═══════════════════════════════════════════════════════════════
// VAULT-IDENTITY value check + genesis mint policy (MAINNET-BLOCK)
// ═══════════════════════════════════════════════════════════════

/// VALUE-PRESERVATION guard shared by EVERY spend handler.
///   - VAULT-IDENTITY NFT: the spent input must carry EXACTLY one asset under the
///     vault_id policy (== this validator's own script hash, read from the input's
///     Script payment credential), and the continuing output must carry the SAME
///     (policy, name). A FABRICATED vault (no NFT — no policy ran to vet its datum)
///     fails at `single_nft_name`, so it cannot be spent by ANY handler.
///   - lovelace(out) >= lovelace(in)  → no surplus ADA siphoned (top-up allowed).
///   - |policies(out)| <= 3           → at most {ADA, LAMP, vault_id NFT}; the
///     vault NEVER carries a shard NFT, so any extra policy = dust-stuffing bloat,
///     rejected.
fn validate_vault_value(vault_input: Input, vault_output: Output) -> Bool {
  expect Script(vault_id_policy) = vault_input.output.address.payment_credential
  let nft_name = single_nft_name(vault_input.output.value, vault_id_policy)
  expect assets.quantity_of(vault_output.value, vault_id_policy, nft_name) == 1
  expect assets.lovelace_of(vault_output.value) >= assets.lovelace_of(vault_input.output.value)
  expect list.length(assets.policies(vault_output.value)) <= 3
  True
}

/// The single asset name held under `policy` in `value` (qty must be 1).
/// `expect`-fails if there is not EXACTLY one such token — a fabricated vault
/// carrying zero vault_id tokens is rejected right here.
fn single_nft_name(value: Value, policy: PolicyId) -> ByteArray {
  expect [Pair(name, qty)] = assets.tokens(value, policy) |> dict.to_pairs
  expect qty == 1
  name
}

/// validate_mint_vault_id — genesis-clean state-thread NFT mint.
/// Runs at MINT (the one moment a policy can enforce "this vault started clean").
/// Constrains EVERY VaultDatum field to its clean initial value and binds the
/// declared LAMP balance to the ACTUAL LAMP sitting in the parked output.
fn validate_mint_vault_id(
  seed            : OutputReference,
  policy_id       : PolicyId,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {

  // ── ONE-SHOT uniqueness: the exact seed UTxO must be spent here ──────────
  expect list.any(tx.inputs, fn(i) { i.output_reference == seed })

  // ── EXACTLY one asset under this policy, qty +1, name = H(seed) ──────────
  let own_tokens = assets.tokens(tx.mint, policy_id)
  expect dict.size(own_tokens) == 1
  let nft_name = crypto.blake2b_256(cbor.serialise(seed))
  expect assets.quantity_of(tx.mint, policy_id, nft_name) == 1

  // ── EXACTLY one output at THIS vault script address carrying the NFT ─────
  // policy_id == this validator's own script hash ⟹ Script(policy_id) is the
  // vault spend address. Binding the NFT here stops "mint clean → re-home dirty".
  let carriers =
    list.filter(tx.outputs, fn(o) {
      o.address.payment_credential == Script(policy_id) && assets.quantity_of(
        o.value,
        policy_id,
        nft_name,
      ) == 1
    })
  expect [vault_out] = carriers

  // ── Genesis datum must be inline + decode as a VaultDatum ────────────────
  expect InlineDatum(datum_data) = vault_out.datum
  expect vd: VaultDatum = datum_data

  // ── CLEAN genesis — constrain ALL 17 fields ─────────────────────────────
  // owner: a pkh the creator controls (present in signatories).
  expect list.has(tx.extra_signatories, vd.owner)

  // LAMP accounting bound to the REAL deposited LAMP (no over-claim).
  let lamp_qty = assets.quantity_of(vault_out.value, lamp_policy_id, lamp_asset_name)
  expect vd.lamp_balance == lamp_qty
  expect vd.lamp_locked == 0
  expect sum_holdings(vd.loyalty_holdings) == vd.lamp_balance
  expect list.all(vd.loyalty_holdings, fn(h) { !h.is_locked })
  expect list.length(vd.loyalty_holdings) <= max_loyalty_holdings

  // MAGIC / schedule / consumed state MUST be empty — the exact levers a forged
  // datum would fabricate (critic I2: consumed_credit is accumulated by BurnBatch
  // though unread today; pin it to 0 at genesis regardless).
  expect vd.magic_batches == []
  expect vd.next_batch_index == 0
  expect vd.vacuum_orders == []
  expect vd.gen_schedules == []
  expect vd.activity_state == ActivityState {
    recent_burn_epochs: [],
    consumed_credit: 0,
  }

  // Every other ledger empty/zeroed. profile NOT pinned: it is a user-chosen
  // STRATEGY (Ember/Flame/Lantern), not accumulated state — any of the 3 valid
  // enum values is a valid genesis strategy, so pinning gives no security benefit
  // and would reject vaults the standard off-chain flow creates (default Flame).
  expect vd.profile_changed_epoch == 0
  expect vd.pending_profile == None
  expect vd.last_updated_epoch == 0
  expect vd.delegation_cert == DelegationCertificate {
    current: [],
    pending: None,
    current_effective_epoch: 0,
    last_changed_epoch: 0,
  }
  expect vd.streak_state == StreakState {
    current_streak: 0,
    last_active_epoch: 0,
  }
  expect vd.personal_delegate == None
  expect vd.attribution == VaultAttribution {
    attribution_root: #"",
    last_event_epoch: 0,
    total_events: 0,
  }

  // ── No dust / shard NFT bundled into genesis: at most {ADA, LAMP, vault_id} ─
  expect list.length(assets.policies(vault_out.value)) <= 3

  True
}

/// Burn path: allowed only for NEGATIVE quantities under this policy. A spend
/// that also burns the NFT is still rejected by `validate_vault_value` (the NFT
/// must survive on the continuing output).
fn validate_burn_vault_id(policy_id: PolicyId, tx: Transaction) -> Bool {
  let own_tokens = assets.tokens(tx.mint, policy_id)
  expect
    list.all(dict.to_pairs(own_tokens), fn(p) {
      let Pair(_name, qty) = p
      qty < 0
    })
  True
}

// ═══════════════════════════════════════════════════════════════
// validate_withdraw_lamp — W-1..W-7 (SPEC_V1 §1)
// ═══════════════════════════════════════════════════════════════
fn validate_withdraw_lamp(
  input_datum     : VaultDatum,
  amount          : Int,
  _current_epoch  : Int,
  vault_addr      : Address,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {

  // ── VAULT-IDENTITY NFT (MAINNET-BLOCK) — fail-fast on a fabricated vault ──
  expect validate_vault_value(
    find_vault_input_raw(tx.inputs, vault_addr),
    find_vault_output_raw(tx.outputs, vault_addr),
  )

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
  // Identify the shard by its DISTINCT one-shot NFT asset name (anti-forgery),
  // not by a self-declared datum field.
  let name = shard_asset_name(shard_id)
  expect Some(i) = list.find(inputs, fn(x) {
    assets.quantity_of(x.output.value, shard_policy_id, name) == 1
  })
  expect InlineDatum(d) = i.output.datum
  expect sd: ScheduleAggregateShardDatum = d
  expect sd.shard_id == shard_id
  sd
}

// No token of the shard NFT policy is minted or burned in this tx. With the
// one-shot policy, minting is already impossible after genesis; this guard makes
// the vault/shard validators independent of that assumption and blocks any
// spoofed companion token under the shard policy id.
fn no_shard_mint(tx: Transaction, shard_policy_id: PolicyId) -> Bool {
  dict.is_empty(assets.tokens(tx.mint, shard_policy_id))
}

// Find the continuing shard output by NFT policy + per-shard asset name
// (vault-side check). Also asserts EXACTLY ONE output carries this shard's NFT,
// so the aggregate state cannot be split across two outputs.
fn find_shard_output_by_policy(
  outputs         : List<Output>,
  shard_policy_id : PolicyId,
  shard_id        : Int,
) -> ScheduleAggregateShardDatum {
  let name = shard_asset_name(shard_id)
  expect
    list.count(outputs, fn(x) {
      assets.quantity_of(x.value, shard_policy_id, name) == 1
    }) == 1
  expect Some(o) = list.find(outputs, fn(x) {
    assets.quantity_of(x.value, shard_policy_id, name) == 1
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

// NOTE: the former `treasury_lamp_received` helper is GONE. Under I-ACT-7 a
// fire releases the lock instead of transferring LAMP, so there is no Treasury
// leg and no `treasury_addr` apply-parameter left in this validator.

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
// LAMP asset name is now a validator PARAM; tests supply it explicitly.
const t_lamp_name: ByteArray = #"744c414d50"   // "tLAMP"
const t_shard_policy: ByteArray =
  #"55555555555555555555555555555555555555555555555555555555"
// vault_id NFT lives under the vault's OWN script hash (policy_id == script hash
// for this multi-purpose validator). Stand-in for blake2b_256(cbor.serialise(seed)).
const t_vault_id_name: ByteArray =
  #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

fn t_vault_addr() -> Address {
  address.from_script(t_vault_hash)
}

fn t_own_ref() -> OutputReference {
  OutputReference { transaction_id: t_tx_id, output_index: 0 }
}

fn t_holding(amount: Int, epoch: Int, locked: Bool) -> LoyaltyHolding {
  LoyaltyHolding { amount, acquired_epoch: epoch, is_locked: locked }
}

// Batches in the BurnBatch tests are created at epoch 7 — the same epoch the
// tests burn in — because §4.2 makes a batch live ONLY in its created_epoch.
const t_burn_epoch: Int = 7

fn t_batch(id: ByteArray, amt: Int) -> MagicBatch {
  MagicBatch {
    batch_id:            id,
    source:              Schedule,
    created_epoch:       t_burn_epoch,
    initial_amount:      amt,
    current_amount:      amt,
    decay_window:        schedule_decay_window,   // 1 (cliff)
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
      recent_burn_epochs: [], consumed_credit: 0,
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
    value: assets.from_asset(t_lamp_policy, t_lamp_name, balance)
      |> assets.add(t_vault_hash, t_vault_id_name, 1),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn t_vault_input(datum: VaultDatum, balance: Int) -> Input {
  Input { output_reference: t_own_ref(), output: t_vault_output(datum, balance) }
}

// Fabricated (NO-NFT) vault fixtures — the attacker's parked UTxO.
fn t_vault_output_nonft(datum: VaultDatum, balance: Int) -> Output {
  Output {
    address: t_vault_addr(),
    value: assets.from_asset(t_lamp_policy, t_lamp_name, balance),  // NO vault_id NFT
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn t_vault_input_nonft(datum: VaultDatum, balance: Int) -> Input {
  Input { output_reference: t_own_ref(), output: t_vault_output_nonft(datum, balance) }
}

fn t_tx(ins: List<Input>, outs: List<Output>, signers: List<ByteArray>) -> Transaction {
  Transaction { ..placeholder, inputs: ins, outputs: outs, extra_signatories: signers }
}

// ── WithdrawLamp tests ────────────────────────────────────────

test w_positive_partial() {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner])
  validate_withdraw_lamp(din, 5, 0, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

test w_amount_zero() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(din, 100)], [t_owner])
  validate_withdraw_lamp(din, 0, 0, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

test w_over_avail() fail {
  let din = t_datum(100, 100, [t_holding(100, 5, True)])
  let dout = t_datum(95, 100, [t_holding(95, 5, True)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner])
  validate_withdraw_lamp(din, 5, 0, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

test w_no_owner_sig() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [])
  validate_withdraw_lamp(din, 5, 0, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
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
  validate_withdraw_lamp(din, 5, 0, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

test w_advance_last_updated_rejected() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout =
    VaultDatum {
      ..t_datum(95, 0, [t_holding(95, 5, False)]),
      last_updated_epoch: 5,
    }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner])
  validate_withdraw_lamp(din, 5, 0, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

// ── BurnBatch (D1) tests ──────────────────────────────────────

fn t_datum_b(batches: List<MagicBatch>) -> VaultDatum {
  VaultDatum { ..t_datum(100, 0, [t_holding(100, 5, False)]), magic_batches: batches }
}

/// Expected output datum after a burn of `burned` nanogic at `epoch`.
fn t_out_b(
  batches: List<MagicBatch>, total_events: Int, burned: Int, epoch: Int,
) -> VaultDatum {
  let base = t_datum_b(batches)
  VaultDatum {
    ..base,
    last_updated_epoch: epoch,
    activity_state: ActivityState {
      ..base.activity_state,
      consumed_credit: base.activity_state.consumed_credit + burned,
    },
    attribution: VaultAttribution {
      attribution_root: #"", last_event_epoch: epoch, total_events,
    },
  }
}

test bb_partial_reduce() {
  let din = t_datum_b([t_batch(#"aa", 100), t_batch(#"bb", 50)])
  let dout = t_out_b([t_batch_reduced(#"aa", 100, 60), t_batch(#"bb", 50)], 1, 40, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 40)], 7, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

test bb_full_prune() {
  let din = t_datum_b([t_batch(#"aa", 100), t_batch(#"bb", 50)])
  let dout = t_out_b([t_batch(#"bb", 50)], 1, 100, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 100)], 7, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

test bb_multi_burn() {
  let din = t_datum_b([t_batch(#"aa", 100), t_batch(#"bb", 50)])
  let dout = t_out_b([t_batch_reduced(#"aa", 100, 90), t_batch_reduced(#"bb", 50, 30)], 1, 30, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 10), (#"bb", 20)], 7, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

test bb_delegate_can_burn() {
  let base = t_datum_b([t_batch(#"aa", 100)])
  let din  = VaultDatum { ..base, personal_delegate: Some(t_delegate) }
  let doutb = t_out_b([t_batch_reduced(#"aa", 100, 60)], 1, 40, 7)
  let dout  = VaultDatum { ..doutb, personal_delegate: Some(t_delegate) }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_burn_batch(din, [(#"aa", 40)], 7, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

// §4.2 CLIFF: a batch created at epoch 7 is DEAD at epoch 8 — burning it must
// be rejected, even though the datum still carries a non-zero current_amount.
test bb_dead_batch_rejected() fail {
  let din  = t_datum_b([t_batch(#"aa", 100)])            // created_epoch = 7
  let dout = t_out_b([], 1, 40, 8)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 40)], 8, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

// §4.2 GC: burning a live batch in the same tx also collects the dead ones.
test bb_dead_batch_collected() {
  let dead = MagicBatch { ..t_batch(#"cc", 999), created_epoch: 6 }
  let din  = t_datum_b([dead, t_batch(#"aa", 100)])
  let dout = t_out_b([t_batch_reduced(#"aa", 100, 60)], 1, 40, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 40)], 7, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

// consumed_credit must advance by exactly Σburns (§6.3 accounting hook).
test bb_consumed_credit_not_advanced() fail {
  let din = t_datum_b([t_batch(#"aa", 100)])
  let dout = t_out_b([t_batch_reduced(#"aa", 100, 60)], 1, 0, 7)   // credit stayed 0
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 40)], 7, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

test bb_consumed_credit_inflated() fail {
  let din = t_datum_b([t_batch(#"aa", 100)])
  let dout = t_out_b([t_batch_reduced(#"aa", 100, 60)], 1, 40_000, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 40)], 7, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

test bb_no_auth() fail {
  let din = t_datum_b([t_batch(#"aa", 100)])
  let dout = t_out_b([t_batch_reduced(#"aa", 100, 60)], 1, 40, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_burn_batch(din, [(#"aa", 40)], 7, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

test bb_over_burn() fail {
  // amount > current_amount → reject (cannot burn more than batch holds)
  let din = t_datum_b([t_batch(#"aa", 100)])
  let dout = t_out_b([], 1, 150, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 150)], 7, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

test bb_zero_amount() fail {
  let din = t_datum_b([t_batch(#"aa", 100)])
  let dout = t_out_b([t_batch(#"aa", 100)], 1, 0, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 0)], 7, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

test bb_empty_burns() fail {
  let din = t_datum_b([t_batch(#"aa", 100)])
  let dout = t_out_b([t_batch(#"aa", 100)], 1, 0, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [], 7, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

test bb_lamp_leak_rejected() fail {
  // output datum claims lamp_balance 100 but only 80 LAMP in the output value
  let din = t_datum_b([t_batch(#"aa", 100)])
  let dout = t_out_b([t_batch_reduced(#"aa", 100, 60)], 1, 40, 7)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 80)], [t_owner])
  validate_burn_batch(din, [(#"aa", 40)], 7, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

test bb_attribution_not_incremented() fail {
  let din = t_datum_b([t_batch(#"aa", 100)])
  let dout = t_out_b([t_batch_reduced(#"aa", 100, 60)], 0, 40, 7)   // total_events stayed 0
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 40)], 7, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

// ── unlock_locked_amount (I-ACT-7 fire release) ───────────────

// UL-1: a full release flips is_locked without changing any amount.
test ul_full_release_preserves_total() {
  let before = [t_holding(100, 5, True)]
  let after  = unlock_locked_amount(before, 100)
  after == [t_holding(100, 5, False)] && sum_holdings(after) == 100
}

// UL-2: a partial release splits the holding; Σamount is invariant.
test ul_partial_release_splits() {
  let before = [t_holding(100, 5, True)]
  let after  = unlock_locked_amount(before, 40)
  after == [t_holding(40, 5, False), t_holding(60, 5, True)]
    && sum_holdings(after) == 100
}

// UL-3: oldest-locked-first, already-unlocked holdings kept up front.
test ul_oldest_locked_first() {
  let before = [t_holding(10, 9, False), t_holding(30, 5, True), t_holding(20, 7, True)]
  let after  = unlock_locked_amount(before, 30)
  after == [t_holding(10, 9, False), t_holding(30, 5, False), t_holding(20, 7, True)]
    && sum_holdings(after) == 60
}

// UL-4 — THE BOUND (Nợ #30). Each partial release splits a holding and nothing
// is ever dropped, so without coalescing the list grew +1 per fire: 21 entries
// after 20 fires, ~201 after an L=200 schedule, against max_loyalty_holdings=64
// enforced by validate_fire. That freezes the user's LAMP outright — no fire, no
// withdraw. Every split inherits the original acquired_epoch, so the count must
// stay flat. Ported with coalesce_holdings from origin/main.
test ul_repeated_does_not_grow() {
  let h1 = unlock_locked_amount([t_holding(1000, 5, True)], 100)
  let h2 = unlock_locked_amount(h1, 100)
  let h3 = unlock_locked_amount(h2, 100)
  list.length(h3) == 2 && sum_holdings(h3) == 1000 && h3 == [
    t_holding(300, 5, False),
    t_holding(700, 5, True),
  ]
}

// UL-5: the opposite trap — distinct epochs must NOT be merged. acquired_epoch
// IS the loyalty age; collapsing two epochs into one would erase it.
test ul_keeps_distinct_epochs_apart() {
  let out = unlock_locked_amount([t_holding(50, 2, True), t_holding(50, 7, True)], 100)
  out == [t_holding(50, 2, False), t_holding(50, 7, False)]
}

// ── SetDelegate tests ─────────────────────────────────────────

test sd_set() {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout =
    VaultDatum { ..din, personal_delegate: Some(t_delegate), last_updated_epoch: 9 }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_set_delegate(din, Some(t_delegate), 9, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
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
  validate_set_delegate(din, None, 9, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

test sd_only_owner() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout =
    VaultDatum { ..din, personal_delegate: Some(t_delegate), last_updated_epoch: 9 }
  // signed by the prospective delegate, NOT the owner → reject
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_set_delegate(din, Some(t_delegate), 9, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
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
  validate_set_delegate(din, Some(t_delegate), 9, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
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

// ═══════════════════════════════════════════════════════════════
// Tests — VAULT-IDENTITY STATE-THREAD NFT (MAINNET-BLOCK)
//
// Closes the fabricated-datum hole: a UTxO parked at the vault script address
// with an attacker-authored inline datum but NO vault_id NFT can no longer be
// spent by any handler, and the mint policy forces a genesis-clean datum bound
// to the real deposited LAMP.
// ═══════════════════════════════════════════════════════════════

fn t_mint_seed() -> OutputReference {
  OutputReference { transaction_id: t_tx_id, output_index: 7 }
}

fn t_mint_name(seed: OutputReference) -> ByteArray {
  crypto.blake2b_256(cbor.serialise(seed))
}

fn t_seed_input(seed: OutputReference) -> Input {
  Input {
    output_reference: seed,
    output: Output {
      address: address.from_script(t_owner),
      value: assets.from_lovelace(2_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

/// Genesis output at Script(policy) carrying `balance` LAMP + the vault_id NFT.
fn t_genesis_output(vd: VaultDatum, balance: Int, policy: PolicyId, name: ByteArray) -> Output {
  Output {
    address: address.from_script(policy),
    value: assets.from_asset(t_lamp_policy, t_lamp_name, balance)
      |> assets.add(policy, name, 1),
    datum: InlineDatum(vd),
    reference_script: None,
  }
}

fn t_mint_tx(seed: OutputReference, out: Output, mint_v: Value, signers: List<ByteArray>) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: [t_seed_input(seed)],
    outputs: [out],
    mint: mint_v,
    extra_signatories: signers,
  }
}

fn t_mint_call(seed: OutputReference, policy_id: PolicyId, tx: Transaction) -> Bool {
  vault.mint(
    t_lamp_policy, t_lamp_name, t_shard_policy, 86_400_000,
    MintVaultId { seed }, policy_id, tx,
  )
}

/// Clean genesis datum (all fields at initial value); owner = t_owner, profile Flame.
fn t_clean_genesis(balance: Int) -> VaultDatum {
  t_datum(balance, 0, [t_holding(balance, 5, False)])
}

// ── mint_clean_genesis_ok: a correct clean mint passes ────────────────────
test mint_clean_genesis_ok() {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  let bal  = 100
  let vd   = t_clean_genesis(bal)
  let out  = t_genesis_output(vd, bal, t_vault_hash, name)
  let m    = assets.from_asset(t_vault_hash, name, 1)
  let tx   = t_mint_tx(seed, out, m, [t_owner])
  t_mint_call(seed, t_vault_hash, tx)
}

// ── poc_dirty_mint_rejected: dirty datum at mint → rejected ────────────────
// Non-empty magic_batches AND nonzero consumed_credit — the exact fabrication.
test poc_dirty_mint_rejected() fail {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  let bal  = 100
  let dirty =
    VaultDatum {
      ..t_clean_genesis(bal),
      magic_batches: [t_batch(#"aa", 1_000_000_000_000_000_000)],
      activity_state: ActivityState {
        recent_burn_epochs: [],
        consumed_credit: 1_000_000_000_000_000_000,
      },
    }
  let out = t_genesis_output(dirty, bal, t_vault_hash, name)
  let m   = assets.from_asset(t_vault_hash, name, 1)
  let tx  = t_mint_tx(seed, out, m, [t_owner])
  t_mint_call(seed, t_vault_hash, tx)
}

// ── mint: lamp_balance overclaimed vs actual LAMP in output → rejected ─────
test poc_dirty_mint_lamp_overclaim_rejected() fail {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  // datum claims 1000 LAMP but only 100 LAMP sits in the output.
  let vd  = t_clean_genesis(1000)
  let out = t_genesis_output(vd, 100, t_vault_hash, name)
  let m   = assets.from_asset(t_vault_hash, name, 1)
  let tx  = t_mint_tx(seed, out, m, [t_owner])
  t_mint_call(seed, t_vault_hash, tx)
}

// ── mint: genesis seed not spent → one-shot broken → rejected ──────────────
test mint_no_genesis_seed_rejected() fail {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  let bal  = 100
  let out  = t_genesis_output(t_clean_genesis(bal), bal, t_vault_hash, name)
  let m    = assets.from_asset(t_vault_hash, name, 1)
  let tx =
    Transaction {
      ..placeholder,
      inputs: [t_seed_input(OutputReference { transaction_id: t_tx_id, output_index: 99 })],
      outputs: [out],
      mint: m,
      extra_signatories: [t_owner],
    }
  t_mint_call(seed, t_vault_hash, tx)
}

// ── mint: qty != 1 (2 minted) → not a singleton → rejected ─────────────────
test mint_wrong_qty_rejected() fail {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  let bal  = 100
  let out  = t_genesis_output(t_clean_genesis(bal), bal, t_vault_hash, name)
  let m    = assets.from_asset(t_vault_hash, name, 2)
  let tx   = t_mint_tx(seed, out, m, [t_owner])
  t_mint_call(seed, t_vault_hash, tx)
}

// ── mint: owner not among signatories → rejected ───────────────────────────
test mint_owner_not_signed_rejected() fail {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  let bal  = 100
  let out  = t_genesis_output(t_clean_genesis(bal), bal, t_vault_hash, name)
  let m    = assets.from_asset(t_vault_hash, name, 1)
  let tx   = t_mint_tx(seed, out, m, [])     // nobody signs for the owner
  t_mint_call(seed, t_vault_hash, tx)
}

// ── POC: fabricated vault fired via ScheduleFire now FAILS ─────────────────
// Pre-fix, a UTxO parked at the vault address with fabricated magic_batches (or
// gen_schedules) could be fired/consumed into REAL MAGIC. Now the no-NFT input
// dies at validate_vault_value → single_nft_name before any schedule logic runs.
test poc_fabricated_magic_schedule_fails() fail {
  let fake = t_batch(#"aa", 1_000_000_000_000_000_000)   // fabricated 10^18
  let din  = t_datum_b([fake])
  let tx   =
    t_tx([t_vault_input_nonft(din, 100)], [t_vault_output_nonft(din, 100)], [t_owner])
  validate_fire(din, #"aa", 7, t_own_ref(), t_vault_addr(),
                t_lamp_policy, t_lamp_name, t_shard_policy, tx)
}

// ── POC: fabricated MAGIC batch burned via BurnBatch now FAILS ─────────────
test poc_fabricated_magic_burn_batch_fails() fail {
  let fake = t_batch(#"aa", 1_000_000_000_000_000_000)
  let din  = t_datum_b([fake])
  let tx   =
    t_tx([t_vault_input_nonft(din, 100)], [t_vault_output_nonft(din, 100)], [t_owner])
  validate_burn_batch(din, [(#"aa", 500)], 7, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

// ── spend_preserves_nft_ok: continuing output keeps the NFT → passes ───────
test spend_preserves_nft_ok() {
  let din  = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx   = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner])
  validate_withdraw_lamp(din, 5, 0, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}

// ── spend_drops_nft_fail: input has NFT, output drops it → rejected ────────
test spend_drops_nft_fail() fail {
  let din  = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx   = t_tx([t_vault_input(din, 100)], [t_vault_output_nonft(dout, 95)], [t_owner])
  validate_withdraw_lamp(din, 5, 0, t_vault_addr(), t_lamp_policy, t_lamp_name, tx)
}
