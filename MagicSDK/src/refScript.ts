// MagicSDK/src/refScript.ts — đường CIP-33 cho các hàm dựng giao dịch của SDK.
//
// ══ VÌ SAO GÓI NÀY TỒN TẠI ════════════════════════════════════════════════════
// Nhét trọn script vào thân giao dịch (`.attach.SpendingValidator`) chạy tốt cho
// tới lúc vault tích đủ dữ liệu, rồi nó ngừng chạy — và nó không ngừng ở chỗ
// người ta nhìn. Số đo 2026-09-15, bằng `applyParamsToScript` thật:
//
//   vault ScheduleGen, đã apply param   12 240 B
//   trần kích thước giao dịch Cardano   16 384 B
//   ⟹ còn ~4 100 B cho TOÀN BỘ datum + output + witness
//
// Một `VaultDatum` đã tích `loyalty_holdings` và `magic_batches` ăn hết phần đó.
// Lúc ấy `withdrawLamp` không dựng nổi giao dịch, và `WithdrawLamp` là nhánh
// DUY NHẤT đưa LAMP rời vault (I-ACT-7). Tức người dùng mất đường RA, trong khi
// mọi bài kiểm vẫn xanh: bộ kiểm dựng vault từ fixture nhỏ, nên nó không bao giờ
// đứng gần trần.
//
// Mọi chặn khác của kho này đều fail-closed — chúng chặn người ta VÀO. Cái này
// chặn người ta RA, và đó là chiều hỏng đắt hơn hẳn.
//
// ══ VÌ SAO PHẢI KIỂM HASH, KHÔNG CHỈ KIỂM "CÓ scriptRef" ══════════════════════
// `readFrom` một UTxO mang script SAI thì `complete()` vẫn dựng ra một giao dịch,
// và nó chết trên chuỗi SAU KHI người dùng đã ký. Đó đúng là ca mà một nhánh
// phòng thủ im lặng sinh ra: người dùng thấy màn ký bình thường, ký, rồi nhận về
// một lỗi không trỏ về đâu. Nên ở đây ném, và ném kèm cả hai hash để người đọc
// đối chiếu được.

import {
  validatorToScriptHash,
  type Script, type UTxO, type Validator,
} from "@lucid-evolution/lucid";

/**
 * UTxO CIP-33 mang script tham chiếu, kèm phép kiểm nó mang ĐÚNG script cần.
 *
 * Trả về chính `refUtxo` để chỗ gọi dùng thẳng trong `readFrom`.
 *
 * @throws khi UTxO không mang `scriptRef`, hoặc mang một script khác.
 */
export function assertRefScriptMatches(
  refUtxo: UTxO,
  script: Validator,
  what: string,
): UTxO {
  const ref: Script | null | undefined = refUtxo.scriptRef;
  const at = `${refUtxo.txHash}#${refUtxo.outputIndex}`;

  if (ref === undefined || ref === null) {
    throw new Error(
      `REFSCRIPT-001: UTxO ${at} được đưa vào làm script tham chiếu của ${what} ` +
      `nhưng nó KHÔNG mang scriptRef. Đọc từ nó sẽ dựng ra một giao dịch thiếu ` +
      `script, và nó chết trên chuỗi sau khi người dùng đã ký.`,
    );
  }

  const want = validatorToScriptHash(script);
  const got  = validatorToScriptHash(ref as Validator);
  if (want !== got) {
    throw new Error(
      `REFSCRIPT-002: UTxO ${at} mang một script KHÁC với ${what}.\n` +
      `  cần:  ${want}\n` +
      `  thấy: ${got}\n` +
      `Hai hash khác nhau nghĩa là bản deploy đã trôi khỏi bytes mà SDK đang cầm ` +
      `— apply-param là tham số lúc BIÊN DỊCH, nên đổi một giá trị là đổi hash, ` +
      `đổi địa chỉ, và phải công bố một script tham chiếu CIP-33 mới.`,
    );
  }

  return refUtxo;
}
