// VaultReadAPI/tests/internalError.test.ts — nhánh 500 của `handle`: người gọi nhận MÃ THAM
// CHIẾU, nhật ký nhận mã + nguyên nhân. CẶP ca: lỗi ngoài dự kiến (500 + mã + ghi nhật ký) ↔
// lỗi tự khai mã (`ChainUnavailableError` ⟹ 502, KHÔNG ghi vào nhánh 500).
import { describe, expect, it } from "vitest";

import type { ChainReader } from "../src/chain.js";
import { ChainUnavailableError } from "../src/errors.js";
import { handle } from "../src/http.js";
import { VaultReadService } from "../src/service.js";
import type { VaultScope } from "../src/config.js";
import { PREPROD_TIP_AT_BATCH_EPOCH, PREVIEW_OWNER_PKH, PREVIEW_VAULT_ADDRESS, PREVIEW_VAULT_SCRIPT_HASH } from "./fixtures/preview-e5fd34b1.js";

const SCOPES: VaultScope[] = [{
  vaultType: "Schedule", address: PREVIEW_VAULT_ADDRESS, scriptHash: PREVIEW_VAULT_SCRIPT_HASH, source: "phép kiểm",
}];
const TOKEN = "thebai-chi-de-kiem-thu-khong-phai-bi-mat";
/** Câu lỗi mang một đường dẫn nội bộ giả — phản hồi KHÔNG được chứa nó. */
const LEAKY = "ENOENT: /Users/nobody/secret/state.json";

function throwingReader(err: Error): ChainReader {
  return {
    label: "throwing",
    utxosAt: async () => { throw err; },
    tip: async () => PREPROD_TIP_AT_BATCH_EPOCH,
  };
}

function run(err: Error) {
  const logged: { ref: string; cause: unknown }[] = [];
  const reader = throwingReader(err);
  const deps = {
    service: new VaultReadService("Preprod", SCOPES, reader), scopes: SCOPES, network: "Preprod",
    chainLabel: reader.label, token: TOKEN, logInternal: (ref: string, cause: unknown) => { logged.push({ ref, cause }); },
  };
  const res = handle({ method: "GET", url: `/vault/by-owner/${PREVIEW_OWNER_PKH}`, headers: { authorization: `Bearer ${TOKEN}` } }, deps);
  return { res, logged };
}

describe("nhánh 500 — mã tham chiếu tra ngược được", () => {
  it("lỗi ngoài dự kiến ⟹ 500 INTERNAL + details.reference_code; nhật ký nhận ĐÚNG mã đó + nguyên nhân; phản hồi không lộ câu lỗi", async () => {
    const boom = new Error(LEAKY);
    const { res, logged } = run(boom);
    const r = await res;
    expect(r.status).toBe(500);
    const body = r.body as { error: { code: string; details: { reference_code: string } } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.details.reference_code).toMatch(/^ref_[0-9a-f]{12}$/);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.ref).toBe(body.error.details.reference_code);
    expect(logged[0]!.cause).toBe(boom);
    expect(JSON.stringify(r.body)).not.toContain("/Users/");
    expect(JSON.stringify(r.body)).not.toContain("ENOENT");
  });

  it("CỰC ĐỐI: lỗi tự khai mã (ChainUnavailableError) ⟹ 502 nguyên mã, KHÔNG đi nhánh 500, không ghi nhật ký nội bộ", async () => {
    const { res, logged } = run(new ChainUnavailableError("nút chuỗi hết giờ"));
    const r = await res;
    expect(r.status).toBe(502);
    expect((r.body as { error: { code: string } }).error.code).toBe("CHAIN_UNAVAILABLE");
    expect(logged).toHaveLength(0);
  });

  it("hai lượt lỗi ⟹ hai mã khác nhau (mã là của LƯỢT, không phải của loại lỗi)", async () => {
    const a = await run(new Error("x")).res;
    const b = await run(new Error("x")).res;
    const code = (r: typeof a) => (r.body as { error: { details: { reference_code: string } } }).error.details.reference_code;
    expect(code(a)).not.toBe(code(b));
  });
});
