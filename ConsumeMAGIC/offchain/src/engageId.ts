// src/engageId.ts — tên asset của thread NFT Engage (state-thread NFT per-app).
//
// ⚠  BẢN SAO CÓ NHÃN. NGUỒN GỐC: `MagicSDK/src/vaultId.ts` (đã chạy xanh, test
//    `MagicSDK/tests/vaultId.test.ts` + neo Aiken
//    `InstantGen/onchain/lib/magiclamp/protocol/vault_id.ak`). Bản sao thứ hai:
//    `scripts/vaultId.ts`. Chép sang đây vì `ConsumeMAGIC/offchain` là npm package
//    ĐỘC LẬP, KHÔNG khai `@magiclamp/sdk` làm dependency (SDK là tầng GỘP, nó phụ
//    thuộc các module — module phụ thuộc ngược lại SDK là đảo chiều).
//    SỬA MỘT BÊN LÀ PHẢI SỬA CẢ BA — lệch một byte thì mint hỏng ngay tại
//    `assets.quantity_of(tx.mint, policy_id, nft_name) == 1`.
//    (Xem "quyết định xin chủ nhân chốt" trong báo cáo: bản-sao-có-nhãn vs
//     tách phép băm ra `@magiclamp/protocol-utils`.)
//
// VÌ SAO CÔNG THỨC Y HỆT VAULT: `validate_mint_engage_id` trong
// `ConsumeMAGIC/onchain/validators/consume.ak` là bản song sinh của
// `validate_mint_vault_id` — cùng khuôn one-shot-theo-seed:
//
//   policy id   = CHÍNH script hash của `consume` ĐÃ apply 7 param (multi-purpose
//                 validator: handler `mint` và `spend` cùng một script, biết nhau
//                 qua TỰ THAM CHIẾU — không bake hash lẫn nhau, không fixed-point)
//   asset name  = blake2b_256( cbor.serialise(seed) )   với seed : OutputReference
//
// KHÔNG còn tên hằng `454e47` ("ENG") của mô hình `engage_nft.ak` cũ. Tên hằng
// nghĩa là MỘT thread cho MỘT policy; tên-theo-seed cho N thread trên cùng policy,
// permissionless, không đụng nhau.
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
//   Bọc thêm một lớp ⇒ hash khác ⇒ mint hỏng.

import { Data, Constr } from "@lucid-evolution/lucid";
import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

/** Seed UTxO một-lần (one-shot) sinh ra danh tính của thread Engage. */
export interface EngageIdSeed {
  /** Tx hash của UTxO seed — 32 byte hex (64 ký tự). */
  txHash: string;
  /** Chỉ số output trong tx đó. */
  outputIndex: number | bigint;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

function normalizeSeed(seed: EngageIdSeed): { txHash: string; index: bigint } {
  if (!seed || typeof seed.txHash !== "string" || !HEX64.test(seed.txHash)) {
    throw new Error(
      `ENGAGE-ID-001: txHash phải là hex 32 byte (64 ký tự), nhận "${seed?.txHash}"`,
    );
  }
  const index = BigInt(seed.outputIndex);
  if (index < 0n) {
    throw new Error(`ENGAGE-ID-002: outputIndex không được âm (nhận ${index})`);
  }
  return { txHash: seed.txHash.toLowerCase(), index };
}

/**
 * CBOR của `seed` đúng như Aiken `cbor.serialise(seed : OutputReference)`.
 * Tách riêng để test neo được cả bước trung gian — hash trùng mà CBOR khác là một
 * loại trùng-hợp che lỗi, phải bắt được.
 */
export function engageSeedCbor(seed: EngageIdSeed): string {
  const { txHash, index } = normalizeSeed(seed);
  return Data.to(new Constr(0, [txHash, index]));
}

/**
 * Tên asset (hex 64 ký tự) của thread NFT Engage sinh từ `seed`.
 *
 * @example
 *   engageAssetName({ txHash: "00…01", outputIndex: 0 })
 *   // → "d7fe829bc1202d4b45654a9f8d017ed3132639e28f419564a348a8c62e627ac9"
 */
export function engageAssetName(seed: EngageIdSeed): string {
  const cborHex = engageSeedCbor(seed);
  return bytesToHex(blake2b(hexToBytes(cborHex), { dkLen: 32 }));
}

/**
 * Unit Lucid (policyId + assetName hex) của thread NFT Engage.
 *
 * BẤT BIẾN #1 (tự tham chiếu): `consumeScriptHash` PHẢI là hash của validator
 * `consume` ĐÃ apply 7 param — nó vừa là policy id của handler `mint`, vừa là
 * payment credential của địa chỉ spend. Truyền nhầm hash khác ⇒ NFT đúc ra nằm
 * dưới policy không ai kiểm được ⇒ `single_thread_nft` từ chối ở lần spend đầu.
 */
export function engageNftUnit(consumeScriptHash: string, seed: EngageIdSeed): string {
  if (!/^[0-9a-fA-F]{56}$/.test(consumeScriptHash)) {
    throw new Error(
      `ENGAGE-ID-003: consumeScriptHash phải là hex 28 byte (56 ký tự), ` +
        `nhận "${consumeScriptHash}"`,
    );
  }
  return consumeScriptHash.toLowerCase() + engageAssetName(seed);
}
