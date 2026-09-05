// lib/vectors.ak — BẢNG VECTOR CHUẨN, MỘT BẢN DUY NHẤT (P8)
//
// Đây là nguồn chân lý cho phép đối chiếu bit-identical Aiken ↔ TypeScript:
//   - test Aiken (cuối file này) chạy hàm on-chain trên bảng và so cột kết quả;
//   - test TypeScript (tests/p8.test.ts) ĐỌC THẲNG file .ak này, trích các cột
//     bằng regex, chạy hàm TS và so cùng cột đó.
// Hai bên bị buộc về CÙNG những con số literal, và con số chỉ tồn tại một bản.
// KHÔNG sao chép bảng này sang chỗ khác.

use aiken/collection/list
use magiclamp/protocol/math.{buffer_floor, par_carp_from_magic, par_magic_from_carp}

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
pub const v3_buf_outstanding: List<Int> =
  [0, 1, 7, 999_999, 1_000_000, 1_000_000, 1_000_000_000_000]

pub const v3_buf_bps: List<Int> =
  [1_500, 1_500, 1_500, 1_500, 1_500, 10_000, 1_500]

pub const v3_buf_out: List<Int> =
  [0, 1, 8, 1_149_998, 1_150_000, 2_000_000, 1_150_000_000_000]

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
