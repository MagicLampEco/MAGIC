// VaultTxAPI/src/funding.ts — `funding` của `/tx/create-vault`: nạp LAMP từ ví Phoenix.
//
// ── BA VÍ, BA VAI ────────────────────────────────────────────────────────────────
//   · ví Phoenix (`funding.address`, payment credential = script `did_payment`): trả LAMP của
//     output vault, KHÔNG lovelace nào; phần thối (LAMP, token khác, TRỌN lovelace của UTxO đã
//     chi, cả mục rút `did_stake` nếu chủ là script) về LẠI chính địa chỉ này.
//   · ví trả phí (`funding.fee_payer`, khoá ký — mô hình Feecover): ĐÚNG MỘT UTxO thuần ADA,
//     vừa là input trả phí vừa là tài sản thế chấp vừa là seed của NFT danh-tính; nó trả phí và
//     ỨNG min-ADA của output vault mới (trọn lovelace output đó — NFT đúc trong tx — có trần
//     `fee_payer_fronting_max_lovelace`, cùng luật khoản ứng ở `feePayer.ts`); tiền thối ADA và
//     `collateral_return` về đúng `fee_payer.address`. Lý do: DID mới thường chỉ có LAMP + ~1,2
//     ADA ở did_payment, dưới min-ADA của két (~2,1 ADA); bắt did_payment trả nó là chặn đúng
//     người dùng cần ví trả phí.
//   · Két instant 0 LAMP, chủ không có mục rút: did_payment không góp gì ⟹ giao dịch KHÔNG chi
//     UTxO did_payment nào (không redeemer, không bộ ký did_payment); quyền chủ vẫn ép như mọi
//     đường. Bảo toàn ở vế (5) bắt két mang LAMP mà không chi did_payment.
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

import { CML, getAddressDetails, valueToAssets, type UTxO } from "@lucid-evolution/lucid";
import {
  FundingError, assertDidPaymentAddress, DID_PAYMENT_SPEND_REDEEMER,
  type Network,
} from "@magiclamp/protocol-utils";
import { didPaymentLucidPorts, vaultIdAssetName } from "@magiclamp/sdk";

import type { ChainReader } from "./chain.js";
import { CodedApiError } from "./errors.js";
import { carriesAnchorNft } from "./owner.js";
import {
  FUNDING_FEE_PAYER_CODES, OUTREF, assertFeePayerAddress, checkCollateral, checkValidTo,
  parseFeePayerShape, readFeePayerUtxo as readFeePayerUtxoShared, refStr,
  type FeePayerCodes, type FeePayerRequest, type OutRefLike,
} from "./feePayer.js";
import { raw } from "./units.js";

const HASH28 = /^[0-9a-f]{56}$/;
const CBOR_HEX = /^(?:[0-9a-f]{2})+$/;

export type { OutRefLike } from "./feePayer.js";

/**
 * Mã lỗi của `funding.collateral` (chế độ `fee_source: "did_payment"`). Cùng hình dạng + cùng hàm
 * đọc/kiểm với `funding.fee_payer`, khác MÃ: mã đi theo TRƯỜNG bị sai (`feePayer.ts` khối đầu tệp).
 */
export const FUNDING_COLLATERAL_CODES: FeePayerCodes = {
  field: "funding.collateral", shape: "FUNDING_SHAPE", invalid: "FUNDING_COLLATERAL_INVALID",
};

export interface FundingRequest {
  type: "did_payment";
  didPaymentScriptCbor: string;
  address: string;
  /**
   * `"fee_payer"` (mặc định, hành vi cũ): ví trả phí bên thứ ba trả phí + thế chấp + làm seed.
   * `"did_payment"` (opt-in): ví Phoenix trả phí, seed là UTxO did_payment của nó, ví khoá của
   * người dùng (`collateral`) CHỈ làm thế chấp. Không địa chỉ bên trả phí nào ở vai nào.
   */
  feeSource: "fee_payer" | "did_payment";
  /** Có ⟺ `feeSource = "fee_payer"`. */
  feePayer?: FeePayerRequest;
  /** Có ⟺ `feeSource = "did_payment"`: UTxO thuần ADA dành riêng làm thế chấp + địa chỉ khoá. */
  collateral?: FeePayerRequest;
  /** Tuỳ chọn khi có `owner_witness` (dùng chung); BẮT BUỘC khi không có. */
  anchorRef?: OutRefLike;
  controllerPkh?: string;
  deviceKeyHash?: string;
}

