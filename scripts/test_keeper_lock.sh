#!/usr/bin/env bash
# test_keeper_lock.sh — ca ĐỐI XỨNG cho `keeper_lock.sh`.
#
# Cặp ca quyết định là "khoá đang có" ↔ "thư mục chứa khoá không ghi được": bản cũ trả cùng một
# kết quả (bỏ qua, thoát 0) cho cả hai, nên một bộ chỉ có ca đầu sẽ xanh trên cả bản cũ lẫn bản mới.
#
#   bash test_keeper_lock.sh
#
# Dòng cuối nói ra trạng thái: ĐẠT · HỎNG · KHÔNG ĐO ĐƯỢC. Đừng đọc mã thoát thay cho nó.
set -uo pipefail
cd "$(dirname "$0")"
. "./keeper_lock.sh"

TMP="$(mktemp -d)"
trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
failures=0
unmeasured=0

# expect_lock <mã mong đợi> <nhãn> <thư mục>
expect_lock() {
  local want="$1" label="$2" dir="$3" got
  acquire_keeper_lock "$dir" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then
    printf '  ✓ %-58s → %s\n' "$label" "$got"
  else
    printf '  ✗ %-58s → %s (mong %s)\n' "$label" "$got" "$want"
    failures=$((failures + 1))
  fi
}

echo "── lấy được khoá"
mkdir "$TMP/fresh"
expect_lock 0 'thư mục trống, ghi được'                      "$TMP/fresh"
[ -d "$TMP/fresh/.keeper.lock" ] || { echo '  ✗ trả 0 mà không có thư mục khoá'; failures=$((failures + 1)); }

echo "── lượt khác đang giữ ↔ không ghi được (cặp quyết định)"
mkdir -p "$TMP/held/.keeper.lock"
expect_lock 3 'khoá đang có, còn mới'                        "$TMP/held"
if [ "$(id -u)" = 0 ]; then
  echo '  ? thư mục không ghi được — KHÔNG ĐO ĐƯỢC: chạy dưới root, chmod không chặn được mkdir'
  unmeasured=$((unmeasured + 1))
else
  mkdir "$TMP/readonly"
  chmod 555 "$TMP/readonly"
  expect_lock 1 'thư mục không ghi được, khoá KHÔNG tồn tại' "$TMP/readonly"
fi
expect_lock 1 'thư mục chứa khoá không tồn tại'              "$TMP/missing"

echo "── khoá cũ"
mkdir -p "$TMP/stale/.keeper.lock"
touch -t 202001010000 "$TMP/stale/.keeper.lock"
expect_lock 0 'khoá cũ hơn ngưỡng — gỡ và lấy lại'           "$TMP/stale"
if [ -n "$(find "$TMP/stale/.keeper.lock" -maxdepth 0 -mmin +"$KEEPER_LOCK_STALE_MINUTES" 2>/dev/null)" ]; then
  echo '  ✗ khoá lấy lại vẫn mang mốc cũ — nó không được tạo mới'
  failures=$((failures + 1))
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "=== HỎNG: $failures ca sai ==="
  exit 1
elif [ "$unmeasured" -gt 0 ]; then
  echo "=== KHÔNG ĐO ĐƯỢC: $unmeasured ca không chạy được trên máy này — không phải ĐẠT ==="
  exit 2
fi
echo "=== ĐẠT ==="
