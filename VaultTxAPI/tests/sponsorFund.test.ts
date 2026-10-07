// VaultTxAPI/tests/sponsorFund.test.ts — mỗi DID một quỹ tài trợ (`sponsorFund.ts`): phân loại tập quỹ
// đã ghim, tìm quỹ của DID cho fund-vault, bảng tình trạng `GET /sponsor/funds`. Hàm thuần, không chuỗi.
//
// Mỗi ca chặn có CẶP: cùng tập quỹ, khác đúng một thứ (DID, `fund_id`, sponsorship) ⟹ đi qua. Ca
// "quỹ DID khác bị bỏ qua" là bài canh của phép so `owner_commit` — gỡ phép so đó thì nó đỏ vì HÀNH VI
// (dịch vụ chọn quỹ của DID khác), không vì một chuỗi biến mất.

import { Constr, credentialToAddress, Data, type UTxO } from "@lucid-evolution/lucid";
import { encodeFundDatum, plutusDataFromCbor, plutusDataToCbor, type PaidFundDatum } from "@magiclamp/prepaidgen-sdk";
import { describe, expect, it } from "vitest";

import { CodedApiError } from "../src/errors.js";
import {
  assertDidNotFundedElsewhere, canonicalDatumCbor, claimRefusal, classifySponsorFunds, fundsBlockingOpen, resolveSponsorFund,
  SPONSOR_RECLAIM_EPOCH_SLACK, sponsorFundsStatusBody, type SponsorFundEntry,
} from "../src/sponsorFund.js";

const NET = "Preprod" as const;
const FUND_HASH = "c2".repeat(28);
const VAULT_HASH = "c1".repeat(28);
const FUND_ADDR = credentialToAddress(NET, { type: "Script", hash: FUND_HASH });
const CARP_UNIT = "22".repeat(28) + "5a".repeat(28);
const SPONSOR_PKH = "5b".repeat(28);
const SPONSOR_ADDR = credentialToAddress(NET, { type: "Key", hash: SPONSOR_PKH });
const STRANGER_PKH = "6c".repeat(28);
const DID_A = "d1".repeat(32);
const DID_B = "d2".repeat(32);

const keyAddr = (pkh: string) => ({ payment_credential: { VerificationKey: [pkh] as [string] }, stake_credential: null });

const PLATFORM = "11".repeat(28);
const ROGUE_PLATFORM = "99".repeat(28);
/** Đích nhận CARP ghim ở cấu hình (vai `fee_inbox`) và đích của kẻ giữ khoá platform. */
const BEN_PKH = "33".repeat(28);
const BEN_ADDR = credentialToAddress(NET, { type: "Key", hash: BEN_PKH });
const ROGUE_BEN_PKH = "44".repeat(28);
/** `InboxDatum { refund }` = Constr0[Constr0[key28]] — hình dạng datum đích của `fee_inbox`, dạng CBOR (bản lucid của gói này). */
const inboxCbor = (refundPkh: string): string => Data.to(new Constr(0, [new Constr(0, [refundPkh])]));
/** Cùng datum, dựng bằng codec của PrepaidGen SDK — datum đọc từ quỹ luôn là `Constr` của bản lucid bên SDK. */
const inboxDatum = (refundPkh: string): Data => plutusDataFromCbor(inboxCbor(refundPkh));
const REFUND_PKH = "7a".repeat(28);

function fundDatum(
  fundId: string,
  o: {
    did?: string; sponsorPkh?: string; none?: boolean; credit?: bigint; platform?: string;
    benPkh?: string; benDatum?: Data | null; bufferBps?: bigint; reclaimAfter?: bigint; reclaimed?: bigint;
  } = {},
): PaidFundDatum {
  return {
    fund_id: fundId,
    platform: o.platform ?? PLATFORM,
    vault_hash: VAULT_HASH,
    carp_locked: o.credit ?? 0n,
    credit_issued: o.credit ?? 0n,
    magic_settled: 0n,
    provider_claimed: 0n,
    buffer_bps: o.bufferBps ?? 1_500n,
    last_updated_epoch: 0n,
    beneficiary: keyAddr(o.benPkh ?? BEN_PKH),
    beneficiary_datum: o.benDatum ?? null,
    sponsorship: o.none === true ? null : {
      sponsor: keyAddr(o.sponsorPkh ?? SPONSOR_PKH), owner_commit: o.did ?? DID_A, reclaim_after_epoch: o.reclaimAfter ?? 530n,
    },
    sponsor_reclaimed: o.reclaimed ?? 0n,
  };
}

