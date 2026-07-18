import { PrismaClient } from "@prisma/client";
import { config } from "./config.js";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: config.env === "development" ? ["query", "warn", "error"] : ["error"],
    datasources: { db: { url: config.database.url } },
  });

if (config.env !== "production") {
  globalForPrisma.prisma = prisma;
}
