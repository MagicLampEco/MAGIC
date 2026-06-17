// validators/paymaster.ak — Paymaster SponsorMeter validator (Sponsor redeemer).
// PlutusV3 / Aiken ≥ 1.1.x. Pure BigInt.
//
// ── MÔ HÌNH (accounting + delegate, neo commit 6c617daf) ─────────────────────
// MAGIC KHÔNG là token. Tiêu MAGIC = handler BurnBatch của VAULT validator giảm
// current_amount. Paymaster KHÔNG mint MAGIC, KHÔNG tx.mint. App = personal_delegate
// của vault user (đồng ký BurnBatch). App trả ADA+LAMP hộ; phí = kế toán datum.
// Paymaster ĐỌC magic_consumed = Σ BurnBatch.burns từ redeemer vault input co-spend
// (mirror consume.ak read_vault_burns), KHÔNG tin redeemer Sponsor, KHÔNG đọc tx.mint.
//
// Parameterized by:
//   vault_script_hash   : payment script hash của generator vault (per-module)
//   burn_batch_constr   : constr index BurnBatch trong VaultRedeemer (Instant=2,
//                         Snapshot=1, Vacuum=4, Schedule=2)
//   lamp_policy_id      : PolicyId LAMP (không dùng trực tiếp ở MVP — giữ cho v1.x
//                         settlement value check; param ổn định)
//   policy_nft_policy   : PolicyId SponsorPolicy NFT (auth beacon)
//   meter_nft_policy    : PolicyId SponsorMeter NFT (thread token)
//   protocol_nft_policy : PolicyId ProtocolFeeParams NFT (auth sàn beacon)
//   max_policy_stale    : số epoch tối đa policy beacon được dùng
//   max_did_entries     : hard-cap did_lamp_map (fail-closed, DoS guard §11)
//   ms_per_epoch        : POSIX ms / epoch (network-specific)
//
// DOUBLE-SATISFACTION (PM-12): validator chạy 1 lần / meter input. PM-7 ép đúng 1
// meter input + 1 output → trong 1 tx chỉ 1 claim. magic_consumed_total = Σ burns
// trên MỌI vault input spend bằng BurnBatch (dedup toàn tx). 1 burn KHÔNG thoả 2 claim.

use aiken/builtin
use aiken/collection/list
use aiken/interval
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, ScriptPurpose, Spend, Transaction,
  placeholder,
}
use magiclamp/paymaster/math.{ada_cap, lamp_cap}
use magiclamp/paymaster/types.{
  PaymasterRedeemer, ProtocolFeeParams, Sponsor, SponsorMeter, SponsorPolicy,
}
use magiclamp/paymaster/util

const meter_nft_name: ByteArray = #"4d4554"   // "MET"
const policy_nft_name: ByteArray = #"504f4c"  // "POL"
const protocol_nft_name: ByteArray = #"50524f" // "PRO"

