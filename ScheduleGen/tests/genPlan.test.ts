// tests/genPlan.test.ts — nhánh KÝ + nhánh BẮN Gen v2.0 (tính thuần + bộ dựng giả).
//
// Mỗi bài âm có một hàng xóm dương chỉ khác ĐÚNG một đại lượng — cùng khuôn với cặp
// `g_*` trong `ScheduleGen/onchain/validators/vault.ak`, để mỗi cổng ở đây gương một cổng
// validator mà không xanh vì lý do rỗng.

import { describe, it, expect } from "vitest";
import { Data, Constr } from "@lucid-evolution/lucid";
import { msPerEpoch, windowOriginMs } from "@magiclamp/protocol-utils";
import { makeLucidFake } from "../../TestSupport/lucidFake.js";
import {
  planScheduleCommit, planScheduleFire, gbShardAfterDraw, drawnInEpoch, windowAddAt,
  rhoAt, type CommitPlanInput,
} from "../offchain/src/genPlan.js";
import { buildScheduleCommitTx, buildScheduleFireTx } from "../offchain/src/schedule.js";
import { computeMi, computeRateLockedQ } from "../offchain/src/math.js";
import { amountByLamp } from "../offchain/src/genFormula.js";
import {
  VaultDatum, GbShard, GbShardRedeemer, ScheduleShardDatum,
  type GenSchedule, type VaultDatum as TVaultDatum,
} from "../offchain/src/types.js";
import {
  SCHEDULE_OBLIGATION_CAP_PER_SHARD, SNAPSHOT_BASE_RATE_Q,
} from "../offchain/src/constants.js";
import {
  NETWORK, OWNER_PKH, VAULT_SCRIPT, SHARD_SCRIPT, GB_SHARD_SCRIPT, GEN, GB_RESET, RHO,
  makeVaultV2, makeShardV2, makeBeacon, makeGbShard, makeRate, ZW,
  vaultUtxoV2, shardUtxosV2, gbShardUtxos, rateBeaconUtxo, gbBeaconUtxo, registryUtxo,
  scriptAddr, GBB_SCRIPT_HASH, COMMIT_SCRIPT, COMMIT_REWARD, utxo,
} from "./genV2Fixtures.js";

const E = 100n;
const SHARD = 10;               // "0a"×28 ⟹ shard 10
const L = 10n;
const LAMBDA = 1_000_000_000n;  // 1 000 LAMP
// Khởi động lạnh, ρ = 4·10⁹ < rate_locked(10) = 8·10⁹ ⟹ M = ⌊λρ/Q⌋·0,5 + ⌊λρ/Q⌋·0,25 = 3·10⁹.
const M = 3_000_000_000n;
const DRAW = 2n * M;            // M × min(10, buffer_ep = 2)

function commitInput(over: Partial<CommitPlanInput> = {}): CommitPlanInput {
  return {
    vaultDatum: makeVaultV2(),
    vaultRef: { txHash: "33".repeat(32), outputIndex: 0 },
    scheduleLength: L, lampPerEpoch: LAMBDA, currentEpoch: E,
    rateParam: makeRate(),
    gbBeacon: makeBeacon(E),
    gbShardIn: makeGbShard(SHARD),
    shardIn: makeShardV2(SHARD),
    ...over,
  };
}

