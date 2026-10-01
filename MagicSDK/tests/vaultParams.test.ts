// MagicSDK/tests/vaultParams.test.ts — pins the compile-time param contract.
//
// buildParamsList output must match the Aiken `validator vault(...)` signature
// POSITION BY POSITION. Nothing else catches a mismatch: applyParamsToScript
// accepts any list, produces a well-formed CBOR, and yields a plausible script
// hash — the error only surfaces as a vault at an address nobody can spend, on
// mainnet, with real LAMP in it.
//
// When you change a validator signature, change this table in the same commit.
// Source of truth (Gen v2.0 — chỉ còn 2 loại két sống):
//   InstantGen/onchain/validators/vault.ak   `validator vault(` — 9 tham số
//   ScheduleGen/onchain/validators/vault.ak  `validator commit(` — 9 tham số (withdraw-zero)
//                                            `validator vault(`  — 6 tham số, #6 = hash `commit`
//
// Gen v2.0 bỏ UM và BackingBeacon khỏi két: bốn tham số um_* / backing_* không còn trong
// chữ ký nào, và `ProtocolParams` mang chúng thì NÉM (ca "trường đời v1" bên dưới).

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { msPerEpoch } from "@magiclamp/protocol-utils";
import { applyParamsToScript, validatorToScriptHash } from "@lucid-evolution/lucid";
import {
  buildParamsList, buildCommitParamsList, applyShardValidator, applyVaultValidator,
} from "../src/validatorScripts.js";
import type { ProtocolParams } from "../src/types.js";

const LAMP_POLICY = "4942de4a226f43c524c1273d752712366511d5fd7ae28bc1a1576077";
const SHARD_POLC  = "33333333333333333333333333333333333333333333333333333333";
const WAKEME_HASH = "66666666666666666666666666666666666666666666666666666666";
const GBB_POLICY  = "88".repeat(28);   // gb_beacon_nft_policy
const GBB_SCRIPT  = "99".repeat(28);   // gb_beacon_script_hash
const GBS_POLICY  = "aa".repeat(28);   // gb_shard_policy_id
const RHO_POLICY  = "bb".repeat(28);   // rate_nft_policy
const RHO_SCRIPT  = "cc".repeat(28);   // rate_script_hash
const COMMIT_HASH = "dd".repeat(28);   // commit_script_hash (Schedule, giá trị giả cho bài danh sách)

const TLAMP = "744c414d50";  // "tLAMP" — testnets
const LAMP  = "4c414d50";    // "LAMP"  — mainnet

function protocolFor(network: ProtocolParams["network"]): ProtocolParams {
  return {
    network,
    lampPolicyId:       LAMP_POLICY,
    shardPolicyId:      SHARD_POLC,
    gbBeaconNftPolicy:  GBB_POLICY,
    gbBeaconScriptHash: GBB_SCRIPT,
    gbShardPolicyId:    GBS_POLICY,
    rateNftPolicy:      RHO_POLICY,
    rateScriptHash:     RHO_SCRIPT,
    wakemeVaultHash:    WAKEME_HASH,
  };
}

const params = (t: Parameters<typeof buildParamsList>[0], n: ProtocolParams["network"]) =>
  buildParamsList(t, protocolFor(n), msPerEpoch(n), t === "Schedule" ? COMMIT_HASH : undefined);

