// scripts/resolve_consume_state.ts — CHỈ ĐỌC. Dò lại UTxO SỐNG của hạ tầng consume
// từ các định danh BẤT BIẾN đã lưu. Không dựng tx, không ghi gì lên chuỗi.
//
// ── VÌ SAO TỆP NÀY TỒN TẠI ──────────────────────────────────────────────────
// `deploy/09_deploy_consume.ts` đúc price NFT ONE-SHOT. Chạy lại nó là:
//     genesis_ref mới ⟹ price_nft_policy mới ⟹ apply-param của `consume` đổi
//     ⟹ script hash `consume` đổi ⟹ ĐỊA CHỈ đổi ⟹ mọi Engage UTxO đang sống
//     nằm ở địa chỉ cũ, không bản `consume` nào mới tiêu được chúng.
// Nghĩa là mỗi lượt chạy chặng 2 dựng ra một "vũ trụ consume" mới và bỏ lại vũ trụ
// cũ cùng toàn bộ kế toán tiêu dùng trong đó. Đây là chốt chặn thật giữa "E2E chạy
// được một lần" và "chạy lại được".
//
// Nhưng KHÔNG cache được thẳng PRICE_BEACON_UTXO / ENGAGE_UTXO: hai UTxO đó bị TIÊU
// và tạo lại sau mỗi tx consume (và sau mỗi PostPrice), nên giá trị lưu hôm qua trỏ
// vào một UTxO đã chết. Chỉ HASH và POLICY là bất biến. Nên đường đúng là: lưu hash,
// rồi mỗi lượt chạy DÒ LẠI UTxO sống theo NFT danh tính — đúng việc tệp này làm. Phép
// dò nằm ở `scripts/consumeLive.ts`, dùng chung với `test/consume_only.ts`.
//
// Vào (env, sổ trạng thái đã nạp):
//   VAULT_KIND = schedule | instant — BẮT BUỘC; chọn bộ khoá hậu tố (scripts/consumeBook.ts)
//   CONSUME_SCRIPT_HASH_<LOẠI> · PRICE_PARAM_HASH_<LOẠI> · PRICE_NFT_UNIT_<LOẠI> · ENGAGE_NFT_UNIT_<LOẠI>
// Ra (stdout, để wrapper `eval`), cùng hậu tố:
//   export PRICE_BEACON_UTXO_<LOẠI>=…#n · export ENGAGE_UTXO_<LOẠI>=…#n
//   export CONSUME_ADDRESS_<LOẠI>=… · export PRICE_PARAM_ADDRESS_<LOẠI>=…
//   export REF_CONSUME_UTXO_<LOẠI>=…#n   (khi tìm thấy ở bãi đỗ; ví khác ví deploy: đặt REF_PARK_ADDRESS)
// Thoát khác 0 khi thiếu biến vào, hoặc khi không còn UTxO nào mang NFT — cả hai đều
// là "hạ tầng cũ không dùng lại được", và người gọi phải BIẾT điều đó chứ không phải
// lặng lẽ deploy đè.

import {
  Lucid, Blockfrost, validatorToScriptHash, type UTxO,
} from "@lucid-evolution/lucid";
import { NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet } from "./config.js";
import { parkAddressFor } from "./refScripts.js";
import { consumeKey, parseVaultKind, selectConsumeBook } from "./consumeBook.js";
import { findLiveConsumeUtxos } from "./consumeLive.js";

