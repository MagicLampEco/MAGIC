// VaultTxAPI/src/funding.ts — `funding` của `/tx/create-vault`: nạp LAMP từ ví Phoenix.
//
// ── BA VÍ, BA VAI ────────────────────────────────────────────────────────────────
//   · ví Phoenix (`funding.address`, payment credential = script `did_payment`): trả LAMP +
//     min-ADA của output vault; phần thối (LAMP, token khác, ADA, cả mục rút `did_stake` nếu
//     chủ là script) về LẠI chính địa chỉ này.
//   · ví trả phí (`funding.fee_payer`, khoá ký — mô hình Feecover): ĐÚNG MỘT UTxO thuần ADA,
//     vừa là input trả phí vừa là tài sản thế chấp vừa là seed của NFT danh-tính; tiền thối
//     ADA và `collateral_return` về đúng `fee_payer.address`.
//   · vault: output đích.
// Không output nào đi chỗ khác. Tài sản thế chấp KHÔNG được là UTxO script (ledger), nên phí
// + thế chấp buộc phải từ ví khoá ký — đó là lý do có vai thứ hai.
//
// ── VÌ SAO `change_address` BỊ CẤM KHI CÓ `funding` ──────────────────────────────
// `change_address` ở đường cũ gánh ba vai cùng lúc: nguồn LAMP, nguồn phí, đích tiền thối.
// `funding` tách ba vai đó ra hai địa chỉ đã có tên. Nhận thêm `change_address` là nhận một
// địa chỉ thứ ba KHÔNG có vai nào — chọn một nghĩa cho nó là đoán ý người gọi, và đoán sai
// là thối tiền về một ví không ai khai. Cấm là đường đơn giản nhất: 400
// `FUNDING_CHANGE_ADDRESS_CONFLICT`.
//
// ── ĐỌC LẠI CBOR ─────────────────────────────────────────────────────────────────
// `checkFundingTx` không tin bộ dựng: nó đọc input, thế chấp, output, redeemer, mục rút và
// hạn dùng TỪ CBOR, đối chiếu với UTxO dịch vụ tự đọc từ chuỗi, và ném 422
// `FUNDING_TX_MISMATCH` ở vế đầu tiên lệch.

import { CML, getAddressDetails, slotToUnixTime, valueToAssets, type UTxO } from "@lucid-evolution/lucid";
import {
  FundingError, assertDidPaymentAddress, DID_PAYMENT_SPEND_REDEEMER, FUNDING_MAX_VALIDITY_MS,
  type Network,
} from "@magiclamp/protocol-utils";
import { didPaymentLucidPorts } from "@magiclamp/sdk";

import type { ChainReader } from "./chain.js";
import { CodedApiError } from "./errors.js";
import { raw } from "./units.js";

const HASH28 = /^[0-9a-f]{56}$/;
const CBOR_HEX = /^(?:[0-9a-f]{2})+$/;
const OUTREF = /^([0-9a-f]{64})#(0|[1-9][0-9]{0,4})$/;

export interface OutRefLike { txHash: string; outputIndex: number }

export interface FundingRequest {
  type: "did_payment";
  didPaymentScriptCbor: string;
  address: string;
  feePayer: { utxoRef: OutRefLike; address: string };
  /** Tuỳ chọn khi có `owner_witness` (dùng chung); BẮT BUỘC khi không có. */
  anchorRef?: OutRefLike;
  controllerPkh?: string;
  deviceKeyHash?: string;
}

const refStr = (r: OutRefLike) => `${r.txHash}#${r.outputIndex}`;

// ── đọc thân bài ─────────────────────────────────────────────────────────────