let ix = 0;
function fundUtxo(fundId: string, d: PaidFundDatum, carp = 0n): UTxO {
  return {
    txHash: "ee".repeat(32), outputIndex: ix++, address: FUND_ADDR,
    assets: { lovelace: 3_000_000n, [FUND_HASH + fundId]: 1n, ...(carp > 0n ? { [CARP_UNIT]: carp } : {}) },
    datum: encodeFundDatum(d),
  } as UTxO;
}

/** Tập quỹ ghim `[fundId, datum]` → các dòng đã phân loại, đúng đường mà dịch vụ dùng. */
function classify(
  funds: Array<[string, PaidFundDatum | null]>, platformPkhs?: string[],
  beneficiary?: { address: string; datumCbor?: string },
  pins: { bufferBps?: bigint; currentEpoch?: bigint } = {},
): SponsorFundEntry[] {
  const units = funds.map(([id]) => FUND_HASH + id);
  const map = new Map<string, UTxO[]>(funds.map(([id, d]) => [FUND_HASH + id, d === null ? [] : [fundUtxo(id, d)]]));
  return classifySponsorFunds({
    units, fundScriptHash: FUND_HASH, fundAddress: FUND_ADDR, vaultScriptHash: VAULT_HASH,
    sponsorAddresses: [SPONSOR_ADDR], network: NET, utxosOfUnit: map,
    ...(platformPkhs === undefined ? {} : { platformPkhs }),
    ...(beneficiary === undefined ? {} : { beneficiary }),
    // Mặc định khớp `fundDatum`: đệm 1500, mốc thu hồi 530 = 330 + 200 (cách trần 531 đúng một biên).
    bufferBps: pins.bufferBps ?? 1_500n,
    reclaimHorizon: { currentEpoch: pins.currentEpoch ?? 330n, delayEpochs: 200n },
  });
}

/** Mã lỗi có kiểu của một lời gọi NÉM; không ném ⟹ bài đỏ. */
function codeOf(f: () => unknown): { status: number; code: string; details: Record<string, unknown> } {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(CodedApiError);
    const c = e as CodedApiError;
    return { status: c.httpStatus, code: c.code, details: c.details };
  }
  throw new Error("không ném");
}

describe("classifySponsorFunds — chỉ quỹ tài trợ của bên tài trợ đã ghim là dùng được", () => {
  it("Some + sponsor đã ghim ⟹ dùng được, mang owner_commit; None ⟹ not_sponsored; sponsor lạ ⟹ foreign_sponsor; vắng ⟹ missing", () => {
    const e = classify([
      ["a0", fundDatum("a0")],
      ["a1", fundDatum("a1", { none: true })],
      ["a2", fundDatum("a2", { sponsorPkh: STRANGER_PKH })],
      ["a3", null],
    ]);
    expect(e.map(x => x.problem ?? null)).toEqual([null, "not_sponsored", "foreign_sponsor", "missing"]);
    expect(e[0]!.ownerCommit).toBe(DID_A);
    expect(e[0]!.sponsorAddress).toBe(SPONSOR_ADDR);
  });

  it("datum trỏ két khác ⟹ wrong_vault; fund_id trong datum ≠ tên NFT ⟹ undecodable", () => {
    const e = classify([["b0", { ...fundDatum("b0"), vault_hash: "c9".repeat(28) }], ["b1", fundDatum("ff")]]);
    expect(e.map(x => x.problem)).toEqual(["wrong_vault", "undecodable"]);
  });
});

