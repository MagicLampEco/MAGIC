// scripts/config.ts — Shared testnet config
// Điền vào sau khi hoàn thành từng bước deploy
// KHÔNG commit file này nếu chứa private key thật

import "dotenv/config";
import { slotsPerEpoch, msPerEpoch, lampAssetName, type Network } from "@magiclamp/protocol-utils";
import type { LucidEvolution } from "@lucid-evolution/lucid";
// Giới hạn shard là ràng buộc cưỡng chế on-chain — giữ MỘT nguồn duy nhất.
// Khai lại ở đây từng làm hai nơi có thể trôi khỏi nhau mà không test nào đỏ.
import { SHARD_COUNT, SHARD_CAP } from "../ScheduleGen/offchain/src/constants.js";

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
// SnapshotGen/VacuumGen đã dời sang Legacy/ (mô hình GenMAGIC v3.3,
// đã bỏ) — không còn hash nào cho hai module đó ở đây.
export const SCRIPT_HASHES = {
  vault_instant:   process.env.VAULT_INSTANT_HASH   ?? "FILL_AFTER_AIKEN_BUILD",
  vault_schedule:  process.env.VAULT_SCHEDULE_HASH  ?? "FILL_AFTER_AIKEN_BUILD",
  shard:           process.env.SHARD_HASH           ?? "FILL_AFTER_AIKEN_BUILD",
  um_datum:        process.env.UM_DATUM_HASH        ?? "FILL_AFTER_AIKEN_BUILD",
  // BackingBeacon script hash (§6.3)  [CẦN XÁC NHẬN — chờ CARP]
  // All-zero default = beacon not deployed ⟹ InstantGen SHUT (fail-closed).
  backing_beacon:  process.env.BACKING_SCRIPT_HASH  ?? "00".repeat(28),
};

// ── Token policy IDs (điền sau khi mint) ─────────────────────
export const POLICY_IDS = {
  lamp:     process.env.LAMP_POLICY_ID     ?? "FILL_AFTER_MINT",
  um_nft:   process.env.UM_NFT_POLICY_ID   ?? "FILL_AFTER_DEPLOY_UM",
  shard_nft:process.env.SHARD_NFT_POLICY_ID ?? "FILL_AFTER_DEPLOY_SHARDS",
  // BackingBeacon NFT (§6.3)  [CẦN XÁC NHẬN — chờ CARP]
  // Default = all-zero: no UTxO can carry a token under a zero policy, so the
  // InstantGen reference-input lookup fails and Gen stays SHUT (fail-closed).
  // Never replace this with a fabricated value to "make it run".
  backing:  process.env.BACKING_NFT_POLICY_ID ?? "00".repeat(28),
};

// ── Asset names (hex) ─────────────────────────────────────────
// LAMP asset name is applied as a validator parameter (vault takes
// lamp_asset_name) — not a hardcoded literal — so the on-chain value check
// reads whatever asset the network's LAMP is minted under.
// DERIVED FROM NETWORK (same rule as MS_PER_EPOCH below): Mainnet "LAMP",
// testnets "tLAMP". A testnet default here would silently bake a tLAMP vault
// on a mainnet deploy — the exact lock this param exists to prevent.
// LAMP_ASSET_NAME env only overrides for a non-canonical mint.
export const ASSET_NAMES = {
  lamp:      process.env.LAMP_ASSET_NAME ?? lampAssetName(NETWORK),
  um_nft:    "554d44",     // "UMD"
  shard_nft: "5348415244", // "SHARD"
  backing:   "425251",     // "BRQ" — BackingBeacon
};

// ── Addresses (điền sau khi deploy) ──────────────────────────
export const ADDRESSES = {
  treasury: process.env.TREASURY_ADDRESS ?? "FILL_AFTER_DEPLOY",
};

// ── Protocol constants ───────────────────────────────────────
//
// 🔴 HAI ĐỒNG HỒ, KHÔNG SUY RA NHAU. Đừng "sửa" cái này cho khớp cái kia.
//
//   SLOTS_PER_EPOCH — nhịp THẬT của chuỗi Cardano (Preview 86_400 / Preprod 432_000 /
//                     Mainnet 432_000). Chỉ dùng khi phải diễn giải slot thật.
//                     KHÔNG đi vào apply-param của validator nào.
//   MS_PER_EPOCH    — nhịp của GIAO THỨC, và là apply-param #4 của mọi vault validator
//                     (xem `deployParams.ts`). Preprod cố tình KHÁC nhịp mạng.
//
// Công thức `ms_per_epoch = slots_per_epoch × 1000` từng đứng ở đúng dòng này và nó
// SAI: nó đúng cho Preview và Mainnet, sai cho Preprod. Ai áp lại công thức đó rồi
// chỉnh `MS_PER_EPOCH_BY_NETWORK` cho "khớp" sẽ đổi apply-param ⟹ đổi script hash ⟹
// đổi địa chỉ vault ⟹ mọi thứ đang sống trên Preprod (`scripts/DEPLOYED.md` §Preprod:
// vault `94c0c8b2…`, UM `c81d0a41…`) thành mồ côi, không ai spend được nữa.
// Nguồn duy nhất của hai bảng: `ProtocolUtils/src/index.ts` — đọc ghi chú ở đó trước
// khi đụng bất cứ con số nào.
export const PROTOCOL = {
  SHARD_COUNT,                            // ← ScheduleGen/offchain/src/constants.ts
  SHARD_CAP,                              // ← nt. (4.5×10^14 oildrop = 450M LAMP)
  SLOTS_PER_EPOCH: slotsPerEpoch(NETWORK), // nhịp chuỗi — hiện KHÔNG call site nào
  MS_PER_EPOCH:    msPerEpoch(NETWORK),    // nhịp giao thức — apply-param, 26 call site
  Q:               1_000_000_000n,
};

// ── Helpers ───────────────────────────────────────────────────
export function toUnit(policyId: string, assetName: string): string {
  return policyId + assetName;
}

export function lampToOildrop(lamp: bigint): bigint {
  return lamp * 1_000_000n;
}
