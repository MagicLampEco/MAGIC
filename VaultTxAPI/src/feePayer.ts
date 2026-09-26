// VaultTxAPI/src/feePayer.ts — ví trả phí bên thứ ba (mô hình Feecover) cho MỌI đường dựng.
//
// ── LUẬT CỦA BÊN TRẢ PHÍ, VÀ VÌ SAO DỊCH VỤ TỰ ÉP LẠI ────────────────────────────
// Bên trả phí chỉ ký một giao dịch khi:
//   · giao dịch tiêu ĐÚNG MỘT UTxO của ví đó (UTxO khai trong `fee_payer.utxo`);
//   · UTxO đó cũng là tài sản thế chấp DUY NHẤT, và thế chấp có thể mất ≤ trần của họ
//     (cấu hình `fee_payer_collateral_lovelace`, mặc định 3 tADA);
//   · ví đó mất ròng ĐÚNG bằng phí: tiền thối ADA + `collateral_return` về lại `fee_payer.address`;
//   · hạn dùng (`validTo`) ≤ 1 giờ kể từ đỉnh chuỗi.
// Dịch vụ không tin bộ dựng về bất kỳ vế nào ở trên: `checkFeePayerTx` đọc lại TỪ CBOR. Một
// giao dịch lệch mà vẫn trả về là một giao dịch bên trả phí từ chối SAU khi người dùng đã ký —
// hoặc tệ hơn, một giao dịch bên trả phí ký nhầm.
//
// ── MÃ LỖI: `FEE_PAYER_*` RIÊNG, KHÔNG TÁI DÙNG `FUNDING_*` ──────────────────────
// Cùng hình dạng, cùng hàm đọc/kiểm với `funding.fee_payer` (`funding.ts` gọi thẳng các hàm
// ở đây), nhưng khác MÃ. Lý do: `FUNDING_*` gọi tên một yêu cầu nạp LAMP từ ví Phoenix, thứ
// không có mặt trên các đường này. App rẽ nhánh theo mã sẽ đọc `FUNDING_FEE_PAYER_INVALID`
// trên `/tx/consume` thành "phần funding sai" — một trường nó không hề gửi. Mã đi theo TRƯỜNG
// bị sai: `fee_payer` ⟹ `FEE_PAYER_*`, `funding.fee_payer` ⟹ `FUNDING_*` (giữ nguyên như cũ).

import { CML, getAddressDetails, slotToUnixTime, valueToAssets, type UTxO } from "@lucid-evolution/lucid";
import { FUNDING_MAX_VALIDITY_MS, type Network } from "@magiclamp/protocol-utils";

import type { ChainReader } from "./chain.js";
import { CodedApiError } from "./errors.js";
import { raw } from "./units.js";

export const OUTREF = /^([0-9a-f]{64})#(0|[1-9][0-9]{0,4})$/;

export interface OutRefLike { txHash: string; outputIndex: number }

export const refStr = (r: OutRefLike): string => `${r.txHash}#${r.outputIndex}`;

/** `{ utxo: "<txhash>#<idx>", address }` — cùng hình dạng ở `fee_payer` và `funding.fee_payer`. */
export interface FeePayerRequest { utxoRef: OutRefLike; address: string }

/** Tên trường + mã lỗi theo CHỖ trường nằm (xem khối đầu tệp). */
export interface FeePayerCodes { field: string; shape: string; invalid: string }

export const FUNDING_FEE_PAYER_CODES: FeePayerCodes = {
  field: "funding.fee_payer", shape: "FUNDING_SHAPE", invalid: "FUNDING_FEE_PAYER_INVALID",
};
export const FEE_PAYER_CODES: FeePayerCodes = {
  field: "fee_payer", shape: "FEE_PAYER_SHAPE", invalid: "FEE_PAYER_INVALID",
};

// ── đọc thân bài ─────────────────────────────────────────────────────────────

