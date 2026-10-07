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
//   409 TX_SUPERSEDED            `/tx/submit` · `/fee/sign`: tx đã bị thay — một tx chung khoá chủ đã
//                                nộp sau khi nó được dựng, hoặc input của nó đã bị tx khác vừa nộp tiêu
//   🪦  OWNER_TX_IN_FLIGHT       ĐÃ NGHỈ 2026-10-03 — không còn ném (lượt dựng mới thay lượt cũ,
//                                `locks.ts`); giữ tên vì app đời cũ ánh xạ, không dùng lại
//   409 VAULT_AMBIGUOUS         chủ có nhiều vault, yêu cầu không nói cái nào
//   409 VAULT_IDENTITY_DUPLICATE hai UTxO cùng mang một NFT danh-tính vault
//   400 FEE_PAYER_SHAPE / FEE_PAYER_INVALID   `fee_payer` sai hình dạng / sai mạng / UTxO lạ
//   400 FEE_PAYER_CHANGE_ADDRESS_CONFLICT     `fee_payer` cùng `change_address`
//   400 FEE_PAYER_UNSUPPORTED    `fee_payer` ở gốc thân bài của `/tx/create-vault`, trừ két instant 0 LAMP không `funding`
//   422 FEE_PAYER_TX_MISMATCH    giao dịch vừa dựng lệch luật ví trả phí (`feePayer.ts`)
//   422 FEE_PAYER_FRONTING_ABOVE_MAX  ví trả phí phải ứng min-ADA vượt `fee_payer_fronting_max_lovelace`
//   422 FEE_PAYER_OWNER_REWARD_NONZERO  chủ did_stake có thưởng > 0 mà không suy được ví Phoenix (did_payment) của chủ (`details.missing`)
//   422 FEE_PAYER_OWNER_REWARD_BELOW_MIN_ADA  thưởng did_stake > 0 nhưng dưới min-ADA của output về ví Phoenix; ví trả phí không ứng
//   400 ENGAGE_REF_SHAPE / ENGAGE_REF_MISMATCH  `engage_ref` sai hình dạng / không phải thread của chủ
//   404 ENGAGE_THREAD_NOT_FOUND  chủ chưa có thread Engage — mở bằng `POST /tx/open-thread`
//   409 ENGAGE_THREAD_AMBIGUOUS  chủ có nhiều thread, yêu cầu không kèm `engage_ref`
//   400 CONSUME_PAIRS_CONFLICT   `/tx/consume`: `pairs` đi cùng `op_type`/`op_count` (gửi MỘT dạng)
//   400 CONSUME_PAIRS_SHAPE      `pairs` không phải mảng / phần tử không phải `{ op_type, op_count }`
//   400 CONSUME_PAIRS_EMPTY / CONSUME_PAIRS_TOO_MANY  `pairs` rỗng / quá 8 cặp (`MAX_CONSUME_PAIRS`)
//   400 CONSUME_PAIRS_NOT_INCREASING  `op_type` không tăng ngặt (kể cả trùng)
//   400 CONSUME_PAIR_COUNT_INVALID / CONSUME_PAIR_TYPE_INVALID  `op_count` không phải chuỗi chữ số ≥ 1
//                                (≤ 20 chữ số) / `op_type` không phải số nguyên trong [0, 1000000]
//   422 CONSUME_TX_MISMATCH      tx tiêu vừa dựng lệch lượt tiêu đã yêu cầu (`consumeLine.ts` ▸ `checkConsumeTx`)
//   422 CONSUME_TOO_MANY_BATCHES lượt tiêu phải đốt từ nhiều lô hơn một tx chở được, kể cả cách ít lô nhất
//                                (`MagicSDK` ▸ `MAX_BURN_ENTRIES_PER_TX`); `details.burn_entries_needed` ·
//                                `burn_entries_cap` · `live_batches`. Ném TRƯỚC khi dựng tx (`txBuilder.ts` ▸ `asProtocolError`)
//   409 ENGAGE_THREAD_EXISTS     `/tx/open-thread` khi chủ đã có thread
//   422 ENGAGE_THREAD_DATUM_UNDECODABLE  `engage_ref` mang NFT nhưng datum không giải được
//   422 OPEN_THREAD_TX_MISMATCH  giao dịch mở thread vừa dựng lệch (NFT/output/datum genesis)
//   400 WAKEME_VAULT_REF_SHAPE   `wakeme_vault_ref` sai hình dạng
//   501 WAKEME_VAULT_UNAVAILABLE mạng chưa có script hash két Wakeme
//   404 WAKEME_VAULT_NOT_FOUND / 409 WAKEME_VAULT_SPENT  UTxO két không có / đã bị tiêu
//   409 WAKEME_VAULT_SCRIPT_MISMATCH / WAKEME_VAULT_PIN_MISMATCH  két sai script / không ghim vault này
//   422 WAKEME_VAULT_UNREADABLE  datum/NFT két không đạt luật đọc L_lent
//   422 WAKEME_VAULT_TX_MISMATCH tx vừa dựng tiêu két hoặc thiếu két trong reference_inputs
//   422 WAKEME_LINK_CHANGE_REJECTED  `wakeme_vault_ref` không phải két đã nối và lượt này không nối/đổi
//                                link được (luật 6) — chạy `/tx/refresh-checkpoint` trước
//   501 OPEN_THREAD_FUNDING_UNSUPPORTED  `/tx/open-thread` kèm `funding` — chưa hỗ trợ
//   400 DID_COMMIT_INVALID       `/tx/bind-did`: `did_commit` không phải đúng 64 ký tự hex thường (32 byte)
//   409 DID_ALREADY_BOUND        `/tx/bind-did`: thread đã gắn DID (một chiều, một lần) — `details.did_commit` = giá trị hiện có
//   422 BIND_DID_TX_MISMATCH     giao dịch gắn DID vừa dựng lệch (redeemer/value/datum/chữ ký chủ)
//   401 FEE_PROXY_APP_UNKNOWN    `X-Feecover-Token` không khớp ứng dụng nào (hoặc không có ứng dụng mặc định)
//   400 FEE_PROXY_PURPOSE_UNMAPPED  ứng dụng chưa có mục đích Feecover cho route đó
//   403 FEE_PROXY_APP_PURPOSE    mục đích mang tiền tố của ứng dụng khác / thiếu tiền tố của chính ứng dụng
//   410 TX_EXPIRED               `/tx/submit` và `/fee/sign` cho tx dịch vụ đã phát nhưng quá validTo + biên
//                                lệch đồng hồ — `details.tx_hash`, `details.expired_at` (ISO 8601 = validTo),
//                                `details.rebuild_safe`, `details.submission` (`locks.ts` ▸ `expiredErrorFor`)
//   403 FEE_PROXY_TX_NOT_ISSUED  `/fee/sign` cho tx không do dịch vụ phát, hoặc còn hạn nộp nhưng đã quá giờ
//                                giữ chỗ UTxO phí (`reserved_until`)
//   409 FEE_PAYER_RESERVATION_EXPIRED  UTxO ví trả phí hết giờ giữ chỗ Feecover trước khi tx kịp có một
//                                khoảng hiệu lực (`validity.ts`), hoặc UTxO Feecover không còn lượt giữ lúc
//                                dựng / lúc `/fee/sign` (`locks.ts` ▸ `feeReservationForBuild` / `feeSignProblem`)
//                                — `details.reserved_until` (null khi vắng), `fee_payer_utxo`, `reservation`;
//                                xin lại `/fee/utxo`
//   400 WITNESS_SIGNATURE_INVALID / WITNESS_MISSING_SIGNER  `/tx/submit`: một chữ ký không khớp thân tx /
//                                thiếu chữ ký của khoá trong `required_signers` (`witnessCheck.ts`)
//   400 FEE_PROXY_NO_FEE_PAYER   `/fee/sign` cho tx không dùng ví trả phí
//   4xx FEE_PROXY_REJECTED       Feecover từ chối — mã trạng thái + `rule`/`message`/`reasons` chuyển nguyên
//   501 FEE_PROXY_UNAVAILABLE    bản deploy không khai `feecover`
//   502 FEE_PROXY_UPSTREAM       Feecover không trả lời / trả 5xx / trả sai hình dạng
//   502 FEE_PROXY_UPSTREAM_MISMATCH  Feecover ký một tx có hash khác tx đã gửi
//   400 WAKEME_VAULT_REF_REQUIRED  `/tx/consume` làm mới checkpoint của két đang ghim két Wakeme
//                                (`wakeme_link` khác "") mà thân bài không kèm `wakeme_vault_ref`
//   400 INSTANT_GEN_M_INVALID    `m` của `/tx/instant-gen` vắng / không phải chuỗi chữ số / bằng 0
//   422 INSTANT_GEN_M_ABOVE_MAX  `m` vượt `max_m` tính trên đúng ảnh chụp beacon/shard sẽ dựng
//   501 CONFIG_MISSING           đường có mã nhưng bản deploy thiếu mục cấu hình nó cần
//                                (`gen_v2`, `ref_script_utxos.commit|gb_shard`…) — `details.missing`
//                                nêu đúng khoá, `details.route` nêu đường
//   501 VAULT_KIND_UNSUPPORTED   bản deploy là khối két Prepaid mà route chưa có bộ dựng cho loại
//                                két đó (`service.ts` ▸ `assertScopesSupported`) — `details.route`
//                                (két Prepaid đi qua `/tx/sponsor/*`; `vaultModuleOf` cũng trả mã này)
//   ── hành trình tài trợ `/tx/sponsor/*` (`sponsor.ts`) ──
//   400 SPONSOR_REQUEST_SHAPE    thân bài sai hình dạng (`details.field`)
//   400 SPONSOR_DID_COMMIT_LENGTH · SPONSOR_VAULT_REF_MISMATCH · SPONSOR_CHANGE_ADDRESS_INVALID ·
//       SPONSOR_UTXO_NOT_KEY · DID_COMMIT_INVALID
//   404 SPONSOR_ANCHOR_NOT_FOUND · SPONSOR_FUND_NOT_FOUND · VAULT_NOT_FOUND · ENGAGE_THREAD_NOT_FOUND
//   409 SPONSOR_ANCHOR_AMBIGUOUS · SPONSOR_FUND_AMBIGUOUS · SPONSOR_EPOCH_MISMATCH · VAULT_ALREADY_EXISTS
//   422 SPONSOR_VALIDITY_SPANS_EPOCHS · SPONSOR_ANCHOR_REF_WRONG · SPONSOR_FUND_NOT_PINNED ·
//       SPONSOR_CARP_INSUFFICIENT · SPONSOR_CARP_OUTPUT_UNPINNED · SPONSOR_WITHDRAW_COUNT ·
//       SPONSOR_BUILD_FAILED · SPONSOR_TX_MISMATCH · SPONSOR_THREAD_DID_INVALID
//   501 SPONSOR_NETWORK_UNSUPPORTED (mạng không có gốc kỳ — Preview) · SPONSOR_PREPAID_UNAVAILABLE ·
//       SPONSOR_PREPAID_SCRIPTS_MISMATCH · SPONSOR_UNAVAILABLE
//   500 INTERNAL ⟸ SPONSOR_GRID_MISMATCH · SPONSOR_ANCHOR_REF_MISSING (lỗi dựng của chính dịch vụ)
//   ── `GET /tx/status/{tx_hash}` (chỉ đọc) ──
//   400 TX_HASH_INVALID          `tx_hash` không phải đúng 64 hex thường (kể cả vắng)
//   502 TX_STATUS_PROVIDER_UNAVAILABLE  nhà cung cấp chuỗi lỗi / quá giờ / trả hình dạng lạ ở bước tra
//                                khối hoặc mempool (`details.stage`) — KHÔNG BAO GIỜ thành `not_found`
//   400 UTXO_NOT_FOUND / 409 UTXO_SPENT  out-ref do bên gọi đưa không có / đã bị tiêu (`chain.ts`)
//   409 PREVIOUS_TX_PENDING      tx trước của vault đã nộp nhưng chưa vào khối — UTxO vault đang bị nó tiêu
//   400 CHANGE_ADDRESS_REQUIRED / CHANGE_ADDRESS_INVALID  thiếu / sai `change_address`
//   400 OWNER_HASH_INVALID · OWNER_CREDENTIAL_SHAPE · OWNER_ALIAS_MISMATCH · OWNER_WITNESS_SHAPE ·
//       OWNER_WITNESS_UNEXPECTED · OWNER_ANCHOR_INVALID   chủ / nhân chứng chủ sai (`owner.ts`)
//   501|400 OWNER_SCRIPT_WITNESS_UNAVAILABLE  chủ script: dịch vụ chưa cấu hình (501) / bên gọi
//                                thiếu nhân chứng (400). Mã từ `OwnerAuthError`: `ownerApiErrorOf`
//   400 OWNER_DID_SHAPE · OWNER_DID_CONFLICT · OWNER_DEVICE_NOT_LISTED   chủ `{type:"did"}` sai
//                                hình dạng / đi kèm `owner_witness`|`owner_pkh` / khoá thiết bị
//                                không có trong anchor (`owner.ts`, `didOwner.ts`)
//   422 OWNER_ANCHOR_NOT_FOUND · OWNER_ANCHOR_AMBIGUOUS · OWNER_ANCHOR_SCHEMA · OWNER_ANCHOR_NOT_ACTIVE
//                                anchor của DID trên chuỗi: không có / nhiều hơn một / datum không
//                                phải TAADDatum 18 trường / không Active (`didOwner.ts`)
//   400 FUNDING_SHAPE · FUNDING_WITNESS_MISMATCH · FUNDING_ANCHOR_INVALID ·
//       FUNDING_FEE_PAYER_INVALID · FUNDING_COLLATERAL_INVALID · FUNDING_CHANGE_ADDRESS_CONFLICT
//                                khối `funding` của `/tx/create-vault` sai (`funding.ts`)
//   422 FUNDING_TX_MISMATCH      tx tạo vault vừa dựng lệch luật `funding`; mã `FundingError` của
//                                SDK đi nguyên (`FUNDING_INSUFFICIENT` ⟹ 422, còn lại 400)
//   501 FUNDING_UNAVAILABLE      bản deploy thiếu `did_stake` ⟹ không đọc được anchor DID cho `funding`
//   400 FEE_QUOTE_SHAPE · FEE_QUOTE_ROUTE_UNKNOWN · FEE_QUOTE_FUNDING_REQUIRED ·
//       FEE_QUOTE_SELF_FUNDED · FEE_QUOTE_OWNER_ADDRESS_INVALID · FEE_QUOTE_OWNER_ADDRESSES_TOO_MANY ·
//       FEE_QUOTE_OWNER_ADDRESSES_DUPLICATE · FEE_QUOTE_FEE_PAYER_IN_PARAMS  yêu cầu báo giá sai (`feeQuote.ts`)
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

