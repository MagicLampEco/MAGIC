// VaultTxAPI/src/shell.ts — phần của VỎ HTTP (`server.ts`) tách ra để kiểm được: đọc thân bài,
// và luật trả lời cho lỗi lọt tới nhánh `.catch` của vỏ.
//
// Luật (cùng luật nhánh 500 của `http.ts` ▸ `handle`):
//   · lỗi do NGƯỜI GỬI (thân không phải JSON, thân quá lớn) ⟹ 400 `BAD_REQUEST`, giữ câu — câu đó
//     nói người gửi phải sửa gì, và nó do chính dịch vụ viết (không mang đường dẫn nội bộ);
//   · mọi thứ khác (luồng đọc đứt, `JSON.stringify` ném trên BigInt, lỗi lập trình) ⟹ 500
//     `INTERNAL` kèm `details.reference_code`; câu thô + stack chỉ vào nhật ký, cùng mã đó.
//
// Bản trước trả 400 `BAD_REQUEST` + nguyên văn `e.message` cho MỌI lỗi tới vỏ, nên một lỗi hệ
// thống đi ra ngoài thành "lỗi của người gửi" kèm câu thô, và không mã nào tra ngược được.

import type { Readable } from "node:stream";

import { BadRequestError, TxApiError, newReferenceCode } from "./errors.js";
import type { HttpResponse } from "./http.js";

/** Đọc thân bài JSON. Thân rỗng ⇒ `undefined` (hợp lệ với GET); thân hỏng / quá lớn ⇒ NÉM
 *  `BadRequestError` (lỗi của người gửi); luồng đứt ⇒ ném NGUYÊN lỗi của luồng (lỗi hệ thống). */
export function readJsonBody(rq: Readable, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (e: unknown): void => { if (!done) { done = true; reject(e); } };
    rq.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        fail(new BadRequestError(`Thân bài vượt ${maxBytes} byte.`, { max_body_bytes: maxBytes }));
        rq.destroy();
        return;
      }
      chunks.push(c);
    });
    rq.on("end", () => {
      if (done) return;
      const text = Buffer.concat(chunks).toString("utf8");
      done = true;
      if (text.trim() === "") { resolve(undefined); return; }
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new BadRequestError(`Thân bài không phải JSON hợp lệ: ${(e as Error).message}`));
      }
    });
    rq.on("error", fail);
  });
}

/** Trả lời cho một lỗi lọt tới nhánh `.catch` của vỏ. Lỗi của người gửi giữ mã + câu; còn lại
 *  ⟹ 500 + mã tham chiếu, và `logInternal` nhận đúng mã đó cùng nguyên nhân gốc. */
export function shellErrorResponse(e: unknown, logInternal: (referenceCode: string, cause: unknown) => void): HttpResponse {
  if (e instanceof TxApiError) return { status: e.httpStatus, body: e.toBody() };
  const ref = newReferenceCode();
  logInternal(ref, e);
  return {
    status: 500,
    body: { error: { code: "INTERNAL", message: "Lỗi nội bộ của dịch vụ dựng giao dịch.", details: { reference_code: ref } } },
  };
}
