// tests/paymaster.test.ts — Paymaster offchain test suite.
//
// Phủ 3 lớp:
//  1. CODEC P8 — datum/redeemer encode→decode roundtrip + cấu trúc CBOR Constr đúng
//     thứ tự field (mirror BYTE-PERFECT types.ak). Đảo thứ tự 1 bên = test vỡ.
//  2. MATH — lamp_cap/ada_cap Q-format (khớp math.ak test vectors TV-PM-PRICE-01/02).
//  3. METER STATE — lookup_did/add_did + magic_consumed dedup (mirror util.ak +
//     paymaster.ak state transition). Đại lượng builder dùng để dựng meter_out.
//
// CHẠY: cd Paymaster/offchain && npm install && npm test

import { describe, it, expect } from "vitest";
import { Data } from "@lucid-evolution/lucid";
import {
  SponsorPolicySchema, SponsorMeterSchema, ProtocolFeeParamsSchema,
  PaymasterRedeemerSchema, OutputReferenceSchema,
  encodeSponsorPolicy, decodeSponsorPolicy,
  encodeSponsorMeter, decodeSponsorMeter,
  encodeProtocolFeeParams, decodeProtocolFeeParams,
  encodePaymasterRedeemer, decodePaymasterRedeemer,
  type SponsorPolicyT, type SponsorMeterT, type ProtocolFeeParamsT,
  type PaymasterRedeemerT,
} from "../offchain/src/types.js";
import {
  lampCap, adaCap, q, sumBurns, lookupDid, addDid, updateGlobalMagic,
  type Burn, type DidLampEntry,
} from "../offchain/src/math.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const APP_ID = "0a99";
const APP_AUTH = "abcdef";
const OWNER = "0bada55e";
const REF_A: { transaction_id: string; output_index: bigint } = {
  transaction_id: "a1", output_index: 0n,
};
const REF_B = { transaction_id: "bb", output_index: 9n };
const REF_C = { transaction_id: "cc", output_index: 8n };

function mkPolicy(over: Partial<SponsorPolicyT> = {}): SponsorPolicyT {
  return {
    app_id: APP_ID,
    app_authority: APP_AUTH,
    max_per_did_per_epoch: 10_000_000_000n,
    max_global_per_epoch: 100_000_000_000n,
    lamp_per_magic_q: 500_000_000n,
    ada_per_magic_q: 0n,
    oracle_nft_policy: null,
    epoch: 6n,
    ...over,
  };
}

