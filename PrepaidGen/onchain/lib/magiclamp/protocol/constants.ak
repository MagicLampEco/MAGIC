// lib/constants.ak — PrepaidGen protocol constants
// Normative: MagicLamp-Tripletoken-Feat-(Vi).md §4.2, §6.5, §11
// Every value here has a twin in offchain/src/constants.ts (P8).

// ── Scales ────────────────────────────────────────────────────
// Q is kept for interface parity with the other generators; PrepaidGen's par
// conversion is a pure unit rescale, NOT a Q-format rate, so it never uses Q.
pub const q : Int = 1_000_000_000

pub const carpdrop_per_carp : Int = 1_000_000       // CARP decimals = 6  [CẦN XÁC NHẬN]
pub const nanogic_per_magic : Int = 1_000_000_000   // MAGIC decimals = 9 (§11)

// par_scale = nanogic_per_magic / carpdrop_per_carp
// 1 CARP khoá → đúng 1 MAGIC (Carpet-CARP-DacTa-Vi.md §3.1). Vì đây là phép
// NHÂN nên chiều CARP→MAGIC không mất số dư.  [Constitutional]
pub const par_scale : Int = 1_000

// ── Batch shape (§4.1, §4.2) ──────────────────────────────────
// §4.1: source 1=Instant 2=Schedule 3=Prepaid
pub const batch_source_prepaid : Int = 3
// §4.2: cliff — batch chỉ LIVE trong đúng created_epoch  [Constitutional]
pub const prepaid_decay_window : Int = 1
// PrepaidGen không dùng tư-cách (§6.5 không có cổng tư-cách)
pub const prepaid_profile : Int = 0

// ── Amount floors ─────────────────────────────────────────────
pub const min_lock_carpdrop : Int = 1_000_000   // 1 CARP        [Routine]
// 1_000 carpdrop → 1_000_000 nanogic = 0.001 MAGIC = giá 1 op CID (§7.2)
pub const min_draw_carpdrop : Int = 1_000       // 0.001 CARP    [Routine]

// ── System limits (§11) ───────────────────────────────────────
pub const max_batches_per_vault : Int = 32      // §11            [Routine]
pub const max_prepaid_credits   : Int = 20      // quỹ / vault    [Routine]

// ── Paid fund (Carpet-CARP-DacTa-Vi.md §5.1 F2) ───────────────
pub const bps_denom      : Int = 10_000
pub const min_buffer_bps : Int = 1_500          // buffer-Paid ≥ 15%  [Constitutional]
