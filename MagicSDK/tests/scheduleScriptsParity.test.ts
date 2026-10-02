// MagicSDK/tests/scheduleScriptsParity.test.ts — két Schedule SDK apply ra ĐÚNG cặp
// (hash `commit`, hash két) mà gói nền `@magiclamp/schedulegen-sdk ▸ applyScheduleScripts`
// ra cho cùng tham số.
//
// SDK không giữ bảng apply-param riêng (`validatorScripts.ts`): nó ánh xạ `ProtocolParams`
// sang `ScheduleScriptParams` rồi uỷ cho gói nền. Chỗ duy nhất SDK còn sai được là PHÉP ÁNH
// XẠ đó — đảo hai trường cùng kiểu (28 byte hex) thì kiểm kiểu im lặng, hash lệch, và két
// sinh ra ở một địa chỉ không bộ dựng nào của gói nền nhận. Nên bài này dựng
// `ScheduleScriptParams` THEO TÊN, bằng tay, với chín giá trị ĐÔI MỘT KHÁC NHAU: mọi hoán vị
// giữa hai trường đều đổi bytes.
//
// Kèm: cổng policy LAMP chạy TRƯỚC mọi kiểm trường riêng trên cả hai đường apply.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { msPerEpoch } from "@magiclamp/protocol-utils";
import {
  applyScheduleScripts, SCHEDULE_VAULT_BLUEPRINT_TITLE,
  type ScheduleBlueprint, type ScheduleScriptParams,
} from "@magiclamp/schedulegen-sdk";

import { applyVaultValidator } from "../src/validatorScripts.js";
import { NON_LAMP_LOOKALIKE_POLICIES } from "../src/lampPolicy.js";
import type { ProtocolParams, ValidatorBundle } from "../src/types.js";

const LAMP_POLICY = "4942de4a226f43c524c1273d752712366511d5fd7ae28bc1a1576077";
const SHARD_POLC  = "33".repeat(28);
const GBB_POLICY  = "88".repeat(28);
const GBB_SCRIPT  = "99".repeat(28);
const GBS_POLICY  = "aa".repeat(28);
const RHO_POLICY  = "bb".repeat(28);
const RHO_SCRIPT  = "cc".repeat(28);
const WAKEME_HASH = "66".repeat(28);
const LOOKALIKE   = Object.keys(NON_LAMP_LOOKALIKE_POLICIES)[0]!;

const loadBp = (m: string) => JSON.parse(readFileSync(
  fileURLToPath(new URL(`../../${m}/onchain/plutus.json`, import.meta.url)), "utf8",
));
const SG_BP = loadBp("ScheduleGen") as ScheduleBlueprint;
const IG_BP = loadBp("InstantGen") as { validators: { title: string; compiledCode: string }[] };

const codeOf = (bp: { validators: { title: string; compiledCode: string }[] }, title: string) => {
  const v = bp.validators.find(x => x.title === title);
  if (!v) throw new Error(`validator "${title}" not in blueprint`);
  return v.compiledCode;
};

const scheduleBundle: ValidatorBundle = {
  vaultUnappliedCbor: codeOf(SG_BP, SCHEDULE_VAULT_BLUEPRINT_TITLE),
  vaultPlutusJson:    SG_BP as never,
} as ValidatorBundle;
const instantBundle: ValidatorBundle = {
  vaultUnappliedCbor: codeOf(IG_BP, "vault.vault.spend"),
} as ValidatorBundle;

// Gốc cửa sổ viết TAY theo mạng (vector LAMP `Specs/Window/CONTRACT.md` v1.0). Preview chưa có
// gốc (`WIN-PREVIEW`) ⟹ bài truyền gốc TƯỜNG MINH của riêng bài, không phải gốc Preview.
const ORIGIN: Record<ProtocolParams["network"], bigint> = {
  Preview: 1_000_000_000n,
  Preprod: 1_654_041_600_000n,
  Mainnet: 1_506_203_091_000n,
};

function protocol(network: ProtocolParams["network"], over: Partial<ProtocolParams> = {}): ProtocolParams {
  return {
    ...(network === "Preview" ? { windowOriginMs: ORIGIN.Preview } : {}),
    network, lampPolicyId: LAMP_POLICY, shardPolicyId: SHARD_POLC,
    gbBeaconNftPolicy: GBB_POLICY, gbBeaconScriptHash: GBB_SCRIPT, gbShardPolicyId: GBS_POLICY,
    rateNftPolicy: RHO_POLICY, rateScriptHash: RHO_SCRIPT, wakemeVaultHash: WAKEME_HASH,
    ...over,
  };
}

