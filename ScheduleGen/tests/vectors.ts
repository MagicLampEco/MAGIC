// tests/vectors.ts — ScheduleGen Test Vectors (NORMATIVE — App B §B.5)
// TV-SCH-01..06, TV-SCH-CATCHUP-LIMIT, TV-SCH-FIRE-PERM

// ══════════════════════════════════════════════════════════════
// TV-SCH-01: S(L) piecewise — 5 values (T11 continuity, T12 diminishing)
// ══════════════════════════════════════════════════════════════
export const TV_SCH_01 = {
  id: "TV-SCH-01", spec_ref: "App B §B.5",
  description: "S_Q(L) piecewise — including continuity at L=50 and L=150",
  cases: [
    { L: 10n,  S_Q: 1_600_000_000n, note: "seg1: 1.5B + 10M×10 = 1.6B" },
    { L: 50n,  S_Q: 2_000_000_000n, note: "T11 continuity: seg1(50)=seg2(50)=2.0B ✓" },
    { L: 100n, S_Q: 2_250_000_000n, note: "seg2: 2.0B + 5M×50 = 2.25B" },
    { L: 150n, S_Q: 2_500_000_000n, note: "T11 continuity: seg2(150)=seg3(150)=2.5B ✓" },
    { L: 200n, S_Q: 2_625_000_000n, note: "seg3: 2.5B + 2.5M×50 = 2.625B" },
  ],
  // T12: dS/dL strictly decreasing: 10M > 5M > 2.5M (slopes) ✓
};

// ══════════════════════════════════════════════════════════════
// TV-SCH-02: L=100, λ=4000 LAMP, R=5.0 → 45 MAGIC/fire (§11.11 Bob)
// ══════════════════════════════════════════════════════════════
export const TV_SCH_02 = {
  id: "TV-SCH-02", spec_ref: "App B §B.5, §11.11",
  description: "L=100, λ=4000 LAMP → 45 MAGIC/fire; total 4500 MAGIC",
  L:            100n,
  lambda_lamp:  4_000n,
  lambda_oildrop:   4_000_000_000n,         // 4000 × 10^6
  r_snap_q:     5_000_000_000n,
  // S_Q(100) = 2_000_000_000 + 5_000_000×50 = 2_250_000_000
  S_Q:          2_250_000_000n,
  // rate_locked_q = ⌊5B × 2.25B / Q⌋ = 11_250_000_000
  rate_locked_q: 11_250_000_000n,
  // M_i = ⌊4×10⁹ × 11_250_000_000 / Q⌋ = 45_000_000_000
  M_i:          45_000_000_000n,        // 45 MAGIC ✓
  total_magic:  4_500_000_000_000n,     // 100 × 45 = 4500 MAGIC ✓
  total_lock:   400_000_000_000_000n,   // 100 × 4000 × 10^6 = 400,000 LAMP (oildrop)
  // C-SCH-RATE: 4×10⁹ × 11_250_000_000 = 4.5×10¹⁹ ≥ Q ✓
  sch_rate_check: 45_000_000_000_000_000_000n >= 1_000_000_000n,
};

// ══════════════════════════════════════════════════════════════
// TV-SCH-03: Rate immutability (T8)
// ══════════════════════════════════════════════════════════════
export const TV_SCH_03 = {
  id: "TV-SCH-03", spec_ref: "App B §B.5, T8",
  description: "DAO raises R at epoch 70; fire at ep80 still uses committed rate",
  commit_epoch:     50n,
  rate_at_commit:   11_250_000_000n,      // locked at epoch 50
  dao_update_epoch: 70n,
  fire_epoch:       80n,
  M_at_fire:        45_000_000_000n,      // UNCHANGED — uses stored rate ✓
  // Validator reads GenSchedule.rate_locked_q, NOT global R_snap
};

