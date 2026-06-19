import { Q } from '../offchain/src/types.js';

// Unit conventions:
//   oil     = LAMP × 10^6  (1 LAMP = 1_000_000 oil)
//   nanogic = MAGIC × 10^9 (1 MAGIC = 1_000_000_000 nanogic)
//
// Q-format rate: lamp_per_magic_q = total_lamp_oil × Q / total_magic_ng
//
// Examples at MIN_MAGIC_EPOCH = 10^12 nanogic (1000 MAGIC minimum per epoch):
//   0.1 LAMP/MAGIC → lamp_per_magic_q = 100_000_000 (= Q/10)
//     total_lamp_oil = 10^8 × 10^12 / 10^9 = 10^11  → 100_000_000_000
//   0.2 LAMP/MAGIC → lamp_per_magic_q = 200_000_000 (= Q/5)
//     total_lamp_oil = 10^8 × 2 × 10^12 / 10^9    → 200_000_000_000
//   0.5 LAMP/MAGIC → lamp_per_magic_q = 500_000_000 (= Q/2)
//     total_lamp_oil = 5 × 10^11                   → 500_000_000_000

// ── Shared base: MIN_MAGIC_EPOCH-safe volumes ─────────────────────────────
// All flows use total_magic_ng = MIN_MAGIC_EPOCH = 10^12 (exactly threshold)
const BASE_MAGIC_NG = 1_000_000_000_000n;  // 10^12 nanogic = 1000 MAGIC

// Initial state cho mọi test
export const INITIAL_STATE = {
  ema_fast_q: 100_000_000n,   // rate_q = Q/10 (0.1 LAMP/MAGIC)
  ema_slow_q: 100_000_000n,
  lamp_per_magic_q: 100_000_000n,
  total_lamp_epoch: 0n,
  total_magic_epoch: 0n,
  last_epoch: 0,
  div_q: 0n,
  cap_q: 250_000_000n,
};

// TV-FR-01: Stable market — rate stays flat
// raw_rate_q = 100_000_000_000 × Q / 10^12 = 100_000_000 = initial_rate_q
// Both EMAs start at 100M, raw=100M → EMA=100M, div=0, cap=25%
export const TV_FR_STABLE = {
  flow: {
    total_lamp_oil: 100_000_000_000n,  // 10^11 oil → rate_q = 100M
    total_magic_ng: BASE_MAGIC_NG,
    epoch: 1,
  },
  expected_rate_q: 100_000_000n,
  expected_div: 0n,
  expected_cap: 250_000_000n,
};

// TV-FR-02: Genuine LAMP price drop over 15 epochs
// Apps pay 0.2 LAMP/MAGIC (rate_q = 200_000_000)
// raw_rate_q = 200_000_000_000 × Q / 10^12 = 200_000_000
// With cap=25%, each epoch rate can grow ≤25%:
//   ep1: 100M × 1.25 = 125M   (blended ~150M, capped 125M)
//   ep2: 125M × 1.25 = 156M   ...after 15 epochs well above 150M
export const TV_FR_GENUINE_CHANGE_EPOCHS = 15;
export const TV_FR_GENUINE_CHANGE_FLOW = {
  total_lamp_oil: 200_000_000_000n,  // rate_q = 200M (0.2 LAMP/MAGIC)
  total_magic_ng: BASE_MAGIC_NG,
};
// After 15 epochs: rate should converge into [150M, 200M]
export const TV_FR_GENUINE_CHANGE_EXPECTED_RANGE = [150_000_000n, 200_000_000n] as const;

// TV-FR-03: Short-term manipulation spike (1 epoch)
// Normal rate 0.1 (rate_q=100M). Attacker submits fake flow at 0.5 LAMP/MAGIC (rate_q=500M)
// raw = 500_000_000_000 × Q / 10^12 = 500_000_000
// fast_ema after: (333M×500M + 666M×100M) / Q = (166.7M + 66.7M) = 233.3M
// slow_ema after: (83M×500M + 916M×100M) / Q ≈ (41.7M + 91.7M) = 133.4M
// div = |233.3 - 133.4| / 133.4 ≈ 74.9%
// → cap = 25%/(1 + 3×74.9%) = 25%/3.25 = 7.7%   (NOT 25% — adaptive cap tightens!)
// → blend goes to 100% slow (div > 10%) → rate_blended ≈ 133.4M
// → max_rate = 100M × (1 + 7.7%) = 107.7M → rate_capped = 107.7M
// → change from 100M: 7.7%
export const TV_FR_MANIP_1EPOCH = {
  flow: {
    total_lamp_oil: 500_000_000_000n,  // rate_q = 500M (0.5 LAMP/MAGIC)
    total_magic_ng: BASE_MAGIC_NG,
    epoch: 1,
  },
  max_allowed_change_pct: 10n,  // at most 10% change — math gives ~7.7%; adaptive cap tightens under high div
};

