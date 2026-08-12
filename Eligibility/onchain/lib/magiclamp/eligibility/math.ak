// lib/eligibility/math.ak — GenMAGIC eligibility, PURE MATH (spec §6.2)
//
// SCOPE: math + vectors only. No validator, no datum, no tx logic — #26 việc 2
// asks for the numbers to be settled before anything is enforced on-chain.
//
// WHAT IS DECIDED (spec) and hard-coded here:
//   - the composition and the four weights (Σ = 1.5Q)
//   - the ageFactor MECHANISM: an EMA of the vault balance with α = 1/6
//
// WHAT IS NOT DECIDED and is therefore a PARAMETER, never a literal:
//   - the normalisation reference of consumedFactor / offPeakFactor / commitFactor
//   - the EMA catch-up cap
// #26: "Hằng số chuẩn hoá rᵢ và slope g trình ở PR để quyết, không tự chốt trong
// code." Anything you can pass in is a thing nobody has committed to yet. See
// Eligibility/PROPOSAL.md for candidate values and the four payoff profiles.
//
// P8: mirrored byte-for-byte by Eligibility/offchain/src/eligibility.ts.
// C-OVERFLOW: every quantity is an arbitrary-precision Int. Q = 10^9.

// ══════════════════════════════════════════════════════════════
// Constants — DECIDED
// ══════════════════════════════════════════════════════════════

pub const q: Int = 1_000_000_000

/// Weights, spec §6.2. Σ = 1.5Q ⟹ eligibility_q ∈ [Q, 2.5Q] = [1.00×, 2.50×].
pub const w_consumed: Int = 900_000_000

pub const w_offpeak: Int = 250_000_000

pub const w_commit: Int = 200_000_000

pub const w_age: Int = 150_000_000

/// EMA smoothing α = 1/6 in Q-format. Floor of Q/6, the same rounding style as
/// FlowRate's ALPHA_FAST_Q = Q/3 (commit 5292578d).
pub const alpha_age_q: Int = 166_666_666

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

pub fn imin(a: Int, b: Int) -> Int {
  if a < b {
    a
  } else {
    b
  }
}

pub fn imax(a: Int, b: Int) -> Int {
  if a > b {
    a
  } else {
    b
  }
}

/// Clamp to [0, Q]. Spec §6.2 requires EVERY rᵢ to be clamped BEFORE it is
/// weighted: a factor allowed past Q would buy more than its weight, and a
/// negative one would silently cancel another factor's earnings.
pub fn clamp_q(v: Int) -> Int {
  imax(0, imin(q, v))
}

/// The normalisation shape the undecided factors share:
///   r = clamp(0, Q, value × Q / reference)
/// `reference` is what nobody has fixed yet, so it is an argument. `max(1, ·)`
/// keeps a zero reference from dividing by zero; it yields r = Q, the safe
/// reading of "no bar to clear".
pub fn ratio_q(value: Int, reference: Int) -> Int {
  clamp_q(value * q / imax(1, reference))
}

// ══════════════════════════════════════════════════════════════
// ageFactor — EMA of the vault balance (mechanism DECIDED)
// ══════════════════════════════════════════════════════════════
//
// Measured by an EMA of the BALANCE, not by walking per-UTxO ages. Rationale
// (#26): per-UTxO is O(n) ExUnits, invites fragmentation attacks, collides with
// Consolidate, and lets age be laundered through vest_start_slot.
//
// `lamp_ema_q` is the EMA of (lamp_balance × Q) — Q-scaled so the ratio below
// lands in [0, Q] without a second scaling step.
//
// Form is FlowRate's, not the `ema + (x − ema)·α` written in the issue.
// Algebraically identical, but it never forms a negative intermediate, so floor
// division rounds the same way whether the balance rose or fell. `ema + (x−ema)·α`
// truncates toward zero on a falling balance and away from it on a rising one —
// a free upward drift for anyone who oscillates their balance.
pub fn ema_step(ema_q: Int, lamp_balance: Int) -> Int {
  ( alpha_age_q * ( lamp_balance * q ) + ( q - alpha_age_q ) * ema_q ) / q
}

/// Advance the EMA over `epochs_elapsed` epochs, applying at most `catch_up_cap`
/// steps.
///
/// The cap is what keeps a missed epoch from being fatal. #26 forbids rebuilding
/// the v0.2 shape where strict sequencing + a singleton beacon + no escape hatch
/// meant one skipped epoch killed an account permanently. Here a latecomer only
/// converges more slowly, and is never locked out.
///
/// catch_up_cap is a PARAMETER: bounding ExUnits is decided, the number is not.
pub fn ema_catch_up(
  ema_q: Int,
  lamp_balance: Int,
  epochs_elapsed: Int,
  catch_up_cap: Int,
) -> Int {
  let steps = imin(imax(0, epochs_elapsed), imax(0, catch_up_cap))
  ema_steps_rec(ema_q, lamp_balance, steps)
}

