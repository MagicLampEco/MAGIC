// LampDistribution shared validator helpers (SPEC §6 invariants).

use aiken/collection/list
use aiken/interval.{Finite, IntervalBoundType}
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets
use cardano/assets.{AssetName, PolicyId, Value}
use cardano/transaction.{InlineDatum, Input, NoDatum, Output, OutputReference, Transaction}
use magiclamp/lampdist/types.{BeaconKind, MerkleRoot, PParam, Randomness}

/// Epoch từ validity_range lower_bound (POSIX ms). ms_per_epoch network-specific.
pub fn get_epoch(tx: Transaction, ms_per_epoch: Int) -> Int {
  expect Some(s) = tx.validity_range.lower_bound.bound_type |> get_finite
  s / ms_per_epoch
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

/// Đếm input tại 1 address (chống double-satisfaction).
pub fn count_inputs_at(inputs: List<Input>, addr: Address) -> Int {
  list.count(inputs, fn(x) { x.output.address == addr })
}

pub fn count_outputs_at(outputs: List<Output>, addr: Address) -> Int {
  list.count(outputs, fn(x) { x.address == addr })
}

pub fn output_at(outputs: List<Output>, addr: Address) -> Output {
  expect Some(o) = list.find(outputs, fn(x) { x.address == addr })
  o
}

pub fn input_at(inputs: List<Input>, addr: Address) -> Output {
  expect Some(i) = list.find(inputs, fn(x) { x.output.address == addr })
  i.output
}

// ── Đếm/tìm theo PAYMENT CREDENTIAL (script hash) — CHỐNG double-satisfaction
// qua stake credential (audit C1/C2). Full-address equality KHÔNG đủ vì cùng
// script hash + khác stake cred = address khác nhưng đều là UTxO của script.

/// Script hash của chính validator đang chạy.
pub fn own_script_hash(own_addr: Address) -> ByteArray {
  expect Script(h) = own_addr.payment_credential
  h
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

/// Đếm chữ ký committee có mặt trong extra_signatories (Byzantine M-of-N).
pub fn count_committee_sigs(
  committee   : List<ByteArray>,
  signatories : List<ByteArray>,
) -> Int {
  list.count(committee, fn(k) { list.has(signatories, k) })
}

/// payment credential của address có phải VerificationKey(pkh) không.
pub fn is_owned_by(addr: Address, pkh: ByteArray) -> Bool {
  when addr.payment_credential is {
    VerificationKey(h) -> h == pkh
    _ -> False
  }
}

/// payment credential của address có phải Script(hash) không.
pub fn is_at_script(addr: Address, script_hash: ByteArray) -> Bool {
  when addr.payment_credential is {
    Script(h) -> h == script_hash
    _ -> False
  }
}

/// Tổng LAMP (oil) các output trả về cho owner PKH.
pub fn lamp_to_owner(
  outputs    : List<Output>,
  owner      : ByteArray,
  lamp_policy: PolicyId,
  lamp_name  : AssetName,
) -> Int {
  list.foldl(
    outputs,
    0,
    fn(o, acc) {
      if is_owned_by(o.address, owner) {
        acc + assets.quantity_of(o.value, lamp_policy, lamp_name)
      } else {
        acc
      }
    },
  )
}

/// Asset name của beacon NFT theo kind (authenticity token).
pub fn beacon_name(kind: BeaconKind) -> AssetName {
  when kind is {
    PParam -> #"505041524d"      // "PPARAM"
    Randomness -> #"4e4f4e4345"  // "NONCE"
    MerkleRoot -> #"4d524f4f54"  // "MROOT"
  }
}

// ── Tests cho helper thuần ────────────────────────────────────

test committee_sig_count() {
  count_committee_sigs([#"a1", #"b2", #"c3"], [#"a1", #"c3", #"ff"]) == 2
}

test committee_sig_none() {
  count_committee_sigs([#"a1", #"b2"], [#"ff"]) == 0
}

test beacon_name_distinct() {
  beacon_name(PParam) != beacon_name(Randomness) && beacon_name(Randomness) != beacon_name(
    MerkleRoot,
  )
}

// ── Test-support builders (mock UTxO/tx) cho validator tests ──

/// Address của script (stake cred None).
pub fn script_address(hash: ByteArray) -> Address {
  Address { payment_credential: Script(hash), stake_credential: None }
}

/// Address của script với stake credential (để test double-satisfaction).
pub fn script_address_staked(hash: ByteArray, stake_pkh: ByteArray) -> Address {
  Address {
    payment_credential: Script(hash),
    stake_credential: Some(Inline(VerificationKey(stake_pkh))),
  }
}

/// Address ví thường (VerificationKey).
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

pub fn mk_ref(ix: Int) -> OutputReference {
  OutputReference { transaction_id: #"00", output_index: ix }
}

// AUDIT C1 — chứng minh fix double-satisfaction qua stake credential.
// 2 UTxO cùng script hash, KHÁC stake credential → 2 Address khác nhau.
// count theo full-address: mỗi addr chỉ thấy 1 → KHÔNG phát hiện (lỗ hổng cũ).
// count theo script-hash: thấy CẢ 2 → phát hiện double (fix mới).
fn mk_input_at(addr: Address) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"00", output_index: 0 },
    output: Output {
      address: addr,
      value: assets.zero,
      datum: NoDatum,
      reference_script: None,
    },
  }
}

test script_count_catches_stake_cred_double() {
  let sh = #"deadbeef"
  let addr_a = Address { payment_credential: Script(sh), stake_credential: None }
  let addr_b =
    Address {
      payment_credential: Script(sh),
      stake_credential: Some(Inline(VerificationKey(#"aa"))),
    }
  let inputs = [mk_input_at(addr_a), mk_input_at(addr_b)]
  // full-address: chỉ đếm 1 cho addr_a → BỎ SÓT double (chứng minh lỗ hổng cũ)
  let by_addr = count_inputs_at(inputs, addr_a)
  // script-hash: đếm cả 2 → CHẶN double (fix C1)
  let by_script = count_inputs_at_script(inputs, sh)
  by_addr == 1 && by_script == 2
}
