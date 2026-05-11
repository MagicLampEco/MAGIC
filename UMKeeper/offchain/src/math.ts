// src/math.ts — UM Math only (no Lucid dependency)
// Exported separately so tests can run without @lucid-evolution/lucid

const Q        = 1_000_000_000n;
const UM_MIN_Q = 500_000_000n;
const UM_MAX_Q = 2_000_000_000n;
const UM_WINDOW = 6;

export function computeUMRaw(epochBurns: bigint, epochMints: bigint): bigint {
  const den = epochMints > 0n ? epochMints : 1n;
  return epochBurns * Q / den;
}

export function clampUM(x: bigint): bigint {
  if (x < UM_MIN_Q) return UM_MIN_Q;
  if (x > UM_MAX_Q) return UM_MAX_Q;
  return x;
}

export function appendHistory(history: bigint[], newRaw: bigint): bigint[] {
  // C-UM-2: keep last ≤ 6 raw values (NOT clamped — spec stores raw values)
  // Clamping happens only at the smoothed output level (computeNewUM)
  return [...history, newRaw].slice(-UM_WINDOW);
}

export function computeSMA(history: bigint[]): bigint {
  if (history.length === 0) return Q;
  return history.reduce((s, x) => s + x, 0n) / BigInt(history.length);
}

export interface UMDatum {
  smoothed_q: bigint;
  last_updated_epoch: bigint;
  history: bigint[];
}

export function computeNewUM(datum: UMDatum, epochBurns: bigint, epochMints: bigint) {
  const newRaw     = computeUMRaw(epochBurns, epochMints);
  const newHistory = appendHistory(datum.history, newRaw);
  const newSmoothed = clampUM(computeSMA(newHistory));
  return { newSmoothed, newHistory, newRaw };
}
