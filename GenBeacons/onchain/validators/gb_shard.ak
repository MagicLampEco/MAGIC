// Bộ đếm `GB_available` — 16 shard spend-decrement (SPEC v2.4 §6.1.3, §13
// `INV-SURPLUS-RATION`, `CC-GEN-SURPLUS-SHARD`).
//
// Mỗi shard là một UTxO mang NFT `(hash script này, "GBS" ‖ shard_id)`, datum `GbShard`.
// Giao dịch sinh (InstantGen) / ký (ScheduleGen) chi ĐÚNG shard của két và trừ ĐÚNG lượng
// cấp. Shard tự đặt lại lười khi thấy beacon GreenBack có `seq` mới hơn.
//
// PHÂN VAI — cái gì ép ở ĐÂY, cái gì két phải ép (validator két nằm ở gói khác):
//   Shard ép:
//     (a) có đúng một beacon GreenBack THẬT trong reference input (NFT + địa chỉ script
//         beacon) và `depeg == False`;
//     (b) đặt lại lười `beacon.seq > shard.seq` ⟹ `remaining = min(⌊GB/16⌋, cap)`;
//     (c) giao dịch tiêu ĐÚNG MỘT két tại một script trong `vault_script_hashes`, két đó
//         mang NFT vault-id dưới policy = hash script của chính nó (INV-VAULT-IDENTITY);
//     (d) output tiếp nối: cùng địa chỉ, cùng value non-ADA (NFT ở lại), cùng `shard_id`,
//         `remaining_out = remaining_eff − amount ≥ 0`, `amount ≥ 0`.
//   Két PHẢI ép (shard KHÔNG ép, và không thể ép):
//     - lượng két cấp == `amount` của redeemer `Draw` trên shard này;
//     - shard này đúng là shard của két (ánh xạ két → shard_id);
//     - trần mỗi-két-mỗi-epoch `⌊reset_amount × gb_vault_share_q / Q⌋` (§6.1.3);
//     - độ tươi beacon (`CC-GEN-BEACON-AGE`) và "không có giao dịch cấp 0";
//     - 🔴 MỌI nhánh két KHÁC nhánh sinh/ký phải TỪ CHỐI giao dịch có tiêu một shard.
//       Shard chỉ thấy "có một két thật đi kèm", không thấy két đi nhánh nào (chỉ số
//       constructor redeemer khác nhau giữa IG và SG). Một nhánh két không biết tới shard
//       (vd `WithdrawLamp`) + `Draw { amount: remaining }` = rút cạn shard mà không sinh
//       gì ⟹ chặn sinh của mọi két khác cùng shard tới lượt ghi beacon sau.
//   Thiếu một vế bên két ⟹ một két rút được shard của két khác hoặc rút mà không sinh.

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use aiken/interval
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, placeholder,
}
use genbeacons/constants
use genbeacons/greenback
use genbeacons/shard
use genbeacons/types.{Draw, GbShard, GbShardRedeemer, GreenBackBeacon}
use genbeacons/util

