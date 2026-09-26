// scripts/farmers/src/runnerCli.ts — chạy MỘT ngày của kế hoạch, ghi sổ SỰ KIỆN, in đối chiếu.
//
// Dùng:  npx tsx src/runnerCli.ts --plan plan.json --events events.jsonl --day <n>
//          [--mutate] [--taad-policy <56 hex> --taad-ref <txhash#ix>] [--work-dir <thư mục>]
//          [--live --confirm-submit]
//
// Mặc định DRY: dựng + chạy thử validator, KHÔNG ký, KHÔNG gửi. `--live` chỉ có hiệu lực khi
// kèm `--confirm-submit`; thiếu một trong hai thì dừng trước khi chạm chuỗi.
// `--mutate`: tập dượt đột biến đường ống trên bước `plan.controls.pipelineMutationStepId`.
//
// Mã thoát: 0 khi sổ đối chiếu sạch và không bước nào `fail`; 1 khi ngược lại.

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chainAccess } from "./chain.ts";
import { EventLog, readEvents, reconcile } from "./eventLog.ts";
import { buildExecutors } from "./executors.ts";
import { enumerateFarmers } from "./farmers.ts";
import { verifyPlan, type Plan } from "./plan.ts";
import { runDay, type Mode } from "./runner.ts";
import { deriveFarmerWallets } from "./wallets.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const planPath = arg("--plan");
  const eventsPath = arg("--events");
  const dayRaw = arg("--day");
  if (!planPath || !eventsPath || !dayRaw || !/^[0-9]+$/.test(dayRaw)) throw new Error("cần --plan <tệp> --events <tệp> --day <số nguyên>");
  const day = Number.parseInt(dayRaw, 10);

  const live = process.argv.includes("--live");
  const confirm = process.argv.includes("--confirm-submit");
  if (live && !confirm) throw new Error("--live cần kèm --confirm-submit — dừng, chưa chạm chuỗi");
  if (confirm && !live) throw new Error("--confirm-submit không có --live — cờ thừa, dừng để tránh hiểu nhầm chế độ");
  const mode: Mode = live ? "live" : "dry";

  const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
  verifyPlan(plan);
  if (day >= plan.params.days) throw new Error(`--day ${day} ngoài kế hoạch (${plan.params.days} ngày)`);

  let mutateStepId: string | undefined;
  if (process.argv.includes("--mutate")) {
    mutateStepId = plan.controls.pipelineMutationStepId;
    const s = plan.steps.find((x) => x.stepId === mutateStepId);
    if (!s) throw new Error(`bước đột biến ${mutateStepId} không có trong kế hoạch`);
    if (s.day !== day) console.log(`⚠ bước đột biến ${mutateStepId} thuộc ngày ${s.day}, không phải ngày ${day} — lượt này không đột biến gì`);
  }

  const network = plan.params.network as "Preprod";
  const env = process.env;
  const farmers = enumerateFarmers(env);
  const wallets = deriveFarmerWallets(farmers, env, network);
  const missing = plan.farmers.filter((f) => !wallets.has(f.farmer)).map((f) => f.farmer);
  if (missing.length > 0) console.log(`⚠ ${missing.length} nông dân trong kế hoạch không có hạt giống trong môi trường: ${missing.join(",")}`);

  const policy = arg("--taad-policy");
  const ref = arg("--taad-ref");
  if ((policy === undefined) !== (ref === undefined)) throw new Error("--taad-policy và --taad-ref phải đi cùng nhau");
  const wd = arg("--work-dir");
  if (wd) mkdirSync(wd, { recursive: true });

  const access = chainAccess(network, env);
  const executors = buildExecutors({
    network,
    access,
    env,
    wallets,
    workDir: wd ?? mkdtempSync(join(tmpdir(), "farmer-run-")),
    taad: policy && ref ? { policy, ref } : null,
    deploySeed: env.DEPLOY_WALLET_SEED?.trim() || null,
  });

  const prior = existsSync(eventsPath) ? readEvents(eventsPath) : [];
  const log = new EventLog(eventsPath, plan.digest);
  console.log(`chế độ ${mode} · ngày ${day} · nhà cung cấp ${access.label} · ${plan.steps.filter((s) => s.day === day).length} bước`);
  const evs = await runDay(plan, day, log, executors, { mode, mutateStepId, priorEvents: prior });
  for (const e of evs) console.log(`  ${e.status.padEnd(10)} ${e.stepId.padEnd(28)} ${e.action.padEnd(20)} ${e.reason}${e.detail ? ` · ${e.detail.slice(0, 160)}` : ""}`);

  const rec = reconcile(plan, readEvents(eventsPath), day);
  console.log(`đối chiếu tới hết ngày ${day}: ok=${rec.ok} · im lặng ${rec.silent.length} · trùng ${rec.duplicated.length} · mồ côi ${rec.orphan.length}`);
  console.log(`  đếm: ${JSON.stringify(rec.counts)}`);
  if (rec.silent.length > 0) console.log(`  bước im lặng: ${rec.silent.slice(0, 20).join(",")}${rec.silent.length > 20 ? " …" : ""}`);
  return rec.ok && rec.counts.fail === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`✗ ${String((e as Error)?.message ?? e)}`);
    process.exit(1);
  },
);
