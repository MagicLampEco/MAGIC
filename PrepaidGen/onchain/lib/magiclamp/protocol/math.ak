// lib/math.ak — PrepaidGen core math
// P8: mọi hàm ở đây có bản sinh đôi bit-identical trong offchain/src/math.ts.
// Bảng vector chung: lib/magiclamp/protocol/vectors.ak (test TS đọc thẳng file đó).

use aiken/crypto
use aiken/primitive/bytearray
use magiclamp/protocol/constants.{bps_denom, par_scale}

// ══════════════════════════════════════════════════════════════
// Par 1:1 — CARP ⇄ MAGIC ở tầng đơn vị cơ sở
// ══════════════════════════════════════════════════════════════
//
// nanogic = carpdrop × par_scale        (NHÂN → chính xác tuyệt đối)
//
// 1 CARP = 10^9 carpdrop → 10^9 nanogic = 1 MAGIC ✓ (CARP 9 chữ số, chốt 2026-09-05)
// Không có phí par, không có hệ số Q, không có làm tròn ở chiều này (C-PP-1).
pub fn par_magic_from_carp(carpdrop: Int) -> Int {
  carpdrop * par_scale
}

// carpdrop = ⌊ nanogic / par_scale ⌋
//
// CHỈ dùng để tính TRẦN ĐÒI của provider (C-PP-6) và phần trả lại hạn-mức khi dọn
// batch chết.
//
// VỚI `par_scale = 1` PHÉP SÀN NÀY KHÔNG CÒN CẮT GÌ. Bản trước ghi "sàn ⌊⌋ lệch về
// phía an toàn: ra ÍT CARP hơn → provider không bao giờ đòi quá phần đã giao" — lập
// luận đó chết cùng lúc hai thang bằng nhau. An toàn nay đến từ chỗ khác: Σ hạn-mức
// còn lại = `credit_issued − Σ burned` = `outstanding`, đúng bằng nhau ở cả hai thang,
// nên quỹ khớp chính xác chứ không còn giữ dư bụi. Ngày nào một trong hai token đổi
// decimals thì `par_scale ≠ 1` và cái sàn này sống lại — giữ nguyên hàm, đừng rút gọn.
pub fn par_carp_from_magic(nanogic: Int) -> Int {
  nanogic / par_scale
}

// ══════════════════════════════════════════════════════════════
// Kế toán quỹ Paid (Carpet-CARP-DacTa-Vi.md §5.1 F2)
// ══════════════════════════════════════════════════════════════
//
// outstanding = credit_issued − ⌊magic_settled / par_scale⌋
//   = phần hạn-mức đã cấp mà DỊCH VỤ CHƯA GIAO. Quỹ phải luôn giữ đủ CARP
//     đối ứng phần này (C-PP-3 + C-PP-6).
pub fn outstanding_of(credit_issued: Int, magic_settled: Int) -> Int {
  credit_issued - par_carp_from_magic(magic_settled)
}

// buffer_floor = outstanding + ⌊ outstanding × buffer_bps / 10000 ⌋
//
// Sàn CARP mà quỹ phải giữ lại SAU khi provider rút. buffer_bps ≥ 1500 ⇒ đệm
// ≥ 15% trên phần chưa giao (buffer-Paid, F2). Khi quỹ tiêu hết
// (outstanding = 0) sàn về 0 → provider rút được toàn bộ.
pub fn buffer_floor(outstanding: Int, buffer_bps: Int) -> Int {
  outstanding + outstanding * buffer_bps / bps_denom
}

// Trần đòi cứng của F2: `claim_provider ≤ Σ MAGIC_burned_par`.
// (Ràng buộc buffer ở trên chặt hơn khi outstanding > 0; giữ cả hai vì đây là
//  luật được nêu tên trong spec.)
pub fn claim_ceiling(magic_settled: Int, provider_claimed: Int) -> Int {
  par_carp_from_magic(magic_settled) - provider_claimed
}

