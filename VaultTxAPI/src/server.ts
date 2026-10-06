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
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

import type { PlutusJson } from "@magiclamp/sdk";

import { BlockfrostChainReader, PendingSpendsFilteredChain } from "./chain.js";
import { loadConfig, isLoopback, type Deployment } from "./config.js";
import { handle } from "./http.js";
import { IssuedTxRegistry, OwnerLockTable, PendingSpends } from "./locks.js";
import { blockRoutingOf, makeBlockServices } from "./blocks.js";
import { SdkTxBuilder } from "./txBuilder.js";
import { DidStakeWitnessProvider } from "./owner.js";
import { DidOwnerResolver } from "./didOwner.js";
import { ChainDidPaymentAnchorReader } from "./funding.js";
import { FeeProxy } from "./feeProxy.js";
import { SponsorTxService } from "./sponsor.js";
import { PREPAID_VAULT_TYPE } from "./config.js";
import type { PrepaidBlueprint } from "@magiclamp/prepaidgen-sdk";
import { readBuildInfo } from "./buildInfo.js";
import { readJsonBody, shellErrorResponse } from "./shell.js";

const cfg = loadConfig();
// Đo MỘT lần lúc khởi động, ở chính cây mã đang chạy: `git pull` sau đó mà không khởi động
// lại thì mã đang chạy vẫn là mã cũ, và commit in ra phải là commit cũ.
const build = readBuildInfo(dirname(fileURLToPath(import.meta.url)));
const vaultPlutusJson = JSON.parse(readFileSync(cfg.vaultPlutusJsonPath, "utf8")) as PlutusJson;

const chain = new BlockfrostChainReader({
  baseUrl: cfg.blockfrostUrl,
  projectId: cfg.blockfrostProjectId,
  timeoutMs: cfg.requestTimeoutMs,
});

const locks = new OwnerLockTable(cfg.lockTtlMs);
// Sổ phát-hành: mỗi dòng hết hạn theo `validTo` của CHÍNH tx đó + biên lệch đồng hồ
// (`validity.ts`), không theo một bội số của khoá mềm.
const issued = new IssuedTxRegistry();
// Input của giao dịch vừa nộp: chỉ phủ khe giữa lúc nút nhận tx và lúc nút đọc thấy input đã
// tiêu (`config.ts` ▸ `pendingSpendsTtlMs`), không mượn TTL khoá mềm nữa.
const pending = new PendingSpends(cfg.pendingSpendsTtlMs);
// Bộ dựng đọc qua lớp lọc để không chọn lại UTxO ví / shard vừa tiêu; đường tra vault của
// dịch vụ đọc bản gốc rồi trả 409 PREVIOUS_TX_PENDING có tên.
const builderChain = new PendingSpendsFilteredChain(chain, pending);

// Nhân chứng chủ script: chỉ khi bản deploy khai `did_stake`. Vắng ⟹ chủ script nhận 501.
const ownerWitness = cfg.deployment.didStake === undefined ? undefined : new DidStakeWitnessProvider({
  network: cfg.network,
  chain,
  anchorNftPolicy: cfg.deployment.didStake.anchorNftPolicy,
});
// Chủ `{type:"did"}`: chỉ khi `did_stake` khai `unapplied_script` (hash đã so lúc nạp cấu hình).
// Vắng ⟹ chủ DID nhận 501; chủ script tường minh vẫn chạy qua `ownerWitness`.
const didStakeCfg = cfg.deployment.didStake;
const didOwner = didStakeCfg?.unappliedScript === undefined ? undefined : new DidOwnerResolver({
  chain,
  anchorNftPolicy: didStakeCfg.anchorNftPolicy,
  unappliedScript: didStakeCfg.unappliedScript,
});
const builderFor = (deployment: Deployment, plutusJson: PlutusJson): SdkTxBuilder => new SdkTxBuilder({
  network: cfg.network,
  blockfrostUrl: cfg.blockfrostUrl,
  blockfrostProjectId: cfg.blockfrostProjectId,
  deployment,
  chain: builderChain,
  vaultPlutusJson: plutusJson,
});
const sdkBuilder = builderFor(cfg.deployment, vaultPlutusJson);

// Khối chính trước, rồi khối phụ (`config.ts` ▸ `loadExtraBlocks`). Mỗi khối một bộ dựng + một dịch
// vụ; khoá mềm, sổ phát-hành, input vừa nộp, nhân chứng chủ dùng CHUNG (`blocks.ts`). `did_stake` đã
// được ép trùng giữa các khối lúc nạp, nên nhân chứng dựng từ khối chính đúng cho mọi khối.
const blockServices = makeBlockServices([
  { deployment: cfg.deployment, builder: sdkBuilder },
  ...cfg.extraBlocks.map(x => ({
    deployment: x.deployment,
    builder: builderFor(x.deployment, JSON.parse(readFileSync(x.vaultPlutusJsonPath, "utf8")) as PlutusJson),
  })),
], {
  network: cfg.network,
  chain,
  locks,
  issued,
  pending,
  lockTtlMs: cfg.lockTtlMs,
  ...(ownerWitness === undefined ? {} : { ownerWitness }),
  ...(didOwner === undefined ? {} : { didOwner }),
  // `funding` did_payment đọc anchor DID dưới CÙNG tham số theo mạng. Vắng ⟹ 501 FUNDING_UNAVAILABLE.
  ...(cfg.deployment.didStake === undefined ? {} : {
    didPaymentAnchor: new ChainDidPaymentAnchorReader({ chain, anchorNftPolicy: cfg.deployment.didStake.anchorNftPolicy }),
  }),
});
// `service` = khối chính; `/health` lấy HỢP `vault_scopes` + mọi nhãn nguồn từ cùng hàm này.
const routing = blockRoutingOf(blockServices);
const { blocks } = routing;


