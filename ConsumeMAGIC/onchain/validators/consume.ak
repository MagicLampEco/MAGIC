// consume.ak — ENGAGEMENT-STATE validator (rewrite D1). KHÔNG token, KHÔNG tx.mint.
// PlutusV3 / Aiken. Pure BigInt.
//
// ── MÔ HÌNH (thay token-burn cũ — PR #13) ─────────────────────────────────────
// MAGIC = số kế toán trong VaultDatum.magic_batches của generator vault. Tiêu MAGIC
// = handler BurnBatch của VAULT validator giảm current_amount (nơi DUY NHẤT giảm
// MAGIC). ConsumeMAGIC KHÔNG mint, KHÔNG chạm MAGIC trực tiếp; nó là lớp PRICING +
// ENGAGEMENT/ATTRIBUTION per-app:
//   - đọc PriceParam beacon → tính required (giá có thẩm quyền).
//   - spend Engage UTxO (state per-app): tăng consumed_count, refresh last_epoch,
//     did_commit immutable, thread NFT bảo toàn, owner bảo toàn, value bảo toàn.
//   - ÉP cùng tx có 1 vault input (vault_ref) spend bằng BurnBatch với
//     Σburns == required → liên kết 2 validator, không lệch giá, không over/under-burn.
//
// Parameterized by:
//   price_nft_policy / price_nft_name   : authenticity NFT của PriceParam beacon
//   engage_nft_policy / engage_nft_name : thread token neo state engagement
//   vault_script_hash                   : payment script hash của generator vault
//   burn_batch_constr                   : constr index của BurnBatch trong
//                                         VaultRedeemer của vault đó (Instant=2,
//                                         Snapshot=1, Vacuum=4, Schedule=2). Per-vault
//                                         param → 1 deploy ConsumeMAGIC / 1 loại vault.
//   max_price_stale : số epoch tối đa cho phép dùng giá
//   ms_per_epoch    : POSIX ms / epoch (network-specific)
//
// DOUBLE-SATISFACTION (engage side): validator chạy 1 lần / Engage input. Các bất biến
// AGGREGATE (idempotent qua mọi invocation): #out@engage == #in@engage; Σ engage NFT
// bảo toàn; value (ngoài engage NFT) bảo toàn; Σ consumed_count(out) == Σ(in)+Σ op_count.

use aiken/builtin
use aiken/collection/list
use aiken/interval
use cardano/assets.{AssetName, PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, ScriptPurpose, Spend, Transaction,
  placeholder,
}
use magiclamp/consume/pricing
use magiclamp/consume/types.{Consume, ConsumeRedeemer, EngageDatum, OpPrice, PriceParam}
use magiclamp/consume/util

