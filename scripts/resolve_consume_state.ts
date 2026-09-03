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
// rồi mỗi lượt chạy DÒ LẠI UTxO sống theo NFT danh tính — đúng việc tệp này làm.
//
// Vào (env, từ deployed.$NET.env):
//   CONSUME_SCRIPT_HASH · PRICE_PARAM_HASH · PRICE_NFT_UNIT · ENGAGE_NFT_UNIT
// Ra (stdout, để wrapper `eval`):
//   export PRICE_BEACON_UTXO=…#n · export ENGAGE_UTXO=…#n
//   export CONSUME_ADDRESS=… · export PRICE_PARAM_ADDRESS=…
// Thoát khác 0 khi thiếu biến vào, hoặc khi không còn UTxO nào mang NFT — cả hai đều
// là "hạ tầng cũ không dùng lại được", và người gọi phải BIẾT điều đó chứ không phải
// lặng lẽ deploy đè.

import {
  Lucid, Blockfrost, credentialToAddress, scriptHashToCredential, type UTxO,
} from "@lucid-evolution/lucid";
import { NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, selectWallet } from "./config.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(
      `✗ thiếu ${name}. Đây là định danh BẤT BIẾN của hạ tầng consume — không có nó ` +
        `thì không dò lại được, và deploy đè sẽ bỏ rơi mọi Engage UTxO cũ.`,
    );
    process.exit(1);
  }
  return v;
}

/** UTxO duy nhất tại `addr` mang đúng 1 đơn vị `unit`. Không có ⟹ null. */
function findByNft(utxos: UTxO[], unit: string): UTxO | null {
  const hits = utxos.filter((u) => (u.assets[unit] ?? 0n) === 1n);
  if (hits.length > 1) {
    console.error(
      `✗ ${hits.length} UTxO cùng mang ${unit} — NFT danh tính lẽ ra là duy nhất. ` +
        `Dừng thay vì đoán: đoán sai là tiêu nhầm UTxO.`,
    );
    process.exit(1);
  }
  return hits[0] ?? null;
}

async function main() {
  const consumeHash = need("CONSUME_SCRIPT_HASH");
  const priceParamHash = need("PRICE_PARAM_HASH");
  const priceNftUnit = need("PRICE_NFT_UNIT");
  const engageNftUnit = need("ENGAGE_NFT_UNIT");

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);

  const consumeAddr = credentialToAddress(NETWORK, scriptHashToCredential(consumeHash));
  const priceAddr = credentialToAddress(NETWORK, scriptHashToCredential(priceParamHash));

  const beacon = findByNft(await lucid.utxosAt(priceAddr), priceNftUnit);
  const engage = findByNft(await lucid.utxosAt(consumeAddr), engageNftUnit);

  console.error(`  mạng             ${NETWORK}`);
  console.error(`  consume address  ${consumeAddr}`);
  console.error(`  price address    ${priceAddr}`);

  if (!beacon) {
    console.error(
      `✗ không còn UTxO nào mang price NFT ${priceNftUnit} tại ${priceAddr}.\n` +
        `  Beacon đã bị tiêu mà không tạo lại ⟹ hạ tầng này CHẾT, không hồi được: ` +
        `price NFT là one-shot, đúc lại là đổi luôn hash consume.`,
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

  console.log(`export CONSUME_ADDRESS=${consumeAddr}`);
  console.log(`export PRICE_PARAM_ADDRESS=${priceAddr}`);
  console.log(`export PRICE_BEACON_UTXO=${beacon.txHash}#${beacon.outputIndex}`);
  console.log(`export ENGAGE_UTXO=${engage.txHash}#${engage.outputIndex}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
