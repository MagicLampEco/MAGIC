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
  Preview) BF_VAR="Blockfrost_GreenSun_Preview" ;;
  Preprod) BF_VAR="Blockfrost_Aladin_Preprod" ;;
  *) echo "✗ Tham số 1 phải là Preview hoặc Preprod (nhận: $NET)"; exit 2 ;;
esac
# Cổng này DỪNG kịch bản trước khi nó chạm vào bất cứ thứ gì. Thông điệp phải nói được
# người đọc PHẢI LÀM GÌ — bản cũ chỉ nói "chưa set", và một lượt chạy chết ở đây không để
# lại dấu vết nào trên chuỗi, nên nó đọc y hệt một lượt chạy đã xong.
: "${AGENT_SECRETS:?
  ✗ AGENT_SECRETS chưa set. Kịch bản DỪNG — KHÔNG có gì được thực hiện, KHÔNG giao dịch nào
    được gửi. Đừng đọc lần chạy này thành 'đã chạy rồi'.

    Biến này phải trỏ tới tệp kho khoá của CHÍNH MÁY BẠN. Kho mã này cố ý KHÔNG ghi đường
    dẫn đó ở bất cứ đâu, nên nó không thể tự điền hộ.

    Đặt một lần cho mọi phiên terminal:
        echo \'export AGENT_SECRETS=\"đường/dẫn/kho/khoá/của/bạn\"\' >> ~/.zshenv
        source ~/.zshenv
}"
cd "$(dirname "$0")"

echo "▶ Dò biến seed ví deploy…"
SEED_VAR="$(npx tsx detect_deploy_wallet.ts)"
echo "  → biến seed: $SEED_VAR"

export NETWORK="$NET"
unquote() { sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
export BLOCKFROST_KEY="$(grep "^${BF_VAR}=" "$AGENT_SECRETS" | cut -d= -f2- | unquote)"
export WALLET_SEED="$(grep "^${SEED_VAR}=" "$AGENT_SECRETS" | cut -d= -f2- | unquote)"
[ -n "${BLOCKFROST_KEY:-}" ] || { echo "✗ không lấy được $BF_VAR"; exit 1; }
[ -n "${WALLET_SEED:-}" ]    || { echo "✗ không lấy được seed $SEED_VAR"; exit 1; }

if [ "$DOT" = "--dot" ]; then
  export LAMP_BURN_CONFIRM="$NET"
  echo "▶ CHẾ ĐỘ ĐỐT THẬT trên $NET."
else
  echo "▶ Chế độ XEM SỐ (không đốt). Thêm --dot để đốt thật."
fi

npx tsx deploy/01b_restore_lamp_cap.ts
