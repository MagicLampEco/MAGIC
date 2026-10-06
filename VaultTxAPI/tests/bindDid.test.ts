// VaultTxAPI/tests/bindDid.test.ts — `POST /tx/bind-did`: gắn PersonDID vào thread Engage (BindDID).
//
// Bộ dựng là `RecordedTxBuilder`: nó trả CBOR ghi sẵn, không ngó tham số — nên mọi ca 422 dưới đây
// đỏ vì CỔNG ĐỌC LẠI (`engage.ts` ▸ `checkBindDidTx`), không vì bộ dựng từ chối. Ca 400/404/409/501
// đỏ TRƯỚC bộ dựng: mỗi ca đòi `builder.lastCall === null`.

import { type UTxO } from "@lucid-evolution/lucid";
import { encodeBindDidRedeemer } from "@magiclamp/consumemagic";
import { describe, expect, it } from "vitest";

import { BUILD_ROUTE_OF_PATH } from "../src/buildRequest.js";
import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { parseDeployment, type Deployment } from "../src/config.js";
import { handle, type RouterDeps } from "../src/http.js";
import { ISSUED_ROUTES, IssuedTxRegistry, OwnerLockTable, PendingSpends } from "../src/locks.js";
import { VaultTxService } from "../src/service.js";
import { RecordedTxBuilder, enterpriseAddressOf } from "../src/txBuilder.js";
import { ENGAGE_ADDRESS, ENGAGE_SCRIPT_HASH, engageDatumHex, threadUtxo, type EngageDatumOpts } from "./fixtures/engage.js";
import {
  LAMP_ASSET_NAME_HEX, LAMP_POLICY_ID, OTHER_OWNER_PKH, OWNER_PKH, SHARD_ADDRESS, VAULT_ADDRESS,
} from "./fixtures/preview.js";
import { buildTxCbor, prerecordedTtlSlot } from "./fixtures/tx.js";

const TTL = 180_000;
const NOW = 1_789_100_703_000;
const FIXTURE_TTL_SLOT = prerecordedTtlSlot(NOW, undefined, "Preview");
const TIP: ChainTip = { blockHeight: 1, blockHash: "14".repeat(32), blockTimePosixMs: BigInt(NOW) };
const KEY_OWNER = { type: "key" as const, hash: OWNER_PKH };
const OTHER_OWNER = { type: "key" as const, hash: OTHER_OWNER_PKH };
const CHANGE_ADDRESS = enterpriseAddressOf("Preview", OWNER_PKH);
const FEE_ADDRESS = enterpriseAddressOf("Preview", "fe".repeat(28));

const DID = "d1".repeat(32);
const OTHER_DID = "d2".repeat(32);
/** Trục kế toán KHÁC 0 — để phép đọc lại có gì mà so "giữ nguyên". */
const ACCOUNTING: EngageDatumOpts = { consumedCount: 3n, lastEpoch: 7n, consumedNanogic: 5_000n };
const THREAD_TX = "7e".repeat(32);
const NFT_NAME = "01";
const THREAD_UNIT = ENGAGE_SCRIPT_HASH + NFT_NAME;
/** Ví trả phí của chủ: xếp SAU thread trong danh sách input đã sắp ⟹ thread ở chỉ số 0. */
const WALLET_IN = { txHash: "c0".repeat(32), outputIndex: 0 };

/** Thread của chủ; hai biến thể chỉ khác đúng ô `did_commit`. */
const threadWith = (didCommit: string, owner = KEY_OWNER): UTxO =>
  threadUtxo(owner, THREAD_TX, 0, NFT_NAME, engageDatumHex(owner, { ...ACCOUNTING, didCommit }));
const UNBOUND = threadWith("");

const DEPLOYMENT: Deployment = parseDeployment(JSON.stringify({
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
}), "Preview");

interface BindTxOpts {
  redeemerHex?: string;
  outLovelace?: bigint;
  outDid?: string;
  outAccounting?: EngageDatumOpts;
  outAddress?: string;
  signers?: string[];
  mint?: Record<string, bigint>;
}