/**
 * 🪦 ĐÃ NGHỈ (2026-10-03) — dịch vụ KHÔNG còn ném mã `OWNER_TX_IN_FLIGHT`. Lượt dựng mới nay THAY
 * lượt cũ (`locks.ts`), xung đột bắt ở lúc nộp bằng `TX_SUPERSEDED`. Lớp và mã giữ lại vì app đời
 * cũ còn ánh xạ chuỗi này; đừng dùng lại tên cho một nghĩa khác.
 */
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

/**
 * Tx này đã bị THAY: một tx khác (chung khoá chủ / chung input) đã được nộp trước nó. Nộp tiếp
 * thì chuỗi từ chối vì input không còn — nên chặn ở đây, nói rõ, trước khi gọi nút chuỗi.
 * `details.superseded_by` (hash tx đã nộp) và/hoặc `details.conflicting_inputs`.
 */
export class TxSupersededError extends TxApiError {
  /** `submission`: tiến trình dịch vụ này đã GỬI chính tx đó tới nút chưa — `accepted` (nút nhận),
   *  `unconfirmed` (đã gửi, không nhận được xác nhận: mất kết nối / quá giờ / nút báo hash khác),
   *  `none` (tiến trình này chưa gửi). `previously_submitted` = `submission !== "none"`.
   *
   *  Cả hai KHÔNG nói gì về trạng thái chuỗi của tx này. `none` chỉ là "TIẾN TRÌNH NÀY chưa gửi":
   *  tiến trình khởi động lại (sổ trong bộ nhớ), bản sao khác sau bộ cân tải, hay một đường nộp khác
   *  đều có thể đã đưa nó lên chuỗi. Bên gọi tra chuỗi theo `tx_hash`, đừng suy từ mã lỗi. */
  constructor(
    txHash: string,
    details: {
      superseded_by?: string; conflicting_inputs?: string[];
      previously_submitted: boolean; submission: "accepted" | "unconfirmed" | "none";
    },
  ) {
    super(
      409,
      "TX_SUPERSEDED",
      `Giao dịch ${txHash.slice(0, 16)}… đã bị thay: ` +
      (details.superseded_by !== undefined
        ? `giao dịch ${details.superseded_by.slice(0, 16)}… của cùng chủ đã được nộp sau khi giao dịch này được dựng`
        : `input ${(details.conflicting_inputs ?? []).join(", ")} đã bị một giao dịch khác vừa nộp tiêu`) +
      (details.previously_submitted
        ? `. Không nộp lại. Dịch vụ ĐÃ GỬI giao dịch này trước đó (${details.submission}) — nó có thể đã ` +
          `vào khối; tra chuỗi theo tx_hash trước khi dựng lại.`
        : `. Không nộp. Đợi giao dịch kia vào khối rồi dựng lại nếu còn cần.`),
      { tx_hash: txHash, ...details },
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
 * 410 `TX_EXPIRED` — `/tx/submit` hoặc `/fee/sign` cho một tx dịch vụ ĐÃ phát, nay quá `validTo + CLOCK_SKEW_MARGIN_MS`
 * (`validity.ts`). Khác `SUBMIT_REJECTED` (tx không do dịch vụ phát): bên gọi biết chắc phải dựng lại.
 * `details.expired_at` = mốc hết hạn dạng ISO 8601 (`validTo`, cùng khuôn `expires_at`);
 * `details.rebuild_safe` = `true` khi tx chưa từng được gửi tới nút — sổ cái không còn nhận nó, nên
 * dựng bản mới không thể ra hai tx cùng lên chuỗi. Tx đã từng gửi ⟹ `false` (có thể đã lên chuỗi
 * trước mốc): tra chuỗi theo `tx_hash` trước khi dựng lại.
 */
export class TxExpiredError extends TxApiError {
  constructor(txHash: string, expiredAtIso: string, submission: "accepted" | "unconfirmed" | "none") {
    super(410, "TX_EXPIRED",
      `Giao dịch ${txHash} đã hết hạn lúc ${expiredAtIso} — sổ cái không nhận nó nữa. ` +
      (submission === "none"
        ? `Gọi lại đường /tx/* tương ứng để dựng bản mới rồi ký bản đó.`
        : `Giao dịch này từng được gửi tới nút: tra chuỗi theo tx_hash trước khi dựng lại.`),
      { tx_hash: txHash, expired_at: expiredAtIso, rebuild_safe: submission === "none", submission });
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
 *   OWNER_STAKE_NOT_REGISTERED                                          → 422 (trạng thái chuỗi)
 *   OWNER_WITHDRAW_RETURNED_NOTHING                                     → 500 (lỗi nhân chứng phía dịch vụ)
 */
export function ownerApiErrorOf(e: { code: string; message: string }): CodedApiError {
  const status =
    e.code === "OWNER_STAKE_NOT_REGISTERED" ? 422
    : e.code === "OWNER_WITHDRAW_RETURNED_NOTHING" ? 500
    : 400;
  // `OwnerAuthError` tự chèn `${code}: ` vào đầu câu; trường `code` đã mang mã, nên câu
  // trả cho app bỏ tiền tố đó — app hiện nguyên câu máy chủ cho người dùng.
  const prefix = `${e.code}: `;
  const message = e.message.startsWith(prefix) ? e.message.slice(prefix.length) : e.message;
  return new CodedApiError(status, e.code, message);
}
