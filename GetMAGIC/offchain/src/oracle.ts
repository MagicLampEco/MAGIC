// src/oracle.ts — Ed25519 oracle signing and message construction for GetMAGIC
// ALL amounts are BigInt. NEVER use Number for nanogic or epoch amounts.
//
// Message formats (must match getmagic/utils.ak exactly — P8):
//   settle_msg  = order_id(var) ++ user_pkh(28) ++ nonce(32) ++ timestamp(8 BE)
//   voucher_msg = alloc_id(32)  ++ epoch(8 BE)  ++ nanogic(8 BE) ++ expiry_posix(8 BE)

import { blake2b } from "@noble/hashes/blake2b";
import { ed25519 } from "@noble/curves/ed25519";

// ── Encoding helpers ─────────────────────────────────────────

/** Encode bigint to 8-byte big-endian Uint8Array (matches Aiken encode_int_8bytes). */
function encodeInt8Bytes(n: bigint): Uint8Array {
  if (n < 0n) throw new Error("encodeInt8Bytes: negative value");
  const buf = new Uint8Array(8);
  const dv  = new DataView(buf.buffer);
  // DataView.setBigUint64 handles 64-bit unsigned big-endian correctly
  dv.setBigUint64(0, n, false); // false = big-endian
  return buf;
}

/** Hex string → Uint8Array */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hexToBytes: odd-length hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Uint8Array → lowercase hex string */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Concatenate multiple Uint8Arrays */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

// ── Oracle settle message ─────────────────────────────────────

/**
 * Build oracle settlement message (G-OTC-1).
 *   msg = order_id ++ user_pkh ++ nonce ++ timestamp_ms(8 BE)
 *
 * Matches Aiken: build_oracle_settle_msg in getmagic/utils.ak
 */
export function buildOracleSettleMsg(
  orderId:     string,  // hex — ASCII bytes of 16-char order ID
  userPkh:     string,  // hex — 28-byte payment key hash
  nonce:       string,  // hex — 32-byte blake2b_256 nonce
  timestampMs: bigint,  // Unix ms
): Uint8Array {
  return concatBytes(
    hexToBytes(orderId),
    hexToBytes(userPkh),
    hexToBytes(nonce),
    encodeInt8Bytes(timestampMs),
  );
}

// ── Epoch voucher message ─────────────────────────────────────

/**
 * Build epoch voucher message (G-ALLOC-1).
 *   msg = alloc_id(32) ++ epoch(8 BE) ++ nanogic(8 BE) ++ expiry_posix(8 BE)
 *
 * Matches Aiken: build_voucher_msg in getmagic/utils.ak
 */
export function buildVoucherMsg(
  allocId:      string,  // hex — 32-byte blake2b_256 of (order_id ++ user_pkh)
  epoch:        bigint,
  nanogic:      bigint,  // NEVER use Number here (C-OVERFLOW)
  expiryPosixMs: bigint,
): Uint8Array {
  return concatBytes(
    hexToBytes(allocId),
    encodeInt8Bytes(epoch),
    encodeInt8Bytes(nanogic),
    encodeInt8Bytes(expiryPosixMs),
  );
}

// ── Signing and verification ──────────────────────────────────

/**
 * Sign a message with an Ed25519 private key.
 * @param privateKeyHex  32-byte private key in hex
 * @param msg            message bytes
 * @returns              64-byte signature in hex
 */
export async function signMsg(
  privateKeyHex: string,
  msg:           Uint8Array,
): Promise<string> {
  const privKey = hexToBytes(privateKeyHex);
  const sig     = ed25519.sign(msg, privKey);
  return bytesToHex(sig);
}

/**
 * Verify an Ed25519 signature.
 * @param vkeyHex  32-byte verification key in hex
 * @param msg      message bytes
 * @param sigHex   64-byte signature in hex
 */
export function verifyMsg(
  vkeyHex: string,
  msg:     Uint8Array,
  sigHex:  string,
): boolean {
  try {
    const vkey = hexToBytes(vkeyHex);
    const sig  = hexToBytes(sigHex);
    return ed25519.verify(sig, msg, vkey);
  } catch {
    return false;
  }
}

// ── Nonce generation ──────────────────────────────────────────

/**
 * Generate oracle nonce: blake2b_256(orderId_bytes ++ bankTxRef_bytes).
 * This binds the settlement to a specific bank transaction reference.
 * @returns 32-byte nonce in hex
 */
export function generateNonce(orderId: string, bankTxRef: string): string {
  const combined = concatBytes(hexToBytes(orderId), new TextEncoder().encode(bankTxRef));
  const hash     = blake2b(combined, { dkLen: 32 });
  return bytesToHex(hash);
}

// ── Alloc ID derivation ───────────────────────────────────────

/**
 * Derive alloc_id: blake2b_256(order_id_bytes ++ user_pkh_bytes).
 * @returns 32-byte alloc ID in hex
 */
export function deriveAllocId(orderId: string, userPkh: string): string {
  const combined = concatBytes(hexToBytes(orderId), hexToBytes(userPkh));
  const hash     = blake2b(combined, { dkLen: 32 });
  return bytesToHex(hash);
}

// ── Epoch voucher batch generation ───────────────────────────

/**
 * Generate pre-signed epoch vouchers for an allocation.
 * Called by the oracle at settlement time.
 *
 * Each voucher authorises claim of `nanogicPerEpoch` for one epoch.
 * Voucher at index i = voucher for epoch (startEpoch + i).
 *
 * @param privateKeyHex    32-byte oracle private key in hex
 * @param allocId          32-byte alloc ID in hex
 * @param startEpoch       first epoch in allocation window
 * @param totalEpochs      number of epochs (typically 6)
 * @param nanogicPerEpoch  MAGIC per epoch (NEVER Number — C-OVERFLOW)
 * @param expiryEpoch      expiry_epoch for the allocation
 * @returns                array of totalEpochs 64-byte signatures in hex
 */
export async function generateEpochVouchers(
  privateKeyHex:   string,
  allocId:         string,
  startEpoch:      bigint,
  totalEpochs:     bigint,
  nanogicPerEpoch: bigint,
  expiryEpoch:     bigint,
): Promise<string[]> {
  // expiry_posix_ms approximation matches Aiken validator:
  //   expiry_posix_ms = expiry_epoch * 86_400_000
  // (Preview/Preprod ms-per-epoch; hardcoded to match on-chain formula)
  const expiryPosixMs = expiryEpoch * 86_400_000n;

  const vouchers: string[] = [];
  for (let i = 0n; i < totalEpochs; i++) {
    const epoch = startEpoch + i;
    const msg   = buildVoucherMsg(allocId, epoch, nanogicPerEpoch, expiryPosixMs);
    const sig   = await signMsg(privateKeyHex, msg);
    vouchers.push(sig);
  }
  return vouchers;
}