validator paymaster(
  vault_script_hash   : ByteArray,
  burn_batch_constr   : Int,
  lamp_policy_id      : PolicyId,
  policy_nft_policy   : PolicyId,
  meter_nft_policy    : PolicyId,
  protocol_nft_policy : PolicyId,
  max_policy_stale    : Int,
  max_did_entries     : Int,
  ms_per_epoch        : Int,
) {
  spend(
    datum_opt : Option<SponsorMeter>,
    redeemer  : PaymasterRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(meter_in) = datum_opt
    let Sponsor { vault_refs, policy_ref, protocol_ref, did_key, lamp_this, ada_this } =
      redeemer

    let own_addr = util.own_address(own_ref, tx.inputs)
    let own_hash = util.own_script_hash(own_addr)
    let current_epoch = util.get_epoch(tx, ms_per_epoch)

    // ── PM-7: đúng 1 meter input + 1 meter output @paymaster_script, mỗi cái mang
    //         đúng 1 Meter NFT (thread token, chống double-meter). ────────────────
    expect util.count_inputs_at_script(tx.inputs, own_hash) == 1
    expect util.count_outputs_at_script(tx.outputs, own_hash) == 1
    let meter_in_out = util.input_at_script(tx.inputs, own_hash)
    let meter_out = util.output_at_script(tx.outputs, own_hash)
    expect assets.quantity_of(meter_in_out.value, meter_nft_policy, meter_nft_name) == 1
    expect assets.quantity_of(meter_out.value, meter_nft_policy, meter_nft_name) == 1

    let meter_out_datum = read_meter(meter_out)

    // ── PM-10: SponsorPolicy beacon — NFT auth + freshness ────────────────────
    let policy = read_policy(tx.reference_inputs, policy_ref, policy_nft_policy)
    expect current_epoch >= policy.epoch
    expect current_epoch - policy.epoch <= max_policy_stale
    // meter ↔ policy cùng app
    expect policy.app_id == meter_in.app_id
    expect meter_out_datum.app_id == meter_in.app_id

    // ── ProtocolFeeParams beacon — NFT auth (sàn PM-3.5) ──────────────────────
    let protocol = read_protocol(tx.reference_inputs, protocol_ref, protocol_nft_policy)

    // ── PM-1: app_authority ∈ extra_signatories ──────────────────────────────
    expect list.has(tx.extra_signatories, policy.app_authority)

    // ── PM-1.5: App PHẢI là delegate đã uỷ quyền của MỌI vault sponsor ─────────
    expect all_vaults_delegate_app(tx, vault_refs, policy.app_authority)

    // ── PM-2: magic_consumed (op này) = Σ burns vault_refs khai (dedup) ───────
    //         đọc từ redeemer BurnBatch thực, KHÔNG tin redeemer Sponsor.
    let magic_consumed =
      util.sum_burns_over_vault_refs(
        tx, vault_refs, vault_script_hash, burn_batch_constr,
      )
    expect magic_consumed > 0

    // ── PM-3.5: sàn DAO + chống sponsor=0 ─────────────────────────────────────
    expect policy.lamp_per_magic_q >= protocol.min_lamp_per_magic_q
    expect if protocol.protocol_fee_active {
      lamp_this > 0
    } else {
      True
    }

    // ── PM-3: lamp_this ≤ ⌊ magic_consumed × lamp_per_magic_q / Q ⌋ (trần) ────
    expect lamp_this >= 0
    expect lamp_this <= lamp_cap(magic_consumed, policy.lamp_per_magic_q)

    // ── PM-4: ada_this ≤ ⌊ magic_consumed × ada_per_magic_q / Q ⌋ (trần) ──────
    expect ada_this >= 0
    expect ada_this <= ada_cap(magic_consumed, policy.ada_per_magic_q)

    // ── PM-8: epoch lock + reset đúng. Base (pre-op) state lấy theo epoch. ─────
    expect meter_out_datum.epoch == current_epoch
    expect meter_in.epoch <= current_epoch
    let (base_map, base_global) =
      if meter_in.epoch < current_epoch {
        // epoch mới → reset budget cũ TRƯỚC khi cộng op này (chống replay budget)
        ([], 0)
      } else {
        (meter_in.did_lamp_map, meter_in.global_lamp_epoch)
      }

    // ── PM-5: per-DID/owner cap (trên base, fail-closed) ──────────────────────
    let did_spent = util.lookup_did(base_map, did_key)
    expect did_spent + lamp_this <= policy.max_per_did_per_epoch

    // ── PM-6: global cap ──────────────────────────────────────────────────────
    expect base_global + lamp_this <= policy.max_global_per_epoch

    // ── Meter state transition đúng: did_lamp_map += lamp_this @did_key; global+= ─
    let expected_map = util.add_did(base_map, did_key, lamp_this)
    expect meter_out_datum.did_lamp_map == expected_map
    expect meter_out_datum.global_lamp_epoch == base_global + lamp_this

    // ── PM hard-cap: |did_lamp_map| ≤ max_did_entries (fail-closed, DoS §11) ───
    expect list.length(meter_out_datum.did_lamp_map) <= max_did_entries

    // ── PM-9: Meter NFT bảo toàn (Σ in@script == Σ out@script == 1, đã ép trên) ─
    //         (PM-7 đã ép qty==1 cả hai bên → bảo toàn).

    // ── PM-11: Value bảo toàn meter UTxO (non-NFT tuyệt đối) ──────────────────
    //   meter_out.value == meter_in.value (giữ luôn ADA + meter NFT, không drain).
    expect value_preserved(meter_in_out.value, meter_out.value)

    // ── PM-12: Aggregate cross-meter (chống double-satisfaction) ──────────────
    //   PM-7 đã ép đúng 1 meter/tx → Σ lamp_this qua MỌI meter = lamp_this này.
    //   magic_consumed_total = Σ burns trên MỌI vault input spend BurnBatch toàn
    //   tx (dedup). lamp_this ≤ lamp_cap(magic_consumed_total) → 1 burn không thoả
    //   2 claim (kể cả nếu redeemer Sponsor khai thiếu vault_refs để hạ trần giả).
    let magic_total = all_burns_in_tx(tx, vault_script_hash, burn_batch_constr)
    expect lamp_this <= lamp_cap(magic_total, policy.lamp_per_magic_q)
    expect ada_this <= ada_cap(magic_total, policy.ada_per_magic_q)

    True
  }

  else(_) {
    fail
  }
}

