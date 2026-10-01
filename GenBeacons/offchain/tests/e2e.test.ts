// e2e trên Lucid Emulator: deploy đủ thứ tự rồi chạy các luồng ghi/rút, đánh giá UPLC THẬT.
//
// Thứ tự deploy (đầu tệp validators/vault_registry.ak):
//   hash sổ → apply beacon GB → apply gb_shard (bake hash sổ) → két giả → đúc sổ [hash két giả]
//   → khởi tạo beacon GB → đúc 16 shard → khởi tạo beacon ρ.
//
// KÉT GIẢ: một native script `sig(deployer)`. Shard chỉ đòi (gb_shard.ak ▸ `exactly_one_vault`)
// đúng MỘT input tại một script có trong sổ, mang đúng MỘT token dưới policy = hash chính
// script đó. Native script có script hash dùng được làm cả payment credential lẫn policy, nên
// thoả hình dạng mà không cần validator két thật. Nó KHÔNG bake `gb_shard_policy_id` như két
// thật — bài này đo shard + beacon + sổ, không đo nhánh két.
//
// Emulator không chạy script lúc nộp; Lucid đánh giá UPLC cục bộ trong `complete()`. Nên ca âm
// là `complete()` bị từ chối, và mỗi ca âm đi CẶP với một ca dương chỉ khác đúng một ô, dựng
// bằng CÙNG hàm thô — để đỏ là do validator, không do bộ dựng.

import {
  Emulator,
  generateEmulatorAccount,
  generateEmulatorAccountFromPrivateKey,
  getAddressDetails,
  Lucid,
  mintingPolicyToId,
  scriptFromNative,
  toUnit,
  validatorToAddress,
  type EmulatorAccount,
  type LucidEvolution,
  type Script,
  type TxBuilder,
  type UTxO,
} from "@lucid-evolution/lucid";
import { beforeAll, describe, expect, it } from "vitest";
import {
  addShardDraw,
  addShardSpendRaw,
  decodeGbShard,
  decodeGreenBackBeacon,
  decodeRateParam,
  decodeVaultRegistry,
  deriveGenBeaconsScripts,
  epochValidityWindow,
  initGreenBackBeaconTx,
  initRateBeaconTx,
  loadBlueprint,
  mintGbShardsTx,
  mintVaultRegistryTx,
  postGreenBackTx,
  postRateTx,
  shardResetAmount,
  spendGreenBackBeaconRaw,
  spendRateBeaconRaw,
  SHARD_COUNT,
  type GenBeaconsScripts,
} from "../src/index.js";

const MS_PER_EPOCH = 3_600_000n; // 1 giờ — đủ ngắn để sang epoch bằng `awaitSlot`.
const EPOCH0 = 500_000n;
const CAP = 1_800_000_000_000_000n; // gb_shard_cap_nanogic TẠM (CC-GEN-SURPLUS-SHARD)
const RHO_MAX = 4_000_000_000n; // rho_max_q TẠM (CC-GEN-RATE-VALUE)

const pkh = (a: EmulatorAccount): string => {
  const c = getAddressDetails(a.address).paymentCredential;
  if (c?.type !== "Key") throw new Error("tài khoản emulator không có key credential");
  return c.hash;
};

let emulator: Emulator;
let lucid: LucidEvolution;
let deployer: EmulatorAccount;
let rateKey: EmulatorAccount;
let writer: EmulatorAccount;
let stranger: EmulatorAccount;
let s: GenBeaconsScripts;
let vaultScript: Script;
let vaultHash: string;
let vaultAddr: string;
let vaultNft: string;

/** Lỗi của Lucid bọc trong Effect — gom `message` + `cause` thành chữ để đọc/so được. */
function describeError(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    return `${e.name}: ${e.message}${cause === undefined ? "" : ` | cause: ${typeof cause === "string" ? cause : JSON.stringify(cause)}`}`;
  }
  return typeof e === "string" ? e : JSON.stringify(e);
}

async function completeOrThrow(tx: TxBuilder) {
  const r = await tx.completeSafe();
  if (r._tag === "Left") throw new Error(describeError(r.left));
  return r.right;
}

async function submit(tx: TxBuilder, extraKeys: EmulatorAccount[] = []): Promise<string> {
  let signer = (await completeOrThrow(tx)).sign.withWallet();
  for (const k of extraKeys) signer = signer.sign.withPrivateKey(k.privateKey);
  const signed = await signer.completeSafe();
  if (signed._tag === "Left") throw new Error(`ký: ${describeError(signed.left)}`);
  const sub = await signed.right.submitSafe();
  if (sub._tag === "Left") throw new Error(`nộp: ${describeError(sub.left)}`);
  const hash = sub.right;
  emulator.awaitBlock(1);
  return hash;
}

