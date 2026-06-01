// lib/magiclamp/protocol/util.ak — eUTXO helpers + test builders.
//
// Đếm input/output của chính validator theo PAYMENT CREDENTIAL (script hash),
// KHÔNG full-Address equality → chống double-satisfaction qua stake credential
// (cùng script hash + khác stake cred = Address khác nhưng đều là UTxO script).

use aiken/collection/list
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets
use cardano/assets.{Value}
use cardano/transaction.{InlineDatum, Input, NoDatum, Output, OutputReference}

pub fn own_address(own_ref: OutputReference, inputs: List<Input>) -> Address {
  expect Some(i) = list.find(inputs, fn(x) { x.output_reference == own_ref })
  i.output.address
}

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

// ── Test-support builders ─────────────────────────────────────
pub fn script_address(hash: ByteArray) -> Address {
  Address { payment_credential: Script(hash), stake_credential: None }
}

pub fn script_address_staked(hash: ByteArray, stake_pkh: ByteArray) -> Address {
  Address {
    payment_credential: Script(hash),
    stake_credential: Some(Inline(VerificationKey(stake_pkh))),
  }
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

pub fn mk_ref(ix: Int) -> OutputReference {
  OutputReference { transaction_id: #"00", output_index: ix }
}

// AUDIT proof — script-hash counting bắt double-satisfaction qua stake cred.
test script_count_catches_stake_cred_double() {
  let sh = #"deadbeef"
  let addr_a = script_address(sh)
  let addr_b = script_address_staked(sh, #"aa")
  let in_a = mk_input(mk_ref(0), mk_output_no_datum(addr_a, assets.zero))
  let in_b = mk_input(mk_ref(1), mk_output_no_datum(addr_b, assets.zero))
  let inputs = [in_a, in_b]
  count_inputs_at_script(inputs, sh) == 2
}
