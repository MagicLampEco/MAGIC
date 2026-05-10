// tests/vectors.ts — InstantGen Test Vectors (NORMATIVE — App B §B.3, §B.9, §B.11, §B.13, §B.14, §B.17)
// Implementation MUST produce bit-identical output for ALL vectors below.
// deploy checklist §E.3: TV-INST-01..03, TV-UM-SPLIT, TV-OVERFLOW-01..02, TV-HALVED-INJECT

export interface Vector {
  id         : string;
  spec_ref   : string;
  description: string;
}

// ── TV-INST-01: Instant lifecycle, no burn ───────────────────
// m₀ = 10^9 nanogic, decay_window = 2
export const TV_INST_01 = {
  id:          "TV-INST-01",
  spec_ref:    "App B §B.3",
  description: "Instant batch lifecycle, no burn (m₀=10⁹)",
  input: {
    initial_amount : 1_000_000_000n,
    current_amount : 1_000_000_000n,
    decay_window   : 2n,
    halved         : false,
    created_epoch  : 100n,
  },
  cases: [
    { current_epoch: 100n, k: 0n, expected_balance: 1_000_000_000n, halved: false },
    { current_epoch: 101n, k: 1n, expected_balance: 500_000_000n,   halved: true  }, // halved
    { current_epoch: 102n, k: 2n, expected_balance: 0n,             halved: true  }, // expired
  ],
};

// ── TV-INST-02: Burn at k=0, then halving at k=1 ─────────────
export const TV_INST_02 = {
  id:          "TV-INST-02",
  spec_ref:    "App B §B.3",
  description: "Burn 300M at k=0, halving at k=1",
  burn_at_k0: {
    initial_amount_before_burn : 1_000_000_000n,
    burn_amount                : 300_000_000n,
    expected_current_after_burn: 700_000_000n,
    halved_after_burn          : false,    // C-DECAY-8: burn does NOT change halved
  },
  halving_at_k1: {
    current_before_halving : 700_000_000n,
    expected_after_halving : 350_000_000n, // ⌊700M / 2⌋
    expected_halved        : true,
  },
  expired_at_k2: 0n,
};

// ── TV-INST-03: Double-halving prevention (T18) ──────────────
// eUTxO prevents intra-block; halved field prevents inter-block.
export const TV_INST_03 = {
  id:          "TV-INST-03",
  spec_ref:    "App B §B.3, C.9",
  description: "T18: halved=True prevents second halving in same epoch",
  batch_before_block_B1: {
    current_amount : 1_000_000_000n,
    halved         : false,
    created_epoch  : 100n,
  },
  // Block B₁: Tx₁ at epoch 101 → halve
  tx1_result: {
    current_amount : 500_000_000n,
    halved         : true,
  },
  // Block B₂: Tx₂ at epoch 101 → should_halve = False (halved already True)
  tx2_should_halve: false,
  tx2_result: {
    current_amount : 500_000_000n,  // UNCHANGED ✓ (not halved again)
    halved         : true,
  },
};

// ── TV-INST-GEN-01: Compute M for 1000 LAMP, Flame, UM=1.0 ──
// From §20.3 calibration: "Instant 1000 LAMP, Flame, UM=1.0 → ≈3.15 MAGIC"
export const TV_INST_GEN_01 = {
  id:          "TV-INST-GEN-01",
  spec_ref:    "§9.1, §20.3",
  description: "InstantGen 1000 LAMP, Flame, UM=1.0 → 3.15 MAGIC",
  input: {
    lamp_paid_oil: 1_000_000_000n,         // 1000 × 10^6 oil
    um_q:          1_000_000_000n,         // UM = 1.0
    pm_q:          1_050_000_000n,         // Flame PM = 1.05
  },
  expected_nanogic: 3_150_000_000n,        // 3.15 MAGIC
  // Step-by-step:
  // s1 = 10^9 × 3_000_000_000 / Q = 3_000_000_000
  // s2 = 3_000_000_000 × 10^9 / Q = 3_000_000_000  (UM=1.0)
  // s3 = 3_000_000_000 × 1_050_000_000 / Q = 3_150_000_000
  steps: {
    s1: 3_000_000_000n,
    s2: 3_000_000_000n,
    s3: 3_150_000_000n,
  },
};

// ── TV-INST-GEN-02: Ember profile ────────────────────────────
export const TV_INST_GEN_02 = {
  id:          "TV-INST-GEN-02",
  spec_ref:    "§9.1",
  description: "InstantGen 1000 LAMP, Ember, UM=1.5",
  input: {
    lamp_paid_oil: 1_000_000_000n,
    um_q:          1_500_000_000n,         // UM = 1.5
    pm_q:          1_150_000_000n,         // Ember PM = 1.15
  },
  // s1 = 3_000_000_000
  // s2 = 3_000_000_000 × 1_500_000_000 / Q = 4_500_000_000
  // s3 = 4_500_000_000 × 1_150_000_000 / Q = 5_175_000_000
  expected_nanogic: 5_175_000_000n,        // 5.175 MAGIC
};

