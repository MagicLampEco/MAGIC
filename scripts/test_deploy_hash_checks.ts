// scripts/test_deploy_hash_checks.ts — ghim phép SO hash kỳ vọng ở từng bước deploy của cụm phục vụ
// (03 · 05 · 07 · 09 · 10 · 11 pha registry), cùng các cổng của chế độ seed cho trước
// (`deploySeeds.ts`): seed trùng vai, có seed mà vắng tệp kỳ vọng, seed ở ví khi có tệp kỳ vọng.
// Không gọi mạng, không đọc khoá.
//
// Chạy từ scripts/:  npx tsx test_deploy_hash_checks.ts
//   Dùng plutus.json ĐANG CÓ trên đĩa (không tự `aiken build`): hash kỳ vọng ĐÚNG ở đây do
//   `clusterHashes.ts ▸ computeClusterHashes` tính trên CÙNG blueprint, nên bộ này không phụ thuộc
//   blueprint là đời nào. Thiếu plutus.json ⟹ ném ở dòng nạp (chạy `test_cluster_hashes.ts` trước).
// Dòng cuối: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===` (mã thoát 1).
//
// Mỗi bước có một CẶP ca: tệp kỳ vọng đúng ⟹ qua và ra đúng hash của `computeClusterHashes` (một
// đường apply, không phải hai); tệp lệch đúng MỘT tên của bước đó ⟹ ném nêu tên đó. Thêm một ca
// cấu trúc: `main()` của từng bước gọi hàm "tính + so", không tự apply — phép so nằm trong hàm
// thuần thì bài kiểm với tới, nhưng chỉ có tác dụng khi `main` thật sự đi qua nó.

import { readFileSync } from "node:fs";
import { msPerEpoch as msPerEpochOf, windowOriginMs as windowOriginOf } from "@magiclamp/protocol-utils";
import {
  checkWakemeAgainstCode, computeClusterHashes, expectedHashesFile, loadClusterBlueprints, parseClusterHashInput,
  type ClusterHashInput,
} from "./clusterHashes.js";
import {
  consumeChainChecked, instantVaultChecked, prepaidPairChecked, scheduleVaultChecked,
} from "./deployHashChecks.js";
import {
  assertDistinctPresetSeeds, EXPECT_HASHES_ENV, EXPECT_NONE_ENV, presetModeOn, presetSeedAllowWallet,
  requireExpectInPresetMode, SEED_ENV, type ExpectedHashes,
} from "./deploySeeds.js";
import { shardStepChecked } from "./deploy/03_deploy_shards.js";
import { registryHashesChecked } from "./deploy/11_deploy_gen_beacons.js";
import { DRY_RUN_PREFIX, printSeeds } from "./deploy/park_seeds.js";
import { parseOutRef } from "./runResult.js";

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
const quiet = () => {};
const Z = "00".repeat(28);

// ── Đầu vào: vector đời 2 (chỉ lấy hình dạng + seed; hash kỳ vọng tính lại trên blueprint hiện tại) ──
const VECTOR = new URL("./vectors/cluster_hashes.gen2-preprod.json", import.meta.url);
const inp: ClusterHashInput = parseClusterHashInput(JSON.parse(readFileSync(VECTOR, "utf8")), "vectors/cluster_hashes.gen2-preprod.json");
const bp = await loadClusterBlueprints();
const r = computeClusterHashes(bp, inp);
const right: ExpectedHashes = expectedHashesFile(r);
const net = inp.network;
const c = inp.constants;
const msPerEpoch = msPerEpochOf(net);
const windowOriginMs = windowOriginOf(net);
const wakeme = inp.wakemeVaultHash!;
const seedOf = (k: keyof ClusterHashInput["seeds"]) => parseOutRef(inp.seeds[k]!, `seeds.${k}`);
const beacons = {
  gbBeaconNftPolicy: right.greenback_beacon!, gbBeaconScriptHash: right.greenback_beacon!,
  gbShardPolicyId: right.gb_shard!,
  rateNftPolicy: right.rate_param!, rateScriptHash: right.rate_param!,
};
const lamp = { lampPolicyId: c.lampPolicyId!, lampAssetName: c.lampAssetName! };
const without = (name: string): ExpectedHashes => { const { [name]: _drop, ...rest } = right; return rest; };
const bent = (name: string): ExpectedHashes => ({ ...right, [name]: Z });

