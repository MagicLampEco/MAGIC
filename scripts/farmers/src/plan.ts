// scripts/farmers/src/plan.ts — sổ 1: KẾ HOẠCH. Sinh TRƯỚC khi chạy, bất biến sau đó.
//
// Nguồn quyết định (nội bộ, đã chốt): ba sổ KẾ HOẠCH / SỰ KIỆN / TRẠNG THÁI; mỗi epoch đúng
// một TAMPER phải bị từ chối; bốn trục ngẫu nhiên (vị thế tCARP · số dư · nhu cầu + tần
// suất · hành động mỗi ngày mỗi khác); số nông dân = số ví đang có.
//
// Hàm ở đây THUẦN: không mạng, không khoá, không đọc môi trường. Danh sách nông dân đi vào
// như một tham số đã liệt kê sẵn (`farmers.ts` ▸ `enumerateFarmers`), nên bài kiểm chạy
// thẳng vào đây với tên giả.
//
// Mọi số tiền là CHUỖI THẬP PHÂN của BigInt (BOUNDARIES.md §2: BigInt cho mọi số tiền).
// JSON không mang BigInt; chuỗi thì mang được mà không mất bit nào.

import { createHash } from "node:crypto";

import { MS_PER_EPOCH_BY_NETWORK } from "../../../ProtocolUtils/src/index.ts";
import {
  SCHEDULE_DELAY,
  SCHEDULE_MIN_LENGTH,
} from "../../../ScheduleGen/offchain/src/constants.ts";
import type { FarmerRef } from "./farmers.ts";
import { Rng } from "./rng.ts";

export const PLAN_SCHEMA = "magiclamp:farmer-sim:plan:v1";

export type ActionKind =
  | "fund"
  | "fund_tcarp"
  | "did_mint"
  | "vault_open_instant"
  | "vault_open_schedule"
  | "engage_mint"
  | "schedule_commit"
  | "tamper"
  | "instant_gen"
  | "schedule_fire"
  | "consume"
  | "prepaid_lock"
  | "rest"
  | "beacon_inversion";

/** Thứ tự trong CÙNG một ngày. TAMPER đứng TRƯỚC lượt sinh hợp lệ của epoch: một lượt phá
 *  chạy SAU lượt sinh có thể bị từ chối vì trần epoch chứ không vì phép phá, và khi đó
 *  "bị từ chối" không chứng minh gì. */
export const PHASE: Record<ActionKind, number> = {
  fund: 0,
  fund_tcarp: 0,
  did_mint: 1,
  vault_open_instant: 2,
  vault_open_schedule: 2,
  engage_mint: 3,
  schedule_commit: 4,
  tamper: 5,
  instant_gen: 6,
  schedule_fire: 6,
  consume: 7,
  prepaid_lock: 8,
  rest: 9,
  beacon_inversion: 10,
};

export type GeneratorKind = "instant" | "schedule";
export type TcarpPosition = "none" | "small" | "large";
export type Profile = "Ember" | "Flame" | "Lantern";
export type Expectation = "accept" | "reject" | "cap-holds" | "none";

export interface FarmerProfile {
  farmer: string;
  seedVar: string;
  /** INV-ONE-PERSON-ONE-VAULT: mỗi DID MỘT vault sinh MAGIC — nông dân chọn đúng một loại. */
  generatorKind: GeneratorKind;
  profile: Profile;
  /** Trục 1 — vị thế tCARP. */
  tcarpPosition: TcarpPosition;
  tcarpNanothread: string;
  /** Trục 2 — số dư. */
  lampDepositOildrop: string;
  adaFundLovelace: string;
  /** Trục 3 — nhu cầu + tần suất. Phần nghìn, số nguyên. */
  activityPerMille: number;
  maxOpsPerConsume: number;
  opTypeWeights: { opType: number; weight: number }[];
  /** ScheduleGen: tham số lịch. */
  scheduleLength: number;
  lampPerEpochLamp: string;
  /** DID mô phỏng: rand_256 của GenesisPerson + bộ người bảo hộ (nông dân khác). */
  didRand256: string;
  guardians: string[];
}

export interface PlanStep {
  stepId: string;
  farmer: string; // "keeper" cho bước không thuộc nông dân nào
  day: number;
  /** epoch GIAO THỨC tương đối: 0 = epoch chứa ngày 0. */
  epoch: number;
  action: ActionKind;
  params: Record<string, string>;
  expect: Expectation;
  dependsOn: string[];
}

