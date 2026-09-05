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

// ── HAI ĐỒNG HỒ, ĐỘC LẬP NHAU — đừng suy bảng này ra bảng kia ─────────────────
//
// Bản trước gộp chúng làm một ("ms_per_epoch = slots_per_epoch × 1000") và câu đó
// SAI cho Preprod: mạng Preprod thật chạy 432_000 slot/epoch (5 ngày), trong khi
// bảng ms cố ý để 1 ngày. Gộp lại thì một trong hai bảng phải sai, và bảng sai đó
// đội lốt số thật — không cổng nào bắt được, vì test đơn vị dùng chính hằng đó làm
// chuẩn nên xanh cả trước lẫn sau. Nguồn phát hiện: nhà Phoenix, đo Blockfrost
// `/epochs/latest` 2026-09-04 (Preprod epoch 311 dài 432 000 s).
//
// Từ nay hai bảng khai HAI thứ khác nhau và không được suy ra nhau:

// (1) SỰ THẬT VỀ MẠNG. Tham số thật của Cardano, dùng khi phải diễn giải slot thật
//     của chuỗi. KHÔNG bao giờ đi vào apply-param của validator nào.
export const SLOTS_PER_EPOCH_BY_NETWORK = {
  Preview:   86_400n,   // 1 ngày — đo được trên chuỗi
  Preprod:  432_000n,   // 5 ngày — đo được trên chuỗi (VÁ 2026-09-05, trước ghi 86_400)
  Mainnet:  432_000n,   // 5 ngày
} as const;

/** Slots-per-epoch THẬT của mạng Cardano (không phải nhịp epoch của giao thức). */
export function slotsPerEpoch(network: Network): bigint {
  return SLOTS_PER_EPOCH_BY_NETWORK[network];
}

// (2) NHỊP ĐỒNG HỒ CỦA GIAO THỨC — apply-param #4 của mọi vault validator.
//     Validator tính `epoch = posix_ms / ms_per_epoch` từ validity_range (PlutusV3
//     mang POSIX ms, không mang slot). Phép chia đó KHÔNG trừ genesis, nên số epoch
//     của giao thức chưa bao giờ là số epoch của Cardano và không thể trở thành nó:
//     hôm nay Preprod chạy epoch Cardano 311 còn epoch giao thức ≈ 20 700. Cho nên
//     chỉnh nhịp này cho khớp Preprod cũng KHÔNG làm hai số gặp nhau — nó chỉ đổi
//     độ dài một epoch giao thức, và đổi apply-param ⟹ đổi script hash ⟹ giết mọi
//     thứ đã deploy.
//
//     Preprod cố ý giữ 1 ngày = ĐỒNG HỒ NÉN cho kiểm thử (nén 5× so với mainnet), để
//     chạy hết một vòng decay / hết hạn / cửa sổ fire trong một ngày thay vì năm ngày.
//     Đây là lựa chọn, không phải số sai — và nó phải mang nhãn, đúng như
//     PhoenixKey-Validator ghi `ms_per_epoch` nén của họ.
export const MS_PER_EPOCH_BY_NETWORK = {
  Preview:   86_400_000n,   // 1 ngày — trùng nhịp mạng Preview
  Preprod:   86_400_000n,   // 1 ngày — ĐỒNG HỒ NÉN 5×, mạng thật là 5 ngày
  Mainnet:  432_000_000n,   // 5 ngày — trùng nhịp mainnet
} as const;

/** Nhịp epoch của GIAO THỨC (ms). Đây là apply-param, đổi là đổi script hash. */
export function msPerEpoch(network: Network): bigint {
  return MS_PER_EPOCH_BY_NETWORK[network];
}

/** POSIX ms → epoch GIAO THỨC (khớp `get_current_epoch` của validator).
 *  KHÔNG trừ genesis ⇒ giá trị trả về KHÔNG phải epoch Cardano, đừng đem so với
 *  số epoch của Blockfrost hay của explorer. */
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

