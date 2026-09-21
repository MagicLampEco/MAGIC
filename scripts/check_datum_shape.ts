// scripts/check_datum_shape.ts — artifact có còn khớp NGUỒN không?
//
// ── VÌ SAO CẦN CỔNG NÀY ───────────────────────────────────────────────────────
// `onchain/plutus.json` là ARTIFACT: nó bị `.gitignore` chặn, nên nó không đi
// theo nhánh, không đi theo commit, và không có gì buộc nó được dựng lại khi
// `types.ak` đổi. Mọi script deploy thì đọc CHÍNH nó. Ghép hai điều ấy lại:
// đổi nhánh là đủ để artifact trên đĩa tả một lược đồ mà không nhánh nào trong
// kho đang khai — và nó vẫn nạp được, vẫn deploy được, vẫn ra một địa chỉ.
//
// Đo 2026-09-21, đúng ca ấy: cả hai `plutus.json` trên đĩa khai `VaultDatum`
// **19 trường**, dựng từ một nhánh đã bị bác và chưa bao giờ vào `main`. Nguồn
// lúc đó khai 18 (`InstantGen`) và 17 (`ScheduleGen`). Không lệnh nào trong kho
// kêu, vì mọi phép kiểm hiện có đọc NGUỒN, và cái sai nằm ở BẢN DỰNG.
//
// Hỏng ở đây không dừng lại ở một lần deploy lỗi: giải mã Plutus Data của Aiken
// nghiêm ngặt về SỐ TRƯỜNG theo cả hai chiều, nên một vault dựng theo artifact
// 19 trường là một vault mà validator 18 trường không đọc nổi — LAMP vào được,
// không ra được, và không nhánh nào tiêu lại được nó.
//
// ── CỔNG NÀY TRẢ BA TRẠNG THÁI, KHÔNG PHẢI HAI ────────────────────────────────
//   0 — KHỚP
//   1 — LỆCH  (artifact cũ ⟹ chạy `aiken build` trong module đó)
//   2 — CHƯA ĐO ĐƯỢC  (thiếu artifact, hoặc không phân tích nổi một trong hai
//       bên). Trạng thái này kêu TO HƠN trạng thái LỆCH, vì nó là trạng thái
//       mù: một phép đo trả giá trị hợp lệ đúng lúc nó không đo được gì thì màu
//       xanh của nó không nói "ổn", nó nói "tôi không biết" bằng giọng của "ổn".
//
// ── PHẠM VI, KHAI RA VÌ MỘT CON SỐ KHÔNG MANG PHẠM VI ĐỌC RỘNG RA ĐƯỢC ────────
// Cổng đo ĐÚNG MỘT đại lượng: số trường của `VaultDatum`. Nó KHÔNG đo thứ tự
// trường, KHÔNG đo kiểu từng trường, KHÔNG đo các type khác trong cùng artifact,
// và KHÔNG đo lược đồ TypeScript. Một lượt đổi CHỖ hai trường cùng kiểu đi lọt
// cổng này trong im lặng — đó là lỗ đã biết, không phải lỗ chưa thấy.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Module nào có một vault mang `VaultDatum`. Danh sách ĐÓNG — thêm module thì thêm ở đây. */
const MODULES = ["InstantGen", "ScheduleGen"] as const;

class NotMeasurable extends Error {}

/** Đếm trường của `pub type VaultDatum { … }` trong nguồn Aiken. */
function countFieldsInSource(akPath: string): number {
  if (!existsSync(akPath)) throw new NotMeasurable(`không có tệp nguồn: ${akPath}`);
  const src = readFileSync(akPath, "utf8");
  const start = src.indexOf("pub type VaultDatum {");
  if (start < 0) throw new NotMeasurable(`không thấy \`pub type VaultDatum {\` trong ${akPath}`);

  let depth = 0;
  let count = 0;
  let i = start;
  for (const rawLine of src.slice(start).split("\n")) {
    i += rawLine.length + 1;
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    const opened = (line.match(/\{/g) ?? []).length;
    const closed = (line.match(/\}/g) ?? []).length;
    // Một trường là một dòng `ten : Kieu,` nằm ở ĐÚNG mức 1 của thân type.
    if (depth === 1 && /^[a-z_][a-z0-9_]*\s*:/i.test(line)) count++;
    depth += opened - closed;
    if (depth === 0 && opened + closed > 0) break;
  }
  if (count === 0) throw new NotMeasurable(`phân tích ra 0 trường trong ${akPath} — mẫu đã trôi`);
  return count;
}

