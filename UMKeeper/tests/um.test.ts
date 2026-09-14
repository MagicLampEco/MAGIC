// tests/um.test.ts — UM Keeper unit tests
import { describe, it, expect } from "vitest";
import {
  computeUMRaw, clampUM, clampStep, appendHistory,
  computeSMA, computeNewUM,
} from "../offchain/src/math.js";

const Q            = 1_000_000_000n;
const UM_MIN_Q     = 500_000_000n;
const UM_MAX_Q     = 2_000_000_000n;
const UM_MAX_STEP_Q = 100_000_000n;   // P8: khớp um_max_step_q trong um_datum.ak

// ── TV-UM-SPLIT (reused from InstantGen) ─────────────────────
describe("computeUMRaw — §14.1 C-UM-1", () => {
  it("burns=mints → raw=Q (neutral 1.0)", () => {
    expect(computeUMRaw(1_000_000_000n, 1_000_000_000n)).toBe(Q);
  });
  it("burns > mints → raw > Q (demand high)", () => {
    expect(computeUMRaw(2_000_000_000n, 1_000_000_000n)).toBe(2_000_000_000n);
  });
  it("burns < mints → raw < Q (demand low)", () => {
    expect(computeUMRaw(500_000_000n, 1_000_000_000n)).toBe(500_000_000n);
  });
  it("mints=0 → denominator=1 (no division by zero)", () => {
    const result = computeUMRaw(1_000_000_000n, 0n);
    expect(result).toBe(1_000_000_000n * Q / 1n);   // very large but valid
  });
});

describe("clampUM — §14.1 C-UM-3", () => {
  it("Within range → unchanged", () => {
    expect(clampUM(Q)).toBe(Q);
    expect(clampUM(UM_MIN_Q)).toBe(UM_MIN_Q);
    expect(clampUM(UM_MAX_Q)).toBe(UM_MAX_Q);
  });
  it("Below MIN → clamped to MIN", () => {
    expect(clampUM(100_000_000n)).toBe(UM_MIN_Q);
  });
  it("Above MAX → clamped to MAX", () => {
    expect(clampUM(5_000_000_000n)).toBe(UM_MAX_Q);
  });
});

// ── Trần tương đối mỗi lượt — P8 với `step_within` trong um_datum.ak ────────
describe("clampStep — trần bước 0,10 mỗi lượt cập nhật", () => {
  it("Bước nhỏ hơn trần → giữ nguyên", () => {
    expect(clampStep(1_050_000_000n, Q)).toBe(1_050_000_000n);
    expect(clampStep(950_000_000n, Q)).toBe(950_000_000n);
  });
  it("Bước đúng bằng trần (hai chiều) → giữ nguyên", () => {
    expect(clampStep(Q + UM_MAX_STEP_Q, Q)).toBe(Q + UM_MAX_STEP_Q);
    expect(clampStep(Q - UM_MAX_STEP_Q, Q)).toBe(Q - UM_MAX_STEP_Q);
  });
  it("Vượt trần đi lên → kẹp về smoothed + trần", () => {
    expect(clampStep(UM_MAX_Q, Q)).toBe(Q + UM_MAX_STEP_Q);
  });
  it("Vượt trần đi xuống → kẹp về smoothed − trần", () => {
    expect(clampStep(UM_MIN_Q, Q)).toBe(Q - UM_MAX_STEP_Q);
  });
  it("Đúng bước của PoC (1,5 → 2,0) → kẹp về 1,6", () => {
    // On-chain bước này bị TỪ CHỐI; off-chain kẹp trước để tx còn gửi được.
    expect(clampStep(2_000_000_000n, 1_500_000_000n)).toBe(1_600_000_000n);
  });
});

