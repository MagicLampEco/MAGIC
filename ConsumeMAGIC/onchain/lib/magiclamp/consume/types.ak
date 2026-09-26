// ConsumeMAGIC onchain types — interface contract (CONTRACT.md §B1/§B2).
// Constr index theo thứ tự khai báo — phải khớp byte-perfect với offchain codec.
//
// ── MÔ HÌNH (rewrite D1, thay mô hình token-burn cũ) ──────────────────────────
// MAGIC KHÔNG là token, KHÔNG MintingPolicy. Tiêu MAGIC = GIẢM current_amount của
// MagicBatch trong VaultDatum của generator vault (handler BurnBatch của vault).
// ConsumeMAGIC KHÔNG còn chạm tx.mint. Module này = PRICING + ENGAGEMENT/ATTRIBUTION:
//   - pricing.ak  : nguồn `required` có thẩm quyền (đọc PriceParam beacon).
//   - consume.ak  : spend Engage UTxO (state per-app), ép cùng tx có 1 vault input
//                   spend bằng BurnBatch với Σburns == required (validator vault là
//                   nơi DUY NHẤT giảm MAGIC). KHÔNG mint.

use cardano/transaction.{OutputReference}

/// Một dòng giá danh nghĩa per loại nghiệp vụ (governance param).
/// `base_price` đơn vị nanogic (1 MAGIC = 1e9). Ví dụ MVP:
///   xử lý 1 ảnh  → op_type=1, base_price=10_000_000  (0.01 MAGIC)
///   neo 1 CID    → op_type=2, base_price= 1_000_000  (0.001 MAGIC)
///
/// `demand_mult` (trường THỨ BA, scale Q) — `CC-LOAD-COUNT-UNIT`, chốt 2026-09-24
/// (`CONTRACT.md §A`). Hệ số co giãn cung-cầu của RIÊNG dòng này, KHÔNG còn một giá
/// trị chung toàn hệ ở mức `PriceParam`.
///
/// VÌ SAO tách xuống dòng: bộ đếm tải gộp toàn hệ trộn `op_count` của những mã có
/// ĐƠN VỊ KHÁC NHAU (một tấm ảnh / một lần neo / một đơn vị fuel). Cộng thẳng chúng
/// thì cỡ đơn vị một bên chọn quyết định giá của mọi bên còn lại — và ca xấu nhất là
/// `op_type = 7` (`did.rotate`): một đợt lộ khoá hàng loạt đẩy tải lên ⇒ xoay khoá
/// đắt lên đúng lúc cần rẻ nhất. Mỗi mã một bộ đếm riêng ⇒ không phép cộng nào bắc
/// qua hai đơn vị.
///
/// 🔴 ĐỔI LƯỢC ĐỒ, KHÔNG PHẢI THÊM TUỲ CHỌN. Giải mã Plutus Data của Aiken NGHIÊM
/// NGẶT VỀ SỐ TRƯỜNG theo CẢ HAI CHIỀU (`BOUNDARIES.md §2`): datum 2 trường đọc bằng
/// type 3 trường FAIL, và ngược lại. Không beacon cũ nào đọc được bằng type này —
/// việc phải làm là bootstrap beacon MỚI (NFT one-shot mới), không phải cứu beacon cũ.
/// Không UTxO NGƯỜI DÙNG nào phải di trú (`EngageDatum` không đụng tới).
pub type OpPrice {
  op_type     : Int,
  base_price  : Int,
  demand_mult : Int,
}

