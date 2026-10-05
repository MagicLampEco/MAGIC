// MagicSDK/tests/ownerScript.test.ts — nhánh chủ `Script(h)` ở các bộ dựng của SDK.
//
// Chưa DID nào đăng ký stake trên Preprod, nên nhánh này chỉ kiểm được bằng giả lập: một
// `lucid` ghi lại mọi lượt gọi trên trình dựng. Thứ khẳng định là HÌNH DẠNG giao dịch SDK
// yêu cầu (mục rút, script đính, ai ký), không phải việc chuỗi có nhận nó không.
//
// Mỗi nhánh có CẶP ca: chủ script ⟹ mục rút + KHÔNG ký bằng h; chủ khoá ⟹ ký bằng pkh +
// KHÔNG mục rút. Một ca đơn lẻ xanh được ở cả hai cực đột biến "luôn đi nhánh X".

import { Data, validatorToScriptHash, type LucidEvolution, type UTxO, type Validator } from "@lucid-evolution/lucid";
import { epochStartMs, posixMsToEpoch, OwnerAuthError } from "@magiclamp/protocol-utils";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { withdrawLamp } from "../src/withdrawLamp.js";
import { updateProfile } from "../src/updateProfile.js";
import { createVault } from "../src/createVault.js";
import { listVaultsForOwner } from "../src/listVaults.js";
import { buildVaultBurnBatch } from "../src/burnBatch.js";
import { didStakeOwnerAuthLucid } from "../src/didStakeLucid.js";
import { ACCEPT_INLINE_SCRIPT_CEILING } from "../src/refScript.js";
import { buildInitialVaultDatum } from "../src/vaultDatum.js";
import { InstantVaultDatumSchema, VaultDatumSchema } from "../src/schemas.js";
import { applyVaultValidator } from "../src/validatorScripts.js";

const LAMP_POLICY = "4942de4a226f43c524c1273d752712366511d5fd7ae28bc1a1576077";
const LAMP_UNIT = `${LAMP_POLICY}744c414d50`;
// Preview chưa có gốc cửa sổ (`WIN-PREVIEW`, LAMP `Specs/Window/CONTRACT.md` v1.0 §4) và các bộ
// dựng tính epoch theo mạng ⟹ fixture chạy trên Preprod, mốc tip tính TỪ GỐC (`epochStartMs`).
const TIP_MS = epochStartMs(60n, "Preprod");
const CUR_EPOCH = posixMsToEpoch(TIP_MS, "Preprod");

// Hai "script did_stake" giả: chỉ cần băm được, không cần chạy.
const DID_SCRIPT = "4746010000222220";
const OTHER_DID_SCRIPT = "49480100002221200101";
const DID_H = validatorToScriptHash({ type: "PlutusV3", script: DID_SCRIPT });
const CTRL = "a1".repeat(28);
const DEV = "b2".repeat(28);
const PKH = DID_H;   // CÙNG 28 byte với script chủ — để chứng minh tag được so.
const ANCHOR = {
  txHash: "ee".repeat(32), outputIndex: 1, address: "addr_test1wqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahga0t3ee",
  assets: { lovelace: 2_000_000n }, datum: null, datumHash: null, scriptRef: null,
} as UTxO;

const VAULT_SCRIPT: Validator = { type: "PlutusV3", script: "4746010000222220" };
const PLUTUS_JSON = {
  validators: [{ title: "vault.vault.spend", redeemer: { schema: { $ref: "#/definitions/vault~1VaultRedeemer" } } }],
  definitions: {
    "vault/VaultRedeemer": {
      anyOf: [
        { title: "InstantGen", index: 0, fields: [] },
        { title: "BurnBatch", index: 1, fields: [] },
        { title: "WithdrawLamp", index: 2, fields: [] },
        { title: "UpdateProfile", index: 3, fields: [] },
      ],
    },
  },
} as never;

const REWARD = async () => ({ registered: true, withdrawableLovelace: 5n });

function scriptAuth(script = DID_SCRIPT) {
  return didStakeOwnerAuthLucid({
    owner: { type: "script", hash: DID_H },
    didStakeScriptCbor: script,
    anchorRefUtxo: ANCHOR,
    controllerPkh: CTRL,
    deviceKeyHash: DEV,
    network: "Preprod",
  }, REWARD);
}

type Owner = { type: "key" | "script"; hash: string };

