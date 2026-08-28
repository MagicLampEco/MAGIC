// consume.ak — ENGAGEMENT-STATE validator (rewrite D1). KHÔNG token, KHÔNG tx.mint.
// PlutusV3 / Aiken. Pure BigInt.
//
// ── MÔ HÌNH (thay token-burn cũ — PR #13) ─────────────────────────────────────
// MAGIC = số kế toán trong VaultDatum.magic_batches của generator vault. Tiêu MAGIC
// = handler BurnBatch của VAULT validator giảm current_amount (nơi DUY NHẤT giảm
// MAGIC). ConsumeMAGIC KHÔNG mint, KHÔNG chạm MAGIC trực tiếp; nó là lớp PRICING +
// ENGAGEMENT/ATTRIBUTION per-app:
//   - đọc PriceParam beacon → tính required (giá có thẩm quyền).
//   - spend Engage UTxO (state per-app): tăng consumed_count, refresh last_epoch,
//     did_commit immutable, thread NFT bảo toàn, owner bảo toàn, value bảo toàn.
//   - ÉP cùng tx có 1 vault input (vault_ref) spend bằng BurnBatch với
//     Σburns == required → liên kết 2 validator, không lệch giá, không over/under-burn.
//
// ── THREAD TOKEN = MULTI-PURPOSE (vá 2026-08-09, PHƯƠNG ÁN A) ─────────────────
// `engage_nft_policy` / `engage_nft_name` KHÔNG còn là apply-param. Policy của thread
// token CHÍNH LÀ script hash của validator này (handler `mint` ở dưới), biết qua TỰ
// THAM CHIẾU: `policy_id` mà ledger truyền vào `mint` == script hash == payment
// credential của địa chỉ spend. Nhờ vậy mint-gate ép được Engage UTxO genesis nằm
// ĐÚNG địa chỉ script này với datum SẠCH, mà KHÔNG phải bake hash lẫn nhau (bake 2
// chiều = fixed-point blake2b = KHÔNG deploy được).
// Tên NFT = blake2b_256(cbor.serialise(seed)) ⇒ N thread / 1 policy, mỗi thread một
// tên duy nhất (one-shot theo seed), permissionless.
//
// Parameterized by:
//   price_nft_policy / price_nft_name   : authenticity NFT của PriceParam beacon
//   vault_script_hash                   : payment script hash của generator vault
//   burn_batch_constr                   : constr index của BurnBatch trong
//                                         VaultRedeemer của vault đó. Giá trị theo
//                                         module: Instant=2, Schedule=2; và trong
//                                         Legacy/ : Snapshot=1, Vacuum=4
//                                         (SnapshotGen/VacuumGen ĐÃ dời sang Legacy —
//                                         các constr trên vẫn ĐÚNG, ghi ở đây để tra
//                                         cứu khi deploy lại vault legacy). Per-vault
//                                         param → 1 deploy ConsumeMAGIC / 1 loại vault.
//   max_price_stale : số epoch tối đa cho phép dùng giá
//   ms_per_epoch    : POSIX ms / epoch (network-specific)
//   price_param_script_hash : payment script hash của validator price_param — beacon
//                             PriceParam PHẢI nằm ở địa chỉ này (xem read_price_param).
//                             BAKE MỘT CHIỀU: price_param KHÔNG tham chiếu ngược
//                             consume ⇒ chuỗi apply-param tuyến tính, KHÔNG vòng
//                             (price_nft → price_param → consume).
//
// DOUBLE-SATISFACTION (engage side): validator chạy 1 lần / Engage input. Các bất biến
// AGGREGATE (idempotent qua mọi invocation): #out@engage == #in@engage; Σ engage NFT
// bảo toàn; value (ngoài engage NFT) bảo toàn; Σ consumed_count(out) == Σ(in)+Σ op_count;
// Σ consumed_nanogic(out) == Σ(in) + total_required.
//
// DOUBLE-SATISFACTION XUYÊN-INSTANCE (vá 2026-08-09): các bất biến AGGREGATE gộp theo
// `own_hash`, mà `own_hash` KHÁC NHAU giữa các deploy (khác beacon giá /
// burn_batch_constr / max_price_stale — mỗi loại vault một instance)
// trong khi `vault_script_hash` có thể TRÙNG ⇒ 2 instance cùng "thấy" 1 vault burn và cùng
// PASS. Đóng bằng `util.script_inputs_confined_to`: mọi input do script khoá phải ở
// own_hash hoặc vault_script_hash ⇒ 1 tx phục vụ ĐÚNG 1 instance consume.

use aiken/builtin
use aiken/cbor
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto
use aiken/interval
use cardano/address.{Address, Script}
use cardano/assets.{AssetName, PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, ScriptPurpose, Spend, Transaction,
  placeholder,
}
use magiclamp/consume/pricing
use magiclamp/consume/types.{
  Consume, ConsumeRedeemer, EngageDatum, EngageMintRedeemer, MintEngage, OpPrice,
  PriceParam,
}
use magiclamp/consume/util

validator consume(
  price_nft_policy  : PolicyId,
  price_nft_name    : AssetName,
  vault_script_hash : ByteArray,
  burn_batch_constr : Int,
  max_price_stale   : Int,
  ms_per_epoch      : Int,
  price_param_script_hash : ByteArray,
) {
  /// Handler MINT — policy của thread token Engage (policy_id == script hash này).
  /// Đây là KHOẢNH KHẮC DUY NHẤT ép được "thread này khởi đầu SẠCH": Cardano KHÔNG
  /// chạy validator lúc TẠO UTxO, nên nếu policy không ràng địa chỉ + datum ở đây
  /// thì kẻ mint đặt Engage UTxO genesis với `consumed_nanogic` bịa (vd 1e18) và
  /// `owner` tuỳ ý — bất biến delta ở spend (Σng(out) == Σng(in) + total_required)
  /// chỉ khoá PHẦN TĂNG, KHÔNG khoá GỐC.
  mint(redeemer: EngageMintRedeemer, policy_id: PolicyId, tx: Transaction) {
    let MintEngage { seed } = redeemer
    validate_mint_engage_id(seed, policy_id, tx)
  }

  spend(
    datum_opt : Option<EngageDatum>,
    redeemer  : ConsumeRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(in_datum) = datum_opt
    // vault_ref của invocation này được dùng qua distinct_vault_refs (aggregate);
    // không cần tham chiếu trực tiếp ở đây.
    let Consume { op_type, op_count, price_ref, vault_ref: _ } = redeemer
    expect op_count >= 1

    let own_addr = util.own_address(own_ref, tx.inputs)
    let own_hash = util.own_script_hash(own_addr)

    // ── VÁ #1 (NGHIÊM TRỌNG) — DOUBLE-SATISFACTION XUYÊN-INSTANCE ──────────────
    //    Đặt SỚM (fail-fast, trước mọi tính toán giá): mọi input do SCRIPT khoá phải
    //    là own_hash hoặc vault_script_hash. Nếu không, hai instance consume ở HAI
    //    script hash khác nhau (sau PHƯƠNG ÁN A: khác nhau ở beacon giá /
    //    burn_batch_constr / max_price_stale — mỗi loại vault một deploy) cùng ăn
    //    MỘT vault burn:
    //    mỗi instance chỉ cộng total_required trên input tại CHÍNH own_hash của nó
    //    ⇒ cả hai đều thấy "10M == 10M" và PASS, vault chỉ giảm 10M cho 2 nghiệp vụ.
    //    Input ví thường (VerificationKey) KHÔNG bị ràng (người dùng vẫn trả phí/ADA).
    expect util.script_inputs_confined_to(tx.inputs, own_hash, vault_script_hash)

    // ── CỔNG ĐỊNH DANH (đặt SỚM, fail-fast) ────────────────────────────────────
    //    MỌI input tại địa chỉ engage PHẢI mang ĐÚNG 1 thread NFT dưới policy
    //    own_hash. Fail-closed: UTxO "engage giả" (ai cũng gửi được tới địa chỉ
    //    script, không validator nào chạy lúc tạo) có dict token RỖNG ⇒ pattern
    //    `[Pair(_, _)]` không khớp ⇒ chết ngay tại đây, KHÔNG kịp bơm datum bịa vào
    //    các tổng kế toán (consumed_count / consumed_nanogic).
    expect
      list.all(
        tx.inputs,
        fn(i) {
          if util.is_at_script(i.output.address, own_hash) {
            single_thread_nft(i.output.value, own_hash)
          } else {
            True
          }
        },
      )

    let current_epoch = util.get_epoch(tx, ms_per_epoch)

    // ── giá có thẩm quyền: PriceParam beacon (reference input, NFT-auth) ────────
    let pp =
      read_price_param(
        tx.reference_inputs, price_ref, price_nft_policy, price_nft_name,
        price_param_script_hash,
      )
    expect pricing.valid_param(pp)

    // ── stale price: 0 ≤ current_epoch − pp.epoch ≤ max_price_stale ─────────────
    expect current_epoch >= pp.epoch
    expect current_epoch - pp.epoch <= max_price_stale

    // ── required (invocation hiện tại) = price(op_type) × op_count ──────────────
    //    Chỉ để ép op_type CÓ trong beacon + required > 0 cho input đang spend; KHÔNG
    //    dùng làm mục tiêu khớp burn (xem AGGREGATE bên dưới — chống under-charge khi
    //    nhiều Engage co-spend chung 1 vault).
    expect Some(required) = pricing.required_for(pp, op_type, op_count)
    expect required > 0

    // ── LIÊN KẾT VAULT (AGGREGATE — C-CM-2, chống multi-engage→single-vault):
    //    total_required = Σ trên MỌI Engage input [ price(op_type_i)×op_count_i ],
    //    total_burned   = Σ burns trên MỌI vault_ref PHÂN BIỆT do các Engage input trỏ.
    //    ép total_burned == total_required. Per-invocation == aggregate → idempotent
    //    qua mọi invocation; không Engage nào "mượn" burn của Engage khác.
    //    Mọi Engage input PHẢI cùng price_ref (cùng beacon) — không trộn nhiều bảng giá.
    let total_required =
      sum_required_over_engage_inputs(tx, own_hash, pp, price_ref)
    let vault_refs = distinct_vault_refs_over_engage_inputs(tx, own_hash)
    let total_burned =
      sum_burns_over_vault_refs(tx, vault_refs, vault_script_hash, burn_batch_constr)
    expect total_burned == total_required

    // ── CỔNG QUYỀN GHI (Nợ #36) — ai được ghi vào thread này ───────────────────
    //    Trước vá, nhánh spend không hỏi ai đang tiêu: `enforce_engagement` chỉ ép
    //    `owner` BẢO TOÀN qua tx, không ép `owner` cho phép. Nên bất kỳ ai có MAGIC
    //    trong vault của CHÍNH MÌNH đều co-spend được thread Engage của người khác
    //    rồi cộng `consumed_count` / `consumed_nanogic` vào hồ sơ đó.
    //
    //    Đó không phải phiền toái: `consumed_*` là đầu vào C1 của quyền biểu quyết,
    //    mà hệ này cấm biểu quyết theo tiền. Cho phép ghi hộ tức là mở đúng đường
    //    mua phiếu bằng tiền mà thiết kế loại trừ — chỉ vòng qua một bước.
    //
    //    HAI vế, không phải một. Vế chữ ký MỘT MÌNH đóng luôn một đường đã thiết
    //    kế: ở Paymaster/Feecover người dùng CỐ Ý không ký (`Paymaster/FEAT.md:44`)
    //    — app chỉ là `personal_delegate` của vault CỦA CHÍNH người dùng, và vault
    //    cho phép BurnBatch theo `owner HOẶC personal_delegate`
    //    (`InstantGen/onchain/validators/vault.ak:900`).
    //
    //    Vế thứ hai nhận đúng đường đó mà không mở lại lỗ: MAGIC bị đốt là MAGIC
    //    của chính chủ thread, nên không có phiếu nào bị mua — người trả phí không
    //    ghi được vào hồ sơ ai khác ngoài người sở hữu số MAGIC vừa tiêu. Ai được
    //    tiêu vault đó thì do chính vault gác, không phải việc của lớp này.
    //
    //    Ràng trên MỌI vault_ref phân biệt, không phải "có một cái khớp": tx trộn
    //    một vault của chủ thread với một vault của người lạ mà thiếu chữ ký thì
    //    phần đốt ở vault người lạ vẫn chảy vào hồ sơ chủ thread.
    expect
      list.has(tx.extra_signatories, in_datum.owner) || all_vault_owners_are(
        tx.inputs,
        vault_refs,
        in_datum.owner,
      )

    // ── ENGAGE state: aggregate invariants (double-satisfaction-safe) ───────────
    // (1) #out@engage == #in@engage (no collapse).
    let n_in = util.count_inputs_at_script(tx.inputs, own_hash)
    let n_out = util.count_outputs_at_script(tx.outputs, own_hash)
    expect n_in == n_out

    // (2) Thread token bảo toàn: cổng định danh phía INPUT (đã chạy ở trên) + mỗi
    //     output@engage mang ĐÚNG 1 NFT dưới own_hash (trong enforce_engagement) +
    //     value bảo toàn TUYỆT ĐỐI (3) ⇒ tập tên NFT vào == ra, không rút, không gộp
    //     2 thread vào 1 UTxO (dict size ≠ 1 là fail). Mạnh hơn phép so TỔNG cũ.

    // (3) VALUE PRESERVATION @engage: mọi asset bảo toàn tuyệt đối giữa input@engage
    //     và output@engage (engage UTxO chỉ giữ ADA + thread NFT, KHÔNG MAGIC/LAMP).
    //     Chống drain ADA/token khỏi engage UTxO (bài học M1 Treasury).
    expect engage_value_preserved(tx, own_hash)

    // (4) Mỗi output@engage: owner giữ, last_epoch=current, did_commit immutable,
    //     đúng 1 thread NFT. Σ consumed_count(out) == Σ(in) + Σ op_count (mọi consume
    //     được ghi, không bỏ sót) VÀ Σ consumed_nanogic(out) == Σ(in) + total_required
    //     (VÁ #2 — ghi GIÁ TRỊ đã trả, không chỉ số LƯỢT).
    enforce_engagement(
      tx, own_hash, in_datum.owner, in_datum.did_commit, current_epoch,
      total_required,
    )
  }

  else(_) {
    fail
  }
}

