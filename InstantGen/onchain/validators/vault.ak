// validators/vault.ak — Vault spending validator (InstantGen)
// Normative: Specs/MagicLamp-Tripletoken-Feat-(Vi).md §4.2, §6.1, §6.3, §7, §12.
// PlutusV3 / Aiken ≥ 1.1.x
//
// MODEL (PHA 2 — three invariants that reshaped this file):
//   I-ACT-7      LAMP NEVER MOVES when MAGIC is generated. Holding LAMP only
//                opens eligibility; `lamp_balance`, `lamp_locked` and
//                `loyalty_holdings` are byte-identical across an InstantGen.
//                There is no Treasury leg any more.
//   §4.2 cliff   A MAGIC batch is live only inside its own `created_epoch`
//                (decay_window = 1). No halving, no carry-over.
//   §6.1 Gen v2.0  Lượng sinh = min( amount_by_lamp(L, L_lent, usage_window, ρ),
//                GB_available ), cộng dồn trong epoch (SPEC §6.1.1–§6.1.4). Bản
//                cũ (thưởng theo MAGIC đã tiêu, UM, `br`) đã bỏ ở gói b1/b2.
//
// Parameterized by (Gen v2.0, gói b1 — thứ tự là hợp đồng với mọi bộ dựng):
//   #1 lamp_policy_id        : PolicyId of LAMP native asset
//   #2 lamp_asset_name       : LAMP asset name theo mạng (tLAMP / LAMP)
//   #3 gb_beacon_nft_policy  : policy NFT beacon GreenBack ("GBB") — nhánh sinh đọc
//   #4 gb_beacon_script_hash : script beacon GreenBack — neo hai lớp cùng #3
//   #5 gb_shard_policy_id    : policy = script hash shard GB. b1: mọi nhánh KHÔNG
//                              sinh từ chối tx có input tại `Script(#5)` (một két
//                              đi nhánh khác mà đồng tiêu shard là rút cạn shard
//                              không sinh gì — `gb_shard.spend` không đọc được nhánh
//                              của két, nên chặn ở phía két).
//   #6 rate_nft_policy       : policy NFT beacon ρ ("RHO")
//   #7 rate_script_hash      : script beacon ρ — neo hai lớp cùng #6
//   #8 wakeme_vault_hash     : hash script két Wakeme CHUẨN. KHÔNG BAO GIỜ lấy từ
//                              redeemer/datum: chọn được hash là chọn được két.
//                              G1b: không nhánh spend nào nhận input tại `Script(#8)`.
//   #9 ms_per_epoch          : POSIX ms per epoch (per-network)
//   #10 window_origin_ms     : gốc lưới cửa sổ (POSIX ms, theo mạng) — LAMP
//                              `Specs/Window/CONTRACT.md` v1.0. Epoch = (t − #10) / #9.
// Bỏ so với bản trước: `um_nft_policy`, `um_script_hash`, `backing_nft_policy`,
// `backing_script_hash` (Gen v2.0 không đọc UM, không đọc `br`).
//
// Build on testnet:
//   aiken build
//   # applies the 10 parameters, producing the script hash

use aiken/builtin
use aiken/cbor
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use aiken/primitive/bytearray
use aiken/interval.{Finite}
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets.{PolicyId, Value}
use cardano/certificate.{Certificate, UnregisterCredential}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}

