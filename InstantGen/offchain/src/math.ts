// src/math.ts — BigInt math engine (§6.1, §6.3, §11)
//
// ALL arithmetic uses BigInt. NEVER use Number for oildrop/nanogic/Q-format
// (C-OVERFLOW) — TV-OVERFLOW-01/02 exist precisely to catch a Number regression.
//
// P8: every function here mirrors onchain/lib/magiclamp/protocol/{math,decay}.ak
// bit-for-bit. Change one side ⟹ change the other side in the same commit.

import {
  Q, INSTANT_REWARD_RATE_Q, BR_SAFE_Q, F_CAP_SURPLUS_Q,
  UM_FALLBACK_Q, UM_MAX_STALENESS,
  INSTANT_RATE_Q, SNAPSHOT_BASE_RATE_Q, SCHEDULE_MIN_LENGTH, LENT_PP_CAP,
  S_SEG1_INTERCEPT_Q, S_SEG1_SLOPE_Q, S_SEG2_KNEE, S_SEG2_INTERCEPT_Q,
  S_SEG2_SLOPE_Q, S_SEG3_KNEE, S_SEG3_INTERCEPT_Q, S_SEG3_SLOPE_Q,
} from "./constants.js";
import {
  slotToEpoch, nanogicToMagicStr, qToStr, lampToOildrop, oildropToLamp,
} from "@magiclamp/protocol-utils";
import type { GenSchedule } from "./types.js";

/** Hình dạng UM mà `getUmForInstant` đọc. Gen v2.0 bỏ UM khỏi két InstantGen (không
 *  còn lược đồ `UMDatum` trong `types.ts`); hàm đời v1 giữ lại cho bài kiểm C-UM-6. */
export interface UmReading { smoothed_q: bigint; last_updated_epoch: bigint }

// Re-export shared primitives to preserve module's public API
export { slotToEpoch, nanogicToMagicStr, qToStr, lampToOildrop, oildropToLamp };

// ── §6.1 Q-format operations ─────────────────────────────────

/** ⌊x × m_q / Q⌋ — error ≤ 1 nanogic per call (L4) */
export function applyMultiplier(x: bigint, mQ: bigint): bigint {
  return x * mQ / Q;
}

/** ⌊a_q × b_q / Q⌋ — multiply two Q-format values */
export function multiplyQ(aQ: bigint, bQ: bigint): bigint {
  return aQ * bQ / Q;
}

