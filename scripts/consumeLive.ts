// scripts/consumeLive.ts — dò UTxO SỐNG của hạ tầng consume theo NFT định danh.
//
// Beacon PriceParam và luồng Engage bị TIÊU rồi tạo lại sau mỗi PostPrice (keeper,
// mỗi epoch) và sau mỗi tx consume. Nên một con trỏ `txHash#idx` lưu trong sổ chết ngay
// lượt keeper kế tiếp — đo 2026-09-24: `PRICE_BEACON_UTXO` của cụm Preprod mới trỏ
// `40a26805…#0`, keeper đã tiêu nó lúc lên epoch 4144, và `consume_only.ts` dừng ở câu
// "Beacon UTxO thiếu" mà không nói vì sao. Chỉ hash và policy là bất biến; UTxO sống thì
// DÒ LẠI mỗi lượt. Dùng chung cho `resolve_consume_state.ts` và `test/consume_only.ts`
// để hai đường không trôi khỏi nhau.

import {
  credentialToAddress, scriptHashToCredential,
  type LucidEvolution, type Network, type UTxO,
} from "@lucid-evolution/lucid";

/** UTxO duy nhất mang đúng 1 đơn vị `unit`. Không có ⟹ null. Hơn một ⟹ ném. */
export function findByNft(utxos: UTxO[], unit: string): UTxO | null {
  const hits = utxos.filter((u) => (u.assets[unit] ?? 0n) === 1n);
  if (hits.length > 1) {
    throw new Error(
      `${hits.length} UTxO cùng mang ${unit} — NFT định danh lẽ ra là duy nhất. ` +
        `Dừng thay vì đoán: đoán sai là tiêu nhầm UTxO.`,
    );
  }
  return hits[0] ?? null;
}

export interface LiveConsumeUtxos {
  consumeAddr: string;
  priceAddr: string;
  beacon: UTxO | null;
  engage: UTxO | null;
}

/**
 * Thử lại trước khi kết luận "không có": chỉ mục Blockfrost nhất-quán-dần, một lần trả
 * rỗng thoáng qua đọc y hệt một hạ tầng đã chết. Trả `null` ở vế nào còn thiếu sau
 * `tries` lượt — người gọi quyết câu lỗi, vì hành động đúng khác nhau theo chỗ gọi.
 */
export async function findLiveConsumeUtxos(opts: {
  lucid: LucidEvolution;
  network: Network;
  consumeHash: string;
  priceParamHash: string;
  priceNftUnit: string;
  engageNftUnit: string;
  tries?: number;
  gapMs?: number;
  log?: (line: string) => void;
}): Promise<LiveConsumeUtxos> {
  const { lucid, network, consumeHash, priceParamHash, priceNftUnit, engageNftUnit } = opts;
  const tries = opts.tries ?? 4;
  const gapMs = opts.gapMs ?? 15_000;
  const log = opts.log ?? ((l: string) => console.error(l));
  const consumeAddr = credentialToAddress(network, scriptHashToCredential(consumeHash));
  const priceAddr = credentialToAddress(network, scriptHashToCredential(priceParamHash));

  let beacon: UTxO | null = null;
  let engage: UTxO | null = null;
  for (let i = 1; i <= tries; i++) {
    beacon = findByNft(await lucid.utxosAt(priceAddr), priceNftUnit);
    engage = findByNft(await lucid.utxosAt(consumeAddr), engageNftUnit);
    if (beacon && engage) break;
    if (i < tries) {
      log(
        `  … lượt ${i}/${tries}: ${beacon ? "" : "chưa thấy beacon"}` +
          `${!beacon && !engage ? " + " : ""}${engage ? "" : "chưa thấy engage"}` +
          ` — chờ ${gapMs / 1000}s (chỉ mục nhất-quán-dần)`,
      );
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }
  return { consumeAddr, priceAddr, beacon, engage };
}
