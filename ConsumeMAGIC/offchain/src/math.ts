// src/math.ts — ConsumeMAGIC v2.2 Pure Math Engine
// NORMATIVE: spec §3-§12, Appendix C formal proofs
// ALL arithmetic BigInt. No Number for nanogic/oil (C8).

// ── Genesis constants (§16.1) ────────────────────────────────
export const Q                      = 1_000_000_000n;
export const DELEGATION_FEE_BPS     = 100n;    // 1% [Significant]
export const MIN_SELF_CAPACITY_BPS  = 500n;    // 5% [Significant]
export const DRM_LOOKBACK           = 12n;     // OAC window [GenMAGIC §6.4]
export const MIN_BURN_FOR_OAC_COUNT = 1_000_000_000n;  // 1 MAGIC [GenMAGIC §6.4]
export const PROFILE_DECAY_RATES    = { Ember: 3n, Flame: 2n, Lantern: 1n } as const;
export const MAX_DELEGATION_APPS    = 5;
export const DELEGATION_BUFFER      = 2n;      // epochs [GenMAGIC §12]

// ── Types ─────────────────────────────────────────────────────
export type ActivityProfile = "Ember" | "Flame" | "Lantern";
export type BatchSource     = "Snapshot" | "Instant" | "Vacuum" | "Schedule";
export type AppStatus       = "Trial" | "Active" | "Suspended" | "Terminated";
export type BurnMode        = "SelfBurn" | "PersonalDelegate" | { AppDelegation: { app_id: string } };

export interface MagicBatch {
  batch_id       : string;
  source         : BatchSource;
  created_epoch  : bigint;
  initial_amount : bigint;
  current_amount : bigint;
  decay_window   : bigint;
  profile_at_creation: ActivityProfile | null;   // Some for Snapshot
  halved         : boolean;                       // Instant only
}

export interface AppAllocation {
  app_id      : string;
  weight_bps  : bigint;
}

export interface DelegationCertificate {
  current                  : AppAllocation[];
  current_effective_epoch  : bigint;
  pending                  : { allocations: AppAllocation[]; effective_epoch: bigint } | null;
  last_changed_epoch       : bigint;
}

export interface ActivityState {
  recent_burn_epochs : [string, bigint][];   // (app_id, epoch)
  total_burns_count  : bigint;
}

export interface VaultAttribution {
  attribution_root : Uint8Array;
  total_events     : bigint;
  last_event_epoch : bigint;
}

export interface AppRegistry {
  [app_id: string]: { status: AppStatus; topo_level: number };
}

export interface GovernanceParams {
  min_self_capacity_bps : bigint;
  delegation_fee_bps    : bigint;
}

// ══════════════════════════════════════════════════════════════
// §4.7 compute_balance — GenMAGIC v3.3 definition
// Called ONLY on post-halving, post-prune batches (INV-CM-EFF-BAL)
// ══════════════════════════════════════════════════════════════
export function computeBalance(batch: MagicBatch, e: bigint): bigint {
  const k = e - batch.created_epoch;
  if (k < 0n) throw new Error(`Epoch ${e} before batch creation`);
  if (k >= batch.decay_window) return 0n;

  if (batch.source === "Snapshot") {
    const r = PROFILE_DECAY_RATES[batch.profile_at_creation ?? "Flame"];
    // I(b) × (10-r)^k / 10^k — integer division
    const numerator   = batch.initial_amount * (10n - r) ** k;
    const denominator = 10n ** k;
    return numerator / denominator;
  }
  // Instant / Vacuum / Schedule: cliff
  return batch.current_amount;
}

// ══════════════════════════════════════════════════════════════
// §10.2 STEP 0c — Lazy halving (CRITICAL: before any compute_balance)
// C-BURN-HALVING: Instant batch k=1, halved=False → halve
// ══════════════════════════════════════════════════════════════
export function applyLazyHalving(batches: MagicBatch[], e: bigint): MagicBatch[] {
  return batches.map(b => {
    if (b.source === "Instant" && (e - b.created_epoch) === 1n && !b.halved) {
      return { ...b, current_amount: b.current_amount / 2n, halved: true };
    }
    return b;
  });
}

