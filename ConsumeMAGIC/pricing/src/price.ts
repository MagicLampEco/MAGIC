// @magiclamp/consumemagic-pricing — Consume-side pricing (CONTRACT v1 §A)
//
// price(op_type, t) = base_price[op_type] × demand_mult(t) / Q          (Q = 1e9)
//
// demand_mult(t) = clamp( SMA_N(load_raw) , m_min , m_max )
//   — FIR filter (Simple Moving Average + clamp), REUSING the UMKeeper structure
//     (UMKeeper/offchain/src/math.ts: computeSMA + clampUM). NO PI controller.
//
// Why FIR (not PI), per CONTRACT §A 4 trục:
//   (1) eUTXO-optimal: no integral state variable on datum → fewer bytes.
//   (2) Unconditional BIBO stability: bounded input (clamped load_raw history) →
//       SMA is a convex combination → output bounded, no tuning of Kp/Ki.
//   (3) Anti-windup free: no integral term → cannot wind up.
//   (4) Protocol consistency: UMKeeper already runs this filter correctly.
//
// ALL arithmetic BigInt. No Number for nanogic / Q values. Pure functions.

import { Q, clamp } from "@magiclamp/protocol-utils";

// ── Q-format constants (scale 1e9) ────────────────────────────────────────────
// Q is re-exported so callers/tests reference a single source of truth.
export { Q };

/** Default demand-multiplier bounds (CONTRACT §A: m_min=0.5, m_max=2.0). */
export const M_MIN_Q = 500_000_000n; //  0.5 × Q
export const M_MAX_Q = 2_000_000_000n; // 2.0 × Q

/** Neutral demand multiplier = 1.0 (used when history is empty). */
export const M_NEUTRAL_Q = Q; // 1.0 × Q

/** FIR window length N — matches UMKeeper UM_WINDOW (6). Governance param. */
export const DEMAND_WINDOW = 6;

// ── op_type base-price table (MVP, CONTRACT §A) ───────────────────────────────
// Unit: nanogic (1 MAGIC = 1e9 nanogic). DAO-governable param on-chain (PriceParam).
export const OP_IMAGE = 1; // process 1 image  → 0.01 MAGIC
export const OP_CID = 2; //   anchor 1 CID     → 0.001 MAGIC

/** Immutable readonly base-price map keyed by op_type → nanogic. */
export type BasePriceTable = Readonly<Record<number, bigint>>;

/** MVP base-price table. 0.01 MAGIC = 10_000_000n ng ; 0.001 MAGIC = 1_000_000n ng. */
export const MVP_BASE_PRICE: BasePriceTable = Object.freeze({
  [OP_IMAGE]: 10_000_000n, // 0.01 MAGIC
  [OP_CID]: 1_000_000n, //   0.001 MAGIC
});

// ── load_raw → demand history → SMA → clamp (FIR) ─────────────────────────────

/**
 * load_raw = ops_served_epoch / target_capacity   (scaled by Q).
 * Q-format ratio of demand vs capacity for one epoch.
 * Pure BigInt; division is floor (conservative — never over-prices on rounding).
 *
 * target_capacity is a governance param (> 0). Guarded to avoid div-by-zero:
 * a zero/negative capacity is treated as 1 (degenerate config), matching the
 * defensive `den = ... : 1n` pattern in UMKeeper computeUMRaw.
 */
export function computeLoadRaw(opsServedEpoch: bigint, targetCapacity: bigint): bigint {
  const den = targetCapacity > 0n ? targetCapacity : 1n;
  const ops = opsServedEpoch > 0n ? opsServedEpoch : 0n;
  return (ops * Q) / den;
}

/**
 * Append a raw load sample, keeping the last ≤ N values (FIR window).
 * Stores RAW (un-clamped) values — clamping happens only at the smoothed output,
 * mirroring UMKeeper appendHistory semantics. Pure: returns a new array.
 */
export function appendLoadHistory(
  history: readonly bigint[],
  newRaw: bigint,
  window: number = DEMAND_WINDOW,
): bigint[] {
  return [...history, newRaw].slice(-window);
}

/**
 * SMA_N — simple moving average of the load history (Q-format).
 * Empty history → neutral 1.0 (no demand signal yet). Floor division.
 * Identical structure to UMKeeper computeSMA.
 */
export function smaLoad(history: readonly bigint[]): bigint {
  if (history.length === 0) return M_NEUTRAL_Q;
  let sum = 0n;
  for (const x of history) sum += x;
  return sum / BigInt(history.length);
}

/**
 * demand_mult(history) = clamp( SMA_N(load_raw) , m_min , m_max )   (Q-format).
 *
 * This is the whole controller: an FIR low-pass (SMA) followed by a clamp.
 * Output is in [m_min, m_max] for ANY input → BIBO stable by construction.
 *
 * @param history  raw load samples (Q-format), newest-last, length ≤ window.
 * @param mMinQ    lower clamp (Q-format), default 0.5×Q.
 * @param mMaxQ    upper clamp (Q-format), default 2.0×Q.
 */
export function demandMult(
  history: readonly bigint[],
  mMinQ: bigint = M_MIN_Q,
  mMaxQ: bigint = M_MAX_Q,
): bigint {
  return clamp(smaLoad(history), mMinQ, mMaxQ);
}

// ── price ─────────────────────────────────────────────────────────────────────

/**
 * price_per_op = base_price[op_type] × demand_mult / Q   (nanogic).
 *
 * Floor division on the Q de-scale: price never exceeds the exact real value,
 * so the burn quote is never rounded UP against the user (CONTRACT §E:
 * magic_burned ≥ required — we keep `required` honest).
 *
 * @param opType         op_type key into the base-price table.
 * @param demandMultQ    demand multiplier in Q-format (output of demandMult).
 * @param basePriceTable governance base-price map (nanogic per op).
 * @returns price in nanogic for ONE op of this type.
 * @throws  if op_type is absent from the table (unknown op = no authoritative price).
 */
export function pricePerOp(
  opType: number,
  demandMultQ: bigint,
  basePriceTable: BasePriceTable = MVP_BASE_PRICE,
): bigint {
  const base = basePriceTable[opType];
  if (base === undefined) {
    throw new Error(`PRICE-001: unknown op_type ${opType} (not in base-price table)`);
  }
  return (base * demandMultQ) / Q;
}

/**
 * required = Σ price(op_type) × op_count   (nanogic) — total burn quote for a tx.
 * Mirrors the on-chain C-CM-2 accumulation. Pure BigInt.
 */
export function requiredBurn(
  items: ReadonlyArray<{ opType: number; opCount: bigint }>,
  demandMultQ: bigint,
  basePriceTable: BasePriceTable = MVP_BASE_PRICE,
): bigint {
  let total = 0n;
  for (const { opType, opCount } of items) {
    const count = opCount > 0n ? opCount : 0n;
    total += pricePerOp(opType, demandMultQ, basePriceTable) * count;
  }
  return total;
}