export interface PlanParams {
  seed: string;
  days: number;
  /** Ngày 0 rơi vào ngày thứ mấy của epoch chứa nó (0-based). `D` rơi bất kỳ đâu. */
  startDayInEpoch: number;
  /** op_type đang có giá trên beacon. Kế hoạch không đọc chuỗi, nên tập này là tham số. */
  opTypes: number[];
  network: keyof typeof MS_PER_EPOCH_BY_NETWORK;
}

export interface Plan {
  schema: typeof PLAN_SCHEMA;
  params: PlanParams;
  constants: {
    msPerEpoch: string;
    epochDays: number;
    scheduleDelay: number;
    scheduleMinLength: number;
  };
  farmerCount: number;
  farmers: FarmerProfile[];
  steps: PlanStep[];
  controls: {
    /** Đột biến đường ống — tập dượt MỘT lần trước khi chạy thật (runner `--mutate`). */
    pipelineMutationStepId: string;
  };
  /** sha256 của mọi thứ ở trên. Runner đối chiếu để biết kế hoạch không bị sửa sau khi sinh. */
  digest: string;
}

const MS_PER_DAY = 86_400_000n;
const OILDROP_PER_LAMP = 1_000_000n;
const NANOTHREAD_PER_CARP = 1_000_000_000n;
const LOVELACE_PER_ADA = 1_000_000n;

const TAMPER_MODES: Record<GeneratorKind, readonly string[]> = {
  // scripts/test/instant_only.ts ▸ các nhánh `tamper ===`
  instant: ["lamp_out", "lamp_balance", "keep_credit", "wrong_owner"],
  // scripts/test/schedule_commit_only.ts ▸ các nhánh `tamper ===`
  schedule: ["lamp_locked", "no_schedule_added", "fake_rate_locked"],
};

export function epochDaysOf(network: PlanParams["network"]): number {
  const ms = MS_PER_EPOCH_BY_NETWORK[network];
  if (ms % MS_PER_DAY !== 0n) throw new Error(`ms_per_epoch ${ms} không chia hết cho một ngày`);
  return Number(ms / MS_PER_DAY);
}

export function epochOfDay(day: number, startDayInEpoch: number, epochDays: number): number {
  return Math.floor((startDayInEpoch + day) / epochDays);
}

function stepIdOf(farmer: string, day: number, action: ActionKind, n: number): string {
  return `d${String(day).padStart(2, "0")}:${farmer}:${action}${n > 0 ? `#${n}` : ""}`;
}

function drawProfiles(params: PlanParams, farmers: FarmerRef[]): FarmerProfile[] {
  const rng = Rng.derive(params.seed, "profiles");
  const ids = farmers.map((f) => f.id);
  // Mỗi loại vault có ít nhất một nông dân khi có từ hai nông dân trở lên.
  const order = rng.sample(ids, ids.length);
  const kindOf = new Map<string, GeneratorKind>();
  order.forEach((id, i) => {
    kindOf.set(id, i === 0 ? "instant" : i === 1 ? "schedule" : rng.pick(["instant", "schedule"] as const));
  });

  return farmers.map((f) => {
    const r = Rng.derive(params.seed, `farmer/${f.id}`);
    const tcarpPosition = r.weighted<TcarpPosition>([
      { value: "none", weight: 4 },
      { value: "small", weight: 4 },
      { value: "large", weight: 2 },
    ]);
    const tcarpCarp =
      tcarpPosition === "none" ? 0n : tcarpPosition === "small" ? BigInt(r.int(100, 1_000)) : BigInt(r.int(10_000, 50_000));
    const depositLamp = BigInt(
      r.weighted([
        { value: 1_000, weight: 3 },
        { value: 5_000, weight: 3 },
        { value: 20_000, weight: 2 },
        { value: 100_000, weight: 1 },
      ]),
    );
    const scheduleLength = r.int(Number(SCHEDULE_MIN_LENGTH), Number(SCHEDULE_MIN_LENGTH) + 4);
    // λ·L ≤ một phần ba số dư: lịch khoá không nuốt trọn két, còn chỗ cho lượt commit thứ hai.
    let lampPerEpoch = depositLamp / (BigInt(scheduleLength) * 3n);
    if (lampPerEpoch < 1n) lampPerEpoch = 1n;
    const others = ids.filter((x) => x !== f.id);
    if (others.length < 2) {
      throw new Error(
        `Cần ít nhất 3 nông dân để mỗi người có 2 người bảo hộ là nông dân khác (đang có ${ids.length}).`,
      );
    }
    const guardianCount = r.int(2, Math.min(5, others.length));
    return {
      farmer: f.id,
      seedVar: f.seedVar,
      generatorKind: kindOf.get(f.id)!,
      profile: r.pick(["Ember", "Flame", "Lantern"] as const),
      tcarpPosition,
      tcarpNanothread: (tcarpCarp * NANOTHREAD_PER_CARP).toString(),
      lampDepositOildrop: (depositLamp * OILDROP_PER_LAMP).toString(),
      adaFundLovelace: (BigInt(r.pick([60, 100, 150])) * LOVELACE_PER_ADA).toString(),
      activityPerMille: r.int(300, 900),
      maxOpsPerConsume: r.int(1, 5),
      opTypeWeights: params.opTypes.map((opType) => ({ opType, weight: r.int(1, 5) })),
      scheduleLength,
      lampPerEpochLamp: lampPerEpoch.toString(),
      didRand256: r.hex(32),
      guardians: r.sample(others, guardianCount).sort(),
    };
  });
}

