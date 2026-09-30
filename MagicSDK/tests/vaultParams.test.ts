// MagicSDK/tests/vaultParams.test.ts — pins the compile-time param contract.
//
// buildParamsList output must match the Aiken `validator vault(...)` signature
// POSITION BY POSITION. Nothing else catches a mismatch: applyParamsToScript
// accepts any list, produces a well-formed CBOR, and yields a plausible script
// hash — the error only surfaces as a vault at an address nobody can spend, on
// mainnet, with real LAMP in it.
//
// When you change a validator signature, change this table in the same commit.
// Source of truth (chỉ còn 2 validator sống — SnapshotGen/VacuumGen đã sang
// Legacy/ nên không còn chữ ký nào để ghim):
//   InstantGen/onchain/validators/vault.ak
//   ScheduleGen/onchain/validators/vault.ak

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { msPerEpoch } from "@magiclamp/protocol-utils";
import { applyParamsToScript, validatorToScriptHash } from "@lucid-evolution/lucid";
import {
  buildParamsList, applyShardValidator, applyVaultValidator,
} from "../src/validatorScripts.js";
import type { ProtocolParams } from "../src/types.js";

const LAMP_POLICY = "4942de4a226f43c524c1273d752712366511d5fd7ae28bc1a1576077";
const UM_POLICY   = "11111111111111111111111111111111111111111111111111111111";
const UM_SCRIPT   = "22222222222222222222222222222222222222222222222222222222";
const SHARD_POLC  = "33333333333333333333333333333333333333333333333333333333";
const BACK_POLICY = "44444444444444444444444444444444444444444444444444444444";
const BACK_SCRIPT = "55555555555555555555555555555555555555555555555555555555";
const WAKEME_HASH = "66666666666666666666666666666666666666666666666666666666";

const TLAMP = "744c414d50";  // "tLAMP" — testnets
const LAMP  = "4c414d50";    // "LAMP"  — mainnet

function protocolFor(network: ProtocolParams["network"]): ProtocolParams {
  return {
    network,
    lampPolicyId:    LAMP_POLICY,
    umNftPolicyId:   UM_POLICY,
    umScriptHash:    UM_SCRIPT,
    shardPolicyId:   SHARD_POLC,
    backingNftPolicyId: BACK_POLICY,
    backingScriptHash:  BACK_SCRIPT,
    wakemeVaultHash:    WAKEME_HASH,
  };
}

const params = (t: Parameters<typeof buildParamsList>[0], n: ProtocolParams["network"]) =>
  buildParamsList(t, protocolFor(n), msPerEpoch(n));

describe("buildParamsList: param order matches the Aiken validator signature", () => {
  const MS_PREVIEW = 86_400_000n;

  it("Instant: (lamp_policy_id, lamp_asset_name, um_nft, um_script_hash, backing_nft, backing_script_hash, ms_per_epoch, wakeme_vault_hash)", () => {
    expect(params("Instant", "Preview")).toEqual([
      LAMP_POLICY, TLAMP, UM_POLICY, UM_SCRIPT, BACK_POLICY, BACK_SCRIPT, MS_PREVIEW, WAKEME_HASH,
    ]);
  });

  it("Instant: thiếu wakemeVaultHash ⟹ ném, không apply 7 tham số", () => {
    const p = { ...protocolFor("Preprod") };
    delete (p as { wakemeVaultHash?: string }).wakemeVaultHash;
    expect(() => buildParamsList("Instant", p, msPerEpoch("Preprod")))
      .toThrow(/wakemeVaultHash required for vaultType="Instant"/);
  });

  it.each([
    ["hex hoa", WAKEME_HASH.replace(/6/g, "A")],
    ["27 byte", WAKEME_HASH.slice(2)],
    ["không phải hex", "g".repeat(56)],
  ])("Instant: wakemeVaultHash sai dạng (%s) ⟹ ném", (_n, bad) => {
    const p = { ...protocolFor("Preprod"), wakemeVaultHash: bad };
    expect(() => buildParamsList("Instant", p, msPerEpoch("Preprod"))).toThrow(/wakeme_vault_hash/);
  });

  it("Schedule: không đòi wakemeVaultHash (param #8 chỉ có ở Instant)", () => {
    const p = { ...protocolFor("Preview") };
    delete (p as { wakemeVaultHash?: string }).wakemeVaultHash;
    expect(buildParamsList("Schedule", p, msPerEpoch("Preview"))).toHaveLength(4);
  });

  it("Schedule: (lamp_policy_id, lamp_asset_name, shard_policy_id, ms_per_epoch)", () => {
    expect(params("Schedule", "Preview")).toEqual([
      LAMP_POLICY, TLAMP, SHARD_POLC, MS_PREVIEW,
    ]);
  });
});