// ── TV-INST-GEN-03: UM=2.0 (maximum), Lantern ───────────────
export const TV_INST_GEN_03 = {
  id:          "TV-INST-GEN-03",
  spec_ref:    "§9.1, §14.1 UM_MAX",
  description: "InstantGen 500 LAMP, Lantern, UM=2.0 (max)",
  input: {
    lamp_paid_oil: 500_000_000n,           // 500 LAMP
    um_q:          2_000_000_000n,         // UM_MAX
    pm_q:          1_000_000_000n,         // Lantern PM = 1.0
  },
  // s1 = 500M × 3B / Q = 1_500_000_000
  // s2 = 1.5B × 2B / Q = 3_000_000_000
  // s3 = 3B × 1B / Q   = 3_000_000_000
  expected_nanogic: 3_000_000_000n,        // 3.0 MAGIC
};

// ── TV-UM-SPLIT: Instant vs Vacuum stale behavior ────────────
export const TV_UM_SPLIT = {
  id:          "TV-UM-SPLIT",
  spec_ref:    "App B §B.13, §14.4 C-UM-6/7",
  description: "Instant gets fallback when stale; Vacuum always gets smoothed",
  um_datum: {
    smoothed_q:         2_000_000_000n,    // 2.0
    last_updated_epoch: 98n,
    history:            [],
  },
  current_epoch: 100n,
  // staleness = 100 - 98 = 2 > UM_MAX_STALENESS=1
  staleness: 2n,
  instant_result: 500_000_000n,   // UM_FALLBACK_Q = UM_MIN_Q ✓
  vacuum_result:  2_000_000_000n, // always smoothed (C-UM-7) ✓
};

// ── TV-UM-FRESH: UM fresh (staleness = 0) ────────────────────
export const TV_UM_FRESH = {
  id:          "TV-UM-FRESH",
  spec_ref:    "§14.4 C-UM-6",
  description: "UM fresh — use smoothed",
  um_datum: {
    smoothed_q:         1_500_000_000n,    // 1.5
    last_updated_epoch: 99n,
    history:            [],
  },
  current_epoch: 100n,
  staleness:     1n,               // ≤ UM_MAX_STALENESS=1 → use smoothed
  instant_result: 1_500_000_000n,  // smoothed ✓
};

// ── TV-OVERFLOW-01: BigInt mandatory ─────────────────────────
export const TV_OVERFLOW_01 = {
  id:          "TV-OVERFLOW-01",
  spec_ref:    "App B §B.14, §2.1",
  description: "JavaScript Number overflows on large L; BigInt required",
  // Number.MAX_SAFE_INTEGER = 2^53 - 1 ≈ 9 × 10^15
  // L = 36 × 10^15 oil (entire LAMP supply)
  L_oil:          36_000_000_000_000_000n,
  instant_rate_q: 3_000_000_000n,
  // step1 = L × R_inst = 36×10^15 × 3×10^9 = 1.08×10^26
  // Number would: 1.08e26 — but JS Number loses precision here
  // BigInt correctly: 108_000_000_000_000_000_000_000_000n
  intermediate_step1_bigint: 108_000_000_000_000_000_000_000_000n,
  // After /Q: 108_000_000_000_000_000n
  step1_after_div: 108_000_000_000_000_000n,
  use_bigint: true,  // MANDATORY (C-OVERFLOW)
};

// ── TV-OVERFLOW-02: Schedule intermediate ────────────────────
export const TV_OVERFLOW_02 = {
  id:          "TV-OVERFLOW-02",
  spec_ref:    "App B §B.14",
  description: "Schedule S_Q intermediate overflows Number",
  // S_Q(200) = 2_625_000_000
  // SNAPSHOT_BASE_RATE_Q = 5_000_000_000
  // Intermediate: 5×10^9 × 2.625×10^9 = 1.3125×10^19 > Number.MAX_SAFE_INTEGER
  intermediate: 13_125_000_000_000_000_000n,
  use_bigint: true,
};

// ── TV-HALVED-INJECT: C-DECAY-8 attack prevention ────────────
export const TV_HALVED_INJECT = {
  id:          "TV-HALVED-INJECT",
  spec_ref:    "App B §B.17, §4.6 C-DECAY-8, T22",
  description: "Attacker sets halved=True at k=0 → REJECT",
  input_batch: {
    source:        "Instant",
    created_epoch: 100n,
    current_epoch: 100n,       // k=0
    current_amount: 1_000_000_000n,
    halved:        false,
  },
  attacker_output_batch: {
    current_amount: 900_000_000n,   // burned 100M
    halved:        true,            // ← INJECTED (k=0, not halving epoch)
  },
  // C-DECAY-8: k=0 ≠ 1, so this is NOT a halving operation.
  // output.halved MUST equal input.halved = false.
  // Validator MUST REJECT this output.
  expected_validation: "REJECT",
  // After legit burn at k=0:
  legit_output_batch: {
    current_amount: 900_000_000n,
    halved:        false,           // ✓ unchanged
  },
  // Then at k=1 (epoch 101):
  legit_halving_result: {
    current_amount: 450_000_000n,  // ⌊900M / 2⌋
    halved:        true,
  },
};

