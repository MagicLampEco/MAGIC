// tests/vectors.ts — InstantGen NORMATIVE test vectors (PHA 2)
//
// Source of truth: SPEC/MagicLamp-Tripletoken-Feat-(Vi).md §4.2, §6.3, §11, §12.
// P8: the Aiken and TypeScript implementations MUST produce bit-identical
// output for every vector below. Every intermediate step is spelled out so a
// reviewer can recompute the value by hand.
//
// Parameters used throughout (constants.ak ↔ constants.ts):
//   Q                     = 1_000_000_000
//   INSTANT_REWARD_RATE_Q =   200_000_000   (0.20)
//   BR_SAFE_Q             = 1_500_000_000   (1.5)
//   F_CAP_SURPLUS_Q       =   100_000_000   (0.10)
//   PM: Ember 1.15 / Flame 1.05 / Lantern 1.00
//   UM ∈ [0.5, 2.0], fallback 0.5

export interface Vector {
  id         : string;
  spec_ref   : string;
  description: string;
}

// ══════════════════════════════════════════════════════════════
// §4.2 — per-epoch use-or-lose CLIFF (decay_window = 1)
// ══════════════════════════════════════════════════════════════

// ── TV-CLIFF-01: a batch lives exactly one epoch ─────────────
export const TV_CLIFF_01 = {
  id:          "TV-CLIFF-01",
  spec_ref:    "§4.2",
  description: "Batch is LIVE only in created_epoch; DEAD from created_epoch+1. No halving.",
  input: {
    initial_amount : 1_000_000_000n,
    current_amount : 1_000_000_000n,
    decay_window   : 1n,
    created_epoch  : 100n,
  },
  cases: [
    { current_epoch: 100n, k: 0n, expired: false, balance: 1_000_000_000n },
    { current_epoch: 101n, k: 1n, expired: true,  balance: 0n },   // cliff — NOT halved
    { current_epoch: 102n, k: 2n, expired: true,  balance: 0n },
  ],
};

// ── TV-CLIFF-02: no carry-over, no hoarding ──────────────────
export const TV_CLIFF_02 = {
  id:          "TV-CLIFF-02",
  spec_ref:    "§4.2",
  description: "Unconsumed MAGIC does NOT roll into the next epoch — it resets to 0.",
  epoch_100_granted:   3_150_000_000n,
  epoch_100_consumed:  1_000_000_000n,
  // The remaining 2.15 MAGIC is NOT available at epoch 101:
  epoch_101_balance:   0n,
  // A burn aimed at that batch at epoch 101 must be REJECTED on-chain.
  epoch_101_burn_expected: "REJECT",   // vault.ak test: bb_dead_batch_rejected
};

// ══════════════════════════════════════════════════════════════
// §6.3 — reward(consumed): magnitude keyed to MAGIC CONSUMED
// ══════════════════════════════════════════════════════════════

// ── TV-IG-REWARD-01: 1 MAGIC consumed, Flame, UM = 1.0 ───────
export const TV_IG_REWARD_01 = {
  id:          "TV-IG-REWARD-01",
  spec_ref:    "§6.3",
  description: "reward(1 MAGIC consumed), Flame, UM=1.0 → 0.21 MAGIC",
  input: {
    consumed: 1_000_000_000n,   // 1 MAGIC in nanogic
    um_q:     1_000_000_000n,   // 1.0
    pm_q:     1_050_000_000n,   // Flame
  },
  // s1 = ⌊10^9 × 200_000_000 / Q⌋ =   200_000_000
  // s2 = ⌊s1   × 10^9        / Q⌋ =   200_000_000
  // s3 = ⌊s2   × 1_050_000_000/Q⌋ =   210_000_000
  steps: { s1: 200_000_000n, s2: 200_000_000n, s3: 210_000_000n },
  expected_nanogic: 210_000_000n,
};

