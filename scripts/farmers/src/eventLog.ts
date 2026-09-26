// scripts/farmers/src/eventLog.ts — sổ 2: SỰ KIỆN. Ghi TRONG khi chạy, một dòng JSON mỗi bước.
//
// Luật của sổ (đã chốt): mỗi bước đúng một dòng, đúng BỐN trạng thái, KHÔNG có im lặng.
//   done        đo được và khớp kỳ vọng (tx vào khối; hoặc lượt phá bị validator từ chối)
//   skip        cố ý không chạy, kèm lý do (nghỉ theo kịch bản · điều kiện tiên quyết chưa lên chuỗi)
//   fail        đo được và SAI kỳ vọng (dựng hỏng · bị từ chối khi phải được nhận · lượt phá LỌT)
//   unverified  không đo được (gửi rồi mà chưa thấy vào khối · chạy khô · chưa có bộ dựng)
//
// `fee` là phí của CHÍNH tx đó (lovelace, chuỗi thập phân) khi có tx; `null` khi không có
// tx nào — không bao giờ là một số ước lượng đứng thay.

import { appendFileSync, existsSync, readFileSync } from "node:fs";

import type { Plan, PlanStep } from "./plan.ts";

export const EVENT_STATUSES = ["done", "skip", "fail", "unverified"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface StepEvent {
  schema: "magiclamp:farmer-sim:event:v1";
  planDigest: string;
  stepId: string;
  farmer: string;
  day: number;
  action: string;
  mode: "dry" | "live";
  status: EventStatus;
  /** Lý do ngắn, máy đọc được: "dry-built", "tx-confirmed", "rejected-as-expected", … */
  reason: string;
  detail?: string;
  txHash: string | null;
  fee: string | null;
  /** Dữ kiện để lại cho bước sau của cùng nông dân (runner.ts ▸ `Artifacts`); vắng = không có. */
  artifacts?: Record<string, string>;
  at: string;
}

export function isEventStatus(x: unknown): x is EventStatus {
  return typeof x === "string" && (EVENT_STATUSES as readonly string[]).includes(x);
}

export class EventLog {
  private readonly seen = new Set<string>();

  constructor(
    readonly path: string,
    readonly planDigest: string,
  ) {
    if (existsSync(path)) {
      for (const e of readEvents(path)) {
        if (e.planDigest === planDigest) this.seen.add(e.stepId);
      }
    }
  }

  has(stepId: string): boolean {
    return this.seen.has(stepId);
  }

  /** Ghi một dòng. Ghi hai lần cho cùng một bước là lỗi của runner ⟹ NÉM. */
  record(step: PlanStep, mode: StepEvent["mode"], r: Omit<StepEvent, "schema" | "planDigest" | "stepId" | "farmer" | "day" | "action" | "mode" | "at">): StepEvent {
    if (!isEventStatus(r.status)) throw new Error(`trạng thái lạ: ${String(r.status)}`);
    if (!r.reason) throw new Error(`bước ${step.stepId}: thiếu lý do — sổ không nhận dòng im lặng`);
    if (this.seen.has(step.stepId)) throw new Error(`bước ${step.stepId} đã có dòng sự kiện — không ghi đè`);
    const ev: StepEvent = {
      schema: "magiclamp:farmer-sim:event:v1",
      planDigest: this.planDigest,
      stepId: step.stepId,
      farmer: step.farmer,
      day: step.day,
      action: step.action,
      mode,
      ...r,
      at: new Date().toISOString(),
    };
    appendFileSync(this.path, JSON.stringify(ev) + "\n");
    this.seen.add(step.stepId);
    return ev;
  }
}

export function readEvents(path: string): StepEvent[] {
  const out: StepEvent[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    let e: StepEvent;
    try {
      e = JSON.parse(line) as StepEvent;
    } catch (err) {
      throw new Error(`${path}:${i + 1}: dòng không phải JSON (${(err as Error).message})`);
    }
    if (!isEventStatus(e.status)) throw new Error(`${path}:${i + 1}: trạng thái lạ ${String(e.status)}`);
    out.push(e);
  });
  return out;
}

export interface Reconciliation {
  /** Bước trong kế hoạch (đến hết `throughDay`) mà KHÔNG có dòng nào — bước im lặng. */
  silent: string[];
  /** Bước có HƠN một dòng. */
  duplicated: string[];
  /** Dòng sự kiện không thuộc bước nào của kế hoạch này. */
  orphan: string[];
  counts: Record<EventStatus, number>;
  ok: boolean;
}

/** Đối chiếu sổ SỰ KIỆN với sổ KẾ HOẠCH: mọi bước tới `throughDay` có ĐÚNG MỘT dòng. */
export function reconcile(plan: Plan, events: StepEvent[], throughDay: number): Reconciliation {
  const planned = new Map(plan.steps.filter((s) => s.day <= throughDay).map((s) => [s.stepId, s] as const));
  const allIds = new Set(plan.steps.map((s) => s.stepId));
  const n = new Map<string, number>();
  const counts: Record<EventStatus, number> = { done: 0, skip: 0, fail: 0, unverified: 0 };
  const orphan: string[] = [];
  for (const e of events) {
    if (e.planDigest !== plan.digest || !allIds.has(e.stepId)) {
      orphan.push(e.stepId);
      continue;
    }
    n.set(e.stepId, (n.get(e.stepId) ?? 0) + 1);
    counts[e.status]++;
  }
  const silent = [...planned.keys()].filter((id) => !n.has(id));
  const duplicated = [...n.entries()].filter(([, c]) => c > 1).map(([id]) => id);
  return { silent, duplicated, orphan, counts, ok: silent.length === 0 && duplicated.length === 0 && orphan.length === 0 };
}
