// tests/e2eEmulator.test.ts — ScheduleGen Gen v2.0 trên Lucid Emulator, đánh giá UPLC THẬT.
//
// Dựng đủ hệ: GenBeacons (sổ két, beacon GreenBack, 16 shard GB, beacon ρ) bằng chính gói
// `GenBeacons/offchain`, rồi két + 16 shard LAMP ScheduleGen từ blueprint
// `ScheduleGen/onchain/plutus.json` (chạy `aiken build ScheduleGen/onchain` trước). Sau đó chạy
// `buildScheduleCommitTx` và `buildScheduleFireTx` — hai bộ dựng mà keeper/ví dùng thật.
//
// Thứ tự deploy (vòng apply-param: gb_shard bake policy SỔ, két bake hash gb_shard, sổ chứa
// hash két): seed → hash sổ/beacon/gb_shard/ρ → shard_nft → két → shard LAMP → đúc sổ [hash két]
// → beacon GB → 16 shard GB → beacon ρ → 16 shard LAMP → genesis két → script tham chiếu.
//
// Emulator không chạy script lúc nộp; Lucid đánh giá UPLC trong `complete()`. Ca âm là bộ dựng
// NÉM ở `complete()` với dấu "failed script execution", và mỗi ca âm đi cặp với ca dương dựng
// bằng CÙNG bộ dựng, chỉ khác đúng một ô datum ra (`tamperOutputDatum`).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blake2b } from "@noble/hashes/blake2b";
import {
  Emulator, Lucid, Data, Constr, applyParamsToScript, generateEmulatorAccount,
  generateEmulatorAccountFromPrivateKey, getAddressDetails, PROTOCOL_PARAMETERS_DEFAULT, mintingPolicyToId, scriptFromNative, toUnit, validatorToAddress,
  validatorToScriptHash,
  type EmulatorAccount, type LucidEvolution, type Script, type TxBuilder, type UTxO,
} from "@lucid-evolution/lucid";
import { msPerEpoch } from "@magiclamp/protocol-utils";
import { beforeAll, describe, expect, it } from "vitest";
import {
  deriveGenBeaconsScripts, loadBlueprint, mintVaultRegistryTx, initGreenBackBeaconTx,
  mintGbShardsTx, initRateBeaconTx, postGreenBackTx, decodeGbShard,
  type GenBeaconsScripts,
} from "../../GenBeacons/offchain/src/index.js";
import { buildScheduleCommitTx, buildScheduleFireTx } from "../offchain/src/schedule.js";
import { scheduleVaultParamList } from "../offchain/src/params.js";
import { computeShardId } from "../offchain/src/math.js";
import { SHARD_CAP, GB_SHARD_CAP_NANOGIC } from "../offchain/src/constants.js";
import {
  VaultDatum, ScheduleShardDatum, decodeVaultDatum,
  type VaultDatum as TVaultDatum,
} from "../offchain/src/types.js";
import { makeVaultV2, makeShardV2 } from "./genV2Fixtures.js";

const NET = "Preprod" as const;
const P = msPerEpoch(NET);                     // két + beacon cùng một ms_per_epoch
const E0 = 4_000n;
const RHO = 4_000_000_000n;                    // = rho_max_q TẠM
const LAMP_NAME = "744c414d50";                // "tLAMP"
const LAMP_Q = 100_000_000_000n;               // 100 000 LAMP
const LAMBDA = 1_000_000_000n;                 // 1 000 LAMP / epoch
const N = 10n;
const M = 3_000_000_000n;                      // ⌊λρ/Q⌋ · 0,75 (khởi động lạnh)
const GB = 16_000_000_000_000_000n;            // ⟹ reset shard = min(GB/16, cap) = 10¹⁵
const SLOW = 600_000;

const pkh = (a: EmulatorAccount): string => {
  const c = getAddressDetails(a.address).paymentCredential;
  if (c?.type !== "Key") throw new Error("tài khoản emulator không có key credential");
  return c.hash;
};

let emulator: Emulator;
let lucid: LucidEvolution;
let deployer: EmulatorAccount;
let writer: EmulatorAccount;
let rateKey: EmulatorAccount;
let parking: EmulatorAccount;
let gb: GenBeaconsScripts;
let vaultScript: Script;
let shardScript: Script;
let vaultAddr: string;
let shardAddr: string;
let vaultNft: string;
let lampPolicy: string;
let refUtxos: UTxO[] = [];
let E1: bigint;                 // epoch ký
let scheduleId: string;

