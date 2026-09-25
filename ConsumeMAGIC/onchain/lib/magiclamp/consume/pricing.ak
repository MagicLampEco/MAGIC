// ConsumeMAGIC pricing — giá CÓ THẨM QUYỀN tính từ PriceParam beacon.
// NORMATIVE: CONTRACT.md §A + §E. Pure BigInt, KHÔNG float.
//
//   required = ⌊ base_price[op_type] × demand_mult[op_type] × op_count / Q ⌋  (Q=1e9)
//
// `demand_mult` đọc từ CHÍNH DÒNG giá (`op.demand_mult`), không còn một giá trị chung
// ở mức `PriceParam` — `CC-LOAD-COUNT-UNIT`, chốt 2026-09-24 (CONTRACT.md §A).
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

/// Những `op_type` bị ép GIÁ CỐ ĐỊNH: `demand_mult` của dòng đó PHẢI đúng bằng `q`
/// (1.0×), nên giá của chúng KHÔNG nhúc nhích theo tải.
///
/// VÌ SAO — `op_type = 7` (`did.rotate`) là THAO TÁC AN NINH, không phải một dịch vụ
/// tính tiền theo cung-cầu. Hai chiều hỏng, cả hai đều nằm ở CHIỀU chứ không ở ĐỘ LỚN
/// (trần `m_max = 2.0×` chặn được độ lớn, không chặn được chiều) — xem khối
/// "🔴 `op_type=7` đang bị định giá SAI" trong `ConsumeMAGIC/CONTRACT.md §A`:
///   (a) ai bơm một mã RẺ với khối lượng lớn cũng đẩy hệ số của mã 7 lên trần, không
///       cần biết PhoenixKey tồn tại — sau `CC-LOAD-COUNT-UNIT` thì bộ đếm đã tách
///       theo mã nên đường này đã hẹp lại, nhưng nó chỉ hẹp vì bộ đếm, không vì luật;
///   (b) một đợt lộ khoá hàng loạt khiến nhiều người cùng Rotate ⇒ tải của CHÍNH mã 7
///       tăng ⇒ Rotate đắt lên. Việc cần gấp nhất thành đắt nhất đúng lúc cần rẻ nhất,
///       và nó TỰ KHUẾCH ĐẠI. Bộ đếm tách theo mã KHÔNG cứu được ca (b) — chỉ luật này
///       cứu được. Đó là lý do hai thay đổi đi CÙNG một lượt.
///
/// Hình dạng đã chọn là DẢI QUY ƯỚC ở lúc BIÊN DỊCH, không phải một cờ `fixed: Bool`
/// trong datum: cờ trong datum là thứ committee tự đặt được, tức là để chính bên bị
/// nghi tự khai mình có bị ràng buộc hay không (cùng họ với "trần để trong datum do
/// cùng khoá ký = trần giả"). Hằng biên dịch nằm trong script hash ⇒ đổi nó là đổi
/// địa chỉ, phải deploy lại và công bố ref-script CIP-33 mới.
///
/// KHÔNG kèm trần `op_count` riêng cho mã cố định: phí xoay khoá tăng theo số lần
/// xoay (dãy Fibonacci ở tầng PhoenixKey) đi vào `op_count`, nên chặn `op_count` là
/// chặn đúng cơ chế chống lạm dụng của bên kia. Chủ dự án chốt.
///
/// `base_price × m_min ≥ q` VẪN áp cho dòng cố định (xem `valid_param`): luật này
/// chặn giá-về-0, nó độc lập với việc hệ số có đứng yên hay không.
pub const fixed_price_op_types: List<Int> = [7]

