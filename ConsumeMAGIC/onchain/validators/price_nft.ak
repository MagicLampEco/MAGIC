// PriceParam authenticity NFT — minting policy ONE-SHOT (CONTRACT.md §B1).
//
// Beacon UTxO PriceParam cần đúng 1 authenticity NFT để chống datum hijacking:
// kẻ tấn công tạo UTxO giả tại beacon address với datum giá bịa, nhưng KHÔNG
// mint được NFT này → consume validator chỉ tin UTxO mang NFT (xác thực policy).
//
// FIRST-PRINCIPLES one-shot: policy parameterized bởi 1 genesis OutputReference.
// 1 UTxO spend tối đa 1 lần → policy chạy tối đa 1 lần → supply NFT cố định, KHÔNG
// re-mint, KHÔNG burn (else(_) fail chặn mọi mint âm + purpose khác).

use aiken/collection/dict
use aiken/collection/list
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction, placeholder}
use magiclamp/consume/types.{MintGenesis, NftRedeemer}
use magiclamp/consume/util

/// Asset name của PriceParam beacon NFT = "PRICE".
pub const price_nft_name: ByteArray = #"5052494345"

validator price_nft(genesis_ref: OutputReference) {
  mint(_redeemer: NftRedeemer, policy_id: PolicyId, tx: Transaction) {
    // ONE-SHOT: phải consume đúng UTxO genesis.
    expect list.any(tx.inputs, fn(i) { i.output_reference == genesis_ref })

    // Mint chứa ĐÚNG 1 asset name của policy này, qty +1 (không thừa, không âm).
    let own_tokens = assets.tokens(tx.mint, policy_id)
    expect dict.size(own_tokens) == 1
    expect assets.quantity_of(tx.mint, policy_id, price_nft_name) == 1
    True
  }

  else(_) {
    fail
  }
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

const pn_policy: PolicyId = #"9999"

fn pn_genesis_ref() -> OutputReference {
  util.mk_ref_id(#"aa", 3)
}

fn pn_genesis_input() {
  util.mk_input(
    pn_genesis_ref(),
    util.mk_output_no_datum(util.vk_address(#"a0"), assets.from_lovelace(2_000_000)),
  )
}

test price_nft_happy() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [pn_genesis_input()],
      mint: assets.from_asset(pn_policy, price_nft_name, 1),
    }
  price_nft.mint(pn_genesis_ref(), MintGenesis, pn_policy, tx)
}

test price_nft_no_genesis() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [
        util.mk_input(
          util.mk_ref(0),
          util.mk_output_no_datum(util.vk_address(#"a0"), assets.from_lovelace(2_000_000)),
        ),
      ],
      mint: assets.from_asset(pn_policy, price_nft_name, 1),
    }
  price_nft.mint(pn_genesis_ref(), MintGenesis, pn_policy, tx)
}

test price_nft_wrong_qty() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [pn_genesis_input()],
      mint: assets.from_asset(pn_policy, price_nft_name, 2),
    }
  price_nft.mint(pn_genesis_ref(), MintGenesis, pn_policy, tx)
}
