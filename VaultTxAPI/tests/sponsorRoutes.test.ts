// VaultTxAPI/tests/sponsorRoutes.test.ts — tầng route + cổng cấu hình của hành trình tài trợ
// (`sponsor.ts`), KHÔNG dựng tx. Bài dựng thật qua SDK nằm ở `sponsorEmulator.test.ts`.
//
// Mỗi cổng có CẶP: ca bị chặn + ca khác đúng một khoá đi qua được cổng đó (chết ở cổng SAU, với
// mã KHÁC). Ca "đi qua" không đòi dựng được tx — nó đòi cổng đang xét không chặn nhầm.
//
// Bộ dựng Lucid ở đây NÉM nếu bị gọi: mọi ca 501 phải chết TRƯỚC khi chạm bộ dựng.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { credentialToAddress } from "@lucid-evolution/lucid";
import type { PrepaidBlueprint } from "@magiclamp/prepaidgen-sdk";
import { OwnerAuthError } from "@magiclamp/protocol-utils";
import { SponsorJourneyError, type SponsorJourneyErrorCode } from "@magiclamp/sdk";
import { describe, expect, it } from "vitest";

import { RecordedChainReader, type ChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment, PREPAID_VAULT_TYPE } from "../src/config.js";
import { CodedApiError, TxApiError, TxBuildRejectedError } from "../src/errors.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import type { VaultTxService } from "../src/service.js";
import {
  SPONSOR_ERROR_STATUS, SponsorTxService, asSponsorApiError, sponsorApiErrorOf, type SponsorTxServiceDeps,
} from "../src/sponsor.js";
import { vaultModuleOf } from "../src/txBuilder.js";
import { LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, OWNER_PKH } from "./fixtures/preview.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const PG_BP = here("../../PrepaidGen/onchain/plutus.json");

type Net = "Preprod" | "Preview";
const scriptAddr = (net: Net, hash: string) => credentialToAddress(net, { type: "Script", hash });
const CARP_UNIT = "22".repeat(28) + "5a".repeat(28);
const SPONSOR_PKH = "5b".repeat(28);
const TIP: ChainTip = { blockHeight: 1, blockHash: "00".repeat(32), blockTimePosixMs: 1_789_100_703_000n };