export function generatePlan(params: PlanParams, farmers: FarmerRef[]): Plan {
  if (!params.seed) throw new Error("seed rỗng — kế hoạch phải dựng lại được từ một seed công bố");
  if (!Number.isInteger(params.days) || params.days < 1) throw new Error(`days phải là số nguyên ≥ 1 (nhận ${params.days})`);
  if (params.opTypes.length === 0) throw new Error("opTypes rỗng — không có op_type nào để tiêu");
  const epochDays = epochDaysOf(params.network);
  if (!Number.isInteger(params.startDayInEpoch) || params.startDayInEpoch < 0 || params.startDayInEpoch >= epochDays) {
    throw new Error(`startDayInEpoch phải trong [0, ${epochDays - 1}]`);
  }
  if (farmers.length === 0) throw new Error("Không có nông dân nào (không thấy biến FARMER_SEED_<số>)");

  const profiles = drawProfiles(params, farmers);
  const steps: PlanStep[] = [];
  const add = (s: Omit<PlanStep, "stepId">, n = 0): PlanStep => {
    const step = { stepId: stepIdOf(s.farmer, s.day, s.action, n), ...s };
    steps.push(step);
    return step;
  };
  const dayRng = Rng.derive(params.seed, "days");
  const delay = Number(SCHEDULE_DELAY);
  const epochs = new Set<number>();
  for (let d = 0; d < params.days; d++) epochs.add(epochOfDay(d, params.startDayInEpoch, epochDays));

  // Lượt sinh hợp lệ đầu tiên của mỗi (nông dân, epoch) — để đặt TAMPER trước nó.
  const firstGenDay = new Map<string, number>();
  const vaultOpenStep = new Map<string, string>();

  for (const p of profiles) {
    const e0 = epochOfDay(0, params.startDayInEpoch, epochDays);
    const fund = add({
      farmer: p.farmer, day: 0, epoch: e0, action: "fund", expect: "accept", dependsOn: [],
      params: { lovelace: p.adaFundLovelace, lampOildrop: p.lampDepositOildrop },
    });
    // tCARP tách thành bước riêng: danh tính CARP trên Preprod chưa yên (policy trong
    // PrepaidGen/offchain/src/constants.ts còn là bản cũ), nên nó phải đỏ/xanh độc lập
    // với phần tADA + tLAMP, không kéo cả nông dân đổ theo.
    const fundTcarp =
      p.tcarpPosition === "none"
        ? null
        : add({
            farmer: p.farmer, day: 0, epoch: e0, action: "fund_tcarp", expect: "accept", dependsOn: [],
            params: { tcarpNanothread: p.tcarpNanothread },
          });
    add({
      farmer: p.farmer, day: 0, epoch: e0, action: "did_mint", expect: "accept", dependsOn: [fund.stepId],
      params: { rand256: p.didRand256, guardians: p.guardians.join(","), label: "magiclamp:did-sim:v1" },
    });
    const open = add({
      farmer: p.farmer, day: 0, epoch: e0,
      action: p.generatorKind === "instant" ? "vault_open_instant" : "vault_open_schedule",
      expect: "accept", dependsOn: [fund.stepId],
      params: { lampOildrop: p.lampDepositOildrop, profile: p.profile },
    });
    vaultOpenStep.set(p.farmer, open.stepId);
    const engage = add({
      farmer: p.farmer, day: 0, epoch: e0, action: "engage_mint", expect: "accept", dependsOn: [open.stepId],
      params: { vaultKind: p.generatorKind },
    });

    const r = Rng.derive(params.seed, `days/${p.farmer}`);
    // Lịch ScheduleGen đang mở: commit ở ngày 0; cửa fire [commit+delay, commit+L+1].
    let commit: { stepId: string; epoch: number; length: number } | null = null;
    if (p.generatorKind === "schedule") {
      const c = add({
        farmer: p.farmer, day: 0, epoch: e0, action: "schedule_commit", expect: "accept", dependsOn: [open.stepId],
        params: { scheduleLength: String(p.scheduleLength), lampPerEpochLamp: p.lampPerEpochLamp },
      });
      commit = { stepId: c.stepId, epoch: e0, length: p.scheduleLength };
    }
    const prepaidDay = p.tcarpPosition === "none" ? -1 : r.int(Math.min(1, params.days - 1), params.days - 1);

    const genInEpoch = new Map<number, string>(); // epoch → stepId lượt sinh
    for (let d = 1; d < params.days; d++) {
      const e = epochOfDay(d, params.startDayInEpoch, epochDays);
      let acted = false;
      if (d === prepaidDay) {
        add({
          farmer: p.farmer, day: d, epoch: e, action: "prepaid_lock", expect: "accept",
          dependsOn: [fund.stepId, ...(fundTcarp ? [fundTcarp.stepId] : [])],
          params: { amountNanothread: (BigInt(p.tcarpNanothread) / BigInt(r.int(2, 4))).toString() },
        });
        acted = true;
      }
      if (!r.chance(p.activityPerMille)) {
        if (!acted) add({ farmer: p.farmer, day: d, epoch: e, action: "rest", expect: "none", dependsOn: [], params: { reason: "scripted-rest" } });
        continue;
      }
      // Sinh MAGIC: một lần mỗi epoch.
      if (!genInEpoch.has(e)) {
        if (p.generatorKind === "instant") {
          const g = add({ farmer: p.farmer, day: d, epoch: e, action: "instant_gen", expect: "accept", dependsOn: [open.stepId], params: {} });
          genInEpoch.set(e, g.stepId);
          acted = true;
        } else if (commit && e >= commit.epoch + delay && e <= commit.epoch + commit.length + 1) {
          const g = add({ farmer: p.farmer, day: d, epoch: e, action: "schedule_fire", expect: "accept", dependsOn: [commit.stepId], params: {} });
          genInEpoch.set(e, g.stepId);
          acted = true;
        }
        if (genInEpoch.has(e) && !firstGenDay.has(`${p.farmer}@${e}`)) firstGenDay.set(`${p.farmer}@${e}`, d);
      }
      // Tiêu: chỉ trong epoch đã có lượt sinh (decay_window = 1 ⟹ lô chết cuối epoch sinh ra nó).
      const gen = genInEpoch.get(e);
      if (gen && r.chance(700)) {
        const opType = r.weighted(p.opTypeWeights.map((w) => ({ value: w.opType, weight: w.weight })));
        add({
          farmer: p.farmer, day: d, epoch: e, action: "consume", expect: "accept", dependsOn: [engage.stepId, gen],
          params: { vaultKind: p.generatorKind, opType: String(opType), opCount: String(r.int(1, p.maxOpsPerConsume)) },
        });
        acted = true;
      }
      if (!acted) add({ farmer: p.farmer, day: d, epoch: e, action: "rest", expect: "none", dependsOn: [], params: { reason: "active-but-nothing-eligible" } });
    }
  }

  // TAMPER: đúng MỘT mỗi epoch có trong khoảng ngày của kế hoạch.
  const tamperRng = Rng.derive(params.seed, "tamper");
  for (const e of [...epochs].sort((a, b) => a - b)) {
    const daysInEpoch = [...Array(params.days).keys()].filter((d) => epochOfDay(d, params.startDayInEpoch, epochDays) === e);
    const p = tamperRng.pick(profiles);
    const day = firstGenDay.get(`${p.farmer}@${e}`) ?? tamperRng.pick(daysInEpoch);
    add({
      farmer: p.farmer, day, epoch: e, action: "tamper", expect: "reject", dependsOn: [vaultOpenStep.get(p.farmer)!],
      params: {
        vaultKind: p.generatorKind,
        via: p.generatorKind === "instant" ? "instant_gen" : "schedule_commit",
        mode: tamperRng.pick(TAMPER_MODES[p.generatorKind]),
      },
    });
  }

  // Beacon ngược: một epoch, bước của keeper — kiểm lượng cấp vẫn bị compute_cap_pp chặn.
  const epochList = [...epochs].sort((a, b) => a - b);
  const invEpoch = epochList.length > 1 ? epochList[1]! : epochList[0]!;
  const invDay = [...Array(params.days).keys()].find((d) => epochOfDay(d, params.startDayInEpoch, epochDays) === invEpoch)!;
  add({
    farmer: "keeper", day: invDay, epoch: invEpoch, action: "beacon_inversion", expect: "cap-holds", dependsOn: [],
    params: { note: "surplus huge, depeg=false; InstantGen grant must stay <= compute_cap_pp(L_avail)" },
  });

  steps.sort((a, b) => a.day - b.day || PHASE[a.action] - PHASE[b.action] || (a.farmer < b.farmer ? -1 : a.farmer > b.farmer ? 1 : 0) || (a.stepId < b.stepId ? -1 : 1));

  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.stepId)) throw new Error(`stepId trùng: ${s.stepId}`);
    ids.add(s.stepId);
  }

  // Tập dượt đột biến: một bước "accept" của đúng một nông dân, không phải bước fund.
  const mutable = steps.filter((s) => s.expect === "accept" && s.action !== "fund" && s.action !== "fund_tcarp" && s.farmer !== "keeper");
  const mutation = Rng.derive(params.seed, "mutation").pick(mutable);

  const body = {
    schema: PLAN_SCHEMA,
    params,
    constants: {
      msPerEpoch: MS_PER_EPOCH_BY_NETWORK[params.network].toString(),
      epochDays,
      scheduleDelay: delay,
      scheduleMinLength: Number(SCHEDULE_MIN_LENGTH),
    },
    farmerCount: profiles.length,
    farmers: profiles,
    steps,
    controls: { pipelineMutationStepId: mutation.stepId },
  } as const;
  return { ...body, digest: planDigest(body) };
}

