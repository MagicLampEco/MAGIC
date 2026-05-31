// Builder logic tests — KHÔNG submit thật (không có Blockfrost/compiled validator).
// Mock tx-builder chain ghi lại các call → assert datum/redeemer/asset preservation
// + validation errors. Test pure logic builder, đúng tinh thần module foundation.

import { describe, it, expect } from "vitest";
import { Constr, Data, validatorToScriptHash, credentialToAddress, scriptHashToCredential, toUnit } from "@lucid-evolution/lucid";
import type { UTxO, Validator } from "@lucid-evolution/lucid";

import { buildClaimTx } from "../offchain/src/claimBuilder.js";
import { buildRedeemTx } from "../offchain/src/redeemBuilder.js";
import { buildPostBeaconTx } from "../offchain/src/beaconBuilder.js";
import {
  claimAccountDatumToCbor, beaconDatumToCbor, treasuryDatumToCbor,
} from "../offchain/src/datum.js";
import { buildMerkleTree } from "../offchain/src/merkle.js";
import { committeeThreshold } from "../offchain/src/committee.js";

// ── Mock Lucid tx-builder ──────────────────────────────────────────────
// Ghi lại mọi call. complete() trả về object giả (không submit). Đủ để assert
// builder dựng đúng input/output/redeemer/signer.

interface Recorded {
  collectFrom: { utxos: UTxO[]; redeemer: string }[];
  attach:      Validator[];
  readFrom:    UTxO[][];
  payData:     { address: string; datum: string; assets: Record<string, bigint> }[];
  payAddr:     { address: string; assets: Record<string, bigint> }[];
  signers:     string[];
}

function mockLucid(walletAddress: string): { lucid: any; rec: Recorded } {
  const rec: Recorded = {
    collectFrom: [], attach: [], readFrom: [], payData: [], payAddr: [], signers: [],
  };
  const txb: any = {
    collectFrom(utxos: UTxO[], redeemer: string) { rec.collectFrom.push({ utxos, redeemer }); return txb; },
    attach: { SpendingValidator(v: Validator) { rec.attach.push(v); return txb; } },
    readFrom(utxos: UTxO[]) { rec.readFrom.push(utxos); return txb; },
    pay: {
      ToAddressWithData(address: string, datum: { kind: string; value: string }, assets: Record<string, bigint>) {
        rec.payData.push({ address, datum: datum.value, assets }); return txb;
      },
      ToAddress(address: string, assets: Record<string, bigint>) {
        rec.payAddr.push({ address, assets }); return txb;
      },
    },
    addSignerKey(k: string) { rec.signers.push(k); return txb; },
    async complete() { return { __mockTx: true }; },
  };
  const lucid = {
    newTx() { return txb; },
    wallet() { return { address: async () => walletAddress }; },
  };
  return { lucid, rec };
}

// fake applied validators — chỉ cần CBOR hợp lệ để derive script hash/address.
// Dùng CBOR PlutusV3 tối thiểu (1 byte). Lucid chỉ blake2b-hash bytes này.
const FAKE_CLAIM:    Validator = { type: "PlutusV3", script: "49480100002221200101" };
const FAKE_TREASURY: Validator = { type: "PlutusV3", script: "49480100002221200102" };
const FAKE_BEACON:   Validator = { type: "PlutusV3", script: "49480100002221200103" };

const NETWORK = "Preview" as const;
const OWNER   = "aabbccddeeff00112233445566778899aabbccddeeff001122334455";
const LAMP_POLICY = "ff".repeat(28);
const LAMP_UNIT   = toUnit(LAMP_POLICY, "4c414d50");

// committee 3 keys, threshold 2
const COMMITTEE = ["11".repeat(28), "22".repeat(28), "33".repeat(28)];

function scriptAddr(v: Validator): string {
  return credentialToAddress(NETWORK, scriptHashToCredential(validatorToScriptHash(v)));
}

// ── committeeThreshold ──────────────────────────────────────────────────
describe("committeeThreshold ⌈2N/3⌉", () => {
  it("matches Byzantine 2/3", () => {
    expect(committeeThreshold(3)).toBe(2);
    expect(committeeThreshold(4)).toBe(3);
    expect(committeeThreshold(5)).toBe(4);
    expect(committeeThreshold(7)).toBe(5);
    expect(committeeThreshold(1)).toBe(1);
  });
});

