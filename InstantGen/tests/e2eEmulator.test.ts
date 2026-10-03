// tests/e2eEmulator.test.ts — két InstantGen Gen v2.0 trên Lucid Emulator, script ĐÃ APPLY
// thật (blueprint `onchain/plutus.json` do `aiken build` sinh), beacon ρ / GreenBack / 16
// shard / sổ két dựng bằng gói `GenBeacons/offchain` theo đúng thứ tự deploy:
//   hash sổ → apply beacon GB → apply gb_shard → apply két (9 tham số) → đúc sổ [hash két]
//   → khởi tạo beacon GB + 16 shard + beacon ρ → sang epoch sau (ρ genesis hiệu lực từ
//   epoch+1) → ghi GB seq 1 → genesis két (MintVaultId).
//
// Emulator không chạy script lúc nộp; Lucid đánh giá UPLC cục bộ trong `complete()`. Ca âm
// là `complete()` bị từ chối VÌ SCRIPT (khớp `failed script execution`), và mỗi ca âm đi
// CẶP với ca dương dựng bằng CÙNG bộ dựng, chỉ khác đúng một ô.

import {
  Emulator, generateEmulatorAccount, generateEmulatorAccountFromPrivateKey, getAddressDetails,
  Lucid, mintingPolicyToId, scriptFromNative, toUnit, validatorToAddress, Data, Constr, credentialToAddress,
  type EmulatorAccount, type LucidEvolution, type UTxO, type Validator,
} from "@lucid-evolution/lucid";
import { blake2b } from "@noble/hashes/blake2b";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { windowOriginMs } from "@magiclamp/protocol-utils";
import {
  deriveGenBeaconsScripts, loadBlueprint, mintVaultRegistryTx, initGreenBackBeaconTx,
  mintGbShardsTx, initRateBeaconTx, postGreenBackTx, epochValidityWindow, decodeGbShard,
  type GenBeaconsScripts,
} from "../../GenBeacons/offchain/src/index.js";
import { applyInstantVaultParams, INSTANT_VAULT_SPEND_TITLE, type InstantVaultParams } from "../offchain/src/vaultScript.js";
import { buildInstantGenTx, buildRefreshCheckpointTx, instantGenLimits, floorDiv } from "../offchain/src/instant.js";
import { VaultDatum, VaultIdRedeemer, OutputReferenceSchema, decodeVaultDatum, type VaultDatum as TVaultDatum } from "../offchain/src/types.js";
import { vaultShardId } from "../offchain/src/greenback.js";
import { WAKEME_SEED_CREDIT } from "../offchain/src/constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const P = 3_600_000n;              // 1 giờ / epoch — sang epoch bằng `awaitSlot`
const EPOCH0 = 500_000n;
// Gốc cửa sổ (apply-param CUỐI của két + beacon). Lấy gốc Preprod: khác 0 nên bản quên trừ
// gốc thấy một epoch khác hẳn. Biên epoch `e` = O + e·P; `P` vẫn là ĐỘ DÀI (awaitSlot).
const O = windowOriginMs("Preprod");
const CAP = 1_800_000_000_000_000n;
const RHO_MAX = 4_000_000_000n;
const LAMP_NAME = "744c414d50";
const LAMP_QTY = 1_000_000_000n;   // 1 000 LAMP
const GB = 16n * 1_000_000_000_000n;
const SCRIPT_FAILURE = /failed script execution Spend\[\d+\]/;
// Két Wakeme giả lập (hành trình người mới): hash = apply-param `wakeme_vault_hash` của két
// (`vp.wakemeVaultHash`), NFT = (hash, owner_commit). Không có script nào sau hash này — két chỉ
// được ĐỌC qua reference input, nên chỉ cần đúng địa chỉ + NFT + datum. NFT nằm sẵn trong UTxO
// genesis của emulator (không đúc được dưới một policy không có script).
const WAKEME_H = "b5".repeat(28);
const WAKEME_COMMIT = "c3".repeat(32);
const WAKEME_NFT = WAKEME_H + WAKEME_COMMIT;
const LENT_C = 3_000_000_000n;     // 3 000 LAMP chưa chốt (deployer còn 8 000 LAMP sau hai két)
const LENT_O = 2_000_000_000n;     // 2 000 LAMP đã chốt