// ── TV-IG-REWARD-02: 5 MAGIC consumed, Ember, UM = 1.5 ───────
export const TV_IG_REWARD_02 = {
  id:          "TV-IG-REWARD-02",
  spec_ref:    "§6.3",
  description: "reward(5 MAGIC consumed), Ember, UM=1.5 → 1.725 MAGIC",
  input: {
    consumed: 5_000_000_000n,
    um_q:     1_500_000_000n,
    pm_q:     1_150_000_000n,
  },
  // s1 = 1_000_000_000 ; s2 = 1_500_000_000 ; s3 = 1_725_000_000
  steps: { s1: 1_000_000_000n, s2: 1_500_000_000n, s3: 1_725_000_000n },
  expected_nanogic: 1_725_000_000n,
};

// ── TV-IG-REWARD-03: INV-CASHBACK-BOUND worst case ───────────
// Highest possible multiplier chain: UM_MAX (2.0) × PM_MAX (Ember 1.15).
export const TV_IG_REWARD_03 = {
  id:          "TV-IG-REWARD-03",
  spec_ref:    "§12 INV-CASHBACK-BOUND",
  description: "Even at UM_MAX × PM_MAX the reward stays below the consumed amount",
  input: {
    consumed: 1_000_000_000n,
    um_q:     2_000_000_000n,   // UM_MAX
    pm_q:     1_150_000_000n,   // PM_MAX
  },
  // s1 = 200_000_000 ; s2 = 400_000_000 ; s3 = 460_000_000
  expected_nanogic: 460_000_000n,
  // 0.46 × consumed < consumed ⟹ a self-burn loop is strictly net-negative.
  effective_rate_q: 460_000_000n,
  bound_holds: true,
};

// ── TV-IG-REWARD-ZERO: no consumption → no reward ────────────
export const TV_IG_REWARD_ZERO = {
  id:          "TV-IG-REWARD-ZERO",
  spec_ref:    "§6.3 'nắm LAMP chỉ MỞ TƯ CÁCH'",
  description: "Holding LAMP without consuming any MAGIC yields exactly 0",
  input: { consumed: 0n, um_q: 2_000_000_000n, pm_q: 1_150_000_000n },
  expected_nanogic: 0n,
  // The validator rejects a zero grant outright (no-op tx).
  expected_validation: "REJECT",
};

// ══════════════════════════════════════════════════════════════
// §6.3 — cap_surplus(br): the backing gate
// ══════════════════════════════════════════════════════════════

// ── TV-IG-CAP-SURPLUS-01: xanh, br = 2.0 ─────────────────────
export const TV_IG_CAP_SURPLUS_01 = {
  id:          "TV-IG-CAP-SURPLUS-01",
  spec_ref:    "§6.3",
  description: "cap_surplus with br=2.0, S=1000 MAGIC → 33.333333333 MAGIC",
  input: {
    br_q:         2_000_000_000n,       // 2.0
    magic_supply: 1_000_000_000_000n,   // 1000 MAGIC in nanogic
  },
  // s1 = ⌊10^12 × 100_000_000 / Q⌋   = 100_000_000_000     (f·S)
  // excess = 2.0Q − 1.5Q             =     500_000_000
  // s2 = ⌊s1 × excess / Q⌋           =  50_000_000_000
  // s3 = ⌊s2 × Q / 1_500_000_000⌋    =  33_333_333_333
  steps: { s1: 100_000_000_000n, excess_q: 500_000_000n, s2: 50_000_000_000n },
  expected_nanogic: 33_333_333_333n,
};

// ── TV-IG-CAP-SURPLUS-02: boundary br == br_safe → ĐỎ ────────
export const TV_IG_CAP_SURPLUS_02 = {
  id:          "TV-IG-CAP-SURPLUS-02",
  spec_ref:    "§6.3 'Đỏ (br ≤ br_safe): cap = 0'",
  description: "br exactly at br_safe is RED (≤, not <) → cap = 0",
  input: { br_q: 1_500_000_000n, magic_supply: 1_000_000_000_000n },
  expected_nanogic: 0n,
};

// ── TV-IG-CAP-SURPLUS-03: đỏ, br < br_safe ───────────────────
export const TV_IG_CAP_SURPLUS_03 = {
  id:          "TV-IG-CAP-SURPLUS-03",
  spec_ref:    "§6.3",
  description: "br=1.4 below br_safe=1.5 → Gen locked (cap = 0)",
  input: { br_q: 1_400_000_000n, magic_supply: 1_000_000_000_000n },
  expected_nanogic: 0n,
};

