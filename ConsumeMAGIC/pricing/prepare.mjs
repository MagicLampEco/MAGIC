#!/usr/bin/env node
// prepare.mjs — dựng dist/ ngay cả khi gói này CHƯA có devDependencies.
//
// Vì sao cần: npm chạy `prepare` của một dependency `file:` NGAY TRONG thư mục gói đó,
// nhưng KHÔNG cài devDependencies ở đó. Nên `prepare: "npm run build"` gọi `tsc` là
// gọi vào khoảng không — `npm install` của bên tiêu thụ chết ở code 127
// ("tsc: command not found", dev tuanzoro2k báo về 2026-08-26), và npm cuộn ngược cả
// cây gói. Kịch bản này tự cài bộ công cụ của chính nó trước khi build.
//
// Không dùng workspace ở gốc — BOUNDARIES.md §1 chốt mỗi gói offchain là gói độc lập.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";

// npm rót npm_package_* / npm_lifecycle_* / npm_config_local_prefix của gói CHA vào
// lifecycle script. Để nguyên thì lệnh npm lồng bên trong nhắm nhầm thư mục cha.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) =>
      !/^npm_(package|lifecycle)_/.test(k) &&
      k !== "npm_config_local_prefix" &&
      k !== "INIT_CWD",
  ),
);

function run(args, cwd) {
  const r = spawnSync(npm, args, { cwd, env, stdio: "inherit", shell: isWin });
  if (r.status !== 0) {
    console.error(`[prepare] ${pkg.name}: \`npm ${args.join(" ")}\` trong ${cwd} thất bại`);
    process.exit(r.status ?? 1);
  }
}

// 1. Bộ công cụ của chính gói này. --ignore-scripts để KHÔNG gọi lại chính prepare này
//    (npm chạy prepare của project sau mỗi install) — đó là chỗ đệ quy vô hạn.
if (!existsSync(join(pkgDir, "node_modules", "typescript"))) {
  const cmd = existsSync(join(pkgDir, "package-lock.json")) ? "ci" : "install";
  run([cmd, "--ignore-scripts", "--no-audit", "--no-fund"], pkgDir);
}

// 2. Các dependency `file:` có prepare riêng: bước 1 đã tắt script nên dist/ của chúng
//    chưa có, mà tsc của gói này cần .d.ts từ đó. Dựng tường minh, theo đúng đồ thị
//    phụ thuộc thật (hữu hạn, không vòng).
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
  const depDir = resolve(pkgDir, spec.slice("file:".length));
  const depPkgPath = join(depDir, "package.json");
  if (!existsSync(depPkgPath)) continue;
  const depPkg = JSON.parse(readFileSync(depPkgPath, "utf8"));
  if (!depPkg.scripts?.prepare) continue;
  console.log(`[prepare] ${pkg.name}: dựng phụ thuộc file: ${name} tại ${depDir}`);
  run(["run", "prepare"], depDir);
}

// 3. Build thật.
run(["run", "build"], pkgDir);
