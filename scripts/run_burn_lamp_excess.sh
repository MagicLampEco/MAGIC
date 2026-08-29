#!/usr/bin/env bash
# scripts/run_burn_lamp_excess.sh — đốt phần tLAMP đúc VƯỢT TRẦN trên testnet.
#
#   bash run_burn_lamp_excess.sh Preprod          # xem số, KHÔNG đốt
#   bash run_burn_lamp_excess.sh Preprod --dot    # đốt thật
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
: "${AGENT_SECRETS:?✗ AGENT_SECRETS chưa set}"
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

npx tsx deploy/01b_burn_lamp_excess.ts
