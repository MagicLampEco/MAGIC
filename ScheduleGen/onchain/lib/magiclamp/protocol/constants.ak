// lib/constants.ak — GenMAGIC v3.3 Protocol Constants (ScheduleGen)
// Normative §19.6. Tiers marked per spec.

pub const q : Int = 1_000_000_000   // [Immutable]
pub const slots_per_epoch : Int = 432_000

// ── SnapshotGen base rate (used to compute rate_locked_q at commit) ──
pub const snapshot_base_rate_q : Int = 5_000_000_000  // [Constitutional]

// ── S(L) piecewise segments (§11.3, §19.6) [Constitutional] ──────────
pub const s_seg1_intercept_q : Int = 1_500_000_000   // 1.5
pub const s_seg1_slope_q     : Int = 10_000_000       // 0.010 per L
pub const s_seg2_knee        : Int = 50               // L=50 boundary
pub const s_seg2_intercept_q : Int = 2_000_000_000   // 2.0
pub const s_seg2_slope_q     : Int = 5_000_000        // 0.005 per (L-50)
pub const s_seg3_knee        : Int = 150              // L=150 boundary
pub const s_seg3_intercept_q : Int = 2_500_000_000   // 2.5
pub const s_seg3_slope_q     : Int = 2_500_000        // 0.0025 per (L-150)

// ── Schedule length (§19.6) [Significant] ────────────────────────────
pub const schedule_min_length : Int = 10
pub const schedule_max_length : Int = 200

// ── λ minimum (§19.6) [Routine] ──────────────────────────────────────
pub const min_lamp_per_fire : Int = 1_000_000   // 1 LAMP in oildrop

// ── Schedule delay (commit → first fire) [Constitutional] ─────────────
pub const schedule_delay : Int = 2   // epochs

// ── Schedule batch cliff [Constitutional] ────────────────────────────
pub const schedule_decay_window : Int = 1   // cliff at k=1

// ── Catch-up limit [Routine] ─────────────────────────────────────────
pub const max_fires_per_tx_catchup : Int = 8

// ── System limits [Routine] ──────────────────────────────────────────
pub const max_gen_schedules     : Int = 20
pub const max_batches_per_vault : Int = 32
pub const max_loyalty_holdings  : Int = 64

// ── Shard [Constitutional] ────────────────────────────────────────────
pub const shard_count : Int = 16
// shard_cap = 4.5 × 10^14 oildrop = 450,000,000 LAMP per shard
// = TOTAL_LAMP × SCHEDULE_PARTICIPATION_CAP_BPS / (10000 × shard_count)
// = 36×10^15 × 2000 / 160000 = 4.5×10^14
pub const shard_cap : Int = 450_000_000_000_000
