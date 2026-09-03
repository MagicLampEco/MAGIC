// scripts/emit_build_record.ts — sinh BẢN GHI DỰNG từ chính hiện vật, không chép tay.
//
// Vì sao tồn tại. `plutus.json` là hiện vật DUY NHẤT mang chuỗi trình biên dịch đủ hậu
// tố (`v1.1.21+42babe5`) và hash của từng validator — mà nó bị `.gitignore`. Nên chuỗi
// bảo đảm đứt đúng ở giữa: một lượt `aiken build` bất kỳ ghi đè nó và `git status` vẫn
// sạch trơn. Cách vá cũ là **chép tay** chuỗi đó vào `DEPLOYED.md`; mà cổng nào đọc bản
// chép tay cũng chỉ trả lời được "tệp này có tự nhất quán không" — người chép sai thì
// cổng so bản sai với chính bản sai.
//
// Nên đảo chiều: bản ghi KHÔNG do người viết. Máy sinh từ nơi giữ duy nhất
// (`plutus.json` + `git`), người chỉ viết phần văn xuôi quanh nó. Ý này của LAMP agent
// (thư 2026-08-27 §2), đã dùng được ở nhà đó cho ca `verify_deployed_bytes.sh`.
//
// TRẦN — nói trước để không ai tính nhầm:
//   · Hash ở đây là hash validator **CHƯA apply-param**. Nó ghim (mã nguồn × trình biên
//     dịch × thư viện). Nó KHÔNG phải địa chỉ đã deploy — địa chỉ còn cần bộ apply-param,
//     việc đó do `verify:hashes` (`verify_per_network.ts`) làm.
//   · Nó không biến "cái gì đang chạy trên chuỗi" thành thứ kiểm được. Nó chỉ bảo đảm:
//     bản ghi đúng bằng lần dựng đã sinh ra nó. Ai bỏ qua script này, tự dựng tay rồi tự
//     viết vào sổ, thì cổng lại mù — chỉ khác là giờ phải CỐ Ý đi vòng thay vì chỉ QUÊN.
//
// Dùng:
//   npx tsx emit_build_record.ts            # ghi đè khối máy-sinh trong BUILD-RECORD.md
//   npx tsx emit_build_record.ts --check     # không ghi; exit 1 nếu khối đã cũ
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const REPO = join(import.meta.dirname, "..");
const OUT = join(import.meta.dirname, "BUILD-RECORD.md");
const BEGIN = "<!-- MÁY SINH — BẮT ĐẦU. Đừng sửa tay: `npm run record:build` ghi đè. -->";
const END = "<!-- MÁY SINH — HẾT -->";

const git = (...args: string[]) =>
  execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();

/** Mọi `aiken.toml` của project — cùng bộ lọc với verify_toolchain.sh. */
function moduleDirs(): string[] {
  const out = execFileSync(
    "find",
    [".", "-name", "aiken.toml", "-not", "-path", "*/build/*", "-not", "-path", "*/Legacy/*",
     "-not", "-path", "./.claude/*", "-not", "-path", "*/node_modules/*"],
    { cwd: REPO, encoding: "utf8" },
  );
  return out.split("\n").filter(Boolean).map((p) => dirname(p)).sort();
}

type Row = { module: string; compiler: string; validators: [string, string][] };

