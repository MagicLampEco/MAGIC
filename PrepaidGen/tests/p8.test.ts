// tests/p8.test.ts — CỔNG P8: bit-identical Aiken ↔ TypeScript
//
// Không chấp nhận "hai bên viết cùng công thức nên chắc giống nhau". Test này
// ĐỌC THẲNG bảng vector trong mã nguồn Aiken
// (onchain/lib/magiclamp/protocol/vectors.ak), trích các cột literal, rồi chạy
// hàm TypeScript trên đúng cột đó. Bên Aiken có test riêng chạy hàm on-chain
// trên CÙNG bảng ấy. Sửa lệch một bên → một trong hai bên đỏ ngay.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bufferFloor,
  parCarpFromMagic,
  parMagicFromCarp,
} from "../offchain/src/math.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_AK = resolve(HERE, "../onchain/lib/magiclamp/protocol/vectors.ak");

const SOURCE = readFileSync(VECTORS_AK, "utf8");

/** Trích một hằng `pub const <name>: List<Int> = [ ... ]` từ mã nguồn Aiken. */
function akIntList(name: string): bigint[] {
  const re = new RegExp(
    `pub\\s+const\\s+${name}\\s*:\\s*List<Int>\\s*=\\s*\\[([\\s\\S]*?)\\]`,
  );
  const m = SOURCE.match(re);
  if (!m || m[1] === undefined) {
    throw new Error(`không tìm thấy hằng ${name} trong ${VECTORS_AK}`);
  }
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/_/g, ""))
    .filter((s) => s.length > 0)
    .map((s) => BigInt(s));
}

describe("P8 — bảng vector đọc từ chính mã nguồn Aiken", () => {
  it("đọc được cả 7 cột, không cột nào rỗng", () => {
    const names = [
      "v1_par_in",
      "v1_par_out",
      "v2_inv_in",
      "v2_inv_out",
      "v3_buf_outstanding",
      "v3_buf_bps",
      "v3_buf_out",
    ];
    for (const n of names) {
      const col = akIntList(n);
      expect(col.length, `${n} rỗng`).toBeGreaterThan(0);
    }
  });

  it("V1 — parMagicFromCarp khớp từng phần tử với vế Aiken", () => {
    const input = akIntList("v1_par_in");
    const expected = akIntList("v1_par_out");
    expect(input.length).toBe(expected.length);
    expect(input.map(parMagicFromCarp)).toEqual(expected);
  });

  it("V2 — parCarpFromMagic khớp từng phần tử với vế Aiken", () => {
    const input = akIntList("v2_inv_in");
    const expected = akIntList("v2_inv_out");
    expect(input.length).toBe(expected.length);
    expect(input.map(parCarpFromMagic)).toEqual(expected);
  });

  it("V3 — bufferFloor khớp từng phần tử với vế Aiken", () => {
    const outstanding = akIntList("v3_buf_outstanding");
    const bps = akIntList("v3_buf_bps");
    const expected = akIntList("v3_buf_out");
    expect(outstanding.length).toBe(bps.length);
    expect(outstanding.length).toBe(expected.length);
    const got = outstanding.map((o, i) => bufferFloor(o, bps[i]!));
    expect(got).toEqual(expected);
  });

  it("vòng tròn par chính xác trên toàn bảng (C-PP-1)", () => {
    for (const c of akIntList("v1_par_in")) {
      expect(parCarpFromMagic(parMagicFromCarp(c))).toBe(c);
    }
  });

  it("bảng có ít nhất một mốc vượt 2^53 — chốt chặn C-OVERFLOW", () => {
    const big = akIntList("v1_par_out").filter(
      (v) => v > BigInt(Number.MAX_SAFE_INTEGER),
    );
    expect(big.length).toBeGreaterThan(0);
  });
});

describe("P8 — hằng số chia sẻ khớp giữa constants.ak và constants.ts", () => {
  const CONSTANTS_AK = resolve(HERE, "../onchain/lib/magiclamp/protocol/constants.ak");
  const AK = readFileSync(CONSTANTS_AK, "utf8");

  function akConst(name: string): bigint {
    const m = AK.match(new RegExp(`pub\\s+const\\s+${name}\\s*:\\s*Int\\s*=\\s*([0-9_]+)`));
    if (!m || m[1] === undefined) throw new Error(`thiếu hằng ${name} trong constants.ak`);
    return BigInt(m[1].replace(/_/g, ""));
  }

  it.each([
    ["par_scale", "PAR_SCALE"],
    ["carpdrop_per_carp", "CARPDROP_PER_CARP"],
    ["nanogic_per_magic", "NANOGIC_PER_MAGIC"],
    ["batch_source_prepaid", "BATCH_SOURCE_PREPAID"],
    ["prepaid_decay_window", "PREPAID_DECAY_WINDOW"],
    ["min_lock_carpdrop", "MIN_LOCK_CARPDROP"],
    ["min_draw_carpdrop", "MIN_DRAW_CARPDROP"],
    ["max_batches_per_vault", "MAX_BATCHES_PER_VAULT"],
    ["max_prepaid_credits", "MAX_PREPAID_CREDITS"],
    ["bps_denom", "BPS_DENOM"],
    ["min_buffer_bps", "MIN_BUFFER_BPS"],
  ])("%s == %s", async (akName, tsName) => {
    const ts = (await import("../offchain/src/constants.js")) as Record<string, unknown>;
    expect(BigInt(ts[tsName] as bigint | number)).toBe(akConst(akName));
  });

  it("par_scale = nanogic_per_magic / carpdrop_per_carp (không phải số ma thuật)", () => {
    expect(akConst("nanogic_per_magic") / akConst("carpdrop_per_carp")).toBe(
      akConst("par_scale"),
    );
  });
});
