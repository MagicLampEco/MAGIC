// tests/sponsorJourney.test.ts — hành trình tài trợ consume đầu của người mới qua API SDK, trên
// Lucid Emulator, đánh giá UPLC THẬT (blueprint `ConsumeMAGIC/onchain/plutus.json` +
// `PrepaidGen/onchain/plutus.json`, do `aiken build` sinh).
//
// Khuôn dựng nền chép từ `ConsumeMAGIC/tests/prepaid_journey.test.ts` (bài tham chiếu của bộ dựng
// gốc); bài này chỉ đi qua mặt tiền SDK: `buildSponsorT1OpenPrepaid` → `buildSponsorT2Fund` →
// `buildSponsorT3Draw` → `buildSponsorT4FirstConsume`.
//
// Ví trả phí (ví khoá của người mới) KHÁC ví bên tài trợ: CARP của T2 chỉ đi từ UTxO bên tài trợ
// mà bài truyền vào, không từ chọn-coin của ví trả phí.
//
// Đứng thay `did_stake`: native `sig(didKey)` làm stake credential. Validator chỉ đọc `Script(h)`
// trong `withdrawals`; bài KHÔNG ghim luật của chính `did_stake` (blueprint của nó không ở kho này).

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
import { msPerEpoch, windowOriginMs, type OwnerAuth } from "@magiclamp/protocol-utils";
import {
  buildConsumeManyTx, buildConsumeTx, decodePriceParam, encodePriceParam, requiredFromBeacon, requiredFromBeaconPairs,
} from "@magiclamp/consumemagic";
import {
  addMintPaidFund,
  decodeVaultDatum,
  derivePrepaidScripts,
  parMagicFromCarp,
  planPrepaidBurns,
  prepaidBurnFor,
  withRefScripts,
  type PrepaidBlueprint,
  type PrepaidScripts,
} from "@magiclamp/prepaidgen-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  SponsorJourneyError,
  assertSponsorCarpOutputs,
  buildSponsorT1OpenPrepaid,
  buildSponsorT2Fund,
  buildSponsorT3Draw,
  buildSponsorT4FirstConsume,
  planSponsorJourney,
  sponsorTxReferenceInputsOf,
  sponsorTxWithdrawalCountOf,
  type NewcomerAnchorRef,
} from "../src/index.js";

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
const SLOW = 900_000;

const DID = "did:phoenixkey:preprod:newcomer-sdk-0001";
const DID_COMMIT = Buffer.from(blake2b(new TextEncoder().encode(DID), { dkLen: 32 })).toString("hex");

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const CM_BP = process.env["CONSUME_BLUEPRINT"] ?? here("../../ConsumeMAGIC/onchain/plutus.json");
const PG_BP = process.env["PREPAID_BLUEPRINT"] ?? here("../../PrepaidGen/onchain/plutus.json");

// ── Trạng thái dùng chung ─────────────────────────────────────────────────────

let emulator: Emulator;
let lucid: LucidEvolution;
let sponsor: EmulatorAccount;   // bên tài trợ: giữ CARP, platform của quỹ
let feeWallet: EmulatorAccount; // ví khoá của người mới: trả phí mọi tx
let didKey: EmulatorAccount;
let provider: EmulatorAccount;
let holder: EmulatorAccount;
let scripts: PrepaidScripts;
let consumeScript: Validator;
let consumeRef: UTxO;
let beaconUnit = "";
let fundUnit = "";
let fundId = "";
let didHash = "";
let didReward = "";
let didNative: ReturnType<typeof scriptFromNative>;
let anchor: NewcomerAnchorRef;
let vaultUnit = "";
let threadUnit = "";
let drawEpoch = 0n;
let t2Cbor = "";

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

async function submit(tx: TxBuilder, extra: EmulatorAccount[] = []): Promise<string> {
  const c = await tx.completeSafe();
  if (c._tag === "Left") throw new Error(describeError(c.left));
  return submitSigned(c.right, extra);
}

async function only(unit: string): Promise<UTxO> {
  const u = (await emulator.getUtxoByUnit(unit)) as UTxO | undefined;
  if (!u) throw new Error(`không có UTxO nào mang ${unit}`);
  return u;
}

const nowMs = () => BigInt(emulator.now());

