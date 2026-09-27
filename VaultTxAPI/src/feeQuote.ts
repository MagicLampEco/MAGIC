// VaultTxAPI/src/feeQuote.ts — `POST /tx/quote`: báo giá phí cho HAI nguồn trả phí, TRƯỚC khi dựng.
//
//   { route, params, [owner_fee_addresses] }
//   → { feecover:      { fee_lovelace, available, [reason], [rule], [message], [upstream_status] },
//       owner_address: { fee_lovelace, available, needed_lovelace, collateral_lovelace,
//                        [fee_payer: { utxo, address }], [reason] },
//       valid_until }
//
// ── HAI NGUỒN, HAI GIAO DỊCH CHỈ KHÁC ĐÚNG MỘT INPUT ──────────────────────────────
// Cả hai nguồn đi qua ĐÚNG đường dựng của `route` (`buildRequest.ts` ▸ `runBuild`, chế độ
// `QuoteMode` của `service.ts`), với `params` + một `fee_payer` do báo giá chèn vào. Phí đọc lại
// TỪ CBOR như `summary` (`feePayer.ts` ▸ `checkFeePayerTx`, hoặc `checkFundingTx` với
// create-vault) — không có công thức phí thứ hai nào ở tệp này.
//
//   · Feecover: địa chỉ ví Feecover chưa biết trước, và báo giá KHÔNG gọi `/v1/utxo` (gọi là
//     giữ chỗ một UTxO của kho Feecover cho một lần hỏi giá). Nên dựng trên MỘT UTxO TỔNG HỢP,
//     không đọc chuỗi cho nó. Lucid đánh giá script CỤC BỘ từ UTxO nó được đưa (xem
//     `SYNTH_*` bên dưới cho bằng chứng thực thi), nên UTxO không có trên chuỗi vẫn dựng được.
//     `available` thì HỎI Feecover (`GET /v1/fee-sources`, không giữ chỗ — `FeeProxy.feeSources`)
//     và chuyển nguyên câu trả lời; không hỏi được ⟹ `false` kèm lý do có tên, không bao giờ
//     `true` khi chưa hỏi (`feecoverSource`).
//   · Chủ: đọc UTxO ở MỌI địa chỉ trong `owner_fee_addresses` (CHỈ ĐỌC), chọn một UTxO theo
//     quy tắc ở `orderOwnerFeeCandidates`, dựng với nó làm `fee_payer` và trả lại nó ở
//     `owner_address.fee_payer` — cùng hình dạng thân `fee_payer` của đường dựng, để app chép
//     thẳng. Chủ dùng ví khoá của chính mình làm `fee_payer` thì app tự ký phần đó, không qua
//     `/fee/sign`.
//
// ── BA THỨ BÁO GIÁ KHÔNG LÀM ─────────────────────────────────────────────────────
// Không giữ khoá mềm của chủ, không ghi sổ phát-hành (`IssuedTxRegistry`), không xin Feecover
// UTxO hay chữ ký (`/v1/utxo`, `/v1/sign`) — lượt gọi Feecover duy nhất là câu hỏi
// `/v1/fee-sources`, vốn không giữ chỗ. Tx dựng ra ở đây không đi ra ngoài: một báo giá không nộp
// được, không xin ký được.
//
// ── MÃ LỖI ────────────────────────────────────────────────────────────────────────
// Lỗi của thân báo giá: `FEE_QUOTE_*` (400). Lỗi của `params`: ĐÚNG mã đường dựng trả —
// `params` đi qua cùng hàm đọc và cùng đường dựng, không bị bọc lại.

import { CML, credentialToAddress, getAddressDetails, type UTxO } from "@lucid-evolution/lucid";

import { parseBuildRequest, runBuild, type BuildResult } from "./buildRequest.js";
import { CodedApiError } from "./errors.js";
import type { FeeProxy, FeeSourcesFailure } from "./feeProxy.js";
import { assertFeePayerAddress, isPureAdaFeeUtxo, refStr, type FeePayerCodes } from "./feePayer.js";
import { ISSUED_ROUTES, type IssuedRoute } from "./locks.js";
import type { VaultTxService } from "./service.js";
import { raw } from "./units.js";

export interface FeeQuoteDeps {
  service: VaultTxService;
  /** Proxy Feecover. Vắng ⟹ bản deploy không khai `feecover` ⟹ nguồn Feecover không có. */
  feeProxy?: FeeProxy;
}

