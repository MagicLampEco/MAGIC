#!/usr/bin/env bash
# scripts/run_consume_e2e.sh — Deploy leg-A (consume) + gen + tiêu MAGIC THẬT e2e.
#
# Chạy tại Terminal của anh (KHÔNG qua Claude — classifier chặn đọc seed):
#   cd /Users/ductiger/Projects/MAGIC/scripts
#   bash run_consume_e2e.sh            # Preview (mặc định)
#   bash run_consume_e2e.sh Preprod    # Preprod
#
# Bí mật đi vào bằng GIÁ TRỊ qua môi trường, KHÔNG in ra:
#   BLOCKFROST_KEY=… WALLET_SEED='…' bash run_consume_e2e.sh Preprod
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
  Preview|Preprod) ;;
  *) echo "✗ Tham số 1 phải là Preview hoặc Preprod (nhận: $NET)"; exit 2 ;;
esac
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
        BLOCKFROST_KEY=… WALLET_SEED=\'…\' bash run_consume_e2e.sh Preprod

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

STATE_FILE="deployed.$NET.env"
persist() { printf '%s=%s\n' "$1" "$2" >> "$STATE_FILE"; }

# Đọc lại prereq đã deploy cho ĐÚNG mạng này (nếu có) — export để thắng dotenv.
# 🔴 HAI KHÔNG GIAN TÊN, một mạng. `run_wakeme_e2e.sh` và `run_schedule_fire.sh`
#   ghi trạng thái vào `state.$NET.sh`; hai runner consume thì đọc `deployed.$NET.env`.
#   Nên chuỗi này từng kết luận "chưa có LAMP" TRONG KHI `state.Preprod.sh` đang giữ
#   sẵn đúng `LAMP_POLICY_ID=28e916b0…` — câu trả lời nằm trên đĩa, ở sổ bên kia.
#   Đó mới là nguyên nhân gốc của lần đúc chồng 2026-08-28, không phải "quên hỏi chuỗi".
#   Đọc sổ CŨ trước, sổ MỚI sau ⟹ giá trị của `deployed.$NET.env` thắng khi cả hai có.
#
# Gác trước khi nạp: `set -a` đưa MỌI dòng gán trong sổ vào môi trường, kể cả những
# biến mà `config.ts` coi là lời khai ý định của người gõ lệnh. Lý do đầy đủ nằm ở
# `state_book_guard.sh` — đừng chép xuống đây.
. "./state_book_guard.sh"
assert_state_books_khong_khai_y_dinh "state.$NET.sh" "deployed.$NET.env"

LEGACY_STATE="state.$NET.sh"
if [ -f "$LEGACY_STATE" ]; then
  echo "▶ Đọc prereq của runner khác: $LEGACY_STATE"
  set -a; . "./$LEGACY_STATE"; set +a
fi
if [ -f "$STATE_FILE" ]; then
  echo "▶ Đọc prereq đã lưu: $STATE_FILE"
  set -a; . "./$STATE_FILE"; set +a
fi

export NETWORK="$NET" BLOCKFROST_KEY WALLET_SEED
echo "  → NETWORK=$NET, Blockfrost + seed đã nhận từ môi trường (không in)."

# ── [0a] Prereq: LAMP policy ────────────────────────────────────────────────
# 🔴 Bước này TỪNG gọi `deploy/01_mint_lamp.ts` khi biến rỗng. Đã bỏ. Policy của
#   bước đó là native `{type:"sig"}` suy tất định từ khoá ví: không trần phát hành,
#   không `SupplyState`, chạy lần hai thì cộng dồn lên tài sản cũ — ngày 2026-08-28
#   nó đẩy cung tLAMP Preprod lên 72 tỷ, gấp đôi trần 36 tỷ, không gì đỏ. Token nó
#   đúc hiển thị đúng chữ `tLAMP` nên lọc theo tên hiển thị không phân biệt được.
if [ -z "${LAMP_POLICY_ID:-}" ]; then
  echo "✗ [0a] LAMP_POLICY_ID chưa có."
  echo "     Chuỗi này KHÔNG tự đúc LAMP nữa. Đặt LAMP_POLICY_ID bằng policy canonical"
  echo "     của $NET (kho LAMP ▸ Genesis ▸ lampPolicies) rồi chạy lại."
  echo "     So CẢ policy id lẫn asset name hex — chữ \"tLAMP\" hiện ra không đủ để kết luận."
  exit 1
