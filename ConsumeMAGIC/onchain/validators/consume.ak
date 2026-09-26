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
//     did_commit bất biến (ép out == in — NHÁNH NÀY, không phải toàn validator),
//     thread NFT bảo toàn, owner bảo toàn, value bảo toàn.
//   - spend Engage UTxO bằng redeemer `BindDID`: ĐƯỜNG GHI DUY NHẤT còn lại cho
//     `did_commit`. Một chiều, đúng một lần — rỗng → 32 byte, rồi khoá vĩnh viễn.
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
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets.{AssetName, PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, ScriptPurpose, Spend, Transaction,
  placeholder,
}
use magiclamp/consume/owner_auth.{owner_authorized}
use magiclamp/consume/pricing
use magiclamp/consume/types.{
  BindDID, BurnEngage, CloseThread, Consume, ConsumeRedeemer, EngageDatum,
  EngageMintRedeemer, MintEngage, OpPrice, PriceParam,
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
    when redeemer is {
      MintEngage { seed } -> validate_mint_engage_id(seed, policy_id, tx)
      // Đường ĐỐT thread NFT (đóng thread). Quyền nằm ở nhánh spend CloseThread.
      BurnEngage -> validate_burn_engage(policy_id, tx)
    }
  }

  spend(
    datum_opt : Option<EngageDatum>,
    redeemer  : ConsumeRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(in_datum) = datum_opt
    let own_addr = util.own_address(own_ref, tx.inputs)
    let own_hash = util.own_script_hash(own_addr)
    when redeemer is {
      // vault_ref của invocation này được dùng qua distinct_vault_refs (aggregate);
      // không cần tham chiếu trực tiếp ở đây.
      Consume { op_type, op_count, price_ref, vault_ref: _ } ->
        validate_consume(
          tx, own_hash, in_datum, op_type, op_count, price_ref,
          price_nft_policy, price_nft_name, vault_script_hash, burn_batch_constr,
          max_price_stale, ms_per_epoch, price_param_script_hash,
        )
      // Gắn PersonDID vào thread. Đường RIÊNG, không đụng giá / vault / epoch.
      BindDID -> validate_bind_did(tx, own_hash, in_datum)
      // Đóng thread, lấy lại min-ADA. Không đọc giá, không đụng vault.
      CloseThread -> validate_close_thread(tx, own_hash, own_ref, in_datum)
    }
  }

  else(_) {
    fail
  }
}

// ═══════════════════════════════════════════════════════════════
// validate_consume — nhánh TIÊU MAGIC (redeemer constr 0)
//
// Nguyên văn thân `spend` cũ. Tách thành hàm (nhận lại 7 apply-param) thay vì lồng
// vào một nhánh `when` để bộ ràng buộc đã có không bị đẩy thêm một tầng thụt lề —
// mỗi lần re-indent trọn khối là một lần diff phủ kín thứ không đổi và giấu thứ đổi.
// ═══════════════════════════════════════════════════════════════
fn validate_consume(
  tx        : Transaction,
  own_hash  : ByteArray,
  in_datum  : EngageDatum,
  op_type   : Int,
  op_count  : Int,
  price_ref : OutputReference,
  price_nft_policy  : PolicyId,
  price_nft_name    : AssetName,
  vault_script_hash : ByteArray,
  burn_batch_constr : Int,
  max_price_stale   : Int,
  ms_per_epoch      : Int,
  price_param_script_hash : ByteArray,
) -> Bool {
    expect op_count >= 1

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
    //    dùng làm mục tiêu khớp burn (xem (4) bên dưới — chống under-charge khi nhiều
    //    Engage co-spend chung 1 vault).
    expect Some(required) = pricing.required_for(pp, op_type, op_count)
    expect required > 0

    // ── ENGAGE state: ghép 1-1 input↔output, KHÔNG so tổng ─────────────────────
    // (1) #out@engage == #in@engage (no collapse).
    //
    //     🔴 Mệnh đề này THỪA — nó được SUY RA từ ba chốt khác, và không gánh tải nào.
    //     Chứng minh, đếm token dưới `own_hash` ở hai vế:
    //       · cổng định danh phía input (trên) ⟹ mỗi input@engage mang ĐÚNG 1 token, qty 1
    //         ⟹ tổng qty dưới own_hash ở vế vào = n_in;
    //       · vòng (A) trong `enforce_engagement` ⟹ mỗi output@engage mang ĐÚNG 1 token,
    //         qty 1 ⟹ tổng qty ở vế ra = n_out;
    //       · (3) `engage_value_preserved` ép TOÀN BỘ value vào == ra ⟹ hai tổng bằng nhau.
    //     ⟹ n_in == n_out. Đo bằng đột biến 2026-09-25 (nền 192/192): gỡ riêng dòng này
    //     → 0 bài lật. Đó là ĐỘT BIẾN TƯƠNG ĐƯƠNG — không có bài nào giết được nó, nên
    //     "sống sót" ở đây KHÔNG phải một lỗ của bộ kiểm.
    //     Bản trước của chú thích này gọi nó là "vế chứng minh song ánh". Sai hướng: song
    //     ánh đứng trên (A) + (3) + phép ghép theo TÊN ở (4). Giữ dòng này làm phòng thủ
    //     chiều sâu, chi phí hai lượt duyệt danh sách. Ai định gỡ một trong ba chốt kia
    //     thì phải biết dòng này KHÔNG thay được chốt đó — nó chỉ là hệ quả của chúng.
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
    //
    //     GIỮ LẠI dù (4) đã ép value theo TỪNG CẶP: mệnh đề này là thứ chứng minh
    //     TÊN thread trên các input PHÂN BIỆT ĐÔI MỘT. Nếu hai input cùng mang tên X
    //     thì Σvalue(in) có X:2, nên Σvalue(out) cũng phải có X:2, mà mỗi output chỉ
    //     mang ĐÚNG 1 token dưới own_hash ⇒ phải có HAI output mang X ⇒ phép lọc
    //     "đúng một output mang tên X" ở (4) nổ. Bỏ dòng này là bỏ luôn lập luận
    //     song ánh, và phép ghép tụt xuống thành ánh xạ (nhiều input → một output).
    expect engage_value_preserved(tx, own_hash)

    // (4) GHÉP 1-1 THEO TÊN THREAD + LIÊN KẾT VAULT.
    //     `enforce_engagement` trả về total_required = Σ price(op_type_i)×op_count_i
    //     trên MỌI Engage input, ĐỒNG THỜI ghim từng cặp (xem thân hàm).
    //     total_burned = Σ burns trên MỌI vault_ref PHÂN BIỆT do các Engage input trỏ.
    //     ép total_burned == total_required (C-CM-2, chống multi-engage→single-vault):
    //     per-invocation == aggregate → idempotent qua mọi invocation; không Engage nào
    //     "mượn" burn của Engage khác.
    let total_required =
      enforce_engagement(
        tx, own_hash, in_datum.owner, in_datum.did_commit, current_epoch, pp,
        price_ref,
      )
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
    //    ĐÚNG MỘT vế, VÔ ĐIỀU KIỆN: mọi vault bị đốt trong tx phải THUỘC VỀ chủ
    //    thread. Nói cách khác, MAGIC bị đốt là MAGIC của chính chủ thread, nên
    //    không có phiếu nào bị mua — người dựng giao dịch không ghi được vào hồ sơ
    //    ai khác ngoài người sở hữu số MAGIC vừa tiêu. Ai được tiêu vault đó thì do
    //    CHÍNH VAULT gác — nay là CHỈ `owner`
    //    (`InstantGen/onchain/validators/vault.ak` ▸ `validate_burn_batch`), không
    //    phải việc của lớp này.
    //
    //    🪦 ĐỌC PHẦN CÒN LẠI CỦA KHỐI NÀY NHƯ LỊCH SỬ (bia mộ 2026-09-16, Nợ #14).
    //    Mọi câu dưới đây nói "vault cho qua vì `personal_delegate == Some(A)`" mô tả
    //    một trạng thái ĐÃ CHẾT: nhánh uỷ nhiệm bị bỏ khỏi mô hình, cả ba vault
    //    (ScheduleGen · InstantGen · PrepaidGen) nay chỉ nhận chữ ký chủ sở hữu.
    //    Chúng được GIỮ vì chúng là lý do tồn tại của cổng `all_vault_owners_are`, và
    //    cổng đó KHÔNG được gỡ theo: nó là lớp phòng thủ độc lập với lớp chữ ký, và
    //    "hôm nay không dựng được đường đó" không phải "không cần cổng".
    //
    //    🔴 VÌ SAO KHÔNG CÒN VẾ `|| chữ ký chủ thread` (vá 2026-09-15).
    //    Bản cũ viết `list.has(tx.extra_signatories, owner) || all_vault_owners_are(..)`.
    //    Chú thích ngay trên nó phát biểu bảo đảm "MAGIC bị đốt là MAGIC của chính chủ
    //    thread" — mà bảo đảm đó do MỘT MÌNH vế 2 giữ. `||` ngắn mạch, vế 1 là vế dễ
    //    thoả nhất (chủ thread luôn ký giao dịch của chính mình), nên trong thực tế vế
    //    2 gần như không bao giờ chạy. Đường đi lọt, dựng được bằng thao tác HỢP LỆ:
    //      A đúc thread Engage của A → A xin `personal_delegate` trên vault của V
    //      (V ký `SetDelegate`, đúng thiết kế) → A dựng tx gồm thread của A + vault của
    //      V, chỉ A ký. Vault cho qua vì `personal_delegate == Some(A)`; consume cho
    //      qua vì vế 1 thoả. MAGIC của V bị đốt, `consumed_nanogic` của A tăng đúng
    //      bằng số đó — đúng đường mua phiếu bằng tiền mà cổng này sinh ra để chặn.
    //
    //    Đường Paymaster/Feecover KHÔNG bị bản vá này giết: ở đó vault CŨNG thuộc về
    //    người dùng (app chỉ là `personal_delegate`), nên `all_vault_owners_are` thoả
    //    mà không cần chữ ký nào. Bài canh: `consume_sponsor_no_signature_ok`.
    //
    //    CÁI CỔNG NÀY THẬT SỰ CHẶN GÌ (viết lại 2026-09-15 — bản cũ tả sai hình dạng).
    //    Bản cũ biện minh bằng "tx trộn một vault của chủ thread với một vault của
    //    người lạ". Hình dạng đó KHÔNG DỰNG ĐƯỢC trong hợp thành hiện tại: cả hai loại
    //    vault đang phục vụ đều ép ĐÚNG MỘT input tại địa chỉ vault trong một tx —
    //    `InstantGen/onchain/validators/vault.ak` ▸ `validate_burn_batch` (`DS-1`), và
    //    `ScheduleGen/onchain/validators/vault.ak` ▸ chốt `C-VAULT-DS-1` đặt ngay đầu
    //    nhánh `spend` nên áp cho MỌI redeemer, BurnBatch trong đó. Hai vault trong một
    //    tx là hai input tại cùng payment credential ⇒ vault tự chết trước khi lớp này
    //    kịp nói gì.
    //
    //    Thứ cổng này chặn, và nó là thứ THẬT: MỘT vault duy nhất KHÔNG thuộc chủ
    //    thread. Kẻ tấn công xin `personal_delegate` trên vault của V (V ký
    //    `SetDelegate`, đúng thiết kế), rồi ghép vault đó với thread của chính mình.
    //    Vault cho qua vì có delegate; không có cổng này thì `consumed_nanogic` của kẻ
    //    tấn công tăng đúng bằng số MAGIC của V. Bài canh:
    //    `consume_foreign_vault_with_owner_signature_rejected`.
    //
    //    BỀ RỘNG MULTI-VAULT LÀ BỀ RỘNG CHƯA TỚI ĐƯỢC. `distinct_vault_refs_over_engage_inputs`
    //    / `sum_burns_over_vault_refs` / `all_vault_owners_are` đều duyệt một DANH SÁCH
    //    vault_ref, và danh sách đó có nhiều hơn một phần tử chỉ khi một loại vault mới
    //    (chưa tồn tại) bỏ chốt một-input. Giữ `list.all` thay vì "có một cái khớp" là
    //    giữ đúng chiều fail-closed cho ngày đó; đừng đọc nó thành bằng chứng rằng hôm
    //    nay dựng được tx nhiều vault.
    all_vault_owners_are(tx.inputs, vault_refs, in_datum.owner)
}

/// Độ dài hợp lệ của `did_commit`: RỖNG (chưa gắn) hoặc ĐÚNG 32 byte (blake2b-256).
///
/// Ghim ở MỌI chỗ GHI trường này (mint genesis + BindDID). Không ghim thì một
/// `did_commit` dài tuỳ ý đi được vào datum: nó vừa phình UTxO (min-ADA theo kích
/// thước) vừa buộc mọi bên đọc tự đoán khuôn — và "tự đoán khuôn" ở lớp định danh là
/// chỗ hai bên đọc ra hai người khác nhau từ cùng một chuỗi byte.
///
/// CỐ Ý KHÔNG ép ở nhánh `Consume`: nhánh đó không GHI, nó ép
/// `output.did_commit == input.did_commit`. Thêm kiểm độ dài vào đó là biến mọi thread
/// đã tồn tại với did sai khuôn thành BẤT KHẢ TIÊU (min-ADA khoá vĩnh viễn) — ràng
/// buộc phải đặt ở cổng VÀO, không đặt ở cổng RA của state đã nằm trên chuỗi.
fn did_len_ok(did: ByteArray) -> Bool {
  let n = builtin.length_of_bytearray(did)
  n == 0 || n == 32
}

