// VaultTxAPI/src/errors.ts — mỗi kiểu hỏng một mã, và KHÔNG kiểu nào biến thành 200.
//
// Gói này dựng giao dịch mà người dùng sắp KÝ. Một nhánh phòng thủ nuốt lỗi ở đây
// không ra một màn hình trống — nó ra một giao dịch trông hợp lệ. Nên:
//
//   400 BAD_REQUEST              tham số của người gọi sai
//   401 UNAUTHORIZED             thiếu/sai thẻ bài
//   404 NOT_FOUND                không có đường đó
//   404 VAULT_NOT_FOUND          chủ này chưa có vault ở phạm vi đã cấu hình
//   405 METHOD_NOT_ALLOWED       method sai
//   409 OWNER_TX_IN_FLIGHT       chủ này đã có một tx chưa nộp — xem `locks.ts`
//   409 VAULT_AMBIGUOUS         chủ có nhiều vault, yêu cầu không nói cái nào
//   409 VAULT_IDENTITY_DUPLICATE hai UTxO cùng mang một NFT danh-tính vault
//   400 FEE_PAYER_SHAPE / FEE_PAYER_INVALID   `fee_payer` sai hình dạng / sai mạng / UTxO lạ
//   400 FEE_PAYER_CHANGE_ADDRESS_CONFLICT     `fee_payer` cùng `change_address`
//   400 FEE_PAYER_UNSUPPORTED    `fee_payer` ở gốc thân bài của `/tx/create-vault` (dùng `funding.fee_payer`)
//   422 FEE_PAYER_TX_MISMATCH    giao dịch vừa dựng lệch luật ví trả phí (`feePayer.ts`)
//   422 FEE_PAYER_DEPOSIT_UNSOURCED  `/tx/open-thread` chỉ có `fee_payer`: không ai trả min-ADA thread
//   400 ENGAGE_REF_SHAPE / ENGAGE_REF_MISMATCH  `engage_ref` sai hình dạng / không phải thread của chủ
//   404 ENGAGE_THREAD_NOT_FOUND  chủ chưa có thread Engage — mở bằng `POST /tx/open-thread`
//   409 ENGAGE_THREAD_AMBIGUOUS  chủ có nhiều thread, yêu cầu không kèm `engage_ref`
//   409 ENGAGE_THREAD_EXISTS     `/tx/open-thread` khi chủ đã có thread
//   422 ENGAGE_THREAD_DATUM_UNDECODABLE  `engage_ref` mang NFT nhưng datum không giải được
//   422 OPEN_THREAD_TX_MISMATCH  giao dịch mở thread vừa dựng lệch (NFT/output/datum genesis)
//   501 OPEN_THREAD_FUNDING_UNSUPPORTED  `/tx/open-thread` kèm `funding` — chưa hỗ trợ
//   401 FEE_PROXY_APP_UNKNOWN    `X-Feecover-Token` không khớp ứng dụng nào (hoặc không có ứng dụng mặc định)
//   400 FEE_PROXY_PURPOSE_UNMAPPED  ứng dụng chưa có mục đích Feecover cho route đó
//   403 FEE_PROXY_APP_PURPOSE    mục đích mang tiền tố của ứng dụng khác / thiếu tiền tố của chính ứng dụng
//   403 FEE_PROXY_TX_NOT_ISSUED  `/fee/sign` cho tx không do dịch vụ phát, hoặc quá hạn xin ký
//   400 FEE_PROXY_NO_FEE_PAYER   `/fee/sign` cho tx không dùng ví trả phí
//   4xx FEE_PROXY_REJECTED       Feecover từ chối — mã trạng thái + `rule`/`message`/`reasons` chuyển nguyên
//   501 FEE_PROXY_UNAVAILABLE    bản deploy không khai `feecover`
//   502 FEE_PROXY_UPSTREAM       Feecover không trả lời / trả 5xx / trả sai hình dạng
//   502 FEE_PROXY_UPSTREAM_MISMATCH  Feecover ký một tx có hash khác tx đã gửi
//   422 TX_BUILD_REJECTED        dựng được tới nơi nhưng giao thức từ chối (L×λ > L_avail,
//                                MAGIC còn sống < required, shard hết chỗ…)
//   422 TX_SUMMARY_UNDECODABLE   dựng ra CBOR mà không đọc lại được — xem `summary.ts`
//   502 CHAIN_UNAVAILABLE        không đọc được chuỗi
//   502 VAULT_DATUM_UNDECODABLE  đọc được, nhưng datum không khớp lược đồ hiện tại
//   502 SUBMIT_REJECTED          nút chuỗi từ chối tx đã ký
//   500 INTERNAL                 ngoài dự kiến — trả MÃ THAM CHIẾU, không trả traceback
//
// ⚠ `VAULT_NOT_FOUND` là 404 chứ không phải 200-với-tx-rỗng. Không có vault thì
// KHÔNG có giao dịch nào để ký, và trả một thân bài hình dạng-thành-công cho ca đó
// là bắt app phải đoán bằng cách dò trường.

