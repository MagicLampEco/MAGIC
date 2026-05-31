// Beacon authenticity NFT — minting policy ONE-SHOT (SPEC §QĐ2, C-BCN-1).
//
// Mỗi beacon UTxO (PParam / Randomness / MerkleRoot) cần đúng 1 authenticity NFT
// để chống datum hijacking: kẻ tấn công có thể tạo UTxO giả tại cùng beacon
// address với datum bịa, nhưng KHÔNG thể mint NFT này → redeem validator
// (claim_account.find_merkle_root) + beacon validator chỉ tin UTxO mang NFT.
//
// FIRST-PRINCIPLES — one-shot:
//   Policy parameterized bởi 1 genesis OutputReference. Mint chỉ hợp lệ khi tx
//   CONSUME đúng UTxO genesis đó. Vì 1 UTxO chỉ spend được 1 lần trong lịch sử
//   chain → policy chạy được đúng 1 lần → supply 3 NFT cố định, KHÔNG re-mint.
//   Đây là bất biến mạnh nhất có thể đạt được mà không cần state on-chain.
//
// MINT shape (đúng 3, không hơn không kém):
//   (PPARAM, +1), (NONCE, +1), (MROOT, +1)  — một genesis set cho cả 3 beacon kind.
//
// BURN — chọn an toàn = CẤM hoàn toàn (xem QĐ ghi dưới).

use aiken/collection/dict
use aiken/collection/list
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{Input, OutputReference, Transaction, placeholder}
use magiclamp/lampdist/types.{MerkleRoot, PParam, Randomness}
use magiclamp/lampdist/util

/// Redeemer của minting policy.
///
/// Chỉ một action `MintGenesis`. KHÔNG có biến thể Burn:
///
/// QĐ (trục an toàn vốn + bền vững hệ thống): CẤM burn.
///  - Beacon NFT là authenticity token sống suốt vòng đời module. Burn được =
///    cho phép phá tính xác thực beacon → datum hijacking lại có cửa. Không có
///    use-case hợp lệ nào cần đốt 3 NFT này.
///  - One-shot đã chặn re-mint, nên cấm burn khiến supply BẤT BIẾN tuyệt đối
///    (đúng 3, mãi mãi). Đơn giản hoá lý luận an toàn cho mọi validator phụ thuộc.
///  - `else(_) { fail }` chặn mọi purpose khác (spend/withdraw/...) lẫn mọi
///    redeemer ngoài MintGenesis → mint âm (burn) tự động bị từ chối.
pub type BeaconNftRedeemer {
  MintGenesis
}

validator beacon_nft(genesis_ref: OutputReference) {
  mint(_redeemer: BeaconNftRedeemer, policy_id: PolicyId, tx: Transaction) {
    // ── ONE-SHOT: phải consume đúng UTxO genesis ───────────────────────────
    // 1 UTxO spend được tối đa 1 lần → policy chạy được tối đa 1 lần.
    expect
      list.any(tx.inputs, fn(i) { i.output_reference == genesis_ref })

    // ── Mint chứa ĐÚNG 3 token của policy này, mỗi cái qty +1 ───────────────
    // tokens(mint, policy_id) = Dict<AssetName, Int> chỉ gồm asset của policy
    // này. size == 3 đảm bảo KHÔNG mint thừa asset name lạ; quantity_of từng
    // name == 1 đảm bảo đúng (PPARAM,1)(NONCE,1)(MROOT,1) — không hơn không kém,
    // không qty 2, không qty âm (burn).
    let own_tokens = assets.tokens(tx.mint, policy_id)
    expect dict.size(own_tokens) == 3

    let pparam_name = util.beacon_name(PParam)
    let nonce_name = util.beacon_name(Randomness)
    let mroot_name = util.beacon_name(MerkleRoot)

    expect assets.quantity_of(tx.mint, policy_id, pparam_name) == 1
    expect assets.quantity_of(tx.mint, policy_id, nonce_name) == 1
    expect assets.quantity_of(tx.mint, policy_id, mroot_name) == 1

    True
  }

  else(_) {
    fail
  }
}

// ══════════════════════════════════════════════════════════════
// Validator tests (mock Transaction)
// ══════════════════════════════════════════════════════════════

const nt_policy: PolicyId = #"beac"

/// genesis UTxO mà policy bắt buộc consume (output_index 7 để phân biệt).
fn nt_genesis_ref() -> OutputReference {
  OutputReference { transaction_id: #"aa", output_index: 7 }
}

/// Mint value tham số hoá theo qty từng kind (để dựng cả happy + sai lệch).
fn nt_mint(pparam_qty: Int, nonce_qty: Int, mroot_qty: Int) -> Value {
  assets.zero
    |> assets.add(nt_policy, util.beacon_name(PParam), pparam_qty)
    |> assets.add(nt_policy, util.beacon_name(Randomness), nonce_qty)
    |> assets.add(nt_policy, util.beacon_name(MerkleRoot), mroot_qty)
}

/// Input consume genesis ref (dummy output ví thường).
fn nt_genesis_input() -> Input {
  let addr = util.vk_address(#"a0")
  util.mk_input(nt_genesis_ref(), util.mk_output_no_datum(addr, assets.from_lovelace(2_000_000)))
}

/// Input bất kỳ KHÔNG phải genesis (output_index khác).
fn nt_other_input() -> Input {
  let addr = util.vk_address(#"a0")
  util.mk_input(util.mk_ref(0), util.mk_output_no_datum(addr, assets.from_lovelace(2_000_000)))
}

test mint_happy() {
  // consume genesis + mint đúng 3 NFT mỗi cái qty 1 → pass.
  let tx =
    Transaction {
      ..placeholder,
      inputs: [nt_other_input(), nt_genesis_input()],
      mint: nt_mint(1, 1, 1),
    }
  beacon_nft.mint(nt_genesis_ref(), MintGenesis, nt_policy, tx)
}

test mint_without_genesis() fail {
  // KHÔNG consume genesis ref → one-shot reject.
  let tx =
    Transaction {
      ..placeholder,
      inputs: [nt_other_input()],
      mint: nt_mint(1, 1, 1),
    }
  beacon_nft.mint(nt_genesis_ref(), MintGenesis, nt_policy, tx)
}

test mint_wrong_quantity() fail {
  // mint 2 PPARAM (≠ 1) → reject (supply phải đúng 1 mỗi kind).
  let tx =
    Transaction {
      ..placeholder,
      inputs: [nt_genesis_input()],
      mint: nt_mint(2, 1, 1),
    }
  beacon_nft.mint(nt_genesis_ref(), MintGenesis, nt_policy, tx)
}