// ── TV-IG-BEACON-ABSENT: fail-closed ─────────────────────────
export const TV_IG_BEACON_ABSENT = {
  id:          "TV-IG-BEACON-ABSENT",
  spec_ref:    "§6.3 + §12 F6",
  description:
    "No beacon / wrong address / stale beacon / depeg ⟹ the tx does NOT validate. " +
    "There is deliberately NO default br — the safe direction is a shut door.",
  cases: [
    { situation: "missing reference input", expected_validation: "REJECT" },
    { situation: "beacon NFT at a non-canonical address", expected_validation: "REJECT" },
    { situation: "beacon older than MAX_BACKING_STALE=1", expected_validation: "REJECT" },
    { situation: "depeg = true", expected_validation: "REJECT" },
  ],
};

// ══════════════════════════════════════════════════════════════
// §6.3 — 0.5 × pp_schedule: the dual ceiling
// ══════════════════════════════════════════════════════════════

// ── TV-IG-CAP-PP-01 ──────────────────────────────────────────
export const TV_IG_CAP_PP_01 = {
  id:          "TV-IG-CAP-PP-01",
  spec_ref:    "§6.3 'trần-kép' + §6.4",
  description: "One schedule λ=4000 LAMP, rate_locked_q=11.25 → pp=45 MAGIC, cap=22.5 MAGIC",
  schedules: [
    { lamp_per_epoch: 4_000_000_000n, rate_locked_q: 11_250_000_000n },
  ],
  // pp = ⌊4×10^9 × 11_250_000_000 / Q⌋ = 45_000_000_000
  expected_pp:  45_000_000_000n,
  expected_cap: 22_500_000_000n,
};

// ── TV-IG-CAP-PP-02: two schedules add up ────────────────────
export const TV_IG_CAP_PP_02 = {
  id:          "TV-IG-CAP-PP-02",
  spec_ref:    "§6.3",
  description: "pp_schedule sums over every live contract in the vault",
  schedules: [
    { lamp_per_epoch: 4_000_000_000n, rate_locked_q: 11_250_000_000n },  // 45 MAGIC
    { lamp_per_epoch: 1_000_000_000n, rate_locked_q:  8_000_000_000n },  //  8 MAGIC
  ],
  expected_pp:  53_000_000_000n,
  expected_cap: 26_500_000_000n,
};

// ── TV-IG-CAP-PP-ZERO: no schedule → door shut ───────────────
export const TV_IG_CAP_PP_ZERO = {
  id:          "TV-IG-CAP-PP-ZERO",
  spec_ref:    "§6.3 'InstantGen ≤ 0.5×Schedule mọi trạng thái'",
  description: "A vault with no ScheduleGen contract has pp=0 ⟹ cap=0 ⟹ InstantGen SHUT",
  schedules: [] as { lamp_per_epoch: bigint; rate_locked_q: bigint }[],
  expected_pp:  0n,
  expected_cap: 0n,
  expected_validation: "REJECT",
};

// ══════════════════════════════════════════════════════════════
// §6.3 — the whole gate: min of the three
// ══════════════════════════════════════════════════════════════

// ── TV-IG-GRANT-01: reward binds ─────────────────────────────
export const TV_IG_GRANT_01 = {
  id:          "TV-IG-GRANT-01",
  spec_ref:    "§6.3",
  description: "grant = min(reward, cap_surplus, 0.5×pp) — reward is the binding ceiling",
  input: {
    consumed:     1_000_000_000n,
    um_q:         1_000_000_000n,
    pm_q:         1_050_000_000n,
    br_q:         2_000_000_000n,
    magic_supply: 1_000_000_000_000n,
    schedules: [{ lamp_per_epoch: 4_000_000_000n, rate_locked_q: 11_250_000_000n }],
  },
  ceilings: {
    reward:      210_000_000n,
    cap_surplus: 33_333_333_333n,
    cap_pp:      22_500_000_000n,
  },
  expected_grant: 210_000_000n,
  binding: "reward(consumed)",
};