validator consume(
  price_nft_policy  : PolicyId,
  price_nft_name    : AssetName,
  engage_nft_policy : PolicyId,
  engage_nft_name   : AssetName,
  vault_script_hash : ByteArray,
  burn_batch_constr : Int,
  max_price_stale   : Int,
  ms_per_epoch      : Int,
) {
  spend(
    datum_opt : Option<EngageDatum>,
    redeemer  : ConsumeRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(in_datum) = datum_opt
    // vault_ref của invocation này được dùng qua distinct_vault_refs (aggregate);
    // không cần tham chiếu trực tiếp ở đây.
    let Consume { op_type, op_count, price_ref, vault_ref: _ } = redeemer
    expect op_count >= 1

    let own_addr = util.own_address(own_ref, tx.inputs)
    let own_hash = util.own_script_hash(own_addr)
    let current_epoch = util.get_epoch(tx, ms_per_epoch)

    // ── giá có thẩm quyền: PriceParam beacon (reference input, NFT-auth) ────────
    let pp =
      read_price_param(tx.reference_inputs, price_ref, price_nft_policy, price_nft_name)
    expect pricing.valid_param(pp)

    // ── stale price: 0 ≤ current_epoch − pp.epoch ≤ max_price_stale ─────────────
    expect current_epoch >= pp.epoch
    expect current_epoch - pp.epoch <= max_price_stale

    // ── required (invocation hiện tại) = price(op_type) × op_count ──────────────
    //    Chỉ để ép op_type CÓ trong beacon + required > 0 cho input đang spend; KHÔNG
    //    dùng làm mục tiêu khớp burn (xem AGGREGATE bên dưới — chống under-charge khi
    //    nhiều Engage co-spend chung 1 vault).
    expect Some(required) = pricing.required_for(pp, op_type, op_count)
    expect required > 0

    // ── LIÊN KẾT VAULT (AGGREGATE — C-CM-2, chống multi-engage→single-vault):
    //    total_required = Σ trên MỌI Engage input [ price(op_type_i)×op_count_i ],
    //    total_burned   = Σ burns trên MỌI vault_ref PHÂN BIỆT do các Engage input trỏ.
    //    ép total_burned == total_required. Per-invocation == aggregate → idempotent
    //    qua mọi invocation; không Engage nào "mượn" burn của Engage khác.
    //    Mọi Engage input PHẢI cùng price_ref (cùng beacon) — không trộn nhiều bảng giá.
    let total_required =
      sum_required_over_engage_inputs(tx, own_hash, pp, price_ref)
    let vault_refs = distinct_vault_refs_over_engage_inputs(tx, own_hash)
    let total_burned =
      sum_burns_over_vault_refs(tx, vault_refs, vault_script_hash, burn_batch_constr)
    expect total_burned == total_required

    // ── ENGAGE state: aggregate invariants (double-satisfaction-safe) ───────────
    // (1) #out@engage == #in@engage (no collapse).
    let n_in = util.count_inputs_at_script(tx.inputs, own_hash)
    let n_out = util.count_outputs_at_script(tx.outputs, own_hash)
    expect n_in == n_out

    // (2) Σ engage NFT bảo toàn (không rút thread token).
    let nft_in =
      sum_engage_nft_inputs(tx.inputs, own_hash, engage_nft_policy, engage_nft_name)
    let nft_out =
      sum_engage_nft_outputs(tx.outputs, own_hash, engage_nft_policy, engage_nft_name)
    expect nft_in == nft_out

    // (3) VALUE PRESERVATION @engage: mọi asset bảo toàn tuyệt đối giữa input@engage
    //     và output@engage (engage UTxO chỉ giữ ADA + thread NFT, KHÔNG MAGIC/LAMP).
    //     Chống drain ADA/token khỏi engage UTxO (bài học M1 Treasury).
    expect engage_value_preserved(tx, own_hash)

    // (4) Mỗi output@engage: owner giữ, last_epoch=current, did_commit immutable,
    //     đúng 1 thread NFT. Σ consumed_count(out) == Σ(in) + Σ op_count (mọi consume
    //     được ghi, không bỏ sót).
    enforce_engagement(
      tx, own_hash, in_datum.owner, in_datum.did_commit, current_epoch,
      engage_nft_policy, engage_nft_name,
    )
  }

  else(_) {
    fail
  }
}

// ── PriceParam beacon tại price_ref (reference input), mang NFT one-shot. ───────
fn read_price_param(
  ref_inputs       : List<Input>,
  price_ref        : OutputReference,
  price_nft_policy : PolicyId,
  price_nft_name   : AssetName,
) -> PriceParam {
  expect Some(beacon) =
    list.find(ref_inputs, fn(i) { i.output_reference == price_ref })
  expect assets.quantity_of(beacon.output.value, price_nft_policy, price_nft_name) == 1
  expect InlineDatum(d) = beacon.output.datum
  expect pp: PriceParam = d
  pp
}

/// Đọc `burns` từ redeemer BurnBatch của vault input vault_ref (purpose Spend).
/// BurnBatch { burns: List<(ByteArray, Natural)> } đồng nhất 6 module; constr index
/// khác nhau → param `burn_batch_constr`. Dùng builtin.un_constr_data để KHÔNG phải
/// import VaultRedeemer của từng module (tránh coupling type cross-module).
fn read_vault_burns(
  tx                : Transaction,
  vault_ref         : OutputReference,
  burn_batch_constr : Int,
) -> List<(ByteArray, Int)> {
  expect Some(Pair(_, rd_data)) =
    list.find(tx.redeemers, fn(p) {
      let Pair(purpose, _) = p
      purpose == Spend(vault_ref)
    })
  // rd_data = Constr(idx, fields). BurnBatch có đúng 1 field = burns.
  let Pair(idx, fields) = builtin.un_constr_data(rd_data)
  expect idx == burn_batch_constr
  expect [burns_data, ..] = fields
  expect burns: List<(ByteArray, Int)> = burns_data
  burns
}

/// Σ amount trong burns = Σ (batch_id, amount).2nd.
fn sum_burns(burns: List<(ByteArray, Int)>) -> Int {
  list.foldl(burns, 0, fn(b, acc) { acc + b.2nd })
}

