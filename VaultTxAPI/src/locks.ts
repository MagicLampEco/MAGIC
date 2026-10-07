// VaultTxAPI/src/locks.ts — khoá mềm theo chủ: lượt dựng MỚI NHẤT thay lượt cũ; xung đột bắt
// ở lúc NỘP, không ở lúc dựng.
//
import { randomBytes } from "node:crypto";

import { TxExpiredError } from "./errors.js";
import { CLOCK_SKEW_MARGIN_MS, feeReservationError } from "./validity.js";

/** Dòng sổ phát-hành quá hạn nộp còn nằm lại bấy lâu để `/tx/submit` trả 410 `TX_EXPIRED` (thay vì
 *  "không do dịch vụ phát"). Một giờ: đủ cho app nộp muộn sau khi người dùng bỏ dở màn ký. */
export const EXPIRED_RETENTION_MS = 3_600_000;
//
// ── VẤN ĐỀ THẬT, KHÔNG PHẢI PHÒNG XA ────────────────────────────────────────────
// Mỗi chủ có một UTxO vault. Dựng một giao dịch nghĩa là CHỌN đúng UTxO đó làm input.
// Hai giao dịch dựng gần nhau cho cùng chủ sẽ chọn TRÙNG input, và eUTXO chỉ cho một trong
// hai lên chuỗi. Cái thua hỏng SAU KHI người dùng đã ký.
//
// ── VÌ SAO KHÔNG CÒN 409 Ở LÚC DỰNG (đổi 2026-10-03, thư OriLife `ol1003mg-d`) ──
// Bản cũ chặn lượt dựng thứ hai bằng `409 OWNER_TX_IN_FLIGHT` suốt 180 giây. Ba dữ kiện làm
// nó thành một cổng từ chối dịch vụ:
//   · chủ (`owner` pkh / script hash) là CÔNG KHAI trên chuỗi;
//   · dựng giao dịch KHÔNG cần chữ ký của chủ;
//   · cả dịch vụ có MỘT thẻ Bearer dùng chung (`VAULT_TX_API_TOKEN`) — "khoá theo người gọi"
//     không có người gọi nào để phân biệt.
// ⟹ ai có thẻ (mọi bản app) gọi lặp là khoá két của người khác vô thời hạn.
//
// Luật mới: lượt dựng mới cho một khoá KHÔNG BAO GIỜ nhận 409 vì một lượt dựng khác. Nó lấy
// khoá; lượt cũ bị THAY, và mọi khoá phụ mà lượt cũ còn giữ (khoá UTxO quỹ / UTxO phí ở
// `sponsor.ts`) nhả ngay. Xung đột thật được bắt ở `/tx/submit`:
//   · tx có input đã bị một tx KHÁC vừa nộp tiêu (`PendingSpends.conflicts`) ⟹ 409 `TX_SUPERSEDED`;
//   · tx phát ra TRƯỚC khi một tx khác chung khoá được nộp (`IssuedTxRegistry.markSubmitted`)
//     ⟹ 409 `TX_SUPERSEDED` — bắt cả hai tx không chung input (hai lượt tạo két từ hai ví).
//
// Vì sao an toàn: người lạ KHÔNG ký được cho chủ, nên tx họ dựng không bao giờ lên chuỗi và
// không bao giờ "được nộp" — nó không thay được tx nào của chủ ở lúc nộp. Lượt dựng của chủ
// luôn đi tiếp. Hai thiết bị của CÙNG chủ dựng song song thì cái nộp TRƯỚC thắng, cái kia nhận
// `TX_SUPERSEDED` ở lúc nộp thay vì ở lúc dựng.
//
// 🔴 Cố ý KHÔNG từ chối nộp chỉ vì tx đã bị một lượt DỰNG sau thay: làm thế thì người lạ dựng
// lặp sau mỗi lượt dựng của chủ là tx của chủ luôn bị từ chối lúc nộp — đúng cổng từ chối dịch
// vụ vừa gỡ, chỉ dời từ lúc dựng sang lúc nộp. Mốc "bị thay" phải là một lượt NỘP (cần chữ ký
// chủ), không phải một lượt DỰNG (không cần gì).
//
// ── VÌ SAO KHOÁ TRONG BỘ NHỚ LÀ ĐỦ, VÀ NÓ KHÔNG ĐỦ Ở ĐÂU ──────────────────────
// Một tiến trình ⟹ một bảng khoá + một sổ. Chạy hai bản sao sau một bộ cân tải thì chúng
// không thấy nhau. Đó là giới hạn ĐÃ BIẾT, ghi ở README §"Còn thiếu".

export interface LockRecord {
  ownerPkh: string;
  /** Hash thân giao dịch đang giữ khoá — `/tx/submit` nhả khoá bằng chính hash này. */
  txHash: string;
  expiresAtMs: number;
  /** Thế hệ của lượt giành khoá — `acquire` trả nó, `bindTxHash`/`release` phải đưa lại. */
  gen: number;
}

