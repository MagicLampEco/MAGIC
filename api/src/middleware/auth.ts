/**
 * Authentication middleware.
 *
 * - Enterprise:    X-API-Key header matched against bcrypt hash in DB.
 * - Oracle mTLS:   CN=vedata-oracle from TLS client cert (production).
 *                  Fallback: X-Oracle-Secret header (dev/staging only).
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcrypt";
import { prisma } from "../lib/prisma.js";
import { config } from "../lib/config.js";
import { getRedis } from "../lib/redis.js";
import { newRequestId } from "../lib/requestId.js";

// ─────────────────────────────────────────────
// Enterprise API key auth
// ─────────────────────────────────────────────

// Cache verified keys for 5 minutes to avoid bcrypt on every request
const keyCache = new Map<string, { enterpriseId: string; expiresAt: number }>();

async function lookupEnterpriseByApiKey(rawKey: string): Promise<{ enterpriseId: string; displayName: string } | null> {
  // Check cache
  const cached = keyCache.get(rawKey);
  if (cached && cached.expiresAt > Date.now()) {
    const ent = await prisma.enterprise.findUnique({ where: { id: cached.enterpriseId } });
    return ent ? { enterpriseId: ent.id, displayName: ent.displayName } : null;
  }

  // Load all active enterprises and check bcrypt (expensive — only done on cache miss)
  const enterprises = await prisma.enterprise.findMany({
    where:  { status: "ACTIVE" },
    select: { id: true, displayName: true, apiKeyHash: true },
  });

  for (const ent of enterprises) {
    const match = await bcrypt.compare(rawKey, ent.apiKeyHash);
    if (match) {
      keyCache.set(rawKey, { enterpriseId: ent.id, expiresAt: Date.now() + 5 * 60 * 1000 });
      return { enterpriseId: ent.id, displayName: ent.displayName };
    }
  }
  return null;
}

export async function requireEnterpriseAuth(
  request: FastifyRequest,
  reply:   FastifyReply,
): Promise<void> {
  const rawKey = request.headers["x-api-key"] as string | undefined;
  if (!rawKey || !rawKey.startsWith(config.apiKeyPrefix)) {
    return reply.status(401).send({
      error:     "UNAUTHORIZED",
      message:   "Thiếu hoặc sai API key.",
      requestId: newRequestId(),
      timestamp: new Date().toISOString(),
    });
  }

  const enterprise = await lookupEnterpriseByApiKey(rawKey);
  if (!enterprise) {
    return reply.status(401).send({
      error:     "UNAUTHORIZED",
      message:   "API key không hợp lệ.",
      requestId: newRequestId(),
      timestamp: new Date().toISOString(),
    });
  }

  // Attach to request for route handlers
  (request as FastifyRequest & { enterprise: { enterpriseId: string; displayName: string } }).enterprise = enterprise;
}

// ─────────────────────────────────────────────
// Oracle internal auth
// ─────────────────────────────────────────────
export async function requireOracleAuth(
  request: FastifyRequest,
  reply:   FastifyReply,
): Promise<void> {
  // Production: check mTLS CN from TLS peer certificate
  // Fastify with @fastify/tls can expose `request.socket.getPeerCertificate()`
  const socket = (request.raw as unknown as { socket?: { getPeerCertificate?: () => { subject?: { CN?: string } } } }).socket;
  if (socket?.getPeerCertificate) {
    const cert = socket.getPeerCertificate();
    if (cert?.subject?.CN === "vedata-oracle") return;
  }

  // Fallback (dev/staging): shared secret header
  const oracleSecret = request.headers["x-oracle-secret"] as string | undefined;
  if (oracleSecret === config.oracle.secret) return;

  return reply.status(401).send({
    error:     "UNAUTHORIZED",
    message:   "Oracle authentication thất bại.",
    requestId: newRequestId(),
    timestamp: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────
// Rate limiting helpers (supplement @fastify/rate-limit)
// ─────────────────────────────────────────────
export async function checkOrderCreationRateLimit(
  ip:            string,
  buyerWallet:   string,
): Promise<void> {
  const redis = getRedis();
  const now   = Math.floor(Date.now() / 1000);
  const window = 60; // 1 minute

  const ipKey     = `ratelimit:order:ip:${ip}`;
  const walletKey = `ratelimit:order:wallet:${buyerWallet}`;

  const [ipCount, walletCount] = await Promise.all([
    redis.incr(ipKey),
    redis.incr(walletKey),
  ]);

  // Set TTL on first increment
  if (ipCount === 1)     await redis.expire(ipKey,     window);
  if (walletCount === 1) await redis.expire(walletKey, window);

  if (ipCount > 10) {
    throw Object.assign(new Error("RATE_LIMITED"), {
      code: "RATE_LIMITED", statusCode: 429,
      message: "Quá nhiều lệnh từ IP này. Thử lại sau 1 phút.",
      retryAfter: window,
    });
  }
  if (walletCount > 3) {
    throw Object.assign(new Error("RATE_LIMITED"), {
      code: "RATE_LIMITED", statusCode: 429,
      message: "Quá nhiều lệnh từ địa chỉ ví này. Thử lại sau 1 phút.",
      retryAfter: window,
    });
  }
}

