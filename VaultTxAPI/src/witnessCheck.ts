// VaultTxAPI/src/witnessCheck.ts — kiểm bộ chứng ký app gửi lên `/tx/submit` TRƯỚC mọi tác dụng phụ.
//
// ── VÌ SAO (2026-10-06) ──────────────────────────────────────────────────────────
// Trước bản này `/tx/submit` chỉ đòi bộ chứng ký "có ít nhất một vkey", rồi gửi nút; nút chưa trả
// lời kịp thì dịch vụ đã ghi `unconfirmed` (`PendingSpends.note` + `IssuedTxRegistry.markSubmitted`).
// Hai lần ghi đó có tác dụng thật: input vào sổ chờ (tx chung khoá khác bị 409) và tx chung khoá
// dựng trước bị đánh dấu "bị thay". Nên một chữ ký RÁC trên tx người khác dựng — thứ chắc chắn bị
// sổ cái bác — vẫn đủ để chặn và thay tx thật của chủ. Cổng ở đây làm hai phép, đều thuần, đều
// trước mọi lần ghi:
//   1. MỖI vkey witness phải là chữ ký Ed25519 hợp lệ trên body hash (một chữ ký hỏng là hỏng cả
//      tx — sổ cái cũng bác như vậy);
//   2. tập khoá đã ký (của app gộp với witness có sẵn trong tx) phải PHỦ ĐỦ `required_signers`.

import { CML } from "@lucid-evolution/lucid";

import { CodedApiError } from "./errors.js";

/**
 * Ném 400 có mã khi bộ chứng ký không thể làm tx hợp lệ. Trả về tập keyhash (hex) đã ký hợp lệ.
 *
 * `appWitnesses` là bộ app gửi; `tx.witness_set()` là phần dịch vụ đã gắn sẵn (nếu có) — cả hai
 * đều được kiểm chữ ký, vì tx ghép xong mang cả hai.
 */
export function assertWitnessesCoverTx(tx: CML.Transaction, appWitnesses: CML.TransactionWitnessSet): Set<string> {
  const bodyHash = CML.hash_transaction(tx.body());
  const msg = bodyHash.to_raw_bytes();
  const signed = new Set<string>();
  const sets: Array<[string, CML.TransactionWitnessSet]> = [["witness_cbor", appWitnesses], ["tx_cbor", tx.witness_set()]];
  for (const [where, ws] of sets) {
    const vks = ws.vkeywitnesses();
    for (let i = 0; vks !== undefined && i < vks.len(); i++) {
      const w = vks.get(i);
      const pk = w.vkey();
      const keyHash = pk.hash().to_hex();
      if (!pk.verify(msg, w.ed25519_signature())) {
        throw new CodedApiError(400, "WITNESS_SIGNATURE_INVALID",
          `Chữ ký của khoá ${keyHash} (trong ${where}) không khớp thân giao dịch ${bodyHash.to_hex()}. ` +
          `Ký đúng thân tx dịch vụ vừa trả rồi gửi lại; chữ ký này chắc chắn bị chuỗi từ chối.`,
          { key_hash: keyHash, body_hash: bodyHash.to_hex(), source: where });
      }
      signed.add(keyHash);
    }
  }
  const rs = tx.body().required_signers();
  const missing: string[] = [];
  for (let i = 0; rs !== undefined && i < rs.len(); i++) {
    const h = rs.get(i).to_hex();
    if (!signed.has(h)) missing.push(h);
  }
  if (missing.length > 0) {
    throw new CodedApiError(400, "WITNESS_MISSING_SIGNER",
      `Bộ chứng ký thiếu chữ ký của ${missing.length} khoá bắt buộc (required_signers): ${missing.join(", ")}.`,
      { missing_signers: missing, body_hash: bodyHash.to_hex() });
  }
  return signed;
}
