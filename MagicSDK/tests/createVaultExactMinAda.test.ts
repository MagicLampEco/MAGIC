// MagicSDK/tests/createVaultExactMinAda.test.ts — lovelace két mặc định của `createVault` = min-ADA
// CHÍNH XÁC của chính output két (2026-10-10).
//
// Bối cảnh: hàng rào phí áp luật L28 cho tx mở két Instant — lovelace két ≤ min(3 ADA, minADA +
// 517 040), minADA = coinsPerUtxoByte × (160 + byte CBOR của output két). Bản trước ước chặn trên
// + biên 20% + làm tròn LÊN ADA chẵn ⟹ két 0 LAMP mở ở 3 ADA, trượt L28.
//
// Trọng tài là CÔNG THỨC sổ cái trên output, không phải hàm mà mã dùng:
//   · Lucid THẬT (ngoại tuyến, `PROTOCOL_PARAMETERS_DEFAULT`) cho chủ khoá — đọc output két từ CBOR
//     giao dịch đã dựng, đếm byte, so công thức; và `CML.min_ada_required` trên chính output đó.
//   · Trình dựng ghi lại cho chủ DID (script) — chủ script cần mục rút `did_stake` mà script luôn-
//     đúng sẵn có không chạy được nhánh withdraw; ở đây so trên đối số `pay.ToAddressWithData`
//     (đúng thứ Lucid nhận), dựng output bằng CML với lovelace đó rồi đếm byte.
// Cặp ca: lovelace két THOẢ công thức và lovelace − 1 KHÔNG thoả (nó là giá trị nhỏ nhất); truyền tay
// thấp hơn 1 lovelace ⟹ NÉM, bằng đúng ⟹ qua; `coinsPerUtxoByte` lấy từ Lucid (đổi tham số ⟹ đổi
// kết quả) chứ không từ hằng.

import {
  CML, Data, Lucid, assetsToValue, credentialToAddress, validatorToScriptHash,
  type Assets, type LucidEvolution, type UTxO, type Validator,
} from "@lucid-evolution/lucid";
import { PROTOCOL_PARAMETERS_DEFAULT } from "@lucid-evolution/utils";
import { epochStartMs } from "@magiclamp/protocol-utils";
import { describe, expect, it } from "vitest";

import { createVault } from "../src/createVault.js";
import { didStakeOwnerAuthLucid } from "../src/didStakeLucid.js";
import { ACCEPT_INLINE_SCRIPT_CEILING } from "../src/refScript.js";
import { InstantVaultDatumSchema } from "../src/schemas.js";

// `validator always_a { spend(..) { True } mint(..) { True } else(_) { fail } }` — plutus v3 (cùng
// bộ với `didPaymentFeePayerFronts.test.ts`).
const ALWAYS_VAULT = "587601010029800aba2aba1aab9eaab9dab9a48888966002646465300130053754003300700398038012444b30013370e9001001c4c8cc892898058009805980600098049baa0048acc004cdc3a40000071324a26eb8c028c024dd5002459007200e18031803800980300098019baa0068a4d13656400401";
const VAULT: Validator = { type: "PlutusV3", script: ALWAYS_VAULT };
const VAULT_HASH = validatorToScriptHash(VAULT);

const LAMP_POLICY = "4942de4a226f43c524c1273d752712366511d5fd7ae28bc1a1576077";
const LAMP_UNIT = `${LAMP_POLICY}744c414d50`;
const TIP_MS = epochStartMs(60n, "Preprod");
const PKH = "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21";
const LINK = "dd".repeat(32);
const LAMP_AMOUNT = 100_000_000n;
const FEE_ADDR = credentialToAddress("Preprod", { type: "Key", hash: "c1".repeat(28) });

const DID_STAKE = "4746010000222220";
const DID_H = validatorToScriptHash({ type: "PlutusV3", script: DID_STAKE });

/** Luật L28 của hàng rào phí (bối cảnh đầu tệp). */
const L28_CAP = 3_000_000n;
const L28_SLACK = 517_040n;

const u = (txHash: string, ix: number, address: string, assets: Record<string, bigint>): UTxO =>
  ({ txHash, outputIndex: ix, address, assets, datum: null, datumHash: null, scriptRef: null }) as UTxO;
const FEE_UTXO = u("fa".repeat(32), 0, FEE_ADDR, { lovelace: 20_000_000n, [LAMP_UNIT]: 1_000_000_000n });
const ANCHOR = u("ee".repeat(32), 1, FEE_ADDR, { lovelace: 2_000_000n });

const base = {
  vaultType: "Instant" as const,
  protocol: { network: "Preprod" as const, lampPolicyId: LAMP_POLICY },
  appliedVault: { script: VAULT, expectedScriptHash: VAULT_HASH },
  vaultRefScriptUtxo: ACCEPT_INLINE_SCRIPT_CEILING,
  tipPosixMs: TIP_MS,
};

