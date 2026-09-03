// tests/codec.test.ts — thứ tự mã hoá Plutus Data phải khớp Aiken ↔ TypeScript
//
// Đây là loại lỗi im lặng nhất trong hệ: đổi thứ tự một trường ở một bên thì
// mọi thứ vẫn biên dịch, vẫn chạy test đơn lẻ, và chỉ hỏng khi giải mã trên
// chuỗi. Test này đọc types.ak, rút thứ tự THẬT bên Aiken, so với bảng thứ tự
// khai báo trong types.ts.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FUND_REDEEMER_ORDER,
  MAGIC_BATCH_FIELDS,
  PAID_FUND_DATUM_FIELDS,
  PREPAID_CREDIT_FIELDS,
  PREPAID_VAULT_DATUM_FIELDS,
  VAULT_ATTRIBUTION_FIELDS,
  VAULT_REDEEMER_ORDER,
} from "../offchain/src/types.js";
import { BURN_BATCH_CONSTR } from "../offchain/src/constants.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES_AK = resolve(HERE, "../onchain/lib/magiclamp/protocol/types.ak");
const SOURCE = readFileSync(TYPES_AK, "utf8");

/** Lấy phần thân `pub type <Name> { ... }` (khớp ngoặc ngoài cùng). */
function typeBody(name: string): string {
  const start = SOURCE.indexOf(`pub type ${name} {`);
  if (start < 0) throw new Error(`không tìm thấy type ${name} trong types.ak`);
  let depth = 0;
  for (let i = SOURCE.indexOf("{", start); i < SOURCE.length; i++) {
    if (SOURCE[i] === "{") depth++;
    else if (SOURCE[i] === "}") {
      depth--;
      if (depth === 0) return SOURCE.slice(SOURCE.indexOf("{", start) + 1, i);
    }
  }
  throw new Error(`ngoặc không cân ở type ${name}`);
}

function stripComments(s: string): string {
  return s
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** Thứ tự tên trường của một record type. */
function recordFields(name: string): string[] {
  const body = stripComments(typeBody(name));
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*([a-z_][a-z0-9_]*)\s*:/);
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}

/** Thứ tự tên nhánh của một enum type (constructor index = vị trí). */
function enumVariants(name: string): string[] {
  const body = stripComments(typeBody(name));
  const out: string[] = [];
  let depth = 0;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (depth === 0) {
      const m = line.match(/^([A-Z][A-Za-z0-9_]*)\s*(\{|$)/);
      if (m && m[1]) out.push(m[1]);
    }
    depth += (rawLine.match(/\{/g) ?? []).length;
    depth -= (rawLine.match(/\}/g) ?? []).length;
  }
  return out;
}

describe("thứ tự trường datum khớp Aiken", () => {
  it.each([
    ["MagicBatch", MAGIC_BATCH_FIELDS],
    ["PrepaidCredit", PREPAID_CREDIT_FIELDS],
    ["VaultAttribution", VAULT_ATTRIBUTION_FIELDS],
    ["PrepaidVaultDatum", PREPAID_VAULT_DATUM_FIELDS],
    ["PaidFundDatum", PAID_FUND_DATUM_FIELDS],
  ])("%s", (akName, tsFields) => {
    expect(recordFields(akName)).toEqual([...tsFields]);
  });
});

describe("constructor index redeemer khớp Aiken", () => {
  it("PrepaidVaultRedeemer", () => {
    expect(enumVariants("PrepaidVaultRedeemer")).toEqual([...VAULT_REDEEMER_ORDER]);
  });

  it("PaidFundRedeemer", () => {
    expect(enumVariants("PaidFundRedeemer")).toEqual([...FUND_REDEEMER_ORDER]);
  });

  it("BurnBatch nằm ĐÚNG constr 2 — ConsumeMAGIC ghim burn_batch_constr (§7.3)", () => {
    expect(enumVariants("PrepaidVaultRedeemer").indexOf("BurnBatch")).toBe(
      BURN_BATCH_CONSTR,
    );
    expect(VAULT_REDEEMER_ORDER.indexOf("BurnBatch")).toBe(BURN_BATCH_CONSTR);
  });

  it("chữ ký BurnBatch giữ nguyên List<(ByteArray, Int)> để consume.ak giải mã được", () => {
    const body = typeBody("PrepaidVaultRedeemer");
    expect(body).toMatch(/BurnBatch\s*\{\s*burns\s*:\s*List<\(ByteArray,\s*Natural\)>/);
  });
});

describe("hình dạng batch bám §4.1 canonical", () => {
  it("đúng 7 trường, không có initial_amount/halved kiểu bản cũ", () => {
    const f = recordFields("MagicBatch");
    expect(f).toHaveLength(7);
    expect(f).not.toContain("initial_amount");
    expect(f).not.toContain("halved");
  });

  it("vault PrepaidGen không mang trường LAMP nào (C-PP-14)", () => {
    const f = recordFields("PrepaidVaultDatum").join(" ");
    expect(f).not.toMatch(/lamp/i);
    expect(f).not.toMatch(/loyalty/i);
  });
});