/// Apply-param (theo thứ tự):
///   gb_beacon_nft_policy  : policy NFT beacon GreenBack (= hash script `greenback_beacon`
///                           theo hình dạng mint-trong-validator của module này).
///   gb_beacon_script_hash : hash script `greenback_beacon`.
///   vault_script_hashes   : hash script két được phép rút (InstantGen + ScheduleGen).
///   gb_shard_cap_nanogic  : trần mỗi shard mỗi lần đặt lại. TẠM 1_800_000_000_000_000
///                           (`CC-GEN-SURPLUS-SHARD`, SPEC §6.1.3 dẫn xuất ở suất tạm).
///   seed                  : OutputReference neo policy NFT one-shot của 16 shard.
validator gb_shard(
  gb_beacon_nft_policy: PolicyId,
  gb_beacon_script_hash: ScriptHash,
  vault_script_hashes: List<ScriptHash>,
  gb_shard_cap_nanogic: Int,
  seed: OutputReference,
) {
  // Genesis: đúc đúng 16 NFT "GBS" ‖ 0..15, mỗi cái vào một output tại chính script,
  // datum `{ shard_id, 0, 0, 0 }` khớp tên NFT. Shard mở ở `remaining == 0` và chỉ có
  // lượng rút sau lượt ghi beacon đầu tiên có `seq > 0` (fail-closed).
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    expect gb_shard_cap_nanogic >= 0
    expect list.any(tx.inputs, fn(i) { i.output_reference == seed })
    let ids = list.range(0, constants.shard_count - 1)
    expect
      dict.to_pairs(assets.tokens(tx.mint, policy_id)) == list.map(
        ids,
        fn(i) { Pair(constants.shard_nft_name(i), 1) },
      )
    let outs =
      list.filter(tx.outputs, fn(o) { util.is_at_script(o.address, policy_id) })
    expect list.length(outs) == constants.shard_count
    list.all(outs, fn(o) { genesis_shard_ok(o, policy_id) })
  }

  spend(
    datum_opt: Option<GbShard>,
    redeemer: GbShardRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(s_in) = datum_opt
    expect gb_shard_cap_nanogic >= 0
    let Draw { amount } = redeemer
    expect amount >= 0
    let (_, next) =
      util.continuing_pair(
        own_ref,
        tx,
        constants.shard_nft_name(s_in.shard_id),
      )
    let beacon =
      greenback.read_greenback(
        tx.reference_inputs,
        gb_beacon_nft_policy,
        gb_beacon_script_hash,
      )
    expect !beacon.depeg // MUT-DEPEG
    expect exactly_one_vault(tx.inputs, vault_script_hashes) // MUT-COSPEND
    let eff = shard.lazy_reset(s_in, beacon, gb_shard_cap_nanogic)
    expect InlineDatum(d) = next.datum
    expect s_out: GbShard = d
    let remaining_out = eff.remaining - amount
    and {
      remaining_out >= 0,
      // So NGUYÊN bản ghi: ghim `shard_id`, `seq`, `reset_amount` cùng lúc.
      s_out == GbShard { ..eff, remaining: remaining_out },
    }
  }

  else(_) {
    fail
  }
}

/// Đúng MỘT input nằm tại một script két được phép, và input đó mang ĐÚNG MỘT token số
/// lượng 1 dưới policy = hash script của chính nó (NFT vault-id, INV-VAULT-IDENTITY).
/// Đếm MỌI input tại script két (có NFT hay không) ⟹ hai két, hoặc một két kèm một UTxO
/// lạc tại địa chỉ két, đều bị từ chối — một output shard không thoả được cho hai két.
fn exactly_one_vault(inputs: List<Input>, vault_script_hashes: List<ScriptHash>) -> Bool {
  let vaults =
    list.filter(
      inputs,
      fn(i) {
        when i.output.address.payment_credential is {
          Script(h) -> list.has(vault_script_hashes, h)
          _ -> False
        }
      },
    )
  when vaults is {
    [v] -> {
      expect Script(h) = v.output.address.payment_credential
      when dict.to_pairs(assets.tokens(v.output.value, h)) is {
        [Pair(_, 1)] -> True
        _ -> False
      }
    }
    _ -> False
  }
}