// ══════════════════════════════════════════════════════════════
// §10.2 STEP 0d — Prune expired batches (C-BURN-PRUNE)
// ══════════════════════════════════════════════════════════════
export function getLiveBatches(batches: MagicBatch[], e: bigint): MagicBatch[] {
  return batches.filter(b => e - b.created_epoch < b.decay_window);
}

// ══════════════════════════════════════════════════════════════
// §10.2 STEP 4 — Effective balance (INV-CM-EFF-BAL)
// ONLY call with post-halving, post-prune batches
// ══════════════════════════════════════════════════════════════
export function effectiveBalance(liveBatches: MagicBatch[], e: bigint): bigint {
  return liveBatches.reduce((s, b) => s + computeBalance(b, e), 0n);
}

// ══════════════════════════════════════════════════════════════
// §3.1 + §5.3 — Active-only delegation (FIX-N2, v2.2)
// Excludes Suspended AND Terminated apps
// Used by ALL burn modes (no conservative variant in v2.2)
// ══════════════════════════════════════════════════════════════
export function delegationEffectiveBpsActive(
  cert     : DelegationCertificate,
  e        : bigint,
  registry : AppRegistry,
): bigint {
  // Apply pending if effective
  const allocs = (cert.pending && cert.pending.effective_epoch <= e)
    ? cert.pending.allocations
    : cert.current;

  return allocs.reduce((s, a) => {
    const entry = registry[a.app_id];
    return entry?.status === "Active" ? s + a.weight_bps : s;
  }, 0n);
}

// §3.2 — Self-capacity
// C-SELF-FLOOR: self_capacity_bps ≥ MIN_SELF_CAPACITY_BPS (enforced by max)
export function selfCapacityBps(
  cert     : DelegationCertificate,
  e        : bigint,
  registry : AppRegistry,
  minSelf  : bigint = MIN_SELF_CAPACITY_BPS,
): bigint {
  const delegated = delegationEffectiveBpsActive(cert, e, registry);
  return delegated >= 10000n - minSelf
    ? minSelf
    : 10000n - delegated;
}

export function selfCapacityTotal(
  cert        : DelegationCertificate,
  liveBatches : MagicBatch[],
  e           : bigint,
  registry    : AppRegistry,
  govParams   : GovernanceParams,
): bigint {
  const effBal = effectiveBalance(liveBatches, e);
  const bps    = selfCapacityBps(cert, e, registry, govParams.min_self_capacity_bps);
  return effBal * bps / 10000n;
}

// §5.2 — App budget per-tx
export function appBudgetPerTx(
  cert        : DelegationCertificate,
  appId       : string,
  liveBatches : MagicBatch[],
  e           : bigint,
  registry    : AppRegistry,
): bigint {
  const allocs = (cert.pending && cert.pending.effective_epoch <= e)
    ? cert.pending.allocations
    : cert.current;
  const alloc = allocs.find(a => a.app_id === appId);
  if (!alloc) return 0n;
  const effBal = effectiveBalance(liveBatches, e);
  return effBal * alloc.weight_bps / 10000n;
}

// ══════════════════════════════════════════════════════════════
// §6 — Fee computation
// C-APP-V6: service_amount ≥ MIN_SERVICE_AMOUNT
// When FEE_BPS=0: MIN_SERVICE_AMOUNT=1 (prevent zero-amount burns)
// ══════════════════════════════════════════════════════════════
export function minServiceAmount(feeBps: bigint): bigint {
  if (feeBps === 0n) return 1n;
  // ceiling(10000 / feeBps)
  return (10000n + feeBps - 1n) / feeBps;
}

