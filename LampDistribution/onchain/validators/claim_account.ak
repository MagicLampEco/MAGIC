// ClaimAccount validator (SPEC §5, §6 — C-CLAIM-*, C-RDM-*).
// Per-wallet account UTxO. 2 redeemer:
//   Claim  — committee 2/3 confirm activity → claimed_cumulative += amount.
//   Redeem — user redeem với Merkle proof của won_cumulative (cumulative, QĐ6),
//            nhận đúng `released` LAMP từ treasury cùng tx.

use aiken/collection/list
use aiken/interval
use cardano/assets
use cardano/transaction.{InlineDatum, Input, OutputReference, Transaction, placeholder}
use magiclamp/lampdist/merkle
use magiclamp/lampdist/types.{
  BeaconDatum, Claim, ClaimAccountDatum, ClaimAccountRedeemer, MerkleRoot, Redeem,
}
use magiclamp/lampdist/util

validator claim_account(
  committee         : List<ByteArray>,
  threshold         : Int,
  ms_per_epoch      : Int,
  lamp_policy       : ByteArray,
  lamp_name         : ByteArray,
  beacon_nft_policy : ByteArray,
) {
  spend(
    datum_opt : Option<ClaimAccountDatum>,
    redeemer  : ClaimAccountRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(datum) = datum_opt
    let own_addr = util.own_address(own_ref, tx.inputs)
    let own_hash = util.own_script_hash(own_addr)

    // C-MINT-0: account validator không liên quan mint
    expect assets.is_zero(tx.mint)

    // C-CLAIM-5 / C-RDM-7: đúng 1 account input + 1 output theo SCRIPT HASH
    // (chống double-satisfaction qua stake credential — audit C1).
    expect util.count_inputs_at_script(tx.inputs, own_hash) == 1
    expect util.count_outputs_at_script(tx.outputs, own_hash) == 1

    let acc_in = util.input_at_script(tx.inputs, own_hash)
    let acc_out = util.output_at_script(tx.outputs, own_hash)
    expect InlineDatum(d) = acc_out.datum
    expect out_datum: ClaimAccountDatum = d

    // Account UTxO chỉ giữ min-ADA (không LAMP) — value bảo toàn tuyệt đối,
    // chống chèn/rút asset lạ (C-VAL-0).
    expect acc_out.value == acc_in.value

    when redeemer is {
      // ── CLAIM (committee) ──────────────────────────────────
      Claim { amount } -> {
        expect amount > 0
        // C-CLAIM-1
        expect util.count_committee_sigs(committee, tx.extra_signatories) >= threshold
        let current_epoch = util.get_epoch(tx, ms_per_epoch)
        // C-CLAIM-2/3/4
        expect out_datum.owner == datum.owner
        expect out_datum.claimed_cumulative == datum.claimed_cumulative + amount
        expect out_datum.redeemed_cumulative == datum.redeemed_cumulative
        expect out_datum.last_claim_epoch == current_epoch
        True
      }

      // ── REDEEM (user + Merkle proof) ───────────────────────
      Redeem { won_cumulative, lottery_epoch, proof } -> {
        // C-RDM-6: owner ký
        expect list.has(tx.extra_signatories, datum.owner)

        // C-RDM-1: Merkle proof hợp lệ với MerkleRoot beacon[lottery_epoch]
        let root = find_merkle_root(tx.reference_inputs, beacon_nft_policy, lottery_epoch)
        expect merkle.verify_claim(root, datum.owner, won_cumulative, proof)

        // C-RDM-2: released > 0; C-RDM-5: không vượt đã claim
        expect won_cumulative > datum.redeemed_cumulative
        expect won_cumulative <= datum.claimed_cumulative
        let released = won_cumulative - datum.redeemed_cumulative

        // C-RDM-4: chỉ redeemed_cumulative đổi, các field khác giữ nguyên
        expect out_datum.owner == datum.owner
        expect out_datum.claimed_cumulative == datum.claimed_cumulative
        expect out_datum.redeemed_cumulative == won_cumulative
        expect out_datum.last_claim_epoch == datum.last_claim_epoch

        // C-RDM-3: owner nhận ĐÚNG (≥) released LAMP
        expect util.lamp_to_owner(tx.outputs, datum.owner, lamp_policy, lamp_name) >= released

        True
      }
    }
  }

  else(_) {
    fail
  }
}

// ══════════════════════════════════════════════════════════════
// Validator tests (mock Transaction)
// ══════════════════════════════════════════════════════════════

const t_sh: ByteArray = #"a1a1a1a1"

