#!/usr/bin/env bash
# scripts/run_prepaid_e2e.sh — PrepaidGen từ genesis tới lượt SINH MAGIC.
#
# PrepaidGen KHÔNG tiêu MAGIC. Việc của nó là `validate_draw`: sinh một batch MAGIC
# ghi vào `magic_batches` của vault, đồng thời chuyển CARP tương ứng sang bên nhận
# (kho của nền tảng — OriLife, AladinWork…). Lượng MAGIC ấy nằm trong vault để
# **làm cơ sở đo mức tiêu thụ** ở chặng sau.
#
# Chặng tiêu là việc của `ConsumeMAGIC`, một script khác, một giao dịch khác. Gộp
# hai chặng dưới một cái tên là cách một người đọc sổ đi tìm cổng tiêu ở trong
# `prepaid.ak` và không thấy gì — `grep consumed_credit PrepaidGen/onchain` → 0 dòng.
#
#   bash run_prepaid_e2e.sh Preprod            # chạy hết phần chạy được không cần CARP
#   bash run_prepaid_e2e.sh Preprod --deploy   # thêm hai giao dịch genesis
#
# Bí mật đi vào bằng GIÁ TRỊ qua môi trường, không in ra:
#   BLOCKFROST_KEY=… WALLET_SEED='…' bash run_prepaid_e2e.sh Preprod --deploy
#
# ── TRẠNG THÁI KỸ THUẬT ──────────────────────────────────────────────────────
#
# | mã       | treo cái gì                          | ràng buộc TẠM (fail-closed)           | khai ở            |
# |----------|--------------------------------------|---------------------------------------|-------------------|
# | Nợ #71   | cặp định danh CARP cho apply-param    | KHÔNG còn treo trên PREPROD. Cặp      | `PrepaidGen/offchain/src/constants.ts` |
# |          | #1/#2 của `paid_fund` và             | canonical nằm ở `carpAssetClass()`,   | `scripts/config.ts` |
# |          | `prepaid_vault`                       | và `requireCarpIdentity()` lấy từ đó. | `DevStatus.md`      |
# |          |                                       | MAINNET vẫn ĐÓNG: `CARP_POLICY_ID`    |                   |
# |          |                                       | của Mainnet là `null` ⟹ hàm NÉM.      |                   |
#
# Vì sao ràng buộc nằm ở tầng mã chứ không ở một biến cấu hình điền sau: hai giá
# trị đó là APPLY-PARAM, tức tham số lúc BIÊN DỊCH. Chúng là một phần của BYTES,
# nên đổi chúng là đổi script hash ⟹ đổi địa chỉ ⟹ mọi UTxO đã tạo ở địa chỉ cũ
# thành mồ côi. Một giá trị giữ chỗ vẫn cho ra hash 28 byte hợp lệ và vẫn deploy
# êm — cái ra đời là một quỹ không bao giờ nhìn thấy CARP của chính nó, và không
# lệnh nào báo đỏ.
#
# KHÔNG đúc một token tạm để lấp chỗ đó. Preprod đã có HAI dòng tài sản cùng hiện
# ra chữ tCARP dưới hai policy khác nhau; dòng thứ ba làm nặng thêm đúng chỗ đang
# phải gỡ, và không phép kiểm hình dạng nào phân biệt được ba dòng ấy. Đó là lý do
# `requireCarpIdentity()` đối chiếu với cặp CANONICAL chứ không chỉ đo hình dạng:
# hình dạng cho cả hai dòng đi qua.
#
# Bước 1–3 KHÔNG chạm ví và KHÔNG chạm mạng — chúng chạy mỗi lượt. Tách như vậy là
# cố ý: một cụm nằm im chờ một dữ kiện sẽ âm thầm già đi, còn một cụm chạy mỗi ngày
# thì hỏng ở đâu kêu ở đó.
#
# ── THỨ TỰ KHÔNG ĐẢO ĐƯỢC ────────────────────────────────────────────────────
#
#   paid_fund(carp…) → paid_fund_hash → prepaid_vault(carp…, paid_fund_hash, …)
#
#   Chiều ngược — quỹ ghim được vault thật lúc quyết toán — đi qua DỮ LIỆU
#   (`PaidFundDatum.vault_hash`, ghim tại genesis), KHÔNG qua tham số biên dịch.
#   Đảo thứ tự là cần hash của vault trước khi nó tồn tại, và lối thoát duy nhất
#   là một giá trị giữ chỗ — tức một script hash trông hợp lệ mà sai vĩnh viễn.
set -euo pipefail