describe("buildParamsList: param order matches the Aiken validator signature", () => {
  const MS_PREVIEW = 86_400_000n;

  it("Instant: (lamp_policy_id, lamp_asset_name, gb_beacon_nft_policy, gb_beacon_script_hash, gb_shard_policy_id, rate_nft_policy, rate_script_hash, wakeme_vault_hash, ms_per_epoch)", () => {
    expect(params("Instant", "Preview")).toEqual([
      LAMP_POLICY, TLAMP, GBB_POLICY, GBB_SCRIPT, GBS_POLICY, RHO_POLICY, RHO_SCRIPT, WAKEME_HASH, MS_PREVIEW,
    ]);
  });

  it("Instant: thiếu wakemeVaultHash ⟹ ném, không apply 8 tham số", () => {
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

  // Mỗi tham số GenBeacons là một lỗ đệm tiềm năng: thiếu mà vẫn apply thì ra một két
  // đọc beacon ở một hash không tồn tại. Hai loại két đòi tập KHÁC nhau — ghim cả hai.
  for (const [vt, field] of [
    ["Instant", "gbBeaconNftPolicy"], ["Instant", "gbBeaconScriptHash"], ["Instant", "gbShardPolicyId"],
    ["Instant", "rateNftPolicy"], ["Instant", "rateScriptHash"],
    ["Schedule", "gbBeaconNftPolicy"], ["Schedule", "gbBeaconScriptHash"], ["Schedule", "gbShardPolicyId"],
    ["Schedule", "rateNftPolicy"], ["Schedule", "rateScriptHash"], ["Schedule", "shardPolicyId"],
  ] as const) {
    it(`${vt}: thiếu ${field} ⟹ ném, không apply`, () => {
      const p = { ...protocolFor("Preview") };
      delete (p as Record<string, unknown>)[field];
      expect(() => buildParamsList(vt, p, msPerEpoch("Preview"), COMMIT_HASH))
        .toThrow(new RegExp(`${field} required for vaultType="${vt}"`));
    });
  }

  // Thay cho bốn cột um_* / backing_* của bảng cũ: ý định "tham số đúng chỗ" của chúng
  // chết theo thiết kế (Gen v2.0 bỏ UM/BackingBeacon). Cái còn phải canh là cấu hình
  // đời cũ vẫn truyền chúng vào — im lặng bỏ qua là để người gọi tưởng két còn đọc UM.
  for (const vt of ["Instant", "Schedule"] as const) {
    it(`${vt}: ProtocolParams mang trường đời v1 (um_*/backing_*) ⟹ ném, nêu đích danh`, () => {
      const p = { ...protocolFor("Preview"), umNftPolicyId: "11".repeat(28), backingScriptHash: "55".repeat(28) };
      expect(() => buildParamsList(vt, p as never, msPerEpoch("Preview"), COMMIT_HASH))
        .toThrow(/trường đời Gen v1 đã bỏ: umNftPolicyId, backingScriptHash/);
    });
  }

  it("Schedule: không đòi wakemeVaultHash (tham số wakeme chỉ có ở Instant)", () => {
    const p = { ...protocolFor("Preview") };
    delete (p as { wakemeVaultHash?: string }).wakemeVaultHash;
    expect(buildParamsList("Schedule", p, msPerEpoch("Preview"), COMMIT_HASH)).toHaveLength(6);
  });

  it("Schedule: thiếu commitScriptHash ⟹ ném, không apply 5 tham số", () => {
    expect(() => buildParamsList("Schedule", protocolFor("Preview"), msPerEpoch("Preview")))
      .toThrow(/commitScriptHash required for vaultType="Schedule"/);
  });

  it("Schedule vault: (lamp_policy_id, lamp_asset_name, shard_policy_id, ms_per_epoch, gb_shard_policy_id, commit_script_hash)", () => {
    expect(params("Schedule", "Preview")).toEqual([
      LAMP_POLICY, TLAMP, SHARD_POLC, MS_PREVIEW, GBS_POLICY, COMMIT_HASH,
    ]);
  });

  it("Schedule commit: (lamp_policy_id, lamp_asset_name, shard_policy_id, ms_per_epoch, gb_beacon_nft_policy, gb_beacon_script_hash, gb_shard_policy_id, rate_nft_policy, rate_script_hash)", () => {
    expect(buildCommitParamsList(protocolFor("Preview"), msPerEpoch("Preview"))).toEqual([
      LAMP_POLICY, TLAMP, SHARD_POLC, MS_PREVIEW, GBB_POLICY, GBB_SCRIPT, GBS_POLICY, RHO_POLICY, RHO_SCRIPT,
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

  it("Schedule commit: Mainnet → \"LAMP\" — `commit` cũng nướng tên tài sản", () => {
    expect(buildCommitParamsList(protocolFor("Mainnet"), msPerEpoch("Mainnet"))[1]).toBe(LAMP);
  });

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

const codeOf = (bp: Blueprint, title: string): string => {
  const v = bp.validators.find((x) => x.title === title);
  if (!v) throw new Error(`validator "${title}" not in blueprint`);
  return v.compiledCode;
};

/** Bundle Schedule: Gen v2.0 đòi blueprint TRỌN (`commit` apply trước két). */
const scheduleBundle = (bp: Blueprint) => ({
  vaultUnappliedCbor: codeOf(bp, "vault.vault.spend"),
  shardUnappliedCbor: codeOf(bp, "vault.shard.spend"),
  vaultPlutusJson:    bp as never,
});

describe("arity gate: SDK param list matches the built blueprint", () => {
  // Bảng tên → giá trị. Đối chiếu THEO TÊN với blueprint, không chỉ theo số lượng:
  // `toHaveLength` cho qua mọi hoán vị, mà hoán vị chính là ca đắt nhất (hash sai,
  // không gì đỏ). Sai một tên ở đây là test đỏ ngay, chứ không phải mainnet đỏ.
  const BY_NAME: Record<string, unknown> = {
    lamp_policy_id:        LAMP_POLICY,
    lamp_asset_name:       TLAMP,
    gb_beacon_nft_policy:  GBB_POLICY,
    gb_beacon_script_hash: GBB_SCRIPT,
    gb_shard_policy_id:    GBS_POLICY,
    rate_nft_policy:       RHO_POLICY,
    rate_script_hash:      RHO_SCRIPT,
    shard_policy_id:       SHARD_POLC,
    ms_per_epoch:          86_400_000n,
    wakeme_vault_hash:     WAKEME_HASH,
    commit_script_hash:    COMMIT_HASH,
  };

  const against = (titles: string[], got: unknown[]) => {
    const unknown = titles.filter((t) => !(t in BY_NAME));
    expect(unknown, `tham số blueprint chưa có trong BY_NAME: ${unknown.join(", ")}`).toEqual([]);
    expect(got).toEqual(titles.map((t) => BY_NAME[t]));
  };

  for (const [vaultType, module] of [
    ["Instant", "InstantGen"], ["Schedule", "ScheduleGen"],
  ] as const) {
    it(`${vaultType}: buildParamsList khớp blueprint theo TÊN và THỨ TỰ`, async () => {
      against(paramTitles(await loadBlueprint(module), "vault.vault.spend"), params(vaultType, "Preview"));
    });
  }

  it("Schedule: buildCommitParamsList khớp blueprint `vault.commit.withdraw` theo TÊN và THỨ TỰ", async () => {
    against(
      paramTitles(await loadBlueprint("ScheduleGen"), "vault.commit.withdraw"),
      buildCommitParamsList(protocolFor("Preview"), msPerEpoch("Preview")),
    );
  });

  it("Instant: bytes SDK apply ĐÚNG BẰNG bytes apply tay 9 tham số — và KHÁC bản 8 tham số", async () => {
    // Bảng BY_NAME ở trên chỉ so DANH SÁCH; bài này so BYTES script cuối cùng, tức thứ
    // quyết định địa chỉ vault. Danh sách 9 phần tử viết TAY theo chữ ký `validator vault(...)`,
    // không đi qua `buildParamsList`, để hai phía không cùng sai theo một hiểu lầm.
    const bp = await loadBlueprint("InstantGen");
    const code = codeOf(bp, "vault.vault.spend");
    const proto = protocolFor("Preprod");
    const mspe = msPerEpoch("Preprod");

    const sdk = applyVaultValidator("Instant", { vaultUnappliedCbor: code }, proto);
    const manual9 = applyParamsToScript(code, [
      LAMP_POLICY, TLAMP, GBB_POLICY, GBB_SCRIPT, GBS_POLICY, RHO_POLICY, RHO_SCRIPT, WAKEME_HASH, mspe,
    ]);
    const manual8 = applyParamsToScript(code, [
      LAMP_POLICY, TLAMP, GBB_POLICY, GBB_SCRIPT, GBS_POLICY, RHO_POLICY, RHO_SCRIPT, WAKEME_HASH,
    ]);

    expect(sdk.vaultScript.script).toBe(manual9);
    expect(sdk.vaultScriptHash).toBe(validatorToScriptHash({ type: "PlutusV3", script: manual9 }));
    expect(sdk.vaultScriptHash).not.toBe(validatorToScriptHash({ type: "PlutusV3", script: manual8 }));
    expect(sdk.commitScriptHash).toBeUndefined();   // `commit` chỉ có ở két Schedule

    // Tham số wakeme thật sự vào bytes: đổi riêng nó là đổi hash.
    const other = applyVaultValidator("Instant", { vaultUnappliedCbor: code },
      { ...proto, wakemeVaultHash: "77".repeat(28) });
    expect(other.vaultScriptHash).not.toBe(sdk.vaultScriptHash);
  });

  it("Instant: applyVaultValidator thiếu wakemeVaultHash ⟹ ném trước khi apply", async () => {
    const bp = await loadBlueprint("InstantGen");
    const p = { ...protocolFor("Preprod") };
    delete (p as { wakemeVaultHash?: string }).wakemeVaultHash;
    expect(() => applyVaultValidator("Instant", { vaultUnappliedCbor: codeOf(bp, "vault.vault.spend") }, p))
      .toThrow(/wakemeVaultHash required/);
  });

  it("Schedule: bytes SDK = apply tay `commit` 9 tham số → hash → két 6 tham số, hash `commit` ở #6", async () => {
    // Cùng tinh thần bài Instant: danh sách viết TAY theo chữ ký hai validator. Ghim luôn
    // chuỗi phụ thuộc — két nướng hash của CHÍNH `commit` vừa apply, không phải một hash bất kỳ.
    const bp = await loadBlueprint("ScheduleGen");
    const proto = protocolFor("Preview");
    const mspe = msPerEpoch("Preview");

    const commit9 = applyParamsToScript(codeOf(bp, "vault.commit.withdraw"), [
      LAMP_POLICY, TLAMP, SHARD_POLC, mspe, GBB_POLICY, GBB_SCRIPT, GBS_POLICY, RHO_POLICY, RHO_SCRIPT,
    ]);
    const commitHash = validatorToScriptHash({ type: "PlutusV3", script: commit9 });
    const vault6 = applyParamsToScript(codeOf(bp, "vault.vault.spend"), [
      LAMP_POLICY, TLAMP, SHARD_POLC, mspe, GBS_POLICY, commitHash,
    ]);

    const sdk = applyVaultValidator("Schedule", scheduleBundle(bp), proto);
    expect(sdk.commitScript?.script).toBe(commit9);
    expect(sdk.commitScriptHash).toBe(commitHash);
    expect(sdk.vaultScript.script).toBe(vault6);
    expect(sdk.vaultScriptHash).toBe(validatorToScriptHash({ type: "PlutusV3", script: vault6 }));

    // Tham số chỉ `commit` nhận (ρ) vẫn đổi được hash két — qua hash `commit` ở #6.
    const other = applyVaultValidator("Schedule", scheduleBundle(bp), { ...proto, rateScriptHash: "ee".repeat(28) });
    expect(other.commitScriptHash).not.toBe(sdk.commitScriptHash);
    expect(other.vaultScriptHash).not.toBe(sdk.vaultScriptHash);
  });

  it("Schedule: applyVaultValidator thiếu vaultPlutusJson ⟹ ném, không apply két mà thiếu `commit`", async () => {
    const bp = await loadBlueprint("ScheduleGen");
    const { vaultPlutusJson: _drop, ...noJson } = scheduleBundle(bp);
    expect(() => applyVaultValidator("Schedule", noJson, protocolFor("Preview")))
      .toThrow(/vaultPlutusJson required for vaultType="Schedule"/);
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

    const shardCode = codeOf(bp, "vault.shard.spend");
    const proto = protocolFor("Preview");

    const { shardScriptHash } = applyShardValidator(scheduleBundle(bp), proto);
    const emptyHash = validatorToScriptHash({
      type: "PlutusV3",
      script: applyParamsToScript(shardCode, []),
    });
    const oneParamHash = validatorToScriptHash({
      type: "PlutusV3",
      script: applyParamsToScript(shardCode, [proto.shardPolicyId!]),
    });
    expect(shardScriptHash).not.toBe(emptyHash);
    expect(shardScriptHash).not.toBe(oneParamHash);
    expect(shardScriptHash).toHaveLength(56);
  });

  it("vault_script_hash mà shard nhận ĐÚNG BẰNG hash của vault Schedule", async () => {
    // Ghim chính phép suy ra. Không có bài này thì `applyShardValidator` truyền một
    // hash bất kỳ vào tham số #2 vẫn xanh — bài trên chỉ đòi "khác bản 1 tham số".
    const bp = await loadBlueprint("ScheduleGen");
    const bundle = scheduleBundle(bp);
    const proto = protocolFor("Preview");

    const { vaultScriptHash } = applyVaultValidator("Schedule", bundle, proto);
    const expected = validatorToScriptHash({
      type: "PlutusV3",
      script: applyParamsToScript(codeOf(bp, "vault.shard.spend"), [
        proto.shardPolicyId!, vaultScriptHash,
      ]),
    });
    expect(applyShardValidator(bundle, proto).shardScriptHash).toBe(expected);
  });

  it("applyShardValidator ném lỗi khi thiếu shardPolicyId — không lặng lẽ apply rỗng", async () => {
    const bp = await loadBlueprint("ScheduleGen");
    const p = { ...protocolFor("Preview") };
    delete (p as { shardPolicyId?: string }).shardPolicyId;
    expect(() => applyShardValidator(scheduleBundle(bp), p)).toThrow(/shardPolicyId required/);
  });
});