// ── đọc thân bài ─────────────────────────────────────────────────────────────

/** `funding` tuỳ chọn. Có mặt thì đúng hình dạng, không trường lạ; sai ⟹ 400 `FUNDING_SHAPE`. */
export function parseFunding(body: Record<string, unknown>): FundingRequest | undefined {
  const f = body.funding;
  if (f === undefined) return undefined;
  const bad = (field: string, want: string) =>
    new CodedApiError(400, "FUNDING_SHAPE", `"funding${field}" phải là ${want}.`, { field: `funding${field}` });
  if (f === null || typeof f !== "object" || Array.isArray(f)) throw bad("", "một đối tượng JSON");
  const o = f as Record<string, unknown>;
  const allowed = [
    "type", "did_payment_script_cbor", "address", "fee_payer", "fee_source", "collateral",
    "anchor_ref", "controller_pkh", "device_key_hash",
  ];
  const extra = Object.keys(o).filter(k => !allowed.includes(k));
  if (extra.length > 0) {
    throw new CodedApiError(400, "FUNDING_SHAPE", `"funding" có trường lạ: ${extra.join(", ")}.`, { extra_fields: extra });
  }
  if (o.type !== "did_payment") throw bad(".type", `"did_payment"`);
  if (typeof o.did_payment_script_cbor !== "string" || !CBOR_HEX.test(o.did_payment_script_cbor)) {
    throw bad(".did_payment_script_cbor", "hex thường, số ký tự chẵn, khác rỗng");
  }
  if (typeof o.address !== "string" || o.address === "") throw bad(".address", "chuỗi địa chỉ bech32 khác rỗng");
  // `fee_source` vắng ⟹ "fee_payer" (hành vi cũ). Hai chế độ loại trừ nhau về TRƯỜNG: mỗi chế
  // độ đòi đúng một trong `fee_payer` / `collateral` và cấm cái kia — một trường không có vai
  // là dấu người gọi đang tưởng mình ở chế độ khác, đoán thay họ là thối/đặt thế chấp nhầm ví.
  const feeSource = o.fee_source ?? "fee_payer";
  if (feeSource !== "fee_payer" && feeSource !== "did_payment") throw bad(".fee_source", `"fee_payer" hoặc "did_payment"`);
  const wrongField = feeSource === "did_payment" ? "fee_payer" : "collateral";
  if (o[wrongField] !== undefined) {
    throw new CodedApiError(400, "FUNDING_SHAPE",
      `"funding.${wrongField}" không dùng được khi "funding.fee_source" = "${feeSource}".`, { field: `funding.${wrongField}` });
  }
  // Cùng hàm đọc với `fee_payer` ở gốc thân bài (`feePayer.ts`); chỉ khác tên trường + mã lỗi.
  const feePayer = feeSource === "fee_payer" ? parseFeePayerShape(o.fee_payer, FUNDING_FEE_PAYER_CODES) : undefined;
  const collateral = feeSource === "did_payment" ? parseFeePayerShape(o.collateral, FUNDING_COLLATERAL_CODES) : undefined;
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
    feeSource,
    ...(feePayer === undefined ? {} : { feePayer }),
    ...(collateral === undefined ? {} : { collateral }),
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
  // Ví khoá của chế độ nào cũng phải là địa chỉ KHOÁ đúng mạng: thế chấp không được là UTxO script.
  if (f.feeSource === "did_payment") assertFeePayerAddress(network, f.collateral!, FUNDING_COLLATERAL_CODES);
  else assertFeePayerAddress(network, f.feePayer!, FUNDING_FEE_PAYER_CODES);
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
  /** UTxO anchor DID; không mang NFT anchor (tên 32 byte, số lượng 1) dưới `anchor_nft_policy` ⟹ 400 `FUNDING_ANCHOR_INVALID`. */
  read(ref: OutRefLike): Promise<UTxO>;
}

export class ChainDidPaymentAnchorReader implements DidPaymentAnchorReader {
  constructor(private readonly deps: { chain: ChainReader; anchorNftPolicy: string }) {}
  async read(ref: OutRefLike): Promise<UTxO> {
    const [u] = await this.deps.chain.utxosByOutRef([ref]);
    // Cùng phép nhận diện với `did_stake` (`owner.ts` ▸ `carriesAnchorNft`): shard/cursor
    // của `taad` nằm dưới cùng policy nhưng không phải anchor.
    if (!carriesAnchorNft((u as UTxO).assets, this.deps.anchorNftPolicy)) {
      throw new CodedApiError(400, "FUNDING_ANCHOR_INVALID",
        `UTxO anchor ${refStr(ref).slice(0, 12)}… không mang NFT anchor nào (tên 32 byte, số lượng 1) dưới anchor_nft_policy của mạng này.`,
        { anchor_ref: refStr(ref) });
    }
    return u as UTxO;
  }
}

