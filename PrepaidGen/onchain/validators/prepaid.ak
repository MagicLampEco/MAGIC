// validators/prepaid.ak — PrepaidGen: prepaid_vault + paid_fund
// Normative: MagicLamp-Tripletoken-Feat-(Vi).md §4.2, §6.5, §7.3, §7.4, §7.6,
//            §11, §12; Carpet-CARP-DacTa-Vi.md §5.1 (F2); C-PP-1..15 (DESIGN.md).
// PlutusV3 / Aiken ≥ 1.1.x
//
// HAI SCRIPT, THẨM QUYỀN TÁCH BẠCH (mỗi delta có ĐÚNG MỘT bên kiểm toàn bộ):
//   PrepaidLock  → VAULT có thẩm quyền trên cả delta quỹ lẫn delta hạn-mức;
//                  quỹ chỉ chứng minh "có vault thật cùng tiêu bằng constr 0".
//   PrepaidDraw  → VAULT (quỹ không tham gia giao dịch → không tranh chấp UTxO).
//   BurnBatch    → VAULT (ConsumeMAGIC ép Σburns == required ở tầng trên). KHÔNG
//                  chạm quỹ: phần đã đốt được GHI NỢ vào
//                  `PrepaidCredit.consumed_unsettled` của dòng tương ứng.
//   PrunePrepaid → VAULT, permissionless.
//   SettleLine   → VAULT có thẩm quyền trên cả delta quỹ lẫn delta sổ nợ; quỹ
//                  đối chiếu lại bằng chính cặp datum vault vào/ra.
//                  Permissionless — xem `types.ak` ▸ `SettleLine`.
//   FundSettle   → QUỸ: đọc thẳng cặp datum vault vào/ra, đòi vault cùng tiêu
//                  bằng constr 6.
//   FundClaim    → QUỸ.
//
// VÌ SAO TÁCH ĐỐT KHỎI QUYẾT TOÁN (2026-09-28). Bản trước ghép `FundSettle` vào
// chính giao dịch `BurnBatch` và đo delta bằng phần `current_amount` giảm TRONG
// giao dịch đó. Hai chỗ hỏng, cả hai im lặng: (1) `BurnBatch` không kèm quỹ vẫn
// được nhận, và phần MAGIC đã đốt ấy mất dấu vĩnh viễn — CARP đối ứng kẹt trong
// quỹ, provider không đòi được (F2), người dùng không lấy lại được, `outstanding`
// phình mãi nên đường "tiêu hết rồi rút hết" của §6.1 không bao giờ tới đích;
// (2) `paid_fund.spend` ép ĐÚNG MỘT quỹ input mỗi giao dịch, nên một lượt đốt
// chạm batch của hai quỹ chỉ quyết toán được một. Nay `BurnBatch` ghi nợ vào
// datum vault và `SettleLine` trả nợ từng quỹ một, mỗi quỹ một giao dịch, lúc
// nào cũng được.
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
use cardano/certificate.{Certificate, UnregisterCredential}
use cardano/transaction.{
  Datum, DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference,
  ScriptPurpose, Spend,
  Transaction,
  placeholder,
}

use magiclamp/protocol/owner_auth.{owner_authorized}
use magiclamp/protocol/window_origin_fixtures
use magiclamp/protocol/types.{
  BurnBatch, CloseSponsoredLine, FundClaim, FundLock, FundReclaim, FundSettle,
  MagicBatch, MintVaultId,
  PaidFundDatum, PaidFundRedeemer, PrepaidCredit, PrepaidDraw, PrepaidLock,
  PrepaidVaultDatum, PrepaidVaultIdRedeemer, PrepaidVaultRedeemer, PrunePrepaid,
  SetDelegate, SetDidCommit, SettleLine, Sponsorship, VaultAttribution,
}
use magiclamp/protocol/constants.{
  batch_source_prepaid, max_batches_per_vault, max_prepaid_credits,
  min_buffer_bps, min_draw_carpdrop, min_lock_carpdrop, prepaid_decay_window,
  prepaid_profile, sponsor_reclaim_delay_epochs,
}
use magiclamp/protocol/math.{
  buffer_floor, compute_batch_id, compute_fund_id, outstanding_effective,
  par_carp_from_magic, par_magic_from_carp, reclaim_outstanding,
}

// Constructor index của các nhánh redeemer — dùng khi đọc redeemer của script
// KHÁC qua builtin.un_constr_data (không ghép kiểu chéo validator).
const rd_prepaid_lock: Int = 0
const rd_settle_line: Int = 6  // quyết toán một dòng hạn-mức (thêm 2026-09-28)
// `WakemeRedeemer` của két Wakeme (`PhoenixKeyDID/Wakeme` ▸ `wakeme_logic.ak`):
// `OwnEpoch` 0 · `ReclaimEpoch` 1 · `Repin` 2, chỉ nối cuối.
const rd_wakeme_reclaim_epoch: Int = 1
// `PaidFundRedeemer::FundReclaim` — handler `mint` đọc redeemer spend của quỹ
// theo chỉ số khi xét một lượt ĐỐT NFT quỹ.
const rd_fund_reclaim: Int = 3
// `PaidFundRedeemer::FundClaim` — lượt rút cuối của quỹ tài trợ đã thu hồi cũng đốt
// NFT quỹ (DESIGN-reclaim §10.11, vá kẹt min-ADA).
const rd_fund_claim: Int = 2
// `PrepaidVaultRedeemer::CloseSponsoredLine` — quỹ đọc redeemer spend của vault
// theo chỉ số ở `FundReclaim` (DESIGN-reclaim §10.11).
const rd_close_sponsored_line: Int = 7

