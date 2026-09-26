// lib/owner_auth.ak — xác thực chủ vault theo `Credential`.

use aiken/collection/list
use aiken/collection/pairs
use cardano/address.{Credential, Script, VerificationKey}
use cardano/transaction.{Transaction}

// `VaultDatum.owner` là `Credential`, không còn là pkh trần. Hai nhánh, KHÔNG nhánh thứ ba:
//
//   VerificationKey(pkh) ⟹ pkh nằm trong `tx.extra_signatories` (hành vi cũ, nguyên vẹn).
//   Script(h)            ⟹ `tx.withdrawals` có khoá `Script(h)` với lượng ĐÚNG BẰNG 0.
//                          Ledger chỉ nhận một mục rút khi validator `withdraw` của h
//                          CHẠY và gật, nên mục rút đó là bằng chứng script chủ đã phê
//                          duyệt CHÍNH giao dịch này.
//
// Hai chỗ cố ý KHÔNG tính:
//   - `Script(h)` mà h chỉ nằm trong `extra_signatories`: một script hash không ký được, và
//     một byte chuỗi 28 byte trùng h trong danh sách ký là khoá của ai đó KHÁC, không phải
//     script.
//   - `VerificationKey(pkh)` mà chỉ có mục rút `Script(pkh)`: hai không gian hash khác nhau;
//     cho lẫn là để một script tình cờ (hoặc cố ý) trùng 28 byte với khoá chủ ký thay chủ.
//
// Rủi ro do NGƯỜI DÙNG chọn, không do validator này: script chủ phải tự ràng buộc nó phê
// duyệt cái gì. Một stake-script gật vô điều kiện thì ai cũng rút 0 được ⟹ ai cũng là chủ.
//
// Lượng rút phải là 0, không chỉ "có mục rút" (2026-09-26). Ledger ép mục rút bằng ĐÚNG số
// dư thưởng hiện có, nên lượng > 0 nghĩa là tx đang QUÉT SẠCH tài khoản thưởng — đúng hình
// dạng tx thu hồi `did_stake`: DID không hoạt động bị huỷ đăng ký mà không cần chữ ký chủ, và
// Cardano đòi số dư = 0 trước khi huỷ, nên tx đó bắt buộc mang một mục rút từ `Script(h)`.
// Nhận lượng > 0 là để người nộp tx thu hồi thành chủ vault của nạn nhân ngay trong tx đó.
// Hệ quả cho bộ dựng: số dư thưởng > 0 thì rút sạch ở một tx RIÊNG trước (tx đó không chạm
// vault), rồi mới dựng tx cần quyền chủ.
//
// h phải ĐÃ ĐĂNG KÝ làm stake credential. Chưa đăng ký, hoặc bị huỷ đăng ký, thì không mục rút
// nào hợp lệ ⟹ mọi nhánh cần owner đóng băng tới khi đăng ký lại.
//
// Chủ `Script(h)` KẾ THỪA vòng đời của h: script h từ chối (ví dụ DID rời trạng thái hoạt động,
// hay h đổi vì script gốc bị dựng lại với tham số khác) ⟹ mọi nhánh cần owner đóng băng, và
// datum KHÔNG có nhánh đổi chủ. Nhánh `validate_withdraw_lamp` / `Draw` nằm trong số đó.
pub fn owner_authorized(tx: Transaction, owner: Credential) -> Bool {
  when owner is {
    VerificationKey(pkh) -> list.has(tx.extra_signatories, pkh)
    Script(h) -> pairs.get_first(tx.withdrawals, Script(h)) == Some(0)
  }
}
