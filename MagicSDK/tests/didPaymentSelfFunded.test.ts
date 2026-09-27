// MagicSDK/tests/didPaymentSelfFunded.test.ts — `createVault({ funding: { feeSource: "did_payment" } })`.
//
// Khác `didPaymentFunding.test.ts` (lucid giả ghi lượt gọi): ở đây là Lucid Evolution THẬT, dựng
// ngoại tuyến (tham số giao thức mặc định của thư viện, nhà cung cấp giả ném nếu bị gọi) với hai
// script luôn-đúng biên dịch bằng aiken 1.1.21 — vault (mint + spend) và did_payment (một tham số
// Int, apply 0). Thứ khẳng định là HÌNH DẠNG đọc lại từ CBOR: input nào, seed nào, thế chấp nào,
// output về đâu, phí ai trả. Script luôn-đúng nghĩa là bài KHÔNG kiểm logic validator.
//
// Mỗi ca dương có ca đối xứng đổi đúng một biến (chế độ phí, UTxO thế chấp, seed, phần giữ chỗ).

import {
  CML, Lucid, applyParamsToScript, credentialToAddress, scriptHashToCredential, validatorToScriptHash,
  type LucidEvolution, type UTxO, type Validator,
} from "@lucid-evolution/lucid";
import { PROTOCOL_PARAMETERS_DEFAULT } from "@lucid-evolution/utils";
import { FundingError } from "@magiclamp/protocol-utils";
import { describe, expect, it } from "vitest";

import { assertSelfFundedShape, createVault } from "../src/createVault.js";
import { vaultIdAssetName } from "../src/vaultId.js";

// `validator always_a { spend(..) { True } mint(..) { True } else(_) { fail } }` — plutus v3.
const ALWAYS_VAULT = "587601010029800aba2aba1aab9eaab9dab9a48888966002646465300130053754003300700398038012444b30013370e9001001c4c8cc892898058009805980600098049baa0048acc004cdc3a40000071324a26eb8c028c024dd5002459007200e18031803800980300098019baa0068a4d13656400401";
// `validator always_b(_tag: Int) { spend(..) { True } else(_) { fail } }` — apply 0.
const ALWAYS_DP_UNAPPLIED = "5860010100229800aba2aba1aab9eaab9dab9a9bad00248888896600264653001300700198039804000cc01c0092225980099b8748008c020dd500144c8cc892898058009805980600098049baa0028b200e180380098021baa0078a4d1365640081";
const DP_SCRIPT = applyParamsToScript(ALWAYS_DP_UNAPPLIED, [0n]);
const DP_ADDR = credentialToAddress("Preview", scriptHashToCredential(validatorToScriptHash({ type: "PlutusV3", script: DP_SCRIPT })));
const VAULT: Validator = { type: "PlutusV3", script: ALWAYS_VAULT };
const VAULT_HASH = validatorToScriptHash(VAULT);
const VAULT_ADDR = credentialToAddress("Preview", scriptHashToCredential(VAULT_HASH));

const LAMP_POLICY = "4942de4a226f43c524c1273d752712366511d5fd7ae28bc1a1576077";
const LAMP_UNIT = `${LAMP_POLICY}744c414d50`;
const OTHER_UNIT = `${"77".repeat(28)}aa`;
const TIP_MS = 1_789_100_703_000n;
const PKH = "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21";
const CTRL = "a1".repeat(28);
const DEV = "b2".repeat(28);
// Ví seed: địa chỉ base khoá/khoá — chỉ đứng thế chấp.
const SEED_ADDR = credentialToAddress("Preview", { type: "Key", hash: "c1".repeat(28) }, { type: "Key", hash: "c2".repeat(28) });
const STRANGER_ADDR = credentialToAddress("Preview", { type: "Key", hash: "c3".repeat(28) });

const u = (txHash: string, ix: number, address: string, assets: Record<string, bigint>): UTxO =>
  ({ txHash, outputIndex: ix, address, assets, datum: null, datumHash: null, scriptRef: null }) as UTxO;
