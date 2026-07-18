/**
 * VeData Oracle — Ops Alerting
 * Sends alerts to Telegram (primary) and logs at ERROR level (fallback).
 * All anomalous payment events and system failures route through here.
 */

import axios from "axios";
import { config } from "./config.js";
import { logger } from "./logger.js";

export async function sendAlert(
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const fullMessage = metadata
    ? `${message}\n\nDetails:\n${JSON.stringify(metadata, null, 2)}`
    : message;

  logger.error({ alert: true, metadata }, `[ALERT] ${message}`);

  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_ALERT_CHAT_ID) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: config.TELEGRAM_ALERT_CHAT_ID,
          text: `🚨 VeData Oracle Alert\n\n${fullMessage}`,
          parse_mode: "Markdown",
        },
        { timeout: 5_000 }
      );
    } catch (err) {
      logger.error(
        { err },
        "Failed to send Telegram alert — check bot token and chat ID"
      );
    }
  }
}
