// scripts/test_deploy_preset_seeds.ts — bộ ca cho đường SEED CHO TRƯỚC của bước 11 pha `beacons` và
// phép so hash kỳ vọng của pha `registry` (`deploySeeds.ts` + `deploy/park_seeds.ts` +
// `deploy/11_deploy_gen_beacons.ts ▸ runBeaconsPhase / runRegistryPhase`),
// chạy trên Lucid Emulator (UPLC đánh giá thật trong `complete()`). Không gọi mạng, không đọc khoá.
// Chạy từ scripts/:  npx tsx test_deploy_preset_seeds.ts
// Dòng cuối: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===` (mã thoát 1).
//
// Hành vi KHÔNG seed (bước tự tạo bốn seed như cũ) do `test_deploy_gen_beacons.ts` canh; bộ này
// chỉ canh đường có seed cho trước. Seed được đỗ bằng CHÍNH `park_seeds.ts ▸ parkSeeds` trên
// Emulator, nên bãi đỗ, script native và hình dạng output là thứ bước deploy thật sẽ gặp.

import { windowOriginMs, windowStartMs } from "@magiclamp/protocol-utils";
import {
  Data,
  Emulator,
  generateEmulatorAccount,
  Lucid,
  type LucidEvolution,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  compiledGbShardCap,
  compiledRhoMaxQ,
  runBeaconsPhase,
  runRegistryPhase,
  beaconScriptsChecked,
  type BeaconsPhaseInput,
  type Chain,
} from "./deploy/11_deploy_gen_beacons.js";
import { parkSeeds } from "./deploy/park_seeds.js";
import {
  BEACON_SEED_ROLES,
  outRefString,
  parkFor,
  presetSeedAllowWallet,
  readBeaconPresetSeeds,
  resolvePresetSeed,
  SEED_ENV,
  type BeaconPresetSeeds,
  type ExpectedHashes,
} from "./deploySeeds.js";
import type { OutRef } from "./runResult.js";
import { loadBlueprint, SHARD_COUNT } from "../GenBeacons/offchain/src/index.js";

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
async function mustThrow(fn: () => unknown, parts: string[]): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const m = (e as Error).message;
    for (const c of parts) if (!m.includes(c)) throw new Error(`ném nhưng câu lỗi thiếu "${c}": ${m.split("\n")[0]}`);
    return m;
  }
  throw new Error("KHÔNG ném");
}

// ── Emulator (cùng hình dạng với test_deploy_gen_beacons.ts) ─────────────────────
const NET = "Preprod" as const;
const MS_PER_EPOCH = 3_600_000n;
const WO = windowOriginMs(NET);
const EPOCH0 = 40_544n;
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
const walletAddress = await lucid.wallet().address();
const park = parkFor(NET, walletAddress);

const base = (presetSeeds?: BeaconPresetSeeds, expectHashes?: ExpectedHashes): BeaconsPhaseInput => ({
  blueprint,
  msPerEpoch: MS_PER_EPOCH,
  windowOriginMs: WO,
  rhoQ: RHO_Q,
  rhoMaxQ: compiledRhoMaxQ(),
  gbShardCapNanogic: compiledGbShardCap(),
  presetSeeds,
  expectHashes,
});
const unspent = async (refs: OutRef[]): Promise<number> => (await emulator.getUtxosByOutRef(refs)).length;
const seedRefs = (s: BeaconPresetSeeds): OutRef[] => BEACON_SEED_ROLES.map((r) => s[r]);
const quiet = () => {};

// ══════════════════════════════════════════════════════════════════════════════
console.log("── Đỗ seed bằng park_seeds.ts trên Emulator");
const parked = await parkSeeds(chain, BEACON_SEED_ROLES);
const seeds: BeaconPresetSeeds = {
  registry: parked.seeds.registry, greenback: parked.seeds.greenback, gbShard: parked.seeds.gbShard, rate: parked.seeds.rate,
};
await testCase("bốn seed nằm ở bãi đỗ, còn chưa tiêu, khác nhau đôi một", async () => {
  const us = await emulator.getUtxosByOutRef(seedRefs(seeds));
  assertEq(us.length, 4, "số seed trên chuỗi");
  for (const u of us) assertEq(u.address, park.parkAddress, `địa chỉ ${outRefString(u)}`);
  assertEq(new Set(seedRefs(seeds).map(outRefString)).size, 4, "số outref khác nhau");
});

// Hash kỳ vọng ĐÚNG = hash mà chính hàm của bước 11 dựng từ bốn seed (không tự apply lại ở đây).
const right = beaconScriptsChecked(base(), NET, park.walletPkh, seeds, quiet);
const expectRight: ExpectedHashes = {
  vault_registry: right.vaultRegistry.hash,
  greenback_beacon: right.greenback.hash,
  gb_shard: right.gbShard.hash,
  rate_param: right.rate.hash,
};

