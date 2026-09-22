#!/usr/bin/env bash
# scripts/run_vault_tx_api_local.sh — chạy VaultTxAPI trên máy này, bind loopback.
#
#   BLOCKFROST_PROJECT_ID=… bash scripts/run_vault_tx_api_local.sh Preprod
#   BLOCKFROST_PROJECT_ID=… bash scripts/run_vault_tx_api_local.sh Preprod Schedule
#
# Bí mật đi vào bằng GIÁ TRỊ qua môi trường. Kịch bản này KHÔNG biết khoá được cất ở
# đâu, KHÔNG mở tệp nào để tìm nó, và KHÔNG in nó ra — phép kiểm dưới đây dùng
# `${VAR:?…}`, cú pháp nêu TÊN biến ra stderr chứ không nêu giá trị.
#
# Mọi giá trị còn lại được SINH, không gõ tay: `gen_vault_tx_api_deployment.ts` đọc
# `state.<NET>.sh` — chính sổ mà các bước deploy ghi ra. Cụm dựng lại thì chạy lại
# lệnh này, không phải sửa một tệp cấu hình nào.
set -uo pipefail

NET="${1:-Preprod}"
VAULT_KIND="${2:-Instant}"
case "$NET" in
  Preview|Preprod) ;;
  *) echo "✗ Tham số 1 phải là Preview hoặc Preprod (nhận: $NET)."; exit 2 ;;
esac
case "$VAULT_KIND" in
  Instant|Schedule) ;;
  *) echo "✗ Tham số 2 phải là Instant hoặc Schedule (nhận: $VAULT_KIND)."; exit 2 ;;
esac

: "${BLOCKFROST_PROJECT_ID:?✗ BLOCKFROST_PROJECT_ID chưa có trong môi trường. Dịch vụ KHÔNG khởi động.}"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"

# Blueprint của module vault tương ứng. Đây là artifact bị .gitignore chặn, nên nó
# KHÔNG đi theo nhánh và KHÔNG đi theo commit — dựng lại bằng `aiken build` trong
# module đó nếu thiếu.
case "$VAULT_KIND" in
  Instant)  BLUEPRINT="$ROOT/InstantGen/onchain/plutus.json" ;;
  Schedule) BLUEPRINT="$ROOT/ScheduleGen/onchain/plutus.json" ;;
esac
if [ ! -f "$BLUEPRINT" ]; then
  echo "✗ Không thấy $BLUEPRINT."
  echo "  Artifact này bị .gitignore chặn. Chạy \`aiken build\` trong module rồi thử lại."
  exit 1
fi

# ── Sinh khối mô tả cụm ────────────────────────────────────────────────────────
# Tách hai bước (sinh ra biến, rồi mới chạy) để mã thoát của bước SINH được đọc
# riêng. Gộp vào một phép thay lệnh thì `$?` mình đọc được là của lệnh ngoài, còn
# lỗi của bộ sinh biến mất — đúng ca một chương trình in nguyên vẹn lý do hỏng mà
# dòng cuối màn hình vẫn là "thoát 0".
#
# 🔴 KHÔNG dùng `npx --prefix <đường khác>`: bản đầu của dòng này làm thế và `npx` trả
# về RỖNG với mã thoát 0 — không một dòng lỗi nào. Dịch vụ khi đó khởi động với một
# khối triển khai rỗng và chết ở một câu lỗi nói về JSON. Chạy `npx` từ chính thư mục
# chứa kịch bản, nơi `tsx` phân giải được.
if ! DEPLOYMENT="$(cd "$HERE" && npx tsx ./gen_vault_tx_api_deployment.ts "$NET" --vault "$VAULT_KIND")"; then
  echo "✗ Bộ sinh khối triển khai hỏng — đọc dòng ✗ ở trên. Dịch vụ KHÔNG khởi động."
  exit 1
fi
if [ -z "$DEPLOYMENT" ]; then
  echo "✗ Bộ sinh chạy xong nhưng trả RỖNG. Đây KHÔNG phải \"không có gì để sinh\" —"
  echo "  khối triển khai không bao giờ rỗng hợp lệ. Dịch vụ KHÔNG khởi động."
  exit 1
fi

export VAULT_TX_API_NETWORK="$NET"
export VAULT_TX_API_DEPLOYMENT="$DEPLOYMENT"
export VAULT_TX_API_VAULT_PLUTUS_JSON="$BLUEPRINT"
# Biến này KHÔNG có mặc định trong mã, và đặt nó là một KHẲNG ĐỊNH: ví của app là địa
# chỉ enterprise của chính `owner_pkh`. Sai khẳng định đó thì tiền thừa rơi vào một
# địa chỉ khác, im lặng. Hiện đó cũng là giá trị hợp lệ duy nhất.
export VAULT_TX_API_CHANGE_ADDRESS_STRATEGY="enterprise_from_owner_pkh"
# Bind loopback ⟹ thẻ bài được phép rỗng. Đổi host mà không đặt thẻ bài thì dịch vụ
# TỪ CHỐI khởi động — nó dựng giao dịch cho bất kỳ `owner_pkh` nào được hỏi và chạy
# bằng hạn mức Blockfrost của người vận hành.
export VAULT_TX_API_HOST="127.0.0.1"
export BLOCKFROST_PROJECT_ID

echo "▶ VaultTxAPI · $NET · vault=$VAULT_KIND · http://127.0.0.1:${VAULT_TX_API_PORT:-8788}"
echo "· khoá đã nhận từ môi trường (không in). Khối triển khai sinh từ state.$NET.sh."
echo "· Ctrl-C để dừng."
cd "$ROOT/VaultTxAPI" && exec npm start
