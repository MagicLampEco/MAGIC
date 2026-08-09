// lib/magiclamp/protocol/vault_id.ak — NEO ĐỐI CHIẾU (P8) cho tên NFT danh-tính vault
//
// KHÔNG chứa logic chạy on-chain. File này chỉ NEO một hằng số: tên asset của
// NFT danh-tính vault mà `validate_mint_vault_id` (validators/vault.ak) tính là
//
//     nft_name = blake2b_256( cbor.serialise(seed) )   với seed : OutputReference
//
// Off-chain (MagicSDK/src/vaultId.ts → `vaultIdAssetName`) phải sinh ĐÚNG chuỗi
// byte đó, nếu không tx mint sẽ hỏng ở `assets.quantity_of(tx.mint, policy, nft_name) == 1`.
//
// DẠNG CBOR ĐÚNG của OutputReference (PlutusV3 / Conway, stdlib v3.1.0):
//   OutputReference { transaction_id: ByteArray, output_index: Int }
//   → Constr 0 [ bytes(32), int ]
//   → d879            tag 121  (= 121 + 0, chỉ số constructor 0)
//     9f              MẢNG ĐỘ-DÀI-BẤT-ĐỊNH mở đầu (KHÔNG phải 0x82 định-độ-dài)
//     5820 <32 byte>  transaction_id
//     <int>           output_index
//     ff              break
//   Ví dụ (index = 0): d8799f5820 0000…0001 00 ff
//   Lưu ý V3: transaction_id là ByteArray TRẦN, không còn bọc thêm Constr 0
//   (TxId) như PlutusV1/V2.
//
// Hai vector dưới đây được neo ĐỒNG THỜI ở:
//   - MagicSDK/tests/vaultId.test.ts  (cùng seed, cùng giá trị)
// Lệch một bên ⇒ CẢ HAI cùng đỏ. Đừng sửa hằng số một phía cho "khớp".

use aiken/cbor
use aiken/crypto
use cardano/transaction.{OutputReference}

const t_tx_id: ByteArray =
  #"0000000000000000000000000000000000000000000000000000000000000001"

/// TV-VAULTID-01 — seed index = 0
test vault_id_asset_name_index_0() {
  let seed = OutputReference { transaction_id: t_tx_id, output_index: 0 }
  // Dạng CBOR trung gian được neo luôn: bắt lỗi "hash trùng nhưng CBOR khác".
  and {
    cbor.serialise(seed) == #"d8799f5820000000000000000000000000000000000000000000000000000000000000000100ff",
    crypto.blake2b_256(cbor.serialise(seed)) == #"d7fe829bc1202d4b45654a9f8d017ed3132639e28f419564a348a8c62e627ac9",
  }
}

/// TV-VAULTID-02 — cùng tx, seed index = 7 (chứng minh index đi vào tên NFT)
test vault_id_asset_name_index_7() {
  let seed = OutputReference { transaction_id: t_tx_id, output_index: 7 }
  and {
    cbor.serialise(seed) == #"d8799f5820000000000000000000000000000000000000000000000000000000000000000107ff",
    crypto.blake2b_256(cbor.serialise(seed)) == #"2a3c0cc4d3dc51fe9c02e68a1681b80f9fb29f8f05fcc855f7a466476c361bc8",
  }
}

/// Hai index khác nhau ⇒ hai vault khác nhau (NFT là one-shot theo seed).
test vault_id_asset_name_distinct_per_index() {
  let a =
    crypto.blake2b_256(
      cbor.serialise(OutputReference { transaction_id: t_tx_id, output_index: 0 }),
    )
  let b =
    crypto.blake2b_256(
      cbor.serialise(OutputReference { transaction_id: t_tx_id, output_index: 7 }),
    )
  a != b
}