/// Trần số dòng trong bảng giá `op_prices`.
///
/// VÌ SAO CẦN CAP: `valid_param` chạy MỘT LẦN / Engage input (mỗi invocation của
/// consume.spend). Không cap ⇒ committee (hoặc kẻ chiếm committee) post bảng vài
/// nghìn dòng ⇒ MỌI tx consume vượt ex-unit ⇒ DoS toàn cơ chế, không hạ được vì
/// beacon chỉ sửa được bởi chính committee.
///
/// VÌ SAO 16 — chọn theo SỐ ĐO `aiken check`, không theo cảm giác. Chi phí
/// `valid_param` trên bảng ĐẦY (gồm cả dựng list trong test) — ĐO LẠI 2026-09-25 dưới
/// lược đồ `OpPrice` BA trường (`demand_mult` xuống từng dòng, `CC-LOAD-COUNT-UNIT`):
///     n= 8 →  425 K mem / 135 M cpu
///     n=12 →  676 K mem / 215 M cpu
///     n=16 →  962 K mem / 306 M cpu
///     n=24 → 1.64 M mem / 523 M cpu
///     n=32 → 2.46 M mem / 784 M cpu
///   Trần tx Cardano: 14 M mem / 10 B cpu. Ràng buộc BINDING là MEM, không phải CPU.
///   Ở n=16, một tx gộp 3 Engage input trả ~2.89 M mem (21% ngân sách) riêng cho việc
///   kiểm bảng giá. Ở n=32, chỉ riêng 2 invocation đã ngốn ~4.93 M (35%).
///   MVP dùng 2 loại nghiệp vụ ⇒ 16 vẫn dư 8× cho mở rộng.
///
///   🔴 SỐ ĐỔI, TRẦN KHÔNG ĐỔI — và đừng đọc hai việc đó thành một. Lược đồ mới làm
///   `valid_param` ĐẮT HƠN ở n nhỏ (thêm hai vế band + một vế giá-cố-định cho MỖI dòng:
///   n=8 từ 339 K lên 425 K) nhưng RẺ HƠN ở n lớn (n=32 từ 3.05 M xuống 2.46 M, vì
///   `demand_mult` không còn phải đọc lại từ mức datum trong mỗi vòng). Nên biên của
///   n=32 nới từ 44% xuống 35% ngân sách. Đó là một dữ kiện, KHÔNG phải một lý do nâng
///   trần: trần là một quyết định của chủ dự án, và bảng số này chỉ nói nâng lên thì
///   tốn bao nhiêu, không nói có nên nâng không. Ai muốn nâng thì hỏi, đừng suy từ biên.
///
///   Ex-unit của đường `consume` THẬT (không phải riêng `valid_param`) KHÔNG chép xuống
///   đây: nó là đầu ra của `consume.ak` ▸ `consume_worst_case_full_table_two_engage_happy`,
///   và một bản sao của nó sẽ chết im lặng ở lần đổi cấu trúc kế tiếp. Đo bằng một lệnh
///   `aiken check` rồi đọc `execution_units` của đúng bài đó.
///   (Bản trước của khối này chép một con số "tx 2-engage hiện đo 2.00 M mem tổng" —
///   nó đã lệch thật, và không gì báo.)
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
///     (sổ ở `MagicLampEco/Registry` ▸ `Specs/Resource-Dictionary.md` §2, neo
///     `main@8a23f72` 2026-09-24 — kho này
///     KHÔNG giữ bản chép của dãy số, xem `ConsumeMAGIC/CONTRACT.md §A`).
///     Trần này = 100× dòng đó.
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

