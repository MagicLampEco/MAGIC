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
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId, Value}
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
  treasury_addr       : Address,    // SEC-01 fix: ép LAMP đến đúng Treasury
  lamp_asset_name     : AssetName,  // SEC-01 fix: thay #"744c414d50" hardcode
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

    // ── PM-TREASURY (SEC-01 fix): LAMP phải thực sự đến Treasury ─────────────
    // Chống attacker chỉ claim LAMP đã trả nhưng thực tế gửi địa chỉ khác.
    //
    // 🔴 ĐÂY NAY LÀ CHÂN THU LAMP DUY NHẤT CỦA TREASURY trong kho này, không phải một
    // bản sao của chỗ khác. Chú thích cũ viết "Mirror pattern từ InstantGen vault.ak
    // validate_gen (treasury_receives_lamp)" — hàm đó KHÔNG CÒN TỒN TẠI, chính
    // `InstantGen/onchain/validators/vault.ak:1144` khai nó đã bị gỡ. Sau I-ACT-7 không
    // generator nào trả LAMP về Treasury nữa. Đo thật 2026-09-05 —
    // `grep -rlni treasury --include='*.ak'` ngoài `Legacy/` cho 5 tệp, và 4 trong số đó
    // chỉ còn là bia mộ, không phải chân thu:
    //   · InstantGen/onchain/validators/vault.ak:1144-1146   "helper GONE, no treasury_addr"
    //   · InstantGen/onchain/lib/magiclamp/protocol/lamp.ak:8 "ĐÃ XOÁ 2026-08-09, 0 call site"
    //   · ScheduleGen/onchain/validators/vault.ak:14,1195,1197 "apply-parameter is gone"
    //   · ConsumeMAGIC/onchain/validators/consume.ak          (tham chiếu bài học audit)
    // Còn lại đúng tệp này. (Lệnh phải quote `'*.ak'` — không quote thì zsh tự nở glob
    // và trả `no matches found` trước khi grep chạy.)
    //
    // Nghĩa là chân thu dời từ hành vi SINH sang hành vi BẢO TRỢ: Treasury không thu khi
    // ai đó sinh MAGIC, mà thu khi một app trả phí hộ người dùng. Ai sửa khối này đang
    // sửa đường thu duy nhất — không có chỗ thứ hai đỡ.
    expect if lamp_this > 0 {
      let lamp_to_treasury =
        tx.outputs
          |> list.filter(fn(o) { o.address == treasury_addr })
          |> list.foldl(
               0,
               fn(o, acc) {
                 acc + assets.quantity_of(o.value, lamp_policy_id, lamp_asset_name)
               },
             )
      lamp_to_treasury >= lamp_this
    } else {
      True
    }

    // ── PM-4: ada_this ≤ ⌊ magic_consumed × ada_per_magic_q / Q ⌋ (trần) ──────
    expect ada_this >= 0
    expect ada_this <= ada_cap(magic_consumed, policy.ada_per_magic_q)

    // ── PM-8: epoch lock + reset đúng. Base (pre-op) state lấy theo epoch. ─────
    expect meter_out_datum.epoch == current_epoch
    expect meter_in.epoch <= current_epoch
    let (base_map, base_global, base_magic) =
      if meter_in.epoch < current_epoch {
        // epoch mới → reset budget cũ TRƯỚC khi cộng op này (chống replay budget)
        ([], 0, 0)
      } else {
        (meter_in.did_lamp_map, meter_in.global_lamp_epoch, meter_in.global_magic_epoch)
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
    // P0-5: global_magic_epoch tích luỹ nanogic tiêu trong epoch (cho FlowRateKeeper)
    expect meter_out_datum.global_magic_epoch == base_magic + magic_consumed

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
//
// 🔴 🪦 CỔNG NÀY KHÔNG CÒN THOẢ ĐƯỢC SAU 2026-09-16 (Nợ #14) — đọc trước khi sửa.
// Nhánh uỷ nhiệm bị bỏ khỏi mô hình: `SetDelegate` ở cả ba vault
// (ScheduleGen · InstantGen · PrepaidGen) nay chỉ XOÁ được, không đặt được, nên
// không vault nào còn có `personal_delegate == Some(app)`. Hệ quả: đường Sponsor
// của Paymaster đứng lại — fail-closed, không phải lỗ.
//
// KHÔNG tự vá bằng cách nới cổng này. Paymaster chưa deploy ở mạng nào
// (`scripts/DEPLOYED.md` không có mục nào cho nó), nên đây là chuyện THỜI THIẾT
// KẾ, và mô hình quyền của Paymaster là thứ chủ dự án chốt chứ không phải thứ
// suy ra từ một cổng. Câu phải hỏi trước khi gõ dòng đầu tiên: app chứng minh
// được người dùng đồng ý bằng CÁI GÌ, khi không còn trường uỷ quyền trong datum?
// Cổng để nguyên cho tới lúc có câu trả lời — một cổng không thoả được thì chặn
// mọi thứ, còn một cổng bị nới vội thì cho qua đúng thứ vừa bỏ.
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
const ct_lamp_asset_name: AssetName = #"744c414d50"  // SEC-01 fix: "tLAMP"

// ── Địa chỉ kho dùng trong bộ kiểm ────────────────────────────────────────────
// 🔴 Kho PHẢI là BASE ADDRESS (có stake part), không phải enterprise.
// Bản cũ dùng `util.script_address(#"beef")` ⟹ stake_credential = None, và CÙNG
// một giá trị đó vừa làm apply-param `treasury_addr` vừa làm địa chỉ dựng output
// ⟹ phép so `o.address == treasury_addr` khớp TẦM THƯỜNG ở mọi ca, nên cổng thu
// LAMP (PM-TREASURY) có độ phủ 0: gỡ hẳn mệnh đề `lamp_to_treasury >= lamp_this`
// mà bộ kiểm vẫn 28/28 xanh (đo bằng ablation 2026-09-16).
// Tệ hơn: cấu hình enterprise đó là cấu hình mà cổng deploy CẤM —
// `scripts/deployParams.ts` ▸ `assertTreasuryStakeDecided` ném lỗi nếu kho không
// có stake part. Bộ kiểm on-chain chưa bao giờ chạy đúng hình dạng sẽ deploy.
const ct_treasury_pay: ByteArray = #"beef"    // payment script hash của kho
const ct_treasury_stake: ByteArray = #"5eed"  // stake part THẬT của kho
const ct_drifted_stake: ByteArray = #"5eed01" // kho đã trôi stake part (sau Refill)
const ct_attacker_stake: ByteArray = #"a77ac4" // stake credential của kẻ tấn công

/// Kho THẬT: base address = (payment script, stake vkh). Đây là giá trị đi vào
/// apply-param `treasury_addr` của MỌI ca kiểm.
fn ct_treasury_addr() -> Address {
  util.script_address_staked(ct_treasury_pay, ct_treasury_stake)
}

/// Ca âm 1 — enterprise: ĐÚNG payment credential, KHÔNG có stake part.
fn ct_treasury_addr_enterprise() -> Address {
  util.script_address(ct_treasury_pay)
}

/// Ca âm 2 — kho đã trôi: đúng payment credential, stake vkh KHÁC.
fn ct_treasury_addr_drifted() -> Address {
  util.script_address_staked(ct_treasury_pay, ct_drifted_stake)
}

/// Ca âm 3 — đúng payment credential, stake credential của kẻ tấn công
/// (khác cả GIÁ TRỊ lẫn LOẠI credential).
fn ct_treasury_addr_attacker_stake() -> Address {
  util.script_address_stake_script(ct_treasury_pay, ct_attacker_stake)
}

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
///
/// 17 ở đây là CỐ Ý và vẫn đúng sau khi InstantGen lên 18 trường (2026-09-21):
/// `vault_delegate_is` đọc theo VỊ TRÍ qua `list.at(fields, 15)`, không giải mã trọn
/// datum, nên nó không quan tâm danh sách dài 17 hay 18. Fixture này vì thế ghim đúng
/// điều cần ghim — trường 15 nằm ở chỉ số 15 — và sẽ đỏ đúng lúc ai đó CHÈN một trường
/// vào GIỮA thay vì thêm ở cuối. Đừng "cập nhật" nó thành 18: làm thế là buộc fixture
/// đi theo một hình dạng mà mã đang đo cố ý không phụ thuộc vào.
fn ct_vault_datum(delegate: Option<ByteArray>) -> Data {
  // VaultDatum, 17 trường đầu (đọc field index 15 = personal_delegate).
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
/// lamp_to_tsy: oildrop LAMP gửi về treasury (SEC-01). Nếu > 0 thêm output @treasury_addr.
/// Apply-param `treasury_addr` LUÔN là `ct_treasury_addr()` (base address) — ca nào cần
/// output rơi ở địa chỉ KHÁC thì gọi `run_to`.
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
  lamp_to_tsy   : Int,
) -> Bool {
  run_to(
    policy, policy_nft_q, protocol, protocol_nft_q, meter_in, meter_nft_in,
    meter_in_lvl, meter_out, meter_nft_out, meter_out_lvl, vault_inputs,
    cur_epoch, rd, signers, extra_reds, lamp_to_tsy, ct_treasury_addr(),
    ct_lamp_policy, ct_lamp_asset_name,
  )
}

/// Như `run` nhưng ĐỊA CHỈ nhận LAMP tách khỏi apply-param `treasury_addr`.
/// Đây là thứ bản cũ KHÔNG có: một mock duy nhất dùng cho cả hai vế làm phép so
/// `o.address == treasury_addr` khớp tầm thường ⟹ cổng PM-TREASURY không đo được.
fn run_to(
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
  lamp_to_tsy   : Int,
  tsy_out_addr  : Address,
  // Định danh tài sản rót vào kho, tách khỏi apply-param `lamp_policy_id`.
  // Cùng lý do với `tsy_out_addr`: một mock dùng cho cả hai vế làm phép so khớp
  // tầm thường. Cổng đích có HAI nửa — AI nhận (`o.address == treasury_addr`) và
  // NHẬN CÁI GÌ (`quantity_of(o.value, lamp_policy_id, lamp_asset_name)`) — và
  // bản cũ chỉ tách được nửa thứ nhất: gỡ HẲN vế policy id, hoặc gỡ HẲN vế asset
  // name, bộ kiểm vẫn xanh toàn phần (đo bằng ablation 2026-09-16).
  tsy_policy    : PolicyId,
  tsy_name      : AssetName,
) -> Bool {
  let meter_i = ct_meter_input(meter_in, meter_nft_in, meter_in_lvl)
  let meter_o = ct_meter_output(meter_out, meter_nft_out, meter_out_lvl)
  // SEC-01 fix: tạo treasury output nếu lamp_to_tsy > 0
  let treasury_outs =
    if lamp_to_tsy > 0 {
      let tsy_val =
        assets.add(
          assets.from_lovelace(2_000_000),
          tsy_policy,
          tsy_name,
          lamp_to_tsy,
        )
      // 🔴 KHÔNG DATUM — và đây là hình dạng, không phải tiện tay.
      //
      // Bên giữ kho là `LAMP/Distribution/onchain/validators/treasury.ak` ▸
      // `fold_ledger`: nhánh `NoDatum -> acc` cộng value vào `value_in` mà bỏ
      // qua phần sổ cái, tức UTxO không datum HÚT ĐƯỢC bằng `Refill`; tệp đó
      // khai thẳng đây là hình dạng của LAMP rót về kho qua A-DEST, và có hai
      // bài canh (`refill_absorb_no_datum_utxo_ok`, `refill_run_on_no_datum_input_ok`).
      // Bên dựng giao dịch cũng phát ra đúng hình dạng này: `paymaster.ts` ▸
      // `buildSponsorTx` dùng `pay.ToAddress`, không gắn datum.
      //
      // Bản trước của dòng này dựng `InlineDatum(Constr 0 [])`. Validator kho
      // KHÔNG soi datum nên nó vẫn xanh — nhưng `fold_ledger` giải mã nhánh
      // `InlineDatum(d)` bằng `expect td: TreasuryDatum = d`, mà `TreasuryDatum`
      // có 2 trường còn `Constr 0 []` có 0, và Aiken nghiêm ngặt số trường CẢ
      // HAI CHIỀU (`BOUNDARIES.md §2`) ⟹ mọi `Refill` chạm UTxO đó chết ở dòng
      // `expect`, và không nhánh nào khác cứu. Tức bộ kiểm — nguồn DUY NHẤT
      // trong kho mô tả "output trả tiền về kho trông như thế nào" — đang khai
      // một hình dạng KẸT VĨNH VIỄN. Ai sửa builder cho khớp nó thì mỗi lần
      // bảo trợ ném vĩnh viễn `lamp_this` + min-ADA vào một UTxO không ai hút
      // nổi, và không gì đỏ. Đúng ca `Forall §Rót đúng ĐỊA CHỈ không phải rót
      // vào SỔ`, chỉ khác chiều vào.
      [util.mk_output_no_datum(tsy_out_addr, tsy_val)]
    } else {
      []
    }
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
      outputs: list.concat([meter_o], treasury_outs),
      redeemers: list.concat(base_reds, extra_reds),
      extra_signatories: signers,
      validity_range: interval.between(cur_epoch * ct_mspe, cur_epoch * ct_mspe + 1),
    }
  paymaster.spend(
    ct_vault_sh, ct_burn_constr, ct_lamp_policy, ct_policy_nft, ct_meter_nft,
    ct_protocol_nft, ct_max_stale, ct_max_did, ct_mspe,
    ct_treasury_addr(), ct_lamp_asset_name,
    Some(meter_in), rd, ct_meter_ref(), tx,
  )
}

