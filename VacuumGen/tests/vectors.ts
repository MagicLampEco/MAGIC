// tests/vectors.ts — VacuumGen Test Vectors (NORMATIVE — App B)
// Spec refs: §B.4 TV-VAC-01 | §B.16 TV-VAC-FULL | §B.13 TV-UM-SPLIT | §B.8 TV-LOCK-01

// ══════════════════════════════════════════════════════════════
// §B.4 TV-VAC-01: VacuumGen formula
// λ=10⁹ oildrop, UM=1.5, streak=8 → SM=1.10
// ══════════════════════════════════════════════════════════════
export const TV_VAC_01 = {
  id: "TV-VAC-01", spec_ref: "App B §B.4",
  description: "commit=100, λ=10⁹, UM=1.5, streak=8 → SM=1.10 → 825M nanogic",
  input: {
    lambda_oildropdrop : 1_000_000_000n,
    um_q       : 1_500_000_000n,   // 1.5
    streak     : 8n,
    sm_q       : 1_100_000_000n,   // streak 6-11 → 1.10
  },
  // step1 = 10⁹ × 500M / Q = 500_000_000
  // step2 = 500M × 1.5B / Q = 750_000_000
  // step3 = 750M × 1.1B / Q = 825_000_000
  steps: { s1: 500_000_000n, s2: 750_000_000n, s3: 825_000_000n },
  expected_nanogic: 825_000_000n,
};

// §20.3 calibration: λ=10⁹, UM=1.0, streak=0 → 0.5 MAGIC
export const TV_VAC_CALIB = {
  id: "TV-VAC-CALIB", spec_ref: "§20.3",
  input: { lambda_oildropdrop: 1_000_000_000n, um_q: 1_000_000_000n, streak: 0n, sm_q: 1_000_000_000n },
  expected_nanogic: 500_000_000n,   // 0.5 MAGIC ✓
};

// UM=2.0 (max), streak≥12 (SM=1.20)
export const TV_VAC_MAX = {
  id: "TV-VAC-MAX", spec_ref: "§10.1, §6.5",
  input: { lambda_oildropdrop: 1_000_000_000n, um_q: 2_000_000_000n, streak: 12n, sm_q: 1_200_000_000n },
  // s1=500M, s2=500M×2B/Q=1B, s3=1B×1.2B/Q=1_200_000_000
  expected_nanogic: 1_200_000_000n,
};

// ══════════════════════════════════════════════════════════════
// Streak Multiplier table (§6.5)
// ══════════════════════════════════════════════════════════════
export const TV_SM_TABLE = [
  { streak: 0n,  sm_q: 1_000_000_000n, label: "<3  → 1.00" },
  { streak: 2n,  sm_q: 1_000_000_000n, label: "<3  → 1.00" },
  { streak: 3n,  sm_q: 1_050_000_000n, label: "3-5 → 1.05" },
  { streak: 5n,  sm_q: 1_050_000_000n, label: "3-5 → 1.05" },
  { streak: 6n,  sm_q: 1_100_000_000n, label: "6-11→ 1.10" },
  { streak: 11n, sm_q: 1_100_000_000n, label: "6-11→ 1.10" },
  { streak: 12n, sm_q: 1_200_000_000n, label: "≥12 → 1.20" },
  { streak: 100n,sm_q: 1_200_000_000n, label: "≥12 → 1.20" },
];

// ══════════════════════════════════════════════════════════════
// C-UM-7: Vacuum always gets smoothed (TV-UM-SPLIT)
// ══════════════════════════════════════════════════════════════
export const TV_UM_SPLIT_VACUUM = {
  id: "TV-UM-SPLIT-VACUUM", spec_ref: "App B §B.13, C-UM-7",
  description: "Vacuum always uses smoothed=2B, regardless of staleness",
  um_datum: {
    smoothed_q:         2_000_000_000n,
    last_updated_epoch: 98n,
    history:            [] as bigint[],
  },
  current_epoch: 100n,
  staleness:     2n,         // > UM_MAX_STALENESS=1, but Vacuum ignores this
  expected_result: 2_000_000_000n,   // smoothed always ✓
};

// ══════════════════════════════════════════════════════════════
// §B.8 TV-LOCK-01: youngest-first lock selection (T5)
// ══════════════════════════════════════════════════════════════
export const TV_LOCK_01 = {
  id: "TV-LOCK-01", spec_ref: "App B §B.8",
  description: "Youngest-first lock: [{1000,50},{2000,80},{1500,60}], lock=2500",
  holdings: [
    { amount: 1_000n, acquired_epoch: 50n, is_locked: false },
    { amount: 2_000n, acquired_epoch: 80n, is_locked: false },
    { amount: 1_500n, acquired_epoch: 60n, is_locked: false },
  ],
  lock_amount: 2_500n,
  // Sorted youngest-first: [2000@80, 1500@60, 1000@50]
  // Lock 2000@80 (rem=500)
  // Lock 500@60 (split remaining 500 from 1500@60)
  // → locked: [{2000,80,L},{500,60,L}] + free: [{1000,60,F},{1000,50,F}]
  expected_locked: [
    { amount: 2_000n, acquired_epoch: 80n, is_locked: true  },
    { amount:   500n, acquired_epoch: 60n, is_locked: true  },
  ],
  expected_free: [
    { amount: 1_000n, acquired_epoch: 60n, is_locked: false },
    { amount: 1_000n, acquired_epoch: 50n, is_locked: false },
  ],
  // T5: free holdings are OLDEST → LF(free) is maximized ✓
  // LF(oldest free: age 60-50=10 → LF≈1.17) > LF(youngest: age 0 → 1.00)
};

