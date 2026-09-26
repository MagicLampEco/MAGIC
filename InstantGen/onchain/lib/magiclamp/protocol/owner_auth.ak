// lib/owner_auth.ak — xác thực chủ vault theo `Credential`.

use aiken/collection/list
use aiken/collection/pairs
use cardano/address.{Credential, Script, VerificationKey}
use cardano/certificate.{
  Certificate, DelegateBlockProduction, DelegateCredential, RegisterAndDelegateCredential,
  RegisterCredential, UnregisterCredential,
}
use cardano/transaction.{Transaction, placeholder}

// `VaultDatum.owner` là `Credential`, không còn là pkh trần. Hai nhánh, KHÔNG nhánh thứ ba:
//
//   VerificationKey(pkh) ⟹ pkh nằm trong `tx.extra_signatories` (hành vi cũ, nguyên vẹn).
//   Script(h)            ⟹ `tx.withdrawals` có khoá `Script(h)` (lượng nào cũng được), VÀ
//                          tx không mang chứng chỉ vòng đời stake nào về `Script(h)`.
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
// Và mục rút là bằng chứng cho CẢ tx, không cho một việc: tx nào script chủ gật thì mọi
// nhánh cần owner trong tx đó đều qua, kể cả nhánh rút LAMP (không ép đích). Script chủ
// hoặc ví ký cho nó phải soát nội dung tx; validator này không thấy redeemer của script chủ.
//
// Tx KHÔNG được mang chứng chỉ vòng đời stake nào về chính `Script(h)` — đăng ký, huỷ đăng
// ký, uỷ thác, đăng ký-kèm-uỷ-thác (2026-09-26). Tx THU HỒI của script chủ (ví dụ huỷ đăng ký
// một DID không hoạt động mà không cần chữ ký chủ) mang `UnregisterCredential(Script(h))`, và
// khi số dư thưởng đã bằng 0 thì nó mang được luôn một mục rút 0 từ `Script(h)`. Không có vế
// này, người nộp tx thu hồi thành chủ vault của nạn nhân ngay trong tx đó. Chủ thật không cần
// đổi vòng đời stake cùng tx với việc vault: tách thành hai tx.
//
// Lượng rút KHÔNG phải đại lượng phân biệt, và bản cổng "lượng phải bằng 0" đã bị bỏ. Ledger
// ép mục rút bằng đúng số dư thưởng, nên lượng chỉ nói số dư ĐANG là bao nhiêu, không nói tx
// là của ai: tx thu hồi mang rút 0 khi số dư đã về 0, còn tx của chủ thật mang lượng > 0 mỗi
// khi có thưởng. Cổng đó chặn đường của chủ mà không chặn tx thu hồi.
//
// Vế chứng chỉ chỉ ĐỦ khi script chủ giữ một hợp đồng: nhánh nào của nó gật mà không cần ý chủ
// thì chỉ gật khi tx có `UnregisterCredential` của chính nó trong CÙNG tx. Một nhánh gật mục
// rút (quét thưởng) mà không kèm chứng chỉ đó thì không cổng nào ở đây phân biệt được với lượt
// gật của chủ. Hợp đồng này là nghĩa vụ của bên giữ script chủ; với `did_stake` của PhoenixKey,
// hôm nay `withdraw` và `publish` đều đòi controller + thiết bị ký, chưa có nhánh gật-không-cần-chủ.
//
// h phải ĐÃ ĐĂNG KÝ làm stake credential. Chưa đăng ký, hoặc bị huỷ đăng ký, thì không mục rút
// nào hợp lệ ⟹ mọi nhánh cần owner đóng băng tới khi đăng ký lại. Đăng ký không đòi chứng từ
// của h, nên người lạ cũng đăng ký lại được: trạng thái đóng băng này không do chủ điều khiển.
//
// Chủ `Script(h)` KẾ THỪA vòng đời của h: script h từ chối (ví dụ DID rời trạng thái hoạt động,
// hay h đổi vì script gốc bị dựng lại với tham số khác) ⟹ mọi nhánh cần owner đóng băng, và
// datum KHÔNG có nhánh đổi chủ. Nhánh `validate_withdraw_lamp` / `Draw` nằm trong số đó.
pub fn owner_authorized(tx: Transaction, owner: Credential) -> Bool {
  when owner is {
    VerificationKey(pkh) -> list.has(tx.extra_signatories, pkh)
    Script(h) ->
      pairs.has_key(tx.withdrawals, Script(h)) && !list.any(
        tx.certificates,
        fn(c) { touches_stake_lifecycle(c, Script(h)) },
      )
  }
}

