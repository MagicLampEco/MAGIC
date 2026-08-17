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
  consumedFactor, commitFactor, eligibilityQ,
  qToMultiplierStr,
} from "../offchain/src/eligibility.js";
import {
  TV_ELIG_WEIGHTS, TV_ELIG_MVP_CEILING, TV_ELIG_MVP_CEILING_TODAY,
  TV_ELIG_EMA_CONVERGENCE, TV_ELIG_EMA_FALLING, TV_ELIG_AGE_LAUNDER,
  CANDIDATE_SETS, PROFILES,
} from "./vectors.js";

/** A vault that updates every epoch takes n single steps — NOT one n-step catch-up. */
function ageAfterEpochs(balance: bigint, epochs: bigint, cap: bigint): bigint {
  let ema = 0n;
  for (let i = 0n; i < epochs; i++) ema = emaCatchUp(ema, balance, balance, 1n, cap);
  return ageFactor(ema, balance);
}

/**
 * A vault that sleeps through those epochs and does ONE catch-up at the end. This
 * is the reading `catch_up_cap` actually binds on — `ageAfterEpochs` above applies
 * one step at a time, so min(1, cap) is 1 for every cap ≥ 1 and the parameter is
 * invisible there. The payoff table prints both.
 */
function ageAfterOneCatchUp(balance: bigint, epochs: bigint, cap: bigint): bigint {
  return ageFactor(emaCatchUp(0n, balance, balance, epochs, cap), balance);
}

/**
 * Illustrative reward, spec §6.3: `reward = ⌊g(consumed) × eligibility / Q⌋`.
 *
 * `g` itself belongs to việc 3 and is NOT decided here; this uses the spec's
 * CEILING `g(c) ≤ 0.4·c` so the column shows the largest reward any admissible
 * slope could pay. It is here because eligibility is a MULTIPLIER on g, and
 * g(0) = 0 — a table of multipliers alone reads backwards, since a profile that
 * consumes nothing shows a high multiplier and collects zero.
 */