export type FeeQuoteReason =
  | "FEE_QUOTE_FEECOVER_UNCONFIGURED"
  | "FEE_QUOTE_FEECOVER_NO_DEFAULT_APP"
  | "FEE_QUOTE_FEECOVER_PURPOSE_UNMAPPED"
  | "FEE_QUOTE_FEECOVER_PURPOSE_FOREIGN"
  | "FEE_QUOTE_FEECOVER_TOKEN_ABSENT"
  | "FEE_QUOTE_FEECOVER_TIMEOUT"
  | "FEE_QUOTE_FEECOVER_UNREACHABLE"
  | "FEE_QUOTE_FEECOVER_HTTP_STATUS"
  | "FEE_QUOTE_FEECOVER_BAD_RESPONSE"
  | "FEE_QUOTE_FEECOVER_DECLINED"
  | "FEE_QUOTE_OWNER_ADDRESSES_ABSENT"
  | "FEE_QUOTE_OWNER_NO_ADA_UTXO"
  | "FEE_QUOTE_OWNER_INSUFFICIENT";

export interface FeeQuoteResponse {
  feecover: {
    fee_lovelace: string;
    /** `true` CHỈ khi Feecover trả lời `/v1/fee-sources` với `available: true`. */
    available: boolean;
    /** Có đúng khi `available = false`. */
    reason?: FeeQuoteReason;
    /** Nguyên văn `rule` / `message` của Feecover (câu trả lời 200, hoặc lời từ chối 4xx). */
    rule?: string;
    message?: string;
    /** Chỉ với `FEE_QUOTE_FEECOVER_HTTP_STATUS`: mã Feecover trả. */
    upstream_status?: number;
  };
  owner_address: {
    fee_lovelace: string;
    available: boolean;
    needed_lovelace: string;
    /** Thế chấp tường minh bản deploy đặt (`deployment.feePayerCollateralLovelace`): khoản UTxO
     *  trả phí mất nếu script chết ở pha 2. Luôn có, kể cả khi `available = false`. */
    collateral_lovelace: string;
    /** CHỈ khi `available = true`: UTxO đã chọn, đúng hình dạng thân `fee_payer` của đường dựng. */
    fee_payer?: { utxo: string; address: string };
    reason?: FeeQuoteReason;
  };
  valid_until: string;
}

/** Trần số địa chỉ ví chủ một lần hỏi. Nguồn: hợp đồng `/tx/quote` bên gọi chốt 2026-09-27.
 *  Mỗi địa chỉ tốn một lượt đọc chuỗi + một lượt dựng tổng hợp, nên trần này là trần công. */
export const MAX_OWNER_FEE_ADDRESSES = 10;

// ── UTxO TỔNG HỢP ─────────────────────────────────────────────────────────────────
//
// Mọi trường chọn theo hướng KHÔNG đánh giá thấp phí: phí Cardano = a·byte + b + phí script,
// và mỗi trường dưới đây là một trục độ dài mã hoá. Số đo (lucid 0.4.30, `complete` với
// `setCollateral` 3 ADA, một input script PlutusV3 luôn-đúng, nhà cung cấp NÉM ở mọi lượt gọi
// ⟹ đếm được 0 lượt gọi; tham số giao thức `PROTOCOL_PARAMETERS_DEFAULT` của lucid):
//
//   ví trả phí                                  phí (lovelace)
//   enterprise · 10 ADA · chỉ số 0                  181 369
//   base       · 10 ADA · chỉ số 0                  183 833   (+2 464 = 56 byte × 44: địa chỉ thối
//                                                              + địa chỉ collateral_return)
//   enterprise · 10 000 ADA · chỉ số 0              181 721   (+352 = 8 byte × 44: hai lượng ≥ 2³²)
//   base       · 10 000 ADA · chỉ số 0              184 185
//   base       · 10 000 ADA · chỉ số 99 999        184 537   (+352: chỉ số ở input + input thế chấp)
//   enterprise · 10 ADA · khoá ví = khoá chủ         176 925   (−4 444: bớt một chữ ký)
//
// ⟹ UTxO tổng hợp lấy loại địa chỉ DÀI hơn (base), lượng + chỉ số có mã hoá RỘNG nhất, và
// khoá KHÁC khoá chủ (ví Feecover thật là một khoá khác). Trên một ví enterprise chỉ số nhỏ,
// báo giá Feecover cao hơn phí thật tối đa 3 168 lovelace (184 537 − 181 369), không bao giờ thấp hơn
// theo ba trục này. Trục CHƯA ghim: địa chỉ con trỏ (pointer) — `assertFeePayerAddress` nhận
// nó, và nó có thể dài hơn base.
//
// Đo lại: dựng một always-succeeds PlutusV3 (`validator always { else(_) { True } }`, aiken
// v1.1.21) rồi gọi `Lucid(<nhà cung cấp ném>, "Preview", { presetProtocolParameters:
// PROTOCOL_PARAMETERS_DEFAULT })` · `selectWallet.fromAddress(addr, [utxo tổng hợp])` ·
// `collectFrom` + `pay.ToAddressWithData` + `addSignerKey` + `validTo` ·
// `complete({ setCollateral: 3_000_000n })`, đọc `body().fee()` — đổi từng trục một.

