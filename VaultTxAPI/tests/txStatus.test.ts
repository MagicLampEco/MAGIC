// VaultTxAPI/tests/txStatus.test.ts — `GET /tx/status/{tx_hash}`: chuỗi trước, rồi mempool; chỉ đọc.
//
// Điều cắn của đường này: một lượt gọi HỎNG không được đọc thành `not_found`. Bên gọi (Core) áp
// `not_found` ∧ `now > expires_at` ⟹ "tx không bao giờ lên chuỗi" rồi ghi nợ theo kết luận đó; một
// 5xx của nhà cung cấp mà rơi thành `not_found` là ghi nợ một tx đang nằm trong khối. Nên mỗi bước
// (khối, mempool) có ca 404 ⟹ đi tiếp / `not_found`, và ca mã-khác ⟹ 502 có mã riêng, đứng cạnh nhau.

import { afterEach, describe, expect, it, vi } from "vitest";

import { BlockfrostChainReader, RecordedChainReader, type ChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment, type Deployment } from "../src/config.js";
import { ChainUnavailableError } from "../src/errors.js";
import { handle, type RouterDeps } from "../src/http.js";
import { EXPIRED_RETENTION_MS, IssuedTxRegistry, OwnerLockTable } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { RecordedTxBuilder } from "../src/txBuilder.js";
import { CLOCK_SKEW_MARGIN_MS } from "../src/validity.js";
import { LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, SHARD_ADDRESS, VAULT_ADDRESS } from "./fixtures/preview.js";
import { GEN_V2_REF_SCRIPTS, genV2Json } from "./fixtures/genV2.js";
import { ENGAGE_ADDRESS } from "./fixtures/engage.js";

const NOW = 1_789_100_703_000;
const TX = "18eafef96e7e641dbd8a48b41bf1b36a26be3de31c23d7479a140aec600ecd62";
const BLOCK = "14ae149dd07cd25ce37a6a4336f3939446bd68d9ad4a2e820201a474cc3ad72f";
const BLOCK_TIME_S = 1_789_100_000;
const SLOT = 108_806_400;

const TIP: ChainTip = { blockHeight: 4_651_976, blockHash: BLOCK, blockTimePosixMs: BigInt(NOW) };

const DEPLOYMENT: Deployment = parseDeployment(JSON.stringify({
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
}), "Preview");

/** Đếm lượt gọi chuỗi — ca 400 phải chết với 0 lượt. */
function counting(inner: ChainReader): { chain: ChainReader; calls: () => number } {
  let n = 0;
  const chain: ChainReader = {
    label: inner.label,
    utxosAt: a => inner.utxosAt(a),
    utxosByOutRef: r => inner.utxosByOutRef(r),
    utxosByUnit: u => inner.utxosByUnit(u),
    tip: () => inner.tip(),
    submitTx: c => inner.submitTx(c),
    rewardAccount: a => inner.rewardAccount(a),
    txStatus: h => { n++; return inner.txStatus(h); },
  };
  return { chain, calls: () => n };
}

function harness(opts: { chain?: ChainReader; token?: string; clock?: { t: number } } = {}) {
  const issued = new IssuedTxRegistry();
  const { chain, calls } = counting(opts.chain ?? new RecordedChainReader({}, TIP));
  const service = new VaultTxService({
    network: "Preview",
    deployment: DEPLOYMENT,
    chain,
    builder: new RecordedTxBuilder({}),
    locks: new OwnerLockTable(180_000),
    issued,
    lockTtlMs: 180_000,
    now: () => opts.clock?.t ?? NOW,
  });
  const internal: unknown[] = [];
  const router: RouterDeps = {
    service,
    deploymentSource: DEPLOYMENT.source,
    vaultScopes: DEPLOYMENT.vaults,
    network: "Preview",
    chainLabel: "recorded",
    changeAddressStrategy: "enterprise_from_owner_pkh",
    token: opts.token ?? "",
    logInternal: (_ref, cause) => internal.push(cause),
  };
  return { service, issued, router, calls, internal };
}

