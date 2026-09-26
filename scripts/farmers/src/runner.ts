// scripts/farmers/src/runner.ts — lõi runner: đọc KẾ HOẠCH, chạy từng bước của một ngày, ghi
// SỔ SỰ KIỆN. Lõi này KHÔNG biết dựng tx: nó nhận một bảng `Executor` và chỉ làm ba việc —
// xét điều kiện tiên quyết, gọi executor, dịch KẾT CỤC của executor thành trạng thái sổ.
//
// Vì sao tách "kết cục" khỏi "trạng thái": cùng một kết cục mang nghĩa ngược nhau tuỳ kỳ
// vọng. Validator từ chối một lượt hợp lệ là `fail`; từ chối một lượt TAMPER là `done`.
// Để executor tự chấm trạng thái thì mỗi executor phải tự nhớ luật đó — và một cái quên là
// sổ in xanh cho đúng lúc validator đã thôi chặn. Luật dịch nằm ở MỘT chỗ: `statusOf`.

import type { EventLog, EventStatus, StepEvent } from "./eventLog.ts";
import type { FarmerProfile, Plan, PlanStep } from "./plan.ts";

export type Mode = "dry" | "live";

/** Dữ kiện một bước để lại cho các bước SAU của CÙNG nông dân (vd `vault_nft`, `engage_nft`).
 *  Executor đặt; runner chỉ gom, theo luật ở `runDay` ▸ `absorb`. Không bao giờ chứa hạt giống. */
export type Artifacts = Readonly<Record<string, string>>;

/** Kết cục THÔ của một lần thực thi — executor chỉ được trả một trong các dạng này. */
export type Outcome =
  /** Dựng xong + validator chạy thử cục bộ qua; KHÔNG gửi (chế độ dry). */
  | { kind: "built"; fee: bigint | null; detail?: string; artifacts?: Artifacts }
  /** Đã gửi và thấy vào khối. */
  | { kind: "confirmed"; txHash: string; fee: bigint | null; detail?: string; artifacts?: Artifacts }
  /** Đã gửi (node nhận) mà chưa thấy vào khối trong hạn chờ. */
  | { kind: "submitted-unconfirmed"; txHash: string | null; fee: bigint | null; detail?: string }
  /** Bị từ chối. `byScript` = có dấu hiệu chính validator từ chối (không phải lỗi mạng/coin). */
  | { kind: "rejected"; byScript: boolean; detail: string }
  /** Hỏng vì lý do khác validator: dựng hỏng, thiếu định danh, mạng. `reason` = mã máy đọc
   *  được thay cho `build-error` chung (vd `child-owner-mismatch`, `child-result-malformed`). */
  | { kind: "error"; detail: string; reason?: string }
  /** Điều kiện tiên quyết trên chuỗi chưa có (ví chưa được cấp vốn, vault chưa mở…). */
  | { kind: "prereq-missing"; detail: string }
  /** Kho chưa có bộ dựng cho hành động này. */
  | { kind: "not-implemented"; detail: string }
  /** Có bộ dựng, nhưng nó không có đường chạy ở chế độ này (vd không có cổng DRY_RUN). */
  | { kind: "not-measurable-in-mode"; detail: string }
  /** Executor CỐ Ý không chạy bước này và NÓI RA vì sao — `reason` là mã máy đọc được,
   *  `detail` là câu cho người + con trỏ tới chỗ còn thiếu. Không bao giờ là `done`. */
  | { kind: "skip"; reason: string; detail: string };

export interface ExecContext {
  mode: Mode;
  plan: Plan;
  step: PlanStep;
  farmer: FarmerProfile | null;
  /** Tập dượt đột biến đường ống: executor PHẢI làm hỏng có chủ ý đầu vào của bước này. */
  mutated: boolean;
  /** Trạng thái của `step.farmer`: artifacts gom từ các bước trước (xem `runDay` ▸ `absorb`). */
  state: Artifacts;
}

export type Executor = (ctx: ExecContext) => Promise<Outcome>;
export type ExecutorTable = Partial<Record<PlanStep["action"], Executor>>;

export interface StatusVerdict {
  status: EventStatus;
  reason: string;
  txHash: string | null;
  fee: string | null;
  detail?: string;
  artifacts?: Artifacts;
}

/** Luật dịch DUY NHẤT: (kỳ vọng, chế độ, kết cục) → trạng thái sổ. */
export function statusOf(expect: PlanStep["expect"], mode: Mode, o: Outcome): StatusVerdict {
  const fee = "fee" in o && o.fee !== null && o.fee !== undefined ? o.fee.toString() : null;
  const txHash = "txHash" in o ? (o.txHash ?? null) : null;
  const detail = "detail" in o ? o.detail : undefined;
  const artifacts = "artifacts" in o ? o.artifacts : undefined;
  const v = (status: EventStatus, reason: string): StatusVerdict => ({ status, reason, txHash, fee, detail, ...(artifacts ? { artifacts } : {}) });

  if (o.kind === "skip") return v("skip", o.reason);
  if (o.kind === "not-implemented") return v("unverified", "no-builder");
  if (o.kind === "not-measurable-in-mode") return v("unverified", `no-${mode}-path`);
  if (o.kind === "prereq-missing") return mode === "dry" ? v("skip", "prerequisite-not-on-chain") : v("fail", "prerequisite-missing-live");

  if (expect === "reject") {
    switch (o.kind) {
      case "rejected": return o.byScript ? v("done", "rejected-as-expected") : v("unverified", "rejected-but-not-by-script");
      case "built": return v("fail", "tamper-passed-local-evaluation");
      case "confirmed": return v("fail", "tamper-leaked-on-chain");
      case "submitted-unconfirmed": return v("fail", "tamper-accepted-by-node");
      case "error": return v("unverified", "tamper-not-measured");
    }
  }
  // accept (và mọi kỳ vọng khác có executor)
  switch (o.kind) {
    case "built": return v("unverified", "dry-built-not-submitted");
    case "confirmed": return v("done", "tx-confirmed");
    case "submitted-unconfirmed": return v("unverified", "submitted-not-confirmed");
    case "rejected": return v("fail", o.byScript ? "rejected-by-validator" : "rejected");
    case "error": return v("fail", o.reason ?? "build-error");
  }
}

