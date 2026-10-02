// src/params.ts — apply-param của HAI validator ScheduleGen Gen v2.0: `commit` (withdraw-zero,
// 10 tham số) và `vault` (7 tham số). Cả hai nhận `window_origin_ms` làm tham số CUỐI CÙNG
// (`LAMP/Specs/Window/CONTRACT.md` v1.0); ở két nó đứng SAU hash của `commit` ĐÃ apply.
//
// Thứ tự là hợp đồng: nó quyết định bytes ⟹ script hash ⟹ địa chỉ két. Nguồn duy nhất
// của thứ tự là hai chữ ký `validator commit(` và `validator vault(` trong
// `ScheduleGen/onchain/validators/vault.ak`; bài `ScheduleGen/tests/datumV2.test.ts` ▸
// "apply-param" đọc hai chữ ký đó và so với hai danh sách tên bên dưới.
//
// Thứ tự DỰNG (khối chú thích trên `validator vault(`):
//     commit(10 tham số) → commit_script_hash → vault(…, commit_script_hash) → vault_script_hash
// `commit` KHÔNG nhận hash két (tránh vòng) — nó biết két qua redeemer `CommitRedeemer`.
//
// `applyParamsToScript` của Lucid KHÔNG kiểm số lượng hay thứ tự tham số: sai một ô vẫn ra
// một hash hợp lệ và két khoá LAMP vĩnh viễn. Nên đường apply duy nhất ở module này là
// `applyScheduleScripts`, và nó đối chiếu TÊN tham số với blueprint trước khi apply — cùng
// hình dạng cổng với `scripts/applyParams.ts` ▸ `appliedScript`.

import { applyParamsToScript, validatorToScriptHash, type Data, type Validator } from "@lucid-evolution/lucid";

/** Chữ ký `validator commit(` — 10 tham số. */
export const SCHEDULE_COMMIT_PARAM_NAMES = [
  "lamp_policy_id",
  "lamp_asset_name",
  "shard_policy_id",
  "ms_per_epoch",
  "gb_beacon_nft_policy",
  "gb_beacon_script_hash",
  "gb_shard_policy_id",
  "rate_nft_policy",
  "rate_script_hash",
  "window_origin_ms",
] as const;

/** Chữ ký `validator vault(` — 7 tham số; #5 là hash `commit` đã apply, #6 gốc cửa sổ. */
export const SCHEDULE_VAULT_PARAM_NAMES = [
  "lamp_policy_id",
  "lamp_asset_name",
  "shard_policy_id",
  "ms_per_epoch",
  "gb_shard_policy_id",
  "commit_script_hash",
  "window_origin_ms",
] as const;

/** Title blueprint dùng để đối chiếu tên tham số (mọi purpose của một validator cùng tham số). */
export const SCHEDULE_COMMIT_BLUEPRINT_TITLE = "vault.commit.withdraw";
export const SCHEDULE_VAULT_BLUEPRINT_TITLE  = "vault.vault.spend";

/** Đầu vào chung của cặp script. Bốn tham số beacon chỉ `commit` nhận; `gb_shard_policy_id`
 *  và bốn tham số đầu thì CẢ HAI nhận, cùng giá trị (khối LẬP LUẬN trên `validator commit`). */
export interface ScheduleScriptParams {
  lampPolicyId       : string;   // 28 byte hex
  lampAssetName      : string;   // hex — theo MẠNG (tLAMP testnet / LAMP mainnet)
  shardPolicyId      : string;   // policy NFT shard LAMP (`shard_nft.ak`)
  msPerEpoch         : bigint;
  gbBeaconNftPolicy  : string;   // policy NFT "GBB"
  gbBeaconScriptHash : string;   // script beacon GreenBack
  gbShardPolicyId    : string;   // = script hash `gb_shard`
  rateNftPolicy      : string;   // policy NFT "RHO"
  rateScriptHash     : string;   // script beacon ρ
  windowOriginMs     : bigint;   // gốc cửa sổ — `@magiclamp/protocol-utils` ▸ `windowOriginMs(network)`
}

function hex(name: string, v: string, bytes?: number): string {
  if (!/^([0-9a-f]{2})*$/.test(v)) throw new Error(`apply-param ${name}: không phải hex thường: "${v}"`);
  if (bytes !== undefined && v.length !== bytes * 2) {
    throw new Error(`apply-param ${name}: cần ${bytes} byte, nhận ${v.length / 2}`);
  }
  return v;
}

function ordered<N extends string>(names: readonly N[], values: Record<N, Data>): Record<string, Data> {
  const out: Record<string, Data> = {};
  for (const n of names) out[n] = values[n];
  return out;
}

