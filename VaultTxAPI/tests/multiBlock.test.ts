// VaultTxAPI/tests/multiBlock.test.ts — một tiến trình phục vụ NHIỀU khối triển khai (Instant + Schedule).
//
// Bốn phần, mỗi phần gọi đúng hàm mà tiến trình thật gọi:
//   · nạp cấu hình  — `config.ts` ▸ `loadConfig` / `loadExtraBlocks` / `assertCompatibleBlocks`
//   · định tuyến    — `blockRouter.ts` ▸ `VaultBlockRouter` (khối giả, không chuỗi)
//   · `/health`     — `blocks.ts` ▸ `blockRoutingOf` + `http.ts` ▸ `handle`
//   · phần CHUNG    — `blocks.ts` ▸ `makeBlockServices`: khoá mềm + sổ phát-hành dùng chung giữa khối
//
// Mỗi ca dương có cực đối ngay cạnh: một ca chỉ xanh ở một phía thì không phân biệt được "đúng" với
// "không làm gì".

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { credentialToAddress, type UTxO } from "@lucid-evolution/lucid";
import { encodeBindDidRedeemer } from "@magiclamp/consumemagic";
import { beforeAll, describe, expect, it } from "vitest";

import { VaultBlockRouter, type RoutableService } from "../src/blockRouter.js";
import { blockRoutingOf, makeBlockServices } from "../src/blocks.js";
import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import {
  assertCompatibleBlocks, loadConfig, loadExtraBlocks, parseDeployment, type Deployment, type ExtraBlockConfig,
} from "../src/config.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable, PendingSpends, type IssuedRoute } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { txBodyHash } from "../src/summary.js";
import { RecordedTxBuilder, enterpriseAddressOf } from "../src/txBuilder.js";
import { ENGAGE_ADDRESS, ENGAGE_SCRIPT_HASH, engageDatumHex, threadUtxo } from "./fixtures/engage.js";
import {
  LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OWNER_PKH, SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex,
} from "./fixtures/preview.js";
import { buildTxCbor, fakeWitnessSetCbor } from "./fixtures/tx.js";

// ── cấu hình giả ────────────────────────────────────────────────────────────────

const INSTANT_SCRIPT_HASH = "1a".repeat(28);
const INSTANT_ADDRESS = credentialToAddress("Preview", { type: "Script", hash: INSTANT_SCRIPT_HASH });
const INSTANT_ID_UNIT = INSTANT_SCRIPT_HASH + "aa";