console.log("── Ca âm: phải NÉM trước mọi tx, bốn seed còn nguyên");
await testCase("hash kỳ vọng LỆCH (gb_shard) ⟹ ném 'KHÔNG nộp', 4 seed chưa tiêu, không beacon nào được đúc", async () => {
  const bad = { ...expectRight, gb_shard: "00".repeat(28) };
  await mustThrow(() => runBeaconsPhase(chain, base(seeds, bad)), ["KHÔNG nộp", "gb_shard", "00".repeat(28)]);
  assertEq(await unspent(seedRefs(seeds)), 4, "seed còn chưa tiêu");
  assertEq(await emulator.getUtxoByUnit(right.rate.nftUnit).catch(() => undefined), undefined, "beacon ρ không có");
});
await testCase("tệp kỳ vọng THIẾU một tên (rate_param) ⟹ ném, 4 seed chưa tiêu", async () => {
  const { rate_param: _drop, ...missing } = expectRight;
  await mustThrow(() => runBeaconsPhase(chain, base(seeds, missing)), ["rate_param", "không có"]);
  assertEq(await unspent(seedRefs(seeds)), 4, "seed còn chưa tiêu");
});
await testCase("có hash kỳ vọng mà KHÔNG có seed cho trước ⟹ ném, ví không tạo seed nào", async () => {
  const before = (await lucid.wallet().getUtxos()).length;
  await mustThrow(() => runBeaconsPhase(chain, base(undefined, expectRight)), ["DEPLOY_SEED_", "DEPLOY_EXPECT_HASHES"]);
  assertEq((await lucid.wallet().getUtxos()).length, before, "số UTxO ví");
});
await testCase("seed KHÔNG có trên chuỗi (outref bịa) ⟹ ném nêu biến + 'không còn trên chuỗi'", async () => {
  const fake = { ...seeds, rate: { txHash: "ab".repeat(32), outputIndex: 0 } };
  await mustThrow(() => runBeaconsPhase(chain, base(fake)), [SEED_ENV.rate, "không còn trên chuỗi"]);
  assertEq(await unspent(seedRefs(seeds)), 4, "seed thật còn chưa tiêu");
});
await testCase("seed nằm ở VÍ (không ở bãi đỗ) ⟹ bước 11 ném; cùng UTxO qua được khi allowWallet (bước 03/09)", async () => {
  const w = (await lucid.wallet().getUtxos()).find((u: UTxO) => Object.keys(u.assets).length === 1)!;
  const atWallet = { ...seeds, greenback: { txHash: w.txHash, outputIndex: w.outputIndex } };
  await mustThrow(() => runBeaconsPhase(chain, base(atWallet)), [SEED_ENV.greenback, "không phải bãi đỗ"]);
  const r = await resolvePresetSeed(lucid, park, "shardNft", { txHash: w.txHash, outputIndex: w.outputIndex }, { allowWallet: true });
  assertEq(r.atPark, false, "atPark");
  // Có tệp kỳ vọng ⟹ bước 03/09 cũng KHÔNG nhận seed ở ví (bộ chọn UTxO tiêu mất được giữa lúc
  // tính trước và lúc đúc).
  await mustThrow(
    () => resolvePresetSeed(lucid, park, "shardNft", { txHash: w.txHash, outputIndex: w.outputIndex }, { allowWallet: presetSeedAllowWallet(expectRight) }),
    [SEED_ENV.shardNft, "không phải bãi đỗ"],
  );
  assertEq(await unspent(seedRefs(seeds)), 4, "seed thật còn chưa tiêu");
});
await testCase("seed ở bãi đỗ nhưng KHÔNG trơn (mang datum) ⟹ ném 'output trơn'", async () => {
  const tx = await lucid.newTx().pay.ToAddressWithData(park.parkAddress, { kind: "inline", value: Data.void() }, { lovelace: 2_000_000n }).complete();
  const h = await (await tx.sign.withWallet().complete()).submit();
  emulator.awaitBlock(1);
  const withDatum = (await emulator.getUtxos(park.parkAddress)).find((u) => u.txHash === h)!;
  await mustThrow(
    () => resolvePresetSeed(lucid, park, "rate", { txHash: withDatum.txHash, outputIndex: withDatum.outputIndex }, { allowWallet: false }),
    [SEED_ENV.rate, "output trơn"],
  );
});
await testCase("env: đặt thiếu một trong bốn biến ⟹ ném nêu tên biến thiếu; trùng seed ⟹ ném; vắng cả bốn ⟹ undefined", async () => {
  const env: Record<string, string> = {
    [SEED_ENV.registry]: outRefString(seeds.registry),
    [SEED_ENV.greenback]: outRefString(seeds.greenback),
    [SEED_ENV.gbShard]: outRefString(seeds.gbShard),
  };
  await mustThrow(() => readBeaconPresetSeeds(env), [SEED_ENV.rate, "thiếu"]);
  await mustThrow(() => readBeaconPresetSeeds({ ...env, [SEED_ENV.rate]: outRefString(seeds.registry) }), ["khác nhau"]);
  assertEq(readBeaconPresetSeeds({}), undefined, "vắng cả bốn");
  const all = readBeaconPresetSeeds({ ...env, [SEED_ENV.rate]: outRefString(seeds.rate) })!;
  assertEq(outRefString(all.rate), outRefString(seeds.rate), "đọc đủ bốn");
});

