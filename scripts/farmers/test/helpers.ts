// Dữ liệu giả dùng chung cho bộ kiểm — không có hạt giống thật nào ở đây.
import { enumerateFarmers, type FarmerRef } from "../src/farmers.ts";
import { generatePlan, type Plan, type PlanParams } from "../src/plan.ts";

export function fakeEnv(n: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (let i = 1; i <= n; i++) env[`FARMER_SEED_${String(i).padStart(2, "0")}`] = "fake";
  return env;
}

export function fakeFarmers(n: number): FarmerRef[] {
  return enumerateFarmers(fakeEnv(n));
}

export function params(seed: string, over: Partial<PlanParams> = {}): PlanParams {
  return { seed, days: 12, startDayInEpoch: 3, opTypes: [1, 2, 7], network: "Preprod", ...over };
}

export function plan(seed: string, n = 17, over: Partial<PlanParams> = {}): Plan {
  return generatePlan(params(seed, over), fakeFarmers(n));
}
