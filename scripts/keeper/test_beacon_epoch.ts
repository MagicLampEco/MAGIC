// scripts/keeper/test_beacon_epoch.ts — bộ ca của `beaconEpochState`. Không gọi mạng.
// Chạy: npx tsx keeper/test_beacon_epoch.ts   (từ thư mục scripts/)
// Dòng cuối NÓI RA trạng thái: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===`.
import { beaconEpochState, type BeaconEpochState } from "./beaconEpoch.js";

const cases: Array<[string, bigint, bigint, BeaconEpochState]> = [
  ["datum đúng epoch hiện tại",                        4144n, 4144n, "current"],
  ["datum cũ một epoch — cần làm mới",                  4143n, 4144n, "behind"],
  ["datum cũ nhiều epoch",                              4100n, 4144n, "behind"],
  // Cặp quyết định: hai ca dưới là ca mà phép so `>=` cũ gộp chung với "current".
  ["datum tương lai một epoch",                         4145n, 4144n, "ahead"],
  ["datum nhịp 1 ngày, keeper nhịp 5 ngày (ca thật)",  20719n, 4144n, "ahead"],
];

let failures = 0;
for (const [label, datumEpoch, currentEpoch, want] of cases) {
  const got = beaconEpochState(datumEpoch, currentEpoch);
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label.padEnd(50)} → ${got}${ok ? "" : ` (mong ${want})`}`);
}
console.log(failures === 0 ? "\n=== ĐẠT ===" : `\n=== HỎNG: ${failures} ca sai ===`);
process.exit(failures === 0 ? 0 : 1);