fn empty_meter(epoch: Int) -> SponsorMeter {
  SponsorMeter {
    app_id: ct_app_id, epoch, did_lamp_map: [], global_lamp_epoch: 0, global_magic_epoch: 0,
  }
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
      global_magic_epoch: 10_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(
    pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000,
    [vault], 6, rd, [ct_app_auth],
    [Pair(Spend(vref), burn_rd)],
    5_000_000,  // lamp_to_tsy = lamp_this (SEC-01)
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
      global_magic_epoch: 50_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 50_000_000, 100_000_000)
  run(
    pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000,
    [vault], 6, rd, [ct_app_auth],
    [Pair(Spend(vref), burn_rd)],
    50_000_000,  // lamp_to_tsy = lamp_this (SEC-01)
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
      global_magic_epoch: 999_999_999_999,  // giá trị cũ — bị reset
    }
  let m_out =
    SponsorMeter {
      app_id: ct_app_id, epoch: 10,
      did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000,
      global_magic_epoch: 10_000_000,       // reset: 0 + 10M burns = 10M
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(
    pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000,
    [vault], 10, rd, [ct_app_auth],
    [Pair(Spend(vref), burn_rd)],
    5_000_000,  // lamp_to_tsy = lamp_this (SEC-01)
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
  // magic 20M (2 vault × 10M), rate 0.5× → cap 10M; lamp_this 10M.
  let m_out =
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 10_000_000)], global_lamp_epoch: 10_000_000,
      global_magic_epoch: 20_000_000,  // Σ burns = 2 × 10M
    }
  let rd = ct_sponsor_rd([vref0, vref1], ct_owner, 10_000_000, 0)
  run(
    pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000,
    [v0, v1], 6, rd, [ct_app_auth],
    [Pair(Spend(vref0), burn_rd), Pair(Spend(vref1), burn_rd)],
    10_000_000,  // lamp_to_tsy = lamp_this (SEC-01)
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CHỐT NÀO THẬT SỰ ĐƯỢC GHIM — số ĐO bằng ablation, không suy từ tên bài
//
// 🔴 PHẠM VI. Đo 2026-09-16 trên ĐÚNG chín chốt mà chín ca âm dưới đây mang tên.
// Phép đo: thay thân chốt bằng `expect True` (cắm một dấu riêng rồi kiểm dấu có
// trong tệp trước khi đọc kết quả), chạy TRỌN bộ kiểm, một chốt một lượt:
//     script -q /dev/null aiken check Paymaster/onchain
// Đọc ở dòng `Summary` + danh sách `FAIL [mem`. Bộ kiểm còn xanh khi đã gỡ chốt
// ⟹ KHÔNG bài nào canh chốt đó (`Forall §Kỷ luật phát ngôn` mục 6). Khối này
// KHÔNG nói gì về các chốt ngoài chín cái đã liệt kê.
//
// TRƯỚC bản vá fixture này (bản `51fff820`): gỡ từng chốt trong CẢ CHÍN → mỗi lần
// đều `35 checks, 0 errors`. **0/9 được ghim.** Chín ca âm đều đỏ đúng dòng mang
// tên chúng, nhưng chúng chết ở cổng PM-TREASURY phía sau: fixture rót
// `lamp_to_tsy = 0` trong khi `lamp_this > 0`, nên gỡ chốt đầu thì giao dịch chỉ
// trượt xuống cổng thu và vẫn bị từ chối. Đúng ca "bài trượt xuống chốt kế tiếp".
//
// SAU bản vá (`lamp_to_tsy` bám đúng `lamp_this` từng ca; `global_magic_epoch`
// bám đúng Σ burns):
//   ĐƯỢC GHIM — gỡ chốt là ca tương ứng đỏ
//     PM-1  app cosign          → pm_neg_no_cosign
//     PM-1.5 vault delegate     → pm_neg_not_delegate, pm_neg_delegate_none
//     PM-3.5 sàn DAO            → pm_neg_below_floor
//     PM-3.5 sponsor ≠ 0        → pm_neg_sponsor_zero
//     PM-10 policy stale        → pm_neg_stale_policy
//     PM-10 policy NFT          → pm_neg_fake_policy_nft
//   CHƯA ghim MỘT MÌNH — hai chốt TRÙNG NHAU, gỡ một cái thì cái kia đỡ:
//     PM-3 ↔ PM-12 (trần lamp)  → gỡ CẢ HAI ⟹ pm_neg_over_lamp_cap +
//                                  pm_neg_fake_magic đỏ
//     PM-7 (NFT ở output) ↔ PM-11 (`value_preserved`) → gỡ CẢ HAI ⟹
//                                  pm_neg_meter_nft_drain + pm_neg_drain_ada đỏ
//   KHÔNG ghim, và KHÔNG có chốt song sinh nào giải thích:
//     PM-2 `magic_consumed > 0` → gỡ nó (một mình, và kèm cả PM-3 + PM-12) đều
//     không làm ca nào đỏ thêm. Không ca âm nào dựng `magic_consumed == 0`.
//     Sổ nợ: `DevStatus.md` ▸ Nợ #77.
// ─────────────────────────────────────────────────────────────────────────────

// ── NEG PM-1: thiếu app cosign → fail ────────────────────────────────────────
test pm_neg_no_cosign() fail {
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
      global_magic_epoch: 10_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [], [Pair(Spend(vref), burn_rd)], 5_000_000)
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
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000,
      global_magic_epoch: 10_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)], 5_000_000)
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
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000,
      global_magic_epoch: 10_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)], 5_000_000)
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
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 5_000_001)], global_lamp_epoch: 5_000_001,
      global_magic_epoch: 10_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_001, 0)  // > cap 5M
  // `lamp_to_tsy` phải bám ĐÚNG `lamp_this` của từng ca, không phải một hằng chung:
  // cổng kho là `lamp_to_treasury >= lamp_this`, nên rót thiếu 1 oildrop là ca này
  // chết ở cổng kho chứ không chết ở PM-3 — đúng thứ ca này mang tên.
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)], 5_000_001)
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
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 4_000_000)], global_lamp_epoch: 4_000_000,
      global_magic_epoch: 10_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 4_000_000, 0)
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)], 5_000_000)
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
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 0)], global_lamp_epoch: 0,
      global_magic_epoch: 10_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 0, 0)  // sponsor 0
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)], 5_000_000)
}

