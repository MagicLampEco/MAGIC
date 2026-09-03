#!/usr/bin/env python3
"""Dò phạm vi PR: suy ra tập gói npm + project Aiken bị chạm từ diff HEAD^1...HEAD^2.

Bài học nguồn (thư agent nhà SuperApp, 2026-08-14): một cổng CI tự chọn tập
kiểm cố định thay vì bám diff thật đã để lọt mã Rust chưa từng qua compiler.
Quy tắc rút ra, áp ở đây: cổng PHẢI bám theo diff của PR, KHÔNG được tự chọn
tập kiểm. Và sai chỉ được phép một chiều — thà chạy thừa, không được bỏ sót.

Vì vậy mọi trường hợp không chắc chắn (git diff hỏng, không lấy được hai cha
của commit gộp thử, sự kiện không phải pull_request...) đều rơi về "chạy
TẤT mọi gói/project đã phát hiện", không bao giờ rơi về danh sách rỗng do
lỗi ngầm bị nuốt.

`pull_request` checkout ra commit GỘP THỬ (merge test commit) — cây tệp của
nó không phải cây tệp của nhánh nguồn hay nhánh đích, mà là kết quả trộn tạm.
Muốn lấy hai cha thật (HEAD^1 = gốc/base, HEAD^2 = ngọn/PR head) thì
`actions/checkout` phải chạy với `fetch-depth: 2` — mặc định `1` sẽ khiến
`git rev-parse HEAD^2` lỗi trong im lặng nếu không kiểm mã thoát.
"""
import json
import os
import re
import subprocess
import sys

REPO_ROOT = os.getcwd()
EXCLUDE_DIR_NAMES = {
    "node_modules", ".git", "Legacy", "dist", "build", "_Agents", ".github", ".claude",
}
VITEST_CONFIG_NAMES = (
    "vitest.config.ts", "vitest.config.js", "vitest.config.mts", "vitest.config.mjs",
)
GLOB_META = re.compile(r"[*?\[{]")
INCLUDE_STRING = re.compile(r"""["']([^"']+)["']""")


def glob_root(pattern):
    """'../tests/**/*.test.ts' -> '../tests' — phần thư mục thật trước ký tự glob đầu tiên."""
    m = GLOB_META.search(pattern)
    prefix = pattern[: m.start()] if m else pattern
    if not prefix.endswith("/"):
        prefix = os.path.dirname(prefix)
    return prefix.rstrip("/")


def find_test_include_dirs(pkg_dir_abs):
    """Đọc vitest.config.* (nếu có) cạnh package.json, trả về tập rel_dir (so với repo
    root) mà `include` glob trỏ tới — kể cả khi trỏ RA NGOÀI thư mục gói (mẫu thật của
    kho này: `<Module>/offchain/vitest.config.ts` include `../tests/**/*.test.ts`, tức
    bộ vector kiểm chuẩn nằm ở `<Module>/tests/`, ngoài `offchain/`). Không bắt phần
    này thì đổi mỗi `<Module>/tests/vectors.ts` mà không đụng `offchain/src/` sẽ lọt
    qua dò phạm vi y hệt bài học SuperApp — test chạy nhưng CI không biết để chạy nó."""
    dirs = set()
    for name in VITEST_CONFIG_NAMES:
        cfg_path = os.path.join(pkg_dir_abs, name)
        if not os.path.isfile(cfg_path):
            continue
        try:
            with open(cfg_path, "r", encoding="utf-8") as fh:
                content = fh.read()
        except Exception as exc:
            print(f"::warning::Không đọc được {cfg_path}: {exc}")
            continue
        m = re.search(r"include\s*:\s*\[([^\]]*)\]", content)
        if not m:
            continue
        for pattern in INCLUDE_STRING.findall(m.group(1)):
            root = glob_root(pattern)
            if not root:
                continue
            resolved = os.path.normpath(os.path.join(pkg_dir_abs, root))
            dirs.add(os.path.relpath(resolved, REPO_ROOT))
    return dirs


def sh(*args):
    """Chạy lệnh, trả (returncode, stdout, stderr). Không raise — nơi gọi tự xét mã thoát."""
    proc = subprocess.run(args, cwd=REPO_ROOT, capture_output=True, text=True)
    return proc.returncode, proc.stdout, proc.stderr


def should_skip_dir(rel_dir):
    parts = os.path.normpath(rel_dir).split(os.sep)
    return any(p in EXCLUDE_DIR_NAMES for p in parts)


