/**
 * VeData Oracle — MB Bank Polling Fallback
 *
 * Spec §1.1 (MB Bank BIZ):
 *   - Poll MB Bank transaction history API every 30 seconds
 *   - Statement API returns transactions in batch (last N entries)
 *   - Webhook delivery not guaranteed → reconcile with polling
 *   - Description field up to 50 chars; may include "CHUYEN TIEN" prefix
 *   - No sandbox; test against MB BIZ staging with real accounts
 *
 * Deduplication: Redis set keyed by bankTxRef prevents double-processing
 * when both webhook and poll detect the same transaction.
 */

import axios, { type AxiosInstance } from "axios";
import { createClient, type RedisClientType } from "redis";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { bus, type NormalizedPayment } from "../events.js";
import { extractValidRef } from "./ref-extractor.js";

// ─── MB Bank API response shapes ──────────────────────────────────────────────

interface MBBankTransaction {
  transactionId: string;       // Bank's unique tx ID
  creditAmount?: number;       // VND credit (positive = received)
  debitAmount?: number;        // VND debit (positive = sent)
  description: string;         // Transfer narration / remark
  transactionDate: string;     // ISO 8601 or "dd/MM/yyyy HH:mm:ss"
  balance?: number;            // Running balance after tx
  refNo?: string;              // Reference number
}

interface MBBankStatementResponse {
  result: {
    ok: boolean;
    message?: string;
  };
  transactions: MBBankTransaction[];
}

interface MBBankLoginResponse {
  result: { ok: boolean };
  token?: string;
  sessionId?: string;
}

// ─── Redis dedup key helpers ──────────────────────────────────────────────────

const DEDUP_KEY_PREFIX = "vedata:mb:seen:";
const DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days — covers any realistic polling gap

function dedupKey(bankTxRef: string): string {
  return `${DEDUP_KEY_PREFIX}${bankTxRef}`;
}

// ─── Parse MB Bank date strings ───────────────────────────────────────────────

