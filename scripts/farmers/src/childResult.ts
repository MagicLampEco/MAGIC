// scripts/farmers/src/childResult.ts — đọc kết cục một tiến trình con (`scripts/test/*_only.ts`,
// `scripts/deploy/05|07`). Tách khỏi executors.ts để các bộ đọc theo hợp đồng riêng
// (vaultGenesis.ts, engage.ts) dùng chung bộ đọc gốc mà không nhập vòng.

import { classifyBuildError } from "./chain.ts";
import type { Mode, Outcome } from "./runner.ts";

/** Kết quả thô của MỘT lần chạy. stdout và stderr giữ RIÊNG: hợp đồng "dòng cuối stdout"
 *  không đọc được trên một chuỗi đã trộn hai luồng. */
export interface ChildRun {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export const TX_HASH_RE = /(?:TX hash:|Đã gửi:)\s*([0-9a-f]{64})/;

/** Kết quả con sai hình dạng hợp đồng ⟹ `fail child-result-malformed`, không đoán. */
export function malformed(detail: string): Outcome {
  return { kind: "error", reason: "child-result-malformed", detail: detail.slice(0, 400) };
}

/** Lỗi dựng/gửi → kết cục. `funds` = ví chưa đủ tiền ⟹ điều kiện tiên quyết chưa có. */
export function outcomeOfError(msg: string): Outcome {
  const cls = classifyBuildError(msg);
  if (cls === "script") return { kind: "rejected", byScript: true, detail: msg.slice(0, 400) };
  if (cls === "funds") return { kind: "prereq-missing", detail: `ví chưa đủ tiền: ${msg.slice(0, 300)}` };
  return { kind: "error", detail: msg.slice(0, 400) };
}

/** Đọc kết cục theo quy ước chung của `scripts/test/*_only.ts` (stdout+stderr đã nối). */
export function interpretChild(status: number | null, text: string, mode: Mode, timedOut: boolean): Outcome {
  const tail = text.replace(/\s+/g, " ").trim().slice(-400);
  if (timedOut) return { kind: "error", detail: `tiến trình con quá hạn: ${tail}` };
  const hash = TX_HASH_RE.exec(text)?.[1] ?? null;
  const rej = /REJECTED \(as expected[^\n]*\n[\s\S]*?Reason:\s*([^\n]*)/.exec(text);
  if (rej) return { kind: "rejected", byScript: classifyBuildError(rej[1] ?? "") === "script", detail: (rej[1] ?? "").slice(0, 400) };
  // Thoát 3 = lượt phá LỌT (dry: qua validator; live: đã gửi).
  if (status === 3) {
    if (mode === "dry") return { kind: "built", fee: null, detail: `tamper qua validator: ${tail}` };
    return hash ? { kind: "confirmed", txHash: hash, fee: null, detail: tail } : { kind: "submitted-unconfirmed", txHash: null, fee: null, detail: tail };
  }
  if (status === 0) {
    if (/DRY RUN: tx dựng xong/.test(text)) return { kind: "built", fee: null, detail: tail };
    if (mode === "live" && hash) return { kind: "confirmed", txHash: hash, fee: null, detail: tail };
    return { kind: "error", detail: `thoát 0 mà không có dấu hiệu kết cục nào: ${tail}` };
  }
  if (/not found|không thấy|không tìm thấy/i.test(text) && /vault|utxo|engage|thread|schedule/i.test(text)) {
    return { kind: "prereq-missing", detail: tail };
  }
  return outcomeOfError(tail);
}
