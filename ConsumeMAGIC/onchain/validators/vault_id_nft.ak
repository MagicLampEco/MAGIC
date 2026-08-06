// Vault identity NFT — minting policy ONE-SHOT (INV-VAULT-IDENTITY, spec §4.1).
//
// VÌ SAO CẦN: trước bản này, `consume.ak` nhận một UTxO là "vault" chỉ vì nó nằm ở
// địa chỉ vault script (`util.is_at_script`). Địa chỉ script là công khai — ai cũng
// trả được ~2 ADA để tạo một UTxO ở đó với datum bịa `magic_batches:[{current_amount:
// 10^18}]`, rồi co-spend Engage + BurnBatch để TIÊU MAGIC CHƯA TỪNG ĐƯỢC SINH. PoC
// `poc_fabricated_magic_burns_ok` từng PASS đúng đường đó.
//
// CÁCH VÁ: vault hợp lệ phải mang một NFT mà kẻ tấn công KHÔNG mint được. Policy này
// neo vào một `OutputReference` genesis: một UTxO spend được tối đa một lần ⟹ policy
// chạy tối đa một lần ⟹ nguồn cung NFT cố định, không re-mint, không burn. UTxO bịa
// không có NFT ⟹ `consume.ak` từ chối.
//
// PHẠM VI (giống ghi chú deploy của `engage_nft.ak`): MVP là MỘT policy / MỘT vault —
// mỗi vault deploy một `genesis_ref` riêng nên policy id khác nhau, và `consume.ak`
// được apply-param bởi đúng cặp policy/name của vault nó phục vụ. Muốn một policy
// phát N vault-NFT thì phải có cửa tạo-vault kiểm tư cách người tạo; đó là việc khác,
// KHÔNG thuộc bản vá này.
//
// CHƯA LÀM Ở ĐÂY: spec §4.1 muốn NFT gắn PersonDID chủ vault qua `I-PERSON-5`. MVP
// `did_commit = #""` nên chưa gắn được. Neo theo `genesis_ref` đã đủ đóng lỗ PoC (kẻ
// tấn công không mint được NFT); phần gắn DID nối sau khi có `did_commit` thật.

use aiken/collection/dict
use aiken/collection/list
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction, placeholder}
use magiclamp/consume/types.{MintGenesis, NftRedeemer}
use magiclamp/consume/util

/// Asset name của vault identity NFT = "VLT".
pub const vault_id_nft_name: ByteArray = #"564c54"

validator vault_id_nft(genesis_ref: OutputReference) {
  mint(_redeemer: NftRedeemer, policy_id: PolicyId, tx: Transaction) {
    // ONE-SHOT: phải tiêu đúng UTxO genesis. UTxO đã tiêu không tiêu lại được nên
    // policy này không bao giờ chạy lần hai.
    expect list.any(tx.inputs, fn(i) { i.output_reference == genesis_ref })

    // Mint chứa ĐÚNG một asset name của policy này, số lượng +1.
    // `dict.size == 1` chặn nhét thêm tên khác cùng policy trong cùng tx;
    // `== 1` chặn cả mint thừa lẫn mint âm (burn).
    let own_tokens = assets.tokens(tx.mint, policy_id)
    expect dict.size(own_tokens) == 1
    expect assets.quantity_of(tx.mint, policy_id, vault_id_nft_name) == 1
    True
  }

  else(_) {
    fail
  }
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

const vn_policy: PolicyId = #"8888"

fn vn_genesis_ref() -> OutputReference {
  util.mk_ref_id(#"dd", 3)
}

fn vn_genesis_input() {
  util.mk_input(
    vn_genesis_ref(),
    util.mk_output_no_datum(util.vk_address(#"b0"), assets.from_lovelace(2_000_000)),
  )
}

test vault_id_nft_happy() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [vn_genesis_input()],
      mint: assets.from_asset(vn_policy, vault_id_nft_name, 1),
    }
  vault_id_nft.mint(vn_genesis_ref(), MintGenesis, vn_policy, tx)
}

// Không tiêu UTxO genesis → không phải lần chạy one-shot → reject.
// Đây là ràng buộc làm cho NFT không thể bịa: kẻ tấn công không có genesis UTxO.
test vault_id_nft_no_genesis() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [
        util.mk_input(
          util.mk_ref(0),
          util.mk_output_no_datum(util.vk_address(#"b0"), assets.from_lovelace(2_000_000)),
        ),
      ],
      mint: assets.from_asset(vn_policy, vault_id_nft_name, 1),
    }
  vault_id_nft.mint(vn_genesis_ref(), MintGenesis, vn_policy, tx)
}

// Mint 2 cái trong một lần chạy → hai vault cùng "hợp lệ" từ một genesis → reject.
test vault_id_nft_qty_two() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [vn_genesis_input()],
      mint: assets.from_asset(vn_policy, vault_id_nft_name, 2),
    }
  vault_id_nft.mint(vn_genesis_ref(), MintGenesis, vn_policy, tx)
}

// Burn (mint âm) → reject: nguồn cung phải cố định, không rút NFT khỏi vault được.
test vault_id_nft_burn_rejected() fail {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [vn_genesis_input()],
      mint: assets.from_asset(vn_policy, vault_id_nft_name, -1),
    }
  vault_id_nft.mint(vn_genesis_ref(), MintGenesis, vn_policy, tx)
}

// Kèm một asset name khác cùng policy → dict.size != 1 → reject.
test vault_id_nft_extra_name() fail {
  let v =
    assets.add(
      assets.from_asset(vn_policy, vault_id_nft_name, 1),
      vn_policy,
      #"6578747261",
      1,
    )
  let tx = Transaction { ..placeholder, inputs: [vn_genesis_input()], mint: v }
  vault_id_nft.mint(vn_genesis_ref(), MintGenesis, vn_policy, tx)
}
