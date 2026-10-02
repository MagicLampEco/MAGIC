// tests/txEmulator.test.ts — bộ dựng PrepaidGen (src/tx) trên Lucid Emulator, đánh giá UPLC THẬT.
//
// Blueprint: biến môi trường PREPAID_BLUEPRINT (đường tới plutus.json), mặc định
// `PrepaidGen/onchain/plutus.json`. Chạy `aiken build PrepaidGen/onchain` trước.
//
// Lucid đánh giá script trong `complete()`, nên ca âm là bộ dựng bị TỪ CHỐI ở bước
// đó. Mỗi ca âm on-chain đổi ĐÚNG MỘT điều so với ca dương cùng nhánh (chữ ký chủ,
// CARP thật, lượng rút, kỳ) — phần còn lại của giao dịch y hệt — để đỏ là do điều đó.
// Giới hạn đã biết: blueprint build mặc định không giữ trace, nên Emulator chỉ nói
// "script fail", không nói `expect` nào; ca âm chứng minh "validator từ chối hình
// dạng này", KHÔNG chứng minh "đúng dòng X từ chối".

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Emulator,
  Lucid,
  PROTOCOL_PARAMETERS_DEFAULT,
  credentialToRewardAddress,
  generateEmulatorAccount,
  generateEmulatorAccountFromPrivateKey,
  getAddressDetails,
  scriptFromNative,
  validatorToScriptHash,
  type EmulatorAccount,
  type LucidEvolution,
  type TxBuilder,
  type UTxO,
} from "@lucid-evolution/lucid";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PrepaidRuleError,
  PrepaidTxError,
  addFundClaim,
  addMintPaidFund,
  addMintPrepaidVault,
  addPrepaidBurnBatch,
  addPrepaidDraw,
  addPrepaidLock,
  addSettleLine,
  applyPlan,
  decodeFundDatum,
  decodeVaultDatum,
  derivePrepaidScripts,
  drawRedeemer,
  encodeVaultDatum,
  epochAtMs,
  maxClaimable,
  parMagicFromCarp,
  planPrepaidBurns,
  planPrepaidDraw,
  planPrepaidLock,
  prepaidBurnFor,
  validityInEpoch,
  type OwnerAuth,
  type PrepaidBlueprint,
  type PrepaidScripts,
  type PrepaidVaultDatum,
  type TxPlan,
} from "../offchain/src/index.js";

const P = 432_000_000n;
const O = 1_700_000_123_000n; // gốc cửa sổ khác 0 và không chia hết cho P
const E0 = 100n;
const CARP = 1_000_000_000n;
const CARP_POLICY = "22".repeat(28);
const CARP_NAME = "5a".repeat(28);
const CARP_UNIT = CARP_POLICY + CARP_NAME;
const SLOW = 600_000;

const BP_PATH =
  process.env["PREPAID_BLUEPRINT"] ?? fileURLToPath(new URL("../onchain/plutus.json", import.meta.url));

let emulator: Emulator;
let lucid: LucidEvolution;
let sponsor: EmulatorAccount;
let user: EmulatorAccount;
let didKey: EmulatorAccount;
let provider: EmulatorAccount;
let scripts: PrepaidScripts;
let fundUnit = "";
let fundId = "";
let vaultA = ""; // chủ khoá (user)
let vaultB = ""; // chủ script (native stake script của didKey)
let didAuth: OwnerAuth<TxBuilder>;

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

async function submit(tx: TxBuilder, extra: EmulatorAccount[] = []): Promise<string> {
  const c = await tx.completeSafe();
  if (c._tag === "Left") throw new Error(describeError(c.left));
  let s = c.right.sign.withWallet();
  for (const k of extra) s = s.sign.withPrivateKey(k.privateKey);
  const signed = await s.completeSafe();
  if (signed._tag === "Left") throw new Error(`ký: ${describeError(signed.left)}`);
  const sub = await signed.right.submitSafe();
  if (sub._tag === "Left") throw new Error(`nộp: ${describeError(sub.left)}`);
  emulator.awaitBlock(1);
  return sub.right;
}

