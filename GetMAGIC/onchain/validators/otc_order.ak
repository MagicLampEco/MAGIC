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
//
// ⚠️ PHASE-1 KNOWN-LIMITS — MUST be closed before settlement produces a spendable
//    MAGIC allocation (see GetMAGIC/TECH.md §KNOWN-LIMITS):
//   KL-2 (Settle does not constrain the produced AllocationDatum, CRITICAL@Phase-2):
//        G-OTC-4 only checks that SOME output exists at alloc_script_hash. It does
//        NOT verify the AllocationDatum CONTENTS or value. The settler (anyone with
//        a valid oracle settle-sig) can therefore mint an arbitrary AllocationDatum
//        — own oracle_vkey (self-signing every voucher, see magic_allocation KL-2),
//        inflated magic_per_epoch/total_epochs, attacker beneficiary. The Settle
//        oracle signature covers only order_id+user_pkh+nonce+timestamp, NOT the
//        allocation params. Fix: bake oracle_vkey as a magic_allocation validator
//        param, AND/OR extend the settle message to commit to the full
//        AllocationDatum, then verify the produced datum matches that commitment.
//   KL-5 (Org registry off-chain): quota (magic_quota), collateral solvency, and
//        nonce-replay (OrgDatum.released_nonces, G-OTC-3) are not enforced by any
//        on-chain validator — an org could over-issue beyond collateral. Move to an
//        Org-registry validator before mainnet.

use aiken/collection/list
use aiken/crypto
use aiken/interval.{Finite}
use cardano/address.{Script}
use cardano/assets
use cardano/transaction.{InlineDatum, Output, OutputReference, Transaction}

use getmagic/types.{
  AllocationDatum, Cancel, Expire, OrderDatum, OrderRedeemer, Settle,
}
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

        // G-OTC-4 (Nợ #42): ĐÚNG MỘT output tại địa chỉ allocation mang
        // AllocationDatum có `order_id` TRÙNG đơn này.
        //
        // Bản trước viết `list.any` với điều kiện duy nhất là "địa chỉ đúng" —
        // trong khi chú thích ngay trên nó hứa "exactly one". Hai đơn Settle của
        // hai khách trong cùng một tx, kèm đúng MỘT output allocation, thì cả hai
        // lượt chạy validator đều thấy điều kiện thoả: một khách nhận phân bổ,
        // khách còn lại trả tiền và không nhận gì. Đếm không ràng buộc theo đơn
        // thì gộp lô là đường làm mất tiền khách, không phải tối ưu phí.
        //
        // Ràng theo `order_id` chứ không chỉ đếm tổng: gộp lô N đơn vẫn hợp lệ,
        // miễn mỗi đơn có output riêng của nó. Đếm tổng sẽ chặn nhầm lô hợp lệ mà
        // vẫn không nói được output nào thuộc đơn nào.
        //
        // Vẫn nằm trong KL-2: dòng này ràng output THUỘC ĐÚNG ĐƠN, chưa ràng NỘI
        // DUNG các trường còn lại của AllocationDatum.
        let alloc_output_exists =
          count_alloc_outputs_for_order(
            tx.outputs, alloc_script_hash, datum.order_id,
          ) == 1

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

// ═══════════════════════════════════════════════════════════════
// Đếm output allocation THUỘC ĐÚNG một đơn (Nợ #42)
// ═══════════════════════════════════════════════════════════════

/// Số output nằm tại địa chỉ allocation VÀ mang AllocationDatum có `order_id`
/// trùng đơn đang xét. Tách rời để kiểm được bằng test, không phải suy từ mã.
pub fn count_alloc_outputs_for_order(
  outputs           : List<Output>,
  alloc_script_hash : ByteArray,
  order_id          : ByteArray,
) -> Int {
  list.count(
    outputs,
    fn(o) {
      if o.address.payment_credential == Script(alloc_script_hash) {
        when o.datum is {
          InlineDatum(d) ->
            if d is AllocationDatum {
              let ad: AllocationDatum = d
              ad.order_id == order_id
            } else {
              False
            }
          _ -> False
        }
      } else {
        False
      }
    },
  )
}

// ── Tests ─────────────────────────────────────────────────────

const t_alloc_sh: ByteArray =
  #"11111111111111111111111111111111111111111111111111111111"

fn t_alloc_datum(order_id: ByteArray) -> AllocationDatum {
  AllocationDatum {
    alloc_id: #"00", order_id, org_pkh: #"aa",
    org_vault_nft_policy: #"bb", beneficiary_pkh: #"cc",
    beneficiary_stake: None, magic_per_epoch: 10_000_000_000,
    total_epochs: 6, claimed_epochs: [], start_epoch: 1,
    expiry_epoch: 7, vouchers: [], oracle_vkey: #"dd",
  }
}

fn t_alloc_out(order_id: ByteArray) -> Output {
  Output {
    address: address.from_script(t_alloc_sh),
    value: assets.from_lovelace(2_000_000),
    datum: InlineDatum(t_alloc_datum(order_id)),
    reference_script: None,
  }
}

/// Một đơn, một output của chính nó.
test alloc_out_one_per_order() {
  count_alloc_outputs_for_order([t_alloc_out(#"4f31")], t_alloc_sh, #"4f31") == 1
}

/// 🔴 Ca Nợ #42: hai đơn Settle trong CÙNG tx, chỉ MỘT output allocation.
/// Bản cũ dùng `list.any` nên cả hai lượt chạy validator đều thấy thoả — khách
/// thứ hai trả tiền và không nhận gì. Nay đơn #"4f32" đếm ra 0 ⟹ tx bị từ chối.
test alloc_out_two_orders_share_one_output() {
  let outs = [t_alloc_out(#"4f31")]
  and {
    count_alloc_outputs_for_order(outs, t_alloc_sh, #"4f31") == 1,
    count_alloc_outputs_for_order(outs, t_alloc_sh, #"4f32") == 0,
  }
}

/// Gộp lô vẫn hợp lệ khi mỗi đơn có output riêng — ràng theo `order_id` chứ
/// không đếm tổng, nên không chặn nhầm lô đúng.
test alloc_out_batch_each_order_has_its_own() {
  let outs = [t_alloc_out(#"4f31"), t_alloc_out(#"4f32")]
  and {
    count_alloc_outputs_for_order(outs, t_alloc_sh, #"4f31") == 1,
    count_alloc_outputs_for_order(outs, t_alloc_sh, #"4f32") == 1,
  }
}

/// Output đúng địa chỉ nhưng datum của đơn KHÁC không được tính.
test alloc_out_wrong_order_not_counted() {
  count_alloc_outputs_for_order([t_alloc_out(#"4f99")], t_alloc_sh, #"4f31") == 0
}

/// Datum đúng nhưng nằm ở địa chỉ khác (ví trần) không được tính.
test alloc_out_wrong_address_not_counted() {
  let o =
    Output {
      ..t_alloc_out(#"4f31"),
      address: address.from_verification_key(#"cc"),
    }
  count_alloc_outputs_for_order([o], t_alloc_sh, #"4f31") == 0
}