// ── Beacon readers ─────────────────────────────────────────────────────────────

fn read_meter(o: Output) -> SponsorMeter {
  expect InlineDatum(d) = o.datum
  expect m: SponsorMeter = d
  m
}

fn read_policy(
  ref_inputs        : List<Input>,
  policy_ref        : OutputReference,
  policy_nft_policy : PolicyId,
) -> SponsorPolicy {
  expect Some(beacon) =
    list.find(ref_inputs, fn(i) { i.output_reference == policy_ref })
  expect assets.quantity_of(beacon.output.value, policy_nft_policy, policy_nft_name) == 1
  expect InlineDatum(d) = beacon.output.datum
  expect p: SponsorPolicy = d
  p
}

fn read_protocol(
  ref_inputs          : List<Input>,
  protocol_ref        : OutputReference,
  protocol_nft_policy : PolicyId,
) -> ProtocolFeeParams {
  expect Some(beacon) =
    list.find(ref_inputs, fn(i) { i.output_reference == protocol_ref })
  expect assets.quantity_of(beacon.output.value, protocol_nft_policy, protocol_nft_name) == 1
  expect InlineDatum(d) = beacon.output.datum
  expect p: ProtocolFeeParams = d
  p
}

// ── PM-1.5: mọi vault input do vault_refs trỏ PHẢI có personal_delegate==Some(app) ─
// VaultDatum.personal_delegate = field index 15 (append-only). Đọc field-agnostic
// qua un_constr_data để KHÔNG import VaultDatum (tránh coupling cross-module type).
fn all_vaults_delegate_app(
  tx            : Transaction,
  vault_refs    : List<OutputReference>,
  app_authority : ByteArray,
) -> Bool {
  let distinct = util.dedup_refs(vault_refs)
  list.all(
    distinct,
    fn(vref) {
      let d = util.input_datum_data(tx, vref)
      vault_delegate_is(d, app_authority)
    },
  )
}

/// VaultDatum field 15 = personal_delegate: Option<ByteArray>.
/// Plutus encode: Constr(0, [..16 fields..]). personal_delegate at index 15.
/// Some(x) = Constr(0,[B x]); None = Constr(1,[]).
fn vault_delegate_is(d: Data, app_authority: ByteArray) -> Bool {
  let Pair(_constr, fields) = builtin.un_constr_data(d)
  expect Some(deleg_field) = list.at(fields, 15)
  let Pair(opt_constr, opt_fields) = builtin.un_constr_data(deleg_field)
  // Some = constr 0 với 1 field ByteArray; None = constr 1.
  if opt_constr == 0 {
    expect [del_data, ..] = opt_fields
    let del: ByteArray = builtin.un_b_data(del_data)
    del == app_authority
  } else {
    False
  }
}

// ── PM-12: Σ burns trên MỌI vault input spend bằng BurnBatch trong tx (dedup) ──
// Quét MỌI redeemer Spend trỏ vào 1 input ở vault_script_hash với constr ==
// burn_batch_constr; cộng Σ burns. KHÔNG dựa vault_refs khai trong redeemer Sponsor
// → attacker không hạ magic_total giả bằng cách khai thiếu.
fn all_burns_in_tx(
  tx                : Transaction,
  vault_script_hash : ByteArray,
  burn_batch_constr : Int,
) -> Int {
  list.foldl(
    tx.inputs,
    0,
    fn(inp, acc) {
      if util.is_at_script(inp.output.address, vault_script_hash) {
        // input ở vault script — đọc redeemer Spend của nó; nếu là BurnBatch cộng.
        when find_spend_redeemer(tx, inp.output_reference) is {
          Some(rd_data) -> {
            let Pair(idx, fields) = builtin.un_constr_data(rd_data)
            if idx == burn_batch_constr {
              expect [burns_data, ..] = fields
              expect burns: List<(ByteArray, Int)> = burns_data
              acc + util.sum_burns(burns)
            } else {
              acc
            }
          }
          None -> acc
        }
      } else {
        acc
      }
    },
  )
}

