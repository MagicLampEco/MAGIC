// scripts/farmers/src/planCli.ts — sinh sổ KẾ HOẠCH từ một seed công bố.
//
// Dùng:  npx tsx src/planCli.ts --seed <chuỗi> --days <n> --start-day-in-epoch <k> --op-types 1,2 --out plan.json
//
// Nông dân = mọi biến FARMER_SEED_<số> trong môi trường (farmers.ts ▸ enumerateFarmers). Tệp này
// chỉ đọc TÊN biến; giá trị hạt giống không vào kế hoạch.

import { writeFileSync } from "node:fs";

import { enumerateFarmers } from "./farmers.ts";
import { generatePlan, summarize, verifyPlan, type PlanParams } from "./plan.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function need(name: string): string {
  const v = arg(name);
  if (v === undefined || v.startsWith("--")) throw new Error(`thiếu ${name}`);
  return v;
}

function intArg(name: string): number {
  const raw = need(name);
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} phải là số nguyên không âm (nhận "${raw}")`);
  return Number.parseInt(raw, 10);
}

function main(): void {
  const opTypes = need("--op-types").split(",").map((x) => {
    if (!/^[0-9]+$/.test(x.trim())) throw new Error(`--op-types: "${x}" không phải số nguyên`);
    return Number.parseInt(x.trim(), 10);
  });
  const params: PlanParams = {
    seed: need("--seed"),
    days: intArg("--days"),
    startDayInEpoch: intArg("--start-day-in-epoch"),
    opTypes,
    network: (arg("--network") ?? "Preprod") as PlanParams["network"],
  };
  const out = need("--out");
  const farmers = enumerateFarmers(process.env);
  if (farmers.length === 0) throw new Error("không có biến FARMER_SEED_<số> nào trong môi trường — không có nông dân");
  const plan = generatePlan(params, farmers);
  verifyPlan(plan);
  writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
  console.log(`kế hoạch: ${out} · digest ${plan.digest}`);
  console.log(JSON.stringify(summarize(plan), null, 2));
}

try {
  main();
} catch (e) {
  console.error(`✗ ${String((e as Error)?.message ?? e)}`);
  process.exit(1);
}