// ══════════════════════════════════════════════════════════════
// TV-SCH-04: Participation cap per shard (T13, C-SCH-CAP)
// ══════════════════════════════════════════════════════════════
export const TV_SCH_04 = {
  id: "TV-SCH-04", spec_ref: "App B §B.5, T13, C-SCH-CAP",
  description: "Shard cap enforcement: 4.5×10¹⁴ oildrop per shard",
  shard_cap:    450_000_000_000_000n,     // 4.5×10¹⁴ = 450M LAMP
  shard_locked: 440_000_000_000_000n,     // 4.4×10¹⁴ already locked
  cases: [
    {
      L: 100n, lambda_oildrop: 10_000_000_000n,   // λ=10,000 LAMP, total=10^12
      total: 1_000_000_000_000n,
      new_locked: 441_000_000_000_000n,        // 4.4×10¹⁴ + 10¹² = 4.41×10¹⁴ ≤ 4.5×10¹⁴
      expected: "ACCEPT",
    },
    {
      L: 200n, lambda_oildrop: 500_000_000_000n,  // λ=500,000 LAMP, total=10¹⁴
      total: 100_000_000_000_000n,
      new_locked: 541_000_000_000_000n,        // 4.41×10¹⁴ + 10¹⁴ > 4.5×10¹⁴
      expected: "REJECT",
    },
  ],
};

// ══════════════════════════════════════════════════════════════
// TV-SCH-05: C-SCH-RATE — prevents M_i = 0 at commit
// ══════════════════════════════════════════════════════════════
export const TV_SCH_05 = {
  id: "TV-SCH-05", spec_ref: "App B §B.5, T19, C-SCH-RATE",
  description: "Low R_snap + small λ → M_i=0 → REJECT at commit",
  r_snap_q:         100n,                  // very low (not realistic but illustrative)
  lambda_oildrop:        1_000_000n,           // 1 LAMP (minimum)
  L:                 10n,
  S_Q_at_10:         1_600_000_000n,
  rate_locked_q:     160n,                 // ⌊100 × 1.6B / Q⌋ = 160
  M_i:               0n,                  // ⌊10^6 × 160 / Q⌋ = 0 < 1
  // λ × rate_locked_q = 10^6 × 160 = 1.6×10^8 < Q=10^9 → REJECT ✓
  sch_rate_violated: true,
  expected: "REJECT",
};

// ══════════════════════════════════════════════════════════════
// TV-SCH-06: Catch-up — 4 missed epochs (§11.11 Bob example)
// ══════════════════════════════════════════════════════════════
export const TV_SCH_06 = {
  id: "TV-SCH-06", spec_ref: "App B §B.5, §11.11, C-FIRE-1",
  description: "Missed epochs 52-54. Fire at ep55: 4 orders catch-up",
  start_fire_epoch: 52n,      // commit_epoch=50, delay=2
  fired_count:       0n,      // nothing fired yet
  current_epoch:    55n,
  M_i:              45_000_000_000n,
  // Eligible: e_0=52≤55, e_1=53≤55, e_2=54≤55, e_3=55≤55 → 4 fires (< 8 limit)
  fires_in_tx:       4,
  total_magic_fired: 180_000_000_000n,  // 4 × 45 MAGIC = 180 MAGIC
  lamp_transferred:  16_000_000_000n,   // 4 × 4000 LAMP oildrop
  output_fired_count: 4n,               // C-FIRE-3 atomic ✓
  // Wallet: "4/100 orders. ALL expire end of epoch 55."
};

// ══════════════════════════════════════════════════════════════
// TV-SCH-CATCHUP-LIMIT: MAX_FIRES_PER_TX_CATCHUP=8 enforced
// ══════════════════════════════════════════════════════════════
export const TV_SCH_CATCHUP_LIMIT = {
  id: "TV-SCH-CATCHUP-LIMIT", spec_ref: "App B §B.5, §5.7",
  description: "18 eligible orders → only 8 fire; 10 defer to next tx",
  start_fire_epoch: 52n,
  fired_count:       0n,
  schedule_length:  20n,
  current_epoch:    69n,      // e_0..e_17 all ≤ 69 (18 eligible)
  max_fires_cap:     8,
  fires_in_tx:       8,       // capped at MAX_FIRES_PER_TX_CATCHUP=8
  remaining_orders: 12,       // 20 - 8 = 12 defer (not forfeit — C-FIRE-1 ≥)
  // TV-SCH-06 note: remaining orders NOT forfeited; fire again next tx
};