fn find_spend_redeemer(tx: Transaction, ref: OutputReference) -> Option<Data> {
  when
    list.find(tx.redeemers, fn(p) {
      let Pair(purpose, _) = p
      purpose == Spend(ref)
    })
  is {
    Some(Pair(_, rd)) -> Some(rd)
    None -> None
  }
}

/// Value bảo toàn tuyệt đối: diff = in − out == zero (mọi asset, kể cả NFT + ADA).
fn value_preserved(v_in: Value, v_out: Value) -> Bool {
  let diff = assets.merge(v_in, assets.negate(v_out))
  assets.is_zero(diff)
}

// ══════════════════════════════════════════════════════════════════════════════
// Validator tests (mock Transaction). happy + negatives PM-1..PM-12.
// ══════════════════════════════════════════════════════════════════════════════

const ct_pm_sh: ByteArray = #"7a7a"           // paymaster script hash
const ct_vault_sh: ByteArray = #"dddd"        // vault script hash
const ct_lamp_policy: PolicyId = #"1111"
const ct_policy_nft: PolicyId = #"2222"
const ct_meter_nft: PolicyId = #"3333"
const ct_protocol_nft: PolicyId = #"4444"
const ct_app_id: ByteArray = #"0a99"
const ct_app_auth: ByteArray = #"abcdef"      // app_authority vkh (= delegate)
const ct_owner: ByteArray = #"0bada55e"
const ct_max_stale: Int = 10
const ct_max_did: Int = 64
const ct_mspe: Int = 86_400_000               // Preview
const ct_burn_constr: Int = 2                 // InstantGen BurnBatch

