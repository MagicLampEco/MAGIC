# keeper_lock.sh — khoá chống chạy chồng cho `run_keeper.sh`. Nạp bằng `.`, không chạy trực tiếp.
#
# Hai lượt keeper cùng lúc tranh cùng UTxO ví và cùng thấy "chưa làm". `mkdir` là thao tác
# nguyên tử (macOS không có `flock`).
#
# `acquire_keeper_lock <thư mục>` trả về BA trạng thái, và phải tách được cả ba:
#   0  đã lấy khoá — đặt KEEPER_LOCK trỏ tới thư mục khoá để người gọi gỡ lúc thoát
#   3  một lượt khác đang giữ khoá — người gọi bỏ qua lượt này, KHÔNG phải lỗi
#   1  KHÔNG tạo được khoá và khoá KHÔNG tồn tại — lỗi quyền/hệ tệp, phải đỏ
#
# Trạng thái 1 là lý do tệp này tồn tại. Bản trước đọc MỌI lần `mkdir` hỏng thành "có lượt
# khác đang chạy" rồi thoát 0: khi dịch vụ đổi sang một tài khoản không có quyền ghi thư mục
# chứa khoá, keeper không làm gì mà mỗi giờ vẫn báo thành công. Phép tách `[ -d ]` do nhà Tiger
# đề xuất: thư mục khoá không tồn tại mà `mkdir` vẫn hỏng thì không thể là lượt chồng.

KEEPER_LOCK_STALE_MINUTES=120

acquire_keeper_lock() {
  local lock="$1/.keeper.lock"
  KEEPER_LOCK="$lock"
  if mkdir "$lock" 2>/dev/null; then
    return 0
  fi
  if [ ! -d "$lock" ]; then
    echo "✗ không tạo được khoá $lock và khoá KHÔNG tồn tại — lỗi quyền/hệ tệp, không phải lượt chồng." >&2
    return 1
  fi
  # Khoá cũ hơn ngưỡng coi là của một lượt đã chết (máy tắt giữa chừng): gỡ, kèm một dòng báo.
  if [ -n "$(find "$lock" -maxdepth 0 -mmin +"$KEEPER_LOCK_STALE_MINUTES" 2>/dev/null)" ]; then
    echo "⚠ khoá $lock cũ hơn $KEEPER_LOCK_STALE_MINUTES phút — coi là lượt đã chết, gỡ và chạy tiếp."
    if rmdir "$lock" && mkdir "$lock"; then
      return 0
    fi
    echo "✗ không lấy lại được khoá cũ $lock" >&2
    return 1
  fi
  echo "· có lượt keeper khác đang chạy (khoá $lock) — lượt này bỏ qua."
  return 3
}
