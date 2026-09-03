// ConsumeMAGIC shared validator helpers.
// Đếm theo PAYMENT SCRIPT HASH (chống double-satisfaction qua stake credential —
// bài học audit C1/C2 Distribution). Test-support builders ở cuối.

use aiken/collection/list
use aiken/interval.{Finite, IntervalBoundType}
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}

/// Epoch tham chiếu cho stale-check, AN TOÀN trước thao túng validity-range.
///
/// LỖ CŨ (đã vá): tính epoch từ lower_bound đơn lẻ. Attacker đặt lower_bound về
/// quá khứ (ledger CHO PHÉP miễn ≤ now) → current_epoch nhỏ giả tạo → beacon CŨ
/// (giá rẻ khi demand thật đang cao) vẫn pass `current − pp.epoch ≤ max_stale` →
/// tiêu MAGIC giá rẻ, phá đúng mục tiêu "giá có thẩm quyền chống spam".
///
/// VÁ TẬN GỐC (2 ràng buộc, first-principles theo bất biến ledger):
///   (1) Dùng UPPER bound làm epoch tham chiếu. Ledger TỪ CHỐI tx nếu now > upper
///       → attacker KHÔNG thể đặt upper về quá khứ mà vẫn submit được → epoch tham
///       chiếu KHÔNG thể nhỏ hơn epoch thật. Đây là trần thời gian PHẢI khai báo.
///   (2) Buộc CẢ HAI biên hữu hạn + cửa sổ `upper − lower ≤ ms_per_epoch` (≤ 1
///       epoch). Chặn `[−∞, finite]` (lower vô hạn → mất kiểm soát) và cửa sổ rộng
///       nhiều epoch (bịa khoảng cách epoch). Cửa sổ hẹp → epoch xác định 2 đầu.
///   (3) [VÁ 2026-08-09] `lo` và `hi` phải CÙNG epoch. Chỉ `hi − lo ≤ ms_per_epoch`
///       KHÔNG đủ: cửa sổ cưỡi ranh giới (lo ở cuối epoch e, hi ở đầu epoch e+1)
///       thoả ràng buộc độ-rộng nhưng trả về e+1 trong khi thời gian THẬT của tx có
///       thể vẫn ở e ⇒ epoch bị THỔI PHỒNG thêm 1. Hệ quả: stale-check
///       `current − pp.epoch ≤ max_stale` bị nới thêm 1 epoch, và mọi mốc so-với-
///       epoch khác lệch 1. Ép cùng epoch ⇒ epoch tham chiếu XÁC ĐỊNH, bất kể
///       ledger chọn slot nào trong cửa sổ.
///
/// ms_per_epoch network-specific (Preview 86_400_000; Mainnet 432_000_000).
pub fn get_epoch(tx: Transaction, ms_per_epoch: Int) -> Int {
  expect Some(lo) = tx.validity_range.lower_bound.bound_type |> get_finite
  expect Some(hi) = tx.validity_range.upper_bound.bound_type |> get_finite
  // Cửa sổ hợp lệ + ≤ 1 epoch (không bịa khoảng cách epoch giữa 2 biên).
  expect hi >= lo
  expect hi - lo <= ms_per_epoch
  // CÙNG epoch cả 2 biên → epoch tham chiếu không phụ thuộc slot ledger chọn.
  expect lo / ms_per_epoch == hi / ms_per_epoch
  // Epoch tham chiếu = từ TRẦN thời gian (upper) → không under-state được.
  hi / ms_per_epoch
}

pub fn get_finite(bt: IntervalBoundType) -> Option<Int> {
  when bt is {
    Finite(s) -> Some(s)
    _ -> None
  }
}

/// Address của chính UTxO đang spend.
pub fn own_address(own_ref: OutputReference, inputs: List<Input>) -> Address {
  expect Some(i) = list.find(inputs, fn(x) { x.output_reference == own_ref })
  i.output.address
}

/// Script hash của chính validator đang chạy.
pub fn own_script_hash(own_addr: Address) -> ByteArray {
  expect Script(h) = own_addr.payment_credential
  h
}

pub fn is_at_script(addr: Address, script_hash: ByteArray) -> Bool {
  when addr.payment_credential is {
    Script(h) -> h == script_hash
    _ -> False
  }
}

pub fn count_inputs_at_script(inputs: List<Input>, script_hash: ByteArray) -> Int {
  list.count(inputs, fn(x) { is_at_script(x.output.address, script_hash) })
}

pub fn count_outputs_at_script(outputs: List<Output>, script_hash: ByteArray) -> Int {
  list.count(outputs, fn(x) { is_at_script(x.address, script_hash) })
}

pub fn input_at_script(inputs: List<Input>, script_hash: ByteArray) -> Output {
  expect Some(i) = list.find(inputs, fn(x) { is_at_script(x.output.address, script_hash) })
  i.output
}

pub fn output_at_script(outputs: List<Output>, script_hash: ByteArray) -> Output {
  expect Some(o) = list.find(outputs, fn(x) { is_at_script(x.address, script_hash) })
  o
}