fn ct_policy_ref() -> OutputReference {
  util.mk_ref_id(#"bb", 9)
}
fn ct_protocol_ref() -> OutputReference {
  util.mk_ref_id(#"cc", 8)
}
fn ct_meter_ref() -> OutputReference {
  util.mk_ref_id(#"ac", 0)
}

/// SponsorPolicy với tỷ giá tuỳ biến.
fn ct_policy(
  lamp_q  : Int,
  ada_q   : Int,
  max_did : Int,
  max_glb : Int,
  epoch   : Int,
) -> SponsorPolicy {
  SponsorPolicy {
    app_id: ct_app_id,
    app_authority: ct_app_auth,
    max_per_did_per_epoch: max_did,
    max_global_per_epoch: max_glb,
    lamp_per_magic_q: lamp_q,
    ada_per_magic_q: ada_q,
    oracle_nft_policy: None,
    epoch: epoch,
  }
}

fn ct_protocol(min_lamp_q: Int, active: Bool, epoch: Int) -> ProtocolFeeParams {
  ProtocolFeeParams { min_lamp_per_magic_q: min_lamp_q, protocol_fee_active: active, epoch }
}

/// Policy beacon reference input (nft_qty cho phép sai để test).
fn ct_policy_input(p: SponsorPolicy, nft_qty: Int) -> Input {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_policy_nft, policy_nft_name, nft_qty)
  util.mk_input(ct_policy_ref(), util.mk_output(util.script_address(#"feed"), v, p))
}

fn ct_protocol_input(p: ProtocolFeeParams, nft_qty: Int) -> Input {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_protocol_nft, protocol_nft_name, nft_qty)
  util.mk_input(ct_protocol_ref(), util.mk_output(util.script_address(#"face"), v, p))
}

/// Meter input @paymaster script, mang meter NFT (qty param).
fn ct_meter_input(m: SponsorMeter, nft_qty: Int, lovelace: Int) -> Input {
  let v = assets.add(assets.from_lovelace(lovelace), ct_meter_nft, meter_nft_name, nft_qty)
  util.mk_input(ct_meter_ref(), util.mk_output(util.script_address(ct_pm_sh), v, m))
}

fn ct_meter_output(m: SponsorMeter, nft_qty: Int, lovelace: Int) -> Output {
  let v = assets.add(assets.from_lovelace(lovelace), ct_meter_nft, meter_nft_name, nft_qty)
  util.mk_output(util.script_address(ct_pm_sh), v, m)
}

/// Vault input @vault script. Datum = full VaultDatum mock (chỉ cần đúng struct để
/// đọc field 15 = personal_delegate). Build datum tối thiểu khớp 17 fields.
fn ct_vault_datum(delegate: Option<ByteArray>) -> Data {
  // VaultDatum 17 fields (đọc field index 15 = personal_delegate).
  // Dùng Data thuần: Constr(0, [f0..f16]). Chỉ field 15 quan trọng cho test này.
  let fields: List<Data> =
    [
      builtin.b_data(ct_owner),            // 0 owner
      builtin.i_data(0),                   // 1 lamp_balance
      builtin.i_data(0),                   // 2 lamp_locked
      empty_list_data(),                   // 3 loyalty_holdings
      empty_list_data(),                   // 4 magic_batches
      builtin.i_data(0),                   // 5 next_batch_index
      empty_list_data(),                   // 6 vacuum_orders
      empty_list_data(),                   // 7 gen_schedules
      builtin.constr_data(0, []),          // 8 profile (Ember)
      builtin.i_data(0),                   // 9 profile_changed_epoch
      builtin.constr_data(1, []),          // 10 pending_profile None
      builtin.i_data(0),                   // 11 last_updated_epoch
      builtin.constr_data(0, []),          // 12 delegation_cert (placeholder constr)
      builtin.constr_data(0, []),          // 13 activity_state
      builtin.constr_data(0, []),          // 14 streak_state
      option_b_data(delegate),             // 15 personal_delegate  ← ĐỌC field này
      builtin.constr_data(0, []),          // 16 attribution
    ]
  builtin.constr_data(0, fields)
}

fn empty_list_data() -> Data {
  let l: List<Data> = []
  builtin.list_data(l)
}

fn option_b_data(o: Option<ByteArray>) -> Data {
  when o is {
    Some(b) -> builtin.constr_data(0, [builtin.b_data(b)])
    None -> builtin.constr_data(1, [])
  }
}

fn ct_vault_input(ref_ix: Int, delegate: Option<ByteArray>) -> Input {
  let v = assets.from_lovelace(2_000_000)
  util.mk_input(
    util.mk_ref_id(#"a1", ref_ix),
    util.mk_output(util.script_address(ct_vault_sh), v, ct_vault_datum(delegate)),
  )
}

/// BurnBatch redeemer data: Constr(constr, [burns]).
fn ct_burn_redeemer(constr: Int, burns: List<(ByteArray, Int)>) -> Data {
  let bd: Data = burns
  builtin.constr_data(constr, [bd])
}

fn ct_sponsor_rd(
  vault_refs : List<OutputReference>,
  did_key    : ByteArray,
  lamp_this  : Int,
  ada_this   : Int,
) -> PaymasterRedeemer {
  Sponsor {
    vault_refs,
    policy_ref: ct_policy_ref(),
    protocol_ref: ct_protocol_ref(),
    did_key,
    lamp_this,
    ada_this,
  }
}

fn rd_data(r: PaymasterRedeemer) -> Data {
  let d: Data = r
  d
}

/// Run validator: cấu hình đầy đủ. validity-range cửa sổ hẹp quanh cur_epoch.
fn run(
  policy        : SponsorPolicy,
  policy_nft_q  : Int,
  protocol      : ProtocolFeeParams,
  protocol_nft_q: Int,
  meter_in      : SponsorMeter,
  meter_nft_in  : Int,
  meter_in_lvl  : Int,
  meter_out     : SponsorMeter,
  meter_nft_out : Int,
  meter_out_lvl : Int,
  vault_inputs  : List<Input>,
  cur_epoch     : Int,
  rd            : PaymasterRedeemer,
  signers       : List<ByteArray>,
  extra_reds    : Pairs<ScriptPurpose, Data>,
) -> Bool {
  let meter_i = ct_meter_input(meter_in, meter_nft_in, meter_in_lvl)
  let meter_o = ct_meter_output(meter_out, meter_nft_out, meter_out_lvl)
  let base_reds: Pairs<ScriptPurpose, Data> =
    [Pair(Spend(ct_meter_ref()), rd_data(rd))]
  let tx =
    Transaction {
      ..placeholder,
      inputs: list.concat([meter_i], vault_inputs),
      reference_inputs: [
        ct_policy_input(policy, policy_nft_q),
        ct_protocol_input(protocol, protocol_nft_q),
      ],
      outputs: [meter_o],
      redeemers: list.concat(base_reds, extra_reds),
      extra_signatories: signers,
      validity_range: interval.between(cur_epoch * ct_mspe, cur_epoch * ct_mspe + 1),
    }
  paymaster.spend(
    ct_vault_sh, ct_burn_constr, ct_lamp_policy, ct_policy_nft, ct_meter_nft,
    ct_protocol_nft, ct_max_stale, ct_max_did, ct_mspe,
    Some(meter_in), rd, ct_meter_ref(), tx,
  )
}

fn empty_meter(epoch: Int) -> SponsorMeter {
  SponsorMeter { app_id: ct_app_id, epoch, did_lamp_map: [], global_lamp_epoch: 0 }
}

// ── HAPPY: 1 vault burn 10M, rate 0.5×Q → lamp_cap 5M; lamp_this 5M; meter cập nhật.
test pm_happy() {
  let pol = ct_policy(500_000_000, 0, 10_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let m_in = empty_meter(6)
  let m_out =
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(
    pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000,
    [vault], 6, rd, [ct_app_auth],
    [Pair(Spend(vref), burn_rd)],
  )
}

// ── HAPPY: ada sponsor — rate 2.0×Q, magic 50M → ada_cap 100M; ada_this 100M.
test pm_happy_ada() {
  let pol = ct_policy(1_000_000_000, 2_000_000_000, 10_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 50_000_000)])
  let m_in = empty_meter(6)
  // lamp_this = 50M (rate 1.0× → cap 50M), ada_this = 100M.
  let m_out =
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 50_000_000)], global_lamp_epoch: 50_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 50_000_000, 100_000_000)
  run(
    pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000,
    [vault], 6, rd, [ct_app_auth],
    [Pair(Spend(vref), burn_rd)],
  )
}

// ── HAPPY: epoch mới → meter reset (did_map=[], global=0) trước khi cộng op. ──
test pm_epoch_reset() {
  let pol = ct_policy(500_000_000, 0, 10_000_000_000, 100_000_000_000, 10)
  let proto = ct_protocol(500_000_000, True, 10)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  // meter_in epoch CŨ 6, có budget cũ — phải reset khi current=10.
  let m_in =
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 9_999_999_999)], global_lamp_epoch: 99_999_999_999,
    }
  let m_out =
    SponsorMeter {
      app_id: ct_app_id, epoch: 10,
      did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(
    pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000,
    [vault], 10, rd, [ct_app_auth],
    [Pair(Spend(vref), burn_rd)],
  )
}

// ── HAPPY: 2 vault PHÂN BIỆT cùng app — magic_consumed dedup Σ = 20M. ─────────
test pm_two_vault() {
  let pol = ct_policy(500_000_000, 0, 100_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref0 = util.mk_ref_id(#"a1", 0)
  let vref1 = util.mk_ref_id(#"a1", 1)
  let v0 = ct_vault_input(0, Some(ct_app_auth))
  let v1 = ct_vault_input(1, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let m_in = empty_meter(6)
  // magic 20M, rate 0.5× → cap 10M; lamp_this 10M.
  let m_out =
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 10_000_000)], global_lamp_epoch: 10_000_000,
    }
  let rd = ct_sponsor_rd([vref0, vref1], ct_owner, 10_000_000, 0)
  run(
    pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000,
    [v0, v1], 6, rd, [ct_app_auth],
    [Pair(Spend(vref0), burn_rd), Pair(Spend(vref1), burn_rd)],
  )
}

// ── NEG PM-1: thiếu app cosign → fail ────────────────────────────────────────
test pm_neg_no_cosign() fail {
  let pol = ct_policy(500_000_000, 0, 10_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let m_in = empty_meter(6)
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000 }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [], [Pair(Spend(vref), burn_rd)])
}

// ── NEG PM-1.5: app KHÔNG phải delegate của vault → fail ──────────────────────
test pm_neg_not_delegate() fail {
  let pol = ct_policy(500_000_000, 0, 10_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(#"deadbeef"))  // delegate khác app_auth
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let m_in = empty_meter(6)
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000 }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)])
}

