// scripts/keeper/test_greenback.ts — bộ ca của phần thuần bước `greenback` (`keeper/greenback.ts`)
// và cổng `GB_EXPECT_EPOCH` của bước 12. Không gọi mạng, không cần khoá.
// Chạy: npx tsx keeper/test_greenback.ts   (từ thư mục scripts/)
// Dòng cuối NÓI RA trạng thái: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===`.
//
// Mỗi ca âm đi kèm CỰC ĐỐI chỉ khác đúng một đầu vào — một ca đơn lẻ có thể ra đúng vì lý do
// rỗng (ví dụ hàm luôn trả "skip"), cặp thì không.
import {
  decideGreenBack, greenbackPostEnv, parseGreenBackPostOutput,
  GREENBACK_END_MARGIN_MS, GREENBACK_START_MARGIN_MS,
} from "./greenback.js";
import { parseExpectEpoch } from "../deploy/12_post_greenback.js";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `  — ${detail}`}`);
};
const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };

// Epoch giả: 5 ngày, gốc 0. Epoch 318 = [318·P, 319·P).
const P = 432_000_000n;
const E = 318n;
const start = E * P, end = (E + 1n) * P;
const mid = start + P / 2n;
const at = (beaconEpoch: bigint, nowMs: bigint) =>
  decideGreenBack({ beaconEpoch, currentEpoch: E, nowMs, epochStartMs: start, epochEndMs: end }).action;

console.log("decideGreenBack");
check("cũ một epoch, giữa epoch ⟹ post",                          at(E - 1n, mid) === "post", at(E - 1n, mid));
check("  cực đối: đúng epoch, giữa epoch ⟹ skip",                  at(E, mid) === "skip", at(E, mid));
check("beacon tương lai ⟹ fail (không ghi đè)",                    at(E + 1n, mid) === "fail", at(E + 1n, mid));
check("  cực đối: beacon cũ nhiều epoch ⟹ post",                   at(E - 5n, mid) === "post", at(E - 5n, mid));
const nearEnd = end - GREENBACK_END_MARGIN_MS + 1n;
check("cũ, còn 15 phút trừ 1 ms tới biên cuối ⟹ skip",             at(E - 1n, nearEnd) === "skip", at(E - 1n, nearEnd));
check("  cực đối: còn đúng 15 phút ⟹ post",                        at(E - 1n, nearEnd - 1n) === "post", at(E - 1n, nearEnd - 1n));
const nearStart = start + GREENBACK_START_MARGIN_MS - 1n;
check("cũ, epoch mới bắt đầu 5 phút trừ 1 ms ⟹ skip",             at(E - 1n, nearStart) === "skip", at(E - 1n, nearStart));
check("  cực đối: đã qua đúng 5 phút ⟹ post",                     at(E - 1n, nearStart + 1n) === "post", at(E - 1n, nearStart + 1n));
check("beacon tương lai sát biên vẫn fail (fail thắng skip biên)", at(E + 1n, nearEnd) === "fail", at(E + 1n, nearEnd));
check("  cực đối: đúng epoch sát biên ⟹ skip",                     at(E, nearEnd) === "skip", at(E, nearEnd));

console.log("greenbackPostEnv");
const a = greenbackPostEnv({ gb_nanogic: 123_456_789n, depeg: false }, E);
const b = greenbackPostEnv({ gb_nanogic: 987_654_321n, depeg: false }, E);
check("giữ nguyên gb_nanogic trên chuỗi",                          a.GB_NANOGIC === "123456789", JSON.stringify(a));
check("  cực đối: gb khác ⟹ GB_NANOGIC khác (không phải hằng)",    b.GB_NANOGIC === "987654321", JSON.stringify(b));
check("depeg false ⟹ DEPEG=0",                                    a.DEPEG === "0", JSON.stringify(a));
const c = greenbackPostEnv({ gb_nanogic: 123_456_789n, depeg: true }, E);
check("  cực đối: depeg true ⟹ DEPEG=1",                          c.DEPEG === "1", JSON.stringify(c));
check("GB_EXPECT_EPOCH = epoch keeper",                            a.GB_EXPECT_EPOCH === "318", JSON.stringify(a));
check("DRY_RUN đặt tường minh 0 (đè DRY_RUN=1 sót trong môi trường)", a.DRY_RUN === "0", JSON.stringify(a));
check("gb = 0 vẫn ghi lại được",                                   greenbackPostEnv({ gb_nanogic: 0n, depeg: false }, E).GB_NANOGIC === "0");
check("  cực đối: gb âm ⟹ ném",                                    throws(() => greenbackPostEnv({ gb_nanogic: -1n, depeg: false }, E)));

console.log("parseGreenBackPostOutput");
const h1 = "a".repeat(64), h2 = "b".repeat(64);
const r1 = parseGreenBackPostOutput(`  mới: gb=1\nGREENBACK_BEACON_TX=${h1}\nGREENBACK_BEACON_CONFIRMED=${h1}\n✅ Đã ghi GreenBack. TX hash: ${h1}\n`);
check("TX + CONFIRMED cùng hash ⟹ tx, confirmed",                 r1.tx === h1 && r1.confirmed, JSON.stringify(r1));
const r2 = parseGreenBackPostOutput(`GREENBACK_BEACON_TX=${h1}\n⚠ CHƯA ĐO ĐƯỢC …\n`);
check("  cực đối: chỉ TX ⟹ tx, CHƯA confirmed",                   r2.tx === h1 && !r2.confirmed, JSON.stringify(r2));
const r3 = parseGreenBackPostOutput(`GREENBACK_BEACON_TX=${h1}\nGREENBACK_BEACON_CONFIRMED=${h2}\n`);
check("CONFIRMED cho hash KHÁC ⟹ chưa confirmed",                  r3.tx === h1 && !r3.confirmed, JSON.stringify(r3));
const r4 = parseGreenBackPostOutput(`✅ Đã ghi GreenBack. TX hash: ${h1}\n`);
check("dòng văn xuôi cũ `TX hash:` KHÔNG đọc thành tx",            r4.tx === undefined && !r4.confirmed, JSON.stringify(r4));
const r5 = parseGreenBackPostOutput(`GREENBACK_BEACON_TX=${h1.slice(1)}\n`);
check("  cực đối: hash 63 ký tự ⟹ không đọc",                      r5.tx === undefined, JSON.stringify(r5));
check("hai hash TX khác nhau ⟹ ném",                               throws(() => parseGreenBackPostOutput(`GREENBACK_BEACON_TX=${h1}\nGREENBACK_BEACON_TX=${h2}\n`)));
check("  cực đối: cùng hash in hai lần ⟹ không ném",               !throws(() => parseGreenBackPostOutput(`GREENBACK_BEACON_TX=${h1}\nGREENBACK_BEACON_TX=${h1}\n`)));

console.log("parseExpectEpoch (bước 12)");
check("vắng ⟹ không ràng buộc",                                   parseExpectEpoch(undefined) === undefined);
check("rỗng ⟹ không ràng buộc",                                   parseExpectEpoch("") === undefined);
check("318 ⟹ 318n",                                               parseExpectEpoch("318") === 318n);
check("  cực đối: -1 ⟹ ném",                                      throws(() => parseExpectEpoch("-1")));
check("  cực đối: 31a ⟹ ném",                                     throws(() => parseExpectEpoch("31a")));

console.log(failures === 0 ? "\n=== ĐẠT ===" : `\n=== HỎNG: ${failures} ca sai ===`);
process.exit(failures === 0 ? 0 : 1);
