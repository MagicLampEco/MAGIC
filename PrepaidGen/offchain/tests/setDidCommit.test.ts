// offchain/tests/setDidCommit.test.ts — bộ dựng `planSetDidCommit`, gương
// `PrepaidGen/onchain/validators/prepaid.ak` ▸ `validate_set_did_commit`.
// Mỗi ca âm có một ca dương cực đối chỉ khác đúng chỗ cổng đo.

import { credentialToAddress, Data, type Network, type UTxO } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";
import {
  PrepaidTxError,
  SET_DID_COMMIT_CONSTR,
  decodeVaultDatum,
  encodeVaultDatum,
  planSetDidCommit,
  type PrepaidScripts,
  type PrepaidVaultDatum,
} from "../src/index.js";

const NET: Network = "Preprod";
const VAULT_HASH = "11".repeat(28);
const FUND_HASH = "44".repeat(28);
const OWNER_SCRIPT = "d1".repeat(28);
const DID = "c0".repeat(32);
const MS_PER_EPOCH = 86_400_000n;

const scripts: PrepaidScripts = {
  network: NET,
  params: {
    carpPolicyId: "22".repeat(28),
    carpAssetName: "5a".repeat(28),
    msPerEpoch: MS_PER_EPOCH,
    windowOriginMs: 0n,
    wakemeVaultHash: "ab".repeat(28),
  },
  vault: {
    script: { type: "PlutusV3", script: "" },
    hash: VAULT_HASH,
    address: credentialToAddress(NET, { type: "Script", hash: VAULT_HASH }),
  },
  paidFund: {
    script: { type: "PlutusV3", script: "" },
    hash: FUND_HASH,
    address: credentialToAddress(NET, { type: "Script", hash: FUND_HASH }),
  },
  carpUnit: "22".repeat(28) + "5a".repeat(28),
};

const NFT_UNIT = VAULT_HASH + "ee".repeat(32);

function vaultDatum(didCommit: string): PrepaidVaultDatum {
  return {
    owner: { Script: [OWNER_SCRIPT] },
    did_commit: didCommit,
    prepaid_credits: [],
    magic_batches: [],
    next_batch_index: 0n,
    personal_delegate: null,
    last_updated_epoch: 3n,
    attribution: { attribution_root: "", last_event_epoch: 0n, total_events: 0n },
  };
}

function vaultUtxo(didCommit: string): UTxO {
  return {
    txHash: "ab".repeat(32),
    outputIndex: 0,
    address: scripts.vault.address,
    assets: { lovelace: 2_000_000n, [NFT_UNIT]: 1n },
    datum: encodeVaultDatum(vaultDatum(didCommit)),
  };
}

// Epoch 7, khung hiệu lực nằm trọn trong một epoch.
const validity = { fromMs: 7n * MS_PER_EPOCH + 1_000n, toMs: 7n * MS_PER_EPOCH + 600_000n };

describe("planSetDidCommit — gắn PersonDID MỘT LẦN", () => {
  it("DƯƠNG — két chưa gắn DID ⟹ dựng được: một spend, đầu ra chỉ đổi did_commit + last_updated_epoch, chủ = owner", () => {
    const u = vaultUtxo("");
    const r = planSetDidCommit({ scripts, vaultUtxo: u, didCommit: DID, validity });
    expect(r.epoch).toBe(7n);
    expect(r.plan.spends).toHaveLength(1);
    expect(r.plan.spends[0]!.utxo).toBe(u);
    // Redeemer constr 5 mang đúng DID.
    const red = Data.from(r.plan.spends[0]!.redeemerCbor) as { index: number; fields: unknown[] };
    expect(red.index).toBe(SET_DID_COMMIT_CONSTR);
    expect(red.fields).toEqual([DID]);
    expect(r.plan.outputs).toHaveLength(1);
    const out = r.plan.outputs[0]!;
    expect(out.address).toBe(u.address);
    expect(out.assets).toEqual(u.assets);
    expect(decodeVaultDatum(out.datumCbor!)).toEqual({ ...vaultDatum(""), did_commit: DID, last_updated_epoch: 7n });
    expect(r.plan.owner).toEqual({ type: "script", hash: OWNER_SCRIPT });
    expect(r.plan.validity).toEqual(validity);
  });

  it("ÂM — két đã gắn DID (kể cả cùng DID) ⟹ NÉM C-PP-DID-ONCE", () => {
    for (const existing of [DID, "c1".repeat(32)]) {
      let err: unknown;
      try {
        planSetDidCommit({ scripts, vaultUtxo: vaultUtxo(existing), didCommit: DID, validity });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PrepaidTxError);
      expect(String((err as Error).message)).toMatch(/đã gắn DID/);
    }
  });

  it("ÂM — did_commit rỗng / 31 byte / hoa ⟹ NÉM; DƯƠNG cực đối 32 byte thường ở ca đầu", () => {
    for (const bad of ["", "c0".repeat(31), "C0".repeat(32)]) {
      expect(() => planSetDidCommit({ scripts, vaultUtxo: vaultUtxo(""), didCommit: bad, validity })).toThrow(/32 byte/);
    }
  });
});
