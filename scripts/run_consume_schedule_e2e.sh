#!/usr/bin/env bash
# scripts/run_consume_schedule_e2e.sh — tiêu MAGIC THẬT qua đường ScheduleGen.
#
#   bash run_consume_schedule_e2e.sh Preprod 1      # chặng 1: dựng + cam kết lịch
#   ... chờ 2 epoch (Preprod: 2 ngày UTC) ...
#   bash run_consume_schedule_e2e.sh Preprod 2 <VAULT_TX_HASH>   # chặng 2: fire + tiêu
#
# Bí mật đi vào bằng GIÁ TRỊ qua môi trường, không in ra:
#   BLOCKFROST_KEY=… WALLET_SEED='…' bash run_consume_schedule_e2e.sh Preprod 1
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
#   là hằng số hiến định, không nới bằng env được. Độ dài epoch là của MẠNG
#   (ProtocolUtils ▸ `msPerEpoch`): Preview 1 ngày, Preprod 5 ngày (từ 2026-09-20)
#   ⟹ trên Preprod chờ THẬT 5-10 ngày tuỳ lúc cam kết. Cam kết sát ranh giới epoch là rẻ nhất.
#
# 🔴 CHẶNG 2 PHẢI XONG TRONG MỘT EPOCH. `schedule_decay_window = 1`
#   (constants.ak:35) ⟹ một batch MAGIC chỉ sống trong ĐÚNG epoch nó được sinh.
#   Fire hôm nay mà tiêu ngày mai là mất trắng số MAGIC đó. Vì thế bước 09 (dựng hạ
#   tầng consume) nằm TRƯỚC bước fire trong chặng 2 — đảo lại là mất một epoch.
#   Đỡ một chút: `ScheduleCommit` với L=10 cho 10 lần fire, mỗi epoch một lần, nên
#   hỏng epoch này thì epoch sau làm lại, không phải chờ 2 epoch nữa.
set -euo pipefail

NET="${1:-Preprod}"
PHASE="${2:-1}"
VAULT_TX="${3:-}"
case "$NET" in
  Preview|Preprod) ;;
  *) echo "✗ Tham số 1 phải là Preview hoặc Preprod (nhận: $NET)"; exit 2 ;;
esac
case "$PHASE" in 1|2) ;; *) echo "✗ Tham số 2 phải là 1 hoặc 2 (nhận: $PHASE)"; exit 2 ;; esac
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
        BLOCKFROST_KEY=… WALLET_SEED=\'…\' bash run_consume_schedule_e2e.sh Preprod 1

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

STATE_FILE="deployed.$NET.env"
persist() { printf '%s=%s\n' "$1" "$2" >> "$STATE_FILE"; }
grab()    { printf '%s\n' "$2" | grep -oE "$1=[0-9a-f]+(#[0-9]+)?" | head -1 | cut -d= -f2- || true; }
# `grab` chỉ bắt dạng KEY=value. Tx hash thì các bước deploy in dưới dạng
# "   TX hash:   <hex>" nên cần bộ bắt riêng — thiếu nó là người chạy phải tự bới
# tx hash trong log rồi dán tay vào chặng 2, và dán nhầm thì fire vào vault khác.
grab_txhash() { printf '%s\n' "$1" | grep -oE 'TX hash:[[:space:]]+[0-9a-f]{64}' | head -1 | grep -oE '[0-9a-f]{64}' || true; }

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

