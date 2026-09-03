// MagicSDK/tests/redeemerIndex.test.ts — verify Aiken plutus.json resolver
// works against real-SHAPED fixtures.
//
// Các fixture ở đây là TỔNG HỢP, cố ý không mang tên module nào: thứ đang thử
// là bản thân resolver (đọc $ref → definitions → anyOf → index), không phải chỉ
// số thật của một validator. Chỉ số thật được ghim ở updateProfile.test.ts bằng
// cách đọc plutus.json ĐÃ BUILD — đó mới là chỗ không được thay bằng fixture.
//
// Hai enum khác độ dài + khác vị trí `UpdateProfile` là điểm mấu chốt: resolver
// phải trả về đúng vị trí của TỆP ĐƯỢC TRUYỀN VÀO, không phải một bảng cứng.

import { describe, it, expect } from "vitest";
import { resolveConstrIndex, type PlutusJson } from "../src/redeemerIndex.js";

// Enum 6 biến thể; $ref có escape JSON Pointer `~1` (= "/") như aiken sinh ra.
const fixtureLongEnum: PlutusJson = {
  validators: [
    {
      title: "vault.vault.spend",
      redeemer: {
        schema: {
          $ref: "#/definitions/magiclamp~1protocol~1types~1VaultRedeemer",
        },
      },
    },
  ],
  definitions: {
    "magiclamp/protocol/types/VaultRedeemer": {
      anyOf: [
        { title: "ScheduleCommit", dataType: "constructor", index: 0, fields: [] },
        { title: "ScheduleFire",  dataType: "constructor", index: 1, fields: [] },
        { title: "InstantGen",    dataType: "constructor", index: 2, fields: [] },
        { title: "ApplyHalving",  dataType: "constructor", index: 3, fields: [] },
        { title: "BurnBatch",     dataType: "constructor", index: 4, fields: [] },
        { title: "UpdateProfile", dataType: "constructor", index: 5, fields: [] },
      ],
    },
  },
};

// Enum 3 biến thể — cùng tên biến thể `UpdateProfile` nhưng ở vị trí KHÁC.
const fixtureShortEnum: PlutusJson = {
  validators: [
    {
      title: "vault.vault.spend",
      redeemer: { schema: { $ref: "#/definitions/X" } },
    },
  ],
  definitions: {
    X: {
      anyOf: [
        { title: "SetDelegate",   dataType: "constructor", index: 0, fields: [] },
        { title: "BurnBatch",     dataType: "constructor", index: 1, fields: [] },
        { title: "UpdateProfile", dataType: "constructor", index: 2, fields: [] },
      ],
    },
  },
};

describe("resolveConstrIndex — happy path", () => {
  it("resolves ScheduleCommit → 0", () => {
    expect(resolveConstrIndex(fixtureLongEnum, "vault.vault.spend", "ScheduleCommit")).toBe(0);
  });
  it("resolves UpdateProfile in the 6-variant enum → 5", () => {
    expect(resolveConstrIndex(fixtureLongEnum, "vault.vault.spend", "UpdateProfile")).toBe(5);
  });
  it("resolves UpdateProfile in the 3-variant enum → 2 (khác enum kia)", () => {
    expect(resolveConstrIndex(fixtureShortEnum, "vault.vault.spend", "UpdateProfile")).toBe(2);
  });
  it("decodes JSON Pointer ~1 escape (/) in $ref path", () => {
    // fixtureLongEnum dùng ~1 — verifies the unescape logic
    expect(resolveConstrIndex(fixtureLongEnum, "vault.vault.spend", "BurnBatch")).toBe(4);
  });
});

describe("resolveConstrIndex — error paths (fail loud)", () => {
  it("throws when validator title missing", () => {
    expect(() => resolveConstrIndex(fixtureShortEnum, "nonexistent.foo.spend", "BurnBatch"))
      .toThrow(/validator "nonexistent.foo.spend" not found/);
  });

  it("throws when redeemer schema $ref missing", () => {
    const bad: PlutusJson = {
      validators: [{ title: "v.v.spend" }],
      definitions: {},
    };
    expect(() => resolveConstrIndex(bad, "v.v.spend", "Foo"))
      .toThrow(/no redeemer.schema/);
  });

  it("throws when definition path doesn't exist", () => {
    const bad: PlutusJson = {
      validators: [{
        title: "v.v.spend",
        redeemer: { schema: { $ref: "#/definitions/Missing" } },
      }],
      definitions: {},
    };
    expect(() => resolveConstrIndex(bad, "v.v.spend", "Foo"))
      .toThrow(/definition "Missing" not in/);
  });

  it("throws when variant title not in enum (with helpful list)", () => {
    expect(() => resolveConstrIndex(fixtureShortEnum, "vault.vault.spend", "WithdrawLamp"))
      .toThrow(/variant "WithdrawLamp" not in.*Available:.*SetDelegate.*BurnBatch.*UpdateProfile/);
  });

  it("simulates v1.0 — when WithdrawLamp added, resolver picks up new index", () => {
    // Hypothetical post-v1.0 plutus.json with WithdrawLamp appended at the end
    const withWithdraw: PlutusJson = {
      validators: [{
        title: "vault.vault.spend",
        redeemer: { schema: { $ref: "#/definitions/X" } },
      }],
      definitions: {
        X: {
          anyOf: [
            { title: "SetDelegate",   dataType: "constructor", index: 0, fields: [] },
            { title: "BurnBatch",     dataType: "constructor", index: 1, fields: [] },
            { title: "UpdateProfile", dataType: "constructor", index: 2, fields: [] },
            { title: "WithdrawLamp",  dataType: "constructor", index: 3, fields: [] },
          ],
        },
      },
    };
    expect(resolveConstrIndex(withWithdraw, "vault.vault.spend", "WithdrawLamp")).toBe(3);
  });

  it("simulates enum reorder — resolver self-corrects (no hardcoded desync)", () => {
    // If Tuân reorders enum (e.g., puts WithdrawLamp at position 0):
    const reordered: PlutusJson = {
      validators: [{
        title: "vault.vault.spend",
        redeemer: { schema: { $ref: "#/definitions/X" } },
      }],
      definitions: {
        X: {
          anyOf: [
            { title: "WithdrawLamp", dataType: "constructor", index: 0, fields: [] },
            { title: "SetDelegate",  dataType: "constructor", index: 1, fields: [] },
          ],
        },
      },
    };
    expect(resolveConstrIndex(reordered, "vault.vault.spend", "WithdrawLamp")).toBe(0);
    expect(resolveConstrIndex(reordered, "vault.vault.spend", "SetDelegate")).toBe(1);
  });
});