const pkh = (a: EmulatorAccount): string => {
  const c = getAddressDetails(a.address).paymentCredential;
  if (c?.type !== "Key") throw new Error("tài khoản emulator không có key credential");
  return c.hash;
};

let emulator: Emulator;
let lucid: LucidEvolution;
let deployer: EmulatorAccount, rateKey: EmulatorAccount, writer: EmulatorAccount, wakemeHolder: EmulatorAccount;
let s: GenBeaconsScripts;
let vp: InstantVaultParams;
let vaultScript: Validator;
let vaultHash: string;
let vaultAddr: string;
let lampUnit: string;
let vaultRef: UTxO;
let shardRef: UTxO;

function describeError(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    return `${e.name}: ${e.message}${cause === undefined ? "" : ` | cause: ${typeof cause === "string" ? cause : JSON.stringify(cause)}`}`;
  }
  return typeof e === "string" ? e : JSON.stringify(e);
}

async function submitBuilt(built: { sign: { withWallet(): any } }, extra: EmulatorAccount[] = []): Promise<string> {
  let signer = built.sign.withWallet();
  for (const k of extra) signer = signer.sign.withPrivateKey(k.privateKey);
  const signed = await signer.complete();
  const hash = await signed.submit();
  emulator.awaitBlock(1);
  return hash;
}

async function submit(tx: any, extra: EmulatorAccount[] = []): Promise<string> {
  const r = await tx.completeSafe();
  if (r._tag === "Left") throw new Error(describeError(r.left));
  return submitBuilt(r.right, extra);
}

async function only(unit: string): Promise<UTxO> {
  const u = (await emulator.getUtxoByUnit(unit)) as UTxO | undefined;
  if (!u) throw new Error(`không có UTxO nào mang ${unit}`);
  return u;
}

const now = () => emulator.now();
const win = () => { const w = epochValidityWindow(now(), P, O); return { fromMs: BigInt(w.fromMs), toMs: BigInt(w.toMs) }; };

function genesisDatum(owner: string, lamp: bigint = LAMP_QTY, link = ""): TVaultDatum {
  return {
    owner: { VerificationKey: [owner] },
    lamp_balance: lamp, lamp_locked: 0n,
    loyalty_holdings: lamp === 0n ? [] : [{ amount: lamp, acquired_epoch: 0n, is_locked: false }],
    magic_batches: [], next_batch_index: 0n, wakeme_link: link, gen_schedules: [],
    profile: "Flame", profile_changed_epoch: 0n, pending_profile: null, last_updated_epoch: 0n,
    cap_epoch: 0n, activity_state: { recent_burn_epochs: [], consumed_credit: WAKEME_SEED_CREDIT },
    cap_nanogic: 0n, personal_delegate: null,
    attribution: { attribution_root: "", last_event_epoch: 0n, total_events: 0n },
    instant_unlock_ms: 0n,
    usage_window: Array.from({ length: 7 }, () => ({ generated: 0n, consumed: 0n })),
    usage_window_epoch: 0n,
  };
}

/** Tên NFT vault-id = blake2b_256(cbor(seed)). */
function vaultIdNameOf(seed: UTxO): string {
  const ref = { transaction_id: seed.txHash, output_index: BigInt(seed.outputIndex) };
  return Buffer.from(blake2b(Buffer.from(Data.to(ref, OutputReferenceSchema as unknown as typeof ref), "hex"), { dkLen: 32 })).toString("hex");
}