// ── NEG PM-5: per-DID cap vượt → fail ────────────────────────────────────────
test pm_neg_did_cap() fail {
  let pol = ct_policy(500_000_000, 0, 10_000_000_000, 100_000_000_000, 6)  // cap 10 LAMP
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  // burns lớn để cap đủ, did đã dùng 9.999 LAMP, op 5M → vượt 10 LAMP (oildrop).
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 1_000_000_000)])  // cap 500M
  let m_in =
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 9_999_000_000)], global_lamp_epoch: 9_999_000_000,
      global_magic_epoch: 0,
    }
  let m_out =
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 10_004_000_000)], global_lamp_epoch: 10_004_000_000,
      // = Σ burns. Để 0 thì bài này còn chết ở chốt chuyển-trạng-thái
      // `global_magic_epoch == base_magic + magic_consumed` — một chốt THỨ HAI,
      // độc lập với cổng did-cap mang tên bài. Đo bằng ablation 2026-09-16: gỡ
      // hẳn PM-5 **và** PM-6 mà bộ kiểm vẫn 33/33; phải gỡ thêm chốt chuyển-
      // trạng-thái thì bài này mới lật. Hai cổng cùng giữ một bài đỏ = bài đó
      // không ghim cổng nào.
      global_magic_epoch: 1_000_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)  // 9.999G + 5M = 10.004G > 10G
  // lamp_to_tsy = lamp_this: PM-TREASURY đứng TRƯỚC PM-5, để 0 thì bài này chết ở
  // cổng thu LAMP chứ không ở cổng did-cap mang tên nó (đo bằng ablation 2026-09-16).
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)], 5_000_000)
}

