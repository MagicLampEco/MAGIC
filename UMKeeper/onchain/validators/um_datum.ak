// validators/um_datum.ak — UM Datum Validator (§14)
// Normative: C-UM-1..4, §14.1, §14.3
//
// UM datum là UTxO riêng (không phải vault).
// Update PERMISSIONLESS — bất kỳ ai cũng có thể trigger (khớp pattern
// VacuumFire/ScheduleFire). Validator verify toán học SMA + ràng buộc
// eUTXO, KHÔNG cần chữ ký keeper.
//
// ── THIẾT KẾ: PERMISSIONLESS (khớp VacuumFire/ScheduleFire) ──────────────
// Cập nhật UM không trao quyền lợi cho người trigger — chỉ làm tươi rate
// theo công thức đã được verify on-chain. Vì vậy mở permissionless như các
// handler *Fire khác để keeper bất kỳ (kể cả user) cập nhật đúng giờ.
//
// Lý do theo 4 trục:
//   1. Định hướng dài hạn: UM là rate gốc cho mọi app dùng SDK → cần được
//      cập nhật đều đặn; permissionless tối đa hoá liveness, không phụ thuộc
//      1 keeper bot duy nhất (single point of liveness failure).
//   2. First-principles: validator tính lại smoothed_q từ history + clamp →
//      người trigger KHÔNG chọn được kết quả; biến số duy nhất họ cấp là
//      new_raw, đã bị double-clamp [UM_MIN_Q, UM_MAX_Q] + SMA 6-epoch làm mịn.
//   3. Tối ưu: bỏ count_keeper_sigs → ít ExUnit hơn, không cần whitelist param.
//   4. An toàn user + bền vững: value preservation (UM NFT không rời output)
//      chống rút token thẩm quyền; single-input theo PAYMENT CREDENTIAL
//      (script hash) chống double-satisfaction qua stake credential. Rủi ro
//      còn lại: new_raw được cấp off-chain (không verify được tự thân) → giới
//      hạn bằng clamp + SMA, ghi chú rõ trong MATH.md §TV-UM-04 / TECH.md.

use aiken/collection/list
use aiken/interval.{Finite, IntervalBoundType, between}
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
  // Bất kỳ ai (permissionless) submit new raw UM value (computed off-chain từ
  // epoch stats). Validator verify SMA math đúng — KHÔNG verify được raw value
  // tự thân; new_raw bị giới hạn bằng clamp [UM_MIN_Q, UM_MAX_Q] + SMA 6-epoch.
  UMUpdate { new_raw: Int }
}

// ── Validator ─────────────────────────────────────────────────
// `ms_per_epoch` is applied per-network (Plutus validity_range is POSIX ms):
//   Mainnet:        432_000_000
//   Preview/Preprod: 86_400_000
//
// `um_policy` / `um_name` : NFT thẩm quyền của UM datum — phải còn ở output
//   (value preservation → chống chuyển UM authority sang UTxO của attacker).
validator um_datum_validator(
  ms_per_epoch : Int,
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
        // ── PERMISSIONLESS ────────────────────────────────────
        // Không yêu cầu chữ ký (khớp VacuumFire/ScheduleFire). An toàn vì
        // validator tính lại smoothed_q từ history + double-clamp → người
        // trigger không hưởng lợi, chỉ làm tươi rate theo công thức.

        // ── Single-input/output theo SCRIPT HASH (payment credential) ─
        // Chống double-satisfaction: cùng script hash + khác stake credential
        // = Address khác nhưng vẫn là UTxO của UM validator. Đếm theo full
        // Address sẽ bỏ sót → BẮT BUỘC đếm theo payment credential (script hash).
        expect count_inputs_at_script(tx.inputs, own_hash) == 1
        expect count_outputs_at_script(tx.outputs, own_hash) == 1

        let um_in  = input_at_script(tx.inputs, own_hash)
        let um_out = output_at_script(tx.outputs, own_hash)

        // ── ADDRESS PRESERVATION: pin FULL Address của output đã chọn ─
        // Count-by-script-hash (line 89-90) chống double-satisfaction, nhưng
        // KHÔNG ràng buộc stake_credential. Nếu chỉ pin payment credential,
        // người trigger permissionless có thể đặt stake_credential của họ vào
        // output → chiếm staking reward trên ADA khoá ở UTxO. Pin full Address
        // (payment + stake) của output ĐÃ chọn = input → stake_credential bất
        // biến. Vẫn giữ count-by-script-hash ở trên cho double-satisfaction.
        expect um_out.address == um_in.address

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

// ── eUTXO helpers ─────────────────────────────────────────────

// SEC-03 fix: upper_bound constraint prevents front-run via epoch injection.
// Đọc cả lower và upper bound; ép e_lo == e_hi để tx phải nằm trong một epoch
// duy nhất. Nếu chỉ đọc lower_bound, attacker có thể set lower=start_of(E)
// với upper=∞, tx được include ở epoch E+k, nhưng validator ghi
// last_updated_epoch = E → sai epoch. Mirrors VacuumGen get_current_epoch.
fn get_epoch(tx: Transaction, ms_per_epoch: Int) -> Int {
  expect Some(lower_ms) =
    tx.validity_range.lower_bound.bound_type |> get_finite_slot
  expect Some(upper_ms) =
    tx.validity_range.upper_bound.bound_type |> get_finite_slot
  let e_lo = lower_ms / ms_per_epoch
  let e_hi = upper_ms / ms_per_epoch
  expect e_lo == e_hi
  e_lo
}

fn get_finite_slot(bt: IntervalBoundType) -> Option<Int> {
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

const t_um_policy: ByteArray = #"00aa"

const t_um_name: ByteArray = #"554d44"   // "UMD" — tên NFT UM chính thức cross-module (InstantGen/VacuumGen/scripts)

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

// tx chuẩn: 1 UM input + 1 UM output, value preserved, epoch.
// `sigs` giữ lại để dựng extra_signatories nhưng KHÔNG còn được validator
// kiểm tra (permissionless) — chỉ là field placeholder của Transaction.
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
    validity_range: between(epoch * t_mspe, (epoch + 1) * t_mspe - 1),
  }
}