fi
echo; echo "▶ [0a] LAMP_POLICY_ID nhận từ môi trường: $LAMP_POLICY_ID"

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

# Mỗi lượt chạy 05 là một vault InstantGen MỚI + một ref-script MỚI: LAMP và ADA
# chôn thêm mỗi lần, và hai vault cùng chủ làm bước gen soi nhầm. Chỉ dựng khi chưa có.
if [ -z "${VAULT_INSTANT_HASH:-}" ] || [ -z "${REF_VAULT_INSTANT_UTXO:-}" ]; then
  echo; echo "▶ [1/4] Deploy vault InstantGen (converge)…"
  OUT05="$(npx tsx deploy/05_create_instant_vault.ts | tee /dev/tty)"
  export VAULT_INSTANT_HASH="$(printf '%s\n' "$OUT05" | grep -oE 'VAULT_INSTANT_HASH=[0-9a-f]+' | head -1 | cut -d= -f2- || true)"
  [ -n "${VAULT_INSTANT_HASH:-}" ] || { echo "✗ không đọc được VAULT_INSTANT_HASH từ 05 (05 lỗi?)"; exit 1; }
  export REF_VAULT_INSTANT_UTXO="$(printf '%s\n' "$OUT05" | grep -oE 'REF_VAULT_INSTANT_UTXO=[0-9a-f]+#[0-9]+' | head -1 | cut -d= -f2- || true)"
  [ -n "${REF_VAULT_INSTANT_UTXO:-}" ] || { echo "✗ 05 không in REF_VAULT_INSTANT_UTXO — bước [4] không dựng nổi tx (vượt trần 16384 byte)"; exit 1; }
  persist VAULT_INSTANT_HASH "$VAULT_INSTANT_HASH"
  persist REF_VAULT_INSTANT_UTXO "$REF_VAULT_INSTANT_UTXO"
else
  echo; echo "▶ [1/4] Dùng lại vault InstantGen $VAULT_INSTANT_HASH"
fi
echo "  → VAULT_INSTANT_HASH=$VAULT_INSTANT_HASH"
echo "  → REF_VAULT_INSTANT_UTXO=$REF_VAULT_INSTANT_UTXO"

echo; echo "▶ [2/4] Gen MAGIC (InstantGen)…"
echo "  ⚠ CHECKPOINT: nếu vault SHUT vì BackingBeacon all-zero, bước này DỪNG."
echo "    Beacon do keeper tầng GreenBack của kho này ghi — không chờ nhà nào khác."
echo "    Khi đó [1] và [3] vẫn là 'leg-A infra deployed'; báo lại em để xử beacon-fixture."
npx tsx test/instant_only.ts | tee /dev/tty

