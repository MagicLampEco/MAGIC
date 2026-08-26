// src/math.ts — PrepaidGen math engine (BigInt tuyệt đối)
// Sinh đôi bit-identical của onchain/lib/magiclamp/protocol/math.ak (P8).
// Bảng vector chung nằm ở onchain/.../vectors.ak — tests/p8.test.ts đọc THẲNG
// file đó rồi chạy các hàm dưới đây, nên hai bên không thể trôi khỏi nhau.

import { blake2b } from "@noble/hashes/blake2b";
import { BPS_DENOM, PAR_SCALE } from "./constants.js";

function requireNonNegative(name: string, v: bigint): void {
  if (v < 0n) throw new RangeError(`${name} phải ≥ 0, nhận ${v}`);
}

// ══════════════════════════════════════════════════════════════
// Par 1:1 — CARP ⇄ MAGIC ở tầng đơn vị cơ sở
// ══════════════════════════════════════════════════════════════

/**
 * nanogic = carpdrop × PAR_SCALE. Phép NHÂN → chính xác tuyệt đối, không phí,
 * không làm tròn (C-PP-1).
 */
export function parMagicFromCarp(carpdrop: bigint): bigint {
  requireNonNegative("carpdrop", carpdrop);
  return carpdrop * PAR_SCALE;
}

/**
 * carpdrop = ⌊ nanogic / PAR_SCALE ⌋.
 * Chỉ dùng cho TRẦN ĐÒI của provider (C-PP-6) và cho phần trả lại hạn-mức khi
 * dọn batch chết. Sàn ⌊⌋ lệch về phía an toàn (ra ÍT CARP hơn).
 *
 * BigInt `/` cắt về 0; với toán hạng không âm điều đó trùng với ⌊⌋ của Aiken,
 * nên chặn số âm ngay tại cửa thay vì để hai bên lệch ngầm.
 */
export function parCarpFromMagic(nanogic: bigint): bigint {
  requireNonNegative("nanogic", nanogic);
  return nanogic / PAR_SCALE;
}

// ══════════════════════════════════════════════════════════════
// Kế toán quỹ Paid (F2)
// ══════════════════════════════════════════════════════════════

/** outstanding = credit_issued − ⌊magic_settled / PAR_SCALE⌋ */
export function outstandingOf(creditIssued: bigint, magicSettled: bigint): bigint {
  return creditIssued - parCarpFromMagic(magicSettled);
}

/** buffer_floor = outstanding + ⌊ outstanding × buffer_bps / 10000 ⌋ */
export function bufferFloor(outstanding: bigint, bufferBps: bigint): bigint {
  requireNonNegative("outstanding", outstanding);
  requireNonNegative("bufferBps", bufferBps);
  return outstanding + (outstanding * bufferBps) / BPS_DENOM;
}

/** Trần cứng F2: claim_provider ≤ Σ MAGIC_burned_par */
export function claimCeiling(magicSettled: bigint, providerClaimed: bigint): bigint {
  return parCarpFromMagic(magicSettled) - providerClaimed;
}

// ══════════════════════════════════════════════════════════════
// Định danh — khớp byte với math.ak
// ══════════════════════════════════════════════════════════════

function beBytes(value: bigint, width: number): Uint8Array {
  requireNonNegative("value", value);
  const out = new Uint8Array(width);
  let v = value;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new RangeError(`giá trị ${value} không lọt ${width} byte`);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`hex lẻ byte: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** batch_id = blake2b256(tx_hash ∥ be8(output_index) ∥ be8(batch_index)) */
export function computeBatchId(
  txHash: string,
  outputIndex: bigint,
  batchIndex: bigint,
): string {
  const pre = concat(hexToBytes(txHash), beBytes(outputIndex, 8), beBytes(batchIndex, 8));
  return bytesToHex(blake2b(pre, { dkLen: 32 }));
}

/** fund_id = blake2b256(tx_hash ∥ be8(output_index)) của input bị tiêu lúc đúc */
export function computeFundId(txHash: string, outputIndex: bigint): string {
  const pre = concat(hexToBytes(txHash), beBytes(outputIndex, 8));
  return bytesToHex(blake2b(pre, { dkLen: 32 }));
}
