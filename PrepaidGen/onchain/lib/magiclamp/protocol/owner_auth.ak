// lib/owner_auth.ak — xác thực chủ vault PrepaidGen theo `Credential`.

use aiken/collection/list
use aiken/collection/pairs
use cardano/address.{Credential, Script, VerificationKey}
use cardano/transaction.{Transaction, placeholder}

// `PrepaidVaultDatum.owner` là `Credential`, không còn là pkh trần. Hai nhánh, KHÔNG nhánh
// thứ ba:
//
//   VerificationKey(pkh) ⟹ pkh nằm trong `tx.extra_signatories` (hành vi cũ, nguyên vẹn).
//   Script(h)            ⟹ `tx.withdrawals` có khoá `Script(h)`. Lượng rút KHÔNG ép — rút 0
//                          là đủ. Ledger chỉ nhận một mục rút khi validator `withdraw` của h
//                          CHẠY và gật, nên sự có mặt của khoá đó là bằng chứng script chủ
//                          đã phê duyệt CHÍNH giao dịch này.
//
// Hai chỗ cố ý KHÔNG tính:
//   - `Script(h)` mà h chỉ nằm trong `extra_signatories`: script hash không ký được; 28 byte
//     trùng h trong danh sách ký là khoá của ai đó KHÁC.
//   - `VerificationKey(pkh)` mà chỉ có mục rút `Script(pkh)`: hai không gian hash khác nhau;
//     cho lẫn là để một script trùng 28 byte ký thay chủ.
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
// Và h phải được ĐĂNG KÝ làm stake credential trên chuỗi, không thì không mục rút nào dựng
// được ⟹ vault khoá vĩnh viễn. Cả hai là việc của bên dựng vault ngoài chuỗi.
//
// `platform` của `PaidFundDatum` KHÔNG đi qua hàm này — nó vẫn là pkh trần.
pub fn owner_authorized(tx: Transaction, owner: Credential) -> Bool {
  when owner is {
    VerificationKey(pkh) -> list.has(tx.extra_signatories, pkh)
    Script(h) -> pairs.has_key(tx.withdrawals, Script(h))
  }
}

// ── Bài kiểm đơn vị — mỗi bài đổi ĐÚNG một biến so với cặp dương của nó ──────
const oa_h: ByteArray = #"5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c"

const oa_h_other: ByteArray =
  #"5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d"

fn oa_tx(sigs: List<ByteArray>, wds: Pairs<Credential, Int>) -> Transaction {
  Transaction { ..placeholder, extra_signatories: sigs, withdrawals: wds }
}

test owner_auth_script_withdraw_zero_ok() {
  owner_authorized(oa_tx([], [Pair(Script(oa_h), 0)]), Script(oa_h))
}

test owner_auth_script_no_withdrawal_rejected() {
  !owner_authorized(oa_tx([], []), Script(oa_h))
}

test owner_auth_script_other_withdrawal_rejected() {
  !owner_authorized(oa_tx([], [Pair(Script(oa_h_other), 0)]), Script(oa_h))
}

test owner_auth_script_hash_in_signatories_rejected() {
  !owner_authorized(oa_tx([oa_h], []), Script(oa_h))
}

// Cùng 28 byte, khác tag: mục rút là của KHOÁ `VerificationKey(h)`, chủ là `Script(h)`.
test owner_auth_script_vk_withdrawal_same_bytes_rejected() {
  !owner_authorized(oa_tx([], [Pair(VerificationKey(oa_h), 0)]), Script(oa_h))
}

test owner_auth_vk_signed_ok() {
  owner_authorized(oa_tx([oa_h], []), VerificationKey(oa_h))
}

test owner_auth_vk_script_withdrawal_unsigned_rejected() {
  !owner_authorized(oa_tx([], [Pair(Script(oa_h), 0)]), VerificationKey(oa_h))
}