// ═══════════════════════════════════════════════════════════════
// validate_mint_engage_id — genesis-clean thread NFT (PHƯƠNG ÁN A)
//
// Cùng KHUÔN với `validate_mint_vault_id` của 4 vault gen (commit 17f051d8):
// one-shot theo seed → asset_name = blake2b_256(cbor.serialise(seed)) → ĐÚNG 1
// output tại chính địa chỉ script này mang NFT → datum genesis SẠCH → owner ký.
// ═══════════════════════════════════════════════════════════════
fn validate_mint_engage_id(
  seed      : OutputReference,
  policy_id : PolicyId,
  tx        : Transaction,
) -> Bool {
  // ── ONE-SHOT: đúng UTxO seed phải bị TIÊU trong tx này ────────────────────
  //    1 UTxO tiêu được tối đa 1 lần ⇒ (policy, name) này đúc được tối đa 1 lần
  //    ⇒ thread NFT là singleton VĨNH VIỄN. Permissionless: ví nào cũng có seed.
  expect list.any(tx.inputs, fn(i) { i.output_reference == seed })

  // ── ĐÚNG 1 asset dưới policy này, qty +1, tên = H(seed) ───────────────────
  let own_tokens = assets.tokens(tx.mint, policy_id)
  expect dict.size(own_tokens) == 1
  let nft_name = crypto.blake2b_256(cbor.serialise(seed))
  expect assets.quantity_of(tx.mint, policy_id, nft_name) == 1

  // ── ĐÚNG 1 output tại ĐỊA CHỈ SCRIPT NÀY mang NFT ─────────────────────────
  //    policy_id == script hash của chính validator này ⇒ `Script(policy_id)` là
  //    địa chỉ spend. Neo NFT vào đó NGAY LÚC ĐÚC là thứ đóng lỗ "mint sạch →
  //    dời nhà bẩn": nếu chỉ kiểm mint mà không kiểm địa chỉ, kẻ tấn công đúc NFT
  //    về ví rồi trong CÙNG tx (hoặc tx sau) gửi NFT + datum bịa tới địa chỉ
  //    engage — không validator nào chạy lúc tạo UTxO nên không ai chặn.
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
  expect [engage_out] = carriers

  // ── Datum genesis phải INLINE + decode được EngageDatum ───────────────────
  expect InlineDatum(datum_data) = engage_out.datum
  expect ed: EngageDatum = datum_data

  // ── GENESIS SẠCH — ràng TỪNG field STATE TÍCH LUỸ ─────────────────────────
  // owner: pkh mà người đúc THẬT SỰ kiểm soát (có trong signatories) ⇒ không đúc
  // thread "nhân danh" ví nạn nhân để bơm attribution rác cho họ.
  expect list.has(tx.extra_signatories, ed.owner)
  // Hai trục kế toán PHẢI bắt đầu từ 0. `consumed_nanogic` là trục bị khai thác:
  // bất biến spend chỉ khoá DELTA nên gốc bịa 1e18 sẽ sống mãi trong state và mọi
  // app đọc "đã tiêu 1e18 nanogic" sẽ cấp dịch vụ miễn phí.
  expect ed.consumed_count == 0
  expect ed.consumed_nanogic == 0
  // last_epoch = state tích luỹ ("epoch consume gần nhất") ⇒ thread mới == 0.
  expect ed.last_epoch == 0
  // did_commit CỐ Ý KHÔNG pin nội dung: types.ak định nghĩa nó là commitment do
  // người tạo đặt MỘT LẦN lúc genesis rồi IMMUTABLE (MVP = #""), tức LỰA CHỌN của
  // người dùng chứ không phải state tích luỹ. Pin cứng về #"" sẽ khoá chết đường
  // liên kết DID sinh trắc sau này mà KHÔNG thêm chút an toàn nào (nó không gate
  // bất kỳ đường tiền nào; tính bất biến đã do spend ép).

  // ── Không nhét rác vào output genesis: nhiều nhất {ADA, thread NFT} ───────
  //    Engage UTxO bảo toàn value TUYỆT ĐỐI ở mọi spend ⇒ token lạ đúc kèm ở đây
  //    sẽ KẸT vĩnh viễn trong thread. Chặn ngay tại nguồn.
  expect list.length(assets.policies(engage_out.value)) <= 2

  True
}

/// ĐÚNG 1 thread NFT (policy == own_hash) với qty == 1 trên UTxO.
/// Fail-closed CÓ CHỦ Ý: value không có token nào của policy ⇒ `dict.to_pairs` trả
/// list rỗng ⇒ `expect [Pair(..)]` nổ ⇒ UTxO "engage giả" không tham gia được.
fn single_thread_nft(value: Value, own_hash: ByteArray) -> Bool {
  expect [Pair(_name, qty)] = assets.tokens(value, own_hash) |> dict.to_pairs
  qty == 1
}

