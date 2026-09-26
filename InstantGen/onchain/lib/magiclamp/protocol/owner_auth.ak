// lib/owner_auth.ak — xác thực chủ vault theo `Credential`.

use aiken/collection/list
use aiken/collection/pairs
use cardano/address.{Credential, Script, VerificationKey}
use cardano/transaction.{Transaction}

// `VaultDatum.owner` là `Credential`, không còn là pkh trần. Hai nhánh, KHÔNG nhánh thứ ba:
//
//   VerificationKey(pkh) ⟹ pkh nằm trong `tx.extra_signatories` (hành vi cũ, nguyên vẹn).
//   Script(h)            ⟹ `tx.withdrawals` có khoá `Script(h)`. Lượng rút KHÔNG ép — rút
//                          0 là đủ. Ledger chỉ chấp nhận một mục rút khi validator
//                          `withdraw` của h CHẠY và gật, nên sự có mặt của khoá đó là bằng
//                          chứng script chủ đã phê duyệt CHÍNH giao dịch này.
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
// Lượng rút: validator này không ép, nhưng LEDGER ép — mục rút phải bằng ĐÚNG số dư thưởng
// hiện có của credential. Chưa uỷ thác pool thì số dư là 0 ("withdraw-zero"); đã uỷ thác thì
// số dư có thể > 0, và bộ dựng tx gõ cứng 0 sẽ bị ledger từ chối. Bộ dựng phải TRA số dư.
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
    Script(h) -> pairs.has_key(tx.withdrawals, Script(h))
  }
}
