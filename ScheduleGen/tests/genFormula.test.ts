// BẢN CHÉP CÓ NHÃN của InstantGen/tests/genFormula.test.ts @ 1e9a72d9.
// tests/genFormula.test.ts — vector TV-GEN-* cho công thức sinh Gen v2.0 (SPEC §6.1.1–§6.1.3).
// P8: cùng vector được chạy ở `onchain/lib/magiclamp/protocol/gen_formula.ak` (aiken check).

import { describe, it, expect } from "vitest";
import {
  type EpochUsage,
  lampBaseAmount, usageRatioQ, usageFactorQ, usageFactorColdstartQ, scaleLimit,
  amountByLamp, generationAmount, gbVaultShare, shiftWindow, windowAdd,
} from "../offchain/src/genFormula.js";
import {
  Q, GB_SHARD_CAP_NANOGIC, RHO_MAX_Q, INSTANT_SCALE_HORIZON, USAGE_FACTOR_FLOOR_Q,
  LENT_PP_CAP,
} from "../offchain/src/constants.js";
import {
  type GenCell,
  TV_GEN_WINDOWS, TV_GEN_BASE, TV_GEN_USAGE, TV_GEN_SCALE, TV_GEN_AMOUNT, TV_GEN_GB,
  TV_GEN_VAULT_SHARE, TV_GEN_SHIFT, TV_GEN_ADD_01,
} from "./vectors.js";

const win = (cells: readonly GenCell[]): EpochUsage[] =>
  cells.map(([generated, consumed]) => ({ generated, consumed }));
const cells = (w: EpochUsage[]): [bigint, bigint][] => w.map(u => [u.generated, u.consumed]);

describe("TV-GEN-BASE — lampBaseAmount", () => {
  for (const v of TV_GEN_BASE) {
    it(v.id, () => expect(lampBaseAmount(v.l_owned, v.l_lent, v.rho_q)).toBe(v.expected));
  }
  it("âm ⟹ ném", () => {
    expect(() => lampBaseAmount(-1n, 0n, 4_000_000_000n)).toThrow();
    expect(() => lampBaseAmount(0n, -1n, 4_000_000_000n)).toThrow();
    expect(() => lampBaseAmount(1n, 0n, -1n)).toThrow();
  });
});

describe("TV-GEN-USAGE — usageRatioQ / usageFactorQ", () => {
  it("coldstart = điểm giữa dải", () => expect(usageFactorColdstartQ()).toBe(750_000_000n));
  for (const v of TV_GEN_USAGE) {
    it(v.id, () => {
      const w = win(TV_GEN_WINDOWS[v.window]);
      expect(usageRatioQ(w)).toBe(v.ratio_q);
      expect(usageFactorQ(w)).toBe(v.factor_q);
    });
  }
  it("cửa sổ sai hình dạng ⟹ ném", () => {
    const six = win(TV_GEN_WINDOWS.full).slice(0, 6);
    const eight = [...win(TV_GEN_WINDOWS.full), { generated: 0n, consumed: 0n }];
    const neg = win(TV_GEN_WINDOWS.full); neg[1] = { generated: 1n, consumed: -1n };
    const negOpen = win(TV_GEN_WINDOWS.full); negOpen[0] = { generated: -1n, consumed: 0n };
    for (const w of [six, eight, neg, negOpen]) expect(() => usageRatioQ(w)).toThrow();
  });
});

describe("TV-GEN-SCALE — scaleLimit", () => {
  for (const v of TV_GEN_SCALE) {
    it(v.id, () => expect(scaleLimit(win(TV_GEN_WINDOWS[v.window]), v.horizon, v.base)).toBe(v.expected));
  }
  it("base âm ⟹ ném", () => expect(() => scaleLimit(win(TV_GEN_WINDOWS.full), 6n, -1n)).toThrow());
});

