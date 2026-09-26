import { describe, it, expect } from "vitest";
import {
  Q,
  M_MIN_Q,
  M_MAX_Q,
  M_NEUTRAL_Q,
  DEMAND_WINDOW,
  OP_IMAGE,
  OP_CID,
  MVP_PRICE_TABLE,
  FIXED_PRICE_OP_TYPES,
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
  MAX_BASE_PRICE,
  type PriceTable,
  type PriceParamLike,
  type OpPriceRow,
} from "../src/price.js";

// helper: build a window full of the same constant raw load
function constHistory(raw: bigint, n: number = DEMAND_WINDOW): bigint[] {
  return Array.from({ length: n }, () => raw);
}

// helper (CC-LOAD-COUNT-UNIT): MVP_PRICE_TABLE nhưng mọi dòng mang demand_mult = m.
// Tái tạo hình dạng test cũ ("pricePerOp(op, demandMultQ)" với base MVP) dưới lược đồ
// mới, nơi demand_mult sống TRONG từng dòng của PriceTable, không phải một tham số rời.
function priceTableAt(m: bigint): PriceTable {
  const out: Record<number, { base_price: bigint; demand_mult: bigint }> = {};
  for (const [k, row] of Object.entries(MVP_PRICE_TABLE)) {
    out[Number(k)] = { base_price: row.base_price, demand_mult: m };
  }
  return out;
}

describe("constants — MVP price table", () => {
  it("op_type=1 (image) = 0.01 MAGIC = 10_000_000 nanogic", () => {
    expect(MVP_PRICE_TABLE[OP_IMAGE]!.base_price).toBe(10_000_000n);
  });
  it("op_type=2 (CID) = 0.001 MAGIC = 1_000_000 nanogic", () => {
    expect(MVP_PRICE_TABLE[OP_CID]!.base_price).toBe(1_000_000n);
  });

  // Bài canh cho ca `ol0920magic-e`: bảng phụ này từng THIẾU mã 3 và 4 trong khi beacon
  // đang deploy có đủ bốn dòng, và một nhà tiêu thụ đọc bảng thiếu rồi báo một chặn không
  // có thật. Ca đó không đỏ ở đâu cả, vì thiếu một dòng không làm hỏng dòng nào còn lại.
  //
  // Neo vào TẬP KHOÁ, không neo vào từng giá: ca "thiếu một mã" là ca phải bắt, và một
  // phép kiểm từng-giá-một không bắt được nó — nó chỉ kiểm những mã nó đã biết tên.
  it("tập op_type khớp sổ CONTRACT.md §A — đúng bốn mã, không thiếu không thừa", () => {
    const codes = Object.keys(MVP_PRICE_TABLE).map(Number).sort((a, b) => a - b);
    expect(codes).toEqual([1, 2, 3, 4]);
  });

  it("op_type=3 và 4 = 1 MAGIC MỖI LẦN (không phải mỗi MB)", () => {
    expect(MVP_PRICE_TABLE[3]!.base_price).toBe(1_000_000_000n);
    expect(MVP_PRICE_TABLE[4]!.base_price).toBe(1_000_000_000n);
  });

  // Ràng buộc on-chain `pricing.ak` ▸ base_price × m_min ≥ Q ⟹ base_price ≥ 2.
  // Một dòng vi phạm nó thì beacon mang dòng ấy bị validator từ chối lúc PostPrice —
  // tức hỏng lộ ra ở lượt deploy, xa chỗ người gõ con số. Kéo nó về đây.
  it("mọi base_price thoả base_price × m_min ≥ Q", () => {
    for (const [code, row] of Object.entries(MVP_PRICE_TABLE)) {
      expect((row.base_price * M_MIN_Q) / Q, `op_type ${code}`).toBeGreaterThanOrEqual(1n);
    }
  });
  it("bounds are 0.5×Q and 2.0×Q", () => {
    expect(M_MIN_Q).toBe(Q / 2n);
    expect(M_MAX_Q).toBe(2n * Q);
    expect(M_NEUTRAL_Q).toBe(Q);
  });

  // CC-LOAD-COUNT-UNIT: MVP_PRICE_TABLE là giá DANH NGHĨA ngoại tuyến — mọi dòng mang
  // demand_mult = Q (1.0×), không phải trạng thái tải của một cụm nào.
  it("MVP_PRICE_TABLE mang demand_mult = Q (1.0×) ở MỌI dòng", () => {
    for (const [code, row] of Object.entries(MVP_PRICE_TABLE)) {
      expect(row.demand_mult, `op_type ${code}`).toBe(Q);
    }
  });
});

