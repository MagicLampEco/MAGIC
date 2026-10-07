// VaultTxAPI/tests/feeProxy.test.ts — proxy Feecover (`feeProxy.ts`), mỗi cổng một CẶP ca.
//
// Feecover là bộ giả tiêm vào (`FetchLike`): không lượt nào gọi mạng thật. Bộ giả GHI mọi lượt
// gọi, nên các ca âm kiểm được cả điều quan trọng nhất của một cổng chặn: nó chặn TRƯỚC khi
// token rời dịch vụ.

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  credentialToAddress, scriptHashToCredential, unixTimeToSlot, validatorToScriptHash, type UTxO,
} from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";

import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { loadConfig, parseDeployment, resolveFeecoverAppToken, type Deployment } from "../src/config.js";
import { FeeProxy, type FetchLike } from "../src/feeProxy.js";
import { FUNDING_FEE_PAYER_CODES, parseFeePayerShape } from "../src/feePayer.js";
import { ChainDidPaymentAnchorReader, FUNDING_COLLATERAL_CODES } from "../src/funding.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { txBodyHash } from "../src/summary.js";
import { CLOCK_SKEW_MARGIN_MS } from "../src/validity.js";
import { RecordedTxBuilder, enterpriseAddressOf } from "../src/txBuilder.js";
import { ENGAGE_ADDRESS, threadUtxo } from "./fixtures/engage.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex,
} from "./fixtures/preview.js";
import { buildTxCbor, type TxOutputSpec } from "./fixtures/tx.js";
import { withConsumeLeg } from "./fixtures/consume.js";
import { GEN_V2_REF_SCRIPTS, genV2Chain, genV2Json } from "./fixtures/genV2.js";

const TTL = 180_000;
/** Hạn dòng sổ phát-hành = `validTo` của CHÍNH tx (ttl fixture: NOW + 10 phút) + biên lệch đồng hồ
 *  (`src/validity.ts`), không còn là `4 × lock_ttl`. */
const REGISTRY_TTL = 600_000 + CLOCK_SKEW_MARGIN_MS;
const NOW = 1_789_100_703_000;
const TIP: ChainTip = { blockHeight: 1, blockHash: "14".repeat(32), blockTimePosixMs: BigInt(NOW) };
const KEY_OWNER = { type: "key" as const, hash: OWNER_PKH };
const CHANGE_ADDRESS = enterpriseAddressOf("Preview", OWNER_PKH);
const FEE_ADDRESS = enterpriseAddressOf("Preview", "fe".repeat(28));

// Token giả — chỉ để quét rò rỉ, không phải token thật của hệ nào.
const MAGIC_TOKEN = "magic-app-token-for-tests-" + "q".repeat(24);
const ORILIFE_TOKEN = "orilife-app-token-for-tests-" + "z".repeat(20);
const ALADIN_TOKEN = "aladin-app-token-for-tests-" + "w".repeat(20);
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

const utxo = (txHash: string, outputIndex: number, address: string, assets: Record<string, bigint>, datum?: string): UTxO =>
  ({ txHash, outputIndex, address, assets, datum }) as UTxO;
const ref = (u: { txHash: string; outputIndex: number }) => ({ txHash: u.txHash, outputIndex: u.outputIndex });

const FEECOVER_BLOCK = {
  url: "https://feecover.example/",
  timeout_ms: 200,
  apps: {
    magic: { purposes: {
      "create-vault": "create_vault", consume: "consume_magic",
      // Cố ý SAI: mục đích của ứng dụng khác — ca 403 FEE_PROXY_APP_PURPOSE.
      "schedule-commit": "orilife_consume_magic",
      "sponsor-t1-open": "sponsor_open",
    } },
    orilife: { token_sha256: sha(ORILIFE_TOKEN), purposes: { consume: "orilife_consume_magic" } },
    // Cố ý SAI: ứng dụng khác `magic` mà mục đích không mang tiền tố tên mình.
    aladinwork: { token_sha256: sha(ALADIN_TOKEN), purposes: { consume: "consume_magic" } },
  },
};

function deploymentObj(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "Preview, bản dựng thử của phép kiểm — không phải một lần deploy thật",
    lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
    vaults: [{ vault_type: "Schedule", address: VAULT_ADDRESS }],
    shard_address: SHARD_ADDRESS,
    ref_script_utxos: {
      vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2`,
      ...GEN_V2_REF_SCRIPTS,
    },
    gen_v2: genV2Json("Preview"),
    consume: {
      engage_address: ENGAGE_ADDRESS,
      price_beacon_address: VAULT_ADDRESS,
      price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
    },
    feecover: FEECOVER_BLOCK,
    ...over,
  };
}
const DEPLOYMENT: Deployment = parseDeployment(JSON.stringify(deploymentObj()), "Preview");

// ── tx tiêu MAGIC có ví trả phí (khuôn `engageFeePayer.test.ts`) ─────────────

const CONSUME_FEE = 178_000n;
// Lô MAGIC sống của két: tx tiêu đốt `CONSUME_BURN` từ lô này (`consumed_credit` tăng đúng bấy
// nhiêu) — `/tx/consume` đọc lại Σburns == required từ CBOR (`fixtures/consume.ts`). Các route
// khác giữ nguyên lô ⟹ kế toán MAGIC của chúng không đổi.
const FEE_BATCH = { id: "fb".repeat(16), createdEpoch: 20_707n, amountNanogic: 5_000_000_000n };
const CONSUME_BURN = 1_000_000_000n;
const vaultOutMagic = (consume: boolean) => consume
  ? { batches: [{ ...FEE_BATCH, amountNanogic: FEE_BATCH.amountNanogic - CONSUME_BURN }], consumedCreditNanogic: CONSUME_BURN }
  : { batches: [FEE_BATCH] };
const VAULT_UTXO = utxo(INPUT_TX_HASH, 0, VAULT_ADDRESS,
  { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n }, datumHex({ lampLockedOildrop: 2_000_000n, batches: [FEE_BATCH] }));
const FEE_UTXO = utxo("fa".repeat(32), 0, FEE_ADDRESS, { lovelace: 10_000_000n });

/** `consume` ⟹ tx tiêu MAGIC thật (két đốt + vế thread); không ⟹ cùng khung cho schedule-commit. */
function consumeTx(consume = false, ttlMs = 600_000): string {
  const outputs: TxOutputSpec[] = [
    {
      address: VAULT_ADDRESS,
      assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
      inlineDatumHex: datumHex({ lampLockedOildrop: 23_000_000n, genScheduleCount: 1, ...vaultOutMagic(consume) }),
    },
    { address: FEE_ADDRESS, assets: { lovelace: 10_000_000n - CONSUME_FEE } },
  ];
  const spec = {
    inputs: [ref(VAULT_UTXO), ref(FEE_UTXO)],
    feeLovelace: CONSUME_FEE,
    outputs,
    requiredSigners: [OWNER_PKH],
    collateralInputs: [ref(FEE_UTXO)],
    collateralReturn: { address: FEE_ADDRESS, assets: { lovelace: 7_000_000n } },
    ttlSlot: BigInt(unixTimeToSlot("Preview", NOW + ttlMs)),
  };
  return buildTxCbor(!consume ? spec : withConsumeLeg(spec, {
    thread: threadUtxo(KEY_OWNER, "7e".repeat(32)), vaultRef: ref(VAULT_UTXO),
    pairs: [{ opType: 1, opCount: 2n }], requiredNanogic: CONSUME_BURN,
  }));
}

// ── tx tạo vault nạp từ ví Phoenix (khuôn `funding.test.ts`) ─────────────────

const CV_FEE = 190_000n;
const DEPOSIT = 1_001_000_000n;
const CTRL = "c1".repeat(28);
const DEV = "d1".repeat(28);
const DP_SCRIPT = "4746010000222220";
const DP_ADDRESS = credentialToAddress("Preview",
  scriptHashToCredential(validatorToScriptHash({ type: "PlutusV3", script: DP_SCRIPT })));
const ANCHOR_POLICY = "a0".repeat(28);
const ANCHOR = utxo("ab".repeat(32), 0, DP_ADDRESS, { lovelace: 2_000_000n, [`${ANCHOR_POLICY}${"01".repeat(32)}`]: 1n });
const DP1 = utxo("d1".repeat(32), 0, DP_ADDRESS, { lovelace: 3_000_000n, [LAMP_UNIT]: 600_000_000n });
const DP2 = utxo("d2".repeat(32), 1, DP_ADDRESS, { lovelace: 4_000_000n, [LAMP_UNIT]: 500_000_000n });

function fundedTx(): string {
  return buildTxCbor({
    inputs: [ref(FEE_UTXO), ref(DP1), ref(DP2)],
    feeLovelace: CV_FEE,
    mint: { [VAULT_ID_UNIT]: 1n },
    requiredSigners: [OWNER_PKH, CTRL, DEV],
    outputs: [
      {
        address: VAULT_ADDRESS,
        assets: { lovelace: 5_000_000n, [LAMP_UNIT]: DEPOSIT, [VAULT_ID_UNIT]: 1n },
        inlineDatumHex: datumHex({ owner: KEY_OWNER, lampBalanceOildrop: DEPOSIT, lampLockedOildrop: 0n }),
      },
      // Ví trả phí ứng min-ADA két (5 ADA); did_payment chỉ góp LAMP, lovelace về lại trọn (3 + 4 ADA).
      { address: DP_ADDRESS, assets: { lovelace: 7_000_000n, [LAMP_UNIT]: 99_000_000n } },
      { address: FEE_ADDRESS, assets: { lovelace: 10_000_000n - CV_FEE - 5_000_000n } },
    ],
    collateralInputs: [ref(FEE_UTXO)],
    collateralReturn: { address: FEE_ADDRESS, assets: { lovelace: 7_000_000n } },
    spendRedeemers: [{ index: 0, dataHex: "d87980" }, { index: 1, dataHex: "d87980" }],
    ttlSlot: BigInt(unixTimeToSlot("Preview", NOW + 600_000)),
  });
}

const FEE_PAYER = { utxo: `${FEE_UTXO.txHash}#0`, address: FEE_ADDRESS };
const FUNDING = {
  type: "did_payment",
  did_payment_script_cbor: DP_SCRIPT,
  address: DP_ADDRESS,
  fee_payer: FEE_PAYER,
  anchor_ref: `${ANCHOR.txHash}#0`,
  controller_pkh: CTRL,
  device_key_hash: DEV,
};

// ── Feecover giả ─────────────────────────────────────────────────────────────

type Reply = { status: number; body: unknown } | "throw" | "hang";
interface Call { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> }

const utxoReply = (reservedUntilMs: number): Reply => ({
  status: 200,
  body: {
    address: FEE_ADDRESS,
    utxo: { txHash: FEE_UTXO.txHash, outputIndex: 0, lovelace: "10000000" },
    reserved_until: new Date(reservedUntilMs).toISOString(),
  },
});
/** Mặc định: ký đúng tx được gửi. */
const echoSign = (b: Record<string, unknown>): Reply => ({
  status: 200,
  body: { txHash: txBodyHash(b.tx_cbor_hex as string), witnessSet: "a100", netLovelace: "178000", feeLovelace: "178000" },
});

function fakeFeecover(r: { utxo?: Reply; sign?: Reply | ((b: Record<string, unknown>) => Reply) } = {}) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, method: init.method, headers: init.headers, body });
    let reply = url.includes("/v1/utxo") ? (r.utxo ?? utxoReply(NOW + 600_000)) : (r.sign ?? echoSign);
    if (typeof reply === "function") reply = reply(body!);
    if (reply === "throw") throw new TypeError("fetch failed");
    if (reply === "hang") {
      return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    }
    const rr = reply;
    return { status: rr.status, text: async () => (typeof rr.body === "string" ? rr.body : JSON.stringify(rr.body)) };
  };
  return { fetch, calls };
}

