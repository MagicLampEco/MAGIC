/**
 * Idempotency middleware.
 * Wraps POST handlers to:
 * 1. Return cached response if Idempotency-Key was already processed.
 * 2. Detect body mismatch for same key.
 * 3. Guard in-flight requests.
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import { createHash } from "crypto";
import { getRedis } from "../lib/redis.js";
import { newRequestId } from "../lib/requestId.js";

const TTL_SECONDS = 86_400; // 24 hours

interface CachedResponse {
  statusCode: number;
  body:       unknown;
  bodyHash:   string;
}

export async function idempotencyMiddleware(
  request: FastifyRequest,
  reply:   FastifyReply,
): Promise<void> {
  const key = request.headers["idempotency-key"] as string | undefined;
  if (!key) return; // No key — proceed normally

  // Validate UUID v4 format
  const uuidV4Re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidV4Re.test(key)) {
    return reply.status(400).send({
      error:     "VALIDATION_ERROR",
      message:   "Idempotency-Key phải là UUID v4.",
      requestId: newRequestId(),
      timestamp: new Date().toISOString(),
    });
  }

  const redis      = getRedis();
  const cacheKey   = `idempotency:response:${key}`;
  const inFlightKey = `idempotency:inflight:${key}`;
  const bodyHash   = createHash("sha256").update(JSON.stringify(request.body ?? {})).digest("hex");

  // Check in-flight
  const inFlight = await redis.get(inFlightKey);
  if (inFlight) {
    reply.header("Idempotency-Replayed", "false");
    return reply.status(409).send({
      error:     "IDEMPOTENCY_IN_FLIGHT",
      message:   "Request với key này đang xử lý.",
      requestId: newRequestId(),
      timestamp: new Date().toISOString(),
    });
  }

  // Check cached response
  const cached = await redis.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached) as CachedResponse;
    if (parsed.bodyHash !== bodyHash) {
      return reply.status(422).send({
        error:     "IDEMPOTENCY_KEY_MISMATCH",
        message:   "Cùng Idempotency-Key nhưng body khác.",
        requestId: newRequestId(),
        timestamp: new Date().toISOString(),
      });
    }
    reply.header("Idempotency-Replayed", "true");
    return reply.status(parsed.statusCode).send(parsed.body);
  }

  // Mark in-flight
  await redis.set(inFlightKey, "1", "EX", 30);

  // Store key + bodyHash on request for post-handler caching
  (request as FastifyRequest & { _idempotencyKey: string; _idempotencyBodyHash: string })._idempotencyKey     = key;
  (request as FastifyRequest & { _idempotencyKey: string; _idempotencyBodyHash: string })._idempotencyBodyHash = bodyHash;
}

/** Call this after a successful POST response to cache the result. */
export async function cacheIdempotencyResponse(
  request:    FastifyRequest,
  statusCode: number,
  body:       unknown,
): Promise<void> {
  const req = request as FastifyRequest & { _idempotencyKey?: string; _idempotencyBodyHash?: string };
  if (!req._idempotencyKey) return;

  const redis    = getRedis();
  const cacheKey  = `idempotency:response:${req._idempotencyKey}`;
  const inFlightKey = `idempotency:inflight:${req._idempotencyKey}`;

  const payload: CachedResponse = {
    statusCode,
    body,
    bodyHash: req._idempotencyBodyHash ?? "",
  };

  await Promise.all([
    redis.set(cacheKey, JSON.stringify(payload), "EX", TTL_SECONDS),
    redis.del(inFlightKey),
  ]);
}