// happy: permissionless (không cần chữ ký), value preserved, SMA đúng.
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
  // không có chữ ký nào — permissionless vẫn pass.
  let tx = um_tx(in_d, out_d, [], 5, v, v)
  um_datum_validator.spend(
    t_mspe, t_um_policy, t_um_name,
    Some(in_d), UMUpdate { new_raw: raw }, mk_ref(0), tx,
  )
}

// REJECT 1 — double-satisfaction qua stake credential.
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
    extra_signatories: [],
    validity_range: between(5 * t_mspe, 6 * t_mspe - 1),
  }
  um_datum_validator.spend(
    t_mspe, t_um_policy, t_um_name,
    Some(in_d), UMUpdate { new_raw: raw }, mk_ref(0), tx,
  )
}

// REJECT 2 — UM NFT thẩm quyền bị rút khỏi output (value không bảo toàn).
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
  let tx = um_tx(in_d, out_d, [], 5, v, bad_out)
  um_datum_validator.spend(
    t_mspe, t_um_policy, t_um_name,
    Some(in_d), UMUpdate { new_raw: raw }, mk_ref(0), tx,
  )
}

// REJECT 3 — không phải epoch boundary (current_epoch == last_updated_epoch).
test um_same_epoch() fail {
  let in_d = UMDatum { smoothed_q: q, last_updated_epoch: 5, history: [q] }
  let raw = 1_200_000_000
  let out_d = UMDatum {
    smoothed_q: 1_100_000_000,
    last_updated_epoch: 5,
    history: [q, raw],
  }
  let v = um_value()
  let tx = um_tx(in_d, out_d, [], 5, v, v)
  um_datum_validator.spend(
    t_mspe, t_um_policy, t_um_name,
    Some(in_d), UMUpdate { new_raw: raw }, mk_ref(0), tx,
  )
}

// REJECT 5 — output đổi stake_credential (chiếm staking reward).
// 1 UM input (no stake) + 1 UM output cùng script hash NHƯNG stake_credential
// của attacker → count-by-script-hash thấy 1 (pass) nhưng full-Address pin
// (um_out.address == um_in.address) reject. Chứng minh fix LOW stake-cred.
test um_output_stake_cred_hijack() fail {
  let in_d = UMDatum { smoothed_q: q, last_updated_epoch: 0, history: [q] }
  let raw = 1_200_000_000
  let out_d = UMDatum {
    smoothed_q: 1_100_000_000,
    last_updated_epoch: 5,
    history: [q, raw],
  }
  let v = um_value()
  let addr_in  = script_address(t_sh)
  let addr_out = script_address_staked(t_sh, #"cc")  // attacker stake cred
  let um_in = Input { output_reference: mk_ref(0), output: mk_out(addr_in, v, in_d) }
  let um_out = mk_out(addr_out, v, out_d)
  let tx = Transaction {
    ..placeholder,
    inputs: [um_in],
    outputs: [um_out],
    extra_signatories: [],
    validity_range: between(5 * t_mspe, 6 * t_mspe - 1),
  }
  um_datum_validator.spend(
    t_mspe, t_um_policy, t_um_name,
    Some(in_d), UMUpdate { new_raw: raw }, mk_ref(0), tx,
  )
}

// REJECT 4 — output smoothed_q sai (người trigger khai gian SMA).
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
  let tx = um_tx(in_d, out_d, [], 5, v, v)
  um_datum_validator.spend(
    t_mspe, t_um_policy, t_um_name,
    Some(in_d), UMUpdate { new_raw: raw }, mk_ref(0), tx,
  )
}
