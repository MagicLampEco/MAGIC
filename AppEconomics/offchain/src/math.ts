// src/math.ts — AppEconomics v2.1 Math Engine (§9 W Function)
// NORMATIVE: §3-§10, Appendix B TV-001 to TV-010
// ALL BigInt arithmetic. No float (C8).

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

// ══════════════════════════════════════════════════════════════
// §3.3 isqrt — ⌊√n⌋ by Newton's method (Lemma 3.5)
// ══════════════════════════════════════════════════════════════
export function isqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = n;
  let y = (n + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// ══════════════════════════════════════════════════════════════
// §9.1 isqrt_10th — ⌊n^(1/10)⌋ (Newton for 10th root, Lemma 9.1)
// Used by V_dampened: V_d = isqrt_10th(V^7)
// Off-chain computation; on-chain verification via verify_V_d
// ══════════════════════════════════════════════════════════════
export function isqrt10th(n: bigint): bigint {
  if (n <= 0n) return 0n;
  if (n < 10n) return 1n;
  // Float initial guess (acceptable off-chain)
  let x = BigInt(Math.max(1, Math.floor(Number(n) ** 0.1) + 2));
  while (true) {
    const x9 = x ** 9n;
    const xNew = (9n * x + n / x9) / 10n;
    if (xNew >= x) break;
    x = xNew;
  }
  // Correct boundary
  while ((x + 1n) ** 10n <= n) x++;
  while (x ** 10n > n) x--;
  return x;
}

// §9.1 V_dampened = ⌊V^(7/10)⌋ = isqrt_10th(V^7)
export function vDampened(V: bigint): bigint {
  return isqrt10th(V ** 7n);
}

// §9.1 On-chain verification: V_d^10 ≤ V^7 < (V_d+1)^10 (Lemma 9.2)
export function verifyVd(V: bigint, Vd: bigint): boolean {
  return Vd ** 10n <= V ** 7n && V ** 7n < (Vd + 1n) ** 10n;
}

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
  if (emergencyPen > 0n) kap = kap * (Q - emergencyPen) / Q;
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

export function nanogicToMagicStr(ng: bigint, dec = 4): string {
  if (ng === 0n) return "0." + "0".repeat(dec);
  return `${ng / Q}.${(ng % Q).toString().padStart(9, "0").slice(0, dec)}`;
}
