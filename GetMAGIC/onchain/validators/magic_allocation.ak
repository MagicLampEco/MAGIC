// validators/magic_allocation.ak — Magic Allocation spending validator
// Guards the AllocationDatum UTxO that tracks per-epoch claim rights.
//
// Security invariants:
//   G-ALLOC-1: Epoch vouchers are per-epoch Ed25519 sigs from oracle (pre-signed at Settle)
//   G-ALLOC-2: claimed_epochs grows monotonically; cannot remove entries
//   G-ALLOC-3: Only beneficiary can claim; only org can reclaim after expiry
//   G-ALLOC-4: Total claimable = total_epochs - len(claimed_epochs)
//   G-ALLOC-5: Voucher at index (epoch - start_epoch) authorises that specific epoch

use aiken/collection/list
use aiken/crypto
use aiken/interval.{Finite}
use cardano/transaction.{InlineDatum, OutputReference, Transaction}

use getmagic/types.{
  AllocationDatum, AllocationRedeemer, ClaimEpoch, ReclaimExpired, Surrender,
}
use getmagic/utils.{
  build_voucher_msg, epoch_already_claimed, get_voucher_for_epoch,
}

validator magic_allocation {
  spend(
    datum_opt: Option<Data>,
    redeemer:  AllocationRedeemer,
    self_ref:  OutputReference,
    tx:        Transaction,
  ) {
    expect Some(datum_raw) = datum_opt
    expect datum: AllocationDatum = datum_raw

    when redeemer is {
      // ── ClaimEpoch ──────────────────────────────────────────
      // Beneficiary claims MAGIC rights for one epoch.
      // Phase 1: epoch is self-declared by caller; oracle voucher verifies
      // the oracle pre-authorised this exact epoch at allocation time.
      ClaimEpoch { epoch, um_ref: _um_ref } -> {

        // G-ALLOC-3: Beneficiary must sign every claim.
        let beneficiary_signed =
          list.any(tx.extra_signatories, fn(pkh) { pkh == datum.beneficiary_pkh })

        // G-ALLOC-4/5: Epoch must be within the allocated window.
        let epoch_in_range =
          epoch >= datum.start_epoch && epoch < datum.expiry_epoch

        // G-ALLOC-2: Epoch cannot be claimed twice.
        let not_claimed = !epoch_already_claimed(datum.claimed_epochs, epoch)

        // G-ALLOC-1: Verify per-epoch oracle voucher signature.
        // voucher_msg = alloc_id ++ epoch(8) ++ nanogic(8) ++ expiry_posix(8)
        // expiry_posix is approximated as expiry_epoch * ms_per_epoch (Preview = 86_400_000).
        // The oracle uses the same formula when pre-signing vouchers.
        let expiry_posix_ms = datum.expiry_epoch * 86_400_000
        let voucher_msg =
          build_voucher_msg(
            datum.alloc_id,
            epoch,
            datum.magic_per_epoch,
            expiry_posix_ms,
          )
        let maybe_voucher =
          get_voucher_for_epoch(datum.vouchers, epoch, datum.start_epoch)
        let voucher_valid =
          when maybe_voucher is {
            Some(voucher) ->
              crypto.verify_ed25519_signature(datum.oracle_vkey, voucher_msg, voucher)
            None -> False
          }

        // G-ALLOC-2: Continuing output must carry AllocationDatum with epoch
        // added to claimed_epochs (sorted ascending for determinism).
        // All other fields must be identical to the input datum.
        let new_claimed =
          list.sort(
            [epoch, ..datum.claimed_epochs],
            fn(a, b) {
              if a < b {
                Less
              } else if a > b {
                Greater
              } else {
                Equal
              }
            },
          )

        let continuing_output_ok =
          list.any(
            tx.outputs,
            fn(o) {
              when o.datum is {
                InlineDatum(d) -> {
                  // Decode only if possible; mismatched datums are skipped.
                  if d is AllocationDatum {
                    let updated: AllocationDatum = d
                    // Verify all fields unchanged except claimed_epochs.
                    updated.alloc_id == datum.alloc_id && updated.order_id == datum.order_id && updated.org_pkh == datum.org_pkh && updated.org_vault_nft_policy == datum.org_vault_nft_policy && updated.beneficiary_pkh == datum.beneficiary_pkh && updated.beneficiary_stake == datum.beneficiary_stake && updated.magic_per_epoch == datum.magic_per_epoch && updated.total_epochs == datum.total_epochs && updated.claimed_epochs == new_claimed && updated.start_epoch == datum.start_epoch && updated.expiry_epoch == datum.expiry_epoch && updated.vouchers == datum.vouchers && updated.oracle_vkey == datum.oracle_vkey
                  } else {
                    False
                  }
                }
                _ -> False
              }
            },
          )

        beneficiary_signed && epoch_in_range && not_claimed && voucher_valid && continuing_output_ok
      }

      // ── ReclaimExpired ──────────────────────────────────────
      // G-ALLOC-3: Org reclaims the UTxO after expiry_epoch has passed.
      // expiry is approximate (expiry_epoch * ms_per_epoch); uses tx lower bound.
      ReclaimExpired -> {
        let tx_lower_ms =
          when tx.validity_range.lower_bound.bound_type is {
            Finite(t) -> t
            _ -> 0
          }
        let is_expired = tx_lower_ms > datum.expiry_epoch * 86_400_000
        let org_signed =
          list.any(tx.extra_signatories, fn(pkh) { pkh == datum.org_pkh })
        is_expired && org_signed
      }

      // ── Surrender ───────────────────────────────────────────
      // G-ALLOC-3: Beneficiary surrenders all remaining epochs at any time.
      // No continuing output required — the UTxO is consumed.
      Surrender ->
        list.any(tx.extra_signatories, fn(pkh) { pkh == datum.beneficiary_pkh })
    }
  }

  else(_) { fail }
}