// Chứng chỉ có đổi vòng đời stake của `cred` không. Bốn biến thể mang trường `credential` của
// một stake credential; các biến thể DRep / pool / uỷ ban nói về vai khác, không tính.
fn touches_stake_lifecycle(cert: Certificate, cred: Credential) -> Bool {
  when cert is {
    RegisterCredential { credential, .. } -> credential == cred
    UnregisterCredential { credential, .. } -> credential == cred
    DelegateCredential { credential, .. } -> credential == cred
    RegisterAndDelegateCredential { credential, .. } -> credential == cred
    _ -> False
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

// Lượng > 0 là tx của chủ khi tài khoản thưởng đang có thưởng — nhận. Đổi ĐÚNG một biến so
// với `owner_auth_script_withdraw_zero_ok`.
test owner_auth_script_positive_withdrawal_ok() {
  owner_authorized(oa_tx([], [Pair(Script(oa_h), 7)]), Script(oa_h))
}

fn oa_tx_c(wds: Pairs<Credential, Int>, certs: List<Certificate>) -> Transaction {
  Transaction { ..placeholder, withdrawals: wds, certificates: certs }
}

// Hình dạng tx thu hồi: huỷ đăng ký `Script(h)` + rút 0 ⟹ từ chối. Đổi ĐÚNG một biến (thêm
// chứng chỉ) so với `owner_auth_script_withdraw_zero_ok`.
test owner_auth_script_unregister_cert_rejected() {
  !owner_authorized(
    oa_tx_c(
      [Pair(Script(oa_h), 0)],
      [UnregisterCredential { credential: Script(oa_h), refund: Never }],
    ),
    Script(oa_h),
  )
}

test owner_auth_script_register_cert_rejected() {
  !owner_authorized(
    oa_tx_c(
      [Pair(Script(oa_h), 0)],
      [RegisterCredential { credential: Script(oa_h), deposit: Never }],
    ),
    Script(oa_h),
  )
}

test owner_auth_script_delegate_cert_rejected() {
  !owner_authorized(
    oa_tx_c(
      [Pair(Script(oa_h), 0)],
      [
        DelegateCredential {
          credential: Script(oa_h),
          delegate: DelegateBlockProduction { stake_pool: oa_h },
        },
      ],
    ),
    Script(oa_h),
  )
}

test owner_auth_script_register_and_delegate_cert_rejected() {
  !owner_authorized(
    oa_tx_c(
      [Pair(Script(oa_h), 0)],
      [
        RegisterAndDelegateCredential {
          credential: Script(oa_h),
          delegate: DelegateBlockProduction { stake_pool: oa_h },
          deposit: 2_000_000,
        },
      ],
    ),
    Script(oa_h),
  )
}

// Chứng chỉ về credential KHÁC không chạm cổng — cặp dương của các ca trên.
test owner_auth_script_other_credential_cert_ok() {
  owner_authorized(
    oa_tx_c(
      [Pair(Script(oa_h), 0)],
      [UnregisterCredential { credential: Script(oa_h_other), refund: Never }],
    ),
    Script(oa_h),
  )
}

// Cùng 28 byte, khác tag: chứng chỉ về KHOÁ `VerificationKey(h)` không phải về `Script(h)`.
test owner_auth_script_vk_cert_same_bytes_ok() {
  owner_authorized(
    oa_tx_c(
      [Pair(Script(oa_h), 0)],
      [UnregisterCredential { credential: VerificationKey(oa_h), refund: Never }],
    ),
    Script(oa_h),
  )
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