/** UTxO trả phí của `funding`: phải ở ĐÚNG `funding.fee_payer.address` và thuần ADA
 *  (`feePayer.ts` ▸ `readFeePayerUtxo`, mã `FUNDING_FEE_PAYER_INVALID`). */
export function readFeePayerUtxo(chain: ChainReader, f: FundingRequest): Promise<UTxO> {
  if (f.feePayer === undefined) throw new Error("[bất biến nội bộ] readFeePayerUtxo gọi ở chế độ không có fee_payer.");
  return readFeePayerUtxoShared(chain, f.feePayer, FUNDING_FEE_PAYER_CODES);
}

/** UTxO thế chấp của chế độ `fee_source: "did_payment"`: ở ĐÚNG `funding.collateral.address`,
 *  thuần ADA, không script tham chiếu (cùng vị từ với UTxO trả phí), mã `FUNDING_COLLATERAL_INVALID`. */
export function readCollateralUtxo(chain: ChainReader, f: FundingRequest): Promise<UTxO> {
  if (f.collateral === undefined) throw new Error("[bất biến nội bộ] readCollateralUtxo gọi ở chế độ không có collateral.");
  return readFeePayerUtxoShared(chain, f.collateral, FUNDING_COLLATERAL_CODES);
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
  /** Trần `Σ collateral_inputs − collateral_return` (`deployment.feePayerCollateralLovelace`). */
  maxCollateralLovelace: bigint;
  /** Trần khoản ứng min-ADA output vault (`deployment.feePayerFrontingMaxLovelace`). */
  frontingMaxLovelace: bigint;
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
  /** Chế độ `fee_source: "fee_payer"` (mặc định). Vắng ⟺ có `self_funded`. */
  fee_payer?: {
    address: string;
    utxo: string;
    input_lovelace: string;
    fee_lovelace: string;
    change_lovelace: string;
    /** Min-ADA ví trả phí ỨNG cho output vault mới = trọn lovelace output đó (khối đầu tệp). */
    fronted_lovelace: string;
    /** Trần khoản ứng đang có hiệu lực (`fee_payer_fronting_max_lovelace`). */
    fronted_max_lovelace: string;
    /** `Σ collateral_inputs − collateral_return` — thứ bên trả phí có thể mất nếu script hỏng. */
    collateral_at_risk_lovelace: string;
    collateral_return_lovelace: string | null;
  };
  /** Chế độ `fee_source: "did_payment"`: phí trả từ ví Phoenix, seed là UTxO did_payment, ví khoá
   *  chỉ làm thế chấp. Mọi số đọc TỪ CBOR. */
  self_funded?: {
    fee_source: "did_payment";
    /** UTxO did_payment mà tên NFT két băm từ đó — một trong `did_payment_inputs`. */
    seed_utxo: string;
    fee_lovelace: string;
    collateral: {
      address: string;
      utxo: string;
      /** `Σ collateral_inputs − collateral_return`. */
      collateral_at_risk_lovelace: string;
      collateral_return_lovelace: string | null;
    };
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

/** Redeemer Spend: đúng một cho mỗi input did_payment (chỉ số theo thứ tự ĐÃ SẮP của ledger),
 *  data = `Constr 0 []`; không redeemer Spend nào cho input khác. Dùng chung cho hai chế độ. */
function checkSpendRedeemers(tx: CML.Transaction, inputs: string[], spentKeys: string[]): void {
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
}

/** Mục rút trong thân (mục rút `did_stake` của chủ script) — tiền của chủ DID vào giao dịch. */
function withdrawalOf(body: CML.TransactionBody): bigint {
  let withdrawal = 0n;
  const wd = body.withdrawals();
  if (wd !== undefined) {
    const ks = wd.keys();
    for (let i = 0; i < ks.len(); i++) withdrawal += wd.get(ks.get(i)) ?? 0n;
  }
  return withdrawal;
}

export interface SelfFundedCheckContext {
  network: Network;
  tipPosixMs: bigint;
  vaultAddress: string;
  vaultNftUnit: string;
  lampUnit: string;
  fundingAddress: string;
  collateralAddress: string;
  collateralUtxo: UTxO;
  /** Mọi UTxO dịch vụ đọc được ở `fundingAddress` lúc dựng. */
  didPaymentUtxos: UTxO[];
  signers: [controllerPkh: string, deviceKeyHash: string];
  /** Trần `Σ collateral_inputs − collateral_return` (cùng cấu hình với ví trả phí). */
  maxCollateralLovelace: bigint;
}

/**
 * Đọc lại CBOR của chế độ `fee_source: "did_payment"` (ví Phoenix tự trả phí). Lệch ⟹ 422
 * `FUNDING_TX_MISMATCH` ở vế đầu tiên lệch. Không tin bộ dựng ở vế nào:
 *   (1) input: CHỈ UTxO did_payment đã biết, ≥ 1 — nên KHÔNG input nào của ví thế chấp;
 *   (2) seed: NFT két đúc trong CBOR có tên = blake2b_256(cbor(seed)) của ĐÚNG MỘT input did_payment;
 *   (3) redeemer Spend mỗi input did_payment;
 *   (4) thế chấp: chỉ UTxO khai, có mặt, `collateral_return` về ví thế chấp, lượng có thể mất ≤ trần;
 *   (5) output: chỉ vault + ví Phoenix — không output nào về ví thế chấp hay địa chỉ lạ;
 *   (6) bảo toàn: did_payment chi (+ mục rút) = vault (trừ NFT) + thối + PHÍ; token không vào phí;
 *   (7) bộ ký did_payment + hạn dùng.
 */
export function checkSelfFundedTx(txCbor: string, ctx: SelfFundedCheckContext): FundingSummary {
  const tx = CML.Transaction.from_cbor_hex(txCbor);
  const body = tx.body();
  const key = (h: string, i: number | bigint) => `${h}#${Number(i)}`;
  const collKey = key(ctx.collateralUtxo.txHash, ctx.collateralUtxo.outputIndex);
  const dp = new Map(ctx.didPaymentUtxos.map(u => [key(u.txHash, u.outputIndex), u]));

  // (1)
  const inputs: string[] = [];
  const il = body.inputs();
  for (let i = 0; i < il.len(); i++) inputs.push(key(il.get(i).transaction_id().to_hex(), il.get(i).index()));
  const foreign = inputs.filter(k => !dp.has(k));
  if (foreign.length > 0) {
    throw mismatch(`input ngoài ví Phoenix ${foreign.join(", ")} — ở chế độ fee_source did_payment chỉ UTxO did_payment được chi`,
      { foreign_inputs: foreign });
  }
  if (inputs.length === 0) throw mismatch(`không có UTxO did_payment nào trong input`);

  // (2) tên NFT két phải băm từ một input did_payment. Validator chỉ đòi seed ∈ inputs; ở chế độ
  //     này (1) đã chứng minh inputs ⊆ did_payment, nên đây là phép đọc NGƯỢC: seed nào sinh ra
  //     tên này, để khai ra trong bản tóm tắt và để một NFT băm từ UTxO ngoài tập bị bắt.
  const mint = body.mint();
  const minted = mint === undefined ? {} : valueToAssets(CML.Value.new(0n, mint.as_positive_multiasset()));
  if (minted[ctx.vaultNftUnit] !== 1n) throw mismatch(`giao dịch không đúc đúng 1 NFT két ${ctx.vaultNftUnit.slice(0, 16)}…`);
  const nftName = ctx.vaultNftUnit.slice(56);
  const seeds = inputs.filter(k => {
    const [h, i] = k.split("#");
    return vaultIdAssetName({ txHash: h!, outputIndex: Number(i) }) === nftName;
  });
  if (seeds.length !== 1) {
    throw mismatch(`tên NFT két không băm từ input did_payment nào — seed phải là một UTxO did_payment bị chi`,
      { vault_nft: ctx.vaultNftUnit });
  }

  // (3)
  checkSpendRedeemers(tx, inputs, inputs);

  // (4)
  const cl = body.collateral_inputs();
  if (cl === undefined || cl.len() === 0) throw mismatch(`giao dịch chạy script mà không có tài sản thế chấp`);
  const { atRisk, collateralReturn } = checkCollateral(
    body, collKey, ctx.collateralUtxo, ctx.collateralAddress, ctx.maxCollateralLovelace, mismatch);

  // (5)
  const allowed = new Set([ctx.vaultAddress, ctx.fundingAddress]);
  const ol = body.outputs();
  const vaultOut: Record<string, bigint> = {};
  const fundOut: Record<string, bigint> = {};
  for (let i = 0; i < ol.len(); i++) {
    const o = ol.get(i);
    const addr = o.address().to_bech32(undefined);
    if (!allowed.has(addr)) {
      throw mismatch(`output #${i} đi tới ${addr === ctx.collateralAddress ? "ví thế chấp" : `địa chỉ lạ ${addr}`}`, { output_index: i });
    }
    sum(addr === ctx.vaultAddress ? vaultOut : fundOut, valueToAssets(o.amount()));
  }

  // (6)
  const fee = body.fee();
  const withdrawal = withdrawalOf(body);
  const spent: Record<string, bigint> = {};
  for (const k of inputs) sum(spent, dp.get(k)!.assets);
  const vaultNoNft = { ...vaultOut, [ctx.vaultNftUnit]: (vaultOut[ctx.vaultNftUnit] ?? 0n) - 1n };
  const units = new Set([...Object.keys(spent), ...Object.keys(vaultNoNft), ...Object.keys(fundOut), "lovelace"]);
  for (const u of units) {
    const left = (spent[u] ?? 0n) + (u === "lovelace" ? withdrawal : 0n);
    const right = (vaultNoNft[u] ?? 0n) + (fundOut[u] ?? 0n) + (u === "lovelace" ? fee : 0n);
    if (left !== right) {
      throw mismatch(`bảo toàn ${u === "lovelace" ? "lovelace" : u.slice(0, 16) + "…"}: did_payment chi ${left}, vault + thối${u === "lovelace" ? " + phí" : ""} nhận ${right}`, { unit: u });
    }
  }

  // (7)
  const rs = body.required_signers();
  const signers: string[] = [];
  for (let i = 0; rs !== undefined && i < rs.len(); i++) signers.push(rs.get(i).to_hex());
  for (const s of ctx.signers) {
    if (!signers.includes(s)) throw mismatch(`required_signers thiếu ${s} (did_payment đòi controller + thiết bị)`);
  }
  const validTo = checkValidTo(body, ctx.network, ctx.tipPosixMs, mismatch);

  return {
    type: "did_payment",
    address: ctx.fundingAddress,
    did_payment_inputs: inputs,
    spent: view(spent, ctx.lampUnit),
    returned: view(fundOut, ctx.lampUnit),
    withdrawal_lovelace: raw(withdrawal),
    self_funded: {
      fee_source: "did_payment",
      seed_utxo: seeds[0]!,
      fee_lovelace: raw(fee),
      collateral: {
        address: ctx.collateralAddress,
        utxo: collKey,
        collateral_at_risk_lovelace: raw(atRisk),
        collateral_return_lovelace: collateralReturn === null ? null : raw(collateralReturn),
      },
    },
    valid_to_posix_ms: raw(validTo),
  };
}

export function checkFundingTx(txCbor: string, ctx: FundingCheckContext): FundingSummary {
  const tx = CML.Transaction.from_cbor_hex(txCbor);
  const body = tx.body();
  const key = (h: string, i: number | bigint) => `${h}#${Number(i)}`;
  const feeKey = key(ctx.feePayerUtxo.txHash, ctx.feePayerUtxo.outputIndex);
  const dp = new Map(ctx.didPaymentUtxos.map(u => [key(u.txHash, u.outputIndex), u]));

  // (1) input: đúng một UTxO trả phí + các UTxO did_payment đã biết; không gì khác. KHÔNG đòi
  //     ≥1 UTxO did_payment: két instant 0 LAMP không mục rút thì did_payment không góp gì (khối
  //     đầu tệp). Két mang LAMP mà không chi did_payment thì vế bảo toàn (5) từ chối.
  const inputs: string[] = [];
  const il = body.inputs();
  for (let i = 0; i < il.len(); i++) inputs.push(key(il.get(i).transaction_id().to_hex(), il.get(i).index()));
  const foreign = inputs.filter(k => k !== feeKey && !dp.has(k));
  if (foreign.length > 0) throw mismatch(`input lạ ${foreign.join(", ")}`, { foreign_inputs: foreign });
  const spentKeys = inputs.filter(k => dp.has(k));
  if (!inputs.includes(feeKey)) throw mismatch(`thiếu UTxO trả phí ${feeKey} trong input`);

  // (2) redeemer Spend: đúng một cho mỗi input did_payment, data = Constr 0 [].
  checkSpendRedeemers(tx, inputs, spentKeys);

  // (3) thế chấp: chỉ UTxO trả phí; collateral_return về đúng ví trả phí; lượng có thể mất
  //     ≤ trần cấu hình. Hàm DÙNG CHUNG với đường `fee_payer` (`feePayer.ts`).
  const { atRisk, collateralReturn } = checkCollateral(
    body, feeKey, ctx.feePayerUtxo, ctx.feePayerAddress, ctx.maxCollateralLovelace, mismatch);

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

  // (5) bảo toàn: ví trả phí trả ĐÚNG phí + khoản ứng = trọn lovelace output vault (vault MỚI, NFT
  //     đúc trong tx ⟹ gốc 0); did_payment (+ mục rút) = vault (trừ NFT vừa đúc, TRỪ lovelace) +
  //     phần thối. Hai phương trình cùng đóng: lovelace của vault chỉ đến từ ví trả phí, lovelace
  //     của did_payment về lại trọn did_payment.
  const fee = body.fee();
  const feeIn = ctx.feePayerUtxo.assets.lovelace ?? 0n;
  const feeChange = feeOut.lovelace ?? 0n;
  const fronted = vaultOut.lovelace ?? 0n;
  if (fronted > ctx.frontingMaxLovelace) {
    throw new CodedApiError(422, "FEE_PAYER_FRONTING_ABOVE_MAX",
      `Ví trả phí phải ứng ${fronted} lovelace min-ADA cho output vault, vượt trần ${ctx.frontingMaxLovelace} ` +
      `(fee_payer_fronting_max_lovelace). Bên trả phí chỉ ứng tới trần đó.`,
      { fronted_lovelace: raw(fronted), fronted_max_lovelace: raw(ctx.frontingMaxLovelace) });
  }
  if (feeIn !== fee + feeChange + fronted) {
    throw mismatch(`ví trả phí góp ${feeIn} lovelace nhưng phí ${fee} + thối ${feeChange} + ứng min-ADA vault ${fronted} — ` +
      `nó đang trả cho thứ khác ngoài phí và khoản ứng`);
  }
  let withdrawal = 0n;
  const wd = body.withdrawals();
  if (wd !== undefined) {
    const ks = wd.keys();
    for (let i = 0; i < ks.len(); i++) withdrawal += wd.get(ks.get(i)) ?? 0n;
  }
  const spent: Record<string, bigint> = {};
  for (const k of spentKeys) sum(spent, dp.get(k)!.assets);
  // Lovelace của vault đã tính vào khoản ứng của ví trả phí ở trên ⟹ không thuộc vế did_payment.
  const vaultNoNft = { ...vaultOut, lovelace: 0n, [ctx.vaultNftUnit]: (vaultOut[ctx.vaultNftUnit] ?? 0n) - 1n };
  const units = new Set([...Object.keys(spent), ...Object.keys(vaultNoNft), ...Object.keys(fundOut), "lovelace"]);
  for (const u of units) {
    const left = (spent[u] ?? 0n) + (u === "lovelace" ? withdrawal : 0n);
    const right = (vaultNoNft[u] ?? 0n) + (fundOut[u] ?? 0n);
    if (left !== right) {
      throw mismatch(`bảo toàn ${u === "lovelace" ? "lovelace" : u.slice(0, 16) + "…"}: did_payment chi ${left}, ${u === "lovelace" ? "thối" : "vault + thối"} nhận ${right}`, { unit: u });
    }
  }

  // (6) bộ ký did_payment (chỉ khi CÓ chi did_payment — script đó mới đòi) + hạn dùng ≤ 1 giờ.
  const rs = body.required_signers();
  const signers: string[] = [];
  for (let i = 0; rs !== undefined && i < rs.len(); i++) signers.push(rs.get(i).to_hex());
  for (const s of spentKeys.length > 0 ? ctx.signers : []) {
    if (!signers.includes(s)) throw mismatch(`required_signers thiếu ${s} (did_payment đòi controller + thiết bị)`);
  }
  const validTo = checkValidTo(body, ctx.network, ctx.tipPosixMs, mismatch);

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
      fronted_lovelace: raw(fronted),
      fronted_max_lovelace: raw(ctx.frontingMaxLovelace),
      collateral_at_risk_lovelace: raw(atRisk),
      collateral_return_lovelace: collateralReturn === null ? null : raw(collateralReturn),
    },
    valid_to_posix_ms: raw(validTo),
  };
}
