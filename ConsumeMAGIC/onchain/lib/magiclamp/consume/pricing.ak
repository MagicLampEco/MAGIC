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

/// Trần số dòng trong bảng giá `op_prices`.
///
/// VÌ SAO CẦN CAP: `valid_param` chạy MỘT LẦN / Engage input (mỗi invocation của
/// consume.spend). Không cap ⇒ committee (hoặc kẻ chiếm committee) post bảng vài
/// nghìn dòng ⇒ MỌI tx consume vượt ex-unit ⇒ DoS toàn cơ chế, không hạ được vì
/// beacon chỉ sửa được bởi chính committee.
///
/// VÌ SAO 16 — chọn theo SỐ ĐO `aiken check`, không theo cảm giác. Chi phí
/// `valid_param` trên bảng ĐẦY (gồm cả dựng list trong test):
///     n= 8 → 339 K mem /  111 M cpu
///     n=12 → 601 K mem /  199 M cpu
///     n=16 → 940 K mem /  314 M cpu
///     n=24 → 1.84 M mem /  625 M cpu
///     n=32 → 3.05 M mem / 1.04 B cpu
///   Trần tx Cardano: 14 M mem / 10 B cpu. Ràng buộc BINDING là MEM, không phải CPU.
///   Ở n=16, một tx gộp 3 Engage input trả ~2.8 M mem (20% ngân sách) riêng cho việc
///   kiểm bảng giá — còn chỗ cho phần còn lại của validator (tx 2-engage hiện đo
///   2.00 M mem tổng). Ở n=32, chỉ riêng 2 invocation đã ngốn ~6.1 M (44%) ⇒ LOẠI.
///   MVP dùng 2 loại nghiệp vụ ⇒ 16 vẫn dư 8× cho mở rộng.
///
/// Cap này nằm DƯỚI trần ledger thật (16 dòng ≈ 256 byte datum, xa trần datum-size)
/// ⇒ nó thực sự ràng buộc, không phải cap trang trí đặt TRÊN trần thật.
pub const max_op_prices: Int = 16

/// Tìm base_price cho op_type trong bảng giá. None nếu op_type không tồn tại.
/// AN TOÀN nhờ `valid_param` đã ép bảng giá TĂNG NGẶT theo op_type — nếu không,
/// `list.find` lấy dòng ĐẦU trong khi bản off-chain viết bằng map (last-wins) lấy
/// dòng CUỐI ⇒ hai phía lệch giá im lặng.
pub fn lookup_base(op_prices: List<OpPrice>, op_type: Int) -> Option<Int> {
  when list.find(op_prices, fn(p) { p.op_type == op_type }) is {
    Some(p) -> Some(p.base_price)
    None -> None
  }
}

/// [VÁ 2026-08-09 #C] Bảng giá phải TĂNG NGẶT theo `op_type`.
///
/// Thay cho `distinct_op_types` (phân biệt đôi một, O(n²)). Hai cái lợi, không mất gì:
///   1) O(n) thay O(n²) — `valid_param` chạy MỘT LẦN / Engage input nên đây là chi phí
///      nhân theo số input.
///   2) DẠNG CHUẨN TẮC: một tập op_type chỉ có ĐÚNG MỘT cách viết hợp lệ ⇒ off-chain
///      KHÔNG sinh nổi bảng nhập nhằng (thứ tự khác nhau = bảng khác nhau), và tăng
///      ngặt đã BAO HÀM "không trùng" (a < b ⇒ a ≠ b).
/// Đổi lại: off-chain BẮT BUỘC sắp xếp bảng giá theo op_type tăng dần trước khi post.
pub fn sorted_strict_op_types(op_prices: List<OpPrice>) -> Bool {
  when op_prices is {
    [] -> True
    [x, ..rest] -> increasing_after(x.op_type, rest)
  }
}

fn increasing_after(prev: Int, rest: List<OpPrice>) -> Bool {
  when rest is {
    [] -> True
    [x, ..tail] -> x.op_type > prev && increasing_after(x.op_type, tail)
  }
}

