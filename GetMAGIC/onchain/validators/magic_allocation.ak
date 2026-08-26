// validators/magic_allocation.ak — Magic Allocation spending validator
// Guards the AllocationDatum UTxO that tracks per-epoch claim rights.
//
// Security invariants:
//   G-ALLOC-1: Epoch vouchers are per-epoch Ed25519 sigs from oracle (pre-signed at Settle)
//   G-ALLOC-2: claimed_epochs grows monotonically; cannot remove entries
//   G-ALLOC-3: Only beneficiary can claim; only org can reclaim after expiry
//   G-ALLOC-4: Total claimable = total_epochs - len(claimed_epochs)
//   G-ALLOC-5: Voucher at index (epoch - start_epoch) authorises that specific epoch
//
// ⚠️ PHASE-1 KNOWN-LIMITS — MUST be closed before ClaimEpoch releases real MAGIC
//    (this layer only TRACKS per-epoch claim rights; no asset/value moves yet — see
//     GetMAGIC/TECH.md §KNOWN-LIMITS):
//   KL-1 (ClaimEpoch continuing-output, CRITICAL@Phase-2): `continuing_output_ok`
//        only matches a datum via `list.any`. It does NOT (a) check the output sits
//        at THIS validator's own script address, (b) preserve the UTxO value, nor
//        (c) enforce exactly ONE continuing output. Once value is locked, a claimer
//        could move the allocation off-script / drain value / double-satisfy.
//        Fix: derive own address from `self_ref`, require exactly 1 continuing
//        output at it, and bind value conservation (see vault.ak value-lock pattern).
//   KL-2 (oracle_vkey trust-root, CRITICAL@Phase-2): vouchers are verified against
//        `datum.oracle_vkey`, a field of the SAME datum minted at Settle. otc_order
//        does not constrain that datum (see otc_order.ak KL-2), so a settler can set
//        their own vkey and self-sign all vouchers. Fix: make oracle_vkey a VALIDATOR
//        PARAMETER (baked per-org at deploy), OR have the Settle oracle signature
//        commit to the full AllocationDatum (oracle_vkey + magic_per_epoch +
//        total_epochs + beneficiary + hash(vouchers)).
//   KL-4 (epoch length, MAINNET): `expiry_posix_ms = expiry_epoch * 86_400_000` is
//        hardcoded to the Preview 1-day epoch. Mainnet differs → param-ise
//        ms_per_epoch (must match the oracle's voucher pre-sign formula).

use aiken/collection/list
use aiken/crypto
use aiken/interval.{Finite, Interval}
use cardano/address.{Address}
use cardano/assets.{Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, placeholder,
}

use getmagic/testkit as tk
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

// ══════════════════════════════════════════════════════════════
// TEST — magic_allocation
//
// BẤT BIẾN đang được phủ (viết bằng lời trước khi đọc mã):
//   • ClaimEpoch chỉ mở cho NGƯỜI THỤ HƯỞNG ghi trong datum — org không ghi thay
//     được, người ngoài càng không.
//   • Mỗi epoch chỉ tiêu được MỘT lần: epoch phải nằm trong [start, expiry), chưa
//     có trong claimed_epochs, và datum tiếp tục phải chèn đúng epoch đó vào danh
//     sách ĐÃ SẮP XẾP — không xoá, không chèn thừa.
//   • Voucher gắn ĐÚNG một epoch: ô thứ (epoch - start_epoch), ký trên
//     alloc_id ++ epoch ++ nanogic ++ expiry_posix. Đổi bất kỳ thành phần nào,
//     hoặc đổi khoá ký, đều phải bị chặn.
//   • Mọi trường khác của datum bất biến qua một lần claim.
//   • ReclaimExpired đòi chữ ký org VÀ đã quá expiry_epoch × 86_400_000.
//   • Surrender đòi chữ ký người thụ hưởng.
//
// Các test tên `poc_*` KỲ VỌNG PASS — chúng là BẰNG CHỨNG THỰC THI của những lỗ
// hổng đã ghi ở đầu tệp (KL-1, KL-2). Không vá ở đây: sửa hợp đồng nhị phân là
// quyết định của chủ dự án. Khi vá, các test đó phải đổi thành `fail`.
// ══════════════════════════════════════════════════════════════

fn um_ref_stub() -> Data {
  let d: Data = 0
  d
}