// ── NEG PM-1.5: vault delegate None → fail ───────────────────────────────────
test pm_neg_delegate_none() fail {
  let pol = ct_policy(500_000_000, 0, 10_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, None)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let m_in = empty_meter(6)
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000 }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)])
}

// ── NEG PM-3: lamp_this vượt trần tỷ giá → fail ──────────────────────────────
test pm_neg_over_lamp_cap() fail {
  let pol = ct_policy(500_000_000, 0, 100_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])  // cap 5M
  let m_in = empty_meter(6)
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 5_000_001)], global_lamp_epoch: 5_000_001 }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_001, 0)  // > cap 5M
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)])
}

// ── NEG PM-3.5: lamp_per_magic_q < sàn → fail ────────────────────────────────
test pm_neg_below_floor() fail {
  let pol = ct_policy(400_000_000, 0, 100_000_000_000, 100_000_000_000, 6)  // 0.4× < sàn 0.5×
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let m_in = empty_meter(6)
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 4_000_000)], global_lamp_epoch: 4_000_000 }
  let rd = ct_sponsor_rd([vref], ct_owner, 4_000_000, 0)
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)])
}

// ── NEG PM-3.5: sponsor=0 khi protocol_fee_active → fail ─────────────────────
test pm_neg_sponsor_zero() fail {
  let pol = ct_policy(500_000_000, 0, 100_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)  // active → lamp_this>0 bắt buộc
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let m_in = empty_meter(6)
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 0)], global_lamp_epoch: 0 }
  let rd = ct_sponsor_rd([vref], ct_owner, 0, 0)  // sponsor 0
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)])
}