if [ "$PHASE" = "1" ]; then
  # ── [1/5] LAMP policy ────────────────────────────────────────────────────
  if [ -z "${LAMP_POLICY_ID:-}" ]; then
    # 🔴 BƯỚC NÀY TỪNG CẨN THẬN ĐÚNG MỘT NỬA, và nửa còn lại mới là chỗ hỏng.
    #
    # Bản trước đã bỏ lệnh đúc và thay bằng `resolve_lamp_policy.ts` — "hỏi chuỗi,
    # chỉ đọc, không đúc". Đọc thì đúng là chỉ đọc. Nhưng hàm đó suy policy id TỪ
    # KHOÁ VÍ, nên thứ nó tìm thấy trên chuỗi chính là token do ví này tự đúc:
    # chính sách chữ-ký-đơn, KHÔNG trần, KHÔNG `SupplyState`, đã có lúc lên 72 tỷ —
    # gấp đôi mức hiến định 36 tỷ. Kho LAMP xếp nó vào nhóm "trông giống LAMP nhưng
    # KHÔNG phải LAMP".
    #
    # Nghĩa là cổng cũ chặn được hành vi ĐÚC mà vẫn để nguyên hành vi DÙNG NHẦM, và
    # cái sau đi qua êm hơn vì nó không ghi gì lên chuỗi cả. Một lượt chạy xanh với
    # token nhái không khác gì một lượt chạy xanh với token thật, cho tới lúc có
    # người mang kết quả đó đi kết luận rằng đường LAMP đã thông.
    #
    # Nay: `LAMP_POLICY_ID` phải do NGƯỜI CHẠY đưa vào, lấy từ sổ canonical theo
    # mạng của kho LAMP. Không suy từ ví, không dò trên chuỗi.
    echo "✗ [1/5] LAMP_POLICY_ID chưa có."
    echo "     Chuỗi này KHÔNG tự đúc và cũng KHÔNG tự suy policy từ khoá ví nữa —"
    echo "     policy suy từ ví là token diễn tập không có trần, không phải LAMP."
    echo "     Đặt LAMP_POLICY_ID bằng policy canonical của $NET (kho LAMP ▸ Genesis ▸"
    echo "     lampPolicies) rồi chạy lại. So CẢ policy id lẫn asset name hex."
    exit 1
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
  if [ -z "${REF_VAULT_SCHEDULE_UTXO:-}" ]; then
    echo; echo "▶ [3/5] Công bố ref-script (06)…"
    echo "  Đính kèm validator vào tx cho 17.310 byte > trần giao thức 16.384 ⟹ không"
    echo "  có ref-script thì KHÔNG tx nào dựng nổi, ở bất kỳ cỡ datum nào."
    OUT="$(npx tsx deploy/06_publish_ref_scripts.ts | tee /dev/tty)"
    export REF_VAULT_SCHEDULE_UTXO="$(grab REF_VAULT_SCHEDULE_UTXO "$OUT")"
    export REF_SHARD_UTXO="$(grab REF_SHARD_UTXO "$OUT")"
    [ -n "${REF_VAULT_SCHEDULE_UTXO:-}" ] || { echo "✗ 06 không in REF_VAULT_SCHEDULE_UTXO"; exit 1; }
    persist REF_VAULT_SCHEDULE_UTXO "$REF_VAULT_SCHEDULE_UTXO"
    persist REF_SHARD_UTXO "$REF_SHARD_UTXO"
  else
    echo; echo "▶ [3/5] Dùng lại ref-script $REF_VAULT_SCHEDULE_UTXO"
    echo "  Công bố lại là chôn thêm ~20 ADA vào một bãi đỗ không ai gom, mà bytes"
    echo "  validator không đổi thì bản cũ vẫn dùng được nguyên."
  fi

  # ── [4/5] vault ScheduleGen (mint NFT danh tính cùng tx) ─────────────────
  if [ -z "${VAULT_SCHEDULE_HASH:-}" ] || [ -z "${VAULT_TX_HASH_SCHEDULE:-}" ]; then
    echo; echo "▶ [4/5] Tạo vault ScheduleGen (07)…"
    OUT="$(npx tsx deploy/07_create_schedule_vault.ts | tee /dev/tty)"
    export VAULT_SCHEDULE_HASH="$(grab VAULT_SCHEDULE_HASH "$OUT")"
    export VAULT_TX_HASH_SCHEDULE="$(grab_txhash "$OUT")"
    [ -n "${VAULT_SCHEDULE_HASH:-}" ] || { echo "✗ 07 không in VAULT_SCHEDULE_HASH"; exit 1; }
    [ -n "${VAULT_TX_HASH_SCHEDULE:-}" ] || { echo "✗ 07 không in được TX hash — chặng 2 sẽ không ghim nổi vault"; exit 1; }
    persist VAULT_SCHEDULE_HASH "$VAULT_SCHEDULE_HASH"
    persist VAULT_TX_HASH_SCHEDULE "$VAULT_TX_HASH_SCHEDULE"
  else
    echo; echo "▶ [4/5] Dùng lại vault $VAULT_TX_HASH_SCHEDULE"
    echo "  🔴 Tạo vault mới mỗi lượt chạy là CHÔN thêm 10.000 tLAMP + ADA vào một"
    echo "     vault không ai đụng tới nữa, và sinh ra hai vault cùng chủ để bước"
    echo "     fire soi nhầm. Muốn vault mới thật thì xoá hai dòng VAULT_SCHEDULE_HASH"
    echo "     và VAULT_TX_HASH_SCHEDULE khỏi $STATE_FILE."
  fi

  # ── [5/5] cam kết lịch ───────────────────────────────────────────────────
  # GHIM vault: `schedule_commit_only` fail-closed theo VAULT_TX_HASH (test/
  # schedule_commit_only.ts:83-90). Không ghim thì nó lấy vault ĐẦU TIÊN của chủ ví
  # — nhiều vault cùng chủ là cam kết lịch vào cái không phải cái vừa tạo.
  # 🔴 NGOẶC NHỌN BẮT BUỘC ở đây. Dấu `…` là MỘT ký tự Unicode 3 byte, và trong locale
  #    UTF-8 bash gộp byte đầu của nó vào TÊN BIẾN — dạng KHÔNG ngoặc (đô-la dán thẳng tên
  #    rồi tới dấu ba chấm) thành một biến KHÁC, tên mang byte thừa, chưa bao giờ được đặt.
  #    (Cố ý không trích dạng hỏng nguyên văn ở đây: phép quét dưới sẽ kêu ở chính chú thích
  #     này, và một cảnh báo luôn có lời giải thích vô hại dạy người đọc bỏ qua nó.)
  #    `set -u` giết kịch bản ngay sau khi bước [4/5]
  #    đã tạo vault THẬT trên chuỗi và đã ghi sổ. Đo 2026-09-11 trên Preprod: vault
  #    2cb416e0… tạo xong, rồi chết ở đúng dòng này với tên biến hiện ra kèm byte hỏng.
  #    Mọi `$BIEN` đứng liền trước chữ tiếng Việt hay dấu `…`/`—` đều dính; quét bằng
  #    mẫu `\$[A-Za-z_][A-Za-z0-9_]*[\x80-\xff]` (grep -P của macOS KHÔNG bắt được).
  echo; echo "▶ [5/5] Cam kết lịch (schedule_commit_only) — ghim vault ${VAULT_TX_HASH_SCHEDULE}…"
  OUT5="$(VAULT_TX_HASH="$VAULT_TX_HASH_SCHEDULE" npx tsx test/schedule_commit_only.ts | tee /dev/tty)"

  # 🔴 BẮT LẠI TX HASH CỦA CHÍNH BƯỚC CAM KẾT — ĐỪNG BỎ.
  #
  #  Cam kết là một lệnh SPEND: `buildScheduleCommitTx` gọi
  #  `.collectFrom([vaultUtxo], redeemer)` (ScheduleGen/offchain/src/schedule.ts:235),
  #  nên UTxO vault mà bước [4/5] vừa tạo bị TIÊU ngay tại đây, và vault sống tiếp ở
  #  một output MỚI mang hash của tx cam kết.
  #
  #  Bản trước KHÔNG bắt hash này (chạy lệnh trần, không bọc `$(...)`) rồi in ra lệnh
  #  chặng 2 kèm hash của bước [4/5]. Lệnh đó **chắc chắn hỏng**, và hỏng theo cách đắt
  #  nhất có thể:
  #    · `schedule_fire_only.ts:79` đòi `u.txHash === wantedTx`, và khi đã ghim thì
  #      hết lượt là DỪNG, cố ý không đoán hộ (`if (wantedTx) break;`).
  #    · kể cả nếu UTxO cũ còn sống thì nó cũng `gen_schedules == []`, và fire chết ở
  #      `schedule_fire_only.ts:115` với "No schedules. Run Commit first".
  #    · thông điệp lỗi lúc đó dẫn người chạy đi soi apply-param và validator hash —
  #      SAI HƯỚNG, đúng vào lúc đắt nhất.
  #  Giá: trọn 2 epoch (~2 ngày UTC) đã chờ, và người chạy phải tự bới hash đúng trong
  #  log — đúng thứ mà dòng cuối chặng 1 vừa bảo họ không cần giữ.
  #
  #  Người chạy không làm sai gì cả: họ dán đúng lệnh mà chính kịch bản này in ra.
  COMMIT_TX_HASH="$(grab_txhash "$OUT5")"
  [ -n "$COMMIT_TX_HASH" ] || {
    echo "✗ Không bắt được TX hash của bước cam kết."
    echo "  Chặng 2 PHẢI ghim hash của tx CAM KẾT, không phải hash tạo vault ở [4/5]."
    echo "  Tìm dòng 'TX hash:' trong output ngay trên rồi chạy chặng 2 bằng hash đó."
    exit 1
  }
  # Từ đây trở đi, vault sống ở output của tx cam kết.
  export VAULT_TX_HASH_SCHEDULE="$COMMIT_TX_HASH"
  persist VAULT_TX_HASH_SCHEDULE "$COMMIT_TX_HASH"

  echo
  echo "✅ CHẶNG 1 XONG trên $NET. Trạng thái đã lưu: $STATE_FILE"
  echo
  echo "   CHỜ 2 EPOCH (Preprod ≈ 2 ngày UTC), rồi chạy đúng lệnh này:"
  echo
  echo "     bash run_consume_schedule_e2e.sh $NET 2 $COMMIT_TX_HASH"
  echo
  echo "   (Hash trên là của tx CAM KẾT — vault đã dời sang đó. Hash tạo vault ở [4/5]"
  echo "    đã bị chính bước cam kết tiêu, dùng nó là chặng 2 không tìm thấy vault.)"
  echo "   Tx hash đã được lưu vào $STATE_FILE nên không phải bới lại trong log."
  exit 0
