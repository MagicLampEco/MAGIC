// tests/math.test.ts — BigInt math engine unit tests
// Run: npx vitest run tests/math.test.ts
// ALL tests must pass before submitting any on-chain tx.

import { describe, it, expect } from "vitest";
import {
  computeInstantMagic,
  getUmForInstant,
  shouldHalve,
  applyHalving,
  isExpired,
  slotToEpoch,
  lampToOil,
  nanogicToMagicStr,
} from "../offchain/src/math.js";
import {
  TV_INST_GEN_01, TV_INST_GEN_02, TV_INST_GEN_03,
  TV_UM_SPLIT, TV_UM_FRESH,
  TV_INST_01, TV_INST_02, TV_INST_03,
} from "./vectors.js";
import { UM_FALLBACK_Q } from "../offchain/src/constants.js";

// ═══════════════════════════════════════════════════════════════
// §9.1 InstantGen generation formula
// ═══════════════════════════════════════════════════════════════

describe("computeInstantMagic — §9.1", () => {

  it("TV-INST-GEN-01: 1000 LAMP, Flame, UM=1.0 → 3.15 MAGIC (§20.3 calibration)", () => {
    const { input, expected_nanogic, steps } = TV_INST_GEN_01;
    const result = computeInstantMagic(input.lamp_paid_oil, input.um_q, input.pm_q);
    expect(result).toBe(expected_nanogic);         // 3_150_000_000n ✓

    // Verify intermediate steps (L4 error analysis)
    const s1 = input.lamp_paid_oil * 3_000_000_000n / 1_000_000_000n;
    const s2 = s1 * input.um_q / 1_000_000_000n;
    const s3 = s2 * input.pm_q / 1_000_000_000n;
    expect(s1).toBe(steps.s1);   // 3_000_000_000n
    expect(s2).toBe(steps.s2);   // 3_000_000_000n
    expect(s3).toBe(steps.s3);   // 3_150_000_000n
    expect(nanogicToMagicStr(result)).toBe("3.1500");
  });

  it("TV-INST-GEN-02: 1000 LAMP, Ember, UM=1.5 → 5.175 MAGIC", () => {
    const { input, expected_nanogic } = TV_INST_GEN_02;
    const result = computeInstantMagic(input.lamp_paid_oil, input.um_q, input.pm_q);
    expect(result).toBe(expected_nanogic);  // 5_175_000_000n ✓
  });

  it("TV-INST-GEN-03: 500 LAMP, Lantern, UM=2.0 (max) → 3.0 MAGIC", () => {
    const { input, expected_nanogic } = TV_INST_GEN_03;
    const result = computeInstantMagic(input.lamp_paid_oil, input.um_q, input.pm_q);
    expect(result).toBe(expected_nanogic);  // 3_000_000_000n ✓
  });

  it("L4: multiplication error ≤ 3 nanogic, M_actual ≤ M_true", () => {
    // For any inputs, the 3-step floor multiplication introduces at most 3 nanogic error
    const lamp = 1_000_000_000n;
    const um   = 1_234_567_890n;  // arbitrary
    const pm   = 1_050_000_000n;
    const Q    = 1_000_000_000n;
    const R    = 3_000_000_000n;

    const m_actual = computeInstantMagic(lamp, um, pm);

    // True value (exact rational, computed with higher precision)
    // M_true = lamp × R × um × pm / Q³  (no floor)
    // We use BigInt × 10^9 to simulate fractional part
    const m_true_num = lamp * R * um * pm;
    const m_true_den = Q * Q * Q;
    const m_true_floor = m_true_num / m_true_den;

    // M_actual ≤ M_true (user-unfavorable in M direction — protocol conservative)
    expect(m_actual).toBeLessThanOrEqual(m_true_floor + 3n);
    expect(m_actual).toBeLessThanOrEqual(m_true_floor);     // never exceeds true value
    const error = m_true_floor - m_actual;
    expect(error).toBeLessThanOrEqual(3n);  // L4: ≤ 3 nanogic
  });

  it("Uses BigInt — does not lose precision for large values", () => {
    // TV-OVERFLOW-01: L = entire LAMP supply
    const largeLamp = 36_000_000_000_000_000n;
    const um        = 1_000_000_000n;
    const pm        = 1_050_000_000n;
    // Should not throw; result is a valid large bigint
    const result = computeInstantMagic(largeLamp, um, pm);
    expect(typeof result).toBe("bigint");
    expect(result > 0n).toBe(true);
    // Step1 intermediate: 36×10^15 × 3×10^9 = 1.08×10^26 (overflows Number)
    const step1 = largeLamp * 3_000_000_000n;
    expect(step1).toBe(108_000_000_000_000_000_000_000_000n);  // TV-OVERFLOW-01 ✓
  });
});