use magiclamp/protocol/owner_auth.{owner_authorized}
use magiclamp/protocol/window_origin_fixtures
use magiclamp/protocol/types.{
  ActivityProfile, ActivityState, BurnBatch, Ember, EpochUsage, Flame,
  GbShard, GreenBackBeacon, Instant, InstantGen, Lantern, LoyaltyHolding, MagicBatch,
  PendingProfile, PruneExpired, RateParam, RefreshCheckpoint, SetDelegate,
  UpdateProfile, VaultAttribution, VaultDatum, VaultRedeemer, WithdrawLamp,
}
use magiclamp/protocol/constants.{
  magic_decay_window, max_batches_per_vault, max_loyalty_holdings,
  min_instant_holding, profile_change_cooldown, wakeme_seed_credit,
}
use magiclamp/protocol/decay.{
  count_expired, instant_gen_in_epoch, is_expired, prune_expired,
}
use magiclamp/protocol/greenback.{
  greenback_open, shard_draw, shard_nft_name, vault_shard_id,
}
use magiclamp/protocol/math.{compute_cap_lent, compute_cap_pp}
use magiclamp/protocol/lamp.{l_avail, remove_newest_first, sum_holdings}
use magiclamp/protocol/profile.{apply_pending_profile}
use magiclamp/protocol/checkpoint.{
  Checkpoint, FollowVault, FollowVaultOrUnlink, KeepLink, VaultParams,
  checkpoint_written, current_checkpoint, empty_window, expected_checkpoint,
  expected_checkpoint_for_gen,
}
use magiclamp/protocol/gen_formula.{
  amount_by_lamp, gb_vault_share, shift_window, window_add,
}

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
//   Preprod:        432_000_000   (đổi 86_400_000 → 432_000_000 ngày 2026-09-20)
//   Preview:         86_400_000
validator vault(
  lamp_policy_id        : PolicyId,
  lamp_asset_name       : ByteArray,
  gb_beacon_nft_policy  : PolicyId,
  gb_beacon_script_hash : ScriptHash,
  gb_shard_policy_id    : PolicyId,
  rate_nft_policy       : PolicyId,
  rate_script_hash      : ScriptHash,
  wakeme_vault_hash     : ScriptHash,
  ms_per_epoch          : Int,
  window_origin_ms      : Int,
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

    let params =
      VaultParams {
        lamp_policy_id,
        lamp_asset_name,
        gb_beacon_nft_policy,
        gb_beacon_script_hash,
        gb_shard_policy_id,
        rate_nft_policy,
        rate_script_hash,
        wakeme_vault_hash,
        ms_per_epoch,
        window_origin_ms,
      }

    // ── G1b: két Wakeme KHÔNG BAO GIỜ bị tiêu cùng két IG ─────────────────
    // Két Wakeme chỉ được ĐỌC (reference input). Ép ngay ở đây cho MỌI nhánh, không
    // dựa vào luật tách rời của sổ cái Conway (luật đó áp theo phiên bản giao thức,
    // chưa kiểm ở kho này).
    expect no_input_at(tx.inputs, wakeme_vault_hash)

    // ── Shard GB chỉ đi cùng nhánh SINH ──────────────────────────────────
    // `gb_shard.spend` chỉ đòi "có một két thật đi kèm", không đọc được két đi nhánh
    // nào. Nhánh không sinh mà cho đồng tiêu shard là cho rút cạn shard.
    let is_gen =
      when redeemer is {
        InstantGen { .. } -> True
        _ -> False
      }
    expect is_gen || no_input_at(tx.inputs, gb_shard_policy_id)

    // ── Derive current epoch from tx validity range ──────────
    // Plutus V3 validity_range carries POSIX milliseconds, not slots.
    let current_epoch = get_current_epoch(tx, ms_per_epoch, window_origin_ms)

    when redeemer is {
      // ── InstantGen — Gen v2.0 (gói b2) ───────────────────────
      InstantGen { claimed_amount } ->
        validate_instant_gen(
          input_datum, claimed_amount, current_epoch, own_ref, params, tx,
        )

      // ── PruneExpired — permissionless dead-batch GC (§7.4) ─
      PruneExpired ->
        validate_prune_expired(input_datum, current_epoch, own_ref, params, tx)

      // ── BurnBatch — datum-consume (D1, no token, no mint) ──
      // Consuming MAGIC = subtracting from magic_batches[].current_amount in
      // the vault datum. MAGIC never leaves the vault as a token. The
      // price/`required` match (Σburns == required) is enforced by the
      // ConsumeMAGIC validator in the co-spend tx; the vault enforces the safe
      // datum mutation + value lock.
      BurnBatch { burns } ->
        validate_burn_batch(input_datum, burns, current_epoch, own_ref, params, tx)

      // ── UpdateProfile (full impl — SPEC_V1 §2/§3) ────────
      UpdateProfile { new_profile } ->
        validate_update_profile(
          input_datum, new_profile, current_epoch, own_ref, params, tx,
        )

      // ── WithdrawLamp (SPEC_V1 §1) ────────────────────────
      WithdrawLamp { amount } ->
        validate_withdraw_lamp(input_datum, amount, current_epoch, own_ref, params, tx)

      // ── SetDelegate — chỉ xoá (Nợ #14) ───────────────────
      SetDelegate { new_delegate } ->
        validate_set_delegate(
          input_datum, new_delegate, current_epoch, own_ref, params, tx,
        )

      // ── RefreshCheckpoint (Gen v2.0) ─────────────────────
      RefreshCheckpoint ->
        validate_refresh_checkpoint(input_datum, current_epoch, own_ref, params, tx)
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

  // ── CLEAN genesis — constrain ALL 20 fields ─────────────────────────────
  // owner: a Credential the creator controls — VerificationKey(pkh) ký, hoặc
  // Script(h) có mục rút trong tx (owner_auth). No squatting a victim's credential,
  // and the creator can actually spend the result.
  expect owner_authorized(tx, vd.owner)

  // LAMP accounting bound to the REAL deposited LAMP (no claiming a balance you
  // did not deposit).
  let lamp_qty = assets.quantity_of(vault_out.value, lamp_policy_id, lamp_asset_name)
  expect vd.lamp_balance == lamp_qty
  expect vd.lamp_locked == 0
  expect sum_holdings(vd.loyalty_holdings) == vd.lamp_balance
  expect list.all(vd.loyalty_holdings, fn(h) { !h.is_locked })
  expect list.length(vd.loyalty_holdings) <= max_loyalty_holdings

  // MAGIC state MUST be empty, and the consumed credit MUST be exactly the
  // Wakeme seed — this equality is the exact lever the attack fabricated.
  //
  // What blocks the fabrication is the `==`, not the number on its right. The
  // attack authored an ARBITRARY consumed_credit; pinning the field to a
  // compile-time constant refuses every value the creator could pick, 0 and
  // `wakeme_seed_credit + 1` alike. Both directions are pinned by
  // `mint_genesis_zero_credit_rejected` and `mint_genesis_credit_off_by_one_rejected`.
  //
  // Pinning it to 0 additionally shut the InstantGen loop for good (Nợ #19):
  // the only writer of `consumed_credit` sits behind `BurnBatch`, which needs a
  // batch that only InstantGen can create. See `constants.ak` ▸ `wakeme_seed_credit`.
  expect vd.magic_batches == []
  expect vd.next_batch_index == 0
  expect vd.activity_state == ActivityState {
    recent_burn_epochs: [],
    consumed_credit: wakeme_seed_credit,
  }

  // Every other ledger empty/zeroed.
  // Gen v2.0: link khai sẵn lúc genesis (2026-10-02). Rỗng, hoặc đúng 32 byte — khuôn
  // `owner_commit` = blake2b_256(DID) = tên NFT két Wakeme (`wakeme_lent.ak` ▸
  // `owner_commit_len`, vế (b) `nft_name == owner_commit`).
  //
  // Vì sao phải cho khai sẵn: Wakeme chỉ cho ghim két IG khi két IG đã mang
  // `link == owner_commit` (`genesis_gen_pin_ok`, `repin_gen_period` @ Wakeme 4512fe6),
  // mà các nhánh spend chỉ ghi được link khi đọc thấy một két Wakeme ĐÃ có trên chuỗi.
  // Bắt link rỗng ở đây thì genesis két Wakeme không bao giờ ghim được két IG ⟹ lượt
  // sinh đầu của người mới không tính được LAMP ở két Wakeme.
  //
  // Vì sao an toàn:
  //   - nhánh này đã đòi chữ ký chủ két (`owner_authorized` ở trên) ⟹ link là lời khai
  //     của chính chủ két IG;
  //   - link một mình không cho gì: phần mượn chỉ được tính khi két Wakeme của DID đó
  //     ghim CHÍNH két IG này (`wakeme_lent.ak` vế (c)), mà ghim cần chủ DID ký 2-of-2
  //     bên Wakeme;
  //   - link sai/lạ (két Wakeme chưa có, hoặc của DID khác): chủ két gỡ bằng
  //     RefreshCheckpoint (`FollowVaultOrUnlink`: không có két ⟹ link := ""). Cho tới
  //     lúc đó, mọi nhánh làm mới khác (sinh, BurnBatch, UpdateProfile, SetDelegate,
  //     và PruneExpired KHÔNG chữ ký) fail vì luật 2 "đã ghim thì bắt buộc đọc" — tức
  //     người ngoài không dọn hộ được két đó; két chỉ tự làm khó chính chủ, không
  //     chạm ai khác. WithdrawLamp không đọc két Wakeme nên không bị kẹt.
  expect or {
      vd.wakeme_link == #"",
      builtin.length_of_bytearray(vd.wakeme_link) == 32, // MUT-B3-link
    }
  expect vd.gen_schedules == []
  expect vd.profile_changed_epoch == 0
  expect vd.pending_profile == None
  expect vd.last_updated_epoch == 0
  // Gen v2.0: cap chưa tính lần nào. `cap_epoch = 0` < mọi epoch thật ⟹ lượt
  // spend đầu tiên (trừ WithdrawLamp) BẮT BUỘC làm mới — một `cap_nanogic` bịa
  // không sống qua được lượt đó, nhưng két Wakeme đọc ô này theo vị trí, nên nó
  // vẫn phải sạch ngay từ lúc sinh.
  expect vd.cap_epoch == 0
  expect vd.cap_nanogic == 0
  expect vd.personal_delegate == None
  expect vd.attribution == VaultAttribution {
    attribution_root: #"",
    last_event_epoch: 0,
    total_events: 0,
  }
  // Két mới chưa sinh lần nào ⟹ chưa khoá gì. Ghim ở đây vì đây là lúc DUY NHẤT
  // ghim được: Cardano không chạy validator lúc tạo UTxO, nên một két dựng với
  // `instant_unlock_ms` bịa sẵn sẽ không bao giờ bị nhánh spend nào hỏi tới —
  // các nhánh đó chỉ ĐÔNG CỨNG trường, chúng không kiểm nó bắt đầu từ đâu. Bịa
  // một mốc TƯƠNG LAI chỉ tự khoá mình, nhưng bịa được thì cũng ghim được, và
  // một ô không ai ghim là một ô mở cho hình dạng khác sau này.
  expect vd.instant_unlock_ms == 0
  // Gen v2.0: cửa sổ 7 ô toàn 0, epoch của ô đầu = 0 (không phải epoch hiện tại):
  // dịch một cửa sổ toàn 0 sang bất kỳ epoch nào vẫn ra cửa sổ toàn 0, nên hai lựa
  // chọn cho cùng một trạng thái từ lượt spend đầu tiên — và 0 không bắt giao dịch
  // genesis mang `validity_range` hữu hạn. Cùng lúc giữ bất biến
  // `usage_window_epoch == cap_epoch` ngay từ genesis.
  expect vd.usage_window == empty_window()
  expect vd.usage_window_epoch == 0
  // profile NOT pinned: it is a user-chosen STRATEGY (Ember/Flame/Lantern), not
  // accumulated state. The type is bounded to 3 valid values and (where
  // UpdateProfile exists) changeable under cooldown, so pinning gives no security
  // benefit while it would reject every vault the standard off-chain flow creates
  // (default Flame). Any of the 3 enum values is a valid genesis strategy.

  // ── No dust bundled into the genesis output ──────────────────────────────
  // At most {ADA, LAMP, vault_id NFT}.
  expect list.length(assets.policies(vault_out.value)) <= 3

  // ── G16: không reference script trên output genesis ─────────────────────
  // Mọi nhánh spend ép `None` (`validate_vault_value`, RefreshCheckpoint); genesis
  // phải ép cùng điều kiện — Cardano không chạy validator spend lúc tạo UTxO, nên đây
  // là chỗ DUY NHẤT chặn được một két sinh ra đã mang sẵn ref-script (đội min-ADA, và
  // lượt chi đầu của chủ phải trả phí ref-script theo byte của nó).
  expect vault_out.reference_script == None

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
// validate_instant_gen — Gen v2.0 (gói b2), SPEC §6.1.1–§6.1.4
//
// `claimed_amount` = lượng sinh `m` của lượt này (nanogic). Lượt sinh KHÔNG tiêu LAMP
// (I-ACT-7): `lamp_*`, `loyalty_holdings` đứng yên. Cổng theo thứ tự trong thân hàm:
//
//   IG-1  đúng một input tại script két (C-VAULT-DS-1)
//   IG-2  chữ ký chủ két
//   IG-3  thời gian không lùi (`last_updated_epoch`)
//   IG-4  `m > 0` (không có giao dịch cấp 0)
//   IG-5  checkpoint làm mới theo `FollowVault` khi `cap_epoch < e` (ρ, két Wakeme,
//         dịch cửa sổ) + `L_lent` của lượt này (`expected_checkpoint_for_gen`)
//   IG-6  G2: `lamp_balance + L_lent ≥ min` và `avail + L_lent ≥ min`
//   IG-7  còn chỗ cho một batch (`live < max_batches_per_vault`)
//   IG-8  cộng dồn trong epoch ≤ `cap_nanogic` (= `amount_by_lamp` của epoch)
//   IG-9  cộng dồn trong epoch ≤ `compute_cap_pp(avail) + compute_cap_lent(L_lent)`
//   IG-10 beacon GreenBack: đúng một, đúng NFT + script, không `depeg`, tươi
//   IG-11 shard của két (byte 0 tên NFT két mod 16): rút ĐÚNG `m`, còn lại ≥ 0
//         (⟺ `m ≤ GB_available`)
//   IG-12 trần mỗi-két-mỗi-epoch: `open.generated + m ≤ gb_vault_share(reset_amount)`
//   IG-13 datum ra: so NGUYÊN bản ghi (batch mới, chỉ số, epoch, attribution, khoá
//         Instant, checkpoint + `m` vào vế `generated` ô 0)
//   IG-14 value: LAMP khớp datum, NFT + ADA + tập token giữ nguyên
//
// IG-8 và IG-9 đều CỘNG DỒN (`gen_so_far + m`). SPEC §6.1.4 nói "người dùng xin
// `m ≤ amount`" và "cộng dồn ≤ compute_cap_pp"; nếu chỉ chặn `m ≤ amount_by_lamp` MỖI
// LƯỢT thì chia một epoch thành nhiều lượt nhỏ lấy trọn `compute_cap_pp` (≥
// `amount_by_lamp` vì `ρ ≤ rho_max_q = 4·10⁹` và `usage_factor ≤ Q`), tức `ρ` và
// `usage_ratio` mất tác dụng. IG-9 KHÔNG thừa: `cap_nanogic` chốt ở lượt làm mới đầu
// epoch, còn `avail`/`L_lent` có thể hạ sau đó trong cùng epoch (rút LAMP trước lượt
// sinh đầu tiên, két Wakeme vắng) — IG-9 đọc số HIỆN TẠI.
//
// `gen_so_far` = `instant_gen_in_epoch` (SUY RA từ batch, SPEC §6.1.4 "Hình dạng đã
// hiện thực" (1)). IG-12 đọc vế `generated` của ô 0 như SPEC §6.1.2/§6.1.3 viết; trên
// két thật hai số bằng nhau (chỉ lượt sinh cộng vào ô 0 `generated`, batch cùng epoch
// không rời danh sách khi còn sống).
// ═══════════════════════════════════════════════════════════════
fn validate_instant_gen(
  input_datum    : VaultDatum,
  claimed_amount : Int,
  current_epoch  : Int,
  own_ref        : OutputReference,
  params         : VaultParams,
  tx             : Transaction,
) -> Bool {
  let m = claimed_amount
  let own_input = find_own_input(own_ref, tx.inputs)
  let vault_addr = own_input.output.address

  // IG-1
  expect list.count(tx.inputs, fn(i) { same_script(i.output.address, vault_addr) }) == 1
  // IG-2
  expect owner_authorized(tx, input_datum.owner)
  // IG-3
  expect current_epoch >= input_datum.last_updated_epoch
  // IG-4 — MUT-GEN-ZERO
  expect m > 0

  let applied = apply_pending_profile(input_datum, current_epoch)

  // IG-5
  expect Script(own_hash) = own_input.output.address.payment_credential
  let own_name = single_nft_name(own_input.output.value, own_hash)
  let (cp, lent) =
    expected_checkpoint_for_gen(
      applied, tx.reference_inputs, current_epoch, own_hash, own_name, params,
    )

  // IG-6 — G2 tính cả LAMP-mượn (hai vế; `lamp_locked` ghim 0 ở genesis và đứng yên
  // mọi nhánh, nên trên két thật hai vế trùng — giữ cả hai như bản trước).
  expect applied.lamp_balance + lent >= min_instant_holding
  let avail = l_avail(applied.lamp_balance, applied.lamp_locked)
  expect avail + lent >= min_instant_holding

  // IG-7
  let live_batches = prune_expired(applied.magic_batches, current_epoch)
  expect list.length(live_batches) < max_batches_per_vault

  // IG-8, IG-9 — MUT-GEN-CUMUL
  let gen_so_far = instant_gen_in_epoch(live_batches, current_epoch)
  expect gen_so_far + m <= cp.cap_nanogic
  expect gen_so_far + m <= compute_cap_pp(avail) + compute_cap_lent(lent)

  // IG-10
  expect
    greenback_open(
      tx.reference_inputs, params.gb_beacon_nft_policy,
      params.gb_beacon_script_hash, current_epoch,
    )

  // IG-11 — MUT-GEN-SHARD
  let (gb_available, reset_amount, remaining_out) =
    shard_draw(
      tx.inputs, tx.outputs, params.gb_shard_policy_id, vault_shard_id(applied.owner),
    )
  expect remaining_out == gb_available - m
  expect remaining_out >= 0

  // IG-12 — MUT-GEN-SHARE
  expect [open, ..] = cp.usage_window
  expect open.generated + m <= gb_vault_share(reset_amount)

  // IG-13
  let new_batch =
    MagicBatch {
      batch_id: compute_batch_id(own_ref, applied.next_batch_index),
      source: Instant,
      created_epoch: current_epoch,
      initial_amount: m,
      current_amount: m,
      decay_window: magic_decay_window,
      profile_at_creation: None,
      contract_id: None,
      halved: False,
    }
  // Khoá Instant (`CC-GEN-L-TIMING`): `max(mốc cũ, cận-trên-validity + ms_per_epoch)`.
  let unlock_from_now = get_validity_upper_ms(tx) + params.ms_per_epoch
  let new_unlock_ms =
    if applied.instant_unlock_ms > unlock_from_now {
      applied.instant_unlock_ms
    } else {
      unlock_from_now
    }
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)
  expect
    output_datum == VaultDatum {
      ..applied,
      magic_batches: list.concat(live_batches, [new_batch]),
      next_batch_index: applied.next_batch_index + 1,
      last_updated_epoch: current_epoch,
      attribution: VaultAttribution {
        attribution_root: output_datum.attribution.attribution_root,
        last_event_epoch: current_epoch,
        total_events: applied.attribution.total_events + 1,
      },
      instant_unlock_ms: new_unlock_ms,
      wakeme_link: cp.wakeme_link,
      cap_epoch: cp.cap_epoch,
      cap_nanogic: cp.cap_nanogic,
      // MUT-GEN-GENERATED
      usage_window: window_add(cp.usage_window, m, 0),
      usage_window_epoch: cp.usage_window_epoch,
    }

  // IG-14
  let vault_output = find_vault_output(tx.outputs, vault_addr)
  expect
    assets.quantity_of(
      vault_output.value,
      params.lamp_policy_id,
      params.lamp_asset_name,
    ) == output_datum.lamp_balance
  validate_vault_value(own_input, vault_output)
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
  params         : VaultParams,
  tx             : Transaction,
) -> Bool {
  let lamp_policy_id = params.lamp_policy_id
  let lamp_asset_name = params.lamp_asset_name

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
  expect output_datum.gen_schedules == applied_input.gen_schedules
  expect output_datum.profile == applied_input.profile
  expect output_datum.profile_changed_epoch == applied_input.profile_changed_epoch
  expect output_datum.pending_profile == applied_input.pending_profile
  expect output_datum.activity_state == applied_input.activity_state
  expect output_datum.personal_delegate == applied_input.personal_delegate
  expect output_datum.attribution == applied_input.attribution

  // ── Khoá Instant ĐÔNG CỨNG (`CC-GEN-L-TIMING`) ────────────
  //
  // Nhánh này KHÔNG CẦN CHỮ KÝ, nên nó là nhánh nguy nhất trong cả két đối với
  // một ô ghi được: thiếu dòng này thì bất kỳ ai cũng dựng được một lượt dọn rác
  // hợp lệ có kèm `instant_unlock_ms: 0` ở đầu ra, và khoá của nạn nhân bốc hơi
  // mà không nhánh nào sai và không bài kiểm nào đỏ. Đó đúng là lý do bộ đếm ở
  // `C-INST-8` được để dạng SUY RA — một đại lượng không có ô thì không có dòng
  // nào để quên. Trường này thì có ô, nên nó phải trả đủ giá ở MỌI nhánh spend.
  expect output_datum.instant_unlock_ms == applied_input.instant_unlock_ms

  // ── VALUE PRESERVATION ────────────────────────────────────
  let prune_vault_output = find_vault_output(tx.outputs, vault_addr)
  let prune_vault_lamp =
    assets.quantity_of(prune_vault_output.value, lamp_policy_id, lamp_asset_name)
  expect prune_vault_lamp == output_datum.lamp_balance

  // ADA / token-set preservation — CRITICAL here because the path is
  // permissionless: without it a stranger reroutes the vault's surplus ADA or
  // stuffs dust tokens to brick the UTxO.
  expect validate_vault_value(find_own_input(own_ref, tx.inputs), prune_vault_output)

  // ── Gen v2.0 checkpoint — nhánh KHÔNG chữ ký: `KeepLink` ──────────────────
  // Làm mới khi `cap_epoch < e` như mọi nhánh; KHÔNG đổi được `wakeme_link`
  // (luật 1). Link đặt ⟹ bắt buộc có đúng két đó (luật 2).
  let (own_hash, own_name) = own_vault_identity(own_ref, tx.inputs)
  let cp =
    expected_checkpoint(
      applied_input, tx.reference_inputs, current_epoch, KeepLink, False,
      own_hash, own_name, params,
    )
  expect checkpoint_written(output_datum, cp)

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
///   O + epoch*P ≤ lower_ms   AND   upper_ms < O + (epoch+1)*P
/// so `(lower_ms − O) / P == (upper_ms − O) / P == epoch`. The on-chain clock then
/// forces `current_epoch` to be the real epoch of the slot the tx lands in — the
/// caller can no longer choose it. The `(lower_ms − O) / ms_per_epoch` definition
/// of `epoch` already gives `O + epoch*P ≤ lower_ms`; we only need the upper bound.
///
/// `O = window_origin_ms` (LAMP `Specs/Window/CONTRACT.md` v1.0): thời gian → epoch
/// TRỪ gốc trước khi chia (WIN-ORIGIN-1); epoch → mốc biên CỘNG gốc (WIN-ORIGIN-2).
fn get_current_epoch(tx: Transaction, ms_per_epoch: Int, window_origin_ms: Int) -> Int {
  expect Some(lower_ms) = tx.validity_range.lower_bound.bound_type |> get_finite_slot
  let epoch = ( lower_ms - window_origin_ms ) / ms_per_epoch
  // upper_bound must be finite AND in the same epoch as lower_bound.
  expect Some(upper_ms) = tx.validity_range.upper_bound.bound_type |> get_finite_slot
  expect upper_ms < window_origin_ms + ( epoch + 1 ) * ms_per_epoch
  epoch
}

/// Cận DƯỚI của `validity_range`, POSIX mili-giây. Dùng cho câu hỏi *"đã tới lúc
/// chưa"*: người gọi chỉ hạ được nó xuống, và hạ xuống làm mốc đến MUỘN hơn — tức
/// chiều gian lận duy nhất còn lại là tự làm khó mình.
fn get_validity_lower_ms(tx: Transaction) -> Int {
  expect Some(lower_ms) = tx.validity_range.lower_bound.bound_type |> get_finite_slot
  lower_ms
}

/// Cận TRÊN của `validity_range`, POSIX mili-giây. Dùng cho câu hỏi *"khoá tới
/// bao giờ"*: người gọi chỉ đẩy được nó về phía sau, và đẩy về sau làm khoá DÀI
/// hơn. Xem khối lý lẽ ở `types.ak` ▸ `instant_unlock_ms` về việc vì sao cận dưới
/// KHÔNG gác được câu hỏi này.
fn get_validity_upper_ms(tx: Transaction) -> Int {
  expect Some(upper_ms) = tx.validity_range.upper_bound.bound_type |> get_finite_slot
  upper_ms
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
///   - reference_script(out) == None         → a permissionless branch (PruneExpired)
///     cannot park a ~15 KB reference script on the vault, which would make every
///     later owner tx pay the per-byte ref-script fee (G16, 2026-10-03).
/// The per-handler LAMP-quantity check still pins the LAMP amount itself.
fn validate_vault_value(vault_input: Input, vault_output: Output) -> Bool {
  // vault_id policy = own script hash, read from the input being spent.
  expect Script(vault_id_policy) = vault_input.output.address.payment_credential
  let nft_name = single_nft_name(vault_input.output.value, vault_id_policy)
  expect assets.quantity_of(vault_output.value, vault_id_policy, nft_name) == 1

  expect lovelace_not_decreased(vault_input, vault_output)
  expect list.length(assets.policies(vault_output.value)) <= 3
  // G16: không gắn reference script vào output két (khuôn PrepaidGen
  // `vault_identity_preserved`, GenBeacons `continuing_pair`).
  expect vault_output.reference_script == None
  True
}

/// lovelace(out) >= lovelace(in) — the ONE ADA rule shared by every spend branch.
///
/// Why `>=` and never `==`: a branch that rewrites the datum can make the
/// continuing output LONGER than the input (checkpoint fields, a 32-byte
/// `wakeme_link`, larger CBOR ints), and the ledger's min-ADA grows with output
/// size. An exact-lovelace pin then leaves a vault opened at bare min-ADA with no
/// valid transition at all — measured on the Lucid emulator 2026-09-30:
/// a vault at 1_978_290 lovelace could not `RefreshCheckpoint`. `>=` lets the
/// caller top up ADA; the vault's ADA still never shrinks.
fn lovelace_not_decreased(vault_input: Input, vault_output: Output) -> Bool {
  assets.lovelace_of(vault_output.value) >= assets.lovelace_of(vault_input.output.value)
}

/// The single asset name held under `policy` in `value` (qty must be 1).
/// `expect`-fails if there is not EXACTLY one such token — a fabricated vault
/// carrying zero vault_id tokens is rejected right here.
fn single_nft_name(value: Value, policy: PolicyId) -> ByteArray {
  expect [Pair(name, qty)] = assets.tokens(value, policy) |> dict.to_pairs
  expect qty == 1
  name
}

/// Two addresses belong to the same SCRIPT iff their payment credentials match.
/// The stake credential is deliberately ignored — nothing constrains it, so one
/// script hash presents as arbitrarily many distinct `Address` values and every
/// "exactly one at MY address" guard counts each of them separately. Same rule,
/// same reason, as `ScheduleGen/onchain/validators/vault.ak` (Nợ #31) and
/// `ConsumeMAGIC/onchain/lib/magiclamp/consume/util.ak` ▸ `is_at_script`.
///
/// A third anchor used to stand here — `Consolidate/.../vault_consolidate.ak`.
/// That module was removed from the repo on 2026-09-21 (`DevStatus.md` ▸
/// `## Đã xoá khỏi kho — 2026-09-21`). The rule did not change with it; only the
/// pointer did. Saying so beats deleting the line, because the line's job is to
/// record that this repo KNEW the rule before it applied it here.
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
  params         : VaultParams,
  tx             : Transaction,
) -> Bool {
  let lamp_policy_id = params.lamp_policy_id
  let lamp_asset_name = params.lamp_asset_name

  // W-1: amount > 0
  expect amount > 0

  // W-2: owner authorizes (ký nếu VerificationKey, rút-0 nếu Script — owner_auth)
  expect owner_authorized(tx, input_datum.owner)

  // W-3: amount ≤ L_avail
  let avail = l_avail(input_datum.lamp_balance, input_datum.lamp_locked)
  expect amount <= avail

  // ── W-3b (`CC-GEN-L-TIMING`): LAMP đã nuôi một lượt sinh thì chưa đi đâu cả ──
  //
  // Đây là nửa thứ hai của cận bảo toàn. Nửa thứ nhất — `C-INST-8` ở nhánh sinh —
  // giữ `Σ sinh ≤ trần theo LAMP` TRONG MỘT KÉT. Nó không giữ được gì khi chính
  // số LAMP ấy rời két: rút ra, nạp vào két thứ hai, sinh tiếp, và két thứ hai có
  // bộ đếm bằng 0. Cùng một đồng LAMP nuôi hai lượt sinh trong một cửa sổ ⟹ cận
  // gãy. Cổng này là chỗ DUY NHẤT chặn đường đó, vì đây là nhánh duy nhất trong
  // két làm `lamp_balance` giảm. Đếm lại tập nhánh ấy, đừng tin danh sách:
  //
  //   grep -n "lamp_balance -" InstantGen/onchain/validators/vault.ak
  //
  // Đọc ở: cột số dòng, rồi tra ngược ra hàm chứa nó bằng
  // `grep -n "^fn " InstantGen/onchain/validators/vault.ak`. Lệnh cố ý KHÔNG khớp
  // `lamp_balance ==` — mọi dòng `==` là chỗ GHIM `lamp_balance` đứng yên, tức
  // đúng những nhánh KHÔNG cần cổng này.
  //
  // KHOÁ TOÀN BỘ chứ không khoá một lượng. `cap_pp` tính từ TRỌN `l_avail`, nên
  // số LAMP đứng sau quyền sinh là cả phần khả dụng, không phải một phần nào đó
  // của nó. Một trường `instant_locked` riêng vì thế đo lại đúng con số đã có, và
  // trả thêm bằng một ô ghi được nữa phải đông cứng ở mọi nhánh.
  //
  // Cận DƯỚI của `validity_range` cho câu hỏi *"đã tới lúc chưa"*: người gọi chỉ
  // hạ nó xuống được, mà hạ xuống thì mốc đến muộn hơn.
  expect get_validity_lower_ms(tx) >= input_datum.instant_unlock_ms

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
  expect output_datum.gen_schedules == input_datum.gen_schedules
  expect output_datum.profile == input_datum.profile
  expect output_datum.profile_changed_epoch == input_datum.profile_changed_epoch
  expect output_datum.pending_profile == input_datum.pending_profile
  expect output_datum.activity_state == input_datum.activity_state
  expect output_datum.personal_delegate == input_datum.personal_delegate
  expect output_datum.attribution == input_datum.attribution
  // Khoá Instant đông cứng — rút KHÔNG được đặt lại mốc (xem `validate_prune_expired`).
  expect output_datum.instant_unlock_ms == input_datum.instant_unlock_ms
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

  // ── Gen v2.0: checkpoint GHIM NGUYÊN, không đọc reference input nào ─────────
  // (luật 4, SPEC §6.1.5): rút LAMP không được phụ thuộc beacon ρ hay két Wakeme.
  // Một beacon chết hay một két Wakeme đã đóng KHÔNG được khoá LAMP của chủ.
  expect checkpoint_written(output_datum, current_checkpoint(input_datum))

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
// — consume.ak ép về phía vault, vault không ép ngược lại. Câu này VẪN ĐÚNG sau
// 2026-09-16 và không được đọc thành "đã vá": vá dưới đây thu hẹp NGƯỜI KÝ, nó
// không dựng liên kết giá hai chiều.
//
// 🪦 ĐÃ VÁ 2026-09-16 (Nợ #14) — bản trước của khối này mô tả một lỗ ĐANG SỐNG
// ("một `personal_delegate` ký được một tx BurnBatch trần trụi … đốt sạch MAGIC
// của chủ vault") và đề xuất cổng co-spend làm bản vá. Cả hai vế nay đã cũ:
//   • Lỗ: chết cùng nhánh uỷ nhiệm — auth nay là CHỈ CHỦ SỞ HỮU.
//   • Bản vá đề xuất: bị BÁC, không phải bị hoãn. Cổng co-spend đặt ở BurnBatch
//     về nguyên tắc không đóng được bán kính, vì cùng vị từ auth gác nhiều
//     handler và `PrepaidDraw` (PrepaidGen) KHÔNG đi qua BurnBatch. Phạm vi lấy
//     bằng TÊN HANDLER thay vì bằng grep vị từ auth là chỗ hỏng phương pháp.
// ═══════════════════════════════════════════════════════════════
fn validate_burn_batch(
  input_datum    : VaultDatum,
  burns          : List<(ByteArray, Int)>,
  current_epoch  : Int,
  own_ref        : OutputReference,
  params         : VaultParams,
  tx             : Transaction,
) -> Bool {
  let lamp_policy_id = params.lamp_policy_id
  let lamp_asset_name = params.lamp_asset_name

  // ── DS-1: exactly one vault input (no double-satisfaction) ──
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { same_script(i.output.address, vault_addr) }) == 1

  // ── AUTH: CHỈ CHỦ SỞ HỮU ký ───────────────────────────────
  // 🪦 BIA MỘ — nhánh uỷ nhiệm (`personal_delegate`) CHẾT 2026-09-16 (Nợ #14).
  // Vế cũ là `owner || personal_delegate`, và nó đủ một mình để đốt sạch MAGIC
  // của chủ vault: không cần Engage input, không cần ConsumeMAGIC có mặt, không
  // hạn mức, không hạn dùng. Trường datum `personal_delegate` (field 15) GIỮ
  // NGUYÊN chỗ làm bia mộ nhị phân — vault InstantGen đang sống trên
  // Preview/Preprod, bỏ trường là vỡ decode mọi UTxO đã tạo.
  //
  // Datum còn mang `Some(d)` của đời trước thì đường uỷ quyền bị TỪ CHỐI, không
  // phải bỏ qua: vế owner đứng một mình nên chữ ký delegate không thoả gì cả.
  expect owner_authorized(tx, input_datum.owner)

  // ── MONOTONIC EPOCH guard (MAINNET-BLOCK — epoch gaming) ──
  // Giữ nguyên sau khi nhánh uỷ nhiệm chết: một epoch lùi làm SỐNG LẠI batch đã
  // chết (§4.2 tính sống theo created_epoch vs current_epoch), và chính chủ cũng
  // dựng được tx như vậy. Cổng này canh THỜI GIAN, không canh người ký.
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

  // ── A02: field-by-field output datum check (18 fields) ────
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  expect output_datum.owner == applied.owner
  expect output_datum.lamp_balance == applied.lamp_balance       // BurnBatch never touches LAMP
  expect output_datum.lamp_locked == applied.lamp_locked
  expect output_datum.loyalty_holdings == applied.loyalty_holdings
  expect output_datum.magic_batches == expected_batches          // the only MAGIC change
  expect output_datum.next_batch_index == applied.next_batch_index
  expect output_datum.gen_schedules == applied.gen_schedules
  expect output_datum.profile == applied.profile
  expect output_datum.profile_changed_epoch == applied.profile_changed_epoch
  expect output_datum.pending_profile == applied.pending_profile
  expect output_datum.activity_state ==
    ActivityState {
      ..applied.activity_state,
      consumed_credit: applied.activity_state.consumed_credit + total_burned,
    }
  expect output_datum.personal_delegate == applied.personal_delegate  // delegate unchanged here
  expect output_datum.last_updated_epoch == current_epoch
  expect output_datum.attribution.total_events == applied.attribution.total_events + 1
  expect output_datum.attribution.last_event_epoch == current_epoch
  // Khoá Instant đông cứng — đốt MAGIC không mở được khoá LAMP
  // (xem `validate_prune_expired`). Chính vòng `sinh → đốt → sinh` là đường mà
  // `C-INST-8` chặn, nên nhánh đốt mà nới được khoá là mở lại nửa kia của nó.
  expect output_datum.instant_unlock_ms == applied.instant_unlock_ms

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
  // ── Gen v2.0 checkpoint — chủ ký: `FollowVault` ─────────────────────────
  // Làm mới (nếu `cap_epoch < e`) TRƯỚC, rồi cộng `total_burned` vào vế
  // `consumed` của ô 0 — ô 0 là epoch `e` sau khi dịch.
  let (own_hash, own_name) = own_vault_identity(own_ref, tx.inputs)
  let cp =
    expected_checkpoint(
      applied, tx.reference_inputs, current_epoch, FollowVault, False, own_hash,
      own_name, params,
    )
  expect
    checkpoint_written(
      output_datum,
      Checkpoint {
        ..cp,
        usage_window: window_add(cp.usage_window, 0, total_burned),
      },
    )

  True
}

/// Subtract `burns` from the batch list.
/// For each (batch_id, amount): there must be EXACTLY one matching batch; that
/// batch must still be LIVE at `current_epoch` (§4.2 use-or-lose — a batch is
/// spendable only inside its own created_epoch); 0 < amount ≤ current_amount;
/// every other field stays immutable (T4); a batch whose result is 0 STAYS in
/// the list carrying `current_amount: 0` (see the red note in the body — it is
/// what keeps `instant_gen_in_epoch` from being reset by a burn).
/// List order is preserved for every batch. Over-burn, unknown batch_id
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
            // 🔴 Batch đốt sạch Ở LẠI mang `current_amount: 0`, KHÔNG bị xoá.
            //
            // Bản trước trả `None` ở đây, và đó là đường lách cổng `C-INST-8`:
            // bộ đếm `instant_gen_in_epoch` cộng `initial_amount` của các batch
            // CÒN TRONG DANH SÁCH, nên xoá phần tử là xoá bộ đếm. Chuỗi
            // `InstantGen → BurnBatch(đốt trọn) → InstantGen` vì thế lấy được
            // trọn trần hai lần trong cùng một epoch, trên cùng số LAMP, chỉ
            // bằng chữ ký của chính chủ két. Bài canh: `bb_full_burn_giu_batch`
            // và `chain_gen_burn_gen_vuot_tran_bi_tu_choi`.
            //
            // Giữ lại là AN TOÀN ở mọi đường đọc khác: `batch_balance` trả
            // `current_amount` cho batch còn sống nên một batch 0 đóng góp 0 vào
            // `live_total`; `apply_burns` đòi `amt > 0` và `amt <= current_amount`
            // nên không ai đốt lại được nó; `prune_expired` dọn nó ở epoch sau.
            //
            // Giá phải trả, nói thẳng: một suất trong trần `max_batches_per_vault`
            // không còn được nhả lại bằng cách đốt. Đó là ĐÚNG — số lượt sinh
            // trong một epoch phải bị chặn, và trần ấy chính là chỗ chặn.
            Some(MagicBatch { ..b, current_amount: b.current_amount - amt })
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
  params         : VaultParams,
  tx             : Transaction,
) -> Bool {
  let lamp_policy_id = params.lamp_policy_id
  let lamp_asset_name = params.lamp_asset_name

  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { same_script(i.output.address, vault_addr) }) == 1

  // ONLY owner may change the delegate (a delegate cannot re-delegate itself)
  expect owner_authorized(tx, input_datum.owner)

  // 🪦 BIA MỘ — nhánh này nay CHỈ XOÁ ĐƯỢC, không đặt được (2026-09-16, Nợ #14).
  // `SetDelegate` (constr 5) ở lại nguyên chỗ: chỉ số constructor là hợp đồng
  // nhị phân, đổi thứ tự variant là vỡ decode mọi redeemer đã phát. Cái chết là
  // QUYỀN, không phải cái vỏ.
  //
  // 🪦 Lý do CŨ ghi ở đây — "vault Preview/Preprod còn mang `Some(d)` và đây là
  // nhánh duy nhất dọn nó" — TỰ CHỌI CHÍNH NÓ: bản vá đổi bytes ⟹ đổi script
  // hash ⟹ đổi địa chỉ, nên vault đời trước bị tiêu bởi bytes CŨ và validator
  // này không bao giờ thấy chúng. Dọn `Some(d)` đời cũ là việc DI TRÚ, không
  // phải việc của dòng này (Nợ #14).
  //
  // Dưới hash NÀY, `Some` không sinh ra được — cửa đúc ép
  // `personal_delegate == None` và không nhánh nào khác ghi trường đó — nên
  // dòng dưới và `fail` tương đương về hành vi. Giữ dạng này vì nhánh còn đi
  // tới được, nên bài kiểm chứng minh được CẢ HAI vế (đặt bị từ chối / xoá qua).
  expect new_delegate == None

  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  // Every field immutable EXCEPT personal_delegate + last_updated_epoch
  expect output_datum.owner == input_datum.owner
  expect output_datum.lamp_balance == input_datum.lamp_balance
  expect output_datum.lamp_locked == input_datum.lamp_locked
  expect output_datum.loyalty_holdings == input_datum.loyalty_holdings
  expect output_datum.magic_batches == input_datum.magic_batches
  expect output_datum.next_batch_index == input_datum.next_batch_index
  expect output_datum.gen_schedules == input_datum.gen_schedules
  expect output_datum.profile == input_datum.profile
  expect output_datum.profile_changed_epoch == input_datum.profile_changed_epoch
  expect output_datum.pending_profile == input_datum.pending_profile
  expect output_datum.activity_state == input_datum.activity_state
  expect output_datum.attribution == input_datum.attribution
  // Khoá Instant đông cứng ở nhánh uỷ nhiệm (xem `validate_prune_expired`).
  expect output_datum.instant_unlock_ms == input_datum.instant_unlock_ms

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

  // ── Gen v2.0 checkpoint — chủ ký: `FollowVault` ─────────────────────────
  let (own_hash, own_name) = own_vault_identity(own_ref, tx.inputs)
  let cp =
    expected_checkpoint(
      input_datum, tx.reference_inputs, current_epoch, FollowVault, False,
      own_hash, own_name, params,
    )
  expect checkpoint_written(output_datum, cp)

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
  params         : VaultParams,
  tx             : Transaction,
) -> Bool {
  let lamp_policy_id = params.lamp_policy_id
  let lamp_asset_name = params.lamp_asset_name

  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { same_script(i.output.address, vault_addr) }) == 1

  // C-PC-V1: owner authorizes (owner_auth)
  expect owner_authorized(tx, input_datum.owner)

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
  expect output_datum.gen_schedules == input_datum.gen_schedules
  expect output_datum.activity_state == input_datum.activity_state
  expect output_datum.personal_delegate == input_datum.personal_delegate
  expect output_datum.attribution == input_datum.attribution
  // Khoá Instant đông cứng ở nhánh đổi hồ sơ (xem `validate_prune_expired`).
  expect output_datum.instant_unlock_ms == input_datum.instant_unlock_ms

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

  // ── Gen v2.0 checkpoint — chủ ký: `FollowVault` ─────────────────────────
  let (own_hash, own_name) = own_vault_identity(own_ref, tx.inputs)
  let cp =
    expected_checkpoint(
      input_datum, tx.reference_inputs, current_epoch, FollowVault, False,
      own_hash, own_name, params,
    )
  expect checkpoint_written(output_datum, cp)

  True
}

// NOTE: the former `treasury_receives_lamp` helper is GONE. Under I-ACT-7 no
// handler moves LAMP out of the vault, so there is no Treasury leg and no
// `treasury_addr` apply-parameter left in this validator.

