// validators/prepaid.ak — PrepaidGen: prepaid_vault + paid_fund
// Normative: MagicLamp-Tripletoken-Feat-(Vi).md §4.2, §6.5, §7.3, §7.4, §7.6,
//            §11, §12; Carpet-CARP-DacTa-Vi.md §5.1 (F2); C-PP-1..15 (DESIGN.md).
// PlutusV3 / Aiken ≥ 1.1.x
//
// HAI SCRIPT, THẨM QUYỀN TÁCH BẠCH (mỗi delta có ĐÚNG MỘT bên kiểm toàn bộ):
//   PrepaidLock  → VAULT có thẩm quyền trên cả delta quỹ lẫn delta hạn-mức;
//                  quỹ chỉ chứng minh "có vault thật cùng tiêu bằng constr 0".
//   PrepaidDraw  → VAULT (quỹ không tham gia giao dịch → không tranh chấp UTxO).
//   BurnBatch    → VAULT (ConsumeMAGIC ép Σburns == required ở tầng trên).
//   PrunePrepaid → VAULT, permissionless.
//   FundSettle   → QUỸ có thẩm quyền: đọc thẳng cặp datum vault vào/ra.
//   FundClaim    → QUỸ.
//
// PHÁ VÒNG THAM CHIẾU: prepaid_vault nhận `paid_fund_hash` làm tham số; chiều
// ngược KHÔNG đi qua tham số biên dịch (sẽ thành vòng) mà qua
// `PaidFundDatum.vault_hash` ghim tại genesis bởi fund_nft và bất biến sau đó.
// Nhờ vậy quỹ vẫn ghim được vault thật khi quyết toán — khác khuôn shard.ak của
// ScheduleGen (shard chấp nhận bất kỳ input nào giải mã ra VaultDatum, được ở đó
// vì shard KHÔNG có thẩm quyền; bê nguyên sang đây là mở đường cho vault giả bơm
// magic_settled rồi rút CARP).

use aiken/builtin
use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite, IntervalBoundType}
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Spend, Transaction, placeholder,
}

use magiclamp/protocol/types.{
  BurnBatch, FundClaim, FundLock, FundSettle, MagicBatch, PaidFundDatum,
  PaidFundRedeemer, PrepaidCredit, PrepaidDraw, PrepaidLock, PrepaidVaultDatum,
  PrepaidVaultRedeemer, PrunePrepaid, SetDelegate, VaultAttribution,
}
use magiclamp/protocol/constants.{
  batch_source_prepaid, max_batches_per_vault, max_prepaid_credits,
  min_draw_carpdrop, min_lock_carpdrop, prepaid_decay_window, prepaid_profile,
}
use magiclamp/protocol/math.{
  buffer_floor, compute_batch_id, outstanding_of, par_carp_from_magic,
  par_magic_from_carp,
}

// Constructor index của các nhánh redeemer — dùng khi đọc redeemer của script
// KHÁC qua builtin.un_constr_data (không ghép kiểu chéo validator).
const rd_prepaid_lock: Int = 0
const rd_burn_batch: Int = 2   // §7.3/§11 — ConsumeMAGIC ghim burn_batch_constr = 2

// ══════════════════════════════════════════════════════════════
// prepaid_vault
// ══════════════════════════════════════════════════════════════
// `ms_per_epoch`: Mainnet 432_000_000 · Preview/Preprod 86_400_000.
validator prepaid_vault(
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  fund_nft_policy : PolicyId,
  paid_fund_hash  : ByteArray,
  ms_per_epoch    : Int,
) {
  spend(
    datum_opt : Option<PrepaidVaultDatum>,
    redeemer  : PrepaidVaultRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(datum) = datum_opt
    let current_epoch = get_epoch(tx, ms_per_epoch)
    let vault_addr = own_addr(own_ref, tx.inputs)

    // C-PP-10: đúng một vault input tại địa chỉ này
    expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

    when redeemer is {
      PrepaidLock { fund_id, amount_carpdrop } ->
        validate_lock(
          datum, fund_id, amount_carpdrop, current_epoch, vault_addr,
          carp_policy_id, carp_asset_name, fund_nft_policy, paid_fund_hash, tx,
        )

      PrepaidDraw { fund_id, amount_carpdrop } ->
        validate_draw(
          datum, fund_id, amount_carpdrop, current_epoch, own_ref, vault_addr,
          carp_policy_id, carp_asset_name, tx,
        )

      BurnBatch { burns } ->
        validate_burn_batch(
          datum, burns, current_epoch, vault_addr, carp_policy_id,
          carp_asset_name, tx,
        )

      PrunePrepaid ->
        validate_prune(
          datum, current_epoch, vault_addr, carp_policy_id, carp_asset_name, tx,
        )

      SetDelegate { new_delegate } ->
        validate_set_delegate(
          datum, new_delegate, current_epoch, vault_addr, carp_policy_id,
          carp_asset_name, tx,
        )
    }
  }

  else(_) {
    fail
  }
}

// ══════════════════════════════════════════════════════════════
// paid_fund
// ══════════════════════════════════════════════════════════════
validator paid_fund(
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  fund_nft_policy : PolicyId,
  ms_per_epoch    : Int,
) {
  spend(
    datum_opt : Option<PaidFundDatum>,
    redeemer  : PaidFundRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(fund_in) = datum_opt
    let current_epoch = get_epoch(tx, ms_per_epoch)
    let fund_addr = own_addr(own_ref, tx.inputs)

    // C-PP-10: đúng một quỹ input tại địa chỉ này, và nó phải MANG NFT quỹ
    expect list.count(tx.inputs, fn(i) { i.output.address == fund_addr }) == 1
    let own_in = own_input(own_ref, tx.inputs)
    expect
      assets.quantity_of(own_in.output.value, fund_nft_policy, fund_in.fund_id) == 1

    // C-PP-13: không đúc/đốt token của policy NFT quỹ trong giao dịch vận hành
    expect no_fund_mint(tx, fund_nft_policy)

    fund_common_checks(
      fund_in, own_in, fund_addr, carp_policy_id, carp_asset_name,
      fund_nft_policy, current_epoch, redeemer, tx,
    )
  }

  else(_) {
    fail
  }
}

// Tách khỏi thân validator cho gọn: kiểm bất biến chung rồi rẽ nhánh.
fn fund_common_checks(
  fund_in         : PaidFundDatum,
  own_in          : Input,
  fund_addr       : Address,
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  fund_nft_policy : PolicyId,
  current_epoch   : Int,
  redeemer        : PaidFundRedeemer,
  tx              : Transaction,
) -> Bool {
  // Đúng MỘT output mang NFT quỹ, và nó phải ở lại địa chỉ quỹ.
  let fund_out_utxo =
    find_fund_output_utxo(tx.outputs, fund_nft_policy, fund_in.fund_id)
  expect fund_out_utxo.address == fund_addr
  let fund_out = decode_fund(fund_out_utxo)

  // C-PP-3: sổ khớp value, hai đầu.
  expect
    assets.quantity_of(own_in.output.value, carp_policy_id, carp_asset_name) == fund_in.carp_locked
  expect
    assets.quantity_of(fund_out_utxo.value, carp_policy_id, carp_asset_name) == fund_out.carp_locked

  // Bất biến định danh + tham số (C-PP-15 giữ chúng đúng từ genesis).
  expect fund_out.fund_id == fund_in.fund_id
  expect fund_out.platform == fund_in.platform
  expect fund_out.vault_hash == fund_in.vault_hash
  expect fund_out.buffer_bps == fund_in.buffer_bps
  expect fund_out.last_updated_epoch == current_epoch

  // C-PP-3: carp_locked == credit_issued − provider_claimed (đúng từ genesis 0/0/0)
  expect fund_out.carp_locked == fund_out.credit_issued - fund_out.provider_claimed

  when redeemer is {
    FundLock -> validate_fund_lock(fund_in, fund_out, tx)
    FundSettle -> validate_fund_settle(fund_in, fund_out, current_epoch, tx)
    FundClaim { amount_carpdrop } ->
      validate_fund_claim(fund_in, fund_out, amount_carpdrop, tx)
  }
}

