/**
 * VeData Oracle — PayOS Webhook Handler
 *
 * Spec §1.1 (PayOS):
 *   - Webhook (primary) with HMAC-SHA256 checksum verification
 *   - orderCode field maps directly to our referenceCode
 *   - Description limited to 25 chars — reference code fills the field
 *
 * PayOS webhook payload reference:
 *   https://payos.vn/docs/webhook
 */

import { createHmac } from "crypto";
import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { bus, type NormalizedPayment } from "../events.js";
import { extractValidRef, validateRefChecksum } from "./ref-extractor.js";

// ─── PayOS payload schema ─────────────────────────────────────────────────────

const PayOSWebhookSchema = z.object({
  code: z.string(),
  desc: z.string(),
  success: z.boolean(),
  data: z
    .object({
      orderCode: z.union([z.string(), z.number()]),
      amount: z.number().positive(),
      description: z.string(),
      accountNumber: z.string().optional(),
      reference: z.string().optional(),
      transactionDateTime: z.string().optional(),
      currency: z.string().optional(),
      paymentLinkId: z.string().optional(),
      code: z.string().optional(),
      desc: z.string().optional(),
      counterAccountBankId: z.string().optional(),
      counterAccountBankName: z.string().optional(),
      counterAccountName: z.string().optional(),
      counterAccountNumber: z.string().optional(),
      virtualAccountName: z.string().optional(),
      virtualAccountNumber: z.string().optional(),
    })
    .optional(),
  signature: z.string(),
});

type PayOSWebhookPayload = z.infer<typeof PayOSWebhookSchema>;

// ─── Signature verification ───────────────────────────────────────────────────

/**
 * PayOS computes the checksum as:
 *   HMAC-SHA256(CHECKSUM_KEY, sorted_query_string_of_data_fields)
 *
 * The query string is built by sorting data field names alphabetically, then
 * joining as "key=value&key=value".  Missing or null values are excluded.
 */
function verifyPayOSSignature(payload: PayOSWebhookPayload): boolean {
  const data = payload.data;
  if (!data) return false;

  // Sort keys alphabetically, build query string
  const sortedKeys = Object.keys(data).sort();
  const queryParts: string[] = [];
  for (const key of sortedKeys) {
    const value = (data as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) {
      queryParts.push(`${key}=${String(value)}`);
    }
  }
  const queryString = queryParts.join("&");

  const expected = createHmac("sha256", config.PAYOS_CHECKSUM_KEY)
    .update(queryString)
    .digest("hex");

  return expected === payload.signature;
}

// ─── Bank reference extraction for PayOS ─────────────────────────────────────

/**
 * PayOS description is limited to 25 chars and often equals the reference code
 * verbatim (buyers using VietQR-compatible apps get it pre-filled).
 * We first try the orderCode field, then fall back to scanning the description.
 */
function extractRefFromPayOS(data: NonNullable<PayOSWebhookPayload["data"]>): string | null {
  // orderCode should equal our referenceCode if QR was generated correctly
  const orderCodeStr = String(data.orderCode).trim().toUpperCase();
  if (orderCodeStr.length === 16 && /^[A-Z0-9]{16}$/.test(orderCodeStr)) {
    if (validateRefChecksum(orderCodeStr)) return orderCodeStr;
  }

  // Fallback: parse description field
  return extractValidRef(data.description);
}

// ─── Webhook route ────────────────────────────────────────────────────────────

export function createPayOSRouter(): Router {
  const router = createRouter();

  router.post(
    config.WEBHOOK_PATH_PAYOS,
    (req: Request, res: Response): void => {
      const childLog = logger.child({ handler: "payos-webhook" });

      // 1. Parse payload
      const parseResult = PayOSWebhookSchema.safeParse(req.body);
      if (!parseResult.success) {
        childLog.warn(
          { errors: parseResult.error.issues, body: req.body },
          "PayOS webhook: invalid payload shape"
        );
        // Respond 200 to prevent PayOS from retrying a malformed payload we cannot process
        res.status(200).json({ received: true, processed: false, reason: "invalid_shape" });
        return;
      }
      const payload = parseResult.data;

      // 2. Verify HMAC signature
      if (!verifyPayOSSignature(payload)) {
        childLog.error(
          { signature: payload.signature },
          "PayOS webhook: HMAC signature verification failed — possible spoofing attempt"
        );
        res.status(401).json({ error: "invalid_signature" });
        return;
      }

      // 3. Handle non-success events (cancelled, error) without signing
      if (!payload.success || payload.code !== "00") {
        childLog.info(
          { code: payload.code, desc: payload.desc },
          "PayOS webhook: non-payment event (cancel/error), no action needed"
        );
        res.status(200).json({ received: true, processed: false, reason: "non_payment_event" });
        return;
      }

      const data = payload.data;
      if (!data) {
        childLog.warn("PayOS webhook: success=true but data field missing");
        res.status(200).json({ received: true, processed: false, reason: "missing_data" });
        return;
      }

      // 4. Extract reference code
      const ref = extractRefFromPayOS(data);
      if (!ref) {
        childLog.warn(
          { orderCode: data.orderCode, description: data.description },
          "PayOS webhook: could not extract valid reference code from payload"
        );
        // Still acknowledge — will be caught by reconciler
        res.status(200).json({ received: true, processed: false, reason: "no_ref_extracted" });
        return;
      }

      // 5. Build normalized payment and emit
      const payment: NormalizedPayment = {
        source: "payos",
        bankTxRef: `payos-${data.paymentLinkId ?? data.orderCode}-${data.reference ?? Date.now()}`,
        amountVND: BigInt(Math.round(data.amount)),
        rawDescription: data.description,
        detectedAt: data.transactionDateTime
          ? new Date(data.transactionDateTime)
          : new Date(),
        rawPayload: payload as unknown as Record<string, unknown>,
      };

      childLog.info(
        { ref, amountVND: payment.amountVND.toString(), bankTxRef: payment.bankTxRef },
        "PayOS: payment confirmed, emitting event"
      );

      bus.emit("payment.confirmed", payment);

      res.status(200).json({ received: true, processed: true, ref });
    }
  );

  return router;
}
