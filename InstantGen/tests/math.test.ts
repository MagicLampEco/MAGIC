// tests/math.test.ts — BigInt math engine unit tests (PHA 2)
// Run: npx vitest run ../tests/math.test.ts
// ALL tests must pass before submitting any on-chain tx.

import { describe, it, expect } from "vitest";
import {
  computeRewardFromConsumed,
  computeCapSurplus,
  computePpSchedule,
  computeCapPp,
  computeInstantGrant,
  getUmForInstant,
  isExpired,
  isLive,
  batchBalance,
  slotToEpoch,
  lampToOildrop,
  nanogicToMagicStr,
} from "../offchain/src/math.js";
import {
  TV_CLIFF_01, TV_CLIFF_02,
  TV_IG_REWARD_01, TV_IG_REWARD_02, TV_IG_REWARD_03, TV_IG_REWARD_ZERO,
  TV_IG_CAP_SURPLUS_01, TV_IG_CAP_SURPLUS_02, TV_IG_CAP_SURPLUS_03,
  TV_IG_CAP_PP_01, TV_IG_CAP_PP_02, TV_IG_CAP_PP_ZERO,
  TV_IG_GRANT_01, TV_IG_GRANT_02, TV_IG_GRANT_03,
  TV_UM_SPLIT, TV_UM_FRESH,
  TV_OVERFLOW_01,
} from "./vectors.js";
import {
  UM_FALLBACK_Q, UM_MAX_Q, Q, INSTANT_REWARD_RATE_Q, PM_Q,
  MAGIC_DECAY_WINDOW, F_CAP_SURPLUS_Q, BR_SAFE_Q,
} from "../offchain/src/constants.js";

// ═══════════════════════════════════════════════════════════════
// §6.3 reward(consumed) — magnitude keyed to MAGIC CONSUMED
// ═══════════════════════════════════════════════════════════════

