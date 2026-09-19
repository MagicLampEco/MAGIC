// MagicSDK/tests/refScript.test.ts — cổng CIP-33.
//
// ══ BÀI GHIM QUAN TRỌNG NHẤT CỦA TỆP NÀY ══════════════════════════════════════
// `ref UTxO mang script KHÁC thì NÉM`. Đây là chỗ hỏng im lặng: `readFrom` một
// UTxO sai vẫn dựng ra một giao dịch hợp lệ về hình dạng, `complete()` không kêu,
// và nó chết trên chuỗi SAU KHI người dùng đã ký. Người dùng thấy màn ký bình
// thường, ký, rồi nhận một lỗi không trỏ về đâu.
//
// Cổng chỉ kiểm "có scriptRef hay không" thì KHÔNG bắt được ca đó — và đó đúng là
// cổng mà ai cũng viết đầu tiên. Nên hai bài dưới đi THÀNH CẶP: một ca thiếu hẳn
// scriptRef, một ca CÓ scriptRef nhưng sai script. Bỏ bài thứ hai thì cổng tụt về
// mức không phân biệt được hai cực.
//
// ══ VÀ MỘT TÍNH CHẤT NGƯỢC DẤU, CŨNG PHẢI GHIM ════════════════════════════════
// Đường chạy thật phụ thuộc vào việc cùng một script ở HAI MỨC BỌC CBOR khác nhau
// cho CÙNG một hash — `vaultScript` cục bộ đến từ `applyParamsToScript`, còn
// `refUtxo.scriptRef` đến từ provider, và hai nguồn đó không hứa cùng mức bọc.
// Không ghim tính chất đó thì một lần viết lại đổi `validatorToScriptHash(...)`
// thành so chuỗi `ref.script === script.script` sẽ XANH TRỌN BỘ rồi hỏng ngay ở
// ca thật đầu tiên. Bài `cùng script, hai mức bọc` bên dưới là chỗ canh nó.
// ══════════════════════════════════════════════════════════════════════════════

import {
  CBOREncodingLevel, validatorToScriptHash,
  type UTxO, type Validator,
} from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";

import {
  assertRefScriptMatches, assertRefScriptsMatchAll,
  resolveRefScript, ACCEPT_INLINE_SCRIPT_CEILING,
} from "../src/refScript.js";

// Hai script KHÁC NHAU, và cả hai GIẢI MÃ ĐƯỢC — xem bài tự kiểm fixture đầu tiên.
const INNER_A = "010000222220";
const SCRIPT_A_SINGLE: Validator = { type: "PlutusV3", script: `46${INNER_A}` };
const SCRIPT_A_DOUBLE: Validator = { type: "PlutusV3", script: `4746${INNER_A}` };
const SCRIPT_B: Validator = { type: "PlutusV3", script: "49480100002221200101" };

const REF = "aa".repeat(32);

function utxo(scriptRef: Validator | null, outputIndex = 0): UTxO {
  return {
    txHash: REF, outputIndex,
    address: "addr_test1wqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahga0t3ee",
    assets: { lovelace: 20_000_000n },
    datum: null, datumHash: null,
    scriptRef,
  } as UTxO;
}

describe("fixture tự kiểm", () => {
  it("hai script mẫu KHÁC hash — nếu không thì mọi bài dưới vô nghĩa", () => {
    // Ca xanh ở cả hai cực thì nó không kiểm gì. Đây là phép kiểm CHÍNH fixture.
    expect(validatorToScriptHash(SCRIPT_A_DOUBLE))
      .not.toBe(validatorToScriptHash(SCRIPT_B));
  });

  it("🔴 cả hai script mẫu GIẢI MÃ ĐƯỢC — không phải bytes cụt lọt qua nhánh dự phòng", () => {
    // Bản trước của tệp này dùng một chuỗi mà header CBOR khai 2 037 byte trong
    // khi nội dung chỉ có 240 — script bị cắt cụt. Nó vẫn ra hash, vì
    // `applyDoubleCborEncoding` rơi vào nhánh "bọc thô hai lần" khi không giải mã
    // nổi. Tức fixture đang đi một đường mã KHÁC đường mà đời thật đi, và không
    // bài nào kêu. `CBOREncodingLevel` ném ở đúng ca đó, nên nó là phép đo đúng.
    expect(CBOREncodingLevel(SCRIPT_A_SINGLE.script)).toBe("single");
    expect(CBOREncodingLevel(SCRIPT_A_DOUBLE.script)).toBe("double");
    expect(CBOREncodingLevel(SCRIPT_B.script)).toBe("double");
  });
});