// ── NEG PM-5: per-DID cap vượt → fail ────────────────────────────────────────
test pm_neg_did_cap() fail {
  let pol = ct_policy(500_000_000, 0, 10_000_000_000, 100_000_000_000, 6)  // cap 10 LAMP
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  // burns lớn để cap đủ, did đã dùng 9.999 LAMP, op 5M → vượt 10 LAMP (oil).
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 1_000_000_000)])  // cap 500M
  let m_in =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 9_999_000_000)], global_lamp_epoch: 9_999_000_000 }
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 10_004_000_000)], global_lamp_epoch: 10_004_000_000 }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)  // 9.999G + 5M = 10.004G > 10G
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)])
}

// ── NEG PM-6: global cap vượt → fail ─────────────────────────────────────────
test pm_neg_global_cap() fail {
  let pol = ct_policy(500_000_000, 0, 1_000_000_000_000, 100_000_000_000, 6)  // glb 100 LAMP
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 1_000_000_000)])  // cap 500M
  let m_in =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 99_998_000_000)], global_lamp_epoch: 99_998_000_000 }
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 100_003_000_000)], global_lamp_epoch: 100_003_000_000 }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)  // global 99.998G + 5M > 100G
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)])
}

// ── NEG PM-10: policy stale (epoch quá cũ) → fail ────────────────────────────
test pm_neg_stale_policy() fail {
  let pol = ct_policy(500_000_000, 0, 10_000_000_000, 100_000_000_000, 1)  // epoch 1
  let proto = ct_protocol(500_000_000, True, 20)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let m_in = empty_meter(20)
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 20, did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000 }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  // current 20 − policy 1 = 19 > max_stale 10 → fail
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 20, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)])
}

// ── NEG PM-10: fake policy beacon (NFT qty=0) → fail ─────────────────────────
test pm_neg_fake_policy_nft() fail {
  let pol = ct_policy(500_000_000, 0, 10_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let m_in = empty_meter(6)
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000 }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(pol, 0, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)])
}

// ── NEG PM-2: khai magic_consumed giả — burn THẬT chỉ 10M nhưng app khai lamp_this
//    theo "20M" giả. Vì PM-2 đọc burns THẬT (10M → cap 5M), lamp_this 10M > cap → fail.
test pm_neg_fake_magic() fail {
  let pol = ct_policy(500_000_000, 0, 100_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])  // THẬT 10M → cap 5M
  let m_in = empty_meter(6)
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 10_000_000)], global_lamp_epoch: 10_000_000 }
  let rd = ct_sponsor_rd([vref], ct_owner, 10_000_000, 0)  // khai 10M > cap 5M
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)])
}

// ── NEG PM-7: 2 meter input @script → double-meter → count fail ──────────────
test pm_neg_double_meter() fail {
  let pol = ct_policy(500_000_000, 0, 100_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let m_in = empty_meter(6)
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000 }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  // thêm 1 meter input thứ 2 @paymaster script
  let extra_meter =
    util.mk_input(
      util.mk_ref_id(#"ad", 1),
      ct_meter_output(empty_meter(6), 1, 2_000_000),
    )
  let meter_i = ct_meter_input(m_in, 1, 2_000_000)
  let meter_o = ct_meter_output(m_out, 1, 2_000_000)
  let reds =
    [Pair(Spend(ct_meter_ref()), rd_data(rd)), Pair(Spend(vref), burn_rd)]
  let tx =
    Transaction {
      ..placeholder,
      inputs: [meter_i, extra_meter, vault],
      reference_inputs: [ct_policy_input(pol, 1), ct_protocol_input(proto, 1)],
      outputs: [meter_o],
      redeemers: reds,
      extra_signatories: [ct_app_auth],
      validity_range: interval.between(6 * ct_mspe, 6 * ct_mspe + 1),
    }
  paymaster.spend(
    ct_vault_sh, ct_burn_constr, ct_lamp_policy, ct_policy_nft, ct_meter_nft,
    ct_protocol_nft, ct_max_stale, ct_max_did, ct_mspe, Some(m_in), rd, ct_meter_ref(), tx,
  )
}

// ── NEG PM-11: drain ADA khỏi meter UTxO → value preservation fail ───────────
test pm_neg_drain_ada() fail {
  let pol = ct_policy(500_000_000, 0, 100_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let m_in = empty_meter(6)
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000 }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  // meter_in 10 ADA, meter_out 2 ADA → drain 8 ADA
  run(pol, 1, proto, 1, m_in, 1, 10_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)])
}