fi

# ══════════════ CHẶNG 2 ══════════════
[ -n "$VAULT_TX" ] || { echo "✗ Chặng 2 cần VAULT_TX_HASH: bash $0 $NET 2 <VAULT_TX_HASH>"; exit 2; }

# 🔴 CỔNG NỬA ĐÊM UTC — ĐO LÚC CHẠY, không phải một lời dặn trong chú thích.
#
#  Cả chặng 2 phải nằm TRỌN trong một epoch: fire sinh batch mang `created_epoch = E`,
#  `schedule_decay_window = 1` ⟹ `is_expired` đúng ngay khi sang E+1. Nếu bước tiêu rơi
#  sang epoch sau thì batch vừa sinh đã chết, và `consume_only.ts` báo "MAGIC còn sống
#  KHÔNG ĐỦ" — thông điệp đúng, nhưng thiệt hại đã xảy ra: mất một ô `fired_count` của
#  lịch và mất một ngày.
#
#  Thời gian thật của chặng 2 (đo theo chính các vòng chờ trong mã):
#    · [1/3] nếu phải deploy hạ tầng consume: 09 polling 30×10s + 1 tx ref-script ≈ 5-6'
#    · [2/3] fire + xác nhận: tối đa 6×20s = 2'
#    · [3/3] tiêu: 1 tx
#  ⟹ lấy 12 phút làm ngưỡng an toàn khi đã có cache, 20 phút khi chưa.
#
#  Cảnh báo tĩnh ở đầu tệp KHÔNG thay được cổng này: người chạy sau hai ngày chờ sẽ gõ
#  lệnh ngay khi rảnh, không phải ngay khi an toàn.
# `10#` phải đứng trước GIÁ TRỊ, không trước hằng 60: `date` in ra hai chữ số có số 0
# dẫn đầu, và bash đọc `08`/`09` là bát phân KHÔNG HỢP LỆ ⟹ với `set -e` cả kịch bản
# chết bằng `value too great for base` ở đúng phút 08/09 — hỏng ồn nhưng thông điệp
# không nhắc gì tới giờ giấc. Đã dựng lại lỗi này rồi mới sửa.
#
# 🔴 Ranh giới là ranh giới EPOCH, không phải nửa đêm mỗi ngày. Bản trước lấy `86400 −
# giây-đã-qua-trong-ngày`, đúng khi epoch dài 1 ngày. Preprod nay 5 ngày (`msPerEpoch`,
# ProtocolUtils) — ranh giới vẫn rơi vào 00:00Z nhưng chỉ một lần mỗi 5 ngày, nên bản cũ
# chặn thừa 12-20 phút trước MỌI nửa đêm và nói sai lý do. Đọc độ dài epoch từ nguồn của
# nó; không đọc được thì DỪNG, đừng lùi về 1 ngày.
MS_EPOCH="$(node -e "import('@magiclamp/protocol-utils').then(m => console.log(String(m.msPerEpoch('$NET'))))" 2>/dev/null || true)"
case "$MS_EPOCH" in
  ''|*[!0-9]*) echo "✗ KHÔNG ĐO ĐƯỢC độ dài epoch của $NET (msPerEpoch) — dừng, không gửi gì."; exit 2 ;;
