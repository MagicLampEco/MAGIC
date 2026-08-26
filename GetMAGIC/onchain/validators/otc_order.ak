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
use aiken/interval.{Finite, Interval}
use cardano/address.{Script}
use cardano/transaction.{Output, OutputReference, Transaction, placeholder}

use getmagic/testkit as tk
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

// ══════════════════════════════════════════════════════════════
// TEST — otc_order
//
// BẤT BIẾN đang được phủ (nói bằng lời trước khi đọc mã test):
//   • Settle chỉ đi qua khi CHÍNH `datum.oracle_vkey` đã ký đúng payload
//     order_id ++ user_pkh ++ nonce ++ ts. Đổi khoá, đổi payload → chặn.
//   • Settle có hai cổng thời gian độc lập: độ tươi của dấu thời gian oracle
//     (±1 giờ quanh cận dưới tx) và hạn đơn (cận dưới tx < expiry_posix_ms).
//   • Số voucher phải ĐÚNG BẰNG total_epochs.
//   • Phải có output ở địa chỉ script allocation.
//   • Expire chỉ mở sau expiry_posix_ms.
//   • Cancel đòi chữ ký org_pkh.
//
// Các test tên `poc_*` KỲ VỌNG PASS. Chúng KHÔNG phải đường-vui: chúng dựng lại
// đúng giao dịch mà kẻ tấn công sẽ gửi, và việc validator chấp nhận là BẰNG CHỨNG
// của lỗ hổng đã ghi ở đầu tệp (KL-2). Ngày nào lỗ được vá, các test đó sẽ ĐỎ —
// đó là tín hiệu đúng, khi ấy đổi chúng thành `fail`.
// ══════════════════════════════════════════════════════════════

fn otc_datum() -> OrderDatum {
  OrderDatum {
    order_id: tk.order_id,
    org_pkh: tk.org_pkh,
    user_pkh: tk.user_pkh,
    user_stake_cred: None,
    magic_per_epoch: tk.magic_per_epoch,
    total_epochs: tk.total_epochs,
    fiat_amount_vnd: tk.fiat_vnd,
    created_posix_ms: tk.otc_ts,
    expiry_posix_ms: tk.otc_expiry,
    oracle_vkey: tk.oracle_vkey,
  }
}

