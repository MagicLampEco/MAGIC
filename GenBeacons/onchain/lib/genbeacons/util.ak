//// Tiện ích dùng chung cho ba validator beacon.

use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite}
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}

/// Epoch thời gian thật của giao dịch. Đòi CẢ HAI biên hữu hạn, nằm trong CÙNG một
/// epoch ⟹ bên ký không chọn được epoch khác epoch mà ledger chạy giao dịch (ledger chỉ
/// nhận giao dịch khi slot hiện tại nằm trong khoảng hiệu lực). Cùng ngữ nghĩa với
/// `ConsumeMAGIC/onchain/lib/magiclamp/consume/util.ak` ▸ `get_epoch`.
///
/// Gốc lưới (WIN-ORIGIN-1, `LAMP/Specs/Window/CONTRACT.md` v1.0): chỉ số epoch =
/// `(t − window_origin_ms) / ms_per_epoch`; `window_origin_ms` là apply-param cuối của
/// validator gọi hàm này.
pub fn get_epoch(tx: Transaction, ms_per_epoch: Int, window_origin_ms: Int) -> Int {
  expect Finite(lo) = tx.validity_range.lower_bound.bound_type
  expect Finite(hi) = tx.validity_range.upper_bound.bound_type
  expect hi >= lo
  let lo_epoch = ( lo - window_origin_ms ) / ms_per_epoch
  let hi_epoch = ( hi - window_origin_ms ) / ms_per_epoch
  expect lo_epoch == hi_epoch
  hi_epoch
}

pub fn is_at_script(addr: Address, script_hash: ByteArray) -> Bool {
  addr.payment_credential == Script(script_hash)
}

pub fn count_inputs_at_script(inputs: List<Input>, script_hash: ByteArray) -> Int {
  list.count(inputs, fn(i) { is_at_script(i.output.address, script_hash) })
}

/// Một-vào-một-ra tại CHÍNH script cho UTxO beacon/shard đang tiêu. Trả `(vào, ra)`.
///
/// Ép: đúng 1 input + đúng 1 output tại script (chống double-satisfaction), input mang
/// NFT `(own_hash, nft_name)`, output cùng địa chỉ ĐẦY ĐỦ (kể cả stake credential),
/// ADA không giảm (còn đường nạp thêm cho min-UTxO), phần non-ADA y hệt ⟹ NFT ở lại,
/// không nhét/rút token lạ, output KHÔNG mang reference script. Khuôn:
/// `ConsumeMAGIC/onchain/validators/price_param.ak`.
///
/// Vì sao cấm reference script (rà 2026-10-02, PoC "shard nhận output gắn ref-script"):
/// UTxO tiếp nối là thứ MỌI giao dịch sau đều chạm — shard bị tiêu ở mỗi lượt rút, beacon
/// ρ/GreenBack bị đọc làm reference input ở mỗi lượt sinh. Ledger Conway tính phí theo
/// byte ref-script của MỌI input và reference input, và ref-script đội min-ADA của chính
/// UTxO. Bên giữ quyền tiêu (khoá ghi beacon, hay bất kỳ ai dựng lượt rút shard) gắn một
/// script lớn vào là đánh thuế lên mọi giao dịch về sau của người khác.
pub fn continuing_pair(
  own_ref: OutputReference,
  tx: Transaction,
  nft_name: ByteArray,
) -> (Output, Output) {
  expect Some(own_in) =
    list.find(tx.inputs, fn(i) { i.output_reference == own_ref })
  let own_out = own_in.output
  expect Script(own_hash) = own_out.address.payment_credential
  expect count_inputs_at_script(tx.inputs, own_hash) == 1
  expect [next] =
    list.filter(tx.outputs, fn(o) { is_at_script(o.address, own_hash) })
  expect assets.quantity_of(own_out.value, own_hash, nft_name) == 1
  expect next.address == own_out.address
  expect next.reference_script == None
  expect assets.lovelace_of(next.value) >= assets.lovelace_of(own_out.value)
  expect
    assets.without_lovelace(next.value) == assets.without_lovelace(own_out.value)
  (own_out, next)
}

