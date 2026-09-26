// tests/ownerAuth.test.ts — bản sao có nhãn của ProtocolUtils/src/ownerAuth.ts + mã hoá chủ vault.
// Run: npx vitest run ../tests/ownerAuth.test.ts (từ PrepaidGen/offchain)

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Data } from "@lucid-evolution/lucid";
import { OwnerCredentialSchema, type OwnerCredentialData } from "../offchain/src/types.js";
import {
  ownerRefOf,
  ownerRefFromPlutusData,
  sameOwner,
  resolveOwnerAuth,
  OwnerAuthError,
} from "../offchain/src/ownerAuth.js";

const OCS = OwnerCredentialSchema as unknown as OwnerCredentialData;
const MARK = "// ── THÂN ──";
const COPY = fileURLToPath(new URL("../offchain/src/ownerAuth.ts", import.meta.url));
const SOURCE = fileURLToPath(new URL("../../ProtocolUtils/src/ownerAuth.ts", import.meta.url));

/** Phần từ dòng mang dấu `── THÂN ──` tới hết tệp. Không có dấu thì NÉM, không trả rỗng. */
function body(path: string): string {
  const text = readFileSync(path, "utf8");
  const i = text.indexOf(MARK);
  if (i < 0) throw new Error(`không thấy dấu "${MARK}" trong ${path}`);
  return text.slice(i);
}

describe("bản sao có nhãn — thân trùng nguồn từng ký tự", () => {
  it("thân của bản sao == thân của ProtocolUtils/src/ownerAuth.ts", () => {
    const a = body(COPY);
    const b = body(SOURCE);
    // Không đọc được gì thì phép so hai chuỗi rỗng sẽ xanh — chặn trước.
    expect(b.length).toBeGreaterThan(1000);
    expect(a).toBe(b);
  });

  it("dòng đầu của bản sao khai nguồn + commit", () => {
    const first = readFileSync(COPY, "utf8").split("\n")[0]!;
    expect(first).toMatch(/BẢN SAO CÓ NHÃN/);
    expect(first).toMatch(/ProtocolUtils\/src\/ownerAuth\.ts/);
    expect(first).toMatch(/commit [0-9a-f]{7,}/);
  });
});

describe("OwnerCredentialSchema — mã hoá ghim theo blueprint", () => {
  const H = "ab".repeat(28);

  it("VerificationKey(h) = d8799f581c<h>ff", () => {
    expect(Data.to<OwnerCredentialData>({ VerificationKey: [H] }, OCS)).toBe(`d8799f581c${H}ff`);
  });

  it("CỰC ĐỐI — Script(h) = d87a9f581c<h>ff (cùng 28 byte, khác tag)", () => {
    expect(Data.to<OwnerCredentialData>({ Script: [H] }, OCS)).toBe(`d87a9f581c${H}ff`);
  });

  it("đọc thô trường owner: tag 0 → key, tag 1 → script", () => {
    expect(ownerRefFromPlutusData(Data.from(`d8799f581c${H}ff`))).toEqual({ type: "key", hash: H });
    expect(ownerRefFromPlutusData(Data.from(`d87a9f581c${H}ff`))).toEqual({ type: "script", hash: H });
  });

  it("ÂM — owner là pkh trần (lược đồ cũ) → NÉM OWNER_CREDENTIAL_SHAPE", () => {
    expect(() => ownerRefFromPlutusData(Data.from(`581c${H}`))).toThrow(/OWNER_CREDENTIAL_SHAPE/);
  });

  it("ÂM — lược đồ từ chối hash 27 byte", () => {
    expect(() => Data.to<OwnerCredentialData>({ VerificationKey: ["ab".repeat(27)] }, OCS)).toThrow();
  });

  it("khoá và script trùng 28 byte là HAI chủ khác nhau", () => {
    const k = ownerRefOf({ VerificationKey: [H] });
    const s = ownerRefOf({ Script: [H] });
    expect(sameOwner(k, k)).toBe(true);
    expect(sameOwner(k, s)).toBe(false);
  });

  it("chủ script mà không truyền OwnerAuth → NÉM, không bịa chứng từ", () => {
    expect(() => resolveOwnerAuth({ type: "script", hash: H })).toThrow(OwnerAuthError);
    expect(resolveOwnerAuth({ type: "key", hash: H })).toEqual({ kind: "key", pkh: H });
  });
});
