// tests/lockSum.test.ts — C-SCH-LOCKSUM (#132): bộ dựng kiểm TRƯỚC đẳng thức mà validator ép.
//
// Validator (`ScheduleGen/onchain/validators/vault.ak` ▸ `validate_commit`, `validate_fire`,
// `validate_withdraw_lamp`) đòi `sum_locked(output.loyalty_holdings) == output.lamp_locked`.
// Phía TS gương nó bằng `math.ts` ▸ `assertLockSumMatches`, gọi ở `planScheduleCommit` và
// `planScheduleFire` (nhánh rút ở `MagicSDK/src/withdrawLamp.ts`, bài kiểm ở
// `MagicSDK/tests/withdrawLamp.test.ts`).
//
// Mỗi nhánh có CẶP ca: datum VÀO đúng thì qua; datum VÀO lệch ĐÚNG 1 oildrop thì ném
// `GEN-LOCK-SUM`. Ca lệch đi qua mọi cổng khác (đủ L_avail, đủ cap shard, đủ holding), nên
// một ca xanh ở cả hai cực không phân biệt được có cổng này hay không — cặp mới ghim được.

import { describe, it, expect } from "vitest";
import type { LoyaltyHolding } from "@magiclamp/protocol-utils";
import { assertLockSumMatches } from "../offchain/src/math.js";
import {
  planScheduleCommit, planScheduleFire, type CommitPlanInput,
} from "../offchain/src/genPlan.js";
import type { GenSchedule, VaultDatum } from "../offchain/src/types.js";
import {
  makeVaultV2, makeShardV2, makeBeacon, makeGbShard, makeRate,
} from "./genV2Fixtures.js";
import { TV_SCH_02 } from "./vectors.js";

const lh = (amount: bigint, epoch: bigint, locked: boolean): LoyaltyHolding =>
  ({ amount, acquired_epoch: epoch, is_locked: locked });

describe("assertLockSumMatches — hàm gương", () => {
  it("Σ khoá == lamp_locked ⟹ qua", () => {
    expect(() => assertLockSumMatches([lh(7n, 1n, true), lh(5n, 2n, false), lh(3n, 3n, true)], 10n, "t"))
      .not.toThrow();
  });
  it("lệch ĐÚNG 1 oildrop (cả hai chiều) ⟹ ném GEN-LOCK-SUM", () => {
    const hs = [lh(7n, 1n, true), lh(5n, 2n, false), lh(3n, 3n, true)];
    expect(() => assertLockSumMatches(hs, 11n, "t")).toThrow(/GEN-LOCK-SUM/);
    expect(() => assertLockSumMatches(hs, 9n, "t")).toThrow(/GEN-LOCK-SUM/);
  });
});

describe("planScheduleCommit — C-SCH-LOCKSUM", () => {
  const BIG = 250_000_000_000_000n;
  const E_C = 50n;
  const total = TV_SCH_02.L * TV_SCH_02.lambda_oildrop;
  const input = (lockedSkew: bigint): CommitPlanInput => ({
    vaultDatum: makeVaultV2({
      lamp_balance:       BIG,
      lamp_locked:        total + lockedSkew,
      loyalty_holdings:   [lh(total, 9n, true), lh(BIG - total, 1n, false)],
      last_updated_epoch: E_C - 1n,
      usage_window_epoch: E_C - 1n,
    }),
    vaultRef:       { txHash: "33".repeat(32), outputIndex: 0 },
    scheduleLength: TV_SCH_02.L,
    lampPerEpoch:   TV_SCH_02.lambda_oildrop,
    currentEpoch:   E_C,
    rateParam:      makeRate(),
    gbBeacon:       makeBeacon(E_C),
    gbShardIn:      makeGbShard(10),
    shardIn:        makeShardV2(10),
  });

  it("datum vào nhất quán ⟹ qua, và đẳng thức giữ trên datum ra", () => {
    const out = planScheduleCommit(input(0n)).vaultDatumOut;
    const sumLocked = out.loyalty_holdings.reduce((a, h) => a + (h.is_locked ? h.amount : 0n), 0n);
    expect(sumLocked).toBe(out.lamp_locked);
  });

  it("datum vào lệch 1 oildrop (lamp_locked lớn hơn Σ khoá) ⟹ ném GEN-LOCK-SUM", () => {
    expect(() => planScheduleCommit(input(1n))).toThrow(/GEN-LOCK-SUM \(planScheduleCommit\)/);
  });
});

describe("planScheduleFire — C-SCH-LOCKSUM", () => {
  const E = 100n;
  const SHARD = 10;
  const LAMBDA = 1_000_000_000n;
  const sched = (): GenSchedule => ({
    schedule_id: "5c4ed0", commit_epoch: 98n, start_fire_epoch: E, end_fire_epoch: 109n,
    schedule_length: 10n, lamp_per_epoch: LAMBDA, rate_locked_q: 8_000_000_000n,
    baseline_at_commit_q: 5_000_000_000n, multiplier_at_commit_q: 1_600_000_000n,
    fired_count: 0n, auto_burn_target: null, m_per_epoch: 1_234_567_891n,
    usage_factor_locked_q: 750_000_000n,
  });
  const fire = (lockedSkew: bigint) => {
    const s = sched();
    const locked = s.lamp_per_epoch * (s.schedule_length - s.fired_count);
    const vaultDatum: VaultDatum = makeVaultV2({
      lamp_locked: locked + lockedSkew,
      loyalty_holdings: [
        lh(locked, 50n, true),
        lh(100_000_000_000n - locked, 60n, false),
      ],
      gen_schedules: [s],
    });
    return planScheduleFire({
      vaultDatum, vaultRef: { txHash: "33".repeat(32), outputIndex: 0 },
      scheduleId: s.schedule_id, currentEpoch: E,
      shardIn: makeShardV2(SHARD, { shard_locked_lamp: 100_000_000_000n }),
    });
  };

  it("datum vào nhất quán ⟹ qua, và đẳng thức giữ trên datum ra", () => {
    const out = fire(0n).vaultDatumOut;
    const sumLocked = out.loyalty_holdings.reduce((a, h) => a + (h.is_locked ? h.amount : 0n), 0n);
    expect(sumLocked).toBe(out.lamp_locked);
  });

  it("datum vào lệch 1 oildrop ⟹ ném GEN-LOCK-SUM", () => {
    expect(() => fire(1n)).toThrow(/GEN-LOCK-SUM \(planScheduleFire\)/);
  });
});