fn ema_steps_rec(ema_q: Int, lamp_balance: Int, steps: Int) -> Int {
  if steps <= 0 {
    ema_q
  } else {
    ema_steps_rec(ema_step(ema_q, lamp_balance), lamp_balance, steps - 1)
  }
}

/// ageFactor = min(ema_q, balance × Q) / max(1, balance)  ∈ [0, Q]
///
/// Reads as "what fraction of the current balance has actually been sitting
/// here". A fresh deposit leaves the EMA behind the balance ⟹ r < Q. A balance
/// held flat lets the EMA converge ⟹ r → Q. The min() handles a withdrawal,
/// where the EMA sits ABOVE the balance: the shrunken balance is fully aged, so
/// r = Q rather than something > Q.
pub fn age_factor(ema_q: Int, lamp_balance: Int) -> Int {
  clamp_q(imin(ema_q, lamp_balance * q) / imax(1, lamp_balance))
}

// ══════════════════════════════════════════════════════════════
// The three undecided factors — shape proposed, reference passed in
// ══════════════════════════════════════════════════════════════

/// consumedFactor — MAGIC this identity has actually consumed, cross-DID
/// (INV-CONSUMED-ATTRIB).
///
/// MVP: `did_commit = #""`, so cross-DID attribution cannot be computed and this
/// term is OFF — callers pass consumed = 0, which yields r = 0 and forfeits the
/// whole 0.90Q weight. That is the largest gap between MVP and full eligibility
/// (2.50× ceiling → 1.60×). Wire it up when a real did_commit ships.
pub fn consumed_factor(consumed_nanogic: Int, consumed_ref: Int) -> Int {
  ratio_q(consumed_nanogic, consumed_ref)
}

/// offPeakFactor — rewards generating while the network is quiet. Headroom below
/// the reference load, normalised by that same reference.
pub fn off_peak_factor(network_load: Int, load_ref: Int) -> Int {
  ratio_q(imax(0, load_ref - network_load), load_ref)
}

/// commitFactor — how much the user has put under commitment (ScheduleGen locks)
/// against the reference that counts as fully committed.
pub fn commit_factor(lamp_locked: Int, commit_ref: Int) -> Int {
  ratio_q(lamp_locked, commit_ref)
}

