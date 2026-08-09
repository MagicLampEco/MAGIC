// PriceParam beacon spend validator (CONTRACT.md §B1).
// Committee/keeper post bảng giá + demand_mult mới mỗi epoch. Authenticity = NFT.
// Genesis beacon tạo lúc deploy (pay-to-address + mint NFT one-shot). Update sau
// = spend + re-create với epoch ĐƠN ĐIỆU TĂNG (chống rollback giá cũ).

use aiken/collection/list
use aiken/interval
use cardano/address.{Address}
use cardano/assets
use cardano/transaction.{InlineDatum, OutputReference, Transaction, placeholder}
use magiclamp/consume/pricing
use magiclamp/consume/types.{OpPrice, PostPrice, PriceParam, PriceParamRedeemer}
use magiclamp/consume/util

/// Apply-param:
///   committee / threshold : M-of-N khoá công (PHẢI phân biệt đôi một — xem dưới)
///   price_nft_policy / price_nft_name : authenticity NFT của beacon
///   ms_per_epoch : POSIX ms / epoch (network-specific) — dùng để CHẶN TRẦN `epoch`
///                  của datum theo thời gian THẬT (VÁ #4).
validator price_param(
  committee         : List<ByteArray>,
  threshold         : Int,
  price_nft_policy  : ByteArray,
  price_nft_name    : ByteArray,
  ms_per_epoch      : Int,
) {
  spend(
    datum_opt : Option<PriceParam>,
    _redeemer : PriceParamRedeemer,
    own_ref   : OutputReference,
    tx        : Transaction,
  ) {
    expect Some(datum) = datum_opt
    let own_addr = util.own_address(own_ref, tx.inputs)
    let own_hash = util.own_script_hash(own_addr)

    // Beacon không liên quan mint (NFT bảo toàn, không đốt/đúc thêm ở đây).
    expect assets.is_zero(tx.mint)

    // single-input + single-output theo SCRIPT HASH (chống double-satisfaction).
    expect util.count_inputs_at_script(tx.inputs, own_hash) == 1
    expect util.count_outputs_at_script(tx.outputs, own_hash) == 1

    // ── VÁ #3: NGƯỠNG MULTISIG PHẢI THẬT ───────────────────────────────────────
    //   `count_sigs` đếm PHẦN TỬ DANH SÁCH, không đếm NGƯỜI. Không có 3 ràng buộc
    //   dưới đây thì "M-of-N" là ảo:
    //     - committee trùng khoá: [c1, c1, c2] + threshold=2 ⇒ MỘT MÌNH c1 ký đã
    //       đếm 2 ⇒ đơn phương post bảng giá (vd base_price=2, vẫn qua GATE
    //       base×m_min ≥ q) ⇒ 1 nghiệp vụ giá 2 nanogic thay vì 10.000.000.
    //     - threshold = 0 ⇒ KHÔNG cần chữ ký nào ⇒ ai cũng post giá.
    //     - threshold > len(committee) ⇒ KHÔNG BAO GIỜ đạt ⇒ beacon kẹt vĩnh viễn
    //       (fail-closed nhưng là brick — bắt lỗi cấu hình ngay tại chỗ).
    //   Đây là param BAKE compile-time (deployer kiểm soát) nên O(n²) an toàn.
    expect threshold > 0
    expect threshold <= list.length(committee)
    expect util.all_distinct(committee)
    expect count_sigs(committee, tx.extra_signatories) >= threshold

    let beacon_in = util.input_at_script(tx.inputs, own_hash)
    let beacon_out = util.output_at_script(tx.outputs, own_hash)
    expect InlineDatum(d) = beacon_out.datum
    expect out_datum: PriceParam = d

    // ── VÁ #6: ĐỊA CHỈ ĐẦY ĐỦ + ADA KHÔNG GIẢM ────────────────────────────────
    //   count_*_at_script chỉ pin payment_credential ⇒ đổi được stake_credential
    //   (địa chỉ bech32 đổi ⇒ mọi công cụ off-chain index theo địa chỉ MẤT DẤU
    //   beacon, dù script hash không đổi) và rút ADA về min-UTxO. So địa chỉ ĐẦY ĐỦ
    //   + lovelace không giảm ⇒ beacon đứng yên đúng chỗ, không bị bào mòn.
    expect beacon_out.address == beacon_in.address
    expect assets.lovelace_of(beacon_out.value) >= assets.lovelace_of(beacon_in.value)

    // epoch đơn điệu TĂNG (chống rollback về giá thấp khi demand đã lên).
    expect out_datum.epoch > datum.epoch

    // ── VÁ #4: TRẦN epoch THEO THỜI GIAN THẬT ─────────────────────────────────
    //   Chỉ có "đơn điệu tăng" mà KHÔNG có trần: một lần post epoch = 1e18 là mọi
    //   tx consume reject VĨNH VIỄN (stale-check `current ≥ pp.epoch` không bao giờ
    //   thoả), và epoch KHÔNG hạ xuống được (đơn điệu) ⇒ chỉ còn đường redeploy;
    //   redeploy đổi price_nft_policy ⇒ đổi hash `consume` ⇒ mọi Engage UTxO cũ
    //   thành rác. `util.get_epoch` đòi CẢ HAI biên Finite + cùng epoch ⇒ committee
    //   không thể tự nới trần bằng validity-range.
    expect out_datum.epoch <= util.get_epoch(tx, ms_per_epoch)

    // datum mới phải hợp lệ (clamp invariant) — không post giá rác.
    expect pricing.valid_param(out_datum)

    // authenticity NFT bảo toàn (đúng 1 token in/out, không rút).
    let nft_in = assets.quantity_of(beacon_in.value, price_nft_policy, price_nft_name)
    let nft_out = assets.quantity_of(beacon_out.value, price_nft_policy, price_nft_name)
    expect nft_in == 1
    expect nft_out == 1
    True
  }

  else(_) {
    fail
  }
}