function illustrativeReward(consumedNanogic: bigint, eligQ: bigint): bigint {
  const g = 4n * consumedNanogic / 10n;
  return g * eligQ / Q;
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

  it("TV-ELIG-MVP-CEILING-TODAY: consumed AND off-peak OFF ⟹ 1.35×", () => {
    const t = TV_ELIG_MVP_CEILING_TODAY;
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

  // An unconfigured reference must FAIL CLOSED. Under the old `max(1, ·)` form
  // every one of these returned Q, so an unset parameter paid the full weight.
  it("ratioQ: an unset reference earns nothing, and never divides by zero", () => {
    expect(ratioQ(1n, 0n)).toBe(0n);
    expect(ratioQ(0n, 0n)).toBe(0n);
    expect(ratioQ(1_000_000_000n, 0n)).toBe(0n);
    expect(ratioQ(1n, -5n)).toBe(0n);
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

  // The cap MUST bind on a one-shot catch-up, and MUST NOT bind on a vault that
  // updates every epoch. Nothing tested this before, so cap = 6 and cap = 10000
  // produced byte-identical payoff tables and the parameter was proposed on
  // evidence that could not see it.
  it("TV-ELIG-EMA-CONVERGENCE: catch_up_cap binds on one-shot catch-up only", () => {
    const t = TV_ELIG_EMA_CONVERGENCE;
    for (const c of t.cases) {
      expect(ageAfterOneCatchUp(t.lamp_balance, c.epochs, t.catch_up_cap), `n=${c.epochs}`)
        .toBe(c.one_shot_cap6_q);
      // Every-epoch updating is cap-insensitive: same number at 1, 6 and 10000.
      expect(ageAfterEpochs(t.lamp_balance, c.epochs, 1n)).toBe(c.age_factor_q);
      expect(ageAfterEpochs(t.lamp_balance, c.epochs, 10_000n)).toBe(c.age_factor_q);
    }
    // 24 epochs of the same tenure: 98.7% updating every epoch, 66.5% in one shot.
    expect(ageAfterEpochs(t.lamp_balance, 24n, 6n))
      .toBeGreaterThan(ageAfterOneCatchUp(t.lamp_balance, 24n, 6n));
  });

  // P8 TEETH ON THE EMA FORM. Every other vector starts at ema = 0 with a flat or
  // rising balance, where the shipped form and the `e + (x−e)·α` form the issue
  // proposed are bit-identical — so the choice between them was untested and a
  // regression to the rejected form passed the whole suite. They separate only on
  // a FALLING balance, and the rejected form drifts UP.
  it("TV-ELIG-EMA-FALLING: the EMA form is pinned where the two forms differ", () => {
    const t = TV_ELIG_EMA_FALLING;
    let e = t.ema_start_q;
    for (let i = 0n; i < t.steps; i++) e = emaStep(e, t.balance_after);
    expect(e).toBe(t.ema_q);

    // Same walk under the rejected form, to prove the vector actually separates
    // them rather than being a number both happen to produce.
    let r = t.ema_start_q;
    for (let i = 0n; i < t.steps; i++) r = r + (t.balance_after * Q - r) * ALPHA_AGE_Q / Q;
    expect(r).toBe(t.rejected_form_would_give);
    expect(r).toBeGreaterThan(e);
  });

  // P8 on the negative domain. `emaQ` is a datum field, so a caller can present it
  // negative; unclamped, Aiken floors (-5 → -5) where TS truncates (→ -4), the two
  // sides write different datums and the vault desynchronises permanently.
  it("emaStep clamps negative inputs, so the two sides cannot diverge", () => {
    expect(emaStep(-1n, 0n)).toBe(0n);
    expect(emaStep(-5n, 0n)).toBe(0n);
    expect(emaStep(1n, -1n)).toBe(0n);
    expect(emaStep(-1_000_000n * Q, 0n)).toBe(0n);
  });

  // TV-ELIG-AGE-LAUNDER — why emaCatchUp takes before AND after.
  it("TV-ELIG-AGE-LAUNDER: a deposit after idle epochs earns one step, not a catch-up", () => {
    const t = TV_ELIG_AGE_LAUNDER;
    expect(ageFactor(
      emaCatchUp(0n, t.balance_before, t.balance_after, t.epochs_elapsed, t.catch_up_cap),
      t.balance_after,
    )).toBe(t.age_factor_q);

    // What the old single-balance signature paid for holding nothing.
    expect(ageFactor(
      emaCatchUp(0n, t.balance_after, t.balance_after, t.epochs_elapsed, t.catch_up_cap),
      t.balance_after,
    )).toBe(t.single_balance_signature_would_give);
  });

  // After a withdrawal the EMA sits ABOVE the balance. What remains is fully
  // aged, so r = Q — not something above Q. This is what the min() is for.
  it("After a withdrawal the factor caps at Q", () => {
    expect(ageFactor(1_000_000n * Q, 100_000n)).toBe(Q);
  });

  // THE ESCAPE HATCH (#26): a missed epoch costs convergence speed, never access.
  it("Catch-up is capped, and skipping epochs is never fatal", () => {
    const b = 1_000_000n;
    expect(emaCatchUp(0n, b, b, 10_000n, 6n)).toBe(emaCatchUp(0n, b, b, 6n, 6n));
    expect(ageFactor(emaCatchUp(0n, b, b, 10_000n, 6n), b)).toBeGreaterThan(0n);
  });

  it("Zero / negative elapsed and zero cap are all no-ops", () => {
    const b = 1_000_000n;
    expect(emaCatchUp(12_345n, b, b, 0n, 6n)).toBe(12_345n);
    expect(emaCatchUp(12_345n, b, b, -5n, 6n)).toBe(12_345n);
    expect(emaCatchUp(12_345n, b, b, 10n, 0n)).toBe(12_345n);
  });

  it("An empty vault has no age and does not divide by zero", () => {
    expect(ageFactor(0n, 0n)).toBe(0n);
  });

  // C-OVERFLOW: 10^15 oildrop × Q = 10^24, far past Number's 2^53. The expected
  // value is a LITERAL, not the implementation's own expression recomputed on the
  // right-hand side — the earlier version was a tautology that would have passed
  // unchanged had emaStep applied α to the wrong term. Mirrored by
  // ema_overflow_keeps_every_digit in math.ak.
  it("TV-OVERFLOW: a 10^15 oildrop balance keeps every digit", () => {
    const huge = 1_000_000_000_000_000n;
    expect(emaStep(0n, huge)).toBe(166_666_666_000_000_000_000_000n);
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

  // offPeakFactor is gone, not renamed — see the note in eligibility.ts. Callers
  // pass 0, so its 0.25Q is simply unreachable and the ceiling that ships is 1.35×.
  it("offPeakFactor is not exported: the factor is off, not approximated", async () => {
    const mod = await import("../offchain/src/eligibility.js");
    expect("offPeakFactor" in mod).toBe(false);
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

describe("PAYOFF TABLE — five profiles × four candidate sets", () => {
  /** Every number the table prints for one (profile, set) pair. */
  function row(p: typeof PROFILES[number], set: typeof CANDIDATE_SETS[number]) {
    const age = ageAfterEpochs(p.lamp_balance, p.epochs_held, set.catch_up_cap);
    const age1 = ageAfterOneCatchUp(p.lamp_balance, p.epochs_held, set.catch_up_cap);
    const con = consumedFactor(p.consumed_nanogic, set.consumed_ref);
    const comRef = set.commit_ref_mode === "relative_to_balance"
      ? p.lamp_balance : set.commit_ref;
    const com = commitFactor(p.lamp_locked, comRef);
    // off-peak is 0 for everyone: the factor is off (eligibility.ts).
    const mvp = eligibilityQ(age, 0n, 0n, com);   // did_commit = #"" ⟹ consumed OFF
    const full = eligibilityQ(age, con, 0n, com);
    return {
      age, age1, con, com, mvp, full,
      rewardMvp: illustrativeReward(p.consumed_nanogic, mvp),
      rewardFull: illustrativeReward(p.consumed_nanogic, full),
    };
  }

  it("emits the table for PR review", () => {
    const lines: string[] = [];
    const pad = (s: string, n: number) => s.padEnd(n);
    const pct = (v: bigint) => `${(v * 100n / Q).toString()}%`;
    const magic = (nanogic: bigint) => `${nanogic / 1_000_000_000n}`;

    for (const set of CANDIDATE_SETS) {
      lines.push("");
      lines.push(`━━━ ${set.name} ━━━  consumed_ref=${set.consumed_ref / 1_000_000_000n} MAGIC · ` +
                 `commit=${set.commit_ref_mode === "relative_to_balance" ? "fraction of balance" : `${set.commit_ref / 1_000_000n} LAMP`} · cap=${set.catch_up_cap}`);
      lines.push(`    ${set.rationale}`);
      lines.push("");
      lines.push(`    ${pad("profile", 28)}${pad("age", 8)}${pad("age¹", 8)}${pad("consum", 8)}${pad("commit", 8)}${pad("MVP", 10)}${pad("full", 10)}${pad("rwd·MVP", 9)}rwd·full`);
      lines.push(`    ${"-".repeat(28 + 8 * 4 + 10 * 2 + 9 + 8)}`);

      for (const p of PROFILES) {
        const r = row(p, set);
        lines.push(
          `    ${pad(p.name, 28)}${pad(pct(r.age), 8)}${pad(pct(r.age1), 8)}${pad(pct(r.con), 8)}` +
          `${pad(pct(r.com), 8)}${pad(qToMultiplierStr(r.mvp), 10)}${pad(qToMultiplierStr(r.full), 10)}` +
          `${pad(magic(r.rewardMvp), 9)}${magic(r.rewardFull)}`,
        );
      }
    }
    lines.push("");
    lines.push("    age   = vault updates EVERY epoch (cap never binds)");
    lines.push("    age¹  = vault sleeps, ONE catch-up at the end (cap binds — this is what picks cap)");
    lines.push("    rwd   = ⌊0.4·consumed × eligibility / Q⌋ in MAGIC — spec §6.3 CEILING slope, illustrative only.");
    lines.push("            eligibility MULTIPLIES g(consumed), and g(0) = 0: read this column, not the multiplier.");
    lines.push("    offpk = 0 for every row, factor is off — no column printed rather than a fake one.");
    lines.push("");
    console.log(lines.join("\n"));
  });

  // The table must SEPARATE people, on the path that actually ships. The old
  // assertion ran on `full`, which is the path MVP does not have — a total MVP
  // degeneracy passed it silently, and MVP degeneracy was the PR's own headline
  // claim. Assert both.
  it("both MVP and full separate the profiles", () => {
    for (const set of CANDIDATE_SETS) {
      const mvps = PROFILES.map(p => String(row(p, set).mvp));
      const fulls = PROFILES.map(p => String(row(p, set).full));
      expect(new Set(mvps).size, `${set.name} MVP`).toBeGreaterThan(1);
      expect(new Set(fulls).size, `${set.name} full`).toBeGreaterThan(1);
    }
  });

  // The correction that mattered most in review: eligibility is a MULTIPLIER on
  // g(consumed), and g(0) = 0. Reading the multiplier column alone says the
  // passive holder (profile 4) and the whale (profile 5) out-earn the consumer
  // (profile 3) in MVP. At reward level they earn nothing at all.
  it("consuming nothing pays nothing, whatever the multiplier says", () => {
    const set = CANDIDATE_SETS[1]!;
    const consumer = row(PROFILES[2]!, set);   // 3 · tiêu mới
    const passive = row(PROFILES[3]!, set);    // 4 · giữ lâu, không tiêu
    const whale = row(PROFILES[4]!, set);      // 5 · cá voi, khoá 1%

    // The multiplier really does rank them backwards — that part of the finding stands.
    expect(passive.mvp).toBeGreaterThan(consumer.mvp);
    expect(whale.mvp).toBeGreaterThan(consumer.mvp);

    // The reward does not, and the reward is what ships.
    expect(passive.rewardMvp).toBe(0n);
    expect(whale.rewardMvp).toBe(0n);
    expect(consumer.rewardMvp).toBeGreaterThan(0n);
  });
});
