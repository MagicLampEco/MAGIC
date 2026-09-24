#!/usr/bin/env bash
# scripts/test_keeper_beacons.sh — bộ ca cho `keeper_beacons.sh`. Không gọi mạng.
# Chạy: bash scripts/test_keeper_beacons.sh   Dòng cuối: `=== ĐẠT ===` hoặc `=== HỎNG: n ca sai ===`.
set -u
cd "$(dirname "$0")"
. ./keeper_beacons.sh

sai=0
ca() { # ca <tên> <chờ KEEPER_PRICE_BEACONS> — môi trường đã dựng sẵn trong subshell gọi
  local ten="$1" cho="$2"
  if [ "$KEEPER_PRICE_BEACONS" = "$cho" ]; then
    echo "  ✓ $ten"
  else
    echo "  ✗ $ten — nhận \"$KEEPER_PRICE_BEACONS\", chờ \"$cho\""; return 1
  fi
}
xoa() { unset KEEPER_PRICE_BEACONS PRICE_NFT_POLICY PRICE_PARAM_HASH \
  PRICE_NFT_POLICY_SCHEDULE PRICE_PARAM_HASH_SCHEDULE PRICE_NFT_POLICY_INSTANT PRICE_PARAM_HASH_INSTANT; }

( xoa; PRICE_NFT_POLICY_SCHEDULE=s1; PRICE_PARAM_HASH_SCHEDULE=s2; PRICE_NFT_POLICY_INSTANT=i1; PRICE_PARAM_HASH_INSTANT=i2
  derive_keeper_price_beacons ""; ca "hai bản consume ⟹ hai cặp" "s1:s2,i1:i2" ) || sai=$((sai+1))

( xoa; PRICE_NFT_POLICY_INSTANT=i1; PRICE_PARAM_HASH_INSTANT=i2; PRICE_NFT_POLICY=c1; PRICE_PARAM_HASH=c2
  derive_keeper_price_beacons ""; ca "có cặp theo loại ⟹ KHÔNG trộn cặp không hậu tố" "i1:i2" ) || sai=$((sai+1))

( xoa; PRICE_NFT_POLICY_SCHEDULE=s1; PRICE_NFT_POLICY=c1; PRICE_PARAM_HASH=c2
  derive_keeper_price_beacons ""; ca "cặp theo loại thiếu một vế ⟹ bỏ, lùi về không hậu tố" "c1:c2" ) || sai=$((sai+1))

( xoa; PRICE_NFT_POLICY=c1; PRICE_PARAM_HASH=c2
  derive_keeper_price_beacons ""; ca "sổ cũ chỉ có không hậu tố ⟹ vẫn chạy" "c1:c2" ) || sai=$((sai+1))

( xoa; KEEPER_PRICE_BEACONS=k1:k2; PRICE_NFT_POLICY_SCHEDULE=s1; PRICE_PARAM_HASH_SCHEDULE=s2
  derive_keeper_price_beacons ""; ca "sổ đặt KEEPER_PRICE_BEACONS ⟹ thắng" "k1:k2" ) || sai=$((sai+1))

( xoa; KEEPER_PRICE_BEACONS=k1:k2
  derive_keeper_price_beacons "n1:n2"; ca "người gọi đặt ⟹ thắng cả sổ" "n1:n2" ) || sai=$((sai+1))

( xoa; derive_keeper_price_beacons ""; ca "không nguồn nào ⟹ rỗng" "" ) || sai=$((sai+1))

if [ "$sai" -eq 0 ]; then echo; echo "=== ĐẠT ==="; else echo; echo "=== HỎNG: $sai ca sai ==="; exit 1; fi
