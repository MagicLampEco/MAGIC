// MagicSDK/src/minAdaVault.ts — min-ADA của UTxO KÉT, tính từ chính datum.
//
// ── VÌ SAO KHÔNG ĐỂ MỘT HẰNG ──────────────────────────────────────────────────
// Trường `vaultLovelace` mang tên min-ADA nhưng bản trước mặc định một HẰNG
// 2 ADA. Datum két thì phình theo `magic_batches` (trần 32) và
// `loyalty_holdings` (trần 40), nên một hằng không thể đúng ở cả hai đầu.
//
// Đo 2026-09-21 bằng `MagicSDK/tests/minAdaVault.test.ts`, mã hoá `VaultDatum`
// bằng ĐÚNG lược đồ sản xuất (không phải hex bịa). Cột "thô" là công thức dưới
// đây, chưa cộng biên:
//
//   batch  holding   datum (byte)   thô (lovelace)   +biên
//     0       0           86          2 133 450      3 ADA
//     1       0          120          2 279 990      3 ADA
//     4       5          290          3 012 690      4 ADA
//     8      10          492          3 883 310      5 ADA
//    16      20          896          5 624 550      7 ADA
//    32      40        1 705          9 111 340     11 ADA
//   Schedule ở trần    1 704          9 107 030     10 ADA
//
// 🔴 Đọc bảng này ĐÚNG MỨC. Cột "thô" dùng `VAULT_NON_DATUM_BYTES` là một chặn
// TRÊN cố ý, nên nó là một chặn TRÊN của min-ADA, không phải min-ADA của sổ
// cái. Nó KHÔNG chứng minh rằng một két rỗng 2 ADA từng bị sổ cái từ chối —
// nó chỉ nói rằng hằng 2 ADA không có biên nào cả, và biến mất khỏi vùng an
// toàn trong vòng vài batch. Phát biểu chắc duy nhất rút ra được: một HẰNG
// không trả lời được câu hỏi này, vì đại lượng thật thay đổi gấp hơn bốn lần
// giữa két rỗng và két ở trần.
//
// Hỏng ở đây hỏng MUỘN: sổ cái từ chối output thiếu min-ADA ở lúc GỬI, tức sau
// khi người dùng đã ký. Không có cổng nào ở phía trước nó.
//
// ── CÔNG THỨC, VÀ PHẠM VI CỦA NÓ ─────────────────────────────────────────────
//   minAda = (160 + số byte của UTxO) × coinsPerUtxoByte
// `coinsPerUtxoByte = 4310` từ Babbage. Đây là THAM SỐ GIAO THỨC, đổi được qua
// một lượt cập nhật tham số ⟹ hằng dưới đây là một BẢN SAO và được khai đúng
// như vậy. Chỗ nào tra được giá trị thật từ node thì truyền vào.
//
// 🔴 Con số trả về là CẬN DƯỚI cộng biên, KHÔNG phải min-ADA chính xác của sổ
// cái. Phép đếm byte ở đây đếm datum theo độ dài thật và ước lượng phần còn lại
// (địa chỉ, khối value, các tag CBOR) bằng hằng chặn trên. Nó an toàn theo đúng
// một chiều: thừa thì tốn ADA của người dùng, thiếu thì giao dịch bị từ chối —
// nên mọi hằng ở đây chọn phía THỪA.

/** Tham số giao thức Babbage+. BẢN SAO — xem khối trên. */
export const COINS_PER_UTXO_BYTE_DEFAULT = 4310n;

/** Phụ phí cố định mà công thức của sổ cái cộng vào mọi UTxO. */
const UTXO_OVERHEAD_BYTES = 160n;

/**
 * Chặn TRÊN cho phần không phải datum của một output két: địa chỉ base có phần
 * stake (57) + khối value mang lovelace, LAMP và NFT danh-tính (2 policy × 28
 * byte + tên + số lượng + tag) + các tag CBOR của chính output.
 * Chọn phía thừa có chủ ý — xem khối đỏ ở trên.
 */
const VAULT_NON_DATUM_BYTES = 57n + 160n + 32n;

/** Biên 20%, làm tròn LÊN ADA chẵn. Nhỏ CÓ CHỦ Ý: đủ nuốt sai số mã hoá, không
 *  đủ nuốt một lượt datum phình thêm nghìn byte. Biên lớn sẽ giấu đúng cái nó
 *  phải làm lộ ra. */
const MARGIN_NUMERATOR   = 120n;
const MARGIN_DENOMINATOR = 100n;
const ONE_ADA            = 1_000_000n;

/** Số byte của UTxO két, suy từ chuỗi CBOR hex của datum inline. */
export function vaultUtxoSizeBytes(datumCborHex: string): bigint {
  if (datumCborHex.length % 2 !== 0) {
    // Hình dạng lạ thì NÉM, đừng đoán: một hex lẻ ký tự nghĩa là chuỗi đã hỏng
    // ở đâu đó phía trên, và đoán ở đây là chở cái hỏng đi tiếp.
    throw new Error(
      `datum CBOR hex lẻ ký tự (${datumCborHex.length}) — chuỗi đã hỏng, không phải min-ADA sai.`,
    );
  }
  return BigInt(datumCborHex.length / 2) + VAULT_NON_DATUM_BYTES;
}

/** min-ADA thô (lovelace) cho UTxO két mang `datumCborHex`. */
export function minAdaForVault(
  datumCborHex: string,
  coinsPerUtxoByte: bigint = COINS_PER_UTXO_BYTE_DEFAULT,
): bigint {
  return (UTXO_OVERHEAD_BYTES + vaultUtxoSizeBytes(datumCborHex)) * coinsPerUtxoByte;
}

/** min-ADA cộng biên 20%, làm tròn LÊN ADA chẵn. Đây là giá trị `createVault` dùng. */
export function minAdaForVaultWithMargin(
  datumCborHex: string,
  coinsPerUtxoByte: bigint = COINS_PER_UTXO_BYTE_DEFAULT,
): bigint {
  const raw = (minAdaForVault(datumCborHex, coinsPerUtxoByte) * MARGIN_NUMERATOR) / MARGIN_DENOMINATOR;
  return ((raw + ONE_ADA - 1n) / ONE_ADA) * ONE_ADA;
}
