// src/math.ts — AppEconomics v2.1 Math Engine (§9 W Function)
// NORMATIVE: §3-§10, Appendix B TV-001 to TV-010
// ALL BigInt arithmetic. No float (C8).

import {
  isqrt   as isqrtShared,
  isqrt10th as isqrt10thShared,
  vDampened as vDampenedShared,
  verifyVd as verifyVdShared,
  nanogicToMagicStr,
} from "@magiclamp/protocol-utils";
export { nanogicToMagicStr };

// ── Constants (§19) ───────────────────────────────────────────
export const Q                         = 1_000_000_000n;
export const UTIL_DEAD_Q               = 50_000_000n;     // 5% [Routine]
export const UTIL_TARGET_Q             = 500_000_000n;    // 50% [Significant]
export const USERS_TARGET              = 100n;             // [Routine]
export const DISPUTE_BETA_Q            = 5_000_000_000n;  // [Significant]
export const VARIANCE_BETA_Q           = 5_000_000_000n;  // [Significant]
export const PENALTY_CAP_Q             = 500_000_000n;    // 50% max [Significant]
export const GRACE_PERIOD              = 6n;               // epochs [Routine]
export const DRATE_PRIOR               = 10n;              // Bayesian prior [Routine]
export const MAX_SINGLE_APP_REWARD_BPS = 3000n;           // 30% cap [Constitutional]
export const TIER_KAPPA = { Tier1: Q, Tier2: 1_200_000_000n, Tier3: 1_500_000_000n } as const;

export type Tier = "Tier1" | "Tier2" | "Tier3";

// ══════════════════════════════════════════════════════════════
// §3.2 mul_q — Q-format multiplication (integer division)
// ══════════════════════════════════════════════════════════════
export function mulQ(a: bigint, b: bigint): bigint {
  return a * b / Q;
}

// §3.3 isqrt, §9.1 isqrt_10th / V_dampened / verify_V_d — canonical
// implementations live in @magiclamp/protocol-utils (single source of truth, P8).
export const isqrt     = isqrtShared;
export const isqrt10th = isqrt10thShared;
export const vDampened = vDampenedShared;
export const verifyVd  = verifyVdShared;

// ══════════════════════════════════════════════════════════════
// §9.2 Five Factors
// ══════════════════════════════════════════════════════════════

// --- Φ_util_adj (§9.2) ---
// Φ_util_base: linear from [UTIL_DEAD_Q, UTIL_TARGET_Q]
export function phiUtilBase(uQ: bigint): bigint {
  if (uQ < UTIL_DEAD_Q) return 0n;
  const raw = (uQ - UTIL_DEAD_Q) * Q / (UTIL_TARGET_Q - UTIL_DEAD_Q);
  return raw > Q ? Q : raw;
}

// §8.3 Variance Q-format σ² from 6 util values
export function varianceQ(utilHistory: bigint[]): bigint {
  if (utilHistory.length === 0) return 0n;
  const K = BigInt(utilHistory.length);
  const uBar = utilHistory.reduce((s, x) => s + x, 0n) / K;
  const sumSq = utilHistory.reduce((s, u) => {
    const diff = u - uBar;  // can be negative; BigInt handles this
    return s + diff * diff / Q;
  }, 0n);
  return sumSq / K;
}

// §8.3 Variance penalty (AI wash resistance, T17)
export function varPenQ(sigma2Q: bigint): bigint {
  const raw = sigma2Q * VARIANCE_BETA_Q / Q;
  return raw > PENALTY_CAP_Q ? PENALTY_CAP_Q : raw;
}

// Φ_util_adj = Φ_util_base(ū) × (Q − var_pen) / Q
export function phiUtilAdj(utilHistory: bigint[]): bigint {
  const K = BigInt(utilHistory.length);
  if (K === 0n) return 0n;
  const uBar = utilHistory.reduce((s, x) => s + x, 0n) / K;
  const s2   = varianceQ(utilHistory);
  const base = phiUtilBase(uBar);
  const pen  = varPenQ(s2);
  return base * (Q - pen) / Q;
}

// --- Φ_users (§9.2) ---
// Φ_users = min(Q, ⌊Q × √(N̄ / n_target)⌋) = min(Q, isqrt(N̄ × Q² / n_target))
// Lemma 9.4: |Φ_users − Q√(N̄/n_t)| ≤ 1
export function phiUsers(nBar: bigint): bigint {
  if (nBar === 0n) return 0n;
  // isqrt(N̄ × Q²  / USERS_TARGET)
  const inner = nBar * Q * Q / USERS_TARGET;
  const result = isqrt(inner);
  return result > Q ? Q : result;
}

// --- Φ_dispute (§9.2) ---
// Φ_dispute = max(0, Q − δ_q × DISPUTE_BETA_Q / Q)
export function phiDispute(deltaQ: bigint): bigint {
  const pen = deltaQ * DISPUTE_BETA_Q / Q;
  return pen >= Q ? 0n : Q - pen;
}

// --- Φ_age (§9.2) ---
// Φ_age = min(Q, (age+1) × Q / (GRACE_PERIOD+1))
// Lemma 9.5: Φ_age(0) = Q/7 > 0; Φ_age(≥6) = Q
export function phiAge(age: bigint): bigint {
  const result = (age + 1n) * Q / (GRACE_PERIOD + 1n);
  return result > Q ? Q : result;
}