// ── NEG PM-6: global cap vượt → fail ─────────────────────────────────────────
test pm_neg_global_cap() fail {
  let pol = ct_policy(500_000_000, 0, 1_000_000_000_000, 100_000_000_000, 6)  // glb 100 LAMP
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 1_000_000_000)])  // cap 500M
  let m_in =
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 99_998_000_000)], global_lamp_epoch: 99_998_000_000,
      global_magic_epoch: 0,
    }
  let m_out =
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 100_003_000_000)], global_lamp_epoch: 100_003_000_000,
      global_magic_epoch: 1_000_000_000,  // = Σ burns — xem ghi chú ở pm_neg_did_cap
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)  // global 99.998G + 5M > 100G
  // lamp_to_tsy = lamp_this — xem ghi chú ở pm_neg_did_cap.
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)], 5_000_000)
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
    SponsorMeter {
      app_id: ct_app_id, epoch: 20,
      did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000,
      global_magic_epoch: 10_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  // current 20 − policy 1 = 19 > max_stale 10 → fail
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 20, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)], 5_000_000)
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
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000,
      global_magic_epoch: 10_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(pol, 0, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)], 5_000_000)
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
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 10_000_000)], global_lamp_epoch: 10_000_000,
      global_magic_epoch: 10_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 10_000_000, 0)  // khai 10M > cap 5M
  // Rót đủ 10M vào kho để cổng kho KHÔNG bắt hộ: ca này phải chết vì trần tỷ giá.
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)], 10_000_000)
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
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000,
      global_magic_epoch: 0,
    }
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
    ct_protocol_nft, ct_max_stale, ct_max_did, ct_mspe,
    ct_treasury_addr(), ct_lamp_asset_name,
    Some(m_in), rd, ct_meter_ref(), tx,
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
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000,
      global_magic_epoch: 10_000_000,  // = Σ burns, để KHÔNG chết ở state-transition
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  // meter_in 10 ADA, meter_out 2 ADA → drain 8 ADA
  // lamp_to_tsy = lamp_this + global_magic_epoch ĐÚNG (= burns 10M): thiếu một trong
  // hai thì bài chết ở PM-TREASURY hoặc ở cổng state-transition, cả hai đều đứng
  // TRƯỚC PM-11 value-preservation mang tên bài này.
  run(pol, 1, proto, 1, m_in, 1, 10_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)], 5_000_000)
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
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000,
      global_magic_epoch: 10_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 0, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)], 5_000_000)
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
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000,
      global_magic_epoch: 10_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  // lamp_to_tsy = lamp_this — xem ghi chú ở pm_neg_did_cap.
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)], 5_000_000)
}

