// lib/constants.ak — GenMAGIC v3.3 Protocol Constants (VacuumGen)
// Normative §19. Tiers: Constitutional / Significant / Routine / Immutable.

pub const q : Int = 1_000_000_000   // [Immutable]

pub const slots_per_epoch : Int = 432_000

// ── VacuumGen (§19.5) ────────────────────────────────────────
pub const vbr_q : Int = 500_000_000              // VBR = 0.5 [Significant]
pub const min_vacuum_amount : Int = 1_000_000     // 1 LAMP in oil [Routine]
pub const max_vacuum_orders : Int = 10            // [Routine]
pub const vacuum_delay : Int = 2                  // epochs [Constitutional]
pub const vacuum_decay_window : Int = 1           // cliff (§2.3) [Constitutional]

// ── Streak Multiplier SM_Q (§6.5) ────────────────────────────
// [Routine]
pub const sm_q_base    : Int = 1_000_000_000   // streak <3  → 1.00
pub const sm_q_3_5     : Int = 1_050_000_000   // streak 3-5 → 1.05
pub const sm_q_6_11    : Int = 1_100_000_000   // streak 6-11→ 1.10
pub const sm_q_12_plus : Int = 1_200_000_000   // streak ≥12 → 1.20

// ── UM (§19.7) ───────────────────────────────────────────────
pub const um_min_q : Int = 500_000_000     // [Constitutional]
pub const um_max_q : Int = 2_000_000_000   // [Constitutional]
// Note: VacuumFire uses C-UM-7 — NO staleness check (smoothed always)

// ── Profile multipliers PM_Q (§3.4) ─────────────────────────
// Note: PM does NOT apply to VacuumGen (§6.10 M_vacuum)
// Included for reference / other mechanisms.

// ── System limits (§19.8) ────────────────────────────────────
pub const max_batches_per_vault  : Int = 32  // [Routine]
pub const max_loyalty_holdings   : Int = 64  // [Routine]
