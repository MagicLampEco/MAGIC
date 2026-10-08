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
// `window_origin_ms` (LAMP/Specs/Window/CONTRACT.md v1.0) là apply-param CUỐI CÙNG của mọi
// validator nhận `ms_per_epoch`. Người gọi lấy giá trị từ `@magiclamp/protocol-utils` ▸
// `windowOriginMs(network)` — nguồn duy nhất, Preview ném `WIN-PREVIEW`. Không gõ số ở đây.
//
// Các hàm ở đây THUẦN: không đọc env, không đọc config.ts, không chạm mạng.
// Nhờ vậy check_param_names.ts chạy được mà không cần .env hay ví.

import { Constr, type Data, type Validator } from "@lucid-evolution/lucid";
import { assertWakemeVaultHash } from "@magiclamp/protocol-utils";
import { appliedScript, findValidator, type Blueprint, type ParamMap } from "./applyParams.js";
import type { GEN_V2_STATE_KEYS, PREPAID_STATE_KEYS } from "./gen_vault_tx_api_deployment.js";

/** OutputReference của PlutusV3 = Constr 0 [transaction_id: Bytes, output_index: Int]. */
export function outputReferenceData(txHash: string, outputIndex: number | bigint): Data {
  return new Constr(0, [txHash, BigInt(outputIndex)]);
}

/**
 * `cardano/address.Address` = Constr 0 [payment_credential, stake_credential].
 *   payment_credential : VerificationKey → Constr 0 [hash] · Script → Constr 1 [hash]
 *   stake_credential   : None → Constr 1 [] · Some(Inline(cred)) → Constr 0 [Constr 0 [cred]]
 *
 * CẨN THẬN — đây là đẳng thức CẤU TRÚC, không phải so chuỗi bech32.
 * Một validator lọc output bằng `o.address == <apply-param Address>` mà nhận bản
 * KHÔNG stake của một ví có stake part sẽ không bao giờ khớp: không output nào lọt
 * qua bộ lọc, và mọi giao dịch đi qua phép so đó bị từ chối. Hai địa chỉ "nhìn
 * giống nhau" trong ví vẫn là hai giá trị Plutus Data khác nhau.
 */
export function addressData(
  payment: { hash: string; isScript: boolean },
  stake?:  { hash: string; isScript: boolean },
): Data {
  const cred = (c: { hash: string; isScript: boolean }) =>
    new Constr(c.isScript ? 1 : 0, [c.hash]);
  return new Constr(0, [
    cred(payment),
    stake ? new Constr(0, [new Constr(0, [cred(stake)])]) : new Constr(1, []),
  ]);
}

// ── Gen v2.0 — tham chiếu cụm GenBeacons đọc từ sổ trạng thái ─────
//
// Năm apply-param beacon của két Instant và của `commit` ScheduleGen đều là HASH SCRIPT
// của cụm GenBeacons mà bước 11 ghi vào sổ. Mỗi beacon là validator đa mục đích (handler
// `mint` nằm trong chính nó), nên policy NFT = script hash theo định nghĩa: một khoá sổ
// cho cả hai ô. Nguồn của nghĩa từng khoá: `gen_vault_tx_api_deployment.ts` ▸
// `GEN_V2_STATE_KEYS` — kiểu của nó ghim tên khoá dưới đây, đổi tên ở nguồn là gãy lúc
// typecheck, không gãy lúc deploy.
//
// Hàm THUẦN: nơi gọi truyền `process.env` (hoặc một sổ đã phân tích) vào. Thiếu khoá ⟹ NÉM,
// kể ĐỦ mọi khoá thiếu trong một lượt, KHÔNG đệm. Một hash đệm vẫn apply ra một két "hợp
// lệ" — chỉ là két đó tra một beacon không tồn tại, vĩnh viễn.
//
// KHÔNG đọc `VAULT_REGISTRY_HASH`: không két nào bake nó (sổ két được đúc SAU két, với hash
// các két — `11_deploy_gen_beacons.ts` pha `registry`), và `GB_SHARD_CAP_NANOGIC` thì bước
// 11 tự đối chiếu với hằng két.
type GenV2StateKey = keyof typeof GEN_V2_STATE_KEYS;
const GEN_V2_VAULT_KEYS = ["RATE_PARAM_HASH", "GREENBACK_BEACON_HASH", "GB_SHARD_HASH"] as const satisfies readonly GenV2StateKey[];

