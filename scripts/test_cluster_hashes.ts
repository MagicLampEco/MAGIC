// scripts/test_cluster_hashes.ts — bộ ca cho `clusterHashes.ts` (tính trước hash cụm phục vụ) và
// phép so hash kỳ vọng của `deploySeeds.ts`. Không gọi mạng, không đọc khoá.
//
// Chạy từ scripts/:  npx tsx test_cluster_hashes.ts
//   Mặc định chạy `aiken build` năm module trước (plutus.json đã gitignore — BOUNDARIES.md §4).
//   CLUSTER_HASHES_SKIP_BUILD=1 ⟹ dùng plutus.json đang có trên đĩa (dòng đầu output nói rõ).
// Dòng cuối: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===` (mã thoát 1).
//
// Trọng tài: `vectors/cluster_hashes.gen2-preprod.json` — 20 hash của cụm phục vụ đời 2 trên
// Preprod, với đúng seed mà cụm đó đã tiêu. Vector chỉ áp được khi blueprint hiện tại trùng
// blueprint đời 2 (`blueprintValidatorHashes`); lệch ⟹ ca đó HỎNG với câu nói rõ vector đã cũ,
// không "bỏ qua" (bỏ qua là trạng thái KHÔNG ĐO ĐƯỢC mang màu ĐẠT).

import { readFileSync } from "node:fs";
import {
  blueprintProvenance, buildClusterBlueprints, compareExpected, computeClusterHashes, expectedHashesFile,
  loadClusterBlueprints, parseClusterHashInput, type ClusterBlueprints, type ClusterHashInput,
} from "./clusterHashes.js";
import { checkExpectedHashes, parseExpectedHashes } from "./deploySeeds.js";

