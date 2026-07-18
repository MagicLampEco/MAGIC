/**
 * Order routes
 *
 * Public:
 *   POST /v1/orders              — create order (with Redis rate lock + VietQR)
 *   GET  /v1/orders/:id          — order status
 *   POST /v1/orders/:id/submit   — buyer submits oracle signature (Option B)
 *   GET  /v1/orders/:id/receipt  — final receipt after COMPLETED
 *   GET  /v1/orders/:id/qr.png   — QR image stream
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import QRCode from "qrcode";
import { prisma } from "../lib/prisma.js";
import { ServiceError } from "../lib/errors.js";
import { newRequestId } from "../lib/requestId.js";
import { idempotencyMiddleware, cacheIdempotencyResponse } from "../middleware/idempotency.js";
import { checkOrderCreationRateLimit } from "../middleware/auth.js";
import {
  createOrder,
  getOrderFull,
  submitOracleSignature,
} from "../services/order.service.js";
import { buildPaymentQR, buildVietQRString, BANKS } from "../services/vietqr.service.js";

// ─── Zod schemas ───────────────────────────────────────────────────────────────

const createOrderBody = z.object({
  offerId:            z.string().min(1),
  tokenAmount:        z.number().int().positive(),
  buyerWalletAddress: z.string().min(10),
});

const submitSignatureBody = z.object({
  oracleSignature: z.object({
    cbor:          z.string().min(4),
    vkeyWitness:   z.string().optional(),
    paymentTxRef:  z.string().optional(),
  }),
});

// ─── Route registration ────────────────────────────────────────────────────────

export async function ordersRoutes(fastify: FastifyInstance): Promise<void> {
  // ── POST /v1/orders ───────────────────────────────────────────────────────
  fastify.post(
    "/v1/orders",
    { preHandler: [idempotencyMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = newRequestId();
      reply.header("X-Request-ID", requestId);

      // Rate limit check
      const ip = request.ip ?? "unknown";
      try {
        const body = createOrderBody.safeParse(request.body);
        if (!body.success) {
          return reply.status(400).send({
            error:     "VALIDATION_ERROR",
            message:   body.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "),
            requestId,
            timestamp: new Date().toISOString(),
          });
        }

        await checkOrderCreationRateLimit(ip, body.data.buyerWalletAddress);

        const idempotencyKey = (request as FastifyRequest & { _idempotencyKey?: string })._idempotencyKey;

        const result = await createOrder({
          offerId:            body.data.offerId,
          tokenAmount:        body.data.tokenAmount,
          buyerWalletAddress: body.data.buyerWalletAddress,
          idempotencyKey,
        });

        await cacheIdempotencyResponse(request, 201, result);
        return reply.status(201).send(result);

      } catch (err) {
        if (err instanceof ServiceError) {
          reply.header("X-Request-ID", requestId);
          return reply.status(err.statusCode).send({
            error:     err.code,
            message:   err.message,
            details:   err.details,
            requestId,
            timestamp: new Date().toISOString(),
          });
        }
        const e = err as { code?: string; statusCode?: number; message?: string; retryAfter?: number };
        if (e.code === "RATE_LIMITED") {
          if (e.retryAfter) reply.header("Retry-After", String(e.retryAfter));
          return reply.status(429).send({
            error:     "RATE_LIMITED",
            message:   e.message ?? "Quá giới hạn gọi API.",
            requestId,
            timestamp: new Date().toISOString(),
          });
        }
        throw err;
      }
    },
  );

  // ── GET /v1/orders/:id ────────────────────────────────────────────────────
  fastify.get("/v1/orders/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const requestId = newRequestId();
    reply.header("X-Request-ID", requestId);

    const order = await getOrderFull(request.params.id);
    if (!order) {
      return reply.status(404).send({
        error:     "ORDER_NOT_FOUND",
        message:   "Order không tồn tại.",
        requestId,
        timestamp: new Date().toISOString(),
      });
    }

    // Rebuild QR (from cache in production, here rebuilt on demand)
    let paymentBlock: unknown = null;
    if (order.payment) {
      const qrPayload = await buildPaymentQR({
        orderId:       order.id,
        bankCode:      order.payment.bankCode,
        accountNumber: order.payment.accountNumber,
        amount:        Number(order.payment.expectedAmount),
        referenceCode: order.payment.referenceCode,
        accountName:   order.offer.enterprise.accountName,
        tokenSymbol:   order.tokenSymbol,
      });
      paymentBlock = {
        bankCode:      order.payment.bankCode,
        bankName:      order.offer.enterprise.displayName,
        accountNumber: order.payment.accountNumber,
        accountName:   order.offer.enterprise.accountName,
        amount:        Number(order.payment.expectedAmount),
        referenceCode: order.payment.referenceCode,
        description:   `Chuyen khoan mua ${order.tokenSymbol} - ${order.payment.referenceCode}`,
        vietQrData: {
          qrString:   qrPayload.qrString,
          qrImageUrl: qrPayload.qrImageUrl,
          qrBase64:   qrPayload.qrBase64,
          deeplinks:  qrPayload.deeplinks,
        },
      };
    }

    const response: Record<string, unknown> = {
      orderId:            order.id,
      status:             order.status,
      tokenAmount:        Number(order.tokenAmount),
      totalVND:           Number(order.totalVND),
      buyerWalletAddress: order.buyerWalletAddress,
      payment:            paymentBlock,
      timeline:           (order.timeline ?? []).map((t) => ({
        status: t.status,
        at:     t.at.toISOString(),
        actor:  t.actor,
        note:   t.note ?? undefined,
      })),
      expiresAt: order.expiresAt.toISOString(),
      createdAt: order.createdAt.toISOString(),
    };

    // Add oracle signature instructions when RELEASE_PENDING
    if (order.status === "RELEASE_PENDING") {
      response["oracleSignature"] = {
        required:     true,
        submitted:    !!order.payment?.oracleCbor,
        instructions: "Tải xuống chữ ký oracle từ VeData và gọi POST /v1/orders/:id/submit",
      };
    }

    return reply.status(200).send(response);
  });

  // ── POST /v1/orders/:id/submit ────────────────────────────────────────────
  fastify.post("/v1/orders/:id/submit", async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply:   FastifyReply,
  ) => {
    const requestId = newRequestId();
    reply.header("X-Request-ID", requestId);

    const body = submitSignatureBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error:     "VALIDATION_ERROR",
        message:   body.error.errors.map((e) => e.message).join("; "),
        requestId,
        timestamp: new Date().toISOString(),
      });
    }

    try {
      const result = await submitOracleSignature(
        request.params.id,
        body.data.oracleSignature.cbor,
        body.data.oracleSignature.vkeyWitness,
        body.data.oracleSignature.paymentTxRef,
      );

      return reply.status(200).send({
        orderId:                    request.params.id,
        status:                     result.status,
        message:                    "Chữ ký oracle đã nhận. Giao dịch on-chain đang xử lý.",
        estimatedCompletionSeconds: result.estimatedCompletionSeconds,
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
  });

  // ── GET /v1/orders/:id/receipt ────────────────────────────────────────────
  fastify.get("/v1/orders/:id/receipt", async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply:   FastifyReply,
  ) => {
    const requestId = newRequestId();
    reply.header("X-Request-ID", requestId);

    const order = await getOrderFull(request.params.id);
    if (!order) {
      return reply.status(404).send({
        error:     "ORDER_NOT_FOUND",
        message:   "Order không tồn tại.",
        requestId,
        timestamp: new Date().toISOString(),
      });
    }

    if (order.status !== "COMPLETED") {
      return reply.status(409).send({
        error:   "RECEIPT_NOT_AVAILABLE",
        status:  order.status,
        message: "Biên lai chưa khả dụng — order chưa hoàn tất.",
        requestId,
        timestamp: new Date().toISOString(),
      });
    }

    return reply.status(200).send({
      orderId:            order.id,
      status:             "COMPLETED",
      tokenSymbol:        order.tokenSymbol,
      tokenAmount:        Number(order.tokenAmount),
      policyId:           order.offer.policyId,
      assetName:          order.offer.assetName,
      buyerWalletAddress: order.buyerWalletAddress,
      txHash:             order.txHash,
      blockHeight:        order.blockHeight,
      blockTime:          order.blockTime?.toISOString() ?? null,
      totalVND:           Number(order.totalVND),
      completedAt:        order.completedAt?.toISOString() ?? null,
    });
  });

  // ── GET /v1/orders/:id/qr.png ─────────────────────────────────────────────
  fastify.get("/v1/orders/:id/qr.png", async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply:   FastifyReply,
  ) => {
    const order = await prisma.order.findUnique({
      where: { id: request.params.id },
      include: { payment: true, offer: { include: { enterprise: true } } },
    });

    if (!order || !order.payment) {
      return reply.status(404).send({ error: "ORDER_NOT_FOUND" });
    }

    const bank = BANKS[order.offer.enterprise.bankCode];
    const qrString = buildVietQRString({
      bankBin:       bank?.napasbin ?? "000000",
      accountNumber: order.offer.enterprise.accountNumber,
      amount:        Number(order.payment.expectedAmount),
      referenceCode: order.payment.referenceCode,
      description:   `Mua ${order.tokenSymbol} ${order.payment.referenceCode}`.slice(0, 25),
      merchantName:  order.offer.enterprise.accountName.slice(0, 25),
    });

    const pngBuffer = await QRCode.toBuffer(qrString, {
      errorCorrectionLevel: "M",
      type: "png",
      width: 400,
      margin: 2,
    });

    reply.header("Content-Type", "image/png");
    reply.header("Cache-Control", "public, max-age=300");
    return reply.status(200).send(pngBuffer);
  });
}