// ══════════════════════════════════════════════════════════════
// Nhánh KÝ
// ══════════════════════════════════════════════════════════════
describe("planScheduleCommit — M_i chốt lúc ký", () => {
  it("M_i = amount_by_lamp(λ, 0, cửa sổ, min(rate_locked, ρ), min(N, 6))", () => {
    const p = planScheduleCommit(commitInput());
    expect(computeRateLockedQ(SNAPSHOT_BASE_RATE_Q, L)).toBe(8_000_000_000n);
    expect(p.rhoEffectiveQ).toBe(RHO);
    expect(p.mPerEpoch).toBe(M);
    expect(p.mPerEpoch).toBe(amountByLamp(LAMBDA, 0n, ZW(), RHO, 6n));
    // CỰC ĐỐI của vế `min`: dùng rate_locked thay ρ thì ra số khác.
    expect(amountByLamp(LAMBDA, 0n, ZW(), 8_000_000_000n, 6n)).not.toBe(M);
    expect(p.newSchedule.m_per_epoch).toBe(M);
    expect(p.newSchedule.usage_factor_locked_q).toBe(750_000_000n);
    expect(p.gbDraw).toBe(DRAW);
    expect(p.obligation).toBe(M * L);
  });

  it("ρ theo effective_epoch: e ≥ mốc ⟹ rho_q; e < mốc ⟹ prev_rho_q", () => {
    const rp = makeRate({ rho_q: 2_000_000_000n, prev_rho_q: 3_000_000_000n, effective_epoch: E });
    expect(rhoAt(rp, E)).toBe(2_000_000_000n);
    expect(rhoAt(rp, E - 1n)).toBe(3_000_000_000n);
    expect(() => rhoAt(makeRate({ rho_q: 4_000_000_001n }), E)).toThrow(/GEN-SCH-RHO/);
  });

  it("datum ra: dịch cửa sổ tới epoch ký, KHÔNG cộng generated; shard GB trừ đúng DRAW", () => {
    const w = ZW(); w[0] = { generated: 7n, consumed: 5n };
    const p = planScheduleCommit(commitInput({
      vaultDatum: makeVaultV2({ usage_window: w, usage_window_epoch: E - 2n }),
    }));
    expect(p.vaultDatumOut.usage_window_epoch).toBe(E);
    expect(p.vaultDatumOut.usage_window[2]).toEqual({ generated: 7n, consumed: 5n });
    expect(p.vaultDatumOut.usage_window[0]).toEqual({ generated: 0n, consumed: 0n });
    expect(p.vaultDatumOut.last_updated_epoch).toBe(E);
    // Cửa sổ đã có lịch sử (Σg = 7, Σc = 5 ở ô đóng) ⟹ M KHÁC ca khởi động lạnh: hệ số đọc
    // SAU khi dịch (ô 0 cũ thành ô 2 — ô ĐÃ ĐÓNG).
    expect(p.mPerEpoch).toBe(amountByLamp(LAMBDA, 0n, p.vaultDatumOut.usage_window, RHO, 6n));
    expect(p.mPerEpoch).not.toBe(M);
    expect(p.gbDraw).toBe(2n * p.mPerEpoch);
    expect(p.gbShardOut).toEqual({ ...makeGbShard(SHARD), remaining: GB_RESET - p.gbDraw });
    expect(p.shardOut.shard_obligation_nanogic).toBe(makeShardV2(SHARD).shard_obligation_nanogic + p.mPerEpoch * L);
  });

  // ── Cặp: shard GB đủ / thiếu 1 nanogic ──
  it("shard GB còn ĐÚNG lượng rút ⟹ ký được, remaining về 0", () => {
    const p = planScheduleCommit(commitInput({ gbShardIn: makeGbShard(SHARD, { remaining: DRAW }) }));
    expect(p.gbShardOut.remaining).toBe(0n);
  });
  it("CỰC ĐỐI: shard GB thiếu 1 nanogic ⟹ GEN-SCH-GB-SHORT", () => {
    expect(() => planScheduleCommit(commitInput({ gbShardIn: makeGbShard(SHARD, { remaining: DRAW - 1n }) })))
      .toThrow(/GEN-SCH-GB-SHORT/);
  });

  // ── Cặp: nhánh đặt lại (beacon seq mới hơn) ──
  // Ở nhánh này trần mỗi-két (5% × reset) luôn chặt hơn lượng còn lại (= reset), nên cặp
  // phân biệt là ⌊GB/16⌋ = 20·DRAW (share == DRAW, đúng biên) đối với 20·DRAW − 1.
  it("beacon seq mới ⟹ shard đặt lại ⌊GB/16⌋ rồi trừ; share đúng biên ⟹ được", () => {
    const b = makeBeacon(E, { seq: 2n, gb_nanogic: 16n * 20n * DRAW });
    const p = planScheduleCommit(commitInput({ gbBeacon: b, gbShardIn: makeGbShard(SHARD, { remaining: 0n }) }));
    expect(p.gbShardOut).toEqual({ shard_id: BigInt(SHARD), seq: 2n, reset_amount: 20n * DRAW, remaining: 19n * DRAW });
  });
  it("CỰC ĐỐI: đặt lại ra ⌊GB/16⌋ = 20·DRAW − 1 ⟹ vượt trần mỗi-két", () => {
    const b = makeBeacon(E, { seq: 2n, gb_nanogic: 16n * (20n * DRAW - 1n) });
    expect(() => planScheduleCommit(commitInput({ gbBeacon: b, gbShardIn: makeGbShard(SHARD, { remaining: 0n }) })))
      .toThrow(/GEN-SCH-GB-VAULT-SHARE/);
  });

  it("trần mỗi-két-mỗi-epoch: drawn + DRAW ≤ ⌊reset·5%⌋ đúng biên ⟹ được; vượt 1 ⟹ NÉM", () => {
    // reset = 20·DRAW ⟹ share = DRAW đúng biên.
    const at = makeGbShard(SHARD, { reset_amount: 20n * DRAW, remaining: 20n * DRAW });
    expect(planScheduleCommit(commitInput({ gbShardIn: at })).gbDraw).toBe(DRAW);
    const under = makeGbShard(SHARD, { reset_amount: 20n * DRAW - 20n, remaining: 20n * DRAW });
    expect(() => planScheduleCommit(commitInput({ gbShardIn: under }))).toThrow(/GEN-SCH-GB-VAULT-SHARE/);
  });

  it("drawn_in_epoch chỉ đếm hợp đồng ký ở CHÍNH epoch đó", () => {
    const s = (commit: bigint): GenSchedule => ({
      ...planScheduleCommit(commitInput()).newSchedule, commit_epoch: commit,
    });
    expect(drawnInEpoch([s(E), s(E - 1n), s(E)], E)).toBe(2n * DRAW);
  });

  // ── Cặp: beacon tươi / cũ 1 epoch · depeg ──
  it("CỰC ĐỐI: beacon GreenBack ghi ở epoch trước ⟹ GEN-SCH-GB-STALE", () => {
    expect(() => planScheduleCommit(commitInput({ gbBeacon: makeBeacon(E - 1n) }))).toThrow(/GEN-SCH-GB-STALE/);
  });
  it("CỰC ĐỐI: beacon depeg ⟹ GEN-SCH-GB-DEPEG", () => {
    expect(() => planScheduleCommit(commitInput({ gbBeacon: makeBeacon(E, { depeg: true }) }))).toThrow(/DEPEG/);
  });
  it("CỰC ĐỐI: shard GB seq mới hơn beacon ⟹ GEN-SCH-GB-SEQ", () => {
    expect(() => planScheduleCommit(commitInput({ gbShardIn: makeGbShard(SHARD, { seq: 2n }) }))).toThrow(/GEN-SCH-GB-SEQ/);
  });

  // ── Cặp: cổng κ TẠM ──
  it("κ: nghĩa vụ chạm ĐÚNG trần ⟹ được; vượt 1 nanogic ⟹ GEN-SCH-KAPPA", () => {
    const at = SCHEDULE_OBLIGATION_CAP_PER_SHARD - M * L;
    expect(planScheduleCommit(commitInput({ shardIn: makeShardV2(SHARD, { shard_obligation_nanogic: at }) }))
      .shardOut.shard_obligation_nanogic).toBe(SCHEDULE_OBLIGATION_CAP_PER_SHARD);
    expect(() => planScheduleCommit(commitInput({
      shardIn: makeShardV2(SHARD, { shard_obligation_nanogic: at + 1n }),
    }))).toThrow(/GEN-SCH-KAPPA/);
  });

  it("CỰC ĐỐI: M_i = 0 (ρ = 0) ⟹ GEN-SCH-GEN-ZERO", () => {
    expect(() => planScheduleCommit(commitInput({ rateParam: makeRate({ rho_q: 0n }) }))).toThrow(/GEN-SCH-GEN-ZERO/);
  });
});