// ── PriceParam beacon tại price_ref (reference input), mang NFT one-shot. ───────
//
// [VÁ #5 2026-08-09] Ngoài NFT, ép beacon nằm ĐÚNG địa chỉ script price_param.
// Trước vá, `quantity_of(...) == 1` là chỗ tựa DUY NHẤT của cả chuỗi tin cậy giá:
// beacon đặt ở VÍ THƯỜNG với bảng giá rẻ 1000× vẫn được chấp nhận (PoC
// poc_beacon_at_wallet_address_accepted PASS). Hiện chưa khai thác được nhờ NFT
// one-shot, nhưng dồn toàn bộ soundness vào một mệnh đề là NỢ: ai chỉ cần một lần
// làm hở tính one-shot (đổi policy, mint lại, NFT rời ra ví) là mất giá.
// Địa chỉ = phòng thủ chiều sâu ĐỘC LẬP với policy NFT.
fn read_price_param(
  ref_inputs       : List<Input>,
  price_ref        : OutputReference,
  price_nft_policy : PolicyId,
  price_nft_name   : AssetName,
  price_param_script_hash : ByteArray,
) -> PriceParam {
  expect Some(beacon) =
    list.find(ref_inputs, fn(i) { i.output_reference == price_ref })
  expect util.is_at_script(beacon.output.address, price_param_script_hash)
  expect assets.quantity_of(beacon.output.value, price_nft_policy, price_nft_name) == 1
  expect InlineDatum(d) = beacon.output.datum
  expect pp: PriceParam = d
  pp
}

/// Đọc `burns` từ redeemer BurnBatch của vault input vault_ref (purpose Spend).
/// BurnBatch { burns: List<(ByteArray, Natural)> } đồng nhất 6 module; constr index
/// khác nhau → param `burn_batch_constr`. Dùng builtin.un_constr_data để KHÔNG phải
/// import VaultRedeemer của từng module (tránh coupling type cross-module).
fn read_vault_burns(
  tx                : Transaction,
  vault_ref         : OutputReference,
  burn_batch_constr : Int,
) -> List<(ByteArray, Int)> {
  expect Some(Pair(_, rd_data)) =
    list.find(tx.redeemers, fn(p) {
      let Pair(purpose, _) = p
      purpose == Spend(vault_ref)
    })
  // rd_data = Constr(idx, fields). BurnBatch có đúng 1 field = burns.
  let Pair(idx, fields) = builtin.un_constr_data(rd_data)
  expect idx == burn_batch_constr
  expect [burns_data, ..] = fields
  expect burns: List<(ByteArray, Int)> = burns_data
  burns
}

/// Σ amount trong burns = Σ (batch_id, amount).2nd.
fn sum_burns(burns: List<(ByteArray, Int)>) -> Int {
  list.foldl(burns, 0, fn(b, acc) { acc + b.2nd })
}

/// AGGREGATE C-CM-2 (chống multi-engage→single-vault under-charge):
/// Σ required trên MỌI Engage input. Mỗi input đọc redeemer Consume RIÊNG, tính
/// price(op_type_i)×op_count_i theo CÙNG beacon pp. ÉP mọi input cùng `price_ref`
/// (cùng bảng giá) → không trộn nhiều beacon. op_type phải có trong bảng + op_count≥1.
fn sum_required_over_engage_inputs(
  tx        : Transaction,
  own_hash  : ByteArray,
  pp        : PriceParam,
  price_ref : OutputReference,
) -> Int {
  list.foldl(
    tx.inputs,
    0,
    fn(inp, acc) {
      if util.is_at_script(inp.output.address, own_hash) {
        let Consume { op_type, op_count, price_ref: pr_i, .. } =
          find_consume_redeemer(tx, inp.output_reference)
        expect op_count >= 1
        expect pr_i == price_ref
        expect Some(req_i) = pricing.required_for(pp, op_type, op_count)
        acc + req_i
      } else {
        acc
      }
    },
  )
}

/// Tập vault_ref PHÂN BIỆT do các Engage input trỏ tới (mỗi vault chỉ đếm burns 1 lần
/// dù N Engage input chia chung). Giữ thứ tự xuất hiện; loại trùng.
fn distinct_vault_refs_over_engage_inputs(
  tx       : Transaction,
  own_hash : ByteArray,
) -> List<OutputReference> {
  list.foldl(
    tx.inputs,
    [],
    fn(inp, acc) {
      if util.is_at_script(inp.output.address, own_hash) {
        let Consume { vault_ref, .. } =
          find_consume_redeemer(tx, inp.output_reference)
        if list.has(acc, vault_ref) {
          acc
        } else {
          list.push(acc, vault_ref)
        }
      } else {
        acc
      }
    },
  )
}

/// Σ burns trên các vault_ref PHÂN BIỆT. Mỗi vault: input ở vault_script_hash + redeemer
/// BurnBatch (constr == burn_batch_constr) → đọc burns, cộng. Đếm 1 lần / vault (đã dedup).
fn sum_burns_over_vault_refs(
  tx                : Transaction,
  vault_refs        : List<OutputReference>,
  vault_script_hash : ByteArray,
  burn_batch_constr : Int,
) -> Int {
  list.foldl(
    vault_refs,
    0,
    fn(vref, acc) {
      expect Some(vault_in) =
        list.find(tx.inputs, fn(i) { i.output_reference == vref })
      expect util.is_at_script(vault_in.output.address, vault_script_hash)
      let burns = read_vault_burns(tx, vref, burn_batch_constr)
      acc + sum_burns(burns)
    },
  )
}

/// Nợ #36 — MỌI vault_ref phân biệt có cùng thuộc `owner` không?
///
/// Đọc trường 0 (`owner`) của datum vault bằng `un_constr_data`, KHÔNG import
/// `VaultDatum`: consume cố ý không phụ thuộc kiểu của vault (mỗi loại vault một
/// deploy — xem `burn_batch_constr`), nên chỉ đọc đúng vị trí đã cam kết ở hợp đồng
/// nhị phân. Cùng khuôn với `read_vault_burns`.
///
/// Gọi SAU `sum_burns_over_vault_refs`: chỗ đó đã chứng minh mỗi `vref` là input
/// THẬT nằm tại `vault_script_hash`, nên ở đây không phải phòng ca datum bịa.
fn all_vault_owners_are(
  inputs     : List<Input>,
  vault_refs : List<OutputReference>,
  owner      : ByteArray,
) -> Bool {
  list.all(
    vault_refs,
    fn(vref) {
      expect Some(vault_in) =
        list.find(inputs, fn(i) { i.output_reference == vref })
      expect InlineDatum(vd) = vault_in.output.datum
      let Pair(_, fields) = builtin.un_constr_data(vd)
      expect [owner_data, ..] = fields
      expect vault_owner: ByteArray = owner_data
      vault_owner == owner
    },
  )
}

/// Tổng (merge) value mọi INPUT tại engage script.
fn sum_value_inputs(inputs: List<Input>, own_hash: ByteArray) -> Value {
  list.foldl(
    inputs,
    assets.zero,
    fn(inp, acc) {
      if util.is_at_script(inp.output.address, own_hash) {
        assets.merge(acc, inp.output.value)
      } else {
        acc
      }
    },
  )
}

/// Tổng (merge) value mọi OUTPUT tại engage script.
fn sum_value_outputs(outputs: List<Output>, own_hash: ByteArray) -> Value {
  list.foldl(
    outputs,
    assets.zero,
    fn(o, acc) {
      if util.is_at_script(o.address, own_hash) {
        assets.merge(acc, o.value)
      } else {
        acc
      }
    },
  )
}

/// Engage UTxO KHÔNG giữ MAGIC/LAMP (chỉ ADA + thread NFT) → value bảo toàn TUYỆT ĐỐI:
/// Σ value(in@engage) == Σ value(out@engage). diff = Σin − Σout phải zero hoàn toàn.
fn engage_value_preserved(tx: Transaction, own_hash: ByteArray) -> Bool {
  let v_in = sum_value_inputs(tx.inputs, own_hash)
  let v_out = sum_value_outputs(tx.outputs, own_hash)
  let diff = assets.merge(v_in, assets.negate(v_out))
  assets.is_zero(diff)
}

/// Σ op_count trên MỌI Engage input (đọc redeemer Consume Spend tương ứng). Dùng để
/// ép tổng tăng state bằng tổng nghiệp vụ — không bỏ sót input nào.
fn sum_op_count_over_engage_inputs(tx: Transaction, own_hash: ByteArray) -> Int {
  list.foldl(
    tx.inputs,
    0,
    fn(inp, acc) {
      if util.is_at_script(inp.output.address, own_hash) {
        let rd = find_consume_redeemer(tx, inp.output_reference)
        let Consume { op_count, .. } = rd
        expect op_count >= 1
        acc + op_count
      } else {
        acc
      }
    },
  )
}

/// Redeemer Consume gắn với 1 Engage input (purpose Spend ref).
fn find_consume_redeemer(tx: Transaction, ref: OutputReference) -> ConsumeRedeemer {
  expect Some(Pair(_, rd_data)) =
    list.find(tx.redeemers, fn(p) {
      let Pair(purpose, _) = p
      purpose == Spend(ref)
    })
  expect rd: ConsumeRedeemer = rd_data
  rd
}

/// Σ consumed_count trên các INPUT tại engage script (state cũ gộp).
fn sum_consumed_inputs(inputs: List<Input>, own_hash: ByteArray) -> Int {
  list.foldl(
    inputs,
    0,
    fn(inp, acc) {
      if util.is_at_script(inp.output.address, own_hash) {
        expect InlineDatum(d) = inp.output.datum
        expect ed: EngageDatum = d
        acc + ed.consumed_count
      } else {
        acc
      }
    },
  )
}

/// Σ consumed_count trên các OUTPUT tại engage script (state mới gộp).
fn sum_consumed_outputs(outputs: List<Output>, own_hash: ByteArray) -> Int {
  list.foldl(
    outputs,
    0,
    fn(o, acc) {
      if util.is_at_script(o.address, own_hash) {
        expect InlineDatum(d) = o.datum
        expect ed: EngageDatum = d
        acc + ed.consumed_count
      } else {
        acc
      }
    },
  )
}