// ── NEG: meter NFT bị rút ở output (qty 0) → PM-7 fail ───────────────────────
test pm_neg_meter_nft_drain() fail {
  let pol = ct_policy(500_000_000, 0, 100_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let m_in = empty_meter(6)
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000 }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 0, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)])
}

// ── NEG PM-8: meter_in epoch FUTURE > current → meter_in.epoch <= current fail ─
test pm_neg_meter_future_epoch() fail {
  let pol = ct_policy(500_000_000, 0, 100_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let m_in = empty_meter(9)  // future > current 6
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000 }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)])
}

// ── NEG: state transition sai (meter_out global không khớp base+lamp_this) → fail
test pm_neg_bad_state() fail {
  let pol = ct_policy(500_000_000, 0, 100_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let m_in = empty_meter(6)
  // out global = 0 (đáng lẽ 5M) → fail
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 0 }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)])
}

// ── NEG PM-16: validity-range unbounded upper → get_epoch fail ───────────────
test pm_neg_unbounded() fail {
  let pol = ct_policy(500_000_000, 0, 100_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let m_in = empty_meter(6)
  let m_out =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000 }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  let meter_i = ct_meter_input(m_in, 1, 2_000_000)
  let meter_o = ct_meter_output(m_out, 1, 2_000_000)
  let tx =
    Transaction {
      ..placeholder,
      inputs: [meter_i, vault],
      reference_inputs: [ct_policy_input(pol, 1), ct_protocol_input(proto, 1)],
      outputs: [meter_o],
      redeemers: [Pair(Spend(ct_meter_ref()), rd_data(rd)), Pair(Spend(vref), burn_rd)],
      extra_signatories: [ct_app_auth],
      validity_range: interval.after(6 * ct_mspe),  // upper vô hạn
    }
  paymaster.spend(
    ct_vault_sh, ct_burn_constr, ct_lamp_policy, ct_policy_nft, ct_meter_nft,
    ct_protocol_nft, ct_max_stale, ct_max_did, ct_mspe, Some(m_in), rd, ct_meter_ref(), tx,
  )
}

// ── NEG PM-17: did_lamp_map vượt max_did_entries → hard-cap fail ─────────────
//    max_did_entries override = 1 (param). map output 2 entry → fail.
test pm_neg_did_cap_overflow() fail {
  let pol = ct_policy(500_000_000, 0, 100_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  // meter_in đã có 1 entry (did khác); op tạo entry thứ 2 cho ct_owner.
  let m_in =
    SponsorMeter { app_id: ct_app_id, epoch: 6, did_lamp_map: [(#"feed", 1_000_000)], global_lamp_epoch: 1_000_000 }
  let m_out =
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(#"feed", 1_000_000), (ct_owner, 5_000_000)], global_lamp_epoch: 6_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  let meter_i = ct_meter_input(m_in, 1, 2_000_000)
  let meter_o = ct_meter_output(m_out, 1, 2_000_000)
  let tx =
    Transaction {
      ..placeholder,
      inputs: [meter_i, vault],
      reference_inputs: [ct_policy_input(pol, 1), ct_protocol_input(proto, 1)],
      outputs: [meter_o],
      redeemers: [Pair(Spend(ct_meter_ref()), rd_data(rd)), Pair(Spend(vref), burn_rd)],
      extra_signatories: [ct_app_auth],
      validity_range: interval.between(6 * ct_mspe, 6 * ct_mspe + 1),
    }
  // max_did_entries = 1 → output 2 entry vi phạm
  paymaster.spend(
    ct_vault_sh, ct_burn_constr, ct_lamp_policy, ct_policy_nft, ct_meter_nft,
    ct_protocol_nft, ct_max_stale, 1, ct_mspe, Some(m_in), rd, ct_meter_ref(), tx,
  )
}