/// AGGREGATE C-CM-2 (chống multi-engage→single-vault under-charge):
/// Σ required trên MỌI Engage input. Mỗi input đọc redeemer Consume RIÊNG, tính
/// price(op_type_i)×op_count_i theo CÙNG beacon pp. ÉP mọi input cùng `price_ref`
/// (cùng bảng giá) → không trộn nhiều beacon. op_type phải có trong bảng + op_count≥1.
fn sum_required_over_engage_inputs(
  tx        : Transaction,
  own_hash  : ByteArray,
  pp        : PriceParam,
  price_ref : OutputReference,
) -> Int {
  list.foldl(
    tx.inputs,
    0,
    fn(inp, acc) {
      if util.is_at_script(inp.output.address, own_hash) {
        let Consume { op_type, op_count, price_ref: pr_i, .. } =
          find_consume_redeemer(tx, inp.output_reference)
        expect op_count >= 1
        expect pr_i == price_ref
        expect Some(req_i) = pricing.required_for(pp, op_type, op_count)
        acc + req_i
      } else {
        acc
      }
    },
  )
}

/// Tập vault_ref PHÂN BIỆT do các Engage input trỏ tới (mỗi vault chỉ đếm burns 1 lần
/// dù N Engage input chia chung). Giữ thứ tự xuất hiện; loại trùng.
fn distinct_vault_refs_over_engage_inputs(
  tx       : Transaction,
  own_hash : ByteArray,
) -> List<OutputReference> {
  list.foldl(
    tx.inputs,
    [],
    fn(inp, acc) {
      if util.is_at_script(inp.output.address, own_hash) {
        let Consume { vault_ref, .. } =
          find_consume_redeemer(tx, inp.output_reference)
        if list.has(acc, vault_ref) {
          acc
        } else {
          list.push(acc, vault_ref)
        }
      } else {
        acc
      }
    },
  )
}

/// Σ burns trên các vault_ref PHÂN BIỆT. Mỗi vault: input ở vault_script_hash + redeemer
/// BurnBatch (constr == burn_batch_constr) → đọc burns, cộng. Đếm 1 lần / vault (đã dedup).
fn sum_burns_over_vault_refs(
  tx                : Transaction,
  vault_refs        : List<OutputReference>,
  vault_script_hash : ByteArray,
  burn_batch_constr : Int,
) -> Int {
  list.foldl(
    vault_refs,
    0,
    fn(vref, acc) {
      expect Some(vault_in) =
        list.find(tx.inputs, fn(i) { i.output_reference == vref })
      expect util.is_at_script(vault_in.output.address, vault_script_hash)
      let burns = read_vault_burns(tx, vref, burn_batch_constr)
      acc + sum_burns(burns)
    },
  )
}

/// Σ quantity engage NFT trên các INPUT tại engage script.
fn sum_engage_nft_inputs(
  inputs            : List<Input>,
  own_hash          : ByteArray,
  engage_nft_policy : PolicyId,
  engage_nft_name   : AssetName,
) -> Int {
  list.foldl(
    inputs,
    0,
    fn(inp, acc) {
      if util.is_at_script(inp.output.address, own_hash) {
        acc + assets.quantity_of(inp.output.value, engage_nft_policy, engage_nft_name)
      } else {
        acc
      }
    },
  )
}

/// Σ quantity engage NFT trên các OUTPUT tại engage script.
fn sum_engage_nft_outputs(
  outputs           : List<Output>,
  own_hash          : ByteArray,
  engage_nft_policy : PolicyId,
  engage_nft_name   : AssetName,
) -> Int {
  list.foldl(
    outputs,
    0,
    fn(o, acc) {
      if util.is_at_script(o.address, own_hash) {
        acc + assets.quantity_of(o.value, engage_nft_policy, engage_nft_name)
      } else {
        acc
      }
    },
  )
}

/// Tổng (merge) value mọi INPUT tại engage script.
fn sum_value_inputs(inputs: List<Input>, own_hash: ByteArray) -> Value {
  list.foldl(
    inputs,
    assets.zero,
    fn(inp, acc) {
      if util.is_at_script(inp.output.address, own_hash) {
        assets.merge(acc, inp.output.value)
      } else {
        acc
      }
    },
  )
}

/// Tổng (merge) value mọi OUTPUT tại engage script.
fn sum_value_outputs(outputs: List<Output>, own_hash: ByteArray) -> Value {
  list.foldl(
    outputs,
    assets.zero,
    fn(o, acc) {
      if util.is_at_script(o.address, own_hash) {
        assets.merge(acc, o.value)
      } else {
        acc
      }
    },
  )
}

