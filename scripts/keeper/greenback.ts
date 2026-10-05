// scripts/keeper/greenback.ts — phần THUẦN của bước `greenback` trong keeper: quyết định
// làm/bỏ/hỏng theo epoch, biến môi trường giao cho bước 12, và đọc kết quả bước 12.
// Không gọi mạng, không đọc đĩa — để bộ ca `keeper/test_greenback.ts` kiểm được mà không cần khoá.
//
// Vì sao bước này tồn tại: beacon GreenBack (GBB) của cụm Gen v2.0 chỉ sống
// `GREENBACK_BEACON_MAX_AGE_EPOCHS` epoch, và ScheduleGen `commit` đòi GB tuổi 0 — tức PHẢI có
// một lượt ghi trong MỖI epoch. Bước `backing` của keeper là BackingBeacon đời cũ, không chạm GBB.
//
// Keeper KHÔNG đổi con số: ghi lại đúng `gb_nanogic` và cờ `depeg` đang trên chuỗi, chỉ đẩy epoch
// (cùng khuôn với bước `backing`). Một giá trị GB là một khẳng định về thặng dư; keeper không có
// thẩm quyền đưa ra khẳng định đó.

import { beaconEpochState, aheadMessage } from "./beaconEpoch.js";

/** Sát biên CUỐI epoch: cửa sổ hiệu lực phải nằm trọn trong một epoch — cùng ngưỡng bước price. */
export const GREENBACK_END_MARGIN_MS = 15n * 60_000n;

/**
 * Sát biên ĐẦU epoch. Bước 12 dựng tx với `nowMs = Date.now() − 120 s`
 * (`deploy/12_post_greenback.ts` ▸ `VALIDITY_BACKOFF_MS`), nên trong hai phút đầu epoch nó ghi
 * epoch CŨ — trong khi keeper, đọc tip, đã thấy epoch mới và kết luận beacon "cũ". Năm phút =
 * 120 s lùi mốc + biên cho lệch đồng hồ giữa máy chạy và tip Blockfrost. Cổng thứ hai ở chính
 * bước 12 (`GB_EXPECT_EPOCH`) chặn nốt ca lệch đồng hồ lớn hơn biên này.
 */
export const GREENBACK_START_MARGIN_MS = 5n * 60_000n;

export type GreenBackDecision =
  | { action: "skip"; note: string }
  | { action: "fail"; note: string }
  | { action: "post"; note: string };

export function decideGreenBack(p: {
  beaconEpoch: bigint;
  currentEpoch: bigint;
  nowMs: bigint;
  epochStartMs: bigint;
  epochEndMs: bigint;
}): GreenBackDecision {
  const state = beaconEpochState(p.beaconEpoch, p.currentEpoch);
  if (state === "ahead") return { action: "fail", note: aheadMessage(p.beaconEpoch, p.currentEpoch) };
  if (state === "current") return { action: "skip", note: `đã ở epoch ${p.beaconEpoch}` };
  if (p.epochEndMs - p.nowMs < GREENBACK_END_MARGIN_MS) {
    return { action: "skip", note: "còn < 15 phút tới biên epoch — để lượt sau" };
  }
  if (p.nowMs - p.epochStartMs < GREENBACK_START_MARGIN_MS) {
    return { action: "skip", note: "epoch mới bắt đầu < 5 phút — bước 12 lùi mốc 120 s nên sẽ ghi epoch cũ; để lượt sau" };
  }
  return { action: "post", note: `sẽ làm mới ${p.beaconEpoch} → ${p.currentEpoch}` };
}

/** Định dạng `<txHash 64 hex>#<chỉ số>` — cùng khuôn mà sổ dùng cho out-ref. */
const BEACON_REF_RE = /^[0-9a-f]{64}#(0|[1-9][0-9]*)$/;

export function formatBeaconRef(u: { txHash: string; outputIndex: number }): string {
  const ref = `${u.txHash}#${u.outputIndex}`;
  if (!BEACON_REF_RE.test(ref)) throw new Error(`out-ref beacon GBB sai dạng: "${ref}"`);
  return ref;
}

/**
 * `GB_EXPECT_BEACON_REF` của bước 12. Vắng ⟹ không ràng buộc (đường ghi TAY). Có mặt thì PHẢI
 * đúng dạng — kể cả chuỗi RỖNG cũng ném: `GB_EXPECT_BEACON_REF=$REF` với `REF` chưa đặt ra chuỗi
 * rỗng, và đọc rỗng thành "không ràng buộc" là tắt cổng mà không ai biết.
 */
export function parseExpectBeaconRef(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!BEACON_REF_RE.test(raw)) {
    throw new Error(`GB_EXPECT_BEACON_REF phải có dạng <txHash 64 hex>#<chỉ số>, nhận "${raw}".`);
  }
  return raw;
}