describe("TV-GEN-AMOUNT — amountByLamp", () => {
  it("horizon InstantGen = 6", () => expect(INSTANT_SCALE_HORIZON).toBe(6n));
  it("RHO_MAX_Q của vector tràn số", () => expect(RHO_MAX_Q).toBe(4_000_000_000n));
  for (const v of TV_GEN_AMOUNT) {
    it(v.id, () => expect(
      amountByLamp(v.l_owned, v.l_lent, win(TV_GEN_WINDOWS[v.window]), v.rho_q, v.horizon),
    ).toBe(v.expected));
  }
  it("TV-GEN-AMOUNT-OVERFLOW: Number làm hỏng, BigInt thì không", () => {
    expect(lampBaseAmount(36_000_000_000_000_000n, 0n, RHO_MAX_Q)).toBe(144_000_000_000_000_000n);
    expect(Number.isSafeInteger(36e15 * 4e9)).toBe(false);
  });
  it("cửa sổ hỏng ⟹ ném cả khi horizon = 0", () =>
    expect(() => amountByLamp(1n, 0n, [{ generated: 0n, consumed: 0n }], 4_000_000_000n, 0n)).toThrow());

  // Phanh vật lý (SPEC §6.1.5): amount_by_lamp ≤ lamp_base_amount, và phần trên sàn
  // không vượt scale_limit. Quét tất định trên một lưới đầu vào.
  it("bất biến: sàn ≤ amount ≤ base, uf ∈ [sàn, Q]", () => {
    let seed = 12345n;
    const rnd = (mod: bigint) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return seed % mod; };
    for (let i = 0; i < 2000; i++) {
      const w: EpochUsage[] = Array.from({ length: 7 }, () => {
        const g = rnd(4n) === 0n ? 0n : rnd(10_000_000_000n);
        return { generated: g, consumed: rnd(g + 1n) };
      });
      const lOwned = rnd(36_000_000_000_000_000n), lLent = rnd(2_000_000_000n);
      const rho = rnd(RHO_MAX_Q + 1n), h = 1n + rnd(6n);
      const base = lampBaseAmount(lOwned, lLent, rho);
      const a = amountByLamp(lOwned, lLent, w, rho, h);
      const uf = usageFactorQ(w);
      expect(uf >= USAGE_FACTOR_FLOOR_Q && uf <= Q).toBe(true);
      expect(a <= base).toBe(true);
      expect(a >= base * USAGE_FACTOR_FLOOR_Q / Q).toBe(true);
      expect(base <= lOwned * rho / Q + LENT_PP_CAP).toBe(true);
    }
  });
});

describe("TV-GEN-GB — generationAmount", () => {
  for (const v of TV_GEN_GB) {
    it(v.id, () => expect(generationAmount(v.amount_by_lamp, v.gb_available)).toBe(v.expected));
  }
  it("âm ⟹ ném", () => {
    expect(() => generationAmount(3_000_000_000n, -1n)).toThrow();
    expect(() => generationAmount(-1n, 5n)).toThrow();
  });
});

describe("TV-GEN-VAULT-SHARE — gbVaultShare", () => {
  for (const v of TV_GEN_VAULT_SHARE) {
    it(v.id, () => expect(gbVaultShare(v.reset_amount)).toBe(v.expected));
  }
  it("âm ⟹ ném", () => expect(() => gbVaultShare(-1n)).toThrow());
  it("GB_SHARD_CAP_NANOGIC = ⌊SHARD_CAP × 4·10⁹ / Q⌋", () =>
    expect(GB_SHARD_CAP_NANOGIC).toBe(450_000_000_000_000n * 4_000_000_000n / Q));
});

describe("TV-GEN-SHIFT / ADD — cửa sổ", () => {
  for (const v of TV_GEN_SHIFT) {
    it(v.id, () => expect(cells(shiftWindow(win(TV_GEN_WINDOWS.seq), v.from_epoch, v.to_epoch)))
      .toEqual(v.expected.map(c => [...c])));
  }
  it("lùi thời gian ⟹ ném", () => expect(() => shiftWindow(win(TV_GEN_WINDOWS.seq), 100n, 99n)).toThrow());
  it("cửa sổ hỏng ⟹ ném", () => expect(() => shiftWindow([{ generated: 0n, consumed: 0n }], 100n, 100n)).toThrow());
  it(TV_GEN_ADD_01.id, () => expect(cells(windowAdd(win(TV_GEN_WINDOWS.seq), TV_GEN_ADD_01.generated, TV_GEN_ADD_01.consumed)))
    .toEqual(TV_GEN_ADD_01.expected.map(c => [...c])));
  it("add âm ⟹ ném", () => expect(() => windowAdd(win(TV_GEN_WINDOWS.seq), 10n, -1n)).toThrow());
});
