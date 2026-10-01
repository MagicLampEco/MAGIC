// tests/datumV2.test.ts — hợp đồng nhị phân VaultDatum InstantGen Gen v2.0.
//
// (1) TV-DATUM-V2-*: `Data.to` của TS == literal CBOR trong `vectors.ts`, và giải mã ngược
//     ra đúng giá trị. Cùng literal được Aiken ghim ở
//     `onchain/lib/magiclamp/protocol/datum_vectors_test.ak` — hai phía cùng một chuỗi.
// (2) `decodeVaultDatum`: 20 trường qua; 18 trường (két Gen v1) NÉM `VAULT_DATUM_V1`;
//     19 trường NÉM `VAULT_DATUM_SHAPE`; 20 trường sai lược đồ con NÉM `VAULT_DATUM_SHAPE`.
//     Mỗi ca âm chỉ khác ca dương đúng một chỗ.

import { describe, it, expect } from "vitest";
import { Data, Constr } from "@lucid-evolution/lucid";
import { VaultDatum, decodeVaultDatum } from "../offchain/src/types.js";
import { TV_DATUM_V2_GENESIS, TV_DATUM_V2_FULL } from "./vectors.js";

const VECTORS = [TV_DATUM_V2_GENESIS, TV_DATUM_V2_FULL];

describe("TV-DATUM-V2 — CBOR datum két v2.0 cố định", () => {
  for (const v of VECTORS) {
    it(`${v.id}: Data.to == literal`, () => {
      expect(Data.to(v.value as never, VaultDatum)).toBe(v.cbor);
    });
    it(`${v.id}: decodeVaultDatum(literal) == giá trị`, () => {
      expect(decodeVaultDatum(v.cbor)).toEqual(v.value);
    });
    it(`${v.id}: đúng 20 trường ở gốc, Constr 0`, () => {
      const raw = Data.from(v.cbor) as Constr<unknown>;
      expect(raw.index).toBe(0);
      expect(raw.fields.length).toBe(20);
    });
  }

  it("hai vector khác nhau ở MỌI ô gốc (một lệch thứ tự trường không trốn sau ô trùng)", () => {
    const a = (Data.from(TV_DATUM_V2_GENESIS.cbor) as Constr<Data>).fields;
    const b = (Data.from(TV_DATUM_V2_FULL.cbor) as Constr<Data>).fields;
    const same = a.map((f, i) => Data.to(f) === Data.to(b[i]!) ? i : -1).filter(i => i >= 0);
    // Ô 13 (activity_state) cố ý trùng hạt giống consumed_credit nhưng khác recent_burn_epochs.
    expect(same).toEqual([]);
  });
});

describe("decodeVaultDatum — chỉ nhận v2.0, NÉM rõ với v1", () => {
  const fields = (Data.from(TV_DATUM_V2_FULL.cbor) as Constr<Data>).fields;
  const withFields = (fs: Data[]) => Data.to(new Constr(0, fs));

  it("ca dương: 20 trường qua", () => {
    expect(() => decodeVaultDatum(withFields(fields))).not.toThrow();
  });
  it("18 trường (két InstantGen Gen v1) ⟹ VAULT_DATUM_V1", () => {
    expect(() => decodeVaultDatum(withFields(fields.slice(0, 18)))).toThrow(/^VAULT_DATUM_V1:/);
  });
  it("19 trường ⟹ VAULT_DATUM_SHAPE (không nhầm thành v1)", () => {
    expect(() => decodeVaultDatum(withFields(fields.slice(0, 19)))).toThrow(/^VAULT_DATUM_SHAPE:/);
  });
  it("21 trường ⟹ VAULT_DATUM_SHAPE", () => {
    expect(() => decodeVaultDatum(withFields([...fields, 0n]))).toThrow(/^VAULT_DATUM_SHAPE:/);
  });
  it("20 trường nhưng ô 6 là danh sách (vacuum_orders đời v1) ⟹ VAULT_DATUM_SHAPE", () => {
    const bad = [...fields];
    bad[6] = [];
    expect(() => decodeVaultDatum(withFields(bad))).toThrow(/^VAULT_DATUM_SHAPE:/);
  });
  it("Constr 1 ⟹ VAULT_DATUM_SHAPE", () => {
    expect(() => decodeVaultDatum(Data.to(new Constr(1, fields)))).toThrow(/^VAULT_DATUM_SHAPE:/);
  });
});
