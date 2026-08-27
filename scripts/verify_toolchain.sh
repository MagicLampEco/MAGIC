#!/usr/bin/env bash
# Cổng trình biên dịch — vì `compiler =` trong aiken.toml KHÔNG phải cổng.
#
# Đo trên aiken v1.1.21 (2026-08-21): ghim sai bản chỉ ra
#     ⚠ aiken.toml demands compiler version v1.0.0, but you are using v1.1.21.
# rồi `aiken check` vẫn `exit 0`. Cảnh báo không chặn ai. Script này chặn.
#
# Vì sao cần: byte của validator do (mã nguồn × trình biên dịch × apply-param) quyết định.
# Dựng lại đúng commit mà khác bản aiken thì ra hash khác — và trên Cardano hash khác
# nghĩa là một ĐỊA CHỈ khác, tiền ở địa chỉ cũ không ai mở được nữa.
set -euo pipefail
cd "$(dirname "$0")/.."

have="$(aiken --version | awk '{print $2}' | cut -d+ -f1)"; have="${have#v}"
rc=0
while IFS= read -r f; do
  want="$(sed -n 's/^compiler[[:space:]]*=[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}.*/\1/p' "$f" | head -1)"
  if [ -z "$want" ]; then
    echo "THIẾU GHIM  $f — thêm dòng: compiler = \"v$have\""; rc=1; continue
  fi
  if [ "${want#v}" != "$have" ]; then
    echo "LỆCH BẢN    $f ghim $want · máy đang chạy v$have"; rc=1; continue
  fi
  echo "khớp        $f  $want"
done < <(find . -name aiken.toml \
           -not -path '*/build/*' \
           -not -path '*/Legacy/*' \
           -not -path './.claude/*' \
           -not -path '*/node_modules/*' | sort)

[ $rc -eq 0 ] && echo "→ toàn bộ project khớp aiken v$have" || echo "→ KHÔNG dựng lại được byte đã deploy bằng bản aiken này."
exit $rc
