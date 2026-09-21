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
  # Chỉ mã thoát 1 = LỆCH. Mọi mã khác đọc thành CHƯA ĐO ĐƯỢC, kể cả khi `npx`
  # hoặc `tsx` chết trước khi cổng kịp chạy — bản trước gộp chúng vào nhãn
  # "artifact đã trôi", nên một máy thiếu `tsx` nhận được lời khuyên chạy
  # `aiken build`, chạy xong vẫn đỏ với đúng câu đó.
  if [ "$rc" = 1 ]; then
    echo '✗ Artifact đã trôi khỏi nguồn. Chạy `aiken build` trong module được nêu, rồi chạy lại.'
  else
    echo "✗ CHƯA ĐO ĐƯỢC hình dạng datum (mã thoát $rc) — đây KHÔNG phải \"khớp\"."
    echo '  Mã thoát 2 = cổng chạy và không đo nổi. Mã khác = cổng KHÔNG CHẠY được.'
  fi
  echo '  KHÔNG giao dịch nào được gửi.'
  exit "$rc"
}

STATE_FILE="state.$NET.sh"
[ -f "$STATE_FILE" ] || { echo "✗ Không thấy $STATE_FILE — keeper cần hash/ref đã deploy."; exit 1; }
# Giữ giá trị người gọi đặt: state file nạp SAU sẽ đè im lặng nếu không cất trước.
CALLER_BEACONS="${KEEPER_PRICE_BEACONS:-}"
# Thế phòng thủ ngay trên đây là bản làm tay cho ĐÚNG MỘT biến. Cổng dưới đây là
# bản chung cho nhóm biến mà không phép kiểm nào đứng sau.
. "./state_book_guard.sh"
assert_state_books_khong_khai_y_dinh "$STATE_FILE"
set -a; . "./$STATE_FILE"; set +a
if [ -n "$CALLER_BEACONS" ]; then
  KEEPER_PRICE_BEACONS="$CALLER_BEACONS"
elif [ -z "${KEEPER_PRICE_BEACONS:-}" ] && [ -n "${PRICE_NFT_POLICY:-}" ] && [ -n "${PRICE_PARAM_HASH:-}" ]; then
  KEEPER_PRICE_BEACONS="$PRICE_NFT_POLICY:$PRICE_PARAM_HASH"
fi

export NETWORK="$NET" BLOCKFROST_KEY WALLET_SEED KEEPER_PRICE_BEACONS
echo "▶ keeper · NETWORK=$NET · $(date -u +%FT%TZ) · secret đã nhận từ môi trường (không in)."

# Khoá chống chạy chồng: hai lượt cùng lúc tranh cùng UTxO ví và cùng thấy "chưa làm".
# `mkdir` là thao tác nguyên tử (macOS không có `flock`). Khoá cũ hơn 2 giờ coi là của một
# lượt đã chết (máy tắt giữa chừng) và được gỡ, kèm một dòng báo.
LOCK=".keeper.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +120 2>/dev/null)" ]; then
    echo "⚠ khoá $LOCK cũ hơn 2 giờ — coi là lượt đã chết, gỡ và chạy tiếp."
    rmdir "$LOCK" && mkdir "$LOCK" || { echo "✗ không lấy được khoá"; exit 1; }
  else
    echo "· có lượt keeper khác đang chạy (khoá $LOCK) — lượt này bỏ qua."
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

npx tsx keeper/keeper.ts
RC=$?
case $RC in
  0) echo "✅ keeper xong." ;;
  2) echo "⚠ keeper: có tx đã gửi mà chưa đọc lại được — soi explorer trước khi chạy lại." ;;
  *) echo "✗ keeper có bước hỏng (mã $RC) — đọc dòng ✗ ở trên." ;;
esac
exit $RC