/** Hình dạng `{ utxo, address }`, không trường lạ. Sai ⟹ 400 `<codes.shape>`. */
export function parseFeePayerShape(fp: unknown, c: FeePayerCodes): FeePayerRequest {
  const bad = (sub: string, want: string) =>
    new CodedApiError(400, c.shape, `"${c.field}${sub}" phải là ${want}.`, { field: `${c.field}${sub}` });
  if (fp === null || typeof fp !== "object" || Array.isArray(fp)) throw bad("", `đối tượng { "utxo", "address" }`);
  const o = fp as Record<string, unknown>;
  const extra = Object.keys(o).filter(k => k !== "utxo" && k !== "address");
  if (extra.length > 0) {
    throw new CodedApiError(400, c.shape, `"${c.field}" có trường lạ: ${extra.join(", ")}.`, { extra_fields: extra });
  }
  const m = typeof o.utxo === "string" ? OUTREF.exec(o.utxo) : null;
  if (m === null) throw bad(".utxo", `chuỗi "<tx_hash 64 hex>#<index>"`);
  if (typeof o.address !== "string" || o.address === "") throw bad(".address", "chuỗi địa chỉ bech32 khác rỗng");
  return { utxoRef: { txHash: m[1]!, outputIndex: Number(m[2]!) }, address: o.address };
}

/** `fee_payer` ở gốc thân bài — tuỳ chọn, mọi đường dựng trừ `/tx/create-vault`. */
export function parseFeePayer(body: Record<string, unknown>): FeePayerRequest | undefined {
  if (body.fee_payer === undefined) return undefined;
  return parseFeePayerShape(body.fee_payer, FEE_PAYER_CODES);
}

// ── kiểm tĩnh ────────────────────────────────────────────────────────────────

/** Khoá băm thanh toán của một địa chỉ, hoặc `null` khi phần thanh toán không phải khoá / không đọc được. */
function paymentKeyHashOf(address: string): string | null {
  try {
    const d = getAddressDetails(address);
    return d.paymentCredential?.type === "Key" ? d.paymentCredential.hash : null;
  } catch {
    return null;
  }
}

/**
 * `fee_payer.address` phải là bech32 của ĐÚNG mạng với payment credential là KHOÁ: tài sản thế
 * chấp không được là UTxO script (ledger), và bên trả phí ký bằng khoá đó.
 */
export function assertFeePayerAddress(network: Network, fp: FeePayerRequest, c: FeePayerCodes): void {
  const wantId = network === "Mainnet" ? 1 : 0;
  let d: ReturnType<typeof getAddressDetails> | undefined;
  try { d = getAddressDetails(fp.address); } catch { d = undefined; }
  if (d === undefined || d.networkId !== wantId || d.paymentCredential?.type !== "Key" || !fp.address.startsWith("addr")) {
    throw new CodedApiError(400, c.invalid,
      `"${c.field}.address" phải là địa chỉ bech32 của mạng ${network} với phần thanh toán là KHOÁ ` +
      `(tài sản thế chấp không được là UTxO script).`,
      { payment_credential: d?.paymentCredential?.type ?? null, network_id: d?.networkId ?? null });
  }
}

// ── đọc chuỗi ────────────────────────────────────────────────────────────────

/** UTxO trả phí: phải ở ĐÚNG `fee_payer.address`, thuần ADA, không script tham chiếu. */
export async function readFeePayerUtxo(chain: ChainReader, fp: FeePayerRequest, c: FeePayerCodes): Promise<UTxO> {
  const [u] = await chain.utxosByOutRef([fp.utxoRef]);
  const utxo = u as UTxO;
  if (utxo.address !== fp.address) {
    throw new CodedApiError(400, c.invalid,
      `UTxO trả phí ${refStr(fp.utxoRef).slice(0, 12)}… không nằm ở ${c.field}.address.`,
      { fee_payer_utxo: refStr(fp.utxoRef) });
  }
  const units = Object.keys(utxo.assets).filter(k => utxo.assets[k] !== 0n);
  if (units.length !== 1 || units[0] !== "lovelace" || utxo.scriptRef != null) {
    throw new CodedApiError(400, c.invalid,
      `UTxO trả phí phải thuần ADA, không token, không script tham chiếu (nó còn là tài sản thế chấp).`,
      { fee_payer_utxo: refStr(fp.utxoRef), units });
  }
  return utxo;
}

// ── đọc lại CBOR: các vế DÙNG CHUNG với `checkFundingTx` ──────────────────────

type Fail = (message: string, details?: Record<string, unknown>) => CodedApiError;

/**
 * Thế chấp: chỉ UTxO trả phí; `collateral_return` (nếu có) về đúng ví trả phí; lượng có thể mất
 * `Σ collateral_inputs − collateral_return` ≤ `maxCollateral`.
 *
 * Vắng `collateral_return` thì lượng có thể mất là TRỌN UTxO trả phí — đó là một con số, không
 * phải một ca được miễn.
 */
