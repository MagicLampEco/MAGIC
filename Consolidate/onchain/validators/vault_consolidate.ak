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
//
// ── AUDIT FIX (Bug 2 — HIGH: LF-inflation qua acquired_epoch) ──────────────
// Cũ: conservation chỉ ràng buộc Σamount và Σlocked. KHÔNG có ràng buộc nào
//   trên `output.loyalty_holdings[i].acquired_epoch`. Ví chủ ký 1 consolidate
//   hợp lệ (Σ giữ, giảm entries) NHƯNG đặt acquired_epoch=0 cho holding merged.
//   → age = current_epoch − 0 lớn vọt → Loyalty Factor LF → cap 1.5 → các cơ
//   chế sinh MAGIC (Snapshot/Instant) sinh MAGIC VƯỢT MỨC từ cùng lượng LAMP.
//   Consolidate "chế tạo" loyalty cũ mà vault chưa từng nắm giữ.
// Fix — 2 ràng buộc verify được on-chain, không cần dựng lại sort-partition-merge:
//   (a) C-CONSOLIDATE-2 (bảo thủ LF, MATH §4): output merged epoch = min của 1
//       tập con input → BỊ CHẶN DƯỚI bởi min(tất cả input epoch). Ép
//         min(output.acquired_epoch) ≥ min(input.acquired_epoch)
//       → KHÔNG thể chế tạo loyalty cũ hơn vault từng có (chặn acquired_epoch=0).
//   (b) Không epoch tương lai: max(output.acquired_epoch) ≤ current_epoch
//       → age ≥ 0, không nonsense. current_epoch đọc từ tx.validity_range.
//   ms_per_epoch là param mạng (POSIX-ms như InstantGen vault) — deploy phải
//   apply đúng giá trị mạng (Preview/mainnet) khớp các vault khác.
//
// ── AUDIT FIX (Bug 2b — HIGH: non-adjacent LF-inflation, council LENS-SEC) ──
// Cũ (chỉ guard (a)(b)): ví chủ KHÔNG vượt min-input, nhưng vẫn dời 1 holding
//   TRẺ về 1 epoch CŨ HỢP LỆ đã có trong input. Vd input [100@5, 50@9] → output
//   [150@5]: 50 LAMP epoch 9 (trẻ) bị gán epoch 5 (cũ) → age +4 → LF cao hơn.
//   Guard (a) bất lực vì epoch tấn công (5) = min-input. Đây là biến thể khó của
//   Bug 2: dùng lại epoch cũ HỢP LỆ thay vì chế tạo epoch dưới min.
// Bản chất luật kề (adjacency) của spec: merge CHỈ gộp holdings |epoch_diff| ≤ 1,
//   epoch merged = min của nhóm → MỖI holding chỉ tụt XUỐNG ≤ 1 epoch. Suy ra
//   tổng "tuổi-LAMP" tụt xuống của 1 consolidate hợp lệ:
//       Σ(amount × epoch)_in − Σ(amount × epoch)_out  ≤  Σ(amount)
//   (mỗi LAMP tụt ≤ 1 epoch → tổng tụt ≤ Σamount). Đã verify trên merge đa-pass
//   (sort-partition-merge offchain): max tụt của bất kỳ holding nào = 1 epoch.
// Fix (rẻ — 1 fold, KHÔNG dựng lại sort-partition-merge):
//   (c) Σ(amount × epoch)_out ≥ Σ(amount × epoch)_in − Σ(amount)
//   → SOUND: không bao giờ cản consolidate hợp lệ (loss ≤ Σamount luôn thoả).
//   → Chặn council attack (dời 50 LAMP xuống 4 epoch: loss 200 > Σamount 150).
//   Trần residual sau fix: tổng tuổi-LAMP tụt ≤ Σamount = tổng balance → trung
//   bình ≤ 1 epoch/LAMP = đúng dung sai C-CONSOLIDATE-2 (gộp epoch kề ±1). So
//   pre-fix (chỉ guard (a)): 1 holding lớn tụt nhiều epoch không bị chặn (vd dời
//   1tr LAMP từ epoch 9 → 5, inflation 4tr tuổi-LAMP qua guard (a)). Fix thu trần
//   inflation từ "không giới hạn theo span" về "≤ Σamount, span trung bình ≤1".