describe("gbShardAfterDraw — gương lazy_reset + remaining − amount", () => {
  it("seq bằng ⟹ giữ reset, trừ remaining", () => {
    expect(gbShardAfterDraw(makeGbShard(3, { remaining: 10n }), makeBeacon(E), GB_RESET, 4n))
      .toEqual(makeGbShard(3, { remaining: 6n }));
  });
  it("seq mới ⟹ reset = min(⌊GB/16⌋, cap)", () => {
    const b = makeBeacon(E, { seq: 5n, gb_nanogic: 1600n });
    expect(gbShardAfterDraw(makeGbShard(2, { seq: 4n, reset_amount: 50n, remaining: 1n }), b, 1_000n, 1n))
      .toEqual({ shard_id: 2n, seq: 5n, reset_amount: 100n, remaining: 99n });
    expect(gbShardAfterDraw(makeGbShard(2, { seq: 4n }), b, 60n, 1n).reset_amount).toBe(60n);
  });
});

// ══════════════════════════════════════════════════════════════
// Nhánh BẮN — KHÔNG đọc beacon, bắn bù theo epoch danh nghĩa
// ══════════════════════════════════════════════════════════════
const M_FIXED = 1_234_567_891n;   // cố ý KHÁC computeMi(λ, rate_locked) để phân biệt nguồn
function sched(over: Partial<GenSchedule> = {}): GenSchedule {
  return {
    schedule_id: "5c4ed0", commit_epoch: 98n, start_fire_epoch: E, end_fire_epoch: 109n,
    schedule_length: 10n, lamp_per_epoch: LAMBDA, rate_locked_q: 8_000_000_000n,
    baseline_at_commit_q: 5_000_000_000n, multiplier_at_commit_q: 1_600_000_000n,
    fired_count: 0n, auto_burn_target: null, m_per_epoch: M_FIXED, usage_factor_locked_q: 750_000_000n,
    ...over,
  };
}
function fireVault(s: GenSchedule, over: Partial<TVaultDatum> = {}): TVaultDatum {
  const locked = s.lamp_per_epoch * (s.schedule_length - s.fired_count);
  return makeVaultV2({
    lamp_locked: locked,
    loyalty_holdings: [
      { amount: locked, acquired_epoch: 50n, is_locked: true },
      { amount: 100_000_000_000n - locked, acquired_epoch: 60n, is_locked: false },
    ],
    gen_schedules: [s],
    ...over,
  });
}
function fireAt(e: bigint, s = sched(), shardOver = {}, vaultOver: Partial<TVaultDatum> = {}) {
  return planScheduleFire({
    vaultDatum: fireVault(s, vaultOver), vaultRef: { txHash: "33".repeat(32), outputIndex: 0 },
    scheduleId: s.schedule_id, currentEpoch: e,
    shardIn: makeShardV2(SHARD, { shard_locked_lamp: 100_000_000_000n, ...shardOver }),
  });
}