// ══════════════════════════════════════════════════════════════
// VAULT — PrepaidLock (C-PP-2, C-PP-3, C-PP-9, C-PP-12)
// ══════════════════════════════════════════════════════════════
fn validate_lock(
  datum           : PrepaidVaultDatum,
  fund_id         : ByteArray,
  amount          : Int,
  current_epoch   : Int,
  vault_addr      : Address,
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  fund_nft_policy : PolicyId,
  paid_fund_hash  : ByteArray,
  tx              : Transaction,
) -> Bool {
  // C-PP-12
  expect amount >= min_lock_carpdrop

  // Quỹ phải ở ĐÚNG địa chỉ paid_fund và mang NFT one-shot đúng tên fund_id.
  // Đây là thứ bảo vệ người khoá khỏi "quỹ giả" do kẻ tấn công dựng.
  let fund_in_utxo =
    find_fund_utxo_at(
      list.map(tx.inputs, fn(i) { i.output }), paid_fund_hash, fund_nft_policy,
      fund_id,
    )
  let fund_out_utxo =
    find_fund_utxo_at(tx.outputs, paid_fund_hash, fund_nft_policy, fund_id)
  let fund_in = decode_fund(fund_in_utxo)
  let fund_out = decode_fund(fund_out_utxo)

  // C-PP-9: platform HOẶC owner ký (app khoá hộ user là hợp lệ — §9 nguồn B)
  expect
    list.has(tx.extra_signatories, fund_in.platform) || list.has(
      tx.extra_signatories,
      datum.owner,
    )

  // C-PP-13
  expect no_fund_mint(tx, fund_nft_policy)

  // Quỹ này phải trỏ về ĐÚNG script vault đang chạy.
  expect fund_in.vault_hash == script_hash_of(vault_addr)

  // VAULT CÓ THẨM QUYỀN: kiểm TOÀN BỘ delta quỹ.
  expect fund_out.fund_id == fund_in.fund_id
  expect fund_out.platform == fund_in.platform
  expect fund_out.vault_hash == fund_in.vault_hash
  expect fund_out.buffer_bps == fund_in.buffer_bps
  expect fund_out.carp_locked == fund_in.carp_locked + amount
  expect fund_out.credit_issued == fund_in.credit_issued + amount
  expect fund_out.magic_settled == fund_in.magic_settled
  expect fund_out.provider_claimed == fund_in.provider_claimed
  expect fund_out.last_updated_epoch == current_epoch

  // CARP THẬT trong output quỹ tăng đúng bằng amount (C-PP-2 chân trái).
  expect
    assets.quantity_of(fund_in_utxo.value, carp_policy_id, carp_asset_name) == fund_in.carp_locked
  expect
    assets.quantity_of(fund_out_utxo.value, carp_policy_id, carp_asset_name) == fund_in.carp_locked + amount

  // Hạn-mức: tối đa 1 dòng cho mỗi fund_id.
  expect list.count(datum.prepaid_credits, fn(c) { c.fund_id == fund_id }) <= 1
  let new_credits = add_credit(datum.prepaid_credits, fund_id, amount, current_epoch)
  expect list.length(new_credits) <= max_prepaid_credits

  let out = get_vault_output(tx.outputs, vault_addr)
  expect out.owner == datum.owner
  expect out.did_commit == datum.did_commit         // C-PP-8
  expect out.prepaid_credits == new_credits
  expect out.magic_batches == datum.magic_batches
  expect out.next_batch_index == datum.next_batch_index
  expect out.personal_delegate == datum.personal_delegate
  expect out.attribution == datum.attribution
  expect out.last_updated_epoch == current_epoch
  expect vault_output_carp(tx.outputs, vault_addr, carp_policy_id, carp_asset_name) == 0
  True
}

// Cộng hạn-mức: có dòng thì cộng vào, chưa có thì thêm vào CUỐI danh sách.
fn add_credit(
  credits : List<PrepaidCredit>,
  fund_id : ByteArray,
  amount  : Int,
  epoch   : Int,
) -> List<PrepaidCredit> {
  if list.any(credits, fn(c) { c.fund_id == fund_id }) {
    list.map(
      credits,
      fn(c) {
        if c.fund_id == fund_id {
          PrepaidCredit { ..c, remaining: c.remaining + amount }
        } else {
          c
        }
      },
    )
  } else {
    list.concat(
      credits,
      [
        PrepaidCredit {
          fund_id,
          remaining: amount,
          issued_epoch: epoch,
          last_draw_epoch: epoch,
        },
      ],
    )
  }
}

