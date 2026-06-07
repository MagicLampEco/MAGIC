// PriceParam beacon spend validator (CONTRACT.md §B1).
// Committee/keeper post bảng giá + demand_mult mới mỗi epoch. Authenticity = NFT.
// Genesis beacon tạo lúc deploy (pay-to-address + mint NFT one-shot). Update sau
// = spend + re-create với epoch ĐƠN ĐIỆU TĂNG (chống rollback giá cũ).

use aiken/collection/list
use cardano/assets
use cardano/transaction.{InlineDatum, OutputReference, Transaction, placeholder}
use magiclamp/consume/pricing
use magiclamp/consume/types.{OpPrice, PostPrice, PriceParam, PriceParamRedeemer}
use magiclamp/consume/util

validator price_param(
  committee         : List<ByteArray>,
  threshold         : Int,
  price_nft_policy  : ByteArray,
  price_nft_name    : ByteArray,
) {
  spend(
    datum_opt : Option<PriceParam>,
    _redeemer : PriceParamRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(datum) = datum_opt
    let own_addr = util.own_address(own_ref, tx.inputs)
    let own_hash = util.own_script_hash(own_addr)

    // Beacon không liên quan mint (NFT bảo toàn, không đốt/đúc thêm ở đây).
    expect assets.is_zero(tx.mint)

    // single-input + single-output theo SCRIPT HASH (chống double-satisfaction).
    expect util.count_inputs_at_script(tx.inputs, own_hash) == 1
    expect util.count_outputs_at_script(tx.outputs, own_hash) == 1

    // Committee M-of-N đồng thuận.
    expect count_sigs(committee, tx.extra_signatories) >= threshold

    let beacon_in = util.input_at_script(tx.inputs, own_hash)
    let beacon_out = util.output_at_script(tx.outputs, own_hash)
    expect InlineDatum(d) = beacon_out.datum
    expect out_datum: PriceParam = d

    // epoch đơn điệu TĂNG (chống rollback về giá thấp khi demand đã lên).
    expect out_datum.epoch > datum.epoch

    // datum mới phải hợp lệ (clamp invariant) — không post giá rác.
    expect pricing.valid_param(out_datum)

    // authenticity NFT bảo toàn (đúng 1 token in/out, không rút).
    let nft_in = assets.quantity_of(beacon_in.value, price_nft_policy, price_nft_name)
    let nft_out = assets.quantity_of(beacon_out.value, price_nft_policy, price_nft_name)
    expect nft_in == 1
    expect nft_out == 1
    True
  }

  else(_) {
    fail
  }
}

fn count_sigs(committee: List<ByteArray>, sigs: List<ByteArray>) -> Int {
  list.count(committee, fn(k) { list.has(sigs, k) })
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

const pp_sh: ByteArray = #"d0d0"

const pp_committee: List<ByteArray> = [#"c1", #"c2", #"c3"]

const pp_threshold: Int = 2

const pp_nft_policy: ByteArray = #"9999"

const pp_nft_name: ByteArray = #"5052494345"

fn mk_pp(epoch: Int, demand: Int) -> PriceParam {
  PriceParam {
    op_prices: [
      OpPrice { op_type: 1, base_price: 10_000_000 },
      OpPrice { op_type: 2, base_price: 1_000_000 },
    ],
    demand_mult: demand,
    m_min: 500_000_000,
    m_max: 2_000_000_000,
    epoch: epoch,
  }
}

fn pp_tx(in_epoch: Int, out_epoch: Int, out_demand: Int, sigs: List<ByteArray>) -> Transaction {
  let addr = util.script_address(pp_sh)
  let nft_val = assets.add(assets.from_lovelace(2_000_000), pp_nft_policy, pp_nft_name, 1)
  let b_in = util.mk_input(util.mk_ref(0), util.mk_output(addr, nft_val, mk_pp(in_epoch, 1_000_000_000)))
  let b_out = util.mk_output(addr, nft_val, mk_pp(out_epoch, out_demand))
  Transaction {
    ..placeholder,
    inputs: [b_in],
    outputs: [b_out],
    extra_signatories: sigs,
    mint: assets.zero,
  }
}

test price_param_happy() {
  let tx = pp_tx(5, 6, 1_500_000_000, [#"c1", #"c2"])
  price_param.spend(
    pp_committee, pp_threshold, pp_nft_policy, pp_nft_name,
    Some(mk_pp(5, 1_000_000_000)), PostPrice, util.mk_ref(0), tx,
  )
}

test price_param_epoch_not_increasing() fail {
  let tx = pp_tx(5, 5, 1_500_000_000, [#"c1", #"c2"])
  price_param.spend(
    pp_committee, pp_threshold, pp_nft_policy, pp_nft_name,
    Some(mk_pp(5, 1_000_000_000)), PostPrice, util.mk_ref(0), tx,
  )
}

test price_param_insufficient_sigs() fail {
  let tx = pp_tx(5, 6, 1_500_000_000, [#"c1"])
  price_param.spend(
    pp_committee, pp_threshold, pp_nft_policy, pp_nft_name,
    Some(mk_pp(5, 1_000_000_000)), PostPrice, util.mk_ref(0), tx,
  )
}

test price_param_invalid_clamp() fail {
  // out demand_mult > m_max → valid_param false → reject.
  let tx = pp_tx(5, 6, 3_000_000_000, [#"c1", #"c2"])
  price_param.spend(
    pp_committee, pp_threshold, pp_nft_policy, pp_nft_name,
    Some(mk_pp(5, 1_000_000_000)), PostPrice, util.mk_ref(0), tx,
  )
}
