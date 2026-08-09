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

use aiken/cbor
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto
use aiken/interval.{Finite, IntervalBoundType}
use aiken/primitive/bytearray
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}

use magiclamp/protocol/types.{
  ActivityProfile, ActivityState, BurnBatch, DelegationCertificate, Ember,
  Flame, LoyaltyHolding, MagicBatch, PendingProfile, SetDelegate, Snapshot,
  StreakState, TriggerSnapshot, UpdateProfile, VaultAttribution, VaultDatum,
  VaultRedeemer, WithdrawLamp,
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

// ══════════════════════════════════════════════════════════════
// VAULT-IDENTITY STATE-THREAD NFT — genesis-clean anchor (MAINNET-BLOCK)
//
// THE HOLE (genesis-vault-has-no-anchor): Cardano runs a validator only when a
// UTxO is SPENT, never when it is CREATED. The vault script address is public
// (= hash of this validator + params). An attacker pays min-ADA to place a UTxO
// at the vault address with a FABRICATED inline datum (`lamp_balance = 10^15`,
// favourable activity_state, `owner = attacker`), then spends it via
// TriggerSnapshot. `validate_snapshot` only checks `list.has(extra_signatories,
// owner)` and the owner is self-declared, so the attacker self-signs; the
// fabricated `lamp_balance` flows straight into `compute_snapshot_magic` →
// MAGIC minted from nothing. Nothing validated the datum at creation.
//
// THE FIX: a state-thread NFT whose ONLY way into existence runs a policy (the
// `mint` handler below) that PROVES the vault started clean, and whose presence
// is REQUIRED on every spend (see `validate_vault_value`). A fabricated vault
// (no NFT) cannot be spent by ANY handler — the singleton-list `expect` on the
// input's own vault_id tokens fails closed.
//
// WHY THIS IS A MULTI-PURPOSE VALIDATOR: the mint policy must bind the genesis
// NFT to THIS vault's script address (otherwise the attacker mints a clean NFT
// to a wallet, then in a plain tx re-homes it to the vault address with a DIRTY
// datum — no script runs on that creation, so the hole reopens). Binding needs
// the vault hash inside the mint policy, while the spend side needs the mint
// policy id — a MUTUAL apply-param fixed point that is undeployable (circular-
// apply-param trap). Folding the mint handler INTO the vault validator breaks
// the cycle: here `policy_id (mint) == script_hash == the Script credential of
// the spend address`, all known via self-reference, no param, no cycle. The
// single script hash IS the vault_id policy id.
//
// The asset name is `blake2b_256(cbor.serialise(seed_output_reference))` so each
// vault is a distinct one-shot (permissionless, unique per spent seed UTxO).
// ══════════════════════════════════════════════════════════════
pub type VaultIdRedeemer {
  // Mint a fresh vault-identity NFT + park a genesis-clean vault UTxO.
  MintVaultId { seed: OutputReference }
  // Burn the NFT (qty < 0 only). A spend that also burns the NFT still fails
  // `validate_vault_value` (the NFT must survive on the continuing output), so
  // under the current handler set the NFT is permanent. Kept for forward-compat.
  BurnVaultId
}

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
// `lamp_asset_name` is the on-chain asset name of the LAMP token, applied at
// deploy time per-network (MAINNET-BLOCK fix): mainnet LAMP and testnet tLAMP
// carry DIFFERENT asset names, so the value-preservation check must read the
// quantity of the network's actual LAMP asset — never a hardcoded literal.
// Offchain mirror: scripts ASSET_NAMES.lamp / TESTNET_CONFIG.lampAssetName.
validator vault(
  lamp_policy_id   : PolicyId,
  lamp_asset_name  : ByteArray,
  ms_per_epoch     : Int,
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
    expect Some(input_datum) = datum_opt

    // Current epoch from tx validity range lower bound (POSIX ms)
    let current_epoch = get_current_epoch(tx, ms_per_epoch)

    when redeemer is {

      // ── TriggerSnapshot ─────────────────────────────────────
      TriggerSnapshot ->
        validate_snapshot(input_datum, current_epoch, own_ref, lamp_policy_id, lamp_asset_name, tx)

      // ── BurnBatch (datum-consume MAGIC — D1) ────────────────
      // Reduce magic_batches[].current_amount in-datum. NO token, NO mint.
      // `required` = Σ burns (datum mechanics). The price×count beacon
      // cross-check lives in the co-spending ConsumeMAGIC validator (D1
      // "Liên kết 2 validator"): both validators read the same op_type/
      // op_count, ConsumeMAGIC asserts Σ burns == price_of(pp,op)×count.
      // The vault here owns the *datum mechanics* only (separation of concern).
      BurnBatch { burns } ->
        validate_burn_batch(
          input_datum, burns, current_epoch, own_ref, lamp_policy_id, lamp_asset_name, tx,
        )

      // ── UpdateProfile (full impl — SPEC_V1 §2) ───────────────
      UpdateProfile { new_profile } ->
        validate_update_profile(
          input_datum, new_profile, current_epoch, own_ref, tx,
        )

      // ── WithdrawLamp (SPEC_V1 §1) ────────────────────────────
      WithdrawLamp { amount } ->
        validate_withdraw_lamp(
          input_datum, amount, current_epoch, own_ref, lamp_policy_id, lamp_asset_name, tx,
        )

      // ── SetDelegate (consume-delegate — D1) ──────────────────
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
// LAMP sitting in the parked output — using the PARAM `lamp_asset_name` (never a
// hardcoded literal: mainnet LAMP and testnet tLAMP carry different names).
// ═══════════════════════════════════════════════════════════════
fn validate_mint_vault_id(
  seed            : OutputReference,
  policy_id       : PolicyId,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
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
  // vault spend address. Binding the NFT to it here stops "mint clean → re-home
  // dirty": the NFT is born at the vault address and can never leave it (spend
  // always preserves it to the continuing output).
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
  // did not deposit). This is the exact lever the attack fabricated for
  // compute_snapshot_magic.
  let lamp_qty = assets.quantity_of(vault_out.value, lamp_policy_id, lamp_asset_name)
  expect vd.lamp_balance == lamp_qty
  expect vd.lamp_locked == 0
  expect sum_holdings(vd.loyalty_holdings) == vd.lamp_balance
  expect list.all(vd.loyalty_holdings, fn(h) { !h.is_locked })
  expect list.length(vd.loyalty_holdings) <= max_loyalty_holdings

  // MAGIC / batch state MUST be empty.
  expect vd.magic_batches == []
  expect vd.next_batch_index == 0

  // activity_state fully clean — recent_burn_epochs empty, count zeroed. A
  // fabricated favourable activity_state would inflate OAC.
  expect vd.activity_state == ActivityState {
    recent_burn_epochs: [],
    total_burns_count: 0,
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
  // accumulated state. The type is bounded to 3 valid values and is changeable
  // via UpdateProfile (cooldown), so any of them is a valid genesis strategy;
  // pinning gives no security benefit and would reject vaults the standard
  // off-chain flow creates (default Flame).

  // ── No dust bundled into the genesis output ──────────────────────────────
  // At most {ADA, LAMP, vault_id NFT}.
  expect list.length(assets.policies(vault_out.value)) <= 3

  True
}

/// Burn path: allowed only for NEGATIVE quantities under this policy. This can
/// never sneak in a mint (all qty < 0), and a spend that also burns the NFT is
/// rejected by `validate_vault_value` (the NFT must survive on the continuing
/// output).
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
// validate_snapshot — all C-SS-* constraints
// ═══════════════════════════════════════════════════════════════
fn validate_snapshot(
  input_datum     : VaultDatum,
  current_epoch   : Int,
  own_ref         : OutputReference,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
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

  // ── VALUE PRESERVATION (MED value-leak) ─────────────────────
  // Snapshot moves NO LAMP, but the datum is fully rewritten. Without
  // tying the continuing output's LAMP token quantity to lamp_balance, an
  // owner could siphon LAMP out of the vault (datum says 1000, output
  // carries 1) in the same tx that mints MAGIC. Symmetric to WithdrawLamp
  // W-6 / InstantGen value check: the LEDGER value must back the datum.
  let vault_output   = find_vault_output(tx.outputs, vault_addr)
  let vault_lamp_qty =
    assets.quantity_of(vault_output.value, lamp_policy_id, lamp_asset_name)
  expect vault_lamp_qty == output_datum.lamp_balance

  // ── GENESIS ANCHOR + ADA / token-set preservation (MAINNET-BLOCK) ─────────
  // Requires the vault_id NFT on BOTH input and continuing output. A fabricated
  // vault (no NFT) fails here, so its fabricated lamp_balance never reaches
  // compute_snapshot_magic.
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), vault_output)

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

/// Find the currently-being-spent vault Input (used for value preservation).
fn find_own_input(own_ref: OutputReference, inputs: List<Input>) -> Input {
  expect Some(own_input) = list.find(inputs, fn(i) { i.output_reference == own_ref })
  own_input
}

/// VALUE-PRESERVATION guard (MAINNET-BLOCK — genesis anchor + ADA drain).
///
/// Called by EVERY spend handler. Three checks:
///   - VAULT-IDENTITY NFT preserved: the spent input must carry EXACTLY one
///     asset under the vault_id policy (== this validator's own script hash),
///     and the continuing output must carry the SAME (policy, name) qty 1. This
///     is the genesis-vault-has-no-anchor fix: a FABRICATED vault (placed at the
///     script address with no NFT — no policy ran to vet its datum) has an EMPTY
///     token list under the vault_id policy, so `single_nft_name` fails closed
///     and the vault cannot be spent by ANY handler. The NFT is born genesis-
///     clean (validate_mint_vault_id) and re-pinned on every transition.
///   - lovelace(out) >= lovelace(in)  → surplus ADA cannot be siphoned (`>=`
///     lets an honest caller top up ADA, never shrink it).
///   - |policies(out)| <= 3           → at most {ADA, LAMP, vault_id NFT};
///     rejects extra policies so dust stuffing cannot bloat/brick the UTxO.
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
/// carrying zero vault_id tokens is rejected right here (empty list fails).
fn single_nft_name(value: Value, policy: PolicyId) -> ByteArray {
  expect [Pair(name, qty)] = assets.tokens(value, policy) |> dict.to_pairs
  expect qty == 1
  name
}

fn find_vault_output(outputs: List<Output>, vault_addr: Address) -> Output {
  // C-VAULT-OUT-1 (PR #11 review): exactly one continuing vault output, symmetric
  // to the input==1 check. Blocks a phantom 2nd vault output carrying a forged datum.
  expect list.count(outputs, fn(o) { o.address == vault_addr }) == 1
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
  input_datum     : VaultDatum,
  amount          : Int,
  _current_epoch  : Int,
  own_ref         : OutputReference,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
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
  // last_updated_epoch PRESERVED (PR #11 review pt4): withdraw must NOT advance
  // it — doing so would reset the Snapshot catch-up window and forfeit MAGIC
  // accrued over elapsed epochs. Withdraw is LAMP-only, orthogonal to snapshot.
  expect output_datum.last_updated_epoch == input_datum.last_updated_epoch

  // W-6: vault output value carries the new lamp_balance worth of LAMP
  let vault_output = find_vault_output(tx.outputs, vault_addr)
  let vault_lamp_qty =
    assets.quantity_of(vault_output.value, lamp_policy_id, lamp_asset_name)
  expect vault_lamp_qty == new_lamp_balance

  // W-7: Σholdings == lamp_balance
  expect sum_holdings(output_datum.loyalty_holdings) == output_datum.lamp_balance

  // C-VAULT-13: |holdings| ≤ 64 (defensive — shouldn't grow on withdraw)
  expect list.length(output_datum.loyalty_holdings) <= max_loyalty_holdings

  // ── GENESIS ANCHOR + ADA / token-set preservation (MAINNET-BLOCK) ─────────
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), vault_output)

  True
}

// ═══════════════════════════════════════════════════════════════
// validate_burn_batch — datum-consume MAGIC (D1)
// ═══════════════════════════════════════════════════════════════
// Consume MAGIC = REDUCE magic_batches[].current_amount in-datum. No token,
// no mint. `required` (= price×count from the beacon) is enforced by the
// co-spending ConsumeMAGIC validator; the vault asserts the *datum mechanics*:
//   - Σ burns subtracted exactly from the named batches (== not ≥: over-burn
//     in an accounting model would destroy the user's MAGIC for free → banned)
//   - every other batch field immutable (T4 sameness)
//   - batches that reach current_amount==0 are pruned
//   - batches NOT in `burns` still run decay (prune_expired_batches)
//   - full A02 (17 fields) + value preservation (LAMP cannot leak)
//   - owner OR personal_delegate (consume-delegate) may trigger
fn validate_burn_batch(
  input_datum     : VaultDatum,
  burns           : List<(ByteArray, Int)>,
  current_epoch   : Int,
  own_ref         : OutputReference,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {

  // ── DS-1: exactly one vault input + one vault output ────────
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

  // ── AUTH: owner OR consume-delegate signs ───────────────────
  let authed =
    list.has(tx.extra_signatories, input_datum.owner) || when input_datum.personal_delegate is {
      Some(d) -> list.has(tx.extra_signatories, d)
      None    -> False
    }
  expect authed

  // ── burns non-empty + total ─────────────────────────────────
  expect !list.is_empty(burns)
  let total_burned =
    list.foldl(burns, 0, fn(b, acc) {
      let (_, amt) = b
      acc + amt
    })
  expect total_burned > 0

  // ── Lazy profile apply (as every handler) ───────────────────
  let applied = apply_pending_profile(input_datum, current_epoch)

  // ── Decay first (batches NOT in burns still age/prune), then
  //    apply burns to the decayed list ─────────────────────────
  let decayed = prune_expired_batches(applied.magic_batches, current_epoch)
  let expected_batches = apply_burns(decayed, burns)

  // ── A02: field-by-field (17 fields) ─────────────────────────
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  expect output_datum.owner == applied.owner
  expect output_datum.lamp_balance == applied.lamp_balance        // BurnBatch never touches LAMP
  expect output_datum.lamp_locked == applied.lamp_locked
  expect output_datum.loyalty_holdings == applied.loyalty_holdings
  expect output_datum.magic_batches == expected_batches           // ← only MAGIC change
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
  // last_updated_epoch PRESERVED (HIGH rewind fix, symmetric to WithdrawLamp W-4
  // line 327): BurnBatch is orthogonal to snapshot generation and must NOT advance
  // the catch-up clock. Advancing it forward forfeits accrued snapshot MAGIC; worse,
  // because current_epoch is owner-chosen via validity_range.lower_bound (no past
  // guard at the ledger), forcing `== current_epoch` would let the owner REWIND
  // last_updated_epoch to a past epoch, then mint Δe× catch-up MAGIC on the next
  // TriggerSnapshot. Preserving from input closes that hole.
  expect output_datum.last_updated_epoch == applied.last_updated_epoch
  expect output_datum.attribution.total_events == applied.attribution.total_events + 1
  expect output_datum.attribution.last_event_epoch == current_epoch

  // C-VAULT-1: batch count ≤ 32
  expect list.length(output_datum.magic_batches) <= max_batches_per_vault

  // ── VALUE PRESERVATION (anti value-leak) ────────────────────
  let vault_output = find_vault_output(tx.outputs, vault_addr)
  let vault_lamp_qty =
    assets.quantity_of(vault_output.value, lamp_policy_id, lamp_asset_name)
  expect vault_lamp_qty == output_datum.lamp_balance

  // ── GENESIS ANCHOR + ADA / token-set preservation (MAINNET-BLOCK) ─────────
  // Delegate-callable path: bind the vault_id NFT + ADA + policy-set so a
  // delegate cannot spend a fabricated vault, siphon ADA, or brick the vault.
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), vault_output)

  True
}

