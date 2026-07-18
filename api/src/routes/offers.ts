/**
 * Offer routes
 *
 * Public:
 *   GET  /v1/offers          — list active offers
 *   GET  /v1/offers/:id      — single offer detail
 *
 * Enterprise (X-API-Key):
 *   POST   /v1/enterprise/offers      — create offer
 *   DELETE /v1/enterprise/offers/:id  — cancel offer
 *   GET    /v1/enterprise/orders      — list enterprise orders
 *   GET    /v1/enterprise/analytics   — revenue analytics
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireEnterpriseAuth } from "../middleware/auth.js";
import { generateOfferId } from "../lib/ids.js";
import { newRequestId } from "../lib/requestId.js";
import { cacheIdempotencyResponse, idempotencyMiddleware } from "../middleware/idempotency.js";

// Helper type for requests that carry the enterprise identity set by requireEnterpriseAuth
type EntReq = FastifyRequest & { enterprise: { enterpriseId: string; displayName: string } };

// ─── Zod schemas ───────────────────────────────────────────────────────────────

const listOffersQuery = z.object({
  tokenSymbol: z.enum(["LAMP", "MAGIC"]).optional(),
  minAmount:   z.coerce.number().int().positive().optional(),
  page:        z.coerce.number().int().min(1).default(1),
  pageSize:    z.coerce.number().int().min(1).max(100).default(20),
});

const createOfferBody = z.object({
  tokenSymbol:    z.enum(["LAMP", "MAGIC"]),
  policyId:       z.string().regex(/^[a-f0-9]{56}$/, "policyId phải là 56 ký tự hex"),
  assetName:      z.string().min(1),
  totalAmount:    z.number().int().positive(),
  priceVND:       z.number().int().positive(),
  minOrderAmount: z.number().int().positive().default(1000),
  maxOrderAmount: z.number().int().positive(),
  onchainEscrowUtxo: z.object({
    txHash:      z.string().regex(/^[a-f0-9]{64}$/),
    outputIndex: z.number().int().min(0),
  }),
  expiresAt:   z.string().datetime(),
  receiveBank: z.object({
    bankCode:       z.string().min(2).max(10),
    accountNumber:  z.string().min(6).max(30),
    accountName:    z.string().min(2).max(100),
  }).optional(),
});

const enterpriseOrdersQuery = z.object({
  status:   z.string().optional(),
  from:     z.string().optional(),
  to:       z.string().optional(),
  page:     z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const analyticsQuery = z.object({
  from:        z.string().optional(),
  to:          z.string().optional(),
  granularity: z.enum(["day", "week", "month"]).default("day"),
});

// ─── Route registration ────────────────────────────────────────────────────────

export async function offersRoutes(fastify: FastifyInstance): Promise<void> {
  // ── GET /v1/offers ────────────────────────────────────────────────────────
  fastify.get("/v1/offers", async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = newRequestId();
    reply.header("X-Request-ID", requestId);

    const query = listOffersQuery.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({
        error:     "VALIDATION_ERROR",
        message:   query.error.errors.map((e) => e.message).join("; "),
        requestId,
        timestamp: new Date().toISOString(),
      });
    }
    const { tokenSymbol, minAmount, page, pageSize } = query.data;
    const skip = (page - 1) * pageSize;

    const where: Prisma.OfferWhereInput = {
      status:    "ACTIVE",
      expiresAt: { gt: new Date() },
      ...(tokenSymbol ? { tokenSymbol } : {}),
      ...(minAmount   ? { availableAmount: { gte: BigInt(minAmount) } } : {}),
    };

    const [offers, total] = await Promise.all([
      prisma.offer.findMany({
        where,
        skip,
        take:    pageSize,
        orderBy: { createdAt: "desc" },
        include: { enterprise: true },
      }),
      prisma.offer.count({ where }),
    ]);

    return reply.status(200).send({
      data: offers.map((o) => ({
        offerId:         o.id,
        tokenSymbol:     o.tokenSymbol,
        priceVND:        Number(o.priceVND),
        availableAmount: Number(o.availableAmount),
        minOrderAmount:  Number(o.minOrderAmount),
        maxOrderAmount:  Number(o.maxOrderAmount),
        enterprise: {
          enterpriseId: o.enterprise.id,
          displayName:  o.enterprise.displayName,
          verifiedAt:   o.enterprise.verifiedAt?.toISOString() ?? null,
        },
        expiresAt: o.expiresAt.toISOString(),
        createdAt: o.createdAt.toISOString(),
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  });

  // ── GET /v1/offers/:id ────────────────────────────────────────────────────
  fastify.get(
    "/v1/offers/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const requestId = newRequestId();
      reply.header("X-Request-ID", requestId);

      const offer = await prisma.offer.findUnique({
        where:   { id: request.params.id },
        include: { enterprise: true },
      });

      if (!offer || offer.status === "CANCELLED") {
        return reply.status(404).send({
          error:     "OFFER_NOT_FOUND",
          message:   "Offer không tồn tại hoặc đã hết hạn.",
          requestId,
          timestamp: new Date().toISOString(),
        });
      }

      const completedOrders = await prisma.order.count({
        where: { offerId: offer.id, status: "COMPLETED" },
      });

      return reply.status(200).send({
        offerId:         offer.id,
        tokenSymbol:     offer.tokenSymbol,
        policyId:        offer.policyId,
        assetName:       offer.assetName,
        priceVND:        Number(offer.priceVND),
        availableAmount: Number(offer.availableAmount),
        lockedAmount:    Number(offer.lockedAmount),
        minOrderAmount:  Number(offer.minOrderAmount),
        maxOrderAmount:  Number(offer.maxOrderAmount),
        enterprise: {
          enterpriseId:      offer.enterprise.id,
          displayName:       offer.enterprise.displayName,
          verifiedAt:        offer.enterprise.verifiedAt?.toISOString() ?? null,
          completedOrders,
          avgReleaseMinutes: null,
        },
        onchainEscrowUtxo: {
          txHash:        offer.escrowTxHash,
          outputIndex:   offer.escrowTxIndex,
          scriptAddress: offer.escrowAddress ?? null,
        },
        status:    offer.status,
        expiresAt: offer.expiresAt.toISOString(),
        createdAt: offer.createdAt.toISOString(),
      });
    },
  );

  // ── POST /v1/enterprise/offers ─────────────────────────────────────────────
  fastify.post(
    "/v1/enterprise/offers",
    { preHandler: [idempotencyMiddleware, requireEnterpriseAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = newRequestId();
      reply.header("X-Request-ID", requestId);

      const entReq       = request as EntReq;
      const enterpriseId = entReq.enterprise.enterpriseId;

      const body = createOfferBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error:     "VALIDATION_ERROR",
          message:   body.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "),
          requestId,
          timestamp: new Date().toISOString(),
        });
      }

      const d = body.data;

      // Update enterprise bank details if provided
      if (d.receiveBank) {
        const bankInfo = d.receiveBank;
        await prisma.enterprise.update({
          where: { id: enterpriseId },
          data: {
            bankCode:      bankInfo.bankCode,
            accountNumber: bankInfo.accountNumber,
            accountName:   bankInfo.accountName,
          },
        });
      }

      const offerId           = generateOfferId();
      const verificationJobId = `job_${offerId.slice(6)}`;

      const offer = await prisma.offer.create({
        data: {
          id:              offerId,
          enterpriseId,
          tokenSymbol:     d.tokenSymbol,
          policyId:        d.policyId,
          assetName:       d.assetName,
          totalAmount:     BigInt(d.totalAmount),
          availableAmount: BigInt(d.totalAmount),
          priceVND:        BigInt(d.priceVND),
          minOrderAmount:  BigInt(d.minOrderAmount),
          maxOrderAmount:  BigInt(d.maxOrderAmount),
          escrowTxHash:    d.onchainEscrowUtxo.txHash,
          escrowTxIndex:   d.onchainEscrowUtxo.outputIndex,
          status:          "PENDING_VERIFICATION",
          verificationJobId,
          expiresAt:       new Date(d.expiresAt),
        },
      });

      const responseBody = {
        offerId:           offer.id,
        status:            "PENDING_VERIFICATION",
        message:           "Đang xác minh UTXO on-chain. Offer sẽ ACTIVE sau ~60 giây.",
        verificationJobId,
      };

      await cacheIdempotencyResponse(request, 201, responseBody);
      return reply.status(201).send(responseBody);
    },
  );

  // ── DELETE /v1/enterprise/offers/:id ──────────────────────────────────────
  fastify.route({
    method:     "DELETE",
    url:        "/v1/enterprise/offers/:id",
    preHandler: [requireEnterpriseAuth],
    handler:    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const requestId    = newRequestId();
      reply.header("X-Request-ID", requestId);
      const enterpriseId = (request as EntReq).enterprise.enterpriseId;

      const offer = await prisma.offer.findUnique({
        where: { id: request.params.id },
      });

      if (!offer || offer.enterpriseId !== enterpriseId) {
        return reply.status(404).send({
          error: "OFFER_NOT_FOUND", message: "Offer không tồn tại.",
          requestId, timestamp: new Date().toISOString(),
        });
      }

      const pendingCount = await prisma.order.count({
        where: { offerId: offer.id, status: { in: ["AWAITING_PAYMENT", "CREATED"] } },
      });
      if (pendingCount > 0) {
        return reply.status(409).send({
          error:        "HAS_PENDING_ORDERS",
          pendingCount,
          message:      `Còn ${pendingCount} order đang AWAITING_PAYMENT. Chờ hết hạn hoặc huỷ từng order.`,
          requestId,
          timestamp:    new Date().toISOString(),
        });
      }

      const now = new Date();
      await prisma.offer.update({
        where: { id: offer.id },
        data:  { status: "CANCELLED", cancelledAt: now },
      });

      return reply.status(200).send({
        offerId:        offer.id,
        status:         "CANCELLED",
        cancelledAt:    now.toISOString(),
        releasedAmount: Number(offer.availableAmount),
        note:           "Token sẽ được trả về địa chỉ enterprise sau khi submit redeem tx.",
      });
    },
  });

  // ── GET /v1/enterprise/orders ──────────────────────────────────────────────
  fastify.get(
    "/v1/enterprise/orders",
    { preHandler: [requireEnterpriseAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId    = newRequestId();
      reply.header("X-Request-ID", requestId);
      const enterpriseId = (request as EntReq).enterprise.enterpriseId;

      const query = enterpriseOrdersQuery.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({
          error:     "VALIDATION_ERROR",
          message:   query.error.errors.map((e) => e.message).join("; "),
          requestId,
          timestamp: new Date().toISOString(),
        });
      }

      const { status, from, to, page, pageSize } = query.data;
      const skip = (page - 1) * pageSize;

      const where: Prisma.OrderWhereInput = {
        enterpriseId,
        ...(status ? { status: status as Prisma.EnumOrderStatusFilter } : {}),
        ...(from || to ? {
          createdAt: {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to   ? { lte: new Date(to) }   : {}),
          },
        } : {}),
      };

      const [orders, total] = await Promise.all([
        prisma.order.findMany({ where, skip, take: pageSize, orderBy: { createdAt: "desc" } }),
        prisma.order.count({ where }),
      ]);

      return reply.status(200).send({
        data: orders.map((o) => ({
          orderId:            o.id,
          offerId:            o.offerId,
          tokenSymbol:        o.tokenSymbol,
          tokenAmount:        Number(o.tokenAmount),
          totalVND:           Number(o.totalVND),
          status:             o.status,
          buyerWalletAddress: o.buyerWalletAddress,
          txHash:             o.txHash ?? null,
          createdAt:          o.createdAt.toISOString(),
          completedAt:        o.completedAt?.toISOString() ?? null,
        })),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      });
    },
  );

  // ── GET /v1/enterprise/analytics ──────────────────────────────────────────
  fastify.get(
    "/v1/enterprise/analytics",
    { preHandler: [requireEnterpriseAuth] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId    = newRequestId();
      reply.header("X-Request-ID", requestId);
      const enterpriseId = (request as EntReq).enterprise.enterpriseId;

      const query = analyticsQuery.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({
          error:     "VALIDATION_ERROR",
          message:   query.error.errors.map((e) => e.message).join("; "),
          requestId,
          timestamp: new Date().toISOString(),
        });
      }

      const { from, to, granularity } = query.data;

      const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const toDate   = to   ? new Date(to)   : new Date();

      const orders = await prisma.order.findMany({
        where: {
          enterpriseId,
          createdAt: { gte: fromDate, lte: toDate },
        },
        select: {
          id: true, status: true, tokenAmount: true, totalVND: true,
          tokenSymbol: true, createdAt: true, completedAt: true,
        },
      });

      const totalOrders    = orders.length;
      const completed      = orders.filter((o) => o.status === "COMPLETED");
      const expired        = orders.filter((o) => o.status === "EXPIRED");
      const cancelled      = orders.filter((o) => o.status === "CANCELLED");
      const totalTokensSold = completed.reduce((s, o) => s + Number(o.tokenAmount), 0);
      const totalRevenue   = completed.reduce((s, o) => s + Number(o.totalVND), 0);

      const buckets = new Map<string, { orders: number; tokensSold: number; revenueVND: number }>();

      for (const o of orders) {
        let key: string;
        const d = o.createdAt;
        if (granularity === "day") {
          key = d.toISOString().slice(0, 10);
        } else if (granularity === "week") {
          const monday = new Date(d);
          monday.setDate(d.getDate() - d.getDay() + 1);
          key = monday.toISOString().slice(0, 10);
        } else {
          key = d.toISOString().slice(0, 7);
        }

        const b = buckets.get(key) ?? { orders: 0, tokensSold: 0, revenueVND: 0 };
        b.orders++;
        if (o.status === "COMPLETED") {
          b.tokensSold += Number(o.tokenAmount);
          b.revenueVND += Number(o.totalVND);
        }
        buckets.set(key, b);
      }

      const series = Array.from(buckets.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({ date, ...v }));

      return reply.status(200).send({
        summary: {
          period:              { from: fromDate.toISOString().slice(0, 10), to: toDate.toISOString().slice(0, 10) },
          totalOrders,
          completedOrders:     completed.length,
          expiredOrders:       expired.length,
          cancelledOrders:     cancelled.length,
          conversionRate:      totalOrders > 0 ? Number((completed.length / totalOrders).toFixed(3)) : 0,
          totalTokensSold,
          totalRevenueVND:     totalRevenue,
          avgOrderTokenAmount: completed.length > 0 ? Math.round(totalTokensSold / completed.length) : 0,
          avgReleaseMinutes:   null,
          tokenSymbol:         "LAMP",
        },
        series,
      });
    },
  );
}
