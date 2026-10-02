// scripts/deploy/12_post_greenback.ts — ghi một giá trị GreenBack mới lên beacon GBB của cụm Gen v2.0.
// Run: GB_NANOGIC=<số> npx tsx deploy/12_post_greenback.ts
//
// Vì sao có bước này: bước 11 khởi tạo beacon GBB với `gb_nanogic = 0`, và beacon chỉ sống
// `GREENBACK_BEACON_MAX_AGE_EPOCHS` epoch (InstantGen/offchain/src/constants.ts). GB = 0 ⟹ mọi
// shard `lazy_reset` về 0 ⟹ `max_m = 0` ở mọi két: cụm dựng xong vẫn KHÔNG sinh được MAGIC cho tới
// khi có người ghi beacon. Người ghi thật là keeper tầng GreenBack (BOUNDARIES ▸ `B` là một danh
// mục token); bước này là đường ghi TAY cho cụm testnet, cùng hàm dựng `postGreenBackTx`.
//
// Env:
//   GB_NANOGIC  — BẮT BUỘC, số nguyên ≥ 0 (nanogic). Không mặc định: một giá trị GB là một khẳng
//                 định về thặng dư, không phải một hằng của bước này.
//   DEPEG       — "1" ⟹ ghi cờ depeg. Mặc định 0.
//   DRY_RUN     — "1" ⟹ dựng + chạy validator khi dựng, không ký, không gửi.
//   STATE_BOOK_PATH — xem `scripts/stateBookPath.ts`.
//
// Sổ phải có `GREENBACK_BEACON_HASH` (bước 11) và `GEN_BEACONS_GREENBACK_SEED_UTXO` — seed one-shot
// của beacon, cần để dựng lại đúng script (apply-param). Bước dựng lại phải ra ĐÚNG hash trong sổ,
// lệch thì NÉM: tiêu beacon bằng một script khác là tx không bao giờ qua.
// Chỉ chạy testnet (cùng lý do với bước 11: CC-GEN-SURPLUS-SHARD còn TẠM).

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Blockfrost, getAddressDetails, Lucid } from "@lucid-evolution/lucid";
import {
  decodeGreenBackBeacon,
  greenbackBeaconScript,
  loadBlueprint,
  postGreenBackTx,
} from "../../GenBeacons/offchain/src/index.js";
import { parseFlag, parseOutRef } from "../runResult.js";
import { stateBookPath } from "../stateBookPath.js";
import { bookToRecord, readBookEntries } from "./11_deploy_gen_beacons.js";

export const GREENBACK_SEED_KEY = "GEN_BEACONS_GREENBACK_SEED_UTXO";

/** Lùi cận dưới cửa sổ hiệu lực — cùng lý do với bước 11 (`OutsideValidityIntervalUTxO`). */
const VALIDITY_BACKOFF_MS = 120_000;

export function parseGbNanogic(raw: string | undefined): bigint {
  if (raw === undefined || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`GB_NANOGIC bắt buộc: số nguyên ≥ 0 (nanogic), nhận "${raw ?? ""}".`);
  }
  return BigInt(raw);
}

async function main(): Promise<void> {
  const gbNanogic = parseGbNanogic(process.env.GB_NANOGIC);
  const depeg = parseFlag(process.env.DEPEG, "DEPEG");
  const dryRun = parseFlag(process.env.DRY_RUN, "DRY_RUN");

  const { NETWORK, BLOCKFROST_URL, BLOCKFROST_KEY, PROTOCOL, selectWallet } = await import("../config.js");
  if (NETWORK === "Mainnet") throw new Error("Bước 12 chỉ chạy testnet (CC-GEN-SURPLUS-SHARD còn TẠM).");

  const bookPath = stateBookPath(NETWORK);
  const book = bookToRecord(readBookEntries(bookPath));
  const bookHash = book.GREENBACK_BEACON_HASH;
  const seedRaw = book[GREENBACK_SEED_KEY];
  if (!bookHash) throw new Error(`Sổ ${bookPath} thiếu GREENBACK_BEACON_HASH — chạy bước 11 pha beacons trước.`);
  if (!seedRaw) throw new Error(`Sổ ${bookPath} thiếu ${GREENBACK_SEED_KEY} — không dựng lại được script beacon GBB.`);

  console.log(`=== Step 12: ghi GreenBack${dryRun ? " · DRY RUN" : ""} ===\n`);
  console.log(`Network: ${NETWORK} · sổ: ${bookPath}`);

  const lucid = await Lucid(new Blockfrost(BLOCKFROST_URL, BLOCKFROST_KEY), NETWORK);
  selectWallet(lucid);
  const cred = getAddressDetails(await lucid.wallet().address()).paymentCredential;
  if (cred?.type !== "Key") throw new Error("Ví ký không có payment key credential.");

  const greenback = greenbackBeaconScript(loadBlueprint(), NETWORK, {
    writer: cred.hash,
    msPerEpoch: PROTOCOL.MS_PER_EPOCH,
    windowOriginMs:  PROTOCOL.WINDOW_ORIGIN_MS,
    seed: parseOutRef(seedRaw, GREENBACK_SEED_KEY),
  });
  if (greenback.hash !== bookHash) {
    throw new Error(
      `Script GBB dựng lại có hash ${greenback.hash} ≠ sổ ${bookHash} — sai seed, sai ví ghi, hoặc blueprint đã đổi.`,
    );
  }
  const beaconUtxo = await lucid.utxoByUnit(greenback.nftUnit);
  const before = decodeGreenBackBeacon(beaconUtxo.datum);
  console.log(`Beacon GBB: ${beaconUtxo.txHash}#${beaconUtxo.outputIndex}`);
  console.log(`  hiện: gb=${before.gb_nanogic} seq=${before.seq} epoch=${before.epoch} depeg=${before.depeg}`);

  const { tx, datum } = postGreenBackTx(lucid, {
    greenback, beaconUtxo, gbNanogic, depeg, nowMs: Date.now() - VALIDITY_BACKOFF_MS,
  });
  console.log(`  mới: gb=${datum.gb_nanogic} seq=${datum.seq} epoch=${datum.epoch} depeg=${datum.depeg}`);

  const built = await tx.complete();
  if (dryRun) {
    console.log(`\n✔ DRY RUN: tx dựng xong, validator qua khi dựng. Hash thân (chưa gửi): ${built.toHash()}`);
    return;
  }
  const h = await (await built.sign.withWallet().complete()).submit();
  await lucid.awaitTx(h);
  console.log(`\n✅ Đã ghi GreenBack. TX hash: ${h}`);
  console.log(`   Beacon mở (depeg=${datum.depeg}) ở epoch ${datum.epoch}..${datum.epoch + 1n} — sau đó phải ghi lại.`);
}

const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