// Hành trình tài trợ: chỉ khi bản deploy phục vụ két Prepaid — khi đó `vaultPlutusJson` CHÍNH LÀ blueprint
// PrepaidGen. Bản deploy khác ⟹ `/tx/sponsor/t*` trả 501 `SPONSOR_UNAVAILABLE`.
const sponsor = cfg.deployment.vaults.some(v => v.vaultType === PREPAID_VAULT_TYPE)
  ? new SponsorTxService({
      network: cfg.network,
      deployment: cfg.deployment,
      chain,
      walletChain: builderChain,
      locks,
      issued,
      pending,
      lockTtlMs: cfg.lockTtlMs,
      ...(ownerWitness === undefined ? {} : { ownerWitness }),
      ...(didOwner === undefined ? {} : { didOwner }),
      prepaidBlueprint: vaultPlutusJson as unknown as PrepaidBlueprint,
      lucidForWallet: (a, u) => sdkBuilder.lucidForWallet(a, u),
    })
  : undefined;

// Proxy Feecover: chỉ khi bản deploy khai `feecover`. Token vào từ cấu hình dưới dạng GIÁ TRỊ;
// không dòng nhật ký nào dưới đây in nó.
const feeProxy = cfg.deployment.feecover === undefined ? undefined : new FeeProxy({
  settings: cfg.deployment.feecover,
  ...(cfg.feecoverAppToken === undefined ? {} : { magicToken: cfg.feecoverAppToken }),
  issued,
  fetch: (url, init) => fetch(url, init),
});

/** Trần thân bài. Một `tx_cbor` + `witness_cbor` nằm gọn dưới mức này; vượt là thứ
 *  không phải yêu cầu hợp lệ, và đọc tiếp chỉ để tốn bộ nhớ. */
const MAX_BODY_BYTES = 512 * 1024;

/** Ghi mã tham chiếu + nguyên nhân gốc — chung cho nhánh 500 của `handle` và nhánh lỗi của vỏ. */
const logInternal = (ref: string, cause: unknown): void => {
  console.error(`[vault-tx-api] ${ref} ←`, cause instanceof Error ? cause.stack : cause);
};

const server = createServer((rq, rs) => {
  const started = Date.now();
  readJsonBody(rq, MAX_BODY_BYTES)
    .then(body =>
      handle(
        {
          method: rq.method ?? "GET",
          url: rq.url ?? "/",
          headers: rq.headers as Record<string, string | undefined>,
          body,
        },
        {
          // service · blocks · deploymentSource · deploymentSources · vaultScopes (HỢP các khối — app mở
          // lối ScheduleGen khi thấy mục Schedule ở đây).
          ...routing,
          network: cfg.network,
          chainLabel: chain.label,
          changeAddressStrategy: cfg.changeAddressStrategy,
          token: cfg.token,
          sponsorToken: cfg.sponsorToken,
          build,
          basePath: cfg.basePath,
          ...(feeProxy === undefined ? {} : { feeProxy }),
          ...(sponsor === undefined ? {} : { sponsor }),
          logInternal,
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
      // Tới được đây là lỗi của VỎ (`handle` đã bắt hết): thân bài hỏng/quá lớn (lỗi người gửi,
      // 400 giữ câu) hoặc lỗi hệ thống (luồng đứt, tuần tự hoá ném) ⟹ 500 + mã tham chiếu.
      // Luật nằm ở `shell.ts` ▸ `shellErrorResponse`, có bài kiểm ở `tests/shell.test.ts`.
      const out = shellErrorResponse(e, logInternal);
      console.error(`[vault-tx-api] vỏ: ${rq.method} ${rq.url} → ${out.status}`);
      if (rs.headersSent) { rs.destroy(); return; }
      rs.writeHead(out.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      rs.end(JSON.stringify(out.body));
    });
});

server.listen(cfg.port, cfg.host, () => {
  console.error(
    `[vault-tx-api] nghe ${cfg.host}:${cfg.port} · mạng ${cfg.network} · nút ${chain.label} · ` +
    `${1 + cfg.extraBlocks.length} khối (${blocks.vaultTypes.join(", ")}) · ` +
    `thẻ bài ${cfg.token === "" ? "TẮT (loopback)" : "bật"} · ` +
    `khoá mềm ${cfg.lockTtlMs}ms · tiền tố ${cfg.basePath === "" ? "không" : cfg.basePath}`,
  );
  console.error("[vault-tx-api] dịch vụ này KHÔNG giữ khoá riêng — chỉ trả giao dịch CHƯA KÝ.");
  if (cfg.token === "" && isLoopback(cfg.host)) {
    console.error(
      "[vault-tx-api] ⚠ không có thẻ bài. Chỉ an toàn chừng nào cổng này còn ở loopback. " +
      "Đặt nó sau một proxy hay mở ra mạng là phải đặt VAULT_TX_API_TOKEN.",
    );
  }
});

const sweeper = setInterval(() => { const t = Date.now(); locks.sweep(t); issued.sweep(t); pending.sweep(t); }, 30_000);
sweeper.unref();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { clearInterval(sweeper); server.close(() => process.exit(0)); });
}
