#!/usr/bin/env bash
# scripts/run_wakeme_e2e.sh — E2E "người dùng vừa bấm Wakeme" trên testnet.
#
#   bash run_wakeme_e2e.sh            # Preview (mặc định)
#   bash run_wakeme_e2e.sh Preprod
#
# Câu hỏi script này trả lời: sau Wakeme (được hệ cho mượn ≤1001 LAMP đặt trong
# vault closed-loop), người dùng có chạy được ScheduleGen và InstantGen không —
# đo bằng tx thật, không bằng test đơn vị.
#
# Secret chỉ lấy value từ $AGENT_SECRETS, không in ra.
# Prereq hạ tầng (LAMP/UM/shard/beacon) là ONE-SHOT mỗi mạng → lưu state.$NET.sh.
#
# Các bước:
#   [0a] 01 mint LAMP        → LAMP_POLICY_ID
#   [0b] 02 deploy UM        → UM_NFT_POLICY_ID + UM_DATUM_HASH
#   [0c] 03 deploy shards    → SHARD_NFT_POLICY_ID + SHARD_HASH
#   [0d] 04 BackingBeacon DỰNG-TẠM → BACKING_NFT_POLICY_ID + BACKING_SCRIPT_HASH
#        (làm mới mỗi lần chạy: max_backing_stale = 1 epoch)
#   [1]  07 tạo vault ScheduleGen, nạp LAMP mượn-Wakeme
#   [2]  ScheduleCommit  — khoá rate, ghi gen_schedules
#   [3]  ScheduleFire    — sinh MAGIC batch thật
#   [4]  05 tạo vault InstantGen
#   [5]  test:instant    — sinh MAGIC theo consumed
set -uo pipefail

NET="${1:-Preview}"
case "$NET" in
  Preview) BF_VAR="Blockfrost_GreenSun_Preview" ;;
  Preprod) BF_VAR="Blockfrost_Aladin_Preprod" ;;
  *) echo "✗ Tham số 1 phải là Preview hoặc Preprod (nhận: $NET)"; exit 2 ;;
esac
: "${AGENT_SECRETS:?✗ AGENT_SECRETS chưa set}"
cd "$(dirname "$0")"

STATE_FILE="state.$NET.sh"
persist() { printf '%s=%s\n' "$1" "$2" >> "$STATE_FILE"; }

if [ -f "$STATE_FILE" ]; then
  echo "▶ Đọc prereq đã lưu: $STATE_FILE"
  set -a; . "./$STATE_FILE"; set +a
fi

