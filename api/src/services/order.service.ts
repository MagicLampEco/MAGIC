/**
 * Order service — business logic for order lifecycle.
 *
 * Covers:
 * - createOrder (distributed Redis lock, idempotency, VietQR)
 * - expireOrders (cron)
 * - markPaymentDetected (oracle callback)
 * - markPaymentFailed (oracle callback)
 * - markReleaseSubmitted
 * - markOrderCompleted (chain indexer callback)
 * - getOrderWithOffer
 */
import type { Order, Offer, OrderStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { getRedis } from "../lib/redis.js";
import { config } from "../lib/config.js";
import { ServiceError } from "../lib/errors.js";
import { generateOrderId, generateReferenceCode } from "../lib/ids.js";
import { isValidCardanoAddress } from "../lib/cardano.js";
import { buildPaymentQR, type QRPayload } from "./vietqr.service.js";

const redis = () => getRedis();

const LOCK_TTL_MS   = config.order.lockTtlMs;
const ORDER_TTL_SEC = config.order.ttlSeconds;

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
export interface CreateOrderDto {
  offerId:            string;
  tokenAmount:        number;
  buyerWalletAddress: string;
  idempotencyKey?:    string;
}

export interface OrderCreatedResult {
  orderId:     string;
  status:      OrderStatus;
  offer: {
    offerId:     string;
    tokenSymbol: string;
    priceVND:    number;
  };
  tokenAmount:        number;
  totalVND:           number;
  buyerWalletAddress: string;
  payment: {
    bankCode:      string;
    bankName:      string;
    accountNumber: string;
    accountName:   string;
    amount:        number;
    referenceCode: string;
    description:   string;
    vietQrData:    {
      qrString:   string;
      qrImageUrl: string;
      qrBase64:   string;
      deeplinks:  Record<string, string>;
    };
  };
  expiresAt:  string;
  createdAt:  string;
}

// ─────────────────────────────────────────────
// Redis-distributed lock helpers
// ─────────────────────────────────────────────
async function acquireLock(key: string, token: string): Promise<boolean> {
  const result = await redis().set(key, token, "PX", LOCK_TTL_MS, "NX");
  return result === "OK";
}

async function releaseLock(key: string, token: string): Promise<void> {
  const current = await redis().get(key);
  if (current === token) await redis().del(key);
}

// ─────────────────────────────────────────────
// createOrder
// ─────────────────────────────────────────────
export async function createOrder(dto: CreateOrderDto): Promise<OrderCreatedResult> {
  // 1. Validate wallet address
  if (!isValidCardanoAddress(dto.buyerWalletAddress)) {
    throw new ServiceError(
      "INVALID_WALLET",
      400,
      "Địa chỉ Cardano không hợp lệ.",
    );
  }

  // 2. Idempotency: check for existing result before acquiring lock
  if (dto.idempotencyKey) {
    const inFlight = await redis().get(`idempotency:inflight:${dto.idempotencyKey}`);
    if (inFlight) {
      throw new ServiceError("IDEMPOTENCY_IN_FLIGHT", 409, "Request với key này đang xử lý.");
    }
    const existingId = await redis().get(`idempotency:${dto.idempotencyKey}`);
    if (existingId) {
      const existing = await prisma.order.findUnique({
        where: { id: existingId },
        include: { offer: { include: { enterprise: true } } },
      });
      if (existing) {
        return buildOrderCreatedResult(existing);
      }
    }
    // Mark in-flight
    await redis().set(`idempotency:inflight:${dto.idempotencyKey}`, "1", "EX", 30);
  }

  const lockKey   = `offer:${dto.offerId}:lock`;
  const lockToken = Math.random().toString(36).slice(2) + Date.now();

  let acquired = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    acquired = await acquireLock(lockKey, lockToken);
    if (acquired) break;
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  if (!acquired) {
    if (dto.idempotencyKey) await redis().del(`idempotency:inflight:${dto.idempotencyKey}`);
    throw new ServiceError("LOCK_UNAVAILABLE", 503, "Redis lock timeout, thử lại sau.");
  }

  try {
    // 3. Load offer
    const offer = await prisma.offer.findUnique({
      where: { id: dto.offerId },
      include: { enterprise: true },
    });
    if (!offer || offer.status !== "ACTIVE") {
      throw new ServiceError("OFFER_NOT_FOUND", 404, "Offer không tồn tại hoặc đã hết hạn.");
    }
    if (new Date(offer.expiresAt) < new Date()) {
      throw new ServiceError("OFFER_EXPIRED", 409, "Offer đã hết hạn.");
    }

    // 4. Validate token amount
    const tokenAmountBig = BigInt(dto.tokenAmount);
    if (tokenAmountBig < offer.minOrderAmount || tokenAmountBig > offer.maxOrderAmount) {
      throw new ServiceError(
        "INVALID_AMOUNT",
        400,
        `tokenAmount phải nằm trong khoảng ${offer.minOrderAmount}–${offer.maxOrderAmount}.`,
        { min: Number(offer.minOrderAmount), max: Number(offer.maxOrderAmount) },
      );
    }
    if (offer.availableAmount < tokenAmountBig) {
      throw new ServiceError(
        "OFFER_INSUFFICIENT",
        409,
        `Không đủ token khả dụng. Còn lại ${offer.availableAmount} ${offer.tokenSymbol}, yêu cầu ${dto.tokenAmount}.`,
        { available: Number(offer.availableAmount), requested: dto.tokenAmount },
      );
    }

    // 5. Generate IDs
    const orderId       = generateOrderId();
    const referenceCode = generateReferenceCode(offer.tokenSymbol, tokenAmountBig, orderId);
    const totalVND      = Number(offer.priceVND) * dto.tokenAmount;
    const expiresAt     = new Date(Date.now() + ORDER_TTL_SEC * 1000);

    // 6. Create order + decrement available (transactional)
    const order = await prisma.$transaction(async (trx) => {
      await trx.offer.update({
        where: { id: dto.offerId },
        data: {
          availableAmount: { decrement: tokenAmountBig },
          lockedAmount:    { increment: tokenAmountBig },
        },
      });

      const newOrder = await trx.order.create({
        data: {
          id:                 orderId,
          offerId:            dto.offerId,
          enterpriseId:       offer.enterpriseId,
          tokenSymbol:        offer.tokenSymbol,
          tokenAmount:        tokenAmountBig,
          priceVNDSnapshot:   offer.priceVND,
          totalVND:           BigInt(totalVND),
          buyerWalletAddress: dto.buyerWalletAddress,
          referenceCode,
          status:             "AWAITING_PAYMENT",
          idempotencyKey:     dto.idempotencyKey ?? null,
          expiresAt,
        },
        include: { offer: { include: { enterprise: true } } },
      });

      await trx.orderTimeline.create({
        data: {
          orderId: orderId,
          status:  "AWAITING_PAYMENT",
          actor:   "BACKEND",
          note:    "Order tạo thành công, chờ thanh toán.",
        },
      });

      await trx.payment.create({
        data: {
          orderId:        orderId,
          referenceCode,
          bankCode:       offer.enterprise.bankCode,
          accountNumber:  offer.enterprise.accountNumber,
          expectedAmount: BigInt(totalVND),
          status:         "PENDING",
        },
      });

      return newOrder;
    });

    // 7. Set Redis TTL for expiry worker
    await redis().set(`order:lock:${orderId}`, "1", "EX", ORDER_TTL_SEC);

    // 8. Store idempotency mapping
    if (dto.idempotencyKey) {
      await redis().set(`idempotency:${dto.idempotencyKey}`, orderId, "EX", 86_400);
    }

    // 9. Build VietQR
    const qrPayload = await buildPaymentQR({
      orderId,
      bankCode:      offer.enterprise.bankCode,
      accountNumber: offer.enterprise.accountNumber,
      accountName:   offer.enterprise.accountName,
      amount:        totalVND,
      referenceCode,
      tokenSymbol:   offer.tokenSymbol,
    });

    return buildOrderCreatedResultFromRaw(order, offer, qrPayload);
  } finally {
    await releaseLock(lockKey, lockToken);
    if (dto.idempotencyKey) {
      await redis().del(`idempotency:inflight:${dto.idempotencyKey}`);
    }
  }
}

// ─────────────────────────────────────────────
// Expire orders — called by cron every minute
// ─────────────────────────────────────────────
export async function expireOrders(): Promise<number> {
  const now = new Date();

  const expirables = await prisma.order.findMany({
    where: {
      status:    { in: ["CREATED", "AWAITING_PAYMENT"] },
      expiresAt: { lte: now },
    },
    select: { id: true, offerId: true, tokenAmount: true },
  });

  if (expirables.length === 0) return 0;

  for (const order of expirables) {
    await prisma.$transaction([
      prisma.order.update({
        where: { id: order.id },
        data:  { status: "EXPIRED" },
      }),
      prisma.orderTimeline.create({
        data: { orderId: order.id, status: "EXPIRED", actor: "BACKEND", note: "Order hết hạn tự động." },
      }),
      prisma.offer.update({
        where: { id: order.offerId },
        data:  {
          availableAmount: { increment: order.tokenAmount },
          lockedAmount:    { decrement: order.tokenAmount },
        },
      }),
      prisma.payment.updateMany({
        where: { orderId: order.id, status: "PENDING" },
        data:  { status: "EXPIRED" },
      }),
    ]);
  }

  return expirables.length;
}

// ─────────────────────────────────────────────
// Oracle: payment confirmed
// ─────────────────────────────────────────────
export interface PaymentConfirmedDto {
  orderId:           string;
  bankTransactionId: string;
  bankCode:          string;
  fromAccount:       string;
  toAccount:         string;
  amount:            number;
  referenceCode:     string;
  transactionTime:   string;
  napasRef?:         string;
  oracleCbor?:       string;
  oracleDatumHash?:  string;
  oracleSignedAt?:   string;
}

export async function markPaymentDetected(dto: PaymentConfirmedDto): Promise<{
  previousStatus: OrderStatus;
  newStatus:      OrderStatus;
  releaseTrigger: string;
}> {
  const order = await prisma.order.findUnique({ where: { id: dto.orderId } });
  if (!order) throw new ServiceError("ORDER_NOT_FOUND", 404, "Order không tồn tại.");
  if (order.status !== "AWAITING_PAYMENT") {
    if (["PAYMENT_DETECTED", "RELEASE_PENDING", "COMPLETED"].includes(order.status)) {
      throw new ServiceError("ALREADY_PROCESSED", 409, "Order đã được xử lý.", { currentStatus: order.status });
    }
    throw new ServiceError("WRONG_STATUS", 409, `Order ở trạng thái ${order.status}, không thể xác nhận thanh toán.`);
  }

  const previousStatus = order.status;
  const detectedAmount = dto.amount;
  const expectedAmount = Number(order.totalVND);

  // Check amount mismatch
  if (detectedAmount !== expectedAmount) {
    await prisma.$transaction([
      prisma.order.update({ where: { id: dto.orderId }, data: { status: "DISPUTED" } }),
      prisma.orderTimeline.create({
        data: {
          orderId: dto.orderId, status: "DISPUTED", actor: "ORACLE",
          note: `Số tiền không khớp: nhận ${detectedAmount} VND, kỳ vọng ${expectedAmount} VND.`,
        },
      }),
      prisma.payment.updateMany({
        where: { orderId: dto.orderId },
        data:  { status: "AMOUNT_MISMATCH", detectedAmount: BigInt(detectedAmount), bankTransactionId: dto.bankTransactionId },
      }),
    ]);
    return { previousStatus, newStatus: "DISPUTED", releaseTrigger: "NONE" };
  }

  // Happy path
  await prisma.$transaction([
    prisma.order.update({ where: { id: dto.orderId }, data: { status: "PAYMENT_DETECTED" } }),
    prisma.orderTimeline.create({
      data: { orderId: dto.orderId, status: "PAYMENT_DETECTED", actor: "ORACLE", note: `Thanh toán xác nhận. Tx: ${dto.bankTransactionId}` },
    }),
    prisma.payment.updateMany({
      where: { orderId: dto.orderId },
      data: {
        status:           "CONFIRMED",
        detectedAmount:   BigInt(detectedAmount),
        bankTransactionId: dto.bankTransactionId,
        fromAccount:      dto.fromAccount,
        napasRef:         dto.napasRef ?? null,
        oracleCbor:       dto.oracleCbor ?? null,
        oracleDatumHash:  dto.oracleDatumHash ?? null,
        oracleSignedAt:   dto.oracleSignedAt ? new Date(dto.oracleSignedAt) : null,
        confirmedAt:      new Date(),
      },
    }),
  ]);

  return { previousStatus, newStatus: "PAYMENT_DETECTED", releaseTrigger: "AUTOMATIC" };
}

// ─────────────────────────────────────────────
// Oracle: payment failed
// ─────────────────────────────────────────────
export type FailureReason = "PAYMENT_EXPIRED" | "AMOUNT_MISMATCH" | "WRONG_REFERENCE" | "BANK_REJECTED";

export async function markPaymentFailed(
  orderId:  string,
  reason:   FailureReason,
  detail?:  string,
): Promise<{ newStatus: OrderStatus; tokenReleased: boolean; releasedToPool: number }> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ServiceError("ORDER_NOT_FOUND", 404, "Order không tồn tại.");

  const eligibleStatuses: OrderStatus[] = ["AWAITING_PAYMENT", "CREATED"];
  if (!eligibleStatuses.includes(order.status as OrderStatus)) {
    throw new ServiceError("WRONG_STATUS", 409, `Order ở trạng thái ${order.status}.`);
  }

  const tokenAmount = Number(order.tokenAmount);

  await prisma.$transaction([
    prisma.order.update({ where: { id: orderId }, data: { status: "EXPIRED" } }),
    prisma.orderTimeline.create({
      data: { orderId, status: "EXPIRED", actor: "ORACLE", note: `Thanh toán thất bại: ${reason}. ${detail ?? ""}` },
    }),
    prisma.offer.update({
      where: { id: order.offerId },
      data:  {
        availableAmount: { increment: order.tokenAmount },
        lockedAmount:    { decrement: order.tokenAmount },
      },
    }),
    prisma.payment.updateMany({
      where: { orderId },
      data:  { status: "EXPIRED" },
    }),
  ]);

  return { newStatus: "EXPIRED", tokenReleased: true, releasedToPool: tokenAmount };
}

