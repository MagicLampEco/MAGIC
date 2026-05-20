// MagicSDK/tests/redeemerIndex.test.ts — verify Aiken plutus.json resolver
// works against a real-shaped fixture (mirrors VacuumGen plutus.json structure
// on main as of 2026-05-20).

import { describe, it, expect } from "vitest";
import { resolveConstrIndex, type PlutusJson } from "../src/redeemerIndex.js";

const fixtureVacuumGen: PlutusJson = {
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
        { title: "VacuumCommit", dataType: "constructor", index: 0, fields: [] },
        { title: "VacuumFire",   dataType: "constructor", index: 1, fields: [] },
        { title: "InstantGen",   dataType: "constructor", index: 2, fields: [] },
        { title: "ApplyHalving", dataType: "constructor", index: 3, fields: [] },
        { title: "BurnBatch",    dataType: "constructor", index: 4, fields: [] },
        { title: "UpdateProfile",dataType: "constructor", index: 5, fields: [] },
      ],
    },
  },
};

const fixtureSnapshotGen: PlutusJson = {
  validators: [
    {
      title: "vault.vault.spend",
      redeemer: { schema: { $ref: "#/definitions/X" } },
    },
  ],
  definitions: {
    X: {
      anyOf: [
        { title: "TriggerSnapshot", dataType: "constructor", index: 0, fields: [] },
        { title: "BurnBatch",       dataType: "constructor", index: 1, fields: [] },
        { title: "UpdateProfile",   dataType: "constructor", index: 2, fields: [] },
      ],
    },
  },
};

describe("resolveConstrIndex — happy path", () => {
  it("resolves VacuumCommit → 0", () => {
    expect(resolveConstrIndex(fixtureVacuumGen, "vault.vault.spend", "VacuumCommit")).toBe(0);
  });
  it("resolves UpdateProfile in Vacuum enum → 5", () => {
    expect(resolveConstrIndex(fixtureVacuumGen, "vault.vault.spend", "UpdateProfile")).toBe(5);
  });
  it("resolves UpdateProfile in SnapshotGen enum → 2 (different from Vacuum)", () => {
    expect(resolveConstrIndex(fixtureSnapshotGen, "vault.vault.spend", "UpdateProfile")).toBe(2);
  });
  it("decodes JSON Pointer ~1 escape (/) in $ref path", () => {
    // VacuumGen uses ~1 — verifies the unescape logic
    expect(resolveConstrIndex(fixtureVacuumGen, "vault.vault.spend", "BurnBatch")).toBe(4);
  });
});

describe("resolveConstrIndex — error paths (fail loud)", () => {
  it("throws when validator title missing", () => {
    expect(() => resolveConstrIndex(fixtureSnapshotGen, "nonexistent.foo.spend", "BurnBatch"))
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
    expect(() => resolveConstrIndex(fixtureSnapshotGen, "vault.vault.spend", "WithdrawLamp"))
      .toThrow(/variant "WithdrawLamp" not in.*Available:.*TriggerSnapshot.*BurnBatch.*UpdateProfile/);
  });

  it("simulates v1.0 — when WithdrawLamp added, resolver picks up new index", () => {
    // Hypothetical post-v1.0 SnapshotGen plutus.json with WithdrawLamp at end
    const withWithdraw: PlutusJson = {
      validators: [{
        title: "vault.vault.spend",
        redeemer: { schema: { $ref: "#/definitions/X" } },
      }],
      definitions: {
        X: {
          anyOf: [
            { title: "TriggerSnapshot", dataType: "constructor", index: 0, fields: [] },
            { title: "BurnBatch",       dataType: "constructor", index: 1, fields: [] },
            { title: "UpdateProfile",   dataType: "constructor", index: 2, fields: [] },
            { title: "WithdrawLamp",    dataType: "constructor", index: 3, fields: [] },
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
            { title: "WithdrawLamp",    dataType: "constructor", index: 0, fields: [] },
            { title: "TriggerSnapshot", dataType: "constructor", index: 1, fields: [] },
          ],
        },
      },
    };
    expect(resolveConstrIndex(reordered, "vault.vault.spend", "WithdrawLamp")).toBe(0);
    expect(resolveConstrIndex(reordered, "vault.vault.spend", "TriggerSnapshot")).toBe(1);
  });
});
