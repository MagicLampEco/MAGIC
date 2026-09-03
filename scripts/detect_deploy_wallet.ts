// scripts/detect_deploy_wallet.ts — Dò biến seed trong $AGENT_SECRETS DẪN RA ví deploy.
//
// In DUY NHẤT tên biến ra stdout (vd "FOUNDATION_SEED"). Chẩn đoán → stderr.
// TUYỆT ĐỐI KHÔNG in seed/mnemonic. Dẫn xuất địa chỉ là OFFLINE (không gọi mạng cho
// từng seed) — chỉ so địa chỉ testnet với TARGET (chung Preview+Preprod, cùng network-id 0).
//
// Chạy (tại Terminal của anh): npx tsx detect_deploy_wallet.ts
//   Override đích: TARGET_ADDR=addr_test1... npx tsx detect_deploy_wallet.ts
//
// Dùng trong wrapper:  SEED_VAR="$(npx tsx detect_deploy_wallet.ts)"

import { readFileSync } from "node:fs";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";

const TARGET =
  process.env.TARGET_ADDR ??
  "addr_test1qqh9u9qc4l2q9eyzx2c58pmpqn9vvxy2gjux0lah2wp33axx7cqq55f75fypagzqnelz3uzwxf764qzjx8kvaaw3q3yq8fyl7p";

const envPath = process.env.AGENT_SECRETS;
if (!envPath) { console.error("✗ AGENT_SECRETS chưa set"); process.exit(2); }

const raw = readFileSync(envPath, "utf8");
const vars: Record<string, string> = {};
for (const line of raw.split("\n")) {
  const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m) vars[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

// Preview Blockfrost key CHỈ để khởi tạo Lucid (fetch protocol-params 1 lần).
// Dẫn xuất địa chỉ per-seed là offline. Địa chỉ testnet giống nhau cho Preview+Preprod.
const bfKey = vars["Blockfrost_GreenSun_Preview"];
if (!bfKey) { console.error("✗ thiếu Blockfrost_GreenSun_Preview trong $AGENT_SECRETS"); process.exit(2); }

const lucid = await Lucid(
  new Blockfrost("https://cardano-preview.blockfrost.io/api/v0", bfKey),
  "Preview",
);

const seedVars = Object.keys(vars).filter((k) => /SEED|MNEMONIC/i.test(k));
for (const name of seedVars) {
  const seed = vars[name].trim().replace(/\s+/g, " ");
  if (seed.split(" ").length < 12) continue; // không phải mnemonic
  try {
    lucid.selectWallet.fromSeed(seed);
    const addr = await lucid.wallet().address();
    if (addr === TARGET) {
      console.error(`✓ khớp ví deploy: biến ${name}`);
      console.log(name); // <-- DUY NHẤT dòng stdout (tên biến, không phải value)
      process.exit(0);
    }
  } catch { /* seed không dẫn xuất được — bỏ qua */ }
}

console.error(`✗ Không biến seed nào dẫn ra ví deploy ${TARGET.slice(0, 20)}…${TARGET.slice(-8)}.`);
console.error("  Kiểm tra TARGET_ADDR, hoặc ví deploy dùng seed tên khác.");
process.exit(1);
