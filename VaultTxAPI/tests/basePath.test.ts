import { describe, expect, it } from "vitest";
import { parseBasePath, stripBasePath } from "../src/basePath.js";
import { handle } from "../src/http.js";

const BP = "/vaulttx/preprod";

describe("basePath: cắt tiền tố do proxy định tuyến theo đường để lại", () => {
  it("cắt đúng ranh giới đoạn. CẶP: tiền tố dính chữ (`preprodX`) KHÔNG bị cắt", () => {
    expect(stripBasePath(`${BP}/tx/consume`, BP)).toBe("/tx/consume");
    expect(stripBasePath(BP, BP)).toBe("/");
    expect(stripBasePath(`${BP}X/tx/consume`, BP)).toBe(`${BP}X/tx/consume`);
  });

  it("đường không mang tiền tố giữ nguyên (gọi thẳng loopback). CẶP: tiền tố rỗng không cắt gì", () => {
    expect(stripBasePath("/health", BP)).toBe("/health");
    expect(stripBasePath(`${BP}/health`, "")).toBe(`${BP}/health`);
  });

  it("parse: rỗng/vắng ⟹ không tiền tố; dạng đúng giữ nguyên; sai dạng NÉM", () => {
    expect(parseBasePath(undefined, "V")).toBe("");
    expect(parseBasePath("", "V")).toBe("");
    expect(parseBasePath(BP, "V")).toBe(BP);
    for (const bad of ["vaulttx", "/vaulttx/", "/Vaulttx", "/vault tx", "//x", "/-x"]) {
      expect(() => parseBasePath(bad, "V"), bad).toThrow(/V=/);
    }
  });
});

describe("/health + định tuyến qua tiền tố", () => {
  const base = {
    // `/health` đọc `lampAsset` (cấu hình bản deploy, không chạm chuỗi) — vỏ dịch vụ chỉ cần đúng getter đó.
    service: { lampAsset: { policyId: "00".repeat(28), assetNameHex: "4c414d50" } } as never, deploymentSource: "src", vaultScopes: [], network: "Preprod",
    chainLabel: "c", changeAddressStrategy: "s", token: "", logInternal: () => {},
  };
  const get = (url: string, deps: object) =>
    handle({ method: "GET", url, headers: {} }, { ...base, ...deps });

  it("có basePath ⟹ `<tiền tố>/health` trả 200 và khai base_path. CẶP: không basePath ⟹ cùng đường là 404", async () => {
    const r = await get(`${BP}/health`, { basePath: BP });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, base_path: BP });

    const r2 = await get(`${BP}/health`, {});
    expect(r2.status).toBe(404);
  });

  it("đường /tx/* qua tiền tố tới đúng bộ định tuyến (404 nêu đường ĐÃ cắt)", async () => {
    const r = await handle({ method: "POST", url: `${BP}/tx/khong-co`, headers: {}, body: {} }, { ...base, basePath: BP });
    expect(r.status).toBe(404);
    expect((r.body as { error: { message: string } }).error.message).toContain(`"/tx/khong-co"`);
  });

  it("gọi thẳng `/health` vẫn 200 khi đã đặt basePath (bộ giám sát trên máy chủ)", async () => {
    expect((await get("/health", { basePath: BP })).status).toBe(200);
  });
});