// ── khung ────────────────────────────────────────────────────────────────────

function harness(opts: { feecover?: ReturnType<typeof fakeFeecover>; proxy?: boolean; consumeTtlMs?: number } = {}) {
  const clock = { t: NOW };
  const chain = new RecordedChainReader(
    { [VAULT_ADDRESS]: [VAULT_UTXO], [ENGAGE_ADDRESS]: [threadUtxo(KEY_OWNER, "7e".repeat(32))], [DP_ADDRESS]: [DP1, DP2], ...genV2Chain("Preview", { epoch: 20_707n }) },
    TIP,
    // Thread của lượt tiêu là INPUT của tx ⟹ phép đọc lại ví trả phí tra nó theo tham chiếu.
    [VAULT_UTXO, FEE_UTXO, ANCHOR, threadUtxo(KEY_OWNER, "7e".repeat(32))],
  );
  const builder = new RecordedTxBuilder({ consume: consumeTx(true, opts.consumeTtlMs), schedule_commit: consumeTx(), create_vault: fundedTx() }, VAULT_ID_UNIT);
  const ridLogs: string[] = [];
  const issued = new IssuedTxRegistry(l => ridLogs.push(l));
  const service = new VaultTxService({
    network: "Preview", deployment: DEPLOYMENT, chain, builder, locks: new OwnerLockTable(TTL), issued,
    lockTtlMs: TTL, now: () => clock.t,
    didPaymentAnchor: new ChainDidPaymentAnchorReader({ chain, anchorNftPolicy: ANCHOR_POLICY }),
  });
  const fc = opts.feecover ?? fakeFeecover();
  const logs: string[] = [];
  const router: RouterDeps = {
    service, deploymentSource: DEPLOYMENT.source, vaultScopes: DEPLOYMENT.vaults, network: "Preview",
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "",
    logInternal: (refCode, cause) => { logs.push(`${refCode} ${cause instanceof Error ? cause.stack : String(cause)}`); },
    ...(opts.proxy === false ? {} : {
      feeProxy: new FeeProxy({
        settings: DEPLOYMENT.feecover!, magicToken: MAGIC_TOKEN, issued, fetch: fc.fetch, now: () => clock.t,
      }),
    }),
  };
  const responses: unknown[] = [];
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await handle({ method, url, headers, body }, router);
    responses.push(r.body);
    return r;
  };
  return { clock, fc, call, responses, logs, issued, ridLogs };
}

const codeOf = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const detailsOf = (r: { body: unknown }) => (r.body as { error: { details: Record<string, unknown> } }).error.details;
const ORILIFE = { "x-feecover-token": ORILIFE_TOKEN };
const consumeBody = (over: Record<string, unknown> = {}) =>
  ({ owner_pkh: OWNER_PKH, op_type: 1, op_count: "2", fee_payer: FEE_PAYER, ...over });

/** Ghi một lượt giữ chỗ cho `FEE_PAYER` như `/fee/utxo` ghi (không gọi Feecover giả, nên không đổi
 *  `fc.calls`). Đã có lượt giữ thì để yên — ca nào xin `/fee/utxo` với mốc riêng thì mốc đó thắng. */
function reserve(h: ReturnType<typeof harness>, untilMs = NOW + 600_000) {
  if (h.issued.feeReservationOf(FEE_PAYER.utxo) === undefined) h.issued.noteFeeReservation(FEE_PAYER.utxo, untilMs, FEE_ADDRESS);
}

/** Dựng một tx tiêu MAGIC có ví trả phí, trả CBOR + hash. `reserved` (mặc định) ⟹ UTxO phí có lượt
 *  giữ chỗ như khi app xin qua `/fee/utxo` — `/fee/sign` đòi lượt giữ còn hiệu lực lúc ký. */
async function issueConsume(h: ReturnType<typeof harness>, over: Record<string, unknown> = {}, reserved = true) {
  if (reserved) reserve(h);
  const r = await h.call("POST", "/tx/consume", consumeBody(over));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const b = r.body as { tx_cbor: string; tx_hash: string };
  return { cbor: b.tx_cbor, hash: b.tx_hash };
}

// ── /fee/utxo ────────────────────────────────────────────────────────────────