/// Datum beacon PriceParam (reference input — CIP-31, KHÔNG tiêu).
/// Giá có thẩm quyền: validator consume ĐỌC từ đây, KHÔNG tin amount client.
///   price(op_type) = base_price[op_type] × demand_mult[op_type] / Q   (Q=1e9, BigInt)
/// `demand_mult` nay nằm ở TỪNG DÒNG `OpPrice`, không còn ở mức datum này — xem
/// docstring `OpPrice` (`CC-LOAD-COUNT-UNIT`, chốt 2026-09-24).
///
/// 🔴 TRƯỜNG `demand_mult` Ở MỨC NÀY ĐÃ BỊ BỎ HẲN, không để lại bia mộ. Lý do khác
/// với ca `BatchSource::Snapshot` (bia mộ giữ chỉ số constructor cho UTxO đã lên
/// chuỗi): ở đây đổi số trường của `OpPrice` đã làm mọi beacon cũ không đọc được,
/// nên không có UTxO nào cần giữ chỉ số. Giữ lại trường này thì nó thành NGUỒN THỨ
/// HAI cho cùng một đại lượng — hai chỗ khai hệ số nhu cầu, không cổng nào nói chỗ
/// nào thắng.
///
/// Mỗi `demand_mult` của từng dòng là FIR (SMA-N) đã clamp về [m_min, m_max] (keeper
/// cập nhật offchain). Bất biến datum: MỌI dòng có m_min ≤ demand_mult ≤ m_max;
/// mọi giá trị ≥ 0; pure BigInt. `m_min`/`m_max` ở lại mức datum vì chúng là BAND
/// dùng chung, ghim tuyệt đối về hằng biên dịch.
pub type PriceParam {
  op_prices : List<OpPrice>,
  m_min     : Int,
  m_max     : Int,
  epoch     : Int,
}

/// State engagement per-app (UTxO RIÊNG do consume validator quản, TÁCH khỏi
/// VaultDatum — quyết định D1: khác chủ thể, song song hoá, không tràn datum vault).
/// Thread token (NFT one-shot) gắn UTxO này → không UTxO giả nào thay thế được.
///
/// `last_epoch` (field 2): epoch của lần consume GẦN NHẤT. Là STATE TÍCH LUỸ, không
///   phải lựa chọn của người dùng ⇒ genesis PHẢI == 0 (thread chưa consume lần nào).
///   Validator spend ép `output.last_epoch == current_epoch`.
///
/// `did_commit` (field 3, APPEND-ONLY — giữ tương thích decode genesis cũ):
///   #"" (rỗng) = CHƯA gắn DID. Khác rỗng = blake2b256 commitment liên kết
///   engagement ↔ DID sinh trắc (PhoenixKey, Governance C1/C3).
///
///   ĐỘ DÀI bị ghim on-chain ở MỌI chỗ GHI (mint genesis + redeemer BindDID):
///   `length == 0` HOẶC `length == 32`. Không ghim thì một did_commit dài tuỳ ý đi
///   được vào datum — vừa phình UTxO vừa buộc mọi bên đọc tự đoán khuôn.
///
///   HAI chỗ GHI, không phải một — và chỗ thứ nhất là GENESIS:
///     (đúc thread) ─┬─▶ rỗng ──BindDID──▶ 32 byte ──▶ (đóng băng vĩnh viễn)
///                   └─▶ 32 byte TỰ CHỌN ─────────────▶ (đóng băng vĩnh viễn)
///   - cổng đúc `validate_mint_engage_id` ghim ĐỘ DÀI (`did_len_ok`) và CỐ Ý không ghim
///     NỘI DUNG ⇒ một thread hợp lệ khởi đầu THẲNG ở 32 byte do người đúc tự chọn.
///     Bài dương tính khoá chủ ý đó: `engage_mint_did_commit_free_happy`.
///   - nhánh `Consume` ép `output.did_commit == input.did_commit` (bất biến tuyệt đối);
///   - nhánh `BindDID` là đường ghi duy nhất CÒN LẠI **sau** genesis, và chỉ khi giá trị
///     hiện tại RỖNG.
///   Không có đường đi ngược (32 byte → rỗng) và không có đường đổi giá trị này sang
///   giá trị khác.
///
///   🔴 AI DỰNG VẾ CHỐNG-MƯỢN ĐỌC KỸ DÒNG NÀY. Bản trước của khối này viết *"`BindDID`
///   là đường DUY NHẤT ghi được"* — bỏ mất vế hạn định *"còn lại"* mà `consume.ak` (đầu
///   tệp) vẫn giữ đúng. Một vế chống-mượn dựng trên mệnh đề thiếu đó sẽ canh `BindDID`
///   và để hở nguyên đường genesis, tức **một bản vá rỗng trông y hệt một bản vá**.
///
///   VÌ SAO cần BindDID: thread mở trong giai đoạn này có did_commit rỗng (lớp gắn DID
///   chưa bật). Nếu did_commit bất biến TUYỆT ĐỐI qua mọi giao dịch thì khi hệ bật
///   `consumedFactor` (hệ số tư-cách đọc MAGIC đã tiêu, gắn theo PersonDID), mọi thread
///   mở hôm nay bị khoá vĩnh viễn ngoài cơ chế đó — không đường nào điền vào sau.
///
/// `consumed_nanogic` (field 4, THÊM Ở CUỐI để KHÔNG dịch chỉ số field cũ):
///   Tổng GIÁ TRỊ đã tiêu (nanogic) tích luỹ trên thread này.
///   LÝ DO tồn tại: `consumed_count` chỉ đếm LƯỢT, KHÔNG phân biệt op rẻ / op đắt.
///   Chỉ có count thì kẻ gọi trả tiền op_type=2 (CID, 1e6) rồi để app đọc "+1 lượt"
///   mà cấp dịch vụ op_type=1 (ảnh, 1e7) → trả thiếu 10×. Validator ép bất biến
///   THỨ HAI (song song với count):
///       Σ consumed_nanogic(out@engage) == Σ consumed_nanogic(in@engage) + total_required
///   ⇒ giá trị THẬT đã trả nằm on-chain. App PHẢI cấp dịch vụ theo delta của trường
///   này, KHÔNG theo `consumed_count` (count giữ lại chỉ để thống kê/attribution).
pub type EngageDatum {
  owner            : ByteArray,
  consumed_count   : Int,
  last_epoch       : Int,
  did_commit       : ByteArray,
  consumed_nanogic : Int,
}