const t_committee: List<ByteArray> = [#"c1", #"c2", #"c3"]

const t_threshold: Int = 2

const t_mspe: Int = 86_400_000

const t_lamp_policy: ByteArray = #"1a3b"

const t_lamp_name: ByteArray = #"4c414d50"

const t_beacon_policy: ByteArray = #"beac"

const t_owner: ByteArray = #"0a0a"

fn ca_datum(claimed: Int, redeemed: Int, last_epoch: Int) -> ClaimAccountDatum {
  ClaimAccountDatum {
    owner: t_owner,
    claimed_cumulative: claimed,
    redeemed_cumulative: redeemed,
    last_claim_epoch: last_epoch,
  }
}

// tx cho CLAIM: 1 account input + 1 output, committee sigs, epoch.
fn claim_tx(
  in_d  : ClaimAccountDatum,
  out_d : ClaimAccountDatum,
  sigs  : List<ByteArray>,
  epoch : Int,
  out_value : assets.Value,
) -> Transaction {
  let acc_addr = util.script_address(t_sh)
  let in_val = assets.from_lovelace(2_000_000)
  let acc_in = util.mk_input(util.mk_ref(0), util.mk_output(acc_addr, in_val, in_d))
  let acc_out = util.mk_output(acc_addr, out_value, out_d)
  Transaction {
    ..placeholder,
    inputs: [acc_in],
    outputs: [acc_out],
    extra_signatories: sigs,
    validity_range: interval.after(epoch * t_mspe),
    mint: assets.zero,
  }
}

test claim_happy_path() {
  let in_d = ca_datum(0, 0, 0)
  let out_d = ca_datum(100, 0, 5)
  let tx = claim_tx(in_d, out_d, [#"c1", #"c2"], 5, assets.from_lovelace(2_000_000))
  claim_account.spend(
    t_committee, t_threshold, t_mspe, t_lamp_policy, t_lamp_name, t_beacon_policy,
    Some(in_d), Claim { amount: 100 }, util.mk_ref(0), tx,
  )
}

test claim_insufficient_committee() fail {
  let in_d = ca_datum(0, 0, 0)
  let out_d = ca_datum(100, 0, 5)
  // chỉ 1 committee sig < threshold 2 → reject
  let tx = claim_tx(in_d, out_d, [#"c1"], 5, assets.from_lovelace(2_000_000))
  claim_account.spend(
    t_committee, t_threshold, t_mspe, t_lamp_policy, t_lamp_name, t_beacon_policy,
    Some(in_d), Claim { amount: 100 }, util.mk_ref(0), tx,
  )
}

test claim_value_tamper() fail {
  let in_d = ca_datum(0, 0, 0)
  let out_d = ca_datum(100, 0, 5)
  // output nhét token lạ → acc_out.value != acc_in.value → reject (C-VAL-0)
  let tampered = assets.add(assets.from_lovelace(2_000_000), #"dead", #"beef", 1)
  let tx = claim_tx(in_d, out_d, [#"c1", #"c2"], 5, tampered)
  claim_account.spend(
    t_committee, t_threshold, t_mspe, t_lamp_policy, t_lamp_name, t_beacon_policy,
    Some(in_d), Claim { amount: 100 }, util.mk_ref(0), tx,
  )
}

// tx cho REDEEM: account in/out + owner nhận LAMP + beacon ref input (MerkleRoot NFT).
fn redeem_tx(
  in_d           : ClaimAccountDatum,
  out_d          : ClaimAccountDatum,
  owner_lamp_out : Int,
  beacon_epoch   : Int,
  root           : ByteArray,
  sigs           : List<ByteArray>,
) -> Transaction {
  let acc_addr = util.script_address(t_sh)
  let val = assets.from_lovelace(2_000_000)
  let acc_in = util.mk_input(util.mk_ref(0), util.mk_output(acc_addr, val, in_d))
  let acc_out = util.mk_output(acc_addr, val, out_d)
  let owner_val = assets.add(assets.from_lovelace(2_000_000), t_lamp_policy, t_lamp_name, owner_lamp_out)
  let owner_out = util.mk_output(util.vk_address(t_owner), owner_val, in_d)
  // beacon reference input mang NFT MerkleRoot
  let beacon_addr = util.script_address(#"bbbbbbbb")
  let beacon_val =
    assets.add(assets.from_lovelace(2_000_000), t_beacon_policy, util.beacon_name(MerkleRoot), 1)
  let beacon_datum = BeaconDatum { epoch: beacon_epoch, kind: MerkleRoot, value: root }
  let beacon_ref = util.mk_input(util.mk_ref(5), util.mk_output(beacon_addr, beacon_val, beacon_datum))
  Transaction {
    ..placeholder,
    inputs: [acc_in],
    reference_inputs: [beacon_ref],
    outputs: [acc_out, owner_out],
    extra_signatories: sigs,
    mint: assets.zero,
  }
}

test redeem_happy_path() {
  let in_d = ca_datum(1000, 0, 0)
  let out_d = ca_datum(1000, 100, 0)
  // cây 1 leaf → root == leaf_hash(owner, won); proof rỗng
  let root = merkle.leaf_hash(t_owner, 100)
  let tx = redeem_tx(in_d, out_d, 100, 5, root, [t_owner])
  claim_account.spend(
    t_committee, t_threshold, t_mspe, t_lamp_policy, t_lamp_name, t_beacon_policy,
    Some(in_d), Redeem { won_cumulative: 100, lottery_epoch: 5, proof: [] }, util.mk_ref(0), tx,
  )
}

test redeem_double_spend() fail {
  // redeemed đã = 100, submit lại won=100 → won > redeemed sai → reject (C-RDM-2)
  let in_d = ca_datum(1000, 100, 0)
  let out_d = ca_datum(1000, 100, 0)
  let root = merkle.leaf_hash(t_owner, 100)
  let tx = redeem_tx(in_d, out_d, 0, 5, root, [t_owner])
  claim_account.spend(
    t_committee, t_threshold, t_mspe, t_lamp_policy, t_lamp_name, t_beacon_policy,
    Some(in_d), Redeem { won_cumulative: 100, lottery_epoch: 5, proof: [] }, util.mk_ref(0), tx,
  )
}

test redeem_forged_amount() fail {
  // root commit won=100, attacker khai won=999 → proof fail (C-RDM-1)
  let in_d = ca_datum(1000, 0, 0)
  let out_d = ca_datum(1000, 999, 0)
  let root = merkle.leaf_hash(t_owner, 100)
  let tx = redeem_tx(in_d, out_d, 999, 5, root, [t_owner])
  claim_account.spend(
    t_committee, t_threshold, t_mspe, t_lamp_policy, t_lamp_name, t_beacon_policy,
    Some(in_d), Redeem { won_cumulative: 999, lottery_epoch: 5, proof: [] }, util.mk_ref(0), tx,
  )
}

test redeem_no_owner_sig() fail {
  // không có owner trong extra_signatories → reject (C-RDM-6)
  let in_d = ca_datum(1000, 0, 0)
  let out_d = ca_datum(1000, 100, 0)
  let root = merkle.leaf_hash(t_owner, 100)
  let tx = redeem_tx(in_d, out_d, 100, 5, root, [])
  claim_account.spend(
    t_committee, t_threshold, t_mspe, t_lamp_policy, t_lamp_name, t_beacon_policy,
    Some(in_d), Redeem { won_cumulative: 100, lottery_epoch: 5, proof: [] }, util.mk_ref(0), tx,
  )
}

test redeem_beacon_wrong_epoch() fail {
  // beacon epoch 7 ≠ redeemer lottery_epoch 5 → find_merkle_root reject (C-RDM-1)
  let in_d = ca_datum(1000, 0, 0)
  let out_d = ca_datum(1000, 100, 0)
  let root = merkle.leaf_hash(t_owner, 100)
  let tx = redeem_tx(in_d, out_d, 100, 7, root, [t_owner])
  claim_account.spend(
    t_committee, t_threshold, t_mspe, t_lamp_policy, t_lamp_name, t_beacon_policy,
    Some(in_d), Redeem { won_cumulative: 100, lottery_epoch: 5, proof: [] }, util.mk_ref(0), tx,
  )
}

/// Đọc Merkle root từ reference input mang beacon NFT (kind=MerkleRoot, epoch khớp).
/// Authenticity qua NFT → chống datum hijacking (fake beacon ở cùng address).
fn find_merkle_root(
  ref_inputs        : List<Input>,
  beacon_nft_policy : ByteArray,
  lottery_epoch     : Int,
) -> ByteArray {
  let mroot_name = util.beacon_name(MerkleRoot)
  expect Some(ri) =
    list.find(
      ref_inputs,
      fn(i) { assets.quantity_of(i.output.value, beacon_nft_policy, mroot_name) == 1 },
    )
  expect InlineDatum(d) = ri.output.datum
  expect bd: BeaconDatum = d
  expect bd.kind == MerkleRoot
  expect bd.epoch == lottery_epoch
  bd.value
}