/// Σ consumed_nanogic trên các INPUT tại engage script (giá trị đã trả, gộp).
fn sum_nanogic_inputs(inputs: List<Input>, own_hash: ByteArray) -> Int {
  list.foldl(
    inputs,
    0,
    fn(inp, acc) {
      if util.is_at_script(inp.output.address, own_hash) {
        expect InlineDatum(d) = inp.output.datum
        expect ed: EngageDatum = d
        acc + ed.consumed_nanogic
      } else {
        acc
      }
    },
  )
}

/// Σ consumed_nanogic trên các OUTPUT tại engage script.
fn sum_nanogic_outputs(outputs: List<Output>, own_hash: ByteArray) -> Int {
  list.foldl(
    outputs,
    0,
    fn(o, acc) {
      if util.is_at_script(o.address, own_hash) {
        expect InlineDatum(d) = o.datum
        expect ed: EngageDatum = d
        acc + ed.consumed_nanogic
      } else {
        acc
      }
    },
  )
}

/// Mọi output@engage: owner giữ, last_epoch=current, did_commit immutable, đúng 1 NFT.
/// HAI bất biến kế toán song song:
///   (a) Σ consumed_count(out) == Σ(in) + Σ op_count → mọi LƯỢT được ghi state.
///   (b) Σ consumed_nanogic(out) == Σ(in) + total_required → mọi GIÁ TRỊ được ghi state.
/// Chỉ (a) là KHÔNG ĐỦ: count không phân biệt op rẻ / op đắt, kẻ gọi trả giá op rẻ rồi
/// để app đọc "+1 lượt" mà cấp dịch vụ op đắt ⇒ trả thiếu nhiều lần. (b) khoá đúng con
/// số tiền đã trả vào state, app đọc delta của nó để cấp dịch vụ.
fn enforce_engagement(
  tx                : Transaction,
  own_hash          : ByteArray,
  owner             : ByteArray,
  did_commit        : ByteArray,
  current_epoch     : Int,
  total_required    : Int,
) -> Bool {
  expect
    list.all(
      tx.outputs,
      fn(o) {
        if util.is_at_script(o.address, own_hash) {
          expect InlineDatum(d) = o.datum
          expect od: EngageDatum = d
          and {
            od.owner == owner,
            od.last_epoch == current_epoch,
            od.did_commit == did_commit,
            // ĐÚNG 1 thread NFT dưới own_hash (không rút, không gộp 2 thread).
            single_thread_nft(o.value, own_hash),
          }
        } else {
          True
        }
      },
    )
  let consumed_in = sum_consumed_inputs(tx.inputs, own_hash)
  let consumed_out = sum_consumed_outputs(tx.outputs, own_hash)
  let total_op = sum_op_count_over_engage_inputs(tx, own_hash)
  expect consumed_out == consumed_in + total_op
  // (b) GIÁ TRỊ đã trả — VÁ #2.
  let nanogic_in = sum_nanogic_inputs(tx.inputs, own_hash)
  let nanogic_out = sum_nanogic_outputs(tx.outputs, own_hash)
  nanogic_out == nanogic_in + total_required
}

// ══════════════════════════════════════════════════════════════
// Validator tests (mock Transaction)
//   happy + negatives: under/over-burn (==), no thread token, double-satisfaction,
//   output-collapse, thread-token drain, state under-count, stale price, price from
//   redeemer (op không có trong beacon), fake beacon NFT, drain ADA, drain token,
//   negative base_price, did_commit mutated, wrong vault constr.
// ══════════════════════════════════════════════════════════════

const ct_eng_sh: ByteArray = #"cccc"
/// Instance THỨ HAI của consume (app khác → apply-param khác → script hash khác),
/// dùng cho test double-satisfaction xuyên-instance.
const ct_eng_sh_b: ByteArray = #"cbcb"
const ct_vault_sh: ByteArray = #"dddd"
/// Địa chỉ script price_param (nơi beacon PriceParam PHẢI nằm).
const ct_price_param_sh: ByteArray = #"feed"
const ct_price_policy: PolicyId = #"9999"
const ct_price_name: AssetName = #"5052494345"      // "PRICE"
/// Tên thread NFT trong fixture. THẬT ra tên = blake2b_256(cbor.serialise(seed)) do
/// mint-gate ép; spend KHÔNG tính lại tên (nó chỉ đòi "đúng 1 token dưới own_hash"),
/// nên fixture dùng tên đục tuỳ ý là hợp lệ. POLICY thì KHÔNG tuỳ ý: sau PHƯƠNG ÁN A
/// nó PHẢI == script hash của địa chỉ engage (tự tham chiếu).
const ct_thread_name: AssetName = #"454e47"          // "ENG"
const ct_owner: ByteArray = #"0bada55e"
const ct_did: ByteArray = #""                        // MVP did_commit rỗng
const ct_max_stale: Int = 5
const ct_mspe: Int = 86_400_000                      // Preview
const ct_burn_constr: Int = 2                        // InstantGen BurnBatch constr
const ct_price_ref_ix: Int = 9

fn ct_price_ref() -> OutputReference {
  util.mk_ref_id(#"bb", ct_price_ref_ix)
}

fn ct_pp(epoch: Int) -> PriceParam {
  PriceParam {
    op_prices: [
      OpPrice { op_type: 1, base_price: 10_000_000 },  // ảnh 0.01 MAGIC
      OpPrice { op_type: 2, base_price: 1_000_000 },    // CID 0.001 MAGIC
    ],
    demand_mult: 1_000_000_000,   // 1.0× → price ảnh = 10_000_000
    m_min: 500_000_000,
    m_max: 2_000_000_000,
    epoch: epoch,
  }
}

/// Giá 1 ảnh (op_type=1) ở demand 1.0× — delta consumed_nanogic mặc định của fixture.
const ct_img_price: Int = 10_000_000

/// Beacon reference input mang PriceParam + NFT (qty nft cho phép sai để test).
fn ct_beacon_ref(pp: PriceParam, nft_qty: Int) -> Input {
  ct_beacon_ref_at(pp, nft_qty, util.script_address(ct_price_param_sh))
}

/// Beacon ở địa chỉ TUỲ Ý (test pin địa chỉ).
fn ct_beacon_ref_at(pp: PriceParam, nft_qty: Int, addr: Address) -> Input {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_price_policy, ct_price_name, nft_qty)
  util.mk_input(ct_price_ref(), util.mk_output(addr, v, pp))
}

/// Engage input tại ct_eng_sh mang EngageDatum + thread NFT (consumed_nanogic = 0).
fn ct_engage_input(ref_ix: Int, consumed: Int) -> Input {
  ct_engage_input_at(ct_eng_sh, ref_ix, consumed)
}