// ══════════════════════════════════════════════════════════════
// TV-SCH-FIRE-PERM: Permissionless fire (C-SCH-FIRE-PERMISSION)
// ══════════════════════════════════════════════════════════════
export const TV_SCH_FIRE_PERM = {
  id: "TV-SCH-FIRE-PERM", spec_ref: "App B §B.19, C-SCH-FIRE-PERMISSION, A18",
  description: "Keeper Bob fires Alice's Schedule without Alice signature",
  alice_is_owner:    true,
  bob_fires:         true,
  alice_sig_in_tx:   false,   // NOT required (C-SCH-FIRE-PERMISSION) ✓
  bob_sig_in_tx:     false,   // Bob not required either — truly permissionless
  expected:          "ACCEPT",
  magic_to_alice:    true,    // MAGIC → Alice's vault ✓
  lamp_stays_in_vault: true,  // PHA 2 / I-ACT-7: LAMP does NOT move — the fire
                              // only RELEASES the lock. No Treasury leg exists.
  shard_correct:     true,    // C-SCH-FIRE-SHARD: shard = first_byte(blake2b256(inner_hash(alice.owner))) % 16 ✓
  // Rationale A18: Alice may lose key after commit → schedule stuck forever
  // Fire is fulfilling a pre-committed LAMP obligation, not a discretionary action
};

// ══════════════════════════════════════════════════════════════
// TV-SCH-SHARD-CRED: shard_id của chủ `Credential` (on-chain 856804fa)
// ══════════════════════════════════════════════════════════════
// Gương của `math.ak` ▸ `compute_shard_id`: băm 28 byte BÊN TRONG credential.
// On-chain ghim `compute_shard_id(VerificationKey(h)) == compute_shard_id(Script(h))
// == blake2b_256(h)[0] % 16` (`validators/vault.ak` ▸ test
// `owner_vk_shard_id_matches_raw_pkh_formula`). Byte đầu băm dưới đây tính ĐỘC LẬP bằng
// Python `hashlib.blake2b(digest_size=32)` ngày 2026-09-26, không bằng thư viện mã TS dùng.
export const TV_SCH_SHARD_CRED = [
  { inner: "00".repeat(28), first_byte: 93,  shard_id: 13 },
  { inner: "0a".repeat(28), first_byte: 106, shard_id: 10 },
  { inner: "ab".repeat(28), first_byte: 142, shard_id: 14 },
  { inner: "5c".repeat(28), first_byte: 233, shard_id: 9 },
] as const;

// ══════════════════════════════════════════════════════════════
// T-DET: All M_i in the same contract are identical
// ══════════════════════════════════════════════════════════════
export const TV_SCH_T_DET = {
  id: "TV-SCH-T-DET", spec_ref: "§11.4 T-DET",
  description: "Every fire in the same contract produces identical M_i",
  rate_locked_q: 11_250_000_000n,   // immutable
  lambda_oildrop:    4_000_000_000n,
  // M_i at fire #1   = ⌊4B × 11.25B / Q⌋ = 45B
  // M_i at fire #100 = ⌊4B × 11.25B / Q⌋ = 45B  ← IDENTICAL
  M_i_all_fires: 45_000_000_000n,
};

// ══════════════════════════════════════════════════════════════
// C-FIRE-3: Atomic fire assertion
// ══════════════════════════════════════════════════════════════
export const TV_SCH_FIRE3 = {
  id: "TV-SCH-FIRE3", spec_ref: "§11.10 C-FIRE-3",
  description: "All fire accounting must be atomic (all-or-nothing)",
  fires_in_tx:  4,
  lambda_oildrop:   4_000_000_000n,
  M_i:          45_000_000_000n,
  // Validator asserts ALL of these simultaneously (PHA 2 / I-ACT-7):
  assertions: {
    fired_count_delta:    4n,             // output.fired_count = input + 4
    lamp_balance_delta:   0n,             // LAMP DOES NOT MOVE
    lamp_locked_delta:  -16_000_000_000n, // -4 × λ released from the locked pool
    holdings_sum_delta:   0n,             // Σholdings invariant (only is_locked flips)
    new_batches_count:    4,              // exactly 4 new batches
    each_batch_initial:  45_000_000_000n, // all equal M_i (T-DET)
    each_batch_decay_window: 1n,          // §4.2 cliff — live this epoch only
  },
};

