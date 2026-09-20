# state_book_guard.sh — gác hai sổ trạng thái TRƯỚC khi `source` chúng.
#
# Tệp này được `.` vào, không chạy thẳng. Nó định nghĩa đúng một hàm.
#
# ── Lỗ mà nó bịt ─────────────────────────────────────────────────────────────
#
# `state.$NET.sh` và `deployed.$NET.env` do MÁY ghi thêm, cả hai đã gitignore, và
# các runner nạp chúng bằng `set -a; . sổ; set +a`. Hình dạng đó đưa MỌI dòng gán
# trong sổ thẳng vào môi trường, và môi trường thì thắng mặc định của `config.ts`.
#
# Phần lớn nội dung sổ đi đường đó là ĐÚNG: hash, địa chỉ, `LAMP_POLICY_ID` đã
# deploy — đó là lý do sổ tồn tại.
#
# ── VỊ NGỮ: tên nào bị chặn, và vì sao KHÔNG phải "tên config.ts gọi là ý định" ──
#
# Bản đầu của tệp này chặn đúng bốn tên mà `config.ts` gắn nhãn "lời khai ý định".
# Vị ngữ đó SAI, và sai theo chiều cho lọt: cả bốn tên ấy đã có một cổng thứ hai
# đứng sau ở `config.ts`, tức chúng là nhóm ÍT cần gác nhất. Nhóm cần gác là nhóm
# NGƯỢC LẠI.
#
# Vị ngữ đúng, và là vị ngữ đang dùng:
#
#     một dòng nằm sẵn trong sổ QUYẾT ĐỊNH được biến này, mà KHÔNG có phép kiểm
#     nào đứng sau nó.
#
# Theo vị ngữ đó, danh sách gồm hai nhóm:
#
#   (a) bốn tên khai ý định — giữ lại. Chúng có cổng thứ hai, nhưng tiền đề của
#       cổng ấy được `config.ts` viết thành chữ: "đặt … TRONG CÙNG MỘT LỆNH". Một
#       dòng nằm sẵn trong sổ khai hộ vĩnh viễn, nên nó phá đúng tiền đề đó.
#
#   (b) bốn tên KHÔNG có cổng nào đứng sau:
#       · `BUFFER_BPS`   — `deploy/10_deploy_prepaid.ts` nướng vào datum quỹ, và
#                          chính tệp đó khai nó BẤT BIẾN suốt đời quỹ.
#       · `PLATFORM_PKH` — khoá DUY NHẤT claim được CARP của quỹ.
#       · `WALLET_SEED` · `BLOCKFROST_KEY` — đổi ví ký và đổi nhà cung cấp dữ
#                          liệu chuỗi. Runner chỉ đánh dấu chúng để export, không
#                          khôi phục giá trị, nên một dòng trong sổ thắng vĩnh viễn.
#
# `LAMP_POLICY_ID` CỐ Ý đứng ngoài: sổ đặt nó là đường chạy bình thường, và
# `run_consume_e2e.sh` còn kiểm nó rỗng hay không ngay sau khi nạp sổ. Thêm nó vào
# đây là dựng một cổng kêu oan vào lối đi hợp lệ — thứ sẽ bị tắt.
#
# ── Vì sao danh-sách-CHẶN, không phải danh-sách-CHO-PHÉP ─────────────────────
#
# Danh-sách-cho-phép là hình thức chặt hơn và đã được cân nhắc. Bị loại vì một số
# đo: `state.Preprod.sh` hiện mang **45 dòng gán** (đếm 2026-09-20 bằng
# `grep -cE '^[[:space:]]*(export[[:space:]]+)?[A-Z_]+=' state.Preprod.sh`). Một
# danh sách 45 mục phải được sửa mỗi lần một script deploy ghi thêm khoá, và lần
# quên đầu tiên thì cổng chặn một lượt chạy HỢP LỆ. Đó đúng chiều hỏng mà
# `Forall §Cổng gác` nói là sẽ dẫn tới việc cổng bị tắt. Danh-sách-chặn hỏng theo
# chiều cho lọt — tệ hơn về lý thuyết, nhưng nó không tự giết mình.
#
# ── Cổng này KHÔNG in giá trị, có chủ đích ───────────────────────────────────
#
# Nó in `sổ:dòng: TÊN`, không in phần sau dấu `=`. Hai tên trong nhóm (b) là bí
# mật; một cổng in nguyên dòng khớp sẽ đẩy hạt giống ví ra terminal và ra log CI
# đúng vào lúc nó tưởng mình đang bảo vệ. Số dòng là đủ để người bị chặn tìm ra
# chỗ cần sửa.
#
# ── Cổng này KHÔNG bắt được gì ───────────────────────────────────────────────
#
# Nó đọc VĂN BẢN của sổ, nên nó mù với: giá trị đặt qua một biến trung gian
# (`X=1; CARP_IDENTITY_NONCANONICAL=$X`), dòng sinh bởi lệnh trong sổ
# (`eval`/`printf`), gán sau dấu `;` hoặc `&&`, `declare -x` / `typeset` /
# `readonly`, gán trong khối `{ }`, và mọi biến quyết-định-được thêm về sau mà
# không ai bổ sung tên vào đây. Mức đúng của nó là "chặn được hình dạng mà máy
# sinh ra", không phải "bịt kín".
#
# Phép đo chặt hơn là đo HÀNH VI chứ không đo văn bản: `source` sổ trong một
# subshell rồi so `env` trước/sau. Chưa làm, vì nó chạy chính nội dung sổ để biết
# sổ có an toàn không — đổi một lỗ lấy một lỗ khác. Ghi ra đây để lần sau không
# phải nghĩ lại từ đầu.

