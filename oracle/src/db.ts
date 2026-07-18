/**
 * VeData Oracle — Prisma client singleton
 */

import { PrismaClient } from "@prisma/client";
import { logger } from "./logger.js";

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__prisma ??
  new PrismaClient({
    log: [
      { level: "query", emit: "event" },
      { level: "warn", emit: "stdout" },
      { level: "error", emit: "stdout" },
    ],
  });

if (process.env["NODE_ENV"] !== "production") {
  global.__prisma = prisma;
}

prisma.$on("query" as never, (e: unknown) => {
  const ev = e as { query: string; duration: number };
  if (ev.duration > 500) {
    logger.warn(
      { query: ev.query, durationMs: ev.duration },
      "Slow DB query detected"
    );
  }
});
