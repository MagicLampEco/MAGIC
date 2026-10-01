// tests/lentRead.test.ts — `readLentLamp` là gương của `wakeme_lent.ak ▸ lent_lamp`
// (CC-GEN-LENT-READ). Mỗi ca chỉ đổi MỘT vế so với ca dương.
import { describe, it, expect } from "vitest";
import {
  Data, Constr, credentialToAddress, scriptHashToCredential, keyHashToCredential,
  type UTxO,
} from "@lucid-evolution/lucid";
import { readLentLamp, type LentReadContext } from "../offchain/src/instant.js";

const WAKEME = "cc62732565af6be1e0874975ad3b3e2afdb0abafb3f5bc4b3008f4e1";
const OTHER  = "dd62732565af6be1e0874975ad3b3e2afdb0abafb3f5bc4b3008f4e1";
const IG     = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const IG_NAME = "b2".repeat(32);
const COMMIT  = "c3".repeat(32);
const LAMP_POLICY = "e1".repeat(28);
const LAMP_NAME   = "744c414d50";
const CONDITIONAL = 700_000_000n;
const OWNED       = 301_000_000n;
const PERIOD      = 100n;

const ctx: LentReadContext = {
  wakemeVaultHash: WAKEME, ownScriptHash: IG, ownVaultName: IG_NAME,
  currentPeriod: PERIOD, lampPolicyId: LAMP_POLICY, lampAssetName: LAMP_NAME,
};

function pin(hash: string, name: string): Data {
  return new Constr(0, [new Constr(0, [hash, name])]);
}

function fields(o: Partial<{ commit: string; cond: bigint; owned: bigint; gen: Data; period: bigint }> = {}): Data[] {
  return [
    o.commit ?? COMMIT, "e5e5", 1_700_000_000_000n, o.cond ?? CONDITIONAL, 0n, 50n, 49n,
    o.owned ?? OWNED, 1_000_000n, 0n, "f6f6", o.gen ?? pin(IG, IG_NAME), o.period ?? PERIOD - 1n,
  ];
}

function utxo(o: Partial<{ script: string; fs: Data[]; lamp: bigint; nftQty: bigint; datumHash: boolean }> = {}): UTxO {
  const script = o.script ?? WAKEME;
  return {
    txHash: "00".repeat(32), outputIndex: 0,
    address: credentialToAddress("Preprod", scriptHashToCredential(script)),
    assets: {
      lovelace: 5_000_000n,
      [WAKEME + COMMIT]: o.nftQty ?? 1n,
      [LAMP_POLICY + LAMP_NAME]: o.lamp ?? CONDITIONAL + OWNED,
    },
    datum: o.datumHash ? undefined : Data.to(new Constr(0, o.fs ?? fields())),
    datumHash: o.datumHash ? "ab".repeat(32) : undefined,
  } as UTxO;
}

describe("readLentLamp — gương lent_lamp", () => {
  it("két hợp lệ ⟹ conditional + owned", () => {
    expect(readLentLamp(utxo(), ctx)).toBe(CONDITIONAL + OWNED);
  });
  it("(d) ghim trong chính kỳ ⟹ 0, không ném", () => {
    expect(readLentLamp(utxo({ fs: fields({ period: PERIOD }) }), ctx)).toBe(0n);
  });
  it("(f) value thiếu 1 oildrop ⟹ 0", () => {
    expect(readLentLamp(utxo({ lamp: CONDITIONAL + OWNED - 1n }), ctx)).toBe(0n);
  });
  it("(f) value dư ⟹ đúng số datum, không phải phần dư", () => {
    expect(readLentLamp(utxo({ lamp: CONDITIONAL + OWNED + 5n }), ctx)).toBe(CONDITIONAL + OWNED);
  });
  it("(c) ghim két IG khác ⟹ ném", () => {
    expect(() => readLentLamp(utxo({ fs: fields({ gen: pin(IG, "0101") }) }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("(c) gen_vault = None ⟹ ném", () => {
    expect(() => readLentLamp(utxo({ fs: fields({ gen: new Constr(1, []) }) }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("(b) NFT số lượng 2 ⟹ ném", () => {
    expect(() => readLentLamp(utxo({ nftQty: 2n }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("(e) lượng âm ⟹ ném", () => {
    expect(() => readLentLamp(utxo({ fs: fields({ cond: -1n }) }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("(a) 12 trường ⟹ ném", () => {
    expect(() => readLentLamp(utxo({ fs: fields().slice(0, 12) }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("luật 1: két ở script khác ⟹ ném (bộ dựng không lọc hộ)", () => {
    expect(() => readLentLamp(utxo({ script: OTHER }), ctx)).toThrow(/GEN-INST-010/);
  });
  it("địa chỉ khoá (không phải script) ⟹ ném", () => {
    const u = { ...utxo(), address: credentialToAddress("Preprod", keyHashToCredential(WAKEME)) } as UTxO;
    expect(() => readLentLamp(u, ctx)).toThrow(/GEN-INST-010/);
  });
});