function describeError(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    return `${e.name}: ${e.message}${cause === undefined ? "" : ` | cause: ${typeof cause === "string" ? cause : JSON.stringify(cause)}`}`;
  }
  return typeof e === "string" ? e : JSON.stringify(e);
}

async function submitBuilder(tx: TxBuilder, extra: EmulatorAccount[] = []): Promise<string> {
  const c = await tx.completeSafe();
  if (c._tag === "Left") throw new Error(describeError(c.left));
  return submitSign(c.right, extra);
}

async function submitSign(tx: any, extra: EmulatorAccount[] = []): Promise<string> {
  let s = tx.sign.withWallet();
  for (const k of extra) s = s.sign.withPrivateKey(k.privateKey);
  const signed = await s.completeSafe();
  if (signed._tag === "Left") throw new Error(`ký: ${describeError(signed.left)}`);
  const sub = await signed.right.submitSafe();
  if (sub._tag === "Left") throw new Error(`nộp: ${describeError(sub.left)}`);
  emulator.awaitBlock(1);
  return sub.right;
}

async function only(unit: string): Promise<UTxO> {
  const u = (await emulator.getUtxoByUnit(unit)) as UTxO | undefined;
  if (!u) throw new Error(`không có UTxO nào mang ${unit}`);
  return u;
}

const nowMs = () => emulator.now();
const epochNow = () => BigInt(emulator.now()) / P;

/** Sang đầu epoch `e` + 60 s. */
function goToEpoch(e: bigint) {
  const target = e * P + 60_000n;
  const slots = Number((target - BigInt(emulator.now())) / 1000n);
  if (slots <= 0) throw new Error(`đã ở sau epoch ${e}`);
  emulator.awaitSlot(slots);
}

type Blueprint = { validators: { title: string; compiledCode: string }[] };
const SG_BP: Blueprint = JSON.parse(readFileSync(
  fileURLToPath(new URL("../onchain/plutus.json", import.meta.url)), "utf8"));
function sgCode(title: string): string {
  const v = SG_BP.validators.find(x => x.title === title);
  if (!v) throw new Error(`blueprint ScheduleGen thiếu ${title} — chạy \`aiken build ScheduleGen/onchain\`.`);
  return v.compiledCode;
}
const outRef = (u: { txHash: string; outputIndex: number }) => new Constr(0, [u.txHash, BigInt(u.outputIndex)]);

async function lampShardUtxos(): Promise<UTxO[]> {
  return (await emulator.getUtxos(shardAddr)).filter(u => Object.keys(u.assets).some(k => k.startsWith(mintingPolicyToId(
    { type: "PlutusV3", script: SHARD_NFT_CODE } as Script))));
}
let SHARD_NFT_CODE = "";

async function gbShardUtxos(): Promise<UTxO[]> {
  return emulator.getUtxos(gb.gbShard.address);
}