// ═══════════════════════════════════════════════════════════════
// validate_refresh_checkpoint — Gen v2.0 (constr 6), chủ ký
//
// CHỈ ghi năm ô checkpoint (`FollowVaultOrUnlink`, luôn làm mới kể cả cùng
// epoch). Mọi trường khác ghim bằng một phép so NGUYÊN datum; value ghim
// nguyên khối TRỪ lovelace (chỉ được tăng — xem `lovelace_not_decreased`). Có két Wakeme ghim két này ⟹ `link := owner_commit`; không có ⟹
// `link := ""` (cửa thoát khi két Wakeme đã ghim sang két khác hoặc đã đóng).
// ═══════════════════════════════════════════════════════════════
fn validate_refresh_checkpoint(
  input_datum   : VaultDatum,
  current_epoch : Int,
  own_ref       : OutputReference,
  params        : VaultParams,
  tx            : Transaction,
) -> Bool {
  let own_input = find_own_input(own_ref, tx.inputs)
  let vault_addr = own_input.output.address
  expect list.count(tx.inputs, fn(i) { same_script(i.output.address, vault_addr) }) == 1
  expect owner_authorized(tx, input_datum.owner)

  let (own_hash, own_name) = own_vault_identity(own_ref, tx.inputs)
  let cp =
    expected_checkpoint(
      input_datum, tx.reference_inputs, current_epoch, FollowVaultOrUnlink, True,
      own_hash, own_name, params,
    )

  let vault_output = find_vault_output(tx.outputs, vault_addr)
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)
  expect
    output_datum == VaultDatum {
      ..input_datum,
      wakeme_link: cp.wakeme_link,
      cap_epoch: cp.cap_epoch,
      cap_nanogic: cp.cap_nanogic,
      usage_window: cp.usage_window,
      usage_window_epoch: cp.usage_window_epoch,
    }
  // Value: mọi thứ NGOÀI lovelace ghim NGUYÊN KHỐI (LAMP, NFT vault-id, không thêm
  // không bớt tên nào — kể cả tên lạ dưới policy LAMP hay policy vault-id, thứ mà
  // phép đếm `≤ 3 policy` của `validate_vault_value` không bắt). Lovelace chỉ được
  // TĂNG (`lovelace_not_decreased`): datum ra dài hơn datum vào ⟹ min-ADA tăng, ghim
  // lovelace bằng tuyệt đối thì két mở sát min-ADA không làm mới được checkpoint.
  // Không dùng `validate_vault_value` ở đây vì nó LỎNG hơn phép so dưới về tập token.
  expect
    assets.without_lovelace(vault_output.value) == assets.without_lovelace(
      own_input.output.value,
    )
  expect lovelace_not_decreased(own_input, vault_output)
  // G16: nhánh này không đi qua `validate_vault_value` ⟹ ép riêng cổng ref-script.
  expect vault_output.reference_script == None
  True
}

/// Danh tính két đang tiêu: (hash script = policy NFT vault-id, tên NFT duy nhất).
/// `single_nft_name` fail nếu không đúng 1 tên số lượng 1 (vault bịa chết ở đây).
fn own_vault_identity(own_ref: OutputReference, inputs: List<Input>) -> (ScriptHash, ByteArray) {
  let own_input = find_own_input(own_ref, inputs)
  expect Script(own_hash) = own_input.output.address.payment_credential
  (own_hash, single_nft_name(own_input.output.value, own_hash))
}

/// Không input nào có payment credential `Script(h)`.
fn no_input_at(inputs: List<Input>, h: ScriptHash) -> Bool {
  !list.any(inputs, fn(i) { i.output.address.payment_credential == Script(h) })
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
// Tests
// Negatives use the `fail` annotation: test passes iff the body errors.
// ═══════════════════════════════════════════════════════════════

const t_owner_pkh: ByteArray =
  #"00000000000000000000000000000000000000000000000000000000"
const t_owner: Credential = VerificationKey(t_owner_pkh)
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
    wakeme_link: #"",
    gen_schedules: [],
    profile: Flame,
    profile_changed_epoch: 0,
    pending_profile: None,
    last_updated_epoch: 0,
    cap_epoch: 0,
    activity_state: ActivityState {
      recent_burn_epochs: [], consumed_credit: 0,
    },
    cap_nanogic: 0,
    personal_delegate: None,
    attribution: VaultAttribution {
      attribution_root: #"", last_event_epoch: 0, total_events: 0,
    },
    instant_unlock_ms: 0,
    usage_window: empty_window(),
    usage_window_epoch: 0,
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

// ── Khung thời gian cho bài kiểm ─────────────────────────────
//
// `placeholder` mang một `validity_range` VÔ HẠN hai đầu, nên mọi bài kiểm gọi
// thẳng một hàm đọc thời gian sẽ chết ở `expect Some(...)`. Đặt một khoảng HỮU
// HẠN ở đây để khung kiểm giống thứ nhánh `spend` thật luôn đòi hỏi: chính
// `get_current_epoch` đã ép cả hai đầu phải hữu hạn trước khi phân nhánh.
// Cố ý KHÔNG đặt `t_lo_ms = 0`: ở 0 thì "chưa từng sinh" (mốc `0`) và "đã hết
// khoá" (mốc ≤ `t_lo_ms`) trùng nhau thành một giá trị, và bài kiểm nào cần
// phân biệt hai trạng thái đó sẽ xanh vì hai vế bằng nhau chứ không vì cổng
// đúng. Đẩy khung giờ ra khỏi 0 để hai trạng thái tách được.
const t_lo_ms: Int = 10_000_000

const t_hi_ms: Int = 10_000_001

/// Một epoch Preprod/Mainnet tính bằng mili-giây (432.000 slot × 1000).
const t_ms_per_epoch: Int = 432_000_000


fn t_tx(ins: List<Input>, outs: List<Output>, signers: List<ByteArray>) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: ins,
    outputs: outs,
    extra_signatories: signers,
    validity_range: interval.between(t_lo_ms, t_hi_ms),
  }
}

// ── WithdrawLamp ──────────────────────────────────────────────

test w_positive_partial() {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner_pkh])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_params(), tx)
}

test w_amount_zero() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(din, 100)], [t_owner_pkh])
  validate_withdraw_lamp(din, 0, 0, t_own_ref(), t_params(), tx)
}

test w_over_avail() fail {
  let din = t_datum(100, 100, [t_holding(100, 5, True)])
  let dout = t_datum(95, 100, [t_holding(95, 5, True)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner_pkh])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_params(), tx)
}

test w_no_owner_sig() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_params(), tx)
}

test w_phantom_second_output() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx =
    t_tx(
      [t_vault_input(din, 100)],
      [t_vault_output(dout, 95), t_vault_output(dout, 95)],
      [t_owner_pkh],
    )
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_params(), tx)
}

// ── Nợ #31: double-satisfaction qua stake credential ──────────
// Same script hash + a stake credential = a different `Address`. Counting by
// full address let the twin read as somebody else's UTxO.

fn t_vault_output_staked(datum: VaultDatum, balance: Int) -> Output {
  Output {
    ..t_vault_output(datum, balance),
    address: address.from_script(t_vault_hash)
      |> address.with_delegation_key(t_owner_pkh),
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
      [t_owner_pkh],
    )
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_params(), tx)
}

// Counting loosened to payment credential; IDENTITY did not.
test ds_continuing_output_must_keep_stake_cred() fail {
  let din  = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output_staked(dout, 95)], [t_owner_pkh])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_params(), tx)
}

// ── Khoá LAMP sau một lượt sinh (`CC-GEN-L-TIMING`, W-3b) ─────
//
// Khung giờ của `t_tx` là `[t_lo_ms, t_hi_ms] = [0, 1]`, nên một két mang mốc mở
// khoá LỚN HƠN `t_lo_ms` là két đang khoá, và mốc `<= t_lo_ms` là két đã mở.
// Hai ca dưới đây chỉ khác nhau ở đúng con số ấy — nếu cổng bị gỡ thì ca thứ
// nhất chuyển sang xanh trong khi ca thứ hai không đổi, nên cặp này phân biệt
// được hai cực thay vì cùng xanh ở cả hai.

fn t_locked_datum(balance: Int, unlock_ms: Int) -> VaultDatum {
  VaultDatum {
    ..t_datum(balance, 0, [t_holding(balance, 5, False)]),
    instant_unlock_ms: unlock_ms,
  }
}

test w_locked_after_gen_rejected() fail {
  let din  = t_locked_datum(100, t_hi_ms + 1)
  let dout = t_locked_datum(95, t_hi_ms + 1)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner_pkh])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_params(), tx)
}

test w_after_unlock_ok() {
  let din  = t_locked_datum(100, t_lo_ms - 1)
  let dout = t_locked_datum(95, t_lo_ms - 1)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner_pkh])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_params(), tx)
}

// Rút KHÔNG được đặt lại mốc: đầu ra khai `0` trong khi đầu vào mang một mốc
// ĐÃ QUA. Lượt rút này hợp lệ ở mọi cổng khác — nó chỉ tiện tay xoá mốc — nên
// không có dòng đông cứng thì đây là đường rửa khoá một bước, và nó dọn đường
// cho lượt rút KẾ TIẾP diễn ra trong lúc khoá lẽ ra còn hiệu lực.
test w_clears_lock_rejected() fail {
  let din  = t_locked_datum(100, t_lo_ms - 1)
  let dout = t_locked_datum(95, 0)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner_pkh])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_params(), tx)
}

test w_advance_last_updated_rejected() fail {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout =
    VaultDatum {
      ..t_datum(95, 0, [t_holding(95, 5, False)]),
      last_updated_epoch: 5,
    }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner_pkh])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_params(), tx)
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
  let din = t_datum_e10()
  let dout = up_output(din, Ember, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_update_profile(din, Ember, 10, t_own_ref(), t_params(), tx)
}

// Đổi hồ sơ KHÔNG mở được khoá LAMP — cửa thứ tư của cùng một đường rửa khoá.
test up_neg_clears_lock() fail {
  let din =
    VaultDatum {
      ..t_datum_e10(),
      instant_unlock_ms: 9_000_000,
    }
  let dout = VaultDatum { ..up_output(din, Ember, 10), instant_unlock_ms: 0 }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_update_profile(din, Ember, 10, t_own_ref(), t_params(), tx)
}

test up_cooldown_not_met() fail {
  let din =
    VaultDatum {
      ..t_datum_e10(),
      profile_changed_epoch: 10,
    }
  let dout = up_output(din, Ember, 11)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_update_profile(din, Ember, 11, t_own_ref(), t_params(), tx)
}

test up_bypass_lazy() fail {
  let din = t_datum_e10()
  let dout = VaultDatum { ..up_output(din, Ember, 10), profile: Ember }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_update_profile(din, Ember, 10, t_own_ref(), t_params(), tx)
}

test up_same_profile() fail {
  let din = t_datum_e10()
  let dout = up_output(din, Flame, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_update_profile(din, Flame, 10, t_own_ref(), t_params(), tx)
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
    // Gen v2.0: checkpoint đã làm mới ở epoch 10 — các bài pe_* đi đường ghim.
    cap_epoch: 10,
    usage_window_epoch: 10,
  }
}

/// `t_datum` với checkpoint đã làm mới ở epoch 10 (bài up_* chạy ở epoch 10).
fn t_datum_e10() -> VaultDatum {
  VaultDatum {
    ..t_datum(100, 0, [t_holding(100, 5, False)]),
    cap_epoch: 10,
    usage_window_epoch: 10,
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
  validate_prune_expired(din, 10, t_own_ref(), t_params(), tx)
}

// P-POS-2: permissionless — no signature at all.
test pe_positive_no_signature_needed() {
  let dead = t_instant_batch(8, 800)
  let din  = t_datum_with_batches([dead])
  let dout = t_datum_with_batches([])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_prune_expired(din, 10, t_own_ref(), t_params(), tx)
}

// P-NEG-1: nothing dead → reject-noop (anti-spam).
test pe_neg_noop_rejected() fail {
  let live = t_instant_batch(10, 1000)        // k=0, still live
  let din  = t_datum_with_batches([live])
  let dout = t_datum_with_batches([live])
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_prune_expired(din, 10, t_own_ref(), t_params(), tx)
}

// P-NEG-2: prune must not eat a LIVE batch.
test pe_neg_live_batch_dropped() fail {
  let dead = t_instant_batch(9, 1000)
  let live = MagicBatch { ..t_instant_batch(10, 500), batch_id: #"ddeeff" }
  let din  = t_datum_with_batches([dead, live])
  let dout = t_datum_with_batches([])          // dropped the live one too
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_prune_expired(din, 10, t_own_ref(), t_params(), tx)
}

// P-NEG-3: lamp_balance mutated during a prune.
test pe_neg_lamp_balance_mutated() fail {
  let dead = t_instant_batch(9, 1000)
  let din  = t_datum_with_batches([dead])
  let dout = VaultDatum { ..t_datum_with_batches([]), lamp_balance: 90 }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_prune_expired(din, 10, t_own_ref(), t_params(), tx)
}

// P-NEG-4: GRIEFING — last_updated_epoch advanced on a permissionless path.
test pe_neg_epoch_advanced_griefing() fail {
  let dead = t_instant_batch(9, 1000)
  let din  = t_datum_with_batches([dead])
  let dout = VaultDatum { ..t_datum_with_batches([]), last_updated_epoch: 10 }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_prune_expired(din, 10, t_own_ref(), t_params(), tx)
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
  validate_prune_expired(din, 10, t_own_ref(), t_params(), tx)
}

// P-NEG-7: dọn rác KHÔNG mở được khoá LAMP của nạn nhân.
//
// Nhánh này không cần chữ ký, nên nếu thiếu dòng đông cứng thì bất kỳ ai cũng
// dựng được một lượt dọn hợp lệ có kèm `instant_unlock_ms: 0` ở đầu ra. Hai bài
// dưới chỉ khác nhau ở đúng trường đó.
test pe_neg_lock_cleared_by_stranger() fail {
  let dead = t_instant_batch(9, 1000)
  let din  =
    VaultDatum { ..t_datum_with_batches([dead]), instant_unlock_ms: 9_000_000 }
  let dout = t_datum_with_batches([])          // instant_unlock_ms = 0
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_prune_expired(din, 10, t_own_ref(), t_params(), tx)
}

test pe_positive_lock_preserved() {
  let dead = t_instant_batch(9, 1000)
  let din  =
    VaultDatum { ..t_datum_with_batches([dead]), instant_unlock_ms: 9_000_000 }
  let dout =
    VaultDatum { ..t_datum_with_batches([]), instant_unlock_ms: 9_000_000 }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_prune_expired(din, 10, t_own_ref(), t_params(), tx)
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
  validate_prune_expired(din, 10, t_own_ref(), t_params(), tx)
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
  validate_prune_expired(din, 10, t_own_ref(), t_params(), tx)
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
    // Gen v2.0: checkpoint đã làm mới ở epoch 10 (epoch mọi bài bb_*/sd_* chạy), nên
    // các bài này đi đường GHIM checkpoint và giữ nguyên chốt chúng mang tên.
    // Đường làm mới có bài riêng (`cp_*`).
    cap_epoch: 10,
    usage_window_epoch: 10,
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
    // Gen v2.0: đốt cộng vào vế `consumed` của ô 0 (epoch đang mở).
    usage_window: window_add(din.usage_window, 0, burned),
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
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_a, 400)], 10, t_own_ref(), t_params(), tx)
}

// BB-POS-2: a FULL burn KEEPS the batch, at current_amount 0.
//
// Bài này từng mang tên `bb_positive_full_prunes` và khẳng định điều NGƯỢC LẠI.
// Hành vi cũ là đường lách cổng `C-INST-8`: xoá phần tử khỏi danh sách là xoá
// bộ đếm `instant_gen_in_epoch`. Xem khối đỏ trong `apply_burns`.
test bb_full_burn_keeps_batch_at_zero() {
  let din = t_burn_din([t_burn_batch(bid_a, 1000), t_burn_batch(bid_b, 500)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 0), t_burn_batch(bid_b, 500)], 1000, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_a, 1000)], 10, t_own_ref(), t_params(), tx)
}

// BB-NEG: cực đối của bài trên. Đầu ra XOÁ batch đã đốt sạch ⟹ phải TỪ CHỐI.
// Không có ca này thì bài trên một mình không phân biệt được hai cực: nó xanh
// được chỉ vì `expect output_datum.magic_batches == expected_batches` so một
// danh sách với chính nó.
test bb_full_burn_dropping_batch_rejected() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000), t_burn_batch(bid_b, 500)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_b, 500)], 1000, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_a, 1000)], 10, t_own_ref(), t_params(), tx)
}

// Một batch đã về 0 KHÔNG đốt lại được: `apply_burns` đòi `amt > 0` và
// `amt <= current_amount`. Ca này ghim rằng việc giữ batch lại không mở ra một
// đường đốt-hai-lần.
test bb_zero_batch_not_burnable_again() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 0), t_burn_batch(bid_b, 500)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 0), t_burn_batch(bid_b, 500)], 0, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_a, 1)], 10, t_own_ref(), t_params(), tx)
}

// BB-POS-3: multi-batch burn in one tx
test bb_positive_multi() {
  let din = t_burn_din([t_burn_batch(bid_a, 1000), t_burn_batch(bid_b, 500)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700), t_burn_batch(bid_b, 200)], 600, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_a, 300), (bid_b, 300)], 10, t_own_ref(), t_params(), tx)
}

// BB-NEG-DELEGATE: đường tấn công Nợ #14 — delegate ký một mình, chủ KHÔNG ký,
// đốt MAGIC của chủ. Bài này từng là `bb_positive_delegate_signs` và từng XANH;
// nó đảo dấu 2026-09-16 khi nhánh uỷ nhiệm bị bỏ khỏi mô hình. Mọi vế khác của
// giao dịch hợp lệ — sai đúng MỘT thứ là người ký.
test bb_delegate_signs_rejected() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate))
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_params(), tx)
}

// BB-POS-4: ĐỐI CHỨNG DƯƠNG của bài ngay trên — CÙNG datum còn mang `Some(d)`
// của đời trước, chỉ đổi người ký sang chủ ⟹ CHẤP NHẬN. Cặp này phân biệt
// "chặn vì người ký sai" với "chặn vì datum có delegate"; thiếu nó thì một bản
// vá quá tay (khoá luôn vault còn delegate) vẫn xanh trọn bộ.
test bb_owner_signs_with_stale_delegate_ok() {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate))
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_params(), tx)
}

// BB-NEG-DEAD: §4.2 — burning a batch OUTSIDE its created_epoch is rejected.
// This is the use-or-lose cliff: at epoch 11 the epoch-10 batch is worth zero.
test bb_dead_batch_rejected() fail {
  let din  = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [], 300, 11)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_a, 300)], 11, t_own_ref(), t_params(), tx)
}

// BB-NEG-1: nobody authorized (no owner, no delegate signature)
test bb_neg_no_auth() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_params(), tx)
}

// BB-NEG-2: delegate not set but a stranger signs → reject
test bb_neg_stranger_no_delegate() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_params(), tx)
}

// BB-NEG-3: over-burn (amount > current_amount) forbidden
test bb_neg_over_burn() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [], 1001, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_a, 1001)], 10, t_own_ref(), t_params(), tx)
}

// BB-NEG-4: unknown batch_id
test bb_neg_unknown_id() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 1000)], 100, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_b, 100)], 10, t_own_ref(), t_params(), tx)
}

// BB-NEG-5: output forges a lower lamp_balance (value-leak) → reject
test bb_neg_lamp_balance_forged() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = VaultDatum {
    ..t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10),
    lamp_balance: 50,   // datum claims 50 but value carries 100
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_params(), tx)
}

// BB-NEG-6: value drained below claimed lamp_balance → reject
test bb_neg_value_drained() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10)
  // output value carries only 60 LAMP while datum claims 100
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 60)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_params(), tx)
}

// BB-NEG-7: attribution not incremented → reject
test bb_neg_attribution_not_bumped() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = VaultDatum {
    ..t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10),
    attribution: din.attribution,   // left untouched
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_params(), tx)
}

// BB-NEG-8: batch other field mutated (initial_amount tampered) → reject
test bb_neg_other_field_mutated() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let tampered = MagicBatch { ..t_burn_batch(bid_a, 700), initial_amount: 999 }
  let dout = t_burn_dout(din, [tampered], 300, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_params(), tx)
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
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_params(), tx)
}

// BB-NEG-10: consumed_credit INFLATED beyond what was burned → reject.
test bb_neg_consumed_credit_inflated() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300_000, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_params(), tx)
}

// ── SetDelegate (D1) ──────────────────────────────────────────

// SD-NEG-SET: chủ ĐẶT một delegate mới, mọi vế khác hợp lệ → vẫn TỪ CHỐI.
// Bài này từng là `sd_positive_set` và từng XANH; đảo dấu 2026-09-16 (Nợ #14).
// Đây là bài canh duy nhất cho cổng bia-mộ `new_delegate == None`.
test sd_set_rejected() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = VaultDatum {
    ..din,
    personal_delegate: Some(t_delegate),
    last_updated_epoch: 10,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_set_delegate(din, Some(t_delegate), 10, t_own_ref(), t_params(), tx)
}

// SD-POS-2: owner clears delegate Some → None
test sd_positive_clear() {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate))
  let dout = VaultDatum {
    ..din,
    personal_delegate: None,
    last_updated_epoch: 10,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_set_delegate(din, None, 10, t_own_ref(), t_params(), tx)
}

// SD-NEG-1: owner did not sign → reject.
// Dựng dưới dạng XOÁ (`new_delegate: None`) có chủ ý sau 2026-09-16: để
// `Some(...)` thì bài chết ở cổng bia-mộ và không còn đo cổng chữ ký nữa.
// Đổi uỷ nhiệm KHÔNG mở được khoá LAMP. Cùng họ với `pe_neg_lock_cleared_by_stranger`
// và `w_clears_lock_rejected`: mỗi nhánh spend là một cửa riêng để rửa khoá, và
// một cửa không gác thì hai cửa kia gác cũng bằng thừa.
test sd_neg_clears_lock() fail {
  let din =
    VaultDatum {
      ..t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate)),
      instant_unlock_ms: 9_000_000,
    }
  let dout = VaultDatum { ..din, personal_delegate: None, last_updated_epoch: 10,
                          instant_unlock_ms: 0 }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_set_delegate(din, None, 10, t_own_ref(), t_params(), tx)
}

test sd_neg_no_owner_sig() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate))
  let dout = VaultDatum {
    ..din,
    personal_delegate: None,
    last_updated_epoch: 10,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [])
  validate_set_delegate(din, None, 10, t_own_ref(), t_params(), tx)
}

// SD-NEG-2: chính delegate cũ tự dọn trường của mình (không có chữ ký chủ) →
// từ chối. Khác SD-NEG-1 ở người ký (rỗng vs delegate), nên hai bài không che
// nhau: một bài đo "không ai ký", bài kia đo "sai người ký".
test sd_neg_delegate_cannot_clear() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate))
  let dout = VaultDatum {
    ..din,
    personal_delegate: None,
    last_updated_epoch: 10,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_delegate])
  validate_set_delegate(din, None, 10, t_own_ref(), t_params(), tx)
}

// SD-NEG-3: output datum mutates MAGIC alongside the delegate change → reject.
// Dựng lại thành thao tác XOÁ (2026-09-16): dạng ĐẶT nay chết ở cổng bia-mộ,
// nên nó không còn chạm tới chốt bất-biến-trường mà bài này mang tên.
test sd_neg_mutates_magic() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate))
  let dout = VaultDatum {
    ..din,
    magic_batches: [t_burn_batch(bid_a, 500)],   // illicit MAGIC change
    personal_delegate: None,
    last_updated_epoch: 10,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_set_delegate(din, None, 10, t_own_ref(), t_params(), tx)
}