esac
GIAY_EPOCH=$(( MS_EPOCH / 1000 ))
CON_LAI_GIAY=$(( GIAY_EPOCH - $(date -u +%s) % GIAY_EPOCH ))
if [ -n "${CONSUME_SCRIPT_HASH_SCHEDULE:-}" ] && [ -n "${REF_CONSUME_UTXO_SCHEDULE:-}" ]; then
  NGUONG=720          # 12 phút — hạ tầng consume đã có, bỏ qua được bước 09
else
  NGUONG=1200         # 20 phút — còn phải deploy hạ tầng consume
fi
printf '⏱  Còn %d phút %02d giây tới ranh giới epoch (ngưỡng cần: %d phút).\n' \
  $(( CON_LAI_GIAY / 60 )) $(( CON_LAI_GIAY % 60 )) $(( NGUONG / 60 ))
if [ "$CON_LAI_GIAY" -lt "$NGUONG" ]; then
  echo
  echo "⛔ KHÔNG ĐỦ THỜI GIAN — dừng TRƯỚC khi chạm vào bất cứ thứ gì."
  echo "   Chạy tiếp bây giờ thì fire sinh batch ở epoch này, bước tiêu rơi sang epoch"
  echo "   sau, và batch đó đã chết (schedule_decay_window = 1). Mất một ô fire + một epoch."
  echo
  echo "   Chờ qua ranh giới epoch rồi chạy lại đúng lệnh này — lịch còn nhiều ô fire, không"
  echo "   phải chờ lại 2 epoch."
  echo
  echo "   Biết mình đang làm gì và vẫn muốn chạy: BO_QUA_CONG_NUA_DEM=1 bash $0 $NET 2 $VAULT_TX"
  [ "${BO_QUA_CONG_NUA_DEM:-}" = "1" ] || exit 3
  echo "   ⚠ BO_QUA_CONG_NUA_DEM=1 — chạy tiếp theo yêu cầu."
