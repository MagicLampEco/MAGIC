// Pre-flight: kiểm tra env load + ví select được + số dư tADA, TRƯỚC khi deploy.
// Không submit tx. Chạy: npx tsx 00_preflight.ts
import { makeLucid, NETWORK } from "./config.js";

const lucid = await makeLucid();
const addr = await lucid.wallet().address();
const utxos = await lucid.wallet().getUtxos();
let lovelace = 0n;
for (const u of utxos) lovelace += u.assets["lovelace"] ?? 0n;

console.log("── Pre-flight LampDistribution ──");
console.log("Network        :", NETWORK);
console.log("Wallet address :", addr);
console.log("UTxO count     :", utxos.length);
console.log("Balance        :", (Number(lovelace) / 1e6).toFixed(6), "tADA");
if (lovelace < 30_000_000n) {
  console.log("\n⚠️  Số dư < 30 tADA — nạp thêm qua faucet Preview trước khi deploy:");
  console.log("   https://docs.cardano.org/cardano-testnets/tools/faucet");
} else {
  console.log("\n✅ Đủ tADA để deploy + e2e.");
}
