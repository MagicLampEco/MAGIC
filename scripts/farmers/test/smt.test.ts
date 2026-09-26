import { describe, expect, it } from "vitest";

import { DEFAULTS, EMPTY_ROOT_DEPTH_256, bytesToHex, rootOf } from "../src/smt.ts";

describe("cây SMT rỗng độ sâu 256", () => {
  it("DEFAULTS[256] == EMPTY_ROOT_DEPTH_256, và rootOf([]) cũng vậy", () => {
    expect(bytesToHex(DEFAULTS[256]!)).toBe(EMPTY_ROOT_DEPTH_256);
    expect(rootOf([])).toBe(EMPTY_ROOT_DEPTH_256);
  });
  it("mức kề bên (255) và cây một lá KHÔNG bằng gốc rỗng", () => {
    expect(bytesToHex(DEFAULTS[255]!)).not.toBe(EMPTY_ROOT_DEPTH_256);
    expect(rootOf(["11".repeat(32)])).not.toBe(EMPTY_ROOT_DEPTH_256);
  });
});