/** coinsPerUtxoByte × (160 + byte CBOR) của một output CML. */
const formulaOf = (out: CML.TransactionOutput, cpub: bigint) => cpub * (160n + BigInt(out.to_cbor_bytes().length));

/** Output két dựng lại bằng CML với ĐÚNG lovelace cho trước. */
function rebuild(address: string, datumHex: string, assets: Assets): CML.TransactionOutput {
  return CML.TransactionOutputBuilder.new()
    .with_address(CML.Address.from_bech32(address))
    .with_data(CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(datumHex)))
    .next()
    .with_value(assetsToValue(assets))
    .build().output();
}

const rows: string[] = [];
function verdict(label: string, lovelace: bigint, minAda: bigint, cml: bigint) {
  const cap = minAda + L28_SLACK < L28_CAP ? minAda + L28_SLACK : L28_CAP;
  rows.push(`${label} | két ${lovelace} | minADA công thức ${minAda} | CML ${cml} | trần L28 ${cap} | ${lovelace <= cap ? "QUA" : "TRƯỢT"}`);
  return cap;
}

async function realLucid(walletUtxos: UTxO[]): Promise<LucidEvolution> {
  const provider = new Proxy({}, {
    get: (_t, p) => (p === "then" ? undefined : async () => { throw new Error(`provider.${String(p)} không được gọi trong bài kiểm`); }),
  }) as never;
  const lucid = await Lucid(provider, "Preprod", { presetProtocolParameters: PROTOCOL_PARAMETERS_DEFAULT });
  lucid.selectWallet.fromAddress(walletUtxos[0]!.address, walletUtxos);
  return lucid;
}

/** Trình dựng ghi lại (khuôn `didPaymentFunding.test.ts`); `cpub` = tham số giao thức nó mang. */
function recordingLucid(walletUtxos: UTxO[], cpub: bigint | undefined) {
  const calls: Array<[string, unknown[]]> = [];
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
    newTx: () => proxy,
    ...(cpub === undefined ? {} : { config: () => ({ protocolParameters: { coinsPerUtxoByte: cpub } }) }),
    wallet: () => ({ address: async () => FEE_ADDR, getUtxos: async () => walletUtxos }),
  } as unknown as LucidEvolution;
  const vaultPay = () => {
    const a = calls.filter(c => c[0] === "pay.ToAddressWithData").map(c => c[1])[0]!;
    return { address: a[0] as string, datumHex: (a[1] as { value: string }).value, assets: a[2] as Assets };
  };
  return { lucid, vaultPay };
}

const scriptAuth = () => didStakeOwnerAuthLucid({
  owner: { type: "script", hash: DID_H }, didStakeScriptCbor: DID_STAKE, anchorRefUtxo: ANCHOR,
  controllerPkh: "a1".repeat(28), deviceKeyHash: "b2".repeat(28), network: "Preprod",
}, async () => ({ registered: true, withdrawableLovelace: 0n }));

const CASES = [
  { lamp: 0n, link: "" },
  { lamp: 0n, link: LINK },
  { lamp: LAMP_AMOUNT, link: "" },
  { lamp: LAMP_AMOUNT, link: LINK },
] as const;
const nameOf = (c: (typeof CASES)[number]) => `${c.lamp === 0n ? "0 LAMP" : "có LAMP"} · ${c.link === "" ? "không link" : "link 32 B"}`;

describe("createVault: lovelace két = min-ADA chính xác (chủ KHOÁ, Lucid THẬT, đọc từ CBOR tx)", () => {
  it.each(CASES.map(c => [nameOf(c), c] as const))("%s", async (_n, c) => {
    const lucid = await realLucid([FEE_UTXO]);
    const res = await createVault({
      ...base, lucid,
      vault: { ownerPkh: PKH, lampDeposit: c.lamp, ...(c.link === "" ? {} : { wakemeLink: c.link }) },
    } as never);
    const outs = CML.Transaction.from_cbor_hex(res.tx.toCBOR()).body().outputs();
    let vaultOut: CML.TransactionOutput | undefined;
    for (let i = 0; i < outs.len(); i++) if (outs.get(i).address().to_bech32(undefined) === res.vaultAddress) vaultOut = outs.get(i);
    expect(vaultOut).toBeDefined();
    const cpub = PROTOCOL_PARAMETERS_DEFAULT.coinsPerUtxoByte;
    const lovelace = vaultOut!.amount().coin();
    const minAda = formulaOf(vaultOut!, cpub);
    const cml = CML.min_ada_required(vaultOut!, cpub);
    // (a) ĐÚNG min-ADA, không hơn: công thức trên chính output đó, và CML đồng ý.
    expect(lovelace).toBe(minAda);
    expect(lovelace).toBe(cml);
    // (b) nhỏ nhất: lovelace − 1 thì output (cùng datum + tài sản) thiếu.
    const datumHex = vaultOut!.datum()!.as_datum()!.to_cbor_hex();
    const assets: Assets = { [res.vaultIdUnit]: 1n, ...(c.lamp === 0n ? {} : { [LAMP_UNIT]: c.lamp }) };
    expect(formulaOf(rebuild(res.vaultAddress, datumHex, { ...assets, lovelace: lovelace - 1n }), cpub)).toBeGreaterThan(lovelace - 1n);
    // (c) luật L28.
    expect(lovelace).toBeLessThanOrEqual(verdict(`khoá · ${nameOf(c)}`, lovelace, minAda, cml));
    // Datum két đúng ca (không phải một ca khác tình cờ cùng cỡ).
    const d = Data.from(datumHex, InstantVaultDatumSchema) as unknown as { lamp_balance: bigint; wakeme_link: string };
    expect(d.lamp_balance).toBe(c.lamp);
    expect(d.wakeme_link).toBe(c.link);
  }, 30_000);
});