describe("POST /fee/utxo", () => {
  it("dương (magic, không gửi token): trả đúng hình dạng fee_payer, app chép thẳng vào /tx/consume ⟹ 200", async () => {
    const h = harness();
    const r = await h.call("POST", "/fee/utxo", { route: "consume" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({
      fee_payer: { utxo: `${"fa".repeat(32)}#0`, address: FEE_ADDRESS, reservation_id: expect.stringMatching(/^[0-9a-f]{32}$/) },
      reserved_until: new Date(NOW + 600_000).toISOString(),
      purpose: "consume_magic",
    });
    expect(h.fc.calls).toHaveLength(1);
    expect(h.fc.calls[0]!.url).toBe("https://feecover.example/v1/utxo?purpose=consume_magic");
    expect(h.fc.calls[0]!.method).toBe("GET");
    expect(h.fc.calls[0]!.headers.authorization).toBe(`Bearer ${MAGIC_TOKEN}`);
    const fp = (r.body as { fee_payer: unknown }).fee_payer;
    const c = await h.call("POST", "/tx/consume", consumeBody({ fee_payer: fp }));
    expect(c.status, JSON.stringify(c.body)).toBe(200);
  });

  it("route tài trợ có khai mục đích ⟹ 200, Feecover nhận đúng mục đích; route tài trợ chưa khai ⟹ 400 UNMAPPED", async () => {
    // Cặp đối xứng: cùng harness, cùng app, chỉ khác route. Bảng mục đích chỉ có `sponsor-t1-open`.
    const h = harness();
    const r = await h.call("POST", "/fee/utxo", { route: "sponsor-t1-open" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as { purpose: string }).purpose).toBe("sponsor_open");
    expect(h.fc.calls[0]!.url).toBe("https://feecover.example/v1/utxo?purpose=sponsor_open");
    const u = await h.call("POST", "/fee/utxo", { route: "sponsor-t3-draw" });
    expect(u.status).toBe(400);
    expect(codeOf(u)).toBe("FEE_PROXY_PURPOSE_UNMAPPED");
    expect(h.fc.calls).toHaveLength(1);
  });

  it("route không có trong bảng của app ⟹ 400 FEE_PROXY_PURPOSE_UNMAPPED, Feecover KHÔNG bị gọi; route lạ cũng vậy", async () => {
    const h = harness();
    const r = await h.call("POST", "/fee/utxo", { route: "schedule-fire" });
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FEE_PROXY_PURPOSE_UNMAPPED");
    expect(codeOf(await h.call("POST", "/fee/utxo", { route: "constructor" }))).toBe("FEE_PROXY_PURPOSE_UNMAPPED");
    expect(h.fc.calls).toHaveLength(0);
  });

  it("Feecover trả thân lạ ⟹ 502 FEE_PROXY_UPSTREAM, không đệm — mỗi ca hỏng ĐÚNG MỘT trường", async () => {
    // Một ca hỏng nhiều trường cùng lúc thì gỡ cổng của một trường vẫn đỏ nhờ trường kia —
    // ca đó không ghim được cổng nào. Nên mỗi ca dưới đây chỉ lệch một chỗ so với lời đáp tốt.
    const good = { address: FEE_ADDRESS, utxo: { txHash: FEE_UTXO.txHash, outputIndex: 0, lovelace: "10000000" }, reserved_until: new Date(NOW + 1).toISOString() };
    const variants: Record<string, unknown>[] = [
      { ...good, address: "không-phải-địa-chỉ" },
      { ...good, utxo: { ...good.utxo, txHash: "zz" } },
      { ...good, utxo: { ...good.utxo, outputIndex: -1 } },
      { ...good, utxo: { txHash: good.utxo.txHash, outputIndex: 0 } },
      { ...good, reserved_until: "không phải thời điểm" },
    ];
    for (const body of variants) {
      const h = harness({ feecover: fakeFeecover({ utxo: { status: 200, body } }) });
      const r = await h.call("POST", "/fee/utxo", { route: "consume" });
      expect(r.status, JSON.stringify(body)).toBe(502);
      expect(codeOf(r)).toBe("FEE_PROXY_UPSTREAM");
    }
    // CẶP: lời đáp tốt đi qua.
    expect((await harness({ feecover: fakeFeecover({ utxo: { status: 200, body: good } }) })
      .call("POST", "/fee/utxo", { route: "consume" })).status).toBe(200);
  });
});

// ── không có khối feecover ───────────────────────────────────────────────────

describe("không cấu hình feecover", () => {
  it("hai route proxy ⟹ 501 FEE_PROXY_UNAVAILABLE; /health nói absent. CẶP: có khối ⟹ configured", async () => {
    const h = harness({ proxy: false });
    for (const [url, body] of [["/fee/utxo", { route: "consume" }], ["/fee/sign", { tx_cbor: "00" }]] as const) {
      const r = await h.call("POST", url, body);
      expect(r.status).toBe(501);
      expect(codeOf(r)).toBe("FEE_PROXY_UNAVAILABLE");
    }
    expect((await h.call("GET", "/health")).body).toMatchObject({ feecover: "absent" });
    expect((await harness().call("GET", "/health")).body).toMatchObject({ feecover: "configured" });
    expect(h.fc.calls).toHaveLength(0);
  });
});

// ── cấu hình ─────────────────────────────────────────────────────────────────

describe("cấu hình feecover", () => {
  const dir = mkdtempSync(join(tmpdir(), "vault-tx-api-fee-"));
  const blueprint = join(dir, "plutus.json");
  writeFileSync(blueprint, JSON.stringify({ validators: [{ title: "vault.vault.spend", compiledCode: "59" }] }));
  const env = (over: Record<string, unknown> = {}, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    VAULT_TX_API_NETWORK: "Preview",
    BLOCKFROST_PROJECT_ID: "giá-trị-khoá-không-phải-đường-dẫn",
    VAULT_TX_API_DEPLOYMENT: JSON.stringify(deploymentObj(over)),
    VAULT_TX_API_CHANGE_ADDRESS_STRATEGY: "enterprise_from_owner_pkh",
    VAULT_TX_API_VAULT_PLUTUS_JSON: blueprint,
    ...extra,
  });

  it("có khối feecover (app magic) mà thiếu FEECOVER_APP_TOKEN ⟹ loadConfig NÉM; CẶP: có token ⟹ nạp được", () => {
    expect(() => loadConfig(env())).toThrow(/FEECOVER_APP_TOKEN/);
    const c = loadConfig(env({}, { FEECOVER_APP_TOKEN: MAGIC_TOKEN }));
    expect(c.feecoverAppToken).toBe(MAGIC_TOKEN);
    expect(c.deployment.feecover?.timeoutMs).toBe(200);
    expect(c.deployment.feecover?.url).toBe("https://feecover.example");
    // Không có khối ⟹ token môi trường bị bỏ qua, không bắt buộc.
    expect(loadConfig(env({ feecover: undefined })).feecoverAppToken).toBeUndefined();
  });

  it("thông điệp lỗi cấu hình không mang token; token trùng băm với ứng dụng khác ⟹ NÉM", () => {
    const d = parseDeployment(JSON.stringify(deploymentObj()), "Preview");
    let msg = "";
    try { resolveFeecoverAppToken(d.feecover, { FEECOVER_APP_TOKEN: ORILIFE_TOKEN }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/trùng băm/);
    expect(msg).not.toContain(ORILIFE_TOKEN);
    expect(msg).not.toContain(sha(ORILIFE_TOKEN));
  });

  it("URL http:// ra ngoài loopback / mang chứng danh ⟹ NÉM; http://127.0.0.1 ⟹ nạp; route lạ trong bảng ⟹ NÉM", () => {
    const withFc = (fc: Record<string, unknown>) =>
      () => parseDeployment(JSON.stringify(deploymentObj({ feecover: { ...FEECOVER_BLOCK, ...fc } })), "Preview");
    expect(withFc({ url: "http://feecover.example" })).toThrow(/https/);
    expect(withFc({ url: "https://u:p@feecover.example" })).toThrow(/chứng danh/);
    expect(withFc({ url: "http://127.0.0.1:8790" })).not.toThrow();
    expect(withFc({ apps: { magic: { purposes: { "consume-magic": "consume_magic" } } } })).toThrow(/route/);
    // Bốn route tài trợ là khoá hợp lệ; tên gần đúng thì vẫn NÉM.
    const sponsorPurposes = {
      "sponsor-t1-open": "sponsor_open", "sponsor-t2-fund": "sponsor_fund",
      "sponsor-t3-draw": "sponsor_draw", "sponsor-t4-first-consume": "sponsor_first_consume",
    };
    expect(withFc({ apps: { magic: { purposes: sponsorPurposes } } })).not.toThrow();
    expect(withFc({ apps: { magic: { purposes: { "sponsor-t2": "sponsor_fund" } } } })).toThrow(/route/);
    expect(withFc({ apps: { magic: { token_sha256: "ab".repeat(32), purposes: {} } } })).toThrow(/token_sha256/);
  });
});

// ── /fee/sign ────────────────────────────────────────────────────────────────

describe("POST /fee/sign — cổng trước Feecover", () => {
  it("tx không trong sổ phát-hành ⟹ 403 FEE_PROXY_TX_NOT_ISSUED, Feecover KHÔNG bị gọi", async () => {
    const h = harness();
    const r = await h.call("POST", "/fee/sign", { tx_cbor: consumeTx() });
    expect(r.status).toBe(403);
    expect(codeOf(r)).toBe("FEE_PROXY_TX_NOT_ISSUED");
    expect(h.fc.calls).toHaveLength(0);
  });

  it("tx đã bị THAY (một tx chung khoá chủ đã NỘP) ⟹ 409 TX_SUPERSEDED, Feecover KHÔNG bị gọi; CẶP: chưa bị thay ⟹ 200", async () => {
    const h = harness();
    const { cbor } = await issueConsume(h);
    const hash = txBodyHash(cbor);
    // Một tx khác cùng khoá chủ được ghi sổ rồi NỘP (mô phỏng `/tx/submit` ▸ `markSubmitted`).
    expect((await h.call("POST", "/fee/sign", { tx_cbor: cbor })).status).toBe(200);
    const callsBefore = h.fc.calls.length;
    const other = "5e".repeat(32);
    h.issued.record(other, NOW, { route: "consume", validToMs: NOW + TTL, lockKeys: h.issued.lookup(hash, NOW)!.lockKeys });
    expect(h.issued.markSubmitted(other, NOW)).toBe(1);
    const r = await h.call("POST", "/fee/sign", { tx_cbor: cbor });
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("TX_SUPERSEDED");
    expect(h.fc.calls).toHaveLength(callsBefore);
  });

  it("tx đã phát KHÔNG dùng ví trả phí ⟹ 400 FEE_PROXY_NO_FEE_PAYER, Feecover KHÔNG bị gọi", async () => {
    const h = harness();
    const { cbor } = await issueConsume(h, { fee_payer: undefined, change_address: CHANGE_ADDRESS });
    const r = await h.call("POST", "/fee/sign", { tx_cbor: cbor });
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FEE_PROXY_NO_FEE_PAYER");
    expect(h.fc.calls).toHaveLength(0);
  });
});

describe("POST /fee/sign — dương: mục đích + ref lấy từ sổ, không từ app", () => {
  it("create-vault: purpose create_vault, ref = 64 hex cuối vault_nft", async () => {
    const h = harness();
    reserve(h);
    const cv = await h.call("POST", "/tx/create-vault",
      { kind: "schedule", owner: KEY_OWNER, lamp_amount: DEPOSIT.toString(), funding: FUNDING });
    expect(cv.status, JSON.stringify(cv.body)).toBe(200);
    const b = cv.body as { tx_cbor: string; tx_hash: string; vault_nft: string };
    // App gửi kèm purpose/ref giả: bị bỏ qua.
    const r = await h.call("POST", "/fee/sign", { tx_cbor: b.tx_cbor, purpose: "consume_magic", ref: "00".repeat(32) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ tx_hash: b.tx_hash, witness_set: "a100", net_lovelace: "178000", fee_lovelace: "178000" });
    expect(h.fc.calls).toHaveLength(1);
    const sent = h.fc.calls[0]!;
    expect(sent.url).toBe("https://feecover.example/v1/sign");
    expect(sent.method).toBe("POST");
    expect(sent.headers.authorization).toBe(`Bearer ${MAGIC_TOKEN}`);
    expect(b.vault_nft.slice(56)).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.body).toEqual({ tx_cbor_hex: b.tx_cbor, purpose: "create_vault", ref: b.vault_nft.slice(-64) });
  });

  it("consume: purpose consume_magic, ref = hash thân tx", async () => {
    const h = harness();
    const { cbor, hash } = await issueConsume(h);
    const r = await h.call("POST", "/fee/sign", { tx_cbor: cbor });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.fc.calls[0]!.body).toEqual({ tx_cbor_hex: cbor, purpose: "consume_magic", ref: hash });
  });
});

