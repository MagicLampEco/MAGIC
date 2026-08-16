#!/usr/bin/env bash
# scripts/run_schedule_fire.sh — bắn MỘT lịch ĐÃ cam kết, không dựng vault mới.
#
#   bash run_schedule_fire.sh Preview <VAULT_TX_HASH>
#   bash run_schedule_fire.sh Preprod <VAULT_TX_HASH>
#
# Vì sao tách khỏi `run_wakeme_e2e.sh`: bản kia chạy TRỌN chuỗi 00→…→instant và
# **tạo vault mới mỗi lần**. Đo trên Preview 2026-08-16: đang có 5 UTxO vault
# ScheduleGen cùng chủ, mỗi cái giữ 1001 tLAMP + NFT định danh riêng — tức 5005
# tLAMP nằm chết vì mỗi lần nghiệm thu lại đẻ thêm một vault. Muốn bắn cái lịch
# đã cam kết thì phải GHIM vault, chứ không chạy lại cả chuỗi.
#
# `VAULT_TX_HASH` bắt buộc, chính vì lý do trên: bỏ trống thì
# `test/schedule_fire_only.ts` dò theo owner-pkh, mà 5 vault cùng owner ⟹ nó
# bắn nhầm cái không có lịch, hoặc rơi vào nhánh đoán ở lần thử thứ 5.
#
# Secret chỉ lấy value từ $AGENT_SECRETS, không in ra.
set -uo pipefail

NET="${1:-Preview}"
VAULT_TX="${2:-${VAULT_TX_HASH:-}}"
case "$NET" in
  Preview) BF_VAR="Blockfrost_GreenSun_Preview" ;;
  Preprod) BF_VAR="Blockfrost_Aladin_Preprod" ;;
  *) echo "✗ Tham số 1 phải là Preview hoặc Preprod (nhận: $NET)"; exit 2 ;;
esac
[ -n "$VAULT_TX" ] || {
  echo "✗ Thiếu VAULT_TX_HASH. Dùng: bash run_schedule_fire.sh $NET <tx-hash-cua-ScheduleCommit>"
  echo "  Tx commit gần nhất ghi ở scripts/DEPLOYED.md."
  exit 2
}
: "${AGENT_SECRETS:?✗ AGENT_SECRETS chưa set}"
cd "$(dirname "$0")"

STATE_FILE="state.$NET.sh"
[ -f "$STATE_FILE" ] || { echo "✗ Không thấy $STATE_FILE — chạy run_wakeme_e2e.sh một lần để dựng prereq."; exit 1; }
set -a; . "./$STATE_FILE"; set +a

# Script tham chiếu CIP-33 là BẮT BUỘC: đính kèm cả vault + shard làm tx vượt
# trần 16384 byte (đo thật 17303). Nạp từ env hoặc từ state file.
: "${REF_VAULT_SCHEDULE_UTXO:?✗ thiếu REF_VAULT_SCHEDULE_UTXO (xem scripts/DEPLOYED.md)}"
: "${REF_SHARD_UTXO:?✗ thiếu REF_SHARD_UTXO (xem scripts/DEPLOYED.md)}"
export REF_VAULT_SCHEDULE_UTXO REF_SHARD_UTXO

SEED_VAR="$(npx tsx detect_deploy_wallet.ts)"
export NETWORK="$NET" VAULT_TX_HASH="$VAULT_TX"
unquote() { sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
export BLOCKFROST_KEY="$(grep "^${BF_VAR}=" "$AGENT_SECRETS" | cut -d= -f2- | unquote)"
export WALLET_SEED="$(grep "^${SEED_VAR}=" "$AGENT_SECRETS" | cut -d= -f2- | unquote)"
[ -n "${BLOCKFROST_KEY:-}" ] || { echo "✗ không lấy được $BF_VAR"; exit 1; }
[ -n "${WALLET_SEED:-}" ]    || { echo "✗ không lấy được seed $SEED_VAR"; exit 1; }
echo "▶ NETWORK=$NET · ví=$SEED_VAR · vault ghim=${VAULT_TX:0:16}… · secret đã nạp (không in)."

npx tsx test/schedule_fire_only.ts
RC=$?
echo
[ $RC -eq 0 ] && echo "✅ ScheduleFire xong — chép tx hash vào scripts/DEPLOYED.md." \
              || echo "✗ ScheduleFire hỏng (mã $RC) — đọc lý do ở trên, đừng chạy lại mù."
exit $RC