/// Tìm DÒNG GIÁ cho op_type trong bảng. None nếu op_type không tồn tại.
/// AN TOÀN nhờ `valid_param` đã ép bảng giá TĂNG NGẶT theo op_type — nếu không,
/// `list.find` lấy dòng ĐẦU trong khi bản off-chain viết bằng map (last-wins) lấy
/// dòng CUỐI ⇒ hai phía lệch giá im lặng.
///
/// Trả cả DÒNG chứ không chỉ `base_price` (đổi 2026-09-25, `CC-LOAD-COUNT-UNIT`):
/// `demand_mult` nay nằm trong chính dòng đó, nên trả một trường rồi đi tra trường
/// kia ở chỗ khác là mở ra một lối cho hai lần tra rơi vào hai dòng khác nhau.
pub fn lookup_row(op_prices: List<OpPrice>, op_type: Int) -> Option<OpPrice> {
  list.find(op_prices, fn(p) { p.op_type == op_type })
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
///   0 ≤ m_min ≤ m_max ; epoch ≥ 0 ; MỌI base_price ≥ 0;
///   BẢNG GIÁ: len(op_prices) ≤ max_op_prices ∧ op_type TĂNG NGẶT (dạng chuẩn tắc);
///   GATE-giá-tối-thiểu: MỌI op có base_price × m_min ≥ q;
///   BAND THEO TỪNG DÒNG: MỌI op có m_min ≤ op.demand_mult ≤ m_max;
///   GIÁ CỐ ĐỊNH: op_type ∈ fixed_price_op_types ⇒ op.demand_mult == q.
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
///   - [CC-LOAD-COUNT-UNIT 2026-09-25] BAND theo TỪNG DÒNG: `demand_mult` rời khỏi
///     mức `PriceParam` xuống `OpPrice`, nên phép kẹp band phải đi xuống theo. Bỏ
///     sót vế này là bỏ luôn thứ DUY NHẤT chặn biên độ một lượt đăng giá — còn lại
///     chỉ `max_base_price` đứng giữa một lượt đăng và một mức giá gấp trăm lần.
///     `m_min`/`m_max` vẫn ghim TUYỆT ĐỐI về hằng ở mức datum (band là thứ dùng
///     chung, không phải thứ mỗi dòng tự khai).
///     🔴 Đường tắt đã LOẠI tường minh: gấp nhu cầu vào thẳng `base_price` cho ra
///     cùng hiệu ứng giá mà KHÔNG đổi lược đồ — và nó PHÁ band, vì band chỉ kẹp
///     `demand_mult`, không kẹp `base_price`.
///   - [CC-LOAD-COUNT-UNIT 2026-09-25] GIÁ CỐ ĐỊNH cho `fixed_price_op_types`: xem
///     hằng đó và `demand_mult_pinned_if_fixed`.
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
    pp.epoch >= 0,
    // BẢNG GIÁ: có trần (ex-unit bị chặn) + khoá tra cứu KHÔNG nhập nhằng
    list.length(pp.op_prices) <= max_op_prices,
    sorted_strict_op_types(pp.op_prices),
    // per-op: base ≥ 0 VÀ giá ≥ 1 nanogic ở demand thấp nhất (#1b, không ngoại lệ)
    // VÀ base ≤ trần (Nợ #32 — chặn khoá-dịch-vụ-bằng-giá; xem `max_base_price`)
    // VÀ demand_mult của CHÍNH DÒNG nằm trong band (CC-LOAD-COUNT-UNIT)
    // VÀ dòng thuộc `fixed_price_op_types` có demand_mult ĐÚNG BẰNG q.
    list.all(
      pp.op_prices,
      fn(op) {
        and {
          op.base_price >= 0,
          op.base_price * pp.m_min >= q,
          op.base_price <= max_base_price,
          op.demand_mult >= pp.m_min,
          op.demand_mult <= pp.m_max,
          demand_mult_pinned_if_fixed(op),
        }
      },
    ),
  }
}

/// Dòng có `op_type` thuộc `fixed_price_op_types` ⇒ `demand_mult` PHẢI == `q` (1.0×).
/// Dòng khác ⇒ luật này không nói gì (band ở chỗ gọi vẫn áp).
///
/// Viết thành hàm riêng thay vì nhét vào biểu thức `and` để cổng này có MỘT CÁI TÊN
/// tra được — đột biến nó thành `True` là phép đo trực tiếp xem nó có đang canh gì
/// không, không phải sửa một vế lẫn trong sáu vế.
pub fn demand_mult_pinned_if_fixed(op: OpPrice) -> Bool {
  if list.has(fixed_price_op_types, op.op_type) {
    op.demand_mult == q
  } else {
    True
  }
}

