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

export function appendHistory(history: bigint[], value: bigint): bigint[] {
  // C-UM-2: pure sliding window — keep last ≤ 6 entries.
  // P8: caller (computeNewUM) clamps BEFORE append để khớp Aiken
  // `append_capped(history, clamped_raw, 6)` — history lưu giá trị đã clamp.
  return [...history, value].slice(-UM_WINDOW);
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
  // P8: clamp-before-append. Aiken `append_capped(history, clamped_raw, 6)`
  // lưu giá trị ĐÃ CLAMP vào history → TS phải làm giống để `history` trong
  // datum khớp bit-identical (double clamp: lần 1 ở đây, lần 2 ở SMA output).
  const newRaw      = computeUMRaw(epochBurns, epochMints);   // raw cho redeemer new_raw
  const clampedRaw  = clampUM(newRaw);
  const newHistory  = appendHistory(datum.history, clampedRaw);
  const newSmoothed = clampUM(computeSMA(newHistory));
  return { newSmoothed, newHistory, newRaw };
}