/** Khoá thanh toán của ví tổng hợp: không phải khoá của ai, chỉ cần KHÁC khoá chủ. */
const SYNTH_PAYMENT_KEY_HASH = "fc".repeat(28);
/** Khoá stake: làm địa chỉ tổng hợp thành base (57 byte) thay vì enterprise (29 byte). */
const SYNTH_STAKE_KEY_HASH = "fd".repeat(28);
const SYNTH_TX_HASH = "fc".repeat(32);
/** Chỉ số output lớn nhất `fee_payer.utxo` nhận (`feePayer.ts` ▸ `OUTREF`: ≤ 5 chữ số). */
const SYNTH_OUTPUT_INDEX = 99_999;
/** Tổng cung ADA tối đa, 45×10⁹ ADA: ≥ 2³² nên lượng + tiền thối + collateral_return đều mã
 *  hoá 9 byte (rộng nhất), và không UTxO thật nào lớn hơn. */
const SYNTH_LOVELACE = 45_000_000_000_000_000n;

function synthUtxo(address: string): UTxO {
  return { txHash: SYNTH_TX_HASH, outputIndex: SYNTH_OUTPUT_INDEX, address, assets: { lovelace: SYNTH_LOVELACE } };
}

/** Địa chỉ base cùng mạng, cùng khoá thanh toán với `address`. */
function baseShapeOf(address: string, network: VaultTxService["network"]): string {
  const d = getAddressDetails(address);
  if (d.paymentCredential?.type !== "Key") {
    throw new Error("[bất biến nội bộ] địa chỉ ví trả phí không có phần thanh toán là khoá — đã phải bị chặn trước đó.");
  }
  return credentialToAddress(network, d.paymentCredential, { type: "Key", hash: SYNTH_STAKE_KEY_HASH });
}

// ── LƯỢNG TỐI THIỂU CỦA UTxO TRẢ PHÍ ────────────────────────────────────────────────
//
// `needed = max(phí, thế_chấp) + min_ADA`, suy từ `complete` của lucid 0.4.30 — hai phép chọn
// độc lập trên CÙNG một UTxO:
//   · chọn input trả phí (`doCoinSelection` → `recursive`): cần phí + phần thối ≥ min-ADA;
//     ví trả phí góp ĐÚNG bằng phí (`checkFeePayerTx` vế 4 ép), nên vế này là `phí + min_ADA`;
//   · chọn thế chấp (`findCollateral` → `recursive`, lượng `max(collateralPercentage × phí,
//     setCollateral)` với `setCollateral` = `collateralCompleteOptions(fee_payer_collateral_lovelace)`):
//     cần thế chấp + collateral_return ≥ min-ADA. Lượng thế chấp đọc lại TỪ CBOR
//     (`collateral_at_risk_lovelace` = Σ collateral_inputs − collateral_return), không tính lại.
// min-ADA mà lucid kiểm ở cả hai chỗ (`calculateMinLovelace`) dùng một địa chỉ base GIẢ, không
// dùng địa chỉ thật ⟹ lấy `max(min_ADA(địa chỉ thật), min_ADA(base))`: base cho vế lucid, địa
// chỉ thật cho vế ledger.
//
// Không phải `phí + thế_chấp + min_ADA`: thế chấp chỉ bị THU khi script hỏng, và khi đó không
// có phí thường nào bị thu — hai khoản không cộng dồn trên UTxO. Đo (cùng dựng thử trên):
// UTxO = needed ⟹ dựng được; needed − 1 ⟹ lucid từ chối ("not enough funds to cover required
// minimum ADA for change output"). Bản cộng dồn cao hơn needed đúng bằng min(phí, thế chấp).