/// Giá 1 đơn vị nghiệp vụ op_type theo beacon (nanogic). Floor division (BigInt).
/// Đơn điệu không-giảm theo demand_mult; bị chặn [base×m_min/Q, base×m_max/Q].
pub fn price_of(pp: PriceParam, op_type: Int) -> Option<Int> {
  when lookup_row(pp.op_prices, op_type) is {
    Some(op) -> Some(op.base_price * op.demand_mult / q)
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
  when lookup_row(pp.op_prices, op_type) is {
    Some(op) -> Some(op.base_price * op.demand_mult * op_count / q)
    None -> None
  }
}

// ── Tests thuần (số học giá) ──────────────────────────────────

fn pp_mvp(demand: Int) -> PriceParam {
  PriceParam {
    op_prices: [
      OpPrice { op_type: 1, base_price: 10_000_000, demand_mult: demand },  // ảnh 0.01 MAGIC
      OpPrice { op_type: 2, base_price: 1_000_000, demand_mult: demand },    // CID 0.001 MAGIC
    ],
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
      op_prices: [OpPrice { op_type: 1, base_price: 1_000_000, demand_mult: 1_333_333_333 }],
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
  // demand_mult > m_max → datum không hợp lệ. Sau CC-LOAD-COUNT-UNIT, `pp_mvp` đặt
  // hệ số vào TỪNG DÒNG, nên bài này nay đo BAND-THEO-DÒNG chứ không còn đo một
  // trường ở mức datum — cùng câu chữ, khác chỗ cưỡng chế.
  !valid_param(pp_mvp(3_000_000_000))
}

test valid_param_gate_rejects_tiny_base() {
  // FIX #1b (collapse-to-0): base_price=1, ở demand=m_min(0.5×) → ⌊1×5e8/1e9⌋ = 0
  // ⇒ giá 0 ⇒ drain miễn phí. GATE base×m_min ≥ q: 1×5e8 = 5e8 < 1e9 → reject.
  let bad =
    PriceParam {
      op_prices: [OpPrice { op_type: 1, base_price: 1, demand_mult: q }],
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
      op_prices: [OpPrice { op_type: 1, base_price: 2, demand_mult: q }],
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
      op_prices: [OpPrice { op_type: 1, base_price: max_base_price, demand_mult: q }],
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
      op_prices: [OpPrice { op_type: 1, base_price: max_base_price + 1, demand_mult: q }],
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
        OpPrice { op_type: 1, base_price: 10_000_000, demand_mult: q },
        OpPrice { op_type: 7, base_price: 9_223_372_036_854_775_807, demand_mult: q },
      ],
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
        OpPrice { op_type: 1, base_price: 10_000_000, demand_mult: q },
        OpPrice { op_type: 2, base_price: 1_000_000, demand_mult: q },
        OpPrice { op_type: 8, base_price: max_base_price + 1, demand_mult: q },
      ],
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
      op_prices: [OpPrice { op_type: 1, base_price: 10_000_000, demand_mult: q }],
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
      op_prices: [OpPrice { op_type: 1, base_price: 10_000_000, demand_mult: 2_000_000_000_000_000 }],
      m_min: 500_000_000,
      m_max: 2_000_000_000_000_000,
      epoch: 100,
    }
  !valid_param(bad)
}

test valid_param_rejects_negative_epoch() {
  let bad =
    PriceParam {
      op_prices: [OpPrice { op_type: 1, base_price: 10_000_000, demand_mult: q }],
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
        OpPrice { op_type: 1, base_price: 10_000_000, demand_mult: q },
        OpPrice { op_type: 1, base_price: 99_000_000, demand_mult: q },
      ],
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
    list.concat(
      mk_ops(n - 1),
      [OpPrice { op_type: n, base_price: 10_000_000, demand_mult: q }],
    )
  }
}