const COLL = u("aa".repeat(32), 0, SEED_ADDR, { lovelace: 5_000_000n });
const W_EXTRA = u("ab".repeat(32), 0, SEED_ADDR, { lovelace: 50_000_000n });
const ANCHOR = u("ee".repeat(32), 1, DP_ADDR, { lovelace: 2_000_000n });
const DP_BIG = u("d1".repeat(32), 0, DP_ADDR, { lovelace: 6_000_000n, [LAMP_UNIT]: 900_000_000n, [OTHER_UNIT]: 3n });
const DP_MID = u("d2".repeat(32), 0, DP_ADDR, { lovelace: 3_000_000n, [LAMP_UNIT]: 500_000_000n });
const DP_ADA = u("d3".repeat(32), 0, DP_ADDR, { lovelace: 8_000_000n });
const k = (x: { txHash: string; outputIndex: number | bigint }) => `${x.txHash}#${Number(x.outputIndex)}`;

async function realLucid(walletUtxos: UTxO[], walletAddr: string = SEED_ADDR): Promise<LucidEvolution> {
  const provider = new Proxy({}, {
    get: (_t, p) => (p === "then" ? undefined : async () => { throw new Error(`provider.${String(p)} không được gọi trong bài kiểm`); }),
  }) as never;
  const lucid = await Lucid(provider, "Preview", { presetProtocolParameters: PROTOCOL_PARAMETERS_DEFAULT });
  lucid.selectWallet.fromAddress(walletAddr, walletUtxos);
  return lucid;
}

const fundingOf = (over: Record<string, unknown> = {}) => ({
  didPaymentScriptCbor: DP_SCRIPT, address: DP_ADDR, utxos: [DP_ADA, DP_MID, DP_BIG],
  anchorRefUtxo: ANCHOR, controllerPkh: CTRL, deviceKeyHash: DEV,
  feeSource: "did_payment", collateralUtxo: COLL, ...over,
});
const LEGACY = { feeSource: undefined, collateralUtxo: undefined };

async function build(fundingOver: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, walletAddr?: string) {
  const lucid = await realLucid([COLL, W_EXTRA], walletAddr);
  return createVault({
    lucid, vaultType: "Schedule",
    protocol: { network: "Preview", lampPolicyId: LAMP_POLICY },
    appliedVault: { script: VAULT, expectedScriptHash: VAULT_HASH },
    vault: { ownerPkh: PKH, lampDeposit: 800_000_000n },
    tipPosixMs: TIP_MS, collateralLovelace: 3_000_000n,
    funding: fundingOf(fundingOver), ...extra,
  } as never);
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return "KHÔNG NÉM"; } catch (e) {
    return e instanceof FundingError ? e.code : `KHÁC: ${(e as Error).message.slice(0, 120)}`;
  }
}

function view(txCbor: string) {
  const b = CML.Transaction.from_cbor_hex(txCbor).body();
  const inputs: string[] = [];
  for (let i = 0; i < b.inputs().len(); i++) inputs.push(k({ txHash: b.inputs().get(i).transaction_id().to_hex(), outputIndex: b.inputs().get(i).index() }));
  const outputs: { address: string; lovelace: bigint; lamp: bigint }[] = [];
  for (let i = 0; i < b.outputs().len(); i++) {
    const o = b.outputs().get(i);
    const ma = o.amount().multi_asset();
    const lamp = ma.get_assets(CML.ScriptHash.from_hex(LAMP_POLICY))?.get(CML.AssetName.from_raw_bytes(Buffer.from("744c414d50", "hex"))) ?? 0n;
    outputs.push({ address: o.address().to_bech32(undefined), lovelace: o.amount().coin(), lamp });
  }
  const coll: string[] = [];
  const cl = b.collateral_inputs();
  for (let i = 0; cl !== undefined && i < cl.len(); i++) coll.push(k({ txHash: cl.get(i).transaction_id().to_hex(), outputIndex: cl.get(i).index() }));
  const minted: string[] = [];
  const mint = b.mint();
  const pols = mint?.keys();
  for (let i = 0; pols !== undefined && i < pols.len(); i++) {
    const names = mint!.get_assets(pols.get(i))!.keys();
    for (let j = 0; j < names.len(); j++) minted.push(pols.get(i).to_hex() + Buffer.from(names.get(j).to_raw_bytes()).toString("hex"));
  }
  return { inputs, outputs, coll, collReturn: b.collateral_return()?.address().to_bech32(undefined), fee: b.fee(), minted };
}

