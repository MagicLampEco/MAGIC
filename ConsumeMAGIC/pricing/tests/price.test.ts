import { describe, it, expect } from "vitest";
import {
  Q,
  M_MIN_Q,
  M_MAX_Q,
  M_NEUTRAL_Q,
  DEMAND_WINDOW,
  OP_IMAGE,
  OP_CID,
  MVP_BASE_PRICE,
  computeLoadRaw,
  appendLoadHistory,
  smaLoad,
  demandMult,
  pricePerOp,
  requiredBurn,
  requiredForOp,
  assertValidPriceParam,
  toCanonicalOpPrices,
  MAX_OP_PRICES,
  type PriceParamLike,
  type OpPriceRow,
} from "../src/price.js";

// helper: build a window full of the same constant raw load
function constHistory(raw: bigint, n: number = DEMAND_WINDOW): bigint[] {
  return Array.from({ length: n }, () => raw);
}

describe("constants — MVP base-price table", () => {
  it("op_type=1 (image) = 0.01 MAGIC = 10_000_000 nanogic", () => {
    expect(MVP_BASE_PRICE[OP_IMAGE]).toBe(10_000_000n);
  });
  it("op_type=2 (CID) = 0.001 MAGIC = 1_000_000 nanogic", () => {
    expect(MVP_BASE_PRICE[OP_CID]).toBe(1_000_000n);
  });
  it("bounds are 0.5×Q and 2.0×Q", () => {
    expect(M_MIN_Q).toBe(Q / 2n);
    expect(M_MAX_Q).toBe(2n * Q);
    expect(M_NEUTRAL_Q).toBe(Q);
  });
});

describe("TEST VECTOR — price at demand = 1.0", () => {
  it("image = 0.01 MAGIC exactly", () => {
    expect(pricePerOp(OP_IMAGE, Q)).toBe(10_000_000n);
  });
  it("CID = 0.001 MAGIC exactly", () => {
    expect(pricePerOp(OP_CID, Q)).toBe(1_000_000n);
  });
  it("demand=1.0 comes from a steady load_raw=1.0 history (full pipeline)", () => {
    // ops == capacity → load_raw = 1.0 = Q ; SMA = Q ; clamp leaves it = Q
    const raw = computeLoadRaw(1000n, 1000n);
    expect(raw).toBe(Q);
    const m = demandMult(constHistory(raw));
    expect(m).toBe(Q);
    expect(pricePerOp(OP_IMAGE, m)).toBe(10_000_000n);
    expect(pricePerOp(OP_CID, m)).toBe(1_000_000n);
  });
});

describe("computeLoadRaw — Q-format ratio, defensive", () => {
  it("ops==capacity → 1.0", () => {
    expect(computeLoadRaw(500n, 500n)).toBe(Q);
  });
  it("ops==2×capacity → 2.0", () => {
    expect(computeLoadRaw(1000n, 500n)).toBe(2n * Q);
  });
  it("ops==0 → 0", () => {
    expect(computeLoadRaw(0n, 500n)).toBe(0n);
  });
  it("capacity<=0 treated as 1 (no div-by-zero)", () => {
    expect(computeLoadRaw(3n, 0n)).toBe(3n * Q);
    expect(computeLoadRaw(3n, -5n)).toBe(3n * Q);
  });
  it("floor division — never rounds up", () => {
    // 1 op / 3 cap = 0.333... → floor
    expect(computeLoadRaw(1n, 3n)).toBe(Q / 3n);
    expect(computeLoadRaw(1n, 3n)).toBe(333_333_333n);
  });
});

describe("FIR window — appendLoadHistory keeps last N raw values", () => {
  it("keeps at most DEMAND_WINDOW (6) samples", () => {
    let h: bigint[] = [];
    for (let i = 1n; i <= 10n; i++) h = appendLoadHistory(h, i * Q);
    expect(h.length).toBe(DEMAND_WINDOW);
    // oldest dropped: last 6 of 1..10 = 5..10
    expect(h).toEqual([5n * Q, 6n * Q, 7n * Q, 8n * Q, 9n * Q, 10n * Q]);
  });
  it("stores RAW (un-clamped) values", () => {
    // 5.0 is above m_max=2.0 but history keeps it raw
    const h = appendLoadHistory([], 5n * Q);
    expect(h[0]).toBe(5n * Q);
  });
  it("is pure — does not mutate input", () => {
    const orig: bigint[] = [Q];
    const next = appendLoadHistory(orig, 2n * Q);
    expect(orig).toEqual([Q]);
    expect(next).toEqual([Q, 2n * Q]);
  });
});