describe("planScheduleFire — Gen v2.0", () => {
  it("dùng m_per_epoch ĐÃ CHỐT, không tính lại từ rate_locked", () => {
    const p = fireAt(E);
    expect(computeMi(LAMBDA, 8_000_000_000n)).not.toBe(M_FIXED);
    expect(p.mPerEpoch).toBe(M_FIXED);
    expect(p.newBatches.map(b => b.initial_amount)).toEqual([M_FIXED]);
    expect(p.vaultDatumOut.usage_window[0]).toEqual({ generated: M_FIXED, consumed: 0n });
  });

  it("bắn bù: batch mang epoch DANH NGHĨA, cửa sổ ghi đúng ô current − e_j", () => {
    const p = fireAt(E + 3n);      // lượt 100..103
    expect(p.firesInTx).toBe(4);
    expect(p.firstNominalEpoch).toBe(E);
    expect(p.newBatches.map(b => b.created_epoch)).toEqual([E, E + 1n, E + 2n, E + 3n]);
    expect(p.vaultDatumOut.usage_window.slice(0, 4).map(u => u.generated))
      .toEqual([M_FIXED, M_FIXED, M_FIXED, M_FIXED]);
    expect(p.vaultDatumOut.usage_window.slice(4).every(u => u.generated === 0n)).toBe(true);
    expect(p.vaultDatumOut.usage_window_epoch).toBe(E + 3n);
  });

  it("bắn bù rất muộn: lượt có ô ≥ 7 bị BỎ khỏi cửa sổ (vẫn sinh batch chết)", () => {
    const p = fireAt(E + 10n);     // 8 lượt: danh nghĩa 100..107 ⟹ ô 10..3
    expect(p.firesInTx).toBe(8);
    expect(p.newBatches.map(b => b.created_epoch)[7]).toBe(E + 7n);
    expect(p.vaultDatumOut.usage_window.map(u => u.generated))
      .toEqual([0n, 0n, 0n, M_FIXED, M_FIXED, M_FIXED, M_FIXED]);
  });

  // ── Cặp: nghĩa vụ shard đủ / thiếu 1 ──
  it("nghĩa vụ shard ĐÚNG bằng M × lượt ⟹ về 0", () => {
    expect(fireAt(E, sched(), { shard_obligation_nanogic: M_FIXED }).shardOut.shard_obligation_nanogic).toBe(0n);
  });
  it("CỰC ĐỐI: nghĩa vụ shard thiếu 1 ⟹ GEN-SCH-KAPPA (âm)", () => {
    expect(() => fireAt(E, sched(), { shard_obligation_nanogic: M_FIXED - 1n })).toThrow(/GEN-SCH-KAPPA/);
  });

  it("lượt cuối gỡ hợp đồng, giảm active_count", () => {
    const p = fireAt(E + 9n, sched({ fired_count: 9n }));
    expect(p.scheduleComplete).toBe(true);
    expect(p.vaultDatumOut.gen_schedules).toEqual([]);
    expect(p.shardOut.shard_active_count).toBe(0n);
  });

  it("windowAddAt: ô âm ⟹ NÉM, ô ≥ 7 ⟹ giữ nguyên", () => {
    expect(() => windowAddAt(ZW(), -1n, 1n)).toThrow();
    expect(windowAddAt(ZW(), 7n, 5n)).toEqual(ZW());
  });
});