// ── TV-CONS-01: LAMP conservation ────────────────────────────
export const TV_CONS_01 = {
  id:          "TV-CONS-01",
  spec_ref:    "App B §B.11, §13.1 T14",
  description: "InstantGen: lamp_paid moves vault→Treasury; total unchanged",
  before: {
    vault_lamp_balance : 100_000_000_000n,  // 10^11 oil (100,000 LAMP)
    treasury_lamp      : 0n,
    total              : 100_000_000_000n,
  },
  lamp_paid: 1_000_000_000n,                // 10^9 oil (1,000 LAMP)
  after: {
    vault_lamp_balance : 99_000_000_000n,   // 10^11 - 10^9
    treasury_lamp      : 1_000_000_000n,    // += lamp_paid
    total              : 100_000_000_000n,  // unchanged ✓ (T14, C-INST-10)
  },
};

// ── TV-INST-MIN: Boundary — minimum purchase ─────────────────
export const TV_INST_MIN = {
  id:          "TV-INST-MIN",
  spec_ref:    "§9.3 C-INST-1",
  description: "Minimum purchase boundary: 10 LAMP = 10^7 oil",
  min_oil: 10_000_000n,
  cases: [
    { lamp_paid: 9_999_999n,  expected: "REJECT" },  // < MIN
    { lamp_paid: 10_000_000n, expected: "ACCEPT" },  // = MIN ✓
    { lamp_paid: 10_000_001n, expected: "ACCEPT" },  // > MIN ✓
  ],
};

// ── TV-INST-MAX: Boundary — maximum purchase ─────────────────
export const TV_INST_MAX = {
  id:          "TV-INST-MAX",
  spec_ref:    "§9.3 C-INST-2",
  description: "Maximum purchase boundary: 10^13 oil",
  max_oil: 10_000_000_000_000n,
  cases: [
    { lamp_paid: 10_000_000_000_000n, expected: "ACCEPT" },   // = MAX ✓
    { lamp_paid: 10_000_000_000_001n, expected: "REJECT" },   // > MAX
  ],
};

// ── TV-INST-AVAIL: C-INST-3 L_avail check ────────────────────
export const TV_INST_AVAIL = {
  id:          "TV-INST-AVAIL",
  spec_ref:    "§9.3 C-INST-3",
  description: "lamp_paid ≤ L_avail; locked LAMP cannot be spent",
  vault: {
    lamp_balance: 100_000_000_000n,   // 100,000 LAMP
    lamp_locked:  60_000_000_000n,    // 60,000 LAMP locked
    l_avail:      40_000_000_000n,    // only 40,000 available
  },
  cases: [
    { lamp_paid: 40_000_000_000n, expected: "ACCEPT" },  // = L_avail ✓
    { lamp_paid: 40_000_000_001n, expected: "REJECT" },  // > L_avail (uses locked LAMP)
  ],
};

// ── TV-INST-VAULT-FULL: C-INST-7 batch count ─────────────────
export const TV_INST_VAULT_FULL = {
  id:          "TV-INST-VAULT-FULL",
  spec_ref:    "§9.3 C-INST-7",
  description: "Cannot add batch when |batches| = 32",
  active_batch_count: 32,
  expected: "REJECT",   // GEN-VAULT-001: burn batches first
};

// ── TV-MULTI-01 (Instant component) ──────────────────────────
// From App B §B.9: epoch 103, Snapshot Lantern + Instant at k=1
export const TV_MULTI_01_INSTANT_COMPONENT = {
  id:          "TV-MULTI-01-INSTANT",
  spec_ref:    "App B §B.9",
  description: "Multi-source balance: Instant at k=1 (halved from 2B)",
  instant_batch: {
    initial_amount : 2_000_000_000n,
    current_amount : 2_000_000_000n,
    created_epoch  : 102n,
    decay_window   : 2n,
    halved         : false,
  },
  current_epoch: 103n,
  // k=1, halved=False → apply halving: ⌊2B/2⌋ = 1B
  expected_balance_after_halving: 1_000_000_000n,
  // Total with Snapshot: 729M + 1B = 1_729_000_000 ✓
};

// ── Export all vectors ────────────────────────────────────────
export const ALL_VECTORS = [
  TV_INST_01,
  TV_INST_02,
  TV_INST_03,
  TV_INST_GEN_01,
  TV_INST_GEN_02,
  TV_INST_GEN_03,
  TV_UM_SPLIT,
  TV_UM_FRESH,
  TV_OVERFLOW_01,
  TV_OVERFLOW_02,
  TV_HALVED_INJECT,
  TV_CONS_01,
  TV_INST_MIN,
  TV_INST_MAX,
  TV_INST_AVAIL,
  TV_INST_VAULT_FULL,
  TV_MULTI_01_INSTANT_COMPONENT,
] as const;