NETWORK="${1:?Thiếu mạng. Dùng: bash run_prepaid_e2e.sh Preprod [--deploy]}"
MODE="${2:-}"

# Cùng cổng mà hai runner consume đã có. Runner này thiếu nó, trong khi nay còn
# `export NETWORK` ra toàn tiến trình con — một chuỗi lạ đi xa hơn trước.
case "$NETWORK" in
  Preview|Preprod) ;;
  *) echo "✗ Tham số 1 phải là Preview hoặc Preprod (nhận: $NETWORK)" >&2; exit 2 ;;
esac

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
ROOT="$PWD/.."
CHECK_JSON="/tmp/prepaid-check.$$.json"
trap 'rm -f "$CHECK_JSON"' EXIT

# ── Nạp tham số CÔNG KHAI của mạng, giống hai runner consume ─────────────────
# Hai sổ, một mạng: `run_wakeme_e2e.sh` và `run_schedule_fire.sh` ghi vào
# `state.$NET.sh`; hai runner consume đọc `deployed.$NET.env`. Runner này trước đây
# KHÔNG đọc sổ nào.
#
# 🔴 PHẠM VI, và nó ĐỔI hành vi ở đúng một chỗ — đừng đọc thành "không đổi gì".
#   `LAMP_POLICY_ID` thì không: `deploy/10_deploy_prepaid.ts` không nhập `POLICY_IDS`
#   nên `requireLampPolicyId()` không nằm trên đường chạy của nó. Đoạn này là chuẩn
#   bị cho chặng SAU — chặng tiêu MAGIC đi qua `consume`, nơi biến đó mới thật sự
#   được đọc.
#   NHƯNG `10_deploy_prepaid.ts` ĐỌC `BUFFER_BPS` và `PLATFORM_PKH` từ môi trường,
#   nên từ lúc có đoạn này, một dòng nằm sẵn trong sổ quyết định được cả hai. Cái
#   thứ nhất bị nướng vào datum quỹ và bất biến suốt đời quỹ; cái thứ hai là khoá
#   duy nhất claim được CARP. Đó chính là lý do cổng ngay dưới gác cả hai tên.
#   Từ 2026-09-26 nó đọc thêm `BENEFICIARY_ADDRESS` + `BENEFICIARY_DATUM` (đích
#   nhận CARP của FundClaim, bất biến suốt đời quỹ, KHÔNG có mặc định) — cổng gác
#   luôn hai tên đó: chúng phải đặt TRONG CÙNG LỆNH gọi runner, không nằm trong sổ.
#   (Bản đầu của chú thích này khai rằng runner "chạy với `LAMP_POLICY_ID` rỗng".
#   Sai: biến đó không được đọc ở đây. Bản thứ hai khai "bốn bước KHÔNG đổi hành
#   vi", rồi nêu ngay hai biến chứng minh điều ngược lại — nó dùng đúng bằng chứng
#   bác mình làm lý do cho mình.)
#
# Đọc sổ CŨ trước, sổ MỚI sau ⟹ `deployed.$NET.env` thắng khi cả hai cùng có.
# Chỉ tham số công khai đi đường này; bí mật vẫn vào bằng GIÁ TRỊ qua môi trường.
. "./state_book_guard.sh"
assert_state_books_khong_khai_y_dinh "state.$NETWORK.sh" "deployed.$NETWORK.env"

NET_ARGV="$NETWORK"
for STATE in "state.$NETWORK.sh" "deployed.$NETWORK.env"; do
  if [ -f "$STATE" ]; then
    echo "▶ Đọc prereq: $STATE"
    set -a; . "./$STATE"; set +a
  fi
done

# Sổ KHÔNG được đổi mạng dưới chân người gõ lệnh. Hai runner consume tránh ca này
# bằng cách giữ argv ở một biến riêng (`NET`) rồi mới export; ở đây thì KÊU thay vì
# lặng lẽ khôi phục — một sổ đổi được mạng là một sổ hỏng, và nó nên hiện ra.
if [ "$NETWORK" != "$NET_ARGV" ]; then
  echo "✗ Sổ vừa nạp đổi mạng: dòng lệnh '$NET_ARGV' → sổ '$NETWORK'." >&2
  echo "  Mọi hash dưới đây ghim theo mạng. Gỡ dòng \`NETWORK=\` khỏi sổ rồi chạy lại." >&2
  exit 1
fi
export NETWORK