function vaultUtxo(kind: "Instant" | "Schedule", owner: Owner, ix = 0, over: Record<string, unknown> = {}): UTxO {
  const d = {
    ...buildInitialVaultDatum({
      owner, lampBalanceOildrop: 1_000_000_000n, profile: "Flame",
      currentEpoch: CUR_EPOCH - 10n, vaultType: kind,
    }),
    ...over,
  };
  return {
    txHash: "bb".repeat(32), outputIndex: ix,
    address: "addr_test1wqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahga0t3ee",
    assets: { lovelace: 20_000_000n, [LAMP_UNIT]: 1_000_000_000n },
    datum: Data.to(d as never, kind === "Instant" ? InstantVaultDatumSchema : VaultDatumSchema),
    datumHash: null, scriptRef: null,
  } as UTxO;
}

/** Trình dựng ghi lại TÊN + THAM SỐ mọi lượt gọi. Gọi bề mặt lạ vẫn ghi (không ném) — các
 *  bài dưới khẳng định trên nội dung ghi được, không dựa vào việc "không ném". */
function recordingLucid(walletUtxos: UTxO[] = []) {
  const calls: Array<[string, unknown[]]> = [];
  let newTxCount = 0;
  const proxy: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (prop === "attach" || prop === "pay") {
        return new Proxy({}, { get(_x, sub) { return (...a: unknown[]) => { calls.push([`${String(prop)}.${String(sub)}`, a]); return proxy; }; } });
      }
      if (prop === "complete") return async () => ({ __fake: true });
      return (...a: unknown[]) => { calls.push([String(prop), a]); return proxy; };
    },
  });
  const lucid = {
    newTx: () => { newTxCount++; return proxy; },
    wallet: () => ({
      address: async () => "addr_test1vqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahgwq9x0u",
      getUtxos: async () => walletUtxos,
    }),
  } as unknown as LucidEvolution;
  const names = () => calls.map(c => c[0]);
  const argsOf = (n: string) => calls.filter(c => c[0] === n).map(c => c[1]);
  return { lucid, calls, names, argsOf, newTxCount: () => newTxCount };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return "KHÔNG NÉM"; } catch (e) {
    return e instanceof OwnerAuthError ? e.code : `KHÁC: ${(e as Error).message.slice(0, 80)}`;
  }
}

const baseWithdraw = {
  amountOildrop: 1_000_000n, vaultScript: VAULT_SCRIPT, vaultType: "Schedule" as const,
  vaultPlutusJson: PLUTUS_JSON, network: "Preprod" as const, lampPolicyId: LAMP_POLICY,
  destinationAddress: "addr_test1vqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahgwq9x0u",
  vaultRefScriptUtxo: ACCEPT_INLINE_SCRIPT_CEILING, tipPosixMs: TIP_MS,
};

describe("didStakeOwnerAuthLucid — hash THẬT (blake2b_224 qua Lucid)", () => {
  it("script băm đúng chủ ⟹ nhận; địa chỉ thưởng là stake_test của đúng h", async () => {
    const a = await scriptAuth();
    expect(a.hash).toBe(DID_H);
    expect(a.details.rewardAddress.startsWith("stake_test1")).toBe(true);
  });
  it("CỰC ĐỐI: script khác ⟹ OWNER_AUTH_MISMATCH", async () => {
    expect(await codeOf(scriptAuth(OTHER_DID_SCRIPT))).toBe("OWNER_AUTH_MISMATCH");
  });
});