/// [VÁ 2026-08-09 — double-satisfaction XUYÊN-INSTANCE]
/// MỌI input do SCRIPT khoá trong tx phải nằm ở `hash_a` hoặc `hash_b`; input ví
/// thường (VerificationKey) KHÔNG bị ràng.
///
/// Vì sao cần: `consume` được apply-param (beacon giá / burn_batch_constr /
/// max_price_stale) ⇒ MỖI deploy là MỘT script hash khác nhau, mà nhiều deploy có thể
/// cùng ăn CHUNG một `vault_script_hash`.
/// Bất biến gộp C-CM-2 (`total_required` cộng theo `own_hash`) chỉ nhìn thấy input ở
/// CHÍNH hash của invocation đó ⇒ tx chứa engage_A(H_A) + engage_B(H_B) + 1 vault
/// burn 10M làm CẢ HAI instance tự thấy "10M == 10M" và cùng PASS, trong khi vault
/// chỉ giảm 10M cho 2 nghiệp vụ (đúng ra 20M). Ép "chỉ own_hash hoặc vault" ⇒ instance
/// A thấy input lạ ở H_B và từ chối ngay ⇒ mỗi tx chỉ phục vụ ĐÚNG một instance.
pub fn script_inputs_confined_to(
  inputs : List<Input>,
  hash_a : ByteArray,
  hash_b : ByteArray,
) -> Bool {
  list.all(
    inputs,
    fn(i) {
      when i.output.address.payment_credential is {
        Script(h) -> h == hash_a || h == hash_b
        _ -> True
      }
    },
  )
}

/// Mọi phần tử phân biệt đôi một (O(n²) — chỉ dùng trên list NGẮN, bị cap độ dài).
pub fn all_distinct(xs: List<ByteArray>) -> Bool {
  when xs is {
    [] -> True
    [x, ..rest] -> !list.has(rest, x) && all_distinct(rest)
  }
}

pub fn is_owned_by(addr: Address, pkh: ByteArray) -> Bool {
  when addr.payment_credential is {
    VerificationKey(h) -> h == pkh
    _ -> False
  }
}

// ── Test-support builders (mock UTxO/tx) ─────────────────────

pub fn script_address(hash: ByteArray) -> Address {
  Address { payment_credential: Script(hash), stake_credential: None }
}

pub fn script_address_staked(hash: ByteArray, stake_pkh: ByteArray) -> Address {
  Address {
    payment_credential: Script(hash),
    stake_credential: Some(Inline(VerificationKey(stake_pkh))),
  }
}

pub fn vk_address(pkh: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(pkh), stake_credential: None }
}

pub fn mk_output(addr: Address, value: Value, datum: Data) -> Output {
  Output { address: addr, value: value, datum: InlineDatum(datum), reference_script: None }
}

pub fn mk_output_no_datum(addr: Address, value: Value) -> Output {
  Output { address: addr, value: value, datum: NoDatum, reference_script: None }
}

pub fn mk_input(ref: OutputReference, out: Output) -> Input {
  Input { output_reference: ref, output: out }
}

pub fn mk_ref_id(id: ByteArray, ix: Int) -> OutputReference {
  OutputReference { transaction_id: id, output_index: ix }
}

pub fn mk_ref(ix: Int) -> OutputReference {
  OutputReference { transaction_id: #"00", output_index: ix }
}

// ── Tests get_epoch (vá "thổi phồng epoch thêm 1") ────────────

const ut_mspe: Int = 86_400_000

fn ut_tx(lo: Int, hi: Int) -> Transaction {
  Transaction { ..placeholder, validity_range: interval.between(lo, hi) }
}

test get_epoch_same_epoch_ok() {
  // Cửa sổ nằm TRỌN trong epoch 6 → epoch tham chiếu = 6.
  get_epoch(ut_tx(6 * ut_mspe, 6 * ut_mspe + 1), ut_mspe) == 6
}

test get_epoch_whole_epoch_window_ok() {
  // Biên rộng nhất còn hợp lệ: đầu epoch 6 → sát cuối epoch 6.
  get_epoch(ut_tx(6 * ut_mspe, 7 * ut_mspe - 1), ut_mspe) == 6
}

test get_epoch_cross_epoch_boundary_fail() fail {
  // lo ở CUỐI epoch 5, hi ở ĐẦU epoch 6: `hi − lo = 1 ≤ ms_per_epoch` nên bản CŨ
  // chấp nhận và trả 6, trong khi tx có thể thực sự chạy ở epoch 5 → epoch bị thổi
  // phồng +1 (nới stale-check). Sau vá: lo/mspe(5) != hi/mspe(6) → REJECT.
  get_epoch(ut_tx(6 * ut_mspe - 1, 6 * ut_mspe), ut_mspe) == 6
}

test get_epoch_unbounded_upper_fail() fail {
  let tx = Transaction { ..placeholder, validity_range: interval.after(6 * ut_mspe) }
  get_epoch(tx, ut_mspe) == 6
}