describe("POST /fee/sign — lời đáp Feecover", () => {
  it("422 ⟹ chuyển nguyên mã + rule/message/reasons dưới FEE_PROXY_REJECTED; 409 chỉ có message ⟹ 409", async () => {
    const h = harness({ feecover: fakeFeecover({
      sign: { status: 422, body: { rule: "L12", message: "ví trả phí mất nhiều hơn phí", reasons: ["ví trả phí mất nhiều hơn phí", "x"] } },
    }) });
    const { cbor } = await issueConsume(h);
    const r = await h.call("POST", "/fee/sign", { tx_cbor: cbor });
    expect(r.status).toBe(422);
    expect(codeOf(r)).toBe("FEE_PROXY_REJECTED");
    expect(detailsOf(r)).toEqual({
      upstream_status: 422, rule: "L12", message: "ví trả phí mất nhiều hơn phí", reasons: ["ví trả phí mất nhiều hơn phí", "x"],
    });
    const h2 = harness({ feecover: fakeFeecover({ sign: { status: 409, body: { message: "UTxO đang giữ cho ứng dụng khác." } } }) });
    const r2 = await h2.call("POST", "/fee/sign", { tx_cbor: (await issueConsume(h2)).cbor });
    expect(r2.status).toBe(409);
    expect(codeOf(r2)).toBe("FEE_PROXY_REJECTED");
  });

  it("CỰC ĐỐI của ca trên: 401/404 của Feecover nói về DỊCH VỤ ⟹ 502 FEE_PROXY_UPSTREAM, không 401 cho app", async () => {
    for (const st of [401, 404]) {
      const h = harness({ feecover: fakeFeecover({ sign: { status: st, body: { message: "token dịch vụ không hợp lệ" } } }) });
      const r = await h.call("POST", "/fee/sign", { tx_cbor: (await issueConsume(h)).cbor });
      expect(r.status, `Feecover ${st}`).toBe(502);
      expect(codeOf(r)).toBe("FEE_PROXY_UPSTREAM");
      expect(detailsOf(r)).toMatchObject({ upstream_status: st, message: "token dịch vụ không hợp lệ" });
    }
    // Còn 403 (luật L14 chặn ứng dụng theo cửa sổ) là quyết định chính sách ⟹ đi nguyên.
    const h = harness({ feecover: fakeFeecover({ sign: { status: 403, body: { rule: "L14", message: "cửa sổ Catalyst" } } }) });
    const r = await h.call("POST", "/fee/sign", { tx_cbor: (await issueConsume(h)).cbor });
    expect(r.status).toBe(403);
    expect(codeOf(r)).toBe("FEE_PROXY_REJECTED");
  });

  it("câu 4xx của Feecover có chứa token của dịch vụ ⟹ câu đó KHÔNG đi ra app", async () => {
    const h = harness({ feecover: fakeFeecover({
      sign: { status: 422, body: { rule: "L1", message: `token ${MAGIC_TOKEN} sai`, reasons: [`x ${MAGIC_TOKEN}`] } },
    }) });
    const r = await h.call("POST", "/fee/sign", { tx_cbor: (await issueConsume(h)).cbor });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).not.toContain(MAGIC_TOKEN);
    expect(detailsOf(r)).toEqual({ upstream_status: 422, rule: "L1" });
  });

  it("Feecover ký một tx có hash KHÁC ⟹ 502 FEE_PROXY_UPSTREAM_MISMATCH", async () => {
    const h = harness({ feecover: fakeFeecover({
      sign: { status: 200, body: { txHash: "00".repeat(32), witnessSet: "a100", netLovelace: "1", feeLovelace: "1" } },
    }) });
    const r = await h.call("POST", "/fee/sign", { tx_cbor: (await issueConsume(h)).cbor });
    expect(r.status).toBe(502);
    expect(codeOf(r)).toBe("FEE_PROXY_UPSTREAM_MISMATCH");
  });

  it("thân lạ / không phải JSON / 5xx / lỗi mạng / quá hạn chót ⟹ 502 FEE_PROXY_UPSTREAM", async () => {
    // Lời đáp /v1/sign lệch ĐÚNG MỘT trường so với lời đáp tốt (xem ca /v1/utxo).
    const singleFault: Record<string, unknown>[] = [
      { txHash: "XYZ" },
      { witnessSet: undefined },
      { witnessSet: "a10" },
      { netLovelace: "1.5" },
      { feeLovelace: undefined },
    ];
    for (const patch of singleFault) {
      const h = harness({ feecover: fakeFeecover({ sign: (b) => {
        const ok = (echoSign(b) as { body: Record<string, unknown> }).body;
        return { status: 200, body: { ...ok, ...patch } };
      } }) });
      const r = await h.call("POST", "/fee/sign", { tx_cbor: (await issueConsume(h)).cbor });
      expect(r.status, JSON.stringify(patch)).toBe(502);
      expect(codeOf(r)).toBe("FEE_PROXY_UPSTREAM");
    }
    const cases: Reply[] = [
      { status: 200, body: { txHash: "x" } },
      { status: 200, body: "<html>không phải JSON</html>" },
      { status: 503, body: { message: "hết UTxO rảnh" } },
      "throw",
      "hang",
    ];
    for (const c of cases) {
      const h = harness({ feecover: fakeFeecover({ sign: (b) => (c === cases[0] ? { status: 200, body: { txHash: txBodyHash(b.tx_cbor_hex as string) } } : c) }) });
      const r = await h.call("POST", "/fee/sign", { tx_cbor: (await issueConsume(h)).cbor });
      expect(r.status, JSON.stringify(c)).toBe(502);
      expect(codeOf(r)).toBe("FEE_PROXY_UPSTREAM");
    }
    // CẶP: hết giờ và không tới được cùng mã nhưng HAI câu — `send` dùng chung với `/v1/fee-sources`
    // phải giữ hai lối tách nhau; câu lỗi thư viện ("fetch failed") không lọt ra, chỉ TÊN lỗi.
    const messageOf = async (c: Reply) => {
      const h = harness({ feecover: fakeFeecover({ sign: () => c }) });
      const r = await h.call("POST", "/fee/sign", { tx_cbor: (await issueConsume(h)).cbor });
      return (r.body as { error: { message: string } }).error.message;
    };
    expect(await messageOf("hang")).toBe("Feecover không trả lời trong 200 ms.");
    expect(await messageOf("throw")).toBe("Không gọi được Feecover (TypeError).");
  });
});

// ── hạn ký = giờ giữ chỗ của UTxO phí ────────────────────────────────────────

