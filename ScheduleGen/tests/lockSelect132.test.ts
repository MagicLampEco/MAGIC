// tests/lockSelect132.test.ts — #132: khoá youngest-first CHỈ trong holding đang mở.
//
// Phía TypeScript của `ScheduleGen/onchain/lib/magiclamp/protocol/lock.ak` ▸
// `select_lamp_for_lock`. Ba vector `TV-LOCK-132-0x` dưới đây có CÙNG đầu vào, CÙNG đầu ra
// với ba bài `tv_lock_132_0x_*` trong `lock.ak` (P8): đổi một bên mà không đổi bên kia thì
// một trong hai bộ đỏ.
//
// Lỗi cũ: hàm sắp và duyệt MỌI holding, kể cả holding đã khoá ⟹ commit lần hai trên két có
// holding trẻ nhất đang khoá "khoá lại" nó, `lamp_locked` tăng đủ mà Σ khoá tăng ít hơn ⟹
// lượt nhả cuối ném GEN-LOCK-002 (on-chain: `expect remaining == 0`) ⟹ LAMP kẹt vĩnh viễn.

import { describe, it, expect } from "vitest";
import {
  selectLampForLock, unlockLockedAmount,
} from "../offchain/src/math.js";
import { planScheduleCommit, type CommitPlanInput } from "../offchain/src/genPlan.js";
import type { LoyaltyHolding } from "@magiclamp/protocol-utils";
import {
  makeVaultV2, makeShardV2, makeBeacon, makeGbShard, makeRate,
} from "./genV2Fixtures.js";
import { TV_SCH_02 } from "./vectors.js";

const lh = (amount: bigint, epoch: bigint, locked: boolean): LoyaltyHolding =>
  ({ amount, acquired_epoch: epoch, is_locked: locked });
const sumAll    = (h: LoyaltyHolding[]) => h.reduce((a, x) => a + x.amount, 0n);
const sumLocked = (h: LoyaltyHolding[]) => h.reduce((a, x) => a + (x.is_locked ? x.amount : 0n), 0n);

describe("#132 — vector P8 chung với lock.ak", () => {
  it("TV-LOCK-132-01: holding đang khoá là holding TRẺ NHẤT", () => {
    expect(selectLampForLock([lh(100n, 9n, true), lh(100n, 1n, false)], 100n))
      .toEqual([lh(100n, 9n, true), lh(100n, 1n, true)]);
    expect(selectLampForLock([lh(100n, 9n, true), lh(100n, 1n, false)], 50n))
      .toEqual([lh(100n, 9n, true), lh(50n, 1n, true), lh(50n, 1n, false)]);
  });

  it("TV-LOCK-132-02: HOÀ acquired_epoch giữa holding khoá và holding mở", () => {
    expect(selectLampForLock([lh(30n, 10n, true), lh(100n, 10n, false), lh(50n, 10n, false)], 120n))
      .toEqual([lh(30n, 10n, true), lh(50n, 10n, true), lh(70n, 10n, true), lh(30n, 10n, false)]);
  });

  it("TV-LOCK-132-03: khoá xen giữa, nhiều epoch", () => {
    expect(selectLampForLock(
      [lh(10n, 3n, false), lh(20n, 7n, true), lh(30n, 5n, false), lh(40n, 9n, false)], 50n))
      .toEqual([lh(20n, 7n, true), lh(40n, 9n, true), lh(10n, 5n, true), lh(20n, 5n, false), lh(10n, 3n, false)]);
  });

  it("lượng vượt phần đang mở thì ném, kể cả khi tổng khoá + mở đủ", () => {
    expect(() => selectLampForLock([lh(100n, 9n, true), lh(100n, 1n, false)], 101n))
      .toThrow("GEN-LOCK-001");
  });

  // TV-LOCK-132-04 — két chưa có holding khoá (lần commit đầu): thứ tự ra GIỮ đúng bản cũ.
  // Đóng băng bằng giá trị, không so với hàm khác: từ khi bản dùng chung tự lọc, phép so
  // "bọc vs không bọc" thành tự so với chính nó và không đo gì nữa.
  it("TV-LOCK-132-04: két chưa có holding khoá — kết quả như trước bản vá", () => {
    const hs = [lh(100n, 10n, false), lh(50n, 10n, false), lh(7n, 3n, false), lh(9n, 12n, false)];
    expect(selectLampForLock(hs, 0n))
      .toEqual([lh(9n, 12n, false), lh(50n, 10n, false), lh(100n, 10n, false), lh(7n, 3n, false)]);
    expect(selectLampForLock(hs, 57n))
      .toEqual([lh(9n, 12n, true), lh(48n, 10n, true), lh(2n, 10n, false), lh(100n, 10n, false), lh(7n, 3n, false)]);
    expect(selectLampForLock(hs, 166n))
      .toEqual([lh(9n, 12n, true), lh(50n, 10n, true), lh(100n, 10n, true), lh(7n, 3n, true)]);
  });
});