/// Chạy validator với datum/redeemer/outputs/chữ ký/cửa sổ thời gian tuỳ biến.
fn otc_run(
  d: Data,
  rd: OrderRedeemer,
  outs: List<Output>,
  sigs: List<ByteArray>,
  vr: Interval,
) -> Bool {
  let tx =
    Transaction {
      ..placeholder,
      outputs: outs,
      extra_signatories: sigs,
      validity_range: vr,
    }
  otc_order.spend(tk.alloc_sh, Some(d), rd, tk.mk_ref(#"01", 0), tx)
}

fn otc_run_d(
  d: OrderDatum,
  rd: OrderRedeemer,
  outs: List<Output>,
  sigs: List<ByteArray>,
  vr: Interval,
) -> Bool {
  let raw: Data = d
  otc_run(raw, rd, outs, sigs, vr)
}

fn settle(sig: ByteArray, ts: Int, n_vouchers: Int) -> OrderRedeemer {
  Settle {
    oracle_nonce: tk.nonce,
    oracle_timestamp: ts,
    oracle_signature: sig,
    epoch_vouchers: list.repeat(#"ff", n_vouchers),
  }
}

/// Output "đúng chuẩn" ở địa chỉ allocation: AllocationDatum khớp đơn hàng.
fn alloc_datum_honest() -> AllocationDatum {
  AllocationDatum {
    alloc_id: tk.alloc_id,
    order_id: tk.order_id,
    org_pkh: tk.org_pkh,
    org_vault_nft_policy: tk.org_vault_nft_policy,
    beneficiary_pkh: tk.user_pkh,
    beneficiary_stake: None,
    magic_per_epoch: tk.magic_per_epoch,
    total_epochs: tk.total_epochs,
    claimed_epochs: [],
    start_epoch: tk.start_epoch,
    expiry_epoch: tk.expiry_epoch,
    vouchers: tk.vouchers_ok(),
    oracle_vkey: tk.oracle_vkey,
  }
}

fn out_alloc_honest() -> Output {
  let d: Data = alloc_datum_honest()
  tk.mk_output(tk.script_address(tk.alloc_sh), tk.rich_value(), d)
}

fn out_to_attacker() -> Output {
  tk.mk_output_no_datum(tk.vk_address(tk.attacker_pkh), tk.rich_value())
}

// ── Settle: đường ĐI ĐƯỢC ─────────────────────────────────────

test otc_settle_happy() {
  otc_run_d(
    otc_datum(),
    settle(tk.settle_sig_ok, tk.otc_ts, 6),
    [out_alloc_honest()],
    [],
    tk.window_from(tk.otc_ts),
  )
}

// Biên hạn đơn: cận dưới = expiry - 1 ms vẫn settle được.
test otc_settle_one_ms_before_expiry_happy() {
  otc_run_d(
    otc_datum(),
    settle(tk.settle_sig_ts_at_expiry, tk.otc_expiry, 6),
    [out_alloc_honest()],
    [],
    tk.window_from(tk.otc_expiry - 1),
  )
}

// ── Settle: ca QUYỀN — trust-root chữ ký oracle ───────────────

// Khoá khác ký cùng payload → chặn. Đây là cổng duy nhất bảo vệ Settle.
test otc_settle_wrong_oracle_key_fail() fail {
  otc_run_d(
    otc_datum(),
    settle(tk.settle_sig_attacker, tk.otc_ts, 6),
    [out_alloc_honest()],
    [],
    tk.window_from(tk.otc_ts),
  )
}

// Oracle ký THẬT nhưng cho user_pkh khác → chặn.
// Không có dòng này thì một chữ ký oracle của đơn A dùng lại cho đơn B.
test otc_settle_tampered_user_pkh_fail() fail {
  otc_run_d(
    otc_datum(),
    settle(tk.settle_sig_other_user, tk.otc_ts, 6),
    [out_alloc_honest()],
    [],
    tk.window_from(tk.otc_ts),
  )
}

// Nonce trong redeemer khác nonce đã ký → chặn (chống phát lại chéo giao dịch ngân hàng).
test otc_settle_tampered_nonce_fail() fail {
  let rd =
    Settle {
      oracle_nonce: #"4444444444444444444444444444444444444444444444444444444444444444",
      oracle_timestamp: tk.otc_ts,
      oracle_signature: tk.settle_sig_ok,
      epoch_vouchers: list.repeat(#"ff", 6),
    }
  otc_run_d(
    otc_datum(),
    rd,
    [out_alloc_honest()],
    [],
    tk.window_from(tk.otc_ts),
  )
}

// ── Settle: ca THỜI GIAN ─────────────────────────────────────

// G-OTC-2: chữ ký oracle cũ hơn 1 giờ so với cận dưới tx → chặn.
test otc_settle_stale_oracle_timestamp_fail() fail {
  otc_run_d(
    otc_datum(),
    settle(tk.settle_sig_ok, tk.otc_ts, 6),
    [out_alloc_honest()],
    [],
    tk.window_from(tk.otc_ts + 3_600_001),
  )
}

// Dấu thời gian oracle ở TƯƠNG LAI quá 1 giờ → chặn (so sánh phải đủ HAI chiều).
test otc_settle_future_oracle_timestamp_fail() fail {
  otc_run_d(
    otc_datum(),
    settle(tk.settle_sig_ok, tk.otc_ts, 6),
    [out_alloc_honest()],
    [],
    tk.window_from(tk.otc_ts - 3_600_001),
  )
}

// G-OTC-5: đúng tại expiry đã phải chặn (`<` chứ không phải `<=`).
// Cùng bộ tham số với `otc_settle_one_ms_before_expiry_happy`, lệch đúng 1 ms.
test otc_settle_at_expiry_fail() fail {
  otc_run_d(
    otc_datum(),
    settle(tk.settle_sig_ts_at_expiry, tk.otc_expiry, 6),
    [out_alloc_honest()],
    [],
    tk.window_from(tk.otc_expiry),
  )
}

// ── Settle: ca GIÁ TRỊ — số lượng voucher ────────────────────

test otc_settle_voucher_count_short_fail() fail {
  otc_run_d(
    otc_datum(),
    settle(tk.settle_sig_ok, tk.otc_ts, 5),
    [out_alloc_honest()],
    [],
    tk.window_from(tk.otc_ts),
  )
}

test otc_settle_voucher_count_long_fail() fail {
  otc_run_d(
    otc_datum(),
    settle(tk.settle_sig_ok, tk.otc_ts, 7),
    [out_alloc_honest()],
    [],
    tk.window_from(tk.otc_ts),
  )
}

test otc_settle_zero_voucher_fail() fail {
  otc_run_d(
    otc_datum(),
    settle(tk.settle_sig_ok, tk.otc_ts, 0),
    [out_alloc_honest()],
    [],
    tk.window_from(tk.otc_ts),
  )
}

// total_epochs ÂM trong datum: `list.length` không bao giờ âm ⇒ đơn không settle
// được bằng bất kỳ cách nào. Ghi lại để nếu sau này ai đó nới `vouchers_ok`
// thành `>=` thì test này đỏ.
test otc_settle_negative_total_epochs_unsettleable_fail() fail {
  let d = OrderDatum { ..otc_datum(), total_epochs: -1 }
  otc_run_d(
    d,
    settle(tk.settle_sig_ok, tk.otc_ts, 6),
    [out_alloc_honest()],
    [],
    tk.window_from(tk.otc_ts),
  )
}

// ── Settle: ca ĐỊA CHỈ ───────────────────────────────────────

// Không có output nào ở địa chỉ allocation → chặn.
test otc_settle_no_output_at_alloc_fail() fail {
  otc_run_d(
    otc_datum(),
    settle(tk.settle_sig_ok, tk.otc_ts, 6),
    [out_to_attacker()],
    [],
    tk.window_from(tk.otc_ts),
  )
}

// Output mang AllocationDatum ĐÚNG nhưng nằm ở script hash KHÁC → chặn.
test otc_settle_output_at_other_script_fail() fail {
  let d: Data = alloc_datum_honest()
  let bad = tk.mk_output(tk.script_address(tk.other_sh), tk.rich_value(), d)
  otc_run_d(
    otc_datum(),
    settle(tk.settle_sig_ok, tk.otc_ts, 6),
    [bad],
    [],
    tk.window_from(tk.otc_ts),
  )
}

// Output tới VÍ TRẦN có payment key hash TRÙNG BYTE với alloc_script_hash → chặn.
// Chốt rằng phép so là trên Credential (Script vs VerificationKey), không phải
// so byte trần — nếu lỏng, một ví thường sẽ giả được địa chỉ script.
test otc_settle_output_at_vk_with_same_bytes_fail() fail {
  let d: Data = alloc_datum_honest()
  let bad = tk.mk_output(tk.vk_address(tk.alloc_sh), tk.rich_value(), d)
  otc_run_d(
    otc_datum(),
    settle(tk.settle_sig_ok, tk.otc_ts, 6),
    [bad],
    [],
    tk.window_from(tk.otc_ts),
  )
}

// ── POC: KL-2 — Settle KHÔNG ràng buộc datum đi ra ───────────

// 🔴 KỲ VỌNG PASS = LỖ HỔNG.
// Người settle (bất kỳ ai cầm chữ ký settle hợp lệ) gắn một AllocationDatum
// hoàn toàn của mình: oracle_vkey của CHÍNH MÌNH, người thụ hưởng là mình,
// magic_per_epoch phóng lên 999 MAGIC, total_epochs 999. Validator vẫn cho qua
// vì G-OTC-4 chỉ hỏi "có output nào ở địa chỉ allocation không".
// Đây là gốc của nợ #34: trust-root nằm trong chính datum bị bỏ trống ràng buộc.
test poc_settle_produces_attacker_controlled_alloc_datum() {
  let evil =
    AllocationDatum {
      ..alloc_datum_honest(),
      beneficiary_pkh: tk.attacker_pkh,
      magic_per_epoch: 999_000_000_000,
      total_epochs: 999,
      oracle_vkey: tk.attacker_vkey,
      vouchers: tk.vouchers_attacker_first(),
    }
  let d: Data = evil
  let out = tk.mk_output(tk.script_address(tk.alloc_sh), tk.rich_value(), d)
  otc_run_d(
    otc_datum(),
    settle(tk.settle_sig_ok, tk.otc_ts, 6),
    [out],
    [],
    tk.window_from(tk.otc_ts),
  )
}

// 🔴 KỲ VỌNG PASS = LỖ HỔNG. Output ở địa chỉ allocation KHÔNG CÓ DATUM và chỉ
// mang bụi ADA; toàn bộ giá trị đơn hàng đi về ví kẻ tấn công. Vẫn qua.
test poc_settle_alloc_output_may_be_dust_without_datum() {
  let dust = tk.mk_output_no_datum(tk.script_address(tk.alloc_sh), tk.drained_value())
  otc_run_d(
    otc_datum(),
    settle(tk.settle_sig_ok, tk.otc_ts, 6),
    [dust, out_to_attacker()],
    [],
    tk.window_from(tk.otc_ts),
  )
}

// 🔴 KỲ VỌNG PASS = ca ĐỊA CHỈ ở mức stake credential.
// payment_credential đúng script allocation nhưng stake_credential là của kẻ tấn
// công ⇒ phần thưởng uỷ quyền của UTxO allocation chảy về ví hắn.
// Cùng lớp lỗi với nợ #35 (kiểm một nửa địa chỉ).
test poc_settle_alloc_output_carries_attacker_stake_cred() {
  let d: Data = alloc_datum_honest()
  let out =
    tk.mk_output(
      tk.script_address_staked(tk.alloc_sh, tk.attacker_pkh),
      tk.rich_value(),
      d,
    )
  otc_run_d(
    otc_datum(),
    settle(tk.settle_sig_ok, tk.otc_ts, 6),
    [out],
    [],
    tk.window_from(tk.otc_ts),
  )
}

// ── Expire ───────────────────────────────────────────────────

test otc_expire_happy() {
  otc_run_d(
    otc_datum(),
    Expire,
    [out_to_attacker()],
    [],
    tk.window_from(tk.otc_expiry),
  )
}

test otc_expire_one_ms_early_fail() fail {
  otc_run_d(
    otc_datum(),
    Expire,
    [out_to_attacker()],
    [],
    tk.window_from(tk.otc_expiry - 1),
  )
}

// Cận dưới KHÔNG chặn → `tx_lower_ms` rơi về mặc định 0. Ở nhánh Expire mặc định
// này an toàn (0 >= expiry là sai ⇒ chặn). Ghi lại để ai đổi dấu so sánh sẽ đỏ.
test otc_expire_unbounded_lower_bound_fails_safe() fail {
  otc_run_d(otc_datum(), Expire, [out_to_attacker()], [], tk.window_unbounded())
}

// 🔴 KỲ VỌNG PASS = ca QUYỀN còn trống.
// Sau hạn, KHÔNG một chữ ký nào được đòi và KHÔNG một output nào bị ràng. Người
// thứ ba không liên quan quét sạch giá trị đơn hàng về ví mình. Chú thích
// otc_order.ak:101 nói "org or user may sweep" — trên chuỗi thì là AI CŨNG ĐƯỢC.
test poc_expire_any_third_party_sweeps_everything() {
  otc_run_d(
    otc_datum(),
    Expire,
    [out_to_attacker()],
    [tk.attacker_pkh],
    tk.window_from(tk.otc_expiry),
  )
}

// ── Cancel ───────────────────────────────────────────────────

test otc_cancel_happy() {
  otc_run_d(
    otc_datum(),
    Cancel,
    [tk.mk_output_no_datum(tk.vk_address(tk.org_pkh), tk.rich_value())],
    [tk.org_pkh],
    tk.window_from(tk.otc_ts),
  )
}

// Ca QUYỀN: không có chữ ký nào → chặn.
test otc_cancel_without_any_sig_fail() fail {
  otc_run_d(otc_datum(), Cancel, [out_to_attacker()], [], tk.window_from(tk.otc_ts))
}

// Ca QUYỀN: người ngoài ký → chặn. Không ai huỷ được đơn của org khác.
test otc_cancel_by_attacker_fail() fail {
  otc_run_d(
    otc_datum(),
    Cancel,
    [out_to_attacker()],
    [tk.attacker_pkh],
    tk.window_from(tk.otc_ts),
  )
}

// Ca QUYỀN: chính NGƯỜI MUA ký cũng không huỷ được (chỉ org).
test otc_cancel_by_user_fail() fail {
  otc_run_d(
    otc_datum(),
    Cancel,
    [out_to_attacker()],
    [tk.user_pkh],
    tk.window_from(tk.otc_ts),
  )
}

// 🔴 KỲ VỌNG PASS = khoảng cách giữa chú thích và mã.
// otc_order.ak:112-113 viết "Org cancels before user has paid (oracle has not yet
// signed)". Trên chuỗi KHÔNG có cổng nào kiểm điều đó: org ký là huỷ được ở BẤT KỲ
// thời điểm nào, kể cả sau khi người mua đã chuyển tiền và oracle đã ký. Giao dịch
// dưới đây đặt cận dưới sau cả hạn đơn và vẫn qua.
test poc_cancel_has_no_time_or_payment_gate() {
  otc_run_d(
    otc_datum(),
    Cancel,
    [tk.mk_output_no_datum(tk.vk_address(tk.org_pkh), tk.rich_value())],
    [tk.org_pkh],
    tk.window_from(tk.otc_expiry + 86_400_000),
  )
}

// ── Datum ────────────────────────────────────────────────────

test otc_missing_datum_fail() fail {
  let tx = Transaction { ..placeholder, validity_range: tk.window_from(tk.otc_ts) }
  otc_order.spend(tk.alloc_sh, None, Expire, tk.mk_ref(#"01", 0), tx)
}

// Datum sai kiểu (một Int trần) → `expect` nổ, không im lặng cho qua.
test otc_wrong_datum_shape_fail() fail {
  let junk: Data = 42
  otc_run(junk, Expire, [out_to_attacker()], [], tk.window_from(tk.otc_expiry))
}