fi
for v in LAMP_POLICY_ID SHARD_NFT_POLICY_ID VAULT_SCHEDULE_HASH REF_VAULT_SCHEDULE_UTXO; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || { echo "✗ thiếu $v — chạy chặng 1 trước, hoặc điền vào $STATE_FILE"; exit 1; }
done

# 09 TRƯỚC fire: batch MAGIC chỉ sống trong đúng epoch nó sinh ra (decay_window=1).
# Bộ khoá consume mang hậu tố `_SCHEDULE` (scripts/consumeBook.ts); 09 chọn vault theo
# VAULT_KIND, không theo VAULT_HASH nữa.
export VAULT_KIND=schedule

# 🔴 09 ĐÚC PRICE NFT ONE-SHOT. Chạy lại nó là genesis_ref mới ⟹ price_nft_policy mới
#    ⟹ apply-param của `consume` đổi ⟹ script hash đổi ⟹ ĐỊA CHỈ đổi ⟹ mọi Engage
#    UTxO đang sống thành mồ côi, kèm toàn bộ kế toán tiêu dùng trong đó. Nên chạy 09
#    ĐÚNG MỘT LẦN cho mỗi loại vault, rồi từ đó DÒ LẠI UTxO sống theo NFT danh tính.
#    Chỉ hash/policy mới cache được — PRICE_BEACON_UTXO và ENGAGE_UTXO bị tiêu và tạo
#    lại sau mỗi tx consume, cache chúng là trỏ vào UTxO đã chết.
if [ -n "${CONSUME_SCRIPT_HASH_SCHEDULE:-}" ] && [ -n "${REF_CONSUME_UTXO_SCHEDULE:-}" ]; then
  echo; echo "▶ [1/3] Dùng lại hạ tầng consume $CONSUME_SCRIPT_HASH_SCHEDULE — dò UTxO sống…"
  # 🔴 Bản trước ở đây là MỘT dòng `eval "$(npx tsx resolve_consume_state.ts)"`. Cùng
  #   một lỗ đã vá ở `run_consume_e2e.sh` — lý lẽ đầy đủ nằm ở đó, đừng chép xuống đây.
  #   Tóm tắt đủ để biết vì sao dòng này dài hơn: `eval "$(cmd)"` VỨT mã thoát của
  #   `cmd`, và `eval` trên một chuỗi rỗng trả 0, nên `set -e` không bao giờ bắn dù
  #   resolver `process.exit(1)`.
  #
  #   Tệp này lọt đợt vá trước vì đợt ấy lấy phạm vi bằng phạm vi của TRIỆU CHỨNG —
  #   lỗi được báo ở `run_consume_e2e.sh` nên chỉ tệp đó được mở. Hai runner là anh em
  #   cùng thư mục, dùng chung đúng một resolver.
  RESOLVED="$(npx tsx resolve_consume_state.ts)" || {
    echo "✗ [1/3] resolve_consume_state.ts thoát khác 0 — KHÔNG dò được UTxO sống."
    echo "     Đừng chạy tiếp: bước sau sẽ dùng giá trị cũ còn sót trong môi trường."
    exit 1
  }
  eval "$RESOLVED"
  [ -n "${PRICE_BEACON_UTXO_SCHEDULE:-}" ] || { echo "✗ [1/3] resolver không in PRICE_BEACON_UTXO_SCHEDULE"; exit 1; }
  [ -n "${ENGAGE_UTXO_SCHEDULE:-}" ]       || { echo "✗ [1/3] resolver không in ENGAGE_UTXO_SCHEDULE"; exit 1; }
  [ -n "${REF_CONSUME_UTXO_SCHEDULE:-}" ]  || { echo "✗ [1/3] REF_CONSUME_UTXO_SCHEDULE rỗng — bước [3] không dựng nổi tx (vượt trần 16384 byte)"; exit 1; }