export interface RunDayOptions {
  mode: Mode;
  mutateStepId?: string;
  /** Sự kiện của các lượt TRƯỚC (cùng kế hoạch) — để xét điều kiện tiên quyết đã lên chuỗi chưa. */
  priorEvents: StepEvent[];
}

/**
 * Chạy mọi bước của `day`. Mỗi bước để lại ĐÚNG MỘT dòng — kể cả khi executor ném, kể cả
 * khi không có executor. Bước đã có dòng từ lượt trước (chạy lại cùng ngày) thì không ghi
 * lại và không chạy lại.
 */
export async function runDay(plan: Plan, day: number, log: EventLog, executors: ExecutorTable, opts: RunDayOptions): Promise<StepEvent[]> {
  const out: StepEvent[] = [];
  const done = new Set(opts.priorEvents.filter((e) => e.planDigest === plan.digest && e.status === "done").map((e) => e.stepId));
  // Chế độ dry: bước phụ thuộc vẫn được THỬ dựng khi bước trước đã dựng khô được — nếu
  // chuỗi thiếu thứ bước trước lẽ ra tạo ra, executor trả `prereq-missing` ⟹ `skip` kèm lý
  // do. Không nới gì ở chế độ live: ở đó chỉ `done` mới mở khoá bước sau.
  const dryBuilt = new Set(
    opts.mode === "dry"
      ? opts.priorEvents.filter((e) => e.planDigest === plan.digest && e.reason === "dry-built-not-submitted").map((e) => e.stepId)
      : [],
  );
  const farmerOf = new Map(plan.farmers.map((f) => [f.farmer, f] as const));
  // Trạng thái nông dân = artifacts của các dòng sự kiện ĐỦ ĐIỀU KIỆN, theo thứ tự sổ (dòng
  // sau đè dòng trước). Đủ điều kiện: cùng kế hoạch · cùng CHẾ ĐỘ (artifact của lượt dry —
  // vd outref của một tx chưa gửi — không bao giờ đi vào lượt live) · và dòng đó là `done`,
  // hoặc (chỉ ở dry) `dry-built-not-submitted`. Dòng `fail`/`skip` không để lại gì.
  const stateOf = new Map<string, Record<string, string>>();
  const absorb = (e: StepEvent): void => {
    if (e.planDigest !== plan.digest || e.mode !== opts.mode || !e.artifacts) return;
    if (!(e.status === "done" || (opts.mode === "dry" && e.reason === "dry-built-not-submitted"))) return;
    stateOf.set(e.farmer, { ...(stateOf.get(e.farmer) ?? {}), ...e.artifacts });
  };
  opts.priorEvents.forEach(absorb);

  for (const step of plan.steps.filter((s) => s.day === day)) {
    if (log.has(step.stepId)) continue;
    const mutated = opts.mutateStepId === step.stepId;

    if (step.action === "rest") {
      out.push(log.record(step, opts.mode, { status: "skip", reason: "scripted-rest", detail: step.params.reason, txHash: null, fee: null }));
      continue;
    }

    const missing = step.dependsOn.filter((id) => !done.has(id) && !dryBuilt.has(id));
    if (missing.length > 0) {
      out.push(
        log.record(step, opts.mode, {
          status: "skip",
          reason: "dependency-not-done",
          detail: missing.join(","),
          txHash: null,
          fee: null,
        }),
      );
      continue;
    }

    const exec = executors[step.action];
    let outcome: Outcome;
    if (!exec) {
      outcome = { kind: "not-implemented", detail: `không có executor cho ${step.action}` };
    } else {
      try {
        const state: Artifacts = { ...(stateOf.get(step.farmer) ?? {}) };
        outcome = await exec({ mode: opts.mode, plan, step, farmer: farmerOf.get(step.farmer) ?? null, mutated, state });
      } catch (e) {
        // Executor ném = hỏng không phân loại được. Vẫn một dòng, không bao giờ im.
        outcome = { kind: "error", detail: `executor threw: ${String((e as Error)?.message ?? e).slice(0, 400)}` };
      }
    }
    const verdict = statusOf(step.expect, opts.mode, outcome);
    const ev = log.record(step, opts.mode, { ...verdict, detail: mutated ? `[MUTATED] ${verdict.detail ?? ""}` : verdict.detail });
    absorb(ev);
    if (ev.status === "done") done.add(step.stepId);
    if (opts.mode === "dry" && ev.reason === "dry-built-not-submitted") dryBuilt.add(step.stepId);
    out.push(ev);
  }
  return out;
}
