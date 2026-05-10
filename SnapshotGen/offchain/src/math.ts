// src/math.ts — BigInt Math Engine (SnapshotGen)
// ALL arithmetic uses BigInt. Never use Number for oil/nanogic/Q-format.
// TV-OVERFLOW-01/02: Number fails. BigInt required (C-OVERFLOW).

import {
  Q, SNAPSHOT_BASE_RATE_Q, PROFILE_PARAMS,
  OAC_BASE_Q, OAC_INCREMENT_Q, OAC_CAP_APPS, DRM_LOOKBACK,
  SLOTS_PER_EPOCH, OIL_PER_LAMP, NANOGIC_PER_MAGIC,
} from "./constants.js";
import type { LoyaltyHolding, ActivityState } from "./types.js";

// ══════════════════════════════════════════════════════════════
// §6.3 Loyalty Factor (BigInt)
// ══════════════════════════════════════════════════════════════

/** LF(age) piecewise linear — Q-format result. TV-LF-01, TV-LF-02. */
export function lfPwlQ(age: bigint): bigint {
  if (age <= 0n) return Q;                                         // 1.00
  if (age <= 6n) return Q + Q / 10n * age / 6n;                  // 1.00..1.10
  if (age <= 12n) return Q + Q / 10n + Q / 10n * (age - 6n) / 6n;  // 1.10..1.20
  if (age <= 24n) return Q + Q / 5n + 3n * Q / 10n * (age - 12n) / 12n; // 1.20..1.50
  return 3n * Q / 2n;                                              // 1.50 cap
}

/** Weighted average LF across ALL holdings (locked + free). TV-LF-03.
 *  C-SS-5 / L3: uses full lamp_balance (locked holdings included). */
export function computeLfQ(holdings: LoyaltyHolding[], currentEpoch: bigint): bigint {
  const total = holdings.reduce((s, h) => s + h.amount, 0n);
  if (total === 0n) return Q;
  const weightedSum = holdings.reduce((s, h) => {
    const age = currentEpoch - h.acquired_epoch;
    return s + h.amount * lfPwlQ(age);
  }, 0n);
  return weightedSum / total;
}

// ══════════════════════════════════════════════════════════════
// §6.4 OAC (BigInt)
// ══════════════════════════════════════════════════════════════

/** Count distinct apps active in window [current-12, current). TV-OAC-BOUNDARY. */
export function countActiveApps(activity: ActivityState, currentEpoch: bigint): number {
  const windowStart = currentEpoch - DRM_LOOKBACK;
  const distinctApps = new Set(
    activity.recent_burn_epochs
      .filter(([, ep]) => ep >= windowStart && ep < currentEpoch)
      .map(([appId]) => appId),
  );
  return distinctApps.size;
}

/** OAC in Q-format. */
export function computeOacQ(activity: ActivityState, currentEpoch: bigint): bigint {
  const n = countActiveApps(activity, currentEpoch);
  return OAC_BASE_Q + OAC_INCREMENT_Q * BigInt(Math.min(n, OAC_CAP_APPS));
}

// ══════════════════════════════════════════════════════════════
// §8.1 SnapshotGen formula — 5 multiplications, no UM (T16)
// ══════════════════════════════════════════════════════════════
//
// M_snapshot = ⌊ L × R_snap × LF × OAC × PM × B ⌋ / Q⁵
//
// Error: ≤ 5 nanogic (L4). M_actual ≤ M_true.
//
// TV-SNAPGEN-01: 1000 LAMP, Flame, LF=1.0, OAC=0.8 → 4_620_000_000 ✓
// TV-SNAPGEN-MATURE: 1000 LAMP, Ember, LF=1.5, OAC=1.0 → 11_212_500_000 ✓

export function computeSnapshotMagic(
  lampBalanceOil : bigint,         // C-SS-5: FULL balance incl. locked
  lfQ            : bigint,
  oacQ           : bigint,
  profile        : string,
): bigint {
  const { B_Q, PM_Q } = PROFILE_PARAMS[profile]!;
  const s1 = lampBalanceOil * SNAPSHOT_BASE_RATE_Q / Q;  // × R_snap
  const s2 = s1 * lfQ  / Q;                              // × LF
  const s3 = s2 * oacQ / Q;                              // × OAC
  const s4 = s3 * PM_Q / Q;                              // × PM
  return s4 * B_Q / Q;                                   // × B
}

// ══════════════════════════════════════════════════════════════
// §8.2 Catch-up (C-SS-6)
// ══════════════════════════════════════════════════════════════