const get = (url: string, headers: Record<string, string> = {}) => ({ method: "GET", url, headers });

function recorded(statuses: RecordedChainReader["txStatuses"]): RecordedChainReader {
  const r = new RecordedChainReader({}, TIP);
  r.txStatuses = statuses;
  return r;
}

afterEach(() => { vi.unstubAllGlobals(); });

// ── tầng HTTP ────────────────────────────────────────────────────────────────

describe("GET /tx/status/{tx_hash} — ba trạng thái", () => {
  it("in_chain ⟹ block (hash khối), slot, block_time ISO; tx không do dịch vụ phát ⟹ không expires_at, không server_time", async () => {
    const h = harness({ chain: recorded({
      [TX]: { state: "in_chain", blockHash: BLOCK, slot: SLOT, blockTimePosixMs: BigInt(BLOCK_TIME_S) * 1000n },
    }) });
    const out = await handle(get(`/tx/status/${TX}`), h.router);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      tx_hash: TX, state: "in_chain", block: BLOCK, slot: SLOT,
      block_time: new Date(BLOCK_TIME_S * 1000).toISOString(),
    });
  });

  it("in_mempool ⟹ không mang block/slot/block_time", async () => {
    const h = harness({ chain: recorded({ [TX]: { state: "in_mempool" } }) });
    const out = await handle(get(`/tx/status/${TX}`), h.router);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ tx_hash: TX, state: "in_mempool" });
  });

  it("not_found ⟹ 200 với state not_found (câu trả lời thật của nút, không phải lỗi)", async () => {
    const h = harness();
    const out = await handle(get(`/tx/status/${TX}`), h.router);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ tx_hash: TX, state: "not_found" });
    expect(h.calls()).toBe(1);
  });
});

describe("GET /tx/status — 400 TX_HASH_INVALID, không chạm chuỗi", () => {
  for (const [label, url] of [
    ["63 hex", `/tx/status/${TX.slice(1)}`],
    ["65 hex", `/tx/status/${TX}0`],
    ["hex HOA", `/tx/status/${TX.toUpperCase()}`],
    ["ký tự ngoài hex", `/tx/status/${"g".repeat(64)}`],
    ["thêm đoạn đường", `/tx/status/${TX}/x`],
    ["vắng hash có gạch chéo", "/tx/status/"],
    ["vắng hash", "/tx/status"],
  ] as const) {
    it(`${label} ⟹ 400 TX_HASH_INVALID, 0 lượt gọi chuỗi`, async () => {
      const h = harness();
      const out = await handle(get(url), h.router);
      expect(out.status).toBe(400);
      expect((out.body.error as { code: string }).code).toBe("TX_HASH_INVALID");
      expect(h.calls()).toBe(0);
    });
  }
});

describe("GET /tx/status — nhà cung cấp hỏng ⟹ 502 mã riêng, KHÔNG BAO GIỜ not_found", () => {
  it("chuỗi ném ChainUnavailableError ⟹ 502 TX_STATUS_PROVIDER_UNAVAILABLE, giữ details của nút", async () => {
    const dead = new RecordedChainReader({}, TIP, [], new ChainUnavailableError("nút chết", { transport: "timeout", stage: "chain" }));
    const h = harness({ chain: dead });
    const out = await handle(get(`/tx/status/${TX}`), h.router);
    expect(out.status).toBe(502);
    const e = out.body.error as { code: string; details: Record<string, unknown> };
    expect(e.code).toBe("TX_STATUS_PROVIDER_UNAVAILABLE");
    expect(e.details).toMatchObject({ transport: "timeout", stage: "chain", tx_hash: TX });
    expect(out.body.state).toBeUndefined();
  });

  it("Blockfrost thật (fetch giả): /txs 404 rồi /mempool 503 ⟹ 502, không phải not_found", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url).pathname.replace(/^\/api\/v0/, "");
      if (path === `/txs/${TX}`) return new Response('{"status_code":404}', { status: 404 });
      if (path === `/mempool/${TX}`) return new Response('{"status_code":503}', { status: 503 });
      return new Response("", { status: 500 });
    });
    const h = harness({ chain: bf() });
    const out = await handle(get(`/tx/status/${TX}`), h.router);
    expect(out.status).toBe(502);
    expect(out.body.error).toMatchObject({ code: "TX_STATUS_PROVIDER_UNAVAILABLE", details: { stage: "mempool", node_http_status: 503 } });
  });

  it("CỰC ĐỐI cùng fetch giả, mempool 404 ⟹ 200 not_found", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"status_code":404}', { status: 404 }));
    const h = harness({ chain: bf() });
    const out = await handle(get(`/tx/status/${TX}`), h.router);
    expect(out.status).toBe(200);
    expect(out.body.state).toBe("not_found");
  });
});