def find_package_jsons():
    """Trả {rel_dir: {"name": str, "file_deps": set(rel_dir)}} cho mọi package.json thật
    (loại trừ node_modules/dist/build/Legacy/_Agents/.github/.claude)."""
    pkgs = {}
    for root, dirs, files in os.walk(REPO_ROOT):
        rel_root = os.path.relpath(root, REPO_ROOT)
        if rel_root == ".":
            rel_root = ""
        if should_skip_dir(rel_root):
            dirs[:] = []
            continue
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIR_NAMES]
        if "package.json" in files:
            path = os.path.join(root, "package.json")
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
            except Exception as exc:  # tệp package.json hỏng — báo, không lặng lẽ bỏ qua
                print(f"::warning::Không đọc được {path}: {exc}")
                continue
            deps = {}
            deps.update(data.get("dependencies", {}) or {})
            deps.update(data.get("devDependencies", {}) or {})
            file_deps = set()
            for spec in deps.values():
                if isinstance(spec, str) and spec.startswith("file:"):
                    target = spec[len("file:"):]
                    dep_dir = os.path.normpath(os.path.join(root, target))
                    dep_rel = os.path.relpath(dep_dir, REPO_ROOT)
                    file_deps.add(dep_rel)
            extra_dirs = find_test_include_dirs(root)
            pkgs[rel_root] = {
                "name": data.get("name", rel_root),
                "file_deps": file_deps,
                "extra_dirs": extra_dirs,
            }
    return pkgs


def find_aiken_projects():
    """Trả danh sách rel_dir của mọi project Aiken cấp cao nhất (có aiken.toml),
    loại trừ Legacy/ và các gói vendor nằm dưới onchain/build/."""
    projects = []
    for root, dirs, files in os.walk(REPO_ROOT):
        rel_root = os.path.relpath(root, REPO_ROOT)
        if rel_root == ".":
            rel_root = ""
        if should_skip_dir(rel_root):
            dirs[:] = []
            continue
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIR_NAMES]
        if "aiken.toml" in files:
            projects.append(rel_root)
    return sorted(projects)


def path_under(changed_file, dir_rel):
    if dir_rel in ("", "."):
        return True
    changed_norm = os.path.normpath(changed_file)
    dir_norm = os.path.normpath(dir_rel)
    return changed_norm == dir_norm or changed_norm.startswith(dir_norm + os.sep)


def compute_scope(changed_files, pkgs, aiken_projects):
    """Logic dò thuần (không đụng git/env) — tách riêng để chạy tay/kiểm được ngoài CI."""
    changed_pkgs = set()
    for f in changed_files:
        for d, info in pkgs.items():
            trigger_dirs = {d} | info.get("extra_dirs", set())
            if any(path_under(f, t) for t in trigger_dirs):
                changed_pkgs.add(d)

    reverse = {}
    for d, info in pkgs.items():
        for dep in info["file_deps"]:
            reverse.setdefault(dep, set()).add(d)

    frontier = set(changed_pkgs)
    closure = set(changed_pkgs)
    while frontier:
        nxt = set()
        for d in frontier:
            for dependent in reverse.get(d, ()):
                if dependent not in closure:
                    closure.add(dependent)
                    nxt.add(dependent)
        frontier = nxt

    npm_out = sorted(closure)
    aiken_out = sorted({d for f in changed_files for d in aiken_projects if path_under(f, d)})

    def in_any_known_scope(f):
        for d, info in pkgs.items():
            if path_under(f, d) or any(path_under(f, t) for t in info.get("extra_dirs", set())):
                return True
        return any(path_under(f, d) for d in aiken_projects)

    untouched = [f for f in changed_files if not in_any_known_scope(f)]
    return npm_out, aiken_out, untouched