/**
 * Biến môi trường giao bước 12: GIỮ NGUYÊN `gb_nanogic` và `depeg` đang trên chuỗi.
 * `DRY_RUN` đặt tường minh "0": keeper ở chế độ khô thì đã dừng trước khi gọi bước 12, nên một
 * `DRY_RUN=1` sót lại trong môi trường máy chủ chỉ có thể làm bước 12 khô âm thầm — và keeper
 * đọc thành "không thấy tx" ⟹ hỏng, mỗi giờ, không rõ vì sao.
 *
 * `GB_EXPECT_BEACON_REF` = UTxO beacon mà keeper ĐÃ ĐỌC để ra quyết định. Giá trị
 * `GB_NANOGIC`/`DEPEG` chỉ đúng với ĐÚNG UTxO đó; bước 12 đọc lại beacon, và nếu giữa hai lần đọc
 * có một lượt ghi tay chen vào thì keeper sẽ ghi đè giá trị mới bằng giá trị cũ (validator cho ghi
 * lại trong cùng epoch, và mỗi lần `seq` tăng thì shard GB nạp lại đầy). Buộc theo out-ref biến
 * cả chuỗi đọc-quyết-gửi thành nguyên tử: tx tiêu đúng UTxO keeper đã đọc, mà UTxO đó đã bị tiêu
 * thì sổ cái từ chối.
 */
export function greenbackPostEnv(
  beacon: { gb_nanogic: bigint; depeg: boolean },
  expectEpoch: bigint,
  beaconRef: { txHash: string; outputIndex: number },
): Record<string, string> {
  if (beacon.gb_nanogic < 0n) throw new Error(`gb_nanogic trên chuỗi âm (${beacon.gb_nanogic}) — không ghi lại.`);
  return {
    GB_NANOGIC: beacon.gb_nanogic.toString(),
    DEPEG: beacon.depeg ? "1" : "0",
    GB_EXPECT_EPOCH: expectEpoch.toString(),
    GB_EXPECT_BEACON_REF: formatBeaconRef(beaconRef),
    DRY_RUN: "0",
  };
}

/** Lý do bước 12 dừng TRƯỚC khi gửi — in thành dòng `GREENBACK_BEACON_NOT_SENT=<mã>`. */
export type GreenBackNotSentCode = "epoch-reached" | "beacon-moved" | "epoch-mismatch" | "dry-run" | "error";
const NOT_SENT_CODES: readonly GreenBackNotSentCode[] = ["epoch-reached", "beacon-moved", "epoch-mismatch", "dry-run", "error"];

export type GreenBackSubmitGate =
  | { ok: true }
  | { ok: false; code: Exclude<GreenBackNotSentCode, "dry-run" | "error">; message: string };

/**
 * Hai cổng của bước 12 trước khi gửi, cộng cổng cũ `GB_EXPECT_EPOCH` ↔ epoch tx sẽ ghi.
 * Thứ tự có nghĩa:
 *   1. `epoch-reached` — beacon ĐÃ ở epoch đích (hoặc vượt): đã có người ghi epoch này. Đứng đầu
 *      vì nó là kết cục lành của chính cuộc đua mà cổng 2 bắt — beacon đổi VÀ đã đúng epoch thì
 *      không có việc, không phải hỏng.
 *   2. `beacon-moved` — UTxO beacon đọc được KHÁC UTxO keeper đã đọc: giá trị keeper giao có thể
 *      đã cũ. Không gửi; lượt sau đọc lại từ đầu.
 *   3. `epoch-mismatch` — tx sẽ ghi epoch khác epoch keeper tính (hai đồng hồ lệch).
 * Mỗi cổng chỉ áp khi biến tương ứng có mặt: đường ghi TAY (không đặt biến nào) vẫn ghi lại được
 * trong cùng epoch — đó là cách duy nhất để đổi giá trị GB.
 */
export function greenbackSubmitGate(p: {
  expectEpoch?: bigint;
  expectRef?: string;
  beaconEpoch: bigint;
  actualRef: string;
  txEpoch: bigint;
}): GreenBackSubmitGate {
  if (p.expectEpoch !== undefined && p.beaconEpoch >= p.expectEpoch) {
    return {
      ok: false, code: "epoch-reached",
      message: `beacon GBB đã ở epoch ${p.beaconEpoch} ≥ GB_EXPECT_EPOCH ${p.expectEpoch} — đã có lượt khác ghi; không gửi gì.`,
    };
  }
  if (p.expectRef !== undefined && p.actualRef !== p.expectRef) {
    return {
      ok: false, code: "beacon-moved",
      message: `beacon GBB đang ở ${p.actualRef} ≠ GB_EXPECT_BEACON_REF ${p.expectRef} — có lượt ghi chen giữa lúc ` +
        `keeper đọc và lúc gửi, giá trị keeper giao có thể đã cũ; không gửi gì.`,
    };
  }
  if (p.expectEpoch !== undefined && p.txEpoch !== p.expectEpoch) {
    return {
      ok: false, code: "epoch-mismatch",
      message: `tx sẽ ghi epoch ${p.txEpoch} ≠ GB_EXPECT_EPOCH ${p.expectEpoch} — đồng hồ máy chạy lệch tip, ` +
        `hoặc đang sát biên epoch. Không gửi gì.`,
    };
  }
  return { ok: true };
}

