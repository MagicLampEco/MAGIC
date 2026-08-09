// scripts/deployParams.ts — bản đồ TÊN → GIÁ TRỊ cho từng validator.
//
// Đây là NƠI DUY NHẤT khai giá trị apply-param cho toàn bộ scripts/. Deploy
// script, verify_per_network.ts và check_param_names.ts đều gọi cùng các hàm
// dưới đây ⇒ không thể xảy ra chuyện "deploy sai, verify cũng sai y hệt nên
// đối chiếu thấy khớp".
//
// TÊN KHOÁ phải trùng từng ký tự với `parameters[].title` trong plutus.json
// (tức tên tham số trong `validator foo(...)` của Aiken). Thứ tự khai ở đây
// cũng phải trùng thứ tự blueprint — applyParams.ts cưỡng chế cả hai.
//
// Các hàm ở đây THUẦN: không đọc env, không đọc config.ts, không chạm mạng.
// Nhờ vậy check_param_names.ts chạy được mà không cần .env hay ví.

import { Constr, type Data } from "@lucid-evolution/lucid";
import type { ParamMap } from "./applyParams.js";

/** OutputReference của PlutusV3 = Constr 0 [transaction_id: Bytes, output_index: Int]. */
export function outputReferenceData(txHash: string, outputIndex: number | bigint): Data {
  return new Constr(0, [txHash, BigInt(outputIndex)]);
}

// ── InstantGen — vault.vault.{mint,spend} (7 tham số) ────────────
// Neo: InstantGen/onchain/validators/vault.ak — `validator vault(...)`.
export interface InstantVaultParamInputs {
  lampPolicyId:      string;
  lampAssetName:     string;  // PARAM theo mạng (tLAMP testnet / LAMP mainnet)
  umNftPolicy:       string;
  umScriptHash:      string;
  backingNftPolicy:  string;
  backingScriptHash: string;
  msPerEpoch:        bigint;
}

export function instantVaultParams(i: InstantVaultParamInputs): ParamMap {
  return {
    lamp_policy_id:      i.lampPolicyId,
    lamp_asset_name:     i.lampAssetName,
    um_nft_policy:       i.umNftPolicy,
    um_script_hash:      i.umScriptHash,
    backing_nft_policy:  i.backingNftPolicy,
    backing_script_hash: i.backingScriptHash,
    ms_per_epoch:        i.msPerEpoch,
  };
}

// ── ScheduleGen — vault.vault.{mint,spend} (4 tham số) ───────────
// Neo: ScheduleGen/onchain/validators/vault.ak.
export interface ScheduleVaultParamInputs {
  lampPolicyId:  string;
  lampAssetName: string;
  shardPolicyId: string;
  msPerEpoch:    bigint;
}

export function scheduleVaultParams(i: ScheduleVaultParamInputs): ParamMap {
  return {
    lamp_policy_id:  i.lampPolicyId,
    lamp_asset_name: i.lampAssetName,
    shard_policy_id: i.shardPolicyId,
    ms_per_epoch:    i.msPerEpoch,
  };
}

// ── ScheduleGen — vault.shard.spend (1 tham số) ──────────────────
export function shardSpendParams(i: { shardPolicyId: string }): ParamMap {
  return { shard_policy_id_param: i.shardPolicyId };
}

// ── UMKeeper — um_datum.um_datum_validator.spend (3 tham số) ─────
// Neo: UMKeeper/onchain/validators/um_datum.ak.
export interface UmDatumParamInputs {
  msPerEpoch: bigint;
  umPolicy:   string;   // policy id của NFT thẩm quyền UM (one-shot)
  umName:     string;   // asset name hex ("UMD")
}

export function umDatumParams(i: UmDatumParamInputs): ParamMap {
  return {
    ms_per_epoch: i.msPerEpoch,
    um_policy:    i.umPolicy,
    um_name:      i.umName,
  };
}

// ── Mọi minting policy one-shot (1 tham số: genesis_ref) ─────────
// Dùng chung cho um_nft, shard_nft, price_nft, engage_nft.
export function oneShotGenesisParams(i: {
  txHash: string; outputIndex: number | bigint;
}): ParamMap {
  return { genesis_ref: outputReferenceData(i.txHash, i.outputIndex) };
}

// ── ConsumeMAGIC — price_param.price_param.spend (5 tham số) ─────
// Neo: ConsumeMAGIC/onchain/validators/price_param.ak.
export interface PriceParamParamInputs {
  committee:      string[];   // List<ByteArray> pkh
  threshold:      bigint;
  priceNftPolicy: string;
  priceNftName:   string;
  msPerEpoch:     bigint;
}

export function priceParamParams(i: PriceParamParamInputs): ParamMap {
  return {
    committee:        i.committee,
    threshold:        i.threshold,
    price_nft_policy: i.priceNftPolicy,
    price_nft_name:   i.priceNftName,
    ms_per_epoch:     i.msPerEpoch,
  };
}

// ── ConsumeMAGIC — consume.consume.{mint,spend} (7 tham số) ──────
// Neo: ConsumeMAGIC/onchain/validators/consume.ak.
// Chuỗi bake TUYẾN TÍNH: price_nft → price_param → consume.
// `price_param_script_hash` là hash của price_param ĐÃ apply 5 tham số trên.
//
// KHÔNG có engage_nft_policy/engage_nft_name: consume nay là validator ĐA MỤC
// ĐÍCH — handler `mint` của chính nó là policy của thread token Engage, nên
// policy id = script hash của consume. Đưa nó vào tham số sẽ tạo vòng băm.
export interface ConsumeParamInputs {
  priceNftPolicy:       string;
  priceNftName:         string;
  vaultScriptHash:      string;
  burnBatchConstr:      bigint;
  maxPriceStale:        bigint;
  msPerEpoch:           bigint;
  priceParamScriptHash: string;
}

export function consumeParams(i: ConsumeParamInputs): ParamMap {
  return {
    price_nft_policy:        i.priceNftPolicy,
    price_nft_name:          i.priceNftName,
    vault_script_hash:       i.vaultScriptHash,
    burn_batch_constr:       i.burnBatchConstr,
    max_price_stale:         i.maxPriceStale,
    ms_per_epoch:            i.msPerEpoch,
    price_param_script_hash: i.priceParamScriptHash,
  };
}