export function min2(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function min3(a: bigint, b: bigint, c: bigint): bigint {
  return min2(min2(a, b), c);
}

// ── Epoch helpers ────────────────────────────────────────────

/** Batch age k = current_epoch - created_epoch */
export function batchAge(createdEpoch: bigint, currentEpoch: bigint): bigint {
  const k = currentEpoch - createdEpoch;
  if (k < 0n) throw new Error(`Negative batch age: created=${createdEpoch}, current=${currentEpoch}`);
  return k;
}

// ══════════════════════════════════════════════════════════════
// §6.3 InstantGen — magnitude keyed to MAGIC ALREADY CONSUMED
// ══════════════════════════════════════════════════════════════
//
//   cấp thực = min( reward(consumed), cap_surplus(br), 0.5 × pp_schedule )
//
// Holding LAMP only OPENS the door; it no longer sizes the grant, and no LAMP
// moves (I-ACT-7).

/**
 * reward(consumed) = ⌊ ⌊ ⌊ consumed × R_reward / Q ⌋ × UM / Q ⌋ × PM / Q ⌋
 *
 * 3 sequential floor steps. `result ≤ true value` — đúng, mọi hạng tử sai số ≥ 0.
 *
 * 🔴 CẬN SAI SỐ: `< 3,94` nanogic, KHÔNG phải `≤ 3`. Bản trước viết "≤ 3" ở cả hai
 * phía P8 — sửa 2026-09-12. Lý do đầy đủ + khai triển `Δ` ở `math.ak` ▸
 * `compute_reward_from_consumed`; tóm tắt: bước 2 nhân `um_q/Q ≤ 2,0` nên nó GIÃN
 * sai số bước 1, và quy tắc "3 bước sàn ⟹ ≤ 3 ulp" chỉ đúng khi mọi hệ số sau mỗi
 * bước sàn đều ≤ 1.
 *
 * INV-CASHBACK-BOUND holds by parameter construction:
 *   R_reward × UM_MAX × PM_MAX = 0.20 × 2.00 × 1.15 = 0.46 < 1
 *
 * Mirrors math.ak: compute_reward_from_consumed.
 */
export function computeRewardFromConsumed(
  consumed: bigint,  // nanogic already burned and not yet rewarded
  umQ     : bigint,  // Q-format UM (after the C-UM-6 stale check)
  // 🔴 pmQ = hệ số HỒ SƠ HOẠT ĐỘNG (`ActivityProfile`), enum ba mức đóng ≤ 1.15.
  //    KHÔNG phải hệ số tư-cách §6.2 (`eligibility_q ∈ [1.00×, 2.50×]`) — nối nhầm thứ
  //    đó vào đây làm INV-CASHBACK-BOUND thành 0.20 × 2.00 × 2.50 = 1.00, tức HOÀ VỐN:
  //    cấp lại đúng bằng số đã tiêu, vòng tiêu-rồi-được-hoàn thôi hội tụ.
  //    Chú thích cũ ở đúng dòng này ghi "(tư-cách, §6.2)" — chính cái nhầm mà bên Aiken
  //    đã viết hẳn một khối để cảnh báo (math.ak ▸ compute_reward_from_consumed).
  pmQ     : bigint,
): bigint {
  const s1 = consumed * INSTANT_REWARD_RATE_Q / Q;  // step 1
  const s2 = s1 * umQ / Q;                           // step 2
  const s3 = s2 * pmQ / Q;                           // step 3
  return s3;
}

/**
 * cap_surplus(br):
 *   xanh (br >  br_safe):  f · S · (br − br_safe) / br_safe
 *   đỏ   (br ≤  br_safe):  0  (khoá Gen)
 *
 * Sequential floors:
 *   s1 = ⌊ S  × f_q       / Q ⌋
 *   s2 = ⌊ s1 × (br−safe) / Q ⌋
 *   s3 = ⌊ s2 × Q / br_safe_q ⌋
 *
 * `brQ`/`magicSupply` come from the BackingBeacon reference input. There is NO
 * default: a missing/stale/depegged beacon must stop the tx before this call.
 *
 * Mirrors math.ak: compute_cap_surplus.
 */
export function computeCapSurplus(brQ: bigint, magicSupply: bigint): bigint {
  if (brQ <= BR_SAFE_Q) return 0n;
  const excessQ = brQ - BR_SAFE_Q;
  const s1 = magicSupply * F_CAP_SURPLUS_Q / Q;
  const s2 = s1 * excessQ / Q;
  return s2 * Q / BR_SAFE_Q;
}

/**
 * ScheduleGen's S_Q, mirrored so `instantRateQDerived` can recompute the rate
 * constant instead of trusting a literal. `l` is a schedule LENGTH IN EPOCHS,
 * not a LAMP amount — `compute_s_q` is called with `schedule_length` at
 * `ScheduleGen/onchain/validators/vault.ak:291`.
 *
 * Mirrors math.ak: compute_s_q.
 */
export function computeSq(l: bigint): bigint {
  if (l <= S_SEG2_KNEE) return S_SEG1_INTERCEPT_Q + S_SEG1_SLOPE_Q * l;
  if (l <= S_SEG3_KNEE) return S_SEG2_INTERCEPT_Q + S_SEG2_SLOPE_Q * (l - S_SEG2_KNEE);
  return S_SEG3_INTERCEPT_Q + S_SEG3_SLOPE_Q * (l - S_SEG3_KNEE);
}

/** Mirrors math.ak: instant_rate_q_derived. A test pins it against the literal. */
export function instantRateQDerived(): bigint {
  return SNAPSHOT_BASE_RATE_Q * computeSq(SCHEDULE_MIN_LENGTH) / Q;
}

/**
 * Third brake: cap_pp = ⌊ ⌊ L_avail × INSTANT_RATE_Q / Q ⌋ / 2 ⌋.
 *
 * `lAvailOildrop = lamp_balance − lamp_locked`, result in nanogic.
 *
 * Replaces the old `0.5 × Σ gen_schedules` (D2). That form read 0 for a vault
 * with no schedule, which is why InstantGen could not issue at all (Nợ #19);
 * and SPEC §6.3's stated replacement, `RATE_REF_Q = 10¹²`, pays 250× what this
 * ceiling allows for the same LAMP. Rate rationale in
 * `onchain/lib/magiclamp/protocol/constants.ak` ▸ `instant_rate_q`.
 *
 * Mirrors math.ak: compute_cap_pp. Two sequential floors, not one fused
 * division — §6.1.
 */
export function computeCapPp(lAvailOildrop: bigint): bigint {
  const perEpoch = lAvailOildrop * INSTANT_RATE_Q / Q;
  return perEpoch / 2n;
}

/** The whole §6.3 gate. Mirrors math.ak: compute_instant_grant. */
export function computeInstantGrant(
  consumed      : bigint,
  umQ           : bigint,
  pmQ           : bigint,
  brQ           : bigint,
  magicSupply   : bigint,
  lAvailOildrop : bigint,
): bigint {
  return min3(
    computeRewardFromConsumed(consumed, umQ, pmQ),
    computeCapSurplus(brQ, magicSupply),
    computeCapPp(lAvailOildrop),
  );
}

// ── L_lent — LAMP-mượn từ két Wakeme (CC-GEN-LENT-READ) ──────
//   capLent  = min(capPp(L_lent), LENT_PP_CAP)
//   capTotal = capPp(L_avail) + capLent
//   grant    = min(reward, capSurplus, capTotal)

/** Phần trần từ L_lent (oildrop), nanogic/epoch. Mirrors math.ak: compute_cap_lent. */
export function computeCapLent(lLentOildrop: bigint): bigint {
  return min2(computeCapPp(lLentOildrop), LENT_PP_CAP);
}

/** §6.3 gate với trần theo LAMP tính sẵn. Mirrors math.ak: compute_instant_grant_capped. */
export function computeInstantGrantCapped(
  consumed    : bigint,
  umQ         : bigint,
  pmQ         : bigint,
  brQ         : bigint,
  magicSupply : bigint,
  capLamp     : bigint,
): bigint {
  return min3(
    computeRewardFromConsumed(consumed, umQ, pmQ),
    computeCapSurplus(brQ, magicSupply),
    capLamp,
  );
}

/** §6.3 gate đủ hai nguồn LAMP. Mirrors math.ak: compute_instant_grant_with_lent.
 *  `lLentOildrop = 0n` cho đúng `computeInstantGrant`. */
export function computeInstantGrantWithLent(
  consumed      : bigint,
  umQ           : bigint,
  pmQ           : bigint,
  brQ           : bigint,
  magicSupply   : bigint,
  lAvailOildrop : bigint,
  lLentOildrop  : bigint,
): bigint {
  return computeInstantGrantCapped(
    consumed, umQ, pmQ, brQ, magicSupply,
    computeCapPp(lAvailOildrop) + computeCapLent(lLentOildrop),
  );
}

// ── C-UM-6: UM for Instant ───────────────────────────────────
//
// staleness = current_epoch − UM_datum.last_updated_epoch
// ≤ 1 → use smoothed; > 1 → UM_FALLBACK_Q = 500_000_000
//
// TV-UM-SPLIT: smoothed=2B, last_updated=98, current=100
//   → staleness=2 > 1 → result = 500_000_000 ✓

export function getUmForInstant(um: UmReading, currentEpoch: bigint): bigint {
  const staleness = currentEpoch - um.last_updated_epoch;
  if (staleness <= UM_MAX_STALENESS) {
    return um.smoothed_q;
  }
  return UM_FALLBACK_Q;
}

// ── §4.2 batch lifetime (CLIFF) ──────────────────────────────
//
// k = 0            → LIVE (full current_amount, burnable)
// k ≥ decay_window → DEAD (worth 0, NOT burnable, garbage-collectable)
//
// with decay_window = 1 for every source. There is no halving step at any k.

export function isExpired(
  createdEpoch: bigint,
  decayWindow : bigint,
  currentEpoch: bigint,
): boolean {
  return (currentEpoch - createdEpoch) >= decayWindow;
}

/**
 * MAGIC đã sinh qua InstantGen trong CHỈ SỐ epoch này, đọc từ các batch còn sống.
 * Gương của `decay.ak ▸ instant_gen_in_epoch` (P8): cộng `initial_amount` (không phải
 * `current_amount` — đã tiêu vẫn tính là đã sinh) của mọi batch `source == Instant`
 * có `created_epoch == currentEpoch`. Bốn điều kiện giữ phép suy đứng nằm cạnh bản Aiken.
 */
export function instantGenInEpoch(
  batches     : ReadonlyArray<{ source: string; created_epoch: bigint; initial_amount: bigint }>,
  currentEpoch: bigint,
): bigint {
  let acc = 0n;
  for (const b of batches) {
    if (b.source === "Instant" && b.created_epoch === currentEpoch) acc += b.initial_amount;
  }
  return acc;
}

/**
 * Gương của `profile.ak ▸ apply_pending_profile`: hồ sơ chờ đã tới hạn thì áp, và
 * `pending_profile` về rỗng. Mọi nhánh của két InstantGen tính trên bản ĐÃ ÁP (hệ số PM
 * lẫn phép so datum ra), nên bộ dựng phải áp trước khi tính bất cứ gì.
 *
 * CHỈ InstantGen: ScheduleGen so datum ra với datum vào THÔ, áp ở đó là sai.
 */
export function applyPendingProfile<
  T extends { profile: unknown; pending_profile: { new_profile: unknown; effective_epoch: bigint } | null },
>(datum: T, currentEpoch: bigint): T {
  const pending = datum.pending_profile;
  if (pending === null || pending === undefined) return datum;
  if (currentEpoch < pending.effective_epoch) return datum;
  return { ...datum, profile: pending.new_profile, pending_profile: null } as T;
}

export function isLive(
  createdEpoch: bigint,
  decayWindow : bigint,
  currentEpoch: bigint,
): boolean {
  return !isExpired(createdEpoch, decayWindow, currentEpoch);
}

/** Live balance of a batch — 0 once the cliff has passed. */
export function batchBalance(
  currentAmount: bigint,
  decayWindow  : bigint,
  createdEpoch : bigint,
  currentEpoch : bigint,
): bigint {
  const k = currentEpoch - createdEpoch;
  if (k < 0n) throw new Error("Negative batch age");
  if (k >= decayWindow) return 0n;
  return currentAmount;
}

// (unit conversions and display helpers are re-exported from
// @magiclamp/protocol-utils — see top of file)