function mkMeter(over: Partial<SponsorMeterT> = {}): SponsorMeterT {
  return { app_id: APP_ID, epoch: 6n, did_lamp_map: [], global_lamp_epoch: 0n, global_magic_epoch: 0n, ...over };
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. CODEC P8 — roundtrip + cấu trúc Constr
// ══════════════════════════════════════════════════════════════════════════════

describe("P8 codec — roundtrip", () => {
  it("SponsorPolicy: encode→decode bảo toàn (oracle None)", () => {
    const p = mkPolicy();
    const back = decodeSponsorPolicy(encodeSponsorPolicy(p));
    expect(back).toEqual(p);
  });

  it("SponsorPolicy: oracle Some(bytes) (CIP-31 v1.x) roundtrip", () => {
    const p = mkPolicy({ oracle_nft_policy: "deadbeef" });
    const back = decodeSponsorPolicy(encodeSponsorPolicy(p));
    expect(back.oracle_nft_policy).toBe("deadbeef");
    expect(back).toEqual(p);
  });

  it("SponsorMeter: did_lamp_map nhiều entry roundtrip (giữ thứ tự)", () => {
    const m = mkMeter({
      did_lamp_map: [["feed", 1_000_000n], [OWNER, 5_000_000n]],
      global_lamp_epoch: 6_000_000n,
    });
    const back = decodeSponsorMeter(encodeSponsorMeter(m));
    expect(back).toEqual(m);
    expect(back.did_lamp_map[0][0]).toBe("feed");
    expect(back.did_lamp_map[1][0]).toBe(OWNER);
  });

  it("ProtocolFeeParams: Bool active True/False mã hoá đúng tag (False=0,True=1)", () => {
    const pT = { min_lamp_per_magic_q: 500_000_000n, protocol_fee_active: true, epoch: 6n };
    const pF = { min_lamp_per_magic_q: 0n, protocol_fee_active: false, epoch: 6n };
    expect(decodeProtocolFeeParams(encodeProtocolFeeParams(pT))).toEqual(pT);
    expect(decodeProtocolFeeParams(encodeProtocolFeeParams(pF))).toEqual(pF);
  });

  it("PaymasterRedeemer Sponsor: roundtrip 6 field đúng thứ tự", () => {
    const r: PaymasterRedeemerT = {
      vault_refs: [REF_A],
      policy_ref: REF_B,
      protocol_ref: REF_C,
      did_key: OWNER,
      lamp_this: 5_000_000n,
      ada_this: 0n,
    };
    const back = decodePaymasterRedeemer(encodePaymasterRedeemer(r));
    expect(back).toEqual(r);
  });

  it("SponsorMeter CBOR = Constr(0,[...]) đúng thứ tự field app_id,epoch,map,global_lamp,global_magic", () => {
    // Đối chiếu cấu trúc Plutus: field index 1=epoch, 3=global_lamp_epoch, 4=global_magic_epoch.
    const m = mkMeter({ epoch: 42n, global_lamp_epoch: 7n, global_magic_epoch: 99n });
    const cbor = encodeSponsorMeter(m);
    const raw = Data.from(cbor); // generic → Constr
    // @ts-expect-error truy cập runtime Constr
    expect(raw.index).toBe(0);
    // @ts-expect-error fields[1] = epoch
    expect(raw.fields[1]).toBe(42n);
    // @ts-expect-error fields[3] = global_lamp_epoch
    expect(raw.fields[3]).toBe(7n);
    // @ts-expect-error fields[4] = global_magic_epoch (append cuối)
    expect(raw.fields[4]).toBe(99n);
  });

  it("OutputReference schema: transaction_id rồi output_index (thứ tự)", () => {
    const cbor = Data.to(REF_A, OutputReferenceSchema as unknown as typeof REF_A);
    const back = Data.from(cbor, OutputReferenceSchema as unknown as typeof REF_A);
    expect(back).toEqual(REF_A);
  });

  it("SponsorPolicy CBOR: 8 field đúng số lượng + index oracle_nft_policy=6", () => {
    const p = mkPolicy({ oracle_nft_policy: "ab" });
    const raw = Data.from(encodeSponsorPolicy(p));
    // @ts-expect-error runtime Constr fields
    expect(raw.fields.length).toBe(8);
    // @ts-expect-error oracle Some = Constr(0,[bytes]) ở index 6
    expect(raw.fields[6].index).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. MATH — Q-format fee caps (mirror math.ak)
// ══════════════════════════════════════════════════════════════════════════════

describe("math — Q-format fee caps", () => {
  it("q == 1e9 (khớp ProtocolUtils.Q + math.ak)", () => {
    expect(q).toBe(1_000_000_000n);
  });

  it("TV-PM-PRICE-01: lampCap(10M, 0.5×Q) == 5M oil", () => {
    expect(lampCap(10_000_000n, 500_000_000n)).toBe(5_000_000n);
  });

  it("TV-PM-PRICE-02: adaCap(50M, 2.0×Q) == 100M lovelace", () => {
    expect(adaCap(50_000_000n, 2_000_000_000n)).toBe(100_000_000n);
  });

  it("rate 1.0×Q → cap == magic_consumed", () => {
    expect(lampCap(7_777_777n, q)).toBe(7_777_777n);
  });

  it("rate 0 → cap 0", () => {
    expect(lampCap(10_000_000n, 0n)).toBe(0n);
  });

  it("floor: 3 nanogic × rate 1 / Q = 0", () => {
    expect(lampCap(3n, 1n)).toBe(0n);
  });

  it("BigInt overflow-safe (amount lớn, KHÔNG Number)", () => {
    expect(lampCap(1_000_000_000_000_000n, 2_000_000_000n)).toBe(2_000_000_000_000_000n);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. METER STATE — magic_consumed dedup + did_lamp_map (mirror util.ak)
// ══════════════════════════════════════════════════════════════════════════════

describe("meter state — magic_consumed + did_lamp_map", () => {
  it("sumBurns Σ amount", () => {
    const burns: Burn[] = [["ba01", 10_000_000n], ["ba02", 5_000_000n]];
    expect(sumBurns(burns)).toBe(15_000_000n);
  });

  it("lookupDid: miss → 0, hit → đúng oil", () => {
    const map: DidLampEntry[] = [["feed", 3n], [OWNER, 99n]];
    expect(lookupDid(map, "nope")).toBe(0n);
    expect(lookupDid(map, OWNER)).toBe(99n);
  });

  it("addDid: key mới append CUỐI (mirror util.ak:163)", () => {
    const out = addDid([["feed", 1n]], OWNER, 5_000_000n);
    expect(out).toEqual([["feed", 1n], [OWNER, 5_000_000n]]);
  });

  it("addDid: key đã có → cộng dồn, giữ vị trí (mirror util.ak:152-161)", () => {
    const out = addDid([[OWNER, 1_000_000n], ["feed", 2n]], OWNER, 4_000_000n);
    expect(out).toEqual([[OWNER, 5_000_000n], ["feed", 2n]]);
  });

  it("state transition KHỚP validator: base [] + lamp_this → map+global", () => {
    // mirror paymaster.ak:142-144 (epoch fresh, base global 0).
    const lampThis = lampCap(10_000_000n, 500_000_000n); // 5M
    const newMap = addDid([], OWNER, lampThis);
    const newGlobal = 0n + lampThis;
    expect(newMap).toEqual([[OWNER, 5_000_000n]]);
    expect(newGlobal).toBe(5_000_000n);
  });

  it("dedup: 2 vault refs trùng OutRef đếm magic 1 lần", () => {
    // mirror util.dedup_refs — builder Set theo `${txHash}#${ix}`.
    const refs = ["a1#0", "a1#0", "a1#1"];
    const seen = new Set<string>();
    let total = 0n;
    for (const r of refs) {
      if (seen.has(r)) continue;
      seen.add(r);
      total += 10_000_000n;
    }
    expect(total).toBe(20_000_000n); // 2 phân biệt × 10M
  });

  it("updateGlobalMagic: epoch mới → global_magic_epoch = magic_consumed", () => {
    // baseMagic = 0 (epoch rollover), magic_consumed = 15M nanogic.
    expect(updateGlobalMagic(0n, 15_000_000n)).toBe(15_000_000n);
  });

  it("updateGlobalMagic: cùng epoch → global_magic_epoch += magic_consumed", () => {
    // baseMagic = 30M (đã tích lũy), magic_consumed = 10M → 40M tổng.
    expect(updateGlobalMagic(30_000_000n, 10_000_000n)).toBe(40_000_000n);
  });

  it("SponsorMeter roundtrip giữ global_magic_epoch", () => {
    const m = mkMeter({
      did_lamp_map: [[OWNER, 5_000_000n]],
      global_lamp_epoch: 5_000_000n,
      global_magic_epoch: 10_000_000n,
    });
    const back = decodeSponsorMeter(encodeSponsorMeter(m));
    expect(back.global_magic_epoch).toBe(10_000_000n);
    expect(back).toEqual(m);
  });

  it("state transition: global_magic_epoch epoch mới = magic_consumed (reset + cộng)", () => {
    // Epoch cũ: global_magic_epoch = 999n. Sang epoch mới: base = 0, result = magic_consumed.
    const magic_consumed = 25_000_000n;
    const base_magic = 0n; // epochRollover
    expect(updateGlobalMagic(base_magic, magic_consumed)).toBe(25_000_000n);
  });

  it("state transition: global_magic_epoch cùng epoch = base + magic_consumed", () => {
    // Cùng epoch: base = meter_in.global_magic_epoch, cộng dồn.
    const base_magic = 50_000_000n;
    const magic_consumed = 20_000_000n;
    expect(updateGlobalMagic(base_magic, magic_consumed)).toBe(70_000_000n);
  });
});
