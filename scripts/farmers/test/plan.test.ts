import { describe, expect, it } from "vitest";

import { summarize, verifyPlan, type Plan } from "../src/plan.ts";
import { plan } from "./helpers.ts";

/** Epoch nào có số TAMPER khác 1 — rỗng nghĩa là đạt. */
function badTamperEpochs(p: Plan): string[] {
  const epochs = new Set(p.steps.map((s) => String(s.epoch)));
  const per = summarize(p).tamperPerEpoch;
  return [...epochs].filter((e) => (per[e] ?? 0) !== 1);
}

describe("kế hoạch dựng lại được từ seed", () => {
  it("cùng seed ⟹ cùng kế hoạch (digest + từng bước)", () => {
    const a = plan("seed-A");
    const b = plan("seed-A");
    expect(a.digest).toBe(b.digest);
    expect(JSON.stringify(a.steps)).toBe(JSON.stringify(b.steps));
  });
  it("khác seed ⟹ khác kế hoạch", () => {
    const a = plan("seed-A");
    const b = plan("seed-B");
    expect(a.digest).not.toBe(b.digest);
    expect(JSON.stringify(a.steps)).not.toBe(JSON.stringify(b.steps));
  });
});

describe("mỗi epoch đúng một TAMPER", () => {
  it("kế hoạch sinh ra: mọi epoch có đúng một bước tamper", () => {
    for (const seed of ["s1", "s2", "s3"]) {
      for (const start of [0, 3, 4]) {
        const p = plan(seed, 17, { days: 15, startDayInEpoch: start });
        expect(badTamperEpochs(p)).toEqual([]);
      }
    }
  });
  it("kế hoạch bị chèn thêm một tamper ⟹ phép kiểm bắt được, và digest không còn khớp", () => {
    const p = plan("s1");
    const t = p.steps.find((s) => s.action === "tamper")!;
    const broken: Plan = { ...p, steps: [...p.steps, { ...t, stepId: `${t.stepId}-dup` }] };
    expect(badTamperEpochs(broken)).toEqual([String(t.epoch)]);
    expect(() => verifyPlan(broken)).toThrow(/digest/);
  });
});