// ══════════════════════════════════════════════════════════════
// §B.16 TV-VAC-FULL: vault full → M=0, LAMP still transfers (INV-43)
// ══════════════════════════════════════════════════════════════
export const TV_VAC_FULL = {
  id: "TV-VAC-FULL", spec_ref: "App B §B.16, INV-43, C-VAC-FIRE-FULL-VAULT",
  description: "32 active batches after prune → M=0; LAMP transfer still occurs",
  active_batch_count: 32,
  lambda_oildropdrop:         1_000_000_000n,
  fire_epoch:         102n,
  prune_count:        0,
  expected_magic:     0n,              // M=0 (vault full)
  expected_batch_created: false,
  lamp_transfer_occurs:   true,        // INV-43: ALWAYS ✓
  event_type: "VacuumFiredZeroMagic",
};

// ══════════════════════════════════════════════════════════════
// C-VAC-6: Exact epoch match (not ≥)
// ══════════════════════════════════════════════════════════════
export const TV_VAC_EPOCH = {
  id: "TV-VAC-EPOCH", spec_ref: "§10.2 C-VAC-6",
  description: "fire_epoch must match EXACTLY — not ≥ (unlike Schedule C-FIRE-1)",
  commit_epoch: 100n,
  fire_epoch:   102n,   // = commit + 2
  cases: [
    { current_epoch: 101n, expected: "REJECT" },   // too early
    { current_epoch: 102n, expected: "ACCEPT" },   // exact ✓
    { current_epoch: 103n, expected: "REJECT" },   // too late (order expired)
  ],
};

// ══════════════════════════════════════════════════════════════
// C-VAC-FIRE-PERMISSION: permissionless fire
// ══════════════════════════════════════════════════════════════
export const TV_VAC_PERM = {
  id: "TV-VAC-PERM", spec_ref: "§10.2 C-VAC-FIRE-PERMISSION",
  description: "Keeper Bob can fire Alice's Vacuum without Alice's signature",
  alice_is_owner:     true,
  bob_fires:          true,
  bob_sig_in_tx:      false,   // Bob not in extra_signatories
  alice_sig_in_tx:    false,   // Alice NOT required (C-VAC-FIRE-PERMISSION)
  expected:           "ACCEPT",
  magic_to_alice_vault: true,  // MAGIC → Alice's vault ✓
  lamp_to_treasury:     true,  // LAMP → Treasury ✓
  // Rationale: user may lose key after commit → LAMP would be stuck forever
  // if fire required signature. Fire is fulfilling a pre-committed obligation.
};

// ══════════════════════════════════════════════════════════════
// C-VAC-12: No cancel
// ══════════════════════════════════════════════════════════════
export const TV_VAC_NO_CANCEL = {
  id: "TV-VAC-NO-CANCEL", spec_ref: "§10.2 C-VAC-12",
  description: "No cancel redeemer exists — cannot retrieve LAMP after commit",
  cancel_exists: false,    // validator has no cancel redeemer ✓
  // Benefit: key compromise → attacker can only trigger burns, not steal LAMP
};

// ══════════════════════════════════════════════════════════════
// LAMP conservation (INV-43, C-VAC-7)
// ══════════════════════════════════════════════════════════════
export const TV_VAC_CONS = {
  id: "TV-VAC-CONS", spec_ref: "INV-43, C-VAC-7, §13.2",
  description: "LAMP always transfers at fire, even when M=0",
  cases: [
    { m_v: 825_000_000n, lamp_transfer: true,  note: "normal fire" },
    { m_v: 0n,           lamp_transfer: true,  note: "vault full — INV-43 ✓" },
  ],
};

// ══════════════════════════════════════════════════════════════
// Boundary tests
// ══════════════════════════════════════════════════════════════
export const TV_VAC_BOUNDS = {
  id: "TV-VAC-BOUNDS", spec_ref: "§9.3 C-VAC-2/3/5",
  cases: [
    { lambda:       999_999n, expected: "REJECT", reason: "C-VAC-3: < 1 LAMP" },
    { lambda:     1_000_000n, expected: "ACCEPT", reason: "C-VAC-3: = 1 LAMP ✓" },
    { orders_count: 10,       expected: "REJECT", reason: "C-VAC-5: ≥ MAX_ORDERS=10" },
    { orders_count: 9,        expected: "ACCEPT", reason: "C-VAC-5: < MAX_ORDERS ✓" },
  ],
};

export const ALL_VACUUM_VECTORS = [
  TV_VAC_01, TV_VAC_CALIB, TV_VAC_MAX,
  TV_SM_TABLE,
  TV_UM_SPLIT_VACUUM,
  TV_LOCK_01,
  TV_VAC_FULL,
  TV_VAC_EPOCH,
  TV_VAC_PERM,
  TV_VAC_NO_CANCEL,
  TV_VAC_CONS,
  TV_VAC_BOUNDS,
] as const;
