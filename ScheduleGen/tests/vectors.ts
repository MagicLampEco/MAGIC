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
  shard_correct:     true,    // C-SCH-FIRE-SHARD: shard = first_byte(blake2b256(alice_pkh)) % 16 ✓
  // Rationale A18: Alice may lose key after commit → schedule stuck forever
  // Fire is fulfilling a pre-committed LAMP obligation, not a discretionary action
};

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
