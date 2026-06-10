// src/constants.ts — GenMAGIC v3.3 Constants (ScheduleGen)
export const Q                   = 1_000_000_000n;
// SLOTS_PER_EPOCH removed — network-specific. Use slotsPerEpoch(network) / msPerEpoch(network)
// from @magiclamp/protocol-utils.
export const OIL_PER_LAMP        = 1_000_000n;
export const NANOGIC_PER_MAGIC   = 1_000_000_000n;
export const SNAPSHOT_BASE_RATE_Q = 5_000_000_000n;   // R_snap [Constitutional]

// ── S(L) segments (§11.3, §19.6) [Constitutional] ────────────
export const S_SEG1_INTERCEPT_Q = 1_500_000_000n;
export const S_SEG1_SLOPE_Q     = 10_000_000n;
export const S_SEG2_KNEE        = 50n;
export const S_SEG2_INTERCEPT_Q = 2_000_000_000n;
export const S_SEG2_SLOPE_Q     = 5_000_000n;
export const S_SEG3_KNEE        = 150n;
export const S_SEG3_INTERCEPT_Q = 2_500_000_000n;
export const S_SEG3_SLOPE_Q     = 2_500_000n;

// ── Schedule params (§19.6) ───────────────────────────────────
export const SCHEDULE_MIN_LENGTH     = 10n;           // [Significant]
export const SCHEDULE_MAX_LENGTH     = 200n;          // [Significant]
export const MIN_LAMP_PER_FIRE       = 1_000_000n;    // 1 LAMP [Routine]
export const SCHEDULE_DELAY          = 2n;             // epochs [Constitutional]
export const SCHEDULE_DECAY_WINDOW   = 1n;             // cliff [Constitutional]
export const MAX_FIRES_PER_TX_CATCHUP = 8;            // [Routine]
export const MAX_GEN_SCHEDULES       = 20;            // [Routine]
export const MAX_BATCHES_PER_VAULT   = 32;            // [Routine]
export const MAX_LOYALTY_HOLDINGS    = 64;            // [Routine]

// ── Shard [Constitutional] ────────────────────────────────────
export const SHARD_COUNT = 16;
export const SHARD_CAP   = 450_000_000_000_000n;      // 4.5×10^14 oil = 450M LAMP per shard
export const PARTICIPATION_CAP_BPS = 2000;            // 20% [Routine]

// ── Testnet config ────────────────────────────────────────────
export const TESTNET_CONFIG = {
  network:          "Preview" as const,
  blockfrostUrl:    "https://cardano-preview.blockfrost.io/api/v0",
  vaultScriptHash:  "REPLACE_WITH_VAULT_SCRIPT_HASH",
  shardScriptHash:  "REPLACE_WITH_SHARD_SCRIPT_HASH",
  lampPolicyId:     "REPLACE_WITH_LAMP_POLICY_ID",
  lampAssetName:    "744c414d50",   // "tLAMP"
  shardNftPolicyId: "REPLACE_WITH_SHARD_NFT_POLICY_ID",
  shardNftAssetName:"5348415244",  // "SHARD"
  treasuryAddress:  "REPLACE_WITH_TREASURY_ADDRESS",
};
