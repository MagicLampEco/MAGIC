// scripts/deploy/01b_restore_lamp_cap.ts — đưa tLAMP testnet VỀ ĐÚNG TRẦN sau một lần đúc thừa.
//
// 🔴 ĐÂY LÀ SỬA SAI VẬN HÀNH TRÊN TESTNET, KHÔNG PHẢI CƠ CHẾ GIẢM CUNG.
//    LAMP KHÔNG BURN. Giảm lưu hành trên mainnet = CHUYỂN VÀO TREASURY, một bút toán
//    kế toán, không phải một lần đốt (`LAMP/Treasury/CONTRACT.md §5`). Thao tác ở đây
//    không giảm cung — nó HUỶ MỘT LẦN ĐÚC THỪA để tổng lịch sử trở lại ≤ trần.
//
// Chạy (từ `scripts/`): bash run_restore_lamp_cap.sh Preprod --dot
//   Không gọi thẳng `npx tsx` tệp này — nó cần `BLOCKFROST_KEY` + `WALLET_SEED` do
//   wrapper nạp từ kho khoá, và `--dot` là thứ đặt `LAMP_BURN_CONFIRM`.
//
// ── CHUYỆN GÌ ĐÃ XẢY RA ─────────────────────────────────────────────────────
// 2026-08-28, chuỗi E2E chạy `01_mint_lamp.ts` lần thứ hai trên Preprod. Policy
// của bước đó là native `{type:"sig", keyHash:<pkh ví>}` — suy TẤT ĐỊNH từ khoá ví,
// nên lần đúc thứ hai KHÔNG tạo tài sản mới mà CỘNG DỒN lên tài sản cũ. Đo ngay sau:
//     asset 28e916b0…744c414d50 · quantity 72000000000000000 · mint_or_burn_count 2
// = 72 tỷ tLAMP, trong khi TRẦN của LAMP là 36 tỷ.
//
// ── VÌ SAO 36 TỶ LÀ TRẦN, KHÔNG PHẢI SỐ ĐÃ ĐÚC ──────────────────────────────
// `LAMP/Papers/Whitepaper.md:48` nói thẳng: *"Cố định 36 tỷ" không nghĩa là 36 tỷ
// nằm sẵn on-chain. LAMP dùng lazy-mint: token chỉ được tạo khi cần, tổng lịch sử
// luôn ≤ cap.* Mainnet vì thế đang ở mức vài triệu LAMP, không phải 36 tỷ. Bản
// fixture testnet đúc thẳng trọn trần cho tiện — nên vượt trần là vượt THẬT, còn
// "gấp đôi cung" là cách nói không đúng mô hình.
//
// ── ĐỐT ĐƯỢC, NHƯNG KHÔNG XOÁ ĐƯỢC DẤU ──────────────────────────────────────
// Native script cho mint ÂM chừng nào mệnh đề của script còn thoả (ở đây: một chữ
// ký). Nên phần dư đốt được. Nhưng `mint_or_burn_count` chỉ TĂNG: sau khi đốt nó
// thành 3, không về 1. Chuỗi ghi vĩnh viễn rằng cung đã từng vượt trần. Đó là lý do
// cổng ở `01_mint_lamp.ts` đáng giá hơn kịch bản này.
//
// KHÔNG dùng cho LAMP mainnet: LAMP mainnet KHÔNG BURN (`LAMP/Treasury/CONTRACT.md §5`
// — giảm lưu hành = chuyển vào Treasury, là kế toán, không phải đốt).

import {
  Lucid, Blockfrost,
  getAddressDetails, mintingPolicyToId, scriptFromNative,
  type MintingPolicy,
} from "@lucid-evolution/lucid";
import {
  NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet, ASSET_NAMES,
} from "../config.js";
import { onchainSupply } from "../resolve_lamp_policy.js";

/** Trần giao thức, tính bằng oildrop. Fixture testnet neo đúng vào trần này. */
const LAMP_CAP = 36_000_000_000_000_000n;

