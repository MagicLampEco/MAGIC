// VaultReadAPI/src/server.ts — vỏ HTTP mỏng quanh `handle()`.
//
// Chạy:  npm start           (đọc cấu hình từ biến môi trường)
// Dừng:  SIGINT / SIGTERM
//
// Mọi logic ở `http.ts` + `service.ts`. Tệp này chỉ: nạp cấu hình (fail-closed),
// mở socket, và ghi một dòng nhật ký mỗi lượt.

import { createServer } from "node:http";

import { BlockfrostChainReader } from "./chain.js";
import { loadConfig, isLoopback } from "./config.js";
import { handle } from "./http.js";
import { VaultReadService } from "./service.js";

const cfg = loadConfig();

const chain = new BlockfrostChainReader({
  baseUrl: cfg.blockfrostUrl,
  projectId: cfg.blockfrostProjectId,
  timeoutMs: cfg.requestTimeoutMs,
});

const service = new VaultReadService(cfg.network, cfg.scopes, chain);

const server = createServer((rq, rs) => {
  const started = Date.now();
  handle(
    { method: rq.method ?? "GET", url: rq.url ?? "/", headers: rq.headers as Record<string, string | undefined> },
    { service, scopes: cfg.scopes, network: cfg.network, chainLabel: chain.label, token: cfg.token },
  )
    .then(out => {
      const payload = JSON.stringify(out.body);
      rs.writeHead(out.status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      rs.end(payload);
      // Nhật ký KHÔNG mang thẻ bài và KHÔNG mang khoá. PKH thì có — nó là thứ đang tra.
      log(rq.method, rq.url, out.status, Date.now() - started);
    })
    .catch(e => {
      // Đường này chỉ tới được khi chính `handle` ném — nó đã bắt hết, nên tới đây là
      // lỗi của vỏ. Vẫn không in traceback ra ngoài.
      rs.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      rs.end(JSON.stringify({ error: { code: "INTERNAL", message: "Lỗi nội bộ.", details: {} } }));
      console.error("[vault-read-api] lỗi vỏ:", (e as Error).message);
    });
});

server.listen(cfg.port, cfg.host, () => {
  console.error(
    `[vault-read-api] nghe ${cfg.host}:${cfg.port} · mạng ${cfg.network} · nút ${chain.label} · ` +
    `${cfg.scopes.length} địa chỉ vault · thẻ bài ${cfg.token === "" ? "TẮT (loopback)" : "bật"}`,
  );
  if (cfg.token === "" && isLoopback(cfg.host)) {
    console.error(
      "[vault-read-api] ⚠ không có thẻ bài. Chỉ an toàn chừng nào cổng này còn ở loopback. " +
      "Đặt nó sau một proxy hay mở ra mạng là phải đặt VAULT_READ_API_TOKEN.",
    );
  }
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}

function log(method: string | undefined, url: string | undefined, status: number, ms: number): void {
  console.error(`[vault-read-api] ${method} ${url} → ${status} (${ms}ms)`);
}