describe("assertRefScriptMatches", () => {
  it("đúng script thì cho qua, và trả về chính UTxO đó để dùng trong readFrom", () => {
    const u = utxo(SCRIPT_A_DOUBLE);
    expect(assertRefScriptMatches(u, SCRIPT_A_DOUBLE, "vault")).toBe(u);
  });

  it("🔴 cùng script, HAI MỨC BỌC CBOR khác nhau ⟹ vẫn cho qua", () => {
    // Đây là tính chất đường chạy thật dựa vào, KHÔNG phải một ca biên hiếm gặp:
    // script cục bộ và scriptRef từ provider không hứa cùng mức bọc. Một phép so
    // chuỗi thô sẽ ném ở đây trong khi hai bên là CÙNG một script.
    expect(SCRIPT_A_SINGLE.script).not.toBe(SCRIPT_A_DOUBLE.script);
    expect(() => assertRefScriptMatches(utxo(SCRIPT_A_SINGLE), SCRIPT_A_DOUBLE, "vault"))
      .not.toThrow();
    expect(() => assertRefScriptMatches(utxo(SCRIPT_A_DOUBLE), SCRIPT_A_SINGLE, "vault"))
      .not.toThrow();
  });

  it("🔴 UTxO KHÔNG mang scriptRef thì NÉM — không im lặng đọc từ nó", () => {
    expect(() => assertRefScriptMatches(utxo(null), SCRIPT_A_DOUBLE, "vault"))
      .toThrow(/REFSCRIPT-001/);
  });

  it("🔴 UTxO mang script KHÁC thì NÉM — ca hỏng im lặng, cổng đếm-suông không bắt được", () => {
    expect(() => assertRefScriptMatches(utxo(SCRIPT_B), SCRIPT_A_DOUBLE, "vault"))
      .toThrow(/REFSCRIPT-002/);
  });

  it("🔴 cùng bytes nhưng KHÁC đời Plutus thì NÉM — V2 và V3 là hai script khác", () => {
    const v2: Validator = { type: "PlutusV2", script: SCRIPT_B.script };
    expect(validatorToScriptHash(v2)).not.toBe(validatorToScriptHash(SCRIPT_B));
    expect(() => assertRefScriptMatches(utxo(v2), SCRIPT_B, "vault"))
      .toThrow(/REFSCRIPT-002/);
  });

  it("🔴 scriptRef có `type` lucid không hiểu ⟹ REFSCRIPT-003, KHÔNG để lọt lỗi trần của lucid", () => {
    const weird = { type: "PlutusV4", script: SCRIPT_B.script } as unknown as Validator;
    let msg = "";
    try { assertRefScriptMatches(utxo(weird), SCRIPT_B, "vault (WithdrawLamp)"); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/REFSCRIPT-003/);
    // Cái mà bản trước đánh rơi: txHash và tên chỗ gọi. Fail-closed vẫn đúng,
    // nhưng người đọc log không biết UTxO nào và nhánh nào.
    expect(msg).toContain(REF);
    expect(msg).toContain("WithdrawLamp");
  });

  it("câu lỗi in CẢ HAI hash — người đọc phải đối chiếu được, không phải đoán", () => {
    let msg = "";
    try { assertRefScriptMatches(utxo(SCRIPT_B), SCRIPT_A_DOUBLE, "vault"); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toContain(validatorToScriptHash(SCRIPT_A_DOUBLE));
    expect(msg).toContain(validatorToScriptHash(SCRIPT_B));
  });

  it("câu lỗi nêu tên chỗ gọi — `vault (WithdrawLamp)` khác `vault (UpdateProfile)`", () => {
    expect(() => assertRefScriptMatches(utxo(null), SCRIPT_A_DOUBLE, "vault (WithdrawLamp)"))
      .toThrow(/WithdrawLamp/);
  });
});

describe("assertRefScriptsMatchAll — ca nhiều script (ScheduleGen tiêu vault + shard)", () => {
  it("🔴 phủ theo TẬP, không theo chỉ số — đảo thứ tự vẫn cho qua", () => {
    // Chỗ gọi nhận danh sách từ cấu hình hoặc từ keeper; không gì bảo đảm thứ tự.
    // Ghép theo chỉ số là dựng ra một phép kiểm ĐỎ khi hai script chỉ đổi chỗ, và
    // XANH khi chúng bị ghép nhầm cặp — sai cả hai chiều.
    const pair = [utxo(SCRIPT_B, 1), utxo(SCRIPT_A_DOUBLE, 0)];
    expect(() => assertRefScriptsMatchAll(pair, [
      { script: SCRIPT_A_DOUBLE, what: "vault" },
      { script: SCRIPT_B,        what: "shard" },
    ])).not.toThrow();
  });

  it("🔴 thiếu MỘT script thì NÉM, và câu lỗi nêu ĐÚNG cái thiếu", () => {
    let msg = "";
    try {
      assertRefScriptsMatchAll([utxo(SCRIPT_A_DOUBLE)], [
        { script: SCRIPT_A_DOUBLE, what: "vault (ScheduleFire)" },
        { script: SCRIPT_B,        what: "shard (ScheduleFire)" },
      ]);
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/REFSCRIPT-002/);
    expect(msg).toContain("shard (ScheduleFire)");
    expect(msg).not.toContain("vault (ScheduleFire)");
  });

  it("🔴 danh sách RỖNG mà vẫn đòi script thì NÉM — không đọc thành 'không có gì để kiểm'", () => {
    expect(() => assertRefScriptsMatchAll([], [{ script: SCRIPT_B, what: "vault" }]))
      .toThrow(/REFSCRIPT-002/);
  });
});

describe("resolveRefScript — đường inline phải được CHỌN, không được mặc định", () => {
  it("hằng chấp-nhận-trần trả `null` ⟹ chỗ gọi đi đường inline", () => {
    expect(resolveRefScript(ACCEPT_INLINE_SCRIPT_CEILING, SCRIPT_B, "vault")).toBeNull();
  });

  it("UTxO thì vẫn qua đúng cổng hash — hằng kia KHÔNG nới lỏng gì", () => {
    const u = utxo(SCRIPT_B);
    expect(resolveRefScript(u, SCRIPT_B, "vault")).toBe(u);
    expect(() => resolveRefScript(utxo(SCRIPT_A_DOUBLE), SCRIPT_B, "vault"))
      .toThrow(/REFSCRIPT-002/);
  });
});
