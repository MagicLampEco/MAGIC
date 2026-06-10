// consume.ak — đốt MAGIC THẬT, ép bất biến C-CM-1..5 (CONTRACT.md §B2/§E).
// PlutusV3 / Aiken. Pure BigInt. CHỈ chạm policy MAGIC — LAMP+ADA bảo toàn byte.
//
// Parameterized by:
//   magic_policy   : PolicyId asset MAGIC (đọc từ config protocol generator)
//   magic_name     : AssetName MAGIC
//   price_nft_policy / price_nft_name   : authenticity NFT của PriceParam beacon
//   engage_nft_policy / engage_nft_name : thread token neo state engagement (C-CM-4)
//   max_price_stale : số epoch tối đa cho phép dùng giá (C-CM-5)
//   ms_per_epoch    : POSIX ms / epoch (network-specific)
//
// MÔ HÌNH double-satisfaction (C-CM-3): mỗi vault input chạy 1 lần validator này.
// MỘT lần mint âm MAGIC trong tx phải phủ TỔNG required của MỌI vault input. Mỗi
// invocation tự tính total_required (quét toàn bộ vault input + redeemer tương
// ứng) rồi so với 1 con số magic_burned toàn cục → không "1 mint thoả nhiều input".

use aiken/collection/list
use aiken/interval
use cardano/assets.{AssetName, PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, ScriptPurpose, Spend,
  Transaction, placeholder,
}
use magiclamp/consume/pricing
use magiclamp/consume/types.{
  Consume, ConsumeRedeemer, EngageDatum, OpPrice, PriceParam,
}
use magiclamp/consume/util

validator consume(
  magic_policy      : PolicyId,
  magic_name        : AssetName,
  price_nft_policy  : PolicyId,
  price_nft_name    : AssetName,
  engage_nft_policy : PolicyId,
  engage_nft_name   : AssetName,
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
    let Consume { op_count, .. } = redeemer
    expect op_count >= 1

    let own_addr = util.own_address(own_ref, tx.inputs)
    let own_hash = util.own_script_hash(own_addr)
    let current_epoch = util.get_epoch(tx, ms_per_epoch)

    // ── C-CM-2 phần 1: đọc PriceParam qua reference input price_ref, xác thực NFT.
    let Consume { price_ref, .. } = redeemer
    let pp = read_price_param(tx.reference_inputs, price_ref, price_nft_policy, price_nft_name)
    expect pricing.valid_param(pp)

    // ── C-CM-5: stale price. 0 ≤ current_epoch − pp.epoch ≤ max_price_stale.
    expect current_epoch >= pp.epoch
    expect current_epoch - pp.epoch <= max_price_stale

    // ── C-CM-1: tx.mint CHỈ chứa policy MAGIC, qty ÂM. ADA+LAMP+asset khác KHÔNG
    // xuất hiện trong tx.mint → ledger bảo toàn tuyệt đối Σin=Σout cho mọi asset
    // ngoài MAGIC. magic_burned = −mint(MAGIC) > 0.
    let magic_burned = check_only_magic_burn(tx.mint, magic_policy, magic_name)
    expect magic_burned > 0

    // ── C-CM-3: TỔNG required của MỌI vault input (theo script hash) vs 1 burn.
    // Giá LẤY TỪ BEACON (pp), KHÔNG từ redeemer amount.
    let total_required = sum_required_over_vault_inputs(tx, own_hash, pp)
    // ── C-CM-2: magic_burned ≥ required (gộp).
    expect magic_burned >= total_required

    // ── C-CM-3 phần 2 (đóng double-satisfaction trên CONTINUING OUTPUT/STATE):
    // Validator chạy 1 lần / vault input. Với N vault input CÙNG owner mang CÙNG
    // engage NFT name (parameterized 1 name), list.find cũ trả về cùng 1 output cho
    // mọi invocation → N-1 thread token có thể bị rút + N-1 state không được ghi.
    // Ba bất biến AGGREGATE sau idempotent qua mọi invocation, đóng kín lỗ hổng:
    //   (1) #out@script == #in@script  → không dồn N input về 1 output (no collapse).
    //   (2) Σ engageNFT(out@script) == Σ engageNFT(in@script) → không RÚT thread token.
    //   (3) mọi out@script: đúng 1 engage NFT + owner bảo toàn + last_epoch=current;
    //       Σ consumed_count(out) == Σ consumed_count(in) + Σ op_count(mọi vault input)
    //       → mọi consume ĐỀU được ghi state, không bỏ sót input nào.
    let n_in = util.count_inputs_at_script(tx.inputs, own_hash)
    let n_out = util.count_outputs_at_script(tx.outputs, own_hash)
    expect n_in == n_out
    let nft_in =
      sum_engage_nft_inputs(tx.inputs, own_hash, engage_nft_policy, engage_nft_name)
    let nft_out =
      sum_engage_nft_outputs(tx.outputs, own_hash, engage_nft_policy, engage_nft_name)
    expect nft_in == nft_out

    // ── C-CM-1 (VALUE PRESERVATION @script — bài học M1 Treasury): NFT bảo toàn
    // đếm token, NHƯNG không chặn được drain ADA / token KHÁC khỏi vault input.
    // Ledger chỉ bảo toàn Σin=Σout TOÀN tx; ADA của vault có thể chảy ra ví attacker
    // miễn tổng tx cân. Ép RIÊNG: tổng value các OUTPUT@script == tổng value các
    // INPUT@script cho MỌI asset ngoại trừ MAGIC (đối tượng thao tác duy nhất). ADA
    // + LAMP + mọi token khác bảo toàn byte-perfect. MAGIC (nếu nằm trong vault)
    // được ràng buộc bởi mint check + required check, không lặp ở đây.
    expect non_magic_value_preserved(tx, own_hash, magic_policy, magic_name)

    // ── C-CM-4: continuing output vault mang thread token, state tăng đúng TỔNG,
    // owner bảo toàn, last_epoch refresh. Aggregate (không per-input list.find).
    enforce_engagement(
      tx, own_hash, in_datum.owner, current_epoch,
      engage_nft_policy, engage_nft_name,
    )
  }

  else(_) {
    fail
  }
}