/** slot → epoch CARDANO (chia nguyên theo `SLOTS_PER_EPOCH_BY_NETWORK`).
 *
 *  ⚠ KHÔNG dùng hàm này để lấy epoch của GIAO THỨC — đó là `posixMsToEpoch`.
 *  Hai hàm trả hai số khác hẳn nhau (đồng hồ giao thức không trừ genesis), và trộn
 *  chúng vào cùng một datum là dựng một giao dịch validator không bao giờ nhận.
 *  Hiện KHÔNG mã sống nào gọi hàm này — chỉ tái xuất qua `math.ts` các module.
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


// ══════════════════════════════════════════════════════════════
// sortAiken — P8: `list.sort` của Aiken KHÔNG ổn định
// ══════════════════════════════════════════════════════════════
//
// 🔴 Đây là chỗ P8 vỡ mà không phép kiểm nào bắt được, và nó vỡ ở đúng trạng thái mà
// giao thức TỰ SINH RA.
//
// `Array.prototype.sort` của JS ổn định từ ES2019: hai phần tử so ra `0` giữ nguyên thứ
// tự. `list.sort` của stdlib Aiken thì ĐẢO chúng. Nguồn — `aiken-lang-stdlib`
// (`lib/aiken/collection/list.ak`, bản ghim ở mọi `aiken.toml` của kho này):
//
//     sort([x, ..xs], cmp)   = insert(sort(xs, cmp), x, cmp)
//     insert([x, ..xs], e)   = if cmp(e, x) == Less { [e, ..self] }
//                              else { [x, ..insert(xs, e)] }
//
// Nó sắp phần ĐUÔI trước rồi chèn phần ĐẦU vào; `Equal` rơi vào nhánh `else` nên phần
// tử đứng trước bị đẩy ra sau. Với hai phần tử hoà, kết quả là danh sách ĐẢO.
//
// Đo thật (2026-09-05, `aiken check` trên bản sao ScheduleGen, đầu vào
// `[(100, ep10, F), (50, ep10, F)]`):
//
//     remove_newest_first(…, 30)   Aiken [(20,F),(100,F)]     TS cũ [(70,F),(50,F)]
//     select_lamp_for_lock(…, 20)  Aiken [(20,T),(30,F),(100,F)]  TS cũ [(20,T),(80,F),(50,F)]
//
// Validator so danh sách BẰNG NHAU TUYỆT ĐỐI (`ScheduleGen/onchain/validators/vault.ak:353`,
// `InstantGen/onchain/validators/vault.ak:822`), nên mỗi lệch là một tx bị chuỗi từ chối.
//
// Vì sao nó không phải ca hiếm: comparator chỉ khoá theo `acquired_epoch`, và
// `select_lamp_for_lock` khi khoá MỘT PHẦN sẽ tách một holding thành HAI holding cùng
// `acquired_epoch` (`lock.ak:34-38`). Nghĩa là lần khoá đầu tiên tự tạo ra thế hoà, và
// mọi thao tác sau đó trên vault đó đi vào đúng ca lệch.
//
// Sửa ở phía TS chứ không phía Aiken là CÓ CHỦ ĐÍCH: đổi `lock.ak` là đổi bytes ⟹ đổi
// script hash ⟹ đổi địa chỉ vault ⟹ mọi vault đang sống mồ côi. On-chain là trọng tài,
// nên bản mô phỏng phải chạy theo nó.
//
// Đây là bản soi gương ĐÚNG THUẬT TOÁN, không phải một mẹo "đảo phần tử hoà". Viết theo
// thuật toán thì nó còn đúng ở những ca mà một phép đảo hậu-kỳ sai — ví dụ ba phần tử
// hoà trở lên, hoặc các cụm hoà xen kẽ cụm không hoà.

function insertAiken<T>(self: readonly T[], e: T, cmp: (a: T, b: T) => number): T[] {
  if (self.length === 0) return [e];
  const [x, ...xs] = self;
  return cmp(e, x) < 0 ? [e, ...self] : [x, ...insertAiken(xs, e, cmp)];
}

/**
 * `list.sort` của Aiken, mô phỏng đúng thuật toán. Dùng THAY CHO `Array.sort` ở mọi chỗ
 * kết quả phải trùng bit với một hàm Aiken (P8). Không đột biến mảng vào.
 */
export function sortAiken<T>(xs: readonly T[], cmp: (a: T, b: T) => number): T[] {
  if (xs.length === 0) return [];
  const [head, ...tail] = xs;
  return insertAiken(sortAiken(tail, cmp), head, cmp);
}

/** §6.8 Youngest-first lock (T5) — maximises LF of free holdings.
 *  Lock youngest holdings first → free = oldest → LF(free) highest.
 *  Pure function: returns new array, does not mutate input.
 */