// ── TV-IG-GRANT-02: cap_pp binds ─────────────────────────────
export const TV_IG_GRANT_02 = {
  id:          "TV-IG-GRANT-02",
  spec_ref:    "§6.3 trần-kép",
  description: "A whale that consumed a lot is still capped at 0.5 × pp_schedule",
  input: {
    consumed:     1_000_000_000_000n,   // 1000 MAGIC consumed
    um_q:         1_000_000_000n,
    pm_q:         1_050_000_000n,
    br_q:         2_000_000_000n,
    magic_supply: 1_000_000_000_000n,
    schedules: [{ lamp_per_epoch: 4_000_000_000n, rate_locked_q: 11_250_000_000n }],
  },
  ceilings: {
    reward:      210_000_000_000n,      // 210 MAGIC
    cap_surplus: 33_333_333_333n,
    cap_pp:      22_500_000_000n,       // ← smallest
  },
  expected_grant: 22_500_000_000n,
  binding: "0.5 × pp_schedule",
};

// ── TV-IG-GRANT-03: red backing shuts everything ─────────────
export const TV_IG_GRANT_03 = {
  id:          "TV-IG-GRANT-03",
  spec_ref:    "§6.3 'đỏ thì khoá Gen'",
  description: "br ≤ br_safe ⟹ cap_surplus = 0 ⟹ grant = 0 regardless of consumption",
  input: {
    consumed:     1_000_000_000_000n,
    um_q:         2_000_000_000n,
    pm_q:         1_150_000_000n,
    br_q:         1_400_000_000n,       // đỏ
    magic_supply: 1_000_000_000_000n,
    schedules: [{ lamp_per_epoch: 4_000_000_000n, rate_locked_q: 11_250_000_000n }],
  },
  expected_grant: 0n,
  expected_validation: "REJECT",
};

// ══════════════════════════════════════════════════════════════
// I-ACT-7 — LAMP does not move
// ══════════════════════════════════════════════════════════════

export const TV_ACT_7 = {
  id:          "TV-ACT-7",
  spec_ref:    "§6.1, §12 I-ACT-7",
  description: "InstantGen leaves every LAMP-bearing field byte-identical",
  before: {
    vault_lamp_balance : 100_000_000_000n,
    vault_lamp_locked  : 0n,
    loyalty_holdings   : [{ amount: 100_000_000_000n, acquired_epoch: 50n, is_locked: false }],
  },
  after: {
    vault_lamp_balance : 100_000_000_000n,   // UNCHANGED
    vault_lamp_locked  : 0n,                 // UNCHANGED
    loyalty_holdings   : [{ amount: 100_000_000_000n, acquired_epoch: 50n, is_locked: false }],
  },
  // Any tx that moves LAMP out of the vault must be rejected, even when the
  // datum is internally consistent with the reduced value.
  lamp_out_expected_validation: "REJECT",   // vault.ak test: ig_neg_lamp_moved
};

// ══════════════════════════════════════════════════════════════
// Eligibility (§6.3 'nắm LAMP chỉ MỞ TƯ CÁCH')
// ══════════════════════════════════════════════════════════════

export const TV_IG_ELIGIBILITY = {
  id:          "TV-IG-ELIGIBILITY",
  spec_ref:    "§6.3",
  description: "LAMP threshold is a DOOR, not a price: it gates access and is never spent",
  min_holding_oildrop: 10_000_000n,   // 10 LAMP
  cases: [
    { lamp_balance:  9_999_999n, lamp_locked: 0n,          expected: "REJECT" },
    { lamp_balance: 10_000_000n, lamp_locked: 0n,          expected: "ACCEPT" },
    // Locked LAMP does not buy eligibility (L_avail < min).
    { lamp_balance: 10_000_000n, lamp_locked: 10_000_000n, expected: "REJECT" },
  ],
};

// ══════════════════════════════════════════════════════════════
// C-UM-6 — UM staleness (Instant only)
// ══════════════════════════════════════════════════════════════

