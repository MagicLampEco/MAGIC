/**
 * WebSocket server layer — real-time order and offer status events.
 *
 * Architecture: we maintain in-process subscription maps.
 * In multi-replica deployments, publish via Redis pub/sub and fan-out here.
 *
 * Endpoint: wss://otc.magiclamp.network/ws
 * Auth: query param ?token=<jwt> (public orders: skip auth, pass orderId only)
 *
 * Client messages:
 *   { action: "subscribe",   channel: "order",      orderId: "ord_..." }
 *   { action: "subscribe",   channel: "enterprise", enterpriseId: "ent_...", apiKey: "ent_live_..." }
 *   { action: "unsubscribe", channel: "order",      orderId: "ord_..." }
 *   { action: "pong" }
 *
 * Server emits:
 *   order.status | order.payment_detected | order.release_submitted
 *   order.completed | order.expired | order.disputed
 *   offer.activated | offer.depleted
 *   ping (heartbeat every 30 s)
 */
import type { FastifyInstance } from "fastify";
import type { WebSocket, RawData } from "ws";
import { getRedis } from "../lib/redis.js";
import pino from "pino";

const log = pino({ name: "ws-service" });

// Per-channel subscriber maps
const orderSubs = new Map<string, Set<WebSocket>>();     // orderId → sockets
const entSubs   = new Map<string, Set<WebSocket>>();     // enterpriseId → sockets

// Reverse map to clean up on disconnect
const socketSubs = new WeakMap<WebSocket, { orders: string[]; enterprises: string[] }>();

// ─────────────────────────────────────────────
// Subscription helpers
// ─────────────────────────────────────────────

function addOrderSub(socket: WebSocket, orderId: string): void {
  let set = orderSubs.get(orderId);
  if (!set) { set = new Set(); orderSubs.set(orderId, set); }
  set.add(socket);

  const meta = socketSubs.get(socket) ?? { orders: [], enterprises: [] };
  if (!meta.orders.includes(orderId)) meta.orders.push(orderId);
  socketSubs.set(socket, meta);
}

function addEntSub(socket: WebSocket, entId: string): void {
  let set = entSubs.get(entId);
  if (!set) { set = new Set(); entSubs.set(entId, set); }
  set.add(socket);

  const meta = socketSubs.get(socket) ?? { orders: [], enterprises: [] };
  if (!meta.enterprises.includes(entId)) meta.enterprises.push(entId);
  socketSubs.set(socket, meta);
}

function cleanupSocket(socket: WebSocket): void {
  const meta = socketSubs.get(socket);
  if (!meta) return;
  for (const orderId of meta.orders) { orderSubs.get(orderId)?.delete(socket); }
  for (const entId   of meta.enterprises) { entSubs.get(entId)?.delete(socket); }
}

function sendJSON(socket: WebSocket, data: unknown): void {
  if (socket.readyState === 1 /* OPEN */) {
    try { socket.send(JSON.stringify(data)); } catch { /* ignore dead socket */ }
  }
}

// ─────────────────────────────────────────────
// Public emit helpers — called from route handlers
// ─────────────────────────────────────────────

export const wsServer = {
  toOrder(orderId: string) {
    return {
      emit(event: string, data: unknown): void {
        const sockets = orderSubs.get(orderId);
        if (!sockets) return;
        const payload = { event, ...((data as object) ?? {}) };
        for (const sock of sockets) sendJSON(sock, payload);
      },
    };
  },
  toEnterprise(enterpriseId: string) {
    return {
      emit(event: string, data: unknown): void {
        const sockets = entSubs.get(enterpriseId);
        if (!sockets) return;
        const payload = { event, ...((data as object) ?? {}) };
        for (const sock of sockets) sendJSON(sock, payload);
      },
    };
  },
};

// ─────────────────────────────────────────────
// Register with Fastify (@fastify/websocket)
// ─────────────────────────────────────────────