// SD-NEG-4: output delegate != redeemer new_delegate → reject.
// Redeemer nói XOÁ (`None`) nhưng datum ra vẫn giữ delegate cũ — hình dạng
// "giả vờ dọn": qua được cổng bia-mộ rồi chết ở chốt khớp trường.
test sd_neg_delegate_mismatch() fail {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate))
  let dout = VaultDatum {
    ..din,
    personal_delegate: Some(t_delegate),   // mismatch vs redeemer None
    last_updated_epoch: 10,
  }
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_set_delegate(din, None, 10, t_own_ref(), t_params(), tx)
}

// ══ Fixture két Wakeme (dùng cho bài checkpoint Gen v2.0) ══════════════════════
//
// Két Wakeme dựng bằng record CÓ KIỂU cùng hình `WakemeVaultDatum` (13 trường,
// `Option<GenPin>` thật), để ca ở đây đi đúng đường mã hoá mà `wakeme_read` đọc theo
// vị trí. Ghim ở kỳ 9; bài checkpoint chạy ở kỳ 10 (vế d đạt). Value két mang ĐÚNG
// `conditional + owned` LAMP của mạng (vế f đạt vừa khít).

/// Hash script két Wakeme chuẩn (apply-param #8 trong bài kiểm).
const t_wakeme_hash: ByteArray =
  #"cc62732565af6be1e0874975ad3b3e2afdb0abafb3f5bc4b3008f4e1"

const t_wakeme_commit: ByteArray =
  #"c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"

const t_wakeme_commit_2: ByteArray =
  #"c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4"

type TGenPin {
  hash: ByteArray,
  name: ByteArray,
}

type TWakemeDatum {
  owner_commit: ByteArray,
  usage_thread: ByteArray,
  vest_start_ms: Int,
  conditional_lamp: Int,
  reclaimed_to_pot: Int,
  epochy_start: Int,
  last_used_period: Int,
  owned_lamp: Int,
  d_unit: Int,
  seen_nanogic: Int,
  usage_consume_hash: ByteArray,
  gen_vault: Option<TGenPin>,
  gen_pin_period: Int,
}

fn t_wakeme_ref(
  index: Int,
  commit: ByteArray,
  pin_name: ByteArray,
  conditional: Int,
  owned: Int,
) -> Input {
  // vest_start 1_700_000_000_000 ở gốc 0 rơi vào kỳ 3935 ≠ 9 ⟹ vế genesis của
  // `wakeme_read` sai; két được tính nhờ `9 < 10` như trước.
  t_wakeme_ref_at(index, commit, pin_name, conditional, owned, 1_700_000_000_000, 9)
}

/// Như `t_wakeme_ref`, chọn được `vest_start_ms` ([2]) và `gen_pin_period` ([12]).
fn t_wakeme_ref_at(
  index: Int,
  commit: ByteArray,
  pin_name: ByteArray,
  conditional: Int,
  owned: Int,
  vest_start_ms: Int,
  gen_pin_period: Int,
) -> Input {
  t_wakeme_ref_gen(
    index, commit, Some(TGenPin { hash: t_vault_hash, name: pin_name }),
    conditional, owned, vest_start_ms, gen_pin_period,
  )
}

/// Như `t_wakeme_ref_at`, chọn được cả ô `gen_vault` ([11]) — kể cả `None`.
fn t_wakeme_ref_gen(
  index: Int,
  commit: ByteArray,
  gen_vault: Option<TGenPin>,
  conditional: Int,
  owned: Int,
  vest_start_ms: Int,
  gen_pin_period: Int,
) -> Input {
  let d: Data =
    TWakemeDatum {
      owner_commit: commit,
      usage_thread: #"e5e5",
      vest_start_ms,
      conditional_lamp: conditional,
      reclaimed_to_pot: 0,
      epochy_start: 5,
      last_used_period: 4,
      owned_lamp: owned,
      d_unit: 1_000_000,
      seen_nanogic: 0,
      usage_consume_hash: #"f6f6",
      gen_vault,
      gen_pin_period,
    }
  Input {
    output_reference: OutputReference { transaction_id: t_tx_id, output_index: 10 + index },
    output: Output {
      address: address.from_script(t_wakeme_hash),
      value: assets.from_lovelace(5_000_000)
        |> assets.add(t_wakeme_hash, commit, 1)
        |> assets.add(t_lamp_policy, t_lamp_asset_name, conditional + owned),
      datum: InlineDatum(d),
      reference_script: None,
    },
  }
}

/// Két Wakeme hợp lệ ghim đúng két IG của bài kiểm (`t_vault_id_name`).
fn t_lent_ref(conditional: Int, owned: Int) -> Input {
  t_wakeme_ref(0, t_wakeme_commit, t_vault_id_name, conditional, owned)
}

// BB-NEG-EMPTY: cửa 2 — không có batch nào thì không đốt được, nên
// `consumed_credit` không có đường nào rời khỏi 0.
test bb_neg_empty_batches_cannot_burn() fail {
  let din = t_burn_din([], None)
  let dout = t_burn_dout(din, [], 0, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  //    Danh sách đốt RỖNG, không phải một id không tồn tại: bản đầu của bài này
  //    dùng `[(bid_a, 0)]` và nó xanh — nhưng đo đột biến cho thấy nó chết ở chốt
  //    "id lạ", KHÔNG ở chốt `total_burned > 0`. Gỡ `total_burned > 0` ra thì cả
  //    100 bài vẫn xanh. Đó là ca Forall §Kỷ luật phát ngôn mục 6 tả: đỏ đúng tên,
  //    sai chốt.
  validate_burn_batch(
    din,
    [],
    10,
    t_own_ref(),
    t_params(),
    tx,
  )
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
  validate_prune_expired(din, 10, t_own_ref(), t_params(), tx)
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
  validate_prune_expired(din, 10, t_own_ref(), t_params(), tx)
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
  validate_prune_expired(din, 10, t_own_ref(), t_params(), tx)
}

// VAL-NEG-3: BurnBatch rút ADA ra khỏi vault → từ chối.
// Người ký đổi delegate → CHỦ ngày 2026-09-16: sau khi nhánh uỷ nhiệm chết, một
// bài ký bằng delegate sẽ chết ở cổng chữ ký và KHÔNG còn chạm tới cổng ADA —
// vẫn đỏ, vẫn mang đúng tên, mà không đo gì nữa.
test val_neg_burn_ada_drained() fail {
  let din  = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10)
  let tx =
    t_tx(
      [t_vault_input_ada(din, 5_000_000, 100)],
      [t_vault_output_ada(dout, 2_000_000, 100)],
      [t_owner_pkh],
    )
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_params(), tx)
}

// VAL-POS-2: ADA top-up (out > in) is allowed (honest min-ADA bump).
test val_pos_ada_topup_ok() {
  let din  = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10)
  let tx =
    t_tx(
      [t_vault_input_ada(din, 2_000_000, 100)],
      [t_vault_output_ada(dout, 3_000_000, 100)],  // owner adds ADA — fine
      [t_owner_pkh],
    )
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_params(), tx)
}

// EPOCH-NEG-1: BurnBatch với current_epoch < last_updated_epoch (thời gian lùi)
// → cổng đơn điệu từ chối.
// Người ký đổi delegate → CHỦ ngày 2026-09-16, cùng lý do như VAL-NEG-3: cổng
// chữ ký đứng TRƯỚC cổng epoch, nên bài ký bằng delegate không còn tới được chốt
// mang tên nó. Ca này vẫn có nghĩa với chủ: chính chủ cũng lùi được epoch để làm
// sống lại batch mà §4.2 đã đưa về không.
test epoch_neg_burn_backwards() fail {
  let din_base = t_burn_din([t_burn_batch(bid_a, 1000)], None)
  // vault already at epoch 20; the owner claims epoch 10 to revive dead MAGIC.
  let din = VaultDatum { ..din_base, last_updated_epoch: 20 }
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 700)], 300, 10)
  let tx = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_a, 300)], 10, t_own_ref(), t_params(), tx)
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
  get_current_epoch(tx, p, 0) == 10
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
  get_current_epoch(tx, p, 0) == 10
}

// EPOCH-NEG-3: unbounded upper (no finite upper_bound) → reject.
test epoch_neg_unbounded_upper() fail {
  let p = 86_400_000
  let tx =
    Transaction {
      ..placeholder,
      validity_range: interval.after(10 * p),  // upper = +inf
    }
  get_current_epoch(tx, p, 0) == 10
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
      address: address.from_script(t_owner_pkh),
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
    t_lamp_policy, t_lamp_asset_name, t_gb_beacon_policy, t_gb_beacon_hash,
    t_shard_hash, t_rate_policy, t_rate_hash, t_wakeme_hash, 86_400_000, 0,
    MintVaultId { seed }, policy_id, tx,
  )
}

/// Clean genesis datum (all fields at initial value); owner = t_owner.
fn t_clean_genesis(balance: Int) -> VaultDatum {
  // Any valid profile passes the mint gate (profile is no longer pinned).
  // Keep Lantern here; t_datum defaults to Flame for spend-path fixtures.
  // `t_datum` zeroes consumed_credit; genesis pins it to the Wakeme seed.
  VaultDatum {
    ..t_datum(balance, 0, [t_holding(balance, 5, False)]),
    profile: Lantern,
    activity_state: ActivityState {
      recent_burn_epochs: [],
      consumed_credit: wakeme_seed_credit,
    },
  }
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
    t_tx([t_vault_input_nonft(din, 100)], [t_vault_output_nonft(dout, 100)], [t_owner_pkh])
  validate_burn_batch(din, [(bid_a, 500)], 10, t_own_ref(), t_params(), tx)
}

// ── mint_clean_genesis_ok: a correct clean mint passes ────────────────────
test mint_clean_genesis_ok() {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  let bal  = 100
  let vd   = t_clean_genesis(bal)
  let out  = t_genesis_output(vd, bal, t_vault_hash, name)
  let m    = assets.from_asset(t_vault_hash, name, 1)
  let tx   = t_mint_tx(seed, out, m, [t_owner_pkh])
  t_mint_call(seed, t_vault_hash, tx)
}

// ── poc_dirty_mint_rejected: dirty datum at mint → rejected ────────────────
// Non-empty magic_batches AND a self-authored consumed_credit — the exact
// fabrication. 10^18 is far from `wakeme_seed_credit`, so this pins the gate
// only in the coarse direction; the two bài ngay dưới pin it at the boundary,
// which is where a gate written as `>=` instead of `==` would survive.
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
  let tx  = t_mint_tx(seed, out, m, [t_owner_pkh])
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
  let tx  = t_mint_tx(seed, out, m, [t_owner_pkh])
  t_mint_call(seed, t_vault_hash, tx)
}

// ── mint: consumed_credit = 0 at genesis → rejected ────────────────────────
// Cổng là một dấu BẰNG, nên nó từ chối cả chiều THẤP. Ghi bài này ra vì 0 là
// giá trị cổng cũ ÉP, nên nó là giá trị dễ sót lại nhất trong một máy dựng
// giao dịch chưa cập nhật — và một vault mở với credit 0 sẽ lại kẹt đúng
// Nợ #19, lần này im lặng, vì nó vẫn là một vault hợp lệ về mọi mặt khác.
test mint_genesis_zero_credit_rejected() fail {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  let bal  = 100
  let vd =
    VaultDatum {
      ..t_clean_genesis(bal),
      activity_state: ActivityState { recent_burn_epochs: [], consumed_credit: 0 },
    }
  let out = t_genesis_output(vd, bal, t_vault_hash, name)
  let m   = assets.from_asset(t_vault_hash, name, 1)
  let tx  = t_mint_tx(seed, out, m, [t_owner_pkh])
  t_mint_call(seed, t_vault_hash, tx)
}

// ── mint: két mới khai sẵn một mốc khoá → từ chối ──────────────────────────
// Cardano không chạy validator lúc TẠO UTxO, nên đây là lúc duy nhất ghim được
// giá trị khởi đầu của trường này. Các nhánh spend chỉ ĐÔNG CỨNG nó — chúng
// không hỏi nó bắt đầu từ đâu.
test mint_genesis_prefilled_lock_rejected() fail {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  let bal  = 100
  let vd   = VaultDatum { ..t_clean_genesis(bal), instant_unlock_ms: 1 }
  let out  = t_genesis_output(vd, bal, t_vault_hash, name)
  let m    = assets.from_asset(t_vault_hash, name, 1)
  let tx   = t_mint_tx(seed, out, m, [t_owner_pkh])
  t_mint_call(seed, t_vault_hash, tx)
}

// ── mint: consumed_credit = seed + 1 → rejected ────────────────────────────
// Ca lệch MỘT nanogic. Đây là bài phân biệt được `==` với `<=`, mà
// `poc_dirty_mint_rejected` (10^18) thì không: gate viết thành `<=` vẫn từ
// chối 10^18 và vẫn xanh ở đó, trong khi nó mở đường cho người tạo vault tự
// chọn mọi giá trị dưới trần.
test mint_genesis_credit_off_by_one_rejected() fail {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  let bal  = 100
  let vd =
    VaultDatum {
      ..t_clean_genesis(bal),
      activity_state: ActivityState {
        recent_burn_epochs: [],
        consumed_credit: wakeme_seed_credit + 1,
      },
    }
  let out = t_genesis_output(vd, bal, t_vault_hash, name)
  let m   = assets.from_asset(t_vault_hash, name, 1)
  let tx  = t_mint_tx(seed, out, m, [t_owner_pkh])
  t_mint_call(seed, t_vault_hash, tx)
}

// ── mint: tài sản thứ tư lọt vào output genesis → từ chối ──────────────────
// Cổng `policies(vault_out.value) <= 3` ở `validate_mint_vault_id` có từ trước
// hai bài này. Cái thiếu không phải cổng, là BÀI CANH nó: gỡ hẳn dòng đó rồi
// chạy trọn bộ (đo 2026-09-16) thì 105/105 vẫn xanh — nên tới hôm nay câu
// "nhánh mint đã ép hình dạng" không neo được vào phép đo nào.
//
// Hậu quả nếu cổng biến mất KHÔNG nằm ở nhánh mint. Output genesis mang tài
// sản thứ tư khoá vào êm, rồi `validate_vault_value` từ chối MỌI lượt chi sau
// đó — và LAMP chỉ ra được qua chính nhánh bị từ chối ấy. Vault hợp lệ thành
// vault chết vĩnh viễn, không lượt nào sửa ngược được.
//
// Hai bài đi THÀNH CẶP, và cặp mới là phép đo. Fixture genesis dùng ở các bài
// trên (`t_genesis_output`) KHÔNG kèm lovelace nên nó chỉ có HAI policy: một
// bài âm tính dựng trên nó vẫn xanh cả khi cổng bị gỡ, tức không phân biệt
// được hai cực. Bài dương ở đây mang đủ ba policy hợp lệ của một vault thật
// (ADA · LAMP · NFT danh-tính) — tức đúng trần, không dưới trần — nên bài âm
// ngay dưới là bước thứ TƯ, chỗ duy nhất dấu `<= 3` nói lên điều gì.
fn t_genesis_output_ada(
  vd: VaultDatum, balance: Int, policy: PolicyId, name: ByteArray, dust: Bool,
) -> Output {
  let base =
    assets.from_lovelace(2_000_000)
      |> assets.add(t_lamp_policy, #"744c414d50", balance)
      |> assets.add(policy, name, 1)
  Output {
    address: address.from_script(policy),
    value: if dust {
      assets.add(base, t_other_policy, #"6475737400", 1)
    } else {
      base
    },
    datum: InlineDatum(vd),
    reference_script: None,
  }
}

test mint_genesis_three_policies_ok() {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  let bal  = 100
  let out  = t_genesis_output_ada(t_clean_genesis(bal), bal, t_vault_hash, name, False)
  let m    = assets.from_asset(t_vault_hash, name, 1)
  let tx   = t_mint_tx(seed, out, m, [t_owner_pkh])
  t_mint_call(seed, t_vault_hash, tx)
}

test mint_genesis_fourth_asset_rejected() fail {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  let bal  = 100
  let out  = t_genesis_output_ada(t_clean_genesis(bal), bal, t_vault_hash, name, True)
  let m    = assets.from_asset(t_vault_hash, name, 1)
  let tx   = t_mint_tx(seed, out, m, [t_owner_pkh])
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
      extra_signatories: [t_owner_pkh],
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
  let tx   = t_mint_tx(seed, out, m, [t_owner_pkh])
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
  let tx   = t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 95)], [t_owner_pkh])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_params(), tx)
}

// ── spend_drops_nft_fail: input has NFT, output drops it → rejected ────────
test spend_drops_nft_fail() fail {
  let din  = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx   = t_tx([t_vault_input(din, 100)], [t_vault_output_nonft(dout, 95)], [t_owner_pkh])
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_params(), tx)
}

// ═══════════════════════════════════════════════════════════════
// owner: Credential — cổng `owner_authorized` (lib/owner_auth.ak)
// ═══════════════════════════════════════════════════════════════
// Mỗi cặp dùng CHUNG một bộ dựng (`t_bb_owner_case` / `t_mint_owner_case`): tx hợp lệ ở mọi
// mặt khác, chỉ ba đầu vào xác thực thay đổi — `owner`, danh sách ký, danh sách rút. Bài
// dương cùng bộ dựng xanh ⟹ bài âm đỏ vì cổng owner, không vì một ràng buộc khác.

const t_owner_script: ByteArray =
  #"abababababababababababababababababababababababababababab"

const t_other_script: ByteArray =
  #"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"

fn t_bb_owner_case(
  owner: Credential, signers: List<ByteArray>, ws: Pairs<Credential, Int>,
) -> Bool {
  t_bb_owner_case_c(owner, signers, ws, [])
}

fn t_bb_owner_case_c(
  owner: Credential, signers: List<ByteArray>, ws: Pairs<Credential, Int>,
  cs: List<Certificate>,
) -> Bool {
  let din =
    VaultDatum { ..t_burn_din([t_burn_batch(bid_a, 1000)], None), owner: owner }
  let dout = t_burn_dout(din, [t_burn_batch(bid_a, 600)], 400, 10)
  let tx =
    Transaction {
      ..t_tx([t_vault_input(din, 100)], [t_vault_output(dout, 100)], signers),
      withdrawals: ws,
      certificates: cs,
    }
  validate_burn_batch(din, [(bid_a, 400)], 10, t_own_ref(), t_params(), tx)
}

fn t_mint_owner_case(
  owner: Credential, signers: List<ByteArray>, ws: Pairs<Credential, Int>,
) -> Bool {
  t_mint_owner_case_c(owner, signers, ws, [])
}

fn t_mint_owner_case_c(
  owner: Credential, signers: List<ByteArray>, ws: Pairs<Credential, Int>,
  cs: List<Certificate>,
) -> Bool {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  let bal  = 100
  let vd   = VaultDatum { ..t_clean_genesis(bal), owner: owner }
  let out  = t_genesis_output(vd, bal, t_vault_hash, name)
  let m    = assets.from_asset(t_vault_hash, name, 1)
  let tx   = Transaction { ..t_mint_tx(seed, out, m, signers), withdrawals: ws, certificates: cs }
  t_mint_call(seed, t_vault_hash, tx)
}

// (5) đối chứng: chủ VerificationKey ký, qua đúng bộ dựng dùng cho các ca Script.
test owner_vk_signed_burn_batch_ok() {
  t_bb_owner_case(t_owner, [t_owner_pkh], [])
}

test owner_vk_signed_mint_ok() {
  t_mint_owner_case(t_owner, [t_owner_pkh], [])
}

// (1) chủ Script(h), tx rút 0 từ Script(h) ⟹ nhận.
test owner_script_zero_withdrawal_burn_batch_ok() {
  t_bb_owner_case(Script(t_owner_script), [], [Pair(Script(t_owner_script), 0)])
}

test owner_script_zero_withdrawal_mint_ok() {
  t_mint_owner_case(Script(t_owner_script), [], [Pair(Script(t_owner_script), 0)])
}

// (1b) chủ Script(h), rút LƯỢNG > 0 từ Script(h) ⟹ nhận. Lượng chỉ nói số dư thưởng đang
// là bao nhiêu (ledger ép mục rút == số dư), không nói tx là của ai.
test owner_script_positive_withdrawal_burn_batch_ok() {
  t_bb_owner_case(Script(t_owner_script), [], [Pair(Script(t_owner_script), 1)])
}

test owner_script_positive_withdrawal_mint_ok() {
  t_mint_owner_case(Script(t_owner_script), [], [Pair(Script(t_owner_script), 1)])
}

// (1c) hình dạng tx THU HỒI: chứng chỉ huỷ đăng ký `Script(h)` + rút 0, không chữ ký ⟹ từ
// chối. Đổi ĐÚNG một biến (thêm chứng chỉ) so với (1).
test owner_script_unregister_cert_burn_batch_rejected() fail {
  t_bb_owner_case_c(
    Script(t_owner_script), [], [Pair(Script(t_owner_script), 0)],
    [UnregisterCredential { credential: Script(t_owner_script), refund: Never }],
  )
}

test owner_script_unregister_cert_mint_rejected() fail {
  t_mint_owner_case_c(
    Script(t_owner_script), [], [Pair(Script(t_owner_script), 0)],
    [UnregisterCredential { credential: Script(t_owner_script), refund: Never }],
  )
}

// (1d) cặp dương của (1c): chứng chỉ về credential KHÁC không chạm cổng chủ.
test owner_script_other_cert_burn_batch_ok() {
  t_bb_owner_case_c(
    Script(t_owner_script), [], [Pair(Script(t_owner_script), 0)],
    [UnregisterCredential { credential: Script(t_other_script), refund: Never }],
  )
}

// (2) chủ Script(h), không có mục rút ⟹ từ chối.
test owner_script_no_withdrawal_burn_batch_rejected() fail {
  t_bb_owner_case(Script(t_owner_script), [], [])
}

test owner_script_no_withdrawal_mint_rejected() fail {
  t_mint_owner_case(Script(t_owner_script), [], [])
}

// (3) chủ Script(h), rút từ Script(h') khác ⟹ từ chối.
test owner_script_foreign_withdrawal_burn_batch_rejected() fail {
  t_bb_owner_case(Script(t_owner_script), [], [Pair(Script(t_other_script), 0)])
}

test owner_script_foreign_withdrawal_mint_rejected() fail {
  t_mint_owner_case(Script(t_owner_script), [], [Pair(Script(t_other_script), 0)])
}

// (3b) cùng 28 byte nhưng mục rút là VerificationKey(h), không phải Script(h) ⟹ từ chối.
test owner_script_vk_keyed_withdrawal_burn_batch_rejected() fail {
  t_bb_owner_case(
    Script(t_owner_script), [], [Pair(VerificationKey(t_owner_script), 0)],
  )
}

// (4) chủ Script(h), h chỉ nằm trong extra_signatories ⟹ từ chối.
test owner_script_hash_as_signer_burn_batch_rejected() fail {
  t_bb_owner_case(Script(t_owner_script), [t_owner_script], [])
}

test owner_script_hash_as_signer_mint_rejected() fail {
  t_mint_owner_case(Script(t_owner_script), [t_owner_script], [])
}

// (6) chủ VerificationKey(pkh), có mục rút Script(pkh) nhưng pkh KHÔNG ký ⟹ từ chối.
test owner_vk_script_withdrawal_unsigned_burn_batch_rejected() fail {
  t_bb_owner_case(t_owner, [], [Pair(Script(t_owner_pkh), 0)])
}

