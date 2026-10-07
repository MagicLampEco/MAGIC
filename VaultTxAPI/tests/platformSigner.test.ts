// VaultTxAPI/tests/platformSigner.test.ts — the one module that holds key material, measured in PAIRS:
// every red case sits next to the green case that differs from it in exactly one input.
//
// Test keys are generated in memory with `node:crypto` and encoded as bech32 `ed25519_sk…` — the same
// shape as the production value. No real key is read anywhere.

import { generateKeyPairSync, type KeyObject } from "node:crypto";

import { CML, Constr, Data, credentialToAddress } from "@lucid-evolution/lucid";
import { encodeFundDatum, fundClaimRedeemer, type PaidFundDatum } from "@magiclamp/prepaidgen-sdk";
import { bech32 } from "bech32";
import { describe, expect, it } from "vitest";

import * as signerModule from "../src/platformSigner.js";
import { createPlatformSigner, type PlatformSignInput, type PlatformSignKind } from "../src/platformSigner.js";

const POLICY = "ab".repeat(28);
const OTHER_POLICY = "cd".repeat(28);
const NET = "Preprod" as const;
const CARP_UNIT = "22".repeat(28) + "5a5a5a5a";
const NFT_NAME = "aa".repeat(32);
const FUND_ADDR = credentialToAddress(NET, { type: "Script", hash: POLICY });
const FEE_ADDR = credentialToAddress(NET, { type: "Key", hash: "22".repeat(28) });
const BEN_KEY = "7a".repeat(28);
const BEN_ADDR = credentialToAddress(NET, { type: "Key", hash: BEN_KEY });
const BEN_DATUM = `d8799fd8799f581c${BEN_KEY}ffff`;
const OTHER_ADDR = credentialToAddress(NET, { type: "Key", hash: "7b".repeat(28) });
const FEE_REF = `${"11".repeat(32)}#0`;
const FUND_REF = `${"33".repeat(32)}#0`;

interface K { pkh: string; sk: string }

function newKey(): K {
  const pair = Object.values(generateKeyPairSync("ed25519")) as KeyObject[];
  const sec = pair.find(k => k.type !== "public")!;
  const der = sec.export({ format: "der", type: "pkcs8" });
  const raw = new Uint8Array(der.subarray(der.length - 32));
  const pubObj = pair.find(k => k.type === "public")!;
  const pubDer = pubObj.export({ format: "der", type: "spki" });
  const pkh = CML.PublicKey.from_bytes(new Uint8Array(pubDer.subarray(pubDer.length - 32))).hash().to_hex();
  return { pkh, sk: bech32.encode("ed25519_sk", bech32.toWords(raw), 1000) };
}

interface OutSpec { address: string; lovelace?: bigint; assets?: Array<[string, bigint]>; datumCbor?: string }
interface TxSpec {
  mint?: Array<[string, string, bigint]>; signers?: string[];
  inputs?: string[]; collateral?: string[]; outputs?: OutSpec[];
  withdrawals?: string[]; cert?: string; redeemer?: { index: bigint; cbor: string };
}

const input = (ref: string) => {
  const [h, i] = ref.split("#") as [string, string];
  return CML.TransactionInput.new(CML.TransactionHash.from_hex(h), BigInt(i));
};

