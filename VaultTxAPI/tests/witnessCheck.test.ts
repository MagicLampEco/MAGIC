// Ca CẶP cho cổng chữ ký của `/tx/submit` (`src/witnessCheck.ts`): chữ ký đúng qua; chữ ký rác
// và thiếu một required_signer bị 400 có mã.
import { describe, expect, it } from "vitest";
import { CML } from "@lucid-evolution/lucid";

import { assertWitnessesCoverTx } from "../src/witnessCheck.js";
import { CodedApiError } from "../src/errors.js";

function makeTx(required: CML.PublicKey[]): CML.Transaction {
  const inputs = CML.TransactionInputList.new();
  inputs.add(CML.TransactionInput.new(CML.TransactionHash.from_hex("11".repeat(32)), 0n));
  const body = CML.TransactionBody.new(inputs, CML.TransactionOutputList.new(), 170_000n);
  if (required.length > 0) {
    const rs = CML.Ed25519KeyHashList.new();
    for (const pk of required) rs.add(pk.hash());
    body.set_required_signers(rs);
  }
  return CML.Transaction.new(body, CML.TransactionWitnessSet.new(), true);
}

function witnessSet(tx: CML.Transaction, keys: CML.PrivateKey[], tamper = false): CML.TransactionWitnessSet {
  const hash = CML.hash_transaction(tx.body());
  const list = CML.VkeywitnessList.new();
  for (const sk of keys) {
    const msg = hash.to_raw_bytes();
    if (tamper) msg[0] = msg[0]! ^ 0xff; // ký lên một thông điệp KHÁC body hash
    list.add(CML.Vkeywitness.new(sk.to_public(), sk.sign(msg)));
  }
  const ws = CML.TransactionWitnessSet.new();
  ws.set_vkeywitnesses(list);
  return ws;
}

function codeOf(f: () => unknown): string | undefined {
  try { f(); return undefined; } catch (e) { return e instanceof CodedApiError ? e.code : `other:${(e as Error).message}`; }
}

describe("assertWitnessesCoverTx", () => {
  const a = CML.PrivateKey.generate_ed25519();
  const b = CML.PrivateKey.generate_ed25519();

  it("CẶP: chữ ký đúng của mọi required_signer ⟹ qua", () => {
    const tx = makeTx([a.to_public(), b.to_public()]);
    expect(codeOf(() => assertWitnessesCoverTx(tx, witnessSet(tx, [a, b])))).toBeUndefined();
  });

  it("CẶP: chữ ký rác (ký lên thông điệp khác) ⟹ 400 WITNESS_SIGNATURE_INVALID", () => {
    const tx = makeTx([a.to_public()]);
    expect(codeOf(() => assertWitnessesCoverTx(tx, witnessSet(tx, [a], true)))).toBe("WITNESS_SIGNATURE_INVALID");
  });

  it("CẶP: thiếu một required_signer ⟹ 400 WITNESS_MISSING_SIGNER", () => {
    const tx = makeTx([a.to_public(), b.to_public()]);
    expect(codeOf(() => assertWitnessesCoverTx(tx, witnessSet(tx, [a])))).toBe("WITNESS_MISSING_SIGNER");
  });

  it("chữ ký đúng của khoá KHÔNG bắt buộc mà thiếu khoá bắt buộc ⟹ vẫn 400", () => {
    const tx = makeTx([a.to_public()]);
    expect(codeOf(() => assertWitnessesCoverTx(tx, witnessSet(tx, [b])))).toBe("WITNESS_MISSING_SIGNER");
  });
});