export function computeCatchupMagic(
  lampBalanceOil : bigint,
  lfQ            : bigint,
  oacQ           : bigint,
  profile        : string,
  deltaEpochs    : bigint,
): bigint {
  const mOne = computeSnapshotMagic(lampBalanceOil, lfQ, oacQ, profile);
  return deltaEpochs * mOne;
}

// ══════════════════════════════════════════════════════════════
// §4.2 / §6.2 Snapshot batch decay
// ══════════════════════════════════════════════════════════════
//
// balance(k) = ⌊ m₀ × (10-r)ᵏ / 10ᵏ ⌋    k < N(P)
// balance(k) = 0                             k ≥ N(P)
//
// L1: error ≤ N(P) nanogic across N steps (floor accumulation).
// L2: balance(k+1) ≤ balance(k) (monotone).
//
// TV-SS-01: Lantern k=0..9 (all 10 values)
// TV-SS-02: Flame   k=0..6
// TV-SS-03: Ember   k=0..3

export function snapshotBatchBalance(
  m0      : bigint,
  profile : string,
  k       : bigint,
): bigint {
  const { r, N } = PROFILE_PARAMS[profile]!;
  if (k < 0n) throw new Error(`Negative batch age k=${k}`);
  if (k >= BigInt(N)) return 0n;
  if (k === 0n) return m0;
  const num = BigInt(10 - r) ** k;
  const den = 10n ** k;
  return m0 * num / den;
}

export function isExpired(
  createdEpoch : bigint,
  decayWindow  : bigint,
  currentEpoch : bigint,
): boolean {
  return (currentEpoch - createdEpoch) >= decayWindow;
}

// ══════════════════════════════════════════════════════════════
// §6.6 Scale-back burn for Snapshot batches
// ══════════════════════════════════════════════════════════════
//
// initial_scale_burn = ⌊ b × 10ᵏ / (10-r)ᵏ ⌋
// new_initial        = m₀ − initial_scale_burn
//
// T17: |new_balance − (current − b)| ≤ 1 nanogic; new_balance ≥ current − b (user-favorable)
//
// TV-SS-04: Lantern k=3, m₀=10⁹, burn=200M
//   current = ⌊10⁹ × 9³/10³⌋ = 729_000_000
//   isb = ⌊200M × 10³/9³⌋ = ⌊200M × 1000/729⌋ = 274_348_422
//   new_initial = 10⁹ - 274_348_422 = 725_651_578
//   new_balance = ⌊725_651_578 × 729/1000⌋ = 529_000_000
//   diff = 729M - 200M - 529M = 0 ✓

export interface BurnResult {
  newInitialAmount : bigint;
  newBalance       : bigint;
  isb              : bigint;   // initial_scale_burn (for audit)
  diff             : bigint;   // current - burn - new_balance (should be 0 or -1)
}

export function burnSnapshot(
  m0      : bigint,
  profile : string,
  k       : bigint,
  burn    : bigint,
): BurnResult {
  const { r } = PROFILE_PARAMS[profile]!;
  const current = snapshotBatchBalance(m0, profile, k);
  if (burn > current) throw new Error(`burn (${burn}) > current (${current})`);
  if (burn <= 0n) throw new Error("burn must be > 0");

  const decayNum = BigInt(10 - r);
  const isb = burn * (10n ** k) / (decayNum ** k);   // ⌊b × 10^k / (10-r)^k⌋
  const newInitial = m0 - isb;
  const newBalance = snapshotBatchBalance(newInitial, profile, k);

  const diff = current - burn - newBalance;   // T17: ≥ 0 (user-favorable)
  if (newBalance < current - burn) {
    throw new Error(`T17 violated: new_balance ${newBalance} < current-burn ${current - burn}`);
  }

  return { newInitialAmount: newInitial, newBalance, isb, diff };
}

// ══════════════════════════════════════════════════════════════
// Utility
// ══════════════════════════════════════════════════════════════

export function slotToEpoch(slot: bigint): bigint { return slot / SLOTS_PER_EPOCH; }
export function lampToOil(lamp: bigint): bigint   { return lamp * OIL_PER_LAMP; }

export function nanogicToMagicStr(ng: bigint, decimals = 4): string {
  if (ng < 0n) throw new Error("Negative nanogic");
  const w = ng / NANOGIC_PER_MAGIC;
  const f = (ng % NANOGIC_PER_MAGIC).toString().padStart(9, "0").slice(0, decimals);
  return `${w}.${f}`;
}

export function qToStr(qv: bigint, decimals = 2): string {
  return (Number(qv) / 1e9).toFixed(decimals);
}
