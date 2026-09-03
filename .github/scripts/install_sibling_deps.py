#!/usr/bin/env python3
"""Cài `node_modules` cho các gói ANH EM mà một gói import qua đường dẫn tương đối.

VÌ SAO TỆP NÀY TỒN TẠI
----------------------
Kho này KHÔNG có workspace ở gốc (BOUNDARIES.md §1) — mỗi `offchain/` là một gói npm
độc lập, cài và chạy riêng. Bước cài phụ thuộc của CI đi theo `file:` dependency, và
điều đó đủ cho phần lớn gói.

Nhưng `scripts/` thì khác: nó `typecheck` bằng `tsc --noEmit`, và mã trong đó import
thẳng `../MagicSDK/src/...`, `../ScheduleGen/offchain/src/...`. tsc đi theo import và
biên dịch cả NGUỒN của gói anh em. Gói anh em không phải `file:` dependency của
`scripts/`, nên `node_modules` của chúng rỗng trên máy CI, và tsc trả về hàng chục lỗi
`Cannot find module '@lucid-evolution/lucid'` cộng một chuỗi `implicit any` ĂN THEO.

Hại thật không phải là CI đỏ — nó là CI đỏ vì lý do GIẢ. Một lỗi kiểu thật nằm lẫn
giữa 20 lỗi giả thì không ai nhìn thấy, và cổng mất tác dụng dù vẫn chạy.

CÁCH LÀM
--------
Quét mọi import tương đối trong gói, giữ lại những cái trỏ RA NGOÀI gói, tìm gói npm
gần nhất chứa đích, rồi `npm install` ở đó. Không khoá cứng tên gói nào — thêm một
import xuyên gói mới thì bước này tự thấy.

GIỚI HẠN, nói rõ để không ai tưởng nó làm nhiều hơn thực tế:
  - Chỉ đọc import TĨNH dạng `from "..."`. Không thấy `import()` động, không thấy
    `require()`, không thấy đường dẫn ghép từ biến.
  - Không đệ quy: nếu gói anh em lại import tương đối sang gói thứ ba thì gói thứ ba
    không được cài. Chưa cần, và thêm đệ quy khi chưa có ca thật là đoán trước.
"""
import json
import os
import re
import subprocess
import sys

REL_IMPORT = re.compile(r"""from\s+["'](\.[^"']+)["']""")
SKIP_DIRS = {"node_modules", "dist", ".git", "build"}
SRC_EXT = (".ts", ".mts", ".cts", ".js", ".mjs", ".cjs")


def owning_package(root: str, path: str):
    """Thư mục gói npm gần nhất chứa `path`. None nếu đi hết cây mà không gặp."""
    d = path if os.path.isdir(path) else os.path.dirname(path)
    while d.startswith(root):
        if os.path.isfile(os.path.join(d, "package.json")):
            return os.path.relpath(d, root)
        if os.path.normpath(d) == os.path.normpath(root):
            return None
        d = os.path.dirname(d)
    return None


def main() -> int:
    if len(sys.argv) != 2:
        print("dùng: install_sibling_deps.py <đường-dẫn-gói>", file=sys.stderr)
        return 2

    root = os.getcwd()
    pkg = os.path.normpath(sys.argv[1])
    pkg_abs = os.path.join(root, pkg)

    if not os.path.isfile(os.path.join(pkg_abs, "package.json")):
        print(f"{pkg}: không có package.json — bỏ qua.")
        return 0

    siblings = set()
    for dirpath, dirnames, filenames in os.walk(pkg_abs):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if not fn.endswith(SRC_EXT):
                continue
            try:
                text = open(os.path.join(dirpath, fn), encoding="utf8").read()
            except (UnicodeDecodeError, OSError):
                continue
            for spec in REL_IMPORT.findall(text):
                target = os.path.normpath(os.path.join(dirpath, spec))
                if target == pkg_abs or target.startswith(pkg_abs + os.sep):
                    continue  # vẫn trong gói — không phải anh em
                owner = owning_package(root, target)
                if owner and owner != pkg:
                    siblings.add(owner)

    if not siblings:
        print(f"{pkg}: không import tương đối ra ngoài gói — không phải cài gì thêm.")
        return 0

    for d in sorted(siblings):
        print(f"::group::npm install {d} (gói anh em của {pkg})")
        subprocess.run(
            ["npm", "install", "--no-audit", "--no-fund"],
            cwd=os.path.join(root, d),
            check=True,
        )
        print("::endgroup::")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
