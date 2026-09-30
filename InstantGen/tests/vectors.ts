// tests/vectors.ts — InstantGen NORMATIVE test vectors (PHA 2)
//
// Source of truth: Specs/MagicLamp-Tripletoken-Feat-(Vi).md §4.2, §6.3, §11, §12.
// P8: the Aiken and TypeScript implementations MUST produce bit-identical
// output for every vector below. Every intermediate step is spelled out so a
// reviewer can recompute the value by hand.
//
// Parameters used throughout (constants.ak ↔ constants.ts):
//   Q                     = 1_000_000_000
//   INSTANT_REWARD_RATE_Q =   200_000_000   (0.20)
//   BR_SAFE_Q             = 1_500_000_000   (1.5)
//   F_CAP_SURPLUS_Q       =     1_000_000   (0.001)
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
  description: "cap_surplus with br=2.0, S=1000 MAGIC → 0.333333333 MAGIC",
  input: {
    br_q:         2_000_000_000n,       // 2.0
    magic_supply: 1_000_000_000_000n,   // 1000 MAGIC in nanogic
  },
  // f hạ 0,10 → 0,001 ngày 2026-09-14 (hàng rào tạm cho lỗ beacon-không-trừ-dần);
  // vector này đi theo vì nó ghim CÔNG THỨC, không ghim một con số lịch sử.
  // s1 = ⌊10^12 × 1_000_000 / Q⌋     =   1_000_000_000     (f·S)
  // excess = 2.0Q − 1.5Q             =     500_000_000
  // s2 = ⌊s1 × excess / Q⌋           =     500_000_000
  // s3 = ⌊s2 × Q / 1_500_000_000⌋    =     333_333_333
  steps: { s1: 1_000_000_000n, excess_q: 500_000_000n, s2: 500_000_000n },
  expected_nanogic: 333_333_333n,
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
  spec_ref:    "§6.3 phanh thứ ba (D2)",
  description: "L_avail = 4000 LAMP → ⌊4×10⁹ × 8×10⁹ / Q⌋ / 2 = 16 MAGIC/epoch",
  l_avail_oildrop: 4_000_000_000n,
  expected_per_epoch: 32_000_000_000n,   // trước khi chia đôi
  expected_cap:       16_000_000_000n,
};

// ── TV-IG-CAP-PP-02: tuyến tính theo L_avail ─────────────────
export const TV_IG_CAP_PP_02 = {
  id:          "TV-IG-CAP-PP-02",
  spec_ref:    "§6.3 phanh thứ ba (D2)",
  description: "Trần tỉ lệ thuận L_avail: 1000 LAMP cho đúng 1/4 của 4000 LAMP",
  l_avail_oildrop: 1_000_000_000n,
  expected_per_epoch: 8_000_000_000n,
  expected_cap:       4_000_000_000n,
};

// ── TV-IG-CAP-PP-ZERO: không còn LAMP tự do → không cấp ──────
export const TV_IG_CAP_PP_ZERO = {
  id:          "TV-IG-CAP-PP-ZERO",
  spec_ref:    "§6.3 phanh thứ ba (D2)",
  description: "L_avail = 0 (LAMP khoá hết) ⟹ cap = 0 ⟹ InstantGen đóng",
  l_avail_oildrop: 0n,
  expected_per_epoch: 0n,
  expected_cap:       0n,
  expected_validation: "REJECT",
  // ⚠ Vector này TỪNG mang tên "no ScheduleGen contract ⟹ shut" và pin một
  // bất biến nay KHÔNG còn: trần thứ ba không đọc `gen_schedules` nữa. Cùng
  // một mã định danh, khác hẳn mệnh đề — đừng trích nó như bằng chứng cho
  // trần-kép cũ.
};

