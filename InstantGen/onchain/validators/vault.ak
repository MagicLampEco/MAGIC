// validators/vault.ak — Vault spending validator (InstantGen)
// Normative: SPEC/MagicLamp-Tripletoken-Feat-(Vi).md §4.2, §6.1, §6.3, §7, §12.
// PlutusV3 / Aiken ≥ 1.1.x
//
// MODEL (PHA 2 — three invariants that reshaped this file):
//   I-ACT-7      LAMP NEVER MOVES when MAGIC is generated. Holding LAMP only
//                opens eligibility; `lamp_balance`, `lamp_locked` and
//                `loyalty_holdings` are byte-identical across an InstantGen.
//                There is no Treasury leg any more.
//   §4.2 cliff   A MAGIC batch is live only inside its own `created_epoch`
//                (decay_window = 1). No halving, no carry-over.
//   §6.3 keyed   Grant size = min( reward(consumed), cap_surplus(br),
//                0.5 × pp_schedule ) — driven by MAGIC ALREADY CONSUMED,
//                not by any LAMP amount.
//
// Parameterized by:
//   lamp_policy_id      : PolicyId of LAMP native asset
//   um_nft_policy       : PolicyId of UM datum NFT (identifies the UM UTxO)
//   um_script_hash      : applied UMKeeper validator hash. Pins the UM reference
//                         input to the canonical UM script address; the NFT alone
//                         is not a global singleton, so without this a forged UTxO
//                         at an attacker address could be used as ref input.
//   backing_nft_policy  : PolicyId of the BackingBeacon NFT      [CẦN XÁC NHẬN]
//   backing_script_hash : script hash of the BackingBeacon UTxO  [CẦN XÁC NHẬN]
//                         Same two-layer pinning as UM. Deploy with an all-zero
//                         pair while CARP has not shipped the beacon: no UTxO can
//                         then satisfy the reference-input lookup, so InstantGen
//                         is SHUT (cap = 0). Never invent a default `br`.
//   ms_per_epoch        : POSIX ms per epoch (per-network)
//
// Build on testnet:
//   aiken build
//   # applies the 6 parameters, producing the script hash

use aiken/cbor
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto
use aiken/primitive/bytearray
use aiken/interval.{Finite}
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}

use magiclamp/protocol/types.{
  ActivityProfile, ActivityState, BackingBeaconDatum, BurnBatch,
  DelegationCertificate, Ember, Flame, GenSchedule, Instant, InstantGen, Lantern,
  LoyaltyHolding, MagicBatch, PendingProfile, PruneExpired, SetDelegate,
  StreakState, UMDatum, UpdateProfile, VaultAttribution, VaultDatum,
  VaultRedeemer, WithdrawLamp,
}
use magiclamp/protocol/constants.{
  magic_decay_window, max_backing_stale, max_batches_per_vault,
  max_loyalty_holdings, min_instant_holding, pm_q_ember, pm_q_flame,
  pm_q_lantern, profile_change_cooldown,
}
use magiclamp/protocol/math.{compute_instant_grant}
use magiclamp/protocol/decay.{count_expired, is_expired, prune_expired}
use magiclamp/protocol/um.{
  get_um_for_instant, validate_um_history_length, validate_um_range,
}
use magiclamp/protocol/lamp.{
  l_avail, remove_newest_first, sum_holdings, validate_lamp_locked,
}
use magiclamp/protocol/profile.{apply_pending_profile}

// ══════════════════════════════════════════════════════════════
// VAULT-IDENTITY STATE-THREAD NFT — genesis-clean anchor (MAINNET-BLOCK)
//
// THE HOLE: Cardano runs a validator only when a UTxO is SPENT, never when it
// is CREATED. The vault script address is public (= hash of this validator +
// params). An attacker pays min-ADA to place a UTxO at the vault address with a
// FABRICATED inline datum (`consumed_credit = 10^18`, `magic_batches` full of
// fake amounts, `owner = attacker`), then spends it via InstantGen/BurnBatch to
// mint MAGIC computed from 100%-fabricated state. Nothing validated the datum at
// creation.
//
// THE FIX: a state-thread NFT whose ONLY way into existence runs a policy (the
// `mint` handler below) that PROVES the vault started clean, and whose presence
// is REQUIRED on every spend (see `validate_vault_value`). A fabricated vault
// (no NFT) cannot be spent by ANY handler.
//
// WHY THIS IS A MULTI-PURPOSE VALIDATOR (deviation from the two-file spec):
// The mint policy must bind the genesis NFT to THIS vault's script address
// (otherwise the attacker mints a clean NFT to a wallet, then in a plain tx
// re-homes it to the vault address with a DIRTY datum — no script runs on that
// creation, so the hole reopens). Binding needs the vault hash inside the mint
// policy, while the spend side needs the mint policy id — a MUTUAL apply-param
// fixed point (`vault_hash = H(…,policy)`, `policy = H(…,vault_hash)`) that is
// undeployable (documented circular-apply-param trap). Folding the mint handler
// INTO the vault validator breaks the cycle: here `policy_id (mint) ==
// script_hash == the Script credential of the spend address`, all known via
// self-reference, no param, no cycle. The single script hash IS the vault_id
// policy id.
//
// The asset name is `blake2b_256(cbor.serialise(seed_output_reference))` so each
// vault is a distinct N-instance one-shot (permissionless creation, unique per
// spent seed UTxO). vault.ak identifies "its" NFT by policy == own script hash
// and pins the exact name across every spend transition.
// ══════════════════════════════════════════════════════════════
pub type VaultIdRedeemer {
  // Mint a fresh vault-identity NFT + park a genesis-clean vault UTxO.
  MintVaultId { seed: OutputReference }
  // Burn the NFT. Allowed unconditionally at the policy level; a spend that
  // burns the NFT still fails `validate_vault_value` (NFT must survive on the
  // continuing output), so in practice the NFT is permanent under the current
  // handler set (there is no terminal close path). Kept for forward-compat.
  BurnVaultId
}