test owner_vk_script_withdrawal_unsigned_mint_rejected() fail {
  t_mint_owner_case(t_owner, [], [Pair(Script(t_owner_pkh), 0)])
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests — Gen v2.0 checkpoint (gói b1): wakeme_link / cap_* / usage_window
//
// Mọi ca âm dựng từ ĐÚNG ca dương cùng nhóm và đổi MỘT vế. Nền chung:
//   két 100 LAMP (100_000_000 oildrop), checkpoint ở epoch 8, chạy ở epoch 10
//   ⟹ làm mới BẮT BUỘC (cap_epoch 8 < 10), dịch cửa sổ k = 2.
//   ρ beacon {rho 2e9, prev 1e9, hiệu lực từ 5} ⟹ ρ(10) = 2e9.
//   Cửa sổ ở epoch 8: [(1e8,5e7),(1e8,5e7),(0,0),(1e8,5e7),(0,0),(7,7),(9,9)].
//   Sau dịch: ô 1..6 = (0,0),(1e8,5e7),(1e8,5e7),(0,0),(1e8,5e7),(0,0)
//   ⟹ Σg = 3e8, Σc = 1.5e8, ratio = 0.5Q, uf = 0.75Q, scale_limit = 5e7.
//   Không lent: base 2e8  ⟹ cap = 1e8 + ⌊5e7 × 0.25⌋ = 112_500_000.
//   L_lent 12 LAMP: base 2e8 + min(2.4e7, 1e9) ⟹ cap = 124_500_000.
//   Hai ô (7,7),(9,9) rơi khỏi cửa sổ khi dịch: bản KHÔNG dịch cho Σ khác.
// ═══════════════════════════════════════════════════════════════════════════

const t_gb_beacon_policy: ByteArray =
  #"7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a"

const t_gb_beacon_hash: ByteArray =
  #"7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b"

const t_shard_hash: ByteArray =
  #"7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c"

// Policy NFT ρ và script ρ KHÁC nhau trong bài kiểm (ngoài đời bằng nhau), để ca
// "sai địa chỉ" và ca "sai NFT" đo hai lớp riêng.
const t_rate_policy: ByteArray =
  #"7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d"

const t_rate_hash: ByteArray =
  #"7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e"

fn t_params() -> VaultParams {
  VaultParams {
    lamp_policy_id: t_lamp_policy,
    lamp_asset_name: t_lamp_asset_name,
    gb_beacon_nft_policy: t_gb_beacon_policy,
    gb_beacon_script_hash: t_gb_beacon_hash,
    gb_shard_policy_id: t_shard_hash,
    rate_nft_policy: t_rate_policy,
    rate_script_hash: t_rate_hash,
    wakeme_vault_hash: t_wakeme_hash,
    ms_per_epoch: t_ms_per_epoch,
    window_origin_ms: 0,
  }
}

fn t_rate_ref(index: Int, at_hash: ByteArray, nft_policy: ByteArray) -> Input {
  let d: Data =
    RateParam { rho_q: 2_000_000_000, prev_rho_q: 1_000_000_000, effective_epoch: 5 }
  Input {
    output_reference: OutputReference { transaction_id: t_tx_id, output_index: 40 + index },
    output: Output {
      address: address.from_script(at_hash),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(nft_policy, #"52484f", 1),
      datum: InlineDatum(d),
      reference_script: None,
    },
  }
}

fn t_rate_ok() -> Input {
  t_rate_ref(0, t_rate_hash, t_rate_policy)
}

fn t_cell(g: Int, c: Int) -> EpochUsage {
  EpochUsage { generated: g, consumed: c }
}

fn t_win_a() -> List<EpochUsage> {
  [
    t_cell(100_000_000, 50_000_000), t_cell(100_000_000, 50_000_000), t_cell(0, 0),
    t_cell(100_000_000, 50_000_000), t_cell(0, 0), t_cell(7, 7), t_cell(9, 9),
  ]
}

const cp_bal: Int = 100_000_000

const cp_lent_c: Int = 7_000_000

const cp_lent_o: Int = 5_000_000

const cp_cap_no_lent: Int = 112_500_000

const cp_cap_lent: Int = 124_500_000

/// Két nền: checkpoint ở epoch 8, `last_updated_epoch` 8.
fn t_cp_din(link: ByteArray) -> VaultDatum {
  VaultDatum {
    ..t_datum(cp_bal, 0, [t_holding(cp_bal, 5, False)]),
    wakeme_link: link,
    cap_epoch: 8,
    cap_nanogic: 77,
    usage_window: t_win_a(),
    usage_window_epoch: 8,
    last_updated_epoch: 8,
  }
}

/// `d` mang checkpoint làm mới ở `e` (cửa sổ dịch rồi cộng `burned` vào ô 0).
fn t_cp_apply(
  d: VaultDatum,
  din: VaultDatum,
  link: ByteArray,
  cap: Int,
  e: Int,
  burned: Int,
) -> VaultDatum {
  VaultDatum {
    ..d,
    wakeme_link: link,
    cap_epoch: e,
    cap_nanogic: cap,
    usage_window: window_add(
      shift_window(din.usage_window, din.usage_window_epoch, e),
      0,
      burned,
    ),
    usage_window_epoch: e,
  }
}

fn t_cp_tx(
  din: VaultDatum,
  dout: VaultDatum,
  refs: List<Input>,
  signers: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..t_tx([t_vault_input(din, cp_bal)], [t_vault_output(dout, cp_bal)], signers),
    reference_inputs: refs,
  }
}

fn t_lent_ok() -> Input {
  t_lent_ref(cp_lent_c, cp_lent_o)
}

// ── Neo số: hai cap trên đúng bằng hàm thật với cửa sổ ĐÃ dịch ──────────────
test cp_cap_literals_match_formula() {
  let w = shift_window(t_win_a(), 8, 10)
  and {
    amount_by_lamp(cp_bal, 0, w, 2_000_000_000, 6) == cp_cap_no_lent,
    amount_by_lamp(cp_bal, cp_lent_c + cp_lent_o, w, 2_000_000_000, 6) == cp_cap_lent,
    // Cửa sổ KHÔNG dịch cho cap khác ⟹ ca "không dịch" phân biệt được.
    amount_by_lamp(cp_bal, 0, t_win_a(), 2_000_000_000, 6) != cp_cap_no_lent,
  }
}

// ═══ RefreshCheckpoint ═════════════════════════════════════════════════════

fn t_rc(dout: VaultDatum, din: VaultDatum, refs: List<Input>) -> Bool {
  validate_refresh_checkpoint(
    din, 10, t_own_ref(), t_params(), t_cp_tx(din, dout, refs, [t_owner_pkh]),
  )
}

test rc_pos_link_from_wakeme() {
  let din = t_cp_din(#"")
  t_rc(t_cp_apply(din, din, t_wakeme_commit, cp_cap_lent, 10, 0), din, [t_rate_ok(), t_lent_ok()])
}

test rc_pos_unlink_without_wakeme() {
  let din = t_cp_din(t_wakeme_commit)
  t_rc(t_cp_apply(din, din, #"", cp_cap_no_lent, 10, 0), din, [t_rate_ok()])
}

// Luôn làm mới, kể cả cùng epoch (cap_epoch == e).
test rc_pos_same_epoch_recomputes() {
  let base = t_cp_din(#"")
  let din = VaultDatum { ..base, cap_epoch: 10, usage_window_epoch: 10 }
  let w = t_win_a()
  let cap = amount_by_lamp(cp_bal, 0, w, 2_000_000_000, 6)
  t_rc(VaultDatum { ..din, cap_nanogic: cap }, din, [t_rate_ok()])
}

test rc_neg_other_field_changed() fail {
  let din = t_cp_din(#"")
  let good = t_cp_apply(din, din, t_wakeme_commit, cp_cap_lent, 10, 0)
  t_rc(VaultDatum { ..good, last_updated_epoch: 10 }, din, [t_rate_ok(), t_lent_ok()])
}

test rc_neg_cap_off_by_one() fail {
  let din = t_cp_din(#"")
  t_rc(t_cp_apply(din, din, t_wakeme_commit, cp_cap_lent + 1, 10, 0), din, [t_rate_ok(), t_lent_ok()])
}

test rc_neg_cap_without_lent_while_wakeme_present() fail {
  let din = t_cp_din(#"")
  t_rc(t_cp_apply(din, din, t_wakeme_commit, cp_cap_no_lent, 10, 0), din, [t_rate_ok(), t_lent_ok()])
}

test rc_neg_window_not_shifted() fail {
  let din = t_cp_din(#"")
  let good = t_cp_apply(din, din, t_wakeme_commit, cp_cap_lent, 10, 0)
  t_rc(VaultDatum { ..good, usage_window: t_win_a() }, din, [t_rate_ok(), t_lent_ok()])
}

test rc_neg_link_chosen_not_derived() fail {
  let din = t_cp_din(#"")
  t_rc(t_cp_apply(din, din, t_wakeme_commit_2, cp_cap_lent, 10, 0), din, [t_rate_ok(), t_lent_ok()])
}

// Hai két hợp lệ đều ghim két này; cái đúng đứng TRƯỚC (list.filter không chọn).
test rc_neg_two_wakeme_vaults() fail {
  let din = t_cp_din(#"")
  let second = t_wakeme_ref(1, t_wakeme_commit_2, t_vault_id_name, cp_lent_c, cp_lent_o)
  t_rc(t_cp_apply(din, din, t_wakeme_commit, cp_cap_lent, 10, 0), din, [t_rate_ok(), t_lent_ok(), second])
}

test rc_neg_no_rate_beacon() fail {
  let din = t_cp_din(#"")
  t_rc(t_cp_apply(din, din, t_wakeme_commit, cp_cap_lent, 10, 0), din, [t_lent_ok()])
}

test rc_neg_two_rate_beacons() fail {
  let din = t_cp_din(#"")
  t_rc(
    t_cp_apply(din, din, t_wakeme_commit, cp_cap_lent, 10, 0),
    din,
    [t_rate_ok(), t_rate_ref(1, t_rate_hash, t_rate_policy), t_lent_ok()],
  )
}

test rc_neg_rate_wrong_script() fail {
  let din = t_cp_din(#"")
  t_rc(
    t_cp_apply(din, din, t_wakeme_commit, cp_cap_lent, 10, 0),
    din,
    [t_rate_ref(0, t_gb_beacon_hash, t_rate_policy), t_lent_ok()],
  )
}

test rc_neg_rate_wrong_nft() fail {
  let din = t_cp_din(#"")
  t_rc(
    t_cp_apply(din, din, t_wakeme_commit, cp_cap_lent, 10, 0),
    din,
    [t_rate_ref(0, t_rate_hash, t_gb_beacon_policy), t_lent_ok()],
  )
}

test rc_neg_no_owner_sig() fail {
  let din = t_cp_din(#"")
  let dout = t_cp_apply(din, din, t_wakeme_commit, cp_cap_lent, 10, 0)
  validate_refresh_checkpoint(
    din, 10, t_own_ref(), t_params(), t_cp_tx(din, dout, [t_rate_ok(), t_lent_ok()], []),
  )
}

// ── Value của RefreshCheckpoint: lovelace chỉ được TĂNG, mọi token khác ghim ─────
//
// Bản trước ghim value bằng TUYỆT ĐỐI (kể cả lovelace) và có bài
// `rc_neg_value_changed` coi "thêm 1 ADA" là phải từ chối. Chính sách đó đã LẬT
// (2026-09-30): datum ra dài hơn datum vào ⟹ min-ADA tăng ⟹ két mở sát min-ADA
// (đo trên Lucid Emulator: 1_978_290 lovelace) kẹt ở checkpoint cũ. Bài cũ bị bỏ,
// dấu kỳ vọng của nó đảo thành `rc_pos_ada_plus_one`.
//
// Mỗi bài âm chỉ khác bài `rc_pos_ada_plus_one` đúng MỘT chỗ (ADA vẫn +1), nên nó
// đỏ vì đúng chốt nó mang tên, không vì ADA.

const rc_min_ada: Int = 1_978_290

/// Datum làm mới hợp lệ; input mang `rc_min_ada` + LAMP `cp_bal` + NFT két.
fn t_rc_value(out_of: fn(VaultDatum) -> Output) -> Bool {
  let din = t_cp_din(#"")
  let dout = t_cp_apply(din, din, t_wakeme_commit, cp_cap_lent, 10, 0)
  let tx =
    Transaction {
      ..t_tx(
        [t_vault_input_ada(din, rc_min_ada, cp_bal)],
        [out_of(dout)],
        [t_owner_pkh],
      ),
      reference_inputs: [t_rate_ok(), t_lent_ok()],
    }
  validate_refresh_checkpoint(din, 10, t_own_ref(), t_params(), tx)
}

test rc_pos_ada_plus_one() {
  t_rc_value(fn(d) { t_vault_output_ada(d, rc_min_ada + 1, cp_bal) })
}

test rc_pos_ada_unchanged() {
  t_rc_value(fn(d) { t_vault_output_ada(d, rc_min_ada, cp_bal) })
}

test rc_neg_ada_minus_one() fail {
  t_rc_value(fn(d) { t_vault_output_ada(d, rc_min_ada - 1, cp_bal) })
}

// Token dưới một policy THỨ TƯ.
test rc_neg_foreign_token_new_policy() fail {
  t_rc_value(fn(d) { t_vault_output_dust(d, rc_min_ada + 1, cp_bal) })
}

// Tên lạ dưới policy LAMP — vẫn chỉ 3 policy, nên `validate_vault_value` (≤ 3
// policy) sẽ CHO QUA. Bài này là bài phân biệt phép so nguyên khối với khuôn IG-14.
test rc_neg_foreign_name_under_lamp_policy() fail {
  t_rc_value(
    fn(d) {
      let o = t_vault_output_ada(d, rc_min_ada + 1, cp_bal)
      Output { ..o, value: assets.add(o.value, t_lamp_policy, #"6475737400", 1) }
    },
  )
}

// Tên lạ thứ hai dưới policy vault-id — cùng lý do như trên.
test rc_neg_foreign_name_under_vault_policy() fail {
  t_rc_value(
    fn(d) {
      let o = t_vault_output_ada(d, rc_min_ada + 1, cp_bal)
      Output { ..o, value: assets.add(o.value, t_vault_hash, #"6475737400", 1) }
    },
  )
}

test rc_neg_lamp_plus_one() fail {
  t_rc_value(fn(d) { t_vault_output_ada(d, rc_min_ada + 1, cp_bal + 1) })
}

test rc_neg_lamp_minus_one() fail {
  t_rc_value(fn(d) { t_vault_output_ada(d, rc_min_ada + 1, cp_bal - 1) })
}

test rc_neg_nft_dropped() fail {
  t_rc_value(
    fn(d) {
      let o = t_vault_output_ada(d, rc_min_ada + 1, cp_bal)
      Output { ..o, value: assets.add(o.value, t_vault_hash, t_vault_id_name, -1) }
    },
  )
}

// ═══ BurnBatch ═════════════════════════════════════════════════════════════

fn t_cp_burn_din(link: ByteArray) -> VaultDatum {
  VaultDatum { ..t_cp_din(link), magic_batches: [t_burn_batch(bid_a, 500)] }
}

fn t_bb(dout: VaultDatum, din: VaultDatum, refs: List<Input>) -> Bool {
  validate_burn_batch(
    din, [(bid_a, 200)], 10, t_own_ref(), t_params(),
    t_cp_tx(din, dout, refs, [t_owner_pkh]),
  )
}

fn t_bb_base_out(din: VaultDatum) -> VaultDatum {
  t_burn_dout(din, [t_burn_batch(bid_a, 300)], 200, 10)
}

test cp_bb_pos_refresh_and_add_consumed() {
  let din = t_cp_burn_din(#"")
  t_bb(t_cp_apply(t_bb_base_out(din), din, #"", cp_cap_no_lent, 10, 200), din, [t_rate_ok()])
}

test cp_bb_neg_not_refreshed() fail {
  let din = t_cp_burn_din(#"")
  // Ghim nguyên checkpoint cũ, chỉ cộng consumed vào ô 0 cũ.
  t_bb(t_bb_base_out(din), din, [t_rate_ok()])
}

test cp_bb_neg_consumed_not_added() fail {
  let din = t_cp_burn_din(#"")
  t_bb(t_cp_apply(t_bb_base_out(din), din, #"", cp_cap_no_lent, 10, 0), din, [t_rate_ok()])
}

test cp_bb_pos_link_set_with_wakeme() {
  let din = t_cp_burn_din(t_wakeme_commit)
  t_bb(
    t_cp_apply(t_bb_base_out(din), din, t_wakeme_commit, cp_cap_lent, 10, 200),
    din,
    [t_rate_ok(), t_lent_ok()],
  )
}

// Luật 2: link đặt mà thiếu két khi làm mới ⟹ fail (đòn "bỏ ref để hạ cap").
test cp_bb_neg_link_set_without_wakeme() fail {
  let din = t_cp_burn_din(t_wakeme_commit)
  t_bb(t_cp_apply(t_bb_base_out(din), din, #"", cp_cap_no_lent, 10, 200), din, [t_rate_ok()])
}

// Ở cùng epoch (cap_epoch == e): ghim nguyên, KHÔNG cần beacon.
test cp_bb_pos_same_epoch_pinned_no_refs() {
  let base = t_cp_burn_din(t_wakeme_commit)
  let din = VaultDatum { ..base, cap_epoch: 10, usage_window_epoch: 10 }
  t_bb(t_bb_base_out(din), din, [])
}

// ═══ PruneExpired (không chữ ký, KeepLink) ═════════════════════════════════

fn t_cp_prune_din(link: ByteArray) -> VaultDatum {
  VaultDatum { ..t_cp_din(link), magic_batches: [t_instant_batch(9, 5_000)] }
}

fn t_pe(dout: VaultDatum, din: VaultDatum, refs: List<Input>) -> Bool {
  validate_prune_expired(din, 10, t_own_ref(), t_params(), t_cp_tx(din, dout, refs, []))
}

test cp_pe_pos_refresh_keep_link() {
  let din = t_cp_prune_din(t_wakeme_commit)
  let out = VaultDatum { ..din, magic_batches: [] }
  t_pe(t_cp_apply(out, din, t_wakeme_commit, cp_cap_lent, 10, 0), din, [t_rate_ok(), t_lent_ok()])
}

test cp_pe_neg_not_refreshed() fail {
  let din = t_cp_prune_din(t_wakeme_commit)
  t_pe(VaultDatum { ..din, magic_batches: [] }, din, [t_rate_ok(), t_lent_ok()])
}

test cp_pe_neg_clears_link() fail {
  let din = t_cp_prune_din(t_wakeme_commit)
  let out = VaultDatum { ..din, magic_batches: [] }
  t_pe(t_cp_apply(out, din, #"", cp_cap_lent, 10, 0), din, [t_rate_ok(), t_lent_ok()])
}

test cp_pe_pos_no_link_no_wakeme() {
  let din = t_cp_prune_din(#"")
  let out = VaultDatum { ..din, magic_batches: [] }
  t_pe(t_cp_apply(out, din, #"", cp_cap_no_lent, 10, 0), din, [t_rate_ok()])
}

// Người lạ đưa két Wakeme vào để ĐẶT link ⟹ fail (chỉ chủ ký đổi được link).
test cp_pe_neg_sets_link() fail {
  let din = t_cp_prune_din(#"")
  let out = VaultDatum { ..din, magic_batches: [] }
  t_pe(t_cp_apply(out, din, t_wakeme_commit, cp_cap_lent, 10, 0), din, [t_rate_ok(), t_lent_ok()])
}

test cp_pe_neg_link_set_without_wakeme() fail {
  let din = t_cp_prune_din(t_wakeme_commit)
  let out = VaultDatum { ..din, magic_batches: [] }
  t_pe(t_cp_apply(out, din, t_wakeme_commit, cp_cap_no_lent, 10, 0), din, [t_rate_ok()])
}

// ═══ UpdateProfile ═════════════════════════════════════════════════════════

fn t_up(dout: VaultDatum, din: VaultDatum, refs: List<Input>) -> Bool {
  validate_update_profile(
    din, Ember, 10, t_own_ref(), t_params(), t_cp_tx(din, dout, refs, [t_owner_pkh]),
  )
}

test cp_up_pos_refresh() {
  let din = t_cp_din(#"")
  t_up(t_cp_apply(up_output(din, Ember, 10), din, #"", cp_cap_no_lent, 10, 0), din, [t_rate_ok()])
}

test cp_up_neg_not_refreshed() fail {
  let din = t_cp_din(#"")
  t_up(up_output(din, Ember, 10), din, [t_rate_ok()])
}

// ═══ SetDelegate ═══════════════════════════════════════════════════════════

fn t_sd(dout: VaultDatum, din: VaultDatum, refs: List<Input>) -> Bool {
  validate_set_delegate(
    din, None, 10, t_own_ref(), t_params(), t_cp_tx(din, dout, refs, [t_owner_pkh]),
  )
}

fn t_cp_sd_din() -> VaultDatum {
  VaultDatum { ..t_cp_din(#""), personal_delegate: Some(t_delegate) }
}

fn t_cp_sd_out(din: VaultDatum) -> VaultDatum {
  VaultDatum { ..din, personal_delegate: None, last_updated_epoch: 10 }
}

test cp_sd_pos_refresh() {
  let din = t_cp_sd_din()
  t_sd(t_cp_apply(t_cp_sd_out(din), din, #"", cp_cap_no_lent, 10, 0), din, [t_rate_ok()])
}

test cp_sd_neg_not_refreshed() fail {
  let din = t_cp_sd_din()
  t_sd(t_cp_sd_out(din), din, [t_rate_ok()])
}

// ═══ WithdrawLamp — ghim nguyên, không đọc gì ══════════════════════════════

fn t_wd(dout: VaultDatum, din: VaultDatum) -> Bool {
  let tx =
    t_tx(
      [t_vault_input(din, cp_bal)],
      [t_vault_output(dout, cp_bal - 5_000_000)],
      [t_owner_pkh],
    )
  // reference_inputs RỖNG: không beacon, không két Wakeme.
  validate_withdraw_lamp(din, 5_000_000, 10, t_own_ref(), t_params(), tx)
}

fn t_wd_out(din: VaultDatum) -> VaultDatum {
  VaultDatum {
    ..din,
    lamp_balance: cp_bal - 5_000_000,
    loyalty_holdings: [t_holding(cp_bal - 5_000_000, 5, False)],
  }
}

// Link đặt, cap cũ (epoch 8 < 10), không két, không beacon ⟹ XANH.
test cp_wd_pos_link_set_no_refs() {
  let din = t_cp_din(t_wakeme_commit)
  t_wd(t_wd_out(din), din)
}

test cp_wd_neg_cap_changed() fail {
  let din = t_cp_din(t_wakeme_commit)
  t_wd(VaultDatum { ..t_wd_out(din), cap_nanogic: din.cap_nanogic + 1 }, din)
}

test cp_wd_neg_link_cleared() fail {
  let din = t_cp_din(t_wakeme_commit)
  t_wd(VaultDatum { ..t_wd_out(din), wakeme_link: #"" }, din)
}

test cp_wd_neg_window_shifted() fail {
  let din = t_cp_din(t_wakeme_commit)
  t_wd(
    VaultDatum {
      ..t_wd_out(din),
      usage_window: shift_window(din.usage_window, 8, 10),
      usage_window_epoch: 10,
    },
    din,
  )
}

// ═══ Qua handler `spend`: G1b, shard, InstantGen đóng ══════════════════════

const t_e10_lo: Int = 10 * 432_000_000 + 1_000

fn t_spend(redeemer: VaultRedeemer, din: VaultDatum, extra_inputs: List<Input>) -> Bool {
  t_spend_at(0, 0, redeemer, din, extra_inputs)
}

/// `t_spend` với gốc lưới `origin` (apply-param #10) và validity range dời `shift` ms.
/// `origin == shift` ⟹ cùng epoch 10 như `t_spend` NẾU validator trừ gốc.
fn t_spend_at(
  origin: Int,
  shift: Int,
  redeemer: VaultRedeemer,
  din: VaultDatum,
  extra_inputs: List<Input>,
) -> Bool {
  let dout = t_cp_apply(din, din, t_wakeme_commit, cp_cap_lent, 10, 0)
  let tx =
    Transaction {
      ..placeholder,
      inputs: [t_vault_input(din, cp_bal), ..extra_inputs],
      reference_inputs: [t_rate_ok(), t_lent_ok()],
      outputs: [t_vault_output(dout, cp_bal)],
      extra_signatories: [t_owner_pkh],
      validity_range: interval.between(t_e10_lo, t_e10_lo + 1_000),
    }
  vault.spend(
    t_lamp_policy, t_lamp_asset_name, t_gb_beacon_policy, t_gb_beacon_hash,
    t_shard_hash, t_rate_policy, t_rate_hash, t_wakeme_hash, t_ms_per_epoch, origin,
    Some(din), redeemer, t_own_ref(), window_origin_fixtures.shift_tx(tx, shift),
  )
}

fn t_foreign_input(index: Int, at_hash: ByteArray) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: t_tx_id, output_index: 60 + index },
    output: Output {
      address: address.from_script(at_hash),
      value: assets.from_lovelace(2_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

test sp_pos_refresh_via_handler() {
  t_spend(RefreshCheckpoint, t_cp_din(#""), [])
}

// G1b: két Wakeme bị TIÊU (nằm trong tx.inputs) ⟹ fail.
test sp_neg_wakeme_vault_spent() fail {
  t_spend(RefreshCheckpoint, t_cp_din(#""), [t_wakeme_ref(2, t_wakeme_commit, t_vault_id_name, cp_lent_c, cp_lent_o)])
}

// Input tại script KHÁC (không phải Wakeme, không phải shard) không bị G1b chặn.
test sp_pos_other_script_input_ok() {
  t_spend(RefreshCheckpoint, t_cp_din(#""), [t_foreign_input(0, t_gb_beacon_hash)])
}

test sp_neg_shard_spent_on_non_gen_branch() fail {
  t_spend(RefreshCheckpoint, t_cp_din(#""), [t_foreign_input(1, t_shard_hash)])
}

// ═══ Gốc lưới cửa sổ (LAMP Specs/Window/CONTRACT.md v1.0) ═════════════════
// Cùng ca `sp_pos_refresh_via_handler`, tx dời đúng bằng gốc và validator nhận gốc đó:
// trừ gốc ⟹ vẫn epoch 10, khớp datum ra (cap_epoch/usage_window_epoch = 10). Quên trừ
// gốc ⟹ epoch ≈ 10 + gốc/P ⟹ datum ra lệch ⟹ đỏ (ca `…_forgotten_origin`).

test wo_refresh_via_handler_mainnet_origin() {
  t_spend_at(
    window_origin_fixtures.mainnet_origin_ms,
    window_origin_fixtures.mainnet_origin_ms,
    RefreshCheckpoint, t_cp_din(#""), [],
  )
}

test wo_refresh_via_handler_preprod_origin() {
  t_spend_at(
    window_origin_fixtures.preprod_origin_ms,
    window_origin_fixtures.preprod_origin_ms,
    RefreshCheckpoint, t_cp_din(#""), [],
  )
}

// Tx dời theo gốc Mainnet nhưng validator nhận gốc 0 (= bản quên trừ gốc) ⟹ đỏ.
test wo_refresh_via_handler_forgotten_origin() fail {
  t_spend_at(0, window_origin_fixtures.mainnet_origin_ms, RefreshCheckpoint, t_cp_din(#""), [])
}

// Vector CONTRACT §3 trên `get_current_epoch` (lower ở biên, upper cùng epoch).
test wo_get_epoch_mainnet_at_boundary() {
  let t = window_origin_fixtures.mainnet_t_658
  get_current_epoch(
    window_origin_fixtures.tx_between(t, t + 1_000),
    window_origin_fixtures.ms_per_window,
    window_origin_fixtures.mainnet_origin_ms,
  ) == 658
}

test wo_get_epoch_mainnet_one_ms_before() {
  let t = window_origin_fixtures.mainnet_t_658
  get_current_epoch(
    window_origin_fixtures.tx_between(t - 1_000, t - 1),
    window_origin_fixtures.ms_per_window,
    window_origin_fixtures.mainnet_origin_ms,
  ) == 657
}

test wo_get_epoch_preprod_at_boundary() {
  let t = window_origin_fixtures.preprod_t_316
  get_current_epoch(
    window_origin_fixtures.tx_between(t, t + 1_000),
    window_origin_fixtures.ms_per_window,
    window_origin_fixtures.preprod_origin_ms,
  ) == 316
}

test wo_get_epoch_preprod_one_ms_before() {
  let t = window_origin_fixtures.preprod_t_316
  get_current_epoch(
    window_origin_fixtures.tx_between(t - 1_000, t - 1),
    window_origin_fixtures.ms_per_window,
    window_origin_fixtures.preprod_origin_ms,
  ) == 315
}

// Biên trên tính theo gốc: upper chạm đúng `O + 659·P` (= biên epoch 659) ⟹ trải hai epoch ⟹ đỏ.
test wo_get_epoch_mainnet_upper_spills() fail {
  let t = window_origin_fixtures.mainnet_t_658
  get_current_epoch(
    window_origin_fixtures.tx_between(t, t + window_origin_fixtures.ms_per_window),
    window_origin_fixtures.ms_per_window,
    window_origin_fixtures.mainnet_origin_ms,
  ) == 658
}

// Upper vừa dưới biên epoch 659 theo gốc ⟹ xanh. Bản quên cộng gốc ở biên trên
// (`upper < (e+1)·P`) chặn nhầm ca này.
test wo_get_epoch_mainnet_upper_last_ms_ok() {
  let t = window_origin_fixtures.mainnet_t_658
  get_current_epoch(
    window_origin_fixtures.tx_between(t, t + window_origin_fixtures.ms_per_window - 1),
    window_origin_fixtures.ms_per_window,
    window_origin_fixtures.mainnet_origin_ms,
  ) == 658
}

// Quên gốc (truyền 0) ⟹ không ra vector.
test wo_get_epoch_mainnet_forgotten_origin() fail {
  let t = window_origin_fixtures.mainnet_t_658
  expect
    get_current_epoch(
      window_origin_fixtures.tx_between(t, t + 1_000),
      window_origin_fixtures.ms_per_window,
      0,
    ) == 658
  True
}


// ═══ Genesis: năm ô mới phải sạch ══════════════════════════════════════════

fn t_genesis_with(vd: VaultDatum) -> Bool {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  let out = t_genesis_output(vd, 100, t_vault_hash, name)
  let m = assets.from_asset(t_vault_hash, name, 1)
  t_mint_call(seed, t_vault_hash, t_mint_tx(seed, out, m, [t_owner_pkh]))
}

test mint_genesis_v2_clean_ok() {
  t_genesis_with(t_clean_genesis(100))
}

// Link khai sẵn lúc genesis: rỗng hoặc đúng 32 byte (khuôn owner_commit).
test mint_genesis_link_prefilled_32_ok() {
  t_genesis_with(VaultDatum { ..t_clean_genesis(100), wakeme_link: t_wakeme_commit })
}

test mint_genesis_link_31_bytes_rejected() fail {
  t_genesis_with(
    VaultDatum { ..t_clean_genesis(100), wakeme_link: bytearray.drop(t_wakeme_commit, 1) },
  )
}

test mint_genesis_link_33_bytes_rejected() fail {
  t_genesis_with(
    VaultDatum { ..t_clean_genesis(100), wakeme_link: bytearray.push(t_wakeme_commit, 0) },
  )
}

test mint_genesis_cap_epoch_prefilled_rejected() fail {
  t_genesis_with(VaultDatum { ..t_clean_genesis(100), cap_epoch: 1 })
}

test mint_genesis_cap_nanogic_prefilled_rejected() fail {
  t_genesis_with(VaultDatum { ..t_clean_genesis(100), cap_nanogic: 1 })
}

test mint_genesis_window_prefilled_rejected() fail {
  t_genesis_with(
    VaultDatum {
      ..t_clean_genesis(100),
      usage_window: [t_cell(0, 1), ..list.drop(empty_window(), 1)],
    },
  )
}

test mint_genesis_window_short_rejected() fail {
  t_genesis_with(
    VaultDatum { ..t_clean_genesis(100), usage_window: list.drop(empty_window(), 1) },
  )
}

test mint_genesis_window_epoch_prefilled_rejected() fail {
  t_genesis_with(VaultDatum { ..t_clean_genesis(100), usage_window_epoch: 1 })
}

// ═══ Vị trí trường — két Wakeme đọc ô 6/12/14 THEO VỊ TRÍ ═════════════════
// Mọi giá trị cùng kiểu trong mẫu KHÁC nhau (cap_epoch 8 ≠ cap_nanogic 77 ≠
// usage_window_epoch 9), để một phép hoán vị hai ô Int không xanh nhờ may.
test layout_v2_field_positions() {
  let d: Data =
    VaultDatum { ..t_cp_din(t_wakeme_commit), usage_window_epoch: 9 }
  let Pair(tag, fields) = builtin.un_constr_data(d)
  and {
    tag == 0,
    list.length(fields) == 20,
    list.at(fields, 6) == Some(builtin.b_data(t_wakeme_commit)),
    list.at(fields, 12) == Some(builtin.i_data(8)),
    list.at(fields, 14) == Some(builtin.i_data(77)),
    list.at(fields, 19) == Some(builtin.i_data(9)),
    list.length(builtin.un_list_data(builtin.head_list(list.drop(fields, 18)))) == 7,
  }
}

// Luật 2 ở nhánh KHÔNG chữ ký: người lạ dọn rác mà bỏ két Wakeme ra ngoài để XOÁ
// link. Ca `cp_pe_neg_link_set_without_wakeme` ở trên KHÔNG ghim được luật này —
// đầu ra của nó giữ link nên nó đỏ ở phép so checkpoint; đo đột biến gỡ
// `expect d.wakeme_link == #""` (2026-09-30) thì nó vẫn xanh. Ca này thì đỏ.
test cp_pe_neg_clears_link_without_wakeme() fail {
  let din = t_cp_prune_din(t_wakeme_commit)
  let out = VaultDatum { ..din, magic_batches: [] }
  t_pe(t_cp_apply(out, din, #"", cp_cap_no_lent, 10, 0), din, [t_rate_ok()])
}

// ═══ InstantGen — Gen v2.0 gói b2 ══════════════════════════════════════════
//
// Nền (dùng lại nền checkpoint ở trên): két `t_cp_din` 100 LAMP, checkpoint ở epoch
// 8, chạy ở epoch 10 ⟹ lượt sinh BẮT BUỘC làm mới. ρ(10) = 2e9.
//   cap không két = `cp_cap_no_lent` 112_500_000; có két (L_lent 12 LAMP) =
//   `cp_cap_lent` 124_500_000 (bài `cp_cap_literals_match_formula` neo hai số).
//   compute_cap_pp(1e8) = 4e8; compute_cap_lent(12e6) = 4.8e7.
// Shard của két: `vault_shard_id(t_owner)` (ánh xạ theo owner, chung với ScheduleGen).
// Shard nền: seq 3, reset 1e10 ⟹ gb_vault_share = 5e8; remaining 1e9.
// Beacon GB nền: seq 3, epoch 10, depeg False.
// Mỗi ca âm dựng từ ĐÚNG ca dương cùng nhóm, đổi MỘT vế; ca âm nào có "hàng xóm"
// xanh thì hàng xóm nằm ngay cạnh.

/// Shard GB của két trong bài kiểm = ánh xạ theo `owner` (`t_owner`).
fn ig_shard_id() -> Int {
  vault_shard_id(t_owner)
}

/// Một shard KHÁC shard của két.
fn ig_wrong_shard_id() -> Int {
  ( ig_shard_id() + 1 ) % 16
}

const ig_reset: Int = 10_000_000_000

const ig_remaining: Int = 1_000_000_000

const ig_lo: Int = 10 * 432_000_000 + 1_000

const ig_hi: Int = 10 * 432_000_000 + 2_000

fn t_gb_ref(
  index: Int,
  at_hash: ByteArray,
  nft_policy: ByteArray,
  epoch: Int,
  depeg: Bool,
) -> Input {
  let d: Data = GreenBackBeacon { gb_nanogic: 160_000_000_000, seq: 3, epoch, depeg }
  Input {
    output_reference: OutputReference { transaction_id: t_tx_id, output_index: 50 + index },
    output: Output {
      address: address.from_script(at_hash),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(nft_policy, #"474242", 1),
      datum: InlineDatum(d),
      reference_script: None,
    },
  }
}

fn t_gb_ok() -> Input {
  t_gb_ref(0, t_gb_beacon_hash, t_gb_beacon_policy, 10, False)
}

fn t_s(seq: Int, reset: Int, remaining: Int) -> GbShard {
  GbShard { shard_id: ig_shard_id(), seq, reset_amount: reset, remaining }
}

fn t_shard_out(id: Int, s: GbShard) -> Output {
  let d: Data = GbShard { ..s, shard_id: id }
  Output {
    address: address.from_script(t_shard_hash),
    value: assets.from_lovelace(2_000_000)
      |> assets.add(t_shard_hash, shard_nft_name(id), 1),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

fn t_shard_in(index: Int, id: Int, s: GbShard) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: t_tx_id, output_index: 30 + index },
    output: t_shard_out(id, s),
  }
}

/// Datum ra ĐÚNG của lượt sinh `m` từ `din` ở epoch 10, checkpoint (link, cap).
fn t_ig_out(din: VaultDatum, link: ByteArray, cap: Int, m: Int) -> VaultDatum {
  let live = prune_expired(din.magic_batches, 10)
  let window = shift_window(din.usage_window, din.usage_window_epoch, 10)
  VaultDatum {
    ..din,
    magic_batches: list.concat(
      live,
      [
        MagicBatch {
          batch_id: compute_batch_id(t_own_ref(), din.next_batch_index),
          source: Instant,
          created_epoch: 10,
          initial_amount: m,
          current_amount: m,
          decay_window: magic_decay_window,
          profile_at_creation: None,
          contract_id: None,
          halved: False,
        },
      ],
    ),
    next_batch_index: din.next_batch_index + 1,
    last_updated_epoch: 10,
    attribution: VaultAttribution {
      ..din.attribution,
      last_event_epoch: 10,
      total_events: din.attribution.total_events + 1,
    },
    instant_unlock_ms: ig_hi + t_ms_per_epoch,
    wakeme_link: link,
    cap_epoch: 10,
    cap_nanogic: cap,
    usage_window: window_add(window, m, 0),
    usage_window_epoch: 10,
  }
}

fn t_ig_tx(
  din: VaultDatum,
  dout: VaultDatum,
  bal: Int,
  refs: List<Input>,
  shard_in: Input,
  shard_out: Output,
) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: [t_vault_input(din, bal), shard_in],
    reference_inputs: refs,
    outputs: [t_vault_output(dout, bal), shard_out],
    extra_signatories: [t_owner_pkh],
    validity_range: interval.between(ig_lo, ig_hi),
  }
}

/// Chạy nhánh sinh với shard `ig_shard_id()`, vào `s_in`, ra `s_out`.
fn t_ig(
  din: VaultDatum,
  dout: VaultDatum,
  bal: Int,
  m: Int,
  refs: List<Input>,
  s_in: GbShard,
  s_out: GbShard,
) -> Bool {
  validate_instant_gen(
    din, m, 10, t_own_ref(), t_params(),
    t_ig_tx(
      din, dout, bal, refs, t_shard_in(0, ig_shard_id(), s_in),
      t_shard_out(ig_shard_id(), s_out),
    ),
  )
}

/// Ca nền: không két, rút `m` từ shard nền.
fn t_ig_base(m: Int, refs: List<Input>) -> Bool {
  let din = t_cp_din(#"")
  t_ig(
    din, t_ig_out(din, #"", cp_cap_no_lent, m), cp_bal, m, refs,
    t_s(3, ig_reset, ig_remaining), t_s(3, ig_reset, ig_remaining - m),
  )
}

fn t_refs_base() -> List<Input> {
  [t_rate_ok(), t_gb_ok()]
}

test ig_wrong_shard_differs() {
  ig_wrong_shard_id() != ig_shard_id()
}

// ── dương nền + m ────────────────────────────────────────────────────────────
test ig_pos_full_cap() {
  t_ig_base(cp_cap_no_lent, t_refs_base())
}

test ig_pos_partial() {
  t_ig_base(1, t_refs_base())
}

test ig_neg_m_zero() fail {
  t_ig_base(0, t_refs_base())
}

// m vượt amount_by_lamp đúng 1 (hàng xóm bằng = `ig_pos_full_cap`).
test ig_neg_over_amount_by_lamp_by_one() fail {
  t_ig_base(cp_cap_no_lent + 1, t_refs_base())
}

test ig_neg_no_owner_sig() fail {
  let din = t_cp_din(#"")
  let m = 1_000
  let tx =
    t_ig_tx(
      din, t_ig_out(din, #"", cp_cap_no_lent, m), cp_bal, t_refs_base(),
      t_shard_in(0, ig_shard_id(), t_s(3, ig_reset, ig_remaining)),
      t_shard_out(ig_shard_id(), t_s(3, ig_reset, ig_remaining - m)),
    )
  validate_instant_gen(
    din, m, 10, t_own_ref(), t_params(), Transaction { ..tx, extra_signatories: [] },
  )
}

// ── GB_available (shard) ─────────────────────────────────────────────────────
fn t_ig_avail(m: Int, available: Int) -> Bool {
  let din = t_cp_din(#"")
  t_ig(
    din, t_ig_out(din, #"", cp_cap_no_lent, m), cp_bal, m, t_refs_base(),
    t_s(3, ig_reset, available), t_s(3, ig_reset, available - m),
  )
}

test ig_pos_gb_available_exact() {
  t_ig_avail(1_000_000, 1_000_000)
}

test ig_neg_over_gb_available_by_one() fail {
  t_ig_avail(1_000_001, 1_000_000)
}

// Shard đặt lại lười trong chính lượt này (seq 2 → 3): GB_available = reset mới,
// KHÔNG phải `remaining` cũ (ở đây 0).
test ig_pos_shard_lazy_reset() {
  let din = t_cp_din(#"")
  let m = 1_000_000
  t_ig(
    din, t_ig_out(din, #"", cp_cap_no_lent, m), cp_bal, m, t_refs_base(),
    t_s(2, 5, 0), t_s(3, ig_reset, ig_reset - m),
  )
}

// Cùng lượt đặt lại, nhưng két đòi `m` vượt reset mới 1.
test ig_neg_shard_lazy_reset_over() fail {
  let din = t_cp_din(#"")
  let m = 1_000_000
  t_ig(
    din, t_ig_out(din, #"", cp_cap_no_lent, m), cp_bal, m, t_refs_base(),
    t_s(2, 5, 0), t_s(3, m - 1, -1),
  )
}

fn t_ig_shard_out_remaining(remaining_out: Int) -> Bool {
  let din = t_cp_din(#"")
  let m = 1_000_000
  t_ig(
    din, t_ig_out(din, #"", cp_cap_no_lent, m), cp_bal, m, t_refs_base(),
    t_s(3, ig_reset, ig_remaining), t_s(3, ig_reset, remaining_out),
  )
}

test ig_neg_shard_under_drawn_by_one() fail {
  t_ig_shard_out_remaining(ig_remaining - 1_000_000 + 1)
}

test ig_neg_shard_over_drawn_by_one() fail {
  t_ig_shard_out_remaining(ig_remaining - 1_000_000 - 1)
}

// Sai shard: shard kế bên (NFT + datum khớp nhau, chỉ không phải của két).
test ig_neg_wrong_shard() fail {
  let din = t_cp_din(#"")
  let m = 1_000_000
  validate_instant_gen(
    din, m, 10, t_own_ref(), t_params(),
    t_ig_tx(
      din, t_ig_out(din, #"", cp_cap_no_lent, m), cp_bal, t_refs_base(),
      t_shard_in(0, ig_wrong_shard_id(), t_s(3, ig_reset, ig_remaining)),
      t_shard_out(ig_wrong_shard_id(), t_s(3, ig_reset, ig_remaining - m)),
    ),
  )
}

// Hai input shard, shard ĐÚNG đứng trước: chỉ phép đếm `[shard_in]` chặn được.
test ig_neg_two_shard_inputs() fail {
  let din = t_cp_din(#"")
  let m = 1_000_000
  let tx =
    t_ig_tx(
      din, t_ig_out(din, #"", cp_cap_no_lent, m), cp_bal, t_refs_base(),
      t_shard_in(0, ig_shard_id(), t_s(3, ig_reset, ig_remaining)),
      t_shard_out(ig_shard_id(), t_s(3, ig_reset, ig_remaining - m)),
    )
  validate_instant_gen(
    din, m, 10, t_own_ref(), t_params(),
    Transaction {
      ..tx,
      inputs: list.concat(tx.inputs, [t_shard_in(1, ig_wrong_shard_id(), t_s(3, ig_reset, ig_remaining))]),
    },
  )
}

// ── Trần mỗi-két-mỗi-epoch: reset 1e9 ⟹ share 5e7 ─────────────────────────────
fn t_ig_share(m: Int) -> Bool {
  let din = t_cp_din(#"")
  t_ig(
    din, t_ig_out(din, #"", cp_cap_no_lent, m), cp_bal, m, t_refs_base(),
    t_s(3, 1_000_000_000, 1_000_000_000), t_s(3, 1_000_000_000, 1_000_000_000 - m),
  )
}

test ig_pos_share_exact() {
  gb_vault_share(1_000_000_000) == 50_000_000 && t_ig_share(50_000_000)
}

test ig_neg_over_share_by_one() fail {
  t_ig_share(50_000_001)
}

// ── Beacon GB ────────────────────────────────────────────────────────────────
test ig_neg_beacon_depeg() fail {
  t_ig_base(1_000, [t_rate_ok(), t_gb_ref(0, t_gb_beacon_hash, t_gb_beacon_policy, 10, True)])
}

// Tuổi 1 epoch = ngưỡng ⟹ xanh; tuổi 2 ⟹ đỏ.
test ig_pos_beacon_age_one() {
  t_ig_base(1_000, [t_rate_ok(), t_gb_ref(0, t_gb_beacon_hash, t_gb_beacon_policy, 9, False)])
}

test ig_neg_beacon_stale() fail {
  t_ig_base(1_000, [t_rate_ok(), t_gb_ref(0, t_gb_beacon_hash, t_gb_beacon_policy, 8, False)])
}

test ig_neg_beacon_from_future() fail {
  t_ig_base(1_000, [t_rate_ok(), t_gb_ref(0, t_gb_beacon_hash, t_gb_beacon_policy, 11, False)])
}

test ig_neg_no_beacon() fail {
  t_ig_base(1_000, [t_rate_ok()])
}

// Hai beacon, cái HỢP LỆ đứng TRƯỚC (ca "0 cái" không ghim được phép đếm).
test ig_neg_two_beacons() fail {
  t_ig_base(
    1_000,
    [t_rate_ok(), t_gb_ok(), t_gb_ref(1, t_gb_beacon_hash, t_gb_beacon_policy, 10, False)],
  )
}

test ig_neg_beacon_wrong_script() fail {
  t_ig_base(1_000, [t_rate_ok(), t_gb_ref(0, t_rate_hash, t_gb_beacon_policy, 10, False)])
}

test ig_neg_beacon_wrong_nft() fail {
  t_ig_base(1_000, [t_rate_ok(), t_gb_ref(0, t_gb_beacon_hash, t_rate_policy, 10, False)])
}

// ── Cộng dồn trong epoch (checkpoint ĐÃ làm mới ở epoch 10) ──────────────────
// Két đã sinh 3e8 trong epoch 10 (một batch + ô 0 `generated`). Không đọc ρ.
fn t_same_din(link: ByteArray, cap: Int) -> VaultDatum {
  VaultDatum {
    ..t_datum(cp_bal, 0, [t_holding(cp_bal, 5, False)]),
    magic_batches: [t_instant_batch(10, 300_000_000)],
    next_batch_index: 1,
    wakeme_link: link,
    cap_epoch: 10,
    cap_nanogic: cap,
    usage_window: [t_cell(300_000_000, 0), ..list.repeat(t_cell(0, 0), 6)],
    usage_window_epoch: 10,
    last_updated_epoch: 10,
  }
}

fn t_ig_same(din: VaultDatum, m: Int, refs: List<Input>) -> Bool {
  t_ig(
    din, t_ig_out(din, din.wakeme_link, din.cap_nanogic, m), cp_bal, m, refs,
    t_s(3, ig_reset, ig_remaining), t_s(3, ig_reset, ig_remaining - m),
  )
}

// IG-9: cap_nanogic cũ (1e12) không chặn; compute_cap_pp(1e8) = 4e8 chặn.
test ig_pos_cumul_cap_pp_exact() {
  t_ig_same(t_same_din(#"", 1_000_000_000_000), 100_000_000, [t_gb_ok()])
}

test ig_neg_cumul_over_cap_pp_by_one() fail {
  t_ig_same(t_same_din(#"", 1_000_000_000_000), 100_000_001, [t_gb_ok()])
}

// IG-8 CỘNG DỒN chứ không mỗi lượt: m = 5e7+1 < cap 3.5e8, nhưng 3e8 + m > 3.5e8.
test ig_pos_cumul_cap_nanogic_exact() {
  t_ig_same(t_same_din(#"", 350_000_000), 50_000_000, [t_gb_ok()])
}

test ig_neg_cumul_over_cap_nanogic_by_one() fail {
  t_ig_same(t_same_din(#"", 350_000_000), 50_000_001, [t_gb_ok()])
}

// IG-9 với LAMP-mượn: 3e8 + m ≤ 4e8 + 4.8e7 chỉ khi có két đã ghim.
test ig_pos_same_epoch_linked_lent() {
  t_ig_same(t_same_din(t_wakeme_commit, 1_000_000_000_000), 148_000_000, [t_lent_ok(), t_gb_ok()])
}

test ig_neg_same_epoch_linked_absent() fail {
  t_ig_same(t_same_din(t_wakeme_commit, 1_000_000_000_000), 148_000_000, [t_gb_ok()])
}

// Giữa epoch, két CHƯA ghim (link "") không được góp L_lent.
test ig_neg_same_epoch_unlinked_wakeme() fail {
  t_ig_same(t_same_din(#"", 1_000_000_000_000), 1_000, [t_lent_ok(), t_gb_ok()])
}

// ── Két Wakeme ở lượt làm mới: link := owner_commit, L_lent vào công thức ─────
fn t_ig_wakeme(m: Int, link_out: ByteArray, cap_out: Int, refs: List<Input>) -> Bool {
  let din = t_cp_din(#"")
  t_ig(
    din, t_ig_out(din, link_out, cap_out, m), cp_bal, m, refs,
    t_s(3, ig_reset, ig_remaining), t_s(3, ig_reset, ig_remaining - m),
  )
}

test ig_pos_wakeme_link_and_lent() {
  t_ig_wakeme(cp_cap_lent, t_wakeme_commit, cp_cap_lent, [t_rate_ok(), t_lent_ok(), t_gb_ok()])
}

// Cùng m, không két: cap = cp_cap_no_lent < m ⟹ đỏ (lượng cho phép khác nhau).
test ig_neg_same_m_without_wakeme() fail {
  t_ig_wakeme(cp_cap_lent, #"", cp_cap_no_lent, [t_rate_ok(), t_gb_ok()])
}

test ig_neg_wakeme_link_not_written() fail {
  t_ig_wakeme(1_000, #"", cp_cap_lent, [t_rate_ok(), t_lent_ok(), t_gb_ok()])
}

test ig_neg_wakeme_cap_without_lent() fail {
  t_ig_wakeme(1_000, t_wakeme_commit, cp_cap_no_lent, [t_rate_ok(), t_lent_ok(), t_gb_ok()])
}

// Link đã ghim, lượt sinh làm mới mà bỏ két ra ⟹ đỏ (luật 2) — đầu ra là đúng thứ hàm
// sẽ tính nếu luật vắng (link "", cap không lent).
test ig_neg_linked_refresh_without_wakeme() fail {
  let din = t_cp_din(t_wakeme_commit)
  let m = 1_000
  t_ig(
    din, t_ig_out(din, #"", cp_cap_no_lent, m), cp_bal, m, t_refs_base(),
    t_s(3, ig_reset, ig_remaining), t_s(3, ig_reset, ig_remaining - m),
  )
}

// ── G2 với L_lent: 5 LAMP sở hữu < 10, cộng 12 LAMP mượn ⟹ đạt ──────────────
const g2_bal: Int = 5_000_000

fn t_g2_din() -> VaultDatum {
  VaultDatum { ..t_cp_din(#""), lamp_balance: g2_bal, loyalty_holdings: [t_holding(g2_bal, 5, False)] }
}

fn t_g2(lent: Int, link: ByteArray, refs: List<Input>) -> Bool {
  let din = t_g2_din()
  let cap =
    amount_by_lamp(g2_bal, lent, shift_window(din.usage_window, 8, 10), 2_000_000_000, 6)
  let m = 1_000_000
  t_ig(
    din, t_ig_out(din, link, cap, m), g2_bal, m, refs,
    t_s(3, ig_reset, ig_remaining), t_s(3, ig_reset, ig_remaining - m),
  )
}

test ig_pos_g2_with_lent() {
  t_g2(cp_lent_c + cp_lent_o, t_wakeme_commit, [t_rate_ok(), t_lent_ok(), t_gb_ok()])
}

test ig_neg_g2_without_lent() fail {
  t_g2(0, #"", t_refs_base())
}

// G2 vế `avail + L_lent`: chỉ tách được khỏi vế `lamp_balance + L_lent` khi
// `lamp_locked > 0`. Két InstantGen thật luôn có `lamp_locked = 0` (genesis ghim, mọi
// nhánh giữ) nên ca này dựng trạng thái không tới được — nó chỉ để gỡ vế avail ra là
// có bài đỏ. Vế `lamp_balance + L_lent` thì không ghim được trên trạng thái tới được:
// `avail ≤ lamp_balance` khi `lamp_locked ≥ 0`, nên nó luôn bị vế avail che; giữ làm
// phòng thủ. Bài canh duy nhất của nó dựng `lamp_locked < 0` (không tới được):
// `ig_neg_g2_balance_below_min_masked_by_avail`.
fn t_g2_locked(bal: Int, locked: Int) -> Bool {
  let din =
    VaultDatum {
      ..t_cp_din(#""),
      lamp_balance: bal,
      lamp_locked: locked,
      loyalty_holdings: [t_holding(bal, 5, False)],
    }
  let cap =
    amount_by_lamp(bal - locked, 0, shift_window(din.usage_window, 8, 10), 2_000_000_000, 6)
  let m = 1_000
  t_ig(
    din, t_ig_out(din, #"", cap, m), bal, m, t_refs_base(),
    t_s(3, ig_reset, ig_remaining), t_s(3, ig_reset, ig_remaining - m),
  )
}

test ig_pos_g2_avail_exact() {
  t_g2_locked(20_000_000, 10_000_000)
}

test ig_neg_g2_avail_below_min() fail {
  t_g2_locked(20_000_000, 10_000_001)
}

// Shard vào là shard KHÁC, shard ra đúng shard của két: chỉ phép soát NFT của INPUT
// chặn được (validator shard cũng chặn — `continuing_pair` đòi cùng tập token — nhưng
// két không dựa vào đó để đọc `GB_available` từ datum input).
test ig_neg_shard_input_foreign() fail {
  let din = t_cp_din(#"")
  let m = 1_000_000
  validate_instant_gen(
    din, m, 10, t_own_ref(), t_params(),
    t_ig_tx(
      din, t_ig_out(din, #"", cp_cap_no_lent, m), cp_bal, t_refs_base(),
      t_shard_in(0, ig_wrong_shard_id(), t_s(3, ig_reset, ig_remaining)),
      t_shard_out(ig_shard_id(), t_s(3, ig_reset, ig_remaining - m)),
    ),
  )
}

// ── Datum ra ─────────────────────────────────────────────────────────────────
test ig_neg_generated_not_added() fail {
  let din = t_cp_din(#"")
  let m = 1_000
  let good = t_ig_out(din, #"", cp_cap_no_lent, m)
  t_ig(
    din, VaultDatum { ..good, usage_window: shift_window(din.usage_window, 8, 10) },
    cp_bal, m, t_refs_base(),
    t_s(3, ig_reset, ig_remaining), t_s(3, ig_reset, ig_remaining - m),
  )
}

test ig_neg_consumed_side_bumped() fail {
  let din = t_cp_din(#"")
  let m = 1_000
  let good = t_ig_out(din, #"", cp_cap_no_lent, m)
  t_ig(
    din,
    VaultDatum {
      ..good,
      usage_window: window_add(shift_window(din.usage_window, 8, 10), m, m),
    },
    cp_bal, m, t_refs_base(),
    t_s(3, ig_reset, ig_remaining), t_s(3, ig_reset, ig_remaining - m),
  )
}

test ig_neg_unlock_not_written() fail {
  let din = t_cp_din(#"")
  let m = 1_000
  t_ig(
    din, VaultDatum { ..t_ig_out(din, #"", cp_cap_no_lent, m), instant_unlock_ms: 0 },
    cp_bal, m, t_refs_base(),
    t_s(3, ig_reset, ig_remaining), t_s(3, ig_reset, ig_remaining - m),
  )
}

test ig_neg_batch_amount_mismatch() fail {
  let din = t_cp_din(#"")
  let m = 1_000
  let good = t_ig_out(din, #"", cp_cap_no_lent, m)
  t_ig(
    din, VaultDatum { ..good, magic_batches: [t_instant_batch(10, m + 1)] },
    cp_bal, m, t_refs_base(),
    t_s(3, ig_reset, ig_remaining), t_s(3, ig_reset, ig_remaining - m),
  )
}

test ig_neg_lamp_moved() fail {
  let din = t_cp_din(#"")
  let m = 1_000
  let good = t_ig_out(din, #"", cp_cap_no_lent, m)
  t_ig(
    din, VaultDatum { ..good, lamp_balance: cp_bal - 1 },
    cp_bal, m, t_refs_base(),
    t_s(3, ig_reset, ig_remaining), t_s(3, ig_reset, ig_remaining - m),
  )
}

// ── Qua handler `spend` (G1b + shard được phép ở nhánh sinh) ─────────────────
fn t_spend_gen(m: Int, extra_inputs: List<Input>) -> Bool {
  let din = t_cp_din(#"")
  let dout = t_ig_out(din, #"", cp_cap_no_lent, m)
  let tx =
    t_ig_tx(
      din, dout, cp_bal, t_refs_base(),
      t_shard_in(0, ig_shard_id(), t_s(3, ig_reset, ig_remaining)),
      t_shard_out(ig_shard_id(), t_s(3, ig_reset, ig_remaining - m)),
    )
  vault.spend(
    t_lamp_policy, t_lamp_asset_name, t_gb_beacon_policy, t_gb_beacon_hash,
    t_shard_hash, t_rate_policy, t_rate_hash, t_wakeme_hash, t_ms_per_epoch, 0,
    Some(din), InstantGen { claimed_amount: m }, t_own_ref(),
    Transaction { ..tx, inputs: list.concat(tx.inputs, extra_inputs) },
  )
}

test sp_pos_instant_gen_via_handler() {
  t_spend_gen(1_000, [])
}

test sp_neg_instant_gen_wakeme_spent() fail {
  t_spend_gen(1_000, [t_wakeme_ref(2, t_wakeme_commit, t_vault_id_name, cp_lent_c, cp_lent_o)])
}

// ── THANG ĐO ExUnit nhánh sinh ───────────────────────────────────────────────
//
// Không bài nào ở đây khẳng định hiệu năng. `aiken check` in mem/cpu từng bài:
//
//     validator ≈ measure_ig_*  −  probe_ig_*_fixture   ← CÙNG một fixture
//
// Luật (khuôn `ScheduleGen/onchain/validators/vault.ak` ▸ mục "THANG ĐO"):
//  (1) hai chân của một cặp gọi CÙNG một hàm fixture, không ai gõ lại số;
//  (2) chân CHẠY-TRỌN là `test` thường (phải PASS) — một bài `fail` xanh cả khi chết
//      ở cổng đầu tiên;
//  (3) chân chạy-trọn đi qua handler `vault.spend` VÀ ép giải mã `VaultDatum` từ
//      `Data` (`expect d: VaultDatum = raw`) — handler thật nhận datum dạng `Data`,
//      nên bỏ bước đó là đo thiếu đúng phần lớn nhất theo trục batch/holding.
//
// Hai cấu hình NẶNG NHẤT, vì làm mới và có batch sống loại trừ nhau trên két thật
// (batch sinh ở epoch `e` chỉ có sau một lượt làm mới ở `e`):
//   A — làm mới: 32 batch CHẾT (dọn hết), 40 holding, ref = ρ + két Wakeme + beacon GB,
//       shard input. Dịch cửa sổ + đọc ρ + đọc két.
//   B — cùng epoch: 31 batch SỐNG (đạt trần `live < 32`), 40 holding, ref = két Wakeme
//       đã ghim + beacon GB, shard input.

const ig_scale_holdings: Int = max_loyalty_holdings

fn t_ig_heavy_holdings() -> List<LoyaltyHolding> {
  list.map(list.range(1, ig_scale_holdings), fn(i) { t_holding(2_500_000, i, False) })
}

fn t_ig_fixture_a() -> (VaultDatum, Transaction, Int) {
  let din =
    VaultDatum {
      ..t_cp_din(#""),
      loyalty_holdings: t_ig_heavy_holdings(),
      magic_batches: list.repeat(t_instant_batch(9, 1), max_batches_per_vault),
      next_batch_index: max_batches_per_vault,
    }
  let m = cp_cap_lent
  let tx =
    t_ig_tx(
      din, t_ig_out(din, t_wakeme_commit, cp_cap_lent, m), cp_bal,
      [t_rate_ok(), t_lent_ok(), t_gb_ok()],
      t_shard_in(0, ig_shard_id(), t_s(2, 1, 0)),
      t_shard_out(ig_shard_id(), t_s(3, ig_reset, ig_reset - m)),
    )
  (din, tx, m)
}

fn t_ig_fixture_b() -> (VaultDatum, Transaction, Int) {
  let live = max_batches_per_vault - 1
  let din =
    VaultDatum {
      ..t_same_din(t_wakeme_commit, cp_cap_lent),
      loyalty_holdings: t_ig_heavy_holdings(),
      magic_batches: list.repeat(t_instant_batch(10, 1_000_000), live),
      next_batch_index: live,
      usage_window: [t_cell(live * 1_000_000, 0), ..list.repeat(t_cell(0, 0), 6)],
    }
  let m = 1_000_000
  let tx =
    t_ig_tx(
      din, t_ig_out(din, t_wakeme_commit, cp_cap_lent, m), cp_bal,
      [t_lent_ok(), t_gb_ok()],
      t_shard_in(0, ig_shard_id(), t_s(3, ig_reset, ig_remaining)),
      t_shard_out(ig_shard_id(), t_s(3, ig_reset, ig_remaining - m)),
    )
  (din, tx, m)
}

fn t_ig_measure(fx: (VaultDatum, Transaction, Int)) -> Bool {
  let (din, tx, m) = fx
  let raw: Data = din
  expect d: VaultDatum = raw
  vault.spend(
    t_lamp_policy, t_lamp_asset_name, t_gb_beacon_policy, t_gb_beacon_hash,
    t_shard_hash, t_rate_policy, t_rate_hash, t_wakeme_hash, t_ms_per_epoch, 0,
    Some(d), InstantGen { claimed_amount: m }, t_own_ref(), tx,
  )
}

fn t_ig_probe(fx: (VaultDatum, Transaction, Int), n_batches: Int, n_refs: Int) -> Bool {
  let (din, tx, m) = fx
  let raw: Data = din
  and {
    m > 0,
    list.length(din.magic_batches) == n_batches,
    list.length(din.loyalty_holdings) == ig_scale_holdings,
    list.length(tx.reference_inputs) == n_refs,
    list.length(tx.inputs) == 2,
    raw != builtin.i_data(0),
  }
}

test measure_ig_refresh_run() {
  t_ig_measure(t_ig_fixture_a())
}

test probe_ig_refresh_fixture() {
  t_ig_probe(t_ig_fixture_a(), max_batches_per_vault, 3)
}

test measure_ig_same_epoch_run() {
  t_ig_measure(t_ig_fixture_b())
}

test probe_ig_same_epoch_fixture() {
  t_ig_probe(t_ig_fixture_b(), max_batches_per_vault - 1, 2)
}

// ═══ Người dùng mới: két Wakeme chưa ghim / ghim từ genesis (2026-10-02) ═════════
//
// Hai thay đổi ở `wakeme_lent.ak` ▸ `read_one_vault`: (c) két Wakeme chưa ghim két IG
// này ⟹ `(owner_commit, 0)` thay vì fail; (d) ghim từ genesis và chưa đổi ghim ⟹ tính
// ngay trong kỳ genesis. Các ca dưới đi qua handler/nhánh thật.

/// Két Wakeme hợp lệ nhưng ghim két IG KHÁC (cùng hash, khác tên NFT).
fn t_unpinned_ok() -> Input {
  t_wakeme_ref(0, t_wakeme_commit, t_wakeme_commit_2, cp_lent_c, cp_lent_o)
}

// ── Nhánh CÓ chữ ký: link := owner_commit, L_lent = 0 ────────────────────────────
test np_rc_unpinned_links_without_lent() {
  let din = t_cp_din(#"")
  t_rc(t_cp_apply(din, din, t_wakeme_commit, cp_cap_no_lent, 10, 0), din, [t_rate_ok(), t_unpinned_ok()])
}

// Cùng tx, cap tính CÓ L_lent ⟹ đỏ: két chưa ghim không góp phần mượn.
test np_rc_unpinned_cap_with_lent_fail() fail {
  let din = t_cp_din(#"")
  t_rc(t_cp_apply(din, din, t_wakeme_commit, cp_cap_lent, 10, 0), din, [t_rate_ok(), t_unpinned_ok()])
}

// Luật 6 siết 2026-10-03 (bỏ vế (a) "link cũ rỗng"): nhánh sinh, link rỗng, két Wakeme
// chưa ghim két này (`L_lent = 0`) ⟹ KHÔNG nối được nữa, tx bị từ chối. Bản trước của bài
// này là ca DƯƠNG `np_ig_unpinned_links_without_lent` (link := owner_commit, lent 0).
test np_ig_unpinned_links_without_lent_rejected() fail {
  t_ig_wakeme(1_000, t_wakeme_commit, cp_cap_no_lent, [t_rate_ok(), t_unpinned_ok(), t_gb_ok()])
}

// Cực đối: cùng lượt sinh, bỏ két Wakeme khỏi reference input ⟹ link giữ rỗng, lent 0, qua.
// Đây là lối thoát của chủ két: luật 6 không làm kẹt két chưa link.
test np_ig_unlinked_without_wakeme_keeps_empty_ok() {
  t_ig_wakeme(1_000, #"", cp_cap_no_lent, [t_rate_ok(), t_gb_ok()])
}

test np_ig_unpinned_cap_with_lent_fail() fail {
  t_ig_wakeme(1_000, t_wakeme_commit, cp_cap_lent, [t_rate_ok(), t_unpinned_ok(), t_gb_ok()])
}

// ── Nhánh KHÔNG chữ ký (KeepLink): link rỗng + két Wakeme đưa vào ⟹ fail ─────────
// Đầu ra là đúng thứ hàm tính nếu chốt KeepLink vắng (link := owner_commit, không
// lent) — ca này ghim chốt KeepLink, không ghim phép so đầu ra.
test np_pe_unlinked_unpinned_sets_link_fail() fail {
  let din = t_cp_prune_din(#"")
  let out = VaultDatum { ..din, magic_batches: [] }
  t_pe(t_cp_apply(out, din, t_wakeme_commit, cp_cap_no_lent, 10, 0), din, [t_rate_ok(), t_unpinned_ok()])
}

// Link rỗng giữ nguyên ở đầu ra, nhưng vẫn đưa két vào ⟹ fail (KeepLink đòi két
// đưa vào phải là két ĐÃ ghim theo link).
test np_pe_unlinked_unpinned_keeps_empty_fail() fail {
  let din = t_cp_prune_din(#"")
  let out = VaultDatum { ..din, magic_batches: [] }
  t_pe(t_cp_apply(out, din, #"", cp_cap_no_lent, 10, 0), din, [t_rate_ok(), t_unpinned_ok()])
}

// Link đã đặt, két Wakeme nay ghim két IG khác ⟹ prune (không chữ ký) vẫn chạy được,
// giữ link, L_lent = 0. Bản trước fail ở đây ⟹ không ai dọn được két đó.
test np_pe_linked_wakeme_repinned_elsewhere_ok() {
  let din = t_cp_prune_din(t_wakeme_commit)
  let out = VaultDatum { ..din, magic_batches: [] }
  t_pe(t_cp_apply(out, din, t_wakeme_commit, cp_cap_no_lent, 10, 0), din, [t_rate_ok(), t_unpinned_ok()])
}

// ── Genesis két IG với 0 LAMP ──────────────────────────────────────────────────
fn t_zero_lamp_genesis() -> VaultDatum {
  VaultDatum { ..t_clean_genesis(0), loyalty_holdings: [] }
}

test np_mint_genesis_zero_lamp_ok() {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  let out = t_genesis_output(t_zero_lamp_genesis(), 0, t_vault_hash, name)
  let m = assets.from_asset(t_vault_hash, name, 1)
  t_mint_call(seed, t_vault_hash, t_mint_tx(seed, out, m, [t_owner_pkh]))
}

// ── Lượt sinh ĐẦU của két 0 LAMP, gốc lưới Mainnet ─────────────────────────────
// Kỳ IG = 10. Két Wakeme cho mượn 12 LAMP (cp_lent_c + cp_lent_o) ≥ min_instant_holding.

fn t_mn_params() -> VaultParams {
  VaultParams { ..t_params(), window_origin_ms: window_origin_fixtures.mainnet_origin_ms }
}

/// `t` trong kỳ `k` của lưới gốc Mainnet (cách đầu kỳ 5 giây).
fn t_mn_in_period(k: Int) -> Int {
  window_origin_fixtures.mainnet_origin_ms + k * t_ms_per_epoch + 5_000
}

/// Két Wakeme ghim két IG của bài kiểm, genesis ở `vest_start_ms`, mốc ghim `gpp`.
fn t_wakeme_pinned_at(vest_start_ms: Int, gpp: Int) -> Input {
  t_wakeme_ref_at(0, t_wakeme_commit, t_vault_id_name, cp_lent_c, cp_lent_o, vest_start_ms, gpp)
}

fn t_first_gen_zero_lamp(params: VaultParams, wakeme: Input) -> Bool {
  t_first_gen_zero_lamp_from(t_zero_lamp_genesis(), params, wakeme)
}

fn t_first_gen_zero_lamp_from(din: VaultDatum, params: VaultParams, wakeme: Input) -> Bool {
  let lent = cp_lent_c + cp_lent_o
  let cap =
    amount_by_lamp(0, lent, shift_window(din.usage_window, din.usage_window_epoch, 10), 2_000_000_000, 6)
  let m = 1_000
  validate_instant_gen(
    din, m, 10, t_own_ref(), params,
    t_ig_tx(
      din, t_ig_out(din, t_wakeme_commit, cap, m), 0, [t_rate_ok(), wakeme, t_gb_ok()],
      t_shard_in(0, ig_shard_id(), t_s(3, ig_reset, ig_remaining)),
      t_shard_out(ig_shard_id(), t_s(3, ig_reset, ig_remaining - m)),
    ),
  )
}

// Két Wakeme ghim két IG này ngay lúc genesis, cùng kỳ 10 ⟹ L_lent được tính ⟹ qua
// IG-6 dù két IG không có LAMP riêng.
test np_first_gen_zero_lamp_genesis_pin_ok() {
  t_first_gen_zero_lamp(t_mn_params(), t_wakeme_pinned_at(t_mn_in_period(10), 10))
}

// Cùng tx, nhưng két Wakeme đã ĐỔI ghim sang két này ở kỳ 10 (genesis kỳ 9) ⟹
// L_lent = 0 ⟹ 0 + 0 < min_instant_holding ⟹ IG-6 từ chối.
test np_first_gen_zero_lamp_repinned_same_period_fail() fail {
  t_first_gen_zero_lamp(t_mn_params(), t_wakeme_pinned_at(t_mn_in_period(9), 10))
}

// Cùng ca dương, nhưng validator nhận gốc 0 (bản quên gốc ở apply-param) ⟹ vế genesis
// thấy kỳ 3496 ≠ 10 ⟹ L_lent = 0 ⟹ đỏ.
test np_first_gen_zero_lamp_forgotten_origin_fail() fail {
  t_first_gen_zero_lamp(t_params(), t_wakeme_pinned_at(t_mn_in_period(10), 10))
}

// ── Hành trình người mới (gốc Mainnet, P = 432M) ────────────────────────────────
// (1) genesis két IG 0 LAMP, link khai sẵn = owner_commit của DID;
// (2) [giả lập] genesis két Wakeme ghim két IG này: `vest_start_ms = hi`,
//     `gen_pin_period = period(hi)` — điều kiện `gen_view(IG).link == owner_commit`
//     bên Wakeme nay thoả nhờ (1);
// (3) lượt sinh đầu cùng kỳ tính L_lent và qua IG-6.

fn t_journey_genesis_linked() -> VaultDatum {
  VaultDatum { ..t_zero_lamp_genesis(), wakeme_link: t_wakeme_commit }
}

test np_journey_mint_zero_lamp_linked_ok() {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  let out = t_genesis_output(t_journey_genesis_linked(), 0, t_vault_hash, name)
  let m = assets.from_asset(t_vault_hash, name, 1)
  t_mint_call(seed, t_vault_hash, t_mint_tx(seed, out, m, [t_owner_pkh]))
}

test np_journey_first_gen_linked_genesis_pin_ok() {
  t_first_gen_zero_lamp_from(
    t_journey_genesis_linked(), t_mn_params(), t_wakeme_pinned_at(t_mn_in_period(10), 10),
  )
}

// ── Ca đối: genesis két IG link RỖNG ⟹ két Wakeme không ghim được nó lúc genesis
// (gen_vault = None). Lượt có ký đặt được link, nhưng L_lent = 0.

fn t_wakeme_genesis_unpinned() -> Input {
  t_wakeme_ref_gen(0, t_wakeme_commit, None, cp_lent_c, cp_lent_o, t_mn_in_period(10), 10)
}

test np_journey_unlinked_rc_sets_link_without_lent() {
  let din = t_zero_lamp_genesis()
  let cap = amount_by_lamp(0, 0, shift_window(din.usage_window, din.usage_window_epoch, 10), 2_000_000_000, 6)
  let dout = t_cp_apply(din, din, t_wakeme_commit, cap, 10, 0)
  validate_refresh_checkpoint(
    din, 10, t_own_ref(), t_mn_params(),
    Transaction {
      ..t_tx([t_vault_input(din, 0)], [t_vault_output(dout, 0)], [t_owner_pkh]),
      reference_inputs: [t_rate_ok(), t_wakeme_genesis_unpinned()],
    },
  )
}

// Cùng kịch bản, lượt sinh đầu của két 0 LAMP ⟹ 0 + 0 < min_instant_holding ⟹ IG-6.
// Từ 2026-10-03 (luật 6 bỏ vế (a)) bài này chết SỚM HƠN, ở `resolve_link` (link rỗng +
// két chưa ghim ⟹ fail), trước khi tới IG-6 — vẫn đỏ đúng chiều, nhưng nó không còn
// ghim IG-6.
test np_journey_unlinked_first_gen_zero_lamp_fail() fail {
  t_first_gen_zero_lamp_from(t_zero_lamp_genesis(), t_mn_params(), t_wakeme_genesis_unpinned())
}

// ═══ Luật 6 — `FollowVault` không đổi link sang két Wakeme lạ (2026-10-02) ═══════
//
// Đòn: két IG đã link X. Người dựng tx (chủ ký cho việc khác) thay két Wakeme thật X
// bằng két Wakeme thật Y đang ghim két IG KHÁC ⟹ vế (c) trả `(Y, 0)`. Trước bản vá:
// link := Y, cap chốt không phần mượn trọn epoch, X không chốt OwnEpoch được nữa.
// Mỗi ca âm có đầu ra ĐÚNG bằng thứ hàm tính khi luật 6 vắng (link := Y, cap không
// lent) — nên chỉ luật 6 chặn được nó, phép so đầu ra thì không. Cực đối dương nằm
// ngay cạnh: cùng tx, két Y ghim CHÍNH két IG này (lent > 0) ⟹ đổi được.

/// Két Wakeme thật Y (owner_commit c4…) ghim két IG KHÁC (tên NFT c4…).
fn t_foreign_wakeme() -> Input {
  t_wakeme_ref(0, t_wakeme_commit_2, t_wakeme_commit_2, cp_lent_c, cp_lent_o)
}

/// Két Wakeme thật Y ghim CHÍNH két IG của bài kiểm (`t_vault_id_name`).
fn t_other_wakeme_pinning_this() -> Input {
  t_wakeme_ref(0, t_wakeme_commit_2, t_vault_id_name, cp_lent_c, cp_lent_o)
}

fn t_ig_linked(link_in: ByteArray, link_out: ByteArray, cap_out: Int, refs: List<Input>) -> Bool {
  let din = t_cp_din(link_in)
  t_ig(
    din, t_ig_out(din, link_out, cap_out, 1_000), cp_bal, 1_000, refs,
    t_s(3, ig_reset, ig_remaining), t_s(3, ig_reset, ig_remaining - 1_000),
  )
}

// ── Nhánh sinh ───────────────────────────────────────────────────────────────────
// Bản PoC `poc_relink_to_foreign_wakeme_accepted` (vòng soát đối kháng) — nay phải đỏ.
test f1_ig_relink_to_foreign_wakeme_rejected() fail {
  t_ig_linked(t_wakeme_commit, t_wakeme_commit_2, cp_cap_no_lent, [t_rate_ok(), t_foreign_wakeme(), t_gb_ok()])
}

// Cực đối: cùng tx, Y ghim chính két này ⟹ đổi link được, cap có phần mượn.
test f1_ig_relink_to_wakeme_pinning_this_ok() {
  t_ig_linked(t_wakeme_commit, t_wakeme_commit_2, cp_cap_lent, [t_rate_ok(), t_other_wakeme_pinning_this(), t_gb_ok()])
}

// Vế (a) cũ ĐÃ BỎ (2026-10-03): link rỗng + két Y ghim két khác (lent 0) ⟹ KHÔNG nối
// được nữa. Bản trước của bài này là ca dương `f1_ig_unlinked_foreign_wakeme_links_ok`.
test f1_ig_unlinked_foreign_wakeme_rejected() fail {
  t_ig_linked(#"", t_wakeme_commit_2, cp_cap_no_lent, [t_rate_ok(), t_foreign_wakeme(), t_gb_ok()])
}

// Cực đối: link rỗng + Y ghim CHÍNH két này (lent > 0) ⟹ vế (c) vẫn nối được, cap có phần mượn.
test f1_ig_unlinked_wakeme_pinning_this_ok() {
  t_ig_linked(#"", t_wakeme_commit_2, cp_cap_lent, [t_rate_ok(), t_other_wakeme_pinning_this(), t_gb_ok()])
}

// Cùng luật ở nhánh BurnBatch (chủ ký, tx do người khác dựng): link rỗng + két lạ ⟹ fail.
test f1_bb_unlinked_foreign_wakeme_rejected() fail {
  let din = t_cp_burn_din(#"")
  t_bb(
    t_cp_apply(t_bb_base_out(din), din, t_wakeme_commit_2, cp_cap_no_lent, 10, 200),
    din, [t_rate_ok(), t_foreign_wakeme()],
  )
}

// Vế (b): link X + két X (chưa ghim két này, lent 0) ⟹ giữ link. Chỉ vế (b) cho qua:
// link khác rỗng và lent = 0.
test f1_ig_linked_same_wakeme_unpinned_keeps_ok() {
  t_ig_linked(t_wakeme_commit, t_wakeme_commit, cp_cap_no_lent, [t_rate_ok(), t_unpinned_ok(), t_gb_ok()])
}

// Đối chứng PoC: bỏ hẳn két ⟹ luật 2 chặn.
test f1_ig_linked_omit_wakeme_rejected() fail {
  t_ig_linked(t_wakeme_commit, #"", cp_cap_no_lent, [t_rate_ok(), t_gb_ok()])
}

// ── Ba nhánh chủ ký còn lại (mỗi chỗ gọi `FollowVault` một ca âm + cực đối) ─────────
test f1_bb_relink_to_foreign_wakeme_rejected() fail {
  let din = t_cp_burn_din(t_wakeme_commit)
  t_bb(
    t_cp_apply(t_bb_base_out(din), din, t_wakeme_commit_2, cp_cap_no_lent, 10, 200),
    din, [t_rate_ok(), t_foreign_wakeme()],
  )
}

test f1_bb_relink_to_wakeme_pinning_this_ok() {
  let din = t_cp_burn_din(t_wakeme_commit)
  t_bb(
    t_cp_apply(t_bb_base_out(din), din, t_wakeme_commit_2, cp_cap_lent, 10, 200),
    din, [t_rate_ok(), t_other_wakeme_pinning_this()],
  )
}

test f1_up_relink_to_foreign_wakeme_rejected() fail {
  let din = t_cp_din(t_wakeme_commit)
  t_up(
    t_cp_apply(up_output(din, Ember, 10), din, t_wakeme_commit_2, cp_cap_no_lent, 10, 0),
    din, [t_rate_ok(), t_foreign_wakeme()],
  )
}

test f1_up_relink_to_wakeme_pinning_this_ok() {
  let din = t_cp_din(t_wakeme_commit)
  t_up(
    t_cp_apply(up_output(din, Ember, 10), din, t_wakeme_commit_2, cp_cap_lent, 10, 0),
    din, [t_rate_ok(), t_other_wakeme_pinning_this()],
  )
}

fn t_f1_sd_din() -> VaultDatum {
  VaultDatum { ..t_cp_sd_din(), wakeme_link: t_wakeme_commit }
}

test f1_sd_relink_to_foreign_wakeme_rejected() fail {
  let din = t_f1_sd_din()
  t_sd(
    t_cp_apply(t_cp_sd_out(din), din, t_wakeme_commit_2, cp_cap_no_lent, 10, 0),
    din, [t_rate_ok(), t_foreign_wakeme()],
  )
}

test f1_sd_relink_to_wakeme_pinning_this_ok() {
  let din = t_f1_sd_din()
  t_sd(
    t_cp_apply(t_cp_sd_out(din), din, t_wakeme_commit_2, cp_cap_lent, 10, 0),
    din, [t_rate_ok(), t_other_wakeme_pinning_this()],
  )
}

// ── RefreshCheckpoint (`FollowVaultOrUnlink`) GIỮ luật cũ: đổi được sang Y chưa ghim ──
test f1_rc_relink_to_foreign_wakeme_ok() {
  let din = t_cp_din(t_wakeme_commit)
  t_rc(t_cp_apply(din, din, t_wakeme_commit_2, cp_cap_no_lent, 10, 0), din, [t_rate_ok(), t_foreign_wakeme()])
}

// ═══ G16 — reference script trên output két (2026-10-03) ═════════════════════════
// Cặp bài theo khuôn `aiken-patterns` 2026-10-02: ca dương gắn ref-script vào output VÍ
// (phân biệt cổng soi-đúng-output-két với cổng soi-mọi-output), ca âm gắn vào output két.
const t_g16_ref_hash: ByteArray =
  #"5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c"

fn t_g16_with_ref_script(o: Output) -> Output {
  Output { ..o, reference_script: Some(t_g16_ref_hash) }
}

fn t_g16_keep(o: Output) -> Output {
  o
}

fn t_g16_wallet_ref_output() -> Output {
  Output {
    address: Address { payment_credential: VerificationKey(t_owner_pkh), stake_credential: None },
    value: assets.from_lovelace(20_000_000),
    datum: NoDatum,
    reference_script: Some(t_g16_ref_hash),
  }
}

/// PruneExpired KHÔNG chữ ký, một batch chết; `edit` sửa output két, `extra` thêm output.
fn t_g16_prune(edit: fn(Output) -> Output, extra: List<Output>) -> Bool {
  let din = t_datum_with_batches([t_instant_batch(9, 1000)])
  let dout = t_datum_with_batches([])
  let tx = t_tx([t_vault_input(din, 100)], [edit(t_vault_output(dout, 100)), ..extra], [])
  validate_prune_expired(din, 10, t_own_ref(), t_params(), tx)
}

test g16_ig_pe_stranger_ref_script_rejected() fail {
  t_g16_prune(t_g16_with_ref_script, [])
}

test g16_ig_pe_wallet_ref_script_ok() {
  t_g16_prune(t_g16_keep, [t_g16_wallet_ref_output()])
}

test g16_ig_pe_no_ref_script_ok() {
  t_g16_prune(t_g16_keep, [])
}

/// Genesis két 0 LAMP (fixture của `np_mint_genesis_zero_lamp_ok`).
fn t_g16_mint(edit: fn(Output) -> Output, extra: List<Output>) -> Bool {
  let seed = t_mint_seed()
  let name = t_mint_name(seed)
  let out = t_genesis_output(t_zero_lamp_genesis(), 0, t_vault_hash, name)
  let m = assets.from_asset(t_vault_hash, name, 1)
  let tx = t_mint_tx(seed, edit(out), m, [t_owner_pkh])
  t_mint_call(seed, t_vault_hash, Transaction { ..tx, outputs: list.concat(tx.outputs, extra) })
}

test g16_ig_genesis_ref_script_rejected() fail {
  t_g16_mint(t_g16_with_ref_script, [])
}

test g16_ig_genesis_wallet_ref_script_ok() {
  t_g16_mint(t_g16_keep, [t_g16_wallet_ref_output()])
}

/// RefreshCheckpoint (fixture của `rc_pos_link_from_wakeme`) — nhánh không qua
/// `validate_vault_value`, cổng ref-script đặt riêng.
fn t_g16_rc(edit: fn(Output) -> Output, extra: List<Output>) -> Bool {
  let din = t_cp_din(#"")
  let dout = t_cp_apply(din, din, t_wakeme_commit, cp_cap_lent, 10, 0)
  let tx = t_cp_tx(din, dout, [t_rate_ok(), t_lent_ok()], [t_owner_pkh])
  validate_refresh_checkpoint(
    din, 10, t_own_ref(), t_params(),
    Transaction { ..tx, outputs: list.concat(list.map(tx.outputs, edit), extra) },
  )
}

test g16_ig_rc_ref_script_rejected() fail {
  t_g16_rc(t_g16_with_ref_script, [])
}

test g16_ig_rc_wallet_ref_script_ok() {
  t_g16_rc(t_g16_keep, [t_g16_wallet_ref_output()])
}

// ═══════════════════════════════════════════════════════════════
// Ca kiểm bổ sung cho bốn chỗ hở khai ở issue #128 (2026-10-06). Mỗi cặp: ca qua và
// ca trượt chỉ khác ở ĐÚNG đại lượng của chốt mang tên, mọi cổng khác giữ ở trạng
// thái qua — nên gỡ chốt đó ra thì ca trượt đổi màu.
// ═══════════════════════════════════════════════════════════════

// ── (1a) IG-9, vế `compute_cap_lent(L_lent)` quyết định một mình ─────────────────
// Ca qua là `ig_pos_same_epoch_linked_lent` (m = 1.48e8: 3e8 + m == 4e8 + 4.8e7).
// Cặp đối cũ (`ig_neg_same_epoch_linked_absent`) đổi TẬP reference input (bỏ két
// Wakeme ⟹ L_lent = 0) nên nó đo "có/không có két", cách biên 4.8e7. Ca này giữ NGUYÊN
// tập reference input, chỉ thêm 1 nanogic ⟹ ghim đúng biên của vế lent: cap_nanogic
// 1e12 không chặn, GB còn 1e9 và share 5e8 ≥ 3e8 + m không chặn. Đo đột biến
// 2026-10-06: gỡ dòng IG-9 ⟹ ca này (và cả hai ca cũ kể trên) đổi màu.
test ig_neg_cumul_over_cap_pp_plus_lent_by_one() fail {
  t_ig_same(t_same_din(t_wakeme_commit, 1_000_000_000_000), 148_000_001, [t_lent_ok(), t_gb_ok()])
}

// ── (1b) IG-6, vế `lamp_balance + L_lent >= min_instant_holding` ────────────────
// Vế này chỉ tách khỏi vế `avail + L_lent` khi `avail > lamp_balance`, tức
// `lamp_locked < 0` — trạng thái KHÔNG tới được trên két thật (genesis ghim
// `lamp_locked = 0`, mọi nhánh giữ nguyên). Cặp dưới dựng đúng trạng thái đó để vế
// balance là vế DUY NHẤT quyết: cả hai ca có avail = 10_000_001 ≥ min, chỉ balance
// khác (10_000_000 vs 9_999_999). Gỡ vế balance ⟹ ca trượt xanh.
test ig_pos_g2_balance_exact_with_negative_lock() {
  t_g2_locked(10_000_000, -1)
}

test ig_neg_g2_balance_below_min_masked_by_avail() fail {
  t_g2_locked(9_999_999, -2)
}

// ── (2) ADA-không-giảm ở bốn nhánh spend chưa có bài canh ───────────────────────
// `validate_vault_value` ▸ `lovelace_not_decreased`. Prune/BurnBatch/Refresh đã có
// (`val_neg_pe_ada_drained`, `val_neg_burn_ada_drained`, `rc_neg_ada_minus_one`).
// Mỗi cặp: lovelace vào 2_000_000, ra 2_000_000 (qua) / 1_999_999 (trượt); datum,
// LAMP, NFT, chữ ký giống hệt nhau.
const ada_in: Int = 2_000_000

// InstantGen: rút m = 1 khỏi két nền (như `ig_pos_partial`), lovelace ra tuỳ chọn.
fn t_ig_ada(lovelace_out: Int) -> Bool {
  let din = t_cp_din(#"")
  let m = 1
  let dout = t_ig_out(din, #"", cp_cap_no_lent, m)
  validate_instant_gen(
    din, m, 10, t_own_ref(), t_params(),
    Transaction {
      ..placeholder,
      inputs: [
        t_vault_input_ada(din, ada_in, cp_bal),
        t_shard_in(0, ig_shard_id(), t_s(3, ig_reset, ig_remaining)),
      ],
      reference_inputs: t_refs_base(),
      outputs: [
        t_vault_output_ada(dout, lovelace_out, cp_bal),
        t_shard_out(ig_shard_id(), t_s(3, ig_reset, ig_remaining - m)),
      ],
      extra_signatories: [t_owner_pkh],
      validity_range: interval.between(ig_lo, ig_hi),
    },
  )
}

test ada_pos_instant_gen_preserved() {
  t_ig_ada(ada_in)
}

test ada_neg_instant_gen_drained_by_one() fail {
  t_ig_ada(ada_in - 1)
}

// WithdrawLamp: rút 5 LAMP (như `w_positive_partial`).
fn t_wd_ada(lovelace_out: Int) -> Bool {
  let din = t_datum(100, 0, [t_holding(100, 5, False)])
  let dout = t_datum(95, 0, [t_holding(95, 5, False)])
  let tx =
    t_tx(
      [t_vault_input_ada(din, ada_in, 100)],
      [t_vault_output_ada(dout, lovelace_out, 95)],
      [t_owner_pkh],
    )
  validate_withdraw_lamp(din, 5, 0, t_own_ref(), t_params(), tx)
}

test ada_pos_withdraw_lamp_preserved() {
  t_wd_ada(ada_in)
}

test ada_neg_withdraw_lamp_drained_by_one() fail {
  t_wd_ada(ada_in - 1)
}

// SetDelegate: xoá delegate Some → None (như `sd_positive_clear`).
fn t_sd_ada(lovelace_out: Int) -> Bool {
  let din = t_burn_din([t_burn_batch(bid_a, 1000)], Some(t_delegate))
  let dout = VaultDatum { ..din, personal_delegate: None, last_updated_epoch: 10 }
  let tx =
    t_tx(
      [t_vault_input_ada(din, ada_in, 100)],
      [t_vault_output_ada(dout, lovelace_out, 100)],
      [t_owner_pkh],
    )
  validate_set_delegate(din, None, 10, t_own_ref(), t_params(), tx)
}

test ada_pos_set_delegate_preserved() {
  t_sd_ada(ada_in)
}

test ada_neg_set_delegate_drained_by_one() fail {
  t_sd_ada(ada_in - 1)
}

// UpdateProfile: Flame → Ember (như `up_positive`).
fn t_up_ada(lovelace_out: Int) -> Bool {
  let din = t_datum_e10()
  let dout = up_output(din, Ember, 10)
  let tx =
    t_tx(
      [t_vault_input_ada(din, ada_in, 100)],
      [t_vault_output_ada(dout, lovelace_out, 100)],
      [t_owner_pkh],
    )
  validate_update_profile(din, Ember, 10, t_own_ref(), t_params(), tx)
}

test ada_pos_update_profile_preserved() {
  t_up_ada(ada_in)
}

test ada_neg_update_profile_drained_by_one() fail {
  t_up_ada(ada_in - 1)
}

// ── (3) RefreshCheckpoint GIỮA epoch khi L_lent của két Wakeme tăng ─────────────
// Két đã ghim link, checkpoint đã chốt ở epoch 10 với L_lent cũ = 12e6 (7e6 + 5e6).
// Cũng trong epoch 10, két Wakeme nay báo owned 15e6 ⟹ L_lent = 22e6. Làm mới phải ghi
// `amount_by_lamp` với L_lent MỚI; ghi lại cap cũ (đúng thứ một nhánh "cùng epoch thì
// bỏ qua" sẽ để nguyên) ⟹ trượt.
const rc_lent_owned_grown: Int = 15_000_000

fn t_rc_mid_din() -> VaultDatum {
  let base = t_cp_din(t_wakeme_commit)
  VaultDatum {
    ..base,
    cap_epoch: 10,
    usage_window_epoch: 10,
    cap_nanogic: rc_mid_cap_old(),
  }
}

fn rc_mid_cap_old() -> Int {
  amount_by_lamp(cp_bal, cp_lent_c + cp_lent_o, t_win_a(), 2_000_000_000, 6)
}

fn rc_mid_cap_new() -> Int {
  amount_by_lamp(cp_bal, cp_lent_c + rc_lent_owned_grown, t_win_a(), 2_000_000_000, 6)
}

fn t_rc_mid(cap_out: Int) -> Bool {
  let din = t_rc_mid_din()
  t_rc(
    VaultDatum { ..din, cap_nanogic: cap_out },
    din,
    [t_rate_ok(), t_lent_ref(cp_lent_c, rc_lent_owned_grown)],
  )
}

// Neo: hai cap phải KHÁC nhau, nếu không cặp dưới không phân biệt được gì.
test rc_mid_epoch_lent_caps_differ() {
  rc_mid_cap_new() > rc_mid_cap_old()
}

test rc_pos_mid_epoch_lent_grown_recomputes() {
  t_rc_mid(rc_mid_cap_new())
}

test rc_neg_mid_epoch_lent_grown_keeps_old_cap() fail {
  t_rc_mid(rc_mid_cap_old())
}
