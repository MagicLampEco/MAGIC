// VaultTxAPI/tests/noSigningMaterial.test.ts — ghim BẤT BIẾN SỐ MỘT bằng một phép đo.
//
// Câu "dịch vụ này không bao giờ chạm khoá riêng" là một lời hứa cho tới khi có thứ kiểm
// được nó. Bài này quét MÃ NGUỒN của gói và đòi ba điều:
//
//   1. không mẫu nào của vật liệu ký xuất hiện — kể cả trong chú thích và chuỗi lỗi;
//   2. không có đường ký nào của lucid được gọi;
//   3. tập biến môi trường gói này đọc là một danh sách ĐÓNG, và bí mật duy nhất trong
//      đó là GIÁ TRỊ khoá Blockfrost — không có tên biến nào trỏ tới một kho khoá.
//
// ── VÌ SAO MẪU ĐƯỢC GHÉP TỪ MẢNH ───────────────────────────────────────────────
// Nếu bài kiểm viết thẳng chuỗi cấm thì chính tệp này vi phạm phép quét của nó, và lối
// thoát duy nhất là loại tệp kiểm ra khỏi vùng quét — tức là tự đục một lỗ đúng bằng
// kích thước của thứ đang canh. Ghép từ mảnh thì vùng quét phủ ĐƯỢC cả tests/.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Mọi tệp MÃ dưới `dir`, không chỉ `.ts`.
 *
 * 🪦 Bản trước lọc `p.endsWith(".ts")` và tên hàm là `tsFilesUnder`. Đo bằng đột biến:
 * một tệp `src/walletLoader.mjs` (hoặc `.js`) mang nguyên chuỗi cấm đi qua phép quét
 * mà bộ kiểm **vẫn xanh 5/5**. Trong khi README khai là "quét toàn bộ `src/**`", nên
 * phạm vi người đọc hiểu và phạm vi phép quét đo là hai thứ khác nhau — đúng ca
 * `Forall §Cổng gác`: phép đo không mang theo phạm vi của chính nó.
 */
const CODE_EXT = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"];

function codeFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...codeFilesUnder(p)); continue; }
    if (CODE_EXT.some(e => p.endsWith(e))) out.push(p);
  }
  return out;
}

/**
 * Vùng quét = MỌI thư mục mã của gói, không phải hai thư mục gọi tên sẵn.
 *
 * 🪦 Bản trước liệt kê đúng `src/` và `tests/`. Một tệp `scripts/loadWallet.ts` mang cả
 * chuỗi cấm lẫn lời gọi biến môi trường đi lọt hoàn toàn — và `scripts/` đúng là chỗ
 * khoá thật có khả năng xuất hiện nhất. Ở đây quét mọi thư mục ở gốc gói trừ danh sách
 * loại trừ; danh sách đó ĐÓNG và được in ra ở bài "vùng quét" bên dưới, để lần sau
 * thêm một thư mục mới thì nó nằm trong phạm vi mặc định chứ không nằm ngoài.
 */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

const SCANNED_DIRS = readdirSync(PKG_ROOT)
  .filter(n => !SKIP_DIRS.has(n))
  .map(n => join(PKG_ROOT, n))
  .filter(p => statSync(p).isDirectory());

const SOURCE_FILES = SCANNED_DIRS.flatMap(codeFilesUnder);

/** Ghép từ mảnh — xem khối đầu tệp. */
const j = (...parts: string[]): string => parts.join("");

const FORBIDDEN: { label: string; re: RegExp }[] = [
  { label: j("mne", "monic"), re: new RegExp(j("mne", "monic"), "i") },
  { label: j("private", "Key"), re: new RegExp(j("private", "\\s*", "key"), "i") },
  { label: j("signing", "Key"), re: new RegExp(j("signing", "\\s*", "key"), "i") },
  { label: j("seed", "Phrase"), re: new RegExp(j("seed", "\\s*", "phrase"), "i") },
  { label: j("AGENT_", "SECRETS"), re: new RegExp(j("AGENT_", "SECRETS")) },
  { label: j("generate", "Private", "Key"), re: new RegExp(j("generate", "Private", "Key"), "i") },
  { label: j("from", "Private", "Key"), re: new RegExp(j("from", "\\s*", "private", "\\s*", "key"), "i") },
  { label: j("with", "Private", "Key"), re: new RegExp(j("with", "\\s*", "private", "\\s*", "key"), "i") },
  { label: j("sign", ".withWallet"), re: new RegExp(j("sign", "\\.with", "Wallet")) },
  { label: j("partial", "Sign"), re: new RegExp(j("partial", "Sign")) },
  // 🪦 Hai mục dưới đây THIẾU ở bản trước, và chúng là đường nạp ví có khoá CHÍNH THỐNG
  // của thư viện gói này đang dùng — lối `from`+`Seed` (ghép liền) có thật trong
  // `@lucid-evolution/lucid` ▸ `dist/index.d.ts`. Không mẫu cũ nào khớp nó: mẫu
  // `seed`+`phrase` đòi hai từ nên không khớp dạng ghép liền, và cụm-từ-khôi-phục thì
  // không xuất hiện ở đâu cả.
  //
  // Chú thích này cố ý KHÔNG viết thẳng ba chuỗi đó — viết thẳng là chính tệp kiểm vi
  // phạm phép quét của nó (đã đo: 3 vết đỏ, đúng ba chuỗi vừa gõ). Đó không phải phiền
  // toái, đó là phép quét đang CẮN thật.
  //
  // Đo bằng đột biến: thêm một lời gọi lối đó vào `src/txBuilder.ts` thì bộ kiểm bản
  // trước **vẫn xanh 5/5**. Bất biến số một của gói mất lưới ở đúng nhánh nó sinh ra
  // để canh.
  { label: j("from", "Seed"), re: new RegExp(j("from", "\\s*", "seed"), "i") },
  // Chặn theo HÌNH DẠNG chứ không theo tên: mọi lối `select`+`Wallet` chấm-bất-cứ-gì,
  // trừ đúng lối chỉ-đọc `…fromAddress`. Đây là mục duy nhất còn đúng khi lucid thêm
  // một lối nạp ví mới mà chưa ai kịp bổ sung danh sách.
  { label: j("select", "Wallet.from<KHÁC Address>"), re: new RegExp(j("select", "Wallet\\s*\\.\\s*from(?!Address)")) },
];