beforeAll(async () => {
  deployer = generateEmulatorAccount({ lovelace: 500_000_000_000n });
  // Khoá ký phụ phải là dạng private key (bech32) — `sign.withPrivateKey` không nhận seed.
  writer   = generateEmulatorAccountFromPrivateKey({ lovelace: 50_000_000n });
  rateKey  = generateEmulatorAccountFromPrivateKey({ lovelace: 50_000_000n });
  parking  = generateEmulatorAccountFromPrivateKey({ lovelace: 50_000_000n });
  // 🔴 TRẦN KÍCH THƯỚC TX NỚI RIÊNG CHO EMULATOR. Validator két ScheduleGen v2.0 biên dịch ra
  // 15 905 B; giao dịch Lucid mặc định công bố nó làm script tham chiếu đo được 16 442 B >
  // 16 384 B (trần Preprod/mainnet). Nới ở đây để đo được PHẦN CÒN LẠI (ký + bắn qua phase-2);
  // trên mạng thật két này CHƯA công bố được — xem báo cáo gói d2b.
  emulator = new Emulator([deployer, writer, rateKey, parking],
    { ...PROTOCOL_PARAMETERS_DEFAULT, maxTxSize: 20_000 });
  emulator.time = Number(E0 * P + 60_000n);
  lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(deployer.seedPhrase);

  // 6 seed one-shot: sổ · beacon GB · gb_shard · ρ · shard_nft · genesis két
  let split = lucid.newTx();
  for (let i = 0; i < 6; i++) split = split.pay.ToAddress(deployer.address, { lovelace: 20_000_000n });
  const splitHash = await submitBuilder(split);
  const seed = (i: number) => ({ txHash: splitHash, outputIndex: i });
  const seedU = async (i: number) => (await emulator.getUtxosByOutRef([seed(i)]))[0]!;

  gb = deriveGenBeaconsScripts(loadBlueprint(), "Custom", {
    msPerEpoch: P, vaultRegistrySeed: seed(0), greenbackWriter: pkh(writer), greenbackSeed: seed(1),
    gbShardCapNanogic: GB_SHARD_CAP_NANOGIC, gbShardSeed: seed(2), rateKey: pkh(rateKey),
    rhoMaxQ: RHO, rateSeed: seed(3),
  });

  const lampNative = scriptFromNative({ type: "sig", keyHash: pkh(deployer) });
  lampPolicy = mintingPolicyToId(lampNative);

  SHARD_NFT_CODE = applyParamsToScript(sgCode("shard_nft.shard_nft.mint"), [outRef(seed(4))]);
  const shardNft: Script = { type: "PlutusV3", script: SHARD_NFT_CODE };
  const shardPolicy = mintingPolicyToId(shardNft);

  vaultScript = {
    type: "PlutusV3",
    script: applyParamsToScript(sgCode("vault.vault.mint"), scheduleVaultParamList({
      lampPolicyId: lampPolicy, lampAssetName: LAMP_NAME, shardPolicyId: shardPolicy, msPerEpoch: P,
      gbBeaconNftPolicy: gb.greenback.hash, gbBeaconScriptHash: gb.greenback.hash,
      gbShardPolicyId: gb.gbShard.hash, rateNftPolicy: gb.rate.hash, rateScriptHash: gb.rate.hash,
    })),
  };
  const vaultHash = validatorToScriptHash(vaultScript);
  vaultAddr = validatorToAddress("Custom", vaultScript);
  shardScript = {
    type: "PlutusV3",
    script: applyParamsToScript(sgCode("vault.shard.spend"), [shardPolicy, vaultHash]),
  };
  shardAddr = validatorToAddress("Custom", shardScript);

  // GenBeacons
  await submitBuilder(mintVaultRegistryTx(lucid, {
    vaultRegistry: gb.vaultRegistry, seedUtxo: await seedU(0), vaultScriptHashes: [vaultHash],
  }).tx);
  await submitBuilder(initGreenBackBeaconTx(lucid, {
    greenback: gb.greenback, seedUtxo: await seedU(1), gbNanogic: 0n, nowMs: nowMs(),
  }).tx, [writer]);
  await submitBuilder(mintGbShardsTx(lucid, { gbShard: gb.gbShard, seedUtxo: await seedU(2) }).tx);
  await submitBuilder(initRateBeaconTx(lucid, {
    rate: gb.rate, seedUtxo: await seedU(3), rhoQ: RHO, nowMs: nowMs(),
  }).tx, [rateKey]);

  // 16 shard LAMP sạch
  const shardName = (i: number) => "5348415244" + i.toString(16).padStart(2, "0");
  let mintShards = lucid.newTx().collectFrom([await seedU(4)])
    .mintAssets(Object.fromEntries(Array.from({ length: 16 }, (_, i) => [toUnit(shardPolicy, shardName(i)), 1n])), Data.void())
    .attach.MintingPolicy(shardNft);
  for (let i = 0; i < 16; i++) {
    const d = makeShardV2(i, {
      shard_locked_lamp: 0n, shard_active_count: 0n, shard_cumulative_committed: 0n,
      shard_cumulative_fired: 0n, last_updated_epoch: 0n, shard_cap: SHARD_CAP, shard_obligation_nanogic: 0n,
    });
    mintShards = mintShards.pay.ToContract(shardAddr, { kind: "inline", value: Data.to(d, ScheduleShardDatum) },
      { lovelace: 2_000_000n, [toUnit(shardPolicy, shardName(i))]: 1n });
  }
  await submitBuilder(mintShards);

  // Script tham chiếu (CIP-33) — đỗ ở ví khác để ví trả phí không tiêu nhầm. Đi TRƯỚC genesis:
  // đính kèm validator két vào chính giao dịch genesis đã vượt trần 16 384 B (đo: 17 044).
  for (const sc of [vaultScript, shardScript, gb.gbShard.script]) {
    const h = await submitBuilder(lucid.newTx().pay.ToAddressWithData(parking.address, undefined,
      { lovelace: 60_000_000n }, sc));
    // Tìm theo HASH script mang theo, không theo chỉ số output — thứ tự output không phải
    // hợp đồng của Lucid (đo: chọn `#0` thì có lượt lấy nhầm output tiền thừa).
    const want = validatorToScriptHash(sc);
    const hits = (await emulator.getUtxos(parking.address)).filter(u =>
      u.txHash === h && u.scriptRef != null && validatorToScriptHash(u.scriptRef as Script) === want);
    if (hits.length !== 1) throw new Error(`script tham chiếu ${want}: thấy ${hits.length} UTxO`);
    refUtxos.push(hits[0]!);
  }

  // Genesis két: NFT = blake2b_256(cbor(seed)), LAMP thật, datum sạch 19 trường.
  const vSeed = await seedU(5);
  const nftName = Buffer.from(blake2b(Buffer.from(Data.to(outRef(vSeed)), "hex"), { dkLen: 32 })).toString("hex");
  vaultNft = toUnit(vaultHash, nftName);
  const lampUnit = toUnit(lampPolicy, LAMP_NAME);
  const genesis: TVaultDatum = makeVaultV2({
    owner: { VerificationKey: [pkh(deployer)] } as TVaultDatum["owner"],
    lamp_balance: LAMP_Q,
    loyalty_holdings: [{ amount: LAMP_Q, acquired_epoch: 0n, is_locked: false }],
    last_updated_epoch: 0n,
    usage_window_epoch: 0n,
    attribution: { attribution_root: "", last_event_epoch: 0n, total_events: 0n },
  });
  // LAMP đúc ở giao dịch RIÊNG: gộp hai `mintAssets` (native + Plutus qua `readFrom`) vào một
  // giao dịch thì Emulator báo "Missing script witness" ở khoảng nửa số lượt (đo 3/5, 2/4) —
  // tuỳ thứ tự hai policy id ngẫu nhiên. Tách ra thì ổn định.
  await submitBuilder(lucid.newTx()
    .mintAssets({ [lampUnit]: LAMP_Q })
    .attach.MintingPolicy(lampNative)
    .pay.ToAddress(deployer.address, { lovelace: 3_000_000n, [lampUnit]: LAMP_Q })
    .addSigner(deployer.address));
  await submitBuilder(lucid.newTx()
    .collectFrom([vSeed])
    .mintAssets({ [vaultNft]: 1n }, Data.to(new Constr(0, [outRef(vSeed)])))
    .readFrom([refUtxos[0]!])
    .pay.ToContract(vaultAddr, { kind: "inline", value: Data.to(genesis, VaultDatum) },
      { lovelace: 5_000_000n, [lampUnit]: LAMP_Q, [vaultNft]: 1n })
    .addSigner(deployer.address));

  // Sang epoch mà ρ có hiệu lực, ghi GreenBack trong CHÍNH epoch đó.
  goToEpoch(E0 + 1n);
  E1 = epochNow();
  await submitBuilder(postGreenBackTx(lucid, {
    greenback: gb.greenback, beaconUtxo: await only(gb.greenback.nftUnit), gbNanogic: GB, depeg: false, nowMs: nowMs(),
  }).tx, [writer]);
}, SLOW);