/**
 * Genesis két: tiêu `seed`, đúc NFT vault-id = blake2b_256(cbor(seed)), khoá LAMP + datum.
 * `lamp = 0n` ⟹ value KHÔNG mang mục LAMP; `link` = `wakeme_link` khai sẵn ("" hoặc 32 byte).
 */
async function openVault(seed: UTxO, lovelace: bigint | null, lamp: bigint = LAMP_QTY, link = ""): Promise<string> {
  const ref = { transaction_id: seed.txHash, output_index: BigInt(seed.outputIndex) };
  const nft = toUnit(vaultHash, vaultIdNameOf(seed));
  const assets: Record<string, bigint> = { [nft]: 1n };
  if (lamp > 0n) assets[lampUnit] = lamp;
  if (lovelace !== null) assets.lovelace = lovelace;
  await submit(lucid.newTx()
    .collectFrom([seed])
    .mintAssets({ [nft]: 1n }, Data.to({ MintVaultId: { seed: ref } }, VaultIdRedeemer))
    .attach.MintingPolicy(vaultScript)
    .pay.ToContract(vaultAddr, { kind: "inline", value: Data.to(genesisDatum(pkh(deployer), lamp, link), VaultDatum) }, assets)
    .addSigner(deployer.address));
  return nft;
}