// ══════════════════════════════════════════════════════════════
// TV-SCH-ACT7: LAMP đứng yên across a fire (I-ACT-7)
// ══════════════════════════════════════════════════════════════
export const TV_SCH_ACT7 = {
  id: "TV-SCH-ACT7", spec_ref: "§6.1, §6.4, §12 I-ACT-7",
  description: "A fire releases the lock; it never transfers LAMP anywhere",
  before: {
    lamp_balance:     40_000_000_000n,
    lamp_locked:      40_000_000_000n,
    loyalty_holdings: [{ amount: 40_000_000_000n, acquired_epoch: 50n, is_locked: true }],
  },
  fires_in_tx: 1,
  lambda_oildrop:  4_000_000_000n,
  after: {
    lamp_balance:     40_000_000_000n,   // UNCHANGED
    lamp_locked:      36_000_000_000n,   // −λ
    loyalty_holdings: [
      { amount:  4_000_000_000n, acquired_epoch: 50n, is_locked: false },  // freed
      { amount: 36_000_000_000n, acquired_epoch: 50n, is_locked: true  },  // still locked
    ],
  },
  // A tx that sends LAMP out of the vault must be REJECTED.
  lamp_out_expected_validation: "REJECT",
};

// ══════════════════════════════════════════════════════════════
// TV-SCH-CLIFF: §4.2 per-epoch use-or-lose for Schedule batches
// ══════════════════════════════════════════════════════════════
export const TV_SCH_CLIFF = {
  id: "TV-SCH-CLIFF", spec_ref: "§4.2, §6.4",
  description:
    "A fired batch is live ONLY in the epoch it was fired. A catch-up of k " +
    "orders stamps all k batches with the CURRENT epoch, so it cannot " +
    "resurrect MAGIC missed in earlier epochs.",
  decay_window: 1n,
  cases: [
    { created_epoch: 60n, current_epoch: 60n, expired: false },
    { created_epoch: 60n, current_epoch: 61n, expired: true  },
    { created_epoch: 60n, current_epoch: 62n, expired: true  },
  ],
  // Burning a dead batch must be rejected on-chain.
  burn_dead_expected_validation: "REJECT",   // vault.ak test: bb_dead_batch_rejected
};

// ══════════════════════════════════════════════════════════════
// Boundary tests
// ══════════════════════════════════════════════════════════════
export const TV_SCH_BOUNDS = {
  id: "TV-SCH-BOUNDS", spec_ref: "§11.9 C-SCH-1/2/3/10",
  cases: [
    { L: 9n,   expected: "REJECT", reason: "C-SCH-1: L < 10" },
    { L: 10n,  expected: "ACCEPT", reason: "C-SCH-1: L = 10 (min) ✓" },
    { L: 200n, expected: "ACCEPT", reason: "C-SCH-1: L = 200 (max) ✓" },
    { L: 201n, expected: "REJECT", reason: "C-SCH-1: L > 200" },
    { schedules: 20, expected: "REJECT", reason: "C-SCH-10: |schedules| ≥ 20" },
    { schedules: 19, expected: "ACCEPT", reason: "C-SCH-10: |schedules| < 20 ✓" },
  ],
};

export const ALL_SCHEDULE_VECTORS = [
  TV_SCH_01, TV_SCH_02, TV_SCH_03, TV_SCH_04, TV_SCH_05,
  TV_SCH_06, TV_SCH_CATCHUP_LIMIT, TV_SCH_FIRE_PERM,
  TV_SCH_T_DET, TV_SCH_FIRE3, TV_SCH_BOUNDS,
  TV_SCH_ACT7, TV_SCH_CLIFF,
] as const;

// BẢN CHÉP CÓ NHÃN của khối TV-GEN-* trong InstantGen/tests/vectors.ts @ 1e9a72d9; bài so: ScheduleGen/tests/genFormulaMirror.test.ts (deep-equal hai bản).
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
