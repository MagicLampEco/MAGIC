// src/params.ts — apply-param của validator `vault` ScheduleGen Gen v2.0 (9 tham số).
//
// Thứ tự là hợp đồng: nó quyết định bytes ⟹ script hash ⟹ địa chỉ két. Nguồn duy nhất
// của thứ tự là chữ ký `validator vault(` trong `ScheduleGen/onchain/validators/vault.ak`;
// bài `ScheduleGen/tests/datumV2.test.ts` ▸ "apply-param" đọc chữ ký đó và so với
// `SCHEDULE_VAULT_PARAM_NAMES` bên dưới.
//
// Module này KHÔNG tự gọi `applyParamsToScript`: hàm đó không kiểm số lượng hay thứ tự
// tham số, sai một ô vẫn ra một hash hợp lệ và két khoá LAMP vĩnh viễn. Đường apply đúng
// là cổng theo TÊN ở `scripts/applyParams.ts` ▸ `appliedScript`, nó đối chiếu tên với
// blueprint. Ở đây chỉ dựng BẢN ĐỒ tên → giá trị theo đúng thứ tự để đưa vào cổng đó.

import type { Data } from "@lucid-evolution/lucid";

export const SCHEDULE_VAULT_PARAM_NAMES = [
  "lamp_policy_id",
  "lamp_asset_name",
  "shard_policy_id",
  "ms_per_epoch",
  "gb_beacon_nft_policy",
  "gb_beacon_script_hash",
  "gb_shard_policy_id",
  "rate_nft_policy",
  "rate_script_hash",
] as const;

export interface ScheduleVaultParams {
  lampPolicyId       : string;   // 28 byte hex
  lampAssetName      : string;   // hex — theo MẠNG (tLAMP testnet / LAMP mainnet)
  shardPolicyId      : string;   // policy NFT shard LAMP (`shard_nft.ak`)
  msPerEpoch         : bigint;
  gbBeaconNftPolicy  : string;   // policy NFT "GBB"
  gbBeaconScriptHash : string;   // script beacon GreenBack
  gbShardPolicyId    : string;   // = script hash `gb_shard`
  rateNftPolicy      : string;   // policy NFT "RHO"
  rateScriptHash     : string;   // script beacon ρ
}

function hex(name: string, v: string, bytes?: number): string {
  if (!/^([0-9a-f]{2})*$/.test(v)) throw new Error(`apply-param ${name}: không phải hex thường: "${v}"`);
  if (bytes !== undefined && v.length !== bytes * 2) {
    throw new Error(`apply-param ${name}: cần ${bytes} byte, nhận ${v.length / 2}`);
  }
  return v;
}

/** Bản đồ TÊN → giá trị Plutus Data, khoá theo đúng thứ tự `SCHEDULE_VAULT_PARAM_NAMES`. */
export function scheduleVaultParamMap(p: ScheduleVaultParams): Record<string, Data> {
  if (p.msPerEpoch <= 0n) throw new Error(`apply-param ms_per_epoch phải > 0, nhận ${p.msPerEpoch}`);
  const values: Record<(typeof SCHEDULE_VAULT_PARAM_NAMES)[number], Data> = {
    lamp_policy_id:        hex("lamp_policy_id", p.lampPolicyId, 28),
    lamp_asset_name:       hex("lamp_asset_name", p.lampAssetName),
    shard_policy_id:       hex("shard_policy_id", p.shardPolicyId, 28),
    ms_per_epoch:          p.msPerEpoch,
    gb_beacon_nft_policy:  hex("gb_beacon_nft_policy", p.gbBeaconNftPolicy, 28),
    gb_beacon_script_hash: hex("gb_beacon_script_hash", p.gbBeaconScriptHash, 28),
    gb_shard_policy_id:    hex("gb_shard_policy_id", p.gbShardPolicyId, 28),
    rate_nft_policy:       hex("rate_nft_policy", p.rateNftPolicy, 28),
    rate_script_hash:      hex("rate_script_hash", p.rateScriptHash, 28),
  };
  const out: Record<string, Data> = {};
  for (const n of SCHEDULE_VAULT_PARAM_NAMES) out[n] = values[n];
  return out;
}

/** Danh sách giá trị theo thứ tự apply (cho người cần mảng; vẫn nên đi qua cổng theo tên). */
export function scheduleVaultParamList(p: ScheduleVaultParams): Data[] {
  const m = scheduleVaultParamMap(p);
  return SCHEDULE_VAULT_PARAM_NAMES.map(n => m[n]!);
}