// ══════════════════════════════════════════════════════════════
// Bộ dựng (Lucid giả): hình dạng giao dịch
// ══════════════════════════════════════════════════════════════
const P_MS = msPerEpoch(NETWORK);
// Biên epoch giao thức E = gốc cửa sổ + E·P (không phải E·P — lưới gốc Unix cũ).
const TIP = windowOriginMs(NETWORK) + E * P_MS + 1_000n;
const LAMP_POLICY = "aa".repeat(28);
const LAMP_NAME = "744c414d50";
const VAULT_ASSETS = { lovelace: 5_000_000n, [LAMP_POLICY + LAMP_NAME]: 100_000_000_000n, ["bb".repeat(28) + "cc".repeat(8)]: 1n };

async function dungCommitV2(over: Record<string, unknown> = {}) {
  const fake = makeLucidFake();
  const res = await buildScheduleCommitTx({
    lucid: fake.lucid as any,
    vaultUtxo: vaultUtxoV2(makeVaultV2(), VAULT_ASSETS),
    shardUtxos: shardUtxosV2(),
    scheduleLength: L, lampPerEpoch: LAMBDA,
    userAddress: "addr_test1vq" + "q".repeat(50),
    vaultScript: VAULT_SCRIPT, shardScript: SHARD_SCRIPT, gbShardScript: GB_SHARD_SCRIPT,
    commitScript: COMMIT_SCRIPT,
    gen: GEN,
    rateBeaconUtxo: rateBeaconUtxo(),
    gbBeaconUtxo: gbBeaconUtxo(makeBeacon(E)),
    vaultRegistryUtxo: registryUtxo(),
    gbShardUtxos: gbShardUtxos(),
    lampPolicyId: LAMP_POLICY, lampAssetName: LAMP_NAME, network: NETWORK, tipPosixMs: TIP,
    ...over,
  } as any);
  return { res, tx: fake.onlyTx() };
}

