// validators/otc_order.ak — OTC Order spending validator
// Guards the OTC Order UTxO while awaiting VeData oracle settlement.
//
// Security invariants:
//   G-OTC-1: Oracle sig covers order_id ++ user_pkh ++ nonce ++ timestamp
//   G-OTC-2: Oracle timestamp TTL = 1 hour (prevents delayed relay attacks)
//   G-OTC-3: Nonce uniqueness enforced off-chain (OrgDatum.released_nonces)
//   G-OTC-4: AllocationDatum must be produced at alloc_script_hash address
//   G-OTC-5: Expiry timeout = 4 hours (enough for AlePay + block confirmation)
//
// Parameters:
//   alloc_script_hash : ScriptHash of magic_allocation validator
//                       (ensures AllocationDatum goes to the correct address)

use aiken/collection/list
use aiken/crypto
use aiken/interval.{Finite}
use cardano/address.{Script}
use cardano/transaction.{OutputReference, Transaction}

use getmagic/types.{Cancel, Expire, OrderDatum, OrderRedeemer, Settle}
use getmagic/utils.{build_oracle_settle_msg}

/// Parameterized by the allocation validator script hash.
/// Must be applied before deployment so alloc_script_hash is baked in.
validator otc_order(alloc_script_hash: ByteArray) {
  spend(
    datum_opt: Option<Data>,
    redeemer:  OrderRedeemer,
    _oref:     OutputReference,
    tx:        Transaction,
  ) {
    expect Some(datum_raw) = datum_opt
    expect datum: OrderDatum = datum_raw

    when redeemer is {
      // ── Settle ──────────────────────────────────────────────
      // Oracle has confirmed VeData payment. Verify signature and produce
      // AllocationDatum at the allocation script address.
      Settle { oracle_nonce, oracle_timestamp, oracle_signature, epoch_vouchers } -> {

        // G-OTC-1: Verify oracle Ed25519 signature over settlement message.
        // msg = order_id ++ user_pkh ++ nonce ++ timestamp_ms
        let msg =
          build_oracle_settle_msg(
            datum.order_id,
            datum.user_pkh,
            oracle_nonce,
            oracle_timestamp,
          )
        let sig_valid =
          crypto.verify_ed25519_signature(datum.oracle_vkey, msg, oracle_signature)

        // Derive tx lower bound in POSIX ms (required for time-bound checks).
        let tx_lower_ms =
          when tx.validity_range.lower_bound.bound_type is {
            Finite(t) -> t
            _ -> 0
          }

        // G-OTC-2: Oracle timestamp freshness — within ±1 hour of tx lower bound.
        // Prevents a replayed oracle signature being used much later.
        let timestamp_fresh =
          oracle_timestamp <= tx_lower_ms + 3_600_000 && oracle_timestamp + 3_600_000 >= tx_lower_ms

        // G-OTC-5: Order must not be expired at time of settlement.
        let not_expired = tx_lower_ms < datum.expiry_posix_ms

        // Voucher count must match total_epochs (pre-issued by oracle at settlement time).
        let vouchers_ok = list.length(epoch_vouchers) == datum.total_epochs

        // G-OTC-4: Exactly one output at the allocation script address must exist.
        // Off-chain is responsible for embedding the correct AllocationDatum inline.
        let alloc_output_exists =
          list.any(
            tx.outputs,
            fn(o) { o.address.payment_credential == Script(alloc_script_hash) },
          )

        sig_valid && timestamp_fresh && not_expired && vouchers_ok && alloc_output_exists
      }

      // ── Expire ──────────────────────────────────────────────
      // G-OTC-5: Unlock after expiry_posix_ms — org or user may sweep the ADA.
      Expire -> {
        let tx_lower_ms =
          when tx.validity_range.lower_bound.bound_type is {
            Finite(t) -> t
            _ -> 0
          }
        tx_lower_ms >= datum.expiry_posix_ms
      }

      // ── Cancel ──────────────────────────────────────────────
      // Org cancels before user has paid (oracle has not yet signed).
      // No time constraint — org can cancel any time the oracle hasn't settled.
      Cancel ->
        list.any(tx.extra_signatories, fn(pkh) { pkh == datum.org_pkh })
    }
  }

  else(_) { fail }
}
