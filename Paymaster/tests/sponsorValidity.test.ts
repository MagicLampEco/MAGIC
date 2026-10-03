// tests/sponsorValidity.test.ts — cửa sổ hiệu lực của giao dịch app-sponsor.
//
// `buildSponsorTx` NÉM PM-000 trước khi tới bước dựng validity (D16), nên không bài
// nào chạm được validity qua hàm đó. Bài này kiểm hàm thuần `sponsorValidityWindow`
// mà `buildSponsorTx` gọi, và kiểm nó bằng HAI trọng tài đặt nối tiếp nhau:
//
//  1. SỔ CÁI — quy hai cận về slot đúng cách Lucid làm (`unixTimeToSlot`, làm tròn
//     XUỐNG), rồi đòi `invalid_before ≤ slot(tip) < ttl`. Khoảng `[s, s)` là rỗng.
//  2. VALIDATOR — đọc lại hai cận bằng `slotToUnixTime` (thứ script thật nhìn thấy),
//     chạy bản gương của `Paymaster/onchain/lib/magiclamp/paymaster/util.ak ▸ get_epoch`:
//     `hi ≥ lo`, `hi − lo ≤ P`, `⌊(lo−O)/P⌋ == ⌊(hi−O)/P⌋`, và epoch đó == epoch builder ghi
//     vào meter. Cận trên đúng bằng `O+(k+1)P` bị đếm sang kỳ k+1 ⟹ phải ≤ `O+(k+1)P−1`.
//
// Kiểm trên số ms THÔ (không qua slot) là bài xanh ở cả hai cực: `[start, start+1]`
// thoả `hi ≥ lo` và cùng kỳ — lỗi chỉ lộ ra sau khi làm tròn slot.

import { describe, it, expect } from "vitest";
import { unixTimeToSlot, slotToUnixTime } from "@lucid-evolution/lucid";
import {
  epochStartMs, msPerEpoch, windowOriginMs, posixMsToEpoch,
  EmptyValidityWindowError, VALIDITY_MAX_AHEAD_MS, type Network,
} from "@magiclamp/protocol-utils";
import { sponsorValidityWindow } from "../offchain/src/paymaster.js";

type SlotNet = "Preprod" | "Mainnet";

/** Gương `util.ak ▸ get_epoch`. Trả epoch, hoặc ném đúng chỗ validator `expect` hỏng. */
function validatorGetEpoch(lo: bigint, hi: bigint, network: Network): bigint {
  const P = msPerEpoch(network);
  const O = windowOriginMs(network);
  if (!(hi >= lo)) throw new Error(`get_epoch: hi ${hi} < lo ${lo}`);
  if (!(hi - lo <= P)) throw new Error(`get_epoch: hi−lo ${hi - lo} > P`);
  // lo, hi ≥ O ở mọi ca dưới đây ⟹ BigInt `/` trùng phép chia sàn của Aiken.
  const loE = (lo - O) / P;
  const hiE = (hi - O) / P;
  if (loE !== hiE) throw new Error(`get_epoch: lo_epoch ${loE} ≠ hi_epoch ${hiE}`);
  return hiE;
}

/** Đặt hai trọng tài lên cửa sổ builder trả về, cho `tip`. */
function judge(tip: bigint, network: SlotNet) {
  const w = sponsorValidityWindow(tip, network);
  const tipSlot = unixTimeToSlot(network, Number(tip));
  const loSlot = unixTimeToSlot(network, Number(w.lowerMs));
  const hiSlot = unixTimeToSlot(network, Number(w.upperMs));
  const lo = BigInt(slotToUnixTime(network, loSlot));
  const hi = BigInt(slotToUnixTime(network, hiSlot));
  return { w, tipSlot, loSlot, hiSlot, lo, hi };
}