// ── Validator parameters ─────────────────────────────────────
// `lamp_asset_name` is the on-chain asset name of the LAMP token, applied at
// deploy time per-network (MAINNET-BLOCK fix): mainnet LAMP and testnet tLAMP
// carry DIFFERENT asset names, so every value-preservation check must read the
// quantity of the network's ACTUAL LAMP asset — never a hardcoded literal.
// A hardcoded "tLAMP" name (#"744c414d50") makes quantity_of return 0 on
// mainnet → lamp_balance is forced to 0 → no vault meets min_instant_holding →
// InstantGen is permanently dead on mainnet. Project rule: "LAMP asset name is
// a PARAM by network, never hardcode." Offchain mirror:
// ASSET_NAMES.lamp / TESTNET_CONFIG.lampAssetName.
// `ms_per_epoch` is applied per-network (Plutus validity_range is POSIX ms):
//   Mainnet:        432_000_000
//   Preview/Preprod: 86_400_000
validator vault(
  lamp_policy_id      : PolicyId,
  lamp_asset_name     : ByteArray,
  um_nft_policy       : PolicyId,
  um_script_hash      : ByteArray,
  backing_nft_policy  : PolicyId,
  backing_script_hash : ByteArray,
  ms_per_epoch        : Int,
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
    // Datum must always be present on vault UTxOs
    expect Some(input_datum) = datum_opt

    // ── Derive current epoch from tx validity range ──────────
    // Plutus V3 validity_range carries POSIX milliseconds, not slots.
    let current_epoch = get_current_epoch(tx, ms_per_epoch)

    when redeemer is {
      // ── InstantGen redeemer ──────────────────────────────
      InstantGen { claimed_amount } ->
        validate_instant_gen(
          input_datum, claimed_amount, current_epoch,
          own_ref, lamp_policy_id, lamp_asset_name, um_nft_policy, um_script_hash,
          backing_nft_policy, backing_script_hash, tx,
        )

      // ── PruneExpired — permissionless dead-batch GC (§7.4) ─
      PruneExpired ->
        validate_prune_expired(
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

  // Any other script purpose (withdraw/publish/vote) fails closed.
  else(_) {
    fail
  }
}

// ═══════════════════════════════════════════════════════════════
// validate_mint_vault_id — genesis-clean state-thread NFT mint
//
// Runs at MINT (the one moment a policy can enforce "this vault started clean",
// since no validator runs at UTxO creation). Constrains EVERY VaultDatum field
// to its clean initial value and binds the declared LAMP balance to the ACTUAL
// LAMP sitting in the parked output.
// ═══════════════════════════════════════════════════════════════
fn validate_mint_vault_id(
  seed           : OutputReference,
  policy_id      : PolicyId,
  lamp_policy_id : PolicyId,
  lamp_asset_name : ByteArray,
  tx             : Transaction,
) -> Bool {

  // ── ONE-SHOT uniqueness: the exact seed UTxO must be spent here ──────────
  // A UTxO is spendable once ⟹ this (policy, name) can be minted once ⟹ the NFT
  // is a permanent per-vault singleton. Permissionless: any wallet UTxO works.
  expect list.any(tx.inputs, fn(i) { i.output_reference == seed })

  // ── EXACTLY one asset under this policy, qty +1, name = H(seed) ──────────
  let own_tokens = assets.tokens(tx.mint, policy_id)
  expect dict.size(own_tokens) == 1
  let nft_name = crypto.blake2b_256(cbor.serialise(seed))
  expect assets.quantity_of(tx.mint, policy_id, nft_name) == 1

  // ── EXACTLY one output at THIS vault script address carrying the NFT ─────
  // policy_id == this validator's own script hash, so Script(policy_id) is the
  // vault spend address. Binding the NFT to it here is what stops the "mint
  // clean → re-home dirty" reopening: the NFT is born at the vault address and
  // can never leave it (spend always preserves it to the continuing output).
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
  // owner: a pkh the creator controls (present in signatories) — no squatting
  // a victim's pkh, and the creator can actually spend the result.
  expect list.has(tx.extra_signatories, vd.owner)

  // LAMP accounting bound to the REAL deposited LAMP (no claiming a balance you
  // did not deposit).
  let lamp_qty = assets.quantity_of(vault_out.value, lamp_policy_id, lamp_asset_name)
  expect vd.lamp_balance == lamp_qty
  expect vd.lamp_locked == 0
  expect sum_holdings(vd.loyalty_holdings) == vd.lamp_balance
  expect list.all(vd.loyalty_holdings, fn(h) { !h.is_locked })
  expect list.length(vd.loyalty_holdings) <= max_loyalty_holdings

  // MAGIC / consumed state MUST be empty — this is the exact lever the attack
  // fabricated.
  expect vd.magic_batches == []
  expect vd.next_batch_index == 0
  expect vd.activity_state == ActivityState {
    recent_burn_epochs: [],
    consumed_credit: 0,
  }

  // Every other ledger empty/zeroed.
  expect vd.vacuum_orders == []
  expect vd.gen_schedules == []
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
  // profile NOT pinned: it is a user-chosen STRATEGY (Ember/Flame/Lantern), not
  // accumulated state. The type is bounded to 3 valid values and (where
  // UpdateProfile exists) changeable under cooldown, so pinning gives no security
  // benefit while it would reject every vault the standard off-chain flow creates
  // (default Flame). Any of the 3 enum values is a valid genesis strategy.

  // ── No dust bundled into the genesis output ──────────────────────────────
  // At most {ADA, LAMP, vault_id NFT}.
  expect list.length(assets.policies(vault_out.value)) <= 3

  True
}

/// Burn path: allowed unconditionally (only NEGATIVE quantities under this
/// policy). This can never be used to sneak a mint (all qty < 0), and a spend
/// that also burns the NFT is rejected by `validate_vault_value` (the NFT must
/// survive on the continuing output).
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
// validate_instant_gen — §6.3 (LAMP đứng yên, độ lớn theo consumed)
//
// Sequence:
//   1. structural guards (single vault in/out, owner sig, monotonic epoch)
//   2. ELIGIBILITY — LAMP must SIT in the vault (min_instant_holding), and it
//      must be genuinely available (not fully locked). Nothing is transferred.
//   3. UM reference input (C-UM-6 stale check)
//   4. BackingBeacon reference input — fail-closed surplus gate
//   5. grant = min( reward(consumed), cap_surplus(br), 0.5 × pp_schedule )
//   6. new batch for THIS epoch (decay_window = 1), consumed_credit zeroed
//   7. A02 field-by-field output datum + LAMP/ADA value lock (I-ACT-7)
// ═══════════════════════════════════════════════════════════════
fn validate_instant_gen(
  input_datum         : VaultDatum,
  claimed_amount      : Int,
  current_epoch       : Int,
  own_ref             : OutputReference,
  lamp_policy_id      : PolicyId,
  lamp_asset_name     : ByteArray,
  um_nft_policy       : PolicyId,
  um_script_hash      : ByteArray,
  backing_nft_policy  : PolicyId,
  backing_script_hash : ByteArray,
  tx                  : Transaction,
) -> Bool {

  // ── C-VAULT-DS-1: exactly one vault input ────────────────
  // Prevents Double Satisfaction attack (T20, A1). Counted by PAYMENT
  // CREDENTIAL — see `same_script`. (The old comment here claimed "address match
  // alone is sufficient because each UTxO has a unique own_ref". That confuses
  // two things: own_ref is unique, but the ADDRESS is not — the stake half is
  // unconstrained, so one script hash presents as N addresses.)
  let vault_addr = find_own_address(own_ref, tx.inputs)
  let vault_input_count =
    list.count(tx.inputs, fn(i) { same_script(i.output.address, vault_addr) })
  expect vault_input_count == 1

  // ── User must sign (C-PC-V1) ─────────────────────────────
  expect list.has(tx.extra_signatories, input_datum.owner)

  // ── Lazy profile apply (SPEC_V1 §2/§3) ────────────────────
  // applied_input drives BOTH the grant computation (PM depends on profile)
  // AND the A02 output check, so pending clears on the output.
  let applied_input = apply_pending_profile(input_datum, current_epoch)

  // ── MONOTONIC EPOCH guard (epoch gaming) ──────────────────
  // Liveness (§4.2 cliff) and the UM/beacon staleness checks all assume time
  // only moves forward. A backwards epoch would let a caller revive a dead
  // batch or replay a stale beacon.
  expect current_epoch >= input_datum.last_updated_epoch

  // ── C-INST-1 (ELIGIBILITY): LAMP sits in the vault ───────
  // §6.3 "nắm LAMP chỉ MỞ TƯ CÁCH". Threshold on the BALANCE, not on any
  // amount paid — nothing is paid.
  expect applied_input.lamp_balance >= min_instant_holding

  // ── C-INST-3 (ELIGIBILITY): the LAMP must be unencumbered ─
  // LAMP fully locked into ScheduleGen contracts does not also buy Instant
  // eligibility.
  let avail = l_avail(applied_input.lamp_balance, applied_input.lamp_locked)
  expect avail >= min_instant_holding

  // ── C-INST-7: |live batches| + 1 ≤ 32 ────────────────────
  let live_batches = prune_expired(applied_input.magic_batches, current_epoch)
  expect list.length(live_batches) < max_batches_per_vault

  // ── Get UM from reference input (C-UM-6) ─────────────────
  let um_datum = find_um_datum(tx.reference_inputs, um_nft_policy, um_script_hash)
  expect validate_um_range(um_datum)
  expect validate_um_history_length(um_datum)
  let um_q = get_um_for_instant(um_datum, current_epoch)

  // ── BackingBeacon reference input (§6.3) — FAIL-CLOSED ───
  // No beacon / wrong address / no NFT ⟹ this lookup fails ⟹ the tx is
  // invalid ⟹ Gen is shut. There is deliberately NO default `br`.
  let backing =
    find_backing_datum(tx.reference_inputs, backing_nft_policy, backing_script_hash)

  // Phanh 1: depeg → cap = 0. Reject outright rather than compute a 0 grant,
  // so the failure reason is unambiguous on-chain.
  expect !backing.depeg

  // Phanh 2: stale beacon is treated as ABSENT.
  let backing_age = current_epoch - backing.last_updated_epoch
  expect backing_age >= 0 && backing_age <= max_backing_stale

  // ── §6.3 grant = min(reward, cap_surplus, 0.5 × pp) ──────
  let pm_q = get_pm_q(applied_input.profile)
  let consumed = applied_input.activity_state.consumed_credit
  let grant =
    compute_instant_grant(
      consumed, um_q, pm_q,
      backing.br_q, backing.magic_supply,
      applied_input.gen_schedules,
    )
  expect grant > 0                       // no-op tx rejected
  expect claimed_amount == grant         // redeemer must state the exact grant

  // ── New batch for THIS epoch (§4.2 cliff) ────────────────
  let new_batch_id = compute_batch_id(own_ref, applied_input.next_batch_index)
  let new_batch =
    MagicBatch {
      batch_id:            new_batch_id,
      source:              Instant,
      created_epoch:       current_epoch,
      initial_amount:      grant,
      current_amount:      grant,
      decay_window:        magic_decay_window,  // 1 — dies next epoch
      profile_at_creation: None,                // C-DECAY-4: None for Instant
      contract_id:         None,
      halved:              False,               // dead field, always False
    }

  let expected_batches = list.concat(live_batches, [new_batch])

  // ── A02: Field-by-field output datum validation ───────────
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  expect output_datum.owner == applied_input.owner

  // ── I-ACT-7: LAMP DOES NOT MOVE ──────────────────────────
  // Every LAMP-bearing field is byte-identical to the input. This is the whole
  // point of PHA 2: generating MAGIC must not displace a single oildrop.
  expect output_datum.lamp_balance == applied_input.lamp_balance
  expect output_datum.lamp_locked == applied_input.lamp_locked
  expect output_datum.loyalty_holdings == applied_input.loyalty_holdings

  // Unchanged bookkeeping
  expect output_datum.vacuum_orders == applied_input.vacuum_orders
  expect output_datum.gen_schedules == applied_input.gen_schedules
  expect output_datum.profile == applied_input.profile
  expect output_datum.profile_changed_epoch == applied_input.profile_changed_epoch
  expect output_datum.pending_profile == applied_input.pending_profile
  expect output_datum.delegation_cert == applied_input.delegation_cert
  expect output_datum.streak_state == applied_input.streak_state
  expect output_datum.personal_delegate == applied_input.personal_delegate

  // C-VAULT-10 / C-VAULT-8 still hold on the (unchanged) LAMP fields.
  expect sum_holdings(output_datum.loyalty_holdings) == output_datum.lamp_balance
  expect validate_lamp_locked(output_datum.lamp_locked, output_datum.lamp_balance)
  expect list.length(output_datum.loyalty_holdings) <= max_loyalty_holdings

  // Changed: magic_batches (dead pruned + new batch appended)
  expect output_datum.magic_batches == expected_batches
  expect list.length(output_datum.magic_batches) <= max_batches_per_vault

  // Changed: next_batch_index increments by exactly 1 (C-VAULT-3)
  expect output_datum.next_batch_index == applied_input.next_batch_index + 1

  // Changed: last_updated_epoch = current epoch
  expect output_datum.last_updated_epoch == current_epoch

  // ── INV-CASHBACK-BOUND: the credit is SPENT, not reused ───
  // The whole consumed_credit is converted in one shot and zeroed, so the same
  // consumption can never be claimed twice.
  expect output_datum.activity_state ==
    ActivityState { ..applied_input.activity_state, consumed_credit: 0 }

  // Attribution hash-chain updated (C-ATT-1, C-ATT-2)
  expect output_datum.attribution.total_events == applied_input.attribution.total_events + 1
  expect output_datum.attribution.last_event_epoch == current_epoch

  // ── VALUE PRESERVATION (bind datum to real value) ─────────
  // The datum claims the LAMP balance is unchanged; bind that claim to the
  // LAMP actually sitting in the vault output, otherwise LAMP could still be
  // drained while the datum lies.
  let inst_vault_output = find_vault_output(tx.outputs, vault_addr)
  let inst_vault_lamp =
    assets.quantity_of(inst_vault_output.value, lamp_policy_id, lamp_asset_name)
  expect inst_vault_lamp == output_datum.lamp_balance

  // ── ADA / token-set preservation ──────────────────────────
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), inst_vault_output)

  True
}

