// VaultTxAPI/tests/schemaSubset.test.ts — bộ kiểm lược đồ nhỏ (`tests/support/schemaSubset.ts`): mỗi từ khoá một CẶP
// (khớp / không khớp). Bộ kiểm này là chỗ hợp đồng module được thực thi; nó hỏng im lặng thì mọi bài khớp-hợp-đồng
// xanh vì lý do rỗng — nên nó có bài riêng.

import { describe, expect, it } from "vitest";

import {
  SchemaUnsupportedError, assertSchemaSupported, resolveRef, validate, type Document, type Schema,
} from "./support/schemaSubset.js";

const DOC: Document = {
  components: {
    schemas: {
      Hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      Loop: { type: "object", properties: { next: { $ref: "#/components/schemas/Loop" } } },
    },
  },
};
const ok = (v: unknown, s: Schema) => expect(validate(v, s, DOC)).toEqual([]);
const bad = (v: unknown, s: Schema, path: string) => {
  const r = validate(v, s, DOC);
  expect(r.map(x => x.path), JSON.stringify(r)).toContain(path);
};

describe("type", () => {
  it("string / integer / boolean / null / array / object: khớp và không khớp", () => {
    ok("a", { type: "string" }); bad(1, { type: "string" }, "$");
    ok(3, { type: "integer" }); bad(3.5, { type: "integer" }, "$"); bad("3", { type: "integer" }, "$");
    ok(true, { type: "boolean" }); bad("true", { type: "boolean" }, "$");
    ok(null, { type: "null" }); bad(0, { type: "null" }, "$");
    ok([], { type: "array" }); bad({}, { type: "array" }, "$");
    ok({}, { type: "object" }); bad([], { type: "object" }, "$"); bad(null, { type: "object" }, "$");
  });
  it("số JSON không phải số hữu hạn bị từ chối ở type number; chuỗi chữ số không phải number", () => {
    ok(1.5, { type: "number" }); bad("1.5", { type: "number" }, "$");
  });
  it("type là mảng: khớp một trong các kiểu", () => {
    ok(null, { type: ["string", "null"] }); ok("x", { type: ["string", "null"] }); bad(1, { type: ["string", "null"] }, "$");
  });
});

describe("required + properties", () => {
  const s: Schema = { type: "object", required: ["a"], properties: { a: { type: "string" }, b: { type: "integer" } } };
  it("required: có khoá ⟹ khớp; thiếu khoá ⟹ không khớp, nêu đúng khoá", () => {
    ok({ a: "x" }, s); bad({ b: 1 }, s, "$.a");
  });
  it("properties: khoá khai kiểu đúng ⟹ khớp; sai kiểu ⟹ không khớp ở đúng đường", () => {
    ok({ a: "x", b: 2 }, s); bad({ a: "x", b: "2" }, s, "$.b");
  });
  it("khoá KHÔNG bắt buộc vắng ⟹ khớp (vắng khác null)", () => {
    ok({ a: "x" }, s); bad({ a: "x", b: null }, s, "$.b");
  });
});

describe("additionalProperties", () => {
  it("vắng ⟹ khoá lạ được nhận (luật cộng thêm của lời đáp); false ⟹ khoá lạ bị từ chối", () => {
    const open: Schema = { type: "object", properties: { a: { type: "string" } } };
    const closed: Schema = { ...open, additionalProperties: false };
    ok({ a: "x", extra: 1 }, open);
    bad({ a: "x", extra: 1 }, closed, "$.extra");
    ok({ a: "x" }, closed);
  });
  it("là lược đồ ⟹ giá trị khoá lạ phải khớp lược đồ đó", () => {
    const s: Schema = { type: "object", additionalProperties: { type: "string" } };
    ok({ x: "1", y: "2" }, s); bad({ x: "1", y: 2 }, s, "$.y");
  });
});

describe("enum + const", () => {
  it("enum: thành viên ⟹ khớp; ngoài tập ⟹ không khớp", () => {
    const s: Schema = { enum: ["in_chain", "in_mempool", "not_found"] };
    ok("in_chain", s); bad("pending", s, "$");
  });
  it("const: bằng ⟹ khớp; khác ⟹ không khớp (kể cả kiểu khác)", () => {
    ok(true, { const: true }); bad(false, { const: true }, "$"); bad("true", { const: true }, "$");
  });
});

describe("pattern", () => {
  const s: Schema = { type: "string", pattern: "^[0-9a-f]{32}$" };
  it("khớp mẫu ⟹ khớp; hoa / sai độ dài ⟹ không khớp", () => {
    ok("ab".repeat(16), s); bad("AB".repeat(16), s, "$"); bad("ab".repeat(15), s, "$");
  });
  it("pattern bỏ qua giá trị không phải chuỗi (kiểu do `type` canh)", () => {
    ok(5, { pattern: "^x$" }); bad(5, { type: "string", pattern: "^x$" }, "$");
  });
});

describe("items", () => {
  const s: Schema = { type: "array", items: { type: "string" } };
  it("mọi phần tử đúng ⟹ khớp; một phần tử sai ⟹ không khớp ở đúng chỉ số", () => {
    ok(["a", "b"], s); ok([], s); bad(["a", 2], s, "$[1]");
  });
});

describe("oneOf", () => {
  const s: Schema = { oneOf: [{ type: "string" }, { type: "integer" }] };
  it("khớp đúng một ⟹ khớp", () => { ok("a", s); ok(1, s); });
  it("không khớp nhánh nào ⟹ không khớp; khớp HAI nhánh ⟹ cũng không khớp", () => {
    bad(null, s, "$");
    bad("a", { oneOf: [{ type: "string" }, { pattern: "^a$" }] }, "$");
  });
});

describe("$ref", () => {
  it("trỏ tới lược đồ có thật ⟹ áp lược đồ đó; trỏ hỏng ⟹ NÉM, không lặng lẽ khớp", () => {
    ok("ab".repeat(32), { $ref: "#/components/schemas/Hash" });
    bad("xyz", { $ref: "#/components/schemas/Hash" }, "$");
    expect(() => validate("x", { $ref: "#/components/schemas/Missing" }, DOC)).toThrow(SchemaUnsupportedError);
    expect(() => resolveRef("https://example.invalid/x.json", DOC)).toThrow(SchemaUnsupportedError);
  });
  it("tham chiếu vòng được kiểm theo giá trị hữu hạn", () => {
    ok({ next: { next: {} } }, { $ref: "#/components/schemas/Loop" });
    bad({ next: { next: 1 } }, { $ref: "#/components/schemas/Loop" }, "$.next.next");
  });
});

describe("từ khoá ngoài tập hỗ trợ ⟹ NÉM", () => {
  it("validate ném với minLength / format / allOf; assertSchemaSupported ném cả khi từ khoá nằm sâu và khi có chú thích hợp lệ", () => {
    for (const kw of ["minLength", "format", "allOf", "minimum", "patternProperties"]) {
      expect(() => validate("x", { type: "string", [kw]: 1 }, DOC), kw).toThrow(SchemaUnsupportedError);
    }
    expect(() => assertSchemaSupported({ type: "object", properties: { a: { type: "string", minLength: 1 } } }, DOC))
      .toThrow(SchemaUnsupportedError);
    // CẶP: chú thích + khoá x- không phải từ khoá kiểm ⟹ qua.
    expect(() => assertSchemaSupported({ type: "string", description: "d", example: "e", "x-note": 1 }, DOC)).not.toThrow();
    ok("x", { type: "string", description: "d", "x-note": 1 });
  });
});
