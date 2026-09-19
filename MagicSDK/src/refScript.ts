// MagicSDK/src/refScript.ts — đường CIP-33 cho các hàm dựng giao dịch của SDK.
//
// ══ VÌ SAO GÓI NÀY TỒN TẠI ════════════════════════════════════════════════════
// Nhét trọn script vào thân giao dịch (`.attach.SpendingValidator`) chạy tốt cho
// tới lúc vault tích đủ dữ liệu, rồi nó ngừng chạy — và nó không ngừng ở chỗ
// người ta nhìn. Script vault đã apply param ăn phần lớn trần 16 384 B của một
// giao dịch Cardano; phần còn lại phải chở TOÀN BỘ datum + output + witness.
//
// **Số đo KHÔNG nằm ở đây.** Kích thước từng script sống ở `DevStatus.md` ▸ bảng
// *"Kích thước script"*, và bảng đó tự kèm lệnh đo lại. Một con số chép vào chú
// thích thì không ai báo cho nó biết lúc bản deploy trôi: bản trước của khối này
// chép `12 240 B` (suy bằng `applyParamsToScript`) trong khi sổ ghi `11 619 B`
// (ĐO THẲNG từ chuỗi), rồi suy tiếp ra một câu "còn ~4 100 B" sai theo.
//
// Một `VaultDatum` đã tích `loyalty_holdings` và `magic_batches` ăn hết phần dư.
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
// một lỗi không trỏ về đâu. Nên ở đây ném, và ném kèm cả hai hash.
//
// Mã lỗi + câu lỗi KHÔNG định nghĩa ở tệp này — chúng ở `@magiclamp/protocol-utils`
// ▸ `assertRefScriptsCover`, để mọi module ra cùng một mã cho cùng một hỏng.

import {
  validatorToScriptHash,
  type Script, type UTxO, type Validator,
} from "@lucid-evolution/lucid";
import { assertRefScriptsCover } from "@magiclamp/protocol-utils";

/**
 * Băm script mà một UTxO đang mang, quy về hình dạng `RefScriptCandidate`.
 *
 * `validatorToScriptHash` chuẩn hoá bọc CBOR trước khi băm, nên một script ở hai
 * mức bọc khác nhau vẫn ra CÙNG hash — đó là tính chất mà đường chạy thật phụ
 * thuộc, vì `vaultScript` cục bộ (từ `applyParamsToScript`) và `refUtxo.scriptRef`
 * (từ provider) không nhất thiết cùng mức bọc. Bài ghim tính chất đó nằm ở
 * `tests/refScript.test.ts`.
 */
function candidateOf(refUtxo: UTxO, intendedFor?: string) {
  const ref: Script | null | undefined = refUtxo.scriptRef;
  const at = `${refUtxo.txHash}#${refUtxo.outputIndex}`;

  if (ref === undefined || ref === null) {
    return { at, gotHash: null, intendedFor };
  }

  try {
    return { at, gotHash: validatorToScriptHash(ref as Validator), intendedFor };
  } catch (e) {
    // `type` ngoài ba loại lucid biết (`PlutusV1|V2|V3|Native`) làm lucid ném một
    // lỗi của RIÊNG nó — `"No variant matched"` — không txHash, không tên chỗ gọi.
    // Fail-closed vẫn đúng, nhưng nó đánh rơi đúng phần ngữ cảnh mà gói này sinh
    // ra để giữ. Nên bọc lại, đừng để lọt nguyên văn.
    throw new Error(
      `REFSCRIPT-003: UTxO ${at}${intendedFor === undefined ? "" : ` (${intendedFor})`} ` +
      `mang một scriptRef mà lucid không giải mã được ` +
      `(type=${JSON.stringify((ref as { type?: unknown }).type)}). ` +
      `Nguyên văn lỗi của lucid: ${(e as Error).message}`,
    );
  }
}

/**
 * UTxO CIP-33 mang script tham chiếu, kèm phép kiểm nó mang ĐÚNG script cần.
 *
 * Trả về chính `refUtxo` để chỗ gọi dùng thẳng trong `readFrom`.
 *
 * @throws `REFSCRIPT-001` khi UTxO không mang `scriptRef`.
 * @throws `REFSCRIPT-002` khi nó mang một script khác.
 * @throws `REFSCRIPT-003` khi `scriptRef` có `type` lucid không giải mã được.
 */
