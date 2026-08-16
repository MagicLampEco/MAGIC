// src/oracle.ts — Ed25519 oracle signing and message construction for GetMAGIC
// ALL amounts are BigInt. NEVER use Number for nanogic or epoch amounts.
//
// ── FRAMING RULE (must match getmagic/utils.ak byte-for-byte — P8) ─────────
//   LP(s)    = u32be(len(s)) ++ s
//   alloc_id = blake2b_256("MAGIC_ALLOC_ID:v1" ++ 0x00 ++ LP(order_id) ++ LP(user_pkh))
//   settle   = "MAGIC_ORACLE_SETTLE:v1" ++ 0x00
//                ++ LP(order_id) ++ LP(user_pkh) ++ LP(nonce) ++ u64be(timestamp)
//   voucher  = "MAGIC_VOUCHER:v1" ++ 0x00 ++ LP(alloc_id)
//                ++ u64be(epoch) ++ u64be(nanogic) ++ u64be(expiry_posix)
//
// Plain concatenation of variable-length fields is NOT injective: moving bytes
// across a field boundary yields the same byte string, so one hash / one oracle
// signature covers several different field-sets (nợ #26). Any NEW variable-
// length field MUST be wrapped in `lengthPrefixed`, and the Aiken side in
// onchain/lib/getmagic/utils.ak must change in the SAME commit.

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

/** Encode bigint to 4-byte big-endian (length prefix). */
function encodeInt4Bytes(n: number): Uint8Array {
  if (n < 0 || n > 0xffff_ffff) throw new Error("encodeInt4Bytes: out of u32 range");
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n, false); // false = big-endian
  return buf;
}

/**
 * LP(s) = u32be(len(s)) ++ s — makes a variable-length field self-delimiting.
 * Matches Aiken: `length_prefixed` in getmagic/utils.ak
 */
export function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  return concatBytes(encodeInt4Bytes(bytes.length), bytes);
}

// ── Domain tags (ASCII, no 0x00 inside) ───────────────────────
// Must equal domain_alloc_id / domain_oracle_settle / domain_voucher in utils.ak.

const DOMAIN_ALLOC_ID      = new TextEncoder().encode("MAGIC_ALLOC_ID:v1");
const DOMAIN_ORACLE_SETTLE = new TextEncoder().encode("MAGIC_ORACLE_SETTLE:v1");
const DOMAIN_VOUCHER       = new TextEncoder().encode("MAGIC_VOUCHER:v1");

/** `tag ++ 0x00` — domain separator prefix. */
function domainPrefix(tag: Uint8Array): Uint8Array {
  return concatBytes(tag, new Uint8Array([0x00]));
}

/** alloc_id is a blake2b_256 digest — always 32 bytes. Enforced, not assumed. */
export const ALLOC_ID_LENGTH = 32;

// ── Oracle settle message ─────────────────────────────────────

/**
 * Build oracle settlement message (G-OTC-1).
 *   msg = "MAGIC_ORACLE_SETTLE:v1" ++ 0x00
 *      ++ LP(order_id) ++ LP(user_pkh) ++ LP(nonce) ++ u64be(timestamp_ms)
 *
 * Matches Aiken: build_oracle_settle_msg in getmagic/utils.ak
 */
export function buildOracleSettleMsg(
  orderId:     string,  // hex — ASCII bytes of the order ID
  userPkh:     string,  // hex — 28-byte payment key hash
  nonce:       string,  // hex — 32-byte blake2b_256 nonce
  timestampMs: bigint,  // Unix ms
): Uint8Array {
  return concatBytes(
    domainPrefix(DOMAIN_ORACLE_SETTLE),
    lengthPrefixed(hexToBytes(orderId)),
    lengthPrefixed(hexToBytes(userPkh)),
    lengthPrefixed(hexToBytes(nonce)),
    encodeInt8Bytes(timestampMs),
  );
}

// ── Epoch voucher message ─────────────────────────────────────

/**
 * Build epoch voucher message (G-ALLOC-1).
 *   msg = "MAGIC_VOUCHER:v1" ++ 0x00 ++ LP(alloc_id)
 *      ++ u64be(epoch) ++ u64be(nanogic) ++ u64be(expiry_posix)
 *
 * Matches Aiken: build_voucher_msg in getmagic/utils.ak
 * Throws on a non-32-byte allocId — mirrors the on-chain
 * `expect bytearray.length(alloc_id) == 32`.
 */
export function buildVoucherMsg(
  allocId:      string,  // hex — 32-byte alloc ID (see deriveAllocId)
  epoch:        bigint,
  nanogic:      bigint,  // NEVER use Number here (C-OVERFLOW)
  expiryPosixMs: bigint,
): Uint8Array {
  const allocBytes = hexToBytes(allocId);
  if (allocBytes.length !== ALLOC_ID_LENGTH) {
    throw new Error(
      `buildVoucherMsg: allocId must be ${ALLOC_ID_LENGTH} bytes, got ${allocBytes.length}`,
    );
  }
  return concatBytes(
    domainPrefix(DOMAIN_VOUCHER),
    lengthPrefixed(allocBytes),
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
 * Derive alloc_id:
 *   blake2b_256("MAGIC_ALLOC_ID:v1" ++ 0x00 ++ LP(order_id) ++ LP(user_pkh))
 *
 * Matches Aiken: build_alloc_id in getmagic/utils.ak
 *
 * alloc_id is a LOOKUP KEY (accounting, double-claim tracking, vouchers). The
 * old raw-concat form let two different (order_id, user_pkh) pairs map to one
 * key, and it failed silently — no signature check would trip.
 *
 * @returns 32-byte alloc ID in hex
 */
export function deriveAllocId(orderId: string, userPkh: string): string {
  const preimage = concatBytes(
    domainPrefix(DOMAIN_ALLOC_ID),
    lengthPrefixed(hexToBytes(orderId)),
    lengthPrefixed(hexToBytes(userPkh)),
  );
  const hash = blake2b(preimage, { dkLen: 32 });
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
