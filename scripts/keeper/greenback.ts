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

/**
 * Biến môi trường giao bước 12: GIỮ NGUYÊN `gb_nanogic` và `depeg` đang trên chuỗi.
 * `DRY_RUN` đặt tường minh "0": keeper ở chế độ khô thì đã dừng trước khi gọi bước 12, nên một
 * `DRY_RUN=1` sót lại trong môi trường máy chủ chỉ có thể làm bước 12 khô âm thầm — và keeper
 * đọc thành "không thấy tx" ⟹ hỏng, mỗi giờ, không rõ vì sao.
 */
export function greenbackPostEnv(
  beacon: { gb_nanogic: bigint; depeg: boolean },
  expectEpoch: bigint,
): Record<string, string> {
  if (beacon.gb_nanogic < 0n) throw new Error(`gb_nanogic trên chuỗi âm (${beacon.gb_nanogic}) — không ghi lại.`);
  return {
    GB_NANOGIC: beacon.gb_nanogic.toString(),
    DEPEG: beacon.depeg ? "1" : "0",
    GB_EXPECT_EPOCH: expectEpoch.toString(),
    DRY_RUN: "0",
  };
}

export interface GreenBackPostResult {
  /** Hash tx đã GỬI — có mặt từ lúc submit, trước khi chờ vào khối. */
  tx?: string;
  /** Bước 12 in dòng xác nhận cho đúng hash đó ⟹ tx đã vào khối. */
  confirmed: boolean;
}

/**
 * Đọc hai dòng khoá ổn định của bước 12: `GREENBACK_BEACON_TX=<64 hex>` (in ngay sau submit) và
 * `GREENBACK_BEACON_CONFIRMED=<64 hex>` (in sau khi vào khối). Hai dòng tách nhau vì tiến trình
 * con có thể bị giết khi đang chờ: có TX mà không có CONFIRMED là "đã gửi, chưa đo được", không
 * phải "hỏng". Xác nhận chỉ tính khi trùng ĐÚNG hash đã gửi.
 */
export function parseGreenBackPostOutput(out: string): GreenBackPostResult {
  const txs = [...out.matchAll(/^\s*GREENBACK_BEACON_TX=([0-9a-f]{64})\s*$/gm)].map((m) => m[1]!);
  if (txs.length === 0) return { confirmed: false };
  if (new Set(txs).size > 1) throw new Error(`bước 12 in ${new Set(txs).size} hash tx khác nhau — không đọc được kết quả`);
  const tx = txs[0]!;
  const confirmed = [...out.matchAll(/^\s*GREENBACK_BEACON_CONFIRMED=([0-9a-f]{64})\s*$/gm)].some((m) => m[1] === tx);
  return { tx, confirmed };
}