describe("sổ phát-hành: hạn ký theo reserved_until", () => {
  it("UTxO qua /fee/utxo: ký được TRƯỚC reserved_until; SAU mốc đó ⟹ 403 (dù hạn sổ còn)", async () => {
    // Dịch vụ kẹp validTo vào reserved_until (`service.ts` ▸ `validityPlan`) ⟹ CBOR ghi sẵn phải
    // mang ttl ≤ mốc đó, như bộ dựng thật; ttl 10′ ⟹ 500 bất biến "bộ dựng bỏ qua cận".
    const h = harness({ feecover: fakeFeecover({ utxo: utxoReply(NOW + 60_000) }), consumeTtlMs: 60_000 });
    expect((await h.call("POST", "/fee/utxo", { route: "consume" })).status).toBe(200);
    const { cbor } = await issueConsume(h);
    h.clock.t = NOW + 59_000;
    expect((await h.call("POST", "/fee/sign", { tx_cbor: cbor })).status).toBe(200);
    h.clock.t = NOW + 61_000;
    const r = await h.call("POST", "/fee/sign", { tx_cbor: cbor });
    expect(r.status).toBe(403);
    expect(codeOf(r)).toBe("FEE_PROXY_TX_NOT_ISSUED");
    expect(h.issued.wasIssued(txBodyHash(cbor), h.clock.t)).toBe(true);
  });

  // Chính sách LẬT 2026-10-07 (thư SuperApp sa1007mg-fc): bản cũ coi UTxO phí không có lượt giữ là
  // "app tự đưa" và cho xin ký tới hết hạn sổ. Nhưng `/fee/sign` chỉ có nghĩa với UTxO của Feecover, và
  // sổ không có lượt giữ cũng là đúng trạng thái SAU khi bộ quét dọn — nên vắng lượt giữ ⟹ 409.
  it("CẶP: UTxO phí KHÔNG có lượt giữ (chưa từng qua /fee/utxo của tiến trình này) ⟹ dựng được, xin ký 409 absent, Feecover KHÔNG bị gọi; có lượt giữ ⟹ 200", async () => {
    const h = harness();
    const { cbor, hash } = await issueConsume(h, {}, false);
    const r = await h.call("POST", "/fee/sign", { tx_cbor: cbor });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(codeOf(r)).toBe("FEE_PAYER_RESERVATION_EXPIRED");
    expect(detailsOf(r)).toEqual({ tx_hash: hash, fee_payer_utxo: FEE_PAYER.utxo, reserved_until: null, reservation: "absent" });
    expect(h.fc.calls).toHaveLength(0);
    // Quá validTo + biên: tx ĐÃ phát ⟹ 410 TX_EXPIRED vẫn thắng (cổng hạn đứng trước cổng giữ chỗ).
    h.clock.t = NOW + REGISTRY_TTL + 1;
    expect(codeOf(await h.call("POST", "/fee/sign", { tx_cbor: cbor }))).toBe("TX_EXPIRED");
    // Cực đối: cùng tx, cùng giờ dựng, có lượt giữ ⟹ ký được.
    const h2 = harness();
    const ok = await issueConsume(h2);
    expect((await h2.call("POST", "/fee/sign", { tx_cbor: ok.cbor })).status).toBe(200);
  });

  // Chính sách LẬT 2026-10-07 (reservation_id): bản trước ra `exceeded` cho ca này. Tx dựng khi CHƯA có
  // lượt giữ nào thì lượt giữ xuất hiện SAU nó là của một lượt `/fee/utxo` khác ⟹ `foreign`.
  it("tx dựng khi chưa có lượt giữ; sau đó /fee/utxo phát CHÍNH UTxO đó ⟹ 409 foreign, Feecover KHÔNG bị gọi", async () => {
    const h = harness({ feecover: fakeFeecover({ utxo: utxoReply(NOW + 300_000) }) });
    const { cbor, hash } = await issueConsume(h, {}, false);
    expect((await h.call("POST", "/fee/utxo", { route: "consume" })).status).toBe(200);
    const r = await h.call("POST", "/fee/sign", { tx_cbor: cbor });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(detailsOf(r)).toEqual({ tx_hash: hash, fee_payer_utxo: FEE_PAYER.utxo, reserved_until: null, reservation: "foreign" });
    expect(h.fc.calls.map(c => c.url)).toEqual(["https://feecover.example/v1/utxo?purpose=consume_magic"]);
  });

  it("validTo của tx VƯỢT lượt giữ CÙNG mã (lượt giữ bị rút ngắn) ⟹ 409 exceeded, Feecover KHÔNG bị gọi", async () => {
    // Đường mã thường không tới ca này (cổng dựng kẹp validTo ≤ lượt giữ, lượt giữ mới luôn mang mã mới);
    // ghim nó bằng cách rút ngắn lượt giữ mà GIỮ mã — phép canh phòng thủ của `feeSignProblem`.
    const h = harness();
    const { cbor, hash } = await issueConsume(h);
    const id = h.issued.feeReservationIdOf(FEE_PAYER.utxo)!;
    h.issued.noteFeeReservation(FEE_PAYER.utxo, NOW + 300_000, FEE_ADDRESS, id);
    const r = await h.call("POST", "/fee/sign", { tx_cbor: cbor });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(detailsOf(r)).toEqual({
      tx_hash: hash, fee_payer_utxo: FEE_PAYER.utxo, reserved_until: new Date(NOW + 300_000).toISOString(), reservation: "exceeded",
    });
    expect(h.fc.calls).toHaveLength(0);
  });

  it("tx ĐÃ phát, quá validTo + biên ⟹ 410 TX_EXPIRED cùng details /tx/submit, Feecover KHÔNG bị gọi; CẶP: tx chưa từng phát cùng giờ ⟹ 403", async () => {
    const h = harness();
    const { cbor } = await issueConsume(h);
    const hash = txBodyHash(cbor);
    h.clock.t = NOW + REGISTRY_TTL + 1;
    const r = await h.call("POST", "/fee/sign", { tx_cbor: cbor });
    expect(r.status).toBe(410);
    expect(codeOf(r)).toBe("TX_EXPIRED");
    // expired_at = validTo của thân tx (ttl fixture NOW + 10′), KHÔNG phải mốc sổ (validTo + biên).
    expect(detailsOf(r)).toEqual({
      tx_hash: hash, expired_at: new Date(NOW + 600_000).toISOString(), rebuild_safe: true, submission: "none",
    });
    expect(h.fc.calls).toHaveLength(0);

    const never = await h.call("POST", "/fee/sign", { tx_cbor: consumeTx() });
    expect(never.status).toBe(403);
    expect(codeOf(never)).toBe("FEE_PROXY_TX_NOT_ISSUED");
  });

  // Chính sách LẬT 2026-10-06: bản cũ kéo dòng sống tới reserved_until. Nay dòng hết đúng tại
  // validTo + biên — sau mốc đó sổ cái chắc chắn từ chối tx, xin Feecover ký là vô ích. Kỳ vọng đảo dấu.
  it("reserved_until DÀI hơn validTo ⟹ dòng KHÔNG sống quá validTo + biên (CẶP: trước mốc thì ký được)", async () => {
    const h = harness({ feecover: fakeFeecover({ utxo: utxoReply(NOW + REGISTRY_TTL + 60_000) }) });
    await h.call("POST", "/fee/utxo", { route: "consume" });
    const { cbor } = await issueConsume(h);
    h.clock.t = NOW + REGISTRY_TTL - 1;
    expect((await h.call("POST", "/fee/sign", { tx_cbor: cbor })).status).toBe(200);
    h.clock.t = NOW + REGISTRY_TTL + 30_000;
    expect(codeOf(await h.call("POST", "/fee/sign", { tx_cbor: cbor }))).toBe("TX_EXPIRED");
  });
});

// ── thư SuperApp sa1007mg-fc: lượt giữ bị bộ quét dọn ───────────────────────

describe("lượt giữ chỗ Feecover đã bị quét ⟹ không dựng, không ký", () => {
  // Chuỗi của thư: /fee/utxo giữ tới R ⟹ tx A kẹp validTo ≤ R ⟹ quá R, bộ quét (`server.ts`, 30 s) dọn
  // lượt giữ ⟹ bản trước: dựng lại với CÙNG fee_payer ra tx hạn 15′ không kẹp, và xin ký được tới hết
  // hạn đó, trong khi Feecover có thể đã giao UTxO cho người khác.
  const R = NOW + 60_000;

  it("CẶP: lượt giữ CÒN ⟹ dựng lại 200 + ký 200; ĐÃ BỊ QUÉT ⟹ dựng lại 409 absent, bộ dựng/Feecover không bị gọi", async () => {
    const h = harness({ feecover: fakeFeecover({ utxo: utxoReply(R) }), consumeTtlMs: 60_000 });
    const u = await h.call("POST", "/fee/utxo", { route: "consume" });
    const fp = (u.body as { fee_payer: unknown }).fee_payer;
    const a = await h.call("POST", "/tx/consume", consumeBody({ fee_payer: fp }));
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    // Lượt giữ còn: dựng lại và ký được.
    const again = await h.call("POST", "/tx/consume", consumeBody({ fee_payer: fp }));
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((await h.call("POST", "/fee/sign", { tx_cbor: (again.body as { tx_cbor: string }).tx_cbor })).status).toBe(200);
    const callsBefore = h.fc.calls.length;

    // Quá R, bộ quét chạy ⟹ sổ không còn lượt giữ.
    h.clock.t = R + 30_000;
    h.issued.sweep(h.clock.t);
    expect(h.issued.feeReservationOf(FEE_PAYER.utxo)).toBeUndefined();
    const b = await h.call("POST", "/tx/consume", consumeBody({ fee_payer: fp }));
    expect(b.status, JSON.stringify(b.body)).toBe(409);
    expect(codeOf(b)).toBe("FEE_PAYER_RESERVATION_EXPIRED");
    expect(detailsOf(b)).toEqual({ fee_payer_utxo: FEE_PAYER.utxo, reserved_until: null, reservation: "absent" });
    expect(h.fc.calls).toHaveLength(callsBefore);
  });

  it("CẶP: ví trả phí KHÔNG phải Feecover (địa chỉ Feecover chưa từng phát) vẫn dựng được sau khi sổ đã quét", async () => {
    const h = harness({ feecover: fakeFeecover({ utxo: utxoReply(R) }), consumeTtlMs: 60_000 });
    await h.call("POST", "/fee/utxo", { route: "consume" });
    h.clock.t = R + 30_000;
    h.issued.sweep(h.clock.t);
    // Cùng sổ đã nhớ địa chỉ Feecover: tra một địa chỉ khác thì không có lượt giữ nào để đòi.
    const own = enterpriseAddressOf("Preview", OWNER_PKH);
    expect(h.issued.feeReservationForBuild(`${"0b".repeat(32)}#0`, own)).toBeUndefined();
    expect(() => h.issued.feeReservationForBuild(FEE_PAYER.utxo, FEE_ADDRESS))
      .toThrow(expect.objectContaining({ code: "FEE_PAYER_RESERVATION_EXPIRED" }));
  });

  it("lượt giữ đã qua nhưng CHƯA bị quét ⟹ /fee/sign vẫn từ chối (403 hạn ký chốt lúc ghi sổ)", async () => {
    const h = harness({ feecover: fakeFeecover({ utxo: utxoReply(R) }), consumeTtlMs: 60_000 });
    await h.call("POST", "/fee/utxo", { route: "consume" });
    const { cbor } = await issueConsume(h);
    h.clock.t = R + 1;
    expect(codeOf(await h.call("POST", "/fee/sign", { tx_cbor: cbor }))).toBe("FEE_PROXY_TX_NOT_ISSUED");
    // Và sau khi quét: vẫn từ chối, không lùi về "không ràng buộc".
    h.issued.sweep(h.clock.t);
    expect(codeOf(await h.call("POST", "/fee/sign", { tx_cbor: cbor }))).toBe("FEE_PROXY_TX_NOT_ISSUED");
    expect(h.fc.calls).toHaveLength(1);
  });
});

