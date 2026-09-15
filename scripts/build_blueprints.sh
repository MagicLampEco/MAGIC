#!/usr/bin/env bash
# scripts/build_blueprints.sh — dựng `plutus.json` cho MỌI project Aiken của kho.
#
# Vì sao tệp này tồn tại, và vì sao nó phải chạy TRƯỚC `verify:build-record`.
#
# `plutus.json` là hiện vật, đã `.gitignore` (BOUNDARIES.md §4). `verify:build-record`
# so sổ với hiện vật ĐANG CÓ trên đĩa — nó không dựng gì cả. Nên nếu hiện vật cũ hơn mã
# nguồn, phép so đó đối chiếu một bản cũ với một bản cũ khác và in ra "khớp". Đó là
# trạng thái thứ ba mà Forall §Cổng gác bắt phải tách ra: KHÔNG ĐO ĐƯỢC, và nó nguy
# hiểm hơn LỆCH vì nó mang màu của KHỚP.
#
# Script này khoá trạng thái đó lại bằng cách làm hiện vật mới trước khi ai so nó.
#
# Và nó đếm hai đầu. `aiken build` hỏng ở một project thì `set -e` giết script ngay —
# nhưng ca đắt hơn là project bị bộ lọc `find` bỏ sót trong im lặng: lúc đó số sổ vẫn
# khớp số hiện vật, chỉ là cả hai cùng thiếu một module. Phép đếm dưới đây là phép
# liệt kê ĐÓNG cho câu "bao nhiêu project đã được dựng", và nó in ra danh sách chứ
# không chỉ in con số.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

find_projects() {
  find . -name aiken.toml \
    -not -path '*/build/*' \
    -not -path '*/Legacy/*' \
    -not -path './.claude/*' \
    -not -path '*/node_modules/*' | sort
}

command -v aiken >/dev/null 2>&1 || {
  echo "✗ không có \`aiken\` trên PATH — không dựng được hiện vật nào." >&2
  echo "  Đây là trạng thái KHÔNG ĐO ĐƯỢC, không phải trạng thái KHỚP." >&2
  exit 1
}

echo "→ aiken: $(aiken --version)"

expected=0
while IFS= read -r toml; do
  dir="$(dirname "$toml")"
  expected=$((expected + 1))
  echo "── aiken build $dir"
  ( cd "$ROOT/$dir" && aiken build >/dev/null )
done < <(find_projects)

actual=0
while IFS= read -r toml; do
  dir="$(dirname "$toml")"
  if [ -f "$ROOT/$dir/plutus.json" ]; then
    actual=$((actual + 1))
  else
    echo "  THIẾU HIỆN VẬT  $dir/plutus.json — aiken build không sinh ra blueprint" >&2
  fi
done < <(find_projects)

echo "→ project Aiken tìm thấy: $expected · blueprint đã dựng: $actual"
find_projects | sed 's|/aiken.toml$||; s|^|   · |'

if [ "$expected" -ne "$actual" ]; then
  echo "✗ số blueprint KHÔNG bằng số project — phép so sổ phía sau sẽ mù ở phần thiếu." >&2
  exit 1
fi

if [ "$expected" -eq 0 ]; then
  echo "✗ không tìm thấy project Aiken nào. Bộ lọc \`find\` sai, hoặc đang đứng nhầm thư mục." >&2
  echo "  Không project nào thì phép so sổ luôn 'khớp' mà không đo gì — coi là ĐỎ." >&2
  exit 1
fi
