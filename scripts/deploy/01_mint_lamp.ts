// scripts/deploy/01_mint_lamp.ts — Mint testnet LAMP token
// Run: npx tsx deploy/01_mint_lamp.ts
// Result: LAMP_POLICY_ID printed → copy vào .env

import {
  Lucid, Blockfrost,
  getAddressDetails, mintingPolicyToId, scriptFromNative,
  type MintingPolicy,
} from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet, ASSET_NAMES,
} from "../config.js";
import { onchainSupply } from "../resolve_lamp_policy.js";

const LAMP_TOTAL_SUPPLY = 36_000_000_000_000_000n; // 36 × 10^15 oildrop (§19.9)
const LAMP_ASSET_NAME   = ASSET_NAMES.lamp;         // "LAMP" hex

async function main() {
  console.log("=== Step 1: Mint testnet LAMP ===\n");

  // ── Cổng 0: KHÔNG BAO GIỜ chạm Mainnet ──────────────────────────────────
  // `04_deploy_backing_fixture.ts:52` đã có đúng chốt này; tệp NÀY thì chưa, và nó
  // là tệp nguy hiểm nhất trong chín script deploy. Vì `config.ts:63` suy tên asset
  // theo mạng, đặt NETWORK=Mainnet là đúc 36×10^15 đơn vị mang tên **LAMP** thật,
  // dưới một policy id KHÔNG phải policy hiến định. Đốt token thì được; xoá
  // `mint_or_burn_count` khỏi lịch sử chuỗi thì không, và explorer/ví/DEX sẽ hiện
  // hai tài sản cùng tên LAMP mãi mãi.
  // LAMP mainnet không do script này sinh ra — nó là việc của kho LAMP.
  if (NETWORK === "Mainnet") {
    throw new Error(
      "Từ chối: 01_mint_lamp.ts là script TESTNET. Policy của nó là native `sig` " +
      "đúc lại được vô hạn lần — không phải mô hình của LAMP mainnet. Đúc LAMP " +
      "mainnet là việc của kho LAMP, không phải của chuỗi kiểm thử này.",
    );
  }

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);

  const address = await lucid.wallet().address();
  console.log(`Wallet address: ${address}`);

  // Native script `sig` — MỘT chữ ký, KHÔNG có time-lock.
  // 🔴 Dòng cũ ở đây viết "Simple time-locked minting policy". SAI: `{type:"sig"}`
  //    không mang `before`/`after` nào, nên policy này đúc lại được VÔ HẠN LẦN chừng
  //    nào khoá ví còn sống. Chính chỗ đọc-nhầm đó làm người ta yên tâm rằng chạy
  //    lại là vô hại. Nó không vô hại — xem cổng ngay dưới.
  // Production: use multi-sig or native script with proper governance
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Cannot get payment credential from wallet");

  // `Data.to({type:"sig",…})` là mã hoá Plutus Data của một object JS — KHÔNG phải
  // native script. Nó ném "Unsupported type" ngay lúc dựng, nên bước 01 chưa từng
  // chạy được với lucid-evolution 0.4.x. `scriptFromNative` mới là hàm dựng đúng
  // (trả về chính {type:"Native", script:<cbor hex>}).
  const mintingPolicy: MintingPolicy = scriptFromNative({
    type: "sig",
    keyHash: paymentCredential.hash,
  });

  const policyId = mintingPolicyToId(mintingPolicy);
  const lampUnit = policyId + LAMP_ASSET_NAME;

  console.log(`\nPolicy ID: ${policyId}`);
  console.log(`LAMP unit: ${lampUnit}`);
  console.log(`Minting:   ${LAMP_TOTAL_SUPPLY} oildrop = 36,000,000,000 LAMP\n`);

  // ── Cổng 1: HỎI CHUỖI, đừng hỏi biến môi trường ─────────────────────────
  // Policy id trên suy TẤT ĐỊNH từ khoá ví ⟹ cùng ví thì lần chạy nào cũng ra cùng
  // policy. Nên "LAMP_POLICY_ID đang rỗng" chỉ nói MÁY NÀY chưa ghi lại; nó không
  // nói gì về chuỗi. Chuỗi E2E từng kết luận theo biến môi trường và ngày
  // 2026-08-28 nó đúc lần thứ hai lên đúng tài sản cũ trên Preprod:
  //     quantity 72000000000000000 · mint_or_burn_count 2
  // = 72 tỷ tLAMP, VƯỢT TRẦN 36 tỷ (BOUNDARIES.md §1 — 36 tỷ là trần, không phải số
  // đã đúc: LAMP lazy-mint, mainnet lúc đó mới vài triệu). Không validator
  // nào đỏ vì chuyện đó, nên nó lọt.
  const existing = await onchainSupply(lampUnit);
  if (existing > 0n) {
    console.error(
      `\n✗ DỪNG — trên ${NETWORK} đã có ${existing.toLocaleString("en-US")} oildrop ` +
      `(= ${(existing / 1_000_000n).toLocaleString("en-US")} LAMP) dưới đúng policy này.`,
    );
    console.error(`  Đúc tiếp là CỘNG DỒN lên cung cũ, không phải tạo tài sản mới.`);
    console.error(`  Dùng lại giá trị sẵn có:\n     LAMP_POLICY_ID=${policyId}`);
    process.exit(1);
  }

  // ── Cổng 2: đúc lần đầu vẫn là ghi lên chuỗi, phải nói ra ────────────────
  // Cổng 1 đã chặn ca hỏng thật. Cổng này chỉ để bước ghi-chuỗi không bao giờ là
  // hệ quả PHỤ của một lệnh mà người chạy tưởng chỉ đi kiểm thử.
  if (process.env.LAMP_MINT_CONFIRM !== NETWORK) {
    console.error(`\n✗ DỪNG — bước này ĐÚC ${LAMP_TOTAL_SUPPLY} oildrop lên ${NETWORK}. Ghi lên chuỗi là không hoàn tác được.`);
    console.error(`  Trên ${NETWORK} chưa có tài sản này, nên đúc lần đầu là hợp lệ. Nếu đúng ý:`);
    console.error(`     LAMP_MINT_CONFIRM=${NETWORK} npx tsx deploy/01_mint_lamp.ts`);
    process.exit(1);
  }

  const utxos = await lucid.wallet().getUtxos();
  const balance = utxos.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
  console.log(`tADA balance: ${balance / 1_000_000n} ADA`);
  if (balance < 5_000_000n) {
    throw new Error("Need ≥ 5 tADA. Get from: https://docs.cardano.org/cardano-testnet/tools/faucet");
  }

  const tx = await lucid
    .newTx()
    // Native script không nhận redeemer — truyền `Data.void()` ở đây làm lucid
    // xếp mint này vào nhánh Plutus và tx dựng ra sai.
    .mintAssets({ [lampUnit]: LAMP_TOTAL_SUPPLY })
    .attach.MintingPolicy(mintingPolicy)
    .pay.ToAddress(address, { [lampUnit]: LAMP_TOTAL_SUPPLY })
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  // Chờ xác nhận: bước sau tiêu chính UTxO thối của tx này. Không chờ thì node
  // vẫn thấy UTxO cũ ⟹ BadInputsUTxO. Chuỗi deploy trước đây không bước nào chờ.
  await lucid.awaitTx(txHash);

  console.log(`✅ LAMP minted!`);
  console.log(`   TX hash:   ${txHash}`);
  console.log(`   Explorer:  https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);
  console.log(`\n📋 Copy to .env:`);
  console.log(`   LAMP_POLICY_ID=${policyId}`);
  console.log(`\nWait ~20s for confirmation, then run: npx tsx deploy/02_deploy_um.ts`);
}

main().catch((e) => { console.error(e); process.exit(1); });
