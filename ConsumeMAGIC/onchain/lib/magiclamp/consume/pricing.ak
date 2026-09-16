// ConsumeMAGIC pricing — giá CÓ THẨM QUYỀN tính từ PriceParam beacon.
// NORMATIVE: CONTRACT.md §A + §E. Pure BigInt, KHÔNG float.
//
//   required = ⌊ base_price[op_type] × demand_mult × op_count / Q ⌋   (Q=1e9, scale)
//
// GỘP-SÀN MỘT LẦN cho cả tổng. KHÔNG sàn từng lượt rồi nhân:
//   price(op_type) = ⌊ base × demand_mult / Q ⌋  chỉ để HIỂN THỊ cho người dùng.
//   `price(t) × n` vứt phần dư ở mỗi lượt ⇒ thu THIẾU ⇒ vì `Σburns == required` là
//   DẤU BẰNG, tx bị từ chối. Xem docstring `required_for` phía dưới.
// (Comment cũ ở đây ghi `required = price(op_type) × op_count` — sai, và nó nằm đúng
//  chỗ người ta liếc trước khi đọc thân hàm.)
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

/// TRẦN TRÊN của `base_price` — 10¹² nanogic = 1.000 MAGIC cho MỘT đơn vị nghiệp vụ.
/// (Hạ từ 10¹⁴ ngày 2026-09-12 — lý do đầy đủ ở khối "CON SỐ" bên dưới.)
///
/// VÌ SAO CẦN: trước bản vá này `valid_param` chỉ có ràng buộc DƯỚI (`base_price >= 0`
/// và GATE `base_price * m_min >= q`). Cả hai chặn giá tụt về 0 (drain miễn phí); KHÔNG
/// cái nào chặn giá vọt lên. Một `PostPrice` hợp lệ đặt `base_price = 2⁶³` cho `op_type=7`
/// (`did.rotate`) là KHOÁ quyền xoay khoá của mọi người — đúng thao tác tự vệ khi nghi lộ
/// khoá. Và không ai lệch ra được: beacon chỉ committee sửa, `consume` bắt buộc đọc beacon
/// còn hạn, không có đường vòng.
///
/// CON SỐ, và vì sao là 10¹² chứ không phải số khác:
///   · Dòng ĐẮT NHẤT trong sổ op_type chuẩn là `did.transfer` = 10¹⁰ nanogic
///     (`ConsumeMAGIC/CONTRACT.md`, bảng op_type). Trần này = 100× dòng đó.
///   · `base_price` là giá MỘT ĐƠN VỊ; khối lượng đi qua `op_count`. Lưu 1 TB không cần
///     base_price to — nó là `op_count = 1.048.576` ở base 10⁹. Nên trần chỉ phải phủ
///     "đơn vị đắt nhất", KHÔNG phải "giao dịch đắt nhất".
///   · Phép thử "đắt hay KHOÁ" là một TỶ LỆ, không phải một lượng: giá-một-đơn-vị ở
///     `m_max` chia cho sản lượng MAGIC toàn mạng mỗi epoch. Trần LAMP khoá được là 20%
///     cung (`PARTICIPATION_CAP_BPS = 2000`) = 7,2×10⁹ LAMP.
///
///     🔴 BẢN TRƯỚC CỦA ĐOẠN NÀY KẾT LUẬN "chưa phải khoá" BẰNG MỘT PHÉP TÍNH THIẾU MỘT
///     THỪA SỐ BẰNG `L` — sửa 2026-09-12. Chỗ sai: nó lấy `ρ = R·S(L)·10⁻¹²` làm "rate
///     mỗi epoch". `ρ` KHÔNG phải rate mỗi epoch — nó là MAGIC trên mỗi LAMP-khoá cho
///     TRỌN vòng đời lịch `L` epoch. Rate mỗi epoch là `ρ/L`.
///     Đối chứng bằng vector chuẩn TV-SCH-02 (`ScheduleGen/.../math.ak` ▸ `compute_m_i`):
///     λ=4000 LAMP · L=100 ⟹ khoá 400.000 LAMP, mỗi epoch ra 45 MAGIC
///     ⟹ suất thật = 45/400.000 = 1,125×10⁻⁴ = ρ/L, với ρ = 0,01125. Tỷ số đúng bằng L.
///
///     Số đúng, cả hai chế độ `L` ở hai đầu mút (`S(L)` đơn điệu nên đây là dải đầy đủ):
///       L=200: sản lượng toàn mạng = 7,2×10⁹ × 0,013125/200 = 4,725×10⁵ MAGIC/epoch
///              ⟹ 10⁻² của nó = 4.725 MAGIC.   Vế trái 200.000 ⟹ VƯỢT 42,3×.
///       L=10 : sản lượng toàn mạng = 7,2×10⁹ × 0,008/10     = 5,76×10⁶ MAGIC/epoch
///              ⟹ 10⁻² của nó = 57.600 MAGIC.  Vế trái 200.000 ⟹ VƯỢT 3,5×.
///     Vượt ở CẢ HAI đầu mút ⟹ ở 10¹⁴ bất biến cuối khối này KHÔNG thoả. Ở giá trần,
///     một đơn vị nghiệp vụ ăn 42% (L=200) sản lượng MAGIC mỗi epoch của TOÀN MẠNG —
///     theo đúng phép thử ngay trên, đó là KHOÁ, không phải đắt.
///
///     ⟹ HẠ VỀ 10¹², chủ dự án chốt 2026-09-12. Đây là hằng BIÊN DỊCH: đổi nó là đổi
///     script hash ⟹ phải deploy lại và công bố ref-script CIP-33 mới cho `consume`.
///
///     🔴 VÀ MỘT ĐÍNH CHÍNH TRONG CHÍNH KHỐI NÀY: bản 2026-09-12 sáng viết *"mức thoả ở
///     ca chặt nhất là 10¹² (dư 4,7×)"*. Con số 4,7× đó BỎ QUÊN thừa số `m_max_q / q = 2`
///     ở vế trái — đúng cái vế mà bất biến viết ra ngay bên dưới. Dư địa thật:
///       vế trái  = 10¹² × 2 / 10⁹      = 2.000 MAGIC
///       vế phải  = 4.725×10⁵ / 100     = 4.725 MAGIC   (ca chặt nhất, L=200)
///       ⟹ thoả, dư **2,36×** — không phải 4,7×.
///     Nêu ra vì đây là lần thứ HAI cùng một khối văn bản mất một thừa số, và cả hai lần
///     đều mất ở vế đang được rút gọn để đọc cho nhanh. Bậc 10¹³ cho vế trái 20.000 > 4.725
///     ⟹ trượt. Nên 10¹² là bậc mười LỚN NHẤT còn thoả, không phải một lựa chọn thoải mái.
///   · HỒ SƠ vì sao 10¹¹/10¹² từng bị loại — và vì sao lý do đó KHÔNG còn đứng:
///     lập luận cũ là chúng sống được hôm nay nhưng chết nếu suất sinh ngả về
///     ρ = 1 MAGIC/LAMP/epoch (SPEC §"RATE_REF_Q"). D2 ĐÃ CHỐT 2026-09-05
///     (`DevStatus.md` ▸ D2): chuẩn hoá bằng cách kéo InstantGen XUỐNG suất ScheduleGen,
///     KHÔNG nâng lên ρ=1 ⟹ điều kiện đó không kích hoạt. Cộng với hệ số `L` vừa sửa ở
///     trên, 10¹² không những sống được mà còn là mức DUY NHẤT trong dải đang bàn thoả
///     được bất biến ở cuối khối này. Nói gọn: cả hai chân của lập luận loại 10¹² đều đã
///     đổ, một chân vì quyết định, một chân vì số học.
///     Đã loại 10¹⁵: một đơn vị ở m_max ăn ~2% sản lượng MAGIC/epoch của cả mạng theo
///     phép tính CŨ — với hệ số `L` đã sửa thì con số thật còn tệ hơn.
///   · Lập luận "làm tròn LÊN cho rộng" ở bản trước đọc bất đối xứng chi phí đúng chiều
///     nhưng áp sai chỗ: thêm dư địa cho một BACKSTOP quả thật tốn 0 phép tính, nhưng nó
///     KHÔNG tốn 0 về an toàn — mỗi bậc 10× nới thêm là một bậc committee đặt được một
///     giá khoá cả mạng. Dư địa rẻ khi trần chỉ chặn thảm hoạ; nó hết rẻ đúng lúc trần
///     vượt qua ngưỡng KHOÁ. Đó là chỗ phép tính thiếu `L` che mất.
///
/// ĐÂY LÀ BACKSTOP CHỐNG THẢM HOẠ, KHÔNG PHẢI KHOẢNG GIÁ GỢI Ý. Đừng đọc "1e13 vẫn dưới
/// trần mà" thành lý do đặt giá cao. Bảng mẫu đang deploy dùng 10⁹.
///
/// 🔴 TRẦN NÀY VẪN KHÔNG CỨU ĐƯỢC `did.rotate` — hạ trần chỉ làm đòn rẻ đi, không gỡ được.
/// Ở 10¹², xoay khoá tốn 2.000 MAGIC ở `m_max` (trước là 200.000). Rẻ hơn 100 lần, nhưng
/// phép thử không phải "bao nhiêu tiền", mà là "người nắm mức tối thiểu sinh được bao nhiêu
/// mỗi epoch": `min_instant_holding` (`InstantGen/.../constants.ak`) sinh ra một phần rất
/// nhỏ của 2.000 MAGIC mỗi epoch ⇒ vẫn khoá tuyệt đối. Phòng
/// tuyến đúng cho thao tác an ninh là một DẢI op_type dành riêng với trần thứ hai chặt hơn,
/// cũng ở lúc biên dịch. Đó là việc khác, còn mở — xem `DevStatus.md` Nợ #43.
///
/// BẤT BIẾN — nay ĐƯỢC MỘT BÀI KIỂM GHIM, không còn là văn xuôi:
///   `max_base_price × m_max_q / q  ≤  10⁻²  ×  (LAMP_khoá_tối_đa × ρ(L) / L)`
///
/// Bài ghim: `max_base_price_duoi_nguong_khoa_toan_mang` ở cuối tệp này. Trước 2026-09-12
/// bất biến này chỉ tồn tại dưới dạng CHỮ, và đó đúng là lý do nó trôi mất một thừa số
/// trong hai bản liên tiếp mà không gì đỏ. Đổi bất kỳ vế nào ⟹ bài đó đỏ.
///
/// `/ L` là phần bản trước THIẾU. Viết đủ chữ để không ai rút gọn nó đi lần nữa:
///   `ρ(L) = snapshot_base_rate_q × S(L) × 10⁻¹²` là MAGIC trên mỗi LAMP-khoá cho TRỌN
///   `L` epoch của một lịch, KHÔNG phải cho một epoch. Chia `L` mới ra suất mỗi epoch.
/// Đo lại bằng: `ScheduleGen/.../math.ak` ▸ `compute_m_i` với vector TV-SCH-02
///   · đọc ở: tỷ số giữa (MAGIC một lần bắn) và (λ × L) — phải bằng ρ/L, không bằng ρ.
pub const max_base_price: Int = 1_000_000_000_000

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
///   - [VÁ 2026-08-28, Nợ #32] base_price ≤ `max_base_price`: hai điều kiện trên đều là
///     ràng buộc DƯỚI. Không có cận trên thì committee đặt giá tuỳ ý và người dùng không
///     cản được — khoá dịch vụ bằng giá. Xem `max_base_price` để biết con số và giới hạn
///     của nó.
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
    // VÀ base ≤ trần (Nợ #32 — chặn khoá-dịch-vụ-bằng-giá; xem `max_base_price`)
    list.all(
      pp.op_prices,
      fn(op) {
        and {
          op.base_price >= 0,
          op.base_price * pp.m_min >= q,
          op.base_price <= max_base_price,
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

test valid_param_cap_accepts_at_ceiling() {
  // Biên TRẦN (Nợ #32): base_price ĐÚNG BẰNG max_base_price → còn hợp lệ.
  // Kiểm ở đúng biên vì `<=` và `<` chỉ khác nhau tại đúng điểm này.
  let ok =
    PriceParam {
      op_prices: [OpPrice { op_type: 1, base_price: max_base_price }],
      demand_mult: q,
      m_min: 500_000_000,
      m_max: 2_000_000_000,
      epoch: 100,
    }
  valid_param(ok)
}

test valid_param_cap_rejects_one_above_ceiling() {
  // Biên TRẦN + 1 nanogic → từ chối. Một nanogic là khoảng cách nhỏ nhất tồn tại,
  // nên cặp test này ghim `<=` chứ không phải `<`, và ngược lại.
  let bad =
    PriceParam {
      op_prices: [OpPrice { op_type: 1, base_price: max_base_price + 1 }],
      demand_mult: q,
      m_min: 500_000_000,
      m_max: 2_000_000_000,
      epoch: 100,
    }
  !valid_param(bad)
}

test valid_param_cap_rejects_lock_the_service_price() {
  // Ca thật mà trần này sinh ra để chặn: committee đặt giá khổng lồ cho op_type=7
  // (`did.rotate`) ⇒ khoá quyền xoay khoá của mọi người. 2⁶³ vẫn là số hợp lệ với
  // Aiken (Int là số nguyên lớn tuỳ ý) — không có gì tự chặn nó ngoài trần này.
  let bad =
    PriceParam {
      op_prices: [
        OpPrice { op_type: 1, base_price: 10_000_000 },
        OpPrice { op_type: 7, base_price: 9_223_372_036_854_775_807 },
      ],
      demand_mult: q,
      m_min: 500_000_000,
      m_max: 2_000_000_000,
      epoch: 100,
    }
  !valid_param(bad)
}

test valid_param_cap_rejects_one_bad_row_among_good() {
  // Trần áp cho MỌI dòng, không phải dòng đầu. Dòng cuối vượt trần ⇒ cả bảng hỏng.
  let bad =
    PriceParam {
      op_prices: [
        OpPrice { op_type: 1, base_price: 10_000_000 },
        OpPrice { op_type: 2, base_price: 1_000_000 },
        OpPrice { op_type: 8, base_price: max_base_price + 1 },
      ],
      demand_mult: q,
      m_min: 500_000_000,
      m_max: 2_000_000_000,
      epoch: 100,
    }
  !valid_param(bad)
}

test valid_param_cap_leaves_headroom_for_dearest_standard_row() {
  // Dòng đắt nhất trong sổ op_type chuẩn (`did.transfer` = 1e10 nanogic) phải còn
  // xa trần — nếu test này đỏ thì trần đã đặt quá thấp và sổ giá sắp không dùng
  // được, chứ không phải test sai.
  //
  // Hệ số 10.000× của bản trước KHÔNG suy ra từ đâu cả: nó là "cho thật rộng" viết
  // thành số, và nó chỉ sống được vì trần lúc ấy là 10¹⁴ — tức nó đo cái trần chứ
  // không ràng buộc cái trần. Hạ trần về 10¹² (2026-09-12) làm nó đỏ, và đó là bằng
  // chứng duy nhất ta có rằng nó từng ràng buộc thứ gì: nó ràng buộc SAI CHIỀU.
  //
  // Hệ số mới là 100×, và nó có nguồn: cận TRÊN thật của trần là bất biến chống-khoá
  // (`max_base_price_below_network_lock_threshold` ngay dưới) cho 10¹², cận DƯỚI là
  // dòng đắt nhất trong sổ. Hai cận kẹp lại chỉ còn đúng hai bậc mười — nên bài này
  // nay là một cái kẹp thật, không phải một con số cho đẹp.
  let dearest_standard = 10_000_000_000
  max_base_price >= dearest_standard * 100
}

/// Bất biến chống-KHOÁ-toàn-mạng, viết ở docstring `max_base_price` từ 2026-08-28 nhưng
/// tới 2026-09-12 mới có bài kiểm. Đúng khoảng trống đó là chỗ nó mất một thừa số bằng
/// `L` qua hai bản liên tiếp mà không gì đỏ — văn xuôi không tự kiểm được chính nó.
///
///   `max_base_price × m_max_q / q  ≤  10⁻² × (LAMP_khoá_tối_đa × ρ(L) / L)`
///
/// 🔶 BA HẰNG DƯỚI ĐÂY LÀ BẢN CHÉP, không phải nguồn. Nguồn ở kho ScheduleGen, và
/// `magiclamp/consume` KHÔNG phụ thuộc `magiclamp/protocol` (hai `aiken.toml` rời) nên
/// không import được — đây là mức 3 "chép có nhãn", không phải lười:
///   · `snapshot_base_rate_q` ← `ScheduleGen/onchain/lib/magiclamp/protocol/constants.ak`
///   · hệ số đoạn 3 của `S_Q`  ← cùng tệp đó (`s_seg3_intercept_q`, `s_seg3_slope_q`)
///   · chép ngày 2026-09-12, đối chứng bằng `compute_rate_locked_q(R, 200)`.
/// Bên nguồn có bài ghim cùng con số (`rate_at_max_length_mirrored_in_consumemagic`),
/// nên đổi hằng bên đó làm ĐỎ bên đó kèm câu chỉ thẳng sang tệp này.
///
/// Vì sao lấy `L = 200`: vế phải tỷ lệ với `ρ(L)/L = R·S_Q(L)/(10¹²·L)`, mà `S_Q` tăng
/// dưới-tuyến-tính ⟹ `ρ/L` GIẢM theo `L` ⟹ `L` lớn nhất là ca chặt nhất. 200 là trần
/// độ dài lịch. Ở `L = 10` vế phải rộng hơn 12,2×, nên ghim ca chặt là đủ cho cả dải.
test max_base_price_below_network_lock_threshold() {
  // 20% cung LAMP (`PARTICIPATION_CAP_BPS = 2000` trên trần 36 tỷ), tính bằng oildrop.
  let lamp_cap_oildrop = 7_200_000_000 * 1_000_000
  let longest_schedule = 200
  // S_Q(200) trên đoạn 3: intercept 2,5e9 + slope 2,5e6 × (200 − 150)
  let s_q_longest = 2_500_000_000 + 2_500_000 * ( longest_schedule - 150 )
  let rate_q = 5_000_000_000 * s_q_longest / q
  // Sản lượng MAGIC (nanogic) mỗi epoch của TOÀN MẠNG nếu khoá hết trần tham gia.
  let network_output_per_epoch =
    lamp_cap_oildrop * rate_q / q / longest_schedule
  and {
    // Ghim từng bước, để khi bài đỏ thì biết ĐỎ Ở BƯỚC NÀO chứ không chỉ biết "sai".
    s_q_longest == 2_625_000_000,
    rate_q == 13_125_000_000,
    network_output_per_epoch == 472_500_000_000_000,
    // Vế trái: giá MỘT đơn vị nghiệp vụ ở trần, tại demand cao nhất.
    max_base_price * m_max_q / q <= network_output_per_epoch / 100,
  }
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