describe("TEST VECTOR — price at demand = 1.0", () => {
  it("image = 0.01 MAGIC exactly", () => {
    expect(pricePerOp(OP_IMAGE)).toBe(10_000_000n);
  });
  it("CID = 0.001 MAGIC exactly", () => {
    expect(pricePerOp(OP_CID)).toBe(1_000_000n);
  });
  it("demand=1.0 comes from a steady load_raw=1.0 history (full pipeline)", () => {
    // ops == capacity → load_raw = 1.0 = Q ; SMA = Q ; clamp leaves it = Q
    const raw = computeLoadRaw(1000n, 1000n);
    expect(raw).toBe(Q);
    const m = demandMult(constHistory(raw));
    expect(m).toBe(Q);
    expect(pricePerOp(OP_IMAGE, priceTableAt(m))).toBe(10_000_000n);
    expect(pricePerOp(OP_CID, priceTableAt(m))).toBe(1_000_000n);
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
      const table = priceTableAt(m);
      const pImg = pricePerOp(OP_IMAGE, table);
      const pCid = pricePerOp(OP_CID, table);
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
    expect(pricePerOp(OP_IMAGE, priceTableAt(m))).toBe(maxImg);
    expect(pricePerOp(OP_IMAGE, priceTableAt(m))).toBe(20_000_000n);
  });
  it("image price never below base × m_min = 0.005 MAGIC", () => {
    const minImg = (10_000_000n * M_MIN_Q) / Q; // 5_000_000
    const m = demandMult(constHistory(0n)); // zero load → clamp to m_min
    expect(pricePerOp(OP_IMAGE, priceTableAt(m))).toBe(minImg);
    expect(pricePerOp(OP_IMAGE, priceTableAt(m))).toBe(5_000_000n);
  });
  it("high demand → higher price but ≤ base × m_max", () => {
    const m = demandMult(constHistory(10n * Q)); // very high load
    const p = pricePerOp(OP_CID, priceTableAt(m));
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
    expect(pricePerOp(OP_IMAGE, priceTableAt(m))).toBe((10_000_000n * targetRaw) / Q); // 15_000_000
    expect(pricePerOp(OP_IMAGE, priceTableAt(m))).toBe(15_000_000n);
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
    const table = priceTableAt(Q);
    // 3 images + 10 CIDs = 3×0.01 + 10×0.001 = 0.04 MAGIC = 40_000_000 ng
    const total = requiredBurn(
      [
        { opType: OP_IMAGE, opCount: 3n },
        { opType: OP_CID, opCount: 10n },
      ],
      table,
    );
    expect(total).toBe(3n * 10_000_000n + 10n * 1_000_000n);
    expect(total).toBe(40_000_000n);
  });
  it("scales with demand, stays ≤ Σ base × m_max", () => {
    const mHigh = demandMult(constHistory(100n * Q)); // m_max = 2.0
    const total = requiredBurn([{ opType: OP_IMAGE, opCount: 5n }], priceTableAt(mHigh));
    expect(total).toBe(5n * 20_000_000n); // 100_000_000
    const ceil = 5n * ((10_000_000n * M_MAX_Q) / Q);
    expect(total).toBeLessThanOrEqual(ceil);
  });
  // ĐỔI HÀNH VI (2026-08-09): ca cũ tên "negative/zero counts contribute nothing" KHOÁ
  // một fail-open. `requiredForOp` trả 0 im lặng cho opCount ≤ 0, trong khi on-chain
  // `expect op_count >= 1` TỪ CHỐI ⇒ app hiện "0 MAGIC", cấp dịch vụ, rồi tx mới chết.
  // Hành vi đúng: ném PRICE-002.
  it("opCount ≤ 0 → ném PRICE-002 (KHÔNG trả 0 im lặng)", () => {
    expect(() => requiredBurn([{ opType: OP_IMAGE, opCount: -4n }])).toThrow(/PRICE-002/);
    expect(() => requiredBurn([{ opType: OP_IMAGE, opCount: 0n }])).toThrow(/PRICE-002/);
    expect(() => requiredForOp(OP_IMAGE, 0n)).toThrow(/PRICE-002/);
    expect(() => requiredForOp(OP_IMAGE, -1n)).toThrow(/PRICE-002/);
  });

  it("opCount = 1 (biên dưới hợp lệ) vẫn tính bình thường", () => {
    expect(requiredForOp(OP_IMAGE, 1n)).toBe(10_000_000n);
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

  const table: PriceTable = { [OP_IMAGE]: { base_price: base, demand_mult: demand } };

  it("requiredForOp folds base×demand×count then ÷Q once (no under-charge)", () => {
    expect(requiredForOp(OP_IMAGE, count, table)).toBe(foldOnce);
    // demonstrate the old floor-before-multiply WOULD have under-charged
    expect((base * demand) / Q * count).toBe(oldFloorFirst);
    expect(foldOnce - oldFloorFirst).toBe(333n);
  });

  it("requiredBurn matches the on-chain fold value on the parity vector", () => {
    expect(requiredBurn([{ opType: OP_IMAGE, opCount: count }], table)).toBe(foldOnce);
  });
});

describe("unknown op_type rejected (no authoritative price)", () => {
  it("throws PRICE-001 for op_type not in table", () => {
    expect(() => pricePerOp(99)).toThrow(/PRICE-001/);
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
//   valid_param_cap_accepts_at_ceiling     → biên TRẦN base == MAX_BASE_PRICE
//   valid_param_cap_rejects_one_above_ceiling      → PRICE-016
//   valid_param_cap_rejects_lock_the_service_price → PRICE-016
//   valid_param_cap_rejects_one_bad_row_among_good → PRICE-016
//   valid_param_cap_leaves_headroom_for_dearest_standard_row → biên kinh tế
//
// CC-LOAD-COUNT-UNIT (2026-09-25), test Aiken tương ứng trong CÙNG tệp:
//   valid_param_accepts_fixed_op_at_q          → PRICE-017 qua (op ∈ fixed_price_op_types, demand=Q)
//   valid_param_rejects_fixed_op_demand_above_q → PRICE-017 ném (demand > Q)
//   valid_param_rejects_fixed_op_demand_at_m_min → PRICE-017 ném (demand = m_min, vẫn ≠ Q)
//   valid_param_rejects_row_demand_above_band  → PRICE-011 ném, biên TRÊN từng dòng
//   valid_param_rejects_row_demand_below_band  → PRICE-011 ném, biên DƯỚI từng dòng
// ══════════════════════════════════════════════════════════════

// CC-LOAD-COUNT-UNIT: `demand_mult` nay sống TRONG từng dòng — `row()` mặc định Q
// (1.0×, trong band) trừ khi test cố tình đẩy nó ra ngoài.
function row(op_type: bigint, base_price: bigint, demand_mult: bigint = Q): OpPriceRow {
  return { op_type, base_price, demand_mult };
}

function ppOf(rows: OpPriceRow[], over: Partial<PriceParamLike> = {}): PriceParamLike {
  return {
    op_prices: rows,
    m_min: M_MIN_Q,
    m_max: M_MAX_Q,
    epoch: 100n,
    ...over,
  };
}

const MVP_ROWS: OpPriceRow[] = [
  row(1n, 10_000_000n),
  row(2n, 1_000_000n),
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
    // m_max khổng lồ: giá nổ ~1e6× — pin chặn tận gốc, trước khi kịp đọc demand_mult
    // của bất kỳ dòng nào (PRICE-010 chạy TRƯỚC vòng lặp theo dòng).
    expect(() =>
      assertValidPriceParam(ppOf(MVP_ROWS, { m_max: 2_000_000_000_000_000n })),
    ).toThrow(/PRICE-010/);
  });

  it("PRICE-011: demand_mult ngoài band → ném (per-row, CC-LOAD-COUNT-UNIT)", () => {
    expect(() =>
      assertValidPriceParam(ppOf([row(1n, 10_000_000n, 3n * Q), row(2n, 1_000_000n)])),
    ).toThrow(/PRICE-011/);
    expect(() =>
      assertValidPriceParam(ppOf([row(1n, 10_000_000n, 1n), row(2n, 1_000_000n)])),
    ).toThrow(/PRICE-011/);
  });

  it("PRICE-011: band biên DƯỚI từng dòng — m_min−1 → ném, đúng m_min → qua", () => {
    expect(() =>
      assertValidPriceParam(ppOf([row(1n, 10_000_000n, M_MIN_Q - 1n)])),
    ).toThrow(/PRICE-011/);
    expect(() =>
      assertValidPriceParam(ppOf([row(1n, 10_000_000n, M_MIN_Q)])),
    ).not.toThrow();
  });

  it("PRICE-011: band biên TRÊN từng dòng — m_max+1 → ném, đúng m_max → qua", () => {
    expect(() =>
      assertValidPriceParam(ppOf([row(1n, 10_000_000n, M_MAX_Q + 1n)])),
    ).toThrow(/PRICE-011/);
    expect(() =>
      assertValidPriceParam(ppOf([row(1n, 10_000_000n, M_MAX_Q)])),
    ).not.toThrow();
  });

  it("PRICE-012: epoch âm → ném", () => {
    expect(() => assertValidPriceParam(ppOf(MVP_ROWS, { epoch: -1n }))).toThrow(/PRICE-012/);
  });

  it("PRICE-013: bảng > 16 dòng → ném (DoS ex-unit)", () => {
    const mk = (n: number): OpPriceRow[] =>
      Array.from({ length: n }, (_, i) => row(BigInt(i + 1), 10_000_000n));
    // biên: đúng MAX_OP_PRICES dòng còn hợp lệ
    expect(() => assertValidPriceParam(ppOf(mk(MAX_OP_PRICES)))).not.toThrow();
    expect(() => assertValidPriceParam(ppOf(mk(MAX_OP_PRICES + 1)))).toThrow(/PRICE-013/);
  });

  it("PRICE-014: bảng KHÔNG sắp xếp tăng ngặt → ném", () => {
    const unsorted: OpPriceRow[] = [
      row(2n, 1_000_000n),
      row(1n, 10_000_000n),
    ];
    expect(() => assertValidPriceParam(ppOf(unsorted))).toThrow(/PRICE-014/);
  });

  it("PRICE-014: op_type trùng (kề nhau) → ném — chỗ sinh lệch giá 10×", () => {
    // on-chain `list.find` lấy dòng ĐẦU (10M), map off-chain lấy dòng CUỐI (99M).
    const dup: OpPriceRow[] = [
      row(1n, 10_000_000n),
      row(1n, 99_000_000n),
      row(2n, 1_000_000n),
    ];
    expect(() => assertValidPriceParam(ppOf(dup))).toThrow(/PRICE-014/);
  });

  it("PRICE-015: base_price quá nhỏ → ném (collapse-to-0)", () => {
    // base=1 ở demand=m_min(0.5×) → ⌊1×5e8/1e9⌋ = 0 ⇒ drain miễn phí.
    expect(() => assertValidPriceParam(ppOf([row(1n, 1n)])))
      .toThrow(/PRICE-015/);
  });

  it("PRICE-015: biên GATE base_price=2 → hợp lệ (2×5e8 == Q)", () => {
    expect(() => assertValidPriceParam(ppOf([row(1n, 2n)]))).not.toThrow();
  });

  it("PRICE-015: base_price = 0 → ném (nhánh chết — consume ép required > 0)", () => {
    expect(() =>
      assertValidPriceParam(ppOf([row(1n, 10_000_000n), row(2n, 0n)])),
    ).toThrow(/PRICE-015/);
  });

  it("PRICE-016: biên TRẦN base == MAX_BASE_PRICE → hợp lệ", () => {
    // `<=` và `<` chỉ khác nhau tại đúng điểm này, nên cặp test biên ghim đúng dấu.
    expect(() =>
      assertValidPriceParam(ppOf([row(1n, MAX_BASE_PRICE)])),
    ).not.toThrow();
  });

  it("PRICE-016: TRẦN + 1 nanogic → ném", () => {
    expect(() =>
      assertValidPriceParam(ppOf([row(1n, MAX_BASE_PRICE + 1n)])),
    ).toThrow(/PRICE-016/);
  });

  it("PRICE-016: giá khoá-dịch-vụ cho op_type=7 (did.rotate) → ném", () => {
    // Ca thật mà trần sinh ra để chặn. 2⁶³−1 vẫn là số hợp lệ với BigInt và với Aiken
    // Int (số nguyên lớn tuỳ ý) — không có gì tự chặn nó ngoài trần này. demand_mult=Q
    // (mặc định của `row`) để không trộn với PRICE-017 — op_type 7 thuộc
    // FIXED_PRICE_OP_TYPES nên phải giữ demand_mult==Q để phép thử này chỉ đo PRICE-016.
    expect(() =>
      assertValidPriceParam(
        ppOf([
          row(1n, 10_000_000n),
          row(7n, 9_223_372_036_854_775_807n),
        ]),
      ),
    ).toThrow(/PRICE-016/);
  });

  it("PRICE-016: trần áp cho MỌI dòng, không riêng dòng đầu", () => {
    expect(() =>
      assertValidPriceParam(
        ppOf([
          row(1n, 10_000_000n),
          row(2n, 1_000_000n),
          row(8n, MAX_BASE_PRICE + 1n),
        ]),
      ),
    ).toThrow(/PRICE-016/);
  });

  it("PRICE-016: dòng đắt nhất trong sổ chuẩn còn xa trần (kẹp hai đầu)", () => {
    // `did.transfer` = 1e10 nanogic (ConsumeMAGIC/CONTRACT.md). Test này đỏ nghĩa là
    // trần đặt quá thấp và sổ giá sắp không dùng được — không phải test sai.
    //
    // Hệ số 100× (hạ từ 10.000× ngày 2026-09-12 cùng lúc trần xuống 10¹²). Cận TRÊN
    // của trần là bất biến chống-khoá-toàn-mạng, ghim bên Aiken ở
    // `pricing.ak` ▸ `max_base_price_below_network_lock_threshold`; TypeScript không
    // dựng lại được vế đó vì nó cần hằng của kho ScheduleGen. Bài này giữ cận DƯỚI.
    const dearestStandard = 10_000_000_000n;
    expect(MAX_BASE_PRICE).toBeGreaterThanOrEqual(dearestStandard * 100n);
    expect(() =>
      assertValidPriceParam(ppOf([row(8n, dearestStandard)])),
    ).not.toThrow();
  });

  it("PRICE-015: base_price ÂM → ném (P8 chỉ đúng khi mọi toán hạng ≥ 0)", () => {
    // Aiken `/` là floor, JS BigInt `/` là trunc-về-0 ⇒ hai phía LỆCH trên số âm.
    // GATE này là chỗ chặn sớm — xem MATH.md §5.1.
    expect(() =>
      assertValidPriceParam(ppOf([row(1n, 10_000_000n), row(2n, -1n)])),
    ).toThrow(/PRICE-015/);
  });

  it("bảng rỗng và bảng 1 dòng: hợp lệ theo định nghĩa (không có cặp nào để so)", () => {
    expect(() => assertValidPriceParam(ppOf([]))).not.toThrow();
    expect(() => assertValidPriceParam(ppOf([row(7n, 10_000_000n)])))
      .not.toThrow();
  });

  // ── PRICE-017 — CC-LOAD-COUNT-UNIT: op_type ∈ FIXED_PRICE_OP_TYPES ép demand_mult == Q ──
  it("PRICE-017: op_type ∈ FIXED_PRICE_OP_TYPES giữ demand_mult ≠ Q → ném", () => {
    expect(FIXED_PRICE_OP_TYPES).toContain(7n);
    expect(() =>
      assertValidPriceParam(ppOf([row(7n, 10_000_000n, M_MIN_Q)])),
    ).toThrow(/PRICE-017/);
  });

  it("PRICE-017: op_type ∈ FIXED_PRICE_OP_TYPES với demand_mult == Q → qua", () => {
    expect(() =>
      assertValidPriceParam(ppOf([row(7n, 10_000_000n, Q)])),
    ).not.toThrow();
  });
});

describe("toCanonicalOpPrices — dạng chuẩn tắc trước khi post", () => {
  it("sắp xếp tăng dần theo op_type", () => {
    const out = toCanonicalOpPrices([
      row(5n, 2_000_000n),
      row(1n, 10_000_000n),
      row(2n, 1_000_000n),
    ]);
    expect(out.map((r) => r.op_type)).toEqual([1n, 2n, 5n]);
    expect(() => assertValidPriceParam(ppOf(out))).not.toThrow();
  });

  it("thuần — không đổi mảng gốc", () => {
    const orig: OpPriceRow[] = [
      row(2n, 1_000_000n),
      row(1n, 10_000_000n),
    ];
    toCanonicalOpPrices(orig);
    expect(orig[0]!.op_type).toBe(2n);
  });

  it("op_type trùng → ném PRICE-014 (không tự chọn dòng thắng)", () => {
    expect(() =>
      toCanonicalOpPrices([
        row(1n, 10_000_000n),
        row(1n, 99_000_000n),
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
    expect(typeof pricePerOp(OP_IMAGE, priceTableAt(m))).toBe("bigint");
    expect(typeof requiredBurn([{ opType: OP_CID, opCount: 2n }], priceTableAt(m))).toBe(
      "bigint",
    );
  });
});