export function planDigest(body: Omit<Plan, "digest">): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** Đọc lại một kế hoạch từ đĩa và từ chối nếu nó đã bị sửa sau khi sinh. */
export function verifyPlan(plan: Plan): void {
  if (plan.schema !== PLAN_SCHEMA) throw new Error(`schema kế hoạch lạ: ${String(plan.schema)}`);
  const { digest, ...body } = plan;
  const actual = planDigest(body);
  if (actual !== digest) throw new Error(`digest kế hoạch KHÔNG khớp (ghi ${digest.slice(0, 12)}…, tính ${actual.slice(0, 12)}…) — kế hoạch đã bị sửa sau khi sinh`);
}

export interface PlanSummary {
  farmers: number;
  days: number;
  epochs: number[];
  byAction: Record<string, number>;
  tamperPerEpoch: Record<string, number>;
  generatorKinds: Record<GeneratorKind, number>;
  tcarpPositions: Record<TcarpPosition, number>;
}

export function summarize(plan: Plan): PlanSummary {
  const byAction: Record<string, number> = {};
  const tamperPerEpoch: Record<string, number> = {};
  const epochs = new Set<number>();
  for (const s of plan.steps) {
    byAction[s.action] = (byAction[s.action] ?? 0) + 1;
    epochs.add(s.epoch);
    if (s.action === "tamper") tamperPerEpoch[String(s.epoch)] = (tamperPerEpoch[String(s.epoch)] ?? 0) + 1;
  }
  const generatorKinds = { instant: 0, schedule: 0 };
  const tcarpPositions = { none: 0, small: 0, large: 0 };
  for (const f of plan.farmers) {
    generatorKinds[f.generatorKind]++;
    tcarpPositions[f.tcarpPosition]++;
  }
  return {
    farmers: plan.farmerCount,
    days: plan.params.days,
    epochs: [...epochs].sort((a, b) => a - b),
    byAction,
    tamperPerEpoch,
    generatorKinds,
    tcarpPositions,
  };
}