// ── thư SuperApp sa1007mg-rid: mã lượt giữ ───────────────────────────────────

describe("reservation_id — mã lượt giữ UTxO Feecover", () => {
  // Lỗ của thư mg1007sa-b: sổ giữ chỗ khoá theo UTxO; Feecover giao lại cùng UTxO cho B thì A, còn cầm
  // `fee_payer` cũ, vẫn dựng được trên lượt giữ của B. Bộ Feecover giả trả CÙNG UTxO mỗi lượt /fee/utxo.
  const fpOf = (r: { body: unknown }) => (r.body as { fee_payer: { utxo: string; address: string; reservation_id: string } }).fee_payer;

  it("CẶP: id khớp ⟹ dựng 200 + ký 200; id của lượt giữ CŨ sau khi UTxO giao lại ⟹ 409 foreign, Feecover không bị gọi", async () => {
    const h = harness();
    const fp1 = fpOf(await h.call("POST", "/fee/utxo", { route: "consume" }));
    const a = await h.call("POST", "/tx/consume", consumeBody({ fee_payer: fp1 }));
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect((await h.call("POST", "/fee/sign", { tx_cbor: (a.body as { tx_cbor: string }).tx_cbor })).status).toBe(200);

    // Feecover giao lại ĐÚNG UTxO đó (cho B) ⟹ lượt giữ mới, mã mới.
    const fp2 = fpOf(await h.call("POST", "/fee/utxo", { route: "consume" }));
    expect(fp2.utxo).toBe(fp1.utxo);
    expect(fp2.reservation_id).not.toBe(fp1.reservation_id);
    const callsBefore = h.fc.calls.length;
    const stale = await h.call("POST", "/tx/consume", consumeBody({ fee_payer: fp1 }));
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(codeOf(stale)).toBe("FEE_PAYER_RESERVATION_EXPIRED");
    expect(detailsOf(stale)).toEqual({ fee_payer_utxo: fp1.utxo, reserved_until: null, reservation: "foreign" });
    expect(h.fc.calls).toHaveLength(callsBefore);
    // Cực đối, cùng thời điểm: người cầm lượt giữ MỚI dựng được.
    expect((await h.call("POST", "/tx/consume", consumeBody({ fee_payer: fp2 }))).status).toBe(200);
  });

  it("CẶP: vắng id ⟹ 200 (bước 1), without_id[consume] tăng + một dòng nhật ký JSON; có id ⟹ with_id tăng, không dòng nào", async () => {
    const h = harness();
    const fp = fpOf(await h.call("POST", "/fee/utxo", { route: "consume" }));
    const bare = { utxo: fp.utxo, address: fp.address };
    expect((await h.call("POST", "/tx/consume", consumeBody({ fee_payer: bare }))).status).toBe(200);
    expect(h.issued.reservationIdStats()).toEqual({ with_id: {}, without_id: { consume: 1 } });
    expect(h.ridLogs).toHaveLength(1);
    expect(JSON.parse(h.ridLogs[0]!)).toEqual({
      event: "fee_reservation_id_missing", route: "consume", fee_payer_utxo: fp.utxo, without_id: 1, with_id: 0,
    });
    expect((await h.call("POST", "/tx/consume", consumeBody({ fee_payer: fp }))).status).toBe(200);
    expect(h.issued.reservationIdStats()).toEqual({ with_id: { consume: 1 }, without_id: { consume: 1 } });
    expect(h.ridLogs).toHaveLength(1);
    // Số đo lộ ở /health cho người vận hành.
    const health = await h.call("GET", "/health");
    expect((health.body as { fee_reservation_id: unknown }).fee_reservation_id)
      .toEqual({ with_id: { consume: 1 }, without_id: { consume: 1 } });
  });

  it("sai kiểu ⟹ 400 FEE_PAYER_SHAPE trước mọi lượt dựng (CẶP: đúng khuôn ⟹ 200)", async () => {
    const h = harness();
    const fp = fpOf(await h.call("POST", "/fee/utxo", { route: "consume" }));
    for (const bad of [5, null, "", fp.reservation_id.toUpperCase(), fp.reservation_id.slice(1), `${fp.reservation_id}00`]) {
      const r = await h.call("POST", "/tx/consume", consumeBody({ fee_payer: { ...fp, reservation_id: bad } }));
      expect(r.status, `${JSON.stringify(bad)} → ${JSON.stringify(r.body)}`).toBe(400);
      expect(codeOf(r)).toBe("FEE_PAYER_SHAPE");
      expect(detailsOf(r)).toEqual({ field: "fee_payer.reservation_id" });
    }
    expect(h.issued.reservationIdStats()).toEqual({ with_id: {}, without_id: {} });
    expect((await h.call("POST", "/tx/consume", consumeBody({ fee_payer: fp }))).status).toBe(200);
  });

  it("/fee/sign: tx dựng trên lượt giữ cũ, UTxO đã giao lại ⟹ 409 foreign, Feecover KHÔNG bị gọi (CẶP: dựng lại trên lượt mới ⟹ 200)", async () => {
    const h = harness();
    const fp1 = fpOf(await h.call("POST", "/fee/utxo", { route: "consume" }));
    // App gửi id: sổ ghi đúng id đó.
    const a = await h.call("POST", "/tx/consume", consumeBody({ fee_payer: fp1 }));
    const cbor = (a.body as { tx_cbor: string }).tx_cbor;
    const fp2 = fpOf(await h.call("POST", "/fee/utxo", { route: "consume" }));
    const callsBefore = h.fc.calls.length;
    const s = await h.call("POST", "/fee/sign", { tx_cbor: cbor });
    expect(s.status, JSON.stringify(s.body)).toBe(409);
    expect(codeOf(s)).toBe("FEE_PAYER_RESERVATION_EXPIRED");
    expect(detailsOf(s)).toEqual({
      tx_hash: (a.body as { tx_hash: string }).tx_hash, fee_payer_utxo: fp1.utxo, reserved_until: null, reservation: "foreign",
    });
    expect(h.fc.calls).toHaveLength(callsBefore);
    // Cực đối: cùng tx (bộ dựng ghi sẵn trả CÙNG CBOR) dựng lại trên lượt giữ MỚI ⟹ sổ ghi mã mới ⟹ ký được.
    expect((await h.call("POST", "/tx/consume", consumeBody({ fee_payer: fp2 }))).status).toBe(200);
    expect((await h.call("POST", "/fee/sign", { tx_cbor: cbor })).status).toBe(200);
    expect(h.fc.calls).toHaveLength(callsBefore + 1);
  });

  it("/fee/sign: app KHÔNG gửi id lúc dựng ⟹ sổ ghi mã lượt giữ đang sống lúc dựng, nên giao lại UTxO vẫn ra 409 foreign", async () => {
    const h = harness();
    const fp1 = fpOf(await h.call("POST", "/fee/utxo", { route: "consume" }));
    const a = await h.call("POST", "/tx/consume", consumeBody({ fee_payer: { utxo: fp1.utxo, address: fp1.address } }));
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(h.issued.lookup((a.body as { tx_hash: string }).tx_hash, NOW)!.feeReservationId).toBe(fp1.reservation_id);
    await h.call("POST", "/fee/utxo", { route: "consume" });
    const s = await h.call("POST", "/fee/sign", { tx_cbor: (a.body as { tx_cbor: string }).tx_cbor });
    expect(s.status, JSON.stringify(s.body)).toBe(409);
    expect((detailsOf(s) as { reservation: string }).reservation).toBe("foreign");
  });

  it("funding.fee_payer nhận reservation_id; funding.collateral (UTxO của chính chủ) KHÔNG nhận — trường lạ", () => {
    const fp = { utxo: FEE_PAYER.utxo, address: FEE_ADDRESS, reservation_id: "ab".repeat(16) };
    expect(parseFeePayerShape(fp, FUNDING_FEE_PAYER_CODES).reservationId).toBe("ab".repeat(16));
    expect(() => parseFeePayerShape(fp, FUNDING_COLLATERAL_CODES))
      .toThrow(expect.objectContaining({ code: FUNDING_COLLATERAL_CODES.shape, details: { extra_fields: ["reservation_id"] } }));
  });
});