export interface GenV2BeaconRefs {
  gbBeaconNftPolicy:  string;   // = GREENBACK_BEACON_HASH (NFT "GBB")
  gbBeaconScriptHash: string;   // = GREENBACK_BEACON_HASH (địa chỉ beacon)
  gbShardPolicyId:    string;   // = GB_SHARD_HASH (NFT "GBS"‖id)
  rateNftPolicy:      string;   // = RATE_PARAM_HASH (NFT "RHO")
  rateScriptHash:     string;   // = RATE_PARAM_HASH (địa chỉ beacon ρ)
}

export function genV2BeaconRefsFromBook(book: Readonly<Record<string, string | undefined>>): GenV2BeaconRefs {
  const missing = GEN_V2_VAULT_KEYS.filter((k) => !book[k]);
  if (missing.length > 0) {
    throw new Error(
      `Sổ trạng thái thiếu ${missing.join(", ")} — chạy \`deploy/11_deploy_gen_beacons.ts\` ` +
      `(GEN_BEACONS_PHASE=beacons) rồi nạp lại sổ. Két Gen v2.0 nướng các hash đó vào apply-param.`,
    );
  }
  const bad = GEN_V2_VAULT_KEYS.filter((k) => !/^[0-9a-f]{56}$/.test(book[k]!));
  if (bad.length > 0) {
    throw new Error(`Sổ trạng thái: ${bad.map((k) => `${k}="${book[k]}"`).join(", ")} không phải 28 byte hex thường.`);
  }
  const rate = book.RATE_PARAM_HASH!, gbb = book.GREENBACK_BEACON_HASH!, gbShard = book.GB_SHARD_HASH!;
  return {
    gbBeaconNftPolicy: gbb, gbBeaconScriptHash: gbb, gbShardPolicyId: gbShard,
    rateNftPolicy: rate, rateScriptHash: rate,
  };
}

function hash28(fn: string, name: string, v: string): string {
  if (!/^[0-9a-f]{56}$/.test(v)) throw new Error(`${fn}: ${name} phải là 28 byte hex thường, nhận "${v}".`);
  return v;
}

// ── InstantGen — vault.vault.{mint,spend} (10 tham số, Gen v2.0 + gốc cửa sổ) ──
// Neo: InstantGen/onchain/validators/vault.ak — `validator vault(...)`. Gương của gói nền:
// `InstantGen/offchain/src/vaultScript.ts` ▸ `INSTANT_VAULT_PARAM_TITLES`; bài
// `test_deploy_gen_v2.ts` so hash của hàm này với `applyInstantVaultParams` cho cùng đầu vào.
//
// `lamp_asset_name` (#2) theo MẠNG nằm GIỮA, và `wakeme_vault_hash` (#8) cũng vậy — không ô
// theo mạng nào nằm cuối, nên bỏ sót một ô là dịch cả dãy chứ không "thiếu tham số cuối".
// UM + BackingBeacon của đời v1 đã rời két (v2.0 đọc beacon ρ + GreenBack thay thế).
export interface InstantVaultParamInputs extends GenV2BeaconRefs {
  lampPolicyId:      string;
  lampAssetName:     string;  // PARAM theo mạng (tLAMP testnet / LAMP mainnet)
  wakemeVaultHash:   string;  // PARAM theo mạng — két Wakeme
  msPerEpoch:        bigint;
  windowOriginMs:    bigint;  // PARAM theo mạng — gốc cửa sổ, tham số CUỐI
}

export function instantVaultParams(i: InstantVaultParamInputs): ParamMap {
  const fn = "instantVaultParams";
  return {
    lamp_policy_id:        hash28(fn, "lampPolicyId", i.lampPolicyId),
    lamp_asset_name:       i.lampAssetName,
    gb_beacon_nft_policy:  hash28(fn, "gbBeaconNftPolicy", i.gbBeaconNftPolicy),
    gb_beacon_script_hash: hash28(fn, "gbBeaconScriptHash", i.gbBeaconScriptHash),
    gb_shard_policy_id:    hash28(fn, "gbShardPolicyId", i.gbShardPolicyId),
    rate_nft_policy:       hash28(fn, "rateNftPolicy", i.rateNftPolicy),
    rate_script_hash:      hash28(fn, "rateScriptHash", i.rateScriptHash),
    // Dạng 56 hex thường, sai ⟹ ném. Kiểm ở đây vì mọi đường apply (deploy, test,
    // cổng đối chiếu) đều đi qua hàm này.
    wakeme_vault_hash:     assertWakemeVaultHash(i.wakemeVaultHash, fn),
    ms_per_epoch:          i.msPerEpoch,
    window_origin_ms:      i.windowOriginMs,
  };
}