fn pp_with_ops(ops: List<OpPrice>) -> PriceParam {
  PriceParam {
    op_prices: ops,
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
        OpPrice { op_type: 1, base_price: 10_000_000, demand_mult: q },
        OpPrice { op_type: 2, base_price: 0, demand_mult: q },
      ],
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
        OpPrice { op_type: 1, base_price: 10_000_000, demand_mult: q },
        OpPrice { op_type: 2, base_price: -1, demand_mult: q },   // dòng giá âm
      ],
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
        OpPrice { op_type: 2, base_price: 1_000_000, demand_mult: q },
        OpPrice { op_type: 1, base_price: 10_000_000, demand_mult: q },
      ],
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
        OpPrice { op_type: 1, base_price: 10_000_000, demand_mult: q },
        OpPrice { op_type: 1, base_price: 99_000_000, demand_mult: q },
        OpPrice { op_type: 2, base_price: 1_000_000, demand_mult: q },
      ],
      m_min: 500_000_000,
      m_max: 2_000_000_000,
      epoch: 100,
    }
  !valid_param(bad)
}

test sorted_strict_op_types_edge_cases() {
  // Bảng rỗng và bảng 1 dòng: hợp lệ theo định nghĩa (không có cặp nào để so).
  sorted_strict_op_types([]) && sorted_strict_op_types(
    [OpPrice { op_type: 7, base_price: 10_000_000, demand_mult: q }],
  )
}

// ── PROBE đo ex-unit cho đường cong `max_op_prices` ───────────────────────────
//
// Số trong docstring `max_op_prices` SINH RA TỪ ĐÂY. Trước 2026-09-25 khối số ấy
// không có bài nào đứng sau: nó là một dãy chép tay, và một dãy chép tay thì không ai
// biết nó đã già đi bao lâu. Đo lại là một lệnh `aiken check`, đọc ở
// `.modules[].tests[].execution_units.mem` của JSON (cột bảng màu chỉ có 3 chữ số có
// nghĩa — không dùng nó để lập ngân sách).
//
// Ba bài này gồm CẢ chi phí dựng list trong bài kiểm, đúng quy ước của dãy số cũ, để
// hai bản còn so được với nhau. n = 24 và n = 32 KHÔNG đo được tại chỗ: `valid_param`
// chặn ở `list.length <= max_op_prices` rồi `and` ngắn mạch, nên con số đo ra sẽ là
// chi phí của phép CHẶN chứ không phải của phép QUÉT. Cách đo hai mốc đó: chép kho ra
// thư mục nháp, nâng `max_op_prices` ở BẢN CHÉP, thêm hai probe cùng khuôn.

test probe_valid_param_n8() {
  valid_param(pp_with_ops(mk_ops(8)))
}

test probe_valid_param_n12() {
  valid_param(pp_with_ops(mk_ops(12)))
}

test probe_valid_param_n16() {
  valid_param(pp_with_ops(mk_ops(16)))
}

// ── CC-LOAD-COUNT-UNIT + GIÁ CỐ ĐỊNH cho `did.rotate` (2026-09-25) ─────────────
//
// Hai chốt mới, hai bộ bài. Mọi fixture dưới đây chép từ MỘT khuôn và đổi ĐÚNG MỘT
// trường so với bài dương của nó — bài âm đổi hai trường thì nó gác vế đầu tiên chặn
// được, không gác vế ghi trong docstring.

/// Khuôn hai dòng: mã 7 (`did.rotate`, GIÁ CỐ ĐỊNH) và mã 8 (dòng thường).
/// Hai `base_price` BẰNG NHAU để mọi chênh lệch giá quan sát được chỉ có thể đến từ
/// `demand_mult` — base khác nhau thì bài so giá không phân biệt được hai nguyên nhân.
fn pp_rotate_pair(demand_rotate: Int, demand_other: Int) -> PriceParam {
  PriceParam {
    op_prices: [
      OpPrice { op_type: 7, base_price: 10_000_000, demand_mult: demand_rotate },
      OpPrice { op_type: 8, base_price: 10_000_000, demand_mult: demand_other },
    ],
    m_min: m_min_q,
    m_max: m_max_q,
    epoch: 100,
  }
}