describe("computeRewardFromConsumed — §6.3", () => {

  it("TV-IG-REWARD-01: 1 MAGIC consumed, Flame, UM=1.0 → 0.21 MAGIC", () => {
    const { input, expected_nanogic, steps } = TV_IG_REWARD_01;
    const result = computeRewardFromConsumed(input.consumed, input.um_q, input.pm_q);
    expect(result).toBe(expected_nanogic);

    // Verify the three sequential floor steps individually (L4 error analysis)
    const s1 = input.consumed * INSTANT_REWARD_RATE_Q / Q;
    const s2 = s1 * input.um_q / Q;
    const s3 = s2 * input.pm_q / Q;
    expect(s1).toBe(steps.s1);
    expect(s2).toBe(steps.s2);
    expect(s3).toBe(steps.s3);
    expect(nanogicToMagicStr(result)).toBe("0.2100");
  });

  it("TV-IG-REWARD-02: 5 MAGIC consumed, Ember, UM=1.5 → 1.725 MAGIC", () => {
    const { input, expected_nanogic } = TV_IG_REWARD_02;
    expect(computeRewardFromConsumed(input.consumed, input.um_q, input.pm_q))
      .toBe(expected_nanogic);
  });

  it("TV-IG-REWARD-ZERO: holding LAMP without consuming yields exactly 0", () => {
    const { input, expected_nanogic } = TV_IG_REWARD_ZERO;
    expect(computeRewardFromConsumed(input.consumed, input.um_q, input.pm_q))
      .toBe(expected_nanogic);
  });

  it("TV-IG-REWARD-03 / INV-CASHBACK-BOUND: reward ≤ consumed at UM_MAX × PM_MAX", () => {
    const { input, expected_nanogic } = TV_IG_REWARD_03;
    const result = computeRewardFromConsumed(input.consumed, input.um_q, input.pm_q);
    expect(result).toBe(expected_nanogic);
    expect(result).toBeLessThan(input.consumed);       // strict — self-burn is net-negative
    // 0.20 × 2.00 × 1.15 = 0.46
    expect(result * 1000n / input.consumed).toBe(460n);
  });

  it("INV-CASHBACK-BOUND holds for every profile at UM_MAX, over a wide range", () => {
    for (const pmQ of Object.values(PM_Q)) {
      for (const consumed of [
        1n, 7n, 999n, 1_000_000_000n, 123_456_789_012n, 36_000_000_000_000_000n,
      ]) {
        const r = computeRewardFromConsumed(consumed, UM_MAX_Q, pmQ);
        expect(r).toBeLessThanOrEqual(consumed);
      }
    }
  });

  it("L4: 3 sequential floors never exceed the exact value", () => {
    const consumed = 123_456_789_012n;
    const umQ = 1_234_567_890n;
    const pmQ = 1_050_000_000n;
    const actual = computeRewardFromConsumed(consumed, umQ, pmQ);
    const exact  = consumed * INSTANT_REWARD_RATE_Q * umQ * pmQ / (Q * Q * Q);
    expect(actual).toBeLessThanOrEqual(exact);
    expect(exact - actual).toBeLessThanOrEqual(3n);   // ≤ 3 nanogic
  });

  it("Monotonic in consumed — more real consumption never pays less", () => {
    let prev = -1n;
    for (let c = 0n; c <= 20_000_000_000n; c += 1_000_000_000n) {
      const r = computeRewardFromConsumed(c, 1_000_000_000n, PM_Q.Flame!);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// §6.3 cap_surplus(br) — the backing gate
// ═══════════════════════════════════════════════════════════════

describe("computeCapSurplus — §6.3", () => {

  it("TV-IG-CAP-SURPLUS-01: br=2.0, S=1000 MAGIC → 33.333333333 MAGIC", () => {
    const { input, expected_nanogic, steps } = TV_IG_CAP_SURPLUS_01;
    expect(computeCapSurplus(input.br_q, input.magic_supply)).toBe(expected_nanogic);

    // sequential floors, spelled out
    const s1 = input.magic_supply * F_CAP_SURPLUS_Q / Q;
    const excess = input.br_q - BR_SAFE_Q;
    const s2 = s1 * excess / Q;
    expect(s1).toBe(steps.s1);
    expect(excess).toBe(steps.excess_q);
    expect(s2).toBe(steps.s2);
    expect(s2 * Q / BR_SAFE_Q).toBe(expected_nanogic);
  });

  it("TV-IG-CAP-SURPLUS-02: br exactly at br_safe is RED (≤, not <) → 0", () => {
    const { input, expected_nanogic } = TV_IG_CAP_SURPLUS_02;
    expect(computeCapSurplus(input.br_q, input.magic_supply)).toBe(expected_nanogic);
  });

  it("TV-IG-CAP-SURPLUS-03: br below br_safe → Gen locked", () => {
    const { input, expected_nanogic } = TV_IG_CAP_SURPLUS_03;
    expect(computeCapSurplus(input.br_q, input.magic_supply)).toBe(expected_nanogic);
  });

  it("br just above br_safe opens a tiny door, never a negative one", () => {
    const cap = computeCapSurplus(BR_SAFE_Q + 1n, 1_000_000_000_000n);
    expect(cap).toBeGreaterThanOrEqual(0n);
    expect(cap).toBeLessThan(computeCapSurplus(2_000_000_000n, 1_000_000_000_000n));
  });

  it("Monotonic in br: healthier backing never allows less", () => {
    let prev = -1n;
    for (let br = BR_SAFE_Q; br <= 5_000_000_000n; br += 100_000_000n) {
      const cap = computeCapSurplus(br, 1_000_000_000_000n);
      expect(cap).toBeGreaterThanOrEqual(prev);
      prev = cap;
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// §6.3 0.5 × pp_schedule — dual ceiling
// ═══════════════════════════════════════════════════════════════

describe("computePpSchedule / computeCapPp — §6.3 trần-kép", () => {

  it("TV-IG-CAP-PP-01: one schedule → pp=45 MAGIC, cap=22.5 MAGIC", () => {
    const v = TV_IG_CAP_PP_01;
    expect(computePpSchedule(v.schedules)).toBe(v.expected_pp);
    expect(computeCapPp(v.schedules)).toBe(v.expected_cap);
  });

  it("TV-IG-CAP-PP-02: pp sums over every live contract", () => {
    const v = TV_IG_CAP_PP_02;
    expect(computePpSchedule(v.schedules)).toBe(v.expected_pp);
    expect(computeCapPp(v.schedules)).toBe(v.expected_cap);
  });

  it("TV-IG-CAP-PP-ZERO: no ScheduleGen contract ⟹ cap = 0 ⟹ InstantGen shut", () => {
    const v = TV_IG_CAP_PP_ZERO;
    expect(computePpSchedule(v.schedules)).toBe(v.expected_pp);
    expect(computeCapPp(v.schedules)).toBe(v.expected_cap);
  });
});

// ═══════════════════════════════════════════════════════════════
// §6.3 the whole gate
// ═══════════════════════════════════════════════════════════════

describe("computeInstantGrant — §6.3 min of three ceilings", () => {

  it("TV-IG-GRANT-01: reward is the binding ceiling", () => {
    const { input, ceilings, expected_grant } = TV_IG_GRANT_01;
    expect(computeRewardFromConsumed(input.consumed, input.um_q, input.pm_q))
      .toBe(ceilings.reward);
    expect(computeCapSurplus(input.br_q, input.magic_supply)).toBe(ceilings.cap_surplus);
    expect(computeCapPp(input.schedules)).toBe(ceilings.cap_pp);
    expect(computeInstantGrant(
      input.consumed, input.um_q, input.pm_q,
      input.br_q, input.magic_supply, input.schedules,
    )).toBe(expected_grant);
  });

  it("TV-IG-GRANT-02: a whale is still capped at 0.5 × pp_schedule", () => {
    const { input, ceilings, expected_grant } = TV_IG_GRANT_02;
    expect(computeRewardFromConsumed(input.consumed, input.um_q, input.pm_q))
      .toBe(ceilings.reward);
    expect(computeInstantGrant(
      input.consumed, input.um_q, input.pm_q,
      input.br_q, input.magic_supply, input.schedules,
    )).toBe(expected_grant);
    // The whale's own reward is an order of magnitude above what it receives.
    expect(ceilings.reward).toBeGreaterThan(expected_grant);
  });

  it("TV-IG-GRANT-03: red backing shuts the door regardless of consumption", () => {
    const { input, expected_grant } = TV_IG_GRANT_03;
    expect(computeInstantGrant(
      input.consumed, input.um_q, input.pm_q,
      input.br_q, input.magic_supply, input.schedules,
    )).toBe(expected_grant);
  });

  it("No schedule ⟹ grant 0 even with healthy backing and heavy consumption", () => {
    expect(computeInstantGrant(
      1_000_000_000_000n, 2_000_000_000n, PM_Q.Ember!,
      3_000_000_000n, 1_000_000_000_000n, [],
    )).toBe(0n);
  });
});

// ═══════════════════════════════════════════════════════════════
// C-UM-6 UM staleness check
// ═══════════════════════════════════════════════════════════════

describe("getUmForInstant — C-UM-6", () => {

  it("TV-UM-SPLIT: stale UM (staleness=2) → UM_FALLBACK_Q (500M)", () => {
    const { um_datum, current_epoch, instant_result } = TV_UM_SPLIT;
    const result = getUmForInstant(um_datum, current_epoch);
    expect(result).toBe(instant_result);
    expect(result).toBe(UM_FALLBACK_Q);
  });

  it("TV-UM-FRESH: fresh UM (staleness=1) → smoothed (1.5B)", () => {
    const { um_datum, current_epoch, instant_result } = TV_UM_FRESH;
    const result = getUmForInstant(um_datum, current_epoch);
    expect(result).toBe(instant_result);
    expect(result).toBe(um_datum.smoothed_q);
  });

  it("staleness=0 (same epoch as update) → smoothed", () => {
    const um = { smoothed_q: 1_800_000_000n, last_updated_epoch: 100n, history: [] };
    expect(getUmForInstant(um, 100n)).toBe(1_800_000_000n);
  });

  it("staleness=2 (just over limit) → fallback", () => {
    const um = { smoothed_q: 1_800_000_000n, last_updated_epoch: 98n, history: [] };
    expect(getUmForInstant(um, 100n)).toBe(UM_FALLBACK_Q);
  });

  it("very large staleness → fallback (not panic)", () => {
    const um = { smoothed_q: 2_000_000_000n, last_updated_epoch: 0n, history: [] };
    expect(getUmForInstant(um, 100n)).toBe(UM_FALLBACK_Q);
  });

  it("A stale UM halves the grant instead of rejecting the tx", () => {
    const fresh = computeRewardFromConsumed(1_000_000_000n, 1_000_000_000n, PM_Q.Flame!);
    const stale = computeRewardFromConsumed(1_000_000_000n, UM_FALLBACK_Q, PM_Q.Flame!);
    expect(fresh).toBe(210_000_000n);
    expect(stale).toBe(105_000_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
// §4.2 CLIFF — one live epoch, nothing else
// ═══════════════════════════════════════════════════════════════

describe("§4.2 per-epoch use-or-lose cliff", () => {

  it("decay_window is 1 for every source", () => {
    expect(MAGIC_DECAY_WINDOW).toBe(1n);
  });

  it("TV-CLIFF-01: live at k=0, dead from k=1 — no halving in between", () => {
    const { input, cases } = TV_CLIFF_01;
    for (const c of cases) {
      expect(isExpired(input.created_epoch, input.decay_window, c.current_epoch))
        .toBe(c.expired);
      expect(isLive(input.created_epoch, input.decay_window, c.current_epoch))
        .toBe(!c.expired);
      expect(batchBalance(input.current_amount, input.decay_window,
                          input.created_epoch, c.current_epoch))
        .toBe(c.balance);
    }
  });

  it("TV-CLIFF-02: unconsumed MAGIC does NOT carry over", () => {
    const v = TV_CLIFF_02;
    const leftover = v.epoch_100_granted - v.epoch_100_consumed;
    expect(leftover).toBeGreaterThan(0n);
    // ...yet the balance at the next epoch is zero.
    expect(batchBalance(leftover, 1n, 100n, 101n)).toBe(v.epoch_101_balance);
  });

  it("batchBalance throws on a negative age (C-DECAY-2)", () => {
    expect(() => batchBalance(1_000n, 1n, 100n, 99n)).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// C-OVERFLOW: BigInt is mandatory
// ═══════════════════════════════════════════════════════════════

describe("C-OVERFLOW — BigInt everywhere", () => {

  it("TV-OVERFLOW-01: cap_surplus intermediate exceeds Number.MAX_SAFE_INTEGER", () => {
    const v = TV_OVERFLOW_01;
    const intermediate = v.magic_supply * v.f_cap_surplus;
    expect(intermediate).toBe(v.intermediate);
    expect(intermediate / Q).toBe(v.step1_after_div);
    // The same magnitude via Number would be lossy:
    expect(Number(intermediate)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it("Whole-supply inputs stay exact through the reward chain", () => {
    const consumed = 36_000_000_000_000_000n;   // entire LAMP supply as nanogic
    const r = computeRewardFromConsumed(consumed, UM_MAX_Q, PM_Q.Ember!);
    expect(typeof r).toBe("bigint");
    expect(r).toBe(16_560_000_000_000_000n);    // 0.46 × 36×10^15, exact
    expect(r).toBeLessThan(consumed);           // INV-CASHBACK-BOUND still holds
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

  it("lampToOildrop: 1 LAMP = 10^6 oildrop", () => {
    expect(lampToOildrop(1n)).toBe(1_000_000n);
    expect(lampToOildrop(1000n)).toBe(1_000_000_000n);
  });

  it("nanogicToMagicStr formats correctly", () => {
    expect(nanogicToMagicStr(210_000_000n)).toBe("0.2100");
    expect(nanogicToMagicStr(1_000_000_000n)).toBe("1.0000");
    expect(nanogicToMagicStr(0n)).toBe("0.0000");
  });
});
