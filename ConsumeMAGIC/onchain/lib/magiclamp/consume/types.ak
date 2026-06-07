// ConsumeMAGIC onchain types — interface contract (CONTRACT.md §B1/§B2).
// Constr index theo thứ tự khai báo — phải khớp byte-perfect với offchain codec.

use cardano/transaction.{OutputReference}

/// Một dòng giá danh nghĩa per loại nghiệp vụ (governance param).
/// `base_price` đơn vị nanogic (1 MAGIC = 1e9). Ví dụ MVP:
///   xử lý 1 ảnh  → op_type=0, base_price=10_000_000  (0.01 MAGIC)
///   neo 1 CID    → op_type=1, base_price= 1_000_000  (0.001 MAGIC)
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

/// State engagement neo vào continuing output của vault (chống replay — C-CM-4).
/// Mỗi consume tăng `consumed_count` đúng 1 và `last_epoch = current_epoch`.
/// Thread token (NFT one-shot) gắn UTxO này → không UTxO giả nào thay thế được.
pub type EngageDatum {
  owner          : ByteArray,
  consumed_count : Int,
  last_epoch     : Int,
}

/// Redeemer validator consume (CONTRACT.md §B2).
///   op_type   : loại nghiệp vụ (khớp 1 OpPrice trong PriceParam.op_prices)
///   op_count  : số lượng nghiệp vụ trong consume này (≥ 1)
///   price_ref : OutputReference của beacon PriceParam (reference input)
pub type ConsumeRedeemer {
  Consume { op_type: Int, op_count: Int, price_ref: OutputReference }
}

/// Redeemer cho beacon PriceParam (committee/keeper post giá mới).
pub type PriceParamRedeemer {
  PostPrice
}

/// Redeemer minting policy thread/price NFT one-shot.
pub type NftRedeemer {
  MintGenesis
}
