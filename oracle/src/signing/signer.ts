/**
 * VeData Oracle — Ed25519 Signing Service
 *
 * Spec §3: Message format = CBOR array, signed with Ed25519 (RFC 8032).
 * Cardano on-chain verification uses:
 *   builtin.verifyEd25519Signature(vkey_32bytes, message_bytes, sig_64bytes)
 *
 * Message structure (§3.1):
 *   [
 *     1,               ; version
 *     orderId,         ; text string 16 chars
 *     buyerWallet,     ; bytes(28) payment key hash
 *     tokenPolicyId,   ; bytes(28)
 *     tokenAssetName,  ; bytes(0..32)
 *     tokenAmount,     ; uint
 *     expiryPOSIX,     ; uint
 *     nonce,           ; bytes(16)
 *   ]
 *
 * CBOR is deterministic (definite-length encoding, cbor library with canonical=true).
 */

import { ed25519 } from "@noble/curves/ed25519";
import * as cbor from "cbor";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { prisma } from "../db.js";
import type { Order, ReleaseSignature } from "@prisma/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SignedRelease {
  orderId: string;
  signatureHex: string;
  messageCborHex: string;
  oraclePubKeyHex: string;
  expiryPosix: bigint;
  nonce: Buffer;
}

// ─── Key loading ──────────────────────────────────────────────────────────────

let _privateKeyBytes: Uint8Array | null = null;
let _publicKeyBytes: Uint8Array | null = null;

export function loadKey(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  if (_privateKeyBytes && _publicKeyBytes) {
    return { privateKey: _privateKeyBytes, publicKey: _publicKeyBytes };
  }

  const privHex = config.ORACLE_PRIVATE_KEY;
  const pubHex = config.ORACLE_PUBLIC_KEY;

  _privateKeyBytes = Buffer.from(privHex, "hex");
  _publicKeyBytes = Buffer.from(pubHex, "hex");

  if (_privateKeyBytes.length !== 32) {
    throw new Error(
      `ORACLE_PRIVATE_KEY must be 32 bytes (64 hex chars); got ${_privateKeyBytes.length} bytes`
    );
  }
  if (_publicKeyBytes.length !== 32) {
    throw new Error(
      `ORACLE_PUBLIC_KEY must be 32 bytes (64 hex chars); got ${_publicKeyBytes.length} bytes`
    );
  }

  // Sanity check: derive public key from private and compare
  const derivedPub = ed25519.getPublicKey(_privateKeyBytes);
  const derivedHex = Buffer.from(derivedPub).toString("hex");
  if (derivedHex !== pubHex.toLowerCase()) {
    throw new Error(
      `ORACLE_PUBLIC_KEY does not match ORACLE_PRIVATE_KEY derivation. ` +
        `Expected ${derivedHex}, got ${pubHex.toLowerCase()}`
    );
  }

  logger.info(
    { pubKeyHex: pubHex.slice(0, 16) + "..." },
    "Oracle key loaded and verified"
  );

  return { privateKey: _privateKeyBytes, publicKey: _publicKeyBytes };
}

// ─── Message builder ──────────────────────────────────────────────────────────

export interface OracleMessageInput {
  orderId: string;         // 16-char reference code
  buyerPkh: string;        // Hex 56-char (28 bytes) payment key hash
  tokenPolicyId: string;   // Hex 56-char (28 bytes)
  tokenAssetName: string;  // Hex bytes (0–64 hex chars = 0–32 bytes)
  tokenAmount: bigint;
  expiryPosix: bigint;
  nonce: Buffer;           // 16 random bytes
}

/**
 * Serialise oracle release message to deterministic CBOR bytes.
 * The resulting bytes are what Ed25519 signs; on-chain verifier receives
 * these exact bytes as the "message" argument to verifyEd25519Signature.
 */
export function buildOracleMessageCbor(input: OracleMessageInput): Buffer {
  const {
    orderId,
    buyerPkh,
    tokenPolicyId,
    tokenAssetName,
    tokenAmount,
    expiryPosix,
    nonce,
  } = input;

  const message = [
    1,                                       // version
    orderId,                                 // text string
    Buffer.from(buyerPkh, "hex"),            // bytes(28)
    Buffer.from(tokenPolicyId, "hex"),       // bytes(28)
    Buffer.from(tokenAssetName, "hex"),      // bytes(0..32)
    tokenAmount,                             // uint (BigInt handled by cbor lib)
    expiryPosix,                             // uint
    nonce,                                   // bytes(16)
  ];

  // cbor.encodeCanonical produces definite-length, deterministic encoding
  return cbor.encodeCanonical(message);
}

