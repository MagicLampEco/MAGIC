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
// ══════════════════════════════════════════════════════════════════════════════

import { validatorToScriptHash, type UTxO, type Validator } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";

import { assertRefScriptMatches } from "../src/refScript.js";

/** Hai script KHÁC NHAU — chỉ cần khác bytes là khác hash. */
const SCRIPT_A: Validator = {
  type: "PlutusV3",
  script: "5907f5010100332323232323223225333004323232323253323300a3001300b375400226464a666018600260206ea8004540041860226024002601e6ea8c038c03cc03cc03c004526163006375a0024464a66601a600260120022a66601e60106ea800854008458595900cc8c8c8c8c008894ccc008cdc78010008a99980d99baf300c30093754a66601800a266ebcc02ccc00c0040088c8c008008c8c004004008894ccc008cdc78018008a4d2c601866646002446e1ccdc424014002a66601866ebcc01cc004c01cc024c01400454ccc02ccdd79817980180319810800a51005301230080021300700113001001001",
};
const SCRIPT_B: Validator = { type: "PlutusV3", script: "49480100002221200101" };

const REF = "aa".repeat(32);

function utxo(scriptRef: Validator | null): UTxO {
  return {
    txHash: REF, outputIndex: 0,
    address: "addr_test1wqvrwknagm22rwnrus2v0nagyknauff3jztknm3x2d9nahga0t3ee",
    assets: { lovelace: 20_000_000n },
    datum: null, datumHash: null,
    scriptRef,
  } as UTxO;
}

describe("assertRefScriptMatches", () => {
  it("hai script mẫu KHÁC hash — nếu không thì mọi bài dưới vô nghĩa", () => {
    // Ca xanh ở cả hai cực thì nó không kiểm gì. Đây là phép kiểm CHÍNH fixture.
    expect(validatorToScriptHash(SCRIPT_A)).not.toBe(validatorToScriptHash(SCRIPT_B));
  });

  it("đúng script thì cho qua, và trả về chính UTxO đó để dùng trong readFrom", () => {
    const u = utxo(SCRIPT_A);
    expect(assertRefScriptMatches(u, SCRIPT_A, "vault")).toBe(u);
  });

  it("🔴 UTxO KHÔNG mang scriptRef thì NÉM — không im lặng đọc từ nó", () => {
    expect(() => assertRefScriptMatches(utxo(null), SCRIPT_A, "vault"))
      .toThrow(/REFSCRIPT-001/);
  });

  it("🔴 UTxO mang script KHÁC thì NÉM — ca hỏng im lặng, cổng đếm-suông không bắt được", () => {
    expect(() => assertRefScriptMatches(utxo(SCRIPT_B), SCRIPT_A, "vault"))
      .toThrow(/REFSCRIPT-002/);
  });

  it("câu lỗi in CẢ HAI hash — người đọc phải đối chiếu được, không phải đoán", () => {
    let msg = "";
    try { assertRefScriptMatches(utxo(SCRIPT_B), SCRIPT_A, "vault"); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toContain(validatorToScriptHash(SCRIPT_A));
    expect(msg).toContain(validatorToScriptHash(SCRIPT_B));
  });

  it("câu lỗi nêu tên chỗ gọi — `vault (WithdrawLamp)` khác `vault (UpdateProfile)`", () => {
    expect(() => assertRefScriptMatches(utxo(null), SCRIPT_A, "vault (WithdrawLamp)"))
      .toThrow(/WithdrawLamp/);
  });
});
