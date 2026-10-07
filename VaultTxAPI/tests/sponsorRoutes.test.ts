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
import {
  PrepaidRuleError, PrepaidTxError, encodeFundDatum, type PaidFundDatum, type PrepaidBlueprint,
} from "@magiclamp/prepaidgen-sdk";
import type { UTxO } from "@lucid-evolution/lucid";
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
  SPONSOR_ERROR_STATUS, SponsorTxService, asSponsorApiError, assertOwnerDid, assertSponsorUtxosPinned,
  assertFundPinnedOutputs, parseSponsorRequest, sponsorApiErrorOf, type SponsorTxServiceDeps, type FundPinnedOutputsExpect,
} from "../src/sponsor.js";
import { parseBuildRequest } from "../src/buildRequest.js";
import type { ResolvedOwnerWitness } from "../src/owner.js";
import { vaultModuleOf } from "../src/txBuilder.js";
import { LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, OWNER_PKH } from "./fixtures/preview.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const PG_BP = here("../../PrepaidGen/onchain/plutus.json");

type Net = "Preprod" | "Preview";
const scriptAddr = (net: Net, hash: string) => credentialToAddress(net, { type: "Script", hash });
const CARP_UNIT = "22".repeat(28) + "5a".repeat(28);
const SPONSOR_PKH = "5b".repeat(28);
const TIP: ChainTip = { blockHeight: 1, blockHash: "00".repeat(32), blockTimePosixMs: 1_789_100_703_000n };

const SPONSOR_ADDR = credentialToAddress("Preprod", { type: "Key", hash: SPONSOR_PKH });
const FUND_HASH = "c2".repeat(28);
/** Ghim mặc định của khối dựng thử: quỹ `f0`, ví bên tài trợ SPONSOR_ADDR, trần 100 carpdrop. */
const PINS = { fund_units: [`${FUND_HASH}f0`], addresses: [SPONSOR_ADDR], max_carp_amount: "100" };
const ROLE_TOKEN = "vai-sponsor-cua-phep-kiem";
const APP_TOKEN = "the-thuong-cua-phep-kiem";

function deploymentJson(net: Net, o: {
  kind?: "Prepaid" | "Instant"; carp?: string | null; didStake?: boolean; pins?: Record<string, unknown> | null;
} = {}): string {
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
      address: scriptAddr(net, FUND_HASH),
      ...(o.carp === null ? {} : { carp_unit: o.carp ?? CARP_UNIT }),
      ...(o.pins === null || net !== "Preprod" ? {} : { sponsor: o.pins ?? PINS }),
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
    issued: new IssuedTxRegistry(),
    lockTtlMs: 60_000,
    prepaidBlueprint: blueprint(),
    lucidForWallet: async () => { lucidCalls++; throw new Error("bộ dựng KHÔNG được chạm trong bài này"); },
    // Các cổng KHÁC cổng loại chủ dùng chủ khoá cho gọn; cổng loại chủ có describe riêng với cờ TẮT.
    allowKeyOwner: true,
    ...over,
  });
  return { svc, reads };
}

const logged: Array<[string, unknown]> = [];
function deps(sponsor: SponsorTxService | undefined, auth: { token?: string; sponsorToken?: string } = {}): RouterDeps {
  return {
    service: {} as unknown as VaultTxService, // đường /tx/sponsor/* không chạm dịch vụ cũ
    deploymentSource: "phép kiểm",
    vaultScopes: [],
    network: "Preprod",
    chainLabel: "counting",
    changeAddressStrategy: "owner-enterprise",
    token: auth.token ?? "",
    sponsorToken: auth.sponsorToken ?? ROLE_TOKEN,
    logInternal: (ref, cause) => { logged.push([ref, cause]); },
    ...(sponsor === undefined ? {} : { sponsor }),
  };
}

/** Mặc định fund-vault đi bằng thẻ vai sponsor (đúng vai); bài về vai tự truyền `headers`/`auth`. */
async function post(path: string, body: unknown, sponsor: SponsorTxService | undefined, method = "POST",
  headers: Record<string, string> = path === "/tx/sponsor/fund-vault" ? { authorization: `Bearer ${ROLE_TOKEN}` } : {},
  auth: { token?: string; sponsorToken?: string } = {}) {
  return handle({ method, url: path, headers, body }, deps(sponsor, auth));
}

const KEY_OWNER = { owner: { type: "key", hash: OWNER_PKH } };
const OPEN_BODY = { ...KEY_OWNER, did_commit: "d1".repeat(32) };
const errCode = (r: { body: Record<string, unknown> }) => (r.body.error as { code: string }).code;
const errDetails = (r: { body: Record<string, unknown> }) => (r.body.error as { details: Record<string, unknown> }).details;

describe("cổng mạng — gốc cửa sổ kỳ", () => {
  it("Preview (không có gốc O) ⟹ 501 SPONSOR_NETWORK_UNSUPPORTED, cause_code gốc, 0 lượt đọc chuỗi, 0 lượt dựng", async () => {
    const { svc, reads } = service("Preview", deploymentJson("Preview"));
    lucidCalls = 0;
    const r = await post("/tx/sponsor/open-vault", OPEN_BODY, svc);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("SPONSOR_NETWORK_UNSUPPORTED");
    expect(errDetails(r).cause_code).toMatch(/^WIN-/);
    expect(reads()).toBe(0);
    expect(lucidCalls).toBe(0);
  });

  it("CẶP: cùng yêu cầu trên Preprod ⟹ qua cổng mạng (chết ở cổng sau, mã KHÁC)", async () => {
    const { svc } = service("Preprod", deploymentJson("Preprod"));
    const r = await post("/tx/sponsor/open-vault", OPEN_BODY, svc);
    expect(errCode(r)).not.toBe("SPONSOR_NETWORK_UNSUPPORTED");
  });
});

