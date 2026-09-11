// VaultReadAPI/scripts/probe.ts — hỏi CHUỖI THẬT một lần, in JSON ra stdout.
//
// Dùng khi cần trả lời "vault của PKH này đang có gì" mà không muốn dựng sidecar.
// Cùng đường đọc với sidecar (cùng `VaultReadService`), nên nó cũng là phép đo đối
// chứng: hai đường ra hai số khác nhau thì một trong hai sai.
//
//   npm run probe -- <owner_pkh> [at_epoch]
//
// Biến môi trường — ĐẶT NGAY TRƯỚC LỆNH, đừng ghi vào tệp nào:
//   VAULT_READ_API_NETWORK   Preview | Preprod | Mainnet
//   VAULT_READ_API_VAULTS    JSON, xem README §Cấu hình
//   BLOCKFROST_PROJECT_ID    GIÁ TRỊ khoá. Kịch bản này KHÔNG mở tệp nào để tìm nó,
//                            KHÔNG nhận đường dẫn tới kho khoá, và KHÔNG in nó ra.
//
// Mã thoát: 0 đọc được · 1 không đọc được chuỗi hoặc tham số sai. Mã thoát là của
// CHÍNH tiến trình này — đừng đọc nó qua một đường ống, ở đó nó là mã của lệnh cuối.

import { BlockfrostChainReader } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { VaultReadError } from "../src/errors.js";
import { VaultReadService, toJsonBody } from "../src/service.js";

async function main(): Promise<number> {
  const ownerPkh = process.argv[2];
  const atEpochRaw = process.argv[3];
  if (!ownerPkh) {
    console.error("dùng: npm run probe -- <owner_pkh> [at_epoch]");
    return 1;
  }

  const cfg = loadConfig();
  const chain = new BlockfrostChainReader({
    baseUrl: cfg.blockfrostUrl,
    projectId: cfg.blockfrostProjectId,
    timeoutMs: cfg.requestTimeoutMs,
  });
  const service = new VaultReadService(cfg.network, cfg.scopes, chain);

  try {
    const outcome = await service.read({
      ownerPkh: ownerPkh.toLowerCase(),
      atEpoch: atEpochRaw === undefined ? undefined : BigInt(atEpochRaw),
    });
    process.stdout.write(JSON.stringify(toJsonBody(outcome), null, 2) + "\n");
    return 0;
  } catch (e) {
    if (e instanceof VaultReadError) {
      process.stdout.write(JSON.stringify(e.toBody(), null, 2) + "\n");
      return 1;
    }
    throw e;
  }
}

main().then(code => { process.exitCode = code; });