/// Engage UTxO KHÔNG giữ MAGIC/LAMP (chỉ ADA + thread NFT) → value bảo toàn TUYỆT ĐỐI:
/// Σ value(in@engage) == Σ value(out@engage). diff = Σin − Σout phải zero hoàn toàn.
fn engage_value_preserved(tx: Transaction, own_hash: ByteArray) -> Bool {
  let v_in = sum_value_inputs(tx.inputs, own_hash)
  let v_out = sum_value_outputs(tx.outputs, own_hash)
  let diff = assets.merge(v_in, assets.negate(v_out))
  assets.is_zero(diff)
}

/// Σ op_count trên MỌI Engage input (đọc redeemer Consume Spend tương ứng). Dùng để
/// ép tổng tăng state bằng tổng nghiệp vụ — không bỏ sót input nào.
fn sum_op_count_over_engage_inputs(tx: Transaction, own_hash: ByteArray) -> Int {
  list.foldl(
    tx.inputs,
    0,
    fn(inp, acc) {
      if util.is_at_script(inp.output.address, own_hash) {
        let rd = find_consume_redeemer(tx, inp.output_reference)
        let Consume { op_count, .. } = rd
        expect op_count >= 1
        acc + op_count
      } else {
        acc
      }
    },
  )
}

/// Redeemer Consume gắn với 1 Engage input (purpose Spend ref).
fn find_consume_redeemer(tx: Transaction, ref: OutputReference) -> ConsumeRedeemer {
  expect Some(Pair(_, rd_data)) =
    list.find(tx.redeemers, fn(p) {
      let Pair(purpose, _) = p
      purpose == Spend(ref)
    })
  expect rd: ConsumeRedeemer = rd_data
  rd
}

/// Σ consumed_count trên các INPUT tại engage script (state cũ gộp).
fn sum_consumed_inputs(inputs: List<Input>, own_hash: ByteArray) -> Int {
  list.foldl(
    inputs,
    0,
    fn(inp, acc) {
      if util.is_at_script(inp.output.address, own_hash) {
        expect InlineDatum(d) = inp.output.datum
        expect ed: EngageDatum = d
        acc + ed.consumed_count
      } else {
        acc
      }
    },
  )
}

/// Σ consumed_count trên các OUTPUT tại engage script (state mới gộp).
fn sum_consumed_outputs(outputs: List<Output>, own_hash: ByteArray) -> Int {
  list.foldl(
    outputs,
    0,
    fn(o, acc) {
      if util.is_at_script(o.address, own_hash) {
        expect InlineDatum(d) = o.datum
        expect ed: EngageDatum = d
        acc + ed.consumed_count
      } else {
        acc
      }
    },
  )
}

/// Mọi output@engage: owner giữ, last_epoch=current, did_commit immutable, đúng 1 NFT.
/// Σ consumed_count(out) == Σ(in) + Σ op_count → mọi consume được ghi state.
fn enforce_engagement(
  tx                : Transaction,
  own_hash          : ByteArray,
  owner             : ByteArray,
  did_commit        : ByteArray,
  current_epoch     : Int,
  engage_nft_policy : PolicyId,
  engage_nft_name   : AssetName,
) -> Bool {
  expect
    list.all(
      tx.outputs,
      fn(o) {
        if util.is_at_script(o.address, own_hash) {
          expect InlineDatum(d) = o.datum
          expect od: EngageDatum = d
          and {
            od.owner == owner,
            od.last_epoch == current_epoch,
            od.did_commit == did_commit,
            assets.quantity_of(o.value, engage_nft_policy, engage_nft_name) == 1,
          }
        } else {
          True
        }
      },
    )
  let consumed_in = sum_consumed_inputs(tx.inputs, own_hash)
  let consumed_out = sum_consumed_outputs(tx.outputs, own_hash)
  let total_op = sum_op_count_over_engage_inputs(tx, own_hash)
  consumed_out == consumed_in + total_op
}

// ══════════════════════════════════════════════════════════════
// Validator tests (mock Transaction)
//   happy + negatives: under/over-burn (==), no thread token, double-satisfaction,
//   output-collapse, thread-token drain, state under-count, stale price, price from
//   redeemer (op không có trong beacon), fake beacon NFT, drain ADA, drain token,
//   negative base_price, did_commit mutated, wrong vault constr.
// ══════════════════════════════════════════════════════════════

