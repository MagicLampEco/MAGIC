/**
 * Order expiry worker.
 *
 * Two strategies run in parallel:
 * 1. Redis keyspace notifications — instant expiry when `order:lock:<orderId>` key expires.
 * 2. Cron fallback — every 60 seconds, expire any AWAITING_PAYMENT orders past expiresAt.
 *
 * Requires Redis config: notify-keyspace-events "Ex"
 */
import { getRedis } from "../lib/redis.js";
import { expireOrders } from "./order.service.js";
import { prisma } from "../lib/prisma.js";
import pino from "pino";

const log = pino({ name: "expiry-worker" });

// ─────────────────────────────────────────────
// Strategy 1: Redis keyspace notifications
// ─────────────────────────────────────────────
export async function startKeyspaceExpiryWorker(): Promise<void> {
  const redis = getRedis().duplicate();

  // Enable keyspace notifications programmatically
  await redis.config("SET", "notify-keyspace-events", "Ex");

  await redis.subscribe("__keyevent@0__:expired");

  redis.on("message", async (_channel: string, key: string) => {
    const match = key.match(/^order:lock:(.+)$/);
    if (!match) return;

    const orderId = match[1];
    log.debug({ orderId }, "keyspace expiry: order lock expired");

    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, offerId: true, tokenAmount: true },
      });
      if (!order) return;
      if (!["CREATED", "AWAITING_PAYMENT"].includes(order.status)) return;

      await prisma.$transaction([
        prisma.order.update({ where: { id: orderId }, data: { status: "EXPIRED" } }),
        prisma.orderTimeline.create({
          data: { orderId, status: "EXPIRED", actor: "BACKEND", note: "Order hết hạn (Redis TTL)." },
        }),
        prisma.offer.update({
          where: { id: order.offerId },
          data:  {
            availableAmount: { increment: order.tokenAmount },
            lockedAmount:    { decrement: order.tokenAmount },
          },
        }),
        prisma.payment.updateMany({
          where: { orderId, status: "PENDING" },
          data:  { status: "EXPIRED" },
        }),
      ]);

      log.info({ orderId }, "order expired via keyspace notification");
    } catch (err) {
      log.error({ err, orderId }, "failed to expire order from keyspace notification");
    }
  });

  redis.on("error", (err) => log.error({ err }, "expiry worker redis error"));
  log.info("keyspace expiry worker started");
}

// ─────────────────────────────────────────────
// Strategy 2: Cron fallback (every 60 s)
// ─────────────────────────────────────────────
export function startCronExpiryWorker(): void {
  const run = async () => {
    try {
      const count = await expireOrders();
      if (count > 0) log.info({ count }, "cron expired orders");
    } catch (err: unknown) {
      log.error({ err }, "cron expiry worker error");
    }
  };

  // Run immediately, then every 60 s
  void run();
  setInterval(() => { void run(); }, 60_000);
  log.info("cron expiry worker started (60 s interval)");
}