async function only(unit: string): Promise<UTxO> {
  const u = (await emulator.getUtxoByUnit(unit)) as UTxO | undefined;
  if (!u) throw new Error(`không có UTxO nào mang ${unit}`);
  return u;
}

const now = () => emulator.now();

/** Dấu của lần đánh giá script THẤT BẠI — để ca âm đỏ vì VALIDATOR, không vì lý do khác. */
/** Dạng Lucid 0.4.30 báo: `failed script execution Mint[0] the validator crashed …`. */
const SCRIPT_FAILURE = /failed script execution (Spend|Mint)\[\d+\]/;

/** Ca âm: `completeSafe` phải trả Left, và Left đó phải là lần đánh giá script thất bại. */
async function expectRejected(tx: TxBuilder, purpose: "Spend" | "Mint" = "Spend"): Promise<void> {
  const r = await tx.completeSafe();
  expect(r._tag, "giao dịch lẽ ra bị validator từ chối").toBe("Left");
  if (r._tag === "Left") {
    const msg = describeError(r.left);
    expect(msg).toMatch(SCRIPT_FAILURE);
    expect(msg).toMatch(new RegExp(`${purpose}\\[`));
  }
}

beforeAll(async () => {
  deployer = generateEmulatorAccount({ lovelace: 100_000_000_000n });
  rateKey = generateEmulatorAccountFromPrivateKey({ lovelace: 50_000_000n });
  writer = generateEmulatorAccountFromPrivateKey({ lovelace: 50_000_000n });
  stranger = generateEmulatorAccountFromPrivateKey({ lovelace: 50_000_000n });
  emulator = new Emulator([deployer, rateKey, writer, stranger]);
  // Ghim đồng hồ: đầu epoch EPOCH0 + 60 s. Gốc slot (= now lúc dựng Lucid) tròn giây ⟹ ranh
  // giới epoch trùng ranh giới slot, đúng giả định của `epochValidityWindow`.
  emulator.time = Number(EPOCH0 * MS_PER_EPOCH + 60_000n);
  lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(deployer.seedPhrase);

  // Tách 4 UTxO làm seed cho bốn validator one-shot.
  let split = lucid.newTx();
  for (let i = 0; i < 4; i++) split = split.pay.ToAddress(deployer.address, { lovelace: 20_000_000n });
  const splitHash = await submit(split);
  const seed = (i: number) => ({ txHash: splitHash, outputIndex: i });

  // 1–3: hash sổ → beacon GB → gb_shard (bake hash sổ + hash beacon); ρ độc lập.
  s = deriveGenBeaconsScripts(loadBlueprint(), "Custom", {
    msPerEpoch: MS_PER_EPOCH,
    vaultRegistrySeed: seed(0),
    greenbackWriter: pkh(writer),
    greenbackSeed: seed(1),
    gbShardCapNanogic: CAP,
    gbShardSeed: seed(2),
    rateKey: pkh(rateKey),
    rhoMaxQ: RHO_MAX,
    rateSeed: seed(3),
  });

  // 4: két giả (xem đầu tệp).
  vaultScript = scriptFromNative({ type: "sig", keyHash: pkh(deployer) });
  vaultHash = mintingPolicyToId(vaultScript);
  vaultAddr = validatorToAddress("Custom", vaultScript);
  vaultNft = toUnit(vaultHash, "76617531"); // "vau1"
  await submit(
    lucid
      .newTx()
      .mintAssets({ [vaultNft]: 1n })
      .attach.MintingPolicy(vaultScript)
      .pay.ToAddress(vaultAddr, { lovelace: 5_000_000n, [vaultNft]: 1n }),
  );
});

async function seedUtxo(i: number): Promise<UTxO> {
  const refs = [s.vaultRegistry.seed, s.greenback.seed, s.gbShard.seed, s.rate.seed];
  const r = refs[i];
  if (!r) throw new Error(`không có seed #${i}`);
  const [u] = await emulator.getUtxosByOutRef([r]);
  if (!u) throw new Error(`seed #${i} không còn trên sổ cái`);
  return u;
}