/// Đếm SỐ PHẦN TỬ committee có chữ ký. Chỉ đúng nghĩa "số NGƯỜI ký" khi committee đã
/// được ép phân biệt đôi một (`util.all_distinct`) ở chỗ gọi — xem VÁ #3.
fn count_sigs(committee: List<ByteArray>, sigs: List<ByteArray>) -> Int {
  list.count(committee, fn(k) { list.has(sigs, k) })
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

const pp_sh: ByteArray = #"d0d0"

const pp_committee: List<ByteArray> = [#"c1", #"c2", #"c3"]

const pp_threshold: Int = 2

const pp_nft_policy: ByteArray = #"9999"

const pp_nft_name: ByteArray = #"5052494345"

fn mk_pp(epoch: Int, demand: Int) -> PriceParam {
  PriceParam {
    op_prices: [
      OpPrice { op_type: 1, base_price: 10_000_000 },
      OpPrice { op_type: 2, base_price: 1_000_000 },
    ],
    demand_mult: demand,
    m_min: 500_000_000,
    m_max: 2_000_000_000,
    epoch: epoch,
  }
}

const pp_mspe: Int = 86_400_000

/// tx post giá; `now_epoch` = epoch THẬT theo validity_range (cửa sổ trọn trong epoch).
fn pp_tx_at(
  in_epoch   : Int,
  out_epoch  : Int,
  out_demand : Int,
  sigs       : List<ByteArray>,
  now_epoch  : Int,
) -> Transaction {
  let addr = util.script_address(pp_sh)
  pp_tx_full(in_epoch, out_epoch, out_demand, sigs, now_epoch, addr, 2_000_000, 2_000_000)
}

/// Bản đầy đủ: cho phép đổi địa chỉ output + lovelace in/out (test VÁ #6).
fn pp_tx_full(
  in_epoch   : Int,
  out_epoch  : Int,
  out_demand : Int,
  sigs       : List<ByteArray>,
  now_epoch  : Int,
  out_addr   : Address,
  lovelace_in  : Int,
  lovelace_out : Int,
) -> Transaction {
  let in_addr = util.script_address(pp_sh)
  let v_in = assets.add(assets.from_lovelace(lovelace_in), pp_nft_policy, pp_nft_name, 1)
  let v_out = assets.add(assets.from_lovelace(lovelace_out), pp_nft_policy, pp_nft_name, 1)
  let b_in = util.mk_input(util.mk_ref(0), util.mk_output(in_addr, v_in, mk_pp(in_epoch, 1_000_000_000)))
  let b_out = util.mk_output(out_addr, v_out, mk_pp(out_epoch, out_demand))
  Transaction {
    ..placeholder,
    inputs: [b_in],
    outputs: [b_out],
    extra_signatories: sigs,
    mint: assets.zero,
    // Cửa sổ nằm TRỌN trong now_epoch (get_epoch đòi 2 biên Finite + cùng epoch).
    validity_range: interval.between(now_epoch * pp_mspe, now_epoch * pp_mspe + 1),
  }
}

/// Mặc định: thời gian thật == epoch được post (trường hợp vận hành bình thường).
fn pp_tx(in_epoch: Int, out_epoch: Int, out_demand: Int, sigs: List<ByteArray>) -> Transaction {
  pp_tx_at(in_epoch, out_epoch, out_demand, sigs, out_epoch)
}

fn pp_spend(committee: List<ByteArray>, threshold: Int, tx: Transaction) -> Bool {
  price_param.spend(
    committee, threshold, pp_nft_policy, pp_nft_name, pp_mspe,
    Some(mk_pp(5, 1_000_000_000)), PostPrice, util.mk_ref(0), tx,
  )
}

test price_param_happy() {
  pp_spend(pp_committee, pp_threshold, pp_tx(5, 6, 1_500_000_000, [#"c1", #"c2"]))
}

test price_param_epoch_not_increasing() fail {
  pp_spend(pp_committee, pp_threshold, pp_tx(5, 5, 1_500_000_000, [#"c1", #"c2"]))
}

test price_param_insufficient_sigs() fail {
  pp_spend(pp_committee, pp_threshold, pp_tx(5, 6, 1_500_000_000, [#"c1"]))
}

test price_param_invalid_clamp() fail {
  // out demand_mult > m_max → valid_param false → reject.
  pp_spend(pp_committee, pp_threshold, pp_tx(5, 6, 3_000_000_000, [#"c1", #"c2"]))
}

// ── VÁ #3: ngưỡng multisig phải THẬT ──────────────────────────────────────────

test price_param_duplicate_committee_fail() fail {
  // committee=[c1,c1,c2], threshold=2: MỘT MÌNH c1 ký ⇒ count_sigs đếm 2 ⇒ "2-of-3"
  // mở bằng 1 khoá ⇒ đơn phương post bảng giá. Sau vá: all_distinct → REJECT.
  pp_spend([#"c1", #"c1", #"c2"], 2, pp_tx(5, 6, 1_500_000_000, [#"c1"]))
}

test price_param_zero_threshold_fail() fail {
  // threshold=0 ⇒ không cần chữ ký nào ⇒ AI CŨNG post được giá. Sau vá: REJECT.
  pp_spend(pp_committee, 0, pp_tx(5, 6, 1_500_000_000, []))
}

test price_param_threshold_over_committee_fail() fail {
  // threshold=4 > len(committee)=3 ⇒ không bao giờ đạt ⇒ beacon brick. REJECT sớm.
  pp_spend(pp_committee, 4, pp_tx(5, 6, 1_500_000_000, [#"c1", #"c2", #"c3"]))
}

test price_param_full_committee_threshold_happy() {
  // Biên hợp lệ: threshold == len(committee), đủ chữ ký phân biệt → pass.
  pp_spend(pp_committee, 3, pp_tx(5, 6, 1_500_000_000, [#"c1", #"c2", #"c3"]))
}

// ── VÁ #4: trần epoch theo thời gian THẬT ─────────────────────────────────────

test price_param_epoch_beyond_validity_fail() fail {
  // epoch = 1e18 trong khi thời gian thật là epoch 6. Trước vá: pass (chỉ cần > 5)
  // ⇒ mọi tx consume reject VĨNH VIỄN, không hạ được (đơn điệu) ⇒ brick toàn cơ chế.
  pp_spend(pp_committee, pp_threshold, pp_tx_at(5, 1_000_000_000_000_000_000, 1_500_000_000, [#"c1", #"c2"], 6))
}

test price_param_epoch_one_ahead_fail() fail {
  // Chặt tới biên: post epoch 7 khi thời gian thật mới là epoch 6 → REJECT.
  pp_spend(pp_committee, pp_threshold, pp_tx_at(5, 7, 1_500_000_000, [#"c1", #"c2"], 6))
}

test price_param_epoch_behind_now_happy() {
  // epoch 6 ≤ now 9 (post muộn) vẫn hợp lệ — trần là TRÊN, không phải bằng.
  pp_spend(pp_committee, pp_threshold, pp_tx_at(5, 6, 1_500_000_000, [#"c1", #"c2"], 9))
}

test price_param_unbounded_validity_fail() fail {
  // validity_range hở trên ⇒ get_epoch từ chối ⇒ committee không tự nới trần epoch.
  let addr = util.script_address(pp_sh)
  let nft_val = assets.add(assets.from_lovelace(2_000_000), pp_nft_policy, pp_nft_name, 1)
  let b_in = util.mk_input(util.mk_ref(0), util.mk_output(addr, nft_val, mk_pp(5, 1_000_000_000)))
  let b_out = util.mk_output(addr, nft_val, mk_pp(6, 1_500_000_000))
  let tx =
    Transaction {
      ..placeholder,
      inputs: [b_in],
      outputs: [b_out],
      extra_signatories: [#"c1", #"c2"],
      mint: assets.zero,
      validity_range: interval.after(6 * pp_mspe),
    }
  pp_spend(pp_committee, pp_threshold, tx)
}

// ── VÁ #6: địa chỉ ĐẦY ĐỦ + ADA không giảm ────────────────────────────────────

test price_param_stake_credential_changed_fail() fail {
  // Cùng payment_credential nhưng thêm stake_credential ⇒ địa chỉ bech32 ĐỔI ⇒ công
  // cụ off-chain index theo địa chỉ mất dấu beacon. Sau vá: so address ĐẦY ĐỦ → REJECT.
  let tx =
    pp_tx_full(
      5, 6, 1_500_000_000, [#"c1", #"c2"], 6,
      util.script_address_staked(pp_sh, #"5ee5"), 2_000_000, 2_000_000,
    )
  pp_spend(pp_committee, pp_threshold, tx)
}

test price_param_lovelace_drain_fail() fail {
  // Rút ADA beacon 2 → 1 ADA. Sau vá: lovelace_out ≥ lovelace_in → REJECT.
  let tx =
    pp_tx_full(
      5, 6, 1_500_000_000, [#"c1", #"c2"], 6,
      util.script_address(pp_sh), 2_000_000, 1_000_000,
    )
  pp_spend(pp_committee, pp_threshold, tx)
}

test price_param_lovelace_topup_happy() {
  // Nạp thêm ADA vào beacon vẫn hợp lệ (ràng buộc là ≥, không phải ==).
  let tx =
    pp_tx_full(
      5, 6, 1_500_000_000, [#"c1", #"c2"], 6,
      util.script_address(pp_sh), 2_000_000, 5_000_000,
    )
  pp_spend(pp_committee, pp_threshold, tx)
}