/** min-ADA của một output thuần ADA — cùng phép tính với `calculateMinLovelace` của lucid. */
function pureAdaMinCoin(address: string, coinsPerUtxoByte: bigint): bigint {
  return CML.TransactionOutputBuilder.new()
    .with_address(CML.Address.from_bech32(address))
    .next()
    .with_asset_and_min_required_coin(CML.MultiAsset.new(), coinsPerUtxoByte)
    .build()
    .output()
    .amount()
    .coin();
}

interface Measured {
  fee: bigint;
  needed: bigint;
  /** min(hạn dùng của tx trong CBOR, `expires_at` đường dựng trả). */
  horizonMs: number;
}

/** Mã lỗi địa chỉ thứ `i` của `owner_fee_addresses` — cùng phép kiểm `assertFeePayerAddress`
 *  của đường dựng, tên trường chỉ đúng phần tử hỏng. */
function ownerFeeAddressCodes(i: number): FeePayerCodes {
  const field = `owner_fee_addresses[${i}]`;
  return { field, addressField: field, shape: "FEE_QUOTE_SHAPE", invalid: "FEE_QUOTE_OWNER_ADDRESS_INVALID" };
}

/** Lối không hỏi được Feecover → lý do trong báo giá. `Record` trên cả kiểu hợp ⟹ thêm một lối
 *  hỏng ở `feeProxy.ts` mà quên ánh xạ ở đây là lỗi biên dịch, không phải một `undefined` im lặng. */
const FEECOVER_REASON_OF_FAILURE: Readonly<Record<FeeSourcesFailure, FeeQuoteReason>> = {
  no_default_app: "FEE_QUOTE_FEECOVER_NO_DEFAULT_APP",
  token_absent: "FEE_QUOTE_FEECOVER_TOKEN_ABSENT",
  purpose_unmapped: "FEE_QUOTE_FEECOVER_PURPOSE_UNMAPPED",
  purpose_foreign: "FEE_QUOTE_FEECOVER_PURPOSE_FOREIGN",
  timeout: "FEE_QUOTE_FEECOVER_TIMEOUT",
  unreachable: "FEE_QUOTE_FEECOVER_UNREACHABLE",
  http_status: "FEE_QUOTE_FEECOVER_HTTP_STATUS",
  bad_response: "FEE_QUOTE_FEECOVER_BAD_RESPONSE",
};

