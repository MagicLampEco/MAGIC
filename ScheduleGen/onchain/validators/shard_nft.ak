// validators/shard_nft.ak — Shard NFT minting policy ONE-SHOT (§11.5).
//
// ── MAINNET-BLOCK fix, layer (a) ──────────────────────────────────────────
// ScheduleGen pins the SCHEDULE_PARTICIPATION_CAP (20% of LAMP) by sharding it
// across 16 aggregate UTxOs, each tagged by a shard NFT. The previous deploy
// used a native `sig` policy keyed to the deployer (03_deploy_shards.ts), which
// can be re-minted arbitrarily AND issued all 16 tokens under the SAME asset
// name "SHARD" (distinguished only by the self-declared `shard_id` datum field).
//
// That broke C-SCH-CAP at the root: the deployer (or a leaked key) could mint
// an extra "SHARD" token, attach a forged shard UTxO with the SAME shard_id and
// shard_locked_lamp = 0, and route commits through it — resetting cap headroom
// without limit and inflating MAGIC past the 2000 bps cap.
//
// FIRST-PRINCIPLES one-shot, distinct names:
//   1. The policy is parameterized by ONE genesis OutputReference. A UTxO is
//      spendable at most once → the policy runs at most once → supply is fixed.
//   2. It mints EXACTLY 16 NFTs, one per asset name `shard_asset_name(0..15)` =
//      "SHARD" ∥ byte(id). Each shard is now identified by a UNIQUE asset name,
//      not by a forgeable datum field. No second token can ever share an id.
//   3. No extra names, no quantity ≠ 1, no burns (else branch fails closed).
//
// Pair with the vault/shard validators which (b) identify the shard by this
// asset name and (c) assert tx.mint carries NO shard-policy token during
// commit/fire/shard-spend (defence in depth — after genesis, minting is already
// impossible, but the validators do not assume the policy can never run).

use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Address, VerificationKey}
use cardano/assets.{PolicyId}
use cardano/address.{Script}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}
use magiclamp/protocol/constants.{shard_cap, shard_count}
use magiclamp/protocol/math.{shard_asset_name}
use magiclamp/protocol/types.{ScheduleAggregateShardDatum}

validator shard_nft(genesis_ref: OutputReference) {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    // ── ONE-SHOT: must consume the exact genesis UTxO ──────────────────────
    expect list.any(tx.inputs, fn(i) { i.output_reference == genesis_ref })

    // ── Exactly 16 distinct asset names under this policy, qty +1 each ──────
    let own_tokens = assets.tokens(tx.mint, policy_id)
    expect dict.size(own_tokens) == shard_count
    expect all_shard_names_minted(tx.mint, policy_id, 0)

    // ── DATUM KHỞI TẠO SẠCH (Nợ #33) ───────────────────────────────────────
    //    Ba `expect` ở trên nói về TOKEN, không dòng nào chạm `tx.outputs`. Nên
    //    16 NFT đúc đúng số, mà DATUM đi kèm là tuỳ ý người chạy script deploy:
    //    đặt `shard_locked_lamp` âm-nghĩa-lớn hay `shard_cap` khổng lồ cho một
    //    shard là gỡ trần C-SCH-CAP cho đúng 1/16 số người dùng — những người
    //    hash vào shard đó — mà không lá chắn nào phía sau thấy, vì từ đó trở đi
    //    validator chỉ kiểm DELTA chứ không kiểm điểm xuất phát.
    //
    //    Cardano chỉ chạy validator lúc TIÊU, không bao giờ lúc TẠO. Genesis là
    //    lần duy nhất policy này chạy, nên đây là chỗ duy nhất ràng được điểm
    //    xuất phát. Bỏ qua ở đây là bỏ qua vĩnh viễn.
    expect all_shards_start_clean(tx.outputs, policy_id, 0)
    True
  }

  // Spend / burn / any other purpose fails closed — the NFTs are permanent.
  else(_) {
    fail
  }
}

// For id = 0..15: quantity_of(mint, policy, shard_asset_name(id)) == 1.
// Combined with dict.size == 16, this proves the mint is EXACTLY the 16 shard
// NFTs and nothing else.
fn all_shard_names_minted(
  mint      : assets.Value,
  policy_id : PolicyId,
  id        : Int,
) -> Bool {
  if id >= shard_count {
    True
  } else {
    assets.quantity_of(mint, policy_id, shard_asset_name(id)) == 1 && all_shard_names_minted(
      mint,
      policy_id,
      id + 1,
    )
  }
}

