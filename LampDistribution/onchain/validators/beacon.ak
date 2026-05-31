// Beacon validator (SPEC §QĐ2/QĐ3, C-BCN-1).
// Committee post P / Randomness nonce / MerkleRoot mỗi epoch. Authenticity = NFT.
// Genesis beacon (epoch đầu) được tạo bằng cách pay-to-address + NFT lúc deploy
// (không qua validator). Mọi update sau spend + re-create với epoch tăng.

use aiken/collection/list
use cardano/assets
use cardano/transaction.{InlineDatum, OutputReference, Transaction, placeholder}
use magiclamp/lampdist/types.{
  BeaconDatum, BeaconKind, BeaconRedeemer, PParam, PostBeacon, Randomness,
}
use magiclamp/lampdist/util

validator beacon(
  committee         : List<ByteArray>,
  threshold         : Int,
  beacon_nft_policy : ByteArray,
) {
  spend(
    datum_opt : Option<BeaconDatum>,
    _redeemer : BeaconRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(datum) = datum_opt
    let own_addr = util.own_address(own_ref, tx.inputs)
    let own_hash = util.own_script_hash(own_addr)

    // C-MINT-0: validator beacon không liên quan mint
    expect assets.is_zero(tx.mint)

    // single-input + single-output theo SCRIPT HASH (chống double-satisfaction
    // qua stake credential — audit C1).
    expect util.count_inputs_at_script(tx.inputs, own_hash) == 1
    expect util.count_outputs_at_script(tx.outputs, own_hash) == 1

    // C-BCN-1: committee 2/3 đồng thuận
    expect util.count_committee_sigs(committee, tx.extra_signatories) >= threshold

    let beacon_in = util.input_at_script(tx.inputs, own_hash)
    let beacon_out = util.output_at_script(tx.outputs, own_hash)
    expect InlineDatum(d) = beacon_out.datum
    expect out_datum: BeaconDatum = d

    // epoch đơn điệu tăng; kind bảo toàn
    expect out_datum.epoch > datum.epoch
    expect out_datum.kind == datum.kind

    // authenticity NFT bảo toàn (đúng 1 token, không bị rút)
    let nft_name = util.beacon_name(datum.kind)
    let nft_in = assets.quantity_of(beacon_in.value, beacon_nft_policy, nft_name)
    let nft_out = assets.quantity_of(beacon_out.value, beacon_nft_policy, nft_name)
    expect nft_in == 1
    expect nft_out == 1

    True
  }

  else(_) {
    fail
  }
}

// ══════════════════════════════════════════════════════════════
// Validator tests (mock Transaction)
// ══════════════════════════════════════════════════════════════

const bt_sh: ByteArray = #"b0b0b0b0"

const bt_committee: List<ByteArray> = [#"c1", #"c2", #"c3"]

const bt_threshold: Int = 2

const bt_nft_policy: ByteArray = #"beac"

fn bt_datum(epoch: Int, kind: BeaconKind) -> BeaconDatum {
  BeaconDatum { epoch: epoch, kind: kind, value: #"00" }
}

fn beacon_tx(
  in_epoch  : Int,
  out_epoch : Int,
  sigs      : List<ByteArray>,
  out_kind  : BeaconKind,
) -> Transaction {
  let addr = util.script_address(bt_sh)
  let nft_val =
    assets.add(assets.from_lovelace(2_000_000), bt_nft_policy, util.beacon_name(PParam), 1)
  let b_in = util.mk_input(util.mk_ref(0), util.mk_output(addr, nft_val, bt_datum(in_epoch, PParam)))
  let b_out = util.mk_output(addr, nft_val, bt_datum(out_epoch, out_kind))
  Transaction {
    ..placeholder,
    inputs: [b_in],
    outputs: [b_out],
    extra_signatories: sigs,
    mint: assets.zero,
  }
}

test beacon_happy() {
  let tx = beacon_tx(5, 6, [#"c1", #"c2"], PParam)
  beacon.spend(
    bt_committee, bt_threshold, bt_nft_policy, Some(bt_datum(5, PParam)), PostBeacon, util.mk_ref(0),
    tx,
  )
}

test beacon_epoch_not_increasing() fail {
  // out.epoch == in.epoch (không tăng) → reject (C-BCN-1)
  let tx = beacon_tx(5, 5, [#"c1", #"c2"], PParam)
  beacon.spend(
    bt_committee, bt_threshold, bt_nft_policy, Some(bt_datum(5, PParam)), PostBeacon, util.mk_ref(0),
    tx,
  )
}

test beacon_kind_changed() fail {
  // out.kind ≠ in.kind → reject (C-BCN-1)
  let tx = beacon_tx(5, 6, [#"c1", #"c2"], Randomness)
  beacon.spend(
    bt_committee, bt_threshold, bt_nft_policy, Some(bt_datum(5, PParam)), PostBeacon, util.mk_ref(0),
    tx,
  )
}

test beacon_insufficient_committee() fail {
  // 1 sig < threshold 2 → reject
  let tx = beacon_tx(5, 6, [#"c1"], PParam)
  beacon.spend(
    bt_committee, bt_threshold, bt_nft_policy, Some(bt_datum(5, PParam)), PostBeacon, util.mk_ref(0),
    tx,
  )
}
