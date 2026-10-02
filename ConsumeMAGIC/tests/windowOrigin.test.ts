// tests/windowOrigin.test.ts — gốc cửa sổ phía off-chain ConsumeMAGIC.
// Vector: `TV_WINDOW_ORIGIN` (LAMP/Specs/Window/CONTRACT.md v1.0 §3). `consume` và `price_param`
// nhận `window_origin_ms` làm apply-param CUỐI; bộ dựng `buildConsumeTx`/`buildPostPriceTx`
// tính epoch bằng `posixMsToEpoch` (trừ gốc theo mạng).
import { describe, it, expect } from "vitest";
import { windowOf, windowOriginMs, posixMsToEpoch, epochValidityWindow } from "@magiclamp/protocol-utils";
import { TV_WINDOW_ORIGIN } from "./vectors.js";

describe("TV-WINDOW-ORIGIN — epoch giao thức ConsumeMAGIC", () => {
  for (const c of TV_WINDOW_ORIGIN.cases) {
    it(`${c.network} ${c.t_ms} ⟹ ${c.window}`, () => {
      expect(windowOf(c.t_ms, TV_WINDOW_ORIGIN.ms_per_epoch, windowOriginMs(c.network))).toBe(c.window);
      expect(posixMsToEpoch(c.t_ms, c.network)).toBe(c.window);
    });
  }
  it("bản quên trừ gốc cho số khác", () => {
    const f = TV_WINDOW_ORIGIN.forgot_origin;
    expect(windowOf(f.t_ms, TV_WINDOW_ORIGIN.ms_per_epoch, 0n)).toBe(f.window);
    expect(posixMsToEpoch(f.t_ms, "Preprod")).not.toBe(f.window);
  });
  it("khoảng hiệu lực ở biên cửa sổ: hai biên cùng một epoch đã trừ gốc (util.get_epoch)", () => {
    const c = TV_WINDOW_ORIGIN.cases[2];             // Preprod, mốc đầu epoch 316
    const w = epochValidityWindow(c.t_ms, c.network);
    expect(posixMsToEpoch(BigInt(w.lowerMs), c.network)).toBe(316n);
    expect(posixMsToEpoch(BigInt(w.upperMs), c.network)).toBe(316n);
    // Cực đối: tip 1 ms trước biên ở slot cuối epoch 315 ⟹ khoảng rỗng ⟹ ném.
    expect(() => epochValidityWindow(TV_WINDOW_ORIGIN.cases[3].t_ms, c.network)).toThrow();
  });
});
