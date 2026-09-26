// MagicSDK/tests/didPaymentFunding.test.ts — `createVault({ funding })`: nạp LAMP từ ví Phoenix.
//
// `lucid` ghi lại mọi lượt gọi trên trình dựng (cùng khuôn với `ownerScript.test.ts`). Thứ
// khẳng định là HÌNH DẠNG giao dịch SDK yêu cầu: UTxO did_payment nào bị chi, với redeemer
// nào, phần thối về đâu, ai ký — không phải việc chuỗi có nhận nó không.

import { Data, credentialToAddress, scriptHashToCredential, validatorToScriptHash, type LucidEvolution, type UTxO, type Validator } from "@lucid-evolution/lucid";
import { FundingError, OwnerAuthError, msPerEpoch, planDidPaymentFunding } from "@magiclamp/protocol-utils";
import { describe, expect, it } from "vitest";

import { createVault } from "../src/createVault.js";
import { didPaymentLucidPorts } from "../src/didPaymentLucid.js";
import { didStakeOwnerAuthLucid } from "../src/didStakeLucid.js";
import { VaultDatumSchema } from "../src/schemas.js";

const LAMP_POLICY = "4942de4a226f43c524c1273d752712366511d5fd7ae28bc1a1576077";
const LAMP_UNIT = `${LAMP_POLICY}744c414d50`;
const TIP_MS = 60n * msPerEpoch("Preview");
const VAULT_SCRIPT: Validator = { type: "PlutusV3", script: "4746010000222220" };
const DID_STAKE = "4746010000222220";
const DID_H = validatorToScriptHash({ type: "PlutusV3", script: DID_STAKE });
const DP_SCRIPT = "49480100002221200101";
const DP_ADDRESS = credentialToAddress("Preview", scriptHashToCredential(validatorToScriptHash({ type: "PlutusV3", script: DP_SCRIPT })));
const FEE_ADDRESS = "addr_test1vqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahgwq9x0u";
const CTRL = "a1".repeat(28);
const DEV = "b2".repeat(28);
const PKH = "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21";

const u = (txHash: string, ix: number, address: string, assets: Record<string, bigint>): UTxO =>
  ({ txHash, outputIndex: ix, address, assets, datum: null, datumHash: null, scriptRef: null }) as UTxO;
const FEE_UTXO = u("fa".repeat(32), 0, FEE_ADDRESS, { lovelace: 10_000_000n });
const ANCHOR = u("ee".repeat(32), 1, DP_ADDRESS, { lovelace: 2_000_000n });
const DP_BIG = u("d1".repeat(32), 0, DP_ADDRESS, { lovelace: 6_000_000n, [LAMP_UNIT]: 900_000_000n, [`${"77".repeat(28)}aa`]: 3n });
const DP_MID = u("d2".repeat(32), 0, DP_ADDRESS, { lovelace: 3_000_000n, [LAMP_UNIT]: 500_000_000n });
const DP_DUST = u("d3".repeat(32), 0, DP_ADDRESS, { lovelace: 2_000_000n, [LAMP_UNIT]: 1n });

function recordingLucid(walletUtxos: UTxO[]) {
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
    config: () => ({ protocolParameters: { coinsPerUtxoByte: 4310n } }),
    wallet: () => ({ address: async () => FEE_ADDRESS, getUtxos: async () => walletUtxos }),
  } as unknown as LucidEvolution;
  const argsOf = (n: string) => calls.filter(c => c[0] === n).map(c => c[1]);
  return { lucid, argsOf, names: () => calls.map(c => c[0]), newTxCount: () => newTxCount };
}

