// VaultTxAPI/tests/sponsorValidity.test.ts — hạn của tx hành trình tài trợ (`sponsor.ts`) đi qua
// CÙNG nguồn với `service.ts`: `planValidity` chọn cận, bộ dựng ghi vào thân, `readTxExpiry` đọc ngược.
//
// Không dựng tx thật (bài dựng thật qua SDK là `sponsorEmulator.test.ts`): CBOR ở đây là fixture mang
// `ttl` ĐÚNG bằng cận mà bộ dựng được giao — đủ để ghim phép lập cận và phép đọc ngược, KHÔNG ghim
// việc bộ dựng SDK thật sự ghi cận đó vào thân (phần đó do `readTxExpiry` ném 500 lúc chạy).

import { credentialToAddress, unixTimeToSlot } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";

import type { ChainTip } from "../src/chain.js";
import { IssuedTxRegistry } from "../src/locks.js";
import { planSponsorValidity, sponsorValidityArgs, toSponsorBody, type SponsorStep } from "../src/sponsor.js";
import { readTxExpiry, type ValidityPlan } from "../src/validity.js";
import { buildTxCbor } from "./fixtures/tx.js";
import { OWNER_PKH } from "./fixtures/preview.js";

const NET = "Preprod" as const;
const TIP: ChainTip = { blockHeight: 1, blockHash: "00".repeat(32), blockTimePosixMs: 1_789_100_703_000n };
const TIP_MS = TIP.blockTimePosixMs;
const TX_VALIDITY_MS = 900_000;
const FEE_REF = `${"fe".repeat(32)}#0`;
const OUT_ADDR = credentialToAddress(NET, { type: "Key", hash: OWNER_PKH });

/** Tx chưa ký mang `ttl` = slot của `validToMs` — thứ bộ dựng sẽ ghi khi tôn trọng cận. */
function txWithValidTo(validToMs: bigint): string {
  return buildTxCbor({
    inputs: [{ txHash: "ab".repeat(32), outputIndex: 0 }],
    outputs: [{ address: OUT_ADDR, assets: { lovelace: 2_000_000n } }],
    feeLovelace: 200_000n,
    requiredSigners: [OWNER_PKH],
    ttlSlot: BigInt(unixTimeToSlot(NET, Number(validToMs))),
  });
}

/** Địa chỉ ví trả phí Feecover trong các ca dưới (sổ nhớ nó khi `/fee/utxo` phát) và ví của chính chủ. */
const FEECOVER_ADDR = credentialToAddress(NET, { type: "Key", hash: "fc".repeat(28) });
const OWN_WALLET_ADDR = OUT_ADDR;

function plan(step: SponsorStep, issued: IssuedTxRegistry, feePayerUtxoRef?: string, address = FEECOVER_ADDR): ValidityPlan {
  return planSponsorValidity({
    step, tipPosixMs: TIP_MS, network: NET, txValidityMs: TX_VALIDITY_MS, issued,
    ...(feePayerUtxoRef === undefined ? {} : { feePayer: { utxoRef: feePayerUtxoRef, address } }),
  });
}