/// Engage input tại script hash TUỲ Ý (test instance thứ hai).
fn ct_engage_input_at(sh: ByteArray, ref_ix: Int, consumed: Int) -> Input {
  // Thread NFT policy == script hash của chính địa chỉ đó (tự tham chiếu).
  let v = assets.add(assets.from_lovelace(2_000_000), sh, ct_thread_name, 1)
  let d = ct_datum(consumed, 0, 0, ct_did)
  util.mk_input(util.mk_ref_id(#"e1", ref_ix), util.mk_output(util.script_address(sh), v, d))
}

fn ct_datum(consumed: Int, epoch: Int, nanogic: Int, did: ByteArray) -> EngageDatum {
  EngageDatum {
    owner: ct_owner,
    consumed_count: consumed,
    last_epoch: epoch,
    did_commit: did,
    consumed_nanogic: nanogic,
  }
}

/// Continuing engage output: thread NFT + EngageDatum tăng (nanogic += 1 ảnh).
fn ct_cont_output(new_consumed: Int, new_epoch: Int, nft_qty: Int) -> Output {
  ct_cont_output_ng(new_consumed, new_epoch, nft_qty, ct_img_price)
}

/// Continuing engage output với consumed_nanogic tuỳ biến (test bất biến GIÁ TRỊ).
fn ct_cont_output_ng(new_consumed: Int, new_epoch: Int, nft_qty: Int, nanogic: Int) -> Output {
  ct_cont_output_at(ct_eng_sh, new_consumed, new_epoch, nft_qty, nanogic)
}

fn ct_cont_output_at(
  sh: ByteArray, new_consumed: Int, new_epoch: Int, nft_qty: Int, nanogic: Int,
) -> Output {
  let v = assets.add(assets.from_lovelace(2_000_000), sh, ct_thread_name, nft_qty)
  let d = ct_datum(new_consumed, new_epoch, nanogic, ct_did)
  util.mk_output(util.script_address(sh), v, d)
}

/// Continuing engage output với did_commit tuỳ biến (test immutable).
fn ct_cont_output_did(new_consumed: Int, new_epoch: Int, did: ByteArray) -> Output {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, ct_thread_name, 1)
  let d = ct_datum(new_consumed, new_epoch, ct_img_price, did)
  util.mk_output(util.script_address(ct_eng_sh), v, d)
}

/// Vault input tại ct_vault_sh (output value/datum không cần khớp VaultDatum — chỉ cần
/// địa chỉ ở vault_script_hash; redeemer BurnBatch là cái validator này đọc).
fn ct_vault_input(ref_ix: Int) -> Input {
  let v = assets.from_lovelace(2_000_000)
  util.mk_input(util.mk_ref_id(#"a1", ref_ix), util.mk_output(util.script_address(ct_vault_sh), v, 0))
}

/// Vault input mang datum ĐÚNG hình dạng: Constr(_, [owner, ..]). `ct_vault_input`
/// nhét datum Integer nên chỉ dùng được cho ca CÓ chữ ký (vế 1 ngắn mạch, vế 2 không
/// chạy). Ca sponsor/không-chữ-ký phải dùng hàm này.
fn ct_vault_input_owned(ref_ix: Int, owner: ByteArray) -> Input {
  let v = assets.from_lovelace(2_000_000)
  let owner_data: Data = owner
  let d: Data = builtin.constr_data(0, [owner_data])
  util.mk_input(
    util.mk_ref_id(#"a1", ref_ix),
    util.mk_output(util.script_address(ct_vault_sh), v, d),
  )
}

fn ct_consume_redeemer(op_type: Int, op_count: Int, vault_ref: OutputReference) -> ConsumeRedeemer {
  Consume { op_type, op_count, price_ref: ct_price_ref(), vault_ref }
}

/// BurnBatch redeemer data: Constr(constr, [burns]) với burns = list (id, amount).
fn ct_burn_redeemer(constr: Int, burns: List<(ByteArray, Int)>) -> Data {
  builtin.constr_data(constr, [burns_to_data(burns)])
}

/// Mã hoá List<(ByteArray, Int)> thành Data (Aiken tự coerce qua un_data ở read).
fn burns_to_data(burns: List<(ByteArray, Int)>) -> Data {
  let d: Data = burns
  d
}

/// Run validator: 1 Engage input + 1 vault input + beacon ref. Tham số hoá đủ để bẻ
/// từng invariant.
fn run(
  pp_for_ref    : PriceParam,
  nft_qty       : Int,
  cur_epoch     : Int,
  engage_inputs : List<Input>,
  vault_inputs  : List<Input>,
  outputs       : List<Output>,
  redeemers     : Pairs<ScriptPurpose, Data>,
  rd            : ConsumeRedeemer,
  own_ref       : OutputReference,
  in_datum      : EngageDatum,
) -> Bool {
  run_beacon(
    ct_beacon_ref(pp_for_ref, nft_qty), cur_epoch, engage_inputs, vault_inputs,
    outputs, redeemers, rd, own_ref, in_datum,
  )
}

/// Như `run` nhưng nhận thẳng beacon Input (test pin địa chỉ beacon).
/// Chữ ký mặc định = chủ thread (Nợ #36). Ca cần thiếu chữ ký dùng `run_sigs`.
fn run_beacon(
  beacon        : Input,
  cur_epoch     : Int,
  engage_inputs : List<Input>,
  vault_inputs  : List<Input>,
  outputs       : List<Output>,
  redeemers     : Pairs<ScriptPurpose, Data>,
  rd            : ConsumeRedeemer,
  own_ref       : OutputReference,
  in_datum      : EngageDatum,
) -> Bool {
  run_sigs(
    beacon, cur_epoch, engage_inputs, vault_inputs, outputs, redeemers, rd,
    own_ref, in_datum, [in_datum.owner],
  )
}

/// Bản đầy đủ: người gọi tự khai danh sách chữ ký.
fn run_sigs(
  beacon        : Input,
  cur_epoch     : Int,
  engage_inputs : List<Input>,
  vault_inputs  : List<Input>,
  outputs       : List<Output>,
  redeemers     : Pairs<ScriptPurpose, Data>,
  rd            : ConsumeRedeemer,
  own_ref       : OutputReference,
  in_datum      : EngageDatum,
  sigs          : List<ByteArray>,
) -> Bool {
  let tx =
    Transaction {
      ..placeholder,
      inputs: list.concat(engage_inputs, vault_inputs),
      reference_inputs: [beacon],
      outputs: outputs,
      redeemers: redeemers,
      extra_signatories: sigs,
      // Cửa sổ HẸP nằm TRỌN trong cur_epoch: lower tại đầu epoch, upper +1ms
      // (vẫn cùng epoch sau floor) → epoch tham chiếu (từ upper) == cur_epoch.
      // Chứng minh validator ăn cửa sổ chặt hợp lệ sau khi vá validity-range.
      validity_range: interval.between(
        cur_epoch * ct_mspe,
        cur_epoch * ct_mspe + 1,
      ),
    }
  consume.spend(
    ct_price_policy, ct_price_name,
    ct_vault_sh, ct_burn_constr, ct_max_stale, ct_mspe, ct_price_param_sh,
    Some(in_datum), rd, own_ref, tx,
  )
}

const ct_in_datum: EngageDatum =
  EngageDatum {
    owner: ct_owner,
    consumed_count: 10,
    last_epoch: 0,
    did_commit: ct_did,
    consumed_nanogic: 0,
  }

// ── HAPPY: 1 ảnh × 1 = required 10M; vault BurnBatch Σburns = 10M; state +1 ──────
test consume_happy() {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ── Nợ #36: chủ thread KHÔNG ký → REJECT ────────────────────────────────────
// Trước khi vá, ca này PASS. Nghĩa là: kẻ tấn công tiêu MAGIC từ vault của CHÍNH
// MÌNH (nên `Σburns == required` vẫn khớp) mà ghi `consumed_count` /
// `consumed_nanogic` vào thread Engage của người khác. `consumed_*` là đầu vào C1
// của quyền biểu quyết, nên đó là đường mua phiếu bằng tiền — thứ hệ này cấm.
//
// Ví lạ có ký, chỉ CHỦ THREAD là không: chứng minh cổng đòi đúng chữ ký của chủ,
// không phải "có ai đó ký".
test consume_owner_not_signer_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input_owned(0, #"deadbeef")
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run_sigs(
    ct_beacon_ref(pp, 1), 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds,
    rd, eng_ref, ct_in_datum, [#"deadbeef"],
  )
}

// Không chữ ký nào — fail-closed, không phải "danh sách rỗng thì bỏ qua".
test consume_no_signer_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input_owned(0, #"deadbeef")
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run_sigs(
    ct_beacon_ref(pp, 1), 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds,
    rd, eng_ref, ct_in_datum, [],
  )
}

// ── Đường SPONSOR (Paymaster/Feecover): chủ thread KHÔNG ký ──────────────────
// `Paymaster/FEAT.md:44` — người dùng cố ý không ký tx sponsor; app là
// `personal_delegate` của vault CỦA CHÍNH người dùng
// (`InstantGen/onchain/validators/vault.ak:900`: BurnBatch = owner HOẶC delegate).
// MAGIC bị đốt là của chủ thread ⇒ vế 2 của cổng #36 nhận, không cần chữ ký.
// Đây là test chặn chính bản vá #36 quá chặt mà chính người viết đã commit trước đó.
test consume_sponsor_no_signature_ok() {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input_owned(0, ct_owner)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run_sigs(
    ct_beacon_ref(pp, 1), 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds,
    rd, eng_ref, ct_in_datum, [],
  )
}

// 🔴 Ca TRỘN — lý do vế 2 phải ràng trên MỌI vault_ref, không phải "có một cái khớp".
// Hai Engage input của cùng chủ thread, hai vault: một của chủ, một của người lạ.
// Không chữ ký. Nếu vế 2 chỉ cần một vault khớp thì phần đốt ở vault người lạ vẫn
// chảy vào `consumed_*` của chủ thread — đúng đường mua phiếu mà cổng này chặn.
test consume_mixed_vault_owners_no_sig_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input(1, 10)
  let v0 = ct_vault_input_owned(0, ct_owner)
  let v1 = ct_vault_input_owned(1, #"deadbeef")
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vref0 = util.mk_ref_id(#"a1", 0)
  let vref1 = util.mk_ref_id(#"a1", 1)
  let rd0 = ct_consume_redeemer(1, 1, vref0)
  let rd1 = ct_consume_redeemer(1, 1, vref1)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds =
    [
      Pair(Spend(er0), rd_as_data(rd0)), Pair(Spend(er1), rd_as_data(rd1)),
      Pair(Spend(vref0), burn_rd), Pair(Spend(vref1), burn_rd),
    ]
  run_sigs(
    ct_beacon_ref(pp, 1), 6, [e0, e1],
    [v0, v1], [ct_cont_output(11, 6, 1), ct_cont_output(11, 6, 1)], reds, rd0,
    er0, ct_in_datum, [],
  )
}

/// ConsumeRedeemer → Data (cho redeemers list).
fn rd_as_data(rd: ConsumeRedeemer) -> Data {
  let d: Data = rd
  d
}

// ── NEGATIVE: Σburns < required (under-burn) → fail (== không ≥) ─────────────────
test consume_underburn_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 9_999_999)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: Σburns > required (over-burn) → fail (mô hình accounting CẤM) ───────
test consume_overburn_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_001)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ── HAPPY: burns nhiều entry, Σ = required (3 ảnh) ──────────────────────────────
test consume_multi_burn_happy() {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 3, vault_ref)    // required = 30M
  let burn_rd =
    ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000), (#"ba02", 12_000_000), (#"ba03", 8_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  // 3 ảnh → consumed_count +3, consumed_nanogic +30M.
  run(pp, 1, 6, [eng], [vault], [ct_cont_output_ng(13, 6, 1, 30_000_000)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: continuing engage output thiếu thread token → fail ────────────────
test consume_no_thread_token_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output(11, 6, 0)], reds, rd, eng_ref, ct_in_datum)   // nft=0
}

// ── NEGATIVE: stale price → fail ────────────────────────────────────────────────
test consume_stale_price_fail() fail {
  let pp = ct_pp(1)          // beacon epoch 1
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 10, [eng], [vault], [ct_cont_output(11, 10, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: op_type ngoài bảng giá beacon → required_for None → fail ──────────
test consume_price_from_redeemer_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(42, 1, vault_ref)   // op_type 42 không có
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: beacon NFT qty ≠ 1 (datum hijack) → fail ──────────────────────────
test consume_fake_beacon_no_nft_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 0, 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)   // nft=0
}

// ── NEGATIVE: base_price âm trong beacon → valid_param fail → fail ──────────────
test consume_negative_base_price_fail() fail {
  let bad_pp =
    PriceParam {
      op_prices: [OpPrice { op_type: 1, base_price: 10_000_000 }, OpPrice { op_type: 2, base_price: -1 }],
      demand_mult: 1_000_000_000, m_min: 500_000_000, m_max: 2_000_000_000, epoch: 6,
    }
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(bad_pp, 1, 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: did_commit bị đổi ở output → immutable vi phạm → fail ─────────────
test consume_did_commit_mutated_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output_did(11, 6, #"deadbeef")], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: vault input redeemer constr ≠ burn_batch_constr → fail ────────────
test consume_wrong_vault_constr_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(3, [(#"ba01", 10_000_000)])   // constr 3 ≠ 2
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: vault_ref trỏ vào UTxO KHÔNG ở vault_script_hash → fail ───────────
//    Dùng địa chỉ VÍ THƯỜNG để KHÔNG bị ràng buộc "script-input confined" (VÁ #1)
//    chặn trước — như vậy test cô lập ĐÚNG check `is_at_script(vault_in, vault_sh)`.
test consume_vault_not_at_script_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  // vault_ref trỏ vào một UTxO ví thường, không phải vault script
  let fake_vault =
    util.mk_input(util.mk_ref_id(#"a1", 0), util.mk_output(util.vk_address(#"beef"), assets.from_lovelace(2_000_000), 0))
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [fake_vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE (FIX aggregate C-CM-2): 2 Engage / 2 ops CHUNG 1 vault burn 10M → fail.
//    Đây là LỖ under-charge cũ (pay-once-consume-N): total_required = 10M+10M = 20M,
//    total_burned = 10M (1 vault) → 10M != 20M → REJECT. Trước fix test này "happy".
test consume_two_engage_share_vault_undercharge_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)   // cả 2 engage trỏ chung vault_ref
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])  // CHỈ 10M
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [e0, e1], [vault], [ct_cont_output(11, 6, 1), ct_cont_output(11, 6, 1)], reds, rd, er0, ct_in_datum)
}

// ── HAPPY 2-input ĐÚNG GIÁ: 2 Engage / 2 ops, vault burn ĐỦ tổng 20M, 2 output, Σstate +2.
//    Chứng minh batching hợp lệ vẫn chạy sau fix: total_required=20M == total_burned=20M.
test consume_two_engage_full_burn_happy() {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])  // ĐỦ 2 ảnh
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  // Σconsumed: in 20, out 22 = 20 + Σop(2) → khớp; Σburns 20M == total_required 20M.
  run(pp, 1, 6, [e0, e1], [vault], [ct_cont_output(11, 6, 1), ct_cont_output(11, 6, 1)], reds, rd, er0, ct_in_datum)
}

// ── HAPPY 2-input, 2 vault PHÂN BIỆT (mỗi engage 1 vault riêng, mỗi vault burn 10M).
//    total_required=20M, total_burned = 10M+10M (2 vault_ref distinct) = 20M → pass.
test consume_two_engage_two_vault_happy() {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input(1, 10)
  let v0 = ct_vault_input(0)
  let v1 = ct_vault_input(1)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vref0 = util.mk_ref_id(#"a1", 0)
  let vref1 = util.mk_ref_id(#"a1", 1)
  let rd0 = ct_consume_redeemer(1, 1, vref0)
  let rd1 = ct_consume_redeemer(1, 1, vref1)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds =
    [
      Pair(Spend(er0), rd_as_data(rd0)), Pair(Spend(er1), rd_as_data(rd1)),
      Pair(Spend(vref0), burn_rd), Pair(Spend(vref1), burn_rd),
    ]
  run(pp, 1, 6, [e0, e1], [v0, v1], [ct_cont_output(11, 6, 1), ct_cont_output(11, 6, 1)], reds, rd0, er0, ct_in_datum)
}

// ── NEGATIVE: 2 Engage input, output-collapse (chỉ 1 output@engage) → #out!=#in ─
test consume_output_collapse_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  // Burn ĐỦ 20M để vượt qua ràng buộc giá → test chạm ĐÚNG bất biến #out == #in
  // (trước đây burn 10M nên chết sớm ở total_burned, KHÔNG hề kiểm collapse).
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [e0, e1], [vault], [ct_cont_output(11, 6, 1)], reds, rd, er0, ct_in_datum)   // 1 output
}

// ── NEGATIVE: 2 Engage input, thread-token drain (1 output thiếu NFT) → Σnft sai ─
test consume_thread_token_drain_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  // Burn ĐỦ 20M → test chạm ĐÚNG bất biến Σ NFT in == out (trước đây chết sớm ở giá).
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [e0, e1], [vault], [ct_cont_output(11, 6, 1), ct_cont_output(11, 6, 0)], reds, rd, er0, ct_in_datum)
}

// ── NEGATIVE: 2 Engage input, state under-count (1 output không tăng) → Σ sai ───
test consume_state_undercount_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  // Burn ĐỦ 20M → test chạm ĐÚNG bất biến Σ consumed_count (trước đây chết sớm ở giá).
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  // out: 11 + 10 = 21 ; in 20 + op 2 = 22 → 21 != 22 → fail
  run(pp, 1, 6, [e0, e1], [vault], [ct_cont_output(11, 6, 1), ct_cont_output(10, 6, 1)], reds, rd, er0, ct_in_datum)
}

// ── HAPPY value preserved: engage UTxO giữ 100 ADA + 5 TOK → output GIỮ NGUYÊN ──
fn ct_engage_input_v(ref_ix: Int, consumed: Int, lovelace: Int, other_qty: Int) -> Input {
  let v0 = assets.add(assets.from_lovelace(lovelace), ct_eng_sh, ct_thread_name, 1)
  let v = assets.add(v0, #"0a0a", #"544f4b", other_qty)
  let d = ct_datum(consumed, 0, 0, ct_did)
  util.mk_input(util.mk_ref_id(#"e1", ref_ix), util.mk_output(util.script_address(ct_eng_sh), v, d))
}

fn ct_cont_output_v(new_consumed: Int, new_epoch: Int, lovelace: Int, other_qty: Int) -> Output {
  let v0 = assets.add(assets.from_lovelace(lovelace), ct_eng_sh, ct_thread_name, 1)
  let v = assets.add(v0, #"0a0a", #"544f4b", other_qty)
  let d = ct_datum(new_consumed, new_epoch, ct_img_price, ct_did)
  util.mk_output(util.script_address(ct_eng_sh), v, d)
}

test consume_value_preserved_happy() {
  let pp = ct_pp(6)
  let eng = ct_engage_input_v(0, 10, 100_000_000, 5)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output_v(11, 6, 100_000_000, 5)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: drain ADA khỏi engage UTxO → value preservation fail ──────────────
test consume_drain_ada_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input_v(0, 10, 100_000_000, 0)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output_v(11, 6, 2_000_000, 0)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: drain token khác khỏi engage UTxO → value preservation fail ───────
test consume_drain_other_token_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input_v(0, 10, 100_000_000, 5)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output_v(11, 6, 100_000_000, 2)], reds, rd, eng_ref, ct_in_datum)
}

// ══════════════════════════════════════════════════════════════
// VALIDITY-RANGE GAMING (vá MAINNET-BLOCK): epoch tham chiếu KHÔNG bịa được.
//   build tx với validity_range tuỳ ý (không qua run() — run() ép cửa sổ hẹp).
// ══════════════════════════════════════════════════════════════

/// run nhưng tự đặt validity_range (test thao túng cửa sổ).
fn run_vr(
  pp_for_ref : PriceParam,
  vr         : interval.Interval,
  engage_inputs : List<Input>,
  vault_inputs  : List<Input>,
  outputs    : List<Output>,
  redeemers  : Pairs<ScriptPurpose, Data>,
  rd         : ConsumeRedeemer,
  own_ref    : OutputReference,
  in_datum   : EngageDatum,
) -> Bool {
  let tx =
    Transaction {
      ..placeholder,
      inputs: list.concat(engage_inputs, vault_inputs),
      reference_inputs: [ct_beacon_ref(pp_for_ref, 1)],
      outputs: outputs,
      redeemers: redeemers,
      validity_range: vr,
      // Chủ thread ký — cổng Nợ #36. Ca thiếu chữ ký nằm ở test riêng.
      extra_signatories: [in_datum.owner],
    }
  consume.spend(
    ct_price_policy, ct_price_name,
    ct_vault_sh, ct_burn_constr, ct_max_stale, ct_mspe, ct_price_param_sh,
    Some(in_datum), rd, own_ref, tx,
  )
}

// ── NEGATIVE: upper_bound VÔ HẠN (interval.after) → get_finite(upper) fail.
//    Trước vá: chỉ đọc lower → pass; attacker để upper hở. Sau vá: REJECT.
test consume_unbounded_upper_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run_vr(
    pp, interval.after(6 * ct_mspe), [eng], [vault],
    [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum,
  )
}

// ── NEGATIVE: cửa sổ RỘNG > 1 epoch (lower quá khứ, upper hiện tại) → fail.
//    Đây CHÍNH LÀ đòn under-state: attacker đặt lower ở epoch 1 để current=lower/mspe
//    nhỏ → dùng beacon cũ. Sau vá: upper−lower > ms_per_epoch → REJECT.
test consume_wide_window_understate_fail() fail {
  let pp = ct_pp(1)          // beacon epoch CŨ (giá rẻ giả định)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  // lower epoch 1, upper epoch 10 → cửa sổ 9 epoch >> 1 → fail ràng buộc cửa sổ.
  run_vr(
    pp, interval.between(1 * ct_mspe, 10 * ct_mspe), [eng], [vault],
    [ct_cont_output(11, 1, 1)], reds, rd, eng_ref, ct_in_datum,
  )
}

// ── HAPPY: cửa sổ nằm TRỌN trong epoch 6, epoch tham chiếu = upper. Beacon epoch 6.
//    Chứng minh đường đi hợp lệ (rộng gần cả epoch) vẫn chạy sau khi siết get_epoch.
test consume_tight_window_upper_epoch_happy() {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  // lower đầu epoch 6, upper sát cuối epoch 6 → cùng epoch; epoch ref = 6.
  run_vr(
    pp, interval.between(6 * ct_mspe, 7 * ct_mspe - 1), [eng], [vault],
    [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum,
  )
}

// ── NEGATIVE (VÁ #9): cửa sổ CƯỠI ranh giới epoch (lo ở epoch 5, hi ở epoch 6).
//    Bản cũ chỉ ép `hi − lo ≤ ms_per_epoch` (ở đây = 1ms) nên chấp nhận và trả 6,
//    trong khi tx có thể thực sự chạy ở epoch 5 → epoch bị thổi phồng +1 → cửa sổ
//    stale-check nới thêm 1 epoch. Sau vá: lo/mspe != hi/mspe → REJECT.
test consume_window_spans_two_epochs_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run_vr(
    pp, interval.between(6 * ct_mspe - 1, 6 * ct_mspe), [eng], [vault],
    [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum,
  )
}

// ══════════════════════════════════════════════════════════════
// VÁ 2026-08-09 — test hồi quy cho các lỗ audit
// ══════════════════════════════════════════════════════════════

// ── #1 NGHIÊM TRỌNG: DOUBLE-SATISFACTION XUYÊN-INSTANCE.
//    Hai Engage ở HAI script hash KHÁC NHAU (H_A=ct_eng_sh, H_B=ct_eng_sh_b — hai app,
//    hai apply-param) cùng trỏ MỘT vault burn 10M. Instance A chỉ đếm input tại H_A
//    → 10M == 10M PASS; instance B chỉ đếm input tại H_B → 10M == 10M PASS. Vault chỉ
//    giảm 10M cho 2 nghiệp vụ (đúng ra 20M). Sau vá: input tại H_B là script-input
//    KHÔNG thuộc {own_hash, vault_script_hash} → REJECT ngay.
test consume_cross_instance_double_sat_fail() fail {
  let pp = ct_pp(6)
  let e_a = ct_engage_input_at(ct_eng_sh, 0, 10)
  let e_b = ct_engage_input_at(ct_eng_sh_b, 1, 10)
  let vault = ct_vault_input(0)
  let er_a = util.mk_ref_id(#"e1", 0)
  let er_b = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds =
    [Pair(Spend(er_a), rd_as_data(rd)), Pair(Spend(er_b), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  // Mỗi instance có continuing output RIÊNG ở hash của mình → mọi bất biến per-hash
  // (đếm, NFT, value, state) đều thoả; chỉ ràng buộc MỚI mới chặn được.
  run(
    pp, 1, 6, [e_a, e_b], [vault],
    [ct_cont_output_at(ct_eng_sh, 11, 6, 1, ct_img_price),
     ct_cont_output_at(ct_eng_sh_b, 11, 6, 1, ct_img_price)],
    reds, rd, er_a, ct_in_datum,
  )
}

// ── #2 NGHIÊM TRỌNG: EngageDatum ghi GIÁ TRỊ, không chỉ ghi LƯỢT.
//    Kẻ gọi trả tiền op_type=2 (CID, 1M) — burn ĐÚNG 1M nên bất biến burn thoả, và
//    consumed_count +1 nên bất biến LƯỢT cũng thoả — nhưng ghi consumed_nanogic +10M
//    (giá 1 ảnh) để app tưởng đã trả tiền ảnh. Sau vá: Σnanogic(out) phải == Σ(in) +
//    total_required (1M) → 10M != 1M → REJECT.
test consume_nanogic_overstated_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(2, 1, vault_ref)          // op CID → required 1M
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 1_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output_ng(11, 6, 1, 10_000_000)], reds, rd, eng_ref, ct_in_datum)
}

// ── #2 đối chứng NGƯỢC: ghi THIẾU giá trị (0) cũng bị chặn (đóng cả hai chiều).
test consume_nanogic_understated_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output_ng(11, 6, 1, 0)], reds, rd, eng_ref, ct_in_datum)
}

// ── #2 HAPPY: op rẻ ghi ĐÚNG giá trị → pass (chứng minh đường hợp lệ còn đi được).
test consume_cheap_op_nanogic_happy() {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(2, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 1_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output_ng(11, 6, 1, 1_000_000)], reds, rd, eng_ref, ct_in_datum)
}

// ── #5 TRUNG BÌNH: beacon PriceParam KHÔNG ở địa chỉ script price_param → REJECT.
//    PoC cũ đặt beacon (bảng giá rẻ 1000×) ở VÍ THƯỜNG và vẫn được chấp nhận vì
//    validator chỉ kiểm NFT. Ở đây bảng giá vẫn ĐÚNG và NFT vẫn đủ 1 — chỉ khác địa
//    chỉ → cô lập đúng ràng buộc mới.
test consume_beacon_at_wallet_address_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run_beacon(
    ct_beacon_ref_at(pp, 1, util.vk_address(#"a11ce5")), 6, [eng], [vault],
    [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum,
  )
}

// ── #5 đối chứng: beacon ở địa chỉ SCRIPT KHÁC (không phải price_param) → REJECT.
test consume_beacon_at_other_script_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run_beacon(
    ct_beacon_ref_at(pp, 1, util.script_address(#"bad5")), 6, [eng], [vault],
    [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum,
  )
}

// ── #1 đối chứng: input ví thường (VerificationKey) trong cùng tx KHÔNG bị chặn.
//    Ràng buộc mới chỉ áp cho input do SCRIPT khoá — người dùng vẫn trả phí bằng ví.
test consume_wallet_input_allowed_happy() {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let wallet =
    util.mk_input(
      util.mk_ref_id(#"11", 0),
      util.mk_output_no_datum(util.vk_address(#"a11ce5"), assets.from_lovelace(50_000_000)),
    )
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault, wallet], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ══════════════════════════════════════════════════════════════
// VÁ 2026-08-09 #A — MINT GATE genesis-clean (PHƯƠNG ÁN A)
//   Trước vá: `engage_nft.mint` (policy RIÊNG) chỉ kiểm one-shot + đúng 1 token.
//   Kẻ mint đặt Engage UTxO genesis với consumed_nanogic bịa (1e18) và owner tuỳ ý,
//   ở địa chỉ nào cũng được. Bất biến delta của spend chỉ khoá PHẦN TĂNG.
//   Sau vá: mint gộp vào chính `consume` ⇒ ép ĐỊA CHỈ (Script(policy_id)) + DATUM SẠCH.
// ══════════════════════════════════════════════════════════════

fn ct_seed() -> OutputReference {
  util.mk_ref_id(#"5eed", 3)
}

/// Tên NFT hợp lệ DUY NHẤT cho seed này (mint-gate tự tính lại).
fn ct_seed_name() -> AssetName {
  crypto.blake2b_256(cbor.serialise(ct_seed()))
}

fn ct_seed_input() -> Input {
  util.mk_input(
    ct_seed(),
    util.mk_output_no_datum(util.vk_address(#"a0"), assets.from_lovelace(5_000_000)),
  )
}

/// Output genesis: địa chỉ tuỳ biến, value = ADA + 1 thread NFT (+ token lạ nếu có).
fn ct_gen_out(addr: Address, name: AssetName, d: EngageDatum, extra_tok: Int) -> Output {
  let v0 = assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, name, 1)
  let v =
    if extra_tok > 0 {
      assets.add(v0, #"0a0a", #"544f4b", extra_tok)
    } else {
      v0
    }
  util.mk_output(addr, v, d)
}

/// Chạy handler mint với policy_id == ct_eng_sh (tự tham chiếu: policy == script hash).
fn run_mint(
  inputs  : List<Input>,
  mint_v  : Value,
  outputs : List<Output>,
  sigs    : List<ByteArray>,
) -> Bool {
  let tx =
    Transaction {
      ..placeholder,
      inputs: inputs,
      mint: mint_v,
      outputs: outputs,
      extra_signatories: sigs,
    }
  consume.mint(
    ct_price_policy, ct_price_name, ct_vault_sh, ct_burn_constr, ct_max_stale,
    ct_mspe, ct_price_param_sh, MintEngage { seed: ct_seed() }, ct_eng_sh, tx,
  )
}

/// Datum genesis SẠCH.
fn ct_clean_genesis() -> EngageDatum {
  ct_datum(0, 0, 0, ct_did)
}

// ── HAPPY: seed bị tiêu, tên = H(seed), output tại địa chỉ script này, datum sạch ──
test engage_mint_clean_happy() {
  run_mint(
    [ct_seed_input()],
    assets.from_asset(ct_eng_sh, ct_seed_name(), 1),
    [ct_gen_out(util.script_address(ct_eng_sh), ct_seed_name(), ct_clean_genesis(), 0)],
    [ct_owner],
  )
}

// ── LỖ CHÍNH: datum genesis BỊA consumed_nanogic = 1e18 → REJECT ─────────────────
//    Đây là đòn mà bất biến delta KHÔNG chặn được: gốc bịa sống mãi trong state,
//    app đọc "đã tiêu 1e18 nanogic" và cấp dịch vụ miễn phí.
test engage_mint_fabricated_nanogic_fail() fail {
  run_mint(
    [ct_seed_input()],
    assets.from_asset(ct_eng_sh, ct_seed_name(), 1),
    [
      ct_gen_out(
        util.script_address(ct_eng_sh), ct_seed_name(),
        ct_datum(0, 0, 1_000_000_000_000_000_000, ct_did), 0,
      ),
    ],
    [ct_owner],
  )
}

// ── Bịa consumed_count (trục attribution/Governance C1) → REJECT ─────────────────
test engage_mint_fabricated_count_fail() fail {
  run_mint(
    [ct_seed_input()],
    assets.from_asset(ct_eng_sh, ct_seed_name(), 1),
    [ct_gen_out(util.script_address(ct_eng_sh), ct_seed_name(), ct_datum(7, 0, 0, ct_did), 0)],
    [ct_owner],
  )
}

// ── Bịa last_epoch (giả vờ thread vừa hoạt động) → REJECT ───────────────────────
test engage_mint_fabricated_last_epoch_fail() fail {
  run_mint(
    [ct_seed_input()],
    assets.from_asset(ct_eng_sh, ct_seed_name(), 1),
    [ct_gen_out(util.script_address(ct_eng_sh), ct_seed_name(), ct_datum(0, 6, 0, ct_did), 0)],
    [ct_owner],
  )
}

// ── ĐỊA CHỈ: đúc NFT về VÍ THƯỜNG (rồi dời nhà kèm datum bẩn) → REJECT ──────────
test engage_mint_output_at_wallet_fail() fail {
  run_mint(
    [ct_seed_input()],
    assets.from_asset(ct_eng_sh, ct_seed_name(), 1),
    [ct_gen_out(util.vk_address(#"a11ce5"), ct_seed_name(), ct_clean_genesis(), 0)],
    [ct_owner],
  )
}

// ── ĐỊA CHỈ: đúc về SCRIPT KHÁC (kể cả instance consume khác) → REJECT ──────────
test engage_mint_output_at_other_script_fail() fail {
  run_mint(
    [ct_seed_input()],
    assets.from_asset(ct_eng_sh, ct_seed_name(), 1),
    [ct_gen_out(util.script_address(ct_eng_sh_b), ct_seed_name(), ct_clean_genesis(), 0)],
    [ct_owner],
  )
}

// ── ONE-SHOT: seed KHÔNG bị tiêu → REJECT (chống đúc lại thread thứ hai) ────────
test engage_mint_seed_not_spent_fail() fail {
  let other =
    util.mk_input(
      util.mk_ref_id(#"ff", 0),
      util.mk_output_no_datum(util.vk_address(#"a0"), assets.from_lovelace(5_000_000)),
    )
  run_mint(
    [other],
    assets.from_asset(ct_eng_sh, ct_seed_name(), 1),
    [ct_gen_out(util.script_address(ct_eng_sh), ct_seed_name(), ct_clean_genesis(), 0)],
    [ct_owner],
  )
}

// ── owner trong datum KHÔNG ký → REJECT (không đúc "nhân danh" ví nạn nhân) ─────
test engage_mint_owner_not_signer_fail() fail {
  run_mint(
    [ct_seed_input()],
    assets.from_asset(ct_eng_sh, ct_seed_name(), 1),
    [ct_gen_out(util.script_address(ct_eng_sh), ct_seed_name(), ct_clean_genesis(), 0)],
    [#"beefbeef"],
  )
}

// ── TÊN: không phải blake2b_256(cbor(seed)) → REJECT (một seed một tên) ─────────
test engage_mint_wrong_name_fail() fail {
  run_mint(
    [ct_seed_input()],
    assets.from_asset(ct_eng_sh, ct_thread_name, 1),
    [ct_gen_out(util.script_address(ct_eng_sh), ct_thread_name, ct_clean_genesis(), 0)],
    [ct_owner],
  )
}

// ── Đúc 2 tên trong 1 tx (nhân bản thread) → dict.size != 1 → REJECT ────────────
test engage_mint_two_names_fail() fail {
  let v =
    assets.add(assets.from_asset(ct_eng_sh, ct_seed_name(), 1), ct_eng_sh, ct_thread_name, 1)
  run_mint(
    [ct_seed_input()],
    v,
    [ct_gen_out(util.script_address(ct_eng_sh), ct_seed_name(), ct_clean_genesis(), 0)],
    [ct_owner],
  )
}

// ── Nhét token lạ vào UTxO genesis → policies > 2 → REJECT ──────────────────────
//    Engage UTxO bảo toàn value tuyệt đối ⇒ token nhét vào đây KẸT vĩnh viễn.
test engage_mint_extra_token_fail() fail {
  run_mint(
    [ct_seed_input()],
    assets.from_asset(ct_eng_sh, ct_seed_name(), 1),
    [ct_gen_out(util.script_address(ct_eng_sh), ct_seed_name(), ct_clean_genesis(), 5)],
    [ct_owner],
  )
}

// ── ĐỐI CHỨNG (chống vá quá tay): did_commit KHÁC RỖNG vẫn PASS ─────────────────
//    types.ak định nghĩa did_commit là commitment do người tạo đặt một lần lúc
//    genesis (MVP rỗng, tương lai = blake2b256 liên kết DID). Đó là LỰA CHỌN, không
//    phải state tích luỹ ⇒ pin cứng về #"" sẽ khoá chết đường DID mà không thêm an
//    toàn nào. Test này khoá quyết định đó lại để lần sau không ai "siết nhầm".
test engage_mint_did_commit_free_happy() {
  run_mint(
    [ct_seed_input()],
    assets.from_asset(ct_eng_sh, ct_seed_name(), 1),
    [
      ct_gen_out(
        util.script_address(ct_eng_sh), ct_seed_name(),
        ct_datum(0, 0, 0, #"d1d1d1d1"), 0,
      ),
    ],
    [ct_owner],
  )
}

// ── SPEND: UTxO "engage giả" (đậu ở địa chỉ script, KHÔNG mang thread NFT) ──────
//    Ai cũng gửi được UTxO tới địa chỉ script (không validator nào chạy lúc TẠO).
//    Nếu nó tham gia được vào tổng kế toán thì datum bịa của nó lọt vào Σ. Cổng
//    định danh phía input chặn ngay: dict token dưới own_hash RỖNG → fail-closed.
test consume_fake_engage_input_no_nft_fail() fail {
  let pp = ct_pp(6)
  let real = ct_engage_input(0, 10)
  let fake =
    util.mk_input(
      util.mk_ref_id(#"e1", 1),
      util.mk_output(
        util.script_address(ct_eng_sh),
        assets.from_lovelace(2_000_000),
        ct_datum(0, 0, 1_000_000_000_000_000_000, ct_did),
      ),
    )
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(
    pp, 1, 6, [real, fake], [vault],
    [ct_cont_output(11, 6, 1), ct_cont_output(11, 6, 1)], reds, rd, er0, ct_in_datum,
  )
}

// ══════════════════════════════════════════════════════════════
// ĐO EX-UNIT KỊCH BẢN XẤU NHẤT trên đường `consume` THẬT
//   bảng giá ĐẦY (max_op_prices = 16 dòng) × 2 Engage input × 1 vault.
//   Số đo dán trong báo cáo; đây là mốc hồi quy để lần sau đổi cấu trúc dữ liệu
//   còn có cái mà so. Trần tx Cardano: 14 M mem / 10 G cpu.
// ══════════════════════════════════════════════════════════════

/// Bảng giá n dòng, op_type TĂNG NGẶT 1..n (dạng chuẩn tắc bắt buộc sau VÁ #C).
fn ct_ops(n: Int) -> List<OpPrice> {
  if n <= 0 {
    []
  } else {
    list.concat(ct_ops(n - 1), [OpPrice { op_type: n, base_price: 10_000_000 }])
  }
}

fn ct_pp_full(epoch: Int) -> PriceParam {
  PriceParam {
    op_prices: ct_ops(pricing.max_op_prices),
    demand_mult: 1_000_000_000,
    m_min: 500_000_000,
    m_max: 2_000_000_000,
    epoch: epoch,
  }
}

test consume_worst_case_full_table_two_engage_happy() {
  // op_type = 16 (dòng CUỐI bảng → lookup_base duyệt hết list, xấu nhất).
  let pp = ct_pp_full(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(pricing.max_op_prices, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [e0, e1], [vault], [ct_cont_output(11, 6, 1), ct_cont_output(11, 6, 1)], reds, rd, er0, ct_in_datum)
}



// ── SPEND: GỘP hai thread vào MỘT UTxO → "đúng 1 NFT / UTxO" chặn ──────────────
//    Thực tế mỗi thread một tên riêng (H(seed)). Kẻ gọi gộp cả hai NFT vào 1 output
//    và để output còn lại rỗng NFT: Σ value VẪN bảo toàn, #out == #in VẪN đúng, Σ
//    count / Σ nanogic VẪN khớp — mọi bất biến TỔNG đều thoả. Chỉ ràng buộc theo
//    TỪNG UTxO mới chặn được việc hợp nhất (sau đó một thread "chết" mà tài sản
//    định danh của nó đã dồn sang cái khác).
fn ct_engage_input_named(ref_ix: Int, consumed: Int, name: AssetName) -> Input {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, name, 1)
  let d = ct_datum(consumed, 0, 0, ct_did)
  util.mk_input(
    util.mk_ref_id(#"e1", ref_ix),
    util.mk_output(util.script_address(ct_eng_sh), v, d),
  )
}

test consume_thread_merge_into_one_utxo_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input_named(0, 10, #"41")   // thread A
  let e1 = ct_engage_input_named(1, 10, #"42")   // thread B
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  // out1 giữ CẢ A lẫn B; out2 không NFT. Σ value in == Σ value out.
  let merged =
    util.mk_output(
      util.script_address(ct_eng_sh),
      assets.add(
        assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, #"41", 1),
        ct_eng_sh, #"42", 1,
      ),
      ct_datum(11, 6, ct_img_price, ct_did),
    )
  let empty =
    util.mk_output(
      util.script_address(ct_eng_sh),
      assets.from_lovelace(2_000_000),
      ct_datum(11, 6, ct_img_price, ct_did),
    )
  run(pp, 1, 6, [e0, e1], [vault], [merged, empty], reds, rd, er0, ct_in_datum)
}

// ── ĐỐT thread NFT là BẤT KHẢ: mint-gate đòi qty == +1 nên mọi lượng âm bị chặn ──
//    Hệ quả (ghi rõ, không giấu): Engage thread KHÔNG có đường đóng ⇒ min-ADA của nó
//    khoá vĩnh viễn. Đây là đánh đổi CÓ CHỦ Ý, giống các vault gen: NFT định danh còn
//    sống thì state không bị "đóng rồi mở lại" với datum khác.
test engage_mint_burn_attempt_fail() fail {
  run_mint(
    [ct_seed_input()],
    assets.from_asset(ct_eng_sh, ct_seed_name(), -1),
    [ct_gen_out(util.script_address(ct_eng_sh), ct_seed_name(), ct_clean_genesis(), 0)],
    [ct_owner],
  )
}
