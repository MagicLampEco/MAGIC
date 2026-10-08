// VaultReadAPI/tests/prepaidConsumeScope.test.ts — thread consume của két Prepaid đi qua
// CÙNG một đường với Schedule/Instant, từ biến môi trường tới chỉ mục.
//
// Vì sao không có nhánh riêng cho Prepaid, và vì sao đó là đúng chứ không phải thiếu:
//  - Mỗi loại két có một bản `consume` riêng, nhưng là CÙNG một validator
//    (`scripts/deployParams.ts` ▸ `consumeScriptChain`, bước 09 gọi)
//    chỉ khác apply-param `vault_script_hash` (`scripts/consumeBook.ts` ▸ `vaultHashKey`).
//    Nên datum thread là MỘT lược đồ cho cả ba loại:
//    `ConsumeMAGIC/onchain/lib/magiclamp/consume/types.ak` ▸ `EngageDatum`.
//  - `ConsumeScope` (`src/config.ts`) vì thế không mang loại két; `source` là nhãn NGUỒN của
//    bản chép (từ đâu, ngày nào), không phải một tập giá trị đóng. Phân biệt két Prepaid ở
//    `/threads/status` là việc của nhãn `source` + `consume_hash`.
//
// Bài DƯƠNG và bài ÂM dựng từ cùng đầu vào, chỉ khác đúng một yếu tố.

import { credentialToAddress } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { ThreadIndex } from "../src/threadIndex.js";

import { CFG, FakeHistoryChain, didOf, threadDatumHex, threadUnit } from "./fixtures/threads.js";
import { PREVIEW_VAULT_ADDRESS } from "./fixtures/preview-e5fd34b1.js";

/** Hash giả cho hai bản `consume` — chỉ cần khác nhau và đúng 28 byte. */
const CONSUME_SCHEDULE_HASH = "a5".repeat(28);
const CONSUME_PREPAID_HASH = "b7".repeat(28);
const ADDR_SCHEDULE = credentialToAddress("Preview", { type: "Script", hash: CONSUME_SCHEDULE_HASH });
const ADDR_PREPAID = credentialToAddress("Preview", { type: "Script", hash: CONSUME_PREPAID_HASH });

const PREPAID_SOURCE = "giả — CONSUME_ADDRESS_PREPAID (bước 09, VAULT_KIND=prepaid), bài kiểm 2026-10-03";

const baseEnv = (): NodeJS.ProcessEnv => ({
  VAULT_READ_API_NETWORK: "Preview",
  BLOCKFROST_PROJECT_ID: "gia-tri-khoa-gia-cho-bai-kiem",
  VAULT_READ_API_VAULTS: JSON.stringify([{ vault_type: "Schedule", address: PREVIEW_VAULT_ADDRESS, source: "bài kiểm" }]),
});

const scopesJson = (prepaid: Record<string, unknown>) => JSON.stringify([
  { address: ADDR_SCHEDULE, source: "giả — CONSUME_ADDRESS_SCHEDULE, bài kiểm" },
  prepaid,
]);

