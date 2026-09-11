// VaultReadAPI/src/errors.ts — BA trạng thái, BA mã. Không gộp.
//
// Toàn bộ lý do gói này tồn tại nằm ở một phép phân biệt: "chủ này CHƯA CÓ vault"
// KHÁC "không đọc được chuỗi". Gộp hai ca lại là dựng lại đúng con số 0 mà backend
// Java đang trả cứng hôm nay — người dùng CÓ MAGIC mà chỉ điểm gãy thì vẫn thấy 0,
// và không có gì kêu lên.
//
// Nên bảng dưới đây là hợp đồng, không phải chi tiết hiện thực:
//
//   200 + { vaults: [] }        chuỗi trả lời được, chủ này không có vault nào
//   502 CHAIN_UNAVAILABLE       KHÔNG đọc được chuỗi — chưa biết chủ này có gì
//   502 VAULT_DATUM_UNDECODABLE đọc được, nhưng một UTxO MANG NFT danh-tính vault
//                               lại không giải mã được bằng lược đồ hiện tại
//   409 VAULT_IDENTITY_DUPLICATE hai UTxO khác nhau cùng mang một NFT danh-tính
//   400 BAD_REQUEST             tham số của người gọi sai
//   401 UNAUTHORIZED            thiếu/sai thẻ bài
//   404 UNKNOWN_VAULT_SCOPE     xin một (mạng, loại vault) không có trong cấu hình
//
// ⚠ `VAULT_DATUM_UNDECODABLE` cố ý là 5xx chứ không phải 2xx-với-danh-sách-rỗng.
// Nó có nghĩa là lược đồ datum của kho đã trôi khỏi thứ đang nằm trên chuỗi — tức
// là BẤT CỨ con số nào ta trả về lúc đó đều đáng ngờ, kể cả con số của các vault
// khác đọc lọt. Trả rỗng ở đây là đúng định nghĩa "cái vỏ im lặng".

/** Lớp cha cho mọi lỗi mà mặt tiền tự khai được thành mã HTTP. */
export class VaultReadError extends Error {
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

  /** Thân bài JSON trả cho người gọi. KHÔNG kèm đường dẫn nội bộ, KHÔNG kèm khoá. */
  toBody(): { error: { code: string; message: string; details: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

/**
 * Không đọc được chuỗi. Đây là ca mà mặt tiền KHÔNG BIẾT chủ đó có gì —
 * khác hẳn "biết là không có".
 *
 * `cause` giữ nguyên lỗi gốc để ghi vào nhật ký của chính sidecar; thân bài trả
 * ra ngoài chỉ mang `transport` + `httpStatusFromNode`, vì URL nút chuỗi và khoá
 * dự án là thứ không được đi ra ngoài.
 */
export class ChainUnavailableError extends VaultReadError {
  constructor(message: string, details: Record<string, unknown> = {}, cause?: unknown) {
    super(502, "CHAIN_UNAVAILABLE", message, details);
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Một UTxO MANG NFT danh-tính vault mà datum không giải mã được.
 *
 * Chỉ ném khi UTxO đó có NFT danh-tính. UTxO lạ đậu ở địa chỉ vault mà không có
 * NFT thì KHÔNG phải vault (`ScheduleGen/onchain/validators/vault.ak:266` nói
 * thẳng: một UTxO đậu ở địa chỉ vault với datum giả mạo nhưng KHÔNG có NFT là
 * thứ validator từ chối) — nó được ĐẾM và khai ở `ignored`, không được ném.
 */
export class VaultDatumUndecodableError extends VaultReadError {
  constructor(utxoRef: string, reason: string) {
    super(
      502,
      "VAULT_DATUM_UNDECODABLE",
      `UTxO ${utxoRef} mang NFT danh-tính vault nhưng datum không giải mã được bằng ` +
      `VaultDatumSchema hiện tại. Lược đồ datum của kho đã trôi khỏi thứ đang nằm trên ` +
      `chuỗi — mọi con số của lượt đọc này đều đáng ngờ, kể cả vault khác.`,
      { utxo_ref: utxoRef, decode_error: reason },
    );
  }
}

/**
 * Hai UTxO khác nhau cùng mang một NFT danh-tính vault.
 *
 * Bất khả trên một sổ cái đã lắng: NFT là one-shot và mọi nhánh spend đòi đúng
 * một cái đi kèm output tiếp-nối (`ScheduleGen/onchain/validators/vault.ak:867-869`).
 * Thấy hai cái là nhà cung cấp dữ liệu đang trả về một ảnh chụp không nhất quán
 * (đang cuộn lại, hoặc chỉ mục chậm giữa chừng một lần tiêu). CỘNG cả hai là
 * đếm hai lần đúng một vault — nên ở đây ném, không cộng.
 */
export class VaultIdentityDuplicateError extends VaultReadError {
  constructor(vaultIdUnit: string, utxoRefs: string[]) {
    super(
      409,
      "VAULT_IDENTITY_DUPLICATE",
      `Hai UTxO cùng mang NFT danh-tính ${vaultIdUnit.slice(0, 24)}… — bất khả trên sổ cái ` +
      `đã lắng. Nhà cung cấp dữ liệu đang trả ảnh chụp không nhất quán. Từ chối cộng dồn ` +
      `để không đếm hai lần một vault.`,
      { vault_id_unit: vaultIdUnit, utxo_refs: utxoRefs },
    );
  }
}

export class BadRequestError extends VaultReadError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(400, "BAD_REQUEST", message, details);
  }
}

export class UnauthorizedError extends VaultReadError {
  constructor(message = "Thiếu hoặc sai thẻ bài.") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class UnknownVaultScopeError extends VaultReadError {
  constructor(network: string, vaultType: string, known: string[]) {
    super(
      404,
      "UNKNOWN_VAULT_SCOPE",
      `Không có địa chỉ vault nào được cấu hình cho (${network}, ${vaultType}).`,
      { requested: `${network}/${vaultType}`, configured: known },
    );
  }
}