/// apply_burns — subtract each (batch_id, amt) from the matching batch.
/// Invariants (D1): each batch_id matches exactly one batch; amt > 0 and
/// amt ≤ current_amount; current_amount' = current_amount − amt; batch is
/// PRUNED iff current_amount' == 0; every other field immutable; order of
/// untouched batches preserved.
fn apply_burns(
  batches : List<MagicBatch>,
  burns   : List<(ByteArray, Int)>,
) -> List<MagicBatch> {
  when burns is {
    [] -> batches
    [(bid, amt), ..rest] -> {
      expect amt > 0
      // exactly one batch carries this batch_id
      expect list.count(batches, fn(b) { b.batch_id == bid }) == 1
      let after =
        list.filter_map(batches, fn(b) {
          if b.batch_id == bid {
            expect amt <= b.current_amount
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
      apply_burns(after, rest)
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// validate_set_delegate — set/clear consume-delegate (D1)
// ═══════════════════════════════════════════════════════════════
// Reuses VaultDatum.personal_delegate (field 15) as the consume-delegate.
// Only the owner may change it (a delegate cannot re-delegate). No cooldown
// (cheap, no economic effect). Everything else immutable; LAMP preserved.
fn validate_set_delegate(
  input_datum     : VaultDatum,
  new_delegate    : Option<ByteArray>,
  current_epoch   : Int,
  own_ref         : OutputReference,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {

  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

  // ONLY owner sets delegate
  expect list.has(tx.extra_signatories, input_datum.owner)

  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  // Everything unchanged except personal_delegate + last_updated_epoch
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

  // KEY: delegate updated. last_updated_epoch PRESERVED (HIGH rewind fix,
  // symmetric to WithdrawLamp W-4 line 327): SetDelegate is orthogonal to snapshot
  // generation and must NOT advance the catch-up clock. Because current_epoch is
  // owner-chosen via validity_range.lower_bound (no past guard at the ledger),
  // forcing `== current_epoch` would let the owner REWIND last_updated_epoch with a
  // backdated, owner-signed, MAGIC-free SetDelegate, then mint Δe× catch-up MAGIC on
  // the next TriggerSnapshot. Preserving from input closes that hole.
  expect output_datum.personal_delegate == new_delegate
  expect output_datum.last_updated_epoch == input_datum.last_updated_epoch

  // Value preserved (SetDelegate touches no LAMP)
  let vault_output = find_vault_output(tx.outputs, vault_addr)
  let vault_lamp_qty =
    assets.quantity_of(vault_output.value, lamp_policy_id, lamp_asset_name)
  expect vault_lamp_qty == output_datum.lamp_balance

  // ── GENESIS ANCHOR + ADA / token-set preservation (MAINNET-BLOCK) ─────────
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), vault_output)

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

  // ── GENESIS ANCHOR + ADA / token-set preservation (MAINNET-BLOCK) ─────────
  // UpdateProfile is owner-signed and LAMP-neutral, but previously bound NO
  // output value at all. Bind the vault_id NFT (fabricated vault fails) + ADA /
  // policy-set so the output cannot be drained, dust-stuffed, or de-anchored.
  let vault_output = find_vault_output(tx.outputs, vault_addr)
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), vault_output)

  True
}

// ═══════════════════════════════════════════════════════════════
// Tests — WithdrawLamp + UpdateProfile (PR #11 review pt5)
// Co-located so they can call the private validate_* handlers.
// Negatives use the `fail` annotation: the test passes iff the body
// errors (an `expect` inside the validator rejects the tx).
// ═══════════════════════════════════════════════════════════════

const t_owner: ByteArray =
  #"00000000000000000000000000000000000000000000000000000000"
const t_vault_hash: ByteArray =
  #"11111111111111111111111111111111111111111111111111111111"
const t_lamp_policy: ByteArray =
  #"22222222222222222222222222222222222222222222222222222222"
// Arbitrary asset name for tests — proves the value-check reads the PARAMETER,
// not a hardcoded testnet literal (MAINNET-BLOCK fix). t_vault_output mints
// this same name so the quantity_of lookup succeeds.
const t_lamp_name: ByteArray = #"4c414d50"  // "LAMP"
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

// vault-identity NFT for fixtures: policy == the vault script hash (t_vault_hash,
// == the payment credential of the vault address), so validate_vault_value reads
// this policy off the input. Name is arbitrary — the spend binds by the EXACT
// name read from the input, so any fixed name works as long as in & out agree.
const t_vault_id_name: ByteArray = #"5641554c544944"  // "VAULTID"

fn t_vault_output(datum: VaultDatum, balance: Int) -> Output {
  Output {
    address: address.from_script(t_vault_hash),
    value: assets.from_asset(t_lamp_policy, t_lamp_name, balance)
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
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

test w_amount_zero() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(din, 100)], [t_owner])
  validate_withdraw_lamp(din, 0, 0, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

test w_over_avail() fail {
  // all 100 locked → avail 0; withdrawing 5 violates W-3
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
  // two outputs at the vault address → C-VAULT-OUT-1 rejects
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
  // output advances last_updated_epoch (5) while input was 0 → pt4 preserve rejects
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
  let din = t_datum(100, 0, [t_holding(100, 5, False)])  // Flame, pce 0
  let dout = up_output(din, Ember, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_update_profile(din, Ember, 10, t_own_ref(), tx)
}

test up_cooldown_not_met() fail {
  // pce=10, current=11 → 1 < 2 cooldown (C-PC-V2)
  let din =
    VaultDatum {
      ..t_datum(100, 0, [t_holding(100, 5, False)]),
      profile_changed_epoch: 10,
    }
  let dout = up_output(din, Ember, 11)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_update_profile(din, Ember, 11, t_own_ref(), tx)
}

test up_bypass_lazy() fail {
  // output sets profile directly (Ember) instead of leaving Flame + pending (C-PC-V6)
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = VaultDatum { ..up_output(din, Ember, 10), profile: Ember }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_update_profile(din, Ember, 10, t_own_ref(), tx)
}

test up_same_profile() fail {
  // new profile == current (Flame) → C-PC-V3
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = up_output(din, Flame, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_update_profile(din, Flame, 10, t_own_ref(), tx)
}

// ── BurnBatch (datum-consume MAGIC) ───────────────────────────

const t_delegate: ByteArray =
  #"44444444444444444444444444444444444444444444444444444444"

/// A snapshot MagicBatch (decay_window large enough to survive the test epoch).
fn t_snap_batch(id: ByteArray, created: Int, amount: Int) -> MagicBatch {
  MagicBatch {
    batch_id:            id,
    source:              Snapshot,
    created_epoch:       created,
    initial_amount:      amount,
    current_amount:      amount,
    decay_window:        9,            // Lantern N — survives small Δ
    profile_at_creation: Some(Flame),
    contract_id:         None,
    halved:              False,
  }
}

fn t_datum_batches(batches: List<MagicBatch>) -> VaultDatum {
  VaultDatum { ..t_datum(100, 0, [t_holding(100, 5, False)]), magic_batches: batches }
}

/// Output datum after a valid BurnBatch at `current`: attribution +1.
/// last_updated_epoch is PRESERVED from input (HIGH rewind fix) — t_datum_batches
/// has last_updated_epoch=0, so the valid output keeps 0 (only attribution.last_event_epoch
/// tracks `current`).
fn t_burn_out(batches: List<MagicBatch>, current: Int) -> VaultDatum {
  VaultDatum {
    ..t_datum_batches(batches),
    attribution: VaultAttribution {
      attribution_root: #"", last_event_epoch: current, total_events: 1,
    },
  }
}

// BB-POS-1: partial burn — current_amount reduced, batch kept,
//   initial_amount immutable (only current_amount changes — T4 sameness)
test bb_positive_partial() {
  let bid = #"b1"
  let in_b  = t_snap_batch(bid, 4, 1000)                    // created 4
  let out_b = MagicBatch { ..in_b, current_amount: 700 }    // 1000 - 300
  let din  = t_datum_batches([in_b])
  let dout = t_burn_out([out_b], 5)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid, 300)], 5, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-POS-2: full burn → batch pruned from output
test bb_positive_full_prune() {
  let bid = #"b1"
  let din  = t_datum_batches([t_snap_batch(bid, 4, 1000)])
  let dout = t_burn_out([], 5)                              // batch removed
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid, 1000)], 5, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-POS-3: consume-delegate signs (owner absent) → allowed
test bb_positive_delegate_signs() {
  let bid = #"b1"
  let in_b = t_snap_batch(bid, 4, 1000)
  let out_b = MagicBatch { ..in_b, current_amount: 600 }   // 1000 - 400
  let base = t_datum_batches([in_b])
  let din  = VaultDatum { ..base, personal_delegate: Some(t_delegate) }
  let dout = VaultDatum {
    ..t_burn_out([out_b], 5),
    personal_delegate: Some(t_delegate),
  }
  // only the delegate signs, NOT the owner
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_burn_batch(din, [(bid, 400)], 5, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-1: no authorization (neither owner nor delegate) → fail
test bb_neg_no_auth() fail {
  let bid = #"b1"
  let din  = t_datum_batches([t_snap_batch(bid, 4, 1000)])
  let dout = t_burn_out([t_snap_batch(bid, 4, 700)], 5)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_burn_batch(din, [(bid, 300)], 5, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-2: burn amount exceeds current_amount → fail
test bb_neg_over_burn_batch() fail {
  let bid = #"b1"
  let din  = t_datum_batches([t_snap_batch(bid, 4, 1000)])
  let dout = t_burn_out([], 5)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid, 1001)], 5, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-3: output keeps un-burned amount (cheating the subtraction) → fail
test bb_neg_wrong_output_amount() fail {
  let bid = #"b1"
  let din  = t_datum_batches([t_snap_batch(bid, 4, 1000)])
  let dout = t_burn_out([t_snap_batch(bid, 4, 1000)], 5)    // not reduced
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid, 300)], 5, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-4: LAMP value-leak — output carries less LAMP than lamp_balance → fail
test bb_neg_lamp_value_leak() fail {
  let bid = #"b1"
  let din  = t_datum_batches([t_snap_batch(bid, 4, 1000)])
  let dout = t_burn_out([t_snap_batch(bid, 4, 700)], 5)     // datum lamp_balance=100
  // ledger only carries 1 LAMP — siphon attempt
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 1)], [t_owner])
  validate_burn_batch(din, [(bid, 300)], 5, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-5: mutate a non-amount batch field (source) → T4 sameness fail
test bb_neg_mutate_other_field() fail {
  let bid = #"b1"
  let din  = t_datum_batches([t_snap_batch(bid, 4, 1000)])
  let tampered = MagicBatch { ..t_snap_batch(bid, 4, 700), created_epoch: 99 }
  let dout = t_burn_out([tampered], 5)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid, 300)], 5, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-6: unknown batch_id (no matching batch) → fail
test bb_neg_unknown_batch() fail {
  let bid = #"b1"
  let din  = t_datum_batches([t_snap_batch(bid, 4, 1000)])
  let dout = t_burn_out([t_snap_batch(bid, 4, 1000)], 5)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(#"deadbeef", 300)], 5, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-7: attribution not incremented → fail
test bb_neg_attribution_stale() fail {
  let bid = #"b1"
  let din  = t_datum_batches([t_snap_batch(bid, 4, 1000)])
  let dout = VaultDatum {
    ..t_datum_batches([t_snap_batch(bid, 4, 700)]),
    // last_updated_epoch preserved at 0 (input value); ONLY attribution is wrong:
    // total_events stays 0 (should be 1) — isolates the attribution check.
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid, 300)], 5, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-8 (HIGH rewind fix): output ADVANCES last_updated_epoch instead of
// preserving it → rejected. Forcing the epoch forward (or, via a backdated
// validity range, backward) would corrupt the snapshot catch-up clock. BurnBatch
// must leave last_updated_epoch byte-identical to the input.
test bb_neg_advance_last_updated() fail {
  let bid = #"b1"
  let din  = t_datum_batches([t_snap_batch(bid, 4, 1000)])
  // input last_updated_epoch = 0; this output forces it to 5
  let dout = VaultDatum { ..t_burn_out([t_snap_batch(bid, 4, 700)], 5), last_updated_epoch: 5 }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid, 300)], 5, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-9 (HIGH rewind fix): the concrete attack — a vault already advanced to
// epoch 10 is burned with a BACKDATED validity range (current_epoch=3). Forcing
// `== current_epoch` would rewind last_updated_epoch 10→3, inflating the next
// snapshot Δe by 7. The preserve check rejects any output epoch ≠ input (10).
test bb_neg_rewind_via_backdated_range() fail {
  let bid = #"b1"
  let base = t_datum_batches([t_snap_batch(bid, 4, 1000)])
  let din  = VaultDatum { ..base, last_updated_epoch: 10 }
  // attacker tries to write last_updated_epoch = 3 (the backdated current_epoch)
  let dout = VaultDatum {
    ..t_datum_batches([t_snap_batch(bid, 4, 700)]),
    last_updated_epoch: 3,
    attribution: VaultAttribution {
      attribution_root: #"", last_event_epoch: 3, total_events: 1,
    },
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(bid, 300)], 3, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// ── SetDelegate ───────────────────────────────────────────────

// SD-POS-1: owner sets a delegate. last_updated_epoch PRESERVED from input (0):
// SetDelegate must not advance the snapshot catch-up clock (HIGH rewind fix).
test sd_positive_set() {
  let din  = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = VaultDatum {
    ..din, personal_delegate: Some(t_delegate),
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_set_delegate(din, Some(t_delegate), 7, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// SD-POS-2: owner clears the delegate (None). last_updated_epoch PRESERVED (0).
test sd_positive_clear() {
  let base = t_datum(100, 0, [t_holding(100, 5, False)])
  let din  = VaultDatum { ..base, personal_delegate: Some(t_delegate) }
  let dout = VaultDatum { ..din, personal_delegate: None }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_set_delegate(din, None, 7, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// SD-NEG-4 (HIGH rewind fix): owner sets delegate but ADVANCES last_updated_epoch
// (input 0 → output 7) → rejected. Same hole as BurnBatch: SetDelegate is MAGIC-free
// and owner-only, so writing the epoch lets the owner reset the catch-up clock at will.
test sd_neg_advance_last_updated() fail {
  let din  = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = VaultDatum {
    ..din, personal_delegate: Some(t_delegate), last_updated_epoch: 7,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_set_delegate(din, Some(t_delegate), 7, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// SD-NEG-5 (HIGH rewind fix): vault at epoch 10, owner submits a BACKDATED
// SetDelegate (current_epoch=3) writing last_updated_epoch=3 → rewind rejected.
test sd_neg_rewind_via_backdated_range() fail {
  let base = t_datum(100, 0, [t_holding(100, 5, False)])
  let din  = VaultDatum { ..base, last_updated_epoch: 10 }
  let dout = VaultDatum {
    ..din, personal_delegate: Some(t_delegate), last_updated_epoch: 3,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_set_delegate(din, Some(t_delegate), 3, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// SD-NEG-1: delegate (not owner) tries to change delegate → fail
test sd_neg_delegate_cannot_set() fail {
  let base = t_datum(100, 0, [t_holding(100, 5, False)])
  let din  = VaultDatum { ..base, personal_delegate: Some(t_delegate) }
  let dout = VaultDatum {
    ..din, personal_delegate: Some(t_owner), last_updated_epoch: 7,
  }
  // delegate signs, owner does not
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_set_delegate(din, Some(t_owner), 7, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// SD-NEG-2: SetDelegate must not move LAMP (value-leak) → fail
test sd_neg_lamp_leak() fail {
  let din  = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = VaultDatum {
    ..din, personal_delegate: Some(t_delegate), last_updated_epoch: 7,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 1)], [t_owner])
  validate_set_delegate(din, Some(t_delegate), 7, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// SD-NEG-3: SetDelegate must not touch magic_batches → fail
test sd_neg_mutate_batches() fail {
  let din  = t_datum_batches([t_snap_batch(#"b1", 4, 1000)])
  let dout = VaultDatum {
    ..t_datum(100, 0, [t_holding(100, 5, False)]),  // batches dropped
    personal_delegate: Some(t_delegate),
    last_updated_epoch: 7,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_set_delegate(din, Some(t_delegate), 7, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// ═══════════════════════════════════════════════════════════════
// Tests — VAULT-IDENTITY STATE-THREAD NFT (genesis-vault-has-no-anchor)
// ═══════════════════════════════════════════════════════════════

// A LAMP amount large enough that a single-epoch snapshot mints > 0 MAGIC (small
// balances round to 0 under the Q-format multipliers).
const t_big: Int = 1_000_000_000_000

// The genesis seed UTxO (distinct output_index from t_own_ref).
fn t_seed() -> OutputReference {
  OutputReference { transaction_id: t_tx_id, output_index: 7 }
}

// An arbitrary wallet UTxO spent as the one-shot seed. Only its output_reference
// matters to validate_mint_vault_id.
fn t_seed_input() -> Input {
  Input {
    output_reference: t_seed(),
    output: Output {
      address: address.from_script(t_vault_hash),
      value: assets.from_asset(t_lamp_policy, t_lamp_name, t_big),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

// A CLEAN genesis datum (all 17 fields at their initial values, profile Ember).
fn t_genesis_datum(balance: Int) -> VaultDatum {
  VaultDatum {
    owner: t_owner,
    lamp_balance: balance,
    lamp_locked: 0,
    loyalty_holdings: [t_holding(balance, 0, False)],
    magic_batches: [],
    next_batch_index: 0,
    vacuum_orders: [],
    gen_schedules: [],
    profile: Ember,
    profile_changed_epoch: 0,
    pending_profile: None,
    last_updated_epoch: 0,
    delegation_cert: DelegationCertificate {
      current: [], pending: None,
      current_effective_epoch: 0, last_changed_epoch: 0,
    },
    activity_state: ActivityState { recent_burn_epochs: [], total_burns_count: 0 },
    streak_state: StreakState { current_streak: 0, last_active_epoch: 0 },
    personal_delegate: None,
    attribution: VaultAttribution {
      attribution_root: #"", last_event_epoch: 0, total_events: 0,
    },
  }
}

// A genesis output at the vault address carrying `balance` LAMP + 1 vault_id NFT
// under policy == t_vault_hash with name == blake2b_256(cbor(seed)).
fn t_genesis_output(balance: Int, datum: VaultDatum) -> Output {
  let name = crypto.blake2b_256(cbor.serialise(t_seed()))
  Output {
    address: address.from_script(t_vault_hash),
    value: assets.from_asset(t_lamp_policy, t_lamp_name, balance)
      |> assets.add(t_vault_hash, name, 1),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn t_mint_tx(out: Output, mint_qty: Int, signers: List<ByteArray>) -> Transaction {
  let name = crypto.blake2b_256(cbor.serialise(t_seed()))
  Transaction {
    ..placeholder,
    inputs: [t_seed_input()],
    outputs: [out],
    mint: assets.from_asset(t_vault_hash, name, mint_qty),
    extra_signatories: signers,
  }
}

// mint_clean_genesis_ok — a well-formed genesis mint passes.
// Attack step it blocks: this is the ONLY way to bring a vault_id NFT into
// existence; it forces the datum clean.
test mint_clean_genesis_ok() {
  let vd = t_genesis_datum(t_big)
  let tx = t_mint_tx(t_genesis_output(t_big, vd), 1, [t_owner])
  validate_mint_vault_id(t_seed(), t_vault_hash, t_lamp_policy, t_lamp_name, tx)
}

// poc_dirty_mint_rejected — the exact attack lever: datum claims a fabricated
// lamp_balance (10^15) while the output carries only t_big LAMP.
// FAILS at: `expect vd.lamp_balance == lamp_qty` in validate_mint_vault_id.
test poc_dirty_mint_rejected() fail {
  let dirty = VaultDatum { ..t_genesis_datum(t_big), lamp_balance: 1_000_000_000_000_000 }
  let tx = t_mint_tx(t_genesis_output(t_big, dirty), 1, [t_owner])
  validate_mint_vault_id(t_seed(), t_vault_hash, t_lamp_policy, t_lamp_name, tx)
}

// poc_dirty_mint_nonclean_activity — a fabricated favourable activity_state (to
// inflate OAC) is rejected at the activity_state clean check.
test poc_dirty_mint_nonclean_activity() fail {
  let dirty =
    VaultDatum {
      ..t_genesis_datum(t_big),
      activity_state: ActivityState { recent_burn_epochs: [], total_burns_count: 99 },
    }
  let tx = t_mint_tx(t_genesis_output(t_big, dirty), 1, [t_owner])
  validate_mint_vault_id(t_seed(), t_vault_hash, t_lamp_policy, t_lamp_name, tx)
}

// Build a VALID single-epoch snapshot (din, dout) by replaying the same lib
// calls the validator uses, so steps 1..9 pass and only the anchor differs.
fn t_snap_valid(epoch: Int) -> (VaultDatum, VaultDatum) {
  let din = t_datum(t_big, 0, [t_holding(t_big, 5, False)])   // Flame, lue 0
  let applied = apply_pending_profile(din, epoch)
  let lf_q  = compute_lf_q(applied.loyalty_holdings, epoch)
  let oac_q = compute_oac_q(applied.activity_state, epoch)
  let delta_e = epoch - applied.last_updated_epoch
  let m_one = compute_snapshot_magic(applied.lamp_balance, lf_q, oac_q, applied.profile)
  let m_total = delta_e * m_one
  let pruned = prune_expired_batches(applied.magic_batches, epoch)
  let new_batch =
    create_snapshot_batch(t_own_ref(), applied.next_batch_index, applied.profile, m_total, epoch)
  let expected_batches = list.concat(pruned, [new_batch])
  let expected_activity = prune_stale_activity(applied.activity_state, epoch)
  let dout =
    VaultDatum {
      ..applied,
      magic_batches: expected_batches,
      next_batch_index: applied.next_batch_index + 1,
      last_updated_epoch: epoch,
      activity_state: expected_activity,
      attribution: VaultAttribution {
        ..applied.attribution,
        total_events: applied.attribution.total_events + 1,
        last_event_epoch: epoch,
      },
    }
  (din, dout)
}

// spend_preserves_nft_ok — control: an anchored vault snapshots fine.
test spend_preserves_nft_ok() {
  let (din, dout) = t_snap_valid(6)
  let tx = t_tx([t_vault_input(din, t_big)], [t_vault_output(dout, t_big)], [t_owner])
  validate_snapshot(din, 6, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// poc_fabricated_magic_snapshot_fails — THE mainnet blocker. Same otherwise-valid
// snapshot tx as spend_preserves_nft_ok, but the input UTxO carries NO vault_id
// NFT (attacker parked a fabricated datum at the script address; no mint policy
// ever ran). All snapshot checks (epoch, owner-sig, DS, datum, LAMP value) pass —
// the tx FAILS only at validate_vault_value → single_nft_name, which `expect`s a
// singleton token list under the vault_id policy and gets the empty list.
test poc_fabricated_magic_snapshot_fails() fail {
  let (din, dout) = t_snap_valid(6)
  let fab_input =
    Input {
      output_reference: t_own_ref(),
      output: Output {
        address: address.from_script(t_vault_hash),
        value: assets.from_asset(t_lamp_policy, t_lamp_name, t_big),  // no NFT
        datum: InlineDatum(din),
        reference_script: None,
      },
    }
  let tx = t_tx([fab_input], [t_vault_output(dout, t_big)], [t_owner])
  validate_snapshot(din, 6, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// spend_drops_nft_fail — anchored input, but the continuing output omits the
// vault_id NFT (attempt to strip the anchor off the thread).
// FAILS at: `expect quantity_of(output, vault_id_policy, name) == 1` (gets 0).
test spend_drops_nft_fail() fail {
  let (din, dout) = t_snap_valid(6)
  let out_no_nft =
    Output {
      address: address.from_script(t_vault_hash),
      value: assets.from_asset(t_lamp_policy, t_lamp_name, t_big),  // no NFT
      datum: InlineDatum(dout),
      reference_script: None,
    }
  let tx = t_tx([t_vault_input(din, t_big)], [out_no_nft], [t_owner])
  validate_snapshot(din, 6, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}