let failures = 0;
async function testCase(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${name}\n      ${(e as Error).message.split("\n").join("\n      ")}`);
  }
}
function assertEq<T>(actual: T, want: T, label: string) {
  if (actual !== want) throw new Error(`${label}: nhận ${String(actual)}, chờ ${String(want)}`);
}
function assertNe<T>(a: T, b: T, label: string) {
  if (a === b) throw new Error(`${label}: hai bên TRÙNG (${String(a)}) — chờ khác`);
}
function mustThrow(fn: () => unknown, parts: string[]): string {
  try {
    fn();
  } catch (e) {
    const m = (e as Error).message;
    for (const c of parts) if (!m.includes(c)) throw new Error(`ném nhưng câu lỗi thiếu "${c}": ${m.split("\n")[0]}`);
    return m;
  }
  throw new Error("KHÔNG ném");
}

const VECTOR = new URL("./vectors/cluster_hashes.gen2-preprod.json", import.meta.url);
const raw = JSON.parse(readFileSync(VECTOR, "utf8")) as Record<string, unknown>;
const gen2 = parseClusterHashInput(raw, "vectors/cluster_hashes.gen2-preprod.json");
const expected = gen2.expected!;
const bpHashes = raw.blueprintValidatorHashes as Record<string, string>;
const clone = (): ClusterHashInput => JSON.parse(JSON.stringify(gen2)) as ClusterHashInput;

// ── Blueprint ────────────────────────────────────────────────────────────────
if (process.env.CLUSTER_HASHES_SKIP_BUILD === "1") {
  console.log("── Blueprint: CLUSTER_HASHES_SKIP_BUILD=1 — dùng plutus.json ĐANG CÓ trên đĩa, KHÔNG dựng lại");
} else {
  console.log("── Blueprint: aiken build năm module");
  buildClusterBlueprints((l) => console.log(l));
}
console.log(`   ${blueprintProvenance()}`);
const bp: ClusterBlueprints = await loadClusterBlueprints();

console.log("\n── Vector đời 2 Preprod");
let vectorApplies = false;
await testCase(`blueprint hiện tại trùng blueprint đời 2 (${Object.keys(bpHashes).length} validator chưa apply)`, () => {
  const byModule: Record<string, { validators: { title: string; hash: string }[] }> = {
    GenBeacons: bp.genBeacons, InstantGen: bp.instant, ScheduleGen: bp.schedule, ConsumeMAGIC: bp.consume, PrepaidGen: bp.prepaid,
  };
  const diff: string[] = [];
  for (const [key, want] of Object.entries(bpHashes)) {
    const [mod, title] = key.split(":") as [string, string];
    const got = byModule[mod]!.validators.find((v) => v.title === title)?.hash;
    if (got !== want) diff.push(`${key}: hiện ${got ?? "(không có)"} ≠ đời 2 ${want}`);
  }
  if (diff.length > 0) {
    throw new Error(
      `VECTOR ĐỜI 2 KHÔNG CÒN ÁP DỤNG — mã validator đã đổi so với lúc dựng cụm đời 2, nên 20 hash kỳ vọng không ` +
        `còn là thứ blueprint này phải ra. Đây không phải lỗi của công cụ tính hash; ghi vector mới cho đời đang ` +
        `deploy.\n${diff.join("\n")}`,
    );
  }
  vectorApplies = true;
});

const r = computeClusterHashes(bp, gen2);
await testCase("20/20 hash đời 2 KHỚP (vector chuẩn)", () => {
  if (!vectorApplies) throw new Error("không so — blueprint không phải blueprint đời 2 (ca trên)");
  const cmp = compareExpected(r, expected);
  assertEq(Object.keys(expected).length, 20, "số mục kỳ vọng");
  if (cmp.ok !== 20) throw new Error(`${cmp.ok} KHỚP · ${cmp.bad} LỆCH · ${cmp.unmeasured} KHÔNG ĐO ĐƯỢC\n${cmp.lines.join("\n")}`);
});

// ── Ca âm: đổi một seed thì hash đổi đúng nhánh phụ thuộc ──────────────────────
console.log("\n── Ca âm: seed đổi ⟹ hash đổi");
await testCase("đổi seed sổ két ⟹ vault_registry, gb_shard, két Instant, két Schedule đổi; shard_nft, beacon ρ giữ", () => {
  const inp = clone();
  inp.seeds.registry = inp.seeds.registry!.replace(/#0$/, "#7");
  const x = computeClusterHashes(bp, inp);
  assertNe(x.hashes.vault_registry, r.hashes.vault_registry, "vault_registry");
  assertNe(x.hashes.gb_shard, r.hashes.gb_shard, "gb_shard");
  assertNe(x.hashes.vault_instant, r.hashes.vault_instant, "vault_instant");
  assertNe(x.hashes.vault_schedule, r.hashes.vault_schedule, "vault_schedule");
  assertNe(x.hashes.consume_instant, r.hashes.consume_instant, "consume_instant");
  assertEq(x.hashes.shard_nft, r.hashes.shard_nft, "shard_nft (không phụ thuộc seed sổ)");
  assertEq(x.hashes.rate_param, r.hashes.rate_param, "rate_param (không phụ thuộc seed sổ)");
  assertEq(x.hashes.vault_prepaid, r.hashes.vault_prepaid, "vault_prepaid (không phụ thuộc beacon)");
  const cmp = compareExpected(x, expected);
  if (cmp.bad === 0) throw new Error("so với vector đời 2 không ra LỆCH nào");
});
await testCase("đổi seed price_nft Instant ⟹ chỉ ba hash consume Instant đổi", () => {
  const inp = clone();
  inp.seeds.priceNftInstant = inp.seeds.priceNftSchedule!.replace(/#1$/, "#9");
  const x = computeClusterHashes(bp, inp);
  const changed = Object.keys(r.hashes).filter((k) => (x.hashes as Record<string, unknown>)[k] !== (r.hashes as Record<string, unknown>)[k]);
  assertEq(changed.sort().join(","), "consume_instant,price_nft_instant,price_param_instant", "tập hash đổi");
});
await testCase("đổi seed shard_nft ⟹ nhánh Schedule đổi, két Instant giữ", () => {
  const inp = clone();
  inp.seeds.shardNft = inp.seeds.shardNft!.replace(/#1$/, "#0");
  const x = computeClusterHashes(bp, inp);
  for (const k of ["shard_nft", "commit", "vault_schedule", "shard_schedule", "consume_schedule"] as const) {
    assertNe(x.hashes[k], r.hashes[k], k);
  }
  assertEq(x.hashes.vault_instant, r.hashes.vault_instant, "vault_instant");
});
await testCase("đổi wakemeVaultHash ⟹ két Instant + paid_fund + két Prepaid đổi, nhánh Schedule giữ", () => {
  const inp = clone();
  inp.wakemeVaultHash = "ab".repeat(28);
  const x = computeClusterHashes(bp, inp);
  for (const k of ["vault_instant", "paid_fund", "vault_prepaid", "consume_instant", "consume_prepaid"] as const) assertNe(x.hashes[k], r.hashes[k], k);
  for (const k of ["vault_schedule", "consume_schedule", "gb_shard"] as const) assertEq(x.hashes[k], r.hashes[k], k);
});
await testCase("wakemeVaultHash = null ⟹ năm hash CHƯA TÍNH ĐƯỢC, so vector ra KHÔNG ĐO ĐƯỢC (không phải KHỚP)", () => {
  const inp = clone();
  inp.wakemeVaultHash = null;
  const x = computeClusterHashes(bp, inp);
  for (const k of ["vault_instant", "paid_fund", "vault_prepaid", "consume_instant", "consume_prepaid"] as const) assertEq(x.hashes[k], null, k);
  assertEq(x.hashes.vault_schedule, r.hashes.vault_schedule, "vault_schedule vẫn tính được");
  const cmp = compareExpected(x, expected);
  // 3 hash két (instant, paid_fund, prepaid) + 3 × 2 chuỗi consume (instant, prepaid) = 9.
  assertEq(cmp.unmeasured, 9, "số KHÔNG ĐO ĐƯỢC");
  assertEq(cmp.bad, 0, "số LỆCH (phần còn lại vẫn khớp)");
  assertEq(Object.keys(expectedHashesFile(x)).includes("vault_instant"), false, "tệp kỳ vọng không chứa hash chưa tính");
});
await testCase("hằng lấy từ mã mà đầu vào ghi khác ⟹ NÉM (không tính hash của một bộ số khác)", () => {
  const inp = clone();
  inp.constants.msPerEpoch = "86400000";
  mustThrow(() => computeClusterHashes(bp, inp), ["msPerEpoch", "432000000"]);
  const inp2 = clone();
  inp2.constants.gbShardCapNanogic = "1";
  mustThrow(() => computeClusterHashes(bp, inp2), ["gbShardCapNanogic"]);
});
await testCase("seed sai hình dạng / vai lạ ⟹ NÉM", () => {
  const inp = clone();
  inp.seeds.rate = "abc#0";
  mustThrow(() => computeClusterHashes(bp, inp), ["seeds.rate"]);
  mustThrow(() => parseClusterHashInput({ ...raw, seeds: { ...gen2.seeds, priceNft: "x" } }, "t"), ["vai lạ", "priceNft"]);
});

// ── Phép so hash của bước deploy (`deploySeeds.ts ▸ checkExpectedHashes`) ─────
console.log("\n── Phép so hash kỳ vọng của bước deploy");
const file = parseExpectedHashes(JSON.parse(JSON.stringify(expectedHashesFile(r))), "tệp --out");
const step11 = {
  vault_registry: r.hashes.vault_registry!, greenback_beacon: r.hashes.greenback_beacon!,
  gb_shard: r.hashes.gb_shard!, rate_param: r.hashes.rate_param!,
};
const quiet = () => {};
await testCase("tệp --out đủ 20 hash và qua được phép so của bước 11", () => {
  assertEq(Object.keys(file).length, 20, "số hash trong tệp");
  checkExpectedHashes("bước 11", step11, file, quiet);
});
await testCase("một hash lệch ⟹ NÉM, câu lỗi nêu tên + hai giá trị", () => {
  const bad = { ...file, gb_shard: "00".repeat(28) };
  mustThrow(() => checkExpectedHashes("bước 11", step11, bad, quiet), ["KHÔNG nộp", "gb_shard", "00".repeat(28)]);
});
await testCase("tệp kỳ vọng thiếu tên ⟹ NÉM (KHÔNG ĐO ĐƯỢC không đi qua như KHỚP)", () => {
  const { rate_param: _drop, ...missing } = file;
  mustThrow(() => checkExpectedHashes("bước 11", step11, missing, quiet), ["rate_param", "không có"]);
});
await testCase("tệp kỳ vọng sai hình dạng ⟹ NÉM", () => {
  mustThrow(() => parseExpectedHashes({ gb_shard: "XYZ" }, "t"), ["gb_shard", "56 hex"]);
  mustThrow(() => parseExpectedHashes([], "t"), ["đối tượng JSON"]);
});

console.log(failures === 0 ? "\n=== ĐẠT ===" : `\n=== HỎNG: ${failures} ca sai ===`);
if (failures !== 0) process.exit(1);
