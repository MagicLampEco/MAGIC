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
