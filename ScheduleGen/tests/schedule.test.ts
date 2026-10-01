// tests/schedule.test.ts — ScheduleGen Gen v2.0: toán lõi + nhánh ký/bắn chạy trên
// `planScheduleCommit` / `planScheduleFire` (không mô phỏng lại trong tệp kiểm).
// Run: npx vitest run tests/schedule.test.ts
//
// Bản trước của tệp này dựng lại nhánh ký/bắn bằng hai hàm mô phỏng riêng
// (`simulateCommit`/`simulateFire`), tính lượng bắn bằng ⌊λ·rate_locked/Q⌋ và đóng dấu
// mọi batch bù bằng epoch hiện tại — ngữ nghĩa v1. Hai hàm đó đã bỏ: mọi bài dưới đây
// gọi thẳng mã bộ dựng dùng, nên gỡ một cổng trong `genPlan.ts` là có bài đỏ ở đây.

import { describe, it, expect } from "vitest";
import { Data } from "@lucid-evolution/lucid";
import {
  computeSQ, computeRateLockedQ, computeMi, checkSchRate,
  computeShardId, computeShardIdFromHash, countEligibleFires,
  nanogicToMagicStr, lampToOildrop, unlockLockedAmount, isExpired, isLive,
  selectLampForLock, assertHoldingCapAfterCommit,
} from "../offchain/src/math.js";
import {
  SHARD_CAP, SNAPSHOT_BASE_RATE_Q, SCHEDULE_SCALE_HORIZON_CAP, MAX_GEN_SCHEDULES,
  MAX_FIRES_PER_TX_CATCHUP, MAX_BATCHES_PER_VAULT, MAX_LOYALTY_HOLDINGS,
} from "../offchain/src/constants.js";
import {
  planScheduleCommit, planScheduleFire, type CommitPlanInput,
} from "../offchain/src/genPlan.js";
import { amountByLamp } from "../offchain/src/genFormula.js";
import {
  VaultRedeemer,
  type VaultDatum, type GenSchedule, type MagicBatch, type ScheduleShardDatum,
} from "../offchain/src/types.js";
import {
  TV_SCH_01, TV_SCH_02, TV_SCH_03, TV_SCH_04, TV_SCH_05,
  TV_SCH_06, TV_SCH_CATCHUP_LIMIT, TV_SCH_T_DET, TV_SCH_FIRE3,
  TV_SCH_ACT7, TV_SCH_CLIFF, TV_SCH_SHARD_CRED, TV_SCH_BOUNDS,
} from "./vectors.js";
import {
  makeVaultV2, makeShardV2, makeBeacon, makeGbShard, makeRate, ZW,
} from "./genV2Fixtures.js";

// ── Fixtures v2.0 ─────────────────────────────────────────────

const SHARD   = 10;                         // chủ "0a"×28 (genV2Fixtures) ⟹ shard 10
const REF     = { txHash: "33".repeat(32), outputIndex: 0 };
const BIG     = 250_000_000_000_000n;       // 250M LAMP (ví dụ Bob)
const E_C     = 50n;                        // epoch ký của các ví dụ §11.11

/** Két v2.0 chưa khoá gì, cửa sổ neo ở epoch ký. */
function freshVault(over: Partial<VaultDatum> = {}): VaultDatum {
  return makeVaultV2({
    lamp_balance:       BIG,
    loyalty_holdings:   [{ amount: BIG, acquired_epoch: 0n, is_locked: false }],
    last_updated_epoch: E_C - 1n,
    usage_window_epoch: E_C - 1n,
    ...over,
  });
}

function commitInput(over: Partial<CommitPlanInput> = {}): CommitPlanInput {
  return {
    vaultDatum:     freshVault(),
    vaultRef:       REF,
    scheduleLength: TV_SCH_02.L,
    lampPerEpoch:   TV_SCH_02.lambda_oildrop,
    currentEpoch:   E_C,
    rateParam:      makeRate(),
    gbBeacon:       makeBeacon(E_C),
    gbShardIn:      makeGbShard(SHARD),
    shardIn:        makeShardV2(SHARD),
    ...over,
  };
}
const commit = (over: Partial<CommitPlanInput> = {}) => planScheduleCommit(commitInput(over));

/** Hợp đồng v2.0 đã ký ở epoch 50 (Bob §11.11), `m_per_epoch` chốt sẵn. */
function scheduleV2(over: Partial<GenSchedule> = {}): GenSchedule {
  return {
    schedule_id:            "5c4ed0",
    commit_epoch:           E_C,
    start_fire_epoch:       52n,
    end_fire_epoch:         151n,
    schedule_length:        100n,
    lamp_per_epoch:         4_000_000_000n,
    rate_locked_q:          11_250_000_000n,
    baseline_at_commit_q:   5_000_000_000n,
    multiplier_at_commit_q: 2_250_000_000n,
    fired_count:            0n,
    auto_burn_target:       null,
    m_per_epoch:            TV_SCH_FIRE3.M_i,
    usage_factor_locked_q:  750_000_000n,
    ...over,
  };
}