/** Minimal transaction built field by field (CML), so each case differs from its pair in one field only. */
function bareTx(o: TxSpec): CML.Transaction {
  const ins = CML.TransactionInputList.new();
  for (const r of o.inputs ?? [FEE_REF]) ins.add(input(r));
  const outs = CML.TransactionOutputList.new();
  for (const s of o.outputs ?? [{ address: OTHER_ADDR }]) {
    const ma = CML.MultiAsset.new();
    for (const [unit, q] of s.assets ?? []) ma.set(CML.ScriptHash.from_hex(unit.slice(0, 56)), CML.AssetName.from_hex(unit.slice(56)), q);
    const v = CML.Value.new(s.lovelace ?? 2_000_000n, ma);
    const addr = CML.Address.from_bech32(s.address);
    outs.add(s.datumCbor === undefined
      ? CML.TransactionOutput.new(addr, v)
      : CML.TransactionOutput.new(addr, v, CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(s.datumCbor))));
  }
  const body = CML.TransactionBody.new(ins, outs, 200_000n);
  if (o.mint !== undefined) {
    const m = CML.Mint.new();
    for (const [p, n, q] of o.mint) m.set(CML.ScriptHash.from_hex(p), CML.AssetName.from_hex(n), q);
    body.set_mint(m);
  }
  if (o.signers !== undefined) {
    const l = CML.Ed25519KeyHashList.new();
    for (const h of o.signers) l.add(CML.Ed25519KeyHash.from_hex(h));
    body.set_required_signers(l);
  }
  if (o.collateral !== undefined) {
    const l = CML.TransactionInputList.new();
    for (const r of o.collateral) l.add(input(r));
    body.set_collateral_inputs(l);
  }
  if (o.withdrawals !== undefined) {
    const w = CML.MapRewardAccountToCoin.new();
    for (const h of o.withdrawals) w.insert(CML.RewardAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(h))), 0n);
    body.set_withdrawals(w);
  }
  if (o.cert !== undefined) {
    const l = CML.CertificateList.new();
    l.add(CML.Certificate.new_stake_registration(CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(o.cert))));
    body.set_certs(l);
  }
  const ws = CML.TransactionWitnessSet.new();
  if (o.redeemer !== undefined) {
    const l = CML.LegacyRedeemerList.new();
    l.add(CML.LegacyRedeemer.new(CML.RedeemerTag.Spend, o.redeemer.index, CML.PlutusData.from_cbor_hex(o.redeemer.cbor), CML.ExUnits.new(0n, 0n)));
    ws.set_redeemers(CML.Redeemers.new_arr_legacy_redeemer(l));
  }
  return CML.Transaction.new(body, ws, true);
}

const feeIn = (address = FEE_ADDR): PlatformSignInput => ({ ref: FEE_REF, address });
const req = (kind: PlatformSignKind, tx: CML.Transaction, inputs: PlatformSignInput[] = [feeIn()]) => ({ kind, tx, inputs });
const platform = newKey();
const PLATFORM_ADDR = credentialToAddress(NET, { type: "Key", hash: platform.pkh });
const opts = (over: Partial<Parameters<typeof createPlatformSigner>[0]> = {}) => ({
  keyBech32: platform.sk, expectedPkh: platform.pkh, paidFundPolicy: POLICY, tokenValues: ["api-token", "sponsor-token"],
  network: NET, carpUnit: CARP_UNIT, beneficiary: { address: BEN_ADDR, datumCbor: BEN_DATUM }, ...over,
});
const goodTx = (over: Partial<TxSpec> = {}) => bareTx({ mint: [[POLICY, "aa".repeat(32), 1n]], signers: [platform.pkh], ...over });

