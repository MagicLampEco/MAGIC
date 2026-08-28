// validators/vault_profile.ak — ProfileChange redeemer (§12)
// Normative: C-PC-V1..6, §12.1..12.4, T4
//
// Profile change là 2-step lazy:
//   Step 1 (this tx):  set pending_profile = Some{new, effective: e+1}
//   Step 2 (next tx):  any vault touch applies pending nếu effective_epoch ≤ current
//
// ── AUDIT FIX (Bug 2 — CRITICAL) ──────────────────────────────────────────
// (a) Cũ: VaultDatum LOCAL cắt ngắn (`// ... other fields unchanged`) → decode
//     FAIL (vault kẹt) HOẶC ví chủ đổi field ẩn (xoá batches/reset streak) mà
//     validator không thấy → DRAIN. Fix: dùng VaultDatum ĐẦY ĐỦ (types.ak) và
//     validate MỌI field == input TRỪ pending_profile / profile_changed_epoch /
//     last_updated_epoch (UpdateProfile); và TRỪ thêm profile (ApplyPending).
// (b) Cũ: `const slots_per_epoch = 432_000` HARD-CODE mainnet → Preview/Preprod
//     tính sai epoch. Fix: parameterize `vault_profile(ms_per_epoch: Int)`
//     (Preview = 86_400_000, Mainnet = 432_000_000) — Plutus validity_range là
//     POSIX ms nên dùng ms_per_epoch (KHÔNG phải slots).
//
// ⚠ Module này RIÊNG với Issue #9 (UpdateProfile cho Snapshot/Instant của Tuân).
//   Xem báo cáo — KHÔNG tự quyết kiến trúc nếu trùng.

use aiken/collection/list
use aiken/interval.{after, between}
use cardano/assets
use cardano/transaction.{InlineDatum, OutputReference, Transaction, placeholder}
use magiclamp/protocol/types.{
  ActivityProfile, ActivityState, DelegationCertificate, Ember, Flame, Lantern,
  PendingProfile, StreakState, VaultAttribution, VaultDatum,
}
use magiclamp/protocol/util

const profile_cooldown : Int = 2   // [Significant]

pub type ProfileRedeemer {
  UpdateProfile { new_profile: ActivityProfile }
  ApplyPending
}

// `ms_per_epoch`: Preview = 86_400_000, Mainnet = 432_000_000 (POSIX ms).
validator vault_profile(ms_per_epoch: Int) {
  spend(
    datum_opt : Option<VaultDatum>,
    redeemer  : ProfileRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(datum) = datum_opt
    let current_epoch = util.get_epoch(tx, ms_per_epoch)
    let own_addr      = util.own_address(own_ref, tx.inputs)
    let own_hash      = util.own_script_hash(own_addr)

    // Đúng 1 vault input + 1 vault output theo SCRIPT HASH (chống
    // double-satisfaction qua stake credential).
    expect util.count_inputs_at_script(tx.inputs, own_hash) == 1
    expect util.count_outputs_at_script(tx.outputs, own_hash) == 1

    let own_input = util.input_at_script(tx.inputs, own_hash)
    let out_raw   = util.output_at_script(tx.outputs, own_hash)

    // ── MAINNET-BLOCK fix: VALUE-CONSERVATION ──────────────────────────────
    // Trước đây chỉ validate DATUM (lamp_balance == datum.lamp_balance ở DATUM),
    // KHÔNG kiểm `out_raw.value`. Owner (bắt buộc ký) gửi tx giữ nguyên datum
    // nhưng rút tLAMP/ADA thật ra ví → kế toán nguyên vẹn, token thật biến mất.
    // ProfileChange KHÔNG động value (không mint/burn/transfer LAMP) nên value
    // ra phải == value vào TUYỆT ĐỐI (gồm tLAMP + min-ADA + mọi token khác).
    expect out_raw.value == own_input.value

    expect InlineDatum(d) = out_raw.datum
    expect output: VaultDatum = d

    when redeemer is {
      // ── §12.1 Initiate profile change ─────────────────────
      UpdateProfile { new_profile } -> {
        // C-PC-V1: user signs
        expect list.has(tx.extra_signatories, datum.owner)

        // C-PC-V2: cooldown ≥ 2 epoch since last change
        expect current_epoch - datum.profile_changed_epoch >= profile_cooldown

        // C-PC-V3: new_profile ≠ current
        expect new_profile != datum.profile

        // C-PC-V5: pending.effective_epoch = current_epoch + 1
        expect output.pending_profile ==
          Some(PendingProfile { new_profile, effective_epoch: current_epoch + 1 })

        // profile_changed_epoch + last_updated_epoch updated to now;
        // các field này được phép đổi.
        expect output.profile_changed_epoch == current_epoch
        expect output.last_updated_epoch    == current_epoch

        // ── MỌI field còn lại == input ──────────────────────
        // (chỉ pending_profile / profile_changed_epoch / last_updated_epoch đổi).
        // profile VẪN là profile cũ ở step này (C-PC-V4: chưa apply).
        expect output.profile == datum.profile
        all_other_fields_unchanged(output, datum)
      }

      // ── §12.2 Apply pending (lazy) ─────────────────────────
      ApplyPending -> {
        expect list.has(tx.extra_signatories, datum.owner)

        when datum.pending_profile is {
          None -> fail @"No pending profile to apply"
          Some(pending) -> {
            expect pending.effective_epoch <= current_epoch
            // Apply: profile becomes new, pending cleared.
            expect output.profile         == pending.new_profile
            expect output.pending_profile == None
            expect output.last_updated_epoch == current_epoch

            // ── MỌI field còn lại == input ────────────────────
            // (chỉ profile / pending_profile / last_updated_epoch đổi).
            // profile_changed_epoch KHÔNG đổi ở bước apply.
            expect output.profile_changed_epoch == datum.profile_changed_epoch
            all_other_fields_unchanged(output, datum)
          }
        }
      }
    }
  }

  else(_) {
    fail
  }
}

