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
# Bí mật đi vào bằng GIÁ TRỊ qua môi trường, không in ra:
#   BLOCKFROST_KEY=… WALLET_SEED='…' bash run_schedule_fire.sh Preprod <VAULT_TX_HASH>
set -uo pipefail

NET="${1:-Preview}"
VAULT_TX="${2:-${VAULT_TX_HASH:-}}"
case "$NET" in
  Preview|Preprod) ;;
  *) echo "✗ Tham số 1 phải là Preview hoặc Preprod (nhận: $NET)"; exit 2 ;;
esac
[ -n "$VAULT_TX" ] || {
  echo "✗ Thiếu VAULT_TX_HASH. Dùng: bash run_schedule_fire.sh $NET <tx-hash-cua-ScheduleCommit>"
  echo "  Tx commit gần nhất ghi ở scripts/DEPLOYED.md."
  exit 2
}
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
        BLOCKFROST_KEY=… WALLET_SEED=\'…\' bash run_schedule_fire.sh Preprod <tx-hash>

    Khoá phải đúng mạng đang chạy. Khoá của mạng khác vẫn là chuỗi hợp lệ và vẫn gọi được
    — nó chỉ trả về dữ liệu của mạng kia, và không có gì kêu lên.
}"
: "${WALLET_SEED:?
  ✗ WALLET_SEED chưa có trong môi trường. Kịch bản DỪNG — KHÔNG giao dịch nào được gửi.
}"
cd "$(dirname "$0")"

# ── Cổng: artifact `plutus.json` còn khớp NGUỒN Aiken không? ──────────────────
# Artifact bị `.gitignore` chặn nên nó KHÔNG đi theo nhánh và KHÔNG đi theo commit:
# đổi nhánh là đủ để bản dựng trên đĩa tả một lược đồ mà không nhánh nào trong kho
# đang khai. Mọi bước deploy phía dưới đọc CHÍNH nó, và giải mã Plutus Data của
# Aiken nghiêm ngặt về số trường theo cả hai chiều — nên một vault dựng theo artifact
# cũ là một vault validator hiện tại không đọc nổi, tức LAMP vào được và không ra
# được. Đặt cổng ở ĐÂY, trước mọi lượt gọi mạng, để không giao dịch nào được gửi.
# Ba trạng thái thoát + phần cổng này KHÔNG đo: `check_datum_shape.ts`.
npx tsx check_datum_shape.ts || {
  rc=$?
  if [ "$rc" = 2 ]; then
    echo '✗ CHƯA ĐO ĐƯỢC hình dạng datum (xem dòng trên) — đây KHÔNG phải "khớp".'
  else
    echo '✗ Artifact đã trôi khỏi nguồn. Chạy `aiken build` trong module được nêu, rồi chạy lại.'
  fi
  echo '  KHÔNG giao dịch nào được gửi.'
  exit "$rc"
}

STATE_FILE="state.$NET.sh"
[ -f "$STATE_FILE" ] || { echo "✗ Không thấy $STATE_FILE — chạy run_wakeme_e2e.sh một lần để dựng prereq."; exit 1; }
. "./state_book_guard.sh"
assert_state_books_khong_khai_y_dinh "$STATE_FILE"
set -a; . "./$STATE_FILE"; set +a

# Script tham chiếu CIP-33 là BẮT BUỘC: đính kèm cả vault + shard làm tx vượt
# trần 16384 byte (đo thật 17303). Nạp từ env hoặc từ state file.
: "${REF_VAULT_SCHEDULE_UTXO:?✗ thiếu REF_VAULT_SCHEDULE_UTXO (xem scripts/DEPLOYED.md)}"
: "${REF_SHARD_UTXO:?✗ thiếu REF_SHARD_UTXO (xem scripts/DEPLOYED.md)}"
export REF_VAULT_SCHEDULE_UTXO REF_SHARD_UTXO

export NETWORK="$NET" VAULT_TX_HASH="$VAULT_TX" BLOCKFROST_KEY WALLET_SEED
echo "▶ NETWORK=$NET · vault ghim=${VAULT_TX:0:16}… · secret đã nhận từ môi trường (không in)."

npx tsx test/schedule_fire_only.ts
RC=$?
echo
[ $RC -eq 0 ] && echo "✅ ScheduleFire xong — chép tx hash vào scripts/DEPLOYED.md." \
              || echo "✗ ScheduleFire hỏng (mã $RC) — đọc lý do ở trên, đừng chạy lại mù."
exit $RC
