// VaultReadAPI/tests/threadIndex.test.ts — chỉ mục DID ⟹ thread.
//
// Mỗi bài ÂM đi cặp với một bài DƯƠNG dựng từ cùng đầu vào, chỉ khác đúng một yếu tố — để một
// bài xanh không thể xanh vì lý do rỗng (chỉ mục không bao giờ trả gì cũng qua được mọi bài âm).

import { describe, expect, it } from "vitest";

import { normalizeTxEffect } from "../src/chain.js";
import { loadConfig, parseConsumeScopes } from "../src/config.js";
import { VaultReadError } from "../src/errors.js";
import { handle } from "../src/http.js";
import { VaultReadService } from "../src/service.js";
import { ThreadIndex } from "../src/threadIndex.js";

import {
  ADDR_A, CFG, CONSUME_A, CONSUME_B, FakeHistoryChain, SCOPE_A, SCOPE_B,
  didOf, threadDatumHex, threadOutput, threadUnit,
} from "./fixtures/threads.js";
import { PREVIEW_VAULT_ADDRESS, PREVIEW_VAULT_SCRIPT_HASH } from "./fixtures/preview-e5fd34b1.js";

const TOKEN = "thebai-chi-de-kiem-thu-khong-phai-bi-mat";
const auth = { authorization: `Bearer ${TOKEN}` };

function setup(scopes = [SCOPE_A]) {
  const chain = new FakeHistoryChain();
  const clock = { t: 1_000_000 };
  const logs: string[] = [];
  const index = new ThreadIndex(chain, scopes, CFG, { now: () => clock.t, log: m => logs.push(m) });
  const deps = {
    // Đường vault không dùng ở đây; dựng đủ để `handle` có hình dạng thật.
    service: new VaultReadService("Preview", [], chain),
    scopes: [], network: "Preview", chainLabel: chain.label, token: TOKEN, threads: index,
  };
  const get = (path: string, headers: Record<string, string> = auth) =>
    handle({ method: "GET", url: path, headers }, deps);
  return { chain, clock, index, get, logs };
}

type Body = Record<string, any>;

describe("10 000 thread — tra DID là tra bảng, KHÔNG gọi chuỗi", () => {
  it("tra một DID trả đúng thread của nó, và chuỗi giả đếm 0 lời gọi trong lúc tra", async () => {
    const { chain, index, get } = setup();
    const N = 10_000;
    // Datum dựng MỘT lần mỗi DID bằng lược đồ thật; chỉ DID khác nhau.
    for (let i = 0; i < N; i++) {
      chain.seed(threadOutput({ seedIndex: i, did: didOf(i), consumedCount: BigInt(i) }));
    }
    await index.syncOnce();
    expect((index.status() as Body).thread_count).toBe(N);

    const target = 7_777;
    const before = chain.calls;
    const hit = await get(`/threads/by-did/${didOf(target)}`);
    const miss = await get(`/threads/by-did/${didOf(N + 5)}`);
    const direct = index.byDid(didOf(42));
    expect(chain.calls - before).toBe(0);   // ← tiêu chí: 0 lời gọi chuỗi lúc tra

    // Dương: đúng một thread, đúng DID, đúng NFT, đúng số đếm.
    expect(hit.status).toBe(200);
    const b = hit.body as Body;
    expect(b.threads).toHaveLength(1);
    expect(b.threads[0].datum.did_commit).toBe(didOf(target));
    expect(b.threads[0].datum.consumed_count).toBe(String(target));
    expect(b.threads[0].policy + b.threads[0].name).toBe(threadUnit(CONSUME_A, target));
    expect(b.threads[0].consume_hash).toBe(CONSUME_A);
    expect(direct.threads[0]!.didCommit).toBe(didOf(42));

    // Cặp âm: DID không có ⟹ rỗng, cũng 0 lời gọi (đã đo chung ở trên).
    expect(miss.status).toBe(200);
    expect((miss.body as Body).threads).toEqual([]);
  }, 120_000);
});