describe("withdrawLamp — nhánh chủ", () => {
  it("chủ script + nhân chứng ⟹ rút đúng số dư, đính did_stake, ký controller+device, KHÔNG ký h", async () => {
    const r = recordingLucid();
    await withdrawLamp({ ...baseWithdraw, lucid: r.lucid, vaultUtxo: vaultUtxo("Schedule", { type: "script", hash: DID_H }), ownerAuth: await scriptAuth() } as never);
    const w = r.argsOf("withdraw");
    expect(w).toHaveLength(1);
    expect(w[0]![1]).toBe(5n);
    expect(w[0]![2]).toBe("d87980");
    expect(r.argsOf("attach.WithdrawalValidator")).toEqual([[{ type: "PlutusV3", script: DID_SCRIPT }]]);
    expect(r.argsOf("addSignerKey")).toEqual([[CTRL], [DEV]]);
    expect(r.argsOf("readFrom")).toContainEqual([[ANCHOR]]);
  });
  it("CỰC ĐỐI: chủ script, KHÔNG nhân chứng ⟹ OWNER_SCRIPT_WITNESS_UNAVAILABLE", async () => {
    const r = recordingLucid();
    expect(await codeOf(withdrawLamp({ ...baseWithdraw, lucid: r.lucid, vaultUtxo: vaultUtxo("Schedule", { type: "script", hash: DID_H }) } as never)))
      .toBe("OWNER_SCRIPT_WITNESS_UNAVAILABLE");
  });
  it("CỰC ĐỐI: chủ KHOÁ cùng 28 byte + nhân chứng script ⟹ OWNER_AUTH_MISMATCH", async () => {
    const r = recordingLucid();
    expect(await codeOf(withdrawLamp({ ...baseWithdraw, lucid: r.lucid, vaultUtxo: vaultUtxo("Schedule", { type: "key", hash: PKH }), ownerAuth: await scriptAuth() } as never)))
      .toBe("OWNER_AUTH_MISMATCH");
  });
  it("CẶP: chủ khoá, không nhân chứng ⟹ addSignerKey(pkh), KHÔNG mục rút", async () => {
    const r = recordingLucid();
    await withdrawLamp({ ...baseWithdraw, lucid: r.lucid, vaultUtxo: vaultUtxo("Schedule", { type: "key", hash: PKH }) } as never);
    expect(r.argsOf("addSignerKey")).toEqual([[PKH]]);
    expect(r.names()).not.toContain("withdraw");
  });
});

describe("updateProfile — nhánh chủ", () => {
  const base = {
    newProfile: "Ember" as const, vaultScript: VAULT_SCRIPT, vaultType: "Instant" as const,
    vaultPlutusJson: PLUTUS_JSON, network: "Preprod" as const,
    vaultRefScriptUtxo: ACCEPT_INLINE_SCRIPT_CEILING, tipPosixMs: TIP_MS,
  };
  // Gen v2.0: két đã làm mới checkpoint TRONG epoch này (`cap_epoch == e`) ⟹ không đọc beacon ρ.
  // Khối này kiểm nhánh CHỦ, không kiểm làm mới checkpoint — để genesis `cap_epoch = 0` thì
  // bài vấp `GEN-INST-011` trước cổng chủ và cặp cực đối dưới đây mất nghĩa.
  const FRESH = { cap_epoch: CUR_EPOCH, usage_window_epoch: CUR_EPOCH };
  it("chủ script + nhân chứng ⟹ mục rút, không ký h", async () => {
    const r = recordingLucid();
    await updateProfile({ ...base, lucid: r.lucid, vaultUtxo: vaultUtxo("Instant", { type: "script", hash: DID_H }, 0, FRESH), ownerAuth: await scriptAuth() } as never);
    expect(r.names()).toContain("withdraw");
    expect(r.argsOf("addSignerKey").flat()).not.toContain(DID_H);
  });
  it("CỰC ĐỐI: chủ script, không nhân chứng ⟹ OWNER_SCRIPT_WITNESS_UNAVAILABLE", async () => {
    const r = recordingLucid();
    expect(await codeOf(updateProfile({ ...base, lucid: r.lucid, vaultUtxo: vaultUtxo("Instant", { type: "script", hash: DID_H }, 0, FRESH) } as never)))
      .toBe("OWNER_SCRIPT_WITNESS_UNAVAILABLE");
  });
});

