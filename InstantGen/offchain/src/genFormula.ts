// src/genFormula.ts — công thức sinh chung Gen v2.0 `F(L, usage_ratio, GB)`
// (SPEC §6.1.1–§6.1.3, INV-MAGIC-CITIZEN).
//
// P8: gương TRÙNG BIT của `onchain/lib/magiclamp/protocol/gen_formula.ak`. Đổi một bên
// ⟹ đổi bên kia trong cùng commit. Quy tắc làm tròn ghi ở từng hàm, giống hệt bản Aiken.
// Mọi đầu vào đã bị ép ≥ 0 nên chia BigInt (cắt về 0) = chia sàn của Aiken.
//
// Dấu: đầu vào âm / cửa sổ sai hình dạng ⟹ NÉM (bản Aiken `fail` ở đúng các chỗ đó).
// Không kẹp về 0 — kẹp trong hàm toán che mất chỗ GHI đang thủng.

import {
  Q, LENT_PP_CAP, USAGE_FACTOR_FLOOR_Q, SCALE_COVERAGE_Q, USAGE_WINDOW_LEN,
  GB_VAULT_SHARE_Q,
} from "./constants.js";

/** Một ô cửa sổ `usage_window` (SPEC §6.1.2), nanogic trong MỘT epoch. */
export interface EpochUsage {
  generated: bigint;
  consumed : bigint;
}