export async function quoteFee(body: Record<string, unknown>, deps: FeeQuoteDeps): Promise<FeeQuoteResponse> {
  const { route, params, ownerFeeAddresses } = parseQuoteBody(body);
  const network = deps.service.network;
  ownerFeeAddresses.forEach((address, i) => assertFeePayerAddress(network,
    { address, utxoRef: { txHash: SYNTH_TX_HASH, outputIndex: 0 } }, ownerFeeAddressCodes(i)));
  // Cấu hình của bản deploy, KHÔNG đọc từ tx: đây là trần bản deploy đặt cho mọi lượt dựng,
  // và nó phải có cả khi không lượt dựng nào với UTxO thật chạy.
  const collateral_lovelace = raw(deps.service.feePayerCollateralLovelace);
  const coinsPerUtxoByte = await deps.service.coinsPerUtxoByte();
  const measure = async (utxo: UTxO): Promise<Measured> =>
    measureOnce(deps.service, route, params, utxo, coinsPerUtxoByte);

  // Lượt ĐẦU chạy trước mọi thứ khác: lỗi của `params` đi ra từ đây, nguyên mã đường dựng.
  const synthAddress = credentialToAddress(network,
    { type: "Key", hash: SYNTH_PAYMENT_KEY_HASH }, { type: "Key", hash: SYNTH_STAKE_KEY_HASH });
  const generic = await measure(synthUtxo(synthAddress));
  const horizons = [generic.horizonMs];

  // Hỏi Feecover SAU lượt dựng đầu: `params` hỏng thì báo giá dừng ở trên, Feecover không bị hỏi.
  const feecover: FeeQuoteResponse["feecover"] = { fee_lovelace: raw(generic.fee), ...await feecoverSource(deps.feeProxy, route) };

  let owner: FeeQuoteResponse["owner_address"] | undefined;
  if (ownerFeeAddresses.length === 0) {
    // Không biết địa chỉ ⟹ số của ví tổng hợp: một ƯỚC LƯỢNG chặn trên (README §`/tx/quote`).
    owner = { fee_lovelace: raw(generic.fee), available: false, needed_lovelace: raw(generic.needed),
      collateral_lovelace, reason: "FEE_QUOTE_OWNER_ADDRESSES_ABSENT" };
  } else {
    // Ngưỡng theo TỪNG địa chỉ, bằng một lượt tổng hợp ở ĐÚNG địa chỉ đó: phí phụ thuộc độ dài
    // địa chỉ và việc khoá ví có trùng khoá chủ không (bảng đo ở trên), nên hai địa chỉ có hai
    // ngưỡng. Dựng thẳng với một UTxO thật quá nhỏ thì lucid ném một lỗi không phân biệt được với
    // lỗi của `params` — lượt tổng hợp cho ngưỡng mà không cần UTxO nào đủ lớn.
    const perAddress: OwnerAddressFacts[] = [];
    for (const address of ownerFeeAddresses) {
      const threshold = await measure(synthUtxo(address));
      horizons.push(threshold.horizonMs);
      const pureAda = (await deps.service.utxosAt(address)).filter(u => u.address === address && isPureAdaFeeUtxo(u));
      perAddress.push({ address, threshold, pureAda });
    }
    for (const c of orderOwnerFeeCandidates(perAddress)) {
      const real = await measure(c.utxo);
      horizons.push(real.horizonMs);
      // Ngưỡng tổng hợp là chặn trên của `real.needed` trên mọi trục đã đo; vế này chỉ đỏ nếu có
      // một trục chưa đo — khi đó UTxO kế tiếp (lớn hơn) được thử, không trả một UTxO không đủ.
      if (lovelaceOf(c.utxo) < real.needed) continue;
      owner = {
        fee_lovelace: raw(real.fee), available: true, needed_lovelace: raw(c.threshold.needed), collateral_lovelace,
        fee_payer: { utxo: refStr(c.utxo), address: c.utxo.address },
      };
      break;
    }
    if (owner === undefined) {
      // Không chọn được ⟹ số là CHẶN TRÊN qua mọi địa chỉ: một UTxO thuần ADA cỡ `needed_lovelace`
      // gửi tới địa chỉ nào trong mảng cũng đủ.
      const fee = perAddress.map(a => a.threshold.fee).reduce(maxBig);
      const needed = perAddress.map(a => a.threshold.needed).reduce(maxBig);
      owner = { fee_lovelace: raw(fee), available: false, needed_lovelace: raw(needed), collateral_lovelace,
        reason: perAddress.some(a => a.pureAda.length > 0) ? "FEE_QUOTE_OWNER_INSUFFICIENT" : "FEE_QUOTE_OWNER_NO_ADA_UTXO" };
    }
  }

  // Hạn báo giá = hạn NGẮN NHẤT trong các lượt dựng vừa chạy: sau hạn dùng (`validTo`) của tx thì
  // tx được mô tả không còn nộp được, và sau `expires_at` đường dựng trả thì app phải dựng lại
  // (thân mới, phí mới) — báo giá không được sống lâu hơn thứ nó mô tả.
  return { feecover, owner_address: owner, valid_until: new Date(Math.min(...horizons)).toISOString() };
}

// ── chọn UTxO cho nguồn chủ ──────────────────────────────────────────────────────

export interface OwnerAddressFacts {
  address: string;
  /** Lượt tổng hợp ở đúng địa chỉ này: `needed` là ngưỡng của địa chỉ. */
  threshold: Measured;
  /** UTxO thuần ADA, không script tham chiếu, ở đúng địa chỉ này (`isPureAdaFeeUtxo`). */
  pureAda: UTxO[];
}