// ═══════════════════════════════════════════════════════════════
// validate_prune_expired — §7.4 permissionless garbage collection
//
// Removes DEAD batches (created_epoch < current_epoch under the §4.2 cliff).
// A dead batch is already worth zero, so this changes NO live value; it only
// reclaims datum bytes. Permissionless (P-1, no signature) and therefore
// hardened against griefing:
//   - reject a no-op (nothing dead) so it cannot be spammed;
//   - last_updated_epoch PRESERVED, so a third party cannot move the victim's
//     clock forward;
//   - LAMP / ADA / token-set locked.
// ═══════════════════════════════════════════════════════════════
fn validate_prune_expired(
  input_datum    : VaultDatum,
  current_epoch  : Int,
  own_ref        : OutputReference,
  lamp_policy_id : PolicyId,
  lamp_asset_name : ByteArray,
  tx             : Transaction,
) -> Bool {

  // ── P-1: exactly one vault input (C-VAULT-DS-1) ─────────────
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { same_script(i.output.address, vault_addr) }) == 1

  // ── P-2: lazy profile apply (SPEC_V1 §2) ─────────────────────
  let applied_input = apply_pending_profile(input_datum, current_epoch)

  // ── P-3: reject-noop — there must be something to collect ───
  expect count_expired(applied_input.magic_batches, current_epoch) > 0

  // ── P-4: output = input minus the dead batches ──────────────
  let expected_batches = prune_expired(applied_input.magic_batches, current_epoch)

  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  // P-5: LAMP untouched
  expect output_datum.owner == applied_input.owner
  expect output_datum.lamp_balance == applied_input.lamp_balance
  expect output_datum.lamp_locked == applied_input.lamp_locked
  expect output_datum.loyalty_holdings == applied_input.loyalty_holdings

  // P-6: the only change is the batch list
  expect output_datum.magic_batches == expected_batches
  expect list.length(output_datum.magic_batches) <= max_batches_per_vault
  expect output_datum.next_batch_index == applied_input.next_batch_index

  // P-7: last_updated_epoch PRESERVED (permissionless griefing guard).
  // Liveness depends only on each batch's created_epoch, never on
  // last_updated_epoch, so preserving it is safe and closes the vector where a
  // stranger advances a victim's clock every epoch.
  expect output_datum.last_updated_epoch == applied_input.last_updated_epoch

  // Remaining fields UNCHANGED — notably activity_state: a prune must NOT
  // touch consumed_credit (it would otherwise be a free reward/theft lever).
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

  // ── VALUE PRESERVATION ────────────────────────────────────
  let prune_vault_output = find_vault_output(tx.outputs, vault_addr)
  let prune_vault_lamp =
    assets.quantity_of(prune_vault_output.value, lamp_policy_id, lamp_asset_name)
  expect prune_vault_lamp == output_datum.lamp_balance

  // ADA / token-set preservation — CRITICAL here because the path is
  // permissionless: without it a stranger reroutes the vault's surplus ADA or
  // stuffs dust tokens to brick the UTxO.
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), prune_vault_output)

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
///   - VAULT-IDENTITY NFT preserved: the spent input must carry EXACTLY one
///     asset under the vault_id policy (== this validator's own script hash),
///     and the continuing output must carry the SAME (policy, name). This is the
///     MAINNET-BLOCK fix: a FABRICATED vault (placed at the script address with
///     no NFT — no policy ran to vet its datum) fails here, so it cannot be spent
///     by ANY handler. The NFT is born genesis-clean (validate_mint_vault_id)
///     and can never leave the vault address (every transition re-pins it).
///   - lovelace(out) >= lovelace(in)        → no ADA siphoned ( `>=` lets an
///     honest caller top up ADA, never let it shrink).
///   - |policies(out)| <= 3                  → at most {ADA, LAMP, vault_id NFT};
///     rejects any extra policy so dust stuffing cannot bloat the UTxO.
/// The per-handler LAMP-quantity check still pins the LAMP amount itself.
fn validate_vault_value(vault_input: Input, vault_output: Output) -> Bool {
  // vault_id policy = own script hash, read from the input being spent.
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

/// Find the BackingBeacon datum from reference inputs (§6.3).  [CẦN XÁC NHẬN]
///
/// Same two-layer pinning as the UM beacon: the ref input must BOTH carry the
/// beacon NFT (`backing_nft_policy`, asset name "BRQ") AND sit at the canonical
/// beacon script address. An NFT policy is not a guaranteed global singleton, so
/// the address pin is what rejects a forged beacon at an attacker address.
///
/// FAIL-CLOSED: no matching reference input ⟹ this `expect` fails ⟹ the whole
/// InstantGen tx is invalid. That is the intended behaviour while CARP has not
/// shipped the beacon (deploy the vault with an all-zero policy/hash pair): the
/// Gen door stays shut instead of running on an invented `br`.
fn find_backing_datum(
  ref_inputs          : List<Input>,
  backing_nft_policy  : PolicyId,
  backing_script_hash : ByteArray,
) -> BackingBeaconDatum {
  expect Some(beacon_input) = list.find(ref_inputs, fn(i) {
    let has_nft =
      assets.quantity_of(i.output.value, backing_nft_policy, #"425251") > 0  // "BRQ"
    let at_beacon_script =
      i.output.address.payment_credential == Script(backing_script_hash)
    has_nft && at_beacon_script
  })
  expect InlineDatum(beacon_data) = beacon_input.output.datum
  expect beacon: BackingBeaconDatum = beacon_data
  beacon
}

/// Two addresses belong to the same SCRIPT iff their payment credentials match.
/// The stake credential is deliberately ignored — nothing constrains it, so one
/// script hash presents as arbitrarily many distinct `Address` values and every
/// "exactly one at MY address" guard counts each of them separately. Same rule,
/// same reason, as `ScheduleGen/onchain/validators/vault.ak` (Nợ #31),
/// `Consolidate/onchain/validators/vault_consolidate.ak:19-20` and
/// `ConsumeMAGIC/onchain/lib/magiclamp/consume/util.ak:67-72`.
fn same_script(a: Address, b: Address) -> Bool {
  a.payment_credential == b.payment_credential
}

/// Find the vault's output (used for value check in WithdrawLamp W-6).
fn find_vault_output(outputs: List<Output>, vault_addr: Address) -> Output {
  // C-VAULT-OUT-1 (PR #11 review): exactly one continuing vault output, symmetric
  // to the input==1 check. Blocks a phantom 2nd vault output carrying a forged datum.
  // COUNTED by payment credential so a staked twin cannot hide from the count.
  expect list.count(outputs, fn(o) { same_script(o.address, vault_addr) }) == 1
  expect Some(vault_output) = list.find(outputs, fn(o) { same_script(o.address, vault_addr) })
  // IDENTITY stays pinned to the input's FULL address — counting loosened, the
  // continuing output did not.
  expect vault_output.address == vault_addr
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
  own_ref        : OutputReference,
  lamp_policy_id : PolicyId,
  lamp_asset_name : ByteArray,
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
  expect list.count(tx.inputs, fn(i) { same_script(i.output.address, vault_addr) }) == 1

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
// reduced. Auth = owner OR consume-delegate (personal_delegate). The vault
// enforces the safe per-batch mutation, A02, and LAMP value lock.
//
// 🔴 ĐÍNH CHÍNH (2026-08-12) — bản cũ ghi rằng `Σburns == required` "is enforced
// by the co-spending ConsumeMAGIC validator". Câu đó chỉ đúng KHI ConsumeMAGIC có
// mặt trong tx, và KHÔNG có gì trong hàm này bắt nó có mặt: không ràng buộc input
// nào ở địa chỉ `consume`, không đọc PriceParam beacon. Liên kết giá là MỘT CHIỀU
// — consume.ak ép về phía vault, vault không ép ngược lại.
//
// Hệ quả đang sống: một `personal_delegate` ký được một tx BurnBatch trần trụi,
// không kèm Engage input, không giao dịch vụ gì, và đốt sạch MAGIC của chủ vault.
// Chủ không mất LAMP và không mất ADA (hai chốt dưới chặn đúng), nhưng mất toàn bộ
// quyền-tiêu-dịch-vụ đã trả tiền để có. `personal_delegate` hiện là
// `Option<ByteArray>` trần: không hạn mức, không phạm vi op, không hạn dùng.
//
// Vá đề xuất (ĐỤNG VALIDATOR — chờ chủ nhân gật, xem DevStatus.md): khi người ký
// là delegate chứ không phải chủ, đòi ≥1 input ở `engage_script_hash` với redeemer
// `Consume`. Đường chủ-tự-ký có thể miễn. Phát hiện: hội đồng rà trước push
// 2026-08-12, trục cơ chế.
// ═══════════════════════════════════════════════════════════════
fn validate_burn_batch(
  input_datum    : VaultDatum,
  burns          : List<(ByteArray, Int)>,
  current_epoch  : Int,
  own_ref        : OutputReference,
  lamp_policy_id : PolicyId,
  lamp_asset_name : ByteArray,
  tx             : Transaction,
) -> Bool {

  // ── DS-1: exactly one vault input (no double-satisfaction) ──
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { same_script(i.output.address, vault_addr) }) == 1

  // ── AUTH: owner OR consume-delegate signs ─────────────────
  let authed =
    list.has(tx.extra_signatories, input_datum.owner) || when input_datum.personal_delegate is {
      Some(d) -> list.has(tx.extra_signatories, d)
      None -> False
    }
  expect authed

  // ── MONOTONIC EPOCH guard (MAINNET-BLOCK — epoch gaming) ──
  // The delegate path means a non-owner can call this; a backwards epoch would
  // revive a DEAD batch (liveness keys on created_epoch vs current_epoch) and
  // let the delegate burn MAGIC that the §4.2 cliff already reset to zero.
  expect current_epoch >= input_datum.last_updated_epoch

  // ── Lazy profile apply (like every handler) ───────────────
  let applied = apply_pending_profile(input_datum, current_epoch)

  // ── Burn on LIVE batches only, then collect the dead ──────
  // apply_burns itself rejects any burn aimed at a batch outside its
  // created_epoch (§4.2 use-or-lose); the surviving dead batches are pruned
  // afterwards so the output never carries zero-value bytes.
  let burned = apply_burns(applied.magic_batches, burns, current_epoch)
  let expected_batches = prune_expired(burned, current_epoch)

  // ── §6.3 consumed accounting ──────────────────────────────
  // Every nanogic actually consumed is credited to `consumed_credit`, which is
  // the base InstantGen later converts into a reward (INV-MAGIC-CITIZEN: the
  // reward is keyed to MAGIC ACTUALLY CONSUMED, never to MAGIC held).
  let total_burned = sum_burns(burns)
  expect total_burned > 0

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
  expect output_datum.activity_state ==
    ActivityState {
      ..applied.activity_state,
      consumed_credit: applied.activity_state.consumed_credit + total_burned,
    }
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

/// Subtract `burns` from the batch list.
/// For each (batch_id, amount): there must be EXACTLY one matching batch; that
/// batch must still be LIVE at `current_epoch` (§4.2 use-or-lose — a batch is
/// spendable only inside its own created_epoch); 0 < amount ≤ current_amount;
/// every other field stays immutable (T4); a batch whose result is 0 is pruned.
/// List order is preserved for untouched batches. Over-burn, unknown batch_id
/// and DEAD batch_id all fail.
fn apply_burns(
  batches       : List<MagicBatch>,
  burns         : List<(ByteArray, Int)>,
  current_epoch : Int,
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
            // §4.2 CLIFF: a batch outside its created_epoch is worth zero and
            // may not be consumed. Without this the ConsumeMAGIC co-spend could
            // "pay" with MAGIC the protocol already reset.
            expect !is_expired(b, current_epoch)
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
      apply_burns(updated, rest, current_epoch)
    }
  }
}

/// Σ of the burn amounts in a BurnBatch redeemer (nanogic actually consumed).
fn sum_burns(burns: List<(ByteArray, Int)>) -> Int {
  list.foldl(burns, 0, fn(b, acc) { let (_bid, amt) = b
    acc + amt })
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
  own_ref        : OutputReference,
  lamp_policy_id : PolicyId,
  lamp_asset_name : ByteArray,
  tx             : Transaction,
) -> Bool {

  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { same_script(i.output.address, vault_addr) }) == 1

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
  own_ref        : OutputReference,
  lamp_policy_id : PolicyId,
  lamp_asset_name : ByteArray,
  tx             : Transaction,
) -> Bool {

  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { same_script(i.output.address, vault_addr) }) == 1

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