async function commitTx(tamper?: (d: TVaultDatum) => TVaultDatum) {
  return buildScheduleCommitTx({
    lucid, vaultUtxo: await only(vaultNft), shardUtxos: await lampShardUtxos(),
    scheduleLength: N, lampPerEpoch: LAMBDA, userAddress: deployer.address,
    vaultScript, shardScript, gbShardScript: gb.gbShard.script,
    gen: {
      gbBeaconNftPolicy: gb.greenback.hash, gbBeaconScriptHash: gb.greenback.hash,
      gbShardPolicyId: gb.gbShard.hash, rateNftPolicy: gb.rate.hash, rateScriptHash: gb.rate.hash,
      gbShardCapNanogic: GB_SHARD_CAP_NANOGIC,
    },
    rateBeaconUtxo: await only(gb.rate.nftUnit),
    gbBeaconUtxo: await only(gb.greenback.nftUnit),
    vaultRegistryUtxo: await only(gb.vaultRegistry.nftUnit),
    gbShardUtxos: await gbShardUtxos(),
    lampPolicyId: lampPolicy, lampAssetName: LAMP_NAME, network: NET,
    tipPosixMs: BigInt(nowMs()), refScriptUtxos: refUtxos,
    ...(tamper ? { tamperOutputDatum: tamper } : {}),
  } as any);
}

async function fireTx(tamper?: (d: TVaultDatum) => TVaultDatum) {
  return buildScheduleFireTx({
    lucid, vaultUtxo: await only(vaultNft), shardUtxos: await lampShardUtxos(), scheduleId,
    vaultScript, shardScript, lampPolicyId: lampPolicy, lampAssetName: LAMP_NAME, network: NET,
    tipPosixMs: BigInt(nowMs()), refScriptUtxos: refUtxos,
    ...(tamper ? { tamperOutputDatum: tamper } : {}),
  } as any);
}

