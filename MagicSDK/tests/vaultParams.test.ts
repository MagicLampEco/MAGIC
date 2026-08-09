// MagicSDK/tests/vaultParams.test.ts — pins the compile-time param contract.
//
// buildParamsList output must match the Aiken `validator vault(...)` signature
// POSITION BY POSITION. Nothing else catches a mismatch: applyParamsToScript
// accepts any list, produces a well-formed CBOR, and yields a plausible script
// hash — the error only surfaces as a vault at an address nobody can spend, on
// mainnet, with real LAMP in it.
//
// When you change a validator signature, change this table in the same commit.
// Source of truth:
//   SnapshotGen/onchain/validators/vault.ak
//   InstantGen/onchain/validators/vault.ak
//   VacuumGen/onchain/validators/vault.ak
//   ScheduleGen/onchain/validators/vault.ak

import { describe, it, expect } from "vitest";
import { Constr, credentialToAddress } from "@lucid-evolution/lucid";
import { msPerEpoch } from "@magiclamp/protocol-utils";
import { buildParamsList } from "../src/validatorScripts.js";
import type { ProtocolParams } from "../src/types.js";

const LAMP_POLICY = "4942de4a226f43c524c1273d752712366511d5fd7ae28bc1a1576077";
const UM_POLICY   = "11111111111111111111111111111111111111111111111111111111";
const UM_SCRIPT   = "22222222222222222222222222222222222222222222222222222222";
const SHARD_POLC  = "33333333333333333333333333333333333333333333333333333333";
const BACK_POLICY = "44444444444444444444444444444444444444444444444444444444";
const BACK_SCRIPT = "55555555555555555555555555555555555555555555555555555555";
const TREASURY_PKH = "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21";

const TLAMP = "744c414d50";  // "tLAMP" — testnets
const LAMP  = "4c414d50";    // "LAMP"  — mainnet

function protocolFor(network: ProtocolParams["network"]): ProtocolParams {
  return {
    network,
    lampPolicyId:    LAMP_POLICY,
    umNftPolicyId:   UM_POLICY,
    umScriptHash:    UM_SCRIPT,
    shardPolicyId:   SHARD_POLC,
    backingNftPolicyId: BACK_POLICY,
    backingScriptHash:  BACK_SCRIPT,
    treasuryAddress: credentialToAddress(network, { type: "Key", hash: TREASURY_PKH }),
  };
}

/** What addressToPlutusData() produces for a key-only address (no stake cred). */
const TREASURY_DATA = new Constr(0, [
  new Constr(0, [TREASURY_PKH]),
  new Constr(1, []),
]);

const params = (t: Parameters<typeof buildParamsList>[0], n: ProtocolParams["network"]) =>
  buildParamsList(t, protocolFor(n), msPerEpoch(n));

describe("buildParamsList: param order matches the Aiken validator signature", () => {
  const MS_PREVIEW = 86_400_000n;
  const MS_MAINNET = 432_000_000n;

  it("Snapshot: (lamp_policy_id, lamp_asset_name, ms_per_epoch)", () => {
    expect(params("Snapshot", "Preview")).toEqual([LAMP_POLICY, TLAMP, MS_PREVIEW]);
  });

  it("Instant: (lamp_policy_id, lamp_asset_name, um_nft, um_script_hash, backing_nft, backing_script_hash, ms_per_epoch)", () => {
    expect(params("Instant", "Preview")).toEqual([
      LAMP_POLICY, TLAMP, UM_POLICY, UM_SCRIPT, BACK_POLICY, BACK_SCRIPT, MS_PREVIEW,
    ]);
  });

  // Vacuum is the only vault that still carries treasury_addr (I-ACT-7 removed
  // it everywhere else), so its signature is NOT the same as Instant's.
  it("Vacuum: (lamp_policy_id, lamp_asset_name, treasury, um_nft, um_script_hash, ms_per_epoch)", () => {
    expect(params("Vacuum", "Preview")).toEqual([
      LAMP_POLICY, TLAMP, TREASURY_DATA, UM_POLICY, UM_SCRIPT, MS_PREVIEW,
    ]);
  });

  it("Schedule: (lamp_policy_id, lamp_asset_name, shard_policy_id, ms_per_epoch)", () => {
    expect(params("Schedule", "Preview")).toEqual([
      LAMP_POLICY, TLAMP, SHARD_POLC, MS_PREVIEW,
    ]);
  });
});

describe("buildParamsList: lamp_asset_name is network-derived, never a testnet default", () => {
  // The whole point of the param: a mainnet vault must be built with "LAMP".
  // A tLAMP fallback here bakes a vault whose value check can never match, and
  // the LAMP inside it is stuck forever.
  for (const vaultType of ["Snapshot", "Instant", "Vacuum", "Schedule"] as const) {
    it(`${vaultType}: Mainnet → "LAMP", testnets → "tLAMP"`, () => {
      expect(params(vaultType, "Mainnet")[1]).toBe(LAMP);
      expect(params(vaultType, "Preview")[1]).toBe(TLAMP);
      expect(params(vaultType, "Preprod")[1]).toBe(TLAMP);
    });

    it(`${vaultType}: no tLAMP literal survives anywhere in a Mainnet param list`, () => {
      const flat = JSON.stringify(params(vaultType, "Mainnet"), (_k, v) =>
        typeof v === "bigint" ? v.toString() : v);
      expect(flat).not.toContain(TLAMP);
    });
  }

  it("explicit protocol.lampAssetName overrides the network default", () => {
    const custom = "6d794c414d50";  // "myLAMP" — non-canonical mint
    const p = { ...protocolFor("Mainnet"), lampAssetName: custom };
    expect(buildParamsList("Instant", p, msPerEpoch("Mainnet"))[1]).toBe(custom);
  });
});