// ── buildClaimTx ────────────────────────────────────────────────────────
describe("buildClaimTx — CREATE path", () => {
  it("pays initial datum, no spend, committee signs", async () => {
    const { lucid, rec } = mockLucid("addr_wallet");
    const res = await buildClaimTx({
      lucid, claimScript: FAKE_CLAIM, network: NETWORK,
      ownerPkh: OWNER, amount: 250_000_000n, currentEpoch: 5n,
      committeeKeyHashes: COMMITTEE,
    });
    expect(res.mode).toBe("create");
    expect(rec.collectFrom).toHaveLength(0);        // không spend
    expect(rec.payData).toHaveLength(1);
    expect(rec.payData[0]!.address).toBe(scriptAddr(FAKE_CLAIM));
    expect(rec.signers.length).toBeGreaterThanOrEqual(2);
    expect(res.newDatum).toEqual({
      owner: OWNER, claimed_cumulative: 250_000_000n,
      redeemed_cumulative: 0n, last_claim_epoch: 5n,
    });
    // datum CBOR khớp encode
    expect(rec.payData[0]!.datum).toBe(claimAccountDatumToCbor(res.newDatum));
  });
});

describe("buildClaimTx — UPDATE path", () => {
  function claimUtxo(datum: any, extraAssets: Record<string, bigint> = {}): UTxO {
    return {
      txHash: "ab".repeat(32), outputIndex: 0,
      address: scriptAddr(FAKE_CLAIM),
      assets: { lovelace: 2_000_000n, ...extraAssets },
      datum: claimAccountDatumToCbor(datum),
    };
  }

  it("increments claimed_cumulative, preserves owner+redeemed+assets", async () => {
    const { lucid, rec } = mockLucid("addr_wallet");
    const prev = { owner: OWNER, claimed_cumulative: 100_000_000n, redeemed_cumulative: 40_000_000n, last_claim_epoch: 3n };
    const DUST = toUnit("ab".repeat(28), "cafe");
    const res = await buildClaimTx({
      lucid, claimScript: FAKE_CLAIM, network: NETWORK,
      ownerPkh: OWNER, amount: 60_000_000n, currentEpoch: 9n,
      claimAccountUtxo: claimUtxo(prev, { [DUST]: 7n }),
      committeeKeyHashes: COMMITTEE,
    });
    expect(res.mode).toBe("update");
    expect(rec.collectFrom).toHaveLength(1);        // spend account
    expect(rec.attach).toContain(FAKE_CLAIM);
    expect(res.newDatum).toEqual({
      owner: OWNER, claimed_cumulative: 160_000_000n,   // +60
      redeemed_cumulative: 40_000_000n,                 // unchanged
      last_claim_epoch: 9n,                             // current
    });
    // assets bảo toàn (lovelace + dust)
    expect(rec.payData[0]!.assets).toEqual({ lovelace: 2_000_000n, [DUST]: 7n });
  });

  it("rejects amount ≤ 0", async () => {
    const { lucid } = mockLucid("addr_wallet");
    await expect(buildClaimTx({
      lucid, claimScript: FAKE_CLAIM, network: NETWORK,
      ownerPkh: OWNER, amount: 0n, currentEpoch: 1n, committeeKeyHashes: COMMITTEE,
    })).rejects.toThrow(/amount must be > 0/);
  });

  it("rejects owner mismatch on update", async () => {
    const { lucid } = mockLucid("addr_wallet");
    const prev = { owner: "00".repeat(28), claimed_cumulative: 1n, redeemed_cumulative: 0n, last_claim_epoch: 0n };
    await expect(buildClaimTx({
      lucid, claimScript: FAKE_CLAIM, network: NETWORK,
      ownerPkh: OWNER, amount: 1n, currentEpoch: 1n,
      claimAccountUtxo: claimUtxo(prev), committeeKeyHashes: COMMITTEE,
    })).rejects.toThrow(/ownerPkh mismatch/);
  });

  it("rejects below-threshold signers", async () => {
    const { lucid } = mockLucid("addr_wallet");
    await expect(buildClaimTx({
      lucid, claimScript: FAKE_CLAIM, network: NETWORK,
      ownerPkh: OWNER, amount: 1n, currentEpoch: 1n,
      committeeKeyHashes: COMMITTEE,
      signerKeyHashes: [COMMITTEE[0]!],   // 1 < threshold 2
    })).rejects.toThrow(/need ≥ 2 signers/);
  });
});