function parseMBDate(raw: string): Date {
  // MB Bank may return: "2025-06-05T14:23:01" or "05/06/2025 14:23:01"
  // Try ISO first
  const iso = new Date(raw);
  if (!isNaN(iso.getTime())) return iso;

  // Vietnamese dd/MM/yyyy HH:mm:ss
  const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (match) {
    const [, dd, mm, yyyy, hh, min, ss] = match;
    return new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}+07:00`); // Vietnam is UTC+7
  }

  logger.warn({ raw }, "MBPoller: could not parse transaction date, falling back to now");
  return new Date();
}

// ─── MBBankPoller class ───────────────────────────────────────────────────────

export class MBBankPoller {
  private readonly http: AxiosInstance;
  private redis!: RedisClientType;
  private sessionToken: string | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private readonly childLog = logger.child({ component: "mb-poller" });

  constructor() {
    this.http = axios.create({
      baseURL: config.MB_BANK_API_BASE_URL,
      timeout: 15_000,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "VeDataOracle/1.0",
      },
    });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) {
      this.childLog.warn("MBBankPoller already running — start() called twice");
      return;
    }

    // Connect Redis
    this.redis = createClient({ url: config.REDIS_URL }) as RedisClientType;
    this.redis.on("error", (err: Error) => {
      this.childLog.error({ err }, "Redis connection error in MBBankPoller");
    });
    await this.redis.connect();

    // Initial authentication
    await this.authenticate();

    // Kick off polling loop
    this.isRunning = true;
    this.intervalHandle = setInterval(
      () => void this.pollOnce(),
      config.MB_BANK_POLL_INTERVAL_MS
    );

    this.childLog.info(
      { intervalMs: config.MB_BANK_POLL_INTERVAL_MS },
      "MBBankPoller started"
    );

    // Run immediately on start
    await this.pollOnce();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    await this.redis.disconnect();
    this.childLog.info("MBBankPoller stopped");
  }

  // ── Authentication ──────────────────────────────────────────────────────────

  private async authenticate(): Promise<void> {
    try {
      const resp = await this.http.post<MBBankLoginResponse>("/auth/login", {
        username: config.MB_BANK_USERNAME,
        password: config.MB_BANK_PASSWORD,
        accountNumber: config.MB_BANK_ACCOUNT_NUMBER,
      });

      if (!resp.data.result.ok || !resp.data.token) {
        throw new Error(
          `MB Bank auth failed: ${resp.data.result.message ?? "unknown error"}`
        );
      }

      this.sessionToken = resp.data.token;
      this.http.defaults.headers.common["Authorization"] = `Bearer ${this.sessionToken}`;
      this.childLog.info("MB Bank authentication successful");
    } catch (err) {
      this.childLog.error({ err }, "MB Bank authentication failed");
      throw err;
    }
  }

  // ── Poll loop ────────────────────────────────────────────────────────────────

  private async pollOnce(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const transactions = await this.fetchRecentTransactions();
      if (transactions.length === 0) return;

      this.childLog.debug(
        { count: transactions.length },
        "MBBankPoller: fetched transactions"
      );

      for (const tx of transactions) {
        await this.processTransaction(tx);
      }
    } catch (err) {
      // Re-authenticate on 401 errors
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        this.childLog.warn("MB Bank session expired, re-authenticating");
        try {
          await this.authenticate();
        } catch (authErr) {
          this.childLog.error({ err: authErr }, "MB Bank re-authentication failed");
          bus.emit("alert.ops", "MB Bank polling: authentication failure — manual intervention required", {
            error: String(authErr),
          });
        }
      } else {
        this.childLog.error({ err }, "MBBankPoller: poll failed");
      }
    }
  }

  private async fetchRecentTransactions(): Promise<MBBankTransaction[]> {
    const now = new Date();
    const from = new Date(now.getTime() - 10 * 60 * 1000); // last 10 minutes

    const resp = await this.http.get<MBBankStatementResponse>("/account/statement", {
      params: {
        accountNumber: config.MB_BANK_ACCOUNT_NUMBER,
        fromDate: this.formatDate(from),
        toDate: this.formatDate(now),
        limit: 50,
      },
    });

    if (!resp.data.result.ok) {
      throw new Error(`MB Bank statement API error: ${resp.data.result.message ?? "unknown"}`);
    }

    // Filter credits only (incoming payments)
    return (resp.data.transactions ?? []).filter(
      (tx) => typeof tx.creditAmount === "number" && tx.creditAmount > 0
    );
  }

  private formatDate(d: Date): string {
    // MB Bank API typically expects "dd/MM/yyyy"
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  // ── Per-transaction processing ───────────────────────────────────────────────

  private async processTransaction(tx: MBBankTransaction): Promise<void> {
    const bankTxRef = `mbbank-${tx.transactionId}`;

    // Dedup check via Redis
    const alreadySeen = await this.redis.get(dedupKey(bankTxRef));
    if (alreadySeen) {
      this.childLog.debug({ bankTxRef }, "MBPoller: already seen, skipping");
      return;
    }

    // Mark seen immediately (before processing — prevents race on concurrent polls)
    await this.redis.set(dedupKey(bankTxRef), "1", { EX: DEDUP_TTL_SECONDS });

    // Extract reference code
    // MB Bank description may contain "CHUYEN TIEN VD7K3X9MABQ2F8WP" prefix
    const ref = extractValidRef(tx.description);
    if (!ref) {
      this.childLog.debug(
        { description: tx.description, bankTxRef },
        "MBPoller: no valid reference code in description — not an OTC payment"
      );
      return;
    }

    const amountVND = BigInt(Math.round(tx.creditAmount!));

    const payment: NormalizedPayment = {
      source: "mbbank",
      bankTxRef,
      amountVND,
      rawDescription: tx.description,
      detectedAt: parseMBDate(tx.transactionDate),
      rawPayload: tx as unknown as Record<string, unknown>,
    };

    this.childLog.info(
      { ref, amountVND: amountVND.toString(), bankTxRef },
      "MBPoller: detected payment, emitting event"
    );

    bus.emit("payment.confirmed", payment);
  }
}