function readBlueprint(dir: string): Row | null {
  const bp = join(REPO, dir, "plutus.json");
  if (!existsSync(bp)) return null;
  const d = JSON.parse(readFileSync(bp, "utf8"));
  const seen = new Map<string, string>();
  for (const v of d.validators ?? []) {
    // `consume.consume.spend` / `.mint` / `.else` là BA handler của MỘT validator, cùng
    // một hash. Gộp theo hash để bản ghi không phình ba lần mà không thêm dữ kiện nào.
    const name = String(v.title).split(".").slice(0, 2).join(".");
    if (v.hash && !seen.has(name)) seen.set(name, v.hash);
  }
  return {
    module: relative(REPO, join(REPO, dir)),
    compiler: d.preamble?.compiler?.version ?? "(blueprint không khai)",
    validators: [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  };
}

function render(): string {
  const rows = moduleDirs().map(readBlueprint).filter((r): r is Row => r !== null);
  const lines: string[] = [];
  lines.push(BEGIN, "");
  if (rows.length === 0) {
    lines.push("_Chưa module nào có `plutus.json`. Chạy `aiken build` trong `<Module>/onchain/` trước._");
  }
  for (const r of rows) {
    lines.push(`### \`${r.module}\``, "", `trình biên dịch \`${r.compiler}\``, "");
    lines.push("| validator | hash (CHƯA apply-param) |", "|---|---|");
    for (const [name, hash] of r.validators) lines.push(`| \`${name}\` | \`${hash}\` |`);
    lines.push("");
  }
  lines.push(END);
  return lines.join("\n");
}

const HEADER = `# Bản ghi dựng — máy sinh, không chép tay

Sinh bằng \`npm run record:build\` (trong \`scripts/\`) từ \`plutus.json\` của từng module.
Đừng sửa khối dưới bằng tay: \`npm run verify:build-record\` so lại và **exit 1** khi lệch.

**Hash dưới đây là hash validator CHƯA apply-param** — nó ghim *mã nguồn × trình biên dịch ×
thư viện*, KHÔNG phải địa chỉ đã deploy. Địa chỉ còn cần bộ apply-param: xem
\`npm run verify:hashes\`.

Vì sao tệp này tồn tại: \`plutus.json\` bị \`.gitignore\`, nên chuỗi trình biên dịch đủ hậu tố
và hash validator chỉ sống trong một hiện vật nằm ngoài lịch sử git. Tệp này kéo hai thứ đó
vào lịch sử — bằng máy, để không ai phải chép.

**Mốc thời gian là chính commit chứa tệp này**, nên khối dưới cố ý KHÔNG chép sha vào. Chép
vào thì lượt commit kế tiếp làm nó lỗi thời ngay, và cổng sẽ đỏ vĩnh viễn vì một lý do không
liên quan gì tới byte.

`;

const body = render();
const check = process.argv.includes("--check");

if (check) {
  if (!existsSync(OUT)) {
    console.error(`✗ chưa có ${relative(REPO, OUT)} — chạy \`npm run record:build\``);
    process.exit(1);
  }
  const cur = readFileSync(OUT, "utf8");
  const i = cur.indexOf(BEGIN), j = cur.indexOf(END);
  if (i < 0 || j < 0) {
    console.error(`✗ ${relative(REPO, OUT)} thiếu cặp mốc MÁY SINH — chạy \`npm run record:build\``);
    process.exit(1);
  }
  if (cur.slice(i, j + END.length).trim() !== body.trim()) {
    console.error(`✗ ${relative(REPO, OUT)} ĐÃ CŨ so với plutus.json đang có.`);
    console.error(`  Dựng lại rồi chạy \`npm run record:build\`, và commit tệp đó cùng lượt.`);
    process.exit(1);
  }
  console.log(`→ ${relative(REPO, OUT)} khớp hiện vật đang có`);
  process.exit(0);
}

// Cây bẩn thì bản ghi không quy được về commit nào — báo, nhưng KHÔNG ghi vào khối.
// Nhét commit/trạng-thái-cây vào khối là tự làm nó lỗi thời ngay lượt commit kế tiếp
// (commit tệp xong thì sha đổi, cây sạch lại) ⇒ `--check` đỏ vĩnh viễn. Commit chứa
// tệp này CHÍNH LÀ mốc thời gian; git đã giữ hộ, không cần chép lần nữa.
if (git("status", "--porcelain").length > 0) {
  console.warn("⚠ cây làm việc BẨN lúc sinh — bản ghi này chưa quy được về một commit nào");
}

const prev = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
const i = prev.indexOf(BEGIN), j = prev.indexOf(END);
const next = i >= 0 && j >= 0
  ? prev.slice(0, i) + body + prev.slice(j + END.length)
  : HEADER + body + "\n";
writeFileSync(OUT, next);
console.log(`→ đã ghi ${relative(REPO, OUT)}`);
