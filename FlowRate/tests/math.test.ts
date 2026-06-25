import { describe, test, expect } from 'vitest';
import { updateFlowRate, adaptiveCap, divergence, blendWeightFast, HARD_FLOOR_Q, HARD_CEIL_Q, MIN_MAGIC_EPOCH } from '../offchain/src/math.js';
import { Q, FlowRateDatum } from '../offchain/src/types.js';
import {
  INITIAL_STATE, TV_FR_STABLE, TV_FR_ZERO_MAGIC, TV_FR_BELOW_THRESHOLD,
  TV_FR_FLOOR, TV_FR_OVERFLOW, TV_FR_MANIP_1EPOCH, TV_FR_CAP_ENFORCEMENT,
  TV_FR_GENUINE_CHANGE_EPOCHS, TV_FR_GENUINE_CHANGE_FLOW, TV_FR_GENUINE_CHANGE_EXPECTED_RANGE,
  TV_FR_MANIP_6EPOCH_FLOW, TV_FR_MANIP_6EPOCH_MAX_SLOW, TV_FR_LAMPNET,
} from './vectors.js';

describe('FlowRate — dual-EMA adaptive cap', () => {

  // Helper to run N epochs with same flow
  function runEpochs(state: FlowRateDatum, flow_per_epoch: Omit<typeof TV_FR_STABLE.flow, 'epoch'>, n: number): FlowRateDatum {
    let s = state;
    for (let i = 1; i <= n; i++) {
      s = updateFlowRate(s, { ...flow_per_epoch, epoch: state.last_epoch + i });
    }
    return s;
  }

  // ── TV-FR-01: Stable market ──────────────────────────────────────────────
  test('TV-FR-01: stable market → rate stays flat', () => {
    const result = updateFlowRate(INITIAL_STATE, TV_FR_STABLE.flow);
    // Rate should barely change (both EMAs tracking same raw rate)
    expect(result.lamp_per_magic_q).toBe(TV_FR_STABLE.expected_rate_q);
    expect(result.div_q).toBe(TV_FR_STABLE.expected_div);
    expect(result.cap_q).toBe(TV_FR_STABLE.expected_cap);
    expect(result.last_epoch).toBe(1);
  });

  // ── TV-FR-02: Genuine long-term change ──────────────────────────────────
  test('TV-FR-02: genuine LAMP price drop → rate converges over 15 epochs', () => {
    const state = runEpochs(INITIAL_STATE, TV_FR_GENUINE_CHANGE_FLOW, TV_FR_GENUINE_CHANGE_EPOCHS);
    expect(state.lamp_per_magic_q).toBeGreaterThanOrEqual(TV_FR_GENUINE_CHANGE_EXPECTED_RANGE[0]);
    expect(state.lamp_per_magic_q).toBeLessThanOrEqual(TV_FR_GENUINE_CHANGE_EXPECTED_RANGE[1]);
    console.log('After 15 epochs genuine change: rate =', state.lamp_per_magic_q.toString());
  });

  // ── TV-FR-03: 1-epoch manipulation spike ────────────────────────────────
  test('TV-FR-03: 1-epoch spike → rate changes < 10% (adaptive cap tightens to 7.7% at 75% div)', () => {
    const result = updateFlowRate(INITIAL_STATE, TV_FR_MANIP_1EPOCH.flow);
    const prev = INITIAL_STATE.lamp_per_magic_q;
    const change_pct = result.lamp_per_magic_q > prev
      ? (result.lamp_per_magic_q - prev) * 100n / prev
      : (prev - result.lamp_per_magic_q) * 100n / prev;
    console.log('1-epoch spike change %:', change_pct.toString(), 'div_q:', result.div_q.toString(), 'cap_q:', result.cap_q.toString());
    expect(change_pct).toBeLessThanOrEqual(TV_FR_MANIP_1EPOCH.max_allowed_change_pct);
  });

  // ── TV-FR-04: 6-epoch sustained manipulation ────────────────────────────
  test('TV-FR-04: 6-epoch sustained manipulation → slow EMA resists (< 0.3 LAMP/MAGIC)', () => {
    const state = runEpochs(INITIAL_STATE, TV_FR_MANIP_6EPOCH_FLOW, 6);
    console.log('After 6 manip epochs: fast=', state.ema_fast_q.toString(), 'slow=', state.ema_slow_q.toString(), 'rate=', state.lamp_per_magic_q.toString());
    // slow EMA (α=1/12) moves slowly — after 6 epochs from 100M toward 500M target
    // slow stays well below 500M (attack target), proving manipulation resistance
    expect(state.ema_slow_q).toBeLessThan(TV_FR_MANIP_6EPOCH_MAX_SLOW);
    // Also verify: actual lamp_per_magic_q resists — it should be much less than attack target
    expect(state.lamp_per_magic_q).toBeLessThan(TV_FR_MANIP_6EPOCH_MAX_SLOW);
  });

  // ── TV-FR-05: Zero activity ──────────────────────────────────────────────
  test('TV-FR-05: zero magic → state unchanged', () => {
    const result = updateFlowRate(INITIAL_STATE, TV_FR_ZERO_MAGIC.flow);
    expect(result.lamp_per_magic_q).toBe(INITIAL_STATE.lamp_per_magic_q);
    expect(result.ema_fast_q).toBe(INITIAL_STATE.ema_fast_q);
    expect(result.ema_slow_q).toBe(INITIAL_STATE.ema_slow_q);
  });

  // ── TV-FR-06: Below threshold ─────────────────────────────────────────────
  test('TV-FR-06: below MIN_MAGIC_EPOCH → state unchanged (only epoch advances)', () => {
    const result = updateFlowRate(INITIAL_STATE, TV_FR_BELOW_THRESHOLD.flow);
    expect(result.lamp_per_magic_q).toBe(INITIAL_STATE.lamp_per_magic_q);
    expect(result.ema_fast_q).toBe(INITIAL_STATE.ema_fast_q);
  });

  // ── TV-FR-07: Hard floor ──────────────────────────────────────────────────
  test('TV-FR-07: very low raw rate → clamp at HARD_FLOOR_Q', () => {
    const result = runEpochs(INITIAL_STATE, { total_lamp_oildrop: 1n, total_magic_ng: 1_000_000_000_000n }, 50);
    expect(result.lamp_per_magic_q).toBeGreaterThanOrEqual(HARD_FLOOR_Q);
    expect(result.ema_fast_q).toBeGreaterThanOrEqual(HARD_FLOOR_Q);
    expect(result.ema_slow_q).toBeGreaterThanOrEqual(HARD_FLOOR_Q);
  });

  // ── TV-FR-08: BigInt overflow safety ──────────────────────────────────────
  test('TV-FR-08: very high lamp → clamp at HARD_CEIL_Q', () => {
    const result = updateFlowRate(INITIAL_STATE, TV_FR_OVERFLOW.flow);
    expect(result.lamp_per_magic_q).toBeLessThanOrEqual(HARD_CEIL_Q);
    expect(result.ema_fast_q).toBeLessThanOrEqual(HARD_CEIL_Q);
    expect(result.ema_slow_q).toBeLessThanOrEqual(HARD_CEIL_Q);
  });

  // ── TV-FR-09: Rate-of-change cap ─────────────────────────────────────────
  test('TV-FR-09: 10× raw rate → output bounded by adaptive cap', () => {
    const prev = TV_FR_CAP_ENFORCEMENT.prev_rate;
    const state = { ...INITIAL_STATE, lamp_per_magic_q: prev, ema_fast_q: prev, ema_slow_q: prev };
    const result = updateFlowRate(state, {
      total_lamp_oildrop: TV_FR_CAP_ENFORCEMENT.high_raw_rate_lamp,
      total_magic_ng: TV_FR_CAP_ENFORCEMENT.high_raw_rate_magic,
      epoch: 1,
    });
    console.log('Cap enforcement: rate=', result.lamp_per_magic_q.toString(), 'cap_q=', result.cap_q.toString());
    expect(result.lamp_per_magic_q).toBeLessThanOrEqual(TV_FR_CAP_ENFORCEMENT.max_allowed);
  });

  // ── TV-FR-10: LampNet pricing math ───────────────────────────────────────
  test('TV-FR-10: LampNet 1MB permanent → correct nanogic amount', () => {
    const { kb_per_mb, perm_nanogic_per_kb, magic_for_1mb_perm, lamp_cap_at_rate_01 } = TV_FR_LAMPNET;
    expect(magic_for_1mb_perm).toBe(kb_per_mb * perm_nanogic_per_kb);
    expect(lamp_cap_at_rate_01).toBe(magic_for_1mb_perm * 100_000_000n / Q);
    // 1024 × 200 × 0.1 / Q = 204800 × 0.1 = 20480 oildrop
    expect(lamp_cap_at_rate_01).toBe(20_480n);
    console.log('1MB perm storage = ', magic_for_1mb_perm.toString(), 'nanogic → lamp_cap =', lamp_cap_at_rate_01.toString(), 'oildrop');
  });

  // ── Component tests ───────────────────────────────────────────────────────
  describe('adaptiveCap', () => {
    test('div=0 → cap=25%', () => {
      expect(adaptiveCap(0n)).toBe(250_000_000n);
    });
    test('div=33% → cap < 25% and > 5%', () => {
      // cap = 250M × Q / (Q + 3 × 333M) = 250M × 10^9 / (10^9 + 999M) ≈ 125M
      const cap = adaptiveCap(333_333_333n);
      expect(cap).toBeLessThan(250_000_000n);
      expect(cap).toBeGreaterThan(50_000_000n);  // above floor
    });
    test('div=very large → cap floors at 5%', () => {
      expect(adaptiveCap(10_000_000_000n)).toBe(50_000_000n);
    });
  });

  describe('blendWeightFast', () => {
    test('div=0 → w_fast=70%', () => {
      expect(blendWeightFast(0n)).toBe(700_000_000n);
    });
    test('div>=10% → w_fast=0 (full slow trust)', () => {
      expect(blendWeightFast(100_000_000n)).toBe(0n);
      expect(blendWeightFast(500_000_000n)).toBe(0n);
    });
    test('div=5% → w_fast=35%', () => {
      // (10% - 5%) / 10% × 70% = 50% × 70% = 35%
      expect(blendWeightFast(50_000_000n)).toBe(350_000_000n);
    });
  });

  describe('divergence', () => {
    test('same values → 0', () => {
      expect(divergence(100n, 100n)).toBe(0n);
    });
    test('fast 50% above slow → 50%', () => {
      expect(divergence(150n, 100n)).toBe(500_000_000n);  // 50% in Q-format
    });
    test('slow=0 → 0 (guard)', () => {
      expect(divergence(100n, 0n)).toBe(0n);
    });
  });
});
