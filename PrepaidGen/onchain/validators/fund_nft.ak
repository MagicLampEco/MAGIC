// validators/fund_nft.ak — NFT định danh quỹ Paid (C-PP-15)
//
// MỘT policy dùng chung cho MỌI quỹ (không tham số hoá theo seed): nếu mỗi quỹ
// một policy thì `fund_nft_policy` của prepaid_vault lại thành per-quỹ, tức mỗi
// platform một script vault riêng — hỏng.
//
// Tính duy nhất đến từ INPUT BỊ TIÊU chứ không từ tham số biên dịch:
//   asset_name = blake2b256(tx_hash ∥ be8(output_index)) của một input trong
//   chính giao dịch đúc. UTxO tiêu được tối đa một lần ⇒ tên không bao giờ lặp,
//   không ai đúc lại được tên cũ.
//
// Đồng thời đây là CỔNG GENESIS của sổ quỹ (C-PP-15): datum của output mang NFT
// phải sạch (mọi số cộng dồn = 0) và buffer_bps ≥ 15%. Không có cổng này thì một
// quỹ có thể "sinh ra" với magic_settled khổng lồ rồi rút CARP của người khác.
//
// Không kiểm được ĐỊA CHỈ output ở đây (sẽ tạo vòng tham chiếu
// fund_nft → paid_fund → prepaid_vault → fund_nft). Chốt chặn địa chỉ nằm ở
// prepaid_vault: nó chỉ chấp nhận quỹ nằm đúng `paid_fund_hash`.

use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/assets.{PolicyId}
use cardano/address.{Address, VerificationKey}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}
use magiclamp/protocol/constants.{min_buffer_bps}
use magiclamp/protocol/math.{compute_fund_id}
use magiclamp/protocol/types.{PaidFundDatum}

validator fund_nft {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    // Đúng MỘT tên tài sản dưới policy này, số lượng đúng 1.
    let own = assets.tokens(tx.mint, policy_id)
    expect [Pair(name, qty)] = dict.to_pairs(own)
    expect qty == 1

    // Tên phải bắt nguồn từ một input BỊ TIÊU trong chính giao dịch này.
    expect
      list.any(
        tx.inputs,
        fn(i) {
          compute_fund_id(
            i.output_reference.transaction_id,
            i.output_reference.output_index,
          ) == name
        },
      )

    // Đúng một output mang NFT, và sổ quỹ của nó phải SẠCH.
    let carriers =
      list.filter(
        tx.outputs,
        fn(o) { assets.quantity_of(o.value, policy_id, name) == 1 },
      )
    expect [fund_utxo] = carriers
    let fd = decode_fund(fund_utxo)

    expect fd.fund_id == name
    expect fd.carp_locked == 0
    expect fd.credit_issued == 0
    expect fd.magic_settled == 0
    expect fd.provider_claimed == 0
    expect fd.buffer_bps >= min_buffer_bps
    expect bytearray.length(fd.platform) == 28
    expect bytearray.length(fd.vault_hash) == 28
    True
  }

  // Đốt / mọi mục đích khác: đóng cứng. NFT quỹ là vĩnh viễn ở v0.1 —
  // đóng quỹ là điểm [CẦN XÁC NHẬN] số 12 trong DESIGN.md.
  else(_) {
    fail
  }
}

