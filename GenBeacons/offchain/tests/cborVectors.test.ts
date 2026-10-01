// Vector CBOR: lược đồ TS ↔ mã hoá Aiken, trùng BYTE.
//
// Hằng hex KHÔNG chép vào đây: đọc thẳng từ GenBeacons/onchain/lib/genbeacons/cbor_vectors.ak,
// nơi `aiken check` ghim cùng hằng đó với `cbor.serialise`. Hai bên cùng khớp một hằng ⟹ thứ
// tự trường + chỉ số constructor của `src/types.ts` trùng `lib/genbeacons/types.ak`.
// Giá trị fixture thì phải khai ở cả hai tệp (không có cách sinh chung) — lệch giá trị thì
// bài đỏ ồn ào, không lệch im lặng.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Data } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";
import {
  decodeGbShard,
  decodeGreenBackBeacon,
  decodeRateParam,
  decodeVaultRegistry,
  encodeGbShard,
  encodeGbShardRedeemer,
  encodeGreenBackBeacon,
  encodeRateParam,
  encodeVaultRegistry,
  GbShardRedeemer,
  outRefData,
} from "../src/index.js";

const AK_PATH = fileURLToPath(
  new URL("../../onchain/lib/genbeacons/cbor_vectors.ak", import.meta.url),
);
const AK = readFileSync(AK_PATH, "utf8");

/** Hằng `pub const <name>: ByteArray = #"…"` trong tệp .ak. Không thấy ⟹ ném (không đệm). */
function akVector(name: string): string {
  const m = new RegExp(`pub const ${name}: ByteArray =\\s*#"([0-9a-f]+)"`).exec(AK);
  if (!m || m[1] === undefined) throw new Error(`không thấy hằng ${name} trong ${AK_PATH}`);
  return m[1];
}

const H1 = "7a" + "00".repeat(26) + "01";
const H2 = "7a" + "00".repeat(26) + "02";

describe("vector CBOR khớp Aiken (lib/genbeacons/cbor_vectors.ak)", () => {
  it("RateParam", () => {
    const d = { rho_q: 1_234_567_890n, prev_rho_q: 987_654_321n, effective_epoch: 20_001n };
    const hex = akVector("rate_param_cbor");
    expect(encodeRateParam(d)).toBe(hex);
    expect(decodeRateParam(hex)).toEqual(d);
  });

  it("GreenBackBeacon — depeg True, gb > 2⁶⁴ (bignum)", () => {
    const d = { gb_nanogic: 36_000_000_000_000_000_000n, seq: 7n, epoch: 20_000n, depeg: true };
    const hex = akVector("greenback_depeg_cbor");
    expect(encodeGreenBackBeacon(d)).toBe(hex);
    expect(decodeGreenBackBeacon(hex)).toEqual(d);
  });

  it("GreenBackBeacon — depeg False (Constr 0 rỗng)", () => {
    const d = { gb_nanogic: 0n, seq: 0n, epoch: 20_000n, depeg: false };
    const hex = akVector("greenback_genesis_cbor");
    expect(encodeGreenBackBeacon(d)).toBe(hex);
    expect(decodeGreenBackBeacon(hex)).toEqual(d);
  });

  it("GbShard", () => {
    const d = {
      shard_id: 15n,
      seq: 7n,
      reset_amount: 1_800_000_000_000_000n,
      remaining: 1_799_999_999_999_600n,
    };
    const hex = akVector("gb_shard_cbor");
    expect(encodeGbShard(d)).toBe(hex);
    expect(decodeGbShard(hex)).toEqual(d);
  });

  it("VaultRegistry", () => {
    const d = { vault_script_hashes: [H1, H2] };
    const hex = akVector("vault_registry_cbor");
    expect(encodeVaultRegistry(d)).toBe(hex);
    expect(decodeVaultRegistry(hex)).toEqual(d);
  });

  it("GbShardRedeemer::Draw", () => {
    const hex = akVector("gb_shard_redeemer_cbor");
    expect(encodeGbShardRedeemer({ amount: 400n })).toBe(hex);
    expect(Data.from(hex, GbShardRedeemer)).toEqual({ amount: 400n });
  });

  it("OutputReference (apply-param seed)", () => {
    const hex = akVector("output_reference_cbor");
    const txHash = "5eed" + "00".repeat(29) + "ab";
    expect(Data.to(outRefData({ txHash, outputIndex: 3 }))).toBe(hex);
  });
});

describe("giải mã hình dạng lạ ⟹ NÉM, không đệm", () => {
  it("GbShard thiếu một trường bị từ chối; đủ trường thì qua", () => {
    const full = encodeGbShard({ shard_id: 1n, seq: 0n, reset_amount: 0n, remaining: 0n });
    expect(decodeGbShard(full).shard_id).toBe(1n);
    // Constr 0 [1, 0, 0] — 3 trường, Aiken cũng từ chối (nghiêm số trường cả hai chiều).
    expect(() => decodeGbShard("d8799f010000ff")).toThrow(/GbShard/);
  });

  it("GreenBackBeacon datum rỗng/thiếu bị từ chối", () => {
    expect(() => decodeGreenBackBeacon(undefined)).toThrow(/không có datum/);
    expect(() => decodeGreenBackBeacon(null)).toThrow(/không có datum/);
  });

  it("RateParam dư một trường bị từ chối", () => {
    expect(() => decodeRateParam("d8799f01020304ff")).toThrow(/RateParam/);
  });
});
