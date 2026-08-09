// validators/vault.ak — Vault validator (VacuumGen focus)
// Normative §10, C-VAC-1..12, C-VAC-FIRE-PERMISSION, C-VAC-PRUNE, C-VAC-FIRE-FULL-VAULT
// PlutusV3 / Aiken ≥ 1.1.x
//
// TWO-PHASE PROTOCOL:
//   Phase 1 — VacuumCommit: user signs, locks LAMP, adds VacuumOrder
//   Phase 2 — VacuumFire:   permissionless, transfers LAMP, creates batch (or M=0)

use aiken/cbor
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto
use aiken/interval.{Finite, IntervalBoundType, after, between}
use aiken/primitive/bytearray
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}

use magiclamp/protocol/types.{
  ActivityState, BurnBatch, DelegationCertificate, Ember, Flame, Instant,
  LoyaltyHolding, MagicBatch, SetDelegate, StreakState, UMDatum, Vacuum,
  VacuumCommit, VacuumExpire, VacuumFire, VacuumOrder, VaultAttribution,
  VaultDatum, VaultRedeemer, WithdrawLamp,
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

// ══════════════════════════════════════════════════════════════
// VAULT-IDENTITY STATE-THREAD NFT — genesis-clean anchor (MAINNET-BLOCK)
//
// THE HOLE: Cardano runs a validator only when a UTxO is SPENT, never when it
// is CREATED. The vault script address is public (= hash of this validator +
// params). An attacker pays min-ADA to place a UTxO at the vault address with a
// FABRICATED inline datum (a full `vacuum_orders` list, a bogus `lamp_balance`,
// `owner = attacker`), funds it with real LAMP, then fires it via VacuumFire —
// which is PERMISSIONLESS and moves real LAMP out to `treasury_addr` while
// minting fabricated MAGIC. VacuumGen is the most dangerous of the four modules
// precisely because a fabricated vault touches REAL LAMP, not just accounting.
//
// THE FIX: a state-thread NFT whose ONLY way into existence runs a policy (the
// `mint` handler below) that PROVES the vault started clean, and whose presence
// is REQUIRED on every spend (see `validate_vault_value`). A fabricated vault
// (no NFT) cannot be spent by ANY handler — VacuumFire included, so its LAMP can
// never leave to treasury.
//
// WHY MULTI-PURPOSE: the mint policy must bind the genesis NFT to THIS vault's
// script address, else the attacker mints a clean NFT to a wallet then re-homes
// it to the vault address with a DIRTY datum in a plain tx (no script runs on
// that creation). Binding needs the vault hash inside the mint policy, while the
// spend side needs the mint policy id — a mutual apply-param fixed point that is
// undeployable. Folding the mint handler INTO the vault validator breaks the
// cycle: here `policy_id (mint) == script_hash == the Script credential of the
// spend address`, all known via self-reference, no param, no cycle. The single
// script hash IS the vault_id policy id.
//
// asset_name = blake2b_256(cbor.serialise(seed_output_reference)) → each vault is
// a distinct N-instance one-shot (permissionless, unique per spent seed UTxO).
// ══════════════════════════════════════════════════════════════
pub type VaultIdRedeemer {
  // Mint a fresh vault-identity NFT + park a genesis-clean vault UTxO.
  MintVaultId { seed: OutputReference }
  // Burn the NFT (qty < 0 only). A spend that also burns the NFT still fails
  // `validate_vault_value` (NFT must survive on the continuing output), so the
  // NFT is effectively permanent under the current handler set.
  BurnVaultId
}

// ── Parameterized validator ───────────────────────────────────
// `ms_per_epoch` is applied per-network (Plutus validity_range is POSIX ms):
//   Mainnet:        432_000_000
//   Preview/Preprod: 86_400_000
// um_script_hash : ByteArray = applied UMKeeper validator hash. Pins the UM
//   reference input to the canonical UM script address (MAINNET-BLOCK fix,
//   defense-in-depth (b)). The UM NFT alone is not a global singleton, so the
//   ref input must ALSO live at Script(um_script_hash) to be trusted.
validator vault(
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,  // LAMP asset name per network (deploy-applied)
  treasury_addr   : Address,
  um_nft_policy   : PolicyId,
  um_script_hash  : ByteArray,
  ms_per_epoch    : Int,
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
    let current_epoch = get_current_epoch(tx, ms_per_epoch)

    when redeemer is {
      VacuumCommit { lambda } ->
        validate_vacuum_commit(input_datum, lambda, current_epoch, own_ref,
                               lamp_policy_id, lamp_asset_name, tx)

      VacuumFire { order_id } ->
        validate_vacuum_fire(input_datum, order_id, current_epoch, own_ref,
                             lamp_policy_id, lamp_asset_name, treasury_addr, um_nft_policy,
                             um_script_hash, tx)

      WithdrawLamp { amount } ->
        validate_withdraw_lamp(input_datum, amount, current_epoch, own_ref,
                               lamp_policy_id, lamp_asset_name, tx)

      // ── BurnBatch — datum-consume (D1): subtract from magic_batches ──
      // MAGIC is an accounting number in magic_batches; consuming = lowering
      // current_amount (NO token, NO tx.mint). The price coupling
      // (Σburns == required) is enforced by the co-spending ConsumeMAGIC
      // engagement validator that reads the PriceParam beacon. This handler
      // enforces the structural correctness of the subtraction + A02 + value
      // preservation + owner-or-delegate auth.
      BurnBatch { burns } ->
        validate_burn_batch(input_datum, burns, current_epoch, own_ref,
                            lamp_policy_id, lamp_asset_name, tx)

      // ── SetDelegate — owner sets/clears consume-delegate ──
      SetDelegate { new_delegate } ->
        validate_set_delegate(input_datum, new_delegate, current_epoch,
                             own_ref, lamp_policy_id, lamp_asset_name, tx)

      // ── VacuumExpire (SEC-05 fix): owner reclaims LAMP after grace window ──
      // Only reachable when current_epoch > fire_epoch + 2. The no-cancel rule
      // (C-VAC-12) forbids cancelling BEFORE fire_epoch; this path is only open
      // AFTER that window has definitively closed, so C-VAC-12 is not violated.
      VacuumExpire { order_id } ->
        validate_vacuum_expire(input_datum, order_id, current_epoch, own_ref,
                               lamp_policy_id, lamp_asset_name, tx)

      // Other shared redeemers (InstantGen / ApplyHalving / UpdateProfile)
      // are intentionally rejected by VacuumGen — those flows live on their
      // respective module's vault. Catch-all stays as a hard anti-tamper guard.
      _ -> fail @"unimplemented redeemer for VacuumGen module"
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
// LAMP sitting in the parked output (via the lamp_asset_name PARAM).
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
  // vault spend address. Binding the NFT to it here stops the "mint clean →
  // re-home dirty" reopening: the NFT is born at the vault address and can never
  // leave it (spend always preserves it to the continuing output).
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
  // owner: a pkh the creator controls (present in signatories) — no squatting a
  // victim's pkh, and the creator can actually spend the result.
  expect list.has(tx.extra_signatories, vd.owner)

  // LAMP accounting bound to the REAL deposited LAMP (no claiming a balance you
  // did not deposit). Uses the lamp_asset_name PARAM (per-network), never a
  // hardcoded literal.
  let lamp_qty = assets.quantity_of(vault_out.value, lamp_policy_id, lamp_asset_name)
  expect vd.lamp_balance == lamp_qty
  expect vd.lamp_locked == 0
  expect sum_holdings(vd.loyalty_holdings) == vd.lamp_balance
  expect list.all(vd.loyalty_holdings, fn(h) { !h.is_locked })
  expect list.length(vd.loyalty_holdings) <= max_loyalty_holdings

  // MAGIC / order / consumption state MUST be empty — exactly the levers a
  // fabricated vault would forge to drain LAMP + mint MAGIC.
  expect vd.magic_batches == []
  expect vd.next_batch_index == 0
  expect vd.vacuum_orders == []
  expect vd.gen_schedules == []
  expect vd.activity_state == ActivityState {
    recent_burn_epochs: [],
    total_burns_count: 0,
  }

  // Every other ledger empty/zeroed.
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
  // accumulated state. The type is bounded to 3 valid values, so any of them is a
  // valid genesis strategy; pinning gives no security benefit and would reject
  // vaults the standard off-chain flow creates (default Flame).

  // ── No dust bundled into the genesis output ──────────────────────────────
  // At most {ADA, LAMP, vault_id NFT}.
  expect list.length(assets.policies(vault_out.value)) <= 3

  True
}

/// Burn path: allowed unconditionally (only NEGATIVE quantities under this
/// policy). This can never sneak a mint (all qty < 0), and a spend that also
/// burns the NFT is rejected by `validate_vault_value` (the NFT must survive on
/// the continuing output).
fn validate_burn_vault_id(policy_id: PolicyId, tx: Transaction) -> Bool {
  let own_tokens = assets.tokens(tx.mint, policy_id)
  expect
    list.all(dict.to_pairs(own_tokens), fn(p) {
      let Pair(_name, qty) = p
      qty < 0
    })
  True
}

/// VALUE + IDENTITY preservation guard (MAINNET-BLOCK).
///
///   - VAULT-IDENTITY NFT preserved: the spent input must carry EXACTLY one
///     asset under the vault_id policy (== this validator's own script hash,
///     read from the input address), and the continuing output must carry the
///     SAME (policy, name). A FABRICATED vault (no NFT — no policy ran to vet its
///     datum) fails at `single_nft_name` (empty list → fails closed), so it
///     cannot be spent by ANY handler. For VacuumFire the LAMP leaves to
///     treasury but the vault UTxO continues and MUST keep its identity NFT.
///   - lovelace(out) >= lovelace(in)   → no ADA siphoned (top-up allowed).
///   - |policies(out)| <= 3            → at most {ADA, LAMP, vault_id NFT};
///     rejects dust stuffing that would bloat the UTxO past exec limits.
fn validate_vault_value(vault_input: Input, vault_output: Output) -> Bool {
  // vault_id policy = own script hash, read from the input being spent.
  expect Script(vault_id_policy) = vault_input.output.address.payment_credential
  let nft_name = single_nft_name(vault_input.output.value, vault_id_policy)
  expect assets.quantity_of(vault_output.value, vault_id_policy, nft_name) == 1

  expect
    assets.lovelace_of(vault_output.value) >= assets.lovelace_of(
      vault_input.output.value,
    )
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

/// Find the currently-being-spent vault Input (used for value preservation).
fn find_own_input(own_ref: OutputReference, inputs: List<Input>) -> Input {
  expect Some(own_input) =
    list.find(inputs, fn(i) { i.output_reference == own_ref })
  own_input
}

// ═══════════════════════════════════════════════════════════════
// Phase 1: VacuumCommit
// Constraints: C-VAC-1..5, C-VAULT-DS-1
// ═══════════════════════════════════════════════════════════════
fn validate_vacuum_commit(
  input_datum    : VaultDatum,
  lambda         : Int,              // oildrop to lock (λ)
  current_epoch  : Int,
  own_ref         : OutputReference,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {

  // ── C-VAULT-DS-1: one vault input ────────────────────────────
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

  // ── IDENTITY GATE (MAINNET-BLOCK): vault-id NFT on input + output ─────────
  expect validate_vault_value(
    find_own_input(own_ref, tx.inputs),
    find_vault_output(tx.outputs, vault_addr),
  )

  // ── C-VAC-1: User signs ──────────────────────────────────────
  expect list.has(tx.extra_signatories, input_datum.owner)

  // ── C-VAC-3: λ ≥ 1 LAMP (10^6 oildrop) ─────────────────────────
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
  let output = find_vault_output(tx.outputs, vault_addr)
  let output_datum = output_datum_of(output)

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
  expect output_datum.attribution == input_datum.attribution

  // C-VAULT-9: lamp_locked consistency
  let expected_locked = sum_locked(new_holdings)
  expect output_datum.lamp_locked == expected_locked  // includes λ just added

  // C-VAULT-10: Σholdings = lamp_balance
  expect sum_holdings(output_datum.loyalty_holdings) == output_datum.lamp_balance

  // ── CRIT value-leak guard (eUTXO): vault output LAMP value must match
  // lamp_balance. Commit does NOT transfer LAMP, so the continuing vault
  // output must still carry the full balance. Without this, an attacker
  // could drain LAMP off the vault while leaving the datum balance intact.
  let vault_lamp_qty =
    assets.quantity_of(output.value, lamp_policy_id, lamp_asset_name)  // "tLAMP"
  expect vault_lamp_qty == output_datum.lamp_balance

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
  um_script_hash  : ByteArray,
  tx              : Transaction,
) -> Bool {

  let vault_addr = find_own_address(own_ref, tx.inputs)

  // ── C-VAULT-DS-1 ─────────────────────────────────────────────
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

  // ── IDENTITY GATE (MAINNET-BLOCK): vault-id NFT on input + continuing out ─
  // Fires are PERMISSIONLESS and move real LAMP to treasury, so a fabricated
  // vault (no NFT) must be rejected here BEFORE any LAMP can leave. The
  // continuing vault output must still carry the NFT even though LAMP departs.
  expect validate_vault_value(
    find_own_input(own_ref, tx.inputs),
    find_vault_output(tx.outputs, vault_addr),
  )

  // ── C-VAC-FIRE-PERMISSION: NO owner signature required ────────
  // (any keeper or third party may trigger fire)

  // ── Find the specific order ───────────────────────────────────
  expect Some(order) = list.find(input_datum.vacuum_orders, fn(o) { o.order_id == order_id })

  // ── C-VAC-6 (SEC-05 fix): fire within grace window after fire_epoch ─
  // Keeper có 2 epoch buffer; nếu miss 1 epoch vẫn có thể fire ở epoch+1/+2.
  // Sau grace window, LAMP không bị khoá vĩnh viễn — owner dùng VacuumExpire.
  // Không ảnh hưởng C-VAC-12: C-VAC-12 cấm cancel TRƯỚC fire_epoch, còn
  // grace window chỉ mở rộng phía SAU fire_epoch.
  let fire_grace_epochs = 2
  expect current_epoch >= order.fire_epoch
  expect current_epoch <= order.fire_epoch + fire_grace_epochs

  // ── Get UM (C-UM-7: always smoothed, no stale check) ─────────
  let um_datum = find_um_datum(tx.reference_inputs, um_nft_policy, um_script_hash)
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
  let output = find_vault_output(tx.outputs, vault_addr)
  let output_datum = output_datum_of(output)

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

  // ── CRIT value-leak guard (eUTXO): vault output LAMP value must equal
  // the post-fire lamp_balance. Fire transfers `order.lamp_amount` to
  // Treasury; the vault keeps `lamp_balance - order.lamp_amount`. Without
  // this check, the datum could record the decrement while LAMP is siphoned
  // somewhere other than Treasury (value-leak), since treasury_receives_lamp
  // only bounds the Treasury side, not the vault side.
  let vault_lamp_qty =
    assets.quantity_of(output.value, lamp_policy_id, lamp_asset_name)  // "tLAMP"
  expect vault_lamp_qty == output_datum.lamp_balance

  True
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

// MAINNET-BLOCK fix (validity-range gaming): bind BOTH bounds, not lower only.
// The ledger only enforces `lower_bound ≤ current_slot` — it does NOT forbid a tx
// from spanning multiple epochs, nor does it guarantee the real block lands at
// `lower_bound`. Reading lower-only lets an attacker set lower=start_of(E) with an
// open/late upper, get included at a real epoch E+k, yet have the validator believe
// current_epoch == E. For VacuumFire (C-VAC-6 EXACT) that means firing late; for
// VacuumCommit/BurnBatch/SetDelegate it backdates fire_epoch / last_updated_epoch /
// attribution stamps. Root-cause cure: require BOTH bounds Finite (fail-closed,
// rejects ±Infinity) AND the whole tx to sit inside ONE epoch (e_lo == e_hi), so
// `current_epoch` is unambiguous. Mirrors ProfileChange util.ak get_epoch.
fn get_current_epoch(tx: Transaction, ms_per_epoch: Int) -> Int {
  expect Some(lower_ms) =
    tx.validity_range.lower_bound.bound_type |> get_finite_slot
  expect Some(upper_ms) =
    tx.validity_range.upper_bound.bound_type |> get_finite_slot
  let e_lo = lower_ms / ms_per_epoch
  let e_hi = upper_ms / ms_per_epoch
  // tx must fall entirely within a single epoch — blocks multi-epoch span and
  // the ambiguity that lets an attacker game the effective epoch.
  expect e_lo == e_hi
  e_lo
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
  // C-VAULT-OUT-2 (LENS-SEC INFO): the continuing vault output must NOT carry a
  // reference_script. Symmetric anti-tamper to input==1/output==1: forbids an
  // attacker bloating the vault UTXO with a foreign reference_script (locked ADA).
  expect o.reference_script == None
  o
}

fn output_datum_of(o: Output) -> VaultDatum {
  expect InlineDatum(d) = o.datum
  expect datum: VaultDatum = d
  datum
}

fn find_vault_output_datum(outputs: List<Output>, vault_addr: Address) -> VaultDatum {
  let o = find_vault_output(outputs, vault_addr)
  output_datum_of(o)
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

  // ── IDENTITY GATE (MAINNET-BLOCK): vault-id NFT on input + output ─────────
  expect validate_vault_value(
    find_own_input(own_ref, tx.inputs),
    find_vault_output(tx.outputs, vault_addr),
  )

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

// ═══════════════════════════════════════════════════════════════
// validate_burn_batch — datum-consume (D1)
// MAGIC = accounting number in magic_batches[]. Consuming MAGIC = lowering
// current_amount of the targeted batches. NO token, NO tx.mint.
// Auth: owner OR personal_delegate (consume-delegate, paymaster model).
// Price coupling (Σ burns == required) is enforced by the co-spending
// ConsumeMAGIC engagement validator (reads PriceParam beacon); this handler
// owns the subtraction correctness + A02 + value preservation.
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

  // ── DS-1: exactly one vault input + one vault output ─────────
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1
  let output = find_vault_output(tx.outputs, vault_addr)   // enforces count == 1
  let output_datum = output_datum_of(output)

  // ── IDENTITY GATE (MAINNET-BLOCK): vault-id NFT on input + output ─────────
  // Delegate-callable path — a fabricated vault (no NFT) must not mint MAGIC.
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), output)

  // ── AUTH: owner OR consume-delegate (personal_delegate) ──────
  let authed =
    list.has(tx.extra_signatories, input_datum.owner) || when input_datum.personal_delegate is {
      Some(d) -> list.has(tx.extra_signatories, d)
      None    -> False
    }
  expect authed

  // ── burns must be non-empty (a no-op burn is meaningless) ────
  expect list.length(burns) > 0

  // ── Decay first (cliff prune, same model as fire), then burns ─
  // VacuumGen batches are cliff (decay_window=1); a batch survives while
  // current_epoch - created_epoch < decay_window. Prune expired BEFORE
  // applying burns so a burn can only target a still-live batch.
  let decayed = prune_expired(input_datum.magic_batches, current_epoch)

  // ── Apply burns: subtract amount per batch_id, prune zeroed ──
  let expected_batches = apply_burns(decayed, burns)

  // ── A02: field-by-field (17 fields) ──────────────────────────
  // Only magic_batches + last_updated_epoch + attribution change.
  expect output_datum.owner == input_datum.owner
  expect output_datum.lamp_balance == input_datum.lamp_balance        // BurnBatch never touches LAMP
  expect output_datum.lamp_locked == input_datum.lamp_locked
  expect output_datum.loyalty_holdings == input_datum.loyalty_holdings
  expect output_datum.magic_batches == expected_batches               // ← the only MAGIC change
  expect output_datum.next_batch_index == input_datum.next_batch_index
  expect output_datum.vacuum_orders == input_datum.vacuum_orders
  expect output_datum.gen_schedules == input_datum.gen_schedules
  expect output_datum.profile == input_datum.profile
  expect output_datum.profile_changed_epoch == input_datum.profile_changed_epoch
  expect output_datum.pending_profile == input_datum.pending_profile
  expect output_datum.delegation_cert == input_datum.delegation_cert
  expect output_datum.activity_state == input_datum.activity_state
  expect output_datum.streak_state == input_datum.streak_state
  expect output_datum.personal_delegate == input_datum.personal_delegate  // delegate unchanged here
  expect output_datum.last_updated_epoch == current_epoch
  expect output_datum.attribution.total_events == input_datum.attribution.total_events + 1
  expect output_datum.attribution.last_event_epoch == current_epoch

  // ── VALUE PRESERVATION (anti value-leak): LAMP must stay in vault ─
  let vault_lamp_qty =
    assets.quantity_of(output.value, lamp_policy_id, lamp_asset_name)  // "tLAMP"
  expect vault_lamp_qty == output_datum.lamp_balance

  expect list.length(output_datum.magic_batches) <= max_batches_per_vault
  True
}

/// Prune batches whose decay window has elapsed (cliff model, mirrors fire).
fn prune_expired(batches: List<MagicBatch>, current_epoch: Int) -> List<MagicBatch> {
  list.filter(batches, fn(b) { current_epoch - b.created_epoch < b.decay_window })
}

/// Apply each (batch_id, amount) burn to the batch list:
///   - exactly one batch must match batch_id (no duplicate, no missing);
///   - 0 < amount ≤ current_amount;
///   - current_amount' = current_amount - amount; all other fields immutable;
///   - if current_amount' == 0 → batch removed; else replaced in place;
///   - order of untouched batches preserved.
fn apply_burns(batches: List<MagicBatch>, burns: List<(ByteArray, Int)>) -> List<MagicBatch> {
  when burns is {
    [] -> batches
    [(batch_id, amount), ..rest] -> {
      expect amount > 0
      // exactly one batch with this id
      expect list.count(batches, fn(b) { b.batch_id == batch_id }) == 1
      let updated =
        list.foldr(batches, [], fn(b, acc) {
          if b.batch_id == batch_id {
            expect amount <= b.current_amount
            let new_amount = b.current_amount - amount
            if new_amount == 0 {
              acc                                     // prune zeroed batch
            } else {
              [MagicBatch { ..b, current_amount: new_amount }, ..acc]
            }
          } else {
            [b, ..acc]
          }
        })
      apply_burns(updated, rest)
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// validate_set_delegate — owner sets/clears consume-delegate (D1)
// personal_delegate (field 15) = consume-delegate: None → owner only;
// Some(d) → owner OR d may trigger BurnBatch. Owner-only to change. No
// cooldown (changing delegate is economically cheap and reversible).
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

  // ── DS-1: one vault input + one vault output ─────────────────
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1
  let output = find_vault_output(tx.outputs, vault_addr)
  let output_datum = output_datum_of(output)

  // ── IDENTITY GATE (MAINNET-BLOCK): vault-id NFT on input + output ─────────
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), output)

  // ── AUTH: ONLY owner may change the delegate ─────────────────
  expect list.has(tx.extra_signatories, input_datum.owner)

  // ── A02: everything immutable except personal_delegate +
  //         last_updated_epoch ───────────────────────────────────
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
  expect output_datum.personal_delegate == new_delegate                  // ← the change
  expect output_datum.last_updated_epoch == current_epoch

  // ── VALUE PRESERVATION ───────────────────────────────────────
  let vault_lamp_qty =
    assets.quantity_of(output.value, lamp_policy_id, lamp_asset_name)
  expect vault_lamp_qty == output_datum.lamp_balance

  True
}

// ═══════════════════════════════════════════════════════════════
// validate_vacuum_expire (SEC-05 fix) — §10 VacuumExpire
// Owner thu hồi LAMP từ order đã quá grace window.
// Điều kiện: current_epoch > fire_epoch + 2 (fire window đã đóng hoàn toàn).
// LAMP trả về lamp_balance (KHÔNG vào Treasury — đây là lỗi keeper, không
// phải completion bình thường; Treasury chỉ nhận khi VacuumFire thành công).
// C-VAC-12 KHÔNG bị vi phạm: C-VAC-12 cấm cancel TRƯỚC fire_epoch; expire
// chỉ mở sau khi fire window + grace đã qua.
// ═══════════════════════════════════════════════════════════════
fn validate_vacuum_expire(
  input_datum    : VaultDatum,
  order_id       : ByteArray,
  current_epoch  : Int,
  own_ref         : OutputReference,
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {

  // ── DS-1: một vault input, một vault output ──────────────────
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1
  let output = find_vault_output(tx.outputs, vault_addr)
  let output_datum = output_datum_of(output)

  // ── IDENTITY GATE (MAINNET-BLOCK): vault-id NFT on input + output ─────────
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), output)

  // ── AUTH: chỉ owner mới được expire (KHÔNG delegate) ─────────
  // Tránh griefing: delegate không được phép expire thay owner.
  expect list.has(tx.extra_signatories, input_datum.owner)

  // ── Tìm order trong vacuum_orders ────────────────────────────
  expect Some(order) =
    list.find(input_datum.vacuum_orders, fn(o) { o.order_id == order_id })

  // ── Kiểm tra grace window đã qua ─────────────────────────────
  // Fire window: [fire_epoch, fire_epoch + 2]. Expire chỉ hợp lệ khi
  // current_epoch > fire_epoch + 2, tức fire_epoch + 3 trở lên.
  let fire_grace_epochs = 2
  expect current_epoch > order.fire_epoch + fire_grace_epochs

  // ── Xoá order, trả LAMP về lamp_balance ──────────────────────
  let new_orders =
    list.filter(input_datum.vacuum_orders, fn(o) { o.order_id != order_id })
  let new_lamp_balance = input_datum.lamp_balance  // balance KHÔNG đổi (LAMP vẫn ở vault)
  let new_lamp_locked  = input_datum.lamp_locked - order.lamp_amount

  // ── Unlock holdings tương ứng ────────────────────────────────
  // Dùng cùng remove_locked_amount như VacuumFire (unlock LIFO).
  let new_holdings = remove_locked_amount(input_datum.loyalty_holdings, order.lamp_amount)

  // ── A02: field-by-field ───────────────────────────────────────
  expect output_datum.owner == input_datum.owner
  expect output_datum.lamp_balance == new_lamp_balance
  expect output_datum.lamp_locked  == new_lamp_locked
  expect output_datum.loyalty_holdings == new_holdings
  expect output_datum.magic_batches == input_datum.magic_batches
  expect output_datum.next_batch_index == input_datum.next_batch_index
  expect output_datum.vacuum_orders == new_orders
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

  // ── C-VAULT-10: Σholdings == lamp_balance ────────────────────
  expect sum_holdings(output_datum.loyalty_holdings) == output_datum.lamp_balance

  // ── VALUE PRESERVATION: LAMP giữ nguyên trong vault ──────────
  // Expire KHÔNG chuyển LAMP ra ngoài — LAMP vẫn trong vault, chỉ unlock.
  let vault_lamp_qty =
    assets.quantity_of(output.value, lamp_policy_id, lamp_asset_name)  // "tLAMP"
  expect vault_lamp_qty == new_lamp_balance

  True
}

// MAINNET-BLOCK defense-in-depth (b): require the UM ref input to carry the
// UM NFT AND sit at the canonical UM script address Script(um_script_hash).
// The UM NFT is not a guaranteed global singleton, so the NFT alone is
// forgeable; pinning the script address rejects forged UM UTxOs.
fn find_um_datum(
  ref_inputs     : List<Input>,
  um_nft_policy  : PolicyId,
  um_script_hash : ByteArray,
) -> UMDatum {
  expect Some(i) = list.find(ref_inputs, fn(x) {
    assets.quantity_of(x.output.value, um_nft_policy, #"554d44") > 0
      && x.output.address.payment_credential == Script(um_script_hash)
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
// Tests use the MAINNET name on purpose: if a #"744c414d50" literal is ever
// reintroduced into validator logic, it no longer matches the param the tests
// apply, and the suite fails instead of silently passing.
const t_lamp_name: ByteArray = #"4c414d50"   // "LAMP"
const t_lamp_policy: ByteArray =
  #"22222222222222222222222222222222222222222222222222222222"
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

// Vault-identity NFT lives under policy == vault script hash (t_vault_hash),
// so single_nft_name reads it straight off the input/output address credential.
const t_vid_name: ByteArray = #"feed"

fn t_vault_value(balance: Int) -> Value {
  assets.from_asset(t_lamp_policy, t_lamp_name, balance)
    |> assets.add(t_vault_hash, t_vid_name, 1)
}

fn t_vault_output(datum: VaultDatum, balance: Int) -> Output {
  Output {
    address: address.from_script(t_vault_hash),
    value: t_vault_value(balance),
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

// ═══════════════════════════════════════════════════════════════
// Tests — BurnBatch (datum-consume D1) + SetDelegate
// ═══════════════════════════════════════════════════════════════

const t_delegate: ByteArray =
  #"44444444444444444444444444444444444444444444444444444444"
const t_bid_a: ByteArray = #"aaaa"
const t_bid_b: ByteArray = #"bbbb"

// Vacuum batch: cliff (decay_window=1) — lives only at the epoch it was
// created (current_epoch - created_epoch < 1 ⇒ created_epoch == current).
fn t_batch(id: ByteArray, created: Int, amount: Int, window: Int) -> MagicBatch {
  MagicBatch {
    batch_id:            id,
    source:              Vacuum,
    created_epoch:       created,
    initial_amount:      amount,
    current_amount:      amount,
    decay_window:        window,
    profile_at_creation: None,
    contract_id:         None,
    halved:              False,
  }
}

fn t_datum_b(batches: List<MagicBatch>, deleg: Option<ByteArray>) -> VaultDatum {
  VaultDatum {
    ..t_datum(100, 0, [t_holding(100, 5, False)]),
    magic_batches: batches,
    personal_delegate: deleg,
  }
}

fn t_after_burn(
  din: VaultDatum, batches: List<MagicBatch>, epoch: Int,
) -> VaultDatum {
  VaultDatum {
    ..din,
    magic_batches: batches,
    last_updated_epoch: epoch,
    attribution: VaultAttribution {
      ..din.attribution,
      total_events: din.attribution.total_events + 1,
      last_event_epoch: epoch,
    },
  }
}

// BB-POS-1: partial burn — current_amount lowered, batch retained
test bb_partial_owner() {
  // window=10 so batch (created@5) is still live at epoch 10
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let bout = MagicBatch { ..bin, current_amount: 600 }
  let din  = t_datum_b([bin], None)
  let dout = t_after_burn(din, [bout], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(t_bid_a, 400)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-POS-2: full burn — batch pruned (current_amount → 0)
test bb_full_prunes() {
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let din  = t_datum_b([bin], None)
  let dout = t_after_burn(din, [], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(t_bid_a, 1000)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-POS-3: delegate (paymaster) may trigger when personal_delegate=Some
test bb_delegate_authed() {
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let bout = MagicBatch { ..bin, current_amount: 700 }
  let din  = t_datum_b([bin], Some(t_delegate))
  let dout = t_after_burn(din, [bout], 10)
  // signed by delegate, NOT owner
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_burn_batch(din, [(t_bid_a, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-POS-4: multi-batch burn, one pruned one retained
test bb_multi() {
  let ba_in = t_batch(t_bid_a, 5, 1000, 10)
  let bb_in = t_batch(t_bid_b, 5, 500, 10)
  let bb_out = MagicBatch { ..bb_in, current_amount: 200 }
  let din  = t_datum_b([ba_in, bb_in], None)
  // a fully burned → pruned; b partial
  let dout = t_after_burn(din, [bb_out], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(t_bid_a, 1000), (t_bid_b, 300)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-1: no auth (neither owner nor delegate signs)
test bb_no_auth() fail {
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let bout = MagicBatch { ..bin, current_amount: 600 }
  let din  = t_datum_b([bin], None)
  let dout = t_after_burn(din, [bout], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_burn_batch(din, [(t_bid_a, 400)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-2: delegate signs but personal_delegate=None → reject
test bb_delegate_not_set() fail {
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let bout = MagicBatch { ..bin, current_amount: 600 }
  let din  = t_datum_b([bin], None)
  let dout = t_after_burn(din, [bout], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_burn_batch(din, [(t_bid_a, 400)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-3: over-burn (amount > current_amount)
test bb_over_burn() fail {
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let din  = t_datum_b([bin], None)
  let dout = t_after_burn(din, [], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(t_bid_a, 1001)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-4: burn references a non-existent batch_id
test bb_unknown_batch() fail {
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let din  = t_datum_b([bin], None)
  let dout = t_after_burn(din, [bin], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(t_bid_b, 100)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-5: LAMP siphoned from vault output (value-leak) — datum unchanged but
// vault output carries less LAMP than lamp_balance.
test bb_value_leak() fail {
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let bout = MagicBatch { ..bin, current_amount: 600 }
  let din  = t_datum_b([bin], None)
  let dout = t_after_burn(din, [bout], 10)
  // output value only 90 LAMP, but datum says 100 → must reject
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 90)], [t_owner])
  validate_burn_batch(din, [(t_bid_a, 400)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-6: tamper lamp_balance (BurnBatch must not change LAMP)
test bb_lamp_mutated() fail {
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let bout = MagicBatch { ..bin, current_amount: 600 }
  let din  = t_datum_b([bin], None)
  let dout = VaultDatum { ..t_after_burn(din, [bout], 10), lamp_balance: 90 }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 90)], [t_owner])
  validate_burn_batch(din, [(t_bid_a, 400)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-7: attribution not incremented
test bb_attribution_not_advanced() fail {
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let bout = MagicBatch { ..bin, current_amount: 600 }
  let din  = t_datum_b([bin], None)
  let dout = VaultDatum {
    ..din, magic_batches: [bout], last_updated_epoch: 10,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(t_bid_a, 400)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-8: empty burns list (no-op) rejected
test bb_empty_burns() fail {
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let din  = t_datum_b([bin], None)
  let dout = t_after_burn(din, [bin], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-9: phantom second vault output
test bb_phantom_output() fail {
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let bout = MagicBatch { ..bin, current_amount: 600 }
  let din  = t_datum_b([bin], None)
  let dout = t_after_burn(din, [bout], 10)
  let tx = t_tx(
    [t_vault_input(din, 100)],
    [t_vault_output(dout, 100), t_vault_output(dout, 100)],
    [t_owner],
  )
  validate_burn_batch(din, [(t_bid_a, 400)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// BB-NEG-10: continuing vault output carries a foreign reference_script — must
// reject (C-VAULT-OUT-2 anti-tamper, symmetric to input==1/output==1).
test bb_ref_script_rejected() fail {
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let bout = MagicBatch { ..bin, current_amount: 600 }
  let din  = t_datum_b([bin], None)
  let dout = t_after_burn(din, [bout], 10)
  let tainted =
    Output { ..t_vault_output(dout, 100), reference_script: Some(t_vault_hash) }
  let tx = t_tx([t_vault_input(din, 100)], [tainted], [t_owner])
  validate_burn_batch(din, [(t_bid_a, 400)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// ── SetDelegate ───────────────────────────────────────────────

fn t_after_setdeleg(din: VaultDatum, d: Option<ByteArray>, epoch: Int) -> VaultDatum {
  VaultDatum { ..din, personal_delegate: d, last_updated_epoch: epoch }
}

// SD-POS-1: owner sets delegate None → Some
test sd_set_some() {
  let din  = t_datum_b([], None)
  let dout = t_after_setdeleg(din, Some(t_delegate), 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_set_delegate(din, Some(t_delegate), 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// SD-POS-2: owner clears delegate Some → None
test sd_clear() {
  let din  = t_datum_b([], Some(t_delegate))
  let dout = t_after_setdeleg(din, None, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_set_delegate(din, None, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// SD-NEG-1: non-owner (the delegate itself) cannot change delegate
test sd_delegate_cannot_change() fail {
  let din  = t_datum_b([], Some(t_delegate))
  let dout = t_after_setdeleg(din, None, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_set_delegate(din, None, 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// SD-NEG-2: output delegate does not match redeemer new_delegate
test sd_mismatch() fail {
  let din  = t_datum_b([], None)
  let dout = t_after_setdeleg(din, None, 10)   // output keeps None
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_set_delegate(din, Some(t_delegate), 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// SD-NEG-3: tamper another field (magic_batches) during SetDelegate
test sd_tamper_batches() fail {
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let din  = t_datum_b([bin], None)
  let dout = VaultDatum {
    ..t_after_setdeleg(din, Some(t_delegate), 10),
    magic_batches: [],   // illegally dropped a batch
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_set_delegate(din, Some(t_delegate), 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// ═══════════════════════════════════════════════════════════════
// Tests — get_current_epoch (validity-range gaming MAINNET-BLOCK fix)
// Preview ms_per_epoch = 86_400_000.
// ═══════════════════════════════════════════════════════════════

const t_mspe: Int = 86_400_000

fn t_tx_vr(lo: Int, hi: Int) -> Transaction {
  Transaction { ..placeholder, validity_range: between(lo, hi) }
}

// VR-POS-1: tx fully inside epoch 5 → current_epoch == 5.
test vr_in_single_epoch() {
  let tx = t_tx_vr(5 * t_mspe, 6 * t_mspe - 1)
  get_current_epoch(tx, t_mspe) == 5
}

// VR-POS-2: tight bounds (lower == upper) inside epoch 7.
test vr_tight_bounds() {
  let slot = 7 * t_mspe + 123
  let tx = t_tx_vr(slot, slot)
  get_current_epoch(tx, t_mspe) == 7
}

// VR-NEG-1: span across epoch boundary (lower in 5, upper in 6) → reject.
// This is the core gaming vector: attacker backdates lower to start_of(E)
// while letting the tx be includable in a later epoch.
test vr_span_two_epochs() fail {
  let tx = t_tx_vr(5 * t_mspe, 6 * t_mspe + 100)
  // Compare the result so the (crashing) call is forced — `let _e = ...` would
  // be discarded lazily and the expected crash would never fire.
  get_current_epoch(tx, t_mspe) == 5
}

// VR-NEG-2: unbounded upper (PositiveInfinity) → fail-closed.
// `after(lo)` = [lo, +∞); without the upper-Finite guard the validator would
// trust lower-only and fire/stamp at the wrong epoch.
test vr_unbounded_upper() fail {
  let tx = Transaction { ..placeholder, validity_range: after(5 * t_mspe) }
  // Compare the result so the (crashing) call is forced.
  get_current_epoch(tx, t_mspe) == 5
}

// ═══════════════════════════════════════════════════════════════
// Tests — VAULT-IDENTITY state-thread NFT (genesis-clean anchor, MAINNET-BLOCK)
// ═══════════════════════════════════════════════════════════════

fn t_seed() -> OutputReference {
  OutputReference { transaction_id: t_tx_id, output_index: 1 }
}

// A genesis-clean VaultDatum: empty everything, LAMP == deposited, profile Ember.
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

fn t_genesis_out(datum: VaultDatum, balance: Int, nft_name: ByteArray) -> Output {
  Output {
    address: address.from_script(t_vault_hash),
    value: assets.from_asset(t_lamp_policy, t_lamp_name, balance)
      |> assets.add(t_vault_hash, nft_name, 1),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn t_seed_input() -> Input {
  Input {
    output_reference: t_seed(),
    output: Output {
      address: address.from_script(t_vault_hash),
      value: assets.from_lovelace(2_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn t_mint_tx(nft_name: ByteArray, vault_out: Output) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: [t_seed_input()],
    mint: assets.from_asset(t_vault_hash, nft_name, 1),
    outputs: [vault_out],
    extra_signatories: [t_owner],
  }
}

// VID-POS-1: clean genesis mint — all fields pinned, LAMP bound to output.
test mint_clean_genesis_ok() {
  let seed = t_seed()
  let nft_name = crypto.blake2b_256(cbor.serialise(seed))
  let gd = t_genesis_datum(100)
  let vault_out = t_genesis_out(gd, 100, nft_name)
  let tx = t_mint_tx(nft_name, vault_out)
  validate_mint_vault_id(seed, t_vault_hash, t_lamp_policy, t_lamp_name, tx)
}

// VID-NEG-1: dirty genesis mint — fabricated magic_batches must be rejected.
test poc_dirty_mint_rejected() fail {
  let seed = t_seed()
  let nft_name = crypto.blake2b_256(cbor.serialise(seed))
  let dirty =
    VaultDatum {
      ..t_genesis_datum(100),
      magic_batches: [t_batch(t_bid_a, 0, 999_999_999, 1)],
    }
  let vault_out = t_genesis_out(dirty, 100, nft_name)
  let tx = t_mint_tx(nft_name, vault_out)
  validate_mint_vault_id(seed, t_vault_hash, t_lamp_policy, t_lamp_name, tx)
}

// VID-NEG-1b: dirty genesis via a pre-loaded vacuum order — also rejected
// (this is the exact lever a fabricated vault would use to drain LAMP on fire).
test poc_dirty_mint_vacuum_order_rejected() fail {
  let seed = t_seed()
  let nft_name = crypto.blake2b_256(cbor.serialise(seed))
  let dirty =
    VaultDatum {
      ..t_genesis_datum(100),
      vacuum_orders: [
        VacuumOrder { order_id: t_bid_a, commit_epoch: 0, fire_epoch: 2, lamp_amount: 100 },
      ],
    }
  let vault_out = t_genesis_out(dirty, 100, nft_name)
  let tx = t_mint_tx(nft_name, vault_out)
  validate_mint_vault_id(seed, t_vault_hash, t_lamp_policy, t_lamp_name, tx)
}

// VID-POS-2: normal spend preserves the NFT on the continuing output → ok.
test spend_preserves_nft_ok() {
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let bout = MagicBatch { ..bin, current_amount: 600 }
  let din  = t_datum_b([bin], None)
  let dout = t_after_burn(din, [bout], 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(t_bid_a, 400)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// VID-NEG-2: spend that drops the NFT off the continuing output → reject.
test spend_drops_nft_fail() fail {
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let bout = MagicBatch { ..bin, current_amount: 600 }
  let din  = t_datum_b([bin], None)
  let dout = t_after_burn(din, [bout], 10)
  // continuing output has LAMP but NO vault-id NFT
  let no_nft_out =
    Output {
      address: address.from_script(t_vault_hash),
      value: assets.from_asset(t_lamp_policy, t_lamp_name, 100),
      datum: InlineDatum(dout),
      reference_script: None,
    }
  let tx = t_tx([t_vault_input(din, 100)], [no_nft_out], [t_owner])
  validate_burn_batch(din, [(t_bid_a, 400)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}

// A fabricated vault INPUT (no NFT) — the attacker parked it at the vault
// address with a forged datum, since no script runs at UTxO creation.
fn t_fabricated_input(datum: VaultDatum, balance: Int) -> Input {
  Input {
    output_reference: t_own_ref(),
    output: Output {
      address: address.from_script(t_vault_hash),
      value: assets.from_asset(t_lamp_policy, t_lamp_name, balance),  // NO NFT
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

// POC-1: fabricated vault (no NFT) CANNOT VacuumFire → cannot drain LAMP.
// Fails at the identity gate (single_nft_name on the input, empty list) BEFORE
// any treasury transfer or MAGIC mint is reached.
test poc_fabricated_vacuum_fire_fails() fail {
  let order =
    VacuumOrder { order_id: t_bid_a, commit_epoch: 3, fire_epoch: 5, lamp_amount: 50 }
  let din =
    VaultDatum {
      ..t_datum(100, 50, [t_holding(100, 5, True)]),
      vacuum_orders: [order],
    }
  let dout =
    VaultDatum {
      ..t_datum(50, 0, [t_holding(50, 5, False)]),
      last_updated_epoch: 5,
    }
  let tx =
    t_tx(
      [t_fabricated_input(din, 100)],
      [t_vault_output(dout, 50)],
      [],
    )
  validate_vacuum_fire(
    din, t_bid_a, 5, t_own_ref(), t_lamp_policy, t_lamp_name,
    address.from_script(t_vault_hash), t_lamp_policy, t_vault_hash, tx,
  )
}

// POC-2: fabricated vault (no NFT) CANNOT BurnBatch → cannot mint fabricated
// MAGIC accounting. Fails at the identity gate on the input.
test poc_fabricated_magic_burn_batch_fails() fail {
  let bin  = t_batch(t_bid_a, 5, 1000, 10)
  let bout = MagicBatch { ..bin, current_amount: 600 }
  let din  = t_datum_b([bin], None)
  let dout = t_after_burn(din, [bout], 10)
  let tx =
    t_tx([t_fabricated_input(din, 100)], [t_vault_output(dout, 100)], [t_owner])
  validate_burn_batch(din, [(t_bid_a, 400)], 10, t_own_ref(), t_lamp_policy, t_lamp_name, tx)
}
