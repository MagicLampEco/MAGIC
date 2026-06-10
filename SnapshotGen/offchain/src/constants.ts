// src/constants.ts — GenMAGIC v3.3 Constants (SnapshotGen)
// MUST match onchain/lib/constants.ak exactly (P8).

export const Q = 1_000_000_000n;
// SLOTS_PER_EPOCH is network-specific — use slotsPerEpoch(network) from @magiclamp/protocol-utils
export const OIL_PER_LAMP      = 1_000_000n;
export const NANOGIC_PER_MAGIC = 1_000_000_000n;

// ── SnapshotGen (§19.1) ──────────────────────────────────────
export const SNAPSHOT_BASE_RATE_Q = 5_000_000_000n;  // [Constitutional]

// Profile parameters (§3.1)
export const PROFILE_PARAMS: Record<string, {
  B_Q : bigint; PM_Q: bigint; r: number; N: number;
}> = {
  Ember:   { B_Q: 1_300_000_000n, PM_Q: 1_150_000_000n, r: 3, N: 3 },
  Flame:   { B_Q: 1_100_000_000n, PM_Q: 1_050_000_000n, r: 2, N: 6 },
  Lantern: { B_Q: 1_000_000_000n, PM_Q: 1_000_000_000n, r: 1, N: 9 },
};

// ELV (§3.3)
export const ELV: Record<string, string> = {
  Ember: "2.19", Flame: "3.69", Lantern: "6.12",
};

// ── LF knees (§6.3, §19.2) ───────────────────────────────────
export const LF_CAP_AGE = 24n;   // LF = 1.50 for age > 24

// ── OAC (§6.4, §19.3) ────────────────────────────────────────
export const OAC_BASE_Q      = 800_000_000n;   // 0.80
export const OAC_INCREMENT_Q = 50_000_000n;    // 0.05
export const OAC_CAP_APPS    = 4;
export const DRM_LOOKBACK    = 12n;            // epochs

// ── System limits ────────────────────────────────────────────
export const MAX_BATCHES_PER_VAULT = 32;
export const MAX_LOYALTY_HOLDINGS  = 64;

// ── Testnet config (update after aiken build) ─────────────────
export const TESTNET_CONFIG = {
  network:          "Preview" as const,
  blockfrostUrl:    "https://cardano-preview.blockfrost.io/api/v0",
  vaultScriptHash:  "REPLACE_WITH_VAULT_SCRIPT_HASH",
  lampPolicyId:     "REPLACE_WITH_LAMP_POLICY_ID",
  lampAssetName:    "744c414d50",  // "tLAMP"
  treasuryAddress:  "REPLACE_WITH_TREASURY_ADDRESS",
};