const ct_eng_sh: ByteArray = #"cccc"
const ct_vault_sh: ByteArray = #"dddd"
const ct_price_policy: PolicyId = #"9999"
const ct_price_name: AssetName = #"5052494345"      // "PRICE"
const ct_engage_policy: PolicyId = #"7777"
const ct_engage_name: AssetName = #"454e47"          // "ENG"
const ct_owner: ByteArray = #"0bada55e"
const ct_did: ByteArray = #""                        // MVP did_commit rỗng
const ct_max_stale: Int = 5
const ct_mspe: Int = 86_400_000                      // Preview
const ct_burn_constr: Int = 2                        // InstantGen BurnBatch constr
const ct_price_ref_ix: Int = 9

fn ct_price_ref() -> OutputReference {
  util.mk_ref_id(#"bb", ct_price_ref_ix)
}

fn ct_pp(epoch: Int) -> PriceParam {
  PriceParam {
    op_prices: [
      OpPrice { op_type: 1, base_price: 10_000_000 },  // ảnh 0.01 MAGIC
      OpPrice { op_type: 2, base_price: 1_000_000 },    // CID 0.001 MAGIC
    ],
    demand_mult: 1_000_000_000,   // 1.0× → price ảnh = 10_000_000
    m_min: 500_000_000,
    m_max: 2_000_000_000,
    epoch: epoch,
  }
}

/// Beacon reference input mang PriceParam + NFT (qty nft cho phép sai để test).
fn ct_beacon_ref(pp: PriceParam, nft_qty: Int) -> Input {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_price_policy, ct_price_name, nft_qty)
  util.mk_input(ct_price_ref(), util.mk_output(util.script_address(#"feed"), v, pp))
}

/// Engage input tại ct_eng_sh mang EngageDatum + thread NFT.
fn ct_engage_input(ref_ix: Int, consumed: Int) -> Input {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_engage_policy, ct_engage_name, 1)
  let d = EngageDatum { owner: ct_owner, consumed_count: consumed, last_epoch: 0, did_commit: ct_did }
  util.mk_input(util.mk_ref_id(#"e1", ref_ix), util.mk_output(util.script_address(ct_eng_sh), v, d))
}

/// Continuing engage output: thread NFT + EngageDatum tăng.
fn ct_cont_output(new_consumed: Int, new_epoch: Int, nft_qty: Int) -> Output {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_engage_policy, ct_engage_name, nft_qty)
  let d = EngageDatum { owner: ct_owner, consumed_count: new_consumed, last_epoch: new_epoch, did_commit: ct_did }
  util.mk_output(util.script_address(ct_eng_sh), v, d)
}

/// Continuing engage output với did_commit tuỳ biến (test immutable).
fn ct_cont_output_did(new_consumed: Int, new_epoch: Int, did: ByteArray) -> Output {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_engage_policy, ct_engage_name, 1)
  let d = EngageDatum { owner: ct_owner, consumed_count: new_consumed, last_epoch: new_epoch, did_commit: did }
  util.mk_output(util.script_address(ct_eng_sh), v, d)
}

/// Vault input tại ct_vault_sh (output value/datum không cần khớp VaultDatum — chỉ cần
/// địa chỉ ở vault_script_hash; redeemer BurnBatch là cái validator này đọc).
fn ct_vault_input(ref_ix: Int) -> Input {
  let v = assets.from_lovelace(2_000_000)
  util.mk_input(util.mk_ref_id(#"a1", ref_ix), util.mk_output(util.script_address(ct_vault_sh), v, 0))
}

fn ct_consume_redeemer(op_type: Int, op_count: Int, vault_ref: OutputReference) -> ConsumeRedeemer {
  Consume { op_type, op_count, price_ref: ct_price_ref(), vault_ref }
}

/// BurnBatch redeemer data: Constr(constr, [burns]) với burns = list (id, amount).
fn ct_burn_redeemer(constr: Int, burns: List<(ByteArray, Int)>) -> Data {
  builtin.constr_data(constr, [burns_to_data(burns)])
}

/// Mã hoá List<(ByteArray, Int)> thành Data (Aiken tự coerce qua un_data ở read).
fn burns_to_data(burns: List<(ByteArray, Int)>) -> Data {
  let d: Data = burns
  d
}

/// Run validator: 1 Engage input + 1 vault input + beacon ref. Tham số hoá đủ để bẻ
/// từng invariant.
fn run(
  pp_for_ref    : PriceParam,
  nft_qty       : Int,
  cur_epoch     : Int,
  engage_inputs : List<Input>,
  vault_inputs  : List<Input>,
  outputs       : List<Output>,
  redeemers     : Pairs<ScriptPurpose, Data>,
  rd            : ConsumeRedeemer,
  own_ref       : OutputReference,
  in_datum      : EngageDatum,
) -> Bool {
  let tx =
    Transaction {
      ..placeholder,
      inputs: list.concat(engage_inputs, vault_inputs),
      reference_inputs: [ct_beacon_ref(pp_for_ref, nft_qty)],
      outputs: outputs,
      redeemers: redeemers,
      // Cửa sổ HẸP đúng 1 epoch quanh cur_epoch: lower tại đầu epoch, upper +1ms
      // (vẫn cùng epoch sau floor) → epoch tham chiếu (từ upper) == cur_epoch.
      // Chứng minh validator ăn cửa sổ chặt hợp lệ sau khi vá validity-range.
      validity_range: interval.between(
        cur_epoch * ct_mspe,
        cur_epoch * ct_mspe + 1,
      ),
    }
  consume.spend(
    ct_price_policy, ct_price_name, ct_engage_policy, ct_engage_name,
    ct_vault_sh, ct_burn_constr, ct_max_stale, ct_mspe,
    Some(in_datum), rd, own_ref, tx,
  )
}

const ct_in_datum: EngageDatum =
  EngageDatum { owner: ct_owner, consumed_count: 10, last_epoch: 0, did_commit: ct_did }

// ── HAPPY: 1 ảnh × 1 = required 10M; vault BurnBatch Σburns = 10M; state +1 ──────
test consume_happy() {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

/// ConsumeRedeemer → Data (cho redeemers list).
fn rd_as_data(rd: ConsumeRedeemer) -> Data {
  let d: Data = rd
  d
}

// ── NEGATIVE: Σburns < required (under-burn) → fail (== không ≥) ─────────────────
test consume_underburn_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 9_999_999)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: Σburns > required (over-burn) → fail (mô hình accounting CẤM) ───────
test consume_overburn_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_001)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ── HAPPY: burns nhiều entry, Σ = required (3 ảnh) ──────────────────────────────
test consume_multi_burn_happy() {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 3, vault_ref)    // required = 30M
  let burn_rd =
    ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000), (#"ba02", 12_000_000), (#"ba03", 8_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output(13, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: continuing engage output thiếu thread token → fail ────────────────
test consume_no_thread_token_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output(11, 6, 0)], reds, rd, eng_ref, ct_in_datum)   // nft=0
}

