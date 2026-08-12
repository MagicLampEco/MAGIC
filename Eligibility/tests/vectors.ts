// tests/vectors.ts — NORMATIVE vectors for eligibility (spec §6.2)
//
// Two kinds of thing live here, and they are NOT the same:
//
//   DECIDED   — pinned values that both implementations must reproduce exactly.
//               Changing one of these is a protocol change.
//   CANDIDATE — normalisation references nobody has committed to. #26 says to
//               present them at PR and let review choose. They are inputs to the
//               payoff table, never assertions.

export const Q = 1_000_000_000n;
export const OILDROP_PER_LAMP = 1_000_000n;
export const NANOGIC_PER_MAGIC = 1_000_000_000n;

const LAMP = (n: bigint) => n * OILDROP_PER_LAMP;
const MAGIC = (n: bigint) => n * NANOGIC_PER_MAGIC;

// ══════════════════════════════════════════════════════════════
// DECIDED — spec §6.2
// ══════════════════════════════════════════════════════════════

export const TV_ELIG_WEIGHTS = {
  id: "TV-ELIG-WEIGHTS",
  spec_ref: "§6.2",
  description: "Σ weights = 1.5Q ⟹ eligibility ∈ [1.00×, 2.50×]",
  w_age: 150_000_000n,
  w_consumed: 900_000_000n,
  w_offpeak: 250_000_000n,
  w_commit: 200_000_000n,
  sum: 1_500_000_000n,
  floor_q: 1_000_000_000n, // all factors 0
  ceiling_q: 2_500_000_000n, // all factors Q
};

/** MVP ceiling: did_commit = #"" ⟹ consumedFactor is OFF ⟹ 0.90Q unreachable. */
export const TV_ELIG_MVP_CEILING = {
  id: "TV-ELIG-MVP-CEILING",
  spec_ref: "§6.2 + §6.3 INV-CONSUMED-ATTRIB",
  description: "Without cross-DID consumed, the ceiling is 1.60× not 2.50×",
  age_r: Q,
  consumed_r: 0n,
  off_peak_r: Q,
  commit_r: Q,
  eligibility_q: 1_600_000_000n,
};

/**
 * EMA convergence from an empty vault at a constant balance, α = 1/6.
 *
 * These are NOT 1 − (5/6)^n. Two things pull them below the analytic curve, and
 * both are deliberate:
 *   - α is stored as ⌊Q/6⌋ = 166_666_666, very slightly under 1/6
 *   - every step floors, so the shortfall compounds across steps
 * n=6 lands on 665_102_021 where the analytic value rounds to 665_102_022. The
 * gap is one part in 10^9 and it is the IMPLEMENTATION that is normative — an
 * Aiken and a TS side that both floor identically are worth more than either one
 * matching a real-number ideal. Recompute from the code if α ever changes; do
 * not "correct" these toward the analytic values.
 */
export const TV_ELIG_EMA_CONVERGENCE = {
  id: "TV-ELIG-EMA-CONVERGENCE",
  spec_ref: "§6.2 ageFactor",
  description: "ageFactor after n single-epoch steps of a flat balance, from ema = 0",
  alpha_q: 166_666_666n,
  lamp_balance: LAMP(1000n),
  cases: [
    { epochs: 1n, age_factor_q: 166_666_666n },
    { epochs: 6n, age_factor_q: 665_102_021n },
    { epochs: 12n, age_factor_q: 887_843_344n },
    { epochs: 24n, age_factor_q: 987_420_884n },
  ],
};

// ══════════════════════════════════════════════════════════════
// CANDIDATE — for review to choose. NOT assertions.
// ══════════════════════════════════════════════════════════════
//
// Each set fixes the three normalisation references and the EMA catch-up cap.
// The spread between them is deliberate: A saturates easily (most users sit at
// the ceiling, the factor stops discriminating), C almost never saturates (the
// factor is effectively dead weight for ordinary users). B is the middle.

export interface CandidateSet {
  name: string;
  rationale: string;
  consumed_ref: bigint; // nanogic of MAGIC consumed that counts as "fully consuming"
  commit_ref: bigint; // oildrop locked that counts as "fully committed"
  load_ref: bigint; // network load that counts as "fully at peak"
  catch_up_cap: bigint; // max EMA steps applied in one update
  /**
   * How commit_ref is read. This is a genuine design fork, not a tuning knob:
   *   "absolute"            — a fixed oildrop bar. A whale clears it with a
   *                           rounding error of their balance, so commitFactor
   *                           becomes free money for size.
   *   "relative_to_balance" — the bar IS the balance, so the factor measures the
   *                           FRACTION committed and costs a whale exactly what
   *                           it costs a small vault. commit_ref is then unused.
   */
  commit_ref_mode: "absolute" | "relative_to_balance";
}