/// Redeemer validator consume (engagement spend — CONTRACT.md §B2).
///
/// 🔴 CHỈ SỐ CONSTRUCTOR LÀ HỢP ĐỒNG NHỊ PHÂN. Variant MỚI chỉ được THÊM Ở CUỐI;
///    đảo thứ tự / chèn giữa là đổi cách decode ⇒ mọi tx đã dựng sẵn và mọi bên
///    off-chain đang mã hoá theo chỉ số cũ đều vỡ. Chỉ số hiện hành:
///      Consume     → constr 0
///      BindDID     → constr 1
///      CloseThread → constr 2   (THÊM 2026-09-25 — Ở CUỐI, không chèn giữa)
///    Ghim bằng test `redeemer_constr_index_pinned` (consume.ak) ↔
///    `tests/codec.test.ts` phía off-chain.
///
/// `Consume` — tiêu MAGIC, ghi engagement:
///   op_type   : loại nghiệp vụ (khớp 1 OpPrice trong PriceParam.op_prices)
///   op_count  : số lượng nghiệp vụ trong consume này (≥ 1)
///   price_ref : OutputReference của beacon PriceParam (reference input)
///   vault_ref : OutputReference của vault input co-spend bằng BurnBatch trong CÙNG
///               tx; validator đọc redeemer BurnBatch của input này để khớp
///               Σburns == required (liên kết 2 validator, không lệch giá).
///
/// `BindDID` — gắn PersonDID vào thread, KHÔNG field.
///   Đường DUY NHẤT ghi `did_commit` sau genesis, đi MỘT CHIỀU và ĐÚNG MỘT LẦN:
///   chỉ hợp lệ khi `did_commit` hiện tại RỖNG, và giá trị mới phải khác rỗng + đúng
///   32 byte. Không tiêu MAGIC, không đọc giá, không đụng vault. Mọi trường kế toán
///   (`owner`, `consumed_count`, `last_epoch`, `consumed_nanogic`) và value bảo toàn
///   TUYỆT ĐỐI — giao dịch này chỉ điền một trường.
///   Không field: continuing output là DUY NHẤT (ép `#in@engage == #out@engage == 1`)
///   nên giá trị mới đọc thẳng từ datum của output đó, không cần khai lại trong
///   redeemer (khai hai nơi là mở ra một chỗ để hai nơi lệch nhau).
///
/// `CloseThread` — ĐÓNG thread, trả lại min-ADA. KHÔNG field.
///   Chủ dự án duyệt 2026-09-25. Thread Engage khoá min-ADA vĩnh viễn: trước redeemer
///   này không nhánh nào tiêu được UTxO engage mà KHÔNG tạo lại continuing output
///   (`Consume` và `BindDID` đều ép `#out@engage == #in@engage`), nên số ADA đó chết
///   cùng thread. Đóng thread = ĐỐT thread NFT (`BurnEngage` phía mint) ⇒ không còn
///   định danh nào để dựng lại UTxO đó ⇒ state biến mất HẲN, không để lại vỏ rỗng.
///
///   `EngageDatum` KHÔNG đổi (5 trường) — đây là hợp đồng liên kho, và đóng thread là
///   một thao tác XOÁ, không phải một trường mới.
///
///   🔴 ĐÓNG LÀ MỘT CHIỀU VÀ MẤT LỊCH SỬ. `consumed_count` / `consumed_nanogic` là đầu
///   vào tư-cách biểu quyết (C1). Đóng thread xoá chúng khỏi chuỗi. Điều đó ĐÚNG THEO
///   THIẾT KẾ ở tầng này (chủ thread tự chọn bỏ hồ sơ của mình để lấy lại ADA), và nó
///   KHÔNG mở đường gian lận: xoá chỉ HẠ tư-cách của chính người ký, không nâng của ai.
///   Ai dựng lớp tư-cách phía trên phải đọc dòng này — hồ sơ trên chuỗi KHÔNG bền vĩnh
///   viễn, nó bền tới khi chủ nó đóng thread.
pub type ConsumeRedeemer {
  Consume {
    op_type   : Int,
    op_count  : Int,
    price_ref : OutputReference,
    vault_ref : OutputReference,
  }
  BindDID
  CloseThread
}

