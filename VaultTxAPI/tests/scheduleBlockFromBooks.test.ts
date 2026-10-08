// VaultTxAPI/tests/scheduleBlockFromBooks.test.ts — VTA nạp khối chính Instant + khối phụ Schedule từ HAI TỆP
// deployment THẬT của cụm Preprod `493002cc` (wk5), và `/tx/schedule-commit` không còn 501 CONFIG_MISSING.
//
// Nguồn fixture: `tests/fixtures/books-preprod-493002cc-wk5/deployment.Preprod.{Instant,Schedule}.json` — bản chép
// nguyên văn (trừ trường `source`: bỏ đường dẫn nội bộ của sổ; đo 2026-10-08) từ sổ cụm
// nội bộ `preprod-serving-493002cc-wk5` (mtime 2026-10-04 11:02). Đó là ảnh chụp,
// KHÔNG phải nguồn: sổ đổi (cụm đời mới) thì bản chép ở đây cũ đi; bài này chứng minh HÌNH DẠNG hai tệp cùng
// một cụm nạp được cùng nhau, không chứng minh sổ hôm nay còn đúng.
//
// Đo trên máy chủ thật 2026-10-08 (quote live): chỉ nạp khối Instant ⟹ `schedule-commit` ⟹ 501
// `CONFIG_MISSING ref_script_utxos.commit`. Bài này tái hiện đúng trạng thái đó (một khối), rồi cặp với hai khối.
//
// Blueprint: `loadExtraBlocks` chỉ đòi tệp đọc được, có mảng `validators` (script thật lấy từ ref-script trên chuỗi,
// `txBuilder.ts` ▸ `scheduleScripts`), nên ở đây dùng blueprint rút gọn như `multiBlock.test.ts`. Blueprint ScheduleGen
// thật dựng bằng `aiken build ScheduleGen/onchain` ở commit deploy — KHÔNG đo ở bài này.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { blockRoutingOf, makeBlockServices } from "../src/blocks.js";
import { RecordedChainReader, type ChainTip } from "../src/chain.js";
import { loadConfig, parseDeployment } from "../src/config.js";
import { handle, type RouterDeps } from "../src/http.js";
import { IssuedTxRegistry, OwnerLockTable, PendingSpends } from "../src/locks.js";
import { RecordedTxBuilder } from "../src/txBuilder.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOKS = join(HERE, "fixtures", "books-preprod-493002cc-wk5");
const INSTANT_FILE = join(BOOKS, "deployment.Preprod.Instant.json");
const SCHEDULE_FILE = join(BOOKS, "deployment.Preprod.Schedule.json");

const NOW = 1_789_100_703_000;
const TIP: ChainTip = { blockHeight: 1, blockHash: "14".repeat(32), blockTimePosixMs: BigInt(NOW) };
const TTL = 180_000;
const OWNER_PKH = "ab".repeat(28);

let blueprintPath = "";
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "vta-books-"));
  blueprintPath = join(dir, "plutus.json");
  writeFileSync(blueprintPath, JSON.stringify({
    preamble: { compiler: { name: "Aiken", version: "v1.1.21" } },
    validators: [{ title: "vault.vault.spend", compiledCode: "59", hash: "aa".repeat(28) }],
  }));
});

/** Biến môi trường tối thiểu của VTA live (không thẻ, loopback) + khối chính = tệp Instant. */
const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const base: Record<string, string | undefined> = {
    VAULT_TX_API_NETWORK: "Preprod",
    BLOCKFROST_PROJECT_ID: "dummy",
    VAULT_TX_API_DEPLOYMENT: readFileSync(INSTANT_FILE, "utf8"),
    VAULT_TX_API_CHANGE_ADDRESS_STRATEGY: "enterprise_from_owner_pkh",
    VAULT_TX_API_VAULT_PLUTUS_JSON: blueprintPath,
    ...over,
  };
  for (const [k, v] of Object.entries(base)) if (v === undefined) delete base[k];
  return base as NodeJS.ProcessEnv;
};
/** Hai biến khối phụ — ghép theo VỊ TRÍ (tệp deployment, blueprint). */
const scheduleEnv = (): Record<string, string> => ({
  VAULT_TX_API_EXTRA_DEPLOYMENT_FILES: SCHEDULE_FILE,
  VAULT_TX_API_EXTRA_VAULT_PLUTUS_JSONS: blueprintPath,
});
const withSchedule = () => env(scheduleEnv());

const schedJson = () => JSON.parse(readFileSync(SCHEDULE_FILE, "utf8")) as {
  ref_script_utxos: { commit: string; gb_shard: string };
};