export const CANDIDATE_SETS: CandidateSet[] = [
  {
    name: "A · lenient",
    rationale: "Low bars. Most active users saturate, so the factors stop separating anyone.",
    consumed_ref: MAGIC(10n),
    commit_ref: LAMP(100n),
    load_ref: 1000n,
    catch_up_cap: 6n,
    commit_ref_mode: "absolute",
  },
  {
    name: "B · balanced",
    rationale: "Bars near the NEWUSER grant (1001 LAMP). Ordinary users land mid-range.",
    consumed_ref: MAGIC(100n),
    commit_ref: LAMP(1000n),
    load_ref: 1000n,
    catch_up_cap: 6n,
    commit_ref_mode: "absolute",
  },
  {
    name: "C · strict",
    rationale: "High bars. Only whales move the needle; small vaults see ~1.0× regardless.",
    consumed_ref: MAGIC(1000n),
    commit_ref: LAMP(10_000n),
    load_ref: 1000n,
    catch_up_cap: 6n,
    commit_ref_mode: "absolute",
  },
  {
    name: "B-rel · balanced, commit relative",
    rationale: "Same as B, but commitFactor measures the FRACTION of the balance locked. Tests whether an absolute commit bar is just a whale subsidy.",
    consumed_ref: MAGIC(100n),
    commit_ref: 0n, // unused in relative mode
    load_ref: 1000n,
    catch_up_cap: 6n,
    commit_ref_mode: "relative_to_balance",
  },
];

// ══════════════════════════════════════════════════════════════
// The four payoff profiles #26 asks to see
// ══════════════════════════════════════════════════════════════
//
// Balances are in oildrop. The NEWUSER channel grants DID × 1001 LAMP, so 1001
// LAMP is the reference "ordinary user" size; the speculator is deliberately 10×
// that to test whether raw size can outrun tenure.
//
// network_load is held equal across profiles on purpose: off-peak is a choice of
// WHEN to generate, not a property of who you are. Holding it constant keeps the
// table about identity, and makes offPeakFactor a visible common offset rather
// than noise.

export interface Profile {
  name: string;
  blurb: string;
  lamp_balance: bigint;
  epochs_held: bigint; // consecutive epochs the balance has been flat
  consumed_nanogic: bigint;
  lamp_locked: bigint;
  network_load: bigint;
}

export const PROFILES: Profile[] = [
  {
    name: "1 · giữ LAMP lâu + có tiêu",
    blurb: "Tenured, consumes, some commitment — the behaviour the design wants",
    lamp_balance: LAMP(1001n),
    epochs_held: 24n,
    consumed_nanogic: MAGIC(50n),
    lamp_locked: LAMP(300n),
    network_load: 500n,
  },
  {
    name: "2 · đầu cơ",
    blurb: "10× the balance, deposited this epoch, consumes nothing, commits nothing",
    lamp_balance: LAMP(10_010n),
    epochs_held: 1n,
    consumed_nanogic: 0n,
    lamp_locked: 0n,
    network_load: 500n,
  },
  {
    name: "3 · tiêu mới",
    blurb: "Fresh balance but consuming heavily — the cohort NEWUSER is meant to grow",
    lamp_balance: LAMP(1001n),
    epochs_held: 1n,
    consumed_nanogic: MAGIC(200n),
    lamp_locked: 0n,
    network_load: 500n,
  },
  {
    name: "4 · giữ lâu, không tiêu",
    blurb: "Tenured but purely passive — the free-rider case",
    lamp_balance: LAMP(1001n),
    epochs_held: 24n,
    consumed_nanogic: 0n,
    lamp_locked: 0n,
    network_load: 500n,
  },
  // Not one of the four #26 names — added because B and B-rel are
  // indistinguishable on profiles 1-4 (commit_ref happens to sit near the
  // ordinary balance, so absolute and relative agree by coincidence). This whale
  // locks 1% of its balance, which clears an ABSOLUTE 1000-LAMP bar outright
  // while a RELATIVE bar reads it for what it is. Without this row the
  // absolute-vs-relative fork looks like it does not matter.
  {
    name: "5 · cá voi, khoá 1%",
    blurb: "100k LAMP, locks 1000 LAMP — buys commitFactor with pocket change",
    lamp_balance: LAMP(100_000n),
    epochs_held: 24n,
    consumed_nanogic: 0n,
    lamp_locked: LAMP(1000n),
    network_load: 500n,
  },
];
