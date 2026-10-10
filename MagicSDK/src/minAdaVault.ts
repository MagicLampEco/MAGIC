// MagicSDK/src/minAdaVault.ts — min-ADA CHÍNH XÁC của output KÉT lúc mở.
//
// ── VÌ SAO KHÔNG ĐỂ MỘT HẰNG, VÀ VÌ SAO KHÔNG CÒN BIÊN ────────────────────────
// Trường `vaultLovelace` mang tên min-ADA nhưng bản đầu mặc định một HẰNG 2 ADA, trong khi datum
// két phình theo `magic_batches` (trần 32) và `loyalty_holdings` (trần 40). Bản thứ hai (2026-09-21)
// tính từ datum nhưng đếm phần NGOÀI datum bằng một hằng chặn trên 249 byte, nhân 1,2 rồi làm tròn
// LÊN ADA chẵn. Đo trên đầu ra thật (coinsPerUtxoByte 4310, 2026-10-10): hằng đó thừa 93–135 byte,
// và sau biên + làm tròn thì két Instant 0 LAMP mở ở 3 ADA trong khi min-ADA thật là 1 719 690;
// két có LAMP + `wakeme_link` mở ở 4 ADA cho min 2 129 140.
//
// Thừa ở đây KHÔNG vô hại: két Instant không có nhánh đóng (mọi nhánh spend ghim NFT danh tính ở
// output), nên lovelace đặt lúc mở khoá vĩnh viễn; và hàng rào phí áp luật L28 cho tx mở két
// (lovelace két ≤ min(3 ADA, minADA + 517 040)) — két 0 LAMP 3 ADA trượt luật đó 763 270 lovelace.
// Phần két phình ở lượt sinh sau do ví trả phí ứng (`VaultTxAPI/tests/minAdaFloor.test.ts`, đầu
// tệp) — nên lúc mở chỉ cần đúng min-ADA của datum genesis, không cần biên cho datum tương lai.
//
// ── CÁCH TÍNH ────────────────────────────────────────────────────────────────
// Dựng lại ĐÚNG output mà Lucid sẽ ghi (`pay.ToAddressWithData`: `TransactionOutputBuilder` +
// địa chỉ + `DatumOption.new_datum` inline) rồi hỏi CML `with_asset_and_min_required_coin` — cùng
// phép tính Lucid dùng (`@lucid-evolution/lucid` 0.4.30 ▸ `ToAddressWithData`). Phép đó giải điểm
// bất động: số byte của chính trường lovelace nằm trong số byte của output, nên không tính tay
// một lần được. Không biên, không làm tròn.
//
// Tên NFT danh tính phụ thuộc seed nhưng LUÔN dài 32 byte (`blake2b_256`), nên min-ADA không phụ
// thuộc seed nào — `createVault` vẫn tính lại trên tên thật sau khi chọn seed và NÉM nếu lệch.

import { CML, assetsToValue, type Assets } from "@lucid-evolution/lucid";

/** Tham số giao thức Babbage+ (`coinsPerUtxoByte`). BẢN SAO — chỉ dùng khi Lucid không mang tham
 *  số giao thức (Lucid dựng không nhà cung cấp, hoặc trình dựng giả trong bài kiểm). Đổi được qua
 *  một lượt cập nhật tham số ⟹ đường thật luôn đọc từ Lucid (`coinsPerUtxoByteOf`). */
export const COINS_PER_UTXO_BYTE_DEFAULT = 4310n;

/**
 * `coinsPerUtxoByte` từ tham số giao thức Lucid đang mang — cùng nguồn mà trình dựng của Lucid
 * dùng để kiểm/nâng lovelace output. Vắng hẳn (không có `config()`, hoặc `protocolParameters`
 * rỗng) ⟹ `COINS_PER_UTXO_BYTE_DEFAULT`, và `source` nói rõ là bản sao. CÓ mà hình dạng lạ (không
 * phải số nguyên dương) ⟹ NÉM: đó là dữ liệu hỏng của nhà cung cấp, đệm bằng hằng là giấu nó.
 */
export function coinsPerUtxoByteOf(
  lucid: unknown,
): { coinsPerUtxoByte: bigint; source: "lucid" | "default" } {
  const cfg = (lucid as { config?: unknown } | null)?.config;
  if (typeof cfg !== "function") return { coinsPerUtxoByte: COINS_PER_UTXO_BYTE_DEFAULT, source: "default" };
  const pp = (cfg.call(lucid) as { protocolParameters?: { coinsPerUtxoByte?: unknown } } | undefined)
    ?.protocolParameters;
  if (pp === undefined || pp === null) {
    return { coinsPerUtxoByte: COINS_PER_UTXO_BYTE_DEFAULT, source: "default" };
  }
  const v = pp.coinsPerUtxoByte;
  const n = typeof v === "bigint" ? v
    : typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v)
    : undefined;
  if (n === undefined || n <= 0n) {
    throw new Error(
      `protocolParameters.coinsPerUtxoByte của Lucid có hình dạng lạ (${String(v)}) — ` +
      `không tính được min-ADA két.`,
    );
  }
  return { coinsPerUtxoByte: n, source: "lucid" };
}

/**
 * min-ADA chính xác (lovelace) của output két: `address` thật, inline datum `datumCborHex` thật,
 * `tokens` = mọi tài sản KHÔNG phải lovelace (NFT danh tính + LAMP nếu có; mục số lượng 0 không
 * được có mặt — `createVault` đã bỏ nó). Mục `lovelace` trong `tokens` bị NÉM, không bị bỏ qua:
 * người gọi truyền nó là đang nhầm phép tính này với value đầy đủ.
 */
export function exactMinAdaForVaultOutput(p: {
  address: string;
  datumCborHex: string;
  tokens: Assets;
  coinsPerUtxoByte: bigint;
}): bigint {
  if ("lovelace" in p.tokens) {
    throw new Error(`exactMinAdaForVaultOutput: \`tokens\` không được mang mục lovelace.`);
  }
  if (p.datumCborHex.length === 0 || p.datumCborHex.length % 2 !== 0) {
    throw new Error(
      `datum CBOR hex rỗng hoặc lẻ ký tự (${p.datumCborHex.length}) — chuỗi đã hỏng, không phải min-ADA sai.`,
    );
  }
  return CML.TransactionOutputBuilder.new()
    .with_address(CML.Address.from_bech32(p.address))
    .with_data(CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(p.datumCborHex)))
    .next()
    .with_asset_and_min_required_coin(assetsToValue(p.tokens).multi_asset(), p.coinsPerUtxoByte)
    .build()
    .output()
    .amount()
    .coin();
}