beforeAll(async () => {
  deployer = generateEmulatorAccount({ lovelace: 200_000_000_000n });
  rateKey = generateEmulatorAccountFromPrivateKey({ lovelace: 50_000_000n });
  writer = generateEmulatorAccountFromPrivateKey({ lovelace: 50_000_000n });
  wakemeHolder = generateEmulatorAccountFromPrivateKey({ lovelace: 50_000_000n, [WAKEME_NFT]: 1n });
  emulator = new Emulator([deployer, rateKey, writer, wakemeHolder]);
  emulator.time = Number(O + EPOCH0 * P + 60_000n);
  lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(deployer.seedPhrase);

  let split = lucid.newTx();
  for (let i = 0; i < 6; i++) split = split.pay.ToAddress(deployer.address, { lovelace: 20_000_000n });
  const splitHash = await submit(split);
  const seed = (i: number) => ({ txHash: splitHash, outputIndex: i });

  s = deriveGenBeaconsScripts(loadBlueprint(), "Custom", {
    msPerEpoch: P, windowOriginMs: O, vaultRegistrySeed: seed(0), greenbackWriter: pkh(writer), greenbackSeed: seed(1),
    gbShardCapNanogic: CAP, gbShardSeed: seed(2), rateKey: pkh(rateKey), rhoMaxQ: RHO_MAX, rateSeed: seed(3),
  });

  // LAMP giả: native script sig(deployer).
  const lampScript = scriptFromNative({ type: "sig", keyHash: pkh(deployer) });
  const lampPolicy = mintingPolicyToId(lampScript);
  lampUnit = toUnit(lampPolicy, LAMP_NAME);
  await submit(lucid.newTx().mintAssets({ [lampUnit]: 10n * LAMP_QTY }).attach.MintingPolicy(lampScript));

  const bp = JSON.parse(readFileSync(resolve(here, "../onchain/plutus.json"), "utf8")) as { validators: Array<{ title: string; compiledCode: string }> };
  const code = bp.validators.find(v => v.title === INSTANT_VAULT_SPEND_TITLE)?.compiledCode;
  if (!code) throw new Error("blueprint InstantGen thiếu vault.vault.spend — chạy aiken build");
  vp = {
    lampPolicyId: lampPolicy, lampAssetName: LAMP_NAME,
    gbBeaconNftPolicy: s.greenback.nftUnit.slice(0, 56), gbBeaconScriptHash: s.greenback.hash,
    gbShardPolicyId: s.gbShard.hash,
    rateNftPolicy: s.rate.nftUnit.slice(0, 56), rateScriptHash: s.rate.hash,
    wakemeVaultHash: WAKEME_H, msPerEpoch: P, windowOriginMs: O,
  };
  vaultScript = applyInstantVaultParams(code, vp);
  vaultHash = mintingPolicyToId(vaultScript);
  vaultAddr = validatorToAddress("Custom", vaultScript);

  const seedU = async (i: number) => (await emulator.getUtxosByOutRef([seed(i)]))[0]!;
  await submit(mintVaultRegistryTx(lucid, { vaultRegistry: s.vaultRegistry, seedUtxo: await seedU(0), vaultScriptHashes: [vaultHash] }).tx);
  await submit(initGreenBackBeaconTx(lucid, { greenback: s.greenback, seedUtxo: await seedU(1), gbNanogic: GB, nowMs: now() }).tx, [writer]);
  await submit(mintGbShardsTx(lucid, { gbShard: s.gbShard, seedUtxo: await seedU(2) }).tx);
  await submit(initRateBeaconTx(lucid, { rate: s.rate, seedUtxo: await seedU(3), rhoQ: 1_000_000_000n, nowMs: now() }).tx, [rateKey]);

  // Sang epoch EPOCH0+1: ρ genesis hiệu lực; ghi GB seq 1 để shard đặt lại lười có lượng.
  // Ref-script CIP-33: két + shard đính kèm cùng lúc = 18 346 byte > trần 16 384 (đo lần đầu
  // chạy tệp này, 2026-09-30) ⟹ lượt sinh BẮT BUỘC đọc script qua reference input. Đỗ ở một
  // địa chỉ native script `any []` (luôn sai) để không ai tiêu được.
  const sink = validatorToAddress("Custom", scriptFromNative({ type: "any", scripts: [] }));
  // Hai giao dịch: đỗ cả hai script trong một giao dịch cũng vượt trần (17 461 byte).
  await submit(lucid.newTx().pay.ToAddressWithData(sink, undefined, { lovelace: 60_000_000n }, vaultScript));
  await submit(lucid.newTx().pay.ToAddressWithData(sink, undefined, { lovelace: 60_000_000n }, s.gbShard.script as Validator));
  const refs = await emulator.getUtxos(sink);
  vaultRef = refs.find(u => u.scriptRef?.script === vaultScript.script)!;
  shardRef = refs.find(u => u.scriptRef?.script === (s.gbShard.script as Validator).script)!;
  if (!vaultRef || !shardRef) throw new Error("không thấy UTxO ref-script vừa đỗ");

  emulator.awaitSlot(Number(P / 1000n));
  await submit(postGreenBackTx(lucid, { greenback: s.greenback, beaconUtxo: await only(s.greenback.nftUnit), gbNanogic: GB, depeg: false, nowMs: now() }).tx, [writer]);
}, 120_000);

function commonParams(vault: UTxO) {
  return { lucid, network: "Preprod" as const, vaultUtxo: vault, vaultScript, vaultParams: vp, validity: win() };
}

async function genParams(vault: UTxO, m: bigint) {
  const shardId = vaultShardId(decodeVaultDatum(vault.datum!).owner);
  return {
    ...commonParams(vault), m,
    rateBeaconUtxo: await only(s.rate.nftUnit),
    greenbackBeaconUtxo: await only(s.greenback.nftUnit),
    gbShardUtxo: await only(s.gbShard.nftUnit(shardId)),
    vaultRefScriptUtxo: vaultRef,
    gbShardRefScriptUtxo: shardRef,
    vaultRegistryUtxo: await only(s.vaultRegistry.nftUnit),
    vaultRegistryPolicy: s.vaultRegistry.nftUnit.slice(0, 56),
    gbShardCapNanogic: CAP,
  };
}