// ── buildPostBeaconTx ───────────────────────────────────────────────────
describe("buildPostBeaconTx", () => {
  const NFT_POLICY = "cd".repeat(28);
  const NFT_UNIT   = toUnit(NFT_POLICY, "4c4d504d"); // MerkleRoot default asset name

  function beaconUtxo(kind: any, epoch: bigint, value: string, assets: Record<string, bigint>): UTxO {
    return {
      txHash: "cd".repeat(32), outputIndex: 0,
      address: scriptAddr(FAKE_BEACON),
      assets,
      datum: beaconDatumToCbor({ epoch, kind, value }),
    };
  }

  it("posts new MerkleRoot beacon, preserves NFT + assets, no mint", async () => {
    const { lucid, rec } = mockLucid("addr_wallet");
    const root = "ab".repeat(32);
    const res = await buildPostBeaconTx({
      lucid, beaconScript: FAKE_BEACON, network: NETWORK,
      beaconNftPolicy: NFT_POLICY,
      beaconUtxo: beaconUtxo("MerkleRoot", 9n, "00".repeat(32), { lovelace: 2_000_000n, [NFT_UNIT]: 1n }),
      newBeacon: { epoch: 10n, kind: "MerkleRoot", value: root },
      committeeKeyHashes: COMMITTEE,
    });
    expect(rec.collectFrom).toHaveLength(1);
    expect(rec.payData).toHaveLength(1);
    // NFT + lovelace bảo toàn ở output
    expect(rec.payData[0]!.assets).toEqual({ lovelace: 2_000_000n, [NFT_UNIT]: 1n });
    expect(rec.payData[0]!.datum).toBe(beaconDatumToCbor({ epoch: 10n, kind: "MerkleRoot", value: root }));
    expect(rec.signers.length).toBeGreaterThanOrEqual(2);
    expect(res.newBeacon.epoch).toBe(10n);
  });

  it("rejects when NFT count ≠ 1", async () => {
    const { lucid } = mockLucid("addr_wallet");
    await expect(buildPostBeaconTx({
      lucid, beaconScript: FAKE_BEACON, network: NETWORK,
      beaconNftPolicy: NFT_POLICY,
      beaconUtxo: beaconUtxo("MerkleRoot", 9n, "00".repeat(32), { lovelace: 2_000_000n }), // no NFT
      newBeacon: { epoch: 10n, kind: "MerkleRoot", value: "ab".repeat(32) },
      committeeKeyHashes: COMMITTEE,
    })).rejects.toThrow(/exactly 1 authenticity NFT/);
  });
});

