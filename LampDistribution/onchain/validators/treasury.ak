// DistributionTreasury validator (SPEC §QĐ7, C-TRE-1/2).
// Giữ LAMP pool; release đúng `released` cho mỗi Redeem cùng tx.
// KHÔNG cần committee — release được kích hoạt bởi 1 Redeem hợp lệ (đã verify Merkle
// proof ở claim_account validator). Treasury chỉ kiểm LAMP delta khớp redeemed delta.

use aiken/collection/list
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, placeholder,
}
use magiclamp/lampdist/types.{
  ClaimAccountDatum, ReleaseForRedeem, TreasuryDatum, TreasuryRedeemer,
}
use magiclamp/lampdist/util

validator treasury(
  claim_account_hash : ByteArray,
  lamp_policy        : ByteArray,
  lamp_name          : ByteArray,
) {
  spend(
    datum_opt : Option<TreasuryDatum>,
    _redeemer : TreasuryRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(datum) = datum_opt
    let own_addr = util.own_address(own_ref, tx.inputs)
    let own_hash = util.own_script_hash(own_addr)

    // C-MINT-0
    expect assets.is_zero(tx.mint)

    // C-TRE-1: đúng 1 treasury input + output theo SCRIPT HASH trên toàn tx
    // (chống N× release qua nhiều treasury UTxO khác stake cred — audit C2).
    expect util.count_inputs_at_script(tx.inputs, own_hash) == 1
    expect util.count_outputs_at_script(tx.outputs, own_hash) == 1

    let tre_in = util.input_at_script(tx.inputs, own_hash)
    let tre_out = util.output_at_script(tx.outputs, own_hash)

    // C-TRE-2: datum bảo toàn
    expect InlineDatum(od) = tre_out.datum
    expect out_datum: TreasuryDatum = od
    expect out_datum.committee_hash == datum.committee_hash

    // Đúng 1 ClaimAccount input + output (cùng tx redeem) — chống batch nhập nhằng.
    expect
      list.count(tx.inputs, fn(i) { util.is_at_script(i.output.address, claim_account_hash) }) == 1
    expect
      list.count(tx.outputs, fn(o) { util.is_at_script(o.address, claim_account_hash) }) == 1

    // released = ClaimAccount.redeemed_cumulative(out) − redeemed_cumulative(in)
    let ca_in = find_claim_account_input(tx.inputs, claim_account_hash)
    let ca_out = find_claim_account_output(tx.outputs, claim_account_hash)
    let released = ca_out.redeemed_cumulative - ca_in.redeemed_cumulative
    expect released > 0

    // C-TRE-1 + C-VAL-0: output treasury == input value với LAMP giảm ĐÚNG released.
    // Bảo toàn TUYỆT ĐỐI mọi asset khác (ADA, token) — chống drain ADA (audit M1).
    expect tre_out.value == assets.add(tre_in.value, lamp_policy, lamp_name, -released)

    True
  }

  else(_) {
    fail
  }
}

fn find_claim_account_input(inputs: List<Input>, script_hash: ByteArray) -> ClaimAccountDatum {
  expect Some(i) = list.find(inputs, fn(x) { util.is_at_script(x.output.address, script_hash) })
  expect InlineDatum(d) = i.output.datum
  expect ca: ClaimAccountDatum = d
  ca
}

fn find_claim_account_output(outputs: List<Output>, script_hash: ByteArray) -> ClaimAccountDatum {
  expect Some(o) = list.find(outputs, fn(x) { util.is_at_script(x.address, script_hash) })
  expect InlineDatum(d) = o.datum
  expect ca: ClaimAccountDatum = d
  ca
}

// ══════════════════════════════════════════════════════════════
// Validator tests (mock Transaction) — chứng minh fix C2 + M1
// ══════════════════════════════════════════════════════════════

const tt_tre_sh: ByteArray = #"77777777"

const tt_ca_sh: ByteArray = #"a1a1a1a1"

const tt_lamp_policy: ByteArray = #"1a3b"