describe("hạn tx tài trợ: kẹp giờ giữ chỗ Feecover", () => {
  it("CẶP (a): reserved_until SỚM hơn tip+15′ ⟹ validTo = reserved_until căn xuống slot, expires_reason fee_reservation", () => {
    const issued = new IssuedTxRegistry();
    const reserved = Number(TIP_MS) + 300_000 + 400; // 5 phút + 400 ms: căn xuống đầu slot
    issued.noteFeeReservation(FEE_REF, reserved);
    const p = plan("T1", issued, FEE_REF);
    expect(p.reason).toBe("fee_reservation");
    expect(p.capMs).toBe(TIP_MS + 300_000n);
    const args = sponsorValidityArgs("T1", p);
    expect(args).toEqual({ validToMs: TIP_MS + 300_000n });
    const e = readTxExpiry(txWithValidTo(TIP_MS + 300_000n), NET, p, TIP_MS);
    expect(e.reason).toBe("fee_reservation");
    expect(e.expiresAt).toBe(new Date(Number(TIP_MS) + 300_000).toISOString());
  });

  it("CẶP (b): reserved_until MUỘN hơn tip+15′ ⟹ validTo = tip+15′, expires_reason tx_validity", () => {
    const issued = new IssuedTxRegistry();
    issued.noteFeeReservation(FEE_REF, Number(TIP_MS) + 2_400_000); // 40 phút
    const p = plan("T1", issued, FEE_REF);
    expect(p.reason).toBe("tx_validity");
    expect(p.capMs).toBe(TIP_MS + 900_000n);
    const e = readTxExpiry(txWithValidTo(TIP_MS + 900_000n), NET, p, TIP_MS);
    expect(e.reason).toBe("tx_validity");
    expect(e.expiresAt).toBe(new Date(Number(TIP_MS) + 900_000).toISOString());
  });

  it("giờ giữ chỗ của UTxO KHÁC không kẹp tx này (khoá tra theo đúng tham chiếu UTxO phí)", () => {
    const issued = new IssuedTxRegistry();
    issued.noteFeeReservation(FEE_REF, Number(TIP_MS) + 300_000);
    expect(plan("T1", issued, `${"fe".repeat(32)}#1`).reason).toBe("tx_validity");
  });

  it("giờ giữ chỗ đã qua ⟹ 409 FEE_PAYER_RESERVATION_EXPIRED trước khi dựng", () => {
    const issued = new IssuedTxRegistry();
    issued.noteFeeReservation(FEE_REF, Number(TIP_MS) - 1);
    expect(() => plan("T1", issued, FEE_REF)).toThrow(expect.objectContaining({ code: "FEE_PAYER_RESERVATION_EXPIRED" }));
  });

  // Thư SuperApp sa1007mg-fc: bộ quét dọn lượt giữ ⟹ bản trước lập hạn như ví không giữ chỗ (tip+15′).
  it("CẶP: lượt giữ của UTxO Feecover ĐÃ BỊ QUÉT ⟹ 409 reservation absent; ví của chính chủ không có lượt giữ ⟹ tx_validity", () => {
    const issued = new IssuedTxRegistry();
    issued.noteFeeReservation(FEE_REF, Number(TIP_MS) - 1, FEECOVER_ADDR);
    issued.sweep(Number(TIP_MS));
    expect(issued.feeReservationOf(FEE_REF)).toBeUndefined();
    expect(() => plan("T1", issued, FEE_REF)).toThrow(expect.objectContaining({
      code: "FEE_PAYER_RESERVATION_EXPIRED",
      details: { fee_payer_utxo: FEE_REF, reserved_until: null, reservation: "absent" },
    }));
    // Cực đối, cùng sổ: một UTxO ở ví của chính chủ (địa chỉ Feecover chưa từng phát nó) ⟹ không kẹp.
    expect(plan("T1", issued, `${"0a".repeat(32)}#0`, OWN_WALLET_ADDR).reason).toBe("tx_validity");
  });
});

describe("hạn tx tài trợ: MỌI bước có validTo", () => {
  it("T1 đường change_address (không fee_payer) vẫn giao validToMs = tip+15′; tx không ttl ⟹ ném bất biến", () => {
    const issued = new IssuedTxRegistry();
    issued.noteFeeReservation(FEE_REF, Number(TIP_MS) + 300_000); // có trong sổ nhưng bước này không tiêu nó
    const p = plan("T1", issued);
    expect(sponsorValidityArgs("T1", p)).toEqual({ validToMs: TIP_MS + 900_000n });
    expect(readTxExpiry(txWithValidTo(TIP_MS + 900_000n), NET, p, TIP_MS).reason).toBe("tx_validity");
    const noTtl = buildTxCbor({
      inputs: [{ txHash: "ab".repeat(32), outputIndex: 0 }],
      outputs: [{ address: OUT_ADDR, assets: { lovelace: 2_000_000n } }],
      feeLovelace: 200_000n,
    });
    expect(() => readTxExpiry(noTtl, NET, p, TIP_MS)).toThrow(/không có validTo/);
  });

  it("CẶP: expires_reason suy từ ttl CỦA CBOR — ttl sớm hơn mọi cận kế hoạch ⟹ builder_cap, không phải tx_validity", () => {
    const issued = new IssuedTxRegistry();
    issued.noteFeeReservation(FEE_REF, Number(TIP_MS) + 300_000);
    const p = plan("T1", issued, FEE_REF); // kế hoạch: fee_reservation thắng ở tip+5′
    expect(p.reason).toBe("fee_reservation");
    // Bộ dựng tự kẹp ở tip+2′: sớm hơn cả hai cận ⟹ không cận nào của kế hoạch giải thích được.
    expect(readTxExpiry(txWithValidTo(TIP_MS + 120_000n), NET, p, TIP_MS).reason).toBe("builder_cap");
    // Cực đối: ttl trùng đúng cận đã thắng ⟹ lý do của cận đó.
    expect(readTxExpiry(txWithValidTo(TIP_MS + 300_000n), NET, p, TIP_MS).reason).toBe("fee_reservation");
    // Kế hoạch không có giữ chỗ: ttl sớm hơn tip+15′ ⟹ vẫn không gán tx_validity.
    const q = plan("T1", new IssuedTxRegistry());
    expect(readTxExpiry(txWithValidTo(TIP_MS + 600_000n), NET, q, TIP_MS).reason).toBe("builder_cap");
  });

  it("T2/T3/T4 nhận cận dưới dạng tham số của bộ dựng SDK (maxAheadMs = cap − tip), kẹp cuối epoch", () => {
    const issued = new IssuedTxRegistry();
    for (const step of ["T2", "T3", "T4"] as const) {
      const p = plan(step, issued);
      expect(p.maxAheadMs).toBe(p.capMs - TIP_MS);
      expect(p.maxAheadMs > 0n && p.maxAheadMs <= 900_000n).toBe(true);
      const args = sponsorValidityArgs(step, p) as Record<string, bigint>;
      expect(Object.values(args)).toEqual([p.maxAheadMs]);
      expect(Object.keys(args)).toEqual([step === "T4" ? "validityMaxAheadMs" : "validityTtlMs"]);
    }
  });
});

