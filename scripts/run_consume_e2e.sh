#!/usr/bin/env bash
# scripts/run_consume_e2e.sh — Deploy leg-A (consume) + gen + tiêu MAGIC THẬT e2e.
#
# Chạy tại Terminal của anh (KHÔNG qua Claude — classifier chặn đọc seed):
#   cd /Users/ductiger/Projects/MAGIC/scripts
#   bash run_consume_e2e.sh            # Preview (mặc định)
#   bash run_consume_e2e.sh Preprod    # Preprod
#
# Secret (Blockfrost + seed) chỉ DÙNG value từ $AGENT_SECRETS, KHÔNG in ra.
#
# PREREQ tự bootstrap theo NETWORK (vá lỗi "Run step 01 first; missing LAMP_POLICY_ID"):
#   - Prereq (LAMP policy, UM policy+hash) là ONE-SHOT / mạng. Lưu vào deployed.$NET.env
#     (đã .gitignore qua *.env). Lần chạy sau tự đọc lại, KHÔNG mint trùng.
#   - Muốn tái dùng bản deploy sẵn: export LAMP_POLICY_ID / UM_NFT_POLICY_ID / UM_DATUM_HASH
#     trước khi chạy, HOẶC điền vào deployed.$NET.env. Có giá trị → bỏ qua bootstrap.
#   - Giá trị export/đọc-file LUÔN thắng dotenv scripts/.env → không lẫn policy giữa 2 mạng.
#
# Các bước:
#   [0a] 01 mint LAMP           → LAMP_POLICY_ID           (bootstrap nếu thiếu)
#   [0b] 02 deploy UM           → UM_NFT_POLICY_ID + UM_DATUM_HASH  (bootstrap nếu thiếu)
#   [1]  05 deploy vault InstantGen converge → VAULT_INSTANT_HASH + REF_VAULT_INSTANT_UTXO
#   [2]  test:instant gen MAGIC ⚠ CHECKPOINT: vault SHUT (BackingBeacon all-zero) sẽ dừng ở đây
#   [3]  09 deploy consume infra (price/engage NFT + beacon + Engage) → export block
#        (kèm REF_CONSUME_UTXO — ref-script consume, 09 tự công bố)
#   [4]  consume_only tiêu MAGIC thật (co-spend Engage + vault BurnBatch)
#
# HAI ref-script ở [1] và [3] là ĐIỀU KIỆN SỐNG của [4], không phải tối ưu: đính kèm
# cả hai validator vào tx consume cho 17.310 byte, vượt trần giao thức 16.384.
set -euo pipefail

NET="${1:-Preview}"
case "$NET" in
  Preview) BF_VAR="Blockfrost_GreenSun_Preview" ;;
  Preprod) BF_VAR="Blockfrost_Aladin_Preprod" ;;
  *) echo "✗ Tham số 1 phải là Preview hoặc Preprod (nhận: $NET)"; exit 2 ;;
esac
: "${AGENT_SECRETS:?✗ AGENT_SECRETS chưa set}"
cd "$(dirname "$0")"

STATE_FILE="deployed.$NET.env"
persist() { printf '%s=%s\n' "$1" "$2" >> "$STATE_FILE"; }

# Đọc lại prereq đã deploy cho ĐÚNG mạng này (nếu có) — export để thắng dotenv.
if [ -f "$STATE_FILE" ]; then
  echo "▶ Đọc prereq đã lưu: $STATE_FILE"
  set -a; . "./$STATE_FILE"; set +a
fi

echo "▶ Dò biến seed ví deploy…"
SEED_VAR="$(npx tsx detect_deploy_wallet.ts)"
echo "  → biến seed: $SEED_VAR"