// ═══════════════════════════════════════════════════════════════
// validate_bind_did — GẮN PersonDID vào thread (redeemer constr 1)
//
// VÌ SAO TỒN TẠI: thread mở trong giai đoạn này có `did_commit` rỗng (lớp gắn DID
// chưa bật). `Consume` ép did_commit BẤT BIẾN, nên khi hệ bật `consumedFactor` (hệ số
// tư-cách đọc MAGIC đã tiêu, gắn theo PersonDID) thì mọi thread mở hôm nay nằm ngoài
// cơ chế đó VĨNH VIỄN — không đường nào điền vào sau.
//
// ĐI MỘT CHIỀU, ĐÚNG MỘT LẦN: rỗng → 32 byte → đóng băng. Không đường về, không đổi
// từ giá trị này sang giá trị khác (vì cổng đòi giá trị hiện tại phải RỖNG).
//
// KHÔNG uỷ quyền: đây là thao tác gắn DANH TÍNH, đòi chữ ký của CHÍNH `owner`.
// 🪦 Vế `|| personal_delegate` mà dòng này từng đối chiếu (nhánh consume, đường
// Paymaster/Feecover) đã CHẾT 2026-09-16 (Nợ #14). Ba vị từ ký của ba vault
// (ScheduleGen · InstantGen · PrepaidGen) nay chỉ nhận chữ ký chủ sở hữu — danh
// sách ĐÓNG, đếm được bằng `grep -rn "personal_delegate is {"` ngoài `Legacy/`
// → 0. Nên với `personal_delegate`, đây không còn là ngoại lệ mà là luật chung.
//
// KHÔNG đọc rộng hơn thế. Bản trước viết "không còn nhánh nào TRONG HỆ nhận uỷ
// quyền" — một lượng từ toàn xưng không có phép liệt kê nào đứng sau, và nó SAI:
// `delegation_cert` (uỷ quyền STAKE) vẫn là một trường sống của datum, và kho
// Treasury CÓ uỷ quyền stake theo D14. Hai thứ cùng mang chữ "uỷ quyền" mà khác
// hẳn nhau — cái chết là uỷ quyền TIÊU, không phải uỷ quyền STAKE.
//
// DOUBLE-SATISFACTION: mọi bất biến dưới đây cục bộ theo `own_hash` và bị kẹp bởi
// `#in == #out == 1`, nên một tx phục vụ đúng MỘT thread. Trộn một input BindDID với
// một input Consume cùng script cũng chết: nhánh BindDID thấy `n_in == 2`, còn nhánh
// Consume thấy redeemer không phải `Consume` ở `expect Consume {..}`.
// ═══════════════════════════════════════════════════════════════
/// 🔴 GIỚI HẠN PHẢI ĐỌC TRƯỚC KHI DÙNG `did_commit` LÀM ĐẦU VÀO CHO BẤT CỨ THỨ GÌ
///
/// Nhánh này KHÔNG xác thực rằng DID được gắn **thuộc về** người ký. Nó kiểm đúng năm
/// thứ: một-lần · chữ ký **CHỦ THREAD** · 1-vào-1-ra · value bảo toàn · độ dài 32 byte.
/// Không vế nào chứng minh mối liên hệ giữa `in_datum.owner` và `did_commit`.
///
/// **Hệ quả cụ thể, không phải lý thuyết:** `did_commit` là một hash 32 byte nằm CÔNG
/// KHAI trên chuỗi trong mọi thread đã gắn. Nên bất kỳ ai cũng CHÉP được `did_commit`
/// của người khác vào thread của mình — không cần biết tiền ảnh, chỉ cần đọc chuỗi —
/// rồi toàn bộ MAGIC mình tiêu sẽ quy về DID của người đó. Cả hai chiều đều mở: bán
/// mức-tiêu của mình cho người khác, và thổi mức-tiêu cho một người không hề yêu cầu.
///
/// Điều đó **ĐÚNG THEO THIẾT KẾ** ở tầng này — `types.ak` định nghĩa `did_commit` là
/// một cam kết do người tạo đặt, và `engage_mint_did_commit_free_happy` (cuối tệp này)
/// khoá chủ ý đó lại để không ai "siết nhầm". Chứng minh quyền sở hữu DID được giả định
/// nằm ở tầng khác.
///
/// **VÌ THẾ:** `did_commit` dùng được cho **QUY KẾT** (ai tự nhận việc tiêu này), KHÔNG
/// dùng được cho bất cứ thứ gì mà nói dối có lợi — quyền biểu quyết, phân bổ phần
/// thưởng, hạn mức theo người, chống-Sybil. Một hệ đọc `did_commit` làm đầu vào cho
/// những thứ đó đang đọc một lời tự khai không ai kiểm.
///
/// Nếu có ngày cần vế mạnh, hình dạng rẻ nhất là đọc anchor Service-DID của PhoenixKey
/// qua `reference_input` rồi đòi chữ ký của controller hiện tại — cùng khuôn mà
/// `SPEC` §13 đã mô tả cho `engine_key`. Nó đổi script hash ⟹ deploy lại ⟹ công bố
/// ref-script CIP-33 mới, nên phải đi cùng một lượt với việc khác đổi hash.
///
/// Viết ra đây, không viết ở tài liệu, vì đây là chỗ người sắp dựa vào `did_commit` sẽ
/// mở ra đọc. Một kho khác đã mở sẵn một mục treo chờ đúng câu trả lời này, và câu trả
/// lời là KHÔNG.
fn validate_bind_did(
  tx       : Transaction,
  own_hash : ByteArray,
  in_datum : EngageDatum,
) -> Bool {
  // ── (1) MỘT LẦN: chỉ hợp lệ khi chưa gắn. Đã có giá trị ⇒ TỪ CHỐI ─────────────
  //    Đây là vế khoá cả hai hướng sai: đổi did này sang did khác, và ghi đè did của
  //    một thread đã có danh tính.
  expect in_datum.did_commit == #""

  // ── (2) CHỮ KÝ CỦA CHÍNH CHỦ THREAD ──────────────────────────────────────────
  //    Thiếu vế này thì bất kỳ ai cũng gắn được một DID do MÌNH chọn vào thread của
  //    người khác, và vì cổng (1) chỉ cho ghi MỘT LẦN nên nạn nhân mất luôn đường
  //    gắn DID thật của họ — hỏng không hoàn tác được.
  expect owner_authorized(tx, in_datum.owner)

  // ── (3) ĐÚNG 1 vào, ĐÚNG 1 ra tại địa chỉ engage ─────────────────────────────
  //    Không gộp hai thread, không tách một thread. Đồng thời làm continuing output
  //    là DUY NHẤT ⇒ đọc nó không cần khớp theo tên NFT.
  expect util.count_inputs_at_script(tx.inputs, own_hash) == 1
  expect util.count_outputs_at_script(tx.outputs, own_hash) == 1

  // ── (4) VALUE BẢO TOÀN TUYỆT ĐỐI ─────────────────────────────────────────────
  //    Cộng với (5) `single_thread_nft` phía output, nó cũng chứng minh input mang
  //    đúng 1 thread NFT (value vào == value ra) — nên không cần cổng định danh riêng
  //    phía input như nhánh Consume.
  expect engage_value_preserved(tx, own_hash)

  expect Some(out) =
    list.find(tx.outputs, fn(o) { util.is_at_script(o.address, own_hash) })
  // ── (4-bis) ĐỊA CHỈ ĐẦY ĐỦ bảo toàn (vá 2026-09-15, CAO) ─────────────────────
  //    `is_at_script` chỉ so PAYMENT credential, nên nhánh này cũng có đúng lỗ của
  //    nhánh Consume: người dựng tx thêm stake credential của mình vào output, địa
  //    chỉ bech32 đổi, và thread biến mất khỏi mọi công cụ tra theo địa chỉ
  //    (`lucid.utxosAt(consumeAddr)` trả rỗng). Neo vào địa chỉ của chính input đang
  //    tiêu — (3) đã ép đúng 1 input tại engage nên `input_at_script` là xác định.
  expect out.address == util.input_at_script(tx.inputs, own_hash).address
  expect InlineDatum(d) = out.datum
  expect od: EngageDatum = d
  // ── (5) đúng 1 thread NFT trên output ────────────────────────────────────────
  expect single_thread_nft(out.value, own_hash)

  and {
    // ── (6) MỌI trường còn lại bảo toàn TUYỆT ĐỐI ─────────────────────────────
    //    Giao dịch này chỉ điền MỘT trường. `consumed_count` / `consumed_nanogic` là
    //    đầu vào tư-cách biểu quyết (C1) và `owner` là quyền tiêu — nhân tiện sửa một
    //    trong số đó là biến một thao tác khai danh tính thành một đường bơm hồ sơ.
    od.owner == in_datum.owner,
    od.consumed_count == in_datum.consumed_count,
    od.last_epoch == in_datum.last_epoch,
    od.consumed_nanogic == in_datum.consumed_nanogic,
    // ── (7) giá trị mới phải KHÁC RỖNG ────────────────────────────────────────
    //    Không có vế này thì "gắn DID" bằng chuỗi rỗng là một no-op hợp lệ; vô hại
    //    một mình, nhưng nó làm cổng (1) không còn nghĩa "một lần".
    od.did_commit != #"",
    // ── (8) và ĐÚNG KHUÔN 32 byte ─────────────────────────────────────────────
    did_len_ok(od.did_commit),
  }
}

// ═══════════════════════════════════════════════════════════════
// validate_close_thread — ĐÓNG thread, trả lại min-ADA (redeemer constr 2)
//
// Chủ dự án duyệt 2026-09-25. Trước redeemer này, min-ADA của mỗi Engage UTxO bị khoá
// VĨNH VIỄN: `Consume` và `BindDID` đều ép `#out@engage == #in@engage`, nên không nhánh
// nào tiêu được UTxO engage mà không dựng lại một UTxO engage khác.
//
// HÌNH DẠNG: đóng = ĐỐT thread NFT, không phải "để lại một UTxO rỗng". Nếu chỉ cho ADA
// đi ra mà NFT vẫn sống, thread hoá thành một cái vỏ mang định danh còn nguyên nhưng
// không còn state — và mọi bên đọc theo NFT sẽ thấy một thread "tồn tại" mà không tra
// được gì. Đốt NFT làm thread biến mất HẲN.
//
// 🔴 KHÔNG ÉP ĐÍCH CỦA ADA — có chủ ý. Người dựng tx chọn đích, và chữ ký `owner` ở (a)
// là cái duyệt lựa chọn đó. Ép đích về một địa chỉ suy từ `owner` (vd `VerificationKey
// (owner)`) sẽ giết mọi ví script, ví nhiều chữ ký, và mọi luồng có người trả phí hộ —
// trong khi không thêm bảo đảm nào: người ký ĐÃ thấy toàn bộ tx trước khi ký.
//
// DOUBLE-SATISFACTION và ca TRỘN VỚI `Consume`:
//   · Trộn `CloseThread` với `Consume` trong một tx thì invocation `Consume` CHẾT.
//     Bài canh: `close_mixed_with_consume_consume_side_fail`.
//
//     🔴 NHƯNG NÓ KHÔNG CHẾT Ở `#in@engage == #out@engage`, và bản đầu của khối này
//     khai sai đúng chỗ đó. Đo bằng đột biến 2026-09-25 (nền 192/192):
//       · gỡ MỘT MÌNH `expect n_in == n_out`              → ca này VẪN ĐỎ (0 bài lật)
//       · gỡ nó CÙNG `engage_value_preserved`             → ca này VẪN ĐỎ (1 bài lật,
//         là `consume_duplicate_thread_name_value_sum_fail`, không phải ca này)
//     Nên phát biểu đúng mức là *"có bài đỏ ở ca trộn"*, và thứ canh nó nằm SÂU HƠN:
//     theo đọc mã, đó là phép ghép cặp `expect [out] = list.filter(...)` trong
//     `enforce_engagement` (thread bị đóng không có output nào mang tên NFT của nó),
//     rồi tới `expect Consume { .. } = find_consume_redeemer(...)` ngay dưới. CHƯA đo
//     tách được hai chốt đó, nên đừng viết rằng chúng "đã được ghim".
//     Ghi ra vì `n_in == n_out` là câu trả lời TRỰC GIÁC ở đây, và nó sai: ai tin nó
//     rồi gỡ một trong hai chốt thật sẽ thấy bộ kiểm vẫn xanh.
//   · Chiều còn lại cũng đóng, độc lập: (c) dưới đây cấm MỌI output tại địa chỉ engage
//     mang NFT dưới `own_hash` — mà một `Consume` hợp lệ buộc phải có đúng một output
//     như thế cho thread của nó ⇒ invocation `CloseThread` cũng CHẾT.
//     Bài canh: `close_mixed_with_consume_close_side_fail`.
//   · Đóng NHIỀU thread trong một tx thì hợp lệ: mỗi invocation kiểm ĐÚNG NFT của input
//     mình (theo tên), nên không thread nào "mượn" lượt đốt của thread khác.
//
// KHÔNG ép `consumed_count` / `consumed_nanogic` ở trạng thái nào — có chủ ý. Đóng thread
// là quyền của chủ thread trên hồ sơ của CHÍNH MÌNH; ràng buộc "chỉ đóng được khi chưa
// tiêu gì" sẽ biến ADA của mọi thread đã dùng thành khoá chết, đúng thứ redeemer này sinh
// ra để gỡ. Hệ quả tư-cách biểu quyết đã khai ở docstring `CloseThread` (`types.ak`).
// ═══════════════════════════════════════════════════════════════
fn validate_close_thread(
  tx       : Transaction,
  own_hash : ByteArray,
  own_ref  : OutputReference,
  in_datum : EngageDatum,
) -> Bool {
  // ── (a) CHỮ KÝ CỦA CHÍNH CHỦ THREAD ──────────────────────────────────────────
  //    Vế DUY NHẤT về quyền trong cả đường đóng. Thiếu nó thì bất kỳ ai cũng đóng được
  //    thread của người khác: xoá hồ sơ tư-cách của họ và bỏ túi min-ADA.
  expect owner_authorized(tx, in_datum.owner)

  // ── (b) ĐÚNG NFT CỦA INPUT NÀY BỊ ĐỐT (−1) ───────────────────────────────────
  //    `thread_nft_name` fail-closed: input phải mang ĐÚNG 1 token dưới own_hash, qty 1.
  //    Rồi ép CHÍNH tên đó xuất hiện trong `tx.mint` với lượng −1 — không phải "có một
  //    lượt đốt nào đó", mà đúng lượt đốt của thread đang tiêu. Khác biệt này load-bearing
  //    ở tx đóng nhiều thread: nếu chỉ hỏi "có đốt gì đó" thì N thread dùng chung MỘT
  //    lượt đốt, N−1 NFT sống sót mà state của chúng đã biến mất.
  expect Some(own_input) =
    list.find(tx.inputs, fn(i) { i.output_reference == own_ref })
  let name = thread_nft_name(own_input.output.value, own_hash)
  expect assets.quantity_of(tx.mint, own_hash, name) == -1

  // ── (c) KHÔNG output nào ở địa chỉ engage còn mang NFT dưới own_hash ──────────
  //    Phòng thủ chiều sâu: (b) + bảo toàn value của ledger đã bảo đảm NFT vừa đốt
  //    không nằm ở output nào. Mệnh đề này mạnh hơn — nó cấm luôn MỌI NFT khác dưới
  //    own_hash đỗ lại địa chỉ engage trong tx đóng, nên nó là vế đóng chiều còn lại
  //    của ca trộn với `Consume` (xem khối trên) mà không phải đọc redeemer của ai.
  list.all(
    tx.outputs,
    fn(o) {
      if util.is_at_script(o.address, own_hash) {
        assets.tokens(o.value, own_hash) |> dict.is_empty
      } else {
        True
      }
    },
  )
}