/** Tx BindDID "đúng": tiêu thread + một UTxO ví, trả thread nguyên value, datum chỉ đổi did_commit. */
function bindTx(o: BindTxOpts = {}): string {
  return buildTxCbor({ ttlSlot: FIXTURE_TTL_SLOT,
    inputs: [{ txHash: THREAD_TX, outputIndex: 0 }, WALLET_IN],
    feeLovelace: 190_000n,
    ...(o.mint === undefined ? {} : { mint: o.mint }),
    outputs: [
      {
        address: o.outAddress ?? ENGAGE_ADDRESS,
        assets: { lovelace: o.outLovelace ?? 2_000_000n, [THREAD_UNIT]: 1n },
        inlineDatumHex: engageDatumHex(KEY_OWNER, { ...ACCOUNTING, ...o.outAccounting, didCommit: o.outDid ?? DID }),
      },
      { address: CHANGE_ADDRESS, assets: { lovelace: 7_810_000n } },
    ],
    requiredSigners: o.signers ?? [OWNER_PKH],
    spendRedeemers: [{ index: 0, dataHex: o.redeemerHex ?? encodeBindDidRedeemer() }],
  });
}

function harness(opts: { threads?: UTxO[]; cbor?: string; pending?: PendingSpends } = {}) {
  const chain = new RecordedChainReader(
    { [VAULT_ADDRESS]: [], [ENGAGE_ADDRESS]: opts.threads ?? [UNBOUND] },
    TIP,
    [],
  );
  const builder = new RecordedTxBuilder({ bind_did: opts.cbor ?? bindTx() });
  builder.coinsPerUtxoByteValue = 4_310n;
  const issued = new IssuedTxRegistry();
  const locks = new OwnerLockTable(TTL);
  const service = new VaultTxService({
    network: "Preview", deployment: DEPLOYMENT, chain, builder, locks, issued, lockTtlMs: TTL, now: () => NOW,
    ...(opts.pending === undefined ? {} : { pending: opts.pending }),
  });
  const router: RouterDeps = {
    service, deploymentSource: DEPLOYMENT.source, vaultScopes: DEPLOYMENT.vaults, network: "Preview",
    chainLabel: "recorded", changeAddressStrategy: "enterprise_from_owner_pkh", token: "", logInternal: () => {},
  };
  return { builder, router, issued, locks };
}

const post = (url: string, body: unknown) => ({ method: "POST", url, headers: {}, body });
const codeOf = (r: { body: unknown }) => (r.body as { error: { code: string } }).error.code;
const detailsOf = (r: { body: unknown }) => (r.body as { error: { details: Record<string, unknown> } }).error.details;
const bind = (over: Record<string, unknown> = {}) =>
  post("/tx/bind-did", { owner: KEY_OWNER, did_commit: DID, ...over });

// ── dương ────────────────────────────────────────────────────────────────────

