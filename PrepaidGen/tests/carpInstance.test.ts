// tests/carpInstance.test.ts — soft-pin cặp CARP với instance CarpetMint.
// KHÔNG gọi mạng: phản hồi là bản rút gọn của GET
// https://api.magiclamp.eco/carpetmint/v1/instance/Preprod (đo 2026-10-04; cặp anchor thay bằng đời 7 ngày 2026-10-10), và
// `fetchCarpInstance` nhận một `fetch` giả.

import { describe, expect, it } from "vitest";
import { carpAssetClass } from "../offchain/src/constants.js";
import {
  CARP_INSTANCE_URL,
  assertCarpMatchesInstance,
  fetchCarpInstance,
  parseCarpInstance,
} from "../offchain/src/carpInstance.js";

const POLICY = "0ee76cb19fad694569d56423852e1dc519dcad4c0938babdfa5d3716";
const NAME = "50eaf449c734fde2c3e73e52cc95889d235e489883683b5330bcabaa";

const body = (over: Record<string, unknown> = {}) => ({
  network: "Preprod",
  sha256: "610a02c944809fcd628dde6e27c63eb2019ba730d03b5aeab09b56544677b671",
  instance: {
    net: "Preprod",
    instance: "CARP@bootstrap-tlamp",
    deployedAt: "2026-10-03T23:17:17.960Z",
    anchor: { policyId: POLICY, name: NAME, unit: POLICY + NAME, label: "tCARP" },
    ...over,
  },
});

const fakeFetch = (status: number, payload: unknown) =>
  (async (url: string) => {
    expect(url).toBe(CARP_INSTANCE_URL("Preprod"));
    return { ok: status === 200, status, json: async () => payload } as Response;
  }) as unknown as typeof fetch;

describe("soft-pin CARP ↔ instance CarpetMint", () => {
  it("instance hiện hành khớp cặp mặc định trong kho (đời 6)", () => {
    const inst = parseCarpInstance(body(), "Preprod");
    expect(inst).toMatchObject({ policyId: POLICY, assetName: NAME, label: "tCARP" });
    expect(() => assertCarpMatchesInstance(carpAssetClass("Preprod"), inst)).not.toThrow();
  });

  it("ÂM — cặp đời 5 (đã thay) lệch instance ⟹ NÉM · cực đối: đời 6 nhận", () => {
    const inst = parseCarpInstance(body(), "Preprod");
    expect(() =>
      assertCarpMatchesInstance(
        {
          policyId: "86ea67178d3739965449535eb1f875b37ba2eede4ee5781f89bc310b",
          assetName: "110d0c97df39bcee5ca6875485c493e7cd7608cac38c84b281d18c4f",
        },
        inst,
      ),
    ).toThrow(/lệch instance/);
    // Chỉ lệch asset name cũng NÉM (định danh là CẶP).
    expect(() => assertCarpMatchesInstance({ policyId: POLICY, assetName: "00".repeat(28) }, inst)).toThrow(
      /lệch instance/,
    );
    expect(() => assertCarpMatchesInstance({ policyId: POLICY, assetName: NAME }, inst)).not.toThrow();
  });

  it("ÂM — hình dạng lạ NÉM, không đệm", () => {
    expect(() => parseCarpInstance(null, "Preprod")).toThrow(/không phải đối tượng/);
    expect(() => parseCarpInstance({ network: "Preprod" }, "Preprod")).toThrow(/thiếu trường `instance`/);
    expect(() => parseCarpInstance({ ...body(), network: "Preview" }, "Preprod")).toThrow(/cần Preprod/);
    expect(() => parseCarpInstance(body({ anchor: undefined }), "Preprod")).toThrow(/anchor/);
    expect(() =>
      parseCarpInstance(body({ anchor: { policyId: POLICY, name: "7443415250", unit: POLICY + "7443415250" } }), "Preprod"),
    ).toThrow(/anchor.name sai hình dạng/);
    expect(() =>
      parseCarpInstance(body({ anchor: { policyId: POLICY, name: NAME, unit: POLICY + "00".repeat(28) } }), "Preprod"),
    ).toThrow(/tự mâu thuẫn/);
  });

  it("fetchCarpInstance: HTTP 200 ⟹ đọc · ÂM: HTTP 503 ⟹ NÉM", async () => {
    await expect(fetchCarpInstance("Preprod", fakeFetch(200, body()))).resolves.toMatchObject({ policyId: POLICY });
    await expect(fetchCarpInstance("Preprod", fakeFetch(503, {}))).rejects.toThrow(/HTTP 503/);
  });
});