// ══════════════════════════════════════════════════════════════
// Composition (spec §6.2) — DECIDED
// ══════════════════════════════════════════════════════════════
//
// eligibility_q = max(Q, Q + (Σ wᵢ·rᵢ) / Q)
//
// NOTE on the outer max(): with every rᵢ clamped to [0, Q] and every weight
// non-negative, the sum can never be negative, so the max() can never bind. It
// is kept because the spec writes it and because it is the only thing standing
// between a future signed factor and an eligibility below 1.00×. Belt and
// braces — do NOT read it as support for negative factors; clamp_q rejects them
// first.
//
// Q-format: ONE floor division, applied to the weighted sum. Each wᵢ·rᵢ is an
// exact product (both ≤ Q ⟹ ≤ 10^18), so there is no per-term rounding to
// accumulate — unlike the sequential ⌊×/Q⌋ chains in §6.1, which need it because
// they multiply more than two Q-format terms.
pub fn eligibility_q(
  age_r: Int,
  consumed_r: Int,
  off_peak_r: Int,
  commit_r: Int,
) -> Int {
  let weighted =
    w_age * clamp_q(age_r) + w_consumed * clamp_q(consumed_r) + w_offpeak * clamp_q(
      off_peak_r,
    ) + w_commit * clamp_q(commit_r)
  imax(q, q + weighted / q)
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

// ── Bounds of the composition ─────────────────────────────────

test elig_all_zero_is_one_x() {
  eligibility_q(0, 0, 0, 0) == q
}

test elig_all_max_is_2_5x() {
  eligibility_q(q, q, q, q) == 2_500_000_000
}

// Clamping happens BEFORE weighting: a factor handed 10×Q must buy exactly its
// weight, not ten times it. Without clamp_q this returns 16.0×.
test elig_over_q_factor_is_clamped() {
  eligibility_q(10 * q, 10 * q, 10 * q, 10 * q) == 2_500_000_000
}

// A negative factor must not cancel another term's earnings.
test elig_negative_factor_cannot_subtract() {
  eligibility_q(-10 * q, q, 0, 0) == q + w_consumed
}

// Each weight is individually reachable — catches a wire-up swap between two
// factors, which a symmetric all-max test cannot see.
test elig_weights_are_individually_addressable() {
  eligibility_q(q, 0, 0, 0) == q + w_age && eligibility_q(0, q, 0, 0) == q + w_consumed && eligibility_q(
    0,
    0,
    q,
    0,
  ) == q + w_offpeak && eligibility_q(0, 0, 0, q) == q + w_commit
}

// MVP ceiling: consumedFactor is OFF while did_commit is empty, so 0.90Q of the
// 1.50Q range is unreachable. 2.50× → 1.60×.
test elig_mvp_ceiling_without_consumed() {
  eligibility_q(q, 0, q, q) == 1_600_000_000
}

// ── ratio_q ───────────────────────────────────────────────────

test ratio_half() {
  ratio_q(50, 100) == q / 2
}

test ratio_saturates_at_q() {
  ratio_q(500, 100) == q
}

test ratio_negative_value_floors_at_zero() {
  ratio_q(-500, 100) == 0
}

// Reference 0 means "no bar to clear", not a crash.
test ratio_zero_reference_is_fully_satisfied() {
  ratio_q(1, 0) == q
}

test ratio_zero_value_is_zero() {
  ratio_q(0, 100) == 0
}

// ── ageFactor / EMA ───────────────────────────────────────────

// A balance held flat is already fully aged — the EMA is a fixed point.
test ema_flat_balance_is_a_fixed_point() {
  let balance = 1_000_000
  let ema = balance * q
  ema_step(ema, balance) == ema && age_factor(ema, balance) == q
}

// A fresh deposit into an empty vault must NOT jump to full age: one step of
// α = 1/6 gets ~16.67% of the way.
test ema_fresh_deposit_is_not_aged() {
  let balance = 1_000_000
  age_factor(ema_step(0, balance), balance) == 166_666_666
}

// Convergence is monotone and bounded — six steps get past half, never past Q.
test ema_converges_upward_without_overshoot() {
  let balance = 1_000_000
  let r6 = age_factor(ema_catch_up(0, balance, 6, 12), balance)
  r6 > q / 2 && r6 < q
}

// A WITHDRAWAL leaves the EMA above the balance. The remaining balance is fully
// aged, so r = Q — not something above Q. This is what the min() is for.
test ema_after_withdrawal_is_capped_at_q() {
  age_factor(1_000_000 * q, 100_000) == q
}

// THE ESCAPE HATCH (#26). Missing epochs must cost convergence speed, never
// access: catch-up applies min(elapsed, cap) steps and stays finite.
test ema_catch_up_is_capped_not_fatal() {
  let balance = 1_000_000
  let skipped = ema_catch_up(0, balance, 10_000, 6)
  let honest = ema_catch_up(0, balance, 6, 6)
  skipped == honest && age_factor(skipped, balance) > 0
}

// Elapsed 0 (same-epoch second call) must be a no-op, not a free extra step.
test ema_zero_elapsed_is_a_noop() {
  ema_catch_up(12_345, 1_000_000, 0, 6) == 12_345
}

// Negative elapsed (clock skew, bad caller) must not run the recursion backwards.
test ema_negative_elapsed_is_a_noop() {
  ema_catch_up(12_345, 1_000_000, -5, 6) == 12_345
}

// A zero cap freezes the EMA rather than looping.
test ema_zero_cap_is_a_noop() {
  ema_catch_up(12_345, 1_000_000, 10, 0) == 12_345
}

// An empty vault has no age to claim, and must not divide by zero.
test age_factor_empty_vault_is_zero() {
  age_factor(0, 0) == 0
}

// TV-ELIG-EMA-CONVERGENCE — the P8 teeth. These exact integers also appear in
// Eligibility/tests/vectors.ts; if the two sides ever round differently, one of
// them fails here rather than silently disagreeing on-chain.
//
// They are NOT 1 − (5/6)^n: α is ⌊Q/6⌋, a hair under 1/6, and every step floors,
// so the shortfall compounds. The implementation is normative — recompute if α
// changes, do not "correct" toward the analytic curve.
test ema_convergence_pinned_curve() {
  let b = 1_000_000_000
  age_factor(ema_catch_up(0, b, 1, 1), b) == 166_666_666 && age_factor(
    ema_catch_up(0, b, 6, 6),
    b,
  ) == 665_102_021 && age_factor(ema_catch_up(0, b, 12, 12), b) == 887_843_344 && age_factor(
    ema_catch_up(0, b, 24, 24),
    b,
  ) == 987_420_884
}

// ── The three parameterised factors ───────────────────────────

test consumed_factor_off_in_mvp() {
  consumed_factor(0, 1_000_000_000) == 0
}

test consumed_factor_saturates() {
  consumed_factor(2_000_000_000, 1_000_000_000) == q
}

// Load at or above the reference earns no off-peak credit, and load far above it
// must floor at 0 rather than wrap negative.
test off_peak_zero_at_and_above_reference() {
  off_peak_factor(100, 100) == 0 && off_peak_factor(1_000_000, 100) == 0
}

test off_peak_full_on_idle_network() {
  off_peak_factor(0, 100) == q
}

test off_peak_half_load_is_half_credit() {
  off_peak_factor(50, 100) == q / 2
}

test commit_factor_scales_with_lock() {
  commit_factor(0, 1000) == 0 && commit_factor(500, 1000) == q / 2 && commit_factor(
    1000,
    1000,
  ) == q
}
