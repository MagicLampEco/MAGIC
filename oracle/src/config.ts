/**
 * VeData Oracle — Configuration
 * All environment variables validated with Zod at startup.
 * The process exits immediately if any required variable is missing or malformed.
 */

import { z } from "zod";
import { config as loadDotenv } from "dotenv";

loadDotenv();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const hexString = (len?: number) =>
  z.string().regex(
    len ? new RegExp(`^[0-9a-fA-F]{${len}}$`) : /^[0-9a-fA-F]+$/,
    len ? `Must be ${len}-char hex string` : "Must be a hex string"
  );

const portNumber = z.coerce
  .number()
  .int()
  .min(1024)
  .max(65535);

const positiveInt = z.coerce.number().int().positive();

// ─── Schema ───────────────────────────────────────────────────────────────────

const ConfigSchema = z.object({
  // ── Oracle key material ──────────────────────────────────────────────────
  ORACLE_PRIVATE_KEY: hexString(64).describe(
    "32-byte Ed25519 private key seed, hex-encoded"
  ),
  ORACLE_PUBLIC_KEY: hexString(64).describe(
    "32-byte Ed25519 public key, hex-encoded"
  ),

  // ── PayOS (primary bank webhook) ─────────────────────────────────────────
  PAYOS_CLIENT_ID: z.string().min(1),
  PAYOS_API_KEY: z.string().min(1),
  PAYOS_CHECKSUM_KEY: z.string().min(1).describe(
    "HMAC-SHA256 key for verifying PayOS webhook payloads"
  ),

  // ── MB Bank (polling fallback) ────────────────────────────────────────────
  MB_BANK_ACCOUNT_NUMBER: z.string().regex(/^\d{6,20}$/, "Must be digits only"),
  MB_BANK_USERNAME: z.string().min(1),
  MB_BANK_PASSWORD: z.string().min(1),
  MB_BANK_API_BASE_URL: z
    .string()
    .url()
    .default("https://api.mbbank.com.vn/v2"),
  MB_BANK_POLL_INTERVAL_MS: positiveInt.default(30_000).describe(
    "How often (ms) to poll MB Bank statement API"
  ),

  // ── Cardano / Blockfrost ──────────────────────────────────────────────────
  CARDANO_NETWORK: z.enum(["mainnet", "preview", "preprod"]).default("preview"),
  BLOCKFROST_API_KEY: z.string().min(1),
  BLOCKFROST_BASE_URL: z
    .string()
    .url()
    .optional()
    .describe("Override Blockfrost URL (for custom Blockfrost-compat nodes)"),

  // ── OTC Contract ─────────────────────────────────────────────────────────
  OTC_SCRIPT_ADDRESS: z.string().min(50).describe(
    "Bech32 address of the deployed OTC Escrow contract"
  ),
  OTC_SCRIPT_CBOR: z.string().regex(/^[0-9a-fA-F]+$/).describe(
    "Full script CBOR for Tx construction"
  ),
  ORACLE_FEE_WALLET_SKEY: hexString(128).describe(
    "Ed25519 extended signing key (256-bit cborHex) of oracle fee wallet, used to pay Cardano tx fees"
  ),

  // ── Storage ───────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().url().describe("PostgreSQL connection string"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  // ── Bank settlement account ───────────────────────────────────────────────
  BANK_ACCOUNT_NUMBER: z.string().regex(/^\d{6,20}$/).describe(
    "Enterprise VND-receiving bank account number shown on VietQR"
  ),
  BANK_ACCOUNT_NAME: z.string().min(1).describe(
    "Registered business name on the settlement account"
  ),
  BANK_BIN: z.string().regex(/^\d{6,9}$/).describe(
    "NAPAS Bank Identification Number (e.g. 970422 for MB Bank)"
  ),

  // ── Oracle tuning ─────────────────────────────────────────────────────────
  RELEASE_SIGNATURE_TTL_MINUTES: positiveInt.default(15).describe(
    "Seconds before a release signature expires"
  ),
  ORDER_EXPIRY_MINUTES: positiveInt.default(30).describe(
    "Minutes a buyer has to complete payment before order expires"
  ),
  CONFIRMATION_DEPTH: positiveInt.default(3).describe(
    "Cardano block depth required for FINALIZED status"
  ),
  MAX_RESIGN_COUNT: positiveInt.default(5).describe(
    "Maximum times a signature may be re-issued for the same order"
  ),

  // ── HTTP server ───────────────────────────────────────────────────────────
  PORT: portNumber.default(3100),
  WEBHOOK_PATH_PAYOS: z.string().default("/webhook/payos"),
  WEBHOOK_PATH_MBBANK: z.string().default("/webhook/mbbank"),

  // ── Alerting ──────────────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ALERT_CHAT_ID: z.string().optional(),
  OPS_EMAIL: z.string().email().optional(),

  // ── Misc ─────────────────────────────────────────────────────────────────
  NODE_ENV: z
    .enum(["development", "staging", "production"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

// ─── Parse & export ───────────────────────────────────────────────────────────

function parseConfig(): AppConfig {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(
      `[VeData Oracle] Configuration error — missing or invalid environment variables:\n${issues}`
    );
    process.exit(1);
  }
  return result.data;
}

export const config: AppConfig = parseConfig();

// ─── Derived helpers ──────────────────────────────────────────────────────────

export const isProduction = config.NODE_ENV === "production";

/** Blockfrost project ID prefix must match the selected network. */
export function assertBlockfrostKeyMatchesNetwork(): void {
  const key = config.BLOCKFROST_API_KEY;
  const net = config.CARDANO_NETWORK;
  const prefix =
    net === "mainnet" ? "mainnet" : net === "preview" ? "preview" : "preprod";
  if (!key.startsWith(prefix)) {
    throw new Error(
      `BLOCKFROST_API_KEY "${key.slice(0, 12)}..." does not match CARDANO_NETWORK "${net}". ` +
        `Key should start with "${prefix}...".`
    );
  }
}