/// Bất biến datum PriceParam (C-CM-2 defense-in-depth, CONTRACT §E "mọi giá trị ≥ 0"):
///   BAND TUYỆT ĐỐI: m_min == m_min_q ∧ m_max == m_max_q (pin, chống band-escape #1b);
///   0 ≤ m_min ≤ m_max ; m_min ≤ demand_mult ≤ m_max ; epoch ≥ 0 ; MỌI base_price ≥ 0;
///   BẢNG GIÁ: len(op_prices) ≤ max_op_prices ∧ op_type TĂNG NGẶT (dạng chuẩn tắc);
///   GATE-giá-tối-thiểu: MỌI op có base_price × m_min ≥ q.
/// Lý do các tầng:
///   - Pin m_min/m_max: PostPrice cẩu thả đặt m_max khổng lồ ⇒ price = base×demand/q nổ
///     ~1e6× (verified). Check tương-đối (m_min≤demand≤m_max) KHÔNG chặn được vì demand
///     cũng theo m_max. Phải neo về HẰNG compile-time.
///   - GATE base×m_min ≥ q: bảo đảm giá 1 đơn-vị ở demand THẤP NHẤT ≥ 1 nanogic
///     (⌊base×m_min/q⌋ ≥ 1) ⇒ đóng collapse-to-0 (#1b): base quá nhỏ ⇒ giá làm tròn về 0
///     ⇒ drain miễn phí.
///     [VÁ 2026-08-09] BỎ ngoại lệ `base_price == 0`. Nó là NHÁNH CHẾT: consume ép
///     `required > 0` nên dòng giá 0 luôn bị từ chối ở tầng trên; giữ lại chỉ tạo ảo
///     giác "có dòng miễn phí" và mở một lối rẽ số-học không ai đi. Mọi dòng đều phải
///     qua GATE ⇒ nhất quán với `required > 0`, ít nhánh hơn, dễ soi hơn.
///   - base_price ≥ 0: giá âm → required âm → burn=0 thoả "≥ required" (drain miễn phí).
///     (Sau khi bỏ ngoại lệ base==0, điều kiện này bị GATE bao hàm — giữ làm belt.)
///   - [VÁ 2026-08-09] cap độ dài + op_type TĂNG NGẶT: xem `max_op_prices` /
///     `sorted_strict_op_types`. Trùng op_type ⇒ on-chain `list.find` lấy dòng ĐẦU,
///     off-chain viết bằng map lấy dòng CUỐI ⇒ hai phía lệch giá (10×) mà KHÔNG bên nào
///     báo lỗi. Tăng ngặt bao hàm "không trùng" và loại luôn bảng cùng-tập-khác-thứ-tự.
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
    // BẢNG GIÁ: có trần (ex-unit bị chặn) + khoá tra cứu KHÔNG nhập nhằng
    list.length(pp.op_prices) <= max_op_prices,
    sorted_strict_op_types(pp.op_prices),
    // per-op: base ≥ 0 VÀ giá ≥ 1 nanogic ở demand thấp nhất (#1b, không ngoại lệ)
    list.all(
      pp.op_prices,
      fn(op) {
        and {
          op.base_price >= 0,
          op.base_price * pp.m_min >= q,
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

// ── VÁ 2026-08-09 #7: bảng giá phải có TRẦN + op_type PHÂN BIỆT ────────────────

test valid_param_rejects_duplicate_op_type() {
  // [{1,10M},{1,99M}] TRƯỚC vá đi qua valid_param: on-chain lookup_base lấy dòng ĐẦU
  // (10M), off-chain viết bằng map/fromEntries lấy dòng CUỐI (99M) ⇒ lệch ~10×, khớp
  // được chỉ là TÌNH CỜ do cả hai cùng dùng `.find`. Sau vá: reject tận gốc.
  let bad =
    PriceParam {
      op_prices: [
        OpPrice { op_type: 1, base_price: 10_000_000 },
        OpPrice { op_type: 1, base_price: 99_000_000 },
      ],
      demand_mult: q,
      m_min: 500_000_000,
      m_max: 2_000_000_000,
      epoch: 100,
    }
  !valid_param(bad)
}

/// Bảng giá n dòng, op_type = 1..n TĂNG NGẶT (dạng chuẩn tắc), base hợp GATE.
/// (Bản cũ dùng `list.push` nên sinh ra bảng GIẢM dần — hợp lệ với luật "phân biệt
/// đôi một" nhưng vi phạm luật "tăng ngặt" mới. Phải nối vào ĐUÔI.)
fn mk_ops(n: Int) -> List<OpPrice> {
  if n <= 0 {
    []
  } else {
    list.concat(mk_ops(n - 1), [OpPrice { op_type: n, base_price: 10_000_000 }])
  }
}

fn pp_with_ops(ops: List<OpPrice>) -> PriceParam {
  PriceParam {
    op_prices: ops,
    demand_mult: q,
    m_min: 500_000_000,
    m_max: 2_000_000_000,
    epoch: 100,
  }
}

test valid_param_accepts_max_op_prices() {
  // Biên: đúng max_op_prices dòng → còn hợp lệ.
  valid_param(pp_with_ops(mk_ops(max_op_prices)))
}

test valid_param_rejects_too_many_op_prices() {
  // max_op_prices + 1 → reject (chặn bảng giá phình → DoS ex-unit mọi tx consume).
  !valid_param(pp_with_ops(mk_ops(max_op_prices + 1)))
}

// ── VÁ 2026-08-09 #8: base_price == 0 là NHÁNH CHẾT → cấm hẳn ──────────────────

test valid_param_rejects_zero_base_price() {
  // Trước vá: valid_param CHO PHÉP (ngoại lệ "dòng miễn phí"), nhưng consume.ak ép
  // `required > 0` nên op này KHÔNG BAO GIỜ dùng được → nhánh chết, gây hiểu nhầm.
  let bad =
    PriceParam {
      op_prices: [
        OpPrice { op_type: 1, base_price: 10_000_000 },
        OpPrice { op_type: 2, base_price: 0 },
      ],
      demand_mult: q,
      m_min: 500_000_000,
      m_max: 2_000_000_000,
      epoch: 100,
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

// ── VÁ 2026-08-09 #C: bảng giá phải TĂNG NGẶT theo op_type (dạng chuẩn tắc) ────

test valid_param_rejects_unsorted_op_types() {
  // Cùng TẬP op_type {1,2} nhưng viết ngược thứ tự. Trước vá: hợp lệ (phân biệt đôi
  // một là đủ) ⇒ off-chain sinh được HAI bảng khác nhau cho cùng một biểu giá, và
  // `list.find` on-chain phụ thuộc thứ tự. Sau vá: chỉ MỘT cách viết hợp lệ → reject.
  let bad =
    PriceParam {
      op_prices: [
        OpPrice { op_type: 2, base_price: 1_000_000 },
        OpPrice { op_type: 1, base_price: 10_000_000 },
      ],
      demand_mult: q,
      m_min: 500_000_000,
      m_max: 2_000_000_000,
      epoch: 100,
    }
  !valid_param(bad)
}

test valid_param_accepts_sorted_op_types() {
  // Đối chứng: đúng tập đó, sắp xếp tăng dần → hợp lệ.
  valid_param(pp_mvp(q))
}

test valid_param_rejects_equal_neighbour_op_types() {
  // Trùng op_type ở hai dòng LIỀN KỀ: tăng NGẶT (>) đã bao (không cần luật riêng).
  let bad =
    PriceParam {
      op_prices: [
        OpPrice { op_type: 1, base_price: 10_000_000 },
        OpPrice { op_type: 1, base_price: 99_000_000 },
        OpPrice { op_type: 2, base_price: 1_000_000 },
      ],
      demand_mult: q,
      m_min: 500_000_000,
      m_max: 2_000_000_000,
      epoch: 100,
    }
  !valid_param(bad)
}

test sorted_strict_op_types_edge_cases() {
  // Bảng rỗng và bảng 1 dòng: hợp lệ theo định nghĩa (không có cặp nào để so).
  sorted_strict_op_types([]) && sorted_strict_op_types(
    [OpPrice { op_type: 7, base_price: 10_000_000 }],
  )
}
