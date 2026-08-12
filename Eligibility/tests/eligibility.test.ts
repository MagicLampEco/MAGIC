// tests/eligibility.test.ts — eligibility math, normative vectors, payoff table
//
// Split by intent:
//   "DECIDED"  asserts. These pin protocol behaviour and mirror the Aiken tests
//              in onchain/lib/magiclamp/eligibility/math.ak one-for-one (P8).
//   "PAYOFF"   prints. #26 wants to SEE the four profiles before anyone fixes the
//              normalisation constants, so this run emits a table rather than
//              asserting values nobody has agreed to yet.

import { describe, it, expect } from "vitest";
import {
  Q, W_AGE, W_CONSUMED, W_OFFPEAK, W_COMMIT, ALPHA_AGE_Q,
  clampQ, ratioQ, emaStep, emaCatchUp, ageFactor,
  consumedFactor, offPeakFactor, commitFactor, eligibilityQ,
  qToMultiplierStr,
} from "../offchain/src/eligibility.js";
import {
  TV_ELIG_WEIGHTS, TV_ELIG_MVP_CEILING, TV_ELIG_EMA_CONVERGENCE,
  CANDIDATE_SETS, PROFILES,
} from "./vectors.js";

/** A vault that updates every epoch takes n single steps — NOT one n-step catch-up. */
function ageAfterEpochs(balance: bigint, epochs: bigint, cap: bigint): bigint {
  let ema = 0n;
  for (let i = 0n; i < epochs; i++) ema = emaCatchUp(ema, balance, 1n, cap);
  return ageFactor(ema, balance);
}

// ══════════════════════════════════════════════════════════════
// DECIDED — composition
// ══════════════════════════════════════════════════════════════

describe("eligibilityQ — composition (§6.2)", () => {
  it("TV-ELIG-WEIGHTS: weights sum to 1.5Q, range is [1.00×, 2.50×]", () => {
    const t = TV_ELIG_WEIGHTS;
    expect(W_AGE).toBe(t.w_age);
    expect(W_CONSUMED).toBe(t.w_consumed);
    expect(W_OFFPEAK).toBe(t.w_offpeak);
    expect(W_COMMIT).toBe(t.w_commit);
    expect(W_AGE + W_CONSUMED + W_OFFPEAK + W_COMMIT).toBe(t.sum);
    expect(eligibilityQ(0n, 0n, 0n, 0n)).toBe(t.floor_q);
    expect(eligibilityQ(Q, Q, Q, Q)).toBe(t.ceiling_q);
  });

  // Clamp happens BEFORE weighting. Without it this returns 16.0×.
  it("A factor above Q buys its weight, not a multiple of it", () => {
    expect(eligibilityQ(10n * Q, 10n * Q, 10n * Q, 10n * Q)).toBe(2_500_000_000n);
  });

  // A negative factor must not cancel another term's earnings.
  it("A negative factor cannot subtract", () => {
    expect(eligibilityQ(-10n * Q, Q, 0n, 0n)).toBe(Q + W_CONSUMED);
  });

  // Catches a wire-up swap between two factors, which an all-max test cannot see.
  it("Each weight is individually addressable", () => {
    expect(eligibilityQ(Q, 0n, 0n, 0n)).toBe(Q + W_AGE);
    expect(eligibilityQ(0n, Q, 0n, 0n)).toBe(Q + W_CONSUMED);
    expect(eligibilityQ(0n, 0n, Q, 0n)).toBe(Q + W_OFFPEAK);
    expect(eligibilityQ(0n, 0n, 0n, Q)).toBe(Q + W_COMMIT);
  });

  it("TV-ELIG-MVP-CEILING: consumed OFF ⟹ 1.60×, not 2.50×", () => {
    const t = TV_ELIG_MVP_CEILING;
    expect(eligibilityQ(t.age_r, t.consumed_r, t.off_peak_r, t.commit_r))
      .toBe(t.eligibility_q);
  });
});

// ══════════════════════════════════════════════════════════════
// DECIDED — clamping and normalisation shape
// ══════════════════════════════════════════════════════════════

