// VaultTxAPI/src/units.ts — số tiền đi ra ngoài dưới dạng CHUỖI, không phải số JSON.
//
// ── VÌ SAO KHÔNG DÙNG `number` ──────────────────────────────────────────────────
// Trần LAMP là 36×10^15 oildrop, còn 2^53 ≈ 9,007×10^15. Nghĩa là một trường oildrop
// CÓ THẬT vượt được ngưỡng an toàn của số dấu-phẩy-động, và lúc vượt thì nó không
// lỗi — nó LÀM TRÒN. JSON không có kiểu số nguyên lớn, nên cách duy nhất nói đúng
// một số nguyên qua JSON là gửi chữ số dưới dạng chuỗi.
//
// Đơn vị nằm ở TÊN TRƯỜNG (`_oildrop`, `_nanogic`, `_lovelace`, `_lamp`, `_magic`),
// không nằm ở giá trị. Hai trường cho một đại lượng là cố ý: máy đọc trường thô
// (`_oildrop`), người đọc trường đã chia (`_lamp`).

// Ba hằng dưới đây TRỎ về ProtocolUtils, không chép giá trị.
//
// 🪦 Bản trước gõ lại `1_000_000n` / `1_000_000_000n` tại chỗ. Chúng trùng giá trị hôm
// nay, nên không bài kiểm nào đỏ và không ai biết có hai bản — đúng ca `Forall §Một
// nguồn, nhiều con trỏ`: phép thử một dòng là *"số này khi nguồn của nó đổi, ai báo cho
// chỗ này biết?"*, và câu trả lời ở bản trước là "không ai".
export { NANOGIC_PER_MAGIC, OILDROP_PER_LAMP, Q } from "@magiclamp/protocol-utils";

export const OILDROP_DECIMALS = 6;
export const NANOGIC_DECIMALS = 9;
export const LOVELACE_DECIMALS = 6;

/** BigInt → chuỗi thập phân thô. Không làm tròn, không đổi đơn vị. */
export function raw(v: bigint): string {
  return v.toString(10);
}

/**
 * BigInt (đơn vị nhỏ nhất) → chuỗi thập phân có dấu phẩy tĩnh, ví dụ
 * `decimal(1_001_000_000n, 6)` = `"1001.000000"`.
 *
 * Toàn bộ phép tính chạy trên BigInt. Không có `Number` ở đây, và đó là điểm của
 * hàm: chuyển đơn vị bằng dấu phẩy động là chỗ mất chữ số cuối mà không ai thấy.
 */
export function decimal(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  const fracStr = frac.toString(10).padStart(decimals, "0");
  return `${neg ? "-" : ""}${whole.toString(10)}${decimals > 0 ? `.${fracStr}` : ""}`;
}

export const oildropToLamp = (v: bigint): string => decimal(v, OILDROP_DECIMALS);
export const nanogicToMagic = (v: bigint): string => decimal(v, NANOGIC_DECIMALS);
export const lovelaceToAda = (v: bigint): string => decimal(v, LOVELACE_DECIMALS);
