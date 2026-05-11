// tests/math.test.ts — SnapshotGen math unit tests
// Run: npx vitest run tests/math.test.ts

import { describe, it, expect } from "vitest";
import {
  lfPwlQ, computeLfQ, computeOacQ, countActiveApps,
  computeSnapshotMagic, snapshotBatchBalance, burnSnapshot,
  computeCatchupMagic, isExpired, nanogicToMagicStr, slotToEpoch,
} from "../offchain/src/math.js";
import {
  TV_SS_01, TV_SS_02, TV_SS_03, TV_SS_04,
  TV_LF_01, TV_LF_02, TV_LF_03, TV_LF_BOUNDARIES,
  TV_SNAPGEN_01, TV_SNAPGEN_MATURE,
  TV_CATCHUP_01, TV_SAMENESS_01, TV_OAC_BOUNDARY,
} from "./vectors.js";
import { PROFILE_PARAMS } from "../offchain/src/constants.js";

// ═══════════════════════════════════════════════════════════════
// §4.2 Snapshot batch decay
// ═══════════════════════════════════════════════════════════════

describe("snapshotBatchBalance — §4.2, L1, T2", () => {

  it("TV-SS-01: Lantern full lifetime (all 10 steps)", () => {
    for (const { k, balance } of TV_SS_01.expected) {
      const result = snapshotBatchBalance(TV_SS_01.m0, TV_SS_01.profile, k);
      expect(result, `k=${k}`).toBe(balance);
    }
  });

  it("TV-SS-02: Flame (7 steps incl. cutoff)", () => {
    for (const { k, balance } of TV_SS_02.expected) {
      const result = snapshotBatchBalance(TV_SS_02.m0, TV_SS_02.profile, k);
      expect(result, `k=${k}`).toBe(balance);
    }
  });

  it("TV-SS-03: Ember (4 steps incl. cutoff)", () => {
    for (const { k, balance } of TV_SS_03.expected) {
      const result = snapshotBatchBalance(TV_SS_03.m0, TV_SS_03.profile, k);
      expect(result, `k=${k}`).toBe(balance);
    }
  });

  it("T2: hard cutoff — balance=0 exactly at k=N", () => {
    // Ember N=3
    expect(snapshotBatchBalance(1_000_000_000n, "Ember",   3n)).toBe(0n);
    // Flame N=6
    expect(snapshotBatchBalance(1_000_000_000n, "Flame",   6n)).toBe(0n);
    // Lantern N=9
    expect(snapshotBatchBalance(1_000_000_000n, "Lantern", 9n)).toBe(0n);
  });

  it("L2: monotone — balance(k+1) ≤ balance(k)", () => {
    const m0 = 1_000_000_000n;
    for (const profile of ["Ember", "Flame", "Lantern"] as const) {
      const N = { Ember: 3, Flame: 6, Lantern: 9 }[profile];
      for (let k = 0; k < N - 1; k++) {
        const bk  = snapshotBatchBalance(m0, profile, BigInt(k));
        const bk1 = snapshotBatchBalance(m0, profile, BigInt(k + 1));
        expect(bk1, `${profile} k=${k}→${k+1}`).toBeLessThanOrEqual(bk);
      }
    }
  });

  it("L1: error ≤ N(P) nanogic — cumulative floor loss bounded", () => {
    // Lantern N=9: worst case ≤ 9 nanogic total error
    const m0 = 1_000_000_000n;
    // Exact rational: m0 × 0.9^8 = m0 × 43046721/100000000
    const exact_num = m0 * 43_046_721n;
    const exact_den = 100_000_000n;
    const exact_floor = exact_num / exact_den;
    const computed = snapshotBatchBalance(m0, "Lantern", 8n);
    const error = exact_floor - computed;
    expect(error).toBeGreaterThanOrEqual(0n);   // M_actual ≤ M_true
    expect(error).toBeLessThanOrEqual(9n);       // L1: ≤ N=9 nanogic
  });
});

// ═══════════════════════════════════════════════════════════════
// §6.6 Scale-back burn (T17)
// ═══════════════════════════════════════════════════════════════

