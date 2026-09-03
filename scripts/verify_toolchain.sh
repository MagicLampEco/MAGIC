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

full="$(aiken --version | awk '{print $2}')"          # v1.1.21+42babe5 — ĐỦ hậu tố commit
have="${full#v}"; have="${have%%+*}"                   # 1.1.21 — phần semver, để so với aiken.toml
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

  # ── Vế 3: THƯ VIỆN. Trình biên dịch đúng bản mà stdlib trôi thì hash vẫn đổi.
  #    Tag git KHÔNG phải định danh bất biến — `v3.1.0` trỏ lại được sang commit
  #    khác, và khi đó dựng lại cùng một commit của repo này ra `plutus.json` khác
  #    ⇒ script hash khác ⇒ ĐỊA CHỈ khác. Nên mọi PHỤ THUỘC phải ghim SHA 40 hex.
  #    Đây là vế một module MỚI rất dễ bỏ sót, và không gì báo.
  #    Chỉ soi khối phụ thuộc — `version` của chính gói (`[package]`) là số phiên
  #    bản của repo này, không phải thứ quyết định byte.
  dep_out="$(python3 - "$f" "$(dirname "$f")/aiken.lock" <<'PYEOF'
import re, sys, os
def deps(path, header):
    if not os.path.exists(path): return []
    out, cur, inblk = [], {}, False
    for line in open(path):
        t = line.strip()
        if t.startswith("[["):
            if inblk and cur.get("version"): out.append((cur.get("name","?"), cur["version"]))
            inblk = (t == header); cur = {}
            continue
        if t.startswith("[") : 
            if inblk and cur.get("version"): out.append((cur.get("name","?"), cur["version"]))
            inblk = False; cur = {}
            continue
        if inblk:
            m = re.match(r'(name|version)\s*=\s*"([^"]*)"', t)
            if m: cur[m.group(1)] = m.group(2)
    if inblk and cur.get("version"): out.append((cur.get("name","?"), cur["version"]))
    return out
bad = []
for path, header in ((sys.argv[1], "[[dependencies]]"), (sys.argv[2], "[[packages]]")):
    for name, ver in deps(path, header):
        if not re.fullmatch(r"[0-9a-f]{40}", ver):
            bad.append(f"  GHIM BẰNG TAG  {path}: {name} = \"{ver}\" — phải là SHA commit 40 hex")
print("\n".join(bad))
PYEOF
)"
  if [ -n "$dep_out" ]; then echo "$dep_out"; rc=1; fi

  # ── Vế 2: blueprint. `aiken.toml` chỉ giữ được semver (phép kiểm của aiken là
  #    semver, "+42babe5" không phải semver) nên vế 1 KHÔNG phân biệt được hai bản
  #    aiken cùng nhãn v1.1.21 dựng từ hai commit khác nhau. `plutus.json` thì ghi
  #    ĐỦ hậu tố — dùng nó chặn nốt ca đó.
  bp="$(dirname "$f")/plutus.json"
  [ -f "$bp" ] || continue
  bpv="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['preamble'].get('compiler',{}).get('version',''))" "$bp" 2>/dev/null)"
  if [ -z "$bpv" ]; then
    echo "  ⚠ blueprint không khai compiler: $bp"; continue
  fi
  if [ "$bpv" != "$full" ]; then
    echo "  LỆCH BẢN DỰNG  $bp dựng bằng $bpv · máy đang chạy $full"; rc=1
  fi
done < <(find . -name aiken.toml \
           -not -path '*/build/*' \
           -not -path '*/Legacy/*' \
           -not -path './.claude/*' \
           -not -path '*/node_modules/*' | sort)

# `plutus.json` KHÔNG được version-control (.gitignore) ⇒ vế 2 chỉ chứng minh được
# "lần dựng này khớp lần dựng trước", KHÔNG chứng minh "script đang chạy trên chuỗi
# dựng bằng bản nào". Muốn có vế đó thì phải ghi chuỗi ĐỦ HẬU TỐ vào scripts/DEPLOYED.md
# ngay lúc deploy — xem mục "Bản dựng" ở tệp đó.
if [ $rc -eq 0 ]; then
  echo "→ toàn bộ project khớp aiken $full"
else
  echo "→ KHÔNG dựng lại được byte đã deploy bằng bản aiken này."
fi
exit $rc