// ── NEGATIVE: stale price → fail ────────────────────────────────────────────────
test consume_stale_price_fail() fail {
  let pp = ct_pp(1)          // beacon epoch 1
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 10, [eng], [vault], [ct_cont_output(11, 10, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: op_type ngoài bảng giá beacon → required_for None → fail ──────────
test consume_price_from_redeemer_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(42, 1, vault_ref)   // op_type 42 không có
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: beacon NFT qty ≠ 1 (datum hijack) → fail ──────────────────────────
test consume_fake_beacon_no_nft_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 0, 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)   // nft=0
}

// ── NEGATIVE: base_price âm trong beacon → valid_param fail → fail ──────────────
test consume_negative_base_price_fail() fail {
  let bad_pp =
    PriceParam {
      op_prices: [OpPrice { op_type: 1, base_price: 10_000_000 }, OpPrice { op_type: 2, base_price: -1 }],
      demand_mult: 1_000_000_000, m_min: 500_000_000, m_max: 2_000_000_000, epoch: 6,
    }
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(bad_pp, 1, 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: did_commit bị đổi ở output → immutable vi phạm → fail ─────────────
test consume_did_commit_mutated_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output_did(11, 6, #"deadbeef")], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: vault input redeemer constr ≠ burn_batch_constr → fail ────────────
test consume_wrong_vault_constr_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(3, [(#"ba01", 10_000_000)])   // constr 3 ≠ 2
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: vault input KHÔNG ở vault_script_hash → fail ──────────────────────
test consume_vault_not_at_script_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  // vault input ở engage script thay vì vault script
  let fake_vault =
    util.mk_input(util.mk_ref_id(#"a1", 0), util.mk_output(util.script_address(#"beef"), assets.from_lovelace(2_000_000), 0))
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [fake_vault], [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE (FIX aggregate C-CM-2): 2 Engage / 2 ops CHUNG 1 vault burn 10M → fail.
//    Đây là LỖ under-charge cũ (pay-once-consume-N): total_required = 10M+10M = 20M,
//    total_burned = 10M (1 vault) → 10M != 20M → REJECT. Trước fix test này "happy".
test consume_two_engage_share_vault_undercharge_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)   // cả 2 engage trỏ chung vault_ref
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])  // CHỈ 10M
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [e0, e1], [vault], [ct_cont_output(11, 6, 1), ct_cont_output(11, 6, 1)], reds, rd, er0, ct_in_datum)
}

// ── HAPPY 2-input ĐÚNG GIÁ: 2 Engage / 2 ops, vault burn ĐỦ tổng 20M, 2 output, Σstate +2.
//    Chứng minh batching hợp lệ vẫn chạy sau fix: total_required=20M == total_burned=20M.
test consume_two_engage_full_burn_happy() {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 20_000_000)])  // ĐỦ 2 ảnh
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  // Σconsumed: in 20, out 22 = 20 + Σop(2) → khớp; Σburns 20M == total_required 20M.
  run(pp, 1, 6, [e0, e1], [vault], [ct_cont_output(11, 6, 1), ct_cont_output(11, 6, 1)], reds, rd, er0, ct_in_datum)
}

// ── HAPPY 2-input, 2 vault PHÂN BIỆT (mỗi engage 1 vault riêng, mỗi vault burn 10M).
//    total_required=20M, total_burned = 10M+10M (2 vault_ref distinct) = 20M → pass.
test consume_two_engage_two_vault_happy() {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input(1, 10)
  let v0 = ct_vault_input(0)
  let v1 = ct_vault_input(1)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vref0 = util.mk_ref_id(#"a1", 0)
  let vref1 = util.mk_ref_id(#"a1", 1)
  let rd0 = ct_consume_redeemer(1, 1, vref0)
  let rd1 = ct_consume_redeemer(1, 1, vref1)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds =
    [
      Pair(Spend(er0), rd_as_data(rd0)), Pair(Spend(er1), rd_as_data(rd1)),
      Pair(Spend(vref0), burn_rd), Pair(Spend(vref1), burn_rd),
    ]
  run(pp, 1, 6, [e0, e1], [v0, v1], [ct_cont_output(11, 6, 1), ct_cont_output(11, 6, 1)], reds, rd0, er0, ct_in_datum)
}

// ── NEGATIVE: 2 Engage input, output-collapse (chỉ 1 output@engage) → #out!=#in ─
test consume_output_collapse_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [e0, e1], [vault], [ct_cont_output(11, 6, 1)], reds, rd, er0, ct_in_datum)   // 1 output
}

// ── NEGATIVE: 2 Engage input, thread-token drain (1 output thiếu NFT) → Σnft sai ─
test consume_thread_token_drain_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [e0, e1], [vault], [ct_cont_output(11, 6, 1), ct_cont_output(11, 6, 0)], reds, rd, er0, ct_in_datum)
}

