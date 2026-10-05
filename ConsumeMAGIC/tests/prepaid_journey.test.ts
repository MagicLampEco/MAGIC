// tests/prepaid_journey.test.ts — hành trình tài trợ của người mới trên két PrepaidGen, Lucid
// Emulator, đánh giá UPLC THẬT (blueprint `ConsumeMAGIC/onchain/plutus.json` +
// `PrepaidGen/onchain/plutus.json`, do `aiken build` sinh).
//
//   T1  một tx: đúc két Prepaid (`addMintPrepaidVault`) + đúc thread consume (`addMintEngage`),
//       `did_commit = blake2b_256(utf8(did))` ghi lúc đúc; chủ hai bên là CÙNG `Script(h)` ⟹ đúng
//       MỘT mục rút phủ cả hai cổng `owner_authorized`.
//   T2  PrepaidLock 1 CARP + FundLock — CARP do ví bên tài trợ chi, chủ két chứng minh quyền.
//   T3  PrepaidDraw ⟹ một lô MAGIC kỳ e.
//   T4  Consume + BurnBatch trên két Prepaid: `prepaidBurnFor` → các trường của `ConsumeParams`.
//
// Đứng thay `did_stake`: native script `sig(didKey)` làm stake credential (cùng khuôn với
// `PrepaidGen/tests/txEmulator.test.ts`). Validator chỉ đọc `Script(h)` trong `withdrawals`, không
// đọc script nào đứng sau h — nên bài này ghim cổng `owner_authorized`, KHÔNG ghim luật của chính
// `did_stake` (blueprint của nó không có trong kho này).
//
// Lưới epoch: `consume` tính epoch theo MẠNG (`@magiclamp/protocol-utils`), nên cả hai bộ script
// apply `ms_per_epoch`/`window_origin_ms` của Preprod và đồng hồ Emulator đặt trên lưới đó.
//
// Bài nằm ở ConsumeMAGIC vì `consume` là tầng đọc mọi loại két; nó nạp mã PrepaidGen theo đường
// tương đối (không thêm phụ thuộc gói). Hai bản Lucid (CM 0.4.30, PG 0.4.34) chỉ trao nhau CBOR
// và chuỗi; `TxBuilder` do bản của CM tạo và PG chỉ gọi phương thức trên nó.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blake2b } from "@noble/hashes/blake2b";
import {
  CML,
  Constr,
  Data,
  Emulator,
  Lucid,
  PROTOCOL_PARAMETERS_DEFAULT,
  applyParamsToScript,
  credentialToRewardAddress,
  generateEmulatorAccount,
  generateEmulatorAccountFromPrivateKey,
  getAddressDetails,
  scriptFromNative,
  validatorToAddress,
  validatorToScriptHash,
  type EmulatorAccount,
  type LucidEvolution,
  type TxBuilder,
  type TxSignBuilder,
  type UTxO,
  type Validator,
} from "@lucid-evolution/lucid";
import { epochValidityWindow, msPerEpoch, posixMsToEpoch, windowOriginMs } from "@magiclamp/protocol-utils";
import { beforeAll, describe, expect, it } from "vitest";
import {
  addMintEngage,
  buildConsumeTx,
  decodePriceParam,
  encodePriceParam,
  requiredFromBeacon,
  type ConsumeParams,
  type EngageOwnerProof,
} from "../offchain/src/index.js";
import {
  addMintPaidFund,
  addMintPrepaidVault,
  addPrepaidDraw,
  addPrepaidLock,
  decodeVaultDatum,
  derivePrepaidScripts,
  encodeVaultDatum,
  epochOfValidity,
  parMagicFromCarp,
  planPrepaidBurns,
  prepaidBurnFor,
  validityInEpoch,
  withRefScripts,
  type PrepaidBlueprint,
  type PrepaidScripts,
  type PrepaidVaultDatum,
} from "../../PrepaidGen/offchain/src/index.js";

// ── Lưới + hằng ───────────────────────────────────────────────────────────────

const NET = "Preprod" as const;
const P = msPerEpoch(NET);
const O = windowOriginMs(NET);
const E0 = 330n;
const CARP = 1_000_000_000n;
const CARP_POLICY = "22".repeat(28);
const CARP_NAME = "5a".repeat(28);
const CARP_UNIT = CARP_POLICY + CARP_NAME;
const PREPAID_BURN_CONSTR = 2n; // `PrepaidVaultRedeemer::BurnBatch` — genV2Checkpoint.ts
const MAX_PRICE_STALE = 2n;
const PRICE_NFT_NAME = "5052494345"; // "PRICE"
const SLOW = 900_000;

