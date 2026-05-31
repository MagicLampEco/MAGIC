// LampDistribution P parameter engine (SPEC §4, nguồn §6) — algorithmic monetary policy.
// Off-chain compute + announce 1 epoch trước (QĐ3). Q-format BigInt.

import { Q, P_MIN, P_MAX, MAX_P_DELTA_Q, SENSITIVITY_Q } from "./constants.js";
import type { PSignals } from "./types.js";

function clampBig(x: bigint, lo: bigint, hi: bigint): bigint {
  return x < lo ? lo : x > hi ? hi : x;
}

/** f(S3): trọng số hạ tầng LampNet vào demand. MVP = identity (đã quy đổi đơn vị).
 *  [Design choice — điều chỉnh khi có mô hình tải hạ tầng thực.] */
export function infraWeight(lampnetUtil: bigint): bigint {
  return lampnetUtil;
}

export interface PComputeResult {
  pNext     : bigint;  // oil/drop cho epoch kế (đã clamp)
  emaNew    : bigint;  // EMA state mới (Q) — truyền sang epoch sau
  ratioQ    : bigint;  // demand/supply (Q) — để audit/announce
  rawDeltaQ : bigint;  // (ratio−1)×sensitivity (Q)
  boundedQ  : bigint;  // sau EMA + clamp ±10% (Q)
}

/**
 * Tính P_{N+1} từ signals epoch N + EMA state trước.
 *   demand = S1 + f(S3);  ratio = demand / S2
 *   raw_delta = (ratio − 1) × sensitivity
 *   ema = (raw_delta + ema_prev) / 2           (α = 0.5, window=3)
 *   bounded = clamp(ema, −10%, +10%)
 *   P_next = clamp( P × (Q + bounded) / Q , P_MIN, P_MAX )
 *
 * S2 = 0 → giữ nguyên P (không có supply để cân bằng) — an toàn, không chia 0.
 */
export function computeNextP(
  pCurrent: bigint,
  signals : PSignals,
  emaPrevQ: bigint = 0n,
): PComputeResult {
  if (pCurrent <= 0n) throw new Error("PPARAM-000: pCurrent must be > 0");

  const demand = signals.magicConsumed + infraWeight(signals.lampnetUtil);
  const S2 = signals.magicGenerated;

  if (S2 <= 0n) {
    // Không có nguồn cung để so → không điều chỉnh.
    const pNext = clampBig(pCurrent, P_MIN, P_MAX);
    return { pNext, emaNew: emaPrevQ, ratioQ: Q, rawDeltaQ: 0n, boundedQ: 0n };
  }

  const ratioQ = (demand * Q) / S2;                       // demand/supply (Q)
  const rawDeltaQ = ((ratioQ - Q) * SENSITIVITY_Q) / Q;   // (ratio−1)×sensitivity (Q)
  const emaNew = (rawDeltaQ + emaPrevQ) / 2n;             // α=0.5
  const boundedQ = clampBig(emaNew, -MAX_P_DELTA_Q, MAX_P_DELTA_Q);

  const pRaw = (pCurrent * (Q + boundedQ)) / Q;
  const pNext = clampBig(pRaw, P_MIN, P_MAX);

  return { pNext, emaNew, ratioQ, rawDeltaQ, boundedQ };
}
