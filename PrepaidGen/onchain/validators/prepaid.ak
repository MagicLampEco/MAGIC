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
// `PaidFundDatum.vault_hash` ghim tại genesis bởi handler `mint` của paid_fund và
// bất biến sau đó. Nhờ vậy quỹ vẫn ghim được vault thật khi quyết toán — khác
// khuôn shard.ak của ScheduleGen (shard chấp nhận bất kỳ input nào giải mã ra
// VaultDatum, được ở đó vì shard KHÔNG có thẩm quyền; bê nguyên sang đây là mở
// đường cho vault giả bơm magic_settled rồi rút CARP).
//
// MỘT THAM SỐ, KHÔNG PHẢI HAI (đổi 2026-09-15). Trước bản này, NFT định danh quỹ
// là một script riêng (`fund_nft.ak`), nên `fund_nft_policy` và `paid_fund_hash`
// là HAI apply-param độc lập — dựng được một bộ bytes mà hai giá trị LỆCH nhau,
// đúng lớp lỗi mà `BOUNDARIES.md §5` gọi là bài học đắt nhất của kho (danh sách
// apply-param lệch chữ ký validator: không test nào đỏ, không compile nào gãy).
// Nay handler `mint` của NFT quỹ nằm trong CHÍNH `paid_fund`, nên
// `fund_nft_policy == paid_fund_hash` theo định nghĩa: một giá trị thì không lệch
// được. Mọi chỗ cần "policy NFT quỹ" suy thẳng từ `paid_fund_hash`.
//
// Và đó không chỉ là dọn tham số — nó là thứ vá được lỗ genesis. Một policy đứng
// riêng KHÔNG kiểm được địa chỉ output mang NFT (sẽ thành vòng fund_nft →
// paid_fund → prepaid_vault → fund_nft), nên NFT quỹ đúc sạch ra được một ví
// thường; tiêu ví đó bằng chữ ký thường KHÔNG chạy validator nào, và người tiêu
// tự đặt một `PaidFundDatum` bịa ở địa chỉ quỹ. Gộp vào `paid_fund` thì
// `policy_id` CHÍNH LÀ script hash của quỹ, nên câu "carrier phải nằm ở
// `Script(policy_id)`" tự trỏ vào mình — cùng khuôn `validate_mint_vault_id` dưới
// đây và `validate_mint_engage_id` của ConsumeMAGIC.

use aiken/builtin
use aiken/cbor
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto
use aiken/interval.{Finite, IntervalBoundType}
use aiken/primitive/bytearray
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Spend, Transaction,
  placeholder,
}

use magiclamp/protocol/types.{
  BurnBatch, FundClaim, FundLock, FundSettle, MagicBatch, MintVaultId,
  PaidFundDatum, PaidFundRedeemer, PrepaidCredit, PrepaidDraw, PrepaidLock,
  PrepaidVaultDatum, PrepaidVaultIdRedeemer, PrepaidVaultRedeemer, PrunePrepaid,
  SetDelegate, VaultAttribution,
}
use magiclamp/protocol/constants.{
  batch_source_prepaid, max_batches_per_vault, max_prepaid_credits,
  min_buffer_bps, min_draw_carpdrop, min_lock_carpdrop, prepaid_decay_window,
  prepaid_profile,
}
use magiclamp/protocol/math.{
  buffer_floor, compute_batch_id, compute_fund_id, outstanding_of,
  par_carp_from_magic, par_magic_from_carp,
}

// Constructor index của các nhánh redeemer — dùng khi đọc redeemer của script
// KHÁC qua builtin.un_constr_data (không ghép kiểu chéo validator).
const rd_prepaid_lock: Int = 0
const rd_burn_batch: Int = 2   // §7.3/§11 — ConsumeMAGIC ghim burn_batch_constr = 2

