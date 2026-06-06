// MagicSDK/tests/updateProfile.test.ts — unit tests for the UpdateProfile SDK op.
//
// Covers the pure / early-exit surface (no lucid network mocking):
//   1. Redeemer constructor-index resolution against the REAL built plutus.json
//      for SnapshotGen (UpdateProfile=2) + InstantGen (=3), and absence on
//      ScheduleGen (no UpdateProfile variant → fail loud).
//   2. ActivityProfile inner-constructor mapping (Ember/Flame/Lantern).
//   3. UPDATE-001 guard — Vacuum/Schedule vaults reject before any network call.

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { updateProfile } from "../src/updateProfile.js";
import { PROFILE_CONSTR_INDEX, UPDATE_PROFILE_TAG } from "../src/updateProfile.js";
import { resolveConstrIndex, loadPlutusJson } from "../src/redeemerIndex.js";

const VAULT_TITLE = "vault.vault.spend";

// Resolve repo-root-relative paths to the built validator artifacts. This test
// file lives at MagicSDK/tests/ → ../../ is the repo root.
const plutusPath = (module: string) =>
  fileURLToPath(new URL(`../../${module}/onchain/plutus.json`, import.meta.url));

describe("updateProfile — redeemer index resolution (real plutus.json)", () => {
  it("resolves UpdateProfile=2 on SnapshotGen", async () => {
    const pj = await loadPlutusJson(plutusPath("SnapshotGen"));
    expect(resolveConstrIndex(pj, VAULT_TITLE, UPDATE_PROFILE_TAG)).toBe(2);
  });

  it("resolves UpdateProfile=3 on InstantGen", async () => {
    const pj = await loadPlutusJson(plutusPath("InstantGen"));
    expect(resolveConstrIndex(pj, VAULT_TITLE, UPDATE_PROFILE_TAG)).toBe(3);
  });

  it("fails loud when UpdateProfile absent (ScheduleGen)", async () => {
    const pj = await loadPlutusJson(plutusPath("ScheduleGen"));
    expect(() => resolveConstrIndex(pj, VAULT_TITLE, UPDATE_PROFILE_TAG))
      .toThrow(/variant "UpdateProfile" not in.*Available:/);
  });
});

describe("updateProfile — ActivityProfile constructor mapping", () => {
  it("maps Ember=0, Flame=1, Lantern=2 (closed enum, invariant since v0)", () => {
    expect(PROFILE_CONSTR_INDEX).toEqual({ Ember: 0, Flame: 1, Lantern: 2 });
  });
});

describe("updateProfile — vault-type guard (UPDATE-001)", () => {
  it("rejects Vacuum vaults before any network call", async () => {
    await expect(
      updateProfile({ vaultType: "Vacuum", newProfile: "Ember" } as never),
    ).rejects.toThrow(/UPDATE-001/);
  });

  it("rejects Schedule vaults before any network call", async () => {
    await expect(
      updateProfile({ vaultType: "Schedule", newProfile: "Ember" } as never),
    ).rejects.toThrow(/UPDATE-001/);
  });
});
