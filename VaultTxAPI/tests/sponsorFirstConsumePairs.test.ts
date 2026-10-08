// VaultTxAPI/tests/sponsorFirstConsumePairs.test.ts — `POST /tx/sponsor/first-consume` nhận `pairs` như `/tx/consume`.
//
// Thuần (không chuỗi, không script). Ba việc:
//   (1) hình dạng: dạng cũ giữ nguyên; `pairs` đọc ra `pairs`; `pairs` một phần tử ⟹ `consumeLineOf` cho dạng ĐƠN
//       với đúng giá trị của dạng cũ (nên SDK dựng cùng một `Consume`, tx y hệt — đo trên script thật ở
//       `sponsorEmulator.test.ts`);
//   (2) ĐỐI CHIẾU với `/tx/consume`: mỗi thân `pairs` sai ra CÙNG mã ở hai route — đo bằng cách chạy cả hai bộ đọc,
//       không gõ sẵn mã mong đợi cho bên first-consume (nếu có người viết song song một bộ đọc thứ hai, bài này đỏ);
//   (3) cực đối: hai dạng cùng lúc ⟹ CONSUME_PAIRS_CONFLICT ở cả tầng đọc lẫn tầng dịch vụ.

import { describe, expect, it } from "vitest";

import { parseBuildRequest } from "../src/buildRequest.js";
import { consumeLineOf } from "../src/consumeLine.js";
import { TxApiError } from "../src/errors.js";
import { parseSponsorRequest } from "../src/sponsor.js";

const OWNER = { owner: { type: "key", hash: "ab".repeat(28) } };
const FIRST = (extra: Record<string, unknown>) => ({ ...OWNER, draw_epoch: 330, ...extra });

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof TxApiError) return e.code;
    return `KHÔNG-CÓ-MÃ:${(e as Error).name}`;
  }
  return "KHÔNG-NÉM";
}

const sponsorCode = (extra: Record<string, unknown>) => codeOf(() => {
  const r = parseSponsorRequest("first-consume", FIRST(extra));
  consumeLineOf(r); // tầng dịch vụ: `firstConsume` gọi hàm này trước khi giữ khoá
});
const consumeCode = (extra: Record<string, unknown>) => codeOf(() => parseBuildRequest("consume", { ...OWNER, ...extra }));

describe("first-consume — hình dạng lượt tiêu", () => {
  it("dạng cũ: op_type/op_count vẫn đọc ra, không có pairs; consumeLineOf cho dạng đơn", () => {
    const r = parseSponsorRequest("first-consume", FIRST({ op_type: 2, op_count: "5" }));
    expect(r.opType).toBe(2);
    expect(r.opCount).toBe(5n);
    expect(r.pairs).toBeUndefined();
    expect(consumeLineOf(r)).toEqual({ kind: "single", opType: 2, opCount: 5n });
  });

  it("`pairs` một phần tử ⟹ dạng ĐƠN cùng giá trị với dạng cũ (CẶP với ca trên)", () => {
    const r = parseSponsorRequest("first-consume", FIRST({ pairs: [{ op_type: 2, op_count: "5" }] }));
    expect(r.opType).toBeUndefined();
    expect(r.opCount).toBeUndefined();
    expect(consumeLineOf(r)).toEqual(consumeLineOf(parseSponsorRequest("first-consume", FIRST({ op_type: 2, op_count: "5" }))));
  });

  it("`pairs` hai phần tử ⟹ dạng nhiều cặp, giữ thứ tự", () => {
    const r = parseSponsorRequest("first-consume", FIRST({ pairs: [{ op_type: 1, op_count: "1" }, { op_type: 2, op_count: "3" }] }));
    expect(consumeLineOf(r)).toEqual({
      kind: "many", pairs: [{ opType: 1, opCount: 1n }, { opType: 2, opCount: 3n }],
    });
  });

  it("thiếu cả hai dạng ⟹ 400 như trước (không đoán)", () => {
    expect(sponsorCode({})).toBe("BAD_REQUEST");
  });
});

describe("first-consume — `pairs` sai ra CÙNG mã với /tx/consume", () => {
  const TWO = [{ op_type: 1, op_count: "1" }, { op_type: 2, op_count: "1" }];
  const cases: [string, Record<string, unknown>, string][] = [
    ["cả hai dạng", { pairs: TWO, op_type: 1, op_count: "2" }, "CONSUME_PAIRS_CONFLICT"],
    ["pairs + chỉ op_type", { pairs: TWO, op_type: 1 }, "CONSUME_PAIRS_CONFLICT"],
    ["pairs rỗng", { pairs: [] }, "CONSUME_PAIRS_EMPTY"],
    ["9 cặp", { pairs: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(t => ({ op_type: t, op_count: "1" })) }, "CONSUME_PAIRS_TOO_MANY"],
    ["không tăng ngặt", { pairs: [{ op_type: 3, op_count: "1" }, { op_type: 1, op_count: "1" }] }, "CONSUME_PAIRS_NOT_INCREASING"],
    ["trùng op_type", { pairs: [{ op_type: 2, op_count: "1" }, { op_type: 2, op_count: "1" }] }, "CONSUME_PAIRS_NOT_INCREASING"],
    ["op_count \"0\"", { pairs: [{ op_type: 1, op_count: "0" }] }, "CONSUME_PAIR_COUNT_INVALID"],
    ["op_count là số JSON", { pairs: [{ op_type: 1, op_count: 2 }] }, "CONSUME_PAIR_COUNT_INVALID"],
    ["op_type là chuỗi", { pairs: [{ op_type: "1", op_count: "1" }] }, "CONSUME_PAIR_TYPE_INVALID"],
    ["op_type quá 1000000", { pairs: [{ op_type: 1_000_001, op_count: "1" }] }, "CONSUME_PAIR_TYPE_INVALID"],
    ["pairs không phải mảng", { pairs: { op_type: 1, op_count: "1" } }, "CONSUME_PAIRS_SHAPE"],
    ["phần tử có khoá lạ", { pairs: [{ op_type: 1, op_count: "1", price: "0" }] }, "CONSUME_PAIRS_SHAPE"],
  ];
  for (const [name, extra, code] of cases) {
    it(name, () => {
      expect(consumeCode(extra)).toBe(code); // đối chứng: bảng này đúng với /tx/consume
      expect(sponsorCode(extra)).toBe(consumeCode(extra));
    });
  }

  it("CẶP: biên hợp lệ (8 cặp, op_type 1000000) qua ở CẢ hai route", () => {
    const eight = { pairs: [1, 2, 3, 4, 5, 6, 7, 8].map(t => ({ op_type: t, op_count: "1" })) };
    const edge = { pairs: [{ op_type: 1_000_000, op_count: "1" }] };
    for (const extra of [eight, edge]) {
      expect(consumeCode(extra)).toBe("KHÔNG-NÉM");
      expect(sponsorCode(extra)).toBe("KHÔNG-NÉM");
    }
  });
});

describe("first-consume — tầng dịch vụ kiểm lại sự loại trừ (lời gọi thẳng, không qua bộ đọc HTTP)", () => {
  it("opType + pairs ⟹ CONSUME_PAIRS_CONFLICT", () => {
    expect(codeOf(() => consumeLineOf({ opType: 1, pairs: [{ opType: 1, opCount: 1n }] }))).toBe("CONSUME_PAIRS_CONFLICT");
  });
});