// ═══════════════════════════════════════════════════════════════
// validate_burn_engage — handler MINT cho đường ĐỐT (redeemer constr 1)
//
// Vế DUY NHẤT: mọi lượng dưới policy này trong `tx.mint` đều ÂM. Không kiểm quyền —
// quyền do nhánh spend `CloseThread` giữ, và nó giữ được vì thread NFT chỉ sống ở địa
// chỉ script engage: đốt nó buộc phải tiêu UTxO đó, tức buộc phải chạy `CloseThread`.
//
// `expect !list.is_empty(...)` là vế fail-closed, không phải vế trang trí: một tx khai
// `BurnEngage` mà KHÔNG đốt gì dưới policy này sẽ thoả `list.all` trên list rỗng (chân
// lý rỗng) và PASS. Nó vô hại hôm nay, nhưng nó là một redeemer luôn-đúng — và một
// redeemer luôn-đúng là thứ mọi ràng buộc thêm vào sau sẽ vô tình đi vòng qua.
// ═══════════════════════════════════════════════════════════════
fn validate_burn_engage(policy_id: PolicyId, tx: Transaction) -> Bool {
  let own_tokens = assets.tokens(tx.mint, policy_id) |> dict.to_pairs
  expect !list.is_empty(own_tokens)
  list.all(
    own_tokens,
    fn(p) {
      let Pair(_name, qty) = p
      qty < 0
    },
  )
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
  //
  //    ── VÁ 2026-09-15 — ĐỊA CHỈ ĐẦY ĐỦ, KHÔNG CHỈ PAYMENT CREDENTIAL ──────────
  //    Bản cũ so `o.address.payment_credential == Script(policy_id)`, nên stake
  //    credential của output genesis do NGƯỜI DỰNG TX chọn tự do. Một sponsor dựng tx
  //    `MintEngage` hộ người dùng đặt được thread ở `Script(consume) + stake(sponsor)`:
  //    người dùng vẫn ký (cổng dưới chỉ đòi `ed.owner` ký) mà không soi địa chỉ, và
  //    thread sinh ra ở một địa chỉ bech32 KHÁC địa chỉ enterprise. Hai hậu quả:
  //    `lucid.utxosAt(consumeAddr)` không bao giờ thấy nó, và phần thưởng stake của
  //    min-ADA chảy về sponsor suốt đời thread.
  //
  //    Trước bản vá nhánh spend 2026-09-15 còn dời về được. Nay `out.address ==
  //    in.address` là bất biến ở CẢ HAI nhánh spend (`Consume` và `BindDID`) ⇒ địa chỉ
  //    lúc sinh là địa chỉ VĨNH VIỄN, và không có redeemer nào dời được.
  //
  //    VÁ Ở ĐÂY, KHÔNG Ở CỔNG SPEND. Spend là cổng RA của state đã nằm trên chuỗi;
  //    siết ở đó là khoá chết mọi thread đã sinh ra ngoài địa chỉ enterprise. Cùng lý
  //    lẽ với `did_len_ok` (xem docstring của nó): ràng buộc khuôn đặt ở chỗ GHI.
  let engage_addr =
    Address { payment_credential: Script(policy_id), stake_credential: None }
  let carriers =
    list.filter(
      tx.outputs,
      fn(o) {
        o.address == engage_addr && assets.quantity_of(
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
  // owner: credential mà người đúc THẬT SỰ kiểm soát (khoá ký, hoặc script gật qua mục
  // rút — `owner_authorized`) ⇒ không đúc
  // thread "nhân danh" ví nạn nhân để bơm attribution rác cho họ.
  expect owner_authorized(tx, ed.owner)
  // Hai trục kế toán PHẢI bắt đầu từ 0. `consumed_nanogic` là trục bị khai thác:
  // bất biến spend chỉ khoá DELTA nên gốc bịa 1e18 sẽ sống mãi trong state và mọi
  // app đọc "đã tiêu 1e18 nanogic" sẽ cấp dịch vụ miễn phí.
  expect ed.consumed_count == 0
  expect ed.consumed_nanogic == 0
  // last_epoch = state tích luỹ ("epoch consume gần nhất") ⇒ thread mới == 0.
  expect ed.last_epoch == 0
  // did_commit CỐ Ý KHÔNG pin NỘI DUNG: types.ak định nghĩa nó là commitment do
  // người tạo đặt lúc genesis, tức LỰA CHỌN của người dùng chứ không phải state tích
  // luỹ. Pin cứng về #"" sẽ khoá chết đường liên kết DID sinh trắc mà KHÔNG thêm chút
  // an toàn nào (nó không gate bất kỳ đường tiền nào).
  // NHƯNG ĐỘ DÀI thì pin: rỗng, hoặc đúng 32 byte. Đây là chỗ GHI, nên là chỗ đúng để
  // ép khuôn — mọi bên đọc sau đó khỏi phải tự đoán.
  expect did_len_ok(ed.did_commit)

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
        expect Consume { vault_ref, .. } =
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
  owner      : Credential,
) -> Bool {
  list.all(
    vault_refs,
    fn(vref) {
      expect Some(vault_in) =
        list.find(inputs, fn(i) { i.output_reference == vref })
      expect InlineDatum(vd) = vault_in.output.datum
      let Pair(_, fields) = builtin.un_constr_data(vd)
      expect [owner_data, ..] = fields
      // Trường 0 của MỌI loại vault là `Credential` (đổi 2026-09-26 cùng lúc ở ba
      // cửa gen). So `==` là so CẢ tag lẫn 28 byte: `VerificationKey(h)` ≠ `Script(h)`.
      expect vault_owner: Credential = owner_data
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

/// TÊN thread NFT (policy == own_hash) trên một UTxO — đòi ĐÚNG một token, qty 1.
/// Fail-closed cùng khuôn `single_thread_nft`; khác ở chỗ nó TRẢ VỀ cái tên, vì tên
/// mới là thứ ghép được input với output tương ứng.
fn thread_nft_name(value: Value, own_hash: ByteArray) -> AssetName {
  expect [Pair(name, qty)] = assets.tokens(value, own_hash) |> dict.to_pairs
  expect qty == 1
  name
}

/// Mọi output@engage: owner giữ, last_epoch=current, did_commit immutable, đúng 1 NFT.
/// Rồi GHÉP TỪNG CẶP input↔output theo TÊN thread NFT và ghim kế toán theo cặp.
/// Trả về `total_required` = Σ price(op_type_i)×op_count_i trên MỌI Engage input.
///
/// ── VÁ 2026-09-15 (NGHIÊM TRỌNG) — Σ giữ TỔNG, KHÔNG giữ PHÂN BỔ ─────────────
/// Bản cũ ép hai bất biến TỔNG:
///     Σ consumed_count(out)   == Σ(in) + Σ op_count
///     Σ consumed_nanogic(out) == Σ(in) + total_required
/// cùng với `#in == #out` và `single_thread_nft` trên mọi output. Ba thứ đó tưởng
/// đủ, nhưng thiếu đúng một bước: KHÔNG khớp tên tài sản của output với datum của
/// input tương ứng. Nên tín dụng DI CƯ được giữa hai thread cùng chủ:
///     thread B đã tích `consumed_nanogic = 10¹²`, thread A mới = 0; chủ tiêu cả hai
///     trong một tx, đốt đúng 2×10⁷ nanogic, rồi khai out(A) = 10¹² + 2×10⁷ và
///     out(B) = 0. Σ khớp TUYỆT ĐỐI, tx được chấp nhận. Ứng dụng đọc delta của
///     thread A thấy +1.000 MAGIC trong khi chỉ 0,02 MAGIC được trả — sai 5×10⁴ lần.
/// Vá: mỗi Engage input phải có ĐÚNG MỘT Engage output mang CHÍNH tên NFT đó, và
/// so datum THEO CẶP. Σ không còn là phép kiểm; nó chỉ còn là kết quả cộng dồn để
/// đối chiếu với Σburns của vault.
///
/// ── VÁ 2026-09-15 (CAO) — stake credential của output Engage ──────────────────
/// `util.is_at_script` chỉ so PAYMENT credential, và không mệnh đề nào ép
/// `out.address == in.address`. Một sponsor dựng tx hộ người dùng đặt được output
/// Engage ở CÙNG payment credential nhưng THÊM stake credential của mình: địa chỉ
/// bech32 đổi ⟹ `lucid.utxosAt(consumeAddr)` trả rỗng ⟹ thread cùng toàn bộ
/// `consumed_nanogic` đã tích rơi khỏi tầm nhìn của mọi công cụ tra theo địa chỉ.
/// Bản NGHIÊM trong chính kho này đã vá đúng chỗ đó cho beacon giá:
/// `price_param.ak` ▸ `expect beacon_out.address == beacon_in.address`. Làm y thế.
/// Neo vào ĐỊA CHỈ CỦA INPUT (không vào hằng): thread giữ nguyên địa chỉ nó sinh ra.
fn enforce_engagement(
  tx            : Transaction,
  own_hash      : ByteArray,
  owner         : Credential,
  did_commit    : ByteArray,
  current_epoch : Int,
  pp            : PriceParam,
  price_ref     : OutputReference,
) -> Int {
  // ── (A) Vòng trên TẬP OUTPUT ──────────────────────────────────────────────
  //    `single_thread_nft` ở đây là vế "mỗi output chỉ mang ĐÚNG một tên thread",
  //    điều kiện cần cho lập luận song ánh ở (B).
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

  // ── (B) Vòng GHÉP CẶP trên TẬP INPUT ──────────────────────────────────────
  list.foldl(
    tx.inputs,
    0,
    fn(inp, acc) {
      if util.is_at_script(inp.output.address, own_hash) {
        let name = thread_nft_name(inp.output.value, own_hash)
        // ĐÚNG MỘT output@engage mang chính tên thread này. Không có ⇒ thread bị
        // xoá sổ; hai cái ⇒ NFT bị nhân bản (đã bị value-preservation chặn).
        expect [out] =
          list.filter(
            tx.outputs,
            fn(o) {
              util.is_at_script(o.address, own_hash) && assets.quantity_of(
                o.value,
                own_hash,
                name,
              ) == 1
            },
          )
        // ĐỊA CHỈ ĐẦY ĐỦ, không chỉ payment credential (vá "stake credential tự do").
        expect out.address == inp.output.address
        // Value theo CẶP: chặn dồn ADA từ thread này sang thread khác của cùng chủ
        // (rút một thread xuống dưới min-ADA là khoá chết nó). Mệnh đề TỔNG
        // `engage_value_preserved` không thấy được phép dồn đó.
        expect out.value == inp.output.value
        expect InlineDatum(d_in) = inp.output.datum
        expect ed_in: EngageDatum = d_in
        expect InlineDatum(d_out) = out.datum
        expect ed_out: EngageDatum = d_out
        // `expect`, không `let`: redeemer của một Engage input khác có thể là
        // `BindDID`. Trộn BindDID vào một tx Consume ⇒ CHẾT ở đây (fail-closed) —
        // BindDID không mang op_type/op_count nên không có gì để tính giá.
        expect Consume { op_type, op_count, price_ref: pr_i, .. } =
          find_consume_redeemer(tx, inp.output_reference)
        expect op_count >= 1
        // Mọi Engage input PHẢI cùng beacon — không trộn nhiều bảng giá trong 1 tx.
        expect pr_i == price_ref
        expect Some(req_i) = pricing.required_for(pp, op_type, op_count)
        // Kế toán THEO CẶP. Hai trục song song, giữ nguyên lý do cũ: `count` không
        // phân biệt op rẻ / op đắt, nên một mình nó cho phép trả giá op rẻ mà app
        // đọc "+1 lượt" rồi cấp dịch vụ op đắt.
        expect ed_out.consumed_count == ed_in.consumed_count + op_count
        expect ed_out.consumed_nanogic == ed_in.consumed_nanogic + req_i
        acc + req_i
      } else {
        acc
      }
    },
  )
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

/// Danh sách chữ ký "giống tx thật" cho một chủ: khoá ⟹ [pkh]; script ⟹ [] (script
/// không ký, nó gật qua mục rút).
fn ct_sigs_of(owner: Credential) -> List<ByteArray> {
  when owner is {
    VerificationKey(pkh) -> [pkh]
    Script(_) -> []
  }
}
const ct_did: ByteArray = #""                        // did_commit rỗng = chưa gắn DID
/// did_commit ĐÚNG KHUÔN (32 byte). Viết thẳng ra hex vì `const` Aiken không gọi hàm.
/// 64 ký tự hex = 32 byte — đếm lại khi sửa: hằng hex LẺ ký tự làm `aiken check`
/// thoát 1 mà KHÔNG in dòng chẩn nào (BOUNDARIES.md §4).
const ct_did32: ByteArray =
  #"d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1"
/// did_commit ĐÚNG KHUÔN, giá trị KHÁC `ct_did32` (test "đã có did thì từ chối").
const ct_did32_b: ByteArray =
  #"c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2"

/// ByteArray đúng `n` byte (mọi byte 0xd1). Dùng cho ca BIÊN độ dài (31/33) — ở đó
/// điều đang đo là ĐỘ DÀI, không phải nội dung.
fn ct_bytes(n: Int) -> ByteArray {
  if n <= 0 {
    #""
  } else {
    builtin.cons_bytearray(0xd1, ct_bytes(n - 1))
  }
}
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
      // demand 1.0× ở cả hai dòng → price ảnh = 10_000_000
      OpPrice { op_type: 1, base_price: 10_000_000, demand_mult: 1_000_000_000 },  // ảnh 0.01 MAGIC
      OpPrice { op_type: 2, base_price: 1_000_000, demand_mult: 1_000_000_000 },    // CID 0.001 MAGIC
    ],
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
    owner: VerificationKey(ct_owner),
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

/// Tên thread THỨ HAI trong fixture.
///
/// Thread NFT là one-shot theo seed (`asset_name = blake2b_256(cbor.serialise(seed))`)
/// nên HAI thread KHÔNG BAO GIỜ trùng tên trên chuỗi. Fixture đa-thread dùng chung một
/// tên là đang đo một hình dạng giao dịch KHÔNG TỒN TẠI — và sau khi cổng ghép-cặp
/// (`enforce_engagement`) vào, nó còn chết ở đúng cổng đó thay vì ở bất biến mà test
/// mang tên. Mọi ca ≥2 Engage input phải cho mỗi thread một tên riêng.
const ct_thread_name_b: AssetName = #"454e4732"      // "ENG2"

/// Engage input mang thread NFT tên B (dùng cặp với `ct_engage_input`).
fn ct_engage_input_b(ref_ix: Int, consumed: Int) -> Input {
  ct_engage_input_named(ref_ix, consumed, ct_thread_name_b)
}

/// Continuing engage output cho thread tên TUỲ Ý.
fn ct_cont_output_named(
  name: AssetName, new_consumed: Int, new_epoch: Int, nft_qty: Int, nanogic: Int,
) -> Output {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, name, nft_qty)
  let d = ct_datum(new_consumed, new_epoch, nanogic, ct_did)
  util.mk_output(util.script_address(ct_eng_sh), v, d)
}

/// Continuing engage output cho thread tên B (delta mặc định = 1 ảnh).
fn ct_cont_output_b(new_consumed: Int, new_epoch: Int, nft_qty: Int) -> Output {
  ct_cont_output_named(ct_thread_name_b, new_consumed, new_epoch, nft_qty, ct_img_price)
}

/// Continuing engage output với did_commit tuỳ biến (test immutable).
fn ct_cont_output_did(new_consumed: Int, new_epoch: Int, did: ByteArray) -> Output {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, ct_thread_name, 1)
  let d = ct_datum(new_consumed, new_epoch, ct_img_price, did)
  util.mk_output(util.script_address(ct_eng_sh), v, d)
}

/// Vault input tại ct_vault_sh, THUỘC VỀ `ct_owner` (chủ thread trong fixture).
///
/// Bản cũ nhét datum Integer `0` và chỉ dùng được cho ca CÓ chữ ký — hợp lệ khi cổng
/// quyền ghi còn vế `||` ngắn mạch. Sau vá 2026-09-15 cổng đòi
/// `all_vault_owners_are` VÔ ĐIỀU KIỆN, nên mọi fixture vault phải mang datum ĐÚNG
/// hình dạng `Constr(_, [owner, ..])`. Datum Integer giờ là ca LỖI HÌNH DẠNG, không
/// còn là "datum không cần khớp".
fn ct_vault_input(ref_ix: Int) -> Input {
  ct_vault_input_owned(ref_ix, ct_owner)
}

/// Vault input mang datum ĐÚNG hình dạng: Constr(_, [owner, ..]) với owner tuỳ ý.
fn ct_vault_input_owned(ref_ix: Int, owner: ByteArray) -> Input {
  ct_vault_input_cred(ref_ix, VerificationKey(owner))
}

/// Như trên nhưng chủ vault là `Credential` tuỳ ý (khoá hoặc script).
fn ct_vault_input_cred(ref_ix: Int, owner: Credential) -> Input {
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
/// Chữ ký mặc định = chủ thread, chỉ để fixture giống tx thật. Nhánh `Consume` KHÔNG
/// đọc `extra_signatories` nữa; `run_sigs` tồn tại để ca sponsor dựng được danh sách
/// RỖNG và chứng minh đúng điều đó.
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
    own_ref, in_datum, ct_sigs_of(in_datum.owner),
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
  run_sigs_w(
    beacon, cur_epoch, engage_inputs, vault_inputs, outputs, redeemers, rd,
    own_ref, in_datum, sigs, [],
  )
}

/// Như `run_sigs` + danh sách mục rút (chủ `Script(h)` gật qua withdraw-zero).
fn run_sigs_w(
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
  wds           : Pairs<Credential, Int>,
) -> Bool {
  let tx =
    Transaction {
      ..placeholder,
      withdrawals: wds,
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
    owner: VerificationKey(ct_owner),
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

// ── Nợ #36: vault của NGƯỜI LẠ, chính người lạ đó ký → REJECT ────────────────
// Trước cổng #36, ca này PASS. Nghĩa là: kẻ tấn công tiêu MAGIC từ vault của CHÍNH
// MÌNH (nên `Σburns == required` vẫn khớp) mà ghi `consumed_count` /
// `consumed_nanogic` vào thread Engage của người khác. `consumed_*` là đầu vào C1
// của quyền biểu quyết, nên đó là đường mua phiếu bằng tiền — thứ hệ này cấm.
//
// 🔴 TÊN CŨ LÀ `consume_owner_not_signer_fail`, và nó HỨA SAI (đổi tên 2026-09-15).
// Sau khi cổng quyền ghi hạ xuống MỘT vế (`all_vault_owners_are` vô điều kiện), không
// còn phép so chữ ký nào trong nhánh `Consume`. Ca này đỏ vì `vault.owner == #"deadbeef"`
// KHÁC chủ thread — danh sách chữ ký của nó không đổi được kết quả. Tên cũ làm người đọc
// tin rằng chốt chữ ký đang được canh, trong khi chốt đó không tồn tại nữa.
test consume_foreign_vault_signed_by_vault_owner_fail() fail {
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

// Cùng hình dạng, danh sách chữ ký RỖNG — fail-closed, không phải "rỗng thì bỏ qua".
// Cặp với ca ngay trên: hai danh sách chữ ký khác nhau, CÙNG kết quả đỏ. Chính cặp đó
// là bằng chứng chốt đang đo CHỦ VAULT chứ không đo chữ ký.
// (Tên cũ `consume_no_signer_fail` — đổi 2026-09-15, cùng lý do ca trên.)
test consume_foreign_vault_no_signer_fail() fail {
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

// ── LỚP NÀY không đòi chữ ký nào của chủ thread ──────────────────────────────
// 🪦 Bài này từng mang tên đường SPONSOR (Paymaster/Feecover), nơi app là
// `personal_delegate` của vault người dùng và ký thay. Đường đó CHẾT 2026-09-16
// (Nợ #14) — cả ba vault nay chỉ nhận chữ ký chủ sở hữu ở `BurnBatch`.
//
// Bài vẫn giữ và vẫn có nghĩa, chỉ đổi nghĩa: nó đo rằng `consume.ak` KHÔNG tự
// dựng thêm một cổng chữ ký của riêng mình. MAGIC bị đốt là của chủ thread ⇒
// cổng #36 nhận. Chữ ký là việc của vault, và vault có cổng riêng đã siết.
// (Bản cũ của dòng này viết "vế 2 của cổng #36" — cổng nay chỉ còn MỘT vế, không đánh số.)
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
  let e1 = ct_engage_input_b(1, 10)
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
    [v0, v1], [ct_cont_output(11, 6, 1), ct_cont_output_b(11, 6, 1)], reds, rd0,
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
      op_prices: [OpPrice { op_type: 1, base_price: 10_000_000, demand_mult: 1_000_000_000 }, OpPrice { op_type: 2, base_price: -1, demand_mult: 1_000_000_000 }], m_min: 500_000_000, m_max: 2_000_000_000, epoch: 6,
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
  let e1 = ct_engage_input_b(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)   // cả 2 engage trỏ chung vault_ref
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])  // CHỈ 10M
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [e0, e1], [vault], [ct_cont_output(11, 6, 1), ct_cont_output_b(11, 6, 1)], reds, rd, er0, ct_in_datum)
}

// ── HAPPY 2-input ĐÚNG GIÁ: 2 Engage / 2 ops, vault burn ĐỦ tổng 20M, 2 output, Σstate +2.
//    Chứng minh batching hợp lệ vẫn chạy sau fix: total_required=20M == total_burned=20M.
test consume_two_engage_full_burn_happy() {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input_b(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])  // ĐỦ 2 ảnh
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  // Mỗi cặp: out = in + 1 lượt / +10M nanogic; Σburns 20M == total_required 20M.
  run(pp, 1, 6, [e0, e1], [vault], [ct_cont_output(11, 6, 1), ct_cont_output_b(11, 6, 1)], reds, rd, er0, ct_in_datum)
}

// ── HAPPY 2-input, 2 vault PHÂN BIỆT (mỗi engage 1 vault riêng, mỗi vault burn 10M).
//    total_required=20M, total_burned = 10M+10M (2 vault_ref distinct) = 20M → pass.
//
// 🔴 NHÃN (2026-09-15) — HÌNH DẠNG CHƯA TỚI ĐƯỢC, ĐỪNG ĐỌC THÀNH "HỢP LỆ".
//    Hai vault input trong một tx là hai input tại CÙNG payment credential, mà cả hai
//    loại vault đang phục vụ đều ép đúng MỘT input tại địa chỉ vault:
//    `InstantGen/onchain/validators/vault.ak` ▸ `validate_burn_batch` (`DS-1`) và
//    `ScheduleGen/onchain/validators/vault.ak` ▸ `C-VAULT-DS-1` (đặt ở đầu nhánh
//    `spend`, áp cho mọi redeemer). Ở đây vault chỉ là mock nên chốt đó không chạy.
//    Ca này giữ lại để bề rộng multi-vault của `distinct_vault_refs_over_engage_inputs`
//    / `sum_burns_over_vault_refs` / `all_vault_owners_are` không bị lượt dọn mã sau cắt
//    mất — nó canh MÃ, không chứng minh một tx như thế dựng được hôm nay.
test consume_two_engage_two_vault_happy() {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input_b(1, 10)
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
  run(pp, 1, 6, [e0, e1], [v0, v1], [ct_cont_output(11, 6, 1), ct_cont_output_b(11, 6, 1)], reds, rd0, er0, ct_in_datum)
}

// ── NEGATIVE: 2 Engage input, output-collapse (chỉ 1 output@engage) → #out!=#in ─
test consume_output_collapse_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input_b(1, 10)
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
  let e1 = ct_engage_input_b(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  // Burn ĐỦ 20M → test chạm ĐÚNG bất biến Σ NFT in == out (trước đây chết sớm ở giá).
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [e0, e1], [vault], [ct_cont_output(11, 6, 1), ct_cont_output_b(11, 6, 0)], reds, rd, er0, ct_in_datum)
}

// ── NEGATIVE: 2 Engage input, state under-count (1 output không tăng) → Σ sai ───
test consume_state_undercount_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input_b(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  // Burn ĐỦ 20M → test chạm ĐÚNG bất biến Σ consumed_count (trước đây chết sớm ở giá).
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  // Cặp thứ hai: in 10 + op 1 = 11 nhưng out khai 10 → lệch theo CẶP → fail.
  run(pp, 1, 6, [e0, e1], [vault], [ct_cont_output(11, 6, 1), ct_cont_output_b(10, 6, 1)], reds, rd, er0, ct_in_datum)
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
      // Chữ ký chủ thread — chỉ để fixture giống tx thật. Nhánh `Consume` KHÔNG đọc
      // `extra_signatories` nữa (cổng #36 hạ xuống một vế `all_vault_owners_are`
      // 2026-09-15); danh sách này không đổi được kết quả của ca nào ở đây.
      extra_signatories: ct_sigs_of(in_datum.owner),
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
  run_mint_w(inputs, mint_v, outputs, sigs, [])
}

fn run_mint_w(
  inputs  : List<Input>,
  mint_v  : Value,
  outputs : List<Output>,
  sigs    : List<ByteArray>,
  wds     : Pairs<Credential, Int>,
) -> Bool {
  let tx =
    Transaction {
      ..placeholder,
      inputs: inputs,
      mint: mint_v,
      outputs: outputs,
      extra_signatories: sigs,
      withdrawals: wds,
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

// ── ĐỊA CHỈ: CÙNG payment credential nhưng THÊM stake credential → REJECT ──────
//    (vá 2026-09-15) Sponsor dựng tx `MintEngage` hộ người dùng và đặt thread ở
//    `Script(consume) + stake(sponsor)`. Người dùng vẫn ký — cổng dưới chỉ đòi
//    `ed.owner` có trong `extra_signatories`, không đòi ai soi địa chỉ. Trước vá,
//    `payment_credential == Script(policy_id)` nhận hình dạng này, và thread sinh ra ở
//    một địa chỉ bech32 mà `lucid.utxosAt(consumeAddr)` không bao giờ trả về.
//
//    Ca này khác `engage_mint_clean_happy` ĐÚNG MỘT BIẾN: stake credential của output.
//    Cặp xanh/đỏ đó là thứ chứng minh cổng đang đo ĐỊA CHỈ ĐẦY ĐỦ, không đo cái khác.
test engage_mint_output_with_stake_credential_fail() fail {
  run_mint(
    [ct_seed_input()],
    assets.from_asset(ct_eng_sh, ct_seed_name(), 1),
    [
      ct_gen_out(
        util.script_address_staked(ct_eng_sh, #"beefbeef"), ct_seed_name(),
        ct_clean_genesis(), 0,
      ),
    ],
    [ct_owner],
  )
}

// Cùng hình dạng, stake credential là của CHÍNH chủ thread → VẪN REJECT.
//
// Không phải siết thừa: mint-gate không có cách nào biết một stake key có thuộc về
// `ed.owner` hay không (`owner` là payment credential — khoá hoặc script — còn stake
// credential là một credential KHÁC), nên
// "stake của chính chủ" là một lời tự khai, và một cổng nhận lời tự khai thì nhận luôn
// lời của sponsor. Quy tắc đọc được bằng một phép so: thread sinh ở địa chỉ ENTERPRISE.
test engage_mint_output_stake_credential_of_owner_fail() fail {
  run_mint(
    [ct_seed_input()],
    assets.from_asset(ct_eng_sh, ct_seed_name(), 1),
    [
      ct_gen_out(
        util.script_address_staked(ct_eng_sh, ct_owner), ct_seed_name(),
        ct_clean_genesis(), 0,
      ),
    ],
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
//    types.ak định nghĩa did_commit là commitment do người tạo đặt lúc genesis (rỗng
//    = chưa gắn, khác rỗng = blake2b256 liên kết DID). Đó là LỰA CHỌN, không phải
//    state tích luỹ. Test này khoá quyết định đó lại để lần sau không ai "siết nhầm".
//
//    🔴 ĐÍNH CHÍNH lý do, 2026-09-15 — kết luận GIỮ NGUYÊN, lập luận thì không.
//    Bản trước viết "pin cứng về #"" sẽ khoá chết đường DID mà không thêm an toàn
//    nào". Cả hai vế đều sai, và tệp này tự bác chúng:
//      · KHÔNG khoá chết — `validate_bind_did` đã là đúng cổng ghi-một-lần đó
//        (một lần · chữ ký chủ · khác rỗng · đúng 32 byte). Pin ở cổng đúc chỉ
//        buộc mọi người đi qua nó, tức thêm MỘT giao dịch mỗi người, không mất đường.
//      · CÓ thêm an toàn, chỉ là rất ít — đường đúc dựng lại đúng cái hại mà cổng
//        (2) của `validate_bind_did` sinh ra để chặn: người lạ mở thread mang
//        `owner` của nạn nhân với một DID do mình chọn, và vì ghi-một-lần nên nạn
//        nhân mất luôn đường gắn DID thật vào CHÍNH thread đó.
//    Vì sao vẫn giữ: thread engage KHÔNG có ràng buộc duy-nhất-theo-owner (đo bằng
//    `grep` trên tệp này: không mệnh đề nào ép một owner một thread), nên thread bị
//    chiếm chỗ là thread CHẾT — nạn nhân mở thread sạch của mình và dùng. Cái giá
//    của việc pin là một giao dịch bắt buộc cho mọi người dùng, vĩnh viễn.
//    Và đây là chỗ ConsumeMAGIC cố ý KHÁC PrepaidGen, không phải chỗ bị bỏ sót:
//    `prepaid_vault` pin `did_commit == #""` ở cổng đúc (2026-09-15) vì nó giữ CARP
//    khoá và tín dụng tích luỹ — người sở hữu buộc phải dùng ĐÚNG vault đó, nên một
//    giá trị sai ở genesis là hỏng không hoàn tác. Thread engage thì thay được.
//    Ai đọc hai module rồi thấy chúng lệch: lệch có chủ ý, lý do nằm ở đây.
//
//    ĐÃ ĐỔI GIÁ TRỊ (vá độ dài did_commit): bản cũ dùng `#"d1d1d1d1"` (4 byte) và
//    bản đó nay bị TỪ CHỐI — xem `engage_mint_did_len_4_fail`. Đây là ca "lật chính
//    sách thì đảo dấu kỳ vọng của phép kiểm cũ", không phải nới test cho xanh.
test engage_mint_did_commit_free_happy() {
  run_mint(
    [ct_seed_input()],
    assets.from_asset(ct_eng_sh, ct_seed_name(), 1),
    [
      ct_gen_out(
        util.script_address(ct_eng_sh), ct_seed_name(),
        ct_datum(0, 0, 0, ct_did32), 0,
      ),
    ],
    [ct_owner],
  )
}

// ══════════════════════════════════════════════════════════════
// VÁ 2026-09-07 — ĐỘ DÀI `did_commit` ở MỌI CHỖ GHI (mint genesis)
//   Trước vá: không ràng buộc nào. Một did_commit dài tuỳ ý vào được datum — phình
//   UTxO (min-ADA theo kích thước) và buộc mọi bên đọc tự đoán khuôn.
//   Sau vá: `length == 0 || length == 32`.
// ══════════════════════════════════════════════════════════════

/// Genesis mang did_commit độ dài tuỳ ý (dựng bằng `bytearray` để đúng số byte).
fn run_mint_did(did: ByteArray) -> Bool {
  run_mint(
    [ct_seed_input()],
    assets.from_asset(ct_eng_sh, ct_seed_name(), 1),
    [
      ct_gen_out(
        util.script_address(ct_eng_sh), ct_seed_name(), ct_datum(0, 0, 0, did), 0,
      ),
    ],
    [ct_owner],
  )
}

// 31 byte — SÁT DƯỚI khuôn. Ca biên: sai một byte vẫn phải chết.
test engage_mint_did_len_31_fail() fail {
  run_mint_did(ct_bytes(31))
}

// 33 byte — SÁT TRÊN khuôn.
test engage_mint_did_len_33_fail() fail {
  run_mint_did(ct_bytes(33))
}

// 4 byte — đúng giá trị mà bản cũ của `engage_mint_did_commit_free_happy` dùng.
test engage_mint_did_len_4_fail() fail {
  run_mint_did(#"d1d1d1d1")
}

// ĐỐI CHỨNG: rỗng (chưa gắn DID) vẫn là đường mở — đây là ca mặc định hôm nay.
test engage_mint_did_len_0_happy() {
  run_mint_did(#"")
}

// ĐỐI CHỨNG: đúng 32 byte đi qua.
test engage_mint_did_len_32_happy() {
  run_mint_did(ct_bytes(32))
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
//   còn có cái mà so. Trần tx Cardano KHÁC NHAU theo mạng — so với MAINNET, trần chặt
//   hơn: `maxTxExecutionUnits` mainnet 16,5 M mem / 10 G cpu, Preprod 17,5 M mem
//   (đo 2026-09-25, Koios `cli_protocol_params` của từng mạng). Bản trước ghi "14 M
//   mem" — số của đời tham số cũ, sai với cả hai mạng. Đừng chép số Preprod làm trần:
//   một tx vừa khít 17 M chạy được trên Preprod và chết trên mainnet.
// ══════════════════════════════════════════════════════════════

/// Bảng giá n dòng, op_type TĂNG NGẶT 1..n (dạng chuẩn tắc bắt buộc sau VÁ #C).
fn ct_ops(n: Int) -> List<OpPrice> {
  if n <= 0 {
    []
  } else {
    list.concat(
      ct_ops(n - 1),
      [OpPrice { op_type: n, base_price: 10_000_000, demand_mult: 1_000_000_000 }],
    )
  }
}

fn ct_pp_full(epoch: Int) -> PriceParam {
  PriceParam {
    op_prices: ct_ops(pricing.max_op_prices),
    m_min: 500_000_000,
    m_max: 2_000_000_000,
    epoch: epoch,
  }
}

test consume_worst_case_full_table_two_engage_happy() {
  // op_type = 16 (dòng CUỐI bảng → lookup_base duyệt hết list, xấu nhất).
  let pp = ct_pp_full(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input_b(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(pricing.max_op_prices, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [e0, e1], [vault], [ct_cont_output(11, 6, 1), ct_cont_output_b(11, 6, 1)], reds, rd, er0, ct_in_datum)
}

// Bài trên chỉ gọi `consume.spend` MỘT LẦN (own_ref = er0) dù tx dựng đủ hai Engage
// input — Aiken test gọi thẳng hàm validator theo `own_ref` mình truyền vào, KHÔNG
// tự lặp theo số input như Cardano thật (Cardano chạy validator một lần / redeemer
// Spend). Số đo của nó vì thế là fixture + MỘT invocation, không phải fixture + HAI —
// đọc nó như "ex-unit của một tx 2-Engage" là đọc THIẾU một lần gọi.
//
// Hai bài dưới đây tách hai vế: bài NÀY chỉ dựng fixture (không gọi `consume.spend`),
// bài KIA gọi đủ HAI lần (một lần mỗi Engage input, đúng số lần Cardano thật chạy).
// Per-tx THẬT (2 Engage) = số đo bài HAI-invocation trừ số đo bài fixture-only —
// ĐỪNG trừ cho bài `consume_worst_case_full_table_two_engage_happy` ở trên, vì nó
// thiếu đúng một lần invocation.
fn ct_fixture_full_table_two_engage() -> (Transaction, OutputReference, OutputReference, ConsumeRedeemer) {
  let pp = ct_pp_full(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input_b(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(pricing.max_op_prices, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  let beacon = ct_beacon_ref(pp, 1)
  let tx =
    Transaction {
      ..placeholder,
      inputs: list.concat([e0, e1], [vault]),
      reference_inputs: [beacon],
      outputs: [ct_cont_output(11, 6, 1), ct_cont_output_b(11, 6, 1)],
      redeemers: reds,
      extra_signatories: ct_sigs_of(ct_in_datum.owner),
      validity_range: interval.between(6 * ct_mspe, 6 * ct_mspe + 1),
    }
  (tx, er0, er1, rd)
}

/// CHỈ dựng fixture của kịch bản xấu nhất — không gọi `consume.spend`. Trả một Bool
/// PHỤ THUỘC dữ liệu vừa dựng (không phải `True` trơ) để trình biên dịch không rút
/// gọn phần dựng fixture thành hằng số rồi làm số đo mất nghĩa.
test probe_fixture_only_full_table_two_engage() {
  let (tx, er0, er1, _rd) = ct_fixture_full_table_two_engage()
  list.length(tx.inputs) == 3 && list.length(tx.redeemers) == 3 && er0 != er1
}

/// CÙNG fixture, gọi `consume.spend` HAI LẦN — một lần cho mỗi Engage input, đúng số
/// lần Cardano thật chạy validator trên một tx có hai Spend input cùng script. Đây là
/// số đo dùng để trừ ra chi phí PER-TX thật (xem chú thích trên `ct_fixture_full_table_two_engage`).
test probe_two_invocations_full_table_two_engage() {
  let (tx, er0, er1, rd) = ct_fixture_full_table_two_engage()
  let ok0 =
    consume.spend(
      ct_price_policy, ct_price_name, ct_vault_sh, ct_burn_constr, ct_max_stale,
      ct_mspe, ct_price_param_sh, Some(ct_in_datum), rd, er0, tx,
    )
  let ok1 =
    consume.spend(
      ct_price_policy, ct_price_name, ct_vault_sh, ct_burn_constr, ct_max_stale,
      ct_mspe, ct_price_param_sh, Some(ct_in_datum), rd, er1, tx,
    )
  ok0 && ok1
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

// ══════════════════════════════════════════════════════════════
// VÁ 2026-09-07 — redeemer `BindDID` (constr 1)
//
// Thread mở hôm nay có `did_commit` rỗng; nhánh `Consume` ép trường đó BẤT BIẾN.
// Không có đường ghi nào khác thì khi hệ bật `consumedFactor` (hệ số tư-cách đọc
// MAGIC đã tiêu, gắn theo PersonDID), mọi thread mở hôm nay nằm ngoài cơ chế đó
// VĨNH VIỄN. `BindDID` mở đúng một cửa: rỗng → 32 byte, một lần, có chữ ký chủ.
// ══════════════════════════════════════════════════════════════

/// Engage input với did_commit tuỳ biến (mặc định `ct_engage_input` dùng #"").
fn ct_engage_input_did(ref_ix: Int, consumed: Int, nanogic: Int, did: ByteArray) -> Input {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, ct_thread_name, 1)
  let d = ct_datum(consumed, 3, nanogic, did)
  util.mk_input(
    util.mk_ref_id(#"e1", ref_ix),
    util.mk_output(util.script_address(ct_eng_sh), v, d),
  )
}

/// Engage output đầy đủ tuỳ biến (mọi trường + value) — để bẻ TỪNG ràng buộc.
fn ct_bind_output(
  owner: ByteArray, consumed: Int, epoch: Int, did: ByteArray, nanogic: Int,
  lovelace: Int, nft_qty: Int,
) -> Output {
  let v = assets.add(assets.from_lovelace(lovelace), ct_eng_sh, ct_thread_name, nft_qty)
  let d = EngageDatum {
    owner: VerificationKey(owner),
    consumed_count: consumed,
    last_epoch: epoch,
    did_commit: did,
    consumed_nanogic: nanogic,
  }
  util.mk_output(util.script_address(ct_eng_sh), v, d)
}

/// Chạy nhánh spend với redeemer BindDID. KHÔNG beacon, KHÔNG vault, KHÔNG
/// validity_range — nhánh này không đọc giá và không refresh `last_epoch`, nên
/// `placeholder` (khoảng thời gian vô hạn) là đầu vào ĐÚNG, không phải chỗ đi tắt.
fn run_bind(
  inputs   : List<Input>,
  outputs  : List<Output>,
  sigs     : List<ByteArray>,
  own_ref  : OutputReference,
  in_datum : EngageDatum,
) -> Bool {
  run_bind_w(inputs, outputs, sigs, own_ref, in_datum, [])
}

fn run_bind_w(
  inputs   : List<Input>,
  outputs  : List<Output>,
  sigs     : List<ByteArray>,
  own_ref  : OutputReference,
  in_datum : EngageDatum,
  wds      : Pairs<Credential, Int>,
) -> Bool {
  let tx =
    Transaction {
      ..placeholder,
      inputs: inputs,
      outputs: outputs,
      extra_signatories: sigs,
      withdrawals: wds,
      redeemers: [Pair(Spend(own_ref), rd_as_data(BindDID))],
    }
  consume.spend(
    ct_price_policy, ct_price_name,
    ct_vault_sh, ct_burn_constr, ct_max_stale, ct_mspe, ct_price_param_sh,
    Some(in_datum), BindDID, own_ref, tx,
  )
}

/// Datum thread CHƯA gắn DID, đã tiêu 7 lượt / 70M nanogic ở epoch 3 — số khác 0 ở
/// mọi trục để ca "nhân tiện sửa trường khác" phân biệt được hai cực.
const ct_bind_in: EngageDatum =
  EngageDatum {
    owner: VerificationKey(ct_owner),
    consumed_count: 7,
    last_epoch: 3,
    did_commit: #"",
    consumed_nanogic: 70_000_000,
  }

// ── HAPPY: rỗng → 32 byte, chủ ký, mọi trường khác giữ nguyên ────────────────────
test bind_did_happy() {
  let eng = ct_engage_input_did(0, 7, 70_000_000, #"")
  let er = util.mk_ref_id(#"e1", 0)
  run_bind(
    [eng],
    [ct_bind_output(ct_owner, 7, 3, ct_did32, 70_000_000, 2_000_000, 1)],
    [ct_owner], er, ct_bind_in,
  )
}

// ── ĐÃ CÓ did → TỪ CHỐI (không đổi giá trị này sang giá trị khác) ────────────────
test bind_did_already_bound_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, ct_did32)
  let er = util.mk_ref_id(#"e1", 0)
  let in_d =
    EngageDatum { ..ct_bind_in, did_commit: ct_did32 }
  run_bind(
    [eng],
    [ct_bind_output(ct_owner, 7, 3, ct_did32_b, 70_000_000, 2_000_000, 1)],
    [ct_owner], er, in_d,
  )
}

// ── ĐÃ CÓ did, ghi lại CHÍNH giá trị đó → vẫn TỪ CHỐI ────────────────────────────
//    Không phải "vô hại nên cho qua": cổng (1) là thứ duy nhất giữ nghĩa MỘT LẦN,
//    nới nó ra cho ca no-op là mở lại đường ghi cho thread đã có danh tính.
test bind_did_rebind_same_value_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, ct_did32)
  let er = util.mk_ref_id(#"e1", 0)
  let in_d =
    EngageDatum { ..ct_bind_in, did_commit: ct_did32 }
  run_bind(
    [eng],
    [ct_bind_output(ct_owner, 7, 3, ct_did32, 70_000_000, 2_000_000, 1)],
    [ct_owner], er, in_d,
  )
}

// ── did RỖNG ở output (no-op "gắn") → TỪ CHỐI ────────────────────────────────────
test bind_did_output_empty_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, #"")
  let er = util.mk_ref_id(#"e1", 0)
  run_bind(
    [eng],
    [ct_bind_output(ct_owner, 7, 3, #"", 70_000_000, 2_000_000, 1)],
    [ct_owner], er, ct_bind_in,
  )
}

// ── THIẾU chữ ký owner (ví lạ ký) → TỪ CHỐI ──────────────────────────────────────
//    Ví khác CÓ ký, chỉ chủ thread là không ⇒ chứng minh cổng đòi ĐÚNG chữ ký của
//    chủ, không phải "có ai đó ký".
test bind_did_owner_not_signer_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, #"")
  let er = util.mk_ref_id(#"e1", 0)
  run_bind(
    [eng],
    [ct_bind_output(ct_owner, 7, 3, ct_did32, 70_000_000, 2_000_000, 1)],
    [#"deadbeef"], er, ct_bind_in,
  )
}

// ── KHÔNG chữ ký nào → TỪ CHỐI (danh sách rỗng không phải "bỏ qua") ─────────────
test bind_did_no_signer_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, #"")
  let er = util.mk_ref_id(#"e1", 0)
  run_bind(
    [eng],
    [ct_bind_output(ct_owner, 7, 3, ct_did32, 70_000_000, 2_000_000, 1)],
    [], er, ct_bind_in,
  )
}

// ── Vế `|| personal_delegate` KHÔNG áp ở đây: vault của chính chủ không thay được
//    chữ ký. Ca này dựng đúng hình dạng đường SPONSOR của nhánh Consume (vault input
//    thuộc chủ thread, chủ thread không ký) — nhánh BindDID vẫn phải TỪ CHỐI.
test bind_did_sponsor_path_rejected_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, #"")
  let vault = ct_vault_input_owned(0, ct_owner)
  let er = util.mk_ref_id(#"e1", 0)
  run_bind(
    [eng, vault],
    [ct_bind_output(ct_owner, 7, 3, ct_did32, 70_000_000, 2_000_000, 1)],
    [], er, ct_bind_in,
  )
}

// ── NHÂN TIỆN sửa `consumed_nanogic` → TỪ CHỐI ──────────────────────────────────
test bind_did_mutates_nanogic_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, #"")
  let er = util.mk_ref_id(#"e1", 0)
  run_bind(
    [eng],
    [ct_bind_output(ct_owner, 7, 3, ct_did32, 999_000_000, 2_000_000, 1)],
    [ct_owner], er, ct_bind_in,
  )
}

// ── NHÂN TIỆN sửa `consumed_count` → TỪ CHỐI ────────────────────────────────────
test bind_did_mutates_count_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, #"")
  let er = util.mk_ref_id(#"e1", 0)
  run_bind(
    [eng],
    [ct_bind_output(ct_owner, 99, 3, ct_did32, 70_000_000, 2_000_000, 1)],
    [ct_owner], er, ct_bind_in,
  )
}

// ── NHÂN TIỆN sửa `owner` (chiếm thread) → TỪ CHỐI ──────────────────────────────
test bind_did_mutates_owner_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, #"")
  let er = util.mk_ref_id(#"e1", 0)
  run_bind(
    [eng],
    [ct_bind_output(#"deadbeef", 7, 3, ct_did32, 70_000_000, 2_000_000, 1)],
    [ct_owner], er, ct_bind_in,
  )
}

// ── NHÂN TIỆN sửa `last_epoch` → TỪ CHỐI (BindDID không phải một lượt consume) ──
test bind_did_mutates_last_epoch_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, #"")
  let er = util.mk_ref_id(#"e1", 0)
  run_bind(
    [eng],
    [ct_bind_output(ct_owner, 7, 9, ct_did32, 70_000_000, 2_000_000, 1)],
    [ct_owner], er, ct_bind_in,
  )
}

// ── ĐỘ DÀI 31 byte → TỪ CHỐI (biên dưới) ────────────────────────────────────────
test bind_did_len_31_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, #"")
  let er = util.mk_ref_id(#"e1", 0)
  run_bind(
    [eng],
    [ct_bind_output(ct_owner, 7, 3, ct_bytes(31), 70_000_000, 2_000_000, 1)],
    [ct_owner], er, ct_bind_in,
  )
}

// ── ĐỘ DÀI 33 byte → TỪ CHỐI (biên trên) ────────────────────────────────────────
test bind_did_len_33_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, #"")
  let er = util.mk_ref_id(#"e1", 0)
  run_bind(
    [eng],
    [ct_bind_output(ct_owner, 7, 3, ct_bytes(33), 70_000_000, 2_000_000, 1)],
    [ct_owner], er, ct_bind_in,
  )
}

// ── RÚT ADA khỏi thread → TỪ CHỐI (value bảo toàn tuyệt đối) ───────────────────
test bind_did_drain_ada_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, #"")
  let er = util.mk_ref_id(#"e1", 0)
  run_bind(
    [eng],
    [ct_bind_output(ct_owner, 7, 3, ct_did32, 70_000_000, 1_000_000, 1)],
    [ct_owner], er, ct_bind_in,
  )
}

// ── RÚT thread NFT → TỪ CHỐI ────────────────────────────────────────────────────
test bind_did_drop_nft_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, #"")
  let er = util.mk_ref_id(#"e1", 0)
  run_bind(
    [eng],
    [ct_bind_output(ct_owner, 7, 3, ct_did32, 70_000_000, 2_000_000, 0)],
    [ct_owner], er, ct_bind_in,
  )
}

// ── KHÔNG output nào tại địa chỉ engage (đốt thread) → TỪ CHỐI ─────────────────
test bind_did_no_engage_output_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, #"")
  let er = util.mk_ref_id(#"e1", 0)
  let elsewhere =
    util.mk_output(
      util.vk_address(#"beef"),
      assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, ct_thread_name, 1),
      ct_datum(7, 3, 70_000_000, ct_did32),
    )
  run_bind([eng], [elsewhere], [ct_owner], er, ct_bind_in)
}

// ── TÁCH: 1 vào, 2 ra tại engage → TỪ CHỐI (#out != 1) ─────────────────────────
test bind_did_two_outputs_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, #"")
  let er = util.mk_ref_id(#"e1", 0)
  run_bind(
    [eng],
    [
      ct_bind_output(ct_owner, 7, 3, ct_did32, 70_000_000, 1_000_000, 1),
      ct_bind_output(ct_owner, 7, 3, ct_did32, 70_000_000, 1_000_000, 0),
    ],
    [ct_owner], er, ct_bind_in,
  )
}

// ── GỘP: 2 vào, 1 ra tại engage → TỪ CHỐI (#in != 1) ───────────────────────────
//    Không có ràng buộc này thì hai thread gộp làm một: một thread "chết" mà tài sản
//    định danh của nó đã dồn sang cái kia.
test bind_did_two_inputs_fail() fail {
  let e0 = ct_engage_input_did(0, 7, 70_000_000, #"")
  let e1 = ct_engage_input_did(1, 7, 70_000_000, #"")
  let er = util.mk_ref_id(#"e1", 0)
  let merged =
    util.mk_output(
      util.script_address(ct_eng_sh),
      assets.add(assets.from_lovelace(4_000_000), ct_eng_sh, ct_thread_name, 2),
      ct_datum(7, 3, 70_000_000, ct_did32),
    )
  run_bind([e0, e1], [merged], [ct_owner], er, ct_bind_in)
}

// ── output datum KHÔNG decode được EngageDatum → TỪ CHỐI ───────────────────────
test bind_did_output_bad_datum_fail() fail {
  let eng = ct_engage_input_did(0, 7, 70_000_000, #"")
  let er = util.mk_ref_id(#"e1", 0)
  let bad =
    util.mk_output(
      util.script_address(ct_eng_sh),
      assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, ct_thread_name, 1),
      0,
    )
  run_bind([eng], [bad], [ct_owner], er, ct_bind_in)
}

// ══════════════════════════════════════════════════════════════
// CHỈ SỐ CONSTRUCTOR = HỢP ĐỒNG NHỊ PHÂN
//   `Consume` phải ở constr 0 (đã lên chuỗi), `BindDID` ở constr 1, `CloseThread` ở
//   constr 2 (mỗi cái thêm ở CUỐI). Đảo thứ tự / chèn giữa là đổi cách decode ⇒ mọi tx
//   dựng theo chỉ số cũ vỡ. Gương off-chain: `tests/codec.test.ts` ghim đúng ba số này.
// ══════════════════════════════════════════════════════════════
test redeemer_constr_index_pinned() {
  let consume_d: Data = rd_as_data(ct_consume_redeemer(1, 1, util.mk_ref(0)))
  let Pair(ix_consume, fields_consume) = builtin.un_constr_data(consume_d)
  let bind_d: Data = rd_as_data(BindDID)
  let Pair(ix_bind, fields_bind) = builtin.un_constr_data(bind_d)
  let close_d: Data = rd_as_data(CloseThread)
  let Pair(ix_close, fields_close) = builtin.un_constr_data(close_d)
  and {
    ix_consume == 0,
    list.length(fields_consume) == 4,
    ix_bind == 1,
    list.length(fields_bind) == 0,
    ix_close == 2,
    list.length(fields_close) == 0,
  }
}

// ── Chỉ số constructor của redeemer MINT (EngageMintRedeemer) ─────────────────
//    `MintEngage` constr 0 (đã lên chuỗi), `BurnEngage` constr 1 (thêm ở CUỐI).
test mint_redeemer_constr_index_pinned() {
  let mint_d: Data = MintEngage { seed: ct_seed() }
  let Pair(ix_mint, fields_mint) = builtin.un_constr_data(mint_d)
  let burn_d: Data = BurnEngage
  let Pair(ix_burn, fields_burn) = builtin.un_constr_data(burn_d)
  and {
    ix_mint == 0,
    list.length(fields_mint) == 1,
    ix_burn == 1,
    list.length(fields_burn) == 0,
  }
}

// ── TRỘN BindDID vào một tx Consume → TỪ CHỐI ở CẢ HAI nhánh ───────────────────
//    Nhánh Consume (ca này): `expect Consume {..}` trong các hàm gộp gặp redeemer
//    BindDID của input kia và chết. Nếu ở đó còn là `let` thì mã không biên dịch,
//    nên ca này canh cả việc không ai đổi ngược lại thành một pattern-match câm.
test consume_mixed_with_bind_did_input_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input_b(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd0 = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds =
    [
      Pair(Spend(er0), rd_as_data(rd0)),
      Pair(Spend(er1), rd_as_data(BindDID)),
      Pair(Spend(vault_ref), burn_rd),
    ]
  run(
    pp, 1, 6, [e0, e1], [vault],
    [ct_cont_output(11, 6, 1), ct_cont_output_b(11, 6, 1)], reds, rd0, er0,
    ct_in_datum,
  )
}

// ── HAI CA DƯỚI ĐÂY SINH RA TỪ KIỂM ĐỘT BIẾN ───────────────────────────────────
//    Gỡ `#in@engage == 1` hoặc `single_thread_nft(out)` mà bộ kiểm VẪN XANH ⇒ hai
//    chốt đó chưa được ghim: các ca trước chết ở chốt HÀNG XÓM, đúng màu và đúng tên
//    nhưng không chứng minh gì cho chốt mang tên nó. Hai ca dưới đây phân biệt được
//    hai cực của đúng hai chốt ấy.

// ── #in@engage == 1: một thread THẬT + một UTxO GIẢ (không NFT) gộp làm một ────
//    Ai cũng gửi UTxO tới địa chỉ script được. UTxO giả không mang NFT, nên value
//    tổng vẫn bảo toàn khi gộp ADA của nó vào thread thật, output vẫn đúng 1 NFT,
//    #out vẫn == 1 — MỌI chốt khác đều thoả. Chỉ `#in == 1` chặn việc thread hút
//    ADA của một UTxO nằm cùng địa chỉ.
test bind_did_absorbs_fake_input_fail() fail {
  let real = ct_engage_input_did(0, 7, 70_000_000, #"")
  let fake =
    util.mk_input(
      util.mk_ref_id(#"e1", 1),
      util.mk_output(
        util.script_address(ct_eng_sh),
        assets.from_lovelace(2_000_000),      // KHÔNG thread NFT
        ct_datum(0, 0, 0, #""),
      ),
    )
  let er = util.mk_ref_id(#"e1", 0)
  // 4 ADA + 1 NFT = đúng tổng value vào; đúng 1 output; đúng 1 NFT trên nó.
  run_bind(
    [real, fake],
    [ct_bind_output(ct_owner, 7, 3, ct_did32, 70_000_000, 4_000_000, 1)],
    [ct_owner], er, ct_bind_in,
  )
}

// ── single_thread_nft(out): thread mang HAI NFT cùng policy đi qua BindDID ─────
//    Value bảo toàn (vào 2 NFT, ra 2 NFT), #in == #out == 1, mọi trường datum giữ
//    nguyên. Chỉ ràng buộc "ĐÚNG 1 NFT trên output" chặn. Hình dạng input này
//    không dựng được qua mint-gate hôm nay (nó ép 1 NFT / genesis), nên chốt này là
//    PHÒNG THỦ CHIỀU SÂU — và đúng vì thế nó cần một ca riêng, chứ ca "rút NFT"
//    chết ở value-preserved chứ không chết ở đây.
test bind_did_two_nfts_on_thread_fail() fail {
  let v =
    assets.add(
      assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, #"41", 1),
      ct_eng_sh, #"42", 1,
    )
  let inp =
    util.mk_input(
      util.mk_ref_id(#"e1", 0),
      util.mk_output(util.script_address(ct_eng_sh), v, ct_datum(7, 3, 70_000_000, #"")),
    )
  let out =
    util.mk_output(
      util.script_address(ct_eng_sh), v, ct_datum(7, 3, 70_000_000, ct_did32),
    )
  run_bind([inp], [out], [ct_owner], util.mk_ref_id(#"e1", 0), ct_bind_in)
}

// ══════════════════════════════════════════════════════════════
// VÁ 2026-09-15 — ba lỗ, mỗi lỗ một CẶP ca phân biệt được hai cực
//
// Mỗi cặp gồm một ca TẤN CÔNG (phải ĐỎ) và một ca HỢP LỆ sát ngay cạnh (phải XANH),
// khác nhau ĐÚNG MỘT biến. Một ca chỉ-đỏ không chứng minh chốt nào được ghim: nó có
// thể đang chết ở chốt kế tiếp mà vẫn đúng tên, đúng màu (`Forall` §Kỷ luật phát ngôn
// mục 6). Ca xanh nằm cạnh là thứ chứng minh phép vá không chặn bừa.
// ══════════════════════════════════════════════════════════════

/// Engage input với TÊN thread và `consumed_nanogic` tuỳ ý (ca đa-thread mà hai thread
/// mang mức tín dụng lệch nhau — đúng hình dạng mà lỗ "di cư tín dụng" khai thác).
fn ct_engage_input_ng(
  ref_ix: Int, name: AssetName, count: Int, nanogic: Int,
) -> Input {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, name, 1)
  let d = ct_datum(count, 0, nanogic, ct_did)
  util.mk_input(
    util.mk_ref_id(#"e1", ref_ix),
    util.mk_output(util.script_address(ct_eng_sh), v, d),
  )
}

/// Engage input đậu ở địa chỉ engage CÓ stake credential (payment credential vẫn là
/// `ct_eng_sh`). Đây là địa chỉ bech32 KHÁC với địa chỉ enterprise cùng hash.
fn ct_engage_input_staked(ref_ix: Int, consumed: Int, stake: ByteArray) -> Input {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, ct_thread_name, 1)
  let d = ct_datum(consumed, 0, 0, ct_did)
  util.mk_input(
    util.mk_ref_id(#"e1", ref_ix),
    util.mk_output(util.script_address_staked(ct_eng_sh, stake), v, d),
  )
}

/// Continuing engage output ở địa chỉ engage CÓ stake credential.
fn ct_cont_output_staked(
  new_consumed: Int, new_epoch: Int, stake: ByteArray,
) -> Output {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, ct_thread_name, 1)
  let d = ct_datum(new_consumed, new_epoch, ct_img_price, ct_did)
  util.mk_output(util.script_address_staked(ct_eng_sh, stake), v, d)
}

// ── LỖ 1: cổng hai vế `||` ngắn mạch ────────────────────────────────────────────
//
// TẤN CÔNG: A tiêu thread CỦA CHÍNH A, nhưng vault trong tx là của người khác
// (`#"beef"`). A ký. Trước vá, vế `list.has(extra_signatories, owner)` ngắn mạch nên
// `all_vault_owners_are` KHÔNG BAO GIỜ chạy ⇒ tx được chấp nhận ⇒ MAGIC của nạn nhân
// bị đốt còn `consumed_nanogic` của A tăng đúng bằng số đó. Sau vá: ĐỎ.
//
// Ca này khác `consume_happy` ĐÚNG MỘT BIẾN: chủ của vault. `consume_happy` xanh,
// ca này đỏ ⇒ chốt đang đo đúng đại lượng "vault thuộc về ai", không đo cái khác.
test consume_foreign_vault_with_owner_signature_rejected() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input_owned(0, #"beef")
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// Cùng tx, chỉ BỎ chữ ký chủ thread ⇒ trước vá cũng đã đỏ (vế 2 chạy). Giữ lại làm
// đối chứng: nó cho thấy ca trên đỏ VÌ chủ vault, không vì thiếu/thừa chữ ký.
test consume_foreign_vault_no_signature_rejected() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input_owned(0, #"beef")
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run_sigs(
    ct_beacon_ref(pp, 1), 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd,
    eng_ref, ct_in_datum, [],
  )
}

// ── LỖ 2: bất biến Σ không ghim cặp NFT ↔ datum ─────────────────────────────────
//
// TẤN CÔNG (DI CƯ TÍN DỤNG): thread B đã tích `consumed_nanogic = 10¹²`, thread A mới
// = 0. Cùng chủ, cùng tx, đốt đúng 2×10⁷ nanogic. Khai out(A) = 10¹² + 2×10⁷ và
// out(B) = 0. Σ nanogic khớp TUYỆT ĐỐI, Σ count khớp tuyệt đối. Trước vá: XANH.
// Ứng dụng đọc delta của thread A thấy +1.000 MAGIC trong khi 0,02 MAGIC được trả.
test consume_nanogic_migrate_between_threads_rejected() fail {
  let pp = ct_pp(6)
  let a = ct_engage_input_ng(0, ct_thread_name, 10, 0)
  let b = ct_engage_input_ng(1, ct_thread_name_b, 10, 1_000_000_000_000)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [
      Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)),
      Pair(Spend(vault_ref), burn_rd),
    ]
  run(
    pp, 1, 6, [a, b], [vault],
    [
      ct_cont_output_named(ct_thread_name, 22, 6, 1, 1_000_020_000_000),
      ct_cont_output_named(ct_thread_name_b, 0, 6, 1, 0),
    ],
    reds, rd, er0, ct_datum(10, 0, 0, ct_did),
  )
}

// HỢP LỆ, sát ngay cạnh: CÙNG hai thread, CÙNG số đốt, chỉ khác PHÂN BỔ — mỗi thread
// nhận đúng phần của mình (+1 lượt, +10M nanogic). Σ y hệt ca trên. Ca này XANH là
// thứ chứng minh chốt mới đo PHÂN BỔ chứ không phải đo TỔNG (nếu nó đo tổng thì hai
// ca này không phân biệt được, vì tổng của chúng bằng nhau từng đơn vị).
test consume_nanogic_paired_allocation_ok() {
  let pp = ct_pp(6)
  let a = ct_engage_input_ng(0, ct_thread_name, 10, 0)
  let b = ct_engage_input_ng(1, ct_thread_name_b, 10, 1_000_000_000_000)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [
      Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)),
      Pair(Spend(vault_ref), burn_rd),
    ]
  run(
    pp, 1, 6, [a, b], [vault],
    [
      ct_cont_output_named(ct_thread_name, 11, 6, 1, 10_000_000),
      ct_cont_output_named(ct_thread_name_b, 11, 6, 1, 1_000_010_000_000),
    ],
    reds, rd, er0, ct_datum(10, 0, 0, ct_did),
  )
}

// Đối chứng Σ: cùng hình dạng DI CƯ nhưng Σ lệch 1 đơn vị. Đỏ cả trước lẫn sau vá.
// Giữ lại để phép so tổng của vault (`Σburns == required`) không bị bản vá làm lỏng.
test consume_nanogic_migrate_sum_off_by_one_rejected() fail {
  let pp = ct_pp(6)
  let a = ct_engage_input_ng(0, ct_thread_name, 10, 0)
  let b = ct_engage_input_ng(1, ct_thread_name_b, 10, 1_000_000_000_000)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [
      Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)),
      Pair(Spend(vault_ref), burn_rd),
    ]
  run(
    pp, 1, 6, [a, b], [vault],
    [
      ct_cont_output_named(ct_thread_name, 22, 6, 1, 1_000_020_000_001),
      ct_cont_output_named(ct_thread_name_b, 0, 6, 1, 0),
    ],
    reds, rd, er0, ct_datum(10, 0, 0, ct_did),
  )
}

// ── LỖ 3: stake credential của output Engage tự do ──────────────────────────────
//
// TẤN CÔNG: input đậu ở địa chỉ engage ENTERPRISE, output vẫn ở CÙNG payment
// credential nhưng GẮN THÊM stake credential của người dựng tx. `is_at_script` chỉ so
// payment credential nên trước vá tx được chấp nhận; địa chỉ bech32 đổi ⟹
// `lucid.utxosAt(consumeAddr)` trả rỗng ⟹ thread cùng toàn bộ `consumed_nanogic` đã
// tích rơi khỏi tầm nhìn của mọi công cụ tra theo địa chỉ.
test consume_engage_output_stake_credential_added_rejected() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(
    pp, 1, 6, [eng], [vault], [ct_cont_output_staked(11, 6, #"beefbeef")], reds, rd,
    eng_ref, ct_in_datum,
  )
}

// HỢP LỆ, sát ngay cạnh: thread đậu ở một địa chỉ CÓ stake credential thì nó GIỮ đúng
// địa chỉ đó. Khác ca trên đúng một biến — địa chỉ của INPUT.
//
// Đây là ca chặn bản vá quá tay Ở NHÁNH SPEND: chốt đúng tại đây là "ĐỊA CHỈ BẢO TOÀN",
// KHÔNG phải "cấm stake credential". Ép `stake_credential == None` ở nhánh spend sẽ
// giết ca này VÀ khoá chết mọi thread đã nằm trên chuỗi ở một địa chỉ như thế — siết ở
// cổng RA là sai chỗ, cùng lý lẽ với `did_len_ok`.
//
// 🔴 NHÃN (2026-09-15): hình dạng này nay là hình dạng CHƯA/KHÔNG TỚI ĐƯỢC. Chính sách
// đã được quyết Ở CỔNG VÀO: `validate_mint_engage_id` ép output genesis nằm đúng địa chỉ
// ENTERPRISE (`stake_credential: None`), nên không thread nào còn SINH RA ở địa chỉ có
// stake credential. Ca này giữ lại đúng một việc — canh cho nhánh spend khỏi bị siết
// nhầm thành "cấm stake credential" — chứ KHÔNG phải bằng chứng rằng đúc được một thread
// như thế. Đừng đọc nó theo nghĩa thứ hai.
test consume_engage_staked_address_preserved_ok() {
  let pp = ct_pp(6)
  let eng = ct_engage_input_staked(0, 10, #"beefbeef")
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(
    pp, 1, 6, [eng], [vault], [ct_cont_output_staked(11, 6, #"beefbeef")], reds, rd,
    eng_ref, ct_in_datum,
  )
}

// Và chiều ngược lại: thread đang đậu ở địa chỉ CÓ stake credential mà output GỠ nó ra
// (về địa chỉ enterprise) cũng phải ĐỎ. Bảo toàn là bảo toàn HAI CHIỀU — chỉ canh
// chiều "thêm vào" thì một sponsor vẫn đổi được địa chỉ của thread người khác.
test consume_engage_stake_credential_removed_rejected() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input_staked(0, 10, #"beefbeef")
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// Đối chứng: đổi hẳn PAYMENT credential. Đỏ cả trước lẫn sau vá (chết ở
// `n_in == n_out`), nên nó KHÔNG chứng minh gì về stake credential — giữ lại đúng vì
// lý do đó: nó là cái mà một bộ kiểm "đã canh chỗ này" dễ nhầm là đủ.
test consume_engage_output_payment_credential_moved_rejected() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  let moved =
    util.mk_output(
      util.script_address(#"eeee"),
      assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, ct_thread_name, 1),
      ct_datum(11, 6, ct_img_price, ct_did),
    )
  run(pp, 1, 6, [eng], [vault], [moved], reds, rd, eng_ref, ct_in_datum)
}

// ── LỖ 3 ở nhánh BindDID — CÙNG lỗ, KHÁC tệp con ────────────────────────────────
// `validate_bind_did` cũng định vị output bằng `is_at_script` (payment credential),
// nên nó mang y nguyên lỗ trên. Quét anh em trước khi đóng đợt vá: một đợt vá lấy
// phạm vi bằng phạm vi của TRIỆU CHỨNG là đợt vá để lại nguyên nguyên nhân.
test bind_did_output_stake_credential_added_rejected() fail {
  let inp =
    util.mk_input(
      util.mk_ref_id(#"e1", 0),
      util.mk_output(
        util.script_address(ct_eng_sh),
        assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, ct_thread_name, 1),
        ct_datum(7, 3, 70_000_000, #""),
      ),
    )
  let out =
    util.mk_output(
      util.script_address_staked(ct_eng_sh, #"beefbeef"),
      assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, ct_thread_name, 1),
      ct_datum(7, 3, 70_000_000, ct_did32),
    )
  run_bind([inp], [out], [ct_owner], util.mk_ref_id(#"e1", 0), ct_bind_in)
}

// HỢP LỆ sát cạnh: thread đậu sẵn ở địa chỉ có stake credential, output GIỮ nguyên.
// Cùng NHÃN với `consume_engage_staked_address_preserved_ok`: sau khi mint-gate ghim
// địa chỉ enterprise, hình dạng "thread đậu ở địa chỉ có stake credential" KHÔNG tới
// được nữa. Ca này canh chiều siết-quá-tay của nhánh BindDID, không chứng minh gì về
// tính hợp lệ của hình dạng đó.
test bind_did_staked_address_preserved_ok() {
  let addr = util.script_address_staked(ct_eng_sh, #"beefbeef")
  let v = assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, ct_thread_name, 1)
  let inp =
    util.mk_input(
      util.mk_ref_id(#"e1", 0),
      util.mk_output(addr, v, ct_datum(7, 3, 70_000_000, #"")),
    )
  let out = util.mk_output(addr, v, ct_datum(7, 3, 70_000_000, ct_did32))
  run_bind([inp], [out], [ct_owner], util.mk_ref_id(#"e1", 0), ct_bind_in)
}

// ── LỖ 2, mặt thứ hai: Σ value giữ TỔNG, cũng không giữ PHÂN BỔ ─────────────────
//
// `engage_value_preserved` so TỔNG value vào/ra tại địa chỉ engage, nên nó KHÔNG thấy
// được phép DỒN ADA từ thread này sang thread khác của cùng chủ. Hại không phải mất
// tiền — cả hai thread cùng một chủ — mà là KHOÁ CHẾT: rút một thread xuống dưới
// min-ADA là biến nó thành UTxO không tiêu được, và `lamp`/`consumed_nanogic` đã tích
// trong đó đứng im vĩnh viễn. Chốt canh là `out.value == in.value` THEO CẶP.
//
// Đối cực XANH nằm sẵn: `consume_value_preserved_happy` (100 ADA + 5 TOK vào, y thế
// ra) và `consume_two_engage_full_burn_happy`. Ca này khác chúng đúng một biến: output
// nào nhận phần ADA nào.
test consume_ada_shuffled_between_threads_rejected() fail {
  let pp = ct_pp(6)
  let a =
    util.mk_input(
      util.mk_ref_id(#"e1", 0),
      util.mk_output(
        util.script_address(ct_eng_sh),
        assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, ct_thread_name, 1),
        ct_datum(10, 0, 0, ct_did),
      ),
    )
  let b =
    util.mk_input(
      util.mk_ref_id(#"e1", 1),
      util.mk_output(
        util.script_address(ct_eng_sh),
        assets.add(assets.from_lovelace(100_000_000), ct_eng_sh, ct_thread_name_b, 1),
        ct_datum(10, 0, 0, ct_did),
      ),
    )
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [
      Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)),
      Pair(Spend(vault_ref), burn_rd),
    ]
  // ADA đảo chỗ: A nhận 100 ADA, B còn 2 ADA. Σ value vào == Σ value ra TUYỆT ĐỐI.
  let out_a =
    util.mk_output(
      util.script_address(ct_eng_sh),
      assets.add(assets.from_lovelace(100_000_000), ct_eng_sh, ct_thread_name, 1),
      ct_datum(11, 6, ct_img_price, ct_did),
    )
  let out_b =
    util.mk_output(
      util.script_address(ct_eng_sh),
      assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, ct_thread_name_b, 1),
      ct_datum(11, 6, ct_img_price, ct_did),
    )
  run(pp, 1, 6, [a, b], [vault], [out_a, out_b], reds, rd, er0, ct_datum(10, 0, 0, ct_did))
}

// ══════════════════════════════════════════════════════════════
// SÁU CHỐT KHÔNG CÓ NGƯỜI CANH — bài âm tính riêng cho từng chốt (2026-09-15)
//
// Nguồn: một lượt gỡ-chốt (thay từng chốt bằng `True`, chạy trọn bộ, đếm bài lật) trên
// bản 148/148 cho thấy SÁU chốt gỡ ra mà bộ kiểm vẫn XANH. "Có bài đỏ ở chốt X" KHÔNG
// phải "chốt X được ghim" (`Forall` §Kỷ luật phát ngôn mục 6), nên mỗi chốt dưới đây
// nhận một ca riêng, dựng để CHẾT ĐÚNG DÒNG MANG TÊN NÓ.
//
// 🔴 ĐỌC TRƯỚC KHI DỌN MÃ: hai trong sáu chốt (`single_thread_nft` phía OUTPUT và
// `n_in == n_out`) gỡ ra thì ca dưới đây VẪN ĐỎ — chúng che nhau. Số đo + phân tích ghi
// ở ngay trên từng ca. Đừng đọc "ca vẫn đỏ" thành "chốt thừa": gỡ CẢ HAI thì ca xanh.
//
// HAI CA DÙNG HÌNH DẠNG HAI THREAD TRÙNG TÊN, cố ý, ngược với cảnh báo ở
// `ct_thread_name_b`. Cảnh báo đó nói: fixture đa-thread dùng chung một tên đang đo một
// hình dạng KHÔNG TỒN TẠI trên chuỗi (tên thread = `blake2b_256(cbor(seed))`, one-shot).
// Đúng — và đó CHÍNH LÀ điều hai chốt này bảo vệ: chúng là lớp thứ hai cho ngày tính
// one-shot bị làm hở. Ca đo một lớp phòng thủ chiều sâu buộc phải dựng cái hình dạng mà
// lớp thứ nhất đang cấm; nếu không thì lớp thứ hai không có cách nào được đo.
// ══════════════════════════════════════════════════════════════

/// Continuing output với `owner` TUỲ Ý (mọi trường khác đúng khuôn một lượt consume).
fn ct_cont_output_owner(owner: Credential, new_consumed: Int, new_epoch: Int) -> Output {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, ct_thread_name, 1)
  let d =
    EngageDatum {
      owner: owner,
      consumed_count: new_consumed,
      last_epoch: new_epoch,
      did_commit: ct_did,
      consumed_nanogic: ct_img_price,
    }
  util.mk_output(util.script_address(ct_eng_sh), v, d)
}

/// Output tại địa chỉ engage mang HAI thread NFT (gộp hai thread vào một UTxO).
fn ct_cont_output_two_threads(lovelace: Int) -> Output {
  let v0 = assets.add(assets.from_lovelace(lovelace), ct_eng_sh, ct_thread_name, 1)
  let v = assets.add(v0, ct_eng_sh, ct_thread_name_b, 1)
  util.mk_output(util.script_address(ct_eng_sh), v, ct_datum(11, 6, ct_img_price, ct_did))
}

/// Output tại địa chỉ engage KHÔNG mang thread NFT nào (datum vẫn đúng khuôn).
fn ct_cont_output_no_thread(lovelace: Int) -> Output {
  util.mk_output(
    util.script_address(ct_eng_sh),
    assets.from_lovelace(lovelace),
    ct_datum(11, 6, ct_img_price, ct_did),
  )
}

/// Output tại địa chỉ engage với value RỖNG TUYỆT ĐỐI — không ADA, không token.
/// Ledger thật không nhận (min-UTxO), nhưng `Transaction` mock thì nhận, và đó đúng là
/// hình dạng cần để cô lập `n_in == n_out` khỏi `engage_value_preserved`.
fn ct_engage_output_zero_value() -> Output {
  util.mk_output(
    util.script_address(ct_eng_sh),
    assets.zero,
    ct_datum(11, 6, ct_img_price, ct_did),
  )
}

/// Redeemer Consume với `price_ref` TUỲ Ý (ca trộn hai beacon giá trong một tx).
fn ct_consume_redeemer_priced(
  op_type: Int, op_count: Int, vault_ref: OutputReference, price_ref: OutputReference,
) -> ConsumeRedeemer {
  Consume { op_type, op_count, price_ref, vault_ref }
}

// ── CHỐT 1/6 — `od.owner == owner` trong `enforce_engagement` (A) ───────────────
//
// NẶNG NHẤT trong sáu. Chủ thread O tiêu thread CỦA CHÍNH MÌNH — mọi thứ khác hợp lệ,
// MAGIC đốt là của O, chữ ký là của O — rồi khai `out.owner = X`. Từ giây đó X sở hữu
// thread cùng TOÀN BỘ `consumed_nanogic` đã tích. Đó là CHUYỂN NHƯỢNG HỒ SƠ TIÊU MAGIC:
// `BOUNDARIES.md §1` khai MAGIC không chuyển nhượng, `INV-MAGIC-CITIZEN` gắn thưởng vào
// MAGIC ĐÃ TIÊU, và `consumed_*` là đầu vào C1 của quyền biểu quyết. Bán một thread đã
// tích là bán đúng cái phiếu mà hệ cấm bán.
//
// Không chốt nào khác nhìn trường này: (B) chỉ so `consumed_count`/`consumed_nanogic`
// theo cặp, còn `all_vault_owners_are` đọc `in_datum.owner`. Đối cực XANH: `consume_happy`
// — khác ca này ĐÚNG MỘT BIẾN, `owner` của output.
test consume_output_rotates_owner_to_stranger_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(
    pp, 1, 6, [eng], [vault], [ct_cont_output_owner(VerificationKey(#"deadbeef"), 11, 6)], reds, rd,
    eng_ref, ct_in_datum,
  )
}

// ── CHỐT 2/6 — `single_thread_nft(o.value, own_hash)` phía OUTPUT ───────────────
//
// Hai Engage input (tên X, tên Y); output thứ nhất GỘP cả hai NFT, output thứ hai giữ
// phần ADA còn lại và KHÔNG mang NFT nào. Σ value tại engage khớp tuyệt đối, `n_in ==
// n_out` khớp — ca đi qua hai chốt đứng trước rồi chết tại chốt này.
//
// 🔴 SỐ ĐO, ĐỪNG SUY: gỡ chốt này thì ca VẪN ĐỎ — nó trôi xuống `out.value ==
// inp.output.value` (phép so value THEO CẶP, vá 2026-09-15). Lý do là một chứng minh,
// không phải một quan sát: phép so theo cặp + `expect [out]` + cổng định danh phía input
// làm phép ghép input↔output ĐƠN ÁNH, và `n_in == n_out` nâng nó lên SONG ÁNH, nên mọi
// output@engage là ảnh của đúng một input ⇒ mang đúng một NFT. Tức chốt này bị bao trọn
// VỀ LOGIC bởi bộ chốt hiện có. Giữ lại vì nó rẻ và vì nó là vế đứng trước trong lập luận
// song ánh đó — nhưng ai dọn mã phải biết mình đang gỡ một lớp DƯ, không phải một lớp
// CHẾT: gỡ nó CÙNG LÚC với `n_in == n_out` thì `consume_extra_engage_output_no_input_fail`
// ngay dưới chuyển sang XANH.
//
// ĐO 2026-09-15 (nền 156/156, gỡ = thay bằng `True`, chạy trọn bộ):
//   gỡ MỘT MÌNH chốt này                      → 0 bài lật
//   gỡ chốt này + `out.value == inp.output.value` → 3 bài lật, gồm CHÍNH ca này
//   gỡ chốt này + `n_in == n_out`             → 1 bài lật (ca của chốt 4/6)
test consume_output_merges_two_threads_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input_b(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)),
     Pair(Spend(vault_ref), burn_rd)]
  run(
    pp, 1, 6, [e0, e1], [vault],
    [ct_cont_output_two_threads(2_000_000), ct_cont_output_no_thread(2_000_000)],
    reds, rd, er0, ct_in_datum,
  )
}

// ── CHỐT 3/6 — `expect engage_value_preserved(tx, own_hash)` ────────────────────
//
// Đây là chốt mà chú thích tại chỗ gọi nó tự khai: "Bỏ dòng này là bỏ luôn lập luận song
// ánh". Ca dưới đây dựng đúng hình dạng mà nó một mình chặn: HAI Engage input mang CÙNG
// một tên thread. Cả hai ghép về cùng một output (phép lọc theo tên chỉ thấy một cái),
// nên `expect [out]` im, `out.value == in.value` im, kế toán theo cặp im — chỉ Σ value
// nhìn thấy `X:2` vào mà `X:1` ra.
//
// Hình dạng này không tồn tại chừng nào tên thread còn là `blake2b_256(cbor(seed))`
// one-shot; xem khối chú thích đầu mục. Chốt này là LỚP THỨ HAI cho ngày đó, và ca này
// là cách duy nhất đo được lớp thứ hai.
test consume_duplicate_thread_name_value_sum_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input_named(0, 10, ct_thread_name)
  let e1 = ct_engage_input_named(1, 10, ct_thread_name)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)),
     Pair(Spend(vault_ref), burn_rd)]
  // Ra: một thread tên X + một thread tên B — B chưa từng vào. Σ vào có X:2, Σ ra có X:1.
  run(
    pp, 1, 6, [e0, e1], [vault],
    [
      ct_cont_output_named(ct_thread_name, 11, 6, 1, ct_img_price),
      ct_cont_output_named(ct_thread_name_b, 11, 6, 1, ct_img_price),
    ],
    reds, rd, er0, ct_in_datum,
  )
}

// ── CHỐT 4/6 — `expect n_in == n_out` ──────────────────────────────────────────
//
// Một Engage input, HAI output tại địa chỉ engage: cái thứ hai không có input đối ứng.
// Để cô lập đúng chốt này, output thừa mang value RỖNG — nhờ vậy Σ value tại engage vẫn
// khớp tuyệt đối và `engage_value_preserved` (chốt đứng ngay sau) không cắn trước.
//
// 🔴 SỐ ĐO: gỡ chốt này thì ca VẪN ĐỎ — nó trôi xuống `single_thread_nft` phía output
// (chốt 2/6), vì output rỗng không mang NFT nào. Hai chốt CHE NHAU: gỡ một cái thì cái
// kia bắt, gỡ cả hai thì ca xanh. Đó là lý do cả hai ở lại, và là lý do ca này đứng ngay
// dưới ca của chốt 2/6 — ai gỡ một trong hai phải đọc cả cặp.
//
// ĐO 2026-09-15 (nền 156/156): gỡ MỘT MÌNH `n_in == n_out` → 0 bài lật; gỡ nó CÙNG
// `single_thread_nft` phía output → 1 bài lật, đúng ca này.
test consume_extra_engage_output_no_input_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(
    pp, 1, 6, [eng], [vault],
    [ct_cont_output(11, 6, 1), ct_engage_output_zero_value()],
    reds, rd, eng_ref, ct_in_datum,
  )
}

// ── CHỐT 5/6 — `expect [out]` (phép lọc trả về ĐÚNG MỘT output) ─────────────────
//
// Hai Engage input CÙNG tên thread, hai output CÙNG tên đó, giá trị bằng nhau từng đơn
// vị. Σ value khớp (`X:2` vào, `X:2` ra), `n_in == n_out` khớp, mọi kế toán theo cặp
// khớp. Chỉ `expect [out]` thấy rằng phép lọc trả về HAI output cho MỘT input.
//
// Nới thành `[out, ..]` là ca này XANH ngay: cả hai input lấy output đầu tiên, và một
// input↔một output tụt xuống nhiều input↔một output. Cùng họ hình-dạng-không-tồn-tại với
// chốt 3/6 — xem khối chú thích đầu mục.
test consume_two_inputs_same_thread_two_matching_outputs_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input_named(0, 10, ct_thread_name)
  let e1 = ct_engage_input_named(1, 10, ct_thread_name)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)),
     Pair(Spend(vault_ref), burn_rd)]
  run(
    pp, 1, 6, [e0, e1], [vault],
    [
      ct_cont_output_named(ct_thread_name, 11, 6, 1, ct_img_price),
      ct_cont_output_named(ct_thread_name, 11, 6, 1, ct_img_price),
    ],
    reds, rd, er0, ct_in_datum,
  )
}

// ── CHỐT 6/6 — `expect pr_i == price_ref` ──────────────────────────────────────
//
// Engage input thứ hai khai một `price_ref` KHÁC trong redeemer của nó. Invocation đang
// chạy đọc bảng giá từ `price_ref` của CHÍNH NÓ rồi tính `req_i` cho MỌI input bằng bảng
// đó, nên nếu không có chốt này thì input thứ hai được tính giá bằng một bảng mà redeemer
// của nó không hề trỏ tới — hai invocation của cùng một tx đọc hai bảng khác nhau và mỗi
// cái tự thấy mình cân.
//
// Trên chuỗi thật, beacon giá mang NFT one-shot nên chỉ tồn tại MỘT UTxO beacon hợp lệ
// tại một thời điểm; chốt này là lớp thứ hai cho ngày tính one-shot đó bị làm hở, cùng
// hạng với chốt 3/6 và 5/6. Ca không cần dựng beacon thứ hai: chốt so `price_ref` của
// redeemer, không đọc datum của nó.
test consume_second_engage_uses_other_price_ref_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input_b(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd0 = ct_consume_redeemer(1, 1, vault_ref)
  let rd1 =
    ct_consume_redeemer_priced(1, 1, vault_ref, util.mk_ref_id(#"bb", ct_price_ref_ix + 1))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd0)), Pair(Spend(er1), rd_as_data(rd1)),
     Pair(Spend(vault_ref), burn_rd)]
  run(
    pp, 1, 6, [e0, e1], [vault],
    [ct_cont_output(11, 6, 1), ct_cont_output_b(11, 6, 1)],
    reds, rd0, er0, ct_in_datum,
  )
}

// ══════════════════════════════════════════════════════════════
// ĐÓNG THREAD — `CloseThread` (spend) + `BurnEngage` (mint)
//   Chủ dự án duyệt 2026-09-25. Mỗi chốt một CẶP dương/âm; ca dương một mình không
//   chứng minh được chốt nào (nó xanh được vì lý do rỗng).
// ══════════════════════════════════════════════════════════════

/// Đích của min-ADA thu hồi. Validator CỐ Ý không ép địa chỉ này — fixture chỉ dựng
/// một đích hợp lý để tx có hình dạng thật.
fn ct_close_payout() -> Output {
  util.mk_output_no_datum(util.vk_address(ct_owner), assets.from_lovelace(2_000_000))
}

fn run_close(
  inputs   : List<Input>,
  mint_v   : Value,
  outputs  : List<Output>,
  sigs     : List<ByteArray>,
  own_ref  : OutputReference,
  in_datum : EngageDatum,
) -> Bool {
  run_close_w(inputs, mint_v, outputs, sigs, own_ref, in_datum, [])
}

fn run_close_w(
  inputs   : List<Input>,
  mint_v   : Value,
  outputs  : List<Output>,
  sigs     : List<ByteArray>,
  own_ref  : OutputReference,
  in_datum : EngageDatum,
  wds      : Pairs<Credential, Int>,
) -> Bool {
  let tx =
    Transaction {
      ..placeholder,
      inputs: inputs,
      mint: mint_v,
      outputs: outputs,
      extra_signatories: sigs,
      withdrawals: wds,
    }
  consume.spend(
    ct_price_policy, ct_price_name, ct_vault_sh, ct_burn_constr, ct_max_stale,
    ct_mspe, ct_price_param_sh, Some(in_datum), CloseThread, own_ref, tx,
  )
}

/// Handler MINT với redeemer `BurnEngage` (policy_id == script hash engage).
fn run_burn(mint_v: Value) -> Bool {
  let tx = Transaction { ..placeholder, mint: mint_v }
  consume.mint(
    ct_price_policy, ct_price_name, ct_vault_sh, ct_burn_constr, ct_max_stale,
    ct_mspe, ct_price_param_sh, BurnEngage, ct_eng_sh, tx,
  )
}

// ── DƯƠNG: chủ ký, NFT của chính thread bị đốt −1, không output nào ở engage ───
test close_thread_happy() {
  run_close(
    [ct_engage_input(0, 10)],
    assets.from_asset(ct_eng_sh, ct_thread_name, -1),
    [ct_close_payout()],
    [ct_owner],
    util.mk_ref_id(#"e1", 0),
    ct_in_datum,
  )
}

// ── DƯƠNG: thread ĐÃ TIÊU vẫn đóng được (không ép consumed_* ở trạng thái nào) ──
//    Chốt này là một QUYẾT ĐỊNH, không phải chỗ hở: ràng buộc "chỉ đóng khi chưa tiêu"
//    sẽ khoá chết min-ADA của đúng những thread đã dùng — thứ redeemer này sinh ra để gỡ.
//    Ca này là bài canh cho quyết định đó: ai siết thêm sẽ thấy nó đỏ.
test close_thread_with_history_happy() {
  let used =
    EngageDatum { ..ct_in_datum, consumed_count: 99, consumed_nanogic: 990_000_000 }
  run_close(
    [ct_engage_input(0, 99)],
    assets.from_asset(ct_eng_sh, ct_thread_name, -1),
    [ct_close_payout()],
    [ct_owner],
    util.mk_ref_id(#"e1", 0),
    used,
  )
}

// ── ÂM (a): THIẾU chữ ký chủ thread ───────────────────────────────────────────
//    Không có vế này thì ai cũng đóng được thread của người khác: xoá hồ sơ tư-cách
//    của họ và bỏ túi min-ADA.
test close_thread_no_owner_signature_fail() fail {
  run_close(
    [ct_engage_input(0, 10)],
    assets.from_asset(ct_eng_sh, ct_thread_name, -1),
    [ct_close_payout()],
    [],
    util.mk_ref_id(#"e1", 0),
    ct_in_datum,
  )
}

// ── ÂM (a-bis): chữ ký của NGƯỜI KHÁC, không phải chủ thread ──────────────────
//    Phân biệt "có ai đó ký" với "ĐÚNG chủ ký" — hai chốt khác nhau, ca trên không
//    phân biệt được.
test close_thread_signed_by_stranger_fail() fail {
  run_close(
    [ct_engage_input(0, 10)],
    assets.from_asset(ct_eng_sh, ct_thread_name, -1),
    [ct_close_payout()],
    [#"deadbeef"],
    util.mk_ref_id(#"e1", 0),
    ct_in_datum,
  )
}

// ── ÂM (b): NFT KHÔNG bị đốt — ADA đi ra, thread vẫn sống ─────────────────────
//    Đây là ca đắt nhất nếu lọt: min-ADA rời UTxO trong khi thread NFT còn nguyên ⇒
//    một UTxO engage dưới min-ADA, không tiêu lại được bằng nhánh nào ⇒ thread chết
//    mà không ai biết. Chốt (b) là thứ ép "đóng" nghĩa là BIẾN MẤT, không phải "rút ruột".
test close_thread_nft_not_burned_fail() fail {
  run_close(
    [ct_engage_input(0, 10)],
    assets.zero,
    [ct_close_payout()],
    [ct_owner],
    util.mk_ref_id(#"e1", 0),
    ct_in_datum,
  )
}

// ── ÂM (b-bis): đốt SAI TÊN — mượn lượt đốt của thread khác ───────────────────
//    Vế "có một lượt đốt nào đó" sẽ cho ca này qua. Trên tx đóng nhiều thread, đó là
//    N thread dùng chung MỘT lượt đốt: N−1 NFT sống sót mà state đã biến mất.
test close_thread_burns_wrong_name_fail() fail {
  run_close(
    [ct_engage_input(0, 10)],
    assets.from_asset(ct_eng_sh, ct_thread_name_b, -1),
    [ct_close_payout()],
    [ct_owner],
    util.mk_ref_id(#"e1", 0),
    ct_in_datum,
  )
}

// ── ÂM (b-ter): lượng đốt KHÔNG phải −1 ───────────────────────────────────────
test close_thread_burn_qty_not_minus_one_fail() fail {
  run_close(
    [ct_engage_input(0, 10)],
    assets.from_asset(ct_eng_sh, ct_thread_name, -2),
    [ct_close_payout()],
    [ct_owner],
    util.mk_ref_id(#"e1", 0),
    ct_in_datum,
  )
}

// ── ÂM (c): còn một output ở địa chỉ engage mang NFT dưới own_hash ────────────
//    Hình dạng THẬT: đóng thread A trong khi thread B được dựng lại ở địa chỉ engage.
//    Chốt (c) cấm mọi NFT dưới own_hash đỗ lại địa chỉ engage trong một tx đóng.
test close_thread_output_keeps_nft_at_engage_fail() fail {
  run_close(
    [ct_engage_input(0, 10), ct_engage_input_b(1, 10)],
    assets.from_asset(ct_eng_sh, ct_thread_name, -1),
    [ct_cont_output_b(10, 0, 1), ct_close_payout()],
    [ct_owner],
    util.mk_ref_id(#"e1", 0),
    ct_in_datum,
  )
}

// ── DƯƠNG (c): đóng HAI thread cùng lúc vẫn hợp lệ ───────────────────────────
//    Cặp đối của ca trên: (c) cấm NFT ĐỖ LẠI, không cấm nhiều thread cùng đóng. Mỗi
//    invocation kiểm ĐÚNG NFT của input mình theo TÊN, nên không ai mượn lượt đốt của ai.
test close_two_threads_happy() {
  let mint_v =
    assets.from_asset(ct_eng_sh, ct_thread_name, -1)
      |> assets.add(ct_eng_sh, ct_thread_name_b, -1)
  run_close(
    [ct_engage_input(0, 10), ct_engage_input_b(1, 10)],
    mint_v,
    [ct_close_payout()],
    [ct_owner],
    util.mk_ref_id(#"e1", 1),
    ct_in_datum,
  )
}

// ══════════════════════════════════════════════════════════════
// `BurnEngage` — handler MINT
// ══════════════════════════════════════════════════════════════

// ── DƯƠNG: chỉ đốt ───────────────────────────────────────────────────────────
test burn_engage_happy() {
  run_burn(assets.from_asset(ct_eng_sh, ct_thread_name, -1))
}

// ── ÂM: lượng DƯƠNG dưới policy này → TỪ CHỐI ────────────────────────────────
//    `BurnEngage` mà đúc được là một đường đúc thread bỏ qua TOÀN BỘ cổng genesis
//    (`validate_mint_engage_id`): datum bịa, owner tuỳ ý, không cần seed.
test burn_engage_positive_qty_fail() fail {
  run_burn(assets.from_asset(ct_eng_sh, ct_thread_name, 1))
}

// ── ÂM: TRỘN đốt một cái, đúc một cái trong cùng tx ──────────────────────────
//    Đây là đường "đổi tên thread": NFT cũ chết, NFT mới sinh ra mà không qua cổng
//    genesis nào. `list.all(... qty < 0)` là vế chặn nó.
test burn_engage_mixed_mint_and_burn_fail() fail {
  let mint_v =
    assets.from_asset(ct_eng_sh, ct_thread_name, -1)
      |> assets.add(ct_eng_sh, ct_thread_name_b, 1)
  run_burn(mint_v)
}

// ── ÂM: `BurnEngage` mà KHÔNG đốt gì dưới policy này ─────────────────────────
//    `list.all` trên list rỗng là chân lý rỗng ⇒ redeemer luôn-đúng. Vế
//    `!list.is_empty` chặn đúng chỗ đó.
test burn_engage_empty_mint_fail() fail {
  run_burn(assets.from_asset(#"0a0a", #"544f4b", 5))
}

// ══════════════════════════════════════════════════════════════
// TRỘN `CloseThread` với `Consume` trong MỘT tx → TỪ CHỐI ở CẢ HAI nhánh
// ══════════════════════════════════════════════════════════════

/// tx trộn: thread A đóng (NFT bị đốt, không có output), thread B đang Consume.
fn ct_mixed_close_consume_tx() -> Transaction {
  let pp = ct_pp(6)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let er_close = util.mk_ref_id(#"e1", 0)
  let er_cons = util.mk_ref_id(#"e1", 1)
  let rd_cons = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  Transaction {
    ..placeholder,
    inputs: [ct_engage_input(0, 10), ct_engage_input_b(1, 10), ct_vault_input(0)],
    reference_inputs: [ct_beacon_ref(pp, 1)],
    outputs: [ct_cont_output_b(11, 6, 1), ct_close_payout()],
    mint: assets.from_asset(ct_eng_sh, ct_thread_name, -1),
    redeemers: [
      Pair(Spend(er_close), rd_as_data(CloseThread)),
      Pair(Spend(er_cons), rd_as_data(rd_cons)),
      Pair(Spend(vault_ref), burn_rd),
    ],
    extra_signatories: [ct_owner],
    validity_range: interval.between(6 * ct_mspe, 6 * ct_mspe + 1),
  }
}

// ── ÂM, phía Consume ────────────────────────────────────────────────────────
//    Thread A đóng ⇒ mất output của nó ⇒ n_in = 2, n_out = 1.
//
//    🔴 ĐỪNG GHI CA NÀY LÀ "BÀI CANH CHO `n_in == n_out`". Đo bằng đột biến
//    2026-09-25 (nền 192/192): gỡ `expect n_in == n_out` một mình → ca này VẪN ĐỎ;
//    gỡ nó cùng `engage_value_preserved` → vẫn đỏ. Thứ canh nó nằm sâu hơn (phép ghép
//    cặp trong `enforce_engagement`), và chưa ai đo tách được chốt đó. Xem khối
//    docstring của `validate_close_thread` để biết mức phát biểu đúng.
test close_mixed_with_consume_consume_side_fail() fail {
  let vault_ref = util.mk_ref_id(#"a1", 0)
  consume.spend(
    ct_price_policy, ct_price_name, ct_vault_sh, ct_burn_constr, ct_max_stale,
    ct_mspe, ct_price_param_sh, Some(ct_in_datum),
    ct_consume_redeemer(1, 1, vault_ref), util.mk_ref_id(#"e1", 1),
    ct_mixed_close_consume_tx(),
  )
}

// ── ÂM, phía CloseThread: chốt (c) ──────────────────────────────────────────
//    Chiều còn lại, ĐỘC LẬP với chốt trên: output của thread B mang NFT dưới own_hash
//    ⇒ (c) nổ. Hai chiều cùng đóng nghĩa là gỡ một chốt thì chốt kia vẫn bắt — nên
//    đừng đọc cặp này thành "đã ghim hai lần cùng một thứ".
test close_mixed_with_consume_close_side_fail() fail {
  consume.spend(
    ct_price_policy, ct_price_name, ct_vault_sh, ct_burn_constr, ct_max_stale,
    ct_mspe, ct_price_param_sh, Some(ct_in_datum), CloseThread,
    util.mk_ref_id(#"e1", 0), ct_mixed_close_consume_tx(),
  )
}

// ══════════════════════════════════════════════════════════════
// CHỦ LÀ `Credential` — `owner_authorized` ở MintEngage / BindDID / CloseThread, và
// `all_vault_owners_are` so `Credential` ở Consume.
//   Mỗi bài âm khác cặp dương của nó ĐÚNG MỘT biến (mục rút, danh sách ký, hoặc tag
//   của chủ vault), nên nó chỉ đỏ được ở cổng owner.
// ══════════════════════════════════════════════════════════════

const ct_owner_script: ByteArray =
  #"5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c"

const ct_other_script: ByteArray =
  #"5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d"

fn ct_wd(h: ByteArray) -> Pairs<Credential, Int> {
  [Pair(Script(h), 0)]
}

/// Engage input tại `ct_eng_sh` mang datum TUỲ Ý (1 NFT `ct_thread_name`).
fn ct_engage_input_datum(ref_ix: Int, d: EngageDatum) -> Input {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, ct_thread_name, 1)
  util.mk_input(
    util.mk_ref_id(#"e1", ref_ix),
    util.mk_output(util.script_address(ct_eng_sh), v, d),
  )
}

fn ct_engage_output_datum(d: EngageDatum) -> Output {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_eng_sh, ct_thread_name, 1)
  util.mk_output(util.script_address(ct_eng_sh), v, d)
}

// ── MintEngage ──
fn oc_mint(owner: Credential, sigs: List<ByteArray>, wds: Pairs<Credential, Int>) -> Bool {
  run_mint_w(
    [ct_seed_input()],
    assets.from_asset(ct_eng_sh, ct_seed_name(), 1),
    [
      ct_gen_out(
        util.script_address(ct_eng_sh), ct_seed_name(),
        EngageDatum { ..ct_clean_genesis(), owner: owner }, 0,
      ),
    ],
    sigs,
    wds,
  )
}

test engage_mint_owner_script_withdraw_zero_ok() {
  oc_mint(Script(ct_owner_script), [], ct_wd(ct_owner_script))
}

test engage_mint_owner_script_no_withdrawal_fail() fail {
  oc_mint(Script(ct_owner_script), [], [])
}

test engage_mint_owner_script_other_withdrawal_fail() fail {
  oc_mint(Script(ct_owner_script), [], ct_wd(ct_other_script))
}

test engage_mint_owner_script_hash_in_signatories_fail() fail {
  oc_mint(Script(ct_owner_script), [ct_owner_script], [])
}

test engage_mint_owner_vk_script_withdrawal_unsigned_fail() fail {
  oc_mint(VerificationKey(ct_owner), [], ct_wd(ct_owner))
}

// ── BindDID ──
fn oc_bind(owner: Credential, sigs: List<ByteArray>, wds: Pairs<Credential, Int>) -> Bool {
  let din = EngageDatum { ..ct_bind_in, owner: owner }
  run_bind_w(
    [ct_engage_input_datum(0, din)],
    [ct_engage_output_datum(EngageDatum { ..din, did_commit: ct_did32 })],
    sigs,
    util.mk_ref_id(#"e1", 0),
    din,
    wds,
  )
}

test bind_did_owner_script_withdraw_zero_ok() {
  oc_bind(Script(ct_owner_script), [], ct_wd(ct_owner_script))
}

test bind_did_owner_script_no_withdrawal_fail() fail {
  oc_bind(Script(ct_owner_script), [], [])
}

test bind_did_owner_script_other_withdrawal_fail() fail {
  oc_bind(Script(ct_owner_script), [], ct_wd(ct_other_script))
}

test bind_did_owner_script_hash_in_signatories_fail() fail {
  oc_bind(Script(ct_owner_script), [ct_owner_script], [])
}

test bind_did_owner_vk_script_withdrawal_unsigned_fail() fail {
  oc_bind(VerificationKey(ct_owner), [], ct_wd(ct_owner))
}

// ── CloseThread ──
fn oc_close(owner: Credential, sigs: List<ByteArray>, wds: Pairs<Credential, Int>) -> Bool {
  let din = EngageDatum { ..ct_in_datum, owner: owner }
  run_close_w(
    [ct_engage_input_datum(0, din)],
    assets.from_asset(ct_eng_sh, ct_thread_name, -1),
    [ct_close_payout()],
    sigs,
    util.mk_ref_id(#"e1", 0),
    din,
    wds,
  )
}

test close_thread_owner_script_withdraw_zero_ok() {
  oc_close(Script(ct_owner_script), [], ct_wd(ct_owner_script))
}

test close_thread_owner_script_no_withdrawal_fail() fail {
  oc_close(Script(ct_owner_script), [], [])
}

test close_thread_owner_script_other_withdrawal_fail() fail {
  oc_close(Script(ct_owner_script), [], ct_wd(ct_other_script))
}

test close_thread_owner_script_hash_in_signatories_fail() fail {
  oc_close(Script(ct_owner_script), [ct_owner_script], [])
}

test close_thread_owner_vk_script_withdrawal_unsigned_fail() fail {
  oc_close(VerificationKey(ct_owner), [], ct_wd(ct_owner))
}

// ── Consume: chủ script, withdraw-zero, và cổng `script_inputs_confined_to` ──
//    Mục rút KHÔNG thêm input, nên nó không đụng `script_inputs_confined_to`. Bài dương
//    chạy trọn validator (kể cả cổng đó); bài `_extra_input_at_owner_script_` là cặp âm
//    chứng minh cổng vẫn sống khi có mục rút: tiêu thêm một UTxO tại CHÍNH script chủ
//    thì bị từ chối.
fn oc_consume(
  thread_owner : Credential,
  vault_owner  : Credential,
  extra_inputs : List<Input>,
) -> Bool {
  let pp = ct_pp(6)
  let din = EngageDatum { ..ct_in_datum, owner: thread_owner }
  let eng = ct_engage_input_datum(0, din)
  let vault = ct_vault_input_cred(0, vault_owner)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run_sigs_w(
    ct_beacon_ref(pp, 1), 6, [eng], list.concat([vault], extra_inputs),
    [ct_cont_output_owner(thread_owner, 11, 6)], reds, rd, eng_ref, din, [],
    ct_wd(ct_owner_script),
  )
}

test consume_owner_script_withdraw_zero_ok() {
  oc_consume(Script(ct_owner_script), Script(ct_owner_script), [])
}

// Cùng 28 byte, khác tag: thread `Script(h)`, vault `VerificationKey(h)` ⟹ không cùng chủ.
test consume_owner_script_vault_owner_vk_same_bytes_fail() fail {
  oc_consume(Script(ct_owner_script), VerificationKey(ct_owner_script), [])
}

test consume_owner_script_extra_input_at_owner_script_fail() fail {
  let at_owner_script =
    util.mk_input(
      util.mk_ref_id(#"0c", 0),
      util.mk_output_no_datum(
        util.script_address(ct_owner_script),
        assets.from_lovelace(2_000_000),
      ),
    )
  oc_consume(Script(ct_owner_script), Script(ct_owner_script), [at_owner_script])
}