/** Dựng tx; trả thông điệp từ chối, hoặc "ACCEPTED" nếu dựng được. */
async function rejection(tx: TxBuilder): Promise<string> {
  const c = await tx.completeSafe();
  return c._tag === "Left" ? describeError(c.left) : "ACCEPTED";
}

// Thông điệp khi UPLC từ chối trong `complete()` (đo ở lượt chạy đầu, xem báo cáo).
const SCRIPT_FAIL = /failed script execution (Spend|Mint)\[\d+\]/;

async function only(unit: string): Promise<UTxO> {
  const u = (await emulator.getUtxoByUnit(unit)) as UTxO | undefined;
  if (!u) throw new Error(`không có UTxO nào mang ${unit}`);
  return u;
}

const nowMs = () => BigInt(emulator.now());
const epochNow = () => epochAtMs(nowMs(), P, O);
const validity = () => validityInEpoch(nowMs(), P, O);

function goToEpoch(e: bigint) {
  const target = O + e * P + 60_000n;
  const slots = Number((target - nowMs()) / 1000n);
  if (slots <= 0) throw new Error(`đã ở sau epoch ${e}`);
  emulator.awaitSlot(slots);
}

async function freshSeed(): Promise<UTxO> {
  const h = await submit(lucid.newTx().pay.ToAddress(sponsor.address, { lovelace: 10_000_000n }));
  return (await emulator.getUtxosByOutRef([{ txHash: h, outputIndex: 0 }]))[0]!;
}

async function vaultDatumOn(unit: string): Promise<PrepaidVaultDatum> {
  return decodeVaultDatum((await only(unit)).datum!);
}

beforeAll(async () => {
  if (!existsSync(BP_PATH)) {
    throw new Error(`không thấy blueprint ${BP_PATH} — chạy \`aiken build PrepaidGen/onchain\` hoặc đặt PREPAID_BLUEPRINT`);
  }
  const bp: PrepaidBlueprint = JSON.parse(readFileSync(BP_PATH, "utf8"));
  sponsor = generateEmulatorAccount({ lovelace: 5_000_000_000n, [CARP_UNIT]: 100n * CARP });
  user = generateEmulatorAccountFromPrivateKey({ lovelace: 20_000_000n });
  didKey = generateEmulatorAccountFromPrivateKey({ lovelace: 20_000_000n });
  provider = generateEmulatorAccountFromPrivateKey({ lovelace: 20_000_000n });
  emulator = new Emulator([sponsor, user, didKey, provider], { ...PROTOCOL_PARAMETERS_DEFAULT, maxTxSize: 16_384 });
  emulator.time = Number(O + E0 * P + 60_000n);
  lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(sponsor.seedPhrase);
  scripts = derivePrepaidScripts(bp, "Custom", {
    carpPolicyId: CARP_POLICY,
    carpAssetName: CARP_NAME,
    msPerEpoch: P,
    windowOriginMs: O,
  });

  // Chủ script: native script `sig(didKey)` làm stake credential, đăng ký trước.
  const native = scriptFromNative({ type: "sig", keyHash: pkh(didKey) });
  const h = validatorToScriptHash(native);
  const reward = credentialToRewardAddress("Custom", { type: "Script", hash: h });
  await submit(lucid.newTx().register.Stake(reward));
  didAuth = { kind: "script", hash: h, attachWithdraw: (tx) => tx.withdraw(reward, 0n).attach.Script(native) };
}, SLOW);

