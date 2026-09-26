// Trạng thái nông dân: artifacts đi từ bước trước sang bước sau, đúng luật `runDay` ▸ `absorb`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventLog, readEvents, type StepEvent } from "../src/eventLog.ts";
import type { ActionKind } from "../src/plan.ts";
import { runDay, statusOf, type ExecutorTable, type Mode, type Outcome } from "../src/runner.ts";
import { plan } from "./helpers.ts";

const p = plan("state-1", 5, { days: 6 });
const logPath = () => join(mkdtempSync(join(tmpdir(), "farmer-state-")), "events.jsonl");

describe("artifacts → ExecContext.state", () => {
  it("dry: vault_open dựng khô để lại vault_nft; bước sau CÙNG nông dân nhận được, nông dân khác thì không", async () => {
    const seen: { farmer: string; action: string; state: Record<string, string> }[] = [];
    const t: ExecutorTable = {};
    const acts: ActionKind[] = ["fund", "fund_tcarp", "did_mint", "engage_mint", "schedule_commit", "tamper", "instant_gen", "schedule_fire", "consume", "prepaid_lock", "beacon_inversion"];
    for (const a of acts) {
      t[a] = async (c): Promise<Outcome> => {
        seen.push({ farmer: c.step.farmer, action: a, state: { ...c.state } });
        return a === "fund" || a === "did_mint" ? { kind: "built", fee: null } : { kind: "skip", reason: "test", detail: a };
      };
    }
    t.vault_open_instant = t.vault_open_schedule = async (c) => ({ kind: "built", fee: null, artifacts: { vault_nft: `nft-${c.step.farmer}` } });
    const path = logPath();
    const log = new EventLog(path, p.digest);
    for (let d = 0; d < p.params.days; d++) await runDay(p, d, log, t, { mode: "dry", priorEvents: readEventsSafe(path) });
    const after = seen.filter((s) => ["engage_mint", "instant_gen", "schedule_commit", "tamper"].includes(s.action));
    expect(after.length).toBeGreaterThan(0);
    for (const s of after) expect(s.state.vault_nft).toBe(`nft-${s.farmer}`);
    const opens = readEvents(path).filter((e) => e.action.startsWith("vault_open"));
    for (const e of opens) expect(e).toMatchObject({ reason: "dry-built-not-submitted", artifacts: { vault_nft: `nft-${e.farmer}` } });
  });

  it("artifact của lượt DRY không vào lượt LIVE; dòng fail không để lại gì; dòng done live thì có", async () => {
    const open = p.steps.find((s) => s.action === "vault_open_instant")!;
    const gen = p.steps.find((s) => s.action === "instant_gen" && s.farmer === open.farmer)!;
    const ev = (mode: Mode, status: StepEvent["status"]): StepEvent => ({
      schema: "magiclamp:farmer-sim:event:v1", planDigest: p.digest, stepId: open.stepId, farmer: open.farmer, day: open.day,
      action: open.action, mode, status, reason: "x", txHash: null, fee: null, at: "t", artifacts: { vault_nft: "A" },
    });
    const probe = async (prior: StepEvent[]) => {
      let got: Record<string, string> | null = null;
      const t: ExecutorTable = { instant_gen: async (c) => ((got = { ...c.state }), { kind: "skip", reason: "t", detail: "t" }) };
      await runDay(p, gen.day, new EventLog(logPath(), p.digest), t, { mode: "live", priorEvents: prior });
      return got;
    };
    expect(await probe([ev("dry", "done")])).toEqual({});
    expect(await probe([ev("live", "done")])).toEqual({ vault_nft: "A" });
  });

  it("statusOf: error mang reason ⟹ fail đúng reason; không reason ⟹ build-error; artifacts đi theo", () => {
    expect(statusOf("accept", "live", { kind: "error", reason: "child-owner-mismatch", detail: "d" })).toMatchObject({ status: "fail", reason: "child-owner-mismatch" });
    expect(statusOf("accept", "live", { kind: "error", detail: "d" })).toMatchObject({ status: "fail", reason: "build-error" });
    expect(statusOf("accept", "dry", { kind: "built", fee: null, artifacts: { a: "b" } })).toMatchObject({ reason: "dry-built-not-submitted", artifacts: { a: "b" } });
  });
});

function readEventsSafe(path: string): StepEvent[] {
  try {
    return readEvents(path);
  } catch {
    return [];
  }
}
