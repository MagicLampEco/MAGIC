# state_book_guard.sh — gác hai sổ trạng thái TRƯỚC khi `source` chúng.
#
# Tệp này được `.` vào, không chạy thẳng. Nó định nghĩa đúng một hàm.
#
# ── Lỗ mà nó bịt ─────────────────────────────────────────────────────────────
#
# `state.$NET.sh` và `deployed.$NET.env` do MÁY ghi thêm (`persist()`), cả hai đã
# gitignore, và các runner nạp chúng bằng `set -a; . sổ; set +a`. Hình dạng đó đưa
# MỌI dòng gán trong sổ thẳng vào môi trường, và môi trường thì thắng mặc định của
# `config.ts`.
#
# Phần lớn nội dung sổ đi đường đó là ĐÚNG: hash, địa chỉ, `LAMP_POLICY_ID` đã
# deploy — đó là lý do sổ tồn tại. Cái KHÔNG được đi đường đó là bốn biến mà
# `config.ts` coi là LỜI KHAI Ý ĐỊNH CỦA NGƯỜI GÕ LỆNH. Chính `config.ts` viết ra
# tiền đề ấy thành chữ — "đặt … **trong cùng một lệnh**" (`config.ts` ▸ thông điệp
# của `LAMP_ASSET_NAME_NONCANONICAL` và `CARP_IDENTITY_NONCANONICAL`). Một dòng nằm
# sẵn trong sổ khai hộ thì cổng vẫn xanh trong khi không người nào khai gì, và cái
# nó gác là apply-param: sai ở đó là sai script hash ⟹ sai địa chỉ ⟹ không sửa được
# bằng cấu hình về sau.
#
# `LAMP_POLICY_ID` CỐ Ý không nằm trong danh sách: sổ đặt nó là đường chạy bình
# thường, và `run_consume_e2e.sh` còn kiểm nó rỗng hay không ngay sau khi nạp sổ.
# Thêm nó vào đây là dựng một cổng kêu oan vào lối đi hợp lệ — thứ sẽ bị tắt.
#
# ── Vì sao fail-safe (ném) chứ không fail-open ───────────────────────────────
#
# Đây là PHÉP KIỂM KHẲNG ĐỊNH, không phải hook chặn thao tác. Theo bảng chiều-hỏng
# ở `Forall §Cổng gác`: hỏng-mà-chặn thì người bị chặn BIẾT; hỏng-mà-cho-qua thì
# không ai biết, và ở đây cái "xanh" đó đi thẳng vào một giao dịch nướng giá trị
# vào bytes.
#
# ── Cổng này KHÔNG bắt được gì ───────────────────────────────────────────────
#
# Nó đọc VĂN BẢN của sổ, nên nó mù với: giá trị đặt qua một biến trung gian
# (`X=1; CARP_IDENTITY_NONCANONICAL=$X`), dòng sinh ra bởi lệnh trong sổ
# (`eval`/`printf`), và mọi biến khai ý định được thêm vào `config.ts` sau này mà
# không ai bổ sung tên vào đây. Mức đúng của nó là "chặn được hình dạng mà
# `persist()` sinh ra", không phải "bịt kín".

# Bốn tên này phải khớp `config.ts`. Đổi bên đó thì đổi cả ở đây — không có cơ chế
# nào ép hai danh sách đi cùng nhau, nên đây là một bản sao có nhãn, đúng mức 3 của
# `Forall §Một nguồn`: con trỏ tới nguồn là `scripts/config.ts` ▸ `requireCarpIdentity`
# và ▸ phép kiểm `LAMP_ASSET_NAME_NONCANONICAL`; mốc chép 2026-09-20.
STATE_BOOK_CO_Y_DINH='CARP_IDENTITY_NONCANONICAL|LAMP_ASSET_NAME_NONCANONICAL|CARP_POLICY_ID|CARP_ASSET_NAME'

# assert_state_books_khong_khai_y_dinh <sổ> [sổ…]
# Ném (exit 1) nếu một sổ có mặt chứa dòng gán một trong bốn tên trên.
assert_state_books_khong_khai_y_dinh() {
  local co_loi=0 da_xet=0 vang_mat=0 f hit
  for f in "$@"; do
    if [ ! -f "$f" ]; then
      vang_mat=$((vang_mat + 1))
      continue
    fi
    da_xet=$((da_xet + 1))
    hit=$(grep -nE "^[[:space:]]*(export[[:space:]]+)?($STATE_BOOK_CO_Y_DINH)=" "$f" || true)
    if [ -n "$hit" ]; then
      {
        echo "✗ Sổ \`$f\` khai hộ một biến Ý ĐỊNH:"
        echo "$hit" | sed 's/^/     /'
      } >&2
      co_loi=1
    fi
  done

  # Phạm vi của phép đo, in kèm kết quả (Forall §Cổng gác vế a+b): nói rõ đã xét
  # mấy sổ và mấy sổ vắng mặt — "xanh" trên 0 sổ không phải "xanh".
  echo "   cổng sổ: đã xét $da_xet sổ, $vang_mat sổ chưa có trên đĩa."

  if [ "$co_loi" -ne 0 ]; then
    {
      echo
      echo "  Bốn biến đó là LỜI KHAI của người gõ lệnh, không phải dữ liệu deploy."
      echo "  \`config.ts\` đòi chúng được đặt TRONG CÙNG MỘT LỆNH, và hai sổ thì được"
      echo "  nạp bằng \`set -a\` nên một dòng nằm sẵn ở đó khai hộ vĩnh viễn."
      echo
      echo "  Đường đúng: gỡ dòng đó khỏi sổ, rồi nếu thật sự có ý định thì đặt ngay"
      echo "  trước lệnh — ví dụ:  CARP_IDENTITY_NONCANONICAL=1 bash <runner> …"
    } >&2
    return 1
  fi
}
