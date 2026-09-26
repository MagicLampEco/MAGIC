#!/usr/bin/env bash
# test_state_book_guard.sh — ca ĐỐI XỨNG cho `state_book_guard.sh`.
#
# Đối xứng nghĩa là mỗi ca có một ca song sinh chỉ khác MỘT biến: cùng một tệp sổ,
# chỉ khác đúng dòng đang được gác. Một bộ chỉ toàn ca-phải-chặn không phân biệt được
# "cổng gác đúng thứ" với "cổng chặn mọi thứ".
#
#   bash test_state_book_guard.sh
set -uo pipefail
cd "$(dirname "$0")"
. "./state_book_guard.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
sai=0

# chay <mong đợi: chan|dat> <nhãn> <nội dung sổ>
chay() {
  local mong="$1" nhan="$2" noi_dung="$3"
  local so="$TMP/state.Test.sh"
  printf '%s\n' "$noi_dung" > "$so"
  local ket_qua
  if assert_state_books_khong_khai_y_dinh "$so" >/dev/null 2>&1; then
    ket_qua=dat
  else
    ket_qua=chan
  fi
  if [ "$ket_qua" = "$mong" ]; then
    printf '  ✓ %-52s → %s\n' "$nhan" "$ket_qua"
  else
    printf '  ✗ %-52s → %s (mong %s)\n' "$nhan" "$ket_qua" "$mong"
    sai=$((sai + 1))
  fi
}

echo "── phải CHẶN: sổ khai hộ một biến ý định"
chay chan 'CARP_IDENTITY_NONCANONICAL=1'      'CARP_IDENTITY_NONCANONICAL=1'
chay chan 'LAMP_ASSET_NAME_NONCANONICAL=1'    'LAMP_ASSET_NAME_NONCANONICAL=1'
chay chan 'CARP_POLICY_ID=<28 byte>'          'CARP_POLICY_ID=4967df00c7e038fc7ce2abdc1e6d4c946342ffa905e059ab861dffc2'
chay chan 'CARP_ASSET_NAME=<28 byte>'         'CARP_ASSET_NAME=30cb6a6b6a1c9746bf9eb081d914d96ede4c4c13e661404678a933a6'
chay chan 'có tiền tố export'                 'export CARP_IDENTITY_NONCANONICAL=1'
chay chan 'thụt đầu dòng'                     '    CARP_IDENTITY_NONCANONICAL=1'
chay chan 'lẫn giữa các dòng hợp lệ'          'LAMP_POLICY_ID=8169b76c
CARP_ASSET_NAME=30cb6a6b
VAULT_PREPAID_TX=b5168165'

echo "── phải ĐẠT: sổ chỉ chứa dữ liệu deploy"
# Ca song sinh của ca trên, khác đúng một dòng.
chay dat  'cùng sổ đó, gỡ dòng CARP_ASSET_NAME'  'LAMP_POLICY_ID=8169b76c
VAULT_PREPAID_TX=b5168165'
chay dat  'LAMP_POLICY_ID (hàng hoá hợp lệ)'     'LAMP_POLICY_ID=8169b76cbb75b2fe2bd39d2b17e59d0a4e2d0a7a0d5f2b0e0a0b0c0d'
chay dat  'sổ rỗng'                              ''
chay dat  'tên chỉ CHỨA chuỗi bị gác'            'MY_CARP_POLICY_ID_BACKUP=deadbeef'
chay dat  'nằm trong một dòng chú thích'         '# CARP_POLICY_ID=… (ghi chú, không phải gán)'
chay dat  'nằm bên phải dấu bằng'                'GHI_CHU="xem CARP_POLICY_ID trong config.ts"'

echo "── phải CHẶN: nhóm (b) — tên KHÔNG có phép kiểm nào đứng sau"
chay chan 'BUFFER_BPS (nướng vào datum quỹ, bất biến)'  'BUFFER_BPS=500'
chay chan 'PLATFORM_PKH (khoá duy nhất claim CARP)'     'PLATFORM_PKH=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
chay chan 'BENEFICIARY_ADDRESS (đích claim, bất biến)'  'BENEFICIARY_ADDRESS=addr_test1vxxx'
chay chan 'BENEFICIARY_DATUM (datum đích, bất biến)'    'BENEFICIARY_DATUM=none'
chay chan 'WALLET_SEED (đổi ví ký)'                     'WALLET_SEED=xxx'
chay chan 'BLOCKFROST_KEY (đổi nhà cung cấp dữ liệu)'   'BLOCKFROST_KEY=xxx'

