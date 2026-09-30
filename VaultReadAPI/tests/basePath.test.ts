import { describe, expect, it } from "vitest";
import { stripBasePath } from "../src/basePath.js";
import { handle } from "../src/http.js";

const BP = "/vaultread/preprod";

describe("basePath (bản chép của VaultTxAPI/src/basePath.ts)", () => {
  it("cắt đúng ranh giới đoạn. CẶP: tiền tố dính chữ không bị cắt", () => {
    expect(stripBasePath(`${BP}/threads/status`, BP)).toBe("/threads/status");
    expect(stripBasePath(`${BP}X/threads/status`, BP)).toBe(`${BP}X/threads/status`);
  });
});

describe("định tuyến qua tiền tố", () => {
  const base = { service: {} as never, scopes: [], network: "Preprod", chainLabel: "c", token: "" };
  const get = (url: string, deps: object) => handle({ method: "GET", url, headers: {} }, { ...base, ...deps });

  it("có basePath ⟹ `<tiền tố>/health` 200 + base_path. CẶP: không basePath ⟹ `<tiền tố>/threads/status` là 404", async () => {
    const r = await get(`${BP}/health`, { basePath: BP });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, base_path: BP });
    expect((await get(`${BP}/threads/status`, {})).status).toBe(404);
  });

  it("qua tiền tố, `/threads/*` tới đúng nhánh chỉ mục (tắt ⟹ 503 THREAD_INDEX_DISABLED, không phải 404)", async () => {
    const r = await get(`${BP}/threads/status`, { basePath: BP });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).toContain("THREAD_INDEX_DISABLED");
  });
});