describe("createVault — ví Phoenix tự trả phí (feeSource = did_payment), Lucid thật", () => {
  it("DƯƠNG: input CHỈ là UTxO did_payment đã chọn; seed là một trong số đó; thế chấp = COLL, collateral_return về ví seed; không output nào về ví seed; phí trả từ did_payment", async () => {
    const res = await build();
    const v = view(res.tx.toCBOR());
    expect(new Set(v.inputs)).toEqual(new Set([k(DP_BIG), k(DP_MID)]));
    expect(v.inputs).not.toContain(k(COLL));
    expect(v.inputs).not.toContain(k(W_EXTRA));
    // Seed: một UTxO did_payment trong tập chi; tên NFT đúc = blake2b_256(cbor(seed)).
    expect(v.inputs).toContain(k(res.seedUtxo));
    expect(k(res.seedUtxo)).toBe(k(DP_BIG));            // pickSeedUtxo(selected): nhiều ADA nhất
    expect(res.seedUtxo.address).toBe(DP_ADDR);
    expect(v.minted).toEqual([`${VAULT_HASH}${vaultIdAssetName(res.seedUtxo)}`]);
    expect(v.coll).toEqual([k(COLL)]);
    expect(v.collReturn).toBe(SEED_ADDR);
    expect(v.outputs.map(o => o.address).sort()).toEqual([DP_ADDR, VAULT_ADDR].sort());
    // Bảo toàn: did_payment chi = vault + thối did_payment + PHÍ.
    const inLovelace = DP_BIG.assets.lovelace! + DP_MID.assets.lovelace!;
    const outLovelace = v.outputs.reduce((s, o) => s + o.lovelace, 0n);
    expect(inLovelace).toBe(outLovelace + v.fee);
    expect(v.outputs.reduce((s, o) => s + o.lamp, 0n)).toBe(1_400_000_000n);
    expect(res.funding?.feeLovelace).toBe(v.fee);
    const ret = v.outputs.find(o => o.address === DP_ADDR)!;
    expect(res.funding?.returned?.lovelace).toBe(ret.lovelace);
  }, 30_000);

  it("CẶP (đổi chế độ phí về mặc định): seed = UTxO ví, ví góp input trả phí, không UTxO did_payment nào làm seed", async () => {
    const res = await build(LEGACY);
    const v = view(res.tx.toCBOR());
    expect(res.seedUtxo).toBe(W_EXTRA);
    expect(v.inputs).toContain(k(W_EXTRA));
    expect(res.funding?.feeLovelace).toBeUndefined();
    expect(v.outputs.some(o => o.address === SEED_ADDR)).toBe(true);
  }, 30_000);

  it("chế độ mặc định, seedUtxo = DP_BIG (UTxO did_payment ĐÃ chọn) ⟹ FUNDING_SHAPE — guard cũ còn nguyên (cặp: ca trên)", async () => {
    expect(await codeOf(build(LEGACY, { seedUtxo: DP_BIG }))).toBe("FUNDING_SHAPE");
  });

  it("DƯƠNG: seedUtxo chỉ định = DP_MID (trong tập chọn, KHÁC lựa chọn mặc định DP_BIG) ⟹ seed đúng DP_MID", async () => {
    const res = await build({}, { seedUtxo: DP_MID });
    expect(k(res.seedUtxo)).toBe(k(DP_MID));
    expect(view(res.tx.toCBOR()).minted).toEqual([`${VAULT_HASH}${vaultIdAssetName(DP_MID)}`]);
  }, 30_000);

  it("CẶP (chỉ đổi seedUtxo sang UTxO ví seed — NGOÀI tập did_payment đã chọn) ⟹ FUNDING_SHAPE", async () => {
    expect(await codeOf(build({}, { seedUtxo: W_EXTRA }))).toBe("FUNDING_SHAPE");
  });

  it("CỰC ĐỐI: thiếu collateralUtxo ⟹ FUNDING_SHAPE", async () => {
    expect(await codeOf(build({ collateralUtxo: undefined }))).toBe("FUNDING_SHAPE");
  });

  it("CỰC ĐỐI: collateralUtxo mang token ⟹ FUNDING_SHAPE", async () => {
    expect(await codeOf(build({ collateralUtxo: { ...COLL, assets: { lovelace: 5_000_000n, [OTHER_UNIT]: 1n } } }))).toBe("FUNDING_SHAPE");
  });

  it("CỰC ĐỐI: collateralUtxo ở địa chỉ khoá KHÁC ví đang chọn ⟹ FUNDING_SHAPE", async () => {
    expect(await codeOf(build({ collateralUtxo: { ...COLL, address: STRANGER_ADDR } }))).toBe("FUNDING_SHAPE");
  });

  it("CỰC ĐỐI: chế độ mặc định mà khai collateralUtxo ⟹ FUNDING_SHAPE (không vai)", async () => {
    expect(await codeOf(build({ feeSource: undefined }))).toBe("FUNDING_SHAPE");
  });

  it("CỰC ĐỐI: feeSource lạ ⟹ FUNDING_SHAPE", async () => {
    expect(await codeOf(build({ feeSource: "fee_payer" }))).toBe("FUNDING_SHAPE");
    // Không kèm collateralUtxo: nếu không thì cổng "collateralUtxo không có vai" ném thay, và ca
    // này xanh cả khi cổng kiểm GIÁ TRỊ feeSource bị gỡ (đột biến sdk_mode_value đo ra điều đó).
    expect(await codeOf(build({ feeSource: "fee_payer", collateralUtxo: undefined }))).toBe("FUNDING_SHAPE");
  });

  it("CỰC ĐỐI: collateralUtxo ở địa chỉ SCRIPT (ví đang chọn cũng là script đó) ⟹ FUNDING_SHAPE", async () => {
    const c = { ...COLL, address: DP_ADDR };
    expect(await codeOf(build({ collateralUtxo: c }, {}, DP_ADDR))).toBe("FUNDING_SHAPE");
  });

  it("CỰC ĐỐI: collateralUtxo mang script tham chiếu ⟹ FUNDING_SHAPE", async () => {
    expect(await codeOf(build({ collateralUtxo: { ...COLL, scriptRef: VAULT } }))).toBe("FUNDING_SHAPE");
  });

  it("CỰC ĐỐI: feeHeadroomLovelace = 0 ⟹ FUNDING_SHAPE (cặp: 100 000 ⟹ FUNDING_INSUFFICIENT ở ca dưới)", async () => {
    expect(await codeOf(build({ feeHeadroomLovelace: 0n }))).toBe("FUNDING_SHAPE");
  });

  it("CỰC ĐỐI: phần giữ chỗ phí 100 000 lovelace < phí đo được ⟹ FUNDING_INSUFFICIENT", async () => {
    expect(await codeOf(build({ feeHeadroomLovelace: 100_000n }))).toBe("FUNDING_INSUFFICIENT");
  });
});