/** `funding` tuỳ chọn. Có mặt thì đúng hình dạng, không trường lạ; sai ⟹ 400 `FUNDING_SHAPE`. */
export function parseFunding(body: Record<string, unknown>): FundingRequest | undefined {
  const f = body.funding;
  if (f === undefined) return undefined;
  const bad = (field: string, want: string) =>
    new CodedApiError(400, "FUNDING_SHAPE", `"funding${field}" phải là ${want}.`, { field: `funding${field}` });
  if (f === null || typeof f !== "object" || Array.isArray(f)) throw bad("", "một đối tượng JSON");
  const o = f as Record<string, unknown>;
  const allowed = ["type", "did_payment_script_cbor", "address", "fee_payer", "anchor_ref", "controller_pkh", "device_key_hash"];
  const extra = Object.keys(o).filter(k => !allowed.includes(k));
  if (extra.length > 0) {
    throw new CodedApiError(400, "FUNDING_SHAPE", `"funding" có trường lạ: ${extra.join(", ")}.`, { extra_fields: extra });
  }
  if (o.type !== "did_payment") throw bad(".type", `"did_payment"`);
  if (typeof o.did_payment_script_cbor !== "string" || !CBOR_HEX.test(o.did_payment_script_cbor)) {
    throw bad(".did_payment_script_cbor", "hex thường, số ký tự chẵn, khác rỗng");
  }
  if (typeof o.address !== "string" || o.address === "") throw bad(".address", "chuỗi địa chỉ bech32 khác rỗng");
  const fp = o.fee_payer;
  if (fp === null || typeof fp !== "object" || Array.isArray(fp)) throw bad(".fee_payer", `đối tượng { "utxo", "address" }`);
  const fpo = fp as Record<string, unknown>;
  const fpExtra = Object.keys(fpo).filter(k => k !== "utxo" && k !== "address");
  if (fpExtra.length > 0) {
    throw new CodedApiError(400, "FUNDING_SHAPE", `"funding.fee_payer" có trường lạ: ${fpExtra.join(", ")}.`, { extra_fields: fpExtra });
  }
  const fpRef = typeof fpo.utxo === "string" ? OUTREF.exec(fpo.utxo) : null;
  if (fpRef === null) throw bad(".fee_payer.utxo", `chuỗi "<tx_hash 64 hex>#<index>"`);
  if (typeof fpo.address !== "string" || fpo.address === "") throw bad(".fee_payer.address", "chuỗi địa chỉ bech32 khác rỗng");
  let anchorRef: OutRefLike | undefined;
  if (o.anchor_ref !== undefined) {
    const m = typeof o.anchor_ref === "string" ? OUTREF.exec(o.anchor_ref) : null;
    if (m === null) throw bad(".anchor_ref", `chuỗi "<tx_hash 64 hex>#<index>"`);
    anchorRef = { txHash: m[1]!, outputIndex: Number(m[2]!) };
  }
  for (const k of ["controller_pkh", "device_key_hash"] as const) {
    if (o[k] !== undefined && (typeof o[k] !== "string" || !HASH28.test(o[k] as string))) throw bad(`.${k}`, "56 hex thường");
  }
  return {
    type: "did_payment",
    didPaymentScriptCbor: o.did_payment_script_cbor,
    address: o.address,
    feePayer: { utxoRef: { txHash: fpRef[1]!, outputIndex: Number(fpRef[2]!) }, address: fpo.address },
    anchorRef,
    controllerPkh: o.controller_pkh as string | undefined,
    deviceKeyHash: o.device_key_hash as string | undefined,
  };
}

// ── kiểm tĩnh (không chạm chuỗi) ─────────────────────────────────────────────

/** `FundingError` → lỗi API có mã. Thiếu tài sản là trạng thái chuỗi ⟹ 422; còn lại 400. */
export function fundingApiErrorOf(e: FundingError): CodedApiError {
  return new CodedApiError(e.code === "FUNDING_INSUFFICIENT" ? 422 : 400, e.code, e.message, e.details);
}

/**
 * Hai địa chỉ + hash script, trước khi giữ khoá:
 *   · `fee_payer.address` phải là bech32 của ĐÚNG mạng với payment credential là KHOÁ;
 *   · `funding.address` phải thuộc đúng mạng, và `did_payment_script_cbor` băm ra ĐÚNG
 *     payment credential `Script(h)` của nó.
 */
