// tests/codec.test.ts — P8 codec round-trip cho ENGAGEMENT layer v2.
// Xác minh EngageDatum/PriceParam/ConsumeRedeemer encode/decode byte-perfect +
// constructor index khớp Aiken (onchain/lib/magiclamp/consume/types.ak).
//
// KHÔNG cần network: thuần Data.to/Data.from (Lucid Evolution Plutus Data codec).

import { describe, it, expect } from "vitest";
import { Data } from "@lucid-evolution/lucid";
import {
  EngageDatumSchema, PriceParamSchema, ConsumeRedeemerSchema, OutputReferenceSchema,
  encodeEngageDatum, decodeEngageDatum, encodePriceParam, decodePriceParam,
  encodeConsumeRedeemer,
  type EngageDatumT, type PriceParamT,
} from "../offchain/src/types.js";

const engage: EngageDatumT = {
  owner: "0bada55e",
  consumed_count: 10n,
  last_epoch: 0n,
  did_commit: "", // MVP rỗng
};

const pp: PriceParamT = {
  op_prices: [
    { op_type: 1n, base_price: 10_000_000n },
    { op_type: 2n, base_price: 1_000_000n },
  ],
  demand_mult: 1_000_000_000n,
  m_min: 500_000_000n,
  m_max: 2_000_000_000n,
  epoch: 6n,
};

describe("EngageDatum codec (constr 0: owner, consumed_count, last_epoch, did_commit)", () => {
  it("round-trips byte-perfect", () => {
    const cbor = encodeEngageDatum(engage);
    expect(decodeEngageDatum(cbor)).toEqual(engage);
  });

  it("is a Constr index 0 with 4 fields", () => {
    // CBOR Plutus Constr 0 (single-field tuple) bắt đầu 0xd8 0x79 (tag 121) hoặc
    // dạng định nghĩa: kiểm field order qua decode lại + so sánh field-by-field.
    const d = decodeEngageDatum(encodeEngageDatum(engage));
    // field 1 = owner (bytes), field 2 = consumed_count (int)...
    expect(d.owner).toBe("0bada55e");
    expect(d.consumed_count).toBe(10n);
    expect(d.last_epoch).toBe(0n);
    expect(d.did_commit).toBe("");
  });

  it("did_commit non-empty round-trips (future DID commitment)", () => {
    const withDid: EngageDatumT = { ...engage, did_commit: "deadbeef" };
    expect(decodeEngageDatum(encodeEngageDatum(withDid))).toEqual(withDid);
  });
});

describe("PriceParam codec (constr 0: op_prices, demand_mult, m_min, m_max, epoch)", () => {
  it("round-trips byte-perfect", () => {
    const cbor = encodePriceParam(pp);
    expect(decodePriceParam(cbor)).toEqual(pp);
  });

  it("preserves op_prices order + field order", () => {
    const d = decodePriceParam(encodePriceParam(pp));
    expect(d.op_prices[0]).toEqual({ op_type: 1n, base_price: 10_000_000n });
    expect(d.op_prices[1]).toEqual({ op_type: 2n, base_price: 1_000_000n });
    expect(d.demand_mult).toBe(1_000_000_000n);
    expect(d.m_min).toBe(500_000_000n);
    expect(d.m_max).toBe(2_000_000_000n);
    expect(d.epoch).toBe(6n);
  });
});

describe("ConsumeRedeemer codec (Constr 0: op_type, op_count, price_ref, vault_ref)", () => {
  const redeemer = {
    op_type: 1n,
    op_count: 3n,
    price_ref: { transaction_id: "bb", output_index: 9n },
    vault_ref: { transaction_id: "a1", output_index: 0n },
  };

  it("encodes + decodes round-trip", () => {
    const cbor = encodeConsumeRedeemer(redeemer);
    const back = Data.from(cbor, ConsumeRedeemerSchema);
    expect(back).toEqual(redeemer);
  });

  it("OutputReference is constr 0 { transaction_id, output_index }", () => {
    const ref = { transaction_id: "bb", output_index: 9n };
    const cbor = Data.to(ref, OutputReferenceSchema);
    expect(Data.from(cbor, OutputReferenceSchema)).toEqual(ref);
  });
});

describe("CBOR Constr-0 tag (khớp Aiken constr index 0)", () => {
  // Plutus Data Constr 0 → CBOR tag 121 = 0xd879 (alternative 0). Mọi type ở đây
  // là single-constr Aiken (OutputReference/OpPrice/PriceParam/EngageDatum/Consume)
  // → CBOR phải bắt đầu d879. Sai tag = lệch constr index → vỡ decode on-chain.
  it("EngageDatum CBOR bắt đầu d879", () => {
    expect(encodeEngageDatum(engage).startsWith("d879")).toBe(true);
  });
  it("PriceParam CBOR bắt đầu d879", () => {
    expect(encodePriceParam(pp).startsWith("d879")).toBe(true);
  });
});

describe("CBOR determinism (same struct → same bytes)", () => {
  it("EngageDatum is deterministic", () => {
    expect(encodeEngageDatum(engage)).toBe(encodeEngageDatum({ ...engage }));
  });
  it("PriceParam is deterministic", () => {
    expect(encodePriceParam(pp)).toBe(encodePriceParam({ ...pp }));
  });
});