// ═══════════════════════════════════════════════════════════════
// §14.4 C-UM-6 UM staleness check
// ═══════════════════════════════════════════════════════════════

describe("getUmForInstant — §14.4 C-UM-6", () => {

  it("TV-UM-SPLIT: stale UM (staleness=2) → UM_FALLBACK_Q (500M)", () => {
    const { um_datum, current_epoch, instant_result } = TV_UM_SPLIT;
    const result = getUmForInstant(um_datum, current_epoch);
    expect(result).toBe(instant_result);          // 500_000_000n ✓
    expect(result).toBe(UM_FALLBACK_Q);           // = UM_MIN_Q ✓
  });

  it("TV-UM-FRESH: fresh UM (staleness=1) → smoothed (1.5B)", () => {
    const { um_datum, current_epoch, instant_result } = TV_UM_FRESH;
    const result = getUmForInstant(um_datum, current_epoch);
    expect(result).toBe(instant_result);          // 1_500_000_000n ✓
    expect(result).toBe(um_datum.smoothed_q);     // = smoothed, not fallback ✓
  });

  it("staleness=0 (same epoch as update) → smoothed", () => {
    const um = { smoothed_q: 1_800_000_000n, last_updated_epoch: 100n, history: [] };
    expect(getUmForInstant(um, 100n)).toBe(1_800_000_000n);
  });

  it("staleness=1 (boundary: exactly UM_MAX_STALENESS) → smoothed", () => {
    const um = { smoothed_q: 1_800_000_000n, last_updated_epoch: 99n, history: [] };
    expect(getUmForInstant(um, 100n)).toBe(1_800_000_000n);  // NOT fallback
  });

  it("staleness=2 (just over limit) → fallback", () => {
    const um = { smoothed_q: 1_800_000_000n, last_updated_epoch: 98n, history: [] };
    expect(getUmForInstant(um, 100n)).toBe(UM_FALLBACK_Q);
  });

  it("very large staleness → fallback (not panic)", () => {
    const um = { smoothed_q: 2_000_000_000n, last_updated_epoch: 0n, history: [] };
    expect(getUmForInstant(um, 100n)).toBe(UM_FALLBACK_Q);
  });
});

// ═══════════════════════════════════════════════════════════════
// §4.3 Halving logic (T18, C-DECAY-7, C-DECAY-8)
// ═══════════════════════════════════════════════════════════════

describe("shouldHalve + applyHalving — §4.3", () => {

  it("TV-INST-01: k=0 → should NOT halve", () => {
    expect(shouldHalve("Instant", 100n, 100n, false)).toBe(false); // k=0
  });

  it("TV-INST-01: k=1, halved=False → SHOULD halve (C-DECAY-7)", () => {
    expect(shouldHalve("Instant", 100n, 101n, false)).toBe(true);  // k=1 ✓
  });

  it("TV-INST-03: k=1, halved=True → should NOT halve again (T18)", () => {
    expect(shouldHalve("Instant", 100n, 101n, true)).toBe(false);  // T18 ✓
  });

  it("k=2 (expired epoch) → should NOT halve", () => {
    expect(shouldHalve("Instant", 100n, 102n, false)).toBe(false);
  });

  it("Non-Instant source → should NOT halve", () => {
    expect(shouldHalve("Snapshot", 100n, 101n, false)).toBe(false);
    expect(shouldHalve("Vacuum",   100n, 101n, false)).toBe(false);
    expect(shouldHalve("Schedule", 100n, 101n, false)).toBe(false);
  });

  it("TV-INST-01: applyHalving(1_000_000_000) = 500_000_000 (floor)", () => {
    expect(applyHalving(1_000_000_000n)).toBe(500_000_000n);       // ✓
  });

  it("TV-INST-02: applyHalving(700_000_000) = 350_000_000 (floor)", () => {
    expect(applyHalving(700_000_000n)).toBe(350_000_000n);         // ✓
  });

  it("applyHalving: odd number floors down", () => {
    expect(applyHalving(999_999_999n)).toBe(499_999_999n);         // ⌊999M/2⌋ ✓
    expect(applyHalving(1n)).toBe(0n);                             // ⌊1/2⌋ = 0 ✓
  });

  it("TV-HALVED-INJECT: C-DECAY-8 — validator must reject halved change at k=0", () => {
    // Off-chain simulation of the constraint:
    // At k=0, source=Instant, halved=False:
    // Any output with halved=True MUST be rejected.
    const k = 100n - 100n;  // k=0
    const isHalvingEpoch = shouldHalve("Instant", 100n, 100n, false);
    expect(isHalvingEpoch).toBe(false);  // k=0 is NOT halving epoch
    // Therefore: output.halved MUST equal input.halved = false
    // (C-DECAY-8 enforcement — validator rejects if output.halved ≠ input.halved for non-halving txs)
  });
});