export NETWORK="$NET"
# Value trong $AGENT_SECRETS có thể được bọc nháy. Không bóc thì dấu nháy đi thẳng
# vào bip39 và chết ở "Invalid mnemonic" — thông báo không hề nhắc tới dấu nháy.
# Hai runner kia (run_schedule_fire, run_wakeme_e2e) đã bóc từ đầu; chỗ này sót.
unquote() { sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
export BLOCKFROST_KEY="$(grep "^${BF_VAR}=" "$AGENT_SECRETS" | cut -d= -f2- | unquote)"
export WALLET_SEED="$(grep "^${SEED_VAR}=" "$AGENT_SECRETS" | cut -d= -f2- | unquote)"
[ -n "${BLOCKFROST_KEY:-}" ] || { echo "✗ không lấy được $BF_VAR"; exit 1; }
[ -n "${WALLET_SEED:-}" ]    || { echo "✗ không lấy được seed $SEED_VAR"; exit 1; }
echo "  → NETWORK=$NET, Blockfrost + seed đã nạp (không in)."

# ── [0a] Prereq: LAMP policy ────────────────────────────────────────────────
if [ -z "${LAMP_POLICY_ID:-}" ]; then
  echo; echo "▶ [0a] Chưa có LAMP_POLICY_ID cho $NET → mint LAMP (01)…"
  OUT01="$(npx tsx deploy/01_mint_lamp.ts | tee /dev/tty)"
  export LAMP_POLICY_ID="$(printf '%s\n' "$OUT01" | grep -oE 'LAMP_POLICY_ID=[0-9a-f]+' | head -1 | cut -d= -f2- || true)"
  [ -n "${LAMP_POLICY_ID:-}" ] || { echo "✗ 01 không in LAMP_POLICY_ID (01 lỗi?)"; exit 1; }
  persist LAMP_POLICY_ID "$LAMP_POLICY_ID"
  echo "  → LAMP_POLICY_ID=$LAMP_POLICY_ID (đã lưu $STATE_FILE)"
else
  echo; echo "▶ [0a] Dùng lại LAMP_POLICY_ID=$LAMP_POLICY_ID"
fi

# ── [0b] Prereq: UM policy + script hash ────────────────────────────────────
if [ -z "${UM_NFT_POLICY_ID:-}" ] || [ -z "${UM_DATUM_HASH:-}" ]; then
  echo; echo "▶ [0b] Chưa đủ UM (policy/hash) cho $NET → deploy UM (02)…"
  OUT02="$(npx tsx deploy/02_deploy_um.ts | tee /dev/tty)"
  export UM_DATUM_HASH="$(printf '%s\n' "$OUT02" | grep -oE 'UM_DATUM_HASH=[0-9a-f]+' | head -1 | cut -d= -f2- || true)"
  export UM_NFT_POLICY_ID="$(printf '%s\n' "$OUT02" | grep -oE 'UM_NFT_POLICY_ID=[0-9a-f]+' | head -1 | cut -d= -f2- || true)"
  { [ -n "${UM_DATUM_HASH:-}" ] && [ -n "${UM_NFT_POLICY_ID:-}" ]; } \
    || { echo "✗ 02 không in UM_DATUM_HASH/UM_NFT_POLICY_ID (02 lỗi?)"; exit 1; }
  persist UM_DATUM_HASH "$UM_DATUM_HASH"
  persist UM_NFT_POLICY_ID "$UM_NFT_POLICY_ID"
  echo "  → UM_NFT_POLICY_ID=$UM_NFT_POLICY_ID · UM_DATUM_HASH=$UM_DATUM_HASH (đã lưu $STATE_FILE)"
else
  echo; echo "▶ [0b] Dùng lại UM_NFT_POLICY_ID=$UM_NFT_POLICY_ID"
fi

echo; echo "▶ [1/4] Deploy vault InstantGen (converge)…"
OUT05="$(npx tsx deploy/05_create_instant_vault.ts | tee /dev/tty)"
export VAULT_INSTANT_HASH="$(printf '%s\n' "$OUT05" | grep -oE 'VAULT_INSTANT_HASH=[0-9a-f]+' | head -1 | cut -d= -f2- || true)"
[ -n "${VAULT_INSTANT_HASH:-}" ] || { echo "✗ không đọc được VAULT_INSTANT_HASH từ 05 (05 lỗi?)"; exit 1; }
export REF_VAULT_INSTANT_UTXO="$(printf '%s\n' "$OUT05" | grep -oE 'REF_VAULT_INSTANT_UTXO=[0-9a-f]+#[0-9]+' | head -1 | cut -d= -f2- || true)"
[ -n "${REF_VAULT_INSTANT_UTXO:-}" ] || { echo "✗ 05 không in REF_VAULT_INSTANT_UTXO — bước [4] không dựng nổi tx (vượt trần 16384 byte)"; exit 1; }
echo "  → VAULT_INSTANT_HASH=$VAULT_INSTANT_HASH"
echo "  → REF_VAULT_INSTANT_UTXO=$REF_VAULT_INSTANT_UTXO"

echo; echo "▶ [2/4] Gen MAGIC (InstantGen)…"
echo "  ⚠ CHECKPOINT: nếu vault SHUT vì BackingBeacon all-zero (CARP chưa ship), bước này DỪNG."
echo "    Khi đó [1] và [3] vẫn là 'leg-A infra deployed'; báo lại em để xử beacon-fixture."
npx tsx test/instant_only.ts | tee /dev/tty

echo; echo "▶ [3/4] Deploy consume infra (price/engage NFT + beacon + Engage)…"
OUT09="$(npx tsx deploy/09_deploy_consume.ts | tee /dev/tty)"
eval "$(printf '%s\n' "$OUT09" | grep '^export ' || true)"
[ -n "${PRICE_BEACON_UTXO:-}" ] || { echo "✗ 09 không in export block (09 lỗi?)"; exit 1; }
[ -n "${REF_CONSUME_UTXO:-}" ] || { echo "✗ 09 không in REF_CONSUME_UTXO — bước [4] không dựng nổi tx (vượt trần 16384 byte)"; exit 1; }

echo; echo "▶ [4/4] Tiêu MAGIC thật (co-spend Engage + vault BurnBatch)…"
npx tsx test/consume_only.ts

echo; echo "✅ HOÀN TẤT e2e trên $NET"