/// Với id = 0..15: NFT `shard_asset_name(id)` phải nằm ở ĐÚNG MỘT output mang
/// inline `ScheduleAggregateShardDatum` **sạch** — mọi bộ đếm bằng 0, `shard_id`
/// khớp tên tài sản, `shard_cap` đúng hằng số giao thức.
///
/// `last_updated_epoch` cố ý KHÔNG ràng: nó là sổ ghi chép, mọi nhánh sau đều
/// ghi đè, và ép nó ở đây chỉ làm script deploy phải đoán epoch lúc nộp tx.
///
/// CÒN MỞ — ĐỊA CHỈ. Policy này không biết script hash của validator `shard`, và
/// không thể biết: `shard` đã nhận `shard_policy_id` làm apply-param, thêm chiều
/// ngược lại là một vòng tròn tham số không giải được. Nên genesis vẫn đặt được
/// NFT ở SAI script. Hai thứ chặn phần lớn hậu quả đó: `find_shard_input_raw`
/// đòi input khoá bằng Script (Nợ #35, `d1c7cb9f`), và mọi nhánh sau ghim output
/// về đúng địa chỉ input. Vế "đúng script NÀO" thì phải phá vòng tham số mới
/// đóng được — đó là quyết định deploy, không phải việc của validator này.
fn all_shards_start_clean(
  outputs   : List<Output>,
  policy_id : PolicyId,
  id        : Int,
) -> Bool {
  if id >= shard_count {
    True
  } else {
    let name = shard_asset_name(id)
    expect [o] =
      list.filter(outputs, fn(o) { assets.quantity_of(o.value, policy_id, name) == 1 })
    expect InlineDatum(d) = o.datum
    expect sd: ScheduleAggregateShardDatum = d
    and {
      sd.shard_id == id,
      sd.shard_locked_lamp == 0,
      sd.shard_active_count == 0,
      sd.shard_cumulative_committed == 0,
      sd.shard_cumulative_fired == 0,
      sd.shard_cap == shard_cap,
      all_shards_start_clean(outputs, policy_id, id + 1),
    }
  }
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

const sn_policy: PolicyId = #"9999"

fn vk_address(h: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(h), stake_credential: None }
}

