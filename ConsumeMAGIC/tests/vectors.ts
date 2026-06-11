// tests/vectors.ts — ConsumeMAGIC v2.2 Normative Test Vectors (Appendix B)
// Implementation correct ⟺ passes ALL vectors

import type { MagicBatch, AppAllocation, DelegationCertificate, ActivityState, AppRegistry } from "../offchain/src/_appeconomics_legacy.js";

// ── Helpers ──────────────────────────────────────────────────
const Q = 1_000_000_000n;
const MAGIC = Q;  // 1 MAGIC = 10^9 nanogic

export function batch(
  id: string, source: "Snapshot"|"Instant"|"Vacuum"|"Schedule",
  created: bigint, amount: bigint, decay: bigint,
  profile: "Ember"|"Flame"|"Lantern"|null = null,
  halved = false,
): MagicBatch {
  return { batch_id: id, source, created_epoch: created, initial_amount: amount,
           current_amount: amount, decay_window: decay, profile_at_creation: profile, halved };
}

export function cert(current: AppAllocation[], effectiveEpoch = 100n): DelegationCertificate {
  return { current, current_effective_epoch: effectiveEpoch, pending: null, last_changed_epoch: 0n };
}

export function activeRegistry(...ids: string[]): AppRegistry {
  return Object.fromEntries(ids.map((id, i) => [id, { status: "Active" as const, topo_level: (i+1)*10 }]));
}

// ══════════════════════════════════════════════════════════════
// B.1 Lazy Halving (TV-HALVE-*)
// ══════════════════════════════════════════════════════════════

export const TV_HALVE_001 = {
  id: "TV-HALVE-001", spec_ref: "Appendix B.1",
  description: "Instant k=1, halved=False → halve BEFORE burn validation",
  input: batch("B1", "Instant", 102n, 1_000_000_000n, 3n),
  epoch: 103n,  // k=1
  expected_after_halving: { current_amount: 500_000_000n, halved: true },
  burn_attempt_A: { amount: 700_000_000n, expect: "REJECT" },  // > 500M post-halving
  burn_attempt_B: { amount: 300_000_000n, expect: "ACCEPT",   remaining: 200_000_000n },
};

export const TV_HALVE_002 = {
  id: "TV-HALVE-002", spec_ref: "Appendix B.1",
  description: "Already halved=True at k=1 → no second halving (idempotent)",
  input: { ...batch("B1", "Instant", 102n, 500_000_000n, 3n), halved: true },
  epoch: 103n,
  expected_after_halving: { current_amount: 500_000_000n, halved: true },  // unchanged
};

export const TV_HALVE_003 = {
  id: "TV-HALVE-003", spec_ref: "Appendix B.1",
  description: "k=0 → no halving",
  input: batch("B1", "Instant", 103n, 1_000_000_000n, 3n),
  epoch: 103n,  // k=0
  expected_after_halving: { current_amount: 1_000_000_000n, halved: false },  // unchanged
};

// ══════════════════════════════════════════════════════════════
// B.2 Fee Computation (TV-FEE-*)
// ══════════════════════════════════════════════════════════════

export const TV_FEE_001 = {
  id: "TV-FEE-001", spec_ref: "Appendix B.2",
  description: "Normal fee: 100 MAGIC × 1% = 1 MAGIC fee",
  fee_bps: 100n, service_amount: 100n * MAGIC,
  expected_fee: 1n * MAGIC,
  expected_total_deducted: 101n * MAGIC,
};

export const TV_FEE_002 = {
  id: "TV-FEE-002", spec_ref: "Appendix B.2",
  description: "Rounding: 999 nanogic, fee=⌊9.99⌋=9 (no ±1 ambiguity with explicit service_amount)",
  fee_bps: 100n, service_amount: 999n,
  expected_fee: 9n,
  expected_total_deducted: 1008n,  // 999 + 9
};

