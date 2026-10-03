// Beacon suất sinh ρ (SPEC v2.4 §6.1.4, §13 `INV-RATE-GOVERNED`, `INV-RATE-KEY-SINGLE`).
//
// Một UTxO mang NFT one-shot `(hash script này, "RHO")`, datum `RateParam` inline. Két
// đọc qua reference input rồi gọi `genbeacons/rate.rho_at(datum, epoch hiện tại)`.
//
// Bất biến validator ép:
//   - chỉ khoá đăng (1-of-1) đổi được ρ;
//   - `0 ≤ rho_q ≤ rho_max_q` — trần cứng biên dịch là ĐIỀU KIỆN ĐỦ để mở đường đăng
//     (`INV-RATE-GOVERNED`); trần chặn BIÊN ĐỘ, không chặn TẦN SUẤT (`INV-RATE-KEY-SINGLE`);
//   - GENESIS (mint): ρ đầu tiên hiệu lực NGAY trong epoch đăng (`effective_epoch == now`,
//     `prev_rho_q == 0`) — người dùng có LAMP và GreenBack có thặng dư thì sinh được ngay,
//     không phải chờ epoch sau (chủ dự án chốt 2026-10-03);
//   - CẬP NHẬT (spend): giá trị mới hiệu lực từ epoch SAU epoch đăng, và `prev_rho_q` = ρ
//     đang hiệu lực trước lượt này ⟹ ρ hằng trong MỌI epoch theo góc nhìn của két, kể cả
//     khi đăng nhiều lần trong một epoch;
//   - NFT ở lại đúng địa chỉ, datum inline.
//
// Vì sao genesis được hiệu lực ngay mà bất biến "ρ hằng trong mỗi epoch" vẫn giữ: trước
// genesis chưa có beacon, mà két đọc ρ bằng `expect [beacon]` (thiếu beacon ⟹ giao dịch
// két hỏng), nên KHÔNG két nào đọc được một ρ nào trong epoch đó trước lượt genesis. Từ
// lượt genesis trở đi, mọi lượt đọc trong epoch đăng đều thấy cùng `rho_q`. Luật "epoch
// sau" chỉ cần ở nhánh cập nhật — chỗ đã có két đọc ρ cũ trong epoch hiện tại.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, OutputReference, Transaction, placeholder}
use genbeacons/constants
use genbeacons/rate
use genbeacons/types.{RateParam}
use genbeacons/util
use genbeacons/window_origin_fixtures

