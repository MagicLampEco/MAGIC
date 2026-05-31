import { describe, it, expect } from "vitest";
import { Constr, Data } from "@lucid-evolution/lucid";
import {
  // ClaimAccount
  encodeClaimAccountDatum, decodeClaimAccountDatum,
  claimAccountDatumToCbor, claimAccountDatumFromCbor,
  // redeemers
  encodeClaimRedeemer, encodeRedeemRedeemer,
  claimRedeemerToCbor, redeemRedeemerToCbor,
  CLAIM_ACCOUNT_REDEEMER,
  // beacon
  encodeBeaconKind, decodeBeaconKind, BEACON_KIND_INDEX,
  encodeBeaconDatum, decodeBeaconDatum,
  beaconDatumToCbor, beaconDatumFromCbor,
  encodeBeaconRedeemer,
  // treasury
  encodeTreasuryDatum, decodeTreasuryDatum,
  treasuryDatumToCbor, treasuryDatumFromCbor,
  encodeTreasuryRedeemer,
} from "../offchain/src/datum.js";
import type {
  ClaimAccountDatum, BeaconDatum, BeaconKind, TreasuryDatum,
} from "../offchain/src/types.js";

// helper: parse cbor → Constr để soi index/fields đúng thứ tự types.ak.
function asConstr(cbor: string): Constr<Data> {
  const d = Data.from(cbor);
  if (!(d instanceof Constr)) throw new Error("not a Constr");
  return d;
}

describe("ClaimAccountDatum", () => {
  const sample: ClaimAccountDatum = {
    owner:               "aabbccddeeff00112233445566778899aabbccddeeff001122334455",
    claimed_cumulative:  250_000_000n,
    redeemed_cumulative: 100_000_000n,
    last_claim_epoch:    42n,
  };

  it("round-trips encode→decode", () => {
    const back = decodeClaimAccountDatum(encodeClaimAccountDatum(sample));
    expect(back).toEqual(sample);
  });

  it("round-trips via CBOR", () => {
    expect(claimAccountDatumFromCbor(claimAccountDatumToCbor(sample))).toEqual(sample);
  });

  it("Constr index 0 with [bytes, int, int, int] in declared order", () => {
    const c = asConstr(claimAccountDatumToCbor(sample));
    expect(c.index).toBe(0);
    expect(c.fields).toHaveLength(4);
    expect(c.fields[0]).toBe(sample.owner);                 // owner (bytes)
    expect(c.fields[1]).toBe(sample.claimed_cumulative);    // int
    expect(c.fields[2]).toBe(sample.redeemed_cumulative);   // int
    expect(c.fields[3]).toBe(sample.last_claim_epoch);      // int
  });

  it("normalizes 0x-prefixed + uppercase owner hex", () => {
    const d: ClaimAccountDatum = { ...sample, owner: "0xAABB" };
    const c = asConstr(claimAccountDatumToCbor(d));
    expect(c.fields[0]).toBe("aabb");
  });

  it("rejects wrong field count / wrong constr", () => {
    expect(() => decodeClaimAccountDatum(new Constr(0, [1n, 2n]))).toThrow();
    expect(() => decodeClaimAccountDatum(new Constr(1, ["aa", 1n, 2n, 3n]))).toThrow();
  });
});

describe("ClaimAccountRedeemer", () => {
  it("Claim = Constr(0, [int])", () => {
    expect(CLAIM_ACCOUNT_REDEEMER.Claim).toBe(0);
    const c = asConstr(claimRedeemerToCbor(123_000_000n));
    expect(c.index).toBe(0);
    expect(c.fields).toEqual([123_000_000n]);
    // encode object form matches
    const e = encodeClaimRedeemer(123_000_000n);
    expect(e.index).toBe(0);
    expect(e.fields).toEqual([123_000_000n]);
  });

  it("Redeem = Constr(1, [int, int, List<bytes>])", () => {
    expect(CLAIM_ACCOUNT_REDEEMER.Redeem).toBe(1);
    const proof = ["aabb", "ccdd"];
    const c = asConstr(redeemRedeemerToCbor(500_000_000n, 7n, proof));
    expect(c.index).toBe(1);
    expect(c.fields[0]).toBe(500_000_000n);    // won_cumulative
    expect(c.fields[1]).toBe(7n);              // lottery_epoch
    expect(c.fields[2]).toEqual(["aabb", "ccdd"]); // proof: List<bytes>
  });

  it("Redeem normalizes proof hex (0x + case)", () => {
    const e = encodeRedeemRedeemer(1n, 1n, ["0xAABB", "CCDD"]);
    expect(e.fields[2]).toEqual(["aabb", "ccdd"]);
  });

  it("Redeem handles empty proof (single-leaf tree)", () => {
    const c = asConstr(redeemRedeemerToCbor(1n, 1n, []));
    expect(c.fields[2]).toEqual([]);
  });
});