describe("clampQ / ratioQ", () => {
  it("clampQ bounds to [0, Q]", () => {
    expect(clampQ(-1n)).toBe(0n);
    expect(clampQ(0n)).toBe(0n);
    expect(clampQ(Q)).toBe(Q);
    expect(clampQ(Q + 1n)).toBe(Q);
  });

  it("ratioQ: half, saturation, floor", () => {
    expect(ratioQ(50n, 100n)).toBe(Q / 2n);
    expect(ratioQ(500n, 100n)).toBe(Q);
    expect(ratioQ(-500n, 100n)).toBe(0n);
    expect(ratioQ(0n, 100n)).toBe(0n);
  });

  // A zero reference means "no bar to clear" — it must not divide by zero.
  it("ratioQ: zero reference is fully satisfied, not a crash", () => {
    expect(ratioQ(1n, 0n)).toBe(Q);
  });
});

// ══════════════════════════════════════════════════════════════
// DECIDED — ageFactor / EMA
// ══════════════════════════════════════════════════════════════

describe("ageFactor — EMA of the balance, α = 1/6", () => {
  it("α is Q/6 floored", () => {
    expect(ALPHA_AGE_Q).toBe(Q / 6n);
  });

  it("A flat balance is a fixed point and reads as fully aged", () => {
    const b = 1_000_000n;
    expect(emaStep(b * Q, b)).toBe(b * Q);
    expect(ageFactor(b * Q, b)).toBe(Q);
  });

  it("A fresh deposit is not aged — one step is ~16.67%", () => {
    const b = 1_000_000n;
    expect(ageFactor(emaStep(0n, b), b)).toBe(166_666_666n);
  });

  it("TV-ELIG-EMA-CONVERGENCE: pinned curve, P8 with math.ak", () => {
    const t = TV_ELIG_EMA_CONVERGENCE;
    for (const c of t.cases) {
      expect(ageAfterEpochs(t.lamp_balance, c.epochs, 12n), `n=${c.epochs}`)
        .toBe(c.age_factor_q);
    }
  });

  // After a withdrawal the EMA sits ABOVE the balance. What remains is fully
  // aged, so r = Q — not something above Q. This is what the min() is for.
  it("After a withdrawal the factor caps at Q", () => {
    expect(ageFactor(1_000_000n * Q, 100_000n)).toBe(Q);
  });

  // THE ESCAPE HATCH (#26): a missed epoch costs convergence speed, never access.
  it("Catch-up is capped, and skipping epochs is never fatal", () => {
    const b = 1_000_000n;
    expect(emaCatchUp(0n, b, 10_000n, 6n)).toBe(emaCatchUp(0n, b, 6n, 6n));
    expect(ageFactor(emaCatchUp(0n, b, 10_000n, 6n), b)).toBeGreaterThan(0n);
  });

  it("Zero / negative elapsed and zero cap are all no-ops", () => {
    expect(emaCatchUp(12_345n, 1_000_000n, 0n, 6n)).toBe(12_345n);
    expect(emaCatchUp(12_345n, 1_000_000n, -5n, 6n)).toBe(12_345n);
    expect(emaCatchUp(12_345n, 1_000_000n, 10n, 0n)).toBe(12_345n);
  });

  it("An empty vault has no age and does not divide by zero", () => {
    expect(ageFactor(0n, 0n)).toBe(0n);
  });

  // C-OVERFLOW: 10^15 oildrop × Q = 10^24, far past Number's 2^53. If this ever
  // gets rewritten with Number, the low digits vanish silently and this fails.
  it("TV-OVERFLOW: a 10^15 oildrop balance keeps every digit", () => {
    const huge = 1_000_000_000_000_000n;
    expect(emaStep(0n, huge)).toBe(ALPHA_AGE_Q * huge * Q / Q);
    expect(ageFactor(huge * Q, huge)).toBe(Q);
  });
});

// ══════════════════════════════════════════════════════════════
// DECIDED — the three parameterised factors
// ══════════════════════════════════════════════════════════════

