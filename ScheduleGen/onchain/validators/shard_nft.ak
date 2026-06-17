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
use cardano/transaction.{
  Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}
use magiclamp/protocol/constants.{shard_count}
use magiclamp/protocol/math.{shard_asset_name}

validator shard_nft(genesis_ref: OutputReference) {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    // ── ONE-SHOT: must consume the exact genesis UTxO ──────────────────────
    expect list.any(tx.inputs, fn(i) { i.output_reference == genesis_ref })

    // ── Exactly 16 distinct asset names under this policy, qty +1 each ──────
    let own_tokens = assets.tokens(tx.mint, policy_id)
    expect dict.size(own_tokens) == shard_count
    expect all_shard_names_minted(tx.mint, policy_id, 0)
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

// happy: consume genesis, mint exactly the 16 shard NFTs.
test shard_nft_happy() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [sn_input(sn_genesis_ref())],
      mint: full_shard_mint(),
    }
  shard_nft.mint(sn_genesis_ref(), Void, sn_policy, tx)
}

// fail: genesis UTxO not consumed → re-mint blocked.
test shard_nft_no_genesis() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [sn_input(mk_ref(0))],
      mint: full_shard_mint(),
    }
  shard_nft.mint(sn_genesis_ref(), Void, sn_policy, tx)
}

// fail: only 15 of 16 names minted → dict.size mismatch.
test shard_nft_missing_one() fail {
  let m = build_mint(assets.zero, 1)   // ids 1..15, missing 0
  let tx =
    Transaction { ..placeholder, inputs: [sn_input(sn_genesis_ref())], mint: m }
  shard_nft.mint(sn_genesis_ref(), Void, sn_policy, tx)
}

// fail: one shard minted with qty 2 → not a singleton.
test shard_nft_double_qty() fail {
  let m = assets.add(full_shard_mint(), sn_policy, shard_asset_name(0), 1)
  let tx =
    Transaction { ..placeholder, inputs: [sn_input(sn_genesis_ref())], mint: m }
  shard_nft.mint(sn_genesis_ref(), Void, sn_policy, tx)
}

// fail: extra spoofed asset name under same policy → dict.size == 17.
test shard_nft_extra_name() fail {
  let m = assets.add(full_shard_mint(), sn_policy, #"6666", 1)
  let tx =
    Transaction { ..placeholder, inputs: [sn_input(sn_genesis_ref())], mint: m }
  shard_nft.mint(sn_genesis_ref(), Void, sn_policy, tx)
}
