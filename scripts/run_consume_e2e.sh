#!/usr/bin/env bash
# scripts/run_consume_e2e.sh — Deploy leg-A (consume) + gen + tiêu MAGIC THẬT e2e.
#
# Chạy tại Terminal của anh (KHÔNG qua Claude — classifier chặn đọc seed):
#   cd /Users/ductiger/Projects/MAGIC/scripts
#   bash run_consume_e2e.sh            # Preview (mặc định)
#   bash run_consume_e2e.sh Preprod    # Preprod
#
# Tự dò biến seed ví deploy trong $AGENT_SECRETS rồi export WALLET_SEED — chỉ DÙNG
# value, KHÔNG in ra. Prereq LAMP/UM/backing nạp tự động qua dotenv từ scripts/.env.
#
# 4 bước, nối env qua stdout của bước trước:
#   [1] 05 deploy vault InstantGen converge → VAULT_INSTANT_HASH
#   [2] test:instant gen MAGIC   ⚠ CHECKPOINT: vault SHUT (BackingBeacon all-zero) sẽ dừng ở đây
#   [3] 09 deploy consume infra (price/engage NFT + beacon + Engage) → export block
#   [4] consume_only tiêu MAGIC thật (co-spend Engage + vault BurnBatch)
set -euo pipefail

NET="${1:-Preview}"
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
export BLOCKFROST_KEY="$(grep "^${BF_VAR}=" "$AGENT_SECRETS" | cut -d= -f2-)"
export WALLET_SEED="$(grep "^${SEED_VAR}=" "$AGENT_SECRETS" | cut -d= -f2-)"
[ -n "${BLOCKFROST_KEY:-}" ] || { echo "✗ không lấy được $BF_VAR"; exit 1; }
[ -n "${WALLET_SEED:-}" ]    || { echo "✗ không lấy được seed $SEED_VAR"; exit 1; }
echo "  → NETWORK=$NET, Blockfrost + seed đã nạp (không in)."

echo; echo "▶ [1/4] Deploy vault InstantGen (converge)…"
OUT05="$(npx tsx deploy/05_create_instant_vault.ts | tee /dev/tty)"
export VAULT_INSTANT_HASH="$(printf '%s\n' "$OUT05" | grep -oE 'VAULT_INSTANT_HASH=[0-9a-f]+' | head -1 | cut -d= -f2- || true)"
[ -n "${VAULT_INSTANT_HASH:-}" ] || { echo "✗ không đọc được VAULT_INSTANT_HASH từ 05 (05 lỗi?)"; exit 1; }
echo "  → VAULT_INSTANT_HASH=$VAULT_INSTANT_HASH"

echo; echo "▶ [2/4] Gen MAGIC (InstantGen)…"
echo "  ⚠ CHECKPOINT: nếu vault SHUT vì BackingBeacon all-zero (CARP chưa ship), bước này DỪNG."
echo "    Khi đó [1] và [3] vẫn là 'leg-A infra deployed'; báo lại em để xử beacon-fixture."
npx tsx test/instant_only.ts | tee /dev/tty

echo; echo "▶ [3/4] Deploy consume infra (price/engage NFT + beacon + Engage)…"
OUT09="$(npx tsx deploy/09_deploy_consume.ts | tee /dev/tty)"
eval "$(printf '%s\n' "$OUT09" | grep '^export ' || true)"
[ -n "${PRICE_BEACON_UTXO:-}" ] || { echo "✗ 09 không in export block (09 lỗi?)"; exit 1; }

echo; echo "▶ [4/4] Tiêu MAGIC thật (co-spend Engage + vault BurnBatch)…"
npx tsx test/consume_only.ts

echo; echo "✅ HOÀN TẤT e2e trên $NET"