export function assertFundingAddresses(network: Network, f: FundingRequest): void {
  const wantId = network === "Mainnet" ? 1 : 0;
  let fp: ReturnType<typeof getAddressDetails> | undefined;
  try { fp = getAddressDetails(f.feePayer.address); } catch { fp = undefined; }
  if (fp === undefined || fp.networkId !== wantId || fp.paymentCredential?.type !== "Key" || !f.feePayer.address.startsWith("addr")) {
    throw new CodedApiError(400, "FUNDING_FEE_PAYER_INVALID",
      `"funding.fee_payer.address" phải là địa chỉ bech32 của mạng ${network} với phần thanh toán là KHOÁ ` +
      `(tài sản thế chấp không được là UTxO script).`,
      { payment_credential: fp?.paymentCredential?.type ?? null, network_id: fp?.networkId ?? null });
  }
  let fa: ReturnType<typeof getAddressDetails> | undefined;
  try { fa = getAddressDetails(f.address); } catch { fa = undefined; }
  if (fa === undefined || fa.networkId !== wantId || !f.address.startsWith("addr")) {
    throw new CodedApiError(400, "FUNDING_SHAPE", `"funding.address" phải là địa chỉ bech32 của mạng ${network}.`);
  }
  // `minLovelaceFor` không dùng ở phép kiểm này; hằng coinsPerUtxoByte chỉ để dựng được cổng.
  try {
    assertDidPaymentAddress(f.didPaymentScriptCbor, f.address, didPaymentLucidPorts(4310n));
  } catch (e) {
    if (e instanceof FundingError) throw fundingApiErrorOf(e);
    throw e;
  }
}

/**
 * Bộ ba anchor + controller + thiết bị của `did_payment`. Có `owner_witness` ⟹ dùng CHUNG bộ
 * đó; `funding` khai thêm mà khác ⟹ 400 `FUNDING_WITNESS_MISMATCH`. Không có ⟹ `funding` phải
 * tự khai đủ ba.
 */
export function fundingWitnessOf(
  f: FundingRequest,
  ow: { anchorRef: OutRefLike; controllerPkh: string; deviceKeyHash: string } | undefined,
): { anchorRef: OutRefLike; controllerPkh: string; deviceKeyHash: string } {
  if (ow !== undefined) {
    const lech: string[] = [];
    if (f.anchorRef !== undefined && refStr(f.anchorRef) !== refStr(ow.anchorRef)) lech.push("anchor_ref");
    if (f.controllerPkh !== undefined && f.controllerPkh !== ow.controllerPkh) lech.push("controller_pkh");
    if (f.deviceKeyHash !== undefined && f.deviceKeyHash !== ow.deviceKeyHash) lech.push("device_key_hash");
    if (lech.length > 0) {
      throw new CodedApiError(400, "FUNDING_WITNESS_MISMATCH",
        `"funding" khai ${lech.join(", ")} khác "owner_witness". did_payment và did_stake cùng một DID ⟹ ` +
        `cùng anchor, cùng controller, cùng khoá thiết bị; không nhận bộ thứ hai.`,
        { mismatched: lech });
    }
    return { anchorRef: ow.anchorRef, controllerPkh: ow.controllerPkh, deviceKeyHash: ow.deviceKeyHash };
  }
  const missing = (["anchorRef", "controllerPkh", "deviceKeyHash"] as const).filter(k => f[k] === undefined);
  if (missing.length > 0) {
    throw new CodedApiError(400, "FUNDING_SHAPE",
      `Không có "owner_witness" để dùng chung ⟹ "funding" phải tự khai anchor_ref, controller_pkh, device_key_hash.`,
      { missing: missing.map(k => ({ anchorRef: "anchor_ref", controllerPkh: "controller_pkh", deviceKeyHash: "device_key_hash" })[k]) });
  }
  return { anchorRef: f.anchorRef!, controllerPkh: f.controllerPkh!, deviceKeyHash: f.deviceKeyHash! };
}

// ── đọc chuỗi ──────────────────────────────────────────────────────────────────

export interface DidPaymentAnchorReader {
  /** UTxO anchor DID; không mang tài sản dưới `anchor_nft_policy` ⟹ 400 `FUNDING_ANCHOR_INVALID`. */
  read(ref: OutRefLike): Promise<UTxO>;
}

