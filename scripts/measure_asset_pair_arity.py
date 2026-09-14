#!/usr/bin/env python3
"""Đo: có lời gọi `assets.quantity_of` nào tra tài sản THIẾU vế asset_name không.

Vì sao không dùng grep. Định danh một tài sản trên Cardano là cặp
`(policy id, asset name)`; `assets.quantity_of(value, policy_id, asset_name)` phải
nhận đủ ba. Một phép grep một dòng KHÔNG đọc được lời gọi trải nhiều dòng, nên nó
trả về "sạch" cho một tập nó chưa hề nhìn thấy — màu xanh đó nói "tôi không biết"
bằng giọng "ổn". Đo 2026-09-14: 4 trong 51 lời gọi của kho này trải nhiều dòng.

Kịch bản này cân ngoặc và đếm dấu phẩy ở mức ngoài cùng, nên nó đọc được cả hai
dạng, và bỏ dấu phẩy đuôi (Aiken cho phép).

    python3 scripts/measure_asset_pair_arity.py      # exit 1 nếu có lời gọi thiếu vế

Bỏ qua `Legacy/` (kho lịch sử, không phải nguồn) và `.claude/worktrees/` — cây làm
việc phụ là BẢN SAO của chính kho này, đếm cả hai là đếm đôi mọi con số.
"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
CALL = re.compile(r"assets\.quantity_of\s*\(")
SKIP = ("Legacy/", ".claude/")


def split_args(src: str, i: int):
    """`i` trỏ ngay sau '('. Trả (danh sách tham số, vị trí sau ')') — None nếu lệch ngoặc."""
    depth, args, cur = 1, [], []
    while i < len(src):
        c = src[i]
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
            if depth == 0:
                args.append("".join(cur).strip())
                return args, i + 1
        elif c == "," and depth == 1:
            args.append("".join(cur).strip())
            cur = []
            i += 1
            continue
        cur.append(c)
        i += 1
    return None, i


def main() -> int:
    total = multiline = 0
    missing = []
    for path in sorted(ROOT.rglob("*.ak")):
        rel = str(path.relative_to(ROOT))
        if rel.startswith(SKIP):
            continue
        src = path.read_text(encoding="utf8", errors="replace")
        for m in CALL.finditer(src):
            args, end = split_args(src, m.end())
            if args is None:
                print(f"  ⚠ KHÔNG ĐO ĐƯỢC — lệch ngoặc ở {rel}:{src.count(chr(10), 0, m.start()) + 1}")
                return 1
            args = [a for a in args if a != ""]      # dấu phẩy đuôi
            total += 1
            if "\n" in src[m.end():end]:
                multiline += 1
            if len(args) != 3:
                missing.append((rel, src.count("\n", 0, m.start()) + 1, args))

    print(f"lời gọi assets.quantity_of : {total}")
    print(f"  trong đó trải nhiều dòng : {multiline}   (grep một dòng không đọc được)")
    print(f"  truyền đủ (value, policy_id, asset_name) : {total - len(missing)}")
    if missing:
        print(f"  ✗ THIẾU vế : {len(missing)}")
        for rel, line, args in missing:
            print(f"     {rel}:{line}  {args}")
        return 1
    print("  ✓ không lời gọi nào tra tài sản bằng policy id một mình")
    return 0


if __name__ == "__main__":
    sys.exit(main())