// --- δ_q Bayesian smoothed dispute rate (§8.9) ---
// δ_q = conf × Q / (burns + DRATE_PRIOR)
// Lemma 8.1: denominator ≥ DRATE_PRIOR = 10 > 0 always (T20)
export function dRateSmoothed(confirmed: bigint, totalBurns: bigint): bigint {
  const denominator = totalBurns + DRATE_PRIOR;  // ≥ 10 always
  const result = confirmed * Q / denominator;
  return result > Q ? Q : result;
}

// ══════════════════════════════════════════════════════════════
// §9.3 W — Reward function (5 multiplications, Theorem 9.3)
// Error ≤ 7 nanogic (Lemma 3.2); W ≤ W_exact (user-unfavorable)
// ══════════════════════════════════════════════════════════════
export function computeW(
  V            : bigint,
  utilHistory  : bigint[],
  nBar         : bigint,
  deltaQ       : bigint,
  tier         : Tier,
  age          : bigint,
  emergencyPen : bigint = 0n,
): bigint {
  if (V === 0n) return 0n;

  const Vd  = vDampened(V);
  const fu  = phiUtilAdj(utilHistory);
  const fn  = phiUsers(nBar);
  const fd  = phiDispute(deltaQ);
  let   kap = TIER_KAPPA[tier];
  // W-3 guard: emergencyPen ∈ [0, Q]. Clamp >Q to Q (kap_eff=0) so W can never
  // go negative. Negative values clamp to 0 (no penalty). Without this guard a
  // caller passing emergencyPen>Q would make (Q-emergencyPen)<0 → kap_eff<0 → W<0.
  let ep = emergencyPen;
  if (ep < 0n) ep = 0n;
  if (ep > Q)  ep = Q;
  if (ep > 0n) kap = kap * (Q - ep) / Q;
  const fa  = phiAge(age);

  // Sequential multiplications — error ≤ 7 nanogic (Lemma 3.2)
  let w = Vd;
  w = mulQ(w, fu);  // ε ≤ 1
  w = mulQ(w, fn);  // ε ≤ 2
  w = mulQ(w, fd);  // ε ≤ 3
  w = mulQ(w, kap); // ε ≤ 6 (κ ≤ 1.5Q)
  w = mulQ(w, fa);  // ε ≤ 7
  return w;
}

// ══════════════════════════════════════════════════════════════
// §10 Reward distribution with iterative cap (Theorem 10.1)
// Terminates in ≤ |𝒜| + 1 iterations (proved)
// ══════════════════════════════════════════════════════════════
export function distribute(
  weights  : Record<string, bigint>,   // {app_id: W(a,e)}
  X        : bigint,                   // total pool (nanogic)
  capBps   : bigint = MAX_SINGLE_APP_REWARD_BPS,
): Record<string, bigint> {
  const apps = Object.keys(weights);
  // W-11 guard: reject negative pool X. X (epoch reward pool, nanogic) is ≥ 0 by
  // construction, but a negative X would flip the sign of every reward via the
  // `weight*X/Wtotal` step (X<0 → reward<0) and corrupt the cap/conservation
  // logic. Defense-in-depth: fail loud on malformed input rather than emit
  // negative rewards.
  if (X < 0n) {
    throw new Error(`distribute: negative pool X (${X}); reward pool must be ≥ 0`);
  }
  // W-10 guard: reject negative weights. W is always ≥ 0 by W-3, so a negative
  // weight is malformed input. Allowing it would let an app with a negative
  // weight pull positive reward via the cap-redistribution loop (Wunc could turn
  // a negative contributor into a cap grab), and could make Wtotal misrepresent
  // the true share denominator. Fail loud rather than silently mis-allocate.
  for (const a of apps) {
    if ((weights[a] ?? 0n) < 0n) {
      throw new Error(`distribute: negative weight for app "${a}" (${weights[a]}); W must be ≥ 0 (W-3)`);
    }
  }
  const Wtotal = apps.reduce((s, a) => s + (weights[a] ?? 0n), 0n);
  if (Wtotal === 0n) return Object.fromEntries(apps.map(a => [a, 0n]));

  const cap = X * capBps / 10000n;

  // Initial uncapped rewards
  const rewards: Record<string, bigint> = {};
  for (const a of apps) rewards[a] = (weights[a] ?? 0n) * X / Wtotal;

  // Iterative cap redistribution — terminates in ≤ |apps|+1 iterations (T10.1)
  let excess = 0n;
  for (const a of apps) {
    if (rewards[a]! > cap) { excess += rewards[a]! - cap; rewards[a] = cap; }
  }

  const maxIters = apps.length + 1;
  for (let iter = 0; iter < maxIters && excess > 0n; iter++) {
    const uncapped = apps.filter(a => rewards[a]! < cap);
    const Wunc = uncapped.reduce((s, a) => s + (weights[a] ?? 0n), 0n);
    if (Wunc === 0n) break;
    let newExcess = 0n;
    for (const a of uncapped) {
      const bonus = (weights[a] ?? 0n) * excess / Wunc;
      const nr    = rewards[a]! + bonus;
      if (nr > cap) { newExcess += nr - cap; rewards[a] = cap; }
      else          { rewards[a] = nr; }
    }
    excess = newExcess;
  }

  return rewards;
}

// ══════════════════════════════════════════════════════════════
// Utility
// ══════════════════════════════════════════════════════════════
export function sma6(history: bigint[]): bigint {
  if (history.length === 0) return Q;  // neutral
  return history.reduce((s, x) => s + x, 0n) / BigInt(history.length);
}

// nanogicToMagicStr re-exported from @magiclamp/protocol-utils — see top of file.