export const TV_FEE_003 = {
  id: "TV-FEE-003", spec_ref: "Appendix B.2",
  description: "Below MIN_SERVICE_AMOUNT → C-APP-V6 REJECT",
  fee_bps: 100n,
  min_service_amount: 100n,  // ceiling(10000/100) = 100
  service_amount: 50n,
  expect: "REJECT",
};

export const TV_FEE_004 = {
  id: "TV-FEE-004", spec_ref: "Appendix B.2 (T14.16b)",
  description: "FEE_BPS=0: fee=0 always (policy), OAC triggered simultaneously — T14.16 NOT applicable",
  fee_bps: 0n,
  min_service_amount: 1n,  // special case when FEE_BPS=0
  service_amount: 1n * MAGIC,
  expected_fee: 0n,
  oac_triggered: true,  // amount ≥ MIN_BURN_FOR_OAC_COUNT = 10^9
  note: "T14.16b: fee=0 AND OAC=True simultaneously valid (scope of T14.16 is FEE_BPS>0)",
};

export const TV_FEE_005 = {
  id: "TV-FEE-005", spec_ref: "Appendix B.2",
  description: "FEE_BPS=0, zero service → C-APP-V6 REJECT",
  fee_bps: 0n, service_amount: 0n, expect: "REJECT",
};

// ══════════════════════════════════════════════════════════════
// B.3 Self-Capacity Active-Only (TV-SC-*)
// ══════════════════════════════════════════════════════════════

export const TV_SC_001 = {
  id: "TV-SC-001", spec_ref: "Appendix B.3 [UPDATED FIX-N2]",
  description: "Suspended app EXCLUDED from active delegation → self_capacity larger",
  registry: {
    "AppA": { status: "Active"    as const, topo_level: 10 },  // 5000 bps
    "AppB": { status: "Suspended" as const, topo_level: 20 },  // 3000 bps — EXCLUDED
  },
  cert_allocs: [
    { app_id: "AppA", weight_bps: 5000n },
    { app_id: "AppB", weight_bps: 3000n },
  ],
  eff_bal: 1_000_000_000_000n,  // 1000 MAGIC
  min_self: 500n,
  // active-only delegation = 5000 (AppB excluded)
  expected_delegation_active: 5000n,
  // self_capacity_bps = max(500, 10000-5000) = 5000
  expected_self_capacity_bps: 5000n,
  // self_capacity_total = 1000M × 5000/10000 = 500M
  expected_self_capacity_total: 500_000_000_000n,  // 500 MAGIC
};

export const TV_SC_002 = {
  id: "TV-SC-002", spec_ref: "Appendix B.3",
  description: "C-DC-CAP blocks 100% delegation when MIN_SELF=500",
  min_self: 500n,
  cap_value: 9500n,  // 10000 - 500
  attempt_sigma_w: 10000n,  // 100%
  expect: "REJECT",  // 10000 > 9500
  max_valid_sigma_w: 9500n,
};

export const TV_SC_003 = {
  id: "TV-SC-003", spec_ref: "Appendix B.3",
  description: "Terminated app cannot receive AppDelegation burns",
  registry: {
    "AppA": { status: "Terminated" as const, topo_level: 10 },
    "AppB": { status: "Active"     as const, topo_level: 20 },
  },
  burn_via_A: "REJECT",  // C-APP-V2: Active required
  burn_via_B: "ACCEPT",
};

// ══════════════════════════════════════════════════════════════
// B.4 C-DC-CAP Migration (TV-DCAP-*)
// ══════════════════════════════════════════════════════════════

export const TV_DCAP_001 = {
  id: "TV-DCAP-001", spec_ref: "Appendix B.4",
  cases: [
    { sigma_w: 9500n, expect: "ACCEPT", self_capacity_bps: 500n, t14_6: true },
    { sigma_w: 9501n, expect: "REJECT" },
  ],
};