export function assertRefScriptMatches(
  refUtxo: UTxO,
  script: Validator,
  what: string,
): UTxO {
  assertRefScriptsCover(
    [candidateOf(refUtxo, what)],
    [{ what, wantHash: validatorToScriptHash(script) }],
  );
  return refUtxo;
}

/**
 * Ca NHIỀU script / NHIỀU UTxO — ví dụ ScheduleGen, nơi một giao dịch tiêu cả vault
 * lẫn shard nên phải có chứng từ cho CẢ HAI validator.
 *
 * Phủ theo TẬP chứ không theo chỉ số: chỗ gọi nhận một danh sách UTxO từ cấu hình
 * hoặc từ keeper, không có gì bảo đảm thứ tự khớp thứ tự script. Ghép theo chỉ số
 * là dựng ra một phép kiểm xanh khi hai script bị đổi chỗ.
 */
export function assertRefScriptsMatchAll(
  refUtxos: UTxO[],
  required: { script: Validator; what: string }[],
): UTxO[] {
  assertRefScriptsCover(
    refUtxos.map((u) => candidateOf(u)),
    required.map((r) => ({ what: r.what, wantHash: validatorToScriptHash(r.script) })),
  );
  return refUtxos;
}

// ══ VÌ SAO THAM SỐ NÀY BẮT BUỘC, TRONG KHI ĐƯỜNG INLINE VẪN CHẠY ═════════════
// Bản đầu của gói này để `vaultRefScriptUtxo?: UTxO` — vắng thì lặng lẽ quay về
// `attach.SpendingValidator`. Nghe như "tương thích ngược", thật ra là fail-open:
// nó MỞ đúng lúc không tìm thấy dữ kiện.
//
// Cái giá không rơi vào người viết mã. Bên tích hợp chép ví dụ trong hướng dẫn,
// không truyền ref UTxO, và mọi thứ chạy: vault mới dựng thì datum nhỏ, bộ kiểm
// dùng fixture nhỏ, mọi lần chạy tay đều xanh. Nó vỡ ở người dùng có vault đã
// tích dữ liệu — tức người có nhiều tài sản nhất — trên nhánh DUY NHẤT đưa LAMP
// rời vault. Và `DevStatus.md` đã chốt CIP-33 là BẮT BUỘC, không phải tuỳ chọn
// (Nợ #20), nên một mặc định im lặng còn mâu thuẫn với chính sổ của kho.
//
// Nên đường inline không bị CẤM — nó bị buộc phải được CHỌN. Chỗ gọi nào thật sự
// đứng xa trần (kịch bản kiểm thử, vault vừa tạo) thì viết ra hằng dưới đây, và
// câu đó tự khai ở diff rằng ai đó đã cân nhắc. Chỗ gọi nào QUÊN thì không biên
// dịch được — hỏng lúc gõ mã, không phải lúc người dùng đã ký.
//
// 🔴 Vì sao KHÔNG dựng một cổng đo kích thước thay cho cách này: ngưỡng thật chưa
// ai đo. Cận dưới đúng đắn (`bytes script + bytes datum ≥ 16 384`) thì gần như
// không bao giờ chạm, còn một ngưỡng đoán thì sai được cả hai chiều. Một con số
// bịa ra nghe chắc hơn hẳn thứ nó biết.

/** Chọn đường inline một cách TƯỜNG MINH — xem khối ngay trên. */
export const ACCEPT_INLINE_SCRIPT_CEILING = "accept-inline-script-ceiling" as const;
export type AcceptInlineScriptCeiling = typeof ACCEPT_INLINE_SCRIPT_CEILING;

/**
 * Quy tham số `vaultRefScriptUtxo` về một trong hai đường.
 *
 * @returns UTxO đã KIỂM HASH để đưa vào `readFrom`, hoặc `null` nghĩa là chỗ gọi
 *          đã tường minh chọn nhét script inline.
 */
export function resolveRefScript(
  supplied: UTxO | AcceptInlineScriptCeiling,
  script:   Validator,
  what:     string,
): UTxO | null {
  if (supplied === ACCEPT_INLINE_SCRIPT_CEILING) return null;
  return assertRefScriptMatches(supplied, script, what);
}
