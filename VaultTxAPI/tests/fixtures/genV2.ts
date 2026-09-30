// VaultTxAPI/tests/fixtures/genV2.ts — khối `gen_v2` của bản deploy + các UTxO beacon/shard
// Gen v2.0 trên chuỗi ghi sẵn.
//
// Mọi datum đi qua lược đồ THẬT của gói nền (`@magiclamp/instantgen-sdk` ▸ `RateParam`,
// `GreenBackBeacon`, `GbShard`, `VaultRegistry`) — lược đồ đổi hình là mẫu đổi theo.
// Địa chỉ dựng bằng `credentialToAddress` từ một script hash bịa nhưng ĐÚNG HÌNH DẠNG, để
// `config.ts` suy được script hash từ địa chỉ như với bản deploy thật.

import { Data, credentialToAddress, type UTxO } from "@lucid-evolution/lucid";
import {
  GREENBACK_NFT_NAME, GbShard, GreenBackBeacon, RATE_NFT_NAME, RateParam, VAULT_REGISTRY_NFT_NAME,
  VaultRegistry, shardNftName,
} from "@magiclamp/instantgen-sdk";

import { VAULT_SCRIPT_HASH } from "./preview.js";

export type GenNet = "Preprod" | "Preview";

export const RATE_SCRIPT_HASH = "a1".repeat(28);
export const RATE_NFT_POLICY = "a2".repeat(28);
export const GBB_SCRIPT_HASH = "b1".repeat(28);
export const GBB_NFT_POLICY = "b2".repeat(28);
export const GB_SHARD_POLICY = "c3".repeat(28);
export const REGISTRY_POLICY = "d4".repeat(28);
export const GB_SHARD_CAP_NANOGIC = 1_000_000_000_000_000n;

export const RATE_REF = `${"a9".repeat(32)}#0`;
export const COMMIT_REF = `${"44".repeat(32)}#3`;
export const GB_SHARD_REF = `${"45".repeat(32)}#4`;

export const addrOf = (net: GenNet, hash: string): string => credentialToAddress(net, { type: "Script", hash });

/** Khối JSON `gen_v2` của bản deploy. */
export function genV2Json(net: GenNet): Record<string, unknown> {
  return {
    rate_beacon_address: addrOf(net, RATE_SCRIPT_HASH),
    rate_nft_policy: RATE_NFT_POLICY,
    greenback_beacon_address: addrOf(net, GBB_SCRIPT_HASH),
    greenback_beacon_nft_policy: GBB_NFT_POLICY,
    gb_shard_address: addrOf(net, GB_SHARD_POLICY),
    gb_shard_cap_nanogic: GB_SHARD_CAP_NANOGIC.toString(),
    vault_registry_address: addrOf(net, REGISTRY_POLICY),
  };
}

export interface GenChainSpec {
  epoch: bigint;
  /** ρ (Q = 10⁹). Mặc định 1 nanogic MAGIC / 1 oildrop … theo gói nền — xem phép kiểm dùng nó. */
  rhoQ?: bigint;
  /** Bỏ beacon ρ khỏi chuỗi — ca "thiếu ρ". */
  noRate?: boolean;
  gbNanogic?: bigint;
  depeg?: boolean;
}

function u(txByte: string, idx: number, address: string, nft: string, datum: string): UTxO {
  return { txHash: txByte.repeat(32), outputIndex: idx, address, assets: { lovelace: 2_000_000n, [nft]: 1n }, datum };
}

/** UTxO theo địa chỉ: beacon ρ, beacon GB, sổ két, và đủ 16 shard GB (id 0..15). */
export function genV2Chain(net: GenNet, s: GenChainSpec): Record<string, UTxO[]> {
  const rate = u("a9", 0, addrOf(net, RATE_SCRIPT_HASH), RATE_NFT_POLICY + RATE_NFT_NAME,
    Data.to({ rho_q: s.rhoQ ?? 1_000_000_000n, prev_rho_q: s.rhoQ ?? 1_000_000_000n, effective_epoch: 0n }, RateParam));
  const gbb = u("b9", 0, addrOf(net, GBB_SCRIPT_HASH), GBB_NFT_POLICY + GREENBACK_NFT_NAME,
    Data.to({ gb_nanogic: s.gbNanogic ?? 16_000_000_000_000_000n, seq: 1n, epoch: s.epoch, depeg: s.depeg ?? false }, GreenBackBeacon));
  const reg = u("d9", 0, addrOf(net, REGISTRY_POLICY), REGISTRY_POLICY + VAULT_REGISTRY_NFT_NAME,
    Data.to({ vault_script_hashes: [VAULT_SCRIPT_HASH] }, VaultRegistry));
  const shards = Array.from({ length: 16 }, (_, i) => u("c9", i, addrOf(net, GB_SHARD_POLICY),
    GB_SHARD_POLICY + shardNftName(BigInt(i)),
    Data.to({ shard_id: BigInt(i), seq: 0n, reset_amount: 0n, remaining: 0n }, GbShard)));
  return {
    [addrOf(net, RATE_SCRIPT_HASH)]: s.noRate === true ? [] : [rate],
    [addrOf(net, GBB_SCRIPT_HASH)]: [gbb],
    [addrOf(net, REGISTRY_POLICY)]: [reg],
    [addrOf(net, GB_SHARD_POLICY)]: shards,
  };
}

/** Khoá thêm vào `ref_script_utxos` cho các đường Gen v2.0 (`commit` của ScheduleGen, `gb_shard`). */
export const GEN_V2_REF_SCRIPTS = { commit: COMMIT_REF, gb_shard: GB_SHARD_REF } as const;
