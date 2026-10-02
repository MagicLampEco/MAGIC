// tests/windowOrigin.test.ts — gốc cửa sổ theo epoch Cardano.
// Nguồn: `LAMP/Specs/Window/CONTRACT.md` v1.0 §1–§4. Vector §3 là trọng tài chung của mọi
// bên tích hợp; cùng bốn ca nằm ở module fixture `window_origin_fixtures` phía Aiken.
import { describe, it, expect } from "vitest";
import {
  WINDOW_ORIGIN_MS_BY_NETWORK, windowOriginMs, windowOf, windowStartMs,
  posixMsToEpoch, epochStartMs, WindowOriginError,
  SHELLEY_START, BYRON_SLOTS_PER_EPOCH, msPerEpoch, slotToEpoch, GENESIS_UNIX,
} from "../src/index.js";

const P = 432_000_000n;

describe("WINDOW_ORIGIN_MS_BY_NETWORK — bản chép có nhãn của LAMP c454fe2", () => {
  it("ghim giá trị CONTRACT §2, một dòng một mạng", () => {
    expect(WINDOW_ORIGIN_MS_BY_NETWORK.Mainnet).toBe(1_506_203_091_000n);
    expect(WINDOW_ORIGIN_MS_BY_NETWORK.Preprod).toBe(1_654_041_600_000n);
  });

  it("suy lại được từ SHELLEY_START của chính gói — bảng mốc đổi thì đỏ", () => {
    // window_origin_ms = shelley.posixMs − shelley.epoch × (độ dài epoch Byron)
    // Độ dài epoch Byron = 21_600 slot × 20 s = 432_000_000 ms — KHÔNG lấy từ
    // MS_PER_EPOCH_BY_NETWORK (đó là apply-param, có thể đổi mà gốc không đổi).
    const byronEpochMs = BYRON_SLOTS_PER_EPOCH * 20_000n;
    expect(byronEpochMs).toBe(P);
    for (const n of ["Mainnet", "Preprod"] as const) {
      const s = SHELLEY_START[n];
      expect(WINDOW_ORIGIN_MS_BY_NETWORK[n])
        .toBe(BigInt(s.zeroTimeMs) - BigInt(s.byronEpochs) * byronEpochMs);
    }
  });

  it("hai gốc KHÔNG chia hết cho ms_per_epoch — điều kiện để vector phân biệt được quên-trừ-gốc", () => {
    expect(windowOriginMs("Mainnet") % P).toBe(251_091_000n);
    expect(windowOriginMs("Preprod") % P).toBe(345_600_000n);
  });

  it("Preview ⟹ NÉM WIN-PREVIEW (CONTRACT §4), không trả gốc 0", () => {
    expect(WINDOW_ORIGIN_MS_BY_NETWORK.Preview).toBeUndefined();
    let caught: unknown;
    try { windowOriginMs("Preview"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(WindowOriginError);
    expect((caught as WindowOriginError).code).toBe("WIN-PREVIEW");
    expect(() => posixMsToEpoch(1_790_000_000_000n, "Preview")).toThrow(/WIN-PREVIEW/);
    expect(() => epochStartMs(1n, "Preview")).toThrow(/WIN-PREVIEW/);
  });

  it("bảng bị đóng băng — không ghi thêm mạng lúc chạy", () => {
    expect(Object.isFrozen(WINDOW_ORIGIN_MS_BY_NETWORK)).toBe(true);
  });
});

describe("windowOf / windowStartMs — vector CONTRACT §3", () => {
  // Mỗi vector đi theo CẶP: mốc biên ⟹ e, mốc biên − 1 ms ⟹ e − 1.
  const VECTORS = [
    { network: "Mainnet", t: 1_790_459_091_000n, e: 658n },
    { network: "Mainnet", t: 1_790_459_090_999n, e: 657n },
    { network: "Preprod", t: 1_790_553_600_000n, e: 316n },
    { network: "Preprod", t: 1_790_553_599_999n, e: 315n },
  ] as const;

  for (const v of VECTORS) {
    it(`${v.network} ${v.t} ⟹ ${v.e}`, () => {
      expect(windowOf(v.t, P, windowOriginMs(v.network))).toBe(v.e);
      expect(posixMsToEpoch(v.t, v.network)).toBe(v.e);
    });
  }

  it("vector PHÂN BIỆT được bản quên trừ gốc (gốc 0 cho số khác hẳn)", () => {
    expect(windowOf(1_790_459_091_000n, P, 0n)).toBe(4_144n);
    expect(windowOf(1_790_553_600_000n, P, 0n)).toBe(4_144n);
    expect(windowOf(1_790_459_091_000n, P, 0n)).not.toBe(658n);
    expect(windowOf(1_790_553_600_000n, P, 0n)).not.toBe(316n);
  });

  it("windowStartMs là nghịch đảo ở biên: start(e) ⟹ e, start(e) − 1 ⟹ e − 1", () => {
    for (const n of ["Mainnet", "Preprod"] as const) {
      const o = windowOriginMs(n);
      for (const e of [0n, 1n, 315n, 316n, 657n, 658n]) {
        const s = windowStartMs(e, P, o);
        expect(s).toBe(o + e * P);
        expect(windowOf(s, P, o)).toBe(e);
        expect(windowOf(s - 1n, P, o)).toBe(e - 1n);
        expect(epochStartMs(e, n)).toBe(s);
      }
    }
    expect(windowStartMs(658n, P, windowOriginMs("Mainnet"))).toBe(1_790_459_091_000n);
    expect(windowStartMs(316n, P, windowOriginMs("Preprod"))).toBe(1_790_553_600_000n);
  });

  it("chia SÀN về −∞ khi t < gốc — khớp `/` của Aiken (divideInteger), không cắt về 0", () => {
    const o = windowOriginMs("Preprod");
    expect(windowOf(o - 1n, P, o)).toBe(-1n);   // JS `/` trần sẽ cho 0
    expect(windowOf(o - P, P, o)).toBe(-1n);
    expect(windowOf(o - P - 1n, P, o)).toBe(-2n);
    expect(windowOf(o, P, o)).toBe(0n);
    expect(windowStartMs(-1n, P, o)).toBe(o - P);
  });

  it("ms_per_epoch ≤ 0 ⟹ NÉM WIN-PARAMS-INVALID", () => {
    expect(() => windowOf(1n, 0n, 0n)).toThrow(/WIN-PARAMS-INVALID/);
    expect(() => windowOf(1n, -1n, 0n)).toThrow(/WIN-PARAMS-INVALID/);
    expect(() => windowStartMs(1n, 0n, 0n)).toThrow(/WIN-PARAMS-INVALID/);
  });

  it("trên Preprod/Mainnet epoch giao thức = epoch Cardano đọc từ slot", () => {
    for (const n of ["Mainnet", "Preprod"] as const) {
      expect(msPerEpoch(n)).toBe(P);
      for (const t of [1_790_459_091_000n, 1_790_553_599_000n, 1_790_553_600_000n]) {
        const slot = t / 1000n - BigInt(GENESIS_UNIX[n]);
        expect(posixMsToEpoch(t, n)).toBe(slotToEpoch(slot, n));
      }
    }
  });
});