describe("GET /tx/status — CẶP ca expires_at", () => {
  const VALID_TO = NOW + 600_000;

  it("tx do dịch vụ phát ⟹ expires_at = validTo ISO (cùng nguồn route dựng) + server_time = đồng hồ dịch vụ", async () => {
    const h = harness();
    h.issued.record(TX, NOW, { route: "consume", validToMs: VALID_TO });
    const out = await handle(get(`/tx/status/${TX}`), h.router);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      tx_hash: TX, state: "not_found",
      expires_at: new Date(VALID_TO).toISOString(),
      server_time: new Date(NOW).toISOString(),
    });
  });

  it("CỰC ĐỐI: cùng hash, KHÔNG có trong sổ phát-hành ⟹ không expires_at, không server_time", async () => {
    const h = harness();
    h.issued.record("ab".repeat(32), NOW, { route: "consume", validToMs: VALID_TO });
    const out = await handle(get(`/tx/status/${TX}`), h.router);
    expect(out.body).toEqual({ tx_hash: TX, state: "not_found" });
  });

  it("quá hạn nhưng còn trong EXPIRED_RETENTION_MS ⟹ vẫn trả expires_at (đúng ca bên gọi cần để kết luận)", async () => {
    const clock = { t: NOW };
    const h = harness({ clock });
    h.issued.record(TX, NOW, { route: "consume", validToMs: VALID_TO });
    clock.t = VALID_TO + CLOCK_SKEW_MARGIN_MS + 1;
    const out = await handle(get(`/tx/status/${TX}`), h.router);
    expect(out.body.expires_at).toBe(new Date(VALID_TO).toISOString());
    expect(out.body.server_time).toBe(new Date(clock.t).toISOString());
  });

  it("quá khoảng giữ lại ⟹ không còn expires_at", async () => {
    const clock = { t: NOW };
    const h = harness({ clock });
    h.issued.record(TX, NOW, { route: "consume", validToMs: VALID_TO });
    clock.t = VALID_TO + CLOCK_SKEW_MARGIN_MS + EXPIRED_RETENTION_MS;
    const out = await handle(get(`/tx/status/${TX}`), h.router);
    expect(out.body).toEqual({ tx_hash: TX, state: "not_found" });
  });

  it("tra trạng thái KHÔNG đổi sổ: /tx/submit vẫn thấy tx đó là đã phát, chưa nộp", async () => {
    const h = harness();
    h.issued.record(TX, NOW, { route: "consume", validToMs: VALID_TO });
    await handle(get(`/tx/status/${TX}`), h.router);
    const e = h.issued.lookup(TX, NOW);
    expect(e).not.toBeNull();
    expect(e!.submittedAtMs).toBeUndefined();
    expect(e!.submitUnconfirmedAtMs).toBeUndefined();
  });
});