describe("thread consume của két Prepaid — cấu hình ⟹ chỉ mục, không nhánh riêng", () => {
  it("DƯƠNG: mục Prepaid nạp được, hash suy từ địa chỉ, và thread ở đó vào chỉ mục theo DID", async () => {
    const cfg = loadConfig({
      ...baseEnv(),
      VAULT_READ_API_CONSUME_SCOPES: scopesJson({ address: ADDR_PREPAID, source: PREPAID_SOURCE }),
    });
    expect(cfg.consumeScopes.map(s => s.scriptHash)).toEqual([CONSUME_SCHEDULE_HASH, CONSUME_PREPAID_HASH]);
    expect(cfg.consumeScopes[1]!.source).toBe(PREPAID_SOURCE);

    const chain = new FakeHistoryChain();
    const DID = didOf(0x9e9a1d);
    const datum = threadDatumHex({ did: DID, consumedCount: 1n, consumedNanogic: 7_000n });
    // Thread thật của két Prepaid: NFT dưới policy = hash bản `consume` Prepaid.
    const r0 = chain.seed({ address: ADDR_PREPAID, assets: { lovelace: 2_000_000n, [threadUnit(CONSUME_PREPAID_HASH, 1)]: 1n }, inlineDatumHex: datum });
    // ÂM cùng chỗ, cùng datum, chỉ khác policy: NFT của bản `consume` Schedule đỗ ở địa chỉ Prepaid.
    // Địa chỉ script là công cộng; policy không khớp địa chỉ ⟹ không phải thread của địa chỉ này.
    chain.seed({ address: ADDR_PREPAID, assets: { lovelace: 2_000_000n, [threadUnit(CONSUME_SCHEDULE_HASH, 2)]: 1n }, inlineDatumHex: datum });

    const index = new ThreadIndex(chain, cfg.consumeScopes, CFG, { now: () => 1_000_000, log: () => {} });
    await index.syncOnce();

    const r = index.byDid(DID);
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0]!.consumeHash).toBe(CONSUME_PREPAID_HASH);
    expect(r.threads[0]!.policy + r.threads[0]!.name).toBe(threadUnit(CONSUME_PREPAID_HASH, 1));
    expect(r.threads[0]!.consumedNanogic).toBe(7_000n);

    const st = index.status() as Record<string, any>;
    const prepaidRow = (st.scopes as Record<string, unknown>[]).find(s => s.consume_hash === CONSUME_PREPAID_HASH);
    expect(prepaidRow).toMatchObject({ source: PREPAID_SOURCE, threads: 1, ignored_no_nft: 1 });

    // Đường GIA TĂNG (phát lại giao dịch), khác đường ảnh chụp ở trên: một lượt consume tiêu
    // thread Prepaid và tạo lại với số đếm mới ⟹ chỉ mục theo kịp sau một vòng.
    const unitP = threadUnit(CONSUME_PREPAID_HASH, 1);
    const { outs } = chain.submit([r0], [{
      address: ADDR_PREPAID,
      assets: { lovelace: 2_000_000n, [unitP]: 1n },
      inlineDatumHex: threadDatumHex({ did: DID, consumedCount: 2n, consumedNanogic: 14_000n }),
    }]);
    await index.syncOnce();
    const r2 = index.byDid(DID);
    expect(r2.threads).toHaveLength(1);
    expect(r2.threads[0]!.utxo).toBe(`${outs[0]!.txHash}#${outs[0]!.outputIndex}`);
    expect(r2.threads[0]!.consumedCount).toBe(2n);
    expect(r2.threads[0]!.consumedNanogic).toBe(14_000n);
  });

  it("ÂM: mục Prepaid thiếu nhãn nguồn ⟹ từ chối khởi động; câu lỗi nêu TÊN biến + vị trí, không nêu địa chỉ", () => {
    const env = { ...baseEnv(), VAULT_READ_API_CONSUME_SCOPES: scopesJson({ address: ADDR_PREPAID }) };
    let msg = "";
    try { loadConfig(env); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/VAULT_READ_API_CONSUME_SCOPES\[1\]\.source thiếu/);
    expect(msg).not.toContain(ADDR_PREPAID);
    expect(msg).not.toContain(CONSUME_PREPAID_HASH);

    // Nhãn chỉ có khoảng trắng cũng là thiếu nhãn.
    expect(() => loadConfig({ ...baseEnv(), VAULT_READ_API_CONSUME_SCOPES: scopesJson({ address: ADDR_PREPAID, source: "   " }) }))
      .toThrow(/\[1\]\.source thiếu/);
  });

  it("ÂM: mục Prepaid là địa chỉ KHOÁ (không phải script) ⟹ từ chối khởi động", () => {
    const keyAddr = credentialToAddress("Preview", { type: "Key", hash: "c9".repeat(28) });
    expect(() => loadConfig({ ...baseEnv(), VAULT_READ_API_CONSUME_SCOPES: scopesJson({ address: keyAddr, source: PREPAID_SOURCE }) }))
      .toThrow(/VAULT_READ_API_CONSUME_SCOPES\[1\]\.address không phải địa chỉ script/);
  });
});
