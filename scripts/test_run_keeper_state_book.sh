#!/usr/bin/env bash
# scripts/test_run_keeper_state_book.sh — ca cho đường sổ của `run_keeper.sh` (`STATE_BOOK_PATH`).
# Không gọi mạng, không gửi giao dịch: mọi ca dừng ở cổng sổ, TRƯỚC khoá và trước keeper.
#
#   bash scripts/test_run_keeper_state_book.sh
#
# Hai lớp:
#   1. `state_book_path_cli.ts` — bash đọc ba cổng của `stateBookPath.ts` qua tệp này.
#   2. `run_keeper.sh` chạy thật tới cổng sổ. Ca phân biệt: sổ chỉ định KHÔNG tồn tại ⟹ câu lỗi
#      phải nêu đúng đường đó. Bản bỏ qua biến sẽ mở sổ mặc định và đi tiếp, nên ca này đỏ ở bản đó.
#
# `run_keeper.sh` chạy cổng `check_datum_shape.ts` trước cổng sổ; cổng đó không qua (thiếu
# `plutus.json`, artifact trôi) thì lớp 2 KHÔNG ĐO ĐƯỢC — báo đúng thế, không tính là đạt.
#
# Dòng cuối nói ra trạng thái: ĐẠT · HỎNG · KHÔNG ĐO ĐƯỢC. Đừng đọc mã thoát thay cho nó.
set -uo pipefail
cd "$(dirname "$0")"
SCRIPTS_DIR="$(pwd -P)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
failures=0
unmeasured=0

ok()  { printf '  ✓ %s\n' "$1"; }
bad() { printf '  ✗ %s\n' "$1"; failures=$((failures + 1)); }

# cli <nhãn> <mã mong đợi> <stdout mong đợi | -> [giá trị STATE_BOOK_PATH | không có đối số = vắng biến]
cli() {
  local label="$1" want_rc="$2" want_out="$3" out rc
  if [ "$#" -ge 4 ]; then
    out="$(STATE_BOOK_PATH="$4" npx tsx state_book_path_cli.ts Preprod 2>/dev/null)"; rc=$?
  else
    out="$(env -u STATE_BOOK_PATH npx tsx state_book_path_cli.ts Preprod 2>/dev/null)"; rc=$?
  fi
  if [ "$rc" != "$want_rc" ]; then bad "$label → mã $rc (mong $want_rc)"; return; fi
  if [ "$want_out" != "-" ] && [ "$out" != "$want_out" ]; then bad "$label → \"$out\" (mong \"$want_out\")"; return; fi
  ok "$label → mã $rc"
}

echo "── state_book_path_cli.ts"
cli 'vắng biến ⟹ scripts/state.Preprod.sh'                 0 "$SCRIPTS_DIR/state.Preprod.sh"
cli 'biến tuyệt đối, đúng tên ⟹ đúng biến'                 0 "$TMP/v2/state.Preprod.sh" "$TMP/v2/state.Preprod.sh"
cli 'biến rỗng ⟹ dừng'                                     1 - ""
cli 'đường tương đối ⟹ dừng'                               1 - "v2/state.Preprod.sh"
cli 'tên sổ của mạng khác ⟹ dừng'                          1 - "$TMP/v2/state.Preview.sh"

# keeper <nhãn> <giá trị STATE_BOOK_PATH> <chuỗi phải có trong output>
keeper() {
  local label="$1" path="$2" want="$3" out rc
  out="$(STATE_BOOK_PATH="$path" BLOCKFROST_KEY=khong-dung WALLET_SEED=khong-dung KEEPER_DRY_RUN=1 \
         KEEPER_STEPS=price bash ./run_keeper.sh Preprod 2>&1)"; rc=$?
  if printf '%s' "$out" | command grep -q 'CHƯA ĐO ĐƯỢC hình dạng datum\|Artifact đã trôi'; then
    printf '  ? %s → KHÔNG ĐO ĐƯỢC (cổng check_datum_shape chặn trước cổng sổ)\n' "$label"
    unmeasured=$((unmeasured + 1)); return
  fi
  if [ "$rc" = 1 ] && printf '%s' "$out" | command grep -qF -- "$want"; then
    ok "$label → mã 1, nêu \"$want\""
  else
    bad "$label → mã $rc, thiếu \"$want\""
    printf '%s\n' "$out" | tail -5 | sed 's/^/      /'
  fi
}

echo "── run_keeper.sh (dừng ở cổng sổ)"
keeper 'sổ chỉ định không tồn tại ⟹ nêu đúng đường đó' "$TMP/khong-co/state.Preprod.sh" "Không thấy $TMP/khong-co/state.Preprod.sh"
keeper 'biến rỗng ⟹ dừng, không lùi về sổ mặc định'    ""                               "KHÔNG giao dịch nào được gửi"

if [ "$failures" -gt 0 ]; then
  echo "=== HỎNG: $failures ca sai ==="; exit 1
elif [ "$unmeasured" -gt 0 ]; then
  echo "=== KHÔNG ĐO ĐƯỢC: $unmeasured ca — lớp 1 đạt, lớp 2 chưa chạy tới cổng sổ ==="; exit 2
fi
echo "=== ĐẠT ==="
