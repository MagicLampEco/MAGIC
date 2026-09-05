// src/constants.ts — PrepaidGen constants
// Sinh đôi của onchain/lib/magiclamp/protocol/constants.ak (P8).
// MỌI số lượng là bigint (C-OVERFLOW) — cấm Number cho carpdrop/nanogic.

export const Q = 1_000_000_000n;

// CARP dùng 9 chữ số thập phân, BẰNG MAGIC — chủ nhân chốt 2026-09-05, khớp
// `nanothread = CARP × 10⁹` ở `BOUNDARIES.md`. Bản trước ghi 10⁶ kèm nhãn
// [CẦN XÁC NHẬN] và nhãn đó nay đã được trả lời.
export const CARPDROP_PER_CARP = 1_000_000_000n; // CARP decimals = 9
export const NANOGIC_PER_MAGIC = 1_000_000_000n; // MAGIC decimals = 9 (§11)

/**
 * par_scale = NANOGIC_PER_MAGIC / CARPDROP_PER_CARP.
 * 1 CARP khoá → đúng 1 MAGIC (C-PP-1).
 *
 * Hai thang bằng nhau ⟹ PAR_SCALE = 1, tức quy đổi là PHÉP ĐỒNG NHẤT. Hệ quả
 * đổi NGỮ NGHĨA chứ không chỉ đổi số: chiều MAGIC→CARP (`parCarpFromMagic`)
 * trước đây SÀN và cố ý lệch về phía an toàn cho quỹ; nay nó chính xác tuyệt
 * đối, không còn phần dư nào để mất. Ngày nào một trong hai token đổi decimals
 * thì hằng này đổi theo, và cái sàn kia sống lại.  [Constitutional]
 */
export const PAR_SCALE = 1n;

// ── Hình dạng batch (§4.1, §4.2) ─────────────────────────────
export const BATCH_SOURCE_PREPAID = 3n; // §4.1: 1=Instant 2=Schedule 3=Prepaid
export const PREPAID_DECAY_WINDOW = 1n; // cliff  [Constitutional]
export const PREPAID_PROFILE = 0n; // PrepaidGen không dùng tư-cách

// ── Sàn số lượng ──────────────────────────────────────────────
export const MIN_LOCK_CARPDROP = 1_000_000_000n; // 1 CARP
export const MIN_DRAW_CARPDROP = 1_000_000n; // 0.001 CARP = giá 1 op CID (§7.2)

// ── Trần hệ thống (§11) ───────────────────────────────────────
export const MAX_BATCHES_PER_VAULT = 32;
export const MAX_PREPAID_CREDITS = 20;

// ── Quỹ Paid (Carpet-CARP-DacTa-Vi.md §5.1 F2) ────────────────
export const BPS_DENOM = 10_000n;
export const MIN_BUFFER_BPS = 1_500n; // buffer-Paid ≥ 15%  [Constitutional]

// ── Constructor index (§11) ───────────────────────────────────
// ConsumeMAGIC ghim `burn_batch_constr` cho từng vault. PrepaidGen = 2, đồng
// nhất với InstantGen/ScheduleGen.  [CẦN XÁC NHẬN — §11 chưa có dòng PrepaidGen]
export const BURN_BATCH_CONSTR = 2;

// ── Cấu hình mạng ─────────────────────────────────────────────
// tCARP đã đúc thật trên cả hai testnet (CARP/_Agents/topics/
// carpetmint-offchain-testnet.md). Asset name + policy là THAM SỐ validator,
// không hardcode vào logic.
export const CARP_ASSET_NAME = "43415250"; // "CARP"

export const CARP_POLICY_ID = {
  Preview: "074cf29c52db3700910d249e0da5b761b7588f8d5bcea595a335bcf7",
  Preprod: "47144f2e675f5fd2b909fc295ba2a975291c4cbb576a15e7298cdb0b",
} as const;

export const MS_PER_EPOCH = {
  Mainnet: 432_000_000n,
  Preview: 86_400_000n,
  Preprod: 86_400_000n,
} as const;
