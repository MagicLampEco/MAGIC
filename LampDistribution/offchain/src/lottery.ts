// LampDistribution Lottery engine (SPEC §3, nguồn §5) — first-principles.
// Per-ticket verifiable: seed = blake2b256(nonce ‖ wallet ‖ uint64BE(i)).

import { blake2b } from "@noble/hashes/blake2b";
import { Q, TARGET_RATE_Q } from "./constants.js";
import { hexToBytes, concatBytes, uint64BE } from "./merkle.js";
import type { LotteryAccount, LotteryResult } from "./types.js";

/** ⌈a / b⌉ cho b > 0 — khớp onchain ceil_div. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("LOTTERY-000: divisor must be > 0");
  if (a <= 0n) return 0n;
  return (a + b - 1n) / b;
}

/** 32-byte seed → uint256 big-endian. */
export function bytesToBigIntBE(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

/** Threshold thắng = target_rate × 2^256 (Q-format). seed < threshold ⇒ thắng. */
export function winThreshold(targetRateQ: bigint = TARGET_RATE_Q): bigint {
  return (targetRateQ * (1n << 256n)) / Q;
}

/** 1 ticket có thắng không (tất định, verifiable từ nonce+wallet+index). */
export function ticketWins(
  nonce: Uint8Array, walletHex: string, index: bigint, threshold: bigint,
): boolean {
  const seed = blake2b(concatBytes(nonce, hexToBytes(walletHex), uint64BE(index)), { dkLen: 32 });
  return bytesToBigIntBE(seed) < threshold;
}

export interface LotteryParams {
  nonceHex   : string;   // RandomnessBeacon[N] (32 bytes hex)
  P          : bigint;   // PParamBeacon[N] (oil/drop)
  targetRateQ?: bigint;  // mặc định TARGET_RATE_Q
  /** Giới hạn an toàn số ticket lặp/wallet (MVP). Whale lớn cần tối ưu binomial ở V2. */
  maxTicketsPerWallet?: bigint;
}

/**
 * Chạy lottery cho 1 epoch. Trả won_cumulative mới cho mỗi wallet (đơn điệu tăng).
 * remaining = claimedCum − wonCumPrev; D = ceil(remaining / P); đếm wins per ticket;
 * wonThis = min(d × P, remaining) (§5.4 — không vượt remaining).
 */
export function runLottery(accounts: LotteryAccount[], params: LotteryParams): LotteryResult[] {
  const { nonceHex, P } = params;
  if (P <= 0n) throw new Error("LOTTERY-001: P must be > 0");
  const nonce = hexToBytes(nonceHex);
  if (nonce.length !== 32) throw new Error(`LOTTERY-002: nonce must be 32 bytes, got ${nonce.length}`);

  const threshold = winThreshold(params.targetRateQ ?? TARGET_RATE_Q);
  const maxTickets = params.maxTicketsPerWallet ?? 1_000_000n;

  const out: LotteryResult[] = [];
  for (const acc of accounts) {
    const remaining = acc.claimedCum - acc.wonCumPrev;
    if (remaining <= 0n) {
      out.push({ owner: acc.owner, wonCumNew: acc.wonCumPrev, wonThis: 0n, tickets: 0n, wins: 0n });
      continue;
    }
    const D = ceilDiv(remaining, P);
    if (D > maxTickets) {
      throw new Error(
        `LOTTERY-003: wallet ${acc.owner} has ${D} tickets > maxTicketsPerWallet ${maxTickets}. ` +
        `Tăng maxTicketsPerWallet hoặc dùng binomial sampling (V2).`,
      );
    }
    let d = 0n;
    for (let i = 0n; i < D; i++) {
      if (ticketWins(nonce, acc.owner, i, threshold)) d += 1n;
    }
    const wonThis = (d * P < remaining) ? d * P : remaining;  // min(d×P, remaining)
    out.push({
      owner: acc.owner,
      wonCumNew: acc.wonCumPrev + wonThis,
      wonThis,
      tickets: D,
      wins: d,
    });
  }
  return out;
}
