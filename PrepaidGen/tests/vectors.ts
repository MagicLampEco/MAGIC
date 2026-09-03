// tests/vectors.ts — vector chuẩn của PrepaidGen (TV-PP-*)
//
// LƯU Ý VỀ NGUỒN: bảng số học thuần (par, buffer_floor) KHÔNG nằm ở đây. Nó chỉ
// tồn tại MỘT bản, trong `onchain/lib/magiclamp/protocol/vectors.ak`, và
// `p8.test.ts` đọc thẳng file đó. Chép lại sang đây là tạo bản sao thứ hai —
// đúng cái làm hai bên trôi khỏi nhau mà P8 muốn chặn.
//
// File này giữ vector KỊCH BẢN: những con số chỉ có nghĩa khi đặt trong một
// vòng đời lock → draw → burn → settle → claim.

// ══════════════════════════════════════════════════════════════
// TV-PP-01: par 1:1 ở mức đơn vị người dùng nhìn thấy
// ══════════════════════════════════════════════════════════════
export const TV_PP_01 = {
  id: "TV-PP-01",
  spec_ref: "§6.5, Carpet-CARP-DacTa-Vi.md §3.1",
  description: "1 CARP khoá → đúng 1 MAGIC; giá 1 op CID = 0.001 MAGIC",
  cases: [
    { carp: "1", carpdrop: 1_000_000n, nanogic: 1_000_000_000n, magic: "1" },
    { carp: "0.001", carpdrop: 1_000n, nanogic: 1_000_000n, magic: "0.001" },
    { carp: "1000", carpdrop: 1_000_000_000n, nanogic: 1_000_000_000_000n, magic: "1000" },
  ],
} as const;

// ══════════════════════════════════════════════════════════════
// TV-PP-02: vòng đời đầy đủ của một quỹ Paid
// ══════════════════════════════════════════════════════════════
export const TV_PP_02 = {
  id: "TV-PP-02",
  spec_ref: "§6.5 + Carpet-CARP-DacTa-Vi.md §5.1",
  description:
    "Platform mở quỹ → khoá 1000 CARP cho user → user rút 10 CARP thành 10 MAGIC ở epoch 100 → tiêu 6 MAGIC → quyết toán",
  buffer_bps: 1_500n,
  lock_carpdrop: 1_000_000_000n, // 1000 CARP
  fund_after_lock: {
    carp_locked: 1_000_000_000n,
    credit_issued: 1_000_000_000n,
    magic_settled: 0n,
    provider_claimed: 0n,
  },
  epoch: 100n,
  draw_carpdrop: 10_000_000n, // 10 CARP
  drawn_nanogic: 10_000_000_000n, // 10 MAGIC (par chính xác)
  // 600 op "ảnh" × 0.01 MAGIC (§7.2 op_type 1)
  burn_nanogic: 6_000_000_000n,
  batch_left_nanogic: 4_000_000_000n,
  settle_delta_nanogic: 6_000_000_000n,
  settled_par_carpdrop: 6_000_000n,
  // Quỹ mới tiêu 0.6% → đệm buffer-Paid chặn hết, provider chưa rút được gì.
  max_claimable_after: 0n,
} as const;

// ══════════════════════════════════════════════════════════════
// TV-PP-BUFFER: ngưỡng chính xác mà provider bắt đầu rút được
// ══════════════════════════════════════════════════════════════
// Điều kiện: carp_locked ≥ outstanding × (1 + buffer_bps/10000).
// Với credit_issued = 10^9, claimed = 0, buffer 15% ⇒ ngưỡng ở
// settled_par = 130_434_783 carpdrop (≈ 13.043% quỹ đã được tiêu thật).
export const TV_PP_BUFFER = {
  id: "TV-PP-BUFFER",
  spec_ref: "Carpet-CARP-DacTa-Vi.md §5.1 F2 (buffer-Paid ≥ 15%)",
  description: "Biên chính xác của sàn đệm buffer-Paid",
  credit_issued: 1_000_000_000n,
  buffer_bps: 1_500n,
  cases: [
    {
      settled_par: 130_434_782n,
      magic_settled: 130_434_782_000n,
      buffer_floor: 1_000_000_000n,
      max_claimable: 0n,
      note: "dưới ngưỡng 1 đơn vị → chưa rút được gì",
    },
    {
      settled_par: 130_434_783n,
      magic_settled: 130_434_783_000n,
      buffer_floor: 999_999_999n,
      max_claimable: 1n,
      note: "đúng ngưỡng → rút được 1 carpdrop đầu tiên",
    },
    {
      settled_par: 500_000_000n,
      magic_settled: 500_000_000_000n,
      buffer_floor: 575_000_000n,
      max_claimable: 425_000_000n,
      note: "tiêu nửa quỹ → rút được 425M, giữ đệm 15% trên 500M chưa giao",
    },
    {
      settled_par: 1_000_000_000n,
      magic_settled: 1_000_000_000_000n,
      buffer_floor: 0n,
      max_claimable: 1_000_000_000n,
      note: "tiêu hết → outstanding = 0 ⇒ đệm = 0 ⇒ rút toàn bộ",
    },
  ],
} as const;

// ══════════════════════════════════════════════════════════════
// TV-PP-EXPIRE: MAGIC hết hạn trả lại HẠN-MỨC, không trả lại CARP
// ══════════════════════════════════════════════════════════════
export const TV_PP_EXPIRE = {
  id: "TV-PP-EXPIRE",
  spec_ref: "§4.2 + DESIGN.md §1.3",
  description:
    "Rút 10 CARP ở epoch 100, chỉ tiêu 6 MAGIC; sang epoch 101 phần còn lại chết và hạn-mức được trả lại 4 CARP",
  draw_carpdrop: 10_000_000n,
  burned_nanogic: 6_000_000_000n,
  expired_nanogic: 4_000_000_000n,
  credit_restored_carpdrop: 4_000_000n, // = ⌊4×10⁹ / 1000⌋
  carp_left_fund: "không đổi — không đồng CARP nào rời quỹ (F2)",
  settled_unchanged: true, // hết hạn KHÔNG tính là tiêu (INV-MAGIC-CITIZEN)
} as const;

// ══════════════════════════════════════════════════════════════
// TV-PP-OVERFLOW: bắt hồi quy dùng Number (C-OVERFLOW)
// ══════════════════════════════════════════════════════════════
export const TV_PP_OVERFLOW = {
  id: "TV-PP-OVERFLOW",
  spec_ref: "§11 C-OVERFLOW",
  description: "Toàn bộ cung LAMP quy sang thang par vượt xa 2^53",
  carpdrop: 36_000_000_000_000_000n,
  nanogic: 36_000_000_000_000_000_000n,
  exceeds_safe_integer: true,
} as const;

export const ALL_PREPAID_VECTORS = [
  TV_PP_01,
  TV_PP_02,
  TV_PP_BUFFER,
  TV_PP_EXPIRE,
  TV_PP_OVERFLOW,
] as const;
