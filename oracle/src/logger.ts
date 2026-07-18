/**
 * VeData Oracle — Structured Logger (pino)
 * Single instance shared across the whole service.
 */

import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: "vedata-oracle", env: config.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport:
    config.NODE_ENV !== "production"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        }
      : undefined,
});

export type Logger = typeof logger;
