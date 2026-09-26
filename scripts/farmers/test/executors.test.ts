import { describe, expect, it } from "vitest";

import { chainAccess } from "../src/chain.ts";
import { buildExecutors, childEnv, interpretChild } from "../src/executors.ts";
import type { ExecContext } from "../src/runner.ts";
import { plan } from "./helpers.ts";

describe("môi trường tiến trình con", () => {
  const base = { PRIVATE_KEY: "k", DEPLOY_WALLET_SEED: "d", FARMER_SEED_01: "a", FARMER_SEED_02: "b", WALLET_SEED: "old", BLOCKFROST_KEY: "bf", TAMPER: "x", PATH: "/bin" };
  it("chỉ mang hạt giống của đúng một nông dân, DRY_RUN=1 ở chế độ dry", () => {
    const e = childEnv(base, "farmer-seed", "Preprod", "dry", {});
    expect(e.WALLET_SEED).toBe("farmer-seed");
    expect(e.DRY_RUN).toBe("1");
    expect(e.BLOCKFROST_KEY).toBe("bf");
    expect(e.PATH).toBe("/bin");
  });
  it("khoá khác bị gỡ; live thì KHÔNG có DRY_RUN; TAMPER cũ không lọt", () => {
    const e = childEnv(base, "farmer-seed", "Preprod", "live", {});
    for (const k of ["PRIVATE_KEY", "DEPLOY_WALLET_SEED", "FARMER_SEED_01", "FARMER_SEED_02", "DRY_RUN", "TAMPER"]) expect(e[k]).toBeUndefined();
  });
});

describe("đọc kết cục tiến trình con", () => {
  it("thoát 0 + dấu DRY RUN ⟹ built; REJECTED do validator ⟹ rejected byScript", () => {
    expect(interpretChild(0, "✔ DRY RUN: tx dựng xong và qua validator khi chạy thử.", "dry", false).kind).toBe("built");
    const r = interpretChild(0, "║   ✅ REJECTED (as expected for negative)   ║\n╚═╝\nReason:    script evaluation failed: validator crashed", "dry", false);
    expect(r).toMatchObject({ kind: "rejected", byScript: true });
  });
  it("thoát 0 KHÔNG có dấu kết cục ⟹ error (không coi là xanh); thoát 3 ở dry ⟹ built (lượt phá lọt)", () => {
    expect(interpretChild(0, "đã chạy xong", "dry", false).kind).toBe("error");
    expect(interpretChild(3, "UNEXPECTED (DRY RUN): tamper tx qua validator", "dry", false).kind).toBe("built");
    expect(interpretChild(1, "❌ Vault UTxO not found.", "dry", false).kind).toBe("prereq-missing");
  });
});

describe("bước chưa dựng được ⟹ skip kèm lý do", () => {
  const p = plan("exec-1", 5, { days: 10 });
  const table = buildExecutors({
    network: "Preprod", access: chainAccess("Preprod", {}), env: {}, wallets: new Map(), workDir: "/nonexistent", taad: null, deploySeed: null,
  });
  const ctx = (action: string, mode: ExecContext["mode"] = "dry"): ExecContext => {
    const step = p.steps.find((s) => s.action === action);
    if (!step) throw new Error(`kế hoạch không có ${action}`);
    return { mode, plan: p, step, farmer: p.farmers.find((f) => f.farmer === step.farmer) ?? null, mutated: false, state: {} };
  };
  it("prepaid_lock · fund_tcarp · beacon_inversion ⟹ skip trỏ đúng việc còn thiếu; vault_open hết lý do cũ", async () => {
    const got: Record<string, unknown> = {};
    for (const a of ["prepaid_lock", "fund_tcarp", "beacon_inversion", "vault_open_instant", "vault_open_schedule", "schedule_fire"] as const) {
      if (!p.steps.some((s) => s.action === a)) continue;
      got[a] = await table[a]!(ctx(a));
    }
    expect(got.beacon_inversion).toMatchObject({ kind: "skip", reason: "keeper-responsibility" });
    if (got.prepaid_lock) expect(got.prepaid_lock).toMatchObject({ kind: "skip", reason: "no-prepaid-lock-builder" });
    if (got.fund_tcarp) expect(got.fund_tcarp).toMatchObject({ kind: "skip", reason: "fund-lacks-tcarp-leg" });
    // env rỗng (không BLOCKFROST_KEY) ⟹ không tiến trình con nào chạy; lý do cụ thể phụ thuộc bản tệp con trong cây.
    for (const v of Object.values(got)) expect(v).toMatchObject({ kind: "skip" });
    for (const v of Object.values(got)) expect((v as { reason: string }).reason).not.toBe("no-vault-genesis-builder");
  });
  it("did_mint không có cấu hình taad ⟹ skip, KHÔNG phải built", async () => {
    const r = await table.did_mint!(ctx("did_mint"));
    expect(r).toMatchObject({ kind: "skip", reason: "no-taad-config" });
    expect(r.kind).not.toBe("built");
  });
});
