// MagicSDK/tests/didPaymentFeePayerFronts.test.ts — `createVault({ funding })` ở chế độ VÍ TRẢ PHÍ
// bên thứ ba: min-ADA của output két mới do ví trả phí ỨNG, did_payment chỉ góp LAMP.
//
// Lucid Evolution THẬT, dựng ngoại tuyến (tham số giao thức mặc định của thư viện, nhà cung cấp giả
// ném nếu bị gọi), hai script luôn-đúng biên dịch bằng aiken 1.1.21 — cùng bộ với
// `didPaymentSelfFunded.test.ts`. Thứ khẳng định là bảo toàn lovelace đọc lại TỪ CBOR do bộ cân
// bằng của lucid dựng: lovelace ra khỏi did_payment = lovelace về lại did_payment, và phần lovelace
// của output két đến từ UTxO trả phí. Script luôn-đúng ⟹ bài KHÔNG kiểm logic validator.
//
// Đầu vào đúng hình DID #1 trên Preprod (2026-10-05): did_payment có MỘT UTxO 1.000 LAMP +
// 1.240.954 lovelace, két Instant genesis cần ~2,1 ADA. Cặp: cùng đầu vào, chế độ ví Phoenix tự trả
// phí ⟹ vẫn `FUNDING_INSUFFICIENT` (chế độ đó did_payment trả cả min-ADA két).

import {
  CML, Lucid, applyParamsToScript, credentialToAddress, scriptHashToCredential, validatorToScriptHash,
  type LucidEvolution, type UTxO, type Validator,
} from "@lucid-evolution/lucid";
import { PROTOCOL_PARAMETERS_DEFAULT } from "@lucid-evolution/utils";
import { FundingError, epochStartMs } from "@magiclamp/protocol-utils";
import { describe, expect, it } from "vitest";

import { createVault } from "../src/createVault.js";

// `validator always_a { spend(..) { True } mint(..) { True } else(_) { fail } }` — plutus v3.
const ALWAYS_VAULT = "587601010029800aba2aba1aab9eaab9dab9a48888966002646465300130053754003300700398038012444b30013370e9001001c4c8cc892898058009805980600098049baa0048acc004cdc3a40000071324a26eb8c028c024dd5002459007200e18031803800980300098019baa0068a4d13656400401";
// `validator always_b(_tag: Int) { spend(..) { True } else(_) { fail } }` — apply 0.
const ALWAYS_DP_UNAPPLIED = "5860010100229800aba2aba1aab9eaab9dab9a9bad00248888896600264653001300700198039804000cc01c0092225980099b8748008c020dd500144c8cc892898058009805980600098049baa0028b200e180380098021baa0078a4d1365640081";
const DP_SCRIPT = applyParamsToScript(ALWAYS_DP_UNAPPLIED, [0n]);
// Ví Phoenix thật mang stake credential `did_stake` (Script) ⟹ địa chỉ BASE script/script.
const DP_ADDR = credentialToAddress(
  "Preprod",
  scriptHashToCredential(validatorToScriptHash({ type: "PlutusV3", script: DP_SCRIPT })),
  scriptHashToCredential("d5".repeat(28)),
);
const VAULT: Validator = { type: "PlutusV3", script: ALWAYS_VAULT };
const VAULT_HASH = validatorToScriptHash(VAULT);
const VAULT_ADDR = credentialToAddress("Preprod", scriptHashToCredential(VAULT_HASH));

const LAMP_POLICY = "4942de4a226f43c524c1273d752712366511d5fd7ae28bc1a1576077";
const LAMP_UNIT = `${LAMP_POLICY}744c414d50`;
const TIP_MS = epochStartMs(60n, "Preprod");
const PKH = "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21";
const CTRL = "a1".repeat(28);
const DEV = "b2".repeat(28);
const FEE_ADDR = credentialToAddress("Preprod", { type: "Key", hash: "c1".repeat(28) });

const u = (txHash: string, ix: number, address: string, assets: Record<string, bigint>): UTxO =>
  ({ txHash, outputIndex: ix, address, assets, datum: null, datumHash: null, scriptRef: null }) as UTxO;
const FEE_UTXO = u("fa".repeat(32), 0, FEE_ADDR, { lovelace: 10_000_000n });
const ANCHOR = u("ee".repeat(32), 1, DP_ADDR, { lovelace: 2_000_000n });
/** Đúng hình did_payment của DID #1: 1.000 LAMP + 1.240.954 lovelace, không datum. */
const DP_DID1 = u("a1".repeat(32), 0, DP_ADDR, { lovelace: 1_240_954n, [LAMP_UNIT]: 1_000_000_000n });
const k = (x: { txHash: string; outputIndex: number | bigint }) => `${x.txHash}#${Number(x.outputIndex)}`;

async function realLucid(walletUtxos: UTxO[], walletAddr: string): Promise<LucidEvolution> {
  const provider = new Proxy({}, {
    get: (_t, p) => (p === "then" ? undefined : async () => { throw new Error(`provider.${String(p)} không được gọi trong bài kiểm`); }),
  }) as never;
  const lucid = await Lucid(provider, "Preprod", { presetProtocolParameters: PROTOCOL_PARAMETERS_DEFAULT });
  lucid.selectWallet.fromAddress(walletAddr, walletUtxos);
  return lucid;
}

