/**
 * LAMP/MAGIC OTC Desk — Order Management API
 * Entry point: Fastify server setup + plugin registration + route mounting.
 */
import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { config } from "./lib/config.js";
import { prisma } from "./lib/prisma.js";
import { getRedis, closeRedis } from "./lib/redis.js";
import { offersRoutes } from "./routes/offers.js";
import { ordersRoutes } from "./routes/orders.js";
import { internalRoutes } from "./routes/internal.js";
import { registerWebSocket } from "./services/websocket.service.js";
import { startKeyspaceExpiryWorker, startCronExpiryWorker } from "./services/expiry.worker.js";
import { newRequestId } from "./lib/requestId.js";

// ─────────────────────────────────────────────
// Build Fastify app
// ─────────────────────────────────────────────
export async function buildApp() {
  const fastify = Fastify({
    logger: config.env === "development"
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : true,
    trustProxy: true,
    genReqId:   () => newRequestId(),
  });

  // ── Core plugins ────────────────────────────────────────────────────────

  await fastify.register(cors, {
    origin: config.env === "production"
      ? ["https://otc.magiclamp.network", "https://magiclamp.network"]
      : true,
    methods:     ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key", "Idempotency-Key", "X-Oracle-Secret"],
    exposedHeaders: ["X-Request-ID", "X-Rate-Limit-Remaining", "X-Rate-Limit-Reset", "Idempotency-Replayed"],
    credentials: true,
  });

  await fastify.register(jwt, {
    secret: config.jwt.secret,
  });

  // Rate limiting — defaults; per-endpoint limits enforced in middleware/auth.ts for orders
  await fastify.register(rateLimit, {
    global:    true,
    max:       300,
    timeWindow: "1 minute",
    redis:     getRedis(),
    keyGenerator(request) {
      return request.headers["x-api-key"]
        ? `ent:${request.headers["x-api-key"] as string}`
        : `ip:${request.ip}`;
    },
    errorResponseBuilder(_req, context) {
      return {
        error:     "RATE_LIMITED",
        message:   `Quá giới hạn gọi API. Thử lại sau ${context.after}.`,
        requestId: newRequestId(),
        timestamp: new Date().toISOString(),
      };
    },
  });

  // WebSocket plugin
  await fastify.register(websocket, {
    options: { maxPayload: 1024 * 16 },
  });

  // ── Global response headers ──────────────────────────────────────────────
  fastify.addHook("onSend", async (request, reply) => {
    if (!reply.hasHeader("X-Request-ID")) {
      reply.header("X-Request-ID", request.id ?? newRequestId());
    }
    // Rate limit headers forwarded from the plugin
  });

  // ── Global error handler ─────────────────────────────────────────────────
  fastify.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id ?? newRequestId());
    fastify.log.error({ err: error, requestId }, "unhandled error");

    if (error.statusCode === 429) {
      return reply.status(429).send({
        error:     "RATE_LIMITED",
        message:   "Quá giới hạn gọi API.",
        requestId,
        timestamp: new Date().toISOString(),
      });
    }

    return reply.status(error.statusCode ?? 500).send({
      error:     "INTERNAL_ERROR",
      message:   config.env === "production" ? "Lỗi server nội bộ." : error.message,
      requestId,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Health check ─────────────────────────────────────────────────────────
  fastify.get("/health", async (_req, reply) => {
    let dbOk = false;
    let redisOk = false;
    try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { /* */ }
    try { await getRedis().ping(); redisOk = true; } catch { /* */ }
    const ok = dbOk && redisOk;
    return reply.status(ok ? 200 : 503).send({
      status: ok ? "ok" : "degraded",
      db:     dbOk ? "ok" : "error",
      redis:  redisOk ? "ok" : "error",
      time:   new Date().toISOString(),
    });
  });

  // ── Routes ───────────────────────────────────────────────────────────────
  await fastify.register(offersRoutes);
  await fastify.register(ordersRoutes);
  await fastify.register(internalRoutes);

  // ── WebSocket ────────────────────────────────────────────────────────────
  await registerWebSocket(fastify);

  return fastify;
}

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────
async function start(): Promise<void> {
  const app = await buildApp();

  // Expiry workers
  startCronExpiryWorker();
  await startKeyspaceExpiryWorker().catch((err) => {
    app.log.warn({ err }, "keyspace worker failed to start — cron fallback active");
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutdown signal received");
    await app.close();
    await prisma.$disconnect();
    await closeRedis();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT",  () => void shutdown("SIGINT"));

  // Listen
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`OTC API listening on ${config.host}:${config.port}`);
}

start().catch((err: unknown) => {
  console.error("fatal startup error", err);
  process.exit(1);
});
