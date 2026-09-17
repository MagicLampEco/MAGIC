#!/usr/bin/env bash
# scripts/run_keeper.sh — chạy keeper testnet một lượt: làm mới beacon, bắn lịch ScheduleGen tới hạn,
# và (tuỳ chọn) cấp một lượt InstantGen. Chi tiết từng bước: keeper/keeper.ts.
#
#   BLOCKFROST_KEY=… WALLET_SEED='…' bash run_keeper.sh Preprod
#   KEEPER_STEPS=backing,price,fire,instant BLOCKFROST_KEY=… WALLET_SEED='…' bash run_keeper.sh Preprod
#   KEEPER_DRY_RUN=1 BLOCKFROST_KEY=… WALLET_SEED='…' bash run_keeper.sh Preprod
#
# Chạy lại bao nhiêu lần trong ngày cũng được: bước nào đã đúng epoch thì bỏ qua. Nên hẹn giờ mỗi
# giờ an toàn hơn hẹn đúng một lần sau nửa đêm UTC — một lượt trượt vì mạng thì lượt sau bù.
#
# Danh sách price beacon lấy từ KEEPER_PRICE_BEACONS (`<price_nft_policy>:<price_param_hash>`,
# phẩy). Không đặt thì dùng cặp PRICE_NFT_POLICY:PRICE_PARAM_HASH của state file.
#
# Bí mật đi vào bằng GIÁ TRỊ qua môi trường. Kịch bản không biết chúng được cất ở đâu.
set -uo pipefail

NET="${1:-Preprod}"
case "$NET" in
  Preview|Preprod) ;;
  *) echo "✗ Tham số 1 phải là Preview hoặc Preprod (nhận: $NET). Keeper không chạy trên Mainnet."; exit 2 ;;
esac
: "${BLOCKFROST_KEY:?✗ BLOCKFROST_KEY chưa có trong môi trường. Keeper DỪNG — KHÔNG giao dịch nào được gửi.}"
: "${WALLET_SEED:?✗ WALLET_SEED chưa có trong môi trường. Keeper DỪNG — KHÔNG giao dịch nào được gửi.}"
cd "$(dirname "$0")"

STATE_FILE="state.$NET.sh"
[ -f "$STATE_FILE" ] || { echo "✗ Không thấy $STATE_FILE — keeper cần hash/ref đã deploy."; exit 1; }
# Giữ giá trị người gọi đặt: state file nạp SAU sẽ đè im lặng nếu không cất trước.
CALLER_BEACONS="${KEEPER_PRICE_BEACONS:-}"
set -a; . "./$STATE_FILE"; set +a
if [ -n "$CALLER_BEACONS" ]; then
  KEEPER_PRICE_BEACONS="$CALLER_BEACONS"
elif [ -z "${KEEPER_PRICE_BEACONS:-}" ] && [ -n "${PRICE_NFT_POLICY:-}" ] && [ -n "${PRICE_PARAM_HASH:-}" ]; then
  KEEPER_PRICE_BEACONS="$PRICE_NFT_POLICY:$PRICE_PARAM_HASH"
fi

export NETWORK="$NET" BLOCKFROST_KEY WALLET_SEED KEEPER_PRICE_BEACONS
echo "▶ keeper · NETWORK=$NET · $(date -u +%FT%TZ) · secret đã nhận từ môi trường (không in)."

npx tsx keeper/keeper.ts
RC=$?
case $RC in
  0) echo "✅ keeper xong." ;;
  2) echo "⚠ keeper: có tx đã gửi mà chưa đọc lại được — soi explorer trước khi chạy lại." ;;
  *) echo "✗ keeper có bước hỏng (mã $RC) — đọc dòng ✗ ở trên." ;;
esac
exit $RC
