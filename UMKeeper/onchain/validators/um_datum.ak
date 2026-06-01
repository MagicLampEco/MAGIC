// validators/um_datum.ak — UM Datum Validator (§14)
// Normative: C-UM-1..4, §14.1, §14.3
//
// UM datum là UTxO riêng (không phải vault).
// Update do KEEPER được uỷ quyền trigger (KHÔNG permissionless — xem AUDIT bên dưới).
// Validator verify toán học SMA, không trust raw value từ keeper.
//
// ── AUDIT FIX (Bug 3 — CRITICAL) ──────────────────────────────────────────
// Cũ: UMUpdate "permissionless" → bất kỳ ai cũng đè smoothed_q mỗi epoch.
//   Dù SMA math bị verify, attacker vẫn chọn được new_raw (trong clamp [MIN,MAX])
//   và bơm history theo hướng có lợi → thao túng Instant/Vacuum rate.
//   Đây là tham số Constitutional của cả mạng → KHÔNG được để hở.
//
// Fix (lý do theo 4 trục):
//   1. Định hướng dài hạn: UM là rate gốc cho mọi app dùng SDK → phải đáng tin,
//      nếu thao túng được thì LAMP mất giá trị (mục tiêu cuối thất bại).
//   2. First-principles: keeper KHÔNG cần là 1 người; whitelist M-of-N keeper ký
//      → decentralize được, không single point, vẫn chống Sybil đè rate.
//   3. Tối ưu: chỉ cần M chữ ký + 1 input/1 output theo script hash → ít ExUnit,
//      không cần oracle phức tạp.
//   4. An toàn user + bền vững: value preservation (UM NFT không rời output) chống
//      rút token thẩm quyền; single-input theo PAYMENT CREDENTIAL (script hash)
//      chống double-satisfaction qua stake credential.

use aiken/collection/list
use aiken/interval.{Finite, IntervalBoundType, after}
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{PolicyId}
use cardano/assets
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction, placeholder}

// ── Constants ────────────────────────────────────────────────
const q : Int = 1_000_000_000
const um_min_q : Int = 500_000_000    // [Constitutional]
const um_max_q : Int = 2_000_000_000  // [Constitutional]
const um_window : Int = 6             // [Significant]

// ── Types ─────────────────────────────────────────────────────
pub type UMDatum {
  smoothed_q         : Int,
  last_updated_epoch : Int,
  history            : List<Int>,   // last ≤ 6 raw values
}

pub type UMRedeemer {
  // Keeper được uỷ quyền submit new raw UM value (computed off-chain từ epoch stats).
  // Validator verify SMA math đúng — không verify được raw value tự thân.
  UMUpdate { new_raw: Int }
}