async function build(fundingOver: Record<string, unknown> = {}, walletUtxos: UTxO[] = [FEE_UTXO]) {
  const lucid = await realLucid(walletUtxos, walletUtxos[0]!.address);
  return createVault({
    lucid, vaultType: "Instant",
    protocol: { network: "Preprod", lampPolicyId: LAMP_POLICY },
    appliedVault: { script: VAULT, expectedScriptHash: VAULT_HASH },
    vault: { ownerPkh: PKH, lampDeposit: 1_000_000_000n },
    tipPosixMs: TIP_MS, collateralLovelace: 3_000_000n,
    funding: {
      didPaymentScriptCbor: DP_SCRIPT, address: DP_ADDR, utxos: [DP_DID1],
      anchorRefUtxo: ANCHOR, controllerPkh: CTRL, deviceKeyHash: DEV, ...fundingOver,
    },
  } as never);
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return "KHÔNG NÉM"; } catch (e) {
    return e instanceof FundingError ? e.code : `KHÁC: ${(e as Error).message.slice(0, 120)}`;
  }
}

/** Đọc lại CBOR: input, output theo địa chỉ (lovelace + số unit khác lovelace), phí, mục rút. */
function view(txCbor: string) {
  const b = CML.Transaction.from_cbor_hex(txCbor).body();
  const inputs: string[] = [];
  for (let i = 0; i < b.inputs().len(); i++) inputs.push(k({ txHash: b.inputs().get(i).transaction_id().to_hex(), outputIndex: b.inputs().get(i).index() }));
  const outputs: { address: string; lovelace: bigint; lamp: bigint; units: number }[] = [];
  for (let i = 0; i < b.outputs().len(); i++) {
    const o = b.outputs().get(i);
    const ma = o.amount().multi_asset();
    const lamp = ma.get_assets(CML.ScriptHash.from_hex(LAMP_POLICY))?.get(CML.AssetName.from_raw_bytes(Buffer.from("744c414d50", "hex"))) ?? 0n;
    let units = 0;
    const pols = ma.keys();
    for (let j = 0; j < pols.len(); j++) units += ma.get_assets(pols.get(j))!.keys().len();
    outputs.push({ address: o.address().to_bech32(undefined), lovelace: o.amount().coin(), lamp, units });
  }
  let withdrawal = 0n;
  const wd = b.withdrawals();
  const ks = wd?.keys();
  for (let i = 0; ks !== undefined && i < ks.len(); i++) withdrawal += wd!.get(ks.get(i)) ?? 0n;
  return { inputs, outputs, fee: b.fee(), withdrawal };
}

const sumAt = (outs: { address: string; lovelace: bigint }[], addr: string) =>
  outs.filter(o => o.address === addr).reduce((s, o) => s + o.lovelace, 0n);

describe("createVault + funding, ví trả phí bên thứ ba: ví trả phí ứng min-ADA két (Lucid thật)", () => {
  it("DƯƠNG (hình DID #1): did_payment 1.000 LAMP + 1.240.954 lovelace ⟹ dựng được; lovelace did_payment ra = về; két đủ min-ADA, tiền từ ví trả phí", async () => {
    const res = await build();
    const v = view(res.tx.toCBOR());
    expect(new Set(v.inputs)).toEqual(new Set([k(FEE_UTXO), k(DP_DID1)]));
    // (a) did_payment: lovelace ra khỏi nó = lovelace về lại nó (+ mục rút, ở đây 0).
    expect(v.withdrawal).toBe(0n);
    expect(sumAt(v.outputs, DP_ADDR)).toBe(DP_DID1.assets.lovelace! + v.withdrawal);
    const dpOuts = v.outputs.filter(o => o.address === DP_ADDR);
    expect(dpOuts).toEqual([{ address: DP_ADDR, lovelace: 1_240_954n, lamp: 0n, units: 0 }]);
    expect(res.funding?.returned).toEqual({ lovelace: 1_240_954n });
    // (b) két: trọn 1.000 LAMP + NFT, lovelace ≥ min-ADA thật của CHÍNH output đó.
    const vaultOuts = v.outputs.filter(o => o.address === VAULT_ADDR);
    expect(vaultOuts).toHaveLength(1);
    expect(vaultOuts[0]!.lamp).toBe(1_000_000_000n);
    const tx = CML.Transaction.from_cbor_hex(res.tx.toCBOR());
    const vaultIdx = v.outputs.findIndex(o => o.address === VAULT_ADDR);
    const vaultCml = tx.body().outputs().get(vaultIdx);
    const minAda = CML.min_ada_required(vaultCml, PROTOCOL_PARAMETERS_DEFAULT.coinsPerUtxoByte);
    expect(vaultOuts[0]!.lovelace >= minAda).toBe(true);
    expect(vaultOuts[0]!.lovelace > DP_DID1.assets.lovelace!).toBe(true);   // did_payment không thể đã trả nó
    // (c) ví trả phí: góp đúng phí + thối + khoản ứng = lovelace két.
    const feeChange = sumAt(v.outputs, FEE_ADDR);
    expect(FEE_UTXO.assets.lovelace!).toBe(v.fee + feeChange + vaultOuts[0]!.lovelace);
    expect(v.outputs.map(o => o.address).sort()).toEqual([DP_ADDR, FEE_ADDR, VAULT_ADDR].sort());
  }, 30_000);

  it("CỰC ĐỐI (chỉ đổi chế độ phí sang ví Phoenix tự trả, phần giữ chỗ phí 1 lovelace): cùng did_payment ⟹ FUNDING_INSUFFICIENT như cũ", async () => {
    const coll = u("cc".repeat(32), 0, FEE_ADDR, { lovelace: 5_000_000n });
    expect(await codeOf(build({ feeSource: "did_payment", collateralUtxo: coll, feeHeadroomLovelace: 1n }, [coll])))
      .toBe("FUNDING_INSUFFICIENT");
  }, 30_000);
});