export class OwnerLockTable {
  private readonly held = new Map<string, LockRecord>();
  private nextGen = 1;

  constructor(private readonly ttlMs: number) {}

  /**
   * Giành khoá cho một lượt dựng. KHÔNG BAO GIỜ ném vì một lượt dựng khác (xem đầu tệp): khoá
   * đang sống của lượt cũ bị THAY. Lượt cũ đã dựng xong (mang hash thật) thì mọi khoá KHÁC nó
   * còn giữ nhả luôn — chúng là chỗ giữ của một tx đã bị thay, giữ tiếp chỉ để chặn suông.
   * Lượt cũ còn đang dựng thì thẻ `gen` của nó không còn khớp ⟹ `bindTxHash`/`release` của nó
   * không đụng được khoá của lượt mới.
   */
  acquire(ownerPkh: string, nowMs: number): number {
    const cur = this.held.get(ownerPkh);
    if (cur !== undefined && cur.expiresAtMs > nowMs && cur.txHash !== PENDING_TX_HASH) {
      for (const [k, rec] of this.held) {
        if (k !== ownerPkh && rec.txHash === cur.txHash) this.held.delete(k);
      }
    }
    // Chỗ giữ chỗ: hash thật chỉ biết sau khi dựng xong.
    const gen = this.nextGen++;
    this.held.set(ownerPkh, { ownerPkh, txHash: PENDING_TX_HASH, expiresAtMs: nowMs + this.ttlMs, gen });
    return gen;
  }

  /**
   * Gắn hash thật vào khoá vừa giành, sau khi đã dựng xong.
   *
   * `gen` là thẻ mà `acquire` trả. Một lượt dựng chậm quá TTL thì khoá của nó đã hết hạn và
   * có thể đã bị lượt SAU giành lại; không có thẻ, lượt chậm gắn hash của nó đè lên khoá
   * của lượt sau (hoặc `release` nhả mất khoá của lượt sau), và lượt thứ ba lại dựng trên
   * đúng UTxO vault đó. Thẻ lệch ⟹ không làm gì. Vắng thẻ ⟹ hành vi cũ, chỉ để giữ tương
   * thích cho mã gọi ngoài dịch vụ.
   */
  bindTxHash(ownerPkh: string, txHash: string, gen?: number): void {
    const cur = this.held.get(ownerPkh);
    if (cur === undefined) return;
    if (gen !== undefined && cur.gen !== gen) return;
    this.held.set(ownerPkh, { ...cur, txHash });
  }