/** Trần mainnet đang dùng để đọc số đo (task: 16,5 triệu mem / 10 tỷ cpu / 16.384 byte). */
const MAINNET_MAX_MEM = 16_500_000n;
const MAINNET_MAX_STEPS = 10_000_000_000n;
const MAINNET_MAX_TX = 16_384;

const DID = "did:phoenixkey:preprod:newcomer-0001";
const DID_COMMIT = Buffer.from(blake2b(new TextEncoder().encode(DID), { dkLen: 32 })).toString("hex");

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const CM_BP = process.env["CONSUME_BLUEPRINT"] ?? here("../onchain/plutus.json");
const PG_BP = process.env["PREPAID_BLUEPRINT"] ?? here("../../PrepaidGen/onchain/plutus.json");

// ── Cầu nối kiểu giữa hai bản Lucid (cùng một đối tượng lúc chạy) ──────────────
type PgTx = Parameters<typeof addMintPrepaidVault>[0];
const toPg = (t: TxBuilder): PgTx => t as unknown as PgTx;
const toCm = (t: PgTx): TxBuilder => t as unknown as TxBuilder;
type PgUtxo = Parameters<typeof prepaidBurnFor>[1];
const toPgU = (u: UTxO): PgUtxo => u as unknown as PgUtxo;
type PgAuth = Extract<Parameters<typeof addPrepaidDraw>[1]["ownerProof"], { mode: "attach" }>["auth"];
const toPgAuth = (a: ReturnType<typeof didAuth>): PgAuth => a as unknown as PgAuth;

// ── Trạng thái dùng chung giữa các bước ───────────────────────────────────────

let emulator: Emulator;
let lucid: LucidEvolution;
let sponsor: EmulatorAccount;
let didKey: EmulatorAccount;
let userKey: EmulatorAccount;
let provider: EmulatorAccount;
let holder: EmulatorAccount;
let scripts: PrepaidScripts;      // két + quỹ, ref-script gắn sau bước công bố
let consumeScript: Validator;
let consumeRef: UTxO;
let vaultRef: UTxO;
let beaconUnit = "";
let fundUnit = "";
let fundId = "";
let didHash = "";
let didReward = "";
let didNative: ReturnType<typeof scriptFromNative>;
let vaultUnit = "";
let threadUnit = "";
let journeyEpoch = 0n;

const MEASURE: string[] = [];
const note = (s: string) => { MEASURE.push(s); console.log(`[G3-MEASURE] ${s}`); };

const pkh = (a: EmulatorAccount): string => {
  const c = getAddressDetails(a.address).paymentCredential;
  if (c?.type !== "Key") throw new Error("tài khoản emulator không có key credential");
  return c.hash;
};

function describeError(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    return `${e.name}: ${e.message}${cause === undefined ? "" : ` | cause: ${typeof cause === "string" ? cause : JSON.stringify(cause)}`}`;
  }
  return typeof e === "string" ? e : JSON.stringify(e);
}

async function submitSigned(tx: TxSignBuilder, extra: EmulatorAccount[] = []): Promise<string> {
  let s = tx.sign.withWallet();
  for (const k of extra) s = s.sign.withPrivateKey(k.privateKey);
  const signed = await s.completeSafe();
  if (signed._tag === "Left") throw new Error(`ký: ${describeError(signed.left)}`);
  const sub = await signed.right.submitSafe();
  if (sub._tag === "Left") throw new Error(`nộp: ${describeError(sub.left)}`);
  emulator.awaitBlock(1);
  return sub.right;
}

async function submit(tx: TxBuilder, extra: EmulatorAccount[] = []): Promise<{ hash: string; cbor: string }> {
  const c = await tx.completeSafe();
  if (c._tag === "Left") throw new Error(describeError(c.left));
  const cbor = c.right.toCBOR();
  return { hash: await submitSigned(c.right, extra), cbor };
}

/** Dựng tx; trả thông điệp từ chối, hoặc "ACCEPTED" nếu dựng được. */
async function rejection(tx: TxBuilder): Promise<string> {
  const c = await tx.completeSafe();
  return c._tag === "Left" ? describeError(c.left) : "ACCEPTED";
}

