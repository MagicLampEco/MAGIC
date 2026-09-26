import { describe, expect, it } from "vitest";

import { enumerateFarmers } from "../src/farmers.ts";
import { fakeEnv } from "./helpers.ts";

describe("liệt kê nông dân từ môi trường", () => {
  it("17 biến FARMER_SEED_NN ⟹ 17 nông dân, đúng thứ tự", () => {
    const f = enumerateFarmers(fakeEnv(17));
    expect(f.length).toBe(17);
    expect(f[0]!.id).toBe("farmer-01");
    expect(f[16]!.id).toBe("farmer-17");
  });
  it("thêm các tên SAI mẫu ⟹ vẫn 17", () => {
    const env = { ...fakeEnv(17), FARMER_SEED_X: "fake", FARMER_SEED: "fake", farmer_seed_18: "fake", FARMER_SEED_19_OLD: "fake", XFARMER_SEED_20: "fake" };
    expect(enumerateFarmers(env).length).toBe(17);
  });
  it("tên đúng mẫu mà rỗng ⟹ ném, không lặng lẽ bớt một nông dân", () => {
    expect(() => enumerateFarmers({ ...fakeEnv(3), FARMER_SEED_04: "  " })).toThrow(/FARMER_SEED_04/);
  });
});
