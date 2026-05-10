// src/constants.ts — GenMAGIC v3.3 Protocol Constants (TypeScript)
// All values from §19. MUST match onchain/lib/constants.ak exactly (P8).

// ── Precision ────────────────────────────────────────────────
export const Q = 1_000_000_000n; // Q = 10^9 [Immutable]

// ── Cardano epoch ────────────────────────────────────────────
export const SLOTS_PER_EPOCH = 432_000n; // mainnet + preview testnet

// ── LAMP / MAGIC units ───────────────────────────────────────
export const LAMP_DECIMALS  = 6n;
export const MAGIC_DECIMALS = 9n;
export const OIL_PER_LAMP   = 1_000_000n;    // 10^6 oil per LAMP
export const NANOGIC_PER_MAGIC = 1_000_000_000n; // 10^9 nanogic per MAGIC

// ── InstantGen (§19.4) ───────────────────────────────────────
export const INSTANT_BASE_RATE_Q = 3_000_000_000n;   // [Constitutional]
export const MIN_INSTANT_PURCHASE = 10_000_000n;      // 10 LAMP in oil [Routine]
export const MAX_INSTANT_PURCHASE = 10_000_000_000_000n; // 10^13 oil [Routine]
export const INSTANT_DECAY_WINDOW = 2n;                // [Constitutional]

// ── UM (§19.7) ───────────────────────────────────────────────
export const UM_MIN_Q            = 500_000_000n;   // 0.5 [Constitutional]
export const UM_MAX_Q            = 2_000_000_000n; // 2.0 [Constitutional]
export const UM_MAX_STALENESS    = 1n;             // [Significant]
export const UM_FALLBACK_Q       = 500_000_000n;   // = UM_MIN_Q [Constitutional]
export const UM_SMOOTHING_WINDOW = 6n;             // [Significant]

// ── Profile multipliers PM_Q (§3.4, §19.1) ──────────────────
export const PM_Q: Record<string, bigint> = {
  Ember:   1_150_000_000n, // 1.15 [Routine]
  Flame:   1_050_000_000n, // 1.05 [Routine]
  Lantern: 1_000_000_000n, // 1.00 [Routine]
};

// ── Profile parameters (§3.1) ────────────────────────────────
export const PROFILE_PARAMS: Record<string, { B_Q: bigint; r: number; N: number }> = {
  Ember:   { B_Q: 1_300_000_000n, r: 3, N: 3 },
  Flame:   { B_Q: 1_100_000_000n, r: 2, N: 6 },
  Lantern: { B_Q: 1_000_000_000n, r: 1, N: 9 },
};

// ── System limits (§19.8) ────────────────────────────────────
export const MAX_BATCHES_PER_VAULT    = 32;
export const MAX_LOYALTY_HOLDINGS     = 64;
export const MAX_VACUUM_ORDERS        = 10;
export const MAX_GEN_SCHEDULES        = 20;
export const MAX_DELEGATION_APPS      = 5;
export const MAX_FIRES_PER_TX_CATCHUP = 8;

// ── Testnet asset names (update with actual policy IDs) ──────
export const TESTNET_CONFIG = {
  network:        "Preview" as const,
  blockfrostUrl:  "https://cardano-preview.blockfrost.io/api/v0",

  // Replace with actual deployed values after `aiken build`
  vaultScriptHash:   "REPLACE_WITH_VAULT_SCRIPT_HASH",
  lampPolicyId:      "REPLACE_WITH_LAMP_POLICY_ID",
  lampAssetName:     "4c414d50", // "LAMP" in hex
  umNftPolicyId:     "REPLACE_WITH_UM_NFT_POLICY_ID",
  umNftAssetName:    "554d44",   // "UMD" in hex
  treasuryAddress:   "REPLACE_WITH_TREASURY_ADDRESS",
};
