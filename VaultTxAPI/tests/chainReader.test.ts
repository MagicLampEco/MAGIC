// VaultTxAPI/tests/chainReader.test.ts — `BlockfrostChainReader.utxosByOutRef` trên phản hồi
// HTTP giả, không gọi mạng.
//
// Bộ đọc ghi sẵn ở các bài khác không đi qua mã phân tích Blockfrost, nên bản cũ ép
// `scriptRef` với MỌI UTxO mà không bài nào đỏ; lỗi chỉ lộ ra trên Preprod thật, khi UTxO trả
// phí thuần ADA bị trả `CHAIN_UNAVAILABLE`. Cặp ca: UTxO thuần ADA đọc được và KHÔNG mang
// `scriptRef`; UTxO ref-script vẫn mang script. Bản vá gỡ luôn việc điền script cũng đỏ.

import { afterEach, describe, expect, it, vi } from "vitest";

import { BlockfrostChainReader } from "../src/chain.js";

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
