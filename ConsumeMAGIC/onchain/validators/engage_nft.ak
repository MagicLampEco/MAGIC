// Engage thread NFT — minting policy ONE-SHOT (CONTRACT.md §B2 C-CM-4).
//
// Mỗi Engage UTxO (state per-app do consume.ak quản) cần ĐÚNG 1 thread NFT
// one-shot để chống replay/UTxO giả: consume.ak ép mỗi output@engage mang đúng 1
// NFT (engage_nft_policy/name) + bảo toàn Σ NFT in==out. Không có policy này thì
// C-CM-4 KHÔNG thể khởi tạo (genesis Engage UTxO không có thread token thật) → kẻ
// tấn công bịa EngageDatum tại consume address với UTxO không NFT, làm nhiễu
// consumed_count (attribution Governance C1/C3).
//
// FIRST-PRINCIPLES one-shot (giống price_nft.ak): policy parameterized bởi 1 genesis
// OutputReference RIÊNG (khác genesis của price_nft → 2 policy id phân biệt). 1 UTxO
// spend tối đa 1 lần → policy chạy tối đa 1 lần → supply NFT cố định, KHÔNG re-mint,
// KHÔNG burn (else(_) fail chặn mọi mint âm + purpose khác).
//
// LƯU Ý deploy: nếu cần N Engage UTxO (N app/owner) thì hoặc (a) mỗi engage 1 policy
// one-shot riêng (genesis_ref riêng) — đảm bảo tuyệt đối tính duy nhất per-thread;
// hoặc (b) 1 policy phát 1 NFT name duy nhất cho 1 thread. MVP: 1 thread / 1 policy
// (consume.ak parameterized bởi 1 cặp engage_nft_policy/name → 1 deploy / 1 thread).

use aiken/collection/dict
use aiken/collection/list
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction, placeholder}
use magiclamp/consume/types.{MintGenesis, NftRedeemer}
use magiclamp/consume/util

/// Asset name của Engage thread NFT = "ENG" (khớp consume.ak ct_engage_name).
pub const engage_nft_name: ByteArray = #"454e47"

validator engage_nft(genesis_ref: OutputReference) {
  mint(_redeemer: NftRedeemer, policy_id: PolicyId, tx: Transaction) {
    // ONE-SHOT: phải consume đúng UTxO genesis.
    expect list.any(tx.inputs, fn(i) { i.output_reference == genesis_ref })

    // Mint chứa ĐÚNG 1 asset name của policy này, qty +1 (không thừa, không âm).
    let own_tokens = assets.tokens(tx.mint, policy_id)
    expect dict.size(own_tokens) == 1
    expect assets.quantity_of(tx.mint, policy_id, engage_nft_name) == 1
    True
  }

  else(_) {
    fail
  }
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

const en_policy: PolicyId = #"7777"

fn en_genesis_ref() -> OutputReference {
  util.mk_ref_id(#"ee", 7)
}

fn en_genesis_input() {
  util.mk_input(
    en_genesis_ref(),
    util.mk_output_no_datum(util.vk_address(#"a0"), assets.from_lovelace(2_000_000)),
  )
}

test engage_nft_happy() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [en_genesis_input()],
      mint: assets.from_asset(en_policy, engage_nft_name, 1),
    }
  engage_nft.mint(en_genesis_ref(), MintGenesis, en_policy, tx)
}

test engage_nft_no_genesis() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [
        util.mk_input(
          util.mk_ref(0),
          util.mk_output_no_datum(util.vk_address(#"a0"), assets.from_lovelace(2_000_000)),
        ),
      ],
      mint: assets.from_asset(en_policy, engage_nft_name, 1),
    }
  engage_nft.mint(en_genesis_ref(), MintGenesis, en_policy, tx)
}

test engage_nft_wrong_qty() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [en_genesis_input()],
      mint: assets.from_asset(en_policy, engage_nft_name, 2),
    }
  engage_nft.mint(en_genesis_ref(), MintGenesis, en_policy, tx)
}

test engage_nft_extra_name_fail() fail {
  // mint NFT đúng + 1 token thừa cùng policy → dict.size != 1 → fail.
  let v = assets.add(
    assets.from_asset(en_policy, engage_nft_name, 1),
    en_policy, #"6578747261", 1,
  )
  let tx = Transaction { ..placeholder, inputs: [en_genesis_input()], mint: v }
  engage_nft.mint(en_genesis_ref(), MintGenesis, en_policy, tx)
}