export const TV_DCAP_002 = {
  id: "TV-DCAP-002", spec_ref: "Appendix B.4",
  description: "DAO raise MIN_SELF 500→1000: new cap = 9000, old cert graceful degradation",
  old_min_self: 500n, new_min_self: 1000n,
  old_cert_sigma_w: 9500n,
  // During migration (0-4 epoch): effective = min(9500, 9000) = 9000; ACCEPT
  migration_effective: 9000n,
  migration_self_bps: 1000n,
  // After migration: new DelegationChangeRedeemer with 9500 → REJECT
  post_migration_9500: "REJECT",
};

// ══════════════════════════════════════════════════════════════
// B.5 Topo Level (TV-TOPOS-*)
// ══════════════════════════════════════════════════════════════

export const TV_TOPOS_001 = {
  id: "TV-TOPOS-001", spec_ref: "Appendix B.5",
  description: "Valid chain: A(10)→B(20)→C(30)→D(40) — all accepted, T14.13 guarantees acyclic",
  registry: { A: { status: "Active" as const, topo_level: 10 }, B: { status: "Active" as const, topo_level: 20 },
              C: { status: "Active" as const, topo_level: 30 }, D: { status: "Active" as const, topo_level: 40 } },
  chains: [
    { source: "A", dests: ["B"], expect: "ACCEPT" },  // 20 > 10 ✓
    { source: "B", dests: ["C"], expect: "ACCEPT" },  // 30 > 20 ✓
    { source: "C", dests: ["D"], expect: "ACCEPT" },  // 40 > 30 ✓
  ],
};

export const TV_TOPOS_002 = {
  id: "TV-TOPOS-002", spec_ref: "Appendix B.5 (T14.13 formal)",
  description: "Cycle D→A impossible: A.topo_level=10 ≤ D.topo_level=40",
  registry: { A: { status: "Active" as const, topo_level: 10 }, D: { status: "Active" as const, topo_level: 40 } },
  attempt: { source: "D", dests: ["A"] },
  expect: "REJECT",  // 10 ≤ 40 → C-REA-NOCYCLE
};

export const TV_TOPOS_003 = {
  id: "TV-TOPOS-003", spec_ref: "Appendix B.5",
  description: "Self-loop rejected by C-REA-3",
  registry: { X: { status: "Active" as const, topo_level: 50 } },
  attempt: { source: "X", dests: ["X"] },
  expect: "REJECT",  // dest == source
};

export const TV_TOPOS_004 = {
  id: "TV-TOPOS-004", spec_ref: "Appendix B.5",
  description: "Governance lower dest topo_level → graceful skip (not reject tx)",
  source_level: 10, dest_level_after_dao: 5,
  expect_at_burn_time: "SKIP",  // dest_level ≤ source_level → skip, not fail
};

// ══════════════════════════════════════════════════════════════
// B.6 ActivityState (TV-ACT-*)
// ══════════════════════════════════════════════════════════════

export const TV_ACT_001 = {
  id: "TV-ACT-001", spec_ref: "Appendix B.6",
  description: "SelfBurn: recent_burn_epochs unchanged, total_burns_count +1",
  input_state: { recent_burn_epochs: [["app1", 95n]] as [string,bigint][], total_burns_count: 5n },
  mode: "SelfBurn" as const,
  epoch: 103n,
  expected: { recent_burn_epochs: [["app1", 95n]] as [string,bigint][], total_burns_count: 6n },
};

export const TV_ACT_002 = {
  id: "TV-ACT-002", spec_ref: "Appendix B.6",
  description: "AppDelegation: entry added; DRM_LOOKBACK=12, inclusive lower bound ep≥91",
  input_state: { recent_burn_epochs: [["app1", 95n], ["app2", 91n]] as [string,bigint][], total_burns_count: 5n },
  mode: { AppDelegation: { app_id: "aladin" } } as const,
  epoch: 103n,
  // Prune: ep ≥ 103-12=91 (inclusive) → both kept; add (aladin,103)
  expected_size: 3,
  expected_has: ["aladin", 103n] as [string, bigint],
  expected_count: 6n,
};