describe("appendHistory — §14.1 C-UM-2", () => {
  it("Empty history → [new_raw]", () => {
    expect(appendHistory([], Q)).toEqual([Q]);
  });
  it("History < 6 → append", () => {
    const h = [Q, Q, Q];
    expect(appendHistory(h, UM_MIN_Q)).toHaveLength(4);
  });
  it("History = 6 → drop oldest, append new (sliding window)", () => {
    const h = [1n, 2n, 3n, 4n, 5n, 6n];
    const result = appendHistory(h, 7n);
    expect(result).toEqual([2n, 3n, 4n, 5n, 6n, 7n]);  // 1n dropped ✓
    expect(result).toHaveLength(6);
  });
  it("TV-UM-SPLIT: smoothed=2B, last_updated=98, history=[2B,2B,2B,2B,2B,2B]", () => {
    const h = Array(6).fill(2_000_000_000n);
    const result = appendHistory(h, Q);  // new raw = Q (1.0)
    expect(result).toHaveLength(6);
    // SMA drops one 2B, adds one Q
    const sma = computeSMA(result);
    expect(sma).toBeLessThan(2_000_000_000n);
    expect(sma).toBeGreaterThan(Q);
  });
});

describe("computeSMA — §14.1 C-UM-1", () => {
  it("Single value → that value", () => {
    expect(computeSMA([1_500_000_000n])).toBe(1_500_000_000n);
  });
  it("All same → that value", () => {
    expect(computeSMA([Q, Q, Q, Q])).toBe(Q);
  });
  it("Mix → floor average", () => {
    // [500M, 1B, 1.5B, 2B] → sum=5B / 4 = 1.25B
    expect(computeSMA([500_000_000n, 1_000_000_000n, 1_500_000_000n, 2_000_000_000n]))
      .toBe(1_250_000_000n);
  });
  it("Empty history → Q (neutral)", () => {
    expect(computeSMA([])).toBe(Q);
  });
});

