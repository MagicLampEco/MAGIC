// Beacon thặng dư GreenBack (SPEC v2.4 §6.1.3, §6.1.5).
//
// Một UTxO mang NFT one-shot `(hash script này, "GBB")`, datum `GreenBackBeacon` inline.
// Hai giai đoạn (mô phỏng → tính từ CARP) dùng CHUNG validator này; chuyển giai đoạn chỉ
// đổi NGUỒN ghi. Beacon mô phỏng chỉ chạy testnet.
//
// Bất biến validator ép:
//   - chỉ `greenback_beacon_writer` (1-of-1, TÁCH khỏi khoá ρ, khoá PriceParam, engine_key,
//     ví deploy — `INV-ORACLE-INDEP`) ghi được;
//   - `epoch` = epoch thời gian thật của giao dịch ghi — bên ghi không tự khai;
//   - `seq` tăng ĐÚNG 1 mỗi lần ghi ⟹ shard nhận ra lượt ghi mới để đặt lại lười;
//   - `gb_nanogic ≥ 0` (bên ghi đăng `max(0, thặng dư)`);
//   - NFT ở lại đúng địa chỉ, datum inline.
// KHÔNG ép ở đây: độ tươi beacon lúc ĐỌC (`CC-GEN-BEACON-AGE`) — két đọc `epoch` rồi tự so.
// KHÔNG có đường xoay khoá ghi (`CC-GEN-BEACON-ROTATION`, TẠM: chấp nhận vì chỉ testnet).

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, OutputReference, Transaction, placeholder}
use genbeacons/constants
use genbeacons/types.{GreenBackBeacon}
use genbeacons/util
use genbeacons/window_origin_fixtures

