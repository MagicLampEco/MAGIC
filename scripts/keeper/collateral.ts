// scripts/keeper/collateral.ts — thế chấp (collateral) LUÔN chỉ-ADA cho mọi tx có script mà
// keeper dựng.
//
// Vì sao cần: Lucid Evolution 0.4.30 `complete()` chọn thế chấp bằng `findCollateral`, mà hàm đó
// sắp MỌI UTxO của ví theo lovelace giảm dần (`sortUTxOs(inputs)`, mặc định LargestFirst) rồi
// lấy từ đầu (`@lucid-evolution/lucid/dist/index.js` ▸ `findCollateral`, ~dòng 1657). Ví keeper
// dùng lâu gom ADA vào UTxO có kèm token ⟹ UTxO lớn nhất mang token ⟹ nó thành thế chấp ⟹ node
// từ chối `CollateralContainsNonADA`. Lượt sau "tự qua" chỉ vì ví đổi hình dạng sau tx trước.
// Ca thật 2026-10-08: hai lượt ghi beacon giá trễ 1–2 giờ trên Preprod.
//
// Cách ép: `complete({ presetWalletInputs })` thay danh sách UTxO ví mà Lucid dùng cho CẢ chọn
// input lẫn chọn thế chấp. Đưa vào đó CHỈ các UTxO thuần ADA, đã sắp tất định ⟹ thế chấp chỉ có
// thể là UTxO thuần ADA. Hệ quả: tx dựng qua đây không bao giờ tiêu UTxO có token của ví, nên
// chỉ dùng cho tx mà ví chỉ TRẢ PHÍ (beacon, fire). Tx cần token từ ví (đúc vault InstantGen cần
// LAMP) không dùng được đường này.
//
// Thế chấp trùng với input thường là hợp lệ (sổ cái cho phép hai tập giao nhau; Lucid vẫn đặt
// `collateral_return` riêng), nên không cần loại UTxO thế chấp khỏi tập chọn input.

import type { LucidEvolution, UTxO } from "@lucid-evolution/lucid";

/** Ngưỡng một UTxO thuần ADA đủ làm thế chấp: 5 ADA (mặc định `setCollateral` của Lucid) cộng
 *  1 ADA chừa cho output `collateral_return` (min-ADA). */
export const MIN_COLLATERAL_UTXO_LOVELACE = 6_000_000n;

/** Thuần ADA = chỉ có `lovelace` trong value VÀ không mang scriptRef (Lucid loại UTxO có
 *  scriptRef khỏi việc chọn thế chấp). */
export function isPureAda(u: UTxO): boolean {
  return u.scriptRef == null && Object.keys(u.assets).every((k) => k === "lovelace");
}

/** Thứ tự tất định: lovelace giảm dần, hoà thì `txHash` rồi `outputIndex` tăng dần. */
function byLovelaceDescThenRef(a: UTxO, b: UTxO): number {
  const la = a.assets.lovelace ?? 0n;
  const lb = b.assets.lovelace ?? 0n;
  if (la !== lb) return la > lb ? -1 : 1;
  if (a.txHash !== b.txHash) return a.txHash < b.txHash ? -1 : 1;
  return a.outputIndex - b.outputIndex;
}

export interface PureAdaSelection {
  /** Mọi UTxO thuần ADA của ví, đã sắp tất định — đưa vào `presetWalletInputs`. */
  inputs: UTxO[];
  /** UTxO thuần ADA lớn nhất (đủ ngưỡng) — chính là UTxO Lucid lấy làm thế chấp. */
  collateral: UTxO;
}

/**
 * Chọn tập UTxO thuần ADA của ví. NÉM khi không có UTxO thuần ADA đủ ngưỡng — không thử may rủi:
 * để Lucid tự chọn trên tập có token là đúng lỗi này.
 * @param label tên/địa chỉ ví, in vào thông điệp lỗi.
 */
export function selectPureAdaInputs(
  utxos: readonly UTxO[],
  label: string,
  minLovelace: bigint = MIN_COLLATERAL_UTXO_LOVELACE,
): PureAdaSelection {
  const inputs = utxos.filter(isPureAda).sort(byLovelaceDescThenRef);
  const collateral = inputs[0];
  if (!collateral || (collateral.assets.lovelace ?? 0n) < minLovelace) {
    const biggest = collateral ? `${collateral.assets.lovelace ?? 0n}` : "—";
    throw new Error(
      `Ví ${label} không có UTxO thuần ADA ≥ ${minLovelace} lovelace để làm thế chấp ` +
      `(${utxos.length} UTxO, ${inputs.length} thuần ADA, lớn nhất ${biggest}). ` +
      `Chạy scripts/prepare_wallet.ts để tách UTxO thuần ADA rồi chạy lại.`,
    );
  }
  return { inputs, collateral };
}

/**
 * Tuỳ chọn cho `TxBuilder.complete()`: thế chấp (và input trả phí) chỉ lấy từ UTxO thuần ADA.
 * Đọc UTxO ví MỚI ở mỗi lần gọi — gọi ngay trước `complete()`, đừng giữ kết quả qua tx khác.
 */
export async function pureAdaCompleteOptions(lucid: LucidEvolution): Promise<{ presetWalletInputs: UTxO[] }> {
  const [address, utxos] = await Promise.all([lucid.wallet().address(), lucid.wallet().getUtxos()]);
  return { presetWalletInputs: selectPureAdaInputs(utxos, address).inputs };
}
