// scripts/config.ts — Shared testnet config
// Điền vào sau khi hoàn thành từng bước deploy
// KHÔNG commit file này nếu chứa private key thật

import "dotenv/config";
import { slotsPerEpoch, msPerEpoch, type Network } from "@magiclamp/protocol-utils";
import type { LucidEvolution } from "@lucid-evolution/lucid";

// ── Network ───────────────────────────────────────────────────
export const NETWORK: Network = (process.env.NETWORK ?? "Preview") as Network;
export const BLOCKFROST_URL = `https://cardano-${NETWORK.toLowerCase()}.blockfrost.io/api/v0`;
export const BLOCKFROST_KEY = process.env.BLOCKFROST_KEY ?? "";
export const PRIVATE_KEY    = process.env.PRIVATE_KEY ?? "";
export const WALLET_SEED    = (process.env.WALLET_SEED ?? "").trim().replace(/\s+/g, " ");

if (!BLOCKFROST_KEY)              throw new Error("BLOCKFROST_KEY missing in .env");
if (!PRIVATE_KEY && !WALLET_SEED) throw new Error("Either PRIVATE_KEY or WALLET_SEED required in .env");

/** Select wallet from whichever credential is available. CRLF-safe for Windows. */
export function selectWallet(lucid: LucidEvolution): void {
  if (PRIVATE_KEY)      lucid.selectWallet.fromPrivateKey(PRIVATE_KEY);
  else if (WALLET_SEED) lucid.selectWallet.fromSeed(WALLET_SEED);
}

// ── Script hashes (điền sau khi aiken build) ──────────────────
// Lấy từ: cat [Module]/onchain/plutus.json | jq '.validators[0].hash'
export const SCRIPT_HASHES = {
  vault_instant:   process.env.VAULT_INSTANT_HASH   ?? "FILL_AFTER_AIKEN_BUILD",
  vault_snapshot:  process.env.VAULT_SNAPSHOT_HASH  ?? "FILL_AFTER_AIKEN_BUILD",
  vault_vacuum:    process.env.VAULT_VACUUM_HASH     ?? "FILL_AFTER_AIKEN_BUILD",
  vault_schedule:  process.env.VAULT_SCHEDULE_HASH  ?? "FILL_AFTER_AIKEN_BUILD",
  shard:           process.env.SHARD_HASH           ?? "FILL_AFTER_AIKEN_BUILD",
  um_datum:        process.env.UM_DATUM_HASH        ?? "FILL_AFTER_AIKEN_BUILD",
};

// ── Token policy IDs (điền sau khi mint) ─────────────────────
export const POLICY_IDS = {
  lamp:     process.env.LAMP_POLICY_ID     ?? "FILL_AFTER_MINT",
  um_nft:   process.env.UM_NFT_POLICY_ID   ?? "FILL_AFTER_DEPLOY_UM",
  shard_nft:process.env.SHARD_NFT_POLICY_ID ?? "FILL_AFTER_DEPLOY_SHARDS",
};

// ── Asset names (hex) ─────────────────────────────────────────
// LAMP asset name is applied as a validator parameter (vault takes
// lamp_asset_name) — not a hardcoded literal — so the on-chain value check
// reads whatever asset the network's LAMP is minted under. Canonical = tLAMP
// 744c414d50 (Genesis/Faucet); env-overridable per deploy.
export const ASSET_NAMES = {
  lamp:      process.env.LAMP_ASSET_NAME ?? "744c414d50", // "tLAMP" — canonical
  um_nft:    "554d44",     // "UMD"
  shard_nft: "5348415244", // "SHARD"
};

// ── Addresses (điền sau khi deploy) ──────────────────────────
export const ADDRESSES = {
  treasury: process.env.TREASURY_ADDRESS ?? "FILL_AFTER_DEPLOY",
};

// ── Protocol constants ───────────────────────────────────────
// SLOTS_PER_EPOCH is network-specific — derived from NETWORK env at runtime.
// Mainnet=432_000, Preview/Preprod=86_400 (1 day).
export const PROTOCOL = {
  SHARD_COUNT:     16,
  SHARD_CAP:       450_000_000_000_000n,  // 4.5×10^14 oildrop = 450M LAMP
  SLOTS_PER_EPOCH: slotsPerEpoch(NETWORK),
  MS_PER_EPOCH:    msPerEpoch(NETWORK),    // = slots_per_epoch × 1000 (slot_length 1s)
  Q:               1_000_000_000n,
};

// ── Helpers ───────────────────────────────────────────────────
export function toUnit(policyId: string, assetName: string): string {
  return policyId + assetName;
}

export function lampToOildrop(lamp: bigint): bigint {
  return lamp * 1_000_000n;
}