// MỌI field KHÔNG liên quan profile-change phải bất biến giữa input/output.
// C-PC-V4/V6: magic_batches (profile_at_creation immutable — T4) đặc biệt quan trọng.
fn all_other_fields_unchanged(output: VaultDatum, datum: VaultDatum) -> Bool {
  expect output.owner            == datum.owner
  expect output.lamp_balance     == datum.lamp_balance
  expect output.lamp_locked      == datum.lamp_locked
  expect output.loyalty_holdings == datum.loyalty_holdings
  expect output.magic_batches    == datum.magic_batches      // C-PC-V4/V6
  expect output.next_batch_index == datum.next_batch_index
  expect output.vacuum_orders    == datum.vacuum_orders
  expect output.gen_schedules    == datum.gen_schedules
  expect output.delegation_cert  == datum.delegation_cert
  expect output.activity_state   == datum.activity_state
  expect output.streak_state     == datum.streak_state
  expect output.personal_delegate == datum.personal_delegate
  expect output.attribution      == datum.attribution
  True
}

// ══════════════════════════════════════════════════════════════
// Validator tests (mock Transaction)
// ══════════════════════════════════════════════════════════════

const t_sh: ByteArray = #"a1a1a1a1"

const t_owner: ByteArray = #"0a0a"

const t_mspe: Int = 86_400_000   // Preview