function deploymentJson(net: Net, o: { kind?: "Prepaid" | "Instant"; carp?: string | null; didStake?: boolean } = {}): string {
  const kind = o.kind ?? "Prepaid";
  const base: Record<string, unknown> = {
    source: `${net}, khối dựng thử của phép kiểm — không phải một lần deploy thật`,
    lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
    consume: {
      engage_address: scriptAddr(net, "e0".repeat(28)),
      price_beacon_address: scriptAddr(net, "77".repeat(28)),
      price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
    },
    ...(o.didStake === false ? {} : { did_stake: { anchor_nft_policy: "ad".repeat(28) } }),
  };
  if (kind === "Instant") {
    return JSON.stringify({
      ...base,
      vaults: [{ vault_type: "Instant", address: scriptAddr(net, "c1".repeat(28)) }],
      shard_address: scriptAddr(net, "c3".repeat(28)),
      ref_script_utxos: { vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2` },
    });
  }
  return JSON.stringify({
    ...base,
    vaults: [{ vault_type: PREPAID_VAULT_TYPE, address: scriptAddr(net, "c1".repeat(28)) }],
    paid_fund: {
      address: scriptAddr(net, "c2".repeat(28)),
      ...(o.carp === null ? {} : { carp_unit: o.carp ?? CARP_UNIT }),
    },
    ref_script_utxos: { vault: `${"11".repeat(32)}#0`, paid_fund: `${"12".repeat(32)}#0`, consume: `${"33".repeat(32)}#2` },
  });
}

/** Chuỗi đếm số lượt đọc: cổng cấu hình phải chết với 0 lượt. */
function countingChain(): { chain: ChainReader; reads: () => number } {
  let n = 0;
  const inner = new RecordedChainReader({}, TIP, []);
  const chain: ChainReader = {
    label: "counting",
    utxosAt: a => { n++; return inner.utxosAt(a); },
    utxosByOutRef: r => { n++; return inner.utxosByOutRef(r); },
    utxosByUnit: u => { n++; return inner.utxosByUnit(u); },
    tip: () => { n++; return inner.tip(); },
    submitTx: c => inner.submitTx(c),
    rewardAccount: a => inner.rewardAccount(a),
  };
  return { chain, reads: () => n };
}

const blueprint = (): PrepaidBlueprint => {
  if (!existsSync(PG_BP)) throw new Error(`không thấy blueprint ${PG_BP} — chạy \`aiken build PrepaidGen/onchain\``);
  return JSON.parse(readFileSync(PG_BP, "utf8")) as PrepaidBlueprint;
};

let lucidCalls = 0;
function service(net: Net, json: string, over: Partial<SponsorTxServiceDeps> = {}) {
  const { chain, reads } = countingChain();
  const svc = new SponsorTxService({
    network: net,
    deployment: parseDeployment(json, net),
    chain,
    locks: new OwnerLockTable(60_000),
    issued: new IssuedTxRegistry(240_000),
    lockTtlMs: 60_000,
    prepaidBlueprint: blueprint(),
    lucidForWallet: async () => { lucidCalls++; throw new Error("bộ dựng KHÔNG được chạm trong bài này"); },
    ...over,
  });
  return { svc, reads };
}

const logged: Array<[string, unknown]> = [];
function deps(sponsor: SponsorTxService | undefined): RouterDeps {
  return {
    service: {} as unknown as VaultTxService, // đường /tx/sponsor/* không chạm dịch vụ cũ
    deploymentSource: "phép kiểm",
    vaultScopes: [],
    network: "Preprod",
    chainLabel: "counting",
    changeAddressStrategy: "owner-enterprise",
    token: "",
    logInternal: (ref, cause) => { logged.push([ref, cause]); },
    ...(sponsor === undefined ? {} : { sponsor }),
  };
}

async function post(path: string, body: unknown, sponsor: SponsorTxService | undefined, method = "POST") {
  return handle({ method, url: path, headers: {}, body }, deps(sponsor));
}

const KEY_OWNER = { owner: { type: "key", hash: OWNER_PKH } };
const T1_BODY = { ...KEY_OWNER, did_commit: "d1".repeat(32) };
const errCode = (r: { body: Record<string, unknown> }) => (r.body.error as { code: string }).code;
const errDetails = (r: { body: Record<string, unknown> }) => (r.body.error as { details: Record<string, unknown> }).details;

describe("cổng mạng — gốc cửa sổ kỳ", () => {
  it("Preview (không có gốc O) ⟹ 501 SPONSOR_NETWORK_UNSUPPORTED, cause_code gốc, 0 lượt đọc chuỗi, 0 lượt dựng", async () => {
    const { svc, reads } = service("Preview", deploymentJson("Preview"));
    lucidCalls = 0;
    const r = await post("/tx/sponsor/t1-open", T1_BODY, svc);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("SPONSOR_NETWORK_UNSUPPORTED");
    expect(errDetails(r).cause_code).toMatch(/^WIN-/);
    expect(reads()).toBe(0);
    expect(lucidCalls).toBe(0);
  });

  it("CẶP: cùng yêu cầu trên Preprod ⟹ qua cổng mạng (chết ở cổng sau, mã KHÁC)", async () => {
    const { svc } = service("Preprod", deploymentJson("Preprod"));
    const r = await post("/tx/sponsor/t1-open", T1_BODY, svc);
    expect(errCode(r)).not.toBe("SPONSOR_NETWORK_UNSUPPORTED");
  });
});

describe("cổng khối deploy Prepaid", () => {
  it("khối Instant ⟹ 501 SPONSOR_PREPAID_UNAVAILABLE, nêu vault_types", async () => {
    const { svc, reads } = service("Preprod", deploymentJson("Preprod", { kind: "Instant" }));
    const r = await post("/tx/sponsor/t3-draw", { ...KEY_OWNER, fund_id: "f0", carp_amount: "1" }, svc);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("SPONSOR_PREPAID_UNAVAILABLE");
    expect(errDetails(r).vault_types).toEqual(["Instant"]);
    expect(reads()).toBe(0);
  });

  it("khối Prepaid thiếu paid_fund.carp_unit ⟹ 501 CONFIG_MISSING nêu đúng khoá, KHÔNG đệm", async () => {
    const { svc, reads } = service("Preprod", deploymentJson("Preprod", { carp: null }));
    const r = await post("/tx/sponsor/t1-open", T1_BODY, svc);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("CONFIG_MISSING");
    expect(errDetails(r).missing).toEqual(["paid_fund.carp_unit"]);
    expect(reads()).toBe(0);
  });

  it("CẶP: có carp_unit mà hash cấu hình KHÁC script suy từ blueprint ⟹ 501 SPONSOR_PREPAID_SCRIPTS_MISMATCH, 0 lượt dựng", async () => {
    lucidCalls = 0;
    const { svc } = service("Preprod", deploymentJson("Preprod"));
    const r = await post("/tx/sponsor/t1-open", T1_BODY, svc);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("SPONSOR_PREPAID_SCRIPTS_MISMATCH");
    const d = errDetails(r) as { configured: { vault_hash: string }; derived: { vault_hash: string } };
    expect(d.configured.vault_hash).toBe("c1".repeat(28));
    expect(d.derived.vault_hash).toMatch(/^[0-9a-f]{56}$/);
    expect(d.derived.vault_hash).not.toBe(d.configured.vault_hash);
    expect(lucidCalls).toBe(0);
    // Khoá chủ đã NHẢ: lượt thứ hai nhận lại đúng 501, không phải 409 OWNER_TX_IN_FLIGHT.
    const again = await post("/tx/sponsor/t1-open", T1_BODY, svc);
    expect(errCode(again)).toBe("SPONSOR_PREPAID_SCRIPTS_MISMATCH");
  });

  // Thứ tự trong `run`: cổng script (`prepare`) chạy TRƯỚC thân T2, nơi đòi `did_stake.anchor_nft_policy`.
  // Khối dựng thử ở đây có hash giả ⟹ cổng script thắng. Ca CONFIG_MISSING thật (script khớp, thiếu
  // did_stake) chỉ dựng được với script thật: `sponsorEmulator.test.ts` ▸ "T2 ĐỎ: … thiếu did_stake".
  it("T2 trên bản deploy thiếu did_stake, hash giả ⟹ 501 SPONSOR_PREPAID_SCRIPTS_MISMATCH (cổng script chạy trước)", async () => {
    const { svc } = service("Preprod", deploymentJson("Preprod", { didStake: false }));
    const r = await post("/tx/sponsor/t2-fund", {
      ...KEY_OWNER, fund_id: "f0", carp_amount: "5",
      sponsor: { utxo_refs: [`${"ab".repeat(32)}#0`], change_address: credentialToAddress("Preprod", { type: "Key", hash: SPONSOR_PKH }) },
    }, svc);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("SPONSOR_PREPAID_SCRIPTS_MISMATCH");
  });
});

describe("fee_payer và nhân chứng", () => {
  it("fee_payer ⟹ 501 SPONSOR_FEE_PAYER_UNSUPPORTED, trước khi đọc chuỗi", async () => {
    const { svc, reads } = service("Preprod", deploymentJson("Preprod"));
    const r = await post("/tx/sponsor/t1-open", {
      ...T1_BODY, fee_payer: { utxo: `${"fe".repeat(32)}#0`, address: credentialToAddress("Preprod", { type: "Key", hash: "fe".repeat(28) }) },
    }, svc);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("SPONSOR_FEE_PAYER_UNSUPPORTED");
    expect(reads()).toBe(0);
  });

  it("chủ script, dịch vụ không có nhân chứng ⟹ 501 OWNER_SCRIPT_WITNESS_UNAVAILABLE; chủ khoá kèm owner_witness ⟹ 400 OWNER_WITNESS_UNEXPECTED", async () => {
    const { svc } = service("Preprod", deploymentJson("Preprod"));
    const s = await post("/tx/sponsor/t1-open", { owner: { type: "script", hash: "5c".repeat(28) }, did_commit: "d1".repeat(32), change_address: credentialToAddress("Preprod", { type: "Key", hash: "fe".repeat(28) }) }, svc);
    expect(s.status).toBe(501);
    expect(errCode(s)).toBe("OWNER_SCRIPT_WITNESS_UNAVAILABLE");
    const k = await post("/tx/sponsor/t1-open", {
      ...T1_BODY,
      owner_witness: {
        did_stake_script_cbor: "00", anchor_ref: `${"aa".repeat(32)}#0`, controller_pkh: "aa".repeat(28), device_key_hash: "bb".repeat(28),
      },
    }, svc);
    expect(k.status).toBe(400);
    // Nhân chứng đúng hình dạng (`parseOwnerWitness` cho qua) ⟹ chết ở `assertWitnessShape`: chủ khoá không nhận nhân chứng.
    expect(errCode(k)).toBe("OWNER_WITNESS_UNEXPECTED");
  });

  it("chủ script không gửi change_address ⟹ 400 CHANGE_ADDRESS_REQUIRED (không suy được ví trả phí)", async () => {
    const { svc } = service("Preprod", deploymentJson("Preprod"));
    const r = await post("/tx/sponsor/t1-open", { owner: { type: "script", hash: "5c".repeat(28) }, did_commit: "d1".repeat(32) }, svc);
    expect(r.status).toBe(400);
    expect(errCode(r)).toBe("CHANGE_ADDRESS_REQUIRED");
  });
});

describe("hình dạng thân bài", () => {
  const s = () => service("Preprod", deploymentJson("Preprod")).svc;
  const T2_OK = {
    ...KEY_OWNER, fund_id: "f0", carp_amount: "5",
    sponsor: { utxo_refs: [`${"ab".repeat(32)}#0`], change_address: credentialToAddress("Preprod", { type: "Key", hash: SPONSOR_PKH }) },
  };

  it.each([
    ["/tx/sponsor/t1-open", { ...KEY_OWNER, did_commit: "zz" }, "DID_COMMIT_INVALID"],
    ["/tx/sponsor/t2-fund", { ...KEY_OWNER, fund_id: "f0", carp_amount: "5" }, "SPONSOR_REQUEST_SHAPE"],
    ["/tx/sponsor/t2-fund", { ...T2_OK, sponsor: { ...T2_OK.sponsor, utxo_refs: [] } }, "SPONSOR_REQUEST_SHAPE"],
    ["/tx/sponsor/t2-fund", { ...T2_OK, sponsor: { ...T2_OK.sponsor, utxo_refs: [`${"ab".repeat(32)}#0`, `${"ab".repeat(32)}#0`] } }, "SPONSOR_REQUEST_SHAPE"],
    ["/tx/sponsor/t2-fund", { ...T2_OK, fund_id: "F0" }, "SPONSOR_REQUEST_SHAPE"],
    ["/tx/sponsor/t2-fund", { ...T2_OK, sponsor: { ...T2_OK.sponsor, change_address: scriptAddr("Preprod", "c9".repeat(28)) } }, "SPONSOR_CHANGE_ADDRESS_INVALID"],
    ["/tx/sponsor/t3-draw", { ...KEY_OWNER, fund_id: "f0", carp_amount: "x" }, "BAD_REQUEST"],
    ["/tx/sponsor/t4-first-consume", { ...KEY_OWNER, op_type: 1, op_count: "1", draw_epoch: -1 }, "SPONSOR_REQUEST_SHAPE"],
    ["/tx/sponsor/t4-first-consume", { ...KEY_OWNER, op_type: 1, op_count: "1", draw_epoch: 330, vault_ref: "nope" }, "SPONSOR_REQUEST_SHAPE"],
  ])("%s %j ⟹ 400 %s", async (path, body, code) => {
    const r = await post(path, body, s());
    expect(r.status).toBe(400);
    expect(errCode(r)).toBe(code);
  });

  it("CẶP: thân T2 hợp lệ ⟹ qua tầng hình dạng (chết ở cổng script, 501)", async () => {
    const r = await post("/tx/sponsor/t2-fund", T2_OK, s());
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("SPONSOR_PREPAID_SCRIPTS_MISMATCH");
  });
});

describe("bộ định tuyến /tx/sponsor/*", () => {
  it("plan ⟹ 200: T2 ký theo thứ tự ví trả phí · bên tài trợ · chủ; T3/T4 cùng kỳ; chạy được khi dịch vụ tài trợ vắng", async () => {
    const r = await post("/tx/sponsor/plan", { ...KEY_OWNER, sponsor_pkh: SPONSOR_PKH }, undefined);
    expect(r.status).toBe(200);
    const steps = r.body.steps as Array<{ step: string; path?: string; signers: Array<{ role: string }> }>;
    const t2 = steps.find(x => x.step === "T2")!;
    expect(t2.path).toBe("/tx/sponsor/t2-fund");
    expect(t2.signers.map(x => x.role)).toEqual(["fee-wallet", "sponsor", "owner"]);
    expect(steps.find(x => x.step === "T3")!.signers.map(x => x.role)).toEqual(["fee-wallet", "owner"]);
    expect(r.body.same_epoch).toEqual(expect.arrayContaining(["T3", "T4"]));
  });

  it("CẶP: plan với sponsor_pkh sai ⟹ 400 SPONSOR_REQUEST_SHAPE", async () => {
    const r = await post("/tx/sponsor/plan", { ...KEY_OWNER, sponsor_pkh: "XYZ" }, undefined);
    expect(r.status).toBe(400);
    expect(errCode(r)).toBe("SPONSOR_REQUEST_SHAPE");
  });

  it("GET ⟹ 405; dịch vụ tài trợ vắng ⟹ 501 SPONSOR_UNAVAILABLE; đường lạ ⟹ 404", async () => {
    expect((await post("/tx/sponsor/t1-open", undefined, undefined, "GET")).status).toBe(405);
    const off = await post("/tx/sponsor/t1-open", T1_BODY, undefined);
    expect(off.status).toBe(501);
    expect(errCode(off)).toBe("SPONSOR_UNAVAILABLE");
    const lost = await post("/tx/sponsor/t5-genesis", T1_BODY, undefined);
    expect(lost.status).toBe(404);
  });

  it("lỗi nội bộ (GRID_MISMATCH lọt ra) ⟹ 500 INTERNAL + reference_code; thông điệp gốc KHÔNG ra ngoài, có trong nhật ký", async () => {
    logged.length = 0;
    const stub = { t1Open: async () => { throw new SponsorJourneyError("SPONSOR_GRID_MISMATCH", "lưới /secret/path lệch"); } };
    const r = await post("/tx/sponsor/t1-open", T1_BODY, stub as unknown as SponsorTxService);
    expect(r.status).toBe(500);
    expect(errCode(r)).toBe("INTERNAL");
    const ref = errDetails(r).reference_code as string;
    expect(ref).toMatch(/\S/);
    expect(JSON.stringify(r.body)).not.toContain("/secret/path");
    expect(logged.map(([x]) => x)).toContain(ref);
  });
});

describe("bảng mã SDK → HTTP", () => {
  const ALL: SponsorJourneyErrorCode[] = Object.keys(SPONSOR_ERROR_STATUS) as SponsorJourneyErrorCode[];

  it("đủ 11 mã; mỗi mã 4xx giữ NGUYÊN code, bỏ tiền tố [CODE]; mã nội bộ đi nguyên (để thành 500)", () => {
    expect(ALL).toHaveLength(11);
    for (const code of ALL) {
      const out = sponsorApiErrorOf(new SponsorJourneyError(code, "chi tiết"));
      const want = SPONSOR_ERROR_STATUS[code];
      if (want === "internal") {
        expect(out).toBeInstanceOf(SponsorJourneyError);
      } else {
        expect(out).toBeInstanceOf(CodedApiError);
        expect((out as CodedApiError).httpStatus).toBe(want);
        expect((out as CodedApiError).code).toBe(code);
        expect((out as CodedApiError).message).toBe("chi tiết");
      }
    }
  });

  it("mức cụ thể của các mã người gọi sửa được", () => {
    expect(SPONSOR_ERROR_STATUS.SPONSOR_DID_COMMIT_LENGTH).toBe(400);
    expect(SPONSOR_ERROR_STATUS.SPONSOR_EPOCH_MISMATCH).toBe(409);
    expect(SPONSOR_ERROR_STATUS.SPONSOR_CARP_INSUFFICIENT).toBe(422);
    expect(SPONSOR_ERROR_STATUS.SPONSOR_GRID_MISMATCH).toBe("internal");
    expect(SPONSOR_ERROR_STATUS.SPONSOR_ANCHOR_REF_MISSING).toBe("internal");
  });

  it("lỗi bộ dựng khác ⟹ 422 TX_BUILD_REJECTED kèm rule_code; lỗi lập trình (TypeError) đi NGUYÊN; OwnerAuthError giữ mã", () => {
    const rule = Object.assign(new Error("C-PP-7 hết hạn"), { name: "PrepaidTxError", code: "C-PP-7" });
    const a = asSponsorApiError(rule);
    expect(a).toBeInstanceOf(TxBuildRejectedError);
    expect((a as TxApiError).details).toMatchObject({ rule_code: "C-PP-7", thrown_by: "PrepaidTxError" });
    const t = new TypeError("x is undefined");
    expect(asSponsorApiError(t)).toBe(t);
    const o = asSponsorApiError(new OwnerAuthError("OWNER_SCRIPT_WITNESS_UNAVAILABLE" as never, "thiếu"));
    expect((o as TxApiError).code).toBe("OWNER_SCRIPT_WITNESS_UNAVAILABLE");
  });
});

describe("vaultModuleOf — két Prepaid", () => {
  it("Prepaid ⟹ 501 VAULT_KIND_UNSUPPORTED, trỏ sang /tx/sponsor/t4-first-consume", () => {
    let e: unknown = null;
    try { vaultModuleOf(PREPAID_VAULT_TYPE); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(CodedApiError);
    expect((e as CodedApiError).httpStatus).toBe(501);
    expect((e as CodedApiError).code).toBe("VAULT_KIND_UNSUPPORTED");
    expect((e as CodedApiError).details.use_instead).toBe("/tx/sponsor/t4-first-consume");
  });

  it("CẶP: Instant / Schedule ⟹ trả mô-đun, không ném", () => {
    expect(() => vaultModuleOf("Instant")).not.toThrow();
    expect(() => vaultModuleOf("Schedule")).not.toThrow();
  });
});
