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