console.log("── Ca dương (cặp): seed đúng + hash đúng ⟹ đúc trên chính bốn seed đó");
let ok = false;
await testCase("pha beacons KHÔNG tạo seed, hash = kỳ vọng, 3 seed beacon đã tiêu, seed sổ còn chờ pha registry", async () => {
  const r = await runBeaconsPhase(chain, base(seeds, expectRight));
  if (r.txs.some((t) => t.label.startsWith("seed"))) throw new Error(`có tx tạo seed: ${r.txs.map((t) => t.label).join(", ")}`);
  assertEq(r.scripts.vaultRegistry.hash, expectRight.vault_registry, "vault_registry");
  assertEq(r.scripts.greenback.hash, expectRight.greenback_beacon, "greenback_beacon");
  assertEq(r.scripts.gbShard.hash, expectRight.gb_shard, "gb_shard");
  assertEq(r.scripts.rate.hash, expectRight.rate_param, "rate_param");
  assertEq(outRefString(r.registrySeed), outRefString(seeds.registry), "registrySeed ghi sổ = seed cho trước");
  assertEq(await unspent([seeds.greenback, seeds.gbShard, seeds.rate]), 0, "seed GB/gb_shard/ρ đã tiêu");
  assertEq(await unspent([seeds.registry]), 1, "seed sổ còn chờ");
  if (!(await emulator.getUtxoByUnit(r.scripts.rate.nftUnit))) throw new Error("không có beacon ρ");
  if (!(await emulator.getUtxoByUnit(r.scripts.greenback.nftUnit))) throw new Error("không có beacon GB");
  for (let i = 0n; i < SHARD_COUNT; i++) {
    if (!(await emulator.getUtxoByUnit(r.scripts.gbShard.nftUnit(i)))) throw new Error(`thiếu gb_shard ${i}`);
  }
  ok = true;
});
await testCase("chạy lại với cùng bốn seed (ba seed đã tiêu) ⟹ ném 'không còn trên chuỗi', không đúc lần hai", async () => {
  if (!ok) throw new Error("ca dương trên không chạy được — không đo");
  await mustThrow(() => runBeaconsPhase(chain, base(seeds, expectRight)), ["không còn trên chuỗi"]);
});

console.log("── Pha registry: so hash kỳ vọng TRƯỚC khi ký tx đúc sổ (sổ bất biến sau khi đúc)");
const VI = "d1".repeat(28), VS = "d2".repeat(28);
const regExpect: ExpectedHashes = { ...expectRight, vault_instant: VI, vault_schedule: VS };
const regInput = (expectHashes: ExpectedHashes) => ({
  blueprint, seed: seeds.registry, pendingHash: right.vaultRegistry.hash, vaultScriptHashes: [VI, VS], expectHashes,
});
await testCase("vault_schedule LỆCH ⟹ ném 'KHÔNG nộp', seed sổ còn chờ", async () => {
  if (!ok) throw new Error("pha beacons không chạy được — không đo");
  await mustThrow(() => runRegistryPhase(chain, regInput({ ...regExpect, vault_schedule: "00".repeat(28) })), ["bước 11 pha registry", "vault_schedule", "KHÔNG nộp"]);
  assertEq(await unspent([seeds.registry]), 1, "seed sổ còn chờ");
});
await testCase("tệp THIẾU vault_instant ⟹ ném 'không có', seed sổ còn chờ", async () => {
  if (!ok) throw new Error("pha beacons không chạy được — không đo");
  const { vault_instant: _drop, ...missing } = regExpect;
  await mustThrow(() => runRegistryPhase(chain, regInput(missing)), ["vault_instant", "không có"]);
  assertEq(await unspent([seeds.registry]), 1, "seed sổ còn chờ");
});
await testCase("(cặp) kỳ vọng đúng ⟹ đúc sổ trên seed cho trước, seed sổ đã tiêu", async () => {
  if (!ok) throw new Error("pha beacons không chạy được — không đo");
  const rr = await runRegistryPhase(chain, regInput(regExpect));
  assertEq(rr.registryHash, expectRight.vault_registry, "vault_registry");
  assertEq(rr.vaultScriptHashes.join(","), `${VI},${VS}`, "két trong sổ");
  assertEq(await unspent([seeds.registry]), 0, "seed sổ đã tiêu");
});

console.log(failures === 0 ? "=== ĐẠT ===" : `=== HỎNG: ${failures} ca sai ===`);
if (failures !== 0) process.exit(1);
