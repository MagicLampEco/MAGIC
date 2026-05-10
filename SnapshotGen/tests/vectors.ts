// tests/vectors.ts — SnapshotGen Test Vectors (NORMATIVE — App B)
// Spec refs: §B.1 TV-SS-01..04 | §B.6 TV-LF-01..03 | §B.7 TV-SNAPGEN-01
//            §B.10 TV-CATCHUP-01 | §B.12 TV-SAMENESS-01 | §B.18 TV-OAC-BOUNDARY

// ══════════════════════════════════════════════════════════════
// §B.1 TV-SS-01: Lantern full lifetime (m₀ = 10⁹ nanogic)
// r=1, N=9, decay = ×0.90/epoch
// ══════════════════════════════════════════════════════════════
export const TV_SS_01 = {
  id: "TV-SS-01", spec_ref: "App B §B.1", profile: "Lantern",
  m0: 1_000_000_000n,
  expected: [
    { k: 0n, balance: 1_000_000_000n },
    { k: 1n, balance:   900_000_000n },
    { k: 2n, balance:   810_000_000n },
    { k: 3n, balance:   729_000_000n },
    { k: 4n, balance:   656_100_000n },
    { k: 5n, balance:   590_490_000n },
    { k: 6n, balance:   531_441_000n },
    { k: 7n, balance:   478_296_900n },
    { k: 8n, balance:   430_467_210n },
    { k: 9n, balance:             0n }, // hard cutoff k≥N=9 (T2)
  ],
};

// TV-SS-02: Flame (m₀ = 10⁹)  r=2, N=6, decay ×0.80/epoch
export const TV_SS_02 = {
  id: "TV-SS-02", spec_ref: "App B §B.1", profile: "Flame",
  m0: 1_000_000_000n,
  expected: [
    { k: 0n, balance: 1_000_000_000n },
    { k: 1n, balance:   800_000_000n },
    { k: 2n, balance:   640_000_000n },
    { k: 3n, balance:   512_000_000n },
    { k: 4n, balance:   409_600_000n },
    { k: 5n, balance:   327_680_000n },
    { k: 6n, balance:             0n }, // hard cutoff k≥N=6 (T2)
  ],
};

// TV-SS-03: Ember (m₀ = 10⁹)  r=3, N=3, decay ×0.70/epoch
export const TV_SS_03 = {
  id: "TV-SS-03", spec_ref: "App B §B.1", profile: "Ember",
  m0: 1_000_000_000n,
  expected: [
    { k: 0n, balance: 1_000_000_000n },
    { k: 1n, balance:   700_000_000n },
    { k: 2n, balance:   490_000_000n },
    { k: 3n, balance:             0n }, // hard cutoff k≥N=3 (T2)
  ],
};

// ══════════════════════════════════════════════════════════════
// §B.2 TV-SS-04: Scale-back burn (T17)
// Lantern k=3, m₀=10⁹, burn=200M
// ══════════════════════════════════════════════════════════════
export const TV_SS_04 = {
  id: "TV-SS-04", spec_ref: "App B §B.2", profile: "Lantern",
  m0: 1_000_000_000n,
  k: 3n,
  burn: 200_000_000n,
  // current = ⌊10⁹ × 9³/10³⌋ = ⌊10⁹ × 729/1000⌋ = 729_000_000
  current_before_burn: 729_000_000n,
  // isb = ⌊200M × 10³/9³⌋ = ⌊200M × 1000/729⌋ = 274_348_422
  // Verify: 274_348_422 × 729 = 199_999_999_638; remainder=362 < 729 ✓
  expected_isb: 274_348_422n,
  expected_new_initial: 725_651_578n,   // 10⁹ - 274_348_422
  // new_balance = ⌊725_651_578 × 729/1000⌋ = 529_000_000
  expected_new_balance: 529_000_000n,
  // diff = 729M - 200M - 529M = 0 ✓ (T17: user-favorable, diff ≤ 1)
  expected_diff: 0n,
};

// ══════════════════════════════════════════════════════════════
// §B.6 TV-LF-01..03: Loyalty Factor
// ══════════════════════════════════════════════════════════════
export const TV_LF_01 = {
  id: "TV-LF-01", spec_ref: "App B §B.6",
  age: 0n, expected_lf_q: 1_000_000_000n,   // 1.00
};
export const TV_LF_02 = {
  id: "TV-LF-02", spec_ref: "App B §B.6",
  age: 24n, expected_lf_q: 1_500_000_000n,  // 1.50 (cap)
};
export const TV_LF_03 = {
  id: "TV-LF-03", spec_ref: "App B §B.6",
  description: "Weighted average: [{10⁹, acq=50}, {10⁹, acq=68}], e=74",
  holdings: [
    { amount: 1_000_000_000n, acquired_epoch: 50n, is_locked: false },
    { amount: 1_000_000_000n, acquired_epoch: 68n, is_locked: false },
  ],
  current_epoch: 74n,
  // age1 = 74-50 = 24 → LF1 = 1.50 → lf_q1 = 1_500_000_000
  // age2 = 74-68 =  6 → LF2 = 1.10 → lf_q2 = 1_100_000_000
  // weighted = (10⁹×1.5B + 10⁹×1.1B) / (2×10⁹) = (1.5B+1.1B)/2 = 1.3B
  expected_lf_q: 1_300_000_000n,
};

