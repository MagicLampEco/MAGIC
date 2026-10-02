// `validityInEpoch` — cửa sổ phải chứa tip theo SLOT (ttl loại trừ), và hai cận cùng kỳ.
// Trọng tài: quy hai cận về giây bằng phép sàn như sổ cái, đòi slot(from) ≤ slot(now) < slot(to),
// rồi đọc lại kỳ của hai cận bằng `epochOfValidity` (gương của validator).
import { describe, expect, it } from "vitest";
import { epochOfValidity, validityInEpoch } from "../offchain/src/tx/window.js";

const O = 1_654_041_600_000n; // gốc cửa sổ Preprod
const P = 432_000_000n;
const K = 316n; // kỳ Preprod theo gốc O, 2026-10-02
const START = O + K * P;
const END = START + P;

function ledgerAccepts(nowMs: bigint) {
  const v = validityInEpoch(nowMs, P, O);
  const s = (ms: bigint) => ms / 1_000n;
  expect(s(v.fromMs) <= s(nowMs)).toBe(true);
  expect(s(nowMs) < s(v.toMs)).toBe(true);
  expect(epochOfValidity(v, P, O)).toBe(K);
  return v;
}

describe("validityInEpoch — biên slot", () => {
  it("tip giữa kỳ: cửa sổ chứa tip, cùng kỳ", () => {
    ledgerAccepts(START + P / 2n);
  });

  it("tip còn 2 giây tới mốc kẹp cuối: vẫn chứa tip", () => {
    ledgerAccepts(END - 3_000n);
  });

  it("tip ĐÚNG bằng mốc kẹp cuối (end − 1000): NÉM, không trả cửa sổ rỗng", () => {
    expect(() => validityInEpoch(END - 1_000n, P, O)).toThrow(/C-PP-EPOCH/);
  });

  it("tip ở giây cuối kỳ (end − 999): NÉM", () => {
    expect(() => validityInEpoch(END - 999n, P, O)).toThrow(/C-PP-EPOCH/);
  });

  it("tip ở giây đầu kỳ: NÉM", () => {
    expect(() => validityInEpoch(START + 500n, P, O)).toThrow(/C-PP-EPOCH/);
  });

  it("tip ngay sau giây đầu kỳ: chứa tip", () => {
    ledgerAccepts(START + 1_000n);
  });
});
