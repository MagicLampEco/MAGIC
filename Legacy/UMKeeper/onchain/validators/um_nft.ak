// validators/um_nft.ak — UM authority NFT minting policy ONE-SHOT (§14).
//
// ── MAINNET-BLOCK fix, layer (a) ──────────────────────────────────────────
// The UM datum UTxO carries exactly 1 authority NFT ("UMD"). InstantGen and
// VacuumGen read the UM rate from a reference input identified by this NFT.
// If the NFT policy were a reusable signature policy (the previous
// `scriptFromNative({ type: "sig" })` in 02_deploy_um.ts), the deployer — or
// anyone holding that key — could re-mint the same policy+name arbitrarily.
// An attacker could then attach their OWN UTxO bearing a forged UMDatum
// (smoothed_q = 2.0× within bounds, last_updated_epoch = current) as the UM
// reference input and force the maximum multiplier, burning more LAMP to
// generate more MAGIC. The UMKeeper validator's double-clamp + SMA become
// meaningless if the consumer can read the wrong UTxO.
//
// FIRST-PRINCIPLES one-shot: the policy is parameterized by ONE genesis
// OutputReference. A UTxO can be spent at most once → the policy runs at most
// once → the NFT supply is fixed at exactly 1, can never be re-minted, and is
// a true global singleton. Combined with layer (b) (vaults pin the UM script
// address), the UM authority is unforgeable.
//
// Pair with the defense-in-depth check in InstantGen/VacuumGen vault.ak
// `find_um_datum`, which additionally requires the ref input to live at the
// canonical UM script address Script(um_script_hash).

use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Address, VerificationKey}
use cardano/assets.{PolicyId}
use cardano/transaction.{
  Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}

/// Asset name of the UM authority NFT = "UMD" (cross-module canonical:
/// InstantGen / VacuumGen / scripts all use this exact name).
pub const um_nft_name: ByteArray = #"554d44"

validator um_nft(genesis_ref: OutputReference) {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    // ── ONE-SHOT: must consume the exact genesis UTxO ──────────────────────
    expect list.any(tx.inputs, fn(i) { i.output_reference == genesis_ref })

    // ── Mint contains EXACTLY one asset name of this policy, qty +1 ─────────
    // No extra names, no negative quantities (rejects burns + spoofed names).
    let own_tokens = assets.tokens(tx.mint, policy_id)
    expect dict.size(own_tokens) == 1
    expect assets.quantity_of(tx.mint, policy_id, um_nft_name) == 1
    True
  }

  // Spend / burn / any other purpose fails closed — the NFT is permanent.
  else(_) {
    fail
  }
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

const un_policy: PolicyId = #"9999"

fn vk_address(h: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(h), stake_credential: None }
}

fn un_genesis_ref() -> OutputReference {
  OutputReference { transaction_id: #"aa", output_index: 3 }
}

fn mk_ref(ix: Int) -> OutputReference {
  OutputReference { transaction_id: #"00", output_index: ix }
}

fn un_input(ref: OutputReference) -> Input {
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

// happy: consume genesis, mint exactly 1 "UMD".
test um_nft_happy() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [un_input(un_genesis_ref())],
      mint: assets.from_asset(un_policy, um_nft_name, 1),
    }
  um_nft.mint(un_genesis_ref(), Void, un_policy, tx)
}

// fail: genesis UTxO not consumed → re-mint blocked.
test um_nft_no_genesis() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [un_input(mk_ref(0))],
      mint: assets.from_asset(un_policy, um_nft_name, 1),
    }
  um_nft.mint(un_genesis_ref(), Void, un_policy, tx)
}

// fail: minting more than 1 → not a singleton.
test um_nft_wrong_qty() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [un_input(un_genesis_ref())],
      mint: assets.from_asset(un_policy, um_nft_name, 2),
    }
  um_nft.mint(un_genesis_ref(), Void, un_policy, tx)
}

// fail: extra asset name under same policy → spoofed companion token.
test um_nft_extra_name() fail {
  let m =
    assets.from_asset(un_policy, um_nft_name, 1)
      |> assets.add(un_policy, #"6666", 1)
  let tx =
    Transaction { ..placeholder, inputs: [un_input(un_genesis_ref())], mint: m }
  um_nft.mint(un_genesis_ref(), Void, un_policy, tx)
}
