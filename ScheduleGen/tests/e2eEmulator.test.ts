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
  Emulator, Lucid, Data, Constr, CML, applyParamsToScript, generateEmulatorAccount,
  generateEmulatorAccountFromPrivateKey, credentialToRewardAddress, getAddressDetails, PROTOCOL_PARAMETERS_DEFAULT, mintingPolicyToId, scriptFromNative, toUnit, validatorToAddress,
  validatorToScriptHash,
  type EmulatorAccount, type LucidEvolution, type Script, type TxBuilder, type UTxO,
} from "@lucid-evolution/lucid";
import { msPerEpoch, windowOf, windowOriginMs } from "@magiclamp/protocol-utils";
import { beforeAll, describe, expect, it } from "vitest";
import {
  deriveGenBeaconsScripts, loadBlueprint, mintVaultRegistryTx, initGreenBackBeaconTx,
  mintGbShardsTx, initRateBeaconTx, postGreenBackTx, decodeGbShard,
  type GenBeaconsScripts,
} from "../../GenBeacons/offchain/src/index.js";
import {
  buildScheduleCommitTx, buildScheduleFireTx, buildRegisterCommitStakeTx,
} from "../offchain/src/schedule.js";
import { applyScheduleScripts, type ScheduleBlueprint } from "../offchain/src/params.js";
import { computeShardId } from "../offchain/src/math.js";
import { SHARD_CAP, GB_SHARD_CAP_NANOGIC } from "../offchain/src/constants.js";
import {
  VaultDatum, ScheduleShardDatum, decodeVaultDatum,
  type VaultDatum as TVaultDatum,
} from "../offchain/src/types.js";
import { makeVaultV2, makeShardV2 } from "./genV2Fixtures.js";

const NET = "Preprod" as const;
const P = msPerEpoch(NET);                     // két + beacon cùng một ms_per_epoch
const O = windowOriginMs(NET);                 // két + beacon cùng một window_origin_ms (gốc khác 0)
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
// Chủ DID + ví trả phí bên thứ ba (đường `fee_payer` của VaultTxAPI). `didKey` là khoá của script
// native đóng vai `did_stake`; `feeAcc` chỉ có MỘT UTxO ADA — đúng hình dạng Feecover giao xuống.
let feeAcc: EmulatorAccount;
let didKey: EmulatorAccount;
let didNative: Script;
let didHash = "";
let didReward = "";
let vaultNftDid: string;
let gb: GenBeaconsScripts;
let vaultScript: Script;
let commitScript: Script;
let commitRef: UTxO;
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
const epochNow = () => windowOf(BigInt(emulator.now()), P, O);

/** Sang đầu epoch `e` + 60 s. */
function goToEpoch(e: bigint) {
  const target = O + e * P + 60_000n;
  const slots = Number((target - BigInt(emulator.now())) / 1000n);
  if (slots <= 0) throw new Error(`đã ở sau epoch ${e}`);
  emulator.awaitSlot(slots);
}