else
  echo; echo "▶ [1/3] Deploy hạ tầng consume (09) cho vault ScheduleGen — ĐẶT TRƯỚC fire, có chủ ý…"
  OUT09="$(npx tsx deploy/09_deploy_consume.ts | tee /dev/tty)"
  eval "$(printf '%s\n' "$OUT09" | grep '^export ' || true)"
  [ -n "${PRICE_BEACON_UTXO_SCHEDULE:-}" ] || { echo "✗ 09 không in export block"; exit 1; }
  [ -n "${REF_CONSUME_UTXO_SCHEDULE:-}" ]  || { echo "✗ 09 không in REF_CONSUME_UTXO_SCHEDULE — bước [3] không dựng nổi tx"; exit 1; }
  # Lưu ĐỊNH DANH BẤT BIẾN (không lưu hai UTxO — chúng đổi sau mỗi tx).
  for v in CONSUME_SCRIPT_HASH PRICE_NFT_POLICY PRICE_NFT_UNIT PRICE_PARAM_HASH \
           ENGAGE_NFT_POLICY ENGAGE_NFT_UNIT MAX_PRICE_STALE REF_CONSUME_UTXO; do
    eval "val=\${${v}_SCHEDULE:-}"
    [ -n "$val" ] && persist "${v}_SCHEDULE" "$val"
  done
fi

echo; echo "▶ [2/3] Bắn lịch (schedule_fire_only) — sinh magic_batches…"
export VAULT_TX_HASH="$VAULT_TX"
npx tsx test/schedule_fire_only.ts

echo; echo "▶ [3/3] Tiêu MAGIC thật (co-spend Engage + vault ScheduleGen BurnBatch)…"
npx tsx test/consume_only.ts

echo; echo "✅ HOÀN TẤT e2e consume qua ScheduleGen trên $NET"
