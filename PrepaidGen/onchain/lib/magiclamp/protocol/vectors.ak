// lib/vectors.ak — BẢNG VECTOR CHUẨN, MỘT BẢN DUY NHẤT (P8)
//
// Đây là nguồn chân lý cho phép đối chiếu bit-identical Aiken ↔ TypeScript:
//   - test Aiken (cuối file này) chạy hàm on-chain trên bảng và so cột kết quả;
//   - test TypeScript (tests/p8.test.ts) ĐỌC THẲNG file .ak này, trích các cột
//     bằng regex, chạy hàm TS và so cùng cột đó.
// Hai bên bị buộc về CÙNG những con số literal, và con số chỉ tồn tại một bản.
// KHÔNG sao chép bảng này sang chỗ khác.

use aiken/collection/list
use magiclamp/protocol/math.{
  buffer_floor, outstanding_effective, par_carp_from_magic, par_magic_from_carp,
  reclaim_outstanding,
}

// ── V1: par_magic_from_carp(carpdrop) -> nanogic ──────────────
//
// ⚠ TỪ 2026-09-05, `par_scale = 1` (CARP và MAGIC cùng 9 chữ số) ⟹ bảng này là
// PHÉP ĐỒNG NHẤT: cột ra bằng cột vào. Nói thẳng để không ai đọc nó thành một
// chốt mạnh hơn thực tế — nó KHÔNG còn chứng minh phép nhân thang nào cả.
// Cái nó CÒN chứng minh, và đó là lý do giữ: hai giá trị cuối không biểu diễn
// được chính xác bằng `Number` (đều > 2^53, giá trị cuối lệch đúng 1 đơn vị so
// với một mốc tròn), nên một lần hồi quy sang `Number` bên TypeScript vẫn làm
// bảng này đỏ (C-OVERFLOW). Ngày CARP hoặc MAGIC đổi decimals thì `par_scale`
// khác 1 trở lại và bảng lấy lại đầy đủ sức nặng — nhớ cập nhật CẢ HAI cột.
pub const v1_par_in: List<Int> =
  [
    0, 1, 1_000, 1_000_000, 123_456_789, 4_500_000_000_000_000,
    36_000_000_000_000_000, 36_000_000_000_000_000_001,
  ]

pub const v1_par_out: List<Int> =
  [
    0, 1, 1_000, 1_000_000, 123_456_789, 4_500_000_000_000_000,
    36_000_000_000_000_000, 36_000_000_000_000_000_001,
  ]

// ── V2: par_carp_from_magic(nanogic) -> carpdrop (floor) ──────
//
// ⚠ Cùng lý do trên: với `par_scale = 1` phép chia sàn KHÔNG cắt gì, nên bảng
// này cũng là đồng nhất và KHÔNG còn chứng minh hành vi làm-tròn-xuống. Trước
// 2026-09-05 nó bắt được ca `999 → 0` (dư bị bỏ, lệch về phía an toàn cho quỹ);
// hành vi đó nay không tồn tại vì không còn phần dư nào.
pub const v2_inv_in: List<Int> =
  [
    0, 999, 1_000, 1_999, 1_000_000_000, 123_456_789_123,
    36_000_000_000_000_000_000,
  ]

pub const v2_inv_out: List<Int> =
  [
    0, 999, 1_000, 1_999, 1_000_000_000, 123_456_789_123,
    36_000_000_000_000_000_000,
  ]

// ── V3: buffer_floor(outstanding, buffer_bps) ─────────────────
// Hàng 8–10: `buffer_bps = 0` (sàn genesis từ 2026-10-05) ⟹ sàn == outstanding;
// hàng 10 > 2^53 (C-OVERFLOW).
pub const v3_buf_outstanding: List<Int> =
  [
    0, 1, 7, 999_999, 1_000_000, 1_000_000, 1_000_000_000_000, 7, 1_000_000,
    36_000_000_000_000_000_000,
  ]

pub const v3_buf_bps: List<Int> =
  [1_500, 1_500, 1_500, 1_500, 1_500, 10_000, 1_500, 0, 0, 0]

pub const v3_buf_out: List<Int> =
  [
    0, 1, 8, 1_149_998, 1_150_000, 2_000_000, 1_150_000_000_000, 7, 1_000_000,
    36_000_000_000_000_000_000,
  ]

