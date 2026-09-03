// src/constants.ts — hằng giao thức (TypeScript). Phải trùng BIT với constants.ak.
// All values from §19. MUST match onchain/lib/constants.ak exactly (P8).

// ── Precision ────────────────────────────────────────────────
export const Q = 1_000_000_000n; // Q = 10^9 [Immutable]

// ── Cardano epoch ────────────────────────────────────────────
// SLOTS_PER_EPOCH is network-specific — use slotsPerEpoch(network) / msPerEpoch(network)
// from @magiclamp/protocol-utils instead of hardcoding.

// ── LAMP / MAGIC units ───────────────────────────────────────
export const LAMP_DECIMALS  = 6n;
export const MAGIC_DECIMALS = 9n;
export const OILDROP_PER_LAMP  = 1_000_000n;    // 10^6 oildrop per LAMP
export const NANOGIC_PER_MAGIC = 1_000_000_000n; // 10^9 nanogic per MAGIC

// ── MAGIC batch lifetime (§4.2 per-epoch use-or-lose) ────────
// [Constitutional] decay_window = 1 ⟹ a batch is LIVE only inside its own
// created_epoch; at created_epoch + 1 it is DEAD (cliff). No halving, no
// carry-over. MUST equal `magic_decay_window` in constants.ak.
export const MAGIC_DECAY_WINDOW   = 1n;
export const INSTANT_DECAY_WINDOW = MAGIC_DECAY_WINDOW;   // alias

// ── InstantGen — eligibility (§6.3) ──────────────────────────
// [Routine] LAMP that must SIT in the vault to open the door. Never moves.
export const MIN_INSTANT_HOLDING = 10_000_000n;      // 10 LAMP in oildrop

// ── InstantGen — magnitude (§6.3 keyed-consumed) ─────────────
// [Significant] rate applied to MAGIC ALREADY CONSUMED.
// INV-CASHBACK-BOUND: rate × UM_MAX × PM_MAX = 0.20 × 2.00 × 1.15 = 0.46 < 1
export const INSTANT_REWARD_RATE_Q = 200_000_000n;   // 0.20

// ── Surplus gate (§6.3 cap_surplus) ──────────────────────────
export const BR_SAFE_Q       = 1_500_000_000n;   // 1.5  [Constitutional]
export const F_CAP_SURPLUS_Q =   100_000_000n;   // 0.10 [Constitutional]
// [Significant] beyond this the backing beacon counts as ABSENT → cap = 0.
export const MAX_BACKING_STALE = 1n;

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
  lampAssetName:     "744c414d50", // "tLAMP" in hex
  umNftPolicyId:     "REPLACE_WITH_UM_NFT_POLICY_ID",
  umNftAssetName:    "554d44",   // "UMD" in hex

  // BackingBeacon (§6.3)  [CẦN XÁC NHẬN — chờ CARP]
  // All-zero policy/hash = "beacon not deployed": no reference input can match,
  // so InstantGen is SHUT. Never substitute a fabricated `br`.
  backingNftPolicyId: "00".repeat(28),
  backingScriptHash:  "00".repeat(28),
  backingNftAssetName: "425251",  // "BRQ" in hex
};