describe("ghim platform_pkhs — quỹ do khoá platform lạ đúc không được nhận", () => {
  // Kẻ gọi đúc quỹ bằng khoá platform CỦA MÌNH, ghi đúng ví bên tài trợ + đúng DID nạn nhân: mọi vế
  // khác của phép phân loại đều khớp, chỉ platform là lạ. Đột biến gỡ lọc platform ⟹ bài này đỏ vì
  // dịch vụ chọn quỹ đó (did_lookup), không vì một chuỗi biến mất.
  it("CỰC ĐỐI: quỹ platform lạ, đúng ví bên tài trợ + đúng DID ⟹ foreign_platform; DID chỉ có quỹ đó ⟹ 409 NOT_OPENED", () => {
    const e = classify([["e0", fundDatum("e0", { platform: ROGUE_PLATFORM })]], [PLATFORM]);
    expect(e.map(x => x.problem)).toEqual(["foreign_platform"]);
    const c = codeOf(() => resolveSponsorFund(e, DID_A));
    expect([c.status, c.code]).toEqual([409, "SPONSOR_FUND_NOT_OPENED"]);
    // Gọi đích danh quỹ đó cũng bị chặn, kèm lý do.
    const d = codeOf(() => resolveSponsorFund(e, DID_A, "e0"));
    expect([d.status, d.code, d.details.problem]).toEqual([422, "SPONSOR_FUND_NOT_ALLOWED", "foreign_platform"]);
  });

  it("CẶP: quỹ của platform đã ghim (cùng DID, cùng ví bên tài trợ) ⟹ được nhận; có cả quỹ platform lạ cạnh bên thì vẫn chọn đúng quỹ ghim", () => {
    const e = classify([
      ["e0", fundDatum("e0", { platform: ROGUE_PLATFORM })],
      ["e1", fundDatum("e1")],
    ], [PLATFORM]);
    expect(e.map(x => x.problem ?? null)).toEqual(["foreign_platform", null]);
    const r = resolveSponsorFund(e, DID_A);
    expect([r.entry.fundId, r.selection]).toEqual(["e1", "did_lookup"]);
  });

  it("vắng platform_pkhs ⟹ không lọc theo platform (đường tập ghim fund_units giữ nguyên hành vi cũ)", () => {
    const e = classify([["e0", fundDatum("e0", { platform: ROGUE_PLATFORM })]]);
    expect(e[0]!.problem).toBeUndefined();
  });
});

