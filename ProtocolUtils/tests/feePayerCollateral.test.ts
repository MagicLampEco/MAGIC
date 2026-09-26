// tests/feePayerCollateral.test.ts — `collateralCompleteOptions`: hình dạng tuỳ chọn thế chấp.
import { describe, it, expect } from "vitest";
import { collateralCompleteOptions, FEE_PAYER_DEFAULT_COLLATERAL_LOVELACE } from "../src/index.js";

describe("collateralCompleteOptions", () => {
  it("undefined ⟹ undefined (giữ hành vi cũ của bộ dựng)", () => {
    expect(collateralCompleteOptions(undefined)).toBeUndefined();
  });

  it("bigint > 0 ⟹ { setCollateral } đúng giá trị", () => {
    expect(collateralCompleteOptions(FEE_PAYER_DEFAULT_COLLATERAL_LOVELACE)).toEqual({ setCollateral: 3_000_000n });
  });

  it("CẶP: 0, âm, hay số JSON ⟹ NÉM, không đệm về mặc định của lucid", () => {
    expect(() => collateralCompleteOptions(0n)).toThrow(RangeError);
    expect(() => collateralCompleteOptions(-1n)).toThrow(RangeError);
    expect(() => collateralCompleteOptions(3_000_000 as unknown as bigint)).toThrow(RangeError);
  });
});