// ── V4: outstanding_effective(credit_issued, sponsor_reclaimed, magic_settled) ─
// Lượng `FundReclaim` trả bên tài trợ (`prepaid.ak` ▸ `reclaim_amount`) và vế
// outstanding của sàn đệm `FundClaim`. Hàng 2–3: số của bài `rc_*` (C = 10e9,
// M = 4e9) trước/sau thu hồi. Hàng 5: > 2^53 (C-OVERFLOW).
pub const v4_eff_credit: List<Int> =
  [0, 10_000_000_000, 10_000_000_000, 1, 36_000_000_000_000_000_001,
    36_000_000_000_000_000_000]

pub const v4_eff_reclaimed: List<Int> =
  [0, 0, 6_000_000_000, 0, 0, 35_999_999_999_999_999_999]

pub const v4_eff_settled: List<Int> =
  [0, 4_000_000_000, 4_000_000_000, 0, 1, 0]

pub const v4_eff_out: List<Int> =
  [0, 6_000_000_000, 0, 1, 36_000_000_000_000_000_000, 1]

// ── V5: reclaim_outstanding(credit_issued, sponsor_reclaimed, magic_settled, unsettled) ─
// Lượng `FundReclaim` trả bên tài trợ khi dòng hạn-mức ở vault còn nợ
// `consumed_unsettled` (DESIGN-reclaim §10.11). Hàng 2: u = 0 ⟹ trùng V4 hàng 2.
// Hàng 3: số của bài `rc_u_*` (u = 1e9). Hàng 4: u nuốt trọn phần chưa giao.
// Hàng 6: > 2^53 (C-OVERFLOW).
pub const v5_rc_credit: List<Int> =
  [0, 10_000_000_000, 10_000_000_000, 10_000_000_000, 1,
    36_000_000_000_000_000_001]

pub const v5_rc_reclaimed: List<Int> =
  [0, 0, 0, 0, 0, 0]

pub const v5_rc_settled: List<Int> =
  [0, 4_000_000_000, 4_000_000_000, 4_000_000_000, 0, 1]

pub const v5_rc_unsettled: List<Int> =
  [0, 0, 1_000_000_000, 6_000_000_000, 1, 2]

pub const v5_rc_out: List<Int> =
  [0, 6_000_000_000, 5_000_000_000, 0, 0, 35_999_999_999_999_999_998]

// ══════════════════════════════════════════════════════════════
// Tests — vế Aiken của cổng P8
// ══════════════════════════════════════════════════════════════

test p8_v1_par_magic_from_carp() {
  list.map(v1_par_in, par_magic_from_carp) == v1_par_out
}

test p8_v2_par_carp_from_magic() {
  list.map(v2_inv_in, par_carp_from_magic) == v2_inv_out
}

test p8_v3_buffer_floor() {
  list.map(
    list.zip(v3_buf_outstanding, v3_buf_bps),
    fn(pair) {
      let (outstanding, bps) = pair
      buffer_floor(outstanding, bps)
    },
  ) == v3_buf_out
}

// Vòng tròn: nhân rồi chia par_scale phải trả về đúng số ban đầu (chiều
// CARP→MAGIC không mất số dư — C-PP-1).
test p8_par_roundtrip_exact() {
  list.all(
    v1_par_in,
    fn(c) { par_carp_from_magic(par_magic_from_carp(c)) == c },
  )
}

test p8_v4_outstanding_effective() {
  let rows =
    list.zip(list.zip(v4_eff_credit, v4_eff_reclaimed), v4_eff_settled)
  list.length(rows) == list.length(v4_eff_out) && list.map(
    rows,
    fn(row) {
      let ((c, r), m) = row
      outstanding_effective(c, r, m)
    },
  ) == v4_eff_out
}

test p8_v5_reclaim_outstanding() {
  let rows =
    list.zip(
      list.zip(list.zip(v5_rc_credit, v5_rc_reclaimed), v5_rc_settled),
      v5_rc_unsettled,
    )
  list.length(rows) == list.length(v5_rc_out) && list.map(
    rows,
    fn(row) {
      let (((c, r), m), u) = row
      reclaim_outstanding(c, r, m, u)
    },
  ) == v5_rc_out
}