describe("BindDID — thread vừa gắn DID xuất hiện sau MỘT vòng đồng bộ", () => {
  it("trước vòng: chưa có; sau một vòng: có, với UTxO mới", async () => {
    const { chain, index, get } = setup();
    const DID = didOf(0xb1d);
    const r0 = chain.seed(threadOutput({ seedIndex: 1 }));   // did_commit rỗng
    await index.syncOnce();

    // Thread chưa gắn DID: có trong by-asset, không có ở by-did.
    const unit = threadUnit(CONSUME_A, 1);
    const asAsset = await get(`/threads/by-asset/${unit.slice(0, 56)}.${unit.slice(56)}`);
    expect(asAsset.status).toBe(200);
    expect((asAsset.body as Body).thread.datum.did_commit).toBe("");
    expect(((await get(`/threads/by-did/${DID}`)).body as Body).threads).toEqual([]);

    // BindDID trên chuỗi: tiêu thread, tạo lại cùng NFT với did_commit = DID.
    const { outs } = chain.submit([r0], [threadOutput({ seedIndex: 1, did: DID })]);

    // Chưa đồng bộ: chỉ mục chưa thấy khối mới nên vẫn tươi, và chưa biết — đúng hành vi đã khai
    // (trễ tối đa là một nhịp đồng bộ; quá ngưỡng thì 503).
    expect(((await get(`/threads/by-did/${DID}`)).body as Body).threads).toEqual([]);

    await index.syncOnce();
    const after = await get(`/threads/by-did/${DID}`);
    expect(after.status).toBe(200);
    const threads = (after.body as Body).threads;
    expect(threads).toHaveLength(1);
    expect(threads[0].utxo).toBe(`${outs[0]!.txHash}#0`);
    expect(threads[0].datum.did_commit).toBe(DID);
  });
});

describe("consume — thread bị tiêu + tạo lại ⟹ by-asset ra UTxO mới, UTxO cũ biến mất", () => {
  it("UTxO mới thay UTxO cũ, NFT giữ nguyên, số thread không đổi", async () => {
    const { chain, index, get } = setup();
    const DID = didOf(0xc0);
    const r0 = chain.seed(threadOutput({ seedIndex: 9, did: DID, consumedCount: 3n, consumedNanogic: 3_000n }));
    await index.syncOnce();
    const unit = threadUnit(CONSUME_A, 9);
    const path = `/threads/by-asset/${unit.slice(0, 56)}.${unit.slice(56)}`;

    const before = (await get(path)).body as Body;
    expect(before.thread.utxo).toBe(`${r0.txHash}#0`);   // dương: UTxO cũ trước khi tiêu

    const { outs } = chain.submit(
      [r0], [threadOutput({ seedIndex: 9, did: DID, consumedCount: 4n, consumedNanogic: 4_500n })],
    );
    await index.syncOnce();

    const res = await get(path);
    expect(res.status).toBe(200);
    const t = (res.body as Body).thread;
    expect(t.utxo).toBe(`${outs[0]!.txHash}#0`);
    expect(t.utxo).not.toBe(`${r0.txHash}#0`);
    expect(t.datum.consumed_count).toBe("4");
    expect(t.datum.consumed_nanogic).toBe("4500");

    const byDid = ((await get(`/threads/by-did/${DID}`)).body as Body).threads;
    expect(byDid.map((x: Body) => x.utxo)).toEqual([`${outs[0]!.txHash}#0`]);   // UTxO cũ không còn
    expect((index.status() as Body).thread_count).toBe(1);
  });

  it("thread bị tiêu mà KHÔNG tạo lại ⟹ rời chỉ mục (by-asset 404 khi tươi)", async () => {
    const { chain, index, get } = setup();
    const r0 = chain.seed(threadOutput({ seedIndex: 3, did: didOf(3) }));
    await index.syncOnce();
    const unit = threadUnit(CONSUME_A, 3);
    const path = `/threads/by-asset/${unit.slice(0, 56)}.${unit.slice(56)}`;
    expect((await get(path)).status).toBe(200);             // dương
    chain.submit([r0], []);
    await index.syncOnce();
    const res = await get(path);
    expect(res.status).toBe(404);
    expect((res.body as Body).error.code).toBe("THREAD_NOT_FOUND");
  });
});

