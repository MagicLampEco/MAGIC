// scripts/test/test_gen_v2_chain.ts — kiểm OFFLINE phần thuần của `genV2Chain.ts` (không mạng,
// không ví, không gửi gì). Mỗi cổng một CẶP ca: ca đúng + ca chỉ khác đúng một ô bị từ chối.
//
//   npx tsx test/test_gen_v2_chain.ts      (thoát 0 = mọi ca đạt; 1 = có ca hỏng, in tên ca)

import type { UTxO } from "@lucid-evolution/lucid";
import {
  parseInstantM, pickByNft, readGenV2E2eBook, requireOutRefKey, resolveInstantM,
} from "./genV2Chain.js";

const H = (c: string) => c.repeat(56);
const TX = "ab".repeat(32);
const FULL_BOOK: Record<string, string> = {
  RATE_PARAM_HASH:          H("1"),
  GREENBACK_BEACON_HASH:    H("2"),
  GB_SHARD_HASH:            H("3"),
  GB_SHARD_CAP_NANOGIC:     "1800000000000000",
  VAULT_REGISTRY_HASH:      H("4"),
  REF_GB_SHARD_UTXO:        `${TX}#0`,
  REF_COMMIT_SCHEDULE_UTXO: `${TX}#1`,
};

let failed = 0, passed = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failed++;
  console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}
// Câu lỗi phải chứa MỌI mẩu trong `needles`: ca "thiếu khoá" đòi cả tên khoá lẫn chữ "thiếu",
// vì một khoá vắng cũng làm cổng DẠNG phía sau ném với đúng tên khoá — chỉ so tên thì ca
// xanh cả khi cổng thiếu-khoá bị gỡ (đo bằng đột biến, xem báo cáo gói s5).
function throwsWith(name: string, fn: () => unknown, ...needles: string[]): void {
  try {
    fn();
    ok(name, false, "không ném");
  } catch (e) {
    const msg = (e as Error).message;
    const miss = needles.filter((n) => !msg.includes(n));
    ok(name, miss.length === 0, `ném nhưng câu thiếu ${miss.map((n) => `"${n}"`).join(", ")}: ${msg.slice(0, 200)}`);
  }
}
function without(k: string): Record<string, string> {
  const b = { ...FULL_BOOK };
  delete b[k];
  return b;
}

// ── readGenV2E2eBook ──────────────────────────────────────────────────────────
{
  const g = readGenV2E2eBook(FULL_BOOK, { withScheduleCommit: true });
  ok("book đủ: rate", g.beacons.rateScriptHash === H("1") && g.beacons.rateNftPolicy === H("1"));
  ok("book đủ: gbb", g.beacons.gbBeaconScriptHash === H("2") && g.beacons.gbBeaconNftPolicy === H("2"));
  ok("book đủ: gb shard", g.beacons.gbShardPolicyId === H("3"));
  ok("book đủ: cap", g.gbShardCapNanogic === 1_800_000_000_000_000n);
  ok("book đủ: registry", g.vaultRegistryHash === H("4"));
  ok("book đủ: ref gb shard", g.refGbShardOutRef.txHash === TX && g.refGbShardOutRef.outputIndex === 0);
  ok("book đủ: ref commit", g.refCommitOutRef?.outputIndex === 1);
  const gi = readGenV2E2eBook(without("REF_COMMIT_SCHEDULE_UTXO"), { withScheduleCommit: false });
  ok("instant không đòi ref commit", gi.refCommitOutRef === undefined);
}
for (const k of ["GB_SHARD_CAP_NANOGIC", "VAULT_REGISTRY_HASH", "REF_GB_SHARD_UTXO", "REF_COMMIT_SCHEDULE_UTXO"]) {
  throwsWith(`thiếu ${k} ⟹ ném nêu tên`, () => readGenV2E2eBook(without(k), { withScheduleCommit: true }), k, "thiếu");
}
for (const k of ["RATE_PARAM_HASH", "GREENBACK_BEACON_HASH", "GB_SHARD_HASH"]) {
  throwsWith(`thiếu ${k} ⟹ ném nêu tên (qua genV2BeaconRefsFromBook)`,
    () => readGenV2E2eBook(without(k), { withScheduleCommit: false }), k, "thiếu");
}
{
  const two = without("VAULT_REGISTRY_HASH");
  delete two.REF_GB_SHARD_UTXO;
  throwsWith("thiếu HAI khoá ⟹ kể đủ cả hai (1/2)", () => readGenV2E2eBook(two, { withScheduleCommit: false }), "VAULT_REGISTRY_HASH");
  throwsWith("thiếu HAI khoá ⟹ kể đủ cả hai (2/2)", () => readGenV2E2eBook(two, { withScheduleCommit: false }), "REF_GB_SHARD_UTXO");
}
throwsWith("cap = 0 ⟹ ném", () => readGenV2E2eBook({ ...FULL_BOOK, GB_SHARD_CAP_NANOGIC: "0" }, { withScheduleCommit: false }), "GB_SHARD_CAP_NANOGIC");
throwsWith("registry HOA ⟹ ném", () => readGenV2E2eBook({ ...FULL_BOOK, VAULT_REGISTRY_HASH: "A".repeat(56) }, { withScheduleCommit: false }), "VAULT_REGISTRY_HASH");
throwsWith("ref gb shard sai dạng ⟹ ném", () => readGenV2E2eBook({ ...FULL_BOOK, REF_GB_SHARD_UTXO: `${TX}#x` }, { withScheduleCommit: false }), "REF_GB_SHARD_UTXO");
throwsWith("requireOutRefKey vắng ⟹ ném nêu khoá", () => requireOutRefKey({}, "REF_SHARD_UTXO", "gợi ý"), "REF_SHARD_UTXO");
ok("requireOutRefKey đúng dạng", requireOutRefKey({ REF_SHARD_UTXO: `${TX}#7` }, "REF_SHARD_UTXO", "x").outputIndex === 7);

