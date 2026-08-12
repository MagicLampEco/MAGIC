// src/eligibility.ts — GenMAGIC eligibility, PURE MATH (spec §6.2)
//
// P8: mirrors Eligibility/onchain/lib/magiclamp/eligibility/math.ak byte-for-byte.
// Change one side, change the other; ../tests/eligibility.test.ts holds the
// normative vectors both must reproduce.
//
// C-OVERFLOW: BigInt everywhere. Never Number — the payoff table runs balances up
// to 10^15 oildrop, and a Number would lose the low digits silently.
//
// DECIDED vs OPEN: the weights and the EMA mechanism are fixed by spec and are
// constants here. Every normalisation reference is a function ARGUMENT, because
// #26 requires those to be settled at PR review rather than baked into code.

export const Q = 1_000_000_000n;

/** Weights, spec §6.2. Σ = 1.5Q ⟹ eligibility ∈ [Q, 2.5Q] = [1.00×, 2.50×]. */
export const W_CONSUMED = 900_000_000n;
export const W_OFFPEAK  = 250_000_000n;
export const W_COMMIT   = 200_000_000n;
export const W_AGE      = 150_000_000n;

/** α = 1/6 in Q-format. Floor of Q/6, matching FlowRate's ALPHA_FAST_Q = Q/3. */
export const ALPHA_AGE_Q = 166_666_666n;

const imin = (a: bigint, b: bigint) => (a < b ? a : b);
const imax = (a: bigint, b: bigint) => (a > b ? a : b);

/** Clamp to [0, Q]. Spec §6.2 clamps EVERY rᵢ before weighting. */
export function clampQ(v: bigint): bigint {
  return imax(0n, imin(Q, v));
}

/**
 * r = clamp(0, Q, value × Q / reference)
 *
 * `reference` is an argument precisely because it is undecided. A zero reference
 * yields r = Q ("no bar to clear") instead of dividing by zero.
 */
export function ratioQ(value: bigint, reference: bigint): bigint {
  return clampQ(value * Q / imax(1n, reference));
}

// ── ageFactor — EMA of the vault balance ──────────────────────
//
// FlowRate's EMA form, not the `ema + (x − ema)·α` written in the issue: they are
// algebraically identical, but this one never forms a negative intermediate, so
// floor division rounds the same way whether the balance rose or fell. The
// issue's form truncates toward zero when the balance falls and away from it when
// it rises — free upward drift for anyone who oscillates their balance.

export function emaStep(emaQ: bigint, lampBalance: bigint): bigint {
  return (ALPHA_AGE_Q * (lampBalance * Q) + (Q - ALPHA_AGE_Q) * emaQ) / Q;
}

/**
 * Advance the EMA over `epochsElapsed`, applying at most `catchUpCap` steps.
 *
 * The cap is the escape hatch #26 demands: a missed epoch costs convergence
 * speed, never access. `catchUpCap` is a parameter — bounding ExUnits is decided,
 * the number is not.
 */
export function emaCatchUp(
  emaQ: bigint,
  lampBalance: bigint,
  epochsElapsed: bigint,
  catchUpCap: bigint,
): bigint {
  const steps = imin(imax(0n, epochsElapsed), imax(0n, catchUpCap));
  let e = emaQ;
  for (let i = 0n; i < steps; i++) e = emaStep(e, lampBalance);
  return e;
}

/**
 * ageFactor = min(emaQ, balance × Q) / max(1, balance) ∈ [0, Q]
 *
 * "What fraction of the current balance has actually been sitting here." The
 * min() covers withdrawal, where the EMA sits above the balance: what remains is
 * fully aged, so r = Q rather than something above it.
 */
export function ageFactor(emaQ: bigint, lampBalance: bigint): bigint {
  return clampQ(imin(emaQ, lampBalance * Q) / imax(1n, lampBalance));
}

// ── The three undecided factors ───────────────────────────────

/**
 * MVP: `did_commit = #""` ⟹ cross-DID attribution is uncomputable ⟹ callers pass
 * 0 and forfeit the whole 0.90Q weight. Ceiling drops 2.50× → 1.60×.
 */
export function consumedFactor(consumedNanogic: bigint, consumedRef: bigint): bigint {
  return ratioQ(consumedNanogic, consumedRef);
}

export function offPeakFactor(networkLoad: bigint, loadRef: bigint): bigint {
  return ratioQ(imax(0n, loadRef - networkLoad), loadRef);
}

export function commitFactor(lampLocked: bigint, commitRef: bigint): bigint {
  return ratioQ(lampLocked, commitRef);
}

// ── Composition ───────────────────────────────────────────────

/**
 * eligibility_q = max(Q, Q + (Σ wᵢ·rᵢ) / Q)
 *
 * The outer max() can never bind while every rᵢ is clamped to [0, Q] and every
 * weight is non-negative. It is kept because the spec writes it, and because it
 * is the only guard between a future signed factor and an eligibility below
 * 1.00×. It is NOT support for negative factors — clampQ rejects those first.
 *
 * ONE floor division at the end: each wᵢ·rᵢ is exact (both ≤ Q), so there is no
 * per-term rounding to accumulate.
 */
export function eligibilityQ(
  ageR: bigint,
  consumedR: bigint,
  offPeakR: bigint,
  commitR: bigint,
): bigint {
  const weighted =
    W_AGE * clampQ(ageR) +
    W_CONSUMED * clampQ(consumedR) +
    W_OFFPEAK * clampQ(offPeakR) +
    W_COMMIT * clampQ(commitR);
  return imax(Q, Q + weighted / Q);
}

/** Render a Q-format multiplier as "1.6000×" for the payoff table. */
export function qToMultiplierStr(qv: bigint, dec = 4): string {
  const scale = 10n ** BigInt(dec);
  const scaled = qv * scale / Q;
  return `${scaled / scale}.${(scaled % scale).toString().padStart(dec, "0")}×`;
}
