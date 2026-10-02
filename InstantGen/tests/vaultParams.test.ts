// tests/vaultParams.test.ts — 9 apply-param của két InstantGen Gen v2.0 khớp blueprint.
//
// Nguồn chân lý: chữ ký `validator vault(...)` trong `onchain/validators/vault.ak`, qua
// blueprint `onchain/plutus.json` do `aiken build` sinh (artifact, gitignore). Bài kiểm
// đọc blueprint THẬT — thiếu tệp thì ĐỎ kèm lệnh cần chạy, không bỏ qua.
//
// Ghim ba thứ: (1) tên + thứ tự + kiểu dữ liệu của 9 tham số; (2) `instantVaultParamList`
// đặt từng trường của `InstantVaultParams` vào ĐÚNG vị trí; (3) đổi một tham số bất kỳ ⟹
// đổi hash script (apply-param là tham số lúc biên dịch).

import { describe, it, expect } from "vitest";
import { windowOriginMs } from "@magiclamp/protocol-utils";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { applyParamsToScript, validatorToScriptHash } from "@lucid-evolution/lucid";
import {
  INSTANT_VAULT_PARAM_TITLES, INSTANT_VAULT_SPEND_TITLE, instantVaultParamList, applyInstantVaultParams,
  type InstantVaultParams,
} from "../offchain/src/vaultScript.js";

const here = dirname(fileURLToPath(import.meta.url));
const BLUEPRINT = resolve(here, "../onchain/plutus.json");

interface Blueprint {
  validators: Array<{ title: string; compiledCode: string; parameters?: Array<{ title: string; schema: { $ref: string } }> }>;
  definitions: Record<string, { dataType?: string }>;
}

function loadBlueprint(): Blueprint {
  if (!existsSync(BLUEPRINT)) {
    throw new Error(`Thiếu ${BLUEPRINT} — chạy \`aiken build InstantGen/onchain\` trước bài kiểm này.`);
  }
  return JSON.parse(readFileSync(BLUEPRINT, "utf8")) as Blueprint;
}

function spendValidator(bp: Blueprint) {
  const v = bp.validators.find(x => x.title === INSTANT_VAULT_SPEND_TITLE);
  if (v === undefined) throw new Error(`Blueprint không có validator ${INSTANT_VAULT_SPEND_TITLE}.`);
  return v;
}

function dataTypeOf(bp: Blueprint, ref: string): string {
  const key = ref.replace("#/definitions/", "").replace(/~1/g, "/");
  const t = bp.definitions[key]?.dataType;
  if (t === undefined) throw new Error(`Không phân giải được ${ref} trong blueprint.`);
  return t;
}

// Mỗi trường một giá trị KHÁC NHAU, để một lệch vị trí không trốn sau hai giá trị trùng.
const P0: InstantVaultParams = {
  lampPolicyId      : "01".repeat(28),
  lampAssetName     : "744c414d50",
  gbBeaconNftPolicy : "03".repeat(28),
  gbBeaconScriptHash: "04".repeat(28),
  gbShardPolicyId   : "05".repeat(28),
  rateNftPolicy     : "06".repeat(28),
  rateScriptHash    : "07".repeat(28),
  wakemeVaultHash   : "08".repeat(28),
  msPerEpoch        : 432_000_000n,
  windowOriginMs    : windowOriginMs("Preprod"),
};

// Tên tham số blueprint → trường TS. Viết tay, độc lập với thứ tự trong `vaultScript.ts`.
const FIELD_OF: Record<string, keyof InstantVaultParams> = {
  lamp_policy_id       : "lampPolicyId",
  lamp_asset_name      : "lampAssetName",
  gb_beacon_nft_policy : "gbBeaconNftPolicy",
  gb_beacon_script_hash: "gbBeaconScriptHash",
  gb_shard_policy_id   : "gbShardPolicyId",
  rate_nft_policy      : "rateNftPolicy",
  rate_script_hash     : "rateScriptHash",
  wakeme_vault_hash    : "wakemeVaultHash",
  ms_per_epoch         : "msPerEpoch",
  window_origin_ms     : "windowOriginMs",
};