// ── parseInstantM / resolveInstantM ───────────────────────────────────────────
throwsWith("INSTANT_M vắng ⟹ ném (không mặc định)", () => parseInstantM(undefined, "INSTANT_M"), "INSTANT_M bắt buộc");
throwsWith("INSTANT_M rỗng ⟹ ném", () => parseInstantM("", "INSTANT_M"), "INSTANT_M bắt buộc");
throwsWith("INSTANT_M = 0 ⟹ ném", () => parseInstantM("0", "INSTANT_M"), "không hợp lệ");
throwsWith("INSTANT_M = 1.5 ⟹ ném", () => parseInstantM("1.5", "INSTANT_M"), "không hợp lệ");
{
  const c = parseInstantM("1000", "INSTANT_M");
  ok("INSTANT_M = 1000 ⟹ exact 1000", c.kind === "exact" && c.m === 1000n);
  ok("m == trần ⟹ nhận", resolveInstantM(c, 1000n, "INSTANT_M") === 1000n);
  throwsWith("m == trần + 1 ⟹ ném", () => resolveInstantM(c, 999n, "INSTANT_M"), "vượt trần");
  ok("max ⟹ lấy trần", resolveInstantM(parseInstantM("max", "INSTANT_M"), 42n, "INSTANT_M") === 42n);
  throwsWith("max với trần 0 ⟹ ném", () => resolveInstantM({ kind: "max" }, 0n, "INSTANT_M"), "maxM = 0");
}

// ── pickByNft ─────────────────────────────────────────────────────────────────
{
  const unit = H("5") + "474242";
  const mk = (i: number, q: bigint): UTxO => ({
    txHash: TX, outputIndex: i, address: "addr_test", assets: { lovelace: 2_000_000n, [unit]: q },
  } as UTxO);
  ok("đúng 1 NFT ⟹ chọn nó", pickByNft([mk(0, 1n), mk(1, 0n)], unit, "beacon").outputIndex === 0);
  throwsWith("0 UTxO mang NFT ⟹ ném", () => pickByNft([mk(1, 0n)], unit, "beacon"), "thấy 0");
  throwsWith("2 UTxO mang NFT ⟹ ném, không chọn đại", () => pickByNft([mk(0, 1n), mk(1, 1n)], unit, "beacon"), "thấy 2");
  throwsWith("số lượng 2 không phải NFT ⟹ ném", () => pickByNft([mk(0, 2n)], unit, "beacon"), "thấy 0");
}

console.log(`${passed} ca đạt · ${failed} ca hỏng`);
if (failed > 0) process.exit(1);
console.log("TRẠNG THÁI: mọi ca đạt.");
