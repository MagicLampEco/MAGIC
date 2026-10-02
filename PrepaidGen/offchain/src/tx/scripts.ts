// src/tx/scripts.ts — apply tham số biên dịch cho hai validator PrepaidGen.
//
// Thứ tự apply-param LÀ hợp đồng nhị phân (BOUNDARIES.md §5: lệch danh sách
// apply-param với chữ ký validator là "không test nào đỏ, không compile nào gãy,
// chỉ lộ ra dưới dạng một vault không ai spend được"). Nguồn đối chiếu:
// `PrepaidGen/onchain/validators/prepaid.ak` ▸ `validator paid_fund(...)` và
// `validator prepaid_vault(...)`. Hàm dưới đây đọc tên tham số TỪ blueprint và so
// với danh sách ở đây — lệch một tên là NÉM, không apply mù.

import {
  applyParamsToScript,
  validatorToAddress,
  validatorToScriptHash,
  type Network,
  type Script,
  type UTxO,
} from "@lucid-evolution/lucid";

/** Phần của `plutus.json` mà tệp này đọc. */
export interface PrepaidBlueprint {
  validators: ReadonlyArray<{
    title: string;
    compiledCode: string;
    parameters?: ReadonlyArray<{ title: string }>;
  }>;
}

/** Tham số biên dịch theo mạng. */
export interface PrepaidScriptParams {
  /** Policy CARP, 28 byte hex. */
  carpPolicyId: string;
  /** Asset name CARP (hex). Là một băm do nhà CarpetMint phát, KHÔNG phải hex "CARP". */
  carpAssetName: string;
  msPerEpoch: bigint;
  /** Gốc lưới cửa sổ (`window_origin_ms`), apply-param CUỐI của cả hai validator. */
  windowOriginMs: bigint;
}

/** Một script đã apply: CBOR, hash, địa chỉ enterprise; tuỳ chọn UTxO ref-script CIP-33. */
export interface ScriptHandle {
  script: Script;
  hash: string;
  /** Địa chỉ enterprise (không stake) — genesis của cả vault lẫn quỹ ép `stake_credential == None`. */
  address: string;
  refUtxo?: UTxO;
}

export interface PrepaidScripts {
  network: Network;
  params: PrepaidScriptParams;
  /** `prepaid_vault` — vừa spend vừa là policy NFT định danh vault. */
  vault: ScriptHandle;
  /** `paid_fund` — vừa spend vừa là policy NFT định danh quỹ. */
  paidFund: ScriptHandle;
  /** `policyId ‖ assetName` của CARP. */
  carpUnit: string;
}

export const PAID_FUND_PARAM_NAMES = [
  "carp_policy_id",
  "carp_asset_name",
  "ms_per_epoch",
  "window_origin_ms",
] as const;

export const PREPAID_VAULT_PARAM_NAMES = [
  "carp_policy_id",
  "carp_asset_name",
  "paid_fund_hash",
  "ms_per_epoch",
  "window_origin_ms",
] as const;

const HEX28 = /^[0-9a-f]{56}$/;
const HEX = /^(?:[0-9a-f]{2})*$/;

function pick(bp: PrepaidBlueprint, title: string, names: readonly string[]): string {
  const v = bp.validators.find((x) => x.title === title);
  if (!v) {
    throw new Error(
      `PrepaidGen blueprint thiếu validator "${title}" — chạy \`aiken build PrepaidGen/onchain\` trước.`,
    );
  }
  const got = (v.parameters ?? []).map((p) => p.title);
  if (got.length !== names.length || got.some((n, i) => n !== names[i])) {
    throw new Error(
      `PrepaidGen: apply-param của "${title}" trong blueprint là [${got.join(", ")}], ` +
        `bộ dựng biết [${names.join(", ")}]. Lệch thứ tự = lệch script hash; sửa bộ dựng theo validator.`,
    );
  }
  return v.compiledCode;
}

/** Apply tham số cho `paid_fund` rồi `prepaid_vault` (vault nhận hash quỹ làm tham số #3). */
export function derivePrepaidScripts(
  blueprint: PrepaidBlueprint,
  network: Network,
  params: PrepaidScriptParams,
): PrepaidScripts {
  const carpPolicyId = params.carpPolicyId.toLowerCase();
  const carpAssetName = params.carpAssetName.toLowerCase();
  if (!HEX28.test(carpPolicyId)) {
    throw new Error(`PrepaidGen: carpPolicyId phải là 56 ký tự hex, nhận "${params.carpPolicyId}"`);
  }
  if (!HEX.test(carpAssetName) || carpAssetName.length > 64) {
    throw new Error(`PrepaidGen: carpAssetName phải là hex ≤ 32 byte, nhận "${params.carpAssetName}"`);
  }
  if (params.msPerEpoch <= 0n) throw new Error(`PrepaidGen: msPerEpoch phải > 0, nhận ${params.msPerEpoch}`);
  if (params.windowOriginMs < 0n) {
    throw new Error(`PrepaidGen: windowOriginMs không được âm, nhận ${params.windowOriginMs}`);
  }

  const fundCode = applyParamsToScript(
    pick(blueprint, "prepaid.paid_fund.spend", PAID_FUND_PARAM_NAMES),
    [carpPolicyId, carpAssetName, params.msPerEpoch, params.windowOriginMs],
  );
  const fundScript: Script = { type: "PlutusV3", script: fundCode };
  const fundHash = validatorToScriptHash(fundScript);

  const vaultCode = applyParamsToScript(
    pick(blueprint, "prepaid.prepaid_vault.spend", PREPAID_VAULT_PARAM_NAMES),
    [carpPolicyId, carpAssetName, fundHash, params.msPerEpoch, params.windowOriginMs],
  );
  const vaultScript: Script = { type: "PlutusV3", script: vaultCode };
  const vaultHash = validatorToScriptHash(vaultScript);

  return {
    network,
    params: { ...params, carpPolicyId, carpAssetName },
    vault: { script: vaultScript, hash: vaultHash, address: validatorToAddress(network, vaultScript) },
    paidFund: { script: fundScript, hash: fundHash, address: validatorToAddress(network, fundScript) },
    carpUnit: carpPolicyId + carpAssetName,
  };
}

/**
 * Gắn UTxO ref-script (CIP-33) cho một hoặc cả hai script. UTxO phải mang ĐÚNG
 * script đó — so bằng hash, không tin lời khai: ref-script sai thì Lucid vẫn dựng
 * được tx, và tx chết lúc nộp với "missing script witness".
 */
export function withRefScripts(
  scripts: PrepaidScripts,
  refs: { vault?: UTxO; paidFund?: UTxO },
): PrepaidScripts {
  const bind = (h: ScriptHandle, u: UTxO | undefined, what: string): ScriptHandle => {
    if (u === undefined) return h;
    if (!u.scriptRef) throw new Error(`PrepaidGen: UTxO ref-script ${what} ${u.txHash}#${u.outputIndex} không mang script`);
    const got = validatorToScriptHash(u.scriptRef);
    if (got !== h.hash) {
      throw new Error(`PrepaidGen: UTxO ref-script ${what} mang script ${got}, cần ${h.hash}`);
    }
    return { ...h, refUtxo: u };
  };
  return {
    ...scripts,
    vault: bind(scripts.vault, refs.vault, "vault"),
    paidFund: bind(scripts.paidFund, refs.paidFund, "paid_fund"),
  };
}