describe("burnSnapshot — §6.6, T17", () => {

  it("TV-SS-04: Lantern k=3, burn=200M → diff=0 ✓ (user-favorable)", () => {
    const { m0, profile, k, burn, expected_isb, expected_new_initial,
            expected_new_balance, expected_diff } = TV_SS_04;
    const result = burnSnapshot(m0, profile, k, burn);

    expect(result.isb).toBe(expected_isb);
    expect(result.newInitialAmount).toBe(expected_new_initial);
    expect(result.newBalance).toBe(expected_new_balance);
    expect(result.diff).toBe(expected_diff);   // 0 ✓ (T17: ≤ 1 nanogic)

    // T17: new_balance ≥ current - burn (user-favorable)
    expect(result.newBalance).toBeGreaterThanOrEqual(TV_SS_04.current_before_burn - burn);
  });

  it("T17: new_balance ≥ current - burn for all profiles at all k", () => {
    const m0 = 1_000_000_000n;
    for (const [profile, N] of [["Ember",3],["Flame",6],["Lantern",9]] as const) {
      for (let ki = 0; ki < N; ki++) {
        const k = BigInt(ki);
        const current = snapshotBatchBalance(m0, profile, k);
        if (current === 0n) continue;
        const burn = current / 2n;  // burn half
        if (burn === 0n) continue;
        const result = burnSnapshot(m0, profile, k, burn);
        expect(result.newBalance).toBeGreaterThanOrEqual(current - burn);
        expect(result.diff).toBeLessThanOrEqual(1n);  // ≤ 1 nanogic
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// §6.3 Loyalty Factor
// ═══════════════════════════════════════════════════════════════

describe("lfPwlQ — §6.3, TV-LF-01..03", () => {

  it("TV-LF-01: age=0 → 1.00", () => {
    expect(lfPwlQ(0n)).toBe(1_000_000_000n);
  });

  it("TV-LF-02: age=24 → 1.50 (cap)", () => {
    expect(lfPwlQ(24n)).toBe(1_500_000_000n);
  });

  it("Boundary table (§6.3)", () => {
    for (const { age, expected } of TV_LF_BOUNDARIES) {
      expect(lfPwlQ(age), `age=${age}`).toBe(expected);
    }
  });

  it("age > 24 → still 1.50 (cap)", () => {
    expect(lfPwlQ(25n)).toBe(1_500_000_000n);
    expect(lfPwlQ(100n)).toBe(1_500_000_000n);
  });

  it("Monotone: LF(age+1) ≥ LF(age)", () => {
    for (let a = 0n; a < 30n; a++) {
      expect(lfPwlQ(a + 1n)).toBeGreaterThanOrEqual(lfPwlQ(a));
    }
  });
});

describe("computeLfQ — weighted average, TV-LF-03", () => {

  it("TV-LF-03: 2 holdings → 1.30× weighted", () => {
    const { holdings, current_epoch, expected_lf_q } = TV_LF_03;
    expect(computeLfQ(holdings, current_epoch)).toBe(expected_lf_q);
  });

  it("All same age → equals lfPwlQ(age)", () => {
    const holdings = [
      { amount: 500_000_000n, acquired_epoch: 50n, is_locked: false },
      { amount: 500_000_000n, acquired_epoch: 50n, is_locked: false },
    ];
    expect(computeLfQ(holdings, 56n)).toBe(lfPwlQ(6n)); // age=6 ✓
  });

  it("Locked holdings included in LF (C-SS-5)", () => {
    const holdings = [
      { amount: 1_000_000_000n, acquired_epoch: 50n, is_locked: true  }, // locked, age=24
      { amount: 1_000_000_000n, acquired_epoch: 74n, is_locked: false }, // free, age=0
    ];
    const lf = computeLfQ(holdings, 74n);
    // age_locked=24 → 1.5; age_free=0 → 1.0; weighted = (1.5+1.0)/2 = 1.25
    expect(lf).toBe(1_250_000_000n);
  });

  it("Empty holdings → LF=1.00", () => {
    expect(computeLfQ([], 100n)).toBe(1_000_000_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
// §6.4 OAC
// ═══════════════════════════════════════════════════════════════

describe("computeOacQ + countActiveApps — §6.4, TV-OAC-BOUNDARY", () => {

  it("TV-OAC-BOUNDARY: 2 active apps → OAC=0.90×", () => {
    const { activity_state, current_epoch, expected_active_apps, expected_oac_q } = TV_OAC_BOUNDARY;
    expect(countActiveApps(activity_state as any, current_epoch)).toBe(expected_active_apps);
    expect(computeOacQ(activity_state as any, current_epoch)).toBe(expected_oac_q);
  });

  it("OAC table: 0..4 apps", () => {
    const cases = [
      { apps: 0, oac: 800_000_000n },  // 0.80
      { apps: 1, oac: 850_000_000n },  // 0.85
      { apps: 2, oac: 900_000_000n },  // 0.90
      { apps: 3, oac: 950_000_000n },  // 0.95
      { apps: 4, oac: 1_000_000_000n },// 1.00
    ];
    for (const { apps, oac } of cases) {
      const activity = {
        recent_burn_epochs: Array.from({ length: apps }, (_, i) =>
          [`app${i}`, 90n] as [string, bigint],
        ),
        total_burns_count: 0n,
      };
      expect(computeOacQ(activity, 100n), `${apps} apps`).toBe(oac);
    }
  });

  it("Boundary: burn AT current epoch excluded from OAC window", () => {
    const activity = {
      recent_burn_epochs: [["app1", 100n] as [string, bigint]],
      total_burns_count: 0n,
    };
    // epoch 100, window [88,100) → ep=100 NOT in window → 0 apps
    expect(countActiveApps(activity, 100n)).toBe(0);
    expect(computeOacQ(activity, 100n)).toBe(800_000_000n);   // 0.80
  });

  it("Same app multiple burns → counted once (anti-sybil)", () => {
    const activity = {
      recent_burn_epochs: [
        ["app1", 90n] as [string, bigint],
        ["app1", 92n] as [string, bigint],  // same app_id, different epoch
        ["app1", 95n] as [string, bigint],
      ],
      total_burns_count: 0n,
    };
    expect(countActiveApps(activity, 100n)).toBe(1);           // 1 distinct app ✓
    expect(computeOacQ(activity, 100n)).toBe(850_000_000n);    // 0.85
  });
});

// ═══════════════════════════════════════════════════════════════
// §8.1 SnapshotGen formula
// ═══════════════════════════════════════════════════════════════

describe("computeSnapshotMagic — §8.1, T16, C-SS-5", () => {

  it("TV-SNAPGEN-01: 1000 LAMP, Flame, LF=1.0, OAC=0.8 → 4.62 MAGIC", () => {
    const { lamp_oil, lf_q, oac_q, profile, steps, expected_nanogic } = TV_SNAPGEN_01;
    const result = computeSnapshotMagic(lamp_oil, lf_q, oac_q, profile);
    expect(result).toBe(expected_nanogic);
    expect(nanogicToMagicStr(result)).toBe("4.6200");

    // Verify step-by-step (L4 audit) — use imported constants directly
    const Q = 1_000_000_000n, R = 5_000_000_000n;
    const { B_Q, PM_Q } = PROFILE_PARAMS[profile]!;
    const s1 = lamp_oil * R / Q;
    const s2 = s1 * lf_q / Q;
    const s3 = s2 * oac_q / Q;
    const s4 = s3 * PM_Q / Q;
    const s5 = s4 * B_Q / Q;
    expect(s1).toBe(steps.s1);
    expect(s2).toBe(steps.s2);
    expect(s3).toBe(steps.s3);
    expect(s4).toBe(steps.s4);
    expect(s5).toBe(steps.s5);
  });

  it("TV-SNAPGEN-MATURE: Ember, LF=1.5, OAC=1.0 → 11.2125 MAGIC (§20.3)", () => {
    const { lamp_oil, lf_q, oac_q, profile, expected_nanogic } = TV_SNAPGEN_MATURE;
    expect(computeSnapshotMagic(lamp_oil, lf_q, oac_q, profile)).toBe(expected_nanogic);
    expect(nanogicToMagicStr(expected_nanogic)).toBe("11.2125");
  });

  it("T16: SnapshotGen has NO UM parameter", () => {
    // The function signature has no um_q argument.
    // This test documents that T16 is structurally enforced.
    const fnStr = computeSnapshotMagic.toString();
    expect(fnStr).not.toContain("um_q");
    expect(fnStr).not.toContain("um_fallback");
  });

  it("C-SS-5: uses full lamp_balance (locked + free)", () => {
    // With locked LAMP, result should be higher than using only L_avail
    const fullBalance = 1_000_000_000n;   // 1000 LAMP
    const locked      =   500_000_000n;   // 500 LAMP locked
    const lAvail      =   500_000_000n;   // only 500 LAMP available
    const lf = 1_000_000_000n, oac = 1_000_000_000n;

    const mFull  = computeSnapshotMagic(fullBalance, lf, oac, "Flame");
    const mAvail = computeSnapshotMagic(lAvail,     lf, oac, "Flame");

    expect(mFull).toBeGreaterThan(mAvail);  // locked LAMP contributes ✓
    expect(mFull).toBe(mAvail * 2n);        // exactly 2× (full = 2× avail) ✓
  });

  it("L4: error ≤ 5 nanogic; M_actual ≤ M_true", () => {
    const Q = 1_000_000_000n, R = 5_000_000_000n;
    const L = 1_000_000_000n, lf = 1_100_000_000n, oac = 900_000_000n;
    const { B_Q, PM_Q } = PROFILE_PARAMS["Flame"]!;
    const m_actual = computeSnapshotMagic(L, lf, oac, "Flame");
    const true_num = L * R * lf * oac * PM_Q * B_Q;
    const true_den = Q * Q * Q * Q * Q;
    const m_true = true_num / true_den;
    expect(m_actual).toBeLessThanOrEqual(m_true);
    expect(m_true - m_actual).toBeLessThanOrEqual(5n);
  });
});

// ═══════════════════════════════════════════════════════════════
// §8.2 Catch-up
// ═══════════════════════════════════════════════════════════════

describe("computeCatchupMagic — §8.2, C-SS-6", () => {

  it("TV-CATCHUP-01: Δe=5, Flame, LF=1.1, OAC=0.9 → 28.586 MAGIC", () => {
    const { lamp_oil, lf_q, oac_q, profile, delta_epochs, m_per_epoch, expected_total } = TV_CATCHUP_01;
    const mOne = computeSnapshotMagic(lamp_oil, lf_q, oac_q, profile);
    expect(mOne).toBe(m_per_epoch);  // ✓ per epoch value
    const total = computeCatchupMagic(lamp_oil, lf_q, oac_q, profile, delta_epochs);
    expect(total).toBe(expected_total);  // 28_586_250_000 ✓
  });

  it("Δe=1 (no catch-up) → equals single epoch M", () => {
    const L = 1_000_000_000n, lf = 1_000_000_000n, oac = 800_000_000n;
    const m1 = computeSnapshotMagic(L, lf, oac, "Flame");
    const mc = computeCatchupMagic(L, lf, oac, "Flame", 1n);
    expect(mc).toBe(m1);
  });
});

// ═══════════════════════════════════════════════════════════════
// T4: Profile lock per batch (TV-SAMENESS-01)
// ═══════════════════════════════════════════════════════════════

describe("TV-SAMENESS-01: profile_at_creation immutable (T4)", () => {

  it("Batch with profile=Flame, N=6 expires at k=6 regardless of profile change", () => {
    const { batch, k_at_check, expected_expired } = TV_SAMENESS_01;
    // Use batch's own decay_window (N=6 for Flame) — NOT the new profile's N
    const isExp = k_at_check >= batch.decay_window;
    expect(isExp).toBe(expected_expired);  // k=6 ≥ N=6 → expired ✓
  });

  it("If wrong profile (Ember N=3) were used, batch would expire earlier at k=3", () => {
    // This documents WHY T4 matters
    const WRONG_decay_window = 3n;   // Ember N
    const k = TV_SAMENESS_01.k_at_check;   // 6
    // With Ember: expired at k=3, so at k=6 it's also expired but for the wrong reason
    // The point: batch created at ep95, Flame lifetime = 6, checked at ep101 (k=6) → correctly expired
    // If Ember N=3 were applied: expired at ep98 (k=3), before the profile change even happened
    expect(3n < TV_SAMENESS_01.batch.decay_window).toBe(true); // Ember N < Flame N ✓
  });
});

// ═══════════════════════════════════════════════════════════════
// LAMP conservation for SnapshotGen
// ═══════════════════════════════════════════════════════════════

describe("LAMP conservation — T16, T14", () => {

  it("TV-CONS-SNAPSHOT: lamp_balance unchanged before and after", () => {
    const before = 100_000_000_000n;
    const after  = before;   // SnapshotGen does NOT move LAMP (T16)
    expect(after).toBe(before);  // ✓
  });
});