use aiken/collection/list
use aiken/interval.{Finite, after}
use cardano/assets
use cardano/assets.{PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, placeholder,
}
use magiclamp/protocol/types.{
  ActivityProfile, ActivityState, DelegationCertificate, Ember, Flame,
  LoyaltyHolding, StreakState, VaultAttribution, VaultDatum,
}
use magiclamp/protocol/util

pub type ConsolidateRedeemer {
  Consolidate
}

// ── AUDIT FIX (Bug 3 — MAINNET-BLOCK: VALUE-LEAK) ─────────────────────────
// Cũ: validator chỉ ràng buộc DATUM (lamp_balance giữ nguyên, Σholdings khớp)
//   nhưng KHÔNG bao giờ đọc `out_raw.value`. LAMP trong protocol là native token
//   NẰM TRONG vault UTxO (policy lamp_policy_id, asset name 744c414d50) — xác nhận
//   ở InstantGen vault.ak:284. Vì consolidate chỉ cần owner tự ký, ví chủ ký 1 tx
//   hợp lệ về datum NHƯNG output vault UTxO chỉ mang min-ADA + 0 LAMP → RÚT toàn bộ
//   LAMP token thật (kể cả phần locked back ScheduleGen/VacuumGen) ra ví mình,
//   trong khi datum vẫn "nói" lamp_balance cũ. Đây CHÍNH là lỗ InstantGen đã vá
//   ("CRIT value-leak fix / MAINNET-BLOCK", vault.ak:276-288).
// Fix (đối xứng InstantGen):
//   (1) thêm param `lamp_policy_id: PolicyId` → deploy apply đúng giá trị mạng.
//   (2) bind datum↔value: quantity_of(out.value, lamp_policy_id, 744c414d50)
//       == output.lamp_balance.
//   (3) validate_vault_value: lovelace_out ≥ lovelace_in (chống rút ADA),
//       |policies| ≤ 2 (chống dust-stuffing brick vault).
//   (4) full-Address equality cho OUTPUT == own input address (chống re-delegate
//       stake reward của LAMP khoá sang ví khác). Giữ count-by-hash cho INPUT
//       (chống double-satisfaction qua stake cred).