// ══════════════════════════════════════════════════════════════
// VAULT — PrepaidDraw (C-PP-1, C-PP-2, C-PP-5, C-PP-12)
// ══════════════════════════════════════════════════════════════
fn validate_draw(
  datum           : PrepaidVaultDatum,
  fund_id         : ByteArray,
  amount          : Int,
  current_epoch   : Int,
  own_ref         : OutputReference,
  vault_addr      : Address,
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {
  // C-PP-12
  expect amount >= min_draw_carpdrop

  // C-PP-9: owner HOẶC consume-delegate (Paymaster §7.6)
  expect authed_owner_or_delegate(datum, tx)

  // C-PP-2: phải có ĐÚNG một dòng hạn-mức của quỹ này, và đủ số dư.
  expect list.count(datum.prepaid_credits, fn(c) { c.fund_id == fund_id }) == 1
  let new_credits =
    list.map(
      datum.prepaid_credits,
      fn(c) {
        if c.fund_id == fund_id {
          expect amount <= c.remaining
          PrepaidCredit {
            ..c,
            remaining: c.remaining - amount,
            last_draw_epoch: current_epoch,
          }
        } else {
          c
        }
      },
    )

  // C-PP-1: par chính xác, không phí, không làm tròn.
  let minted_nanogic = par_magic_from_carp(amount)

  // C-PP-5: batch sinh ra luôn thuộc epoch hiện tại, cliff = 1.
  let batch =
    MagicBatch {
      batch_id: compute_batch_id(
        own_ref.transaction_id,
        own_ref.output_index,
        datum.next_batch_index,
      ),
      source: batch_source_prepaid,
      created_epoch: current_epoch,
      current_amount: minted_nanogic,
      decay_window: prepaid_decay_window,
      profile_at_creation: prepaid_profile,
      contract_id: fund_id,
    }
  let new_batches = list.concat(datum.magic_batches, [batch])
  expect list.length(new_batches) <= max_batches_per_vault

  let out = get_vault_output(tx.outputs, vault_addr)
  expect out.owner == datum.owner
  expect out.did_commit == datum.did_commit         // C-PP-8
  expect out.prepaid_credits == new_credits
  expect out.magic_batches == new_batches
  expect out.next_batch_index == datum.next_batch_index + 1
  expect out.personal_delegate == datum.personal_delegate
  expect out.attribution == datum.attribution
  expect out.last_updated_epoch == current_epoch
  expect vault_output_carp(tx.outputs, vault_addr, carp_policy_id, carp_asset_name) == 0
  True
}

// ══════════════════════════════════════════════════════════════
// VAULT — BurnBatch (D1 datum-consume, §7.1/§7.3)
// ══════════════════════════════════════════════════════════════
// Giảm current_amount của batch được trỏ. KHÔNG tx.mint, KHÔNG token.
// `required` (giá) do ConsumeMAGIC ép ở tầng trên; vault ép ĐÚNG kế toán + phân
// quyền + không rò giá trị + C-PP-5 (chỉ tiêu được batch CÒN SỐNG).
fn validate_burn_batch(
  datum           : PrepaidVaultDatum,
  burns           : List<(ByteArray, Int)>,
  current_epoch   : Int,
  vault_addr      : Address,
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {
  expect authed_owner_or_delegate(datum, tx)
  expect list.length(burns) > 0

  let expected_batches = apply_burns(datum.magic_batches, burns, current_epoch)

  let out = get_vault_output(tx.outputs, vault_addr)
  expect out.owner == datum.owner
  expect out.did_commit == datum.did_commit         // C-PP-8
  expect out.prepaid_credits == datum.prepaid_credits
  expect out.magic_batches == expected_batches
  expect out.next_batch_index == datum.next_batch_index
  expect out.personal_delegate == datum.personal_delegate
  expect out.last_updated_epoch == current_epoch
  expect out.attribution.attribution_root == datum.attribution.attribution_root
  expect out.attribution.total_events == datum.attribution.total_events + 1
  expect out.attribution.last_event_epoch == current_epoch
  expect list.length(out.magic_batches) <= max_batches_per_vault
  expect vault_output_carp(tx.outputs, vault_addr, carp_policy_id, carp_asset_name) == 0
  True
}

// Mỗi (batch_id, amt): đúng một batch khớp id, batch phải CÒN SỐNG
// (created_epoch == current_epoch — C-PP-5), amt ∈ (0, current_amount];
// giảm current_amount, bỏ batch khi về 0; mọi trường khác bất biến.
fn apply_burns(
  batches       : List<MagicBatch>,
  burns         : List<(ByteArray, Int)>,
  current_epoch : Int,
) -> List<MagicBatch> {
  when burns is {
    [] -> batches
    [(bid, amt), ..rest] -> {
      expect amt > 0
      expect list.count(batches, fn(b) { b.batch_id == bid }) == 1
      let reduced =
        list.filter_map(
          batches,
          fn(b) {
            if b.batch_id == bid {
              // C-PP-5: batch của epoch đã chết KHÔNG tiêu được.
              expect b.created_epoch == current_epoch
              expect amt <= b.current_amount
              let na = b.current_amount - amt
              if na == 0 {
                None
              } else {
                Some(MagicBatch { ..b, current_amount: na })
              }
            } else {
              Some(b)
            }
          },
        )
      apply_burns(reduced, rest, current_epoch)
    }
  }
}

// ══════════════════════════════════════════════════════════════
// VAULT — PrunePrepaid (§7.4, permissionless) — TRẢ LẠI HẠN-MỨC
// ══════════════════════════════════════════════════════════════
// MAGIC hết hạn thì phần CARP đối ứng vẫn nằm trong quỹ và provider KHÔNG đòi
// được (F2 chỉ cho đòi phần đã tiêu thật). Nếu không trả lại hạn-mức thì số CARP
// đó kẹt vĩnh viễn, vô chủ. Trả lại HẠN-MỨC (không phải CARP) giữ nguyên F2:
// không đồng CARP nào rời quỹ, hạn-mức vẫn chỉ đi một chiều thành dịch vụ.
fn validate_prune(
  datum           : PrepaidVaultDatum,
  current_epoch   : Int,
  vault_addr      : Address,
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {
  // KHÔNG cần chữ ký (C-PP-9) — dọn rác là việc ai cũng làm được.
  let dead = list.filter(datum.magic_batches, fn(b) { b.created_epoch < current_epoch })
  let live = list.filter(datum.magic_batches, fn(b) { b.created_epoch >= current_epoch })

  // reject-noop (§7.4): không có gì để dọn thì từ chối.
  expect list.length(dead) > 0

  let new_credits = restore_credits(datum.prepaid_credits, dead)

  let out = get_vault_output(tx.outputs, vault_addr)
  expect out.owner == datum.owner
  expect out.did_commit == datum.did_commit         // C-PP-8
  expect out.prepaid_credits == new_credits
  expect out.magic_batches == live
  expect out.next_batch_index == datum.next_batch_index
  expect out.personal_delegate == datum.personal_delegate
  expect out.attribution == datum.attribution
  expect out.last_updated_epoch == current_epoch
  expect vault_output_carp(tx.outputs, vault_addr, carp_policy_id, carp_asset_name) == 0
  True
}

fn restore_credits(
  credits : List<PrepaidCredit>,
  dead    : List<MagicBatch>,
) -> List<PrepaidCredit> {
  when dead is {
    [] -> credits
    [b, ..rest] -> {
      expect b.source == batch_source_prepaid
      // Dòng hạn-mức không bao giờ bị xoá ⇒ luôn tồn tại đúng một dòng.
      expect list.count(credits, fn(c) { c.fund_id == b.contract_id }) == 1
      let back = par_carp_from_magic(b.current_amount)
      let updated =
        list.map(
          credits,
          fn(c) {
            if c.fund_id == b.contract_id {
              PrepaidCredit { ..c, remaining: c.remaining + back }
            } else {
              c
            }
          },
        )
      restore_credits(updated, rest)
    }
  }
}

// ══════════════════════════════════════════════════════════════
// VAULT — SetDelegate (§7.6)
// ══════════════════════════════════════════════════════════════
fn validate_set_delegate(
  datum           : PrepaidVaultDatum,
  new_delegate    : Option<ByteArray>,
  current_epoch   : Int,
  vault_addr      : Address,
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {
  // CHỈ owner — delegate không được tự uỷ quyền tiếp.
  expect list.has(tx.extra_signatories, datum.owner)

  let out = get_vault_output(tx.outputs, vault_addr)
  expect out.owner == datum.owner
  expect out.did_commit == datum.did_commit         // C-PP-8
  expect out.prepaid_credits == datum.prepaid_credits
  expect out.magic_batches == datum.magic_batches
  expect out.next_batch_index == datum.next_batch_index
  expect out.personal_delegate == new_delegate       // ← thay đổi duy nhất
  expect out.attribution == datum.attribution
  expect out.last_updated_epoch == current_epoch
  expect vault_output_carp(tx.outputs, vault_addr, carp_policy_id, carp_asset_name) == 0
  True
}

// ══════════════════════════════════════════════════════════════
// FUND — FundLock
// ══════════════════════════════════════════════════════════════
// Vault đã kiểm toàn bộ delta; quỹ chỉ chứng minh có VAULT THẬT (đúng
// vault_hash ghim genesis) cùng tiêu bằng constr 0, và delta có dạng đúng.
fn validate_fund_lock(
  fund_in  : PaidFundDatum,
  fund_out : PaidFundDatum,
  tx       : Transaction,
) -> Bool {
  expect vault_cospend(tx, fund_in.vault_hash, rd_prepaid_lock)
  expect fund_out.carp_locked > fund_in.carp_locked
  expect
    fund_out.credit_issued - fund_in.credit_issued == fund_out.carp_locked - fund_in.carp_locked
  expect fund_out.magic_settled == fund_in.magic_settled
  expect fund_out.provider_claimed == fund_in.provider_claimed
  True
}

// ══════════════════════════════════════════════════════════════
// FUND — FundSettle (C-PP-7, INV-MAGIC-CITIZEN)
// ══════════════════════════════════════════════════════════════
fn validate_fund_settle(
  fund_in       : PaidFundDatum,
  fund_out      : PaidFundDatum,
  current_epoch : Int,
  tx            : Transaction,
) -> Bool {
  // Vault thật, tiêu bằng ĐÚNG BurnBatch (constr 2). Không nhận constr khác:
  // PrunePrepaid cũng làm current_amount biến mất nhưng đó là HẾT HẠN, không
  // phải tiêu thật — tính vào magic_settled là phá INV-MAGIC-CITIZEN.
  expect vault_cospend(tx, fund_in.vault_hash, rd_burn_batch)

  let delta = settle_delta(tx, fund_in.vault_hash, fund_in.fund_id, current_epoch)
  expect delta > 0

  expect fund_out.magic_settled == fund_in.magic_settled + delta
  expect fund_out.credit_issued == fund_in.credit_issued
  expect fund_out.provider_claimed == fund_in.provider_claimed
  expect fund_out.carp_locked == fund_in.carp_locked

  // Không thể quyết toán quá phần hạn-mức đã cấp.
  expect par_carp_from_magic(fund_out.magic_settled) <= fund_out.credit_issued
  True
}

// Σ phần current_amount GIẢM trên các batch: contract_id == fund_id,
// source == 3, created_epoch == epoch hiện tại (CÒN SỐNG).
fn settle_delta(
  tx            : Transaction,
  vault_hash    : ByteArray,
  fund_id       : ByteArray,
  current_epoch : Int,
) -> Int {
  expect Some(vin) = list.find(tx.inputs, fn(i) { is_at_script(i.output.address, vault_hash) })
  expect
    list.count(tx.outputs, fn(o) { is_at_script(o.address, vault_hash) }) == 1
  expect Some(vout) = list.find(tx.outputs, fn(o) { is_at_script(o.address, vault_hash) })
  let din = decode_vault(vin.output)
  let dout = decode_vault(vout)
  sum_settled(din.magic_batches, dout.magic_batches, fund_id, current_epoch, 0)
}

fn sum_settled(
  ins           : List<MagicBatch>,
  outs          : List<MagicBatch>,
  fund_id       : ByteArray,
  current_epoch : Int,
  acc           : Int,
) -> Int {
  when ins is {
    [] -> acc
    [b, ..rest] ->
      if b.contract_id == fund_id && b.source == batch_source_prepaid && b.created_epoch == current_epoch {
        let after =
          when list.find(outs, fn(o) { o.batch_id == b.batch_id }) is {
            Some(o) -> o.current_amount
            None -> 0
          }
        expect after <= b.current_amount
        sum_settled(rest, outs, fund_id, current_epoch, acc + b.current_amount - after)
      } else {
        sum_settled(rest, outs, fund_id, current_epoch, acc)
      }
  }
}

// ══════════════════════════════════════════════════════════════
// FUND — FundClaim (C-PP-6 = F2)
// ══════════════════════════════════════════════════════════════
fn validate_fund_claim(
  fund_in  : PaidFundDatum,
  fund_out : PaidFundDatum,
  amount   : Int,
  tx       : Transaction,
) -> Bool {
  expect list.has(tx.extra_signatories, fund_in.platform)
  expect amount > 0
  expect fund_out.carp_locked == fund_in.carp_locked - amount
  expect fund_out.provider_claimed == fund_in.provider_claimed + amount
  expect fund_out.credit_issued == fund_in.credit_issued
  expect fund_out.magic_settled == fund_in.magic_settled

  // F2 (a): claim_provider ≤ Σ MAGIC_burned_par
  expect
    fund_out.provider_claimed <= par_carp_from_magic(fund_out.magic_settled)

  // F2 (b): buffer-Paid — giữ lại đệm trên phần dịch vụ chưa giao.
  let outstanding = outstanding_of(fund_out.credit_issued, fund_out.magic_settled)
  expect fund_out.carp_locked >= buffer_floor(outstanding, fund_out.buffer_bps)
  True
}

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

// SEC-02: đọc mỗi lower_bound cho phép kẻ tấn công đặt lower = đầu epoch E với
// upper mở, được đưa vào chuỗi ở epoch E+k, mà validator vẫn tin current_epoch
// == E. Ép CẢ HAI biên Finite và cùng một epoch → current_epoch không nhập nhằng.
fn get_epoch(tx: Transaction, ms_per_epoch: Int) -> Int {
  expect Some(lower_ms) = tx.validity_range.lower_bound.bound_type |> get_finite
  expect Some(upper_ms) = tx.validity_range.upper_bound.bound_type |> get_finite
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

fn script_hash_of(addr: Address) -> ByteArray {
  expect Script(h) = addr.payment_credential
  h
}

// So khớp theo payment credential, KHÔNG theo địa chỉ đầy đủ — địa chỉ thật có
// thể mang stake credential.
fn is_at_script(addr: Address, hash: ByteArray) -> Bool {
  when addr.payment_credential is {
    Script(h) -> h == hash
    _ -> False
  }
}

fn find_vault_output_raw(outputs: List<Output>, vault_addr: Address) -> Output {
  // C-PP-10: đúng một output vault tiếp nối.
  expect list.count(outputs, fn(x) { x.address == vault_addr }) == 1
  expect Some(o) = list.find(outputs, fn(x) { x.address == vault_addr })
  o
}

fn get_vault_output(outputs: List<Output>, vault_addr: Address) -> PrepaidVaultDatum {
  decode_vault(find_vault_output_raw(outputs, vault_addr))
}

fn decode_vault(o: Output) -> PrepaidVaultDatum {
  expect InlineDatum(d) = o.datum
  expect vd: PrepaidVaultDatum = d
  vd
}

fn decode_fund(o: Output) -> PaidFundDatum {
  expect InlineDatum(d) = o.datum
  expect fd: PaidFundDatum = d
  fd
}

fn vault_output_carp(
  outputs         : List<Output>,
  vault_addr      : Address,
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
) -> Int {
  let o = find_vault_output_raw(outputs, vault_addr)
  assets.quantity_of(o.value, carp_policy_id, carp_asset_name)
}

// Tìm UTxO quỹ trong một danh sách Output: phải Ở ĐÚNG script quỹ và mang đúng
// 1 NFT tên fund_id. Ép DUY NHẤT để trạng thái quỹ không bị tách làm hai.
fn find_fund_utxo_at(
  outs            : List<Output>,
  paid_fund_hash  : ByteArray,
  fund_nft_policy : PolicyId,
  fund_id         : ByteArray,
) -> Output {
  let matches =
    list.filter(
      outs,
      fn(o) {
        is_at_script(o.address, paid_fund_hash) && assets.quantity_of(
          o.value,
          fund_nft_policy,
          fund_id,
        ) == 1
      },
    )
  expect [only] = matches
  only
}

// Phía quỹ: đúng một output mang NFT quỹ (bất kể địa chỉ) — bên gọi ép thêm địa
// chỉ, nhờ vậy NFT không thể bị chuyển đi nơi khác.
fn find_fund_output_utxo(
  outputs         : List<Output>,
  fund_nft_policy : PolicyId,
  fund_id         : ByteArray,
) -> Output {
  let matches =
    list.filter(
      outputs,
      fn(o) { assets.quantity_of(o.value, fund_nft_policy, fund_id) == 1 },
    )
  expect [only] = matches
  only
}

fn no_fund_mint(tx: Transaction, fund_nft_policy: PolicyId) -> Bool {
  dict.is_empty(assets.tokens(tx.mint, fund_nft_policy))
}

fn authed_owner_or_delegate(datum: PrepaidVaultDatum, tx: Transaction) -> Bool {
  list.has(tx.extra_signatories, datum.owner) || when datum.personal_delegate is {
    Some(d) -> list.has(tx.extra_signatories, d)
    None -> False
  }
}

// Có ĐÚNG MỘT input tại script `vault_hash`, và redeemer Spend của nó là nhánh
// `want_constr`. Đọc constructor index bằng builtin (không ghép kiểu chéo
// validator — cùng cách ConsumeMAGIC đọc BurnBatch). Fail-closed khi không tìm
// thấy redeemer.
fn vault_cospend(tx: Transaction, vault_hash: ByteArray, want_constr: Int) -> Bool {
  expect
    list.count(tx.inputs, fn(i) { is_at_script(i.output.address, vault_hash) }) == 1
  expect Some(vin) =
    list.find(tx.inputs, fn(i) { is_at_script(i.output.address, vault_hash) })
  when
    list.find(
      tx.redeemers,
      fn(p) {
        let Pair(purpose, _) = p
        purpose == Spend(vin.output_reference)
      },
    )
  is {
    Some(Pair(_, rd_data)) -> {
      let Pair(idx, _fields) = builtin.un_constr_data(rd_data)
      idx == want_constr
    }
    None -> False
  }
}

// ═══════════════════════════════════════════════════════════════
// Tests — happy path + MỌI nhánh tấn công đã nêu trong DESIGN.md §4
// ═══════════════════════════════════════════════════════════════

const t_owner: ByteArray = #"00000000000000000000000000000000000000000000000000000000"
const t_delegate: ByteArray = #"99999999999999999999999999999999999999999999999999999999"
const t_platform: ByteArray = #"77777777777777777777777777777777777777777777777777777777"
const t_stranger: ByteArray = #"88888888888888888888888888888888888888888888888888888888"
const t_vault_hash: ByteArray = #"11111111111111111111111111111111111111111111111111111111"
const t_fund_hash: ByteArray = #"44444444444444444444444444444444444444444444444444444444"
const t_evil_hash: ByteArray = #"66666666666666666666666666666666666666666666666666666666"
const t_carp_policy: ByteArray = #"22222222222222222222222222222222222222222222222222222222"
const t_carp_name: ByteArray = #"43415250"
const t_fund_policy: ByteArray = #"33333333333333333333333333333333333333333333333333333333"
const t_fund_id: ByteArray =
  #"aaaa000000000000000000000000000000000000000000000000000000000000"
const t_other_fund: ByteArray =
  #"bbbb000000000000000000000000000000000000000000000000000000000000"
const t_did: ByteArray = #"deadbeef"
const t_tx_id: ByteArray =
  #"3333333333333333333333333333333333333333333333333333333333333333"
const t_fund_tx: ByteArray =
  #"5555555555555555555555555555555555555555555555555555555555555555"

const t_epoch: Int = 7

fn t_vault_addr() -> Address {
  address.from_script(t_vault_hash)
}

fn t_fund_addr() -> Address {
  address.from_script(t_fund_hash)
}

fn t_own_ref() -> OutputReference {
  OutputReference { transaction_id: t_tx_id, output_index: 0 }
}

fn t_fund_ref() -> OutputReference {
  OutputReference { transaction_id: t_fund_tx, output_index: 0 }
}

// ── Vault fixtures ────────────────────────────────────────────

fn t_credit(fund_id: ByteArray, remaining: Int) -> PrepaidCredit {
  PrepaidCredit { fund_id, remaining, issued_epoch: 5, last_draw_epoch: 5 }
}

fn t_batch(id: ByteArray, amount: Int, epoch: Int, fund_id: ByteArray) -> MagicBatch {
  MagicBatch {
    batch_id: id,
    source: batch_source_prepaid,
    created_epoch: epoch,
    current_amount: amount,
    decay_window: prepaid_decay_window,
    profile_at_creation: prepaid_profile,
    contract_id: fund_id,
  }
}

fn t_vd(
  credits : List<PrepaidCredit>,
  batches : List<MagicBatch>,
) -> PrepaidVaultDatum {
  PrepaidVaultDatum {
    owner: t_owner,
    did_commit: t_did,
    prepaid_credits: credits,
    magic_batches: batches,
    next_batch_index: 0,
    personal_delegate: None,
    last_updated_epoch: 5,
    attribution: VaultAttribution {
      attribution_root: #"",
      last_event_epoch: 0,
      total_events: 0,
    },
  }
}

fn t_vault_out_v(datum: PrepaidVaultDatum, carp: Int) -> Output {
  Output {
    address: t_vault_addr(),
    value: assets.from_lovelace(2_000_000)
      |> assets.add(t_carp_policy, t_carp_name, carp),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn t_vault_out(datum: PrepaidVaultDatum) -> Output {
  t_vault_out_v(datum, 0)
}

fn t_vault_in(datum: PrepaidVaultDatum) -> Input {
  Input { output_reference: t_own_ref(), output: t_vault_out(datum) }
}

// ── Fund fixtures ─────────────────────────────────────────────

fn t_fd(
  carp_locked      : Int,
  credit_issued    : Int,
  magic_settled    : Int,
  provider_claimed : Int,
  buffer_bps       : Int,
) -> PaidFundDatum {
  PaidFundDatum {
    fund_id: t_fund_id,
    platform: t_platform,
    vault_hash: t_vault_hash,
    carp_locked,
    credit_issued,
    magic_settled,
    provider_claimed,
    buffer_bps,
    last_updated_epoch: t_epoch,
  }
}

fn t_fund_value(carp: Int, nft_name: ByteArray) -> assets.Value {
  assets.from_lovelace(2_000_000)
    |> assets.add(t_carp_policy, t_carp_name, carp)
    |> assets.add(t_fund_policy, nft_name, 1)
}

fn t_fund_out_at(datum: PaidFundDatum, carp: Int, addr: Address) -> Output {
  Output {
    address: addr,
    value: t_fund_value(carp, datum.fund_id),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn t_fund_out(datum: PaidFundDatum, carp: Int) -> Output {
  t_fund_out_at(datum, carp, t_fund_addr())
}

fn t_fund_in(datum: PaidFundDatum, carp: Int) -> Input {
  Input { output_reference: t_fund_ref(), output: t_fund_out(datum, carp) }
}

fn t_tx(
  ins     : List<Input>,
  outs    : List<Output>,
  signers : List<ByteArray>,
) -> Transaction {
  Transaction { ..placeholder, inputs: ins, outputs: outs, extra_signatories: signers }
}

fn t_tx_rd(
  ins     : List<Input>,
  outs    : List<Output>,
  signers : List<ByteArray>,
  vault_r : PrepaidVaultRedeemer,
) -> Transaction {
  let rd: Data = vault_r
  Transaction {
    ..placeholder,
    inputs: ins,
    outputs: outs,
    extra_signatories: signers,
    redeemers: [Pair(Spend(t_own_ref()), rd)],
  }
}

// ══════════════════════════════════════════════════════════════
// PrepaidLock
// ══════════════════════════════════════════════════════════════

const lock_amt: Int = 1_000_000_000   // 1 CARP (9 chu so)

fn lock_tx(
  vin_d    : PrepaidVaultDatum,
  vout_d   : PrepaidVaultDatum,
  fin      : PaidFundDatum,
  fin_carp : Int,
  fout     : PaidFundDatum,
  fout_carp: Int,
  signers  : List<ByteArray>,
) -> Transaction {
  t_tx(
    [t_vault_in(vin_d), t_fund_in(fin, fin_carp)],
    [t_vault_out(vout_d), t_fund_out(fout, fout_carp)],
    signers,
  )
}

fn run_lock(datum: PrepaidVaultDatum, tx: Transaction) -> Bool {
  validate_lock(
    datum, t_fund_id, lock_amt, t_epoch, t_vault_addr(), t_carp_policy,
    t_carp_name, t_fund_policy, t_fund_hash, tx,
  )
}

// happy: khoá 1 CARP → hạn-mức mới, CARP thật vào quỹ.
test pp_lock_ok() {
  let din = t_vd([], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: lock_amt,
          issued_epoch: t_epoch,
          last_draw_epoch: t_epoch,
        },
      ],
      last_updated_epoch: t_epoch,
    }
  let fin = t_fd(0, 0, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  run_lock(din, lock_tx(din, dout, fin, 0, fout, lock_amt, [t_platform]))
}

// happy: khoá thêm vào hạn-mức đã có → cộng dồn, không thêm dòng.
test pp_lock_topup_ok() {
  let din = t_vd([t_credit(t_fund_id, 500)], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: 500 + lock_amt,
          issued_epoch: 5,
          last_draw_epoch: 5,
        },
      ],
      last_updated_epoch: t_epoch,
    }
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(2 * lock_amt, 2 * lock_amt, 0, 0, 1_500)
  run_lock(din, lock_tx(din, dout, fin, lock_amt, fout, 2 * lock_amt, [t_owner]))
}

// TẤN CÔNG: cấp hạn-mức mà CARP thật KHÔNG vào quỹ (datum nói tăng, value không).
test pp_lock_credit_without_carp() fail {
  let din = t_vd([], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: lock_amt,
          issued_epoch: t_epoch,
          last_draw_epoch: t_epoch,
        },
      ],
      last_updated_epoch: t_epoch,
    }
  let fin = t_fd(0, 0, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  // output quỹ chỉ mang 0 CARP dù datum khai lock_amt
  run_lock(din, lock_tx(din, dout, fin, 0, fout, 0, [t_platform]))
}

// TẤN CÔNG: credit_issued tăng nhiều hơn carp_locked.
test pp_lock_credit_gt_carp() fail {
  let din = t_vd([], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: lock_amt,
          issued_epoch: t_epoch,
          last_draw_epoch: t_epoch,
        },
      ],
      last_updated_epoch: t_epoch,
    }
  let fin = t_fd(0, 0, 0, 0, 1_500)
  let fout = t_fd(lock_amt, 10 * lock_amt, 0, 0, 1_500)
  run_lock(din, lock_tx(din, dout, fin, 0, fout, lock_amt, [t_platform]))
}

// TẤN CÔNG: "quỹ" nằm ở địa chỉ của kẻ tấn công (NFT đúng, địa chỉ sai).
test pp_lock_fake_fund_address() fail {
  let din = t_vd([], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: lock_amt,
          issued_epoch: t_epoch,
          last_draw_epoch: t_epoch,
        },
      ],
      last_updated_epoch: t_epoch,
    }
  let fin = t_fd(0, 0, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let evil = address.from_script(t_evil_hash)
  let tx =
    t_tx(
      [
        t_vault_in(din),
        Input {
          output_reference: t_fund_ref(),
          output: t_fund_out_at(fin, 0, evil),
        },
      ],
      [t_vault_out(dout), t_fund_out_at(fout, lock_amt, evil)],
      [t_platform],
    )
  run_lock(din, tx)
}

// TẤN CÔNG: quỹ trỏ vault_hash khác → vault này không được nhận hạn-mức từ nó.
test pp_lock_wrong_vault_hash() fail {
  let din = t_vd([], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: lock_amt,
          issued_epoch: t_epoch,
          last_draw_epoch: t_epoch,
        },
      ],
      last_updated_epoch: t_epoch,
    }
  let fin = PaidFundDatum { ..t_fd(0, 0, 0, 0, 1_500), vault_hash: t_evil_hash }
  let fout =
    PaidFundDatum { ..t_fd(lock_amt, lock_amt, 0, 0, 1_500), vault_hash: t_evil_hash }
  run_lock(din, lock_tx(din, dout, fin, 0, fout, lock_amt, [t_platform]))
}