describe("consumed / offPeak / commit factors", () => {
  it("consumedFactor is 0 in MVP (did_commit = empty)", () => {
    expect(consumedFactor(0n, 1_000_000_000n)).toBe(0n);
  });

  it("consumedFactor saturates at the reference", () => {
    expect(consumedFactor(2_000_000_000n, 1_000_000_000n)).toBe(Q);
  });

  it("offPeakFactor: idle = Q, at reference = 0, above reference floors at 0", () => {
    expect(offPeakFactor(0n, 100n)).toBe(Q);
    expect(offPeakFactor(50n, 100n)).toBe(Q / 2n);
    expect(offPeakFactor(100n, 100n)).toBe(0n);
    expect(offPeakFactor(1_000_000n, 100n)).toBe(0n);
  });

  it("commitFactor scales with the lock", () => {
    expect(commitFactor(0n, 1000n)).toBe(0n);
    expect(commitFactor(500n, 1000n)).toBe(Q / 2n);
    expect(commitFactor(1000n, 1000n)).toBe(Q);
  });
});

// ══════════════════════════════════════════════════════════════
// PAYOFF — prints, does not assert
// ══════════════════════════════════════════════════════════════

describe("PAYOFF TABLE — four profiles × three candidate sets", () => {
  it("emits the table for PR review", () => {
    const lines: string[] = [];
    const pad = (s: string, n: number) => s.padEnd(n);

    for (const set of CANDIDATE_SETS) {
      lines.push("");
      lines.push(`━━━ ${set.name} ━━━  consumed_ref=${set.consumed_ref / 1_000_000_000n} MAGIC · ` +
                 `commit=${set.commit_ref_mode === "relative_to_balance" ? "fraction of balance" : `${set.commit_ref / 1_000_000n} LAMP`} · load_ref=${set.load_ref} · cap=${set.catch_up_cap}`);
      lines.push(`    ${set.rationale}`);
      lines.push("");
      lines.push(`    ${pad("profile", 28)}${pad("age", 9)}${pad("consum", 9)}${pad("offpk", 9)}${pad("commit", 9)}${pad("MVP", 10)}full`);
      lines.push(`    ${"-".repeat(28 + 9 * 4 + 10 + 6)}`);

      for (const p of PROFILES) {
        const age = ageAfterEpochs(p.lamp_balance, p.epochs_held, set.catch_up_cap);
        const con = consumedFactor(p.consumed_nanogic, set.consumed_ref);
        const off = offPeakFactor(p.network_load, set.load_ref);
        const comRef = set.commit_ref_mode === "relative_to_balance"
          ? p.lamp_balance : set.commit_ref;
        const com = commitFactor(p.lamp_locked, comRef);

        const mvp  = eligibilityQ(age, 0n, off, com);   // did_commit = #"" ⟹ consumed OFF
        const full = eligibilityQ(age, con, off, com);

        const pct = (v: bigint) => `${(v * 100n / Q).toString()}%`;
        lines.push(
          `    ${pad(p.name, 28)}${pad(pct(age), 9)}${pad(pct(con), 9)}${pad(pct(off), 9)}` +
          `${pad(pct(com), 9)}${pad(qToMultiplierStr(mvp), 10)}${qToMultiplierStr(full)}`,
        );
      }
    }
    lines.push("");
    console.log(lines.join("\n"));

    // The only thing asserted here is that the table is meaningful at all: if
    // every profile lands on the same number, the factors are not separating
    // anyone and the constants are wrong regardless of which set won.
    const set = CANDIDATE_SETS[1]!;
    const fulls = PROFILES.map(p => eligibilityQ(
      ageAfterEpochs(p.lamp_balance, p.epochs_held, set.catch_up_cap),
      consumedFactor(p.consumed_nanogic, set.consumed_ref),
      offPeakFactor(p.network_load, set.load_ref),
      commitFactor(p.lamp_locked,
        set.commit_ref_mode === "relative_to_balance" ? p.lamp_balance : set.commit_ref),
    ));
    expect(new Set(fulls.map(String)).size).toBeGreaterThan(1);
  });
});