def get_changed_files():
    """Trả (ok, files, reason). ok=False => phải chạy tất, không phải danh sách rỗng."""
    # ── Chế độ CỤC BỘ ─────────────────────────────────────────────────────────
    # Cổng CI của kho này đang bị chặn vì thanh toán tài khoản, không phải vì mã
    # (job đầu tiên trả về 0 bước, annotation nguyên văn: "The job was not started
    # because recent account payments have failed..."). Nên phải có đường chạy ĐÚNG
    # cổng đó ở máy, trước khi đẩy. Dùng CHUNG bộ dò này thay vì chép luật sang một
    # kịch bản thứ hai — hai bộ dò là hai cổng khác nhau đội lốt một.
    base = os.environ.get("LOCAL_BASE", "")
    if base:
        rc, _, err = sh("git", "rev-parse", "--verify", base)
        if rc != 0:
            return False, [], f"LOCAL_BASE={base!r} không phải ref hợp lệ: {err.strip()} — chạy tất."
        rc, out, err = sh("git", "diff", "--name-only", f"{base}...HEAD")
        if rc != 0:
            return False, [], f"git diff {base}...HEAD thất bại (mã {rc}): {err.strip()} — chạy tất."
        files = [line.strip() for line in out.splitlines() if line.strip()]
        return True, files, "ok (chế độ cục bộ)"

    event = os.environ.get("GITHUB_EVENT_NAME", "")
    if event != "pull_request":
        return False, [], (
            f"event '{event}' không phải pull_request — không có diff hai cha "
            "để dò theo đúng nghĩa PR, chạy tất."
        )

    rc1, _, err1 = sh("git", "rev-parse", "HEAD^1")
    rc2, _, err2 = sh("git", "rev-parse", "HEAD^2")
    if rc1 != 0 or rc2 != 0:
        return False, [], (
            "không lấy được HEAD^1/HEAD^2 (thiếu fetch-depth:2 khi checkout, hoặc "
            f"HEAD không phải commit gộp thử). rc1={rc1} err1={err1.strip()!r} "
            f"rc2={rc2} err2={err2.strip()!r} — chạy tất."
        )

    rc, out, err = sh("git", "diff", "--name-only", "HEAD^1", "HEAD^2")
    if rc != 0:
        return False, [], f"git diff thất bại (mã {rc}): {err.strip()} — chạy tất."

    files = [line.strip() for line in out.splitlines() if line.strip()]
    return True, files, "ok"


def main():
    ok, changed_files, reason = get_changed_files()
    pkgs = find_package_jsons()
    aiken_projects = find_aiken_projects()

    print(f"Tổng gói npm phát hiện: {len(pkgs)}")
    for d in sorted(pkgs):
        deps = sorted(pkgs[d]["file_deps"]) or "-"
        extra = sorted(pkgs[d].get("extra_dirs", set())) or "-"
        print(f"  - {d}  ({pkgs[d]['name']})  deps nội bộ: {deps}  vùng kiểm ngoài (vitest include): {extra}")
    print(f"Tổng project Aiken phát hiện: {len(aiken_projects)}")
    for d in aiken_projects:
        print(f"  - {d}")

    run_all = not ok
    if run_all:
        print(f"::warning::Dò phạm vi rơi về CHẠY TẤT. Lý do: {reason}")
        npm_out = sorted(pkgs.keys())
        aiken_out = aiken_projects
    else:
        print(f"Tệp đổi trong PR ({len(changed_files)}):")
        for f in changed_files:
            print(f"  - {f}")

        npm_out, aiken_out, untouched = compute_scope(changed_files, pkgs, aiken_projects)

        if untouched:
            print("Tệp đổi ngoài mọi gói/project đã biết (không cần kiểm code cho các tệp này):")
            for f in untouched:
                print(f"  - {f}")

    print(f"=> npm_packages ({len(npm_out)}): {npm_out}")
    print(f"=> aiken_projects ({len(aiken_out)}): {aiken_out}")
    print(f"=> run_all: {run_all}")

    gh_out = os.environ.get("GITHUB_OUTPUT")
    if not gh_out:
        # Chạy ở máy: in ra stdout theo đúng cùng ba khoá để `verify.sh` đọc. KHÔNG
        # thoát lỗi — thoát lỗi ở đây là biến chế độ cục bộ thành thứ không dùng được.
        if os.environ.get("LOCAL_BASE"):
            print(f"SCOPE_NPM={json.dumps(npm_out)}")
            print(f"SCOPE_AIKEN={json.dumps(aiken_out)}")
            print(f"SCOPE_RUN_ALL={'true' if run_all else 'false'}")
            return
        print("::error::Không thấy biến môi trường GITHUB_OUTPUT — không chạy trong GitHub Actions?")
        sys.exit(1)
    with open(gh_out, "a", encoding="utf-8") as fh:
        fh.write(f"npm_packages={json.dumps(npm_out)}\n")
        fh.write(f"aiken_projects={json.dumps(aiken_out)}\n")
        fh.write(f"run_all={'true' if run_all else 'false'}\n")


if __name__ == "__main__":
    main()
