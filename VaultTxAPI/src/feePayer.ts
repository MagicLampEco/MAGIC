// VaultTxAPI/src/feePayer.ts — ví trả phí bên thứ ba (mô hình Feecover) cho MỌI đường dựng.
//
// ── LUẬT CỦA BÊN TRẢ PHÍ, VÀ VÌ SAO DỊCH VỤ TỰ ÉP LẠI ────────────────────────────
// Bên trả phí chỉ ký một giao dịch khi:
//   · giao dịch tiêu ĐÚNG MỘT UTxO của ví đó (UTxO khai trong `fee_payer.utxo`);
//   · UTxO đó cũng là tài sản thế chấp DUY NHẤT, và thế chấp có thể mất ≤ trần của họ
//     (cấu hình `fee_payer_collateral_lovelace`, mặc định 3 tADA);
//   · ví đó mất ròng ĐÚNG bằng phí + khoản ỨNG min-ADA (dưới đây): tiền thối ADA +
//     `collateral_return` về lại `fee_payer.address`;
//   · hạn dùng (`validTo`) ≤ 1 giờ kể từ đỉnh chuỗi.
//
// ── KHOẢN ỨNG MIN-ADA (`fronting`) — VẾ NỚI DUY NHẤT, CÓ TRẦN ────────────────────
// Người dùng mới có 0 ADA. Ba chỗ cần ADA mà không ai khác ứng được:
//   · lượt làm datum KÉT dài ra (Sinh thêm lô, làm mới checkpoint): validator két chỉ ép
//     `lovelace(out) >= lovelace(in)` (`InstantGen/onchain/validators/vault.ak` ▸
//     `lovelace_not_decreased`), min-ADA của output két tăng theo datum. Đo trên Preprod
//     2026-10-04: két mở 2 ADA, lượt Sinh đầu đòi nâng 672 360 lovelace;
//   · mở thread Engage: output thread mới mang ≥ `ENGAGE_MIN_LOVELACE` (2 ADA);
//   · mở két Instant 0 LAMP: output két mới mang min-ADA của datum genesis.
// Nên ví trả phí được ỨNG min-ADA cho ĐÚNG MỘT output do đường dựng chỉ định: output ở
// `fronting.address` mang NFT danh-tính `fronting.nftUnit` (két / thread của CHÍNH chủ). Khoản
// ứng = lovelace output đó − lovelace input mang cùng NFT (két cũ), hoặc trọn lovelace output
// (NFT đúc trong chính tx). Khoản ứng > `fronting.maxLovelace` ⟹ 422
// `FEE_PAYER_FRONTING_ABOVE_MAX`. Output nào khác nhận ADA của ví trả phí vẫn là 422
// `FEE_PAYER_TX_MISMATCH` — vế (4) cân ĐÚNG phí + thối + khoản ứng, không dư một lovelace.
// Thread KHÔNG bao giờ được nâng sau khi mở: nhánh Consume ép `out.value == inp.output.value`
// (`ConsumeMAGIC/onchain/validators/consume.ak`), và 2 ADA đã trên min-ADA của datum thread ở
// cỡ trần (`tests/minAdaFloor.test.ts` ghim quan hệ đó).
//
// ── MỤC RÚT `did_stake` > 0 ──────────────────────────────────────────────────────
// Chủ `Script(did_stake)` chứng minh quyền bằng một mục rút TRỌN số dư thưởng lúc dựng
// (`ProtocolUtils/src/didStakeOwnerAuth.ts`). Đi qua ví trả phí thì mọi tiền thối ADA về
// `fee_payer.address` ⟹ thưởng của chủ chảy sang Feecover. Dịch vụ không biết địa chỉ ví Phoenix
// của chủ trên các đường này (thân bài không mang nó), nên không có đích đúng để trả số đó về:
// `assertNoOwnerRewardToFeePayer` dừng ở 422 `FEE_PAYER_OWNER_REWARD_NONZERO` TRƯỚC khi dựng.
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

