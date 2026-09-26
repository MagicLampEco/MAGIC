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
import { ChainDidPaymentAnchorReader } from "../src/funding.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { txBodyHash } from "../src/summary.js";
import { RecordedTxBuilder, enterpriseAddressOf } from "../src/txBuilder.js";
import { ENGAGE_ADDRESS, threadUtxo } from "./fixtures/engage.js";
import {
  INPUT_TX_HASH, LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, LAMP_UNIT, OWNER_PKH,
  SHARD_ADDRESS, VAULT_ADDRESS, VAULT_ID_UNIT, datumHex,
} from "./fixtures/preview.js";
import { buildTxCbor, type TxOutputSpec } from "./fixtures/tx.js";

const TTL = 180_000;
const REGISTRY_TTL = TTL * 4;
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
    },
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
const VAULT_UTXO = utxo(INPUT_TX_HASH, 0, VAULT_ADDRESS,
  { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n }, datumHex({ lampLockedOildrop: 2_000_000n }));
const FEE_UTXO = utxo("fa".repeat(32), 0, FEE_ADDRESS, { lovelace: 10_000_000n });

function consumeTx(): string {
  const outputs: TxOutputSpec[] = [
    {
      address: VAULT_ADDRESS,
      assets: { lovelace: 5_659_030n, [LAMP_UNIT]: 1_001_000_000n, [VAULT_ID_UNIT]: 1n },
      inlineDatumHex: datumHex({ lampLockedOildrop: 23_000_000n, genScheduleCount: 1 }),
    },
    { address: FEE_ADDRESS, assets: { lovelace: 10_000_000n - CONSUME_FEE } },
  ];
  return buildTxCbor({
    inputs: [ref(VAULT_UTXO), ref(FEE_UTXO)],
    feeLovelace: CONSUME_FEE,
    outputs,
    requiredSigners: [OWNER_PKH],
    collateralInputs: [ref(FEE_UTXO)],
    collateralReturn: { address: FEE_ADDRESS, assets: { lovelace: 7_000_000n } },
    ttlSlot: BigInt(unixTimeToSlot("Preview", NOW + 1_800_000)),
  });
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
const ANCHOR = utxo("ab".repeat(32), 0, DP_ADDRESS, { lovelace: 2_000_000n, [`${ANCHOR_POLICY}01`]: 1n });
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
      { address: DP_ADDRESS, assets: { lovelace: 2_000_000n, [LAMP_UNIT]: 99_000_000n } },
      { address: FEE_ADDRESS, assets: { lovelace: 10_000_000n - CV_FEE } },
    ],
    collateralInputs: [ref(FEE_UTXO)],
    collateralReturn: { address: FEE_ADDRESS, assets: { lovelace: 7_000_000n } },
    spendRedeemers: [{ index: 0, dataHex: "d87980" }, { index: 1, dataHex: "d87980" }],
    ttlSlot: BigInt(unixTimeToSlot("Preview", NOW + 1_800_000)),
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

function harness(opts: { feecover?: ReturnType<typeof fakeFeecover>; proxy?: boolean } = {}) {
  const clock = { t: NOW };
  const chain = new RecordedChainReader(
    { [VAULT_ADDRESS]: [VAULT_UTXO], [ENGAGE_ADDRESS]: [threadUtxo(KEY_OWNER, "7e".repeat(32))], [DP_ADDRESS]: [DP1, DP2] },
    TIP,
    [VAULT_UTXO, FEE_UTXO, ANCHOR],
  );
  const cbor = consumeTx();
  const builder = new RecordedTxBuilder({ consume: cbor, schedule_commit: cbor, create_vault: fundedTx() }, VAULT_ID_UNIT);
  const issued = new IssuedTxRegistry(REGISTRY_TTL);
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
  return { clock, fc, call, responses, logs, issued };
}

const codeOf = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const detailsOf = (r: { body: unknown }) => (r.body as { error: { details: Record<string, unknown> } }).error.details;
const ORILIFE = { "x-feecover-token": ORILIFE_TOKEN };
const consumeBody = (over: Record<string, unknown> = {}) =>
  ({ owner_pkh: OWNER_PKH, op_type: 1, op_count: "2", fee_payer: FEE_PAYER, ...over });

/** Dựng một tx tiêu MAGIC có ví trả phí, trả CBOR + hash. */
async function issueConsume(h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) {
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
      fee_payer: { utxo: `${"fa".repeat(32)}#0`, address: FEE_ADDRESS },
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
  });
});

// ── hạn ký = giờ giữ chỗ của UTxO phí ────────────────────────────────────────

describe("sổ phát-hành: hạn ký theo reserved_until", () => {
  it("UTxO qua /fee/utxo: ký được TRƯỚC reserved_until; SAU mốc đó ⟹ 403 (dù hạn sổ còn)", async () => {
    const h = harness({ feecover: fakeFeecover({ utxo: utxoReply(NOW + 60_000) }) });
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

  it("CẶP: app tự đưa fee_payer (không qua /fee/utxo) ⟹ hạn ký = hạn sổ", async () => {
    const h = harness();
    const { cbor } = await issueConsume(h);
    h.clock.t = NOW + 61_000;
    expect((await h.call("POST", "/fee/sign", { tx_cbor: cbor })).status).toBe(200);
    h.clock.t = NOW + REGISTRY_TTL + 1;
    expect(codeOf(await h.call("POST", "/fee/sign", { tx_cbor: cbor }))).toBe("FEE_PROXY_TX_NOT_ISSUED");
  });

  it("reserved_until DÀI hơn hạn sổ ⟹ dòng sống tới reserved_until", async () => {
    const h = harness({ feecover: fakeFeecover({ utxo: utxoReply(NOW + REGISTRY_TTL + 60_000) }) });
    await h.call("POST", "/fee/utxo", { route: "consume" });
    const { cbor } = await issueConsume(h);
    h.clock.t = NOW + REGISTRY_TTL + 30_000;
    expect((await h.call("POST", "/fee/sign", { tx_cbor: cbor })).status).toBe(200);
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
    const proxy = new FeeProxy({ settings: DEPLOYMENT.feecover!, issued: new IssuedTxRegistry(REGISTRY_TTL), fetch: fc.fetch });
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