describe("GET /tx/status — method + thẻ bài", () => {
  it("POST ⟹ 405", async () => {
    const out = await handle({ method: "POST", url: `/tx/status/${TX}`, headers: {}, body: {} }, harness().router);
    expect(out.status).toBe(405);
  });

  it("thẻ bài như các đường /tx/* khác: thiếu ⟹ 401; đúng ⟹ 200", async () => {
    const h = harness({ token: "t0ken" });
    expect((await handle(get(`/tx/status/${TX}`), h.router)).status).toBe(401);
    expect(h.calls()).toBe(0);
    const ok = await handle(get(`/tx/status/${TX}`, { authorization: "Bearer t0ken" }), h.router);
    expect(ok.status).toBe(200);
  });
});

// ── tầng nhà cung cấp: BlockfrostChainReader.txStatus ─────────────────────────

const bf = (): BlockfrostChainReader =>
  new BlockfrostChainReader({ baseUrl: "https://cardano-preview.blockfrost.io/api/v0", projectId: "test", timeoutMs: 50 });

function stub(routes: Record<string, { status: number; body?: unknown }>): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url).pathname.replace(/^\/api\/v0/, "");
    calls.push(path);
    const r = routes[path] ?? { status: 404, body: { status_code: 404 } };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  });
  return calls;
}

describe("BlockfrostChainReader.txStatus", () => {
  it("/txs 200 ⟹ in_chain, giây → mili-giây; KHÔNG tra mempool", async () => {
    const calls = stub({ [`/txs/${TX}`]: { status: 200, body: { hash: TX, block: BLOCK, block_height: 1, slot: SLOT, block_time: BLOCK_TIME_S } } });
    expect(await bf().txStatus(TX)).toEqual({
      state: "in_chain", blockHash: BLOCK, slot: SLOT, blockTimePosixMs: BigInt(BLOCK_TIME_S) * 1000n,
    });
    expect(calls).toEqual([`/txs/${TX}`]);
  });

  it("/txs 404, /mempool 200 ⟹ in_mempool", async () => {
    const calls = stub({ [`/mempool/${TX}`]: { status: 200, body: { tx: { hash: TX } } } });
    expect(await bf().txStatus(TX)).toEqual({ state: "in_mempool" });
    expect(calls).toEqual([`/txs/${TX}`, `/mempool/${TX}`]);
  });

  it("/txs 404, /mempool 404 ⟹ not_found", async () => {
    stub({});
    expect(await bf().txStatus(TX)).toEqual({ state: "not_found" });
  });

  it("/txs 500 ⟹ NÉM (stage chain), không tra tiếp mempool", async () => {
    const calls = stub({ [`/txs/${TX}`]: { status: 500, body: { status_code: 500 } } });
    await expect(bf().txStatus(TX)).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE", details: { stage: "chain", node_http_status: 500 } });
    expect(calls).toEqual([`/txs/${TX}`]);
  });

  it("/txs 429 (hết hạn mức) ⟹ NÉM, không phải not_found", async () => {
    stub({ [`/txs/${TX}`]: { status: 429, body: { status_code: 429 } } });
    await expect(bf().txStatus(TX)).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it("/txs 200 thiếu slot ⟹ NÉM, không đệm", async () => {
    stub({ [`/txs/${TX}`]: { status: 200, body: { block: BLOCK, block_time: BLOCK_TIME_S } } });
    await expect(bf().txStatus(TX)).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE", details: { stage: "chain" } });
  });

  it("/txs 200 với block_time là slot (nhỏ hơn mốc tỉnh táo) ⟹ NÉM", async () => {
    stub({ [`/txs/${TX}`]: { status: 200, body: { block: BLOCK, slot: SLOT, block_time: SLOT } } });
    await expect(bf().txStatus(TX)).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it("quá giờ ⟹ NÉM transport timeout", async () => {
    vi.stubGlobal("fetch", (_url: string, init: { signal: AbortSignal }) => new Promise((_res, rej) => {
      init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    await expect(bf().txStatus(TX)).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE", details: { transport: "timeout" } });
  });
});