describe("buildScheduleCommitTx v2.0 — hình dạng giao dịch", () => {
  it("tiêu vault + shard LAMP + shard GB (Draw = M×2), đọc ρ + GB + sổ, trả 3 output", async () => {
    const { tx, res } = await dungCommitV2();
    expect(res.mPerEpoch).toBe(M);
    expect(res.gbDraw).toBe(DRAW);
    expect(tx.collectFrom).toHaveLength(3);
    expect(tx.collectFrom[2]!.redeemer).toBe(Data.to({ amount: DRAW }, GbShardRedeemer));
    expect((tx.collectFrom[2]!.utxos[0] as { outputIndex: number }).outputIndex).toBe(SHARD);
    expect(tx.readFrom[0]!.map((u: any) => u.outputIndex)).toEqual([20, 21, 22]);
    expect(tx.attached).toHaveLength(4);
    expect(tx.attached[3]).toEqual(COMMIT_SCRIPT);
    expect(tx.outputs).toHaveLength(3);
    expect(tx.signerKeys).toEqual([OWNER_PKH]);
    const outs = tx.outputs as any[];
    const gbOut = outs[2];
    expect(gbOut.address).toBe(scriptAddr(GEN.gbShardPolicyId));
    expect(Data.from(gbOut.datum.value, GbShard)).toEqual(makeGbShard(SHARD, { remaining: GB_RESET - DRAW }));
    const vOut = Data.from(outs[0].datum.value, VaultDatum);
    expect(vOut.gen_schedules[0]!.m_per_epoch).toBe(M);
    expect(Data.from(outs[1].datum.value, ScheduleShardDatum).shard_obligation_nanogic)
      .toBe(makeShardV2(SHARD).shard_obligation_nanogic + M * L);
  });

  it("CỰC ĐỐI: shard GB thiếu 1 nanogic ⟹ bộ dựng NÉM, không dựng tx", async () => {
    await expect(dungCommitV2({ gbShardUtxos: gbShardUtxos(() => ({ remaining: DRAW - 1n })) }))
      .rejects.toThrow(/GEN-SCH-GB-SHORT/);
    await expect(dungCommitV2({ gbShardUtxos: gbShardUtxos(() => ({ remaining: DRAW })) }))
      .resolves.toBeDefined();
  });

  it("CỰC ĐỐI: beacon GB ở sai địa chỉ (NFT đúng) ⟹ GEN-SCH-BEACON", async () => {
    await expect(dungCommitV2({ gbBeaconUtxo: gbBeaconUtxo(makeBeacon(E), scriptAddr("99".repeat(28))) }))
      .rejects.toThrow(/GEN-SCH-BEACON/);
    expect(scriptAddr(GBB_SCRIPT_HASH)).not.toBe(scriptAddr("99".repeat(28)));
  });

  // ── Chân uỷ quyền `commit` (withdraw-zero) ──
  it("mục rút `commit`: ĐÚNG MỘT, 0 lovelace, reward address của commit, redeemer = Constr 0 [OutRef két]", async () => {
    const { tx } = await dungCommitV2();
    expect(tx.withdrawals).toHaveLength(1);
    const w = tx.withdrawals[0]!;
    expect(w.rewardAddress).toBe(COMMIT_REWARD);
    expect(w.amount).toBe(0n);
    // Theo BYTE: CommitRedeemer { vault_ref: OutputReference { "33"×32, 0 } }.
    expect(w.redeemer).toBe(Data.to(new Constr(0, [new Constr(0, ["33".repeat(32), 0n])]) as never));
  });

  it("CỰC ĐỐI: redeemer nêu ĐÚNG outRef của két đang tiêu — két ở #7 ⟹ redeemer mang 7", async () => {
    const v = { ...vaultUtxoV2(makeVaultV2(), VAULT_ASSETS), outputIndex: 7 };
    const { tx } = await dungCommitV2({ vaultUtxo: v });
    expect(tx.withdrawals[0]!.redeemer).toBe(Data.to(new Constr(0, [new Constr(0, ["33".repeat(32), 7n])]) as never));
  });

  it("CỰC ĐỐI: thiếu commitScript ⟹ GEN-SCH-COMMIT, không dựng tx", async () => {
    await expect(dungCommitV2({ commitScript: undefined })).rejects.toThrow(/GEN-SCH-COMMIT/);
  });

  it("ref-script `commit`: đúng hash ⟹ readFrom, không attach; sai hash ⟹ NÉM", async () => {
    const good = { ...utxo(null, { lovelace: 20_000_000n }, 30, "fa".repeat(32)), scriptRef: COMMIT_SCRIPT };
    const { tx } = await dungCommitV2({ commitRefScriptUtxo: good });
    expect(tx.attached).toHaveLength(3);
    expect(tx.attached).not.toContainEqual(COMMIT_SCRIPT);
    expect(tx.readFrom.flat().map((u: any) => u.outputIndex)).toContain(30);
    const bad = { ...good, scriptRef: SHARD_SCRIPT };
    await expect(dungCommitV2({ commitRefScriptUtxo: bad })).rejects.toThrow(/commit \(withdraw-zero\)/);
  });

  it("CỰC ĐỐI: gbShardScript không khớp gbShardPolicyId ⟹ NÉM", async () => {
    await expect(dungCommitV2({ gbShardScript: SHARD_SCRIPT })).rejects.toThrow(/gbShardPolicyId/);
  });

  it("CỰC ĐỐI: két datum v1 (17 trường) ⟹ GEN-SCH-V1-DATUM", async () => {
    const v2 = Data.from(Data.to(makeVaultV2(), VaultDatum)) as Constr<unknown>;
    const v1hex = Data.to(new Constr(0, v2.fields.slice(0, 17)) as never);
    await expect(dungCommitV2({ vaultUtxo: { ...vaultUtxoV2(makeVaultV2(), VAULT_ASSETS), datum: v1hex } }))
      .rejects.toThrow(/GEN-SCH-V1-DATUM/);
  });
});

