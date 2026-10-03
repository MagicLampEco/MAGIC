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
//   502 VAULT_DATUM_V1          một UTxO MANG NFT danh-tính vault mang datum ĐỜI TRƯỚC
//                               Gen v2.0 (Instant 18 / Schedule 17 trường) — scope đang
//                               trỏ vào két đời cũ; v2.0 là hash mới, không di trú
//   409 VAULT_IDENTITY_DUPLICATE hai UTxO khác nhau cùng mang một NFT danh-tính
//   400 BAD_REQUEST             tham số của người gọi sai
//   401 UNAUTHORIZED            thiếu/sai thẻ bài
//   404 UNKNOWN_VAULT_SCOPE     xin một (mạng, loại vault) không có trong cấu hình
//
import { randomBytes } from "node:crypto";

// ⚠ `VAULT_DATUM_UNDECODABLE` cố ý là 5xx chứ không phải 2xx-với-danh-sách-rỗng.
// Nó có nghĩa là lược đồ datum của kho đã trôi khỏi thứ đang nằm trên chuỗi — tức
// là BẤT CỨ con số nào ta trả về lúc đó đều đáng ngờ, kể cả con số của các vault
// khác đọc lọt. Trả rỗng ở đây là đúng định nghĩa "cái vỏ im lặng".

/**
 * Mã tham chiếu cho một lỗi 500: người gọi nhận MÃ (không traceback, không đường dẫn nội bộ),
 * nhật ký của sidecar nhận mã + nguyên nhân gốc — tra ngược được từ câu báo của người dùng.
 * Cùng khuôn với `VaultTxAPI/src/errors.ts` ▸ `newReferenceCode`.
 */
export function newReferenceCode(): string {
  return `ref_${randomBytes(6).toString("hex")}`;
}

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
 * Một UTxO MANG NFT danh-tính vault mà datum là hình dạng ĐỜI TRƯỚC Gen v2.0.
 *
 * Mã RIÊNG, không gộp vào `VAULT_DATUM_UNDECODABLE`, vì hai ca cần hai cách xử:
 * `UNDECODABLE` nói lược đồ của kho đã trôi khỏi chuỗi (lỗi mã); `V1` nói cấu hình đang
 * trỏ scope vào một địa chỉ két đời cũ (lỗi cấu hình) — hash v2.0 là script MỚI, không
 * két v2.0 nào mang được datum này, và chủ dự án đã chốt không di trú UTxO v1.
 *
 * KHÔNG đệm các ô thiếu (`usage_window`, `cap_*`…) rồi trả tiếp: một két v1 đọc như v2
 * là đọc sai ô 6/12/14 (Instant tái dụng ba ô đó ở v2.0), và con số ra trông hợp lệ.
 */
