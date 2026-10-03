// tests/consume_many.test.ts — redeemer ConsumeMany (constr 3), THÊM 2026-10-03.
//
// P8: required sàn TỪNG cặp rồi cộng, trùng bit với on-chain `pricing.required_for_pairs`
// (vector TV-PAIRS-* ở vectors.ts, cùng số với bài Aiken). Hình dạng `pairs` gương
// `pricing.valid_pairs`. Codec constr 3 ghim BYTES chéo với Aiken
// (`consume_many_redeemer_cbor_pinned` trong validators/consume.ak).
//
// Thuần số học + codec — KHÔNG cần network/Lucid emulator.

import { describe, it, expect } from "vitest";
import { Constr, Data } from "@lucid-evolution/lucid";
import {
  requiredForPairs, requiredForOp, assertValidPairs, sumPairCounts, MAX_CONSUME_PAIRS,
  MAX_OP_PRICES, Q, type PriceTable,
} from "@magiclamp/consumemagic-pricing";
import { requiredFromBeacon, requiredFromBeaconPairs } from "../offchain/src/consume.js";
import {
  encodeConsumeManyRedeemer, decodeConsumeManyRedeemer, CONSUME_MANY_REDEEMER_CONSTR,
  OP_PAIR_CONSTR, CONSUME_REDEEMER_CONSTR, BIND_DID_REDEEMER_CONSTR,
  CLOSE_THREAD_REDEEMER_CONSTR, type PriceParamT, type ConsumeManyRedeemerT,
} from "../offchain/src/types.js";
import { TV_PAIRS_TABLE, TV_PAIRS_001, TV_PAIRS_002 } from "./vectors.js";

const table: PriceTable = TV_PAIRS_TABLE;
const beacon: PriceParamT = {
  op_prices: Object.entries(TV_PAIRS_TABLE).map(([t, r]) => ({
    op_type: BigInt(t), base_price: r.base_price, demand_mult: r.demand_mult,
  })),
  m_min: 500_000_000n,
  m_max: 2_000_000_000n,
  epoch: 6n,
};

/** Quy tắc SAI, viết ra để chứng minh vector phân biệt được hai quy tắc. */
const sumThenFloor = (pairs: ReadonlyArray<{ opType: number; opCount: bigint }>): bigint =>
  pairs.reduce((acc, p) => {
    const r = TV_PAIRS_TABLE[p.opType as 1 | 2];
    return acc + r.base_price * r.demand_mult * p.opCount;
  }, 0n) / Q;

describe("TV-PAIRS — required sàn TỪNG cặp rồi cộng (P8 với pricing.required_for_pairs)", () => {
  for (const v of [TV_PAIRS_001, TV_PAIRS_002]) {
    it(`${v.id}: bảng giá (requiredForPairs) == beacon (requiredFromBeaconPairs) == vector`, () => {
      expect(requiredForPairs(v.pairs, table)).toBe(v.required);
      expect(requiredFromBeaconPairs(beacon, v.pairs)).toBe(v.required);
      expect(v.pairs.map((p) => requiredForOp(p.opType, p.opCount, table))).toEqual([...v.per_pair]);
      expect(sumPairCounts(v.pairs)).toBe(v.count_delta);
    });
    it(`${v.id}: CỰC ĐỐI — cộng-rồi-sàn ra số KHÁC (vector phân biệt được hai quy tắc)`, () => {
      expect(sumThenFloor(v.pairs)).toBe(v.sum_then_floor);
      expect(v.sum_then_floor).not.toBe(v.required);
    });
  }
  it("một cặp == requiredFromBeacon của Consume đơn (hai nhánh không lệch giá)", () => {
    expect(requiredFromBeaconPairs(beacon, [{ opType: 1, opCount: 3n }]))
      .toBe(requiredFromBeacon(beacon, 1, 3n));
  });
  it("op_type vắng trong beacon ⇒ CONSUME-007 (không fallback)", () => {
    expect(() => requiredFromBeaconPairs(beacon, [{ opType: 1, opCount: 1n }, { opType: 9, opCount: 1n }]))
      .toThrow(/CONSUME-007/);
  });
});