describe("buildScheduleFireTx v2.0 — beacon vắng vẫn dựng được", () => {
  it("không beacon, không shard GB: dựng xong, không readFrom, không input shard GB", async () => {
    const fake = makeLucidFake();
    const s = sched();
    const res = await buildScheduleFireTx({
      lucid: fake.lucid as any,
      vaultUtxo: vaultUtxoV2(fireVault(s), VAULT_ASSETS),
      shardUtxos: shardUtxosV2(() => ({ shard_locked_lamp: 100_000_000_000n })),
      scheduleId: s.schedule_id,
      vaultScript: VAULT_SCRIPT, shardScript: SHARD_SCRIPT,
      lampPolicyId: LAMP_POLICY, lampAssetName: LAMP_NAME, network: NETWORK, tipPosixMs: TIP,
    } as any);
    const tx = fake.onlyTx();
    expect(tx.completed).toBe(true);
    expect(tx.readFrom).toEqual([]);
    expect(tx.collectFrom).toHaveLength(2);
    expect(tx.signerKeys).toEqual([]);
    expect(res.mPerFire).toBe(M_FIXED);
    const vOut = Data.from((tx.outputs[0] as any).datum.value, VaultDatum);
    expect(vOut.magic_batches[0]!.created_epoch).toBe(E);
    expect(vOut.usage_window[0]!.generated).toBe(M_FIXED);
  });
});