export function selectLampForLock(
  holdings : LoyaltyHolding[],
  amount   : bigint,
): LoyaltyHolding[] {
  // Sort youngest-first (desc acquired_epoch). `sortAiken`, KHÔNG `Array.sort` —
  // xem chú thích ở `sortAiken`: hai holding cùng `acquired_epoch` ra thứ tự khác nhau.
  const sorted = sortAiken(holdings, (a, b) => cmpBigIntDesc(a.acquired_epoch, b.acquired_epoch));
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
  const locked   = sortAiken(holdings.filter(h => h.is_locked),        // oldest first
    (a, b) => cmpBigIntAsc(a.acquired_epoch, b.acquired_epoch));       // P8: xem sortAiken

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
  const locked   = sortAiken(holdings.filter(h => h.is_locked),        // oldest first
    (a, b) => cmpBigIntAsc(a.acquired_epoch, b.acquired_epoch));       // P8: xem sortAiken

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

// ── INV-VAULT-IDENTITY: dựng value output của vault ──────────────────────────────
//
// Mọi nhánh spend của mọi vault đòi vault-id NFT còn nguyên ở output
// (`validate_vault_value`, ví dụ `ScheduleGen/onchain/validators/vault.ak:866-872`).
// NFT là one-shot, sinh cùng lúc với vault, không đúc lại được.
//
// 🔴 LỖI ĐÃ XẢY RA THẬT, HAI LẦN, VÀ IM LẶNG CẢ HAI LẦN. Cách viết
//
//     { lovelace: L, [lampUnit]: X }        // ✗ dựng lại từ đầu
//
// bỏ mất mọi tài sản khác đang nằm trên vault — trong đó có NFT danh tính. Không lỗi
// biên dịch, không test đỏ; chuỗi từ chối tx và thông điệp không nói NFT. `ca5870df`
// (tuanzoro2k, 11/8) vá đúng chỗ này, lần trộn hội tụ đánh rơi bản vá, và đường
// ScheduleFire nằm gãy từ đó tới 3/9 — đúng khoảng thời gian mà `DEPLOYED.md` ghi là
// "fire chưa bao giờ thành công trên chuỗi".
//
// Dùng hàm này thay vì viết object bằng tay. Nó ở ProtocolUtils vì cả bốn module vault
// cần cùng một bất biến, và một bất biến thì giữ ở một chỗ.

/** Tập tài sản tối thiểu mà lucid nhận cho một output. */
export type AssetsLike = Record<string, bigint>;

/**
 * Value cho output tiếp-nối của vault: bê NGUYÊN value đầu vào, chỉ đè các đơn vị được
 * nêu. Tài sản không nêu — vault-id NFT trước hết — đi qua nguyên vẹn.
 *
 * @param inputAssets value của UTxO vault đang tiêu (`vaultUtxo.assets`).
 * @param overrides   các đơn vị cần đặt lại, ví dụ `{ lovelace, [lampUnit]: newBalance }`.
 *                    Đặt một đơn vị về `0n` là XOÁ nó khỏi output (lucid không nhận
 *                    số lượng 0) — dùng khi thật sự muốn tài sản đó rời vault.
 */
export function vaultOutValue(
  inputAssets: AssetsLike,
  overrides:   AssetsLike,
): AssetsLike {
  const out: AssetsLike = { ...inputAssets, ...overrides };
  for (const [unit, qty] of Object.entries(out)) {
    if (qty === 0n) delete out[unit];
  }
  return out;
}

/**
 * Đếm số tài sản KHÔNG phải lovelace bị đánh rơi giữa value vào và value ra. Dùng cho
 * test và cho chốt lúc chạy: > 0 nghĩa là có thứ gì đó rời vault, và nếu đó là NFT danh
 * tính thì mọi nhánh spend về sau đều bị từ chối.
 */
export function droppedUnits(
  inputAssets: AssetsLike,
  outputAssets: AssetsLike,
): string[] {
  return Object.keys(inputAssets)
    .filter(u => u !== "lovelace")
    .filter(u => (inputAssets[u] ?? 0n) > 0n)
    .filter(u => (outputAssets[u] ?? 0n) === 0n);
}

/**
 * Chốt lúc chạy: value sắp trả về vault KHÔNG được đánh rơi tài sản nào của value vào.
 *
 * ⚠ Đọc kỹ trước khi ai đó gỡ nó vì "thừa": nó ĐÚNG LÀ thừa chừng nào chỗ gọi còn dùng
 * `vaultOutValue` — hàm đó bê nguyên value vào nên không thể đánh rơi gì. Nó tồn tại cho
 * đúng một tình huống, và tình huống đó đã xảy ra HAI LẦN: có người thay biểu thức value
 * bằng một object dựng mới (`{ lovelace, [lampUnit] }`). Lúc đó `vaultOutValue` biến mất
 * khỏi dòng đó, còn dòng này ở lại — và nó đổi lỗi từ "chuỗi từ chối tx với thông điệp
 * không nhắc NFT" thành "builder ném lỗi gọi đúng tên thứ bị rơi".
 *
 * Đặt nó thành CÂU LỆNH RIÊNG, đừng gộp vào biểu thức truyền cho `.pay` — gộp lại là nó
 * biến mất cùng lần viết lại mà nó sinh ra để bắt.
 */
export function assertVaultIdentityKept(
  inputAssets: AssetsLike,
  outputAssets: AssetsLike,
): void {
  const dropped = droppedUnits(inputAssets, outputAssets);
  if (dropped.length > 0) {
    throw new Error(
      `INV-VAULT-IDENTITY: value ra của vault đánh rơi ${dropped.length} tài sản ` +
      `(${dropped.join(", ")}). Vault-id NFT là one-shot, không đúc lại được, và mọi ` +
      `nhánh spend đòi nó còn nguyên ở output — rơi là vault chết vĩnh viễn. ` +
      `Dựng value ra bằng vaultOutValue(vaultUtxo.assets, {...}), đừng viết object mới.`,
    );
  }
}