// ── C-CM-1: tx.mint chỉ gồm đúng 1 entry (magic_policy, magic_name, q<0).
// Trả về magic_burned = −q (>0). Mọi entry khác policy/name → fail.
fn check_only_magic_burn(mint: Value, magic_policy: PolicyId, magic_name: AssetName) -> Int {
  expect [(p, n, q)] = assets.flatten(mint)
  expect p == magic_policy
  expect n == magic_name
  expect q < 0
  -q
}

// ── C-CM-2 read: PriceParam beacon tại price_ref (reference input), mang NFT.
fn read_price_param(
  ref_inputs       : List<Input>,
  price_ref        : OutputReference,
  price_nft_policy : PolicyId,
  price_nft_name   : AssetName,
) -> PriceParam {
  expect Some(beacon) = list.find(ref_inputs, fn(i) { i.output_reference == price_ref })
  expect assets.quantity_of(beacon.output.value, price_nft_policy, price_nft_name) == 1
  expect InlineDatum(d) = beacon.output.datum
  expect pp: PriceParam = d
  pp
}

// ── C-CM-3: Σ over vault inputs của price(op_type)×op_count. Đọc redeemer Consume
// của TỪNG vault input từ tx.redeemers (purpose Spend).
fn sum_required_over_vault_inputs(tx: Transaction, own_hash: ByteArray, pp: PriceParam) -> Int {
  list.foldl(
    tx.inputs,
    0,
    fn(inp, acc) {
      if util.is_at_script(inp.output.address, own_hash) {
        let rd = find_spend_redeemer(tx, inp.output_reference)
        let Consume { op_type, op_count, .. } = rd
        expect op_count >= 1
        expect Some(req) = pricing.required_for(pp, op_type, op_count)
        acc + req
      } else {
        acc
      }
    },
  )
}

/// Redeemer Consume gắn với 1 vault input (purpose Spend ref).
fn find_spend_redeemer(tx: Transaction, ref: OutputReference) -> ConsumeRedeemer {
  expect Some(Pair(_, rd_data)) =
    list.find(tx.redeemers, fn(p) {
      let Pair(purpose, _) = p
      purpose == Spend(ref)
    })
  expect rd: ConsumeRedeemer = rd_data
  rd
}

