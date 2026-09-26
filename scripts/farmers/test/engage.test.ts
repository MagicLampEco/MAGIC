import { Constr, Data } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";

import { interpretEngageMint, pickEngageThread } from "../src/engage.ts";

const PKH = "ab".repeat(28);
const OTHER = "12".repeat(28);
const CH = "c0".repeat(28);
const UNIT = CH + "01".repeat(32);
const UNIT2 = CH + "02".repeat(32);
const TX = "cd".repeat(32);
const TX2 = "11".repeat(32);
const datum = (owner: Data) => Data.to(new Constr(0, [owner, 0n, 0n, "", 0n]));
const keyCred = (pkh: string) => new Constr(0, [pkh]);
const u = (tx: string, unit: string, d: string | undefined) => ({ txHash: tx, outputIndex: 0, address: "addr", assets: { lovelace: 2_000_000n, [unit]: 1n }, datum: d });
const r = (stdout: string, status = 0) => ({ status, stdout, stderr: "", timedOut: false });

describe("tra thread Engage của nông dân", () => {
  it("trường 0 của datum mã hoá đúng d8799f581c<pkh>ff", () => {
    expect(Data.to(keyCred(PKH))).toBe(`d8799f581c${PKH}ff`);
    expect(datum(keyCred(PKH)).startsWith(`d8799fd8799f581c${PKH}ff`)).toBe(true);
  });
  it("đúng một thread của pkh ⟹ outref; thread người khác bị bỏ qua", () => {
    const got = pickEngageThread([u(TX, UNIT, datum(keyCred(PKH))), u(TX2, UNIT2, datum(keyCred(OTHER)))], PKH, CH, null);
    expect(got).toMatchObject({ ok: true, outRef: `${TX}#0`, unit: UNIT });
  });
  it("0 ứng viên ⟹ prereq-missing; owner dạng ByteArray cũ KHÔNG được nhận; không datum ⟹ không nhận", () => {
    expect(pickEngageThread([], PKH, CH, null)).toMatchObject({ ok: false, outcome: { kind: "prereq-missing" } });
    expect(pickEngageThread([u(TX, UNIT, datum(PKH))], PKH, CH, null)).toMatchObject({ ok: false, outcome: { kind: "prereq-missing" } });
    expect(pickEngageThread([u(TX, UNIT, undefined)], PKH, CH, null)).toMatchObject({ ok: false, outcome: { kind: "prereq-missing" } });
  });
  it(">1 ứng viên ⟹ error engage-thread-ambiguous; unit đã biết thì lọc theo unit; unit đó chủ khác ⟹ error", () => {
    const two = [u(TX, UNIT, datum(keyCred(PKH))), u(TX2, UNIT2, datum(keyCred(PKH)))];
    expect(pickEngageThread(two, PKH, CH, null)).toMatchObject({ ok: false, outcome: { kind: "error", reason: "engage-thread-ambiguous" } });
    expect(pickEngageThread(two, PKH, CH, UNIT)).toMatchObject({ ok: true, unit: UNIT });
    expect(pickEngageThread([u(TX, UNIT, datum(keyCred(OTHER)))], PKH, CH, UNIT)).toMatchObject({ ok: false, outcome: { kind: "error", reason: "engage-thread-owner-mismatch" } });
  });
  it("interpretEngageMint: dry ⟹ engage_nft; live ⟹ + engage_outref; thiếu dòng / sai loại / chủ khác ⟹ error", () => {
    const head = `owner pkh:     ${PKH}\nthread unit:   ${UNIT}\n\n`;
    expect(interpretEngageMint(r(`${head}✔ DRY RUN: tx dựng xong và qua validator khi chạy thử.`), "dry", PKH, "instant"))
      .toMatchObject({ kind: "built", artifacts: { engage_nft: UNIT } });
    const live = `${head}Đã gửi: ${TX}\nexport ENGAGE_NFT_UNIT_INSTANT=${UNIT}\nexport ENGAGE_UTXO_INSTANT=${TX}#0\n`;
    expect(interpretEngageMint(r(live), "live", PKH, "instant")).toMatchObject({ kind: "confirmed", artifacts: { engage_nft: UNIT, engage_outref: `${TX}#0` } });
    expect(interpretEngageMint(r(live), "live", PKH, "schedule")).toMatchObject({ kind: "error", reason: "child-result-malformed" });
    expect(interpretEngageMint(r(`thread unit:   ${UNIT}\n✔ DRY RUN: tx dựng xong`), "dry", PKH, "instant")).toMatchObject({ kind: "error", reason: "child-result-malformed" });
    expect(interpretEngageMint(r(`${head}✔ DRY RUN: tx dựng xong`), "dry", OTHER, "instant")).toMatchObject({ kind: "error", reason: "child-owner-mismatch" });
  });
});
