// lib/math.ak — Q-format arithmetic (§6.1, §11)
// Aiken `/` on Int is floor division. Every Q-format formula is applied as a
// chain of SEQUENTIAL ⌊× / Q⌋ steps — never one fused multiply-then-divide —
// so the rounding error stays bounded at ≤ 1 nanogic per step (L4).
//
// P8: offchain/src/math.ts mirrors every function here bit-for-bit.

use aiken/collection/list
use magiclamp/protocol/constants.{
  br_safe_q, f_cap_surplus_q, instant_reward_rate_q, q,
}
use magiclamp/protocol/types.{GenSchedule}

// ── §6.1 Core Q operations ───────────────────────────────────

/// apply_multiplier: multiply x by a Q-format multiplier
/// Error: ≤ 1 nanogic per call (L4)
pub fn apply_multiplier(x: Int, m_q: Int) -> Int {
  x * m_q / q
}

/// multiply_q: multiply two Q-format values. Result is also Q-format.
pub fn multiply_q(a_q: Int, b_q: Int) -> Int {
  a_q * b_q / q
}

/// Compute batch age k = current_epoch - created_epoch
/// Fails if current_epoch < created_epoch (C-DECAY-2)
pub fn batch_age(created_epoch: Int, current_epoch: Int) -> Int {
  let k = current_epoch - created_epoch
  expect k >= 0
  k
}

/// Clamp value to [lo, hi] inclusive
pub fn clamp(x: Int, lo: Int, hi: Int) -> Int {
  if x < lo {
    lo
  } else if x > hi {
    hi
  } else {
    x
  }
}

pub fn min2(a: Int, b: Int) -> Int {
  if a < b {
    a
  } else {
    b
  }
}

pub fn min3(a: Int, b: Int, c: Int) -> Int {
  min2(min2(a, b), c)
}

// ══════════════════════════════════════════════════════════════
// §6.3 InstantGen — magnitude keyed to MAGIC ALREADY CONSUMED
// ══════════════════════════════════════════════════════════════
//
//   cấp thực = min( reward(consumed), cap_surplus(br), 0.5 × pp_schedule )
//
// Holding LAMP only OPENS the door (eligibility); it no longer sizes the
// grant, and no LAMP moves (I-ACT-7).

// ── reward(consumed) ─────────────────────────────────────────
//
//   reward = ⌊ ⌊ ⌊ consumed × R_reward / Q ⌋ × UM / Q ⌋ × PM / Q ⌋
//
// 3 sequential floor steps (≤ 3 nanogic total error, result ≤ true value).
//
// INV-CASHBACK-BOUND (reward ≤ consumed) holds by parameter construction:
//   R_reward × UM_MAX × PM_MAX = 0.20 × 2.00 × 1.15 = 0.46 < 1
// and each floor step only ever lowers the result.
pub fn compute_reward_from_consumed(
  consumed : Int, // nanogic already burned and not yet rewarded
  um_q     : Int, // Q-format UM (after the C-UM-6 stale check)
  pm_q     : Int, // Q-format profile multiplier (tư-cách, §6.2)
) -> Int {
  let s1 = consumed * instant_reward_rate_q / q // step 1
  let s2 = s1 * um_q / q // step 2
  s2 * pm_q / q // step 3
}

// ── cap_surplus(br) — surplus-backing gate ───────────────────
//
//   xanh (br >  br_safe):  cap = f · S · (br − br_safe) / br_safe
//   đỏ   (br ≤  br_safe):  cap = 0                       (khoá Gen)
//
// Applied as sequential floors:
//   s1 = ⌊ S  × f_q        / Q ⌋          -- f·S
//   s2 = ⌊ s1 × (br−safe)  / Q ⌋          -- f·S·(br−br_safe)
//   s3 = ⌊ s2 × Q / br_safe_q ⌋           -- ÷ br_safe
//
// `br_q` and `magic_supply` come from the BackingBeacon reference input; a
// missing/stale/depegged beacon never reaches this function — the validator
// rejects the tx first (fail-closed, no default br).
pub fn compute_cap_surplus(br_q: Int, magic_supply: Int) -> Int {
  if br_q <= br_safe_q {
    0
  } else {
    let excess_q = br_q - br_safe_q
    let s1 = magic_supply * f_cap_surplus_q / q
    let s2 = s1 * excess_q / q
    s2 * q / br_safe_q
  }
}

// ── 0.5 × pp_schedule — dual ceiling ─────────────────────────
//
// pp_schedule = Σ over live ScheduleGen contracts of the per-epoch MAGIC
// guarantee M_i = ⌊ λ_i × rate_locked_q_i / Q ⌋ (§6.4). Vault-internal data.
//
// Empty `gen_schedules` ⟹ pp = 0 ⟹ cap = 0 ⟹ InstantGen SHUT. That is the
// intended fail-closed direction: InstantGen may never exceed half of the
// committed ScheduleGen flow in ANY state (§6.3 "trần-kép").
pub fn compute_pp_schedule(schedules: List<GenSchedule>) -> Int {
  list.foldl(
    schedules,
    0,
    fn(s, acc) { acc + s.lamp_per_epoch * s.rate_locked_q / q },
  )
}

pub fn compute_cap_pp(schedules: List<GenSchedule>) -> Int {
  compute_pp_schedule(schedules) / 2
}

// ── The whole gate ───────────────────────────────────────────
pub fn compute_instant_grant(
  consumed     : Int,
  um_q         : Int,
  pm_q         : Int,
  br_q         : Int,
  magic_supply : Int,
  schedules    : List<GenSchedule>,
) -> Int {
  min3(
    compute_reward_from_consumed(consumed, um_q, pm_q),
    compute_cap_surplus(br_q, magic_supply),
    compute_cap_pp(schedules),
  )
}