export class VaultDatumV1Error extends VaultReadError {
  constructor(utxoRef: string, fieldCount: number, generation: "Instant" | "Schedule") {
    super(
      502,
      "VAULT_DATUM_V1",
      `UTxO ${utxoRef} mang NFT danh-tính vault nhưng datum ${fieldCount} trường là két ` +
      `${generation} đời TRƯỚC Gen v2.0. Mặt tiền này chỉ đọc két v2.0 (hash mới, không di ` +
      `trú) — scope đang trỏ vào một địa chỉ két đời cũ.`,
      { utxo_ref: utxoRef, field_count: fieldCount, datum_generation: `${generation}-v1` },
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

/** `owner` và bí danh `owner_pkh` cùng có mà chỉ hai chủ khác nhau. Mã RIÊNG, không gộp vào
 *  `BAD_REQUEST`: app cần phân biệt "gửi sai khuôn" với "gửi hai chủ mâu thuẫn". */
export class OwnerAliasMismatchError extends VaultReadError {
  constructor(owner: { type: string; hash: string }, alias: { type: string; hash: string }) {
    super(400, "OWNER_ALIAS_MISMATCH",
      `owner = ${owner.type}:${owner.hash.slice(0, 12)}… nhưng owner_pkh = ${alias.hash.slice(0, 12)}…. ` +
      `Hai trường cùng có thì phải chỉ cùng một chủ.`,
      { owner, owner_pkh: alias.hash },
    );
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

// ── Chỉ mục DID ⟹ thread (`threadIndex.ts`) ─────────────────────────────────────
//
//   200 + { threads: [] }        chỉ mục TƯƠI, DID này không có thread nào
//   404 THREAD_NOT_FOUND         chỉ mục TƯƠI, không có thread mang NFT này
//   503 INDEX_STALE              chỉ mục trễ hơn ngưỡng, hoặc CHƯA đồng bộ lần nào — KHÔNG
//                                biết, nên không trả danh sách
//   503 THREAD_INDEX_DISABLED    tiến trình không cấu hình địa chỉ consume nào
//   404 UNKNOWN_CONSUME_SCOPE    policy người gọi hỏi không nằm trong tập đang theo dõi
//   502 THREAD_DATUM_UNDECODABLE UTxO mang đúng NFT thread nhưng datum không đọc được
//   409 THREAD_IDENTITY_DUPLICATE hai UTxO cùng mang một NFT thread
//
// Vì sao "cũ" là 503 chứ không phải 200-kèm-cờ: bên tiêu thụ chính (Wakeme) dùng UTxO thread
// làm reference input cho genesis. Một UTxO đã bị tiêu mà chỉ mục chưa biết ⟹ giao dịch của
// họ bị chuỗi từ chối, người dùng mất suất, và một cờ `stale: true` nằm cạnh danh sách là thứ
// một bên gọi vội vàng sẽ không đọc.

export class IndexStaleError extends VaultReadError {
  constructor(details: {
    synced_slot: number | null;
    tip_slot: number | null;
    lag_blocks: number | null;
    stale_threshold_blocks: number;
    reason: "NEVER_SYNCED" | "LAG_EXCEEDED";
    last_sync_error: string | null;
  }) {
    super(
      503,
      "INDEX_STALE",
      details.reason === "NEVER_SYNCED"
        ? "Chỉ mục thread chưa đồng bộ xong lần nào — chưa biết gì, không trả danh sách."
        : `Chỉ mục thread trễ ${details.lag_blocks} khối, quá ngưỡng ${details.stale_threshold_blocks}. ` +
          `Danh sách có thể chứa UTxO đã bị tiêu — không trả.`,
      details,
    );
  }
}

export class ThreadIndexDisabledError extends VaultReadError {
  constructor() {
    super(503, "THREAD_INDEX_DISABLED",
      "Tiến trình này không cấu hình địa chỉ consume nào (VAULT_READ_API_CONSUME_SCOPES) — chỉ mục thread tắt.");
  }
}

export class ThreadNotFoundError extends VaultReadError {
  constructor(unit: string) {
    super(404, "THREAD_NOT_FOUND",
      "Chỉ mục tươi và không có UTxO nào đang mang NFT thread này.", { asset: unit });
  }
}

export class UnknownConsumeScopeError extends VaultReadError {
  constructor(policy: string, known: string[]) {
    super(404, "UNKNOWN_CONSUME_SCOPE",
      `Policy ${policy.slice(0, 12)}… không phải script hash consume nào đang được theo dõi.`,
      { policy, tracked: known });
  }
}

export class ThreadDatumUndecodableError extends VaultReadError {
  constructor(utxoRef: string, unit: string, reason: string) {
    super(502, "THREAD_DATUM_UNDECODABLE",
      `UTxO ${utxoRef} mang NFT thread nhưng datum không đọc được thành EngageDatum.`,
      { utxo: utxoRef, asset: unit, reason });
  }
}

export class ThreadIdentityDuplicateError extends VaultReadError {
  constructor(unit: string, utxoRefs: string[]) {
    super(409, "THREAD_IDENTITY_DUPLICATE",
      `Hai UTxO cùng mang NFT thread ${unit.slice(0, 24)}… — bất khả trên sổ cái đã lắng. ` +
      `Chỉ mục đang ở trạng thái không nhất quán; không chọn hộ.`,
      { asset: unit, utxos: utxoRefs });
  }
}