// ── nhiều ứng dụng ───────────────────────────────────────────────────────────

describe("token theo ứng dụng gọi", () => {
  it("orilife: /fee/utxo + /fee/sign chuyển tiếp ĐÚNG token người gọi + mục đích orilife_consume_magic", async () => {
    const h = harness();
    const u = await h.call("POST", "/fee/utxo", { route: "consume" }, ORILIFE);
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect((u.body as { purpose: string }).purpose).toBe("orilife_consume_magic");
    const { cbor, hash } = await issueConsume(h);
    const s = await h.call("POST", "/fee/sign", { tx_cbor: cbor }, ORILIFE);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(h.fc.calls.map(c => c.headers.authorization)).toEqual([`Bearer ${ORILIFE_TOKEN}`, `Bearer ${ORILIFE_TOKEN}`]);
    expect(h.fc.calls[0]!.url).toBe("https://feecover.example/v1/utxo?purpose=orilife_consume_magic");
    expect(h.fc.calls[1]!.body).toEqual({ tx_cbor_hex: cbor, purpose: "orilife_consume_magic", ref: hash });
  });

  it("orilife với route chỉ magic có ⟹ 400 FEE_PROXY_PURPOSE_UNMAPPED (không lùi về bảng của magic)", async () => {
    const h = harness();
    const r = await h.call("POST", "/fee/utxo", { route: "create-vault" }, ORILIFE);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FEE_PROXY_PURPOSE_UNMAPPED");
    expect(h.fc.calls).toHaveLength(0);
  });

  it("magic dùng mục đích orilife_* ⟹ 403; app khác magic dùng mục đích không tiền tố tên mình ⟹ 403", async () => {
    const h = harness();
    const r = await h.call("POST", "/fee/utxo", { route: "schedule-commit" });
    expect(r.status).toBe(403);
    expect(codeOf(r)).toBe("FEE_PROXY_APP_PURPOSE");
    const r2 = await h.call("POST", "/fee/utxo", { route: "consume" }, { "x-feecover-token": ALADIN_TOKEN });
    expect(r2.status).toBe(403);
    expect(codeOf(r2)).toBe("FEE_PROXY_APP_PURPOSE");
    // Cùng cổng ở /fee/sign: tx phát bởi schedule-commit, magic xin ký ⟹ 403.
    const { cbor } = await (async () => {
      const c = await h.call("POST", "/tx/schedule-commit",
        { owner_pkh: OWNER_PKH, schedule_length: "3", lamp_per_epoch: "7000000", fee_payer: FEE_PAYER });
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      return { cbor: (c.body as { tx_cbor: string }).tx_cbor };
    })();
    expect(codeOf(await h.call("POST", "/fee/sign", { tx_cbor: cbor }))).toBe("FEE_PROXY_APP_PURPOSE");
    expect(h.fc.calls).toHaveLength(0);
  });

  it("token lạ (kể cả chính token magic gửi qua tiêu đề, hoặc chuỗi rỗng) ⟹ 401 FEE_PROXY_APP_UNKNOWN, Feecover KHÔNG bị gọi", async () => {
    const h = harness();
    const { cbor } = await issueConsume(h);
    for (const t of ["không-phải-token-nào", MAGIC_TOKEN, ""]) {
      for (const [url, body] of [["/fee/utxo", { route: "consume" }], ["/fee/sign", { tx_cbor: cbor }]] as const) {
        const r = await h.call("POST", url, body, { "x-feecover-token": t });
        expect(r.status).toBe(401);
        expect(codeOf(r)).toBe("FEE_PROXY_APP_UNKNOWN");
      }
    }
    expect(h.fc.calls).toHaveLength(0);
  });

  it("không có token magic ở dịch vụ ⟹ người gọi không gửi token nhận 401", async () => {
    const fc = fakeFeecover();
    const proxy = new FeeProxy({ settings: DEPLOYMENT.feecover!, issued: new IssuedTxRegistry(), fetch: fc.fetch });
    await expect(proxy.utxo("consume", undefined)).rejects.toMatchObject({ code: "FEE_PROXY_APP_UNKNOWN", httpStatus: 401 });
    // CẶP: cùng proxy, người gọi orilife vẫn đi được.
    await expect(proxy.utxo("consume", ORILIFE_TOKEN)).resolves.toMatchObject({ purpose: "orilife_consume_magic" });
    expect(fc.calls).toHaveLength(1);
  });
});

// ── token không rò ───────────────────────────────────────────────────────────

describe("token không xuất hiện trong lời đáp hay nhật ký", () => {
  it("quét mọi thân lời đáp + nhật ký của một loạt ca dương lẫn âm", async () => {
    const all: string[] = [];
    const replies: (Reply | undefined)[] = [undefined, { status: 422, body: { rule: "L1", message: "m", reasons: [] } }, "throw", "hang",
      { status: 500, body: "x" }, { status: 200, body: { txHash: "00".repeat(32), witnessSet: "a1", netLovelace: 1, feeLovelace: 1 } }];
    for (const rep of replies) {
      const h = harness({ feecover: fakeFeecover(rep === undefined ? {} : { sign: rep, utxo: rep }) });
      await h.call("POST", "/fee/utxo", { route: "consume" });
      await h.call("POST", "/fee/utxo", { route: "consume" }, ORILIFE);
      await h.call("POST", "/fee/utxo", { route: "consume" }, { "x-feecover-token": "sai" });
      const { cbor } = await issueConsume(h);
      await h.call("POST", "/fee/sign", { tx_cbor: cbor });
      await h.call("POST", "/fee/sign", { tx_cbor: cbor }, ORILIFE);
      await h.call("POST", "/fee/sign", { tx_cbor: "zz" });
      await h.call("GET", "/health");
      all.push(JSON.stringify(h.responses), ...h.logs);
    }
    const text = all.join("\n");
    expect(text.length).toBeGreaterThan(1000);
    for (const secret of [MAGIC_TOKEN, ORILIFE_TOKEN, sha(MAGIC_TOKEN), sha(ORILIFE_TOKEN)]) {
      expect(text).not.toContain(secret);
    }
    // Phép quét CẮN được: token thật sự đã đi tới Feecover trong cùng loạt ca.
    expect(text).toContain("FEE_PROXY_REJECTED");
  });
});

// ── source: nguồn trả phí Feecover ký (feecover | sponsor) ──────────────────────

/** `/v1/utxo` trả kèm `source` (Feecover có nguồn sponsor). `undefined` ⟹ không gửi trường đó. */
const utxoReplySource = (source: unknown): Reply => {
  const base = utxoReply(NOW + 600_000) as { status: number; body: Record<string, unknown> };
  return { status: 200, body: source === undefined ? base.body : { ...base.body, source } };
};
/** `/v1/sign` ký đúng tx được gửi, trả `source` theo hàm `pick` (nhận thân yêu cầu). */
const signWithSource = (pick: (b: Record<string, unknown>) => unknown) => (b: Record<string, unknown>): Reply => {
  const r = echoSign(b) as { status: number; body: Record<string, unknown> };
  const s = pick(b);
  return { status: 200, body: s === undefined ? r.body : { ...r.body, source: s } };
};
/** Ghi lượt giữ cho `FEE_PAYER` với nguồn `source` (như `/fee/utxo` ghi sau khi Feecover xác nhận). */
const reserveAs = (h: ReturnType<typeof harness>, source: "feecover" | "sponsor") =>
  h.issued.noteFeeReservation(FEE_PAYER.utxo, NOW + 600_000, FEE_ADDRESS, undefined, source);

