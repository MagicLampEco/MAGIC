/**
 * Internal oracle endpoints — mTLS auth (CN=vedata-oracle).
 * Dev fallback: X-Oracle-Secret header.
 *
 * POST /v1/internal/oracle/payment-confirmed
 * POST /v1/internal/oracle/payment-failed
 * POST /v1/internal/oracle/order-completed   (chain indexer)
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { requireOracleAuth } from "../middleware/auth.js";
import { newRequestId } from "../lib/requestId.js";
import { ServiceError } from "../lib/errors.js";
import {
  markPaymentDetected,
  markPaymentFailed,
  markOrderCompleted,
  markReleaseSubmitted,
  type FailureReason,
} from "../services/order.service.js";

// ─── Zod schemas ───────────────────────────────────────────────────────────────

const paymentConfirmedBody = z.object({
  orderId: z.string().min(1),
  paymentEvidence: z.object({
    bankTransactionId: z.string().min(1),
    bankCode:          z.string().min(2),
    fromAccount:       z.string().min(1),
    toAccount:         z.string().min(1),
    amount:            z.number().int().positive(),
    referenceCode:     z.string().min(1),
    transactionTime:   z.string().datetime(),
    rawNapasRef:       z.string().optional(),
  }),
  oracleAttestation: z.object({
    cbor:       z.string().min(4),
    datumHash:  z.string().optional(),
    signedAt:   z.string().datetime(),
  }).optional(),
});

const paymentFailedBody = z.object({
  orderId:    z.string().min(1),
  reason:     z.enum(["PAYMENT_EXPIRED", "AMOUNT_MISMATCH", "WRONG_REFERENCE", "BANK_REJECTED"]),
  detail:     z.string().optional(),
  detectedAt: z.string().datetime().optional(),
});

const releaseSubmittedBody = z.object({
  orderId:     z.string().min(1),
  txHash:      z.string().regex(/^[a-f0-9]{64}$/, "txHash phải là 64 ký tự hex"),
  txCbor:      z.string().optional(),
  triggerMode: z.enum(["AUTOMATIC", "BUYER_SUBMITTED", "ADMIN_MANUAL"]).default("AUTOMATIC"),
});

const orderCompletedBody = z.object({
  orderId:     z.string().min(1),
  txHash:      z.string().regex(/^[a-f0-9]{64}$/),
  blockHeight: z.number().int().positive(),
  blockTime:   z.string().datetime(),
});

// ─── Route registration ────────────────────────────────────────────────────────

export async function internalRoutes(fastify: FastifyInstance): Promise<void> {
  // ── POST /v1/internal/oracle/payment-confirmed ─────────────────────────────
  fastify.post(
    "/v1/internal/oracle/payment-confirmed",
    { preHandler: [requireOracleAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = newRequestId();
      reply.header("X-Request-ID", requestId);

      const body = paymentConfirmedBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error:     "VALIDATION_ERROR",
          message:   body.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "),
          requestId,
          timestamp: new Date().toISOString(),
        });
      }

      try {
        const { orderId, paymentEvidence, oracleAttestation } = body.data;

        const result = await markPaymentDetected({
          orderId,
          bankTransactionId: paymentEvidence.bankTransactionId,
          bankCode:          paymentEvidence.bankCode,
          fromAccount:       paymentEvidence.fromAccount,
          toAccount:         paymentEvidence.toAccount,
          amount:            paymentEvidence.amount,
          referenceCode:     paymentEvidence.referenceCode,
          transactionTime:   paymentEvidence.transactionTime,
          napasRef:          paymentEvidence.rawNapasRef,
          oracleCbor:        oracleAttestation?.cbor,
          oracleDatumHash:   oracleAttestation?.datumHash,
          oracleSignedAt:    oracleAttestation?.signedAt,
        });

        // Push WebSocket event (server is injected via fastify.io / wsServer if available)
        const ws = (fastify as FastifyInstance & { wsServer?: { toOrder?: (id: string) => { emit?: (event: string, data: unknown) => void } } }).wsServer;
        ws?.toOrder?.(orderId)?.emit?.("order.status", {
          event:          "order.status",
          orderId,
          previousStatus: result.previousStatus,
          newStatus:      result.newStatus,
          at:             new Date().toISOString(),
          actor:          "ORACLE",
        });

        if (result.newStatus === "PAYMENT_DETECTED") {
          ws?.toOrder?.(orderId)?.emit?.("order.payment_detected", {
            event:            "order.payment_detected",
            orderId,
            amountVND:        paymentEvidence.amount,
            bankTransactionId: paymentEvidence.bankTransactionId,
            detectedAt:       paymentEvidence.transactionTime,
            message:          "Thanh toán đã xác nhận. Đang giải phóng token.",
          });
        }

        return reply.status(200).send({
          orderId,
          previousStatus: result.previousStatus,
          newStatus:      result.newStatus,
          releaseTrigger: result.releaseTrigger,
          message:        result.newStatus === "PAYMENT_DETECTED"
            ? "Thanh toán xác nhận. Kích hoạt release on-chain tự động."
            : `Order chuyển sang ${result.newStatus}.`,
        });

      } catch (err) {
        if (err instanceof ServiceError) {
          const status = err.statusCode === 409 && err.code === "ALREADY_PROCESSED" ? 409 : err.statusCode;
          return reply.status(status).send({
            error:         err.code,
            message:       err.message,
            currentStatus: (err.details as { currentStatus?: string } | undefined)?.currentStatus,
            requestId,
            timestamp:     new Date().toISOString(),
          });
        }
        throw err;
      }
    },
  );

  // ── POST /v1/internal/oracle/payment-failed ────────────────────────────────
  fastify.post(
    "/v1/internal/oracle/payment-failed",
    { preHandler: [requireOracleAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = newRequestId();
      reply.header("X-Request-ID", requestId);

      const body = paymentFailedBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error:     "VALIDATION_ERROR",
          message:   body.error.errors.map((e) => e.message).join("; "),
          requestId,
          timestamp: new Date().toISOString(),
        });
      }

      try {
        const result = await markPaymentFailed(
          body.data.orderId,
          body.data.reason as FailureReason,
          body.data.detail,
        );

        const ws = (fastify as FastifyInstance & { wsServer?: { toOrder?: (id: string) => { emit?: (event: string, data: unknown) => void } } }).wsServer;
        ws?.toOrder?.(body.data.orderId)?.emit?.("order.expired", {
          event:     "order.expired",
          orderId:   body.data.orderId,
          expiredAt: new Date().toISOString(),
          message:   body.data.detail ?? "Order hết hạn.",
        });

        return reply.status(200).send(result);

      } catch (err) {
        if (err instanceof ServiceError) {
          return reply.status(err.statusCode).send({
            error: err.code, message: err.message,
            requestId, timestamp: new Date().toISOString(),
          });
        }
        throw err;
      }
    },
  );

  // ── POST /v1/internal/oracle/release-submitted ────────────────────────────
  fastify.post(
    "/v1/internal/oracle/release-submitted",
    { preHandler: [requireOracleAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = newRequestId();
      reply.header("X-Request-ID", requestId);

      const body = releaseSubmittedBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "VALIDATION_ERROR",
          message: body.error.errors.map((e) => e.message).join("; "),
          requestId, timestamp: new Date().toISOString(),
        });
      }

      try {
        await markReleaseSubmitted(
          body.data.orderId,
          body.data.txHash,
          body.data.txCbor,
          body.data.triggerMode,
        );

        const ws = (fastify as FastifyInstance & { wsServer?: { toOrder?: (id: string) => { emit?: (event: string, data: unknown) => void } } }).wsServer;
        ws?.toOrder?.(body.data.orderId)?.emit?.("order.release_submitted", {
          event:                    "order.release_submitted",
          orderId:                  body.data.orderId,
          txHash:                   body.data.txHash,
          submittedAt:              new Date().toISOString(),
          estimatedConfirmSeconds:  90,
        });

        return reply.status(200).send({
          orderId: body.data.orderId,
          status:  "RELEASE_PENDING",
          txHash:  body.data.txHash,
          message: "Release tx đã submit lên Cardano.",
        });

      } catch (err) {
        if (err instanceof ServiceError) {
          return reply.status(err.statusCode).send({
            error: err.code, message: err.message,
            requestId, timestamp: new Date().toISOString(),
          });
        }
        throw err;
      }
    },
  );

  // ── POST /v1/internal/oracle/order-completed ──────────────────────────────
  fastify.post(
    "/v1/internal/oracle/order-completed",
    { preHandler: [requireOracleAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = newRequestId();
      reply.header("X-Request-ID", requestId);

      const body = orderCompletedBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "VALIDATION_ERROR",
          message: body.error.errors.map((e) => e.message).join("; "),
          requestId, timestamp: new Date().toISOString(),
        });
      }

      try {
        await markOrderCompleted(
          body.data.orderId,
          body.data.txHash,
          body.data.blockHeight,
          body.data.blockTime,
        );

        const { prisma } = await import("../lib/prisma.js");
        const order = await prisma.order.findUnique({
          where: { id: body.data.orderId },
          select: { tokenAmount: true, tokenSymbol: true },
        });

        const ws = (fastify as FastifyInstance & { wsServer?: { toOrder?: (id: string) => { emit?: (event: string, data: unknown) => void } } }).wsServer;
        ws?.toOrder?.(body.data.orderId)?.emit?.("order.completed", {
          event:       "order.completed",
          orderId:     body.data.orderId,
          txHash:      body.data.txHash,
          tokenAmount: order ? Number(order.tokenAmount) : 0,
          tokenSymbol: order?.tokenSymbol ?? "LAMP",
          blockHeight: body.data.blockHeight,
          completedAt: new Date().toISOString(),
        });

        return reply.status(200).send({
          orderId: body.data.orderId,
          status:  "COMPLETED",
          txHash:  body.data.txHash,
          message: "Order hoàn tất.",
        });

      } catch (err) {
        if (err instanceof ServiceError) {
          return reply.status(err.statusCode).send({
            error: err.code, message: err.message,
            requestId, timestamp: new Date().toISOString(),
          });
        }
        throw err;
      }
    },
  );
}