import { CML, getAddressDetails, slotToUnixTime, valueToAssets, type Network as SlotNetwork, type UTxO } from "@lucid-evolution/lucid";
import { FUNDING_MAX_VALIDITY_MS, type Network } from "@magiclamp/protocol-utils";

import type { ChainReader } from "./chain.js";
import { CodedApiError } from "./errors.js";
import { raw } from "./units.js";

export const OUTREF = /^([0-9a-f]{64})#(0|[1-9][0-9]{0,4})$/;

export interface OutRefLike { txHash: string; outputIndex: number }

export const refStr = (r: OutRefLike): string => `${r.txHash}#${r.outputIndex}`;

/** `{ utxo: "<txhash>#<idx>", address }` — cùng hình dạng ở `fee_payer` và `funding.fee_payer`. */
export interface FeePayerRequest { utxoRef: OutRefLike; address: string }

/** Tên trường + mã lỗi theo CHỖ trường nằm (xem khối đầu tệp). `addressField` vắng ⟹
 *  `<field>.address`; báo giá (`feeQuote.ts`) kiểm một địa chỉ trần nên khai tên riêng. */
export interface FeePayerCodes { field: string; shape: string; invalid: string; addressField?: string }

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
      `"${c.addressField ?? `${c.field}.address`}" phải là địa chỉ bech32 của mạng ${network} với phần thanh toán là KHOÁ ` +
      `(tài sản thế chấp không được là UTxO script).`,
      { payment_credential: d?.paymentCredential?.type ?? null, network_id: d?.networkId ?? null });
  }
}

// ── đọc chuỗi ────────────────────────────────────────────────────────────────

/** Đơn vị tài sản khác 0 của một UTxO. */
function nonZeroUnits(utxo: UTxO): string[] {
  return Object.keys(utxo.assets).filter(k => utxo.assets[k] !== 0n);
}

/** UTxO dùng làm ví trả phí được: thuần ADA, không script tham chiếu (nó còn là tài sản thế chấp).
 *  MỘT vị từ cho cả `readFeePayerUtxo` lẫn phép chọn UTxO của báo giá (`feeQuote.ts`). */
export function isPureAdaFeeUtxo(utxo: UTxO): boolean {
  const units = nonZeroUnits(utxo);
  return units.length === 1 && units[0] === "lovelace" && utxo.scriptRef == null;
}