echo "=== PrepaidGen E2E · mạng $NETWORK ==="
echo

# ── (1) Aiken: validator biên dịch được và bộ kiểm xanh ─────────────────────
# Phép đo này KHÔNG phụ thuộc cặp định danh CARP: apply-param chưa xảy ra ở bước
# này, `aiken check` chạy trên bản CHƯA apply.
echo "── (1) aiken check · PrepaidGen/onchain"
(
  cd "$ROOT/PrepaidGen/onchain"
  # Quy trình HAI BƯỚC, đừng bỏ bước hai (BOUNDARIES.md §4): qua pipe, v1.1.21 in
  # RỖNG cho MỌI lỗi biên dịch. Đi thẳng vào trình đọc JSON ở nhánh lỗi sẽ ném một
  # lỗi phân tích cú pháp, và lỗi đó trỏ đi chỗ khác.
  if aiken check 2>/dev/null > "$CHECK_JSON"; then
    node -e '
      const d = require(process.argv[1]).summary;
      console.log(`   ${d.passed}/${d.total} xanh, ${d.failed} đỏ`);
      if (d.failed > 0) process.exit(1);
    ' "$CHECK_JSON"
  else
    echo "   ✗ aiken check ĐỎ. Output qua pipe RỖNG là hành vi đã biết của v1.1.21," >&2
    echo "     KHÔNG phải 'không rõ nguyên nhân': chạy lại dưới" >&2
    echo "     \`script -q /dev/null aiken check\` để đọc được lỗi thật." >&2
    exit 1
  fi
)

# ── (2) Cổng tên apply-param ────────────────────────────────────────────────
# Cũng không cần CARP thật: cổng chỉ so TÊN + THỨ TỰ với blueprint, bằng giá trị
# giữ chỗ. Đây là chốt chặn lớp lỗi mà `applyParamsToScript` không bắt — nó không
# kiểm arity, nên thiếu một tham số vẫn ra script hash 28 byte trông hợp lệ.
echo
echo "── (2) đối chiếu tên + thứ tự apply-param"
npx tsx check_param_names.ts | grep -E "PrepaidGen|Tổng kết" | sed 's/^/   /'

# ── (3) Kiểu của toàn bộ scripts/ ───────────────────────────────────────────
echo
echo "── (3) tsc --noEmit · scripts/"
npx tsc --noEmit -p tsconfig.json && echo "   ✓ 0 lỗi kiểu"

if [ "$MODE" != "--deploy" ]; then
  echo
  echo "── DỪNG Ở ĐÂY (không có --deploy)."
  echo "   Ba bước trên là toàn bộ phần đo được mà không cần cặp định danh CARP."
  exit 0
fi

# ── (4) Hai giao dịch genesis ───────────────────────────────────────────────
# `10_deploy_prepaid.ts` tự gác: `requireCarpIdentity()` là dòng đầu của `main()`.
# KHÔNG lặp lại phép kiểm đó ở đây — hai bản sao của một cổng thì bản lỏng hơn là
# bản quyết định, và không bản nào tự khai mình lỏng hơn.
echo
echo "── (4) genesis: quỹ Paid + vault trả trước"
# Fail-closed: thiếu BENEFICIARY_ADDRESS / BENEFICIARY_DATUM thì bước này NÉM
# trước khi chạm mạng (xem khối env ở đầu `deploy/10_deploy_prepaid.ts`).
NETWORK="$NETWORK" npx tsx deploy/10_deploy_prepaid.ts

echo
echo "── CÒN THIẾU sau bước 4, để MAGIC do PrepaidGen SINH RA tiêu được qua ConsumeMAGIC:"
echo "   · một bản \`consume\` apply-param bằng \`vault_script_hash\` của vault vừa tạo."
echo "     \`consume\` ghim vault theo LOẠI (BOUNDARIES.md §2) ⟹ mỗi cửa gen một bản."
echo "   · một beacon giá còn tươi (\`PostPrice\`), và một thread Engage."
echo "   Đường đã chạy thật cho ScheduleGen: \`run_consume_schedule_e2e.sh\` chặng 2."
echo
echo "🔴 Ghi cặp định danh CARP NGAY CẠNH mọi hash vừa in ra, trong sổ deploy."
echo "   Hash ở trên GHIM một đời CARP. Đời đổi ⟹ hash đổi ⟹ địa chỉ đổi, và một"
echo "   dòng sổ không mang định danh thì lần sau không ai phân biệt nổi hai đời."
