/**
 * VeData Oracle — Idempotent Payment Processor
 *
 * Spec §6: "Definitively Processed" guarantees, crash recovery, distributed locking.
 *
 * Flow for each incoming NormalizedPayment:
 *   1. Acquire Redis distributed lock on orderId (prevent concurrent processing)
 *   2. Persist raw PaymentEvent to DB (deduplication: UNIQUE source+bankTxRef)
 *   3. Validate: extract ref, check order exists, amount matches, order not expired
 *   4. Transition order state machine: PENDING → PAYMENT_MATCHED → SIGNING → SIGNED
 *   5. Call signer, update order status, release lock
 *   6. Emit 'order.signed' for chain-submitter
 *
 * All anomalous payments (§2.4) are stored in payment_exceptions and alert ops.
 */

import { createClient, type RedisClientType } from "redis";
import { type Prisma } from "@prisma/client";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { bus, type NormalizedPayment } from "../events.js";
import { prisma } from "../db.js";
import { signRelease } from "../signing/signer.js";
import { extractValidRef } from "../bank/ref-extractor.js";
import { sendAlert } from "../alerting.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type ExceptionType =
  | "UNMATCHED_PAYMENT"
  | "EXPIRED_ORDER"
  | "DUPLICATE_PAYMENT"
  | "UNDERPAYMENT"
  | "OVERPAYMENT"
  | "WRONG_ACCOUNT";

// ─── Redis lock helpers ───────────────────────────────────────────────────────

const LOCK_PREFIX = "vedata:lock:order:";
const LOCK_TTL_SECONDS = 30;
const LOCK_RETRY_DELAY_MS = 200;
const LOCK_MAX_RETRIES = 10;