/** UTxO trả phí: phải ở ĐÚNG `fee_payer.address`, thuần ADA, không script tham chiếu. */
export async function readFeePayerUtxo(chain: ChainReader, fp: FeePayerRequest, c: FeePayerCodes): Promise<UTxO> {
  const [u] = await chain.utxosByOutRef([fp.utxoRef]);
  // Tham chiếu không còn là UTxO chưa tiêu ⟹ 400 có mã. Bản trước đọc `.address` trên `undefined` ⟹ 500.
  if (u === undefined) {
    throw new CodedApiError(400, c.invalid,
      `UTxO trả phí ${refStr(fp.utxoRef).slice(0, 12)}… không phải UTxO chưa tiêu.`,
      { fee_payer_utxo: refStr(fp.utxoRef) });
  }
  const utxo = u as UTxO;
  if (utxo.address !== fp.address) {
    throw new CodedApiError(400, c.invalid,
      `UTxO trả phí ${refStr(fp.utxoRef).slice(0, 12)}… không nằm ở ${c.field}.address.`,
      { fee_payer_utxo: refStr(fp.utxoRef) });
  }
  const units = nonZeroUnits(utxo);
  if (!isPureAdaFeeUtxo(utxo)) {
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
export function checkValidTo(body: CML.TransactionBody, network: SlotNetwork, tipPosixMs: bigint, fail: Fail): bigint {
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
  /** Min-ADA ví trả phí ỨNG cho output két/thread của chủ (khối đầu tệp). `"0"` khi không ứng. */
  fronted_lovelace: string;
  /** Trần khoản ứng đang có hiệu lực (`fee_payer_fronting_max_lovelace`). */
  fronted_max_lovelace: string;
  /** Chỉ số output nhận khoản ứng; `null` khi đường dựng không chỉ định output nào. */
  fronted_output_index: number | null;
  /** Phần min-ADA ví trả phí ứng cho output DÙNG CHUNG (shard GreenBack) — đã gồm trong
   *  `fronted_lovelace`. `"0"` khi không có. */
  shared_fronted_lovelace: string;
  /** Từng output dùng chung được ứng: chỉ số output + số lovelace ứng. */
  shared_fronted_outputs: { output_index: number; lovelace: string }[];
  /** `Σ collateral_inputs − collateral_return` — thứ bên trả phí có thể mất nếu script hỏng. */
  collateral_at_risk_lovelace: string;
  collateral_return_lovelace: string | null;
  valid_to_posix_ms: string;
}

/** Output DUY NHẤT được nhận khoản ứng min-ADA của ví trả phí (khối đầu tệp). */
export interface FeePayerFronting {
  /** Địa chỉ của output được ứng. */
  address: string;
  /** NFT danh-tính (`policy + tên`) của đúng output đó — két hoặc thread của chính chủ. */
  nftUnit: string;
  /** Input mang cùng NFT (két đang bị tiêu). Vắng ⟹ output MỚI: NFT phải được đúc trong tx. */
  inputRef?: OutRefLike;
  /** Trần khoản ứng (lovelace). */
  maxLovelace: bigint;
}

/**
 * UTxO DÙNG CHUNG của luồng (shard GreenBack) được nhận khoản ứng min-ADA. Nhánh sinh tiêu một
 * shard rồi dựng lại nó với datum dài hơn, nên min-ADA của shard có thể TĂNG — và trên đường
 * chủ tự trả, chính chủ trả phần tăng đó. Qua ví trả phí, người dùng 0 ADA không trả được, nên
 * ví trả phí ứng — nhưng chỉ cho output mang token của `policyId`, ở đúng `address`, mà input
 * mang CÙNG token đó cũng ở `address` (shard dựng lại, không phải shard mới). Mỗi output ≤ trần.
 */
export interface FeePayerSharedFronting {
  address: string;
  policyId: string;
  maxLovelace: bigint;
}

export interface FeePayerCheckContext {
  network: Network;
  tipPosixMs: bigint;
  feePayer: FeePayerRequest;
  feePayerUtxo: UTxO;
  maxCollateralLovelace: bigint;
  /** Mọi input KHÁC UTxO trả phí, đã đọc từ chuỗi (dịch vụ tra theo tham chiếu trong CBOR). */
  otherInputs: UTxO[];
  /** Output được nhận khoản ứng; vắng ⟹ ví trả phí chỉ được mất đúng bằng phí. */
  fronting?: FeePayerFronting;
  /** Output dùng chung được nhận khoản ứng (shard GreenBack); vắng ⟹ không ứng cho output nào khác két/thread. */
  sharedFrontings?: readonly FeePayerSharedFronting[];
  /** Tập ĐÓNG địa chỉ mà input khác UTxO trả phí được phép nằm. Vắng ⟹ không ép (đường dựng
   *  tiêu nhiều UTxO script của luồng). `[]` ⟹ UTxO trả phí là input DUY NHẤT. */
  otherInputAddresses?: readonly string[];
}

/**
 * Chủ `Script(did_stake)` có số dư thưởng > 0 mà đi qua ví trả phí ⟹ 422
 * `FEE_PAYER_OWNER_REWARD_NONZERO`, TRƯỚC khi dựng (khối đầu tệp, vế mục rút). Chủ khoá (vắng
 * `reward`), hoặc số dư 0 ⟹ không làm gì. `reward` = `ResolvedOwnerWitness.ownerReward`.
 */
export function assertNoOwnerRewardToFeePayer(
  reward: { rewardAddress: string; withdrawLovelace: bigint } | undefined,
): void {
  if (reward === undefined || reward.withdrawLovelace <= 0n) return;
  throw new CodedApiError(422, "FEE_PAYER_OWNER_REWARD_NONZERO",
    `Tài khoản thưởng của chủ (${reward.rewardAddress}) đang có ${reward.withdrawLovelace} lovelace. Nhân ` +
    `chứng chủ did_stake rút TRỌN số dư đó, và qua "fee_payer" thì tiền thối về ví trả phí — thưởng của ` +
    `chủ sẽ chảy sang bên trả phí. Rút thưởng về ví của chủ trước (một giao dịch tự trả phí), hoặc gửi ` +
    `"change_address" thay cho "fee_payer".`,
    { reward_address: reward.rewardAddress, withdraw_lovelace: raw(reward.withdrawLovelace) });
}

/**
 * Khoản ứng min-ADA cho output `ctx.fronting` (khối đầu tệp). Không có `fronting` ⟹ 0.
 *
 * Output đích: ĐÚNG MỘT output mang `fronting.nftUnit`, ở đúng `fronting.address`. Gốc so:
 * input `fronting.inputRef` (phải là input của tx, mang cùng NFT, cùng địa chỉ) hoặc — vắng
 * `inputRef` — NFT phải được đúc đúng 1 trong tx (output mới, gốc 0). Khoản ứng =
 * `max(0, lovelace(out) − lovelace(gốc))`; vượt `maxLovelace` ⟹ 422 `FEE_PAYER_FRONTING_ABOVE_MAX`.
 */
function frontingOf(
  body: CML.TransactionBody, ctx: FeePayerCheckContext,
  outs: { index: number; address: string; lovelace: bigint }[], resolved: Map<string, UTxO>, fail: Fail,
): { fronted: bigint; outputIndex: number | null } {
  const f = ctx.fronting;
  if (f === undefined) return { fronted: 0n, outputIndex: null };
  const unit = f.nftUnit;
  if (outs.length !== 1) {
    throw fail(`${outs.length} output mang NFT ${unit.slice(0, 16)}… — cần ĐÚNG MỘT (két/thread được ứng min-ADA)`,
      { nft_unit: unit, outputs: outs.map(o => o.index) });
  }
  const out = outs[0]!;
  if (out.address !== f.address) {
    throw fail(`output #${out.index} mang NFT ${unit.slice(0, 16)}… nhưng nằm ở ${out.address}, không ở địa chỉ két/thread`,
      { output_index: out.index });
  }
  let base = 0n;
  if (f.inputRef !== undefined) {
    const k = refStr(f.inputRef);
    const u = resolved.get(k);
    if (u === undefined || u.address !== f.address || (u.assets[unit] ?? 0n) !== 1n) {
      throw fail(`input ${k} không phải két/thread mang NFT ${unit.slice(0, 16)}… ở địa chỉ khai`, { input: k });
    }
    base = u.assets.lovelace ?? 0n;
  } else {
    const minted = mintedQty(body, unit);
    if (minted !== 1n) {
      throw fail(`NFT ${unit.slice(0, 16)}… không được đúc đúng 1 trong giao dịch (đúc ${minted}) — output mới phải mang NFT vừa đúc`,
        { nft_unit: unit, minted: raw(minted) });
    }
  }
  const fronted = out.lovelace > base ? out.lovelace - base : 0n;
  if (fronted > f.maxLovelace) {
    throw new CodedApiError(422, "FEE_PAYER_FRONTING_ABOVE_MAX",
      `Ví trả phí phải ứng ${fronted} lovelace min-ADA cho output #${out.index}, vượt trần ${f.maxLovelace} ` +
      `(fee_payer_fronting_max_lovelace). Bên trả phí chỉ ứng tới trần đó.`,
      { fronted_lovelace: raw(fronted), fronted_max_lovelace: raw(f.maxLovelace), output_index: out.index });
  }
  return { fronted, outputIndex: out.index };
}

/**
 * Khoản ứng min-ADA cho output dùng chung (`ctx.sharedFrontings`). Với mỗi output ở `address`
 * mang token của `policyId`: phải có ĐÚNG MỘT input ở cùng địa chỉ mang cùng token (shard được
 * tiêu rồi dựng lại); khoản ứng = `max(0, lovelace(out) − lovelace(in))`, ≤ `maxLovelace`.
 */
function sharedFrontingOf(
  body: CML.TransactionBody, ctx: FeePayerCheckContext, resolved: Map<string, UTxO>, fail: Fail,
): { total: bigint; outputs: { output_index: number; lovelace: string }[] } {
  const list = ctx.sharedFrontings ?? [];
  if (list.length === 0) return { total: 0n, outputs: [] };
  const ins = [...resolved.values()];
  const ol = body.outputs();
  let total = 0n;
  const outputs: { output_index: number; lovelace: string }[] = [];
  for (let i = 0; i < ol.len(); i++) {
    const o = ol.get(i);
    const addr = o.address().to_bech32(undefined);
    const sf = list.find(s => s.address === addr);
    if (sf === undefined) continue;
    const a = valueToAssets(o.amount());
    const units = Object.keys(a).filter(u => u !== "lovelace" && u.startsWith(sf.policyId) && a[u] === 1n);
    if (units.length !== 1) continue;
    const unit = units[0]!;
    const src = ins.filter(u => u.address === addr && (u.assets[unit] ?? 0n) === 1n);
    if (src.length !== 1) {
      throw fail(`output #${i} mang ${unit.slice(0, 16)}… ở địa chỉ dùng chung nhưng có ${src.length} input mang cùng token — ` +
        `chỉ ứng min-ADA cho output dùng chung được tiêu rồi dựng lại`, { output_index: i });
    }
    const base = src[0]!.assets.lovelace ?? 0n;
    const out = a.lovelace ?? 0n;
    const fronted = out > base ? out - base : 0n;
    if (fronted === 0n) continue;
    if (fronted > sf.maxLovelace) {
      throw new CodedApiError(422, "FEE_PAYER_FRONTING_ABOVE_MAX",
        `Ví trả phí phải ứng ${fronted} lovelace min-ADA cho output dùng chung #${i}, vượt trần ${sf.maxLovelace} ` +
        `(fee_payer_fronting_max_lovelace). Bên trả phí chỉ ứng tới trần đó.`,
        { fronted_lovelace: raw(fronted), fronted_max_lovelace: raw(sf.maxLovelace), output_index: i });
    }
    total += fronted;
    outputs.push({ output_index: i, lovelace: raw(fronted) });
  }
  return { total, outputs };
}

/** Lượng đúc (âm = đốt) của `unit` trong thân giao dịch. */
function mintedQty(body: CML.TransactionBody, unit: string): bigint {
  const mint = body.mint();
  if (mint === undefined) return 0n;
  const pos = valueToAssets(CML.Value.new(0n, mint.as_positive_multiasset()));
  const neg = valueToAssets(CML.Value.new(0n, mint.as_negative_multiasset()));
  return (pos[unit] ?? 0n) - (neg[unit] ?? 0n);
}

/**
 * Đọc lại giao dịch vừa dựng và ép luật của bên trả phí (khối đầu tệp). Lệch ⟹ 422
 * `FEE_PAYER_TX_MISMATCH` ở vế đầu tiên lệch; khoản ứng vượt trần ⟹ 422 `FEE_PAYER_FRONTING_ABOVE_MAX`.
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

  // (1) input: UTxO trả phí CÓ mặt, và là UTxO DUY NHẤT của ví đó; input khác nằm trong tập đóng
  //     `otherInputAddresses` khi đường dựng khai tập đó.
  const inputs = inputRefsOf(txCbor).map(refStr);
  if (!inputs.includes(feeKey)) throw fail(`UTxO trả phí ${feeKey} không phải input của giao dịch`);
  const resolved = new Map(ctx.otherInputs.map(u => [`${u.txHash}#${u.outputIndex}`, u]));
  const allowedIn = ctx.otherInputAddresses === undefined ? undefined : new Set(ctx.otherInputAddresses);
  for (const k of inputs) {
    if (k === feeKey) continue;
    const u = resolved.get(k);
    if (u === undefined) throw fail(`input ${k} không đối chiếu được với chuỗi`, { input: k });
    if (ownedByFeePayer(u.address)) {
      throw fail(`input ${k} cũng thuộc ví trả phí — bên trả phí chỉ cho tiêu ĐÚNG MỘT UTxO`, { input: k });
    }
    if (allowedIn !== undefined && !allowedIn.has(u.address)) {
      throw fail(`input ${k} ở ${u.address} — ngoài UTxO trả phí và các UTxO script của luồng (chủ không góp UTxO nào)`,
        { input: k });
    }
  }

  // (2) thế chấp.
  const { atRisk, collateralReturn } = checkCollateral(
    body, feeKey, ctx.feePayerUtxo, ctx.feePayer.address, ctx.maxCollateralLovelace, fail);

  // (3) output về ví trả phí: đúng địa chỉ khai, chỉ ADA. Cùng khoá mà khác địa chỉ = thối nhầm.
  //     Đồng thời tìm output nhận khoản ứng (mang NFT `fronting.nftUnit`).
  const ol = body.outputs();
  let change = 0n;
  const frontedOuts: { index: number; address: string; lovelace: bigint }[] = [];
  for (let i = 0; i < ol.len(); i++) {
    const o = ol.get(i);
    const addr = o.address().to_bech32(undefined);
    const a = valueToAssets(o.amount());
    if (ctx.fronting !== undefined && (a[ctx.fronting.nftUnit] ?? 0n) > 0n) {
      frontedOuts.push({ index: i, address: addr, lovelace: a.lovelace ?? 0n });
    }
    if (addr === ctx.feePayer.address) {
      if (Object.keys(a).some(u => u !== "lovelace" && a[u] !== 0n)) {
        throw fail(`output #${i} về ví trả phí mang token — tài sản của người khác không được thối sang đó`, { output_index: i });
      }
      change += a.lovelace ?? 0n;
    } else if (ownedByFeePayer(addr)) {
      throw fail(`output #${i} về ${addr}: cùng khoá với ví trả phí nhưng KHÔNG phải fee_payer.address`, { output_index: i });
    }
  }
  const { fronted: ownFronted, outputIndex: frontedIndex } = frontingOf(body, ctx, frontedOuts, resolved, fail);
  const shared = sharedFrontingOf(body, ctx, resolved, fail);
  const fronted = ownFronted + shared.total;

  // (4) ví trả phí mất ròng ĐÚNG bằng phí + khoản ứng.
  const fee = body.fee();
  const feeIn = ctx.feePayerUtxo.assets.lovelace ?? 0n;
  if (feeIn !== fee + change + fronted) {
    let withdrawal = 0n;
    const wd = body.withdrawals();
    if (wd !== undefined) {
      const ks = wd.keys();
      for (let i = 0; i < ks.len(); i++) withdrawal += wd.get(ks.get(i)) ?? 0n;
    }
    const spent = fee + change + fronted;
    const why = feeIn > spent
      ? `nó đang trả cho thứ khác ngoài phí${fronted > 0n ? " và khoản ứng min-ADA" : ""} (${feeIn - spent} lovelace)`
      : withdrawal > 0n
        ? `ví nhận THÊM ${spent - feeIn} lovelace — mục rút ${withdrawal} lovelace của chủ đang chảy về ví trả phí`
        : `ví nhận THÊM ${spent - feeIn} lovelace của người khác`;
    throw fail(`ví trả phí góp ${feeIn} lovelace nhưng phí ${fee} + thối ${change}` +
      `${fronted > 0n ? ` + ứng min-ADA ${fronted}` : ""}: ${why}`);
  }

  // (5) hạn dùng.
  const validTo = checkValidTo(body, ctx.network, ctx.tipPosixMs, fail);

  return {
    address: ctx.feePayer.address,
    utxo: feeKey,
    input_lovelace: raw(feeIn),
    fee_lovelace: raw(fee),
    change_lovelace: raw(change),
    fronted_lovelace: raw(fronted),
    fronted_max_lovelace: raw(ctx.fronting?.maxLovelace ?? 0n),
    fronted_output_index: frontedIndex,
    shared_fronted_lovelace: raw(shared.total),
    shared_fronted_outputs: shared.outputs,
    collateral_at_risk_lovelace: raw(atRisk),
    collateral_return_lovelace: collateralReturn === null ? null : raw(collateralReturn),
    valid_to_posix_ms: raw(validTo),
  };
}