export class ChainDidPaymentAnchorReader implements DidPaymentAnchorReader {
  constructor(private readonly deps: { chain: ChainReader; anchorNftPolicy: string }) {}
  async read(ref: OutRefLike): Promise<UTxO> {
    const [u] = await this.deps.chain.utxosByOutRef([ref]);
    const hit = Object.entries((u as UTxO).assets).some(([unit, q]) => unit.startsWith(this.deps.anchorNftPolicy) && q > 0n);
    if (!hit) {
      throw new CodedApiError(400, "FUNDING_ANCHOR_INVALID",
        `UTxO anchor ${refStr(ref).slice(0, 12)}… không mang tài sản nào dưới anchor_nft_policy của mạng này.`,
        { anchor_ref: refStr(ref) });
    }
    return u as UTxO;
  }
}

/** UTxO trả phí: phải ở ĐÚNG `fee_payer.address` và thuần ADA. */
export async function readFeePayerUtxo(chain: ChainReader, f: FundingRequest): Promise<UTxO> {
  const [u] = await chain.utxosByOutRef([f.feePayer.utxoRef]);
  const utxo = u as UTxO;
  if (utxo.address !== f.feePayer.address) {
    throw new CodedApiError(400, "FUNDING_FEE_PAYER_INVALID",
      `UTxO trả phí ${refStr(f.feePayer.utxoRef).slice(0, 12)}… không nằm ở funding.fee_payer.address.`,
      { fee_payer_utxo: refStr(f.feePayer.utxoRef) });
  }
  const units = Object.keys(utxo.assets).filter(k => utxo.assets[k] !== 0n);
  if (units.length !== 1 || units[0] !== "lovelace" || utxo.scriptRef != null) {
    throw new CodedApiError(400, "FUNDING_FEE_PAYER_INVALID",
      `UTxO trả phí phải thuần ADA, không token, không script tham chiếu (nó còn là tài sản thế chấp).`,
      { fee_payer_utxo: refStr(f.feePayer.utxoRef), units });
  }
  return utxo;
}

// ── đọc lại CBOR ─────────────────────────────────────────────────────────────

export interface FundingCheckContext {
  network: Network;
  tipPosixMs: bigint;
  vaultAddress: string;
  vaultNftUnit: string;
  lampUnit: string;
  fundingAddress: string;
  feePayerAddress: string;
  feePayerUtxo: UTxO;
  /** Mọi UTxO dịch vụ đọc được ở `fundingAddress` lúc dựng. */
  didPaymentUtxos: UTxO[];
  /** Bộ ký `did_payment` phải có trong `required_signers`. */
  signers: [controllerPkh: string, deviceKeyHash: string];
}

export interface AmountView { lovelace: string; lamp_oildrop: string; other_assets: { unit: string; quantity: string }[] }

export interface FundingSummary {
  type: "did_payment";
  address: string;
  did_payment_inputs: string[];
  /** Tổng giá trị các UTxO did_payment bị chi. */
  spent: AmountView;
  /** Output thối về ví Phoenix (cộng lại mọi output ở `address`). */
  returned: AmountView;
  /** Mục rút did_stake (chủ script) — thuộc chủ DID, đã tính vào phần thối. */
  withdrawal_lovelace: string;
  fee_payer: {
    address: string;
    utxo: string;
    input_lovelace: string;
    fee_lovelace: string;
    change_lovelace: string;
    collateral_return_lovelace: string | null;
  };
  valid_to_posix_ms: string;
}

function mismatch(message: string, details: Record<string, unknown> = {}): CodedApiError {
  return new CodedApiError(422, "FUNDING_TX_MISMATCH", `giao dịch vừa dựng lệch hợp đồng funding: ${message}`, details);
}

function sum(into: Record<string, bigint>, a: Record<string, bigint>): Record<string, bigint> {
  for (const [k, v] of Object.entries(a)) into[k] = (into[k] ?? 0n) + v;
  return into;
}

function view(a: Record<string, bigint>, lampUnit: string): AmountView {
  return {
    lovelace: raw(a.lovelace ?? 0n),
    lamp_oildrop: raw(a[lampUnit] ?? 0n),
    other_assets: Object.entries(a)
      .filter(([u, q]) => u !== "lovelace" && u !== lampUnit && q !== 0n)
      .map(([unit, q]) => ({ unit, quantity: raw(q) }))
      .sort((x, y) => (x.unit < y.unit ? -1 : 1)),
  };
}