async function main() {
  console.log("=== Step 1b: Đốt tLAMP đúc vượt trần ===\n");

  if (NETWORK === "Mainnet") {
    throw new Error(
      "Từ chối: LAMP mainnet KHÔNG BURN (LAMP/Treasury/CONTRACT.md §5). Giảm lưu " +
      "hành trên mainnet là CHUYỂN VÀO TREASURY — một bút toán, không phải một lần đốt.",
    );
  }

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const address = await lucid.wallet().address();

  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) throw new Error("Không lấy được payment credential từ ví");
  const mintingPolicy: MintingPolicy = scriptFromNative({
    type: "sig",
    keyHash: paymentCredential.hash,
  });
  const policyId = mintingPolicyToId(mintingPolicy);
  const lampUnit = policyId + ASSET_NAMES.lamp;

  const supply = await onchainSupply(lampUnit);
  const excess = supply - LAMP_CAP;

  console.log(`Mạng:        ${NETWORK}`);
  console.log(`Policy:      ${policyId}`);
  console.log(`Unit:        ${lampUnit}`);
  console.log(`Cung hiện:   ${supply.toLocaleString("en-US")} oildrop = ${(supply / 1_000_000n).toLocaleString("en-US")} LAMP`);
  console.log(`Trần:        ${LAMP_CAP.toLocaleString("en-US")} oildrop = 36,000,000,000 LAMP`);

  if (excess <= 0n) {
    console.log(`\n✓ Không có phần dư (chênh ${excess}). Không có gì để đốt — dừng, không dựng tx.`);
    return;
  }
  console.log(`Phần dư:     ${excess.toLocaleString("en-US")} oildrop = ${(excess / 1_000_000n).toLocaleString("en-US")} LAMP\n`);

  // Đốt CHỈ được phần ví đang giữ. Nếu phần dư đã đi chỗ khác (nằm trong vault,
  // trong một UTxO script) thì không gom về bằng một chữ ký được — và tự ý gom là
  // đụng vào tiền của giao dịch khác.
  const utxos = await lucid.wallet().getUtxos();
  const held = utxos.reduce((s, u) => s + (u.assets[lampUnit] ?? 0n), 0n);
  const ada = utxos.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n);
  console.log(`Ví đang giữ: ${held.toLocaleString("en-US")} oildrop · ${ada / 1_000_000n} tADA`);

  if (held < excess) {
    console.error(
      `\n✗ DỪNG — ví chỉ giữ ${held.toLocaleString("en-US")} oildrop, thiếu ` +
      `${(excess - held).toLocaleString("en-US")} so với phần cần đốt.\n` +
      `  Phần còn lại đang nằm ở nơi khác (vault, UTxO script, ví khác). Đốt một phần ` +
      `rồi báo "đã về trần" là báo sai — nên kịch bản này không đốt một phần.`,
    );
    process.exit(1);
  }
  if (ada < 3_000_000n) throw new Error("Cần ≥ 3 tADA cho phí.");

  if (process.env.LAMP_BURN_CONFIRM !== NETWORK) {
    console.error(`\n✗ DỪNG — bước này ĐỐT ${excess.toLocaleString("en-US")} oildrop trên ${NETWORK}. Ghi lên chuỗi là không hoàn tác được.`);
    console.error(`  Sau khi đốt, mint_or_burn_count sẽ TĂNG (không giảm) — dấu vết ở lại vĩnh viễn.`);
    // Gợi ý PHẢI là lệnh chạy được từ một shell sạch. Chạy thẳng `npx tsx` ở đây thì
    // thiếu `BLOCKFROST_KEY` + `WALLET_SEED` — hai biến đó do wrapper nạp từ kho khoá
    // (`run_restore_lamp_cap.sh:44-45`), nên câu gợi ý cũ dẫn người vận hành sang một
    // lỗi KHÁC ở chỗ khác. Trỏ wrapper: `--dot` chính là thứ đặt biến xác nhận này.
    console.error(`  Nếu đúng ý, chạy từ thư mục \`scripts/\`:\n     bash run_restore_lamp_cap.sh ${NETWORK} --dot`);
    process.exit(1);
  }

  const tx = await lucid
    .newTx()
    // Mint ÂM = burn. Native script không nhận redeemer.
    .mintAssets({ [lampUnit]: -excess })
    .attach.MintingPolicy(mintingPolicy)
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  await lucid.awaitTx(txHash);

  console.log(`\n✅ Đã gửi và tx đã vào khối.`);
  console.log(`   TX hash:   ${txHash}`);
  console.log(`   Explorer:  https://${NETWORK.toLowerCase()}.cardanoscan.io/transaction/${txHash}`);

  // 🔴 `awaitTx` trả về khi tx VÀO KHỐI. Nó KHÔNG nói bảng tổng hợp tài sản của indexer
  //    đã cập nhật — bảng đó nhất-quán-dần, và đo được là trễ hơn vài phút. Bản cũ đọc
  //    `onchainSupply` đúng một lần ngay sau `awaitTx`, thấy còn số cũ, rồi in
  //    "⚠ Cung sau KHÁC trần" + exit 1. Một lần đốt ĐÃ THÀNH CÔNG đọc y hệt một lần hỏng.
  //
  //    Forall §Cổng gác: phép đo phải phân biệt BA trạng thái — khớp · lệch · KHÔNG ĐO
  //    ĐƯỢC — và trạng thái thứ ba không được đội lốt trạng thái thứ hai. Ở đây "indexer
  //    chưa kịp" là trạng thái thứ ba. Nên: thử lại có chờ, và nếu hết lượt vẫn chưa đổi
  //    thì nói đúng rằng CHƯA ĐO ĐƯỢC, kèm phép đo độc lập không đi qua bảng tổng hợp.
  const TRIES = 6, GAP_MS = 20_000;
  let after = 0n, khop = false;
  for (let i = 1; i <= TRIES; i++) {
    after = await onchainSupply(lampUnit);
    if (after === LAMP_CAP) { khop = true; break; }
    if (i < TRIES) {
      console.log(`   … bảng tổng hợp còn đọc ${after.toLocaleString("en-US")} — chờ ${GAP_MS / 1000}s rồi hỏi lại (${i}/${TRIES - 1})`);
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
  }

  if (khop) {
    console.log(`   Cung sau:  ${after.toLocaleString("en-US")} oildrop = 36,000,000,000 LAMP`);
    console.log(`   → Đúng trần 36 tỷ. Chú ý: mint_or_burn_count nay là 3, không về 1.`);
    return;
  }

  // KHÔNG kết luận "đốt hỏng" — tx đã vào khối, chỉ là phép đo này chưa thấy.
  console.log(`\n⏳ CHƯA ĐO ĐƯỢC — không phải "đốt hỏng".`);
  console.log(`   Tx ở trên ĐÃ vào khối. Bảng tổng hợp tài sản của indexer còn đọc`);
  console.log(`   ${after.toLocaleString("en-US")} oildrop sau ${(TRIES - 1) * GAP_MS / 1000}s; bảng đó nhất-quán-dần.`);
  console.log(`\n   Hai phép đo KHÔNG đi qua bảng tổng hợp, dùng cái nào cũng được:`);
  console.log(`   1) tx này đã đốt bao nhiêu — đọc trường \`assets_minted\` (số ÂM là đốt):`);
  console.log(`      curl -s -X POST https://${NETWORK.toLowerCase()}.koios.rest/api/v1/tx_info \\`);
  console.log(`        -H 'Content-Type: application/json' -d '{"_tx_hashes":["${txHash}"],"_assets":true}'`);
  console.log(`   2) tổng đang thực giữ — cộng mọi địa chỉ, đây mới là sổ cái:`);
  console.log(`      curl -s 'https://${NETWORK.toLowerCase()}.koios.rest/api/v1/asset_addresses?_asset_policy=${policyId}&_asset_name=${lampUnit.slice(56)}'`);
  console.log(`\n   Tổng ở phép (2) bằng ${LAMP_CAP.toLocaleString("en-US")} ⟹ đã đúng trần, xong việc.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