// ── Validator ─────────────────────────────────────────────────
// `ms_per_epoch` is applied per-network (Plutus validity_range is POSIX ms):
//   Mainnet:        432_000_000
//   Preview/Preprod: 86_400_000
//
// `keepers`   : whitelist payment key hash của keeper được phép update.
// `threshold` : số chữ ký keeper tối thiểu (M-of-N, Byzantine fault tolerance).
// `um_policy` / `um_name` : NFT thẩm quyền của UM datum — phải còn ở output
//   (value preservation → chống chuyển UM authority sang UTxO của attacker).
validator um_datum_validator(
  ms_per_epoch : Int,
  keepers      : List<ByteArray>,
  threshold    : Int,
  um_policy    : PolicyId,
  um_name      : ByteArray,
) {
  spend(
    datum_opt : Option<UMDatum>,
    redeemer  : UMRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(datum) = datum_opt
    let current_epoch = get_epoch(tx, ms_per_epoch)
    let own_addr      = get_own_addr(own_ref, tx.inputs)
    let own_hash      = own_script_hash(own_addr)

    when redeemer is {
      UMUpdate { new_raw } -> {
        // ── AUTH: keeper M-of-N ký ────────────────────────────
        // Chống đè rate permissionless. Đếm số keeper whitelist có mặt
        // trong extra_signatories, yêu cầu ≥ threshold.
        expect count_keeper_sigs(keepers, tx.extra_signatories) >= threshold

        // ── Single-input/output theo SCRIPT HASH (payment credential) ─
        // Chống double-satisfaction: cùng script hash + khác stake credential
        // = Address khác nhưng vẫn là UTxO của UM validator. Đếm theo full
        // Address sẽ bỏ sót → BẮT BUỘC đếm theo payment credential (script hash).
        expect count_inputs_at_script(tx.inputs, own_hash) == 1
        expect count_outputs_at_script(tx.outputs, own_hash) == 1

        let um_in  = input_at_script(tx.inputs, own_hash)
        let um_out = output_at_script(tx.outputs, own_hash)

        // ── VALUE PRESERVATION: UM NFT thẩm quyền còn nguyên ở output ─
        // NFT UM authenticity không được rời UTxO → attacker không thể tách
        // authority NFT sang UTxO mình kiểm soát rồi tự ý update sau này.
        expect assets.quantity_of(um_out.value, um_policy, um_name) == 1
        // Toàn bộ value bảo toàn (không rút min-ADA / token lạ chèn vào).
        expect um_out.value == um_in.value

        // ── C-UM-4: Update at epoch boundary ────────────────
        expect current_epoch > datum.last_updated_epoch

        // ── Clamp raw value ──────────────────────────────────
        let clamped_raw = clamp(new_raw, um_min_q, um_max_q)

        // ── C-UM-2: history cap ≤ 6 ─────────────────────────
        let old_history = datum.history
        let new_history = append_capped(old_history, clamped_raw, um_window)

        // ── C-UM-1: SMA computation ──────────────────────────
        let new_smoothed = compute_sma(new_history)

        // ── C-UM-3: Clamp smoothed to [UM_MIN, UM_MAX] ──────
        let new_smoothed_clamped = clamp(new_smoothed, um_min_q, um_max_q)

        // ── A02: Verify output datum ─────────────────────────
        expect InlineDatum(d) = um_out.datum
        expect output_datum: UMDatum = d
        expect output_datum.smoothed_q == new_smoothed_clamped
        expect output_datum.last_updated_epoch == current_epoch
        expect output_datum.history == new_history
        expect list.length(output_datum.history) <= um_window

        True
      }
    }
  }

  else(_) {
    fail
  }
}

// ── Math helpers ──────────────────────────────────────────────

// SMA = sum(history) / len(history)
fn compute_sma(history: List<Int>) -> Int {
  let len = list.length(history)
  if len == 0 { q }  // neutral fallback (never happens after first update)
  else {
    let total = list.foldl(history, 0, fn(x, acc) { acc + x })
    total / len
  }
}

// Append new value, keep only last `cap` entries
fn append_capped(history: List<Int>, new_val: Int, cap: Int) -> List<Int> {
  let appended = list.concat(history, [new_val])
  let len = list.length(appended)
  if len <= cap { appended }
  else { list.drop(appended, len - cap) }
}

fn clamp(x: Int, lo: Int, hi: Int) -> Int {
  if x < lo { lo } else if x > hi { hi } else { x }
}

// ── Auth helper ───────────────────────────────────────────────
fn count_keeper_sigs(keepers: List<ByteArray>, sigs: List<ByteArray>) -> Int {
  list.count(keepers, fn(k) { list.has(sigs, k) })
}

// ── eUTXO helpers ─────────────────────────────────────────────
fn get_epoch(tx: Transaction, ms_per_epoch: Int) -> Int {
  expect Some(s) = tx.validity_range.lower_bound.bound_type |> get_finite
  s / ms_per_epoch
}

fn get_finite(bt: IntervalBoundType) -> Option<Int> {
  when bt is {
    Finite(s) -> Some(s)
    _ -> None
  }
}

fn get_own_addr(own_ref: OutputReference, inputs: List<Input>) -> Address {
  expect Some(i) = list.find(inputs, fn(x) { x.output_reference == own_ref })
  i.output.address
}

// Script hash (payment credential) của chính validator đang chạy.
fn own_script_hash(own_addr: Address) -> ByteArray {
  expect Script(h) = own_addr.payment_credential
  h
}

// Đếm input/output theo PAYMENT CREDENTIAL (script hash) — chống
// double-satisfaction qua stake credential (full-Address equality KHÔNG đủ).
fn is_at_script(addr: Address, script_hash: ByteArray) -> Bool {
  when addr.payment_credential is {
    Script(h) -> h == script_hash
    _ -> False
  }
}

fn count_inputs_at_script(inputs: List<Input>, script_hash: ByteArray) -> Int {
  list.count(inputs, fn(x) { is_at_script(x.output.address, script_hash) })
}

fn count_outputs_at_script(outputs: List<Output>, script_hash: ByteArray) -> Int {
  list.count(outputs, fn(x) { is_at_script(x.address, script_hash) })
}

