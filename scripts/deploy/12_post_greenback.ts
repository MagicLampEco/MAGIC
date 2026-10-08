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
//   GB_EXPECT_EPOCH — tuỳ chọn, số nguyên ≥ 0. Đặt thì KHÔNG gửi khi (a) beacon hiện tại đã ở
//                 epoch ≥ số này (đã có lượt khác ghi), hoặc (b) tx ghi epoch KHÁC số này. Keeper
//                 đặt nó: keeper tính epoch theo tip Blockfrost, bước này tính theo
//                 `Date.now() − 120 s` — hai đồng hồ, và ở đầu epoch chúng ra hai epoch khác nhau.
//   GB_EXPECT_BEACON_REF — tuỳ chọn, `<txHash>#<chỉ số>` của UTxO beacon mà người gọi đã đọc để
//                 ra GB_NANOGIC/DEPEG. Đặt thì UTxO beacon đọc lại được KHÁC ⟹ không gửi. Có mặt
//                 mà sai dạng (kể cả rỗng) ⟹ NÉM. Keeper đặt nó; lý do ở `keeper/greenback.ts` ▸
//                 `greenbackPostEnv`. Ba cổng (a)(b) và cổng này: `greenbackSubmitGate`.
//
// Dòng khoá cho máy đọc (keeper ▸ `keeper/greenback.ts` ▸ `parseGreenBackPostOutput`):
//   GREENBACK_BEACON_TX=<hash>        in NGAY sau khi gửi, trước khi chờ vào khối.
//   GREENBACK_BEACON_CONFIRMED=<hash> in sau khi tx vào khối. Hết trần chờ ⟹ không in, thoát 2.
//   GREENBACK_BEACON_NOT_SENT=<mã>    in khi dừng TRƯỚC lời gọi submit (mã: epoch-reached ·
//                                     beacon-moved · epoch-mismatch · dry-run · error). Hỏng SAU
//                                     khi đã gọi submit thì KHÔNG in dòng này — người đọc phải coi
//                                     là "có thể đã gửi".
//
// Sổ phải có `GREENBACK_BEACON_HASH` (bước 11) và `GEN_BEACONS_GREENBACK_SEED_UTXO` — seed one-shot
// của beacon, cần để dựng lại đúng script (apply-param). Bước dựng lại phải ra ĐÚNG hash trong sổ,
// lệch thì NÉM: tiêu beacon bằng một script khác là tx không bao giờ qua.
// Chỉ chạy testnet (cùng lý do với bước 11: CC-GEN-SURPLUS-SHARD còn TẠM).

import { realpathSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Blockfrost, getAddressDetails, Lucid } from "@lucid-evolution/lucid";
import {
  decodeGreenBackBeacon,
  greenbackBeaconScript,
  loadBlueprint,
  postGreenBackTx,
} from "../../GenBeacons/offchain/src/index.js";
import { awaitTxBounded, chuaDoDuocMessage } from "../awaitTx.js";
import { parseFlag, parseOutRef } from "../runResult.js";
import { stateBookPath } from "../stateBookPath.js";
import { bookToRecord, readBookEntries } from "./11_deploy_gen_beacons.js";
import { pureAdaCompleteOptions } from "../keeper/collateral.js";
import { formatBeaconRef, greenbackSubmitGate, parseExpectBeaconRef, type GreenBackNotSentCode } from "../keeper/greenback.js";

export const GREENBACK_SEED_KEY = "GEN_BEACONS_GREENBACK_SEED_UTXO";

/** Lùi cận dưới cửa sổ hiệu lực — cùng lý do với bước 11 (`OutsideValidityIntervalUTxO`). */
const VALIDITY_BACKOFF_MS = 120_000;

export function parseGbNanogic(raw: string | undefined): bigint {
  if (raw === undefined || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`GB_NANOGIC bắt buộc: số nguyên ≥ 0 (nanogic), nhận "${raw ?? ""}".`);
  }
  return BigInt(raw);
}