/// Σ quantity engage NFT trên các INPUT tại script (thread token bảo toàn).
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

/// Σ quantity engage NFT trên các OUTPUT tại script.
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

/// Tổng (merge) value mọi INPUT tại script.
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

/// Tổng (merge) value mọi OUTPUT tại script.
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

/// C-CM-1 value preservation: mọi asset ≠ MAGIC bảo toàn tuyệt đối giữa input@script
/// và output@script. diff = Σin − Σout; zero hoá thành phần MAGIC; phần còn lại phải
/// rỗng → không drain ADA/LAMP/token nào. MAGIC để mint/required check lo riêng.
fn non_magic_value_preserved(
  tx          : Transaction,
  own_hash    : ByteArray,
  magic_policy: PolicyId,
  magic_name  : AssetName,
) -> Bool {
  let v_in = sum_value_inputs(tx.inputs, own_hash)
  let v_out = sum_value_outputs(tx.outputs, own_hash)
  let diff = assets.merge(v_in, assets.negate(v_out))
  // bỏ thành phần MAGIC khỏi diff (đặt về 0), phần còn lại phải = 0 tuyệt đối.
  let magic_diff = assets.quantity_of(diff, magic_policy, magic_name)
  let diff_no_magic = assets.add(diff, magic_policy, magic_name, -magic_diff)
  assets.is_zero(diff_no_magic)
}

/// Σ op_count trên MỌI vault input (theo redeemer Spend tương ứng). Dùng để ép
/// tổng tăng state bằng tổng nghiệp vụ thực — không bỏ sót input nào (C-CM-4).
fn sum_op_count_over_vault_inputs(tx: Transaction, own_hash: ByteArray) -> Int {
  list.foldl(
    tx.inputs,
    0,
    fn(inp, acc) {
      if util.is_at_script(inp.output.address, own_hash) {
        let rd = find_spend_redeemer(tx, inp.output_reference)
        let Consume { op_count, .. } = rd
        expect op_count >= 1
        acc + op_count
      } else {
        acc
      }
    },
  )
}

/// Σ consumed_count trên các INPUT tại script (state cũ gộp).
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

// ── C-CM-4 (AGGREGATE): mọi continuing output@script mang ĐÚNG 1 thread token,
// owner bảo toàn, last_epoch = current_epoch; và Σ consumed_count(out) ==
// Σ consumed_count(in) + Σ op_count. Kết hợp với (1)(2) ở thân spend (#out==#in,
// Σnft bảo toàn) → bijection input↔output, mọi consume đều ghi state, không rút
// thread token, không collapse output. Idempotent qua mọi invocation.
fn enforce_engagement(
  tx                : Transaction,
  own_hash          : ByteArray,
  owner             : ByteArray,
  current_epoch     : Int,
  engage_nft_policy : PolicyId,
  engage_nft_name   : AssetName,
) -> Bool {
  // (3a) Từng output@script: đúng 1 engage NFT + owner giữ + last_epoch refresh.
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
            assets.quantity_of(o.value, engage_nft_policy, engage_nft_name) == 1,
          }
        } else {
          True
        }
      },
    )
  // (3b) Σ state tăng đúng đúng tổng nghiệp vụ — không bỏ sót consume nào.
  let consumed_in = sum_consumed_inputs(tx.inputs, own_hash)
  let consumed_out = sum_consumed_outputs(tx.outputs, own_hash)
  let total_op = sum_op_count_over_vault_inputs(tx, own_hash)
  consumed_out == consumed_in + total_op
}

/// Σ consumed_count trên các OUTPUT tại script (state mới gộp).
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

// ══════════════════════════════════════════════════════════════
// Validator tests (mock Transaction) — happy + 6 negatives C-CM-1..5
// ══════════════════════════════════════════════════════════════

const ct_sh: ByteArray = #"cccc"
const ct_magic_policy: PolicyId = #"3333"
const ct_magic_name: AssetName = #"4d4147"          // "MAG"
const ct_price_policy: PolicyId = #"9999"
const ct_price_name: AssetName = #"5052494345"      // "PRICE"
const ct_engage_policy: PolicyId = #"7777"
const ct_engage_name: AssetName = #"454e47"          // "ENG"
const ct_owner: ByteArray = #"0bada55e"
const ct_max_stale: Int = 5
const ct_mspe: Int = 86_400_000                      // Preview
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