/** Đếm trường của `VaultDatum` trong artifact `plutus.json`. */
function countFieldsInArtifact(jsonPath: string): number {
  if (!existsSync(jsonPath)) {
    throw new NotMeasurable(
      `không có artifact: ${jsonPath}\n` +
      `    Artifact bị .gitignore chặn nên checkout sạch KHÔNG có nó. Dựng bằng ` +
      `\`aiken build\` trong thư mục onchain của module.`,
    );
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (e) {
    throw new NotMeasurable(`artifact không phải JSON đọc được: ${jsonPath} — ${(e as Error).message}`);
  }
  const defs = (doc as { definitions?: Record<string, unknown> }).definitions;
  if (!defs) throw new NotMeasurable(`artifact không có khối \`definitions\`: ${jsonPath}`);

  const keys = Object.keys(defs).filter((k) => k.endsWith("/VaultDatum"));
  if (keys.length !== 1) {
    throw new NotMeasurable(
      `mong đúng 1 định nghĩa \`VaultDatum\` trong ${jsonPath}, thấy ${keys.length}`,
    );
  }
  const variants = (defs[keys[0]] as { anyOf?: { fields?: unknown[] }[] }).anyOf;
  if (!variants || variants.length !== 1) {
    throw new NotMeasurable(
      `\`VaultDatum\` trong ${jsonPath} không phải một constructor đơn — không so được số trường`,
    );
  }
  return (variants[0].fields ?? []).length;
}

let mismatched = 0;
let unmeasurable = 0;

console.log("Đối chiếu SỐ TRƯỜNG `VaultDatum`: nguồn Aiken ↔ artifact plutus.json");
console.log(`Phạm vi: ${MODULES.length} module (${MODULES.join(", ")}) — danh sách ĐÓNG.\n`);

for (const mod of MODULES) {
  const akPath   = `${repoRoot}/${mod}/onchain/lib/magiclamp/protocol/types.ak`;
  const jsonPath = `${repoRoot}/${mod}/onchain/plutus.json`;
  try {
    const src = countFieldsInSource(akPath);
    const art = countFieldsInArtifact(jsonPath);
    if (src === art) {
      console.log(`  ✓ ${mod.padEnd(12)} nguồn ${src} = artifact ${art}`);
    } else {
      mismatched++;
      console.error(`  ✗ ${mod.padEnd(12)} nguồn ${src} ≠ artifact ${art}`);
      console.error(`      nguồn   : ${akPath}`);
      console.error(`      artifact: ${jsonPath}`);
      console.error(`      Artifact đã trôi khỏi nguồn. Dựng lại: \`aiken build\` trong ${mod}/onchain.`);
    }
  } catch (e) {
    if (e instanceof NotMeasurable) {
      unmeasurable++;
      console.error(`  ? ${mod.padEnd(12)} CHƯA ĐO ĐƯỢC — ${e.message}`);
    } else {
      // Ngoại lệ CHƯA PHÂN LOẠI cũng là CHƯA ĐO ĐƯỢC, không phải LỆCH. Bản
      // trước ném tiếp ⟹ node thoát 1 ⟹ runner dán nhãn "artifact đã trôi" cho
      // một thứ chẳng liên quan gì tới artifact. Chiều hỏng vẫn đúng (vẫn
      // chặn), nhưng nhãn sai đẩy người vận hành đi chạy `aiken build` rồi
      // gặp lại đúng câu đó.
      unmeasurable++;
      console.error(
        `  ? ${mod.padEnd(12)} CHƯA ĐO ĐƯỢC — ngoại lệ chưa phân loại: ` +
        `${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      );
    }
  }
}

console.log("\nKHÔNG đo trong lượt này: thứ tự trường · kiểu từng trường · mọi type khác");
console.log("trong artifact · lược đồ TypeScript. Đổi CHỖ hai trường cùng kiểu đi lọt cổng này.");

if (unmeasurable > 0) {
  console.error(`\nCHƯA ĐO ĐƯỢC ở ${unmeasurable}/${MODULES.length} module — đừng đọc thành "khớp".`);
  process.exit(2);
}
if (mismatched > 0) {
  console.error(`\nLỆCH ở ${mismatched}/${MODULES.length} module.`);
  process.exit(1);
}
console.log(`\nKhớp ở ${MODULES.length}/${MODULES.length} module.`);
