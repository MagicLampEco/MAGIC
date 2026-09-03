// MagicSDK/src/vaultId.ts — tên asset của NFT danh-tính vault (state-thread NFT)
//
// BỐI CẢNH (INV-VAULT-IDENTITY, commit 17f051d8)
// Cardano chỉ chạy validator khi UTxO bị TIÊU, không bao giờ khi UTxO được TẠO.
// Địa chỉ script vault là công khai ⇒ kẻ tấn công có thể đặt một UTxO với datum
// BỊA (consumed_credit khổng lồ, magic_batches giả) vào chính địa chỉ đó. Vá:
// mỗi vault mang một NFT "state-thread" chỉ ra đời được qua handler `mint` của
// chính validator vault (handler đó ép datum khởi sinh SẠCH), và MỌI nhánh
// `spend` đều đòi NFT đó còn nguyên trên output nối tiếp.
//
//   policy id   = chính script hash của vault đã apply params (multi-purpose
//                 validator: `mint` và `spend` cùng một script)
//   asset name  = blake2b_256( cbor.serialise(seed) )   với seed : OutputReference
//
// Nguồn on-chain: `validate_mint_vault_id` trong
//   InstantGen/onchain/validators/vault.ak  (và bản song sinh ở ScheduleGen)
//
// ĐỐI CHIẾU BIT-IDENTICAL (P8): hằng số sinh ra ở đây được neo song song trong
//   InstantGen/onchain/lib/magiclamp/protocol/vault_id.ak  (test Aiken)
//   MagicSDK/tests/vaultId.test.ts                          (test vitest)
// Lệch một bên ⇒ cả hai cùng đỏ.
//
// DẠNG CBOR ĐÚNG của OutputReference (PlutusV3 / Conway, aiken stdlib v3.1.0):
//   OutputReference { transaction_id: ByteArray, output_index: Int }
//     → Constr 0 [ bytes(32), int ]
//     → d879                tag 121 = 121 + 0 (chỉ số constructor 0)
//       9f                  mảng ĐỘ-DÀI-BẤT-ĐỊNH (KHÔNG phải 0x82 định-độ-dài)
//       5820 <32 byte>      transaction_id
//       <int>               output_index
//       ff                  break
//   PlutusV1/V2 bọc transaction_id trong một Constr 0 (TxId) nữa; V3 thì KHÔNG.
//   Bọc thêm một lớp ⇒ hash khác ⇒ mint hỏng ở `quantity_of(...) == 1`.

import { Data, Constr } from "@lucid-evolution/lucid";
import { blake2b } from "@noble/hashes/blake2b";

/** Seed UTxO một-lần (one-shot) sinh ra danh tính của vault. */
export interface VaultIdSeed {
  /** Tx hash của UTxO seed — 32 byte hex (64 ký tự). */
  txHash: string;
  /** Chỉ số output trong tx đó. */
  outputIndex: number | bigint;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

function normalizeSeed(seed: VaultIdSeed): { txHash: string; index: bigint } {
  if (!seed || typeof seed.txHash !== "string" || !HEX64.test(seed.txHash)) {
    throw new Error(
      `vaultIdAssetName: txHash phải là hex 32 byte (64 ký tự), nhận "${seed?.txHash}"`,
    );
  }
  const index = BigInt(seed.outputIndex);
  if (index < 0n) {
    throw new Error(`vaultIdAssetName: outputIndex không được âm (nhận ${index})`);
  }
  return { txHash: seed.txHash.toLowerCase(), index };
}

/**
 * CBOR của `seed` đúng như Aiken `cbor.serialise(seed : OutputReference)`.
 * Tách riêng để test neo được cả bước trung gian — hash trùng mà CBOR khác là
 * một loại trùng-hợp che lỗi, phải bắt được.
 */
export function vaultIdSeedCbor(seed: VaultIdSeed): string {
  const { txHash, index } = normalizeSeed(seed);
  // Constr 0 [ bytes, int ] — Data.to phát ra tag 121 + mảng bất-định, khớp
  // đúng bộ mã hoá Plutus Data của ledger mà `cbor.serialise` dùng.
  return Data.to(new Constr(0, [txHash, index]));
}

/**
 * Tên asset (hex 64 ký tự) của NFT danh-tính vault sinh từ `seed`.
 *
 * @example
 *   vaultIdAssetName({ txHash: "00…01", outputIndex: 0 })
 *   // → "d7fe829bc1202d4b45654a9f8d017ed3132639e28f419564a348a8c62e627ac9"
 */
export function vaultIdAssetName(seed: VaultIdSeed): string {
  const cborHex = vaultIdSeedCbor(seed);
  const digest = blake2b(Buffer.from(cborHex, "hex"), { dkLen: 32 });
  return Buffer.from(digest).toString("hex");
}