/**
 * QUY TẮC CHỌN UTxO TRẢ PHÍ CỦA CHỦ (hợp đồng `/tx/quote`, chốt 2026-09-27):
 *   1. chỉ UTxO thuần ADA, không script tham chiếu, trên MỌI địa chỉ trong `owner_fee_addresses`
 *      — UTxO mang token bị bỏ qua dù lớn đến đâu (nó còn là tài sản thế chấp);
 *   2. chỉ UTxO có lovelace ≥ ngưỡng `needed` của CHÍNH địa chỉ chứa nó;
 *   3. chọn UTxO lovelace NHỎ NHẤT còn lại — giữ UTxO lớn cho việc khác;
 *   4. hoà lovelace ⟹ địa chỉ đứng trước trong mảng; cùng địa chỉ ⟹ `tx_hash` nhỏ hơn (chuỗi
 *      hex), rồi chỉ số output nhỏ hơn (SỐ, không phải chuỗi: `#9` trước `#10`).
 * Trả về danh sách theo đúng thứ tự đó; phần tử đầu là UTxO được chọn, phần sau chỉ dùng khi
 * lượt dựng thật cho thấy phần tử trước không đủ.
 */
export function orderOwnerFeeCandidates(perAddress: readonly OwnerAddressFacts[]): { utxo: UTxO; addressIndex: number; threshold: Measured }[] {
  return perAddress
    .flatMap((a, addressIndex) => a.pureAda
      .filter(u => lovelaceOf(u) >= a.threshold.needed)
      .map(utxo => ({ utxo, addressIndex, threshold: a.threshold })))
    .sort((x, y) => {
      const d = lovelaceOf(x.utxo) - lovelaceOf(y.utxo);
      if (d !== 0n) return d < 0n ? -1 : 1;
      if (x.addressIndex !== y.addressIndex) return x.addressIndex - y.addressIndex;
      if (x.utxo.txHash !== y.utxo.txHash) return x.utxo.txHash < y.utxo.txHash ? -1 : 1;
      return x.utxo.outputIndex - y.utxo.outputIndex;
    });
}

// ── đọc thân bài ─────────────────────────────────────────────────────────────────

function parseQuoteBody(body: Record<string, unknown>): {
  route: IssuedRoute; params: Record<string, unknown>; ownerFeeAddresses: string[];
} {
  const shape = (message: string, details: Record<string, unknown> = {}) =>
    new CodedApiError(400, "FEE_QUOTE_SHAPE", message, details);
  const extra = Object.keys(body).filter(k => k !== "route" && k !== "params" && k !== "owner_fee_addresses");
  if (extra.length > 0) throw shape(`Thân báo giá có trường lạ: ${extra.join(", ")}.`, { extra_fields: extra });
  const route = body.route;
  if (typeof route !== "string" || !(ISSUED_ROUTES as readonly string[]).includes(route)) {
    throw new CodedApiError(400, "FEE_QUOTE_ROUTE_UNKNOWN",
      `"route" phải là một trong: ${ISSUED_ROUTES.join(" | ")}.`, { route: typeof route === "string" ? route : null });
  }
  const params = body.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw shape(`"params" phải là đối tượng JSON — đúng thân bài của /tx/${route}, không kèm ví trả phí.`);
  }
  const p = params as Record<string, unknown>;
  // Báo giá TỰ chèn ví trả phí cho từng nguồn. Một `fee_payer` trong `params` là câu hỏi khác
  // ("phí với UTxO này là bao nhiêu") mà đường dựng đã trả lời — không lặng lẽ ghi đè nó.
  if (p.fee_payer !== undefined) throw feePayerInParams("params.fee_payer");
  if (route === "create-vault") {
    const f = p.funding;
    if (f === undefined) {
      throw new CodedApiError(400, "FEE_QUOTE_FUNDING_REQUIRED",
        `Báo giá /tx/create-vault cần "params.funding": chỉ đường nạp từ ví Phoenix có ví trả phí ` +
        `("funding.fee_payer"). Đường "change_address" trả phí bằng chính ví đó, không có gì để báo giá.`);
    }
    if (f !== null && typeof f === "object" && !Array.isArray(f) && (f as Record<string, unknown>).fee_payer !== undefined) {
      throw feePayerInParams("params.funding.fee_payer");
    }
    // Chế độ ví Phoenix tự trả phí không có ví trả phí nào để báo giá: phí chi từ chính ví
    // Phoenix. Báo giá chèn `fee_payer` vào — để trôi xuống thì đường dựng trả `FUNDING_SHAPE`
    // ("fee_payer không dùng được…"), một câu nói về trường người gọi KHÔNG gửi. Nói thẳng ở đây.
    if (f !== null && typeof f === "object" && !Array.isArray(f) && (f as Record<string, unknown>).fee_source === "did_payment") {
      throw new CodedApiError(400, "FEE_QUOTE_SELF_FUNDED",
        `Báo giá không áp cho "funding.fee_source" = "did_payment": ví Phoenix tự trả phí, không có ví ` +
        `trả phí nào để báo giá. Gọi thẳng /tx/create-vault — phí đo được nằm ở ` +
        `"summary.funding.self_funded.fee_lovelace".`, { field: "params.funding.fee_source" });
    }
  }
  return { route: route as IssuedRoute, params: p, ownerFeeAddresses: parseOwnerFeeAddresses(body.owner_fee_addresses) };
}

