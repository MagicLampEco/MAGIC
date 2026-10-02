// Sổ script két được phép đồng tiêu với shard GB (`VaultRegistry`).
//
// VÌ SAO CÓ VALIDATOR NÀY — gỡ vòng apply-param. Bản trước bake danh sách hash két vào
// apply-param của `gb_shard`, trong khi két InstantGen/ScheduleGen bake `gb_shard_policy_id`
// (= hash script `gb_shard`, vì mint gộp vào cùng validator). Hai hash phụ thuộc nhau ⟹ đòi
// điểm bất động của blake2b ⟹ không bộ hash nào nhất quán ⟹ không deploy được. Nay shard
// chỉ bake policy của SỔ (chỉ phụ thuộc `seed`), và tìm danh sách két lúc chạy qua
// reference input.
//
// THỨ TỰ DEPLOY (không còn vòng):
//   1. chọn `seed` cho sổ ⟹ hash `vault_registry` (= policy NFT "VRG"). CHƯA đúc.
//   2. `gb_shard(…, vault_registry_policy = hash bước 1, …)` ⟹ hash shard.
//   3. két InstantGen / ScheduleGen apply `gb_shard_policy_id = hash bước 2` ⟹ hash két.
//   4. đúc sổ: tiêu `seed`, datum `VaultRegistry { [hash két bước 3] }`.
//   Giữa bước 1 và 4, UTxO `seed` PHẢI còn chưa tiêu — tiêu nhầm là policy sổ chết, phải
//   dựng lại từ bước 1. Trước bước 4, mọi lượt rút shard bị từ chối (không có sổ ⟹
//   fail-closed).
//
// Bất biến validator ép:
//   - mint one-shot (`seed` tiêu một lần): đúng MỘT NFT `(hash script này, "VRG")`, output
//     mang NFT nằm tại chính script, KHÔNG stake credential, non-ADA chỉ có NFT đó;
//   - datum inline `VaultRegistry`, danh sách không rỗng, không trùng, mỗi phần tử 28 byte;
//   - spend LUÔN từ chối ⟹ NFT không rời địa chỉ, datum không đổi, không đốt được.
// KHÔNG ép (không ép được ở đây): danh sách đúng là hash két THẬT. Đó là lời khai của bên
// giữ `seed` lúc đúc — đối chiếu với blueprint đã apply trước khi đúc (bước 4).
//
// Đổi danh sách (thêm loại két) = seed MỚI ⟹ sổ MỚI ⟹ `gb_shard` MỚI ⟹ két MỚI (vì két
// bake hash shard). Trước deploy: khả hồi. Sau deploy: quyết định vận hành.

use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, OutputReference, Transaction, placeholder}
use genbeacons/constants
use genbeacons/registry
use genbeacons/types.{VaultRegistry}
use genbeacons/util