// ── ScheduleGen — cặp `commit` (withdraw-zero) + két (Gen v2.0) ──
// Neo: ScheduleGen/onchain/validators/vault.ak — `validator commit(` (10 tham số) và
// `validator vault(` (7 tham số) — cả hai có `window_origin_ms` ở CUỐI. Gương gói nền: `ScheduleGen/offchain/src/params.ts` ▸
// `applyScheduleScripts`.
//
// THỨ TỰ APPLY MỘT CHIỀU:
//   commit(10) → commit_script_hash → vault(…, commit_script_hash) → vault_script_hash → shard(…)
// `commit` KHÔNG nhận hash két (nó biết két qua redeemer), nên chuỗi không khép. Dùng
// `scheduleScriptPair` dưới đây thay vì tự apply từng nửa: nửa sau cần ĐÚNG hash của nửa đầu
// ĐÃ apply, và một hash của bản chưa apply cũng là 28 byte hex hợp lệ.
export interface ScheduleScriptParamInputs extends GenV2BeaconRefs {
  lampPolicyId:  string;
  lampAssetName: string;
  shardPolicyId: string;
  msPerEpoch:    bigint;
  windowOriginMs: bigint;   // PARAM theo mạng — tham số CUỐI của cả `commit` lẫn két
}

export function scheduleCommitParams(i: ScheduleScriptParamInputs): ParamMap {
  const fn = "scheduleCommitParams";
  return {
    lamp_policy_id:        hash28(fn, "lampPolicyId", i.lampPolicyId),
    lamp_asset_name:       i.lampAssetName,
    shard_policy_id:       hash28(fn, "shardPolicyId", i.shardPolicyId),
    ms_per_epoch:          i.msPerEpoch,
    gb_beacon_nft_policy:  hash28(fn, "gbBeaconNftPolicy", i.gbBeaconNftPolicy),
    gb_beacon_script_hash: hash28(fn, "gbBeaconScriptHash", i.gbBeaconScriptHash),
    gb_shard_policy_id:    hash28(fn, "gbShardPolicyId", i.gbShardPolicyId),
    rate_nft_policy:       hash28(fn, "rateNftPolicy", i.rateNftPolicy),
    rate_script_hash:      hash28(fn, "rateScriptHash", i.rateScriptHash),
    window_origin_ms:      i.windowOriginMs,
  };
}

export interface ScheduleVaultParamInputs {
  lampPolicyId:     string;
  lampAssetName:    string;
  shardPolicyId:    string;
  msPerEpoch:       bigint;
  gbShardPolicyId:  string;
  commitScriptHash: string;   // hash của `commit` ĐÃ apply 10 tham số
  windowOriginMs:   bigint;
}

export function scheduleVaultParams(i: ScheduleVaultParamInputs): ParamMap {
  const fn = "scheduleVaultParams";
  return {
    lamp_policy_id:     hash28(fn, "lampPolicyId", i.lampPolicyId),
    lamp_asset_name:    i.lampAssetName,
    shard_policy_id:    hash28(fn, "shardPolicyId", i.shardPolicyId),
    ms_per_epoch:       i.msPerEpoch,
    gb_shard_policy_id: hash28(fn, "gbShardPolicyId", i.gbShardPolicyId),
    commit_script_hash: hash28(fn, "commitScriptHash", i.commitScriptHash),
    window_origin_ms:   i.windowOriginMs,
  };
}

export interface ScheduleScriptPair {
  commitScript: Validator; commitHash: string;
  vaultScript:  Validator; vaultHash:  string;
}

/** Apply cặp `commit` → két theo đúng thứ tự, qua cổng TÊN của `applyParams.ts`. Thuần:
 *  nhận blueprint đã nạp (`loadBlueprint("ScheduleGen")`), không đọc đĩa hay env. */