// ── Validator ─────────────────────────────────────────────────
// Param:
//   lamp_policy_id  — PolicyId của LAMP native asset (bind datum↔value).
//   lamp_asset_name — asset name của LAMP theo network (tLAMP testnet
//                     #"744c414d50" / LAMP mainnet #"4c414d50"). Deploy apply để
//                     không hardcode → vault không khoá khi đổi mạng.
//   ms_per_epoch    — POSIX-ms per epoch (network-specific). Phải khớp giá trị các
//                     vault khác (InstantGen vault dùng cùng tham số). Deploy apply
//                     theo mạng (Preview 86_400_000 / Mainnet 432_000_000).
validator vault_consolidate(
  lamp_policy_id  : PolicyId,
  lamp_asset_name : ByteArray,
  ms_per_epoch    : Int,
) {
  spend(
    datum_opt : Option<VaultDatum>,
    _redeemer : ConsolidateRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(datum) = datum_opt
    let own_addr = util.own_address(own_ref, tx.inputs)
    let own_hash = util.own_script_hash(own_addr)

    // Epoch hiện tại từ validity range (Plutus V3: POSIX-ms, không phải slot).
    let current_epoch = get_current_epoch(tx, ms_per_epoch)

    // C-PC-V1: user signs
    expect list.has(tx.extra_signatories, datum.owner)

    // Đúng 1 vault input + 1 vault output theo SCRIPT HASH (chống
    // double-satisfaction qua stake credential — full-Address equality bỏ sót).
    expect util.count_inputs_at_script(tx.inputs, own_hash) == 1
    expect util.count_outputs_at_script(tx.outputs, own_hash) == 1

    let out_raw = util.output_at_script(tx.outputs, own_hash)
    expect InlineDatum(d) = out_raw.datum
    expect output: VaultDatum = d

    // ── OUTPUT-ADDRESS conservation (MAINNET-BLOCK) ───────────
    // count-by-hash (line trên) chỉ khớp PAYMENT CREDENTIAL → output có thể gửi
    // tới CÙNG script hash nhưng STAKE CREDENTIAL khác (re-delegate stake reward
    // của LAMP khoá sang ví khác). Ép full-Address equality cho OUTPUT == địa chỉ
    // input. Lưu ý: count-by-hash vẫn giữ cho INPUT (chống double-satisfaction
    // qua stake cred — full-Address equality ở input sẽ bỏ sót case đó).
    expect out_raw.address == own_addr

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

    // ── C-CONSOLIDATE-2 GUARD (chống LF-inflation) ────────────
    // (a) KHÔNG chế tạo loyalty cũ hơn vault từng nắm: mọi output epoch ≥
    //     min(input epoch). C-CONSOLIDATE-2 (output = min của 1 tập con input)
    //     luôn thoả; acquired_epoch=0 (khi min input > 0) bị chặn.
    let min_in = min_epoch(datum.loyalty_holdings)
    expect list.all(
      output.loyalty_holdings,
      fn(h) { h.acquired_epoch >= min_in },
    )
    // (b) KHÔNG epoch tương lai: mọi output epoch ≤ current_epoch (age ≥ 0).
    expect list.all(
      output.loyalty_holdings,
      fn(h) { h.acquired_epoch <= current_epoch },
    )
    // (c) CHỐNG non-adjacent inflation (Bug 2b): tổng tuổi-LAMP tụt xuống của 1
    //     consolidate hợp lệ ≤ Σamount (mỗi LAMP tụt ≤ 1 epoch theo luật kề).
    //     Σ(amount×epoch)_out ≥ Σ(amount×epoch)_in − Σamount.
    let we_in  = sum_amount_epoch(datum.loyalty_holdings)
    let we_out = sum_amount_epoch(output.loyalty_holdings)
    expect we_out >= we_in - sum_in

    // C-VAULT-10: Σholdings = lamp_balance
    expect sum_out == datum.lamp_balance

    // C-VAULT-8: lamp_locked ≤ lamp_balance (unchanged)
    expect datum.lamp_locked <= datum.lamp_balance

    // ── VALUE-LEAK fix (MAINNET-BLOCK, đối xứng InstantGen vault.ak:276-288) ──
    // Bind datum↔value: LAMP token thật trong vault output == lamp_balance datum.
    // Consolidate không đổi lamp_balance → output phải mang đúng lượng LAMP cũ.
    // Không có dòng này, ví chủ ký 1 consolidate hợp lệ về datum rồi rút sạch LAMP.
    let out_lamp = assets.quantity_of(out_raw.value, lamp_policy_id, lamp_asset_name)
    expect out_lamp == output.lamp_balance

    // ── ADA / token-set preservation (MAINNET-BLOCK) ──────────
    // lovelace_out ≥ lovelace_in (không rút ADA dư); |policies| ≤ 2 (chỉ {ADA,
    // LAMP} → chống dust-stuffing làm phình UTxO quá exec-unit limit → brick vault).
    let own_input = util.own_input(own_ref, tx.inputs)
    expect validate_vault_value(own_input, out_raw)

    True
  }

  else(_) {
    fail
  }
}

/// VALUE-PRESERVATION guard (MAINNET-BLOCK — ADA drain / token-set stuffing).
/// Đối xứng InstantGen vault.ak:464. LAMP-quantity check (ở validator body) đã pin
/// lượng LAMP; helper này khoá phần value còn lại:
///   - lovelace_out ≥ lovelace_in → không siphon ADA dư (≥ cho phép top-up ADA).
///   - |policies(out)| ≤ 2 → tối đa {ADA, LAMP}; chặn dust-stuffing brick vault.
fn validate_vault_value(vault_input: Input, vault_output: Output) -> Bool {
  expect
    assets.lovelace_of(vault_output.value) >= assets.lovelace_of(
      vault_input.output.value,
    )
  expect list.length(assets.policies(vault_output.value)) <= 2
  True
}

