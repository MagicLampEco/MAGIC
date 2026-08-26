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
// 1 CARP = 10^6 carpdrop → 10^9 nanogic = 1 MAGIC ✓ (Carpet-CARP §3.1)
// Không có phí par, không có hệ số Q, không có làm tròn ở chiều này (C-PP-1).
pub fn par_magic_from_carp(carpdrop: Int) -> Int {
  carpdrop * par_scale
}

// carpdrop = ⌊ nanogic / par_scale ⌋
//
// CHỈ dùng để tính TRẦN ĐÒI của provider (C-PP-6). Sàn ⌊⌋ lệch về phía an toàn:
// quy đổi ra ÍT CARP hơn → provider không bao giờ đòi quá phần đã giao.
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
