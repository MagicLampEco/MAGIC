#!/usr/bin/env bash
# verify.sh — chạy ĐÚNG cổng của `.github/workflows/pr-verify.yml`, ở máy này.
#
#   bash verify.sh                 # bám diff so với origin/main
#   bash verify.sh origin/develop  # bám diff so với ref khác
#   VERIFY_ALL=1 bash verify.sh    # bỏ qua dò phạm vi, chạy TẤT
#
# ── VÌ SAO TỆP NÀY TỒN TẠI ──────────────────────────────────────────────────
# Kho này là repo RIÊNG TƯ, nên phút GitHub Actions bị tính tiền (repo công khai
# thì runner tiêu chuẩn miễn phí, đó là khác biệt duy nhất). Tài khoản đang bị
# chặn, và chặn ở mức job KHÔNG KHỞI ĐỘNG: đo trên run 33185142631, job đầu tiên
# "Dò phạm vi PR" trả về `0 steps`, annotation nguyên văn:
#     "The job was not started because recent account payments have failed or your
#      spending limit needs to be increased."
# Nghĩa là cổng CI hiện KHÔNG chạy gì cả — nó không phải "đỏ vì mã", nó là "không
# tồn tại". Một cổng không chạy mà vẫn hiện dấu đỏ là thứ dạy người ta bỏ qua dấu đỏ.
#
# Cổng này KHÔNG chép lại luật dò phạm vi: nó gọi thẳng
# `.github/scripts/detect_scope.py` ở chế độ LOCAL_BASE — cùng một bộ dò với CI. Hai
# bộ dò là hai cổng khác nhau đội lốt một.
#
# Cái nó KHÔNG thay được: CI chạy trên checkout SẠCH, máy khác, `npm ci` từ đầu. Nên
# nó vẫn bắt được lỗi "chạy được ở máy tôi" mà cổng này bỏ qua. Xanh ở đây là điều
# kiện CẦN để đẩy, không phải điều kiện đủ để coi là đã qua CI.
set -uo pipefail
cd "$(dirname "$0")"

BASE="${1:-origin/main}"
FAILED=()
PASSED=()

if [ "${VERIFY_ALL:-0}" = "1" ]; then
  echo "▶ Chạy TẤT (VERIFY_ALL=1) — bỏ qua dò phạm vi."
  SCOPE="$(LOCAL_BASE=$(git rev-list --max-parents=0 HEAD | tail -1) python3 .github/scripts/detect_scope.py)" || {
    echo "✗ dò phạm vi hỏng"; exit 1; }
else
  echo "▶ Dò phạm vi theo diff $BASE...HEAD (cùng bộ dò với CI)…"
  SCOPE="$(LOCAL_BASE="$BASE" python3 .github/scripts/detect_scope.py)" || {
    echo "✗ dò phạm vi hỏng"; exit 1; }
fi

read_list() { printf '%s\n' "$SCOPE" | grep "^$1=" | cut -d= -f2- | python3 -c 'import json,sys; print("\n".join(json.loads(sys.stdin.read())))'; }
NPM_PKGS="$(read_list SCOPE_NPM)"
AIKEN_PROJECTS="$(read_list SCOPE_AIKEN)"

echo
echo "  gói npm     : $(printf '%s\n' "$NPM_PKGS" | grep -c . || true)"
echo "  project aiken: $(printf '%s\n' "$AIKEN_PROJECTS" | grep -c . || true)"

# ── npm ─────────────────────────────────────────────────────────────────────
# `npm ci` cố ý KHÔNG chạy ở đây: CI dựng từ checkout sạch, còn ở máy thì `npm ci`
# xoá node_modules của mọi gói mỗi lượt và biến cổng 2 phút thành cổng 20 phút.
# Đổi phụ thuộc thì tự chạy `npm install` trước — cổng này kiểm MÃ, không kiểm cài đặt.
for pkg in $NPM_PKGS; do
  [ -d "$pkg" ] || continue
  echo; echo "── npm · $pkg ──"
  ( cd "$pkg" && npm run typecheck --if-present && npm test --if-present ) \
    && PASSED+=("npm:$pkg") || FAILED+=("npm:$pkg")
done

# ── aiken ───────────────────────────────────────────────────────────────────
if command -v aiken >/dev/null 2>&1; then
  for proj in $AIKEN_PROJECTS; do
    [ -d "$proj" ] || continue
    echo; echo "── aiken · $proj ──"
    # `aiken check` qua pipe in JSON ĐẦY ĐỦ (BOUNDARIES.md §4) — hàng nghìn dòng mỗi
    # project. Giữ lại, chỉ in khi ĐỎ.
    # 🔴 Và khi đỏ thì in NGUYÊN output thô, KHÔNG phân tích JSON: có ca `aiken check`
    #    thoát 1 mà toàn bộ output là 42 byte không chứa dấu `{` (hằng hex LẺ ký tự).
    #    Phân tích JSON ở đó ném lỗi của trình phân tích và trỏ người đọc đi chỗ khác.
    OUT_AIKEN="$( cd "$proj" && aiken check 2>&1 )"
    if [ $? -eq 0 ]; then
      NCHK="$(printf '%s' "$OUT_AIKEN" | grep -oE '"status": "(pass|fail)"' | wc -l | tr -d ' ')"
      echo "  ✓ $NCHK checks"
      PASSED+=("aiken:$proj")
    else
      printf '%s\n' "$OUT_AIKEN"
      FAILED+=("aiken:$proj")
    fi
  done
else
  echo; echo "⚠ không thấy lệnh `aiken` — BỎ QUA toàn bộ phần on-chain."
  echo "  Đây là BỎ SÓT, không phải xanh. Cài aiken ≥ 1.1.0 rồi chạy lại."
  FAILED+=("aiken:KHÔNG-CHẠY-ĐƯỢC")
fi

echo
echo "════════════════════════════════════════"
printf '  xanh : %s\n' "${#PASSED[@]}"
printf '  đỏ   : %s\n' "${#FAILED[@]}"
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf '    ✗ %s\n' "${FAILED[@]}"
  exit 1
fi
echo "  ✅ Cổng cục bộ XANH. Nhắc: CI chạy trên checkout sạch — cổng này không thay được điều đó."
