/**
 * VeData Oracle — Option B Signature Endpoint
 *
 * POST /oracle/signature/:orderId
 *
 * For technically sophisticated buyers (DEXs, protocol integrators) who want to
 * build and submit the Cardano transaction themselves.
 *
 * Pre-conditions:
 *   - Order must exist
 *   - Order status must be PAYMENT_MATCHED or SIGNED (payment confirmed)
 *   - If SIGNED: return existing signature (idempotent)
 *   - If signature expired: re-sign within MAX_RESIGN_COUNT
 *
 * Returns: ReleaseAuthorization (spec §A.2)
 */

import type { Request, Response } from "express";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { signRelease, resignRelease, verifySignature } from "../signing/signer.js";

interface ReleaseAuthorization {
  status: "signed";
  orderId: string;
  referenceCode: string;
  signedMessageCbor: string;
  signatureHex: string;
  oraclePubKeyHex: string;
  expiryPOSIX: string;
  tokenPolicyId: string;
  tokenAssetNameHex: string;
  tokenAmount: string;
  buyerAddress: string;
  submissionMode: "buyer_submits";
  estimatedConfirmationSeconds: number;
}

export async function handleSignatureRequest(
  req: Request,
  res: Response
): Promise<void> {
  const { orderId } = req.params as { orderId: string };
  const childLog = logger.child({ orderId, handler: "signature-endpoint" });

  // 1. Load order
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { releaseSignature: true },
  });

  if (!order) {
    res.status(404).json({ error: "ORDER_NOT_FOUND" });
    return;
  }

  // 2. Check order state
  if (order.status === "PENDING") {
    res.status(402).json({
      error: "ORDER_NOT_MATCHED",
      message: "Payment has not been confirmed yet",
      status: order.status,
    });
    return;
  }

  if (order.status === "EXPIRED") {
    res.status(410).json({
      error: "EXPIRED",
      message: "Order has expired",
    });
    return;
  }

  if (
    order.status === "FINALIZED" ||
    order.status === "CONFIRMED" ||
    order.status === "SUBMITTED"
  ) {
    res.status(409).json({
      error: "ALREADY_CLAIMED",
      message: `Order is already in state: ${order.status}`,
      txHash: order.releaseSignature?.cardanoTxHash ?? null,
    });
    return;
  }

  if (order.status === "EXCEPTION") {
    res.status(409).json({
      error: "ORDER_EXCEPTION",
      message: "Order requires human review — contact support",
    });
    return;
  }

  // 3. Get or create signature
  let sig = order.releaseSignature;
  const nowPosix = Math.floor(Date.now() / 1000);

  if (sig) {
    // Check if expired
    if (Number(sig.expiryPosix) < nowPosix + 30) {
      childLog.info("Existing signature expired — re-signing for Option B request");
      const freshSig = await resignRelease(order, sig);
      // Reload
      sig = await prisma.releaseSignature.findUniqueOrThrow({ where: { orderId } });
      childLog.info({ newExpiry: freshSig.expiryPosix.toString() }, "Re-signed");
    }
  } else if (
    order.status === "PAYMENT_MATCHED" ||
    order.status === "SIGNING" ||
    order.status === "SIGNED"
  ) {
    // Sign now
    childLog.info("No existing signature — signing now");
    await signRelease(order);
    sig = await prisma.releaseSignature.findUniqueOrThrow({ where: { orderId } });

    // Advance status to SIGNED if not already
    if (order.status !== "SIGNED") {
      await prisma.order.update({
        where: { id: orderId },
        data: { status: "SIGNED" },
      });
    }
  } else {
    res.status(409).json({
      error: "ORDER_NOT_MATCHED",
      message: `Cannot sign order in state: ${order.status}`,
    });
    return;
  }

  if (!sig) {
    res.status(500).json({ error: "SIGNING_FAILED" });
    return;
  }

  // 4. Verify signature before returning (defensive check)
  const messageCborHex = Buffer.from(sig.messageBytes).toString("hex");
  const isValid = verifySignature(messageCborHex, sig.signatureHex, sig.oraclePubKeyHex);
  if (!isValid) {
    childLog.error("Signature verification failed — DO NOT return to buyer");
    res.status(500).json({ error: "SIGNATURE_VERIFICATION_FAILED" });
    return;
  }

  const response: ReleaseAuthorization = {
    status: "signed",
    orderId: order.id,
    referenceCode: order.referenceCode,
    signedMessageCbor: messageCborHex,
    signatureHex: sig.signatureHex,
    oraclePubKeyHex: sig.oraclePubKeyHex,
    expiryPOSIX: sig.expiryPosix.toString(),
    tokenPolicyId: order.tokenPolicy,
    tokenAssetNameHex: order.tokenName,
    tokenAmount: order.tokenAmount.toString(),
    buyerAddress: order.buyerWallet,
    submissionMode: "buyer_submits",
    estimatedConfirmationSeconds: 60,
  };

  res.json(response);
}