describe("ghim beneficiary — quỹ do khoá platform ĐÃ GHIM đúc mà trả CARP đi nơi khác không được nhận", () => {
  // Kẻ giữ khoá platform (khoá lộ) đúc quỹ: đúng platform, đúng ví bên tài trợ, đúng DID nạn nhân — chỉ đích
  // nhận CARP là của kẻ đó. Mọi vế khác của phép phân loại đều khớp. Đột biến gỡ phép so địa chỉ ⟹ bài cực đối
  // đỏ vì dịch vụ CHỌN quỹ đó (did_lookup), không vì một chuỗi biến mất.
  const PIN = { address: BEN_ADDR };

  it("CỰC ĐỐI: platform đã ghim + đúng ví bên tài trợ + đúng DID, beneficiary khác địa chỉ ⟹ foreign_beneficiary; DID chỉ có quỹ đó ⟹ 409 NOT_OPENED", () => {
    const e = classify([["b0", fundDatum("b0", { benPkh: ROGUE_BEN_PKH })]], [PLATFORM], PIN);
    expect(e.map(x => x.problem)).toEqual(["foreign_beneficiary"]);
    // Dòng lệch vẫn mang DID + ví bên tài trợ — người vận hành biết quỹ nào đang hút CARP của ai.
    expect([e[0]!.ownerCommit, e[0]!.sponsorAddress]).toEqual([DID_A, SPONSOR_ADDR]);
    const c = codeOf(() => resolveSponsorFund(e, DID_A));
    expect([c.status, c.code]).toEqual([409, "SPONSOR_FUND_NOT_OPENED"]);
    const d = codeOf(() => resolveSponsorFund(e, DID_A, "b0"));
    expect([d.status, d.code, d.details.problem]).toEqual([422, "SPONSOR_FUND_NOT_ALLOWED", "foreign_beneficiary"]);
  });

  it("CẶP: cùng tập, beneficiary đúng địa chỉ ghim ⟹ dùng được; quỹ lệch đứng cạnh thì vẫn chọn đúng quỹ ghim", () => {
    const e = classify([
      ["b0", fundDatum("b0", { benPkh: ROGUE_BEN_PKH })],
      ["b1", fundDatum("b1")],
    ], [PLATFORM], PIN);
    expect(e.map(x => x.problem ?? null)).toEqual(["foreign_beneficiary", null]);
    const r = resolveSponsorFund(e, DID_A);
    expect([r.entry.fundId, r.selection]).toEqual(["b1", "did_lookup"]);
  });

  it("CỰC ĐỐI: cùng địa chỉ, datum khác (refund lạ) ⟹ foreign_beneficiary; CẶP: datum khớp ⟹ dùng được", () => {
    const pin = { address: BEN_ADDR, datumCbor: inboxCbor(REFUND_PKH) };
    const e = classify([
      ["c0", fundDatum("c0", { benDatum: inboxDatum(ROGUE_BEN_PKH) })],
      ["c1", fundDatum("c1", { benDatum: inboxDatum(REFUND_PKH) })],
    ], [PLATFORM], pin);
    expect(e.map(x => x.problem ?? null)).toEqual(["foreign_beneficiary", null]);
    expect(resolveSponsorFund(e, DID_A).entry.fundId).toBe("c1");
  });

  it("datum vắng ⟺ vắng: ghim có datum mà quỹ vắng ⟹ foreign_beneficiary; ghim vắng mà quỹ có ⟹ foreign_beneficiary", () => {
    const withDatum = { address: BEN_ADDR, datumCbor: inboxCbor(REFUND_PKH) };
    expect(classify([["d0", fundDatum("d0")]], [PLATFORM], withDatum)[0]!.problem).toBe("foreign_beneficiary");
    expect(classify([["d1", fundDatum("d1", { benDatum: inboxDatum(REFUND_PKH) })]], [PLATFORM], PIN)[0]!.problem)
      .toBe("foreign_beneficiary");
    // CẶP của cả hai: cùng vắng, cùng có.
    expect(classify([["d2", fundDatum("d2")]], [PLATFORM], PIN)[0]!.problem).toBeUndefined();
    expect(classify([["d3", fundDatum("d3", { benDatum: inboxDatum(REFUND_PKH) })]], [PLATFORM], withDatum)[0]!.problem)
      .toBeUndefined();
  });

  it("chuẩn hoá: ghim viết CBOR mảng ĐỊNH-ĐỘ-DÀI (khác cách Lucid viết) cho cùng giá trị ⟹ vẫn khớp", () => {
    // Constr0[Constr0[bytes28]] viết tay bằng mảng định-độ-dài: d879 81 d879 81 581c <28 byte>.
    const definite = `d87981d87981581c${REFUND_PKH}`;
    expect(definite).not.toBe(inboxCbor(REFUND_PKH));
    expect(canonicalDatumCbor(definite)).toBe(plutusDataToCbor(inboxDatum(REFUND_PKH)));
    const e = classify([["d4", fundDatum("d4", { benDatum: inboxDatum(REFUND_PKH) })]], [PLATFORM],
      { address: BEN_ADDR, datumCbor: definite });
    expect(e[0]!.problem).toBeUndefined();
  });

  it("vắng ghim beneficiary (đường tập đóng fund_units) ⟹ không lọc theo đích", () => {
    expect(classify([["d5", fundDatum("d5", { benPkh: ROGUE_BEN_PKH })]], [PLATFORM])[0]!.problem).toBeUndefined();
  });

  it("GET /sponsor/funds: quỹ lệch đích hiện ra với problem foreign_beneficiary, tính vào unusable, không cộng tổng", () => {
    const e = classify([["d6", fundDatum("d6", { benPkh: ROGUE_BEN_PKH, credit: 5n })], ["d7", fundDatum("d7", { credit: 2n })]],
      [PLATFORM], PIN);
    const body = sponsorFundsStatusBody({ entries: e, carpUnit: CARP_UNIT, busyOf: () => null, wallets: [], maxCarpAmount: 1n, nowMs: 0 });
    expect([body.usable, body.unusable]).toEqual([1, 1]);
    expect((body.funds as Array<Record<string, unknown>>)[0]).toMatchObject({ fund_id: "d6", problem: "foreign_beneficiary", owner_commit: DID_A });
    expect((body.totals as Record<string, unknown>).credit_issued).toBe("2");
  });
});