describe("BẤT BIẾN SỐ MỘT — dịch vụ không chạm vật liệu ký", () => {
  it("quét được một tập tệp khác rỗng (nếu không, phép quét đang đo NHẦM ĐẠI LƯỢNG)", () => {
    // Một phép quét trên 0 tệp trả về "không thấy gì" và trông y hệt "sạch". Đây là bài
    // canh chính phép canh: trạng thái KHÔNG-ĐO-ĐƯỢC phải kêu to hơn trạng thái lệch.
    expect(SOURCE_FILES.length).toBeGreaterThan(10);
    expect(SOURCE_FILES.some(f => f.endsWith("txBuilder.ts"))).toBe(true);
    expect(SOURCE_FILES.some(f => f.endsWith("noSigningMaterial.test.ts"))).toBe(true);
  });

  it("không mẫu vật liệu ký nào xuất hiện trong mã nguồn của gói", () => {
    const hits: string[] = [];
    for (const file of SOURCE_FILES) {
      const text = readFileSync(file, "utf8");
      for (const f of FORBIDDEN) {
        if (f.re.test(text)) hits.push(`${file.slice(PKG_ROOT.length)} ▸ ${f.label}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("phép quét CẮN được: một chuỗi cấm nhân tạo bị bắt", () => {
    // Không có bài này thì mọi mẫu ở trên có thể đã hỏng (regex sai, cờ sai) mà vẫn xanh.
    const planted = `const x = "${j("mne", "monic")}";`;
    expect(FORBIDDEN.some(f => f.re.test(planted))).toBe(true);
  });

  it("chỉ `config.ts` chạm biến môi trường của tiến trình — không có đường nạp phụ nào", () => {
    const envAccess = new RegExp(j("process", "\\s*\\.\\s*", "env"));
    const readers = SOURCE_FILES
      .filter(f => envAccess.test(readFileSync(f, "utf8")))
      .map(f => f.slice(PKG_ROOT.length));
    expect(readers.sort()).toEqual(["src/config.ts"]);
  });

  it("tập biến môi trường là danh sách ĐÓNG, và bí mật duy nhất là GIÁ TRỊ khoá chuỗi", () => {
    const allowed = new Set([
      "VAULT_TX_API_NETWORK",
      "VAULT_TX_API_DEPLOYMENT",
      "VAULT_TX_API_CHANGE_ADDRESS_STRATEGY",
      "VAULT_TX_API_VAULT_PLUTUS_JSON",
      "VAULT_TX_API_BLOCKFROST_URL",
      "VAULT_TX_API_HOST",
      "VAULT_TX_API_PORT",
      "VAULT_TX_API_TOKEN",
      "VAULT_TX_API_TIMEOUT_MS",
      "VAULT_TX_API_LOCK_TTL_MS",
      "BLOCKFROST_PROJECT_ID",
    ]);
    // Chỉ tính hai hình dạng ĐỌC thật: truy cập thuộc tính trên `env`, và chuỗi tên
    // truyền vào bộ đọc.
    // Một hằng nội bộ như `BLOCKFROST_URL_BY_NETWORK` không phải biến môi trường, và gom
    // nó vào đây là biến phép kiểm thành thứ kêu ở chỗ không có gì sai.
    const found = new Set<string>();
    for (const file of SOURCE_FILES) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\benv\.([A-Z0-9_]+)\b/g)) found.add(m[1]!);
      for (const m of text.matchAll(/"(VAULT_TX_API_[A-Z0-9_]+|BLOCKFROST_[A-Z0-9_]+)"/g)) found.add(m[1]!);
    }
    expect([...found].filter(n => !allowed.has(n))).toEqual([]);
    // Và tên nào trong danh sách cũng KHÔNG được là một đường dẫn tới kho khoá: mã nhận
    // GIÁ TRỊ, không nhận sơ đồ kho. `VAULT_PLUTUS_JSON` là blueprint công khai của
    // `aiken build`, không phải kho bí mật.
    for (const name of allowed) {
      expect(name).not.toMatch(/(SECRET|KEYSTORE|WALLET|VAULT_KEY)/);
    }
  });
});
