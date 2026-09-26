// VaultTxAPI/src/locks.ts — khoá mềm theo `owner_pkh`, chống hai giao dịch giành một UTxO.
//
// ── VẤN ĐỀ THẬT, KHÔNG PHẢI PHÒNG XA ────────────────────────────────────────────
// Mỗi chủ có một UTxO vault. Dựng một giao dịch nghĩa là CHỌN đúng UTxO đó làm input.
// Hai yêu cầu tới gần nhau cho cùng `owner_pkh` sẽ chọn TRÙNG input, và eUTXO chỉ cho
// một trong hai lên chuỗi. Cái thua không hỏng lúc dựng — nó hỏng SAU KHI người dùng
// đã ký, và thông báo của chuỗi lúc đó không nhắc gì tới chuyện có hai giao dịch.
//
// ── VÌ SAO KHOÁ GIỮ TỚI LÚC NỘP, KHÔNG NHẢ NGAY SAU KHI DỰNG ───────────────────
// Nhả ngay sau khi dựng thì không chặn được gì: UTxO vault vẫn chưa bị tiêu, nên yêu
// cầu thứ hai vẫn chọn đúng nó. Khoá phải sống từ lúc dựng tới lúc `/tx/submit` nhận
// đúng giao dịch ấy — hoặc tới lúc hết hạn, cho ca người dùng đóng app giữa chừng.
//
// ── VÌ SAO KHOÁ TRONG BỘ NHỚ LÀ ĐỦ, VÀ NÓ KHÔNG ĐỦ Ở ĐÂU ──────────────────────
// Một tiến trình ⟹ một bảng khoá. Chạy hai bản sao sau một bộ cân tải thì hai bảng
// không thấy nhau và khoá không còn nghĩa. Đó là giới hạn ĐÃ BIẾT, ghi ở README §"Còn
// thiếu" — không phải thứ tệp này giả vờ giải quyết.

import { OwnerTxInFlightError } from "./errors.js";

export interface LockRecord {
  ownerPkh: string;
  /** Hash thân giao dịch đang giữ khoá — `/tx/submit` nhả khoá bằng chính hash này. */
  txHash: string;
  expiresAtMs: number;
}

export class OwnerLockTable {
  private readonly held = new Map<string, LockRecord>();

  constructor(private readonly ttlMs: number) {}

  /**
   * Giành quyền dựng cho một chủ.
   *
   * KHÔNG trả `false` và KHÔNG trả `null`: một giá trị đệm ở đây sẽ đi tiếp vào đường
   * dựng và ra một giao dịch thứ hai. Bận thì NÉM, và ném đúng mã 409.
   */
  acquire(ownerPkh: string, nowMs: number): void {
    const cur = this.held.get(ownerPkh);
    if (cur !== undefined && cur.expiresAtMs > nowMs) {
      throw new OwnerTxInFlightError(ownerPkh, cur.txHash, new Date(cur.expiresAtMs).toISOString());
    }
    // Chỗ giữ chỗ: hash thật chỉ biết sau khi dựng xong. Giữ chỗ TRƯỚC là thứ đóng khe
    // đua giữa hai yêu cầu vào cùng lúc — đăng ký sau khi dựng thì cả hai đã dựng rồi.
    this.held.set(ownerPkh, { ownerPkh, txHash: PENDING_TX_HASH, expiresAtMs: nowMs + this.ttlMs });
  }

  /** Gắn hash thật vào khoá vừa giành, sau khi đã dựng xong. */
  bindTxHash(ownerPkh: string, txHash: string): void {
    const cur = this.held.get(ownerPkh);
    if (cur === undefined) return;
    this.held.set(ownerPkh, { ...cur, txHash });
  }

  /** Nhả khoá khi dựng HỎNG — nếu không, một lần lỗi khoá chủ đó lại suốt thời hạn. */
  release(ownerPkh: string): void {
    this.held.delete(ownerPkh);
  }