/// Apply-param (theo thứ tự):
///   rate_key     : khoá đăng ρ, 1-of-1 (`INV-RATE-KEY-SINGLE`).
///   rho_max_q    : trần cứng của ρ (Q-format). TẠM 4_000_000_000 — chủ dự án chốt giá
///                  trị ở `CC-GEN-RATE-VALUE` (SPEC §13).
///   ms_per_epoch : POSIX ms mỗi epoch theo mạng.
///   seed         : OutputReference neo policy NFT one-shot (policy = hash script này).
///   window_origin_ms : gốc lưới epoch theo mạng (POSIX ms), apply-param CUỐI —
///                  epoch = (t − window_origin_ms) / ms_per_epoch (WIN-ORIGIN-1,
///                  LAMP/Specs/Window/CONTRACT.md v1.0).
validator rate_param(
  rate_key: VerificationKeyHash,
  rho_max_q: Int,
  ms_per_epoch: Int,
  seed: OutputReference,
  window_origin_ms: Int,
) {
  // Genesis: đúc NFT + tạo UTxO beacon đầu tiên. ρ hiệu lực NGAY trong epoch đăng
  // (`effective_epoch == now`): trước lượt này không có beacon nên không két nào đã đọc
  // ρ trong epoch `now` ⟹ hiệu lực ngay không đổi ρ giữa epoch theo góc nhìn của két.
  // `prev_rho_q == 0` vẫn giữ: mọi epoch trước genesis có ρ = 0 (két đọc epoch cũ hơn
  // `now`, nếu có, thấy 0 — fail-closed).
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    expect ms_per_epoch > 0
    expect rho_max_q >= 0
    expect list.has(tx.extra_signatories, rate_key)
    let out = util.genesis_single(tx, policy_id, seed, constants.rate_nft_name)
    expect InlineDatum(d) = out.datum
    expect g: RateParam = d
    and {
      rate.rho_in_range(g.rho_q, rho_max_q),
      g.prev_rho_q == 0,
      g.effective_epoch == util.get_epoch(tx, ms_per_epoch, window_origin_ms),
    }
  }

  spend(
    datum_opt: Option<RateParam>,
    _redeemer: Data,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d_in) = datum_opt
    expect ms_per_epoch > 0
    expect list.has(tx.extra_signatories, rate_key)
    let (_, next) = util.continuing_pair(own_ref, tx, constants.rate_nft_name)
    expect InlineDatum(d) = next.datum
    expect d_out: RateParam = d
    let now = util.get_epoch(tx, ms_per_epoch, window_origin_ms)
    and {
      rate.rho_in_range(d_out.rho_q, rho_max_q),
      // ρ đang hiệu lực NGAY LÚC đăng — không phải `d_in.rho_q`. Đăng lần hai trong cùng
      // epoch thì `d_in.rho_q` là giá trị chưa hiệu lực, dùng nó sẽ đổi ρ giữa epoch.
      d_out.prev_rho_q == rate.rho_at(d_in, now),
      d_out.effective_epoch == now + 1,
    }
  }

  else(_) {
    fail
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

const rp_sh: ByteArray = #"a0a0a0"

const rp_key: ByteArray = #"b1b1b1"

const rp_max: Int = 4_000_000_000

const rp_mspe: Int = 86_400_000

const rp_seed: OutputReference = OutputReference {
  transaction_id: #"5eed",
  output_index: 0,
}

fn rp_nft_value(lovelace: Int) -> assets.Value {
  assets.add(assets.from_lovelace(lovelace), rp_sh, constants.rate_nft_name, 1)
}

fn rp_window(e: Int) -> interval.Interval {
  interval.between(e * rp_mspe, e * rp_mspe + 1)
}

/// Giao dịch đăng: input beacon mang `d_in`, output tại `out_addr` mang `d_out` với value
/// `out_value`, extra output tuỳ ý (để dựng ca NFT rời địa chỉ).
fn rp_tx_full(
  d_in: RateParam,
  d_out: RateParam,
  sigs: List<ByteArray>,
  now: Int,
  out_addr,
  out_value,
  extra_outputs,
) -> Transaction {
  let b_in =
    util.mk_input(
      util.mk_ref(#"00", 0),
      util.mk_output(util.script_address(rp_sh), rp_nft_value(2_000_000), d_in),
    )
  Transaction {
    ..placeholder,
    inputs: [b_in],
    outputs: [util.mk_output(out_addr, out_value, d_out), ..extra_outputs],
    extra_signatories: sigs,
    validity_range: rp_window(now),
  }
}

fn rp_tx(d_in: RateParam, d_out: RateParam, sigs, now: Int) -> Transaction {
  rp_tx_full(
    d_in,
    d_out,
    sigs,
    now,
    util.script_address(rp_sh),
    rp_nft_value(2_000_000),
    [],
  )
}

fn rp_spend(d_in: RateParam, tx: Transaction) -> Bool {
  rp_spend_at(0, d_in, tx)
}

/// Như `rp_spend` nhưng validator nhận gốc `origin`.
fn rp_spend_at(origin: Int, d_in: RateParam, tx: Transaction) -> Bool {
  rate_param.spend(
    rp_key,
    rp_max,
    rp_mspe,
    rp_seed,
    origin,
    Some(d_in),
    Void,
    util.mk_ref(#"00", 0),
    tx,
  )
}

/// Đầu vào chung: ρ = 3e9 hiệu lực từ epoch 5; hiện tại epoch 7.
const rp_in: RateParam =
  RateParam { rho_q: 3_000_000_000, prev_rho_q: 2_000_000_000, effective_epoch: 5 }

test rate_update_happy() {
  let out =
    RateParam { rho_q: 3_500_000_000, prev_rho_q: 3_000_000_000, effective_epoch: 8 }
  rp_spend(rp_in, rp_tx(rp_in, out, [rp_key], 7))
}

test rate_update_not_key_fail() fail {
  let out =
    RateParam { rho_q: 3_500_000_000, prev_rho_q: 3_000_000_000, effective_epoch: 8 }
  rp_spend(rp_in, rp_tx(rp_in, out, [#"cccccc"], 7))
}

test rate_update_at_max_happy() {
  let out =
    RateParam { rho_q: rp_max, prev_rho_q: 3_000_000_000, effective_epoch: 8 }
  rp_spend(rp_in, rp_tx(rp_in, out, [rp_key], 7))
}

test rate_update_over_max_fail() fail {
  let out =
    RateParam { rho_q: rp_max + 1, prev_rho_q: 3_000_000_000, effective_epoch: 8 }
  rp_spend(rp_in, rp_tx(rp_in, out, [rp_key], 7))
}

test rate_update_negative_fail() fail {
  let out = RateParam { rho_q: -1, prev_rho_q: 3_000_000_000, effective_epoch: 8 }
  rp_spend(rp_in, rp_tx(rp_in, out, [rp_key], 7))
}

test rate_update_effective_same_epoch_fail() fail {
  // Hiệu lực ngay trong epoch đăng ⟹ ρ đổi giữa epoch.
  let out =
    RateParam { rho_q: 3_500_000_000, prev_rho_q: 3_000_000_000, effective_epoch: 7 }
  rp_spend(rp_in, rp_tx(rp_in, out, [rp_key], 7))
}

test rate_update_effective_two_ahead_fail() fail {
  let out =
    RateParam { rho_q: 3_500_000_000, prev_rho_q: 3_000_000_000, effective_epoch: 9 }
  rp_spend(rp_in, rp_tx(rp_in, out, [rp_key], 7))
}

test rate_update_prev_wrong_fail() fail {
  // prev phải là ρ hiệu lực lúc đăng (3e9), không phải prev cũ (2e9).
  let out =
    RateParam { rho_q: 3_500_000_000, prev_rho_q: 2_000_000_000, effective_epoch: 8 }
  rp_spend(rp_in, rp_tx(rp_in, out, [rp_key], 7))
}

/// Đăng lần hai trong CÙNG epoch 7: input đang mang {3.5e9, prev 3e9, eff 8}.
const rp_in_pending: RateParam =
  RateParam { rho_q: 3_500_000_000, prev_rho_q: 3_000_000_000, effective_epoch: 8 }

test rate_second_update_same_epoch_happy() {
  // ρ hiệu lực ở epoch 7 vẫn là 3e9 ⟹ prev giữ 3e9.
  let out =
    RateParam { rho_q: 1_000_000_000, prev_rho_q: 3_000_000_000, effective_epoch: 8 }
  rp_spend(rp_in_pending, rp_tx(rp_in_pending, out, [rp_key], 7))
}

test rate_second_update_same_epoch_prev_pending_fail() fail {
  // Lấy prev = giá trị CHƯA hiệu lực (3.5e9) ⟹ ρ epoch 7 nhảy từ 3e9 lên 3.5e9 giữa epoch.
  let out =
    RateParam { rho_q: 1_000_000_000, prev_rho_q: 3_500_000_000, effective_epoch: 8 }
  rp_spend(rp_in_pending, rp_tx(rp_in_pending, out, [rp_key], 7))
}

test rate_update_nft_leaves_fail() fail {
  // Output tại script KHÔNG còn NFT; NFT đi sang ví khoá đăng.
  let out =
    RateParam { rho_q: 3_500_000_000, prev_rho_q: 3_000_000_000, effective_epoch: 8 }
  let tx =
    rp_tx_full(
      rp_in,
      out,
      [rp_key],
      7,
      util.script_address(rp_sh),
      assets.from_lovelace(2_000_000),
      [util.mk_output_no_datum(util.vk_address(rp_key), rp_nft_value(2_000_000))],
    )
  rp_spend(rp_in, tx)
}

test rate_update_other_address_fail() fail {
  // Cả UTxO (NFT + datum) chuyển sang ví: không còn output nào tại script.
  let out =
    RateParam { rho_q: 3_500_000_000, prev_rho_q: 3_000_000_000, effective_epoch: 8 }
  let tx =
    rp_tx_full(
      rp_in,
      out,
      [rp_key],
      7,
      util.vk_address(rp_key),
      rp_nft_value(2_000_000),
      [],
    )
  rp_spend(rp_in, tx)
}

// ── Genesis (mint) ────────────────────────────────────────────────────────────

fn rp_genesis_tx(
  g: RateParam,
  sigs: List<ByteArray>,
  spend_seed: Bool,
  now: Int,
) -> Transaction {
  let seed_in =
    util.mk_input(
      if spend_seed {
        rp_seed
      } else {
        util.mk_ref(#"0bad", 0)
      },
      util.mk_output_no_datum(util.vk_address(rp_key), assets.from_lovelace(9_000_000)),
    )
  Transaction {
    ..placeholder,
    inputs: [seed_in],
    outputs: [
      util.mk_output(util.script_address(rp_sh), rp_nft_value(2_000_000), g),
    ],
    mint: assets.from_asset(rp_sh, constants.rate_nft_name, 1),
    extra_signatories: sigs,
    validity_range: rp_window(now),
  }
}

fn rp_mint(tx: Transaction) -> Bool {
  rp_mint_at(0, tx)
}

/// Như `rp_mint` nhưng validator nhận gốc `origin`.
fn rp_mint_at(origin: Int, tx: Transaction) -> Bool {
  rate_param.mint(rp_key, rp_max, rp_mspe, rp_seed, origin, Void, rp_sh, tx)
}

/// Genesis ở epoch 7: ρ = 3e9 hiệu lực NGAY epoch 7 (`effective_epoch == now`).
const rp_genesis: RateParam =
  RateParam { rho_q: 3_000_000_000, prev_rho_q: 0, effective_epoch: 7 }

// Cặp phân biệt luật cũ (`now + 1`) với luật mới (`now`): ca dương `eff = now` đỏ dưới
// luật cũ; ca âm `eff = now + 1` xanh-thân (qua) dưới luật cũ ⟹ bài `fail` đỏ. Ca âm
// `eff = now − 1` chặn đột biến nới thành `<=`.

test rate_genesis_happy() {
  rp_mint(rp_genesis_tx(rp_genesis, [rp_key], True, 7))
}

test rate_genesis_rho_in_force_same_epoch() {
  // Mục tiêu của luật: ngay epoch genesis két đọc được ρ = rho_q, không phải 0.
  and {
    rp_mint(rp_genesis_tx(rp_genesis, [rp_key], True, 7)),
    rate.rho_at(rp_genesis, 7) == 3_000_000_000,
  }
}

test rate_genesis_no_seed_fail() fail {
  rp_mint(rp_genesis_tx(rp_genesis, [rp_key], False, 7))
}

test rate_genesis_not_key_fail() fail {
  rp_mint(rp_genesis_tx(rp_genesis, [#"cccccc"], True, 7))
}

test rate_genesis_over_max_fail() fail {
  rp_mint(
    rp_genesis_tx(
      RateParam { rho_q: rp_max + 1, prev_rho_q: 0, effective_epoch: 7 },
      [rp_key],
      True,
      7,
    ),
  )
}

test rate_genesis_prev_nonzero_fail() fail {
  // `effective_epoch == now` hợp lệ ⟹ chỉ vế `prev_rho_q == 0` chặn được ca này.
  rp_mint(
    rp_genesis_tx(
      RateParam { rho_q: 3_000_000_000, prev_rho_q: 1, effective_epoch: 7 },
      [rp_key],
      True,
      7,
    ),
  )
}

test rate_genesis_effective_next_epoch_fail() fail {
  // Luật cũ (hiệu lực từ epoch sau) — nay bị từ chối: két phải chờ trọn epoch dựng.
  rp_mint(
    rp_genesis_tx(
      RateParam { rho_q: 3_000_000_000, prev_rho_q: 0, effective_epoch: 8 },
      [rp_key],
      True,
      7,
    ),
  )
}

test rate_genesis_effective_prev_epoch_fail() fail {
  // Hiệu lực lùi về epoch trước genesis ⟹ từ chối (chặn đột biến `==` → `<=`).
  rp_mint(
    rp_genesis_tx(
      RateParam { rho_q: 3_000_000_000, prev_rho_q: 0, effective_epoch: 6 },
      [rp_key],
      True,
      7,
    ),
  )
}

// ── Genesis rồi cập nhật trong CÙNG epoch ─────────────────────────────────────────
//    Sau genesis {3e9, 0, 7}, ρ epoch 7 đã là 3e9 ⟹ lượt cập nhật cùng epoch phải ghi
//    prev = 3e9. Ghi prev = 0 là kéo ρ epoch 7 từ 3e9 về 0 giữa epoch.

test rate_update_after_genesis_same_epoch_happy() {
  let out =
    RateParam { rho_q: 1_000_000_000, prev_rho_q: 3_000_000_000, effective_epoch: 8 }
  rp_spend(rp_genesis, rp_tx(rp_genesis, out, [rp_key], 7))
}

test rate_update_after_genesis_same_epoch_prev_zero_fail() fail {
  let out = RateParam { rho_q: 1_000_000_000, prev_rho_q: 0, effective_epoch: 8 }
  rp_spend(rp_genesis, rp_tx(rp_genesis, out, [rp_key], 7))
}

// ── GỐC CỬA SỔ (WIN-ORIGIN-1) ───────────────────────────────────────────────────
//    Thời gian thật = gốc Mainnet + epoch 7 ⟹ now = 7 ⟹ effective_epoch 8. Bỏ phép trừ
//    gốc ⟹ now ≈ 17_439 ⟹ ca dương đỏ.

test rate_update_origin_mainnet_happy() {
  let o = window_origin_fixtures.mainnet_origin_ms
  let out =
    RateParam { rho_q: 3_500_000_000, prev_rho_q: 3_000_000_000, effective_epoch: 8 }
  rp_spend_at(o, rp_in, window_origin_fixtures.shift_tx(rp_tx(rp_in, out, [rp_key], 7), o))
}

test rate_update_origin_forgotten_fail() fail {
  let o = window_origin_fixtures.mainnet_origin_ms
  let out =
    RateParam { rho_q: 3_500_000_000, prev_rho_q: 3_000_000_000, effective_epoch: 8 }
  rp_spend_at(0, rp_in, window_origin_fixtures.shift_tx(rp_tx(rp_in, out, [rp_key], 7), o))
}

test rate_genesis_origin_mainnet_happy() {
  // Thời gian thật = gốc Mainnet + epoch 7 ⟹ now = 7 ⟹ effective_epoch 7.
  let o = window_origin_fixtures.mainnet_origin_ms
  rp_mint_at(
    o,
    window_origin_fixtures.shift_tx(rp_genesis_tx(rp_genesis, [rp_key], True, 7), o),
  )
}

test rate_genesis_origin_forgotten_fail() fail {
  let o = window_origin_fixtures.mainnet_origin_ms
  rp_mint_at(
    0,
    window_origin_fixtures.shift_tx(rp_genesis_tx(rp_genesis, [rp_key], True, 7), o),
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Cổng `reference_script == None` (rà 2026-10-02) — cặp dương/âm
// ══════════════════════════════════════════════════════════════════════════════
// Ca dương: đầu ra script giữ `None`, ref-script nằm ở một output VÍ khác ⟹ qua (cổng
// chỉ soi đầu ra của chính script). Ca âm: CÙNG giao dịch, ref-script gắn vào đầu ra
// script ⟹ từ chối. Hai ca chỉ khác đúng một trường, nên ca âm đỏ được vì cổng này chứ
// không vì chốt nào khác.

const woc_ref_script: ByteArray =
  #"5c0000000000000000000000000000000000000000000000000000ff"

const woc_rp_out: RateParam =
  RateParam { rho_q: 3_500_000_000, prev_rho_q: 3_000_000_000, effective_epoch: 8 }

test rate_update_ref_script_elsewhere_ok() {
  rp_spend(
    rp_in,
    util.with_wallet_ref_script_output(
      rp_tx(rp_in, woc_rp_out, [rp_key], 7),
      woc_ref_script,
    ),
  )
}

test rate_update_continuing_ref_script_fail() fail {
  rp_spend(
    rp_in,
    util.with_ref_script_at(
      rp_tx(rp_in, woc_rp_out, [rp_key], 7),
      rp_sh,
      woc_ref_script,
    ),
  )
}

test rate_genesis_ref_script_elsewhere_ok() {
  rp_mint(
    util.with_wallet_ref_script_output(
      rp_genesis_tx(rp_genesis, [rp_key], True, 7),
      woc_ref_script,
    ),
  )
}

test rate_genesis_ref_script_fail() fail {
  rp_mint(
    util.with_ref_script_at(
      rp_genesis_tx(rp_genesis, [rp_key], True, 7),
      rp_sh,
      woc_ref_script,
    ),
  )
}