export function checkFundingTx(txCbor: string, ctx: FundingCheckContext): FundingSummary {
  const tx = CML.Transaction.from_cbor_hex(txCbor);
  const body = tx.body();
  const key = (h: string, i: number | bigint) => `${h}#${Number(i)}`;
  const feeKey = key(ctx.feePayerUtxo.txHash, ctx.feePayerUtxo.outputIndex);
  const dp = new Map(ctx.didPaymentUtxos.map(u => [key(u.txHash, u.outputIndex), u]));

  // (1) input: đúng một UTxO trả phí + ≥1 UTxO did_payment đã biết; không gì khác.
  const inputs: string[] = [];
  const il = body.inputs();
  for (let i = 0; i < il.len(); i++) inputs.push(key(il.get(i).transaction_id().to_hex(), il.get(i).index()));
  const foreign = inputs.filter(k => k !== feeKey && !dp.has(k));
  if (foreign.length > 0) throw mismatch(`input lạ ${foreign.join(", ")}`, { foreign_inputs: foreign });
  const spentKeys = inputs.filter(k => dp.has(k));
  if (!inputs.includes(feeKey)) throw mismatch(`thiếu UTxO trả phí ${feeKey} trong input`);
  if (spentKeys.length === 0) throw mismatch(`không có UTxO did_payment nào trong input`);

  // (2) redeemer Spend: đúng một cho mỗi input did_payment, data = Constr 0 [].
  const sorted = [...inputs].sort((a, b) => {
    const [ha, ia] = a.split("#"); const [hb, ib] = b.split("#");
    return ha! < hb! ? -1 : ha! > hb! ? 1 : Number(ia) - Number(ib);
  });
  const spends: { index: number; data: string }[] = [];
  const rd = tx.witness_set().redeemers();
  const legacy = rd?.as_arr_legacy_redeemer();
  for (let i = 0; legacy !== undefined && i < legacy.len(); i++) {
    const r = legacy.get(i);
    if (r.tag() === CML.RedeemerTag.Spend) spends.push({ index: Number(r.index()), data: r.data().to_cbor_hex() });
  }
  const map = rd?.as_map_redeemer_key_to_redeemer_val();
  if (map !== undefined) {
    const ks = map.keys();
    for (let i = 0; i < ks.len(); i++) {
      const k = ks.get(i);
      if (k.tag() === CML.RedeemerTag.Spend) spends.push({ index: Number(k.index()), data: map.get(k)!.data().to_cbor_hex() });
    }
  }
  const wantIdx = spentKeys.map(k => sorted.indexOf(k)).sort((a, b) => a - b);
  const gotIdx = spends.map(s => s.index).sort((a, b) => a - b);
  if (JSON.stringify(wantIdx) !== JSON.stringify(gotIdx) || spends.some(s => s.data !== DID_PAYMENT_SPEND_REDEEMER)) {
    throw mismatch(`redeemer Spend không khớp input did_payment`, { want_indexes: wantIdx, got: spends });
  }

  // (3) thế chấp: chỉ UTxO trả phí; collateral_return về đúng ví trả phí.
  const cl = body.collateral_inputs();
  for (let i = 0; cl !== undefined && i < cl.len(); i++) {
    const k = key(cl.get(i).transaction_id().to_hex(), cl.get(i).index());
    if (k !== feeKey) throw mismatch(`tài sản thế chấp ${k} không phải UTxO trả phí`);
  }
  const cr = body.collateral_return();
  let collateralReturn: bigint | null = null;
  if (cr !== undefined) {
    if (cr.address().to_bech32(undefined) !== ctx.feePayerAddress) {
      throw mismatch(`collateral_return không về funding.fee_payer.address`);
    }
    collateralReturn = cr.amount().coin();
  }

  // (4) output: chỉ vault / ví Phoenix / ví trả phí.
  const allowed = new Set([ctx.vaultAddress, ctx.fundingAddress, ctx.feePayerAddress]);
  const ol = body.outputs();
  const vaultOut: Record<string, bigint> = {};
  const fundOut: Record<string, bigint> = {};
  const feeOut: Record<string, bigint> = {};
  for (let i = 0; i < ol.len(); i++) {
    const o = ol.get(i);
    const addr = o.address().to_bech32(undefined);
    if (!allowed.has(addr)) throw mismatch(`output #${i} đi tới địa chỉ lạ ${addr}`, { output_index: i });
    const a = valueToAssets(o.amount());
    sum(addr === ctx.vaultAddress ? vaultOut : addr === ctx.fundingAddress ? fundOut : feeOut, a);
  }
  if (Object.keys(feeOut).some(u => u !== "lovelace" && feeOut[u] !== 0n)) {
    throw mismatch(`output về ví trả phí mang token — tài sản của ví Phoenix không được thối sang đó`);
  }

  // (5) bảo toàn: ví trả phí trả ĐÚNG phí; did_payment (+ mục rút) = vault (trừ NFT vừa đúc) + phần thối.
  const fee = body.fee();
  const feeIn = ctx.feePayerUtxo.assets.lovelace ?? 0n;
  const feeChange = feeOut.lovelace ?? 0n;
  if (feeIn !== fee + feeChange) {
    throw mismatch(`ví trả phí góp ${feeIn} lovelace nhưng phí ${fee} + thối ${feeChange} — nó đang trả cho thứ khác ngoài phí`);
  }
  let withdrawal = 0n;
  const wd = body.withdrawals();
  if (wd !== undefined) {
    const ks = wd.keys();
    for (let i = 0; i < ks.len(); i++) withdrawal += wd.get(ks.get(i)) ?? 0n;
  }
  const spent: Record<string, bigint> = {};
  for (const k of spentKeys) sum(spent, dp.get(k)!.assets);
  const vaultNoNft = { ...vaultOut, [ctx.vaultNftUnit]: (vaultOut[ctx.vaultNftUnit] ?? 0n) - 1n };
  const units = new Set([...Object.keys(spent), ...Object.keys(vaultNoNft), ...Object.keys(fundOut), "lovelace"]);
  for (const u of units) {
    const left = (spent[u] ?? 0n) + (u === "lovelace" ? withdrawal : 0n);
    const right = (vaultNoNft[u] ?? 0n) + (fundOut[u] ?? 0n);
    if (left !== right) {
      throw mismatch(`bảo toàn ${u === "lovelace" ? "lovelace" : u.slice(0, 16) + "…"}: did_payment chi ${left}, vault + thối nhận ${right}`, { unit: u });
    }
  }

  // (6) bộ ký did_payment + hạn dùng ≤ 1 giờ kể từ đỉnh chuỗi.
  const rs = body.required_signers();
  const signers: string[] = [];
  for (let i = 0; rs !== undefined && i < rs.len(); i++) signers.push(rs.get(i).to_hex());
  for (const s of ctx.signers) {
    if (!signers.includes(s)) throw mismatch(`required_signers thiếu ${s} (did_payment đòi controller + thiết bị)`);
  }
  const ttl = body.ttl();
  if (ttl === undefined) throw mismatch(`giao dịch không có hạn dùng (validTo) — ví trả phí đòi ≤ 1 giờ`);
  const validTo = BigInt(slotToUnixTime(ctx.network, Number(ttl)));
  if (validTo > ctx.tipPosixMs + FUNDING_MAX_VALIDITY_MS) {
    throw mismatch(`hạn dùng ${validTo} quá 1 giờ kể từ đỉnh chuỗi ${ctx.tipPosixMs}`);
  }

  return {
    type: "did_payment",
    address: ctx.fundingAddress,
    did_payment_inputs: spentKeys,
    spent: view(spent, ctx.lampUnit),
    returned: view(fundOut, ctx.lampUnit),
    withdrawal_lovelace: raw(withdrawal),
    fee_payer: {
      address: ctx.feePayerAddress,
      utxo: feeKey,
      input_lovelace: raw(feeIn),
      fee_lovelace: raw(fee),
      change_lovelace: raw(feeChange),
      collateral_return_lovelace: collateralReturn === null ? null : raw(collateralReturn),
    },
    valid_to_posix_ms: raw(validTo),
  };
}