// LF boundary checks
export const TV_LF_BOUNDARIES = [
  { age: 0n,  expected: 1_000_000_000n },   // 1.00
  { age: 6n,  expected: 1_100_000_000n },   // 1.10
  { age: 12n, expected: 1_200_000_000n },   // 1.20
  { age: 24n, expected: 1_500_000_000n },   // 1.50 cap
  { age: 25n, expected: 1_500_000_000n },   // still 1.50
  { age: 100n,expected: 1_500_000_000n },   // still 1.50
];

// ══════════════════════════════════════════════════════════════
// §B.7 TV-SNAPGEN-01: generation formula
// ══════════════════════════════════════════════════════════════
export const TV_SNAPGEN_01 = {
  id: "TV-SNAPGEN-01", spec_ref: "App B §B.7",
  description: "1000 LAMP, Flame, LF=1.0, OAC=0.8, PM=1.05, B=1.1 → ≈4.62 MAGIC",
  lamp_oil: 1_000_000_000n,   // 1000 × 10^6 oil
  lf_q:     1_000_000_000n,   // 1.00
  oac_q:      800_000_000n,   // 0.80
  profile: "Flame",
  // s1 = 10^9 × 5B / Q = 5_000_000_000
  // s2 = 5B × 1.0B / Q = 5_000_000_000   (LF=1.0)
  // s3 = 5B × 0.8B / Q = 4_000_000_000   (OAC=0.8)
  // s4 = 4B × 1.05B / Q = 4_200_000_000  (PM=1.05)
  // s5 = 4.2B × 1.1B / Q = 4_620_000_000 (B=1.10)
  steps: {
    s1: 5_000_000_000n,
    s2: 5_000_000_000n,
    s3: 4_000_000_000n,
    s4: 4_200_000_000n,
    s5: 4_620_000_000n,
  },
  expected_nanogic: 4_620_000_000n,
};

// Mature user: Ember, LF=1.5, OAC=1.0 → 11.21 MAGIC (§20.3 calibration)
export const TV_SNAPGEN_MATURE = {
  id: "TV-SNAPGEN-MATURE", spec_ref: "§20.3",
  description: "1000 LAMP, Ember, LF=1.5, OAC=1.0 → ≈11.21 MAGIC",
  lamp_oil: 1_000_000_000n,
  lf_q:     1_500_000_000n,   // 1.50
  oac_q:    1_000_000_000n,   // 1.00
  profile: "Ember",
  // s1 = 5B
  // s2 = 5B × 1.5B / Q = 7_500_000_000
  // s3 = 7.5B × 1.0B / Q = 7_500_000_000
  // s4 = 7.5B × 1.15B / Q = 8_625_000_000
  // s5 = 8.625B × 1.3B / Q = 11_212_500_000
  expected_nanogic: 11_212_500_000n,
};

// ══════════════════════════════════════════════════════════════
// §B.10 TV-CATCHUP-01
// ══════════════════════════════════════════════════════════════
export const TV_CATCHUP_01 = {
  id: "TV-CATCHUP-01", spec_ref: "App B §B.10",
  description: "1000 LAMP, Flame, LF=1.1, OAC=0.9, Δe=5 → 28.586 MAGIC total",
  lamp_oil:    1_000_000_000n,
  lf_q:        1_100_000_000n,
  oac_q:         900_000_000n,
  profile:     "Flame",
  delta_epochs: 5n,
  // M_one = ((((10^9 × 5B/Q) × 1.1B/Q) × 0.9B/Q) × 1.05B/Q) × 1.1B/Q
  // = (((5B × 1.1B/Q) × 0.9B/Q) × 1.05B/Q) × 1.1B/Q
  // = ((5.5B × 0.9B/Q) × 1.05B/Q) × 1.1B/Q
  // = (4.95B × 1.05B/Q) × 1.1B/Q
  // = 5.1975B × 1.1B/Q
  // = 5_717_250_000
  m_per_epoch:  5_717_250_000n,
  // M_total = 5 × 5_717_250_000 = 28_586_250_000
  expected_total: 28_586_250_000n,
};