// ─────────────────────────────────────────────
// Buyer submits oracle signature (Option B)
// ─────────────────────────────────────────────
export async function submitOracleSignature(
  orderId:        string,
  oracleCbor:     string,
  vkeyWitness?:   string,
  paymentTxRef?:  string,
): Promise<{ status: OrderStatus; estimatedCompletionSeconds: number }> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ServiceError("ORDER_NOT_FOUND", 404, "Order không tồn tại.");
  if (new Date() > order.expiresAt) {
    throw new ServiceError("ORDER_EXPIRED", 410, "Order đã hết hạn.");
  }
  if (order.status !== "RELEASE_PENDING" && order.status !== "PAYMENT_DETECTED") {
    throw new ServiceError("WRONG_STATUS", 409, `Order ở trạng thái ${order.status}, không thể submit signature.`);
  }

  // Basic CBOR validation: must be non-empty hex string
  if (!oracleCbor || !/^[0-9a-fA-F]+$/.test(oracleCbor)) {
    throw new ServiceError("INVALID_SIGNATURE", 400, "CBOR không hợp lệ.");
  }

  await prisma.$transaction([
    prisma.order.update({ where: { id: orderId }, data: { status: "RELEASE_PENDING" } }),
    prisma.orderTimeline.create({
      data: { orderId, status: "RELEASE_PENDING", actor: "BUYER", note: "Buyer gửi oracle signature." },
    }),
    prisma.payment.updateMany({
      where: { orderId },
      data:  { oracleCbor, status: "CONFIRMED" },
    }),
  ]);

  return { status: "RELEASE_PENDING", estimatedCompletionSeconds: 90 };
}