describe("độ tươi — cũ thì 503 INDEX_STALE, KHÔNG trả danh sách", () => {
  it("chưa đồng bộ lần nào ⟹ 503 (cả by-did lẫn by-asset); đồng bộ xong ⟹ 200", async () => {
    const { chain, index, get } = setup();
    chain.seed(threadOutput({ seedIndex: 1, did: didOf(1) }));
    const unit = threadUnit(CONSUME_A, 1);
    const byAsset = `/threads/by-asset/${unit.slice(0, 56)}.${unit.slice(56)}`;

    for (const p of [`/threads/by-did/${didOf(1)}`, byAsset]) {
      const r = await get(p);
      expect(r.status).toBe(503);
      const e = (r.body as Body).error;
      expect(e.code).toBe("INDEX_STALE");
      expect(e.details.reason).toBe("NEVER_SYNCED");
      expect(e.details.synced_slot).toBeNull();
      expect(r.body).not.toHaveProperty("threads");
    }

    await index.syncOnce();
    expect((await get(`/threads/by-did/${didOf(1)}`)).status).toBe(200);   // cặp dương
    expect((await get(byAsset)).status).toBe(200);
  });

  it("vòng đầu HỎNG ⟹ vẫn 503 NEVER_SYNCED, kèm lỗi vòng đồng bộ", async () => {
    const { chain, index, get, logs } = setup();
    chain.failing = true;
    await index.syncOnce();
    const r = await get(`/threads/by-did/${didOf(1)}`);
    expect(r.status).toBe(503);
    expect((r.body as Body).error.details.reason).toBe("NEVER_SYNCED");
    expect((r.body as Body).error.details.last_sync_error).toMatch(/CHAIN_UNAVAILABLE/);
    expect(logs.length).toBe(1);
  });

  it("trễ 4 khối (> 3) ⟹ 503 kèm synced_slot/tip_slot/lag_blocks; trễ đúng 3 ⟹ 200", async () => {
    const { chain, index, get } = setup();
    chain.seed(threadOutput({ seedIndex: 1, did: didOf(1) }));
    await index.syncOnce();
    const syncedSlot = chain.slotOf(chain.height);

    // Đỉnh chạy, nhưng đọc lịch sử hỏng ⟹ đỉnh được quan sát, điểm đồng bộ đứng yên.
    const observeTipOnly = async (blocks: number) => {
      chain.advance(blocks);
      const orig = chain.txsAt.bind(chain);
      chain.txsAt = async () => { throw new Error("lịch sử hỏng"); };
      await index.syncOnce();
      chain.txsAt = orig;
    };

    await observeTipOnly(3);
    const ok = await get(`/threads/by-did/${didOf(1)}`);
    expect(ok.status).toBe(200);                       // dương: đúng ngưỡng vẫn tươi
    expect((ok.body as Body).lag_blocks).toBe(3);

    await observeTipOnly(1);
    const r = await get(`/threads/by-did/${didOf(1)}`);
    expect(r.status).toBe(503);
    const e = (r.body as Body).error;
    expect(e.code).toBe("INDEX_STALE");
    expect(e.details).toMatchObject({
      synced_slot: syncedSlot, tip_slot: chain.slotOf(chain.height), lag_blocks: 4, reason: "LAG_EXCEEDED",
    });
    expect(r.body).not.toHaveProperty("threads");

    // Đồng bộ lại được ⟹ tươi trở lại.
    await index.syncOnce();
    expect((await get(`/threads/by-did/${didOf(1)}`)).status).toBe(200);
  });

  it("vòng đồng bộ CHẾT (không quan sát được đỉnh nữa) ⟹ đồng hồ tường đẩy lag lên, không kẹt ở 0", async () => {
    const { chain, clock, index, get } = setup();
    chain.seed(threadOutput({ seedIndex: 1, did: didOf(1) }));
    await index.syncOnce();
    chain.failing = true;

    clock.t += 3 * CFG.blockTimeMs;                  // dương: 3 khối ước lượng ⟹ vẫn tươi
    await index.syncOnce();
    expect((await get(`/threads/by-did/${didOf(1)}`)).status).toBe(200);

    clock.t += CFG.blockTimeMs;                      // 4 khối ⟹ cũ
    await index.syncOnce();
    const r = await get(`/threads/by-did/${didOf(1)}`);
    expect(r.status).toBe(503);
    expect((r.body as Body).error.details.lag_blocks).toBe(4);
    expect((r.body as Body).error.details.tip_slot).toBe(chain.slotOf(chain.height) + (4 * CFG.blockTimeMs) / 1000);
  });

  it("tươi mà không có: by-did ⟹ 200 threads: []; by-asset ⟹ 404. Cùng tình huống khi CŨ ⟹ 503, không phải rỗng/404", async () => {
    const { chain, clock, index, get } = setup();
    await index.syncOnce();
    const unit = threadUnit(CONSUME_A, 77);
    const assetPath = `/threads/by-asset/${unit.slice(0, 56)}.${unit.slice(56)}`;

    const d = await get(`/threads/by-did/${didOf(77)}`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ threads: [], lag_blocks: 0 });
    const a = await get(assetPath);
    expect(a.status).toBe(404);
    expect((a.body as Body).error.code).toBe("THREAD_NOT_FOUND");

    chain.failing = true;
    clock.t += 10 * CFG.blockTimeMs;
    expect((await get(`/threads/by-did/${didOf(77)}`)).status).toBe(503);
    expect((await get(assetPath)).status).toBe(503);
  });
});

