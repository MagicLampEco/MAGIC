// scripts/txOutputIndex.ts — chỉ số output của một giao dịch ĐÃ DỰNG (chưa cần ký).
//
// Tách khỏi `runResult.ts` vì tệp đó phải thuần (không nạp Lucid) để bộ kiểm chạy nhanh
// và không phụ thuộc WASM. Phần quyết định — "đúng MỘT output, đúng địa chỉ, đúng 1 NFT"
// — nằm ở `runResult.ts ▸ singleOutputIndexWithUnit` và được kiểm ở đó.
//
// Vì sao đọc từ thân giao dịch mà không chờ chỉ mục: thân giao dịch là thứ bị băm ra tx
// hash, chữ ký chỉ thêm chứng từ chứ không đổi thân. Nên chỉ số đọc ở đây là chỉ số thật
// của UTxO sau khi gửi, và đọc được ngay cả ở lượt DRY_RUN không gửi gì.

import { coreToTxOutput, type TxSignBuilder } from "@lucid-evolution/lucid";
import { singleOutputIndexWithUnit, type OutputLike } from "./runResult.js";

export function outputIndexWithUnit(tx: TxSignBuilder, address: string, unit: string): number {
  const outs = tx.toTransaction().body().outputs();
  const list: OutputLike[] = [];
  for (let i = 0; i < outs.len(); i++) {
    const o = coreToTxOutput(outs.get(i));
    list.push({ address: o.address, assets: o.assets });
  }
  return singleOutputIndexWithUnit(list, address, unit);
}