export function scheduleScriptPair(bp: Blueprint, i: ScheduleScriptParamInputs): ScheduleScriptPair {
  const commit = appliedScript(findValidator(bp, "vault.commit.withdraw"), scheduleCommitParams(i));
  const vault = appliedScript(findValidator(bp, "vault.vault.spend"), scheduleVaultParams({
    lampPolicyId: i.lampPolicyId, lampAssetName: i.lampAssetName, shardPolicyId: i.shardPolicyId,
    msPerEpoch: i.msPerEpoch, gbShardPolicyId: i.gbShardPolicyId, commitScriptHash: commit.hash,
    windowOriginMs: i.windowOriginMs,
  }));
  return { commitScript: commit.script, commitHash: commit.hash, vaultScript: vault.script, vaultHash: vault.hash };
}

// ── ScheduleGen — vault.shard.spend (2 tham số) ──────────────────
//
// `vault_script_hash` là tham số #2 từ 2026-09-07. `shard` không tự phán xét delta
// sổ cái shard — nó chỉ chứng minh trong cùng giao dịch có một vault THẬT đang bị
// tiêu. Trước đó "thật" được định nghĩa bằng hình dạng datum, thứ người gửi tự đặt,
// nên nó không định nghĩa gì; tham số này là vế ghim địa chỉ.
//
// THỨ TỰ APPLY MỘT CHIỀU, không có vòng:
//   shard_nft(genesis_ref) → shard_policy_id → vault(…) → vault_script_hash → shard(…)
// Vault KHÔNG nhận hash của shard, nên chuỗi không khép. Ai đảo thứ tự này sẽ cần
// hash vault trước khi có nó và phải dựng ra một giá trị giữ chỗ — đó là đường đi
// tới một hash trông hợp lệ mà sai.
export function shardSpendParams(
  i: { shardPolicyId: string; vaultScriptHash: string },
): ParamMap {
  return {
    shard_policy_id_param: i.shardPolicyId,
    vault_script_hash:     i.vaultScriptHash,
  };
}

// ── PrepaidGen — prepaid.paid_fund.{mint,spend} (5 tham số) ──────
// Neo: PrepaidGen/onchain/validators/prepaid.ak — `validator paid_fund(...)`.
//
// `paid_fund` KHÔNG nhận hash của vault. Đó là điều kiện làm chuỗi apply MỘT
// CHIỀU và không khép vòng:
//
//   paid_fund(carp…) → paid_fund_hash → prepaid_vault(carp…, paid_fund_hash, …)
//
// Chiều ngược — quỹ ghim được vault thật lúc quyết toán — KHÔNG đi qua tham số
// biên dịch mà qua `PaidFundDatum.vault_hash`, ghim tại genesis bởi handler
// `mint` của chính `paid_fund` rồi bất biến. Ai đảo thứ tự này sẽ cần hash của
// vault trước khi nó tồn tại, và lối thoát duy nhất là dựng một giá trị giữ chỗ —
// đó là đường đi tới một script hash trông hợp lệ mà sai vĩnh viễn.
//
// KHÔNG có `fund_nft_policy`: handler `mint` nằm trong chính `paid_fund`, nên
// policy id của NFT quỹ BẰNG script hash của quỹ theo định nghĩa. Trước
// 2026-09-15 đó là hai apply-param độc lập, và hai giá trị song song thì lệch
// được — đúng lớp lỗi mà `BOUNDARIES.md §5` gọi là bài học đắt nhất của kho.
//
// `wakeme_vault_hash` (#5, CUỐI — thêm 2026-10-04, nhánh `FundReclaim`): script hash
// két Wakeme mà quỹ tài trợ đòi đồng-tiêu bằng `ReclaimEpoch`. MỘT hash cho mọi DID ⟹
// đổi theo bản deploy Wakeme của mạng; nguồn `@magiclamp/protocol-utils` ▸
// `wakemeVaultHash(network)`. Đổi nó ⟹ đổi hash quỹ ⟹ đổi hash két Prepaid theo.
export interface PaidFundParamInputs {
  carpPolicyId:  string;
  carpAssetName: string;
  msPerEpoch:    bigint;
  windowOriginMs: bigint;
  wakemeVaultHash: string;  // PARAM theo mạng — két Wakeme, tham số CUỐI
}

