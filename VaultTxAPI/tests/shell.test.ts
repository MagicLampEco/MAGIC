// VaultTxAPI/tests/shell.test.ts — vỏ HTTP: lỗi của người gửi giữ câu (400), lỗi hệ thống thô ra
// mã tham chiếu (500) và mã đó PHẢI có ở nhật ký. Cặp đối chứng: cùng một nhánh `.catch`, hai loại
// lỗi, hai phản hồi khác nhau — một hiện thực trả 400 + `e.message` cho mọi thứ (bản cũ) đỏ ở vế 500.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { readJsonBody, shellErrorResponse } from "../src/shell.js";

function stream(): PassThrough { return new PassThrough(); }

function collectLog(): { log: (ref: string, cause: unknown) => void; calls: { ref: string; cause: unknown }[] } {
  const calls: { ref: string; cause: unknown }[] = [];
  return { log: (ref, cause) => { calls.push({ ref, cause }); }, calls };
}

type ErrBody = { error: { code: string; message: string; details: Record<string, unknown> } };

describe("readJsonBody", () => {
  it("thân rỗng ⟹ undefined; thân JSON ⟹ giá trị đã phân tích", async () => {
    const a = stream(); const pa = readJsonBody(a, 1024); a.end("  ");
    expect(await pa).toBeUndefined();
    const b = stream(); const pb = readJsonBody(b, 1024); b.end('{"x":1}');
    expect(await pb).toEqual({ x: 1 });
  });
});

describe("shellErrorResponse — lỗi tới nhánh .catch của vỏ", () => {
  it("thân không phải JSON ⟹ 400 BAD_REQUEST giữ câu, KHÔNG mã tham chiếu, KHÔNG ghi nhật ký nội bộ", async () => {
    const s = stream(); const p = readJsonBody(s, 1024); s.end("{hỏng");
    const e = await p.then(() => { throw new Error("phải ném"); }, (x: unknown) => x);
    const { log, calls } = collectLog();
    const r = shellErrorResponse(e, log);
    expect(r.status).toBe(400);
    const b = r.body as ErrBody;
    expect(b.error.code).toBe("BAD_REQUEST");
    expect(b.error.message).toMatch(/^Thân bài không phải JSON hợp lệ: /);
    expect(b.error.details).not.toHaveProperty("reference_code");
    expect(calls).toHaveLength(0);
  });

  it("thân vượt trần ⟹ 400 BAD_REQUEST, câu nêu trần + details.max_body_bytes", async () => {
    const s = stream(); const p = readJsonBody(s, 8); s.write(Buffer.from("0123456789"));
    const e = await p.then(() => { throw new Error("phải ném"); }, (x: unknown) => x);
    const r = shellErrorResponse(e, collectLog().log);
    expect(r.status).toBe(400);
    const b = r.body as ErrBody;
    expect(b.error.message).toBe("Thân bài vượt 8 byte.");
    expect(b.error.details).toEqual({ max_body_bytes: 8 });
  });

  it("CỰC ĐỐI: luồng đọc đứt (lỗi hệ thống) ⟹ 500 INTERNAL + reference_code; câu thô KHÔNG ra ngoài, mã có ở nhật ký", async () => {
    const s = stream(); const p = readJsonBody(s, 1024);
    const raw = new Error("read ECONNRESET at /srv/vault-tx-api/node_modules/x.js:12");
    s.destroy(raw);
    const e = await p.then(() => { throw new Error("phải ném"); }, (x: unknown) => x);
    expect(e).toBe(raw);
    const { log, calls } = collectLog();
    const r = shellErrorResponse(e, log);
    expect(r.status).toBe(500);
    const b = r.body as ErrBody;
    expect(b.error.code).toBe("INTERNAL");
    expect(b.error.details.reference_code).toMatch(/^ref_[0-9a-f]{12}$/);
    expect(JSON.stringify(r.body)).not.toMatch(/ECONNRESET|\/srv\//);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ref).toBe(b.error.details.reference_code);
    expect(calls[0]!.cause).toBe(raw);
  });

  it("lỗi lập trình ở vỏ (JSON.stringify trên BigInt) ⟹ 500 INTERNAL, không phải 400", () => {
    let e: unknown;
    try { JSON.stringify({ n: 1n }); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(TypeError);
    const r = shellErrorResponse(e, collectLog().log);
    expect(r.status).toBe(500);
    expect((r.body as ErrBody).error.code).toBe("INTERNAL");
  });
});