fn sum_locked(holdings: List<LoyaltyHolding>) -> Int {
  list.foldl(
    holdings,
    0,
    fn(h, acc) { if h.is_locked { acc + h.amount } else { acc } },
  )
}

/// Σ(amount × acquired_epoch) — "tuổi-LAMP" có trọng số. Dùng cho guard (c)
/// chống non-adjacent inflation: merge hợp lệ (luật kề ≤1) chỉ làm giảm tổng này
/// ≤ Σamount; dời holding trẻ xuống >1 epoch làm giảm vượt mức → bị chặn.
fn sum_amount_epoch(holdings: List<LoyaltyHolding>) -> Int {
  list.foldl(holdings, 0, fn(h, acc) { acc + h.amount * h.acquired_epoch })
}

/// min(acquired_epoch) trên danh sách holdings.
/// Danh sách input luôn không rỗng ở đây (sum_in == lamp_balance > 0 trong thực
/// tế, và |input| > |output| ≥ 0 nên |input| ≥ 1). Seed an toàn: phần tử đầu.
fn min_epoch(holdings: List<LoyaltyHolding>) -> Int {
  when holdings is {
    [] -> 0
    [first, ..rest] ->
      list.foldl(
        rest,
        first.acquired_epoch,
        fn(h, acc) { if h.acquired_epoch < acc { h.acquired_epoch } else { acc } },
      )
  }
}

/// Plutus V3 validity_range là POSIX-ms → epoch = lower_bound_ms / ms_per_epoch.
fn get_current_epoch(tx: Transaction, ms_per_epoch: Int) -> Int {
  expect Some(lower_ms) = tx.validity_range.lower_bound.bound_type |> get_finite_slot
  lower_ms / ms_per_epoch
}

fn get_finite_slot(bound_type) -> Option<Int> {
  when bound_type is {
    Finite(s) -> Some(s)
    _ -> None
  }
}

// ══════════════════════════════════════════════════════════════
// Validator tests (mock Transaction)
// ══════════════════════════════════════════════════════════════

const t_sh: ByteArray = #"a1a1a1a1"

const t_owner: ByteArray = #"0a0a"

// LAMP policy + asset name (t_lamp_name) cho value-leak test.
const t_lamp_policy: ByteArray = #"b2b2b2b2"

// Tests use the MAINNET name on purpose: if a #"744c414d50" literal is ever
// reintroduced into validator logic, it no longer matches the param the tests
// apply, and the suite fails instead of silently passing.
const t_lamp_name: ByteArray = #"4c414d50"   // "LAMP"

// Lovelace nền của vault UTxO (min-ADA). Output phải giữ ≥ input.
const t_lovelace: Int = 2_000_000

// Preview ms_per_epoch (Plutus validity_range = POSIX ms). Mainnet = 432_000_000.
const t_mspe: Int = 86_400_000

// Mọi case dùng holdings epoch ≤ 10 → đặt validity range tại epoch 10 để
// current_epoch = 10 ≥ tất cả output epoch hợp lệ (không vướng guard (b)).
const t_epoch_now: Int = 10

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

/// Value = min-ADA + `lamp` LAMP token (native). Mặc định bind đúng lamp_balance.
fn vault_value(lovelace: Int, lamp: Int) -> assets.Value {
  assets.from_lovelace(lovelace)
    |> assets.merge(assets.from_asset(t_lamp_policy, t_lamp_name, lamp))
}

fn cons_tx(
  in_d  : VaultDatum,
  out_d : VaultDatum,
  sigs  : List<ByteArray>,
) -> Transaction {
  // Input + output mang LAMP token = lamp_balance của datum tương ứng (đúng luật
  // value-leak: output phải mang đủ LAMP). Consolidate giữ balance nên 2 bên bằng.
  cons_tx_val(
    in_d, out_d, sigs,
    vault_value(t_lovelace, in_d.lamp_balance),
    vault_value(t_lovelace, out_d.lamp_balance),
  )
}

