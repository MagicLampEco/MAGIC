// VaultTxAPI/tests/platformSigner.test.ts — the one module that holds key material, measured in PAIRS:
// every red case sits next to the green case that differs from it in exactly one input.
//
// Test keys are generated in memory with `node:crypto` and encoded as bech32 `ed25519_sk…` — the same
// shape as the production value. No real key is read anywhere.

import { generateKeyPairSync, type KeyObject } from "node:crypto";

import { CML, credentialToAddress } from "@lucid-evolution/lucid";
import { bech32 } from "bech32";
import { describe, expect, it } from "vitest";

import * as signerModule from "../src/platformSigner.js";
import { createPlatformSigner } from "../src/platformSigner.js";

const POLICY = "ab".repeat(28);
const OTHER_POLICY = "cd".repeat(28);

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

/** Minimal transaction: one input, one output, optional mint, optional required signers. */
function bareTx(o: { mint?: Array<[string, string, bigint]>; signers?: string[] }): CML.Transaction {
  const ins = CML.TransactionInputList.new();
  ins.add(CML.TransactionInput.new(CML.TransactionHash.from_hex("11".repeat(32)), 0n));
  const outs = CML.TransactionOutputList.new();
  const addr = credentialToAddress("Preprod", { type: "Key", hash: "22".repeat(28) });
  outs.add(CML.TransactionOutput.new(CML.Address.from_bech32(addr), CML.Value.from_coin(2_000_000n)));
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
  return CML.Transaction.new(body, CML.TransactionWitnessSet.new(), true);
}

const platform = newKey();
const opts = (over: Partial<Parameters<typeof createPlatformSigner>[0]> = {}) => ({
  keyBech32: platform.sk, expectedPkh: platform.pkh, paidFundPolicy: POLICY, tokenValues: ["api-token", "sponsor-token"], ...over,
});
const goodTx = () => bareTx({ mint: [[POLICY, "aa".repeat(32), 1n]], signers: [platform.pkh] });

describe("platformSigner — the only key the service holds", () => {
  it("module exports exactly one runtime symbol: createPlatformSigner", () => {
    expect(Object.keys(signerModule).sort()).toEqual(["createPlatformSigner"]);
  });

  it("PAIR right key ⟹ vkey witness of the platform key, valid signature over the body hash (and NOT over another message)", () => {
    const sign = createPlatformSigner(opts());
    const tx = goodTx();
    const w = sign(tx);
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
    expect(() => sign(bareTx({ signers: [platform.pkh] }))).toThrow(/does not mint exactly one fund NFT/);
    expect(() => sign(goodTx())).not.toThrow();
  });

  it("mint under ANOTHER policy, mint of 2, or two assets under paid_fund ⟹ sign throws", () => {
    const sign = createPlatformSigner(opts());
    expect(() => sign(bareTx({ mint: [[OTHER_POLICY, "aa".repeat(32), 1n]], signers: [platform.pkh] }))).toThrow(/fund NFT/);
    expect(() => sign(bareTx({ mint: [[POLICY, "aa".repeat(32), 2n]], signers: [platform.pkh] }))).toThrow(/fund NFT/);
    expect(() => sign(bareTx({ mint: [[POLICY, "aa".repeat(32), 1n], [POLICY, "bb".repeat(32), 1n]], signers: [platform.pkh] })))
      .toThrow(/fund NFT/);
    expect(() => sign(bareTx({ mint: [[POLICY, "aa".repeat(32), -1n]], signers: [platform.pkh] }))).toThrow(/fund NFT/);
  });

  it("PAIR required_signers WITHOUT the platform key hash ⟹ sign throws; with it ⟹ signs", () => {
    const sign = createPlatformSigner(opts());
    const other = newKey();
    expect(() => sign(bareTx({ mint: [[POLICY, "aa".repeat(32), 1n]], signers: [other.pkh] }))).toThrow(/required_signers/);
    expect(() => sign(bareTx({ mint: [[POLICY, "aa".repeat(32), 1n]] }))).toThrow(/required_signers/);
    expect(() => sign(bareTx({ mint: [[POLICY, "aa".repeat(32), 1n]], signers: [other.pkh, platform.pkh] }))).not.toThrow();
  });
});