/** Két đang giữ ĐÚNG phần LAMP còn khoá của một hợp đồng. */
function vaultWith(s: GenSchedule, over: Partial<VaultDatum> = {}): VaultDatum {
  const locked = s.lamp_per_epoch * (s.schedule_length - s.fired_count);
  return freshVault({
    lamp_locked: locked,
    loyalty_holdings: [
      { amount: locked,       acquired_epoch: 0n, is_locked: true  },
      { amount: BIG - locked, acquired_epoch: 1n, is_locked: false },
    ],
    gen_schedules:      [s],
    last_updated_epoch: s.commit_epoch,
    usage_window_epoch: s.commit_epoch,
    ...over,
  });
}

/** Shard LAMP khớp đúng phần còn lại của một hợp đồng (khoá + nghĩa vụ). */
function shardFor(s: GenSchedule, over: Partial<ScheduleShardDatum> = {}): ScheduleShardDatum {
  const left = s.schedule_length - s.fired_count;
  return makeShardV2(SHARD, {
    shard_locked_lamp:        s.lamp_per_epoch * left,
    shard_obligation_nanogic: s.m_per_epoch * left,
    shard_active_count:       1n,
    ...over,
  });
}

function fire(d: VaultDatum, shardIn: ScheduleShardDatum, scheduleId: string, e: bigint) {
  return planScheduleFire({ vaultDatum: d, vaultRef: REF, scheduleId, currentEpoch: e, shardIn });
}

const sumHoldings = (d: VaultDatum) => d.loyalty_holdings.reduce((a, h) => a + h.amount, 0n);

// ═══════════════════════════════════════════════════════════════
// §11.3 S(L) piecewise
// ═══════════════════════════════════════════════════════════════

