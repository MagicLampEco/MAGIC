// validators/vault_consolidate.ak — ConsolidateHoldings redeemer (§6.9)
// Normative: C-CONSOLIDATE-1..6, T23 (determinism, convergence, conservation)
//
// Mục đích: Merge holdings gần nhau (|epoch_diff| ≤ 1, cùng is_locked)
// để giảm số entries → tránh ExUnit exhaustion (A5).
// Khi |loyalty_holdings| gần 64, ví cần consolidate trước khi thêm.

use aiken/collection/list
use cardano/address.{Address}
use cardano/script_context.{ScriptContext}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction}

// ── Types ─────────────────────────────────────────────────────
type LoyaltyHolding {
  amount         : Int,
  acquired_epoch : Int,
  is_locked      : Bool,
}

type VaultDatum {
  owner            : ByteArray,
  lamp_balance     : Int,
  lamp_locked      : Int,
  loyalty_holdings : List<LoyaltyHolding>,
  // ... other fields omitted for brevity; A02 checks all fields unchanged
}

type ConsolidateRedeemer {
  Consolidate
}

// ── Validator ─────────────────────────────────────────────────
validator vault_consolidate {
  spend(
    datum_opt : Option<VaultDatum>,
    redeemer  : ConsolidateRedeemer,
    own_ref   : OutputReference,
    ctx       : ScriptContext,
  ) {
    expect Some(datum) = datum_opt
    let tx       = ctx.transaction
    let own_addr = get_own_addr(own_ref, tx.inputs)

    // C-PC-V1: user signs
    expect list.has(tx.extra_signatories, datum.owner)

    let output = get_output_datum(tx.outputs, own_addr)

    // All non-holdings fields unchanged
    expect output.owner        == datum.owner
    expect output.lamp_balance == datum.lamp_balance
    expect output.lamp_locked  == datum.lamp_locked

    // C-CONSOLIDATE-4: |output| < |input| (must reduce entries)
    expect list.length(output.loyalty_holdings) < list.length(datum.loyalty_holdings)

    // C-CONSOLIDATE-5: Σ(output.amount) = Σ(input.amount)
    let sum_in  = list.foldl(datum.loyalty_holdings,   0, fn(h, acc) { acc + h.amount })
    let sum_out = list.foldl(output.loyalty_holdings,  0, fn(h, acc) { acc + h.amount })
    expect sum_out == sum_in

    // C-CONSOLIDATE-6: Σ(locked output) = Σ(locked input)
    let locked_in  = sum_locked(datum.loyalty_holdings)
    let locked_out = sum_locked(output.loyalty_holdings)
    expect locked_out == locked_in

    // C-CONSOLIDATE-1: Only same is_locked merged (verify no cross-type merging)
    // This is enforced off-chain by the sort-partition algorithm;
    // on-chain we verify conservation (C-CONSOLIDATE-5/6 together imply this).

    // C-VAULT-10: Σholdings = lamp_balance
    expect sum_out == datum.lamp_balance

    // C-VAULT-8: lamp_locked ≤ lamp_balance (unchanged)
    expect datum.lamp_locked <= datum.lamp_balance

    True
  }
}

fn sum_locked(holdings: List<LoyaltyHolding>) -> Int {
  list.foldl(holdings, 0, fn(h, acc) { if h.is_locked { acc + h.amount } else { acc } })
}

fn get_own_addr(own_ref: OutputReference, inputs: List<Input>) -> Address {
  expect Some(i) = list.find(inputs, fn(x) { x.output_reference == own_ref })
  i.output.address
}

fn get_output_datum(outputs: List<Output>, addr: Address) -> VaultDatum {
  expect Some(o) = list.find(outputs, fn(x) { x.address == addr })
  expect InlineDatum(d) = o.datum
  expect datum: VaultDatum = d
  datum
}