// Thông điệp khi UPLC từ chối trong `complete()` — cùng mẫu với PrepaidGen/tests/txEmulator.test.ts.
const SCRIPT_FAIL = /failed script execution (Spend|Mint)\[\d+\]/;

async function only(unit: string): Promise<UTxO> {
  const u = (await emulator.getUtxoByUnit(unit)) as UTxO | undefined;
  if (!u) throw new Error(`không có UTxO nào mang ${unit}`);
  return u;
}

const nowMs = () => BigInt(emulator.now());
const pgValidity = () => validityInEpoch(nowMs(), P, O);

function goToEpoch(e: bigint) {
  const target = O + e * P + 60_000n;
  const slots = Number((target - nowMs()) / 1000n);
  if (slots <= 0) throw new Error(`đã ở sau epoch ${e}`);
  emulator.awaitSlot(slots);
}

async function freshSeed(): Promise<UTxO> {
  const { hash } = await submit(lucid.newTx().pay.ToAddress(sponsor.address, { lovelace: 10_000_000n }));
  return (await emulator.getUtxosByOutRef([{ txHash: hash, outputIndex: 0 }]))[0]!;
}

/** ExUnit từng redeemer + tổng, đọc từ witness set của tx đã `complete()`. Hình dạng lạ ⟹ NÉM. */
function exUnitsOf(cbor: string) {
  const rs = CML.Transaction.from_cbor_hex(cbor).witness_set().redeemers();
  if (!rs) throw new Error("tx không có redeemer nào");
  const flat = rs.to_flat_format();
  const each: { tag: number; index: bigint; mem: bigint; steps: bigint }[] = [];
  for (let i = 0; i < flat.len(); i++) {
    const r = flat.get(i);
    each.push({ tag: r.tag(), index: r.index(), mem: r.ex_units().mem(), steps: r.ex_units().steps() });
  }
  const mem = each.reduce((a, r) => a + r.mem, 0n);
  const steps = each.reduce((a, r) => a + r.steps, 0n);
  return { each, mem, steps };
}

function measure(label: string, cbor: string) {
  const bytes = cbor.length / 2;
  const ex = exUnitsOf(cbor);
  note(
    `${label}: ${bytes} B (trần ${MAINNET_MAX_TX}, còn ${MAINNET_MAX_TX - bytes}) · mem ${ex.mem} ` +
      `(${(Number(ex.mem) * 100 / Number(MAINNET_MAX_MEM)).toFixed(1)}% của ${MAINNET_MAX_MEM}) · cpu ${ex.steps} ` +
      `(${(Number(ex.steps) * 100 / Number(MAINNET_MAX_STEPS)).toFixed(1)}% của ${MAINNET_MAX_STEPS}) · ` +
      ex.each.map((r) => `tag${r.tag}[${r.index}] mem=${r.mem} cpu=${r.steps}`).join(" ; "),
  );
  return { bytes, ...ex };
}

/** min-ADA của output `index` trong tx `cbor` (CML, coinsPerUtxoByte của Emulator). */
function minAdaOf(cbor: string, index: number): bigint {
  const out = CML.Transaction.from_cbor_hex(cbor).body().outputs().get(index);
  return CML.min_ada_required(out, PROTOCOL_PARAMETERS_DEFAULT.coinsPerUtxoByte);
}

function withdrawalCount(cbor: string): number {
  const w = CML.Transaction.from_cbor_hex(cbor).body().withdrawals();
  return w === undefined ? 0 : w.len();
}

/** EngageDatum thô: Constr 0 [owner, consumed_count, last_epoch, did_commit, consumed_nanogic]. */
function rawEngage(u: UTxO): Constr<Data> {
  const d = Data.from(u.datum!);
  if (!(d instanceof Constr) || d.index !== 0 || d.fields.length !== 5) {
    throw new Error(`thread ${u.txHash}#${u.outputIndex}: datum không phải Constr 0 năm trường`);
  }
  return d;
}

/** Mục rút `Script(did_stake)` — gắn ĐÚNG một lần cho cả tx. */
const attachDidWithdraw = (t: TxBuilder): TxBuilder => t.withdraw(didReward, 0n).attach.Script(didNative);
const didAuth = () => ({ kind: "script" as const, hash: didHash, attachWithdraw: attachDidWithdraw });
const didOwner = () => ({ type: "script" as const, hash: didHash });