export interface GreenBackPostResult {
  /** Hash tx đã GỬI — có mặt từ lúc submit, trước khi chờ vào khối. */
  tx?: string;
  /** Bước 12 in dòng xác nhận cho đúng hash đó ⟹ tx đã vào khối. */
  confirmed: boolean;
  /** Bước 12 khẳng định đã dừng TRƯỚC lời gọi submit, kèm lý do. */
  notSent?: GreenBackNotSentCode;
}

/**
 * Đọc ba dòng khoá ổn định của bước 12: `GREENBACK_BEACON_TX=<64 hex>` (in ngay sau submit),
 * `GREENBACK_BEACON_CONFIRMED=<64 hex>` (in sau khi vào khối) và `GREENBACK_BEACON_NOT_SENT=<mã>`
 * (in khi dừng trước lời gọi submit). Có TX mà không có CONFIRMED là "đã gửi, chưa đo được", không
 * phải "hỏng". Xác nhận chỉ tính khi trùng ĐÚNG hash đã gửi. TX và NOT_SENT cùng có mặt là tự mâu
 * thuẫn ⟹ ném (keeper đọc thành "chưa đo được").
 */
export function parseGreenBackPostOutput(out: string): GreenBackPostResult {
  const notSents = [...out.matchAll(/^\s*GREENBACK_BEACON_NOT_SENT=([a-z-]+)\s*$/gm)].map((m) => m[1]!);
  const bad = notSents.find((c) => !(NOT_SENT_CODES as readonly string[]).includes(c));
  if (bad !== undefined) throw new Error(`bước 12 in mã NOT_SENT lạ "${bad}" — không đọc được kết quả`);
  if (new Set(notSents).size > 1) throw new Error(`bước 12 in ${new Set(notSents).size} mã NOT_SENT khác nhau — không đọc được kết quả`);
  const notSent = notSents[0] as GreenBackNotSentCode | undefined;

  const txs = [...out.matchAll(/^\s*GREENBACK_BEACON_TX=([0-9a-f]{64})\s*$/gm)].map((m) => m[1]!);
  if (txs.length === 0) return notSent === undefined ? { confirmed: false } : { confirmed: false, notSent };
  if (notSent !== undefined) throw new Error(`bước 12 in cả GREENBACK_BEACON_TX lẫn NOT_SENT=${notSent} — tự mâu thuẫn`);
  if (new Set(txs).size > 1) throw new Error(`bước 12 in ${new Set(txs).size} hash tx khác nhau — không đọc được kết quả`);
  const tx = txs[0]!;
  const confirmed = [...out.matchAll(/^\s*GREENBACK_BEACON_CONFIRMED=([0-9a-f]{64})\s*$/gm)].some((m) => m[1] === tx);
  return { tx, confirmed };
}

/**
 * Kết luận của keeper về một lượt chạy bước 12. Chiều hỏng chọn theo chỗ ai nhìn thấy:
 * "không có tx nào được gửi" CHỈ được nói khi bước 12 tự khẳng định bằng dòng NOT_SENT. Thiếu cả
 * dòng TX lẫn dòng NOT_SENT ⟹ tiến trình con có thể đã chết GIỮA lời gọi submit (mất kết nối sau
 * khi nút đã nhận, bị giết vì quá giờ, stdout bị cắt khi thoát) ⟹ "chưa đo được", không phải
 * "hỏng — chưa gửi": đọc nhầm thành chưa gửi thì lượt sau gửi lại.
 */
export function classifyGreenBackRun(
  res: GreenBackPostResult,
  code: number,
): { outcome: "done" | "skip" | "fail" | "unverified"; note: string } {
  if (res.tx) {
    if (res.confirmed) return { outcome: "done", note: `tx ${res.tx}` };
    return { outcome: "unverified", note: `tx ${res.tx} đã gửi, chưa thấy vào khối (bước 12 thoát ${code}) — soi explorer trước khi chạy lại` };
  }
  if (res.notSent === "epoch-reached") {
    return { outcome: "skip", note: `bước 12: beacon đã ở epoch đích khi đọc lại — lượt khác đã ghi giữa chừng, không gửi gì` };
  }
  if (res.notSent !== undefined) {
    return { outcome: "fail", note: `bước 12 dừng trước khi gửi (${res.notSent}, thoát ${code}) — không có tx nào được gửi` };
  }
  return {
    outcome: "unverified",
    note: `bước 12 thoát ${code}, không in GREENBACK_BEACON_TX cũng không in GREENBACK_BEACON_NOT_SENT — ` +
      `có thể đã nộp tx; CHƯA ĐO ĐƯỢC, soi beacon GBB trên explorer trước khi chạy lại`,
  };
}
