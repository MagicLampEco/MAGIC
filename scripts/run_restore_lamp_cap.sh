#!/usr/bin/env bash
# scripts/run_restore_lamp_cap.sh — đưa tLAMP testnet VỀ ĐÚNG TRẦN sau một lần đúc thừa.
#
# 🔴 SỬA SAI VẬN HÀNH TESTNET, KHÔNG PHẢI CƠ CHẾ GIẢM CUNG. LAMP KHÔNG BURN — giảm lưu
#    hành trên mainnet là CHUYỂN VÀO TREASURY (LAMP/Treasury/CONTRACT.md §5).
#
#   bash run_restore_lamp_cap.sh Preprod          # xem số, KHÔNG đốt
#   bash run_restore_lamp_cap.sh Preprod --dot    # đốt thật
#
# Chạy tại Terminal của anh (cổng máy chặn agent đọc seed).
# Không có `--dot` thì kịch bản dừng ở cổng xác nhận và chỉ IN ra con số đo từ chuỗi —
# đó là chế độ mặc định, có chủ ý: nhìn số trước, đốt sau.
set -euo pipefail

NET="${1:-Preprod}"
DOT="${2:-}"
case "$NET" in
  Preview|Preprod) ;;
  *) echo "✗ Tham số 1 phải là Preview hoặc Preprod (nhận: $NET)"; exit 2 ;;
esac
# Cổng này DỪNG kịch bản trước khi nó chạm vào bất cứ thứ gì. Thông điệp phải nói được
# người đọc PHẢI LÀM GÌ — bản cũ chỉ nói "chưa set", và một lượt chạy chết ở đây không để
# lại dấu vết nào trên chuỗi, nên nó đọc y hệt một lượt chạy đã xong.
#
# Kịch bản nhận GIÁ TRỊ qua môi trường và KHÔNG biết chúng được cất ở đâu. Đó là ràng buộc
# cố ý, không phải chỗ còn thiếu. Một tệp mã biết đường tới kho khoá là một tệp CHỈ ĐƯỜNG,
# và nó chỉ đường cho cả người không nên biết — kể cả khi nó không in ra giá trị nào.
: "${BLOCKFROST_KEY:?
  ✗ BLOCKFROST_KEY chưa có trong môi trường. Kịch bản DỪNG — KHÔNG có gì được thực hiện,
    KHÔNG giao dịch nào được gửi. Đừng đọc lần chạy này thành \'đã chạy rồi\'.

    Đặt giá trị ngay trước lệnh, để bí mật sống trong đúng một tiến trình và không đi qua
    tệp nào:
        BLOCKFROST_KEY=… WALLET_SEED=\'…\' bash run_restore_lamp_cap.sh Preprod

    Khoá phải đúng mạng đang chạy. Khoá của mạng khác vẫn là chuỗi hợp lệ và vẫn gọi được
    — nó chỉ trả về dữ liệu của mạng kia, và không có gì kêu lên.
}"
: "${WALLET_SEED:?
  ✗ WALLET_SEED chưa có trong môi trường. Kịch bản DỪNG — KHÔNG giao dịch nào được gửi.
}"
cd "$(dirname "$0")"

export NETWORK="$NET" BLOCKFROST_KEY WALLET_SEED

if [ "$DOT" = "--dot" ]; then
  export LAMP_BURN_CONFIRM="$NET"
  echo "▶ CHẾ ĐỘ ĐỐT THẬT trên $NET."
else
  echo "▶ Chế độ XEM SỐ (không đốt). Thêm --dot để đốt thật."
fi

npx tsx deploy/01b_restore_lamp_cap.ts
