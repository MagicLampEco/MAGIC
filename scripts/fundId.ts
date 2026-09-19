// scripts/fundId.ts — tên asset của NFT định danh quỹ Paid (PrepaidGen).
//
// 🔴 ĐÂY KHÔNG PHẢI CÙNG PHÉP BĂM VỚI `vaultId.ts`, và hai cái ở cạnh nhau trong
// CÙNG MỘT GIAO DỊCH deploy. Đó là lý do tệp này đứng riêng thay vì thêm một hàm
// vào `vaultId.ts`: hai hàm cùng nhận một `{txHash, outputIndex}`, cùng trả 64 ký
// tự hex, và gọi nhầm hàm thì KHÔNG có gì đỏ ở tầng TypeScript — nó đỏ trên chuỗi,
// ở một dòng `expect` không nói tên hàm nào.
//
//   NFT vault  : blake2b_256( cbor.serialise(OutputReference) )
//                → Constr 0 [ bytes(32), int ]  — có khung CBOR
//                Neo: PrepaidGen/onchain/validators/prepaid.ak ▸ `vault_id_name`
//
//   NFT quỹ    : blake2b_256( tx_hash ‖ be8(output_index) )
//                → 32 byte thô nối 8 byte big-endian — KHÔNG khung CBOR
//                Neo: PrepaidGen/onchain/lib/magiclamp/protocol/math.ak ▸ `compute_fund_id`
//
// Cùng đầu vào, khác đầu ra, và cả hai đều là tên tài sản hợp lệ. Phép thử một
// dòng trước khi sửa tệp này: *"đổi ở đây thì bên Aiken ai báo?"* — không ai;
// nên mọi thay đổi phải đi kèm đọc lại đúng hai hàm Aiken nêu trên.

import { blake2b } from "@noble/hashes/blake2b";

/** UTxO bị TIÊU trong chính giao dịch đúc — nguồn tính duy nhất của tên quỹ. */
export interface FundIdSeed {
  /** Tx hash của UTxO seed — 32 byte hex (64 ký tự). */
  txHash: string;
  /** Chỉ số output trong tx đó. */
  outputIndex: number | bigint;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * `compute_fund_id(tx_hash, output_index)` — bản TypeScript.
 *
 * `output_index` mã hoá thành ĐÚNG 8 byte big-endian. Đây là chỗ dễ lệch nhất:
 * một bản dựng dùng độ dài tối thiểu (1 byte cho index 0) vẫn chạy trót lọt ở
 * TypeScript và cho một hash khác — rồi `list.any(tx.inputs, …)` trong
 * `validate_mint_fund_nft` không khớp input nào và giao dịch chết với một thông
 * điệp không trỏ về đây.
 */
export function fundIdAssetName(seed: FundIdSeed): string {
  if (!seed || typeof seed.txHash !== "string" || !HEX64.test(seed.txHash)) {
    throw new Error(
      `fundIdAssetName: txHash phải là hex 32 byte (64 ký tự), nhận "${seed?.txHash}"`,
    );
  }
  const index = BigInt(seed.outputIndex);
  if (index < 0n) {
    throw new Error(`fundIdAssetName: outputIndex không được âm (nhận ${index})`);
  }
  if (index > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`fundIdAssetName: outputIndex vượt 8 byte (nhận ${index})`);
  }

  const txBytes = Buffer.from(seed.txHash.toLowerCase(), "hex");
  const idxBytes = Buffer.alloc(8);
  idxBytes.writeBigUInt64BE(index);

  const digest = blake2b(Buffer.concat([txBytes, idxBytes]), { dkLen: 32 });
  return Buffer.from(digest).toString("hex");
}