describe("computeSQ — §11.3, T11, T12", () => {

  it("TV-SCH-01: all 5 values bit-identical", () => {
    for (const { L, S_Q } of TV_SCH_01.cases) {
      expect(computeSQ(L), `L=${L}`).toBe(S_Q);
    }
  });

  it("T11: S(50) continuous — seg1=seg2=2.0B", () => {
    expect(computeSQ(50n)).toBe(2_000_000_000n);
  });

  it("T11: S(150) continuous — seg2=seg3=2.5B", () => {
    expect(computeSQ(150n)).toBe(2_500_000_000n);
  });

  it("T12: dS/dL strictly decreasing (slopes 10M > 5M > 2.5M)", () => {
    const vals = [10n,20n,30n,50n,60n,100n,150n,160n,200n].map(L => [L, computeSQ(L)] as const);
    for (let i = 0; i < vals.length - 1; i++) {
      const [L1, S1] = vals[i]!;
      const [L2, S2] = vals[i+1]!;
      expect(S2).toBeGreaterThan(S1);
      const slope = Number(S2 - S1) / Number(L2 - L1);
      expect(slope).toBeLessThanOrEqual(10_000_000);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// §11.2 rate_locked_q + C-SCH-RATE
// ═══════════════════════════════════════════════════════════════

describe("computeRateLockedQ + C-SCH-RATE — §11.2", () => {

  it("TV-SCH-02: rate_locked_q = ⌊R·S(100)/Q⌋ = 11,25 nanogic/oildrop", () => {
    expect(computeSQ(TV_SCH_02.L)).toBe(TV_SCH_02.S_Q);
    expect(computeRateLockedQ(SNAPSHOT_BASE_RATE_Q, TV_SCH_02.L)).toBe(TV_SCH_02.rate_locked_q);
  });

  // P8 với `math.ak` ▸ `unit_anchor_tv_sch_02`. `compute_m_i` còn sống ở Aiken (bài canh
  // đơn vị + fixture) nên bản TS giữ để hai đầu cùng đỏ nếu ai đổi. Nó KHÔNG còn là lượng
  // mỗi lượt bắn — lượng đó là `m_per_epoch` (khối kế tiếp).
  it("TV-SCH-02 (P8): ⌊λ·rate_locked/Q⌋ = 45 MAGIC — gương compute_m_i", () => {
    expect(computeMi(TV_SCH_02.lambda_oildrop, TV_SCH_02.rate_locked_q)).toBe(TV_SCH_02.M_i);
  });

  it("TV-SCH-05: λ·rate_locked < Q ⟹ C-SCH-RATE bác", () => {
    const { lambda_oildrop, rate_locked_q } = TV_SCH_05;
    expect(checkSchRate(lambda_oildrop, rate_locked_q)).toBe(false);
  });

  it("CỰC ĐỐI: λ·rate_locked == Q đúng biên ⟹ C-SCH-RATE cho qua", () => {
    expect(checkSchRate(TV_SCH_05.lambda_oildrop, 1_000n)).toBe(true);    // 10⁶·10³ = Q
    expect(checkSchRate(TV_SCH_05.lambda_oildrop, 999n)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// M_i chốt lúc ký — Gen v2.0 (SPEC §6.1.2, CC-GEN-SCHEDULE-FIXED)
// ═══════════════════════════════════════════════════════════════

describe("m_per_epoch — chốt lúc ký, bất biến qua mọi lượt bắn", () => {

  it("TV-SCH-02 v2.0: Bob ký ở ρ = 4 ⟹ 12 MAGIC/lượt = amount_by_lamp(λ, 0, cửa sổ, min(rate, ρ), 6)", () => {
    const p = commit();
    expect(p.rhoEffectiveQ).toBe(TV_SCH_02.rho_q_v2);
    expect(p.mPerEpoch).toBe(TV_SCH_02.m_per_epoch_v2);
    expect(p.mPerEpoch).toBe(amountByLamp(
      TV_SCH_02.lambda_oildrop, 0n, ZW(),
      TV_SCH_02.rho_q_v2 < TV_SCH_02.rate_locked_q ? TV_SCH_02.rho_q_v2 : TV_SCH_02.rate_locked_q,
      SCHEDULE_SCALE_HORIZON_CAP));
    expect(p.newSchedule.m_per_epoch).toBe(p.mPerEpoch);
    expect(nanogicToMagicStr(p.mPerEpoch)).toBe("12.0000");
  });

  it("TV-SCH-03: ρ hạ SAU khi ký — ký mới cấp ít hơn, hợp đồng cũ vẫn bắn đúng lượng đã chốt", () => {
    const v = TV_SCH_03;
    const old = commit({ rateParam: makeRate({ rho_q: v.rho_at_commit, prev_rho_q: v.rho_at_commit }) });
    const neu = commit({ rateParam: makeRate({ rho_q: v.rho_later, prev_rho_q: v.rho_later }) });
    expect(old.mPerEpoch).toBe(v.M_at_commit);
    expect(neu.mPerEpoch).toBe(v.M_new_commit);      // ρ CÓ tác dụng lúc ký

    // Bắn hợp đồng cũ ở epoch 80: `planScheduleFire` không nhận beacon nào, nên lượng
    // chỉ có thể đến từ datum. Đã bắn 28 lượt (52..79) ⟹ lượt kế có epoch danh nghĩa 80.
    const s = { ...old.newSchedule, fired_count: v.fire_epoch - old.newSchedule.start_fire_epoch };
    const r = fire(vaultWith(s), shardFor(s), s.schedule_id, v.fire_epoch);
    expect(r.firesInTx).toBe(1);
    expect(r.mPerEpoch).toBe(v.M_at_fire);
    expect(r.newBatches.map(b => b.initial_amount)).toEqual([v.M_at_fire]);
  });

  it("TV-SCH-T-DET: 10 lượt bắn liên tiếp, lượt nào cũng cấp đúng m_per_epoch", () => {
    const v = TV_SCH_T_DET;
    let s = scheduleV2({
      schedule_length: v.schedule_length, lamp_per_epoch: v.lambda_oildrop,
      m_per_epoch: v.m_per_epoch, end_fire_epoch: E_C + v.schedule_length + 1n,
    });
    let d = vaultWith(s);
    let sh = shardFor(s);
    const amounts: bigint[] = [];
    for (let k = 0n; k < v.schedule_length; k++) {
      const r = fire(d, sh, s.schedule_id, s.start_fire_epoch + k);
      expect(r.firesInTx).toBe(1);
      amounts.push(...r.newBatches.map(b => b.initial_amount));
      d = r.vaultDatumOut; sh = r.shardOut;
    }
    expect(amounts).toEqual(Array(Number(v.schedule_length)).fill(v.m_per_epoch));
  });
});

// ═══════════════════════════════════════════════════════════════
// C-FIRE-1 ≥ catch-up
// ═══════════════════════════════════════════════════════════════

describe("countEligibleFires — C-FIRE-1 ≥, catch-up", () => {

  it("TV-SCH-06: 4 missed epochs → 4 fires", () => {
    const { start_fire_epoch, fired_count, current_epoch, fires_in_tx } = TV_SCH_06;
    expect(countEligibleFires(start_fire_epoch, fired_count, 100n, current_epoch, 0)).toBe(fires_in_tx);
  });

  it("TV-SCH-CATCHUP-LIMIT: 18 eligible → capped at 8", () => {
    const { start_fire_epoch, fired_count, schedule_length, current_epoch, fires_in_tx } = TV_SCH_CATCHUP_LIMIT;
    const result = countEligibleFires(start_fire_epoch, fired_count, schedule_length, current_epoch, 0);
    expect(result).toBe(fires_in_tx);
    expect(result).toBeLessThanOrEqual(MAX_FIRES_PER_TX_CATCHUP);
  });

  it("C-FIRE-1 ≥: fire allowed at e_i ≤ current (not exact match like Vacuum)", () => {
    expect(countEligibleFires(52n, 0n, 100n, 52n, 0)).toBe(1);
    expect(countEligibleFires(52n, 0n, 100n, 55n, 0)).toBe(4);
    expect(countEligibleFires(52n, 0n, 100n, 51n, 0)).toBe(0);
  });

  it("Batch budget cap: vault full limits fires", () => {
    const fires = countEligibleFires(52n, 0n, 100n, 59n, 30);
    expect(fires).toBeLessThanOrEqual(2);
  });

  // ── Ngõ cụt 32 batch — bài canh phía off-chain (P8 với Aiken
  // `f_fire_full_of_dead_batches_now_fires` / `..._live_batches_still_rejected`).
  // Nay chạy thẳng trên `planScheduleFire` (bộ dựng gọi đúng hàm này), không chỉ trên
  // `countEligibleFires` — tham số "số batch CÒN SỐNG" là hợp đồng của BÊN GỌI.
  const mkBatches = (n: number, createdEpoch: bigint): MagicBatch[] =>
    Array.from({ length: n }, (_, i) => ({
      batch_id:            i.toString(16).padStart(2, "0"),
      source:              "Schedule" as const,
      created_epoch:       createdEpoch,
      initial_amount:      1n,
      current_amount:      1n,
      decay_window:        1n,
      profile_at_creation: null,
      contract_id:         null,
      halved:              false,
    }));

  it("32 batch ĐÃ CHẾT không được khoá fire — planScheduleFire dọn rồi mới đếm", () => {
    const s = scheduleV2();
    const d = vaultWith(s, { magic_batches: mkBatches(MAX_BATCHES_PER_VAULT, 50n) });   // chết từ 51
    const r = fire(d, shardFor(s), s.schedule_id, 59n);
    expect(r.firesInTx).toBeGreaterThan(0);
    expect(r.vaultDatumOut.magic_batches.every(b => b.contract_id === s.schedule_id)).toBe(true);
  });

  it("CỰC ĐỐI: 32 batch CÒN SỐNG vẫn khoá fire — trần không bị nới", () => {
    const s = scheduleV2();
    const d = vaultWith(s, { magic_batches: mkBatches(MAX_BATCHES_PER_VAULT, 59n) });   // sống ở 59
    expect(() => fire(d, shardFor(s), s.schedule_id, 59n)).toThrow(/No eligible fires/);
  });
});

// ═══════════════════════════════════════════════════════════════
// §5.5 Shard ID (C-SCH-FIRE-SHARD)
// ═══════════════════════════════════════════════════════════════

describe("computeShardId — §5.5, C-SCH-FIRE-SHARD", () => {

  it("TV-SCH-SHARD-CRED: VerificationKey(h) ⟹ đúng shard của vector (P8)", () => {
    for (const v of TV_SCH_SHARD_CRED) {
      expect(computeShardId({ VerificationKey: [v.inner] })).toBe(v.shard_id);
      expect(computeShardIdFromHash(v.inner)).toBe(v.shard_id);
    }
  });

  it("TV-SCH-SHARD-CRED: Script(h) rơi CÙNG shard với VerificationKey(h) (khai ở on-chain)", () => {
    for (const v of TV_SCH_SHARD_CRED) {
      expect(computeShardId({ Script: [v.inner] })).toBe(v.shard_id);
    }
  });

  it("CỰC ĐỐI: vector phân biệt được — bốn đầu vào cho ít nhất ba shard khác nhau", () => {
    expect(new Set(TV_SCH_SHARD_CRED.map((v) => v.shard_id)).size).toBeGreaterThanOrEqual(3);
  });

  it("CỰC ĐỐI: pkh trần (hình dạng owner cũ) ⟹ NÉM, không băm nhầm chuỗi", () => {
    expect(() => computeShardId("00".repeat(28) as never)).toThrow(/OWNER_CREDENTIAL_SHAPE/);
  });

  it("CỰC ĐỐI: shard LAMP của shard khác ⟹ nhánh ký NÉM GEN-SCH-008", () => {
    expect(() => commit({ shardIn: makeShardV2(SHARD + 1) })).toThrow(/GEN-SCH-008/);
  });
});

// ═══════════════════════════════════════════════════════════════
// TV-SCH-04: Shard cap (T13, C-SCH-CAP) — qua nhánh ký thật
// ═══════════════════════════════════════════════════════════════

describe("Shard participation cap — T13, C-SCH-CAP", () => {

  const at = (c: (typeof TV_SCH_04.cases)[number], locked: bigint) =>
    () => commit({
      scheduleLength: c.L, lampPerEpoch: c.lambda_oildrop,
      shardIn: makeShardV2(SHARD, { shard_locked_lamp: locked }),
    });

  it("TV-SCH-04: ca ACCEPT của vector đi qua planScheduleCommit", () => {
    const c = TV_SCH_04.cases.find(x => x.expected === "ACCEPT")!;
    expect(at(c, TV_SCH_04.shard_locked)().shardOut.shard_locked_lamp).toBe(c.new_locked);
  });

  it("TV-SCH-04: ca REJECT của vector ⟹ GEN-SCH-006", () => {
    const c = TV_SCH_04.cases.find(x => x.expected === "REJECT")!;
    expect(at(c, TV_SCH_04.shard_locked)).toThrow(/GEN-SCH-006/);
  });

  it("biên: shard_locked + L·λ == cap đi qua; lệch 1 oildrop ⟹ GEN-SCH-006", () => {
    const c = TV_SCH_04.cases.find(x => x.expected === "ACCEPT")!;
    expect(at(c, SHARD_CAP - c.total)().shardOut.shard_locked_lamp).toBe(SHARD_CAP);
    expect(at(c, SHARD_CAP - c.total + 1n)).toThrow(/GEN-SCH-006/);
  });

  it("SHARD_CAP = 4.5×10¹⁴ oildrop (450M LAMP per shard)", () => {
    expect(SHARD_CAP).toBe(450_000_000_000_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
// Biên nhánh ký (TV-SCH-BOUNDS) — qua planScheduleCommit
// ═══════════════════════════════════════════════════════════════

describe("Commit constraint boundaries", () => {

  const lam = lampToOildrop(1000n);

  for (const c of TV_SCH_BOUNDS.cases.filter(x => "L" in x)) {
    const L = (c as { L: bigint }).L;
    it(`${c.reason}`, () => {
      const run = () => commit({ scheduleLength: L, lampPerEpoch: lam });
      if (c.expected === "ACCEPT") expect(run().newSchedule.schedule_length).toBe(L);
      else expect(run).toThrow(/GEN-SCH-001/);
    });
  }

  const others = (n: number): GenSchedule[] =>
    Array.from({ length: n }, (_, i) => scheduleV2({ schedule_id: i.toString(16).padStart(4, "0"), commit_epoch: 40n }));

  it(`C-SCH-10: ${MAX_GEN_SCHEDULES - 1} hợp đồng đang chạy ⟹ ký thêm được`, () => {
    const p = commit({ vaultDatum: freshVault({ gen_schedules: others(MAX_GEN_SCHEDULES - 1) }) });
    expect(p.vaultDatumOut.gen_schedules).toHaveLength(MAX_GEN_SCHEDULES);
  });

  it(`CỰC ĐỐI C-SCH-10: ${MAX_GEN_SCHEDULES} hợp đồng ⟹ GEN-SCH-005`, () => {
    expect(() => commit({ vaultDatum: freshVault({ gen_schedules: others(MAX_GEN_SCHEDULES) }) }))
      .toThrow(/GEN-SCH-005/);
  });

  it("C-SCH-3: L×λ == L_avail đi qua; L×λ > L_avail ⟹ GEN-SCH-003", () => {
    const tight = (bal: bigint) => freshVault({
      lamp_balance: bal, loyalty_holdings: [{ amount: bal, acquired_epoch: 0n, is_locked: false }],
    });
    expect(commit({ vaultDatum: tight(10n * lam), scheduleLength: 10n, lampPerEpoch: lam }).totalLock)
      .toBe(10n * lam);
    expect(() => commit({ vaultDatum: tight(10n * lam - 1n), scheduleLength: 10n, lampPerEpoch: lam }))
      .toThrow(/GEN-SCH-003/);
  });
});

// ═══════════════════════════════════════════════════════════════
// C-FIRE-3 atomic (§11.10) — qua planScheduleFire
// ═══════════════════════════════════════════════════════════════

describe("C-FIRE-3 atomic fire assertion", () => {

  it("TV-SCH-FIRE3: mọi vế kế toán của một lượt bắn 4 lệnh khớp vector", () => {
    const { fires_in_tx, M_i, assertions: a } = TV_SCH_FIRE3;
    const s = scheduleV2();
    const d = vaultWith(s);
    const r = fire(d, shardFor(s), s.schedule_id, 52n + BigInt(fires_in_tx) - 1n);
    const out = r.vaultDatumOut;

    expect(r.firesInTx).toBe(fires_in_tx);
    expect(out.gen_schedules[0]!.fired_count - s.fired_count).toBe(a.fired_count_delta);
    expect(out.lamp_balance - d.lamp_balance).toBe(a.lamp_balance_delta);
    expect(out.lamp_locked - d.lamp_locked).toBe(a.lamp_locked_delta);
    expect(sumHoldings(out) - sumHoldings(d)).toBe(a.holdings_sum_delta);
    expect(r.newBatches).toHaveLength(a.new_batches_count);
    for (const b of r.newBatches) {
      expect(b.initial_amount).toBe(a.each_batch_initial);
      expect(b.current_amount).toBe(M_i);
      expect(b.decay_window).toBe(a.each_batch_decay_window);
    }
  });

  it("Bob §11.11: bắn ở epoch 55 ⟹ 4 lệnh bù, 180 MAGIC ghi batch, 16 000 LAMP giải khoá", () => {
    const v = TV_SCH_06;
    const s = scheduleV2({ start_fire_epoch: v.start_fire_epoch, fired_count: v.fired_count });
    const r = fire(vaultWith(s), shardFor(s), s.schedule_id, v.current_epoch);
    const total = r.newBatches.reduce((a, b) => a + b.initial_amount, 0n);
    expect(r.firesInTx).toBe(v.fires_in_tx);
    expect(total).toBe(v.total_magic_fired);
    expect(r.lampReleased).toBe(v.lamp_transferred);
    expect(r.vaultDatumOut.gen_schedules[0]!.fired_count).toBe(v.output_fired_count);
    expect(nanogicToMagicStr(total)).toBe("180.0000");
  });
});

// ═══════════════════════════════════════════════════════════════
// VaultRedeemer constructor-index contract (P8 invariant)
//
// Thứ tự enum `VaultRedeemer` trong `types.ak` là tag constr Plutus Data:
//   ScheduleCommit=0, ScheduleFire=1, BurnBatch=2, WithdrawLamp=3, SetDelegate=4,
//   PruneExpired=5.
// Bài dưới MÃ HOÁ THẬT bằng lược đồ TS rồi đọc byte đầu — bản trước so một mảng chữ
// với chính nó, nên không ghim gì, và nó thiếu luôn `PruneExpired`.
// ═══════════════════════════════════════════════════════════════

describe("VaultRedeemer constr-index contract (P8: Aiken ↔ TS order)", () => {

  const cases: Array<[string, unknown, number]> = [
    ["ScheduleCommit", { ScheduleCommit: { schedule_length: 10n, lamp_per_epoch: 1n } }, 0],
    ["ScheduleFire",   { ScheduleFire: { schedule_id: "aa" } },                             1],
    ["BurnBatch",      { BurnBatch: { burns: [] } },                                        2],
    ["WithdrawLamp",   { WithdrawLamp: { amount: 1n } },                                    3],
    ["SetDelegate",    { SetDelegate: { new_delegate: null } },                             4],
    ["PruneExpired",   { PruneExpired: [] },                                                5],
  ];

  for (const [name, value, idx] of cases) {
    it(`${name} là constr ${idx} ⟹ CBOR head 0xd8${(0x79 + idx).toString(16)}`, () => {
      const hex = Data.to(value as never, VaultRedeemer);
      expect(hex.slice(0, 4)).toBe("d8" + (0x79 + idx).toString(16));
    });
  }

  it("T10: không có biến thể huỷ hợp đồng — mọi tên biến thể đều nằm trong danh sách trên", () => {
    expect(cases.map(c => c[0])).not.toContain("CancelSchedule");
    expect(() => Data.to({ CancelSchedule: {} } as never, VaultRedeemer)).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// Vòng đời hợp đồng: ký → nhiều lượt bắn → xong — chuỗi datum thật
// ═══════════════════════════════════════════════════════════════

describe("Schedule lifecycle: commit → fires → complete", () => {

  function runToEnd(fireEpochs: bigint[]) {
    const p = commit({ scheduleLength: 10n, lampPerEpoch: lampToOildrop(1000n) });
    let d = p.vaultDatumOut;
    let sh = p.shardOut;
    const id = p.newSchedule.schedule_id;
    let batches = 0;
    for (const e of fireEpochs) {
      const r = fire(d, sh, id, e);
      batches += r.newBatches.length;
      d = r.vaultDatumOut; sh = r.shardOut;
    }
    return { p, d, sh, batches };
  }

  it("L=10, bắn đúng hạn từng epoch: 10 batch, hợp đồng gỡ, khoá + nghĩa vụ về đúng mốc trước khi ký", () => {
    const { p, d, sh, batches } = runToEnd(Array.from({ length: 10 }, (_, k) => E_C + 2n + BigInt(k)));
    expect(batches).toBe(10);
    expect(d.gen_schedules).toEqual([]);
    expect(d.lamp_locked).toBe(0n);
    expect(d.lamp_balance).toBe(BIG);
    expect(d.loyalty_holdings.every(h => !h.is_locked)).toBe(true);
    // shard: hai tổng tích luỹ bằng nhau, nghĩa vụ M×N đã trả hết
    const s0 = makeShardV2(SHARD);
    expect(sh.shard_locked_lamp).toBe(s0.shard_locked_lamp);
    expect(sh.shard_obligation_nanogic).toBe(s0.shard_obligation_nanogic);
    expect(sh.shard_cumulative_fired - s0.shard_cumulative_fired).toBe(p.totalLock);
    expect(sh.shard_active_count).toBe(s0.shard_active_count);
  });

  it("Bắn bù 3 lệnh rồi bắn nốt: tổng batch vẫn đúng N, không lệnh nào mất hay nhân đôi", () => {
    const { d, batches } = runToEnd([54n, 55n, 56n, 57n, 58n, 59n, 60n, 61n]);
    expect(batches).toBe(10);          // 3 (52..54) + 7 lượt đúng hạn
    expect(d.gen_schedules).toEqual([]);
  });

  it("CỰC ĐỐI: bắn thêm sau khi hợp đồng đã gỡ ⟹ NÉM (không tìm thấy hợp đồng)", () => {
    const { d, sh, p } = runToEnd(Array.from({ length: 10 }, (_, k) => E_C + 2n + BigInt(k)));
    expect(() => fire(d, sh, p.newSchedule.schedule_id, 70n)).toThrow(/not found/);
  });
});

// ═══════════════════════════════════════════════════════════════
// I-ACT-7: a fire releases the lock, it never moves LAMP
// ═══════════════════════════════════════════════════════════════

describe("I-ACT-7 — LAMP đứng yên across a fire", () => {

  it("TV-SCH-ACT7: balance invariant, lock reduced, Σholdings invariant", () => {
    const v = TV_SCH_ACT7;
    const released = v.lambda_oildrop * BigInt(v.fires_in_tx);

    const after = unlockLockedAmount(v.before.loyalty_holdings, released);
    expect(after).toEqual(v.after.loyalty_holdings);

    const sumBefore = v.before.loyalty_holdings.reduce((s, h) => s + h.amount, 0n);
    const sumAfter  = after.reduce((s, h) => s + h.amount, 0n);
    expect(sumAfter).toBe(sumBefore);
    expect(sumAfter).toBe(v.after.lamp_balance);
    expect(v.before.lamp_locked - released).toBe(v.after.lamp_locked);
  });

  it("unlockLockedAmount: full release flips is_locked without changing amounts", () => {
    const before = [{ amount: 100n, acquired_epoch: 5n, is_locked: true }];
    const after  = unlockLockedAmount(before, 100n);
    expect(after).toEqual([{ amount: 100n, acquired_epoch: 5n, is_locked: false }]);
  });

  it("unlockLockedAmount: oldest-locked-first, unlocked entries kept up front", () => {
    const before = [
      { amount: 10n, acquired_epoch: 9n, is_locked: false },
      { amount: 30n, acquired_epoch: 5n, is_locked: true  },
      { amount: 20n, acquired_epoch: 7n, is_locked: true  },
    ];
    const after = unlockLockedAmount(before, 30n);
    expect(after).toEqual([
      { amount: 10n, acquired_epoch: 9n, is_locked: false },
      { amount: 30n, acquired_epoch: 5n, is_locked: false },
      { amount: 20n, acquired_epoch: 7n, is_locked: true  },
    ]);
  });

  it("unlockLockedAmount: releasing more than is locked throws", () => {
    const before = [{ amount: 10n, acquired_epoch: 5n, is_locked: true }];
    expect(() => unlockLockedAmount(before, 11n)).toThrow("GEN-LOCK-002");
  });

  // Nợ #30 — THE BOUND. Mirrors Aiken ul_repeated_does_not_grow (vault.ak) (P8).
  it("unlockLockedAmount: repeated partial releases do not grow the list", () => {
    const h1 = unlockLockedAmount([{ amount: 1000n, acquired_epoch: 5n, is_locked: true }], 100n);
    const h2 = unlockLockedAmount(h1, 100n);
    const h3 = unlockLockedAmount(h2, 100n);
    expect(h3).toHaveLength(2);
    expect(h3.reduce((a, h) => a + h.amount, 0n)).toBe(1000n);
    expect(h3).toEqual([
      { amount: 300n, acquired_epoch: 5n, is_locked: false },
      { amount: 700n, acquired_epoch: 5n, is_locked: true  },
    ]);
  });

  // Mirrors ul_keeps_distinct_epochs_apart.
  it("unlockLockedAmount: distinct acquired_epoch are kept apart", () => {
    const after = unlockLockedAmount([
      { amount: 50n, acquired_epoch: 2n, is_locked: true },
      { amount: 50n, acquired_epoch: 7n, is_locked: true },
    ], 100n);
    expect(after).toEqual([
      { amount: 50n, acquired_epoch: 2n, is_locked: false },
      { amount: 50n, acquired_epoch: 7n, is_locked: false },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════
// §4.2 use-or-lose + bắn bù theo epoch DANH NGHĨA (SPEC v2.0 §6.1.2)
// ═══════════════════════════════════════════════════════════════

describe("§4.2 cliff — batch sống đúng epoch danh nghĩa của nó", () => {

  it("TV-SCH-CLIFF: live at k=0, dead from k=1", () => {
    for (const c of TV_SCH_CLIFF.cases) {
      expect(isExpired(c.created_epoch, TV_SCH_CLIFF.decay_window, c.current_epoch))
        .toBe(c.expired);
      expect(isLive(c.created_epoch, TV_SCH_CLIFF.decay_window, c.current_epoch))
        .toBe(!c.expired);
    }
  });

  // Hành vi v1 (bị bỏ): đóng dấu cả 4 batch bù bằng epoch 55 ⟹ 180 MAGIC SỐNG trong
  // một epoch. v2.0 (`validate_fire` ▸ `create_fire_batches(..., first_nominal)`): lượt j
  // mang epoch 52+j, nên ở epoch 55 chỉ batch của chính epoch 55 tiêu được.
  it("bắn bù không hồi sinh epoch đã qua: 4 lệnh ở epoch 55 ⟹ chỉ 45 MAGIC còn sống", () => {
    const v = TV_SCH_06;
    const s = scheduleV2({ start_fire_epoch: v.start_fire_epoch, fired_count: v.fired_count });
    const r = fire(vaultWith(s), shardFor(s), s.schedule_id, v.current_epoch);
    expect(r.newBatches.map(b => b.created_epoch)).toEqual([52n, 53n, 54n, 55n]);
    const live = r.newBatches.filter(b => isLive(b.created_epoch, b.decay_window, v.current_epoch));
    expect(live.map(b => b.created_epoch)).toEqual([55n]);
    expect(live.reduce((a, b) => a + b.current_amount, 0n)).toBe(v.live_magic_at_current);
  });

  it("CỰC ĐỐI: bắn ĐÚNG hạn (1 lệnh ở epoch 52) ⟹ batch duy nhất còn sống", () => {
    const s = scheduleV2();
    const r = fire(vaultWith(s), shardFor(s), s.schedule_id, 52n);
    expect(r.newBatches.map(b => b.created_epoch)).toEqual([52n]);
    expect(isLive(52n, r.newBatches[0]!.decay_window, 52n)).toBe(true);
  });

  it("cửa sổ usage: generated của lượt bù ghi vào ô current − e_j, không dồn vào ô 0", () => {
    const s = scheduleV2();
    const r = fire(vaultWith(s), shardFor(s), s.schedule_id, 55n);
    const M = s.m_per_epoch;
    expect(r.vaultDatumOut.usage_window.map(u => u.generated)).toEqual([M, M, M, M, 0n, 0n, 0n]);
    expect(r.vaultDatumOut.usage_window_epoch).toBe(55n);
  });
});

// ═══════════════════════════════════════════════════════════════
// TV-OVERFLOW-02 — BigInt bắt buộc ở phía ScheduleGen
//
// Vector này khai ở `InstantGen/tests/vectors.ts` (TV_OVERFLOW_02) nhưng ở đó nó
// KHÔNG có một assertion nào, và `ALL_VECTORS` không tệp nào import — nghĩa là chốt
// mà BOUNDARIES.md §2 viện dẫn cho phía ScheduleGen từng chỉ là đồ trang trí.
// Bài kiểm thật sống ở đây, cạnh `computeSQ` mà nó gác.
// ═══════════════════════════════════════════════════════════════
describe("C-OVERFLOW — TV-OVERFLOW-02: trung gian S_Q × R_snap vượt Number", () => {
  it("S_Q(200) × SNAPSHOT_BASE_RATE_Q khớp vector và vượt MAX_SAFE_INTEGER", () => {
    const sQ = computeSQ(200n);
    expect(sQ).toBe(2_625_000_000n);

    const intermediate = sQ * SNAPSHOT_BASE_RATE_Q;
    expect(intermediate).toBe(13_125_000_000_000_000_000n);
    expect(intermediate > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("ở độ lớn đó Number KHÔNG phân biệt được hai giá trị kề nhau", () => {
    // Cái hỏng không phải giá trị mẫu, mà là ĐỘ PHÂN GIẢI: quanh 1.3e19 khoảng cách
    // giữa hai double kề nhau đã là hàng nghìn, nên một nanogic lệch biến mất không
    // dấu vết. Đó là lý do mọi số tiền phải là BigInt.
    const exact = computeSQ(200n) * SNAPSHOT_BASE_RATE_Q;
    expect(Number(exact + 1n)).toBe(Number(exact));
    expect(Number(exact + 1000n)).toBe(Number(exact));
  });
});

describe("C-SCH-HOLD — cửa VÀO phải hẹp hơn cửa RA đúng một suất", () => {
  // Số học đứng sau dấu `<`. Các bài dưới neo theo HẰNG, không theo số 40.
  function fullyUnlocked(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      amount: 1_000_000n, acquired_epoch: BigInt(i + 1), is_locked: false,
    }));
  }

  it("khoá TRỌN không cắt holding nào — độ dài giữ nguyên", () => {
    const before = fullyUnlocked(MAX_LOYALTY_HOLDINGS);
    const after  = selectLampForLock(before, BigInt(MAX_LOYALTY_HOLDINGS) * 1_000_000n);
    expect(after).toHaveLength(MAX_LOYALTY_HOLDINGS);
    expect(after.every(h => h.is_locked)).toBe(true);
  });

  it("nhưng lượt fire đầu tiên cắt một cái — danh sách dài thêm ĐÚNG 1", () => {
    const locked = selectLampForLock(
      fullyUnlocked(MAX_LOYALTY_HOLDINGS),
      BigInt(MAX_LOYALTY_HOLDINGS) * 1_000_000n);
    expect(unlockLockedAmount(locked, 4_300_000n))
      .toHaveLength(MAX_LOYALTY_HOLDINGS + 1);
  });

  it("chạm đúng trần sau commit bị chặn — đó là lối vào của bẫy khoá vĩnh viễn", () => {
    expect(() => assertHoldingCapAfterCommit(MAX_LOYALTY_HOLDINGS, "t"))
      .toThrow("GEN-SCH-007");
  });

  it("trần − 1 đi qua — và một suất đó vừa đủ cho lượt fire cắt thêm", () => {
    expect(() => assertHoldingCapAfterCommit(MAX_LOYALTY_HOLDINGS - 1, "t")).not.toThrow();
    const locked = selectLampForLock(
      fullyUnlocked(MAX_LOYALTY_HOLDINGS - 1),
      BigInt(MAX_LOYALTY_HOLDINGS - 1) * 1_000_000n);
    expect(unlockLockedAmount(locked, 4_300_000n))
      .toHaveLength(MAX_LOYALTY_HOLDINGS);
  });

  // Cặp ghim LỜI GỌI trong `planScheduleCommit` (bản trước ghi "CHƯA GHIM" vì lời gọi
  // nằm trong bộ dựng Lucid; nay nó nằm ở hàm thuần). Hai ca chỉ khác MỘT holding
  // không bị chạm: 39 holding khoá trọn + 0 hay 1 holding tự do.
  const A = lampToOildrop(1000n);
  const holdingsFor = (extra: number) => [
    ...Array.from({ length: MAX_LOYALTY_HOLDINGS - 1 }, (_, i) => ({
      amount: A, acquired_epoch: BigInt(i + 1), is_locked: false,
    })),
    ...Array.from({ length: extra }, () => ({ amount: A, acquired_epoch: 1000n, is_locked: false })),
  ];
  const commitHold = (extra: number) => {
    const hs = holdingsFor(extra);
    const bal = hs.reduce((a, h) => a + h.amount, 0n);
    return commit({
      vaultDatum: freshVault({ lamp_balance: bal, loyalty_holdings: hs }),
      scheduleLength: BigInt(MAX_LOYALTY_HOLDINGS - 1), lampPerEpoch: A,
    });
  };

  it("planScheduleCommit: sau ký còn trần − 1 holding ⟹ ký được", () => {
    expect(commitHold(0).vaultDatumOut.loyalty_holdings).toHaveLength(MAX_LOYALTY_HOLDINGS - 1);
  });

  it("CỰC ĐỐI planScheduleCommit: sau ký chạm ĐÚNG trần ⟹ GEN-SCH-007", () => {
    expect(() => commitHold(1)).toThrow(/GEN-SCH-007/);
  });
});
