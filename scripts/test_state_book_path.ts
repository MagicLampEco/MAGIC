// scripts/test_state_book_path.ts — bộ ca cho `stateBookPath.ts`. Không gọi mạng, không đọc sổ.
// Chạy từ scripts/:  npx tsx test_state_book_path.ts
// Dòng cuối: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===` (mã thoát 1).
//
// Mỗi cổng có CẶP ca: một ca qua, một ca chỉ khác đúng chỗ đó phải ném. Ca "vắng biến ⟹ mặc
// định" đứng một mình xanh được cả ở bản bỏ qua hẳn biến, nên ca "có biến ⟹ trả đúng biến"
// là ca phân biệt được hai bản.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateBookPath } from "./stateBookPath.js";

let sai = 0;
function ca(ten: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${ten}`); }
  catch (e) { sai++; console.log(`  ✗ ${ten}\n      ${(e as Error).message.split("\n")[0]}`); }
}
function bang<T>(thuc: T, cho: T, nhan: string) {
  if (thuc !== cho) throw new Error(`${nhan}: nhận ${String(thuc)}, chờ ${String(cho)}`);
}
function phaiNem(fn: () => void, chua: string) {
  try { fn(); } catch (e) {
    const m = (e as Error).message;
    if (!m.includes(chua)) throw new Error(`ném nhưng câu lỗi thiếu "${chua}": ${m.split("\n")[0]}`);
    return;
  }
  throw new Error("KHÔNG ném");
}

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const V2 = "/tmp/cluster-books/preprod-v2/state.Preprod.sh";

console.log("── stateBookPath");
ca("vắng biến ⟹ scripts/state.<NET>.sh", () =>
  bang(stateBookPath("Preprod", {}), join(SCRIPTS_DIR, "state.Preprod.sh"), "đường"));
ca("có biến tuyệt đối, đúng tên ⟹ trả đúng biến (không lùi về mặc định)", () =>
  bang(stateBookPath("Preprod", { STATE_BOOK_PATH: V2 }), V2, "đường"));
ca("biến rỗng ⟹ ném (không lùi về sổ mặc định)", () =>
  phaiNem(() => stateBookPath("Preprod", { STATE_BOOK_PATH: "" }), "rỗng"));
ca("đường tương đối ⟹ ném", () =>
  phaiNem(() => stateBookPath("Preprod", { STATE_BOOK_PATH: "preprod-v2/state.Preprod.sh" }), "tuyệt đối"));
ca("sổ của mạng khác ⟹ ném", () =>
  phaiNem(() => stateBookPath("Preprod", { STATE_BOOK_PATH: "/tmp/x/state.Preview.sh" }), "state.Preprod.sh"));
ca("cùng đường đó, đúng mạng ⟹ qua", () =>
  bang(stateBookPath("Preview", { STATE_BOOK_PATH: "/tmp/x/state.Preview.sh" }), "/tmp/x/state.Preview.sh", "đường"));

console.log(sai === 0 ? "\n=== ĐẠT ===" : `\n=== HỎNG: ${sai} ca sai ===`);
process.exit(sai === 0 ? 0 : 1);