// VaultDatum đầy đủ; tham số hoá field profile-related + 1 field "khác" (streak)
// để dựng case tamper.
fn vault(
  profile        : ActivityProfile,
  changed_epoch  : Int,
  pending        : Option<PendingProfile>,
  last_updated   : Int,
  streak         : Int,
) -> VaultDatum {
  VaultDatum {
    owner: t_owner,
    lamp_balance: 1000,
    lamp_locked: 0,
    loyalty_holdings: [],
    magic_batches: [],
    next_batch_index: 0,
    vacuum_orders: [],
    gen_schedules: [],
    profile,
    profile_changed_epoch: changed_epoch,
    pending_profile: pending,
    last_updated_epoch: last_updated,
    delegation_cert: DelegationCertificate {
      current: [],
      pending: None,
      current_effective_epoch: 0,
      last_changed_epoch: 0,
    },
    activity_state: ActivityState {
      recent_burn_epochs: [],
      consumed_credit: 0,
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

// Validity range nằm TRỌN trong epoch `epoch`: [E·mspe, (E+1)·mspe − 1].
// (E+1)·mspe − 1 chia mspe = E → e_lo == e_hi. Mô phỏng off-chain đúng chuẩn.
fn pc_tx(
  in_d  : VaultDatum,
  out_d : VaultDatum,
  sigs  : List<ByteArray>,
  epoch : Int,
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
    validity_range: between(epoch * t_mspe, (epoch + 1) * t_mspe - 1),
  }
}

// HAPPY (UpdateProfile): current=5, last change=0, cooldown OK, Flame→Ember.
test update_happy_path() {
  let in_d = vault(Flame, 0, None, 0, 7)
  let out_d = vault(Flame, 5, Some(PendingProfile { new_profile: Ember, effective_epoch: 6 }), 5, 7)
  let tx = pc_tx(in_d, out_d, [t_owner], 5)
  vault_profile.spend(t_mspe, Some(in_d), UpdateProfile { new_profile: Ember }, util.mk_ref(0), tx)
}

// HAPPY (ApplyPending): pending Ember effective@6, current=6 → apply.
test apply_happy_path() {
  let pend = Some(PendingProfile { new_profile: Ember, effective_epoch: 6 })
  let in_d = vault(Flame, 5, pend, 5, 7)
  let out_d = vault(Ember, 5, None, 6, 7)
  let tx = pc_tx(in_d, out_d, [t_owner], 6)
  vault_profile.spend(t_mspe, Some(in_d), ApplyPending, util.mk_ref(0), tx)
}

// REJECT 1 — tamper field KHÁC (reset streak 7→0 trong lúc UpdateProfile).
// Cũ (datum cắt ngắn) KHÔNG thấy → DRAIN. Fix chặn.
test update_streak_tamper() fail {
  let in_d = vault(Flame, 0, None, 0, 7)
  let out_d = vault(Flame, 5, Some(PendingProfile { new_profile: Ember, effective_epoch: 6 }), 5, 0)
  let tx = pc_tx(in_d, out_d, [t_owner], 5)
  vault_profile.spend(t_mspe, Some(in_d), UpdateProfile { new_profile: Ember }, util.mk_ref(0), tx)
}

// REJECT 2 — double-satisfaction qua stake credential.
test update_double_satisfaction_stake_cred() fail {
  let in_d = vault(Flame, 0, None, 0, 7)
  let out_d = vault(Flame, 5, Some(PendingProfile { new_profile: Ember, effective_epoch: 6 }), 5, 7)
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
    validity_range: between(5 * t_mspe, 6 * t_mspe - 1),
  }
  vault_profile.spend(t_mspe, Some(in_d), UpdateProfile { new_profile: Ember }, util.mk_ref(0), tx)
}

// REJECT 3 — epoch TÍNH SAI theo ms_per_epoch (cooldown chưa đủ).
// last change @ epoch 4. current phải = 5 mới đủ cooldown 2? 5-4=1 < 2 → reject.
// Dùng ms_per_epoch Preview để chứng minh epoch = slot/ms_per_epoch đúng.
test update_cooldown_via_ms_per_epoch() fail {
  let in_d = vault(Flame, 4, None, 0, 7)
  let out_d = vault(Flame, 5, Some(PendingProfile { new_profile: Ember, effective_epoch: 6 }), 5, 7)
  // validity_range lower bound = 5 * 86_400_000 → epoch 5; 5-4=1 < cooldown 2.
  let tx = pc_tx(in_d, out_d, [t_owner], 5)
  vault_profile.spend(t_mspe, Some(in_d), UpdateProfile { new_profile: Ember }, util.mk_ref(0), tx)
}

// REJECT 3b — chứng minh ms_per_epoch ĐÚNG cho phép pass khi đủ cooldown:
// nếu hard-code mainnet (432_000_000) thì 5*86.4M / 432M = 1 (epoch sai) → fail.
// Ở đây mạng Preview, epoch=5, last=0 → cooldown 5≥2 OK → pass (happy đã cover).
// Test này: same-profile (Flame→Flame) bị C-PC-V3 chặn.
test update_same_profile() fail {
  let in_d = vault(Flame, 0, None, 0, 7)
  let out_d = vault(Flame, 5, Some(PendingProfile { new_profile: Flame, effective_epoch: 6 }), 5, 7)
  let tx = pc_tx(in_d, out_d, [t_owner], 5)
  vault_profile.spend(t_mspe, Some(in_d), UpdateProfile { new_profile: Flame }, util.mk_ref(0), tx)
}

// REJECT 4 — ApplyPending khi pending chưa tới hạn (effective > current).
test apply_not_yet_effective() fail {
  let pend = Some(PendingProfile { new_profile: Ember, effective_epoch: 6 })
  let in_d = vault(Flame, 5, pend, 5, 7)
  let out_d = vault(Ember, 5, None, 5, 7)
  // current = 5 < effective 6 → reject
  let tx = pc_tx(in_d, out_d, [t_owner], 5)
  vault_profile.spend(t_mspe, Some(in_d), ApplyPending, util.mk_ref(0), tx)
}

// REJECT 5 — ApplyPending tamper magic_batches (T4 immutability) — dùng Lantern
// để chắc chắn nhánh apply chạy; ở đây đổi profile sai (không khớp pending).
test apply_wrong_profile() fail {
  let pend = Some(PendingProfile { new_profile: Ember, effective_epoch: 6 })
  let in_d = vault(Flame, 5, pend, 5, 7)
  let out_d = vault(Lantern, 5, None, 6, 7)   // pending là Ember, output Lantern → reject
  let tx = pc_tx(in_d, out_d, [t_owner], 6)
  vault_profile.spend(t_mspe, Some(in_d), ApplyPending, util.mk_ref(0), tx)
}

// REJECT 6 — owner không ký.
test update_no_owner_sig() fail {
  let in_d = vault(Flame, 0, None, 0, 7)
  let out_d = vault(Flame, 5, Some(PendingProfile { new_profile: Ember, effective_epoch: 6 }), 5, 7)
  let tx = pc_tx(in_d, out_d, [], 5)
  vault_profile.spend(t_mspe, Some(in_d), UpdateProfile { new_profile: Ember }, util.mk_ref(0), tx)
}

// REJECT 7 — MAINNET-BLOCK value-conservation: datum nguyên vẹn nhưng output
// value < input value (owner rút bớt lovelace/token thật). Phải fail.
test update_value_drain() fail {
  let in_d = vault(Flame, 0, None, 0, 7)
  let out_d = vault(Flame, 5, Some(PendingProfile { new_profile: Ember, effective_epoch: 6 }), 5, 7)
  let addr = util.script_address(t_sh)
  let val_in  = assets.from_lovelace(2_000_000)
  let val_out = assets.from_lovelace(1_000_000)   // owner rút 1 ADA ra ví mình
  let v_in  = util.mk_input(util.mk_ref(0), util.mk_output(addr, val_in, in_d))
  let v_out = util.mk_output(addr, val_out, out_d)
  let tx = Transaction {
    ..placeholder,
    inputs: [v_in],
    outputs: [v_out],
    extra_signatories: [t_owner],
    validity_range: between(5 * t_mspe, 6 * t_mspe - 1),
  }
  vault_profile.spend(t_mspe, Some(in_d), UpdateProfile { new_profile: Ember }, util.mk_ref(0), tx)
}

// REJECT 8 — MAINNET-BLOCK validity span: tx span 2 epoch (lower @5, upper @6)
// → get_epoch fail (e_lo=5 ≠ e_hi=6). Chặn epoch nhập nhằng.
test update_validity_span_multi_epoch() fail {
  let in_d = vault(Flame, 0, None, 0, 7)
  let out_d = vault(Flame, 5, Some(PendingProfile { new_profile: Ember, effective_epoch: 6 }), 5, 7)
  let addr = util.script_address(t_sh)
  let val = assets.from_lovelace(2_000_000)
  let v_in  = util.mk_input(util.mk_ref(0), util.mk_output(addr, val, in_d))
  let v_out = util.mk_output(addr, val, out_d)
  let tx = Transaction {
    ..placeholder,
    inputs: [v_in],
    outputs: [v_out],
    extra_signatories: [t_owner],
    validity_range: between(5 * t_mspe, 6 * t_mspe + 100),   // span sang epoch 6
  }
  vault_profile.spend(t_mspe, Some(in_d), UpdateProfile { new_profile: Ember }, util.mk_ref(0), tx)
}

// REJECT 9 — MAINNET-BLOCK validity: upper_bound = PositiveInfinity (after()).
// get_epoch yêu cầu upper Finite → fail-closed.
test update_validity_unbounded_upper() fail {
  let in_d = vault(Flame, 0, None, 0, 7)
  let out_d = vault(Flame, 5, Some(PendingProfile { new_profile: Ember, effective_epoch: 6 }), 5, 7)
  let addr = util.script_address(t_sh)
  let val = assets.from_lovelace(2_000_000)
  let v_in  = util.mk_input(util.mk_ref(0), util.mk_output(addr, val, in_d))
  let v_out = util.mk_output(addr, val, out_d)
  let tx = Transaction {
    ..placeholder,
    inputs: [v_in],
    outputs: [v_out],
    extra_signatories: [t_owner],
    validity_range: after(5 * t_mspe),   // upper = PositiveInfinity
  }
  vault_profile.spend(t_mspe, Some(in_d), UpdateProfile { new_profile: Ember }, util.mk_ref(0), tx)
}
