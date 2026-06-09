// lib/constants.ak — GenMAGIC v3.3 Protocol Constants
// All values from §19. Tiers: Constitutional=immutable; others may change via DAO.

// ── Precision ────────────────────────────────────────────────
// Q = 10^9 [Immutable §19.8]
pub const q : Int = 1_000_000_000

// ── LAMP supply ──────────────────────────────────────────────
// 36 × 10^15 oil [Constitutional — immutable forever §19.9]
pub const total_lamp_supply : Int = 36_000_000_000_000_000

// ── Epoch length ─────────────────────────────────────────────
// 432,000 slots per epoch on Cardano (mainnet + preview testnet)
pub const slots_per_epoch : Int = 432_000

// ── InstantGen parameters (§19.4) ───────────────────────────
// [Constitutional] Base rate
pub const instant_base_rate_q : Int = 3_000_000_000

// [Routine] Minimum purchase: 10 LAMP = 10^7 oil
pub const min_instant_purchase : Int = 10_000_000

// [Routine] Maximum purchase per tx: 10^13 oil
pub const max_instant_purchase : Int = 10_000_000_000_000

// [Constitutional] Decay window: 2 epochs
pub const instant_decay_window : Int = 2

// ── UM parameters (§19.7) ────────────────────────────────────
// [Constitutional] UM minimum (floor)
pub const um_min_q : Int = 500_000_000

// [Constitutional] UM maximum (ceiling)
pub const um_max_q : Int = 2_000_000_000

// [Significant] Staleness window: 1 epoch (Instant only, C-UM-6)
pub const um_max_staleness : Int = 1

// [Constitutional] Fallback = UM_MIN_Q (C-UM-6)
pub const um_fallback_q : Int = 500_000_000

// [Significant] Smoothing window: 6 epochs
pub const um_smoothing_window : Int = 6

// ── Profile multipliers PM_Q (§19.1, §3.4) ──────────────────
// [Routine] — can be changed by DAO Routine vote
pub const pm_q_ember   : Int = 1_150_000_000   // 1.15
pub const pm_q_flame   : Int = 1_050_000_000   // 1.05
pub const pm_q_lantern : Int = 1_000_000_000   // 1.00

// ── Profile bonus B_Q (§3.1) ────────────────────────────────
// [Constitutional]
pub const b_q_ember   : Int = 1_300_000_000   // 1.30
pub const b_q_flame   : Int = 1_100_000_000   // 1.10
pub const b_q_lantern : Int = 1_000_000_000   // 1.00

// ── System limits (§19.8) ────────────────────────────────────
// [Routine]
pub const max_batches_per_vault   : Int = 32
pub const max_loyalty_holdings    : Int = 64
pub const max_vacuum_orders       : Int = 10
pub const max_gen_schedules       : Int = 20
pub const max_delegation_apps     : Int = 5
pub const max_fires_per_tx_catchup: Int = 8

// ── Snapshot base rate (§19.1) ───────────────────────────────
// [Constitutional]
pub const snapshot_base_rate_q : Int = 5_000_000_000

// ── Profile change cooldown (§12, C-PC-V2) ──────────────────
// [Routine] Minimum epochs between UpdateProfile calls
pub const profile_change_cooldown : Int = 2