// ── TV-IG-CAP-PP-DOOR: khoảng cách với suất spec, viết thành số ──
export const TV_IG_CAP_PP_DOOR = {
  id:          "TV-IG-CAP-PP-DOOR",
  spec_ref:    "SPEC §6.3 `RATE_REF_Q = 10¹²` đối chiếu D2",
  description:
    "Một LAMP: spec ghi 10⁹ nanogic/epoch (ρ=1), trần này cho 4×10⁶ — cách nhau 250 lần. " +
    "Cửa chênh lệch đó chỉ tồn tại khi InstantGen chạy được, nên nó đã nằm sẵn trong " +
    "bản vá của bất kỳ ai gỡ Nợ #19 mà không đọc chỗ này.",
  l_avail_oildrop:    1_000_000n,        // 1 LAMP
  spec_rate_ref_q:    1_000_000_000_000n,
  spec_would_pay:     1_000_000_000n,    // ⌊10⁶ × 10¹² / Q⌋
  expected_cap:       4_000_000n,
  ratio:              250n,
};

// ══════════════════════════════════════════════════════════════
// §6.3 — the whole gate: min of the three
// ══════════════════════════════════════════════════════════════

// ── TV-IG-GRANT-01: reward binds ─────────────────────────────
export const TV_IG_GRANT_01 = {
  id:          "TV-IG-GRANT-01",
  spec_ref:    "§6.3",
  description: "grant = min(reward, cap_surplus, cap_pp(L_avail)) — reward binds",
  input: {
    consumed:     1_000_000_000n,
    um_q:         1_000_000_000n,
    pm_q:         1_050_000_000n,
    br_q:         2_000_000_000n,
    magic_supply: 1_000_000_000_000n,
    l_avail_oildrop: 4_000_000_000n,   // 4000 LAMP tự do trong vault
  },
  ceilings: {
    reward:      210_000_000n,
    cap_surplus: 333_333_333n,        // f = 0,001 (hạ 2026-09-14)
    cap_pp:      16_000_000_000n,
  },
  expected_grant: 210_000_000n,
  binding: "reward(consumed)",
};

