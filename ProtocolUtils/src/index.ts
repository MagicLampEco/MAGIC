// @magiclamp/protocol-utils — Shared primitives (GenMAGIC v3.3)
// Single source of truth for all modules.
// ALL arithmetic BigInt. No Number for oildrop/nanogic/Q values.

// ══════════════════════════════════════════════════════════════
// §19 Protocol constants (Immutable unless noted)
// ══════════════════════════════════════════════════════════════
export const Q                   = 1_000_000_000n;   // [Immutable]
export const OILDROP_PER_LAMP        = 1_000_000n;
export const NANOGIC_PER_MAGIC   = 1_000_000_000n;
export const S_LAMP_TOTAL        = 36_000_000_000_000_000n;  // 36×10^15 oildrop

// `slots_per_epoch` is network-specific (used for slot-based epoch math and SDK display).
export const SLOTS_PER_EPOCH_BY_NETWORK = {
  Preview:  86_400n,
  Preprod:  86_400n,
  Mainnet:  432_000n,
} as const;

/** Slots-per-epoch for a given Cardano network. */
export function slotsPerEpoch(network: Network): bigint {
  return SLOTS_PER_EPOCH_BY_NETWORK[network];
}

// `ms_per_epoch` is what the Aiken validator's epoch-from-validity-range math uses,
// because PlutusV3 validity_range carries POSIX milliseconds (not slots).
// All current Cardano networks use slot_length = 1000 ms, so ms_per_epoch = slots_per_epoch × 1000.
export const MS_PER_EPOCH_BY_NETWORK = {
  Preview:  86_400_000n,
  Preprod:  86_400_000n,
  Mainnet:  432_000_000n,
} as const;

/** Milliseconds-per-epoch for a given Cardano network (used by validator + SDK). */
export function msPerEpoch(network: Network): bigint {
  return MS_PER_EPOCH_BY_NETWORK[network];
}

/** POSIX ms → POSIX-derived epoch number (matches Aiken validator's get_current_epoch). */
export function posixMsToEpoch(posixMs: bigint, network: Network): bigint {
  return posixMs / msPerEpoch(network);
}

// LAMP carries a DIFFERENT asset name per network — mainnet "LAMP", testnets
// "tLAMP". Every vault validator takes it as compile-time param #2, so a wrong
// value here bakes a vault that can never see its own LAMP (MAINNET-BLOCK).
// Derived from network like ms_per_epoch — never defaulted to a testnet literal.
export const LAMP_ASSET_NAME_BY_NETWORK = {
  Preview:  "744c414d50",   // "tLAMP"
  Preprod:  "744c414d50",   // "tLAMP"
  Mainnet:  "4c414d50",     // "LAMP"
} as const;

/** LAMP asset name (hex) for a given Cardano network — validator param + unit building. */
export function lampAssetName(network: Network): string {
  return LAMP_ASSET_NAME_BY_NETWORK[network];
}

// OAC [GenMAGIC §6.4, Constitutional]
export const DRM_LOOKBACK        = 12n;   // epochs
export const MIN_BURN_FOR_OAC    = 1_000_000_000n;  // 1 MAGIC

// ══════════════════════════════════════════════════════════════
// §2.4 Epoch utilities
// ══════════════════════════════════════════════════════════════

// Cardano genesis UNIX timestamps per network (used as fallback when Blockfrost
// is unavailable). Preview Shelley genesis: slot 0 = block 1 (2022-10-25).
export const GENESIS_UNIX: Record<"Preview" | "Preprod" | "Mainnet", number> = {
  Preview:  1666656000,  // 2022-10-25
  Preprod:  1654041600,  // 2022-06-01
  Mainnet:  1596491091,  // 2020-08-03
};

export type Network = "Preview" | "Preprod" | "Mainnet";

/** slot → epoch (integer division). Must pass the network because slots/epoch differs:
 *    Mainnet:        432_000
 *    Preview/Preprod: 86_400
 */
export function slotToEpoch(slot: bigint, network: Network): bigint {
  return slot / slotsPerEpoch(network);
}

/** Get current tip slot from a Lucid-compatible provider.
 *  Falls back to wall-clock estimate using the network's genesis UNIX time.
 *  Hardcoding 1666656000 in callers breaks Preprod/Mainnet — always pass `network`.
 */