describe("BeaconKind", () => {
  it("PParam=0, Randomness=1, MerkleRoot=2", () => {
    expect(BEACON_KIND_INDEX).toEqual({ PParam: 0, Randomness: 1, MerkleRoot: 2 });
  });

  it("round-trips every kind + verifies index", () => {
    for (const [kind, idx] of Object.entries(BEACON_KIND_INDEX) as [BeaconKind, number][]) {
      const enc = encodeBeaconKind(kind);
      expect(enc.index).toBe(idx);
      expect(enc.fields).toEqual([]);
      expect(decodeBeaconKind(enc)).toBe(kind);
    }
  });

  it("rejects kind with fields / unknown index", () => {
    expect(() => decodeBeaconKind(new Constr(0, ["aa"]))).toThrow();
    expect(() => decodeBeaconKind(new Constr(9, []))).toThrow();
  });
});

describe("BeaconDatum", () => {
  const samples: BeaconDatum[] = [
    { epoch: 10n, kind: "PParam",     value: "05f5e100" },
    { epoch: 11n, kind: "Randomness", value: "00".repeat(32) },
    { epoch: 12n, kind: "MerkleRoot", value: "ff".repeat(32) },
  ];

  it("round-trips each kind via CBOR", () => {
    for (const s of samples) {
      expect(beaconDatumFromCbor(beaconDatumToCbor(s))).toEqual(s);
    }
  });

  it("Constr(0, [int, BeaconKind, bytes]) declared order", () => {
    const s = samples[1]!; // Randomness
    const c = asConstr(beaconDatumToCbor(s));
    expect(c.index).toBe(0);
    expect(c.fields).toHaveLength(3);
    expect(c.fields[0]).toBe(11n);                          // epoch
    expect(c.fields[1]).toBeInstanceOf(Constr);
    expect((c.fields[1] as Constr<Data>).index).toBe(1);   // kind = Randomness
    expect(c.fields[2]).toBe("00".repeat(32));             // value bytes
  });

  it("decode object form matches", () => {
    const s = samples[2]!;
    expect(decodeBeaconDatum(encodeBeaconDatum(s))).toEqual(s);
  });
});

describe("TreasuryDatum", () => {
  const sample: TreasuryDatum = { committee_hash: "deadbeef".repeat(4) };

  it("round-trips via CBOR", () => {
    expect(treasuryDatumFromCbor(treasuryDatumToCbor(sample))).toEqual(sample);
  });

  it("Constr(0, [bytes])", () => {
    const c = asConstr(treasuryDatumToCbor(sample));
    expect(c.index).toBe(0);
    expect(c.fields).toEqual([sample.committee_hash]);
  });

  it("decode object form matches", () => {
    expect(decodeTreasuryDatum(encodeTreasuryDatum(sample))).toEqual(sample);
  });
});

describe("unit redeemers (no fields)", () => {
  it("BeaconRedeemer PostBeacon = Constr(0, [])", () => {
    const c = encodeBeaconRedeemer();
    expect(c.index).toBe(0);
    expect(c.fields).toEqual([]);
  });

  it("TreasuryRedeemer ReleaseForRedeem = Constr(0, [])", () => {
    const c = encodeTreasuryRedeemer();
    expect(c.index).toBe(0);
    expect(c.fields).toEqual([]);
  });
});