// ── buildRedeemTx ───────────────────────────────────────────────────────
describe("buildRedeemTx", () => {
  // 2-leaf lottery: OWNER won 300 LAMP cumulative, other won 500.
  const OTHER = "bb".repeat(28);
  const leaves = [
    { owner: OWNER, wonCumulative: 300_000_000n },
    { owner: OTHER, wonCumulative: 500_000_000n },
  ];
  const tree = buildMerkleTree(leaves);
  const ROOT = tree.rootHex;

  function claimUtxo(redeemed: bigint, claimed = 300_000_000n, extra: Record<string, bigint> = {}): UTxO {
    return {
      txHash: "11".repeat(32), outputIndex: 0,
      address: scriptAddr(FAKE_CLAIM),
      assets: { lovelace: 2_000_000n, ...extra },
      datum: claimAccountDatumToCbor({
        owner: OWNER, claimed_cumulative: claimed, redeemed_cumulative: redeemed, last_claim_epoch: 4n,
      }),
    };
  }
  function treasuryUtxo(lamp: bigint, extra: Record<string, bigint> = {}): UTxO {
    return {
      txHash: "22".repeat(32), outputIndex: 0,
      address: scriptAddr(FAKE_TREASURY),
      assets: { lovelace: 5_000_000n, [LAMP_UNIT]: lamp, ...extra },
      datum: treasuryDatumToCbor({ committee_hash: "ee".repeat(28) }),
    };
  }
  function beaconUtxo(epoch: bigint, root: string): UTxO {
    return {
      txHash: "33".repeat(32), outputIndex: 0,
      address: scriptAddr(FAKE_BEACON),
      assets: { lovelace: 2_000_000n },
      datum: beaconDatumToCbor({ epoch, kind: "MerkleRoot", value: root }),
    };
  }

  const base = {
    network: NETWORK, claimScript: FAKE_CLAIM, treasuryScript: FAKE_TREASURY,
    wonCumulative: 300_000_000n, lotteryEpoch: 7n, lampPolicyId: LAMP_POLICY,
  };

  it("releases won−redeemed, preserves treasury dust + committee_hash, sets redeemed=won", async () => {
    const { lucid, rec } = mockLucid("addr_user");
    const DUST = toUnit("dd".repeat(28), "f00d");
    const res = await buildRedeemTx({
      ...base, lucid,
      claimAccountUtxo: claimUtxo(100_000_000n),                       // redeemed 100
      treasuryUtxo: treasuryUtxo(1_000_000_000n, { [DUST]: 3n }),      // 1000 LAMP + dust
      merkleBeaconUtxo: beaconUtxo(7n, ROOT),
      proof: tree.proofs.get(OWNER)!,
    });
    expect(res.released).toBe(200_000_000n);                          // 300 − 100
    expect(res.newClaimDatum.redeemed_cumulative).toBe(300_000_000n); // = won
    expect(res.newClaimDatum.claimed_cumulative).toBe(300_000_000n);  // unchanged
    expect(res.newClaimDatum.last_claim_epoch).toBe(4n);              // unchanged

    // 2 inputs spent (claim + treasury), beacon read-only
    expect(rec.collectFrom).toHaveLength(2);
    expect(rec.readFrom).toHaveLength(1);
    expect(rec.attach).toEqual(expect.arrayContaining([FAKE_CLAIM, FAKE_TREASURY]));

    // treasury output: LAMP 1000→800, dust + lovelace bảo toàn
    const treasuryOut = rec.payData.find(p => p.address === scriptAddr(FAKE_TREASURY))!;
    expect(treasuryOut.assets[LAMP_UNIT]).toBe(800_000_000n);
    expect(treasuryOut.assets.lovelace).toBe(5_000_000n);
    expect(treasuryOut.assets[DUST]).toBe(3n);

    // user receives exactly released LAMP
    expect(rec.payAddr).toHaveLength(1);
    expect(rec.payAddr[0]!.assets[LAMP_UNIT]).toBe(200_000_000n);
    expect(rec.payAddr[0]!.address).toBe("addr_user");

    // owner signs
    expect(rec.signers).toContain(OWNER);
  });

  it("auto-builds proof from lotteryLeaves when proof omitted", async () => {
    const { lucid } = mockLucid("addr_user");
    const res = await buildRedeemTx({
      ...base, lucid,
      claimAccountUtxo: claimUtxo(0n),
      treasuryUtxo: treasuryUtxo(1_000_000_000n),
      merkleBeaconUtxo: beaconUtxo(7n, ROOT),
      lotteryLeaves: leaves,
    });
    expect(res.released).toBe(300_000_000n);
  });

  it("rejects double-redeem (released ≤ 0)", async () => {
    const { lucid } = mockLucid("addr_user");
    await expect(buildRedeemTx({
      ...base, lucid,
      claimAccountUtxo: claimUtxo(300_000_000n),   // already redeemed all
      treasuryUtxo: treasuryUtxo(1_000_000_000n),
      merkleBeaconUtxo: beaconUtxo(7n, ROOT),
      proof: tree.proofs.get(OWNER)!,
    })).rejects.toThrow(/released ≤ 0/);
  });

  it("rejects invalid proof (wrong root)", async () => {
    const { lucid } = mockLucid("addr_user");
    await expect(buildRedeemTx({
      ...base, lucid,
      claimAccountUtxo: claimUtxo(0n),
      treasuryUtxo: treasuryUtxo(1_000_000_000n),
      merkleBeaconUtxo: beaconUtxo(7n, "00".repeat(32)),   // bogus root
      proof: tree.proofs.get(OWNER)!,
    })).rejects.toThrow(/proof không hợp lệ/);
  });

  it("rejects won > claimed (C-RDM-5)", async () => {
    const { lucid } = mockLucid("addr_user");
    await expect(buildRedeemTx({
      ...base, lucid,
      claimAccountUtxo: claimUtxo(0n, 200_000_000n),   // claimed only 200 < won 300
      treasuryUtxo: treasuryUtxo(1_000_000_000n),
      merkleBeaconUtxo: beaconUtxo(7n, ROOT),
      proof: tree.proofs.get(OWNER)!,
    })).rejects.toThrow(/won_cumulative .* > claimed_cumulative/);
  });

  it("rejects treasury with insufficient LAMP", async () => {
    const { lucid } = mockLucid("addr_user");
    await expect(buildRedeemTx({
      ...base, lucid,
      claimAccountUtxo: claimUtxo(0n),
      treasuryUtxo: treasuryUtxo(100_000_000n),     // only 100 < released 300
      merkleBeaconUtxo: beaconUtxo(7n, ROOT),
      proof: tree.proofs.get(OWNER)!,
    })).rejects.toThrow(/< released/);
  });

  it("rejects beacon epoch mismatch", async () => {
    const { lucid } = mockLucid("addr_user");
    await expect(buildRedeemTx({
      ...base, lucid,
      claimAccountUtxo: claimUtxo(0n),
      treasuryUtxo: treasuryUtxo(1_000_000_000n),
      merkleBeaconUtxo: beaconUtxo(99n, ROOT),       // epoch ≠ lotteryEpoch 7
      proof: tree.proofs.get(OWNER)!,
    })).rejects.toThrow(/beacon epoch .* ≠ lotteryEpoch/);
  });
});
