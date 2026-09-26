import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventLog, readEvents, reconcile } from "../src/eventLog.ts";
import type { ActionKind } from "../src/plan.ts";
import { runDay, type ExecutorTable, type Outcome } from "../src/runner.ts";
import { plan } from "./helpers.ts";

const ACTIONS: ActionKind[] = [
  "fund", "fund_tcarp", "did_mint", "vault_open_instant", "vault_open_schedule", "engage_mint", "schedule_commit",
  "tamper", "instant_gen", "schedule_fire", "consume", "prepaid_lock", "beacon_inversion",
];

/** Executor giả: mọi hành động trả `skip` có lý do — đủ để kiểm SỔ, không cần chuỗi. */
function skipAll(): ExecutorTable {
  const t: ExecutorTable = {};
  for (const a of ACTIONS) t[a] = async (): Promise<Outcome> => ({ kind: "skip", reason: "test-skip", detail: a });
  return t;
}

async function runAll(seed: string) {
  const p = plan(seed, 5, { days: 8 });
  const path = join(mkdtempSync(join(tmpdir(), "farmer-test-")), "events.jsonl");
  const log = new EventLog(path, p.digest);
  for (let d = 0; d < p.params.days; d++) await runDay(p, d, log, skipAll(), { mode: "dry", priorEvents: existsSync(path) ? readEvents(path) : [] });
  return { p, events: readEvents(path) };
}

describe("đối chiếu sổ SỰ KIỆN với KẾ HOẠCH", () => {
  it("runner chạy hết ⟹ mọi bước có ĐÚNG MỘT dòng, reconcile.ok", async () => {
    const { p, events } = await runAll("rec-1");
    expect(events.length).toBe(p.steps.length);
    const r = reconcile(p, events, p.params.days - 1);
    expect(r).toMatchObject({ ok: true, silent: [], duplicated: [], orphan: [] });
  });
  it("runner bỏ một bước ⟹ reconcile.ok = false, và chỉ ra đúng bước im", async () => {
    const { p, events } = await runAll("rec-1");
    const dropped = events[Math.floor(events.length / 2)]!;
    const r = reconcile(p, events.filter((e) => e !== dropped), p.params.days - 1);
    expect(r.ok).toBe(false);
    expect(r.silent).toEqual([dropped.stepId]);
  });
  it("một bước có hai dòng ⟹ reconcile.ok = false (trùng)", async () => {
    const { p, events } = await runAll("rec-1");
    const r = reconcile(p, [...events, events[0]!], p.params.days - 1);
    expect(r.ok).toBe(false);
    expect(r.duplicated).toEqual([events[0]!.stepId]);
  });
});