function min2(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function requireNonNegative(name: string, x: bigint): void {
  if (typeof x !== "bigint") throw new TypeError(`${name} phải là bigint`);
  if (x < 0n) throw new RangeError(`${name} âm: ${x}`);
}

/** Đúng 7 ô, mọi ô không âm. Ô 0 = epoch ĐANG MỞ; ô 1..6 = 6 epoch ĐÃ ĐÓNG. */
export function windowWellFormed(window: readonly EpochUsage[]): boolean {
  return window.length === USAGE_WINDOW_LEN &&
    window.every(u => typeof u.generated === "bigint" && typeof u.consumed === "bigint" &&
                      u.generated >= 0n && u.consumed >= 0n);
}

function requireWindow(window: readonly EpochUsage[]): void {
  if (!windowWellFormed(window)) {
    throw new RangeError(`usage_window sai hình dạng (cần ${USAGE_WINDOW_LEN} ô không âm)`);
  }
}

/** (Σ generated, Σ consumed) trên ô 1..6 — 6 epoch ĐÃ QUA (SPEC §6.1.2). */
export function closedWindowTotals(window: readonly EpochUsage[]): [bigint, bigint] {
  requireWindow(window);
  let g = 0n, c = 0n;
  for (const u of window.slice(1)) { g += u.generated; c += u.consumed; }
  return [g, c];
}

function ratioFromTotals(g: bigint, c: bigint): bigint {
  return g === 0n ? 0n : min2(Q, c * Q / g);
}

function factorFromTotals(g: bigint, c: bigint): bigint {
  if (g === 0n) return usageFactorColdstartQ();
  return USAGE_FACTOR_FLOOR_Q + (Q - USAGE_FACTOR_FLOOR_Q) * ratioFromTotals(g, c) / Q;
}

function scaleFromTotals(g: bigint, horizon: bigint, base: bigint): bigint {
  if (horizon <= 0n) return 0n;         // fail-closed: SPEC không định nghĩa horizon ≤ 0
  if (g === 0n) return base;            // khởi động lạnh: không ràng buộc
  return g * Q / (horizon * SCALE_COVERAGE_Q);
}

/** ⌊L_owned·ρ/Q⌋ + min(⌊L_lent·ρ/Q⌋, LENT_PP_CAP) — sàn RIÊNG từng vế. */
export function lampBaseAmount(lOwned: bigint, lLent: bigint, rhoQ: bigint): bigint {
  requireNonNegative("l_owned", lOwned);
  requireNonNegative("l_lent", lLent);
  requireNonNegative("rho_q", rhoQ);
  return lOwned * rhoQ / Q + min2(lLent * rhoQ / Q, LENT_PP_CAP);
}

/** sàn + ⌊(Q − sàn)/2⌋ (CC-GEN-COLD-START). */
export function usageFactorColdstartQ(): bigint {
  return USAGE_FACTOR_FLOOR_Q + (Q - USAGE_FACTOR_FLOOR_Q) / 2n;
}

/** 0 nếu Σg = 0, ngược lại min(Q, ⌊Σc·Q/Σg⌋) — MỘT phép chia. */
export function usageRatioQ(window: readonly EpochUsage[]): bigint {
  const [g, c] = closedWindowTotals(window);
  return ratioFromTotals(g, c);
}

/** coldstart nếu Σg = 0, ngược lại sàn + ⌊(Q − sàn)·ratio/Q⌋ (ratio đã sàn). */
export function usageFactorQ(window: readonly EpochUsage[]): bigint {
  const [g, c] = closedWindowTotals(window);
  return factorFromTotals(g, c);
}

/** base nếu Σg = 0; ⌊Σg·Q/(horizon·scale_coverage_q)⌋; horizon ≤ 0 ⟹ 0. */
export function scaleLimit(window: readonly EpochUsage[], horizon: bigint, base: bigint): bigint {
  requireNonNegative("base", base);
  const [g] = closedWindowTotals(window);
  return scaleFromTotals(g, horizon, base);
}

/** ⌊base·sàn/Q⌋ + ⌊min(base, scale_limit)·(uf − sàn)/Q⌋; horizon ≤ 0 ⟹ 0. */
export function amountByLamp(
  lOwned: bigint, lLent: bigint, window: readonly EpochUsage[], rhoQ: bigint, horizon: bigint,
): bigint {
  const base = lampBaseAmount(lOwned, lLent, rhoQ);
  const [g, c] = closedWindowTotals(window);
  if (horizon <= 0n) return 0n;
  const factor = factorFromTotals(g, c);
  const limit  = scaleFromTotals(g, horizon, base);
  return base * USAGE_FACTOR_FLOOR_Q / Q + min2(base, limit) * (factor - USAGE_FACTOR_FLOOR_Q) / Q;
}

/** min(amount_by_lamp, GB_available) — GB là TRẦN (CC-GEN-GB-ROLE). */
export function generationAmount(amountByLampValue: bigint, gbAvailable: bigint): bigint {
  requireNonNegative("amount_by_lamp", amountByLampValue);
  requireNonNegative("gb_available", gbAvailable);
  return min2(amountByLampValue, gbAvailable);
}

/** ⌊reset_amount·gb_vault_share_q/Q⌋ — trần rút mỗi vault mỗi epoch (SPEC §6.1.3). */
export function gbVaultShare(resetAmount: bigint): bigint {
  requireNonNegative("reset_amount", resetAmount);
  return resetAmount * GB_VAULT_SHARE_Q / Q;
}

/** Dịch k = to − from ô: thêm min(k, 7) ô 0 vào đầu, cắt còn 7. k < 0 ⟹ ném. */
export function shiftWindow(
  window: readonly EpochUsage[], fromEpoch: bigint, toEpoch: bigint,
): EpochUsage[] {
  requireWindow(window);
  const k = toEpoch - fromEpoch;
  if (k < 0n) throw new RangeError(`shift_window lùi thời gian: ${fromEpoch} → ${toEpoch}`);
  if (k === 0n) return window.map(u => ({ ...u }));
  const n = Number(min2(k, BigInt(USAGE_WINDOW_LEN)));
  const zeros: EpochUsage[] = Array.from({ length: n }, () => ({ generated: 0n, consumed: 0n }));
  return [...zeros, ...window.map(u => ({ ...u }))].slice(0, USAGE_WINDOW_LEN);
}

/** Cộng vào ô 0 (epoch đang mở). Âm ⟹ ném. */
export function windowAdd(
  window: readonly EpochUsage[], generated: bigint, consumed: bigint,
): EpochUsage[] {
  requireWindow(window);
  requireNonNegative("generated", generated);
  requireNonNegative("consumed", consumed);
  const [open, ...closed] = window;
  if (open === undefined) throw new RangeError("usage_window rỗng");   // requireWindow đã chặn
  return [
    { generated: open.generated + generated, consumed: open.consumed + consumed },
    ...closed.map(u => ({ ...u })),
  ];
}
