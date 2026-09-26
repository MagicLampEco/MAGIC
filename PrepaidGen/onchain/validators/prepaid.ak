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
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Spend, Transaction,
  placeholder,
}

use magiclamp/protocol/owner_auth.{owner_authorized}
use magiclamp/protocol/types.{
  BurnBatch, FundClaim, FundLock, FundSettle, MagicBatch, MintVaultId,
  PaidFundDatum, PaidFundRedeemer, PrepaidCredit, PrepaidDraw, PrepaidLock,
  PrepaidVaultDatum, PrepaidVaultIdRedeemer, PrepaidVaultRedeemer, PrunePrepaid,
  SetDelegate, SetDidCommit, VaultAttribution,
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
// `ms_per_epoch`: Mainnet 432_000_000 · Preprod 432_000_000 · Preview 86_400_000.
// (Preprod đổi 86_400_000 → 432_000_000 ngày 2026-09-20 để trùng nhịp mạng thật.)
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

    // INV-VAULT-IDENTITY — ĐIỂM NGHẼN DUY NHẤT, ép cho CẢ SÁU nhánh redeemer.
    // Cố ý đặt ở thân handler chứ không chép vào từng `validate_*`: chép sáu bản
    // là sáu chỗ có thể sót một, mà sót thì không gì đỏ. Một bản ở đây thì gỡ nó
    // ra là cả nhóm bài `pp_spend_*_forged_vault`/`_nft_escapes` cùng chuyển sang
    // xanh — phép đột biến đó ghim được toàn bộ các nhánh chỉ bằng một lần chạy.
    // Và nó là lý do nhánh `SetDidCommit` thêm sau này KHÔNG phải tự nhớ gọi lại:
    // cổng nằm ở cấu trúc, không nằm ở kỷ luật của người thêm nhánh.
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

      SetDidCommit { did_commit } ->
        validate_set_did_commit(
          datum, did_commit, current_epoch, vault_addr, carp_policy_id,
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
  // Đích nhận CARP của FundClaim (L1'', 2026-09-26): ghim genesis, bất biến ở MỌI
  // nhánh spend. Một bản ở đây phủ cả ba nhánh — đổi đích giữa chừng là mở lại
  // đúng đường "chiếm khoá platform ⟹ rút về ví mình" mà hai trường này đóng.
  expect fund_out.beneficiary == fund_in.beneficiary
  expect fund_out.beneficiary_datum == fund_in.beneficiary_datum
  expect fund_out.last_updated_epoch == current_epoch

  // C-PP-3: carp_locked == credit_issued − provider_claimed (đúng từ genesis 0/0/0)
  expect fund_out.carp_locked == fund_out.credit_issued - fund_out.provider_claimed

  when redeemer is {
    FundLock -> validate_fund_lock(fund_in, fund_out, tx)
    FundSettle -> validate_fund_settle(fund_in, fund_out, current_epoch, tx)
    FundClaim { amount_carpdrop } ->
      validate_fund_claim(
        fund_in, fund_out, amount_carpdrop, carp_policy_id, carp_asset_name, tx,
      )
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

  // C-PP-9 (siết 2026-09-26, vá DoS "platform || owner"):
  //   · MỞ DÒNG MỚI (vault chưa có dòng hạn-mức cho `fund_id`) ⟹ CHỈ `owner` ký.
  //   · NẠP THÊM vào dòng ĐÃ CÓ ⟹ `platform` HOẶC `owner` (app khoá hộ user là
  //     hợp lệ — §9 nguồn B).
  //
  // Vì sao phải tách: genesis quỹ thì ai cũng lập được (với platform = pkh của
  // chính mình), nên "platform nào cũng được" nghĩa là NGƯỜI LẠ tiêu được UTxO
  // vault của nạn nhân. Người lạ lấp 20 chỗ `max_prepaid_credits` với 1 CARP mỗi
  // chỗ, và dòng KHÔNG BAO GIỜ bị xoá (`types.ak` ▸ `PrepaidCredit`) ⟹ vault mất
  // cửa nạp vĩnh viễn; còn nạp lại vào dòng của chính họ thì chặn cửa vault
  // (tranh UTxO) vô hạn lần, đủ để nạn nhân không `BurnBatch` kịp trong epoch.
  // Đòi chữ ký owner ở lượt mở dòng đóng cả hai với người lạ; bề mặt còn lại là
  // platform mà CHÍNH owner đã chọn mở dòng cho.
  //
  // Điều kiện "dòng mới" là CÙNG vị từ mà `add_credit` dùng để rẽ nhánh gộp/thêm
  // (`has_credit_line`) — hai chỗ cùng một hàm thì không lệch được nhau.
  let opens_new_line = !has_credit_line(datum.prepaid_credits, fund_id)
  expect
    if opens_new_line {
      authed_owner(datum, tx)
    } else {
      list.has(tx.extra_signatories, fund_in.platform) || authed_owner(datum, tx)
    }

  // C-PP-13
  expect no_fund_mint(tx, fund_nft_policy)

  // Quỹ này phải trỏ về ĐÚNG script vault đang chạy.
  expect fund_in.vault_hash == script_hash_of(vault_addr)

  // VAULT CÓ THẨM QUYỀN: kiểm TOÀN BỘ delta quỹ.
  expect fund_out.fund_id == fund_in.fund_id
  expect fund_out.platform == fund_in.platform
  expect fund_out.vault_hash == fund_in.vault_hash
  expect fund_out.buffer_bps == fund_in.buffer_bps
  expect fund_out.beneficiary == fund_in.beneficiary
  expect fund_out.beneficiary_datum == fund_in.beneficiary_datum
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

// Vault đã có dòng hạn-mức cho `fund_id` chưa. Dùng chung cho `add_credit` (rẽ
// gộp/thêm) và cổng chữ ký C-PP-9 ở `validate_lock` (rẽ owner / platform||owner).
fn has_credit_line(credits: List<PrepaidCredit>, fund_id: ByteArray) -> Bool {
  list.any(credits, fn(c) { c.fund_id == fund_id })
}

// Cộng hạn-mức: có dòng thì cộng vào, chưa có thì thêm vào CUỐI danh sách.
fn add_credit(
  credits : List<PrepaidCredit>,
  fund_id : ByteArray,
  amount  : Int,
  epoch   : Int,
) -> List<PrepaidCredit> {
  if has_credit_line(credits, fund_id) {
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

  // C-PP-9: CHỈ chủ sở hữu. Vế `HOẶC consume-delegate (Paymaster §7.6)` chết
  // 2026-09-16 — xem bia mộ ở `authed_owner`.
  expect authed_owner(datum, tx)

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
  expect authed_owner(datum, tx)
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
  expect owner_authorized(tx, datum.owner)

  // 🪦 BIA MỘ — nhánh này nay CHỈ XOÁ ĐƯỢC, không đặt được (2026-09-16, Nợ #14).
  // `SetDelegate` (constr 4) ở lại nguyên chỗ vì chỉ số constructor là hợp đồng
  // nhị phân — `SetDidCommit` nằm sau nó, gỡ variant này là đẩy `SetDidCommit`
  // lên một bậc.
  //
  // 🪦 Lý do CŨ — "giữ lại để một vault lỡ mang `Some(d)` còn dọn được" — TỰ
  // CHỌI CHÍNH NÓ: bản vá đổi bytes ⟹ đổi script hash ⟹ đổi địa chỉ, nên vault
  // đời trước bị tiêu bởi bytes CŨ và validator này không thấy chúng. Việc dọn
  // đời cũ là DI TRÚ, không phải việc của dòng này (Nợ #14). Dưới hash NÀY,
  // `Some` không sinh ra được, nên dòng dưới và `fail` tương đương về hành vi;
  // giữ dạng này vì nhánh còn đi tới được nên bài kiểm chứng minh được cả hai vế.
  expect new_delegate == None

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
// VAULT — SetDidCommit (§7.5) — GẮN PersonDID, MỘT LẦN
// ══════════════════════════════════════════════════════════════
//
// VÌ SAO NHÁNH NÀY TỒN TẠI. `validate_mint_vault_id` ghim `did_commit == #""` ở
// cổng đúc, còn C-PP-8 ép `out.did_commit == datum.did_commit` ở mọi nhánh khác.
// Hai vế đó cộng lại mà KHÔNG có nhánh này thì trường `did_commit` là hằng số
// rỗng trọn đời mọi vault — tức cả cơ chế tư-cách đọc theo PersonDID nằm ngoài
// tầm PrepaidGen VĨNH VIỄN, không đường điền vào sau. Đây là nhánh GHI duy nhất.
//
// Bản trước bản này đi đường ngược lại: cổng đúc KHÔNG ghim `did_commit`, người
// tạo vault tự đặt giá trị. Đường đó hỏng ở chỗ nó gộp hai thẩm quyền vào một
// chữ ký — `owner` được ký để chứng minh mình điều khiển pkh đó, và nó bị dùng
// luôn làm chứng cho một cam kết DID mà không vế nào buộc phải cùng người. Mà
// C-PP-8 bất biến trọn đời nên một cam kết bịa KHÔNG sửa được: vault đó chỉ có
// thể bị bỏ đi. Tách thành hai khoảnh khắc không làm cho lời khai trở nên thật
// hơn (xem GIỚI HẠN dưới đây) nhưng nó trả lại đúng một thứ: người đặt cam kết
// phải là người đang ĐIỀU KHIỂN vault tại thời điểm đặt, không phải bất kỳ ai
// dựng hộ một vault mang tên người khác.
//
// 🔴 GIỚI HẠN — ĐỌC TRƯỚC KHI DÙNG `did_commit` LÀM ĐẦU VÀO CHO BẤT CỨ THỨ GÌ.
// Nhánh này KHÔNG chứng minh DID được gắn THUỘC VỀ người ký. `did_commit` là một
// hash 32 byte nằm công khai trên chuỗi, nên ai cũng CHÉP được cam kết của người
// khác vào vault của mình — không cần biết tiền ảnh. ⟹ `did_commit` dùng được
// cho QUY KẾT (ai tự nhận việc tiêu này), KHÔNG dùng được cho thứ mà nói dối có
// lợi: quyền biểu quyết, phân bổ thưởng, hạn mức theo người, chống-Sybil. Cùng
// một giới hạn, cùng một câu chữ với `validate_bind_did` của ConsumeMAGIC — hai
// module phải nói cùng một điều, nếu không bên đọc sẽ tin bên lỏng hơn.
//
// Vế mạnh (nếu có ngày cần): đọc anchor Service-DID của PhoenixKey qua
// `reference_input` rồi đòi chữ ký của controller hiện tại. Nó đổi script hash ⟹
// deploy lại ⟹ công bố ref-script CIP-33 mới, nên phải đi cùng lượt với một
// thay đổi khác cũng đổi hash.
fn validate_set_did_commit(
  datum           : PrepaidVaultDatum,
  new_did         : ByteArray,
  current_epoch   : Int,
  vault_addr      : Address,
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {
  // ── (1) MỘT LẦN: chỉ hợp lệ khi chưa gắn ────────────────────────────────
  // Khoá cả hai hướng sai cùng lúc: đổi cam kết này sang cam kết khác, và ghi
  // đè cam kết của một vault đã có danh tính. Vế này cộng với C-PP-8 ở năm
  // nhánh kia là thứ làm nhánh này TỰ KHOÁ sau lần chạy đầu tiên.
  expect datum.did_commit == #""

  // ── (2) CHỮ KÝ CỦA CHÍNH `owner` ────────────────────────────────────────
  // KHÔNG nhận `personal_delegate`. Vế đó nay đã chết ở MỌI nhánh (2026-09-16,
  // Nợ #14), nên dòng này không còn là ngoại lệ — nhưng lý do riêng của nó vẫn
  // đáng giữ, vì nó là lý do khiến nhánh này ĐÚNG NGAY TỪ ĐẦU: thứ từng được uỷ
  // quyền ở đường Paymaster là TRẢ TIỀN hộ, còn ở đây là KHAI MÌNH LÀ AI. Và vì
  // (1) chỉ cho ghi một lần, một delegate ghi trước là nạn nhân mất luôn đường
  // gắn DID thật — hỏng không hoàn tác được.
  expect owner_authorized(tx, datum.owner)

  // ── (3) GIÁ TRỊ MỚI KHÁC RỖNG ───────────────────────────────────────────
  // Không có vế này thì "gắn DID" bằng chuỗi rỗng là một no-op hợp lệ: vô hại
  // một mình, nhưng nó làm cổng (1) hết nghĩa "một lần" — đặt rỗng rồi đặt lại.
  expect new_did != #""

  // ── (4) ĐÚNG KHUÔN 32 byte ──────────────────────────────────────────────
  expect did_len_ok(new_did)

  let out = get_vault_output(tx.outputs, vault_addr)
  expect out.owner == datum.owner
  expect out.did_commit == new_did                   // ← thay đổi duy nhất
  expect out.prepaid_credits == datum.prepaid_credits
  expect out.magic_batches == datum.magic_batches
  expect out.next_batch_index == datum.next_batch_index
  expect out.personal_delegate == datum.personal_delegate
  expect out.attribution == datum.attribution
  expect out.last_updated_epoch == current_epoch
  expect vault_output_carp(tx.outputs, vault_addr, carp_policy_id, carp_asset_name) == 0
  True
}

/// Độ dài hợp lệ của `did_commit`: RỖNG (chưa gắn) hoặc ĐÚNG 32 byte
/// (blake2b-256). Cùng ràng buộc, cùng lý lẽ với
/// `ConsumeMAGIC/onchain/validators/consume.ak` ▸ `did_len_ok` — hai module đọc
/// cùng một trường của cùng một người, nên hai khuôn khác nhau là hai bên đọc ra
/// hai người khác nhau từ cùng một chuỗi byte.
///
/// Ghim ở MỌI chỗ GHI trường này, và CHỈ ở đó: cổng đúc (ghim về rỗng) và
/// `validate_set_did_commit`. CỐ Ý KHÔNG ép ở năm nhánh còn lại — chúng không
/// GHI, chúng ép `out.did_commit == datum.did_commit`. Thêm kiểm độ dài vào một
/// nhánh bảo toàn là biến mọi vault đã nằm trên chuỗi với did sai khuôn thành
/// BẤT KHẢ TIÊU (min-ADA khoá vĩnh viễn), mà chính nhánh tiêu là thứ vừa bị
/// khoá nên không có đường di trú. Ràng buộc đặt ở cổng VÀO, không đặt ở cổng RA
/// của state đã nằm trên chuỗi.
fn did_len_ok(did: ByteArray) -> Bool {
  let n = builtin.length_of_bytearray(did)
  n == 0 || n == 32
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
  fund_in         : PaidFundDatum,
  fund_out        : PaidFundDatum,
  amount          : Int,
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {
  expect list.has(tx.extra_signatories, fund_in.platform)
  expect amount > 0

  // ── ĐÍCH (L1'', 2026-09-26): CARP rút ra phải tới ĐÚNG bên hưởng đã ghim ──
  // Hình dạng "không input tại đích + đúng MỘT output tại đích", KHÔNG phải "delta
  // tại đích". Cấm input tại đích thì tiền thừa của người dựng tx không thể rơi
  // về đích, nên lý do cũ để loại dạng một-output (tiền thừa lẫn vào) mất hiệu
  // lực; và dạng này ghim được cả DATUM, thứ mà "delta" không ghim.
  //
  // So ĐỊA CHỈ ĐẦY ĐỦ (genesis ép `beneficiary.stake_credential == None`): output
  // ở (cùng payment cred, stake người lạ) KHÔNG tính là tới đích, nên không ai
  // gắn stake của mình lên tiền của bên hưởng. Hệ quả vận hành: phí và tiền thừa
  // của tx claim phải đi từ một địa chỉ KHÁC `beneficiary` (vd địa chỉ base của
  // cùng khoá — nó khác địa chỉ enterprise của bên hưởng).
  //
  // Datum khớp: `None` ⟹ `NoDatum`, `Some(d)` ⟹ `InlineDatum(d)`. Bên hưởng là
  // script thì thiếu datum là "rót đúng địa chỉ, ngoài sổ" — CARP nằm ở đó mà
  // không nhánh nào của kho đích tiêu lại được. Ràng buộc này là CẦN, chưa ĐỦ:
  // khả năng tiêu lại của cặp (beneficiary, beneficiary_datum) phải được chứng
  // minh ngoài chuỗi trước khi lập quỹ (mục nợ trong `DevStatus.md`).
  let ben = fund_in.beneficiary
  expect !list.any(tx.inputs, fn(i) { i.output.address == ben })
  expect [paid] = list.filter(tx.outputs, fn(o) { o.address == ben })
  expect
    assets.quantity_of(paid.value, carp_policy_id, carp_asset_name) == amount
  expect
    when fund_in.beneficiary_datum is {
      None -> paid.datum == NoDatum
      Some(d) -> paid.datum == InlineDatum(d)
    }

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
  // owner: một credential mà người tạo thật sự điều khiển — khoá ký, hoặc script gật
  // qua mục rút (`owner_authorized`). Không có vế này thì bất kỳ ai
  // cũng dựng được vault mang tên người khác (mọi nhánh spend sau đó đọc `owner`
  // làm quyền).
  expect owner_authorized(tx, vd.owner)

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

  // ── `did_commit` phải RỖNG lúc đúc ──────────────────────────────────────
  // Bản trước để trường này TỰ DO ở đây, với lý lẽ "§7.5 nói đặt một lần lúc tạo
  // vault, mà lúc tạo vault chính là giao dịch này". Lý lẽ đó đúng về thời điểm
  // và sai về THẨM QUYỀN. Chỗ duy nhất kiểm danh tính trong giao dịch đúc là
  // `owner_authorized(tx, vd.owner)` ngay trên, và không vế nào buộc
  // `owner` có liên hệ gì với `did_commit` — nên cùng một chữ ký vừa chứng minh
  // "tôi điều khiển owner này" vừa được tính là chứng cho một cam kết DID bất kỳ.
  //
  // Và nó BẤT BIẾN TRỌN ĐỜI: năm nhánh spend còn lại đều ép `out.did_commit ==
  // datum.did_commit` (C-PP-8), nên một vault sinh ra với cam kết bịa thì không
  // nhánh nào sửa được — chỉ có thể bỏ vault đi. Một trường ghi-một-lần-không-
  // sửa-được mà cổng ghi lại không kiểm gì là lớp hại không hoàn tác.
  //
  // Đường đặt KHÔNG bị đóng: nó chuyển sang nhánh `SetDidCommit` (constr 5), nơi
  // có đủ ba vế mà chỗ này không có — chưa-gắn, chữ ký CHÍNH `owner` tại thời
  // điểm gắn, và khuôn 32 byte. Xem `validate_set_did_commit`.
  expect vd.did_commit == #""

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

  // ── Platform phải KÝ genesis (L1'', 2026-09-26) ─────────────────────────
  // Không có vế này thì ai cũng lập được một quỹ mang pkh của platform thật với
  // `beneficiary` là ví mình, dẫn người dùng của platform khoá CARP vào đó, rồi
  // chờ keeper của platform ký `FundClaim` cho "quỹ mang pkh của tôi" — CARP chảy
  // về kẻ mạo danh. Ghim đích mà không bắt platform ký là làm hệ XẤU đi so với
  // lúc đích còn do người ký claim tự chọn.
  expect list.has(tx.extra_signatories, fd.platform)

  // ── Hình dạng đích nhận CARP (ghim trọn đời, xem `fund_common_checks`) ───
  let ben = fd.beneficiary
  // Không stake: cùng lý do với địa chỉ quỹ ở trên, và claim so địa chỉ ĐẦY ĐỦ.
  expect ben.stake_credential == None
  // Khuôn 28 byte cho hash của payment credential — cùng lớp với hai dòng độ dài
  // ở trên: một hash sai độ dài không có output nào đỗ được ở đó, nên mọi claim
  // chết và CARP người dùng kẹt sau buffer vĩnh viễn.
  expect
    when ben.payment_credential is {
      VerificationKey(h) -> bytearray.length(h) == 28
      Script(h) -> bytearray.length(h) == 28
    }
  // Đích là quỹ: output tới đích lại là output quỹ ⟹ claim không bao giờ đúng
  // hình dạng. Đích là vault: output không mang NFT vault ⟹ không nhánh nào tiêu
  // lại được (`vault_identity_preserved`). Cả hai là CARP chết.
  expect ben.payment_credential != Script(policy_id)
  expect ben.payment_credential != Script(fd.vault_hash)
  // Đích là script ⟹ BẮT BUỘC ghim datum (xem khối ĐÍCH ở `validate_fund_claim`).
  expect
    when ben.payment_credential is {
      Script(_) -> fd.beneficiary_datum != None
      VerificationKey(_) -> True
    }
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

// 🪦 BIA MỘ — hàm này từng tên `authed_owner_or_delegate` và từng có vế
// `|| personal_delegate`. Vế đó CHẾT 2026-09-16 (Nợ #14) cùng cả nhánh uỷ nhiệm.
//
// Vì sao ca này là ca ĐẮT NHẤT trong ba module: vị từ ở đây gác HAI handler,
// `PrepaidDraw` (`validate_draw`) và `BurnBatch` (`validate_burn_batch`). Mọi
// bản vá đặt cổng ở BurnBatch — kể cả cổng co-spend từng được đề xuất — đều bỏ
// sót `PrepaidDraw`, nhánh biến `prepaid_credits.remaining` (hạn mức mua bằng
// CARP, KHÔNG có hạn dùng) thành một batch MAGIC `decay_window = 1` chết ở vách
// epoch kế. Trần duy nhất là `amount <= c.remaining`, nên một delegate rút trọn
// hạn mức trong một giao dịch, chủ không ký. Đổi tên hàm là cố ý: cái tên cũ là
// thứ mời người sau nối lại vế đã chết.
//
// Đổi tên `pub`/private trong `lib`/`validators` KHÔNG đổi script hash. (Bản trước
// của dòng này còn viết "PrepaidGen chưa deploy ở mạng nào" — sai từ 2026-09-20:
// `scripts/DEPLOYED.md` có mục PrepaidGen Preprod. Tra ở đó, đừng suy từ đây.)
//
// Từ 2026-09-26 hàm này gác thêm lượt `PrepaidLock` MỞ DÒNG MỚI (C-PP-9, xem
// `validate_lock`).
fn authed_owner(datum: PrepaidVaultDatum, tx: Transaction) -> Bool {
  owner_authorized(tx, datum.owner)
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
// Bên hưởng CARP của FundClaim (L1''): một pkh riêng và một script riêng, KHÔNG
// trùng platform/vault/quỹ — để bài nào đỏ thì đỏ vì đúng vế đang canh.
const t_ben_pkh: ByteArray = #"bebebebebebebebebebebebebebebebebebebebebebebebebebebebe"
const t_ben_script: ByteArray = #"5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c"
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
// `did_commit` của một vault ĐÃ GẮN: đúng 32 byte, khuôn duy nhất mà
// `did_len_ok` cho qua. Bản trước là #"deadbeef" (4 byte) — từ khi cổng đúc ghim
// rỗng và `SetDidCommit` ghim 32 byte thì độ dài đó KHÔNG tới được trên chuỗi, và
// một fixture tả trạng thái bất khả đạt là fixture kiểm một thế giới không có.
const t_did: ByteArray =
  #"d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1"
// Giá trị 32 byte THỨ HAI — dùng cho bài "vault đã có DID thì từ chối đặt lại".
const t_did_other: ByteArray =
  #"d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2"
// SAI KHUÔN (4 byte) — chỉ để chứng minh cổng độ dài ở nhánh ghi có người canh.
const t_did_short: ByteArray = #"deadbeef"
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

// Địa chỉ enterprise (không stake) của bên hưởng — đúng khuôn genesis ép.
fn t_ben_addr() -> Address {
  Address { payment_credential: VerificationKey(t_ben_pkh), stake_credential: None }
}

fn t_ben_script_addr() -> Address {
  address.from_script(t_ben_script)
}

// Datum ghim cho bên hưởng là script (ví dụ datum sổ của một kho).
fn t_ben_datum() -> Data {
  let d: Data = #"0b0b"
  d
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
    owner: VerificationKey(t_owner),
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
    beneficiary: t_ben_addr(),
    beneficiary_datum: None,
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

// happy: khoá 1 CARP → hạn-mức mới, CARP thật vào quỹ. MỞ DÒNG MỚI ⟹ chữ ký
// owner (C-PP-9 siết 2026-09-26). Các bài tấn công mở-dòng-mới bên dưới cũng ký
// bằng owner để chúng đỏ vì ĐÚNG vế mình canh, không đỏ vì thiếu chữ ký.
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
  run_lock(din, lock_tx(din, dout, fin, 0, fout, lock_amt, [t_owner]))
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
  run_lock(din, lock_tx(din, dout, fin, 0, fout, 0, [t_owner]))
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
  run_lock(din, lock_tx(din, dout, fin, 0, fout, lock_amt, [t_owner]))
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
      [t_owner],
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
  run_lock(din, lock_tx(din, dout, fin, 0, fout, lock_amt, [t_owner]))
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
  let tx = lock_tx(din, dout, fin, 0, fout, 1, [t_owner])
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
  run_lock(din, lock_tx(din, dout, fin, 0, fout, lock_amt, [t_owner]))
}


// ── C-PP-9 siết 2026-09-26: MỞ DÒNG MỚI đòi owner; NẠP THÊM giữ platform||owner ──
//
// Ba bài dưới cùng hình dạng `pp_lock_ok` / `pp_lock_topup_ok` và chỉ đổi ĐÚNG
// MỘT yếu tố (người ký, hoặc dòng đang có là của quỹ nào), nên chúng phân biệt
// được hai phía của phép đột biến "cổng mở-dòng-mới ≡ True".

fn new_line_dout(din: PrepaidVaultDatum) -> PrepaidVaultDatum {
  PrepaidVaultDatum {
    ..din,
    prepaid_credits: list.concat(
      din.prepaid_credits,
      [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: lock_amt,
          issued_epoch: t_epoch,
          last_draw_epoch: t_epoch,
        },
      ],
    ),
    last_updated_epoch: t_epoch,
  }
}

// TẤN CÔNG: mở dòng mới chỉ với chữ ký platform (cặp của `pp_lock_ok`).
test pp_lock_new_line_platform_only() fail {
  let din = t_vd([], [])
  let fin = t_fd(0, 0, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  run_lock(
    din,
    lock_tx(din, new_line_dout(din), fin, 0, fout, lock_amt, [t_platform]),
  )
}

// TẤN CÔNG (đúng kịch bản DoS): NGƯỜI LẠ tự lập một quỹ hợp lệ với platform =
// pkh của mình, rồi dùng nó chiếm một chỗ trong vault của nạn nhân.
test pp_lock_stranger_fund_new_line() fail {
  let din = t_vd([], [])
  let fin = PaidFundDatum { ..t_fd(0, 0, 0, 0, 1_500), platform: t_stranger }
  let fout =
    PaidFundDatum { ..t_fd(lock_amt, lock_amt, 0, 0, 1_500), platform: t_stranger }
  run_lock(
    din,
    lock_tx(din, new_line_dout(din), fin, 0, fout, lock_amt, [t_stranger]),
  )
}

// TẤN CÔNG: vault ĐÃ có dòng — nhưng của quỹ KHÁC. Lượt này vẫn là mở dòng mới
// cho `t_fund_id`, nên chữ ký platform không đủ. Bài này bắt đột biến nới vị từ
// "dòng mới" thành "vault còn rỗng".
test pp_lock_new_line_beside_other_fund_platform_only() fail {
  let din = t_vd([t_credit(t_other_fund, 500)], [])
  let fin = t_fd(0, 0, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  run_lock(
    din,
    lock_tx(din, new_line_dout(din), fin, 0, fout, lock_amt, [t_platform]),
  )
}

// happy: cùng tình huống trên nhưng owner ký (cặp dương của bài trên).
test pp_lock_new_line_beside_other_fund_owner_ok() {
  let din = t_vd([t_credit(t_other_fund, 500)], [])
  let fin = t_fd(0, 0, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  run_lock(
    din,
    lock_tx(din, new_line_dout(din), fin, 0, fout, lock_amt, [t_owner]),
  )
}

// happy: NẠP THÊM vào dòng đã có chỉ với chữ ký platform — luồng "app khoá hộ"
// giữ nguyên (cặp của `pp_lock_topup_ok`, chỉ đổi người ký).
test pp_lock_topup_platform_only_ok() {
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
  run_lock(din, lock_tx(din, dout, fin, lock_amt, fout, 2 * lock_amt, [t_platform]))
}

// TẤN CÔNG: nạp thêm mà không ai trong {platform, owner} ký — vế cũ vẫn có người canh.
test pp_lock_topup_no_auth() fail {
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
  run_lock(din, lock_tx(din, dout, fin, lock_amt, fout, 2 * lock_amt, [t_stranger]))
}

// TẤN CÔNG: lượt khoá đổi đích nhận CARP của quỹ. `validate_lock` tự khai "kiểm
// TOÀN BỘ delta quỹ" — bài này ghim hai dòng đích trong khối đó (gọi thẳng
// `validate_lock`, không qua `fund_common_checks`).
test pp_lock_fund_beneficiary_changed() fail {
  let din = t_vd([], [])
  let fin = t_fd(0, 0, 0, 0, 1_500)
  let fout =
    PaidFundDatum {
      ..t_fd(lock_amt, lock_amt, 0, 0, 1_500),
      beneficiary: address.from_verification_key(t_stranger),
    }
  run_lock(
    din,
    lock_tx(din, new_line_dout(din), fin, 0, fout, lock_amt, [t_owner]),
  )
}

test pp_lock_fund_beneficiary_datum_changed() fail {
  let din = t_vd([], [])
  let fin = t_fd(0, 0, 0, 0, 1_500)
  let fout =
    PaidFundDatum {
      ..t_fd(lock_amt, lock_amt, 0, 0, 1_500),
      beneficiary_datum: Some(t_ben_datum()),
    }
  run_lock(
    din,
    lock_tx(din, new_line_dout(din), fin, 0, fout, lock_amt, [t_owner]),
  )
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

// ĐƯỜNG TẤN CÔNG Nợ #14, nhánh KHÔNG đi qua BurnBatch — delegate rút hạn mức
// trả trước của chủ, chủ KHÔNG ký. Bài này từng là `pp_draw_by_delegate_ok`
// ("happy: delegate (Paymaster §7.6) rút hộ") và từng XANH; đảo dấu 2026-09-16.
//
// Đây là bài chứng minh vì sao cổng co-spend ở BurnBatch không đóng được bán
// kính: giao dịch này không chạm BurnBatch một lần nào.
test pp_draw_by_delegate_rejected() fail {
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

// ĐỐI CHỨNG DƯƠNG: CÙNG datum còn mang `Some(d)` của đời trước, chỉ đổi người
// ký sang chủ ⟹ CHẤP NHẬN. Cặp này phân biệt "chặn vì người ký sai" với "chặn
// vì datum có delegate".
test pp_draw_owner_signs_with_stale_delegate_ok() {
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
  run_draw(din, draw_amt, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
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

// ĐƯỜNG TẤN CÔNG Nợ #14, handler thứ hai do CÙNG vị từ auth gác — delegate ký
// một mình, huỷ MAGIC sống của chủ. PrepaidGen trước 2026-09-16 KHÔNG có bài
// nào ở hình dạng này: `pp_burn_no_auth` dùng `t_stranger`, mà người lạ thì bị
// chặn ở cả bản cũ lẫn bản mới ⟹ nó không phân biệt được hai bên đột biến.
test pp_burn_by_delegate_rejected() fail {
  let base = t_vd([], [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let din = PrepaidVaultDatum { ..base, personal_delegate: Some(t_delegate) }
  let doutb = t_out_burn([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], [], 1)
  let dout = PrepaidVaultDatum { ..doutb, personal_delegate: Some(t_delegate) }
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_delegate]),
  )
}

// ĐỐI CHỨNG DƯƠNG cho bài ngay trên: cùng datum mang delegate cũ, chủ ký ⟹ qua.
test pp_burn_owner_signs_with_stale_delegate_ok() {
  let base = t_vd([], [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let din = PrepaidVaultDatum { ..base, personal_delegate: Some(t_delegate) }
  let doutb = t_out_burn([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], [], 1)
  let dout = PrepaidVaultDatum { ..doutb, personal_delegate: Some(t_delegate) }
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
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

// ĐẶT một delegate mới — chủ ký, mọi vế khác hợp lệ, vẫn phải bị TỪ CHỐI.
// Bài này từng là `pp_setdelegate_ok` và từng XANH; đảo dấu 2026-09-16.
// Đây là bài canh duy nhất cho cổng bia-mộ `new_delegate == None` ở module này.
test pp_setdelegate_set_rejected() fail {
  let din = t_vd([t_credit(t_fund_id, 10)], [])
  let dout =
    PrepaidVaultDatum {
      ..din,
      personal_delegate: Some(t_delegate),
      last_updated_epoch: t_epoch,
    }
  run_setdel(din, Some(t_delegate), t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
}

// ĐỐI CHỨNG DƯƠNG: đường XOÁ còn sống — chủ dọn được một trường `Some(d)` lỡ
// mang từ đời trước. Không có bài này thì một bản vá bịt luôn cả nhánh vẫn xanh.
test pp_setdelegate_clear_ok() {
  let base = t_vd([t_credit(t_fund_id, 10)], [])
  let din = PrepaidVaultDatum { ..base, personal_delegate: Some(t_delegate) }
  let dout =
    PrepaidVaultDatum { ..din, personal_delegate: None, last_updated_epoch: t_epoch }
  run_setdel(din, None, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
}

// TẤN CÔNG: chính delegate cũ đụng vào trường của mình, chủ không ký.
// Dựng dưới dạng XOÁ có chủ ý: dạng ĐẶT nay chết ở cổng bia-mộ và bài sẽ đỏ vì
// lý do khác hẳn cái tên nó mang.
test pp_setdelegate_by_delegate() fail {
  let base = t_vd([], [])
  let din = PrepaidVaultDatum { ..base, personal_delegate: Some(t_delegate) }
  let dout =
    PrepaidVaultDatum { ..din, personal_delegate: None, last_updated_epoch: t_epoch }
  run_setdel(din, None, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_delegate]))
}

// TẤN CÔNG: dọn delegate kèm bơm hạn-mức.
test pp_setdelegate_mints_credit() fail {
  let base = t_vd([t_credit(t_fund_id, 10)], [])
  let din = PrepaidVaultDatum { ..base, personal_delegate: Some(t_delegate) }
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [t_credit(t_fund_id, 10_000_000)],
      personal_delegate: None,
      last_updated_epoch: t_epoch,
    }
  run_setdel(din, None, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
}

// ══════════════════════════════════════════════════════════════
// SetDidCommit — nhánh GHI duy nhất của `did_commit`
// ══════════════════════════════════════════════════════════════
//
// Mỗi bài âm tính dưới đây dựng phần CÒN LẠI của giao dịch HỢP LỆ và chỉ sai
// đúng MỘT thứ. Đó không phải nghi thức: một bài âm dựng ẩu thì gỡ chốt ra nó
// vẫn đỏ ở chốt kế tiếp, số bài lật ra 0, và phép đột biến không chứng minh gì.

fn sd_din() -> PrepaidVaultDatum {
  PrepaidVaultDatum { ..t_vd([t_credit(t_fund_id, 10)], []), did_commit: #"" }
}

fn sd_dout(did: ByteArray) -> PrepaidVaultDatum {
  PrepaidVaultDatum { ..sd_din(), did_commit: did, last_updated_epoch: t_epoch }
}

fn run_setdid(
  datum   : PrepaidVaultDatum,
  new_did : ByteArray,
  tx      : Transaction,
) -> Bool {
  validate_set_did_commit(
    datum, new_did, t_epoch, t_vault_addr(), t_carp_policy, t_carp_name, tx,
  )
}

fn sd_tx(din: PrepaidVaultDatum, dout: PrepaidVaultDatum, signers: List<ByteArray>) -> Transaction {
  t_tx([t_vault_in(din)], [t_vault_out(dout)], signers)
}

// DƯƠNG TÍNH: vault chưa gắn, chính owner ký, giá trị đúng khuôn 32 byte.
test pp_setdid_ok() {
  run_setdid(sd_din(), t_did, sd_tx(sd_din(), sd_dout(t_did), [t_owner]))
}

// TẤN CÔNG: vault đã có danh tính, ghi đè sang một cam kết khác.
// Đây là vế "một lần, không đảo ngược" — thiếu nó thì `did_commit` thành một
// trường đổi được tuỳ ý, và mọi bên đã quy kết theo giá trị cũ bị bỏ lại.
test pp_setdid_already_set() fail {
  let din = PrepaidVaultDatum { ..sd_din(), did_commit: t_did_other }
  let dout = PrepaidVaultDatum { ..din, did_commit: t_did, last_updated_epoch: t_epoch }
  run_setdid(din, t_did, sd_tx(din, dout, [t_owner]))
}

// TẤN CÔNG: người lạ gắn DID của mình vào vault người khác. Vì cổng "một lần"
// chỉ cho ghi MỘT lần, nạn nhân mất luôn đường gắn DID thật — hỏng không hoàn tác.
test pp_setdid_no_owner_sig() fail {
  run_setdid(sd_din(), t_did, sd_tx(sd_din(), sd_dout(t_did), [t_stranger]))
}

// TẤN CÔNG: `personal_delegate` khai danh tính hộ. Uỷ quyền TRẢ PHÍ không phải
// uỷ quyền KHAI MÌNH LÀ AI — bài này từng là thứ chặn ai đó "tiện tay" đổi vế
// (2) thành `authed_owner_or_delegate` cho đồng bộ với Draw/BurnBatch.
// Sau 2026-09-16 hai nhánh kia CŨNG chỉ nhận chủ, nên cái bẫy "cho đồng bộ" hết
// đường xảy ra. Bài vẫn giữ: nó canh vế (2) một cách độc lập với việc hàng xóm
// đang chặt hay lỏng, và đó đúng là thứ một bài canh phải làm.
test pp_setdid_by_delegate() fail {
  let din = PrepaidVaultDatum { ..sd_din(), personal_delegate: Some(t_delegate) }
  let dout = PrepaidVaultDatum { ..din, did_commit: t_did, last_updated_epoch: t_epoch }
  run_setdid(din, t_did, sd_tx(din, dout, [t_delegate]))
}

// TẤN CÔNG: cam kết sai khuôn (4 byte). Không chặn thì mỗi bên đọc tự đoán khuôn,
// và ở lớp định danh "tự đoán khuôn" là hai bên đọc ra hai người khác nhau.
test pp_setdid_wrong_length() fail {
  run_setdid(sd_din(), t_did_short, sd_tx(sd_din(), sd_dout(t_did_short), [t_owner]))
}

// TẤN CÔNG: "gắn" bằng chuỗi rỗng. Vô hại một mình, nhưng nó làm cổng một-lần
// hết nghĩa: đặt rỗng rồi đặt lại, bao nhiêu lần cũng được.
test pp_setdid_to_empty() fail {
  run_setdid(sd_din(), #"", sd_tx(sd_din(), sd_dout(#""), [t_owner]))
}

// TẤN CÔNG: nhân tiện khai danh tính thì bơm luôn hạn-mức. Giao dịch này chỉ
// được điền MỘT trường.
test pp_setdid_mutates_other_field() fail {
  let dout =
    PrepaidVaultDatum { ..sd_dout(t_did), prepaid_credits: [t_credit(t_fund_id, 10_000_000)] }
  run_setdid(sd_din(), t_did, sd_tx(sd_din(), dout, [t_owner]))
}

// DƯƠNG TÍNH ĐẦU–CUỐI, chạy qua ĐÚNG các handler thật, ba bước liền mạch:
//   (1) đúc vault — cổng mint ép `did_commit == #""`;
//   (2) `SetDidCommit` đặt giá trị 32 byte;
//   (3) một nhánh spend KHÁC (`SetDelegate`) chạy tiếp và giá trị còn nguyên.
// Bước (3) chứng minh đường đi tồn tại, KHÔNG chứng minh C-PP-8 có người canh —
// việc đó thuộc `pp_lock_did_forged` / `pp_burn_did_forged`, hai bài âm tính đo
// đúng chốt bảo toàn.
test pp_setdid_end_to_end() {
  let g = t_genesis_vd()
  expect run_mint(t_seed_ref(), mint_tx_with(g))

  let after = PrepaidVaultDatum { ..g, did_commit: t_did, last_updated_epoch: t_epoch }
  expect
    run_spend(
      g,
      SetDidCommit { did_commit: t_did },
      branch_tx(t_vault_in(g), t_vault_out(after), [], [], [t_owner]),
    )

  // Bước (3) dùng `SetDelegate` ở dạng XOÁ (2026-09-16): nhánh này vẫn là một
  // nhánh spend KHÁC và vẫn chứng minh được `did_commit` sống qua nó, nhưng
  // dạng ĐẶT đã chết nên không dựng bước này bằng `Some(...)` được nữa.
  let after2 = PrepaidVaultDatum { ..after, personal_delegate: None }
  expect after2.did_commit == t_did
  run_spend(
    after,
    SetDelegate { new_delegate: None },
    branch_tx(t_vault_in(after), t_vault_out(after2), [], [], [t_owner]),
  )
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

// Output tới bên hưởng, đúng hình dạng mà `validate_fund_claim` đòi: đúng địa
// chỉ, đúng `carp` CARP, datum khớp `fin.beneficiary_datum`.
fn t_ben_out(fin: PaidFundDatum, carp: Int) -> Output {
  Output {
    address: fin.beneficiary,
    value: assets.from_lovelace(2_000_000)
      |> assets.add(t_carp_policy, t_carp_name, carp),
    datum: when fin.beneficiary_datum is {
      None -> NoDatum
      Some(d) -> InlineDatum(d)
    },
    reference_script: None,
  }
}

// Lượng trả bên hưởng = phần `carp_locked` giảm theo DATUM (= `amount` ở mọi bài
// dưới): các bài tấn công cũ nhờ vậy chỉ đỏ vì vế chúng canh, không đỏ vì đích.
fn claim_tx(
  fin       : PaidFundDatum,
  fin_carp  : Int,
  fout      : PaidFundDatum,
  fout_carp : Int,
  signers   : List<ByteArray>,
) -> Transaction {
  t_tx(
    [t_fund_in(fin, fin_carp)],
    [
      t_fund_out(fout, fout_carp),
      t_ben_out(fin, fin.carp_locked - fout.carp_locked),
    ],
    signers,
  )
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
    t_tx(
      [t_fund_in(fin, 1_000_000_000)],
      [t_fund_out_at(fout, 0, evil), t_ben_out(fin, 1_000_000_000)],
      [t_platform],
    )
  run_fund(fin, 1_000_000_000, tx, FundClaim { amount_carpdrop: 1_000_000_000 })
}

// ── FundClaim — ĐÍCH (L1'', 2026-09-26) ───────────────────────
//
// Mọi bài dưới dựng từ `pp_fund_claim_full_ok` và đổi ĐÚNG MỘT yếu tố.

fn full_fin() -> PaidFundDatum {
  t_fd(1_000_000_000, 1_000_000_000, 1_000_000_000, 0, 1_500)
}

fn full_fout() -> PaidFundDatum {
  t_fd(0, 1_000_000_000, 1_000_000_000, 1_000_000_000, 1_500)
}

fn run_full_claim(ins: List<Input>, outs: List<Output>) -> Bool {
  run_fund(
    full_fin(), 1_000_000_000,
    t_tx(ins, outs, [t_platform]),
    FundClaim { amount_carpdrop: 1_000_000_000 },
  )
}

// TẤN CÔNG CỐT LÕI: người ký claim (khoá platform bị chiếm) đẩy CARP về ví mình
// thay vì bên hưởng đã ghim.
test pp_fund_claim_to_wrong_address() fail {
  let fin = full_fin()
  run_full_claim(
    [t_fund_in(fin, 1_000_000_000)],
    [
      t_fund_out(full_fout(), 0),
      Output { ..t_ben_out(fin, 1_000_000_000), address: address.from_verification_key(t_stranger) },
    ],
  )
}

// TẤN CÔNG: gắn stake credential của người lạ lên output tới bên hưởng (cùng
// payment cred, khác địa chỉ đầy đủ) — không tính là tới đích.
test pp_fund_claim_beneficiary_stake_swapped() fail {
  let fin = full_fin()
  run_full_claim(
    [t_fund_in(fin, 1_000_000_000)],
    [
      t_fund_out(full_fout(), 0),
      Output {
        ..t_ben_out(fin, 1_000_000_000),
        address: t_ben_addr() |> address.with_delegation_key(t_stranger),
      },
    ],
  )
}

// TẤN CÔNG: bên hưởng có input trong tx ⟹ tiền thừa lẫn vào đích, "một output"
// mất nghĩa. Input chỉ mang ADA — mọi vế khác vẫn đúng.
test pp_fund_claim_input_at_beneficiary() fail {
  let fin = full_fin()
  let ben_in =
    Input {
      output_reference: OutputReference { transaction_id: t_tx_id, output_index: 9 },
      output: Output {
        address: t_ben_addr(),
        value: assets.from_lovelace(5_000_000),
        datum: NoDatum,
        reference_script: None,
      },
    }
  run_full_claim(
    [t_fund_in(fin, 1_000_000_000), ben_in],
    [t_fund_out(full_fout(), 0), t_ben_out(fin, 1_000_000_000)],
  )
}

// TẤN CÔNG: HAI output tại bên hưởng (một đủ CARP, một chỉ ADA).
test pp_fund_claim_two_outputs_at_beneficiary() fail {
  let fin = full_fin()
  run_full_claim(
    [t_fund_in(fin, 1_000_000_000)],
    [
      t_fund_out(full_fout(), 0),
      t_ben_out(fin, 1_000_000_000),
      t_ben_out(fin, 0),
    ],
  )
}

// TẤN CÔNG: output tới bên hưởng thiếu 1 carpdrop so với `amount`.
test pp_fund_claim_carp_short() fail {
  let fin = full_fin()
  run_full_claim(
    [t_fund_in(fin, 1_000_000_000)],
    [t_fund_out(full_fout(), 0), t_ben_out(fin, 999_999_999)],
  )
}

// TẤN CÔNG: bên hưởng ghim `None` mà output mang datum.
test pp_fund_claim_datum_on_key_beneficiary() fail {
  let fin = full_fin()
  run_full_claim(
    [t_fund_in(fin, 1_000_000_000)],
    [
      t_fund_out(full_fout(), 0),
      Output { ..t_ben_out(fin, 1_000_000_000), datum: InlineDatum(t_ben_datum()) },
    ],
  )
}

// Bên hưởng là SCRIPT với datum ghim — dựng quỹ và output tương ứng.
fn script_ben_fin() -> PaidFundDatum {
  PaidFundDatum {
    ..full_fin(),
    beneficiary: t_ben_script_addr(),
    beneficiary_datum: Some(t_ben_datum()),
  }
}

fn script_ben_fout() -> PaidFundDatum {
  PaidFundDatum {
    ..full_fout(),
    beneficiary: t_ben_script_addr(),
    beneficiary_datum: Some(t_ben_datum()),
  }
}

fn run_script_ben_claim(ben_out: Output) -> Bool {
  let fin = script_ben_fin()
  run_fund(
    fin, 1_000_000_000,
    t_tx(
      [t_fund_in(fin, 1_000_000_000)],
      [t_fund_out(script_ben_fout(), 0), ben_out],
      [t_platform],
    ),
    FundClaim { amount_carpdrop: 1_000_000_000 },
  )
}

// happy: bên hưởng là script, output mang ĐÚNG datum ghim.
test pp_fund_claim_script_beneficiary_ok() {
  run_script_ben_claim(t_ben_out(script_ben_fin(), 1_000_000_000))
}

// TẤN CÔNG ("rót đúng địa chỉ, ngoài sổ"): bên hưởng là script, output KHÔNG datum.
test pp_fund_claim_script_beneficiary_no_datum() fail {
  run_script_ben_claim(
    Output { ..t_ben_out(script_ben_fin(), 1_000_000_000), datum: NoDatum },
  )
}

// TẤN CÔNG: bên hưởng là script, output mang datum KHÁC datum ghim.
test pp_fund_claim_script_beneficiary_wrong_datum() fail {
  let other: Data = #"0c0c"
  run_script_ben_claim(
    Output { ..t_ben_out(script_ben_fin(), 1_000_000_000), datum: InlineDatum(other) },
  )
}

// TẤN CÔNG: một nhánh spend quỹ đổi đích (bất biến ở `fund_common_checks`).
test pp_fund_beneficiary_changed() fail {
  let fin = full_fin()
  let fout = PaidFundDatum { ..full_fout(), beneficiary: address.from_verification_key(t_stranger) }
  run_full_claim(
    [t_fund_in(fin, 1_000_000_000)],
    [t_fund_out(fout, 0), t_ben_out(fin, 1_000_000_000)],
  )
}

test pp_fund_beneficiary_datum_changed() fail {
  let fin = full_fin()
  let fout = PaidFundDatum { ..full_fout(), beneficiary_datum: Some(t_ben_datum()) }
  run_full_claim(
    [t_fund_in(fin, 1_000_000_000)],
    [t_fund_out(fout, 0), t_ben_out(fin, 1_000_000_000)],
  )
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

const ms_ep: Int = 86_400_000   // Preview (Preprod nay 432_000_000, từ 2026-09-20)

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
// lặng ngay lần thêm bài kế tiếp. Chính khối này đã dính đúng thế một lần (ghi
// "MƯỜI" khi `DESIGN.md` ghi 12), và lần thêm nhánh `SetDidCommit` vừa rồi lại
// làm con số đổi — đó là lý do nó không được nằm ở đây.

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

// Datum genesis SẠCH: mọi cần gạt ở trạng thái khởi tạo, kể cả `did_commit`.
fn t_genesis_vd() -> PrepaidVaultDatum {
  PrepaidVaultDatum {
    owner: VerificationKey(t_owner),
    did_commit: #"",
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

// TẤN CÔNG: khai sẵn cam kết DID lúc tạo vault.
//
// Đây là ca ĐẮT NHẤT trong nhóm mint, vì nó không hoàn tác được: C-PP-8 ép
// `out.did_commit == datum.did_commit` ở cả năm nhánh spend còn lại, nên một cam
// kết bịa lọt qua cổng đúc là bịa VĨNH VIỄN — vault đó chỉ có thể bị bỏ đi. Giá
// trị dùng ở đây ĐÚNG KHUÔN 32 byte có chủ ý: nếu nó sai khuôn thì bài không
// phân biệt được "cổng chặn vì khác rỗng" với "cổng chặn vì sai độ dài", mà cổng
// độ dài thì không tồn tại ở nhánh mint.
test pp_mint_did_preset() fail {
  let vd = PrepaidVaultDatum { ..t_genesis_vd(), did_commit: t_did }
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
    [t_owner],   // mở dòng mới ⟹ owner (C-PP-9 siết 2026-09-26)
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

// Dựng ở dạng XOÁ (2026-09-16): nhánh `SetDelegate` nay chỉ xoá được, nên bộ
// bài "nhánh 5/5" phải đi qua dạng còn sống, không thì nó đo cổng bia-mộ chứ
// không đo cổng NFT định danh vault mà nó mang tên.
fn sp_setdel_din() -> PrepaidVaultDatum {
  PrepaidVaultDatum {
    ..t_vd([t_credit(t_fund_id, 10)], []),
    personal_delegate: Some(t_delegate),
  }
}

fn sp_setdel_dout() -> PrepaidVaultDatum {
  PrepaidVaultDatum {
    ..sp_setdel_din(),
    personal_delegate: None,
    last_updated_epoch: t_epoch,
  }
}

fn sp_setdel_run(vin: Input, vout: Output) -> Bool {
  run_spend(
    sp_setdel_din(),
    SetDelegate { new_delegate: None },
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

// ── Nhánh 6/6 — SetDidCommit ──────────────────────────────────
// Nhánh mới KHÔNG phải tự nhớ gọi `vault_identity_preserved`: cổng nằm ở thân
// handler `spend`, trước `when redeemer is`. Ba bài dưới đây là phép ĐO câu đó,
// không phải một lời khai về nó.

fn sp_setdid_din() -> PrepaidVaultDatum {
  sd_din()
}

fn sp_setdid_dout() -> PrepaidVaultDatum {
  sd_dout(t_did)
}

fn sp_setdid_run(vin: Input, vout: Output) -> Bool {
  run_spend(
    sp_setdid_din(),
    SetDidCommit { did_commit: t_did },
    branch_tx(vin, vout, [], [], [t_owner]),
  )
}

test pp_spend_setdidcommit_ok() {
  sp_setdid_run(t_vault_in(sp_setdid_din()), t_vault_out(sp_setdid_dout()))
}

test pp_spend_setdidcommit_forged_vault() fail {
  sp_setdid_run(
    t_vault_in_no_nft(sp_setdid_din()), t_vault_out_no_nft(sp_setdid_dout()),
  )
}

test pp_spend_setdidcommit_nft_escapes() fail {
  sp_setdid_run(t_vault_in(sp_setdid_din()), t_vault_out_no_nft(sp_setdid_dout()))
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
    beneficiary: t_ben_addr(),
    beneficiary_datum: None,
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

fn run_fund_mint_signed(
  outs    : List<Output>,
  m       : Value,
  signers : List<ByteArray>,
) -> Bool {
  paid_fund.mint(
    t_carp_policy, t_carp_name, ms_ep,
    Void, t_fund_hash,
    Transaction {
      ..placeholder,
      inputs: [fg_seed_input()],
      outputs: outs,
      mint: m,
      extra_signatories: signers,
    },
  )
}

// Mặc định platform KÝ (genesis đòi từ 2026-09-26) — các bài tấn công cũ nhờ vậy
// chỉ đỏ vì vế chúng canh.
fn run_fund_mint(outs: List<Output>, m: Value) -> Bool {
  run_fund_mint_signed(outs, m, [t_platform])
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

// ── Genesis quỹ — L1'' (2026-09-26) ───────────────────────────
// Mỗi bài đổi ĐÚNG MỘT yếu tố so với `fg_mint_ok`.

// TẤN CÔNG (quỹ mạo danh): lập quỹ mang pkh của platform thật mà platform không ký.
test fg_mint_no_platform_sig() fail {
  let name = fg_name()
  run_fund_mint_signed(
    [fg_carrier(name, fg_clean())],
    assets.from_asset(t_fund_hash, name, 1),
    [t_stranger],
  )
}

fn fg_mint_ben(ben: Address, ben_datum: Option<Data>) -> Bool {
  fg_mint_with(
    PaidFundDatum { ..fg_clean(), beneficiary: ben, beneficiary_datum: ben_datum },
  )
}

// TẤN CÔNG: bên hưởng mang stake credential.
test fg_mint_beneficiary_stake_set() fail {
  fg_mint_ben(t_ben_addr() |> address.with_delegation_key(t_stranger), None)
}

// TẤN CÔNG: bên hưởng là chính script quỹ (datum có, để chỉ vế này đỏ).
test fg_mint_beneficiary_is_fund_script() fail {
  fg_mint_ben(address.from_script(t_fund_hash), Some(t_ben_datum()))
}

// TẤN CÔNG: bên hưởng là script vault mà quỹ trỏ tới (datum có).
test fg_mint_beneficiary_is_vault_script() fail {
  fg_mint_ben(address.from_script(t_vault_hash), Some(t_ben_datum()))
}

// happy: bên hưởng là một script khác, có datum ghim.
test fg_mint_script_beneficiary_with_datum_ok() {
  fg_mint_ben(t_ben_script_addr(), Some(t_ben_datum()))
}

// TẤN CÔNG: bên hưởng là script mà KHÔNG ghim datum (cặp của bài trên).
test fg_mint_script_beneficiary_no_datum() fail {
  fg_mint_ben(t_ben_script_addr(), None)
}

// happy: bên hưởng là khoá thường, có ghim datum — cho phép (khoá tiêu được bất kể datum).
test fg_mint_key_beneficiary_with_datum_ok() {
  fg_mint_ben(t_ben_addr(), Some(t_ben_datum()))
}

// TẤN CÔNG: hash của bên hưởng sai độ dài ⟹ không output nào đỗ được ở đó.
test fg_mint_beneficiary_bad_hash_length() fail {
  fg_mint_ben(
    Address { payment_credential: VerificationKey(#"bebe"), stake_credential: None },
    None,
  )
}

// ══════════════════════════════════════════════════════════════
// CHỦ LÀ `Credential` — `owner_authorized` trên genesis + hai nhánh spend
//   Mỗi bài âm khác cặp dương của nó ĐÚNG MỘT biến (mục rút hoặc danh sách ký),
//   nên nó chỉ đỏ được ở cổng owner. Cổng `platform` của quỹ KHÔNG đổi (vẫn pkh).
// ══════════════════════════════════════════════════════════════

const t_owner_script: ByteArray =
  #"5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c"

const t_other_script: ByteArray =
  #"5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d"

fn with_withdrawals(tx: Transaction, wds: Pairs<Credential, Int>) -> Transaction {
  Transaction { ..tx, withdrawals: wds }
}

// ── genesis ──
fn oc_mint_tx(owner: Credential, signers: List<ByteArray>) -> Transaction {
  let name = t_vault_nft()
  t_mint_tx(
    [t_seed_input(t_seed_ref())],
    [t_genesis_out(PrepaidVaultDatum { ..t_genesis_vd(), owner: owner }, name)],
    assets.from_asset(t_vault_hash, name, 1),
    signers,
  )
}

test pp_owner_script_mint_withdraw_zero_ok() {
  run_mint(
    t_seed_ref(),
    with_withdrawals(
      oc_mint_tx(Script(t_owner_script), []),
      [Pair(Script(t_owner_script), 0)],
    ),
  )
}

test pp_owner_script_mint_no_withdrawal_rejected() fail {
  run_mint(t_seed_ref(), oc_mint_tx(Script(t_owner_script), []))
}

test pp_owner_script_mint_other_withdrawal_rejected() fail {
  run_mint(
    t_seed_ref(),
    with_withdrawals(
      oc_mint_tx(Script(t_owner_script), []),
      [Pair(Script(t_other_script), 0)],
    ),
  )
}

test pp_owner_script_mint_hash_in_signatories_rejected() fail {
  run_mint(t_seed_ref(), oc_mint_tx(Script(t_owner_script), [t_owner_script]))
}

test pp_owner_vk_mint_script_withdrawal_unsigned_rejected() fail {
  run_mint(
    t_seed_ref(),
    with_withdrawals(
      oc_mint_tx(VerificationKey(t_owner), []),
      [Pair(Script(t_owner), 0)],
    ),
  )
}

// ── spend: SetDidCommit (`validate_set_did_commit`, gọi thẳng `owner_authorized`) ──
fn oc_sd_din(owner: Credential) -> PrepaidVaultDatum {
  PrepaidVaultDatum { ..sd_din(), owner: owner }
}

fn oc_sd_tx(owner: Credential, signers: List<ByteArray>) -> Transaction {
  let din = oc_sd_din(owner)
  let dout = PrepaidVaultDatum { ..din, did_commit: t_did, last_updated_epoch: t_epoch }
  sd_tx(din, dout, signers)
}

test pp_owner_script_setdid_withdraw_zero_ok() {
  let owner = Script(t_owner_script)
  run_setdid(
    oc_sd_din(owner), t_did,
    with_withdrawals(oc_sd_tx(owner, []), [Pair(Script(t_owner_script), 0)]),
  )
}

test pp_owner_script_setdid_no_withdrawal_rejected() fail {
  let owner = Script(t_owner_script)
  run_setdid(oc_sd_din(owner), t_did, oc_sd_tx(owner, []))
}

test pp_owner_script_setdid_other_withdrawal_rejected() fail {
  let owner = Script(t_owner_script)
  run_setdid(
    oc_sd_din(owner), t_did,
    with_withdrawals(oc_sd_tx(owner, []), [Pair(Script(t_other_script), 0)]),
  )
}

test pp_owner_script_setdid_hash_in_signatories_rejected() fail {
  let owner = Script(t_owner_script)
  run_setdid(oc_sd_din(owner), t_did, oc_sd_tx(owner, [t_owner_script]))
}

test pp_owner_vk_setdid_script_withdrawal_unsigned_rejected() fail {
  let owner = VerificationKey(t_owner)
  run_setdid(
    oc_sd_din(owner), t_did,
    with_withdrawals(oc_sd_tx(owner, []), [Pair(Script(t_owner), 0)]),
  )
}

// ── spend: PrepaidDraw (`authed_owner`) ──
fn oc_draw_din(owner: Credential) -> PrepaidVaultDatum {
  PrepaidVaultDatum { ..t_vd([t_credit(t_fund_id, 5_000_000_000)], []), owner: owner }
}

fn oc_draw_tx(owner: Credential, signers: List<ByteArray>) -> Transaction {
  let din = oc_draw_din(owner)
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
  t_tx([t_vault_in(din)], [t_vault_out(dout)], signers)
}

test pp_owner_script_draw_withdraw_zero_ok() {
  let owner = Script(t_owner_script)
  run_draw(
    oc_draw_din(owner), draw_amt,
    with_withdrawals(oc_draw_tx(owner, []), [Pair(Script(t_owner_script), 0)]),
  )
}

test pp_owner_script_draw_no_withdrawal_rejected() fail {
  let owner = Script(t_owner_script)
  run_draw(oc_draw_din(owner), draw_amt, oc_draw_tx(owner, []))
}

test pp_owner_script_draw_other_withdrawal_rejected() fail {
  let owner = Script(t_owner_script)
  run_draw(
    oc_draw_din(owner), draw_amt,
    with_withdrawals(oc_draw_tx(owner, []), [Pair(Script(t_other_script), 0)]),
  )
}

test pp_owner_script_draw_hash_in_signatories_rejected() fail {
  let owner = Script(t_owner_script)
  run_draw(oc_draw_din(owner), draw_amt, oc_draw_tx(owner, [t_owner_script]))
}

test pp_owner_vk_draw_script_withdrawal_unsigned_rejected() fail {
  let owner = VerificationKey(t_owner)
  run_draw(
    oc_draw_din(owner), draw_amt,
    with_withdrawals(oc_draw_tx(owner, []), [Pair(Script(t_owner), 0)]),
  )
}

// Cặp dương của bài trên: cùng tx, CHỈ thêm chữ ký pkh ⟹ nhận (mục rút thừa vô hại).
test pp_owner_vk_draw_signed_with_script_withdrawal_ok() {
  let owner = VerificationKey(t_owner)
  run_draw(
    oc_draw_din(owner), draw_amt,
    with_withdrawals(oc_draw_tx(owner, [t_owner]), [Pair(Script(t_owner), 0)]),
  )
}
