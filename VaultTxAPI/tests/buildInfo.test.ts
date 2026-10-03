import { describe, expect, it } from "vitest";
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
    expect(readBuildInfo("/x", runner({ head: `${SHA}\n`, status: " M VaultTxAPI/src/http.ts\n" })))
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
  const base = {
    // `/health` đọc `lampAsset` (cấu hình bản deploy, không chạm chuỗi) — vỏ dịch vụ chỉ cần đúng getter đó.
    service: { lampAsset: { policyId: "00".repeat(28), assetNameHex: "4c414d50" } } as never, deploymentSource: "src", vaultScopes: [], network: "Preprod",
    chainLabel: "c", changeAddressStrategy: "s", token: "", logInternal: () => {},
  };

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
