// VaultTxAPI/tests/sponsorEmulator.test.ts — hành trình tài trợ consume đầu đi trọn T1 → T2 → T3 → T4
// qua CHÍNH route HTTP (`http.ts` ▸ `handle` → `sponsor.ts` ▸ `SponsorTxService`), trên Lucid
// Emulator, đánh giá UPLC THẬT (blueprint `ConsumeMAGIC/onchain/plutus.json` +
// `PrepaidGen/onchain/plutus.json`, do `aiken build` sinh).
//
// Khuôn dựng nền chép từ `MagicSDK/tests/sponsorJourney.test.ts`; khác ở hai chỗ:
//
//   1. Dịch vụ dựng tx, bài chỉ KÝ và NỘP — vai của app + ví người dùng + bên tài trợ. Dịch vụ không
//      cầm khoá nào: `lucidForWallet` chỉ chọn ví CHỈ-ĐỌC (`fromAddress`), đúng như `txBuilder.ts`.
//   2. `noSigningMaterial.test.ts` quét CẢ thư mục tests/, nên bài không dùng đường ký của lucid. Ba
//      khoá thử (ví trả phí, chủ, bên tài trợ) là cặp ed25519 sinh TRONG BỘ NHỚ bằng `node:crypto`,
//      chết theo tiến trình; chữ ký ghép vào tx bằng `assemble` như một ví ngoài trả nhân chứng về.
//      Phép quét kia đo theo TÊN, nên nó không nhìn thấy dạng này — xem "chốt không ghim" ở cuối tệp.
//
// Chủ là KHOÁ (không `did_stake`): nhánh chủ script cần nhân chứng PhoenixKey thật, bài SDK phủ nó.

import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CML,
  Constr,
  Data,
  Emulator,
  Lucid,
  PROTOCOL_PARAMETERS_DEFAULT,
  applyParamsToScript,
  credentialToAddress,
  scriptFromNative,
  validatorToAddress,
  validatorToScriptHash,
  type EmulatorAccount,
  type LucidEvolution,
  type TxBuilder,
  type UTxO,
  type Validator,
} from "@lucid-evolution/lucid";
import { encodePriceParam } from "@magiclamp/consumemagic";
import {
  addMintPaidFund,
  decodeVaultDatum,
  derivePrepaidScripts,
  parMagicFromCarp,
  withRefScripts,
  type PrepaidBlueprint,
} from "@magiclamp/prepaidgen-sdk";
import { msPerEpoch, windowOriginMs } from "@magiclamp/protocol-utils";
import { beforeAll, describe, expect, it } from "vitest";

import type { ChainReader } from "../src/chain.js";
import { parseDeployment, PREPAID_VAULT_TYPE } from "../src/config.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import type { VaultTxService } from "../src/service.js";
import { SponsorTxService } from "../src/sponsor.js";
import { LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID } from "./fixtures/preview.js";

// ── Lưới + hằng ───────────────────────────────────────────────────────────────

const NET = "Preprod" as const;
const P = msPerEpoch(NET);
const O = windowOriginMs(NET);
const E0 = 330n;
const CARP = 1_000_000_000n;
const CARP_POLICY = "22".repeat(28);
const CARP_NAME = "5a".repeat(28);
const CARP_UNIT = CARP_POLICY + CARP_NAME;
const PREPAID_BURN_CONSTR = 2n;
const MAX_PRICE_STALE = 2n;
const PRICE_NFT_NAME = "5052494345";
const DID_COMMIT = "d1".repeat(32);
const SLOW = 900_000;

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const CM_BP = here("../../ConsumeMAGIC/onchain/plutus.json");
const PG_BP = here("../../PrepaidGen/onchain/plutus.json");

// ── Khoá thử trong bộ nhớ ─────────────────────────────────────────────────────

interface TestKey { pkh: string; address: string; pub: Uint8Array; sec: KeyObject }