  /**
   * Nhả khoá theo hash giao dịch vừa nộp. Trả về `owner_pkh` đã nhả, hoặc `null` khi
   * không có khoá nào mang hash đó.
   *
   * `null` ở đây KHÔNG phải giá trị đệm che lỗi: nó là một câu trả lời thật và bình
   * thường (nộp lại một tx đã nhả khoá, hoặc tx dựng từ tiến trình khác). Người gọi
   * dùng nó để ghi nhật ký, không dùng nó để quyết định có nộp hay không.
   */
  releaseByTxHash(txHash: string): string | null {
    for (const [owner, rec] of this.held) {
      if (rec.txHash === txHash) {
        this.held.delete(owner);
        return owner;
      }
    }
    return null;
  }

  /** Khoá đang giữ của một chủ, hoặc `null`. Dùng cho `/health` và phép kiểm. */
  peek(ownerPkh: string, nowMs: number): LockRecord | null {
    const cur = this.held.get(ownerPkh);
    if (cur === undefined) return null;
    if (cur.expiresAtMs <= nowMs) return null;
    return cur;
  }

  /** Dọn khoá đã hết hạn. Gọi theo nhịp, hoặc không gọi — `acquire`/`peek` đã tự bỏ qua
   *  khoá hết hạn, nên đây chỉ là chuyện giải phóng bộ nhớ. */
  sweep(nowMs: number): number {
    let n = 0;
    for (const [owner, rec] of this.held) {
      if (rec.expiresAtMs <= nowMs) { this.held.delete(owner); n++; }
    }
    return n;
  }

  size(): number {
    return this.held.size;
  }
}

/** Hash giữ chỗ giữa lúc giành khoá và lúc dựng xong. Không phải hash hợp lệ (64 hex),
 *  nên nó không bao giờ khớp `releaseByTxHash` của một giao dịch thật. */
export const PENDING_TX_HASH = "pending";

/**
 * Sổ hash thân của những giao dịch mà CHÍNH dịch vụ này đã phát ra.
 *
 * ── VÌ SAO NÓ TỒN TẠI ─────────────────────────────────────────────────────────
 * `/tx/submit` nộp lên chuỗi bằng khoá nhà cung cấp của người vận hành. Không có sổ
 * này thì nó nhận `tx_cbor` BẤT KỲ và nộp: hạn mức của người vận hành thành cổng nộp
 * công cộng, mọi quy kết lạm dụng rơi vào dự án của người vận hành, và người nộp thật
 * đứng sau IP lẫn khoá của người vận hành. Đường vào đó không đòi hỏi gì ngoài thẻ bài
 * mà mọi bản app đều có.
 *
 * ── VÌ SAO KHÔNG DÙNG LUÔN `OwnerLockTable` ───────────────────────────────────
 * Bảng khoá XOÁ dòng ngay khi nộp xong, nên một lần nộp lại vì rớt mạng sẽ bị từ chối
 * bởi đúng cổng vừa dựng lên để chặn người lạ. Sổ này giữ dòng tới khi hết hạn, nên
 * nộp lại cùng một giao dịch vẫn đi qua; chuỗi tự lo phần trùng lặp.
 *
 * ── NÓ KHÔNG PHẢI CÁI GÌ ──────────────────────────────────────────────────────
 * Nó KHÔNG trả lời câu "người gọi có quyền với `owner_pkh` này không" — câu đó chưa có
 * cổng nào trong dịch vụ, xem `DevStatus.md` ▸ Nợ #78. Nó chỉ trả lời "giao dịch này
 * có phải do tôi dựng không". Và như bảng khoá, nó nằm trong bộ nhớ MỘT tiến trình:
 * chạy hai bản sao sau bộ cân tải thì mỗi bản chỉ nhận lại giao dịch của chính nó.
 */
/** Tên đường dựng đã phát ra một giao dịch — khoá tra bảng mục đích Feecover (`feeProxy.ts`). */
export type IssuedRoute =
  "create-vault" | "instant-gen" | "schedule-commit" | "schedule-fire" | "consume" | "open-thread";

export const ISSUED_ROUTES: readonly IssuedRoute[] =
  ["create-vault", "instant-gen", "schedule-commit", "schedule-fire", "consume", "open-thread"];

