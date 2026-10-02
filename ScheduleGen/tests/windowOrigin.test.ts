// tests/windowOrigin.test.ts — gốc cửa sổ phía off-chain ScheduleGen.
// Vector: `TV_WINDOW_ORIGIN` (LAMP/Specs/Window/CONTRACT.md v1.0 §3). Apply-param: cả `commit`
// lẫn két nhận `window_origin_ms` làm tham số CUỐI CÙNG.
import { describe, it, expect } from "vitest";
import { windowOf, windowOriginMs, posixMsToEpoch } from "@magiclamp/protocol-utils";
import { TV_WINDOW_ORIGIN } from "./vectors.js";
import {
  SCHEDULE_COMMIT_PARAM_NAMES, SCHEDULE_VAULT_PARAM_NAMES,
  scheduleCommitParamList, scheduleVaultParamList, type ScheduleScriptParams,
} from "../offchain/src/params.js";

describe("TV-WINDOW-ORIGIN — epoch giao thức ScheduleGen", () => {
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
});

describe("apply-param ScheduleGen — `window_origin_ms` là tham số CUỐI của cả hai script", () => {
  const H = "cd".repeat(28);
  const p: ScheduleScriptParams = {
    lampPolicyId: H, lampAssetName: "744c414d50", shardPolicyId: H, msPerEpoch: 432_000_000n,
    gbBeaconNftPolicy: H, gbBeaconScriptHash: H, gbShardPolicyId: H, rateNftPolicy: H, rateScriptHash: H,
    windowOriginMs: windowOriginMs("Mainnet"),
  };
  it("commit: 10 tên, tên cuối window_origin_ms; ô cuối = gốc", () => {
    expect(SCHEDULE_COMMIT_PARAM_NAMES.length).toBe(10);
    expect(SCHEDULE_COMMIT_PARAM_NAMES[9]).toBe("window_origin_ms");
    const l = scheduleCommitParamList(p);
    expect(l.length).toBe(10);
    expect(l[9]).toBe(1_506_203_091_000n);
  });
  it("két: 7 tên, commit_script_hash rồi window_origin_ms; ô cuối = gốc", () => {
    expect(SCHEDULE_VAULT_PARAM_NAMES.length).toBe(7);
    expect(SCHEDULE_VAULT_PARAM_NAMES.slice(-2)).toEqual(["commit_script_hash", "window_origin_ms"]);
    const l = scheduleVaultParamList(p, "ef".repeat(28));
    expect(l.length).toBe(7);
    expect(l[5]).toBe("ef".repeat(28));
    expect(l[6]).toBe(1_506_203_091_000n);
  });
  it("gốc âm ⟹ NÉM", () => {
    expect(() => scheduleCommitParamList({ ...p, windowOriginMs: -1n })).toThrow(/window_origin_ms/);
  });
});
