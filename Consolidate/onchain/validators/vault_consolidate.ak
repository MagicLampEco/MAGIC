// validators/vault_consolidate.ak — ConsolidateHoldings redeemer (§6.9)
// Normative: C-CONSOLIDATE-1..6, T23 (determinism, convergence, conservation)
//
// Mục đích: Merge holdings gần nhau (|epoch_diff| ≤ 1, cùng is_locked)
// để giảm số entries → tránh ExUnit exhaustion (A5).
// Khi |loyalty_holdings| gần 64, ví cần consolidate trước khi thêm.
//
// ── AUDIT FIX (Bug 1 — CRITICAL) ──────────────────────────────────────────
// Cũ: VaultDatum LOCAL chỉ 4 field (`// ... other fields omitted`).
//   → CBOR decode FAIL (vault kẹt) HOẶC nếu decode lỏng, ví chủ ký 1 tx
//     consolidate mà kèm reset streak/profile/xoá magic_batches → DRAIN.
//   Validator KHÔNG bao giờ thấy các field bị đổi nên không chặn được.
// Fix:
//   1. Dùng VaultDatum ĐẦY ĐỦ (lib/magiclamp/protocol/types.ak) → decode đúng
//      mọi field, đúng thứ tự constructor.
//   2. Validate MỌI field output == input TRỪ loyalty_holdings (cái duy nhất
//      consolidate được phép đổi). Các field khác đổi → reject.
//   3. Giữ conservation C-CONSOLIDATE-4/5/6.
//   4. Đếm input/output theo PAYMENT CREDENTIAL (script hash) → chống
//      double-satisfaction qua stake credential.

use aiken/collection/list
use cardano/assets
use cardano/transaction.{InlineDatum, OutputReference, Transaction, placeholder}
use magiclamp/protocol/types.{
  ActivityProfile, ActivityState, DelegationCertificate, Ember, Flame,
  LoyaltyHolding, StreakState, VaultAttribution, VaultDatum,
}
use magiclamp/protocol/util

pub type ConsolidateRedeemer {
  Consolidate
}

// ── Validator ─────────────────────────────────────────────────
validator vault_consolidate {
  spend(
    datum_opt : Option<VaultDatum>,
    _redeemer : ConsolidateRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(datum) = datum_opt
    let own_addr = util.own_address(own_ref, tx.inputs)
    let own_hash = util.own_script_hash(own_addr)

    // C-PC-V1: user signs
    expect list.has(tx.extra_signatories, datum.owner)

    // Đúng 1 vault input + 1 vault output theo SCRIPT HASH (chống
    // double-satisfaction qua stake credential — full-Address equality bỏ sót).
    expect util.count_inputs_at_script(tx.inputs, own_hash) == 1
    expect util.count_outputs_at_script(tx.outputs, own_hash) == 1

    let out_raw = util.output_at_script(tx.outputs, own_hash)
    expect InlineDatum(d) = out_raw.datum
    expect output: VaultDatum = d

    // ── MỌI field == input TRỪ loyalty_holdings ───────────────
    // (loyalty_holdings là cái duy nhất consolidate được phép đổi).
    expect output.owner                 == datum.owner
    expect output.lamp_balance          == datum.lamp_balance
    expect output.lamp_locked           == datum.lamp_locked
    expect output.magic_batches         == datum.magic_batches
    expect output.next_batch_index      == datum.next_batch_index
    expect output.vacuum_orders         == datum.vacuum_orders
    expect output.gen_schedules         == datum.gen_schedules
    expect output.profile               == datum.profile
    expect output.profile_changed_epoch == datum.profile_changed_epoch
    expect output.pending_profile       == datum.pending_profile
    expect output.last_updated_epoch    == datum.last_updated_epoch
    expect output.delegation_cert       == datum.delegation_cert
    expect output.activity_state        == datum.activity_state
    expect output.streak_state          == datum.streak_state
    expect output.personal_delegate     == datum.personal_delegate
    expect output.attribution           == datum.attribution

    // C-CONSOLIDATE-4: |output| < |input| (must reduce entries)
    expect
      list.length(output.loyalty_holdings) < list.length(datum.loyalty_holdings)

    // C-CONSOLIDATE-5: Σ(output.amount) = Σ(input.amount)
    let sum_in  = list.foldl(datum.loyalty_holdings,  0, fn(h, acc) { acc + h.amount })
    let sum_out = list.foldl(output.loyalty_holdings, 0, fn(h, acc) { acc + h.amount })
    expect sum_out == sum_in

    // C-CONSOLIDATE-6: Σ(locked output) = Σ(locked input)
    let locked_in  = sum_locked(datum.loyalty_holdings)
    let locked_out = sum_locked(output.loyalty_holdings)
    expect locked_out == locked_in

    // C-VAULT-10: Σholdings = lamp_balance
    expect sum_out == datum.lamp_balance

    // C-VAULT-8: lamp_locked ≤ lamp_balance (unchanged)
    expect datum.lamp_locked <= datum.lamp_balance

    True
  }

  else(_) {
    fail
  }
}

fn sum_locked(holdings: List<LoyaltyHolding>) -> Int {
  list.foldl(
    holdings,
    0,
    fn(h, acc) { if h.is_locked { acc + h.amount } else { acc } },
  )
}