const funding = (over: Record<string, unknown> = {}) => ({
  didPaymentScriptCbor: DP_SCRIPT, address: DP_ADDRESS, utxos: [DP_DUST, DP_MID, DP_BIG],
  anchorRefUtxo: ANCHOR, controllerPkh: CTRL, deviceKeyHash: DEV, ...over,
});
const base = {
  vaultType: "Schedule" as const,
  protocol: { network: "Preview" as const, lampPolicyId: LAMP_POLICY },
  appliedVault: { script: VAULT_SCRIPT, expectedScriptHash: validatorToScriptHash(VAULT_SCRIPT) },
  tipPosixMs: TIP_MS,
};
const scriptAuth = (ctrl = CTRL) => didStakeOwnerAuthLucid({
  owner: { type: "script", hash: DID_H }, didStakeScriptCbor: DID_STAKE, anchorRefUtxo: ANCHOR,
  controllerPkh: ctrl, deviceKeyHash: DEV, network: "Preview",
}, async () => ({ registered: true, withdrawableLovelace: 0n }));

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return "KHÔNG NÉM"; } catch (e) {
    return e instanceof FundingError || e instanceof OwnerAuthError ? e.code : `KHÁC: ${(e as Error).message.slice(0, 80)}`;
  }
}

describe("createVault + funding did_payment", () => {
  it("chủ khoá: seed = UTxO ví trả phí; chi ĐÚNG UTxO LAMP lớn nhất, redeemer Spend; thối về ví Phoenix; ký pkh + controller + thiết bị", async () => {
    const r = recordingLucid([FEE_UTXO]);
    const res = await createVault({ ...base, lucid: r.lucid, vault: { ownerPkh: PKH, lampDeposit: 800_000_000n }, funding: funding() } as never);
    const collects = r.argsOf("collectFrom");
    expect(collects[0]).toEqual([[FEE_UTXO]]);
    expect(collects[1]).toEqual([[DP_BIG], "d87980"]);     // một UTxO là đủ — không kéo DP_MID/DP_DUST
    expect(r.argsOf("attach.SpendingValidator")).toEqual([[{ type: "PlutusV3", script: DP_SCRIPT }]]);
    const vaultOut = r.argsOf("pay.ToAddressWithData")[0]![2] as Record<string, bigint>;
    const [[retAddr, ret]] = r.argsOf("pay.ToAddress") as [[string, Record<string, bigint>]];
    expect(retAddr).toBe(DP_ADDRESS);
    expect(ret).toEqual({
      lovelace: DP_BIG.assets.lovelace! - vaultOut.lovelace!,
      [LAMP_UNIT]: 100_000_000n,
      [`${"77".repeat(28)}aa`]: 3n,
    });
    expect(r.argsOf("readFrom")).toEqual([[[ANCHOR]]]);
    expect(r.argsOf("addSignerKey")).toEqual([[CTRL], [DEV], [PKH]]);
    expect(r.argsOf("validTo")).toEqual([[Number(TIP_MS + 3_600_000n)]]);
    expect(res.funding?.selected).toEqual([DP_BIG]);
    expect(res.seedUtxo).toBe(FEE_UTXO);
  });

  it("CẶP: không funding ⟹ không chi did_payment, không redeemer, không validTo (đường cũ)", async () => {
    const r = recordingLucid([u("fb".repeat(32), 0, FEE_ADDRESS, { lovelace: 10_000_000n, [LAMP_UNIT]: 900_000_000n })]);
    await createVault({ ...base, lucid: r.lucid, vault: { ownerPkh: PKH, lampDeposit: 800_000_000n } } as never);
    expect(r.argsOf("collectFrom")).toHaveLength(1);
    expect(r.names()).not.toContain("attach.SpendingValidator");
    expect(r.names()).not.toContain("validTo");
  });

  it("chủ script: bộ ký did_payment trùng nhân chứng ⟹ KHÔNG ký/đọc anchor lần hai; mục rút (0) không đổi phần thối về ví Phoenix", async () => {
    const r = recordingLucid([FEE_UTXO]);
    await createVault({ ...base, lucid: r.lucid, vault: { owner: { type: "script", hash: DID_H }, lampDeposit: 800_000_000n }, ownerAuth: await scriptAuth(), funding: funding() } as never);
    expect(r.argsOf("addSignerKey")).toEqual([[CTRL], [DEV]]);
    expect(r.argsOf("readFrom")).toEqual([[[ANCHOR]]]);
    const vaultOut = r.argsOf("pay.ToAddressWithData")[0]![2] as Record<string, bigint>;
    const ret = r.argsOf("pay.ToAddress")[0]![1] as Record<string, bigint>;
    expect(ret.lovelace).toBe(DP_BIG.assets.lovelace! - vaultOut.lovelace!);
  });

  it("CỰC ĐỐI: chủ script, controller của nhân chứng khác funding ⟹ FUNDING_WITNESS_MISMATCH, không dựng tx", async () => {
    const r = recordingLucid([FEE_UTXO]);
    expect(await codeOf(createVault({ ...base, lucid: r.lucid, vault: { owner: { type: "script", hash: DID_H }, lampDeposit: 1n }, ownerAuth: await scriptAuth("c9".repeat(28)), funding: funding() } as never)))
      .toBe("FUNDING_WITNESS_MISMATCH");
    expect(r.newTxCount()).toBe(0);
  });

  it("CỰC ĐỐI: script không băm ra credential của địa chỉ ⟹ FUNDING_SCRIPT_MISMATCH, không dựng tx", async () => {
    const r = recordingLucid([FEE_UTXO]);
    expect(await codeOf(createVault({ ...base, lucid: r.lucid, vault: { ownerPkh: PKH, lampDeposit: 1n }, funding: funding({ didPaymentScriptCbor: DID_STAKE }) } as never)))
      .toBe("FUNDING_SCRIPT_MISMATCH");
    expect(r.newTxCount()).toBe(0);
  });

  it("CỰC ĐỐI: ví Phoenix không đủ LAMP ⟹ FUNDING_INSUFFICIENT", async () => {
    const r = recordingLucid([FEE_UTXO]);
    expect(await codeOf(createVault({ ...base, lucid: r.lucid, vault: { ownerPkh: PKH, lampDeposit: 1_400_000_002n }, funding: funding() } as never)))
      .toBe("FUNDING_INSUFFICIENT");
    expect(r.newTxCount()).toBe(0);
  });
});