/** `owner_fee_addresses`: vắng ⟹ `[]`; mảng 0..10 chuỗi khác rỗng, không trùng. Kiểm địa chỉ
 *  (mạng, phần thanh toán là khoá) chạy sau, ở `quoteFee`, vì nó cần mạng của bản deploy. */
function parseOwnerFeeAddresses(o: unknown): string[] {
  if (o === undefined) return [];
  if (!Array.isArray(o)) {
    throw new CodedApiError(400, "FEE_QUOTE_SHAPE", `"owner_fee_addresses" phải là mảng chuỗi địa chỉ bech32.`,
      { field: "owner_fee_addresses" });
  }
  o.forEach((a, i) => {
    if (typeof a !== "string" || a === "") {
      throw new CodedApiError(400, "FEE_QUOTE_SHAPE", `"owner_fee_addresses[${i}]" phải là chuỗi địa chỉ bech32 khác rỗng.`,
        { field: `owner_fee_addresses[${i}]` });
    }
  });
  const addrs = o as string[];
  if (addrs.length > MAX_OWNER_FEE_ADDRESSES) {
    throw new CodedApiError(400, "FEE_QUOTE_OWNER_ADDRESSES_TOO_MANY",
      `"owner_fee_addresses" có ${addrs.length} phần tử, tối đa ${MAX_OWNER_FEE_ADDRESSES}.`,
      { count: addrs.length, max: MAX_OWNER_FEE_ADDRESSES });
  }
  const duplicates = [...new Set(addrs.filter((a, i) => addrs.indexOf(a) !== i))];
  if (duplicates.length > 0) {
    throw new CodedApiError(400, "FEE_QUOTE_OWNER_ADDRESSES_DUPLICATE",
      `"owner_fee_addresses" có địa chỉ lặp lại — mỗi địa chỉ một lần.`, { duplicates });
  }
  return addrs;
}

function feePayerInParams(field: string): CodedApiError {
  return new CodedApiError(400, "FEE_QUOTE_FEE_PAYER_IN_PARAMS",
    `"${field}" không được gửi trong báo giá: báo giá tự đặt ví trả phí cho từng nguồn (Feecover, ví ` +
    `của chủ). Bỏ trường này.`, { field });
}

// ── một lượt dựng ────────────────────────────────────────────────────────────────

/** `params` + ví trả phí của MỘT nguồn, đúng chỗ đường dựng đọc nó. */
function withFeePayer(route: IssuedRoute, params: Record<string, unknown>, fp: { utxo: string; address: string }): Record<string, unknown> {
  if (route !== "create-vault") return { ...params, fee_payer: fp };
  const f = params.funding;
  // `funding` sai hình dạng thì để nguyên: `parseFunding` trả đúng `FUNDING_SHAPE` của đường dựng.
  if (f === null || typeof f !== "object" || Array.isArray(f)) return params;
  return { ...params, funding: { ...(f as Record<string, unknown>), fee_payer: fp } };
}

