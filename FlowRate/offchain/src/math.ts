import { Q, FlowRateDatum, EpochFlow } from './types.js';

// ── Constants ──────────────────────────────────────────────────────────────
export const ALPHA_FAST_Q = Q / 3n;      // α ≈ 0.333 — fast EMA
export const ALPHA_SLOW_Q = Q / 12n;     // α ≈ 0.083 — slow EMA (12-epoch window)
export const BASE_CAP_Q = 250_000_000n;  // 25% max cap (calm market)
export const MIN_CAP_Q   = 50_000_000n;  // 5% min cap (high manipulation)
export const DIV_BLEND_PIVOT = 100_000_000n;  // 10% divergence = blend shift pivot
export const BLEND_FAST_MAX  = 700_000_000n;  // 70% max weight for fast EMA
export const HARD_FLOOR_Q    = 10_000_000n;   // 0.01 LAMP/MAGIC absolute floor
export const HARD_CEIL_Q     = 10_000_000_000n; // 10 LAMP/MAGIC absolute ceiling
export const MIN_MAGIC_EPOCH = 1_000_000_000_000n; // 1000 MAGIC min activity threshold

function clamp(x: bigint, lo: bigint, hi: bigint): bigint {
  return x < lo ? lo : x > hi ? hi : x;
}

function abs(x: bigint): bigint { return x < 0n ? -x : x; }

// Divergence: |fast - slow| / slow in Q-format
export function divergence(ema_fast_q: bigint, ema_slow_q: bigint): bigint {
  if (ema_slow_q === 0n) return 0n;
  return abs(ema_fast_q - ema_slow_q) * Q / ema_slow_q;
}

// Adaptive cap: 25%/(1 + 3×div) ∈ [5%, 25%]
// When calm (div≈0): cap=25%, When manipulated (div≈8%): cap≈25%/(1+24%)≈20%
export function adaptiveCap(div_q: bigint): bigint {
  // cap_q = BASE_CAP_Q × Q / (Q + 3 × div_q)
  const cap_q = BASE_CAP_Q * Q / (Q + 3n * div_q);
  return clamp(cap_q, MIN_CAP_Q, BASE_CAP_Q);
}

// Fast weight: 70% at div=0, 0% at div>=10%
export function blendWeightFast(div_q: bigint): bigint {
  if (div_q >= DIV_BLEND_PIVOT) return 0n;
  return (DIV_BLEND_PIVOT - div_q) * BLEND_FAST_MAX / DIV_BLEND_PIVOT;
}

// Update flow rate state — called by FlowRateKeeper each epoch
export function updateFlowRate(datum: FlowRateDatum, flow: EpochFlow): FlowRateDatum {
  // Guard: insufficient activity
  if (flow.total_magic_ng < MIN_MAGIC_EPOCH || flow.total_lamp_oil === 0n) {
    return { ...datum, last_epoch: flow.epoch };
  }
  // Guard: epoch must advance
  if (flow.epoch <= datum.last_epoch) return datum;

  // Raw rate this epoch (Q-format)
  const raw_rate_q = flow.total_lamp_oil * Q / flow.total_magic_ng;

  // Update fast EMA: ema_new = (α × raw + (1-α) × ema_old) / Q
  const new_fast = (ALPHA_FAST_Q * raw_rate_q + (Q - ALPHA_FAST_Q) * datum.ema_fast_q) / Q;
  // Update slow EMA
  const new_slow = (ALPHA_SLOW_Q * raw_rate_q + (Q - ALPHA_SLOW_Q) * datum.ema_slow_q) / Q;

  // Divergence between fast and slow
  const div_q = divergence(new_fast, new_slow);

  // Adaptive cap based on divergence
  const cap_q = adaptiveCap(div_q);

  // Blended rate: trust fast when calm, trust slow when manipulated
  const w_fast = blendWeightFast(div_q);
  const w_slow = Q - w_fast;
  const rate_blended = (w_fast * new_fast + w_slow * new_slow) / Q;

  // Apply adaptive rate-of-change cap vs PREVIOUS lamp_per_magic_q
  const prev = datum.lamp_per_magic_q;
  const max_rate = prev * (Q + cap_q) / Q;
  const min_rate = prev * (Q - cap_q) / Q;
  const rate_capped = clamp(rate_blended, min_rate, max_rate);

  return {
    ema_fast_q: clamp(new_fast, HARD_FLOOR_Q, HARD_CEIL_Q),
    ema_slow_q: clamp(new_slow, HARD_FLOOR_Q, HARD_CEIL_Q),
    lamp_per_magic_q: clamp(rate_capped, HARD_FLOOR_Q, HARD_CEIL_Q),
    total_lamp_epoch: flow.total_lamp_oil,
    total_magic_epoch: flow.total_magic_ng,
    last_epoch: flow.epoch,
    div_q,
    cap_q,
  };
}