export const TV_ACT_003 = {
  id: "TV-ACT-003", spec_ref: "Appendix B.6 [CONFIRMED CORRECT]",
  description: "OAC window at e=104: ep≥92 (exclusive 91); DRM_LOOKBACK=12",
  state: { recent_burn_epochs: [["aladin",103n],["app1",95n],["app2",91n]] as [string,bigint][], total_burns_count: 10n },
  epoch: 104n,
  // Window: ep ≥ 104-12=92  →  91 < 92 → EXCLUDED
  expected_in_window: [["aladin",103n],["app1",95n]] as [string,bigint][],
  expected_active_app_count: 2,
  note: "Epoch 91 exclusion CORRECT (91 < 92 = 104-12). Do not modify.",
};

export const TV_ACT_004 = {
  id: "TV-ACT-004", spec_ref: "Appendix B.6",
  description: "C-ACTIVITY-DEDUP: same (app_id, epoch) in 3 burns → only 1 entry added",
  start_state: { recent_burn_epochs: [] as [string,bigint][], total_burns_count: 0n },
  app_id: "app_A", epoch: 103n, burns: 3,
  expected_final_recent_size: 1,  // only 1 entry for (app_A, 103)
  expected_burns_count: 3n,       // count always +1 per burn
};

export const TV_ACT_005 = {
  id: "TV-ACT-005", spec_ref: "Appendix B.6",
  description: "Size bound: MAX_DELEGATION_APPS=5, DRM_LOOKBACK=12 → ≤ 60 entries",
  max_entries: 60,
  memory_kb: 2.2,  // 60 × 36 bytes ≈ 2.2 KB << 16 KB tx limit
};

// ══════════════════════════════════════════════════════════════
// B.7 Personal Delegate (TV-PD-*)
// ══════════════════════════════════════════════════════════════

export const TV_PD_001 = {
  id: "TV-PD-001", spec_ref: "Appendix B.7",
  description: "PD cannot be registered app (set-time check C-PERSONAL-DELEGATE-CONSTRAINT)",
  aladin_pkh: "aladin_pkh", registry_includes_aladin: true,
  attempt: "PersonalDelegateUpdateRedeemer { new_delegate: aladin_pkh }",
  expect: "REJECT",
};

export const TV_PD_002 = {
  id: "TV-PD-002", spec_ref: "Appendix B.7 (C-PD-V11 runtime)",
  description: "App registers after PD set → runtime burn fails",
  timeline: [
    { epoch: 100n, action: "set PD = bot_pkh", bot_in_registry: false, result: "ACCEPT" },
    { epoch: 105n, action: "bot_pkh registers as App", result: "OK" },
    { epoch: 110n, action: "Burn with PersonalDelegate mode", bot_in_registry: true, result: "REJECT" },
  ],
};

export const TV_PD_003 = {
  id: "TV-PD-003", spec_ref: "Appendix B.7",
  description: "PD = Suspended app blocked at set-time (Suspended is still 'in registry')",
  suspended_pkh: "susp_pkh",
  registry_includes: true,  // Suspended is in registry
  expect: "REJECT",
};

// ══════════════════════════════════════════════════════════════
// B.8 Scale-Back Burn (TV-SSB-*)
// ══════════════════════════════════════════════════════════════

export const TV_SSB_001 = {
  id: "TV-SSB-001", spec_ref: "Appendix B.8 (GenMAGIC T17, user-favorable)",
  description: "Lantern Snapshot, k=3, burn 200M nanogic",
  batch: { profile: "Lantern" as const, initial: 1_000_000_000n, created: 100n, decay_window: 10n },
  epoch: 103n,  // k=3, r=1
  // balance_before = 1B × 9^3 / 10^3 = 1B × 729/1000 = 729_000_000
  balance_before: 729_000_000n,
  burn_amount: 200_000_000n,
  // isb = 200M × 10^3 / 9^3 = 200M × 1000/729 = 274_348_422 (floor)
  expected_isb: 274_348_422n,
  expected_new_initial: 725_651_578n,  // 1B - 274_348_422
  // new_balance = 725_651_578 × 729 / 1000 = 529_000_000 (floor)
  expected_new_balance: 529_000_000n,
  // error = |529M - (729M - 200M)| = 0 (user-favorable, T17) ✓
  error: 0n,
};