export function checkCollateral(
  body: CML.TransactionBody, feeKey: string, feeUtxo: UTxO, feePayerAddress: string,
  maxCollateral: bigint, fail: Fail,
): { atRisk: bigint; collateralReturn: bigint | null } {
  const cl = body.collateral_inputs();
  let collateralIn = 0n;
  for (let i = 0; cl !== undefined && i < cl.len(); i++) {
    const k = `${cl.get(i).transaction_id().to_hex()}#${cl.get(i).index()}`;
    if (k !== feeKey) throw fail(`tài sản thế chấp ${k} không phải UTxO trả phí`);
    collateralIn += feeUtxo.assets.lovelace ?? 0n;
  }
  const cr = body.collateral_return();
  let collateralReturn: bigint | null = null;
  if (cr !== undefined) {
    if (cr.address().to_bech32(undefined) !== feePayerAddress) {
      throw fail(`collateral_return không về địa chỉ ví trả phí`);
    }
    collateralReturn = cr.amount().coin();
  }
  const atRisk = collateralIn - (collateralReturn ?? 0n);
  if (atRisk > maxCollateral) {
    throw fail(
      `thế chấp có thể mất ${atRisk} lovelace, vượt trần ${maxCollateral} của ví trả phí ` +
      `(Σ collateral_inputs ${collateralIn} − collateral_return ${collateralReturn ?? 0n})`,
      { collateral_at_risk_lovelace: raw(atRisk), max_collateral_lovelace: raw(maxCollateral) },
    );
  }
  return { atRisk, collateralReturn };
}

/** Hạn dùng phải CÓ và ≤ 1 giờ kể từ đỉnh chuỗi. Trả `validTo` (POSIX ms). */
export function checkValidTo(body: CML.TransactionBody, network: Network, tipPosixMs: bigint, fail: Fail): bigint {
  const ttl = body.ttl();
  if (ttl === undefined) throw fail(`giao dịch không có hạn dùng (validTo) — ví trả phí đòi ≤ 1 giờ`);
  const validTo = BigInt(slotToUnixTime(network, Number(ttl)));
  if (validTo > tipPosixMs + FUNDING_MAX_VALIDITY_MS) {
    throw fail(`hạn dùng ${validTo} quá 1 giờ kể từ đỉnh chuỗi ${tipPosixMs}`);
  }
  return validTo;
}

/** Mọi input của thân giao dịch, dạng `<txhash>#<idx>`, theo thứ tự trong CBOR. */
export function inputRefsOf(txCbor: string): OutRefLike[] {
  const ins = CML.Transaction.from_cbor_hex(txCbor).body().inputs();
  const out: OutRefLike[] = [];
  for (let i = 0; i < ins.len(); i++) {
    out.push({ txHash: ins.get(i).transaction_id().to_hex(), outputIndex: Number(ins.get(i).index()) });
  }
  return out;
}

// ── đọc lại CBOR: đường `fee_payer` ───────────────────────────────────────────

export interface FeePayerSummary {
  address: string;
  utxo: string;
  input_lovelace: string;
  fee_lovelace: string;
  change_lovelace: string;
  /** `Σ collateral_inputs − collateral_return` — thứ bên trả phí có thể mất nếu script hỏng. */
  collateral_at_risk_lovelace: string;
  collateral_return_lovelace: string | null;
  valid_to_posix_ms: string;
}

export interface FeePayerCheckContext {
  network: Network;
  tipPosixMs: bigint;
  feePayer: FeePayerRequest;
  feePayerUtxo: UTxO;
  maxCollateralLovelace: bigint;
  /** Mọi input KHÁC UTxO trả phí, đã đọc từ chuỗi (dịch vụ tra theo tham chiếu trong CBOR). */
  otherInputs: UTxO[];
}

/**
 * Đọc lại giao dịch vừa dựng và ép luật của bên trả phí (khối đầu tệp). Lệch ⟹ 422
 * `FEE_PAYER_TX_MISMATCH` ở vế đầu tiên lệch.
 */