describe("cổng khối deploy Prepaid", () => {
  it("khối Instant ⟹ 501 SPONSOR_PREPAID_UNAVAILABLE, nêu vault_types", async () => {
    const { svc, reads } = service("Preprod", deploymentJson("Preprod", { kind: "Instant" }));
    const r = await post("/tx/sponsor/draw-magic", { ...KEY_OWNER, fund_id: "f0", carp_amount: "1" }, svc);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("SPONSOR_PREPAID_UNAVAILABLE");
    expect(errDetails(r).vault_types).toEqual(["Instant"]);
    expect(reads()).toBe(0);
  });

  it("khối Prepaid thiếu paid_fund.carp_unit ⟹ 501 CONFIG_MISSING nêu đúng khoá, KHÔNG đệm", async () => {
    const { svc, reads } = service("Preprod", deploymentJson("Preprod", { carp: null }));
    const r = await post("/tx/sponsor/open-vault", OPEN_BODY, svc);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("CONFIG_MISSING");
    expect(errDetails(r).missing).toEqual(["paid_fund.carp_unit"]);
    expect(reads()).toBe(0);
  });

  it("CẶP: có carp_unit mà hash cấu hình KHÁC script suy từ blueprint ⟹ 501 SPONSOR_PREPAID_SCRIPTS_MISMATCH, 0 lượt dựng", async () => {
    lucidCalls = 0;
    const { svc } = service("Preprod", deploymentJson("Preprod"));
    const r = await post("/tx/sponsor/open-vault", OPEN_BODY, svc);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("SPONSOR_PREPAID_SCRIPTS_MISMATCH");
    const d = errDetails(r) as { configured: { vault_hash: string }; derived: { vault_hash: string } };
    expect(d.configured.vault_hash).toBe("c1".repeat(28));
    expect(d.derived.vault_hash).toMatch(/^[0-9a-f]{56}$/);
    expect(d.derived.vault_hash).not.toBe(d.configured.vault_hash);
    expect(lucidCalls).toBe(0);
    // Khoá chủ đã NHẢ: lượt thứ hai nhận lại đúng 501, không phải 409 OWNER_TX_IN_FLIGHT.
    const again = await post("/tx/sponsor/open-vault", OPEN_BODY, svc);
    expect(errCode(again)).toBe("SPONSOR_PREPAID_SCRIPTS_MISMATCH");
  });

  // Thứ tự trong `run`: cổng script (`prepare`) chạy TRƯỚC thân fund-vault, nơi đòi `did_stake.anchor_nft_policy`.
  // Khối dựng thử ở đây có hash giả ⟹ cổng script thắng. Ca CONFIG_MISSING thật (script khớp, thiếu
  // did_stake) chỉ dựng được với script thật: `sponsorEmulator.test.ts` ▸ "fund-vault ĐỎ: … thiếu did_stake".
  it("fund-vault trên bản deploy thiếu did_stake, hash giả ⟹ 501 SPONSOR_PREPAID_SCRIPTS_MISMATCH (cổng script chạy trước)", async () => {
    const { svc } = service("Preprod", deploymentJson("Preprod", { didStake: false }));
    const r = await post("/tx/sponsor/fund-vault", {
      ...KEY_OWNER, fund_id: "f0", carp_amount: "5",
      sponsor: { utxo_refs: [`${"ab".repeat(32)}#0`] },
    }, svc);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("SPONSOR_PREPAID_SCRIPTS_MISMATCH");
  });
});

