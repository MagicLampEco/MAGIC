// scripts/test_deploy_gen_beacons.ts — bộ ca cho `deploy/11_deploy_gen_beacons.ts`, chạy TRỌN luồng
// deploy trên Lucid Emulator (UPLC đánh giá thật trong `complete()`), ghi vào một sổ GIẢ trong
// thư mục tạm, rồi đưa sổ đó qua bộ sinh deployment và bộ nạp của VaultTxAPI.
// Không gọi mạng, không đọc sổ thật, không đọc khoá.
// Chạy từ scripts/:  npx tsx test_deploy_gen_beacons.ts
// Dòng cuối: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===` (mã thoát 1).
//
// Trọng tài cuối là CHÍNH `VaultTxAPI/src/config.ts ▸ parseDeployment`, như ở
// `test_gen_vault_tx_api_deployment.ts`: sổ do bước deploy ghi phải đi qua đúng hàm dịch vụ gọi
// lúc khởi động.
//
// Hash két trong sổ giả là GIẢ (56 hex): bộ này đo bước GenBeacons + chỗ nối với bộ sinh, không
// đo két v2.0 (tham số két thuộc `deployParams.ts`).

import { windowOriginMs, windowStartMs } from "@magiclamp/protocol-utils";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialToAddress,
  Emulator,
  generateEmulatorAccount,
  Lucid,
  PROTOCOL_PARAMETERS_DEFAULT,
  scriptHashToCredential,
  validatorToScriptHash,
  type LucidEvolution,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  appendStateBook,
  beaconsBookEntries,
  bookToRecord,
  compiledGbShardCap,
  compiledRhoMaxQ,
  KEY,
  PHASE_KEYS,
  readBookEntries,
  registryBookEntries,
  registryInputsFromBook,
  runBeaconsPhase,
  runRegistryPhase,
  type BeaconsPhaseResult,
  type Chain,
  type RegistryPhaseResult,
} from "./deploy/11_deploy_gen_beacons.js";
import { buildDeployment, GEN_V2_STATE_KEYS, type StateBook } from "./gen_vault_tx_api_deployment.js";
import { consumeKey, vaultHashKey } from "./consumeBook.js";
import { parseDeployment } from "../VaultTxAPI/src/config.js";
import {
  decodeGbShard,
  decodeGreenBackBeacon,
  decodeRateParam,
  decodeVaultRegistry,
  loadBlueprint,
  SHARD_COUNT,
} from "../GenBeacons/offchain/src/index.js";