const keyAddrData = (h: string) => ({ payment_credential: { VerificationKey: [h] as [string] }, stake_credential: null });
// `Data.from` here would build a Constr of THIS package's lucid copy, which the SDK's own copy refuses to
// serialise ("Unsupported type"). So the fund datum carries a 32-byte placeholder and the CBOR is patched.
const BEN_DATUM_SLOT = "e1".repeat(32);
function fundDatum(over: Partial<PaidFundDatum> = {}): PaidFundDatum {
  return {
    fund_id: NFT_NAME, platform: platform.pkh, vault_hash: "cc".repeat(28), carp_locked: 100n, credit_issued: 100n,
    magic_settled: 10n, provider_claimed: 0n, buffer_bps: 0n, last_updated_epoch: 1n,
    beneficiary: keyAddrData(BEN_KEY), beneficiary_datum: BEN_DATUM_SLOT, sponsorship: null, sponsor_reclaimed: 0n,
    ...over,
  } as PaidFundDatum;
}
const fundIn = (d: PaidFundDatum = fundDatum()): PlatformSignInput => ({
  ref: FUND_REF, address: FUND_ADDR, datumCbor: encodeFundDatum(d).replace(`5820${BEN_DATUM_SLOT}`, BEN_DATUM),
  assets: { lovelace: 3_000_000n, [POLICY + NFT_NAME]: 1n, [CARP_UNIT]: 100n },
});
// Sorted inputs: "11…" (fee) < "33…" (fund) ⟹ the fund is spend redeemer index 1.
const CLAIM_REDEEMER = { index: 1n, cbor: fundClaimRedeemer(10n) };
const contOut = (): OutSpec => ({ address: FUND_ADDR, lovelace: 3_000_000n, assets: [[POLICY + NFT_NAME, 1n], [CARP_UNIT, 90n]] });
// `null` = no datum. (Not `undefined`: passing `undefined` falls back to the default parameter.)
const benOut = (address = BEN_ADDR, datumCbor: string | null = BEN_DATUM): OutSpec =>
  ({ address, lovelace: 1_200_000n, assets: [[CARP_UNIT, 10n]], ...(datumCbor === null ? {} : { datumCbor }) });
function claimTx(over: Partial<TxSpec> = {}): CML.Transaction {
  return bareTx({
    inputs: [FEE_REF, FUND_REF], outputs: [contOut(), benOut(), { address: FEE_ADDR }], signers: [platform.pkh],
    redeemer: CLAIM_REDEEMER, ...over,
  });
}
const claimReq = (tx: CML.Transaction, f: PlatformSignInput = fundIn()) => req("fund-claim", tx, [feeIn(), f]);