/// Apply-param (theo thứ tự):
///   greenback_beacon_writer : khoá ghi beacon, 1-of-1.
///   ms_per_epoch            : POSIX ms mỗi epoch theo mạng.
///   seed                    : OutputReference neo policy NFT one-shot (policy = hash
///                             script này).
///   window_origin_ms        : gốc lưới epoch theo mạng (POSIX ms), apply-param CUỐI —
///                             epoch = (t − window_origin_ms) / ms_per_epoch
///                             (WIN-ORIGIN-1, LAMP/Specs/Window/CONTRACT.md v1.0).
validator greenback_beacon(
  greenback_beacon_writer: VerificationKeyHash,
  ms_per_epoch: Int,
  seed: OutputReference,
  window_origin_ms: Int,
) {
  // Genesis: `seq == 0`. Shard genesis cũng `seq == 0` ⟹ shard chỉ đặt lại từ lượt ghi
  // THỨ HAI trở đi (seq 1); tới lúc đó shard `remaining == 0` (fail-closed).
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    expect ms_per_epoch > 0
    expect list.has(tx.extra_signatories, greenback_beacon_writer)
    let out =
      util.genesis_single(tx, policy_id, seed, constants.greenback_nft_name)
    expect InlineDatum(d) = out.datum
    expect g: GreenBackBeacon = d
    and {
      g.seq == 0,
      g.gb_nanogic >= 0,
      g.epoch == util.get_epoch(tx, ms_per_epoch, window_origin_ms),
    }
  }

  spend(
    datum_opt: Option<GreenBackBeacon>,
    _redeemer: Data,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d_in) = datum_opt
    expect ms_per_epoch > 0
    expect list.has(tx.extra_signatories, greenback_beacon_writer)
    let (_, next) =
      util.continuing_pair(own_ref, tx, constants.greenback_nft_name)
    expect InlineDatum(d) = next.datum
    expect d_out: GreenBackBeacon = d
    and {
      d_out.epoch == util.get_epoch(tx, ms_per_epoch, window_origin_ms),
      d_out.seq == d_in.seq + 1,
      d_out.gb_nanogic >= 0,
    }
  }

  else(_) {
    fail
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

const gb_sh: ByteArray = #"9c9c9c"

const gb_writer: ByteArray = #"e1e1e1"

const gb_mspe: Int = 86_400_000

const gb_seed: OutputReference = OutputReference {
  transaction_id: #"5eed02",
  output_index: 1,
}

fn gb_nft_value(lovelace: Int) -> assets.Value {
  assets.add(assets.from_lovelace(lovelace), gb_sh, constants.greenback_nft_name, 1)
}

fn gb_tx_full(
  d_in: GreenBackBeacon,
  d_out: GreenBackBeacon,
  sigs: List<ByteArray>,
  now: Int,
  out_value,
  extra_outputs,
) -> Transaction {
  let b_in =
    util.mk_input(
      util.mk_ref(#"00", 0),
      util.mk_output(util.script_address(gb_sh), gb_nft_value(2_000_000), d_in),
    )
  Transaction {
    ..placeholder,
    inputs: [b_in],
    outputs: [
      util.mk_output(util.script_address(gb_sh), out_value, d_out),
      ..extra_outputs
    ],
    extra_signatories: sigs,
    validity_range: interval.between(now * gb_mspe, now * gb_mspe + 1),
  }
}

fn gb_tx(d_in, d_out, sigs, now) -> Transaction {
  gb_tx_full(d_in, d_out, sigs, now, gb_nft_value(2_000_000), [])
}

fn gb_spend(d_in: GreenBackBeacon, tx: Transaction) -> Bool {
  gb_spend_at(0, d_in, tx)
}

/// Như `gb_spend` nhưng validator nhận gốc `origin`.
fn gb_spend_at(origin: Int, d_in: GreenBackBeacon, tx: Transaction) -> Bool {
  greenback_beacon.spend(
    gb_writer,
    gb_mspe,
    gb_seed,
    origin,
    Some(d_in),
    Void,
    util.mk_ref(#"00", 0),
    tx,
  )
}

const gb_in: GreenBackBeacon =
  GreenBackBeacon { gb_nanogic: 1_000, seq: 4, epoch: 6, depeg: False }

test greenback_update_happy() {
  let out = GreenBackBeacon { gb_nanogic: 2_000, seq: 5, epoch: 7, depeg: False }
  gb_spend(gb_in, gb_tx(gb_in, out, [gb_writer], 7))
}

test greenback_update_depeg_on_happy() {
  // Bật depeg là quyền của bên ghi (fail-closed ở phía ĐỌC) — beacon không cấm.
  let out = GreenBackBeacon { gb_nanogic: 0, seq: 5, epoch: 7, depeg: True }
  gb_spend(gb_in, gb_tx(gb_in, out, [gb_writer], 7))
}

test greenback_update_stranger_fail() fail {
  let out = GreenBackBeacon { gb_nanogic: 2_000, seq: 5, epoch: 7, depeg: False }
  gb_spend(gb_in, gb_tx(gb_in, out, [#"cccccc"], 7))
}

test greenback_update_epoch_behind_fail() fail {
  let out = GreenBackBeacon { gb_nanogic: 2_000, seq: 5, epoch: 6, depeg: False }
  gb_spend(gb_in, gb_tx(gb_in, out, [gb_writer], 7))
}

test greenback_update_epoch_ahead_fail() fail {
  let out = GreenBackBeacon { gb_nanogic: 2_000, seq: 5, epoch: 8, depeg: False }
  gb_spend(gb_in, gb_tx(gb_in, out, [gb_writer], 7))
}

test greenback_update_seq_same_fail() fail {
  let out = GreenBackBeacon { gb_nanogic: 2_000, seq: 4, epoch: 7, depeg: False }
  gb_spend(gb_in, gb_tx(gb_in, out, [gb_writer], 7))
}

test greenback_update_seq_back_fail() fail {
  let out = GreenBackBeacon { gb_nanogic: 2_000, seq: 3, epoch: 7, depeg: False }
  gb_spend(gb_in, gb_tx(gb_in, out, [gb_writer], 7))
}

test greenback_update_seq_jump_two_fail() fail {
  let out = GreenBackBeacon { gb_nanogic: 2_000, seq: 6, epoch: 7, depeg: False }
  gb_spend(gb_in, gb_tx(gb_in, out, [gb_writer], 7))
}

test greenback_update_negative_gb_fail() fail {
  let out = GreenBackBeacon { gb_nanogic: -1, seq: 5, epoch: 7, depeg: False }
  gb_spend(gb_in, gb_tx(gb_in, out, [gb_writer], 7))
}

test greenback_update_nft_leaves_fail() fail {
  let out = GreenBackBeacon { gb_nanogic: 2_000, seq: 5, epoch: 7, depeg: False }
  let tx =
    gb_tx_full(
      gb_in,
      out,
      [gb_writer],
      7,
      assets.from_lovelace(2_000_000),
      [
        util.mk_output_no_datum(
          util.vk_address(gb_writer),
          gb_nft_value(2_000_000),
        ),
      ],
    )
  gb_spend(gb_in, tx)
}

// ── Genesis (mint) ────────────────────────────────────────────────────────────

fn gb_genesis_tx(g: GreenBackBeacon, sigs: List<ByteArray>) -> Transaction {
  let seed_in =
    util.mk_input(
      gb_seed,
      util.mk_output_no_datum(
        util.vk_address(gb_writer),
        assets.from_lovelace(9_000_000),
      ),
    )
  Transaction {
    ..placeholder,
    inputs: [seed_in],
    outputs: [util.mk_output(util.script_address(gb_sh), gb_nft_value(2_000_000), g)],
    mint: assets.from_asset(gb_sh, constants.greenback_nft_name, 1),
    extra_signatories: sigs,
    validity_range: interval.between(7 * gb_mspe, 7 * gb_mspe + 1),
  }
}

fn gb_mint(tx: Transaction) -> Bool {
  greenback_beacon.mint(gb_writer, gb_mspe, gb_seed, 0, Void, gb_sh, tx)
}

test greenback_genesis_happy() {
  gb_mint(
    gb_genesis_tx(
      GreenBackBeacon { gb_nanogic: 0, seq: 0, epoch: 7, depeg: False },
      [gb_writer],
    ),
  )
}

test greenback_genesis_seq_nonzero_fail() fail {
  gb_mint(
    gb_genesis_tx(
      GreenBackBeacon { gb_nanogic: 0, seq: 1, epoch: 7, depeg: False },
      [gb_writer],
    ),
  )
}

test greenback_genesis_stranger_fail() fail {
  gb_mint(
    gb_genesis_tx(
      GreenBackBeacon { gb_nanogic: 0, seq: 0, epoch: 7, depeg: False },
      [#"cccccc"],
    ),
  )
}

// ── GỐC CỬA SỔ (WIN-ORIGIN-1) ───────────────────────────────────────────────────
//    Gốc Mainnet không chia hết cho gb_mspe ⟹ bỏ phép trừ gốc trong `util.get_epoch`
//    làm epoch tính ra ≈ 17_439 ≠ 7 ⟹ ca dương đỏ. Gốc Preprod CHIA HẾT cho 86_400_000
//    nên không phân biệt được ở độ dài này — không dựng ca Preprod.

test greenback_update_origin_mainnet_happy() {
  let o = window_origin_fixtures.mainnet_origin_ms
  let out = GreenBackBeacon { gb_nanogic: 2_000, seq: 5, epoch: 7, depeg: False }
  gb_spend_at(o, gb_in, window_origin_fixtures.shift_tx(gb_tx(gb_in, out, [gb_writer], 7), o))
}

test greenback_update_origin_forgotten_fail() fail {
  let o = window_origin_fixtures.mainnet_origin_ms
  let out = GreenBackBeacon { gb_nanogic: 2_000, seq: 5, epoch: 7, depeg: False }
  gb_spend_at(0, gb_in, window_origin_fixtures.shift_tx(gb_tx(gb_in, out, [gb_writer], 7), o))
}