describe("deploy đủ thứ tự trên Emulator", () => {
  it("5: đúc sổ két với [hash két giả]; sổ không tiêu được", async () => {
    const { tx } = mintVaultRegistryTx(lucid, {
      vaultRegistry: s.vaultRegistry,
      seedUtxo: await seedUtxo(0),
      vaultScriptHashes: [vaultHash],
    });
    await submit(tx);
    const reg = await only(s.vaultRegistry.nftUnit);
    expect(reg.address).toBe(s.vaultRegistry.address);
    expect(decodeVaultRegistry(reg.datum).vault_script_hashes).toEqual([vaultHash]);
    // spend luôn từ chối
    await expectRejected(lucid
        .newTx()
        .collectFrom([reg], "d87980")
        .attach.SpendingValidator(s.vaultRegistry.script)
        .pay.ToContract(reg.address, { kind: "inline", value: reg.datum ?? "" }, reg.assets));
  });

  it("khởi tạo beacon GB: người ký lạ bị từ chối, bên ghi thì qua", async () => {
    const seed = await seedUtxo(1);
    // Ca âm: cùng giao dịch, chỉ đổi khoá ký — dựng thô bằng cách đổi `writer` của bộ script.
    const forged = { ...s.greenback, writer: pkh(stranger) };
    const bad = initGreenBackBeaconTx(lucid, { greenback: forged, seedUtxo: seed, gbNanogic: 0n, nowMs: now() });
    await expectRejected(bad.tx, "Mint");

    const { tx, datum } = initGreenBackBeaconTx(lucid, { greenback: s.greenback, seedUtxo: seed, gbNanogic: 0n, nowMs: now() });
    await submit(tx, [writer]);
    const b = await only(s.greenback.nftUnit);
    expect(decodeGreenBackBeacon(b.datum)).toEqual(datum);
    expect(datum).toEqual({ gb_nanogic: 0n, seq: 0n, epoch: EPOCH0, depeg: false });
  });

  it("đúc 16 shard, mỗi cái { id, 0, 0, 0 } tại script shard", async () => {
    const { tx } = mintGbShardsTx(lucid, { gbShard: s.gbShard, seedUtxo: await seedUtxo(2) });
    await submit(tx);
    for (let i = 0n; i < SHARD_COUNT; i++) {
      const u = await only(s.gbShard.nftUnit(i));
      expect(u.address).toBe(s.gbShard.address);
      expect(decodeGbShard(u.datum)).toEqual({ shard_id: i, seq: 0n, reset_amount: 0n, remaining: 0n });
    }
  });

  it("khởi tạo beacon ρ: hiệu lực epoch sau, prev = 0", async () => {
    const { tx, datum } = initRateBeaconTx(lucid, {
      rate: s.rate,
      seedUtxo: await seedUtxo(3),
      rhoQ: 1_000_000_000n,
      nowMs: now(),
    });
    await submit(tx, [rateKey]);
    expect(datum).toEqual({ rho_q: 1_000_000_000n, prev_rho_q: 0n, effective_epoch: EPOCH0 + 1n });
    expect(decodeRateParam((await only(s.rate.nftUnit)).datum)).toEqual(datum);
  });
});

describe("beacon ρ — đăng ρ mới", () => {
  it("khoá lạ bị từ chối; khoá đăng với CÙNG datum thì qua", async () => {
    const beacon = await only(s.rate.nftUnit);
    const w = epochValidityWindow(now(), MS_PER_EPOCH);
    const next = { rho_q: 2_000_000_000n, prev_rho_q: 0n, effective_epoch: w.epoch + 1n };
    const bad = spendRateBeaconRaw(lucid, { rate: s.rate, beaconUtxo: beacon, next, signer: pkh(stranger), window: w });
    await expectRejected(bad);
    const good = spendRateBeaconRaw(lucid, { rate: s.rate, beaconUtxo: beacon, next, signer: pkh(rateKey), window: w });
    await submit(good, [rateKey]);
    expect(decodeRateParam((await only(s.rate.nftUnit)).datum)).toEqual(next);
  });

  it("trên rho_max_q 1 bị từ chối; ĐÚNG rho_max_q thì qua", async () => {
    const beacon = await only(s.rate.nftUnit);
    const w = epochValidityWindow(now(), MS_PER_EPOCH);
    const cur = decodeRateParam(beacon.datum);
    // Cùng epoch với lượt đăng trước ⟹ ρ hiệu lực vẫn là prev (0), không phải 2·10⁹ chưa hiệu lực.
    const prev = cur.prev_rho_q;
    const over = { rho_q: RHO_MAX + 1n, prev_rho_q: prev, effective_epoch: w.epoch + 1n };
    await expectRejected(spendRateBeaconRaw(lucid, { rate: s.rate, beaconUtxo: beacon, next: over, signer: pkh(rateKey), window: w }));
    const { tx, datum } = postRateTx(lucid, { rate: s.rate, beaconUtxo: beacon, newRhoQ: RHO_MAX, nowMs: now() });
    expect(datum).toEqual({ rho_q: RHO_MAX, prev_rho_q: 0n, effective_epoch: EPOCH0 + 1n });
    await submit(tx, [rateKey]);
  });

  it("sang epoch sau: prev = ρ vừa có hiệu lực, hiệu lực lại lùi một epoch", async () => {
    emulator.awaitSlot(Number(MS_PER_EPOCH / 1_000n));
    const beacon = await only(s.rate.nftUnit);
    const { tx, datum } = postRateTx(lucid, { rate: s.rate, beaconUtxo: beacon, newRhoQ: 3_000_000_000n, nowMs: now() });
    expect(datum).toEqual({ rho_q: 3_000_000_000n, prev_rho_q: RHO_MAX, effective_epoch: EPOCH0 + 2n });
    await submit(tx, [rateKey]);
  });
});