describe("/tx/bind-did — dương", () => {
  it("thread chưa gắn DID ⟹ 200; did_commit + value + trục kế toán đọc TỪ CBOR; tx vào sổ phát hành", async () => {
    const h = harness();
    const r = await handle(bind(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body as Record<string, unknown> & { summary: { engage: Record<string, unknown> }; tx_hash: string };
    expect(Object.keys(b).sort()).toEqual([
      "did_commit", "engage_address", "engage_nft", "expires_at", "expires_reason", "owner", "required_signers", "server_time", "summary",
      "tx_cbor", "tx_hash", "witness_notes",
    ]);
    expect(b.did_commit).toBe(DID);
    expect(b.engage_nft).toBe(THREAD_UNIT);
    expect(b.engage_address).toBe(ENGAGE_ADDRESS);
    expect(b.required_signers).toEqual([OWNER_PKH]);
    expect(b.summary).toMatchObject({ requested_intent: "bind_did", network: "Preview", fee_lovelace: "190000" });
    expect(b.summary.engage).toEqual({
      nft_unit: THREAD_UNIT, address: ENGAGE_ADDRESS, input_ref: `${THREAD_TX}#0`, output_index: 0,
      lovelace: "2000000", owner: KEY_OWNER, consumed_count: "3", last_epoch: "7", consumed_nanogic: "5000",
      did_commit_before: "", did_commit: DID,
    });
    expect(h.issued.lookup(b.tx_hash, NOW)?.route).toBe("bind-did");
    expect(h.builder.lastCall).toMatchObject({ route: "bind_did", params: { didCommit: DID }, changeAddress: CHANGE_ADDRESS });
    expect(h.builder.lastCall?.engageUtxo).toBe(UNBOUND);
    // Khoá chủ (khoá = pkh với chủ khoá, `owner.ts` ▸ `ownerLockKey`) giữ tới lúc nộp, mang đúng hash vừa phát.
    expect(h.locks.peek(OWNER_PKH, NOW)?.txHash).toBe(b.tx_hash);
  });

  it("owner_pkh (bí danh) + change_address tường minh ⟹ 200, bộ dựng nhận đúng change_address", async () => {
    const h = harness();
    const r = await handle(post("/tx/bind-did", { owner_pkh: OWNER_PKH, did_commit: DID, change_address: CHANGE_ADDRESS }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.builder.lastCall?.changeAddress).toBe(CHANGE_ADDRESS);
  });

  it("đường change_address: bộ dựng nhận validToMs = cận đã lên kế hoạch (đỉnh + 15′), expires_reason = tx_validity", async () => {
    // Đỉnh chuỗi = NOW (tròn giây ⟹ căn slot không dời); hạn ký mặc định 15′ (`validity.ts` ▸ DEFAULT_TX_VALIDITY_MS).
    const h = harness();
    const r = await handle(post("/tx/bind-did", { owner_pkh: OWNER_PKH, did_commit: DID, change_address: CHANGE_ADDRESS }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.builder.lastCall?.changeAddress).toBe(CHANGE_ADDRESS);
    expect(h.builder.lastCall?.feePayerUtxo).toBeUndefined();
    expect(h.builder.lastCall?.validToMs).toBe(BigInt(NOW) + 900_000n);
    expect((r.body as { expires_reason: string }).expires_reason).toBe("tx_validity");
  });
});

// ── 400: did_commit sai dạng ─────────────────────────────────────────────────

describe("/tx/bind-did — 400 DID_COMMIT_INVALID (bộ dựng không bị gọi, không giữ khoá)", () => {
  const cases: [string, unknown][] = [
    ["63 ký tự", "ab".repeat(31) + "a"],
    ["65 ký tự", "ab".repeat(32) + "a"],
    ["64 ký tự nhưng không phải hex", "zz".repeat(32)],
    ["chuỗi rỗng", ""],
    ["vắng trường", undefined],
    ["số JSON", 123],
    ["hex chữ HOA", "D1".repeat(32)],
  ];
  for (const [name, v] of cases) {
    it(`${name} ⟹ 400 DID_COMMIT_INVALID`, async () => {
      const h = harness();
      const r = await handle(bind({ did_commit: v }), h.router);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(codeOf(r)).toBe("DID_COMMIT_INVALID");
      expect(h.builder.lastCall).toBeNull();
      expect(h.locks.size()).toBe(0);
    });
  }

  it("CẶP: đúng 64 hex thường ⟹ qua cổng (200)", async () => {
    const h = harness();
    const r = await handle(bind({ did_commit: DID }), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});

// ── 409: đã gắn DID — cặp ca chỉ khác đúng ô did_commit của datum thread ─────

describe("/tx/bind-did — 409 DID_ALREADY_BOUND", () => {
  it("CẶP: did_commit của thread rỗng ⟹ 200; khác rỗng ⟹ 409 kèm did_commit hiện có", async () => {
    const pass = await handle(bind(), harness({ threads: [threadWith("")] }).router);
    expect(pass.status, JSON.stringify(pass.body)).toBe(200);

    const h = harness({ threads: [threadWith(OTHER_DID)] });
    const r = await handle(bind(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(codeOf(r)).toBe("DID_ALREADY_BOUND");
    expect(detailsOf(r)).toMatchObject({ did_commit: OTHER_DID, engage_ref: `${THREAD_TX}#0`, engage_nft: THREAD_UNIT });
    expect(h.builder.lastCall).toBeNull();
    // 409 xảy ra TRONG vùng khoá ⟹ khoá phải được nhả, không giữ chủ tới hết hạn.
    expect(h.locks.size()).toBe(0);
  });

  it("gửi lại CHÍNH giá trị đã gắn ⟹ vẫn 409 (một lần, không ghi lại)", async () => {
    const h = harness({ threads: [threadWith(DID)] });
    const r = await handle(bind({ did_commit: DID }), h.router);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("DID_ALREADY_BOUND");
    expect(detailsOf(r).did_commit).toBe(DID);
  });
});

// ── 404 / 409 chọn thread ───────────────────────────────────────────────────

describe("/tx/bind-did — chọn thread theo chủ", () => {
  it("chủ chưa có thread (chỉ có thread chủ khác) ⟹ 404 ENGAGE_THREAD_NOT_FOUND, chỉ tới /tx/open-thread rồi /tx/bind-did", async () => {
    const h = harness({ threads: [threadUtxo(OTHER_OWNER, "a1".repeat(32))] });
    const r = await handle(bind(), h.router);
    expect(r.status).toBe(404);
    expect(codeOf(r)).toBe("ENGAGE_THREAD_NOT_FOUND");
    const msg = JSON.stringify(r.body);
    expect(msg).toContain("/tx/open-thread");
    expect(msg).toContain("/tx/bind-did");
    expect(h.builder.lastCall).toBeNull();
    expect(h.locks.size()).toBe(0);
  });

  it("hai thread cùng chủ ⟹ 409 ENGAGE_THREAD_AMBIGUOUS; CẶP: kèm engage_ref ⟹ thread đó tới bộ dựng", async () => {
    const t2 = threadUtxo(KEY_OWNER, "b2".repeat(32), 1, "02");
    const h = harness({ threads: [UNBOUND, t2] });
    const a = await handle(bind(), h.router);
    expect(a.status).toBe(409);
    expect(codeOf(a)).toBe("ENGAGE_THREAD_AMBIGUOUS");
    const b = await handle(bind({ engage_ref: `${THREAD_TX}#0` }), h.router);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(h.builder.lastCall?.engageUtxo).toBe(UNBOUND);
  });
});

// ── fee_payer ────────────────────────────────────────────────────────────────

// `fee_payer` gắn được DID từ 2026-10-04 (`buildBindDidTx` ▸ `validToMs`): ca dương/âm ở
// `tests/feePayerNewcomer.test.ts`. Mã `BIND_DID_FEE_PAYER_UNSUPPORTED` đã bỏ.
describe("/tx/bind-did — fee_payer", () => {
  it("fee_payer cùng change_address ⟹ 400 FEE_PAYER_CHANGE_ADDRESS_CONFLICT, trước mọi bước đọc chuỗi", async () => {
    const h = harness();
    const r = await handle(bind({
      fee_payer: { utxo: `${"fa".repeat(32)}#0`, address: FEE_ADDRESS }, change_address: CHANGE_ADDRESS,
    }), h.router);
    expect(r.status).toBe(400);
    expect(codeOf(r)).toBe("FEE_PAYER_CHANGE_ADDRESS_CONFLICT");
    expect(h.builder.lastCall).toBeNull();
    expect(h.locks.size()).toBe(0);
  });
});

// ── khoá + UTxO đang chờ ─────────────────────────────────────────────────────

describe("/tx/bind-did — tranh chấp thread", () => {
  it("hai lượt gắn liền nhau, lượt đầu chưa nộp ⟹ lượt sau THAY lượt đầu, không 409 (đổi từ OWNER_TX_IN_FLIGHT, 2026-10-03)", async () => {
    const h = harness();
    const a = await handle(bind(), h.router);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const b = await handle(bind(), h.router);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect((b.body as { tx_hash?: unknown }).tx_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("thread là input của tx vừa nộp mà chưa vào khối ⟹ 409 PREVIOUS_TX_PENDING", async () => {
    const pending = new PendingSpends(TTL);
    pending.note([`${THREAD_TX}#0`], NOW);
    const h = harness({ pending });
    const r = await handle(bind(), h.router);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("PREVIOUS_TX_PENDING");
    expect(h.builder.lastCall).toBeNull();
  });
});

// ── 422: đọc lại CBOR ────────────────────────────────────────────────────────

describe("/tx/bind-did — 422 BIND_DID_TX_MISMATCH (cổng đọc lại, bộ dựng trả CBOR lệch)", () => {
  const bad: [string, BindTxOpts][] = [
    ["redeemer là Constr 0 (Consume) thay vì BindDID", { redeemerHex: "d87980" }],
    ["value thread đổi (lovelace 1,9 ADA)", { outLovelace: 1_900_000n }],
    ["did_commit trong output khác giá trị yêu cầu", { outDid: OTHER_DID }],
    ["did_commit trong output rỗng", { outDid: "" }],
    ["trục kế toán đổi (consumed_count 4)", { outAccounting: { consumedCount: 4n } }],
    ["khoá chủ không nằm trong required_signers", { signers: [OTHER_OWNER_PKH] }],
    ["output thread không ở địa chỉ engage", { outAddress: VAULT_ADDRESS }],
    ["đúc thêm tài sản dưới policy consume", { mint: { [ENGAGE_SCRIPT_HASH + "beef"]: 1n } }],
  ];
  for (const [name, o] of bad) {
    it(`${name} ⟹ 422`, async () => {
      const h = harness({ cbor: bindTx(o) });
      const r = await handle(bind(), h.router);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(codeOf(r)).toBe("BIND_DID_TX_MISMATCH");
      expect(h.locks.size()).toBe(0);
      expect(h.issued.size()).toBe(0);
    });
  }

  it("CẶP: CBOR đúng ⟹ 200 (cùng harness, chỉ khác CBOR ghi sẵn)", async () => {
    const h = harness({ cbor: bindTx() });
    const r = await handle(bind(), h.router);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});

// ── bảng route ───────────────────────────────────────────────────────────────

describe("bảng route — bind-did có mặt ở mọi bảng", () => {
  it("BUILD_ROUTE_OF_PATH ↔ ISSUED_ROUTES là CÙNG một tập, và có bind-did", () => {
    expect(BUILD_ROUTE_OF_PATH["/tx/bind-did"]).toBe("bind-did");
    expect(ISSUED_ROUTES).toContain("bind-did");
    expect([...new Set(Object.values(BUILD_ROUTE_OF_PATH))].sort()).toEqual([...ISSUED_ROUTES].sort());
  });

  it("feecover.apps.*.purposes nhận route bind-did (cấu hình không từ chối route có thật)", () => {
    const d = parseDeployment(JSON.stringify({
      source: "Preview, bản dựng thử",
      lamp: { policy_id: LAMP_POLICY_ID, asset_name_hex: LAMP_ASSET_NAME_HEX },
      vaults: [{ vault_type: "Schedule", address: VAULT_ADDRESS }],
      shard_address: SHARD_ADDRESS,
      ref_script_utxos: {
        vault: `${"11".repeat(32)}#0`, shard: `${"22".repeat(32)}#1`, consume: `${"33".repeat(32)}#2`,
      },
      consume: {
        engage_address: ENGAGE_ADDRESS, price_beacon_address: VAULT_ADDRESS,
        price_beacon_nft_unit: `${"55".repeat(28)}cafe`,
      },
      feecover: { url: "http://127.0.0.1:1", apps: { magic: { purposes: { "bind-did": "magic_bind_did" } } } },
    }), "Preview");
    expect(d.feecover?.apps.get("magic")?.purposes.get("bind-did")).toBe("magic_bind_did");
  });
});