describe("e2e Emulator — InstantGen v2.0 trên script đã apply", () => {
  let nft: string;
  let genM = 0n;

  it("genesis két (MintVaultId) qua validator thật", async () => {
    const seed = (await lucid.wallet().getUtxos()).find(u => u.assets.lovelace === 20_000_000n && Object.keys(u.assets).length === 1);
    if (!seed) throw new Error("không còn UTxO seed 20 ADA");
    nft = await openVault(seed, 5_000_000n);
    const v = await only(nft);
    expect(v.address).toBe(vaultAddr);
    expect(decodeVaultDatum(v.datum!).cap_epoch).toBe(0n);
  });

  it("CỰC ĐỐI: datum ra lệch 1 ở usage_window[0].generated ⟹ script từ chối (cùng bộ dựng)", async () => {
    const v = await only(nft);
    const p = await genParams(v, 1_000_000n);
    await expect(buildInstantGenTx({
      ...p,
      tamperOutputDatum: d => ({ ...d, usage_window: [{ ...d.usage_window[0]!, generated: d.usage_window[0]!.generated - 1n }, ...d.usage_window.slice(1)] }),
    })).rejects.toThrow(SCRIPT_FAILURE);
  });

  it("CỰC ĐỐI: datum ra lệch 1 ms ở instant_unlock_ms ⟹ script từ chối", async () => {
    const v = await only(nft);
    const p = await genParams(v, 1_000_000n);
    await expect(buildInstantGenTx({ ...p, tamperOutputDatum: d => ({ ...d, instant_unlock_ms: d.instant_unlock_ms - 1n }) }))
      .rejects.toThrow(SCRIPT_FAILURE);
  });

  it("InstantGen lượt đầu epoch (làm mới checkpoint bằng ρ, rút shard GB) — nộp được", async () => {
    const v = await only(nft);
    const p = await genParams(v, 1n);
    // m lớn nhất theo hàm thuần, chặn ở 1e6 cho gọn.
    const lim = instantGenLimits({
      vaultDatum: decodeVaultDatum(v.datum!), vaultOutRef: v, currentEpoch: EPOCH0 + 1n,
      rate: { rho_q: 1_000_000_000n, prev_rho_q: 0n, effective_epoch: EPOCH0 + 1n },
      wakeme: null,
      greenback: { gb_nanogic: GB, seq: 1n, epoch: EPOCH0 + 1n, depeg: false },
      shardIn: decodeGbShard(p.gbShardUtxo.datum), gbShardCapNanogic: CAP,
    });
    expect(lim.refreshed).toBe(true);
    expect(lim.maxM).toBeGreaterThan(0n);
    genM = lim.maxM < 1_000_000n ? lim.maxM : 1_000_000n;
    const res = await buildInstantGenTx({ ...p, m: genM });
    await submitBuilt(res.tx);
    const out = decodeVaultDatum((await only(nft)).datum!);
    expect(out.cap_epoch).toBe(EPOCH0 + 1n);
    expect(out.usage_window[0]!.generated).toBe(genM);
    expect(out.instant_unlock_ms).toBe(res.validity.toMs + P);
    const shard = decodeGbShard((await only(s.gbShard.nftUnit(vaultShardId(out.owner)))).datum);
    expect(shard.seq).toBe(1n);
    expect(shard.remaining).toBe(shard.reset_amount - genM);
  });

  it("lượt sinh THỨ HAI cùng epoch (không làm mới, không cần ρ) — nộp được, cộng dồn", async () => {
    const v = await only(nft);
    const p = await genParams(v, 7n);
    const { rateBeaconUtxo: _drop, ...noRate } = p;
    void _drop;
    const res = await buildInstantGenTx(noRate);
    expect(res.outputs.refreshed).toBe(false);
    await submitBuilt(res.tx);
    expect(decodeVaultDatum((await only(nft)).datum!).usage_window[0]!.generated).toBe(genM + 7n);
  });

  it("RefreshCheckpoint (luôn làm mới) — value ra == value vào, nộp được", async () => {
    const v = await only(nft);
    const res = await buildRefreshCheckpointTx({ ...commonParams(v), rateBeaconUtxo: await only(s.rate.nftUnit) });
    await submitBuilt(res.tx);
    const after = await only(nft);
    expect(after.assets).toEqual(v.assets);
    expect(decodeVaultDatum(after.datum!)).toEqual(res.outputDatum);
  });

  // Két mở ở ĐÚNG min-ADA (Lucid tự đặt lovelace), datum ra dài hơn datum vào ⟹ min-ADA
  // tăng. Validator cho lovelace ra ≥ vào, mọi token khác nguyên khối (ca "ra = vào − 1 bị
  // từ chối" canh ở tầng validator: `vault.ak ▸ rc_neg_ada_minus_one`). Ở đây: bộ dựng nạp
  // thêm đúng phần thiếu ⟹ UPLC thật chấp nhận, lovelace ra > vào, token khác không đổi.
  // Trước bản vá validator 2026-09-30, cùng két này bị từ chối `failed script execution`.
  it("min-ADA: két sát min-ADA ⟹ bộ dựng nạp thêm ADA, validator chấp nhận", async () => {
    const seed = (await lucid.wallet().getUtxos()).find(u => u.assets.lovelace === 20_000_000n && Object.keys(u.assets).length === 1);
    if (!seed) throw new Error("không còn UTxO seed 20 ADA");
    const unit = await openVault(seed, null);
    const v = await only(unit);
    const base = { ...commonParams(v), rateBeaconUtxo: await only(s.rate.nftUnit) };
    const res = await buildRefreshCheckpointTx(base);
    await submitBuilt(res.tx);
    const after = await only(unit);
    expect(after.assets.lovelace! > v.assets.lovelace!).toBe(true);
    const { lovelace: _a, ...restAfter } = after.assets;
    const { lovelace: _b, ...restBefore } = v.assets;
    expect(restAfter).toEqual(restBefore);
  });
});