let sai = 0;
async function ca(ten: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${ten}`);
  } catch (e) {
    sai++;
    console.log(`  ✗ ${ten}\n      ${(e as Error).message.split("\n")[0]}`);
  }
}
function bang<T>(thuc: T, cho: T, nhan: string) {
  if (thuc !== cho) throw new Error(`${nhan}: nhận ${String(thuc)}, chờ ${String(cho)}`);
}
async function phaiNem(fn: () => unknown, chua: string[]): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const m = (e as Error).message;
    for (const c of chua) if (!m.includes(c)) throw new Error(`ném nhưng câu lỗi thiếu "${c}": ${m.split("\n")[0]}`);
    return m;
  }
  throw new Error("KHÔNG ném");
}

// ── Emulator ──────────────────────────────────────────────────────────────────
// Mạng của địa chỉ = Preprod (cùng hình dạng với DRY_RUN của bước 11: Emulator "Custom" có
// network id 0 như Preprod). Đồng hồ ghim đầu epoch + 60 s để `epochValidityWindow` nằm gọn
// trong một epoch — cùng cách `GenBeacons/offchain/tests/e2e.test.ts` làm.
const NET = "Preprod" as const;
const MS_PER_EPOCH = 3_600_000n;
// Gốc cửa sổ thật của Preprod (khác 0 — gốc 0 không phân biệt bản trừ gốc với bản quên trừ).
// EPOCH0 đếm TỪ GỐC: `windowStartMs(40_544, 1h, gốc Preprod)` = 1_800_000_000_000 ms, đúng mốc
// tuyệt đối của bản trước (500_000 × 1h tính từ 0).
const WO = windowOriginMs(NET);
const EPOCH0 = 40_544n;
// ρ khởi đầu: giá trị TẠM của SPEC v2.0 §12 (`generation_rate_q = 4·10⁹`, CC-GEN-RATE-VALUE).
// Ở bước deploy thật nó là env BẮT BUỘC; ở đây là đầu vào của ca.
const RHO_Q = 4_000_000_000n;

const deployer = generateEmulatorAccount({ lovelace: 100_000_000_000n });
const emulator = new Emulator([deployer]);
emulator.time = Number(windowStartMs(EPOCH0, MS_PER_EPOCH, WO) + 60_000n);
const lucid: LucidEvolution = await Lucid(emulator, "Custom");
lucid.selectWallet.fromSeed(deployer.seedPhrase);

const chain: Chain = {
  lucid,
  network: NET,
  nowMs: () => emulator.now(),
  log: () => {},
  submit: async (signed) => {
    const h = await signed.submit();
    emulator.awaitBlock(1);
    return h;
  },
};
const blueprint = loadBlueprint();

// ── Sổ giả: các khoá KHÔNG thuộc bước 11 (cùng hình dạng với fixture của bộ ca bộ sinh) ──
const h = (b: string) => b.repeat(28);
const addr = (hash: string) => credentialToAddress(NET, scriptHashToCredential(hash));
const outref = (b: string, ix: number) => `${b.repeat(32)}#${ix}`;
const BASE: [string, string][] = [
  ["LAMP_POLICY_ID", h("a1")],
  ["SHARD_HASH", h("a2")],
  ["REF_SHARD_UTXO", outref("a3", 1)],
  ["VAULT_INSTANT_ADDR", addr(h("a4"))],
  ["REF_VAULT_INSTANT_UTXO", outref("a5", 0)],
  [consumeKey("CONSUME_ADDRESS", "instant"), addr(h("a8"))],
  [consumeKey("PRICE_PARAM_HASH", "instant"), h("a9")],
  [consumeKey("PRICE_NFT_UNIT", "instant"), h("aa") + "5052494345"],
  [consumeKey("MAX_PRICE_STALE", "instant"), "1"],
  [consumeKey("REF_CONSUME_UTXO", "instant"), outref("ab", 2)],
  ["ANCHOR_NFT_POLICY", h("ac")],
];
// Hash két GIẢ, ghi SAU pha beacons (như bước 05/07 thật sẽ ghi).
const VAULT_INSTANT_HASH = h("d1");
const VAULT_SCHEDULE_HASH = h("d2");
const META = { sourcePath: "scripts/state.Preprod.sh (GIẢ)", mtime: "2026-09-30T00:00:00Z", sha: "testsha" };

// Thư mục của sổ giả: `GEN_BEACONS_TEST_DIR` nếu đặt (không dùng TMPDIR — tsx mở socket IPC
// trong TMPDIR, và một đường dài vượt trần độ dài đường socket), không thì thư mục tạm hệ thống.
const dir = mkdtempSync(join(process.env.GEN_BEACONS_TEST_DIR ?? tmpdir(), "gen-beacons-book-"));
const bookPath = join(dir, "state.Preprod.sh");
writeFileSync(bookPath, "#!/usr/bin/env bash\n# sổ GIẢ của test_deploy_gen_beacons.ts\n");
appendStateBook(bookPath, BASE, "khoá nền (giả)");

const gen = (book: StateBook) => JSON.stringify(buildDeployment(book, NET, "Instant", META).deployment);
const only = async (unit: string): Promise<UTxO> => {
  const u = (await emulator.getUtxoByUnit(unit)) as UTxO | undefined;
  if (!u) throw new Error(`không có UTxO nào mang ${unit}`);
  return u;
};

// ══════════════════════════════════════════════════════════════════════════════
console.log("── Pha beacons trên Emulator");
let beacons: BeaconsPhaseResult | undefined;
await ca("chạy pha beacons: seed ×4 → mint → ref gb_shard, mọi tx ≤ maxTxSize", async () => {
  beacons = await runBeaconsPhase(chain, {
    blueprint,
    msPerEpoch: MS_PER_EPOCH,
    windowOriginMs: WO,
    rhoQ: RHO_Q,
    rhoMaxQ: compiledRhoMaxQ(),
    gbShardCapNanogic: compiledGbShardCap(),
  });
  const limit = lucid.config().protocolParameters!.maxTxSize;
  for (const t of beacons.txs) {
    console.log(`      · ${t.label.padEnd(34)} ${String(t.bytes).padStart(6)} B  ${t.hash}`);
    if (t.bytes > limit) throw new Error(`${t.label} ${t.bytes} B > ${limit}`);
  }
  console.log(`      · mint ${beacons.combinedMint ? "GỘP một tx" : "TÁCH ba tx"} · trần ${limit} B`);
});
if (!beacons) {
  console.log(`=== HỎNG: pha beacons không chạy được, dừng ===`);
  process.exit(1);
}
const B = beacons;

await ca("trên chuỗi: RHO/GBB đúng địa chỉ + datum genesis; 16 GBS; ref mang đúng hash gb_shard", async () => {
  const rho = await only(B.scripts.rate.nftUnit);
  bang(rho.address, B.scripts.rate.address, "địa chỉ beacon ρ");
  const rp = decodeRateParam(rho.datum);
  bang(rp.rho_q, RHO_Q, "rho_q");
  const gbb = await only(B.scripts.greenback.nftUnit);
  bang(gbb.address, B.scripts.greenback.address, "địa chỉ beacon GB");
  const gb = decodeGreenBackBeacon(gbb.datum);
  bang(gb.gb_nanogic, 0n, "gb_nanogic genesis");
  bang(gb.seq, 0n, "seq genesis");
  for (let i = 0n; i < SHARD_COUNT; i++) {
    const s = await only(B.scripts.gbShard.nftUnit(i));
    bang(s.address, B.scripts.gbShard.address, `địa chỉ shard ${i}`);
    bang(decodeGbShard(s.datum).shard_id, i, `shard_id ${i}`);
  }
  const [txHash, ix] = B.refGbShardUtxo.split("#");
  const [ref] = await emulator.getUtxosByOutRef([{ txHash: txHash!, outputIndex: Number(ix) }]);
  if (!ref?.scriptRef) throw new Error("UTxO ref không mang scriptRef");
  bang(validatorToScriptHash(ref.scriptRef), B.scripts.gbShard.hash, "hash ref-script");
  bang(B.scripts.gbShard.capNanogic, compiledGbShardCap(), "cap đã apply = hằng két");
  const [seed] = await emulator.getUtxosByOutRef([B.registrySeed]);
  if (!seed) throw new Error("seed sổ không còn — pha registry sẽ không đúc được");
});

appendStateBook(bookPath, beaconsBookEntries(B), "11_deploy_gen_beacons · pha beacons (test)");
const afterBeacons = readFileSync(bookPath, "utf8");

console.log("── Fail-closed giữa hai pha");
await ca("sau pha beacons, CHƯA đúc sổ ⟹ bộ sinh từ chối, nêu VAULT_REGISTRY_HASH", async () => {
  await phaiNem(() => gen(bookToRecord(readBookEntries(bookPath))), [KEY.VAULT_REGISTRY_HASH]);
});
await ca("pha beacons KHÔNG ghi VAULT_REGISTRY_HASH", () => {
  if (beaconsBookEntries(B).some(([k]) => k === KEY.VAULT_REGISTRY_HASH)) throw new Error("pha beacons có ghi");
});

console.log("── Cổng thứ tự của pha registry");
await ca("âm: hash két ghi TRƯỚC GB_SHARD_HASH ⟹ registryInputsFromBook ném", async () => {
  const p = join(dir, "order-bad.sh");
  writeFileSync(p, "");
  appendStateBook(p, [[vaultHashKey("instant"), VAULT_INSTANT_HASH], [vaultHashKey("schedule"), VAULT_SCHEDULE_HASH]], "két cũ");
  appendStateBook(p, beaconsBookEntries(B), "pha beacons");
  await phaiNem(() => registryInputsFromBook(readBookEntries(p)), [vaultHashKey("instant"), "TRƯỚC"]);
});
await ca("dương (cặp): cùng các dòng, két ghi SAU ⟹ nhận, đúng thứ tự [instant, schedule]", () => {
  const p = join(dir, "order-ok.sh");
  writeFileSync(p, "");
  appendStateBook(p, beaconsBookEntries(B), "pha beacons");
  appendStateBook(p, [[vaultHashKey("instant"), VAULT_INSTANT_HASH], [vaultHashKey("schedule"), VAULT_SCHEDULE_HASH]], "két mới");
  const r = registryInputsFromBook(readBookEntries(p));
  bang(r.vaultScriptHashes.join(","), `${VAULT_INSTANT_HASH},${VAULT_SCHEDULE_HASH}`, "vaultScriptHashes");
  bang(r.pendingHash, B.scripts.vaultRegistry.hash, "pendingHash");
});
await ca("âm: thiếu VAULT_SCHEDULE_HASH ⟹ ném (sổ bất biến, thiếu loại két là vĩnh viễn)", async () => {
  const p = join(dir, "no-schedule.sh");
  writeFileSync(p, "");
  appendStateBook(p, beaconsBookEntries(B), "pha beacons");
  appendStateBook(p, [[vaultHashKey("instant"), VAULT_INSTANT_HASH]], "chỉ một két");
  await phaiNem(() => registryInputsFromBook(readBookEntries(p)), [vaultHashKey("schedule")]);
});

// Két "dựng" sau pha beacons ⟹ nối đuôi vào sổ thật của bộ ca.
appendStateBook(
  bookPath,
  [[vaultHashKey("instant"), VAULT_INSTANT_HASH], [vaultHashKey("schedule"), VAULT_SCHEDULE_HASH]],
  "bước 05/07 (giả)",
);

console.log("── Pha registry trên Emulator");
await ca("âm: pendingHash lệch hash dựng lại từ seed ⟹ ném, KHÔNG gửi", async () => {
  const input = registryInputsFromBook(readBookEntries(bookPath));
  const before = (await emulator.getUtxosByOutRef([input.seed])).length;
  await phaiNem(() => runRegistryPhase(chain, { blueprint, ...input, pendingHash: h("ee") }), ["blueprint"]);
  bang((await emulator.getUtxosByOutRef([input.seed])).length, before, "seed còn nguyên");
});
let registry: RegistryPhaseResult | undefined;
await ca("dương (cặp): đọc đầu vào TỪ SỔ, đúc VRG với [instant, schedule]", async () => {
  registry = await runRegistryPhase(chain, { blueprint, ...registryInputsFromBook(readBookEntries(bookPath)) });
  console.log(`      · ${registry.tx.label.padEnd(34)} ${String(registry.tx.bytes).padStart(6)} B  ${registry.tx.hash}`);
  const reg = await only(B.scripts.vaultRegistry.nftUnit);
  bang(reg.address, B.scripts.vaultRegistry.address, "địa chỉ sổ");
  bang(decodeVaultRegistry(reg.datum).vault_script_hashes.join(","), `${VAULT_INSTANT_HASH},${VAULT_SCHEDULE_HASH}`, "datum sổ");
  bang((await emulator.getUtxosByOutRef([B.registrySeed])).length, 0, "seed sổ đã tiêu");
});
if (!registry) {
  console.log(`=== HỎNG: pha registry không chạy được, dừng ===`);
  process.exit(1);
}
appendStateBook(bookPath, registryBookEntries(registry), "11_deploy_gen_beacons · pha registry (test)");

console.log("── Sổ sau hai pha ⟹ bộ sinh ⟹ VaultTxAPI");
await ca("hai pha cộng lại ghi ĐỦ mọi khoá GEN_V2_STATE_KEYS, không khoá lạ ngoài PHASE_KEYS", () => {
  const written = new Set([...beaconsBookEntries(B), ...registryBookEntries(registry!)].map(([k]) => k));
  for (const k of Object.keys(GEN_V2_STATE_KEYS)) if (!written.has(k)) throw new Error(`thiếu ${k}`);
  const allowed = new Set([...Object.keys(GEN_V2_STATE_KEYS), ...Object.values(PHASE_KEYS)]);
  for (const k of written) if (!allowed.has(k)) throw new Error(`khoá lạ ${k}`);
});
await ca("dương: buildDeployment(--vault Instant) phát gen_v2; parseDeployment nạp không ném, giá trị khớp chuỗi", () => {
  const d = parseDeployment(gen(bookToRecord(readBookEntries(bookPath))), NET);
  if (d.genV2 === undefined) throw new Error("genV2 vắng");
  bang(d.genV2.rateScriptHash, B.scripts.rate.hash, "rateScriptHash");
  bang(d.genV2.rateNftPolicy, B.scripts.rate.hash, "rateNftPolicy");
  bang(d.genV2.gbBeaconScriptHash, B.scripts.greenback.hash, "gbBeaconScriptHash");
  bang(d.genV2.gbBeaconNftPolicy, B.scripts.greenback.hash, "gbBeaconNftPolicy");
  bang(d.genV2.gbShardPolicyId, B.scripts.gbShard.hash, "gbShardPolicyId");
  bang(d.genV2.gbShardCapNanogic, compiledGbShardCap(), "gbShardCapNanogic");
  bang(d.genV2.vaultRegistryPolicy, registry!.registryHash, "vaultRegistryPolicy");
  bang(`${d.refScriptUtxos.gbShard?.txHash}#${d.refScriptUtxos.gbShard?.outputIndex}`, B.refGbShardUtxo, "ref gb_shard");
});
await ca("âm (cặp, khác đúng MỘT dòng): bỏ bước công bố ref gb_shard ⟹ bộ sinh ném, nêu REF_GB_SHARD_UTXO", async () => {
  const entries = readBookEntries(bookPath).filter((e) => e.key !== KEY.REF_GB_SHARD_UTXO);
  await phaiNem(() => gen(bookToRecord(entries)), [KEY.REF_GB_SHARD_UTXO, "thiếu 1 khoá Gen v2.0"]);
});

console.log("── Ghi sổ");
await ca("appendStateBook: giá trị có khoảng trắng ⟹ ném, không ghi byte nào", async () => {
  const before = readFileSync(bookPath, "utf8");
  await phaiNem(() => appendStateBook(bookPath, [[KEY.GB_SHARD_HASH, "ab cd"]], "x"), [KEY.GB_SHARD_HASH]);
  bang(readFileSync(bookPath, "utf8"), before, "sổ không đổi");
});
await ca("sổ là nối đuôi: nội dung sau pha beacons là TIỀN TỐ của sổ cuối", () => {
  if (!readFileSync(bookPath, "utf8").startsWith(afterBeacons)) throw new Error("pha sau đã sửa dòng cũ");
});

console.log("── Đường TÁCH tx (trần hạ xuống 8.000 B trên một Emulator riêng)");
await ca("tx gộp vượt trần ⟹ tách ba tx, mỗi tx ≤ trần, đủ RHO + GBB + 16 GBS", async () => {
  const small = 8_000;
  const acc = generateEmulatorAccount({ lovelace: 100_000_000_000n });
  const emu = new Emulator([acc], { ...PROTOCOL_PARAMETERS_DEFAULT, maxTxSize: small });
  emu.time = Number(windowStartMs(EPOCH0, MS_PER_EPOCH, WO) + 60_000n);
  const l = await Lucid(emu, "Custom");
  l.selectWallet.fromSeed(acc.seedPhrase);
  const r = await runBeaconsPhase(
    { lucid: l, network: NET, nowMs: () => emu.now(), log: () => {}, submit: async (s) => { const x = await s.submit(); emu.awaitBlock(1); return x; } },
    { blueprint, msPerEpoch: MS_PER_EPOCH, windowOriginMs: WO, rhoQ: RHO_Q, rhoMaxQ: compiledRhoMaxQ(), gbShardCapNanogic: compiledGbShardCap() },
  );
  bang(r.combinedMint, false, "combinedMint");
  bang(r.txs.length, 5, "số tx (seed + 3 mint + ref)");
  for (const t of r.txs) {
    console.log(`      · ${t.label.padEnd(34)} ${String(t.bytes).padStart(6)} B`);
    if (t.bytes > small) throw new Error(`${t.label} ${t.bytes} B > ${small}`);
  }
  for (const unit of [r.scripts.rate.nftUnit, r.scripts.greenback.nftUnit, ...[...Array(16).keys()].map((i) => r.scripts.gbShard.nftUnit(BigInt(i)))]) {
    if (!(await emu.getUtxoByUnit(unit))) throw new Error(`thiếu ${unit}`);
  }
});

console.log(`   sổ giả: ${bookPath}`);
console.log(sai === 0 ? "=== ĐẠT ===" : `=== HỎNG: ${sai} ca sai ===`);
if (sai !== 0) process.exit(1);
