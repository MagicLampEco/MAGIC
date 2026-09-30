// Bản song sinh của `VaultTxAPI/tests/buildInfo.test.ts` — cùng ca, cho bản chép `src/buildInfo.ts`.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildInfo, type GitRunner } from "../src/buildInfo.js";
import { handle } from "../src/http.js";

const SHA = "a3c223cd".padEnd(40, "0");

function runner(out: { head?: string | Error; status?: string | Error }): GitRunner {
  return (args) => {
    const v = args[0] === "rev-parse" ? out.head : out.status;
    if (v instanceof Error) throw v;
    return v ?? "";
  };
}

describe("buildInfo: commit của mã đang chạy", () => {
  it("cây sạch ⟹ commit + dirty:false. CẶP: có tệp track bị sửa ⟹ dirty:true", () => {
    expect(readBuildInfo("/x", runner({ head: `${SHA}\n`, status: "" })))
      .toEqual({ commit: SHA, dirty: false, source: "git" });
    expect(readBuildInfo("/x", runner({ head: `${SHA}\n`, status: " M VaultReadAPI/src/http.ts\n" })))
      .toEqual({ commit: SHA, dirty: true, source: "git" });
  });

  it("không có git ⟹ commit:null + source unavailable kèm lý do, KHÔNG đoán", () => {
    const b = readBuildInfo("/x", runner({ head: new Error("spawn git ENOENT\nstack…") }));
    expect(b).toEqual({ commit: null, dirty: null, source: "unavailable", reason: "spawn git ENOENT" });
  });

  it("rev-parse trả hình dạng lạ ⟹ unavailable, không in chuỗi lạ ra làm commit", () => {
    const b = readBuildInfo("/x", runner({ head: "HEAD\n", status: "" }));
    expect(b.commit).toBeNull();
    expect(b.source).toBe("unavailable");
  });

  it("status hỏng ⟹ commit vẫn có, dirty:null (không đo được ≠ sạch)", () => {
    expect(readBuildInfo("/x", runner({ head: SHA, status: new Error("lock") })))
      .toEqual({ commit: SHA, dirty: null, source: "git" });
  });
});

describe("/health khai commit", () => {
  const base = { service: {} as never, scopes: [], network: "Preprod", chainLabel: "c", token: "" };

  it("có build ⟹ in commit/dirty/source. CẶP: vắng build ⟹ commit null + not_measured", async () => {
    const r = await handle({ method: "GET", url: "/health", headers: {} },
      { ...base, build: { commit: SHA, dirty: false, source: "git" } });
    expect(r.body).toMatchObject({ commit: SHA, commit_dirty: false, commit_source: "git" });
    expect(r.body).not.toHaveProperty("commit_unavailable_reason");

    const r2 = await handle({ method: "GET", url: "/health", headers: {} }, base);
    expect(r2.body).toMatchObject({ commit: null, commit_dirty: null, commit_source: "not_measured" });
  });

  it("không đo được ⟹ in lý do", async () => {
    const r = await handle({ method: "GET", url: "/health", headers: {} },
      { ...base, build: { commit: null, dirty: null, source: "unavailable", reason: "spawn git ENOENT" } });
    expect(r.body).toMatchObject({ commit: null, commit_source: "unavailable", commit_unavailable_reason: "spawn git ENOENT" });
  });
});

// Bản chép và nguồn không có workspace chung ⟹ không gì khác bắt được chúng trôi khỏi nhau.
// So THÂN tệp (bỏ khối nhãn đầu của mỗi bên), không so byte trọn tệp.
describe("bản chép buildInfo.ts không trôi khỏi nguồn", () => {
  it("thân VaultReadAPI/src/buildInfo.ts == thân VaultTxAPI/src/buildInfo.ts", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const body = (p: string) => {
      const s = readFileSync(p, "utf8");
      const i = s.indexOf("\nimport ");
      if (i < 0) throw new Error(`không thấy dòng import đầu tiên trong ${p}`);
      return s.slice(i);
    };
    expect(body(join(here, "../src/buildInfo.ts"))).toBe(body(join(here, "../../VaultTxAPI/src/buildInfo.ts")));
  });
});