function expectAccepted(tip: bigint, network: SlotNet) {
  const j = judge(tip, network);
  const k = posixMsToEpoch(tip, network);
  const nextStart = epochStartMs(k + 1n, network);
  // (1) sổ cái: khoảng KHÔNG rỗng và chứa slot của tip.
  expect(j.loSlot, "invalid_before ≤ slot(tip)").toBeLessThanOrEqual(j.tipSlot);
  expect(j.tipSlot, "slot(tip) < ttl — cận trên không được ở quá khứ").toBeLessThan(j.hiSlot);
  // (2) validator: cùng kỳ, đúng kỳ của tip, và kỳ builder ghi vào meter khớp.
  const e = validatorGetEpoch(j.lo, j.hi, network);
  expect(e).toBe(k);
  expect(j.w.currentEpoch).toBe(e);
  expect(j.hi, "cận trên ≤ O+(k+1)P−1 (biên O+(k+1)P là kỳ kế)").toBeLessThanOrEqual(nextStart - 1n);
  return j;
}

const NET: SlotNet = "Preprod";
// Epoch giao thức Preprod của 2026-10 (gốc O Preprod, P = 5 ngày): ⌊(1_790_942_400_000 − O)/P⌋.
const K = posixMsToEpoch(1_790_942_400_000n, NET);
const START = epochStartMs(K, NET);
const NEXT = epochStartMs(K + 1n, NET);
const P = msPerEpoch(NET);

describe("sponsorValidityWindow — sổ cái nhận + validator cùng kỳ", () => {
  it("tip GIỮA kỳ (lệch ms lẻ): cận trên không ở quá khứ, khoảng không rỗng", () => {
    expectAccepted(START + P / 2n + 437n, NET);
  });

  it("cực đối — tip ĐÚNG đầu kỳ: khoảng vẫn không rỗng sau làm tròn slot", () => {
    expectAccepted(START, NET);
  });

  it("tip trong slot ĐẦU kỳ nhưng lệch 999 ms: cận dưới làm tròn về đúng đầu kỳ, vẫn kỳ k", () => {
    const j = expectAccepted(START + 999n, NET);
    expect(j.lo).toBe(START);
  });

  it("cực đối — tip sát CUỐI kỳ (còn 5 slot): cửa sổ CO lại, không vắt sang kỳ kế", () => {
    const tip = NEXT - 5_000n;
    const j = expectAccepted(tip, NET);
    expect(j.hi).toBe(NEXT - 1_000n);
    expect(j.hi - tip).toBeLessThan(VALIDITY_MAX_AHEAD_MS);
  });

  it("tip ở slot CUỐI kỳ: NÉM EmptyValidityWindowError, chỉ đúng mốc đầu kỳ kế", () => {
    // So theo `name`, KHÔNG `instanceof`: dưới vitest, gói protocol-utils bị nạp HAI bản
    // (một bản cho `../offchain/src`, một bản cho tệp kiểm này), nên lớp lỗi ném ra từ
    // builder không `instanceof` lớp import ở đây dù cùng tệp nguồn (đo 2026-10-03).
    for (const tip of [NEXT - 1_000n, NEXT - 1n]) {
      let err: unknown;
      try { sponsorValidityWindow(tip, NET); } catch (e) { err = e; }
      expect((err as Error | undefined)?.name).toBe("EmptyValidityWindowError");
      expect((err as EmptyValidityWindowError).retryAfterMs).toBe(NEXT);
      expect((err as EmptyValidityWindowError).waitMs).toBe(NEXT - tip);
    }
  });

  it("Mainnet giữa kỳ: cùng hai trọng tài", () => {
    const s = epochStartMs(posixMsToEpoch(1_790_942_400_000n, "Mainnet"), "Mainnet");
    expectAccepted(s + 123_456_789n, "Mainnet");
  });

  it("Preview: NÉM WIN-PREVIEW (không có gốc O), không đoán", () => {
    expect(() => sponsorValidityWindow(1_700_000_000_000n, "Preview")).toThrow(/WIN-PREVIEW/);
  });
});