/**
 * T1 ghép: mảnh két rồi mảnh thread, CHUNG một seed (mảnh két `collectFrom`, mảnh thread không),
 * cả hai ở chế độ `deferred`. `withdraws` = số lần gắn mục rút sau khi ghép.
 */
function composeT1(seed: UTxO, sc: PrepaidScripts, withdraws: number, didCommit = DID_COMMIT, ref?: UTxO) {
  const deferred: EngageOwnerProof = { mode: "deferred" };
  const v = addMintPrepaidVault(toPg(lucid.newTx()), {
    scripts: sc, seedUtxo: seed, owner: didOwner(), collectSeed: true, ownerProof: { mode: "deferred" },
  });
  const th = addMintEngage(toCm(v.tx), {
    consumeScript, seedUtxo: seed, collectSeed: false, owner: didOwner(), ownerProof: deferred,
    didCommit, network: NET, consumeRefUtxo: ref,
  });
  let tx = th.tx;
  for (let i = 0; i < withdraws; i++) tx = attachDidWithdraw(tx);
  return { tx, vault: v, thread: th };
}

function applyConsumeParams(bp: { validators: Array<{ title: string; compiledCode: string; parameters?: Array<{ title: string }> }> }, p: {
  priceNftPolicy: string; priceNftName: string; vaultScriptHash: string; priceParamScriptHash: string;
}): Validator {
  const v = bp.validators.find((x) => x.title === "consume.consume.spend");
  if (!v) throw new Error("blueprint ConsumeMAGIC thiếu consume.consume.spend — chạy `aiken build ConsumeMAGIC/onchain`");
  const want = [
    "price_nft_policy", "price_nft_name", "vault_script_hash", "burn_batch_constr",
    "max_price_stale", "ms_per_epoch", "price_param_script_hash", "window_origin_ms",
  ];
  const got = (v.parameters ?? []).map((x) => x.title);
  if (got.join(",") !== want.join(",")) {
    throw new Error(`apply-param consume trong blueprint là [${got}], bài này biết [${want}]`);
  }
  return {
    type: "PlutusV3",
    script: applyParamsToScript(v.compiledCode, [
      p.priceNftPolicy, p.priceNftName, p.vaultScriptHash, PREPAID_BURN_CONSTR,
      MAX_PRICE_STALE, P, p.priceParamScriptHash, O,
    ]),
  };
}