function newKey(): TestKey {
  const pair = Object.values(generateKeyPairSync("ed25519")) as KeyObject[];
  const pubObj = pair.find(k => k.type === "public")!;
  const sec = pair.find(k => k.type !== "public")!;
  const der = pubObj.export({ format: "der", type: "spki" });
  const pub = new Uint8Array(der.subarray(der.length - 32));
  const pkh = CML.PublicKey.from_bytes(pub).hash().to_hex();
  return { pkh, address: credentialToAddress(NET, { type: "Key", hash: pkh }), pub, sec };
}

/** Bộ nhân chứng vkey của `keys` trên đúng thân tx `txCbor` (CBOR hex của witness set). */
function witnessSet(txCbor: string, keys: TestKey[]): string {
  const body = CML.Transaction.from_cbor_hex(txCbor).body();
  const msg = CML.hash_transaction(body).to_raw_bytes();
  const list = CML.VkeywitnessList.new();
  for (const k of keys) {
    list.add(CML.Vkeywitness.new(
      CML.PublicKey.from_bytes(k.pub),
      CML.Ed25519Signature.from_raw_bytes(new Uint8Array(edSign(null, msg, k.sec))),
    ));
  }
  const ws = CML.TransactionWitnessSet.new();
  ws.set_vkeywitnesses(list);
  return ws.to_cbor_hex();
}

// ── Trạng thái dùng chung ─────────────────────────────────────────────────────

let emulator: Emulator;
let lucid: LucidEvolution;
let fee: TestKey;     // ví khoá của người mới: phí + thế chấp + tiền thừa
let owner: TestKey;   // chủ két (chủ khoá)
let sponsor: TestKey; // bên tài trợ: giữ CARP, platform của quỹ
let deploymentNoDid = "";
let svc: SponsorTxService;
let svcNoDid: SponsorTxService;
let svcStakeEngage: SponsorTxService;
let locks: OwnerLockTable;
let fundAddress = "";
let fundUnit = "";
let fundId = "";
let vaultUnit = "";
let threadUnit = "";
let anchorRef = "";
let drawEpoch = 0;
let epochEndMs = 0n;

const refStr = (u: { txHash: string; outputIndex: number }) => `${u.txHash}#${u.outputIndex}`;
const nowMs = () => BigInt(emulator.now());

function describeError(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    return `${e.name}: ${e.message}${cause === undefined ? "" : ` | cause: ${typeof cause === "string" ? cause : JSON.stringify(cause)}`}`;
  }
  return typeof e === "string" ? e : JSON.stringify(e);
}

/** Ký bằng `keys` rồi nộp; trả hash. Hỏng ⟹ NÉM kèm lý do của Emulator. */
async function signAndSubmit(txCbor: string, keys: TestKey[]): Promise<string> {
  const signed = await lucid.fromTx(txCbor).assemble([witnessSet(txCbor, keys)]).complete();
  const h = await signed.submit();
  emulator.awaitBlock(1);
  return h;
}

/** Dựng nền do bên tài trợ trả: ví chỉ-đọc mang UTxO hiện tại của bên tài trợ. */
async function asSponsor(build: (l: LucidEvolution) => TxBuilder): Promise<string> {
  lucid.selectWallet.fromAddress(sponsor.address, await emulator.getUtxos(sponsor.address));
  const c = await build(lucid).completeSafe();
  if (c._tag === "Left") throw new Error(describeError(c.left));
  return signAndSubmit(c.right.toCBOR(), [sponsor]);
}

async function only(unit: string): Promise<UTxO> {
  const u = (await emulator.getUtxoByUnit(unit)) as UTxO | undefined;
  if (!u) throw new Error(`không có UTxO nào mang ${unit}`);
  return u;
}

function unspent(): UTxO[] {
  return Object.values(emulator.ledger).filter(e => !e.spent).map(e => e.utxo);
}

/** ChainReader ảo trên Emulator — cùng hợp đồng với `chain.ts` (scriptRef đi kèm UTxO). */
function emulatorChain(): ChainReader {
  return {
    label: "emulator",
    utxosAt: a => emulator.getUtxos(a),
    utxosByOutRef: r => emulator.getUtxosByOutRef(r),
    utxosByUnit: async u => unspent().filter(x => (x.assets[u] ?? 0n) > 0n),
    tip: async () => ({ blockHeight: emulator.blockHeight, blockHash: "00".repeat(32), blockTimePosixMs: nowMs() }),
    submitTx: c => emulator.submitTx(c),
    rewardAccount: async () => { throw new Error("bài chủ khoá không đọc tài khoản thưởng"); },
  };
}