describe("PrepaidGen bộ dựng — Emulator, script thật", () => {
  it("genesis quỹ (đúc NFT quỹ, platform = bên tài trợ)", async () => {
    const seed = await freshSeed();
    const r = addMintPaidFund(lucid.newTx(), {
      scripts,
      seedUtxo: seed,
      platformPkh: pkh(sponsor),
      beneficiary: { payment_credential: { VerificationKey: [pkh(provider)] }, stake_credential: null },
      beneficiaryDatum: null,
      bufferBps: 1_500n,
      collectSeed: true,
    });
    await submit(r.tx);
    fundUnit = r.nftUnit;
    fundId = r.fundId;
    expect(decodeFundDatum((await only(fundUnit)).datum!)).toEqual(r.datum);
  }, SLOW);

  // ── T1 ──────────────────────────────────────────────────────
  it("T1 ĐỎ: mint két chủ khoá mà không có chữ ký chủ ⟹ validator từ chối", async () => {
    const seed = await freshSeed();
    const r = addMintPrepaidVault(lucid.newTx(), {
      scripts, seedUtxo: seed, owner: { type: "key", hash: pkh(user) }, collectSeed: true,
      ownerProof: { mode: "deferred" },
    });
    expect(r.plan.owner).toEqual({ type: "key", hash: pkh(user) });
    expect(await rejection(r.tx)).toMatch(SCRIPT_FAIL);
  }, SLOW);

  it("T1 XANH: mint két chủ khoá, datum genesis sạch", async () => {
    const seed = await freshSeed();
    const r = addMintPrepaidVault(lucid.newTx(), {
      scripts, seedUtxo: seed, owner: { type: "key", hash: pkh(user) }, collectSeed: true,
      ownerProof: { mode: "attach" },
    });
    await submit(r.tx, [user]);
    vaultA = r.nftUnit;
    const d = await vaultDatumOn(vaultA);
    expect(d).toEqual(r.datum);
    expect(d.did_commit).toBe("");
  }, SLOW);

  it("T1 XANH: mint két chủ SCRIPT qua withdraw-zero (một mục rút)", async () => {
    const seed = await freshSeed();
    const r = addMintPrepaidVault(lucid.newTx(), {
      scripts, seedUtxo: seed, owner: { type: "script", hash: didAuth.kind === "script" ? didAuth.hash : "" },
      collectSeed: true, ownerProof: { mode: "attach", auth: didAuth },
    });
    await submit(r.tx, [didKey]);
    vaultB = r.nftUnit;
    expect((await vaultDatumOn(vaultB)).owner).toEqual(r.datum.owner);
  }, SLOW);

  it("T1: chủ script mà không truyền auth ⟹ bộ dựng NÉM, không bịa nhân chứng", async () => {
    const seed = await freshSeed();
    expect(() =>
      addMintPrepaidVault(lucid.newTx(), {
        scripts, seedUtxo: seed, owner: { type: "script", hash: "ab".repeat(28) }, collectSeed: true,
        ownerProof: { mode: "attach" },
      }),
    ).toThrow(/OWNER_SCRIPT_WITNESS_UNAVAILABLE/);
  });

  // ── T2 ──────────────────────────────────────────────────────
  it("T2: mở dòng mới bằng chữ ký platform ⟹ bộ dựng NÉM C-PP-9", async () => {
    const vu = await only(vaultA);
    const fu = await only(fundUnit);
    expect(() => planPrepaidLock({ scripts, vaultUtxo: vu, fundUtxo: fu, amount: 2n * CARP, validity: validity(), by: "platform" }))
      .toThrow(PrepaidRuleError);
  }, SLOW);

  it("T2 ĐỎ: mở dòng mới không có quyền chủ ⟹ validator từ chối", async () => {
    const r = addPrepaidLock(lucid.newTx(), {
      scripts, vaultUtxo: await only(vaultA), fundUtxo: await only(fundUnit), amount: 2n * CARP,
      validity: validity(), by: "owner", ownerProof: { mode: "deferred" },
    });
    expect(await rejection(r.tx)).toMatch(SCRIPT_FAIL);
  }, SLOW);

  it("T2 ĐỎ: quỹ đầu ra thiếu 1 carpdrop so với datum ⟹ validator từ chối", async () => {
    const r = planPrepaidLock({
      scripts, vaultUtxo: await only(vaultA), fundUtxo: await only(fundUnit), amount: 2n * CARP,
      validity: validity(), by: "owner",
    });
    const fundOut = r.plan.outputs[1]!;
    const tampered: TxPlan = {
      ...r.plan,
      outputs: [r.plan.outputs[0]!, { ...fundOut, assets: { ...fundOut.assets, [CARP_UNIT]: fundOut.assets[CARP_UNIT]! - 1n } }],
    };
    expect(await rejection(applyPlan(lucid.newTx(), tampered, { mode: "attach" }))).toMatch(SCRIPT_FAIL);
  }, SLOW);

  it("T2 XANH: khoá 2 CARP, chủ ký, CARP từ ví bên tài trợ; datum hai đầu khớp luật", async () => {
    const r = addPrepaidLock(lucid.newTx(), {
      scripts, vaultUtxo: await only(vaultA), fundUtxo: await only(fundUnit), amount: 2n * CARP,
      validity: validity(), by: "owner", ownerProof: { mode: "attach" },
    });
    expect(r.opensNewLine).toBe(true);
    await submit(r.tx, [user]);
    expect(await vaultDatumOn(vaultA)).toEqual(r.vaultDatumOut);
    const fu = await only(fundUnit);
    expect(decodeFundDatum(fu.datum!)).toEqual(r.fundDatumOut);
    expect(fu.assets[CARP_UNIT]).toBe(2n * CARP);
    expect(r.vaultDatumOut.prepaid_credits[0]!.issued_epoch).toBe(epochNow());
  }, SLOW);

  it("T2 XANH: nạp thêm vào dòng ĐÃ CÓ chỉ bằng chữ ký platform", async () => {
    const r = addPrepaidLock(lucid.newTx(), {
      scripts, vaultUtxo: await only(vaultA), fundUtxo: await only(fundUnit), amount: CARP,
      validity: validity(), by: "platform", ownerProof: { mode: "attach" },
    });
    expect(r.opensNewLine).toBe(false);
    await submit(r.tx);
    expect((await vaultDatumOn(vaultA)).prepaid_credits[0]!.remaining).toBe(3n * CARP);
  }, SLOW);

  it("T2 XANH: két chủ SCRIPT mở dòng qua withdraw-zero", async () => {
    const r = addPrepaidLock(lucid.newTx(), {
      scripts, vaultUtxo: await only(vaultB), fundUtxo: await only(fundUnit), amount: CARP,
      validity: validity(), by: "owner", ownerProof: { mode: "attach", auth: didAuth },
    });
    await submit(r.tx, [didKey]);
    expect(await vaultDatumOn(vaultB)).toEqual(r.vaultDatumOut);
    expect((await only(fundUnit)).assets[CARP_UNIT]).toBe(4n * CARP);
  }, SLOW);

  // ── T3 ──────────────────────────────────────────────────────
  it("T3 ĐỎ: rút vượt hạn-mức (datum đầu ra nhất quán với lượng vượt) ⟹ validator từ chối", async () => {
    const vu = await only(vaultA);
    const remaining = decodeVaultDatum(vu.datum!).prepaid_credits[0]!.remaining;
    const ok = planPrepaidDraw({ scripts, vaultUtxo: vu, fundId, amount: remaining, validity: validity() });
    const over = remaining + 1n;
    const bad: PrepaidVaultDatum = {
      ...ok.vaultDatumOut,
      prepaid_credits: ok.vaultDatumOut.prepaid_credits.map((c) => ({ ...c, remaining: remaining - over })),
      magic_batches: ok.vaultDatumOut.magic_batches.map((b) => ({ ...b, current_amount: parMagicFromCarp(over) })),
    };
    const tampered: TxPlan = {
      ...ok.plan,
      spends: [{ ...ok.plan.spends[0]!, redeemerCbor: drawRedeemer(fundId, over) }],
      outputs: [{ ...ok.plan.outputs[0]!, datumCbor: encodeVaultDatum(bad) }],
    };
    expect(await rejection(applyPlan(lucid.newTx(), tampered, { mode: "attach" }))).toMatch(SCRIPT_FAIL);
    // Cực đối: cùng lượng hợp lệ thì dựng được.
    expect(await rejection(applyPlan(lucid.newTx(), ok.plan, { mode: "attach" }))).toBe("ACCEPTED");
  }, SLOW);

  it("T3 XANH: rút 1 CARP ⟹ batch created_epoch == kỳ hiện tại", async () => {
    const r = addPrepaidDraw(lucid.newTx(), {
      scripts, vaultUtxo: await only(vaultA), fundId, amount: CARP, validity: validity(), ownerProof: { mode: "attach" },
    });
    await submit(r.tx, [user]);
    const d = await vaultDatumOn(vaultA);
    expect(d).toEqual(r.vaultDatumOut);
    expect(r.batch.created_epoch).toBe(epochNow());
    expect(r.batch.current_amount).toBe(parMagicFromCarp(CARP));
  }, SLOW);

  it("T3: validity vắt hai kỳ ⟹ bộ dựng NÉM trước khi tới chuỗi", async () => {
    const end = O + (epochNow() + 1n) * P;
    const vu = await only(vaultA);
    expect(() =>
      planPrepaidDraw({ scripts, vaultUtxo: vu, fundId, amount: CARP, validity: { fromMs: end - 5_000n, toMs: end + 5_000n } }),
    ).toThrow(/C-PP-EPOCH/);
  }, SLOW);

  // ── T4 phía vault + quyết toán ─────────────────────────────
  it("BurnBatch XANH (chủ ký, đứng một mình): nợ quyết toán tăng đúng lượng đốt", async () => {
    const vu = await only(vaultA);
    const d = decodeVaultDatum(vu.datum!);
    const burns = planPrepaidBurns(d, 400_000_000n, epochNow());
    const r = addPrepaidBurnBatch(lucid.newTx(), { scripts, vaultUtxo: vu, burns, validity: validity(), ownerProof: { mode: "attach" } });
    await submit(r.tx, [user]);
    const after = await vaultDatumOn(vaultA);
    expect(after).toEqual(r.vaultDatumOut);
    expect(after.prepaid_credits[0]!.consumed_unsettled).toBe(400_000_000n);
    // prepaidBurnFor cho bộ dựng consume trả cùng datum như mảnh đứng một mình.
    expect(prepaidBurnFor(scripts, vu, burns, epochNow()).vaultOutDatumCbor).toBe(encodeVaultDatum(r.vaultDatumOut));
  }, SLOW);

  it("T3 sau BurnBatch: Draw GIỮ consumed_unsettled (khớp drawMagic; phụ thuộc bản vá validate_draw của G1)", async () => {
    const r = addPrepaidDraw(lucid.newTx(), {
      scripts, vaultUtxo: await only(vaultA), fundId, amount: CARP / 10n, validity: validity(), ownerProof: { mode: "attach" },
    });
    expect(r.vaultDatumOut.prepaid_credits[0]!.consumed_unsettled).toBe(400_000_000n);
    await submit(r.tx, [user]);
    expect(await vaultDatumOn(vaultA)).toEqual(r.vaultDatumOut);
  }, SLOW);

  it("SettleLine + FundSettle XANH (permissionless) sau khi đốt nốt 0,6 MAGIC của batch đầu", async () => {
    // Đốt thêm để quỹ có đủ phần đã tiêu cho FundClaim vượt sàn đệm (outstanding × 1,15).
    const vu = await only(vaultA);
    const burns = planPrepaidBurns(decodeVaultDatum(vu.datum!), 600_000_000n, epochNow());
    await submit(addPrepaidBurnBatch(lucid.newTx(), { scripts, vaultUtxo: vu, burns, validity: validity(), ownerProof: { mode: "attach" } }).tx, [user]);
    const r = addSettleLine(lucid.newTx(), { scripts, vaultUtxo: await only(vaultA), fundUtxo: await only(fundUnit), validity: validity() });
    expect(r.delta).toBe(1_000_000_000n);
    await submit(r.tx);
    expect((await vaultDatumOn(vaultA)).prepaid_credits[0]!.consumed_unsettled).toBe(0n);
    expect(decodeFundDatum((await only(fundUnit)).datum!)).toEqual(r.fundDatumOut);
    expect(r.fundDatumOut.magic_settled).toBe(1_000_000_000n);
  }, SLOW);

  it("FundClaim: phá sàn đệm ⟹ NÉM; 0,5 CARP ⟹ XANH, CARP tới đích đã ghim", async () => {
    const fu = await only(fundUnit);
    expect(() => addFundClaim(lucid.newTx(), { scripts, fundUtxo: fu, amount: CARP, validity: validity() })).toThrow(PrepaidRuleError);
    expect(maxClaimable(decodeFundDatum(fu.datum!))).toBe(550_000_000n);
    const r = addFundClaim(lucid.newTx(), { scripts, fundUtxo: fu, amount: CARP / 2n, validity: validity() });
    await submit(r.tx);
    expect(decodeFundDatum((await only(fundUnit)).datum!)).toEqual(r.fundDatumOut);
    const got = (await emulator.getUtxos(r.beneficiaryAddress)).reduce((a, u) => a + (u.assets[CARP_UNIT] ?? 0n), 0n);
    expect(got).toBe(CARP / 2n);
  }, SLOW);

  // ── ngoài kỳ ───────────────────────────────────────────────
  it("T3 ĐỎ ngoài kỳ: kế hoạch dựng ở kỳ e, nộp với validity kỳ e+1 ⟹ validator từ chối; dựng lại ở e+1 ⟹ XANH", async () => {
    const e = epochNow();
    const stale = planPrepaidDraw({ scripts, vaultUtxo: await only(vaultA), fundId, amount: CARP / 10n, validity: validity() });
    expect(stale.batch.created_epoch).toBe(e);
    goToEpoch(e + 1n);
    const moved: TxPlan = { ...stale.plan, validity: validity() };
    expect(await rejection(applyPlan(lucid.newTx(), moved, { mode: "attach" }))).toMatch(SCRIPT_FAIL);

    const fresh = addPrepaidDraw(lucid.newTx(), {
      scripts, vaultUtxo: await only(vaultA), fundId, amount: CARP / 10n, validity: validity(), ownerProof: { mode: "attach" },
    });
    expect(fresh.batch.created_epoch).toBe(e + 1n);
    await submit(fresh.tx, [user]);
    expect(await vaultDatumOn(vaultA)).toEqual(fresh.vaultDatumOut);
  }, SLOW);

  it("BurnBatch batch kỳ trước ⟹ bộ dựng NÉM C-PP-5 (MAGIC chết theo kỳ)", async () => {
    const vu = await only(vaultA);
    const d = decodeVaultDatum(vu.datum!);
    const old = d.magic_batches.find((b) => b.created_epoch < epochNow())!;
    expect(old).toBeDefined();
    expect(() => prepaidBurnFor(scripts, vu, [[old.batch_id, 1n]], epochNow())).toThrow(/C-PP-5/);
  }, SLOW);

  it("đọc UTxO lạ ⟹ NÉM (không đệm)", async () => {
    const fu = await only(fundUnit);
    expect(() => planPrepaidDraw({ scripts, vaultUtxo: fu, fundId, amount: CARP, validity: validity() })).toThrow(PrepaidTxError);
  });
});
