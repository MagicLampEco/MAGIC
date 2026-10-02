// src/vaultScript.ts — apply-param của validator két InstantGen Gen v2.0.
//
// Thứ tự apply-param = chữ ký `validator vault(...)` trong
// `InstantGen/onchain/validators/vault.ak` (10 tham số; `window_origin_ms` CUỐI CÙNG theo
// `LAMP/Specs/Window/CONTRACT.md` v1.0). Blueprint do `aiken build` sinh ở
// `InstantGen/onchain/plutus.json` (artifact, gitignore) khai cùng danh sách trong
// `validators[].parameters[]` — bài kiểm `tests/vaultParams.test.ts` đối chiếu THEO TÊN.
//
// Apply-param là tham số lúc BIÊN DỊCH: đổi một giá trị = đổi hash két = đổi địa chỉ
// (BOUNDARIES §2). Hai tham số UM/backing của đời v1 đã bị BỎ; bốn tham số GreenBack/ρ
// thế chỗ.

import { applyParamsToScript, type Validator } from "@lucid-evolution/lucid";

/** Đường tương đối (từ gốc gói `InstantGen/offchain`) tới blueprint `aiken build`. */
export const INSTANT_BLUEPRINT_PATH = "../onchain/plutus.json";

/** Tiêu đề validator vault trong blueprint (mint/spend dùng chung một mã biên dịch). */
export const INSTANT_VAULT_SPEND_TITLE = "vault.vault.spend";

export interface InstantVaultParams {
  /** #0 policy LAMP của mạng. */
  lampPolicyId       : string;
  /** #1 asset name LAMP của mạng (hex) — `tLAMP` testnet, `LAMP` mainnet. */
  lampAssetName      : string;
  /** #2 policy NFT beacon GreenBack ("GBB"). */
  gbBeaconNftPolicy  : string;
  /** #3 hash script `greenback_beacon`. */
  gbBeaconScriptHash : string;
  /** #4 hash script `gb_shard` (= policy NFT shard, mint gộp trong validator). */
  gbShardPolicyId    : string;
  /** #5 policy NFT beacon ρ ("RHO"). */
  rateNftPolicy      : string;
  /** #6 hash script `rate_param`. */
  rateScriptHash     : string;
  /** #7 hash script két Wakeme (chỉ đọc qua reference input). */
  wakemeVaultHash    : string;
  /** #8 POSIX ms mỗi epoch giao thức (độ dài). */
  msPerEpoch         : bigint;
  /** #9 gốc cửa sổ POSIX ms — `@magiclamp/protocol-utils` ▸ `windowOriginMs(network)`. */
  windowOriginMs     : bigint;
}

/** Tên tham số theo đúng thứ tự blueprint — bài kiểm so với `parameters[].title`. */
export const INSTANT_VAULT_PARAM_TITLES = [
  "lamp_policy_id",
  "lamp_asset_name",
  "gb_beacon_nft_policy",
  "gb_beacon_script_hash",
  "gb_shard_policy_id",
  "rate_nft_policy",
  "rate_script_hash",
  "wakeme_vault_hash",
  "ms_per_epoch",
  "window_origin_ms",
] as const;

function hash28(name: string, v: string): string {
  if (!/^[0-9a-f]{56}$/.test(v)) throw new Error(`INSTANT_VAULT_PARAM: ${name} phải là 28 byte hex thường, nhận "${v}".`);
  return v;
}

/** Danh sách 10 apply-param theo thứ tự validator. Sai dạng ⟹ NÉM trước khi apply. */
export function instantVaultParamList(p: InstantVaultParams): [string, string, string, string, string, string, string, string, bigint, bigint] {
  if (!/^([0-9a-f]{2}){0,32}$/.test(p.lampAssetName)) {
    throw new Error(`INSTANT_VAULT_PARAM: lampAssetName phải là hex ≤ 32 byte, nhận "${p.lampAssetName}".`);
  }
  if (typeof p.msPerEpoch !== "bigint" || p.msPerEpoch <= 0n) {
    throw new Error(`INSTANT_VAULT_PARAM: msPerEpoch phải là bigint > 0.`);
  }
  if (typeof p.windowOriginMs !== "bigint" || p.windowOriginMs < 0n) {
    throw new Error(`INSTANT_VAULT_PARAM: windowOriginMs phải là bigint ≥ 0.`);
  }
  return [
    hash28("lampPolicyId", p.lampPolicyId),
    p.lampAssetName,
    hash28("gbBeaconNftPolicy", p.gbBeaconNftPolicy),
    hash28("gbBeaconScriptHash", p.gbBeaconScriptHash),
    hash28("gbShardPolicyId", p.gbShardPolicyId),
    hash28("rateNftPolicy", p.rateNftPolicy),
    hash28("rateScriptHash", p.rateScriptHash),
    hash28("wakemeVaultHash", p.wakemeVaultHash),
    p.msPerEpoch,
    p.windowOriginMs,
  ];
}

/** Validator két InstantGen đã apply 10 tham số, từ `compiledCode` chưa apply của blueprint. */
export function applyInstantVaultParams(unappliedCompiledCode: string, p: InstantVaultParams): Validator {
  return { type: "PlutusV3", script: applyParamsToScript(unappliedCompiledCode, instantVaultParamList(p)) };
}