describe("createVault — chủ Credential ở genesis", () => {
  const walletUtxo = {
    txHash: "dd".repeat(32), outputIndex: 0,
    address: "addr_test1vqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahgwq9x0u",
    assets: { lovelace: 50_000_000n, [LAMP_UNIT]: 5_000_000_000n },
    datum: null, datumHash: null, scriptRef: null,
  } as UTxO;
  const vaultHash = validatorToScriptHash(VAULT_SCRIPT);
  const base = {
    vaultType: "Schedule" as const,
    protocol: { network: "Preprod" as const, lampPolicyId: LAMP_POLICY },
    appliedVault: { script: VAULT_SCRIPT, expectedScriptHash: vaultHash },
    vaultRefScriptUtxo: ACCEPT_INLINE_SCRIPT_CEILING,
    tipPosixMs: TIP_MS,
  };
  const outDatumOwner = (r: ReturnType<typeof recordingLucid>) => {
    const out = r.argsOf("pay.ToAddressWithData")[0]!;
    const d = Data.from((out[1] as { value: string }).value, VaultDatumSchema) as unknown as { owner: unknown };
    return d.owner;
  };

  // ── Dây nối CIP-33: script vault InstantGen ~14,5 KB; inline cùng did_payment + did_stake vượt trần
  //    16 384 byte (đo trên Preprod 2026-10-05: tx 21 385 byte). Genesis phải ĐỌC ref.
  const refUtxo = (script: Validator) => ({
    txHash: "ee".repeat(32), outputIndex: 0,
    address: "addr_test1vqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahgwq9x0u",
    assets: { lovelace: 20_000_000n }, datum: null, datumHash: null, scriptRef: script,
  } as UTxO);
  const OTHER_VAULT_SCRIPT: Validator = { type: "PlutusV3", script: OTHER_DID_SCRIPT };

  it("🔴 có ref UTxO script vault ⟹ readFrom ĐÚNG UTxO đó, KHÔNG attach.MintingPolicy", async () => {
    const r = recordingLucid([walletUtxo]);
    const ref = refUtxo(VAULT_SCRIPT);
    await createVault({ ...base, vaultRefScriptUtxo: ref, lucid: r.lucid, vault: { ownerPkh: PKH, lampDeposit: 1_000_000_000n } } as never);
    expect(r.argsOf("readFrom")).toContainEqual([[ref]]);
    expect(r.names()).not.toContain("attach.MintingPolicy");
  });

  it("CỰC ĐỐI: chọn inline TƯỜNG MINH ⟹ attach.MintingPolicy, KHÔNG readFrom", async () => {
    const r = recordingLucid([walletUtxo]);
    await createVault({ ...base, lucid: r.lucid, vault: { ownerPkh: PKH, lampDeposit: 1_000_000_000n } } as never);
    expect(r.argsOf("attach.MintingPolicy")).toEqual([[VAULT_SCRIPT]]);
    expect(r.names()).not.toContain("readFrom");
  });

  it("🔴 ref UTxO mang script KHÁC ⟹ NÉM trước khi dựng tx", async () => {
    const r = recordingLucid([walletUtxo]);
    await expect(createVault({ ...base, vaultRefScriptUtxo: refUtxo(OTHER_VAULT_SCRIPT), lucid: r.lucid, vault: { ownerPkh: PKH, lampDeposit: 1_000_000_000n } } as never))
      .rejects.toThrow(/vault \(createVault\)/);
    expect(r.newTxCount()).toBe(0);
  });

  it("bí danh ownerPkh ⟹ datum VerificationKey, ký pkh, mint 1 NFT, KHÔNG mục rút", async () => {
    const r = recordingLucid([walletUtxo]);
    const res = await createVault({ ...base, lucid: r.lucid, vault: { ownerPkh: PKH, lampDeposit: 1_000_000_000n } } as never);
    expect(outDatumOwner(r)).toEqual({ VerificationKey: [PKH] });
    expect(r.argsOf("addSignerKey")).toEqual([[PKH]]);
    expect(r.names()).not.toContain("withdraw");
    expect(r.argsOf("mintAssets")).toEqual([[{ [res.vaultIdUnit]: 1n }, expect.any(String)]]);
    expect(res.owner).toEqual({ type: "key", hash: PKH });
  });

  it("chủ script + nhân chứng ⟹ datum Script, mục rút Script(h), KHÔNG ký h", async () => {
    const r = recordingLucid([walletUtxo]);
    const res = await createVault({ ...base, lucid: r.lucid, vault: { owner: { type: "script", hash: DID_H }, lampDeposit: 1_000_000_000n }, ownerAuth: await scriptAuth() } as never);
    expect(outDatumOwner(r)).toEqual({ Script: [DID_H] });
    expect(r.argsOf("withdraw")).toHaveLength(1);
    expect(r.argsOf("addSignerKey")).toEqual([[CTRL], [DEV]]);
    expect(res.owner).toEqual({ type: "script", hash: DID_H });
  });

  it("CỰC ĐỐI: chủ script KHÔNG nhân chứng ⟹ ném TRƯỚC khi dựng tx", async () => {
    const r = recordingLucid([walletUtxo]);
    expect(await codeOf(createVault({ ...base, lucid: r.lucid, vault: { owner: { type: "script", hash: DID_H }, lampDeposit: 1n } } as never)))
      .toBe("OWNER_SCRIPT_WITNESS_UNAVAILABLE");
    expect(r.newTxCount()).toBe(0);
  });

  it("CỰC ĐỐI: owner và ownerPkh cùng có mà KHÁC chủ ⟹ OWNER_AUTH_MISMATCH", async () => {
    const r = recordingLucid([walletUtxo]);
    expect(await codeOf(createVault({ ...base, lucid: r.lucid, vault: { owner: { type: "script", hash: DID_H }, ownerPkh: PKH, lampDeposit: 1n } } as never)))
      .toBe("OWNER_AUTH_MISMATCH");
  });

  it("CỰC ĐỐI: appliedVault băm khác expectedScriptHash ⟹ ném; truyền cả validators ⟹ ném", async () => {
    const r = recordingLucid([walletUtxo]);
    await expect(createVault({ ...base, lucid: r.lucid, appliedVault: { script: VAULT_SCRIPT, expectedScriptHash: "00".repeat(28) }, vault: { ownerPkh: PKH, lampDeposit: 1n } } as never))
      .rejects.toThrow(/NGOÀI lần deploy/);
    await expect(createVault({ ...base, lucid: r.lucid, validators: { vaultUnappliedCbor: "00" }, vault: { ownerPkh: PKH, lampDeposit: 1n } } as never))
      .rejects.toThrow(/ĐÚNG MỘT/);
    expect(r.newTxCount()).toBe(0);
  });
});