describe("source — /fee/utxo + /fee/sign", () => {
  it("CẶP source lạ ⟹ 400 FEE_PROXY_SOURCE_INVALID, Feecover KHÔNG bị gọi (utxo + sign); source hợp lệ ⟹ chuyển tiếp", async () => {
    const h = harness({ feecover: fakeFeecover({ utxo: utxoReplySource("sponsor") }) });
    for (const source of ["owner_address", "SPONSOR", 1, null, ""]) {
      const r = await h.call("POST", "/fee/utxo", { route: "consume", source });
      expect(r.status, JSON.stringify(source)).toBe(400);
      expect(codeOf(r)).toBe("FEE_PROXY_SOURCE_INVALID");
    }
    const { cbor } = await issueConsume(h);
    const s = await h.call("POST", "/fee/sign", { tx_cbor: cbor, source: "bogus" });
    expect(s.status).toBe(400);
    expect(codeOf(s)).toBe("FEE_PROXY_SOURCE_INVALID");
    expect(h.fc.calls).toHaveLength(0);
    const ok = await harness({ feecover: fakeFeecover({ utxo: utxoReplySource("sponsor") }) }).call("POST", "/fee/utxo", { route: "consume", source: "sponsor" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("sponsor vọng sponsor: /fee/utxo gửi &source=sponsor, ghi nguồn vào lượt giữ; /fee/sign chuyển source, thân trả source của Feecover", async () => {
    const h = harness({ feecover: fakeFeecover({ utxo: utxoReplySource("sponsor"), sign: signWithSource(b => b.source) }) });
    const u = await h.call("POST", "/fee/utxo", { route: "consume", source: "sponsor" });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(h.fc.calls[0]!.url).toBe("https://feecover.example/v1/utxo?purpose=consume_magic&source=sponsor");
    expect((u.body as { source?: unknown }).source).toBe("sponsor");
    expect(h.issued.feeReservationSourceOf(FEE_PAYER.utxo)).toBe("sponsor");
    const fp = (u.body as { fee_payer: unknown }).fee_payer;
    const c = await h.call("POST", "/tx/consume", consumeBody({ fee_payer: fp }));
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const { tx_cbor, tx_hash } = c.body as { tx_cbor: string; tx_hash: string };
    const s = await h.call("POST", "/fee/sign", { tx_cbor, source: "sponsor" });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(h.fc.calls[1]!.body).toEqual({ tx_cbor_hex: tx_cbor, purpose: "consume_magic", ref: tx_hash, source: "sponsor" });
    expect(s.body).toEqual({ tx_hash, witness_set: "a100", net_lovelace: "178000", fee_lovelace: "178000", source: "sponsor" });
  });

  it("CẶP xin sponsor mà Feecover KHÔNG trả source ⟹ 502 FEE_SOURCE_NOT_CONFIRMED (utxo: không ghi lượt giữ; sign: không giao chữ ký); Feecover trả source ⟹ 200", async () => {
    const hu = harness({ feecover: fakeFeecover({ utxo: utxoReplySource(undefined) }) });
    const u = await hu.call("POST", "/fee/utxo", { route: "consume", source: "sponsor" });
    expect(u.status).toBe(502);
    expect(codeOf(u)).toBe("FEE_SOURCE_NOT_CONFIRMED");
    expect(hu.issued.feeReservationOf(FEE_PAYER.utxo)).toBeUndefined();

    const hs = harness({ feecover: fakeFeecover({ sign: signWithSource(() => undefined) }) });
    reserveAs(hs, "sponsor");
    const { cbor, hash } = await issueConsume(hs);
    const s = await hs.call("POST", "/fee/sign", { tx_cbor: cbor, source: "sponsor" });
    expect(s.status).toBe(502);
    expect(codeOf(s)).toBe("FEE_SOURCE_NOT_CONFIRMED");
    expect(detailsOf(s)).toEqual({ tx_hash: hash, source: "sponsor" });
    expect(JSON.stringify(s.body)).not.toContain("a100");

    const ok = harness({ feecover: fakeFeecover({ sign: signWithSource(() => "sponsor") }) });
    reserveAs(ok, "sponsor");
    const r = await ok.call("POST", "/fee/sign", { tx_cbor: (await issueConsume(ok)).cbor, source: "sponsor" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("CẶP feecover / vắng mà Feecover KHÔNG trả source ⟹ thân KHÔNG có source (bản Feecover cũ); Feecover trả source feecover ⟹ có", async () => {
    const old = harness();
    const u = await old.call("POST", "/fee/utxo", { route: "consume" });
    expect(u.status).toBe(200);
    expect("source" in (u.body as object)).toBe(false);
    const { cbor } = await issueConsume(old);
    const s = await old.call("POST", "/fee/sign", { tx_cbor: cbor });
    expect(s.status).toBe(200);
    expect("source" in (s.body as object)).toBe(false);
    expect("source" in old.fc.calls[1]!.body!).toBe(false);
    const explicit = await old.call("POST", "/fee/sign", { tx_cbor: cbor, source: "feecover" });
    expect(explicit.status).toBe(200);
    expect("source" in (explicit.body as object)).toBe(false);

    const neu = harness({ feecover: fakeFeecover({ utxo: utxoReplySource("feecover"), sign: signWithSource(() => "feecover") }) });
    const u2 = await neu.call("POST", "/fee/utxo", { route: "consume" });
    expect((u2.body as { source?: unknown }).source).toBe("feecover");
    const s2 = await neu.call("POST", "/fee/sign", { tx_cbor: (await issueConsume(neu)).cbor });
    expect((s2.body as { source?: unknown }).source).toBe("feecover");
  });

  it("Feecover trả source KHÁC yêu cầu ⟹ vọng ĐÚNG giá trị của Feecover (app tự từ chối), không giá trị đã xin", async () => {
    const hs = harness({ feecover: fakeFeecover({ sign: signWithSource(() => "feecover") }) });
    reserveAs(hs, "sponsor");
    const s = await hs.call("POST", "/fee/sign", { tx_cbor: (await issueConsume(hs)).cbor, source: "sponsor" });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect((s.body as { source?: unknown }).source).toBe("feecover");

    // /fee/utxo: xin sponsor, Feecover phát UTxO nguồn feecover ⟹ vọng feecover và lượt giữ ghi feecover.
    const hu = harness({ feecover: fakeFeecover({ utxo: utxoReplySource("feecover") }) });
    const u = await hu.call("POST", "/fee/utxo", { route: "consume", source: "sponsor" });
    expect(u.status).toBe(200);
    expect((u.body as { source?: unknown }).source).toBe("feecover");
    expect(hu.issued.feeReservationSourceOf(FEE_PAYER.utxo)).toBe("feecover");
  });

  it("CẶP L38: Feecover 422 / 403 cho nguồn sponsor ⟹ chuyển nguyên mã + rule + message dưới FEE_PROXY_REJECTED", async () => {
    const h422 = harness({ feecover: fakeFeecover({
      sign: { status: 422, body: { rule: "L38", message: "ngân sách sponsor 24 giờ đã dùng hết.", reasons: ["ngân sách sponsor 24 giờ đã dùng hết."] } },
    }) });
    reserveAs(h422, "sponsor");
    const s = await h422.call("POST", "/fee/sign", { tx_cbor: (await issueConsume(h422)).cbor, source: "sponsor" });
    expect(s.status).toBe(422);
    expect(codeOf(s)).toBe("FEE_PROXY_REJECTED");
    expect(detailsOf(s)).toMatchObject({ upstream_status: 422, rule: "L38", message: "ngân sách sponsor 24 giờ đã dùng hết." });

    const h403 = harness({ feecover: fakeFeecover({ utxo: { status: 403, body: { rule: "L38", message: "chủ không có DID." } } }) });
    const u = await h403.call("POST", "/fee/utxo", { route: "consume", source: "sponsor" });
    expect(u.status).toBe(403);
    expect(codeOf(u)).toBe("FEE_PROXY_REJECTED");
    expect(detailsOf(u)).toEqual({ upstream_status: 403, rule: "L38", message: "chủ không có DID." });
  });

  it("CẶP /fee/sign source KHÁC nguồn lượt giữ ⟹ 400 FEE_PROXY_SOURCE_MISMATCH, Feecover KHÔNG bị gọi; cùng nguồn ⟹ 200", async () => {
    const hf = harness();
    const { cbor } = await issueConsume(hf); // lượt giữ nguồn feecover
    const a = await hf.call("POST", "/fee/sign", { tx_cbor: cbor, source: "sponsor" });
    expect(a.status).toBe(400);
    expect(codeOf(a)).toBe("FEE_PROXY_SOURCE_MISMATCH");
    expect(detailsOf(a)).toMatchObject({ source: "sponsor", reserved_source: "feecover" });

    const hs = harness({ feecover: fakeFeecover({ sign: signWithSource(b => b.source) }) });
    reserveAs(hs, "sponsor");
    const t = await issueConsume(hs);
    const b = await hs.call("POST", "/fee/sign", { tx_cbor: t.cbor }); // vắng = feecover
    expect(b.status).toBe(400);
    expect(codeOf(b)).toBe("FEE_PROXY_SOURCE_MISMATCH");
    expect(hf.fc.calls).toHaveLength(0);
    expect(hs.fc.calls).toHaveLength(0);

    expect((await hf.call("POST", "/fee/sign", { tx_cbor: cbor, source: "feecover" })).status).toBe(200);
    expect((await hs.call("POST", "/fee/sign", { tx_cbor: t.cbor, source: "sponsor" })).status).toBe(200);
  });
});