// NOTE: the former `treasury_receives_lamp` helper is GONE. Under I-ACT-7 no
// handler moves LAMP out of the vault, so there is no Treasury leg and no
// `treasury_addr` apply-parameter left in this validator.

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
// Tests
// Negatives use the `fail` annotation: test passes iff the body errors.
// ═══════════════════════════════════════════════════════════════

const t_owner: ByteArray =
  #"00000000000000000000000000000000000000000000000000000000"
const t_vault_hash: ByteArray =
  #"11111111111111111111111111111111111111111111111111111111"
const t_lamp_policy: ByteArray =
  #"22222222222222222222222222222222222222222222222222222222"
// Test LAMP asset name — matches the name minted into every test fixture value
// builder (#"744c414d50" = "tLAMP"). Passed as the new `lamp_asset_name` param.
const t_lamp_asset_name: ByteArray = #"744c414d50"
const t_tx_id: ByteArray =
  #"3333333333333333333333333333333333333333333333333333333333333333"

// vault_id NFT lives under the vault's OWN script hash (policy_id == script
// hash for the multi-purpose validator). `t_vault_id_name` is an arbitrary
// 32-byte name standing in for blake2b_256(cbor.serialise(seed)).
const t_vault_id_name: ByteArray =
  #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

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
    address: address.from_script(t_vault_hash),
    value: assets.from_asset(t_lamp_policy, #"744c414d50", balance)
      |> assets.add(t_vault_hash, t_vault_id_name, 1),
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
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

test w_amount_zero() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(din, 100)], [t_owner])
  validate_withdraw_lamp(din, 0, 0, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

test w_over_avail() fail {
  let din = t_datum(100, 100, [t_holding(100, 5, True)])
  let dout = t_datum(95, 100, [t_holding(95, 5, True)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

test w_no_owner_sig() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
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
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// ── Nợ #31: double-satisfaction qua stake credential ──────────
// Same script hash + a stake credential = a different `Address`. Counting by
// full address let the twin read as somebody else's UTxO.

fn t_vault_output_staked(datum: VaultDatum, balance: Int) -> Output {
  Output {
    ..t_vault_output(datum, balance),
    address: address.from_script(t_vault_hash)
      |> address.with_delegation_key(t_owner),
  }
}

// Pre-fix this PASSED: `o.address == vault_addr` counted 1, not 2.
test ds_phantom_output_under_stake_cred_rejected() fail {
  let din  = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx =
    t_tx(
      [t_vault_input(din, 100)],
      [t_vault_output(dout, 95), t_vault_output_staked(dout, 95)],
      [t_owner],
    )
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// Counting loosened to payment credential; IDENTITY did not.
test ds_continuing_output_must_keep_stake_cred() fail {
  let din  = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output_staked(dout, 95)], [t_owner])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

test w_advance_last_updated_rejected() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout =
    VaultDatum {
      ..t_datum(95, 0, [t_holding(95, 5, False)]),
      last_updated_epoch: 5,
    }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
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
  validate_update_profile(din, Ember, 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

test up_cooldown_not_met() fail {
  let din =
    VaultDatum {
      ..t_datum(100, 0, [t_holding(100, 5, False)]),
      profile_changed_epoch: 10,
    }
  let dout = up_output(din, Ember, 11)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_update_profile(din, Ember, 11, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

test up_bypass_lazy() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = VaultDatum { ..up_output(din, Ember, 10), profile: Ember }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_update_profile(din, Ember, 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

test up_same_profile() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = up_output(din, Flame, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_update_profile(din, Flame, 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// ── §4.2 CLIFF — batch lifetime ───────────────────────────────
//
// decay_window = 1 everywhere: a batch is live ONLY in created_epoch.

fn t_instant_batch(epoch_created: Int, amount: Int) -> MagicBatch {
  MagicBatch {
    batch_id:            #"aabbcc",
    source:              Instant,
    created_epoch:       epoch_created,
    initial_amount:      amount,
    current_amount:      amount,
    decay_window:        magic_decay_window,   // 1
    profile_at_creation: None,
    contract_id:         None,
    halved:              False,
  }
}

fn t_datum_with_batches(batches: List<MagicBatch>) -> VaultDatum {
  VaultDatum {
    ..t_datum(100, 0, [t_holding(100, 5, False)]),
    magic_batches: batches,
  }
}

// CLIFF-1: k=0 → live
test cliff_k0_live() {
  !is_expired(t_instant_batch(10, 1000), 10)
}

// CLIFF-2: k=1 → DEAD (no halving step in between)
test cliff_k1_dead() {
  is_expired(t_instant_batch(10, 1000), 11)
}

// CLIFF-3: k=2 → DEAD
test cliff_k2_dead() {
  is_expired(t_instant_batch(10, 1000), 12)
}

// ── PruneExpired (§7.4) ───────────────────────────────────────

// P-POS-1: a dead batch is collected; last_updated_epoch PRESERVED.
test pe_positive_collects_dead() {
  let dead = t_instant_batch(9, 1000)          // created 9, current 10 → dead
  let din  = t_datum_with_batches([dead])
  let dout = t_datum_with_batches([])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_prune_expired(din, 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// P-POS-2: permissionless — no signature at all.
test pe_positive_no_signature_needed() {
  let dead = t_instant_batch(8, 800)
  let din  = t_datum_with_batches([dead])
  let dout = t_datum_with_batches([])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_prune_expired(din, 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// P-NEG-1: nothing dead → reject-noop (anti-spam).
test pe_neg_noop_rejected() fail {
  let live = t_instant_batch(10, 1000)        // k=0, still live
  let din  = t_datum_with_batches([live])
  let dout = t_datum_with_batches([live])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_prune_expired(din, 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// P-NEG-2: prune must not eat a LIVE batch.
test pe_neg_live_batch_dropped() fail {
  let dead = t_instant_batch(9, 1000)
  let live = MagicBatch { ..t_instant_batch(10, 500), batch_id: #"ddeeff" }
  let din  = t_datum_with_batches([dead, live])
  let dout = t_datum_with_batches([])          // dropped the live one too
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_prune_expired(din, 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// P-NEG-3: lamp_balance mutated during a prune.
test pe_neg_lamp_balance_mutated() fail {
  let dead = t_instant_batch(9, 1000)
  let din  = t_datum_with_batches([dead])
  let dout = VaultDatum { ..t_datum_with_batches([]), lamp_balance: 90 }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_prune_expired(din, 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// P-NEG-4: GRIEFING — last_updated_epoch advanced on a permissionless path.
test pe_neg_epoch_advanced_griefing() fail {
  let dead = t_instant_batch(9, 1000)
  let din  = t_datum_with_batches([dead])
  let dout = VaultDatum { ..t_datum_with_batches([]), last_updated_epoch: 10 }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_prune_expired(din, 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// P-NEG-5: prune must not touch consumed_credit (free-reward lever).
test pe_neg_consumed_credit_inflated() fail {
  let dead = t_instant_batch(9, 1000)
  let din  = t_datum_with_batches([dead])
  let dout = VaultDatum {
    ..t_datum_with_batches([]),
    activity_state: ActivityState { recent_burn_epochs: [], consumed_credit: 10_000_000_000 },
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_prune_expired(din, 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// P-NEG-6: phantom second vault output.
test pe_neg_phantom_second_output() fail {
  let dead = t_instant_batch(9, 1000)
  let din  = t_datum_with_batches([dead])
  let dout = t_datum_with_batches([])
  let tx =
    t_tx(
      [t_vault_input(din, 100)],
      [t_vault_output(dout, 100), t_vault_output(dout, 100)],
      [],
    )
  validate_prune_expired(din, 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// P-POS-3: applies a due pending_profile while collecting.
test pe_positive_applies_pending_profile() {
  let dead = t_instant_batch(9, 1000)
  let din = VaultDatum {
    ..t_datum_with_batches([dead]),
    pending_profile: Some(PendingProfile { new_profile: Ember, effective_epoch: 10 }),
  }
  let dout = VaultDatum {
    ..din,
    magic_batches:   [],
    profile:         Ember,
    pending_profile: None,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_prune_expired(din, 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// ── BurnBatch — datum-consume (D1) ────────────────────────────

const t_delegate: ByteArray =
  #"44444444444444444444444444444444444444444444444444444444"

/// Batch with explicit id + current amount, source=Instant, created_epoch=10 so
/// it is LIVE at current_epoch=10. initial_amount fixed at 1000 (immutable).
fn t_burn_batch(id: ByteArray, current: Int) -> MagicBatch {
  MagicBatch {
    batch_id:            id,
    source:              Instant,
    created_epoch:       10,
    initial_amount:      1000,
    current_amount:      current,
    decay_window:        magic_decay_window,
    profile_at_creation: None,
    contract_id:         None,
    halved:              False,
  }
}

fn t_burn_din(batches: List<MagicBatch>, delegate: Option<ByteArray>) -> VaultDatum {
  VaultDatum {
    ..t_datum(100, 0, [t_holding(100, 5, False)]),
    magic_batches: batches,
    personal_delegate: delegate,
  }
}

/// Expected output datum after a burn: batches set, consumed_credit advanced by
/// `burned`, attribution incremented, last_updated_epoch = current.
fn t_burn_dout(
  din: VaultDatum, out_batches: List<MagicBatch>, burned: Int, current: Int,
) -> VaultDatum {
  VaultDatum {
    ..din,
    magic_batches: out_batches,
    last_updated_epoch: current,
    activity_state: ActivityState {
      ..din.activity_state,
      consumed_credit: din.activity_state.consumed_credit + burned,
    },
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
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 600)], 400, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 400)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// BB-POS-2: full burn prunes the batch
test bb_positive_full_prunes() {
  let din = t_burn_din([t_burn_batch(bid_a, 1000), t_burn_batch(bid_b, 500)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_b, 500)], 1000, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 1000)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// BB-POS-3: multi-batch burn in one tx
test bb_positive_multi() {
  let din = t_burn_din([t_burn_batch(bid_a, 1000), t_burn_batch(bid_b, 500)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700), t_burn_batch(bid_b, 200)], 600, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 300), (bid_b, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// BB-POS-4: consume-delegate (paymaster) can trigger burn; owner did NOT sign
test bb_positive_delegate_signs() {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate))
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// BB-NEG-DEAD: §4.2 — burning a batch OUTSIDE its created_epoch is rejected.
// This is the use-or-lose cliff: at epoch 11 the epoch-10 batch is worth zero.
test bb_dead_batch_rejected() fail {
  let din  = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [], 300, 11)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 300)], 11, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// BB-NEG-1: nobody authorized (no owner, no delegate signature)
test bb_neg_no_auth() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// BB-NEG-2: delegate not set but a stranger signs → reject
test bb_neg_stranger_no_delegate() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// BB-NEG-3: over-burn (amount > current_amount) forbidden
test bb_neg_over_burn() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [], 1001, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 1001)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// BB-NEG-4: unknown batch_id
test bb_neg_unknown_id() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 1000)], 100, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_b, 100)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// BB-NEG-5: output forges a lower lamp_balance (value-leak) → reject
test bb_neg_lamp_balance_forged() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = VaultDatum {
    ..t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10),
    lamp_balance: 50,   // datum claims 50 but value carries 100
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// BB-NEG-6: value drained below claimed lamp_balance → reject
test bb_neg_value_drained() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10)
  // output value carries only 60 LAMP while datum claims 100
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 60)], [t_owner])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// BB-NEG-7: attribution not incremented → reject
test bb_neg_attribution_not_bumped() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = VaultDatum {
    ..t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10),
    attribution: din.attribution,   // left untouched
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// BB-NEG-8: batch other field mutated (initial_amount tampered) → reject
test bb_neg_other_field_mutated() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let tampered = MagicBatch { ..t_burn_batch(bid_a, 700), initial_amount: 999 }
  let dout = t_burn_dout(din, [tampered], 300, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// BB-NEG-9: consumed_credit NOT advanced by the burned amount → reject.
// This is the accounting hook InstantGen later reads (§6.3); leaving it flat
// would let a burn happen without ever crediting the consumption.
test bb_neg_consumed_credit_not_advanced() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = VaultDatum {
    ..t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10),
    activity_state: din.activity_state,   // consumed_credit stayed 0
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// BB-NEG-10: consumed_credit INFLATED beyond what was burned → reject.
test bb_neg_consumed_credit_inflated() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300_000, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
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
  validate_set_delegate(din, Some(t_delegate), 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
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
  validate_set_delegate(din, None, 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
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
  validate_set_delegate(din, Some(t_delegate), 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
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
  validate_set_delegate(din, Some(t_owner), 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
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
  validate_set_delegate(din, Some(t_delegate), 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
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
  validate_set_delegate(din, Some(t_delegate), 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// ═══════════════════════════════════════════════════════════════
// Tests — InstantGen (§6.3): LAMP đứng yên + độ lớn theo consumed
// ═══════════════════════════════════════════════════════════════

const t_um_policy: ByteArray =
  #"66666666666666666666666666666666666666666666666666666666"
const t_um_hash: ByteArray =
  #"77777777777777777777777777777777777777777777777777777777"
const t_backing_policy: ByteArray =
  #"88888888888888888888888888888888888888888888888888888888"
const t_backing_hash: ByteArray =
  #"99999999999999999999999999999999999999999999999999999999"

fn t_um_ref(smoothed_q: Int, updated: Int) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: t_tx_id, output_index: 1 },
    output: Output {
      address: address.from_script(t_um_hash),
      value: assets.from_asset(t_um_policy, #"554d44", 1),
      datum: InlineDatum(UMDatum {
        smoothed_q, last_updated_epoch: updated, history: [],
      }),
      reference_script: None,
    },
  }
}

fn t_backing_ref(br_q: Int, supply: Int, depeg: Bool, updated: Int) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: t_tx_id, output_index: 2 },
    output: Output {
      address: address.from_script(t_backing_hash),
      value: assets.from_asset(t_backing_policy, #"425251", 1),
      datum: InlineDatum(BackingBeaconDatum {
        br_q, magic_supply: supply, depeg, last_updated_epoch: updated,
      }),
      reference_script: None,
    },
  }
}

/// A schedule contributing pp = ⌊λ × rate_locked_q / Q⌋ MAGIC per epoch.
fn t_sched(lambda: Int, rate_q: Int) -> GenSchedule {
  GenSchedule {
    schedule_id:            #"5c4ed0",
    commit_epoch:           0,
    start_fire_epoch:       2,
    end_fire_epoch:         100,
    schedule_length:        10,
    lamp_per_epoch:         lambda,
    rate_locked_q:          rate_q,
    baseline_at_commit_q:   5_000_000_000,
    multiplier_at_commit_q: 2_250_000_000,
    fired_count:            0,
    auto_burn_target:       None,
  }
}

/// Input vault: 1000 LAMP sitting (eligibility), `credit` nanogic consumed,
/// one ScheduleGen contract so the 0.5×pp ceiling is not zero.
fn t_ig_din(credit: Int) -> VaultDatum {
  VaultDatum {
    ..t_datum(1_000_000_000, 0, [t_holding(1_000_000_000, 5, False)]),
    gen_schedules: [t_sched(4_000_000_000, 11_250_000_000)],   // pp = 45×10^9
    activity_state: ActivityState { recent_burn_epochs: [], consumed_credit: credit },
  }
}

/// Expected output vault after a grant of `grant` nanogic at `epoch`.
fn t_ig_dout(din: VaultDatum, grant: Int, epoch: Int) -> VaultDatum {
  let batch =
    MagicBatch {
      batch_id:            compute_batch_id(t_own_ref(), din.next_batch_index),
      source:              Instant,
      created_epoch:       epoch,
      initial_amount:      grant,
      current_amount:      grant,
      decay_window:        magic_decay_window,
      profile_at_creation: None,
      contract_id:         None,
      halved:              False,
    }
  VaultDatum {
    ..din,
    magic_batches:      list.concat(prune_expired(din.magic_batches, epoch), [batch]),
    next_batch_index:   din.next_batch_index + 1,
    last_updated_epoch: epoch,
    activity_state:     ActivityState { ..din.activity_state, consumed_credit: 0 },
    attribution: VaultAttribution {
      attribution_root: din.attribution.attribution_root,
      last_event_epoch: epoch,
      total_events:     din.attribution.total_events + 1,
    },
  }
}

fn t_ig_tx(
  din  : VaultDatum,
  dout : VaultDatum,
  lamp_out : Int,
  refs : List<Input>,
  signers : List<ByteArray>,
) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: [t_vault_input(din, din.lamp_balance)],
    reference_inputs: refs,
    outputs: [t_vault_output(dout, lamp_out)],
    extra_signatories: signers,
  }
}

fn t_ig_call(din: VaultDatum, claimed: Int, epoch: Int, tx: Transaction) -> Bool {
  validate_instant_gen(
    din, claimed, epoch, t_own_ref(), t_lamp_policy, t_lamp_asset_name,
    t_um_policy, t_um_hash, t_backing_policy, t_backing_hash, tx,
  )
}

// Reference grant used across the positive cases.
//   consumed = 10^9 ; rate 0.20 → 200_000_000
//   UM = 1.0        → 200_000_000
//   PM = Flame 1.05 → 210_000_000
//   cap_surplus: S=10^12, br=2.0 ⟹ f·S = 10^11 ; ×(0.5) = 5×10^10 ; ÷1.5 = 33_333_333_333
//   cap_pp     : pp = ⌊4×10^9 × 11_250_000_000 / Q⌋ = 45×10^9 → ⌊/2⌋ = 22_500_000_000
//   grant = min(210_000_000, 33_333_333_333, 22_500_000_000) = 210_000_000
const ig_credit : Int = 1_000_000_000
const ig_grant  : Int = 210_000_000

fn t_ig_refs_ok(epoch: Int) -> List<Input> {
  [
    t_um_ref(1_000_000_000, epoch),                       // UM = 1.0, fresh
    t_backing_ref(2_000_000_000, 1_000_000_000_000, False, epoch),  // br = 2.0 > 1.5
  ]
}

// IG-POS-1: happy path — grant matches the formula, LAMP untouched.
test ig_positive_grant() {
  let din  = t_ig_din(ig_credit)
  let dout = t_ig_dout(din, ig_grant, 10)
  let tx   = t_ig_tx(din, dout, din.lamp_balance, t_ig_refs_ok(10), [t_owner])
  t_ig_call(din, ig_grant, 10, tx)
}

// IG-NEG-LAMP-MOVED: I-ACT-7 — any LAMP leaving the vault is rejected, even if
// the datum is "consistent" with the reduced value. This is the exact behaviour
// PHA 2 removed (the old validator REQUIRED this transfer).
test ig_neg_lamp_moved() fail {
  let din  = t_ig_din(ig_credit)
  let moved = din.lamp_balance - 10_000_000
  let dout = VaultDatum {
    ..t_ig_dout(din, ig_grant, 10),
    lamp_balance: moved,
    loyalty_holdings: [t_holding(moved, 5, False)],
  }
  let tx = t_ig_tx(din, dout, moved, t_ig_refs_ok(10), [t_owner])
  t_ig_call(din, ig_grant, 10, tx)
}

// IG-NEG-VALUE-DRAINED: datum says LAMP is unchanged but the output value is
// short → reject (datum↔value binding).
test ig_neg_value_drained() fail {
  let din  = t_ig_din(ig_credit)
  let dout = t_ig_dout(din, ig_grant, 10)
  let tx = t_ig_tx(din, dout, din.lamp_balance - 1, t_ig_refs_ok(10), [t_owner])
  t_ig_call(din, ig_grant, 10, tx)
}

// IG-NEG-NO-CREDIT: consumed = 0 ⟹ reward = 0 ⟹ grant = 0 → reject.
// Holding LAMP alone buys NOTHING (§6.3: LAMP chỉ mở tư cách).
test ig_neg_no_consumed_credit() fail {
  let din  = t_ig_din(0)
  let dout = t_ig_dout(din, 0, 10)
  let tx = t_ig_tx(din, dout, din.lamp_balance, t_ig_refs_ok(10), [t_owner])
  t_ig_call(din, 0, 10, tx)
}

// IG-NEG-CLAIM-MISMATCH: redeemer claims more than the formula allows.
test ig_neg_claim_mismatch() fail {
  let din  = t_ig_din(ig_credit)
  let dout = t_ig_dout(din, ig_grant + 1, 10)
  let tx = t_ig_tx(din, dout, din.lamp_balance, t_ig_refs_ok(10), [t_owner])
  t_ig_call(din, ig_grant + 1, 10, tx)
}

// IG-NEG-CREDIT-NOT-SPENT: consumed_credit must be zeroed by the grant,
// otherwise the same consumption is rewarded every epoch (INV-CASHBACK-BOUND).
test ig_neg_credit_not_spent() fail {
  let din  = t_ig_din(ig_credit)
  let dout = VaultDatum {
    ..t_ig_dout(din, ig_grant, 10),
    activity_state: din.activity_state,   // credit left intact
  }
  let tx = t_ig_tx(din, dout, din.lamp_balance, t_ig_refs_ok(10), [t_owner])
  t_ig_call(din, ig_grant, 10, tx)
}

// IG-NEG-RED-BR: br ≤ br_safe (đỏ) ⟹ cap_surplus = 0 ⟹ grant = 0 → reject.
test ig_neg_red_backing() fail {
  let din  = t_ig_din(ig_credit)
  let dout = t_ig_dout(din, ig_grant, 10)
  let refs = [
    t_um_ref(1_000_000_000, 10),
    t_backing_ref(1_400_000_000, 1_000_000_000_000, False, 10),   // br = 1.4 < 1.5
  ]
  let tx = t_ig_tx(din, dout, din.lamp_balance, refs, [t_owner])
  t_ig_call(din, ig_grant, 10, tx)
}

// IG-NEG-DEPEG: depeg flag shuts the door regardless of br.
test ig_neg_depeg() fail {
  let din  = t_ig_din(ig_credit)
  let dout = t_ig_dout(din, ig_grant, 10)
  let refs = [
    t_um_ref(1_000_000_000, 10),
    t_backing_ref(2_000_000_000, 1_000_000_000_000, True, 10),
  ]
  let tx = t_ig_tx(din, dout, din.lamp_balance, refs, [t_owner])
  t_ig_call(din, ig_grant, 10, tx)
}

// IG-NEG-STALE-BEACON: beacon older than max_backing_stale = absent → closed.
test ig_neg_stale_beacon() fail {
  let din  = t_ig_din(ig_credit)
  let dout = t_ig_dout(din, ig_grant, 10)
  let refs = [
    t_um_ref(1_000_000_000, 10),
    t_backing_ref(2_000_000_000, 1_000_000_000_000, False, 8),   // 2 epochs old
  ]
  let tx = t_ig_tx(din, dout, din.lamp_balance, refs, [t_owner])
  t_ig_call(din, ig_grant, 10, tx)
}

// IG-NEG-NO-BEACON: no beacon reference input at all → fail-closed.
test ig_neg_missing_beacon() fail {
  let din  = t_ig_din(ig_credit)
  let dout = t_ig_dout(din, ig_grant, 10)
  let tx = t_ig_tx(din, dout, din.lamp_balance, [t_um_ref(1_000_000_000, 10)], [t_owner])
  t_ig_call(din, ig_grant, 10, tx)
}

// IG-NEG-FORGED-BEACON: right NFT, WRONG address → rejected by the address pin.
test ig_neg_forged_beacon_address() fail {
  let din  = t_ig_din(ig_credit)
  let dout = t_ig_dout(din, ig_grant, 10)
  let forged =
    Input {
      output_reference: OutputReference { transaction_id: t_tx_id, output_index: 2 },
      output: Output {
        address: address.from_script(t_vault_hash),   // attacker-controlled
        value: assets.from_asset(t_backing_policy, #"425251", 1),
        datum: InlineDatum(BackingBeaconDatum {
          br_q: 9_000_000_000, magic_supply: 1_000_000_000_000,
          depeg: False, last_updated_epoch: 10,
        }),
        reference_script: None,
      },
    }
  let tx = t_ig_tx(din, dout, din.lamp_balance, [t_um_ref(1_000_000_000, 10), forged], [t_owner])
  t_ig_call(din, ig_grant, 10, tx)
}

// IG-NEG-NO-SCHEDULE: no ScheduleGen contract ⟹ pp = 0 ⟹ 0.5×pp = 0 ⟹ closed.
// Documents the dual-ceiling behaviour: InstantGen can never run ahead of the
// committed Schedule flow.
test ig_neg_no_schedule_cap_zero() fail {
  let base = t_ig_din(ig_credit)
  let din  = VaultDatum { ..base, gen_schedules: [] }
  let dout = t_ig_dout(din, ig_grant, 10)
  let tx = t_ig_tx(din, dout, din.lamp_balance, t_ig_refs_ok(10), [t_owner])
  t_ig_call(din, ig_grant, 10, tx)
}

// IG-NEG-NOT-ELIGIBLE: LAMP below min_instant_holding → door closed.
test ig_neg_below_min_holding() fail {
  let base = t_ig_din(ig_credit)
  let din = VaultDatum {
    ..base,
    lamp_balance: min_instant_holding - 1,
    loyalty_holdings: [t_holding(min_instant_holding - 1, 5, False)],
  }
  let dout = t_ig_dout(din, ig_grant, 10)
  let tx = t_ig_tx(din, dout, din.lamp_balance, t_ig_refs_ok(10), [t_owner])
  t_ig_call(din, ig_grant, 10, tx)
}

// IG-NEG-ALL-LOCKED: LAMP present but fully locked → not eligible.
test ig_neg_all_locked() fail {
  let base = t_ig_din(ig_credit)
  let din = VaultDatum {
    ..base,
    lamp_locked: base.lamp_balance,
    loyalty_holdings: [t_holding(base.lamp_balance, 5, True)],
  }
  let dout = t_ig_dout(din, ig_grant, 10)
  let tx = t_ig_tx(din, dout, din.lamp_balance, t_ig_refs_ok(10), [t_owner])
  t_ig_call(din, ig_grant, 10, tx)
}

// IG-NEG-NO-SIG: owner must sign.
test ig_neg_no_owner_sig() fail {
  let din  = t_ig_din(ig_credit)
  let dout = t_ig_dout(din, ig_grant, 10)
  let tx = t_ig_tx(din, dout, din.lamp_balance, t_ig_refs_ok(10), [])
  t_ig_call(din, ig_grant, 10, tx)
}

// IG-NEG-STALE-UM: stale UM falls back to 0.5× ⟹ grant 105M ≠ claimed 210M.
// (The tx is not rejected outright — C-UM-6 is a rate penalty, not a hard stop.)
test ig_neg_stale_um_changes_grant() fail {
  let din  = t_ig_din(ig_credit)
  let dout = t_ig_dout(din, ig_grant, 10)
  let refs = [
    t_um_ref(1_000_000_000, 8),                                    // 2 epochs stale
    t_backing_ref(2_000_000_000, 1_000_000_000_000, False, 10),
  ]
  let tx = t_ig_tx(din, dout, din.lamp_balance, refs, [t_owner])
  t_ig_call(din, ig_grant, 10, tx)
}

// IG-POS-STALE-UM: the SAME tx with the fallback-derived grant is accepted.
//   210_000_000 × 0.5 → step2 = 100_000_000 ; × PM 1.05 = 105_000_000
test ig_positive_stale_um_fallback_grant() {
  let din  = t_ig_din(ig_credit)
  let dout = t_ig_dout(din, 105_000_000, 10)
  let refs = [
    t_um_ref(1_000_000_000, 8),
    t_backing_ref(2_000_000_000, 1_000_000_000_000, False, 10),
  ]
  let tx = t_ig_tx(din, dout, din.lamp_balance, refs, [t_owner])
  t_ig_call(din, 105_000_000, 10, tx)
}

// IG-POS-CLIFF: a dead batch from a previous epoch is dropped by the same tx.
test ig_positive_drops_dead_batch() {
  let base = t_ig_din(ig_credit)
  let din  = VaultDatum { ..base, magic_batches: [t_instant_batch(9, 5_000)] }
  let dout = t_ig_dout(din, ig_grant, 10)   // t_ig_dout prunes at `epoch`
  let tx = t_ig_tx(din, dout, din.lamp_balance, t_ig_refs_ok(10), [t_owner])
  t_ig_call(din, ig_grant, 10, tx)
}

// ═══════════════════════════════════════════════════════════════
// Tests — VALUE preservation (ADA drain / token-set stuffing)
// and epoch monotonicity (validity-range gaming).
//
// `t_vault_output`/`t_vault_input` carry NO lovelace and exactly one policy
// (LAMP), so the default tests above satisfy validate_vault_value vacuously
// (0 >= 0, 1 ≤ 2). These tests use lovelace-carrying / extra-token outputs to
// exercise the guard directly.
// ═══════════════════════════════════════════════════════════════

const t_other_policy: ByteArray =
  #"55555555555555555555555555555555555555555555555555555555"

/// Vault output with explicit lovelace + LAMP balance.
fn t_vault_output_ada(datum: VaultDatum, lovelace: Int, balance: Int) -> Output {
  Output {
    address: address.from_script(t_vault_hash),
    value: assets.from_lovelace(lovelace)
      |> assets.add(t_lamp_policy, #"744c414d50", balance)
      |> assets.add(t_vault_hash, t_vault_id_name, 1),
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
      |> assets.add(t_vault_hash, t_vault_id_name, 1)
      |> assets.add(t_other_policy, #"6475737400", 1),  // "dust" → 4th policy
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

// VAL-POS-1: PruneExpired preserves ADA (in 2 ADA, out 2 ADA) → ok.
test val_pos_pe_ada_preserved() {
  let dead = t_instant_batch(9, 1000)
  let din  = t_datum_with_batches([dead])
  let dout = t_datum_with_batches([])
  let tx =
    t_tx(
      [t_vault_input_ada(din, 2_000_000, 100)],
      [t_vault_output_ada(dout, 2_000_000, 100)],
      [],
    )
  validate_prune_expired(din, 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// VAL-NEG-1: PruneExpired (permissionless) drains ADA → reject.
test val_neg_pe_ada_drained() fail {
  let dead = t_instant_batch(9, 1000)
  let din  = t_datum_with_batches([dead])
  let dout = t_datum_with_batches([])
  let tx =
    t_tx(
      [t_vault_input_ada(din, 5_000_000, 100)],   // vault held 5 ADA
      [t_vault_output_ada(dout, 2_000_000, 100)], // attacker pockets 3 ADA
      [],
    )
  validate_prune_expired(din, 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// VAL-NEG-2: PruneExpired stuffs a 3rd-policy dust token (UTxO bloat) → reject.
test val_neg_pe_dust_stuffed() fail {
  let dead = t_instant_batch(9, 1000)
  let din  = t_datum_with_batches([dead])
  let dout = t_datum_with_batches([])
  let tx =
    t_tx(
      [t_vault_input_ada(din, 2_000_000, 100)],
      [t_vault_output_dust(dout, 2_000_000, 100)],  // 3 policies: ADA+LAMP+dust
      [],
    )
  validate_prune_expired(din, 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// VAL-NEG-3: BurnBatch drains ADA on the delegate path → reject.
test val_neg_burn_ada_drained() fail {
  let din  = t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate))
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10)
  let tx =
    t_tx(
      [t_vault_input_ada(din, 5_000_000, 100)],
      [t_vault_output_ada(dout, 2_000_000, 100)],
      [t_delegate],
    )
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// VAL-POS-2: ADA top-up (out > in) is allowed (honest min-ADA bump).
test val_pos_ada_topup_ok() {
  let din  = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10)
  let tx =
    t_tx(
      [t_vault_input_ada(din, 2_000_000, 100)],
      [t_vault_output_ada(dout, 3_000_000, 100)],  // owner adds ADA — fine
      [t_owner],
    )
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// EPOCH-NEG-1: BurnBatch with current_epoch < last_updated_epoch (backwards
// time, delegate path) → reject by the monotonicity guard.
test epoch_neg_burn_backwards() fail {
  let din_base = t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate))
  // vault already at epoch 20; attacker claims epoch 10 to revive dead MAGIC.
  let din = VaultDatum { ..din_base, last_updated_epoch: 20 }
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
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

// ═══════════════════════════════════════════════════════════════
// Tests — VAULT-IDENTITY STATE-THREAD NFT (MAINNET-BLOCK)
//
// Closes the fabricated-datum hole: a UTxO placed at the vault script address
// with an attacker-authored inline datum but NO vault_id NFT can no longer be
// spent by any handler, and the mint policy forces a genesis-clean datum bound
// to the real deposited LAMP.
// ═══════════════════════════════════════════════════════════════

// ── Fabricated (NO-NFT) vault fixtures — the attacker's UTxO ──────────────
fn t_vault_output_nonft(datum: VaultDatum, balance: Int) -> Output {
  Output {
    address: address.from_script(t_vault_hash),
    value: assets.from_asset(t_lamp_policy, #"744c414d50", balance),  // NO NFT
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn t_vault_input_nonft(datum: VaultDatum, balance: Int) -> Input {
  Input {
    output_reference: t_own_ref(),
    output: t_vault_output_nonft(datum, balance),
  }
}

// ── Mint helpers ──────────────────────────────────────────────────────────
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
    value: assets.from_asset(t_lamp_policy, #"744c414d50", balance)
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
    t_lamp_policy, t_lamp_asset_name, t_um_policy, t_um_hash, t_backing_policy,
    t_backing_hash, 86_400_000, MintVaultId { seed }, policy_id, tx,
  )
}

/// Clean genesis datum (all fields at initial value); owner = t_owner.
fn t_clean_genesis(balance: Int) -> VaultDatum {
  // Any valid profile passes the mint gate (profile is no longer pinned).
  // Keep Lantern here; t_datum defaults to Flame for spend-path fixtures.
  VaultDatum { ..t_datum(balance, 0, [t_holding(balance, 5, False)]), profile: Lantern }
}

// ── POC: fabricated vault spent via InstantGen now FAILS ──────────────────
// Pre-fix this extracted REAL MAGIC from a 100%-fabricated consumed_credit. The
// tx is well-formed (valid UM + backing refs, correct claimed grant) and passes
// every economic check; it now dies at validate_vault_value → single_nft_name
// because the fabricated input carries no vault_id NFT.
test poc_fabricated_magic_instant_gen_fails() fail {
  let din  = t_ig_din(ig_credit)                 // attacker-authored consumed_credit
  let dout = t_ig_dout(din, ig_grant, 10)
  let tx =
    Transaction {
      ..placeholder,
      inputs: [t_vault_input_nonft(din, din.lamp_balance)],
      reference_inputs: t_ig_refs_ok(10),
      outputs: [t_vault_output_nonft(dout, din.lamp_balance)],
      extra_signatories: [t_owner],
    }
  t_ig_call(din, ig_grant, 10, tx)
}

// ── POC: fabricated MAGIC batch burned via BurnBatch now FAILS ─────────────
// Pre-fix, a fabricated 10^18 batch could be consumed to pay a ConsumeMAGIC
// co-spend. Now the no-NFT input is rejected at validate_vault_value.
test poc_fabricated_magic_burn_batch_fails() fail {
  let fake = t_burn_batch(bid_a, 1_000_000_000_000_000_000)   // fabricated 10^18
  let din  = t_burn_din([fake], None)
  let dout =
    t_burn_dout(
      din,
      [MagicBatch { ..fake, current_amount: fake.current_amount - 500 }],
      500, 10,
    )
  let tx =
    t_tx([t_vault_input_nonft(din, 100)], [t_vault_output_nonft(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid_a, 500)], 10, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
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
      magic_batches: [t_instant_batch(0, 1_000_000_000_000_000_000)],
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
  // tx does NOT spend the seed UTxO (spends an unrelated input).
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

// ── spend_preserves_nft_ok: continuing output keeps the NFT → passes ───────
test spend_preserves_nft_ok() {
  let din  = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx   = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}

// ── spend_drops_nft_fail: input has NFT, output drops it → rejected ────────
test spend_drops_nft_fail() fail {
  let din  = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx   = t_tx([t_vault_input(din, 100)], [t_vault_output_nonft(dout, 95)], [t_owner])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_lamp_policy, t_lamp_asset_name, tx)
}