export function paidFundParams(i: PaidFundParamInputs): ParamMap {
  return {
    carp_policy_id:   i.carpPolicyId,
    carp_asset_name:  i.carpAssetName,
    ms_per_epoch:     i.msPerEpoch,
    window_origin_ms: i.windowOriginMs,
    wakeme_vault_hash: assertWakemeVaultHash(i.wakemeVaultHash, "paidFundParams"),
  };
}

// ── PrepaidGen — prepaid.prepaid_vault.{mint,spend} (5 tham số) ──
// Neo: PrepaidGen/onchain/validators/prepaid.ak — `validator prepaid_vault(...)`.
//
// `paid_fund_hash` là hash của `paid_fund` ĐÃ apply đúng năm tham số trên. Truyền
// hash của bản CHƯA apply cũng ra 28 byte hex hợp lệ và cũng deploy êm — và vault
// sinh ra sẽ từ chối mọi quỹ thật, vĩnh viễn.
//
// `carp_asset_name` nằm GIỮA `carp_policy_id` và `paid_fund_hash`. Bỏ sót nó
// không phải là "thiếu tham số cuối": nó ĐẨY `paid_fund_hash` vào đúng chỗ của
// asset name và `ms_per_epoch` vào chỗ của `paid_fund_hash`. Ba giá trị vẫn là
// hex hợp lệ, `applyParamsToScript` không kiểm arity, và hash thu được trông
// bình thường — cùng hình dạng với `lamp_asset_name` trong `instantVaultParams`
// ở trên, nơi một tham số THEO MẠNG cũng nằm GIỮA chứ không nằm cuối.
export interface PrepaidVaultParamInputs {
  carpPolicyId:  string;
  carpAssetName: string;
  paidFundHash:  string;
  msPerEpoch:    bigint;
  windowOriginMs: bigint;
}

export function prepaidVaultParams(i: PrepaidVaultParamInputs): ParamMap {
  return {
    carp_policy_id:  i.carpPolicyId,
    carp_asset_name: i.carpAssetName,
    paid_fund_hash:   i.paidFundHash,
    ms_per_epoch:     i.msPerEpoch,
    window_origin_ms: i.windowOriginMs,
  };
}

export interface PrepaidScriptPair {
  fundScript:  Validator; fundHash:  string;
  vaultScript: Validator; vaultHash: string;
}

/** Apply cặp `paid_fund` → `prepaid_vault` theo đúng chiều một chiều ở trên, qua cổng TÊN
 *  của `applyParams.ts`. Thuần: nhận blueprint đã nạp (`loadBlueprint("PrepaidGen")`).
 *
 *  MỘT hàm cho cả ba nơi cần hai hash này — bước 10 (genesis + ref-script), bước 09
 *  (`VAULT_KIND=prepaid` đối chiếu hash trong sổ) và bộ ca. Ba nơi tự apply thì chỉ cần
 *  một nơi quên `paid_fund_hash` là ra một hash vault hợp lệ khác hai nơi kia.
 *
 *  Hai hash phụ thuộc ĐỜI CARP (`carp_policy_id`, `carp_asset_name`) và BẢN DEPLOY
 *  WAKEME (`wakeme_vault_hash`), không phụ thuộc LAMP: đổi một trong hai ⟹ cả hai hash
 *  đổi ⟹ mọi ref-script và bản `consume` của loại két này phải dựng lại. */
export function prepaidScriptPair(bp: Blueprint, i: PaidFundParamInputs): PrepaidScriptPair {
  const fund = appliedScript(findValidator(bp, "prepaid.paid_fund.spend"), paidFundParams(i));
  const vault = appliedScript(findValidator(bp, "prepaid.prepaid_vault.spend"), prepaidVaultParams({
    carpPolicyId: i.carpPolicyId, carpAssetName: i.carpAssetName, paidFundHash: fund.hash,
    msPerEpoch: i.msPerEpoch, windowOriginMs: i.windowOriginMs,
  }));
  return { fundScript: fund.script, fundHash: fund.hash, vaultScript: vault.script, vaultHash: vault.hash };
}

/** Khoá sổ của hai ref-script PrepaidGen. Ghim bằng KIỂU vào bảng khoá Prepaid của bộ
 *  sinh deployment (`gen_vault_tx_api_deployment.ts` ▸ `PREPAID_STATE_KEYS`): đổi tên ở một
 *  phía ⟹ gãy lúc typecheck, không trôi im lặng. */
