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

/// Band cầu-giá TUYỆT ĐỐI — HẰNG GIAO THỨC CỐ ĐỊNH (CONTRACT §A), KHỚP offchain
/// M_MIN_Q / M_MAX_Q (P8). demand_mult ∈ [m_min_q, m_max_q].
///   m_min_q = 0.5× = 500_000_000 ; m_max_q = 2.0× = 2_000_000_000
/// valid_param PIN pp.m_min == m_min_q ∧ pp.m_max == m_max_q → chặn PostPrice đặt
/// m_max khổng lồ (giá nổ ~1e6×, #1b band-escape). KHÔNG chỉ dựa check tương-đối.
pub const m_min_q: Int = 500_000_000

pub const m_max_q: Int = 2_000_000_000

/// Tìm base_price cho op_type trong bảng giá. None nếu op_type không tồn tại.
pub fn lookup_base(op_prices: List<OpPrice>, op_type: Int) -> Option<Int> {
  when list.find(op_prices, fn(p) { p.op_type == op_type }) is {
    Some(p) -> Some(p.base_price)
    None -> None
  }
}

/// Bất biến datum PriceParam (C-CM-2 defense-in-depth, CONTRACT §E "mọi giá trị ≥ 0"):
///   BAND TUYỆT ĐỐI: m_min == m_min_q ∧ m_max == m_max_q (pin, chống band-escape #1b);
///   0 ≤ m_min ≤ m_max ; m_min ≤ demand_mult ≤ m_max ; epoch ≥ 0 ; MỌI base_price ≥ 0;
///   GATE-giá-tối-thiểu: MỌI op có base_price == 0 HOẶC base_price × m_min ≥ q.
/// Lý do các tầng:
///   - Pin m_min/m_max: PostPrice cẩu thả đặt m_max khổng lồ ⇒ price = base×demand/q nổ
///     ~1e6× (verified). Check tương-đối (m_min≤demand≤m_max) KHÔNG chặn được vì demand
///     cũng theo m_max. Phải neo về HẰNG compile-time.
///   - GATE base×m_min ≥ q: bảo đảm giá 1 đơn-vị ở demand THẤP NHẤT ≥ 1 nanogic
///     (⌊base×m_min/q⌋ ≥ 1) ⇒ đóng collapse-to-0 (#1b): base quá nhỏ ⇒ giá làm tròn về 0
///     ⇒ drain miễn phí. base_price == 0 là dòng "miễn phí có chủ đích" (được phép).
///   - base_price ≥ 0: giá âm → required âm → burn=0 thoả "≥ required" (drain miễn phí).
/// Nếu sai → datum beacon không hợp lệ → consume phải fail (không dùng giá rác).
pub fn valid_param(pp: PriceParam) -> Bool {
  and {
    // BAND TUYỆT ĐỐI (pin về hằng — load-bearing chống #1b band-escape)
    pp.m_min == m_min_q,
    pp.m_max == m_max_q,
    // check tương-đối GIỮ NGUYÊN (defense-in-depth, redundant sau pin nhưng không bỏ)
    pp.m_min >= 0,
    pp.m_min <= pp.m_max,
    pp.demand_mult >= pp.m_min,
    pp.demand_mult <= pp.m_max,
    pp.epoch >= 0,
    // per-op: base ≥ 0 VÀ (base == 0 HOẶC giá ≥ 1 nanogic ở demand thấp nhất) → #1b
    list.all(
      pp.op_prices,
      fn(op) {
        and {
          op.base_price >= 0,
          op.base_price == 0 || op.base_price * pp.m_min >= q,
        }
      },
    ),
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

/// required = ⌊ base_price × demand_mult × op_count / Q ⌋ (FOLD-FLOOR-MỘT-LẦN).
/// None nếu op_type không có trong bảng. op_count phải ≥ 1 (validator ép riêng).
///
/// ⚠ FIX #1 (under-charge): KHÔNG floor per-op RỒI nhân op_count (⌊base×dm/Q⌋ × count)
/// vì phần dư mỗi op bị mất, cộng dồn theo count ⇒ thu thiếu. Nhân base×dm×count TRƯỚC,
/// chia Q MỘT lần ⇒ chỉ mất < 1 nanogic cho CẢ dòng. BigInt (Int Aiken) — không tràn.
/// P8: offchain requiredBurn / requiredFromBeacon PHẢI dùng CÙNG fold-floor này.
pub fn required_for(pp: PriceParam, op_type: Int, op_count: Int) -> Option<Int> {
  when lookup_base(pp.op_prices, op_type) is {
    Some(base) -> Some(base * pp.demand_mult * op_count / q)
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

test required_fold_floor_no_undercharge() {
  // FIX #1: base=1e6, demand=1_333_333_333, count=1000.
  //   Cũ (floor-before-multiply): ⌊1e6×1_333_333_333/1e9⌋=1_333_333 → ×1000 = 1_333_333_000.
  //   Mới (fold-floor-once):       ⌊1e6×1_333_333_333×1000/1e9⌋       = 1_333_333_333.
  // Chênh 333 nanogic bị thu THIẾU ở bản cũ. Phải == bản mới (giá trị fold đúng).
  let pp =
    PriceParam {
      op_prices: [OpPrice { op_type: 1, base_price: 1_000_000 }],
      demand_mult: 1_333_333_333,
      m_min: 500_000_000,
      m_max: 2_000_000_000,
      epoch: 100,
    }
  required_for(pp, 1, 1000) == Some(1_333_333_333)
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

test valid_param_gate_rejects_tiny_base() {
  // FIX #1b (collapse-to-0): base_price=1, ở demand=m_min(0.5×) → ⌊1×5e8/1e9⌋ = 0
  // ⇒ giá 0 ⇒ drain miễn phí. GATE base×m_min ≥ q: 1×5e8 = 5e8 < 1e9 → reject.
  let bad =
    PriceParam {
      op_prices: [OpPrice { op_type: 1, base_price: 1 }],
      demand_mult: q,
      m_min: 500_000_000,
      m_max: 2_000_000_000,
      epoch: 100,
    }
  !valid_param(bad)
}

test valid_param_gate_accepts_min_base() {
  // Biên GATE: base_price=2 → 2×5e8 = 1e9 ≥ q → hợp lệ (⌊2×5e8/1e9⌋ = 1 nanogic).
  let ok =
    PriceParam {
      op_prices: [OpPrice { op_type: 1, base_price: 2 }],
      demand_mult: q,
      m_min: 500_000_000,
      m_max: 2_000_000_000,
      epoch: 100,
    }
  valid_param(ok)
}

test valid_param_rejects_unpinned_m_max() {
  // FIX #1b (band-escape): m_max lệch hằng (dù chỉ +1) → pin fail → reject.
  let bad =
    PriceParam {
      op_prices: [OpPrice { op_type: 1, base_price: 10_000_000 }],
      demand_mult: q,
      m_min: 500_000_000,
      m_max: 2_000_000_001,
      epoch: 100,
    }
  !valid_param(bad)
}

test valid_param_rejects_huge_m_max() {
  // m_max khổng lồ (2e15) + demand bám theo → giá nổ ~1e6×. Pin m_max chặn tận gốc.
  let bad =
    PriceParam {
      op_prices: [OpPrice { op_type: 1, base_price: 10_000_000 }],
      demand_mult: 2_000_000_000_000_000,
      m_min: 500_000_000,
      m_max: 2_000_000_000_000_000,
      epoch: 100,
    }
  !valid_param(bad)
}

test valid_param_rejects_negative_epoch() {
  let bad =
    PriceParam {
      op_prices: [OpPrice { op_type: 1, base_price: 10_000_000 }],
      demand_mult: q,
      m_min: 500_000_000,
      m_max: 2_000_000_000,
      epoch: -1,
    }
  !valid_param(bad)
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