echo "── phải CHẶN: KHÔNG ĐO ĐƯỢC ≠ sổ sạch"
# Ca này ghim chỗ `|| true` từng nuốt mã thoát ≥2 của grep. Sổ CÓ MẶT nhưng không
# đọc được: bản cũ trả ĐẠT, tức trả lời "sạch" cho một câu nó không đọc nổi.
KHONG_DOC="$TMP/state.Cam.sh"
printf 'LAMP_POLICY_ID=8169b76c\n' > "$KHONG_DOC"
chmod 000 "$KHONG_DOC"
if [ -r "$KHONG_DOC" ]; then
  # Chạy dưới quyền root thì chmod không chặn được — ca này KHÔNG đo được gì, và
  # nói thẳng ra còn hơn in một dấu ✓ rỗng nghĩa.
  printf '  ⚠ %-52s → BỎ QUA (đang chạy với quyền đọc mọi tệp)\n' 'sổ có mặt mà không đọc được'
else
  if assert_state_books_khong_khai_y_dinh "$KHONG_DOC" >/dev/null 2>&1; then
    printf '  ✗ %-52s → dat (mong chan)\n' 'sổ có mặt mà không đọc được'
    sai=$((sai + 1))
  else
    printf '  ✓ %-52s → chan\n' 'sổ có mặt mà không đọc được'
  fi
fi
chmod 644 "$KHONG_DOC" 2>/dev/null || true

echo "── phải ĐẠT: cổng KHÔNG in giá trị ra ngoài"
# Hai tên trong danh sách là bí mật. Một cổng in nguyên dòng khớp là đường rò mang
# mặt nạ cổng, nên ca này ghim: thông điệp chặn phải có TÊN, không có giá trị.
SO_BI_MAT="$TMP/state.BiMat.sh"
printf 'WALLET_SEED=dung-bao-gio-in-chuoi-nay\n' > "$SO_BI_MAT"
THONG_DIEP=$(assert_state_books_khong_khai_y_dinh "$SO_BI_MAT" 2>&1 || true)
if printf '%s' "$THONG_DIEP" | grep -q 'dung-bao-gio-in-chuoi-nay'; then
  printf '  ✗ %-52s → giá trị BỊ IN RA\n' 'thông điệp chặn không mang giá trị'
  sai=$((sai + 1))
elif printf '%s' "$THONG_DIEP" | grep -q 'WALLET_SEED'; then
  printf '  ✓ %-52s → có TÊN, không có giá trị\n' 'thông điệp chặn không mang giá trị'
else
  printf '  ✗ %-52s → mất cả TÊN, người bị chặn không tra được\n' 'thông điệp chặn không mang giá trị'
  sai=$((sai + 1))
fi

echo "── phải ĐẠT: DÂY NỐI runner↔cổng"
# Ca này tồn tại vì một phép đột biến: gỡ lời gọi cổng khỏi một runner thì mọi ca
# phía trên VẪN XANH — chúng ghim cái HÀM, không ghim chỗ hàm được dùng. Một cổng
# đúng mà không ai gọi thì độ phủ của nó bằng không.
ho_day_noi=0
for r in run_*.sh; do
  grep -q 'set -a' "$r" || continue
  if ! grep -q 'assert_state_books_khong_khai_y_dinh' "$r"; then
    printf '  ✗ %-52s → nạp sổ bằng `set -a` mà KHÔNG gác\n' "$r"
    ho_day_noi=$((ho_day_noi + 1))
  fi
done
if [ "$ho_day_noi" -eq 0 ]; then
  printf '  ✓ %-52s → 0 lỗ\n' 'mọi runner có `set -a` đều gọi cổng'
else
  sai=$((sai + ho_day_noi))
fi

echo "── phải ĐẠT: sổ vắng mặt không phải lỗi"
if assert_state_books_khong_khai_y_dinh "$TMP/khong-ton-tai.sh" >/dev/null 2>&1; then
  echo "  ✓ sổ chưa có trên đĩa                                 → dat"
else
  echo "  ✗ sổ chưa có trên đĩa                                 → chan (mong dat)"
  sai=$((sai + 1))
fi

echo
if [ "$sai" -eq 0 ]; then
  echo "sai 0 — bộ ca đạt."
else
  echo "sai $sai — bộ ca ĐỎ."
  exit 1
fi