/// Vault input tại ct_sh mang EngageDatum + engage NFT.
fn ct_vault_input(ref_ix: Int, consumed: Int) -> Input {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_engage_policy, ct_engage_name, 1)
  let d = EngageDatum { owner: ct_owner, consumed_count: consumed, last_epoch: 0 }
  util.mk_input(util.mk_ref_id(#"a1", ref_ix), util.mk_output(util.script_address(ct_sh), v, d))
}

/// Continuing output: engage NFT + EngageDatum tăng.
fn ct_cont_output(new_consumed: Int, new_epoch: Int, nft_qty: Int) -> Output {
  let v = assets.add(assets.from_lovelace(2_000_000), ct_engage_policy, ct_engage_name, nft_qty)
  let d = EngageDatum { owner: ct_owner, consumed_count: new_consumed, last_epoch: new_epoch }
  util.mk_output(util.script_address(ct_sh), v, d)
}

fn ct_redeemer(op_type: Int, op_count: Int) -> ConsumeRedeemer {
  Consume { op_type, op_count, price_ref: ct_price_ref() }
}

/// 1 cặp redeemer. Param `rd: Data` → ConsumeRedeemer coerce ở biên argument.
fn red1(ref: OutputReference, rd: Data) -> Pairs<ScriptPurpose, Data> {
  [Pair(Spend(ref), rd)]
}

/// 2 cặp redeemer (cho test double-satisfaction).
fn red2(r0: OutputReference, rd0: Data, r1: OutputReference, rd1: Data) -> Pairs<ScriptPurpose, Data> {
  [Pair(Spend(r0), rd0), Pair(Spend(r1), rd1)]
}

/// mint value: âm MAGIC `burned` (+ tuỳ chọn entry rác để test C-CM-1).
fn ct_mint(burned: Int) -> Value {
  assets.from_asset(ct_magic_policy, ct_magic_name, -burned)
}

/// Run validator với 1 tx đã dựng (tham số hoá đủ thứ để bẻ từng invariant).
fn run(
  pp_for_ref   : PriceParam,
  nft_qty      : Int,
  cur_epoch    : Int,
  mint         : Value,
  vault_inputs : List<Input>,
  outputs      : List<Output>,
  redeemers    : Pairs<ScriptPurpose, Data>,
  rd           : ConsumeRedeemer,
  own_ref      : OutputReference,
) -> Bool {
  let tx =
    Transaction {
      ..placeholder,
      inputs: vault_inputs,
      reference_inputs: [ct_beacon_ref(pp_for_ref, nft_qty)],
      outputs: outputs,
      mint: mint,
      redeemers: redeemers,
      validity_range: interval.after(cur_epoch * ct_mspe),
    }
  consume.spend(
    ct_magic_policy, ct_magic_name, ct_price_policy, ct_price_name,
    ct_engage_policy, ct_engage_name, ct_max_stale, ct_mspe,
    Some(EngageDatum { owner: ct_owner, consumed_count: 10, last_epoch: 0 }),
    rd, own_ref, tx,
  )
}

// ── HAPPY: đốt MAGIC = required (1 ảnh × 1 = 10_000_000), state tăng đúng ──────
test consume_happy() {
  let pp = ct_pp(6)
  let vin = ct_vault_input(0, 10)
  let own_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_redeemer(1, 1)
  run(
    pp, 1, 6, ct_mint(10_000_000), [vin],
    [ct_cont_output(11, 6, 1)], red1(own_ref, rd), rd, own_ref,
  )
}

// ── NEGATIVE 1 (C-CM-2): đốt < required → fail ───────────────────────────────
test consume_underburn_fail() fail {
  let pp = ct_pp(6)
  let vin = ct_vault_input(0, 10)
  let own_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_redeemer(1, 1)
  run(
    pp, 1, 6, ct_mint(9_999_999), [vin],
    [ct_cont_output(11, 6, 1)], red1(own_ref, rd), rd, own_ref,
  )
}

// ── NEGATIVE 2 (C-CM-1): drain ADA = thêm entry mint ngoài MAGIC → fail ───────
// tx.mint chứa thêm 1 native asset lạ (mô phỏng cố nặn value) → check_only_magic_burn fail.
test consume_extra_mint_entry_fail() fail {
  let pp = ct_pp(6)
  let vin = ct_vault_input(0, 10)
  let own_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_redeemer(1, 1)
  let bad_mint =
    assets.from_asset(ct_magic_policy, ct_magic_name, -10_000_000)
      |> assets.add(#"4c414d50", #"4c414d50", -1)   // đụng LAMP/asset khác trong mint
  run(
    pp, 1, 6, bad_mint, [vin],
    [ct_cont_output(11, 6, 1)], red1(own_ref, rd), rd, own_ref,
  )
}

// ── NEGATIVE 3 (C-CM-4): continuing output thiếu thread token → fail (replay) ──
// engage NFT không có ở output → find_continuing không thấy → fail.
test consume_no_thread_token_fail() fail {
  let pp = ct_pp(6)
  let vin = ct_vault_input(0, 10)
  let own_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_redeemer(1, 1)
  run(
    pp, 1, 6, ct_mint(10_000_000), [vin],
    [ct_cont_output(11, 6, 0)], red1(own_ref, rd), rd, own_ref,   // nft_qty = 0
  )
}

// ── NEGATIVE 4 (C-CM-3): double-satisfaction — 2 vault input, 1 mint chỉ phủ 1 ─
// 2 input mỗi cái cần 10_000_000 → total_required = 20_000_000; burn chỉ 10_000_000 → fail.
test consume_double_satisfaction_fail() fail {
  let pp = ct_pp(6)
  let v0 = ct_vault_input(0, 10)
  let v1 = ct_vault_input(1, 10)
  let r0 = util.mk_ref_id(#"a1", 0)
  let r1 = util.mk_ref_id(#"a1", 1)
  let rd = ct_redeemer(1, 1)
  run(
    pp, 1, 6, ct_mint(10_000_000), [v0, v1],
    [ct_cont_output(11, 6, 1)], red2(r0, rd, r1, rd), rd, r0,
  )
}

// ── NEGATIVE 4b (C-CM-3 OUTPUT-COLLAPSE): 2 vault input CÙNG owner, đốt ĐỦ tổng
// (20M), nhưng CHỈ 1 continuing output → #out(1) != #in(2) → PHẢI fail. Đây là
// nhánh mà bản cũ lọt (burn aggregate đủ, list.find dồn cả 2 input về 1 output,
// rút 1 thread token + bỏ ghi 1 state). Bất biến #out==#in đóng kín.
test consume_output_collapse_burn_enough_fail() fail {
  let pp = ct_pp(6)
  let v0 = ct_vault_input(0, 10)
  let v1 = ct_vault_input(1, 10)
  let r0 = util.mk_ref_id(#"a1", 0)
  let r1 = util.mk_ref_id(#"a1", 1)
  let rd = ct_redeemer(1, 1)
  run(
    pp, 1, 6, ct_mint(20_000_000), [v0, v1],     // đốt ĐỦ 20M
    [ct_cont_output(11, 6, 1)], red2(r0, rd, r1, rd), rd, r0,   // chỉ 1 output
  )
}

// ── NEGATIVE 4c (C-CM-3 THREAD-TOKEN DRAIN): 2 input (Σnft_in=2), 2 output@script
// nhưng 1 output KHÔNG mang engage NFT (nft_qty=0) → Σnft_out(1) != Σnft_in(2) →
// fail. Chặn rút thread token khỏi protocol dù #out==#in.
test consume_thread_token_drain_fail() fail {
  let pp = ct_pp(6)
  let v0 = ct_vault_input(0, 10)
  let v1 = ct_vault_input(1, 10)
  let r0 = util.mk_ref_id(#"a1", 0)
  let r1 = util.mk_ref_id(#"a1", 1)
  let rd = ct_redeemer(1, 1)
  run(
    pp, 1, 6, ct_mint(20_000_000), [v0, v1],
    [ct_cont_output(11, 6, 1), ct_cont_output(11, 6, 0)],   // output 2 thiếu NFT
    red2(r0, rd, r1, rd), rd, r0,
  )
}

// ── HAPPY 3 (C-CM-3 đường hợp lệ N input): 2 vault input CÙNG owner, đốt đủ 20M,
// 2 continuing output mỗi cái 1 NFT, Σconsumed = 22 = 20(in) + 2(op) → PASS.
test consume_two_inputs_happy() {
  let pp = ct_pp(6)
  let v0 = ct_vault_input(0, 10)
  let v1 = ct_vault_input(1, 10)
  let r0 = util.mk_ref_id(#"a1", 0)
  let r1 = util.mk_ref_id(#"a1", 1)
  let rd = ct_redeemer(1, 1)
  run(
    pp, 1, 6, ct_mint(20_000_000), [v0, v1],
    [ct_cont_output(11, 6, 1), ct_cont_output(11, 6, 1)],
    red2(r0, rd, r1, rd), rd, r0,
  )
}

// ── NEGATIVE 4d (C-CM-4 state under-count): 2 input đủ burn, 2 output đủ NFT,
// nhưng Σconsumed_out chỉ tăng 1 (1 output không tăng state) → fail. Chặn bỏ ghi
// 1 consume khi mọi bất biến đếm/NFT đều thoả.
test consume_state_undercount_fail() fail {
  let pp = ct_pp(6)
  let v0 = ct_vault_input(0, 10)
  let v1 = ct_vault_input(1, 10)
  let r0 = util.mk_ref_id(#"a1", 0)
  let r1 = util.mk_ref_id(#"a1", 1)
  let rd = ct_redeemer(1, 1)
  run(
    pp, 1, 6, ct_mint(20_000_000), [v0, v1],
    [ct_cont_output(11, 6, 1), ct_cont_output(10, 6, 1)],   // output 2 KHÔNG tăng
    red2(r0, rd, r1, rd), rd, r0,
  )
}

// ── NEGATIVE 5 (C-CM-5): stale price — cur_epoch − pp.epoch > max_stale → fail ─
test consume_stale_price_fail() fail {
  let pp = ct_pp(1)          // beacon epoch 1
  let vin = ct_vault_input(0, 10)
  let own_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_redeemer(1, 1)
  run(
    pp, 1, 10, ct_mint(10_000_000), [vin],   // cur_epoch 10, stale 9 > 5
    [ct_cont_output(11, 10, 1)], red1(own_ref, rd), rd, own_ref,
  )
}

// ── NEGATIVE 6: giá lấy từ redeemer thay beacon — redeemer khai op_count=1 nhưng
// kẻ tấn công muốn trả theo "amount tự mớm" thấp. Mô phỏng: redeemer op_type trỏ
// op KHÔNG tồn tại trong beacon (giá rác client) → required_for None → fail.
// (Chứng minh validator CHỈ tin bảng giá beacon; op ngoài bảng không tự định giá.)
test consume_price_from_redeemer_fail() fail {
  let pp = ct_pp(6)
  let vin = ct_vault_input(0, 10)
  let own_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_redeemer(42, 1)    // op_type 42 không có trong beacon
  run(
    pp, 1, 6, ct_mint(10_000_000), [vin],
    [ct_cont_output(11, 6, 1)], red1(own_ref, rd), rd, own_ref,
  )
}

// ── NEGATIVE 7 (C-CM-2 auth): beacon NFT qty ≠ 1 → datum hijacking → fail ─────
test consume_fake_beacon_no_nft_fail() fail {
  let pp = ct_pp(6)
  let vin = ct_vault_input(0, 10)
  let own_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_redeemer(1, 1)
  run(
    pp, 0, 6, ct_mint(10_000_000), [vin],    // nft_qty = 0 trên beacon ref
    [ct_cont_output(11, 6, 1)], red1(own_ref, rd), rd, own_ref,
  )
}

// ── builders tùy biến value cho test value-preservation (finding C-CM-1 gap) ──
/// Vault input mang lovelace tùy biến + (tùy chọn) 1 token "khác" để test drain.
fn ct_vault_input_v(ref_ix: Int, consumed: Int, lovelace: Int, other_qty: Int) -> Input {
  let v0 = assets.add(assets.from_lovelace(lovelace), ct_engage_policy, ct_engage_name, 1)
  let v = assets.add(v0, #"0a0a", #"544f4b", other_qty)   // token "TOK" lạ trong vault
  let d = EngageDatum { owner: ct_owner, consumed_count: consumed, last_epoch: 0 }
  util.mk_input(util.mk_ref_id(#"a1", ref_ix), util.mk_output(util.script_address(ct_sh), v, d))
}

/// Continuing output mang lovelace + token "khác" tùy biến (để mô phỏng drain).
fn ct_cont_output_v(new_consumed: Int, new_epoch: Int, lovelace: Int, other_qty: Int) -> Output {
  let v0 = assets.add(assets.from_lovelace(lovelace), ct_engage_policy, ct_engage_name, 1)
  let v = assets.add(v0, #"0a0a", #"544f4b", other_qty)
  let d = EngageDatum { owner: ct_owner, consumed_count: new_consumed, last_epoch: new_epoch }
  util.mk_output(util.script_address(ct_sh), v, d)
}

// ── HAPPY 4 (C-CM-1 value): vault có 100 ADA + 5 TOK; continuing output GIỮ NGUYÊN
// 100 ADA + 5 TOK → non_magic_value_preserved PASS.
test consume_value_preserved_happy() {
  let pp = ct_pp(6)
  let vin = ct_vault_input_v(0, 10, 100_000_000, 5)
  let own_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_redeemer(1, 1)
  run(
    pp, 1, 6, ct_mint(10_000_000), [vin],
    [ct_cont_output_v(11, 6, 100_000_000, 5)], red1(own_ref, rd), rd, own_ref,
  )
}

// ── NEGATIVE 8 (C-CM-1 DRAIN ADA): vault 100 ADA → continuing output chỉ 2 ADA
// (98 ADA chảy ra ví attacker). NFT + state vẫn đúng nhưng ADA bị rút → PHẢI fail.
test consume_drain_ada_fail() fail {
  let pp = ct_pp(6)
  let vin = ct_vault_input_v(0, 10, 100_000_000, 0)
  let own_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_redeemer(1, 1)
  run(
    pp, 1, 6, ct_mint(10_000_000), [vin],
    [ct_cont_output_v(11, 6, 2_000_000, 0)], red1(own_ref, rd), rd, own_ref,
  )
}

// ── NEGATIVE 9 (C-CM-1 DRAIN TOKEN KHÁC): vault giữ 5 TOK → continuing output chỉ
// 2 TOK (rút 3 TOK lạ khỏi vault) → non_magic_value_preserved fail → PHẢI fail.
test consume_drain_other_token_fail() fail {
  let pp = ct_pp(6)
  let vin = ct_vault_input_v(0, 10, 100_000_000, 5)
  let own_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_redeemer(1, 1)
  run(
    pp, 1, 6, ct_mint(10_000_000), [vin],
    [ct_cont_output_v(11, 6, 100_000_000, 2)], red1(own_ref, rd), rd, own_ref,
  )
}

// ── NEGATIVE 10 (finding medium): base_price âm trong beacon → valid_param fail →
// consume PHẢI fail (giá âm → required âm → drain miễn phí). Beacon op_type 2 = −1.
test consume_negative_base_price_fail() fail {
  let bad_pp =
    PriceParam {
      op_prices: [
        OpPrice { op_type: 1, base_price: 10_000_000 },
        OpPrice { op_type: 2, base_price: -1 },
      ],
      demand_mult: 1_000_000_000,
      m_min: 500_000_000,
      m_max: 2_000_000_000,
      epoch: 6,
    }
  let vin = ct_vault_input(0, 10)
  let own_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_redeemer(1, 1)
  run(
    bad_pp, 1, 6, ct_mint(10_000_000), [vin],
    [ct_cont_output(11, 6, 1)], red1(own_ref, rd), rd, own_ref,
  )
}

// ── HAPPY 2: over-burn cho phép (magic_burned > required) — đốt 2 ảnh trả dư ──
test consume_overburn_ok() {
  let pp = ct_pp(6)
  let vin = ct_vault_input(0, 10)
  let own_ref = util.mk_ref_id(#"a1", 0)
  let rd = ct_redeemer(1, 1)     // cần 10_000_000
  run(
    pp, 1, 6, ct_mint(15_000_000), [vin],    // đốt dư
    [ct_cont_output(11, 6, 1)], red1(own_ref, rd), rd, own_ref,
  )
}