describe("UTxO giả ở địa chỉ consume — không NFT ⟹ không vào chỉ mục", () => {
  it("cùng datum khai cùng DID: bản KHÔNG NFT bị bỏ, bản CÓ NFT được tính", async () => {
    const { chain, index, get } = setup();
    const DID = didOf(0xfa6e);
    const datum = threadDatumHex({ did: DID });
    // Âm: không NFT.
    chain.seed({ address: ADDR_A, assets: { lovelace: 2_000_000n }, inlineDatumHex: datum });
    // Âm: NFT sai policy (policy của consume B, đỗ ở địa chỉ A).
    chain.seed({ address: ADDR_A, assets: { lovelace: 2_000_000n, [threadUnit(CONSUME_B, 5)]: 1n }, inlineDatumHex: datum });
    // Âm: đúng policy nhưng số lượng 2 — không phải NFT.
    chain.seed({ address: ADDR_A, assets: { lovelace: 2_000_000n, [threadUnit(CONSUME_A, 6)]: 2n }, inlineDatumHex: datum });
    await index.syncOnce();

    let r = (await get(`/threads/by-did/${DID}`)).body as Body;
    expect(r.threads).toEqual([]);
    expect((index.status() as Body).ignored_no_nft_count).toBe(3);

    // Dương: cùng datum, có NFT đúng policy ⟹ vào chỉ mục.
    chain.submit([], [{ address: ADDR_A, assets: { lovelace: 2_000_000n, [threadUnit(CONSUME_A, 7)]: 1n }, inlineDatumHex: datum }]);
    await index.syncOnce();
    r = (await get(`/threads/by-did/${DID}`)).body as Body;
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0].policy + r.threads[0].name).toBe(threadUnit(CONSUME_A, 7));
  });
});