export async function getTipSlot(
  lucid   : { provider: unknown },
  network : Network = "Preview",
): Promise<number> {
  try {
    const tip = await (lucid.provider as { getBlock: (s: string) => Promise<{ slot?: number }> })
      .getBlock("latest");
    return tip.slot ?? 0;
  } catch {
    const genesis = GENESIS_UNIX[network] ?? GENESIS_UNIX.Preview;
    return Math.max(0, Math.floor(Date.now() / 1000) - genesis);
  }
}

/** Get current epoch from a Lucid-compatible provider. */
export async function getCurrentEpoch(
  lucid   : { provider: unknown },
  network : Network = "Preview",
): Promise<bigint> {
  return slotToEpoch(BigInt(await getTipSlot(lucid, network)), network);
}

// ══════════════════════════════════════════════════════════════
// Unit conversions
// ══════════════════════════════════════════════════════════════
export function lampToOildrop(lamp: bigint): bigint   { return lamp * OILDROP_PER_LAMP; }
export function oildropToLamp(oildrop: bigint):  bigint   { return oildrop  / OILDROP_PER_LAMP; }
export function lAvail(balance: bigint, locked: bigint): bigint { return balance - locked; }

// ══════════════════════════════════════════════════════════════
// Display
// ══════════════════════════════════════════════════════════════
export function nanogicToMagicStr(ng: bigint, dec = 4): string {
  if (ng === 0n) return "0." + "0".repeat(dec);
  if (ng < 0n)   return "-" + nanogicToMagicStr(-ng, dec);
  const whole = ng / NANOGIC_PER_MAGIC;
  const frac  = (ng % NANOGIC_PER_MAGIC).toString().padStart(9, "0").slice(0, dec);
  return `${whole}.${frac}`;
}

export function qToStr(qv: bigint, dec = 3): string {
  const sign = qv < 0n ? "-" : "";
  const abs  = qv < 0n ? -qv : qv;
  return sign + (Number(abs) / 1e9).toFixed(dec);
}