// ══════════════════════════════════════════════════════════════
// prepaid_vault
// ══════════════════════════════════════════════════════════════
// `ms_per_epoch`: Mainnet 432_000_000 · Preview/Preprod 86_400_000.
//
// INV-VAULT-IDENTITY (BOUNDARIES.md §2) — vì sao validator này vừa là policy đúc
// vừa là script tiêu:
//
// Cardano KHÔNG chạy validator lúc TẠO một UTxO. Nên nếu vault chỉ có nhánh
// `spend`, datum ĐẦU TIÊN của một vault là thứ người tạo tự soạn, không cổng nào
// vét. Kẻ tấn công đọc `fund_id` công khai của một quỹ thật, tự gửi một UTxO tới
// địa chỉ script này với `prepaid_credits = [{fund_id: <quỹ thật>, remaining:
// khổng lồ}]` mà KHÔNG khoá một đồng CARP nào, rồi `PrepaidDraw` — `validate_draw`
// không có input quỹ nào để đối chiếu, nó đọc đúng cái datum vừa được bịa. MAGIC
// sinh từ hư không, và ConsumeMAGIC nhận diện vault chỉ bằng script hash nên UTxO
// giả đi lọt tầng trên.
//
// Chốt chặn duy nhất đặt được vào đúng khoảnh khắc đó là MINT: handler `mint` dưới
// đây đúc một NFT one-shot và ép cả bộ datum về trạng thái genesis sạch, còn MỌI
// nhánh spend đòi NFT ấy còn nguyên trên output tiếp nối. Vault không NFT = chưa
// từng có policy nào vét datum của nó ⇒ không nhánh nào tiêu được.
//
// Policy id của NFT == script hash của chính validator này (tự tham chiếu, không
// tham số) — gộp mint vào vault là cách phá vòng `vault_hash = H(…, policy)` ⇄
// `policy = H(…, vault_hash)`; tách thành hai script sẽ thành điểm bất động
// blake2b, không bao giờ instantiate được.
validator prepaid_vault(
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  paid_fund_hash  : ByteArray,
  ms_per_epoch    : Int,
) {
  // ── mint: policy NFT định danh vault (policy_id == script hash này) ──────
  mint(redeemer: PrepaidVaultIdRedeemer, policy_id: PolicyId, tx: Transaction) {
    let MintVaultId { seed } = redeemer
    validate_mint_vault_id(seed, policy_id, tx)
  }

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

    // INV-VAULT-IDENTITY — ĐIỂM NGHẼN DUY NHẤT, ép cho CẢ NĂM nhánh redeemer.
    // Cố ý đặt ở thân handler chứ không chép vào từng `validate_*`: chép năm bản
    // là năm chỗ có thể sót một, mà sót thì không gì đỏ. Một bản ở đây thì gỡ nó
    // ra là cả năm bài `pp_*_nft_stripped` cùng chuyển sang xanh — phép đột biến
    // đó ghim được toàn bộ năm nhánh chỉ bằng một lần chạy.
    expect
      vault_identity_preserved(
        own_input(own_ref, tx.inputs),
        find_vault_output_raw(tx.outputs, vault_addr),
      )

    when redeemer is {
      PrepaidLock { fund_id, amount_carpdrop } ->
        validate_lock(
          datum, fund_id, amount_carpdrop, current_epoch, vault_addr,
          carp_policy_id, carp_asset_name, paid_fund_hash, tx,
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
// paid_fund — sổ quỹ (spend) VÀ policy của NFT định danh quỹ (mint)
// ══════════════════════════════════════════════════════════════
// Hai handler trong MỘT script là điều kiện cần để cổng genesis nói được câu
// "NFT này phải nằm ở địa chỉ quỹ": `policy_id` của handler `mint` bằng đúng
// script hash của handler `spend`, nên `Script(policy_id)` CHÍNH LÀ địa chỉ quỹ.
// Xem khối đầu tệp, mục "MỘT THAM SỐ, KHÔNG PHẢI HAI".
validator paid_fund(
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  ms_per_epoch    : Int,
) {
  // ── mint: policy NFT định danh quỹ (policy_id == script hash này) ────────
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    validate_mint_fund_nft(policy_id, tx)
  }

  spend(
    datum_opt : Option<PaidFundDatum>,
    redeemer  : PaidFundRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(fund_in) = datum_opt
    let current_epoch = get_epoch(tx, ms_per_epoch)
    let fund_addr = own_addr(own_ref, tx.inputs)

    // Policy NFT quỹ == script hash của chính validator này. KHÔNG còn là
    // apply-param: hai tham số song song thì lệch được, một giá trị suy ra thì
    // không.
    let fund_nft_policy = script_hash_of(fund_addr)

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
  paid_fund_hash  : ByteArray,
  tx              : Transaction,
) -> Bool {
  // C-PP-12
  expect amount >= min_lock_carpdrop

  // Policy NFT quỹ == script hash quỹ (mint gộp vào `paid_fund`).
  let fund_nft_policy = paid_fund_hash

  // Quỹ phải ở ĐÚNG địa chỉ paid_fund và mang NFT one-shot đúng tên fund_id.
  // Đây là thứ bảo vệ người khoá khỏi "quỹ giả" do kẻ tấn công dựng.
  let fund_in_utxo =
    find_fund_utxo_at(
      list.map(tx.inputs, fn(i) { i.output }), paid_fund_hash, fund_id,
    )
  let fund_out_utxo = find_fund_utxo_at(tx.outputs, paid_fund_hash, fund_id)
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

  // ĐÂY LÀ CHỖ GIỮ `outstanding >= 0`, và nó phải nằm ở CHỖ GHI chứ không phải
  // ở `outstanding_of`/`buffer_floor`.
  //
  // `outstanding_of(credit_issued, magic_settled) = credit_issued −
  // par_carp_from_magic(magic_settled)`, và `buffer_floor` nhân nó với một hệ số
  // dương. Cả hai KHÔNG kẹp sàn 0 — cố ý. `outstanding < 0` kéo `buffer_floor <
  // 0`, và mọi phép so `carp_locked >= buffer_floor` ở `validate_fund_claim`
  // thành vô điều kiện ⇒ rút sạch quỹ. Kẹp `max(0, …)` trong hai hàm đó là bịt
  // TRIỆU CHỨNG: nó biến một trạng thái bất khả thi thành một trạng thái trông
  // bình thường, không ai kêu, và bản off-chain (P8) phải kẹp theo nếu không thì
  // hai bên lệch bit.
  //
  // Quy nạp, ba vế, không vế nào ngoài module này:
  //   · genesis — `validate_mint_fund_nft` ép `credit_issued = magic_settled = 0`;
  //   · `magic_settled` CHỈ tăng ở nhánh này, và dòng dưới đây là trần của nó;
  //   · `credit_issued` chỉ tăng (FundLock) hoặc đứng yên (FundSettle/FundClaim
  //     đều ép `fund_out.credit_issued == fund_in.credit_issued`).
  // ⇒ `par_carp_from_magic(magic_settled) <= credit_issued` là bất biến, tức
  // `outstanding >= 0` ở mọi UTxO quỹ tiêu được. Bài canh: `pp_fund_settle_over_issued`.
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
// VAULT — genesis NFT định danh + cổng bảo toàn (INV-VAULT-IDENTITY)
// ══════════════════════════════════════════════════════════════

// Tên tài sản NFT định danh = blake2b_256(cbor.serialise(seed)).
//
// ĐÂY LÀ CÔNG THỨC CỦA `BOUNDARIES.md §2`, KHÁC công thức `compute_fund_id`
// (`blake2b_256(tx_hash ∥ be8(idx))`) mà `fund_nft.ak` dùng cho NFT quỹ. Hai công
// thức khác nhau nằm cạnh nhau trong cùng module là chuyện có chủ ý, không phải sơ
// suất: NFT vault phải khớp bất biến toàn kho (ScheduleGen/InstantGen đã theo), NFT
// quỹ đã ghim công thức của nó trước đó. Chép nhầm bên này sang bên kia thì off-chain
// dựng ra một tên không đúc được, và lỗi chỉ lộ ra lúc submit.
fn vault_id_name(seed: OutputReference) -> ByteArray {
  crypto.blake2b_256(cbor.serialise(seed))
}

// Đúng MỘT tên tài sản dưới `policy` trong `value`, số lượng đúng 1 — trả về tên đó.
// Một vault bịa (không mang NFT nào của policy này) chết ngay tại đây.
//
// Dùng khuôn một-phần-tử `expect [Pair(name, qty)]` chứ không `dict.size(...) == 1`:
// `size == 1` chỉ nói "đúng MỘT TÊN", không nói "đúng MỘT token" — số lượng nằm ở
// GIÁ TRỊ của cặp, nên hai đơn vị cùng tên đi lọt trọn vẹn.
fn single_nft_name(value: Value, policy: PolicyId) -> ByteArray {
  expect [Pair(name, qty)] = assets.tokens(value, policy) |> dict.to_pairs
  expect qty == 1
  name
}

// Cổng bảo toàn dùng chung cho MỌI nhánh spend:
//   - NFT định danh: input bị tiêu phải mang ĐÚNG một token dưới policy = script
//     hash đọc từ chính payment credential của nó, và output tiếp nối phải mang
//     lại ĐÚNG cặp (policy, name) đó — CHỈ cặp đó, không tên thứ hai dưới cùng
//     policy. Vault bịa (không NFT) chết ở `single_nft_name`.
//
//     Hai đầu đều đi qua `single_nft_name` chứ không phải `quantity_of(...) == 1`:
//     `quantity_of` trả lời "có đúng NFT đó", nó KHÔNG trả lời "chỉ có NFT đó".
//     Chênh lệch giữa hai câu là một tên thứ hai dưới chính policy vault; cổng
//     `|policies| <= 2` bên dưới đếm POLICY nên không thấy nó. Nguồn sinh ra tên
//     thứ hai đã được liệt kê đóng và không tới được (handler `mint` ép
//     `dict.size(tx.mint tại policy này) == 1`), nên đây là phòng-thủ-chiều-sâu,
//     không phải vá một lỗ đang mở — nhưng nó rẻ đúng bằng một lời gọi hàm.
//   - lovelace(out) ≥ lovelace(in): không ai rút bớt ADA tối thiểu của vault
//     (nạp thêm thì được).
//   - |policies(out)| ≤ 2: nhiều nhất {ADA, NFT vault}. Vault PrepaidGen không bao
//     giờ giữ CARP (C-PP-14 — mọi nhánh đã ép `vault_output_carp == 0`), nên một
//     policy thứ ba chỉ có thể là bụi token nhét vào cho phình datum/value.
fn vault_identity_preserved(vault_input: Input, vault_output: Output) -> Bool {
  expect Script(vault_id_policy) = vault_input.output.address.payment_credential
  let nft_name = single_nft_name(vault_input.output.value, vault_id_policy)
  expect single_nft_name(vault_output.value, vault_id_policy) == nft_name
  expect
    assets.lovelace_of(vault_output.value) >= assets.lovelace_of(
      vault_input.output.value,
    )
  expect list.length(assets.policies(vault_output.value)) <= 2
  True
}

// validate_mint_vault_id — genesis SẠCH, chạy ở đúng khoảnh khắc duy nhất mà một
// policy nói được câu "vault này bắt đầu từ số không".
//
// Ghim ĐỦ bộ "cần gạt" mà một datum bịa sẽ bịa. Thiếu một cần gạt là để nguyên lỗ:
// `prepaid_credits` bịa ra hạn-mức chưa mua, `magic_batches` bịa thẳng MAGIC,
// `attribution.total_events` bịa lịch sử tiêu, `next_batch_index` bịa chỉ số batch.
fn validate_mint_vault_id(
  seed      : OutputReference,
  policy_id : PolicyId,
  tx        : Transaction,
) -> Bool {
  // ── ONE-SHOT: đúng UTxO seed phải bị TIÊU trong chính giao dịch này ──────
  // Một UTxO tiêu được tối đa một lần ⇒ tên tài sản không bao giờ lặp, và không
  // ai đúc lại được tên của một vault đã tồn tại.
  expect list.any(tx.inputs, fn(i) { i.output_reference == seed })

  // ── Đúng MỘT tên dưới policy này, số lượng +1, tên = H(seed) ─────────────
  // Cặp ràng buộc này cũng là thứ đóng luôn đường ĐỐT: mọi giao dịch có số lượng
  // âm dưới policy này đều chết ở đây.
  let own_tokens = assets.tokens(tx.mint, policy_id)
  expect dict.size(own_tokens) == 1
  let nft_name = vault_id_name(seed)
  expect assets.quantity_of(tx.mint, policy_id, nft_name) == 1

  // ── Đúng MỘT output tại chính script vault này, và nó mang NFT ───────────
  // policy_id == script hash của chính validator ⇒ `Script(policy_id)` là địa chỉ
  // tiêu của vault. Ràng ở đây chặn mẫu "đúc sạch rồi dời sang chỗ khác".
  let carriers =
    list.filter(
      tx.outputs,
      fn(o) {
        o.address.payment_credential == Script(policy_id) && assets.quantity_of(
          o.value,
          policy_id,
          nft_name,
        ) == 1
      },
    )
  expect [vault_out] = carriers

  // ── CHỈ NFT đó dưới policy vault, không tên thứ hai ──────────────────────
  // Xem lý do ở chú thích của `vault_identity_preserved`: bộ lọc `carriers` bên
  // trên dùng `quantity_of` nên nó không loại được một tên thứ hai đi kèm.
  expect single_nft_name(vault_out.value, policy_id) == nft_name

  // ── Địa chỉ vault phải CHÍNH TẮC: không stake credential ─────────────────
  // `Script(h)` và `(Script(h), stake=người lạ)` là HAI địa chỉ khác nhau nhưng
  // cùng chạy validator này, nên không ghim thì mỗi vault đỗ được ở một địa chỉ
  // riêng và không còn "địa chỉ vault" nào để `utxosAt` quét. Ghim None không
  // đóng cơ chế nào: không dòng nào trong module đọc stake credential, và mọi
  // phép so địa chỉ ở nhánh spend là so ĐẦY ĐỦ (`o.address == vault_addr`) nên
  // một vault có stake vẫn tiêu được — nó chỉ vô hình với người đi tìm.
  expect vault_out.address.stake_credential == None

  // ── Không gắn sẵn reference script ───────────────────────────────────────
  // Ref-script đội min-ADA của UTxO lên, mà `vault_identity_preserved` chỉ cho
  // lovelace ĐI LÊN và không nhánh nào rút ADA ra khỏi vault ⇒ phần ADA ấy khoá
  // vĩnh viễn. Đây là khoá-vốn im lặng, không phải lỗi giao dịch.
  expect vault_out.reference_script == None

  // ── Datum genesis phải là inline và giải mã ra PrepaidVaultDatum ─────────
  expect InlineDatum(datum_data) = vault_out.datum
  expect vd: PrepaidVaultDatum = datum_data

  // ── GENESIS SẠCH ────────────────────────────────────────────────────────
  // owner: một pkh mà người tạo thật sự điều khiển. Không có vế này thì bất kỳ ai
  // cũng dựng được vault mang tên người khác (mọi nhánh spend sau đó đọc `owner`
  // làm quyền).
  expect list.has(tx.extra_signatories, vd.owner)

  expect vd.prepaid_credits == []
  expect vd.magic_batches == []
  expect vd.next_batch_index == 0
  expect vd.personal_delegate == None
  expect vd.last_updated_epoch == 0
  expect vd.attribution == VaultAttribution {
    attribution_root: #"",
    last_event_epoch: 0,
    total_events: 0,
  }

  // `did_commit` KHÔNG bị ghim về rỗng — §7.5 nói nó được ĐẶT MỘT LẦN LÚC TẠO
  // VAULT rồi bất biến, mà "lúc tạo vault" chính là giao dịch này. Ghim về rỗng ở
  // đây là đóng vĩnh viễn đường đặt nó, vì không nhánh spend nào đổi được. Nó cũng
  // không phải cần gạt giá trị: không nhánh nào đọc `did_commit` để cấp quyền hay
  // tính tiền. Khoảng hở còn lại là hở TÍNH XÁC THỰC (ai cũng khai được cam kết DID
  // của người khác) — đóng nó cần một sổ DID đọc qua reference input, nằm ngoài
  // phạm vi module này. Xem mục "chỗ còn mơ hồ" trong báo cáo.

  // ── Không bụi token, không CARP trong vault genesis: nhiều nhất {ADA, NFT} ─
  expect list.length(assets.policies(vault_out.value)) <= 2

  True
}

// ══════════════════════════════════════════════════════════════
// FUND — genesis NFT định danh quỹ (C-PP-15)
// ══════════════════════════════════════════════════════════════
//
// MỘT policy dùng chung cho MỌI quỹ (không tham số hoá theo seed): nếu mỗi quỹ
// một policy thì `paid_fund_hash` của prepaid_vault lại thành per-quỹ, tức mỗi
// platform một script vault riêng — đúng cái phép thử apply-param ở
// `BOUNDARIES.md §2` loại bỏ ("giá trị này đổi theo cái gì?": đổi theo từng lần
// tạo ⟹ KHÔNG).
//
// Tính duy nhất đến từ INPUT BỊ TIÊU chứ không từ tham số biên dịch:
//   asset_name = blake2b_256(tx_hash ∥ be8(output_index)) của một input trong
//   chính giao dịch đúc. UTxO tiêu được tối đa một lần ⇒ tên không bao giờ lặp,
//   không ai đúc lại được tên cũ.
//
// Đồng thời đây là CỔNG GENESIS của sổ quỹ: datum của output mang NFT phải sạch
// (mọi số cộng dồn = 0) và buffer_bps ≥ 15%. Không có cổng này thì một quỹ có
// thể "sinh ra" với magic_settled khổng lồ, kéo `outstanding` âm, kéo
// `buffer_floor` âm, và mọi phép so `≥ buffer_floor` thành vô điều kiện ⇒
// FundClaim rút sạch CARP của người khác.
//
// VÌ SAO NÓ PHẢI Ở TRONG `paid_fund` CHỨ KHÔNG PHẢI MỘT SCRIPT RIÊNG: chỉ ở đây
// mới ép được ĐỊA CHỈ của output mang NFT. Bản trước (`validators/fund_nft.ak`,
// đã xoá 2026-09-15) lọc carrier CHỈ bằng `quantity_of(...) == 1` và tự ghi
// trong chú thích rằng không kiểm được địa chỉ vì sẽ thành vòng tham chiếu. Vòng
// đó không có thật — phá bằng đúng khuôn tự-trỏ-vào-mình mà kho đã dùng hai lần
// (`validate_mint_vault_id` ở ngay trên, `validate_mint_engage_id` bên
// ConsumeMAGIC). Đường khai thác mà nó để hở, ba bước:
//   1. đúc NFT quỹ vào một output VÍ THƯỜNG, datum sạch → cổng cũ cho qua;
//   2. tiêu output ví đó bằng chữ ký thường — KHÔNG validator nào chạy (đây là
//      minting policy, giao dịch 2 không mint) — rồi tạo output ở địa chỉ quỹ
//      với datum bịa `magic_settled` khổng lồ;
//   3. người dùng khoá CARP vào quỹ đó; `FundClaim` rút sạch.
fn validate_mint_fund_nft(policy_id: PolicyId, tx: Transaction) -> Bool {
  // ── Đúng MỘT tên tài sản dưới policy này, số lượng đúng 1 ────────────────
  // Cặp ràng buộc này cũng đóng luôn đường ĐỐT: mọi số lượng âm chết tại đây.
  expect [Pair(name, qty)] = assets.tokens(tx.mint, policy_id) |> dict.to_pairs
  expect qty == 1

  // ── ONE-SHOT: tên phải bắt nguồn từ một input BỊ TIÊU trong chính tx này ─
  expect
    list.any(
      tx.inputs,
      fn(i) {
        compute_fund_id(
          i.output_reference.transaction_id,
          i.output_reference.output_index,
        ) == name
      },
    )

  // ── Đúng MỘT output mang NFT, VÀ nó phải nằm ở địa chỉ quỹ ───────────────
  // `policy_id == script hash của chính validator này` ⇒ `Script(policy_id)` là
  // địa chỉ tiêu của quỹ. Đây là mệnh đề mà bản tách-script không viết được.
  let carriers =
    list.filter(
      tx.outputs,
      fn(o) {
        o.address.payment_credential == Script(policy_id) && assets.quantity_of(
          o.value,
          policy_id,
          name,
        ) == 1
      },
    )
  expect [fund_utxo] = carriers

  // Cùng ba cổng hình-dạng-địa-chỉ với genesis vault, cùng lý do — xem
  // `validate_mint_vault_id`. Ba dòng này ở đây là bản đối chứng của ba dòng ở
  // đó: hai cổng genesis cạnh nhau mà một bên lỏng hơn thì bên lỏng là bên sai.
  expect single_nft_name(fund_utxo.value, policy_id) == name
  expect fund_utxo.address.stake_credential == None
  expect fund_utxo.reference_script == None

  // ── Sổ quỹ genesis SẠCH ─────────────────────────────────────────────────
  let fd = decode_fund(fund_utxo)
  expect fd.fund_id == name
  expect fd.carp_locked == 0
  expect fd.credit_issued == 0
  expect fd.magic_settled == 0
  expect fd.provider_claimed == 0
  expect fd.last_updated_epoch == 0
  expect fd.buffer_bps >= min_buffer_bps
  expect bytearray.length(fd.platform) == 28
  expect bytearray.length(fd.vault_hash) == 28
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
  outs           : List<Output>,
  paid_fund_hash : ByteArray,
  fund_id        : ByteArray,
) -> Output {
  let matches =
    list.filter(
      outs,
      fn(o) {
        is_at_script(o.address, paid_fund_hash) && assets.quantity_of(
          o.value,
          paid_fund_hash,
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
// `carp_asset_name` thật là một BĂM 28 byte do nhà CarpetMint phát (xem
// `offchain/src/constants.ts` §"Cấu hình mạng: CARP", đo 2026-09-11) — KHÔNG
// phải hex của ticker "CARP". Fixture giữ đúng HÌNH DẠNG đó mà không chép giá
// trị thật vào đây: một bản chép trong tệp kiểm sẽ chết im lặng khi nhà
// CarpetMint đổi số. Bản trước ghi #"43415250" (4 byte, hex ASCII "CARP") nên
// mọi bài kiểm chạy trên một hình dạng không tồn tại trên chuỗi.
const t_carp_name: ByteArray = #"5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a"
// Policy của NFT quỹ KHÔNG còn là một hằng riêng. Handler `mint` nằm trong chính
// `paid_fund`, nên policy id BẰNG script hash quỹ theo định nghĩa. Giữ hai hằng
// khác nhau trong bộ kiểm là dựng ra một thế giới không tồn tại trên chuỗi, và
// mọi bài chạy trên thế giới đó sẽ xanh vì lý do sai.
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

// Seed của NFT định danh vault trong fixture. Tên tài sản được TÍNH bằng chính
// `vault_id_name` chứ không chép một hằng băm vào đây: một bản chép sẽ chết im
// lặng nếu công thức đổi, mà bài kiểm vẫn xanh.
const t_seed_tx: ByteArray =
  #"7777777777777777777777777777777777777777777777777777777777777777"

fn t_seed_ref() -> OutputReference {
  OutputReference { transaction_id: t_seed_tx, output_index: 3 }
}

fn t_vault_nft() -> ByteArray {
  vault_id_name(t_seed_ref())
}

// Vault THẬT: mang NFT định danh (policy = script hash của vault).
fn t_vault_out_v(datum: PrepaidVaultDatum, carp: Int) -> Output {
  Output {
    address: t_vault_addr(),
    value: assets.from_lovelace(2_000_000)
      |> assets.add(t_carp_policy, t_carp_name, carp)
      |> assets.add(t_vault_hash, t_vault_nft(), 1),
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

// Vault BỊA: cùng địa chỉ script, KHÔNG mang NFT — đúng hình dạng mà kẻ tấn công
// tự gửi tới địa chỉ script (Cardano không chạy validator lúc tạo UTxO).
fn t_vault_out_no_nft(datum: PrepaidVaultDatum) -> Output {
  Output {
    address: t_vault_addr(),
    value: assets.from_lovelace(2_000_000),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn t_vault_in_no_nft(datum: PrepaidVaultDatum) -> Input {
  Input { output_reference: t_own_ref(), output: t_vault_out_no_nft(datum) }
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
    |> assets.add(t_fund_hash, nft_name, 1)
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
    t_carp_name, t_fund_hash, tx,
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
    t_fund_hash, tx,
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
    t_fund_hash, t_epoch, redeemer, tx,
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

// ── FundSettle: trần của `magic_settled` (giữ outstanding ≥ 0) ─
//
// Bài canh cho dòng `par_carp_from_magic(fund_out.magic_settled) <=
// fund_out.credit_issued` trong `validate_fund_settle`. Gỡ dòng đó ra thì bài
// này chuyển sang xanh — và với nó là đường: `outstanding` âm ⇒ `buffer_floor`
// âm ⇒ mọi phép so `carp_locked >= buffer_floor` ở `validate_fund_claim` thành
// vô điều kiện ⇒ rút sạch CARP của người khác.
test pp_fund_settle_over_issued() fail {
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 1_500_000_000, 0, 1_500)
  let tx =
    settle_tx(
      [t_batch(#"b1", 1_500_000_000, t_epoch, t_fund_id)],
      [],
      fin, lock_amt, fout, lock_amt,
      BurnBatch { burns: [(#"b1", 1_500_000_000)] },
    )
  run_fund(fin, lock_amt, tx, FundSettle)
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

// ══════════════════════════════════════════════════════════════
// INV-VAULT-IDENTITY — genesis (mint) + chốt chặn ở MỌI nhánh spend
// ══════════════════════════════════════════════════════════════
//
// Lỗ được vá ở đây: Cardano KHÔNG chạy validator lúc TẠO một UTxO, nên trước bản
// này datum đầu tiên của vault do người tạo tự soạn. Bài `pp_mint_credits_forged`
// dựng đúng kịch bản đó — hạn-mức khổng lồ trỏ vào một quỹ THẬT, không khoá một
// đồng CARP nào — và nó phải bị nhánh mint từ chối.
//
// Mỗi nhánh spend có BA bài, cố ý đi thành bộ để mỗi bài âm tính phân biệt được
// hai bên đột biến:
//   `_ok`            — cùng giao dịch đó, vault mang NFT → PHẢI qua. Đây là thứ
//                      chứng minh bài âm tính bên dưới chỉ chết vì NFT chứ không
//                      vì một cổng khác của nhánh.
//   `_forged_vault`  — input KHÔNG mang NFT (vault bịa, chưa policy nào vét datum).
//   `_nft_escapes`   — input mang NFT nhưng output tiếp nối thì không.
//
// Gỡ lời gọi `vault_identity_preserved` ở thân `spend` ⟹ toàn bộ nhóm bài âm
// tính này chuyển sang xanh cùng lúc. SỐ ĐO nằm ở MỘT nơi — `DESIGN.md §2.1` —
// và cố ý không chép xuống đây: một con số chép ở hai chỗ thì chỗ chép chết im
// lặng ngay lần thêm bài kế tiếp (bản trước của dòng này ghi "MƯỜI", `DESIGN.md`
// ghi "12", đo thật ra 12; nay là 13).

// ── Fixtures genesis ──────────────────────────────────────────

fn t_seed_input(ref: OutputReference) -> Input {
  Input {
    output_reference: ref,
    output: Output {
      address: address.from_script(t_owner),
      value: assets.from_lovelace(5_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

// Datum genesis SẠCH: mọi cần gạt ở trạng thái khởi tạo.
fn t_genesis_vd() -> PrepaidVaultDatum {
  PrepaidVaultDatum {
    owner: t_owner,
    did_commit: t_did,
    prepaid_credits: [],
    magic_batches: [],
    next_batch_index: 0,
    personal_delegate: None,
    last_updated_epoch: 0,
    attribution: VaultAttribution {
      attribution_root: #"",
      last_event_epoch: 0,
      total_events: 0,
    },
  }
}

fn t_genesis_out_v(vd: PrepaidVaultDatum, name: ByteArray, carp: Int) -> Output {
  Output {
    address: t_vault_addr(),
    value: assets.from_lovelace(2_000_000)
      |> assets.add(t_vault_hash, name, 1)
      |> assets.add(t_carp_policy, t_carp_name, carp),
    datum: InlineDatum(vd),
    reference_script: None,
  }
}

fn t_genesis_out(vd: PrepaidVaultDatum, name: ByteArray) -> Output {
  t_genesis_out_v(vd, name, 0)
}

fn t_mint_tx(
  ins     : List<Input>,
  outs    : List<Output>,
  m       : Value,
  signers : List<ByteArray>,
) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: ins,
    outputs: outs,
    mint: m,
    extra_signatories: signers,
  }
}

fn run_mint(seed: OutputReference, tx: Transaction) -> Bool {
  prepaid_vault.mint(
    t_carp_policy, t_carp_name, t_fund_hash, ms_ep,
    MintVaultId { seed }, t_vault_hash, tx,
  )
}

// Giao dịch đúc chuẩn, chỉ khác nhau ở datum genesis.
fn mint_tx_with(vd: PrepaidVaultDatum) -> Transaction {
  let name = t_vault_nft()
  t_mint_tx(
    [t_seed_input(t_seed_ref())],
    [t_genesis_out(vd, name)],
    assets.from_asset(t_vault_hash, name, 1),
    [t_owner],
  )
}

// happy: tiêu seed → tên duy nhất, datum sạch, owner ký.
test pp_mint_genesis_ok() {
  run_mint(t_seed_ref(), mint_tx_with(t_genesis_vd()))
}

// TẤN CÔNG CỐT LÕI: vault sinh ra đã mang hạn-mức khổng lồ trỏ vào một quỹ THẬT,
// không khoá đồng CARP nào. Đây chính là bước 2 của kịch bản khai thác —
// `validate_draw` sau đó không có input quỹ nào để đối chiếu.
test pp_mint_credits_forged() fail {
  let vd =
    PrepaidVaultDatum {
      ..t_genesis_vd(),
      prepaid_credits: [t_credit(t_fund_id, 1_000_000_000_000_000)],
    }
  run_mint(t_seed_ref(), mint_tx_with(vd))
}

// TẤN CÔNG: bỏ qua cả bước rút, bịa thẳng MagicBatch → MAGIC từ hư không.
test pp_mint_batches_forged() fail {
  let vd =
    PrepaidVaultDatum {
      ..t_genesis_vd(),
      magic_batches: [t_batch(#"b1", 1_000_000_000_000_000, t_epoch, t_fund_id)],
    }
  run_mint(t_seed_ref(), mint_tx_with(vd))
}

// TẤN CÔNG: dựng vault mang tên người khác (mọi nhánh spend đọc `owner` làm quyền).
test pp_mint_no_owner_sig() fail {
  let name = t_vault_nft()
  let tx =
    t_mint_tx(
      [t_seed_input(t_seed_ref())],
      [t_genesis_out(t_genesis_vd(), name)],
      assets.from_asset(t_vault_hash, name, 1),
      [t_stranger],
    )
  run_mint(t_seed_ref(), tx)
}

// TẤN CÔNG: bịa chỉ số batch kế tiếp (đẩy batch_id ra khỏi dãy dẫn xuất).
test pp_mint_next_index_forged() fail {
  let vd = PrepaidVaultDatum { ..t_genesis_vd(), next_batch_index: 9 }
  run_mint(t_seed_ref(), mint_tx_with(vd))
}

// TẤN CÔNG: bịa lịch sử quy kết (BurnBatch chỉ ép total_events + 1, không ép gốc).
test pp_mint_attribution_forged() fail {
  let vd =
    PrepaidVaultDatum {
      ..t_genesis_vd(),
      attribution: VaultAttribution {
        attribution_root: #"cafe",
        last_event_epoch: t_epoch,
        total_events: 42,
      },
    }
  run_mint(t_seed_ref(), mint_tx_with(vd))
}

// TẤN CÔNG: cài sẵn delegate lúc tạo (đường uỷ quyền phải đi qua SetDelegate,
// nhánh duy nhất đòi CHÍNH owner ký).
test pp_mint_delegate_preset() fail {
  let vd =
    PrepaidVaultDatum { ..t_genesis_vd(), personal_delegate: Some(t_delegate) }
  run_mint(t_seed_ref(), mint_tx_with(vd))
}

// TẤN CÔNG: bơm last_updated_epoch lúc tạo.
test pp_mint_epoch_forged() fail {
  let vd = PrepaidVaultDatum { ..t_genesis_vd(), last_updated_epoch: t_epoch }
  run_mint(t_seed_ref(), mint_tx_with(vd))
}

// TẤN CÔNG: seed không bị tiêu → tính one-shot vỡ, đúc lại được tên cũ.
test pp_mint_seed_not_spent() fail {
  let name = t_vault_nft()
  let tx =
    t_mint_tx(
      [t_seed_input(OutputReference { transaction_id: t_seed_tx, output_index: 99 })],
      [t_genesis_out(t_genesis_vd(), name)],
      assets.from_asset(t_vault_hash, name, 1),
      [t_owner],
    )
  run_mint(t_seed_ref(), tx)
}

// TẤN CÔNG: tên tài sản không dẫn xuất từ seed → đặt tên tuỳ ý, đụng tên vault khác.
test pp_mint_forged_name() fail {
  let name = #"ffff000000000000000000000000000000000000000000000000000000000000"
  let tx =
    t_mint_tx(
      [t_seed_input(t_seed_ref())],
      [t_genesis_out(t_genesis_vd(), name)],
      assets.from_asset(t_vault_hash, name, 1),
      [t_owner],
    )
  run_mint(t_seed_ref(), tx)
}

// TẤN CÔNG: đúc 2 bản cùng tên → định danh vault tách đôi, hai UTxO cùng "là" vault.
test pp_mint_qty_two() fail {
  let name = t_vault_nft()
  let out =
    Output {
      address: t_vault_addr(),
      value: assets.from_lovelace(2_000_000) |> assets.add(t_vault_hash, name, 2),
      datum: InlineDatum(t_genesis_vd()),
      reference_script: None,
    }
  let tx =
    t_mint_tx(
      [t_seed_input(t_seed_ref())],
      [out],
      assets.from_asset(t_vault_hash, name, 2),
      [t_owner],
    )
  run_mint(t_seed_ref(), tx)
}

// TẤN CÔNG: kèm một tên lạ dưới cùng policy (vault thứ hai không qua cổng genesis).
test pp_mint_extra_name() fail {
  let name = t_vault_nft()
  let m =
    assets.from_asset(t_vault_hash, name, 1)
      |> assets.add(t_vault_hash, #"6666", 1)
  let tx =
    t_mint_tx(
      [t_seed_input(t_seed_ref())],
      [t_genesis_out(t_genesis_vd(), name)],
      m,
      [t_owner],
    )
  run_mint(t_seed_ref(), tx)
}

// TẤN CÔNG: "đúc sạch rồi dời đi" — NFT ra một địa chỉ khác, vault thật để lại
// datum không ai vét. Cổng carriers đòi output mang NFT nằm ĐÚNG script vault.
test pp_mint_nft_parked_elsewhere() fail {
  let name = t_vault_nft()
  let out =
    Output {
      address: address.from_script(t_evil_hash),
      value: assets.from_lovelace(2_000_000) |> assets.add(t_vault_hash, name, 1),
      datum: InlineDatum(t_genesis_vd()),
      reference_script: None,
    }
  let tx =
    t_mint_tx(
      [t_seed_input(t_seed_ref())],
      [out],
      assets.from_asset(t_vault_hash, name, 1),
      [t_owner],
    )
  run_mint(t_seed_ref(), tx)
}

// TẤN CÔNG: datum không inline → không cổng nào đọc được trạng thái genesis.
test pp_mint_no_inline_datum() fail {
  let name = t_vault_nft()
  let out =
    Output {
      address: t_vault_addr(),
      value: assets.from_lovelace(2_000_000) |> assets.add(t_vault_hash, name, 1),
      datum: NoDatum,
      reference_script: None,
    }
  let tx =
    t_mint_tx(
      [t_seed_input(t_seed_ref())],
      [out],
      assets.from_asset(t_vault_hash, name, 1),
      [t_owner],
    )
  run_mint(t_seed_ref(), tx)
}

// TẤN CÔNG: nhét CARP (policy thứ ba) vào vault genesis — vault PrepaidGen không
// bao giờ giữ CARP, mọi nhánh spend sau đó sẽ kẹt ở `vault_output_carp == 0`.
test pp_mint_carp_stuffed() fail {
  let name = t_vault_nft()
  let tx =
    t_mint_tx(
      [t_seed_input(t_seed_ref())],
      [t_genesis_out_v(t_genesis_vd(), name, 1_000_000_000)],
      assets.from_asset(t_vault_hash, name, 1),
      [t_owner],
    )
  run_mint(t_seed_ref(), tx)
}

// ── Chốt chặn ở thân `spend`: chạy QUA handler, không gọi validate_* trực tiếp ──

fn branch_tx(
  vin       : Input,
  vout      : Output,
  more_ins  : List<Input>,
  more_outs : List<Output>,
  signers   : List<ByteArray>,
) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: list.concat([vin], more_ins),
    outputs: list.concat([vout], more_outs),
    extra_signatories: signers,
    validity_range: interval.between(t_epoch * ms_ep + 10, t_epoch * ms_ep + 20),
  }
}

fn run_spend(
  datum    : PrepaidVaultDatum,
  redeemer : PrepaidVaultRedeemer,
  tx       : Transaction,
) -> Bool {
  prepaid_vault.spend(
    t_carp_policy, t_carp_name, t_fund_hash, ms_ep,
    Some(datum), redeemer, t_own_ref(), tx,
  )
}

// ── Nhánh 1/5 — PrepaidLock ───────────────────────────────────

fn sp_lock_din() -> PrepaidVaultDatum {
  t_vd([], [])
}

fn sp_lock_dout() -> PrepaidVaultDatum {
  PrepaidVaultDatum {
    ..sp_lock_din(),
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
}

fn sp_lock_tx(vin: Input, vout: Output) -> Transaction {
  branch_tx(
    vin, vout,
    [t_fund_in(t_fd(0, 0, 0, 0, 1_500), 0)],
    [t_fund_out(t_fd(lock_amt, lock_amt, 0, 0, 1_500), lock_amt)],
    [t_platform],
  )
}

fn sp_lock_run(vin: Input, vout: Output) -> Bool {
  run_spend(
    sp_lock_din(),
    PrepaidLock { fund_id: t_fund_id, amount_carpdrop: lock_amt },
    sp_lock_tx(vin, vout),
  )
}

test pp_spend_lock_ok() {
  sp_lock_run(t_vault_in(sp_lock_din()), t_vault_out(sp_lock_dout()))
}

test pp_spend_lock_forged_vault() fail {
  sp_lock_run(
    t_vault_in_no_nft(sp_lock_din()), t_vault_out_no_nft(sp_lock_dout()),
  )
}

test pp_spend_lock_nft_escapes() fail {
  sp_lock_run(t_vault_in(sp_lock_din()), t_vault_out_no_nft(sp_lock_dout()))
}

// ── Nhánh 2/5 — PrepaidDraw ───────────────────────────────────

fn sp_draw_din() -> PrepaidVaultDatum {
  t_vd([t_credit(t_fund_id, 5_000_000_000)], [])
}

fn sp_draw_dout() -> PrepaidVaultDatum {
  PrepaidVaultDatum {
    ..sp_draw_din(),
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
}

fn sp_draw_run(vin: Input, vout: Output) -> Bool {
  run_spend(
    sp_draw_din(),
    PrepaidDraw { fund_id: t_fund_id, amount_carpdrop: draw_amt },
    branch_tx(vin, vout, [], [], [t_owner]),
  )
}

test pp_spend_draw_ok() {
  sp_draw_run(t_vault_in(sp_draw_din()), t_vault_out(sp_draw_dout()))
}

// TẤN CÔNG CỐT LÕI (bước 3 của kịch bản): tiêu chính UTxO bịa bằng PrepaidDraw.
test pp_spend_draw_forged_vault() fail {
  sp_draw_run(
    t_vault_in_no_nft(sp_draw_din()), t_vault_out_no_nft(sp_draw_dout()),
  )
}

test pp_spend_draw_nft_escapes() fail {
  sp_draw_run(t_vault_in(sp_draw_din()), t_vault_out_no_nft(sp_draw_dout()))
}

// ── Nhánh 3/5 — BurnBatch ─────────────────────────────────────

fn sp_burn_din() -> PrepaidVaultDatum {
  t_vd([], [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
}

fn sp_burn_dout() -> PrepaidVaultDatum {
  t_out_burn([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], [], 1)
}

fn sp_burn_run(vin: Input, vout: Output) -> Bool {
  run_spend(
    sp_burn_din(),
    BurnBatch { burns: [(#"b1", 600_000_000)] },
    branch_tx(vin, vout, [], [], [t_owner]),
  )
}

test pp_spend_burn_ok() {
  sp_burn_run(t_vault_in(sp_burn_din()), t_vault_out(sp_burn_dout()))
}

test pp_spend_burn_forged_vault() fail {
  sp_burn_run(
    t_vault_in_no_nft(sp_burn_din()), t_vault_out_no_nft(sp_burn_dout()),
  )
}

test pp_spend_burn_nft_escapes() fail {
  sp_burn_run(t_vault_in(sp_burn_din()), t_vault_out_no_nft(sp_burn_dout()))
}

// ── Nhánh 4/5 — PrunePrepaid (permissionless: KHÔNG chữ ký) ────

fn sp_prune_din() -> PrepaidVaultDatum {
  t_vd(
    [t_credit(t_fund_id, 0)],
    [t_batch(#"b1", 1_000_000_000, t_epoch - 1, t_fund_id)],
  )
}

fn sp_prune_dout() -> PrepaidVaultDatum {
  PrepaidVaultDatum {
    ..sp_prune_din(),
    prepaid_credits: [t_credit(t_fund_id, 1_000_000_000)],
    magic_batches: [],
    last_updated_epoch: t_epoch,
  }
}

fn sp_prune_run(vin: Input, vout: Output) -> Bool {
  run_spend(sp_prune_din(), PrunePrepaid, branch_tx(vin, vout, [], [], []))
}

test pp_spend_prune_ok() {
  sp_prune_run(t_vault_in(sp_prune_din()), t_vault_out(sp_prune_dout()))
}

// Nhánh permissionless là nhánh dễ sót nhất: nó không có cổng chữ ký nào che.
test pp_spend_prune_forged_vault() fail {
  sp_prune_run(
    t_vault_in_no_nft(sp_prune_din()), t_vault_out_no_nft(sp_prune_dout()),
  )
}

test pp_spend_prune_nft_escapes() fail {
  sp_prune_run(t_vault_in(sp_prune_din()), t_vault_out_no_nft(sp_prune_dout()))
}

// ── Nhánh 5/5 — SetDelegate ───────────────────────────────────

fn sp_setdel_din() -> PrepaidVaultDatum {
  t_vd([t_credit(t_fund_id, 10)], [])
}

fn sp_setdel_dout() -> PrepaidVaultDatum {
  PrepaidVaultDatum {
    ..sp_setdel_din(),
    personal_delegate: Some(t_delegate),
    last_updated_epoch: t_epoch,
  }
}

fn sp_setdel_run(vin: Input, vout: Output) -> Bool {
  run_spend(
    sp_setdel_din(),
    SetDelegate { new_delegate: Some(t_delegate) },
    branch_tx(vin, vout, [], [], [t_owner]),
  )
}

test pp_spend_setdelegate_ok() {
  sp_setdel_run(t_vault_in(sp_setdel_din()), t_vault_out(sp_setdel_dout()))
}

test pp_spend_setdelegate_forged_vault() fail {
  sp_setdel_run(
    t_vault_in_no_nft(sp_setdel_din()), t_vault_out_no_nft(sp_setdel_dout()),
  )
}

test pp_spend_setdelegate_nft_escapes() fail {
  sp_setdel_run(t_vault_in(sp_setdel_din()), t_vault_out_no_nft(sp_setdel_dout()))
}

// ── Hai cổng còn lại của `vault_identity_preserved` ────────────

// TẤN CÔNG: rút bớt ADA tối thiểu của vault ra ví mình mỗi lần dọn rác.
test pp_spend_lovelace_siphoned() fail {
  let vout =
    Output {
      address: t_vault_addr(),
      value: assets.from_lovelace(1_000_000)
        |> assets.add(t_vault_hash, t_vault_nft(), 1),
      datum: InlineDatum(sp_prune_dout()),
      reference_script: None,
    }
  sp_prune_run(t_vault_in(sp_prune_din()), vout)
}

// TẤN CÔNG: nhét bụi token vào output tiếp nối (policy thứ ba) để phình value.
test pp_spend_dust_stuffed() fail {
  let vout =
    Output {
      address: t_vault_addr(),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_vault_hash, t_vault_nft(), 1)
        |> assets.add(t_evil_hash, #"6666", 1),
      datum: InlineDatum(sp_prune_dout()),
      reference_script: None,
    }
  sp_prune_run(t_vault_in(sp_prune_din()), vout)
}

// TẤN CÔNG: vault mang HAI đơn vị NFT định danh, cả vào lẫn ra.
//
// Bài này canh `expect qty == 1` trong `single_nft_name`, và nó phải dựng CẢ HAI
// đầu cùng mang 2 đơn vị — nếu chỉ một đầu thì phép so tên/số lượng ở đầu kia
// giết nó trước, và bài đo mất khả năng phân biệt hai bên đột biến. Hai đơn vị
// cùng tên nghĩa là hai UTxO tách ra sau này đều "là" vault, mỗi cái mang một
// bản datum — đúng thứ mà `list.count(... == vault_addr) == 1` không bắt được vì
// nó đếm ĐỊA CHỈ chứ không đếm định danh.
test pp_spend_nft_qty_two() fail {
  let nft = t_vault_nft()
  let vin =
    Input {
      output_reference: t_own_ref(),
      output: Output {
        address: t_vault_addr(),
        value: assets.from_lovelace(2_000_000) |> assets.add(t_vault_hash, nft, 2),
        datum: InlineDatum(sp_prune_din()),
        reference_script: None,
      },
    }
  let vout =
    Output {
      address: t_vault_addr(),
      value: assets.from_lovelace(2_000_000) |> assets.add(t_vault_hash, nft, 2),
      datum: InlineDatum(sp_prune_dout()),
      reference_script: None,
    }
  sp_prune_run(vin, vout)
}

// ── Genesis vault: ba cổng hình dạng output ───────────────────

// TẤN CÔNG: vault đỗ ở (script vault, stake của người lạ) — cùng validator,
// KHÁC địa chỉ ⇒ biến mất khỏi mọi `utxosAt(vaultAddress)`.
test pp_mint_stake_credential_set() fail {
  let name = t_vault_nft()
  let out =
    Output {
      ..t_genesis_out(t_genesis_vd(), name),
      address: t_vault_addr() |> address.with_delegation_key(t_stranger),
    }
  run_mint(
    t_seed_ref(),
    t_mint_tx(
      [t_seed_input(t_seed_ref())], [out],
      assets.from_asset(t_vault_hash, name, 1), [t_owner],
    ),
  )
}

// TẤN CÔNG: gắn sẵn reference script vào vault genesis → min-ADA đội lên và khoá
// vĩnh viễn (lovelace chỉ được phép ĐI LÊN, không nhánh nào rút ADA).
test pp_mint_reference_script_attached() fail {
  let name = t_vault_nft()
  let out =
    Output {
      ..t_genesis_out(t_genesis_vd(), name),
      reference_script: Some(t_evil_hash),
    }
  run_mint(
    t_seed_ref(),
    t_mint_tx(
      [t_seed_input(t_seed_ref())], [out],
      assets.from_asset(t_vault_hash, name, 1), [t_owner],
    ),
  )
}

// TẤN CÔNG: carrier mang thêm một TÊN thứ hai dưới chính policy vault. Cổng
// `|policies| <= 2` đếm POLICY nên nó không thấy; chỉ `single_nft_name` thấy.
test pp_mint_second_name_on_carrier() fail {
  let name = t_vault_nft()
  let out =
    Output {
      ..t_genesis_out(t_genesis_vd(), name),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_vault_hash, name, 1)
        |> assets.add(t_vault_hash, #"6666", 1),
    }
  run_mint(
    t_seed_ref(),
    t_mint_tx(
      [t_seed_input(t_seed_ref())], [out],
      assets.from_asset(t_vault_hash, name, 1), [t_owner],
    ),
  )
}

// TẤN CÔNG: ĐỐT NFT định danh vault (số lượng âm trong tx.mint).
//
// Bài canh cho `expect assets.quantity_of(tx.mint, policy_id, nft_name) == 1` —
// mệnh đề mà `types.ak` viện dẫn khi khai rằng redeemer này KHÔNG có nhánh đốt.
// Mọi thứ còn lại của giao dịch được dựng HỢP LỆ (seed bị tiêu, carrier đúng chỗ,
// datum sạch, chủ ký) để bài chết đúng ở dòng mang tên nó và để phép gỡ-chốt đo
// được: gỡ dòng ấy ra thì bài này chuyển sang xanh, tức đường đốt mở ra.
test pp_mint_burn_rejected() fail {
  let name = t_vault_nft()
  run_mint(
    t_seed_ref(),
    t_mint_tx(
      [t_seed_input(t_seed_ref())],
      [t_genesis_out(t_genesis_vd(), name)],
      assets.from_asset(t_vault_hash, name, -1),
      [t_owner],
    ),
  )
}

// ══════════════════════════════════════════════════════════════
// C-PP-15 — genesis quỹ (handler `mint` của `paid_fund`)
// ══════════════════════════════════════════════════════════════
//
// Bộ này CHUYỂN TỪ `validators/fund_nft.ak` (đã xoá 2026-09-15) sang đây, và
// `fn_addr()` của bản cũ — một địa chỉ VÍ — đã được đổi thành địa chỉ SCRIPT của
// quỹ. Ghi lại vì nó là bài học, không phải một lần dời tệp: bản cũ đặt NFT quỹ
// vào ví ở MỌI bài kể cả bài happy, nên bài happy xanh CHÍNH LÀ bằng chứng cổng
// cho phép NFT quỹ rơi vào ví — bộ kiểm mù đúng ở chỗ nó phải nhìn.

fn fg_wallet_addr() -> Address {
  Address { payment_credential: VerificationKey(t_platform), stake_credential: None }
}

// Seed: một UTxO ví thường bị tiêu trong chính giao dịch đúc.
fn fg_seed_input() -> Input {
  Input {
    output_reference: t_fund_ref(),
    output: Output {
      address: fg_wallet_addr(),
      value: assets.from_lovelace(5_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

// Tên NFT quỹ được TÍNH bằng chính `compute_fund_id`, không chép hằng băm.
fn fg_name() -> ByteArray {
  compute_fund_id(t_fund_tx, 0)
}

fn fg_datum(
  fund_id : ByteArray,
  locked  : Int,
  issued  : Int,
  settled : Int,
  claimed : Int,
  buffer  : Int,
  epoch   : Int,
) -> PaidFundDatum {
  PaidFundDatum {
    fund_id,
    platform: t_platform,
    vault_hash: t_vault_hash,
    carp_locked: locked,
    credit_issued: issued,
    magic_settled: settled,
    provider_claimed: claimed,
    buffer_bps: buffer,
    last_updated_epoch: epoch,
  }
}

fn fg_clean() -> PaidFundDatum {
  fg_datum(fg_name(), 0, 0, 0, 0, 1_500, 0)
}

fn fg_carrier_at(name: ByteArray, d: PaidFundDatum, qty: Int, addr: Address) -> Output {
  Output {
    address: addr,
    value: assets.from_lovelace(2_000_000) |> assets.add(t_fund_hash, name, qty),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

fn fg_carrier(name: ByteArray, d: PaidFundDatum) -> Output {
  fg_carrier_at(name, d, 1, t_fund_addr())
}

fn run_fund_mint(outs: List<Output>, m: Value) -> Bool {
  paid_fund.mint(
    t_carp_policy, t_carp_name, ms_ep,
    Void, t_fund_hash,
    Transaction { ..placeholder, inputs: [fg_seed_input()], outputs: outs, mint: m },
  )
}

// Giao dịch đúc chuẩn, chỉ khác nhau ở datum quỹ.
fn fg_mint_with(d: PaidFundDatum) -> Bool {
  let name = fg_name()
  run_fund_mint([fg_carrier(name, d)], assets.from_asset(t_fund_hash, name, 1))
}

// happy: tiêu seed → tên duy nhất, sổ quỹ sạch, đệm ≥ 15%, NFT ở ĐÚNG địa chỉ quỹ.
test fg_mint_ok() {
  fg_mint_with(fg_clean())
}

// TẤN CÔNG CỐT LÕI (bước 1 của kịch bản ba bước): đúc NFT quỹ vào một VÍ THƯỜNG.
//
// Bản `fund_nft.ak` cũ cho qua vì nó lọc carrier chỉ bằng `quantity_of == 1`.
// Sau đó tiêu output ví ấy bằng chữ ký thường — KHÔNG validator nào chạy — rồi
// đỗ một `PaidFundDatum` bịa ở địa chỉ quỹ. Đây là bài canh cho mệnh đề
// `o.address.payment_credential == Script(policy_id)`.
test fg_mint_nft_to_wallet() fail {
  let name = fg_name()
  run_fund_mint(
    [fg_carrier_at(name, fg_clean(), 1, fg_wallet_addr())],
    assets.from_asset(t_fund_hash, name, 1),
  )
}

// TẤN CÔNG: đúc vào một SCRIPT khác (biến thể của bài trên — địa chỉ phải là
// đúng script quỹ, không phải "một script nào đó").
test fg_mint_nft_to_other_script() fail {
  let name = fg_name()
  run_fund_mint(
    [fg_carrier_at(name, fg_clean(), 1, address.from_script(t_evil_hash))],
    assets.from_asset(t_fund_hash, name, 1),
  )
}

// TẤN CÔNG: quỹ đỗ ở (script quỹ, stake người lạ) → vô hình với `utxosAt`.
test fg_mint_stake_credential_set() fail {
  let name = fg_name()
  run_fund_mint(
    [
      fg_carrier_at(
        name, fg_clean(), 1,
        t_fund_addr() |> address.with_delegation_key(t_stranger),
      ),
    ],
    assets.from_asset(t_fund_hash, name, 1),
  )
}

// TẤN CÔNG: gắn reference script vào quỹ genesis.
test fg_mint_reference_script_attached() fail {
  let name = fg_name()
  let out =
    Output { ..fg_carrier(name, fg_clean()), reference_script: Some(t_evil_hash) }
  run_fund_mint([out], assets.from_asset(t_fund_hash, name, 1))
}

// TẤN CÔNG: carrier mang thêm một tên thứ hai dưới chính policy quỹ.
test fg_mint_second_name_on_carrier() fail {
  let name = fg_name()
  let out =
    Output {
      ..fg_carrier(name, fg_clean()),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_fund_hash, name, 1)
        |> assets.add(t_fund_hash, #"6666", 1),
    }
  run_fund_mint([out], assets.from_asset(t_fund_hash, name, 1))
}

// TẤN CÔNG: tên không bắt nguồn từ input nào bị tiêu → đúc trùng/giả tên.
test fg_mint_forged_name() fail {
  let name = #"ffff000000000000000000000000000000000000000000000000000000000000"
  run_fund_mint(
    [fg_carrier(name, fg_datum(name, 0, 0, 0, 0, 1_500, 0))],
    assets.from_asset(t_fund_hash, name, 1),
  )
}

// TẤN CÔNG: đúc 2 bản cùng tên → trạng thái quỹ tách đôi.
test fg_mint_qty_two() fail {
  let name = fg_name()
  run_fund_mint(
    [fg_carrier_at(name, fg_clean(), 2, t_fund_addr())],
    assets.from_asset(t_fund_hash, name, 2),
  )
}

// TẤN CÔNG: ĐỐT NFT quỹ (số lượng âm). NFT quỹ là vĩnh viễn ở v0.1.
test fg_mint_burn_rejected() fail {
  let name = fg_name()
  run_fund_mint(
    [fg_carrier(name, fg_clean())],
    assets.from_asset(t_fund_hash, name, -1),
  )
}

// TẤN CÔNG: đúc kèm một tên lạ dưới cùng policy (quỹ thứ hai không qua cổng).
test fg_mint_extra_name() fail {
  let name = fg_name()
  run_fund_mint(
    [fg_carrier(name, fg_clean())],
    assets.from_asset(t_fund_hash, name, 1) |> assets.add(t_fund_hash, #"6666", 1),
  )
}

// TẤN CÔNG CỐT LÕI: quỹ sinh ra đã khai magic_settled khổng lồ → `outstanding`
// âm → `buffer_floor` âm → FundClaim rút CARP của người khác.
test fg_mint_dirty_settled() fail {
  fg_mint_with(fg_datum(fg_name(), 0, 0, 999_000_000_000, 0, 1_500, 0))
}

// TẤN CÔNG: quỹ sinh ra đã khai credit_issued > 0 (phá C-PP-3 ngay từ đầu).
test fg_mint_dirty_issued() fail {
  fg_mint_with(fg_datum(fg_name(), 0, 1_000_000, 0, 0, 1_500, 0))
}

// TẤN CÔNG: khai carp_locked > 0 mà không có CARP thật trong UTxO.
test fg_mint_dirty_locked() fail {
  fg_mint_with(fg_datum(fg_name(), 1_000_000, 0, 0, 0, 1_500, 0))
}

// TẤN CÔNG: khai provider_claimed > 0 để nới trần F2 ngay từ genesis.
test fg_mint_dirty_claimed() fail {
  fg_mint_with(fg_datum(fg_name(), 0, 0, 0, 1_000_000, 1_500, 0))
}

// TẤN CÔNG: đệm buffer-Paid dưới 15%.
test fg_mint_buffer_too_low() fail {
  fg_mint_with(fg_datum(fg_name(), 0, 0, 0, 0, 1_499, 0))
}

// TẤN CÔNG: bơm last_updated_epoch lúc tạo.
test fg_mint_epoch_forged() fail {
  fg_mint_with(fg_datum(fg_name(), 0, 0, 0, 0, 1_500, t_epoch))
}

// TẤN CÔNG: fund_id trong datum khác tên NFT → định danh trôi.
test fg_mint_id_mismatch() fail {
  fg_mint_with(fg_datum(#"abcd", 0, 0, 0, 0, 1_500, 0))
}

// TẤN CÔNG: platform không phải một pkh 28 byte (khoá đòi của quỹ thành rác).
test fg_mint_platform_wrong_length() fail {
  let name = fg_name()
  let d = PaidFundDatum { ..fg_clean(), platform: #"77" }
  run_fund_mint([fg_carrier(name, d)], assets.from_asset(t_fund_hash, name, 1))
}

// TẤN CÔNG: vault_hash không phải script hash 28 byte.
test fg_mint_vault_hash_wrong_length() fail {
  let name = fg_name()
  let d = PaidFundDatum { ..fg_clean(), vault_hash: #"11" }
  run_fund_mint([fg_carrier(name, d)], assets.from_asset(t_fund_hash, name, 1))
}

// TẤN CÔNG: NFT đúc ra nhưng không output nào giữ (không có sổ quỹ).
test fg_mint_no_carrier() fail {
  let name = fg_name()
  run_fund_mint([], assets.from_asset(t_fund_hash, name, 1))
}

// TẤN CÔNG: datum quỹ không inline → không cổng nào đọc được trạng thái genesis.
test fg_mint_no_inline_datum() fail {
  let name = fg_name()
  let out = Output { ..fg_carrier(name, fg_clean()), datum: NoDatum }
  run_fund_mint([out], assets.from_asset(t_fund_hash, name, 1))
}