  /** Nhả khoá khi dựng HỎNG — nếu không, một lần lỗi khoá chủ đó lại suốt thời hạn.
   *  `gen` như ở `bindTxHash`: thẻ lệch ⟹ khoá đó của lượt khác, không nhả. */
  release(ownerPkh: string, gen?: number): void {
    const cur = this.held.get(ownerPkh);
    if (cur === undefined) return;
    if (gen !== undefined && cur.gen !== gen) return;
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
    // Nhả MỌI khoá mang hash đó: một tx có thể giữ hơn một khoá (T2 tài trợ giữ khoá chủ + khoá
    // UTxO quỹ dùng chung — `sponsor.ts`). Trả khoá giành TRƯỚC (thứ tự chèn của Map) — với tx một
    // khoá thì y như cũ.
    let first: string | null = null;
    for (const [owner, rec] of this.held) {
      if (rec.txHash === txHash) {
        this.held.delete(owner);
        if (first === null) first = owner;
      }
    }
    return first;
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

/**
 * Input của những giao dịch vừa nộp mà có thể CHƯA vào khối.
 *
 * `/tx/submit` nhả khoá của chủ ngay khi nút nhận giao dịch. Nhưng nút đọc UTxO (Blockfrost)
 * chỉ thấy input bị tiêu khi giao dịch đã vào khối — khoảng 20 giây tới vài phút. Trong khe
 * đó một lượt dựng mới đọc lại ĐÚNG UTxO vừa tiêu, dựng xong, người dùng ký, và chuỗi từ chối
 * vì input không còn. Sổ này giữ các input đó tới hết hạn để đường dựng từ chối SỚM (409) và
 * để bộ dựng không chọn lại chúng làm input trả phí.
 *
 * Hết hạn mà giao dịch vẫn chưa vào khối (bị rơi khỏi mempool) thì UTxO cũ dùng lại được —
 * đúng, vì nó thật sự chưa bị tiêu.
 */
export class PendingSpends {
  /** input → hạn + hash thân của tx đã tiêu nó (vắng khi bên ghi không khai). */
  private readonly spent = new Map<string, { until: number; txHash?: string }>();

  constructor(private readonly ttlMs: number) {}

  /** Ghi các input (`txhash#idx`) của một giao dịch vừa nộp thành công. `txHash` = hash thân
   *  của chính tx đó — để lần NỘP LẠI cùng tx (rớt mạng) không bị coi là xung đột với chính nó. */
  note(refs: readonly string[], nowMs: number, txHash?: string): void {
    for (const r of refs) this.spent.set(r, { until: nowMs + this.ttlMs, ...(txHash === undefined ? {} : { txHash }) });
  }

  has(ref: string, nowMs: number): boolean {
    const e = this.spent.get(ref);
    if (e === undefined) return false;
    if (e.until <= nowMs) { this.spent.delete(ref); return false; }
    return true;
  }

  /**
   * Những input trong `refs` đang bị một tx KHÁC `txHash` vừa nộp tiêu. Dòng ghi không kèm hash
   * (bên ghi không khai) tính là KHÁC — không biết thì coi là xung đột, đừng đoán là chính nó.
   */
  conflicts(refs: readonly string[], nowMs: number, txHash: string): string[] {
    return refs.filter(r => this.has(r, nowMs) && this.spent.get(r)!.txHash !== txHash);
  }

  sweep(nowMs: number): number {
    let n = 0;
    for (const [r, e] of this.spent) {
      if (e.until <= nowMs) { this.spent.delete(r); n++; }
    }
    return n;
  }

  size(): number {
    return this.spent.size;
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
 *
 * ── HẠN CỦA MỘT DÒNG = `validTo` CỦA CHÍNH TX ĐÓ (đổi 2026-10-06) ───────────────
 * Bản cũ cho mọi dòng sống `4 × lock_ttl_ms` kể từ lúc phát — một con số không dính gì tới hạn
 * thật của tx (thân tx có thể còn hiệu lực 1 giờ, hoặc đã hết từ cuối epoch). Nay `record` NHẬN
 * `validToMs` đọc từ thân tx (`validity.ts` ▸ `readTxExpiry`) và dòng hết hạn đúng tại đó, cộng
 * `CLOCK_SKEW_MARGIN_MS` cho lệch đồng hồ với nút. Quá mốc, dòng chưa bị xoá ngay: nó nằm lại
 * `EXPIRED_RETENTION_MS` để `/tx/submit` trả 410 `TX_EXPIRED` kèm `rebuild_safe` đúng (tx này đã
 * từng gửi tới nút chưa), thay vì 502 "không do dịch vụ dựng" — câu đó sai với tx của chính mình.
 */
/** Tên đường dựng đã phát ra một giao dịch — khoá tra bảng mục đích Feecover (`feeProxy.ts`). */
export type IssuedRoute =
  | "create-vault" | "instant-gen" | "refresh-checkpoint" | "schedule-commit" | "schedule-fire" | "consume"
  | "open-thread" | "bind-did";

export const ISSUED_ROUTES: readonly IssuedRoute[] = [
  "create-vault", "instant-gen", "refresh-checkpoint", "schedule-commit", "schedule-fire", "consume",
  "open-thread", "bind-did",
];

/**
 * Điều sổ phát-hành biết về một giao dịch, ngoài hash thân của nó.
 *
 * `/fee/sign` KHÔNG nhận `purpose` hay `ref` từ app: nó lấy cả hai từ đây. App chỉ đưa CBOR,
 * nên nó không giả được mục đích (xin ký một tx tạo vault dưới mục đích tiêu MAGIC) cũng không
 * giả được mã ghi sổ của Feecover.
 */
/**
 * Route tài trợ (`sponsor.ts`). Tách khỏi `IssuedRoute` có chủ đích: `IssuedRoute`/`ISSUED_ROUTES`
 * là tập đường dựng của `/tx/quote`, còn bốn route này không báo giá. Sổ phát-hành vẫn phải ghi
 * chúng — không ghi thì `/tx/submit` từ chối nộp tx mà chính dịch vụ vừa dựng.
 */
export type SponsorRoute = "sponsor-t1-open" | "sponsor-t2-fund" | "sponsor-t3-draw" | "sponsor-t4-first-consume";

export const SPONSOR_ROUTES: readonly SponsorRoute[] = [
  "sponsor-t1-open", "sponsor-t2-fund", "sponsor-t3-draw", "sponsor-t4-first-consume",
];

/**
 * Khoá của bảng mục đích Feecover (`feecover.apps.*.purposes`, `feeProxy.ts ▸ purposeFor`): mọi
 * đường dựng nhận `fee_payer`, gồm cả bốn bước tài trợ. Rộng hơn `ISSUED_ROUTES` vì bảng mục đích
 * hỏi "Feecover trả phí cho đường nào", còn `ISSUED_ROUTES` hỏi "`/tx/quote` báo giá được đường
 * nào". Route có trong tập này mà app chưa khai mục đích ⟹ vẫn 400 `FEE_PROXY_PURPOSE_UNMAPPED`.
 */
export type FeePurposeRoute = IssuedRoute | SponsorRoute;
export const FEE_PURPOSE_ROUTES: readonly FeePurposeRoute[] = [...ISSUED_ROUTES, ...SPONSOR_ROUTES];

export interface IssuedTxMeta {
  route: IssuedRoute | SponsorRoute;
  /** Mã ghi sổ Feecover khi nó KHÔNG phải hash thân tx: create-vault ⟹ tên NFT vault (64 hex),
   *  open-thread ⟹ tên NFT thread (64 hex). Vắng ⟹ hash thân tx. */
  feeRef?: string;
  /** UTxO ví trả phí (`txhash#idx`) mà tx tiêu. Vắng ⟹ tx không có ví trả phí bên thứ ba. */
  feePayerUtxo?: string;
  /** Mã lượt giữ mà app gửi kèm `fee_payer.reservation_id` lúc dựng. Vắng ⟹ `record` ghi mã của lượt
   *  giữ ĐANG SỐNG của `feePayerUtxo` lúc ghi sổ (bước 1, app chưa gửi). `/fee/sign` so mã này với mã
   *  lượt giữ đang sống lúc ký (`feeSignProblem`). */
  feeReservationId?: string;
  /** Khoá mềm mà lượt dựng đã giữ (`ownerLockKey(owner)`, khoá UTxO quỹ/phí của `sponsor.ts`).
   *  Một tx chung khoá với tx vừa NỘP thì bị thay (`markSubmitted`). Vắng ⟹ không bị thay theo
   *  khoá, chỉ còn phép xung đột input (`PendingSpends.conflicts`). */
  lockKeys?: readonly string[];
  /** `validTo` (POSIX ms) đọc từ CHÍNH thân tx — nguồn hạn duy nhất của dòng (`validity.ts`). */
  validToMs: number;
}

export interface IssuedTxEntry extends IssuedTxMeta {
  /** Hết mốc này thì `/tx/submit` không nhận nữa: `validToMs + CLOCK_SKEW_MARGIN_MS`. */
  expiresAtMs: number;
  /** Hết mốc này thì `/fee/sign` không xin chữ ký nữa: UTxO phí đã hết giờ giữ chỗ ở Feecover. */
  signableUntilMs: number;
  /** Hash thân của tx chung khoá đã được NỘP sau khi tx này phát ra ⟹ `/tx/submit` và
   *  `/fee/sign` trả 409 `TX_SUPERSEDED`. Vắng ⟹ chưa bị thay. Áp CẢ cho tx đã nộp trước đó: tx đã
   *  nộp mà rơi khỏi mempool, rồi bị một tx chung khoá nộp sau thay, thì nộp lại nó là đúng ca hai
   *  lượt tạo két từ hai ví (đầu tệp) — két thứ hai cho cùng chủ. */
  supersededBy?: string;
  /** Mốc nút chuỗi NHẬN tx (trả đúng hash thân). Có mốc ⟹ `/tx/submit` lần sau trả lại kết quả cũ,
   *  KHÔNG gửi lên chuỗi lần nữa (`submittedResult`). */
  submittedAtMs?: number;
  /** Mốc dịch vụ ĐÃ GỬI tx tới nút mà không nhận được xác nhận: mất kết nối / quá giờ, hoặc nút báo
   *  một hash khác. Tx có thể đang ở mempool. Lượt nộp lại vẫn GỬI (không biết lượt đầu tới chưa),
   *  nhưng không được đối xử như tx chưa từng gửi: việc thay tx chung khoá đã làm ở lượt đầu. */
  submitUnconfirmedAtMs?: number;
  /** Kết quả lượt nộp được nút nhận — trả lại nguyên vẹn cho lượt nộp lại. */
  submittedResult?: { lockReleasedFor: string | null };
}

/** Trạng thái gửi của một tx trong sổ, đọc ra cho bên gọi (`details.submission` của 409). */
export type SubmissionState = "accepted" | "unconfirmed" | "none";

export function submissionStateOf(e: IssuedTxEntry): SubmissionState {
  if (e.submittedAtMs !== undefined) return "accepted";
  if (e.submitUnconfirmedAtMs !== undefined) return "unconfirmed";
  return "none";
}

/** 410 `TX_EXPIRED` cho một tx ĐÃ phát mà nay quá hạn nộp (`IssuedTxRegistry.expiredEntry`) — MỘT chỗ
 *  dựng cho cả `/tx/submit` lẫn `/fee/sign`, để hai đường trả cùng `details` (`expired_at` = `validTo`
 *  dạng ISO 8601, `rebuild_safe`, `submission`). `null` ⟹ tx chưa từng phát, hoặc dòng đã quá
 *  `EXPIRED_RETENTION_MS`: bên gọi giữ mã lỗi cũ của đường mình. */
export function expiredErrorFor(issued: IssuedTxRegistry, txHash: string, nowMs: number): TxExpiredError | null {
  const e = issued.expiredEntry(txHash, nowMs);
  if (e === null) return null;
  return new TxExpiredError(txHash, new Date(e.validToMs).toISOString(), submissionStateOf(e));
}

// ── MÃ LƯỢT GIỮ (`reservation_id`, 2026-10-07, thư SuperApp `sa1007mg-rid`) ─────────────────────
// Sổ giữ chỗ khoá theo UTxO, không theo NGƯỜI giữ — và mọi bản app đi chung một thẻ dịch vụ, nên dịch
// vụ không có "người gọi" nào để phân biệt. Feecover giao lại cùng UTxO cho B thì A, còn cầm `fee_payer`
// cũ, vẫn dựng được trên lượt giữ của B và `/fee/sign` vẫn xin ký cho A. Vá: mỗi lượt `/fee/utxo` sinh
// một mã ngẫu nhiên 128 bit, lưu cạnh lượt giữ và trả ở `fee_payer.reservation_id`. Feecover giao lại
// UTxO ⟹ lượt giữ mới ⟹ mã mới. Người không qua lượt `/fee/utxo` đó không biết mã.
//   · route dựng: `fee_payer.reservation_id` có mặt mà khác mã lượt giữ đang sống ⟹ 409 `foreign`;
//     vắng ⟹ hành vi cũ (BƯỚC 1) và được ĐẾM (`reservationIdStats`) để đo tỉ lệ thiếu trước BƯỚC 2;
//   · `/fee/sign`: app không gửi gì thêm — sổ phát-hành đã ghi mã lúc dựng, so với mã đang sống.
// Mã KHÔNG phải bí mật dài hạn: nó chỉ có nghĩa trong đời một lượt giữ (vài phút).

/** Nguồn trả phí Feecover ký (`/v1/utxo` + `/v1/sign` ▸ `source`): ví Feecover (app trả CARP) hoặc
 *  ngân sách tài trợ L38 (người dùng không trả gì). `owner_address` KHÔNG ở đây — ví của chủ tự ký,
 *  không qua Feecover. */
export const FEE_SOURCES = ["feecover", "sponsor"] as const;
export type FeeSource = typeof FEE_SOURCES[number];

/** Một lượt giữ UTxO phí: hết giờ (`reserved_until`, POSIX ms) + mã lượt giữ + nguồn Feecover xác nhận
 *  lúc phát (`/fee/sign` từ chối một `source` khác nguồn này). */
interface FeeReservation { untilMs: number; id: string; source: FeeSource }

/** Mã lượt giữ mới: 16 byte ngẫu nhiên mật mã ⟹ 32 hex (`feePayer.ts` ▸ `RESERVATION_ID`). */
export function newReservationId(): string {
  return randomBytes(16).toString("hex");
}

/** Bộ đếm lượt dựng tiêu UTxO Feecover đang giữ chỗ, theo route: có / thiếu `reservation_id`. */
export interface ReservationIdStats { with_id: Record<string, number>; without_id: Record<string, number> }

export class IssuedTxRegistry {
  private readonly issued = new Map<string, IssuedTxEntry>();
  /** UTxO ví trả phí phát qua `/fee/utxo` → lượt giữ (hết giờ ở Feecover + mã lượt giữ). */
  private readonly feeReservations = new Map<string, FeeReservation>();
  private readonly ridWith = new Map<string, number>();
  private readonly ridWithout = new Map<string, number>();

  /** `log` nhận MỘT dòng JSON cho mỗi lượt dựng Feecover thiếu `reservation_id`. Vắng ⟹ `console.error`
   *  (cùng luồng với nhật ký yêu cầu của `server.ts`). */
  constructor(private readonly log: (line: string) => void = l => console.error(l)) {}
  /** Địa chỉ ví trả phí Feecover đã trả qua `/fee/utxo`. KHÔNG dọn: nó là thứ cho biết một UTxO là của
   *  Feecover sau khi lượt giữ của nó đã bị quét (`feeReservationForBuild`). Tập nhỏ, đổi chậm. */
  private readonly feecoverAddresses = new Set<string>();

  /**
   * Ghi một giao dịch vừa phát.
   *
   * Tx tiêu một UTxO phí đã được giữ chỗ qua `/fee/utxo` thì dòng của nó xin ký được tới ĐÚNG
   * `reserved_until` rồi thôi — sau mốc đó Feecover có thể đã giao UTxO ấy cho tx khác, và xin
   * ký tiếp là xin ký một tx tiêu đồ của người khác. Dòng vẫn sống ít nhất tới `reserved_until`
   * (kể cả khi TTL của sổ ngắn hơn), để lượt ký kịp trong giờ giữ chỗ không bị sổ đánh rơi.
   * UTxO phí không qua `/fee/utxo` (app tự đưa) ⟹ hạn ký = hạn của dòng.
   *
   * Hạn của dòng = `meta.validToMs + CLOCK_SKEW_MARGIN_MS` — đọc từ CHÍNH thân tx, không cộng trên
   * đồng hồ dịch vụ (`validity.ts`). Hạn xin ký không vượt hạn dòng: sau mốc đó sổ cái chắc chắn
   * từ chối tx, xin ký nữa là phí một chữ ký của Feecover. `_nowMs` chỉ còn để giữ chữ ký gọi cũ.
   */
  record(txHash: string, _nowMs: number, meta: IssuedTxMeta): void {
    const expiresAtMs = meta.validToMs + CLOCK_SKEW_MARGIN_MS;
    const reserved = meta.feePayerUtxo === undefined ? undefined : this.feeReservations.get(meta.feePayerUtxo);
    // Mã lượt giữ của tx: mã app gửi (đã qua cổng dựng, nên khớp lượt giữ lúc dựng), hoặc — app chưa
    // gửi — mã của lượt giữ đang sống lúc ghi. Không có lượt giữ ⟹ vắng.
    const feeReservationId = meta.feeReservationId ?? reserved?.id;
    this.issued.set(txHash, {
      ...meta,
      ...(feeReservationId === undefined ? {} : { feeReservationId }),
      expiresAtMs,
      signableUntilMs: reserved === undefined ? expiresAtMs : Math.min(reserved.untilMs, expiresAtMs),
    });
  }

  /** Ghi một lượt giữ UTxO phí vừa phát qua `/fee/utxo` và trả MÃ lượt giữ (mới mỗi lượt — Feecover
   *  giao lại cùng UTxO thì lượt sau có mã khác). `address` = địa chỉ Feecover trả kèm; sổ nhớ nó (không
   *  dọn) để nhận ra UTxO của Feecover cả khi lượt giữ đã bị quét (`feeReservationForBuild`). `id` chỉ để
   *  phép kiểm ghim một mã biết trước; dịch vụ không truyền. */
  noteFeeReservation(
    utxoRef: string, reservedUntilMs: number, address?: string, id: string = newReservationId(), source: FeeSource = "feecover",
  ): string {
    this.feeReservations.set(utxoRef, { untilMs: reservedUntilMs, id, source });
    if (address !== undefined) this.feecoverAddresses.add(address);
    return id;
  }

  /** Giờ giữ chỗ (`reserved_until`, POSIX ms) của một UTxO phí phát qua `/fee/utxo`, hoặc `undefined`
   *  khi sổ không có dòng (app tự đưa, hoặc đã bị dọn). Chỉ để TRA; lập hạn lúc dựng dùng
   *  `feeReservationForBuild` — `undefined` ở đây KHÔNG có nghĩa "không ràng buộc". */
  feeReservationOf(utxoRef: string): number | undefined {
    return this.feeReservations.get(utxoRef)?.untilMs;
  }

  /** Nguồn của lượt giữ đang có trong sổ cho `utxoRef`, hoặc `undefined`. Chỉ để TRA. */
  feeReservationSourceOf(utxoRef: string): FeeSource | undefined {
    return this.feeReservations.get(utxoRef)?.source;
  }

  /** Mã lượt giữ đang có trong sổ cho `utxoRef`, hoặc `undefined`. Chỉ để TRA. */
  feeReservationIdOf(utxoRef: string): string | undefined {
    return this.feeReservations.get(utxoRef)?.id;
  }

  /** Bộ đếm có / thiếu `reservation_id` theo route, từ lúc tiến trình khởi động (`/health`). */
  reservationIdStats(): ReservationIdStats {
    return { with_id: Object.fromEntries(this.ridWith), without_id: Object.fromEntries(this.ridWithout) };
  }

  /**
   * Giờ giữ chỗ làm cận `validTo` cho một lượt DỰNG tiêu UTxO ví trả phí `utxoRef` ở `address`.
   *
   * Sổ có lượt giữ ⟹ trả nó (`planValidity` kẹp vào đó, hoặc 409 `expired` khi nó đã qua).
   * Sổ KHÔNG có lượt giữ mà `address` là địa chỉ Feecover dịch vụ đã từng phát ⟹ NÉM 409
   * `FEE_PAYER_RESERVATION_EXPIRED` (`reservation: "absent"`). Trước bản này nhánh đó trả `undefined`
   * và bộ lập hạn đọc thành "không giữ chỗ ⟹ không kẹp": bộ quét 30 s dọn lượt giữ ở `reserved_until`,
   * nên một lượt dựng lại với UTxO cũ ra tx hạn 15′ và `/fee/sign` xin ký được tới hết hạn đó — trong
   * khi Feecover có thể đã giao UTxO cho người khác. Thiếu dữ liệu của bên khác ⟹ từ chối, không lùi
   * về mặc định thoải mái.
   * Địa chỉ không phải của Feecover (ví của chính chủ, app tự ký) ⟹ `undefined`: không có giờ giữ chỗ.
   * Giới hạn: sổ nhớ địa chỉ trong bộ nhớ tiến trình — vừa khởi động lại thì chưa nhớ địa chỉ nào cho
   * tới lượt `/fee/utxo` đầu; khi đó cổng ở `/fee/sign` (`feeSignProblem`) vẫn chặn lượt xin ký.
   */
  /**
   * Cổng mã lượt giữ (`opts.reservationId` = `fee_payer.reservation_id` app gửi): có mặt mà khác mã
   * lượt giữ đang sống ⟹ 409 `foreign`; có mặt mà sổ không có lượt giữ ⟹ 409 `absent` (mã chỉ sinh ở
   * `/fee/utxo`, nên đây là UTxO Feecover dù địa chỉ chưa được nhớ). Vắng mà UTxO đang được giữ ⟹ đi
   * tiếp (BƯỚC 1) và ĐẾM theo `opts.route` + một dòng nhật ký JSON. `opts.route` vắng (báo giá) ⟹ không đếm.
   */
  feeReservationForBuild(
    utxoRef: string, address: string, opts: { reservationId?: string; route?: string } = {},
  ): number | undefined {
    const reserved = this.feeReservations.get(utxoRef);
    if (reserved !== undefined) {
      if (opts.reservationId !== undefined && opts.reservationId !== reserved.id) {
        throw feeReservationError(utxoRef, "foreign", undefined);
      }
      if (opts.route !== undefined) this.countReservationId(opts.route, utxoRef, opts.reservationId !== undefined);
      return reserved.untilMs;
    }
    if (opts.reservationId !== undefined || this.feecoverAddresses.has(address)) {
      throw feeReservationError(utxoRef, "absent", undefined);
    }
    return undefined;
  }

  private countReservationId(route: string, utxoRef: string, present: boolean): void {
    const m = present ? this.ridWith : this.ridWithout;
    m.set(route, (m.get(route) ?? 0) + 1);
    if (!present) {
      this.log(JSON.stringify({
        event: "fee_reservation_id_missing", route, fee_payer_utxo: utxoRef,
        without_id: this.ridWithout.get(route), with_id: this.ridWith.get(route) ?? 0,
      }));
    }
  }

  /**
   * Cổng giữ chỗ của `/fee/sign`, tra LẠI ở lúc ký (không dựa vào `signableUntilMs` chốt lúc ghi sổ):
   * xin Feecover ký một tx tiêu `entry.feePayerUtxo` chỉ khi sổ CÒN lượt giữ cho UTxO đó, lượt giữ
   * chưa qua, và `validTo` của tx không vượt nó. `/fee/sign` chỉ có nghĩa với UTxO của Feecover, nên
   * vắng lượt giữ ⟹ từ chối, không coi là "không ràng buộc". `null` ⟹ ký được.
   */
  feeSignProblem(entry: IssuedTxEntry, nowMs: number):
    { utxoRef: string; reservation: "absent" | "expired" | "exceeded" | "foreign"; reservedUntilMs?: number } | null {
    const utxoRef = entry.feePayerUtxo;
    if (utxoRef === undefined) return null;
    const reserved = this.feeReservations.get(utxoRef);
    if (reserved === undefined) return { utxoRef, reservation: "absent" };
    // Lượt giữ đang sống phải là ĐÚNG lượt tx được dựng trên. Tx ghi sổ khi chưa có lượt giữ nào (mã
    // vắng) mà nay UTxO đang được giữ ⟹ lượt giữ đó sinh SAU tx, cũng là của người khác.
    if (entry.feeReservationId !== reserved.id) return { utxoRef, reservation: "foreign" };
    if (reserved.untilMs <= nowMs) return { utxoRef, reservation: "expired", reservedUntilMs: reserved.untilMs };
    if (entry.validToMs > reserved.untilMs) return { utxoRef, reservation: "exceeded", reservedUntilMs: reserved.untilMs };
    return null;
  }

  /** `true` khi dịch vụ này đã phát ra đúng giao dịch đó và dòng chưa hết hạn. */
  wasIssued(txHash: string, nowMs: number): boolean {
    return this.lookup(txHash, nowMs) !== null;
  }

  /** Dòng của giao dịch, hoặc `null` khi không có / đã hết hạn nộp. */
  /**
   * Tx `txHash` vừa được NỘP thành công: mọi tx khác còn sống trong sổ, chưa bị thay, chung ít
   * nhất một khoá với nó, thì bị THAY bởi nó — và giờ giữ chỗ UTxO phí của chúng bỏ khỏi sổ,
   * để `/fee/sign` không xin ký một tx chắc chắn không lên chuỗi. Trả số tx vừa bị thay.
   *
   * Chỉ tx phát ra TRƯỚC lượt nộp này bị thay (chúng đang có trong sổ lúc gọi). Tx dựng SAU — lượt
   * kế tiếp hợp lệ của chủ — không bị đụng.
   *
   * Tx chung khoá đã từng được nộp VẪN bị thay (không có miễn trừ cho nó): miễn trừ đó mở lại đúng
   * ca hai lượt tạo két từ hai ví — T1 nộp rồi rơi khỏi mempool, T2 nộp và lên chuỗi, nộp lại T1 ⟹
   * két thứ hai cho cùng chủ, trong khi validator chưa ép mỗi DID một két. 409 cho T1 lúc đó kèm
   * `details.submission` để bên gọi biết T1 từng được gửi và đi tra chuỗi.
   *
   * Việc thay chỉ chạy ở lượt GỬI ĐẦU TIÊN của `txHash` (`outcome` là `accepted` hay `unconfirmed`
   * đều tính — tx có thể đã ở mempool thì phải coi như đã nộp). NỘP LẠI chính nó (rớt mạng, thử lại)
   * chỉ nâng trạng thái `unconfirmed` → `accepted`, không thay gì: tx dựng sau lượt gửi đầu là lượt
   * kế tiếp hợp lệ của chủ.
   */
  markSubmitted(
    txHash: string, nowMs: number,
    outcome: "accepted" | "unconfirmed" = "accepted",
    result: { lockReleasedFor: string | null } = { lockReleasedFor: null },
  ): number {
    const me = this.lookup(txHash, nowMs);
    if (me === null) return 0;
    const firstSend = me.submittedAtMs === undefined && me.submitUnconfirmedAtMs === undefined;
    if (outcome === "accepted") {
      if (me.submittedAtMs === undefined) this.issued.set(txHash, { ...me, submittedAtMs: nowMs, submittedResult: result });
    } else if (firstSend) {
      this.issued.set(txHash, { ...me, submitUnconfirmedAtMs: nowMs });
    }
    if (!firstSend) return 0;
    const keys = new Set(me.lockKeys ?? []);
    if (keys.size === 0) return 0;
    let n = 0;
    for (const [h, e] of this.issued) {
      if (h === txHash || e.supersededBy !== undefined || e.expiresAtMs <= nowMs) continue;
      if (!(e.lockKeys ?? []).some(k => keys.has(k))) continue;
      this.issued.set(h, { ...e, supersededBy: txHash });
      // Chỉ bỏ ĐÚNG lượt giữ tx đó được dựng trên: UTxO đã được Feecover giao lại (mã khác) thì lượt
      // giữ đang sống là của người khác, tx bị thay của A không được xoá nó.
      if (e.feePayerUtxo !== undefined && e.feeReservationId !== undefined
        && this.feeReservations.get(e.feePayerUtxo)?.id === e.feeReservationId) {
        this.feeReservations.delete(e.feePayerUtxo);
      }
      n++;
    }
    return n;
  }

  lookup(txHash: string, nowMs: number): IssuedTxEntry | null {
    const e = this.issued.get(txHash);
    if (e === undefined) return null;
    if (e.expiresAtMs <= nowMs) {
      if (e.expiresAtMs + EXPIRED_RETENTION_MS <= nowMs) this.issued.delete(txHash);
      return null;
    }
    return e;
  }

  /** Dòng của một tx ĐÃ phát mà nay quá hạn nộp, còn trong khoảng giữ lại `EXPIRED_RETENTION_MS` —
   *  để `/tx/submit` phân biệt "hết hạn" (410 `TX_EXPIRED`) với "không do dịch vụ phát". */
  expiredEntry(txHash: string, nowMs: number): IssuedTxEntry | null {
    const e = this.issued.get(txHash);
    if (e === undefined || e.expiresAtMs > nowMs || e.expiresAtMs + EXPIRED_RETENTION_MS <= nowMs) return null;
    return e;
  }

  sweep(nowMs: number): number {
    let n = 0;
    for (const [h, e] of this.issued) {
      if (e.expiresAtMs + EXPIRED_RETENTION_MS <= nowMs) { this.issued.delete(h); n++; }
    }
    for (const [u, r] of this.feeReservations) {
      if (r.untilMs <= nowMs) this.feeReservations.delete(u);
    }
    return n;
  }

  size(): number {
    return this.issued.size;
  }
}