// TẤN CÔNG: không ai trong {platform, owner} ký.
test pp_lock_no_auth() fail {
  let din = t_vd([], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: lock_amt,
          issued_epoch: t_epoch,
          last_draw_epoch: t_epoch,
        },
      ],
      last_updated_epoch: t_epoch,
    }
  let fin = t_fd(0, 0, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  run_lock(din, lock_tx(din, dout, fin, 0, fout, lock_amt, [t_stranger]))
}

// TẤN CÔNG: khoá dưới sàn tối thiểu.
test pp_lock_below_min() fail {
  let din = t_vd([], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: 1,
          issued_epoch: t_epoch,
          last_draw_epoch: t_epoch,
        },
      ],
      last_updated_epoch: t_epoch,
    }
  let fin = t_fd(0, 0, 0, 0, 1_500)
  let fout = t_fd(1, 1, 0, 0, 1_500)
  let tx = lock_tx(din, dout, fin, 0, fout, 1, [t_platform])
  validate_lock(
    din, t_fund_id, 1, t_epoch, t_vault_addr(), t_carp_policy, t_carp_name,
    t_fund_policy, t_fund_hash, tx,
  )
}

// TẤN CÔNG: sửa did_commit trong lúc khoá.
test pp_lock_did_forged() fail {
  let din = t_vd([], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      did_commit: #"cafe",
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: lock_amt,
          issued_epoch: t_epoch,
          last_draw_epoch: t_epoch,
        },
      ],
      last_updated_epoch: t_epoch,
    }
  let fin = t_fd(0, 0, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  run_lock(din, lock_tx(din, dout, fin, 0, fout, lock_amt, [t_platform]))
}