describe("apply-param két InstantGen v2.0 ↔ blueprint", () => {
  const bp = loadBlueprint();
  const spend = spendValidator(bp);
  const params = spend.parameters ?? [];

  it("blueprint khai đúng 10 tham số, đúng tên, đúng thứ tự", () => {
    expect(params.map(p => p.title)).toEqual([...INSTANT_VAULT_PARAM_TITLES]);
  });

  it("kiểu dữ liệu: 8 bytes rồi 2 integer (ms_per_epoch, window_origin_ms)", () => {
    expect(params.map(p => dataTypeOf(bp, p.schema.$ref))).toEqual([
      "bytes", "bytes", "bytes", "bytes", "bytes", "bytes", "bytes", "bytes", "integer", "integer",
    ]);
  });

  it("mint + spend cùng một mã biên dịch, cùng danh sách tham số", () => {
    const mint = bp.validators.find(x => x.title === "vault.vault.mint");
    expect(mint?.compiledCode).toBe(spend.compiledCode);
    expect(mint?.parameters?.map(p => p.title)).toEqual(params.map(p => p.title));
  });

  it("instantVaultParamList đặt MỖI trường vào đúng vị trí tên blueprint", () => {
    const list = instantVaultParamList(P0);
    expect(list).toHaveLength(params.length);
    params.forEach((p, i) => {
      const field = FIELD_OF[p.title];
      if (field === undefined) throw new Error(`Tham số blueprint lạ: ${p.title}`);
      expect(list[i]).toBe(P0[field]);
    });
  });

  it("applyInstantVaultParams == applyParamsToScript(compiledCode, list)", () => {
    const v = applyInstantVaultParams(spend.compiledCode, P0);
    expect(v.type).toBe("PlutusV3");
    expect(v.script).toBe(applyParamsToScript(spend.compiledCode, instantVaultParamList(P0)));
  });

  it("đổi MỘT tham số bất kỳ ⟹ hash script đổi (10 cặp)", () => {
    const h0 = validatorToScriptHash(applyInstantVaultParams(spend.compiledCode, P0));
    const seen = new Set([h0]);
    for (const k of Object.keys(P0) as Array<keyof InstantVaultParams>) {
      const p = { ...P0 } as Record<string, unknown>;
      p[k] = k === "msPerEpoch" ? 86_400_000n : k === "windowOriginMs" ? P0.windowOriginMs + 1_000n : k === "lampAssetName" ? "4c414d50" : "0f".repeat(28);
      const h = validatorToScriptHash(applyInstantVaultParams(spend.compiledCode, p as unknown as InstantVaultParams));
      expect(h).not.toBe(h0);
      seen.add(h);
    }
    expect(seen.size).toBe(11);
  });
});

describe("instantVaultParamList — sai dạng NÉM trước khi apply", () => {
  it("hash 27 byte ⟹ INSTANT_VAULT_PARAM", () => {
    expect(() => instantVaultParamList({ ...P0, rateScriptHash: "07".repeat(27) })).toThrow(/INSTANT_VAULT_PARAM: rateScriptHash/);
  });
  it("hex hoa ⟹ INSTANT_VAULT_PARAM", () => {
    expect(() => instantVaultParamList({ ...P0, wakemeVaultHash: "AB".repeat(28) })).toThrow(/INSTANT_VAULT_PARAM/);
  });
  it("windowOriginMs = −1 ⟹ INSTANT_VAULT_PARAM; = 0 qua", () => {
    expect(() => instantVaultParamList({ ...P0, windowOriginMs: -1n })).toThrow(/INSTANT_VAULT_PARAM: windowOriginMs/);
    expect(() => instantVaultParamList({ ...P0, windowOriginMs: 0n })).not.toThrow();
  });
  it("msPerEpoch = 0 ⟹ INSTANT_VAULT_PARAM; = 1 qua", () => {
    expect(() => instantVaultParamList({ ...P0, msPerEpoch: 0n })).toThrow(/INSTANT_VAULT_PARAM/);
    expect(() => instantVaultParamList({ ...P0, msPerEpoch: 1n })).not.toThrow();
  });
  it("lampAssetName 33 byte ⟹ INSTANT_VAULT_PARAM; 32 byte qua", () => {
    expect(() => instantVaultParamList({ ...P0, lampAssetName: "aa".repeat(33) })).toThrow(/INSTANT_VAULT_PARAM/);
    expect(() => instantVaultParamList({ ...P0, lampAssetName: "aa".repeat(32) })).not.toThrow();
  });
});