test fixed_price_op_isolated_from_neighbour_demand_surge() {
  // NGHIỆM THU Feecover: hàng xóm tăng nhu cầu tới TRẦN không được kéo giá xoay khoá.
  // Đây là bài duy nhất trong tệp đo CẢ HAI cực của cùng một lượt đăng giá — một bài
  // chỉ kiểm "mã 7 không đổi" mà không kiểm "mã 8 CÓ đổi" thì nó vẫn xanh khi
  // `demand_mult` bị bỏ quên hoàn toàn (mọi giá đứng yên là một cách thoả nửa vế).
  let before = pp_rotate_pair(q, q)
  let after = pp_rotate_pair(q, m_max_q)
  and {
    // Lượt đăng 2.0× cho mã 8 là HỢP LỆ — cổng mới không chặn nhầm dòng thường.
    valid_param(before),
    valid_param(after),
    // Hàng xóm ĐỔI: 3 op × 10.000.000 × 1.0× = 30.000.000 → × 2.0× = 60.000.000.
    required_for(before, 8, 3) == Some(30_000_000),
    required_for(after, 8, 3) == Some(60_000_000),
    // Mã 7 ĐỨNG YÊN với CÙNG op_count, trước và sau cùng một lượt đăng.
    required_for(after, 7, 3) == required_for(before, 7, 3),
    required_for(after, 7, 3) == Some(30_000_000),
  }
}

test valid_param_accepts_fixed_op_at_q() {
  // ĐỐI CHỨNG (chống vá quá tay): mã 7 ở đúng 1.0× vẫn đăng được.
  valid_param(pp_rotate_pair(q, q))
}

test valid_param_rejects_fixed_op_demand_above_q() {
  // Mã 7 đăng 1.5×: TRONG band [0.5×, 2.0×] nên band KHÔNG bắt hộ. Chỉ
  // `demand_mult_pinned_if_fixed` từ chối được ca này.
  !valid_param(pp_rotate_pair(1_500_000_000, q))
}

test valid_param_rejects_fixed_op_demand_at_m_min() {
  // Mã 7 đăng 0.5× = ĐÚNG BIÊN DƯỚI của band — hợp lệ với mọi cổng cũ, kể cả cổng
  // band vừa hạ xuống từng dòng. Bài này tồn tại để cổng giá cố định KHÔNG bị đọc
  // thành một bản sao của band: rẻ hơn cũng là ĐỔI THEO TẢI, và một thao tác an ninh
  // được giảm giá lúc tải thấp thì đối xứng của nó là bị tăng giá lúc tải cao.
  !valid_param(pp_rotate_pair(m_min_q, q))
}

test valid_param_rejects_row_demand_above_band() {
  // Dòng THƯỜNG (mã 8, không thuộc `fixed_price_op_types`) vượt trần band 1 nanogic.
  // Dùng mã thường có chủ đích: đặt ở mã 7 thì cổng giá cố định bắt trước và bài này
  // không còn đo band nữa.
  !valid_param(pp_rotate_pair(q, m_max_q + 1))
}

test valid_param_rejects_row_demand_below_band() {
  // Đối xứng dưới: 1 nanogic dưới sàn band. Sàn là thứ chặn giá tụt gần 0 bằng hệ số
  // trong khi `base_price` vẫn qua GATE.
  !valid_param(pp_rotate_pair(q, m_min_q - 1))
}

test required_for_fixed_op_has_no_count_cap() {
  // KHÔNG có trần `op_count` riêng cho mã cố định (chủ dự án chốt): phí xoay khoá
  // tăng theo SỐ LẦN xoay ở tầng PhoenixKey và đi vào `op_count`, nên chặn `op_count`
  // là chặn đúng cơ chế chống lạm dụng của bên kia.
  // demand == q ⇒ required rút gọn đúng bằng base × op_count, không dư làm tròn.
  let pp = pp_rotate_pair(q, q)
  required_for(pp, 7, 1_000_000) == Some(10_000_000 * 1_000_000)
}

test fixed_price_op_types_contains_rotate() {
  // Ghim NỘI DUNG của hằng, không chỉ ghim hành vi: đổi danh sách mà quên đổi luật
  // (hoặc ngược lại) thì bài này đỏ trước khi một beacon sai lên chuỗi.
  list.has(fixed_price_op_types, 7) && !list.has(fixed_price_op_types, 8)
}
