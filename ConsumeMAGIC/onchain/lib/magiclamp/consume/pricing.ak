// ConsumeMAGIC pricing — giá CÓ THẨM QUYỀN tính từ PriceParam beacon.
// NORMATIVE: CONTRACT.md §A + §E. Pure BigInt, KHÔNG float.
//
//   price(op_type) = base_price[op_type] × demand_mult / Q     (Q=1e9, scale)
//   required       = price(op_type) × op_count
//
// demand_mult đã được keeper clamp về [m_min, m_max] offchain; validator KIỂM TRA
// lại bất biến đó on-chain (defense-in-depth) trước khi dùng — không tin mù datum.

use aiken/collection/list
use magiclamp/consume/types.{OpPrice, PriceParam}

/// Scale factor Q (1 MAGIC = 1e9 nanogic), khớp ProtocolUtils.Q.
pub const q: Int = 1_000_000_000

/// Tìm base_price cho op_type trong bảng giá. None nếu op_type không tồn tại.
pub fn lookup_base(op_prices: List<OpPrice>, op_type: Int) -> Option<Int> {
  when list.find(op_prices, fn(p) { p.op_type == op_type }) is {
    Some(p) -> Some(p.base_price)
    None -> None
  }
}

/// Bất biến datum PriceParam (C-CM-2 defense-in-depth, CONTRACT §E "mọi giá trị ≥ 0"):
///   0 ≤ m_min ≤ m_max ; m_min ≤ demand_mult ≤ m_max ; MỌI base_price ≥ 0.
/// Giá âm → required âm → magic_burned ≥ required thoả với burn=0 (drain miễn phí).
/// Vì m_min ≥ 0 và demand_mult ≥ m_min nên demand_mult ≥ 0 (ngầm). base_price phải
/// ép RIÊNG: clamp m_* không chặn được dòng giá danh nghĩa âm.
/// Nếu sai → datum beacon không hợp lệ → consume phải fail (không dùng giá rác).
pub fn valid_param(pp: PriceParam) -> Bool {
  and {
    pp.m_min >= 0,
    pp.m_min <= pp.m_max,
    pp.demand_mult >= pp.m_min,
    pp.demand_mult <= pp.m_max,
    list.all(pp.op_prices, fn(op) { op.base_price >= 0 }),
  }
}

/// Giá 1 đơn vị nghiệp vụ op_type theo beacon (nanogic). Floor division (BigInt).
/// Đơn điệu không-giảm theo demand_mult; bị chặn [base×m_min/Q, base×m_max/Q].
pub fn price_of(pp: PriceParam, op_type: Int) -> Option<Int> {
  when lookup_base(pp.op_prices, op_type) is {
    Some(base) -> Some(base * pp.demand_mult / q)
    None -> None
  }
}

/// required = price(op_type) × op_count. None nếu op_type không có trong bảng.
/// op_count phải ≥ 1 (validator ép riêng); ở đây thuần số học.
pub fn required_for(pp: PriceParam, op_type: Int, op_count: Int) -> Option<Int> {
  when price_of(pp, op_type) is {
    Some(unit) -> Some(unit * op_count)
    None -> None
  }
}

// ── Tests thuần (số học giá) ──────────────────────────────────

fn pp_mvp(demand: Int) -> PriceParam {
  PriceParam {
    op_prices: [
      OpPrice { op_type: 1, base_price: 10_000_000 },  // ảnh 0.01 MAGIC
      OpPrice { op_type: 2, base_price: 1_000_000 },    // CID 0.001 MAGIC
    ],
    demand_mult: demand,
    m_min: 500_000_000,    // 0.5×
    m_max: 2_000_000_000,  // 2.0×
    epoch: 100,
  }
}

test price_unit_demand() {
  // demand_mult = Q (1.0×) → price = base.
  let pp = pp_mvp(q)
  price_of(pp, 1) == Some(10_000_000) && price_of(pp, 2) == Some(1_000_000)
}

test price_high_demand() {
  // demand_mult = 2×Q → price ảnh = 20_000_000 (0.02 MAGIC).
  let pp = pp_mvp(2_000_000_000)
  price_of(pp, 1) == Some(20_000_000)
}

test price_low_demand() {
  // demand_mult = 0.5×Q → price ảnh = 5_000_000.
  let pp = pp_mvp(500_000_000)
  price_of(pp, 1) == Some(5_000_000)
}

test price_monotone_nondecreasing() {
  // Đơn điệu: demand cao hơn → giá ≥.
  expect Some(lo) = price_of(pp_mvp(q), 1)
  expect Some(hi) = price_of(pp_mvp(2_000_000_000), 1)
  hi >= lo
}

test required_multiplies_count() {
  let pp = pp_mvp(q)
  required_for(pp, 1, 5) == Some(50_000_000)
}

test unknown_op_none() {
  price_of(pp_mvp(q), 99) == None && required_for(pp_mvp(q), 99, 1) == None
}

test valid_param_ok() {
  valid_param(pp_mvp(q))
}

test valid_param_out_of_clamp() {
  // demand_mult > m_max → datum không hợp lệ.
  !valid_param(pp_mvp(3_000_000_000))
}

test valid_param_negative_base_price_fail() {
  // base_price âm → datum không hợp lệ (finding medium): giá âm → required âm →
  // burn=0 thoả "magic_burned ≥ required" → drain miễn phí. Phải reject.
  let bad =
    PriceParam {
      op_prices: [
        OpPrice { op_type: 1, base_price: 10_000_000 },
        OpPrice { op_type: 2, base_price: -1 },   // dòng giá âm
      ],
      demand_mult: q,
      m_min: 500_000_000,
      m_max: 2_000_000_000,
      epoch: 100,
    }
  !valid_param(bad)
}