// ── Hành trình người mới (2026-10-02) — gương `vault.ak ▸ np_journey_*` trên UPLC thật ─────
// (1) genesis két IG 0 LAMP, `wakeme_link` khai sẵn = owner_commit của DID;
// (2) [giả lập] genesis két Wakeme ghim két IG này: `vest_start_ms` = lúc tạo,
//     `gen_pin_period` = kỳ của mốc đó trên CÙNG lưới gốc `O` (vế (d) ngoại lệ genesis);
// (3) lượt sinh đầu, CÙNG kỳ: L_lent được tính ⟹ qua IG-6 dù két không có LAMP riêng.
// Bằng chứng ở (3) là UPLC thật nhận một két `lamp_balance = 0`: validator đòi
// `lamp_balance + L_lent ≥ min_instant_holding`, nên nó chỉ qua khi chính validator đã cộng L_lent.
describe("e2e Emulator — người mới: két IG 0 LAMP, phần mượn từ két Wakeme ghim lúc genesis", () => {
  let igNft: string;
  let wakeme: UTxO;
  const wakemeAddr = () => credentialToAddress("Custom", { type: "Script", hash: WAKEME_H });

  /** Datum két Wakeme 13 trường theo VỊ TRÍ (`wakeme_lent.ak` đầu tệp: [0] [2] [3] [7] [11] [12]). */
  function wakemeDatum(igName: string, vestStartMs: bigint, gpp: bigint): string {
    const pin = new Constr(0, [new Constr(0, [vaultHash, igName])]);
    return Data.to(new Constr(0, [WAKEME_COMMIT, "e5e5", vestStartMs, LENT_C, 0n, 0n, 0n, LENT_O, 1_000_000n, 0n, "f6f6", pin, gpp]));
  }

  /** UTxO seed riêng (21 ADA) — không tranh seed 20 ADA của các ca trên. */
  async function freshSeed(): Promise<UTxO> {
    const h = await submit(lucid.newTx().pay.ToAddress(deployer.address, { lovelace: 21_000_000n }));
    const u = (await emulator.getUtxos(deployer.address)).find(x => x.txHash === h && x.assets.lovelace === 21_000_000n && Object.keys(x.assets).length === 1);
    if (!u) throw new Error("không thấy UTxO seed 21 ADA vừa tạo");
    return u;
  }

  it("CỰC ĐỐI: genesis két IG với link 31 byte ⟹ validator mint từ chối (cùng bộ dựng)", async () => {
    await expect(openVault(await freshSeed(), 5_000_000n, 0n, "c3".repeat(31))).rejects.toThrow(/failed script execution Mint\[\d+\]/);
  });

  it("(1) genesis két IG 0 LAMP + link 32 byte ⟹ validator mint nhận", async () => {
    igNft = await openVault(await freshSeed(), 5_000_000n, 0n, WAKEME_COMMIT);
    const v = await only(igNft);
    expect(v.assets[lampUnit]).toBeUndefined();
    const d = decodeVaultDatum(v.datum!);
    expect(d.lamp_balance).toBe(0n);
    expect(d.loyalty_holdings).toEqual([]);
    expect(d.wakeme_link).toBe(WAKEME_COMMIT);
  });

  it("(2) két Wakeme ghim két IG này, vest_start ∈ kỳ hiện tại, [12] = kỳ đó", async () => {
    const holder = await only(WAKEME_NFT);
    const vest = BigInt(now());
    const gpp = floorDiv(vest - O, P);
    await submit(lucid.newTx()
      .collectFrom([holder])
      .pay.ToContract(wakemeAddr(), { kind: "inline", value: wakemeDatum(igNft.slice(56), vest, gpp) },
        { lovelace: 5_000_000n, [WAKEME_NFT]: 1n, [lampUnit]: LENT_C + LENT_O }), [wakemeHolder]);
    wakeme = await only(WAKEME_NFT);
    expect(wakeme.address).toBe(wakemeAddr());
  });

  it("CỰC ĐỐI: lượt sinh đầu, datum ra lệch 1 ở cap_nanogic ⟹ script từ chối (cùng bộ dựng)", async () => {
    const v = await only(igNft);
    const p = await genParams(v, 1_000_000n);
    await expect(buildInstantGenTx({
      ...p, wakemeVaultUtxo: wakeme, tamperOutputDatum: d => ({ ...d, cap_nanogic: d.cap_nanogic - 1n }),
    })).rejects.toThrow(SCRIPT_FAILURE);
  });

  it("(3) lượt sinh ĐẦU cùng kỳ genesis két Wakeme ⟹ L_lent tính, UPLC thật nhận két 0 LAMP", async () => {
    const v = await only(igNft);
    const p = await genParams(v, 1_000_000n);
    const res = await buildInstantGenTx({ ...p, wakemeVaultUtxo: wakeme });
    const wd = Data.from(wakeme.datum!) as Constr<bigint>;
    expect(res.currentEpoch).toBe(wd.fields[12]);         // cùng kỳ ⟹ chỉ vế genesis cứu được
    expect(res.outputs.lent).toBe(LENT_C + LENT_O);
    expect(res.outputs.lAvail).toBe(0n);
    expect(res.outputs.maxM >= 1_000_000n).toBe(true);
    await submitBuilt(res.tx);
    const out = decodeVaultDatum((await only(igNft)).datum!);
    expect(out.lamp_balance).toBe(0n);
    expect(out.wakeme_link).toBe(WAKEME_COMMIT);
    expect(out.cap_epoch).toBe(res.currentEpoch);
    expect(out.usage_window[0]!.generated).toBe(1_000_000n);
    // Két Wakeme chỉ được ĐỌC: vẫn nguyên ở chỗ cũ.
    expect(await only(WAKEME_NFT)).toEqual(wakeme);
  });
});