describe("toSponsorBody — witness_notes mang dòng hạn khớp expires_at", () => {
  const base = {
    step: "T1" as SponsorStep, txCbor: "", txHash: "", requiredSigners: [], signers: [],
    witnessNotes: ["ghi chú có sẵn"], summary: {}, expiresAt: "2026-10-06T03:00:00.000Z",
  };
  it("CẶP: fee_reservation và epoch_end cho hai câu khác nhau, cùng mốc, ghi chú cũ giữ nguyên ở đầu", () => {
    const a = toSponsorBody({ ...base, expiresReason: "fee_reservation" }) as { witness_notes: string[] };
    const e = toSponsorBody({ ...base, expiresReason: "epoch_end" }) as { witness_notes: string[] };
    expect(a.witness_notes[0]).toBe("ghi chú có sẵn");
    expect(a.witness_notes).toHaveLength(2);
    for (const n of [a.witness_notes[1], e.witness_notes[1]]) expect(n).toContain(`trước ${base.expiresAt} `);
    expect(a.witness_notes[1]).toContain("Feecover");
    expect(e.witness_notes[1]).toContain("cuối epoch");
    expect(a.witness_notes[1]).not.toBe(e.witness_notes[1]);
  });
});

// Thư SuperApp sa1007mg-rid: bốn bước tài trợ đi qua CÙNG cổng mã lượt giữ với `service.ts`.
describe("hạn tx tài trợ: mã lượt giữ (reservation_id)", () => {
  const ID_OLD = "0a".repeat(16);
  const ID_NEW = "0b".repeat(16);

  it("CẶP: mã khớp lượt giữ đang sống ⟹ lập hạn được và đếm with_id; mã của lượt giữ CŨ ⟹ 409 foreign", () => {
    const logs: string[] = [];
    const issued = new IssuedTxRegistry(l => logs.push(l));
    issued.noteFeeReservation(FEE_REF, Number(TIP_MS) + 300_000, FEECOVER_ADDR, ID_OLD);
    // Feecover giao lại UTxO ⟹ lượt giữ mới, mã mới.
    issued.noteFeeReservation(FEE_REF, Number(TIP_MS) + 300_000, FEECOVER_ADDR, ID_NEW);
    const run = (reservationId: string) => planSponsorValidity({
      step: "T2", tipPosixMs: TIP_MS, network: NET, txValidityMs: TX_VALIDITY_MS, issued, route: "sponsor-t2-fund",
      feePayer: { utxoRef: FEE_REF, address: FEECOVER_ADDR, reservationId },
    });
    expect(run(ID_NEW).reason).toBe("fee_reservation");
    expect(() => run(ID_OLD)).toThrow(expect.objectContaining({
      code: "FEE_PAYER_RESERVATION_EXPIRED",
      details: { fee_payer_utxo: FEE_REF, reserved_until: null, reservation: "foreign" },
    }));
    expect(issued.reservationIdStats()).toEqual({ with_id: { "sponsor-t2-fund": 1 }, without_id: {} });
    expect(logs).toEqual([]);
  });
});