describe("resolveSponsorFund — mỗi DID một quỹ", () => {
  it("XANH: tìm đúng quỹ của DID giữa quỹ DID khác và quỹ chung; selection = did_lookup", () => {
    const e = classify([["c0", fundDatum("c0", { did: DID_B })], ["c1", fundDatum("c1", { none: true })], ["c2", fundDatum("c2")]]);
    const r = resolveSponsorFund(e, DID_A);
    expect(r.entry.fundId).toBe("c2");
    expect(r.selection).toBe("did_lookup");
    // CẶP: cùng tập, DID B ⟹ quỹ c0.
    expect(resolveSponsorFund(e, DID_B).entry.fundId).toBe("c0");
  });

  it("CỰC ĐỐI: tập ghim chỉ có quỹ của DID KHÁC ⟹ 409 SPONSOR_FUND_NOT_OPENED, không chọn quỹ đó", () => {
    const e = classify([["d0", fundDatum("d0", { did: DID_B })]]);
    const c = codeOf(() => resolveSponsorFund(e, DID_A));
    expect([c.status, c.code]).toEqual([409, "SPONSOR_FUND_NOT_OPENED"]);
    expect(c.details.did_commit).toBe(DID_A);
  });

  it("CỰC ĐỐI: chỉ có quỹ chung (sponsorship = None) ⟹ 409 SPONSOR_FUND_NOT_OPENED; gọi đích danh quỹ đó ⟹ 422 not_sponsored", () => {
    const e = classify([["e0", fundDatum("e0", { none: true })]]);
    expect(codeOf(() => resolveSponsorFund(e, DID_A)).code).toBe("SPONSOR_FUND_NOT_OPENED");
    const c = codeOf(() => resolveSponsorFund(e, DID_A, "e0"));
    expect([c.status, c.code, c.details.problem]).toEqual([422, "SPONSOR_FUND_NOT_ALLOWED", "not_sponsored"]);
  });

  it("CỰC ĐỐI: quỹ của DID mà bên tài trợ ghi là ví lạ ⟹ không chọn (NOT_OPENED)", () => {
    const e = classify([["e1", fundDatum("e1", { sponsorPkh: STRANGER_PKH })]]);
    expect(codeOf(() => resolveSponsorFund(e, DID_A)).code).toBe("SPONSOR_FUND_NOT_OPENED");
  });

  it("hai quỹ cho cùng DID ⟹ 409 SPONSOR_FUND_AMBIGUOUS kèm cả hai fund_id; CẶP: gọi đích danh một quỹ ⟹ caller", () => {
    const e = classify([["f0", fundDatum("f0")], ["f1", fundDatum("f1")]]);
    const c = codeOf(() => resolveSponsorFund(e, DID_A));
    expect([c.status, c.code]).toEqual([409, "SPONSOR_FUND_AMBIGUOUS"]);
    expect(c.details.fund_ids).toEqual(["f0", "f1"]);
    const r = resolveSponsorFund(e, DID_A, "f1");
    expect([r.entry.fundId, r.selection]).toEqual(["f1", "caller"]);
  });

  it("CỰC ĐỐI: fund_id là quỹ của DID khác ⟹ 422 SPONSOR_FUND_DID_MISMATCH; CẶP: fund_id của chính DID ⟹ qua", () => {
    const e = classify([["3a", fundDatum("3a", { did: DID_B })], ["3b", fundDatum("3b")]]);
    const c = codeOf(() => resolveSponsorFund(e, DID_A, "3a"));
    expect([c.status, c.code, c.details.owner_commit]).toEqual([422, "SPONSOR_FUND_DID_MISMATCH", DID_B]);
    expect(resolveSponsorFund(e, DID_A, "3b").entry.fundId).toBe("3b");
  });

  it("fund_id ngoài tập ghim ⟹ 422 SPONSOR_FUND_NOT_ALLOWED", () => {
    const e = classify([["4a", fundDatum("4a")]]);
    expect(codeOf(() => resolveSponsorFund(e, DID_A, "h9")).code).toBe("SPONSOR_FUND_NOT_ALLOWED");
  });
});