// ─────────────────────────────────────────────
// Mark release submitted on-chain
// ─────────────────────────────────────────────
export async function markReleaseSubmitted(
  orderId:    string,
  txHash:     string,
  txCbor?:    string,
  triggerMode: "AUTOMATIC" | "BUYER_SUBMITTED" | "ADMIN_MANUAL" = "AUTOMATIC",
): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ServiceError("ORDER_NOT_FOUND", 404, "Order không tồn tại.");

  await prisma.$transaction([
    prisma.order.update({ where: { id: orderId }, data: { status: "RELEASE_PENDING", txHash } }),
    prisma.orderTimeline.create({
      data: { orderId, status: "RELEASE_PENDING", actor: "BACKEND", note: `Tx on-chain: ${txHash}` },
    }),
    prisma.release.upsert({
      where:  { orderId },
      create: {
        orderId,
        tokenAmount:        order.tokenAmount,
        destinationAddress: order.buyerWalletAddress,
        triggerMode,
        submittedTxCbor:    txCbor ?? null,
        txHash,
        status:             "SUBMITTED",
      },
      update: { txHash, status: "SUBMITTED", submittedTxCbor: txCbor ?? null },
    }),
  ]);
}

// ─────────────────────────────────────────────
// Mark order completed (chain indexer callback)
// ─────────────────────────────────────────────
export async function markOrderCompleted(
  orderId:     string,
  txHash:      string,
  blockHeight: number,
  blockTime:   string,
): Promise<void> {
  const now = new Date();
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new ServiceError("ORDER_NOT_FOUND", 404, "Order không tồn tại.");

  await prisma.$transaction([
    prisma.order.update({
      where: { id: orderId },
      data: { status: "COMPLETED", txHash, blockHeight, blockTime: new Date(blockTime), completedAt: now },
    }),
    prisma.orderTimeline.create({
      data: { orderId, status: "COMPLETED", actor: "BACKEND", note: `Tx confirmed at block ${blockHeight}.` },
    }),
    prisma.offer.update({
      where: { id: order.offerId },
      data:  { lockedAmount: { decrement: order.tokenAmount } },
    }),
    prisma.release.updateMany({
      where: { orderId },
      data:  { status: "CONFIRMED", blockHeight, blockTime: new Date(blockTime), confirmedAt: now },
    }),
  ]);
}

