// lib/constants.ak — MagicLamp Tripletoken protocol constants (InstantGen)
// Normative: SPEC/MagicLamp-Tripletoken-Feat-(Vi).md §4.2, §6.1, §6.3, §11.
// MUST stay in sync with offchain/src/constants.ts (P8).

// ── Precision ────────────────────────────────────────────────
// Q = 10^9 [Immutable §11]
pub const q : Int = 1_000_000_000

// ── LAMP supply ──────────────────────────────────────────────
// 36 × 10^15 oildrop [Constitutional — immutable forever]
pub const total_lamp_supply : Int = 36_000_000_000_000_000

// ── Epoch length ─────────────────────────────────────────────
// KHÔNG có hằng số epoch ở đây, CỐ Ý. Độ dài epoch là THAM SỐ THEO MẠNG, không
// phải hằng của giao thức: Preview = 86_400 slot, Mainnet/Preprod = 432_000.
// Validator nhận `ms_per_epoch` qua apply-param; offchain tra
// `SLOTS_PER_EPOCH_BY_NETWORK` trong `ProtocolUtils/src/index.ts`.
// (Hằng `slots_per_epoch = 432_000` với bình luận "mainnet + preview testnet" đã
//  xoá 2026-08-09: sai với Preview, 0 call site, và là mìn ngủ cho người đọc sau.)

// ── MAGIC batch lifetime (§4.2 per-epoch use-or-lose) ────────
// [Constitutional] decay_window = 1 ⟹ a batch is LIVE only inside its own
// created_epoch. At created_epoch + 1 the batch is DEAD (cliff): it cannot be
// burned and is garbage-collected. NO halving, NO carry-over, NO hoarding.
pub const magic_decay_window : Int = 1

// Backwards-compatible alias used by InstantGen call sites.
pub const instant_decay_window : Int = magic_decay_window

// ── InstantGen — eligibility (§6.3 "nắm LAMP chỉ MỞ TƯ CÁCH") ─
// [Routine] Minimum LAMP that must SIT in the vault to open eligibility.
// The LAMP is never moved (I-ACT-7); it only gates the door.
pub const min_instant_holding : Int = 10_000_000   // 10 LAMP in oildrop

// ── InstantGen — magnitude (§6.3 keyed-consumed) ─────────────
// [Significant] reward rate applied to MAGIC ALREADY CONSUMED.
// INV-CASHBACK-BOUND requires reward ≤ consumed for every DID, so the whole
// multiplier chain must stay < Q:
//   rate × UM_MAX × PM_MAX = 0.20 × 2.00 × 1.15 = 0.46 < 1  ✓
pub const instant_reward_rate_q : Int = 200_000_000   // 0.20

// ── Surplus gate (§6.3 cap_surplus) ──────────────────────────
// [Constitutional] br_safe = 1.5 ; f ≤ 0.10
pub const br_safe_q       : Int = 1_500_000_000   // 1.5
pub const f_cap_surplus_q : Int =   100_000_000   // 0.10

// [Significant] Backing beacon staleness window (epochs). Beyond it the
// beacon is treated as ABSENT → cap_surplus = 0 → Gen closed (fail-closed).
pub const max_backing_stale : Int = 1

// ── UM parameters (network demand multiplier) ────────────────
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

// ── Profile multipliers PM_Q (§6.2 tư-cách) ─────────────────
// [Routine] — can be changed by DAO Routine vote
pub const pm_q_ember   : Int = 1_150_000_000   // 1.15
pub const pm_q_flame   : Int = 1_050_000_000   // 1.05
pub const pm_q_lantern : Int = 1_000_000_000   // 1.00

// ── Profile bonus B_Q ────────────────────────────────────────
// [Constitutional]
pub const b_q_ember   : Int = 1_300_000_000   // 1.30
pub const b_q_flame   : Int = 1_100_000_000   // 1.10
pub const b_q_lantern : Int = 1_000_000_000   // 1.00

// ── System limits (§11) ──────────────────────────────────────
// [Routine]
pub const max_batches_per_vault   : Int = 32
pub const max_loyalty_holdings    : Int = 64
pub const max_vacuum_orders       : Int = 10
pub const max_gen_schedules       : Int = 20
pub const max_delegation_apps     : Int = 5
pub const max_fires_per_tx_catchup: Int = 8

// ── Snapshot base rate (legacy — ScheduleGen rate baseline) ──
// [Constitutional]
pub const snapshot_base_rate_q : Int = 5_000_000_000

// ── Profile change cooldown (§12, C-PC-V2) ──────────────────
// [Routine] Minimum epochs between UpdateProfile calls
pub const profile_change_cooldown : Int = 2
