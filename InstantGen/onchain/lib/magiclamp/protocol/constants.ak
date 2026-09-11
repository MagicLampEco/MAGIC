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

// ── Profile multipliers PM_Q — HỆ SỐ HỒ SƠ HOẠT ĐỘNG (ActivityProfile) ──
// KHÔNG phải hệ số tư-cách §6.2 (`eligibility_q ∈ [1.00×, 2.50×]`). Ba mức dưới đây
// đều ≤ 1.15, và trần 1.15 đó chính là thứ giữ INV-CASHBACK-BOUND < 1.───────────────
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

// ── Shape factor S_Q — MIRRORED from ScheduleGen ─────────────
// [Constitutional] Byte-identical to
// `ScheduleGen/onchain/lib/magiclamp/protocol/constants.ak:15-22`. Copied, not
// imported: each `onchain/` is a separate Aiken project, so there is no shared
// module to point at. `instant_rate_q_derived` (math.ak) recomputes the derived
// rate from these, and a test pins it against the literal below — that test is
// what stops the two copies drifting apart in silence.
//
// S_Q is a function of a schedule's LENGTH IN EPOCHS, not of any LAMP amount.
// Reading it as a size factor is the mistake to avoid: `compute_s_q` is called
// with `schedule_length` at `ScheduleGen/onchain/validators/vault.ak:291`.
pub const s_seg1_intercept_q : Int = 1_500_000_000   // 1.5
pub const s_seg1_slope_q     : Int = 10_000_000      // 0.010 per L
pub const s_seg2_knee        : Int = 50              // L=50 boundary
pub const s_seg2_intercept_q : Int = 2_000_000_000   // 2.0
pub const s_seg2_slope_q     : Int = 5_000_000       // 0.005 per (L-50)
pub const s_seg3_knee        : Int = 150             // L=150 boundary
pub const s_seg3_intercept_q : Int = 2_500_000_000   // 2.5
pub const s_seg3_slope_q     : Int = 2_500_000       // 0.0025 per (L-150)

/// Shortest commitment ScheduleGen will accept, in epochs.
/// Mirror of `ScheduleGen/onchain/lib/magiclamp/protocol/constants.ak:25`.
pub const schedule_min_length : Int = 10

// ── instant_rate_q — the rate InstantGen is allowed to pay ───
// [Constitutional]
//
//   instant_rate_q = ⌊ snapshot_base_rate_q × S_Q(schedule_min_length) / Q ⌋
//                  = ⌊ 5_000_000_000 × 1_600_000_000 / 10⁹ ⌋
//                  = 8_000_000_000
//
// WHY THIS NUMBER AND NOT ANOTHER. The third brake used to be
// `0.5 × Σ over gen_schedules`, and SPEC §6.3 replaced that with
// `⌊L_avail × RATE_REF_Q / Q⌋` at `RATE_REF_Q = 10¹²` (ρ = 1 MAGIC/LAMP/epoch).
// Neither is usable as written:
//   · the old form is 0 whenever the vault has no schedule, which is why
//     InstantGen cannot issue at all today;
//   · ρ = 1 pays 10⁹ nanogic per LAMP per epoch, while a real ScheduleGen
//     commitment pays `rate_locked_q / Q` per oildrop — 8×10⁹/10⁹ = 8 nanogic
//     per oildrop at the shortest schedule, i.e. 8×10⁶ nanogic per LAMP. That
//     is a 125× gap between two doors onto the same LAMP — 250× once the `/2`
//     in `compute_cap_pp` is applied, which is the figure the test pins. Two
//     numbers, two quantities: 125× compares the RATES, 250× compares what a
//     vault actually receives. The gap opens the moment someone fixes
//     InstantGen without reading this.
//
// So the rate is pinned to what ScheduleGen actually pays, at its LEAST
// generous setting. The argument is a monotonicity one, not a taste one:
// `compute_s_q` is increasing in schedule length, so `S_Q(schedule_min_length)`
// is the smallest rate ScheduleGen ever grants. An InstantGen lock lasts one
// epoch — shorter than any schedule — so it may not be paid more than the
// shortest schedule. Every other choice would have to argue for a number;
// this one is the floor of an existing range.
pub const instant_rate_q : Int = 8_000_000_000

// ── Profile change cooldown (§12, C-PC-V2) ──────────────────
// [Routine] Minimum epochs between UpdateProfile calls
pub const profile_change_cooldown : Int = 2