describe("smaLoad — SMA_N", () => {
  it("empty history → neutral 1.0", () => {
    expect(smaLoad([])).toBe(M_NEUTRAL_Q);
  });
  it("average of [0.5,1.0,1.5] = 1.0", () => {
    expect(smaLoad([Q / 2n, Q, (3n * Q) / 2n])).toBe(Q);
  });
  it("floor division on average", () => {
    // (Q + Q + Q) / ... use values that don't divide evenly
    // [1,1,2] avg = 4/3 → floor
    expect(smaLoad([Q, Q, 2n * Q])).toBe((4n * Q) / 3n);
  });
});

describe("demandMult — clamp(SMA, m_min, m_max)", () => {
  it("steady load 1.0 → 1.0", () => {
    expect(demandMult(constHistory(Q))).toBe(Q);
  });
  it("clamps LOW: load 0.1 (below 0.5) → m_min", () => {
    const lowRaw = Q / 10n; // 0.1
    expect(demandMult(constHistory(lowRaw))).toBe(M_MIN_Q);
  });
  it("clamps HIGH: load 5.0 (above 2.0) → m_max", () => {
    const highRaw = 5n * Q; // 5.0
    expect(demandMult(constHistory(highRaw))).toBe(M_MAX_Q);
  });
  it("interior value passes through: load 1.5 → 1.5", () => {
    expect(demandMult(constHistory((3n * Q) / 2n))).toBe((3n * Q) / 2n);
  });
  it("empty history → neutral 1.0 (in range)", () => {
    expect(demandMult([])).toBe(Q);
  });
  it("respects custom bounds", () => {
    // tighten to [0.8, 1.2]; load 2.0 → clamp to 1.2
    expect(demandMult(constHistory(2n * Q), (8n * Q) / 10n, (12n * Q) / 10n)).toBe(
      (12n * Q) / 10n,
    );
  });
});

describe("BIBO bound — demandMult output ALWAYS in [m_min, m_max]", () => {
  const samples = [0n, 1n, Q / 100n, Q / 2n, Q, 2n * Q, 7n * Q, 1_000_000n * Q];
  for (const raw of samples) {
    it(`raw=${raw} stays bounded`, () => {
      const m = demandMult(constHistory(raw));
      expect(m).toBeGreaterThanOrEqual(M_MIN_Q);
      expect(m).toBeLessThanOrEqual(M_MAX_Q);
    });
  }
});