console.log(`── Tệp kỳ vọng tính trên blueprint hiện tại: ${Object.keys(right).length} hash`);
await testCase("đủ 20 hash (đầu vào đời 2 có wakemeVaultHash + đủ tám seed)", () => {
  assertEq(Object.keys(right).length, 20, "số hash");
});

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── Bước 03 · shard_nft · commit · vault_schedule · shard_schedule");
const s03 = () => ({ ...lamp, msPerEpoch, windowOriginMs, ...beacons });
await testCase("kỳ vọng đúng ⟹ qua, bốn hash = computeClusterHashes", () => {
  const x = shardStepChecked(bp.schedule, seedOf("shardNft"), s03(), right, quiet);
  assertEq(x.shardNftPolicyId, right.shard_nft, "shard_nft");
  assertEq(x.commitHash, right.commit, "commit");
  assertEq(x.vaultHash, right.vault_schedule, "vault_schedule");
  assertEq(x.shardHash, right.shard_schedule, "shard_schedule");
});
await testCase("shard_schedule LỆCH ⟹ ném 'bước 03' + 'KHÔNG nộp'", () => {
  mustThrow(() => shardStepChecked(bp.schedule, seedOf("shardNft"), s03(), bent("shard_schedule"), quiet), ["bước 03", "shard_schedule", "KHÔNG nộp"]);
});
await testCase("seed khác (seed sổ két) với tệp đúng ⟹ ném ở shard_nft", () => {
  mustThrow(() => shardStepChecked(bp.schedule, seedOf("registry"), s03(), right, quiet), ["bước 03", "shard_nft"]);
});

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── Bước 05 · vault_instant");
const s05 = () => ({ ...lamp, ...beacons, wakemeVaultHash: wakeme, msPerEpoch, windowOriginMs });
await testCase("kỳ vọng đúng ⟹ qua, hash = computeClusterHashes", () => {
  assertEq(instantVaultChecked(bp.instant, s05(), right, quiet).hash, right.vault_instant, "vault_instant");
});
await testCase("vault_instant LỆCH ⟹ ném 'bước 05'", () => {
  mustThrow(() => instantVaultChecked(bp.instant, s05(), bent("vault_instant"), quiet), ["bước 05", "vault_instant", "KHÔNG nộp"]);
});
await testCase("tệp THIẾU vault_instant ⟹ ném 'không có' (KHÔNG ĐO ĐƯỢC không đi qua như KHỚP)", () => {
  mustThrow(() => instantVaultChecked(bp.instant, s05(), without("vault_instant"), quiet), ["bước 05", "vault_instant", "không có"]);
});
await testCase("hằng Wakeme của mã khác hằng đã tính trước ⟹ ném 'bước 05'", () => {
  mustThrow(() => instantVaultChecked(bp.instant, { ...s05(), wakemeVaultHash: "ab".repeat(28) }, right, quiet), ["bước 05", "vault_instant"]);
});

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── Bước 07 · shard_nft (từ sổ) · commit · vault_schedule");
const s07 = (shardPolicyId: string) => ({ ...lamp, shardPolicyId, msPerEpoch, windowOriginMs, ...beacons });
await testCase("kỳ vọng đúng ⟹ qua, hash = computeClusterHashes", () => {
  const x = scheduleVaultChecked(bp.schedule, s07(right.shard_nft!), right, quiet);
  assertEq(x.commitHash, right.commit, "commit");
  assertEq(x.vaultHash, right.vault_schedule, "vault_schedule");
});
await testCase("commit LỆCH ⟹ ném 'bước 07'", () => {
  mustThrow(() => scheduleVaultChecked(bp.schedule, s07(right.shard_nft!), bent("commit"), quiet), ["bước 07", "commit", "KHÔNG nộp"]);
});
await testCase("sổ mang SHARD_NFT_POLICY_ID của đời khác ⟹ ném nêu đúng tên shard_nft", () => {
  mustThrow(() => scheduleVaultChecked(bp.schedule, s07("cd".repeat(28)), right, quiet), ["bước 07", "shard_nft:"]);
});

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── Bước 09 · price_nft · price_param · consume × ba loại két");
const vaultOf = { instant: right.vault_instant!, schedule: right.vault_schedule!, prepaid: right.vault_prepaid! };
const seedRole = { instant: "priceNftInstant", schedule: "priceNftSchedule", prepaid: "priceNftPrepaid" } as const;
const s09 = (kind: "instant" | "schedule" | "prepaid") => ({
  priceNftSeed: seedOf(seedRole[kind]),
  committee: inp.priceCommittee ?? [r.operatorPkh],
  threshold: BigInt(c.priceThreshold ?? "1"),
  vaultScriptHash: vaultOf[kind],
  maxPriceStale: BigInt(c.maxPriceStale ?? "1"),
  msPerEpoch, windowOriginMs,
});
for (const kind of ["instant", "schedule", "prepaid"] as const) {
  await testCase(`${kind}: kỳ vọng đúng ⟹ qua, ba hash = computeClusterHashes`, () => {
    const x = consumeChainChecked(bp.consume, kind, s09(kind), right, quiet);
    assertEq(x.priceNftPolicy, right[`price_nft_${kind}`], `price_nft_${kind}`);
    assertEq(x.priceParamHash, right[`price_param_${kind}`], `price_param_${kind}`);
    assertEq(x.consumeHash, right[`consume_${kind}`], `consume_${kind}`);
  });
  await testCase(`${kind}: consume_${kind} LỆCH ⟹ ném 'bước 09 (${kind})'`, () => {
    mustThrow(() => consumeChainChecked(bp.consume, kind, s09(kind), bent(`consume_${kind}`), quiet), [`bước 09 (${kind})`, `consume_${kind}`]);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── Bước 10 · paid_fund · vault_prepaid");
const s10 = () => ({ carpPolicyId: c.carpPolicyId!, carpAssetName: c.carpAssetName!, msPerEpoch, windowOriginMs, wakemeVaultHash: wakeme });
await testCase("kỳ vọng đúng ⟹ qua, hai hash = computeClusterHashes", () => {
  const x = prepaidPairChecked(bp.prepaid, s10(), right, quiet);
  assertEq(x.fundHash, right.paid_fund, "paid_fund");
  assertEq(x.vaultHash, right.vault_prepaid, "vault_prepaid");
});
await testCase("paid_fund LỆCH ⟹ ném 'bước 10'", () => {
  mustThrow(() => prepaidPairChecked(bp.prepaid, s10(), bent("paid_fund"), quiet), ["bước 10", "paid_fund", "KHÔNG nộp"]);
});
await testCase("tệp THIẾU vault_prepaid ⟹ ném 'không có'", () => {
  mustThrow(() => prepaidPairChecked(bp.prepaid, s10(), without("vault_prepaid"), quiet), ["bước 10", "vault_prepaid", "không có"]);
});

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── Bước 11 pha registry · vault_registry · vault_instant · vault_schedule");
await testCase("kỳ vọng đúng (thứ tự instant, schedule) ⟹ qua", () => {
  registryHashesChecked(right.vault_registry!, [right.vault_instant!, right.vault_schedule!], right, quiet);
});
await testCase("hai két ĐẢO thứ tự ⟹ ném nêu vault_instant", () => {
  mustThrow(() => registryHashesChecked(right.vault_registry!, [right.vault_schedule!, right.vault_instant!], right, quiet), ["bước 11 pha registry", "vault_instant"]);
});
await testCase("vault_schedule LỆCH ⟹ ném", () => {
  mustThrow(() => registryHashesChecked(right.vault_registry!, [right.vault_instant!, right.vault_schedule!], bent("vault_schedule"), quiet), ["bước 11 pha registry", "vault_schedule"]);
});
await testCase("thiếu một hash két ⟹ ném trước khi so", () => {
  mustThrow(() => registryHashesChecked(right.vault_registry!, [right.vault_instant!], right, quiet), ["đúng 2 hash két"]);
});

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── main() của từng bước đi qua hàm 'tính + so' (không tự apply)");
const mainOf = (rel: string) => {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  const i = src.indexOf("async function main");
  if (i < 0) throw new Error(`${rel}: không thấy main`);
  return src.slice(i);
};
const wiring: [string, string, string[]][] = [
  ["./deploy/03_deploy_shards.ts", "shardStepChecked(", ["shardNftPolicyFor(", "scheduleShardScript("]],
  ["./deploy/05_create_instant_vault.ts", "instantVaultChecked(", ["instantVaultParams(", "appliedScript("]],
  ["./deploy/07_create_schedule_vault.ts", "scheduleVaultChecked(", ["scheduleScriptPair("]],
  ["./deploy/09_deploy_consume.ts", "consumeChainChecked(", ["consumeScriptChain("]],
  ["./deploy/10_deploy_prepaid.ts", "prepaidPairChecked(", ["prepaidScriptPair("]],
];
for (const [rel, must, mustNot] of wiring) {
  await testCase(`${rel.replace("./deploy/", "")}: gọi ${must.slice(0, -1)}, không tự apply`, () => {
    const m = mainOf(rel);
    if (!m.includes(must)) throw new Error(`main không gọi ${must}`);
    for (const n of mustNot) if (m.includes(n)) throw new Error(`main tự gọi ${n} — đường apply không qua phép so`);
    if (!/loadExpectedHashes\(process\.env\)/.test(m)) throw new Error("main không đọc DEPLOY_EXPECT_HASHES");
    if (!/requireExpectInPresetMode\(/.test(m)) throw new Error("main không gọi requireExpectInPresetMode");
  });
}
await testCase("11: pha registry truyền expectHashes vào runRegistryPhase; 03/09/11 gọi assertDistinctPresetSeeds", () => {
  const m11 = mainOf("./deploy/11_deploy_gen_beacons.ts");
  if (!/runRegistryPhase\(chain, \{[^}]*expectHashes[^}]*\}\)/.test(m11)) throw new Error("runRegistryPhase không nhận expectHashes");
  for (const rel of ["./deploy/03_deploy_shards.ts", "./deploy/09_deploy_consume.ts", "./deploy/11_deploy_gen_beacons.ts"]) {
    if (!mainOf(rel).includes("assertDistinctPresetSeeds(process.env")) throw new Error(`${rel}: main không gọi assertDistinctPresetSeeds`);
  }
  for (const rel of ["./deploy/03_deploy_shards.ts", "./deploy/09_deploy_consume.ts"]) {
    if (!mainOf(rel).includes("allowWallet: presetSeedAllowWallet(expectHashes)")) throw new Error(`${rel}: allowWallet không theo tệp kỳ vọng`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── Seed trùng vai");
const reg = inp.seeds.registry!, shard = inp.seeds.shardNft!, pi = inp.seeds.priceNftInstant!;
await testCase("DEPLOY_SEED_SHARD_NFT = seed sổ két (DEPLOY_SEED_REGISTRY) ⟹ ném nêu cả hai biến", () => {
  mustThrow(() => assertDistinctPresetSeeds({ [SEED_ENV.registry]: reg, [SEED_ENV.shardNft]: reg }), ["trùng vai", SEED_ENV.registry, SEED_ENV.shardNft]);
});
await testCase("DEPLOY_SEED_PRICE_NFT_INSTANT = seed sổ két đã ghi ở SỔ (không có trong env) ⟹ ném 'SỔ KÉT'", () => {
  mustThrow(() => assertDistinctPresetSeeds({ [SEED_ENV.priceNftInstant]: reg }, [reg]), ["SỔ KÉT", SEED_ENV.priceNftInstant]);
});
await testCase("DEPLOY_SEED_REGISTRY = seed sổ két ở sổ ⟹ qua (đúng vai); seed khác nhau đôi một ⟹ qua", () => {
  assertDistinctPresetSeeds({ [SEED_ENV.registry]: reg, [SEED_ENV.shardNft]: shard, [SEED_ENV.priceNftInstant]: pi }, [reg]);
});
await testCase("đầu vào clusterHashes: hai vai cùng outref ⟹ ném", () => {
  const raw = JSON.parse(readFileSync(VECTOR, "utf8")) as { seeds: Record<string, string> };
  raw.seeds.shardNft = raw.seeds.registry!;
  mustThrow(() => parseClusterHashInput(raw, "dup"), ["trùng outref", "registry = shardNft"]);
});

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── Có seed mà vắng tệp kỳ vọng");
await testCase("có DEPLOY_SEED_* mà vắng DEPLOY_EXPECT_HASHES ⟹ ném nêu biến", () => {
  mustThrow(() => requireExpectInPresetMode("bước 03", { [SEED_ENV.shardNft]: shard }, undefined), ["bước 03", SEED_ENV.shardNft, EXPECT_HASHES_ENV, EXPECT_NONE_ENV]);
});
await testCase("bước KHÔNG có seed riêng (05) vẫn ném khi env đang ở chế độ seed cho trước", () => {
  mustThrow(() => requireExpectInPresetMode("bước 05", { [SEED_ENV.registry]: reg }, undefined), ["bước 05", EXPECT_HASHES_ENV]);
});
await testCase(`${EXPECT_NONE_ENV}=1 ⟹ qua; đặt cùng ${EXPECT_HASHES_ENV} ⟹ ném mâu thuẫn; không seed, không tệp ⟹ qua`, () => {
  requireExpectInPresetMode("bước 03", { [SEED_ENV.shardNft]: shard, [EXPECT_NONE_ENV]: "1" }, undefined);
  mustThrow(() => requireExpectInPresetMode("bước 03", { [EXPECT_NONE_ENV]: "1" }, right), ["chọn một"]);
  requireExpectInPresetMode("bước 03", {}, undefined);
  assertEq(presetModeOn({}), false, "presetModeOn({})");
});
await testCase("có tệp kỳ vọng ⟹ seed ở VÍ không được nhận (allowWallet=false); vắng tệp ⟹ nhận", () => {
  assertEq(presetSeedAllowWallet(right), false, "có tệp");
  assertEq(presetSeedAllowWallet(undefined), true, "vắng tệp");
});

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── clusterHashes: Wakeme đầu vào ≠ hằng mã");
await testCase("khác hằng mã, không cờ ⟹ ném nêu bước 05/10", () => {
  mustThrow(() => checkWakemeAgainstCode({ network: net, wakemeVaultHash: wakeme }, false, () => "ef".repeat(28), quiet), ["05/10", "--wakeme-ahead-of-code"]);
});
await testCase("khác hằng mã + --wakeme-ahead-of-code ⟹ qua, in cảnh báo bước 05/10 sẽ NÉM", () => {
  const lines: string[] = [];
  checkWakemeAgainstCode({ network: net, wakemeVaultHash: wakeme }, true, () => "ef".repeat(28), (l) => lines.push(l));
  if (!lines.some((l) => l.includes("Bước 05") && l.includes("NÉM"))) throw new Error(`không có dòng cảnh báo: ${lines.join(" | ")}`);
});
await testCase("trùng hằng mã ⟹ qua; mạng chưa có hằng ⟹ coi là khác ⟹ ném", () => {
  checkWakemeAgainstCode({ network: net, wakemeVaultHash: wakeme }, false, () => wakeme, quiet);
  mustThrow(() => checkWakemeAgainstCode({ network: net, wakemeVaultHash: wakeme }, false, () => { throw new Error("x"); }, quiet), ["mã chưa có"]);
});

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── park_seeds DRY_RUN");
await testCase("DRY_RUN ⟹ mọi dòng DEPLOY_SEED_* và mọi dòng khối JSON mang tiền tố; chạy thật ⟹ không", () => {
  const seeds = { registry: seedOf("registry"), shardNft: seedOf("shardNft") };
  const dry: string[] = [];
  printSeeds(seeds, (l) => dry.push(l), true);
  // Mọi dòng không phải tiêu đề 📋 là dòng dán-được: 2 dòng env + 4 dòng JSON ("seeds": {, hai vai, }).
  const pasteable = dry.flatMap((l) => l.split("\n")).filter((l) => l.trim() !== "" && !l.includes("📋"));
  assertEq(pasteable.length, 6, "số dòng dán-được");
  const bare = pasteable.filter((l) => !l.trimStart().startsWith(DRY_RUN_PREFIX));
  if (bare.length > 0) throw new Error(`dòng KHÔNG có tiền tố: ${bare.join(" | ")}`);
  const live: string[] = [];
  printSeeds(seeds, (l) => live.push(l), false);
  if (live.some((l) => l.includes(DRY_RUN_PREFIX))) throw new Error("chạy thật mà có tiền tố DRY_RUN");
});

console.log(failures === 0 ? "\n=== ĐẠT ===" : `\n=== HỎNG: ${failures} ca sai ===`);
if (failures !== 0) process.exit(1);