// ── NEG: state transition sai (meter_out global không khớp base+lamp_this) → fail
test pm_neg_bad_state() fail {
  let pol = ct_policy(500_000_000, 0, 100_000_000_000, 100_000_000_000, 6)
  let proto = ct_protocol(500_000_000, True, 6)
  let vref = util.mk_ref_id(#"a1", 0)
  let vault = ct_vault_input(0, Some(ct_app_auth))
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let m_in = empty_meter(6)
  // out global_lamp_epoch = 0 (đáng lẽ 5M) → fail tại PM-8 state transition check
  let m_out =
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 0,
      global_magic_epoch: 10_000_000,  // đúng để fail đúng chỗ global_lamp_epoch
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run(pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000, [vault], 6, rd, [ct_app_auth], [Pair(Spend(vref), burn_rd)], 5_000_000)
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
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(ct_owner, 5_000_000)], global_lamp_epoch: 5_000_000,
      global_magic_epoch: 0,
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
      validity_range: interval.after(6 * ct_mspe),  // upper vô hạn
    }
  paymaster.spend(
    ct_vault_sh, ct_burn_constr, ct_lamp_policy, ct_policy_nft, ct_meter_nft,
    ct_protocol_nft, ct_max_stale, ct_max_did, ct_mspe,
    ct_treasury_addr(), ct_lamp_asset_name,
    Some(m_in), rd, ct_meter_ref(), tx,
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
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(#"feed", 1_000_000)], global_lamp_epoch: 1_000_000,
      global_magic_epoch: 0,
    }
  let m_out =
    SponsorMeter {
      app_id: ct_app_id, epoch: 6,
      did_lamp_map: [(#"feed", 1_000_000), (ct_owner, 5_000_000)], global_lamp_epoch: 6_000_000,
      global_magic_epoch: 10_000_000,  // = Σ burns, để KHÔNG chết ở state-transition
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  let meter_i = ct_meter_input(m_in, 1, 2_000_000)
  let meter_o = ct_meter_output(m_out, 1, 2_000_000)
  // PM-TREASURY đứng TRƯỚC cổng hard-cap mang tên bài này → phải trả đủ LAMP về kho,
  // nếu không bài đỏ ở cổng thu chứ không ở cổng did-entries.
  // 🪦 Bản trước dựng output này bằng `builtin.constr_data(0, [])` — đúng hình dạng
  // mà khối chú thích của `run_to` gọi là CHẾT VĨNH VIỄN (`TreasuryDatum` có 2 trường,
  // `fold_ledger` giải mã bằng `expect td: TreasuryDatum = d`). Bộ kiểm là nguồn duy
  // nhất trong kho mô tả "output trả tiền về kho trông như thế nào", và đây là bài duy
  // nhất dựng giao dịch bằng tay, nên nó cũng là bài dễ được chép làm mẫu nhất.
  let tsy_o =
    util.mk_output_no_datum(
      ct_treasury_addr(),
      assets.add(assets.from_lovelace(2_000_000), ct_lamp_policy, ct_lamp_asset_name, 5_000_000),
    )
  let tx =
    Transaction {
      ..placeholder,
      inputs: [meter_i, vault],
      reference_inputs: [ct_policy_input(pol, 1), ct_protocol_input(proto, 1)],
      outputs: [meter_o, tsy_o],
      redeemers: [Pair(Spend(ct_meter_ref()), rd_data(rd)), Pair(Spend(vref), burn_rd)],
      extra_signatories: [ct_app_auth],
      validity_range: interval.between(6 * ct_mspe, 6 * ct_mspe + 1),
    }
  // max_did_entries = 1 → output 2 entry vi phạm
  paymaster.spend(
    ct_vault_sh, ct_burn_constr, ct_lamp_policy, ct_policy_nft, ct_meter_nft,
    ct_protocol_nft, ct_max_stale, 1, ct_mspe,
    ct_treasury_addr(), ct_lamp_asset_name,
    Some(m_in), rd, ct_meter_ref(), tx,
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// PM-TREASURY — cổng thu LAMP DUY NHẤT của kho. Khối này là phép đo của riêng nó.
//
// Trước 2026-09-16 cổng đó có ĐỘ PHỦ 0: gỡ hẳn mệnh đề `lamp_to_treasury >=
// lamp_this` mà 28/28 bài vẫn xanh. Nguyên nhân ở fixture, không ở validator —
// `ct_treasury_addr()` cũ là enterprise address và được dùng cho CẢ apply-param
// LẪN địa chỉ dựng output, nên `o.address == treasury_addr` khớp tầm thường.
//
// Bốn ca âm dưới đây đều giữ NGUYÊN mọi điều kiện khác của `pm_happy` và chỉ
// đổi đúng một thứ, nên chúng chết ở PM-TREASURY chứ không ở cổng nào khác. Ca
// dương `pm_pos_treasury_base_address_exact` là ĐỐI CHỨNG: không có nó thì bốn
// ca âm có thể đỏ vì một lý do tầm thường nào đó chứ không vì cổng làm việc.
// ══════════════════════════════════════════════════════════════════════════════

/// Cấu hình chuẩn dùng chung cho cả khối PM-TREASURY: bản sao đúng của `pm_happy`
/// (burns 10M, rate 0.5×Q → lamp_cap 5M, lamp_this 5M), chỉ thay ĐỊA CHỈ nhận
/// LAMP và SỐ LƯỢNG gửi về kho.
fn tsy_case(lamp_to_tsy: Int, tsy_out_addr: Address) -> Bool {
  tsy_case_pair(lamp_to_tsy, tsy_out_addr, ct_lamp_policy, ct_lamp_asset_name)
}

/// Như `tsy_case` nhưng đổi được ĐỊNH DANH tài sản rót vào kho.
fn tsy_case_pair(
  lamp_to_tsy  : Int,
  tsy_out_addr : Address,
  tsy_policy   : PolicyId,
  tsy_name     : AssetName,
) -> Bool {
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
      global_magic_epoch: 10_000_000,
    }
  let rd = ct_sponsor_rd([vref], ct_owner, 5_000_000, 0)
  run_to(
    pol, 1, proto, 1, m_in, 1, 2_000_000, m_out, 1, 2_000_000,
    [vault], 6, rd, [ct_app_auth],
    [Pair(Spend(vref), burn_rd)],
    lamp_to_tsy, tsy_out_addr, tsy_policy, tsy_name,
  )
}

// ── ĐỐI CHỨNG DƯƠNG: base address == base address, đủ LAMP → CHẤP NHẬN ───────
test pm_pos_treasury_base_address_exact() {
  tsy_case(5_000_000, ct_treasury_addr())
}

// ── NEG PM-TREASURY 1: output tới ENTERPRISE address (stake = None) trong khi
//    apply-param là base address. Cùng payment credential, vẫn phải bị TỪ CHỐI.
test pm_neg_treasury_enterprise_address() fail {
  tsy_case(5_000_000, ct_treasury_addr_enterprise())
}

// ── NEG PM-TREASURY 2: kho đã TRÔI stake part (mô phỏng sau `Refill`). Đúng
//    payment credential, stake vkh khác → TỪ CHỐI.
test pm_neg_treasury_stake_drifted() fail {
  tsy_case(5_000_000, ct_treasury_addr_drifted())
}

// ── NEG PM-TREASURY 3: đúng payment credential, stake credential của KẺ TẤN CÔNG
//    (khác cả giá trị lẫn loại credential) → TỪ CHỐI. Đây là ca "phần thưởng uỷ
//    quyền trên ADA của kho chảy về khoá stake của kẻ khác".
test pm_neg_treasury_attacker_stake() fail {
  tsy_case(5_000_000, ct_treasury_addr_attacker_stake())
}

// ── NEG PM-TREASURY 4: ĐÚNG địa chỉ nhưng THIẾU 1 oildrop → ghim CHIỀU của phép
//    so `>=`, thứ mà ba ca địa chỉ ở trên không chạm tới.
test pm_neg_treasury_amount_short() fail {
  tsy_case(4_999_999, ct_treasury_addr())
}

// ── NEG PM-TREASURY 5+6: nửa TÀI SẢN của cổng đích ───────────────────────────
//
// Bốn ca trên ghim nửa "AI nhận" và chiều của phép so `>=`. Chúng KHÔNG chạm
// nửa "NHẬN CÁI GÌ": đo 2026-09-16 bằng hai đột biến độc lập — đếm theo asset
// name qua MỌI policy, rồi đếm theo policy qua MỌI tên — bộ kiểm **xanh toàn
// phần ở cả hai**. Tức vế `policy_id` và vế `asset_name` của
// `assets.quantity_of(o.value, lamp_policy_id, lamp_asset_name)` đều gỡ ra được
// mà không bài nào lật.
//
// Chỗ này không phải một góc hiếm. `BOUNDARIES.md §1` ghi thành bất biến của
// kho: **định danh tài sản là CẶP `(policy id, asset name)`; policy id là điều
// kiện ĐỦ, asset name KHÔNG BAO GIỜ là** — và testnet đang có **27 dòng tài
// sản** mang tên của hệ này dưới một policy chữ-ký-đơn không phải của LAMP,
// trong đó có một dòng `tLAMP` mang trọn 36 tỷ. Kịch bản hỏng nếu ai "tối ưu"
// phép đếm thành so theo tên: app bảo trợ rót token nhái vào kho, phép đếm
// cộng đủ, giao dịch được chấp nhận, sổ ghi `lamp_this` như đã trả phí thật.
// Kho nhận rác, sổ ghi có, bộ kiểm xanh.
//
// Hai bài đối xứng vì mỗi bài chỉ ghim được MỘT vế: bài đầu sai policy (đúng
// tên), bài sau sai tên (đúng policy). Cả hai giữ nguyên địa chỉ kho và giữ
// nguyên lượng, nên chúng không thể đỏ nhờ ba ca địa chỉ hay ca thiếu-lượng.
test pm_neg_treasury_lookalike_policy() fail {
  tsy_case_pair(5_000_000, ct_treasury_addr(), #"2222", ct_lamp_asset_name)
}

test pm_neg_treasury_wrong_asset_name() fail {
  tsy_case_pair(5_000_000, ct_treasury_addr(), ct_lamp_policy, #"6c616d70")
}