describe("MONOTONE non-decreasing in load", () => {
  it("price is non-decreasing as load_raw increases", () => {
    // sweep load from 0 to 4.0 in steps; each full-window demand → price
    let prevImg = -1n;
    let prevCid = -1n;
    for (let k = 0n; k <= 40n; k++) {
      const raw = (k * Q) / 10n; // 0.0, 0.1, ... 4.0
      const m = demandMult(constHistory(raw));
      const pImg = pricePerOp(OP_IMAGE, m);
      const pCid = pricePerOp(OP_CID, m);
      expect(pImg).toBeGreaterThanOrEqual(prevImg);
      expect(pCid).toBeGreaterThanOrEqual(prevCid);
      prevImg = pImg;
      prevCid = pCid;
    }
  });
  it("demandMult itself is non-decreasing in steady load", () => {
    let prev = -1n;
    for (let k = 0n; k <= 50n; k++) {
      const raw = (k * Q) / 10n;
      const m = demandMult(constHistory(raw));
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
  });
});

describe("price bounds — [base×m_min, base×m_max]", () => {
  it("image price never exceeds base × m_max = 0.02 MAGIC", () => {
    const maxImg = (10_000_000n * M_MAX_Q) / Q; // 20_000_000
    const m = demandMult(constHistory(100n * Q)); // saturating load
    expect(pricePerOp(OP_IMAGE, m)).toBe(maxImg);
    expect(pricePerOp(OP_IMAGE, m)).toBe(20_000_000n);
  });
  it("image price never below base × m_min = 0.005 MAGIC", () => {
    const minImg = (10_000_000n * M_MIN_Q) / Q; // 5_000_000
    const m = demandMult(constHistory(0n)); // zero load → clamp to m_min
    expect(pricePerOp(OP_IMAGE, m)).toBe(minImg);
    expect(pricePerOp(OP_IMAGE, m)).toBe(5_000_000n);
  });
  it("high demand → higher price but ≤ base × m_max", () => {
    const m = demandMult(constHistory(10n * Q)); // very high load
    const p = pricePerOp(OP_CID, m);
    expect(p).toBeGreaterThan(1_000_000n); // > base (demand>1)
    const ceil = (1_000_000n * M_MAX_Q) / Q; // 2_000_000
    expect(p).toBeLessThanOrEqual(ceil);
    expect(p).toBe(2_000_000n);
  });
});

describe("CONVERGENCE — settles to base × SMA within ≤ N epochs of steady load", () => {
  it("after N=6 epochs of constant load 1.5, demand == 1.5 and price == base×1.5", () => {
    const targetRaw = (3n * Q) / 2n; // 1.5 (interior → SMA passes through clamp)
    let h: bigint[] = []; // start empty (cold)
    let m = demandMult(h);
    expect(m).toBe(Q); // cold start neutral

    for (let e = 0; e < DEMAND_WINDOW; e++) {
      h = appendLoadHistory(h, targetRaw);
      m = demandMult(h);
    }
    // window now fully filled with targetRaw → SMA == targetRaw exactly
    expect(m).toBe(targetRaw);
    expect(pricePerOp(OP_IMAGE, m)).toBe((10_000_000n * targetRaw) / Q); // 15_000_000
    expect(pricePerOp(OP_IMAGE, m)).toBe(15_000_000n);
  });

  it("convergence from a different starting load (step response settles in ≤ N)", () => {
    // start saturated high, then drop to steady 1.0 → must reach exactly 1.0 by epoch N
    let h: bigint[] = constHistory(9n * Q); // history all 9.0
    expect(demandMult(h)).toBe(M_MAX_Q); // saturated high

    let m = demandMult(h);
    for (let e = 0; e < DEMAND_WINDOW; e++) {
      h = appendLoadHistory(h, Q); // feed steady 1.0
      m = demandMult(h);
    }
    expect(m).toBe(Q); // fully converged to base × SMA(=1.0)
  });

  it("BIBO: bounded input history → bounded SMA at every step (no divergence)", () => {
    let h: bigint[] = [];
    // arbitrary bounded inputs in [0, 4Q]
    const seq = [0n, 4n * Q, Q, 2n * Q, Q / 2n, 3n * Q, 0n, 4n * Q];
    for (const r of seq) {
      h = appendLoadHistory(h, r);
      const sma = smaLoad(h);
      // SMA is a convex combination of inputs → within [min,max] of the window
      const lo = h.reduce((a, b) => (b < a ? b : a), h[0]!);
      const hi = h.reduce((a, b) => (b > a ? b : a), h[0]!);
      expect(sma).toBeGreaterThanOrEqual(lo);
      expect(sma).toBeLessThanOrEqual(hi);
      // and demand always bounded
      const m = demandMult(h);
      expect(m).toBeGreaterThanOrEqual(M_MIN_Q);
      expect(m).toBeLessThanOrEqual(M_MAX_Q);
    }
  });
});

describe("requiredBurn — Σ price × count (mirrors on-chain C-CM-2)", () => {
  it("mixed batch at demand 1.0", () => {
    const m = Q;
    // 3 images + 10 CIDs = 3×0.01 + 10×0.001 = 0.04 MAGIC = 40_000_000 ng
    const total = requiredBurn(
      [
        { opType: OP_IMAGE, opCount: 3n },
        { opType: OP_CID, opCount: 10n },
      ],
      m,
    );
    expect(total).toBe(3n * 10_000_000n + 10n * 1_000_000n);
    expect(total).toBe(40_000_000n);
  });
  it("scales with demand, stays ≤ Σ base × m_max", () => {
    const mHigh = demandMult(constHistory(100n * Q)); // m_max = 2.0
    const total = requiredBurn([{ opType: OP_IMAGE, opCount: 5n }], mHigh);
    expect(total).toBe(5n * 20_000_000n); // 100_000_000
    const ceil = 5n * ((10_000_000n * M_MAX_Q) / Q);
    expect(total).toBeLessThanOrEqual(ceil);
  });
  // ĐỔI HÀNH VI (2026-08-09): ca cũ tên "negative/zero counts contribute nothing" KHOÁ
  // một fail-open. `requiredForOp` trả 0 im lặng cho opCount ≤ 0, trong khi on-chain
  // `expect op_count >= 1` TỪ CHỐI ⇒ app hiện "0 MAGIC", cấp dịch vụ, rồi tx mới chết.
  // Hành vi đúng: ném PRICE-002.
  it("opCount ≤ 0 → ném PRICE-002 (KHÔNG trả 0 im lặng)", () => {
    expect(() => requiredBurn([{ opType: OP_IMAGE, opCount: -4n }], Q)).toThrow(/PRICE-002/);
    expect(() => requiredBurn([{ opType: OP_IMAGE, opCount: 0n }], Q)).toThrow(/PRICE-002/);
    expect(() => requiredForOp(OP_IMAGE, 0n, Q)).toThrow(/PRICE-002/);
    expect(() => requiredForOp(OP_IMAGE, -1n, Q)).toThrow(/PRICE-002/);
  });

  it("opCount = 1 (biên dưới hợp lệ) vẫn tính bình thường", () => {
    expect(requiredForOp(OP_IMAGE, 1n, Q)).toBe(10_000_000n);
  });
});

describe("FOLD-FLOOR-ONCE — P8 parity anchor (must match onchain pricing.required_for)", () => {
  // NORMATIVE parity vector — GIÁ TRỊ NÀY == test Aiken required_fold_floor_no_undercharge.
  // base=1e6, demand=1_333_333_333, count=1000.
  const base = 1_000_000n;
  const demand = 1_333_333_333n;
  const count = 1000n;
  const foldOnce = 1_333_333_333n; //  ⌊base×demand×count/Q⌋   — CORRECT (fold-once)
  const oldFloorFirst = 1_333_333_000n; // ⌊base×demand/Q⌋×count — under-charge (333 ng)

  const table = { [OP_IMAGE]: base } as const;

  it("requiredForOp folds base×demand×count then ÷Q once (no under-charge)", () => {
    expect(requiredForOp(OP_IMAGE, count, demand, table)).toBe(foldOnce);
    // demonstrate the old floor-before-multiply WOULD have under-charged
    expect((base * demand) / Q * count).toBe(oldFloorFirst);
    expect(foldOnce - oldFloorFirst).toBe(333n);
  });

  it("requiredBurn matches the on-chain fold value on the parity vector", () => {
    expect(requiredBurn([{ opType: OP_IMAGE, opCount: count }], demand, table)).toBe(foldOnce);
  });
});

describe("unknown op_type rejected (no authoritative price)", () => {
  it("throws PRICE-001 for op_type not in table", () => {
    expect(() => pricePerOp(99, Q)).toThrow(/PRICE-001/);
  });
});

// ══════════════════════════════════════════════════════════════
// assertValidPriceParam — bản gương off-chain của pricing.ak:valid_param
//
// ĐỐI CHIẾU 1-1 với test Aiken (ConsumeMAGIC/onchain/lib/magiclamp/consume/pricing.ak):
//   valid_param_ok                         → "bảng MVP hợp lệ"
//   valid_param_out_of_clamp               → PRICE-011
//   valid_param_rejects_unpinned_m_max     → PRICE-010
//   valid_param_rejects_negative_epoch     → PRICE-012
//   valid_param_accepts_max_op_prices      → biên 16 dòng
//   valid_param_rejects_too_many_op_prices → PRICE-013
//   valid_param_rejects_unsorted_op_types  → PRICE-014
//   valid_param_rejects_duplicate_op_type  → PRICE-014
//   valid_param_gate_rejects_tiny_base     → PRICE-015
//   valid_param_gate_accepts_min_base      → biên GATE base=2
//   valid_param_rejects_zero_base_price    → PRICE-015
//   valid_param_negative_base_price_fail   → PRICE-015
// ══════════════════════════════════════════════════════════════

function ppOf(rows: OpPriceRow[], over: Partial<PriceParamLike> = {}): PriceParamLike {
  return {
    op_prices: rows,
    demand_mult: Q,
    m_min: M_MIN_Q,
    m_max: M_MAX_Q,
    epoch: 100n,
    ...over,
  };
}

const MVP_ROWS: OpPriceRow[] = [
  { op_type: 1n, base_price: 10_000_000n },
  { op_type: 2n, base_price: 1_000_000n },
];

describe("assertValidPriceParam — cổng TRƯỚC khi post beacon", () => {
  it("bảng MVP hợp lệ → không ném", () => {
    expect(() => assertValidPriceParam(ppOf(MVP_ROWS))).not.toThrow();
  });

  it("PRICE-010: m_max lệch hằng dù chỉ +1 → ném (band-escape)", () => {
    expect(() => assertValidPriceParam(ppOf(MVP_ROWS, { m_max: M_MAX_Q + 1n })))
      .toThrow(/PRICE-010/);
    expect(() => assertValidPriceParam(ppOf(MVP_ROWS, { m_min: 0n })))
      .toThrow(/PRICE-010/);
    // m_max khổng lồ + demand bám theo: giá nổ ~1e6× — pin chặn tận gốc.
    expect(() =>
      assertValidPriceParam(
        ppOf(MVP_ROWS, { m_max: 2_000_000_000_000_000n, demand_mult: 2_000_000_000_000_000n }),
      ),
    ).toThrow(/PRICE-010/);
  });

  it("PRICE-011: demand_mult ngoài band → ném", () => {
    expect(() => assertValidPriceParam(ppOf(MVP_ROWS, { demand_mult: 3n * Q })))
      .toThrow(/PRICE-011/);
    expect(() => assertValidPriceParam(ppOf(MVP_ROWS, { demand_mult: 1n })))
      .toThrow(/PRICE-011/);
  });

  it("PRICE-012: epoch âm → ném", () => {
    expect(() => assertValidPriceParam(ppOf(MVP_ROWS, { epoch: -1n }))).toThrow(/PRICE-012/);
  });

  it("PRICE-013: bảng > 16 dòng → ném (DoS ex-unit)", () => {
    const mk = (n: number): OpPriceRow[] =>
      Array.from({ length: n }, (_, i) => ({
        op_type: BigInt(i + 1),
        base_price: 10_000_000n,
      }));
    // biên: đúng MAX_OP_PRICES dòng còn hợp lệ
    expect(() => assertValidPriceParam(ppOf(mk(MAX_OP_PRICES)))).not.toThrow();
    expect(() => assertValidPriceParam(ppOf(mk(MAX_OP_PRICES + 1)))).toThrow(/PRICE-013/);
  });

  it("PRICE-014: bảng KHÔNG sắp xếp tăng ngặt → ném", () => {
    const unsorted: OpPriceRow[] = [
      { op_type: 2n, base_price: 1_000_000n },
      { op_type: 1n, base_price: 10_000_000n },
    ];
    expect(() => assertValidPriceParam(ppOf(unsorted))).toThrow(/PRICE-014/);
  });

  it("PRICE-014: op_type trùng (kề nhau) → ném — chỗ sinh lệch giá 10×", () => {
    // on-chain `list.find` lấy dòng ĐẦU (10M), map off-chain lấy dòng CUỐI (99M).
    const dup: OpPriceRow[] = [
      { op_type: 1n, base_price: 10_000_000n },
      { op_type: 1n, base_price: 99_000_000n },
      { op_type: 2n, base_price: 1_000_000n },
    ];
    expect(() => assertValidPriceParam(ppOf(dup))).toThrow(/PRICE-014/);
  });

  it("PRICE-015: base_price quá nhỏ → ném (collapse-to-0)", () => {
    // base=1 ở demand=m_min(0.5×) → ⌊1×5e8/1e9⌋ = 0 ⇒ drain miễn phí.
    expect(() => assertValidPriceParam(ppOf([{ op_type: 1n, base_price: 1n }])))
      .toThrow(/PRICE-015/);
  });

  it("PRICE-015: biên GATE base_price=2 → hợp lệ (2×5e8 == Q)", () => {
    expect(() => assertValidPriceParam(ppOf([{ op_type: 1n, base_price: 2n }]))).not.toThrow();
  });

  it("PRICE-015: base_price = 0 → ném (nhánh chết — consume ép required > 0)", () => {
    expect(() =>
      assertValidPriceParam(
        ppOf([{ op_type: 1n, base_price: 10_000_000n }, { op_type: 2n, base_price: 0n }]),
      ),
    ).toThrow(/PRICE-015/);
  });

  it("PRICE-015: base_price ÂM → ném (P8 chỉ đúng khi mọi toán hạng ≥ 0)", () => {
    // Aiken `/` là floor, JS BigInt `/` là trunc-về-0 ⇒ hai phía LỆCH trên số âm.
    // GATE này là chỗ chặn sớm — xem MATH.md §5.1.
    expect(() =>
      assertValidPriceParam(
        ppOf([{ op_type: 1n, base_price: 10_000_000n }, { op_type: 2n, base_price: -1n }]),
      ),
    ).toThrow(/PRICE-015/);
  });

  it("bảng rỗng và bảng 1 dòng: hợp lệ theo định nghĩa (không có cặp nào để so)", () => {
    expect(() => assertValidPriceParam(ppOf([]))).not.toThrow();
    expect(() => assertValidPriceParam(ppOf([{ op_type: 7n, base_price: 10_000_000n }])))
      .not.toThrow();
  });
});

describe("toCanonicalOpPrices — dạng chuẩn tắc trước khi post", () => {
  it("sắp xếp tăng dần theo op_type", () => {
    const out = toCanonicalOpPrices([
      { op_type: 5n, base_price: 2_000_000n },
      { op_type: 1n, base_price: 10_000_000n },
      { op_type: 2n, base_price: 1_000_000n },
    ]);
    expect(out.map((r) => r.op_type)).toEqual([1n, 2n, 5n]);
    expect(() => assertValidPriceParam(ppOf(out))).not.toThrow();
  });

  it("thuần — không đổi mảng gốc", () => {
    const orig: OpPriceRow[] = [
      { op_type: 2n, base_price: 1_000_000n },
      { op_type: 1n, base_price: 10_000_000n },
    ];
    toCanonicalOpPrices(orig);
    expect(orig[0]!.op_type).toBe(2n);
  });

  it("op_type trùng → ném PRICE-014 (không tự chọn dòng thắng)", () => {
    expect(() =>
      toCanonicalOpPrices([
        { op_type: 1n, base_price: 10_000_000n },
        { op_type: 1n, base_price: 99_000_000n },
      ]),
    ).toThrow(/PRICE-014/);
  });
});

describe("NO FLOAT — every output is a BigInt", () => {
  const m = demandMult(constHistory((3n * Q) / 2n));
  it("computeLoadRaw, smaLoad, demandMult, pricePerOp, requiredBurn all bigint", () => {
    expect(typeof computeLoadRaw(7n, 3n)).toBe("bigint");
    expect(typeof smaLoad([Q, 2n * Q])).toBe("bigint");
    expect(typeof m).toBe("bigint");
    expect(typeof pricePerOp(OP_IMAGE, m)).toBe("bigint");
    expect(typeof requiredBurn([{ opType: OP_CID, opCount: 2n }], m)).toBe("bigint");
  });
});
