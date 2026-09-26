// tests/ownerAuth.test.ts — chính sách chủ = Credential (không Lucid).
//
// Phần bytes (Constr 0/1 [bytes 28]) KHÔNG kiểm ở đây: gói này không có bộ mã hoá. Mỗi gói
// có lược đồ Lucid tự mang cặp ca so bytes. Ở đây ghim hai thứ mà bytes không nói được:
// bộ dựng rẽ ĐÚNG nhánh, và không nhánh nào lặng lẽ đổi sang nhánh kia.
import { describe, it, expect } from "vitest";
import {
  applyOwnerAuth, resolveOwnerAuth, ownerCredential, ownerCredentialOf, ownerRefOf,
  ownerRefFromPlutusData, ownerInnerHash, sameOwner, assertHash28, OwnerAuthError,
  type OwnerAuth,
} from "../src/index.js";

const PKH = "ab".repeat(28);
const SH = "5c".repeat(28);

/** Giao dịch giả tối thiểu: chỉ ghi. */
class FakeTx {
  signers: string[] = [];
  withdrawals: string[] = [];
  addSignerKey(k: string): FakeTx { this.signers.push(k); return this; }
}

describe("ownerCredential / ownerRefOf — hai nhánh, không nhánh thứ ba", () => {
  it("key ⟹ {VerificationKey:[h]}, script ⟹ {Script:[h]}", () => {
    expect(ownerCredential("key", PKH)).toEqual({ VerificationKey: [PKH] });
    expect(ownerCredential("script", SH)).toEqual({ Script: [SH] });
    expect(ownerRefOf({ Script: [SH] })).toEqual({ type: "script", hash: SH });
    expect(ownerInnerHash({ VerificationKey: [PKH] })).toBe(PKH);
  });

  it("CỰC ĐỐI: pkh trần (hình dạng cũ) KHÔNG phải Credential ⟹ NÉM", () => {
    expect(() => ownerRefOf(PKH)).toThrow(/OWNER_CREDENTIAL_SHAPE/);
    expect(() => ownerRefOf({ Foo: [PKH] })).toThrow(/OWNER_CREDENTIAL_SHAPE/);
    expect(() => ownerRefOf({ VerificationKey: [PKH], Script: [SH] })).toThrow(/OWNER_CREDENTIAL_SHAPE/);
  });

  it("hash không đúng 28 byte ⟹ NÉM, không cắt không đệm", () => {
    expect(() => ownerCredential("key", "ab".repeat(27))).toThrow(/OWNER_HASH_INVALID/);
    expect(() => ownerCredential("script", "zz".repeat(28))).toThrow(/OWNER_HASH_INVALID/);
    expect(assertHash28(PKH.toUpperCase(), "x")).toBe(PKH);
  });

  it("ownerCredentialOf nhận cả OwnerAuth lẫn OwnerRef", () => {
    expect(ownerCredentialOf({ kind: "key", pkh: PKH })).toEqual({ VerificationKey: [PKH] });
    expect(ownerCredentialOf({ type: "script", hash: SH })).toEqual({ Script: [SH] });
  });
});

describe("ownerRefFromPlutusData — gương của `expect vault_owner: Credential`", () => {
  it("Constr 0 ⟹ key, Constr 1 ⟹ script", () => {
    expect(ownerRefFromPlutusData({ index: 0, fields: [PKH] })).toEqual({ type: "key", hash: PKH });
    expect(ownerRefFromPlutusData({ index: 1, fields: [SH] })).toEqual({ type: "script", hash: SH });
  });
  it("CỰC ĐỐI: bytes trần, tag 2, hai trường ⟹ NÉM", () => {
    expect(() => ownerRefFromPlutusData(PKH)).toThrow(/OWNER_CREDENTIAL_SHAPE/);
    expect(() => ownerRefFromPlutusData({ index: 2, fields: [PKH] })).toThrow(/OWNER_CREDENTIAL_SHAPE/);
    expect(() => ownerRefFromPlutusData({ index: 0, fields: [PKH, PKH] })).toThrow(/OWNER_CREDENTIAL_SHAPE/);
  });
});

describe("sameOwner — so CẢ tag lẫn hash", () => {
  it("cùng 28 byte, khác tag ⟹ KHÁC chủ", () => {
    expect(sameOwner({ type: "key", hash: PKH }, { type: "script", hash: PKH })).toBe(false);
    expect(sameOwner({ type: "key", hash: PKH }, { type: "key", hash: PKH.toUpperCase() })).toBe(true);
  });
});

describe("resolveOwnerAuth", () => {
  it("chủ khoá, không truyền auth ⟹ nhánh key với pkh từ datum", () => {
    expect(resolveOwnerAuth({ type: "key", hash: PKH })).toEqual({ kind: "key", pkh: PKH });
  });
  it("chủ script, không truyền auth ⟹ OWNER_SCRIPT_WITNESS_UNAVAILABLE (fail-closed)", () => {
    try {
      resolveOwnerAuth({ type: "script", hash: SH });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OwnerAuthError);
      expect((e as OwnerAuthError).code).toBe("OWNER_SCRIPT_WITNESS_UNAVAILABLE");
    }
  });
  it("auth khác tag (cùng 28 byte) ⟹ OWNER_AUTH_MISMATCH", () => {
    expect(() =>
      resolveOwnerAuth({ type: "script", hash: PKH }, { kind: "key", pkh: PKH }),
    ).toThrow(/OWNER_AUTH_MISMATCH/);
  });
  it("auth khớp ⟹ trả nguyên auth", () => {
    const a: OwnerAuth<FakeTx> = { kind: "script", hash: SH, attachWithdraw: (t) => t };
    expect(resolveOwnerAuth({ type: "script", hash: SH }, a)).toBe(a);
  });
});

describe("applyOwnerAuth — rẽ đúng nhánh", () => {
  it("key ⟹ addSignerKey(pkh), KHÔNG mục rút", () => {
    const tx = new FakeTx();
    applyOwnerAuth(tx, { kind: "key", pkh: PKH });
    expect(tx.signers).toEqual([PKH]);
    expect(tx.withdrawals).toEqual([]);
  });

  it("script ⟹ attachWithdraw ĐÚNG MỘT LẦN, KHÔNG addSignerKey(hash)", () => {
    const tx = new FakeTx();
    let calls = 0;
    const out = applyOwnerAuth(tx, {
      kind: "script",
      hash: SH,
      attachWithdraw: (t) => { calls++; t.withdrawals.push(SH); return t; },
    });
    expect(calls).toBe(1);
    expect(out).toBe(tx);
    expect(tx.signers).toEqual([]);
    expect(tx.withdrawals).toEqual([SH]);
  });

  it("CỰC ĐỐI: attachWithdraw trả undefined ⟹ NÉM, không đi tiếp với tx cũ", () => {
    const tx = new FakeTx();
    expect(() =>
      applyOwnerAuth(tx, {
        kind: "script",
        hash: SH,
        attachWithdraw: (() => undefined) as unknown as (t: FakeTx) => FakeTx,
      }),
    ).toThrow(/OWNER_WITHDRAW_RETURNED_NOTHING/);
  });
});