describe("assertSelfFundedShape — từng vế, trên CBOR do Lucid thật dựng", () => {
  const ref = (s: string) => { const [h, i] = s.split("#"); return { txHash: h!, outputIndex: Number(i) } as UTxO; };
  it("DƯƠNG: đúng tập input / thế chấp / ví / phí ⟹ không ném; mỗi vế lệch một biến ⟹ FUNDING_SHAPE", async () => {
    const res = await build();
    const cbor = res.tx.toCBOR();
    const v = view(cbor);
    const sel = v.inputs.map(ref);
    expect(() => assertSelfFundedShape(cbor, sel, COLL, SEED_ADDR, v.fee)).not.toThrow();
    const shape = (f: () => void) => { try { f(); return "không ném"; } catch (e) { return (e as FundingError).code; } };
    expect(shape(() => assertSelfFundedShape(cbor, sel.slice(1), COLL, SEED_ADDR, v.fee))).toBe("FUNDING_SHAPE");
    expect(shape(() => assertSelfFundedShape(cbor, sel, W_EXTRA, SEED_ADDR, v.fee))).toBe("FUNDING_SHAPE");
    expect(shape(() => assertSelfFundedShape(cbor, sel, COLL, STRANGER_ADDR, v.fee))).toBe("FUNDING_SHAPE");
    expect(shape(() => assertSelfFundedShape(cbor, sel, COLL, SEED_ADDR, v.fee + 1n))).toBe("FUNDING_SHAPE");
  }, 30_000);

  it("CỰC ĐỐI: tx có output về ví thế chấp (tx chế độ mặc định, khai đúng input/thế chấp/phí của chính nó) ⟹ FUNDING_SHAPE", async () => {
    const res = await build(LEGACY);
    const cbor = res.tx.toCBOR();
    const v = view(cbor);
    expect(v.collReturn === undefined || v.collReturn === SEED_ADDR).toBe(true);
    expect(v.coll).toHaveLength(1);
    let code = "không ném";
    try { assertSelfFundedShape(cbor, v.inputs.map(ref), ref(v.coll[0]!), SEED_ADDR, v.fee); } catch (e) { code = (e as FundingError).code; }
    expect(code).toBe("FUNDING_SHAPE");
  }, 30_000);
});