describe("sponsorFundsStatusBody — bảng GET /sponsor/funds", () => {
  it("mỗi quỹ: owner_commit, reclaim_after_epoch, kế toán, busy; tổng chỉ trên quỹ dùng được; CARP ví bên tài trợ", () => {
    const e = classify([["5c", fundDatum("5c", { credit: 7n })], ["5d", fundDatum("5d", { none: true, credit: 100n })]]);
    const body = sponsorFundsStatusBody({
      entries: e, carpUnit: CARP_UNIT, busyOf: x => (x.fundId === "5c" ? "in_flight" : null),
      wallets: [{ address: SPONSOR_ADDR, utxos: [{ assets: { lovelace: 2n, [CARP_UNIT]: 40n } } as unknown as UTxO] }],
      maxCarpAmount: 9n, nowMs: 0,
    });
    expect([body.pinned_funds, body.usable, body.unusable, body.busy]).toEqual([2, 1, 1, 1]);
    const funds = body.funds as Array<Record<string, unknown>>;
    expect(funds[0]).toMatchObject({ fund_id: "5c", owner_commit: DID_A, reclaim_after_epoch: "530", busy: true, problem: null });
    expect((funds[0]!.accounting as Record<string, unknown>).credit_issued).toBe("7");
    expect(funds[1]).toMatchObject({ fund_id: "5d", owner_commit: null, problem: "not_sponsored", reclaim_after_epoch: null });
    // Quỹ chung KHÔNG cộng vào tổng: 7, không phải 107.
    expect((body.totals as Record<string, unknown>).credit_issued).toBe("7");
    expect(body.sponsor_carp_total).toBe("40");
    expect(body.max_carp_amount).toBe("9");
  });
});

// ── #161-3 / #161-4 / red-team 4: quỹ đã thu hồi, ghim đệm + mốc thu hồi, nạp lần hai cho cùng DID ─────────────

describe("classifySponsorFunds — ghim đệm, trần mốc thu hồi, quỹ đã thu hồi", () => {
  it("đệm = cấu hình ⟹ dùng được; CỰC ĐỐI: cùng quỹ, cấu hình đệm khác ⟹ buffer_mismatch (vẫn mang owner_commit)", () => {
    expect(classify([["c0", fundDatum("c0")]])[0]!.problem).toBeUndefined();
    const e = classify([["c0", fundDatum("c0")]], undefined, undefined, { bufferBps: 1_000n })[0]!;
    expect(e.problem).toBe("buffer_mismatch");
    expect(e.ownerCommit).toBe(DID_A);
  });

  it("mốc thu hồi = epoch + delay + biên ⟹ dùng được; CỰC ĐỐI: thêm 1 epoch ⟹ reclaim_too_far", () => {
    const edge = 330n + 200n + SPONSOR_RECLAIM_EPOCH_SLACK;
    expect(classify([["c1", fundDatum("c1", { reclaimAfter: edge })]])[0]!.problem).toBeUndefined();
    expect(classify([["c1", fundDatum("c1", { reclaimAfter: edge + 1n })]])[0]!.problem).toBe("reclaim_too_far");
    // Epoch hiện tại tăng ⟹ trần nới: cùng quỹ đọc ở epoch sau thì dùng được (không phải trần tuyệt đối).
    expect(classify([["c1", fundDatum("c1", { reclaimAfter: edge + 1n })]], undefined, undefined, { currentEpoch: 331n })[0]!.problem)
      .toBeUndefined();
  });

  it("sponsor_reclaimed = 0 ⟹ dùng được; CỰC ĐỐI: sponsor_reclaimed > 0 ⟹ reclaimed, fund-vault theo DID ⟹ 409 NOT_OPENED", () => {
    expect(classify([["c2", fundDatum("c2", { credit: 9n })]])[0]!.problem).toBeUndefined();
    const e = classify([["c2", fundDatum("c2", { credit: 9n, reclaimed: 9n })]]);
    expect(e[0]!.problem).toBe("reclaimed");
    expect(codeOf(() => resolveSponsorFund(e, DID_A)).code).toBe("SPONSOR_FUND_NOT_OPENED");
    expect(codeOf(() => resolveSponsorFund(e, DID_A, "c2"))).toMatchObject({ status: 422, code: "SPONSOR_FUND_NOT_ALLOWED" });
  });

  it("fundsBlockingOpen: quỹ đã thu hồi VẪN chặn open-fund; CỰC ĐỐI: quỹ lệch đích (foreign_beneficiary) không chặn", () => {
    const reclaimed = classify([["c3", fundDatum("c3", { credit: 9n, reclaimed: 9n })]]);
    expect(fundsBlockingOpen(reclaimed, DID_A).map(e => e.fundId)).toEqual(["c3"]);
    const rogue = classify([["c4", fundDatum("c4", { benPkh: ROGUE_BEN_PKH })]], undefined, { address: BEN_ADDR });
    expect(rogue[0]!.problem).toBe("foreign_beneficiary");
    expect(fundsBlockingOpen(rogue, DID_A)).toEqual([]);
  });
});