import { randomBytes } from "node:crypto";

export class TxApiError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(httpStatus: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = code;
    this.httpStatus = httpStatus;
    this.code = code;
    this.details = details;
  }

  toBody(): { error: { code: string; message: string; details: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export class BadRequestError extends TxApiError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(400, "BAD_REQUEST", message, details);
  }
}

export class UnauthorizedError extends TxApiError {
  constructor(message = "Thiếu hoặc sai thẻ bài.") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class VaultNotFoundError extends TxApiError {
  constructor(ownerPkh: string, addresses: string[]) {
    super(
      404,
      "VAULT_NOT_FOUND",
      `Không có vault nào mang NFT danh-tính và thuộc chủ ${ownerPkh.slice(0, 12)}… ở các địa chỉ ` +
      `đã cấu hình. Chưa có vault thì chưa có giao dịch nào để ký.`,
      { owner_pkh: ownerPkh, addresses_searched: addresses },
    );
  }
}

/**
 * Hai UTxO khác nhau cùng mang một NFT danh-tính vault.
 *
 * NFT vault là one-shot (`INV-VAULT-IDENTITY`), nên trên một sổ cái đã lắng chuyện này
 * bất khả. Thấy hai cái nghĩa là nhà cung cấp dữ liệu đang trả ảnh chụp giữa chừng một
 * lần tiêu. Chọn đại một cái để dựng tx là chọn đại một input — tx sẽ chết sau khi
 * người dùng đã ký.
 */
export class VaultIdentityDuplicateError extends TxApiError {
  constructor(vaultIdUnit: string, utxoRefs: string[]) {
    super(
      409,
      "VAULT_IDENTITY_DUPLICATE",
      `Hai UTxO cùng mang NFT danh-tính ${vaultIdUnit.slice(0, 24)}… — bất khả trên sổ cái đã ` +
      `lắng. Từ chối chọn đại một cái làm input.`,
      { vault_id_unit: vaultIdUnit, utxo_refs: utxoRefs },
    );
  }
}

/**
 * Chủ này có NHIỀU vault hợp lệ trong cùng phạm vi, và yêu cầu không nói dựng cho cái nào.
 *
 * Nhiều vault một chủ là HỢP LỆ (khác thời hạn, khác profile) — mặt tiền ĐỌC cộng dồn
 * chúng và đó là câu trả lời đúng ở bên đọc. Nhưng dựng giao dịch thì phải CHỌN một
 * UTxO làm input, và chọn đại là chọn hộ người dùng một cái vault họ không nhắc tới.
 * Nên ở đây fail-closed, và thân bài liệt kê đủ để bên gọi chọn.
 */
export class VaultAmbiguousError extends TxApiError {
  constructor(ownerPkh: string, vaultType: string, utxoRefs: string[]) {
    super(
      409,
      "VAULT_AMBIGUOUS",
      `Chủ ${ownerPkh.slice(0, 12)}… có ${utxoRefs.length} vault loại ${vaultType} hợp lệ. ` +
      `Yêu cầu không nói dựng cho vault nào, và chọn đại một cái là chọn hộ người dùng.`,
      { owner_pkh: ownerPkh, vault_type: vaultType, utxo_refs: utxoRefs },
    );
  }
}

/** Chủ này đã có một giao dịch dựng xong mà chưa nộp. Xem `locks.ts` cho lý do. */
export class OwnerTxInFlightError extends TxApiError {
  constructor(ownerPkh: string, heldTxHash: string, expiresAtIso: string) {
    super(
      409,
      "OWNER_TX_IN_FLIGHT",
      `Chủ ${ownerPkh.slice(0, 12)}… đã có một giao dịch dựng xong mà chưa nộp ` +
      `(${heldTxHash.slice(0, 16)}…). Dựng thêm một giao dịch bây giờ sẽ chọn TRÙNG UTxO vault, ` +
      `và chỉ một trong hai lên được chuỗi — cái kia chết SAU khi người dùng đã ký. ` +
      `Hãy nộp hoặc bỏ giao dịch kia; khoá mềm tự hết hạn lúc ${expiresAtIso}.`,
      { owner_pkh: ownerPkh, held_tx_hash: heldTxHash, lock_expires_at: expiresAtIso },
    );
  }
}

/** Giao thức từ chối trước khi có tx: L×λ > L_avail, MAGIC sống < required, shard hết chỗ… */
export class TxBuildRejectedError extends TxApiError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(422, "TX_BUILD_REJECTED", message, details);
  }
}