describe("beacon GB + shard: ghi rồi rút, shard đặt lại lười", () => {
  const SHARD_ID = 5n;

  async function vaultUtxo(): Promise<UTxO> {
    return only(vaultNft);
  }

  function withVault(tx: TxBuilder, v: UTxO): TxBuilder {
    return tx
      .collectFrom([v])
      .attach.SpendingValidator(vaultScript)
      .pay.ToAddress(vaultAddr, v.assets);
  }

  it("trước lượt ghi đầu tiên: shard còn 0 ⟹ rút 1 bị từ chối, rút 0 thì qua", async () => {
    const [shard, beacon, reg, v] = await Promise.all([
      only(s.gbShard.nftUnit(SHARD_ID)),
      only(s.greenback.nftUnit),
      only(s.vaultRegistry.nftUnit),
      vaultUtxo(),
    ]);
    const cur = decodeGbShard(shard.datum);
    const bad = addShardSpendRaw(withVault(lucid.newTx(), v), {
      gbShard: s.gbShard, shardUtxo: shard, refs: [beacon, reg], amount: 1n, next: { ...cur, remaining: -1n },
    });
    await expectRejected(bad);
    const good = addShardSpendRaw(withVault(lucid.newTx(), v), {
      gbShard: s.gbShard, shardUtxo: shard, refs: [beacon, reg], amount: 0n, next: cur,
    });
    await submit(good);
  });

  it("ghi GB: người ký lạ bị từ chối; bên ghi với CÙNG datum thì qua (seq 0 → 1)", async () => {
    const beacon = await only(s.greenback.nftUnit);
    const w = epochValidityWindow(now(), MS_PER_EPOCH);
    const next = { gb_nanogic: 16n * 1_000n + 15n, seq: 1n, epoch: w.epoch, depeg: false };
    const bad = spendGreenBackBeaconRaw(lucid, { greenback: s.greenback, beaconUtxo: beacon, next, signer: pkh(stranger), window: w });
    await expectRejected(bad);
    const good = spendGreenBackBeaconRaw(lucid, { greenback: s.greenback, beaconUtxo: beacon, next, signer: pkh(writer), window: w });
    await submit(good, [writer]);
    expect(decodeGreenBackBeacon((await only(s.greenback.nftUnit)).datum)).toEqual(next);
  });

  it("seq lùi (1 → 0) và seq đứng (1 → 1) bị từ chối; seq tiến (1 → 2) thì qua", async () => {
    const beacon = await only(s.greenback.nftUnit);
    const w = epochValidityWindow(now(), MS_PER_EPOCH);
    const base = { gb_nanogic: 16n * 1_000n + 15n, epoch: w.epoch, depeg: false };
    for (const seq of [0n, 1n]) {
      await expectRejected(spendGreenBackBeaconRaw(lucid, {
          greenback: s.greenback, beaconUtxo: beacon, next: { ...base, seq }, signer: pkh(writer), window: w,
        }));
    }
    // Cùng GB, seq 2 — lượng đặt lại vẫn 1000.
    const { tx, datum } = postGreenBackTx(lucid, {
      greenback: s.greenback, beaconUtxo: beacon, gbNanogic: base.gb_nanogic, depeg: false, nowMs: now(),
    });
    expect(datum.seq).toBe(2n);
    await submit(tx, [writer]);
  });

  it("rút sau lượt ghi: shard đặt lại về ⌊GB/16⌋ rồi trừ; datum không đặt lại bị từ chối", async () => {
    const [shard, beacon, reg, v] = await Promise.all([
      only(s.gbShard.nftUnit(SHARD_ID)),
      only(s.greenback.nftUnit),
      only(s.vaultRegistry.nftUnit),
      vaultUtxo(),
    ]);
    expect(decodeGbShard(shard.datum).remaining).toBe(0n);
    // Ca âm: khai rút 400 nhưng output giữ seq cũ (bỏ qua đặt lại) — validator đòi đúng bản ghi.
    const stale = { ...decodeGbShard(shard.datum), remaining: 0n };
    await expectRejected(addShardSpendRaw(withVault(lucid.newTx(), v), {
        gbShard: s.gbShard, shardUtxo: shard, refs: [beacon, reg], amount: 0n, next: stale,
      }));
    // Ca âm: rút hơn lượng đặt lại 1.
    const reset = shardResetAmount(16n * 1_000n + 15n, CAP);
    expect(reset).toBe(1_000n);
    await expectRejected(addShardSpendRaw(withVault(lucid.newTx(), v), {
        gbShard: s.gbShard, shardUtxo: shard, refs: [beacon, reg], amount: reset + 1n,
        next: { shard_id: SHARD_ID, seq: 2n, reset_amount: reset, remaining: -1n },
      }));

    const { tx, datum } = addShardDraw(withVault(lucid.newTx(), v), {
      gbShard: s.gbShard, shardUtxo: shard, beaconUtxo: beacon, registryUtxo: reg,
      registry: s.vaultRegistry, amount: 400n, vaultScriptHash: vaultHash,
    });
    expect(datum).toEqual({ shard_id: SHARD_ID, seq: 2n, reset_amount: 1_000n, remaining: 600n });
    await submit(tx);
    expect(decodeGbShard((await only(s.gbShard.nftUnit(SHARD_ID))).datum)).toEqual(datum);
  });

  it("thiếu két đi kèm ⟹ shard từ chối (cùng giao dịch có két thì qua ở bài trên)", async () => {
    const [shard, beacon, reg] = await Promise.all([
      only(s.gbShard.nftUnit(SHARD_ID)),
      only(s.greenback.nftUnit),
      only(s.vaultRegistry.nftUnit),
    ]);
    const cur = decodeGbShard(shard.datum);
    await expectRejected(addShardSpendRaw(lucid.newTx(), {
        gbShard: s.gbShard, shardUtxo: shard, refs: [beacon, reg], amount: 1n, next: { ...cur, remaining: cur.remaining - 1n },
      }));
  });

  it("ghi GB vượt trần: shard đặt lại về cap, KHÔNG cộng dồn phần còn lại cũ", async () => {
    const beacon = await only(s.greenback.nftUnit);
    const gb = 16n * CAP + 1_600n;
    await submit(postGreenBackTx(lucid, { greenback: s.greenback, beaconUtxo: beacon, gbNanogic: gb, depeg: false, nowMs: now() }).tx, [writer]);
    const [shard, b2, reg, v] = await Promise.all([
      only(s.gbShard.nftUnit(SHARD_ID)),
      only(s.greenback.nftUnit),
      only(s.vaultRegistry.nftUnit),
      vaultUtxo(),
    ]);
    expect(decodeGbShard(shard.datum).remaining).toBe(600n);
    const { tx, datum } = addShardDraw(withVault(lucid.newTx(), v), {
      gbShard: s.gbShard, shardUtxo: shard, beaconUtxo: b2, registryUtxo: reg, registry: s.vaultRegistry, amount: 1n,
    });
    expect(datum).toEqual({ shard_id: SHARD_ID, seq: 3n, reset_amount: CAP, remaining: CAP - 1n });
    await submit(tx);
    // Ca âm cùng hình dạng: cộng dồn (600 + cap) bị từ chối.
    const [shard2, b3, reg3, v3] = await Promise.all([
      only(s.gbShard.nftUnit(SHARD_ID)),
      only(s.greenback.nftUnit),
      only(s.vaultRegistry.nftUnit),
      vaultUtxo(),
    ]);
    await submit(postGreenBackTx(lucid, { greenback: s.greenback, beaconUtxo: b3, gbNanogic: gb, depeg: false, nowMs: now() }).tx, [writer]);
    const b4 = await only(s.greenback.nftUnit);
    const cur = decodeGbShard(shard2.datum);
    await expectRejected(addShardSpendRaw(withVault(lucid.newTx(), v3), {
        gbShard: s.gbShard, shardUtxo: shard2, refs: [b4, reg3], amount: 0n,
        next: { shard_id: SHARD_ID, seq: 4n, reset_amount: CAP, remaining: cur.remaining + CAP },
      }));
  });
});