function goToEpoch(e: bigint) {
  const target = O + e * P + 60_000n;
  const slots = Number((target - nowMs()) / 1000n);
  if (slots <= 0) throw new Error(`đã ở sau epoch ${e}`);
  emulator.awaitSlot(slots);
}

async function freshSeed(): Promise<UTxO> {
  const h = await submit(lucid.newTx().pay.ToAddress(feeWallet.address, { lovelace: 10_000_000n }));
  return (await emulator.getUtxosByOutRef([{ txHash: h, outputIndex: 0 }]))[0]!;
}

function rawEngage(u: UTxO): Constr<Data> {
  const d = Data.from(u.datum!);
  if (!(d instanceof Constr) || d.index !== 0 || d.fields.length !== 5) {
    throw new Error(`thread ${u.txHash}#${u.outputIndex}: datum không phải Constr 0 năm trường`);
  }
  return d;
}

const didOwner = () => ({ type: "script" as const, hash: didHash });
const didAuth = (): OwnerAuth<TxBuilder> => ({
  kind: "script", hash: didHash, attachWithdraw: (t) => t.withdraw(didReward, 0n).attach.Script(didNative),
});
/** Nhân chứng kiểu `did_stake` thật: tự gắn chính anchor của DID làm reference input. */
const didAuthWithAnchor = (): OwnerAuth<TxBuilder> => ({
  kind: "script", hash: didHash,
  attachWithdraw: (t) => t.withdraw(didReward, 0n).attach.Script(didNative).readFrom([anchor.utxo]),
});

/** Ví khoá đang chọn chỉ giữ ADA (bài này ép để T2 không kéo CARP của ví trả phí). */
async function sponsorCarpUtxos(): Promise<UTxO[]> {
  return (await emulator.getUtxos(sponsor.address)).filter((u) => (u.assets[CARP_UNIT] ?? 0n) > 0n);
}

