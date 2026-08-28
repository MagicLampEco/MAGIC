#!/usr/bin/env bash
# scripts/run_consume_schedule_e2e.sh — tiêu MAGIC THẬT qua đường ScheduleGen.
#
#   bash run_consume_schedule_e2e.sh Preprod 1      # chặng 1: dựng + cam kết lịch
#   ... chờ 2 epoch (Preprod: 2 ngày UTC) ...
#   bash run_consume_schedule_e2e.sh Preprod 2 <VAULT_TX_HASH>   # chặng 2: fire + tiêu
#
# Chạy tại Terminal của anh (KHÔNG qua Claude — cổng máy chặn đọc seed).
# Secret chỉ lấy value từ $AGENT_SECRETS, không in ra.
#
# ── VÌ SAO ĐƯỜNG NÀY, KHÔNG PHẢI run_consume_e2e.sh ──────────────────────────
#   `run_consume_e2e.sh` đi qua InstantGen, và đường đó ĐANG KẸT (Nợ #19):
#   `consumed_credit` chỉ tăng ở `BurnBatch`; `BurnBatch` đòi `magic_batches` khác
#   rỗng; mà nhánh `InstantGen` là nơi DUY NHẤT ghi `magic_batches` — vòng tự tham
#   chiếu, không mở được bằng biến môi trường.
#   ScheduleGen không có vòng đó: `ScheduleFire` ghi thẳng `magic_batches`
#   (ScheduleGen/onchain/validators/vault.ak:483) và `BurnBatch` nằm ngay trong
#   cùng validator (vault.ak:512). Và `consume` KHÔNG giải mã `VaultDatum` — nó chỉ
#   đọc trường 0 (`owner`) qua `un_constr_data` (consume.ak:443-461) — nên cùng mã
#   nguồn `consume` phục vụ được vault ScheduleGen, chỉ cần apply-param bằng hash
#   của nó. KHÔNG sửa một dòng Aiken nào.
#
# ── VÌ SAO PHẢI HAI CHẶNG ────────────────────────────────────────────────────
#   `schedule_delay = 2` epoch (ScheduleGen/onchain/lib/magiclamp/protocol/constants.ak:32),
#   là hằng số hiến định, không nới bằng env được. Preprod 1 epoch giao thức =
#   86.400.000 ms = 1 ngày (ProtocolUtils/src/index.ts:30), ranh giới nửa đêm UTC
#   ⟹ chờ THẬT 24-48 giờ tuỳ giờ cam kết. Cam kết ngay trước nửa đêm UTC là rẻ nhất.
#
# 🔴 CHẶNG 2 PHẢI XONG TRONG MỘT NGÀY UTC. `schedule_decay_window = 1`
#   (constants.ak:35) ⟹ một batch MAGIC chỉ sống trong ĐÚNG epoch nó được sinh.
#   Fire hôm nay mà tiêu ngày mai là mất trắng số MAGIC đó. Vì thế bước 09 (dựng hạ
#   tầng consume) nằm TRƯỚC bước fire trong chặng 2 — đảo lại là mất một ngày.
#   Đỡ một chút: `ScheduleCommit` với L=10 cho 10 lần fire, mỗi epoch một lần, nên
#   hỏng ngày này thì ngày sau làm lại, không phải chờ 2 epoch nữa.
set -euo pipefail

NET="${1:-Preprod}"
PHASE="${2:-1}"
VAULT_TX="${3:-}"
case "$NET" in
  Preview) BF_VAR="Blockfrost_GreenSun_Preview" ;;
  Preprod) BF_VAR="Blockfrost_Aladin_Preprod" ;;
  *) echo "✗ Tham số 1 phải là Preview hoặc Preprod (nhận: $NET)"; exit 2 ;;
esac
case "$PHASE" in 1|2) ;; *) echo "✗ Tham số 2 phải là 1 hoặc 2 (nhận: $PHASE)"; exit 2 ;; esac
: "${AGENT_SECRETS:?✗ AGENT_SECRETS chưa set}"
cd "$(dirname "$0")"