// ══════════════════════════════════════════════════════════════
// Định danh
// ══════════════════════════════════════════════════════════════

// batch_id = blake2b256(tx_hash ∥ be8(output_index) ∥ be8(batch_index))
pub fn compute_batch_id(
  tx_hash      : ByteArray,
  output_index : Int,
  batch_index  : Int,
) -> ByteArray {
  let ref_bytes =
    bytearray.concat(tx_hash, bytearray.from_int_big_endian(output_index, 8))
  let idx_bytes = bytearray.from_int_big_endian(batch_index, 8)
  crypto.blake2b_256(bytearray.concat(ref_bytes, idx_bytes))
}

// fund_id = blake2b256(tx_hash ∥ be8(output_index)) của MỘT input bị tiêu lúc
// đúc NFT quỹ → tên tài sản duy nhất, không đúc lại được, không trùng.
pub fn compute_fund_id(tx_hash: ByteArray, output_index: Int) -> ByteArray {
  crypto.blake2b_256(
    bytearray.concat(tx_hash, bytearray.from_int_big_endian(output_index, 8)),
  )
}

// ── Vector chuẩn P8: compute_fund_id ↔ scripts/fundId.ts ────────────────────
// Ba giá trị dưới đây do `scripts/fundId.ts` ▸ `fundIdAssetName` sinh ra
// (2026-09-19). Bài này là TRAP-DOOR cho phép trùng-bit giữa hai hiện thực: nó
// đỏ khi một trong hai bên đổi mà bên kia không đổi.
//
// VÌ SAO CẦN, dù công thức chỉ có một dòng: bên TypeScript phải tự tay mã hoá
// `output_index` thành ĐÚNG 8 byte big-endian. Cách viết tự nhiên hơn — dùng độ
// dài tối thiểu — chạy trót lọt, trả về 64 ký tự hex, và cho một tên tài sản
// KHÁC. Lúc đó `validate_mint_fund_nft` không khớp input nào và giao dịch chết
// với một thông điệp không trỏ về chỗ sai.
//
// Ca `#0` là ca quan trọng nhất và là ca dễ lọt nhất: index 0 mã hoá tối thiểu
// ra MỘT byte, nên một bản dựng sai vẫn "trông đúng" ở mọi ca người ta thử tay.
//
// VÌ SAO KHÔNG Ở `vectors.ak` — đừng "dọn" nó sang đó. Bảng kia giữ vector SỐ cho
// các hàm số học và người đọc nó là `offchain/src/math.ts`, module KHÔNG hiện thực
// `compute_fund_id`. Vector này neo một cặp khác hẳn: hàm băm định danh ở đây ↔
// `scripts/fundId.ts`. Chuyển sang bảng kia là đưa một vector vào tầm mắt của một
// bên không có gì để đối chiếu, và lấy nó khỏi tầm mắt của bên có.
//
// Đã đo trap-door 2026-09-19: đổi `from_int_big_endian(output_index, 8)` thành `4`
// ⟹ ĐÚNG MỘT bài đỏ, chính bài này (139 tổng, 138 xanh). Không bài nào khác trong
// module bắt được thay đổi đó.
test tv_fund_id_matches_typescript() {
  let tx_a = #"1111111111111111111111111111111111111111111111111111111111111111"
  let tx_b = #"abababababababababababababababababababababababababababababababab"
  and {
    compute_fund_id(tx_a, 0) == #"89a14e509dfb8c8a861d91e275c12d7dacb33d6ec5a80bda7657e85651f34e37",
    compute_fund_id(tx_a, 3) == #"e676bdc6ff18e85229e58bf657990d4f6ab7775921e10cfc4198dec82a57be1e",
    compute_fund_id(tx_b, 7) == #"9abebc9dfb5819fc04fdc74cef430436ec9a1ba841ceec1dabc63615714c6778",
  }
}
