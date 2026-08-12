// scripts/prepare_wallet.ts — Bảo đảm ví deploy có đủ UTxO THUẦN ADA.
// Run: npx tsx prepare_wallet.ts   (env: PURE_ADA_COUNT, PURE_ADA_EACH)
//
// Vì sao cần: Cardano cấm tài sản thế chấp (collateral) mang native token
// (`CollateralContainsNonADA`). Ví deploy dùng lâu sẽ gom hết ADA vào các UTxO
// có kèm token, và khi đó MỌI tx có script đều bị node từ chối — không phải lỗi
// validator, mà lỗi hình dạng ví. Các bước one-shot cũng cần UTxO thuần ADA
// riêng làm genesis (03/09 đòi ≥2 cái).
//
// Chạy được nhiều lần: đã đủ thì không dựng tx nào.

import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet } from "./config.js";

const WANT_COUNT = Number(process.env.PURE_ADA_COUNT ?? "5");
const WANT_EACH  = BigInt(process.env.PURE_ADA_EACH  ?? "10000000"); // 10 ADA

async function main() {
  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();

  const utxos = await lucid.wallet().getUtxos();
  const pure = utxos.filter(
    (u) => Object.keys(u.assets).length === 1 && (u.assets.lovelace ?? 0n) >= WANT_EACH,
  );
  console.log(`Ví: ${address}`);
  console.log(`UTxO thuần ADA ≥${WANT_EACH} lovelace: ${pure.length}/${WANT_COUNT}`);

  if (pure.length >= WANT_COUNT) {
    console.log("✔ đã đủ — không dựng tx.");
    return;
  }

  const need = WANT_COUNT - pure.length;
  console.log(`→ tạo thêm ${need} UTxO thuần ADA…`);

  let tx = lucid.newTx();
  for (let i = 0; i < need; i++) tx = tx.pay.ToAddress(address, { lovelace: WANT_EACH });

  const completed = await tx.complete();
  const signed = await completed.sign.withWallet().complete();
  const txHash = await signed.submit();
  await lucid.awaitTx(txHash);
  console.log(`✔ tx: ${txHash}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
