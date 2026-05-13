// validators/vault_profile.ak — ProfileChange redeemer (§12)
// Normative: C-PC-V1..6, §12.1..12.4, T4
//
// Profile change là 2-step lazy:
//   Step 1 (this tx):  set pending_profile = Some{new, effective: e+1}
//   Step 2 (next tx):  any vault touch applies pending nếu effective_epoch ≤ current

use aiken/collection/list
use aiken/interval.{Finite, IntervalBoundType}
use cardano/address.{Address}
use cardano/script_context.{ScriptContext}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction}

const slots_per_epoch : Int = 432_000
const profile_cooldown : Int = 2   // [Significant]

type ActivityProfile { Ember | Flame | Lantern }
type PendingProfile  { new_profile: ActivityProfile, effective_epoch: Int }

type VaultDatum {
  owner                 : ByteArray,
  lamp_balance          : Int,
  lamp_locked           : Int,
  magic_batches         : List<MagicBatch>,     // C-PC-V4: unchanged in this tx
  profile               : ActivityProfile,
  profile_changed_epoch : Int,
  pending_profile       : Option<PendingProfile>,
  last_updated_epoch    : Int,
  // ... other fields unchanged
}

type MagicBatch { profile_at_creation: Option<ActivityProfile>, /* ... */ }

type ProfileRedeemer {
  UpdateProfile { new_profile: ActivityProfile }
  ApplyPending                                   // apply pending on any vault touch
}

validator vault_profile {
  spend(
    datum_opt : Option<VaultDatum>,
    redeemer  : ProfileRedeemer,
    own_ref   : OutputReference,
    ctx       : ScriptContext,
  ) {
    expect Some(datum) = datum_opt
    let tx            = ctx.transaction
    let current_epoch = get_epoch(tx)
    let own_addr      = get_own_addr(own_ref, tx.inputs)

    when redeemer is {

      // ── §12.1 Initiate profile change ─────────────────────
      UpdateProfile { new_profile } -> {

        // C-PC-V1: user signs
        expect list.has(tx.extra_signatories, datum.owner)

        // C-PC-V2: cooldown ≥ 2 epoch since last change
        expect current_epoch - datum.profile_changed_epoch >= profile_cooldown

        // C-PC-V3: new_profile ≠ current
        expect new_profile != datum.profile

        let output = get_output_datum(tx.outputs, own_addr)

        // C-PC-V5: pending.effective_epoch = current_epoch + 1
        expect output.pending_profile ==
          Some(PendingProfile { new_profile, effective_epoch: current_epoch + 1 })

        // C-PC-V4: existing batches unchanged (profile_at_creation immutable — T4)
        expect output.magic_batches == datum.magic_batches

        // Other fields unchanged in this tx
        expect output.owner                 == datum.owner
        expect output.lamp_balance          == datum.lamp_balance
        expect output.lamp_locked           == datum.lamp_locked
        expect output.profile               == datum.profile    // still old profile
        expect output.profile_changed_epoch == current_epoch    // updated to now
        expect output.last_updated_epoch    == current_epoch

        True
      }

      // ── §12.2 Apply pending (lazy) ─────────────────────────
      ApplyPending -> {
        expect list.has(tx.extra_signatories, datum.owner)

        let output = get_output_datum(tx.outputs, own_addr)

        when datum.pending_profile is {
          None -> fail @"No pending profile to apply"
          Some(pending) -> {
            expect pending.effective_epoch <= current_epoch
            // Apply: profile becomes new, pending cleared
            expect output.profile         == pending.new_profile
            expect output.pending_profile == None
            // C-PC-V6: profile_at_creation immutable for existing batches
            expect output.magic_batches   == datum.magic_batches
            expect output.last_updated_epoch == current_epoch
            True
          }
        }
      }
    }
  }
}

fn get_epoch(tx: Transaction) -> Int {
  expect Some(s) = tx.validity_range.lower_bound.bound_type |> get_finite
  s / slots_per_epoch
}

fn get_finite(bt: IntervalBoundType<Int>) -> Option<Int> {
  when bt is {
    Finite(s) -> Some(s)
    _ -> None
  }
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