export const REF_VAULT_PREPAID_KEY = "REF_VAULT_PREPAID_UTXO" as const satisfies keyof typeof PREPAID_STATE_KEYS;
export const REF_PAID_FUND_KEY = "REF_PAID_FUND_UTXO" as const satisfies keyof typeof PREPAID_STATE_KEYS;

export interface PrepaidRefScriptPlanItem { label: string; bookKey: string; script: Validator; hash: string }

/** Hai ref-script PrepaidGen theo thứ tự công bố — MỖI CÁI MỘT TX (`refScripts.ts ▸
 *  publishRefScript`). Số đo vì sao tách, không gộp: `scripts/test_deploy_prepaid.ts` (C). */
export function prepaidRefScriptPlan(bp: Blueprint, i: PaidFundParamInputs): PrepaidRefScriptPlanItem[] {
  const p = prepaidScriptPair(bp, i);
  return [
    { label: "prepaid_vault ref", bookKey: REF_VAULT_PREPAID_KEY, script: p.vaultScript, hash: p.vaultHash },
    { label: "paid_fund ref",     bookKey: REF_PAID_FUND_KEY,     script: p.fundScript,  hash: p.fundHash },
  ];
}

// ── UMKeeper — um_datum.um_datum_validator.spend (4 tham số) ─────
// Neo: UMKeeper/onchain/validators/um_datum.ak.
export interface UmDatumParamInputs {
  msPerEpoch: bigint;
  umPolicy:   string;   // policy id của NFT thẩm quyền UM (one-shot)
  umName:     string;   // asset name hex ("UMD")
  windowOriginMs: bigint;
}

export function umDatumParams(i: UmDatumParamInputs): ParamMap {
  return {
    ms_per_epoch: i.msPerEpoch,
    um_policy:    i.umPolicy,
    um_name:      i.umName,
    window_origin_ms: i.windowOriginMs,
  };
}

// ── Mọi minting policy one-shot (1 tham số: genesis_ref) ─────────
// Dùng chung cho um_nft, shard_nft, price_nft, engage_nft.
export function oneShotGenesisParams(i: {
  txHash: string; outputIndex: number | bigint;
}): ParamMap {
  return { genesis_ref: outputReferenceData(i.txHash, i.outputIndex) };
}

// ── ConsumeMAGIC — price_param.price_param.spend (6 tham số) ─────
// Neo: ConsumeMAGIC/onchain/validators/price_param.ak.
export interface PriceParamParamInputs {
  committee:      string[];   // List<ByteArray> pkh
  threshold:      bigint;
  priceNftPolicy: string;
  priceNftName:   string;
  msPerEpoch:     bigint;
  windowOriginMs: bigint;
}

export function priceParamParams(i: PriceParamParamInputs): ParamMap {
  return {
    committee:        i.committee,
    threshold:        i.threshold,
    price_nft_policy: i.priceNftPolicy,
    price_nft_name:   i.priceNftName,
    ms_per_epoch:     i.msPerEpoch,
    window_origin_ms: i.windowOriginMs,
  };
}

// ── ConsumeMAGIC — consume.consume.{mint,spend} (8 tham số) ──────
// Neo: ConsumeMAGIC/onchain/validators/consume.ak.
// Chuỗi bake TUYẾN TÍNH: price_nft → price_param → consume.
// `price_param_script_hash` là hash của price_param ĐÃ apply 6 tham số trên.
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
  windowOriginMs:       bigint;
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
    window_origin_ms:        i.windowOriginMs,
  };
}

/** Asset name của NFT giá: "PRICE" — `price_nft.ak`. Apply-param #2 của `price_param` và `consume`. */
export const PRICE_NFT_NAME = "5052494345";

// BurnBatch = constr 2 trong VaultRedeemer của CẢ HAI vault sinh MAGIC:
//   InstantGen  — InstantGen/onchain/lib/magiclamp/protocol/types.ak ▸ VaultRedeemer ▸ BurnBatch (constr 2)
//   ScheduleGen — ScheduleGen/onchain/lib/magiclamp/protocol/types.ak ▸ VaultRedeemer ▸ BurnBatch
// Nên một giá trị dùng chung được. (Bản cũ của `scripts/README.md` nói hai module
// khác constr — SAI, và cái sai đó làm việc dễ trông như việc khó.)
export const BURN_BATCH_CONSTR = 2n;