/**
 * Một năng lực có mã nhưng CHƯA được khai đủ cấu hình để mở.
 *
 * `501` chứ không `404`: đường này TỒN TẠI, nó chưa được bật. `404` bảo bên gọi đi
 * sửa URL — việc không có gì để sửa; `501` bảo họ đi hỏi người vận hành, và đó là
 * việc đúng. `503` cũng sai vì nó hứa "thử lại sau", trong khi không có thời gian
 * nào làm một mục cấu hình tự xuất hiện.
 */
export class ConfigMissingError extends TxApiError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(501, "CONFIG_MISSING", message, details);
  }
}

export class ChainUnavailableError extends TxApiError {
  constructor(message: string, details: Record<string, unknown> = {}, cause?: unknown) {
    super(502, "CHAIN_UNAVAILABLE", message, details);
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export class VaultDatumUndecodableError extends TxApiError {
  constructor(utxoRef: string, reason: string) {
    super(
      502,
      "VAULT_DATUM_UNDECODABLE",
      `UTxO ${utxoRef} mang NFT danh-tính vault nhưng datum không giải mã được bằng ` +
      `VaultDatumSchema hiện tại. Lược đồ của kho đã trôi khỏi thứ đang nằm trên chuỗi — ` +
      `dựng tiếp là dựng một giao dịch trên một hiểu nhầm.`,
      { utxo_ref: utxoRef, decode_error: reason },
    );
  }
}

/**
 * Dựng ra CBOR mà không đọc lại được thành `summary`.
 *
 * Đây KHÔNG phải lỗi nhỏ được phép bỏ qua. `summary` là thứ duy nhất app hiện cho
 * người dùng trước khi họ ký. Trả `tx_cbor` kèm một `summary` rỗng (hoặc kèm tham số
 * đầu vào chép lại) là mời người ta ký một thứ không ai đọc.
 */
export class TxSummaryUndecodableError extends TxApiError {
  constructor(reason: string, details: Record<string, unknown> = {}) {
    super(
      422,
      "TX_SUMMARY_UNDECODABLE",
      `Dựng được giao dịch nhưng không suy lại được bản tóm tắt TỪ CHÍNH CBOR đó: ${reason}. ` +
      `Từ chối trả tx — người dùng sẽ không có gì để đọc trước khi ký.`,
      details,
    );
  }
}

export class SubmitRejectedError extends TxApiError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(502, "SUBMIT_REJECTED", message, details);
  }
}

/**
 * Lỗi ngoài dự kiến. Người gọi nhận MỘT MÃ THAM CHIẾU, không nhận traceback.
 *
 * Mã phải tra ngược được ở nhật ký — nếu không thì nó chỉ là "có lỗi xảy ra" mặc
 * đồng phục. `newReferenceCode()` sinh mã; `server.ts` ghi mã + nguyên nhân gốc vào
 * nhật ký của chính dịch vụ, nơi người vận hành tra được.
 */
export function newReferenceCode(): string {
  return `ref_${randomBytes(6).toString("hex")}`;
}

/**
 * Lỗi 4xx/5xx mang MÃ RIÊNG — cho các ca mà app phải phân biệt được với nhau (chủ sai
 * hình dạng · hai trường chủ mâu thuẫn · thiếu nhân chứng chủ script · chưa đăng ký stake).
 * Gộp chúng vào `BAD_REQUEST` là bắt app đoán từ câu chữ.
 */
export class CodedApiError extends TxApiError {
  constructor(httpStatus: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(httpStatus, code, message, details);
  }
}

/**
 * `OwnerAuthError` (ném từ bộ dựng / nhân chứng) → mã HTTP. GIỮ NGUYÊN `code`: tầng API ánh
 * xạ theo mã, không theo câu chữ.
 *
 *   OWNER_HASH_INVALID · OWNER_CREDENTIAL_SHAPE · OWNER_AUTH_MISMATCH  → 400 (bên gọi gửi sai)
 *   OWNER_SCRIPT_WITNESS_UNAVAILABLE                                    → 400 (thiếu nhân chứng)
 *   OWNER_STAKE_NOT_REGISTERED · OWNER_STAKE_REWARDS_PENDING           → 422 (trạng thái chuỗi)
 *   OWNER_WITHDRAW_RETURNED_NOTHING                                     → 500 (lỗi nhân chứng phía dịch vụ)
 */
export function ownerApiErrorOf(e: { code: string; message: string }): CodedApiError {
  const status =
    e.code === "OWNER_STAKE_NOT_REGISTERED" || e.code === "OWNER_STAKE_REWARDS_PENDING" ? 422
    : e.code === "OWNER_WITHDRAW_RETURNED_NOTHING" ? 500
    : 400;
  return new CodedApiError(status, e.code, e.message);
}