fn sn_genesis_ref() -> OutputReference {
  OutputReference { transaction_id: #"aa", output_index: 3 }
}

fn mk_ref(ix: Int) -> OutputReference {
  OutputReference { transaction_id: #"00", output_index: ix }
}

fn sn_input(ref: OutputReference) -> Input {
  Input {
    output_reference: ref,
    output: Output {
      address: vk_address(#"a0"),
      value: assets.from_lovelace(2_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

// Build the canonical mint: 16 NFTs SHARD#0..SHARD#15, qty 1 each.
fn full_shard_mint() -> assets.Value {
  build_mint(assets.zero, 0)
}

fn build_mint(acc: assets.Value, id: Int) -> assets.Value {
  if id >= shard_count {
    acc
  } else {
    build_mint(assets.add(acc, sn_policy, shard_asset_name(id), 1), id + 1)
  }
}

const sn_shard_script: ByteArray =
  #"55555555555555555555555555555555555555555555555555555555"

fn sn_shard_addr() -> Address {
  Address { payment_credential: Script(sn_shard_script), stake_credential: None }
}

fn sn_clean_datum(id: Int) -> ScheduleAggregateShardDatum {
  ScheduleAggregateShardDatum {
    shard_id: id, shard_locked_lamp: 0, shard_active_count: 0,
    shard_cumulative_committed: 0, shard_cumulative_fired: 0,
    last_updated_epoch: 0, shard_cap,
  }
}

fn sn_out(id: Int, d: ScheduleAggregateShardDatum) -> Output {
  Output {
    address: sn_shard_addr(),
    value: assets.add(assets.from_lovelace(2_000_000), sn_policy, shard_asset_name(id), 1),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

/// 16 output sạch, mỗi output một shard.
fn sn_clean_outputs() -> List<Output> {
  build_outs([], 0)
}

fn build_outs(acc: List<Output>, id: Int) -> List<Output> {
  if id >= shard_count {
    acc
  } else {
    build_outs(list.push(acc, sn_out(id, sn_clean_datum(id))), id + 1)
  }
}

/// Như `sn_clean_outputs` nhưng shard `bad_id` mang datum do người deploy bịa.
fn sn_outputs_with(bad_id: Int, bad: ScheduleAggregateShardDatum) -> List<Output> {
  list.map(
    sn_clean_outputs(),
    fn(o) {
      if assets.quantity_of(o.value, sn_policy, shard_asset_name(bad_id)) == 1 {
        Output { ..o, datum: InlineDatum(bad) }
      } else {
        o
      }
    },
  )
}

fn sn_tx(mint: assets.Value, outputs: List<Output>) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: [sn_input(sn_genesis_ref())],
    mint: mint,
    outputs: outputs,
  }
}

// happy: consume genesis, mint exactly the 16 shard NFTs, 16 datum SẠCH.
test shard_nft_happy() {
  shard_nft.mint(sn_genesis_ref(), Void, sn_policy, sn_tx(full_shard_mint(), sn_clean_outputs()))
}

// 🔴 Nợ #33 — người deploy nới trần cho ĐÚNG shard mình muốn.
// `shard_cap` gấp 1000 lần hằng số giao thức: 1/16 số người dùng (những người hash
// vào shard 7) hết bị trần C-SCH-CAP ràng, và không nhánh nào sau đó thấy — chúng
// chỉ kiểm DELTA, không kiểm điểm xuất phát.
test shard_nft_inflated_cap_fail() fail {
  let bad = ScheduleAggregateShardDatum { ..sn_clean_datum(7), shard_cap: shard_cap * 1000 }
  shard_nft.mint(sn_genesis_ref(), Void, sn_policy, sn_tx(full_shard_mint(), sn_outputs_with(7, bad)))
}

// 🔴 Nợ #33 — bộ đếm khởi tạo không sạch: shard mở màn đã "đã cam kết" sẵn một
// khoản, tức sổ tổng bịa ngay từ dòng đầu.
test shard_nft_nonzero_locked_fail() fail {
  let bad = ScheduleAggregateShardDatum { ..sn_clean_datum(3), shard_locked_lamp: 1_000_000 }
  shard_nft.mint(sn_genesis_ref(), Void, sn_policy, sn_tx(full_shard_mint(), sn_outputs_with(3, bad)))
}

// 🔴 Nợ #33 — `shard_id` trong datum không khớp TÊN TÀI SẢN. Trước bản vá, danh
// tính shard nằm ở trường tự khai; nay tên tài sản là trọng tài.
test shard_nft_id_mismatch_fail() fail {
  let bad = sn_clean_datum(9)                       // datum khai id 9…
  shard_nft.mint(sn_genesis_ref(), Void, sn_policy, sn_tx(full_shard_mint(), sn_outputs_with(4, bad)))
}                                                    // …nhưng gắn vào NFT shard 4

// 🔴 Nợ #33 — đúc đủ 16 NFT nhưng KHÔNG đặt output nào cho chúng (giữ lại ở ví
// người deploy, datum viết sau). Trước bản vá đây là đường đi được.
test shard_nft_no_outputs_fail() fail {
  shard_nft.mint(sn_genesis_ref(), Void, sn_policy, sn_tx(full_shard_mint(), []))
}

// fail: genesis UTxO not consumed → re-mint blocked.
test shard_nft_no_genesis() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [sn_input(mk_ref(0))],
      mint: full_shard_mint(),
      outputs: sn_clean_outputs(),
    }
  shard_nft.mint(sn_genesis_ref(), Void, sn_policy, tx)
}

// fail: only 15 of 16 names minted → dict.size mismatch.
test shard_nft_missing_one() fail {
  let m = build_mint(assets.zero, 1)   // ids 1..15, missing 0
  shard_nft.mint(sn_genesis_ref(), Void, sn_policy, sn_tx(m, sn_clean_outputs()))
}

// fail: one shard minted with qty 2 → not a singleton.
test shard_nft_double_qty() fail {
  let m = assets.add(full_shard_mint(), sn_policy, shard_asset_name(0), 1)
  shard_nft.mint(sn_genesis_ref(), Void, sn_policy, sn_tx(m, sn_clean_outputs()))
}

// fail: extra spoofed asset name under same policy → dict.size == 17.
test shard_nft_extra_name() fail {
  let m = assets.add(full_shard_mint(), sn_policy, #"6666", 1)
  shard_nft.mint(sn_genesis_ref(), Void, sn_policy, sn_tx(m, sn_clean_outputs()))
}
