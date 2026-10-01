#!/usr/bin/env bash
# scripts/test_run_keeper_state_book.sh — ca cho đường sổ của `run_keeper.sh` (`STATE_BOOK_PATH`).
# Không gọi mạng, không gửi giao dịch: mọi ca dừng TRƯỚC keeper — ở cổng sổ, ở cổng gác nội
# dung sổ, hoặc ở khoá (một khoá còn mới được đặt sẵn trong thư mục tạm).
#
#   bash scripts/test_run_keeper_state_book.sh
#
# Hai lớp:
#   1. `state_book_path_cli.ts` — đường ống tiến trình mà bash dùng để đọc ba cổng của
#      `stateBookPath.ts` (chính ba cổng đã có ca ở `test_state_book_path.ts`).
#   2. `run_keeper.sh` chạy thật tới chỗ dừng. Mỗi ca khẳng định cả câu RIÊNG của lối thoát
#      đó lẫn điều KHÔNG được xảy ra sau nó — câu chung "KHÔNG giao dịch nào được gửi" có ở
#      nhiều lối thoát nên không phân biệt được lối nào.
#
# `run_keeper.sh` chạy cổng `check_datum_shape.ts` trước cổng sổ; cổng đó không qua (thiếu
# `plutus.json`, artifact trôi) thì lớp 2 KHÔNG ĐO ĐƯỢC — báo đúng thế, không tính là đạt.
# Ca "sổ instant theo sổ cụm" cần một sổ thật để chép (`scripts/state.Preprod.sh`); không có
# thì ca đó KHÔNG ĐO ĐƯỢC.
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
skip() { printf '  ? %s → KHÔNG ĐO ĐƯỢC (%s)\n' "$1" "$2"; unmeasured=$((unmeasured + 1)); }

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
out="$(npx tsx state_book_path_cli.ts 2>/dev/null)"; rc=$?
[ "$rc" = 2 ] && [ -z "$out" ] && ok "thiếu tham số mạng → mã 2" || bad "thiếu tham số mạng → mã $rc (mong 2)"

# keeper <nhãn> <STATE_BOOK_PATH> <mã mong đợi> <chuỗi PHẢI có> <chuỗi KHÔNG được có>
# Khoá và sổ instant mặc định luôn ở thư mục tạm (`STATE_DIRECTORY`), kể cả khi mã thoái lui.
keeper() {
  local label="$1" path="$2" want_rc="$3" want="$4" forbid="$5" out rc
  out="$(STATE_BOOK_PATH="$path" STATE_DIRECTORY="$TMP/data" BLOCKFROST_KEY=khong-dung WALLET_SEED=khong-dung \
         KEEPER_DRY_RUN=1 KEEPER_STEPS=price bash ./run_keeper.sh Preprod 2>&1)"; rc=$?
  if printf '%s' "$out" | command grep -q 'CHƯA ĐO ĐƯỢC hình dạng datum\|Artifact đã trôi'; then
    skip "$label" 'cổng check_datum_shape chặn trước cổng sổ'; return
  fi
  if [ "$rc" != "$want_rc" ]; then
    bad "$label → mã $rc (mong $want_rc)"
  elif ! printf '%s' "$out" | command grep -qF -- "$want"; then
    bad "$label → thiếu \"$want\""
  elif printf '%s' "$out" | command grep -qF -- "$forbid"; then
    bad "$label → có \"$forbid\" (lẽ ra đã dừng trước đó)"
  else
    ok "$label → mã $rc, có \"$want\", không có \"$forbid\""; return
  fi
  printf '%s\n' "$out" | tail -5 | sed 's/^/      /'
}

mkdir -p "$TMP/data/.keeper.lock"   # khoá còn mới ⟹ lượt nào đi qua được mọi cổng cũng dừng ở khoá, mã 0

echo "── run_keeper.sh"
keeper 'sổ chỉ định không tồn tại ⟹ nêu đúng đường đó' \
  "$TMP/khong-co/state.Preprod.sh" 1 "Không thấy $TMP/khong-co/state.Preprod.sh" "· price beacon"
keeper 'biến rỗng ⟹ dừng ở cổng sổ, không lùi về sổ mặc định' \
  "" 1 "STATE_BOOK_PATH có mặt nhưng rỗng" "· sổ:"

mkdir -p "$TMP/chan"
printf '%s\n' 'CARP_IDENTITY_NONCANONICAL=1' > "$TMP/chan/state.Preprod.sh"
keeper 'sổ bị cổng gác chặn ⟹ dừng, KHÔNG nạp sổ' \
  "$TMP/chan/state.Preprod.sh" 1 "khai hộ một biến" "· price beacon"

if [ -f "$SCRIPTS_DIR/state.Preprod.sh" ]; then
  mkdir -p "$TMP/c2"
  cp "$SCRIPTS_DIR/state.Preprod.sh" "$TMP/c2/state.Preprod.sh"
  keeper 'sổ cụm hai ⟹ sổ instant nằm cạnh sổ đó, không ở thư mục dữ liệu' \
    "$TMP/c2/state.Preprod.sh" 0 "sổ instant: $TMP/c2/keeper-state.Preprod.json" "sổ instant: $TMP/data/"
else
  skip 'sổ cụm hai ⟹ sổ instant nằm cạnh sổ đó' 'không có scripts/state.Preprod.sh để chép'
fi

if [ "$failures" -gt 0 ]; then
  echo "=== HỎNG: $failures ca sai ==="; exit 1
elif [ "$unmeasured" -gt 0 ]; then
  echo "=== KHÔNG ĐO ĐƯỢC: $unmeasured ca — các ca còn lại đạt ==="; exit 2
fi
echo "=== ĐẠT ==="
