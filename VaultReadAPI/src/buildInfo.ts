// VaultReadAPI/src/buildInfo.ts — BẢN CHÉP có nhãn của `VaultTxAPI/src/buildInfo.ts` (nguồn), chép
// 2026-09-30. Hai gói không có workspace chung ở gốc (BOUNDARIES §4); sửa một bên thì sửa cả hai.
//
// Commit của mã đang chạy, ĐO lúc khởi động.
//
// Bên gọi cần biết máy chủ chạy bản nào để tự đối chiếu route và mã lỗi, khỏi phải
// hỏi người vận hành. Commit lấy bằng cách HỎI git ở chính cây mã đang chạy, không
// nhận qua biến môi trường: một biến do người triển khai tự khai thì sống lâu hơn lần
// `git pull` kế tiếp mà không có gì báo, còn `git rev-parse` thì không nói dối về cây
// nó đứng trong.
//
// BA trạng thái, và trạng thái thứ ba phải tự khai:
//   · đo được, cây sạch          → `commit` + `dirty: false`
//   · đo được, cây có sửa tại chỗ → `commit` + `dirty: true` (commit KHÔNG đủ mô tả mã chạy)
//   · không đo được               → `commit: null`, `source: "unavailable"` kèm lý do.
//     Không đoán, không đệm chuỗi rỗng.

import { execFileSync } from "node:child_process";

export interface BuildInfo {
  commit: string | null;
  dirty: boolean | null;
  source: "git" | "unavailable";
  /** Chỉ có khi `source === "unavailable"`: vì sao không đo được. */
  reason?: string;
}

/** Chạy một lệnh git trong `cwd`, trả stdout. Tiêm được để bộ kiểm không cần kho thật. */
export type GitRunner = (args: string[], cwd: string) => string;

const defaultRunner: GitRunner = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });

export function readBuildInfo(cwd: string, run: GitRunner = defaultRunner): BuildInfo {
  let commit: string;
  try {
    commit = run(["rev-parse", "HEAD"], cwd).trim();
  } catch (e) {
    return { commit: null, dirty: null, source: "unavailable", reason: firstLine(e) };
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    return { commit: null, dirty: null, source: "unavailable", reason: "git rev-parse trả hình dạng lạ" };
  }
  let dirty: boolean | null;
  try {
    // Chỉ tệp ĐÃ track: tệp sinh ra (plutus.json, dist/) bị gitignore nên không làm bẩn.
    dirty = run(["status", "--porcelain", "--untracked-files=no"], cwd).trim() !== "";
  } catch {
    dirty = null;
  }
  return { commit, dirty, source: "git" };
}

function firstLine(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0]!.slice(0, 200);
}