/** `GB_EXPECT_EPOCH`: vắng/rỗng ⟹ không ràng buộc; có mặt thì phải là số nguyên ≥ 0. */
export function parseExpectEpoch(raw: string | undefined): bigint | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`GB_EXPECT_EPOCH phải là số nguyên ≥ 0, nhận "${raw}".`);
  return BigInt(raw);
}

/** Lỗi dừng-trước-khi-gửi có mã, để dòng NOT_SENT nói đúng lý do. */
class NotSentError extends Error {
  constructor(readonly code: GreenBackNotSentCode, message: string) { super(message); }
}

/** Bật NGAY trước lời gọi submit. Từ đây trở đi không được in NOT_SENT nữa. */
let submitAttempted = false;

async function main(): Promise<void> {
  const gbNanogic = parseGbNanogic(process.env.GB_NANOGIC);
  const expectEpoch = parseExpectEpoch(process.env.GB_EXPECT_EPOCH);
  const expectRef = parseExpectBeaconRef(process.env.GB_EXPECT_BEACON_REF);
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
  const actualRef = formatBeaconRef(beaconUtxo);
  console.log(`Beacon GBB: ${actualRef}`);
  console.log(`  hiện: gb=${before.gb_nanogic} seq=${before.seq} epoch=${before.epoch} depeg=${before.depeg}`);

  const { tx, datum } = postGreenBackTx(lucid, {
    greenback, beaconUtxo, gbNanogic, depeg, nowMs: Date.now() - VALIDITY_BACKOFF_MS,
  });
  console.log(`  mới: gb=${datum.gb_nanogic} seq=${datum.seq} epoch=${datum.epoch} depeg=${datum.depeg}`);
  const gate = greenbackSubmitGate({
    expectEpoch, expectRef, beaconEpoch: before.epoch, actualRef, txEpoch: datum.epoch,
  });
  if (!gate.ok) throw new NotSentError(gate.code, gate.message);

  // Thế chấp chỉ-ADA: `tx.complete()` trần để Lucid lấy UTxO ví lớn nhất làm thế chấp, kể cả khi nó
  // mang token ⟹ `CollateralContainsNonADA` (ca thật 2026-10-08). Xem `keeper/collateral.ts`.
  const built = await tx.complete(await pureAdaCompleteOptions(lucid));
  if (dryRun) {
    console.log(`\n✔ DRY RUN: tx dựng xong, validator qua khi dựng. Hash thân (chưa gửi): ${built.toHash()}`);
    console.log("GREENBACK_BEACON_NOT_SENT=dry-run");
    return;
  }
  const signed = await built.sign.withWallet().complete();
  submitAttempted = true;
  const h = await signed.submit();
  console.log(`GREENBACK_BEACON_TX=${h}`);
  if (!(await awaitTxBounded(lucid, h))) {
    console.log(chuaDoDuocMessage(h));
    process.exit(2);
  }
  console.log(`GREENBACK_BEACON_CONFIRMED=${h}`);
  console.log(`\n✅ Đã ghi GreenBack. TX hash: ${h}`);
  console.log(`   Beacon mở (depeg=${datum.depeg}) ở epoch ${datum.epoch}..${datum.epoch + 1n} — sau đó phải ghi lại.`);
}

const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    // Chỉ khẳng định "chưa gửi" khi CHƯA chạm lời gọi submit. Submit ném (mất kết nối, quá giờ)
    // thì tx có thể đã vào mempool — im lặng ở đây để người đọc coi là "chưa đo được".
    // Ghi ĐỒNG BỘ: trên macOS stdout nối ống là bất đồng bộ, và `process.exit` ngay sau
    // `console.log` có thể cắt mất dòng — mất dòng này thì keeper đọc thành "chưa đo được"
    // (chiều an toàn), nhưng là một báo động giả mỗi lần.
    if (!submitAttempted) writeSync(1, `GREENBACK_BEACON_NOT_SENT=${e instanceof NotSentError ? e.code : "error"}\n`);
    process.exit(1);
  });
}