describe("createVault: lovelace két = min-ADA chính xác (chủ DID script, đối số pay.ToAddressWithData)", () => {
  it.each(CASES.map(c => [nameOf(c), c] as const))("%s", async (_n, c) => {
    const r = recordingLucid([FEE_UTXO], 4310n);
    const res = await createVault({
      ...base, lucid: r.lucid,
      vault: { owner: { type: "script", hash: DID_H }, lampDeposit: c.lamp, ...(c.link === "" ? {} : { wakemeLink: c.link }) },
      ownerAuth: await scriptAuth(),
    } as never);
    const p = r.vaultPay();
    expect(p.address).toBe(res.vaultAddress);
    expect(p.assets[res.vaultIdUnit]).toBe(1n);
    expect(p.assets[LAMP_UNIT]).toBe(c.lamp === 0n ? undefined : c.lamp);
    const out = rebuild(p.address, p.datumHex, p.assets);
    const minAda = formulaOf(out, 4310n);
    const cml = CML.min_ada_required(out, 4310n);
    expect(p.assets.lovelace).toBe(minAda);
    expect(p.assets.lovelace).toBe(cml);
    expect(formulaOf(rebuild(p.address, p.datumHex, { ...p.assets, lovelace: p.assets.lovelace! - 1n }), 4310n))
      .toBeGreaterThan(p.assets.lovelace! - 1n);
    expect(p.assets.lovelace!).toBeLessThanOrEqual(verdict(`DID · ${nameOf(c)}`, p.assets.lovelace!, minAda, cml));
    const d = Data.from(p.datumHex, InstantVaultDatumSchema) as unknown as { owner: unknown; wakeme_link: string };
    expect(JSON.stringify(d.owner, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toContain(DID_H);
    expect(d.wakeme_link).toBe(c.link);
  });

  it("(in bảng) mọi ca", () => {
    console.log("\n" + rows.join("\n"));
    expect(rows.length).toBe(CASES.length * 2);
  });
});

describe("createVault: cổng `vaultLovelace` truyền tay + nguồn coinsPerUtxoByte", () => {
  const vault = { ownerPkh: PKH, lampDeposit: 0n, wakemeLink: LINK };
  const exactMin = async (cpub: bigint | undefined) => {
    const r = recordingLucid([FEE_UTXO], cpub);
    await createVault({ ...base, lucid: r.lucid, vault } as never);
    return r.vaultPay().assets.lovelace!;
  };

  it("ÂM: thấp hơn min chính xác 1 lovelace ⟹ NÉM, câu lỗi nói min chính xác", async () => {
    const m = await exactMin(4310n);
    const r = recordingLucid([FEE_UTXO], 4310n);
    await expect(createVault({ ...base, lucid: r.lucid, vault: { ...vault, vaultLovelace: m - 1n } } as never))
      .rejects.toThrow(new RegExp(`THẤP HƠN min-ADA chính xác ${m}\\b`));
  });

  it("DƯƠNG (cực đối): bằng đúng min ⟹ qua, output mang đúng giá trị đó; lớn hơn ⟹ giữ nguyên giá trị tay", async () => {
    const m = await exactMin(4310n);
    for (const v of [m, m + 1n]) {
      const r = recordingLucid([FEE_UTXO], 4310n);
      await createVault({ ...base, lucid: r.lucid, vault: { ...vault, vaultLovelace: v } } as never);
      expect(r.vaultPay().assets.lovelace).toBe(v);
    }
  });

  it("coinsPerUtxoByte ĐỌC TỪ Lucid: tham số khác ⟹ lovelace két khác; vắng tham số ⟹ hằng 4310", async () => {
    const at4310 = await exactMin(4310n);
    const at8620 = await exactMin(8620n);
    expect(at8620).not.toBe(at4310);
    expect(at8620).toBeGreaterThan(at4310);
    expect(await exactMin(undefined)).toBe(at4310);
  });

  it("tham số giao thức hỏng hình dạng ⟹ NÉM, không rơi về hằng", async () => {
    const r = recordingLucid([FEE_UTXO], 0n);
    await expect(createVault({ ...base, lucid: r.lucid, vault } as never)).rejects.toThrow(/hình dạng lạ/);
  });
});