# Tám tên này là một bản sao có nhãn, đúng mức 3 của `Forall §Một nguồn`. Nguồn:
# `scripts/config.ts` ▸ `requireCarpIdentity` và ▸ phép kiểm
# `LAMP_ASSET_NAME_NONCANONICAL` cho nhóm (a); `scripts/deploy/10_deploy_prepaid.ts`
# cho `BUFFER_BPS` + `PLATFORM_PKH`. Mốc chép 2026-09-20. Không cơ chế nào ép hai
# danh sách đi cùng nhau — đổi bên kia thì đổi cả ở đây.
STATE_BOOK_CO_Y_DINH='CARP_IDENTITY_NONCANONICAL|LAMP_ASSET_NAME_NONCANONICAL|CARP_POLICY_ID|CARP_ASSET_NAME|BUFFER_BPS|PLATFORM_PKH|WALLET_SEED|BLOCKFROST_KEY'

# assert_state_books_khong_khai_y_dinh <sổ> [sổ…]
# Ném (exit 1) khi một sổ có mặt chứa dòng gán một trong tám tên trên, VÀ khi một
# sổ có mặt mà không quét được.
#
# Ba trạng thái, không phải hai (`Forall §Cổng gác`): khớp · lệch · KHÔNG ĐO ĐƯỢC.
# Trạng thái thứ ba kêu TO HƠN thứ hai, vì nó là trạng thái mù. Bản đầu của hàm này
# viết `$(grep … || true)`, và hình dạng đó nuốt mã thoát ≥2 của grep (grep vắng
# mặt trên PATH, sổ không có quyền đọc, grep lỗi) thành chuỗi rỗng — y hệt ca
# "không khớp". Ba đường im lặng cùng trả về ĐẠT.
assert_state_books_khong_khai_y_dinh() {
  local co_loi=0 da_quet=0 vang_mat=0 f hit rc

  for f in "$@"; do
    if [ ! -f "$f" ]; then
      vang_mat=$((vang_mat + 1))
      continue
    fi

    # KHÔNG dùng `|| true`: phải giữ được mã thoát để phân biệt 1 với ≥2.
    hit=$(grep -nE "^[[:space:]]*(export[[:space:]]+)?($STATE_BOOK_CO_Y_DINH)=" "$f")
    rc=$?

    case "$rc" in
      0|1) da_quet=$((da_quet + 1)) ;;
      *)
        echo "✗ KHÔNG ĐO ĐƯỢC sổ \`$f\`: grep thoát $rc." >&2
        echo "  Đây KHÔNG phải 'sổ sạch' — cổng không đọc được nó. Dừng." >&2
        co_loi=1
        continue
        ;;
    esac

    if [ "$rc" -eq 0 ]; then
      {
        echo "✗ Sổ \`$f\` khai hộ một biến mà không phép kiểm nào đứng sau:"
        # Chỉ in `dòng: TÊN`. Phần sau dấu `=` bị cắt — hai tên trong danh sách là
        # bí mật, và một cổng in giá trị là một đường rò mang mặt nạ cổng.
        echo "$hit" | sed -E 's/^([0-9]+):[[:space:]]*(export[[:space:]]+)?([A-Z_]+)=.*/     dòng \1: \3/'
      } >&2
      co_loi=1
    fi
  done

  # Phạm vi của phép đo, in kèm kết quả (`Forall §Cổng gác` vế a+b): đếm sổ đã QUÉT
  # ĐƯỢC, không đếm sổ CÓ MẶT. Hai số đó khác nhau đúng ở ca mù, và đó là ca duy
  # nhất đáng in ra.
  echo "   cổng sổ: quét được $da_quet sổ, $vang_mat sổ chưa có trên đĩa."

  if [ "$co_loi" -ne 0 ]; then
    {
      echo
      echo "  Một dòng nằm sẵn trong sổ thì quyết định vĩnh viễn, vì hai sổ được nạp"
      echo "  bằng \`set -a\` nên mọi dòng gán trong đó thắng mặc định của \`config.ts\`."
      echo
      echo "  Đường đúng: gỡ dòng đó khỏi sổ, rồi nếu thật sự có ý định thì đặt ngay"
      echo "  trước lệnh — ví dụ:  CARP_IDENTITY_NONCANONICAL=1 bash <runner> …"
    } >&2
    return 1
  fi
}