describe("planDidPaymentFunding — bộ chọn", () => {
  const ports = didPaymentLucidPorts(4310n);
  it("phần thối dưới min-ADA ⟹ kéo thêm UTxO; chi vừa khít ⟹ không output thối", () => {
    // DP_MID đủ LAMP nhưng 3 ADA − 2,9 ADA = 0,1 ADA + 100 LAMP < min-ADA ⟹ phải thêm UTxO.
    const p = planDidPaymentFunding({ utxos: [DP_MID, DP_DUST], need: { lovelace: 2_900_000n, [LAMP_UNIT]: 400_000_000n }, primaryUnit: LAMP_UNIT, returnAddress: DP_ADDRESS }, ports);
    expect(p.selected).toEqual([DP_MID, DP_DUST]);
    const exact = planDidPaymentFunding({ utxos: [DP_MID], need: { lovelace: 3_000_000n, [LAMP_UNIT]: 500_000_000n }, primaryUnit: LAMP_UNIT, returnAddress: DP_ADDRESS }, ports);
    expect(exact.returned).toBeNull();
  });

  it("UTxO chỉ có datum hash (không datum) bị loại và được ĐẾM", () => {
    const dh = { ...DP_BIG, datumHash: "00".repeat(32) } as UTxO;
    expect(() => planDidPaymentFunding({ utxos: [dh], need: { lovelace: 1n, [LAMP_UNIT]: 1n }, primaryUnit: LAMP_UNIT, returnAddress: DP_ADDRESS }, ports))
      .toThrow(/0 UTxO chi được/);
  });
});

// Chặn chép nhầm: datum vault vẫn là của chủ, không phải của ví Phoenix.
it("datum vault giữ chủ yêu cầu khi có funding", async () => {
  const r = recordingLucid([FEE_UTXO]);
  await createVault({ ...base, lucid: r.lucid, vault: { ownerPkh: PKH, lampDeposit: 800_000_000n }, funding: funding() } as never);
  const out = r.argsOf("pay.ToAddressWithData")[0]!;
  expect((Data.from((out[1] as { value: string }).value, VaultDatumSchema) as unknown as { owner: unknown }).owner).toEqual({ VerificationKey: [PKH] });
});