const SG_BP: ScheduleBlueprint = JSON.parse(readFileSync(
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
  feeAcc   = generateEmulatorAccountFromPrivateKey({ lovelace: 40_000_000n });
  didKey   = generateEmulatorAccountFromPrivateKey({ lovelace: 5_000_000n });
  // Trần kích thước tx = trần THẬT Preprod/mainnet (16 384 B), ghi tường minh. Bản d2b phải
  // nới lên 20 000 vì két gộp 15 905 B không công bố nổi làm ref-script (16 442 B); sau khi
  // tách nhánh ký ra `commit` (b50770db) két còn 12 134 B, nên mọi tx ở đây — kể cả bốn tx
  // công bố ref-script — phải lọt trần thật. Nới lại trần ở đây là giấu một hồi quy.
  emulator = new Emulator([deployer, writer, rateKey, parking, feeAcc, didKey],
    { ...PROTOCOL_PARAMETERS_DEFAULT, maxTxSize: 16_384 });
  emulator.time = Number(O + E0 * P + 60_000n);
  lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(deployer.seedPhrase);

  // 7 seed one-shot: sổ · beacon GB · gb_shard · ρ · shard_nft · genesis két · genesis két chủ DID
  let split = lucid.newTx();
  for (let i = 0; i < 7; i++) split = split.pay.ToAddress(deployer.address, { lovelace: 20_000_000n });
  const splitHash = await submitBuilder(split);
  const seed = (i: number) => ({ txHash: splitHash, outputIndex: i });
  const seedU = async (i: number) => (await emulator.getUtxosByOutRef([seed(i)]))[0]!;

  gb = deriveGenBeaconsScripts(loadBlueprint(), "Custom", {
    msPerEpoch: P, windowOriginMs: O, vaultRegistrySeed: seed(0), greenbackWriter: pkh(writer), greenbackSeed: seed(1),
    gbShardCapNanogic: GB_SHARD_CAP_NANOGIC, gbShardSeed: seed(2), rateKey: pkh(rateKey),
    rhoMaxQ: RHO, rateSeed: seed(3),
  });

  const lampNative = scriptFromNative({ type: "sig", keyHash: pkh(deployer) });
  lampPolicy = mintingPolicyToId(lampNative);

  SHARD_NFT_CODE = applyParamsToScript(sgCode("shard_nft.shard_nft.mint"), [outRef(seed(4))]);
  const shardNft: Script = { type: "PlutusV3", script: SHARD_NFT_CODE };
  const shardPolicy = mintingPolicyToId(shardNft);

  // Cặp script theo đúng thứ tự dựng: `commit` (10) → hash → két (7), qua cổng tên-blueprint.
  const pair = applyScheduleScripts(SG_BP, {
    lampPolicyId: lampPolicy, lampAssetName: LAMP_NAME, shardPolicyId: shardPolicy, msPerEpoch: P, windowOriginMs: O,
    gbBeaconNftPolicy: gb.greenback.hash, gbBeaconScriptHash: gb.greenback.hash,
    gbShardPolicyId: gb.gbShard.hash, rateNftPolicy: gb.rate.hash, rateScriptHash: gb.rate.hash,
  });
  vaultScript = pair.vaultScript;
  commitScript = pair.commitScript;
  const vaultHash = pair.vaultScriptHash;
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
  for (const sc of [vaultScript, shardScript, gb.gbShard.script, commitScript]) {
    const pub = await lucid.newTx().pay.ToAddressWithData(parking.address, undefined,
      { lovelace: 60_000_000n }, sc).complete();
    PUBLISH_BYTES.push(pub.toCBOR().length / 2);
    const h = await submitSign(pub);
    // Tìm theo HASH script mang theo, không theo chỉ số output — thứ tự output không phải
    // hợp đồng của Lucid (đo: chọn `#0` thì có lượt lấy nhầm output tiền thừa).
    const want = validatorToScriptHash(sc);
    const hits = (await emulator.getUtxos(parking.address)).filter(u =>
      u.txHash === h && u.scriptRef != null && validatorToScriptHash(u.scriptRef as Script) === want);
    if (hits.length !== 1) throw new Error(`script tham chiếu ${want}: thấy ${hits.length} UTxO`);
    refUtxos.push(hits[0]!);
  }
  // Ref của `commit` đi đường riêng (`commitRefScriptUtxo`), ba ref đầu cho két/shard/gb_shard.
  commitRef = refUtxos.pop()!;

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

  // Két THỨ HAI, chủ = Script(did_stake): script native đóng vai `did_stake` (rút 0 từ reward address
  // của nó là cách chứng minh quyền chủ — `owner_auth`). Phải ĐĂNG KÝ stake credential trước khi rút.
  didNative = scriptFromNative({ type: "sig", keyHash: pkh(didKey) });
  didHash = validatorToScriptHash(didNative);
  didReward = credentialToRewardAddress(NET, { type: "Script", hash: didHash });
  await submitBuilder(lucid.newTx().register.Stake(didReward));
  await submitBuilder(lucid.newTx()
    .mintAssets({ [lampUnit]: LAMP_Q })
    .attach.MintingPolicy(lampNative)
    .pay.ToAddress(deployer.address, { lovelace: 3_000_000n, [lampUnit]: LAMP_Q })
    .addSigner(deployer.address));
  const vSeedDid = await seedU(6);
  const nftNameDid = Buffer.from(blake2b(Buffer.from(Data.to(outRef(vSeedDid)), "hex"), { dkLen: 32 })).toString("hex");
  vaultNftDid = toUnit(vaultHash, nftNameDid);
  const genesisDid: TVaultDatum = makeVaultV2({
    owner: { Script: [didHash] } as TVaultDatum["owner"],
    lamp_balance: LAMP_Q,
    loyalty_holdings: [{ amount: LAMP_Q, acquired_epoch: 0n, is_locked: false }],
    last_updated_epoch: 0n,
    usage_window_epoch: 0n,
    attribution: { attribution_root: "", last_event_epoch: 0n, total_events: 0n },
  });
  // Genesis đòi `owner_authorized`: với Script(h) là một mục rút 0 từ chính h trong tx này.
  await submitBuilder(didAuth().attachWithdraw(lucid.newTx()
    .collectFrom([vSeedDid])
    .mintAssets({ [vaultNftDid]: 1n }, Data.to(new Constr(0, [outRef(vSeedDid)])))
    .readFrom([refUtxos[0]!])
    .pay.ToContract(vaultAddr, { kind: "inline", value: Data.to(genesisDid, VaultDatum) },
      { lovelace: 5_000_000n, [lampUnit]: LAMP_Q, [vaultNftDid]: 1n })
    .addSigner(deployer.address)), [didKey]);

  // Sang epoch kế (ρ genesis đã hiệu lực từ E0), ghi GreenBack trong CHÍNH epoch đó.
  goToEpoch(E0 + 1n);
  E1 = epochNow();
  await submitBuilder(postGreenBackTx(lucid, {
    greenback: gb.greenback, beaconUtxo: await only(gb.greenback.nftUnit), gbNanogic: GB, depeg: false, nowMs: nowMs(),
  }).tx, [writer]);
}, SLOW);