describe("fee_payer và nhân chứng", () => {
  // Hành trình fee_payer đi trọn open-vault→first-consume trên script thật: `sponsorEmulator.test.ts`. Ở đây chỉ các cổng
  // hình dạng chạy TRƯỚC mọi lượt đọc chuỗi (cặp xanh: các bài Emulator, cùng hình dạng thân).
  const FP = { utxo: `${"fe".repeat(32)}#0`, address: credentialToAddress("Preprod", { type: "Key", hash: "fe".repeat(28) }) };
  it("fee_payer + change_address ⟹ 400 FEE_PAYER_CHANGE_ADDRESS_CONFLICT, trước khi đọc chuỗi", async () => {
    const { svc, reads } = service("Preprod", deploymentJson("Preprod"));
    const r = await post("/tx/sponsor/open-vault", { ...OPEN_BODY, fee_payer: FP, change_address: FP.address }, svc);
    expect(r.status).toBe(400);
    expect(errCode(r)).toBe("FEE_PAYER_CHANGE_ADDRESS_CONFLICT");
    expect(reads()).toBe(0);
  });

  it("fee_payer.address sai mạng / là script ⟹ 400 FEE_PAYER_INVALID, trước khi đọc chuỗi", async () => {
    const { svc, reads } = service("Preprod", deploymentJson("Preprod"));
    for (const address of [
      credentialToAddress("Mainnet", { type: "Key", hash: "fe".repeat(28) }),
      credentialToAddress("Preprod", { type: "Script", hash: "fe".repeat(28) }),
    ]) {
      const r = await post("/tx/sponsor/draw-magic", { ...KEY_OWNER, fund_id: "f0", carp_amount: "5", fee_payer: { ...FP, address } }, svc);
      expect(r.status).toBe(400);
      expect(errCode(r)).toBe("FEE_PAYER_INVALID");
    }
    expect(reads()).toBe(0);
  });

  it("thân bài có funding (kể cả chỉ mang funding.fee_payer) ⟹ 400 SPONSOR_REQUEST_SHAPE; cặp: fee_payer ở gốc qua cổng hình dạng", async () => {
    const { svc, reads } = service("Preprod", deploymentJson("Preprod"));
    const r = await post("/tx/sponsor/open-vault", { ...OPEN_BODY, funding: { fee_payer: FP } }, svc);
    expect(r.status).toBe(400);
    expect(errCode(r)).toBe("SPONSOR_REQUEST_SHAPE");
    expect(reads()).toBe(0);
    const ok = await post("/tx/sponsor/open-vault", { ...OPEN_BODY, fee_payer: FP }, svc);
    expect(errCode(ok)).not.toBe("SPONSOR_REQUEST_SHAPE");
    expect(ok.status).not.toBe(400);
  });

  it("chủ script, dịch vụ không có nhân chứng ⟹ 501 OWNER_SCRIPT_WITNESS_UNAVAILABLE; chủ khoá kèm owner_witness ⟹ 400 OWNER_WITNESS_UNEXPECTED", async () => {
    const { svc } = service("Preprod", deploymentJson("Preprod"));
    const s = await post("/tx/sponsor/open-vault", { owner: { type: "script", hash: "5c".repeat(28) }, did_commit: "d1".repeat(32), change_address: credentialToAddress("Preprod", { type: "Key", hash: "fe".repeat(28) }) }, svc);
    expect(s.status).toBe(501);
    expect(errCode(s)).toBe("OWNER_SCRIPT_WITNESS_UNAVAILABLE");
    const k = await post("/tx/sponsor/open-vault", {
      ...OPEN_BODY,
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
    const r = await post("/tx/sponsor/open-vault", { owner: { type: "script", hash: "5c".repeat(28) }, did_commit: "d1".repeat(32) }, svc);
    expect(r.status).toBe(400);
    expect(errCode(r)).toBe("CHANGE_ADDRESS_REQUIRED");
  });
});

describe("hình dạng thân bài", () => {
  const s = () => service("Preprod", deploymentJson("Preprod")).svc;
  const FUND_OK = {
    ...KEY_OWNER, fund_id: "f0", carp_amount: "5",
    sponsor: { utxo_refs: [`${"ab".repeat(32)}#0`] },
  };

  it.each([
    ["/tx/sponsor/open-vault", { ...KEY_OWNER, did_commit: "zz" }, "DID_COMMIT_INVALID"],
    ["/tx/sponsor/fund-vault", { ...KEY_OWNER, fund_id: "f0", carp_amount: "5" }, "SPONSOR_REQUEST_SHAPE"],
    ["/tx/sponsor/fund-vault", { ...FUND_OK, sponsor: { ...FUND_OK.sponsor, utxo_refs: [] } }, "SPONSOR_REQUEST_SHAPE"],
    ["/tx/sponsor/fund-vault", { ...FUND_OK, sponsor: { ...FUND_OK.sponsor, utxo_refs: [`${"ab".repeat(32)}#0`, `${"ab".repeat(32)}#0`] } }, "SPONSOR_REQUEST_SHAPE"],
    ["/tx/sponsor/fund-vault", { ...FUND_OK, fund_id: "F0" }, "SPONSOR_REQUEST_SHAPE"],
    // Đích thối không còn do người gọi viết — kể cả đúng ví bên tài trợ cũng bị từ chối (trường đã bỏ).
    ["/tx/sponsor/fund-vault", { ...FUND_OK, sponsor: { ...FUND_OK.sponsor, change_address: SPONSOR_ADDR } }, "SPONSOR_REQUEST_SHAPE"],
    // Trần chữ số trước `BigInt()` (`buildRequest.ts` ▸ `MAX_AMOUNT_DIGITS`).
    ["/tx/sponsor/fund-vault", { ...FUND_OK, carp_amount: "1".repeat(21) }, "BAD_REQUEST"],
    ["/tx/sponsor/open-vault", { ...KEY_OWNER, did_commit: "d1".repeat(32), thread_lovelace: "9".repeat(21) }, "BAD_REQUEST"],
    ["/tx/sponsor/draw-magic", { ...KEY_OWNER, fund_id: "f0", carp_amount: "x" }, "BAD_REQUEST"],
    ["/tx/sponsor/first-consume", { ...KEY_OWNER, op_type: 1, op_count: "1", draw_epoch: -1 }, "SPONSOR_REQUEST_SHAPE"],
    ["/tx/sponsor/first-consume", { ...KEY_OWNER, op_type: 1, op_count: "1", draw_epoch: 330, vault_ref: "nope" }, "SPONSOR_REQUEST_SHAPE"],
  ])("%s %j ⟹ 400 %s", async (path, body, code) => {
    const r = await post(path, body, s());
    expect(r.status).toBe(400);
    expect(errCode(r)).toBe(code);
  });

  it("CẶP: thân fund-vault hợp lệ ⟹ qua tầng hình dạng (chết ở cổng script, 501)", async () => {
    const r = await post("/tx/sponsor/fund-vault", FUND_OK, s());
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("SPONSOR_PREPAID_SCRIPTS_MISMATCH");
  });
});

describe("bộ định tuyến /tx/sponsor/*", () => {
  it("plan ⟹ 200: fund-vault ký theo thứ tự ví trả phí · bên tài trợ · chủ; draw-magic/first-consume cùng kỳ; chạy được khi dịch vụ tài trợ vắng", async () => {
    const r = await post("/tx/sponsor/plan", { ...KEY_OWNER, sponsor_pkh: SPONSOR_PKH }, undefined);
    expect(r.status).toBe(200);
    const steps = r.body.steps as Array<{ step: string; path?: string; signers: Array<{ role: string }> }>;
    const fundStep = steps.find(x => x.step === "fund-vault")!;
    expect(fundStep.path).toBe("/tx/sponsor/fund-vault");
    expect(fundStep.signers.map(x => x.role)).toEqual(["fee-wallet", "sponsor", "owner"]);
    expect(steps.find(x => x.step === "draw-magic")!.signers.map(x => x.role)).toEqual(["fee-wallet", "owner"]);
    expect(r.body.same_epoch).toEqual(expect.arrayContaining(["draw-magic", "first-consume"]));
  });

  it("plan: open-fund đứng SAU bind-did, TRƯỚC fund-vault; vai ký = ví trả phí · platform (chủ KHÔNG ký); fund-vault đòi open-fund", async () => {
    const r = await post("/tx/sponsor/plan", { ...KEY_OWNER, sponsor_pkh: SPONSOR_PKH }, undefined);
    expect(r.status).toBe(200);
    const steps = r.body.steps as Array<{ step: string; path?: string; signers: Array<{ role: string }>; requires: string[] }>;
    const order = steps.map(x => x.step).filter(s => s !== "wakeme-genesis");
    expect(order).toEqual(["open-vault", "bind-did", "open-fund", "fund-vault", "draw-magic", "first-consume"]);
    const open = steps.find(x => x.step === "open-fund")!;
    expect(open.path).toBe("/tx/sponsor/open-fund");
    expect(open.signers.map(x => x.role)).toEqual(["fee-wallet", "platform"]);
    expect(steps.find(x => x.step === "fund-vault")!.requires.some(q => q.startsWith("open-fund"))).toBe(true);
  });

  it("open-fund: thân bài mang did_commit / owner_commit / sponsor / beneficiary / fund_id ⟹ 400 SPONSOR_REQUEST_SHAPE; CẶP: chỉ owner ⟹ qua", () => {
    for (const f of ["did_commit", "owner_commit", "sponsor", "beneficiary", "fund_id", "platform_pkh"]) {
      let caught: unknown;
      try {
        parseSponsorRequest("open-fund", { ...KEY_OWNER, [f]: "d1".repeat(32) });
      } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(CodedApiError);
      expect((caught as CodedApiError).httpStatus).toBe(400);
      expect((caught as CodedApiError).code).toBe("SPONSOR_REQUEST_SHAPE");
      expect((caught as CodedApiError).details).toMatchObject({ field: f });
    }
    expect(parseSponsorRequest("open-fund", { ...KEY_OWNER }).owner).toEqual(KEY_OWNER.owner);
  });

  it("CẶP: plan với sponsor_pkh sai ⟹ 400 SPONSOR_REQUEST_SHAPE", async () => {
    const r = await post("/tx/sponsor/plan", { ...KEY_OWNER, sponsor_pkh: "XYZ" }, undefined);
    expect(r.status).toBe(400);
    expect(errCode(r)).toBe("SPONSOR_REQUEST_SHAPE");
  });

  it("GET ⟹ 405; dịch vụ tài trợ vắng ⟹ 501 SPONSOR_UNAVAILABLE; đường lạ ⟹ 404", async () => {
    expect((await post("/tx/sponsor/open-vault", undefined, undefined, "GET")).status).toBe(405);
    const off = await post("/tx/sponsor/open-vault", OPEN_BODY, undefined);
    expect(off.status).toBe(501);
    expect(errCode(off)).toBe("SPONSOR_UNAVAILABLE");
    const lost = await post("/tx/sponsor/t5-genesis", OPEN_BODY, undefined);
    expect(lost.status).toBe(404);
  });

  it("lỗi nội bộ (GRID_MISMATCH lọt ra) ⟹ 500 INTERNAL + reference_code; thông điệp gốc KHÔNG ra ngoài, có trong nhật ký", async () => {
    logged.length = 0;
    const stub = { openVault: async () => { throw new SponsorJourneyError("SPONSOR_GRID_MISMATCH", "lưới /secret/path lệch"); } };
    const r = await post("/tx/sponsor/open-vault", OPEN_BODY, stub as unknown as SponsorTxService);
    expect(r.status).toBe(500);
    expect(errCode(r)).toBe("INTERNAL");
    const ref = errDetails(r).reference_code as string;
    expect(ref).toMatch(/\S/);
    expect(JSON.stringify(r.body)).not.toContain("/secret/path");
    expect(logged.map(([x]) => x)).toContain(ref);
  });

  it("tên route CŨ (t1-open · t2-fund · t3-draw · t4-first-consume) ⟹ 404, không bí danh; CẶP: tên mới ⟹ không 404", async () => {
    const { svc } = service("Preprod", deploymentJson("Preprod"));
    for (const old of ["t1-open", "t2-fund", "t3-draw", "t4-first-consume"]) {
      const r = await post(`/tx/sponsor/${old}`, OPEN_BODY, svc, "POST", { authorization: `Bearer ${ROLE_TOKEN}` });
      expect(r.status, old).toBe(404);
    }
    const now = await post("/tx/sponsor/fund-vault", FUND_BASE, svc);
    expect(now.status).not.toBe(404);
  });
});

describe("GET /sponsor/funds — tình trạng quỹ tài trợ theo DID", () => {
  const PINNED = { ...PINS, fund_units: [`${FUND_HASH}f0`, `${FUND_HASH}f1`] };
  const vaultHash = "c1".repeat(28);
  const fundAddr = scriptAddr("Preprod", FUND_HASH);
  const keyAddr = (pkh: string) => ({ payment_credential: { VerificationKey: [pkh] as [string] }, stake_credential: null });
  const datum = (fundId: string, sponsorship: PaidFundDatum["sponsorship"], credit: bigint): PaidFundDatum => ({
    fund_id: fundId, platform: "11".repeat(28), vault_hash: vaultHash, carp_locked: credit, credit_issued: credit,
    magic_settled: 0n, provider_claimed: 0n, buffer_bps: 1_500n, last_updated_epoch: 0n,
    beneficiary: keyAddr("33".repeat(28)), beneficiary_datum: null, sponsorship, sponsor_reclaimed: 0n,
  });
  const utxo = (fundId: string, d: PaidFundDatum, i: number): UTxO => ({
    txHash: "ee".repeat(32), outputIndex: i, address: fundAddr,
    assets: { lovelace: 3_000_000n, [`${FUND_HASH}${fundId}`]: 1n, [CARP_UNIT]: d.carp_locked }, datum: encodeFundDatum(d),
  }) as UTxO;
  const DID = "d1".repeat(32);
  const chainWith = (fail: boolean): ChainReader => ({
    label: "stub",
    utxosAt: async a => {
      if (fail) throw new Error("nhà cung cấp sập");
      return a === SPONSOR_ADDR ? [{ txHash: "aa".repeat(32), outputIndex: 0, address: a, assets: { lovelace: 5n, [CARP_UNIT]: 40n } } as UTxO] : [];
    },
    utxosByOutRef: async () => [],
    utxosByUnit: async u => {
      if (fail) throw new Error("nhà cung cấp sập");
      if (u === `${FUND_HASH}f0`) return [utxo("f0", datum("f0", { sponsor: keyAddr(SPONSOR_PKH), owner_commit: DID, reclaim_after_epoch: 530n }, 7n), 0)];
      if (u === `${FUND_HASH}f1`) return [utxo("f1", datum("f1", null, 100n), 1)];
      return [];
    },
    tip: async () => TIP,
    submitTx: async () => { throw new Error("không nộp"); },
    rewardAccount: async () => { throw new Error("không đọc"); },
  });
  const get = (path: string, s: SponsorTxService | undefined, method = "GET") => handle({ method, url: path, headers: {}, body: undefined }, deps(s));

  it("200: quỹ của DID mang owner_commit + reclaim_after_epoch; quỹ chung ⟹ not_sponsored, không vào tổng; CARP ví bên tài trợ", async () => {
    const { svc } = service("Preprod", deploymentJson("Preprod", { pins: PINNED }), { chain: chainWith(false) });
    const r = await get("/sponsor/funds", svc);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const funds = r.body.funds as Array<Record<string, unknown>>;
    expect(funds.map(f => [f.fund_id, f.owner_commit, f.problem, f.busy])).toEqual([["f0", DID, null, false], ["f1", null, "not_sponsored", false]]);
    expect(funds[0]!.reclaim_after_epoch).toBe("530");
    expect((r.body.totals as Record<string, unknown>).carp_locked).toBe("7");
    expect(r.body.sponsor_carp_total).toBe("40");
  });

  it("CỰC ĐỐI: nhà cung cấp chuỗi lỗi ⟹ 502 CHAIN_UNAVAILABLE, không trả bảng rỗng", async () => {
    const { svc } = service("Preprod", deploymentJson("Preprod", { pins: PINNED }), { chain: chainWith(true) });
    const r = await get("/sponsor/funds", svc);
    expect(r.status).toBe(502);
    expect(errCode(r)).toBe("CHAIN_UNAVAILABLE");
    expect(r.body.funds).toBeUndefined();
  });

  it("POST ⟹ 405; dịch vụ tài trợ vắng ⟹ 501 SPONSOR_UNAVAILABLE; đường cũ /sponsor/pool ⟹ 404", async () => {
    const { svc } = service("Preprod", deploymentJson("Preprod", { pins: PINNED }), { chain: chainWith(false) });
    expect((await get("/sponsor/funds", svc, "POST")).status).toBe(405);
    const off = await get("/sponsor/funds", undefined);
    expect([off.status, errCode(off)]).toEqual([501, "SPONSOR_UNAVAILABLE"]);
    expect((await get("/sponsor/pool", svc)).status).toBe(404);
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

  it("lớp có mã của bộ dựng (PrepaidTxError / PrepaidRuleError) ⟹ 422 TX_BUILD_REJECTED kèm rule_code; lỗi lập trình đi NGUYÊN; OwnerAuthError giữ mã", () => {
    for (const rule of [new PrepaidTxError("C-PP-7", "hết hạn"), new PrepaidRuleError("C-PP-5", "sai kỳ")]) {
      const a = asSponsorApiError(rule);
      expect(a).toBeInstanceOf(TxBuildRejectedError);
      expect((a as TxApiError).details).toMatchObject({ rule_code: rule.code, thrown_by: rule.name });
    }
    const t = new TypeError("x is undefined");
    expect(asSponsorApiError(t)).toBe(t);
    const o = asSponsorApiError(new OwnerAuthError("OWNER_SCRIPT_WITNESS_UNAVAILABLE" as never, "thiếu"));
    expect((o as TxApiError).code).toBe("OWNER_SCRIPT_WITNESS_UNAVAILABLE");
  });
});

describe("vaultModuleOf — két Prepaid", () => {
  it("Prepaid ⟹ 501 VAULT_KIND_UNSUPPORTED, trỏ sang /tx/sponsor/first-consume", () => {
    let e: unknown = null;
    try { vaultModuleOf(PREPAID_VAULT_TYPE); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(CodedApiError);
    expect((e as CodedApiError).httpStatus).toBe(501);
    expect((e as CodedApiError).code).toBe("VAULT_KIND_UNSUPPORTED");
    expect((e as CodedApiError).details.use_instead).toBe("/tx/sponsor/first-consume");
  });

  it("CẶP: Instant / Schedule ⟹ trả mô-đun, không ném", () => {
    expect(() => vaultModuleOf("Instant")).not.toThrow();
    expect(() => vaultModuleOf("Schedule")).not.toThrow();
  });
});

// ── G12: ba lỗ của luồng tài trợ + bốn mục soát bổ sung ───────────────────────

const FUND_BASE = { ...KEY_OWNER, fund_id: "f0", carp_amount: "5", sponsor: { utxo_refs: [`${"ab".repeat(32)}#0`] } };

describe("vai thẻ bài — fund-vault chỉ mở bằng thẻ vai sponsor", () => {
  const s = () => service("Preprod", deploymentJson("Preprod")).svc;
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const auth = { token: APP_TOKEN, sponsorToken: ROLE_TOKEN };

  it("thẻ thường gọi fund-vault ⟹ 403 SPONSOR_ROLE_REQUIRED, trước mọi lượt đọc chuỗi", async () => {
    const { svc, reads } = service("Preprod", deploymentJson("Preprod"));
    const r = await post("/tx/sponsor/fund-vault", FUND_BASE, svc, "POST", bearer(APP_TOKEN), auth);
    expect(r.status).toBe(403);
    expect(errCode(r)).toBe("SPONSOR_ROLE_REQUIRED");
    expect(reads()).toBe(0);
  });

  it("CẶP: thẻ vai sponsor gọi fund-vault ⟹ qua cổng vai (chết ở cổng script, 501)", async () => {
    const r = await post("/tx/sponsor/fund-vault", FUND_BASE, s(), "POST", bearer(ROLE_TOKEN), auth);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("SPONSOR_PREPAID_SCRIPTS_MISMATCH");
  });

  it("dịch vụ không thẻ (loopback) + không gửi thẻ ⟹ fund-vault vẫn 403; thẻ lạ ⟹ 401", async () => {
    const open = await post("/tx/sponsor/fund-vault", FUND_BASE, s(), "POST", {}, { token: "", sponsorToken: ROLE_TOKEN });
    expect(open.status).toBe(403);
    const odd = await post("/tx/sponsor/fund-vault", FUND_BASE, s(), "POST", bearer("la"), auth);
    expect(odd.status).toBe(401);
  });

  it("thiếu thẻ vai sponsor ở dịch vụ ⟹ fund-vault 501 CONFIG_MISSING (kể cả gửi đúng thẻ thường), không mặc định cho qua", async () => {
    const r = await post("/tx/sponsor/fund-vault", FUND_BASE, s(), "POST", bearer(APP_TOKEN), { token: APP_TOKEN, sponsorToken: "" });
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("CONFIG_MISSING");
    expect(errDetails(r).missing).toEqual(["sponsor_role_token"]);
  });

  it("route tài trợ khác giữ thẻ thường: open-vault/draw-magic bằng thẻ thường qua cổng vai; thẻ vai sponsor ở open-vault ⟹ 401 (vai hẹp)", async () => {
    const openR = await post("/tx/sponsor/open-vault", OPEN_BODY, s(), "POST", bearer(APP_TOKEN), auth);
    expect(errCode(openR)).toBe("SPONSOR_PREPAID_SCRIPTS_MISMATCH");
    const drawR = await post("/tx/sponsor/draw-magic", { ...KEY_OWNER, fund_id: "f0", carp_amount: "1" }, s(), "POST", bearer(APP_TOKEN), auth);
    expect(errCode(drawR)).toBe("SPONSOR_PREPAID_SCRIPTS_MISMATCH");
    const wrongRole = await post("/tx/sponsor/open-vault", OPEN_BODY, s(), "POST", bearer(ROLE_TOKEN), auth);
    expect(wrongRole.status).toBe(401);
  });
});

describe("ghim cấu hình của fund-vault — trước khi giữ khoá, 0 lượt đọc chuỗi", () => {
  it("khối không có paid_fund.sponsor ⟹ 501 CONFIG_MISSING nêu đúng khoá", async () => {
    const { svc, reads } = service("Preprod", deploymentJson("Preprod", { pins: null }));
    const r = await post("/tx/sponsor/fund-vault", FUND_BASE, svc);
    expect(r.status).toBe(501);
    expect(errCode(r)).toBe("CONFIG_MISSING");
    expect(errDetails(r).missing).toEqual(["paid_fund.sponsor"]);
    expect(reads()).toBe(0);
  });

  it("quỹ ngoài tập đã ghim (f1) ⟹ 422 SPONSOR_FUND_NOT_ALLOWED; CẶP f0 ⟹ qua (chết ở cổng script)", async () => {
    const { svc, reads } = service("Preprod", deploymentJson("Preprod"));
    const r = await post("/tx/sponsor/fund-vault", { ...FUND_BASE, fund_id: "f1" }, svc);
    expect(r.status).toBe(422);
    expect(errCode(r)).toBe("SPONSOR_FUND_NOT_ALLOWED");
    expect(reads()).toBe(0);
    const ok = await post("/tx/sponsor/fund-vault", FUND_BASE, svc);
    expect(errCode(ok)).toBe("SPONSOR_PREPAID_SCRIPTS_MISMATCH");
  });

  it("carp_amount = trần + 1 ⟹ 422 SPONSOR_CARP_ABOVE_CAP; CẶP đúng trần ⟹ qua", async () => {
    const { svc } = service("Preprod", deploymentJson("Preprod"));
    const over = await post("/tx/sponsor/fund-vault", { ...FUND_BASE, carp_amount: "101" }, svc);
    expect(over.status).toBe(422);
    expect(errCode(over)).toBe("SPONSOR_CARP_ABOVE_CAP");
    const at = await post("/tx/sponsor/fund-vault", { ...FUND_BASE, carp_amount: "100" }, svc);
    expect(errCode(at)).toBe("SPONSOR_PREPAID_SCRIPTS_MISMATCH");
  });

  it("parseDeployment: ghim sai hình dạng ⟹ NÉM lúc khởi động, không thành 'không ghim'", () => {
    const bad = (pins: Record<string, unknown>) => () => parseDeployment(deploymentJson("Preprod", { pins }), "Preprod");
    expect(bad({ ...PINS, fund_units: [] })).toThrow(/fund_units/);
    expect(bad({ ...PINS, fund_units: [`${"c9".repeat(28)}f0`] })).toThrow(/policy paid_fund/);
    expect(bad({ ...PINS, addresses: [scriptAddr("Preprod", "c9".repeat(28))] })).toThrow(/KHOÁ/);
    // Viết HOA toàn bộ: giải mã được nhưng không chính tắc ⟹ chết đúng ở phép so chính tắc (không ở tiền tố).
    expect(bad({ ...PINS, addresses: [SPONSOR_ADDR.toUpperCase()] })).toThrow(/chính tắc/);
    // Chính tắc nhưng sai mạng ⟹ chết ở tiền tố.
    expect(bad({ ...PINS, addresses: [credentialToAddress("Mainnet", { type: "Key", hash: SPONSOR_PKH })] })).toThrow(/tiền tố/);
    expect(bad({ ...PINS, max_carp_amount: 100 })).toThrow(/max_carp_amount/);
    expect(bad({ ...PINS, max_carp_amount: "0" })).toThrow(/> 0/);
    expect(bad({ ...PINS, max_carp_amount: "1".repeat(21) })).toThrow(/max_carp_amount/);
    // CẶP: khối mặc định nạp được và giữ đúng giá trị.
    const d = parseDeployment(deploymentJson("Preprod"), "Preprod");
    expect(d.prepaid!.sponsor).toEqual({ fundUnits: PINS.fund_units, addresses: PINS.addresses, maxCarpAmount: 100n });
  });
});

describe("loại chủ — open-vault/fund-vault chỉ nhận chủ Script(did_stake) khi cờ bài kiểm TẮT", () => {
  const strict = () => service("Preprod", deploymentJson("Preprod"), { allowKeyOwner: false });

  it("chủ khoá ở open-vault ⟹ 422 SPONSOR_OWNER_NOT_DID, 0 lượt đọc chuỗi", async () => {
    const { svc, reads } = strict();
    const r = await post("/tx/sponsor/open-vault", OPEN_BODY, svc);
    expect(r.status).toBe(422);
    expect(errCode(r)).toBe("SPONSOR_OWNER_NOT_DID");
    expect(reads()).toBe(0);
  });

  it("chủ khoá ở fund-vault ⟹ 422 SPONSOR_OWNER_NOT_DID", async () => {
    const r = await post("/tx/sponsor/fund-vault", FUND_BASE, strict().svc);
    expect(r.status).toBe(422);
    expect(errCode(r)).toBe("SPONSOR_OWNER_NOT_DID");
  });

  it("CẶP: cùng yêu cầu khi cờ BẬT ⟹ qua cổng loại chủ; draw-magic chủ khoá khi cờ tắt ⟹ không bị cổng này chặn; chủ script ⟹ qua", async () => {
    const on = await post("/tx/sponsor/open-vault", OPEN_BODY, service("Preprod", deploymentJson("Preprod")).svc);
    expect(errCode(on)).toBe("SPONSOR_PREPAID_SCRIPTS_MISMATCH");
    const drawR = await post("/tx/sponsor/draw-magic", { ...KEY_OWNER, fund_id: "f0", carp_amount: "1" }, strict().svc);
    expect(errCode(drawR)).toBe("SPONSOR_PREPAID_SCRIPTS_MISMATCH");
    const script = await post("/tx/sponsor/open-vault",
      { owner: { type: "script", hash: "5c".repeat(28) }, did_commit: "d1".repeat(32), change_address: SPONSOR_ADDR }, strict().svc);
    expect(errCode(script)).toBe("OWNER_SCRIPT_WITNESS_UNAVAILABLE");
  });
});

describe("assertOwnerDid — tên anchor trong nhân chứng = did_commit", () => {
  const SCRIPT = { type: "script" as const, hash: "5c".repeat(28) };
  const DID = "d1".repeat(32);
  const w = (name?: string): ResolvedOwnerWitness =>
    ({ auth: { kind: "script", hash: SCRIPT.hash, attachWithdraw: (t: unknown) => t }, requiredSigners: [], notes: [],
      ...(name === undefined ? {} : { anchorNftName: name }) }) as unknown as ResolvedOwnerWitness;

  it("tên anchor = did_commit ⟹ qua", () => {
    expect(() => assertOwnerDid("open-vault", SCRIPT, w(DID), DID)).not.toThrow();
  });
  it("CỰC ĐỐI: anchor của DID KHÁC ⟹ 422 SPONSOR_OWNER_DID_MISMATCH", () => {
    expect(() => assertOwnerDid("fund-vault", SCRIPT, w("d2".repeat(32)), DID))
      .toThrow(expect.objectContaining({ httpStatus: 422, code: "SPONSOR_OWNER_DID_MISMATCH" }));
  });
  it("CỰC ĐỐI: nhân chứng không báo tên anchor ⟹ coi là lệch (fail-closed)", () => {
    expect(() => assertOwnerDid("open-vault", SCRIPT, w(), DID)).toThrow(expect.objectContaining({ code: "SPONSOR_OWNER_DID_MISMATCH" }));
    expect(() => assertOwnerDid("open-vault", SCRIPT, undefined, DID)).toThrow(expect.objectContaining({ code: "SPONSOR_OWNER_DID_MISMATCH" }));
  });
});

// ── đầu vào/đầu ra fund-vault đã ghim (thuần) ───────────────────────────────────────

const OTHER_TOKEN = `${"77".repeat(28)}abcd`;
const FUND_UNIT = `${FUND_HASH}f0`;
const FUND_ADDR = scriptAddr("Preprod", FUND_HASH);
const FEE_ADDR = credentialToAddress("Preprod", { type: "Key", hash: "fe".repeat(28) });
const ATK_ADDR = credentialToAddress("Preprod", { type: "Key", hash: "a7".repeat(28) });
const SAME_KEY_OTHER_STAKE = credentialToAddress("Preprod", { type: "Key", hash: SPONSOR_PKH }, { type: "Key", hash: "a7".repeat(28) });
const PINS_T: FundPinnedOutputsExpect["pins"] = { fundUnits: [FUND_UNIT], addresses: [SPONSOR_ADDR], maxCarpAmount: 100n };
const u = (address: string, assets: Record<string, bigint>, i = 0): UTxO =>
  ({ txHash: "ab".repeat(32), outputIndex: i, address, assets, datum: null, datumHash: null, scriptRef: null }) as UTxO;

describe("assertSponsorUtxosPinned", () => {
  it("một địa chỉ đã ghim, mỗi UTxO mang CARP ⟹ trả đúng địa chỉ đó (đích thối)", () => {
    expect(assertSponsorUtxosPinned([u(SPONSOR_ADDR, { lovelace: 5n, [CARP_UNIT]: 9n }), u(SPONSOR_ADDR, { lovelace: 1n, [CARP_UNIT]: 1n }, 1)], PINS_T, CARP_UNIT))
      .toBe(SPONSOR_ADDR);
  });
  it("CỰC ĐỐI: cùng khoá thanh toán, KHÁC phần stake ⟹ 422 SPONSOR_UTXO_NOT_ALLOWED (so nguyên văn)", () => {
    expect(() => assertSponsorUtxosPinned([u(SAME_KEY_OTHER_STAKE, { lovelace: 5n, [CARP_UNIT]: 9n })], PINS_T, CARP_UNIT))
      .toThrow(expect.objectContaining({ code: "SPONSOR_UTXO_NOT_ALLOWED" }));
  });
  it("CỰC ĐỐI: trộn một UTxO đã ghim với một UTxO của kẻ gọi ⟹ 422 SPONSOR_UTXO_NOT_ALLOWED", () => {
    expect(() => assertSponsorUtxosPinned([u(SPONSOR_ADDR, { lovelace: 5n, [CARP_UNIT]: 9n }), u(ATK_ADDR, { lovelace: 5n, [CARP_UNIT]: 9n }, 1)], PINS_T, CARP_UNIT))
      .toThrow(expect.objectContaining({ code: "SPONSOR_UTXO_NOT_ALLOWED" }));
  });
  it("CỰC ĐỐI: một UTxO đã ghim KHÔNG mang CARP ⟹ 422 SPONSOR_UTXO_NO_CARP", () => {
    expect(() => assertSponsorUtxosPinned([u(SPONSOR_ADDR, { lovelace: 5n, [CARP_UNIT]: 9n }), u(SPONSOR_ADDR, { lovelace: 9_000_000n }, 1)], PINS_T, CARP_UNIT))
      .toThrow(expect.objectContaining({ code: "SPONSOR_UTXO_NO_CARP" }));
  });
});

describe("assertFundPinnedOutputs — đọc lại output so với giá trị ĐÃ GHIM", () => {
  const fundIn = u(FUND_ADDR, { lovelace: 2_000_000n, [FUND_UNIT]: 1n, [CARP_UNIT]: 50n });
  const sponsorIn = [u(SPONSOR_ADDR, { lovelace: 4_872_000_000n, [CARP_UNIT]: 99_000n, [OTHER_TOKEN]: 7n })];
  const expectT2: FundPinnedOutputsExpect = {
    pins: PINS_T, carpUnit: CARP_UNIT, fundScriptHash: FUND_HASH, fundAddress: FUND_ADDR,
    fundIn, sponsorIn, sponsorAddress: SPONSOR_ADDR, carpAmount: 100n,
  };
  const good = () => [
    { index: 0, address: scriptAddr("Preprod", "c1".repeat(28)), assets: { lovelace: 3_000_000n } },
    { index: 1, address: FUND_ADDR, assets: { lovelace: 2_000_000n, [FUND_UNIT]: 1n, [CARP_UNIT]: 150n } },
    { index: 2, address: SPONSOR_ADDR, assets: { lovelace: 4_872_000_000n, [CARP_UNIT]: 98_900n, [OTHER_TOKEN]: 7n } },
    { index: 3, address: FEE_ADDR, assets: { lovelace: 900_000_000n } },
  ];
  const rejects = (outs: ReturnType<typeof good>) =>
    expect(() => assertFundPinnedOutputs(outs, expectT2)).toThrow(expect.objectContaining({ code: "SPONSOR_TX_MISMATCH" }));

  it("thối = vào − carp_amount TRỌN giá trị, quỹ +carp_amount ⟹ qua", () => {
    expect(() => assertFundPinnedOutputs(good(), expectT2)).not.toThrow();
  });
  it("CỰC ĐỐI (PoC): phần thối đi sang ví kẻ gọi ⟹ SPONSOR_TX_MISMATCH", () => {
    const o = good(); o[2]!.address = ATK_ADDR; rejects(o);
  });
  it("CỰC ĐỐI: thối thiếu 1 lovelace (ADA đi chỗ khác) ⟹ SPONSOR_TX_MISMATCH", () => {
    const o = good(); o[2]!.assets.lovelace -= 1n; o[3]!.assets.lovelace += 1n; rejects(o);
  });
  it("CỰC ĐỐI: token không-CARP của bên tài trợ đi sang output khác ⟹ SPONSOR_TX_MISMATCH", () => {
    const o = good(); delete (o[2]!.assets as Record<string, bigint>)[OTHER_TOKEN];
    (o[3]!.assets as Record<string, bigint>)[OTHER_TOKEN] = 7n; rejects(o);
  });
  it("CỰC ĐỐI: NFT quỹ ngoài tập đã ghim ⟹ SPONSOR_TX_MISMATCH", () => {
    const o = good(); const a = o[1]!.assets as Record<string, bigint>;
    delete a[FUND_UNIT]; a[`${FUND_HASH}f1`] = 1n; rejects(o);
  });
  it("CỰC ĐỐI: quỹ nhận lệch carp_amount ⟹ SPONSOR_TX_MISMATCH", () => {
    const o = good(); (o[1]!.assets as Record<string, bigint>)[CARP_UNIT] = 149n;
    (o[2]!.assets as Record<string, bigint>)[CARP_UNIT] = 98_901n; rejects(o);
  });
  it("CỰC ĐỐI: một output thứ ba mang CARP (quỹ + thối vẫn đúng) ⟹ SPONSOR_TX_MISMATCH", () => {
    const o = good(); (o[3]!.assets as Record<string, bigint>)[CARP_UNIT] = 1n; rejects(o);
  });
});

describe("asSponsorApiError — danh sách đóng", () => {
  it("Error thường (kể cả mang code + giả tên lớp) ⟹ đi NGUYÊN (để thành 500)", () => {
    const plain = Object.assign(new Error("lộ /secret/path"), { code: "X" });
    expect(asSponsorApiError(plain)).toBe(plain);
    const fake = Object.assign(new Error("giả"), { name: "PrepaidTxError", code: "C-PP-7" });
    expect(asSponsorApiError(fake)).toBe(fake);
  });
  it("qua route: lỗi lạ ⟹ 500 INTERNAL + reference_code, KHÔNG chứa message; CẶP PrepaidTxError ⟹ 422", async () => {
    logged.length = 0;
    const boom = { openVault: async () => { throw asSponsorApiError(new Error("lộ /secret/path")); } };
    const r = await post("/tx/sponsor/open-vault", OPEN_BODY, boom as unknown as SponsorTxService);
    expect(r.status).toBe(500);
    expect(errCode(r)).toBe("INTERNAL");
    expect(JSON.stringify(r.body)).not.toContain("/secret/path");
    expect(logged.map(([x]) => x)).toContain(errDetails(r).reference_code);
    const rule = { openVault: async () => { throw asSponsorApiError(new PrepaidTxError("C-PP-7", "hết hạn")); } };
    const q = await post("/tx/sponsor/open-vault", OPEN_BODY, rule as unknown as SponsorTxService);
    expect(q.status).toBe(422);
    expect(errCode(q)).toBe("TX_BUILD_REJECTED");
  });
});

describe("trần chữ số của lượng trong thân bài", () => {
  const big = "9".repeat(21);
  it("21 chữ số ⟹ 400, câu lỗi KHÔNG lặp lại con số; CẶP 20 chữ số ⟹ đọc được", () => {
    let e: unknown;
    try { parseBuildRequest("schedule-commit", { ...KEY_OWNER, schedule_length: "1", lamp_per_epoch: big }); } catch (x) { e = x; }
    expect(e).toMatchObject({ httpStatus: 400, code: "BAD_REQUEST", details: { max_digits: 20, received_digits: 21 } });
    expect(JSON.stringify((e as TxApiError).toBody())).not.toContain(big);
    const ok = parseBuildRequest("schedule-commit", { ...KEY_OWNER, schedule_length: "1", lamp_per_epoch: "9".repeat(20) });
    expect((ok.req as { lampPerEpoch: bigint }).lampPerEpoch).toBe(10n ** 20n - 1n);
  });
  it("m của instant-gen (bộ đọc có mã riêng) cùng trần: 21 chữ số ⟹ 400 INSTANT_GEN_M_INVALID; CẶP 20 ⟹ đọc được", () => {
    expect(() => parseBuildRequest("instant-gen", { ...KEY_OWNER, m: big }))
      .toThrow(expect.objectContaining({ httpStatus: 400, code: "INSTANT_GEN_M_INVALID" }));
    expect(() => parseBuildRequest("instant-gen", { ...KEY_OWNER, m: "9".repeat(20) })).not.toThrow();
  });
  it("qua route fund-vault: 20 chữ số qua tầng hình dạng rồi chết ở trần CARP (cổng SAU, mã khác)", async () => {
    const r = await post("/tx/sponsor/fund-vault", { ...FUND_BASE, carp_amount: "9".repeat(20) }, service("Preprod", deploymentJson("Preprod")).svc);
    expect(errCode(r)).toBe("SPONSOR_CARP_ABOVE_CAP");
  });
});