async function measureOnce(
  service: VaultTxService, route: IssuedRoute, params: Record<string, unknown>, utxo: UTxO, coinsPerUtxoByte: bigint,
): Promise<Measured> {
  const body = withFeePayer(route, params, { utxo: refStr(utxo), address: utxo.address });
  const r = await runBuild(service, parseBuildRequest(route, body), { feePayerUtxo: utxo });
  const fp = feePayerFigures(r);
  const minAda = [pureAdaMinCoin(utxo.address, coinsPerUtxoByte),
    pureAdaMinCoin(baseShapeOf(utxo.address, service.network), coinsPerUtxoByte)]
    .reduce((a, b) => (a > b ? a : b));
  const needed = (fp.fee > fp.collateral ? fp.fee : fp.collateral) + minAda;
  return { fee: fp.fee, needed, horizonMs: Math.min(Number(fp.validToMs), Date.parse(fp.expiresAt)) };
}

/** Phí + thế chấp + hạn dùng của ví trả phí, đọc từ bản tóm tắt ĐÃ đọc lại CBOR. */
function feePayerFigures(r: BuildResult): { fee: bigint; collateral: bigint; validToMs: bigint; expiresAt: string } {
  if (r.route === "open-thread") {
    // `openThread` ném 422 `FEE_PAYER_DEPOSIT_UNSOURCED` khi có ví trả phí; về tới đây là lệch.
    throw new Error("[bất biến nội bộ] báo giá /tx/open-thread trả về một tx.");
  }
  if (r.route === "create-vault") {
    const f = r.out.summary.funding;
    if (f === undefined) throw new Error("[bất biến nội bộ] báo giá create-vault: bản tóm tắt thiếu `funding`.");
    // `parseQuoteBody` chặn chế độ tự trả phí (`FEE_QUOTE_SELF_FUNDED`), nên thiếu `fee_payer` là lệch.
    if (f.fee_payer === undefined) throw new Error("[bất biến nội bộ] báo giá create-vault: bản tóm tắt thiếu `funding.fee_payer`.");
    return {
      fee: BigInt(f.fee_payer.fee_lovelace), collateral: BigInt(f.fee_payer.collateral_at_risk_lovelace),
      validToMs: BigInt(f.valid_to_posix_ms), expiresAt: r.out.expiresAt,
    };
  }
  const f = r.out.summary.fee_payer;
  if (f === undefined) throw new Error(`[bất biến nội bộ] báo giá ${r.route}: bản tóm tắt thiếu \`fee_payer\`.`);
  return {
    fee: BigInt(f.fee_lovelace), collateral: BigInt(f.collateral_at_risk_lovelace),
    validToMs: BigInt(f.valid_to_posix_ms), expiresAt: r.out.expiresAt,
  };
}

// ── Feecover ─────────────────────────────────────────────────────────────────────

/**
 * Khối `feecover` (trừ phí) của báo giá: câu trả lời `/v1/fee-sources` của Feecover, chuyển NGUYÊN
 * `available` + `rule` + `message`. FAIL-CLOSED: `available: true` chỉ đi ra từ một câu trả lời 200
 * đúng hình dạng mang `available: true`; mọi lối khác là `false` kèm `reason` có tên.
 */
async function feecoverSource(
  feeProxy: FeeProxy | undefined, route: IssuedRoute,
): Promise<Omit<FeeQuoteResponse["feecover"], "fee_lovelace">> {
  if (feeProxy === undefined) return { available: false, reason: "FEE_QUOTE_FEECOVER_UNCONFIGURED" };
  const a = await feeProxy.feeSources(route);
  const words = { ...(a.rule === undefined ? {} : { rule: a.rule }), ...(a.message === undefined ? {} : { message: a.message }) };
  if (a.answered) {
    return a.available ? { available: true, ...words } : { available: false, reason: "FEE_QUOTE_FEECOVER_DECLINED", ...words };
  }
  return {
    available: false, reason: FEECOVER_REASON_OF_FAILURE[a.failure], ...words,
    ...(a.upstreamStatus === undefined ? {} : { upstream_status: a.upstreamStatus }),
  };
}

// ── phụ trợ ──────────────────────────────────────────────────────────────────────

/** Chỉ gọi trên UTxO đã qua `isPureAdaFeeUtxo` — thiếu lovelace ở đó là lệch, không đệm 0. */
function lovelaceOf(u: UTxO): bigint {
  const l = u.assets.lovelace;
  if (l === undefined) throw new Error(`[bất biến nội bộ] UTxO ${refStr(u)} không có lovelace.`);
  return l;
}

/** Số lớn hơn của hai bigint — dùng với `reduce` trên mảng khác rỗng. */
function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
