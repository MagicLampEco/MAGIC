// tests/windowOrigin.test.ts — gốc cửa sổ phía off-chain InstantGen.
// Vector: `TV_WINDOW_ORIGIN` (LAMP/Specs/Window/CONTRACT.md v1.0 §3). Apply-param: két nhận
// `window_origin_ms` làm tham số CUỐI CÙNG (#9).
import { describe, it, expect } from "vitest";
import { windowOf, windowStartMs, windowOriginMs, posixMsToEpoch } from "@magiclamp/protocol-utils";
import { TV_WINDOW_ORIGIN } from "./vectors.js";
import {
  INSTANT_VAULT_PARAM_TITLES, instantVaultParamList, type InstantVaultParams,
} from "../offchain/src/vaultScript.js";

describe("TV-WINDOW-ORIGIN — epoch giao thức InstantGen", () => {
  for (const c of TV_WINDOW_ORIGIN.cases) {
    it(`${c.network} ${c.t_ms} ⟹ ${c.window}`, () => {
      const o = windowOriginMs(c.network);
      expect(windowOf(c.t_ms, TV_WINDOW_ORIGIN.ms_per_epoch, o)).toBe(c.window);
      expect(posixMsToEpoch(c.t_ms, c.network)).toBe(c.window);
    });
  }
  it("bản quên trừ gốc cho số khác — vector phân biệt được hai bên đột biến", () => {
    const f = TV_WINDOW_ORIGIN.forgot_origin;
    expect(windowOf(f.t_ms, TV_WINDOW_ORIGIN.ms_per_epoch, 0n)).toBe(f.window);
    expect(posixMsToEpoch(f.t_ms, "Preprod")).not.toBe(f.window);
  });
  it("mốc mở khoá `cận trên + ms_per_epoch` là ĐỘ DÀI, không đổi theo gốc", () => {
    // `instant_unlock_ms = upper + ms_per_epoch` cộng một độ dài vào một mốc — rơi đúng
    // epoch kế, bất kể gốc. Gương của luật này ở `instant.ts` ▸ `computeInstantGenOutputs`.
    const o = windowOriginMs("Preprod");
    const p = TV_WINDOW_ORIGIN.ms_per_epoch;
    const upper = windowStartMs(316n, p, o) + 123_000n;
    expect(windowOf(upper + p, p, o)).toBe(317n);
  });
});

describe("apply-param két InstantGen — `window_origin_ms` là tham số CUỐI", () => {
  const H = "ab".repeat(28);
  const base: InstantVaultParams = {
    lampPolicyId: H, lampAssetName: "744c414d50", gbBeaconNftPolicy: H, gbBeaconScriptHash: H,
    gbShardPolicyId: H, rateNftPolicy: H, rateScriptHash: H, wakemeVaultHash: H,
    msPerEpoch: 432_000_000n, windowOriginMs: windowOriginMs("Preprod"),
  };
  it("tên cuối = window_origin_ms, ngay sau ms_per_epoch", () => {
    expect(INSTANT_VAULT_PARAM_TITLES.length).toBe(10);
    expect(INSTANT_VAULT_PARAM_TITLES.slice(-2)).toEqual(["ms_per_epoch", "window_origin_ms"]);
  });
  it("danh sách 10 ô, ô cuối = gốc, ô áp chót = nhịp", () => {
    const l = instantVaultParamList(base);
    expect(l.length).toBe(10);
    expect(l[9]).toBe(1_654_041_600_000n);
    expect(l[8]).toBe(432_000_000n);
  });
  it("gốc âm / không phải bigint ⟹ NÉM", () => {
    expect(() => instantVaultParamList({ ...base, windowOriginMs: -1n })).toThrow(/windowOriginMs/);
    expect(() => instantVaultParamList({ ...base, windowOriginMs: 1 as unknown as bigint })).toThrow(/windowOriginMs/);
  });
});
