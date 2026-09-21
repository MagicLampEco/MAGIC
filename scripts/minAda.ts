// scripts/minAda.ts — tính min-ADA của một UTxO từ thứ THẬT SỰ nằm trong nó.
//
// ══ VÌ SAO TỆP NÀY TỒN TẠI ════════════════════════════════════════════════════
// min-ADA là một hàm của SỐ BYTE mà UTxO chiếm trên sổ cái. Một con số gõ cứng vì
// thế không phải "giá trị mặc định" — nó là một lời đoán về kích thước một thứ
// chưa dựng xong, và nó già đi mỗi lần validator dài thêm một dòng.
//
// Đo 2026-09-21 trên chính `plutus.json` của kho (script CHƯA apply-param, tức
// CẬN DƯỚI — apply-param chỉ làm script dài thêm):
//
//   ScheduleGen ▸ vault.spend    12.104 byte  → min-ADA ≈ 53,11 ADA   (gõ cứng: 35)
//   ScheduleGen ▸ shard.spend     5.294 byte  → min-ADA ≈ 23,76 ADA   (gõ cứng: 20)
//   InstantGen  ▸ vault.spend    11.203 byte  → min-ADA ≈ 49,23 ADA   (gõ cứng: 35)
//   ConsumeMAGIC ▸ consume.spend  5.440 byte  → min-ADA ≈ 24,39 ADA
//
// Cả BA giá trị gõ cứng đều THẤP HƠN min-ADA, nên các bước công bố ref-script
// KHÔNG chạy nổi: sổ cái từ chối output, và nó từ chối ở lúc gửi chứ không lúc
// dựng — tức sau khi người chạy đã ký.
//
// ══ PHẠM VI — đọc trước khi tin con số ════════════════════════════════════════
// Hàm ở đây tính THEO CÔNG THỨC, không hỏi node. Nó đúng khi `coinsPerUtxoByte`
// của mạng đúng bằng hằng dưới đây. Tham số ấy do giao thức đặt và đổi được qua
// một lượt cập nhật tham số — hằng này vì thế là một BẢN SAO, và bản sao thì chết
// im lặng. Nên `minAdaForRefScript` nhận `coinsPerUtxoByte` làm tham số tuỳ chọn:
// chỗ nào tra được giá trị thật từ node thì TRUYỀN VÀO, đừng dựa vào hằng.
//
// Hàm này KHÔNG thay `complete()` của Lucid, vốn tự tính min-ADA từ giao dịch
// thật. Việc của nó là trả lời câu Lucid không trả lời được trước khi dựng tx:
// "ví cần sẵn bao nhiêu ADA thì bước này mới chạy được".
// ══════════════════════════════════════════════════════════════════════════════

/** Tham số giao thức Babbage trở đi. Xem khối PHẠM VI: đây là bản sao, không phải nguồn. */
export const COINS_PER_UTXO_BYTE_DEFAULT = 4310n;

/** Hằng trong công thức min-ADA của sổ cái (phần chi phí cố định mỗi UTxO). */
const UTXO_OVERHEAD_BYTES = 160n;

/**
 * Số byte của phần KHÔNG PHẢI script trong một UTxO ref-script chỉ-lovelace:
 * địa chỉ script testnet (29) + value chỉ-lovelace (9) + vỏ CBOR của scriptRef (5).
 * Cộng 16 byte dư cho chênh lệch mã hoá — biên này CÓ CHỦ Ý và nhỏ: nó bù sai số
 * mã hoá, KHÔNG bù cho một lượt validator dài thêm.
 */
const REF_SCRIPT_NON_SCRIPT_BYTES = 29n + 9n + 5n + 16n;

/**
 * min-ADA cho một UTxO mang script tham chiếu (CIP-33), tính từ chính chuỗi CBOR
 * của script đã apply-param.
 *
 * @param scriptCborHex  `compiledCode` ĐÃ apply-param — dùng bản chưa apply là tự
 *                       cho mình một con số thấp hơn thật.
 */
export function minAdaForRefScript(
  scriptCborHex: string,
  coinsPerUtxoByte: bigint = COINS_PER_UTXO_BYTE_DEFAULT,
): bigint {
  if (!/^[0-9a-fA-F]*$/.test(scriptCborHex) || scriptCborHex.length % 2 !== 0) {
    throw new Error(
      `minAdaForRefScript: chuỗi script không phải hex chẵn ký tự (dài ${scriptCborHex.length}). ` +
      `Đưa nhầm một đối tượng Script thay vì trường CBOR của nó?`,
    );
  }
  const scriptBytes = BigInt(scriptCborHex.length / 2);
  if (scriptBytes === 0n) {
    throw new Error("minAdaForRefScript: script rỗng — không có gì để đo.");
  }
  return (UTXO_OVERHEAD_BYTES + REF_SCRIPT_NON_SCRIPT_BYTES + scriptBytes) * coinsPerUtxoByte;
}

/**
 * min-ADA cộng một biên an toàn, làm tròn LÊN tới ADA chẵn.
 *
 * Vì sao có biên và vì sao nó nhỏ: đưa đúng min-ADA là đứng ngay mép: một khác
 * biệt vài byte ở khâu mã hoá là tx bị từ chối. Nhưng một biên LỚN thì tệ theo
 * chiều khác — nó giấu đúng cái nó phải làm lộ ra, là việc script đã dài tới mức
 * cần xem lại. 20% là chỗ dừng: đủ nuốt sai số mã hoá, không đủ nuốt một lượt
 * validator phình thêm nghìn byte.
 */
export function minAdaForRefScriptWithMargin(
  scriptCborHex: string,
  coinsPerUtxoByte: bigint = COINS_PER_UTXO_BYTE_DEFAULT,
): bigint {
  const raw = (minAdaForRefScript(scriptCborHex, coinsPerUtxoByte) * 120n) / 100n;
  const oneAda = 1_000_000n;
  return ((raw + oneAda - 1n) / oneAda) * oneAda;
}