// ─────────────────────────────────────────────
// Fetch order with all relations
// ─────────────────────────────────────────────
export async function getOrderFull(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: {
      offer:    { include: { enterprise: true } },
      timeline: { orderBy: { at: "asc" } },
      payment:  true,
      release:  true,
    },
  });
}

// ─────────────────────────────────────────────
// Internal helpers to build response shapes
// ─────────────────────────────────────────────
async function buildOrderCreatedResult(
  order: Order & { offer: Offer & { enterprise: { bankCode: string; bankBin: string; accountNumber: string; accountName: string; displayName: string } } },
): Promise<OrderCreatedResult> {
  const qrPayload = await buildPaymentQR({
    orderId:       order.id,
    bankCode:      order.offer.enterprise.bankCode,
    accountNumber: order.offer.enterprise.accountNumber,
    accountName:   order.offer.enterprise.accountName,
    amount:        Number(order.totalVND),
    referenceCode: order.referenceCode,
    tokenSymbol:   order.tokenSymbol,
  });
  return buildOrderCreatedResultFromRaw(order, order.offer, qrPayload);
}

function buildOrderCreatedResultFromRaw(
  order:   Order & { offer: Offer & { enterprise: { bankCode: string; bankBin: string; accountNumber: string; accountName: string; displayName: string } } },
  offer:   Offer & { enterprise: { bankCode: string; bankBin: string; accountNumber: string; accountName: string; displayName: string } },
  qrPayload: QRPayload,
): OrderCreatedResult {
  const totalVND = Number(order.totalVND);
  return {
    orderId:           order.id,
    status:            order.status as OrderStatus,
    offer: {
      offerId:     offer.id,
      tokenSymbol: offer.tokenSymbol,
      priceVND:    Number(offer.priceVND),
    },
    tokenAmount:        Number(order.tokenAmount),
    totalVND,
    buyerWalletAddress: order.buyerWalletAddress,
    payment: {
      bankCode:      offer.enterprise.bankCode,
      bankName:      offer.enterprise.displayName,
      accountNumber: offer.enterprise.accountNumber,
      accountName:   offer.enterprise.accountName,
      amount:        totalVND,
      referenceCode: order.referenceCode,
      description:   `Chuyen khoan mua ${offer.tokenSymbol} - ${order.referenceCode}`,
      vietQrData: {
        qrString:   qrPayload.qrString,
        qrImageUrl: qrPayload.qrImageUrl,
        qrBase64:   qrPayload.qrBase64,
        deeplinks:  qrPayload.deeplinks,
      },
    },
    expiresAt: order.expiresAt.toISOString(),
    createdAt: order.createdAt.toISOString(),
  };
}