export async function registerWebSocket(fastify: FastifyInstance): Promise<void> {
  // Attach wsServer to fastify instance for use in route handlers
  (fastify as FastifyInstance & { wsServer: typeof wsServer }).wsServer = wsServer;

  fastify.get("/ws", { websocket: true }, (socket: WebSocket, _req) => {
    log.debug("ws: client connected");

    sendJSON(socket, {
      event:      "connected",
      serverTime: new Date().toISOString(),
      message:    "OTC WebSocket ready. Send { action: 'subscribe', channel: 'order', orderId: '...' }",
    });

    // Heartbeat: 30 s ping
    const pingInterval = setInterval(() => {
      sendJSON(socket, { event: "ping", serverTime: new Date().toISOString() });
    }, 30_000);

    // Pong timeout: close if silent > 60 s
    let lastPong = Date.now();
    const pongWatcher = setInterval(() => {
      if (Date.now() - lastPong > 60_000) {
        log.debug("ws: pong timeout, closing");
        socket.terminate();
      }
    }, 10_000);

    socket.on("message", (raw: RawData) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        sendJSON(socket, { event: "error", message: "Invalid JSON." });
        return;
      }

      const action = msg["action"] as string | undefined;

      if (action === "pong") {
        lastPong = Date.now();
        return;
      }

      if (action === "subscribe") {
        const channel = msg["channel"] as string | undefined;
        if (channel === "order") {
          const orderId = msg["orderId"] as string | undefined;
          if (!orderId) {
            sendJSON(socket, { event: "error", message: "orderId required for order channel." });
            return;
          }
          addOrderSub(socket, orderId);
          sendJSON(socket, { event: "subscribed", channel: `order:${orderId}` });
          return;
        }
        if (channel === "enterprise") {
          const enterpriseId = msg["enterpriseId"] as string | undefined;
          if (!enterpriseId) {
            sendJSON(socket, { event: "error", message: "enterpriseId required for enterprise channel." });
            return;
          }
          // TODO: validate apiKey against enterprise record in production
          addEntSub(socket, enterpriseId);
          sendJSON(socket, { event: "subscribed", channel: `enterprise:${enterpriseId}` });
          return;
        }
        sendJSON(socket, { event: "error", message: `Unknown channel: ${channel ?? "undefined"}` });
        return;
      }

      if (action === "unsubscribe") {
        const channel  = msg["channel"] as string | undefined;
        const orderId  = msg["orderId"] as string | undefined;
        const entId    = msg["enterpriseId"] as string | undefined;
        if (channel === "order" && orderId)     orderSubs.get(orderId)?.delete(socket);
        if (channel === "enterprise" && entId)  entSubs.get(entId)?.delete(socket);
        sendJSON(socket, { event: "unsubscribed", channel });
        return;
      }

      sendJSON(socket, { event: "error", message: `Unknown action: ${action ?? "undefined"}` });
    });

    socket.on("close", () => {
      clearInterval(pingInterval);
      clearInterval(pongWatcher);
      cleanupSocket(socket);
      log.debug("ws: client disconnected");
    });

    socket.on("error", (err) => {
      log.warn({ err }, "ws: socket error");
    });
  });

  // ── Redis pub/sub fan-out for multi-replica deployments ─────────────────
  // Subscribe to a dedicated Redis channel; other replicas publish there.
  const redisSub = getRedis().duplicate();
  await redisSub.subscribe("otc:ws:events").catch((err: unknown) => {
    log.error({ err }, "ws: redis subscribe error");
  });

  redisSub.on("message", (_channel: string, message: string) => {
    try {
      const { target, targetId, event, data } = JSON.parse(message) as {
        target:   "order" | "enterprise";
        targetId: string;
        event:    string;
        data:     unknown;
      };
      if (target === "order")      wsServer.toOrder(targetId).emit(event, data);
      if (target === "enterprise") wsServer.toEnterprise(targetId).emit(event, data);
    } catch (e: unknown) {
      log.warn({ e }, "ws: malformed redis event");
    }
  });

  log.info("WebSocket service registered at /ws");
}

// ─────────────────────────────────────────────
// Helper to broadcast via Redis (used by services on other replicas)
// ─────────────────────────────────────────────
export async function publishOrderEvent(
  orderId: string,
  event:   string,
  data:    unknown,
): Promise<void> {
  await getRedis().publish(
    "otc:ws:events",
    JSON.stringify({ target: "order", targetId: orderId, event, data }),
  );
}

export async function publishEnterpriseEvent(
  enterpriseId: string,
  event:        string,
  data:         unknown,
): Promise<void> {
  await getRedis().publish(
    "otc:ws:events",
    JSON.stringify({ target: "enterprise", targetId: enterpriseId, event, data }),
  );
}