describe("nạp cấu hình bằng hai tệp sổ thật", () => {
  it("CHỈ khối Instant (trạng thái live đo 2026-10-08) ⟹ nạp được, không có khối phụ, không loại két Schedule", () => {
    const c = loadConfig(env());
    expect(c.extraBlocks).toEqual([]);
    expect(c.deployment.vaults.map(v => v.vaultType)).toEqual(["Instant"]);
    expect(c.deployment.refScriptUtxos.commit).toBeUndefined();
  });

  it("Instant (chính) + Schedule (phụ qua EXTRA_*) ⟹ qua loadExtraBlocks + assertCompatibleBlocks; khối phụ mang `commit` của tệp", () => {
    const c = loadConfig(withSchedule());
    expect(c.extraBlocks).toHaveLength(1);
    const x = c.extraBlocks[0]!;
    expect(x.file).toBe(SCHEDULE_FILE);
    expect(x.vaultPlutusJsonPath).toBe(blueprintPath);
    expect(x.deployment.vaults.map(v => v.vaultType)).toEqual(["Schedule"]);
    const j = schedJson();
    expect(`${x.deployment.refScriptUtxos.commit?.txHash}#${x.deployment.refScriptUtxos.commit?.outputIndex}`).toBe(j.ref_script_utxos.commit);
    expect(x.deployment.refScriptUtxos.gbShard).toBeDefined();
    // Cùng cụm ⟹ cùng LAMP, cùng did_stake: hai điều kiện dùng chung mà `assertCompatibleBlocks` ép.
    expect(x.deployment.lampPolicyId).toBe(c.deployment.lampPolicyId);
    expect(x.deployment.lampAssetNameHex).toBe(c.deployment.lampAssetNameHex);
    // Khối chính KHÔNG đổi vì có khối phụ.
    expect(c.deployment.vaults.map(v => v.vaultType)).toEqual(["Instant"]);
  });

  it("CỰC ĐỐI: hai khối Instant ⟹ khởi động THẤT BẠI (mỗi loại két đúng một khối); khối phụ lệch mạng ⟹ thất bại", () => {
    expect(() => loadConfig(env({
      VAULT_TX_API_EXTRA_DEPLOYMENT_FILES: INSTANT_FILE, VAULT_TX_API_EXTRA_VAULT_PLUTUS_JSONS: blueprintPath,
    }))).toThrow(/mỗi loại két/);
    expect(() => loadConfig(env({ ...scheduleEnv(), VAULT_TX_API_NETWORK: "Preview" }))).toThrow();
  });
});

describe("/tx/schedule-commit trên khối dựng từ hai tệp sổ", () => {
  function router(blocks: "instant-only" | "instant+schedule"): { router: RouterDeps; builders: RecordedTxBuilder[] } {
    const c = loadConfig(blocks === "instant-only" ? env() : withSchedule());
    const chain = new RecordedChainReader({}, TIP, []);
    const builders = [new RecordedTxBuilder({}), ...c.extraBlocks.map(() => new RecordedTxBuilder({}))];
    const services = makeBlockServices([
      { deployment: c.deployment, builder: builders[0]! },
      ...c.extraBlocks.map((x, i) => ({ deployment: x.deployment, builder: builders[i + 1]! })),
    ], {
      network: "Preprod", chain, locks: new OwnerLockTable(TTL), issued: new IssuedTxRegistry(),
      pending: new PendingSpends(TTL), lockTtlMs: TTL, now: () => NOW,
    });
    return {
      builders,
      router: {
        ...blockRoutingOf(services), network: "Preprod", chainLabel: "recorded",
        changeAddressStrategy: "enterprise_from_owner_pkh", token: "", logInternal: () => {}, now: () => NOW,
      },
    };
  }
  const post = () => ({
    method: "POST", url: "/tx/schedule-commit", headers: {},
    body: { owner_pkh: OWNER_PKH, schedule_length: "3", lamp_per_epoch: "7000000" },
  });
  const errOf = (r: { body: unknown }) => (r.body as { error: { code: string; details: Record<string, unknown> } }).error;

  it("một khối Instant ⟹ 501 CONFIG_MISSING nêu `ref_script_utxos.commit` (tái hiện quote live)", async () => {
    const h = router("instant-only");
    const r = await handle(post(), h.router);
    expect(r.status).toBe(501);
    expect(errOf(r).code).toBe("CONFIG_MISSING");
    expect(errOf(r).details.missing).toBe("deployment.ref_script_utxos.commit");
  });

  it("CẶP: thêm khối Schedule từ tệp sổ ⟹ định tuyến tới khối Schedule, QUA cổng cấu hình (không còn CONFIG_MISSING)", async () => {
    const h = router("instant+schedule");
    const r = await handle(post(), h.router);
    // Chuỗi ghi sẵn rỗng ⟹ chết ở bước sau cổng cấu hình (không có két của chủ). Điều cần đo: KHÔNG phải 501 CONFIG_MISSING.
    expect(r.status, JSON.stringify(r.body)).not.toBe(501);
    const code = (r.body as { error?: { code: string } }).error?.code;
    expect(code).not.toBe("CONFIG_MISSING");
    expect(code).not.toBe("VAULT_TYPE_NOT_SERVED");
  });

  it("/health với hai khối: vault_scopes = Instant rồi Schedule; deployment_sources hai nhãn", async () => {
    const h = router("instant+schedule");
    const r = await handle({ method: "GET", url: "/health", headers: {} }, h.router);
    expect(r.status).toBe(200);
    const b = r.body as { vault_scopes: { vault_type: string }[]; deployment_sources: string[] };
    expect(b.vault_scopes.map(s => s.vault_type)).toEqual(["Instant", "Schedule"]);
    expect(b.deployment_sources).toHaveLength(2);
    const sources = [INSTANT_FILE, SCHEDULE_FILE].map(f => (JSON.parse(readFileSync(f, "utf8")) as { source: string }).source);
    expect(b.deployment_sources).toEqual(sources);
    // Nhãn mở đầu bằng tên mạng (điều kiện `assertCompatibleBlocks` đo được).
    for (const s of sources) expect(s.startsWith("Preprod")).toBe(true);
  });

  it("parseDeployment của riêng tệp Schedule (khối chính) cũng hợp lệ — tệp không phụ thuộc vị trí khối", () => {
    const d = parseDeployment(readFileSync(SCHEDULE_FILE, "utf8"), "Preprod");
    expect(d.refScriptUtxos.commit).toBeDefined();
  });
});
