// tests/genFormulaMirror.test.ts — canh bản chép có nhãn của toán Gen v2.0 (BOUNDARIES P8).
//
// ScheduleGen giữ một BẢN CHÉP của `InstantGen/.../gen_formula.ak`, `genFormula.ts`, các hằng
// Gen v2.0 và vector TV-GEN-*. Hai module là hai gói độc lập (không workspace ở gốc), nên chưa
// có chỗ chung để TRỎ. Bài này làm bản chép tự chết ỒN ÀO: lệch một ký tự trong thân hàm, một
// giá trị hằng, hay một literal vector ⟹ đỏ.
//
// Mặc định so với CÂY LÀM VIỆC của InstantGen (không phải một commit cố định): sửa bên
// InstantGen mà quên bên này thì bài đỏ ngay ở lượt kiểm ScheduleGen kế tiếp.
// `GEN_MIRROR_INSTANT_DIR=<thư mục>` thay gốc InstantGen bằng một ảnh chụp (vd. dựng từ
// `git show <sha>:InstantGen/<tệp>` vào thư mục nháp, giữ cấu trúc `onchain/…`, `offchain/src/…`,
// `tests/vectors.ts`) — để đo bản chép so với ĐÚNG commit nó chép.
//
// Bỏ qua khi so thân: dòng nhãn `// BẢN CHÉP CÓ NHÃN …` và khối nhập (`use …` / `import …`),
// vì đường nhập hợp lệ khác nhau giữa hai gói. Mọi thứ còn lại phải trùng nguyên văn.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import * as scheduleVectors from "./vectors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEDULE = resolve(HERE, "..");
const INSTANT = process.env["GEN_MIRROR_INSTANT_DIR"] ?? resolve(HERE, "../../InstantGen");
const mine = (p: string): string => readFileSync(resolve(SCHEDULE, p), "utf8");
const theirs = (p: string): string => readFileSync(resolve(INSTANT, p), "utf8");
const instantVectors: Record<string, unknown> =
  await import(pathToFileURL(resolve(INSTANT, "tests/vectors.ts")).href);

const LABEL_PREFIX = "// BẢN CHÉP CÓ NHÃN";

/** Bỏ dòng nhãn và các khối nhập nhiều dòng (`use x.{ … }` / `import { … } from "…";`). */
function stripHeader(src: string, keyword: "use" | "import"): string {
  const importEnds = (line: string): boolean =>
    keyword === "use" ? line.includes("}") : /from\s+["'][^"']+["'];?\s*$/.test(line);
  const out: string[] = [];
  let inImport = false;
  for (const line of src.split("\n")) {
    if (inImport) {
      if (importEnds(line)) inImport = false;
      continue;
    }
    if (line.startsWith(LABEL_PREFIX)) continue;
    if (line.startsWith(keyword + " ")) {
      const closed = keyword === "use" ? !line.includes("{") || line.includes("}") : importEnds(line);
      inImport = !closed;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

const AK_PATH = "onchain/lib/magiclamp/protocol/gen_formula.ak";
const TS_PATH = "offchain/src/genFormula.ts";

describe("Gen v2.0 — thân bản chép trùng nguyên văn bản InstantGen (P8)", () => {
  it("gen_formula.ak: thân trùng (bỏ nhãn + `use`)", () => {
    const a = stripHeader(mine(AK_PATH), "use");
    const b = stripHeader(theirs(AK_PATH), "use");
    // Chặn ca rỗng-trùng-rỗng: bộ lọc không được nuốt cả thân.
    expect(a).toContain("pub fn generation_amount(");
    expect(a).toContain("test tv_gen_amount_overflow()");
    expect(a).toBe(b);
  });

  it("genFormula.ts: thân trùng (bỏ nhãn + `import`)", () => {
    const a = stripHeader(mine(TS_PATH), "import");
    const b = stripHeader(theirs(TS_PATH), "import");
    expect(a).toContain("export function generationAmount(");
    expect(a).toBe(b);
  });
});

// Các hằng Gen v2.0 mà bản chép cần. So GIÁ TRỊ, không so văn bản: chú thích quanh hằng được
// phép khác (bên này có nhãn chép), giá trị thì không.
const AK_CONSTS = [
  "q", "lent_pp_cap", "usage_factor_floor_q", "scale_coverage_q", "usage_window_len",
  "instant_scale_horizon", "gb_vault_share_q", "gb_shard_cap_nanogic", "buffer_ep", "rho_max_q",
] as const;
const TS_CONSTS = [
  "Q", "LENT_PP_CAP", "USAGE_FACTOR_FLOOR_Q", "SCALE_COVERAGE_Q", "USAGE_WINDOW_LEN",
  "INSTANT_SCALE_HORIZON", "GB_VAULT_SHARE_Q", "GB_SHARD_CAP_NANOGIC", "BUFFER_EP", "RHO_MAX_Q",
] as const;

/** Mọi giá trị khai cho `name` trong tệp (bản chép phải có đúng MỘT). */
function constValues(src: string, re: (n: string) => RegExp, name: string): string[] {
  return [...src.matchAll(re(name))].map(m => (m[1] ?? "").replace(/_/g, ""));
}

describe("Gen v2.0 — giá trị hằng bản chép trùng bản InstantGen (P8)", () => {
  const akRe = (n: string) => new RegExp(`^pub const ${n}\\s*:\\s*Int\\s*=\\s*([0-9_]+)`, "gm");
  const tsRe = (n: string) => new RegExp(`^export const ${n}\\s*=\\s*([0-9_]+)n?\\s*;`, "gm");
  const akMine = mine("onchain/lib/magiclamp/protocol/constants.ak");
  const akTheirs = theirs("onchain/lib/magiclamp/protocol/constants.ak");
  const tsMine = mine("offchain/src/constants.ts");
  const tsTheirs = theirs("offchain/src/constants.ts");

  for (const n of AK_CONSTS) {
    it(`constants.ak ▸ ${n}`, () => {
      const v = constValues(akMine, akRe, n);
      expect(v).toHaveLength(1);
      expect(v).toEqual(constValues(akTheirs, akRe, n));
    });
  }
  for (const n of TS_CONSTS) {
    it(`constants.ts ▸ ${n}`, () => {
      const v = constValues(tsMine, tsRe, n);
      expect(v).toHaveLength(1);
      expect(v).toEqual(constValues(tsTheirs, tsRe, n));
    });
  }
});

describe("Gen v2.0 — vector TV-GEN-* bản chép trùng bản InstantGen (P8)", () => {
  const names = Object.keys(instantVectors).filter(k => k.startsWith("TV_GEN_")).sort();
  it("cùng tập tên TV_GEN_*", () => {
    expect(names.length).toBeGreaterThan(0);
    expect(Object.keys(scheduleVectors).filter(k => k.startsWith("TV_GEN_")).sort()).toEqual(names);
  });
  for (const n of names) {
    it(n, () => {
      expect((scheduleVectors as Record<string, unknown>)[n]).toEqual(instantVectors[n]);
    });
  }
});