/// cons_tx với value input/output tự chọn (dùng cho test value-leak/ADA-drain).
fn cons_tx_val(
  in_d   : VaultDatum,
  out_d  : VaultDatum,
  sigs   : List<ByteArray>,
  in_val : assets.Value,
  out_val: assets.Value,
) -> Transaction {
  let addr = util.script_address(t_sh)
  let v_in = util.mk_input(util.mk_ref(0), util.mk_output(addr, in_val, in_d))
  let v_out = util.mk_output(addr, out_val, out_d)
  Transaction {
    ..placeholder,
    inputs: [v_in],
    outputs: [v_out],
    extra_signatories: sigs,
    validity_range: after(t_epoch_now * t_mspe),
  }
}

// HAPPY: 3 holdings → 2 (merge 2 cùng epoch/locked), conservation giữ.
test consolidate_happy_path() {
  let in_h = [hold(100, 5, False), hold(50, 5, False), hold(30, 9, True)]
  let out_h = [hold(150, 5, False), hold(30, 9, True)]
  let in_d = vault(in_h, 180, Flame, 7)
  let out_d = vault(out_h, 180, Flame, 7)
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 1 — tamper field KHÁC loyalty_holdings: đổi profile (Flame→Ember).
// Cũ (datum cắt ngắn) KHÔNG thấy field này → DRAIN. Fix chặn.
test consolidate_profile_tamper() fail {
  let in_h = [hold(100, 5, False), hold(50, 5, False)]
  let out_h = [hold(150, 5, False)]
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Ember, 7)   // profile bị đổi → reject
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 1b — tamper streak_state (reset streak 7→0).
test consolidate_streak_tamper() fail {
  let in_h = [hold(100, 5, False), hold(50, 5, False)]
  let out_h = [hold(150, 5, False)]
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 0)   // streak reset → reject
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 2 — double-satisfaction qua stake credential.
// 2 vault input cùng script hash khác stake cred → count theo script hash = 2 ≠ 1.
test consolidate_double_satisfaction_stake_cred() fail {
  let in_h = [hold(100, 5, False), hold(50, 5, False)]
  let out_h = [hold(150, 5, False)]
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 7)
  let val = vault_value(t_lovelace, 150)
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
    validity_range: after(t_epoch_now * t_mspe),
  }
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 3 — conservation vỡ: Σ output ≠ Σ input (rút 50 LAMP lén).
test consolidate_conservation_break() fail {
  let in_h = [hold(100, 5, False), hold(50, 5, False)]
  let out_h = [hold(100, 5, False)]   // mất 50 → Σ sai
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 7)
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 4 — không giảm entries (|output| !< |input|).
test consolidate_no_reduction() fail {
  let in_h = [hold(150, 5, False)]
  let out_h = [hold(150, 5, False)]
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 7)
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 5 — owner không ký.
test consolidate_no_owner_sig() fail {
  let in_h = [hold(100, 5, False), hold(50, 5, False)]
  let out_h = [hold(150, 5, False)]
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 7)
  let tx = cons_tx(in_d, out_d, [])
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 6 — LF-INFLATION (Bug 2): output đặt acquired_epoch=0 trong khi
// min(input epoch)=5. Σamount/Σlocked/giảm-entries đều hợp lệ → CŨ qua được,
// sinh MAGIC vượt mức. Guard (a) min_out(0) < min_in(5) → reject.
test consolidate_acquired_epoch_inflation() fail {
  let in_h = [hold(100, 5, False), hold(50, 5, False)]
  let out_h = [hold(150, 0, False)]   // epoch giả 0 → age vọt → LF cap → reject
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 7)
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 6b — inflation tinh vi: hạ epoch xuống 4 (dưới min_in=5 nhưng > 0).
// Vẫn "chế tạo" loyalty cũ hơn vault từng có → guard (a) chặn.
test consolidate_acquired_epoch_below_min() fail {
  let in_h = [hold(100, 5, False), hold(50, 6, False)]
  let out_h = [hold(150, 4, False)]   // 4 < min_in(5) → reject
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 7)
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 7 — epoch TƯƠNG LAI: output epoch 11 > current_epoch(10) → age âm.
// Guard (b) chặn.
test consolidate_acquired_epoch_future() fail {
  let in_h = [hold(100, 5, False), hold(50, 6, False)]
  let out_h = [hold(150, 11, False)]   // 11 > current_epoch(10) → reject
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 7)
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// HAPPY 2 — C-CONSOLIDATE-2 đúng chuẩn: merge epoch 5+6 → min=5 (≥ min_in=5,
// ≤ current 10). Guard mới KHÔNG cản consolidate hợp lệ.
test consolidate_min_epoch_ok() {
  let in_h = [hold(100, 5, False), hold(50, 6, False), hold(30, 9, True)]
  let out_h = [hold(150, 5, False), hold(30, 9, True)]   // min=5 bảo thủ ✓
  let in_d = vault(in_h, 180, Flame, 7)
  let out_d = vault(out_h, 180, Flame, 7)
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 8 — NON-ADJACENT INFLATION (Bug 2b, council LENS-SEC HIGH):
// input [100@5, 50@9] (diff=4, KHÔNG được merge theo luật kề), output [150@5].
// Qua guard (a) (min_out=5 ≥ min_in=5), (b) (5 ≤ 10), Σamount/Σlocked/giảm-entries.
// 50 LAMP epoch 9 (trẻ) bị gán epoch 5 (cũ) → age +4 → LF cao hơn = inflation.
// Guard (c): Σ(a×e)_in = 100*5+50*9 = 950; Σ(a×e)_out = 150*5 = 750;
//   Σamount = 150. 750 ≥ 950−150=800? KHÔNG → reject.
test consolidate_nonadjacent_inflation() fail {
  let in_h = [hold(100, 5, False), hold(50, 9, False)]
  let out_h = [hold(150, 5, False)]   // dời 50 LAMP xuống 4 epoch → reject
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 7)
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 8b — inflation tinh vi: holding lớn dời nhiều epoch (pre-fix qua guard (a)).
// input [1@5, 1000@9] → output [1001@5]: dời 1000 LAMP xuống 4 epoch.
// Σ(a×e)_in = 5+9000 = 9005; _out = 1001*5 = 5005; Σamount=1001.
//   5005 ≥ 9005−1001=8004? KHÔNG → reject (pre-fix guard (a) min_out=5≥5 sẽ qua).
test consolidate_nonadjacent_large_inflation() fail {
  let in_h = [hold(1, 5, False), hold(1000, 9, False)]
  let out_h = [hold(1001, 5, False)]
  let in_d = vault(in_h, 1001, Flame, 7)
  let out_d = vault(out_h, 1001, Flame, 7)
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// HAPPY 3 — luật kề tụt ĐÚNG 1 epoch (dung sai C-CONSOLIDATE-2): merge 5+6 → 5.
// Guard (c) KHÔNG cản: Σ(a×e)_in = 100*5+50*6 = 800; _out = 150*5 = 750;
//   Σamount=150. 750 ≥ 800−150=650? CÓ → pass. (loss đúng = 50 ≤ Σamount).
test consolidate_adjacent_diff1_ok() {
  let in_h = [hold(100, 5, False), hold(50, 6, False)]
  let out_h = [hold(150, 5, False)]
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 7)
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// HAPPY 4 — multi-pass merge dày đặc [5,6,7,8] → [{5},{7}] (offchain TV mẫu).
// Verify guard (c) ôm trọn merge đa-pass: Σ(a×e)_in = 10*5+10*6+10*7+10*8 = 260;
//   _out = 20*5+20*7 = 240; Σamount=40. 240 ≥ 260−40=220? CÓ → pass.
test consolidate_multipass_dense_ok() {
  let in_h =
    [hold(10, 5, False), hold(10, 6, False), hold(10, 7, False), hold(10, 8, False)]
  let out_h = [hold(20, 5, False), hold(20, 7, False)]
  let in_d = vault(in_h, 40, Flame, 7)
  let out_d = vault(out_h, 40, Flame, 7)
  let tx = cons_tx(in_d, out_d, [t_owner])
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 9 — VALUE-LEAK (MAINNET-BLOCK): datum hợp lệ (Σ giữ, giảm entries) NHƯNG
// output vault UTxO chỉ mang min-ADA + 0 LAMP. Ví chủ rút toàn bộ 180 LAMP ra
// ngoài, datum vẫn "nói" lamp_balance=180. Value-bind: out_lamp(0) ≠ 180 → reject.
test consolidate_value_leak_no_lamp() fail {
  let in_h = [hold(100, 5, False), hold(50, 5, False), hold(30, 9, True)]
  let out_h = [hold(150, 5, False), hold(30, 9, True)]
  let in_d = vault(in_h, 180, Flame, 7)
  let out_d = vault(out_h, 180, Flame, 7)
  // input mang đủ 180 LAMP; output RÚT sạch (chỉ min-ADA, 0 LAMP).
  let tx =
    cons_tx_val(
      in_d, out_d, [t_owner],
      vault_value(t_lovelace, 180),
      assets.from_lovelace(t_lovelace),   // 0 LAMP → leak
    )
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 9b — VALUE-LEAK một phần: output mang 150 LAMP nhưng datum nói 180.
// 30 LAMP bị rút lén dù datum khớp datum-to-datum. out_lamp(150) ≠ 180 → reject.
test consolidate_value_leak_partial() fail {
  let in_h = [hold(100, 5, False), hold(50, 5, False), hold(30, 9, True)]
  let out_h = [hold(150, 5, False), hold(30, 9, True)]
  let in_d = vault(in_h, 180, Flame, 7)
  let out_d = vault(out_h, 180, Flame, 7)
  let tx =
    cons_tx_val(
      in_d, out_d, [t_owner],
      vault_value(t_lovelace, 180),
      vault_value(t_lovelace, 150),   // thiếu 30 LAMP → leak
    )
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 10 — ADA-DRAIN (MAINNET-BLOCK): LAMP đúng nhưng output siphon ADA dư
// (input 5_000_000 lovelace → output min 2_000_000). lovelace_out < lovelace_in
// → validate_vault_value reject.
test consolidate_ada_drain() fail {
  let in_h = [hold(100, 5, False), hold(50, 5, False)]
  let out_h = [hold(150, 5, False)]
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 7)
  let tx =
    cons_tx_val(
      in_d, out_d, [t_owner],
      vault_value(5_000_000, 150),    // input có 5 ADA
      vault_value(2_000_000, 150),    // output rút bớt → 2 ADA
    )
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 11 — TOKEN-STUFFING (MAINNET-BLOCK): output nhét policy thứ 3 (dust)
// → |policies| = 3 > 2 → brick vault. validate_vault_value reject.
test consolidate_token_stuffing() fail {
  let in_h = [hold(100, 5, False), hold(50, 5, False)]
  let out_h = [hold(150, 5, False)]
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 7)
  let stuffed =
    vault_value(t_lovelace, 150)
      |> assets.merge(assets.from_asset(#"cccccccc", #"6475737400", 1))  // dust policy 3
  let tx =
    cons_tx_val(
      in_d, out_d, [t_owner],
      vault_value(t_lovelace, 150),
      stuffed,
    )
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}

// REJECT 12 — OUTPUT-ADDRESS conservation (MAINNET-BLOCK): output gửi tới CÙNG
// script hash nhưng STAKE CREDENTIAL khác (re-delegate stake reward LAMP khoá).
// count_outputs_at_script vẫn = 1 (cùng hash) NHƯNG out.address ≠ own_addr → reject.
test consolidate_output_restake() fail {
  let in_h = [hold(100, 5, False), hold(50, 5, False)]
  let out_h = [hold(150, 5, False)]
  let in_d = vault(in_h, 150, Flame, 7)
  let out_d = vault(out_h, 150, Flame, 7)
  let addr_in = util.script_address(t_sh)
  let addr_out = util.script_address_staked(t_sh, #"bb")   // khác stake cred
  let val = vault_value(t_lovelace, 150)
  let v_in = util.mk_input(util.mk_ref(0), util.mk_output(addr_in, val, in_d))
  let v_out = util.mk_output(addr_out, val, out_d)
  let tx = Transaction {
    ..placeholder,
    inputs: [v_in],
    outputs: [v_out],
    extra_signatories: [t_owner],
    validity_range: after(t_epoch_now * t_mspe),
  }
  vault_consolidate.spend(t_lamp_policy, t_lamp_name, t_mspe, Some(in_d), Consolidate, util.mk_ref(0), tx)
}
