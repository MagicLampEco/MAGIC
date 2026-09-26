// VaultTxAPI/src/server.ts — vỏ HTTP mỏng quanh `handle()`.
//
// Chạy:  npm start   (đọc cấu hình từ biến môi trường — fail-closed, xem `config.ts`)
// Dừng:  SIGINT / SIGTERM
//
// Tệp này chỉ: nạp cấu hình, đọc blueprint, mở socket, đọc thân bài, ghi nhật ký.
// Mọi logic ở `http.ts` + `service.ts`.
//
// KHÔNG có đường nào ở đây đọc hay nhận vật liệu ký. Bí mật duy nhất đi vào tiến trình
// là khoá dự án Blockfrost, dưới dạng GIÁ TRỊ, qua biến môi trường.

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";

import type { PlutusJson } from "@magiclamp/sdk";

import { BlockfrostChainReader } from "./chain.js";
import { loadConfig, isLoopback } from "./config.js";
import { handle } from "./http.js";
import { IssuedTxRegistry, OwnerLockTable } from "./locks.js";
import { VaultTxService } from "./service.js";
import { SdkTxBuilder } from "./txBuilder.js";
import { DidStakeWitnessProvider } from "./owner.js";

const cfg = loadConfig();
const vaultPlutusJson = JSON.parse(readFileSync(cfg.vaultPlutusJsonPath, "utf8")) as PlutusJson;

const chain = new BlockfrostChainReader({
  baseUrl: cfg.blockfrostUrl,
  projectId: cfg.blockfrostProjectId,
  timeoutMs: cfg.requestTimeoutMs,
});

const locks = new OwnerLockTable(cfg.lockTtlMs);
// Sổ phát-hành sống LÂU HƠN khoá mềm: khoá nhả lúc nộp, còn một lần nộp lại vì rớt
// mạng phải đi qua được. Bốn lần là đủ rộng cho ca người dùng ký chậm, và vẫn hữu hạn.
const issued = new IssuedTxRegistry(cfg.lockTtlMs * 4);

const service = new VaultTxService({
  // Nhân chứng chủ script: chỉ khi bản deploy khai `did_stake`. Vắng ⟹ chủ script nhận 501.
  ownerWitness: cfg.deployment.didStake === undefined ? undefined : new DidStakeWitnessProvider({
    network: cfg.network,
    chain,
    anchorNftPolicy: cfg.deployment.didStake.anchorNftPolicy,
  }),
  network: cfg.network,
  deployment: cfg.deployment,
  chain,
  builder: new SdkTxBuilder({
    network: cfg.network,
    blockfrostUrl: cfg.blockfrostUrl,
    blockfrostProjectId: cfg.blockfrostProjectId,
    deployment: cfg.deployment,
    chain,
    vaultPlutusJson,
  }),
  locks,
  issued,
  lockTtlMs: cfg.lockTtlMs,
});

/** Trần thân bài. Một `tx_cbor` + `witness_cbor` nằm gọn dưới mức này; vượt là thứ
 *  không phải yêu cầu hợp lệ, và đọc tiếp chỉ để tốn bộ nhớ. */
const MAX_BODY_BYTES = 512 * 1024;

const server = createServer((rq, rs) => {
  const started = Date.now();
  readBody(rq)
    .then(body =>
      handle(
        {
          method: rq.method ?? "GET",
          url: rq.url ?? "/",
          headers: rq.headers as Record<string, string | undefined>,
          body,
        },
        {
          service,
          deploymentSource: cfg.deployment.source,
          vaultScopes: cfg.deployment.vaults,
          network: cfg.network,
          chainLabel: chain.label,
          changeAddressStrategy: cfg.changeAddressStrategy,
          token: cfg.token,
          logInternal: (ref, cause) => {
            console.error(`[vault-tx-api] ${ref} ←`, cause instanceof Error ? cause.stack : cause);
          },
        },
      ))
    .then(out => {
      const payload = JSON.stringify(out.body);
      rs.writeHead(out.status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      rs.end(payload);
      // Nhật ký KHÔNG mang thẻ bài, KHÔNG mang khoá, KHÔNG mang thân bài.
      console.error(`[vault-tx-api] ${rq.method} ${rq.url} → ${out.status} (${Date.now() - started}ms)`);
    })
    .catch(e => {
      // Tới được đây là lỗi của VỎ (`handle` đã bắt hết). Vẫn không in traceback ra ngoài.
      rs.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      rs.end(JSON.stringify({ error: { code: "BAD_REQUEST", message: (e as Error).message, details: {} } }));
      console.error(`[vault-tx-api] vỏ: ${(e as Error).message}`);
    });
});

server.listen(cfg.port, cfg.host, () => {
  console.error(
    `[vault-tx-api] nghe ${cfg.host}:${cfg.port} · mạng ${cfg.network} · nút ${chain.label} · ` +
    `${cfg.deployment.vaults.length} địa chỉ vault · thẻ bài ${cfg.token === "" ? "TẮT (loopback)" : "bật"} · ` +
    `khoá mềm ${cfg.lockTtlMs}ms`,
  );
  console.error("[vault-tx-api] dịch vụ này KHÔNG giữ khoá riêng — chỉ trả giao dịch CHƯA KÝ.");
  if (cfg.token === "" && isLoopback(cfg.host)) {
    console.error(
      "[vault-tx-api] ⚠ không có thẻ bài. Chỉ an toàn chừng nào cổng này còn ở loopback. " +
      "Đặt nó sau một proxy hay mở ra mạng là phải đặt VAULT_TX_API_TOKEN.",
    );
  }
});

const sweeper = setInterval(() => { locks.sweep(Date.now()); }, 30_000);
sweeper.unref();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { clearInterval(sweeper); server.close(() => process.exit(0)); });
}

/** Đọc thân bài JSON. Thân rỗng ⇒ `undefined` (hợp lệ với GET); thân hỏng ⇒ NÉM. */
function readBody(rq: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    rq.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Thân bài vượt ${MAX_BODY_BYTES} byte.`));
        rq.destroy();
        return;
      }
      chunks.push(c);
    });
    rq.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") { resolve(undefined); return; }
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error(`Thân bài không phải JSON hợp lệ: ${(e as Error).message}`));
      }
    });
    rq.on("error", reject);
  });
}