// ── T2 / L4 (audit @5274b8c8): nhãn LỆCH cấu hình hiện tại ≠ nhãn KHÔNG TIN ─────────────────────────────────

describe("T2 claimRefusal — claim chỉ chặn đúng thứ hàm ký kiểm (platform + đích)", () => {
  const BEN = { address: BEN_ADDR };
  const gate = { network: NET, platformPkhs: [PLATFORM], beneficiary: BEN };
  const one = (id: string, d: PaidFundDatum | null, pins: { bufferBps?: bigint } = {}) =>
    classify([[id, d]], [PLATFORM], BEN, pins)[0]!;
  const otherVault = (d: PaidFundDatum): PaidFundDatum => ({ ...d, vault_hash: "ee".repeat(28) });

  it("quỹ LỆCH cấu hình hiện tại (đệm · ví bên tài trợ · két · mốc thu hồi · đã thu hồi · quỹ chung), platform + đích đúng ⟹ cho claim", () => {
    const rows: Array<[SponsorFundEntry, string]> = [
      [one("e0", fundDatum("e0"), { bufferBps: 1_000n }), "buffer_mismatch"],
      [one("e1", fundDatum("e1", { sponsorPkh: STRANGER_PKH })), "foreign_sponsor"],
      [one("e2", otherVault(fundDatum("e2"))), "wrong_vault"],
      [one("e3", fundDatum("e3", { reclaimAfter: 999n })), "reclaim_too_far"],
      [one("e4", fundDatum("e4", { credit: 9n, reclaimed: 9n })), "reclaimed"],
      // Đã thu hồi VÀ lệch đệm: nhãn là buffer_mismatch (đứng trước) — vẫn phải claim được (lượt rút cuối đóng quỹ).
      [one("e5", fundDatum("e5", { credit: 9n, reclaimed: 9n }), { bufferBps: 1_000n }), "buffer_mismatch"],
      [one("e6", fundDatum("e6", { none: true })), "not_sponsored"],
    ];
    for (const [e, label] of rows) {
      expect(e.problem).toBe(label);
      expect(claimRefusal(e, gate)).toBeUndefined();
    }
  });

  it("CỰC ĐỐI: đích lạ / platform lạ / không có quỹ ⟹ chặn — kể cả khi nhãn phân loại che phép so đích (wrong_vault, quỹ chung, ví lạ)", () => {
    expect(claimRefusal(one("f0", fundDatum("f0", { benPkh: ROGUE_BEN_PKH })), gate)).toBe("foreign_beneficiary");
    expect(claimRefusal(one("f1", fundDatum("f1", { platform: ROGUE_PLATFORM })), gate)).toBe("foreign_platform");
    expect(claimRefusal(one("f2", null), gate)).toBe("missing");
    // Nhãn đứng TRƯỚC phép so đích: phân loại chưa so đích, claimRefusal so lại.
    const masked: Array<[SponsorFundEntry, string]> = [
      [one("f3", otherVault(fundDatum("f3", { benPkh: ROGUE_BEN_PKH }))), "wrong_vault"],
      [one("f4", fundDatum("f4", { none: true, benPkh: ROGUE_BEN_PKH })), "not_sponsored"],
      [one("f5", fundDatum("f5", { sponsorPkh: STRANGER_PKH, benPkh: ROGUE_BEN_PKH })), "foreign_sponsor"],
    ];
    for (const [e, label] of masked) {
      expect(e.problem).toBe(label);
      expect(claimRefusal(e, gate)).toBe("foreign_beneficiary");
    }
    // Cấu hình không có beneficiary ⟹ không có đích để so ⟹ chặn (fail closed).
    expect(claimRefusal(one("f6", fundDatum("f6")), { network: NET, platformPkhs: [PLATFORM] })).toBe("foreign_beneficiary");
  });
});