function routerDeps(s: SponsorTxService): RouterDeps {
  return {
    service: {} as unknown as VaultTxService, // đường /tx/sponsor/* không chạm dịch vụ cũ
    deploymentSource: "emulator",
    vaultScopes: [],
    network: NET,
    chainLabel: "emulator",
    changeAddressStrategy: "owner-enterprise",
    token: "",
    logInternal: (ref, cause) => { throw new Error(`lỗi nội bộ ${ref}: ${describeError(cause)}`); },
    sponsor: s,
  };
}

type Body = Record<string, unknown>;
async function post(path: string, body: Body, s: SponsorTxService = svc): Promise<{ status: number; body: Body }> {
  return handle({ method: "POST", url: path, headers: {}, body }, routerDeps(s));
}
const errCode = (r: { body: Body }) => (r.body.error as { code: string } | undefined)?.code;
const ownerBody = () => ({ owner: { type: "key", hash: owner.pkh }, change_address: fee.address });

/** Đáp ứng 200 của một bước, hoặc NÉM kèm lỗi máy chủ trả. */
async function step(path: string, body: Body): Promise<Body> {
  const r = await post(path, body);
  if (r.status !== 200) throw new Error(`${path} ⟹ ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** Vai ký: đúng thứ tự `planSponsorJourney`; mỗi `required_signers` phải thuộc một vai. */
function expectSigners(b: Body, roles: string[], want: Record<string, string[]>): void {
  const signers = b.signers as Array<{ role: string; key_hashes: string[] }>;
  expect(signers.map(s => s.role)).toEqual(roles);
  for (const s of signers) expect(s.key_hashes).toEqual(want[s.role]);
  const all = new Set(signers.flatMap(s => s.key_hashes));
  for (const r of b.required_signers as string[]) expect(all.has(r)).toBe(true);
  expect(b.required_signers).toContain(owner.pkh);
  expect(typeof b.tx_hash).toBe("string");
  expect(CML.hash_transaction(CML.Transaction.from_cbor_hex(b.tx_cbor as string).body()).to_hex()).toBe(b.tx_hash);
}

function applyConsumeParams(bp: { validators: Array<{ title: string; compiledCode: string; parameters?: Array<{ title: string }> }> }, p: {
  priceNftPolicy: string; priceNftName: string; vaultScriptHash: string; priceParamScriptHash: string;
}): Validator {
  const v = bp.validators.find(x => x.title === "consume.consume.spend");
  if (!v) throw new Error("blueprint ConsumeMAGIC thiếu consume.consume.spend — chạy `aiken build ConsumeMAGIC/onchain`");
  const want = [
    "price_nft_policy", "price_nft_name", "vault_script_hash", "burn_batch_constr",
    "max_price_stale", "ms_per_epoch", "price_param_script_hash", "window_origin_ms",
  ];
  const got = (v.parameters ?? []).map(x => x.title);
  if (got.join(",") !== want.join(",")) throw new Error(`apply-param consume trong blueprint là [${got}], bài này biết [${want}]`);
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

  fee = newKey();
  owner = newKey();
  sponsor = newKey();
  const acct = (address: string, assets: Record<string, bigint>) => ({ address, assets }) as unknown as EmulatorAccount;
  emulator = new Emulator([
    acct(sponsor.address, { lovelace: 5_000_000_000n, [CARP_UNIT]: 100n * CARP }),
    acct(fee.address, { lovelace: 1_000_000_000n }),
    acct(fee.address, { lovelace: 1_000_000_000n }),
    acct(owner.address, { lovelace: 20_000_000n }),
  ], { ...PROTOCOL_PARAMETERS_DEFAULT, maxTxSize: 16_384, maxTxExMem: 16_500_000n, maxTxExSteps: 10_000_000_000n });
  // Lucid đặt lưới slot "Custom" theo `emulator.now()` LÚC KHỞI TẠO ⟹ đặt giờ trước. Đỉnh cách biên kỳ 60 s.
  emulator.time = Number(O + E0 * P + 60_000n);
  lucid = await Lucid(emulator, "Custom");

  const base = derivePrepaidScripts(pgBp, NET, { carpPolicyId: CARP_POLICY, carpAssetName: CARP_NAME, msPerEpoch: P, windowOriginMs: O });

  // Một địa chỉ khoá giữ beacon / anchor / ref-script (native sig của bên tài trợ).
  const lockNative = scriptFromNative({ type: "sig", keyHash: sponsor.pkh });
  const lockHash = validatorToScriptHash(lockNative);
  const lockAddr = validatorToAddress(NET, lockNative);
  const priceNative = scriptFromNative({ type: "sig", keyHash: sponsor.pkh });
  const pricePolicy = validatorToScriptHash(priceNative);
  const beaconUnit = pricePolicy + PRICE_NFT_NAME;
  const consumeScript = applyConsumeParams(cmBp, {
    priceNftPolicy: pricePolicy, priceNftName: PRICE_NFT_NAME, vaultScriptHash: base.vault.hash, priceParamScriptHash: lockHash,
  });

  await asSponsor(l => l.newTx()
    .mintAssets({ [beaconUnit]: 1n })
    .attach.MintingPolicy(priceNative)
    .pay.ToContract(lockAddr, {
      kind: "inline",
      value: encodePriceParam({
        op_prices: [{ op_type: 1n, base_price: 10_000_000n, demand_mult: 1_000_000_000n }],
        m_min: 500_000_000n, m_max: 2_000_000_000n, epoch: E0,
      }),
    }, { lovelace: 3_000_000n, [beaconUnit]: 1n }));

  // Anchor DID của người mới: NFT tên = owner_commit = did_commit của két; policy native đứng thay.
  const anchorNative = scriptFromNative({ type: "all", scripts: [{ type: "sig", keyHash: sponsor.pkh }] });
  const anchorPolicy = validatorToScriptHash(anchorNative);
  const ah = await asSponsor(l => l.newTx()
    .mintAssets({ [anchorPolicy + DID_COMMIT]: 1n })
    .attach.MintingPolicy(anchorNative)
    .pay.ToAddress(lockAddr, { lovelace: 3_000_000n, [anchorPolicy + DID_COMMIT]: 1n }));
  anchorRef = `${ah}#0`;

  const ch = await asSponsor(l => l.newTx().pay.ToAddressWithData(lockAddr, undefined, { lovelace: 30_000_000n }, consumeScript));
  const vh = await asSponsor(l => l.newTx().pay.ToAddressWithData(lockAddr, undefined, { lovelace: 40_000_000n }, base.vault.script));
  const fh = await asSponsor(l => l.newTx().pay.ToAddressWithData(lockAddr, undefined, { lovelace: 40_000_000n }, base.paidFund.script));
  const [vaultRef, fundRef] = await emulator.getUtxosByOutRef([{ txHash: vh, outputIndex: 0 }, { txHash: fh, outputIndex: 0 }]);
  const scripts = withRefScripts(base, { vault: vaultRef!, paidFund: fundRef! });

  // Quỹ tài trợ đã ghim: platform = bên tài trợ, bên hưởng = chủ (không quan trọng cho hành trình).
  const seedH = await asSponsor(l => l.newTx().pay.ToAddress(sponsor.address, { lovelace: 10_000_000n }));
  const seedUtxo = (await emulator.getUtxosByOutRef([{ txHash: seedH, outputIndex: 0 }]))[0]!;
  let minted: { nftUnit: string; fundId: string } | undefined;
  await asSponsor(l => {
    const f = addMintPaidFund(l.newTx(), {
      scripts, seedUtxo, platformPkh: sponsor.pkh,
      beneficiary: { payment_credential: { VerificationKey: [owner.pkh] }, stake_credential: null },
      beneficiaryDatum: null, bufferBps: 1_500n, collectSeed: true,
    });
    minted = f;
    return f.tx;
  });
  fundUnit = minted!.nftUnit;
  fundId = minted!.fundId;
  fundAddress = base.paidFund.address;

  const deployment = (withDid: boolean, engageAddress = validatorToAddress(NET, consumeScript)) => JSON.stringify({
    source: "Emulator của phép kiểm — không phải một lần deploy thật",
    lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
    consume: {
      engage_address: engageAddress,
      price_beacon_address: lockAddr,
      price_beacon_nft_unit: beaconUnit,
      max_price_stale: Number(MAX_PRICE_STALE),
    },
    ...(withDid ? { did_stake: { anchor_nft_policy: anchorPolicy } } : {}),
    vaults: [{ vault_type: PREPAID_VAULT_TYPE, address: validatorToAddress(NET, base.vault.script) }],
    paid_fund: { address: base.paidFund.address, carp_unit: CARP_UNIT },
    ref_script_utxos: { vault: `${vh}#0`, paid_fund: `${fh}#0`, consume: `${ch}#0` },
  });
  deploymentNoDid = deployment(false);

  const mk = (json: string, l: OwnerLockTable) => new SponsorTxService({
    network: NET,
    deployment: parseDeployment(json, NET),
    chain: emulatorChain(),
    locks: l,
    issued: new IssuedTxRegistry(240_000),
    lockTtlMs: 60_000,
    now: () => emulator.now(),
    prepaidBlueprint: pgBp,
    lucidForWallet: async (address, utxos) => { lucid.selectWallet.fromAddress(address, utxos); return lucid; },
  });
  locks = new OwnerLockTable(60_000);
  svc = mk(deployment(true), locks);
  svcNoDid = mk(deploymentNoDid, new OwnerLockTable(60_000));
  // Cùng script consume, địa chỉ engage KHÁC (thêm phần stake): cổng script chỉ so HASH nên cho qua;
  // tx do SDK dựng gửi thread tới địa chỉ không-stake ⟹ chỉ phép đọc-lại output (`nftOutput`) chặn được.
  svcStakeEngage = mk(deployment(true, credentialToAddress(NET,
    { type: "Script", hash: validatorToScriptHash(consumeScript) }, { type: "Key", hash: sponsor.pkh })), new OwnerLockTable(60_000));
}, SLOW);