// ── Dựng nền ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  for (const p of [CM_BP, PG_BP]) {
    if (!existsSync(p)) throw new Error(`không thấy blueprint ${p} — chạy \`aiken build\` của module đó`);
  }
  const cmBp = JSON.parse(readFileSync(CM_BP, "utf8"));
  const pgBp: PrepaidBlueprint = JSON.parse(readFileSync(PG_BP, "utf8"));

  sponsor = generateEmulatorAccount({ lovelace: 5_000_000_000n, [CARP_UNIT]: 100n * CARP });
  didKey = generateEmulatorAccountFromPrivateKey({ lovelace: 20_000_000n });
  userKey = generateEmulatorAccountFromPrivateKey({ lovelace: 20_000_000n });
  provider = generateEmulatorAccountFromPrivateKey({ lovelace: 20_000_000n });
  holder = generateEmulatorAccountFromPrivateKey({ lovelace: 20_000_000n });
  emulator = new Emulator([sponsor, didKey, userKey, provider, holder], {
    ...PROTOCOL_PARAMETERS_DEFAULT,
    maxTxSize: MAINNET_MAX_TX,
    maxTxExMem: MAINNET_MAX_MEM,
    maxTxExSteps: MAINNET_MAX_STEPS,
  });
  emulator.time = Number(O + E0 * P + 60_000n);
  lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(sponsor.seedPhrase);

  const base = derivePrepaidScripts(pgBp, "Custom", {
    carpPolicyId: CARP_POLICY, carpAssetName: CARP_NAME, msPerEpoch: P, windowOriginMs: O,
    // Emulator không có két Wakeme; luồng T1–T4 không đọc tham số này (chỉ `FundReclaim`).
    wakemeVaultHash: "ab".repeat(28),
  });

  // Chỗ đỗ beacon giá + ref-script: native `sig(holder)` — không ví nào trong bài ký thay nó.
  const lockNative = scriptFromNative({ type: "sig", keyHash: pkh(holder) });
  const lockHash = validatorToScriptHash(lockNative);
  const lockAddr = validatorToAddress("Custom", lockNative);

  // Policy NFT giá: native `sig(sponsor)` (bản thật là `price_nft` one-shot; consume chỉ so cặp
  // (policy, name) đã apply).
  const priceNative = scriptFromNative({ type: "sig", keyHash: pkh(sponsor) });
  const pricePolicy = validatorToScriptHash(priceNative);
  beaconUnit = pricePolicy + PRICE_NFT_NAME;

  consumeScript = applyConsumeParams(cmBp, {
    priceNftPolicy: pricePolicy, priceNftName: PRICE_NFT_NAME,
    vaultScriptHash: base.vault.hash, priceParamScriptHash: lockHash,
  });

  // did_stake đứng thay: native `sig(didKey)` làm stake credential, đăng ký trước.
  didNative = scriptFromNative({ type: "sig", keyHash: pkh(didKey) });
  didHash = validatorToScriptHash(didNative);
  didReward = credentialToRewardAddress("Custom", { type: "Script", hash: didHash });
  await submit(lucid.newTx().register.Stake(didReward));

  // Beacon giá epoch E0 (bảng của consume_owner_auth.test.ts: required(op 1, ×1) = 10_000_000).
  await submit(
    lucid.newTx()
      .mintAssets({ [beaconUnit]: 1n })
      .attach.MintingPolicy(priceNative)
      .pay.ToContract(lockAddr, {
        kind: "inline",
        value: encodePriceParam({
          op_prices: [{ op_type: 1n, base_price: 10_000_000n, demand_mult: 1_000_000_000n }],
          m_min: 500_000_000n, m_max: 2_000_000_000n, epoch: E0,
        }),
      }, { lovelace: 3_000_000n, [beaconUnit]: 1n }),
  );

  // Ref-script CIP-33: mỗi script một tx (cộng lại ~14 KB, để riêng cho chắc trần).
  const c = await submit(lucid.newTx().pay.ToAddressWithData(lockAddr, undefined, { lovelace: 30_000_000n }, consumeScript));
  consumeRef = (await emulator.getUtxosByOutRef([{ txHash: c.hash, outputIndex: 0 }]))[0]!;
  const v = await submit(lucid.newTx().pay.ToAddressWithData(lockAddr, undefined, { lovelace: 40_000_000n }, base.vault.script));
  vaultRef = (await emulator.getUtxosByOutRef([{ txHash: v.hash, outputIndex: 0 }]))[0]!;
  if (validatorToScriptHash(consumeRef.scriptRef!) !== validatorToScriptHash(consumeScript)) throw new Error("ref consume lệch");
  scripts = withRefScripts(base, { vault: toPgU(vaultRef) });

  // Quỹ tài trợ: platform = ví bên tài trợ (Feecover), bên hưởng = provider.
  const seed = await freshSeed();
  const f = addMintPaidFund(toPg(lucid.newTx()), {
    scripts, seedUtxo: seed, platformPkh: pkh(sponsor),
    beneficiary: { payment_credential: { VerificationKey: [pkh(provider)] }, stake_credential: null },
    beneficiaryDatum: null, bufferBps: 1_500n, collectSeed: true,
  });
  await submit(toCm(f.tx));
  fundUnit = f.nftUnit;
  fundId = f.fundId;
}, SLOW);

// ── Hành trình ────────────────────────────────────────────────────────────────

