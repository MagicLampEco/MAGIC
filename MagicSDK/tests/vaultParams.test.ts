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
import { buildParamsList, applyShardValidator } from "../src/validatorScripts.js";
import type { ProtocolParams } from "../src/types.js";

const LAMP_POLICY = "4942de4a226f43c524c1273d752712366511d5fd7ae28bc1a1576077";
const UM_POLICY   = "11111111111111111111111111111111111111111111111111111111";
const UM_SCRIPT   = "22222222222222222222222222222222222222222222222222222222";
const SHARD_POLC  = "33333333333333333333333333333333333333333333333333333333";
const BACK_POLICY = "44444444444444444444444444444444444444444444444444444444";
const BACK_SCRIPT = "55555555555555555555555555555555555555555555555555555555";

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
  };
}

const params = (t: Parameters<typeof buildParamsList>[0], n: ProtocolParams["network"]) =>
  buildParamsList(t, protocolFor(n), msPerEpoch(n));

describe("buildParamsList: param order matches the Aiken validator signature", () => {
  const MS_PREVIEW = 86_400_000n;

  it("Instant: (lamp_policy_id, lamp_asset_name, um_nft, um_script_hash, backing_nft, backing_script_hash, ms_per_epoch)", () => {
    expect(params("Instant", "Preview")).toEqual([
      LAMP_POLICY, TLAMP, UM_POLICY, UM_SCRIPT, BACK_POLICY, BACK_SCRIPT, MS_PREVIEW,
    ]);
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

  it("applyShardValidator apply ĐÚNG 1 tham số — không phải []", async () => {
    // Bản cũ của test này chỉ đọc blueprint rồi assert tên tham số; nó KHÔNG hề gọi
    // applyShardValidator, nên revert hàm đó về `[]` vẫn xanh. Nay gọi thật và so
    // hash với bản apply `[]`: hai hash phải KHÁC nhau.
    const bp = await loadBlueprint("ScheduleGen");
    const titles = paramTitles(bp, "vault.shard.spend");
    expect(titles).toEqual(["shard_policy_id_param"]);

    const shardRaw = bp.validators.find((v) => v.title === "vault.shard.spend")!;
    const { shardScriptHash } = applyShardValidator(
      { vaultUnappliedCbor: shardRaw.compiledCode, shardUnappliedCbor: shardRaw.compiledCode },
      protocolFor("Preview"),
    );
    const emptyHash = validatorToScriptHash({
      type: "PlutusV3",
      script: applyParamsToScript(shardRaw.compiledCode, []),
    });
    expect(shardScriptHash).not.toBe(emptyHash);
    expect(shardScriptHash).toHaveLength(56);
  });

  it("applyShardValidator ném lỗi khi thiếu shardPolicyId — không lặng lẽ apply rỗng", async () => {
    const bp = await loadBlueprint("ScheduleGen");
    const shardRaw = bp.validators.find((v) => v.title === "vault.shard.spend")!;
    const p = { ...protocolFor("Preview") };
    delete (p as { shardPolicyId?: string }).shardPolicyId;
    expect(() => applyShardValidator(
      { vaultUnappliedCbor: shardRaw.compiledCode, shardUnappliedCbor: shardRaw.compiledCode },
      p,
    )).toThrow();
  });
});