/**
 * Điều sổ phát-hành biết về một giao dịch, ngoài hash thân của nó.
 *
 * `/fee/sign` KHÔNG nhận `purpose` hay `ref` từ app: nó lấy cả hai từ đây. App chỉ đưa CBOR,
 * nên nó không giả được mục đích (xin ký một tx tạo vault dưới mục đích tiêu MAGIC) cũng không
 * giả được mã ghi sổ của Feecover.
 */
export interface IssuedTxMeta {
  route: IssuedRoute;
  /** Mã ghi sổ Feecover khi nó KHÔNG phải hash thân tx: create-vault ⟹ tên NFT vault (64 hex),
   *  open-thread ⟹ tên NFT thread (64 hex). Vắng ⟹ hash thân tx. */
  feeRef?: string;
  /** UTxO ví trả phí (`txhash#idx`) mà tx tiêu. Vắng ⟹ tx không có ví trả phí bên thứ ba. */
  feePayerUtxo?: string;
}

export interface IssuedTxEntry extends IssuedTxMeta {
  /** Hết mốc này thì `/tx/submit` không nhận nữa. */
  expiresAtMs: number;
  /** Hết mốc này thì `/fee/sign` không xin chữ ký nữa: UTxO phí đã hết giờ giữ chỗ ở Feecover. */
  signableUntilMs: number;
}

export class IssuedTxRegistry {
  private readonly issued = new Map<string, IssuedTxEntry>();
  /** UTxO ví trả phí phát qua `/fee/utxo` → hết giờ giữ chỗ (`reserved_until`) ở Feecover. */
  private readonly feeReservations = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  /**
   * Ghi một giao dịch vừa phát.
   *
   * Tx tiêu một UTxO phí đã được giữ chỗ qua `/fee/utxo` thì dòng của nó xin ký được tới ĐÚNG
   * `reserved_until` rồi thôi — sau mốc đó Feecover có thể đã giao UTxO ấy cho tx khác, và xin
   * ký tiếp là xin ký một tx tiêu đồ của người khác. Dòng vẫn sống ít nhất tới `reserved_until`
   * (kể cả khi TTL của sổ ngắn hơn), để lượt ký kịp trong giờ giữ chỗ không bị sổ đánh rơi.
   * UTxO phí không qua `/fee/utxo` (app tự đưa) ⟹ hạn ký = hạn của sổ.
   */
  record(txHash: string, nowMs: number, meta: IssuedTxMeta): void {
    const ttlExpiry = nowMs + this.ttlMs;
    const reserved = meta.feePayerUtxo === undefined ? undefined : this.feeReservations.get(meta.feePayerUtxo);
    this.issued.set(txHash, {
      ...meta,
      expiresAtMs: reserved === undefined ? ttlExpiry : Math.max(ttlExpiry, reserved),
      signableUntilMs: reserved === undefined ? ttlExpiry : reserved,
    });
  }

  /** Ghi giờ giữ chỗ của một UTxO phí vừa phát qua `/fee/utxo`. */
  noteFeeReservation(utxoRef: string, reservedUntilMs: number): void {
    this.feeReservations.set(utxoRef, reservedUntilMs);
  }

  /** `true` khi dịch vụ này đã phát ra đúng giao dịch đó và dòng chưa hết hạn. */
  wasIssued(txHash: string, nowMs: number): boolean {
    return this.lookup(txHash, nowMs) !== null;
  }

  /** Dòng của giao dịch, hoặc `null` khi không có / đã hết hạn nộp. */
  lookup(txHash: string, nowMs: number): IssuedTxEntry | null {
    const e = this.issued.get(txHash);
    if (e === undefined) return null;
    if (e.expiresAtMs <= nowMs) { this.issued.delete(txHash); return null; }
    return e;
  }

  sweep(nowMs: number): number {
    let n = 0;
    for (const [h, e] of this.issued) {
      if (e.expiresAtMs <= nowMs) { this.issued.delete(h); n++; }
    }
    for (const [u, until] of this.feeReservations) {
      if (until <= nowMs) this.feeReservations.delete(u);
    }
    return n;
  }

  size(): number {
    return this.issued.size;
  }
}
