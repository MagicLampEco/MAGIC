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
pub type OpPrice {
  op_type    : Int,
  base_price : Int,
}

/// Datum beacon PriceParam (reference input — CIP-31, KHÔNG tiêu).
/// Giá có thẩm quyền: validator consume ĐỌC từ đây, KHÔNG tin amount client.
///   price(op_type) = base_price[op_type] × demand_mult / Q   (Q=1e9, scale BigInt)
/// demand_mult là FIR (SMA-N) đã clamp về [m_min, m_max] (keeper cập nhật offchain).
/// Bất biến datum: m_min ≤ demand_mult ≤ m_max; mọi giá trị ≥ 0; pure BigInt.
pub type PriceParam {
  op_prices   : List<OpPrice>,
  demand_mult : Int,
  m_min       : Int,
  m_max       : Int,
  epoch       : Int,
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
///   MVP = #"" (rỗng). Tương lai = blake2b256 commitment liên kết engagement ↔ DID
///   sinh trắc (PhoenixKey, Governance C1/C3). Đặt 1 lần lúc genesis, IMMUTABLE sau đó
///   (validator ép output.did_commit == input.did_commit). Validator KHÔNG ràng buộc
///   NỘI DUNG ở MVP (rỗng-được), chỉ ràng buộc bất biến.
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
///   op_type   : loại nghiệp vụ (khớp 1 OpPrice trong PriceParam.op_prices)
///   op_count  : số lượng nghiệp vụ trong consume này (≥ 1)
///   price_ref : OutputReference của beacon PriceParam (reference input)
///   vault_ref : OutputReference của vault input co-spend bằng BurnBatch trong CÙNG
///               tx; validator đọc redeemer BurnBatch của input này để khớp
///               Σburns == required (liên kết 2 validator, không lệch giá).
pub type ConsumeRedeemer {
  Consume {
    op_type   : Int,
    op_count  : Int,
    price_ref : OutputReference,
    vault_ref : OutputReference,
  }
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
pub type EngageMintRedeemer {
  MintEngage { seed: OutputReference }
}

/// Redeemer minting policy thread/price NFT one-shot.
pub type NftRedeemer {
  MintGenesis
}