describe("hành trình tài trợ người mới — két Prepaid + thread consume, script thật", () => {
  it("T1 ĐỎ (b): chủ script, ghép hai mảnh mà KHÔNG có mục rút ⟹ validator từ chối", async () => {
    const r = composeT1(await freshSeed(), scripts, 0);
    expect(r.vault.plan.owner).toEqual(didOwner());
    expect(r.thread.owner).toEqual(didOwner());
    expect(await rejection(r.tx)).toMatch(SCRIPT_FAIL);
  }, SLOW);

  it("T1 (c): HAI lần gắn mục rút cho cùng credential — ghi lại Lucid làm gì", async () => {
    const r = composeT1(await freshSeed(), scripts, 2);
    const c = await r.tx.completeSafe();
    if (c._tag === "Left") {
      note(`T1 hai mục rút cùng credential: Lucid TỪ CHỐI lúc complete — ${describeError(c.left).slice(0, 300)}`);
    } else {
      const n = withdrawalCount(c.right.toCBOR());
      note(`T1 hai mục rút cùng credential: Lucid DỰNG ĐƯỢC, body có ${n} mục rút (map theo credential)`);
      // Ledger giữ withdrawals là MAP ⟹ không thể có 2 khoá trùng trong tx đã mã hoá.
      expect(n).toBe(1);
    }
  }, SLOW);

  it("T1 XANH: một tx đúc két + thread, đúng MỘT mục rút, did_commit ghi lúc đúc", async () => {
    // Đo bản đính script (không ref) trước — chỉ dựng, không nộp.
    {
      const inline = composeT1(await freshSeed(), { ...scripts, vault: { ...scripts.vault, refUtxo: undefined } }, 1);
      const c = await inline.tx.completeSafe();
      if (c._tag === "Left") note(`T1 đính script (không ref): KHÔNG dựng được — ${describeError(c.left).slice(0, 200)}`);
      else measure("T1 đính script (không ref)", c.right.toCBOR());
    }
    const seed = await freshSeed();
    const r = composeT1(seed, scripts, 1, DID_COMMIT, consumeRef);
    const sub = await submit(r.tx, [didKey]);
    const m = measure("T1 ghép (ref-script két + consume)", sub.cbor);
    expect(m.bytes).toBeLessThanOrEqual(MAINNET_MAX_TX);
    expect(m.mem).toBeLessThanOrEqual(MAINNET_MAX_MEM);
    expect(m.steps).toBeLessThanOrEqual(MAINNET_MAX_STEPS);
    expect(withdrawalCount(sub.cbor)).toBe(1);
    expect(m.each.length).toBe(2); // hai redeemer Mint, mục rút native không có redeemer

    vaultUnit = r.vault.nftUnit;
    threadUnit = r.thread.engageNftUnit;
    const vu = await only(vaultUnit);
    const tu = await only(threadUnit);
    expect(decodeVaultDatum(vu.datum!)).toEqual(r.vault.datum);
    const raw = rawEngage(tu);
    expect(raw.fields[2]).toBe(0n);
    expect(raw.fields[3]).toBe(DID_COMMIT);
    expect(raw.fields[4]).toBe(0n);
    expect(tu.address).toBe(r.thread.engageAddress);

    const vIdx = vu.outputIndex;
    const tIdx = tu.outputIndex;
    note(
      `min-ADA T1: két Prepaid lovelace=${vu.assets["lovelace"]} (min ${minAdaOf(sub.cbor, vIdx)}) · ` +
        `thread lovelace=${tu.assets["lovelace"]} (min ${minAdaOf(sub.cbor, tIdx)})`,
    );
  }, SLOW);

  it("T1 chủ KHOÁ (ca đơn giản): hai mảnh deferred + MỘT addSignerKey", async () => {
    const seed = await freshSeed();
    const owner = { type: "key" as const, hash: pkh(userKey) };
    // TxBuilder của Lucid giữ trạng thái sau `complete()` — dựng lại từ đầu cho mỗi lượt.
    const build = () => {
      const v = addMintPrepaidVault(toPg(lucid.newTx()), {
        scripts, seedUtxo: seed, owner, collectSeed: true, ownerProof: { mode: "deferred" },
      });
      return addMintEngage(toCm(v.tx), {
        consumeScript, seedUtxo: seed, collectSeed: false, owner, ownerProof: { mode: "deferred" },
        didCommit: DID_COMMIT, network: NET, consumeRefUtxo: consumeRef,
      });
    };
    // Cực đối: thiếu chữ ký chủ ⟹ từ chối; thêm đúng một lần ⟹ nộp được.
    expect(await rejection(build().tx)).toMatch(SCRIPT_FAIL);
    const th = build();
    await submit(th.tx.addSignerKey(owner.hash), [userKey]);
    expect(rawEngage(await only(th.engageNftUnit)).fields[3]).toBe(DID_COMMIT);
  }, SLOW);

  it("T2 XANH: PrepaidLock 1 CARP + FundLock, CARP từ ví bên tài trợ, chủ két chứng minh quyền", async () => {
    const sponsorCarpBefore = (await emulator.getUtxos(sponsor.address)).reduce((a, u) => a + (u.assets[CARP_UNIT] ?? 0n), 0n);
    const r = addPrepaidLock(toPg(lucid.newTx()), {
      scripts, vaultUtxo: await only(vaultUnit), fundUtxo: await only(fundUnit), amount: CARP,
      validity: pgValidity(), by: "owner", ownerProof: { mode: "attach", auth: toPgAuth(didAuth()) },
    });
    expect(r.opensNewLine).toBe(true);
    const sub = await submit(toCm(r.tx), [didKey]);
    measure("T2 Lock+FundLock", sub.cbor);
    expect(decodeVaultDatum((await only(vaultUnit)).datum!)).toEqual(r.vaultDatumOut);
    expect((await only(fundUnit)).assets[CARP_UNIT]).toBe(CARP);
    const sponsorCarpAfter = (await emulator.getUtxos(sponsor.address)).reduce((a, u) => a + (u.assets[CARP_UNIT] ?? 0n), 0n);
    expect(sponsorCarpBefore - sponsorCarpAfter).toBe(CARP);
  }, SLOW);

  it("T3 XANH: PrepaidDraw 1 CARP ⟹ một lô MAGIC kỳ e", async () => {
    const r = addPrepaidDraw(toPg(lucid.newTx()), {
      scripts, vaultUtxo: await only(vaultUnit), fundId, amount: CARP, validity: pgValidity(),
      ownerProof: { mode: "attach", auth: toPgAuth(didAuth()) },
    });
    const sub = await submit(toCm(r.tx), [didKey]);
    measure("T3 Draw", sub.cbor);
    journeyEpoch = posixMsToEpoch(nowMs(), NET);
    expect(r.batch.created_epoch).toBe(journeyEpoch);
    expect(r.batch.current_amount).toBe(parMagicFromCarp(CARP));
    expect(decodeVaultDatum((await only(vaultUnit)).datum!)).toEqual(r.vaultDatumOut);
  }, SLOW);

  /** Tham số `buildConsumeTx` cho két Prepaid ở tip hiện tại; `burnEpoch` = kỳ dùng để dựng phía két. */
  async function consumeParamsAt(burnEpoch?: bigint, tamper?: (d: PrepaidVaultDatum) => PrepaidVaultDatum) {
    const tip = nowMs();
    const win = epochValidityWindow(tip, NET);
    const e = epochOfValidity({ fromMs: BigInt(win.lowerMs), toMs: BigInt(win.upperMs) }, P, O);
    const beacon = await only(beaconUnit);
    const required = requiredFromBeacon(decodePriceParam(beacon.datum!), 1, 1n);
    const vu = await only(vaultUnit);
    const vd = decodeVaultDatum(vu.datum!);
    const be = burnEpoch ?? e;
    const burns = planPrepaidBurns(vd, required, be);
    const pb = prepaidBurnFor(scripts, toPgU(vu), burns, be);
    const outDatum = tamper ? encodeVaultDatum(tamper(pb.vaultDatumOut)) : pb.vaultOutDatumCbor;
    const params: ConsumeParams = {
      lucid, engageUtxo: await only(threadUnit), vaultUtxo: vu, priceBeaconUtxo: beacon,
      consumeScript, vaultScript: scripts.vault.script as Validator, opType: 1, opCount: 1n,
      vaultBurnRedeemerCbor: pb.vaultBurnRedeemerCbor, vaultOutDatumCbor: outDatum,
      vaultOutAssets: pb.vaultOutAssets, vaultKind: "prepaid",
      ownerAuth: didAuth(), consumeRefUtxo: consumeRef, vaultRefUtxo: vaultRef,
      network: NET, tipPosixMs: tip, maxPriceStale: MAX_PRICE_STALE,
    };
    return { params, required, e, pb, vd, burns };
  }

  it("T4 XANH: Consume + BurnBatch trên két Prepaid; thread [2,3,4] = [e, did_commit, ≥1]", async () => {
    const { params, required, e, pb } = await consumeParamsAt();
    expect(e).toBe(journeyEpoch); // T3 và T4 cùng kỳ
    note(`MAGIC một lượt consume đầu ở fixture (op 1 ×1): required = ${required} nanogic`);

    // Đo bản đính script (không ref) — chỉ dựng.
    try {
      const inl = await buildConsumeTx({ ...params, consumeRefUtxo: undefined, vaultRefUtxo: undefined });
      measure("T4 đính hai script (không ref)", inl.tx.toCBOR());
    } catch (err) {
      note(`T4 đính hai script (không ref): KHÔNG dựng được — ${describeError(err).slice(0, 200)}`);
    }

    const r = await buildConsumeTx(params);
    expect(r.requiredNanogic).toBe(required);
    expect(r.vaultCheckpoint).toEqual({ kind: "prepaid", refreshed: false });
    const cbor = r.tx.toCBOR();
    const m = measure("T4 consume+BurnBatch (ref-script hai bên)", cbor);
    expect(m.bytes).toBeLessThanOrEqual(MAINNET_MAX_TX);
    expect(m.mem).toBeLessThanOrEqual(MAINNET_MAX_MEM);
    expect(m.steps).toBeLessThanOrEqual(MAINNET_MAX_STEPS);
    expect(withdrawalCount(cbor)).toBe(1);
    await submitSigned(r.tx, [didKey]);

    const tu = await only(threadUnit);
    const raw = rawEngage(tu);
    // Layout Wakeme đọc [2,3,4] = [last_epoch, did_commit, consumed_nanogic].
    expect(raw.fields[2]).toBe(e);
    expect(raw.fields[3]).toBe(DID_COMMIT);
    expect(raw.fields[4] as bigint).toBeGreaterThanOrEqual(1n);
    expect(raw.fields[4]).toBe(required);
    expect(raw.fields[1]).toBe(1n);

    const vu = await only(vaultUnit);
    const after = decodeVaultDatum(vu.datum!);
    expect(after).toEqual(pb.vaultDatumOut);
    expect(after.magic_batches[0]!.current_amount).toBe(parMagicFromCarp(CARP) - required);
    expect(after.prepaid_credits[0]!.consumed_unsettled).toBe(required);
    expect(after.last_updated_epoch).toBe(e);
    note(
      `min-ADA sau T4: két lovelace=${vu.assets["lovelace"]} (min ${minAdaOf(cbor, vu.outputIndex)}) · ` +
        `thread lovelace=${tu.assets["lovelace"]} (min ${minAdaOf(cbor, tu.outputIndex)})`,
    );
  }, SLOW);

  it("T4 ĐỎ (a): sang kỳ e+1 — bộ dựng trung thực NÉM C-PP-5; kế hoạch kỳ e ép lên chuỗi ⟹ validator từ chối", async () => {
    goToEpoch(journeyEpoch + 1n);
    // (a1) đường trung thực: không còn lô sống ở e+1.
    await expect(consumeParamsAt()).rejects.toThrow(/C-PP-5/);
    // (a2) dựng phía két bằng kỳ e (lô kỳ e vẫn còn số dư), CHỈ đổi hai trường mốc kỳ của datum ra
    //      về e+1 để datum khớp kỳ của tx — điều duy nhất còn sai là lô đã chết.
    const { params } = await consumeParamsAt(journeyEpoch, (d) => ({
      ...d,
      last_updated_epoch: journeyEpoch + 1n,
      attribution: { ...d.attribution, last_event_epoch: journeyEpoch + 1n },
    }));
    const err = await buildConsumeTx(params).then(() => "ACCEPTED", (x) => describeError(x));
    note(`T4 kỳ e+1 với lô kỳ e: ${err.slice(0, 240)}`);
    expect(err).toMatch(/failed script execution|script/i);
    expect(err).not.toBe("ACCEPTED");
  }, SLOW);

  it("sau hành trình: tổng kiểm tra ghi chép số đo", () => {
    expect(MEASURE.length).toBeGreaterThan(0);
  });
});

// Bài nội bộ của tệp: did_commit = blake2b_256(utf8(did)) dài 32 byte; mảnh thread chặn độ dài sai.
describe("phép phụ trợ của hành trình", () => {
  it("did_commit 32 byte, khác nhau khi DID khác", () => {
    expect(DID_COMMIT).toMatch(/^[0-9a-f]{64}$/);
    const other = Buffer.from(blake2b(new TextEncoder().encode(DID + "x"), { dkLen: 32 })).toString("hex");
    expect(other).not.toBe(DID_COMMIT);
  });
  it("addMintEngage NÉM MINT-ENGAGE-005 khi did_commit khác 0/32 byte (gương did_len_ok)", () => {
    const fakeSeed = { txHash: "00".repeat(32), outputIndex: 0, address: "", assets: {} } as UTxO;
    const fake = {} as TxBuilder;
    const cs: Validator = { type: "PlutusV3", script: "49480100002221200101" };
    expect(() => addMintEngage(fake, {
      consumeScript: cs, seedUtxo: fakeSeed, owner: { type: "key", hash: "0b".repeat(28) },
      ownerProof: { mode: "deferred" }, didCommit: "d1".repeat(31), network: NET,
    })).toThrow(/MINT-ENGAGE-005/);
  });
});
