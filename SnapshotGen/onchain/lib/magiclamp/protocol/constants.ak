// lib/constants.ak — GenMAGIC v3.3 Protocol Constants (SnapshotGen)
// Normative §19. Tiers: Constitutional / Significant / Routine / Immutable.

// ── Precision [Immutable §19.8] ──────────────────────────────
pub const q : Int = 1_000_000_000

// ── Epoch ────────────────────────────────────────────────────
pub const slots_per_epoch : Int = 432_000

// ── SnapshotGen (§19.1) ──────────────────────────────────────
pub const snapshot_base_rate_q : Int = 5_000_000_000  // [Constitutional]

// Profile bonus B_Q (§3.1) [Constitutional]
pub const b_q_ember   : Int = 1_300_000_000   // 1.30
pub const b_q_flame   : Int = 1_100_000_000   // 1.10
pub const b_q_lantern : Int = 1_000_000_000   // 1.00

// Decay rate r (§3.1) — (10 - r) is the decay numerator [Constitutional]
pub const r_ember   : Int = 3
pub const r_flame   : Int = 2
pub const r_lantern : Int = 1

// Lifetime N (§3.1) [Constitutional]
pub const n_ember   : Int = 3
pub const n_flame   : Int = 6
pub const n_lantern : Int = 9

// Profile Multiplier PM_Q (§3.4) [Routine]
pub const pm_q_ember   : Int = 1_150_000_000   // 1.15
pub const pm_q_flame   : Int = 1_050_000_000   // 1.05
pub const pm_q_lantern : Int = 1_000_000_000   // 1.00

// Profile change cooldown (§3.5) [Significant]
pub const profile_change_cooldown : Int = 2

// ── OAC (§19.3) ──────────────────────────────────────────────
pub const oac_base_q      : Int = 800_000_000   // 0.80 [Significant]
pub const oac_increment_q : Int = 50_000_000    // 0.05 [Significant]
pub const oac_cap_apps    : Int = 4             // [Significant]
pub const drm_lookback    : Int = 12            // epochs [Significant]
pub const min_burn_for_oac: Int = 1_000_000_000 // 1 MAGIC in nanogic [Routine]

// ── LF knees (§19.2) ─────────────────────────────────────────
// age=0..6   → LF 1.00..1.10  [Significant]
// age=6..12  → LF 1.10..1.20  [Significant]
// age=12..24 → LF 1.20..1.50  [Constitutional]
pub const lf_cap_age : Int = 24   // LF = 1.50 for age > 24 [Constitutional]

// ── System limits (§19.8) ────────────────────────────────────
pub const max_batches_per_vault : Int = 32  // [Routine]
pub const max_loyalty_holdings  : Int = 64  // [Routine]