export function computeFee(serviceAmount: bigint, feeBps: bigint): bigint {
  return serviceAmount * feeBps / 10000n;
}

export function totalDeducted(serviceAmount: bigint, feeBps: bigint): bigint {
  return serviceAmount + computeFee(serviceAmount, feeBps);
}

// ══════════════════════════════════════════════════════════════
// §7.2 — C-REA-NOCYCLE: topo_level O(K) check (FIX-N8)
// Replaces DFS (60% ExUnit). Formally sound: T14.13.
// ══════════════════════════════════════════════════════════════
export function validateReAllocDestinations(
  sourceId     : string,
  destinations : string[],
  registry     : AppRegistry,
): { valid: boolean; reason?: string } {
  const sourceLevel = registry[sourceId]?.topo_level ?? 0;
  for (const destId of destinations) {
    if (destId === sourceId)
      return { valid: false, reason: `C-REA-3: self-loop ${sourceId}` };
    const destLevel = registry[destId]?.topo_level;
    if (destLevel === undefined)
      return { valid: false, reason: `dest ${destId} not in registry` };
    if (destLevel <= sourceLevel)
      return { valid: false, reason: `C-REA-NOCYCLE: dest ${destId} level ${destLevel} ≤ source ${sourceLevel}` };
  }
  return { valid: true };
}

// ══════════════════════════════════════════════════════════════
// §10.3 — apply_burns (per-batch, spec §10.3 NORMATIVE)
// NOT FIFO — user specifies exact batch_id + amount
// Snapshot: scale-back burn (GenMAGIC T17, user-favorable)
// Non-Snapshot: direct current_amount reduction
// ══════════════════════════════════════════════════════════════
export interface BurnItem { batch_id: string; amount: bigint; }

export function applyBurns(
  liveBatches : MagicBatch[],
  items       : BurnItem[],
  e           : bigint,
): MagicBatch[] {
  const batchMap = new Map(liveBatches.map(b => [b.batch_id, { ...b }]));

  for (const item of items) {
    const b = batchMap.get(item.batch_id);
    if (!b) throw new Error(`Batch ${item.batch_id} not in live batches`);

    if (b.source === "Snapshot") {
      // Scale-back burn (GenMAGIC §6.6, T17 user-favorable)
      const k = e - b.created_epoch;
      const r = PROFILE_DECAY_RATES[b.profile_at_creation ?? "Flame"];
      // isb = item.amount × 10^k / (10-r)^k  [integer, may round down = user-favorable]
      const isb = item.amount * (10n ** k) / ((10n - r) ** k);
      b.initial_amount -= isb;
    } else {
      b.current_amount -= item.amount;
    }

    // Remove fully consumed batches
    if (computeBalance(b, e) === 0n) {
      batchMap.delete(item.batch_id);
    }
  }

  return [...batchMap.values()];
}

// ══════════════════════════════════════════════════════════════
// §5.4 / §10.2 STEP 6 — ActivityState update
// C-ACTIVITY-DEDUP: no duplicate (app_id, epoch) entries
// Only AppDelegation updates recent_burn_epochs (C2 principle)
// INV-CM-ACT-WIN: ep ≥ e − DRM_LOOKBACK (inclusive lower bound)
// ══════════════════════════════════════════════════════════════
export function updateActivityState(
  state  : ActivityState,
  mode   : BurnMode,
  e      : bigint,
): ActivityState {
  // Prune outside window (inclusive: ep ≥ e - DRM_LOOKBACK)
  const pruned = state.recent_burn_epochs.filter(
    ([, ep]) => ep >= e - DRM_LOOKBACK,
  );

  const newState: ActivityState = {
    total_burns_count:  state.total_burns_count + 1n,
    recent_burn_epochs: pruned,
  };

  if (typeof mode === "object" && "AppDelegation" in mode) {
    const appId = mode.AppDelegation.app_id;
    // C-ACTIVITY-DEDUP: skip if (app_id, e) already present
    const exists = pruned.some(([id, ep]) => id === appId && ep === e);
    if (!exists) {
      // Insert at front (epoch-descending order per INV-CM-ACT-ORDER)
      newState.recent_burn_epochs = [[appId, e], ...pruned];
    }
  }

  return newState;
}

