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
//   - the normalisation reference of consumedFactor / commitFactor
//   - the EMA catch-up cap
//
// WHAT IS ABSENT ON PURPOSE:
//   - offPeakFactor. The version that shipped here measured network-wide load and
//     returned the same number for every user, so 0.25Q was a flat bonus that
//     separated nobody while looking implemented. Off (r = 0) until việc 3 gives it
//     the per-user shape spec §6.2 asks for. See the note where it used to live.
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
/// `reference` is what nobody has fixed yet, so it is an argument.
///
/// A reference ≤ 0 yields r = 0, NOT r = Q. It reads as "this factor has no bar
/// configured, so it earns nothing" — fail CLOSED. The earlier `max(1, ·)` form
/// failed open: reference = 0 made every nonzero value saturate, so an unset
/// parameter handed out the factor's full weight to everyone. An unset reference
/// is overwhelmingly a wiring mistake, not a deliberate "no bar to clear", and a
/// wiring mistake must not pay.
pub fn ratio_q(value: Int, reference: Int) -> Int {
  if reference <= 0 {
    0
  } else {
    clamp_q(value * q / reference)
  }
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
// Algebraically identical over the reals, NOT over floored integers: `(x − ema)`
// goes negative whenever the balance falls, and the two sides floor a negative
// numerator differently — Aiken's `/` is divideInteger (floors toward −∞) while
// TypeScript's BigInt `/` truncates toward 0. This form never builds a negative
// intermediate, so both sides round identically in every direction. See
// `ema_falling_balance_pins_the_form` below: the rejected form drifts UP by 4
// units over five falling steps, free money for anyone who oscillates a balance.
//
// P8: both inputs are floored at 0 first. `ema_q` is a DATUM field, so a hostile
// or merely wrong caller can present it negative; unclamped, Aiken and TS then
// compute different values (ema_step(-5, 0) → -5 vs -4), that difference is
// WRITTEN BACK to the datum and compounds — off-chain builds a tx on-chain
// rejects. The clamp is what makes the divergence unreachable rather than merely
// unlikely.
pub fn ema_step(ema_q: Int, lamp_balance: Int) -> Int {
  let e = imax(0, ema_q)
  let b = imax(0, lamp_balance)
  ( alpha_age_q * ( b * q ) + ( q - alpha_age_q ) * e ) / q
}

/// Advance the EMA across a gap and then record the balance this tx leaves
/// behind: `steps − 1` steps at `balance_before`, then ONE final step at
/// `balance_after`, where `steps = min(epochs_elapsed, catch_up_cap)`.
///
/// Taking the last step at `balance_after` is what stops age-laundering. A vault
/// that sits empty for 24 epochs, then deposits and calls once, ages the gap at
/// the balance it actually held during the gap (zero) and gets exactly one step
/// of credit for the new money: 16.7%, not the 66.5% it would collect if the
/// whole catch-up ran at the post-deposit balance. A holder who really did sit
/// on the balance passes before == after and is unaffected — every pinned vector
/// in TV-ELIG-EMA-CONVERGENCE is that case, which is why they are unchanged.
///
/// The cap is what keeps a missed epoch from being fatal. #26 forbids rebuilding
/// the v0.2 shape where strict sequencing + a singleton beacon + no escape hatch
/// meant one skipped epoch killed an account permanently. Here a latecomer only
/// converges more slowly, and is never locked out.
///
/// catch_up_cap is a PARAMETER: bounding ExUnits is decided, the number is not.
/// When việc 3 wires this into a validator it MUST arrive as a compile-time
/// constant — nothing here bounds the cap itself, so a redeemer- or
/// datum-sourced cap is an unbounded loop.
pub fn ema_catch_up(
  ema_q: Int,
  balance_before: Int,
  balance_after: Int,
  epochs_elapsed: Int,
  catch_up_cap: Int,
) -> Int {
  let steps = imin(imax(0, epochs_elapsed), imax(0, catch_up_cap))
  if steps <= 0 {
    ema_q
  } else {
    ema_step(ema_steps_rec(ema_q, balance_before, steps - 1), balance_after)
  }
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
/// CALLER CONTRACT — `consumed_nanogic` is the total consumed in the TRAILING
/// 6 EPOCHS, not lifetime. Spec §6.2 fixes the window as part of the mechanism,
/// and the mechanism is decided even though the reference is not. This function
/// cannot enforce it: it never sees an epoch. A caller that passes lifetime
/// consumption turns the heaviest weight in the system (0.90Q of 1.50Q) into a
/// one-off achievement that never decays — consume 100 MAGIC once, collect r =
/// 100% forever. Việc 3 owns the windowing, and owes a decay vector when it
/// lands; there is nothing here to test until then.
///
/// MVP: `did_commit = #""`, so cross-DID attribution cannot be computed and this
/// term is OFF — callers pass consumed = 0, which yields r = 0 and forfeits the
/// whole 0.90Q weight. That is the largest gap between MVP and full eligibility
/// (2.50× ceiling → 1.60×). Wire it up when a real did_commit ships.
pub fn consumed_factor(consumed_nanogic: Int, consumed_ref: Int) -> Int {
  ratio_q(consumed_nanogic, consumed_ref)
}

// offPeakFactor — DELIBERATELY ABSENT, callers pass off_peak_r = 0 in MVP.
//
// The function that used to sit here read `(load_ref − network_load) / load_ref`:
// network-wide load headroom, with no argument belonging to the user at all. It
// returned the same number for everybody, so 0.25Q — a sixth of the whole range —
// was a flat constant added to every vault, discriminating between nobody while
// looking like a working feature. That is worse than off, because it reads as
// implemented.
//
// Spec §6.2 asks for something else entirely: the share of THIS user's consumption
// that happened off-peak, with the off-peak label taken from the published service
// price (`demand_mult` in ConsumeMAGIC's `PriceParam` beacon — an existing
// reference input, not a metric anyone has to invent). Shape it must have:
//
//     off_peak_factor(consumed_offpeak_nanogic, consumed_total_nanogic)
//
// Both arguments are per-user, so there is no `load_ref` to choose. Restore it in
// việc 3 when the per-user split is available; until then 0.25Q is unreachable and
// the MVP ceiling is 1.35×, not 1.60×.

/// commitFactor — how much the user has put under commitment (ScheduleGen locks)
/// against the reference that counts as fully committed.
///
/// KNOWN GAP (việc 3, INV-CONSUMED-ATTRIB): whichever reference wins, this is
/// per-VAULT, and splitting a balance across n vaults is nearly free on Cardano.
/// A relative bar reads a whale's 1%-of-balance lock for what it is, but 100
/// wallets each locking 100% of a small balance score 100% on every one of them.
/// The fix is the same DID aggregation consumedFactor needs, so both wait on the
/// same infrastructure.
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
// AND IF YOU DO ADD A SIGNED FACTOR: `weighted / q` below is the second place in
// this file where a negative numerator would meet Aiken's floor division and
// TypeScript's truncation and get two different answers (weighted = −1 ⟹ Aiken −1,
// TS 0).
//
// 🔴 CÂU TIẾP THEO TỪNG SAI, và nó sai theo chiều đẩy người vá đi canh nhầm chỗ. Bản cũ
// viết "Nothing is clamped after that division, so the divergence would reach the
// caller." KHÔNG ĐÚNG: `imax(q, q + weighted / q)` ngay dưới nuốt trọn. Với weighted âm
// bất kỳ, hai bên cho `q + (−a)` và `q + (−b)` với a,b ≥ 0, cả hai ≤ q ⟹ `imax` kéo cả
// hai về đúng `q`. Chênh lệch sàn-vs-cắt KHÔNG tới được người gọi qua đường này.
//
// Điều đúng, và nó là điều đáng nói: `imax(q, ·)` hôm nay là mã KHÔNG BAO GIỜ ràng buộc
// (mọi số hạng là `w × clamp_q(·) ≥ 0` ⟹ `weighted ≥ 0`), nên không vector nào giết được
// nó — xem `elig_all_negative_inputs_floor_at_q`. Nó chỉ bắt đầu làm việc ĐÚNG VÀO LÚC
// ai đó nới `clamp_q`, và lúc đó nó làm đúng việc này: chặn chênh lệch sàn-vs-cắt.
//
// Nên người nới `clamp_q` nợ hai thứ, không phải một: (a) một quyết định `quotient`-vs-`/`
// cho `weighted / q`, và (b) viết lại chú thích ở `elig_all_negative_inputs_floor_at_q` —
// từ lúc đó `imax` kiểm được, và phải được kiểm.
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

// 🔴 Test dưới đây TỪNG là bản tự tham chiếu, và nó KHÔNG bắt được thứ chú thích của
// chính nó hứa. Bản cũ so `eligibility_q(q,0,0,0) == q + w_age` — tức so kết quả với
// CHÍNH hằng cần ghim, nên hoán vị hai trọng số làm hai vế đổi cùng nhau và test vẫn
// xanh. Đo được, cùng cây nguồn, chỉ hoán vị `w_age` ↔ `w_commit` (tổng giữ 1.5Q):
//
//     aiken check → exit 0, 30 pass / 0 fail
//     AIKEN (đã hoán vị) : age_only = 1_200_000_000  commit_only = 1_150_000_000
//     TS   (nguyên bản)  : age_only = 1_150_000_000  commit_only = 1_200_000_000
//
// Hai hiện thực, cùng đầu vào, khác kết quả, hai bộ kiểm đều xanh. Đó là định nghĩa P8
// vỡ. Phía TS ghim literal cho TỪNG trọng số (`eligibility.ts:17-20`), phía Aiken thì
// không — nên bên nào lệch cũng chỉ có bên TS phát hiện, và chỉ khi ai đó đọc.
//
// Nay ghim bằng literal. Một literal không tự đổi theo hằng nó canh.
test elig_weights_pinned_by_literal() {
  w_consumed == 900_000_000 && w_offpeak == 250_000_000 && w_commit == 200_000_000 && w_age == 150_000_000
}

// Σ = 1.5Q là thứ cho khoảng [Q, 2.5Q] ở spec §6.2. Ghim riêng: literal từng trọng số
// giữ được giá trị, tổng giữ được TÍNH CHẤT — hỏng một trong hai là hỏng khác nhau.
test elig_weights_sum_to_1_5q() {
  w_consumed + w_offpeak + w_commit + w_age == 3 * q / 2
}

// Mỗi trọng số vẫn phải đi tới được đúng ô của nó — literal ở trên ghim GIÁ TRỊ, test
// này ghim ĐẤU DÂY. Vế phải là literal, không phải tên hằng.
test elig_weights_are_individually_addressable() {
  eligibility_q(q, 0, 0, 0) == 1_150_000_000 && eligibility_q(0, q, 0, 0) == 1_900_000_000 && eligibility_q(
    0,
    0,
    q,
    0,
  ) == 1_250_000_000 && eligibility_q(0, 0, 0, q) == 1_200_000_000
}

// ── Bốn cái KẸP, mỗi cái một vector âm ────────────────────────────────────────
// Gỡ bất kỳ cái nào trong bốn cái kẹp dưới đây thì bộ kiểm cũ VẪN xanh 30/30 — đo được.
// Chúng là thứ nuốt chênh lệch giữa Aiken chia-sàn và BigInt cắt-về-0, nên không canh
// chúng là để P8 phụ thuộc vào việc không ai đưa số âm vào.
test elig_clamp_age_factor_negative_ema() {
  age_factor(-5, 3) == 0
}

// `imin(ema, balance*q)` là thứ DUY NHẤT chặn "kho rỗng đòi thâm niên": vault đã rút
// sạch mà EMA còn cao thì không được khai 50% tuổi. Ca `age_factor(0,0)` ở test cũ
// vacuous đúng chỗ cần canh — ema cũng bằng 0.
test elig_clamp_age_factor_empty_balance() {
  age_factor(500_000_000, 0) == 0
}

// Vector phải là (âm, âm), KHÔNG phải (dương, âm). Với `ratio_q(1, -3)` thì bỏ hẳn cổng
// `reference <= 0` vẫn cho 0, vì `clamp_q` phía sau nuốt số âm — nên vector đó xanh ở cả
// hai hiện thực và không chứng minh gì. Đo được: đổi cổng thành `== 0` → đỏ=0.
// Với (âm, âm) thì thương DƯƠNG (`-3×q / -3 = q`) và `clamp_q` không nuốt được:
// có cổng → 0, bỏ cổng → q. Đó mới là ca tách được hai hiện thực.
test elig_clamp_ratio_negative_reference() {
  ratio_q(-3, -3) == 0 && ratio_q(1, -3) == 0
}

// ⚠ `imax(q, ·)` ở cuối `eligibility_q` là KHÔNG THỂ KIỂM bằng vector, và nói rõ ở đây
// thay vì viết một test trông như đang canh nó. Lý do: mỗi số hạng là
// `w_i × clamp_q(x_i)` với `clamp_q(v) = imax(0, imin(q, v))` (`math.ak:68-70`) ⟹ mọi số
// hạng ≥ 0 ⟹ `weighted ≥ 0` ⟹ `q + weighted/q ≥ q` ⟹ `imax` KHÔNG BAO GIỜ ràng buộc.
// Đo: bỏ hẳn `imax` → đỏ=0, và đó là kết quả ĐÚNG, không phải lỗ hổng kiểm thử.
//
// Nên nó là đai an toàn cho một tương lai bỏ `clamp_q` bên trong, không phải một chốt
// đang cưỡng chế điều gì. Ai bỏ `clamp_q` khỏi bất kỳ số hạng nào PHẢI viết lại chú
// thích này — lúc đó `imax` mới bắt đầu ràng buộc và mới kiểm được.
//
// Test dưới chỉ ghim GIÁ TRỊ ở ca toàn-âm; nó không ghim `imax`.
test elig_all_negative_inputs_floor_at_q() {
  eligibility_q(-1, -1, -1, -1) == q
}

// consumedFactor is OFF while did_commit is empty, so 0.90Q of the 1.50Q range is
// unreachable: 2.50× → 1.60×. This is the ceiling MVP reaches once offPeakFactor
// is restored (việc 3); today off-peak is off too, so see
// elig_mvp_ceiling_without_consumed_or_offpeak for what actually ships.
test elig_ceiling_without_consumed() {
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

// An unconfigured reference must FAIL CLOSED. Under the old `max(1, ·)` form
// every one of these returned Q — a wiring mistake paid out the full weight.
test ratio_unset_reference_earns_nothing() {
  ratio_q(1, 0) == 0 && ratio_q(0, 0) == 0 && ratio_q(1_000_000_000, 0) == 0 && ratio_q(
    1,
    -5,
  ) == 0
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
  let r6 = age_factor(ema_catch_up(0, balance, balance, 6, 12), balance)
  r6 > q / 2 && r6 < q
}

// P8 TEETH ON THE EMA FORM. Every other vector here starts at ema = 0 with a flat
// or rising balance, and on that path the shipped form and the `ema + (x−ema)·α`
// form the issue proposed are bit-identical — so the whole argument for choosing
// this form was untested, and a regression back to the rejected form passed 100%
// of the suite. They diverge only when the balance FALLS, which is exactly the
// direction the rejected form gets wrong: it drifts UP.
//
//   ema converged at 1000 LAMP, balance drops to 1 oildrop, five steps
//     this form:    401_877_574_222_093_621
//     rejected:     401_877_574_222_093_625   ← free upward drift
test ema_falling_balance_pins_the_form() {
  let ema0 = 1_000_000_000 * q
  let e1 = ema_step(ema0, 1)
  let e2 = ema_step(e1, 1)
  let e3 = ema_step(e2, 1)
  let e4 = ema_step(e3, 1)
  ema_step(e4, 1) == 401_877_574_222_093_621
}

// P8 on the negative domain. `ema_q` is a datum field, so a caller can present it
// negative; without the clamp Aiken floors (-5 → -5) where TS truncates (→ -4),
// the two sides write different datums and the vault desynchronises for good.
test ema_step_clamps_negative_inputs() {
  ema_step(-1, 0) == 0 && ema_step(-5, 0) == 0 && ema_step(1, -1) == 0 && ema_step(
    -1_000_000 * q,
    0,
  ) == 0
}

// C-OVERFLOW mirror of the TS TV-OVERFLOW vector: 10^15 oildrop × Q = 10^24, far
// past any 64-bit or float53 representation. Hard-coded, not recomputed from the
// implementation's own expression.
test ema_overflow_keeps_every_digit() {
  ema_step(0, 1_000_000_000_000_000) == 166_666_666_000_000_000_000_000
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
  let skipped = ema_catch_up(0, balance, balance, 10_000, 6)
  let honest = ema_catch_up(0, balance, balance, 6, 6)
  skipped == honest && age_factor(skipped, balance) > 0
}

// Elapsed 0 (same-epoch second call) must be a no-op, not a free extra step.
test ema_zero_elapsed_is_a_noop() {
  ema_catch_up(12_345, 1_000_000, 1_000_000, 0, 6) == 12_345
}

// Negative elapsed (clock skew, bad caller) must not run the recursion backwards.
test ema_negative_elapsed_is_a_noop() {
  ema_catch_up(12_345, 1_000_000, 1_000_000, -5, 6) == 12_345
}

// A zero cap freezes the EMA rather than looping.
test ema_zero_cap_is_a_noop() {
  ema_catch_up(12_345, 1_000_000, 1_000_000, 10, 0) == 12_345
}

// AGE-LAUNDERING, the reason balance_before exists. An empty vault sleeps 24
// epochs, then deposits and calls once. It aged the gap at the balance it really
// held — zero — so the deposit buys exactly one step, 16.7%. Running the whole
// catch-up at the post-deposit balance would hand it 66.5% for having held
// nothing, which is what the single-balance signature did.
test ema_catch_up_cannot_launder_age() {
  let deposited = 10_010 * 1_000_000
  let laundered = age_factor(ema_catch_up(0, 0, deposited, 24, 6), deposited)
  let as_if_held = age_factor(
    ema_catch_up(0, deposited, deposited, 24, 6),
    deposited,
  )
  laundered == 166_666_666 && as_if_held == 665_102_021
}

// The cap MUST bind, and the payoff table has to be read knowing it does. Same
// 24 epochs of tenure, two update habits, two very different numbers at cap = 6:
//   updates every epoch  → 24 single steps → 98.7%  (ema_convergence_pinned_curve)
//   updates once at the end → min(24, 6) = 6 steps → 66.5%
// A table that only ever shows the first habit prints the cap in its header while
// being completely insensitive to it — which is how cap = 6 nearly got approved
// on evidence that could not distinguish it from cap = 10000.
test ema_catch_up_cap_binds() {
  let b = 1_000_000_000
  let one_shot = age_factor(ema_catch_up(0, b, b, 24, 6), b)
  let uncapped = age_factor(ema_catch_up(0, b, b, 24, 24), b)
  one_shot == 665_102_021 && uncapped == 987_420_884
}

// An empty vault has no age to claim, and must not divide by zero.
test age_factor_empty_vault_is_zero() {
  age_factor(0, 0) == 0
}

// TV-ELIG-EMA-CONVERGENCE — cùng bộ số nguyên với `Eligibility/tests/vectors.ts`.
//
// 🔴 CÂU CŨ Ở ĐÂY HỨA MỘT CƠ CHẾ KHÔNG TỒN TẠI. Nó viết: "if the two sides ever round
// differently, one of them fails here rather than silently disagreeing on-chain." Không có
// gì làm điều đó. Aiken KHÔNG đọc `vectors.ts` — `grep vectors.ts` trong cây `*.ak` chỉ ra
// chú thích, không ra một lời gọi nào; và CI chạy hai job rời nhau, không job nào đối
// chiếu hai bộ số. Hai bộ kỳ vọng được GÕ TAY HAI LẦN. Hôm nay chúng khớp vì người gõ
// đúng, không vì cơ chế nào.
//
// Đo được, cùng cây nguồn, chỉ hoán vị `w_age` ↔ `w_commit` phía Aiken (tổng giữ 1.5Q):
// `aiken check` 30/30 xanh, `vitest` xanh, mà `eligibility_q(q,0,0,0)` cho
// 1_200_000_000 phía Aiken và 1_150_000_000 phía TS. Hai hiện thực khác kết quả, không
// bộ kiểm nào đỏ.
//
// Nay từng trọng số được ghim bằng LITERAL hai phía (`elig_weights_pinned_by_literal` ↔
// `eligibility.ts:17-20`), nên ca đó bị bắt — kiểm đột biến: đỏ 2.
// NHƯNG đó là ghim theo GIÁ TRỊ, vẫn do người gõ hai lần. Cơ chế cưỡng chế thật (một job
// CI đối chiếu literal hai phía, hoặc sinh vector từ một nguồn chung) thì kho CHƯA CÓ.
// Đừng đọc khối này thành "P8 đã được cưỡng chế".
//
// They are NOT 1 − (5/6)^n: α is ⌊Q/6⌋, a hair under 1/6, and every step floors,
// so the shortfall compounds. The implementation is normative — recompute if α
// changes, do not "correct" toward the analytic curve.
test ema_convergence_pinned_curve() {
  let b = 1_000_000_000
  age_factor(ema_catch_up(0, b, b, 1, 1), b) == 166_666_666 && age_factor(
    ema_catch_up(0, b, b, 6, 6),
    b,
  ) == 665_102_021 && age_factor(ema_catch_up(0, b, b, 12, 12), b) == 887_843_344 && age_factor(
    ema_catch_up(0, b, b, 24, 24),
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

// offPeakFactor is OFF in MVP (see the note where it used to be defined): its
// 0.25Q is simply unreachable, so the MVP ceiling is 1.35× — age + commit only.
test elig_mvp_ceiling_without_consumed_or_offpeak() {
  eligibility_q(q, 0, 0, q) == 1_350_000_000
}

test commit_factor_scales_with_lock() {
  commit_factor(0, 1000) == 0 && commit_factor(500, 1000) == q / 2 && commit_factor(
    1000,
    1000,
  ) == q
}