// ══════════════════════════════════════════════════════════════
// PrepaidDraw
// ══════════════════════════════════════════════════════════════

const draw_amt: Int = 1_000_000_000          // 1 CARP (9 chu so)
const draw_nanogic: Int = 1_000_000_000      // = 1 MAGIC (par chính xác)

fn drawn_batch(index: Int) -> MagicBatch {
  MagicBatch {
    batch_id: compute_batch_id(t_tx_id, 0, index),
    source: batch_source_prepaid,
    created_epoch: t_epoch,
    current_amount: draw_nanogic,
    decay_window: prepaid_decay_window,
    profile_at_creation: prepaid_profile,
    contract_id: t_fund_id,
  }
}

fn run_draw(datum: PrepaidVaultDatum, amount: Int, tx: Transaction) -> Bool {
  validate_draw(
    datum, t_fund_id, amount, t_epoch, t_own_ref(), t_vault_addr(),
    t_carp_policy, t_carp_name, tx,
  )
}

// happy: rút 1 CARP hạn-mức → đúng 1 MAGIC, batch của epoch hiện tại.
test pp_draw_ok() {
  let din = t_vd([t_credit(t_fund_id, 5_000_000_000)], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: 4_000_000_000,
          issued_epoch: 5,
          last_draw_epoch: t_epoch,
        },
      ],
      magic_batches: [drawn_batch(0)],
      next_batch_index: 1,
      last_updated_epoch: t_epoch,
    }
  run_draw(din, draw_amt, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
}