describe("hai hash consume ⟹ một DID ra hai thread, mỗi thread đúng hash của nó", () => {
  it("DID có thread ở cả A và B ⟹ 2; DID chỉ có ở A ⟹ 1", async () => {
    const { chain, index, get } = setup([SCOPE_A, SCOPE_B]);
    const BOTH = didOf(0xab);
    const ONLY_A = didOf(0xaa);
    chain.seed(threadOutput({ consumeHash: CONSUME_A, seedIndex: 1, did: BOTH }));
    chain.seed(threadOutput({ consumeHash: CONSUME_B, seedIndex: 2, did: BOTH }));
    chain.seed(threadOutput({ consumeHash: CONSUME_A, seedIndex: 3, did: ONLY_A }));
    await index.syncOnce();

    const both = ((await get(`/threads/by-did/${BOTH}`)).body as Body).threads;
    expect(both).toHaveLength(2);
    expect(both.map((t: Body) => t.consume_hash)).toEqual([CONSUME_A, CONSUME_B]);
    expect(both[0].policy + both[0].name).toBe(threadUnit(CONSUME_A, 1));
    expect(both[1].policy + both[1].name).toBe(threadUnit(CONSUME_B, 2));
    for (const t of both) expect(t.policy).toBe(t.consume_hash);

    const onlyA = ((await get(`/threads/by-did/${ONLY_A}`)).body as Body).threads;
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].consume_hash).toBe(CONSUME_A);
  });

  it("thread tạo mới ở địa chỉ B vào chỉ mục qua đồng bộ gia tăng, không chỉ qua ảnh chụp", async () => {
    const { chain, index, get } = setup([SCOPE_A, SCOPE_B]);
    await index.syncOnce();
    const DID = didOf(0xbb);
    chain.submit([], [threadOutput({ consumeHash: CONSUME_B, seedIndex: 4, did: DID })]);
    await index.syncOnce();
    const t = ((await get(`/threads/by-did/${DID}`)).body as Body).threads;
    expect(t).toHaveLength(1);
    expect(t[0].consume_hash).toBe(CONSUME_B);
    expect((index.status() as Body).rebuilds).toBe(1);   // chỉ lần dựng đầu
  });
});

describe("datum lạ trên UTxO MANG NFT — đếm và lộ ra, không nuốt", () => {
  it("datum hỏng ⟹ skipped_count 1, /threads/status liệt kê, by-asset 502; datum lành ⟹ 200", async () => {
    const { chain, index, get } = setup();
    const badUnit = threadUnit(CONSUME_A, 11);
    const bad = chain.seed({ address: ADDR_A, assets: { lovelace: 2_000_000n, [badUnit]: 1n }, inlineDatumHex: "d87980" });
    chain.seed(threadOutput({ seedIndex: 12, did: didOf(12) }));
    await index.syncOnce();

    const st = (await get("/threads/status")).body as Body;
    expect(st.skipped_count).toBe(1);
    expect(st.skipped[0]).toMatchObject({ utxo: `${bad.txHash}#0`, consume_hash: CONSUME_A, reason: "DATUM_UNDECODABLE" });
    expect(st.scopes[0]).toMatchObject({ threads: 1, skipped: 1, ignored_no_nft: 0 });

    const r = await get(`/threads/by-asset/${badUnit.slice(0, 56)}.${badUnit.slice(56)}`);
    expect(r.status).toBe(502);
    expect((r.body as Body).error.code).toBe("THREAD_DATUM_UNDECODABLE");

    // by-did vẫn trả, nhưng khai rằng toàn chỉ mục có UTxO không đọc được.
    const d = await get(`/threads/by-did/${didOf(12)}`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ skipped_count: 1 });
    expect((d.body as Body).threads).toHaveLength(1);

    // Cặp dương: cùng NFT, datum lành ⟹ 200 và skipped về 0.
    chain.submit([bad], [threadOutput({ seedIndex: 11, did: didOf(11) })]);
    await index.syncOnce();
    expect((await get(`/threads/by-asset/${badUnit.slice(0, 56)}.${badUnit.slice(56)}`)).status).toBe(200);
    expect(((await get("/threads/status")).body as Body).skipped_count).toBe(0);
  });

  it("did_commit dài lạ (không 0, không 32 byte) ⟹ skipped DID_COMMIT_LENGTH", async () => {
    const { chain, index } = setup();
    chain.seed(threadOutput({ seedIndex: 1, did: "ab".repeat(16) }));
    chain.seed(threadOutput({ seedIndex: 2, did: "ab".repeat(32) }));   // dương
    await index.syncOnce();
    const st = index.status() as Body;
    expect(st.skipped.map((x: Body) => x.reason)).toEqual(["DID_COMMIT_LENGTH"]);
    expect(st.thread_count).toBe(1);
  });
});