STATE_FILE="deployed.$NET.env"
persist() { printf '%s=%s\n' "$1" "$2" >> "$STATE_FILE"; }
grab()    { printf '%s\n' "$2" | grep -oE "$1=[0-9a-f]+(#[0-9]+)?" | head -1 | cut -d= -f2- || true; }

if [ -f "$STATE_FILE" ]; then
  echo "▶ Đọc prereq đã lưu: $STATE_FILE"
  set -a; . "./$STATE_FILE"; set +a
fi

echo "▶ Dò biến seed ví deploy…"
SEED_VAR="$(npx tsx detect_deploy_wallet.ts)"
echo "  → biến seed: $SEED_VAR"

export NETWORK="$NET"
# Value trong $AGENT_SECRETS có thể bọc nháy. Không bóc thì dấu nháy đi thẳng vào
# bip39 và chết ở "Invalid mnemonic" — thông báo không hề nhắc tới dấu nháy.
unquote() { sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
export BLOCKFROST_KEY="$(grep "^${BF_VAR}=" "$AGENT_SECRETS" | cut -d= -f2- | unquote)"
export WALLET_SEED="$(grep "^${SEED_VAR}=" "$AGENT_SECRETS" | cut -d= -f2- | unquote)"
[ -n "${BLOCKFROST_KEY:-}" ] || { echo "✗ không lấy được $BF_VAR"; exit 1; }
[ -n "${WALLET_SEED:-}" ]    || { echo "✗ không lấy được seed $SEED_VAR"; exit 1; }
echo "  → NETWORK=$NET, Blockfrost + seed đã nạp (không in)."

if [ "$PHASE" = "1" ]; then
  # ── [1/5] LAMP policy ────────────────────────────────────────────────────
  if [ -z "${LAMP_POLICY_ID:-}" ]; then
    echo; echo "▶ [1/5] Chưa có LAMP_POLICY_ID cho $NET → mint LAMP (01)…"
    OUT="$(npx tsx deploy/01_mint_lamp.ts | tee /dev/tty)"
    export LAMP_POLICY_ID="$(grab LAMP_POLICY_ID "$OUT")"
    [ -n "${LAMP_POLICY_ID:-}" ] || { echo "✗ 01 không in LAMP_POLICY_ID"; exit 1; }
    persist LAMP_POLICY_ID "$LAMP_POLICY_ID"
  else
    echo; echo "▶ [1/5] Dùng lại LAMP_POLICY_ID=$LAMP_POLICY_ID"
  fi

  # ── [2/5] 16 shard — policy ONE-SHOT, không đúc lại được ─────────────────
  if [ -z "${SHARD_NFT_POLICY_ID:-}" ]; then
    echo; echo "▶ [2/5] Deploy 16 shard (03)…"
    echo "  ⚠ shard_nft là policy ONE-SHOT: đúc xong KHÔNG đúc lại. Mỗi lần đổi byte"
    echo "    validator là 16 shard cũ thành vô dụng và mất lại 2 epoch chờ."
    OUT="$(npx tsx deploy/03_deploy_shards.ts | tee /dev/tty)"
    export SHARD_NFT_POLICY_ID="$(grab SHARD_NFT_POLICY_ID "$OUT")"
    export SHARD_HASH="$(grab SHARD_HASH "$OUT")"
    [ -n "${SHARD_NFT_POLICY_ID:-}" ] || { echo "✗ 03 không in SHARD_NFT_POLICY_ID"; exit 1; }
    persist SHARD_NFT_POLICY_ID "$SHARD_NFT_POLICY_ID"
    persist SHARD_HASH "$SHARD_HASH"
  else
    echo; echo "▶ [2/5] Dùng lại SHARD_NFT_POLICY_ID=$SHARD_NFT_POLICY_ID"
  fi

  # ── [3/5] ref-script CIP-33 — ĐIỀU KIỆN SỐNG, không phải tối ưu ──────────
  echo; echo "▶ [3/5] Công bố ref-script (06)…"
  echo "  Đính kèm validator vào tx cho 17.310 byte > trần giao thức 16.384 ⟹ không"
  echo "  có ref-script thì KHÔNG tx nào dựng nổi, ở bất kỳ cỡ datum nào."
  OUT="$(npx tsx deploy/06_publish_ref_scripts.ts | tee /dev/tty)"
  export REF_VAULT_SCHEDULE_UTXO="$(grab REF_VAULT_SCHEDULE_UTXO "$OUT")"
  export REF_SHARD_UTXO="$(grab REF_SHARD_UTXO "$OUT")"
  [ -n "${REF_VAULT_SCHEDULE_UTXO:-}" ] || { echo "✗ 06 không in REF_VAULT_SCHEDULE_UTXO"; exit 1; }
  persist REF_VAULT_SCHEDULE_UTXO "$REF_VAULT_SCHEDULE_UTXO"
  persist REF_SHARD_UTXO "$REF_SHARD_UTXO"

  # ── [4/5] vault ScheduleGen (mint NFT danh tính cùng tx) ─────────────────
  echo; echo "▶ [4/5] Tạo vault ScheduleGen (07)…"
  OUT="$(npx tsx deploy/07_create_schedule_vault.ts | tee /dev/tty)"
  export VAULT_SCHEDULE_HASH="$(grab VAULT_SCHEDULE_HASH "$OUT")"
  [ -n "${VAULT_SCHEDULE_HASH:-}" ] || { echo "✗ 07 không in VAULT_SCHEDULE_HASH"; exit 1; }
  persist VAULT_SCHEDULE_HASH "$VAULT_SCHEDULE_HASH"

  # ── [5/5] cam kết lịch ───────────────────────────────────────────────────
  echo; echo "▶ [5/5] Cam kết lịch (schedule_commit_only)…"
  npx tsx test/schedule_commit_only.ts | tee /dev/tty

  echo
  echo "✅ CHẶNG 1 XONG trên $NET. Trạng thái đã lưu: $STATE_FILE"
  echo
  echo "   CHỜ 2 EPOCH (Preprod ≈ 2 ngày UTC), rồi chạy chặng 2 với tx hash của vault:"
  echo "     bash run_consume_schedule_e2e.sh $NET 2 <VAULT_TX_HASH>"
  echo
  echo "   VAULT_TX_HASH bắt buộc: nếu để trống thì fire dò theo owner-pkh, mà nhiều"
  echo "   vault cùng chủ ⟹ nó bắn nhầm cái không có lịch."
  exit 0
fi

# ══════════════ CHẶNG 2 ══════════════
[ -n "$VAULT_TX" ] || { echo "✗ Chặng 2 cần VAULT_TX_HASH: bash $0 $NET 2 <VAULT_TX_HASH>"; exit 2; }
for v in LAMP_POLICY_ID SHARD_NFT_POLICY_ID VAULT_SCHEDULE_HASH REF_VAULT_SCHEDULE_UTXO; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || { echo "✗ thiếu $v — chạy chặng 1 trước, hoặc điền vào $STATE_FILE"; exit 1; }
done

# 09 TRƯỚC fire: batch MAGIC chỉ sống trong đúng epoch nó sinh ra (decay_window=1).
echo; echo "▶ [1/3] Deploy hạ tầng consume (09) — ĐẶT TRƯỚC fire, có chủ ý…"
export VAULT_HASH="$VAULT_SCHEDULE_HASH"
OUT09="$(npx tsx deploy/09_deploy_consume.ts | tee /dev/tty)"
eval "$(printf '%s\n' "$OUT09" | grep '^export ' || true)"
[ -n "${PRICE_BEACON_UTXO:-}" ] || { echo "✗ 09 không in export block"; exit 1; }
[ -n "${REF_CONSUME_UTXO:-}" ]  || { echo "✗ 09 không in REF_CONSUME_UTXO — bước [3] không dựng nổi tx"; exit 1; }

echo; echo "▶ [2/3] Bắn lịch (schedule_fire_only) — sinh magic_batches…"
export VAULT_TX_HASH="$VAULT_TX"
npx tsx test/schedule_fire_only.ts | tee /dev/tty

echo; echo "▶ [3/3] Tiêu MAGIC thật (co-spend Engage + vault ScheduleGen BurnBatch)…"
export VAULT_KIND=schedule
npx tsx test/consume_only.ts

echo; echo "✅ HOÀN TẤT e2e consume qua ScheduleGen trên $NET"