// happy: delegate (Paymaster §7.6) rút hộ.
test pp_draw_by_delegate_ok() {
  let base = t_vd([t_credit(t_fund_id, 5_000_000_000)], [])
  let din = PrepaidVaultDatum { ..base, personal_delegate: Some(t_delegate) }
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: 4_000_000_000,
          issued_epoch: 5,
          last_draw_epoch: t_epoch,
        },
      ],
      magic_batches: [drawn_batch(0)],
      next_batch_index: 1,
      last_updated_epoch: t_epoch,
    }
  run_draw(din, draw_amt, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_delegate]))
}

// TẤN CÔNG cốt lõi: sinh MAGIC mà KHÔNG có hạn-mức nào của quỹ đó.
test pp_draw_without_credit() fail {
  let din = t_vd([t_credit(t_other_fund, 5_000_000_000)], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      magic_batches: [drawn_batch(0)],
      next_batch_index: 1,
      last_updated_epoch: t_epoch,
    }
  run_draw(din, draw_amt, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
}

// TẤN CÔNG: rút quá hạn-mức.
test pp_draw_over_credit() fail {
  let din = t_vd([t_credit(t_fund_id, 500_000_000)], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: 0,
          issued_epoch: 5,
          last_draw_epoch: t_epoch,
        },
      ],
      magic_batches: [drawn_batch(0)],
      next_batch_index: 1,
      last_updated_epoch: t_epoch,
    }
  run_draw(din, draw_amt, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
}

// TẤN CÔNG: rút đúng hạn-mức nhưng ghi MAGIC nhiều hơn par (bơm tỷ giá).
test pp_draw_inflated_magic() fail {
  let din = t_vd([t_credit(t_fund_id, 5_000_000_000)], [])
  let inflated =
    MagicBatch { ..drawn_batch(0), current_amount: draw_nanogic * 10 }
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: 4_000_000_000,
          issued_epoch: 5,
          last_draw_epoch: t_epoch,
        },
      ],
      magic_batches: [inflated],
      next_batch_index: 1,
      last_updated_epoch: t_epoch,
    }
  run_draw(din, draw_amt, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
}

// TẤN CÔNG: gắn batch vào epoch tương lai để né cliff.
test pp_draw_future_epoch() fail {
  let din = t_vd([t_credit(t_fund_id, 5_000_000_000)], [])
  let future = MagicBatch { ..drawn_batch(0), created_epoch: t_epoch + 5 }
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: 4_000_000_000,
          issued_epoch: 5,
          last_draw_epoch: t_epoch,
        },
      ],
      magic_batches: [future],
      next_batch_index: 1,
      last_updated_epoch: t_epoch,
    }
  run_draw(din, draw_amt, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
}

// TẤN CÔNG: đặt decay_window > 1 để MAGIC sống qua epoch.
test pp_draw_decay_window_forged() fail {
  let din = t_vd([t_credit(t_fund_id, 5_000_000_000)], [])
  let forged = MagicBatch { ..drawn_batch(0), decay_window: 12 }
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: 4_000_000_000,
          issued_epoch: 5,
          last_draw_epoch: t_epoch,
        },
      ],
      magic_batches: [forged],
      next_batch_index: 1,
      last_updated_epoch: t_epoch,
    }
  run_draw(din, draw_amt, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
}

// TẤN CÔNG: người lạ rút hạn-mức của người khác.
test pp_draw_no_auth() fail {
  let din = t_vd([t_credit(t_fund_id, 5_000_000_000)], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: 4_000_000_000,
          issued_epoch: 5,
          last_draw_epoch: t_epoch,
        },
      ],
      magic_batches: [drawn_batch(0)],
      next_batch_index: 1,
      last_updated_epoch: t_epoch,
    }
  run_draw(din, draw_amt, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_stranger]))
}

// TẤN CÔNG: rút dưới sàn (spam batch rác).
test pp_draw_below_min() fail {
  let din = t_vd([t_credit(t_fund_id, 5_000_000_000)], [])
  let tiny = MagicBatch { ..drawn_batch(0), current_amount: 999_000 }
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: 5_000_000 - 999,
          issued_epoch: 5,
          last_draw_epoch: t_epoch,
        },
      ],
      magic_batches: [tiny],
      next_batch_index: 1,
      last_updated_epoch: t_epoch,
    }
  run_draw(din, 999, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
}

// TẤN CÔNG: gửi CARP vào chính vault (giá trị không được kế toán).
test pp_draw_vault_holds_carp() fail {
  let din = t_vd([t_credit(t_fund_id, 5_000_000_000)], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: 4_000_000_000,
          issued_epoch: 5,
          last_draw_epoch: t_epoch,
        },
      ],
      magic_batches: [drawn_batch(0)],
      next_batch_index: 1,
      last_updated_epoch: t_epoch,
    }
  run_draw(
    din,
    draw_amt,
    t_tx([t_vault_in(din)], [t_vault_out_v(dout, 500_000)], [t_owner]),
  )
}

// ══════════════════════════════════════════════════════════════
// BurnBatch
// ══════════════════════════════════════════════════════════════

fn t_out_burn(
  batches : List<MagicBatch>,
  credits : List<PrepaidCredit>,
  events  : Int,
) -> PrepaidVaultDatum {
  PrepaidVaultDatum {
    ..t_vd(credits, batches),
    last_updated_epoch: t_epoch,
    attribution: VaultAttribution {
      attribution_root: #"",
      last_event_epoch: t_epoch,
      total_events: events,
    },
  }
}

fn run_burn(
  datum : PrepaidVaultDatum,
  burns : List<(ByteArray, Int)>,
  tx    : Transaction,
) -> Bool {
  validate_burn_batch(
    datum, burns, t_epoch, t_vault_addr(), t_carp_policy, t_carp_name, tx,
  )
}