// ── NEGATIVE: 2 Engage input, state under-count (1 output không tăng) → Σ sai ───
test consume_state_undercount_fail() fail {
  let pp = ct_pp(6)
  let e0 = ct_engage_input(0, 10)
  let e1 = ct_engage_input(1, 10)
  let vault = ct_vault_input(0)
  let er0 = util.mk_ref_id(#"e1", 0)
  let er1 = util.mk_ref_id(#"e1", 1)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds =
    [Pair(Spend(er0), rd_as_data(rd)), Pair(Spend(er1), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  // out: 11 + 10 = 21 ; in 20 + op 2 = 22 → 21 != 22 → fail
  run(pp, 1, 6, [e0, e1], [vault], [ct_cont_output(11, 6, 1), ct_cont_output(10, 6, 1)], reds, rd, er0, ct_in_datum)
}

// ── HAPPY value preserved: engage UTxO giữ 100 ADA + 5 TOK → output GIỮ NGUYÊN ──
fn ct_engage_input_v(ref_ix: Int, consumed: Int, lovelace: Int, other_qty: Int) -> Input {
  let v0 = assets.add(assets.from_lovelace(lovelace), ct_engage_policy, ct_engage_name, 1)
  let v = assets.add(v0, #"0a0a", #"544f4b", other_qty)
  let d = EngageDatum { owner: ct_owner, consumed_count: consumed, last_epoch: 0, did_commit: ct_did }
  util.mk_input(util.mk_ref_id(#"e1", ref_ix), util.mk_output(util.script_address(ct_eng_sh), v, d))
}

fn ct_cont_output_v(new_consumed: Int, new_epoch: Int, lovelace: Int, other_qty: Int) -> Output {
  let v0 = assets.add(assets.from_lovelace(lovelace), ct_engage_policy, ct_engage_name, 1)
  let v = assets.add(v0, #"0a0a", #"544f4b", other_qty)
  let d = EngageDatum { owner: ct_owner, consumed_count: new_consumed, last_epoch: new_epoch, did_commit: ct_did }
  util.mk_output(util.script_address(ct_eng_sh), v, d)
}

test consume_value_preserved_happy() {
  let pp = ct_pp(6)
  let eng = ct_engage_input_v(0, 10, 100_000_000, 5)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output_v(11, 6, 100_000_000, 5)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: drain ADA khỏi engage UTxO → value preservation fail ──────────────
test consume_drain_ada_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input_v(0, 10, 100_000_000, 0)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output_v(11, 6, 2_000_000, 0)], reds, rd, eng_ref, ct_in_datum)
}

// ── NEGATIVE: drain token khác khỏi engage UTxO → value preservation fail ───────
test consume_drain_other_token_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input_v(0, 10, 100_000_000, 5)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run(pp, 1, 6, [eng], [vault], [ct_cont_output_v(11, 6, 100_000_000, 2)], reds, rd, eng_ref, ct_in_datum)
}

// ══════════════════════════════════════════════════════════════
// VALIDITY-RANGE GAMING (vá MAINNET-BLOCK): epoch tham chiếu KHÔNG bịa được.
//   build tx với validity_range tuỳ ý (không qua run() — run() ép cửa sổ hẹp).
// ══════════════════════════════════════════════════════════════

/// run nhưng tự đặt validity_range (test thao túng cửa sổ).
fn run_vr(
  pp_for_ref : PriceParam,
  vr         : interval.Interval,
  engage_inputs : List<Input>,
  vault_inputs  : List<Input>,
  outputs    : List<Output>,
  redeemers  : Pairs<ScriptPurpose, Data>,
  rd         : ConsumeRedeemer,
  own_ref    : OutputReference,
  in_datum   : EngageDatum,
) -> Bool {
  let tx =
    Transaction {
      ..placeholder,
      inputs: list.concat(engage_inputs, vault_inputs),
      reference_inputs: [ct_beacon_ref(pp_for_ref, 1)],
      outputs: outputs,
      redeemers: redeemers,
      validity_range: vr,
    }
  consume.spend(
    ct_price_policy, ct_price_name, ct_engage_policy, ct_engage_name,
    ct_vault_sh, ct_burn_constr, ct_max_stale, ct_mspe,
    Some(in_datum), rd, own_ref, tx,
  )
}

// ── NEGATIVE: upper_bound VÔ HẠN (interval.after) → get_finite(upper) fail.
//    Trước vá: chỉ đọc lower → pass; attacker để upper hở. Sau vá: REJECT.
test consume_unbounded_upper_fail() fail {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  run_vr(
    pp, interval.after(6 * ct_mspe), [eng], [vault],
    [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum,
  )
}

// ── NEGATIVE: cửa sổ RỘNG > 1 epoch (lower quá khứ, upper hiện tại) → fail.
//    Đây CHÍNH LÀ đòn under-state: attacker đặt lower ở epoch 1 để current=lower/mspe
//    nhỏ → dùng beacon cũ. Sau vá: upper−lower > ms_per_epoch → REJECT.
test consume_wide_window_understate_fail() fail {
  let pp = ct_pp(1)          // beacon epoch CŨ (giá rẻ giả định)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  // lower epoch 1, upper epoch 10 → cửa sổ 9 epoch >> 1 → fail ràng buộc cửa sổ.
  run_vr(
    pp, interval.between(1 * ct_mspe, 10 * ct_mspe), [eng], [vault],
    [ct_cont_output(11, 1, 1)], reds, rd, eng_ref, ct_in_datum,
  )
}

// ── HAPPY: cửa sổ chặt 1 epoch, epoch tham chiếu = upper. Beacon epoch == upper-epoch.
//    Chứng minh đường đi hợp lệ vẫn chạy: upper tại epoch 6, beacon epoch 6 → stale 0.
test consume_tight_window_upper_epoch_happy() {
  let pp = ct_pp(6)
  let eng = ct_engage_input(0, 10)
  let vault = ct_vault_input(0)
  let eng_ref = util.mk_ref_id(#"e1", 0)
  let vault_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_consume_redeemer(1, 1, vault_ref)
  let burn_rd = ct_burn_redeemer(ct_burn_constr, [(#"ba01", 10_000_000)])
  let reds = [Pair(Spend(eng_ref), rd_as_data(rd)), Pair(Spend(vault_ref), burn_rd)]
  // lower cuối epoch 5, upper đầu epoch 6 → cửa sổ < 1 epoch; epoch ref = 6.
  run_vr(
    pp, interval.between(6 * ct_mspe - 1, 6 * ct_mspe), [eng], [vault],
    [ct_cont_output(11, 6, 1)], reds, rd, eng_ref, ct_in_datum,
  )
}