fn decode_fund(o: Output) -> PaidFundDatum {
  expect InlineDatum(d) = o.datum
  expect fd: PaidFundDatum = d
  fd
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

const fn_policy: PolicyId = #"33333333333333333333333333333333333333333333333333333333"
const fn_platform: ByteArray = #"77777777777777777777777777777777777777777777777777777777"
const fn_vault: ByteArray = #"11111111111111111111111111111111111111111111111111111111"
const fn_seed_tx: ByteArray =
  #"5555555555555555555555555555555555555555555555555555555555555555"

fn fn_seed_ref() -> OutputReference {
  OutputReference { transaction_id: fn_seed_tx, output_index: 2 }
}

fn fn_name() -> ByteArray {
  compute_fund_id(fn_seed_tx, 2)
}

fn fn_addr() -> Address {
  Address { payment_credential: VerificationKey(fn_platform), stake_credential: None }
}

fn fn_input(ref: OutputReference) -> Input {
  Input {
    output_reference: ref,
    output: Output {
      address: fn_addr(),
      value: assets.from_lovelace(2_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn fn_datum(
  fund_id  : ByteArray,
  locked   : Int,
  issued   : Int,
  settled  : Int,
  claimed  : Int,
  buffer   : Int,
) -> PaidFundDatum {
  PaidFundDatum {
    fund_id,
    platform: fn_platform,
    vault_hash: fn_vault,
    carp_locked: locked,
    credit_issued: issued,
    magic_settled: settled,
    provider_claimed: claimed,
    buffer_bps: buffer,
    last_updated_epoch: 0,
  }
}

fn fn_carrier(name: ByteArray, d: PaidFundDatum, qty: Int) -> Output {
  Output {
    address: fn_addr(),
    value: assets.from_lovelace(2_000_000) |> assets.add(fn_policy, name, qty),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

fn fn_tx(mint: assets.Value, ins: List<Input>, outs: List<Output>) -> Transaction {
  Transaction { ..placeholder, inputs: ins, outputs: outs, mint }
}

// happy: tiêu seed → tên duy nhất, sổ quỹ sạch, đệm ≥ 15%.
test fn_mint_ok() {
  let name = fn_name()
  let d = fn_datum(name, 0, 0, 0, 0, 1_500)
  let tx =
    fn_tx(
      assets.from_asset(fn_policy, name, 1),
      [fn_input(fn_seed_ref())],
      [fn_carrier(name, d, 1)],
    )
  fund_nft.mint(Void, fn_policy, tx)
}

// TẤN CÔNG: tên không bắt nguồn từ input nào bị tiêu → đúc trùng/giả tên.
test fn_mint_forged_name() fail {
  let name = #"ffff000000000000000000000000000000000000000000000000000000000000"
  let d = fn_datum(name, 0, 0, 0, 0, 1_500)
  let tx =
    fn_tx(
      assets.from_asset(fn_policy, name, 1),
      [fn_input(fn_seed_ref())],
      [fn_carrier(name, d, 1)],
    )
  fund_nft.mint(Void, fn_policy, tx)
}

// TẤN CÔNG: đúc 2 bản cùng tên → trạng thái quỹ tách đôi.
test fn_mint_qty_two() fail {
  let name = fn_name()
  let d = fn_datum(name, 0, 0, 0, 0, 1_500)
  let tx =
    fn_tx(
      assets.from_asset(fn_policy, name, 2),
      [fn_input(fn_seed_ref())],
      [fn_carrier(name, d, 2)],
    )
  fund_nft.mint(Void, fn_policy, tx)
}

// TẤN CÔNG: đúc kèm một tên lạ dưới cùng policy.
test fn_mint_extra_name() fail {
  let name = fn_name()
  let d = fn_datum(name, 0, 0, 0, 0, 1_500)
  let m =
    assets.from_asset(fn_policy, name, 1) |> assets.add(fn_policy, #"6666", 1)
  let tx = fn_tx(m, [fn_input(fn_seed_ref())], [fn_carrier(name, d, 1)])
  fund_nft.mint(Void, fn_policy, tx)
}

// TẤN CÔNG CỐT LÕI: quỹ sinh ra đã khai magic_settled khổng lồ → rút CARP người khác.
test fn_mint_dirty_settled() fail {
  let name = fn_name()
  let d = fn_datum(name, 0, 0, 999_000_000_000, 0, 1_500)
  let tx =
    fn_tx(
      assets.from_asset(fn_policy, name, 1),
      [fn_input(fn_seed_ref())],
      [fn_carrier(name, d, 1)],
    )
  fund_nft.mint(Void, fn_policy, tx)
}

// TẤN CÔNG: quỹ sinh ra đã khai credit_issued > 0 (phá C-PP-3 ngay từ đầu).
test fn_mint_dirty_issued() fail {
  let name = fn_name()
  let d = fn_datum(name, 0, 1_000_000, 0, 0, 1_500)
  let tx =
    fn_tx(
      assets.from_asset(fn_policy, name, 1),
      [fn_input(fn_seed_ref())],
      [fn_carrier(name, d, 1)],
    )
  fund_nft.mint(Void, fn_policy, tx)
}

// TẤN CÔNG: đệm buffer-Paid dưới 15%.
test fn_mint_buffer_too_low() fail {
  let name = fn_name()
  let d = fn_datum(name, 0, 0, 0, 0, 1_499)
  let tx =
    fn_tx(
      assets.from_asset(fn_policy, name, 1),
      [fn_input(fn_seed_ref())],
      [fn_carrier(name, d, 1)],
    )
  fund_nft.mint(Void, fn_policy, tx)
}

// TẤN CÔNG: fund_id trong datum khác tên NFT → định danh trôi.
test fn_mint_id_mismatch() fail {
  let name = fn_name()
  let d = fn_datum(#"abcd", 0, 0, 0, 0, 1_500)
  let tx =
    fn_tx(
      assets.from_asset(fn_policy, name, 1),
      [fn_input(fn_seed_ref())],
      [fn_carrier(name, d, 1)],
    )
  fund_nft.mint(Void, fn_policy, tx)
}

// TẤN CÔNG: NFT đúc ra nhưng không output nào giữ (không có sổ quỹ).
test fn_mint_no_carrier() fail {
  let name = fn_name()
  let tx = fn_tx(assets.from_asset(fn_policy, name, 1), [fn_input(fn_seed_ref())], [])
  fund_nft.mint(Void, fn_policy, tx)
}