/** Byte của bốn tx công bố ref-script: két · shard · gb_shard · commit. */
const PUBLISH_BYTES: number[] = [];

/** Tổng ExUnit theo purpose, đọc từ witness set của tx đã `complete()` (Lucid đã điền
 *  ExUnit đánh giá thật). Hình dạng lạ ⟹ NÉM. */
function exUnitsOf(cbor: string): { tag: number; index: bigint; mem: bigint; steps: bigint }[] {
  const rs = CML.Transaction.from_cbor_hex(cbor).witness_set().redeemers();
  if (!rs) throw new Error("tx không có redeemer nào");
  const flat = rs.to_flat_format();
  const out = [];
  for (let i = 0; i < flat.len(); i++) {
    const r = flat.get(i);
    out.push({ tag: r.tag(), index: r.index(), mem: r.ex_units().mem(), steps: r.ex_units().steps() });
  }
  return out;
}

async function commitTx(
  tamper?: (d: TVaultDatum) => TVaultDatum,
  over: Record<string, unknown> = {},
) {
  return buildScheduleCommitTx({
    commitScript, commitRefScriptUtxo: commitRef,
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
    // Cuối cùng ⟹ ghi đè được MỌI trường (ví lucid, ownerAuth, thế chấp… cho đường `fee_payer`).
    ...over,
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

// ── Đường `fee_payer` + chủ DID (VaultTxAPI: `txBuilder.ts` ▸ `lucidFor` + `collateralLovelace`) ──
// Ví lucid của dịch vụ là ví CHỈ-ĐỌC (`fromAddress`) mang ĐÚNG MỘT UTxO của bên trả phí; thế chấp
// tường minh 3 ADA. Phép dựng ở đây chép hình dạng đó: ví của CHÍNH `lucid` tạm chuyển sang `fromAddress` rồi trả lại.
// (KHÔNG dựng một `Lucid(emulator)` thứ hai: đo 2026-10-09, lần dựng thứ hai làm lệch cấu hình slot của Emulator —
// cận trên hiệu lực tính theo gốc slot mới, mọi tx sau đó bị bác "Upper bound … not in slot range".)
const FEE_COLLATERAL = 3_000_000n;
const didAuth = () => ({
  kind: "script" as const, hash: didHash,
  attachWithdraw: (t: TxBuilder) => t.withdraw(didReward, 0n).attach.Script(didNative),
});
/** UTxO ADA-thuần lớn nhất của ví trả phí — đúng một UTxO giao cho dịch vụ. */
async function feePayerUtxo(): Promise<UTxO> {
  const us = (await emulator.getUtxos(feeAcc.address))
    .filter(u => Object.keys(u.assets).length === 1 && u.assets.lovelace !== undefined)
    .sort((a, b) => (b.assets.lovelace! > a.assets.lovelace! ? 1 : -1));
  if (us.length === 0) throw new Error("ví trả phí hết UTxO ADA thuần");
  return us[0]!;
}
async function withFeePayerWallet<T>(u: UTxO, build: () => Promise<T>): Promise<T> {
  lucid.selectWallet.fromAddress(feeAcc.address, [u]);
  try { return await build(); } finally { lucid.selectWallet.fromSeed(deployer.seedPhrase); }
}
const outRefKey = (r: { txHash: string; outputIndex: number }) => `${r.txHash}#${r.outputIndex}`;
/** input / thế chấp / required_signers / mục rút của một tx, đọc từ CBOR. */
function shapeOf(cbor: string) {
  const body = CML.Transaction.from_cbor_hex(cbor).body();
  const refs = (l: any) => {
    const out: string[] = [];
    if (l === undefined || l === null) return out;
    for (let i = 0; i < l.len(); i++) out.push(`${l.get(i).transaction_id().to_hex()}#${l.get(i).index()}`);
    return out;
  };
  const rs = body.required_signers();
  const signers: string[] = [];
  if (rs) for (let i = 0; i < rs.len(); i++) signers.push(rs.get(i).to_hex());
  const w = body.withdrawals();
  return { inputs: refs(body.inputs()), collateral: refs(body.collateral_inputs()), signers, withdrawals: w ? w.len() : 0 };
}
async function submitKeys(tx: any, keys: EmulatorAccount[]): Promise<string> {
  let s = tx;
  keys.forEach((k, i) => { s = (i === 0 ? tx.sign : s.sign).withPrivateKey(k.privateKey); });
  const signed = await s.completeSafe();
  if (signed._tag === "Left") throw new Error(`ký: ${describeError(signed.left)}`);
  const sub = await signed.right.submitSafe();
  if (sub._tag === "Left") throw new Error(`nộp: ${describeError(sub.left)}`);
  emulator.awaitBlock(1);
  return sub.right;
}
function commitTxDidFee(u: UTxO, over: Record<string, unknown> = {}) {
  return withFeePayerWallet(u, async () => commitTx(undefined, {
    userAddress: feeAcc.address, ownerAuth: didAuth(), collateralLovelace: FEE_COLLATERAL,
    vaultUtxo: await only(vaultNftDid), ...over,
  }));
}
function fireTxDidFee(u: UTxO) {
  return withFeePayerWallet(u, async () => buildScheduleFireTx({
    lucid, vaultUtxo: await only(vaultNftDid), shardUtxos: await lampShardUtxos(), scheduleId: scheduleIdDid,
    vaultScript, shardScript, lampPolicyId: lampPolicy, lampAssetName: LAMP_NAME, network: NET,
    tipPosixMs: BigInt(nowMs()), refScriptUtxos: refUtxos, collateralLovelace: FEE_COLLATERAL,
  } as any));
}
let scheduleIdDid: string;

// Purpose trong câu lỗi đánh giá của Lucid: `Spend[i]` = một input script (két / shard / shard GB),
// `Withdraw[i]` = mục rút (ở đây chỉ `commit`). Ca âm khẳng định ĐÚNG purpose, không chỉ "có bác".
// (Lucid 0.4.30 in `Withdraw[0]`, đo 2026-09-30 — không phải `Reward[0]`.)
const SPEND_FAILURE  = /failed script execution Spend\[\d+\]/;
const REWARD_FAILURE = /failed script execution Withdraw\[\d+\]/;
async function rejectionOf(p: Promise<unknown>): Promise<string> {
  let msg = "";
  try { await p; } catch (e) { msg = describeError(e); }
  expect(msg, "giao dịch lẽ ra bị từ chối").not.toBe("");
  return msg;
}
async function expectScriptRejected(p: Promise<unknown>, re: RegExp = SPEND_FAILURE) {
  expect(await rejectionOf(p), "giao dịch lẽ ra bị validator từ chối").toMatch(re);
}

describe("ScheduleGen v2.0 e2e — đăng ký stake commit → ký → bắn trên Emulator", () => {
  it("CỰC ĐỐI ký: m_per_epoch ghi lệch 1 nanogic ⟹ `commit` (mục rút) bác", async () => {
    await expectScriptRejected(commitTx(d => ({
      ...d,
      gen_schedules: d.gen_schedules.map(s => ({ ...s, m_per_epoch: s.m_per_epoch + 1n })),
    })), REWARD_FAILURE);
  }, SLOW);

  // Cặp với ca dương "ký" bên dưới — chỉ khác ĐÚNG việc có mục rút `commit` hay không.
  // Trong ScheduleGen + GenBeacons, chỗ DUY NHẤT đọc `tx.withdrawals` là `commit_delegated_to`
  // của két (và `owner_auth` cho chủ script — chủ ở đây là khoá), nên lượt Spend bị bác là két.
  it("CỰC ĐỐI ký: THIẾU mục rút `commit` ⟹ validator két bác (Spend)", async () => {
    await expectScriptRejected(commitTx(undefined, { omitCommitWithdrawal: true }), SPEND_FAILURE);
  }, SLOW);

  it("CỰC ĐỐI ký: stake credential `commit` CHƯA đăng ký ⟹ ledger bác lúc nộp (UPLC đã xanh)", async () => {
    const res = await commitTx();                         // đánh giá UPLC qua ⟹ tx hợp lệ về script
    const msg = await rejectionOf(submitSign(res.tx));
    expect(msg).toMatch(/Withdrawal amount doesn't match actual reward balance/);
  }, SLOW);

  it("đăng ký stake credential `commit` (một lần) — chứng chỉ đăng ký, không rút gì", async () => {
    const { tx, rewardAddress, commitScriptHash } = await buildRegisterCommitStakeTx({
      lucid, commitScript, network: NET,
    });
    expect(commitScriptHash).toBe(validatorToScriptHash(commitScript));
    await submitSign(tx);
    const del = await lucid.config().provider.getDelegation(rewardAddress);
    expect(del.rewards).toBe(0n);
    // Cực đối: đăng ký lần hai ⟹ ledger bác (khẳng định đăng ký ĐÃ ghi, không chỉ tx qua).
    const again = await buildRegisterCommitStakeTx({ lucid, commitScript, network: NET });
    expect(await rejectionOf(submitSign(again.tx))).toMatch(/already registered/);
  }, SLOW);

  it("ký: đọc ρ + GB, rút shard GB đúng M × 2, chốt m_per_epoch", async () => {
    const gbShardId = BigInt(computeShardId({ VerificationKey: [pkh(deployer)] }));
    // Đo thêm biến thể ĐÍNH KÈM `commit` (không ref) — dựng, không nộp.
    const attached = await commitTx(undefined, { commitRefScriptUtxo: undefined });
    const res = await commitTx();
    expect(res.mPerEpoch).toBe(M);
    expect(res.gbDraw).toBe(2n * M);
    const cbor = res.tx.toCBOR();
    const ex = exUnitsOf(cbor);
    const sum = (k: "mem" | "steps") => ex.reduce((a, r) => a + r[k], 0n);
    console.log(JSON.stringify({
      publishRefScriptBytes: PUBLISH_BYTES,
      commitTxBytesRef: cbor.length / 2,
      commitTxBytesAttached: attached.tx.toCBOR().length / 2,
      exUnits: ex.map(r => ({ ...r, index: String(r.index), mem: String(r.mem), steps: String(r.steps) })),
      totalMem: String(sum("mem")), totalSteps: String(sum("steps")),
    }));
    expect(cbor.length / 2).toBeLessThanOrEqual(16_384);
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

  // ── Chủ DID (Script) + ví trả phí bên thứ ba: ca dương/âm ở tầng bộ dựng + validator thật ──
  // VaultTxAPI ▸ `/tx/schedule-commit` với `fee_payer`: ví lucid chỉ có UTxO trả phí, thế chấp tường
  // minh, quyền chủ = rút 0 từ `did_stake`. Mọi ca âm dưới đây dựng Y HỆT ca dương, chỉ khác một vế.
  it("DID+fee_payer — commit XANH: input ngoài script CHỈ là UTxO trả phí; thế chấp = UTxO đó; mục rút = commit + did_stake; không khoá chủ ở required_signers", async () => {
    const fee = await feePayerUtxo();
    const res = await commitTxDidFee(fee);
    const sh = shapeOf(res.tx.toCBOR());
    const vaultIn = await only(vaultNftDid);
    expect(sh.inputs, "UTxO trả phí và két phải là input").toEqual(expect.arrayContaining([outRefKey(fee), outRefKey(vaultIn)]));
    // Mọi input còn lại phải là UTxO script (két · shard LAMP · shard GB), KHÔNG UTxO ví nào khác.
    const walletIns = (await Promise.all(sh.inputs.map(async i => {
      const [h, ix] = i.split("#");
      const u = (await emulator.getUtxosByOutRef([{ txHash: h!, outputIndex: Number(ix) }]))[0]!;
      return getAddressDetails(u.address).paymentCredential?.type === "Key" ? i : null;
    }))).filter(x => x !== null);
    expect(walletIns).toEqual([outRefKey(fee)]);
    expect(sh.collateral).toEqual([outRefKey(fee)]);
    expect(sh.withdrawals).toBe(2);                       // `commit` + `did_stake`
    expect(sh.signers).not.toContain(pkh(deployer));
    // Ký: ví trả phí (input + thế chấp) và khoá của script native `did_stake`. Không khoá nào khác.
    await submitKeys(res.tx, [feeAcc, didKey]);
    scheduleIdDid = res.scheduleId;
    const d = decodeVaultDatum((await only(vaultNftDid)).datum!);
    expect(d.owner).toEqual({ Script: [didHash] });
    expect(d.gen_schedules).toHaveLength(1);
    expect(d.lamp_locked).toBe(N * LAMBDA);
  }, SLOW);

  it("DID+fee_payer — commit CỰC ĐỐI (thiếu ký ví trả phí): cùng tx, chỉ ký did_stake ⟹ ledger bác", async () => {
    // Két DID đã commit ở ca trên; dựng lại trên chính trạng thái hiện tại bằng một UTxO trả phí mới.
    const fee = await feePayerUtxo();
    const res = await commitTxDidFee(fee);
    expect(await rejectionOf(submitKeys(res.tx, [didKey]))).toMatch(/Missing vkey witness/i);
  }, SLOW);

  it("DID+fee_payer — commit CỰC ĐỐI (thiếu ký did_stake): cùng tx, chỉ ký ví trả phí ⟹ ledger bác", async () => {
    const fee = await feePayerUtxo();
    const res = await commitTxDidFee(fee);
    expect(await rejectionOf(submitKeys(res.tx, [feeAcc]))).toMatch(/Invalid native script witness/i);
  }, SLOW);

  it("DID+fee_payer — commit CỰC ĐỐI (không nhân chứng chủ): chủ script mà ownerAuth vắng ⟹ bộ dựng NÉM OWNER_SCRIPT_WITNESS_UNAVAILABLE", async () => {
    const fee = await feePayerUtxo();
    await expect(commitTxDidFee(fee, { ownerAuth: undefined })).rejects.toThrow(/OWNER_SCRIPT_WITNESS_UNAVAILABLE/);
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

  // Két DID đã commit ở E1; nay E1+4. Bắn không cần chủ (permissionless): chỉ ví trả phí ký.
  it("DID+fee_payer — fire XANH: không mục rút, không required_signers; input ví CHỈ là UTxO trả phí; thế chấp = UTxO đó; chỉ ví trả phí ký", async () => {
    const fee = await feePayerUtxo();
    const res = await fireTxDidFee(fee);
    const sh = shapeOf(res.tx.toCBOR());
    expect(sh.withdrawals).toBe(0);
    expect(sh.signers).toEqual([]);
    expect(sh.collateral).toEqual([outRefKey(fee)]);
    const walletIns = (await Promise.all(sh.inputs.map(async i => {
      const [h, ix] = i.split("#");
      const u = (await emulator.getUtxosByOutRef([{ txHash: h!, outputIndex: Number(ix) }]))[0]!;
      return getAddressDetails(u.address).paymentCredential?.type === "Key" ? i : null;
    }))).filter(x => x !== null);
    expect(walletIns).toEqual([outRefKey(fee)]);
    expect(res.firesInTx).toBeGreaterThanOrEqual(1);
    // CỰC ĐỐI (cùng tx, đi TRƯỚC ca dương vì lượt bắn thật dùng hết lệnh đến hạn): thiếu chữ ký ví trả phí
    // (chỉ khoá did_stake ký — fire không cần chủ) ⟹ ledger bác; rồi cặp dương: chỉ ví trả phí ký ⟹ nhận.
    const neg = await rejectionOf(submitKeys(res.tx, [didKey]));
    // "Missing", không phải "Extraneous": ledger đòi chữ ký ví trả phí (input + thế chấp) mà không thấy.
    expect(neg).toMatch(/Missing vkey witness/i);
    // `sign.withPrivateKey` GHI VÀO bộ dựng: chữ ký did_stake của lần nộp âm còn nằm lại trong `res.tx`
    // và bị ledger bác "Extraneous vkey witness" ở lần nộp dương. Nên dựng lại tx từ cùng UTxO trả phí
    // (lần nộp âm bị bác ⟹ UTxO đó vẫn chưa tiêu) rồi mới ký-nộp cặp dương.
    const res2 = await fireTxDidFee(fee);
    await submitKeys(res2.tx, [feeAcc]);
    const d = decodeVaultDatum((await only(vaultNftDid)).datum!);
    expect(d.owner).toEqual({ Script: [didHash] });
    expect(d.gen_schedules[0]!.fired_count).toBe(BigInt(res2.firesInTx));
  }, SLOW);
});

function decodeGreenBackEpoch(raw: string): bigint {
  const c = Data.from(raw) as Constr<unknown>;
  return c.fields[2] as bigint;
}