async function main() {
  const kind = parseVaultKind(process.env.VAULT_KIND);
  try {
    selectConsumeBook(process.env, kind, [
      "CONSUME_SCRIPT_HASH", "PRICE_PARAM_HASH", "PRICE_NFT_UNIT", "ENGAGE_NFT_UNIT",
    ]);
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
  const consumeHash = process.env.CONSUME_SCRIPT_HASH!;
  const priceParamHash = process.env.PRICE_PARAM_HASH!;
  const priceNftUnit = process.env.PRICE_NFT_UNIT!;
  const engageNftUnit = process.env.ENGAGE_NFT_UNIT!;

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);

  // 🔴 THỬ LẠI TRƯỚC KHI KẾT LUẬN "CHẾT". Ba trạng thái, không phải hai.
  //
  //  Thông điệp phía dưới nói "hạ tầng này CHẾT, không hồi được" — một kết luận VĨNH
  //  VIỄN, và nó dẫn thẳng tới một hành động phá: người chạy đúc lại hạ tầng thứ hai
  //  trong khi bộ cũ còn sống. Nhưng đầu vào của kết luận đó là MỘT lần hỏi chỉ mục,
  //  không thử lại. Chỉ mục Blockfrost nhất-quán-dần — chính kho này đã ghi nhận hiện
  //  tượng ấy ở `test/schedule_fire_only.ts` (vòng 5 lượt) và ở
  //  `deploy/01b_restore_lamp_cap.ts` (vòng 6 lượt, kèm nhãn "CHƯA ĐO ĐƯỢC").
  //  ⟹ một lần trả rỗng thoáng qua đọc y hệt một hạ tầng đã chết.
  //
  //  Forall §Cổng gác: khớp · lệch · KHÔNG ĐO ĐƯỢC là BA trạng thái, và trạng thái thứ
  //  ba không được đội lốt trạng thái thứ hai. Ở đây trạng thái thứ ba còn nguy hơn
  //  thường lệ, vì hành động nó xui ra là bất khả hồi: price NFT one-shot, đúc lại là
  //  đổi hash consume ⟹ mọi Engage UTxO đang sống thành mồ côi.
  const TRIES = 4, GAP_MS = 15_000;
  let found;
  try {
    found = await findLiveConsumeUtxos({
      lucid, network: NETWORK, consumeHash, priceParamHash, priceNftUnit, engageNftUnit,
      tries: TRIES, gapMs: GAP_MS,
    });
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
  const { beacon, engage, consumeAddr, priceAddr } = found;

  console.error(`  mạng             ${NETWORK}`);
  console.error(`  loại vault       ${kind}`);
  console.error(`  consume address  ${consumeAddr}`);
  console.error(`  price address    ${priceAddr}`);

  if (!beacon) {
    console.error(
      `✗ sau ${TRIES} lượt (${(TRIES * GAP_MS) / 1000}s) vẫn không thấy UTxO nào mang ` +
        `price NFT ${priceNftUnit} tại ${priceAddr}.\n` +
        `  HAI KHẢ NĂNG, và chúng đòi hai hành động NGƯỢC NHAU — đừng đoán:\n` +
        `   (a) beacon đã bị tiêu mà không tạo lại ⟹ hạ tầng này chết thật. Price NFT là\n` +
        `       one-shot, đúc lại là đổi luôn hash consume ⟹ mọi Engage UTxO đang sống\n` +
        `       thành mồ côi, kèm toàn bộ kế toán tiêu dùng trong đó.\n` +
        `   (b) chỉ mục còn trễ. Hiếm sau ${(TRIES * GAP_MS) / 1000}s, nhưng KHÔNG loại trừ được\n` +
        `       từ phía kịch bản này.\n` +
        `  PHÂN BIỆT bằng đường KHÔNG qua chỉ mục: mở Explorer soi địa chỉ trên, xem NFT\n` +
        `  còn nằm ở đó không. Thấy còn ⟹ (b), chờ rồi chạy lại. Thấy mất ⟹ (a).\n` +
        `  ⛔ ĐỪNG chạy lại 09_deploy_consume.ts trước khi phân biệt xong — ở ca (b) nó\n` +
        `     dựng một hạ tầng thứ hai và giết hạ tầng đang sống.`,
    );
    process.exit(1);
  }
  if (!engage) {
    console.error(
      `✗ không còn UTxO nào mang Engage thread NFT ${engageNftUnit} tại ${consumeAddr}.`,
    );
    process.exit(1);
  }

  console.error(`  beacon           ${beacon.txHash}#${beacon.outputIndex}`);
  console.error(`  engage           ${engage.txHash}#${engage.outputIndex}`);

  const K = kind.toUpperCase();
  console.log(`export ${consumeKey("CONSUME_ADDRESS", kind)}=${consumeAddr}`);
  console.log(`export PRICE_PARAM_ADDRESS_${K}=${priceAddr}`);
  console.log(`export ${consumeKey("PRICE_BEACON_UTXO", kind)}=${beacon.txHash}#${beacon.outputIndex}`);
  console.log(`export ${consumeKey("ENGAGE_UTXO", kind)}=${engage.txHash}#${engage.outputIndex}`);

  // Ref-script `consume` ở bãi đỗ. Bãi đỗ suy từ ví NGƯỜI DEPLOY (`parkAddressFor`), không
  // phải ví người chạy tệp này — nên người dùng khác ví deploy phải đặt REF_PARK_ADDRESS
  // (in ở bước 09). Không thấy thì chỉ cảnh báo: hai biến trên vẫn đúng, và `consume_only`
  // tự kiểm hash của REF_CONSUME_UTXO trước khi dựng tx.
  const parkAddr = process.env.REF_PARK_ADDRESS
    ?? parkAddressFor(NETWORK, await lucid.wallet().address());
  let ref: UTxO | undefined;
  try {
    ref = (await lucid.utxosAt(parkAddr)).find(
      (u) => u.scriptRef && validatorToScriptHash(u.scriptRef) === consumeHash,
    );
  } catch (e: any) {
    // Không làm hỏng cả lượt: bốn biến phía trên đã in và vẫn đúng.
    console.error(`⚠ không đọc được bãi đỗ ${parkAddr}: ${e?.message ?? e} — REF_CONSUME_UTXO KHÔNG được in.`);
    return;
  }
  if (ref) {
    console.error(`  consume ref      ${ref.txHash}#${ref.outputIndex}`);
    console.log(`export ${consumeKey("REF_CONSUME_UTXO", kind)}=${ref.txHash}#${ref.outputIndex}`);
  } else {
    console.error(
      `⚠ không thấy ref-script consume ${consumeHash} tại bãi đỗ ${parkAddr}. ` +
        `Chạy bằng ví khác ví deploy thì đặt REF_PARK_ADDRESS rồi chạy lại.`,
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
