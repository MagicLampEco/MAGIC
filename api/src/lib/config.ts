import "dotenv/config";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  port:    Number(process.env.PORT ?? 3000),
  host:    process.env.HOST ?? "0.0.0.0",
  env:     process.env.NODE_ENV ?? "development",

  database: {
    url: requireEnv("DATABASE_URL"),
  },

  redis: {
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
  },

  jwt: {
    secret: process.env.JWT_SECRET ?? "dev_secret_min_32_chars_padding_xx",
  },

  oracle: {
    secret: process.env.ORACLE_SECRET ?? "dev_oracle_secret",
  },

  blockfrost: {
    projectId: process.env.BLOCKFROST_PROJECT_ID ?? "",
    network:   process.env.BLOCKFROST_NETWORK ?? "preview",
  },

  order: {
    ttlSeconds: Number(process.env.ORDER_TTL_SECONDS ?? 900),
    lockTtlMs:  Number(process.env.LOCK_TTL_MS ?? 2000),
  },

  bank: {
    defaultBankCode:      process.env.DEFAULT_BANK_CODE      ?? "VCB",
    defaultAccountNumber: process.env.DEFAULT_ACCOUNT_NUMBER ?? "1234567890",
    defaultAccountName:   process.env.DEFAULT_ACCOUNT_NAME   ?? "CONG TY MAGICLAMP NETWORK",
    defaultMerchantName:  process.env.DEFAULT_MERCHANT_NAME  ?? "MAGICLAMP NETWORK",
  },

  baseUrl:      process.env.BASE_URL ?? "https://otc.magiclamp.network/api",
  apiKeyPrefix: process.env.API_KEY_PREFIX ?? "ent_",
} as const;