export interface ConsumeScriptChainInputs {
  /** Seed one-shot của `price_nft` (g1 ở bước 09). */
  priceNftSeed:    { txHash: string; outputIndex: number | bigint };
  committee:       string[];
  threshold:       bigint;
  vaultScriptHash: string;
  maxPriceStale:   bigint;
  msPerEpoch:      bigint;
  windowOriginMs:  bigint;
}

export interface ConsumeScriptChain {
  priceNftScript: Validator; priceNftPolicy: string;
  priceParamHash: string;
  consumeScript:  Validator; consumeHash:    string;
}

/** Chuỗi bake TUYẾN TÍNH của một bản `consume`: price_nft(seed) → price_param → consume. Thuần:
 *  nhận blueprint đã nạp (`loadBlueprint("ConsumeMAGIC")`). MỘT hàm cho bước 09 (dựng thật) và
 *  `clusterHashes.ts` (tính trước) — hai nơi tự apply thì chỉ cần một nơi quên
 *  `price_param_script_hash` là ra một hash consume hợp lệ khác nơi kia. */
export function consumeScriptChain(bp: Blueprint, i: ConsumeScriptChainInputs): ConsumeScriptChain {
  const priceNft = appliedScript(
    findValidator(bp, "price_nft.price_nft.mint"),
    oneShotGenesisParams({ txHash: i.priceNftSeed.txHash, outputIndex: i.priceNftSeed.outputIndex }),
  );
  const priceParam = appliedScript(findValidator(bp, "price_param.price_param.spend"), priceParamParams({
    committee:      i.committee,
    threshold:      i.threshold,
    priceNftPolicy: priceNft.hash,
    priceNftName:   PRICE_NFT_NAME,
    msPerEpoch:     i.msPerEpoch,
    windowOriginMs: i.windowOriginMs,
  }));
  const consume = appliedScript(findValidator(bp, "consume.consume.spend"), consumeParams({
    priceNftPolicy:       priceNft.hash,
    priceNftName:         PRICE_NFT_NAME,
    vaultScriptHash:      i.vaultScriptHash,
    burnBatchConstr:      BURN_BATCH_CONSTR,
    maxPriceStale:        i.maxPriceStale,
    msPerEpoch:           i.msPerEpoch,
    windowOriginMs:       i.windowOriginMs,
    priceParamScriptHash: priceParam.hash,   // neo beacon giá vào đúng script
  }));
  return {
    priceNftScript: priceNft.script, priceNftPolicy: priceNft.hash,
    priceParamHash: priceParam.hash,
    consumeScript:  consume.script,  consumeHash:    consume.hash,
  };
}