const codeOf = async (p: Promise<unknown>): Promise<string> =>
  p.then(() => "ACCEPTED", (e) => (e instanceof SponsorJourneyError ? e.code : `KHÁC: ${describeError(e)}`));

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

  sponsor = generateEmulatorAccountFromPrivateKey({ lovelace: 5_000_000_000n, [CARP_UNIT]: 100n * CARP });
  feeWallet = generateEmulatorAccount({ lovelace: 2_000_000_000n });
  didKey = generateEmulatorAccountFromPrivateKey({ lovelace: 20_000_000n });
  provider = generateEmulatorAccountFromPrivateKey({ lovelace: 20_000_000n });
  holder = generateEmulatorAccountFromPrivateKey({ lovelace: 20_000_000n });
  emulator = new Emulator([sponsor, feeWallet, didKey, provider, holder], {
    ...PROTOCOL_PARAMETERS_DEFAULT,
    maxTxSize: 16_384,
    maxTxExMem: 16_500_000n,
    maxTxExSteps: 10_000_000_000n,
  });
  emulator.time = Number(O + E0 * P + 60_000n);
  lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromPrivateKey(sponsor.privateKey); // dựng nền do bên tài trợ trả

  const base = derivePrepaidScripts(pgBp, "Custom", {
    carpPolicyId: CARP_POLICY, carpAssetName: CARP_NAME, msPerEpoch: P, windowOriginMs: O,
  });

  const lockNative = scriptFromNative({ type: "sig", keyHash: pkh(holder) });
  const lockHash = validatorToScriptHash(lockNative);
  const lockAddr = validatorToAddress("Custom", lockNative);

  const priceNative = scriptFromNative({ type: "sig", keyHash: pkh(sponsor) });
  const pricePolicy = validatorToScriptHash(priceNative);
  beaconUnit = pricePolicy + PRICE_NFT_NAME;

  consumeScript = applyConsumeParams(cmBp, {
    priceNftPolicy: pricePolicy, priceNftName: PRICE_NFT_NAME,
    vaultScriptHash: base.vault.hash, priceParamScriptHash: lockHash,
  });

  didNative = scriptFromNative({ type: "sig", keyHash: pkh(didKey) });
  didHash = validatorToScriptHash(didNative);
  didReward = credentialToRewardAddress("Custom", { type: "Script", hash: didHash });
  await submit(lucid.newTx().register.Stake(didReward));

  await submit(
    lucid.newTx()
      .mintAssets({ [beaconUnit]: 1n })
      .attach.MintingPolicy(priceNative)
      .pay.ToContract(lockAddr, {
        kind: "inline",
        value: encodePriceParam({
          // op 1 giữ nguyên cho T4. op 2–4 (ConsumeMany, khối cuối tệp): giá lẻ chọn để
          // sàn-TỪNG-cặp KHÁC gộp-rồi-sàn — 4.999.999,5 + 10.000.000,5 ⟹ lệch đúng 1 nanogic.
          op_prices: [
            { op_type: 1n, base_price: 10_000_000n, demand_mult: 1_000_000_000n },
            { op_type: 2n, base_price: 3_333_333n, demand_mult: 1_500_000_000n },
            { op_type: 3n, base_price: 6_666_667n, demand_mult: 1_500_000_000n },
            { op_type: 4n, base_price: 1_111_111n, demand_mult: 1_700_000_000n },
          ],
          m_min: 500_000_000n, m_max: 2_000_000_000n, epoch: E0,
        }),
      }, { lovelace: 3_000_000n, [beaconUnit]: 1n }),
  );

  // Anchor DID của người mới: NFT tên = owner_commit, policy native đứng thay policy anchor thật.
  const anchorNative = scriptFromNative({ type: "sig", keyHash: pkh(sponsor) });
  const anchorPolicy = validatorToScriptHash(anchorNative);
  const ah = await submit(
    lucid.newTx()
      .mintAssets({ [anchorPolicy + DID_COMMIT]: 1n })
      .attach.MintingPolicy(anchorNative)
      .pay.ToAddress(lockAddr, { lovelace: 3_000_000n, [anchorPolicy + DID_COMMIT]: 1n }),
  );
  const anchorUtxo = (await emulator.getUtxosByOutRef([{ txHash: ah, outputIndex: 0 }]))[0]!;
  anchor = { utxo: anchorUtxo, anchorNftPolicyId: anchorPolicy, ownerCommit: DID_COMMIT };

  const c = await submit(lucid.newTx().pay.ToAddressWithData(lockAddr, undefined, { lovelace: 30_000_000n }, consumeScript));
  consumeRef = (await emulator.getUtxosByOutRef([{ txHash: c, outputIndex: 0 }]))[0]!;
  const v = await submit(lucid.newTx().pay.ToAddressWithData(lockAddr, undefined, { lovelace: 40_000_000n }, base.vault.script));
  const vaultRef = (await emulator.getUtxosByOutRef([{ txHash: v, outputIndex: 0 }]))[0]!;
  scripts = withRefScripts(base, { vault: vaultRef });

  // Quỹ tài trợ đã ghim: platform = bên tài trợ, bên hưởng = provider.
  const seedH = await submit(lucid.newTx().pay.ToAddress(sponsor.address, { lovelace: 10_000_000n }));
  const seed = (await emulator.getUtxosByOutRef([{ txHash: seedH, outputIndex: 0 }]))[0]!;
  const f = addMintPaidFund(lucid.newTx(), {
    scripts, seedUtxo: seed, platformPkh: pkh(sponsor),
    beneficiary: { payment_credential: { VerificationKey: [pkh(provider)] }, stake_credential: null },
    beneficiaryDatum: null, bufferBps: 1_500n, collectSeed: true,
  });
  await submit(f.tx);
  fundUnit = f.nftUnit;
  fundId = f.fundId;

  // Từ đây ví đang chọn = ví khoá của người mới (chỉ ADA): trả phí mọi tx của hành trình.
  lucid.selectWallet.fromSeed(feeWallet.seedPhrase);
}, SLOW);

// ── Kế hoạch ──────────────────────────────────────────────────────────────────