async function acquireLock(redis: RedisClientType, orderId: string): Promise<string | null> {
  const key = `${LOCK_PREFIX}${orderId}`;
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");

  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    const result = await redis.set(key, token, {
      NX: true,
      EX: LOCK_TTL_SECONDS,
    });
    if (result === "OK") return token;
    await new Promise<void>((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
  }
  return null; // Could not acquire lock
}

async function releaseLock(
  redis: RedisClientType,
  orderId: string,
  token: string
): Promise<void> {
  const key = `${LOCK_PREFIX}${orderId}`;
  // Lua script for atomic check-and-delete
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  await redis.eval(script, { keys: [key], arguments: [token] });
}

// ─── Exception recording ──────────────────────────────────────────────────────

async function recordException(
  paymentEventId: bigint,
  exceptionType: ExceptionType,
  amountVND: bigint,
  description: string | null,
  refExtracted: string | null,
  orderId: string | null
): Promise<void> {
  await prisma.paymentException.create({
    data: {
      paymentEventId,
      exceptionType,
      amountReceived: amountVND,
      rawDescription: description,
      refExtracted,
      ...(orderId ? { orderId } : {}),
    },
  });
}

// ─── Processor class ──────────────────────────────────────────────────────────

export class PaymentProcessor {
  private redis!: RedisClientType;
  private readonly childLog = logger.child({ component: "processor" });

  async start(): Promise<void> {
    this.redis = createClient({ url: config.REDIS_URL }) as RedisClientType;
    this.redis.on("error", (err: Error) => {
      this.childLog.error({ err }, "Redis error in PaymentProcessor");
    });
    await this.redis.connect();
    this.childLog.info("PaymentProcessor started");

    // On startup: recover any orders stuck in SIGNING state
    await this.recoverSigningState();
  }

  async stop(): Promise<void> {
    await this.redis.disconnect();
    this.childLog.info("PaymentProcessor stopped");
  }

  // ── Crash recovery ────────────────────────────────────────────────────────

  async recoverSigningState(): Promise<void> {
    const stuckOrders = await prisma.order.findMany({
      where: {
        status: "SIGNING",
        // Only recover if stuck for > 60 seconds (allows in-progress signing to complete)
        updatedAt: {
          lt: new Date(Date.now() - 60_000),
        },
      },
    });

    if (stuckOrders.length === 0) return;

    this.childLog.warn(
      { count: stuckOrders.length },
      "Found orders stuck in SIGNING state — recovering"
    );

    for (const order of stuckOrders) {
      const existing = await prisma.releaseSignature.findUnique({
        where: { orderId: order.id },
      });

      if (existing) {
        // Signing completed before crash; resume at SIGNED
        await prisma.order.update({
          where: { id: order.id },
          data: { status: "SIGNED" },
        });
        this.childLog.info(
          { orderId: order.id },
          "Recovery: signing was complete, advanced to SIGNED"
        );
        bus.emit("order.signed", order.id);
      } else {
        // Signing did not complete; safe to retry
        await prisma.order.update({
          where: { id: order.id },
          data: { status: "PAYMENT_MATCHED" },
        });
        this.childLog.info(
          { orderId: order.id },
          "Recovery: signing was incomplete, reset to PAYMENT_MATCHED for retry"
        );
      }
    }
  }

  // ── Main entry point ──────────────────────────────────────────────────────

  async processPayment(payment: NormalizedPayment): Promise<void> {
    const childLog = this.childLog.child({ bankTxRef: payment.bankTxRef, source: payment.source });

    // 1. Persist raw payment event — dedup by UNIQUE(source, bankTxRef)
    let paymentEvent: { id: bigint } | null = null;
    try {
      paymentEvent = await prisma.paymentEvent.create({
        data: {
          source: payment.source,
          bankTxRef: payment.bankTxRef,
          amountVND: payment.amountVND,
          rawDescription: payment.rawDescription,
          rawPayload: payment.rawPayload as Prisma.InputJsonValue,
          detectedAt: payment.detectedAt,
        },
        select: { id: true },
      });
    } catch (err: unknown) {
      // Unique constraint violation = already seen from another source (webhook + poll)
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === "P2002"
      ) {
        childLog.debug("Payment already stored (dedup) — skipping");
        return;
      }
      throw err;
    }

    childLog.info(
      { eventId: paymentEvent.id.toString(), amountVND: payment.amountVND.toString() },
      "PaymentEvent persisted"
    );

    // 2. Extract reference code from description
    const ref = extractValidRef(payment.rawDescription);
    if (!ref) {
      childLog.warn({ description: payment.rawDescription }, "No valid reference code — UNMATCHED_PAYMENT");
      await recordException(
        paymentEvent.id,
        "UNMATCHED_PAYMENT",
        payment.amountVND,
        payment.rawDescription,
        null,
        null
      );
      await sendAlert(
        `UNMATCHED_PAYMENT: ${payment.amountVND} VND from ${payment.source} — no valid ref code in description: "${payment.rawDescription}"`
      );
      await prisma.paymentEvent.update({
        where: { id: paymentEvent.id },
        data: { processed: true, processedAt: new Date() },
      });
      return;
    }

    // 3. Look up order by reference code
    const order = await prisma.order.findUnique({ where: { referenceCode: ref } });
    if (!order) {
      childLog.warn({ ref }, "Reference code not found in DB — UNMATCHED_PAYMENT");
      await recordException(
        paymentEvent.id,
        "UNMATCHED_PAYMENT",
        payment.amountVND,
        payment.rawDescription,
        ref,
        null
      );
      await sendAlert(
        `UNMATCHED_PAYMENT: ref ${ref} not found in order DB. Amount: ${payment.amountVND} VND`
      );
      await prisma.paymentEvent.update({
        where: { id: paymentEvent.id },
        data: { processed: true, processedAt: new Date(), orderId: null },
      });
      return;
    }

    childLog.info({ orderId: order.id, orderStatus: order.status }, "Order found");

    // Link payment event to order
    await prisma.paymentEvent.update({
      where: { id: paymentEvent.id },
      data: { orderId: order.id },
    });

    // 4. Acquire distributed lock on this order
    const lockToken = await acquireLock(this.redis, order.id);
    if (!lockToken) {
      childLog.warn(
        { orderId: order.id },
        "Could not acquire lock — another processor is handling this order"
      );
      return;
    }

    try {
      await this.handleLockedOrder(order, payment, paymentEvent.id, ref, childLog);
    } finally {
      await releaseLock(this.redis, order.id, lockToken);
    }
  }

  // ── Locked order handler ──────────────────────────────────────────────────

  private async handleLockedOrder(
    order: Awaited<ReturnType<typeof prisma.order.findUnique>> & object,
    payment: NormalizedPayment,
    paymentEventId: bigint,
    ref: string,
    childLog: ReturnType<typeof logger.child>
  ): Promise<void> {
    if (!order) return;

    // Re-fetch inside lock to get latest status
    const freshOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });

    // 5. Check order status — handle already-processed orders
    if (
      freshOrder.status === "PAYMENT_MATCHED" ||
      freshOrder.status === "SIGNING" ||
      freshOrder.status === "SIGNED" ||
      freshOrder.status === "SUBMITTED" ||
      freshOrder.status === "CONFIRMED" ||
      freshOrder.status === "FINALIZED"
    ) {
      childLog.warn(
        { status: freshOrder.status },
        "Order already processed — DUPLICATE_PAYMENT detected"
      );
      await recordException(
        paymentEventId,
        "DUPLICATE_PAYMENT",
        payment.amountVND,
        payment.rawDescription,
        ref,
        freshOrder.id
      );
      await sendAlert(
        `DUPLICATE_PAYMENT ALERT: Order ${freshOrder.id} (ref ${ref}) received second payment of ` +
          `${payment.amountVND} VND from ${payment.source}. REQUIRES HUMAN REVIEW.`,
        { orderId: freshOrder.id, source: payment.source, amountVND: payment.amountVND.toString() }
      );
      await prisma.paymentEvent.update({
        where: { id: paymentEventId },
        data: { processed: true, processedAt: new Date() },
      });
      return;
    }

    if (freshOrder.status === "EXPIRED") {
      childLog.warn({ ref }, "Order expired — EXPIRED_ORDER");
      await recordException(paymentEventId, "EXPIRED_ORDER", payment.amountVND, payment.rawDescription, ref, freshOrder.id);
      await sendAlert(
        `EXPIRED_ORDER: ${payment.amountVND} VND received for expired order ${freshOrder.id} (ref ${ref}).`
      );
      await prisma.paymentEvent.update({
        where: { id: paymentEventId },
        data: { processed: true, processedAt: new Date() },
      });
      return;
    }

    if (freshOrder.status === "EXCEPTION") {
      childLog.warn({ ref }, "Order already in EXCEPTION state — human review required");
      await prisma.paymentEvent.update({
        where: { id: paymentEventId },
        data: { processed: true, processedAt: new Date() },
      });
      return;
    }

    // 6. Check order expiry
    if (new Date() > freshOrder.expiresAt) {
      childLog.warn({ ref, expiresAt: freshOrder.expiresAt }, "Order has expired");
      await prisma.order.update({ where: { id: freshOrder.id }, data: { status: "EXPIRED" } });
      await recordException(paymentEventId, "EXPIRED_ORDER", payment.amountVND, payment.rawDescription, ref, freshOrder.id);
      await sendAlert(
        `EXPIRED_ORDER: ${payment.amountVND} VND received but order ${freshOrder.id} expired at ${freshOrder.expiresAt.toISOString()}.`
      );
      await prisma.paymentEvent.update({
        where: { id: paymentEventId },
        data: { processed: true, processedAt: new Date() },
      });
      return;
    }

    // 7. Amount validation — EXACT match (spec §2.2)
    if (payment.amountVND < freshOrder.expectedVND) {
      await this.handleInsufficientPayment(payment, paymentEventId, freshOrder, ref, childLog);
      return;
    }

    if (payment.amountVND > freshOrder.expectedVND) {
      await this.handleExcessPayment(payment, paymentEventId, freshOrder, ref, childLog);
      return;
    }

    // 8. Exact match — proceed to signing
    childLog.info(
      { amountVND: payment.amountVND.toString(), expected: freshOrder.expectedVND.toString() },
      "Amount matches exactly — proceeding to signing"
    );

    await this.executeSigningPipeline(freshOrder, paymentEventId, childLog);
  }

  // ── Signing pipeline (with crash recovery bracket) ────────────────────────

  private async executeSigningPipeline(
    order: NonNullable<Awaited<ReturnType<typeof prisma.order.findUnique>>>,
    paymentEventId: bigint,
    childLog: ReturnType<typeof logger.child>
  ): Promise<void> {
    // Transition to PAYMENT_MATCHED first (transactional)
    await prisma.$transaction([
      prisma.order.update({
        where: { id: order.id },
        data: { status: "PAYMENT_MATCHED" },
      }),
      prisma.paymentEvent.update({
        where: { id: paymentEventId },
        data: { processed: true, processedAt: new Date() },
      }),
    ]);

    // Mark SIGNING — crash recovery will find us if we die here
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "SIGNING" },
    });

    // Sign the release (outside DB transaction — signing is pure CPU work)
    let signed;
    try {
      signed = await signRelease(order);
    } catch (err) {
      childLog.error({ err }, "Signing failed — reverting to PAYMENT_MATCHED for retry");
      await prisma.order.update({
        where: { id: order.id },
        data: { status: "PAYMENT_MATCHED" },
      });
      throw err;
    }

    // Advance to SIGNED
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "SIGNED" },
    });

    childLog.info(
      { orderId: order.id, expiryPosix: signed.expiryPosix.toString() },
      "Order signed successfully"
    );

    bus.emit("order.signed", order.id);
  }

  // ── Anomalous payment handlers ────────────────────────────────────────────

  private async handleInsufficientPayment(
    payment: NormalizedPayment,
    paymentEventId: bigint,
    order: NonNullable<Awaited<ReturnType<typeof prisma.order.findUnique>>>,
    ref: string,
    childLog: ReturnType<typeof logger.child>
  ): Promise<void> {
    const shortfall = order.expectedVND - payment.amountVND;
    childLog.warn(
      { received: payment.amountVND.toString(), expected: order.expectedVND.toString(), shortfall: shortfall.toString() },
      "UNDERPAYMENT — amount insufficient"
    );

    await prisma.$transaction([
      prisma.order.update({ where: { id: order.id }, data: { status: "EXCEPTION" } }),
      prisma.paymentEvent.update({
        where: { id: paymentEventId },
        data: { processed: true, processedAt: new Date() },
      }),
    ]);

    await recordException(
      paymentEventId,
      "UNDERPAYMENT",
      payment.amountVND,
      payment.rawDescription,
      ref,
      order.id
    );

    await sendAlert(
      `UNDERPAYMENT: Order ${order.id} (ref ${ref}). Expected ${order.expectedVND} VND, ` +
        `received ${payment.amountVND} VND. Shortfall: ${shortfall} VND. Human review required.`,
      {
        orderId: order.id,
        expected: order.expectedVND.toString(),
        received: payment.amountVND.toString(),
        shortfall: shortfall.toString(),
      }
    );
  }

  private async handleExcessPayment(
    payment: NormalizedPayment,
    paymentEventId: bigint,
    order: NonNullable<Awaited<ReturnType<typeof prisma.order.findUnique>>>,
    ref: string,
    childLog: ReturnType<typeof logger.child>
  ): Promise<void> {
    const excess = payment.amountVND - order.expectedVND;
    childLog.warn(
      { received: payment.amountVND.toString(), expected: order.expectedVND.toString(), excess: excess.toString() },
      "OVERPAYMENT — do NOT auto-release"
    );

    await prisma.$transaction([
      prisma.order.update({ where: { id: order.id }, data: { status: "EXCEPTION" } }),
      prisma.paymentEvent.update({
        where: { id: paymentEventId },
        data: { processed: true, processedAt: new Date() },
      }),
    ]);

    await recordException(
      paymentEventId,
      "OVERPAYMENT",
      payment.amountVND,
      payment.rawDescription,
      ref,
      order.id
    );

    await sendAlert(
      `OVERPAYMENT: Order ${order.id} (ref ${ref}). Expected ${order.expectedVND} VND, ` +
        `received ${payment.amountVND} VND. Excess: ${excess} VND. DO NOT AUTO-RELEASE. Human review required.`,
      {
        orderId: order.id,
        expected: order.expectedVND.toString(),
        received: payment.amountVND.toString(),
        excess: excess.toString(),
      }
    );
  }
}