/// Apply-param:
///   seed : OutputReference neo policy NFT one-shot (policy = hash script này).
validator vault_registry(seed: OutputReference) {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    let out =
      util.genesis_single(
        tx,
        policy_id,
        seed,
        constants.vault_registry_nft_name,
      )
    expect InlineDatum(d) = out.datum
    expect r: VaultRegistry = d
    registry.vault_list_ok(r.vault_script_hashes)
  }

  // Sổ bất biến: không nhánh tiêu nào.
  spend(
    _datum_opt: Option<Data>,
    _redeemer: Data,
    _own_ref: OutputReference,
    _tx: Transaction,
  ) {
    fail
  }

  else(_) {
    fail
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

const vr_sh: ByteArray = #"8d8d8d"

const vr_seed: OutputReference =
  OutputReference { transaction_id: #"5eed04", output_index: 3 }

// Hash két 28 byte (độ dài thật của blake2b-224).
const vr_h1: ByteArray =
  #"7a000000000000000000000000000000000000000000000000000001"

const vr_h2: ByteArray =
  #"7a000000000000000000000000000000000000000000000000000002"

// 27 byte và 29 byte — khác vr_h1 để bài độ dài không trùng bài trùng lặp.
const vr_h27: ByteArray =
  #"7a0000000000000000000000000000000000000000000000000003"

const vr_h29: ByteArray =
  #"7a00000000000000000000000000000000000000000000000000000004"

fn vr_nft_value(qty: Int) -> assets.Value {
  assets.add(
    assets.from_lovelace(2_000_000),
    vr_sh,
    constants.vault_registry_nft_name,
    qty,
  )
}

fn vr_out(datum: Data) -> transaction.Output {
  util.mk_output(util.script_address(vr_sh), vr_nft_value(1), datum)
}

fn vr_tx_full(
  outs: List<transaction.Output>,
  spend_seed: Bool,
  minted: assets.Value,
) -> Transaction {
  let seed_in =
    util.mk_input(
      if spend_seed {
        vr_seed
      } else {
        util.mk_ref(#"0bad", 0)
      },
      util.mk_output_no_datum(
        util.vk_address(#"e1e1e1"),
        assets.from_lovelace(10_000_000),
      ),
    )
  Transaction { ..placeholder, inputs: [seed_in], outputs: outs, mint: minted }
}

fn vr_one() -> assets.Value {
  assets.from_asset(vr_sh, constants.vault_registry_nft_name, 1)
}

fn vr_tx(hashes: List<ByteArray>) -> Transaction {
  vr_tx_full(
    [vr_out(VaultRegistry { vault_script_hashes: hashes })],
    True,
    vr_one(),
  )
}

fn vr_mint(tx: Transaction) -> Bool {
  vault_registry.mint(vr_seed, Void, vr_sh, tx)
}

test registry_mint_happy() {
  vr_mint(vr_tx([vr_h1, vr_h2]))
}

test registry_mint_single_happy() {
  vr_mint(vr_tx([vr_h1]))
}

test registry_mint_no_seed_fail() fail {
  vr_mint(
    vr_tx_full(
      [vr_out(VaultRegistry { vault_script_hashes: [vr_h1, vr_h2] })],
      False,
      vr_one(),
    ),
  )
}

test registry_mint_empty_fail() fail {
  vr_mint(vr_tx([]))
}

test registry_mint_duplicate_fail() fail {
  // Hai phần tử đều 28 byte, không rỗng ⟹ chỉ vế "không trùng" chặn.
  vr_mint(vr_tx([vr_h1, vr_h2, vr_h1]))
}

test registry_mint_short_hash_fail() fail {
  vr_mint(vr_tx([vr_h1, vr_h27]))
}

test registry_mint_long_hash_fail() fail {
  vr_mint(vr_tx([vr_h29, vr_h1]))
}

test registry_mint_bad_datum_fail() fail {
  vr_mint(vr_tx_full([vr_out(42)], True, vr_one()))
}

test registry_mint_to_wallet_fail() fail {
  let out =
    util.mk_output(
      util.vk_address(#"e1e1e1"),
      vr_nft_value(1),
      VaultRegistry { vault_script_hashes: [vr_h1] },
    )
  vr_mint(vr_tx_full([out], True, vr_one()))
}

test registry_mint_two_units_fail() fail {
  // Đúc 2 đơn vị ⟹ hai "sổ" có thể tồn tại cùng lúc.
  let out =
    util.mk_output(
      util.script_address(vr_sh),
      vr_nft_value(2),
      VaultRegistry { vault_script_hashes: [vr_h1] },
    )
  vr_mint(
    vr_tx_full(
      [out],
      True,
      assets.from_asset(vr_sh, constants.vault_registry_nft_name, 2),
    ),
  )
}

test registry_mint_wrong_name_fail() fail {
  let bad = assets.from_asset(vr_sh, #"585858", 1)
  let out =
    util.mk_output(
      util.script_address(vr_sh),
      assets.merge(assets.from_lovelace(2_000_000), bad),
      VaultRegistry { vault_script_hashes: [vr_h1] },
    )
  vr_mint(vr_tx_full([out], True, bad))
}

test registry_spend_always_fail() fail {
  // Tiêu sổ hợp lệ, đủ chữ ký, output tiếp nối y hệt — vẫn từ chối.
  let d: Data = VaultRegistry { vault_script_hashes: [vr_h1, vr_h2] }
  let reg_in = util.mk_input(util.mk_ref(#"00", 0), vr_out(d))
  let tx =
    Transaction {
      ..placeholder,
      inputs: [reg_in],
      outputs: [vr_out(d)],
      extra_signatories: [#"e1e1e1"],
    }
  vault_registry.spend(vr_seed, Some(d), Void, util.mk_ref(#"00", 0), tx)
}

// ══════════════════════════════════════════════════════════════════════════════
// Cổng `reference_script == None` (rà 2026-10-02) — cặp dương/âm
// ══════════════════════════════════════════════════════════════════════════════
// Ca dương: đầu ra script giữ `None`, ref-script nằm ở một output VÍ khác ⟹ qua (cổng
// chỉ soi đầu ra của chính script). Ca âm: CÙNG giao dịch, ref-script gắn vào đầu ra
// script ⟹ từ chối. Hai ca chỉ khác đúng một trường, nên ca âm đỏ được vì cổng này chứ
// không vì chốt nào khác.

const woc_ref_script: ByteArray =
  #"5c0000000000000000000000000000000000000000000000000000ff"

test registry_mint_ref_script_elsewhere_ok() {
  vr_mint(util.with_wallet_ref_script_output(vr_tx([vr_h1, vr_h2]), woc_ref_script))
}

test registry_mint_ref_script_fail() fail {
  vr_mint(util.with_ref_script_at(vr_tx([vr_h1, vr_h2]), vr_sh, woc_ref_script))
}