// Bộ sinh tất định (đồng dư tuyến tính) — cùng hằng số với `lock.ak` ▸ `prop_next`.
function* lcg(seed: bigint) {
  let s = seed;
  for (;;) { s = (s * 1_103_515_245n + 12_345n) % 2_147_483_648n; yield s; }
}
function genHoldings(r: Generator<bigint>, mixed: boolean): LoyaltyHolding[] {
  const n = Number(r.next().value / 7n % 12n) + 1;
  return Array.from({ length: n }, () => {
    const s1 = r.next().value, s2 = r.next().value, s3 = r.next().value;
    return lh(1n + s1 / 7n % 1000n, s2 / 7n % 6n, mixed && s3 / 7n % 2n === 0n);
  });
}
function genAmount(s: bigint, cap: bigint): bigint {
  const k = s / 7n % 4n;
  return k === 0n ? 0n : k === 1n ? cap : s / 11n % (cap + 1n);
}

describe("#132 — tính chất trên MỌI miền (holding khoá + mở trộn lẫn)", () => {
  it("select: Σ khoá tăng ĐÚNG bằng lượng yêu cầu; holding khoá đi qua nguyên vẹn, đứng đầu", () => {
    const r = lcg(132n);
    let cut = 0, youngestLocked = 0;
    for (let i = 0; i < 300; i++) {
      const hs = genHoldings(r, true);
      const locked = hs.filter(h => h.is_locked);
      const amount = genAmount(r.next().value, sumAll(hs) - sumLocked(hs));
      const out = selectLampForLock(hs, amount);
      expect(sumLocked(out) - sumLocked(hs)).toBe(amount);
      expect(sumAll(out)).toBe(sumAll(hs));
      expect(out.every(h => h.amount > 0n)).toBe(true);
      expect(out.slice(0, locked.length)).toEqual(locked);
      if (out.length > hs.length) cut++;
      const maxE = hs.reduce((m, h) => h.acquired_epoch > m ? h.acquired_epoch : m, -1n);
      if (hs.some(h => h.is_locked && h.acquired_epoch === maxE) && hs.some(h => !h.is_locked)) youngestLocked++;
    }
    // Bộ sinh phải phủ nhánh cắt và đúng ca #132, không thì bài xanh vì rỗng.
    expect(cut).toBeGreaterThanOrEqual(50);
    expect(youngestLocked).toBeGreaterThanOrEqual(30);
  });

  it("chuỗi genesis → commit → commit → fire … → nhả hết, Σ khoá == lamp_locked ở mọi bước", () => {
    const chain = (genesis: LoyaltyHolding[], lambda: bigint, l1: bigint, l2: bigint) => {
      let hs = selectLampForLock(genesis, l1 * lambda);
      let locked = l1 * lambda;
      expect(sumLocked(hs)).toBe(locked);
      hs = selectLampForLock(hs, l2 * lambda);
      locked += l2 * lambda;
      expect(sumLocked(hs)).toBe(locked);
      for (let i = 0n; i < l1 + l2; i++) {
        hs = unlockLockedAmount(hs, lambda);   // ném GEN-LOCK-002 nếu két lệch
        locked -= lambda;
        expect(sumLocked(hs)).toBe(locked);
      }
      expect(locked).toBe(0n);
      expect(sumAll(hs)).toBe(sumAll(genesis));
    };
    chain([lh(100n, 0n, false)], 7n, 3n, 4n);                        // một holding, mọi mảnh hoà
    chain([lh(100n, 9n, false), lh(200n, 1n, false)], 10n, 10n, 10n); // holding trẻ nhất bị khoá ở commit 1
  });
});

describe("#132 — bộ dựng planScheduleCommit trên két có holding trẻ nhất đang khoá", () => {
  const BIG = 250_000_000_000_000n;
  const E_C = 50n;
  const total = TV_SCH_02.L * TV_SCH_02.lambda_oildrop;
  const input = (): CommitPlanInput => ({
    vaultDatum: makeVaultV2({
      lamp_balance:       BIG,
      lamp_locked:        total,
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

  it("khoá từ holding e1 (đang mở), holding e9 giữ nguyên ở đầu, lamp_locked == Σ khoá", () => {
    const out = planScheduleCommit(input()).vaultDatumOut;
    expect(out.loyalty_holdings).toEqual([
      lh(total, 9n, true), lh(total, 1n, true), lh(BIG - 2n * total, 1n, false),
    ]);
    expect(out.lamp_locked).toBe(2n * total);
    expect(sumLocked(out.loyalty_holdings)).toBe(out.lamp_locked);
  });
});