describe("buildParamsList: lamp_asset_name is network-derived, never a testnet default", () => {
  // The whole point of the param: a mainnet vault must be built with "LAMP".
  // A tLAMP fallback here bakes a vault whose value check can never match, and
  // the LAMP inside it is stuck forever.
  for (const vaultType of ["Instant", "Schedule"] as const) {
    it(`${vaultType}: Mainnet → "LAMP", testnets → "tLAMP"`, () => {
      expect(params(vaultType, "Mainnet")[1]).toBe(LAMP);
      expect(params(vaultType, "Preview")[1]).toBe(TLAMP);
      expect(params(vaultType, "Preprod")[1]).toBe(TLAMP);
    });

    it(`${vaultType}: no tLAMP literal survives anywhere in a Mainnet param list`, () => {
      const flat = JSON.stringify(params(vaultType, "Mainnet"), (_k, v) =>
        typeof v === "bigint" ? v.toString() : v);
      expect(flat).not.toContain(TLAMP);
    });
  }

  it("explicit protocol.lampAssetName overrides the network default", () => {
    const custom = "6d794c414d50";  // "myLAMP" — non-canonical mint
    const p = { ...protocolFor("Mainnet"), lampAssetName: custom };
    expect(buildParamsList("Instant", p, msPerEpoch("Mainnet"))[1]).toBe(custom);
  });
});

// ── Cổng ARITY — đối chiếu thẳng với blueprint đã build ─────────────────────
//
// Bảng kỳ vọng ở trên vẫn là bảng CHÉP TAY: nó bắt được lệch THỨ TỰ nhưng vẫn
// trôi cùng nhau nếu người sửa cập nhật cả code lẫn bảng theo một hiểu sai.
// Khối này đọc `parameters[]` từ chính `plutus.json` do `aiken build` sinh ra —
// nguồn duy nhất không thể chép sai.
//
// Đây là lỗi đã xảy ra thật, ba lần trong repo này: `applyParamsToScript` KHÔNG
// kiểm arity, nên truyền thiếu vẫn ra hash 28 byte trông hợp lệ, và sai chỉ lộ ra
// khi có LAMP thật nằm ở một địa chỉ không ai spend được.
type Blueprint = {
  validators: { title: string; compiledCode: string; parameters?: { title: string }[] }[];
};

const loadBlueprint = async (module: string): Promise<Blueprint> =>
  JSON.parse(await readFile(
    fileURLToPath(new URL(`../../${module}/onchain/plutus.json`, import.meta.url)),
    "utf8",
  ));

const paramTitles = (bp: Blueprint, title: string): string[] => {
  const v = bp.validators.find((x) => x.title === title);
  if (!v) throw new Error(`validator "${title}" not in blueprint`);
  return (v.parameters ?? []).map((p) => p.title);
};