fn input_at_script(inputs: List<Input>, script_hash: ByteArray) -> Output {
  expect Some(i) = list.find(inputs, fn(x) { is_at_script(x.output.address, script_hash) })
  i.output
}

fn output_at_script(outputs: List<Output>, script_hash: ByteArray) -> Output {
  expect Some(o) = list.find(outputs, fn(x) { is_at_script(x.address, script_hash) })
  o
}

// ══════════════════════════════════════════════════════════════
// Validator tests (mock Transaction)
// ══════════════════════════════════════════════════════════════

const t_mspe: Int = 86_400_000   // Preview

const t_sh: ByteArray = #"a1a1a1a1"

fn t_keepers() -> List<ByteArray> {
  [#"a1", #"a2", #"a3"]
}

const t_threshold: Int = 2

const t_um_policy: ByteArray = #"00aa"

const t_um_name: ByteArray = #"554d"   // "UM"

// Address builders
fn script_address(hash: ByteArray) -> Address {
  Address { payment_credential: Script(hash), stake_credential: None }
}

fn script_address_staked(hash: ByteArray, stake_pkh: ByteArray) -> Address {
  Address {
    payment_credential: Script(hash),
    stake_credential: Some(
      Inline(VerificationKey(stake_pkh)),
    ),
  }
}

fn um_value() -> assets.Value {
  assets.add(assets.from_lovelace(2_000_000), t_um_policy, t_um_name, 1)
}

fn mk_out(addr: Address, value: assets.Value, d: Data) -> Output {
  Output { address: addr, value: value, datum: InlineDatum(d), reference_script: None }
}

fn mk_ref(ix: Int) -> OutputReference {
  OutputReference { transaction_id: #"00", output_index: ix }
}

// tx chuẩn: 1 UM input + 1 UM output, value preserved, keeper sigs, epoch.
fn um_tx(
  in_d  : UMDatum,
  out_d : UMDatum,
  sigs  : List<ByteArray>,
  epoch : Int,
  in_val  : assets.Value,
  out_val : assets.Value,
) -> Transaction {
  let addr = script_address(t_sh)
  let um_in = Input {
    output_reference: mk_ref(0),
    output: mk_out(addr, in_val, in_d),
  }
  let um_out = mk_out(addr, out_val, out_d)
  Transaction {
    ..placeholder,
    inputs: [um_in],
    outputs: [um_out],
    extra_signatories: sigs,
    validity_range: after(epoch * t_mspe),
  }
}

// happy: 2 keeper ký, value preserved, SMA đúng.
test um_happy_path() {
  let in_d = UMDatum { smoothed_q: q, last_updated_epoch: 0, history: [q] }
  let raw = 1_200_000_000
  // history [q, raw] → SMA = (1e9 + 1.2e9)/2 = 1.1e9, clamp giữ nguyên
  let new_hist = [q, raw]
  let out_d = UMDatum {
    smoothed_q: 1_100_000_000,
    last_updated_epoch: 5,
    history: new_hist,
  }
  let v = um_value()
  let tx = um_tx(in_d, out_d, [#"a1", #"a2"], 5, v, v)
  um_datum_validator.spend(
    t_mspe, t_keepers(), t_threshold, t_um_policy, t_um_name,
    Some(in_d), UMUpdate { new_raw: raw }, mk_ref(0), tx,
  )
}

// REJECT 1 — unauthorized: chỉ 1 keeper ký < threshold 2.
test um_unauthorized() fail {
  let in_d = UMDatum { smoothed_q: q, last_updated_epoch: 0, history: [q] }
  let raw = 1_200_000_000
  let out_d = UMDatum {
    smoothed_q: 1_100_000_000,
    last_updated_epoch: 5,
    history: [q, raw],
  }
  let v = um_value()
  // chỉ #"a1" ký → 1 < threshold 2 → reject
  let tx = um_tx(in_d, out_d, [#"a1"], 5, v, v)
  um_datum_validator.spend(
    t_mspe, t_keepers(), t_threshold, t_um_policy, t_um_name,
    Some(in_d), UMUpdate { new_raw: raw }, mk_ref(0), tx,
  )
}

// REJECT 1b — kẻ lạ ký (không trong whitelist).
test um_stranger_signer() fail {
  let in_d = UMDatum { smoothed_q: q, last_updated_epoch: 0, history: [q] }
  let raw = 1_200_000_000
  let out_d = UMDatum {
    smoothed_q: 1_100_000_000,
    last_updated_epoch: 5,
    history: [q, raw],
  }
  let v = um_value()
  let tx = um_tx(in_d, out_d, [#"ff", #"ee"], 5, v, v)
  um_datum_validator.spend(
    t_mspe, t_keepers(), t_threshold, t_um_policy, t_um_name,
    Some(in_d), UMUpdate { new_raw: raw }, mk_ref(0), tx,
  )
}

// REJECT 2 — double-satisfaction qua stake credential.
// 2 UM input cùng script hash, khác stake credential → count theo script hash
// thấy 2 ≠ 1 → reject (full-Address equality sẽ bỏ sót).
test um_double_satisfaction_stake_cred() fail {
  let in_d = UMDatum { smoothed_q: q, last_updated_epoch: 0, history: [q] }
  let raw = 1_200_000_000
  let out_d = UMDatum {
    smoothed_q: 1_100_000_000,
    last_updated_epoch: 5,
    history: [q, raw],
  }
  let v = um_value()
  let addr_a = script_address(t_sh)
  let addr_b = script_address_staked(t_sh, #"bb")
  let in_a = Input { output_reference: mk_ref(0), output: mk_out(addr_a, v, in_d) }
  let in_b = Input { output_reference: mk_ref(1), output: mk_out(addr_b, v, in_d) }
  let out_a = mk_out(addr_a, v, out_d)
  let out_b = mk_out(addr_b, v, out_d)
  let tx = Transaction {
    ..placeholder,
    inputs: [in_a, in_b],
    outputs: [out_a, out_b],
    extra_signatories: [#"a1", #"a2"],
    validity_range: after(5 * t_mspe),
  }
  um_datum_validator.spend(
    t_mspe, t_keepers(), t_threshold, t_um_policy, t_um_name,
    Some(in_d), UMUpdate { new_raw: raw }, mk_ref(0), tx,
  )
}

// REJECT 3 — UM NFT thẩm quyền bị rút khỏi output (value không bảo toàn).
test um_authority_nft_stripped() fail {
  let in_d = UMDatum { smoothed_q: q, last_updated_epoch: 0, history: [q] }
  let raw = 1_200_000_000
  let out_d = UMDatum {
    smoothed_q: 1_100_000_000,
    last_updated_epoch: 5,
    history: [q, raw],
  }
  let v = um_value()
  // output KHÔNG có UM NFT (chỉ min-ADA) → reject
  let bad_out = assets.from_lovelace(2_000_000)
  let tx = um_tx(in_d, out_d, [#"a1", #"a2"], 5, v, bad_out)
  um_datum_validator.spend(
    t_mspe, t_keepers(), t_threshold, t_um_policy, t_um_name,
    Some(in_d), UMUpdate { new_raw: raw }, mk_ref(0), tx,
  )
}

// REJECT 4 — không phải epoch boundary (current_epoch == last_updated_epoch).
test um_same_epoch() fail {
  let in_d = UMDatum { smoothed_q: q, last_updated_epoch: 5, history: [q] }
  let raw = 1_200_000_000
  let out_d = UMDatum {
    smoothed_q: 1_100_000_000,
    last_updated_epoch: 5,
    history: [q, raw],
  }
  let v = um_value()
  let tx = um_tx(in_d, out_d, [#"a1", #"a2"], 5, v, v)
  um_datum_validator.spend(
    t_mspe, t_keepers(), t_threshold, t_um_policy, t_um_name,
    Some(in_d), UMUpdate { new_raw: raw }, mk_ref(0), tx,
  )
}

// REJECT 5 — output smoothed_q sai (keeper khai gian SMA).
test um_forged_smoothed() fail {
  let in_d = UMDatum { smoothed_q: q, last_updated_epoch: 0, history: [q] }
  let raw = 1_200_000_000
  // SMA đúng = 1.1e9, attacker khai 2e9 → reject
  let out_d = UMDatum {
    smoothed_q: 2_000_000_000,
    last_updated_epoch: 5,
    history: [q, raw],
  }
  let v = um_value()
  let tx = um_tx(in_d, out_d, [#"a1", #"a2"], 5, v, v)
  um_datum_validator.spend(
    t_mspe, t_keepers(), t_threshold, t_um_policy, t_um_name,
    Some(in_d), UMUpdate { new_raw: raw }, mk_ref(0), tx,
  )
}