// ══════════════════════════════════════════════════════════════
// §B.12 TV-SAMENESS-01: profile change doesn't affect existing batch (T4)
// ══════════════════════════════════════════════════════════════
export const TV_SAMENESS_01 = {
  id: "TV-SAMENESS-01", spec_ref: "App B §B.12",
  description: "Batch created Flame, profile→Ember at ep100 (effective ep101). At ep101: batch still Flame N=6, k=6≥N → expired ✓",
  batch: {
    source:              "Snapshot" as const,
    profile_at_creation: "Flame",    // N=6 ← LOCKED at creation (T4)
    created_epoch:       95n,
    decay_window:        6n,         // N(Flame) = 6
  },
  // Profile changed to Ember at ep100, effective ep101
  profile_change_epoch:     100n,
  new_profile:              "Ember",
  effective_epoch:          101n,
  check_at_epoch:           101n,
  // k = 101 - 95 = 6 ≥ decay_window=6 → expired ✓
  // Profile change to Ember (N=3) does NOT change this batch's decay_window
  k_at_check:               6n,
  expected_expired:         true,
  // If wrongly applied Ember N=3: would have expired at k=3 (epoch 98) — earlier
  // T4: profile_at_creation is immutable; batch uses Flame profile throughout
};

// ══════════════════════════════════════════════════════════════
// §B.18 TV-OAC-BOUNDARY
// ══════════════════════════════════════════════════════════════
export const TV_OAC_BOUNDARY = {
  id: "TV-OAC-BOUNDARY", spec_ref: "App B §B.18",
  description: "Burn at epoch 103 NOT counted in OAC at epoch 103; counts for ep104",
  current_epoch: 103n,
  activity_state: {
    recent_burn_epochs: [
      ["app1", 87n] as [string, bigint],   // 103-87=16 > 12 → outside window → prune
      ["app2", 88n] as [string, bigint],   // 103-88=15 > 12 → boundary check
      ["app3", 91n] as [string, bigint],   // 103-91=12, ep=91 ≥ 91 (window_start=91) → in window
      ["app4", 100n] as [string, bigint],  // ep=100, 91≤100<103 → in window
      ["app5", 103n] as [string, bigint],  // ep=103 ≥ 103 (current) → NOT in [91,103) → excluded
    ],
    total_burns_count: 0n,
  },
  // window = [103-12, 103) = [91, 103)
  // app1: ep=87 < 91 → outside → prune candidate
  // app2: ep=88 < 91 → outside → prune candidate
  // app3: ep=91 ∈ [91,103) → counted
  // app4: ep=100 ∈ [91,103) → counted
  // app5: ep=103 ≥ 103 (current) → NOT counted for current OAC
  expected_active_apps: 2,                  // app3 + app4
  expected_oac_q:       900_000_000n,       // 0.80 + 0.05×2 = 0.90 ✓
};

// ══════════════════════════════════════════════════════════════
// §B.11 TV-CONS-SNAPSHOT: No LAMP movement (T16)
// ══════════════════════════════════════════════════════════════
export const TV_CONS_SNAPSHOT = {
  id: "TV-CONS-SNAPSHOT", spec_ref: "§13.1, T16",
  description: "SnapshotGen: lamp_balance unchanged before and after",
  lamp_balance_before: 100_000_000_000n,
  lamp_balance_after:  100_000_000_000n,   // UNCHANGED ✓
  treasury_before:     0n,
  treasury_after:      0n,                  // UNCHANGED ✓ (no LAMP cost)
};

// ══════════════════════════════════════════════════════════════
// C-SS-8: Vault full → SKIP
// ══════════════════════════════════════════════════════════════
export const TV_SS_SKIP = {
  id: "TV-SS-SKIP", spec_ref: "§8.3 C-SS-8",
  description: "Vault has 32 batches → SKIP; last_updated_epoch still updates; generation LOST",
  active_batch_count:       32,
  expected_batch_added:     false,
  expected_epoch_updated:   true,     // last_updated_epoch still changes ✓
  generation_recoverable:   false,    // LOST PERMANENTLY — cannot backfill
};

export const ALL_SNAPSHOT_VECTORS = [
  TV_SS_01, TV_SS_02, TV_SS_03, TV_SS_04,
  TV_LF_01, TV_LF_02, TV_LF_03,
  TV_SNAPGEN_01, TV_SNAPGEN_MATURE,
  TV_CATCHUP_01,
  TV_SAMENESS_01,
  TV_OAC_BOUNDARY,
  TV_CONS_SNAPSHOT,
  TV_SS_SKIP,
] as const;