fn alloc_datum() -> AllocationDatum {
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

/// Output tiếp tục: cùng datum, chỉ đổi claimed_epochs, đặt ở địa chỉ + giá trị
/// do test chỉ định (để tách bạch ca ĐỊA CHỈ và ca GIÁ TRỊ).
fn cont_out(d: AllocationDatum, claimed: List<Int>, addr: Address, v: Value) -> Output {
  let updated: Data = AllocationDatum { ..d, claimed_epochs: claimed }
  tk.mk_output(addr, v, updated)
}

fn alloc_addr() -> Address {
  tk.script_address(tk.alloc_sh)
}

/// Output tiếp tục "đúng chuẩn": tại địa chỉ script, giữ nguyên giá trị.
fn cont_ok(d: AllocationDatum, claimed: List<Int>) -> Output {
  cont_out(d, claimed, alloc_addr(), tk.rich_value())
}

fn alloc_input(d: AllocationDatum, ix: Int) -> Input {
  let raw: Data = d
  tk.mk_input(
    tk.mk_ref(#"a0", ix),
    tk.mk_output(alloc_addr(), tk.rich_value(), raw),
  )
}

fn alloc_run(
  d: Data,
  rd: AllocationRedeemer,
  ins: List<Input>,
  outs: List<Output>,
  sigs: List<ByteArray>,
  vr: Interval,
  own: OutputReference,
) -> Bool {
  let tx =
    Transaction {
      ..placeholder,
      inputs: ins,
      outputs: outs,
      extra_signatories: sigs,
      validity_range: vr,
    }
  magic_allocation.spend(Some(d), rd, own, tx)
}

/// Đường chạy mặc định: một input allocation, cửa sổ thời gian giữa vòng đời.
fn claim_run(
  d: AllocationDatum,
  epoch: Int,
  outs: List<Output>,
  sigs: List<ByteArray>,
) -> Bool {
  let raw: Data = d
  alloc_run(
    raw,
    ClaimEpoch { epoch, um_ref: um_ref_stub() },
    [alloc_input(d, 0)],
    outs,
    sigs,
    tk.window_from(tk.start_epoch * 86_400_000),
    tk.mk_ref(#"a0", 0),
  )
}

// ── ClaimEpoch: đường ĐI ĐƯỢC ────────────────────────────────

test alloc_claim_happy() {
  let d = alloc_datum()
  claim_run(d, 100, [cont_ok(d, [100])], [tk.user_pkh])
}

// Epoch cuối cùng còn hợp lệ là expiry_epoch - 1 = 105.
test alloc_claim_last_epoch_happy() {
  let d = alloc_datum()
  claim_run(d, 105, [cont_ok(d, [105])], [tk.user_pkh])
}

// Chèn giữa dãy: đã claim [100, 102], nay claim 101 → danh sách phải là
// [100, 101, 102] (đúng thứ tự tăng dần mà validator tự sắp).
test alloc_claim_middle_epoch_sorted_happy() {
  let d = AllocationDatum { ..alloc_datum(), claimed_epochs: [100, 102] }
  claim_run(d, 101, [cont_ok(d, [100, 101, 102])], [tk.user_pkh])
}

// ── ClaimEpoch: ca QUYỀN ─────────────────────────────────────
//
// Đây là lớp lỗi của nợ #36 (ConsumeMAGIC): "ai cũng ghi được vào bản ghi người
// khác". Ba test dưới chứng minh nhánh này KHÔNG dính lỗi đó.

test alloc_claim_no_signature_fail() fail {
  let d = alloc_datum()
  claim_run(d, 100, [cont_ok(d, [100])], [])
}

test alloc_claim_attacker_signature_fail() fail {
  let d = alloc_datum()
  claim_run(d, 100, [cont_ok(d, [100])], [tk.attacker_pkh])
}

// Org KHÔNG được tiêu quyền thay người thụ hưởng.
test alloc_claim_org_signature_fail() fail {
  let d = alloc_datum()
  claim_run(d, 100, [cont_ok(d, [100])], [tk.org_pkh])
}

// ── ClaimEpoch: ca PHẠM VI + PHÁT LẠI ────────────────────────

test alloc_claim_epoch_below_start_fail() fail {
  let d = alloc_datum()
  claim_run(d, 99, [cont_ok(d, [99])], [tk.user_pkh])
}

// Đúng tại expiry_epoch đã phải chặn (`<` chứ không phải `<=`).
test alloc_claim_epoch_at_expiry_fail() fail {
  let d = alloc_datum()
  claim_run(d, 106, [cont_ok(d, [106])], [tk.user_pkh])
}

// G-ALLOC-2: tiêu lại đúng epoch đã tiêu → chặn.
test alloc_claim_replay_same_epoch_fail() fail {
  let d = AllocationDatum { ..alloc_datum(), claimed_epochs: [100] }
  claim_run(d, 100, [cont_ok(d, [100, 100])], [tk.user_pkh])
}

// ── ClaimEpoch: ca VOUCHER (G-ALLOC-1/5) ─────────────────────

// Voucher bị XOAY: ô 0 chứa chữ ký của epoch 101. Claim epoch 100 phải chặn —
// nếu không, một voucher bất kỳ mở được mọi epoch.
test alloc_claim_voucher_from_wrong_epoch_fail() fail {
  let d = AllocationDatum { ..alloc_datum(), vouchers: tk.vouchers_rotated() }
  claim_run(d, 100, [cont_ok(d, [100])], [tk.user_pkh])
}

// Ô 0 do kẻ tấn công ký, datum.oracle_vkey vẫn là oracle thật → chặn.
test alloc_claim_voucher_signed_by_other_key_fail() fail {
  let d = AllocationDatum { ..alloc_datum(), vouchers: tk.vouchers_forged_first() }
  claim_run(d, 100, [cont_ok(d, [100])], [tk.user_pkh])
}

// Danh sách voucher rỗng → không có ô nào → chặn (list.at trả None).
test alloc_claim_no_voucher_fail() fail {
  let d = AllocationDatum { ..alloc_datum(), vouchers: [] }
  claim_run(d, 100, [cont_ok(d, [100])], [tk.user_pkh])
}

// Voucher rác 64 byte → chặn.
test alloc_claim_garbage_voucher_fail() fail {
  let d =
    AllocationDatum {
      ..alloc_datum(),
      vouchers: [
        #"00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      ],
    }
  claim_run(d, 100, [cont_ok(d, [100])], [tk.user_pkh])
}

// Voucher gắn CHẶT vào magic_per_epoch: đổi số tiền trong datum thì chữ ký cũ
// không còn khớp. Đây là dòng duy nhất ràng "số MAGIC mỗi epoch" vào oracle.
test alloc_claim_inflated_magic_per_epoch_fail() fail {
  let d = AllocationDatum { ..alloc_datum(), magic_per_epoch: 999_000_000_000 }
  claim_run(d, 100, [cont_ok(d, [100])], [tk.user_pkh])
}

// Voucher cũng gắn vào alloc_id → không mượn được voucher của phân bổ khác.
test alloc_claim_swapped_alloc_id_fail() fail {
  let d =
    AllocationDatum {
      ..alloc_datum(),
      alloc_id: #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    }
  claim_run(d, 100, [cont_ok(d, [100])], [tk.user_pkh])
}

// ── ClaimEpoch: ca GIÁ TRỊ — số âm và tràn 64 bit ────────────
//
// Cả ba đại lượng dưới đây đi thẳng vào `integer_to_bytearray(8 byte)`. Aiken
// KHÔNG bọc vòng: builtin nổ, giao dịch bị từ chối. Chốt hành vi đó lại để không
// ai "tối ưu" nó thành phép cắt bit.

test alloc_claim_negative_magic_per_epoch_fail() fail {
  let d = AllocationDatum { ..alloc_datum(), magic_per_epoch: -1 }
  claim_run(d, 100, [cont_ok(d, [100])], [tk.user_pkh])
}

test alloc_claim_magic_per_epoch_overflow_fail() fail {
  let d =
    AllocationDatum {
      ..alloc_datum(),
      magic_per_epoch: 18_446_744_073_709_551_616,
    }
  claim_run(d, 100, [cont_ok(d, [100])], [tk.user_pkh])
}

// expiry_epoch × 86_400_000 vượt 2^64 → nổ. Một datum có expiry_epoch quá lớn là
// UTxO chết: không claim được, chỉ ReclaimExpired mới gỡ ra.
test alloc_claim_expiry_epoch_overflow_fail() fail {
  let d = AllocationDatum { ..alloc_datum(), expiry_epoch: 300_000_000_000 }
  claim_run(d, 100, [cont_ok(d, [100])], [tk.user_pkh])
}

// ── ClaimEpoch: datum tiếp tục phải giữ nguyên mọi trường khác ─

test alloc_claim_output_drops_claimed_history_fail() fail {
  let d = AllocationDatum { ..alloc_datum(), claimed_epochs: [100] }
  // Output "quên" epoch 100 đã tiêu → G-ALLOC-2 vỡ nếu lọt.
  claim_run(d, 101, [cont_ok(d, [101])], [tk.user_pkh])
}

// Chèn thừa một epoch chưa hề được cấp voucher → chặn.
test alloc_claim_output_injects_extra_epoch_fail() fail {
  let d = alloc_datum()
  claim_run(d, 100, [cont_ok(d, [100, 101])], [tk.user_pkh])
}

// Danh sách không theo thứ tự tăng dần → chặn (tính xác định của so sánh datum).
test alloc_claim_output_unsorted_claimed_fail() fail {
  let d = AllocationDatum { ..alloc_datum(), claimed_epochs: [100, 102] }
  claim_run(d, 101, [cont_ok(d, [100, 102, 101])], [tk.user_pkh])
}

test alloc_claim_output_swaps_beneficiary_fail() fail {
  let d = alloc_datum()
  let evil: Data =
    AllocationDatum {
      ..d,
      claimed_epochs: [100],
      beneficiary_pkh: tk.attacker_pkh,
    }
  claim_run(d, 100, [tk.mk_output(alloc_addr(), tk.rich_value(), evil)], [tk.user_pkh])
}

// Đổi trust-root ở output → chặn. (Trust-root vẫn hỏng ở chỗ khác — xem POC dưới.)
test alloc_claim_output_swaps_oracle_vkey_fail() fail {
  let d = alloc_datum()
  let evil: Data =
    AllocationDatum { ..d, claimed_epochs: [100], oracle_vkey: tk.attacker_vkey }
  claim_run(d, 100, [tk.mk_output(alloc_addr(), tk.rich_value(), evil)], [tk.user_pkh])
}

test alloc_claim_output_inflates_magic_per_epoch_fail() fail {
  let d = alloc_datum()
  let evil: Data =
    AllocationDatum {
      ..d,
      claimed_epochs: [100],
      magic_per_epoch: 999_000_000_000,
    }
  claim_run(d, 100, [tk.mk_output(alloc_addr(), tk.rich_value(), evil)], [tk.user_pkh])
}

test alloc_claim_output_extends_expiry_fail() fail {
  let d = alloc_datum()
  let evil: Data =
    AllocationDatum { ..d, claimed_epochs: [100], expiry_epoch: 100_000 }
  claim_run(d, 100, [tk.mk_output(alloc_addr(), tk.rich_value(), evil)], [tk.user_pkh])
}

test alloc_claim_output_replaces_vouchers_fail() fail {
  let d = alloc_datum()
  let evil: Data =
    AllocationDatum {
      ..d,
      claimed_epochs: [100],
      vouchers: tk.vouchers_attacker_first(),
    }
  claim_run(d, 100, [tk.mk_output(alloc_addr(), tk.rich_value(), evil)], [tk.user_pkh])
}

// Không có output tiếp tục nào → chặn. UTxO không được phép biến mất.
test alloc_claim_no_continuing_output_fail() fail {
  let d = alloc_datum()
  claim_run(
    d,
    100,
    [tk.mk_output_no_datum(tk.vk_address(tk.attacker_pkh), tk.rich_value())],
    [tk.user_pkh],
  )
}

// ── POC: KL-1 — ràng buộc output tiếp tục còn hở ─────────────

// 🔴 KỲ VỌNG PASS = LỖ HỔNG, đúng lớp lỗi của nợ #35 (ScheduleGen).
// `continuing_output_ok` duyệt tx.outputs bằng list.any và CHỈ so nội dung datum.
// Nó không hỏi output nằm ở đâu. Ở đây bản ghi phân bổ — cùng toàn bộ giá trị —
// được chuyển thẳng vào VÍ TRẦN của kẻ tấn công. Từ giây đó validator không còn
// canh giữ nó nữa: mọi epoch còn lại tiêu được không cần voucher, không cần ai ký.
test poc_claim_continuing_output_leaves_script_address() {
  let d = alloc_datum()
  claim_run(
    d,
    100,
    [cont_out(d, [100], tk.vk_address(tk.attacker_pkh), tk.rich_value())],
    [tk.user_pkh],
  )
}

// 🔴 KỲ VỌNG PASS = LỖ HỔNG (ca GIÁ TRỊ).
// Datum tiếp tục đúng từng byte, đặt đúng địa chỉ script — nhưng giá trị bị vét:
// 100 ADA + token quyền vào, ra còn 1 ADA và không token, phần chênh về ví kẻ tấn
// công. Không có dòng nào bảo toàn giá trị.
test poc_claim_drains_utxo_value() {
  let d = alloc_datum()
  claim_run(
    d,
    100,
    [
      cont_out(d, [100], alloc_addr(), tk.drained_value()),
      tk.mk_output_no_datum(tk.vk_address(tk.attacker_pkh), tk.rich_value()),
    ],
    [tk.user_pkh],
  )
}

// 🔴 KỲ VỌNG PASS = DOUBLE SATISFACTION.
// Validator này KHÔNG có NFT định danh (khác INV-VAULT-IDENTITY của các vault
// khác trong repo), nên hai UTxO ở cùng địa chỉ script mang datum GIỐNG HỆT nhau
// là hợp lệ về hình thức. Một giao dịch tiêu cả hai, chỉ tạo MỘT output tiếp tục:
// `list.any` thoả cho cả hai input. Hai bản ghi thu về một, người thụ hưởng mất
// một nửa số epoch — hoặc, nhìn từ phía kia, một output "trả nợ" cho hai đầu vào.
test poc_claim_double_satisfaction_two_inputs_one_output() {
  let d = alloc_datum()
  let raw: Data = d
  let ins = [alloc_input(d, 0), alloc_input(d, 1)]
  let outs = [cont_ok(d, [100])]
  let rd = ClaimEpoch { epoch: 100, um_ref: um_ref_stub() }
  let vr = tk.window_from(tk.start_epoch * 86_400_000)
  alloc_run(raw, rd, ins, outs, [tk.user_pkh], vr, tk.mk_ref(#"a0", 0)) && alloc_run(
    raw,
    rd,
    ins,
    outs,
    [tk.user_pkh],
    vr,
    tk.mk_ref(#"a0", 1),
  )
}

// ── POC: KL-2 / nợ #34 — trust-root nằm TRONG chính datum ────

// 🔴 KỲ VỌNG PASS = LỖ HỔNG GỐC.
// `oracle_vkey` là một TRƯỜNG của đúng cái datum mà nó xác minh, và validator
// không nhận tham số nào neo nó lại. Kẻ tấn công tự tạo một UTxO ở địa chỉ script
// với: oracle_vkey = khoá của mình, beneficiary = mình, voucher do mình ký. Không
// một dòng nào trong validator hỏi "khoá này của ai" — claim đi qua sạch.
//
// Ghép với `poc_settle_produces_attacker_controlled_alloc_datum` ở otc_order.ak,
// đây là chuỗi tấn công đầy đủ: settle một đơn bất kỳ → tự cấp bản ghi phân bổ →
// tự ký voucher → tiêu quyền. Không cần oracle thật ở bước nào sau Settle.
test poc_claim_self_signed_oracle_is_accepted() {
  let evil =
    AllocationDatum {
      ..alloc_datum(),
      beneficiary_pkh: tk.attacker_pkh,
      oracle_vkey: tk.attacker_vkey,
      vouchers: tk.vouchers_attacker_first(),
    }
  claim_run(evil, 100, [cont_ok(evil, [100])], [tk.attacker_pkh])
}

// ── ReclaimExpired ───────────────────────────────────────────

fn reclaim_run(d: AllocationDatum, lo: Int, sigs: List<ByteArray>) -> Bool {
  let raw: Data = d
  alloc_run(
    raw,
    ReclaimExpired,
    [alloc_input(d, 0)],
    [tk.mk_output_no_datum(tk.vk_address(tk.org_pkh), tk.rich_value())],
    sigs,
    tk.window_from(lo),
    tk.mk_ref(#"a0", 0),
  )
}

test alloc_reclaim_happy() {
  reclaim_run(alloc_datum(), tk.expiry_posix + 1, [tk.org_pkh])
}

// Biên: đúng tại expiry_posix vẫn chưa mở (`>` chứ không phải `>=`).
test alloc_reclaim_at_boundary_fail() fail {
  reclaim_run(alloc_datum(), tk.expiry_posix, [tk.org_pkh])
}

// Ca QUYỀN: người thụ hưởng không thu hồi thay org được.
test alloc_reclaim_by_beneficiary_fail() fail {
  reclaim_run(alloc_datum(), tk.expiry_posix + 1, [tk.user_pkh])
}

test alloc_reclaim_by_attacker_fail() fail {
  reclaim_run(alloc_datum(), tk.expiry_posix + 1, [tk.attacker_pkh])
}

test alloc_reclaim_no_signature_fail() fail {
  reclaim_run(alloc_datum(), tk.expiry_posix + 1, [])
}

// Cận dưới không chặn → tx_lower_ms mặc định 0 → chưa hết hạn → chặn. An toàn.
test alloc_reclaim_unbounded_lower_bound_fails_safe() fail {
  let d = alloc_datum()
  let raw: Data = d
  alloc_run(
    raw,
    ReclaimExpired,
    [alloc_input(d, 0)],
    [tk.mk_output_no_datum(tk.vk_address(tk.org_pkh), tk.rich_value())],
    [tk.org_pkh],
    tk.window_unbounded(),
    tk.mk_ref(#"a0", 0),
  )
}

// 🔴 KỲ VỌNG PASS = hành vi cần chủ dự án xác nhận, không phải lỗi mã.
// Sau hạn, org thu hồi TOÀN BỘ UTxO mà không một output nào bị ràng buộc, kể cả
// khi người thụ hưởng chưa tiêu epoch nào. Nếu mô hình muốn "quyền chưa tiêu thì
// mất", đây đúng ý; nếu muốn hoàn một phần, chỗ này thiếu ràng buộc.
test poc_reclaim_takes_everything_with_zero_epochs_claimed() {
  let d = AllocationDatum { ..alloc_datum(), claimed_epochs: [] }
  let raw: Data = d
  alloc_run(
    raw,
    ReclaimExpired,
    [alloc_input(d, 0)],
    [tk.mk_output_no_datum(tk.vk_address(tk.org_pkh), tk.rich_value())],
    [tk.org_pkh],
    tk.window_from(tk.expiry_posix + 1),
    tk.mk_ref(#"a0", 0),
  )
}

// ── Surrender ────────────────────────────────────────────────

fn surrender_run(d: AllocationDatum, outs: List<Output>, sigs: List<ByteArray>) -> Bool {
  let raw: Data = d
  alloc_run(
    raw,
    Surrender,
    [alloc_input(d, 0)],
    outs,
    sigs,
    tk.window_from(tk.start_epoch * 86_400_000),
    tk.mk_ref(#"a0", 0),
  )
}

test alloc_surrender_happy() {
  surrender_run(
    alloc_datum(),
    [tk.mk_output_no_datum(tk.vk_address(tk.user_pkh), tk.rich_value())],
    [tk.user_pkh],
  )
}

test alloc_surrender_no_signature_fail() fail {
  surrender_run(
    alloc_datum(),
    [tk.mk_output_no_datum(tk.vk_address(tk.attacker_pkh), tk.rich_value())],
    [],
  )
}

// Ca QUYỀN: org KHÔNG ép người thụ hưởng từ bỏ quyền được.
test alloc_surrender_by_org_fail() fail {
  surrender_run(
    alloc_datum(),
    [tk.mk_output_no_datum(tk.vk_address(tk.org_pkh), tk.rich_value())],
    [tk.org_pkh],
  )
}

test alloc_surrender_by_attacker_fail() fail {
  surrender_run(
    alloc_datum(),
    [tk.mk_output_no_datum(tk.vk_address(tk.attacker_pkh), tk.rich_value())],
    [tk.attacker_pkh],
  )
}

// 🔴 KỲ VỌNG PASS = rủi ro còn lại của Surrender.
// Chữ ký người thụ hưởng là điều kiện DUY NHẤT; không output nào bị ràng. Ai dựng
// giao dịch cũng lấy trọn giá trị. Người thụ hưởng ký nhầm một giao dịch tưởng là
// claim thì mất sạch — không có lưới an toàn on-chain nào.
test poc_surrender_value_goes_anywhere() {
  surrender_run(
    alloc_datum(),
    [tk.mk_output_no_datum(tk.vk_address(tk.attacker_pkh), tk.rich_value())],
    [tk.user_pkh],
  )
}

// ── Datum ────────────────────────────────────────────────────

test alloc_missing_datum_fail() fail {
  let tx =
    Transaction {
      ..placeholder,
      validity_range: tk.window_from(tk.start_epoch * 86_400_000),
    }
  magic_allocation.spend(None, Surrender, tk.mk_ref(#"a0", 0), tx)
}

test alloc_wrong_datum_shape_fail() fail {
  let junk: Data = 42
  alloc_run(
    junk,
    Surrender,
    [],
    [],
    [tk.user_pkh],
    tk.window_from(tk.start_epoch * 86_400_000),
    tk.mk_ref(#"a0", 0),
  )
}