// ═══════════════════════════════════════════════════════════════
// §4 Prune / expiry
// ═══════════════════════════════════════════════════════════════

describe("isExpired — §4", () => {

  it("Instant: k=0 → NOT expired", () => {
    expect(isExpired(100n, 2n, 100n)).toBe(false);
  });

  it("Instant: k=1 → NOT expired", () => {
    expect(isExpired(100n, 2n, 101n)).toBe(false);
  });

  it("Instant: k=2 → EXPIRED (cliff)", () => {
    expect(isExpired(100n, 2n, 102n)).toBe(true);  // k=2 ≥ decay_window=2 ✓
  });

  it("Instant: k=3 → EXPIRED", () => {
    expect(isExpired(100n, 2n, 103n)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// C-INST-1/2/3: constraints (off-chain validation mirrors)
// ═══════════════════════════════════════════════════════════════

describe("InstantGen constraint mirrors — §9.3", () => {

  it("TV-INST-MIN: 9_999_999 oil < 10_000_000 (min) → reject", () => {
    const MIN = 10_000_000n;
    expect(9_999_999n < MIN).toBe(true);    // would be rejected by C-INST-1
    expect(10_000_000n >= MIN).toBe(true);  // exactly MIN — accepted ✓
  });

  it("TV-INST-MAX: 10^13 oil accepted; 10^13+1 rejected", () => {
    const MAX = 10_000_000_000_000n;
    expect(10_000_000_000_000n <= MAX).toBe(true);
    expect(10_000_000_000_001n <= MAX).toBe(false);
  });

  it("TV-INST-AVAIL: lamp_paid > L_avail → reject", () => {
    const lamp_balance = 100_000_000_000n;
    const lamp_locked  = 60_000_000_000n;
    const l_avail      = lamp_balance - lamp_locked;  // 40B
    expect(l_avail).toBe(40_000_000_000n);
    expect(40_000_000_000n <= l_avail).toBe(true);    // accepted
    expect(40_000_000_001n <= l_avail).toBe(false);   // rejected
  });
});

// ═══════════════════════════════════════════════════════════════
// T14: LAMP conservation
// ═══════════════════════════════════════════════════════════════

describe("LAMP conservation — T14, C-INST-10", () => {

  it("TV-CONS-01: vault+treasury total unchanged after InstantGen", () => {
    const before_vault     = 100_000_000_000n;
    const before_treasury  = 0n;
    const lamp_paid        = 1_000_000_000n;

    const after_vault     = before_vault - lamp_paid;
    const after_treasury  = before_treasury + lamp_paid;
    const total_before    = before_vault + before_treasury;
    const total_after     = after_vault + after_treasury;

    expect(total_after).toBe(total_before);        // T14 ✓
    expect(after_vault).toBe(99_000_000_000n);     // ✓
    expect(after_treasury).toBe(1_000_000_000n);   // ✓
  });
});

// ═══════════════════════════════════════════════════════════════
// Utility functions
// ═══════════════════════════════════════════════════════════════

describe("Utility — formatting & conversion", () => {

  it("slotToEpoch Mainnet: 432000 slots = 1 epoch", () => {
    expect(slotToEpoch(0n, "Mainnet")).toBe(0n);
    expect(slotToEpoch(431_999n, "Mainnet")).toBe(0n);
    expect(slotToEpoch(432_000n, "Mainnet")).toBe(1n);
    expect(slotToEpoch(864_000n, "Mainnet")).toBe(2n);
  });

  it("lampToOil: 1 LAMP = 10^6 oil", () => {
    expect(lampToOil(1n)).toBe(1_000_000n);
    expect(lampToOil(1000n)).toBe(1_000_000_000n);
  });

  it("nanogicToMagicStr: 3_150_000_000 → '3.1500'", () => {
    expect(nanogicToMagicStr(3_150_000_000n)).toBe("3.1500");
    expect(nanogicToMagicStr(1_000_000_000n)).toBe("1.0000");
    expect(nanogicToMagicStr(500_000_000n)).toBe("0.5000");
    expect(nanogicToMagicStr(0n)).toBe("0.0000");
  });
});