// happy: tiêu một phần batch còn sống.
test pp_burn_ok() {
  let din = t_vd([], [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let dout = t_out_burn([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], [], 1)
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// happy: tiêu hết → batch bị bỏ khỏi danh sách.
test pp_burn_full_ok() {
  let din = t_vd([], [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let dout = t_out_burn([], [], 1)
  run_burn(
    din,
    [(#"b1", 1_000_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// TẤN CÔNG cốt lõi: tiêu batch của epoch ĐÃ CHẾT (C-PP-5).
test pp_burn_dead_batch() fail {
  let din = t_vd([], [t_batch(#"b1", 1_000_000_000, t_epoch - 1, t_fund_id)])
  let dout = t_out_burn([t_batch(#"b1", 400_000_000, t_epoch - 1, t_fund_id)], [], 1)
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// TẤN CÔNG: tiêu quá số dư batch.
test pp_burn_over() fail {
  let din = t_vd([], [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let dout = t_out_burn([], [], 1)
  run_burn(
    din,
    [(#"b1", 2_000_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// TẤN CÔNG: không ký.
test pp_burn_no_auth() fail {
  let din = t_vd([], [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let dout = t_out_burn([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], [], 1)
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_stranger]),
  )
}

// TẤN CÔNG: giả mạo did_commit khi tiêu (phá attribution DID).
test pp_burn_did_forged() fail {
  let din = t_vd([], [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let base = t_out_burn([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], [], 1)
  let dout = PrepaidVaultDatum { ..base, did_commit: #"cafe" }
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// TẤN CÔNG: tiêu mà không ghi sự kiện attribution.
test pp_burn_no_attribution() fail {
  let din = t_vd([], [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let dout = t_out_burn([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], [], 0)
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// TẤN CÔNG: nhân tiện "tiêu" thì cộng thêm hạn-mức cho mình.
test pp_burn_mints_credit() fail {
  let din = t_vd([t_credit(t_fund_id, 10)], [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let dout =
    t_out_burn(
      [t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)],
      [t_credit(t_fund_id, 999_999_999)],
      1,
    )
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// TẤN CÔNG: hai output vault (tách trạng thái).
test pp_burn_two_vault_outputs() fail {
  let din = t_vd([], [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let dout = t_out_burn([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], [], 1)
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout), t_vault_out(dout)], [t_owner]),
  )
}

// ══════════════════════════════════════════════════════════════
// PrunePrepaid
// ══════════════════════════════════════════════════════════════

fn run_prune(datum: PrepaidVaultDatum, tx: Transaction) -> Bool {
  validate_prune(datum, t_epoch, t_vault_addr(), t_carp_policy, t_carp_name, tx)
}

// happy: batch chết bị bỏ, hạn-mức được trả lại, KHÔNG cần chữ ký.
test pp_prune_ok() {
  let din =
    t_vd(
      [t_credit(t_fund_id, 0)],
      [
        t_batch(#"b1", 1_000_000_000, t_epoch - 1, t_fund_id),
        t_batch(#"b2", 500_000_000, t_epoch, t_fund_id),
      ],
    )
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [t_credit(t_fund_id, 1_000_000_000)],
      magic_batches: [t_batch(#"b2", 500_000_000, t_epoch, t_fund_id)],
      last_updated_epoch: t_epoch,
    }
  run_prune(din, t_tx([t_vault_in(din)], [t_vault_out(dout)], []))
}

// TẤN CÔNG: dọn khi không có gì chết (noop bơm last_updated_epoch).
test pp_prune_noop() fail {
  let din = t_vd([t_credit(t_fund_id, 0)], [t_batch(#"b1", 500_000_000, t_epoch, t_fund_id)])
  let dout = PrepaidVaultDatum { ..din, last_updated_epoch: t_epoch }
  run_prune(din, t_tx([t_vault_in(din)], [t_vault_out(dout)], []))
}

// TẤN CÔNG: nhân lúc dọn thì xoá luôn batch CÒN SỐNG của người khác.
test pp_prune_drops_live() fail {
  let din =
    t_vd(
      [t_credit(t_fund_id, 0)],
      [
        t_batch(#"b1", 1_000_000_000, t_epoch - 1, t_fund_id),
        t_batch(#"b2", 500_000_000, t_epoch, t_fund_id),
      ],
    )
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [t_credit(t_fund_id, 1_000_000)],
      magic_batches: [],
      last_updated_epoch: t_epoch,
    }
  run_prune(din, t_tx([t_vault_in(din)], [t_vault_out(dout)], []))
}

// TẤN CÔNG: trả lại hạn-mức NHIỀU HƠN par của MAGIC đã chết.
test pp_prune_overpay_credit() fail {
  let din =
    t_vd([t_credit(t_fund_id, 0)], [t_batch(#"b1", 1_000_000_000, t_epoch - 1, t_fund_id)])
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [t_credit(t_fund_id, 999_000_000)],
      magic_batches: [],
      last_updated_epoch: t_epoch,
    }
  run_prune(din, t_tx([t_vault_in(din)], [t_vault_out(dout)], []))
}

// ══════════════════════════════════════════════════════════════
// SetDelegate
// ══════════════════════════════════════════════════════════════

fn run_setdel(
  datum : PrepaidVaultDatum,
  nd    : Option<ByteArray>,
  tx    : Transaction,
) -> Bool {
  validate_set_delegate(
    datum, nd, t_epoch, t_vault_addr(), t_carp_policy, t_carp_name, tx,
  )
}

test pp_setdelegate_ok() {
  let din = t_vd([t_credit(t_fund_id, 10)], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      personal_delegate: Some(t_delegate),
      last_updated_epoch: t_epoch,
    }
  run_setdel(din, Some(t_delegate), t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
}

// TẤN CÔNG: delegate tự uỷ quyền tiếp cho mình.
test pp_setdelegate_by_delegate() fail {
  let base = t_vd([], [])
  let din = PrepaidVaultDatum { ..base, personal_delegate: Some(t_delegate) }
  let dout =
    PrepaidVaultDatum {
      ..din,
      personal_delegate: Some(t_stranger),
      last_updated_epoch: t_epoch,
    }
  run_setdel(din, Some(t_stranger), t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_delegate]))
}

// TẤN CÔNG: đổi delegate kèm bơm hạn-mức.
test pp_setdelegate_mints_credit() fail {
  let din = t_vd([t_credit(t_fund_id, 10)], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [t_credit(t_fund_id, 10_000_000)],
      personal_delegate: Some(t_delegate),
      last_updated_epoch: t_epoch,
    }
  run_setdel(din, Some(t_delegate), t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
}

// ══════════════════════════════════════════════════════════════
// Quỹ Paid — FundLock / FundSettle / FundClaim
// ══════════════════════════════════════════════════════════════

fn run_fund(
  fin      : PaidFundDatum,
  fin_carp : Int,
  tx       : Transaction,
  redeemer : PaidFundRedeemer,
) -> Bool {
  fund_common_checks(
    fin, t_fund_in(fin, fin_carp), t_fund_addr(), t_carp_policy, t_carp_name,
    t_fund_policy, t_epoch, redeemer, tx,
  )
}

// ── FundLock ──────────────────────────────────────────────────

test pp_fund_lock_ok() {
  let vd = t_vd([], [])
  let fin = t_fd(0, 0, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let tx =
    t_tx_rd(
      [t_vault_in(vd), t_fund_in(fin, 0)],
      [t_vault_out(vd), t_fund_out(fout, lock_amt)],
      [t_platform],
      PrepaidLock { fund_id: t_fund_id, amount_carpdrop: lock_amt },
    )
  run_fund(fin, 0, tx, FundLock)
}

// TẤN CÔNG: quỹ bị tiêu bằng FundLock nhưng vault đi kèm chạy redeemer KHÁC
// (BurnBatch) → không có ai kiểm delta hạn-mức.
test pp_fund_lock_wrong_vault_redeemer() fail {
  let vd = t_vd([], [])
  let fin = t_fd(0, 0, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let tx =
    t_tx_rd(
      [t_vault_in(vd), t_fund_in(fin, 0)],
      [t_vault_out(vd), t_fund_out(fout, lock_amt)],
      [t_platform],
      BurnBatch { burns: [] },
    )
  run_fund(fin, 0, tx, FundLock)
}

// TẤN CÔNG: FundLock nhưng rút bớt CARP ra.
test pp_fund_lock_drains_carp() fail {
  let vd = t_vd([], [])
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(0, lock_amt, 0, 0, 1_500)
  let tx =
    t_tx_rd(
      [t_vault_in(vd), t_fund_in(fin, lock_amt)],
      [t_vault_out(vd), t_fund_out(fout, 0)],
      [t_platform],
      PrepaidLock { fund_id: t_fund_id, amount_carpdrop: lock_amt },
    )
  run_fund(fin, lock_amt, tx, FundLock)
}

// ── FundSettle ────────────────────────────────────────────────

fn settle_tx(
  vin_batches  : List<MagicBatch>,
  vout_batches : List<MagicBatch>,
  fin          : PaidFundDatum,
  fin_carp     : Int,
  fout         : PaidFundDatum,
  fout_carp    : Int,
  vault_r      : PrepaidVaultRedeemer,
) -> Transaction {
  let vin_d = t_vd([], vin_batches)
  let vout_d = t_vd([], vout_batches)
  t_tx_rd(
    [t_vault_in(vin_d), t_fund_in(fin, fin_carp)],
    [t_vault_out(vout_d), t_fund_out(fout, fout_carp)],
    [t_platform],
    vault_r,
  )
}

// happy: 0.6 MAGIC bị tiêu thật → magic_settled += 600_000_000.
test pp_fund_settle_ok() {
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500)
  let tx =
    settle_tx(
      [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)],
      [t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)],
      fin, lock_amt, fout, lock_amt,
      BurnBatch { burns: [(#"b1", 600_000_000)] },
    )
  run_fund(fin, lock_amt, tx, FundSettle)
}

// TẤN CÔNG cốt lõi: tính MAGIC HẾT HẠN thành "đã tiêu" (phá INV-MAGIC-CITIZEN).
// Batch của epoch trước biến mất khỏi output nhưng KHÔNG được tính.
test pp_fund_settle_counts_expired() fail {
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 1_000_000_000, 0, 1_500)
  let tx =
    settle_tx(
      [t_batch(#"b1", 1_000_000_000, t_epoch - 1, t_fund_id)],
      [],
      fin, lock_amt, fout, lock_amt,
      BurnBatch { burns: [] },
    )
  run_fund(fin, lock_amt, tx, FundSettle)
}

// TẤN CÔNG: quyết toán MAGIC của quỹ KHÁC.
test pp_fund_settle_other_fund_batch() fail {
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500)
  let tx =
    settle_tx(
      [t_batch(#"b1", 1_000_000_000, t_epoch, t_other_fund)],
      [t_batch(#"b1", 400_000_000, t_epoch, t_other_fund)],
      fin, lock_amt, fout, lock_amt,
      BurnBatch { burns: [(#"b1", 600_000_000)] },
    )
  run_fund(fin, lock_amt, tx, FundSettle)
}

// TẤN CÔNG: khai settled cao hơn lượng thật sự giảm.
test pp_fund_settle_inflated() fail {
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 900_000_000, 0, 1_500)
  let tx =
    settle_tx(
      [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)],
      [t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)],
      fin, lock_amt, fout, lock_amt,
      BurnBatch { burns: [(#"b1", 600_000_000)] },
    )
  run_fund(fin, lock_amt, tx, FundSettle)
}

// TẤN CÔNG: quyết toán trong khi vault chạy PrunePrepaid (constr 3) —
// hết hạn KHÔNG phải tiêu thật.
test pp_fund_settle_under_prune() fail {
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500)
  let tx =
    settle_tx(
      [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)],
      [t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)],
      fin, lock_amt, fout, lock_amt,
      PrunePrepaid,
    )
  run_fund(fin, lock_amt, tx, FundSettle)
}

// TẤN CÔNG: "vault" giả ở script khác (đúng cái mà khuôn shard.ak để hở).
test pp_fund_settle_fake_vault() fail {
  let vin_d = t_vd([], [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let vout_d = t_vd([], [t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)])
  let evil = address.from_script(t_evil_hash)
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500)
  let rd: Data = BurnBatch { burns: [(#"b1", 600_000_000)] }
  let tx =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output_reference: t_own_ref(),
          output: Output {
            address: evil,
            value: assets.from_lovelace(2_000_000),
            datum: InlineDatum(vin_d),
            reference_script: None,
          },
        },
        t_fund_in(fin, lock_amt),
      ],
      outputs: [
        Output {
          address: evil,
          value: assets.from_lovelace(2_000_000),
          datum: InlineDatum(vout_d),
          reference_script: None,
        },
        t_fund_out(fout, lock_amt),
      ],
      extra_signatories: [t_platform],
      redeemers: [Pair(Spend(t_own_ref()), rd)],
    }
  run_fund(fin, lock_amt, tx, FundSettle)
}

// TẤN CÔNG: mượn FundSettle để rút CARP.
test pp_fund_settle_drains_carp() fail {
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(0, lock_amt, 600_000_000, 0, 1_500)
  let tx =
    settle_tx(
      [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)],
      [t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)],
      fin, lock_amt, fout, 0,
      BurnBatch { burns: [(#"b1", 600_000_000)] },
    )
  run_fund(fin, lock_amt, tx, FundSettle)
}

// ── FundClaim ─────────────────────────────────────────────────

fn claim_tx(
  fin       : PaidFundDatum,
  fin_carp  : Int,
  fout      : PaidFundDatum,
  fout_carp : Int,
  signers   : List<ByteArray>,
) -> Transaction {
  t_tx([t_fund_in(fin, fin_carp)], [t_fund_out(fout, fout_carp)], signers)
}

// happy: quỹ đã tiêu hết → provider rút toàn bộ (outstanding = 0 ⇒ đệm = 0).
test pp_fund_claim_full_ok() {
  let fin = t_fd(1_000_000_000, 1_000_000_000, 1_000_000_000, 0, 1_500)
  let fout = t_fd(0, 1_000_000_000, 1_000_000_000, 1_000_000_000, 1_500)
  run_fund(
    fin, 1_000_000_000,
    claim_tx(fin, 1_000_000_000, fout, 0, [t_platform]),
    FundClaim { amount_carpdrop: 1_000_000_000 },
  )
}

// happy: mới tiêu một nửa → rút tối đa 425_000_000 (giữ đệm 15% trên 500_000_000).
test pp_fund_claim_partial_ok() {
  let fin = t_fd(1_000_000_000, 1_000_000_000, 500_000_000, 0, 1_500)
  let fout = t_fd(575_000_000, 1_000_000_000, 500_000_000, 425_000_000, 1_500)
  run_fund(
    fin, 1_000_000_000,
    claim_tx(fin, 1_000_000_000, fout, 575_000_000, [t_platform]),
    FundClaim { amount_carpdrop: 425_000_000 },
  )
}

// TẤN CÔNG: rút thêm 1 đơn vị nữa → phá sàn đệm buffer-Paid.
test pp_fund_claim_breaks_buffer() fail {
  let fin = t_fd(1_000_000_000, 1_000_000_000, 500_000_000, 0, 1_500)
  let fout = t_fd(574_999_999, 1_000_000_000, 500_000_000, 425_000_001, 1_500)
  run_fund(
    fin, 1_000_000_000,
    claim_tx(fin, 1_000_000_000, fout, 574_999_999, [t_platform]),
    FundClaim { amount_carpdrop: 425_000_001 },
  )
}

// TẤN CÔNG: rút quá phần MAGIC đã tiêu thật (F2), đệm để 0 để cô lập luật này.
test pp_fund_claim_over_settled() fail {
  let fin = t_fd(1_000_000_000, 1_000_000_000, 500_000_000, 0, 0)
  let fout = t_fd(400_000_000, 1_000_000_000, 500_000_000, 600_000_000, 0)
  run_fund(
    fin, 1_000_000_000,
    claim_tx(fin, 1_000_000_000, fout, 400_000_000, [t_platform]),
    FundClaim { amount_carpdrop: 600_000_000 },
  )
}

// TẤN CÔNG: kẻ lạ rút quỹ (khoá platform không có).
test pp_fund_claim_no_platform_sig() fail {
  let fin = t_fd(1_000_000_000, 1_000_000_000, 1_000_000_000, 0, 1_500)
  let fout = t_fd(0, 1_000_000_000, 1_000_000_000, 1_000_000_000, 1_500)
  run_fund(
    fin, 1_000_000_000,
    claim_tx(fin, 1_000_000_000, fout, 0, [t_stranger]),
    FundClaim { amount_carpdrop: 1_000_000_000 },
  )
}

// TẤN CÔNG: rút CARP mà không ghi provider_claimed (phá C-PP-3).
test pp_fund_claim_unrecorded() fail {
  let fin = t_fd(1_000_000_000, 1_000_000_000, 1_000_000_000, 0, 1_500)
  let fout = t_fd(0, 1_000_000_000, 1_000_000_000, 0, 1_500)
  run_fund(
    fin, 1_000_000_000,
    claim_tx(fin, 1_000_000_000, fout, 0, [t_platform]),
    FundClaim { amount_carpdrop: 1_000_000_000 },
  )
}

// TẤN CÔNG: hạ buffer_bps để mở đường rút (tham số bất biến).
test pp_fund_buffer_lowered() fail {
  let fin = t_fd(1_000_000_000, 1_000_000_000, 500_000_000, 0, 1_500)
  let fout = t_fd(500_000_000, 1_000_000_000, 500_000_000, 500_000_000, 0)
  run_fund(
    fin, 1_000_000_000,
    claim_tx(fin, 1_000_000_000, fout, 500_000_000, [t_platform]),
    FundClaim { amount_carpdrop: 500_000_000 },
  )
}

// TẤN CÔNG: đổi platform (chiếm quyền đòi của quỹ).
test pp_fund_platform_changed() fail {
  let fin = t_fd(1_000_000_000, 1_000_000_000, 1_000_000_000, 0, 1_500)
  let base = t_fd(0, 1_000_000_000, 1_000_000_000, 1_000_000_000, 1_500)
  let fout = PaidFundDatum { ..base, platform: t_stranger }
  run_fund(
    fin, 1_000_000_000,
    claim_tx(fin, 1_000_000_000, fout, 0, [t_platform]),
    FundClaim { amount_carpdrop: 1_000_000_000 },
  )
}

// TẤN CÔNG: đổi vault_hash để sau này quyết toán bằng vault giả.
test pp_fund_vault_hash_changed() fail {
  let fin = t_fd(1_000_000_000, 1_000_000_000, 1_000_000_000, 0, 1_500)
  let base = t_fd(0, 1_000_000_000, 1_000_000_000, 1_000_000_000, 1_500)
  let fout = PaidFundDatum { ..base, vault_hash: t_evil_hash }
  run_fund(
    fin, 1_000_000_000,
    claim_tx(fin, 1_000_000_000, fout, 0, [t_platform]),
    FundClaim { amount_carpdrop: 1_000_000_000 },
  )
}

// TẤN CÔNG: mang NFT quỹ (và trạng thái quỹ) ra khỏi địa chỉ quỹ.
test pp_fund_nft_escapes() fail {
  let fin = t_fd(1_000_000_000, 1_000_000_000, 1_000_000_000, 0, 1_500)
  let fout = t_fd(0, 1_000_000_000, 1_000_000_000, 1_000_000_000, 1_500)
  let evil = address.from_script(t_evil_hash)
  let tx =
    t_tx([t_fund_in(fin, 1_000_000_000)], [t_fund_out_at(fout, 0, evil)], [t_platform])
  run_fund(fin, 1_000_000_000, tx, FundClaim { amount_carpdrop: 1_000_000_000 })
}

// TẤN CÔNG: datum quỹ khai một đằng, CARP trong UTxO một nẻo.
test pp_fund_value_mismatch() fail {
  let fin = t_fd(1_000_000_000, 1_000_000_000, 1_000_000_000, 0, 1_500)
  let fout = t_fd(0, 1_000_000_000, 1_000_000_000, 1_000_000_000, 1_500)
  run_fund(
    fin, 1_000_000_000,
    claim_tx(fin, 1_000_000_000, fout, 900_000_000, [t_platform]),
    FundClaim { amount_carpdrop: 1_000_000_000 },
  )
}

// ══════════════════════════════════════════════════════════════
// get_epoch — SEC-02 (C-PP-11)
// ══════════════════════════════════════════════════════════════

const ms_ep: Int = 86_400_000   // Preview/Preprod

fn tx_range(lo: Int, hi: Int) -> Transaction {
  Transaction { ..placeholder, validity_range: interval.between(lo, hi) }
}

test pp_epoch_ok() {
  get_epoch(tx_range(7 * ms_ep + 10, 7 * ms_ep + 20), ms_ep) == 7
}

// TẤN CÔNG: khoảng hiệu lực trải qua hai epoch → current_epoch nhập nhằng.
test pp_epoch_straddle() fail {
  get_epoch(tx_range(7 * ms_ep - 5, 7 * ms_ep + 5), ms_ep) == 7
}

// TẤN CÔNG: biên trên vô hạn (mẫu tấn công cổ điển của SEC-02).
test pp_epoch_open_upper() fail {
  let tx =
    Transaction { ..placeholder, validity_range: interval.after(7 * ms_ep) }
  get_epoch(tx, ms_ep) == 7
}