// ══════════════════════════════════════════════════════════════
// BigInt sort comparators (avoids Number() precision concern)
// Safe for all realistic values; pure BigInt comparison.
// ══════════════════════════════════════════════════════════════
export function cmpBigIntAsc(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function cmpBigIntDesc(a: bigint, b: bigint): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

// ══════════════════════════════════════════════════════════════
// LoyaltyHolding types & lock algorithm (§6.8, §A.9, T5)
// Canonical implementation — P8: all modules must use this exact code.
// ══════════════════════════════════════════════════════════════
export interface LoyaltyHolding {
  amount         : bigint;
  acquired_epoch : bigint;
  is_locked      : boolean;
}

/** §6.8 Youngest-first lock (T5) — maximises LF of free holdings.
 *  Lock youngest holdings first → free = oldest → LF(free) highest.
 *  Pure function: returns new array, does not mutate input.
 */
export function selectLampForLock(
  holdings : LoyaltyHolding[],
  amount   : bigint,
): LoyaltyHolding[] {
  // Sort youngest-first (desc acquired_epoch) — BigInt-safe comparator
  const sorted = [...holdings].sort((a, b) => cmpBigIntDesc(a.acquired_epoch, b.acquired_epoch));
  let remaining = amount;
  const result: LoyaltyHolding[] = [];

  for (const h of sorted) {
    if (remaining <= 0n) { result.push(h); continue; }
    if (remaining >= h.amount) {
      result.push({ ...h, is_locked: true });
      remaining -= h.amount;
    } else {
      result.push({ amount: remaining,           acquired_epoch: h.acquired_epoch, is_locked: true  });
      result.push({ amount: h.amount - remaining, acquired_epoch: h.acquired_epoch, is_locked: false });
      remaining = 0n;
    }
  }
  if (remaining > 0n) throw new Error(`GEN-LOCK-001: insufficient holdings (${remaining} oildrop short)`);
  return result;
}

/** I-ACT-7 — Oldest-locked-first RELEASE. Called at ScheduleGen fire time.
 *
 *  Unlike `removeLockedAmount`, the LAMP stays: holdings keep their amount and
 *  acquired_epoch, only `is_locked` flips. Σholdings is therefore invariant, so
 *  the vault's `lamp_balance` (and the real LAMP in the UTxO) does not move —
 *  a fire mints MAGIC without eroding the user's principal.
 *
 *  Mirrors `unlock_locked_amount` in ScheduleGen/onchain/lib/.../lock.ak
 *  byte-for-byte, including the result order (P8):
 *    [already unlocked] ++ [newly freed] ++ [still locked]
 *
 *  Pure function: returns new array, does not mutate input.
 */
export function unlockLockedAmount(
  holdings : LoyaltyHolding[],
  amount   : bigint,
): LoyaltyHolding[] {
  const unlocked = holdings.filter(h => !h.is_locked);
  const locked   = holdings.filter(h =>  h.is_locked)
    .sort((a, b) => cmpBigIntAsc(a.acquired_epoch, b.acquired_epoch));  // oldest first

  let remaining = amount;
  const freed:       LoyaltyHolding[] = [];
  const stillLocked: LoyaltyHolding[] = [];

  for (const h of locked) {
    if (remaining <= 0n) { stillLocked.push(h); continue; }
    if (remaining >= h.amount) {
      freed.push({ ...h, is_locked: false });
      remaining -= h.amount;
    } else {
      // Partial release splits one holding; the parts sum to the original.
      freed.push({ amount: remaining, acquired_epoch: h.acquired_epoch, is_locked: false });
      stillLocked.push({ amount: h.amount - remaining, acquired_epoch: h.acquired_epoch, is_locked: true });
      remaining = 0n;
    }
  }
  if (remaining > 0n) throw new Error(`GEN-LOCK-002: insufficient locked holdings (${remaining} oildrop short)`);
  return coalesceHoldings([...unlocked, ...freed, ...stillLocked]);
}

/** Merge holdings sharing (acquired_epoch, is_locked). Lossless: that pair is the
 *  only thing distinguishing two holdings, and `amount` is additive.
 *
 *  NOT optional. `unlockLockedAmount` splits a holding on every partial release
 *  and never drops one, so without this the list grows +1 per fire — 21 entries
 *  after 20 fires vs 2 under the old `removeLockedAmount`. MAX_LOYALTY_HOLDINGS
 *  is 64 and the vault validator enforces it on withdrawal, so an L=200 schedule
 *  would leave the user unable to withdraw at all.
 *
 *  Mirrors `coalesce_holdings` in ScheduleGen/onchain/lib/.../lock.ak, including
 *  order: the first occurrence of a bucket keeps its position (P8).
 */
export function coalesceHoldings(holdings: LoyaltyHolding[]): LoyaltyHolding[] {
  const out: LoyaltyHolding[] = [];
  for (const h of holdings) {
    const i = out.findIndex(x =>
      x.acquired_epoch === h.acquired_epoch && x.is_locked === h.is_locked);
    if (i >= 0) out[i] = { ...out[i]!, amount: out[i]!.amount + h.amount };
    else out.push({ ...h });
  }
  return out;
}

/** §A.9 Oldest-locked-first REMOVAL — deletes the LAMP.
 *
 *  Legacy/VacuumGen only. ScheduleGen moved to `unlockLockedAmount` under
 *  I-ACT-7: removing LAMP at fire time eroded the user's principal.
 *
 *  Pure function: returns new array, does not mutate input.
 */
export function removeLockedAmount(
  holdings : LoyaltyHolding[],
  amount   : bigint,
): LoyaltyHolding[] {
  const unlocked = holdings.filter(h => !h.is_locked);
  const locked   = holdings.filter(h =>  h.is_locked)
    .sort((a, b) => cmpBigIntAsc(a.acquired_epoch, b.acquired_epoch));  // oldest first

  let remaining = amount;
  const result: LoyaltyHolding[] = [];

  for (const h of locked) {
    if (remaining <= 0n) { result.push(h); continue; }
    if (remaining >= h.amount) { remaining -= h.amount; }
    else { result.push({ ...h, amount: h.amount - remaining }); remaining = 0n; }
  }
  if (remaining > 0n) throw new Error(`GEN-LOCK-002: insufficient locked holdings (${remaining} oildrop short)`);
  return [...unlocked, ...result];
}

export function sumHoldings(holdings: LoyaltyHolding[]): bigint {
  return holdings.reduce((s, h) => s + h.amount, 0n);
}

export function sumLocked(holdings: LoyaltyHolding[]): bigint {
  return holdings.filter(h => h.is_locked).reduce((s, h) => s + h.amount, 0n);
}

// ══════════════════════════════════════════════════════════════
// OAC (§6.4) — single canonical implementation
//
// IMPORTANT: Two different window semantics exist by design:
//
//   PRUNE (ConsumeMAGIC §10.2 STEP 0e): keeps ep ≥ e − DRM_LOOKBACK
//     → keeps entries that may be counted in the NEXT SnapshotGen
//
//   COUNT (SnapshotGen §6.4, AppEconomics §8.5): counts ep ∈ [e−12, e)
//     → [current-12, current) — exclusive upper bound
//     → burns in CURRENT epoch apply to NEXT epoch's OAC (by design)
//
// These are intentionally different. Do NOT unify them.
// ══════════════════════════════════════════════════════════════

/** Prune stale entries from recent_burn_epochs (ConsumeMAGIC STEP 0e).
 *  Keeps entries with ep ≥ current − DRM_LOOKBACK.
 */
export function pruneActivityWindow(
  entries      : [string, bigint][],
  currentEpoch : bigint,
): [string, bigint][] {
  return entries.filter(([, ep]) => ep >= currentEpoch - DRM_LOOKBACK);
}

/** Count distinct active apps in OAC window (SnapshotGen §6.4).
 *  Window: [current − DRM_LOOKBACK, current) — EXCLUSIVE upper bound.
 *  Burns from current epoch NOT counted (they affect next epoch's OAC).
 */
export function countActiveAppsInOacWindow(
  entries      : [string, bigint][],
  currentEpoch : bigint,
): number {
  const lo = currentEpoch - DRM_LOOKBACK;
  const hi = currentEpoch;  // exclusive
  const active = entries.filter(([, ep]) => ep >= lo && ep < hi);
  return new Set(active.map(([id]) => id)).size;
}

/** Add or update (app_id, epoch) in recent_burn_epochs with deduplication.
 *  C-ACTIVITY-DEDUP: skip if (app_id, epoch) already present.
 *  INV-CM-ACT-ORDER: maintains epoch-descending order for efficient dedup.
 */
export function addBurnToActivity(
  entries  : [string, bigint][],
  appId    : string,
  epoch    : bigint,
): [string, bigint][] {
  // C-ACTIVITY-DEDUP: no duplicate (app_id, epoch)
  if (entries.some(([id, ep]) => id === appId && ep === epoch)) return entries;
  return [[appId, epoch], ...entries];  // prepend = epoch-descending order
}

// ══════════════════════════════════════════════════════════════
// isqrt — ⌊√n⌋ Newton's method (AppEconomics §3.3, Lemma 3.5)
// Pure BigInt — no float.
// ══════════════════════════════════════════════════════════════
export function isqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  // Initial guess: use bit length to estimate magnitude (BigInt-safe)
  const bits = n.toString(2).length;
  let x = 1n << BigInt(Math.ceil(bits / 2));
  let y = (x + n / x) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/** isqrt_10th — ⌊n^(1/10)⌋ for AppEconomics V_dampened.
 *  BigInt Newton's method. No float for initial guess.
 *  Safe for V^7 where V ≤ S_LAMP_TOTAL = 36×10^15 (V^7 ≤ ~10^110).
 */
export function isqrt10th(n: bigint): bigint {
  if (n <= 0n) return 0n;
  if (n < 10n) return 1n;

  // Initial guess via bit-length (pure BigInt, no float)
  const bits = n.toString(2).length;
  // k^10 ≈ 2^(bits-1) → k ≈ 2^((bits-1)/10)
  let x = 1n << BigInt(Math.ceil((bits - 1) / 10) + 1);

  // Newton's method: x_{n+1} = (9x + n/x^9) / 10
  for (let iter = 0; iter < 200; iter++) {
    const x9   = x ** 9n;
    const xNew = (9n * x + n / x9) / 10n;
    if (xNew >= x) break;
    x = xNew;
  }

  // Correct boundary (one-time adjustment)
  while ((x + 1n) ** 10n <= n) x++;
  while (x > 0n && x ** 10n > n) x--;

  return x;
}

/** On-chain verification of V_dampened (§9.1 Lemma 9.2).
 *  Vd^10 ≤ V^7 < (Vd+1)^10 — cheaper than computing isqrt_10th on-chain.
 */
export function verifyVd(V: bigint, Vd: bigint): boolean {
  return Vd ** 10n <= V ** 7n && V ** 7n < (Vd + 1n) ** 10n;
}

export function vDampened(V: bigint): bigint {
  return isqrt10th(V ** 7n);
}

// ══════════════════════════════════════════════════════════════
// Q-format arithmetic (§3.2)
// ══════════════════════════════════════════════════════════════
export function mulQ(a: bigint, b: bigint): bigint { return a * b / Q; }
export function clamp(x: bigint, lo: bigint, hi: bigint): bigint {
  return x < lo ? lo : x > hi ? hi : x;
}
