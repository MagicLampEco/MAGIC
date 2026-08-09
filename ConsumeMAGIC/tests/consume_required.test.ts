// tests/consume_required.test.ts — FIX #3 (P8 fold-floor) + #4 (price authority).
//
// requiredFromBeacon = ĐÚNG hàm buildConsumeTx dùng trên đường tiền (money path).
// Kiểm: (a) đọc base_price TỪ beacon (khác MVP → required theo beacon), (b) fold-floor-
// once khớp on-chain pricing.required_for byte-perfect, (c) op_type vắng → throw.
//
// Thuần số học BigInt — KHÔNG cần network/Lucid.

import { describe, it, expect } from "vitest";
import { requiredFromBeacon } from "../offchain/src/consume.js";
import { requiredForOp, MVP_BASE_PRICE, OP_IMAGE } from "@magiclamp/consumemagic-pricing";
import type { PriceParamT } from "../offchain/src/types.js";

// beacon với base_price KHÁC bảng MVP (MVP op_type=1 = 10_000_000; ở đây = 3_000_000).
// Governance PostPrice đổi giá ⇒ off-chain PHẢI theo beacon, KHÔNG dùng MVP.
const beacon: PriceParamT = {
  op_prices: [
    { op_type: 1n, base_price: 3_000_000n }, // ≠ MVP 10_000_000
    { op_type: 2n, base_price: 500_000n }, //   ≠ MVP 1_000_000
  ],
  demand_mult: 1_000_000_000n, // 1.0×
  m_min: 500_000_000n,
  m_max: 2_000_000_000n,
  epoch: 6n,
};

describe("FIX #4 — required reads base_price FROM beacon datum (not MVP table)", () => {
  it("uses beacon base_price, diverging from the hardcoded MVP table", () => {
    const req = requiredFromBeacon(beacon, 1, 5n);
    // beacon: 3_000_000 × 1e9 × 5 / 1e9 = 15_000_000
    expect(req).toBe(15_000_000n);
    // MVP would have (wrongly) given 10_000_000 × 5 = 50_000_000 → proves it is NOT MVP
    expect(req).not.toBe(MVP_BASE_PRICE[OP_IMAGE]! * 5n);
  });

  it("throws CONSUME-007 when op_type absent from beacon (no silent MVP fallback)", () => {
    expect(() => requiredFromBeacon(beacon, 99, 1n)).toThrow(/CONSUME-007/);
  });
});

describe("FIX #3 — P8: requiredFromBeacon == on-chain fold-floor value", () => {
  // NORMATIVE parity vector (== Aiken required_fold_floor_no_undercharge
  //  == pricing requiredBurn parity anchor): base=1e6, demand=1_333_333_333, count=1000.
  const parityBeacon: PriceParamT = {
    op_prices: [{ op_type: 1n, base_price: 1_000_000n }],
    demand_mult: 1_333_333_333n,
    m_min: 500_000_000n,
    m_max: 2_000_000_000n,
    epoch: 6n,
  };

  it("fold-floor-once matches on-chain = 1_333_333_333 (not 1_333_333_000)", () => {
    expect(requiredFromBeacon(parityBeacon, 1, 1000n)).toBe(1_333_333_333n);
  });

  it("agrees with pricing.requiredForOp for the same inputs (P8 across off-chain modules)", () => {
    const viaBeacon = requiredFromBeacon(beacon, 1, 7n);
    const viaPricing = requiredForOp(1, 7n, beacon.demand_mult, { 1: 3_000_000n });
    expect(viaBeacon).toBe(viaPricing);
  });

  it("op_count < 1 clamps to 0 (matches count>0 guard)", () => {
    expect(requiredFromBeacon(beacon, 1, 0n)).toBe(0n);
    expect(requiredFromBeacon(beacon, 1, -3n)).toBe(0n);
  });
});
