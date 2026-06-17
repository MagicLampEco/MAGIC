// Paymaster shared validator helpers.
// Đếm theo PAYMENT SCRIPT HASH (chống double-satisfaction qua stake credential —
// bài học audit C1/C2 Distribution). Đọc burns từ redeemer BurnBatch mirror
// consume.ak read_vault_burns. Test-support builders ở cuối.

use aiken/builtin
use aiken/collection/list
use aiken/interval.{Finite, IntervalBoundType}
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Spend, Transaction,
}

/// Epoch tham chiếu AN TOÀN trước thao túng validity-range (mirror consume.util).
/// Dùng UPPER bound (trần thời gian ledger từ chối nếu now>upper → không under-state),
/// buộc cả hai biên hữu hạn + cửa sổ ≤ 1 epoch (không bịa khoảng cách epoch).
pub fn get_epoch(tx: Transaction, ms_per_epoch: Int) -> Int {
  expect Some(lo) = tx.validity_range.lower_bound.bound_type |> get_finite
  expect Some(hi) = tx.validity_range.upper_bound.bound_type |> get_finite
  expect hi >= lo
  expect hi - lo <= ms_per_epoch
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

// ── BurnBatch reader (mirror consume.ak read_vault_burns) ──────────────────────

/// Đọc `burns` từ redeemer BurnBatch của vault input vault_ref (purpose Spend).
/// BurnBatch { burns } constr index = burn_batch_constr (per-vault param). Dùng
/// builtin.un_constr_data để KHÔNG import VaultRedeemer (tránh coupling cross-module).
pub fn read_vault_burns(
  tx                : Transaction,
  vault_ref         : OutputReference,
  burn_batch_constr : Int,
) -> List<(ByteArray, Int)> {
  expect Some(Pair(_, rd_data)) =
    list.find(tx.redeemers, fn(p) {
      let Pair(purpose, _) = p
      purpose == Spend(vault_ref)
    })
  let Pair(idx, fields) = builtin.un_constr_data(rd_data)
  expect idx == burn_batch_constr
  expect [burns_data, ..] = fields
  expect burns: List<(ByteArray, Int)> = burns_data
  burns
}

/// Σ amount trong burns.
pub fn sum_burns(burns: List<(ByteArray, Int)>) -> Int {
  list.foldl(burns, 0, fn(b, acc) { acc + b.2nd })
}

/// magic_consumed = Σ burns trên các vault_ref PHÂN BIỆT (dedup). Mỗi vault: input
/// PHẢI ở vault_script_hash + redeemer BurnBatch (constr == burn_batch_constr).
/// Đếm 1 lần / vault — cùng đại lượng consume.ak ép == total_required.
pub fn sum_burns_over_vault_refs(
  tx                : Transaction,
  vault_refs        : List<OutputReference>,
  vault_script_hash : ByteArray,
  burn_batch_constr : Int,
) -> Int {
  let distinct = dedup_refs(vault_refs)
  list.foldl(
    distinct,
    0,
    fn(vref, acc) {
      expect Some(vault_in) =
        list.find(tx.inputs, fn(i) { i.output_reference == vref })
      expect is_at_script(vault_in.output.address, vault_script_hash)
      let burns = read_vault_burns(tx, vref, burn_batch_constr)
      acc + sum_burns(burns)
    },
  )
}

/// Loại trùng OutputReference, giữ thứ tự xuất hiện.
pub fn dedup_refs(refs: List<OutputReference>) -> List<OutputReference> {
  list.foldr(
    refs,
    [],
    fn(r, acc) {
      if list.has(acc, r) {
        acc
      } else {
        [r, ..acc]
      }
    },
  )
}

// ── did_lamp_map helpers ───────────────────────────────────────────────────────

/// Lượng oil đã sponsor cho did_key trong map (0 nếu chưa có).
pub fn lookup_did(map: List<(ByteArray, Int)>, did_key: ByteArray) -> Int {
  when list.find(map, fn(e) { e.1st == did_key }) is {
    Some(e) -> e.2nd
    None -> 0
  }
}

/// Cộng `add` vào entry did_key (tạo mới nếu chưa có). Giữ thứ tự; tối đa 1 entry/key.
pub fn add_did(
  map     : List<(ByteArray, Int)>,
  did_key : ByteArray,
  add     : Int,
) -> List<(ByteArray, Int)> {
  if list.any(map, fn(e) { e.1st == did_key }) {
    list.map(
      map,
      fn(e) {
        if e.1st == did_key {
          (e.1st, e.2nd + add)
        } else {
          e
        }
      },
    )
  } else {
    list.concat(map, [(did_key, add)])
  }
}

// ── Datum readers (input + reference input) ────────────────────────────────────

/// Datum của input tại vault_ref (đọc VaultDatum.personal_delegate qua field-agnostic
/// un_constr — chỉ cần field 15 = personal_delegate. Index field 15, append-only).
pub fn input_datum_data(tx: Transaction, ref: OutputReference) -> Data {
  expect Some(inp) = list.find(tx.inputs, fn(i) { i.output_reference == ref })
  expect InlineDatum(d) = inp.output.datum
  d
}

// ── Test-support builders (mock UTxO/tx) ───────────────────────────────────────

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