describe("HTTP — mã lỗi của /threads/*", () => {
  it("không chỉ mục ⟹ 503 THREAD_INDEX_DISABLED; có chỉ mục ⟹ không phải mã đó", async () => {
    const chain = new FakeHistoryChain();
    const base = { service: new VaultReadService("Preview", [], chain), scopes: [], network: "Preview", chainLabel: "x", token: "" };
    const r = await handle({ method: "GET", url: `/threads/by-did/${didOf(1)}`, headers: {} }, base);
    expect(r.status).toBe(503);
    expect((r.body as Body).error.code).toBe("THREAD_INDEX_DISABLED");
    const { get } = setup();
    expect(((await get(`/threads/by-did/${didOf(1)}`)).body as Body).error.code).toBe("INDEX_STALE");
  });

  it("thiếu thẻ bài ⟹ 401; DID sai khuôn ⟹ 400; policy không theo dõi ⟹ 404 UNKNOWN_CONSUME_SCOPE", async () => {
    const { index, get } = setup();
    await index.syncOnce();
    expect((await get(`/threads/by-did/${didOf(1)}`, {})).status).toBe(401);
    expect((await get(`/threads/by-did/${didOf(1)}`)).status).toBe(200);             // dương
    expect((await get(`/threads/by-did/${didOf(0xabc)}`)).status).toBe(200);           // dương: hex thường
    expect((await get(`/threads/by-did/${didOf(0xabc).toUpperCase()}`)).status).toBe(400);
    expect((await get(`/threads/by-did/abcd`)).status).toBe(400);
    const u = await get(`/threads/by-asset/${"ee".repeat(28)}.${"00".repeat(32)}`);
    expect(u.status).toBe(404);
    expect((u.body as Body).error.code).toBe("UNKNOWN_CONSUME_SCOPE");
    const k = await get(`/threads/by-asset/${CONSUME_A}.${"00".repeat(32)}`);
    expect((k.body as Body).error.code).toBe("THREAD_NOT_FOUND");                       // dương: policy theo dõi
  });

  it("hai UTxO cùng mang một NFT thread ⟹ 409, không chọn hộ", async () => {
    const { chain, index, get } = setup();
    const DID = didOf(0xd0);
    chain.seed(threadOutput({ seedIndex: 1, did: DID }));
    chain.seed(threadOutput({ seedIndex: 1, did: DID }));
    await index.syncOnce();
    const unit = threadUnit(CONSUME_A, 1);
    expect((await get(`/threads/by-asset/${unit.slice(0, 56)}.${unit.slice(56)}`)).status).toBe(409);
    expect((await get(`/threads/by-did/${DID}`)).status).toBe(409);
  });
});

