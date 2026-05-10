// src/constants.ts — GenMAGIC v3.3 Constants (VacuumGen)
export const Q = 1_000_000_000n;
export const SLOTS_PER_EPOCH    = 432_000n;
export const OIL_PER_LAMP       = 1_000_000n;
export const NANOGIC_PER_MAGIC  = 1_000_000_000n;

// ── VacuumGen (§19.5) ────────────────────────────────────────
export const VBR_Q               = 500_000_000n;     // 0.5 [Significant]
export const MIN_VACUUM_AMOUNT   = 1_000_000n;        // 1 LAMP in oil [Routine]
export const MAX_VACUUM_ORDERS   = 10;
export const VACUUM_DELAY        = 2n;                // epochs [Constitutional]
export const VACUUM_DECAY_WINDOW = 1n;                // cliff [Constitutional]

// ── Streak Multiplier (§6.5) [Routine] ───────────────────────
export const SM_Q: Record<string, bigint> = {
  base:    1_000_000_000n,  // streak <3
  "3_5":   1_050_000_000n,  // streak 3-5
  "6_11":  1_100_000_000n,  // streak 6-11
  "12plus":1_200_000_000n,  // streak ≥12
};

// ── UM (§19.7) ───────────────────────────────────────────────
export const UM_MIN_Q = 500_000_000n;   // [Constitutional]
export const UM_MAX_Q = 2_000_000_000n; // [Constitutional]
// C-UM-7: VacuumFire always uses smoothed — no stale check

// ── System limits ────────────────────────────────────────────
export const MAX_BATCHES_PER_VAULT = 32;
export const MAX_LOYALTY_HOLDINGS  = 64;

// ── Testnet config ────────────────────────────────────────────
export const TESTNET_CONFIG = {
  network:          "Preview" as const,
  blockfrostUrl:    "https://cardano-preview.blockfrost.io/api/v0",
  vaultScriptHash:  "REPLACE_WITH_VAULT_SCRIPT_HASH",
  lampPolicyId:     "REPLACE_WITH_LAMP_POLICY_ID",
  lampAssetName:    "4c414d50",
  umNftPolicyId:    "REPLACE_WITH_UM_NFT_POLICY_ID",
  umNftAssetName:   "554d44",
  treasuryAddress:  "REPLACE_WITH_TREASURY_ADDRESS",
};