export function checkFeePayerTx(txCbor: string, ctx: FeePayerCheckContext): FeePayerSummary {
  const fail: Fail = (m, d = {}) =>
    new CodedApiError(422, "FEE_PAYER_TX_MISMATCH", `giao dịch vừa dựng lệch luật ví trả phí: ${m}`, d);
  let tx: CML.Transaction;
  try {
    tx = CML.Transaction.from_cbor_hex(txCbor);
  } catch (e) {
    throw fail(`CBOR không giải mã được: ${(e as Error).message}`);
  }
  const body = tx.body();
  const feeKey = refStr(ctx.feePayer.utxoRef);
  const feeHash = paymentKeyHashOf(ctx.feePayer.address);
  if (feeHash === null) throw fail(`fee_payer.address không có phần thanh toán là khoá`);
  const ownedByFeePayer = (address: string) => paymentKeyHashOf(address) === feeHash;

  // (1) input: UTxO trả phí CÓ mặt, và là UTxO DUY NHẤT của ví đó.
  const inputs = inputRefsOf(txCbor).map(refStr);
  if (!inputs.includes(feeKey)) throw fail(`UTxO trả phí ${feeKey} không phải input của giao dịch`);
  const resolved = new Map(ctx.otherInputs.map(u => [`${u.txHash}#${u.outputIndex}`, u]));
  for (const k of inputs) {
    if (k === feeKey) continue;
    const u = resolved.get(k);
    if (u === undefined) throw fail(`input ${k} không đối chiếu được với chuỗi`, { input: k });
    if (ownedByFeePayer(u.address)) {
      throw fail(`input ${k} cũng thuộc ví trả phí — bên trả phí chỉ cho tiêu ĐÚNG MỘT UTxO`, { input: k });
    }
  }

  // (2) thế chấp.
  const { atRisk, collateralReturn } = checkCollateral(
    body, feeKey, ctx.feePayerUtxo, ctx.feePayer.address, ctx.maxCollateralLovelace, fail);

  // (3) output về ví trả phí: đúng địa chỉ khai, chỉ ADA. Cùng khoá mà khác địa chỉ = thối nhầm.
  const ol = body.outputs();
  let change = 0n;
  for (let i = 0; i < ol.len(); i++) {
    const o = ol.get(i);
    const addr = o.address().to_bech32(undefined);
    if (addr === ctx.feePayer.address) {
      const a = valueToAssets(o.amount());
      if (Object.keys(a).some(u => u !== "lovelace" && a[u] !== 0n)) {
        throw fail(`output #${i} về ví trả phí mang token — tài sản của người khác không được thối sang đó`, { output_index: i });
      }
      change += a.lovelace ?? 0n;
    } else if (ownedByFeePayer(addr)) {
      throw fail(`output #${i} về ${addr}: cùng khoá với ví trả phí nhưng KHÔNG phải fee_payer.address`, { output_index: i });
    }
  }

  // (4) ví trả phí mất ròng ĐÚNG bằng phí.
  const fee = body.fee();
  const feeIn = ctx.feePayerUtxo.assets.lovelace ?? 0n;
  if (feeIn !== fee + change) {
    let withdrawal = 0n;
    const wd = body.withdrawals();
    if (wd !== undefined) {
      const ks = wd.keys();
      for (let i = 0; i < ks.len(); i++) withdrawal += wd.get(ks.get(i)) ?? 0n;
    }
    const why = feeIn > fee + change
      ? `nó đang trả cho thứ khác ngoài phí (${feeIn - fee - change} lovelace)`
      : withdrawal > 0n
        ? `ví nhận THÊM ${fee + change - feeIn} lovelace — mục rút ${withdrawal} lovelace của chủ đang chảy về ví trả phí`
        : `ví nhận THÊM ${fee + change - feeIn} lovelace của người khác`;
    throw fail(`ví trả phí góp ${feeIn} lovelace nhưng phí ${fee} + thối ${change}: ${why}`);
  }

  // (5) hạn dùng.
  const validTo = checkValidTo(body, ctx.network, ctx.tipPosixMs, fail);

  return {
    address: ctx.feePayer.address,
    utxo: feeKey,
    input_lovelace: raw(feeIn),
    fee_lovelace: raw(fee),
    change_lovelace: raw(change),
    collateral_at_risk_lovelace: raw(atRisk),
    collateral_return_lovelace: collateralReturn === null ? null : raw(collateralReturn),
    valid_to_posix_ms: raw(validTo),
  };
}