fn genesis_shard_ok(o: Output, policy_id: PolicyId) -> Bool {
  expect InlineDatum(d) = o.datum
  expect s: GbShard = d
  and {
    o.address == util.script_address(policy_id),
    s.shard_id >= 0,
    s.shard_id < constants.shard_count,
    s.seq == 0,
    s.reset_amount == 0,
    s.remaining == 0,
    assets.without_lovelace(o.value) == assets.from_asset(
      policy_id,
      constants.shard_nft_name(s.shard_id),
      1,
    ),
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

const sh_sh: ByteArray = #"5a5a5a"

// Policy NFT beacon và script beacon cố ý KHÁC nhau trong test: bài "beacon ở script
// khác" chỉ phân biệt được khi hai hằng không trùng.
const sh_gb_policy: ByteArray = #"9b9b9b"

const sh_gb_script: ByteArray = #"9c9c9c"

const sh_vault_a: ByteArray = #"7a0001"

const sh_vault_b: ByteArray = #"7a0002"

const sh_vaults: List<ByteArray> = [sh_vault_a, sh_vault_b]

const sh_cap: Int = 1_800_000_000_000_000

const sh_seed: OutputReference = OutputReference {
  transaction_id: #"5eed03",
  output_index: 2,
}

fn sh_beacon_at(addr: Address, b: GreenBackBeacon) -> Input {
  util.mk_input(
    util.mk_ref(#"be", 0),
    util.mk_output(
      addr,
      assets.add(
        assets.from_lovelace(2_000_000),
        sh_gb_policy,
        constants.greenback_nft_name,
        1,
      ),
      b,
    ),
  )
}

fn sh_beacon(gb: Int, seq: Int, depeg: Bool) -> Input {
  sh_beacon_at(
    util.script_address(sh_gb_script),
    GreenBackBeacon { gb_nanogic: gb, seq: seq, epoch: 7, depeg: depeg },
  )
}

fn sh_vault(h: ByteArray, with_nft: Bool, ix: Int) -> Input {
  let v =
    if with_nft {
      assets.add(assets.from_lovelace(5_000_000), h, #"abcdef", 1)
    } else {
      assets.from_lovelace(5_000_000)
    }
  util.mk_input(
    util.mk_ref(#"0a", ix),
    util.mk_output(util.script_address(h), v, Void),
  )
}

fn sh_value(id: Int) -> assets.Value {
  assets.add(
    assets.from_lovelace(2_000_000),
    sh_sh,
    constants.shard_nft_name(id),
    1,
  )
}

fn sh_tx(
  refs: List<Input>,
  vaults: List<Input>,
  s_in: GbShard,
  s_out: GbShard,
) -> Transaction {
  let shard_in =
    util.mk_input(
      util.mk_ref(#"00", 0),
      util.mk_output(util.script_address(sh_sh), sh_value(s_in.shard_id), s_in),
    )
  Transaction {
    ..placeholder,
    inputs: [shard_in, ..vaults],
    reference_inputs: refs,
    outputs: [
      util.mk_output(util.script_address(sh_sh), sh_value(s_in.shard_id), s_out),
    ],
    validity_range: interval.between(7 * 86_400_000, 7 * 86_400_000 + 1),
  }
}

fn sh_spend(s_in: GbShard, amount: Int, tx: Transaction) -> Bool {
  gb_shard.spend(
    sh_gb_policy,
    sh_gb_script,
    sh_vaults,
    sh_cap,
    sh_seed,
    Some(s_in),
    Draw { amount },
    util.mk_ref(#"00", 0),
    tx,
  )
}

// Fixture chung: shard 3, seq 5, còn 1000. Beacon seq 5, GB = 48000 (nếu đặt lại sẽ ra
// 3000 — khác 1000, để phân biệt "có đặt lại" với "không đặt lại").
const sh_in: GbShard =
  GbShard { shard_id: 3, seq: 5, reset_amount: 1_000, remaining: 1_000 }

const sh_out_ok: GbShard =
  GbShard { shard_id: 3, seq: 5, reset_amount: 1_000, remaining: 600 }

fn sh_ok_refs() -> List<Input> {
  [sh_beacon(48_000, 5, False)]
}

fn sh_ok_vaults() -> List<Input> {
  [sh_vault(sh_vault_a, True, 1)]
}

test shard_draw_happy() {
  sh_spend(sh_in, 400, sh_tx(sh_ok_refs(), sh_ok_vaults(), sh_in, sh_out_ok))
}

test shard_draw_schedule_vault_happy() {
  // Két ở script được phép THỨ HAI (ScheduleGen).
  sh_spend(
    sh_in,
    400,
    sh_tx(sh_ok_refs(), [sh_vault(sh_vault_b, True, 1)], sh_in, sh_out_ok),
  )
}

test shard_draw_exact_remaining_happy() {
  sh_spend(
    sh_in,
    1_000,
    sh_tx(
      sh_ok_refs(),
      sh_ok_vaults(),
      sh_in,
      GbShard { ..sh_out_ok, remaining: 0 },
    ),
  )
}

test shard_draw_over_remaining_fail() fail {
  sh_spend(
    sh_in,
    1_001,
    sh_tx(
      sh_ok_refs(),
      sh_ok_vaults(),
      sh_in,
      GbShard { ..sh_out_ok, remaining: -1 },
    ),
  )
}

test shard_draw_negative_fail() fail {
  // amount âm ⟹ "rút" thành NẠP: remaining 1000 → 1001.
  sh_spend(
    sh_in,
    -1,
    sh_tx(
      sh_ok_refs(),
      sh_ok_vaults(),
      sh_in,
      GbShard { ..sh_out_ok, remaining: 1_001 },
    ),
  )
}

test shard_remaining_mismatch_amount_fail() fail {
  // Khai rút 400 nhưng output chỉ trừ 100.
  sh_spend(
    sh_in,
    400,
    sh_tx(
      sh_ok_refs(),
      sh_ok_vaults(),
      sh_in,
      GbShard { ..sh_out_ok, remaining: 900 },
    ),
  )
}

// ── (a) beacon ────────────────────────────────────────────────────────────────

test shard_no_beacon_fail() fail {
  sh_spend(sh_in, 400, sh_tx([], sh_ok_vaults(), sh_in, sh_out_ok))
}

test shard_beacon_depeg_fail() fail {
  sh_spend(
    sh_in,
    400,
    sh_tx([sh_beacon(48_000, 5, True)], sh_ok_vaults(), sh_in, sh_out_ok),
  )
}

test shard_beacon_other_script_fail() fail {
  // Cùng NFT thật, datum hợp lệ, nhưng UTxO nằm ở script KHÁC script beacon.
  let b =
    sh_beacon_at(
      util.script_address(#"dddddd"),
      GreenBackBeacon { gb_nanogic: 48_000, seq: 5, epoch: 7, depeg: False },
    )
  sh_spend(sh_in, 400, sh_tx([b], sh_ok_vaults(), sh_in, sh_out_ok))
}

test shard_beacon_at_wallet_fail() fail {
  let b =
    sh_beacon_at(
      util.vk_address(#"e1e1e1"),
      GreenBackBeacon { gb_nanogic: 48_000, seq: 5, epoch: 7, depeg: False },
    )
  sh_spend(sh_in, 400, sh_tx([b], sh_ok_vaults(), sh_in, sh_out_ok))
}

test shard_two_beacons_valid_first_fail() fail {
  // Beacon HỢP LỆ đứng TRƯỚC — thứ tự này là phần gánh tải: đảo lại thì bài đỏ ở chốt
  // địa chỉ thay vì chốt "đúng một beacon".
  let fake =
    sh_beacon_at(
      util.vk_address(#"e1e1e1"),
      GreenBackBeacon { gb_nanogic: 48_000, seq: 5, epoch: 7, depeg: False },
    )
  sh_spend(
    sh_in,
    400,
    sh_tx([sh_beacon(48_000, 5, False), fake], sh_ok_vaults(), sh_in, sh_out_ok),
  )
}

// ── (b) đặt lại lười ──────────────────────────────────────────────────────────

const sh_in_stale: GbShard =
  GbShard { shard_id: 3, seq: 4, reset_amount: 1_000, remaining: 10 }

test shard_lazy_reset_happy() {
  // beacon.seq 5 > shard.seq 4 ⟹ eff = {3, 5, 3000, 3000} rồi trừ 400.
  sh_spend(
    sh_in_stale,
    400,
    sh_tx(
      sh_ok_refs(),
      sh_ok_vaults(),
      sh_in_stale,
      GbShard { shard_id: 3, seq: 5, reset_amount: 3_000, remaining: 2_600 },
    ),
  )
}

test shard_lazy_reset_capped_happy() {
  let gb = sh_cap * 16 * 3
  sh_spend(
    sh_in_stale,
    400,
    sh_tx(
      [sh_beacon(gb, 5, False)],
      sh_ok_vaults(),
      sh_in_stale,
      GbShard { shard_id: 3, seq: 5, reset_amount: sh_cap, remaining: sh_cap - 400 },
    ),
  )
}

test shard_lazy_reset_skipped_fail() fail {
  // Có beacon mới mà output giữ trạng thái cũ (không đặt lại).
  sh_spend(
    sh_in_stale,
    5,
    sh_tx(
      sh_ok_refs(),
      sh_ok_vaults(),
      sh_in_stale,
      GbShard { shard_id: 3, seq: 4, reset_amount: 1_000, remaining: 5 },
    ),
  )
}

test shard_lazy_reset_accumulates_fail() fail {
  // Đặt lại mà CỘNG DỒN phần còn lại cũ (3000 + 10) thay vì ghi đè.
  sh_spend(
    sh_in_stale,
    400,
    sh_tx(
      sh_ok_refs(),
      sh_ok_vaults(),
      sh_in_stale,
      GbShard { shard_id: 3, seq: 5, reset_amount: 3_000, remaining: 2_610 },
    ),
  )
}

test shard_same_seq_no_reset_fail() fail {
  // beacon.seq == shard.seq ⟹ KHÔNG được đặt lại dù GB đủ cho 3000.
  sh_spend(
    sh_in,
    400,
    sh_tx(
      sh_ok_refs(),
      sh_ok_vaults(),
      sh_in,
      GbShard { shard_id: 3, seq: 5, reset_amount: 3_000, remaining: 2_600 },
    ),
  )
}

// ── (c) két đi kèm ────────────────────────────────────────────────────────────

test shard_no_vault_fail() fail {
  sh_spend(sh_in, 400, sh_tx(sh_ok_refs(), [], sh_in, sh_out_ok))
}

test shard_vault_without_nft_fail() fail {
  sh_spend(
    sh_in,
    400,
    sh_tx(sh_ok_refs(), [sh_vault(sh_vault_a, False, 1)], sh_in, sh_out_ok),
  )
}

test shard_two_vaults_fail() fail {
  sh_spend(
    sh_in,
    400,
    sh_tx(
      sh_ok_refs(),
      [sh_vault(sh_vault_a, True, 1), sh_vault(sh_vault_b, True, 2)],
      sh_in,
      sh_out_ok,
    ),
  )
}

test shard_vault_not_allowed_script_fail() fail {
  sh_spend(
    sh_in,
    400,
    sh_tx(sh_ok_refs(), [sh_vault(#"7a0003", True, 1)], sh_in, sh_out_ok),
  )
}

// ── (d) output tiếp nối ───────────────────────────────────────────────────────

test shard_id_changed_fail() fail {
  sh_spend(
    sh_in,
    400,
    sh_tx(
      sh_ok_refs(),
      sh_ok_vaults(),
      sh_in,
      GbShard { ..sh_out_ok, shard_id: 4 },
    ),
  )
}

test shard_nft_leaves_fail() fail {
  let base = sh_tx(sh_ok_refs(), sh_ok_vaults(), sh_in, sh_out_ok)
  let tx =
    Transaction {
      ..base,
      outputs: [
        util.mk_output(
          util.script_address(sh_sh),
          assets.from_lovelace(2_000_000),
          sh_out_ok,
        ),
        util.mk_output_no_datum(util.vk_address(#"e1e1e1"), sh_value(3)),
      ],
    }
  sh_spend(sh_in, 400, tx)
}

// ── Genesis (mint 16 shard) ───────────────────────────────────────────────────

fn sh_genesis_tx(outs: List<Output>, spend_seed: Bool) -> Transaction {
  let seed_in =
    util.mk_input(
      if spend_seed {
        sh_seed
      } else {
        util.mk_ref(#"0bad", 0)
      },
      util.mk_output_no_datum(
        util.vk_address(#"e1e1e1"),
        assets.from_lovelace(90_000_000),
      ),
    )
  let minted =
    list.foldl(
      list.range(0, constants.shard_count - 1),
      assets.zero,
      fn(i, acc) { assets.add(acc, sh_sh, constants.shard_nft_name(i), 1) },
    )
  Transaction { ..placeholder, inputs: [seed_in], outputs: outs, mint: minted }
}

fn sh_genesis_out(id: Int, remaining: Int) -> Output {
  util.mk_output(
    util.script_address(sh_sh),
    sh_value(id),
    GbShard { shard_id: id, seq: 0, reset_amount: 0, remaining: remaining },
  )
}

fn sh_genesis_outs() -> List<Output> {
  list.map(list.range(0, 15), fn(i) { sh_genesis_out(i, 0) })
}

fn sh_mint(tx: Transaction) -> Bool {
  gb_shard.mint(sh_gb_policy, sh_gb_script, sh_vaults, sh_cap, sh_seed, Void, sh_sh, tx)
}

test shard_genesis_happy() {
  sh_mint(sh_genesis_tx(sh_genesis_outs(), True))
}

test shard_genesis_no_seed_fail() fail {
  sh_mint(sh_genesis_tx(sh_genesis_outs(), False))
}

test shard_genesis_nonzero_remaining_fail() fail {
  let outs =
    list.map(
      list.range(0, 15),
      fn(i) {
        if i == 7 {
          sh_genesis_out(i, 1)
        } else {
          sh_genesis_out(i, 0)
        }
      },
    )
  sh_mint(sh_genesis_tx(outs, True))
}

test shard_genesis_nft_to_wallet_fail() fail {
  // Shard 15 đi ra ví: chỉ 15 output tại script.
  let outs =
    list.map(
      list.range(0, 15),
      fn(i) {
        if i == 15 {
          util.mk_output_no_datum(util.vk_address(#"e1e1e1"), sh_value(15))
        } else {
          sh_genesis_out(i, 0)
        }
      },
    )
  sh_mint(sh_genesis_tx(outs, True))
}

test shard_genesis_id_name_mismatch_fail() fail {
  // Output mang NFT shard 2 nhưng datum khai shard_id 5.
  let outs =
    list.map(
      list.range(0, 15),
      fn(i) {
        if i == 2 {
          util.mk_output(
            util.script_address(sh_sh),
            sh_value(2),
            GbShard { shard_id: 5, seq: 0, reset_amount: 0, remaining: 0 },
          )
        } else {
          sh_genesis_out(i, 0)
        }
      },
    )
  sh_mint(sh_genesis_tx(outs, True))
}
