// `/health` khai GỐC KỲ giao thức (`epoch`) để app khỏi gõ cứng hằng theo mạng.
// Vector: LAMP `Specs/Window/CONTRACT.md` v1.0 §3 — Preprod t=1_790_553_600_000 ⟹ kỳ 316,
// t−1 ⟹ kỳ 315; Mainnet 1_790_459_091_000 ⟹ 658. Gốc thật (không chia hết cho P) nên bài
// phân biệt được lưới `(t−O)/P` với lưới Unix `t/P`.

import { describe, expect, it } from "vitest";
import { handle, epochHealthFields, type RouterDeps } from "../src/http.js";
import { WINDOW_ORIGIN_MS_BY_NETWORK, windowOriginMs, msPerEpoch } from "@magiclamp/protocol-utils";

const P = 432_000_000;
const T_316 = 1_790_553_600_000; // Preprod, đúng biên kỳ 315→316
const T_658 = 1_790_459_091_000; // Mainnet, đúng biên kỳ 657→658

function deps(network: string, now: number): RouterDeps {
  return {
    service: { lampAsset: { policyId: "00".repeat(28), assetNameHex: "4c414d50" } } as never,
    deploymentSource: "src", vaultScopes: [], network, chainLabel: "c",
    changeAddressStrategy: "s", token: "", logInternal: () => {}, now: () => now,
  };
}

async function health(network: string, now: number) {
  return handle({ method: "GET", url: "/health", headers: {} }, deps(network, now));
}

describe("/health ▸ epoch", () => {
  it("Preprod: O/P đúng nguồn bộ dựng, current khớp vector CONTRACT §3 (kỳ 316), start/end liền kề", async () => {
    const r = await health("Preprod", T_316 + 5_000);
    expect(r.status).toBe(200);
    expect(r.body.epoch).toEqual({
      origin_ms: "1654041600000",
      ms_per_epoch: "432000000",
      current: 316,
      start_ms: String(T_316),
      end_ms: String(T_316 + P),
    });
    expect(r.body).not.toHaveProperty("epoch_unavailable_reason");
    // Cùng nguồn với bộ dựng: không phải một bản chép thứ hai trong http.ts.
    const ep = r.body.epoch as { origin_ms: string; ms_per_epoch: string };
    expect(ep.origin_ms).toBe(windowOriginMs("Preprod").toString());
    expect(ep.ms_per_epoch).toBe(msPerEpoch("Preprod").toString());
  });

  it("biên 315→316: t−1 ⟹ kỳ 315 (end_ms = t); t = O + kP ⟹ kỳ 316 và start_ms = t", async () => {
    const before = (await health("Preprod", T_316 - 1)).body.epoch as Record<string, unknown>;
    expect(before.current).toBe(315);
    expect(before.end_ms).toBe(String(T_316));
    const at = (await health("Preprod", T_316)).body.epoch as Record<string, unknown>;
    expect(at.current).toBe(316);
    expect(at.start_ms).toBe(String(T_316));
    // Mốc t = O + kP cho k bất kỳ: kỳ k, start_ms = t.
    const O = Number(WINDOW_ORIGIN_MS_BY_NETWORK.Preprod);
    for (const k of [0, 1, 315, 316, 400]) {
      const e = (await health("Preprod", O + k * P)).body.epoch as Record<string, unknown>;
      expect(e.current).toBe(k);
      expect(e.start_ms).toBe(String(O + k * P));
      expect(e.end_ms).toBe(String(O + (k + 1) * P));
    }
  });

  it("Mainnet: gốc riêng, biên 657→658 theo vector", async () => {
    const at = (await health("Mainnet", T_658)).body.epoch as Record<string, unknown>;
    expect(at).toMatchObject({ origin_ms: "1506203091000", current: 658, start_ms: String(T_658) });
    const before = (await health("Mainnet", T_658 - 1)).body.epoch as Record<string, unknown>;
    expect(before.current).toBe(657);
  });

  it("CỰC ĐỐI: lưới Unix t/P cho số KHÁC (4144 ≠ 316) — bài phân biệt được hai lưới", async () => {
    const unixGrid = Math.floor(T_316 / P);
    expect(unixGrid).toBe(4144);
    const e = (await health("Preprod", T_316)).body.epoch as Record<string, unknown>;
    expect(e.current).not.toBe(unixGrid);
    // Và start_ms của lưới Unix sẽ KHÔNG bằng t — gốc 1970 không chia hết trùng gốc O.
    expect(String(unixGrid * P)).not.toBe(e.start_ms);
    expect(e.current).toBe(316);
  });

  it("Preview (không có gốc): /health vẫn 200, epoch null + lý do tường minh, KHÔNG đệm 0", async () => {
    const r = await health("Preview", T_316);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.epoch).toBeNull();
    expect(r.body.epoch_unavailable_reason).toBe("WINDOW_ORIGIN_UNAVAILABLE");
    expect(JSON.stringify(r.body)).not.toContain("origin_ms");
    expect(epochHealthFields("Preview", T_316)).toEqual({
      epoch: null, epoch_unavailable_reason: "WINDOW_ORIGIN_UNAVAILABLE",
    });
  });

  it("mốc trước gốc (t < O): chia SÀN về −∞, không cắt về 0", () => {
    const O = Number(WINDOW_ORIGIN_MS_BY_NETWORK.Preprod);
    const e = epochHealthFields("Preprod", O - 1).epoch as Record<string, unknown>;
    expect(e.current).toBe(-1);
    expect(e.end_ms).toBe(String(O));
  });
});