// TV-FR-04: Sustained manipulation (6 epochs of inflated raw rate)
// Attacker submits 0.5 LAMP/MAGIC for 6 consecutive epochs
// slow EMA (α=1/12) moves: after 6 epochs ≈ 100M+(500M-100M)×(1-(11/12)^6)
//   (11/12)^6 ≈ 0.594 → slow ≈ 100M + 400M×0.406 ≈ 262M
// actual lamp_per_magic_q is further constrained by cap
export const TV_FR_MANIP_6EPOCH_FLOW = {
  total_lamp_oil: 500_000_000_000n,  // rate_q = 500M
  total_magic_ng: BASE_MAGIC_NG,
};
// After 6 epochs: slow EMA < 300M (still well below attack target of 500M)
// lamp_per_magic_q is capped even more strictly
export const TV_FR_MANIP_6EPOCH_MAX_SLOW = 300_000_000n;

// TV-FR-05: Zero activity — state unchanged (only epoch advances)
export const TV_FR_ZERO_MAGIC = {
  flow: { total_lamp_oil: 0n, total_magic_ng: 0n, epoch: 1 },
};

// TV-FR-06: Below activity threshold — state unchanged (only epoch advances)
// MIN_MAGIC_EPOCH = 1_000_000_000_000 nanogic (1000 MAGIC)
export const TV_FR_BELOW_THRESHOLD = {
  flow: {
    total_lamp_oil: 100n,
    total_magic_ng: 999_999_999_999n,  // 1 below MIN_MAGIC_EPOCH
    epoch: 1,
  },
};

// TV-FR-07: Hard floor enforcement
// raw_rate_q = 1 × Q / 10^12 = 0 (integer division) → EMAs decay to HARD_FLOOR
// total_lamp_oil=1 (non-zero passes the lamp guard), total_magic_ng=10^12 (above threshold)
export const TV_FR_FLOOR = {
  flow: { total_lamp_oil: 1n, total_magic_ng: BASE_MAGIC_NG, epoch: 1 },
  expected_min: 10_000_000n,  // HARD_FLOOR_Q
};

// TV-FR-08: BigInt overflow safety
// raw_rate_q = 10^16 × 10^9 / 10^12 = 10^13 >> HARD_CEIL_Q (10^10) → clamped
export const TV_FR_OVERFLOW = {
  flow: {
    total_lamp_oil: 10_000_000_000_000_000n,  // 10^16 oil
    total_magic_ng: BASE_MAGIC_NG,             // 10^12 (above threshold)
    epoch: 1,
  },
  expected_max: 10_000_000_000n, // HARD_CEIL_Q
};

// TV-FR-09: Rate-of-change cap prevents sudden jumps
// Start from balanced state (no divergence → cap=25%)
// raw_rate_q = Q (1.0 LAMP/MAGIC, 10× the initial 0.1)
// Max output: 100M × (1 + 25%) = 125M (given cap=25% and blend will include fast)
// fast_ema after: (333M×Q + 666M×100M) / Q ≈ 333M + 66.7M = 400M
// slow_ema after: (83M×Q + 916M×100M) / Q ≈ 83.3M + 91.7M = 175M
// div = |400M - 175M| / 175M ≈ 129% → blend 100% slow → rate_blended ≈ 175M
// cap = 25%/( 1 + 3×129%) ≈ 5.9% → max = 100M × 1.059 = 105.9M
export const TV_FR_CAP_ENFORCEMENT = {
  prev_rate: 100_000_000n,
  high_raw_rate_lamp: 1_000_000_000_000n,  // rate_q = Q (1.0 LAMP/MAGIC)
  high_raw_rate_magic: BASE_MAGIC_NG,
  max_allowed: 130_000_000n,  // 30% buffer above 100M (cap tightens under high div)
};

// TV-FR-10: LampNet pricing consistency
// LampNet perm: 200 nanogic/KB, 1 MB = 1024 KB → 204_800 nanogic per MB
// At lamp_per_magic_q = 100_000_000 (rate_q = Q/10):
//   lamp_oil = 204_800 nanogic × 100_000_000 / Q = 20_480 oil
export const TV_FR_LAMPNET = {
  kb_per_mb: 1024n,
  perm_nanogic_per_kb: 200n,
  magic_for_1mb_perm: 1024n * 200n,  // = 204_800 nanogic
  lamp_cap_at_rate_01: 1024n * 200n * 100_000_000n / Q,  // = 20_480 oil
};