/** Chốt fail-closed: `treasury_addr` PHẢI mang stake part. Enterprise address bị từ chối.
 *
 *  Chưa validator nào trong kho nhận `treasury_addr` làm apply-param: người gọi duy nhất,
 *  `paymasterParams`, đi cùng module `Paymaster/` đã xoá 2026-10-07 (`DevStatus.md` ▸
 *  `## Đã xoá khỏi kho — 2026-10-07`). Chốt giữ lại vì nó gác quyết định D14, không gác
 *  riêng module đó; deploy script đầu tiên bake một địa chỉ kho thì gọi nó trước khi bake.
 *
 *  **Chốt 2026-09-06: kho Treasury CÓ uỷ quyền stake.** ADA nằm trong kho là ADA nhàn
 *  rỗi, và trên Cardano thì uỷ quyền stake không khoá vốn cũng không chuyển quyền chi —
 *  không uỷ quyền là bỏ không một dòng thu mà không đổi lại được gì. Nên câu hỏi cũ
 *  ("kho có bao giờ uỷ quyền stake không") đã có câu trả lời, và cổng này nay gác một
 *  quyết định ĐÃ RA thay vì gác một chỗ trống.
 *
 *  Vì sao vẫn phải là CỔNG chứ không phải một dòng ghi chú: `treasury_addr` là
 *  apply-param, tức tham số lúc **biên dịch**. Bake bản enterprise là chốt "không bao
 *  giờ uỷ quyền" bằng **thứ tự thao tác** — gỡ ra sau này phải đổi script hash, công bố
 *  lại ref-script CIP-33, di trú mọi UTxO đang sống. Cái giá đó trả một lần lúc deploy
 *  thì bằng không; trả sau thì bằng một đợt di trú.
 *
 *  **KHÔNG có cửa bỏ qua.** Bản trước nhận một cờ `treasuryEnterpriseIsDecided` cho ca
 *  "đã chốt kho không uỷ quyền stake". Ca đó nay không tồn tại, và một cờ bỏ-qua còn nằm
 *  lại là đường để lần sau đi vòng qua chính chốt này — đúng lớp lỗi mà bản soát #39 vừa
 *  chỉ ra ở một chỗ khác của cùng tệp.
 *
 *  🟢 **2026-09-13: đường sinh địa chỉ bên LAMP đã mang stake credential vào** (nhà LAMP
 *  báo; gộp vào nhánh chính của kho đó). `Genesis/scripts/_reserve_layer2.ts` ▸
 *  `deriveCustody` nay dựng địa chỉ kho dạng **BASE**: payment = hash `custody`, stake =
 *  hash `treasury_stake` áp `(instance_id, reward_cred, delegation_admin)`, với
 *  `reward_cred` trỏ về chính credential thanh toán của kho. `ReserveWiring` xuất thêm
 *  `treasuryStakeHash` nên phần stake đọc được thẳng, không phải suy từ địa chỉ.
 *
 *  ⚠ **Mọi giá trị `treasuryAddr` giữ từ trước 2026-09-13 đều đã CHẾT.** Địa chỉ kho đổi
 *  so với mọi bản đã gieo. Dựng bằng `addressData(payment, stake)` với CẢ HAI vế, lấy từ
 *  artifact deploy của LAMP theo mạng — **soft-pin, không bake, không chép sang tệp thứ
 *  hai**.
 *
 *  ⚠ Neo liên-kho mục lặng lẽ, và lượt này có bằng chứng cho cả hai chiều mục:
 *    · Một vòng soát từng báo `_reserve_layer2.ts` "không tồn tại", vì phép tìm chỉ quét
 *      kho này. Neo liên-kho phải nói rõ KHO NÀO.
 *    · Neo `_reserve_layer2.ts:156-158` ▸ `scriptAddressData` (bản cũ của khối này trích
 *      nguyên văn `Constr(0, [Constr(1, [hash]), Constr(1, [])])`) đã mục trong **7
 *      ngày**, theo kiểu khó thấy nhất: **hàm vẫn tồn tại, vẫn trả đúng hình dạng bị tố,
 *      chỉ là không còn chỗ gọi** — sót lại từ thời `reserve_draw` nhận apply-param
 *      `reserve_dest`. Một lần `grep` vẫn ra kết quả, và kết quả ấy vẫn sai. Địa chỉ
 *      enterprise thật sự đến từ `custodyAddr: addrOf(custodyHash, network)` trong
 *      `deriveCustody`. ⟹ Neo liên-kho phải trích theo **đường GỌI**, không theo chỗ định
 *      nghĩa: một định nghĩa không ai gọi vẫn khớp `grep` y như lúc nó còn sống.
 *
 *  Cổng này **GIỮ NGUYÊN, không nới, không thêm cờ bỏ qua** — nó vừa chặn đúng một lần
 *  bake không lùi được, và đó là lý do nó tồn tại.
 */
export function assertTreasuryStakeDecided(treasuryAddr: Data): void {
  // Address = Constr 0 [payment_credential, stake_credential]; stake None = Constr 1 [].
  const addr = treasuryAddr as { index?: number; fields?: unknown[] };
  const stake = addr?.fields?.[1] as { index?: number } | undefined;
  if (stake?.index === 1) {
    throw new Error(
      "treasury_addr đang mang stake part `None` (enterprise address). Chốt 2026-09-06: " +
      "kho Treasury CÓ uỷ quyền stake, nên địa chỉ bake vào apply-param phải mang stake " +
      "credential. Bake bản enterprise là khoá cứng 'không bao giờ uỷ quyền' vào script " +
      "hash — gỡ ra sau này phải đổi hash, công bố lại ref-script CIP-33 và di trú mọi " +
      "UTxO đang sống. Dựng địa chỉ bằng `addressData(payment, stake)` với vế stake thật.",
    );
  }
}