describe("platformSigner — the only key the service holds", () => {
  it("module exports exactly one runtime symbol: createPlatformSigner", () => {
    expect(Object.keys(signerModule).sort()).toEqual(["createPlatformSigner"]);
  });

  it("PAIR right key ⟹ vkey witness of the platform key, valid signature over the body hash (and NOT over another message)", () => {
    const sign = createPlatformSigner(opts());
    const tx = goodTx();
    const w = sign(req("fund-genesis", tx));
    expect(w.vkey().hash().to_hex()).toBe(platform.pkh);
    const msg = CML.hash_transaction(tx.body()).to_raw_bytes();
    expect(w.vkey().verify(msg, w.ed25519_signature())).toBe(true);
    const flipped = new Uint8Array(msg);
    flipped[31] = flipped[31]! ^ 0x80;
    expect(w.vkey().verify(flipped, w.ed25519_signature())).toBe(false);
  });

  it("PAIR key hash != platform_pkhs[0] ⟹ startup throws; equal ⟹ no throw", () => {
    const other = newKey();
    expect(() => createPlatformSigner(opts({ expectedPkh: other.pkh }))).toThrow(/platform_pkhs\[0\]/);
    expect(() => createPlatformSigner(opts({ expectedPkh: platform.pkh }))).not.toThrow();
  });

  it("platform_pkhs empty ⟹ startup throws (key hash cannot be checked)", () => {
    expect(() => createPlatformSigner(opts({ expectedPkh: undefined }))).toThrow(/platform_pkhs is empty/);
  });

  it("PAIR key value equal to a bearer token ⟹ startup throws; different tokens ⟹ no throw", () => {
    expect(() => createPlatformSigner(opts({ tokenValues: ["api-token", platform.sk] }))).toThrow(/bearer token/);
    expect(() => createPlatformSigner(opts({ tokenValues: ["api-token", "x"] }))).not.toThrow();
  });

  it("not a bech32 ed25519_sk value ⟹ startup throws without echoing the value", () => {
    let msg = "";
    try { createPlatformSigner(opts({ keyBech32: "ed25519_sk1notavalidvalue" })); } catch (e) { msg = String((e as Error).message); }
    expect(msg).toMatch(/not a valid bech32/);
    expect(msg).not.toContain("notavalidvalue");
    expect(() => createPlatformSigner(opts({ keyBech32: "addr_test1xyz" }))).toThrow(/ed25519_sk/);
  });

  it("PAIR tx WITHOUT a fund mint ⟹ sign throws; same tx WITH the +1 fund mint ⟹ signs", () => {
    const sign = createPlatformSigner(opts());
    expect(() => sign(req("fund-genesis", bareTx({ signers: [platform.pkh] })))).toThrow(/does not mint exactly one fund NFT/);
    expect(() => sign(req("fund-genesis", goodTx()))).not.toThrow();
  });

  it("mint under ANOTHER policy, mint of 2, or two assets under paid_fund ⟹ sign throws", () => {
    const sign = createPlatformSigner(opts());
    expect(() => sign(req("fund-genesis", bareTx({ mint: [[OTHER_POLICY, "aa".repeat(32), 1n]], signers: [platform.pkh] })))).toThrow(/fund NFT/);
    expect(() => sign(req("fund-genesis", bareTx({ mint: [[POLICY, "aa".repeat(32), 2n]], signers: [platform.pkh] })))).toThrow(/fund NFT/);
    expect(() => sign(req("fund-genesis", bareTx({ mint: [[POLICY, "aa".repeat(32), 1n], [POLICY, "bb".repeat(32), 1n]], signers: [platform.pkh] }))))
      .toThrow(/fund NFT/);
    expect(() => sign(req("fund-genesis", bareTx({ mint: [[POLICY, "aa".repeat(32), -1n]], signers: [platform.pkh] })))).toThrow(/fund NFT/);
  });

  it("PAIR required_signers WITHOUT the platform key hash ⟹ sign throws; with it ⟹ signs", () => {
    const sign = createPlatformSigner(opts());
    const other = newKey();
    expect(() => sign(req("fund-genesis", bareTx({ mint: [[POLICY, "aa".repeat(32), 1n]], signers: [other.pkh] })))).toThrow(/required_signers/);
    expect(() => sign(req("fund-genesis", bareTx({ mint: [[POLICY, "aa".repeat(32), 1n]] })))).toThrow(/required_signers/);
    expect(() => sign(req("fund-genesis", bareTx({ mint: [[POLICY, "aa".repeat(32), 1n]], signers: [other.pkh, platform.pkh] })))).not.toThrow();
  });

  // ── review #162-1: nothing in the body may draw on the platform key ────────────────────────────────
  it("PAIR (#162-1) fee input at the platform key's address ⟹ sign throws; same tx with the input elsewhere ⟹ signs", () => {
    const sign = createPlatformSigner(opts());
    expect(() => sign(req("fund-genesis", goodTx(), [feeIn(PLATFORM_ADDR)]))).toThrow(/address of the platform key/);
    // Base address with the platform payment key and a foreign stake part: still the platform key.
    const base = credentialToAddress(NET, { type: "Key", hash: platform.pkh }, { type: "Key", hash: "44".repeat(28) });
    expect(() => sign(req("fund-genesis", goodTx(), [feeIn(base)]))).toThrow(/address of the platform key/);
    expect(() => sign(req("fund-genesis", goodTx(), [feeIn(FEE_ADDR)]))).not.toThrow();
  });

  it("PAIR (#162-1) collateral at the platform key's address ⟹ throws; collateral at the fee wallet ⟹ signs", () => {
    const sign = createPlatformSigner(opts());
    const col = `${"55".repeat(32)}#1`;
    expect(() => sign(req("fund-genesis", goodTx({ collateral: [col] }), [feeIn(), { ref: col, address: PLATFORM_ADDR }])))
      .toThrow(/address of the platform key/);
    expect(() => sign(req("fund-genesis", goodTx({ collateral: [col] }), [feeIn(), { ref: col, address: FEE_ADDR }]))).not.toThrow();
  });

  it("an input or collateral that is not resolved ⟹ throws (no blind signing)", () => {
    const sign = createPlatformSigner(opts());
    expect(() => sign(req("fund-genesis", goodTx(), []))).toThrow(/not resolved/);
    expect(() => sign(req("fund-genesis", goodTx({ collateral: [`${"55".repeat(32)}#1`] })))).toThrow(/not resolved/);
  });

  it("PAIR (#162-1) withdrawal from the platform key's reward account ⟹ throws; from another key ⟹ signs", () => {
    const sign = createPlatformSigner(opts());
    expect(() => sign(req("fund-genesis", goodTx({ withdrawals: [platform.pkh] })))).toThrow(/withdrawal/);
    expect(() => sign(req("fund-genesis", goodTx({ withdrawals: ["66".repeat(28)] })))).not.toThrow();
  });

  it("any certificate ⟹ throws (neither shape needs one)", () => {
    const sign = createPlatformSigner(opts());
    expect(() => sign(req("fund-genesis", goodTx({ cert: platform.pkh })))).toThrow(/certificates/);
    expect(() => sign(req("fund-genesis", goodTx({ cert: "66".repeat(28) })))).toThrow(/certificates/);
  });

  // ── fund-claim: FundClaim / closing claim (red-team #2) ───────────────────────────────────────────
  it("PAIR claim: continuing FundClaim to the pinned beneficiary ⟹ signs; the same tx asked as fund-genesis ⟹ throws", () => {
    const sign = createPlatformSigner(opts());
    const w = sign(claimReq(claimTx()));
    expect(w.vkey().hash().to_hex()).toBe(platform.pkh);
    expect(() => sign(req("fund-genesis", claimTx(), [feeIn(), fundIn()]))).toThrow(/does not mint exactly one fund NFT/);
  });

  it("PAIR claim: CARP output to ANOTHER address ⟹ throws; to the pinned beneficiary ⟹ signs", () => {
    const sign = createPlatformSigner(opts());
    expect(() => sign(claimReq(claimTx({ outputs: [contOut(), benOut(OTHER_ADDR, undefined), { address: FEE_ADDR }] }))))
      .toThrow(/not to the pinned beneficiary/);
    // Split: 10 to the beneficiary AND CARP to another address in the same tx.
    expect(() => sign(claimReq(claimTx({ outputs: [contOut(), benOut(), { ...benOut(OTHER_ADDR, undefined) }] }))))
      .toThrow(/not to the pinned beneficiary/);
    expect(() => sign(claimReq(claimTx()))).not.toThrow();
  });

  it("PAIR claim: beneficiary output with another datum ⟹ throws; two CARP outputs to the beneficiary ⟹ throws", () => {
    const sign = createPlatformSigner(opts());
    expect(() => sign(claimReq(claimTx({ outputs: [contOut(), benOut(BEN_ADDR, null), { address: FEE_ADDR }] }))))
      .toThrow(/datum other than the pinned one/);
    expect(() => sign(claimReq(claimTx({ outputs: [contOut(), benOut(BEN_ADDR, "d87980"), { address: FEE_ADDR }] }))))
      .toThrow(/datum other than the pinned one/);
    // Pair: the pinned datum ⟹ signs.
    expect(() => sign(claimReq(claimTx({ outputs: [contOut(), benOut(), { address: FEE_ADDR }] })))).not.toThrow();
    expect(() => sign(claimReq(claimTx({ outputs: [contOut(), benOut(), benOut()] })))).toThrow(/exactly one is required/);
  });

  it("PAIR claim: fund datum names ANOTHER beneficiary (config pin unchanged) ⟹ throws; another platform ⟹ throws", () => {
    const sign = createPlatformSigner(opts());
    expect(() => sign(claimReq(claimTx(), fundIn(fundDatum({ beneficiary: keyAddrData("7c".repeat(28)) })))))
      .toThrow(/beneficiary differs/);
    expect(() => sign(claimReq(claimTx(), fundIn(fundDatum({ beneficiary_datum: null }))))).toThrow(/beneficiary differs/);
    expect(() => sign(claimReq(claimTx(), fundIn(fundDatum({ platform: "77".repeat(28) }))))).toThrow(/another platform/);
    expect(() => sign(claimReq(claimTx(), fundIn(fundDatum())))).not.toThrow();
  });

  it("PAIR claim: another redeemer on the fund input (FundLock-shaped Constr 0 []) or no redeemer ⟹ throws", () => {
    const sign = createPlatformSigner(opts());
    expect(() => sign(claimReq(claimTx({ redeemer: { index: 1n, cbor: Data.to(new Constr(0, [])) } })))).toThrow(/FundClaim/);
    expect(() => sign(claimReq(claimTx({ redeemer: { index: 0n, cbor: CLAIM_REDEEMER.cbor } })))).toThrow(/FundClaim/);
    expect(() => sign(claimReq(claimTx({ redeemer: { index: 1n, cbor: fundClaimRedeemer(0n) } })))).toThrow(/FundClaim/);
    expect(() => sign(claimReq(claimTx({ redeemer: CLAIM_REDEEMER })))).not.toThrow();
  });

  it("claim: extra mint ⟹ throws; closing claim burning its own fund NFT ⟹ signs; burning while continuing ⟹ throws", () => {
    const sign = createPlatformSigner(opts());
    expect(() => sign(claimReq(claimTx({ mint: [[OTHER_POLICY, "bb".repeat(4), 1n]] })))).toThrow(/mints something other/);
    const closing = claimTx({
      mint: [[POLICY, NFT_NAME, -1n]],
      outputs: [{ ...benOut(), assets: [[CARP_UNIT, 100n]] }, { address: OTHER_ADDR, lovelace: 3_000_000n }, { address: FEE_ADDR }],
    });
    expect(() => sign(claimReq(closing))).not.toThrow();
    expect(() => sign(claimReq(claimTx({ mint: [[POLICY, NFT_NAME, -1n]] })))).toThrow(/mints something other/);
  });

  it("claim: two paid_fund inputs, or a fund input without datum ⟹ throws", () => {
    const sign = createPlatformSigner(opts());
    const second = `${"44".repeat(32)}#0`;
    expect(() => sign(req("fund-claim", claimTx({ inputs: [FEE_REF, FUND_REF, second] }),
      [feeIn(), fundIn(), { ...fundIn(), ref: second }]))).toThrow(/spends 2 paid_fund UTxOs/);
    expect(() => sign(claimReq(claimTx(), { ref: FUND_REF, address: FUND_ADDR }))).toThrow(/without datum or assets/);
  });

  it("PAIR claim: fee input at the platform key's address ⟹ throws even on a valid claim", () => {
    const sign = createPlatformSigner(opts());
    expect(() => sign(req("fund-claim", claimTx(), [feeIn(PLATFORM_ADDR), fundIn()]))).toThrow(/address of the platform key/);
    expect(() => sign(req("fund-claim", claimTx(), [feeIn(), fundIn()]))).not.toThrow();
  });

  it("claim without carp_unit / beneficiary in configuration ⟹ refused (fail closed)", () => {
    expect(() => createPlatformSigner(opts({ beneficiary: undefined }))(claimReq(claimTx()))).toThrow(/needs paid_fund/);
    expect(() => createPlatformSigner(opts({ carpUnit: undefined }))(claimReq(claimTx()))).toThrow(/needs paid_fund/);
  });

  it("PAIR claim: required_signers without the platform key hash ⟹ throws", () => {
    const sign = createPlatformSigner(opts());
    expect(() => sign(claimReq(claimTx({ signers: ["66".repeat(28)] })))).toThrow(/required_signers/);
    expect(() => sign(claimReq(claimTx({ signers: ["66".repeat(28), platform.pkh] })))).not.toThrow();
  });
});