# 🔴 09 đúc price NFT ONE-SHOT ⟹ chạy lại là đổi price_nft_policy ⟹ đổi apply-param
#    của `consume` ⟹ đổi script hash ⟹ đổi ĐỊA CHỈ ⟹ mọi Engage UTxO cũ thành mồ côi
#    cùng toàn bộ kế toán tiêu dùng. Chạy ĐÚNG MỘT LẦN, sau đó dò UTxO sống theo NFT.
#    (Hai UTxO beacon/engage KHÔNG cache được — chúng bị tiêu và tạo lại mỗi tx.)
if [ -n "${CONSUME_SCRIPT_HASH:-}" ] && [ -n "${REF_CONSUME_UTXO:-}" ]; then
  echo; echo "▶ [3/4] Dùng lại hạ tầng consume $CONSUME_SCRIPT_HASH — dò UTxO sống…"
  # 🔴 Bản trước ở đây là MỘT dòng `eval "$(npx tsx resolve_consume_state.ts)"`, không cổng
  #   nào. Hai chỗ hỏng, cả hai im:
  #
  #   (a) `eval "$(cmd)"` vứt mã thoát của `cmd`. Mã thoát của cả câu là mã thoát của
  #       `eval`, và `eval` trên một chuỗi RỖNG trả 0 — nên `set -e` không bắt. Resolver
  #       `process.exit(1)` bốn chỗ (dòng 41 · 54 · 121 · 127) và không chỗ nào tới được
  #       kịch bản này.
  #   (b) Không biến nào được kiểm sau đó. Nhánh DEPLOY ngay dưới, cách 6 dòng, kiểm hai
  #       biến rồi mới đi tiếp. Hai nhánh cùng dẫn tới đúng một bước [4], một nhánh nghiêm
  #       một nhánh lỏng, không dòng nào giải thích vì sao khác.
  #
  #   Hệ quả: bước [4] chạy với `PRICE_BEACON_UTXO`/`ENGAGE_UTXO` rỗng hoặc CŨ (còn sót
  #   trong môi trường từ sổ trạng thái), dựng tx trên một UTxO đã bị tiêu, và lỗi hiện ra
  #   là một câu của Lucid về UTxO không tồn tại — trỏ vào bước [4], trong khi hỏng ở [3].
  RESOLVED="$(npx tsx resolve_consume_state.ts)" || {
    echo "✗ [3/4] resolve_consume_state.ts thoát khác 0 — KHÔNG dò được UTxO sống."
    echo "     Đừng chạy tiếp bước [4]: nó sẽ dùng giá trị cũ còn sót trong môi trường."
    exit 1
  }
  eval "$RESOLVED"
  # Cùng hai cổng mà nhánh deploy dùng, cộng `ENGAGE_UTXO` — bước [4] co-spend nó.
  [ -n "${PRICE_BEACON_UTXO:-}" ] || { echo "✗ [3/4] resolver không in PRICE_BEACON_UTXO"; exit 1; }
  [ -n "${ENGAGE_UTXO:-}" ]       || { echo "✗ [3/4] resolver không in ENGAGE_UTXO"; exit 1; }
  [ -n "${REF_CONSUME_UTXO:-}" ]  || { echo "✗ [3/4] REF_CONSUME_UTXO rỗng — bước [4] không dựng nổi tx (vượt trần 16384 byte)"; exit 1; }
else
  echo; echo "▶ [3/4] Deploy consume infra (price/engage NFT + beacon + Engage)…"
  OUT09="$(npx tsx deploy/09_deploy_consume.ts | tee /dev/tty)"
  eval "$(printf '%s\n' "$OUT09" | grep '^export ' || true)"
  [ -n "${PRICE_BEACON_UTXO:-}" ] || { echo "✗ 09 không in export block (09 lỗi?)"; exit 1; }
  [ -n "${REF_CONSUME_UTXO:-}" ] || { echo "✗ 09 không in REF_CONSUME_UTXO — bước [4] không dựng nổi tx (vượt trần 16384 byte)"; exit 1; }
  for v in CONSUME_SCRIPT_HASH PRICE_NFT_POLICY PRICE_NFT_UNIT PRICE_PARAM_HASH \
           ENGAGE_NFT_POLICY ENGAGE_NFT_UNIT MAX_PRICE_STALE REF_CONSUME_UTXO; do
    eval "val=\${$v:-}"
    [ -n "$val" ] && persist "$v" "$val"
  done
fi

echo; echo "▶ [4/4] Tiêu MAGIC thật (co-spend Engage + vault BurnBatch)…"
npx tsx test/consume_only.ts

echo; echo "✅ HOÀN TẤT e2e trên $NET"
