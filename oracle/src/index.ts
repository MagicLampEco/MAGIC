/**
 * VeData Oracle Service — Main Orchestrator
 *
 * Boots in this order:
 *   1. Validate configuration (exits on misconfiguration)
 *   2. Verify oracle key pair
 *   3. Connect Prisma (DB)
 *   4. Start PaymentProcessor (Redis locks + crash recovery)
 *   5. Start MB Bank poller (30s interval, fallback)
 *   6. Mount PayOS webhook router on Express server
 *   7. Wire 'payment.confirmed' → processor
 *   8. Wire 'order.signed' → chain submitter
 *   9. Start HTTP server (webhook + health endpoints)
 *  10. Register graceful shutdown handlers
 *
 * Health endpoint: GET /health
 * Option B signature endpoint: POST /oracle/signature/:orderId
 */

import express, { type Request, type Response } from "express";
import { config, assertBlockfrostKeyMatchesNetwork } from "./config.js";
import { logger } from "./logger.js";
import { bus } from "./events.js";
import { prisma } from "./db.js";
import { loadKey } from "./signing/signer.js";
import { PaymentProcessor } from "./dedup/processor.js";
import { MBBankPoller } from "./bank/mb-poller.js";
import { chainSubmitter } from "./submission/chain-submitter.js";
import { createPayOSRouter } from "./bank/payos-monitor.js";
import { handleSignatureRequest } from "./api/signature-endpoint.js";
import type { NormalizedPayment } from "./events.js";

// ─── Application state ────────────────────────────────────────────────────────

let isShuttingDown = false;
const mbPoller = new MBBankPoller();
const processor = new PaymentProcessor();

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  logger.info(
    { version: "1.0.0", network: config.CARDANO_NETWORK, env: config.NODE_ENV },
    "VeData Oracle Service starting"
  );

  // 1. Key verification (exits if key pair is invalid)
  assertBlockfrostKeyMatchesNetwork();
  loadKey(); // throws on mismatch between ORACLE_PRIVATE_KEY and ORACLE_PUBLIC_KEY

  // 2. DB connectivity check
  await prisma.$connect();
  logger.info("Database connected");

  // 3. Start payment processor (connects Redis, runs crash recovery)
  await processor.start();

  // 4. Start MB Bank poller
  await mbPoller.start();

  // 5. Wire payment events → processor
  bus.on("payment.confirmed", async (payment: NormalizedPayment) => {
    if (isShuttingDown) {
      logger.warn("Shutdown in progress — dropping incoming payment event");
      return;
    }
    try {
      await processor.processPayment(payment);
    } catch (err) {
      logger.error({ err, source: payment.source, bankTxRef: payment.bankTxRef }, "Unhandled error in processPayment");
    }
  });

  // 6. Wire order.signed → chain submitter (Option A: oracle submits)
  bus.on("order.signed", async (orderId: string) => {
    if (isShuttingDown) {
      logger.warn({ orderId }, "Shutdown in progress — deferring chain submission");
      return;
    }
    try {
      await chainSubmitter.submitRelease(orderId);
    } catch (err) {
      logger.error({ err, orderId }, "Unhandled error in submitRelease");
    }
  });

  // 7. Build Express app
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // PayOS webhook
  app.use(createPayOSRouter());

  // Health check
  app.get("/health", async (_req: Request, res: Response): Promise<void> => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        status: isShuttingDown ? "halted" : "ok",
        ts: new Date().toISOString(),
        services: {
          db: "ok",
          mbPoller: "ok",
        },
        network: config.CARDANO_NETWORK,
        oraclePubKey: config.ORACLE_PUBLIC_KEY.slice(0, 16) + "...",
      });
    } catch (err) {
      res.status(503).json({
        status: "degraded",
        ts: new Date().toISOString(),
        error: String(err),
      });
    }
  });

  // Order status endpoint
  app.get("/oracle/status/:orderId", async (req: Request, res: Response): Promise<void> => {
    const { orderId } = req.params as { orderId: string };
    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { releaseSignature: true },
      });
      if (!order) {
        res.status(404).json({ error: "ORDER_NOT_FOUND" });
        return;
      }

      const sig = order.releaseSignature;
      const etaSeconds =
        order.status === "PENDING"
          ? Math.max(0, Math.floor((order.expiresAt.getTime() - Date.now()) / 1000))
          : order.status === "SUBMITTED"
          ? 60 // estimated Cardano confirmation time
          : null;

      res.json({
        orderId: order.id,
        referenceCode: order.referenceCode,
        status: order.status,
        tokenAmount: order.tokenAmount.toString(),
        expectedVND: order.expectedVND.toString(),
        expiresAt: order.expiresAt.toISOString(),
        completedAt: order.completedAt?.toISOString() ?? null,
        eta: etaSeconds,
        txHash: sig?.cardanoTxHash ?? null,
      });
    } catch (err) {
      logger.error({ err, orderId }, "Error fetching order status");
      res.status(500).json({ error: "INTERNAL_ERROR" });
    }
  });

  // Option B: buyer-initiated signature endpoint
  app.post(
    "/oracle/signature/:orderId",
    async (req: Request, res: Response): Promise<void> => {
      await handleSignatureRequest(req, res);
    }
  );

  // 8. Start HTTP server
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "HTTP server listening");
  });

  // 9. Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, "Shutdown signal received — draining...");

    server.close(() => logger.info("HTTP server closed"));

    try {
      await mbPoller.stop();
      await processor.stop();
      await prisma.$disconnect();
      logger.info("All services stopped cleanly");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception — initiating emergency shutdown");
    void shutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection");
    // Log but don't exit — some rejections are recoverable
  });

  logger.info("VeData Oracle Service fully initialized");
}

bootstrap().catch((err) => {
  logger.fatal({ err }, "Bootstrap failed — exiting");
  process.exit(1);
});
