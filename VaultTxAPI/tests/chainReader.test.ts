// VaultTxAPI/tests/chainReader.test.ts — `BlockfrostChainReader.utxosByOutRef` trên phản hồi
// HTTP giả, không gọi mạng.
//
// Bộ đọc ghi sẵn ở các bài khác không đi qua mã phân tích Blockfrost, nên bản cũ ép
// `scriptRef` với MỌI UTxO mà không bài nào đỏ; lỗi chỉ lộ ra trên Preprod thật, khi UTxO trả
// phí thuần ADA bị trả `CHAIN_UNAVAILABLE`. Cặp ca: UTxO thuần ADA đọc được và KHÔNG mang
// `scriptRef`; UTxO ref-script vẫn mang script. Bản vá gỡ luôn việc điền script cũng đỏ.

import { afterEach, describe, expect, it, vi } from "vitest";

import { BlockfrostChainReader, PendingSpendsFilteredChain, RecordedChainReader } from "../src/chain.js";
import { PendingSpends } from "../src/locks.js";
import type { UTxO } from "@lucid-evolution/lucid";

const TX = "18eafef96e7e641dbd8a48b41bf1b36a26be3de31c23d7479a140aec600ecd62";
const ADDR = "addr_test1vqh9u9qcx4v5ls3eh5wh8rdcnxfl5km6s2qkfdtf9q0cc2g6lsw0w";
const SCRIPT_HASH = "ab".repeat(28);
// Validator PlutusV3 luôn-thành-công, CBOR bọc một lớp — chỉ cần giải được, không cần chạy.
const SCRIPT_CBOR = "4e4d01000033222220051200120011";

function stubBlockfrost(routes: Record<string, unknown>): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url).pathname.replace(/^\/api\/v0/, "");
    const body = routes[path];
    if (body === undefined) return new Response("", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

const reader = (): BlockfrostChainReader =>
  new BlockfrostChainReader({ baseUrl: "https://cardano-preprod.blockfrost.io/api/v0", projectId: "test" });

afterEach(() => { vi.unstubAllGlobals(); });

describe("BlockfrostChainReader.utxosByOutRef", () => {
  it("UTxO thuần ADA (UTxO trả phí) đọc được, không mang scriptRef", async () => {
    stubBlockfrost({
      [`/txs/${TX}/utxos`]: {
        outputs: [{ address: ADDR, output_index: 2, amount: [{ unit: "lovelace", quantity: "25000000" }] }],
      },
    });
    const [u] = await reader().utxosByOutRef([{ txHash: TX, outputIndex: 2 }]);
    expect(u!.assets.lovelace).toBe(25_000_000n);
    expect(u!.scriptRef ?? null).toBeNull();
  });

  it("UTxO ref-script vẫn mang script đọc từ chuỗi", async () => {
    stubBlockfrost({
      [`/txs/${TX}/utxos`]: {
        outputs: [{
          address: ADDR, output_index: 0, reference_script_hash: SCRIPT_HASH,
          amount: [{ unit: "lovelace", quantity: "30000000" }],
        }],
      },
      [`/scripts/${SCRIPT_HASH}`]: { type: "plutusV3" },
      [`/scripts/${SCRIPT_HASH}/cbor`]: { cbor: SCRIPT_CBOR },
    });
    const [u] = await reader().utxosByOutRef([{ txHash: TX, outputIndex: 0 }]);
    expect(u!.scriptRef?.type).toBe("PlutusV3");
  });
});

describe("BlockfrostChainReader — script theo hash đọc MỘT lần", () => {
  it("N UTxO cùng một script tham chiếu ⟹ /scripts/<hash> gọi đúng một lần qua nhiều lượt đọc", async () => {
    const calls: string[] = [];
    const routes: Record<string, unknown> = {
      [`/addresses/${ADDR}/utxos`]: Array.from({ length: 5 }, (_, i) => ({
        tx_hash: TX, output_index: i, reference_script_hash: SCRIPT_HASH,
        amount: [{ unit: "lovelace", quantity: "2000000" }],
      })),
      [`/scripts/${SCRIPT_HASH}`]: { type: "plutusV3" },
      [`/scripts/${SCRIPT_HASH}/cbor`]: { cbor: SCRIPT_CBOR },
    };
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url).pathname.replace(/^\/api\/v0/, "");
      calls.push(path);
      const body = routes[path];
      return body === undefined ? new Response("", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
    });
    const r = reader();
    const a = await r.utxosAt(ADDR);
    const b = await r.utxosAt(ADDR);
    expect(a.every(u => u.scriptRef?.type === "PlutusV3")).toBe(true);
    expect(b.every(u => u.scriptRef?.type === "PlutusV3")).toBe(true);
    expect(calls.filter(c => c.startsWith("/scripts/"))).toEqual([`/scripts/${SCRIPT_HASH}`, `/scripts/${SCRIPT_HASH}/cbor`]);
  });
  it("CỰC ĐỐI: lượt đọc script HỎNG không bị đệm — lần sau đọc lại được", async () => {
    let fail = true;
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url).pathname.replace(/^\/api\/v0/, "");
      if (path === `/txs/${TX}/utxos`) {
        return new Response(JSON.stringify({ outputs: [{ address: ADDR, output_index: 0, reference_script_hash: SCRIPT_HASH, amount: [{ unit: "lovelace", quantity: "1" }] }] }), { status: 200 });
      }
      if (path === `/scripts/${SCRIPT_HASH}`) return fail ? new Response("", { status: 500 }) : new Response(JSON.stringify({ type: "plutusV3" }), { status: 200 });
      if (path === `/scripts/${SCRIPT_HASH}/cbor`) return new Response(JSON.stringify({ cbor: SCRIPT_CBOR }), { status: 200 });
      return new Response("", { status: 404 });
    });
    const r = reader();
    await expect(r.utxosByOutRef([{ txHash: TX, outputIndex: 0 }])).rejects.toBeDefined();
    fail = false;
    const [u] = await r.utxosByOutRef([{ txHash: TX, outputIndex: 0 }]);
    expect(u!.scriptRef?.type).toBe("PlutusV3");
  });
});