const tt_lamp_name: ByteArray = #"4c414d50"

const tt_owner: ByteArray = #"0a0a"

fn tt_tre_d() -> TreasuryDatum {
  TreasuryDatum { committee_hash: #"cccc" }
}

fn tt_ca_d(redeemed: Int) -> ClaimAccountDatum {
  ClaimAccountDatum {
    owner: tt_owner,
    claimed_cumulative: 1000,
    redeemed_cumulative: redeemed,
    last_claim_epoch: 0,
  }
}

fn tt_lamp_val(lovelace: Int, lamp: Int) -> assets.Value {
  assets.add(assets.from_lovelace(lovelace), tt_lamp_policy, tt_lamp_name, lamp)
}

fn treasury_tx(
  tre_in_val  : assets.Value,
  tre_out_val : assets.Value,
  redeemed_in : Int,
  redeemed_out: Int,
  extra_tre   : List<Input>,
) -> Transaction {
  let tre_addr = util.script_address(tt_tre_sh)
  let ca_addr = util.script_address(tt_ca_sh)
  let tre_in = util.mk_input(util.mk_ref(0), util.mk_output(tre_addr, tre_in_val, tt_tre_d()))
  let tre_out = util.mk_output(tre_addr, tre_out_val, tt_tre_d())
  let ca_in =
    util.mk_input(
      util.mk_ref(1),
      util.mk_output(ca_addr, assets.from_lovelace(2_000_000), tt_ca_d(redeemed_in)),
    )
  let ca_out = util.mk_output(ca_addr, assets.from_lovelace(2_000_000), tt_ca_d(redeemed_out))
  Transaction {
    ..placeholder,
    inputs: list.concat([tre_in, ca_in], extra_tre),
    outputs: [tre_out, ca_out],
    mint: assets.zero,
  }
}

test treasury_happy() {
  // released = 100; treasury LAMP 1000 → 900, ADA giữ nguyên
  let tx = treasury_tx(tt_lamp_val(5_000_000, 1000), tt_lamp_val(5_000_000, 900), 0, 100, [])
  treasury.spend(
    tt_ca_sh, tt_lamp_policy, tt_lamp_name, Some(tt_tre_d()), ReleaseForRedeem, util.mk_ref(0), tx,
  )
}

test treasury_double_release() fail {
  // C2: 2 treasury input cùng script hash, KHÁC stake cred → count_inputs_at_script == 2 → reject
  let tre_addr2 = util.script_address_staked(tt_tre_sh, #"5742")
  let extra =
    util.mk_input(util.mk_ref(9), util.mk_output(tre_addr2, tt_lamp_val(5_000_000, 1000), tt_tre_d()))
  let tx = treasury_tx(tt_lamp_val(5_000_000, 1000), tt_lamp_val(5_000_000, 900), 0, 100, [extra])
  treasury.spend(
    tt_ca_sh, tt_lamp_policy, tt_lamp_name, Some(tt_tre_d()), ReleaseForRedeem, util.mk_ref(0), tx,
  )
}

test treasury_ada_drain() fail {
  // M1: LAMP delta đúng (1000→900=released 100) NHƯNG rút bớt ADA (5M→2M) → value sai → reject
  let tx = treasury_tx(tt_lamp_val(5_000_000, 1000), tt_lamp_val(2_000_000, 900), 0, 100, [])
  treasury.spend(
    tt_ca_sh, tt_lamp_policy, tt_lamp_name, Some(tt_tre_d()), ReleaseForRedeem, util.mk_ref(0), tx,
  )
}

test treasury_zero_release() fail {
  // released = 0 (redeemed không đổi) → expect released > 0 fail → reject
  let tx = treasury_tx(tt_lamp_val(5_000_000, 1000), tt_lamp_val(5_000_000, 1000), 100, 100, [])
  treasury.spend(
    tt_ca_sh, tt_lamp_policy, tt_lamp_name, Some(tt_tre_d()), ReleaseForRedeem, util.mk_ref(0), tx,
  )
}
