// src/math.ts — UM Math only (no Lucid dependency)
// Exported separately so tests can run without @lucid-evolution/lucid

const Q        = 1_000_000_000n;
const UM_MIN_Q = 500_000_000n;
const UM_MAX_Q = 2_000_000_000n;
const UM_WINDOW = 6;
// P8 — phải trùng BIT với `um_max_step_q` trong
// UMKeeper/onchain/validators/um_datum.ak (hằng `um_max_step_q`, 0,10).
// Đây là hàng rào TẠM chống ghim UM bằng new_raw tự khai; bản vá thật là cổng
// M-of-N ngang `price_param`. Đổi một bên mà quên bên kia thì mọi giao dịch
// keeper dựng ra sẽ bị validator từ chối (fail-closed, nhưng keeper đứng im).
const UM_MAX_STEP_Q = 100_000_000n;

export function computeUMRaw(epochBurns: bigint, epochMints: bigint): bigint {
  const den = epochMints > 0n ? epochMints : 1n;
  return epochBurns * Q / den;
}

export function clampUM(x: bigint): bigint {
  if (x < UM_MIN_Q) return UM_MIN_Q;
  if (x > UM_MAX_Q) return UM_MAX_Q;
  return x;
}

/**
 * Kẹp `raw` vào [smoothed − δ, smoothed + δ] với δ = UM_MAX_STEP_Q.
 *
 * On-chain KHÔNG kẹp — nó TỪ CHỐI giao dịch có bước vượt trần
 * (`expect step_within(...)`). Nên việc kẹp là nghĩa vụ của BÊN DỰNG tx: gửi
 * một `new_raw` vượt trần là ném cả giao dịch đi, keeper mất phí và UM không
 * được làm tươi. Kẹp ở đây = luôn gửi được bước lớn nhất còn hợp lệ.
 *
 * Hệ quả phải nói thẳng: khi thị trường đổi nhanh hơn 0,10/epoch thì UM đi sau
 * thực tế, và nó đi sau ĐÚNG BẰNG cái giá của hàng rào này.
 */
export function clampStep(raw: bigint, smoothed: bigint): bigint {
  const hi = smoothed + UM_MAX_STEP_Q;
  const lo = smoothed - UM_MAX_STEP_Q;
  if (raw > hi) return hi;
  if (raw < lo) return lo;
  return raw;
}

export function appendHistory(history: bigint[], value: bigint): bigint[] {
  // C-UM-2: pure sliding window — keep last ≤ 6 entries.
  // P8: caller (computeNewUM) clamps BEFORE append để khớp Aiken
  // `append_capped(history, clamped_raw, 6)` — history lưu giá trị đã clamp.
  return [...history, value].slice(-UM_WINDOW);
}

export function computeSMA(history: bigint[]): bigint {
  if (history.length === 0) return Q;
  return history.reduce((s, x) => s + x, 0n) / BigInt(history.length);
}

export interface UMDatum {
  smoothed_q: bigint;
  last_updated_epoch: bigint;
  history: bigint[];
}

export function computeNewUM(datum: UMDatum, epochBurns: bigint, epochMints: bigint) {
  // P8: clamp-before-append. Aiken `append_capped(history, clamped_raw, 6)`
  // lưu giá trị ĐÃ CLAMP vào history → TS phải làm giống để `history` trong
  // datum khớp bit-identical (double clamp: lần 1 ở đây, lần 2 ở SMA output).
  //
  // Thứ tự BẮT BUỘC là clamp-dải rồi mới kẹp-bước, vì on-chain kiểm bước trên
  // `clamped_raw` (đã qua clamp dải) chứ không trên `new_raw` thô:
  //   um_datum.ak ▸ let clamped_raw = clamp(new_raw, um_min_q, um_max_q)
  //                 expect step_within(clamped_raw, datum.smoothed_q, …)
  //
  // HAI con số raw, đừng lẫn:
  //   newRaw       — tỉ lệ ĐO ĐƯỢC của epoch, giữ nguyên để ghi nhật ký/chẩn
  //                  đoán. Nó là lời khai về thị trường.
  //   submittedRaw — con số THẬT SỰ đi vào redeemer và vào `history`, sau khi
  //                  kẹp bước. Gửi newRaw thô là bị validator từ chối.
  // Giữ cả hai để nhật ký keeper còn thấy được khoảng cách giữa "thị trường
  // nói gì" và "hàng rào cho phép gì" — đó chính là chi phí của hàng rào, và
  // nó phải NHÌN THẤY ĐƯỢC, không được nuốt vào trong một con số duy nhất.
  const newRaw       = computeUMRaw(epochBurns, epochMints);
  const clampedRaw   = clampUM(newRaw);
  const submittedRaw = clampStep(clampedRaw, datum.smoothed_q);
  const newHistory   = appendHistory(datum.history, submittedRaw);
  const newSmoothed  = clampUM(computeSMA(newHistory));
  return { newSmoothed, newHistory, newRaw, submittedRaw };
}
