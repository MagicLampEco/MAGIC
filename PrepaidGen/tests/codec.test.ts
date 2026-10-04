// tests/codec.test.ts — thứ tự mã hoá Plutus Data phải khớp Aiken ↔ TypeScript
//
// Đây là loại lỗi im lặng nhất trong hệ: đổi thứ tự một trường ở một bên thì
// mọi thứ vẫn biên dịch, vẫn chạy test đơn lẻ, và chỉ hỏng khi giải mã trên
// chuỗi. Test này đọc types.ak, rút thứ tự THẬT bên Aiken, so với bảng thứ tự
// khai báo trong types.ts.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Data } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";
import {
  DID_COMMIT_BYTES,
  FUND_REDEEMER_ORDER,
  MAGIC_BATCH_FIELDS,
  PAID_FUND_DATUM_FIELDS,
  PREPAID_CREDIT_FIELDS,
  PREPAID_VAULT_DATUM_FIELDS,
  CLOSE_SPONSORED_LINE_CONSTR,
  type PrepaidVaultRedeemer,
  PrepaidVaultRedeemerSchema,
  SET_DID_COMMIT_CONSTR,
  SETTLE_LINE_CONSTR,
  VAULT_ATTRIBUTION_FIELDS,
  VAULT_ID_REDEEMER_ORDER,
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

  it("PrepaidVaultIdRedeemer", () => {
    expect(enumVariants("PrepaidVaultIdRedeemer")).toEqual([
      ...VAULT_ID_REDEEMER_ORDER,
    ]);
  });

  // `seed` là một OutputReference (constr), KHÔNG phải tx hash trần. Tên tài sản
  // là blake2b_256(cbor.serialise(seed)) nên sai hình dạng ⇒ sai tên ⇒ giao dịch
  // dựng được nhưng chết lúc submit.
  it("seed của MintVaultId là OutputReference, không phải ByteArray", () => {
    const body = typeBody("PrepaidVaultIdRedeemer");
    expect(body).toMatch(/MintVaultId\s*\{\s*seed\s*:\s*OutputReference\s*\}/);
  });

  // Đóng đường đốt: `types.ak` khai rằng redeemer này KHÔNG có nhánh thứ hai, và
  // on-chain `validate_mint_vault_id` ép `quantity_of(tx.mint, …) == 1`. Thêm một
  // nhánh bên TS là dựng ra constr 1 mà on-chain không có.
  it("PrepaidVaultIdRedeemer có ĐÚNG một nhánh (không có đường đốt)", () => {
    expect(enumVariants("PrepaidVaultIdRedeemer")).toHaveLength(1);
  });

  it("BurnBatch nằm ĐÚNG constr 2 — ConsumeMAGIC ghim burn_batch_constr (§7.3)", () => {
    expect(enumVariants("PrepaidVaultRedeemer").indexOf("BurnBatch")).toBe(
      BURN_BATCH_CONSTR,
    );
    expect(VAULT_REDEEMER_ORDER.indexOf("BurnBatch")).toBe(BURN_BATCH_CONSTR);
  });

  // ── SetDidCommit: thêm 2026-09-15, CHỈ THÊM Ở CUỐI ──────────────────────
  //
  // Ba phép dưới đây đo ba thứ KHÁC NHAU, và chỉ phép thứ ba đo được thứ thật sự
  // đi lên chuỗi. Bảng `VAULT_REDEEMER_ORDER` là một mảng chữ do người gõ; lược
  // đồ `PrepaidVaultRedeemerSchema` mới là thứ Lucid dùng để mã hoá. Hai cái đó
  // lệch được mà không gì đỏ — nên phải ép cả hai, rồi ép byte thật.
  it("SetDidCommit nằm ĐÚNG constr 5 ở cả Aiken lẫn bảng thứ tự TypeScript", () => {
    expect(enumVariants("PrepaidVaultRedeemer").indexOf("SetDidCommit")).toBe(
      SET_DID_COMMIT_CONSTR,
    );
    expect(VAULT_REDEEMER_ORDER.indexOf("SetDidCommit")).toBe(SET_DID_COMMIT_CONSTR);
  });

  it("sáu chỉ số cũ KHÔNG dịch khi thêm nhánh mới", () => {
    const ak = enumVariants("PrepaidVaultRedeemer");
    expect(ak.slice(0, 6)).toEqual([
      "PrepaidLock",
      "PrepaidDraw",
      "BurnBatch",
      "PrunePrepaid",
      "SetDelegate",
      "SetDidCommit",
    ]);
    // Nhánh mới phải là nhánh CUỐI — thêm ở cuối thì sáu chỉ số trên đứng yên
    // theo cấu trúc, không theo kỷ luật của người thêm.
    expect(ak[SETTLE_LINE_CONSTR]).toBe("SettleLine");
    expect(ak).toHaveLength(CLOSE_SPONSORED_LINE_CONSTR + 1);
    expect(ak[CLOSE_SPONSORED_LINE_CONSTR]).toBe("CloseSponsoredLine");
  });

  // ── SettleLine: thêm 2026-09-28, CHỈ THÊM Ở CUỐI ────────────────────────
  it("SettleLine nằm ĐÚNG constr 6 ở cả Aiken lẫn bảng thứ tự TypeScript", () => {
    expect(enumVariants("PrepaidVaultRedeemer").indexOf("SettleLine")).toBe(
      SETTLE_LINE_CONSTR,
    );
    expect(VAULT_REDEEMER_ORDER.indexOf("SettleLine")).toBe(SETTLE_LINE_CONSTR);
  });

  // Byte THẬT: constr 6 ⟹ thẻ CBOR 121+6 = 127 ⟹ tiền tố `d87f`. Đây là chỉ số
  // CUỐI CÙNG trong họ thẻ 121..127 — nhánh thứ tám (constr 7) dùng thẻ
  // 1280+(i−7) = 1280 ⟹ `d9 05 00` (bài `CloseSponsoredLine` ngay dưới đo byte đó).
  // Constr 7..127 là họ 1280..1400; từ 128 là dạng chung thẻ 102.
  it("Data.to(SettleLine) mã hoá ra thẻ constr 6 (`d87f`)", () => {
    const schema = PrepaidVaultRedeemerSchema as unknown as PrepaidVaultRedeemer;
    const hex = Data.to({ SettleLine: { fund_id: "ab".repeat(28) } }, schema);
    expect(hex.startsWith("d87f")).toBe(true);
    // Đối chứng ở hàng xóm: SetDidCommit vẫn constr 5 ⟹ `d87e`. Thiếu vế này
    // thì bài vẫn xanh khi CẢ HAI nhánh cùng dịch một bậc.
    const sd = Data.to(
      { SetDidCommit: { did_commit: "ab".repeat(DID_COMMIT_BYTES) } },
      schema,
    );
    expect(sd.startsWith("d87e")).toBe(true);
  });

  // ── CloseSponsoredLine: thêm 2026-10-04, CHỈ THÊM Ở CUỐI ────────────────
  it("CloseSponsoredLine nằm ĐÚNG constr 7 ở cả Aiken lẫn bảng thứ tự TypeScript", () => {
    expect(enumVariants("PrepaidVaultRedeemer").indexOf("CloseSponsoredLine")).toBe(
      CLOSE_SPONSORED_LINE_CONSTR,
    );
    expect(VAULT_REDEEMER_ORDER.indexOf("CloseSponsoredLine")).toBe(CLOSE_SPONSORED_LINE_CONSTR);
  });

  // Byte THẬT, đối chiếu với chính bảng thẻ Plutus Data (không suy tiếp dãy d87x):
  //   constr i ∈ [0,6]   ⟹ thẻ 121+i      (`d879`..`d87f`)
  //   constr i ∈ [7,127] ⟹ thẻ 1280+(i−7) (`d90500`..)
  // Bảng được dựng TỪ công thức rồi so với byte Lucid sinh ra cho từng nhánh của lược
  // đồ — nên một nhánh dịch chỗ, hoặc Lucid đổi cách mã hoá constr ≥ 7, đều đỏ.
  it("Data.to(CloseSponsoredLine) mã hoá ra thẻ 1280 (`d90500`) · cực đối: nhánh cũ giữ thẻ cũ", () => {
    const schema = PrepaidVaultRedeemerSchema as unknown as PrepaidVaultRedeemer;
    const tagHex = (i: number): string => {
      const tag = i <= 6 ? 121 + i : 1280 + (i - 7);
      return tag < 256 ? "d8" + tag.toString(16).padStart(2, "0") : "d9" + tag.toString(16).padStart(4, "0");
    };
    expect(tagHex(CLOSE_SPONSORED_LINE_CONSTR)).toBe("d90500");
    const fid = "ab".repeat(32);
    const samples: Record<string, PrepaidVaultRedeemer> = {
      PrepaidLock: { PrepaidLock: { fund_id: fid, amount_carpdrop: 1n } },
      PrepaidDraw: { PrepaidDraw: { fund_id: fid, amount_carpdrop: 1n } },
      BurnBatch: { BurnBatch: { burns: [] } },
      PrunePrepaid: "PrunePrepaid",
      SetDelegate: { SetDelegate: { new_delegate: null } },
      SetDidCommit: { SetDidCommit: { did_commit: fid } },
      SettleLine: { SettleLine: { fund_id: fid } },
      CloseSponsoredLine: { CloseSponsoredLine: { fund_id: fid } },
    };
    expect(Object.keys(samples)).toEqual([...VAULT_REDEEMER_ORDER]);
    VAULT_REDEEMER_ORDER.forEach((name, i) => {
      expect(Data.to(samples[name]!, schema).startsWith(tagHex(i)), name).toBe(true);
    });
    // Byte trọn của nhánh mới: thẻ 1280 · mảng vô hạn 1 phần tử · ByteArray 32.
    expect(Data.to(samples.CloseSponsoredLine!, schema)).toBe("d905009f5820" + fid + "ff");
    // Cực đối: SettleLine KHÔNG ra thẻ 1280 — bài không xanh khi hai nhánh trùng thẻ.
    expect(Data.to(samples.SettleLine!, schema).startsWith("d90500")).toBe(false);
  });

  // Byte THẬT, không phải bảng chữ. Plutus Data mã hoá constructor i ∈ [0,6] bằng
  // thẻ CBOR 121+i, nên constr 5 ⟹ 126 ⟹ tiền tố `d87e`. Nếu ai chèn nhánh mới
  // vào giữa mảng `Data.Enum`, chuỗi này đổi và bài đỏ ngay — trong khi mọi phép
  // kiểm kiểu của TypeScript vẫn xanh.
  //
  // Chữ `as unknown as PrepaidVaultRedeemer` là idiom BẮT BUỘC của Lucid 0.4.x,
  // đã ghi ở `ConsumeMAGIC/offchain/src/types.ts` cạnh `encodeEngageDatum`:
  // `Data.to(value, Schema)` suy kiểu tham số thứ hai từ tham số thứ nhất, nên
  // truyền lược đồ vào thẳng thì `tsc` đòi tham số MỘT phải là lược đồ.
  //
  // Và phép ép có cái giá của nó, nói thẳng ra vì nó không tự khai: sau khi ép,
  // `tsc` KHÔNG còn đối chiếu tham số thứ nhất với lược đồ nữa — một tên nhánh
  // gõ sai ở đây sẽ biên dịch trót lọt. Cái bù lại là phép so thẻ CBOR ngay dưới:
  // nhánh sai thì thẻ sai, và bài này đỏ. Đó đúng là lý do bài này đo BYTE chứ
  // không đo bảng chữ — nên chỗ mất là chỗ vốn đã không được tin.
  it("Data.to(SetDidCommit) mã hoá ra thẻ constr 5 (`d87e`)", () => {
    const schema = PrepaidVaultRedeemerSchema as unknown as PrepaidVaultRedeemer;
    const hex = Data.to({ SetDidCommit: { did_commit: "ab".repeat(DID_COMMIT_BYTES) } }, schema);
    expect(hex.startsWith("d87e")).toBe(true);
    // Đối chứng ở hàng xóm: SetDelegate vẫn là constr 4 ⟹ thẻ 125 ⟹ `d87d`.
    // Không có vế này thì bài trên xanh cả khi CẢ HAI nhánh cùng dịch một bậc.
    const del = Data.to({ SetDelegate: { new_delegate: null } }, schema);
    expect(del.startsWith("d87d")).toBe(true);
  });

  it("chữ ký BurnBatch giữ nguyên List<(ByteArray, Int)> để consume.ak giải mã được", () => {
    const body = typeBody("PrepaidVaultRedeemer");
    expect(body).toMatch(/BurnBatch\s*\{\s*burns\s*:\s*List<\(ByteArray,\s*Natural\)>/);
  });
});

describe("hình dạng batch bám §4.1 canonical", () => {
  it("MagicBatch đúng 7 trường, không có initial_amount/halved kiểu bản cũ", () => {
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