// ── TV-UM-SPLIT ──────────────────────────────────────────────
export const TV_UM_SPLIT = {
  id:          "TV-UM-SPLIT",
  spec_ref:    "C-UM-6",
  description: "Instant gets the fallback when UM is stale",
  um_datum: {
    smoothed_q:         2_000_000_000n,    // 2.0
    last_updated_epoch: 98n,
    history:            [],
  },
  current_epoch: 100n,
  staleness: 2n,                    // > UM_MAX_STALENESS = 1
  instant_result: 500_000_000n,     // UM_FALLBACK_Q = UM_MIN_Q ✓
};

// ── TV-UM-FRESH ──────────────────────────────────────────────
export const TV_UM_FRESH = {
  id:          "TV-UM-FRESH",
  spec_ref:    "C-UM-6",
  description: "UM fresh (staleness = 1, the boundary) — use smoothed",
  um_datum: {
    smoothed_q:         1_500_000_000n,    // 1.5
    last_updated_epoch: 99n,
    history:            [],
  },
  current_epoch: 100n,
  staleness:     1n,
  instant_result: 1_500_000_000n,
};

// ══════════════════════════════════════════════════════════════
// C-OVERFLOW — BigInt is mandatory
// ══════════════════════════════════════════════════════════════

// ── TV-OVERFLOW-01 ───────────────────────────────────────────
export const TV_OVERFLOW_01 = {
  id:          "TV-OVERFLOW-01",
  spec_ref:    "§11 C-OVERFLOW",
  description: "Intermediate products blow past Number.MAX_SAFE_INTEGER (≈9×10^15)",
  // S = 36×10^15 nanogic of effective supply through cap_surplus:
  //   s1 = ⌊S × f_q / Q⌋ needs S × 10^8 = 3.6×10^24 as an exact integer.
  magic_supply:  36_000_000_000_000_000n,
  f_cap_surplus: 100_000_000n,
  intermediate:  3_600_000_000_000_000_000_000_000n,
  step1_after_div: 3_600_000_000_000_000n,
  use_bigint: true,   // MANDATORY
};

// ── TV-OVERFLOW-02 ───────────────────────────────────────────
export const TV_OVERFLOW_02 = {
  id:          "TV-OVERFLOW-02",
  spec_ref:    "§11 C-OVERFLOW",
  description: "ScheduleGen S_Q intermediate overflows Number",
  // S_Q(200) = 2_625_000_000 ; SNAPSHOT_BASE_RATE_Q = 5_000_000_000
  intermediate: 13_125_000_000_000_000_000n,
  use_bigint: true,
};

// ══════════════════════════════════════════════════════════════
// Vault limits
// ══════════════════════════════════════════════════════════════

export const TV_INST_VAULT_FULL = {
  id:          "TV-INST-VAULT-FULL",
  spec_ref:    "§11 MAX_BATCHES_PER_VAULT",
  description: "Cannot add a batch when 32 LIVE batches are already present",
  live_batch_count: 32,
  expected: "REJECT",
};

// ── Export all vectors ────────────────────────────────────────
export const ALL_VECTORS = [
  TV_CLIFF_01,
  TV_CLIFF_02,
  TV_IG_REWARD_01,
  TV_IG_REWARD_02,
  TV_IG_REWARD_03,
  TV_IG_REWARD_ZERO,
  TV_IG_CAP_SURPLUS_01,
  TV_IG_CAP_SURPLUS_02,
  TV_IG_CAP_SURPLUS_03,
  TV_IG_BEACON_ABSENT,
  TV_IG_CAP_PP_01,
  TV_IG_CAP_PP_02,
  TV_IG_CAP_PP_ZERO,
  TV_IG_GRANT_01,
  TV_IG_GRANT_02,
  TV_IG_GRANT_03,
  TV_ACT_7,
  TV_IG_ELIGIBILITY,
  TV_UM_SPLIT,
  TV_UM_FRESH,
  TV_OVERFLOW_01,
  TV_OVERFLOW_02,
  TV_INST_VAULT_FULL,
] as const;