describe("assertValidPairs — gương pricing.valid_pairs", () => {
  const run = (n: number, from = 1) =>
    Array.from({ length: n }, (_, i) => ({ opType: from + i, opCount: 1n }));
  it("DƯƠNG: 1 cặp, nhiều cặp tăng ngặt, đúng trần", () => {
    expect(() => assertValidPairs(run(1))).not.toThrow();
    expect(() => assertValidPairs([{ opType: 1, opCount: 1n }, { opType: 4, opCount: 9n }])).not.toThrow();
    expect(() => assertValidPairs(run(MAX_CONSUME_PAIRS))).not.toThrow();
  });
  it("ÂM: rỗng ⇒ PRICE-020", () => expect(() => assertValidPairs([])).toThrow(/PRICE-020/));
  it("ÂM: quá trần MỘT cặp ⇒ PRICE-021", () =>
    expect(() => assertValidPairs(run(MAX_CONSUME_PAIRS + 1))).toThrow(/PRICE-021/));
  it("ÂM: op_count 0 ở cặp đầu và cặp sau ⇒ PRICE-022", () => {
    expect(() => assertValidPairs([{ opType: 1, opCount: 0n }])).toThrow(/PRICE-022/);
    expect(() => assertValidPairs([{ opType: 1, opCount: 1n }, { opType: 2, opCount: 0n }])).toThrow(/PRICE-022/);
  });
  it("ÂM: op_type trùng / giảm ⇒ PRICE-023", () => {
    expect(() => assertValidPairs([{ opType: 1, opCount: 1n }, { opType: 1, opCount: 1n }])).toThrow(/PRICE-023/);
    expect(() => assertValidPairs([{ opType: 2, opCount: 1n }, { opType: 1, opCount: 1n }])).toThrow(/PRICE-023/);
  });
  it("trần nhỏ hơn bảng giá (nên cổng độ dài có tải, không bị bảng giá che)", () => {
    expect(MAX_CONSUME_PAIRS).toBe(8);
    expect(MAX_CONSUME_PAIRS).toBeLessThan(MAX_OP_PRICES);
  });
});

describe("ConsumeMany codec — Constr 3 [List<Constr 0 [op_type, op_count]>, price_ref, vault_ref]", () => {
  const r: ConsumeManyRedeemerT = {
    pairs: [{ op_type: 1n, op_count: 1n }, { op_type: 2n, op_count: 3n }],
    price_ref: { transaction_id: "bb", output_index: 9n },
    vault_ref: { transaction_id: "a1", output_index: 0n },
  };
  it("chỉ số constructor: 0/1/2 cũ không đổi, ConsumeMany = 3, OpPair = 0", () => {
    expect([CONSUME_REDEEMER_CONSTR, BIND_DID_REDEEMER_CONSTR, CLOSE_THREAD_REDEEMER_CONSTR,
      CONSUME_MANY_REDEEMER_CONSTR, OP_PAIR_CONSTR]).toEqual([0, 1, 2, 3, 0]);
  });
  it("round-trip + hình dạng Plutus Data", () => {
    const cbor = encodeConsumeManyRedeemer(r);
    expect(decodeConsumeManyRedeemer(cbor)).toEqual(r);
    const raw = Data.from(cbor) as Constr<Data>;
    expect(raw.index).toBe(3);
    expect(raw.fields.length).toBe(3);
  });
  it("bytes trùng Aiken cbor.serialise (consume_many_redeemer_cbor_pinned)", () => {
    expect(encodeConsumeManyRedeemer(r)).toBe(AIKEN_CONSUME_MANY_CBOR);
  });
  it("ÂM: bytes của Consume (constr 0) không giải mã thành ConsumeMany", () => {
    const c0 = Data.to(new Constr(0, [1n, 1n, new Constr(0, ["bb", 9n]), new Constr(0, ["a1", 0n])]));
    expect(() => decodeConsumeManyRedeemer(c0)).toThrow(/CONSUME-017/);
  });
});

// Chép có nhãn — nguồn: validators/consume.ak ▸ `consume_many_redeemer_cbor_pinned`
// (Aiken `cbor.serialise`), 2026-10-03. Hai bên phải đổi cùng commit.
const AIKEN_CONSUME_MANY_CBOR = "d87c9f9fd8799f0101ffd8799f0203ffffd8799f41bb09ffd8799f41a100ffff";