const SCRIPT_FAILURE = /failed script execution Spend\[\d+\]/;
async function expectScriptRejected(p: Promise<unknown>) {
  let msg = "";
  try { await p; } catch (e) { msg = describeError(e); }
  expect(msg, "giao dịch lẽ ra bị validator từ chối").toMatch(SCRIPT_FAILURE);
}

describe("ScheduleGen v2.0 e2e — ký rồi bắn trên Emulator", () => {
  it("CỰC ĐỐI ký: m_per_epoch ghi lệch 1 nanogic ⟹ validator két bác", async () => {
    await expectScriptRejected(commitTx(d => ({
      ...d,
      gen_schedules: d.gen_schedules.map(s => ({ ...s, m_per_epoch: s.m_per_epoch + 1n })),
    })));
  }, SLOW);

  it("ký: đọc ρ + GB, rút shard GB đúng M × 2, chốt m_per_epoch", async () => {
    const gbShardId = BigInt(computeShardId({ VerificationKey: [pkh(deployer)] }));
    const res = await commitTx();
    expect(res.mPerEpoch).toBe(M);
    expect(res.gbDraw).toBe(2n * M);
    await submitSign(res.tx);
    scheduleId = res.scheduleId;

    const d = decodeVaultDatum((await only(vaultNft)).datum!);
    expect(d.gen_schedules).toHaveLength(1);
    expect(d.gen_schedules[0]!.m_per_epoch).toBe(M);
    expect(d.gen_schedules[0]!.commit_epoch).toBe(E1);
    expect(d.lamp_locked).toBe(N * LAMBDA);
    const gs = decodeGbShard((await only(gb.gbShard.nftUnit(gbShardId))).datum);
    expect(gs.reset_amount).toBe(GB / 16n);
    expect(gs.remaining).toBe(GB / 16n - 2n * M);
  }, SLOW);

  it("CỰC ĐỐI bắn: batch ghi lệch 1 nanogic ⟹ validator két bác", async () => {
    goToEpoch(E1 + 2n);
    await expectScriptRejected(fireTx(d => ({
      ...d,
      magic_batches: d.magic_batches.map(b => ({ ...b, initial_amount: b.initial_amount + 1n, current_amount: b.current_amount + 1n })),
    })));
  }, SLOW);

  it("bắn ở epoch ký + 2: beacon GB đã CŨ mà vẫn bắn được, cấp đúng m_per_epoch", async () => {
    expect(epochNow()).toBe(E1 + 2n);
    const beacon = decodeGreenBackEpoch((await only(gb.greenback.nftUnit)).datum!);
    expect(beacon).toBeLessThan(epochNow());            // nhánh KÝ sẽ bác beacon này
    const res = await fireTx();
    expect(res.firesInTx).toBe(1);
    expect(res.mPerFire).toBe(M);
    await submitSign(res.tx);
    const d = decodeVaultDatum((await only(vaultNft)).datum!);
    expect(d.magic_batches.map(b => [b.created_epoch, b.initial_amount])).toEqual([[E1 + 2n, M]]);
    expect(d.gen_schedules[0]!.fired_count).toBe(1n);
    expect(d.lamp_locked).toBe((N - 1n) * LAMBDA);
    expect(d.usage_window[0]).toEqual({ generated: M, consumed: 0n });
  }, SLOW);

  it("bắn BÙ 2 lệnh ở epoch ký + 4: batch mang epoch danh nghĩa, validator nhận", async () => {
    goToEpoch(E1 + 4n);
    const res = await fireTx();
    expect(res.firesInTx).toBe(2);
    expect(res.firstNominalEpoch).toBe(E1 + 3n);
    await submitSign(res.tx);
    const d = decodeVaultDatum((await only(vaultNft)).datum!);
    // batch E1+2 đã chết ⟹ bị dọn; lượt bù E1+3 chết lúc sinh nhưng vẫn ghi; E1+4 sống.
    expect(d.magic_batches.map(b => b.created_epoch)).toEqual([E1 + 3n, E1 + 4n]);
    expect(d.usage_window.slice(0, 3).map(u => u.generated)).toEqual([M, M, M]);
    expect(d.gen_schedules[0]!.fired_count).toBe(3n);
  }, SLOW);
});

function decodeGreenBackEpoch(raw: string): bigint {
  const c = Data.from(raw) as Constr<unknown>;
  return c.fields[2] as bigint;
}