function sharedValues(p: ScheduleScriptParams) {
  if (p.msPerEpoch <= 0n) throw new Error(`apply-param ms_per_epoch phải > 0, nhận ${p.msPerEpoch}`);
  if (typeof p.windowOriginMs !== "bigint" || p.windowOriginMs < 0n) {
    throw new Error(`apply-param window_origin_ms phải là bigint ≥ 0, nhận ${String(p.windowOriginMs)}`);
  }
  return {
    lamp_policy_id:     hex("lamp_policy_id", p.lampPolicyId, 28),
    lamp_asset_name:    hex("lamp_asset_name", p.lampAssetName),
    shard_policy_id:    hex("shard_policy_id", p.shardPolicyId, 28),
    ms_per_epoch:       p.msPerEpoch,
    gb_shard_policy_id: hex("gb_shard_policy_id", p.gbShardPolicyId, 28),
    window_origin_ms:   p.windowOriginMs,
  };
}

/** Bản đồ TÊN → giá trị cho `commit`, khoá theo đúng thứ tự `SCHEDULE_COMMIT_PARAM_NAMES`. */
export function scheduleCommitParamMap(p: ScheduleScriptParams): Record<string, Data> {
  const s = sharedValues(p);
  return ordered(SCHEDULE_COMMIT_PARAM_NAMES, {
    ...s,
    gb_beacon_nft_policy:  hex("gb_beacon_nft_policy", p.gbBeaconNftPolicy, 28),
    gb_beacon_script_hash: hex("gb_beacon_script_hash", p.gbBeaconScriptHash, 28),
    rate_nft_policy:       hex("rate_nft_policy", p.rateNftPolicy, 28),
    rate_script_hash:      hex("rate_script_hash", p.rateScriptHash, 28),
  });
}

export function scheduleCommitParamList(p: ScheduleScriptParams): Data[] {
  const m = scheduleCommitParamMap(p);
  return SCHEDULE_COMMIT_PARAM_NAMES.map(n => m[n]!);
}

/** Bản đồ TÊN → giá trị cho két. `commitScriptHash` = hash của `commit` SAU KHI apply. */
export function scheduleVaultParamMap(p: ScheduleScriptParams, commitScriptHash: string): Record<string, Data> {
  const s = sharedValues(p);
  return ordered(SCHEDULE_VAULT_PARAM_NAMES, {
    ...s,
    commit_script_hash: hex("commit_script_hash", commitScriptHash, 28),
  });
}

export function scheduleVaultParamList(p: ScheduleScriptParams, commitScriptHash: string): Data[] {
  const m = scheduleVaultParamMap(p, commitScriptHash);
  return SCHEDULE_VAULT_PARAM_NAMES.map(n => m[n]!);
}

// ── Cổng theo tên + dựng cặp script ──────────────────────────────────

/** Tập con của blueprint CIP-57 mà cổng cần. */
export interface ScheduleBlueprint {
  validators: { title: string; compiledCode: string; parameters?: { title?: string }[] }[];
}

function blueprintCode(bp: ScheduleBlueprint, title: string, want: readonly string[]): string {
  const v = bp.validators.find(x => x.title === title);
  if (!v) {
    throw new Error(`GEN-SCH-PARAMS: blueprint thiếu "${title}" — chạy lại \`aiken build ScheduleGen/onchain\`.`);
  }
  const got = (v.parameters ?? []).map((p, i) => {
    if (typeof p.title !== "string" || p.title.length === 0) {
      throw new Error(`GEN-SCH-PARAMS: tham số #${i} của "${title}" không có title trong blueprint.`);
    }
    return p.title;
  });
  if (got.length !== want.length || got.some((t, i) => t !== want[i])) {
    throw new Error(
      `GEN-SCH-PARAMS: tham số "${title}" lệch blueprint.\n` +
      `  blueprint: ${got.join(", ")}\n  mã TS:     ${want.join(", ")}`);
  }
  return v.compiledCode;
}

export interface ScheduleScripts {
  commitScript     : Validator;
  commitScriptHash : string;
  vaultScript      : Validator;
  vaultScriptHash  : string;
}

/** Apply cặp script theo ĐÚNG thứ tự: `commit` → hash → két. Tên tham số của cả hai được
 *  đối chiếu với blueprint trước khi apply; lệch ⟹ NÉM `GEN-SCH-PARAMS`. */
export function applyScheduleScripts(bp: ScheduleBlueprint, p: ScheduleScriptParams): ScheduleScripts {
  const commitCode = blueprintCode(bp, SCHEDULE_COMMIT_BLUEPRINT_TITLE, SCHEDULE_COMMIT_PARAM_NAMES);
  const vaultCode  = blueprintCode(bp, SCHEDULE_VAULT_BLUEPRINT_TITLE, SCHEDULE_VAULT_PARAM_NAMES);
  const commitScript: Validator = {
    type: "PlutusV3", script: applyParamsToScript(commitCode, scheduleCommitParamList(p)),
  };
  const commitScriptHash = validatorToScriptHash(commitScript);
  const vaultScript: Validator = {
    type: "PlutusV3", script: applyParamsToScript(vaultCode, scheduleVaultParamList(p, commitScriptHash)),
  };
  return { commitScript, commitScriptHash, vaultScript, vaultScriptHash: validatorToScriptHash(vaultScript) };
}
