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
 * `reference` is an argument precisely because it is undecided. A reference ≤ 0
 * yields r = 0 — fail CLOSED. The earlier `max(1, ·)` form failed open: an unset
 * reference made every nonzero value saturate and handed out the factor's whole
 * weight to everyone. An unset reference is a wiring mistake, and a wiring
 * mistake must not pay.
 */
export function ratioQ(value: bigint, reference: bigint): bigint {
  if (reference <= 0n) return 0n;
  return clampQ(value * Q / reference);
}

// ── ageFactor — EMA of the vault balance ──────────────────────
//
// FlowRate's EMA form, not the `ema + (x − ema)·α` written in the issue. Identical
// over the reals, NOT over floored integers: `(x − ema)` goes negative whenever
// the balance falls, and Aiken's `/` floors toward −∞ while TypeScript's BigInt
// `/` truncates toward 0. This form never builds a negative intermediate, so both
// sides round identically in every direction. The rejected form drifts UP by 4
// units over five falling steps — see the TV-ELIG-EMA-FALLING vector.
//
// P8: both inputs are floored at 0 first. `emaQ` is a DATUM field, so a caller can
// present it negative; unclamped, the two sides disagree (emaStep(-5n, 0n) → -4n
// here, -5 in Aiken), the difference is WRITTEN BACK to the datum and compounds.

export function emaStep(emaQ: bigint, lampBalance: bigint): bigint {
  const e = imax(0n, emaQ);
  const b = imax(0n, lampBalance);
  return (ALPHA_AGE_Q * (b * Q) + (Q - ALPHA_AGE_Q) * e) / Q;
}

/**
 * Advance the EMA across a gap, then record the balance this tx leaves behind:
 * `steps − 1` steps at `balanceBefore`, then ONE final step at `balanceAfter`,
 * where `steps = min(epochsElapsed, catchUpCap)`.
 *
 * The final step at `balanceAfter` is what stops age-laundering: a vault that sat
 * empty for 24 epochs and then deposits ages the gap at the balance it actually
 * held (zero) and gets one step of credit for the new money — 16.7%, not the
 * 66.5% a single-balance catch-up would grant. A genuine holder passes
 * before == after and is unaffected, which is why every pinned convergence vector
 * is unchanged.
 *
 * The cap is the escape hatch #26 demands: a missed epoch costs convergence
 * speed, never access. `catchUpCap` is a parameter — bounding ExUnits is decided,
 * the number is not. Nothing bounds the cap itself, so when việc 3 wires this into
 * a validator the cap must be a compile-time constant, never redeemer- or
 * datum-sourced.
 */
export function emaCatchUp(
  emaQ: bigint,
  balanceBefore: bigint,
  balanceAfter: bigint,
  epochsElapsed: bigint,
  catchUpCap: bigint,
): bigint {
  const steps = imin(imax(0n, epochsElapsed), imax(0n, catchUpCap));
  if (steps <= 0n) return emaQ;
  let e = emaQ;
  for (let i = 1n; i < steps; i++) e = emaStep(e, balanceBefore);
  return emaStep(e, balanceAfter);
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
 * CALLER CONTRACT — `consumedNanogic` is the total consumed in the TRAILING 6
 * EPOCHS, not lifetime. Spec §6.2 fixes the window as part of the mechanism; this
 * function cannot enforce it because it never sees an epoch. Pass lifetime
 * consumption and the heaviest weight in the system (0.90Q of 1.50Q) becomes a
 * one-off achievement that never decays. Việc 3 owns the windowing and owes a
 * decay vector when it lands.
 *
 * MVP: `did_commit = #""` ⟹ cross-DID attribution is uncomputable ⟹ callers pass
 * 0 and forfeit the whole 0.90Q weight. Ceiling drops 2.50× → 1.60×.
 */
export function consumedFactor(consumedNanogic: bigint, consumedRef: bigint): bigint {
  return ratioQ(consumedNanogic, consumedRef);
}

// offPeakFactor — DELIBERATELY ABSENT, callers pass offPeakR = 0 in MVP.
//
// What used to live here was `(loadRef − networkLoad) / loadRef`: network-wide
// load headroom, with no user argument at all. Same number for everybody, so 0.25Q
// — a sixth of the whole range — was a flat constant added to every vault. Worse
// than off, because it reads as implemented.
//
// Spec §6.2 wants the share of THIS user's consumption that happened off-peak,
// labelled from the published service price (`demand_mult` in ConsumeMAGIC's
// PriceParam beacon — an existing reference input, not a metric to invent):
//
//     offPeakFactor(consumedOffpeakNanogic, consumedTotalNanogic)
//
// Both per-user, so there is no loadRef to choose. Restore in việc 3; until then
// 0.25Q is unreachable and the MVP ceiling is 1.35×, not 1.60×.

/**
 * KNOWN GAP (việc 3, INV-CONSUMED-ATTRIB): whichever reference wins, this is
 * per-VAULT, and splitting a balance across n vaults is nearly free on Cardano —
 * 100 wallets each locking 100% of a small balance score 100% on every one. The
 * fix is the DID aggregation consumedFactor also needs.
 */
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
 * AND IF YOU DO ADD ONE: the max() alone is not enough. `weighted / Q` below is
 * the second place a negative numerator would meet Aiken's floor division and
 * TypeScript's truncation and get two different answers (weighted = −1 ⟹ Aiken
 * −1, TS 0), with nothing clamping afterwards. Relaxing clampQ owes this line a
 * decision and a negative vector, exactly as emaStep already has.
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
