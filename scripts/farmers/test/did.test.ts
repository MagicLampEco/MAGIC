import { describe, expect, it } from "vitest";

import { base32GenesisMs } from "../src/did.ts";

describe("base32GenesisMs", () => {
  it("vector chuẩn", () => {
    expect(base32GenesisMs(0n)).toBe("aaaaaaaaaaaaa");
    expect(base32GenesisMs(7n)).toBe("aaaaaaaaaaaao");
    expect(base32GenesisMs(1754000000000n)).toBe("aaaadgdcrqcaa");
  });
  it("lệch một mili-giây ⟹ khác chuỗi; độ dài cố định 13", () => {
    expect(base32GenesisMs(1754000000001n)).not.toBe("aaaadgdcrqcaa");
    expect(base32GenesisMs(6n)).not.toBe("aaaaaaaaaaaao");
    expect(base32GenesisMs(1754000000000n).length).toBe(13);
  });
});