/// Redeemer cho beacon PriceParam (committee/keeper post giá mới).
pub type PriceParamRedeemer {
  PostPrice
}

/// Redeemer handler `mint` của chính validator `consume` (MULTI-PURPOSE).
///
/// VÌ SAO nằm TRONG consume chứ không phải một validator riêng: mint-policy phải ép
/// Engage UTxO genesis nằm ĐÚNG địa chỉ script consume với datum SẠCH. Muốn thế,
/// policy phải biết `consume_script_hash`, mà `consume_script_hash` lại phụ thuộc
/// policy nếu policy là param ⇒ fixed-point blake2b, KHÔNG deploy được. Gộp `mint`
/// vào chính `consume` ⇒ `policy_id (mint) == script_hash == payment_credential của
/// địa chỉ spend` — biết qua TỰ THAM CHIẾU, không param, không vòng.
///
///   seed : OutputReference bị TIÊU trong chính tx mint (one-shot). Tên NFT =
///          blake2b_256(cbor.serialise(seed)) ⇒ mỗi thread một tên duy nhất,
///          permissionless, N thread cùng policy mà không đụng nhau.
///
/// 🔴 CHỈ SỐ CONSTRUCTOR LÀ HỢP ĐỒNG NHỊ PHÂN — variant mới THÊM Ở CUỐI:
///      MintEngage → constr 0
///      BurnEngage → constr 1   (THÊM 2026-09-25)
///
/// `BurnEngage` — ĐỐT thread NFT, không field. Đường mint DUY NHẤT có lượng ÂM.
///   Vế nó giữ MỘT MÌNH: mọi lượng dưới policy này trong `tx.mint` đều ÂM. Nó KHÔNG
///   kiểm quyền — quyền nằm ở nhánh spend `CloseThread` (chữ ký chủ thread), vì thread
///   NFT chỉ sống ở địa chỉ script engage nên muốn đốt thì buộc phải tiêu UTxO đó, và
///   tiêu UTxO đó là chạy `CloseThread`. Hai handler kẹp nhau: mint ép "chỉ đốt",
///   spend ép "ai được đốt".
///
///   VÌ SAO phải là redeemer RIÊNG chứ không nới `MintEngage`: `MintEngage` ép
///   `dict.size(own_tokens) == 1` + `quantity_of(...) == +1` + một output genesis SẠCH.
///   Nới nó để nhận lượng âm là mở luôn ca "đốt một cái, đúc một cái" trong cùng tx —
///   một đường đổi tên thread mà không cổng nào còn thấy.
pub type EngageMintRedeemer {
  MintEngage { seed: OutputReference }
  BurnEngage
}

/// Redeemer minting policy thread/price NFT one-shot.
pub type NftRedeemer {
  MintGenesis
}
