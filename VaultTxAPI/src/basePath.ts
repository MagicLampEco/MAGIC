// VaultTxAPI/src/basePath.ts — tiền tố đường khi dịch vụ đứng sau một proxy định tuyến theo đường.
//
// Đường hầm Cloudflare chọn dịch vụ theo mẫu đường (`api.magiclamp.eco` ▸ `^/vaulttx/preprod`)
// nhưng chuyển NGUYÊN đường xuống, không cắt tiền tố. Không có tệp này thì mọi lượt gọi qua
// proxy tới đây dưới dạng `/vaulttx/preprod/tx/consume` và rơi vào 404.
//
// Mạng nằm TRONG tiền tố (`/preprod`, `/mainnet`) chứ không nằm ở tên dịch vụ: một tiến trình
// phục vụ đúng một mạng, nên một URL chỉ được trỏ tới một mạng — đổi nghĩa một URL đã phát ra
// là để bản app cũ gọi nhầm mạng mà không có gì báo.
//
// Bản song sinh: `VaultReadAPI/src/basePath.ts` (chép 2026-09-30 từ tệp này). Hai gói không có
// workspace chung ở gốc (BOUNDARIES §4), nên chép có nhãn; sửa một bên thì sửa cả hai.

/** Mỗi đoạn: chữ thường, số, `.`, `_`, `-`; bắt đầu bằng chữ hoặc số. Không `/` ở cuối. */
const BASE_PATH_RE = /^(\/[a-z0-9][a-z0-9._-]*)+$/;

/** Đọc tiền tố từ biến môi trường. Vắng/rỗng ⟹ `""` (không tiền tố). Sai dạng ⟹ NÉM: một
 *  tiền tố sai mà vẫn khởi động là một dịch vụ xanh trả 404 cho mọi lượt gọi qua proxy. */
export function parseBasePath(raw: string | undefined, varName: string): string {
  if (raw === undefined || raw === "") return "";
  if (!BASE_PATH_RE.test(raw)) {
    throw new Error(
      `[config] ${varName}="${raw}" không hợp lệ. Dạng đúng: "/vaulttx/preprod" — bắt đầu bằng "/", ` +
      `mỗi đoạn là chữ thường/số/"."/"_"/"-", không có "/" ở cuối.`,
    );
  }
  return raw;
}

/**
 * Bỏ tiền tố khỏi `pathname`. Đường KHÔNG mang tiền tố thì giữ nguyên — đó là lượt gọi thẳng
 * vào cổng loopback (bộ giám sát trên máy chủ gọi `/health`), không phải lượt qua proxy.
 * `/vaulttx/preprodX/…` không khớp ranh giới đoạn nên cũng giữ nguyên, và rơi vào 404.
 */
export function stripBasePath(pathname: string, basePath: string): string {
  if (basePath === "") return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return pathname;
}