// ─── Signer ───────────────────────────────────────────────────────────────────

/**
 * Build and sign the release message for an order.
 * Stores the result in the `release_signatures` table.
 * Idempotent: if a signature already exists for this order, returns it.
 */
export async function signRelease(order: Order): Promise<SignedRelease> {
  const childLog = logger.child({ orderId: order.id, component: "signer" });

  // 1. Check for existing signature (idempotency)
  const existing = await prisma.releaseSignature.findUnique({
    where: { orderId: order.id },
  });
  if (existing) {
    childLog.info("Returning existing signature (idempotent)");
    return {
      orderId: order.id,
      signatureHex: existing.signatureHex,
      messageCborHex: Buffer.from(existing.messageBytes).toString("hex"),
      oraclePubKeyHex: existing.oraclePubKeyHex,
      expiryPosix: existing.expiryPosix,
      nonce: Buffer.from(existing.nonce),
    };
  }

  // 2. Load signing key
  const { privateKey, publicKey } = loadKey();

  // 3. Build message
  const nonce = Buffer.allocUnsafe(16);
  crypto.getRandomValues(new Uint8Array(nonce.buffer, nonce.byteOffset, nonce.byteLength));

  const expiryPosix = BigInt(Math.floor(Date.now() / 1000)) +
    BigInt(config.RELEASE_SIGNATURE_TTL_MINUTES * 60);

  const msgInput: OracleMessageInput = {
    orderId: order.referenceCode,
    buyerPkh: order.buyerPkh,
    tokenPolicyId: order.tokenPolicy,
    tokenAssetName: order.tokenName,
    tokenAmount: order.tokenAmount,
    expiryPosix,
    nonce,
  };

  const messageCbor = buildOracleMessageCbor(msgInput);

  // 4. Sign with Ed25519
  const signatureBytes = ed25519.sign(messageCbor, privateKey);

  const signatureHex = Buffer.from(signatureBytes).toString("hex");
  const pubKeyHex = Buffer.from(publicKey).toString("hex");
  const messageCborHex = messageCbor.toString("hex");

  childLog.info(
    {
      signatureLen: signatureBytes.length,
      messageLen: messageCbor.length,
      expiryPosix: expiryPosix.toString(),
    },
    "Signature produced"
  );

  // 5. Persist — UNIQUE(orderId) prevents double-signing at DB level
  await prisma.releaseSignature.create({
    data: {
      orderId: order.id,
      messageBytes: messageCbor,
      signatureHex,
      oraclePubKeyHex: pubKeyHex,
      expiryPosix,
      nonce,
    },
  });

  return {
    orderId: order.id,
    signatureHex,
    messageCborHex,
    oraclePubKeyHex: pubKeyHex,
    expiryPosix,
    nonce,
  };
}

// ─── Verification helper (testing / external callers) ─────────────────────────

/**
 * Verify a release signature.
 * Used in tests and for the Option B signature endpoint validation.
 */
export function verifySignature(
  messageCborHex: string,
  signatureHex: string,
  pubKeyHex: string
): boolean {
  try {
    const message = Buffer.from(messageCborHex, "hex");
    const signature = Buffer.from(signatureHex, "hex");
    const pubKey = Buffer.from(pubKeyHex, "hex");
    return ed25519.verify(signature, message, pubKey);
  } catch {
    return false;
  }
}

/**
 * Re-sign an order (for expired signatures when Option A oracle-submits path retries).
 * Enforces MAX_RESIGN_COUNT.
 */
export async function resignRelease(
  order: Order,
  existingSig: ReleaseSignature
): Promise<SignedRelease> {
  const childLog = logger.child({ orderId: order.id, component: "signer" });

  if (existingSig.submissionAttempts >= config.MAX_RESIGN_COUNT) {
    throw new Error(
      `Order ${order.id} has exceeded MAX_RESIGN_COUNT (${config.MAX_RESIGN_COUNT}). ` +
        "Manual intervention required."
    );
  }

  childLog.info(
    { attempt: existingSig.submissionAttempts + 1 },
    "Re-signing order with fresh nonce and expiry"
  );

  // Delete old signature so the idempotency check in signRelease doesn't short-circuit
  await prisma.releaseSignature.delete({ where: { orderId: order.id } });
  await prisma.order.update({
    where: { id: order.id },
    data: { status: "PAYMENT_MATCHED" },
  });

  // Preserve submission attempt count
  const newSig = await signRelease(order);

  // Restore attempt count
  await prisma.releaseSignature.update({
    where: { orderId: order.id },
    data: {
      submissionAttempts: existingSig.submissionAttempts + 1,
    },
  });

  return newSig;
}