/** Nộp xong ⟹ nhả khoá chủ theo hash (máy chủ thật nhả ở `/tx/submit` hoặc khi hết TTL). */
async function submitStep(b: Body, keys: TestKey[]): Promise<string> {
  const h = await signAndSubmit(b.tx_cbor as string, keys);
  expect(h).toBe(b.tx_hash);
  locks.releaseByTxHash(h);
  return h;
}

// ── Hành trình qua route ──────────────────────────────────────────────────────

describe("hành trình tài trợ qua route HTTP — script thật trên Emulator", () => {
  it("T1 XANH: /tx/sponsor/t1-open ⟹ một tx đúc két + thread; vai ký = ví phí · chủ; nộp được", async () => {
    const b = await step("/tx/sponsor/t1-open", { ...ownerBody(), did_commit: DID_COMMIT });
    expect(b.step).toBe("T1");
    expectSigners(b, ["fee-wallet", "owner"], { "fee-wallet": [fee.pkh], owner: [owner.pkh] });
    const s = b.summary as Body;
    expect(s.did_commit).toBe(DID_COMMIT);
    vaultUnit = s.vault_unit as string;
    threadUnit = s.thread_unit as string;
    await submitStep(b, [fee, owner]);
    expect(refStr(await only(vaultUnit))).toBe(s.vault_out_ref);
    expect(refStr(await only(threadUnit))).toBe(s.thread_out_ref);
    // did_commit nằm ở THREAD (trường 3), két genesis giữ rỗng — chỗ T2 phải đọc để định vị anchor.
    expect(decodeVaultDatum((await only(vaultUnit)).datum!).did_commit).toBe("");
    expect((Data.from((await only(threadUnit)).datum!) as Constr<Data>).fields[3]).toBe(DID_COMMIT);
  }, SLOW);

  it("T1 ĐỎ (cực đối): chủ đã có két ⟹ 409 VAULT_ALREADY_EXISTS, không dựng két thứ hai", async () => {
    const r = await post("/tx/sponsor/t1-open", { ...ownerBody(), did_commit: DID_COMMIT });
    expect(r.status).toBe(409);
    expect(errCode(r)).toBe("VAULT_ALREADY_EXISTS");
  }, SLOW);

  it("T1 ĐỎ: thread rơi ngoài engage_address đã cấu hình (khác phần stake) ⟹ 422 SPONSOR_TX_MISMATCH, không phát tx", async () => {
    const other = newKey(); // chủ khác, chưa có két — để không chết sớm ở VAULT_ALREADY_EXISTS
    const r = await post("/tx/sponsor/t1-open",
      { owner: { type: "key", hash: other.pkh }, change_address: fee.address, did_commit: DID_COMMIT }, svcStakeEngage);
    expect(r.status).toBe(422);
    expect(errCode(r)).toBe("SPONSOR_TX_MISMATCH");
    expect(JSON.stringify(r.body)).toContain("thread");
  }, SLOW);

  const t2Body = async (): Promise<Body> => ({
    ...ownerBody(), fund_id: fundId, carp_amount: CARP.toString(),
    sponsor: {
      utxo_refs: (await emulator.getUtxos(sponsor.address)).filter(u => (u.assets[CARP_UNIT] ?? 0n) > 0n).map(refStr),
      change_address: sponsor.address,
    },
  });

  it("T2 ĐỎ: bản deploy khớp script mà thiếu did_stake ⟹ 501 CONFIG_MISSING nêu did_stake.anchor_nft_policy", async () => {
    const r = await post("/tx/sponsor/t2-fund", await t2Body(), svcNoDid);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("CONFIG_MISSING");
    expect(JSON.stringify(r.body)).toContain("did_stake.anchor_nft_policy");
  }, SLOW);

  it("T2 XANH: CARP chỉ tới quỹ đã ghim + thối bên tài trợ; anchor ở reference_inputs; thiếu chữ ký bên tài trợ ⟹ chuỗi từ chối", async () => {
    const fundCarpBefore = (await only(fundUnit)).assets[CARP_UNIT] ?? 0n;
    const carpTotal = unspent().reduce((a, u) => a + (u.assets[CARP_UNIT] ?? 0n), 0n);
    const req2 = await t2Body();
    const b = await step("/tx/sponsor/t2-fund", req2);
    expect(b.step).toBe("T2");
    expectSigners(b, ["fee-wallet", "sponsor", "owner"], { "fee-wallet": [fee.pkh], sponsor: [sponsor.pkh], owner: [owner.pkh] });
    const s = b.summary as Body;
    expect(s.anchor_ref).toBe(anchorRef);
    expect(s.owner_commit).toBe(DID_COMMIT);
    expect(s.fund_unit).toBe(fundUnit);
    expect(s.sponsor_signers).toEqual([sponsor.pkh]);

    // Đo độc lập với phép kiểm của dịch vụ/SDK: đọc thẳng thân tx bằng CML.
    const refs = CML.Transaction.from_cbor_hex(b.tx_cbor as string).body().reference_inputs();
    const refKeys: string[] = [];
    for (let i = 0; i < (refs?.len() ?? 0); i++) refKeys.push(`${refs!.get(i).transaction_id().to_hex()}#${refs!.get(i).index()}`);
    expect(refKeys).toContain(anchorRef);

    // Chữ ký bên tài trợ là BẮT BUỘC: thiếu nó thì chuỗi từ chối, trạng thái không đổi.
    await expect(signAndSubmit(b.tx_cbor as string, [fee, owner])).rejects.toThrow(`Missing vkey witness. Key hash: ${sponsor.pkh}`);
    await submitStep(b, [fee, sponsor, owner]);

    expect((await only(fundUnit)).assets[CARP_UNIT]).toBe(fundCarpBefore + CARP);
    const carpAt = new Set(unspent().filter(u => (u.assets[CARP_UNIT] ?? 0n) > 0n).map(u => u.address));
    expect([...carpAt].sort()).toEqual([fundAddress, sponsor.address].sort());
    expect(unspent().reduce((a, u) => a + (u.assets[CARP_UNIT] ?? 0n), 0n)).toBe(carpTotal);
    expect((await only(fundUnit)).address).toBe(fundAddress);
    expect(decodeVaultDatum((await only(vaultUnit)).datum!).prepaid_credits.length).toBe(1);
    expect(refStr(await only(vaultUnit))).toBe(s.vault_out_ref);
  }, SLOW);

  it("T3 XANH: PrepaidDraw ⟹ một lô MAGIC kỳ e; epoch_end_ms là biên kỳ sau", async () => {
    const b = await step("/tx/sponsor/t3-draw", { ...ownerBody(), fund_id: fundId, carp_amount: CARP.toString() });
    expectSigners(b, ["fee-wallet", "owner"], { "fee-wallet": [fee.pkh], owner: [owner.pkh] });
    const s = b.summary as Body;
    expect(s.magic_nanogic).toBe(parMagicFromCarp(CARP).toString());
    drawEpoch = s.epoch as number;
    epochEndMs = BigInt(s.epoch_end_ms as string);
    expect(BigInt(drawEpoch)).toBe((nowMs() - O) / P);
    expect(epochEndMs).toBe(O + (BigInt(drawEpoch) + 1n) * P);
    expect((b.witness_notes as string[]).join(" ")).toContain(epochEndMs.toString());
    await submitStep(b, [fee, owner]);
    const vd = decodeVaultDatum((await only(vaultUnit)).datum!);
    expect(vd.magic_batches.at(-1)!.created_epoch).toBe(BigInt(drawEpoch));
  }, SLOW);

  const t4Body = (de: number): Body => ({ ...ownerBody(), op_type: 1, op_count: "1", draw_epoch: de });

  it("T4 ĐỎ: draw_epoch lệch kỳ hiện tại ⟹ 409 SPONSOR_EPOCH_MISMATCH; khoá chủ được nhả", async () => {
    const r = await post("/tx/sponsor/t4-first-consume", t4Body(drawEpoch - 1));
    expect(r.status).toBe(409);
    expect(errCode(r)).toBe("SPONSOR_EPOCH_MISMATCH");
    expect(locks.peek(owner.pkh, emulator.now())).toBeNull();
  }, SLOW);

  it("T4 XANH (cực đối, cùng kỳ T3, trước epoch_end_ms): consume đầu + BurnBatch; thread [2,3,4] = [e, did_commit, required]", async () => {
    expect(nowMs()).toBeLessThan(epochEndMs);
    const b = await step("/tx/sponsor/t4-first-consume", t4Body(drawEpoch));
    expectSigners(b, ["fee-wallet", "owner"], { "fee-wallet": [fee.pkh], owner: [owner.pkh] });
    const s = b.summary as Body;
    expect(s.epoch).toBe(drawEpoch);
    expect(s.thread_unit).toBe(threadUnit);
    expect(s.required_nanogic).toBe("10000000");
    await submitStep(b, [fee, owner]);
    const d = Data.from((await only(threadUnit)).datum!) as Constr<Data>;
    expect(d.fields[2]).toBe(BigInt(drawEpoch));
    expect(d.fields[3]).toBe(DID_COMMIT);
    expect(d.fields[4]).toBe(10_000_000n);
    const vd = decodeVaultDatum((await only(vaultUnit)).datum!);
    expect(vd.magic_batches[0]!.current_amount).toBe(parMagicFromCarp(CARP) - 10_000_000n);
  }, SLOW);
});

// Chốt bài này KHÔNG ghim được:
//   · nhánh chủ SCRIPT (`did_stake`) qua route — cần nhân chứng PhoenixKey; bài SDK phủ phần dựng tx;
//   · `noSigningMaterial.test.ts` đo theo TÊN: ký bằng ed25519 của `node:crypto` (như ở đây) không
//     khớp mẫu nào, nên một đường ký kiểu này trong src/ cũng sẽ đi lọt phép quét đó;
//   · T4 sang kỳ sau với lô đã hết hạn — bài SDK phủ (`goToEpoch`); ở đây chỉ phủ draw_epoch lệch.