describe("arity gate: SDK param list matches the built blueprint", () => {
  // Bảng tên → giá trị. Đối chiếu THEO TÊN với blueprint, không chỉ theo số lượng:
  // `toHaveLength` cho qua mọi hoán vị, mà hoán vị chính là ca đắt nhất (hash sai,
  // không gì đỏ). Sai một tên ở đây là test đỏ ngay, chứ không phải mainnet đỏ.
  const BY_NAME: Record<string, unknown> = {
    lamp_policy_id:       LAMP_POLICY,
    lamp_asset_name:      TLAMP,
    um_nft_policy:        UM_POLICY,
    um_script_hash:       UM_SCRIPT,
    backing_nft_policy:   BACK_POLICY,
    backing_script_hash:  BACK_SCRIPT,
    shard_policy_id:      SHARD_POLC,
    ms_per_epoch:         86_400_000n,
    wakeme_vault_hash:    WAKEME_HASH,
  };

  for (const [vaultType, module] of [
    ["Instant", "InstantGen"], ["Schedule", "ScheduleGen"],
  ] as const) {
    it(`${vaultType}: buildParamsList khớp blueprint theo TÊN và THỨ TỰ`, async () => {
      const titles = paramTitles(await loadBlueprint(module), "vault.vault.spend");
      const unknown = titles.filter((t) => !(t in BY_NAME));
      expect(unknown, `tham số blueprint chưa có trong BY_NAME: ${unknown.join(", ")}`)
        .toEqual([]);
      expect(params(vaultType, "Preview")).toEqual(titles.map((t) => BY_NAME[t]));
    });
  }

  it("Instant: bytes SDK apply ĐÚNG BẰNG bytes apply tay 8 tham số — và KHÁC bản 7 tham số", async () => {
    // Bảng BY_NAME ở trên chỉ so DANH SÁCH; bài này so BYTES script cuối cùng, tức thứ
    // quyết định địa chỉ vault. Danh sách 8 phần tử viết TAY theo chữ ký `validator vault(...)`,
    // không đi qua `buildParamsList`, để hai phía không cùng sai theo một hiểu lầm.
    const bp = await loadBlueprint("InstantGen");
    const raw = bp.validators.find((v) => v.title === "vault.vault.spend")!;
    const proto = protocolFor("Preprod");
    const mspe = msPerEpoch("Preprod");

    const sdk = applyVaultValidator("Instant", { vaultUnappliedCbor: raw.compiledCode }, proto);
    const manual8 = applyParamsToScript(raw.compiledCode, [
      LAMP_POLICY, TLAMP, UM_POLICY, UM_SCRIPT, BACK_POLICY, BACK_SCRIPT, mspe, WAKEME_HASH,
    ]);
    const manual7 = applyParamsToScript(raw.compiledCode, [
      LAMP_POLICY, TLAMP, UM_POLICY, UM_SCRIPT, BACK_POLICY, BACK_SCRIPT, mspe,
    ]);

    expect(sdk.vaultScript.script).toBe(manual8);
    expect(sdk.vaultScriptHash).toBe(validatorToScriptHash({ type: "PlutusV3", script: manual8 }));
    expect(sdk.vaultScriptHash).not.toBe(validatorToScriptHash({ type: "PlutusV3", script: manual7 }));

    // Tham số #8 thật sự vào bytes: đổi riêng nó là đổi hash.
    const other = applyVaultValidator("Instant", { vaultUnappliedCbor: raw.compiledCode },
      { ...proto, wakemeVaultHash: "77".repeat(28) });
    expect(other.vaultScriptHash).not.toBe(sdk.vaultScriptHash);
  });

  it("Instant: applyVaultValidator thiếu wakemeVaultHash ⟹ ném trước khi apply", async () => {
    const bp = await loadBlueprint("InstantGen");
    const raw = bp.validators.find((v) => v.title === "vault.vault.spend")!;
    const p = { ...protocolFor("Preprod") };
    delete (p as { wakemeVaultHash?: string }).wakemeVaultHash;
    expect(() => applyVaultValidator("Instant", { vaultUnappliedCbor: raw.compiledCode }, p))
      .toThrow(/wakemeVaultHash required/);
  });

  it("applyShardValidator apply ĐÚNG 2 tham số — không phải [] và không phải 1", async () => {
    // Bản cũ của test này chỉ đọc blueprint rồi assert tên tham số; nó KHÔNG hề gọi
    // applyShardValidator, nên revert hàm đó về `[]` vẫn xanh. Nay gọi thật và so
    // hash với các bản apply thiếu tham số: mọi hash phải KHÁC nhau.
    //
    // Bundle phải mang vault THẬT, không phải chính bytes của shard: từ 2026-09-07
    // `applyShardValidator` suy `vault_script_hash` bằng `applyVaultValidator`, nên
    // truyền nhầm bytes vào đó vẫn ra một hash — `applyParamsToScript` không kiểm
    // arity — chỉ là hash của một thứ không tồn tại trên chuỗi.
    const bp = await loadBlueprint("ScheduleGen");
    expect(paramTitles(bp, "vault.shard.spend")).toEqual([
      "shard_policy_id_param", "vault_script_hash",
    ]);

    const shardRaw = bp.validators.find((v) => v.title === "vault.shard.spend")!;
    const vaultRaw = bp.validators.find((v) => v.title === "vault.vault.spend")!;
    const bundle = {
      vaultUnappliedCbor: vaultRaw.compiledCode,
      shardUnappliedCbor: shardRaw.compiledCode,
    };
    const proto = protocolFor("Preview");

    const { shardScriptHash } = applyShardValidator(bundle, proto);
    const emptyHash = validatorToScriptHash({
      type: "PlutusV3",
      script: applyParamsToScript(shardRaw.compiledCode, []),
    });
    const oneParamHash = validatorToScriptHash({
      type: "PlutusV3",
      script: applyParamsToScript(shardRaw.compiledCode, [proto.shardPolicyId!]),
    });
    expect(shardScriptHash).not.toBe(emptyHash);
    expect(shardScriptHash).not.toBe(oneParamHash);
    expect(shardScriptHash).toHaveLength(56);
  });

  it("vault_script_hash mà shard nhận ĐÚNG BẰNG hash của vault Schedule", async () => {
    // Ghim chính phép suy ra. Không có bài này thì `applyShardValidator` truyền một
    // hash bất kỳ vào tham số #2 vẫn xanh — bài trên chỉ đòi "khác bản 1 tham số".
    const bp = await loadBlueprint("ScheduleGen");
    const shardRaw = bp.validators.find((v) => v.title === "vault.shard.spend")!;
    const vaultRaw = bp.validators.find((v) => v.title === "vault.vault.spend")!;
    const bundle = {
      vaultUnappliedCbor: vaultRaw.compiledCode,
      shardUnappliedCbor: shardRaw.compiledCode,
    };
    const proto = protocolFor("Preview");

    const { vaultScriptHash } = applyVaultValidator("Schedule", bundle, proto);
    const expected = validatorToScriptHash({
      type: "PlutusV3",
      script: applyParamsToScript(shardRaw.compiledCode, [
        proto.shardPolicyId!, vaultScriptHash,
      ]),
    });
    expect(applyShardValidator(bundle, proto).shardScriptHash).toBe(expected);
  });

  it("applyShardValidator ném lỗi khi thiếu shardPolicyId — không lặng lẽ apply rỗng", async () => {
    const bp = await loadBlueprint("ScheduleGen");
    const shardRaw = bp.validators.find((v) => v.title === "vault.shard.spend")!;
    const vaultRaw = bp.validators.find((v) => v.title === "vault.vault.spend")!;
    const p = { ...protocolFor("Preview") };
    delete (p as { shardPolicyId?: string }).shardPolicyId;
    expect(() => applyShardValidator(
      { vaultUnappliedCbor: vaultRaw.compiledCode, shardUnappliedCbor: shardRaw.compiledCode },
      p,
    )).toThrow();
  });
});