describe("listVaultsForOwner — lọc theo owner {type, hash}", () => {
  // Gen v2.0: két Schedule nướng hash `commit` nên `applyVaultValidator` đòi blueprint TRỌN
  // (`vault.commit.withdraw` + `vault.vault.spend`) — stub một validator không còn dựng
  // được địa chỉ. Dùng blueprint ScheduleGen đã build; chỉ để ra một địa chỉ két.
  const bp = JSON.parse(readFileSync(
    fileURLToPath(new URL("../../ScheduleGen/onchain/plutus.json", import.meta.url)), "utf8",
  )) as { validators: { title: string; compiledCode: string }[] };
  const protocol = {
    network: "Preprod" as const, lampPolicyId: LAMP_POLICY, shardPolicyId: "11".repeat(28),
    gbBeaconNftPolicy: "12".repeat(28), gbBeaconScriptHash: "13".repeat(28), gbShardPolicyId: "14".repeat(28),
    rateNftPolicy: "15".repeat(28), rateScriptHash: "16".repeat(28),
  };
  const validators = {
    vaultUnappliedCbor: bp.validators.find(v => v.title === "vault.vault.spend")!.compiledCode,
    vaultPlutusJson:    bp as never,
  };
  const utxos = [vaultUtxo("Schedule", { type: "key", hash: PKH }, 0), vaultUtxo("Schedule", { type: "script", hash: DID_H }, 1)];
  const lucid = { utxosAt: async () => utxos } as unknown as LucidEvolution;

  it("script ⟹ đúng két chủ script; bí danh ownerPkh ⟹ đúng két chủ khoá (cùng 28 byte)", async () => {
    // Đảm bảo stub apply được trước khi đổ lỗi cho bộ lọc.
    applyVaultValidator("Schedule", validators, protocol);
    const s = await listVaultsForOwner({ lucid, vaultType: "Schedule", protocol, validators, owner: { type: "script", hash: DID_H } });
    const k = await listVaultsForOwner({ lucid, vaultType: "Schedule", protocol, validators, ownerPkh: PKH });
    expect(s.map(v => v.vaultId)).toEqual([`${"bb".repeat(32)}#1`]);
    expect(k.map(v => v.vaultId)).toEqual([`${"bb".repeat(32)}#0`]);
  });
});

describe("buildVaultBurnBatch — đối chiếu chủ trước khi tính", () => {
  const p = (owner: Owner) => ({
    vaultUtxo: vaultUtxo("Schedule", owner), required: 1n, currentEpoch: CUR_EPOCH,
    vaultModule: "ScheduleGen" as const, vaultPlutusJson: PLUTUS_JSON,
  });
  it("CỰC ĐỐI: chủ script, không nhân chứng ⟹ OWNER_SCRIPT_WITNESS_UNAVAILABLE", async () => {
    expect(await codeOf((async () => buildVaultBurnBatch(p({ type: "script", hash: DID_H })))()))
      .toBe("OWNER_SCRIPT_WITNESS_UNAVAILABLE");
  });
  it("có nhân chứng ⟹ qua cổng chủ, dừng ở cổng MAGIC (két rỗng) — lỗi KHÔNG phải OwnerAuthError", async () => {
    const a = await scriptAuth();
    const c = await codeOf((async () => buildVaultBurnBatch({ ...p({ type: "script", hash: DID_H }), ownerAuth: a }))());
    expect(c.startsWith("KHÁC:")).toBe(true);
  });
});