SEED_VAR="$(npx tsx detect_deploy_wallet.ts)"
export NETWORK="$NET"
# Bỏ nháy bao quanh — $AGENT_SECRETS có dòng ghi dạng KEY="giá trị", mà cut giữ
# nguyên dấu nháy ⟹ mnemonic hỏng ngay ở từ đầu và từ cuối.
unquote() { sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
export BLOCKFROST_KEY="$(grep "^${BF_VAR}=" "$AGENT_SECRETS" | cut -d= -f2- | unquote)"
export WALLET_SEED="$(grep "^${SEED_VAR}=" "$AGENT_SECRETS" | cut -d= -f2- | unquote)"
[ -n "${BLOCKFROST_KEY:-}" ] || { echo "✗ không lấy được $BF_VAR"; exit 1; }
[ -n "${WALLET_SEED:-}" ]    || { echo "✗ không lấy được seed $SEED_VAR"; exit 1; }
echo "▶ NETWORK=$NET · ví=$SEED_VAR · Blockfrost + seed đã nạp (không in)."

step() { echo; echo "══════ $* ══════"; }

# ── [00] Ví phải có UTxO thuần ADA, nếu không mọi tx script bị từ chối ──────
step "[00] chuẩn bị ví (UTxO thuần ADA cho collateral + genesis one-shot)"
npx tsx prepare_wallet.ts 2>&1 || { echo "✗ prepare_wallet lỗi"; exit 1; }

# ── [0a] LAMP ───────────────────────────────────────────────────────────────
if [ -z "${LAMP_POLICY_ID:-}" ]; then
  step "[0a] mint LAMP (01)"
  OUT="$(npx tsx deploy/01_mint_lamp.ts 2>&1)"; printf "%s\n" "$OUT"
  export LAMP_POLICY_ID="$(printf '%s\n' "$OUT" | grep -oE 'LAMP_POLICY_ID=[0-9a-f]+' | head -1 | cut -d= -f2-)"
  [ -n "${LAMP_POLICY_ID:-}" ] || { echo "✗ 01 lỗi"; exit 1; }
  persist LAMP_POLICY_ID "$LAMP_POLICY_ID"
else echo "  ✓ [0a] dùng lại LAMP_POLICY_ID=$LAMP_POLICY_ID"; fi

# ── [0b] UM ─────────────────────────────────────────────────────────────────
if [ -z "${UM_NFT_POLICY_ID:-}" ] || [ -z "${UM_DATUM_HASH:-}" ]; then
  step "[0b] deploy UM (02)"
  OUT="$(npx tsx deploy/02_deploy_um.ts 2>&1)"; printf "%s\n" "$OUT"
  export UM_DATUM_HASH="$(printf '%s\n' "$OUT" | grep -oE 'UM_DATUM_HASH=[0-9a-f]+' | head -1 | cut -d= -f2-)"
  export UM_NFT_POLICY_ID="$(printf '%s\n' "$OUT" | grep -oE 'UM_NFT_POLICY_ID=[0-9a-f]+' | head -1 | cut -d= -f2-)"
  { [ -n "${UM_DATUM_HASH:-}" ] && [ -n "${UM_NFT_POLICY_ID:-}" ]; } || { echo "✗ 02 lỗi"; exit 1; }
  persist UM_DATUM_HASH "$UM_DATUM_HASH"; persist UM_NFT_POLICY_ID "$UM_NFT_POLICY_ID"
else echo "  ✓ [0b] dùng lại UM_NFT_POLICY_ID=$UM_NFT_POLICY_ID"; fi

# ── [0c] Shards ─────────────────────────────────────────────────────────────
if [ -z "${SHARD_NFT_POLICY_ID:-}" ] || [ -z "${SHARD_HASH:-}" ]; then
  step "[0c] deploy shards (03)"
  OUT="$(npx tsx deploy/03_deploy_shards.ts 2>&1)"; printf "%s\n" "$OUT"
  export SHARD_HASH="$(printf '%s\n' "$OUT" | grep -oE 'SHARD_HASH=[0-9a-f]+' | head -1 | cut -d= -f2-)"
  export SHARD_NFT_POLICY_ID="$(printf '%s\n' "$OUT" | grep -oE 'SHARD_NFT_POLICY_ID=[0-9a-f]+' | head -1 | cut -d= -f2-)"
  { [ -n "${SHARD_HASH:-}" ] && [ -n "${SHARD_NFT_POLICY_ID:-}" ]; } || { echo "✗ 03 lỗi"; exit 1; }
  persist SHARD_HASH "$SHARD_HASH"; persist SHARD_NFT_POLICY_ID "$SHARD_NFT_POLICY_ID"
else echo "  ✓ [0c] dùng lại SHARD_NFT_POLICY_ID=$SHARD_NFT_POLICY_ID"; fi

# ── [0d] BackingBeacon dựng-tạm — LÀM MỚI mỗi lần (hết hạn sau 1 epoch) ─────
step "[0d] BackingBeacon dựng-tạm (04)"
OUT="$(npx tsx deploy/04_deploy_backing_fixture.ts 2>&1)"; printf "%s\n" "$OUT"
export BACKING_NFT_POLICY_ID="$(printf '%s\n' "$OUT" | grep -oE 'BACKING_NFT_POLICY_ID=[0-9a-f]+' | head -1 | cut -d= -f2-)"
export BACKING_SCRIPT_HASH="$(printf '%s\n' "$OUT" | grep -oE 'BACKING_SCRIPT_HASH=[0-9a-f]+' | head -1 | cut -d= -f2-)"
{ [ -n "${BACKING_NFT_POLICY_ID:-}" ] && [ -n "${BACKING_SCRIPT_HASH:-}" ]; } || { echo "✗ 04 lỗi"; exit 1; }

# ── [0e] Script tham chiếu CIP-33 — BẮT BUỘC cho ScheduleGen (tx > 16 KB) ──
# Luôn chạy: 06 tự kiểm bãi đỗ và chỉ công bố cái còn thiếu. Đọc lại từ state
# là cách bản trước tin vào một UTxO đã bị tiêu mất.
step "[0e] công bố script tham chiếu (06)"
OUT="$(npx tsx deploy/06_publish_ref_scripts.ts 2>&1)"; printf "%s\n" "$OUT"
export REF_VAULT_SCHEDULE_UTXO="$(printf '%s\n' "$OUT" | grep -oE 'REF_VAULT_SCHEDULE_UTXO=[0-9a-f]+#[0-9]+' | head -1 | cut -d= -f2-)"
export REF_SHARD_UTXO="$(printf '%s\n' "$OUT" | grep -oE 'REF_SHARD_UTXO=[0-9a-f]+#[0-9]+' | head -1 | cut -d= -f2-)"
{ [ -n "${REF_VAULT_SCHEDULE_UTXO:-}" ] && [ -n "${REF_SHARD_UTXO:-}" ]; } || { echo "✗ 06 lỗi"; exit 1; }

# ── [1] Vault ScheduleGen — nạp LAMP mượn-Wakeme (≤1001, SPEC §6) ──────────
# Nạp lại UTxO thuần ADA: 04 và 06 vừa tiêu mất, mà mọi tx script đều cần một cái
# làm collateral. Thiếu là node từ chối với CollateralContainsNonADA.
npx tsx prepare_wallet.ts >/dev/null 2>&1 || true
step "[1] tạo vault ScheduleGen + nạp LAMP mượn-Wakeme (07)"
export LAMP_DEPOSIT="${LAMP_DEPOSIT:-1001}"
OUT="$(npx tsx deploy/07_create_schedule_vault.ts 2>&1)"; printf "%s\n" "$OUT"
export VAULT_SCHEDULE_HASH="$(printf '%s\n' "$OUT" | grep -oE 'VAULT_SCHEDULE_HASH=[0-9a-f]+' | head -1 | cut -d= -f2-)"
# Bắt theo NHÃN "TX hash:" — bắt bừa 64 hex đầu tiên sẽ vớ phải tên asset của
# NFT danh-tính vault (cũng đúng 64 hex, và in TRƯỚC tx hash).
SCHED_TX="$(printf '%s\n' "$OUT" | grep -oE 'TX hash: +[0-9a-f]{64}' | grep -oE '[0-9a-f]{64}' | head -1)"
[ -n "${VAULT_SCHEDULE_HASH:-}" ] || { echo "✗ 07 lỗi"; exit 1; }

# ── [2] ScheduleCommit ──────────────────────────────────────────────────────
step "[2] ScheduleCommit — khoá rate, ghi gen_schedules"
[ -n "${SCHED_TX:-}" ] && export VAULT_TX_HASH="$SCHED_TX"
OUT="$(npx tsx test/schedule_commit_only.ts 2>&1)"; RC_COMMIT=$?; printf "%s\n" "$OUT"
COMMIT_TX="$(printf '%s\n' "$OUT" | grep -oE 'TX hash: +[0-9a-f]{64}' | grep -oE '[0-9a-f]{64}' | head -1)"

# ── [3] ScheduleFire ────────────────────────────────────────────────────────
step "[3] ScheduleFire — sinh MAGIC batch"
# Trỏ vào UTxO vault SAU commit. Giữ nguyên hash cũ là đọc lại bản gen_schedules
# rỗng và báo "No schedules" — sai chỗ, vì commit đã xong.
[ -n "${COMMIT_TX:-}" ] && export VAULT_TX_HASH="$COMMIT_TX"
npx tsx test/schedule_fire_only.ts 2>&1
RC_FIRE=${PIPESTATUS[0]}

# ── [4] Vault InstantGen ────────────────────────────────────────────────────
npx tsx prepare_wallet.ts >/dev/null 2>&1 || true
step "[4] tạo vault InstantGen (05)"
OUT="$(npx tsx deploy/05_create_instant_vault.ts 2>&1)"; printf "%s\n" "$OUT"
export VAULT_INSTANT_HASH="$(printf '%s\n' "$OUT" | grep -oE 'VAULT_INSTANT_HASH=[0-9a-f]+' | head -1 | cut -d= -f2-)"
INST_TX="$(printf '%s\n' "$OUT" | grep -oE 'TX hash: +[0-9a-f]{64}' | grep -oE '[0-9a-f]{64}' | head -1)"
[ -n "${VAULT_INSTANT_HASH:-}" ] || { echo "✗ 05 lỗi"; exit 1; }

# ── [5] InstantGen ──────────────────────────────────────────────────────────
step "[5] InstantGen — sinh MAGIC theo consumed"
[ -n "${INST_TX:-}" ] && export VAULT_TX_HASH="$INST_TX"
npx tsx test/instant_only.ts 2>&1
RC_INSTANT=${PIPESTATUS[0]}

echo
echo "══════ TỔNG KẾT $NET ══════"
echo "  ScheduleCommit : $([ "$RC_COMMIT"  = 0 ] && echo PASS || echo "FAIL(rc=$RC_COMMIT)")"
echo "  ScheduleFire   : $([ "$RC_FIRE"    = 0 ] && echo PASS || echo "FAIL(rc=$RC_FIRE)")"
echo "  InstantGen     : $([ "$RC_INSTANT" = 0 ] && echo PASS || echo "FAIL(rc=$RC_INSTANT)")"