describe("PendingSpendsFilteredChain", () => {
  it("utxosAt bỏ UTxO đang chờ; CỰC ĐỐI: UTxO khác đi qua nguyên", async () => {
    const p = new PendingSpends(60_000);
    p.note([`${TX}#1`], 0);
    const inner = new RecordedChainReader({
      [ADDR]: [0, 1, 2].map(i => ({ txHash: TX, outputIndex: i, address: ADDR, assets: { lovelace: 1n } }) as UTxO),
    }, { blockHeight: 1, blockHash: "00".repeat(32), blockTimePosixMs: 1n });
    const got = await new PendingSpendsFilteredChain(inner, p, () => 1).utxosAt(ADDR);
    expect(got.map(u => u.outputIndex)).toEqual([0, 2]);
  });
});

describe("BlockfrostChainReader.utxosByOutRef — output ĐÃ TIÊU / không tồn tại", () => {
  const out = (consumed: string | null) => ({
    [`/txs/${TX}/utxos`]: {
      outputs: [{ address: ADDR, output_index: 2, consumed_by_tx: consumed, amount: [{ unit: "lovelace", quantity: "25000000" }] }],
    },
  });
  it("consumed_by_tx là một hash ⟹ 409 UTXO_SPENT", async () => {
    stubBlockfrost(out("50".repeat(32)));
    await expect(reader().utxosByOutRef([{ txHash: TX, outputIndex: 2 }]))
      .rejects.toMatchObject({ httpStatus: 409, code: "UTXO_SPENT" });
  });
  it("CỰC ĐỐI: consumed_by_tx = null ⟹ đọc được", async () => {
    stubBlockfrost(out(null));
    const [u] = await reader().utxosByOutRef([{ txHash: TX, outputIndex: 2 }]);
    expect(u!.assets.lovelace).toBe(25_000_000n);
  });
  it("output # không có ⟹ 400 UTXO_NOT_FOUND; giao dịch không có (404) ⟹ 400 UTXO_NOT_FOUND", async () => {
    stubBlockfrost(out(null));
    await expect(reader().utxosByOutRef([{ txHash: TX, outputIndex: 7 }]))
      .rejects.toMatchObject({ httpStatus: 400, code: "UTXO_NOT_FOUND" });
    await expect(reader().utxosByOutRef([{ txHash: "cd".repeat(32), outputIndex: 0 }]))
      .rejects.toMatchObject({ httpStatus: 400, code: "UTXO_NOT_FOUND" });
  });
});

// Cờ đăng ký stake: Blockfrost tách `registered` (đã nộp cọc) khỏi `active` (đang uỷ thác pool).
// Bản cũ đọc `active` ⟹ DID đã đăng ký mà chưa uỷ thác bị chặn OWNER_STAKE_NOT_REGISTERED (đo
// Preprod 2026-10-05). Cặp cực đối: chỉ khác hai cờ đó, kết luận phải đảo theo `registered`.
describe("BlockfrostChainReader.rewardAccount — cờ đăng ký", () => {
  const STAKE = "stake_test17ramey83zzyderj6uzwl04wx2c73s2xx0sdl89dywap3xxcux6sqp";
  const route = (b: Record<string, unknown>) => stubBlockfrost({ [`/accounts/${STAKE}`]: { withdrawable_amount: "0", ...b } });

  it("registered=true, active=false (đăng ký, chưa uỷ thác) ⟹ đã đăng ký", async () => {
    route({ registered: true, active: false });
    expect((await reader().rewardAccount(STAKE)).registered).toBe(true);
  });

  it("cực đối: registered=false, active=true ⟹ CHƯA đăng ký", async () => {
    route({ registered: false, active: true });
    expect((await reader().rewardAccount(STAKE)).registered).toBe(false);
  });

  it("API đời trước không có `registered` ⟹ lùi về `active`", async () => {
    route({ active: true });
    expect((await reader().rewardAccount(STAKE)).registered).toBe(true);
  });

  it("`registered` sai kiểu ⟹ NÉM, không đoán", async () => {
    route({ registered: "yes", active: true });
    await expect(reader().rewardAccount(STAKE)).rejects.toThrow(/hình dạng lạ/);
  });

  it("404 ⟹ chưa đăng ký, thưởng 0", async () => {
    stubBlockfrost({});
    expect(await reader().rewardAccount(STAKE)).toEqual({ registered: false, withdrawableLovelace: 0n });
  });
});
