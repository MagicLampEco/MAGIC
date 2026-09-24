# scripts/keeper_beacons.sh — suy danh sách price beacon cho keeper từ sổ trạng thái.
# Nạp bằng `. ./keeper_beacons.sh` rồi gọi `derive_keeper_price_beacons "<giá trị người gọi đặt>"`.
#
# Đặt KEEPER_PRICE_BEACONS (`<price_nft_policy>:<price_param_hash>`, phẩy) và
# KEEPER_PRICE_BEACONS_SOURCE (nguồn đã dùng, để in ra nhật ký). Thứ tự ưu tiên:
#   1. giá trị người gọi đặt trước khi nạp sổ;
#   2. KEEPER_PRICE_BEACONS trong sổ;
#   3. mọi cặp có hậu tố loại vault — `PRICE_NFT_POLICY_SCHEDULE:PRICE_PARAM_HASH_SCHEDULE`,
#      rồi `_INSTANT` — mỗi cặp chỉ lấy khi CẢ HAI vế có mặt (scripts/consumeBook.ts);
#   4. cặp không hậu tố `PRICE_NFT_POLICY:PRICE_PARAM_HASH` (sổ viết trước khi tách).
#
# Vì sao bước 3 tồn tại: mỗi loại vault có bản consume riêng ⟹ beacon giá riêng. Bản trước
# chỉ có bước 4, nên sổ có hai bản consume vẫn chỉ ra MỘT beacon, và beacon còn lại đứng
# yên cho tới khi quá `max_price_stale` — lúc đó mọi tx tiêu trên loại vault kia bị từ chối,
# còn keeper vẫn in "hỏng 0" vì nó không biết beacon đó tồn tại.
#
# Bước 4 chỉ chạy khi bước 3 không ra cặp nào: trộn hai nguồn thì một sổ vừa có bộ cũ vừa
# có bộ mới sẽ đăng giá cho một beacon của đời trước.

derive_keeper_price_beacons() {
  local caller="${1:-}" pairs="" kind pol hash
  if [ -n "$caller" ]; then
    KEEPER_PRICE_BEACONS="$caller"; KEEPER_PRICE_BEACONS_SOURCE="người gọi đặt"; return 0
  fi
  if [ -n "${KEEPER_PRICE_BEACONS:-}" ]; then
    KEEPER_PRICE_BEACONS_SOURCE="KEEPER_PRICE_BEACONS trong sổ"; return 0
  fi
  for kind in SCHEDULE INSTANT; do
    eval "pol=\${PRICE_NFT_POLICY_${kind}:-}; hash=\${PRICE_PARAM_HASH_${kind}:-}"
    if [ -n "$pol" ] && [ -n "$hash" ]; then
      pairs="${pairs:+$pairs,}$pol:$hash"
    fi
  done
  if [ -n "$pairs" ]; then
    KEEPER_PRICE_BEACONS="$pairs"; KEEPER_PRICE_BEACONS_SOURCE="cặp theo loại vault (_SCHEDULE/_INSTANT)"; return 0
  fi
  if [ -n "${PRICE_NFT_POLICY:-}" ] && [ -n "${PRICE_PARAM_HASH:-}" ]; then
    KEEPER_PRICE_BEACONS="$PRICE_NFT_POLICY:$PRICE_PARAM_HASH"
    KEEPER_PRICE_BEACONS_SOURCE="cặp không hậu tố (sổ trước khi tách theo loại vault)"; return 0
  fi
  KEEPER_PRICE_BEACONS=""; KEEPER_PRICE_BEACONS_SOURCE="không nguồn nào"
}
