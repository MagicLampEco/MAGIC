// scripts/check_min_ada.ts — BẢN ĐO min-ADA của ref-script. KHÔNG phải một cổng.
//
// Chạy: npx tsx check_min_ada.ts
// Mã thoát:  0 = đo được  ·  2 = CHƯA ĐO ĐƯỢC
//
// ⚠ Tên tệp bắt đầu bằng `check_` theo khuôn của kho, nhưng nó KHÔNG đỏ được ở
// bất kỳ trạng thái nào của mã — nó chỉ đỏ khi không đọc nổi artifact. Đừng đọc
// màu xanh của nó như một lời khai rằng các bước deploy đủ ADA, và đừng nối nó
// vào runner: một dòng luôn xanh in mỗi lượt chạy dạy người đọc lướt qua.
//
// ══ VÌ SAO KHÔNG DỰNG CỔNG — cố ý, không phải bỏ dở ═══════════════════════════
// Đã thử một cổng bắt chuỗi `lovelace: <số>` trong `deploy/*.ts` và ĐO ĐƯỢC rằng
// nó sai cả hai chiều cùng lúc:
//   RỘNG  → đỏ ở 7 tệp, gồm cả 2 ADA HỢP LỆ của UTxO mang datum ở bước 02·03·04·07
//   HẸP   → thu về đúng lời gọi `publishRefScript` thì trượt bước 06, nơi lời gọi
//           đi qua một hàm bọc với tham số theo VỊ TRÍ, không có chữ `lovelace:`
// Sai được cả hai chiều nghĩa là đang đo SAI ĐẠI LƯỢNG. Đại lượng đúng — "con số
// này có phải một hằng đoán không" — không nằm trong chuỗi ký tự của tệp.
//
// Chỗ chặn đúng nằm ở TẦNG KHÁC và đã đặt: bước 05 và 06 nay TÍNH lovelace từ
// `minAda.ts`, nên không còn con số để đoán sai. Một cổng chuỗi ở đây chỉ canh
// việc ai đó gỡ phép tính ra — và `git diff` đã canh việc đó tốt hơn.
//
// PHẠM VI — in ra ở cuối mỗi lượt chạy, và đọc nó trước khi tin con số.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { minAdaForRefScript, COINS_PER_UTXO_BYTE_DEFAULT } from "./minAda.js";

class NotMeasurable extends Error {}

/** Danh sách ĐÓNG: mọi validator được công bố làm ref-script trong kho này. */
const REF_SCRIPTS: Array<{ module: string; title: string; nhan: string }> = [
  { module: "ScheduleGen",  title: "vault.vault.spend",    nhan: "ScheduleGen vault" },
  { module: "ScheduleGen",  title: "vault.shard.spend",    nhan: "ScheduleGen shard" },
  { module: "InstantGen",   title: "vault.vault.spend",    nhan: "InstantGen vault" },
  { module: "ConsumeMAGIC", title: "consume.consume.spend", nhan: "ConsumeMAGIC consume" },
];

function compiledSize(module: string, title: string): number {
  const p = fileURLToPath(new URL(`../${module}/onchain/plutus.json`, import.meta.url));
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    throw new NotMeasurable(
      `${module}: không đọc được plutus.json (${(e as NodeJS.ErrnoException).code}). ` +
      `Chạy \`aiken build\` trong ${module}/onchain.`,
    );
  }
  let bp: { validators?: Array<{ title: string; compiledCode?: string }> };
  try {
    bp = JSON.parse(raw);
  } catch (e) {
    throw new NotMeasurable(`${module}: plutus.json không phải JSON hợp lệ — ${(e as Error).message}`);
  }
  const v = bp.validators?.find((x) => x.title === title);
  if (!v?.compiledCode) {
    throw new NotMeasurable(`${module} ▸ ${title}: không có trong blueprint, hoặc thiếu compiledCode.`);
  }
  return v.compiledCode.length / 2;
}

console.log(
  `Đối chiếu min-ADA của ${REF_SCRIPTS.length} ref-script · ` +
  `coinsPerUtxoByte = ${COINS_PER_UTXO_BYTE_DEFAULT} (hằng trong kho, KHÔNG hỏi node)`,
);

let thieu = 0;
let muMo = 0;

for (const r of REF_SCRIPTS) {
  let bytes: number;
  try {
    bytes = compiledSize(r.module, r.title);
  } catch (e) {
    if (e instanceof NotMeasurable) {
      console.log(`  ? ${r.nhan}: CHƯA ĐO ĐƯỢC — ${e.message}`);
      muMo++;
      continue;
    }
    throw e;
  }
  // `compiledCode` là bản CHƯA apply-param. Apply-param chỉ làm script DÀI thêm,
  // nên con số này là CẬN DƯỚI của min-ADA thật — một bước deploy đủ ADA ở đây
  // vẫn có thể thiếu trên thực tế, nhưng một bước THIẾU ở đây thì chắc chắn thiếu.
  const minAda = minAdaForRefScript("00".repeat(bytes));
  console.log(
    `  · ${r.nhan}: ${bytes} byte → min-ADA ≥ ${(Number(minAda) / 1e6).toFixed(2)} ADA`,
  );
}

console.log("");
console.log("KHÔNG đo: tham số `coinsPerUtxoByte` thật của mạng (hằng ở đây là BẢN SAO,");
console.log("  đổi được qua một lượt cập nhật tham số mà không gì báo); kích thước script");
console.log("  SAU apply-param (nên mọi số trên là CẬN DƯỚI); và min-ADA của UTxO mang");
console.log("  datum + token — két, beacon, shard — vẫn gõ cứng 2 ADA ở bước 02·03·04·07,");
console.log("  loại UTxO tệp này không chạm tới.");

if (muMo > 0) {
  console.log(`\n✗ CHƯA ĐO ĐƯỢC ${muMo}/${REF_SCRIPTS.length} — đây KHÔNG phải "đủ".`);
  process.exit(2);
}
console.log(`\n✓ Đo được ${REF_SCRIPTS.length}/${REF_SCRIPTS.length} ref-script.`);
process.exit(thieu);