// ══════════════════════════════════════════════════════════════
// §12 — Attribution hash chain (STEP 7, RULE AB-ATTRIBUTION)
// Per BurnItem: new_root = blake2b256(old_root || encode(event))
// ══════════════════════════════════════════════════════════════
import { blake2b } from "@noble/hashes/blake2b";

export function encodeEvent(appIdOpt: string | null): Uint8Array {
  const tag = `BatchBurned:${appIdOpt ?? "null"}`;
  return new TextEncoder().encode(tag);
}

export function updateAttributionChain(
  attribution : VaultAttribution,
  items       : BurnItem[],
  appIdOpt    : string | null,
  e           : bigint,
): VaultAttribution {
  let root = attribution.attribution_root;
  let count = attribution.total_events;

  for (const _ of items) {
    const event = encodeEvent(appIdOpt);
    const preimage = new Uint8Array(root.length + event.length);
    preimage.set(root, 0);
    preimage.set(event, root.length);
    root = blake2b(preimage, { dkLen: 32 });
    count++;
  }

  return { attribution_root: root, total_events: count, last_event_epoch: e };
}

// ══════════════════════════════════════════════════════════════
// §10.4 — delegation_proof_valid
// CRITICAL: budget ALWAYS from cert weight, never from proof.weight_bps (C-APP-PROOF)
// ══════════════════════════════════════════════════════════════
export interface DelegationProof {
  app_id          : string;
  weight_bps      : bigint;
  effective_epoch : bigint;
}

export function delegationProofValid(
  proof    : DelegationProof,
  cert     : DelegationCertificate,
  e        : bigint,
): boolean {
  const allocs = (cert.pending && cert.pending.effective_epoch <= e)
    ? cert.pending.allocations
    : cert.current;

  const certAlloc = allocs.find(a => a.app_id === proof.app_id);
  if (!certAlloc) return false;
  if (certAlloc.weight_bps !== proof.weight_bps) return false;

  const validEpoch = proof.effective_epoch === cert.current_effective_epoch
    || (cert.pending !== null && proof.effective_epoch === cert.pending.effective_epoch);
  return validEpoch;
}

// ══════════════════════════════════════════════════════════════
// C-DC-CAP (§3.3 FIX-M1) — delegation change validation
// At DelegationChangeRedeemer: Σw ≤ 10000 − min_self
// ══════════════════════════════════════════════════════════════
export function validateDelegationCap(
  newAllocations : AppAllocation[],
  minSelf        : bigint = MIN_SELF_CAPACITY_BPS,
): { valid: boolean; reason?: string } {
  const total = newAllocations.reduce((s, a) => s + a.weight_bps, 0n);
  const cap   = 10000n - minSelf;
  if (total > cap)
    return { valid: false, reason: `C-DC-CAP: Σw=${total} > ${cap} (10000 − ${minSelf})` };
  return { valid: true };
}

// ══════════════════════════════════════════════════════════════
// Utility
// ══════════════════════════════════════════════════════════════
export function nanogicToMagicStr(ng: bigint, dec = 4): string {
  if (ng === 0n) return "0." + "0".repeat(dec);
  const NANOGIC_PER_MAGIC = 1_000_000_000n;
  return `${ng / NANOGIC_PER_MAGIC}.${(ng % NANOGIC_PER_MAGIC).toString().padStart(9, "0").slice(0, dec)}`;
}

export function countActiveAppsInWindow(state: ActivityState, e: bigint): number {
  const inWindow = state.recent_burn_epochs.filter(([, ep]) => ep >= e - DRM_LOOKBACK);
  return new Set(inWindow.map(([id]) => id)).size;
}