// ══════════════════════════════════════════════════════════════
// prepaid_vault
// ══════════════════════════════════════════════════════════════
// `ms_per_epoch`: Mainnet 432_000_000 · Preprod 432_000_000 · Preview 86_400_000.
// (Preprod đổi 86_400_000 → 432_000_000 ngày 2026-09-20 để trùng nhịp mạng thật.)
// `window_origin_ms` (apply-param CUỐI của cả `prepaid_vault` lẫn `paid_fund`): gốc lưới
// cửa sổ theo mạng, LAMP `Specs/Window/CONTRACT.md` v1.0. Epoch = (t − gốc) / ms_per_epoch.
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
  window_origin_ms : Int,
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
    let current_epoch = get_epoch(tx, ms_per_epoch, window_origin_ms)
    let vault_addr = own_addr(own_ref, tx.inputs)

    // C-PP-10: đúng một vault input ở SCRIPT này — đếm theo payment credential
    // (G3V 2026-10-08): `Script(h)` kèm stake lạ là địa chỉ khác nhưng cùng script.
    expect
      list.count(
        tx.inputs,
        fn(i) { i.output.address.payment_credential == vault_addr.payment_credential },
      ) == 1

    // INV-VAULT-IDENTITY — ĐIỂM NGHẼN DUY NHẤT, ép cho MỌI nhánh redeemer (tám nhánh
    // từ 2026-10-04, kể cả `CloseSponsoredLine`).
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

      SettleLine { fund_id } ->
        validate_settle_line(
          datum, fund_id, current_epoch, vault_addr, carp_policy_id,
          carp_asset_name, paid_fund_hash, tx,
        )

      CloseSponsoredLine { fund_id } ->
        validate_close_sponsored_line(
          datum, fund_id, current_epoch, vault_addr, carp_policy_id,
          carp_asset_name, paid_fund_hash, tx,
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
// `wakeme_vault_hash` (nối cuối 2026-10-04, DESIGN-reclaim §10.5): script hash của két
// Wakeme — MỘT hash cho mọi DID ⟹ đổi theo LOẠI (bản deploy Wakeme của mạng), không
// theo từng quỹ. KHÔNG BAO GIỜ lấy từ chỗ người dựng giao dịch chọn được.
validator paid_fund(
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  ms_per_epoch    : Int,
  window_origin_ms : Int,
  wakeme_vault_hash : crypto.ScriptHash,
) {
  // ── mint: policy NFT định danh quỹ (policy_id == script hash này) ────────
  // Hai đường, rẽ theo DẤU của lượng duy nhất dưới policy này:
  //   · `-1` ⟹ ĐỐT: chỉ hợp lệ khi chính quỹ mang NFT đó bị tiêu bằng
  //     `FundReclaim` ở nhánh đóng (`validate_burn_fund_nft`); nhánh spend ép
  //     phần còn lại (E = 0, đích, lượng).
  //   · mọi lượng khác ⟹ genesis (`validate_mint_fund_nft` ép đúng `+1`). Nên mọi
  //     lượng âm KHÁC `-1` vẫn chết ở đó như trước.
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    expect [Pair(name, qty)] = assets.tokens(tx.mint, policy_id) |> dict.to_pairs
    if qty == -1 {
      validate_burn_fund_nft(name, policy_id, tx)
    } else {
      validate_mint_fund_nft(policy_id, ms_per_epoch, window_origin_ms, tx)
    }
  }

  spend(
    datum_opt : Option<PaidFundDatum>,
    redeemer  : PaidFundRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(fund_in) = datum_opt
    let current_epoch = get_epoch(tx, ms_per_epoch, window_origin_ms)
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

    // NHÁNH ĐÓNG (2026-10-04, đóng `CC-RECLAIM-FUND-CLOSE`): `FundReclaim` mà phần
    // còn nợ provider `E = carp_locked − R` bằng 0 thì quỹ tiếp nối là thứ KHÔNG
    // nhánh nào tiêu lại được (DESIGN-reclaim §10.8) — nên ở E = 0 đóng là BẮT
    // BUỘC, không phải tuỳ chọn của người dựng giao dịch: để tuỳ chọn thì một
    // người gửi bất kỳ (nhánh này permissionless) chọn hình dạng tiếp nối và khoá
    // min-ADA của bên tài trợ vĩnh viễn. Rẽ theo DATUM, không theo hình dạng tx.
    //
    // `u` (2026-10-04, `CC-RECLAIM-VAULT-LINE`): nợ quyết toán của dòng hạn-mức bị
    // gỡ ở vault cùng giao dịch — đã tiêu, sổ quỹ còn thiếu. Nó vào `magic_settled`
    // TRƯỚC khi tính R, nên quyết định "đóng hay tiếp nối" cũng phải tính bằng nó.
    //
    // NHÁNH ĐÓNG thứ hai (2026-10-04, vá kẹt min-ADA): `FundClaim` rút TRỌN
    // `carp_locked` của quỹ đã thu hồi. Quỹ đó không còn nhận nạp (`FundLock`
    // chặn) và không còn dòng nào ở vault (đã gỡ cùng `FundReclaim`), nên một quỹ
    // tiếp nối với `carp_locked = 0` là thứ không nhánh nào tiêu lại được ⟹ đóng là
    // BẮT BUỘC, rẽ theo datum + lượng rút.
    when redeemer is {
      FundReclaim -> {
        let u = reclaim_unsettled(fund_in, tx)
        if fund_in.carp_locked == reclaim_amount(fund_in, u) {
          validate_fund_close(
            fund_in, own_in, fund_nft_policy, carp_policy_id, carp_asset_name,
            wakeme_vault_hash, current_epoch, u, tx,
          )
        } else {
          // C-PP-13
          expect no_fund_mint(tx, fund_nft_policy)
          fund_common_checks(
            fund_in, own_in, fund_addr, carp_policy_id, carp_asset_name,
            fund_nft_policy, current_epoch, wakeme_vault_hash, u, redeemer, tx,
          )
        }
      }
      FundClaim { amount_carpdrop } ->
        // MUT-H-CLAIMCLOSE
        if fund_in.sponsor_reclaimed > 0 && amount_carpdrop == fund_in.carp_locked {
          validate_fund_claim_close(
            fund_in, own_in, fund_nft_policy, amount_carpdrop, carp_policy_id,
            carp_asset_name, tx,
          )
        } else {
          // C-PP-13
          expect no_fund_mint(tx, fund_nft_policy)
          fund_common_checks(
            fund_in, own_in, fund_addr, carp_policy_id, carp_asset_name,
            fund_nft_policy, current_epoch, wakeme_vault_hash, 0, redeemer, tx,
          )
        }
      _ -> {
        // C-PP-13: không đúc/đốt token của policy NFT quỹ trong giao dịch vận hành
        expect no_fund_mint(tx, fund_nft_policy)
        fund_common_checks(
          fund_in, own_in, fund_addr, carp_policy_id, carp_asset_name,
          fund_nft_policy, current_epoch, wakeme_vault_hash, 0, redeemer, tx,
        )
      }
    }
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
  wakeme_vault_hash : ByteArray,
  // `consumed_unsettled` của dòng bị gỡ ở vault — chỉ `FundReclaim` dùng; các
  // nhánh khác nhận 0 và không đọc.
  reclaim_u       : Int,
  redeemer        : PaidFundRedeemer,
  tx              : Transaction,
) -> Bool {
  // Đúng MỘT output mang NFT quỹ, và nó phải ở lại địa chỉ quỹ.
  let fund_out_utxo =
    find_fund_output_utxo(tx.outputs, fund_nft_policy, fund_in.fund_id)
  expect fund_out_utxo.address == fund_addr
  // G3V (2026-10-08): output tiếp nối là output DUY NHẤT ở script quỹ (đếm theo
  // payment credential). `find_fund_output_utxo` chỉ đếm output MANG NFT, nên bản
  // trước để lọt output thứ hai ở script quỹ không NFT — UTxO chết.
  expect
    list.count(tx.outputs, fn(o) { is_at_script(o.address, fund_nft_policy) }) == 1
  let fund_out = decode_fund(fund_out_utxo)

  // ── UTxO quỹ tiếp nối phải giữ đúng HÌNH DẠNG của quỹ ────────────────────
  // Genesis (`validate_mint_fund_nft`) đã ép đủ bốn vế này, nhưng nhánh spend
  // thì chưa — nên một lượt vận hành hợp lệ vẫn đẻ ra được một quỹ méo, và mọi
  // lượt sau kế thừa nó. Bốn vế, mỗi vế đóng một đường khác nhau:
  //
  //   · `reference_script == None` — ref-script đội min-ADA của UTxO lên, mà
  //     `carp_locked` không đổi theo ADA nên phần ADA ấy khoá vĩnh viễn: không
  //     nhánh nào rút ADA khỏi quỹ. Khoá-vốn im lặng, không phải lỗi giao dịch.
  //   · `lovelace(out) >= lovelace(in)` — không ai rút bớt ADA tối thiểu của
  //     quỹ. Nạp thêm thì được.
  //   · `single_nft_name(out) == fund_id` — `find_fund_output_utxo` dùng
  //     `quantity_of`, nó trả lời "có đúng NFT đó", KHÔNG trả lời "chỉ có NFT
  //     đó"; chênh lệch giữa hai câu là một tên thứ hai dưới chính policy quỹ,
  //     mà cổng đếm policy ngay dưới đếm POLICY nên không thấy.
  //   · `|policies(out)| <= 3` — nhiều nhất {ADA, CARP, NFT quỹ}. Policy thứ
  //     tư chỉ có thể là bụi token nhét vào cho phình value.
  expect fund_out_utxo.reference_script == None
  expect
    assets.lovelace_of(fund_out_utxo.value) >= assets.lovelace_of(
      own_in.output.value,
    )
  expect single_nft_name(fund_out_utxo.value, fund_nft_policy) == fund_in.fund_id
  expect list.length(assets.policies(fund_out_utxo.value)) <= 3

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
  // Bên tài trợ + DID được tài trợ (DESIGN-reclaim §10.7): ghim genesis, bất biến ở
  // MỌI nhánh tiếp nối. Đổi `sponsor` giữa chừng là đổi đích của `FundReclaim`.
  expect fund_out.sponsorship == fund_in.sponsorship
  expect fund_out.last_updated_epoch == current_epoch

  // C-PP-3: carp_locked == credit_issued − provider_claimed − sponsor_reclaimed
  // (đúng từ genesis 0/0/0/0).
  expect
    fund_out.carp_locked == fund_out.credit_issued - fund_out.provider_claimed - fund_out.sponsor_reclaimed

  when redeemer is {
    FundLock -> validate_fund_lock(fund_in, fund_out, tx)
    FundSettle -> validate_fund_settle(fund_in, fund_out, tx)
    FundClaim { amount_carpdrop } ->
      validate_fund_claim(
        fund_in, fund_out, amount_carpdrop, carp_policy_id, carp_asset_name, tx,
      )
    FundReclaim ->
      validate_fund_reclaim(
        fund_in, fund_out, wakeme_vault_hash, carp_policy_id, carp_asset_name,
        current_epoch, reclaim_u, tx,
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

  // ── Quỹ TÀI TRỢ (DESIGN-reclaim §10.11, LỖ 3 + một-dòng) ───────────────
  // (a) Dòng của quỹ tài trợ chỉ nằm ở vault đã gắn ĐÚNG DID được tài trợ. Không
  //     có vế này thì dòng của quỹ DID A nằm được ở vault DID B, và hạn-mức bên
  //     tài trợ cấp cho A do B tiêu.
  // (b) Quỹ tài trợ có TỐI ĐA MỘT dòng trọn đời: chỉ được MỞ dòng khi quỹ chưa
  //     cấp đồng nào (`credit_issued == 0`). Đây là thứ cho `FundReclaim` chứng
  //     minh được trên chuỗi "dòng nào đang tồn tại": mọi lượt mở dòng đi cùng
  //     một `FundLock` làm `credit_issued` tăng ≥ `min_lock_carpdrop` (bốn
  //     redeemer quỹ khác đều mâu thuẫn delta với nhánh này), và dòng chỉ bị gỡ
  //     ở `CloseSponsoredLine`. Nên `credit_issued == 0` ⟺ chưa từng có dòng;
  //     `credit_issued > 0` ⟹ đúng một dòng — và nó là dòng `FundReclaim` đòi
  //     gỡ cùng giao dịch. Nạp THÊM vào dòng đã có thì không bị chặn.
  expect
    when fund_in.sponsorship is {
      None -> True
      Some(s) -> {
        // MUT-B-NONEMPTY
        expect datum.did_commit != #""
        // MUT-B-DID
        expect datum.did_commit == s.owner_commit
        // MUT-B-ONE-LINE
        expect !opens_new_line || fund_in.credit_issued == 0
        True
      }
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
  // DESIGN-reclaim §10.7: vault có thẩm quyền trên delta quỹ của PrepaidLock nên
  // phải tự ghim hai trường tài trợ, cùng chỗ với hai dòng `beneficiary`.
  expect fund_out.sponsorship == fund_in.sponsorship
  expect fund_out.sponsor_reclaimed == fund_in.sponsor_reclaimed
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
          // Dòng mới chưa đốt gì ⟹ chưa nợ quỹ đồng nào.
          consumed_unsettled: 0,
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
          // Chỉ hai trường này đổi. `consumed_unsettled` là sổ nợ của QUỸ — chỉ
          // `BurnBatch` cộng, chỉ `SettleLine` đưa về 0 (C-PP-7). Bản trước đặt
          // cứng về 0 ở đây ⟹ rút 1 CARP là xoá nợ, CARP đối ứng kẹt trong quỹ.
          // Gương: `offchain/src/prepaid.ts` ▸ `drawMagic`.
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

  // Đốt và GHI NỢ trong cùng một lượt duyệt: mỗi `amt` vừa trừ khỏi batch vừa
  // cộng vào `consumed_unsettled` của dòng hạn-mức mà batch ấy thuộc về. Hai
  // việc phải đi cùng một hàm, không tách ra hai lượt duyệt — tách là mở đúng
  // khe mà bản trước để hở: một bên đo trên danh sách đã rút gọn, bên kia đo
  // trên danh sách gốc, và hai bên lệch nhau đúng ở ca đốt trọn một batch.
  let (expected_batches, expected_credits) =
    apply_burns(datum.magic_batches, datum.prepaid_credits, burns, current_epoch)

  let out = get_vault_output(tx.outputs, vault_addr)
  expect out.owner == datum.owner
  expect out.did_commit == datum.did_commit         // C-PP-8
  expect out.prepaid_credits == expected_credits
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
// giảm current_amount, bỏ batch khi về 0; mọi trường khác bất biến. Song song
// đó, cộng `amt` vào `consumed_unsettled` của dòng hạn-mức có `fund_id ==
// batch.contract_id` — dòng đó PHẢI tồn tại đúng một (batch chỉ sinh ra từ
// `PrepaidDraw`, nhánh đòi đúng một dòng, và dòng không bao giờ bị xoá). Thiếu
// dòng ⟹ `expect` vỡ, KHÔNG âm thầm bỏ qua: bỏ qua là đốt MAGIC mà không ai nợ
// ai, tức đúng lỗ vừa vá.
fn apply_burns(
  batches       : List<MagicBatch>,
  credits       : List<PrepaidCredit>,
  burns         : List<(ByteArray, Int)>,
  current_epoch : Int,
) -> (List<MagicBatch>, List<PrepaidCredit>) {
  when burns is {
    [] -> (batches, credits)
    [(bid, amt), ..rest] -> {
      expect amt > 0
      expect list.count(batches, fn(b) { b.batch_id == bid }) == 1
      expect Some(target) = list.find(batches, fn(b) { b.batch_id == bid })
      // C-PP-5: batch của epoch đã chết KHÔNG tiêu được.
      expect target.created_epoch == current_epoch
      expect amt <= target.current_amount
      let reduced =
        list.filter_map(
          batches,
          fn(b) {
            if b.batch_id == bid {
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
      let credited = add_consumed(credits, target.contract_id, amt)
      apply_burns(reduced, credited, rest, current_epoch)
    }
  }
}

// Ghi nợ `amt` nanogic vào dòng hạn-mức của `fund_id`. Đúng MỘT dòng, không hơn
// không kém — `list.count(...) == 1` là chỗ duy nhất trong nhánh đốt biết được
// rằng số vừa đốt có một chỗ để đi về.
fn add_consumed(
  credits : List<PrepaidCredit>,
  fund_id : ByteArray,
  amt     : Int,
) -> List<PrepaidCredit> {
  expect list.count(credits, fn(c) { c.fund_id == fund_id }) == 1
  list.map(
    credits,
    fn(c) {
      if c.fund_id == fund_id {
        PrepaidCredit { ..c, consumed_unsettled: c.consumed_unsettled + amt }
      } else {
        c
      }
    },
  )
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
// VAULT — SettleLine (C-PP-7, INV-MAGIC-CITIZEN) — TRẢ NỢ QUYẾT TOÁN
// ══════════════════════════════════════════════════════════════
// Đưa `consumed_unsettled` của MỘT dòng hạn-mức về 0 và cộng đúng bằng ấy vào
// `magic_settled` của quỹ tương ứng, trong cùng giao dịch.
//
// KHÔNG CẦN CHỮ KÝ, cùng lý lẽ với `PrunePrepaid`: nhánh này không lấy gì của
// ai — không đồng CARP nào rời quỹ, không hạn-mức nào sinh ra, không batch nào
// đổi — nó chỉ chuyển một con số ĐÃ nằm trong datum vault sang sổ quỹ. Người
// hưởng lợi là provider, không phải chủ vault; đòi chữ ký chủ vault là đặt
// doanh thu của provider dưới thiện chí của con nợ, và đó chính là chỗ hỏng mà
// bản trước mắc (người dựng giao dịch đốt là chủ vault, không phải provider).
//
// VAULT CÓ THẨM QUYỀN trên cả hai đầu — cùng khuôn `validate_lock`. Quỹ cũng
// kiểm lại bằng `validate_fund_settle`; hai bên kiểm cùng một delta từ hai phía
// khác nhau, không bên nào tin bên nào.
fn validate_settle_line(
  datum           : PrepaidVaultDatum,
  fund_id         : ByteArray,
  current_epoch   : Int,
  vault_addr      : Address,
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  paid_fund_hash  : ByteArray,
  tx              : Transaction,
) -> Bool {
  // ── Dòng hạn-mức: đúng MỘT, và phải có nợ thật ──────────────────────────
  expect list.count(datum.prepaid_credits, fn(c) { c.fund_id == fund_id }) == 1
  expect Some(line) = list.find(datum.prepaid_credits, fn(c) { c.fund_id == fund_id })
  let delta = line.consumed_unsettled

  // reject-noop: `delta == 0` thì giao dịch không chuyển gì cả, nhưng nó VẪN
  // tiêu UTxO vault — nghĩa là một người lạ chặn cửa vault vô hạn lần mà không
  // trả giá gì ngoài phí. Cùng hình dạng reject-noop với `PrunePrepaid`.
  expect delta > 0

  let new_credits =
    list.map(
      datum.prepaid_credits,
      fn(c) {
        if c.fund_id == fund_id {
          PrepaidCredit { ..c, consumed_unsettled: 0 }
        } else {
          c
        }
      },
    )

  // ── Vault output: CHỈ dòng đó đổi ────────────────────────────────────────
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

  // ── Quỹ cùng tx: đúng địa chỉ paid_fund, mang NFT one-shot tên fund_id ───
  // Cùng khuôn `validate_lock`: `find_fund_utxo_at` ép cả địa chỉ lẫn NFT, nên
  // một "quỹ" do kẻ tấn công dựng không lọt được vào chỗ này.
  let fund_in_utxo =
    find_fund_utxo_at(
      list.map(tx.inputs, fn(i) { i.output }), paid_fund_hash, fund_id,
    )
  let fund_out_utxo = find_fund_utxo_at(tx.outputs, paid_fund_hash, fund_id)
  let fund_in = decode_fund(fund_in_utxo)
  let fund_out = decode_fund(fund_out_utxo)

  // Quỹ này phải trỏ về ĐÚNG script vault đang chạy.
  expect fund_in.vault_hash == script_hash_of(vault_addr)

  // C-PP-13
  expect no_fund_mint(tx, paid_fund_hash)

  // Delta đi vào sổ quỹ đúng bằng nợ đã xoá; ba đại lượng tiền đứng yên.
  expect fund_out.magic_settled == fund_in.magic_settled + delta
  expect fund_out.carp_locked == fund_in.carp_locked
  expect fund_out.credit_issued == fund_in.credit_issued
  expect fund_out.provider_claimed == fund_in.provider_claimed
  True
}

// ══════════════════════════════════════════════════════════════
// VAULT — CloseSponsoredLine (DESIGN-reclaim §10.11, `CC-RECLAIM-VAULT-LINE`)
// ══════════════════════════════════════════════════════════════
// Gỡ dòng hạn-mức của quỹ tài trợ `fund_id` CÙNG mọi `MagicBatch` của nó, trong
// CÙNG giao dịch mà quỹ đó bị tiêu bằng `FundReclaim`. Đóng hai lỗ:
//   · nợ quyết toán `consumed_unsettled` của dòng không bị trả nhầm cho bên tài
//     trợ — quỹ đọc nó từ datum vault đầu vào và ghi vào `magic_settled` trước khi
//     tính R (`sponsored_line_unsettled`);
//   · sau thu hồi không còn `PrepaidDraw`/`BurnBatch` nào chạy trên hạn-mức mà
//     CARP đối ứng đã rời quỹ — dòng và batch đã biến mất khỏi vault.
//
// KHÔNG cần chữ ký chủ vault: điều kiện cho phép thu hồi do validator QUỸ ép
// (`reclaim_preconditions` bước 3), theo MỘT trong hai đường — két Wakeme của DID
// `ReclaimEpoch` cùng giao dịch, HOẶC đường dự phòng (bên tài trợ ký + đã qua mốc
// `reclaim_after_epoch` ghim lúc genesis quỹ). Vault không đọc đường nào: nó chỉ
// đòi quỹ ĐÚNG `fund_id` tiêu bằng `FundReclaim` (dưới), nên mọi cổng thu hồi nằm
// trọn ở quỹ. Đòi chữ ký chủ vault là đặt việc thu hồi dưới thiện chí của chính
// người có thể đã bỏ đi.
//
// Hai phía ép lẫn nhau: vault đòi quỹ ĐÚNG `fund_id` (địa chỉ `paid_fund_hash` +
// NFT) tiêu bằng `FundReclaim`; quỹ đòi vault tiêu bằng redeemer này với ĐÚNG
// `fund_id` của nó và đọc `u` từ đúng dòng đó.
//
// Batch bị gỡ là MAGIC chưa tiêu — phần chưa giao, CARP đối ứng nằm trong R về
// bên tài trợ. Batch đã chết mà chưa `PrunePrepaid` cũng bị gỡ: hạn-mức nó trả
// lại sẽ vào dòng đã gỡ, nên phần đó vốn đã nằm trong R (R tính từ sổ quỹ, không
// từ `remaining`).
//
// KHÔNG ép `no_fund_mint`: ở nhánh đóng của `FundReclaim` NFT quỹ bị đốt trong
// chính giao dịch này; quỹ tự ép hình dạng mint của nó.
fn validate_close_sponsored_line(
  datum           : PrepaidVaultDatum,
  fund_id         : ByteArray,
  current_epoch   : Int,
  vault_addr      : Address,
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  paid_fund_hash  : ByteArray,
  tx              : Transaction,
) -> Bool {
  // ── Dòng: đúng MỘT ───────────────────────────────────────────────────────
  // MUT-V-LINE
  expect list.count(datum.prepaid_credits, fn(c) { c.fund_id == fund_id }) == 1

  // ── Quỹ cùng tx: đúng địa chỉ paid_fund, mang NFT `fund_id`, `FundReclaim` ─
  // MUT-V-FUND
  expect [fin] =
    list.filter(
      tx.inputs,
      fn(i) {
        is_at_script(i.output.address, paid_fund_hash) && assets.quantity_of(
          i.output.value,
          paid_fund_hash,
          fund_id,
        ) == 1
      },
    )
  // MUT-V-FRD
  expect spend_redeemer_constr_is(tx, fin.output_reference, rd_fund_reclaim)
  // Quỹ này phải trỏ về ĐÚNG script vault đang chạy (cùng khuôn lock/settle).
  // MUT-V-VHASH
  expect decode_fund(fin.output).vault_hash == script_hash_of(vault_addr)

  let new_credits =
    list.filter(datum.prepaid_credits, fn(c) { c.fund_id != fund_id })
  let new_batches =
    list.filter(datum.magic_batches, fn(b) { b.contract_id != fund_id })

  // ── Vault output: CHỈ dòng + batch của quỹ đổi ───────────────────────────
  let out = get_vault_output(tx.outputs, vault_addr)
  expect out.owner == datum.owner
  expect out.did_commit == datum.did_commit         // C-PP-8
  // MUT-V-CREDITS
  expect out.prepaid_credits == new_credits
  // MUT-V-BATCHES
  expect out.magic_batches == new_batches
  expect out.next_batch_index == datum.next_batch_index
  expect out.personal_delegate == datum.personal_delegate
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
  // Quỹ đã khép (`FundReclaim` đã chạy) không nhận nạp: CARP nạp sau đó không
  // bao giờ thu hồi được, vì `ReclaimEpoch` của két Wakeme không lặp lại.
  expect fund_in.sponsor_reclaimed == 0
  expect fund_out.sponsor_reclaimed == fund_in.sponsor_reclaimed
  // Quỹ tài trợ: bên tài trợ phải KÝ lượt nạp. Không có vế này thì người dùng
  // (hoặc platform) khoá CARP của chính mình vào quỹ tài trợ, và lúc thu hồi CARP
  // đó chảy về bên tài trợ. Genesis ép payment của `sponsor` là `VerificationKey`.
  expect
    when fund_in.sponsorship is {
      None -> True
      Some(s) -> {
        expect VerificationKey(h) = s.sponsor.payment_credential
        list.has(tx.extra_signatories, h)
      }
    }
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
// `current_epoch` KHÔNG còn là tham số ở đây (bỏ 2026-09-28): delta nay đọc từ
// `consumed_unsettled`, một con số đã được `validate_burn_batch` kiểm thời điểm
// lúc ghi (C-PP-5 — batch chết không đốt được). Cổng `last_updated_epoch ==
// current_epoch` vẫn nằm ở `fund_common_checks`, phủ cả ba nhánh.
fn validate_fund_settle(
  fund_in  : PaidFundDatum,
  fund_out : PaidFundDatum,
  tx       : Transaction,
) -> Bool {
  // Vault thật, tiêu bằng ĐÚNG SettleLine (constr 6). Không nhận constr khác —
  // và đặc biệt KHÔNG nhận `PrunePrepaid`: nó cũng làm `current_amount` biến
  // mất, nhưng đó là HẾT HẠN chứ không phải tiêu thật, tính vào `magic_settled`
  // là phá INV-MAGIC-CITIZEN. Từ 2026-09-28 vế đó còn được giữ bằng cấu trúc:
  // chỉ `BurnBatch` cộng vào `consumed_unsettled`, còn `validate_prune` không
  // chạm trường ấy, nên MAGIC hết hạn KHÔNG có đường nào vào sổ nợ.
  expect vault_cospend(tx, fund_in.vault_hash, rd_settle_line)

  let delta = settle_line_delta(tx, fund_in.vault_hash, fund_in.fund_id)
  expect delta > 0

  expect fund_out.magic_settled == fund_in.magic_settled + delta
  expect fund_out.credit_issued == fund_in.credit_issued
  expect fund_out.provider_claimed == fund_in.provider_claimed
  expect fund_out.carp_locked == fund_in.carp_locked
  expect fund_out.sponsor_reclaimed == fund_in.sponsor_reclaimed

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
  //
  // Từ 2026-10-04 trần là hạn-mức HIỆU LỰC `credit_issued − sponsor_reclaimed`.
  // Quy nạp vẫn đứng: `sponsor_reclaimed` chỉ đổi đúng một lần, ở `FundReclaim`,
  // và đổi đúng bằng `outstanding` ⟹ `outstanding` về đúng 0, không âm.
  expect
    par_carp_from_magic(fund_out.magic_settled) <= fund_out.credit_issued - fund_out.sponsor_reclaimed
  True
}

// Nợ quyết toán vừa được xoá khỏi dòng `fund_id`: `in.consumed_unsettled −
// out.consumed_unsettled`, đọc từ cặp datum vault vào/ra.
//
// Ép ĐÚNG MỘT input và ĐÚNG MỘT output tại `vault_hash`. Cả hai vế đều cần:
// nhiều input thì `list.find` lấy cái đầu tiên và phần nợ của các vault còn lại
// đi lọt; nhiều output thì trạng thái vault bị tách làm hai và chọn được cái có
// lợi. Bản trước chỉ ép vế output.
//
// Dòng phải tồn tại ở CẢ HAI đầu, đúng một. Thiếu ở đầu vào là quỹ đang đọc một
// vault không nợ nó gì; thiếu ở đầu ra là dòng vừa bị xoá — mà dòng hạn-mức
// không bao giờ được xoá (`types.ak` ▸ `PrepaidCredit`), nên đó là hình dạng lạ
// và phải chết, không được quy về 0.
fn settle_line_delta(
  tx         : Transaction,
  vault_hash : ByteArray,
  fund_id    : ByteArray,
) -> Int {
  expect
    list.count(tx.inputs, fn(i) { is_at_script(i.output.address, vault_hash) }) == 1
  expect Some(vin) =
    list.find(tx.inputs, fn(i) { is_at_script(i.output.address, vault_hash) })
  expect
    list.count(tx.outputs, fn(o) { is_at_script(o.address, vault_hash) }) == 1
  expect Some(vout) =
    list.find(tx.outputs, fn(o) { is_at_script(o.address, vault_hash) })
  let din = decode_vault(vin.output)
  let dout = decode_vault(vout)

  expect list.count(din.prepaid_credits, fn(c) { c.fund_id == fund_id }) == 1
  expect Some(cin) = list.find(din.prepaid_credits, fn(c) { c.fund_id == fund_id })
  expect list.count(dout.prepaid_credits, fn(c) { c.fund_id == fund_id }) == 1
  expect Some(cout) = list.find(dout.prepaid_credits, fn(c) { c.fund_id == fund_id })

  cin.consumed_unsettled - cout.consumed_unsettled
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
  expect beneficiary_paid(fund_in, amount, carp_policy_id, carp_asset_name, tx)

  expect fund_out.carp_locked == fund_in.carp_locked - amount
  expect fund_out.provider_claimed == fund_in.provider_claimed + amount
  expect fund_out.credit_issued == fund_in.credit_issued
  expect fund_out.magic_settled == fund_in.magic_settled
  expect fund_out.sponsor_reclaimed == fund_in.sponsor_reclaimed

  // F2 (a): claim_provider ≤ Σ MAGIC_burned_par
  expect
    fund_out.provider_claimed <= par_carp_from_magic(fund_out.magic_settled)

  // F2 (b): buffer-Paid — giữ lại đệm trên phần dịch vụ chưa giao.
  // Hạn-mức hiệu lực `credit_issued − sponsor_reclaimed` (DESIGN-reclaim §10.7).
  let outstanding =
    outstanding_effective(
      fund_out.credit_issued,
      fund_out.sponsor_reclaimed,
      fund_out.magic_settled,
    )
  expect fund_out.carp_locked >= buffer_floor(outstanding, fund_out.buffer_bps)
  True
}

// ĐÍCH của `FundClaim` (khối chú thích ĐÍCH ở `validate_fund_claim`): không input
// nào ở `beneficiary`; ĐÚNG MỘT output ở `beneficiary` (so địa chỉ đầy đủ), mang
// đúng `amount` CARP, datum khớp `beneficiary_datum`. Dùng chung cho nhánh rút
// thường và nhánh rút-cuối-đóng-quỹ — hai bản chép là hai chỗ lệch được nhau.
fn beneficiary_paid(
  fund_in         : PaidFundDatum,
  amount          : Int,
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {
  let ben = fund_in.beneficiary
  expect !list.any(tx.inputs, fn(i) { i.output.address == ben })
  expect [paid] = list.filter(tx.outputs, fn(o) { o.address == ben })
  expect
    assets.quantity_of(paid.value, carp_policy_id, carp_asset_name) == amount
  when fund_in.beneficiary_datum is {
    None -> paid.datum == NoDatum
    Some(d) -> paid.datum == InlineDatum(d)
  }
}

// ══════════════════════════════════════════════════════════════
// FUND — FundClaim rút TRỌN quỹ đã thu hồi ⟹ ĐÓNG (DESIGN-reclaim §10.11)
// ══════════════════════════════════════════════════════════════
// Sau `FundReclaim` tiếp nối, quỹ chỉ còn phần provider đã kiếm `E`. Rút trọn `E`
// mà để quỹ tiếp nối thì UTxO đó có `carp_locked = 0`, không nhận nạp
// (`sponsor_reclaimed > 0`), không còn dòng ở vault để `SettleLine`, không còn gì
// để rút, không `FundReclaim` lần hai ⟹ NFT + min-ADA khoá vĩnh viễn. Thân handler
// rẽ vào đây đúng khi `sponsor_reclaimed > 0 ∧ amount == carp_locked`.
//
// Hình dạng: CARP về `beneficiary` (y như rút thường, cùng `beneficiary_paid`);
// NFT quỹ bị đốt; không output nào còn mang NFT; min-ADA về `sponsor` theo đúng
// cách nhánh đóng của `FundReclaim` trả (`sponsor_payout`, datum `fund_id`).
// Chữ ký: platform, như mọi `FundClaim`.
fn validate_fund_claim_close(
  fund_in         : PaidFundDatum,
  own_in          : Input,
  fund_nft_policy : PolicyId,
  amount          : Int,
  carp_policy_id  : PolicyId,
  carp_asset_name : ByteArray,
  tx              : Transaction,
) -> Bool {
  // MUT-C-SIG
  expect list.has(tx.extra_signatories, fund_in.platform)
  // Quỹ đã thu hồi chỉ có thể là quỹ tài trợ (`FundReclaim` mục 1).
  expect Some(s) = fund_in.sponsorship
  // MUT-C-RECLAIMED — lặp lại phép rẽ của handler để hàm tự đứng được.
  expect fund_in.sponsor_reclaimed > 0
  // MUT-C-ALL
  expect amount == fund_in.carp_locked
  expect amount > 0
  // Sổ khớp value đầu vào (C-PP-3 phía input; `fund_common_checks` không chạy).
  // MUT-C-INVALUE
  expect
    assets.quantity_of(own_in.output.value, carp_policy_id, carp_asset_name) == fund_in.carp_locked
  // F2 (a): tổng đã rút ≤ phần đã giao. Vế (b) (sàn đệm) suy ra từ (a) ở đây:
  // `carp_locked' = 0` và (a) ⟺ `credit_issued − sponsor_reclaimed ≤
  // par(magic_settled)` ⟺ outstanding ≤ 0 ⟹ sàn đệm ≤ 0.
  // MUT-C-F2A
  expect
    fund_in.provider_claimed + amount <= par_carp_from_magic(fund_in.magic_settled)
  // Đích CARP.
  // MUT-C-BEN
  expect beneficiary_paid(fund_in, amount, carp_policy_id, carp_asset_name, tx)
  // Đốt ĐÚNG NFT quỹ này, ĐÚNG −1, không token nào khác dưới policy quỹ.
  // MUT-C-BURN
  expect
    dict.to_pairs(assets.tokens(tx.mint, fund_nft_policy)) == [
      Pair(fund_in.fund_id, -1),
    ]
  // MUT-C-NFTOUT
  expect
    !list.any(
      tx.outputs,
      fn(o) { assets.quantity_of(o.value, fund_nft_policy, fund_in.fund_id) != 0 },
    )
  // G3V (2026-10-08): đóng là đóng — KHÔNG output nào ở script quỹ (đếm theo
  // payment credential). Thiếu vế này thì giao dịch đóng đẻ được một UTxO ở
  // script quỹ mà không nhánh nào tiêu lại được.
  expect !list.any(tx.outputs, fn(o) { is_at_script(o.address, fund_nft_policy) })
  // min-ADA về bên tài trợ.
  let back = sponsor_payout(s.sponsor, fund_in.fund_id, tx)
  // MUT-C-ADA
  expect assets.lovelace_of(back.value) >= assets.lovelace_of(own_in.output.value)
  True
}

// ══════════════════════════════════════════════════════════════
// FUND — FundReclaim (DESIGN-reclaim §10.6, 2026-10-04)
// ══════════════════════════════════════════════════════════════
// Trả phần hạn-mức đã cấp mà dịch vụ CHƯA giao về ví bên tài trợ, cùng đợt với
// lúc két Wakeme của đúng DID đó bị `ReclaimEpoch`. Không đòi chữ ký nào — cùng
// tính chất với `ReclaimEpoch`: điều kiện thời gian (Φ) do validator két Wakeme
// tự ép (Ψ đã bỏ 2026-10-04), quỹ chỉ đòi sự kiện đó xảy ra TRONG CÙNG giao dịch.

// R = phần chưa giao, suy từ datum quỹ + `consumed_unsettled` `u` của dòng bị gỡ
// ở vault (không do người dựng tx khai). Gương P8: `math.ak` ▸ `reclaim_outstanding`.
fn reclaim_amount(fd: PaidFundDatum, u: Int) -> Int {
  reclaim_outstanding(fd.credit_issued, fd.sponsor_reclaimed, fd.magic_settled, u)
}

// `u` của `FundReclaim` (DESIGN-reclaim §10.11, `CC-RECLAIM-VAULT-LINE`).
//
// `credit_issued == 0` ⟹ quỹ CHƯA TỪNG có dòng ở vault nào: mọi lượt mở dòng đi
// cùng một `FundLock` làm `credit_issued` tăng (`validate_lock` + `validate_fund_lock`),
// và genesis vault ép `prepaid_credits == []`. Chỉ ca này được thu hồi KHÔNG kèm
// vault (R = 0, nhánh đóng: trả min-ADA, đốt NFT).
//
// `credit_issued > 0` ⟹ quỹ có ĐÚNG MỘT dòng (`validate_lock` ▸ vế một-dòng của quỹ
// tài trợ) ⟹ BẮT BUỘC đồng tiêu vault mang dòng đó bằng `CloseSponsoredLine`.
// Không có đường "thu hồi bỏ qua vault" cho ca này: nếu có, người dựng giao dịch
// (thường là bên được hưởng R) chọn đường đó để lấy luôn phần `u` của provider.
fn reclaim_unsettled(fund_in: PaidFundDatum, tx: Transaction) -> Int {
  // MUT-A-NOLINE
  if fund_in.credit_issued == 0 {
    0
  } else {
    sponsored_line_unsettled(tx, fund_in.vault_hash, fund_in.fund_id)
  }
}

// ĐÚNG MỘT input ở `Script(vault_hash)`; redeemer Spend của nó là
// `CloseSponsoredLine { fund_id }` với ĐÚNG `fund_id` của quỹ này; datum của nó có
// ĐÚNG MỘT dòng `fund_id` ⟹ trả `consumed_unsettled` của dòng đó.
//
// Validator vault (chạy vì input bị tiêu) ép phần còn lại: NFT định danh vault
// (`vault_identity_preserved`), dòng + batch của quỹ bị gỡ, mọi thứ khác đứng yên.
// Ràng `fund_id` trong redeemer là thứ chặn MỘT lượt gỡ dòng phục vụ HAI quỹ.
fn sponsored_line_unsettled(
  tx         : Transaction,
  vault_hash : ByteArray,
  fund_id    : ByteArray,
) -> Int {
  // MUT-A-ONEVAULT
  expect [vin] =
    list.filter(tx.inputs, fn(i) { is_at_script(i.output.address, vault_hash) })
  expect Some(Pair(_, rd_data)) =
    list.find(
      tx.redeemers,
      fn(p) {
        let Pair(purpose, _) = p
        purpose == Spend(vin.output_reference)
      },
    )
  let Pair(idx, fields) = builtin.un_constr_data(rd_data)
  // MUT-A-VRD
  expect idx == rd_close_sponsored_line
  expect [f] = fields
  // MUT-A-VFID
  expect builtin.un_b_data(f) == fund_id
  let din = decode_vault(vin.output)
  // MUT-A-LINE
  expect [line] = list.filter(din.prepaid_credits, fn(c) { c.fund_id == fund_id })
  line.consumed_unsettled
}

// Mục 1–4 của §10.6, dùng chung cho hai hình dạng (tiếp nối / đóng).
fn reclaim_preconditions(
  fund_in           : PaidFundDatum,
  wakeme_vault_hash : ByteArray,
  // epoch của giao dịch (`get_epoch`: hai cận hữu hạn, CÙNG epoch ⟹ bằng epoch
  // của cận DƯỚI) — chỉ đường dự phòng đọc.
  current_epoch     : Int,
  u                 : Int,
  tx                : Transaction,
) -> (Sponsorship, Int) {
  // 1. quỹ được tài trợ
  expect Some(s) = fund_in.sponsorship
  // 2. chưa thu hồi — chốt cục bộ, không dựa vào việc két Wakeme chỉ
  //    `ReclaimEpoch` được một lần.
  expect fund_in.sponsor_reclaimed == 0
  // 3. MỘT trong hai đường (DESIGN-reclaim §10.12):
  //   (a) DỰ PHÒNG — bên tài trợ KÝ, VÀ (đã tới mốc tuyệt đối `reclaim_after_epoch`
  //       ghim lúc genesis, HOẶC quỹ chưa từng cấp đồng nào). Không phụ thuộc két
  //       Wakeme: ai đó chạy `ReclaimEpoch` riêng, Wakeme deploy lại (đổi
  //       `wakeme_vault_hash`), hay DID không có két — CARP vẫn về được bên tài trợ.
  //       `credit_issued == 0` ⟹ chưa DID nào có dòng, không có gì phải chờ.
  //   (b) Wakeme — két Wakeme của ĐÚNG người này bị `ReclaimEpoch` cùng giao dịch.
  // Vế (a) đứng TRƯỚC vì `wakeme_reclaim_cospend` dùng `expect`: vắng két Wakeme thì
  // nó HỎNG chứ không trả False, nên đặt sau thì đường dự phòng không bao giờ tới.
  // Bước 4 + `reclaim_unsettled` (vault `CloseSponsoredLine` khi `credit_issued > 0`)
  // áp cho CẢ HAI đường — phần `u` của provider không rơi theo đường nào.
  expect or {
      and {
        // MUT-FB-SIG
        when s.sponsor.payment_credential is {
          VerificationKey(h) -> list.has(tx.extra_signatories, h)
          Script(_) -> False
        },
        or {
          // MUT-FB-AFTER
          current_epoch >= s.reclaim_after_epoch,
          // MUT-FB-NEVER
          fund_in.credit_issued == 0,
        },
      },
      wakeme_reclaim_cospend(tx, wakeme_vault_hash, s.owner_commit),
    }
  // 4. lượng thu hồi — đã trừ phần `u` đã giao mà sổ quỹ còn thiếu.
  let r = reclaim_amount(fund_in, u)
  // R ≥ 1, trừ ca quỹ chưa từng cấp đồng nào (R = 0, chỉ đi được nhánh đóng —
  // `carp_locked = 0 = R`): đó là đường trả min-ADA của quỹ chưa bao giờ nạp.
  // MUT-A-RPOS
  expect r >= 1 || fund_in.credit_issued == 0
  (s, r)
}

// Đúng MỘT input ở `Script(wakeme_vault_hash)`; nó mang vault-NFT
// `(wakeme_vault_hash, owner_commit)`; redeemer Spend của nó là `ReclaimEpoch`.
//
// Nhận diện két bằng NFT, KHÔNG bằng ô [0] của datum: datum ở địa chỉ két là thứ
// ai cũng soạn được (Cardano không chạy validator lúc tạo UTxO), còn vault-NFT
// chỉ đúc được qua genesis của két, nơi tên bị ép bằng tên anchor đang bị chi.
// Có vế NFT thì đọc ô [0] không thêm gì ⟹ KHÔNG giải mã datum Wakeme, bỏ luôn phụ
// thuộc vào chỉ số trường của kho khác.
fn wakeme_reclaim_cospend(
  tx                : Transaction,
  wakeme_vault_hash : ByteArray,
  owner_commit      : ByteArray,
) -> Bool {
  expect [win] =
    list.filter(
      tx.inputs,
      fn(i) { is_at_script(i.output.address, wakeme_vault_hash) },
    )
  expect
    assets.quantity_of(win.output.value, wakeme_vault_hash, owner_commit) == 1
  spend_redeemer_constr_is(tx, win.output_reference, rd_wakeme_reclaim_epoch)
}

// Redeemer `Spend(out_ref)` có constructor index `want`. Fail-closed khi không
// có redeemer. Đọc bằng builtin, không ghép kiểu chéo validator.
fn spend_redeemer_constr_is(
  tx      : Transaction,
  out_ref : OutputReference,
  want    : Int,
) -> Bool {
  when
    list.find(
      tx.redeemers,
      fn(p) {
        let Pair(purpose, _) = p
        purpose == Spend(out_ref)
      },
    )
  is {
    Some(Pair(_, rd_data)) -> {
      let Pair(idx, _fields) = builtin.un_constr_data(rd_data)
      idx == want
    }
    None -> False
  }
}

// ĐÍCH: không input nào ở `sponsor`; ĐÚNG MỘT output mang cặp
// (địa chỉ `sponsor`, inline datum `fund_id`) — so ĐỊA CHỈ ĐẦY ĐỦ. So theo payment
// credential thì output ở (payment bên tài trợ, stake người lạ) vẫn tính là tới
// đích, và người lạ gắn stake của mình lên CARP bên tài trợ. Cấm input tại đích ⟹
// tiền thừa của người dựng tx không lẫn được vào phần thu hồi.
//
// DATUM = `fund_id` (2026-10-04, chống THOẢ-MÃN-KÉP): hai quỹ ở hai bản deploy
// `paid_fund` khác nhau (C-PP-10 chỉ ép một input quỹ cho MỖI địa chỉ) cùng
// `sponsor`, cùng `owner_commit`, cùng `R` cùng ăn được MỘT input két Wakeme; nếu
// đích chỉ là địa chỉ thì MỘT output trả thoả cả hai quỹ, và phần `R` của quỹ thứ
// hai về tay người dựng giao dịch. Gắn output trả vào đúng một quỹ bằng `fund_id`
// (tên NFT quỹ, one-shot theo seed ⟹ duy nhất toàn mạng) thì mỗi quỹ đòi một output
// riêng. Output khác tới `sponsor` mà không mang datum này KHÔNG được tính vào phần
// trả (không cấm: tiền thêm tới ví bên tài trợ vô hại). Datum không đổi khả năng
// tiêu: genesis ép đích là ví KHOÁ.
fn sponsor_payout(sponsor: Address, fund_id: ByteArray, tx: Transaction) -> Output {
  expect !list.any(tx.inputs, fn(i) { i.output.address == sponsor })
  let tag: Data = fund_id
  expect [paid] =
    list.filter(
      tx.outputs,
      fn(o) { o.address == sponsor && o.datum == InlineDatum(tag) },
    )
  paid
}

// Hình dạng TIẾP NỐI (E > 0): quỹ ở lại với đúng phần provider đã kiếm mà chưa
// rút; `outstanding' = 0` ⟹ sàn đệm = 0 ⟹ provider rút trọn phần đó bằng
// `FundClaim`. `fund_common_checks` đã ép phần chung (output tiếp nối duy nhất,
// địa chỉ, hình dạng value, sổ khớp value hai đầu, định danh, `sponsorship`).
fn validate_fund_reclaim(
  fund_in           : PaidFundDatum,
  fund_out          : PaidFundDatum,
  wakeme_vault_hash : ByteArray,
  carp_policy_id    : PolicyId,
  carp_asset_name   : ByteArray,
  current_epoch     : Int,
  u                 : Int,
  tx                : Transaction,
) -> Bool {
  let (s, r) = reclaim_preconditions(fund_in, wakeme_vault_hash, current_epoch, u, tx)

  // 5. sổ quỹ đầu ra
  expect fund_out.carp_locked == fund_in.carp_locked - r
  // E = 0 thì phải đi nhánh ĐÓNG (thân handler rẽ theo datum); dòng này giữ cho
  // hàm tự đứng được khi gọi thẳng, và chặn một quỹ tiếp nối không ai tiêu lại.
  expect fund_out.carp_locked > 0
  expect fund_out.sponsor_reclaimed == r
  expect fund_out.credit_issued == fund_in.credit_issued
  // Nợ quyết toán của dòng vừa gỡ vào sổ quỹ (§10.11): phần đó provider đã giao,
  // nay rút được bằng `FundClaim`. Dòng ở vault không còn nên không có
  // `SettleLine` nào ghi nó lần hai.
  // MUT-A-SETTLED
  expect fund_out.magic_settled == fund_in.magic_settled + u
  expect fund_out.provider_claimed == fund_in.provider_claimed

  // 6. đích
  let paid = sponsor_payout(s.sponsor, fund_in.fund_id, tx)
  expect assets.quantity_of(paid.value, carp_policy_id, carp_asset_name) == r
  True
}

// Hình dạng ĐÓNG (E = 0, đóng `CC-RECLAIM-FUND-CLOSE`): không có output quỹ tiếp
// nối; NFT quỹ bị đốt (−1, đúng tên, dưới policy quỹ); toàn bộ CARP (= R) và
// toàn bộ ADA của UTxO quỹ về đúng `sponsor`.
//
// Phép thử "rót đúng sổ" (§10.8) cho nhánh này: sau giao dịch không còn UTxO nào
// mang NFT quỹ (đốt + vế "không output nào mang nó"), nên không có quỹ chết; thứ
// duy nhất được tạo là output ở ví khoá của bên tài trợ, tiêu lại bằng chữ ký
// khoá đó.
fn validate_fund_close(
  fund_in           : PaidFundDatum,
  own_in            : Input,
  fund_nft_policy   : PolicyId,
  carp_policy_id    : PolicyId,
  carp_asset_name   : ByteArray,
  wakeme_vault_hash : ByteArray,
  current_epoch     : Int,
  u                 : Int,
  tx                : Transaction,
) -> Bool {
  let (s, r) = reclaim_preconditions(fund_in, wakeme_vault_hash, current_epoch, u, tx)
  // E = carp_locked − R = 0. Thân handler đã rẽ theo đúng phép so này; lặp lại ở
  // đây để hàm không phụ thuộc chỗ gọi.
  expect fund_in.carp_locked == r
  // Sổ khớp value đầu vào (C-PP-3 phía input): CARP thật trong UTxO == sổ.
  expect
    assets.quantity_of(own_in.output.value, carp_policy_id, carp_asset_name) == fund_in.carp_locked

  // Đốt ĐÚNG NFT quỹ này, ĐÚNG −1, và không token nào khác dưới policy quỹ.
  expect
    dict.to_pairs(assets.tokens(tx.mint, fund_nft_policy)) == [
      Pair(fund_in.fund_id, -1),
    ]
  // Không output nào còn mang NFT quỹ.
  expect
    !list.any(
      tx.outputs,
      fn(o) { assets.quantity_of(o.value, fund_nft_policy, fund_in.fund_id) != 0 },
    )
  // G3V (2026-10-08): đóng là đóng — KHÔNG output nào ở script quỹ (đếm theo
  // payment credential). Thiếu vế này thì giao dịch đóng đẻ được một UTxO ở
  // script quỹ mà không nhánh nào tiêu lại được.
  expect !list.any(tx.outputs, fn(o) { is_at_script(o.address, fund_nft_policy) })

  // Đích: CARP == R và ADA ≥ toàn bộ ADA của UTxO quỹ (min-ADA về bên tài trợ).
  let paid = sponsor_payout(s.sponsor, fund_in.fund_id, tx)
  expect assets.quantity_of(paid.value, carp_policy_id, carp_asset_name) == r
  expect assets.lovelace_of(paid.value) >= assets.lovelace_of(own_in.output.value)
  True
}

// Handler `mint` của `paid_fund`, lượng `−1`: chỉ cho đốt khi ĐÚNG MỘT input ở
// `Script(policy_id)` mang NFT đó và nó bị tiêu bằng `FundReclaim`. Nhánh spend
// của chính quỹ đó (bắt buộc chạy vì input bị tiêu) ép phần còn lại: E = 0, đích,
// lượng, và chính nó đòi `tx.mint` dưới policy quỹ == `[(fund_id, −1)]`.
fn validate_burn_fund_nft(
  name      : ByteArray,
  policy_id : PolicyId,
  tx        : Transaction,
) -> Bool {
  expect [fin] =
    list.filter(
      tx.inputs,
      fn(i) {
        i.output.address.payment_credential == Script(policy_id) && assets.quantity_of(
          i.output.value,
          policy_id,
          name,
        ) == 1
      },
    )
  // Hai redeemer đốt được: `FundReclaim` (nhánh đóng E = 0) và `FundClaim` (rút
  // trọn quỹ đã thu hồi — `validate_fund_claim_close`). Nhánh spend của quỹ là
  // chỗ quyết hình dạng: mọi đường không-đóng của nó ép `no_fund_mint`, nên cho
  // `FundClaim` đốt ở đây KHÔNG mở lượt đốt nào mà spend không đồng ý.
  // MUT-C-MINTRD
  spend_redeemer_constr_is(tx, fin.output_reference, rd_fund_reclaim) || spend_redeemer_constr_is(
    tx,
    fin.output_reference,
    rd_fund_claim,
  )
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
  //   - reference_script == None: cổng đúc đã ghim vế này cho UTxO genesis, mà
  //     nhánh spend thì chưa — nên một lượt vận hành hợp lệ vẫn gắn được
  //     ref-script vào vault tiếp nối. Hại: min-ADA đội lên, và dòng ngay trên
  //     chỉ cho lovelace ĐI LÊN trong khi không nhánh nào rút ADA khỏi vault ⟹
  //     phần ADA ấy khoá vĩnh viễn.
  expect vault_output.reference_script == None
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
  // Lọc theo SCRIPT trước, rồi mới đòi NFT trên output DUY NHẤT đó (G3V
  // 2026-10-08): bản lọc "ở script VÀ mang NFT" để lọt một output thứ hai ở
  // script này không mang NFT — UTxO không nhánh nào tiêu lại được.
  expect [vault_out] =
    list.filter(tx.outputs, fn(o) { o.address.payment_credential == Script(policy_id) })
  expect assets.quantity_of(vault_out.value, policy_id, nft_name) == 1

  // ── CHỈ NFT đó dưới policy vault, không tên thứ hai ──────────────────────
  // Xem lý do ở chú thích của `vault_identity_preserved`: phép kiểm NFT bên
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
// (mọi số cộng dồn = 0) và buffer_bps ≥ min_buffer_bps. Không có cổng này thì một quỹ có
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
fn validate_mint_fund_nft(
  policy_id        : PolicyId,
  ms_per_epoch     : Int,
  window_origin_ms : Int,
  tx               : Transaction,
) -> Bool {
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
  // Lọc theo SCRIPT trước, rồi mới đòi NFT trên output DUY NHẤT đó (G3V
  // 2026-10-08): bản lọc "ở script VÀ mang NFT" để lọt một output thứ hai ở
  // script này không mang NFT — UTxO không nhánh nào tiêu lại được.
  expect [fund_utxo] =
    list.filter(tx.outputs, fn(o) { o.address.payment_credential == Script(policy_id) })
  expect assets.quantity_of(fund_utxo.value, policy_id, name) == 1

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
  expect fd.sponsor_reclaimed == 0
  // Quỹ tài trợ (DESIGN-reclaim §10.7): bên tài trợ là ví KHOÁ, hash 28 byte, và
  // `owner_commit` 32 byte (= tên vault-NFT két Wakeme). Bên tài trợ là script thì
  // CARP thu hồi "rót đúng địa chỉ, ngoài sổ" — loại ở đây (`CC-RECLAIM-SCRIPT-SPONSOR`).
  // Genesis KHÔNG đòi bên tài trợ ký: quỹ ghi tên X mà X không nạp thì vô hại;
  // cửa nạp (`validate_fund_lock`) mới đòi chữ ký X.
  //
  // Chặn TỰ HƯỞNG (chủ dự án chốt 2026-10-05): CARP của MAGIC đã consume đi về
  // `beneficiary`; nếu đó là chính khoá tài trợ thì bên tài trợ nạp CARP, cho DID
  // tiêu, rồi nhận lại đúng số CARP đó qua `FundClaim`. So PAYMENT CREDENTIAL,
  // không so địa chỉ đầy đủ: `sponsor` là địa chỉ base, `beneficiary` bị ép không
  // stake, nên phép so địa chỉ không bao giờ bằng — cùng khoá khác phần stake lách
  // qua được.
  expect
    when fd.sponsorship is {
      None -> True
      Some(s) ->
        when s.sponsor.payment_credential is {
          VerificationKey(h) -> and {
              bytearray.length(h) == 28,
              bytearray.length(s.owner_commit) == 32,
              fd.beneficiary.payment_credential != s.sponsor.payment_credential,
              // Mốc thu hồi dự phòng (DESIGN-reclaim §10.12) ≥ epoch(cận TRÊN) + trễ.
              // Cận TRÊN, không cận dưới: cận dưới người dựng đặt lùi vào quá khứ
              // tuỳ ý (mốc rơi vào quá khứ ⟹ rút được ngay); cận trên ≥ thời điểm
              // thật, đặt xa chỉ làm bên tài trợ tự chịu chậm. Không cận trên ⟹ hỏng.
              // MUT-G-AFTER
              when tx.validity_range.upper_bound.bound_type |> get_finite is {
                Some(hi) ->
                  s.reclaim_after_epoch >= ( hi - window_origin_ms ) / ms_per_epoch + sponsor_reclaim_delay_epochs
                None -> False
              },
            }
          Script(_) -> False
        }
    }
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
  // Một `when` cho mọi vế về payment credential của bên hưởng (gộp 2026-10-05 để
  // lọt trần byte; mỗi vế vẫn đứng riêng một dòng trong `and`):
  //   · khuôn 28 byte — cùng lớp với hai dòng độ dài ở trên: hash sai độ dài thì
  //     không output nào đỗ được ở đó, mọi claim chết, CARP kẹt vĩnh viễn;
  //   · khoá ≠ `platform` — chặn TỰ HƯỞNG (chủ dự án chốt 2026-10-05): `platform`
  //     nạp thêm được vào dòng đã có (C-PP-9, app khoá hộ người dùng), tức nó cũng
  //     là một bên tài trợ, và nó ký `FundClaim`. So theo CREDENTIAL (nhánh khoá),
  //     cùng lý do với vế `sponsor` ở trên;
  //   · script ≠ chính quỹ (output tới đích lại là output quỹ ⟹ claim không bao giờ
  //     đúng hình dạng), ≠ vault (output không mang NFT vault ⟹ không nhánh nào tiêu
  //     lại được, `vault_identity_preserved`) — cả hai là CARP chết;
  //   · script ⟹ BẮT BUỘC ghim datum (xem khối ĐÍCH ở `validate_fund_claim`).
  expect
    when ben.payment_credential is {
      VerificationKey(h) -> and {
          bytearray.length(h) == 28,
          h != fd.platform,
        }
      Script(h) -> and {
          bytearray.length(h) == 28,
          h != policy_id,
          h != fd.vault_hash,
          fd.beneficiary_datum != None,
        }
    }
  True
}

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

// SEC-02: đọc mỗi lower_bound cho phép kẻ tấn công đặt lower = đầu epoch E với
// upper mở, được đưa vào chuỗi ở epoch E+k, mà validator vẫn tin current_epoch
// == E. Ép CẢ HAI biên Finite và cùng một epoch → current_epoch không nhập nhằng.
// Gốc lưới cửa sổ (LAMP `Specs/Window/CONTRACT.md` v1.0, WIN-ORIGIN-1): cả hai biên trừ
// `window_origin_ms` trước khi chia.
fn get_epoch(tx: Transaction, ms_per_epoch: Int, window_origin_ms: Int) -> Int {
  expect Some(lower_ms) = tx.validity_range.lower_bound.bound_type |> get_finite
  expect Some(upper_ms) = tx.validity_range.upper_bound.bound_type |> get_finite
  let e_lo = ( lower_ms - window_origin_ms ) / ms_per_epoch
  let e_hi = ( upper_ms - window_origin_ms ) / ms_per_epoch
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
  // C-PP-10: đúng một output ở SCRIPT két, đếm theo payment credential (G3V
  // 2026-10-08 — bản đếm theo địa chỉ đầy đủ để lọt một output cùng script khác
  // stake: UTxO ở script két mà không nhánh nào tiêu lại được), và output đó phải
  // mang ĐÚNG địa chỉ đầy đủ của input (stake credential không trôi).
  let vault_cred = vault_addr.payment_credential
  expect [o] =
    list.filter(outputs, fn(x) { x.address.payment_credential == vault_cred })
  expect o.address == vault_addr
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
const t_wakeme_hash: ByteArray = #"abababababababababababababababababababababababababababab"
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
  t_credit_u(fund_id, remaining, 0)
}

// Dòng hạn-mức mang sẵn một khoản nợ quyết toán `consumed_unsettled`.
fn t_credit_u(fund_id: ByteArray, remaining: Int, consumed: Int) -> PrepaidCredit {
  PrepaidCredit {
    fund_id,
    remaining,
    issued_epoch: 5,
    last_draw_epoch: 5,
    consumed_unsettled: consumed,
  }
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
    sponsorship: None,
    sponsor_reclaimed: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
        },
      ],
      magic_batches: [drawn_batch(0)],
      next_batch_index: 1,
      last_updated_epoch: t_epoch,
    }
  run_draw(din, draw_amt, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
}

// ── Draw trên dòng ĐANG NỢ quyết toán (vá 2026-10-02) ─────────────────────────
// `PrepaidDraw` chỉ đổi `remaining` và `last_draw_epoch` của dòng (DESIGN.md
// §5.3). `consumed_unsettled` là sổ nợ của quỹ: chỉ `BurnBatch` cộng, chỉ
// `SettleLine` đưa về 0. Bản trước đặt cứng `consumed_unsettled: 0` ở nhánh rút
// ⟹ chủ vault rút 1 CARP là xoá sạch nợ, CARP đối ứng phần đã tiêu kẹt trong quỹ
// (provider không đòi được); và chiều ngược lại: bộ dựng off-chain `drawMagic`
// GIỮ nợ nên mọi lượt rút trung thực trên dòng đang nợ bị từ chối. Mọi fixture
// rút trước đó dùng `t_credit` (nợ 0), nên không ca nào phân biệt được hai bản.
//
// Đối ứng TS cùng con số: `tests/prepaid.test.ts` ▸ "Draw trên dòng đang nợ".
const draw_debt: Int = 600_000_000

fn draw_on_debt_dout(din: PrepaidVaultDatum, debt_out: Int) -> PrepaidVaultDatum {
  PrepaidVaultDatum {
    ..din,
    prepaid_credits: [
      PrepaidCredit {
        fund_id: t_fund_id,
        remaining: 4_000_000_000,
        issued_epoch: 5,
        last_draw_epoch: t_epoch,
        consumed_unsettled: debt_out,
      },
    ],
    magic_batches: [drawn_batch(0)],
    next_batch_index: 1,
    last_updated_epoch: t_epoch,
  }
}

// happy: nợ đi nguyên qua lượt rút.
test pp_draw_keeps_unsettled_debt_ok() {
  let din = t_vd([t_credit_u(t_fund_id, 5_000_000_000, draw_debt)], [])
  let dout = draw_on_debt_dout(din, draw_debt)
  run_draw(din, draw_amt, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
}

// TẤN CÔNG: rút để xoá nợ quyết toán của quỹ.
test pp_draw_wipes_unsettled_debt_rejected() fail {
  let din = t_vd([t_credit_u(t_fund_id, 5_000_000_000, draw_debt)], [])
  let dout = draw_on_debt_dout(din, 0)
  run_draw(din, draw_amt, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
}

// TẤN CÔNG chiều kia: rút mà ghi THÊM nợ (đếm lượng rút như đã tiêu) ⟹ quỹ
// quyết toán MAGIC chưa ai tiêu.
test pp_draw_inflates_unsettled_debt_rejected() fail {
  let din = t_vd([t_credit_u(t_fund_id, 5_000_000_000, draw_debt)], [])
  let dout = draw_on_debt_dout(din, draw_debt + draw_nanogic)
  run_draw(din, draw_amt, t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]))
}

// TẤN CÔNG: rút ở dòng A mà xoá nợ của dòng B (nhánh `else` của map).
test pp_draw_wipes_other_line_debt_rejected() fail {
  let din =
    t_vd(
      [
        t_credit(t_fund_id, 5_000_000_000),
        t_credit_u(t_other_fund, 0, draw_debt),
      ],
      [],
    )
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [
        PrepaidCredit {
          fund_id: t_fund_id,
          remaining: 4_000_000_000,
          issued_epoch: 5,
          last_draw_epoch: t_epoch,
          consumed_unsettled: 0,
        },
        t_credit(t_other_fund, 0),
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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
          consumed_unsettled: 0,
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

// Vault vào một lượt đốt: dòng hạn-mức của quỹ chính CÓ MẶT và chưa nợ gì. Mọi
// batch trong nhóm bài này thuộc `t_fund_id`, mà `add_consumed` đòi đúng MỘT
// dòng cho quỹ của batch — đó là chỗ số vừa đốt có nơi đi về.
fn burn_din(batches: List<MagicBatch>) -> PrepaidVaultDatum {
  t_vd([t_credit(t_fund_id, 0)], batches)
}

// Vault ra sau khi đốt `consumed` nanogic từ batch của `t_fund_id`.
fn burn_dout(
  batches  : List<MagicBatch>,
  consumed : Int,
  events   : Int,
) -> PrepaidVaultDatum {
  t_out_burn(batches, [t_credit_u(t_fund_id, 0, consumed)], events)
}

// happy: tiêu một phần batch còn sống; sổ nợ quyết toán tăng ĐÚNG bằng lượng đốt.
test pp_burn_ok() {
  let din = burn_din([t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let dout =
    burn_dout([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], 600_000_000, 1)
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// TẤN CÔNG: ghi nợ THIẾU so với lượng thật sự đốt. Phần chênh là MAGIC đã tiêu
// mà quỹ không bao giờ đòi được — đúng lớp hại mà bản vá này sinh ra để đóng,
// chỉ khác chỗ vào. Cực đối của `pp_burn_ok`: cùng giao dịch, khác một con số.
test pp_burn_counter_short() fail {
  let din = burn_din([t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let dout =
    burn_dout([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], 500_000_000, 1)
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// TẤN CÔNG chiều ngược: ghi nợ THỪA. `SettleLine` sẽ bơm `magic_settled` lên
// quá phần MAGIC tiêu thật, và provider rút CARP theo F2 trên một con số bịa.
test pp_burn_counter_inflated() fail {
  let din = burn_din([t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let dout =
    burn_dout([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], 700_000_000, 1)
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// TẤN CÔNG: đốt trong khi vault KHÔNG có dòng hạn-mức nào cho quỹ của batch.
// Hình dạng lạ (dòng hạn-mức không bao giờ bị xoá) ⟹ phải CHẾT. Cho qua là đốt
// MAGIC mà không ai nợ ai — đúng cái vỏ im lặng.
test pp_burn_no_credit_line() fail {
  let din = t_vd([], [t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let dout = t_out_burn([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], [], 1)
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// happy: MỘT lượt đốt chạm batch của HAI quỹ ⟹ cả hai dòng cùng được ghi nợ.
// Đây là ca mà bản trước không làm được: `paid_fund.spend` ép đúng một quỹ input
// mỗi giao dịch, nên quyết toán tại chỗ chỉ với tới được một quỹ và phần của quỹ
// kia mất dấu vĩnh viễn.
test pp_burn_two_funds_both_lines_credited() {
  let din =
    t_vd(
      [t_credit(t_fund_id, 0), t_credit(t_other_fund, 0)],
      [
        t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id),
        t_batch(#"b2", 1_000_000_000, t_epoch, t_other_fund),
      ],
    )
  let dout =
    t_out_burn(
      [
        t_batch(#"b1", 400_000_000, t_epoch, t_fund_id),
        t_batch(#"b2", 700_000_000, t_epoch, t_other_fund),
      ],
      [
        t_credit_u(t_fund_id, 0, 600_000_000),
        t_credit_u(t_other_fund, 0, 300_000_000),
      ],
      1,
    )
  run_burn(
    din,
    [(#"b1", 600_000_000), (#"b2", 300_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// CỰC ĐỐI của bài ngay trên: đốt batch của hai quỹ nhưng chỉ ghi nợ cho quỹ A.
test pp_burn_two_funds_only_one_line_credited() fail {
  let din =
    t_vd(
      [t_credit(t_fund_id, 0), t_credit(t_other_fund, 0)],
      [
        t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id),
        t_batch(#"b2", 1_000_000_000, t_epoch, t_other_fund),
      ],
    )
  let dout =
    t_out_burn(
      [
        t_batch(#"b1", 400_000_000, t_epoch, t_fund_id),
        t_batch(#"b2", 700_000_000, t_epoch, t_other_fund),
      ],
      [t_credit_u(t_fund_id, 0, 600_000_000), t_credit(t_other_fund, 0)],
      1,
    )
  run_burn(
    din,
    [(#"b1", 600_000_000), (#"b2", 300_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// happy: tiêu hết → batch bị bỏ khỏi danh sách, nợ vẫn được ghi trọn.
test pp_burn_full_ok() {
  let din = burn_din([t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let dout = burn_dout([], 1_000_000_000, 1)
  run_burn(
    din,
    [(#"b1", 1_000_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// TẤN CÔNG cốt lõi: tiêu batch của epoch ĐÃ CHẾT (C-PP-5).
test pp_burn_dead_batch() fail {
  let din = burn_din([t_batch(#"b1", 1_000_000_000, t_epoch - 1, t_fund_id)])
  let dout =
    burn_dout([t_batch(#"b1", 400_000_000, t_epoch - 1, t_fund_id)], 600_000_000, 1)
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// TẤN CÔNG: tiêu quá số dư batch.
test pp_burn_over() fail {
  let din = burn_din([t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let dout = burn_dout([], 2_000_000_000, 1)
  run_burn(
    din,
    [(#"b1", 2_000_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// TẤN CÔNG: không ký.
test pp_burn_no_auth() fail {
  let din = burn_din([t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let dout =
    burn_dout([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], 600_000_000, 1)
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
  let base = burn_din([t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let din = PrepaidVaultDatum { ..base, personal_delegate: Some(t_delegate) }
  let doutb =
    burn_dout([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], 600_000_000, 1)
  let dout = PrepaidVaultDatum { ..doutb, personal_delegate: Some(t_delegate) }
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_delegate]),
  )
}

// ĐỐI CHỨNG DƯƠNG cho bài ngay trên: cùng datum mang delegate cũ, chủ ký ⟹ qua.
test pp_burn_owner_signs_with_stale_delegate_ok() {
  let base = burn_din([t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let din = PrepaidVaultDatum { ..base, personal_delegate: Some(t_delegate) }
  let doutb =
    burn_dout([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], 600_000_000, 1)
  let dout = PrepaidVaultDatum { ..doutb, personal_delegate: Some(t_delegate) }
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// TẤN CÔNG: giả mạo did_commit khi tiêu (phá attribution DID).
test pp_burn_did_forged() fail {
  let din = burn_din([t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let base =
    burn_dout([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], 600_000_000, 1)
  let dout = PrepaidVaultDatum { ..base, did_commit: #"cafe" }
  run_burn(
    din,
    [(#"b1", 600_000_000)],
    t_tx([t_vault_in(din)], [t_vault_out(dout)], [t_owner]),
  )
}

// TẤN CÔNG: tiêu mà không ghi sự kiện attribution.
test pp_burn_no_attribution() fail {
  let din = burn_din([t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let dout =
    burn_dout([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], 600_000_000, 0)
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
      [t_credit_u(t_fund_id, 999_999_999, 600_000_000)],
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
  let din = burn_din([t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
  let dout =
    burn_dout([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], 600_000_000, 1)
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
// SettleLine (constr 6) — quyết toán một dòng hạn-mức
// ══════════════════════════════════════════════════════════════

fn run_settle_line(
  datum   : PrepaidVaultDatum,
  fund_id : ByteArray,
  tx      : Transaction,
) -> Bool {
  validate_settle_line(
    datum, fund_id, t_epoch, t_vault_addr(), t_carp_policy, t_carp_name,
    t_fund_hash, tx,
  )
}

// Quỹ mang `fund_id` bất kỳ — `t_fd` ghim cứng `t_fund_id`, mà bài hai-quỹ cần
// một quỹ thứ hai (NFT của quỹ lấy tên từ chính `datum.fund_id`).
fn t_fd_of(
  fund_id       : ByteArray,
  carp_locked   : Int,
  credit_issued : Int,
  magic_settled : Int,
) -> PaidFundDatum {
  PaidFundDatum {
    ..t_fd(carp_locked, credit_issued, magic_settled, 0, 1_500),
    fund_id,
  }
}

fn sl_din(debt: Int) -> PrepaidVaultDatum {
  t_vd([t_credit_u(t_fund_id, 0, debt)], [])
}

fn sl_dout(debt: Int) -> PrepaidVaultDatum {
  PrepaidVaultDatum {
    ..t_vd([t_credit_u(t_fund_id, 0, debt)], []),
    last_updated_epoch: t_epoch,
  }
}

fn sl_tx(
  din  : PrepaidVaultDatum,
  dout : PrepaidVaultDatum,
  fin  : PaidFundDatum,
  fout : PaidFundDatum,
) -> Transaction {
  // KHÔNG chữ ký nào: nhánh này permissionless (xem `types.ak` ▸ `SettleLine`).
  t_tx(
    [t_vault_in(din), t_fund_in(fin, lock_amt)],
    [t_vault_out(dout), t_fund_out(fout, lock_amt)],
    [],
  )
}

// happy: nợ 0.6 MAGIC chuyển sang sổ quỹ, KHÔNG ai phải ký.
test pp_settle_line_ok() {
  run_settle_line(
    sl_din(600_000_000),
    t_fund_id,
    sl_tx(
      sl_din(600_000_000),
      sl_dout(0),
      t_fd(lock_amt, lock_amt, 0, 0, 1_500),
      t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500),
    ),
  )
}

// TẤN CÔNG: xoá nợ mà KHÔNG kèm quỹ. Đây là hình dạng mà bản trước NHẬN ở nhánh
// `BurnBatch` — và nhận nó là làm mất dấu phần MAGIC đã tiêu vĩnh viễn.
test pp_settle_line_no_fund() fail {
  let din = sl_din(600_000_000)
  run_settle_line(
    din,
    t_fund_id,
    t_tx([t_vault_in(din)], [t_vault_out(sl_dout(0))], []),
  )
}

// TẤN CÔNG: quỹ cộng ÍT hơn phần nợ được xoá — phần chênh biến mất.
test pp_settle_line_fund_short() fail {
  run_settle_line(
    sl_din(600_000_000),
    t_fund_id,
    sl_tx(
      sl_din(600_000_000),
      sl_dout(0),
      t_fd(lock_amt, lock_amt, 0, 0, 1_500),
      t_fd(lock_amt, lock_amt, 500_000_000, 0, 1_500),
    ),
  )
}

// TẤN CÔNG: quỹ cộng NHIỀU hơn — bơm `magic_settled` để rút CARP qua F2.
test pp_settle_line_fund_inflated() fail {
  run_settle_line(
    sl_din(600_000_000),
    t_fund_id,
    sl_tx(
      sl_din(600_000_000),
      sl_dout(0),
      t_fd(lock_amt, lock_amt, 0, 0, 1_500),
      t_fd(lock_amt, lock_amt, 900_000_000, 0, 1_500),
    ),
  )
}

// TẤN CÔNG: xoá nợ MỘT PHẦN nhưng quỹ nhận trọn — `delta` luôn là toàn bộ nợ
// của dòng, nên output vault phải về đúng 0.
test pp_settle_line_partial_zero() fail {
  run_settle_line(
    sl_din(600_000_000),
    t_fund_id,
    sl_tx(
      sl_din(600_000_000),
      sl_dout(100_000_000),
      t_fd(lock_amt, lock_amt, 0, 0, 1_500),
      t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500),
    ),
  )
}

// TẤN CÔNG (reject-noop): dòng không nợ gì mà vẫn tiêu UTxO vault — người lạ
// chặn cửa vault vô hạn lần, giá chỉ bằng phí.
test pp_settle_line_zero_delta() fail {
  run_settle_line(
    sl_din(0),
    t_fund_id,
    sl_tx(
      sl_din(0),
      sl_dout(0),
      t_fd(lock_amt, lock_amt, 0, 0, 1_500),
      t_fd(lock_amt, lock_amt, 0, 0, 1_500),
    ),
  )
}

// TẤN CÔNG: nhân lượt quyết toán quỹ A thì xoá luôn nợ của quỹ B — B mất doanh
// thu mà không giao dịch nào của B tham gia.
test pp_settle_line_zeroes_other_line() fail {
  let din =
    t_vd(
      [t_credit_u(t_fund_id, 0, 600_000_000), t_credit_u(t_other_fund, 0, 300_000_000)],
      [],
    )
  let dout =
    PrepaidVaultDatum {
      ..t_vd([t_credit_u(t_fund_id, 0, 0), t_credit_u(t_other_fund, 0, 0)], []),
      last_updated_epoch: t_epoch,
    }
  run_settle_line(
    din,
    t_fund_id,
    sl_tx(
      din, dout,
      t_fd(lock_amt, lock_amt, 0, 0, 1_500),
      t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500),
    ),
  )
}

// TẤN CÔNG: quyết toán một dòng KHÔNG TỒN TẠI.
test pp_settle_line_no_credit_line() fail {
  let din = t_vd([], [])
  let dout = PrepaidVaultDatum { ..t_vd([], []), last_updated_epoch: t_epoch }
  run_settle_line(
    din,
    t_fund_id,
    sl_tx(
      din, dout,
      t_fd(lock_amt, lock_amt, 0, 0, 1_500),
      t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500),
    ),
  )
}

// TẤN CÔNG: quỹ trỏ về một script vault KHÁC — nó không phải quỹ của vault này.
test pp_settle_line_fund_wrong_vault_hash() fail {
  let fin =
    PaidFundDatum { ..t_fd(lock_amt, lock_amt, 0, 0, 1_500), vault_hash: t_evil_hash }
  let fout =
    PaidFundDatum {
      ..t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500),
      vault_hash: t_evil_hash,
    }
  run_settle_line(
    sl_din(600_000_000),
    t_fund_id,
    sl_tx(sl_din(600_000_000), sl_dout(0), fin, fout),
  )
}

// TẤN CÔNG: mượn lượt quyết toán để rút CARP khỏi quỹ.
test pp_settle_line_drains_carp() fail {
  run_settle_line(
    sl_din(600_000_000),
    t_fund_id,
    t_tx(
      [t_vault_in(sl_din(600_000_000)), t_fund_in(t_fd(lock_amt, lock_amt, 0, 0, 1_500), lock_amt)],
      [
        t_vault_out(sl_dout(0)),
        t_fund_out(t_fd(0, lock_amt, 600_000_000, 0, 1_500), 0),
      ],
      [],
    ),
  )
}

// TẤN CÔNG: mượn lượt quyết toán để cấp thêm hạn-mức cho chính mình.
test pp_settle_line_mints_credit() fail {
  let din = sl_din(600_000_000)
  let dout =
    PrepaidVaultDatum {
      ..t_vd([t_credit_u(t_fund_id, 999_000_000, 0)], []),
      last_updated_epoch: t_epoch,
    }
  run_settle_line(
    din,
    t_fund_id,
    sl_tx(
      din, dout,
      t_fd(lock_amt, lock_amt, 0, 0, 1_500),
      t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500),
    ),
  )
}

// TẤN CÔNG: giữ CARP lại trong vault (C-PP-14 — vault PrepaidGen không bao giờ
// giữ CARP).
test pp_settle_line_vault_holds_carp() fail {
  let din = sl_din(600_000_000)
  run_settle_line(
    din,
    t_fund_id,
    t_tx(
      [t_vault_in(din), t_fund_in(t_fd(lock_amt, lock_amt, 0, 0, 1_500), lock_amt)],
      [
        t_vault_out_v(sl_dout(0), 1),
        t_fund_out(t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500), lock_amt),
      ],
      [],
    ),
  )
}

// Tái dựng PoC `poc_two_funds_burned_only_A_settles` — nhưng thành ĐƯỜNG DƯƠNG.
// Một lượt đốt chạm batch của hai quỹ thì quyết toán bằng HAI giao dịch riêng,
// mỗi giao dịch một quỹ; cả hai đều qua và không đồng MAGIC nào mất dấu. Bản
// trước chỉ với tới được quỹ A (vì `paid_fund.spend` ép đúng một quỹ input mỗi
// giao dịch, mà `settle_delta` chỉ đo được trong chính giao dịch đốt), nên phần
// của B chết vĩnh viễn trong quỹ B.
test pp_two_funds_settle_in_two_txs_ok() {
  let d0 =
    t_vd(
      [t_credit_u(t_fund_id, 0, 600_000_000), t_credit_u(t_other_fund, 0, 300_000_000)],
      [],
    )
  // Giao dịch 1 — quỹ A. Nợ của B đứng nguyên.
  let d1 =
    PrepaidVaultDatum {
      ..t_vd(
        [t_credit_u(t_fund_id, 0, 0), t_credit_u(t_other_fund, 0, 300_000_000)],
        [],
      ),
      last_updated_epoch: t_epoch,
    }
  let a_ok =
    run_settle_line(
      d0,
      t_fund_id,
      sl_tx(
        d0, d1,
        t_fd_of(t_fund_id, lock_amt, lock_amt, 0),
        t_fd_of(t_fund_id, lock_amt, lock_amt, 600_000_000),
      ),
    )

  // Giao dịch 2 — quỹ B, trên chính vault vừa đi ra khỏi giao dịch 1.
  let d2 =
    PrepaidVaultDatum {
      ..t_vd([t_credit_u(t_fund_id, 0, 0), t_credit_u(t_other_fund, 0, 0)], []),
      last_updated_epoch: t_epoch,
    }
  let b_ok =
    run_settle_line(
      d1,
      t_other_fund,
      sl_tx(
        d1, d2,
        t_fd_of(t_other_fund, lock_amt, lock_amt, 0),
        t_fd_of(t_other_fund, lock_amt, lock_amt, 300_000_000),
      ),
    )
  a_ok && b_ok
}

// INV-MAGIC-CITIZEN, vế cấu trúc: `PrunePrepaid` KHÔNG được biến MAGIC HẾT HẠN
// thành nợ quyết toán. Đây là chỗ bất biến ấy sống sau khi quỹ thôi đo delta
// batch — nếu prune cộng được vào `consumed_unsettled` thì `SettleLine` sau đó
// hợp thức hoá nó mà không ai thấy.
test pp_prune_inflates_consumed_unsettled() fail {
  let din =
    t_vd([t_credit_u(t_fund_id, 0, 0)], [t_batch(#"b1", 1_000_000_000, t_epoch - 1, t_fund_id)])
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [t_credit_u(t_fund_id, 1_000_000_000, 1_000_000_000)],
      magic_batches: [],
      last_updated_epoch: t_epoch,
    }
  run_prune(din, t_tx([t_vault_in(din)], [t_vault_out(dout)], []))
}

// ĐỐI CHỨNG DƯƠNG: cùng lượt dọn, nợ quyết toán đã có từ trước ĐỨNG YÊN qua
// prune — nó không bị xoá (phần đã tiêu thật vẫn đòi được sau khi batch chết).
test pp_prune_keeps_consumed_unsettled() {
  let din =
    t_vd(
      [t_credit_u(t_fund_id, 0, 400_000_000)],
      [t_batch(#"b1", 600_000_000, t_epoch - 1, t_fund_id)],
    )
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [t_credit_u(t_fund_id, 600_000_000, 400_000_000)],
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
    t_fund_hash, t_epoch, t_wakeme_hash, run_fund_u(fin, redeemer, tx), redeemer,
    tx,
  )
}

// `u` mà thân handler tính cho `FundReclaim` — gọi thẳng `fund_common_checks` thì
// phải tính đúng như handler, nếu không bài gọi thẳng đo một hàm khác.
fn run_fund_u(fin: PaidFundDatum, redeemer: PaidFundRedeemer, tx: Transaction) -> Int {
  when redeemer is {
    FundReclaim -> reclaim_unsettled(fin, tx)
    _ -> 0
  }
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
//
// Từ 2026-09-28 quỹ KHÔNG còn đo delta bằng phần `current_amount` giảm trong
// chính giao dịch đốt. Nó đọc `PrepaidCredit.consumed_unsettled` của dòng mang
// `fund_id` của mình, ở cặp datum vault vào/ra, và đòi vault cùng tiêu bằng
// `SettleLine` (constr 6).

// Giao dịch quyết toán: vault đưa nợ của dòng `t_fund_id` từ `debt_in` xuống
// `debt_out`; quỹ đi từ `fin` sang `fout`.
fn settle_tx(
  debt_in   : Int,
  debt_out  : Int,
  fin       : PaidFundDatum,
  fin_carp  : Int,
  fout      : PaidFundDatum,
  fout_carp : Int,
  vault_r   : PrepaidVaultRedeemer,
) -> Transaction {
  let vin_d = t_vd([t_credit_u(t_fund_id, 0, debt_in)], [])
  let vout_d =
    PrepaidVaultDatum {
      ..t_vd([t_credit_u(t_fund_id, 0, debt_out)], []),
      last_updated_epoch: t_epoch,
    }
  t_tx_rd(
    [t_vault_in(vin_d), t_fund_in(fin, fin_carp)],
    [t_vault_out(vout_d), t_fund_out(fout, fout_carp)],
    [t_platform],
    vault_r,
  )
}

// happy: nợ 0.6 MAGIC được xoá khỏi dòng → magic_settled += 600_000_000.
test pp_fund_settle_ok() {
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500)
  let tx =
    settle_tx(
      600_000_000, 0, fin, lock_amt, fout, lock_amt,
      SettleLine { fund_id: t_fund_id },
    )
  run_fund(fin, lock_amt, tx, FundSettle)
}

// TẤN CÔNG — hình dạng này TỪNG LÀ ĐƯỜNG DƯƠNG (trước 2026-09-28): quỹ bị tiêu
// bằng FundSettle trong khi vault chạy `BurnBatch` (constr 2). Nay `BurnBatch`
// chỉ GHI NỢ, nó không xoá nợ, nên cho qua ở đây là cộng `magic_settled` hai
// lần cho cùng một lượt tiêu.
test pp_fund_settle_cospend_burn_batch() fail {
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500)
  let tx =
    settle_tx(
      600_000_000, 0, fin, lock_amt, fout, lock_amt,
      BurnBatch { burns: [(#"b1", 600_000_000)] },
    )
  run_fund(fin, lock_amt, tx, FundSettle)
}

// TẤN CÔNG: quyết toán trong khi vault chạy PrunePrepaid (constr 3) —
// hết hạn KHÔNG phải tiêu thật (INV-MAGIC-CITIZEN).
test pp_fund_settle_under_prune() fail {
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500)
  let tx =
    settle_tx(600_000_000, 0, fin, lock_amt, fout, lock_amt, PrunePrepaid)
  run_fund(fin, lock_amt, tx, FundSettle)
}

// TẤN CÔNG: khai settled cao hơn phần nợ thật sự được xoá.
test pp_fund_settle_inflated() fail {
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 900_000_000, 0, 1_500)
  let tx =
    settle_tx(
      600_000_000, 0, fin, lock_amt, fout, lock_amt,
      SettleLine { fund_id: t_fund_id },
    )
  run_fund(fin, lock_amt, tx, FundSettle)
}

// TẤN CÔNG: nợ đứng yên mà quỹ vẫn cộng — quyết toán từ hư không.
test pp_fund_settle_zero_delta() fail {
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500)
  let tx =
    settle_tx(
      600_000_000, 600_000_000, fin, lock_amt, fout, lock_amt,
      SettleLine { fund_id: t_fund_id },
    )
  run_fund(fin, lock_amt, tx, FundSettle)
}

// TẤN CÔNG: quyết toán bằng nợ của quỹ KHÁC. Dòng của quỹ này đứng yên ở 0, chỉ
// dòng `t_other_fund` được xoá — quỹ này không có quyền gì trên con số đó.
test pp_fund_settle_other_fund_line() fail {
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500)
  let vin_d =
    t_vd([t_credit_u(t_fund_id, 0, 0), t_credit_u(t_other_fund, 0, 600_000_000)], [])
  let vout_d =
    PrepaidVaultDatum {
      ..t_vd([t_credit_u(t_fund_id, 0, 0), t_credit_u(t_other_fund, 0, 0)], []),
      last_updated_epoch: t_epoch,
    }
  let tx =
    t_tx_rd(
      [t_vault_in(vin_d), t_fund_in(fin, lock_amt)],
      [t_vault_out(vout_d), t_fund_out(fout, lock_amt)],
      [t_platform],
      SettleLine { fund_id: t_other_fund },
    )
  run_fund(fin, lock_amt, tx, FundSettle)
}

// TẤN CÔNG: datum vault khai HAI dòng cho cùng một quỹ. Quỹ đọc delta từ datum
// mà nó không tự dựng, nên nó phải tự kiểm tính duy nhất — `list.find` một mình
// lấy dòng ĐẦU TIÊN và bỏ qua dòng thứ hai, tức chọn được con số có lợi.
//
// Hai bài, hai đầu, vì `settle_line_delta` có hai phép đếm riêng biệt: một cho
// datum vào, một cho datum ra. Thiếu bài nào thì phép đếm bên đó không có ai canh.
test pp_fund_settle_duplicate_line_in() fail {
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500)
  let vin_d =
    t_vd(
      [t_credit_u(t_fund_id, 0, 600_000_000), t_credit_u(t_fund_id, 0, 100_000_000)],
      [],
    )
  let vout_d =
    PrepaidVaultDatum {
      ..t_vd([t_credit_u(t_fund_id, 0, 0)], []),
      last_updated_epoch: t_epoch,
    }
  let tx =
    t_tx_rd(
      [t_vault_in(vin_d), t_fund_in(fin, lock_amt)],
      [t_vault_out(vout_d), t_fund_out(fout, lock_amt)],
      [t_platform],
      SettleLine { fund_id: t_fund_id },
    )
  run_fund(fin, lock_amt, tx, FundSettle)
}

test pp_fund_settle_duplicate_line_out() fail {
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500)
  let vin_d = t_vd([t_credit_u(t_fund_id, 0, 600_000_000)], [])
  let vout_d =
    PrepaidVaultDatum {
      ..t_vd([t_credit_u(t_fund_id, 0, 0), t_credit_u(t_fund_id, 0, 500_000_000)], []),
      last_updated_epoch: t_epoch,
    }
  let tx =
    t_tx_rd(
      [t_vault_in(vin_d), t_fund_in(fin, lock_amt)],
      [t_vault_out(vout_d), t_fund_out(fout, lock_amt)],
      [t_platform],
      SettleLine { fund_id: t_fund_id },
    )
  run_fund(fin, lock_amt, tx, FundSettle)
}

// TẤN CÔNG: "vault" giả ở script khác (đúng cái mà khuôn shard.ak để hở).
test pp_fund_settle_fake_vault() fail {
  let vin_d = t_vd([t_credit_u(t_fund_id, 0, 600_000_000)], [])
  let vout_d = t_vd([t_credit_u(t_fund_id, 0, 0)], [])
  let evil = address.from_script(t_evil_hash)
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500)
  let rd: Data = SettleLine { fund_id: t_fund_id }
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
      600_000_000, 0, fin, lock_amt, fout, 0,
      SettleLine { fund_id: t_fund_id },
    )
  run_fund(fin, lock_amt, tx, FundSettle)
}

// ── Hình dạng UTxO quỹ tiếp nối (vá 2026-09-28) ───────────────
//
// Bốn vế dưới đây genesis đã ép từ lâu, nhánh spend thì chưa — nên một lượt vận
// hành hợp lệ vẫn đẻ ra được một quỹ méo mà mọi lượt sau kế thừa. Dùng chính
// giao dịch quyết toán hợp lệ rồi bóp méo ĐÚNG MỘT vế của output quỹ.

fn settle_ok_tx_with_fund_out(fout_utxo: Output) -> Transaction {
  let vin_d = t_vd([t_credit_u(t_fund_id, 0, 600_000_000)], [])
  let vout_d =
    PrepaidVaultDatum {
      ..t_vd([t_credit_u(t_fund_id, 0, 0)], []),
      last_updated_epoch: t_epoch,
    }
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  t_tx_rd(
    [t_vault_in(vin_d), t_fund_in(fin, lock_amt)],
    [t_vault_out(vout_d), fout_utxo],
    [t_platform],
    SettleLine { fund_id: t_fund_id },
  )
}

fn settle_fin() -> PaidFundDatum {
  t_fd(lock_amt, lock_amt, 0, 0, 1_500)
}

fn settle_fout() -> PaidFundDatum {
  t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500)
}

// ĐỐI CHỨNG DƯƠNG cho bốn bài dưới: cùng đường chạy, output quỹ không méo.
test pp_fund_out_shape_ok() {
  run_fund(
    settle_fin(),
    lock_amt,
    settle_ok_tx_with_fund_out(t_fund_out(settle_fout(), lock_amt)),
    FundSettle,
  )
}

// TẤN CÔNG: gắn reference script vào UTxO quỹ tiếp nối. Không giao dịch nào
// lỗi, nhưng min-ADA đội lên và không nhánh nào rút ADA khỏi quỹ ⟹ khoá vốn
// vĩnh viễn, im lặng.
test pp_fund_out_reference_script() fail {
  let fout_utxo =
    Output { ..t_fund_out(settle_fout(), lock_amt), reference_script: Some(t_evil_hash) }
  run_fund(settle_fin(), lock_amt, settle_ok_tx_with_fund_out(fout_utxo), FundSettle)
}

// TẤN CÔNG: rút bớt ADA tối thiểu của quỹ.
test pp_fund_out_lovelace_siphoned() fail {
  let fd = settle_fout()
  let fout_utxo =
    Output {
      ..t_fund_out(fd, lock_amt),
      value: assets.from_lovelace(1_000_000)
        |> assets.add(t_carp_policy, t_carp_name, lock_amt)
        |> assets.add(t_fund_hash, fd.fund_id, 1),
    }
  run_fund(settle_fin(), lock_amt, settle_ok_tx_with_fund_out(fout_utxo), FundSettle)
}

// TẤN CÔNG: tên tài sản THỨ HAI dưới chính policy quỹ. `find_fund_output_utxo`
// dùng `quantity_of` nên nó trả lời "có đúng NFT đó", KHÔNG trả lời "chỉ có NFT
// đó"; cổng đếm policy thì đếm POLICY nên cũng không thấy.
test pp_fund_out_second_name_under_fund_policy() fail {
  let fd = settle_fout()
  let fout_utxo =
    Output {
      ..t_fund_out(fd, lock_amt),
      value: t_fund_value(lock_amt, fd.fund_id)
        |> assets.add(t_fund_hash, #"a1a1", 1),
    }
  run_fund(settle_fin(), lock_amt, settle_ok_tx_with_fund_out(fout_utxo), FundSettle)
}

// TẤN CÔNG: nhét bụi token (policy thứ tư) cho phình value của quỹ.
test pp_fund_out_dust_stuffed() fail {
  let fd = settle_fout()
  let fout_utxo =
    Output {
      ..t_fund_out(fd, lock_amt),
      value: t_fund_value(lock_amt, fd.fund_id)
        |> assets.add(t_evil_hash, #"dd", 1),
    }
  run_fund(settle_fin(), lock_amt, settle_ok_tx_with_fund_out(fout_utxo), FundSettle)
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

// happy (đệm 0, sàn genesis từ 2026-10-05): quỹ `buffer_bps = 0` rút tới ĐÚNG
// `outstanding` — sàn `buffer_floor(500e6, 0) = 500e6`, công thức không đổi.
test pp_fund_claim_zero_buffer_to_outstanding_ok() {
  let fin = t_fd(1_000_000_000, 1_000_000_000, 500_000_000, 0, 0)
  let fout = t_fd(500_000_000, 1_000_000_000, 500_000_000, 500_000_000, 0)
  run_fund(
    fin, 1_000_000_000,
    claim_tx(fin, 1_000_000_000, fout, 500_000_000, [t_platform]),
    FundClaim { amount_carpdrop: 500_000_000 },
  )
}

// Cặp cực đối của bài trên: cùng số, chỉ khác `buffer_bps = 1500` ở cả hai datum
// ⟹ sàn 575e6 > 500e6, bị chặn. Ghim rằng `buffer_bps` của quỹ vẫn được đọc.
test pp_fund_claim_same_amount_buffer_1500_rejected() fail {
  let fin = t_fd(1_000_000_000, 1_000_000_000, 500_000_000, 0, 1_500)
  let fout = t_fd(500_000_000, 1_000_000_000, 500_000_000, 500_000_000, 1_500)
  run_fund(
    fin, 1_000_000_000,
    claim_tx(fin, 1_000_000_000, fout, 500_000_000, [t_platform]),
    FundClaim { amount_carpdrop: 500_000_000 },
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
      1_500_000_000, 0, fin, lock_amt, fout, lock_amt,
      SettleLine { fund_id: t_fund_id },
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
  get_epoch(tx_range(7 * ms_ep + 10, 7 * ms_ep + 20), ms_ep, 0) == 7
}

// TẤN CÔNG: khoảng hiệu lực trải qua hai epoch → current_epoch nhập nhằng.
test pp_epoch_straddle() fail {
  get_epoch(tx_range(7 * ms_ep - 5, 7 * ms_ep + 5), ms_ep, 0) == 7
}

// TẤN CÔNG: biên trên vô hạn (mẫu tấn công cổ điển của SEC-02).
test pp_epoch_open_upper() fail {
  let tx =
    Transaction { ..placeholder, validity_range: interval.after(7 * ms_ep) }
  get_epoch(tx, ms_ep, 0) == 7
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
    t_carp_policy, t_carp_name, t_fund_hash, ms_ep, 0,
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
  run_spend_at(0, 0, datum, redeemer, tx)
}

/// `run_spend` với gốc lưới `origin` (apply-param cuối) và validity range dời `shift` ms.
fn run_spend_at(
  origin   : Int,
  shift    : Int,
  datum    : PrepaidVaultDatum,
  redeemer : PrepaidVaultRedeemer,
  tx       : Transaction,
) -> Bool {
  prepaid_vault.spend(
    t_carp_policy, t_carp_name, t_fund_hash, ms_ep, origin,
    Some(datum), redeemer, t_own_ref(), window_origin_fixtures.shift_tx(tx, shift),
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
        consumed_unsettled: 0,
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

// ═══ Gốc lưới cửa sổ (LAMP Specs/Window/CONTRACT.md v1.0) ═════════════════
// Cùng ca `pp_spend_lock_ok`, tx dời đúng bằng gốc và validator nhận gốc đó ⟹ trừ gốc
// thì vẫn epoch `t_epoch`, khớp `last_updated_epoch` của két và quỹ. Quên trừ ⟹ đỏ.
fn wo_lock_run(origin: Int, shift: Int) -> Bool {
  run_spend_at(
    origin, shift, sp_lock_din(),
    PrepaidLock { fund_id: t_fund_id, amount_carpdrop: lock_amt },
    sp_lock_tx(t_vault_in(sp_lock_din()), t_vault_out(sp_lock_dout())),
  )
}

test wo_prepaid_lock_mainnet_origin() {
  wo_lock_run(window_origin_fixtures.mainnet_origin_ms, window_origin_fixtures.mainnet_origin_ms)
}

test wo_prepaid_lock_preprod_origin() {
  wo_lock_run(window_origin_fixtures.preprod_origin_ms, window_origin_fixtures.preprod_origin_ms)
}

test wo_prepaid_lock_forgotten_origin() fail {
  wo_lock_run(0, window_origin_fixtures.mainnet_origin_ms)
}

// `paid_fund.spend` qua HANDLER (các bài `run_fund` gọi thẳng `fund_common_checks` với
// epoch cho sẵn, không đi qua `get_epoch`). Cùng tx với `pp_fund_claim_full_ok`.
fn wo_fund_claim_run(origin: Int, shift: Int) -> Bool {
  let fin = t_fd(1_000_000_000, 1_000_000_000, 1_000_000_000, 0, 1_500)
  let fout = t_fd(0, 1_000_000_000, 1_000_000_000, 1_000_000_000, 1_500)
  let lo = shift + t_epoch * ms_ep + 10
  paid_fund.spend(
    t_carp_policy, t_carp_name, ms_ep, origin, t_wakeme_hash,
    Some(fin), FundClaim { amount_carpdrop: 1_000_000_000 }, t_fund_ref(),
    Transaction {
      ..claim_tx(fin, 1_000_000_000, fout, 0, [t_platform]),
      validity_range: interval.between(lo, lo + 10),
    },
  )
}

test wo_fund_claim_handler_zero_origin() {
  wo_fund_claim_run(0, 0)
}

test wo_fund_claim_handler_mainnet_origin() {
  wo_fund_claim_run(window_origin_fixtures.mainnet_origin_ms, window_origin_fixtures.mainnet_origin_ms)
}

test wo_fund_claim_handler_preprod_origin() {
  wo_fund_claim_run(window_origin_fixtures.preprod_origin_ms, window_origin_fixtures.preprod_origin_ms)
}

test wo_fund_claim_handler_forgotten_origin() fail {
  wo_fund_claim_run(0, window_origin_fixtures.mainnet_origin_ms)
}

// Vector CONTRACT §3 trên `get_epoch` (hai biên cùng epoch).
test wo_get_epoch_mainnet_at_boundary() {
  let t = window_origin_fixtures.mainnet_t_658
  get_epoch(
    window_origin_fixtures.tx_between(t, t + 1_000),
    window_origin_fixtures.ms_per_window,
    window_origin_fixtures.mainnet_origin_ms,
  ) == 658
}

test wo_get_epoch_mainnet_one_ms_before() {
  let t = window_origin_fixtures.mainnet_t_658
  get_epoch(
    window_origin_fixtures.tx_between(t - 1_000, t - 1),
    window_origin_fixtures.ms_per_window,
    window_origin_fixtures.mainnet_origin_ms,
  ) == 657
}

test wo_get_epoch_preprod_at_boundary() {
  let t = window_origin_fixtures.preprod_t_316
  get_epoch(
    window_origin_fixtures.tx_between(t, t + 1_000),
    window_origin_fixtures.ms_per_window,
    window_origin_fixtures.preprod_origin_ms,
  ) == 316
}

test wo_get_epoch_preprod_one_ms_before() {
  let t = window_origin_fixtures.preprod_t_316
  get_epoch(
    window_origin_fixtures.tx_between(t - 1_000, t - 1),
    window_origin_fixtures.ms_per_window,
    window_origin_fixtures.preprod_origin_ms,
  ) == 315
}

test wo_get_epoch_preprod_straddle() fail {
  let t = window_origin_fixtures.preprod_t_316
  get_epoch(
    window_origin_fixtures.tx_between(t - 1, t + 1_000),
    window_origin_fixtures.ms_per_window,
    window_origin_fixtures.preprod_origin_ms,
  ) == 315
}

test wo_get_epoch_mainnet_forgotten_origin() fail {
  let t = window_origin_fixtures.mainnet_t_658
  expect
    get_epoch(
      window_origin_fixtures.tx_between(t, t + 1_000),
      window_origin_fixtures.ms_per_window,
      0,
    ) == 658
  True
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
        consumed_unsettled: 0,
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
  burn_din([t_batch(#"b1", 1_000_000_000, t_epoch, t_fund_id)])
}

fn sp_burn_dout() -> PrepaidVaultDatum {
  burn_dout([t_batch(#"b1", 400_000_000, t_epoch, t_fund_id)], 600_000_000, 1)
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

// TẤN CÔNG (C-PP-10 · thoả-mãn-kép): tiêu HAI vault trong một giao dịch, mà chỉ
// trả về MỘT output vault — vault thứ hai bốc hơi cùng toàn bộ hạn mức của nó.
//
// Bài này CỐ Ý trùng hình dạng với `pp_spend_settle_line_two_vault_inputs` ở
// nhánh khác, và trùng là ĐÚNG chứ không phải thừa. `C-PP-10` là chốt dùng chung
// cho cả bảy nhánh, đặt ở thân `spend`; nếu nó chỉ có một bài canh và bài đó đi
// qua nhánh `SettleLine`, thì ngày nào đó nhánh ấy bị gỡ là chốt chống
// thoả-mãn-kép của SÁU nhánh còn lại mất người canh mà không gì đỏ. Nhánh
// `PrunePrepaid` được chọn làm bản thứ hai vì nó permissionless (không cần chữ
// ký) và không cần fixture quỹ — rẻ nhất trong bảy nhánh.
//
// Đi QUA handler là bắt buộc: phép đếm nằm ở thân `spend`, gọi thẳng
// `validate_prune` thì không chạm tới nó.
test pp_spend_prune_two_vault_inputs() fail {
  let vin2 =
    Input {
      output_reference: OutputReference {
        transaction_id: t_tx_id,
        output_index: 9,
      },
      output: t_vault_out(sp_prune_din()),
    }
  run_spend(
    sp_prune_din(),
    PrunePrepaid,
    branch_tx(
      t_vault_in(sp_prune_din()),
      t_vault_out(sp_prune_dout()),
      [vin2],
      [],
      [],
    ),
  )
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

// ── Nhánh 7/7 — SettleLine (permissionless: KHÔNG chữ ký) ──────
//
// Nhánh này là nhánh DUY NHẤT vừa permissionless vừa đụng tới một script KHÁC
// (sổ quỹ), nên nếu cổng định danh vault ở thân handler có chỗ hở thì đây là
// chỗ khai thác rẻ nhất — không cần khoá của ai. Chú thích ở thân `spend` khai
// rằng cổng đó phủ "CẢ BẢY nhánh"; các bài dưới đây là phép ĐO câu đó cho nhánh
// thứ bảy, không phải một lời khai về nó.

fn sp_settle_din() -> PrepaidVaultDatum {
  sl_din(600_000_000)
}

fn sp_settle_dout() -> PrepaidVaultDatum {
  sl_dout(0)
}

// Dựng bằng `branch_tx` chứ không phải `sl_tx`: handler suy epoch từ
// `validity_range`, mà `t_tx` (nền của `sl_tx`) không đặt trường đó.
fn sp_settle_tx(vin: Input, vout: Output, more_ins: List<Input>) -> Transaction {
  branch_tx(
    vin,
    vout,
    list.concat(
      [t_fund_in(t_fd(lock_amt, lock_amt, 0, 0, 1_500), lock_amt)],
      more_ins,
    ),
    [t_fund_out(t_fd(lock_amt, lock_amt, 600_000_000, 0, 1_500), lock_amt)],
    [],
  )
}

fn sp_settle_run(vin: Input, vout: Output) -> Bool {
  run_spend(
    sp_settle_din(),
    SettleLine { fund_id: t_fund_id },
    sp_settle_tx(vin, vout, []),
  )
}

test pp_spend_settle_line_ok() {
  sp_settle_run(t_vault_in(sp_settle_din()), t_vault_out(sp_settle_dout()))
}

test pp_spend_settle_line_forged_vault() fail {
  sp_settle_run(
    t_vault_in_no_nft(sp_settle_din()), t_vault_out_no_nft(sp_settle_dout()),
  )
}

test pp_spend_settle_line_nft_escapes() fail {
  sp_settle_run(t_vault_in(sp_settle_din()), t_vault_out_no_nft(sp_settle_dout()))
}

// TẤN CÔNG: gắn reference script vào output vault ở đúng nhánh permissionless.
// Bài `pp_spend_reference_script_attached` đã canh cổng này qua nhánh `Prune`;
// bài này KHÔNG lặp lại nó mà đo một thứ khác: người dựng giao dịch ở đây không
// cần là chủ vault, nên chi phí tấn công bằng đúng phí mạng.
test pp_spend_settle_line_reference_script() fail {
  let vout =
    Output {
      ..t_vault_out(sp_settle_dout()),
      reference_script: Some(t_evil_hash),
    }
  sp_settle_run(t_vault_in(sp_settle_din()), vout)
}

// TẤN CÔNG (C-PP-10 · thoả-mãn-kép): tiêu HAI vault trong một giao dịch, mỗi
// vault nợ 0.6 MAGIC, mà chỉ kèm MỘT quỹ cộng 0.6 — nợ của vault thứ hai bị xoá
// không công. `validate_settle_line` một mình KHÔNG bắt được: nó chỉ nhìn datum
// vào/ra của một vault và không biết có vault thứ hai trong cùng giao dịch.
//
// Nên bài phải đi QUA handler: phép đếm mang nhãn `C-PP-10` nằm ở thân `spend`,
// gọi thẳng `validate_settle_line` thì không chạm tới nó. Trước bài này không
// bài nào canh dòng đó (đo đột biến 2026-09-28: gỡ nó ra, 0 bài đỏ).
test pp_spend_settle_line_two_vault_inputs() fail {
  let vin2 =
    Input {
      output_reference: OutputReference {
        transaction_id: t_tx_id,
        output_index: 9,
      },
      output: t_vault_out(sp_settle_din()),
    }
  run_spend(
    sp_settle_din(),
    SettleLine { fund_id: t_fund_id },
    sp_settle_tx(
      t_vault_in(sp_settle_din()),
      t_vault_out(sp_settle_dout()),
      [vin2],
    ),
  )
}

// ── Ba cổng còn lại của `vault_identity_preserved` ─────────────

// TẤN CÔNG: gắn reference script vào output vault tiếp nối (vá 2026-09-28).
// Cổng đúc đã ghim vế này cho UTxO genesis, nhánh spend thì chưa — nên một lượt
// dọn rác hợp lệ vẫn đội min-ADA của vault lên, mà dòng `lovelace(out) >=
// lovelace(in)` chỉ cho ADA đi lên và không nhánh nào rút ADA ra ⟹ khoá vốn
// vĩnh viễn, không giao dịch nào lỗi.
test pp_spend_reference_script_attached() fail {
  let vout =
    Output {
      ..t_vault_out(sp_prune_dout()),
      reference_script: Some(t_evil_hash),
    }
  sp_prune_run(t_vault_in(sp_prune_din()), vout)
}

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
    sponsorship: None,
    sponsor_reclaimed: 0,
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
    t_carp_policy, t_carp_name, ms_ep, 0, t_wakeme_hash,
    Void, t_fund_hash,
    Transaction {
      ..placeholder,
      inputs: [fg_seed_input()],
      outputs: outs,
      mint: m,
      extra_signatories: signers,
      // Cận TRÊN hữu hạn ở epoch `t_epoch`: genesis quỹ tài trợ đòi nó để tính mốc
      // `reclaim_after_epoch` (quỹ thường không đọc).
      validity_range: interval.between(t_epoch * ms_ep + 10, t_epoch * ms_ep + 20),
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

// TẤN CÔNG: `buffer_bps` âm ⟹ `buffer_floor` dưới `outstanding`. Sàn genesis là
// `min_buffer_bps = 0` (chủ dự án chốt 2026-10-05) nên −1 là giá trị sát sàn.
test fg_mint_buffer_negative() fail {
  fg_mint_with(fg_datum(fg_name(), 0, 0, 0, 0, -1, 0))
}

// Cặp dương cực đối: đệm 0 đúc được (trước 2026-10-05 sàn là 1500 ⟹ bài này đỏ).
test fg_mint_buffer_zero_ok() {
  fg_mint_with(fg_datum(fg_name(), 0, 0, 0, 0, 0, 0))
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

// TẤN CÔNG (tự hưởng, 2026-10-05): bên hưởng là chính khoá `platform` — CARP mà
// platform nạp hộ người dùng quay về platform qua `FundClaim`.
test fg_mint_beneficiary_is_platform_key() fail {
  fg_mint_ben(address.from_verification_key(t_platform), None)
}

// Cặp dương cực đối: chỉ khác hash khoá của bên hưởng.
test fg_mint_beneficiary_other_key_ok() {
  fg_mint_ben(address.from_verification_key(t_ben_pkh), None)
}

// Cùng 28 byte của `platform` nhưng là SCRIPT ⟹ khác credential, không phải tự
// hưởng — ghim rằng cổng so CREDENTIAL chứ không so riêng hash.
test fg_mint_beneficiary_script_with_platform_bytes_ok() {
  fg_mint_ben(address.from_script(t_platform), Some(t_ben_datum()))
}

// TẤN CÔNG: hash SCRIPT của bên hưởng sai độ dài (datum có, để chỉ vế độ dài đỏ).
// Cặp dương: `fg_mint_script_beneficiary_with_datum_ok`. Trước 2026-10-05 nhánh
// Script của vế độ dài không có bài nào canh (đột biến gỡ nó: 0 bài lật).
test fg_mint_script_beneficiary_bad_hash_length() fail {
  fg_mint_ben(address.from_script(#"5c5c"), Some(t_ben_datum()))
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

fn with_certs(tx: Transaction, cs: List<Certificate>) -> Transaction {
  Transaction { ..tx, certificates: cs }
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

// Rút LƯỢNG > 0 từ Script(h) ⟹ nhận: lượng chỉ nói số dư thưởng, không nói tx là của ai.
test pp_owner_script_setdid_positive_withdrawal_ok() {
  let owner = Script(t_owner_script)
  run_setdid(
    oc_sd_din(owner), t_did,
    with_withdrawals(oc_sd_tx(owner, []), [Pair(Script(t_owner_script), 1)]),
  )
}

// Hình dạng tx THU HỒI: huỷ đăng ký Script(h) + rút 0 ⟹ từ chối. Đổi ĐÚNG một biến so với
// `pp_owner_script_setdid_withdraw_zero_ok`.
test pp_owner_script_setdid_unregister_cert_rejected() fail {
  let owner = Script(t_owner_script)
  run_setdid(
    oc_sd_din(owner), t_did,
    with_certs(
      with_withdrawals(oc_sd_tx(owner, []), [Pair(Script(t_owner_script), 0)]),
      [UnregisterCredential { credential: Script(t_owner_script), refund: Never }],
    ),
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
          consumed_unsettled: 0,
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

// Rút LƯỢNG > 0 từ Script(h) ⟹ nhận.
test pp_owner_script_draw_positive_withdrawal_ok() {
  let owner = Script(t_owner_script)
  run_draw(
    oc_draw_din(owner), draw_amt,
    with_withdrawals(oc_draw_tx(owner, []), [Pair(Script(t_owner_script), 1)]),
  )
}

// Hình dạng tx THU HỒI trên nhánh rút tiền: huỷ đăng ký Script(h) + rút 0 ⟹ từ chối.
test pp_owner_script_draw_unregister_cert_rejected() fail {
  let owner = Script(t_owner_script)
  run_draw(
    oc_draw_din(owner), draw_amt,
    with_certs(
      with_withdrawals(oc_draw_tx(owner, []), [Pair(Script(t_owner_script), 0)]),
      [UnregisterCredential { credential: Script(t_owner_script), refund: Never }],
    ),
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

// ═══════════════════════════════════════════════════════════════
// FundReclaim — thu hồi CARP tài trợ (DESIGN-reclaim §10.9) + nhánh ĐÓNG
// ═══════════════════════════════════════════════════════════════
// Mọi bài đi qua HANDLER (`paid_fund.spend` / `paid_fund.mint`), không gọi thẳng
// `fund_common_checks`: chỗ rẽ "tiếp nối hay đóng" nằm ở thân handler.
//
// Các bài này GIẢ LẬP input két Wakeme (địa chỉ + NFT + redeemer), KHÔNG chạy
// validator Wakeme ⟹ KHÔNG ghim Φ (điều kiện thời gian của `ReclaimEpoch`).
//
// Số liệu (par_scale = 1): C = credit_issued, M = magic_settled, P = provider_claimed.
//   tiếp nối: C = 10e9, M = 4e9, P = 1e9 ⟹ carp = 9e9, R = 6e9, E = 3e9
//   đóng:     C = 10e9, M = 4e9, P = 4e9 ⟹ carp = 6e9, R = 6e9, E = 0

const rc_sponsor_pkh: ByteArray =
  #"5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b"
const rc_sponsor_stake: ByteArray =
  #"5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d"
const rc_owner_commit: ByteArray =
  #"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"
const rc_other_commit: ByteArray =
  #"c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"
const rc_wk_tx: ByteArray =
  #"7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a"
const rc_e9: Int = 1_000_000_000

// Địa chỉ BASE (có stake) — hình dạng hợp lệ T2 ghim nguyên văn (§10.3).
fn rc_sponsor_addr() -> Address {
  Address {
    payment_credential: VerificationKey(rc_sponsor_pkh),
    stake_credential: Some(address.Inline(VerificationKey(rc_sponsor_stake))),
  }
}

// Cùng payment, stake người lạ (R9, nhánh đóng "min-ADA về sai địa chỉ").
fn rc_sponsor_addr_stranger_stake() -> Address {
  Address {
    payment_credential: VerificationKey(rc_sponsor_pkh),
    stake_credential: Some(address.Inline(VerificationKey(t_stranger))),
  }
}

fn rc_sp() -> Option<Sponsorship> {
  Some(
    Sponsorship {
      sponsor: rc_sponsor_addr(),
      owner_commit: rc_owner_commit,
      reclaim_after_epoch: rc_after(),
    },
  )
}

fn rc_fd(c: Int, m: Int, p: Int, reclaimed: Int) -> PaidFundDatum {
  PaidFundDatum {
    ..t_fd(c - p - reclaimed, c, m, p, 1_500),
    sponsorship: rc_sp(),
    sponsor_reclaimed: reclaimed,
  }
}

fn rc_cont_fin() -> PaidFundDatum {
  rc_fd(10 * rc_e9, 4 * rc_e9, rc_e9, 0)
}

fn rc_cont_fout() -> PaidFundDatum {
  rc_fd(10 * rc_e9, 4 * rc_e9, rc_e9, 6 * rc_e9)
}

fn rc_close_fin() -> PaidFundDatum {
  rc_fd(10 * rc_e9, 4 * rc_e9, 4 * rc_e9, 0)
}

fn rc_wk_ref() -> OutputReference {
  OutputReference { transaction_id: rc_wk_tx, output_index: 0 }
}

fn rc_wk_in_full(
  ref    : OutputReference,
  hash   : ByteArray,
  policy : ByteArray,
  name   : ByteArray,
) -> Input {
  Input {
    output_reference: ref,
    output: Output {
      address: address.from_script(hash),
      value: assets.from_lovelace(5_000_000) |> assets.add(policy, name, 1),
      datum: InlineDatum(builtin.constr_data(0, [builtin.b_data(rc_owner_commit)])),
      reference_script: None,
    },
  }
}

fn rc_wk_in() -> Input {
  rc_wk_in_full(rc_wk_ref(), t_wakeme_hash, t_wakeme_hash, rc_owner_commit)
}

// Input két ở địa chỉ két nhưng KHÔNG mang vault-NFT (datum ô [0] vẫn đúng).
fn rc_wk_in_no_nft() -> Input {
  Input {
    output_reference: rc_wk_ref(),
    output: Output { ..rc_wk_in().output, value: assets.from_lovelace(5_000_000) },
  }
}

fn rc_payer_in() -> Input {
  Input {
    output_reference: OutputReference { transaction_id: rc_wk_tx, output_index: 9 },
    output: Output {
      address: address.from_verification_key(t_stranger),
      value: assets.from_lovelace(50_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

// Output trả bên tài trợ mặc định mang inline datum = `fund_id` của quỹ đang thu
// hồi (luật chống thoả-mãn-kép ở `sponsor_payout`). Bài nào cần datum khác thì
// dùng `rc_pay_dat`.
fn rc_pay_at(addr: Address, carp: Int, lovelace: Int) -> Output {
  rc_pay_dat(addr, carp, lovelace, rc_tag(t_fund_id))
}

fn rc_tag(fund_id: ByteArray) -> Datum {
  let d: Data = fund_id
  InlineDatum(d)
}

fn rc_pay_dat(addr: Address, carp: Int, lovelace: Int, dat: Datum) -> Output {
  Output {
    address: addr,
    value: assets.from_lovelace(lovelace)
      |> assets.add(t_carp_policy, t_carp_name, carp),
    datum: dat,
    reference_script: None,
  }
}

fn rc_pay(carp: Int) -> Output {
  rc_pay_at(rc_sponsor_addr(), carp, 2_000_000)
}

// ── Vault mang dòng hạn-mức của quỹ (DESIGN-reclaim §10.11) ──────────────────
// Từ 2026-10-04 `FundReclaim` trên quỹ đã cấp (`credit_issued > 0`) BẮT BUỘC đồng
// tiêu vault mang dòng của quỹ bằng `CloseSponsoredLine { fund_id }`. Mọi giao
// dịch `rc_*` mặc định mang một vault như thế với `u = 0` (nợ quyết toán rỗng) —
// nên các bài R/D/X cũ đo đúng vế của chúng và R không đổi. Bài `rc_u_*` đặt u > 0.
fn rc_pv_din(u: Int) -> PrepaidVaultDatum {
  PrepaidVaultDatum {
    ..t_vd(
      [t_credit_u(t_fund_id, 2 * rc_e9, u)],
      [t_batch(#"b1", rc_e9, t_epoch, t_fund_id)],
    ),
    did_commit: rc_owner_commit,
  }
}

fn rc_pv_in_d(d: PrepaidVaultDatum) -> Input {
  Input { output_reference: t_own_ref(), output: t_vault_out(d) }
}

fn rc_pv_in() -> Input {
  rc_pv_in_d(rc_pv_din(0))
}

fn rc_pv_rd(fund_id: ByteArray) -> Pair<ScriptPurpose, Data> {
  let vr: Data = CloseSponsoredLine { fund_id }
  Pair(Spend(t_own_ref()), vr)
}

fn rc_rd(wk_constr: Int, fund_r: PaidFundRedeemer) -> Pairs<ScriptPurpose, Data> {
  let fr: Data = fund_r
  [
    Pair(Spend(t_fund_ref()), fr),
    Pair(Spend(rc_wk_ref()), builtin.constr_data(wk_constr, [])),
    rc_pv_rd(t_fund_id),
  ]
}

// Như `rc_tx_with` nhưng KHÔNG tự thêm vault — cho bài cần vault khác / không vault.
fn rc_tx_raw(
  ins  : List<Input>,
  outs : List<Output>,
  rds  : Pairs<ScriptPurpose, Data>,
  m    : Value,
) -> Transaction {
  let lo = t_epoch * ms_ep + 10
  Transaction {
    ..placeholder,
    inputs: ins,
    outputs: outs,
    redeemers: rds,
    mint: m,
    validity_range: interval.between(lo, lo + 10),
  }
}

fn rc_tx_with(
  ins  : List<Input>,
  outs : List<Output>,
  rds  : Pairs<ScriptPurpose, Data>,
  m    : Value,
) -> Transaction {
  rc_tx_raw(list.concat(ins, [rc_pv_in()]), outs, rds, m)
}

// Giao dịch tiếp nối chuẩn: quỹ + két Wakeme + ví trả phí (người lạ).
fn rc_cont_tx(fout: PaidFundDatum, fout_carp: Int, pay: List<Output>) -> Transaction {
  let fin = rc_cont_fin()
  rc_tx_with(
    [t_fund_in(fin, fin.carp_locked), rc_wk_in(), rc_payer_in()],
    list.concat([t_fund_out(fout, fout_carp)], pay),
    rc_rd(1, FundReclaim),
    assets.zero,
  )
}

fn rc_cont_ok_tx() -> Transaction {
  rc_cont_tx(rc_cont_fout(), 3 * rc_e9, [rc_pay(6 * rc_e9)])
}

fn rc_spend(fin: PaidFundDatum, tx: Transaction) -> Bool {
  paid_fund.spend(
    t_carp_policy, t_carp_name, ms_ep, 0, t_wakeme_hash,
    Some(fin), FundReclaim, t_fund_ref(), tx,
  )
}

fn rc_mint(tx: Transaction) -> Bool {
  paid_fund.mint(
    t_carp_policy, t_carp_name, ms_ep, 0, t_wakeme_hash,
    Void, t_fund_hash, tx,
  )
}

fn rc_burn() -> Value {
  assets.from_asset(t_fund_hash, t_fund_id, -1)
}

// Giao dịch đóng chuẩn: không output quỹ, đốt NFT, CARP + ADA của quỹ về bên tài trợ.
fn rc_close_tx_with(fin: PaidFundDatum, outs: List<Output>, m: Value) -> Transaction {
  rc_tx_with(
    [t_fund_in(fin, fin.carp_locked), rc_wk_in(), rc_payer_in()],
    outs,
    rc_rd(1, FundReclaim),
    m,
  )
}

fn rc_close_ok_tx() -> Transaction {
  rc_close_tx_with(rc_close_fin(), [rc_pay(6 * rc_e9)], rc_burn())
}

// ── Cực đối chung ─────────────────────────────────────────────

test rc_cont_ok() {
  rc_spend(rc_cont_fin(), rc_cont_ok_tx())
}

test rc_close_ok() {
  let tx = rc_close_ok_tx()
  rc_spend(rc_close_fin(), tx) && rc_mint(tx)
}

// ── R1..R16 (§10.9) ───────────────────────────────────────────

// R1: quỹ thường (`sponsorship = None`) không vào được FundReclaim.
test rc_r1_not_sponsored() fail {
  let fin = PaidFundDatum { ..rc_cont_fin(), sponsorship: None }
  let fout = PaidFundDatum { ..rc_cont_fout(), sponsorship: None }
  rc_spend(fin, rc_cont_tx(fout, 3 * rc_e9, [rc_pay(6 * rc_e9)]))
}

// R2: redeemer két Wakeme = OwnEpoch (0).
test rc_r2_wakeme_own_epoch() fail {
  rc_spend(
    rc_cont_fin(),
    Transaction { ..rc_cont_ok_tx(), redeemers: rc_rd(0, FundReclaim) },
  )
}

// R2: redeemer két Wakeme = Repin (2).
test rc_r2_wakeme_repin() fail {
  rc_spend(
    rc_cont_fin(),
    Transaction { ..rc_cont_ok_tx(), redeemers: rc_rd(2, FundReclaim) },
  )
}

// R2 (nhánh đóng): OwnEpoch.
test rc_r2_close_wakeme_own_epoch() fail {
  rc_spend(
    rc_close_fin(),
    Transaction { ..rc_close_ok_tx(), redeemers: rc_rd(0, FundReclaim) },
  )
}

// R3: input ở địa chỉ két, datum ô [0] đúng, KHÔNG mang vault-NFT.
test rc_r3_wakeme_no_nft() fail {
  let fin = rc_cont_fin()
  rc_spend(
    fin,
    Transaction {
      ..rc_cont_ok_tx(),
      inputs: [t_fund_in(fin, fin.carp_locked), rc_wk_in_no_nft(), rc_payer_in(), rc_pv_in()],
    },
  )
}

// R4: két mang NFT của owner_commit KHÁC.
test rc_r4_wakeme_other_commit() fail {
  let fin = rc_cont_fin()
  rc_spend(
    fin,
    Transaction {
      ..rc_cont_ok_tx(),
      inputs: [
        t_fund_in(fin, fin.carp_locked),
        rc_wk_in_full(rc_wk_ref(), t_wakeme_hash, t_wakeme_hash, rc_other_commit),
        rc_payer_in(),
        rc_pv_in(),
      ],
    },
  )
}

// R5: NFT tên owner_commit dưới policy kẻ tấn công, ở script khác.
test rc_r5_wakeme_forged_policy() fail {
  let fin = rc_cont_fin()
  rc_spend(
    fin,
    Transaction {
      ..rc_cont_ok_tx(),
      inputs: [
        t_fund_in(fin, fin.carp_locked),
        rc_wk_in_full(rc_wk_ref(), t_evil_hash, t_evil_hash, rc_owner_commit),
        rc_payer_in(),
        rc_pv_in(),
      ],
    },
  )
}

// R6: hai input ở Script(wakeme_vault_hash) — cái HỢP LỆ đứng TRƯỚC (list.find
// lấy cái đầu; đảo thứ tự thì bài đỏ ở vế NFT, không ghim phép đếm).
test rc_r6_two_wakeme_inputs() fail {
  let fin = rc_cont_fin()
  rc_spend(
    fin,
    Transaction {
      ..rc_cont_ok_tx(),
      inputs: [
        t_fund_in(fin, fin.carp_locked),
        rc_wk_in(),
        rc_wk_in_full(
          OutputReference { transaction_id: rc_wk_tx, output_index: 1 },
          t_wakeme_hash, t_wakeme_hash, rc_other_commit,
        ),
        rc_payer_in(),
        rc_pv_in(),
      ],
    },
  )
}

// R7: không có input két.
test rc_r7_no_wakeme_input() fail {
  let fin = rc_cont_fin()
  rc_spend(
    fin,
    Transaction {
      ..rc_cont_ok_tx(),
      inputs: [t_fund_in(fin, fin.carp_locked), rc_payer_in(), rc_pv_in()],
    },
  )
}

// R8: bên tài trợ nhận R − 1.
test rc_r8_pay_short() fail {
  rc_spend(
    rc_cont_fin(),
    rc_cont_tx(rc_cont_fout(), 3 * rc_e9, [rc_pay(6 * rc_e9 - 1)]),
  )
}

// R8: bên tài trợ nhận R + 1.
test rc_r8_pay_over() fail {
  rc_spend(
    rc_cont_fin(),
    rc_cont_tx(rc_cont_fout(), 3 * rc_e9, [rc_pay(6 * rc_e9 + 1)]),
  )
}

// R9: output tới (payment bên tài trợ, stake người lạ).
test rc_r9_stranger_stake() fail {
  rc_spend(
    rc_cont_fin(),
    rc_cont_tx(
      rc_cont_fout(), 3 * rc_e9,
      [rc_pay_at(rc_sponsor_addr_stranger_stake(), 6 * rc_e9, 2_000_000)],
    ),
  )
}

// R10: hai output tại địa chỉ bên tài trợ (cái đúng đứng TRƯỚC).
test rc_r10_two_sponsor_outputs() fail {
  rc_spend(
    rc_cont_fin(),
    rc_cont_tx(rc_cont_fout(), 3 * rc_e9, [rc_pay(6 * rc_e9), rc_pay(0)]),
  )
}

// R11: có input tại địa chỉ bên tài trợ.
test rc_r11_sponsor_input() fail {
  let fin = rc_cont_fin()
  let sponsor_in =
    Input {
      output_reference: OutputReference { transaction_id: rc_wk_tx, output_index: 8 },
      output: rc_pay_at(rc_sponsor_addr(), 0, 10_000_000),
    }
  rc_spend(
    fin,
    Transaction {
      ..rc_cont_ok_tx(),
      inputs: [t_fund_in(fin, fin.carp_locked), rc_wk_in(), sponsor_in, rc_pv_in()],
    },
  )
}

// R12: lấy cả phần provider đã kiếm (R = carp_locked) khi E > 0.
test rc_r12_take_provider_earned() fail {
  let fout = rc_fd(10 * rc_e9, 4 * rc_e9, rc_e9, 9 * rc_e9)
  rc_spend(rc_cont_fin(), rc_cont_tx(fout, 0, [rc_pay(9 * rc_e9)]))
}

// R13: sổ đầu ra sai — mỗi trường một bài.
test rc_r13_reclaimed_wrong() fail {
  let fout = PaidFundDatum { ..rc_cont_fout(), sponsor_reclaimed: 6 * rc_e9 - 1 }
  rc_spend(rc_cont_fin(), rc_cont_tx(fout, 3 * rc_e9, [rc_pay(6 * rc_e9)]))
}

test rc_r13_carp_locked_wrong() fail {
  let fout = PaidFundDatum { ..rc_cont_fout(), carp_locked: 3 * rc_e9 + 1 }
  rc_spend(rc_cont_fin(), rc_cont_tx(fout, 3 * rc_e9 + 1, [rc_pay(6 * rc_e9)]))
}

test rc_r13_credit_issued_changed() fail {
  let fout = PaidFundDatum { ..rc_cont_fout(), credit_issued: 10 * rc_e9 + 1 }
  rc_spend(rc_cont_fin(), rc_cont_tx(fout, 3 * rc_e9, [rc_pay(6 * rc_e9)]))
}

test rc_r13_magic_settled_changed() fail {
  let fout = PaidFundDatum { ..rc_cont_fout(), magic_settled: 4 * rc_e9 + 1 }
  rc_spend(rc_cont_fin(), rc_cont_tx(fout, 3 * rc_e9, [rc_pay(6 * rc_e9)]))
}

test rc_r13_provider_claimed_changed() fail {
  let fout = PaidFundDatum { ..rc_cont_fout(), provider_claimed: rc_e9 + 1 }
  rc_spend(rc_cont_fin(), rc_cont_tx(fout, 3 * rc_e9, [rc_pay(6 * rc_e9)]))
}

// R14: thu hồi lần hai. Chạy trên nhánh ĐÓNG: ở đó không có datum đầu ra, nên
// vế "chưa thu hồi" là vế DUY NHẤT phân biệt (ở nhánh tiếp nối, C-PP-3 cùng với
// `sponsor_reclaimed' == R` đã chặn trước).
// fin: C = 10e9, reclaimed = 1, M = P = 4e9 ⟹ carp = R = 6e9 − 1.
test rc_r14_second_reclaim() fail {
  let fin = rc_fd(10 * rc_e9, 4 * rc_e9, 4 * rc_e9, 1)
  let tx = rc_close_tx_with(fin, [rc_pay(6 * rc_e9 - 1)], rc_burn())
  rc_spend(fin, tx)
}

// Cực đối R14: cùng số liệu, `reclaimed = 0` (= rc_close_ok).

// R15: outstanding = 0 ⟹ R = 0. C = 4e9, M = 4e9, P = 1e9 ⟹ carp = 3e9.
test rc_r15_nothing_outstanding() fail {
  let fin = rc_fd(4 * rc_e9, 4 * rc_e9, rc_e9, 0)
  let fout = rc_fd(4 * rc_e9, 4 * rc_e9, rc_e9, 0)
  rc_spend(
    fin,
    Transaction {
      ..rc_cont_tx(fout, 3 * rc_e9, [rc_pay(0)]),
      inputs: [t_fund_in(fin, 3 * rc_e9), rc_wk_in(), rc_payer_in(), rc_pv_in()],
    },
  )
}

// Cực đối R15: outstanding = 1 ⟹ R = 1.
test rc_r15_one_outstanding_ok() {
  let fin = rc_fd(4 * rc_e9 + 1, 4 * rc_e9, rc_e9, 0)
  let fout = rc_fd(4 * rc_e9 + 1, 4 * rc_e9, rc_e9, 1)
  rc_spend(
    fin,
    Transaction {
      ..rc_cont_tx(fout, 3 * rc_e9, [rc_pay(1)]),
      inputs: [t_fund_in(fin, 3 * rc_e9 + 1), rc_wk_in(), rc_payer_in(), rc_pv_in()],
    },
  )
}

// R16: `sponsorship'` đổi `sponsor` sang ví khác.
test rc_r16_sponsor_rewritten() fail {
  let fout =
    PaidFundDatum {
      ..rc_cont_fout(),
      sponsorship: Some(
        Sponsorship {
          sponsor: address.from_verification_key(t_stranger),
          owner_commit: rc_owner_commit,
          reclaim_after_epoch: rc_after(),
        },
      ),
    }
  rc_spend(rc_cont_fin(), rc_cont_tx(fout, 3 * rc_e9, [rc_pay(6 * rc_e9)]))
}

// ── Nhánh ĐÓNG (đóng CC-RECLAIM-FUND-CLOSE) ───────────────────

// Đốt NFT quỹ mà KHÔNG tiêu quỹ.
test rc_x_burn_without_fund_spend() fail {
  let tx =
    rc_tx_with(
      [rc_wk_in(), rc_payer_in()],
      [rc_pay(0)],
      rc_rd(1, FundReclaim),
      rc_burn(),
    )
  rc_mint(tx)
}

// Đốt mà quỹ bị tiêu bằng redeemer KHÁC FundReclaim/FundClaim (FundSettle).
// (Trước 2026-10-04 bài này dùng FundClaim; nay FundClaim là redeemer đốt hợp lệ
// của nhánh rút-cuối-đóng-quỹ — xem `rc_cc_*`.)
test rc_x_burn_with_other_fund_redeemer() fail {
  let tx = Transaction { ..rc_close_ok_tx(), redeemers: rc_rd(1, FundSettle) }
  rc_mint(tx)
}

// Và FundLock.
test rc_x_burn_with_fund_lock_redeemer() fail {
  let tx = Transaction { ..rc_close_ok_tx(), redeemers: rc_rd(1, FundLock) }
  rc_mint(tx)
}

// Đóng khi E > 0: hình dạng đóng trên quỹ còn phần provider đã kiếm.
test rc_x_close_when_e_positive() fail {
  let fin = rc_cont_fin()
  let tx = rc_close_tx_with(fin, [rc_pay(9 * rc_e9)], rc_burn())
  rc_spend(fin, tx)
}

// Cực đối cho bài trên ở phía mint: handler mint một mình KHÔNG đọc E — nó giao
// phần đó cho nhánh spend (bắt buộc chạy vì quỹ bị tiêu).
test rc_x_close_when_e_positive_mint_alone_ok() {
  let fin = rc_cont_fin()
  rc_mint(rc_close_tx_with(fin, [rc_pay(9 * rc_e9)], rc_burn()))
}

// E = 0 mà giữ hình dạng TIẾP NỐI (không đốt): quỹ tiếp nối E = 0 là quỹ chết.
test rc_x_continue_when_e_zero() fail {
  let fin = rc_close_fin()
  let fout = rc_fd(10 * rc_e9, 4 * rc_e9, 4 * rc_e9, 6 * rc_e9)
  let tx =
    rc_tx_with(
      [t_fund_in(fin, fin.carp_locked), rc_wk_in(), rc_payer_in()],
      [t_fund_out(fout, 0), rc_pay(6 * rc_e9)],
      rc_rd(1, FundReclaim),
      assets.zero,
    )
  rc_spend(fin, tx)
}

// min-ADA + CARP về (payment bên tài trợ, stake người lạ).
test rc_x_close_stranger_stake() fail {
  let tx =
    rc_close_tx_with(
      rc_close_fin(),
      [rc_pay_at(rc_sponsor_addr_stranger_stake(), 6 * rc_e9, 2_000_000)],
      rc_burn(),
    )
  rc_spend(rc_close_fin(), tx)
}

// min-ADA về thiếu 1 lovelace.
test rc_x_close_ada_short() fail {
  let tx =
    rc_close_tx_with(
      rc_close_fin(),
      [rc_pay_at(rc_sponsor_addr(), 6 * rc_e9, 1_999_999)],
      rc_burn(),
    )
  rc_spend(rc_close_fin(), tx)
}

// Đốt −2 (handler mint).
test rc_x_burn_minus_two_mint() fail {
  let tx =
    rc_close_tx_with(
      rc_close_fin(),
      [rc_pay(6 * rc_e9)],
      assets.from_asset(t_fund_hash, t_fund_id, -2),
    )
  rc_mint(tx)
}

// Đốt −2 (nhánh spend).
test rc_x_burn_minus_two_spend() fail {
  let tx =
    rc_close_tx_with(
      rc_close_fin(),
      [rc_pay(6 * rc_e9)],
      assets.from_asset(t_fund_hash, t_fund_id, -2),
    )
  rc_spend(rc_close_fin(), tx)
}

// Đóng mà KHÔNG đốt (NFT đi ra một ví).
test rc_x_close_without_burn() fail {
  let nft_out =
    Output {
      address: address.from_verification_key(t_stranger),
      value: assets.from_lovelace(2_000_000) |> assets.add(t_fund_hash, t_fund_id, 1),
      datum: NoDatum,
      reference_script: None,
    }
  let tx =
    rc_close_tx_with(rc_close_fin(), [rc_pay(6 * rc_e9), nft_out], assets.zero)
  rc_spend(rc_close_fin(), tx)
}

// Đốt đúng −1 nhưng một output vẫn mang NFT quỹ (giao dịch phi lý về sổ cái,
// dựng được trong bài kiểm) — ghim vế "không output nào mang NFT quỹ".
test rc_x_close_nft_still_in_output() fail {
  let nft_out =
    Output {
      address: address.from_verification_key(t_stranger),
      value: assets.from_lovelace(2_000_000) |> assets.add(t_fund_hash, t_fund_id, 1),
      datum: NoDatum,
      reference_script: None,
    }
  let tx = rc_close_tx_with(rc_close_fin(), [rc_pay(6 * rc_e9), nft_out], rc_burn())
  rc_spend(rc_close_fin(), tx)
}

// Đóng: bên tài trợ nhận thiếu 1 CARP.
test rc_x_close_pay_short() fail {
  let tx = rc_close_tx_with(rc_close_fin(), [rc_pay(6 * rc_e9 - 1)], rc_burn())
  rc_spend(rc_close_fin(), tx)
}

// Đóng: đốt kèm tên thứ hai dưới policy quỹ (tên xếp SAU tên quỹ).
test rc_x_close_burn_extra_name() fail {
  let m =
    rc_burn()
      |> assets.add(t_fund_hash, #"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", -1)
  rc_spend(rc_close_fin(), rc_close_tx_with(rc_close_fin(), [rc_pay(6 * rc_e9)], m))
}

// ── L1..L3: FundLock / PrepaidLock ────────────────────────────

fn rc_lock_fin() -> PaidFundDatum {
  PaidFundDatum { ..t_fd(0, 0, 0, 0, 1_500), sponsorship: rc_sp() }
}

fn rc_lock_fout() -> PaidFundDatum {
  PaidFundDatum { ..t_fd(lock_amt, lock_amt, 0, 0, 1_500), sponsorship: rc_sp() }
}

// Vault đã gắn ĐÚNG DID được tài trợ (`validate_lock` ▸ vế LỖ 3, 2026-10-04).
fn rc_lock_din() -> PrepaidVaultDatum {
  PrepaidVaultDatum { ..t_vd([], []), did_commit: rc_owner_commit }
}

fn rc_lock_run(fin: PaidFundDatum, fout: PaidFundDatum, signers: List<ByteArray>) -> Bool {
  let vd = t_vd([], [])
  let tx =
    t_tx_rd(
      [t_vault_in(vd), t_fund_in(fin, fin.carp_locked)],
      [t_vault_out(vd), t_fund_out(fout, fout.carp_locked)],
      signers,
      PrepaidLock { fund_id: t_fund_id, amount_carpdrop: lock_amt },
    )
  run_fund(fin, fin.carp_locked, tx, FundLock)
}

// L1: nạp vào quỹ tài trợ thiếu chữ ký bên tài trợ.
test rc_l1_lock_no_sponsor_sig() fail {
  rc_lock_run(rc_lock_fin(), rc_lock_fout(), [t_platform])
}

test rc_l1_lock_sponsor_sig_ok() {
  rc_lock_run(rc_lock_fin(), rc_lock_fout(), [t_platform, rc_sponsor_pkh])
}

// L2: nạp sau thu hồi (có chữ ký). fin: C = 10e9, M = P = 4e9, reclaimed = 6e9.
test rc_l2_lock_after_reclaim() fail {
  let fin = rc_fd(10 * rc_e9, 4 * rc_e9, 4 * rc_e9, 6 * rc_e9)
  let fout = rc_fd(10 * rc_e9 + lock_amt, 4 * rc_e9, 4 * rc_e9, 6 * rc_e9)
  rc_lock_run(fin, fout, [t_platform, rc_sponsor_pkh])
}

// Cực đối L2: cùng hình dạng, trước thu hồi.
test rc_l2_lock_before_reclaim_ok() {
  let fin = rc_fd(10 * rc_e9, 4 * rc_e9, 4 * rc_e9, 0)
  let fout = rc_fd(10 * rc_e9 + lock_amt, 4 * rc_e9, 4 * rc_e9, 0)
  rc_lock_run(fin, fout, [t_platform, rc_sponsor_pkh])
}

// L3: phía vault — PrepaidLock đổi `sponsorship` của quỹ.
test rc_l3_vault_lock_rewrites_sponsorship() fail {
  let din = rc_lock_din()
  let fout = PaidFundDatum { ..rc_lock_fout(), sponsorship: None }
  run_lock(
    din,
    lock_tx(din, new_line_dout(din), rc_lock_fin(), 0, fout, lock_amt, [t_owner]),
  )
}

// L3: phía vault — PrepaidLock đổi `sponsor_reclaimed` của quỹ.
test rc_l3_vault_lock_rewrites_reclaimed() fail {
  let din = rc_lock_din()
  let fout = PaidFundDatum { ..rc_lock_fout(), sponsor_reclaimed: 1 }
  run_lock(
    din,
    lock_tx(din, new_line_dout(din), rc_lock_fin(), 0, fout, lock_amt, [t_owner]),
  )
}

test rc_l3_vault_lock_keeps_sponsorship_ok() {
  let din = rc_lock_din()
  run_lock(
    din,
    lock_tx(
      din, new_line_dout(din), rc_lock_fin(), 0, rc_lock_fout(), lock_amt,
      [t_owner],
    ),
  )
}

// ── S1: FundSettle ────────────────────────────────────────────
// Sau thu hồi: C = 10e9, M = 4e9, P = 4e9, reclaimed = 6e9 ⟹ credit_eff = 4e9.
test rc_s1_settle_after_reclaim() fail {
  let fin = rc_fd(10 * rc_e9, 4 * rc_e9, 4 * rc_e9, 6 * rc_e9)
  let fout = rc_fd(10 * rc_e9, 4 * rc_e9 + 1, 4 * rc_e9, 6 * rc_e9)
  let tx = settle_tx(1, 0, fin, 0, fout, 0, SettleLine { fund_id: t_fund_id })
  run_fund(fin, 0, tx, FundSettle)
}

// Cực đối: trước thu hồi, delta = 1.
test rc_s1_settle_before_reclaim_ok() {
  let fin = rc_fd(10 * rc_e9, 4 * rc_e9, 4 * rc_e9, 0)
  let fout = rc_fd(10 * rc_e9, 4 * rc_e9 + 1, 4 * rc_e9, 0)
  let tx =
    settle_tx(
      1, 0, fin, fin.carp_locked, fout, fout.carp_locked,
      SettleLine { fund_id: t_fund_id },
    )
  run_fund(fin, fin.carp_locked, tx, FundSettle)
}

// Cực đối ở biên: sau thu hồi một phần (tạo bằng tay: reclaimed = 5e9, M = 4e9,
// C = 10e9 ⟹ credit_eff = 5e9), settle tới đúng `par(M') == credit_eff`.
test rc_s1_settle_at_effective_cap_ok() {
  let fin = rc_fd(10 * rc_e9, 4 * rc_e9, 4 * rc_e9, 5 * rc_e9)
  let fout = rc_fd(10 * rc_e9, 5 * rc_e9, 4 * rc_e9, 5 * rc_e9)
  let tx =
    settle_tx(
      rc_e9, 0, fin, fin.carp_locked, fout, fout.carp_locked,
      SettleLine { fund_id: t_fund_id },
    )
  run_fund(fin, fin.carp_locked, tx, FundSettle)
}

// Và một bậc quá biên đó.
test rc_s1_settle_past_effective_cap() fail {
  let fin = rc_fd(10 * rc_e9, 4 * rc_e9, 4 * rc_e9, 5 * rc_e9)
  let fout = rc_fd(10 * rc_e9, 5 * rc_e9 + 1, 4 * rc_e9, 5 * rc_e9)
  let tx =
    settle_tx(
      rc_e9 + 1, 0, fin, fin.carp_locked, fout, fout.carp_locked,
      SettleLine { fund_id: t_fund_id },
    )
  run_fund(fin, fin.carp_locked, tx, FundSettle)
}

// ── C1: FundClaim sau thu hồi ─────────────────────────────────
// Sau thu hồi tiếp nối: C = 10e9, M = 4e9, P = 1e9, reclaimed = 6e9 ⟹ E = 3e9.
test rc_c1_claim_e_after_reclaim_ok() {
  let fin = rc_cont_fout()
  let fout = rc_fd(10 * rc_e9, 4 * rc_e9, 4 * rc_e9, 6 * rc_e9)
  run_fund(
    fin, fin.carp_locked,
    claim_tx(fin, fin.carp_locked, fout, 0, [t_platform]),
    FundClaim { amount_carpdrop: 3 * rc_e9 },
  )
}

test rc_c1_claim_e_plus_one_after_reclaim() fail {
  let fin = rc_cont_fout()
  let fout =
    PaidFundDatum {
      ..rc_fd(10 * rc_e9, 4 * rc_e9, 4 * rc_e9 + 1, 6 * rc_e9),
      carp_locked: -1,
    }
  run_fund(
    fin, fin.carp_locked,
    claim_tx(fin, fin.carp_locked, fout, -1, [t_platform]),
    FundClaim { amount_carpdrop: 3 * rc_e9 + 1 },
  )
}

// ── G1..G4: genesis ───────────────────────────────────────────

fn rc_g(sponsor: Address, commit: ByteArray) -> Bool {
  fg_mint_with(
    PaidFundDatum {
      ..fg_clean(),
      sponsorship: Some(
        Sponsorship { sponsor, owner_commit: commit, reclaim_after_epoch: rc_after() },
      ),
    },
  )
}

test rc_g_sponsored_ok() {
  rc_g(rc_sponsor_addr(), rc_owner_commit)
}

// G1: bên tài trợ là script.
test rc_g1_sponsor_script() fail {
  rc_g(address.from_script(rc_sponsor_pkh), rc_owner_commit)
}

// G2: owner_commit 31 byte / 33 byte.
test rc_g2_commit_31() fail {
  rc_g(rc_sponsor_addr(), bytearray.drop(rc_owner_commit, 1))
}

test rc_g2_commit_33() fail {
  rc_g(rc_sponsor_addr(), bytearray.push(rc_owner_commit, 0))
}

// G3: genesis sponsor_reclaimed = 1.
test rc_g3_reclaimed_nonzero() fail {
  fg_mint_with(PaidFundDatum { ..fg_clean(), sponsor_reclaimed: 1 })
}

// G4: hash khoá bên tài trợ 27 byte.
test rc_g4_sponsor_key_27() fail {
  rc_g(
    Address {
      ..rc_sponsor_addr(),
      payment_credential: VerificationKey(bytearray.drop(rc_sponsor_pkh, 1)),
    },
    rc_owner_commit,
  )
}

// ── G5: chặn tự hưởng — bên hưởng trùng KHOÁ tài trợ (chủ dự án chốt 2026-10-05) ──
fn rc_g_ben(sponsor: Address, ben: Address) -> Bool {
  fg_mint_with(
    PaidFundDatum {
      ..fg_clean(),
      beneficiary: ben,
      sponsorship: Some(
        Sponsorship {
          sponsor,
          owner_commit: rc_owner_commit,
          reclaim_after_epoch: rc_after(),
        },
      ),
    },
  )
}

// G5: bên hưởng = địa chỉ ENTERPRISE của chính khoá tài trợ. `sponsor` là địa chỉ
// BASE ⟹ phép so địa chỉ đầy đủ không bằng; chỉ phép so payment credential bắt được.
test rc_g5_beneficiary_is_sponsor_key() fail {
  rc_g_ben(rc_sponsor_addr(), address.from_verification_key(rc_sponsor_pkh))
}

// Cặp dương cực đối của G5: chỉ khác hash khoá của bên hưởng.
test rc_g5_beneficiary_other_key_ok() {
  rc_g_ben(rc_sponsor_addr(), address.from_verification_key(t_ben_pkh))
}

// Genesis `sponsorship = None` vẫn đúc được (quỹ thường không đổi hành vi).
test rc_g_none_ok() {
  fg_mint_with(fg_clean())
}

// ── K1..K2: codec ─────────────────────────────────────────────

test rc_k1_reclaim_tag_d87c() {
  let r: PaidFundRedeemer = FundReclaim
  let c: PaidFundRedeemer = FundClaim { amount_carpdrop: 1 }
  and {
    bytearray.take(cbor.serialise(r), 2) == #"d87c",
    bytearray.take(cbor.serialise(c), 2) == #"d87b",
  }
}

// K2: datum 11 trường (quỹ đời cũ) không đọc được bằng kiểu 13 trường.
fn rc_fields_take(n: Int) -> Data {
  let d: Data = rc_cont_fin()
  let Pair(_, fields) = builtin.un_constr_data(d)
  builtin.constr_data(0, list.take(fields, n))
}

test rc_k2_eleven_fields_rejected() fail {
  expect _decoded: PaidFundDatum = rc_fields_take(11)
  True
}

test rc_k2_thirteen_fields_ok() {
  expect decoded: PaidFundDatum = rc_fields_take(13)
  decoded == rc_cont_fin()
}

// Đột biến cho thấy vế `fund_out.carp_locked > 0` của `validate_fund_reclaim` KHÔNG
// với tới được qua handler (handler rẽ E = 0 sang nhánh đóng). Bài này gọi THẲNG
// `fund_common_checks` để ghim vế đó khi hàm bị gọi ngoài handler.
test rc_x_continue_when_e_zero_direct() fail {
  let fin = rc_close_fin()
  let fout = rc_fd(10 * rc_e9, 4 * rc_e9, 4 * rc_e9, 6 * rc_e9)
  let tx =
    rc_tx_with(
      [t_fund_in(fin, fin.carp_locked), rc_wk_in(), rc_payer_in()],
      [t_fund_out(fout, 0), rc_pay(6 * rc_e9)],
      rc_rd(1, FundReclaim),
      assets.zero,
    )
  run_fund(fin, fin.carp_locked, tx, FundReclaim)
}

// Cực đối: cùng đường gọi thẳng, E > 0.
test rc_cont_ok_direct() {
  run_fund(rc_cont_fin(), rc_cont_fin().carp_locked, rc_cont_ok_tx(), FundReclaim)
}

// Nhánh đóng: CARP thật trong UTxO quỹ LỆCH sổ (dư 5). Trạng thái này không tới
// được bằng quy nạp; bài ghim vế "sổ khớp value đầu vào" của nhánh đóng, nơi
// `fund_common_checks` không chạy. Phần dư đi ra ví người lạ.
test rc_x_close_input_value_mismatch() fail {
  let fin = rc_close_fin()
  let stray = rc_pay_at(address.from_verification_key(t_stranger), 5, 2_000_000)
  let tx =
    rc_tx_with(
      [t_fund_in(fin, fin.carp_locked + 5), rc_wk_in(), rc_payer_in()],
      [rc_pay(6 * rc_e9), stray],
      rc_rd(1, FundReclaim),
      rc_burn(),
    )
  rc_spend(fin, tx)
}

// ═══════════════════════════════════════════════════════════════
// FundReclaim — output trả bên tài trợ mang inline datum = `fund_id` (chống
// THOẢ-MÃN-KÉP, 2026-10-04). Mỗi ca âm có cực đối ngay dưới; cực đối chung của
// cả khối là `rc_cont_ok` / `rc_close_ok` (output trả mang đúng datum).
// ═══════════════════════════════════════════════════════════════

// D1: output trả KHÔNG có datum (nhánh tiếp nối và nhánh đóng).
test rc_d1_pay_no_datum() fail {
  rc_spend(
    rc_cont_fin(),
    rc_cont_tx(
      rc_cont_fout(), 3 * rc_e9,
      [rc_pay_dat(rc_sponsor_addr(), 6 * rc_e9, 2_000_000, NoDatum)],
    ),
  )
}

test rc_d1_close_pay_no_datum() fail {
  let tx =
    rc_close_tx_with(
      rc_close_fin(),
      [rc_pay_dat(rc_sponsor_addr(), 6 * rc_e9, 2_000_000, NoDatum)],
      rc_burn(),
    )
  rc_spend(rc_close_fin(), tx)
}

// D1': datum đúng giá trị nhưng ở dạng HASH, không inline.
test rc_d1_pay_datum_hash() fail {
  rc_spend(
    rc_cont_fin(),
    rc_cont_tx(
      rc_cont_fout(), 3 * rc_e9,
      [
        rc_pay_dat(
          rc_sponsor_addr(), 6 * rc_e9, 2_000_000,
          DatumHash(crypto.blake2b_256(cbor.serialise(t_fund_id))),
        ),
      ],
    ),
  )
}

// D2: datum là `fund_id` của quỹ KHÁC (nhánh tiếp nối và nhánh đóng).
test rc_d2_pay_other_fund_id() fail {
  rc_spend(
    rc_cont_fin(),
    rc_cont_tx(
      rc_cont_fout(), 3 * rc_e9,
      [rc_pay_dat(rc_sponsor_addr(), 6 * rc_e9, 2_000_000, rc_tag(t_other_fund))],
    ),
  )
}

test rc_d2_close_pay_other_fund_id() fail {
  let tx =
    rc_close_tx_with(
      rc_close_fin(),
      [rc_pay_dat(rc_sponsor_addr(), 6 * rc_e9, 2_000_000, rc_tag(t_other_fund))],
      rc_burn(),
    )
  rc_spend(rc_close_fin(), tx)
}

// R10 nay đếm theo CẶP (địa chỉ, datum): một output đúng datum + một output tới
// cùng ví KHÔNG mang datum đó ⟹ hợp lệ (output thứ hai không tính vào phần trả).
// Cặp âm của nó là `rc_r10_two_sponsor_outputs` (hai output cùng mang datum).
test rc_r10_untagged_extra_ok() {
  rc_spend(
    rc_cont_fin(),
    rc_cont_tx(
      rc_cont_fout(), 3 * rc_e9,
      [rc_pay(6 * rc_e9), rc_pay_dat(rc_sponsor_addr(), 0, 2_000_000, NoDatum)],
    ),
  )
}

// Cùng luật ở nhánh đóng: output thêm tới ví bên tài trợ với datum của quỹ khác
// (vd phần trả của một quỹ ở bản deploy khác) không làm hỏng phần trả của quỹ này.
test rc_r10_close_other_tagged_extra_ok() {
  let tx =
    rc_close_tx_with(
      rc_close_fin(),
      [
        rc_pay(6 * rc_e9),
        rc_pay_dat(rc_sponsor_addr(), 1, 2_000_000, rc_tag(t_other_fund)),
      ],
      rc_burn(),
    )
  rc_spend(rc_close_fin(), tx) && rc_mint(tx)
}

// D3: HAI quỹ ở HAI bản deploy `paid_fund` (hai script hash ⟹ C-PP-10 không chặn
// vì nó đếm theo địa chỉ quỹ), cùng `sponsor`, cùng `owner_commit`, cùng `R`;
// MỘT input két Wakeme (`ReclaimEpoch` ép `single_vault_input`, nên hai quỹ cùng
// DID là hình dạng DUY NHẤT dựng được — và nó dựng được, vì cả hai quỹ chỉ đòi
// "đúng một input két mang NFT của owner_commit").
//
// Bài gọi cùng handler `paid_fund.spend` với cùng tham số cho cả hai quỹ; quỹ B
// được nhận diện bằng địa chỉ của chính nó (handler suy policy NFT từ địa chỉ
// input, không từ tham số), nên đây là hình dạng của hai bản deploy khác hash.
const rc_fund_hash_b: ByteArray =
  #"4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b"

fn rc_fund_ref_b() -> OutputReference {
  OutputReference { transaction_id: t_fund_tx, output_index: 1 }
}

// Từ 2026-10-04 quỹ B (bản deploy `paid_fund` thứ hai) đi cặp với bản deploy vault
// thứ hai: `vault_hash` khác, và giao dịch mang HAI vault, mỗi vault gỡ dòng của
// đúng quỹ mình (`CloseSponsoredLine { fund_id }`). Một vault không phục vụ được
// hai quỹ — redeemer của nó mang một `fund_id` (bài `rc_u_one_vault_two_funds`).
const rc_vault_hash_b: ByteArray =
  #"1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b"

fn rc_vault_ref_b() -> OutputReference {
  OutputReference { transaction_id: t_tx_id, output_index: 1 }
}

fn rc_fd_b(fd: PaidFundDatum) -> PaidFundDatum {
  PaidFundDatum { ..fd, fund_id: t_other_fund, vault_hash: rc_vault_hash_b }
}

fn rc_pv_in_b() -> Input {
  let d =
    PrepaidVaultDatum {
      ..t_vd([t_credit_u(t_other_fund, 2 * rc_e9, 0)], []),
      did_commit: rc_owner_commit,
    }
  Input {
    output_reference: rc_vault_ref_b(),
    output: Output { ..t_vault_out(d), address: address.from_script(rc_vault_hash_b) },
  }
}

fn rc_fund_utxo_b(fd: PaidFundDatum, carp: Int) -> Output {
  Output {
    address: address.from_script(rc_fund_hash_b),
    value: assets.from_lovelace(2_000_000)
      |> assets.add(t_carp_policy, t_carp_name, carp)
      |> assets.add(rc_fund_hash_b, fd.fund_id, 1),
    datum: InlineDatum(fd),
    reference_script: None,
  }
}

fn rc_two_fund_tx(pay: List<Output>) -> Transaction {
  let fin_a = rc_cont_fin()
  let fin_b = rc_fd_b(rc_cont_fin())
  let fa: Data = FundReclaim
  rc_tx_with(
    [
      t_fund_in(fin_a, fin_a.carp_locked),
      Input {
        output_reference: rc_fund_ref_b(),
        output: rc_fund_utxo_b(fin_b, fin_b.carp_locked),
      },
      rc_wk_in(),
      rc_payer_in(),
      rc_pv_in_b(),
    ],
    list.concat(
      [
        t_fund_out(rc_cont_fout(), 3 * rc_e9),
        rc_fund_utxo_b(rc_fd_b(rc_cont_fout()), 3 * rc_e9),
      ],
      pay,
    ),
    [
      Pair(Spend(t_fund_ref()), fa),
      Pair(Spend(rc_fund_ref_b()), fa),
      Pair(Spend(rc_wk_ref()), builtin.constr_data(1, [])),
      rc_pv_rd(t_fund_id),
      {
        let vr: Data = CloseSponsoredLine { fund_id: t_other_fund }
        Pair(Spend(rc_vault_ref_b()), vr)
      },
    ],
    assets.zero,
  )
}

fn rc_spend_b(tx: Transaction) -> Bool {
  paid_fund.spend(
    t_carp_policy, t_carp_name, ms_ep, 0, t_wakeme_hash,
    Some(rc_fd_b(rc_cont_fin())), FundReclaim, rc_fund_ref_b(), tx,
  )
}

// D3 âm: một output trả (datum quỹ A) cho hai quỹ ⟹ quỹ B phải từ chối. Trước luật
// datum, bài này XANH: output đó thoả cả hai, và 6e9 CARP của quỹ B trôi đi đâu tuỳ
// người dựng giao dịch.
test rc_d3_two_funds_one_payout() fail {
  let tx = rc_two_fund_tx([rc_pay(6 * rc_e9)])
  rc_spend(rc_cont_fin(), tx) && rc_spend_b(tx)
}

// Đối chứng của bài trên: trong CHÍNH giao dịch đó, quỹ A vẫn hợp lệ ⟹ bài âm đỏ
// vì quỹ B, không vì quỹ A.
test rc_d3_two_funds_one_payout_a_alone_ok() {
  rc_spend(rc_cont_fin(), rc_two_fund_tx([rc_pay(6 * rc_e9)]))
}

// D3 cực đối: hai output trả, mỗi output đúng datum quỹ của nó ⟹ cả hai hợp lệ.
test rc_d3_two_funds_two_payouts_ok() {
  let tx =
    rc_two_fund_tx(
      [
        rc_pay(6 * rc_e9),
        rc_pay_dat(rc_sponsor_addr(), 6 * rc_e9, 2_000_000, rc_tag(t_other_fund)),
      ],
    )
  rc_spend(rc_cont_fin(), tx) && rc_spend_b(tx)
}

// ═══════════════════════════════════════════════════════════════
// DESIGN-reclaim §10.11 (2026-10-04) — đóng dòng hạn-mức cùng FundReclaim
// (`CC-RECLAIM-VAULT-LINE`), DID ở cổng nạp (LỖ 3), rút-cuối-đóng-quỹ (kẹt min-ADA).
// Mỗi ca âm có cực đối ngay cạnh: cùng giao dịch, đổi đúng một yếu tố.
// ═══════════════════════════════════════════════════════════════

// ── A, phía QUỸ: R trừ phần `u` đã tiêu mà sổ quỹ còn thiếu ──────────────────
// fin: C = 10e9, M = 4e9, P = 1e9 ⟹ carp = 9e9. Dòng ở vault nợ u = 1e9.
// R = 10e9 − (4e9 + 1e9) = 5e9; quỹ tiếp nối: M' = 5e9, carp' = 4e9 (E = 4e9).
const rc_u: Int = 1_000_000_000

fn rc_u_fout() -> PaidFundDatum {
  rc_fd(10 * rc_e9, 4 * rc_e9 + rc_u, rc_e9, 5 * rc_e9)
}

fn rc_u_tx_full(
  vault_u : Int,
  fout    : PaidFundDatum,
  pay     : Int,
  vault_rd: Pair<ScriptPurpose, Data>,
) -> Transaction {
  let fin = rc_cont_fin()
  let fr: Data = FundReclaim
  rc_tx_raw(
    [
      t_fund_in(fin, fin.carp_locked), rc_wk_in(), rc_payer_in(),
      rc_pv_in_d(rc_pv_din(vault_u)),
    ],
    [t_fund_out(fout, fout.carp_locked), rc_pay(pay)],
    [
      Pair(Spend(t_fund_ref()), fr),
      Pair(Spend(rc_wk_ref()), builtin.constr_data(1, [])),
      vault_rd,
    ],
    assets.zero,
  )
}

fn rc_u_tx(vault_u: Int, fout: PaidFundDatum, pay: Int) -> Transaction {
  rc_u_tx_full(vault_u, fout, pay, rc_pv_rd(t_fund_id))
}

test rc_u_cont_ok() {
  rc_spend(rc_cont_fin(), rc_u_tx(rc_u, rc_u_fout(), 5 * rc_e9))
}

// Công thức CŨ (R bỏ qua u): trả 6e9, sổ như trước bản vá ⟹ phần u của provider
// về bên tài trợ. Phải đỏ.
test rc_u_r_ignores_u() fail {
  rc_spend(rc_cont_fin(), rc_u_tx(rc_u, rc_cont_fout(), 6 * rc_e9))
}

// R đúng, nhưng `magic_settled` KHÔNG được cộng u (sổ khớp C-PP-3 vẫn đúng).
test rc_u_settled_not_bumped() fail {
  let fout = PaidFundDatum { ..rc_u_fout(), magic_settled: 4 * rc_e9 }
  rc_spend(rc_cont_fin(), rc_u_tx(rc_u, fout, 5 * rc_e9))
}

// u ở vault lệch ±1 so với sổ/payout dựng cho u = 1e9.
test rc_u_vault_u_plus_one() fail {
  rc_spend(rc_cont_fin(), rc_u_tx(rc_u + 1, rc_u_fout(), 5 * rc_e9))
}

test rc_u_vault_u_minus_one() fail {
  rc_spend(rc_cont_fin(), rc_u_tx(rc_u - 1, rc_u_fout(), 5 * rc_e9))
}

// Cực đối của hai bài trên: u lệch 1 VÀ sổ/payout tính theo u đó ⟹ xanh.
test rc_u_vault_u_plus_one_consistent_ok() {
  let fout = rc_fd(10 * rc_e9, 4 * rc_e9 + rc_u + 1, rc_e9, 5 * rc_e9 - 1)
  rc_spend(rc_cont_fin(), rc_u_tx(rc_u + 1, fout, 5 * rc_e9 - 1))
}

// Thiếu vault (quỹ đã cấp > 0): thu hồi bỏ qua vault là lấy phần u của provider.
test rc_u_no_vault() fail {
  let tx = rc_u_tx(rc_u, rc_u_fout(), 5 * rc_e9)
  rc_spend(
    rc_cont_fin(),
    Transaction {
      ..tx,
      inputs: [
        t_fund_in(rc_cont_fin(), rc_cont_fin().carp_locked), rc_wk_in(),
        rc_payer_in(),
      ],
    },
  )
}

// Vault tiêu bằng redeemer KHÁC (SettleLine, constr 6) cho cùng fund_id.
test rc_u_vault_wrong_redeemer() fail {
  let vr: Data = SettleLine { fund_id: t_fund_id }
  rc_spend(
    rc_cont_fin(),
    rc_u_tx_full(rc_u, rc_u_fout(), 5 * rc_e9, Pair(Spend(t_own_ref()), vr)),
  )
}

// Vault đúng redeemer nhưng `fund_id` của quỹ KHÁC.
test rc_u_vault_other_fund_id() fail {
  rc_spend(
    rc_cont_fin(),
    rc_u_tx_full(rc_u, rc_u_fout(), 5 * rc_e9, rc_pv_rd(t_other_fund)),
  )
}

// Vault không có redeemer nào trong `tx.redeemers`.
test rc_u_vault_no_redeemer() fail {
  let tx = rc_u_tx(rc_u, rc_u_fout(), 5 * rc_e9)
  let fr: Data = FundReclaim
  rc_spend(
    rc_cont_fin(),
    Transaction {
      ..tx,
      redeemers: [
        Pair(Spend(t_fund_ref()), fr),
        Pair(Spend(rc_wk_ref()), builtin.constr_data(1, [])),
      ],
    },
  )
}

// Hai input ở script vault — cái HỢP LỆ đứng trước.
test rc_u_two_vault_inputs() fail {
  let tx = rc_u_tx(rc_u, rc_u_fout(), 5 * rc_e9)
  let second =
    Input {
      output_reference: OutputReference { transaction_id: t_tx_id, output_index: 7 },
      output: t_vault_out(rc_pv_din(0)),
    }
  rc_spend(rc_cont_fin(), Transaction { ..tx, inputs: list.concat(tx.inputs, [second]) })
}

// Vault không có dòng của quỹ (u đọc ra không được). Payout tính như u = 0.
test rc_u_vault_no_line() fail {
  let fin = rc_cont_fin()
  let d = PrepaidVaultDatum { ..rc_pv_din(0), prepaid_credits: [] }
  let tx = rc_cont_ok_tx()
  rc_spend(
    fin,
    Transaction {
      ..tx,
      inputs: [
        t_fund_in(fin, fin.carp_locked), rc_wk_in(), rc_payer_in(), rc_pv_in_d(d),
      ],
    },
  )
}

// Hai dòng cùng fund_id trong datum vault (không đọc được dòng duy nhất).
test rc_u_vault_two_lines() fail {
  let fin = rc_cont_fin()
  let d =
    PrepaidVaultDatum {
      ..rc_pv_din(0),
      prepaid_credits: [t_credit(t_fund_id, 1), t_credit(t_fund_id, 2)],
    }
  let tx = rc_cont_ok_tx()
  rc_spend(
    fin,
    Transaction {
      ..tx,
      inputs: [
        t_fund_in(fin, fin.carp_locked), rc_wk_in(), rc_payer_in(), rc_pv_in_d(d),
      ],
    },
  )
}

// Một vault, hai quỹ (cùng `vault_hash`): redeemer vault mang MỘT `fund_id` ⟹ quỹ
// thứ hai phải từ chối. Cực đối: `rc_d3_two_funds_two_payouts_ok` (hai vault).
test rc_u_one_vault_two_funds() fail {
  let fin_b = PaidFundDatum { ..rc_fd_b(rc_cont_fin()), vault_hash: t_vault_hash }
  let fr: Data = FundReclaim
  let tx =
    rc_tx_with(
      [
        t_fund_in(rc_cont_fin(), rc_cont_fin().carp_locked),
        Input {
          output_reference: rc_fund_ref_b(),
          output: rc_fund_utxo_b(fin_b, fin_b.carp_locked),
        },
        rc_wk_in(), rc_payer_in(),
      ],
      [
        t_fund_out(rc_cont_fout(), 3 * rc_e9),
        rc_fund_utxo_b(
          PaidFundDatum { ..rc_fd_b(rc_cont_fout()), vault_hash: t_vault_hash },
          3 * rc_e9,
        ),
        rc_pay(6 * rc_e9),
        rc_pay_dat(rc_sponsor_addr(), 6 * rc_e9, 2_000_000, rc_tag(t_other_fund)),
      ],
      [
        Pair(Spend(t_fund_ref()), fr), Pair(Spend(rc_fund_ref_b()), fr),
        Pair(Spend(rc_wk_ref()), builtin.constr_data(1, [])), rc_pv_rd(t_fund_id),
      ],
      assets.zero,
    )
  rc_spend(rc_cont_fin(), tx) && paid_fund.spend(
    t_carp_policy, t_carp_name, ms_ep, 0, t_wakeme_hash, Some(fin_b), FundReclaim,
    rc_fund_ref_b(), tx,
  )
}

// Đối chứng của bài trên: trong CHÍNH giao dịch đó quỹ A hợp lệ ⟹ bài âm đỏ vì B.
test rc_u_one_vault_two_funds_a_alone_ok() {
  let fin_b = PaidFundDatum { ..rc_fd_b(rc_cont_fin()), vault_hash: t_vault_hash }
  let fr: Data = FundReclaim
  let tx =
    rc_tx_with(
      [
        t_fund_in(rc_cont_fin(), rc_cont_fin().carp_locked),
        Input {
          output_reference: rc_fund_ref_b(),
          output: rc_fund_utxo_b(fin_b, fin_b.carp_locked),
        },
        rc_wk_in(), rc_payer_in(),
      ],
      [t_fund_out(rc_cont_fout(), 3 * rc_e9), rc_pay(6 * rc_e9)],
      [
        Pair(Spend(t_fund_ref()), fr), Pair(Spend(rc_fund_ref_b()), fr),
        Pair(Spend(rc_wk_ref()), builtin.constr_data(1, [])), rc_pv_rd(t_fund_id),
      ],
      assets.zero,
    )
  rc_spend(rc_cont_fin(), tx)
}

// Quỹ CHƯA TỪNG cấp (`credit_issued = 0`): thu hồi KHÔNG kèm vault, R = 0, nhánh
// đóng trả min-ADA + đốt NFT. Đây là đường duy nhất cho ca "không có dòng nào".
fn rc_never_fin() -> PaidFundDatum {
  rc_fd(0, 0, 0, 0)
}

fn rc_never_tx(outs: List<Output>) -> Transaction {
  let fin = rc_never_fin()
  rc_tx_raw(
    [t_fund_in(fin, 0), rc_wk_in(), rc_payer_in()],
    outs,
    [
      {
        let fr: Data = FundReclaim
        Pair(Spend(t_fund_ref()), fr)
      },
      Pair(Spend(rc_wk_ref()), builtin.constr_data(1, [])),
    ],
    rc_burn(),
  )
}

test rc_u_never_locked_close_ok() {
  let tx = rc_never_tx([rc_pay(0)])
  rc_spend(rc_never_fin(), tx) && rc_mint(tx)
}

// Cùng ca, min-ADA về sai chỗ (thiếu 1 lovelace).
test rc_u_never_locked_ada_short() fail {
  let tx = rc_never_tx([rc_pay_at(rc_sponsor_addr(), 0, 1_999_999)])
  rc_spend(rc_never_fin(), tx)
}

// ── A, phía VAULT: `CloseSponsoredLine` ─────────────────────────────────────
// din: dòng quỹ (nợ 1e9) + dòng quỹ khác; batch b1 (quỹ, sống), b3 (quỹ, đã chết
// chưa dọn), b2 (quỹ khác). dout: chỉ còn dòng + batch của quỹ khác.
fn csl_din() -> PrepaidVaultDatum {
  PrepaidVaultDatum {
    ..t_vd(
      [t_credit_u(t_fund_id, 2 * rc_e9, rc_u), t_credit(t_other_fund, 5)],
      [
        t_batch(#"b1", rc_e9, t_epoch, t_fund_id),
        t_batch(#"b2", 3, t_epoch, t_other_fund),
        t_batch(#"b3", 7, t_epoch - 1, t_fund_id),
      ],
    ),
    did_commit: rc_owner_commit,
  }
}

fn csl_dout() -> PrepaidVaultDatum {
  PrepaidVaultDatum {
    ..csl_din(),
    prepaid_credits: [t_credit(t_other_fund, 5)],
    magic_batches: [t_batch(#"b2", 3, t_epoch, t_other_fund)],
    last_updated_epoch: t_epoch,
  }
}

fn csl_tx_with(
  din     : PrepaidVaultDatum,
  dout    : PrepaidVaultDatum,
  fin     : PaidFundDatum,
  fund_rd : PaidFundRedeemer,
) -> Transaction {
  let fr: Data = fund_rd
  let vr: Data = CloseSponsoredLine { fund_id: t_fund_id }
  rc_tx_raw(
    [t_vault_in(din), t_fund_in(fin, fin.carp_locked), rc_wk_in(), rc_payer_in()],
    [t_vault_out(dout)],
    [Pair(Spend(t_fund_ref()), fr), Pair(Spend(t_own_ref()), vr)],
    assets.zero,
  )
}

fn csl_run(din: PrepaidVaultDatum, tx: Transaction) -> Bool {
  validate_close_sponsored_line(
    din, t_fund_id, t_epoch, t_vault_addr(), t_carp_policy, t_carp_name,
    t_fund_hash, tx,
  )
}

// Qua HANDLER (cổng định danh vault + epoch từ validity range). KHÔNG chữ ký nào.
fn csl_handler(din: PrepaidVaultDatum, tx: Transaction) -> Bool {
  prepaid_vault.spend(
    t_carp_policy, t_carp_name, t_fund_hash, ms_ep, 0, Some(din),
    CloseSponsoredLine { fund_id: t_fund_id }, t_own_ref(), tx,
  )
}

fn csl_ok_tx() -> Transaction {
  csl_tx_with(csl_din(), csl_dout(), rc_cont_fin(), FundReclaim)
}

test csl_ok() {
  csl_run(csl_din(), csl_ok_tx())
}

test csl_handler_ok() {
  csl_handler(csl_din(), csl_ok_tx())
}

// Vault BỊA (không NFT định danh) ⟹ cổng chung của handler chặn.
test csl_handler_forged_vault() fail {
  let tx = csl_ok_tx()
  csl_handler(
    csl_din(),
    Transaction {
      ..tx,
      inputs: [
        t_vault_in_no_nft(csl_din()),
        t_fund_in(rc_cont_fin(), rc_cont_fin().carp_locked), rc_wk_in(),
        rc_payer_in(),
      ],
    },
  )
}

// Két thiếu quỹ: không input quỹ nào trong giao dịch.
test csl_no_fund_input() fail {
  let tx = csl_ok_tx()
  csl_run(
    csl_din(),
    Transaction { ..tx, inputs: [t_vault_in(csl_din()), rc_wk_in(), rc_payer_in()] },
  )
}

// Input quỹ THỨ HAI cùng địa chỉ + cùng NFT `fund_id` (out-ref khác).
fn csl_fund_in_2(fin: PaidFundDatum) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: t_fund_tx, output_index: 9 },
    output: t_fund_out(fin, fin.carp_locked),
  }
}

// Ghim `MUT-V-FUND` (đo đột biến 2026-10-04: KHÔNG bài nào lật khi đổi `expect [fin]`
// thành `[fin, ..]`). Vault đòi ĐÚNG MỘT input mang NFT quỹ. Cực đối: `csl_ok`.
test csl_two_fund_inputs() fail {
  let tx = csl_ok_tx()
  csl_run(
    csl_din(),
    Transaction {
      ..tx,
      inputs: list.concat(tx.inputs, [csl_fund_in_2(rc_cont_fin())]),
    },
  )
}

// Cùng hình dạng, đi QUA handler quỹ: C-PP-10 (`list.count(... == fund_addr) == 1`)
// chặn độc lập với vế của vault — nên chốt vault là lớp thứ hai, không phải lớp duy
// nhất (lớp thứ ba: NFT quỹ one-shot, hai UTxO mang nó không tồn tại trên chuỗi).
// Cực đối: `rc_u_cont_ok` (cùng giao dịch, một input quỹ).
test csl_two_fund_inputs_fund_handler() fail {
  let tx = rc_u_tx(rc_u, rc_u_fout(), 5 * rc_e9)
  rc_spend(
    rc_cont_fin(),
    Transaction {
      ..tx,
      inputs: list.concat(tx.inputs, [csl_fund_in_2(rc_cont_fin())]),
    },
  )
}

// Quỹ có mặt nhưng tiêu bằng redeemer KHÁC (FundClaim).
test csl_fund_wrong_redeemer() fail {
  csl_run(
    csl_din(),
    csl_tx_with(csl_din(), csl_dout(), rc_cont_fin(), FundClaim { amount_carpdrop: 1 }),
  )
}

// Quỹ trỏ về vault KHÁC (`vault_hash` ≠ script đang chạy).
test csl_fund_other_vault_hash() fail {
  let fin = PaidFundDatum { ..rc_cont_fin(), vault_hash: t_evil_hash }
  csl_run(csl_din(), csl_tx_with(csl_din(), csl_dout(), fin, FundReclaim))
}

// Vault không có dòng của quỹ.
test csl_no_line() fail {
  let din = PrepaidVaultDatum { ..csl_din(), prepaid_credits: [t_credit(t_other_fund, 5)] }
  csl_run(din, csl_tx_with(din, csl_dout(), rc_cont_fin(), FundReclaim))
}

// Output còn giữ dòng của quỹ.
test csl_line_kept() fail {
  let dout = PrepaidVaultDatum { ..csl_dout(), prepaid_credits: csl_din().prepaid_credits }
  csl_run(csl_din(), csl_tx_with(csl_din(), dout, rc_cont_fin(), FundReclaim))
}

// Output còn batch của quỹ (b1 — batch sống).
test csl_batch_of_fund_kept() fail {
  let dout =
    PrepaidVaultDatum {
      ..csl_dout(),
      magic_batches: [
        t_batch(#"b1", rc_e9, t_epoch, t_fund_id),
        t_batch(#"b2", 3, t_epoch, t_other_fund),
      ],
    }
  csl_run(csl_din(), csl_tx_with(csl_din(), dout, rc_cont_fin(), FundReclaim))
}

// Dòng của quỹ KHÁC bị đụng (remaining 5 → 6).
test csl_other_line_touched() fail {
  let dout = PrepaidVaultDatum { ..csl_dout(), prepaid_credits: [t_credit(t_other_fund, 6)] }
  csl_run(csl_din(), csl_tx_with(csl_din(), dout, rc_cont_fin(), FundReclaim))
}

// Batch của quỹ KHÁC bị gỡ theo.
test csl_other_batch_removed() fail {
  let dout = PrepaidVaultDatum { ..csl_dout(), magic_batches: [] }
  csl_run(csl_din(), csl_tx_with(csl_din(), dout, rc_cont_fin(), FundReclaim))
}

// DID của vault bị đổi trong cùng lượt.
test csl_did_rewritten() fail {
  let dout = PrepaidVaultDatum { ..csl_dout(), did_commit: rc_other_commit }
  csl_run(csl_din(), csl_tx_with(csl_din(), dout, rc_cont_fin(), FundReclaim))
}

// ── B: PrepaidLock vào quỹ tài trợ đòi đúng DID + một dòng ─────────────────

// Vault gắn DID KHÁC owner_commit.
test rc_b_did_other() fail {
  let din = t_vd([], [])
  run_lock(
    din,
    lock_tx(din, new_line_dout(din), rc_lock_fin(), 0, rc_lock_fout(), lock_amt, [t_owner]),
  )
}

// Vault chưa gắn DID (rỗng).
test rc_b_did_empty() fail {
  let din = PrepaidVaultDatum { ..t_vd([], []), did_commit: #"" }
  run_lock(
    din,
    lock_tx(din, new_line_dout(din), rc_lock_fin(), 0, rc_lock_fout(), lock_amt, [t_owner]),
  )
}

// Vế "khác rỗng" đứng riêng: datum quỹ tài trợ mang `owner_commit` RỖNG (genesis
// chặn được — G2 — nên trạng thái này chỉ dựng được bằng tay) và vault DID rỗng ⟹
// vế "bằng nhau" thoả, chỉ vế "khác rỗng" chặn.
test rc_b_did_empty_matches_empty_commit() fail {
  let din = PrepaidVaultDatum { ..t_vd([], []), did_commit: #"" }
  let sp =
    Some(
      Sponsorship {
        sponsor: rc_sponsor_addr(),
        owner_commit: #"",
        reclaim_after_epoch: rc_after(),
      },
    )
  let fin = PaidFundDatum { ..rc_lock_fin(), sponsorship: sp }
  let fout = PaidFundDatum { ..rc_lock_fout(), sponsorship: sp }
  run_lock(din, lock_tx(din, new_line_dout(din), fin, 0, fout, lock_amt, [t_owner]))
}

// Mở DÒNG THỨ HAI cho quỹ tài trợ đã cấp (credit_issued > 0) ở một vault khác cùng DID.
fn rc_b_fin_locked() -> PaidFundDatum {
  PaidFundDatum { ..t_fd(lock_amt, lock_amt, 0, 0, 1_500), sponsorship: rc_sp() }
}

fn rc_b_fout_locked() -> PaidFundDatum {
  PaidFundDatum {
    ..t_fd(2 * lock_amt, 2 * lock_amt, 0, 0, 1_500),
    sponsorship: rc_sp(),
  }
}

test rc_b_second_line() fail {
  let din = rc_lock_din()
  run_lock(
    din,
    lock_tx(
      din, new_line_dout(din), rc_b_fin_locked(), lock_amt, rc_b_fout_locked(),
      2 * lock_amt, [t_owner],
    ),
  )
}

// Cực đối: cùng quỹ đã cấp, NẠP THÊM vào dòng đã có ở chính vault đó ⟹ xanh.
test rc_b_top_up_existing_line_ok() {
  let din =
    PrepaidVaultDatum {
      ..rc_lock_din(),
      prepaid_credits: [t_credit(t_fund_id, lock_amt)],
    }
  let dout =
    PrepaidVaultDatum {
      ..din,
      prepaid_credits: [t_credit(t_fund_id, 2 * lock_amt)],
      last_updated_epoch: t_epoch,
    }
  run_lock(
    din,
    lock_tx(
      din, dout, rc_b_fin_locked(), lock_amt, rc_b_fout_locked(), 2 * lock_amt,
      [t_owner],
    ),
  )
}

// Quỹ THƯỜNG (`sponsorship = None`) không bị hai vế trên: vault DID khác, mở dòng
// mới trên quỹ đã cấp ⟹ xanh như trước.
test rc_b_plain_fund_unaffected_ok() {
  let din = t_vd([], [])
  let fin = t_fd(lock_amt, lock_amt, 0, 0, 1_500)
  let fout = t_fd(2 * lock_amt, 2 * lock_amt, 0, 0, 1_500)
  run_lock(
    din,
    lock_tx(din, new_line_dout(din), fin, lock_amt, fout, 2 * lock_amt, [t_owner]),
  )
}

// ── C: FundClaim rút TRỌN quỹ đã thu hồi ⟹ đóng (đốt NFT, min-ADA về bên tài trợ) ─
// fin = quỹ sau thu hồi tiếp nối: C = 10e9, M = 4e9, P = 1e9, reclaimed = 6e9 ⟹ E = 3e9.
fn cc_fin() -> PaidFundDatum {
  rc_cont_fout()
}

fn cc_tx_full(
  fin_carp : Int,
  amount   : Int,
  outs     : List<Output>,
  m        : Value,
  signers  : List<ByteArray>,
) -> Transaction {
  let fr: Data = FundClaim { amount_carpdrop: amount }
  Transaction {
    ..rc_tx_raw(
      [t_fund_in(cc_fin(), fin_carp), rc_payer_in()],
      outs,
      [Pair(Spend(t_fund_ref()), fr)],
      m,
    ),
    extra_signatories: signers,
  }
}

fn cc_ok_outs() -> List<Output> {
  [t_ben_out(cc_fin(), 3 * rc_e9), rc_pay(0)]
}

fn cc_ok_tx() -> Transaction {
  cc_tx_full(3 * rc_e9, 3 * rc_e9, cc_ok_outs(), rc_burn(), [t_platform])
}

fn cc_spend(fin: PaidFundDatum, amount: Int, tx: Transaction) -> Bool {
  paid_fund.spend(
    t_carp_policy, t_carp_name, ms_ep, 0, t_wakeme_hash,
    Some(fin), FundClaim { amount_carpdrop: amount }, t_fund_ref(), tx,
  )
}

test rc_cc_ok() {
  let tx = cc_ok_tx()
  cc_spend(cc_fin(), 3 * rc_e9, tx) && rc_mint(tx)
}

// LỖ 4: rút trọn rồi để quỹ tiếp nối `carp_locked = 0` (không đốt) ⟹ đỏ.
test rc_cc_continue_zero() fail {
  let fout = rc_fd(10 * rc_e9, 4 * rc_e9, 4 * rc_e9, 6 * rc_e9)
  let tx =
    cc_tx_full(
      3 * rc_e9, 3 * rc_e9, [t_fund_out(fout, 0), t_ben_out(cc_fin(), 3 * rc_e9)],
      assets.zero, [t_platform],
    )
  cc_spend(cc_fin(), 3 * rc_e9, tx)
}

// Cực đối LỖ 4: rút E − 1, quỹ tiếp nối còn 1 ⟹ đường thường, xanh.
test rc_cc_partial_continue_ok() {
  let fout = rc_fd(10 * rc_e9, 4 * rc_e9, 4 * rc_e9 - 1, 6 * rc_e9)
  let tx =
    cc_tx_full(
      3 * rc_e9, 3 * rc_e9 - 1,
      [t_fund_out(fout, 1), t_ben_out(cc_fin(), 3 * rc_e9 - 1)], assets.zero,
      [t_platform],
    )
  cc_spend(cc_fin(), 3 * rc_e9 - 1, tx)
}

test rc_cc_no_platform_sig() fail {
  let tx = cc_tx_full(3 * rc_e9, 3 * rc_e9, cc_ok_outs(), rc_burn(), [t_stranger])
  cc_spend(cc_fin(), 3 * rc_e9, tx)
}

test rc_cc_ben_short() fail {
  let tx =
    cc_tx_full(
      3 * rc_e9, 3 * rc_e9, [t_ben_out(cc_fin(), 3 * rc_e9 - 1), rc_pay(0)],
      rc_burn(), [t_platform],
    )
  cc_spend(cc_fin(), 3 * rc_e9, tx)
}

test rc_cc_ada_short() fail {
  let tx =
    cc_tx_full(
      3 * rc_e9, 3 * rc_e9,
      [t_ben_out(cc_fin(), 3 * rc_e9), rc_pay_at(rc_sponsor_addr(), 0, 1_999_999)],
      rc_burn(), [t_platform],
    )
  cc_spend(cc_fin(), 3 * rc_e9, tx)
}

test rc_cc_no_sponsor_output() fail {
  let tx =
    cc_tx_full(
      3 * rc_e9, 3 * rc_e9, [t_ben_out(cc_fin(), 3 * rc_e9)], rc_burn(),
      [t_platform],
    )
  cc_spend(cc_fin(), 3 * rc_e9, tx)
}

test rc_cc_nft_still_in_output() fail {
  let nft_out =
    Output {
      address: address.from_verification_key(t_stranger),
      value: assets.from_lovelace(2_000_000) |> assets.add(t_fund_hash, t_fund_id, 1),
      datum: NoDatum,
      reference_script: None,
    }
  let tx =
    cc_tx_full(
      3 * rc_e9, 3 * rc_e9, list.concat(cc_ok_outs(), [nft_out]), rc_burn(),
      [t_platform],
    )
  cc_spend(cc_fin(), 3 * rc_e9, tx)
}

test rc_cc_burn_extra_name() fail {
  let m =
    rc_burn()
      |> assets.add(t_fund_hash, #"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", -1)
  cc_spend(cc_fin(), 3 * rc_e9, cc_tx_full(3 * rc_e9, 3 * rc_e9, cc_ok_outs(), m, [t_platform]))
}

// CARP thật trong UTxO quỹ dư 5 so với sổ; phần dư đi ra ví người lạ.
test rc_cc_input_value_mismatch() fail {
  let stray = rc_pay_at(address.from_verification_key(t_stranger), 5, 2_000_000)
  let tx =
    cc_tx_full(
      3 * rc_e9 + 5, 3 * rc_e9, list.concat(cc_ok_outs(), [stray]), rc_burn(),
      [t_platform],
    )
  cc_spend(cc_fin(), 3 * rc_e9, tx)
}

// F2 (a): sổ dựng tay với M = 4e9 − 1 (C-PP-3 vẫn khớp) ⟹ P + carp = 4e9 > par(M).
test rc_cc_over_f2a() fail {
  let fin = PaidFundDatum { ..cc_fin(), magic_settled: 4 * rc_e9 - 1 }
  let fr: Data = FundClaim { amount_carpdrop: 3 * rc_e9 }
  let tx =
    Transaction {
      ..rc_tx_raw(
        [t_fund_in(fin, 3 * rc_e9), rc_payer_in()],
        cc_ok_outs(),
        [Pair(Spend(t_fund_ref()), fr)],
        rc_burn(),
      ),
      extra_signatories: [t_platform],
    }
  cc_spend(fin, 3 * rc_e9, tx)
}

// Gọi THẲNG hàm (hai vế mà phép rẽ ở handler đã lọc trước).
fn cc_direct(fin: PaidFundDatum, amount: Int, tx: Transaction) -> Bool {
  validate_fund_claim_close(
    fin, t_fund_in(fin, fin.carp_locked), t_fund_hash, amount, t_carp_policy,
    t_carp_name, tx,
  )
}

test rc_cc_direct_ok() {
  cc_direct(cc_fin(), 3 * rc_e9, cc_ok_tx())
}

test rc_cc_direct_not_reclaimed() fail {
  let fin = PaidFundDatum { ..cc_fin(), sponsor_reclaimed: 0 }
  cc_direct(fin, 3 * rc_e9, cc_ok_tx())
}

test rc_cc_direct_amount_not_all() fail {
  cc_direct(cc_fin(), 3 * rc_e9 - 1, cc_ok_tx())
}

// Ghim `MUT-C-ALL` (đo đột biến 2026-10-04: bài ngay trên KHÔNG lật khi gỡ chốt, vì
// output bên hưởng của nó vẫn mang 3e9 nên `beneficiary_paid` chặn trước). Ở đây mọi
// vế khác khớp với lượng `3e9 − 1` — bên hưởng nhận đúng lượng đó, F2 (a), value đầu
// vào, đốt NFT, min-ADA đều đúng — chỉ vế "rút TRỌN" sai. Gỡ chốt thì 1 carpdrop
// còn lại ra khỏi quỹ đã đốt NFT mà không đích nào được ép. Cực đối: `rc_cc_direct_ok`.
test rc_cc_direct_amount_not_all_consistent() fail {
  let amt = 3 * rc_e9 - 1
  cc_direct(
    cc_fin(),
    amt,
    cc_tx_full(
      3 * rc_e9, amt, [t_ben_out(cc_fin(), amt), rc_pay(0)], rc_burn(),
      [t_platform],
    ),
  )
}

// Quỹ CHƯA thu hồi rút trọn ⟹ đường thường (không đóng); đốt NFT ở đó bị
// `no_fund_mint` chặn.
test rc_cc_not_reclaimed_burn() fail {
  let fin = PaidFundDatum { ..cc_fin(), sponsor_reclaimed: 0, credit_issued: 4 * rc_e9 }
  let fr: Data = FundClaim { amount_carpdrop: 3 * rc_e9 }
  let tx =
    Transaction {
      ..rc_tx_raw(
        [t_fund_in(fin, 3 * rc_e9), rc_payer_in()],
        cc_ok_outs(),
        [Pair(Spend(t_fund_ref()), fr)],
        rc_burn(),
      ),
      extra_signatories: [t_platform],
    }
  cc_spend(fin, 3 * rc_e9, tx)
}

// ══════════════════════════════════════════════════════════════
// FundReclaim — đường DỰ PHÒNG (DESIGN-reclaim §10.12, 2026-10-05)
// ══════════════════════════════════════════════════════════════
// Bên tài trợ ký + đã tới mốc `reclaim_after_epoch` (hoặc quỹ chưa cấp đồng nào),
// KHÔNG có két Wakeme. Mọi fixture quỹ tài trợ ghim mốc `rc_after()` = t_epoch + 200,
// nên bài Wakeme cũ (ở t_epoch, không chữ ký) vẫn đi đường Wakeme.

fn rc_after() -> Int {
  t_epoch + sponsor_reclaim_delay_epochs
}

fn fb_tx(
  ins     : List<Input>,
  outs    : List<Output>,
  vault   : Bool,
  m       : Value,
  epoch   : Int,
  signers : List<ByteArray>,
) -> Transaction {
  let lo = epoch * ms_ep + 10
  let fr: Data = FundReclaim
  Transaction {
    ..placeholder,
    inputs: if vault {
      list.concat(ins, [rc_pv_in()])
    } else {
      ins
    },
    outputs: outs,
    redeemers: if vault {
      [Pair(Spend(t_fund_ref()), fr), rc_pv_rd(t_fund_id)]
    } else {
      [Pair(Spend(t_fund_ref()), fr)]
    },
    mint: m,
    validity_range: interval.between(lo, lo + 10),
    extra_signatories: signers,
  }
}

// Tiếp nối (E = 3e9 > 0), không két Wakeme.
fn fb_cont(epoch: Int, signers: List<ByteArray>, vault: Bool) -> Bool {
  let fin = rc_cont_fin()
  let fout = PaidFundDatum { ..rc_cont_fout(), last_updated_epoch: epoch }
  rc_spend(
    fin,
    fb_tx(
      [t_fund_in(fin, fin.carp_locked), rc_payer_in()],
      [t_fund_out(fout, 3 * rc_e9), rc_pay(6 * rc_e9)],
      vault, assets.zero, epoch, signers,
    ),
  )
}

// Đóng (E = 0), không két Wakeme.
fn fb_close_tx(epoch: Int, signers: List<ByteArray>, vault: Bool) -> Transaction {
  let fin = rc_close_fin()
  fb_tx(
    [t_fund_in(fin, fin.carp_locked), rc_payer_in()],
    [rc_pay(6 * rc_e9)],
    vault, rc_burn(), epoch, signers,
  )
}

fn fb_close(epoch: Int, signers: List<ByteArray>, vault: Bool) -> Bool {
  rc_spend(rc_close_fin(), fb_close_tx(epoch, signers, vault))
}

// Quỹ chưa cấp đồng nào (credit_issued = 0): đóng, trả min-ADA, không vault.
fn fb_never(epoch: Int, signers: List<ByteArray>) -> Bool {
  let fin = rc_never_fin()
  rc_spend(
    fin,
    fb_tx([t_fund_in(fin, 0), rc_payer_in()], [rc_pay(0)], False, rc_burn(), epoch, signers),
  )
}

fn fb_s_list() -> List<ByteArray> {
  [rc_sponsor_pkh]
}

// ── Tiếp nối ──
test fb_cont_after_mark_signed_ok() {
  fb_cont(rc_after() + 5, fb_s_list(), True)
}

// Đúng biên `==`: phân biệt `>=` với `>`.
test fb_cont_at_mark_ok() {
  fb_cont(rc_after(), fb_s_list(), True)
}

test fb_cont_before_mark() fail {
  fb_cont(rc_after() - 1, fb_s_list(), True)
}

test fb_cont_unsigned() fail {
  fb_cont(rc_after() + 5, [t_stranger], True)
}

// Ký bằng khoá STAKE của bên tài trợ, không phải khoá payment ⟹ hỏng.
test fb_cont_stake_key_signed() fail {
  fb_cont(rc_after() + 5, [rc_sponsor_stake], True)
}

// credit_issued > 0 mà KHÔNG đồng tiêu vault mang dòng ⟹ hỏng (phần `u` của provider).
test fb_cont_without_vault() fail {
  fb_cont(rc_after() + 5, fb_s_list(), False)
}

// ── Đóng ──
test fb_close_after_mark_signed_ok() {
  fb_close(rc_after() + 5, fb_s_list(), True)
}

test fb_close_at_mark_ok() {
  fb_close(rc_after(), fb_s_list(), True)
}

test fb_close_before_mark() fail {
  fb_close(rc_after() - 1, fb_s_list(), True)
}

test fb_close_unsigned() fail {
  fb_close(rc_after() + 5, [t_stranger], True)
}

test fb_close_without_vault() fail {
  fb_close(rc_after() + 5, fb_s_list(), False)
}

// Handler mint (đốt −1) nhận giao dịch đóng dự phòng.
test fb_close_burn_mint_ok() {
  rc_mint(fb_close_tx(rc_after(), fb_s_list(), True))
}

// ── Quỹ chưa từng cấp ──
// Ký, CHƯA tới mốc ⟹ đạt (vế `credit_issued == 0`).
test fb_never_signed_before_mark_ok() {
  fb_never(t_epoch, fb_s_list())
}

test fb_never_unsigned() fail {
  fb_never(t_epoch, [])
}

// ── Đường Wakeme cũ vẫn đạt: chưa tới mốc, KHÔNG chữ ký bên tài trợ ──
test fb_wakeme_cont_before_mark_unsigned_ok() {
  rc_spend(rc_cont_fin(), rc_cont_ok_tx())
}

test fb_wakeme_close_before_mark_unsigned_ok() {
  rc_spend(rc_close_fin(), rc_close_ok_tx())
}

// ── Bất biến: mốc ghim ở mọi nhánh tiếp nối (so trọn `sponsorship`) ──
test fb_cont_mark_rewritten() fail {
  let fout =
    PaidFundDatum {
      ..rc_cont_fout(),
      sponsorship: Some(
        Sponsorship {
          sponsor: rc_sponsor_addr(),
          owner_commit: rc_owner_commit,
          reclaim_after_epoch: t_epoch,
        },
      ),
    }
  rc_spend(rc_cont_fin(), rc_cont_tx(fout, 3 * rc_e9, [rc_pay(6 * rc_e9)]))
}

// ── Genesis: mốc ≥ epoch(cận TRÊN) + 200 ──
fn fb_g(after: Int, range: transaction.ValidityRange) -> Bool {
  let name = fg_name()
  let d =
    PaidFundDatum {
      ..fg_clean(),
      sponsorship: Some(
        Sponsorship {
          sponsor: rc_sponsor_addr(),
          owner_commit: rc_owner_commit,
          reclaim_after_epoch: after,
        },
      ),
    }
  paid_fund.mint(
    t_carp_policy, t_carp_name, ms_ep, 0, t_wakeme_hash,
    Void, t_fund_hash,
    Transaction {
      ..placeholder,
      inputs: [fg_seed_input()],
      outputs: [fg_carrier(name, d)],
      mint: assets.from_asset(t_fund_hash, name, 1),
      extra_signatories: [t_platform],
      validity_range: range,
    },
  )
}

fn fb_range() -> transaction.ValidityRange {
  interval.between(t_epoch * ms_ep + 10, t_epoch * ms_ep + 20)
}

test fb_g_plus_200_ok() {
  fb_g(t_epoch + 200, fb_range())
}

test fb_g_plus_199() fail {
  fb_g(t_epoch + 199, fb_range())
}

test fb_g_no_upper_bound() fail {
  fb_g(t_epoch + 10_000, interval.after(t_epoch * ms_ep + 10))
}

// Cận DƯỚI lùi về epoch 0, cận TRÊN ở t_epoch: mốc = 0 + 200 phải HỎNG (tính theo
// cận dưới thì đạt) — ghim "cận TRÊN, không cận dưới".
test fb_g_lower_bound_ignored() fail {
  fb_g(200, interval.between(10, t_epoch * ms_ep + 20))
}

// Quỹ THƯỜNG không đọc validity: không cận trên vẫn đạt.
test fb_g_plain_fund_no_bound_ok() {
  let name = fg_name()
  paid_fund.mint(
    t_carp_policy, t_carp_name, ms_ep, 0, t_wakeme_hash,
    Void, t_fund_hash,
    Transaction {
      ..placeholder,
      inputs: [fg_seed_input()],
      outputs: [fg_carrier(name, fg_clean())],
      mint: assets.from_asset(t_fund_hash, name, 1),
      extra_signatories: [t_platform],
    },
  )
}

// ── Gốc lưới ≠ 0 (cụm Preprod thật có `window_origin_ms` khác 0) ──
// Gốc = 3 epoch + 12.345 ms (không chia hết `ms_ep`), nên bản QUÊN trừ gốc đọc epoch
// lệch +3 so với bản đúng: ca genesis "+200 đạt" đỏ dưới đột biến đó.
const fb_origin: Int = 259_212_345

fn fbo_lo(epoch: Int) -> Int {
  fb_origin + epoch * ms_ep + 10
}

fn fbo_g(after: Int) -> Bool {
  let name = fg_name()
  let d =
    PaidFundDatum {
      ..fg_clean(),
      sponsorship: Some(
        Sponsorship {
          sponsor: rc_sponsor_addr(),
          owner_commit: rc_owner_commit,
          reclaim_after_epoch: after,
        },
      ),
    }
  paid_fund.mint(
    t_carp_policy, t_carp_name, ms_ep, fb_origin, t_wakeme_hash,
    Void, t_fund_hash,
    Transaction {
      ..placeholder,
      inputs: [fg_seed_input()],
      outputs: [fg_carrier(name, d)],
      mint: assets.from_asset(t_fund_hash, name, 1),
      extra_signatories: [t_platform],
      validity_range: interval.between(fbo_lo(t_epoch), fbo_lo(t_epoch) + 10),
    },
  )
}

// Cận trên ở epoch t_epoch THEO GỐC ⟹ mốc tối thiểu t_epoch + 200.
test fbo_g_plus_200_ok() {
  fbo_g(t_epoch + 200)
}

test fbo_g_plus_199() fail {
  fbo_g(t_epoch + 199)
}

fn fbo_spend(fin: PaidFundDatum, tx: Transaction) -> Bool {
  paid_fund.spend(
    t_carp_policy, t_carp_name, ms_ep, fb_origin, t_wakeme_hash,
    Some(fin), FundReclaim, t_fund_ref(), tx,
  )
}

fn fbo_at(tx: Transaction, epoch: Int) -> Transaction {
  Transaction {
    ..tx,
    validity_range: interval.between(fbo_lo(epoch), fbo_lo(epoch) + 10),
  }
}

// Dự phòng, tiếp nối, gốc ≠ 0 (mốc rc_after() = t_epoch + 200).
fn fbo_cont(epoch: Int) -> Bool {
  let fin = rc_cont_fin()
  let fout = PaidFundDatum { ..rc_cont_fout(), last_updated_epoch: epoch }
  fbo_spend(
    fin,
    fbo_at(
      fb_tx(
        [t_fund_in(fin, fin.carp_locked), rc_payer_in()],
        [t_fund_out(fout, 3 * rc_e9), rc_pay(6 * rc_e9)],
        True, assets.zero, epoch, fb_s_list(),
      ),
      epoch,
    ),
  )
}

test fbo_cont_at_mark_ok() {
  fbo_cont(rc_after())
}

test fbo_cont_before_mark() fail {
  fbo_cont(rc_after() - 1)
}

// Dự phòng, đóng, gốc ≠ 0.
test fbo_close_at_mark_ok() {
  fbo_spend(rc_close_fin(), fbo_at(fb_close_tx(rc_after(), fb_s_list(), True), rc_after()))
}

test fbo_close_before_mark() fail {
  let e = rc_after() - 1
  fbo_spend(rc_close_fin(), fbo_at(fb_close_tx(e, fb_s_list(), True), e))
}

// ═══ G3V (2026-10-08): mọi output ở script két/quỹ phải là một DÒNG SỔ ════════
// Nguyên tắc: giao dịch chạy script két/quỹ không được đẻ ra output ở chính
// script đó mà không nhánh nào tiêu lại được (không NFT, không datum sổ). Đếm
// theo PAYMENT CREDENTIAL, không theo địa chỉ đầy đủ — `Script(h)` kèm stake
// credential lạ là một địa chỉ KHÁC nhưng cùng chạy validator này.
// Mỗi ca âm dưới đây XANH (= giao dịch được nhận) trên mã trước bản vá
// fix/vault-output-uniqueness; ca đối chứng gọi cùng hàm dựng, chỉ bỏ output rác.

const g3v_stranger_stake: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

fn g3v_junk_at(hash: ByteArray, staked: Bool) -> Output {
  let base = address.from_script(hash)
  Output {
    address: if staked {
      address.with_delegation_key(base, g3v_stranger_stake)
    } else {
      base
    },
    value: assets.from_lovelace(5_000_000),
    datum: NoDatum,
    reference_script: None,
  }
}

fn g3v_add_out(tx: Transaction, o: Output) -> Transaction {
  Transaction { ..tx, outputs: list.concat(tx.outputs, [o]) }
}

// ── Lỗ 1: nhánh spend két đếm output theo địa chỉ đầy đủ ──────────────────────

fn g3v_setdel_tx(more_ins: List<Input>, more_outs: List<Output>) -> Transaction {
  branch_tx(
    t_vault_in(sp_setdel_din()),
    t_vault_out(sp_setdel_dout()),
    more_ins,
    more_outs,
    [t_owner],
  )
}

fn g3v_setdel(tx: Transaction) -> Bool {
  run_spend(sp_setdel_din(), SetDelegate { new_delegate: None }, tx)
}

test g3v_spend_control_ok() {
  g3v_setdel(g3v_setdel_tx([], []))
}

test g3v_spend_junk_output_staked_twin_rejected() fail {
  g3v_setdel(g3v_setdel_tx([], [g3v_junk_at(t_vault_hash, True)]))
}

test g3v_spend_junk_output_canonical_rejected() fail {
  g3v_setdel(g3v_setdel_tx([], [g3v_junk_at(t_vault_hash, False)]))
}

// Đồng dạng phía input (phòng thủ chiều sâu): input thứ hai ở cùng script, khác
// stake. Tự nó không tiêu được (không NFT), nhưng phép đếm C-PP-10 phải thấy nó.
test g3v_spend_staked_twin_input_rejected() fail {
  let twin =
    Input { output_reference: t_seed_ref(), output: g3v_junk_at(t_vault_hash, True) }
  g3v_setdel(g3v_setdel_tx([twin], []))
}

// Ghim địa chỉ đầy đủ của output tiếp nối (R169): bộ lọc theo payment credential
// ra đúng một output, nên dòng `expect o.address == vault_addr` ở
// `find_vault_output_raw` là thứ DUY NHẤT chặn két tiếp nối trôi sang stake
// credential lạ (cùng script, khác địa chỉ). Hai ca chỉ khác stake credential của
// output tiếp nối; không output nào khác ở script két.

fn g3v_setdel_cont_tx(restaked: Bool) -> Transaction {
  let out0 = t_vault_out(sp_setdel_dout())
  let out =
    if restaked {
      Output {
        ..out0,
        address: address.with_delegation_key(out0.address, g3v_stranger_stake),
      }
    } else {
      out0
    }
  branch_tx(t_vault_in(sp_setdel_din()), out, [], [], [t_owner])
}

test g3v_spend_continuation_canonical_address_ok() {
  g3v_setdel(g3v_setdel_cont_tx(False))
}

test g3v_spend_continuation_restaked_rejected() fail {
  g3v_setdel(g3v_setdel_cont_tx(True))
}

// ── Lỗ 2: genesis két/quỹ chỉ lọc output MANG NFT ─────────────────────────────

fn g3v_vault_mint(extra: List<Output>) -> Bool {
  let tx0 = mint_tx_with(t_genesis_vd())
  run_mint(t_seed_ref(), Transaction { ..tx0, outputs: list.concat(tx0.outputs, extra) })
}

test g3v_mint_control_ok() {
  g3v_vault_mint([])
}

test g3v_mint_junk_output_at_vault_rejected() fail {
  g3v_vault_mint([g3v_junk_at(t_vault_hash, False)])
}

test g3v_mint_junk_output_staked_twin_rejected() fail {
  g3v_vault_mint([g3v_junk_at(t_vault_hash, True)])
}

fn g3v_fund_mint(extra: List<Output>) -> Bool {
  let name = fg_name()
  run_fund_mint(
    list.concat([fg_carrier(name, fg_clean())], extra),
    assets.from_asset(t_fund_hash, name, 1),
  )
}

test g3v_fund_mint_control_ok() {
  g3v_fund_mint([])
}

test g3v_fund_mint_junk_output_at_fund_rejected() fail {
  g3v_fund_mint([g3v_junk_at(t_fund_hash, False)])
}

test g3v_fund_mint_junk_output_staked_twin_rejected() fail {
  g3v_fund_mint([g3v_junk_at(t_fund_hash, True)])
}

// ── Lỗ 3: nhánh spend quỹ — tiếp nối đúng 1 output ở script quỹ, đóng thì 0 ──

test g3v_fund_cont_control_ok() {
  rc_spend(rc_cont_fin(), rc_cont_ok_tx())
}

test g3v_fund_cont_junk_output_rejected() fail {
  rc_spend(rc_cont_fin(), g3v_add_out(rc_cont_ok_tx(), g3v_junk_at(t_fund_hash, False)))
}

test g3v_fund_cont_junk_output_staked_twin_rejected() fail {
  rc_spend(rc_cont_fin(), g3v_add_out(rc_cont_ok_tx(), g3v_junk_at(t_fund_hash, True)))
}

test g3v_fund_close_control_ok() {
  rc_spend(rc_close_fin(), rc_close_ok_tx())
}

test g3v_fund_close_junk_output_rejected() fail {
  rc_spend(rc_close_fin(), g3v_add_out(rc_close_ok_tx(), g3v_junk_at(t_fund_hash, True)))
}

test g3v_fund_claim_close_control_ok() {
  cc_spend(cc_fin(), 3 * rc_e9, cc_ok_tx())
}

test g3v_fund_claim_close_junk_output_rejected() fail {
  cc_spend(cc_fin(), 3 * rc_e9, g3v_add_out(cc_ok_tx(), g3v_junk_at(t_fund_hash, False)))
}