/// Cổng genesis chung cho beacon ĐƠN (ρ, GreenBack): policy = hash chính script.
///   - `seed` bị tiêu trong giao dịch ⟹ one-shot (seed chỉ tiêu được một lần).
///   - đúc ĐÚNG MỘT token `(policy_id, nft_name)`, không tên nào khác dưới policy này.
///   - output mang NFT nằm ở `Script(policy_id)` KHÔNG stake credential, phần non-ADA
///     chỉ có đúng NFT đó, KHÔNG mang reference script (cùng lý do với `continuing_pair`;
///     sổ `vault_registry` không có nhánh tiêu nên ref-script gắn lúc genesis nằm đó
///     vĩnh viễn, và mọi lượt rút shard đọc sổ đều trả phí cho nó).
/// Trả output genesis để validator soát datum. Cardano không chạy validator spend lúc
/// TẠO UTxO, nên đây là chỗ DUY NHẤT ép được datum khởi đầu (INV-VAULT-IDENTITY).
pub fn genesis_single(
  tx: Transaction,
  policy_id: PolicyId,
  seed: OutputReference,
  nft_name: ByteArray,
) -> Output {
  expect list.any(tx.inputs, fn(i) { i.output_reference == seed })
  expect [Pair(minted_name, 1)] = dict.to_pairs(assets.tokens(tx.mint, policy_id))
  expect minted_name == nft_name
  expect [out] =
    list.filter(
      tx.outputs,
      fn(o) { assets.quantity_of(o.value, policy_id, nft_name) > 0 },
    )
  expect out.address == script_address(policy_id)
  expect out.reference_script == None
  expect
    assets.without_lovelace(out.value) == assets.from_asset(
      policy_id,
      nft_name,
      1,
    )
  out
}

// ── Dựng fixture cho test ─────────────────────────────────────────────────────

pub fn script_address(hash: ByteArray) -> Address {
  Address { payment_credential: Script(hash), stake_credential: None }
}

pub fn vk_address(pkh: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(pkh), stake_credential: None }
}

pub fn mk_output(addr: Address, value: Value, datum: Data) -> Output {
  Output {
    address: addr,
    value: value,
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

pub fn mk_output_no_datum(addr: Address, value: Value) -> Output {
  Output { address: addr, value: value, datum: NoDatum, reference_script: None }
}

/// Output mang reference script `Some(h)` — builder `mk_output` luôn ghi `None`, nên
/// không có helper này thì mọi cổng `reference_script == None` là cổng không bài nào đỏ.
pub fn mk_output_with_ref_script(addr: Address, value: Value, h: ByteArray) -> Output {
  Output { address: addr, value: value, datum: NoDatum, reference_script: Some(h) }
}

/// Gắn `reference_script = Some(h)` cho MỌI output tại `Script(script_hash)`, giữ nguyên
/// các output khác — dựng ca âm cho cổng ref-script trên đầu ra tiếp nối/genesis.
pub fn with_ref_script_at(
  tx: Transaction,
  script_hash: ByteArray,
  h: ByteArray,
) -> Transaction {
  Transaction {
    ..tx,
    outputs: list.map(
      tx.outputs,
      fn(o) {
        if is_at_script(o.address, script_hash) {
          Output { ..o, reference_script: Some(h) }
        } else {
          o
        }
      },
    ),
  }
}

/// Thêm một output VÍ mang ref-script vào cuối giao dịch — ca dương: cổng chỉ soi đầu
/// ra của chính script, ref-script ở output khác không liên quan.
pub fn with_wallet_ref_script_output(tx: Transaction, h: ByteArray) -> Transaction {
  Transaction {
    ..tx,
    outputs: list.concat(
      tx.outputs,
      [
        mk_output_with_ref_script(
          vk_address(#"ab0ab0"),
          assets.from_lovelace(20_000_000),
          h,
        ),
      ],
    ),
  }
}

pub fn mk_input(ref: OutputReference, out: Output) -> Input {
  Input { output_reference: ref, output: out }
}

pub fn mk_ref(id: ByteArray, ix: Int) -> OutputReference {
  OutputReference { transaction_id: id, output_index: ix }
}