export const TV_SSB_002 = {
  id: "TV-SSB-002", spec_ref: "Appendix B.8",
  description: "INV-CM-BATCH-4: Snapshot initial_amount only decreases",
  initial_before: 1_000_000_000n,
  initial_after_burn: 725_651_578n,  // < before ✓
  expect_increase_rejected: true,
};

// ══════════════════════════════════════════════════════════════
// B.9 Auto-burn (TV-AB-*)
// ══════════════════════════════════════════════════════════════

export const TV_AB_001 = {
  id: "TV-AB-001", spec_ref: "Appendix B.9 (RULE AB-2)",
  description: "target=Some(aladin_id), Active → fee=0 policy waiver, credit + OAC",
  target_app_id: "aladin_id", registry_status: "Active" as const,
  burn_amount: 45n * MAGIC,
  expected_fee: 0n,           // C-FIRE-AB-FEE: policy, not rounding
  expected_credit: 45n * MAGIC,
  oac_updated: true,
  attribution_updated: true,  // RULE AB-ATTRIBUTION
};

export const TV_AB_002 = {
  id: "TV-AB-002", spec_ref: "Appendix B.9",
  description: "target=Suspended → C-FIRE-AB-STATUS REJECT",
  target_app_id: "susp_id", registry_status: "Suspended" as const,
  expect: "REJECT",
};

export const TV_AB_003 = {
  id: "TV-AB-003", spec_ref: "Appendix B.9 (RULE AB-1)",
  description: "target=None: fee=0, no credit update, no OAC, attribution updated",
  target_app_id: null,
  expected_fee: 0n,
  credit_updated: false,
  oac_updated: false,
  attribution_updated: true,  // RULE AB-ATTRIBUTION applies
};

// ══════════════════════════════════════════════════════════════
// B.10/11 Re-allocation, Zombie (TV-REA-*, TV-ZOMBIE-*)
// ══════════════════════════════════════════════════════════════

export const TV_REA_CYCLE_001 = {
  id: "TV-REA-CYCLE-001", spec_ref: "Appendix B.10",
  source: "A", dest: "A",  // self-loop
  expect: "REJECT",  // C-REA-3
};

export const TV_REA_CYCLE_002 = {
  id: "TV-REA-CYCLE-002", spec_ref: "Appendix B.10",
  source_level: 10, dest_level: 8,
  expect: "REJECT",  // C-REA-NOCYCLE: 8 ≤ 10
};

export const TV_REA_CONSTRAINED_001 = {
  id: "TV-REA-CONSTRAINED-001", spec_ref: "Appendix B.10",
  description: "D(40)→A(10): REJECT; D(40)→E(50): ACCEPT",
  registry: { A: { status: "Active" as const, topo_level: 10 }, D: { status: "Active" as const, topo_level: 40 },
              E: { status: "Active" as const, topo_level: 50 } },
  cases: [
    { source: "D", dest: "A", expect: "REJECT" },  // 10 ≤ 40
    { source: "D", dest: "E", expect: "ACCEPT" },  // 50 > 40
  ],
};

export const TV_ZOMBIE_001 = {
  id: "TV-ZOMBIE-001", spec_ref: "Appendix B.11 (C-DELEGATION-ZOMBIE-CLEANUP)",
  description: "Remove Terminated app: effective_epoch = current (no buffer)",
  app_status: "Terminated" as const,
  expected_effective_epoch: "current_epoch",  // immediate, no DELEGATION_BUFFER
};

export const TV_ZOMBIE_002 = {
  id: "TV-ZOMBIE-002", spec_ref: "Appendix B.11",
  description: "Remove Active app: effective_epoch = current + DELEGATION_BUFFER",
  app_status: "Active" as const,
  expected_effective_epoch: "current_epoch + 2",  // standard buffer
};
