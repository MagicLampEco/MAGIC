// Ca CẶP cho cổng chữ ký của `/tx/submit` (`src/witnessCheck.ts`): chữ ký đúng qua; chữ ký rác
// và thiếu một required_signer bị 400 có mã. Chữ ký là vector GHI SẴN (`fixtures/witnessVectors.ts`)
// — gói không sinh khoá, không ký (bất biến số một, `noSigningMaterial.test.ts`).
import { describe, expect, it } from "vitest";
import { CML } from "@lucid-evolution/lucid";

import { assertWitnessesCoverTx } from "../src/witnessCheck.js";
import { CodedApiError } from "../src/errors.js";
import {
  BODY_REQUIRES_A, BODY_REQUIRES_A_B, VKEY_A_HEX, VKEY_B_HEX, flipFirstByte, type WitnessVector,
} from "./fixtures/witnessVectors.js";

const vkey = (h: string): CML.PublicKey => CML.PublicKey.from_bytes(Buffer.from(h, "hex"));
const A = vkey(VKEY_A_HEX);
const B = vkey(VKEY_B_HEX);

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

/** Dựng tx rồi đòi thân của nó trùng đúng thân mà vector đã được ký — lệch là đỏ Ở ĐÂY, không đỏ mù ở cổng. */
function txFor(required: CML.PublicKey[], v: WitnessVector): CML.Transaction {
  const tx = makeTx(required);
  expect(CML.hash_transaction(tx.body()).to_hex(), "thân tx lệch vector ghi sẵn — sinh lại fixtures/witnessVectors.ts").toBe(v.bodyHash);
  return tx;
}

function witnessSet(pairs: Array<[CML.PublicKey, string]>): CML.TransactionWitnessSet {
  const list = CML.VkeywitnessList.new();
  for (const [pk, sig] of pairs) list.add(CML.Vkeywitness.new(pk, CML.Ed25519Signature.from_hex(sig)));
  const ws = CML.TransactionWitnessSet.new();
  ws.set_vkeywitnesses(list);
  return ws;
}

function codeOf(f: () => unknown): string | undefined {
  try { f(); return undefined; } catch (e) { return e instanceof CodedApiError ? e.code : `other:${(e as Error).message}`; }
}

describe("assertWitnessesCoverTx", () => {
  it("vector ghi sẵn tự khớp: chữ ký A, B xác minh được trên đúng bodyHash", () => {
    for (const v of [BODY_REQUIRES_A, BODY_REQUIRES_A_B]) {
      const msg = Buffer.from(v.bodyHash, "hex");
      expect(A.verify(msg, CML.Ed25519Signature.from_hex(v.sigA))).toBe(true);
      expect(B.verify(msg, CML.Ed25519Signature.from_hex(v.sigB))).toBe(true);
    }
  });

  it("CẶP: chữ ký đúng của mọi required_signer ⟹ qua", () => {
    const v = BODY_REQUIRES_A_B;
    const tx = txFor([A, B], v);
    expect(codeOf(() => assertWitnessesCoverTx(tx, witnessSet([[A, v.sigA], [B, v.sigB]])))).toBeUndefined();
  });

  it("CẶP: chữ ký rác (lật một bit) ⟹ 400 WITNESS_SIGNATURE_INVALID", () => {
    const v = BODY_REQUIRES_A;
    const tx = txFor([A], v);
    expect(codeOf(() => assertWitnessesCoverTx(tx, witnessSet([[A, flipFirstByte(v.sigA)]])))).toBe("WITNESS_SIGNATURE_INVALID");
  });

  it("CẶP: chữ ký hợp lệ nhưng của một thân KHÁC ⟹ 400 WITNESS_SIGNATURE_INVALID", () => {
    const tx = txFor([A], BODY_REQUIRES_A);
    expect(codeOf(() => assertWitnessesCoverTx(tx, witnessSet([[A, BODY_REQUIRES_A_B.sigA]])))).toBe("WITNESS_SIGNATURE_INVALID");
  });

  it("CẶP: thiếu một required_signer ⟹ 400 WITNESS_MISSING_SIGNER", () => {
    const v = BODY_REQUIRES_A_B;
    const tx = txFor([A, B], v);
    expect(codeOf(() => assertWitnessesCoverTx(tx, witnessSet([[A, v.sigA]])))).toBe("WITNESS_MISSING_SIGNER");
  });

  it("chữ ký đúng của khoá KHÔNG bắt buộc mà thiếu khoá bắt buộc ⟹ vẫn 400", () => {
    const v = BODY_REQUIRES_A;
    const tx = txFor([A], v);
    expect(codeOf(() => assertWitnessesCoverTx(tx, witnessSet([[B, v.sigB]])))).toBe("WITNESS_MISSING_SIGNER");
  });
});