// ── TV-IG-GRANT-02: cap_pp binds ─────────────────────────────
export const TV_IG_GRANT_02 = {
  id:          "TV-IG-GRANT-02",
  spec_ref:    "§6.3 trần-kép",
  description: "A whale that consumed a lot is still capped by the LAMP it holds free",
  input: {
    consumed:     1_000_000_000_000n,   // 1000 MAGIC consumed
    um_q:         1_000_000_000n,
    pm_q:         1_050_000_000n,
    br_q:         2_000_000_000n,
    // Cung nâng 10^12 → 10^14 ngày 2026-09-14. LÝ DO, vì đây là đổi ĐẦU VÀO của
    // một vector chuẩn chứ không chỉ đổi kết quả: `f` hạ 0,10 → 0,001 làm
    // `cap_surplus` co đúng 100 lần, nên ở cung 1000 MAGIC thì CHÍNH NÓ thành
    // cái chặn — và vector này tồn tại để chứng minh `cap_pp` chặn. Giữ nguyên
    // đầu vào thì vector vẫn xanh nhưng xanh vì lý do khác với tên nó mang.
    // 10^14 × 0,001 = 10^12 × 0,10 ⟹ `cap_surplus` giữ nguyên 33_333_333_333.
    magic_supply: 100_000_000_000_000n,
    l_avail_oildrop: 4_000_000_000n,   // 4000 LAMP tự do trong vault
  },
  ceilings: {
    reward:      210_000_000_000n,      // 210 MAGIC
    cap_surplus: 33_333_333_333n,
    cap_pp:      16_000_000_000n,       // ← smallest
  },
  expected_grant: 16_000_000_000n,
  binding: "cap_pp(L_avail)",
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
    l_avail_oildrop: 4_000_000_000n,   // 4000 LAMP tự do trong vault
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
  //   s1 = ⌊S × f_q / Q⌋ needs S × 10^6 = 3.6×10^22 as an exact integer.
  // f hạ 10^8 → 10^6 ngày 2026-09-14; tích trung gian vẫn vượt xa 9×10^15, nên
  // mệnh đề vector này ghim (phải dùng BigInt) không đổi — chỉ số hạng đổi.
  magic_supply:  36_000_000_000_000_000n,
  f_cap_surplus: 1_000_000n,
  intermediate:  36_000_000_000_000_000_000_000n,
  step1_after_div: 36_000_000_000_000n,
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
  TV_IG_CAP_PP_DOOR,
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

// ── CC-GEN-LENT-READ — trần LAMP-mượn (P8) ──────────────────
// CÙNG SỐ với `onchain/lib/magiclamp/protocol/math.ak` ▸ `ig_lent_*_vector`.
// Aiken không đọc tệp này: ghim phía on-chain là các bài `.ak` đó, sửa số ở đây thì
// sửa số ở đó trong cùng commit.
// Chung: consumed = 10 MAGIC, UM = 1.0, Flame ⟹ reward = 2.1 MAGIC; br = 2.0,
// S = 10^15 nanogic ⟹ cap_surplus = 333_333_333_333 (không ràng buộc);
// L_avail = 100 LAMP ⟹ cap_pp = 0.4 MAGIC.
const TV_IG_LENT_COMMON = {
  consumed:        10_000_000_000n,
  um_q:            1_000_000_000n,
  pm_q:            1_050_000_000n,
  br_q:            2_000_000_000n,
  magic_supply:    1_000_000_000_000_000n,
  l_avail_oildrop: 100_000_000n,
};

export const TV_IG_LENT_ZERO = {
  id:          "TV-IG-LENT-ZERO",
  spec_ref:    "CC-GEN-LENT-READ",
  description: "L_lent = 0 ⟹ cap_lent = 0, grant = bản không-lent",
  input:       { ...TV_IG_LENT_COMMON, l_lent_oildrop: 0n },
  expected_cap_lent: 0n,
  expected_grant:    400_000_000n,
};

export const TV_IG_LENT_BELOW = {
  id:          "TV-IG-LENT-BELOW",
  spec_ref:    "CC-GEN-LENT-READ",
  description: "L_lent = 12 LAMP ⟹ cap_lent = cap_pp = 0.048 MAGIC (dưới LENT_PP_CAP)",
  input:       { ...TV_IG_LENT_COMMON, l_lent_oildrop: 12_000_000n },
  expected_cap_lent: 48_000_000n,
  expected_grant:    448_000_000n,
};

export const TV_IG_LENT_ABOVE = {
  id:          "TV-IG-LENT-ABOVE",
  spec_ref:    "CC-GEN-LENT-READ",
  description: "L_lent = 1001 LAMP ⟹ cap_pp 4.004 MAGIC bị kẹp ở LENT_PP_CAP = 1 MAGIC",
  input:       { ...TV_IG_LENT_COMMON, l_lent_oildrop: 1_001_000_000n },
  expected_cap_pp_of_lent: 4_004_000_000n,
  expected_cap_lent:       1_000_000_000n,
  expected_grant:          1_400_000_000n,
};

export const TV_IG_LENT_KNEE = {
  id:          "TV-IG-LENT-KNEE",
  spec_ref:    "CC-GEN-LENT-READ",
  description: "cap_pp chạm LENT_PP_CAP đúng ở 250 LAMP",
  cases: [
    { l_lent_oildrop: 250_000_000n, expected_cap_lent: 1_000_000_000n },
    { l_lent_oildrop: 249_999_999n, expected_cap_lent:   999_999_996n },
  ],
};

// ══════════════════════════════════════════════════════════════
// Gen v2.0 §6.1.1–§6.1.3 — công thức sinh chung F(L, usage_ratio, GB)
// ══════════════════════════════════════════════════════════════
// P8: literal GIỐNG HỆT khối "Vector chuẩn TV-GEN-*" trong
// `onchain/lib/magiclamp/protocol/gen_formula.ak`. Sửa một bên thì sửa bên kia.
// Chung: Q = 10⁹, sàn = 5×10⁸, coldstart = 7.5×10⁸, ρ = 4×10⁹ (suất tạm), LENT_PP_CAP = 10⁹.
// Cửa sổ: [ô0 (epoch mở), ô1 … ô6 (đã đóng)], mỗi ô là [generated, consumed].

export type GenCell = readonly [bigint, bigint];

export const TV_GEN_WINDOWS = {
  cold:        [[0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n]],
  cold_open:   [[5_000_000_000n, 5_000_000_000n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n]],
  zero_use:    [[0n, 0n], [6_000_000_000n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n]],
  full:        [[0n, 0n], [6_000_000_000n, 6_000_000_000n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n]],
  partial:     [[0n, 0n], [5_000_000_000n, 3_000_000_000n], [3_000_000_000n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n]],
  over:        [[0n, 0n], [2_000_000_000n, 3_000_000_000n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n]],
  round:       [[0n, 0n], [3n, 1n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n]],
  last_cell:   [[0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [4_000_000_000n, 1_000_000_000n]],
  full_big:    [[0n, 0n], [30_000_000_000n, 30_000_000_000n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n]],
  scale_round: [[0n, 0n], [7n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n]],
  seq:         [[1n, 1n], [2n, 2n], [3n, 3n], [4n, 4n], [5n, 5n], [6n, 6n], [7n, 7n]],
} as const satisfies Record<string, readonly GenCell[]>;

export type GenWindowName = keyof typeof TV_GEN_WINDOWS;

// ── TV-GEN-BASE-*: lamp_base_amount(l_owned, l_lent, rho_q) ──
export const TV_GEN_BASE = [
  { id: "TV-GEN-BASE-OWNED",         l_owned: 1_000_000_000n, l_lent: 0n,             rho_q: 4_000_000_000n, expected: 4_000_000_000n },
  { id: "TV-GEN-BASE-LENT-BELOW",    l_owned: 1_000_000_000n, l_lent: 100_000_000n,   rho_q: 4_000_000_000n, expected: 4_400_000_000n },
  { id: "TV-GEN-BASE-LENT-KNEE",     l_owned: 1_000_000_000n, l_lent: 250_000_000n,   rho_q: 4_000_000_000n, expected: 5_000_000_000n },
  { id: "TV-GEN-BASE-LENT-CAP",      l_owned: 1_000_000_000n, l_lent: 1_001_000_000n, rho_q: 4_000_000_000n, expected: 5_000_000_000n },
  // sàn RIÊNG từng vế: ⌊1.5⌋ + ⌊1.5⌋ = 2 (bản gộp ra 3)
  { id: "TV-GEN-BASE-FLOOR-PER-TERM", l_owned: 1n,            l_lent: 1n,             rho_q: 1_500_000_000n, expected: 2n },
  { id: "TV-GEN-BASE-RHO-ZERO",      l_owned: 1_000_000_000n, l_lent: 1_001_000_000n, rho_q: 0n,             expected: 0n },
] as const;

// ── TV-GEN-USAGE-*: usage_ratio_q(window), usage_factor_q(window) ──
export const TV_GEN_USAGE = [
  { id: "TV-GEN-USAGE-COLD",        window: "cold",      ratio_q: 0n,             factor_q: 750_000_000n },
  { id: "TV-GEN-USAGE-COLD-OPEN",   window: "cold_open", ratio_q: 0n,             factor_q: 750_000_000n },   // ô 0 không đếm
  { id: "TV-GEN-USAGE-ZERO-USE",    window: "zero_use",  ratio_q: 0n,             factor_q: 500_000_000n },   // ↔ COLD: chỉ khác Σg
  { id: "TV-GEN-USAGE-FULL",        window: "full",      ratio_q: 1_000_000_000n, factor_q: 1_000_000_000n }, // ↔ ZERO-USE: chỉ khác Σc
  { id: "TV-GEN-USAGE-PARTIAL",     window: "partial",   ratio_q: 375_000_000n,   factor_q: 687_500_000n },
  { id: "TV-GEN-USAGE-OVER",        window: "over",      ratio_q: 1_000_000_000n, factor_q: 1_000_000_000n }, // kẹp Q
  { id: "TV-GEN-USAGE-ROUND",       window: "round",     ratio_q: 333_333_333n,   factor_q: 666_666_666n },
  { id: "TV-GEN-USAGE-LAST-CELL",   window: "last_cell", ratio_q: 250_000_000n,   factor_q: 625_000_000n },   // ô 6 có đếm
] as const satisfies readonly { window: GenWindowName }[];

// ── TV-GEN-SCALE-*: scale_limit(window, horizon, base) ──
export const TV_GEN_SCALE = [
  { id: "TV-GEN-SCALE-COLD",      window: "cold",        horizon: 6n, base: 4_000_000_000n, expected: 4_000_000_000n },
  { id: "TV-GEN-SCALE-COLD-OPEN", window: "cold_open",   horizon: 6n, base: 4_000_000_000n, expected: 4_000_000_000n },
  { id: "TV-GEN-SCALE-IG",        window: "full",        horizon: 6n, base: 4_000_000_000n, expected: 1_000_000_000n },
  { id: "TV-GEN-SCALE-H3",        window: "full",        horizon: 3n, base: 4_000_000_000n, expected: 2_000_000_000n },
  { id: "TV-GEN-SCALE-H0",        window: "full",        horizon: 0n, base: 4_000_000_000n, expected: 0n },
  { id: "TV-GEN-SCALE-ROUND",     window: "scale_round", horizon: 6n, base: 100n,           expected: 1n },
] as const satisfies readonly { window: GenWindowName }[];

// ── TV-GEN-AMOUNT-*: amount_by_lamp(l_owned, l_lent, window, rho_q, horizon) ──
export const TV_GEN_AMOUNT = [
  { id: "TV-GEN-AMOUNT-COLD",               l_owned: 1_000_000_000n,          l_lent: 0n,             window: "cold",     rho_q: 4_000_000_000n, horizon: 6n, expected: 3_000_000_000n },
  { id: "TV-GEN-AMOUNT-ZERO-USE",           l_owned: 1_000_000_000n,          l_lent: 0n,             window: "zero_use", rho_q: 4_000_000_000n, horizon: 6n, expected: 2_000_000_000n },
  { id: "TV-GEN-AMOUNT-SCALE-BINDS",        l_owned: 1_000_000_000n,          l_lent: 0n,             window: "full",     rho_q: 4_000_000_000n, horizon: 6n, expected: 2_500_000_000n },
  { id: "TV-GEN-AMOUNT-SCALE-FREE-SMALL-L", l_owned: 200_000_000n,            l_lent: 0n,             window: "full",     rho_q: 4_000_000_000n, horizon: 6n, expected: 800_000_000n },
  { id: "TV-GEN-AMOUNT-SCALE-FREE-BIG-HIST",l_owned: 1_000_000_000n,          l_lent: 0n,             window: "full_big", rho_q: 4_000_000_000n, horizon: 6n, expected: 4_000_000_000n },
  { id: "TV-GEN-AMOUNT-LENT-BELOW",         l_owned: 1_000_000_000n,          l_lent: 100_000_000n,   window: "cold",     rho_q: 4_000_000_000n, horizon: 6n, expected: 3_300_000_000n },
  { id: "TV-GEN-AMOUNT-LENT-CAP",           l_owned: 1_000_000_000n,          l_lent: 1_001_000_000n, window: "cold",     rho_q: 4_000_000_000n, horizon: 6n, expected: 3_750_000_000n },
  { id: "TV-GEN-AMOUNT-HORIZON-ZERO",       l_owned: 1_000_000_000n,          l_lent: 0n,             window: "full",     rho_q: 4_000_000_000n, horizon: 0n, expected: 0n },
  // sàn tuần tự: 1 + 0 = 1 (bản gộp ⌊3×7.5e8/Q⌋ ra 2)
  { id: "TV-GEN-AMOUNT-ROUND-SEQ",          l_owned: 3n,                      l_lent: 0n,             window: "cold",     rho_q: 1_000_000_000n, horizon: 6n, expected: 1n },
  // tràn số: trần cung 36×10¹⁵ oildrop × RHO_MAX_Q, tích trung gian 1.44×10²⁶
  { id: "TV-GEN-AMOUNT-OVERFLOW",           l_owned: 36_000_000_000_000_000n, l_lent: 0n,             window: "cold",     rho_q: 4_000_000_000n, horizon: 6n, expected: 108_000_000_000_000_000n },
] as const satisfies readonly { window: GenWindowName }[];

// ── TV-GEN-GB-*: generation_amount(amount_by_lamp, gb_available) ──
export const TV_GEN_GB = [
  { id: "TV-GEN-GB-BINDS", amount_by_lamp: 3_000_000_000n, gb_available: 1_000_000_000n, expected: 1_000_000_000n },
  { id: "TV-GEN-GB-FREE",  amount_by_lamp: 3_000_000_000n, gb_available: 5_000_000_000n, expected: 3_000_000_000n },
  { id: "TV-GEN-GB-EQUAL", amount_by_lamp: 3_000_000_000n, gb_available: 3_000_000_000n, expected: 3_000_000_000n },
  { id: "TV-GEN-GB-ZERO",  amount_by_lamp: 3_000_000_000n, gb_available: 0n,             expected: 0n },
] as const;

// ── TV-GEN-VAULT-SHARE-*: gb_vault_share(reset_amount) ──
export const TV_GEN_VAULT_SHARE = [
  { id: "TV-GEN-VAULT-SHARE-CAP", reset_amount: 1_800_000_000_000_000n, expected: 90_000_000_000_000n },
  { id: "TV-GEN-VAULT-SHARE-19",  reset_amount: 19n,                    expected: 0n },
  { id: "TV-GEN-VAULT-SHARE-20",  reset_amount: 20n,                    expected: 1n },
  { id: "TV-GEN-VAULT-SHARE-0",   reset_amount: 0n,                     expected: 0n },
] as const;

// ── TV-GEN-SHIFT-*: shift_window(seq, 100, to_epoch) ──
export const TV_GEN_SHIFT = [
  { id: "TV-GEN-SHIFT-K0",   from_epoch: 100n, to_epoch: 100n, expected: TV_GEN_WINDOWS.seq },
  { id: "TV-GEN-SHIFT-K1",   from_epoch: 100n, to_epoch: 101n, expected: [[0n, 0n], [1n, 1n], [2n, 2n], [3n, 3n], [4n, 4n], [5n, 5n], [6n, 6n]] },
  { id: "TV-GEN-SHIFT-K6",   from_epoch: 100n, to_epoch: 106n, expected: [[0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [0n, 0n], [1n, 1n]] },
  { id: "TV-GEN-SHIFT-K7",   from_epoch: 100n, to_epoch: 107n, expected: TV_GEN_WINDOWS.cold },
  { id: "TV-GEN-SHIFT-K100", from_epoch: 100n, to_epoch: 200n, expected: TV_GEN_WINDOWS.cold },
] as const satisfies readonly { expected: readonly GenCell[] }[];

// ── TV-GEN-ADD-01: window_add(seq, 10, 3) ──
export const TV_GEN_ADD_01 = {
  id: "TV-GEN-ADD-01", generated: 10n, consumed: 3n,
  expected: [[11n, 4n], [2n, 2n], [3n, 3n], [4n, 4n], [5n, 5n], [6n, 6n], [7n, 7n]],
} as const;