describe("chuẩn hoá tác động giao dịch (Blockfrost) — hai luật của sổ cái", () => {
  const OUT = { address: ADDR_A, amount: [{ unit: "lovelace", quantity: "2000000" }], output_index: 0, inline_datum: null, collateral: false };
  const input = (over: Record<string, unknown>) => ({ tx_hash: "aa".repeat(32), output_index: 0, collateral: false, reference: false, ...over });

  it("reference input KHÔNG bị tiêu; cùng đầu vào không-reference thì bị tiêu", () => {
    const ref = normalizeTxEffect("bb".repeat(32), true, [input({ reference: true })], [OUT]);
    expect(ref.spent).toEqual([]);
    const spend = normalizeTxEffect("bb".repeat(32), true, [input({})], [OUT]);
    expect(spend.spent).toEqual([{ txHash: "aa".repeat(32), outputIndex: 0 }]);
    expect(spend.created).toHaveLength(1);
  });

  it("trượt pha 2 ⟹ chỉ collateral bị tiêu, đầu ra thường không được tạo; giao dịch lành thì ngược lại", () => {
    const ins = [input({}), input({ output_index: 1, collateral: true })];
    const outs = [OUT, { ...OUT, output_index: 1, collateral: true }];
    const bad = normalizeTxEffect("cc".repeat(32), false, ins, outs);
    expect(bad.spent).toEqual([{ txHash: "aa".repeat(32), outputIndex: 1 }]);
    expect(bad.created.map(c => c.outputIndex)).toEqual([1]);
    const good = normalizeTxEffect("cc".repeat(32), true, ins, outs);
    expect(good.spent).toEqual([{ txHash: "aa".repeat(32), outputIndex: 0 }]);
    expect(good.created.map(c => c.outputIndex)).toEqual([0]);
  });

  it("thiếu cờ `reference` ⟹ NÉM, không coi là false", () => {
    const { reference: _drop, ...noFlag } = input({});
    expect(() => normalizeTxEffect("dd".repeat(32), true, [noFlag], [])).toThrow(VaultReadError);
  });
});

describe("cấu hình VAULT_READ_API_CONSUME_SCOPES", () => {
  const base = (): NodeJS.ProcessEnv => ({
    VAULT_READ_API_NETWORK: "Preview",
    BLOCKFROST_PROJECT_ID: "gia-tri-khoa-gia-cho-bai-kiem",
    VAULT_READ_API_VAULTS: JSON.stringify([{ vault_type: "Schedule", address: PREVIEW_VAULT_ADDRESS, source: "bài kiểm" }]),
  });

  it("vắng biến ⟹ chỉ mục tắt; có biến ⟹ script hash suy từ địa chỉ; mặc định ngưỡng 3 khối", () => {
    expect(loadConfig(base()).consumeScopes).toEqual([]);
    const cfg = loadConfig({
      ...base(),
      VAULT_READ_API_CONSUME_SCOPES: JSON.stringify([{ address: PREVIEW_VAULT_ADDRESS, source: "bài kiểm 2026-09-29" }]),
    });
    expect(cfg.consumeScopes[0]!.scriptHash).toBe(PREVIEW_VAULT_SCRIPT_HASH);
    expect(cfg.threadIndex.staleBlocks).toBe(3);
  });

  it("thiếu nhãn nguồn / sai mạng / trùng / mảng rỗng ⟹ ném lúc khởi động", () => {
    const good = [{ address: PREVIEW_VAULT_ADDRESS, source: "x" }];
    expect(() => parseConsumeScopes(JSON.stringify(good), "Preview")).not.toThrow();
    expect(() => parseConsumeScopes(JSON.stringify([{ address: PREVIEW_VAULT_ADDRESS }]), "Preview")).toThrow(/source/);
    expect(() => parseConsumeScopes(JSON.stringify(good), "Mainnet")).toThrow(/Mainnet/);
    expect(() => parseConsumeScopes(JSON.stringify([...good, ...good]), "Preview")).toThrow(/trùng/);
    expect(() => parseConsumeScopes("[]", "Preview")).toThrow(/không rỗng/);
    expect(() => loadConfig({ ...base(), VAULT_READ_API_THREAD_STALE_BLOCKS: "-1" })).toThrow(/STALE_BLOCKS/);
  });
});
