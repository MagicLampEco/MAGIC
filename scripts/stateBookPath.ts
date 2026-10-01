// scripts/stateBookPath.ts — đường tới sổ trạng thái của một mạng.
//
// Mặc định: `scripts/state.<NET>.sh`. `STATE_BOOK_PATH` (đường TUYỆT ĐỐI) đổi sổ cho đúng
// một tiến trình, để dựng một cụm thứ hai cạnh cụm đang phục vụ mà không chạm sổ của cụm đó.
//
// Vì sao cần: `scripts/state.<NET>.sh` có thể là một symlink tới sổ của cụm đang chạy. Bước
// nào tự ghi sổ (`deploy/11_deploy_gen_beacons.ts`) thì `appendFileSync` đi XUYÊN symlink, nên
// dựng cụm mới mà không đổi đường sổ là ghi khoá cụm mới vào sổ cụm cũ — không gì kêu.
//
// Ba cổng, cả ba NÉM chứ không lùi về mặc định, vì lùi về mặc định đúng là ca hỏng ở trên:
//   · biến có mặt nhưng rỗng        ⟹ ném (một `STATE_BOOK_PATH=` gõ dở không được thành sổ cũ);
//   · đường tương đối               ⟹ ném (nghĩa của nó đổi theo thư mục đang đứng);
//   · tên tệp khác `state.<NET>.sh` ⟹ ném (chặn chạy Preprod trên sổ của mạng khác).

import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

export function stateBookPath(network: string, env: Record<string, string | undefined> = process.env): string {
  const expectedName = `state.${network}.sh`;
  const v = env.STATE_BOOK_PATH;
  if (v === undefined) return join(SCRIPTS_DIR, expectedName);
  if (v === "") throw new Error("STATE_BOOK_PATH có mặt nhưng rỗng — bỏ hẳn biến để dùng sổ mặc định, hoặc đặt đường tuyệt đối.");
  if (!isAbsolute(v)) throw new Error(`STATE_BOOK_PATH phải là đường tuyệt đối, nhận "${v}".`);
  if (basename(v) !== expectedName) {
    throw new Error(`STATE_BOOK_PATH phải trỏ tới một tệp tên "${expectedName}" (mạng ${network}), nhận "${basename(v)}".`);
  }
  return v;
}