// ══════════════════════════════════════════════════════════════
// Validator tests (mock Transaction)
// ══════════════════════════════════════════════════════════════

const t_sh: ByteArray = #"a1a1a1a1"

const t_owner: ByteArray = #"0a0a"

fn hold(amount: Int, epoch: Int, locked: Bool) -> LoyaltyHolding {
  LoyaltyHolding { amount, acquired_epoch: epoch, is_locked: locked }
}

// VaultDatum đầy đủ cho test. Tham số hoá field hay đổi để dựng case tamper.
fn vault(
  holdings : List<LoyaltyHolding>,
  balance  : Int,
  profile  : ActivityProfile,
  streak   : Int,
) -> VaultDatum {
  VaultDatum {
    owner: t_owner,
    lamp_balance: balance,
    lamp_locked: 0,
    loyalty_holdings: holdings,
    magic_batches: [],
    next_batch_index: 0,
    vacuum_orders: [],
    gen_schedules: [],
    profile,
    profile_changed_epoch: 0,
    pending_profile: None,
    last_updated_epoch: 0,
    delegation_cert: DelegationCertificate {
      current: [],
      pending: None,
      current_effective_epoch: 0,
      last_changed_epoch: 0,
    },
    activity_state: ActivityState {
      recent_burn_epochs: [],
      total_burns_count: 0,
    },
    streak_state: StreakState { current_streak: streak, last_active_epoch: 0 },
    personal_delegate: None,
    attribution: VaultAttribution {
      attribution_root: #"",
      last_event_epoch: 0,
      total_events: 0,
    },
  }
}

fn cons_tx(
  in_d  : VaultDatum,
  out_d : VaultDatum,
  sigs  : List<ByteArray>,
) -> Transaction {
  let addr = util.script_address(t_sh)
  let val = assets.from_lovelace(2_000_000)
  let v_in = util.mk_input(util.mk_ref(0), util.mk_output(addr, val, in_d))
  let v_out = util.mk_output(addr, val, out_d)
  Transaction {
    ..placeholder,
    inputs: [v_in],
    outputs: [v_out],
    extra_signatories: sigs,
  }
}

// HAPPY: 3 holdings → 2 (merge 2 cùng epoch/locked), conservation giữ.
test consolidate_happy_path() {
  let in_h = [hold(100, 5, False), hold(50, 5, False), hold(30, 9, True)]
  let out_h = [hold(150, 5, False), hold(30, 9, True)]
  let in_d = vault(in_h, 180, Flame, 7)
  let out_d = vault(out_h, 180, Flame, 7)
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 1 — tamper field KHÁC loyalty_holdings: đổi profile (Flame→Ember).
// Cũ (datum cắt ngắn) KHÔNG thấy field này → DRAIN. Fix chặn.
test consolidate_profile_tamper() fail {
  let in_h = [hold(100, 5, False), hold(50, 5, False)]
  let out_h = [hold(150, 5, False)]
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Ember, 7)   // profile bị đổi → reject
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 1b — tamper streak_state (reset streak 7→0).
test consolidate_streak_tamper() fail {
  let in_h = [hold(100, 5, False), hold(50, 5, False)]
  let out_h = [hold(150, 5, False)]
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 0)   // streak reset → reject
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 2 — double-satisfaction qua stake credential.
// 2 vault input cùng script hash khác stake cred → count theo script hash = 2 ≠ 1.
test consolidate_double_satisfaction_stake_cred() fail {
  let in_h = [hold(100, 5, False), hold(50, 5, False)]
  let out_h = [hold(150, 5, False)]
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 7)
  let val = assets.from_lovelace(2_000_000)
  let addr_a = util.script_address(t_sh)
  let addr_b = util.script_address_staked(t_sh, #"bb")
  let in_a = util.mk_input(util.mk_ref(0), util.mk_output(addr_a, val, in_d))
  let in_b = util.mk_input(util.mk_ref(1), util.mk_output(addr_b, val, in_d))
  let out_a = util.mk_output(addr_a, val, out_d)
  let out_b = util.mk_output(addr_b, val, out_d)
  let tx = Transaction {
    ..placeholder,
    inputs: [in_a, in_b],
    outputs: [out_a, out_b],
    extra_signatories: [t_owner],
  }
  vault_consolidate.spend(Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 3 — conservation vỡ: Σ output ≠ Σ input (rút 50 LAMP lén).
test consolidate_conservation_break() fail {
  let in_h = [hold(100, 5, False), hold(50, 5, False)]
  let out_h = [hold(100, 5, False)]   // mất 50 → Σ sai
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 7)
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 4 — không giảm entries (|output| !< |input|).
test consolidate_no_reduction() fail {
  let in_h = [hold(150, 5, False)]
  let out_h = [hold(150, 5, False)]
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 7)
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 5 — owner không ký.
test consolidate_no_owner_sig() fail {
  let in_h = [hold(100, 5, False), hold(50, 5, False)]
  let out_h = [hold(150, 5, False)]
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 7)
  let tx = cons_tx(in_d, out_d, [])
  vault_consolidate.spend(Some(in_d), Consolidate, util.mk_ref(0), tx)
}
