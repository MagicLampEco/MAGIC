// tests/codec.test.ts — P8 codec round-trip cho ENGAGEMENT layer v2.
// Xác minh EngageDatum/PriceParam/ConsumeRedeemer encode/decode byte-perfect +
// constructor index khớp Aiken (onchain/lib/magiclamp/consume/types.ak).
//
// KHÔNG cần network: thuần Data.to/Data.from (Lucid Evolution Plutus Data codec).

import { describe, it, expect } from "vitest";
import { Data, Constr } from "@lucid-evolution/lucid";
import {
  EngageDatumSchema, PriceParamSchema, ConsumeRedeemerSchema, OutputReferenceSchema,
  EngageMintRedeemerSchema,
  encodeEngageDatum, decodeEngageDatum, encodePriceParam, decodePriceParam,
  encodeConsumeRedeemer, encodeEngageMintRedeemer, decodeEngageMintRedeemer,
  type EngageDatumT, type PriceParamT, type EngageMintRedeemerT,
} from "../offchain/src/types.js";

const engage: EngageDatumT = {
  owner: "0bada55e",
  consumed_count: 10n,
  last_epoch: 0n,
  did_commit: "", // MVP rỗng
  consumed_nanogic: 0n,
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

describe("EngageDatum codec — 5 trường (constr 0: owner, consumed_count, last_epoch, did_commit, consumed_nanogic)", () => {
  it("round-trips byte-perfect", () => {
    const cbor = encodeEngageDatum(engage);
    expect(decodeEngageDatum(cbor)).toEqual(engage);
  });

  it("is a Constr index 0 with 5 fields — ĐÚNG THỨ TỰ khai báo trong types.ak", () => {
    // Thiếu `consumed_nanogic` ⇒ Constr 0 chỉ 4 field ⇒ on-chain `expect ed: EngageDatum`
    // nổ ⇒ mint thread hỏng và mọi consume tx bị từ chối. Kiểm THẲNG số field trong
    // CBOR, không chỉ round-trip (round-trip khớp với chính mình dù thiếu field).
    const raw = Data.from(encodeEngageDatum(engage)) as { fields: unknown[]; index: number };
    expect(raw.index).toBe(0);
    expect(raw.fields).toHaveLength(5);
    expect(raw.fields).toEqual(["0bada55e", 10n, 0n, "", 0n]);

    const d = decodeEngageDatum(encodeEngageDatum(engage));
    expect(d.owner).toBe("0bada55e");
    expect(d.consumed_count).toBe(10n);
    expect(d.last_epoch).toBe(0n);
    expect(d.did_commit).toBe("");
    expect(d.consumed_nanogic).toBe(0n);
  });

  it("consumed_nanogic mang giá trị lớn (tích luỹ đời thread) round-trip", () => {
    const busy: EngageDatumT = {
      ...engage,
      consumed_count: 1_234n,
      consumed_nanogic: 12_345_678_901_234n,
    };
    expect(decodeEngageDatum(encodeEngageDatum(busy))).toEqual(busy);
  });

  it("did_commit non-empty round-trips (future DID commitment)", () => {
    const withDid: EngageDatumT = { ...engage, did_commit: "deadbeef" };
    expect(decodeEngageDatum(encodeEngageDatum(withDid))).toEqual(withDid);
  });

  it("datum genesis SẠCH: ba trục kế toán đều 0 (validate_mint_engage_id)", () => {
    const genesis: EngageDatumT = {
      owner: "0bada55e",
      consumed_count: 0n,
      last_epoch: 0n,
      did_commit: "",
      consumed_nanogic: 0n,
    };
    const raw = Data.from(encodeEngageDatum(genesis)) as { fields: unknown[] };
    expect(raw.fields[1]).toBe(0n); // consumed_count
    expect(raw.fields[2]).toBe(0n); // last_epoch — state tích luỹ, KHÔNG phải epoch hiện tại
    expect(raw.fields[4]).toBe(0n); // consumed_nanogic
  });
});

describe("EngageMintRedeemer codec (MintEngage { seed } — Constr 0 [ Constr 0 [bytes, int] ])", () => {
  const seedTx = "0000000000000000000000000000000000000000000000000000000000000001";
  const rd: EngageMintRedeemerT = {
    seed: { transaction_id: seedTx, output_index: 0n },
  };

  it("round-trips byte-perfect", () => {
    expect(decodeEngageMintRedeemer(encodeEngageMintRedeemer(rd))).toEqual(rd);
  });

  it("bytes == Constr 0 [ Constr 0 [txHash, index] ] dựng tay", () => {
    // Cùng dạng với MintVaultId của 4 vault gen (khuôn one-shot dùng chung).
    const manual = Data.to(new Constr(0, [new Constr(0, [seedTx, 0n])]));
    expect(encodeEngageMintRedeemer(rd)).toBe(manual);
  });

  it("output_index thực sự đi vào bytes (không bị bỏ qua)", () => {
    const other: EngageMintRedeemerT = {
      seed: { transaction_id: seedTx, output_index: 7n },
    };
    expect(encodeEngageMintRedeemer(other)).not.toBe(encodeEngageMintRedeemer(rd));
  });

  it("schema decode được bytes dựng tay", () => {
    const manual = Data.to(new Constr(0, [new Constr(0, [seedTx, 7n])]));
    expect(Data.from(manual, EngageMintRedeemerSchema)).toEqual({
      seed: { transaction_id: seedTx, output_index: 7n },
    });
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