describe("planSponsorJourney — ai ký tx nào", () => {
  it("chủ script: bên tài trợ chỉ ký T2; T3/T4/T5 cùng kỳ; T2 đòi anchor", () => {
    const plan = planSponsorJourney({ owner: { type: "script", hash: "ab".repeat(28) }, sponsorPkh: "cd".repeat(28) });
    expect(plan.steps.map((s) => s.step)).toEqual(["T1", "T2", "T3", "T4"]);
    const roles = (st: string) => plan.steps.find((s) => s.step === st)!.signers.map((s) => s.role);
    expect(roles("T1")).toEqual(["fee-wallet", "owner"]);
    expect(roles("T2")).toEqual(["fee-wallet", "sponsor", "owner"]);
    expect(roles("T3")).toEqual(["fee-wallet", "owner"]);
    expect(roles("T4")).toEqual(["fee-wallet", "owner"]);
    expect(plan.steps[1]!.requires.join(" ")).toMatch(/anchor/);
    expect(plan.steps[0]!.signers[1]!.how).toMatch(/Script\(/);
    expect(plan.sameEpoch).toEqual(["T3", "T4", "T5"]);
  });
  it("chủ khoá: owner ký bằng khoá, không mục rút", () => {
    const plan = planSponsorJourney({ owner: { type: "key", hash: "ab".repeat(28) }, sponsorPkh: "cd".repeat(28) });
    expect(plan.steps[0]!.signers[1]!.how).toMatch(/chữ ký khoá/);
  });
});

// ── Hành trình ────────────────────────────────────────────────────────────────

describe("hành trình tài trợ qua API SDK — script thật trên Emulator", () => {
  it("T1 ĐỎ: did_commit 31 byte ⟹ NÉM SPONSOR_DID_COMMIT_LENGTH, trước khi chạm Lucid", async () => {
    const seed = await freshSeed();
    const code = await codeOf(buildSponsorT1OpenPrepaid({
      lucid, prepaidScripts: scripts, consumeScript, consumeRefUtxo: consumeRef, seedUtxo: seed,
      owner: didOwner(), ownerAuth: didAuth(), didCommit: DID_COMMIT.slice(0, 62), network: NET,
    }));
    expect(code).toBe("SPONSOR_DID_COMMIT_LENGTH");
    // 33 byte cũng đỏ — chặn là "ĐÚNG 32", không phải "≤ 32".
    expect(await codeOf(buildSponsorT1OpenPrepaid({
      lucid, prepaidScripts: scripts, consumeScript, consumeRefUtxo: consumeRef, seedUtxo: seed,
      owner: didOwner(), ownerAuth: didAuth(), didCommit: DID_COMMIT + "00", network: NET,
    }))).toBe("SPONSOR_DID_COMMIT_LENGTH");
  }, SLOW);

  it("T1 XANH (cực đối, 32 byte): một tx đúc két + thread, đúng MỘT mục rút, did_commit ghi lúc đúc", async () => {
    const seed = await freshSeed();
    const r = await buildSponsorT1OpenPrepaid({
      lucid, prepaidScripts: scripts, consumeScript, consumeRefUtxo: consumeRef, seedUtxo: seed,
      owner: didOwner(), ownerAuth: didAuth(), didCommit: DID_COMMIT, network: NET,
    });
    expect(sponsorTxWithdrawalCountOf(r.txCbor)).toBe(1);
    expect(r.summary.withdrawals).toBe(1);
    expect(r.summary.didCommit).toBe(DID_COMMIT);
    expect(r.summary.outputs.some((o) => o.address === r.summary.vaultAddress && o.assets[r.summary.vaultUnit] === 1n)).toBe(true);
    expect(r.summary.outputs.some((o) => o.address === r.summary.threadAddress && o.assets[r.summary.threadUnit] === 1n)).toBe(true);
    await submitSigned(r.tx, [didKey]);

    vaultUnit = r.summary.vaultUnit;
    threadUnit = r.summary.threadUnit;
    const raw = rawEngage(await only(threadUnit));
    expect(raw.fields[2]).toBe(0n);
    expect(raw.fields[3]).toBe(DID_COMMIT);
    expect(raw.fields[4]).toBe(0n);
    expect(decodeVaultDatum((await only(vaultUnit)).datum!).prepaid_credits).toEqual([]);
  }, SLOW);

  it("T2 ĐỎ: thiếu anchor ref ⟹ NÉM SPONSOR_ANCHOR_REF_MISSING; anchor không mang NFT owner_commit ⟹ SPONSOR_ANCHOR_REF_WRONG", async () => {
    const common = {
      lucid, prepaidScripts: scripts, vaultUtxo: await only(vaultUnit), fundUtxo: await only(fundUnit),
      pinnedFundUnit: fundUnit, carpAmount: CARP, sponsorCarpUtxos: await sponsorCarpUtxos(),
      sponsorChangeAddress: sponsor.address, ownerAuth: didAuth(), network: NET, nowMs: nowMs(),
    };
    expect(await codeOf(buildSponsorT2Fund({ ...common, newcomerAnchor: undefined }))).toBe("SPONSOR_ANCHOR_REF_MISSING");
    expect(await codeOf(buildSponsorT2Fund({ ...common, newcomerAnchor: { ...anchor, utxo: consumeRef } })))
      .toBe("SPONSOR_ANCHOR_REF_WRONG");
    expect(await codeOf(buildSponsorT2Fund({ ...common, newcomerAnchor: anchor, pinnedFundUnit: scripts.paidFund.hash + "00".repeat(32) })))
      .toBe("SPONSOR_FUND_NOT_PINNED");
  }, SLOW);

  it("T2 nhân chứng tự gắn chính anchor (kiểu did_stake thật) ⟹ anchor đúng MỘT lần trong reference_inputs", async () => {
    const r = await buildSponsorT2Fund({
      lucid, prepaidScripts: scripts, vaultUtxo: await only(vaultUnit), fundUtxo: await only(fundUnit),
      pinnedFundUnit: fundUnit, carpAmount: CARP, sponsorCarpUtxos: await sponsorCarpUtxos(),
      sponsorChangeAddress: sponsor.address, newcomerAnchor: anchor, ownerAuth: didAuthWithAnchor(),
      network: NET, nowMs: nowMs(),
    });
    const hits = sponsorTxReferenceInputsOf(r.txCbor)
      .filter((x) => x.txHash === anchor.utxo.txHash && x.outputIndex === anchor.utxo.outputIndex);
    expect(hits.length).toBe(1);
  }, SLOW);

  it("T2 XANH (cực đối, có anchor): Lock + FundLock, CARP từ bên tài trợ, anchor là reference input", async () => {
    const sponsorCarpBefore = (await sponsorCarpUtxos()).reduce((a, u) => a + u.assets[CARP_UNIT]!, 0n);
    const feeCarpBefore = (await emulator.getUtxos(feeWallet.address)).reduce((a, u) => a + (u.assets[CARP_UNIT] ?? 0n), 0n);
    const r = await buildSponsorT2Fund({
      lucid, prepaidScripts: scripts, vaultUtxo: await only(vaultUnit), fundUtxo: await only(fundUnit),
      pinnedFundUnit: fundUnit, carpAmount: CARP, sponsorCarpUtxos: await sponsorCarpUtxos(),
      sponsorChangeAddress: sponsor.address, newcomerAnchor: anchor, ownerAuth: didAuth(),
      network: NET, nowMs: nowMs(),
    });
    // Đo độc lập với phép kiểm trong SDK: đọc thẳng thân tx bằng CML.
    const refs = CML.Transaction.from_cbor_hex(r.txCbor).body().reference_inputs();
    const refKeys: string[] = [];
    for (let i = 0; i < (refs?.len() ?? 0); i++) {
      refKeys.push(`${refs!.get(i).transaction_id().to_hex()}#${refs!.get(i).index()}`);
    }
    expect(refKeys).toContain(`${anchor.utxo.txHash}#${anchor.utxo.outputIndex}`);
    expect(r.summary.opensNewLine).toBe(true);
    expect(r.summary.fundId).toBe(fundId);
    expect(r.summary.sponsorSigners).toEqual([pkh(sponsor)]);
    expect(r.summary.withdrawals).toBe(1);
    t2Cbor = r.txCbor;
    await submitSigned(r.tx, [sponsor, didKey]);

    expect((await only(fundUnit)).assets[CARP_UNIT]).toBe(CARP);
    const sponsorCarpAfter = (await sponsorCarpUtxos()).reduce((a, u) => a + u.assets[CARP_UNIT]!, 0n);
    expect(sponsorCarpBefore - sponsorCarpAfter).toBe(CARP);
    const feeCarpAfter = (await emulator.getUtxos(feeWallet.address)).reduce((a, u) => a + (u.assets[CARP_UNIT] ?? 0n), 0n);
    expect(feeCarpAfter).toBe(feeCarpBefore);
    expect(decodeVaultDatum((await only(vaultUnit)).datum!).prepaid_credits.length).toBe(1);
  }, SLOW);

  it("assertSponsorCarpOutputs: CARP tới địa chỉ ngoài quỹ đã ghim ⟹ NÉM; T2 thật ⟹ qua", async () => {
    const expectT2 = {
      carpUnit: CARP_UNIT, fundAddress: scripts.paidFund.address, fundUnit, fundCarpOut: CARP,
      sponsorChangeAddress: sponsor.address, sponsorChangeCarp: 99n * CARP,
    };
    expect(() => assertSponsorCarpOutputs(t2Cbor, expectT2)).not.toThrow();
    // Một tx chuyển CARP của bên tài trợ cho người lạ (dựng bằng ví bên tài trợ, không nộp).
    lucid.selectWallet.fromPrivateKey(sponsor.privateKey);
    try {
      const c = await lucid.newTx().pay.ToAddress(holder.address, { lovelace: 2_000_000n, [CARP_UNIT]: CARP }).completeSafe();
      if (c._tag === "Left") throw new Error(describeError(c.left));
      let code = "ACCEPTED";
      try { assertSponsorCarpOutputs(c.right.toCBOR(), expectT2); } catch (e) { code = (e as SponsorJourneyError).code; }
      expect(code).toBe("SPONSOR_CARP_OUTPUT_UNPINNED");
    } finally {
      lucid.selectWallet.fromSeed(feeWallet.seedPhrase);
    }
  }, SLOW);

  it("T3 ĐỎ: validity vắt hai kỳ ⟹ NÉM SPONSOR_VALIDITY_SPANS_EPOCHS", async () => {
    const t = nowMs();
    const e = (t - O) / P;
    const end = O + (e + 1n) * P;
    expect(await codeOf(buildSponsorT3Draw({
      lucid, prepaidScripts: scripts, vaultUtxo: await only(vaultUnit), fundId, carpAmount: CARP,
      ownerAuth: didAuth(), network: NET, nowMs: t, validity: { fromMs: t - 60_000n, toMs: end + 60_000n },
    }))).toBe("SPONSOR_VALIDITY_SPANS_EPOCHS");
  }, SLOW);

  it("T3 XANH (cực đối, validity gọn trong kỳ): PrepaidDraw ⟹ một lô MAGIC kỳ e", async () => {
    const r = await buildSponsorT3Draw({
      lucid, prepaidScripts: scripts, vaultUtxo: await only(vaultUnit), fundId, carpAmount: CARP,
      ownerAuth: didAuth(), network: NET, nowMs: nowMs(),
    });
    expect(r.summary.magicNanogic).toBe(parMagicFromCarp(CARP));
    expect(r.summary.withdrawals).toBe(1);
    await submitSigned(r.tx, [didKey]);
    drawEpoch = r.summary.epoch;
    expect(drawEpoch).toBe((nowMs() - O) / P);
    const vd = decodeVaultDatum((await only(vaultUnit)).datum!);
    expect(vd.magic_batches.at(-1)!.created_epoch).toBe(drawEpoch);
  }, SLOW);

  async function t4At(dEpoch: bigint) {
    return buildSponsorT4FirstConsume({
      lucid, prepaidScripts: scripts, consumeScript, consumeRefUtxo: consumeRef,
      engageUtxo: await only(threadUnit), vaultUtxo: await only(vaultUnit), priceBeaconUtxo: await only(beaconUnit),
      opType: 1, opCount: 1n, ownerAuth: didAuth(), network: NET, tipPosixMs: nowMs(), drawEpoch: dEpoch,
      maxPriceStale: MAX_PRICE_STALE,
    });
  }

  it("T4 XANH (cùng kỳ T3): consume đầu + BurnBatch; thread [2,3,4] = [e, did_commit, required]", async () => {
    const r = await t4At(drawEpoch);
    expect(r.summary.epoch).toBe(drawEpoch);
    expect(r.summary.threadUnit).toBe(threadUnit);
    expect(r.summary.withdrawals).toBe(1);
    expect(r.summary.requiredNanogic).toBe(10_000_000n);
    await submitSigned(r.tx, [didKey]);
    const raw = rawEngage(await only(threadUnit));
    expect(raw.fields[2]).toBe(drawEpoch);
    expect(raw.fields[3]).toBe(DID_COMMIT);
    expect(raw.fields[4]).toBe(r.summary.requiredNanogic);
    const vd = decodeVaultDatum((await only(vaultUnit)).datum!);
    expect(vd.magic_batches[0]!.current_amount).toBe(parMagicFromCarp(CARP) - r.summary.requiredNanogic);
  }, SLOW);

  // ── ConsumeMany (redeemer constr 3) — validator `consume` + vault Prepaid chạy THẬT ─────────
  // Cùng kỳ T3 (lô Prepaid chỉ sống kỳ rút), trên thread đã qua T4. `required` của ConsumeMany
  // = Σ sàn TỪNG cặp (`requiredFromBeaconPairs`); ca ĐỎ dựng y hệt ca XANH, chỉ đổi lượng két đốt
  // sang gộp-rồi-sàn (lớn hơn đúng 1 nanogic) ⟹ `Σburns == required` vỡ ⟹ validator từ chối.

  type Line = { opType: number; opCount: bigint } | { pairs: { opType: number; opCount: bigint }[] };
  const Q = 1_000_000_000n;

  /** Gộp-rồi-sàn: ⌊Σ base·dm·count / Q⌋ — quy tắc của Consume ĐƠN, SAI cho ConsumeMany. */
  async function foldOnce(pairs: { opType: number; opCount: bigint }[]): Promise<bigint> {
    const pp = decodePriceParam((await only(beaconUnit)).datum!);
    const num = pairs.reduce((t, p) => {
      const op = pp.op_prices.find(o => o.op_type === BigInt(p.opType))!;
      return t + op.base_price * op.demand_mult * p.opCount;
    }, 0n);
    return num / Q;
  }

  async function consumeLine(line: Line, burnOverride?: bigint) {
    const vaultUtxo = await only(vaultUnit);
    const beacon = await only(beaconUnit);
    const pp = decodePriceParam(beacon.datum!);
    const required = "pairs" in line
      ? requiredFromBeaconPairs(pp, line.pairs) : requiredFromBeacon(pp, line.opType, line.opCount);
    const burns = planPrepaidBurns(decodeVaultDatum(vaultUtxo.datum!), burnOverride ?? required, drawEpoch);
    const pb = prepaidBurnFor(scripts, vaultUtxo, burns, drawEpoch);
    const common = {
      lucid, engageUtxo: await only(threadUnit), vaultUtxo, priceBeaconUtxo: beacon, consumeScript,
      vaultScript: scripts.vault.script as Validator,
      vaultBurnRedeemerCbor: pb.vaultBurnRedeemerCbor, vaultOutDatumCbor: pb.vaultOutDatumCbor,
      vaultOutAssets: pb.vaultOutAssets, vaultKind: "prepaid" as const, ownerAuth: didAuth(),
      consumeRefUtxo: consumeRef, vaultRefUtxo: scripts.vault.refUtxo, network: NET, tipPosixMs: nowMs(),
      maxPriceStale: MAX_PRICE_STALE,
    };
    const r = "pairs" in line
      ? await buildConsumeManyTx({ ...common, pairs: line.pairs })
      : await buildConsumeTx({ ...common, opType: line.opType, opCount: line.opCount });
    return { r, required };
  }

  /** Kích thước + ExUnit tổng (mọi redeemer) của tx đã dựng — Lucid đã đánh giá script thật. */
  function measure(cbor: string): { bytes: number; mem: bigint; steps: bigint } {
    const rd = CML.Transaction.from_cbor_hex(cbor).witness_set().redeemers();
    let mem = 0n, steps = 0n;
    const add = (eu: CML.ExUnits) => { mem += eu.mem(); steps += eu.steps(); };
    const legacy = rd?.as_arr_legacy_redeemer();
    if (legacy !== undefined) for (let i = 0; i < legacy.len(); i++) add(legacy.get(i).ex_units());
    const map = rd?.as_map_redeemer_key_to_redeemer_val();
    if (map !== undefined) {
      const ks = map.keys();
      for (let i = 0; i < ks.len(); i++) add(map.get(ks.get(i))!.ex_units());
    }
    if (mem === 0n) throw new Error("tx không có redeemer nào — phép đo vô nghĩa");
    return { bytes: cbor.length / 2, mem, steps };
  }

  async function threadAndLot() {
    const raw = rawEngage(await only(threadUnit));
    const vd = decodeVaultDatum((await only(vaultUnit)).datum!);
    return { count: raw.fields[1] as bigint, nanogic: raw.fields[4] as bigint, lot: vd.magic_batches[0]!.current_amount };
  }

  it("ĐO: Consume đơn vs ConsumeMany MỘT cặp (cùng op 2 × 1) — byte + ExUnit, script chạy thật", async () => {
    const single = await consumeLine({ opType: 2, opCount: 1n });
    const many1 = await consumeLine({ pairs: [{ opType: 2, opCount: 1n }] });
    expect(many1.r.requiredNanogic).toBe(single.r.requiredNanogic);
    const a = measure(single.r.tx.toCBOR());
    const b = measure(many1.r.tx.toCBOR());
    // Số đo đi vào README VaultTxAPI §`/tx/consume` (quyết định `pairs` một phần tử ⟹ Consume đơn).
    console.log(`[đo ConsumeMany] Consume đơn: ${a.bytes} byte, mem ${a.mem}, steps ${a.steps} · ` +
      `ConsumeMany 1 cặp: ${b.bytes} byte, mem ${b.mem}, steps ${b.steps}`);
    expect(b.bytes).toBeGreaterThan(a.bytes);
    expect(b.mem).toBeGreaterThan(a.mem);
    expect(b.steps).toBeGreaterThan(a.steps);
  }, SLOW);

  it("ConsumeMany ĐỎ (cực đối của ca XANH dưới): két đốt gộp-rồi-sàn (+1 nanogic) ⟹ validator từ chối", async () => {
    const pairs = [{ opType: 2, opCount: 1n }, { opType: 3, opCount: 1n }];
    const perPair = requiredFromBeaconPairs(decodePriceParam((await only(beaconUnit)).datum!), pairs);
    const folded = await foldOnce(pairs);
    expect(folded - perPair).toBe(1n); // đầu vào PHÂN BIỆT được hai quy tắc
    const before = await threadAndLot();
    await expect(consumeLine({ pairs }, folded)).rejects.toThrow();
    expect(await threadAndLot()).toEqual(before);
  }, SLOW);

  it("ConsumeMany XANH 2 cặp (op 2, 3): thread + két giảm đúng Σ sàn TỪNG cặp; consumed_count += 2", async () => {
    const pairs = [{ opType: 2, opCount: 1n }, { opType: 3, opCount: 1n }];
    const before = await threadAndLot();
    const { r, required } = await consumeLine({ pairs });
    expect(r.requiredNanogic).toBe(required);
    expect(required).toBe(14_999_999n);
    await submitSigned(r.tx, [didKey]);
    const after = await threadAndLot();
    expect(after.nanogic - before.nanogic).toBe(14_999_999n);
    expect(after.count - before.count).toBe(2n);
    expect(before.lot - after.lot).toBe(14_999_999n);
  }, SLOW);

  it("ConsumeMany XANH 4 cặp OriLife (mã 1–4): Σ sàn từng cặp, khác gộp-rồi-sàn", async () => {
    const pairs = [
      { opType: 1, opCount: 1n }, { opType: 2, opCount: 1n }, { opType: 3, opCount: 1n }, { opType: 4, opCount: 3n },
    ];
    const folded = await foldOnce(pairs);
    const before = await threadAndLot();
    const { r, required } = await consumeLine({ pairs });
    expect(required).toBe(30_666_665n);
    expect(folded).toBe(30_666_666n);
    console.log(`[đo ConsumeMany] 4 cặp: ${JSON.stringify(measure(r.tx.toCBOR()), (_, v) => typeof v === "bigint" ? v.toString() : v)}`);
    await submitSigned(r.tx, [didKey]);
    const after = await threadAndLot();
    expect(after.nanogic - before.nanogic).toBe(required);
    expect(after.count - before.count).toBe(6n);
    expect(before.lot - after.lot).toBe(required);
  }, SLOW);

  it("T4 ĐỎ: sang kỳ e+1 với lô của kỳ e ⟹ NÉM SPONSOR_EPOCH_MISMATCH trước khi dựng", async () => {
    goToEpoch(drawEpoch + 1n);
    expect(await codeOf(t4At(drawEpoch))).toBe("SPONSOR_EPOCH_MISMATCH");
  }, SLOW);
});