function deploymentObj(vaultType: string, address: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: `Preview · ${vaultType} · bản dựng thử của phép kiểm — không phải một lần deploy thật`,
    lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
    vaults: [{ vault_type: vaultType, address }],
    shard_address: SHARD_ADDRESS,
    ref_script_utxos: { vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2` },
    consume: {
      engage_address: ENGAGE_ADDRESS,
      price_beacon_address: VAULT_ADDRESS,
      price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
    },
    ...over,
  };
}
const SCHEDULE_JSON = deploymentObj("Schedule", VAULT_ADDRESS);
const INSTANT_JSON = deploymentObj("Instant", INSTANT_ADDRESS);
const SCHEDULE_DEPLOYMENT: Deployment = parseDeployment(JSON.stringify(SCHEDULE_JSON), "Preview");
const INSTANT_DEPLOYMENT: Deployment = parseDeployment(JSON.stringify(INSTANT_JSON), "Preview");

let dir = "";
let blueprintPath = "";
let badBlueprintPath = "";
const fileOf = (name: string, content: unknown): string => {
  const p = join(dir, name);
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vault-tx-api-multi-"));
  blueprintPath = fileOf("plutus.json", {
    preamble: { compiler: { name: "Aiken", version: "v1.1.21" } },
    validators: [{ title: "vault.vault.spend", compiledCode: "59", hash: "aa".repeat(28) }],
  });
  badBlueprintPath = fileOf("not-blueprint.json", { preamble: {} });
});

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    VAULT_TX_API_NETWORK: "Preview",
    BLOCKFROST_PROJECT_ID: "dummy",
    VAULT_TX_API_DEPLOYMENT: JSON.stringify(SCHEDULE_JSON),
    VAULT_TX_API_CHANGE_ADDRESS_STRATEGY: "enterprise_from_owner_pkh",
    VAULT_TX_API_VAULT_PLUTUS_JSON: blueprintPath,
    ...over,
  };
  for (const [k, v] of Object.entries(base)) if (v === undefined) delete base[k];
  return base as NodeJS.ProcessEnv;
}

const extra = (d: Deployment, file = "extra.json"): ExtraBlockConfig => ({ file, deployment: d, vaultPlutusJsonPath: blueprintPath });

// ── 1. nạp cấu hình ─────────────────────────────────────────────────────────────

describe("cấu hình khối phụ — nạp", () => {
  it("vắng hai biến ⟹ không khối phụ nào (một khối, như trước). CẶP: có biến ⟹ đúng một khối phụ", () => {
    expect(loadConfig(env()).extraBlocks).toEqual([]);
    expect(loadConfig(env({ VAULT_TX_API_EXTRA_DEPLOYMENT_FILES: "", VAULT_TX_API_EXTRA_VAULT_PLUTUS_JSONS: "" })).extraBlocks)
      .toEqual([]);
    const c = loadConfig(env({
      VAULT_TX_API_EXTRA_DEPLOYMENT_FILES: fileOf("instant.json", INSTANT_JSON),
      VAULT_TX_API_EXTRA_VAULT_PLUTUS_JSONS: blueprintPath,
    }));
    expect(c.extraBlocks).toHaveLength(1);
    expect(c.extraBlocks[0]!.deployment.vaults.map(v => v.vaultType)).toEqual(["Instant"]);
    expect(c.extraBlocks[0]!.vaultPlutusJsonPath).toBe(blueprintPath);
    // Khối chính KHÔNG đổi vì có khối phụ.
    expect(c.deployment.vaults.map(v => v.vaultType)).toEqual(["Schedule"]);
  });

  it("hai danh sách lệch độ dài ⟹ ném. CẶP: cùng độ dài ⟹ qua", () => {
    const f = fileOf("instant2.json", INSTANT_JSON);
    expect(() => loadExtraBlocks(f, undefined, "Preview")).toThrow(/ghép theo VỊ TRÍ/);
    expect(() => loadExtraBlocks(undefined, blueprintPath, "Preview")).toThrow(/ghép theo VỊ TRÍ/);
    expect(() => loadExtraBlocks(`${f},${f}`, blueprintPath, "Preview")).toThrow(/2 mục.*1/);
    expect(loadExtraBlocks(f, blueprintPath, "Preview")).toHaveLength(1);
  });

  it("mục rỗng (dấu phẩy thừa) ⟹ ném, không bỏ qua. CẶP: khoảng trắng quanh mục được cắt", () => {
    const f = fileOf("instant3.json", INSTANT_JSON);
    expect(() => loadExtraBlocks(`${f},`, `${blueprintPath},`, "Preview")).toThrow(/RỖNG ở vị trí 1/);
    expect(loadExtraBlocks(` ${f} `, ` ${blueprintPath} `, "Preview")).toHaveLength(1);
  });

  it("tệp khối không đọc được / hỏng / blueprint hỏng ⟹ ném, nêu ĐÚNG khối phụ", () => {
    expect(() => loadExtraBlocks(join(dir, "khong-co.json"), blueprintPath, "Preview"))
      .toThrow(/EXTRA_DEPLOYMENT_FILES\[0\].*không đọc được/);
    expect(() => loadExtraBlocks(fileOf("broken.json", "{ không phải json"), blueprintPath, "Preview"))
      .toThrow(/EXTRA_DEPLOYMENT_FILES\[0\].*không phải JSON hợp lệ/);
    expect(() => loadExtraBlocks(fileOf("instant4.json", INSTANT_JSON), badBlueprintPath, "Preview"))
      .toThrow(/EXTRA_VAULT_PLUTUS_JSONS\[0\].*validators/);
  });
});

describe("cấu hình khối phụ — các điều kiện NÉM (assertCompatibleBlocks)", () => {
  it("hai khối hợp lệ (Schedule + Instant, cùng LAMP, cùng mạng) ⟹ qua", () => {
    expect(() => assertCompatibleBlocks(SCHEDULE_DEPLOYMENT, [extra(INSTANT_DEPLOYMENT)], "Preview")).not.toThrow();
  });

  it("khác mạng — địa chỉ mainnet ⟹ ném lúc đọc khối phụ; nhãn source khai mạng khác ⟹ ném. CẶP: nhãn đúng mạng ⟹ qua", () => {
    // Preview và Preprod cùng `addr_test` + `tLAMP`: nhãn là dấu duy nhất tách hai mạng đó.
    const preprodLabelled = parseDeployment(JSON.stringify({ ...INSTANT_JSON, source: "Preprod · Instant · …" }), "Preview");
    expect(() => assertCompatibleBlocks(SCHEDULE_DEPLOYMENT, [extra(preprodLabelled)], "Preview"))
      .toThrow(/"Preprod" mà VAULT_TX_API_NETWORK=Preview/);
    const previewLabelled = parseDeployment(JSON.stringify({ ...INSTANT_JSON, source: "Preview · Instant · …" }), "Preview");
    expect(() => assertCompatibleBlocks(SCHEDULE_DEPLOYMENT, [extra(previewLabelled)], "Preview")).not.toThrow();
    // Mainnet ⟹ tiền tố địa chỉ sai, `parseDeployment` ném; câu lỗi gắn tên khối phụ.
    const mainnetAddr = credentialToAddress("Mainnet", { type: "Script", hash: INSTANT_SCRIPT_HASH });
    const f = fileOf("mainnet.json", { ...INSTANT_JSON, vaults: [{ vault_type: "Instant", address: mainnetAddr }] });
    expect(() => loadExtraBlocks(f, blueprintPath, "Preview")).toThrow(/EXTRA_DEPLOYMENT_FILES\[0\].*tiền tố/);
  });

  it("khác tài sản LAMP ⟹ ném. CẶP: cùng LAMP ⟹ qua (ca hợp lệ ở trên)", () => {
    const otherLamp = { ...INSTANT_DEPLOYMENT, lampPolicyId: "f2".repeat(28) };
    expect(() => assertCompatibleBlocks(SCHEDULE_DEPLOYMENT, [extra(otherLamp)], "Preview"))
      .toThrow(/MỘT tài sản LAMP/);
    const otherName = { ...INSTANT_DEPLOYMENT, lampAssetNameHex: "4c414d50" };
    expect(() => assertCompatibleBlocks(SCHEDULE_DEPLOYMENT, [extra(otherName)], "Preview"))
      .toThrow(/MỘT tài sản LAMP/);
  });

  it("hai khối cùng vault_type ⟹ ném. CẶP: khác loại ⟹ qua", () => {
    const secondSchedule = parseDeployment(JSON.stringify(deploymentObj("Schedule", INSTANT_ADDRESS)), "Preview");
    expect(() => assertCompatibleBlocks(SCHEDULE_DEPLOYMENT, [extra(secondSchedule)], "Preview"))
      .toThrow(/két "Schedule" mà khối chính cũng phục vụ/);
    // Trùng giữa HAI khối phụ cũng bị bắt, không chỉ trùng với khối chính.
    expect(() => assertCompatibleBlocks(SCHEDULE_DEPLOYMENT, [extra(INSTANT_DEPLOYMENT), extra(INSTANT_DEPLOYMENT)], "Preview"))
      .toThrow(/két "Instant" mà VAULT_TX_API_EXTRA_DEPLOYMENT_FILES\[0\] cũng phục vụ/);
  });

  it("khối phụ là Prepaid ⟹ ném; khối chính Prepaid mà có khối phụ ⟹ ném. CẶP: khối chính Prepaid đứng MỘT mình ⟹ qua", () => {
    const asPrepaid = (d: Deployment): Deployment => ({ ...d, vaults: d.vaults.map(v => ({ ...v, vaultType: "Prepaid" })) });
    expect(() => assertCompatibleBlocks(SCHEDULE_DEPLOYMENT, [extra(asPrepaid(INSTANT_DEPLOYMENT))], "Preview"))
      .toThrow(/két "Prepaid" — két Prepaid chỉ chạy/);
    expect(() => assertCompatibleBlocks(asPrepaid(SCHEDULE_DEPLOYMENT), [extra(INSTANT_DEPLOYMENT)], "Preview"))
      .toThrow(/khối chính phục vụ két "Prepaid" mà có khối phụ/);
    expect(() => assertCompatibleBlocks(asPrepaid(SCHEDULE_DEPLOYMENT), [], "Preview")).not.toThrow();
  });

  it("khác did_stake ⟹ ném (nhân chứng chủ là MỘT). CẶP: cùng did_stake ⟹ qua", () => {
    const ds = { anchorNftPolicy: "ab".repeat(28) };
    expect(() => assertCompatibleBlocks({ ...SCHEDULE_DEPLOYMENT, didStake: ds }, [extra(INSTANT_DEPLOYMENT)], "Preview"))
      .toThrow(/did_stake khác khối chính/);
    expect(() => assertCompatibleBlocks(
      { ...SCHEDULE_DEPLOYMENT, didStake: ds }, [extra({ ...INSTANT_DEPLOYMENT, didStake: { ...ds } })], "Preview",
    )).not.toThrow();
  });

  it("khối phụ khai feecover ⟹ ném (proxy phí đọc từ khối chính). CẶP: khối chính khai feecover ⟹ qua", () => {
    const fc = { url: "https://fee.invalid", timeoutMs: 1_000, apps: new Map() };
    expect(() => assertCompatibleBlocks(SCHEDULE_DEPLOYMENT, [extra({ ...INSTANT_DEPLOYMENT, feecover: fc })], "Preview"))
      .toThrow(/khai feecover/);
    expect(() => assertCompatibleBlocks({ ...SCHEDULE_DEPLOYMENT, feecover: fc }, [extra(INSTANT_DEPLOYMENT)], "Preview"))
      .not.toThrow();
  });

  it("loadConfig chạy cổng tương thích: khối phụ trùng loại với khối chính ⟹ khởi động THẤT BẠI", () => {
    expect(() => loadConfig(env({
      VAULT_TX_API_EXTRA_DEPLOYMENT_FILES: fileOf("dup.json", deploymentObj("Schedule", INSTANT_ADDRESS)),
      VAULT_TX_API_EXTRA_VAULT_PLUTUS_JSONS: blueprintPath,
    }))).toThrow(/mỗi loại két/);
  });
});

// ── 2. định tuyến ───────────────────────────────────────────────────────────────

interface FakeBlock extends RoutableService { name: string; lookups: number }
const fake = (name: string, types: string[], has: boolean): FakeBlock => {
  const b: FakeBlock = {
    name, vaultTypes: types, lookups: 0,
    hasVaultOf: async () => { b.lookups++; return has; },
  };
  return b;
};
const KEY_OWNER = { type: "key" as const, hash: OWNER_PKH };
const codeOf = async (p: Promise<unknown>): Promise<{ httpStatus: number; code: string; details: Record<string, unknown> }> => {
  try { await p; } catch (e) { return e as { httpStatus: number; code: string; details: Record<string, unknown> }; }
  throw new Error("chờ ném, mà không ném");
};

describe("VaultBlockRouter — đường có loại két cố định", () => {
  const I = fake("I", ["Instant"], false);
  const S = fake("S", ["Schedule"], false);
  const r = new VaultBlockRouter([I, S]);

  it("create-vault theo kind: instant → Instant, schedule → Schedule", async () => {
    expect((await r.serviceFor("create-vault", { kind: "instant" })).name).toBe("I");
    expect((await r.serviceFor("create-vault", { kind: "schedule" })).name).toBe("S");
  });

  it("instant-gen + refresh-checkpoint → Instant; schedule-commit + schedule-fire → Schedule (khối chính là Schedule cũng không đổi)", async () => {
    const r2 = new VaultBlockRouter([S, I]);
    for (const router of [r, r2]) {
      expect((await router.serviceFor("instant-gen", {})).name).toBe("I");
      expect((await router.serviceFor("refresh-checkpoint", {})).name).toBe("I");
      expect((await router.serviceFor("schedule-commit", {})).name).toBe("S");
      expect((await router.serviceFor("schedule-fire", {})).name).toBe("S");
    }
    expect(I.lookups + S.lookups).toBe(0);
  });

  it("vault_type trái với loại của đường ⟹ 400 VAULT_TYPE_ROUTE_CONFLICT. CẶP: trùng loại ⟹ qua", async () => {
    expect(await codeOf(r.serviceFor("schedule-commit", { vault_type: "Instant" })))
      .toMatchObject({ httpStatus: 400, code: "VAULT_TYPE_ROUTE_CONFLICT" });
    expect(await codeOf(r.serviceFor("create-vault", { kind: "instant", vault_type: "Schedule" })))
      .toMatchObject({ httpStatus: 400, code: "VAULT_TYPE_ROUTE_CONFLICT" });
    expect((await r.serviceFor("schedule-commit", { vault_type: "Schedule" })).name).toBe("S");
  });

  it("nhiều khối mà loại của đường không khối nào phục vụ ⟹ 400 VAULT_TYPE_NOT_SERVED. CẶP: MỘT khối ⟹ khối đó (dịch vụ trả lỗi scopesFor như trước)", async () => {
    const onlyI = new VaultBlockRouter([I, fake("P", ["Other"], false)]);
    expect(await codeOf(onlyI.serviceFor("schedule-commit", {})))
      .toMatchObject({ httpStatus: 400, code: "VAULT_TYPE_NOT_SERVED", details: { vault_type: "Schedule", configured: ["Instant", "Other"] } });
    expect((await new VaultBlockRouter([I]).serviceFor("schedule-commit", {})).name).toBe("I");
  });
});

describe("VaultBlockRouter — consume / open-thread / bind-did", () => {
  const ROUTES: IssuedRoute[] = ["consume", "open-thread", "bind-did"];

  it("vault_type có ⟹ đi thẳng khối đó, KHÔNG tra chuỗi", async () => {
    const I = fake("I", ["Instant"], true);
    const S = fake("S", ["Schedule"], true);
    const r = new VaultBlockRouter([I, S]);
    for (const route of ROUTES) {
      expect((await r.serviceFor(route, { owner: KEY_OWNER, vault_type: "Schedule" })).name).toBe("S");
      expect((await r.serviceFor(route, { owner: KEY_OWNER, vault_type: "Instant" })).name).toBe("I");
    }
    expect(I.lookups + S.lookups).toBe(0);
  });

  it("vault_type mà không khối nào phục vụ ⟹ 400 VAULT_TYPE_NOT_SERVED (cả khi chỉ một khối)", async () => {
    const r = new VaultBlockRouter([fake("I", ["Instant"], true)]);
    for (const route of ROUTES) {
      expect(await codeOf(r.serviceFor(route, { owner: KEY_OWNER, vault_type: "Schedule" })))
        .toMatchObject({ httpStatus: 400, code: "VAULT_TYPE_NOT_SERVED", details: { vault_type: "Schedule", configured: ["Instant"] } });
    }
  });

  it("vault_type sai giá trị ⟹ 400 VAULT_TYPE_INVALID (\"Prepaid\", số, null)", async () => {
    const r = new VaultBlockRouter([fake("I", ["Instant"], true), fake("S", ["Schedule"], true)]);
    for (const bad of ["Prepaid", "instant", 1, null]) {
      expect(await codeOf(r.serviceFor("consume", { owner: KEY_OWNER, vault_type: bad })))
        .toMatchObject({ httpStatus: 400, code: "VAULT_TYPE_INVALID" });
    }
  });

  it("vắng vault_type, MỘT khối ⟹ khối đó, không tra chuỗi", async () => {
    const I = fake("I", ["Instant"], false);
    const r = new VaultBlockRouter([I]);
    for (const route of ROUTES) expect((await r.serviceFor(route, { owner: KEY_OWNER })).name).toBe("I");
    expect(I.lookups).toBe(0);
  });

  it("vắng vault_type, nhiều khối: đúng một khối có két ⟹ khối đó — CẢ HAI chiều (két ở khối phụ, két ở khối chính)", async () => {
    for (const route of ROUTES) {
      const viaExtra = new VaultBlockRouter([fake("I", ["Instant"], false), fake("S", ["Schedule"], true)]);
      expect((await viaExtra.serviceFor(route, { owner: KEY_OWNER })).name).toBe("S");
      const viaPrimary = new VaultBlockRouter([fake("I", ["Instant"], true), fake("S", ["Schedule"], false)]);
      expect((await viaPrimary.serviceFor(route, { owner: KEY_OWNER })).name).toBe("I");
    }
  });

  it("vắng vault_type, nhiều khối, không khối nào có két ⟹ khối CHÍNH", async () => {
    const r = new VaultBlockRouter([fake("S", ["Schedule"], false), fake("I", ["Instant"], false)]);
    for (const route of ROUTES) expect((await r.serviceFor(route, { owner: KEY_OWNER })).name).toBe("S");
  });

  it("vắng vault_type, nhiều khối có két ⟹ 409 VAULT_TYPE_AMBIGUOUS, details kê các loại có két", async () => {
    const r = new VaultBlockRouter([fake("I", ["Instant"], true), fake("S", ["Schedule"], true)]);
    for (const route of ROUTES) {
      const e = await codeOf(r.serviceFor(route, { owner: KEY_OWNER }));
      expect(e).toMatchObject({ httpStatus: 409, code: "VAULT_TYPE_AMBIGUOUS", details: { vault_types: ["Instant", "Schedule"] } });
      expect((e as unknown as Error).message).toMatch(/vault_type/);
    }
  });

  it("chủ hỏng hình dạng khi phải tra ⟹ 400 của bộ đọc chủ, không tra chuỗi", async () => {
    const I = fake("I", ["Instant"], true);
    const r = new VaultBlockRouter([I, fake("S", ["Schedule"], true)]);
    await expect(r.serviceFor("consume", { owner: { type: "key", hash: "zz" } })).rejects.toMatchObject({ httpStatus: 400 });
    expect(I.lookups).toBe(0);
  });

  it("/tx/quote: `vault_type` trong `params` quyết khối; thân bài hỏng ⟹ khối chính (để quoteFee trả 400 của nó)", async () => {
    const r = new VaultBlockRouter([fake("I", ["Instant"], true), fake("S", ["Schedule"], true)]);
    expect((await r.serviceForQuote({ route: "consume", params: { owner: KEY_OWNER, vault_type: "Schedule" } })).name).toBe("S");
    expect((await r.serviceForQuote({ route: "schedule-fire", params: {} })).name).toBe("S");
    expect((await r.serviceForQuote({ route: "khong-co", params: {} })).name).toBe("I");
    expect((await r.serviceForQuote({ route: "consume", params: [] })).name).toBe("I");
    expect(await codeOf(r.serviceForQuote({ route: "consume", params: { owner: KEY_OWNER } })))
      .toMatchObject({ code: "VAULT_TYPE_AMBIGUOUS" });
  });
});

// ── 3 + 4. dịch vụ thật trên hai khối: /health, khoá chung, nộp chung ───────────

const TTL = 180_000;
const NOW = 1_789_100_703_000;
const TIP: ChainTip = { blockHeight: 1, blockHash: "14".repeat(32), blockTimePosixMs: BigInt(NOW) };
const CHANGE_ADDRESS = enterpriseAddressOf("Preview", OWNER_PKH);
const DID = "d1".repeat(32);
const THREAD_TX = "7e".repeat(32);
const THREAD_UNIT = ENGAGE_SCRIPT_HASH + "01";
const UNBOUND = threadUtxo(KEY_OWNER, THREAD_TX, 0, "01", engageDatumHex(KEY_OWNER, { didCommit: "" }));

/** Tx BindDID "đúng" (như `bindDid.test.ts`); `fee` khác nhau ⟹ hash khác nhau giữa hai khối. */
function bindTx(fee: bigint): string {
  return buildTxCbor({
    inputs: [{ txHash: THREAD_TX, outputIndex: 0 }, { txHash: "c0".repeat(32), outputIndex: 0 }],
    feeLovelace: fee,
    outputs: [
      {
        address: ENGAGE_ADDRESS,
        assets: { lovelace: 2_000_000n, [THREAD_UNIT]: 1n },
        inlineDatumHex: engageDatumHex(KEY_OWNER, { didCommit: DID }),
      },
      { address: CHANGE_ADDRESS, assets: { lovelace: 7_810_000n } },
    ],
    requiredSigners: [OWNER_PKH],
    spendRedeemers: [{ index: 0, dataHex: encodeBindDidRedeemer() }],
  });
}
const T_INSTANT = bindTx(190_000n);
const T_SCHEDULE = bindTx(191_000n);

const vaultAt = (address: string, idUnit: string, txHash: string): UTxO => ({
  txHash, outputIndex: 0, address,
  assets: { lovelace: 5_000_000n, [LAMP_UNIT]: 1_000_000n, [idUnit]: 1n },
  datum: datumHex(),
});

/** Hai khối dựng bằng ĐÚNG `makeBlockServices` + `blockRoutingOf` mà `server.ts` gọi. */
function twoBlocks(opts: { submitResult?: string; vaults?: { instant: boolean; schedule: boolean } } = {}) {
  const v = opts.vaults ?? { instant: true, schedule: true };
  const chain = new RecordedChainReader({
    [ENGAGE_ADDRESS]: [UNBOUND],
    [INSTANT_ADDRESS]: v.instant ? [vaultAt(INSTANT_ADDRESS, INSTANT_ID_UNIT, "a1".repeat(32))] : [],
    [VAULT_ADDRESS]: v.schedule ? [vaultAt(VAULT_ADDRESS, VAULT_ID_UNIT, "a2".repeat(32))] : [],
  }, TIP, [], undefined, opts.submitResult);
  const instantBuilder = new RecordedTxBuilder({ bind_did: T_INSTANT });
  const scheduleBuilder = new RecordedTxBuilder({ bind_did: T_SCHEDULE });
  const locks = new OwnerLockTable(TTL);
  const issued = new IssuedTxRegistry(TTL * 4);
  const services = makeBlockServices([
    { deployment: INSTANT_DEPLOYMENT, builder: instantBuilder },
    { deployment: SCHEDULE_DEPLOYMENT, builder: scheduleBuilder },
  ], { network: "Preview", chain, locks, issued, pending: new PendingSpends(TTL), lockTtlMs: TTL, now: () => NOW });
  const router: RouterDeps = {
    ...blockRoutingOf(services),
    network: "Preview", chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh",
    token: "", logInternal: () => {}, now: () => NOW,
  };
  return { chain, locks, issued, instantBuilder, scheduleBuilder, router };
}

const post = (url: string, body: unknown) => ({ method: "POST", url, headers: {}, body });
const bodyOf = (r: { body: unknown }) => r.body as Record<string, unknown> & { error?: { code: string; details: Record<string, unknown> } };

describe("/health với hai khối", () => {
  it("vault_scopes là HỢP (khối chính trước); deployment_source = nhãn khối CHÍNH; deployment_sources = mọi khối", async () => {
    const h = twoBlocks();
    const r = await handle({ method: "GET", url: "/health", headers: {} }, h.router);
    expect(r.status).toBe(200);
    const b = bodyOf(r);
    expect((b.vault_scopes as { vault_type: string }[]).map(s => s.vault_type)).toEqual(["Instant", "Schedule"]);
    expect(b.deployment_source).toBe(INSTANT_DEPLOYMENT.source);
    expect(b.deployment_sources).toEqual([INSTANT_DEPLOYMENT.source, SCHEDULE_DEPLOYMENT.source]);
    expect(b.lamp).toEqual({ policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX });
  });

  it("CẶP: một khối ⟹ chỉ loại của khối đó, deployment_sources một phần tử", async () => {
    const chain = new RecordedChainReader({}, TIP, []);
    const one = makeBlockServices([{ deployment: INSTANT_DEPLOYMENT, builder: new RecordedTxBuilder({}) }],
      { network: "Preview", chain, locks: new OwnerLockTable(TTL), issued: new IssuedTxRegistry(TTL), lockTtlMs: TTL });
    const r = await handle({ method: "GET", url: "/health", headers: {} }, {
      ...blockRoutingOf(one), network: "Preview", chainLabel: "recorded",
      changeAddressStrategy: "enterprise_from_owner_pkh", token: "", logInternal: () => {},
    });
    const b = bodyOf(r);
    expect((b.vault_scopes as { vault_type: string }[]).map(s => s.vault_type)).toEqual(["Instant"]);
    expect(b.deployment_sources).toEqual([INSTANT_DEPLOYMENT.source]);
  });
});

describe("định tuyến qua HTTP trên dịch vụ thật", () => {
  it("bind-did vắng vault_type, chủ có két ở CẢ HAI khối ⟹ 409 VAULT_TYPE_AMBIGUOUS, không bộ dựng nào bị gọi", async () => {
    const h = twoBlocks();
    const r = await handle(post("/tx/bind-did", { owner: KEY_OWNER, did_commit: DID }), h.router);
    expect(r.status).toBe(409);
    expect(bodyOf(r).error).toMatchObject({ code: "VAULT_TYPE_AMBIGUOUS", details: { vault_types: ["Instant", "Schedule"] } });
    expect(h.instantBuilder.lastCall).toBeNull();
    expect(h.scheduleBuilder.lastCall).toBeNull();
  });

  it("bind-did vắng vault_type, chủ chỉ có két Schedule ⟹ đi khối Schedule (khối PHỤ). CẶP: chỉ có két Instant ⟹ khối chính", async () => {
    const onlyS = twoBlocks({ vaults: { instant: false, schedule: true } });
    expect((await handle(post("/tx/bind-did", { owner: KEY_OWNER, did_commit: DID }), onlyS.router)).status).toBe(200);
    expect(onlyS.scheduleBuilder.lastCall?.route).toBe("bind_did");
    expect(onlyS.instantBuilder.lastCall).toBeNull();
    const onlyI = twoBlocks({ vaults: { instant: true, schedule: false } });
    expect((await handle(post("/tx/bind-did", { owner: KEY_OWNER, did_commit: DID }), onlyI.router)).status).toBe(200);
    expect(onlyI.instantBuilder.lastCall?.route).toBe("bind_did");
    expect(onlyI.scheduleBuilder.lastCall).toBeNull();
  });

  it("/tx/quote đi qua bộ định tuyến: `params` vắng vault_type, két ở cả hai khối ⟹ 409 VAULT_TYPE_AMBIGUOUS. CẶP: có vault_type ⟹ không còn 409 đó", async () => {
    const h = twoBlocks();
    const amb = await handle(post("/tx/quote", { route: "bind-did", params: { owner: KEY_OWNER, did_commit: DID } }), h.router);
    expect(amb.status).toBe(409);
    expect(bodyOf(amb).error?.code).toBe("VAULT_TYPE_AMBIGUOUS");
    const picked = await handle(post("/tx/quote", {
      route: "bind-did", params: { owner: KEY_OWNER, did_commit: DID, vault_type: "Schedule" },
    }), h.router);
    expect(bodyOf(picked).error?.code).not.toBe("VAULT_TYPE_AMBIGUOUS");
  });

  it("tx dựng ở khối Schedule, nộp qua /tx/submit chung (khối chính) ⟹ thành công", async () => {
    const h = twoBlocks({ submitResult: txBodyHash(T_SCHEDULE) });
    const built = await handle(post("/tx/bind-did", { owner: KEY_OWNER, did_commit: DID, vault_type: "Schedule" }), h.router);
    expect(built.status).toBe(200);
    expect(h.scheduleBuilder.lastCall?.route).toBe("bind_did");
    const sub = await handle(post("/tx/submit", { tx_cbor: T_SCHEDULE, witness_cbor: fakeWitnessSetCbor() }), h.router);
    expect(sub.status).toBe(200);
    expect(h.chain.submitted).toHaveLength(1);
  });

  it("CẶP: hai khối mà sổ phát-hành RIÊNG ⟹ cùng tx đó bị /tx/submit của khối chính từ chối (bài trên đo được sự dùng chung)", async () => {
    const chain = new RecordedChainReader({ [ENGAGE_ADDRESS]: [UNBOUND] }, TIP, [], undefined, txBodyHash(T_SCHEDULE));
    const locks = new OwnerLockTable(TTL);
    const mk = (d: Deployment, cbor: string) => new VaultTxService({
      network: "Preview", deployment: d, chain, builder: new RecordedTxBuilder({ bind_did: cbor }),
      locks, issued: new IssuedTxRegistry(TTL * 4), lockTtlMs: TTL, now: () => NOW,
    });
    const primary = mk(INSTANT_DEPLOYMENT, T_INSTANT);
    const schedule = mk(SCHEDULE_DEPLOYMENT, T_SCHEDULE);
    await schedule.bindDid({ owner: KEY_OWNER, didCommit: DID });
    await expect(primary.submit({ txCbor: T_SCHEDULE, witnessCbor: fakeWitnessSetCbor() }))
      .rejects.toMatchObject({ code: "SUBMIT_REJECTED" });
    expect(chain.submitted).toHaveLength(0);
  });
});

describe("khoá mềm theo chủ DÙNG CHUNG giữa hai khối", () => {
  it("lượt dựng ở khối Schedule THAY lượt dựng ở khối Instant của cùng chủ — đúng như hai lượt cùng khối", async () => {
    const h = twoBlocks({ submitResult: txBodyHash(T_SCHEDULE) });
    const a = await handle(post("/tx/bind-did", { owner: KEY_OWNER, did_commit: DID, vault_type: "Instant" }), h.router);
    expect(a.status).toBe(200);
    expect(h.locks.peek(OWNER_PKH, NOW)?.txHash).toBe(txBodyHash(T_INSTANT));
    const b = await handle(post("/tx/bind-did", { owner: KEY_OWNER, did_commit: DID, vault_type: "Schedule" }), h.router);
    expect(b.status).toBe(200);
    // Khoá của chủ giờ trỏ tx của khối Schedule: lượt sau đã thay lượt trước dù khác khối.
    expect(h.locks.peek(OWNER_PKH, NOW)?.txHash).toBe(txBodyHash(T_SCHEDULE));
    // Nộp tx khối Schedule ⟹ tx khối Instant của cùng chủ bị đánh dấu THAY; nộp nó ⟹ 409.
    expect((await handle(post("/tx/submit", { tx_cbor: T_SCHEDULE, witness_cbor: fakeWitnessSetCbor() }), h.router)).status).toBe(200);
    const stale = await handle(post("/tx/submit", { tx_cbor: T_INSTANT, witness_cbor: fakeWitnessSetCbor() }), h.router);
    expect(stale.status).toBe(409);
    expect(bodyOf(stale).error).toMatchObject({ code: "TX_SUPERSEDED", details: { superseded_by: txBodyHash(T_SCHEDULE) } });
    expect(h.chain.submitted).toHaveLength(1);
  });
});
