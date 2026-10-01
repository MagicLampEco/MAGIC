// tests/wakemeVaultHash.test.ts — apply-param #8 của vault InstantGen, theo mạng.
//
// Hai chiều phải cùng ghim: mạng CÓ két trả đúng giá trị, mạng CHƯA có két thì NÉM
// (không trả giá trị đệm — một hash giả vẫn nướng ra một vault hợp lệ, chỉ là không bao
// giờ đọc được két thật).
import { describe, it, expect } from "vitest";
import {
  wakemeVaultHash, assertWakemeVaultHash, WAKEME_VAULT_HASH_BY_NETWORK,
} from "../src/index.js";

const PREPROD_V3 = "cc62732565af6be1e0874975ad3b3e2afdb0abafb3f5bc4b3008f4e1";

describe("wakemeVaultHash — theo mạng, fail-closed", () => {
  it("Preprod ⟹ két Wakeme v3", () => {
    expect(wakemeVaultHash("Preprod")).toBe(PREPROD_V3);
  });

  it("Preview và Mainnet chưa có két ⟹ NÉM, nêu tên mạng", () => {
    expect(() => wakemeVaultHash("Preview")).toThrow(/chưa có két Wakeme trên Preview/);
    expect(() => wakemeVaultHash("Mainnet")).toThrow(/chưa có két Wakeme trên Mainnet/);
  });

  it("bảng không mang dòng giữ chỗ nào (all-zero, rỗng)", () => {
    for (const v of Object.values(WAKEME_VAULT_HASH_BY_NETWORK)) {
      expect(v).not.toBe("00".repeat(28));
      expect(assertWakemeVaultHash(v, "bảng")).toBe(v);
    }
  });
});

describe("assertWakemeVaultHash — 56 hex thường", () => {
  it("nhận đúng dạng", () => {
    expect(assertWakemeVaultHash(PREPROD_V3, "t")).toBe(PREPROD_V3);
  });

  it.each([
    ["hoa", PREPROD_V3.toUpperCase()],
    ["thiếu một ký tự", PREPROD_V3.slice(1)],
    ["thừa một byte", PREPROD_V3 + "00"],
    ["không phải hex", "zz" + PREPROD_V3.slice(2)],
    ["rỗng", ""],
  ])("NÉM: %s", (_name, v) => {
    expect(() => assertWakemeVaultHash(v, "t")).toThrow(/wakeme_vault_hash/);
  });

  it("NÉM khi không phải chuỗi", () => {
    expect(() => assertWakemeVaultHash(undefined, "t")).toThrow(/undefined/);
    expect(() => assertWakemeVaultHash(123, "t")).toThrow(/number/);
  });
});
