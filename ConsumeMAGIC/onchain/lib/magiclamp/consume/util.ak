// ConsumeMAGIC shared validator helpers.
// Đếm theo PAYMENT SCRIPT HASH (chống double-satisfaction qua stake credential —
// bài học audit C1/C2 Distribution). Test-support builders ở cuối.

use aiken/collection/list
use aiken/interval.{Finite, IntervalBoundType}
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{Value}
use cardano/transaction.{InlineDatum, Input, NoDatum, Output, OutputReference, Transaction}

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
///
/// ms_per_epoch network-specific (Preview 86_400_000; Mainnet 432_000_000).
pub fn get_epoch(tx: Transaction, ms_per_epoch: Int) -> Int {
  expect Some(lo) = tx.validity_range.lower_bound.bound_type |> get_finite
  expect Some(hi) = tx.validity_range.upper_bound.bound_type |> get_finite
  // Cửa sổ hợp lệ + ≤ 1 epoch (không bịa khoảng cách epoch giữa 2 biên).
  expect hi >= lo
  expect hi - lo <= ms_per_epoch
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