/** `ScheduleScriptParams` viết TAY theo tên — không đi qua ánh xạ của SDK. */
function byName(network: ProtocolParams["network"]): ScheduleScriptParams {
  return {
    lampPolicyId:       LAMP_POLICY,
    lampAssetName:      network === "Mainnet" ? "4c414d50" : "744c414d50",
    shardPolicyId:      SHARD_POLC,
    msPerEpoch:         msPerEpoch(network),
    gbBeaconNftPolicy:  GBB_POLICY,
    gbBeaconScriptHash: GBB_SCRIPT,
    gbShardPolicyId:    GBS_POLICY,
    rateNftPolicy:      RHO_POLICY,
    rateScriptHash:     RHO_SCRIPT,
    windowOriginMs:     ORIGIN[network],
  };
}

describe("applyVaultValidator(\"Schedule\") ≡ applyScheduleScripts của gói nền", () => {
  for (const network of ["Preview", "Preprod", "Mainnet"] as const) {
    it(`${network}: hash két, hash commit và bytes TRÙNG`, () => {
      const ref = applyScheduleScripts(SG_BP, byName(network));
      const sdk = applyVaultValidator("Schedule", scheduleBundle, protocol(network));
      expect(sdk.commitScriptHash).toBe(ref.commitScriptHash);
      expect(sdk.vaultScriptHash).toBe(ref.vaultScriptHash);
      expect(sdk.commitScript?.script).toBe(ref.commitScript.script);
      expect(sdk.vaultScript.script).toBe(ref.vaultScript.script);
    });
  }

  // Cực đối: phép so trên phải PHÂN BIỆT được một hoán vị. Đảo đúng hai trường cùng kiểu ở
  // phía gói nền ⟹ hash khác bản SDK. Nếu bằng, bài trên không ghim thứ tự trường.
  it.each([
    ["gbBeaconNftPolicy ↔ gbShardPolicyId", "gbBeaconNftPolicy", "gbShardPolicyId"],
    ["rateNftPolicy ↔ rateScriptHash",      "rateNftPolicy",     "rateScriptHash"],
    ["shardPolicyId ↔ gbShardPolicyId",     "shardPolicyId",     "gbShardPolicyId"],
  ] as const)("đảo %s ở tham số gói nền ⟹ hash KHÁC bản SDK", (_n, a, b) => {
    const p = byName("Preview");
    const swapped = { ...p, [a]: p[b], [b]: p[a] };
    const ref = applyScheduleScripts(SG_BP, swapped);
    const sdk = applyVaultValidator("Schedule", scheduleBundle, protocol("Preview"));
    expect(ref.vaultScriptHash).not.toBe(sdk.vaultScriptHash);
  });

  it("SDK không đọc wakemeVaultHash cho két Schedule — đổi nó KHÔNG đổi hash", () => {
    const a = applyVaultValidator("Schedule", scheduleBundle, protocol("Preview"));
    const b = applyVaultValidator("Schedule", scheduleBundle, protocol("Preview", { wakemeVaultHash: "77".repeat(28) }));
    expect(b.vaultScriptHash).toBe(a.vaultScriptHash);
  });
});

describe("cổng policy LAMP chạy TRƯỚC kiểm trường riêng — trên applyVaultValidator", () => {
  // Cặp ca: cùng thiếu `gbShardPolicyId`, chỉ khác policy. Policy nhái ⟹ câu lỗi về POLICY;
  // policy hợp lệ ⟹ câu lỗi về trường thiếu. Nếu cổng đứng sau `requireField`, ca đầu nhận
  // câu "gbShardPolicyId required" và người gọi đi sửa nhầm chỗ.
  for (const [vt, bundle] of [["Schedule", scheduleBundle], ["Instant", instantBundle]] as const) {
    it(`${vt}: policy nhái + thiếu trường ⟹ lỗi nói về POLICY`, () => {
      const p = protocol("Preview", { lampPolicyId: LOOKALIKE, gbShardPolicyId: undefined });
      expect(() => applyVaultValidator(vt, bundle, p)).toThrow(/KHÔNG PHẢI LAMP/);
    });
    it(`${vt}: policy hợp lệ + thiếu trường ⟹ lỗi nói về TRƯỜNG`, () => {
      const p = protocol("Preview", { gbShardPolicyId: undefined });
      expect(() => applyVaultValidator(vt, bundle, p)).toThrow(new RegExp(`gbShardPolicyId required for vaultType="${vt}"`));
    });
  }
});