describe("computeNewUM — full update", () => {
  it("Neutral epoch (burns=mints) → smoothed converges toward Q", () => {
    const datum = {
      smoothed_q: 1_500_000_000n,
      last_updated_epoch: 99n,
      history: [1_500_000_000n, 1_500_000_000n, 1_500_000_000n],
    };
    const { newSmoothed, newHistory, newRaw } = computeNewUM(datum, 1_000_000_000n, 1_000_000_000n);
    expect(newRaw).toBe(Q);           // burns=mints → raw=Q
    expect(newHistory).toHaveLength(4);
    expect(newSmoothed).toBeLessThan(1_500_000_000n);  // converging down ✓
    expect(newSmoothed).toBeGreaterThanOrEqual(UM_MIN_Q);
    expect(newSmoothed).toBeLessThanOrEqual(UM_MAX_Q);
  });

  it("High demand (burns >> mints) → MỘT lượt chỉ nhích tối đa 0,10, KHÔNG còn nhảy thẳng lên UM_MAX", () => {
    // Bản trước bài này đòi `newSmoothed === UM_MAX_Q` sau ĐÚNG MỘT lượt — và
    // đó chính là đường tấn công PoC đã đi (6 lượt, 0 chữ ký, ghim UM lên trần).
    // Trần bước làm kỳ vọng cũ SAI theo thiết kế; sửa kỳ vọng, không nới trần.
    const datum = { smoothed_q: Q, last_updated_epoch: 99n, history: [] };
    const { newSmoothed, submittedRaw, newRaw } = computeNewUM(datum, 10_000_000_000_000n, 1_000_000_000n);
    expect(newRaw).toBeGreaterThan(UM_MAX_Q);          // thị trường đòi rất cao
    expect(submittedRaw).toBe(Q + UM_MAX_STEP_Q);      // gửi đi chỉ là 1,10
    expect(newSmoothed).toBe(Q + UM_MAX_STEP_Q);       // history rỗng → SMA = 1,10
    expect(newSmoothed).toBeLessThan(UM_MAX_Q);
  });

  it("Từ 1,0 lên UM_MAX cần NHIỀU epoch — đây là CÁI GIÁ của hàng rào, không phải chỗ ẩn đi", () => {
    // Đo thẳng: nhu cầu cực đại liên tục thì mất bao nhiêu lượt mới chạm trần.
    let datum = { smoothed_q: Q, last_updated_epoch: 0n, history: [] as bigint[] };
    let epochs = 0;
    while (datum.smoothed_q < UM_MAX_Q && epochs < 200) {
      const { newSmoothed, newHistory } = computeNewUM(datum, 10_000_000_000_000n, 1n);
      datum = { smoothed_q: newSmoothed, last_updated_epoch: BigInt(epochs), history: newHistory };
      epochs++;
    }
    // Hàng rào chỉ LÀM CHẬM, KHÔNG CHẶN: vẫn tới trần, chỉ tốn nhiều epoch hơn.
    // Bản vá thật là cổng M-of-N (khuôn ở ConsumeMAGIC/…/price_param.ak).
    expect(datum.smoothed_q).toBe(UM_MAX_Q);
    expect(epochs).toBeGreaterThan(6);   // PoC cũ chỉ cần 6 lượt
  });

  it("P8 — submittedRaw LUÔN qua được `step_within` của validator", () => {
    // Nếu bài này đỏ thì bên dựng tx đang sinh ra giao dịch bị on-chain từ chối.
    const smootheds = [UM_MIN_Q, Q, 1_500_000_000n, UM_MAX_Q];
    const cases = [
      { burns: 0n,               mints: 1_000_000_000n },
      { burns: 10_000_000_000n,  mints: 1n },
      { burns: 1_000_000_000n,   mints: 1_000_000_000n },
      { burns: 1n,               mints: 10_000_000_000n },
    ];
    for (const smoothed_q of smootheds) {
      for (const { burns, mints } of cases) {
        const datum = { smoothed_q, last_updated_epoch: 0n, history: [] as bigint[] };
        const { submittedRaw } = computeNewUM(datum, burns, mints);
        const clamped = clampUM(submittedRaw);          // on-chain clamp dải trước
        const delta = clamped > smoothed_q ? clamped - smoothed_q : smoothed_q - clamped;
        expect(delta).toBeLessThanOrEqual(UM_MAX_STEP_Q);
      }
    }
  });

  it("No burns → raw clamped to UM_MIN, smoothed falls", () => {
    const datum = { smoothed_q: 1_500_000_000n, last_updated_epoch: 99n, history: [1_500_000_000n] };
    const { newSmoothed } = computeNewUM(datum, 0n, 1_000_000_000n);
    expect(newSmoothed).toBeLessThan(1_500_000_000n);
    expect(newSmoothed).toBeGreaterThanOrEqual(UM_MIN_Q);
  });

  it("History stays ≤ 6 entries after 10 updates", () => {
    let datum = { smoothed_q: Q, last_updated_epoch: 90n, history: [] as bigint[] };
    for (let i = 0; i < 10; i++) {
      const { newSmoothed, newHistory } = computeNewUM(datum, 1_000_000_000n, 1_000_000_000n);
      datum = { smoothed_q: newSmoothed, last_updated_epoch: BigInt(91 + i), history: newHistory };
      expect(newHistory.length).toBeLessThanOrEqual(6);  // C-UM-2 ✓
    }
  });

  it("Smoothed always in [UM_MIN_Q, UM_MAX_Q] — C-UM-3", () => {
    const cases = [
      { burns: 0n,              mints: 1_000_000_000n },
      { burns: 1_000_000_000n,  mints: 0n },
      { burns: 10_000_000_000n, mints: 1n },
      { burns: 1n,              mints: 10_000_000_000n },
    ];
    const datum = { smoothed_q: Q, last_updated_epoch: 0n, history: [] as bigint[] };
    for (const { burns, mints } of cases) {
      const { newSmoothed } = computeNewUM(datum, burns, mints);
      expect(newSmoothed).toBeGreaterThanOrEqual(UM_MIN_Q);
      expect(newSmoothed).toBeLessThanOrEqual(UM_MAX_Q);
    }
  });
});