describe("L4 fundsBlockingOpen — mọi quỹ của DID do platform này ký chặn genesis quỹ thứ hai", () => {
  it("quỹ lệch đệm / két khác / ví bên tài trợ khác của DID ⟹ chặn; CỰC ĐỐI: chỉ có quỹ foreign_platform ⟹ không chặn; DID khác ⟹ không chặn", () => {
    const buf = classify([["b0", fundDatum("b0")]], [PLATFORM], { address: BEN_ADDR }, { bufferBps: 1_000n });
    expect(buf[0]!.problem).toBe("buffer_mismatch");
    expect(fundsBlockingOpen(buf, DID_A).map(e => e.fundId)).toEqual(["b0"]);
    expect(fundsBlockingOpen(buf, DID_B)).toEqual([]);
    const wrongVault = classify([["b1", { ...fundDatum("b1"), vault_hash: "ee".repeat(28) }]], [PLATFORM], { address: BEN_ADDR });
    expect(wrongVault[0]!.problem).toBe("wrong_vault");
    expect(wrongVault[0]!.ownerCommit).toBe(DID_A);
    expect(fundsBlockingOpen(wrongVault, DID_A).map(e => e.fundId)).toEqual(["b1"]);
    const sponsorRotated = classify([["b2", fundDatum("b2", { sponsorPkh: STRANGER_PKH })]], [PLATFORM], { address: BEN_ADDR });
    expect(sponsorRotated[0]!.problem).toBe("foreign_sponsor");
    expect(fundsBlockingOpen(sponsorRotated, DID_A).map(e => e.fundId)).toEqual(["b2"]);
    // CỰC ĐỐI: quỹ của DID nhưng platform lạ — ai cũng đúc được ⟹ không chặn.
    const foreign = classify([["b3", fundDatum("b3", { platform: ROGUE_PLATFORM })]], [PLATFORM], { address: BEN_ADDR });
    expect(foreign[0]!.problem).toBe("foreign_platform");
    expect(fundsBlockingOpen(foreign, DID_A)).toEqual([]);
  });
});

describe("assertDidNotFundedElsewhere — mỗi DID một lần tài trợ (red-team 4)", () => {
  it("quỹ khác của CÙNG DID có credit_issued > 0 ⟹ 409 SPONSOR_DID_FUNDED_ELSEWHERE", () => {
    const e = classify([["d0", fundDatum("d0")], ["d1", fundDatum("d1", { credit: 5n })]]);
    expect(codeOf(() => assertDidNotFundedElsewhere(e, DID_A, FUND_HASH + "d0")))
      .toMatchObject({ status: 409, code: "SPONSOR_DID_FUNDED_ELSEWHERE", details: { funded_fund_ids: ["d1"] } });
  });
  it("CỰC ĐỐI: quỹ khác cùng DID credit 0 ⟹ qua; quỹ credit > 0 của DID KHÁC ⟹ qua; chính quỹ đã chọn credit > 0 ⟹ qua", () => {
    const e = classify([["d0", fundDatum("d0", { credit: 5n })], ["d1", fundDatum("d1")], ["d2", fundDatum("d2", { did: DID_B, credit: 5n })]]);
    expect(() => assertDidNotFundedElsewhere(e, DID_A, FUND_HASH + "d0")).not.toThrow();
  });
  it("quỹ đã thu hồi của cùng DID (credit > 0) ⟹ 409; CỰC ĐỐI: quỹ platform lạ cùng DID credit > 0 ⟹ không chặn", () => {
    const e = classify([["d0", fundDatum("d0")], ["d3", fundDatum("d3", { credit: 5n, reclaimed: 5n })]]);
    expect(codeOf(() => assertDidNotFundedElsewhere(e, DID_A, FUND_HASH + "d0")).code).toBe("SPONSOR_DID_FUNDED_ELSEWHERE");
    const f = classify([["d0", fundDatum("d0")], ["d4", fundDatum("d4", { credit: 5n, platform: ROGUE_PLATFORM })]], [PLATFORM]);
    expect(f[1]!.problem).toBe("foreign_platform");
    expect(() => assertDidNotFundedElsewhere(f, DID_A, FUND_HASH + "d0")).not.toThrow();
  });
});
