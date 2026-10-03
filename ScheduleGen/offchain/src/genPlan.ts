// src/genPlan.ts — ScheduleGen Gen v2.0: tính THUẦN datum ra của nhánh ký + nhánh bắn.
//
// Không mạng, không Lucid: nhận datum đã giải mã + beacon đã giải mã, trả về datum ra.
// Bộ dựng giao dịch (`schedule.ts`) chỉ gọi hai hàm `planScheduleCommit` /
// `planScheduleFire` rồi dán kết quả vào tx — nên bài kiểm chạy thẳng trên hai hàm này.
//
// P8: mỗi bước dưới đây gương một dòng `expect` của validator, CÙNG THỨ TỰ:
//   `ScheduleGen/onchain/validators/vault.ak` ▸ `validate_commit` / `validate_fire`,
//   `ScheduleGen/onchain/lib/magiclamp/protocol/gen_gate.ak` ▸ `read_rho`,
//   `read_greenback_fresh`, `gb_draw_checked`, `drawn_in_epoch`, `window_add_at`,
//   `GenBeacons/onchain/lib/genbeacons/shard.ak` ▸ `lazy_reset` (shard GB tự đặt lại).
// Toán sinh KHÔNG viết lại ở đây — gọi `genFormula.ts` (bản chép trùng bit của InstantGen).
//
// Một điều kiện validator sẽ bác ⟹ NÉM trước khi dựng tx, kèm mã `GEN-SCH-…`. Không kẹp,
// không đệm: một giá trị bù ở đây đi tiếp vào datum và KHÔNG còn tự khai được là thiếu.

import { blake2b } from "@noble/hashes/blake2b";
import {
  SCHEDULE_DELAY, SCHEDULE_DECAY_WINDOW, MAX_GEN_SCHEDULES, MAX_BATCHES_PER_VAULT,
  MAX_LOYALTY_HOLDINGS, SCHEDULE_MIN_LENGTH, SCHEDULE_MAX_LENGTH, MIN_LAMP_PER_FIRE,
  SHARD_CAP, SHARD_COUNT, SNAPSHOT_BASE_RATE_Q, USAGE_WINDOW_LEN, BUFFER_EP, RHO_MAX_Q,
  GB_SHARD_CAP_NANOGIC, GB_SHARD_NFT_PREFIX, GREENBACK_BEACON_MAX_AGE_EPOCHS,
  SCHEDULE_SCALE_HORIZON_CAP, SCHEDULE_OBLIGATION_CAP_PER_SHARD,
} from "./constants.js";
import {
  computeSQ, computeRateLockedQ, checkSchRate, computeShardId, countEligibleFires,
  selectLampForLock, unlockLockedAmount, isExpired, lAvail, assertHoldingCapAfterCommit,
  assertLockSumMatches,
} from "./math.js";
import {
  amountByLamp, usageFactorQ, gbVaultShare, shiftWindow, windowWellFormed,
  type EpochUsage,
} from "./genFormula.js";
import type {
  VaultDatum, GenSchedule, MagicBatch, ScheduleShardDatum,
  RateParam, GreenBackBeacon, GbShard,
} from "./types.js";

function min2(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Tham chiếu UTxO két đang tiêu — nguồn băm `schedule_id` / `batch_id`. */
export interface VaultOutRef {
  txHash      : string;
  outputIndex : number;
}

/** blake2b_256(tx_hash ‖ u64be(output_index) ‖ u64be(idx)) — gương `math.ak` ▸
 *  `compute_schedule_id` / `compute_batch_id` (hai hàm cùng công thức). */
export function computeRefIndexId(ref: VaultOutRef, idx: bigint): string {
  const pre = Buffer.concat([
    Buffer.from(ref.txHash, "hex"), u64(BigInt(ref.outputIndex)), u64(idx),
  ]);
  return Buffer.from(blake2b(pre, { dkLen: 32 })).toString("hex");
}
function u64(n: bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b; }

// ══════════════════════════════════════════════════════════════
// Beacon + shard GB (gương `gen_gate.ak`)
// ══════════════════════════════════════════════════════════════

/** Tên NFT shard GB: "GBS" ‖ byte(shard_id) — gương `gen_gate.ak` ▸ `gb_shard_nft_name`. */
export function gbShardNftName(shardId: number): string {
  if (!Number.isInteger(shardId) || shardId < 0 || shardId >= SHARD_COUNT) {
    throw new RangeError(`shard_id ${shardId} ∉ [0, ${SHARD_COUNT})`);
  }
  return GB_SHARD_NFT_PREFIX + shardId.toString(16).padStart(2, "0");
}

/** ρ hiệu lực ở epoch `e` — gương `read_rho` (phần sau khi đã tìm đúng beacon).
 *  `e >= effective_epoch` ⟹ `rho_q`, ngược lại `prev_rho_q`; ngoài `[0, RHO_MAX_Q]` ⟹ NÉM. */
export function rhoAt(rp: RateParam, e: bigint): bigint {
  const rho = e >= rp.effective_epoch ? rp.rho_q : rp.prev_rho_q;
  if (rho < 0n || rho > RHO_MAX_Q) {
    throw new RangeError(`GEN-SCH-RHO: ρ hiệu lực ${rho} ∉ [0, ${RHO_MAX_Q}] ở epoch ${e}`);
  }
  return rho;
}

/** Beacon GreenBack DÙNG ĐƯỢC ở epoch `e` — gương các vế datum của `read_greenback_fresh`:
 *  `depeg == False` · `gb_nanogic >= 0` · `0 <= e − epoch <= max_age` (max_age = 0 ⟹ beacon
 *  phải ghi TRONG epoch hiện tại). */
export function assertGreenBackFresh(b: GreenBackBeacon, e: bigint): void {
  if (b.depeg) {
    throw new Error("GEN-SCH-GB-DEPEG: beacon GreenBack đang báo depeg — nhánh ký đóng (SPEC §6.1.3).");
  }
  if (b.gb_nanogic < 0n) {
    throw new RangeError(`GEN-SCH-GB: gb_nanogic âm (${b.gb_nanogic}).`);
  }
  if (b.epoch > e || e - b.epoch > GREENBACK_BEACON_MAX_AGE_EPOCHS) {
    throw new Error(
      `GEN-SCH-GB-STALE: beacon GreenBack ghi ở epoch ${b.epoch}, epoch hiện tại ${e}; ` +
      `tuổi tối đa ${GREENBACK_BEACON_MAX_AGE_EPOCHS}. Chờ lượt ghi beacon của epoch này.`);
  }
}

/** Shard GB sau khi rút `draw` — gương `gb_shard.ak` (`lazy_reset` + `remaining − amount`)
 *  cộng các vế két ép trong `gb_draw_checked`. `cap` = apply-param `gb_shard_cap_nanogic` của
 *  `gb_shard` (két không biết nó; shard ép `reset = min(⌊GB/16⌋, cap)` đúng bằng).
 *  `remaining_eff < draw` ⟹ NÉM `GEN-SCH-GB-SHORT`. */
export function gbShardAfterDraw(
  shardIn: GbShard, beacon: GreenBackBeacon, cap: bigint, draw: bigint,
): GbShard {
  if (draw <= 0n) throw new RangeError(`GEN-SCH-GB: lượng rút phải > 0, nhận ${draw}`);
  if (cap < 0n) throw new RangeError(`gb_shard_cap_nanogic âm (${cap})`);
  let eff: GbShard;
  if (beacon.seq > shardIn.seq) {
    const perShard = beacon.gb_nanogic / BigInt(SHARD_COUNT);
    const amount = min2(perShard, cap);
    eff = { shard_id: shardIn.shard_id, seq: beacon.seq, reset_amount: amount, remaining: amount };
  } else if (beacon.seq === shardIn.seq) {
    eff = { ...shardIn };
  } else {
    throw new Error(
      `GEN-SCH-GB-SEQ: shard GB seq ${shardIn.seq} mới hơn beacon seq ${beacon.seq} — beacon cũ.`);
  }
  const remaining = eff.remaining - draw;
  if (remaining < 0n) {
    throw new Error(
      `GEN-SCH-GB-SHORT: shard GB ${shardIn.shard_id} còn ${eff.remaining} nanogic, ` +
      `hợp đồng cần rút ${draw} (M × min(N, ${BUFFER_EP})). Thặng dư GreenBack không đủ.`);
  }
  return { ...eff, remaining };
}

/** Σ `m_per_epoch × min(N, buffer_ep)` của hợp đồng ký ở `e` — gương `drawn_in_epoch`. */
export function drawnInEpoch(schedules: readonly GenSchedule[], e: bigint): bigint {
  let acc = 0n;
  for (const s of schedules) {
    if (s.commit_epoch === e) acc += s.m_per_epoch * min2(s.schedule_length, BUFFER_EP);
  }
  return acc;
}

/** Cộng `generated` vào ô `idx` (0 = epoch đang mở); `idx >= 7` ⟹ bỏ (đã ra khỏi cửa sổ);
 *  `idx < 0` hoặc `generated < 0` ⟹ NÉM — gương `window_add_at`. */
export function windowAddAt(
  window: readonly EpochUsage[], idx: bigint, generated: bigint,
): EpochUsage[] {
  if (idx < 0n || generated < 0n) {
    throw new RangeError(`window_add_at: idx ${idx}, generated ${generated} phải ≥ 0`);
  }
  if (!windowWellFormed(window)) {
    throw new RangeError(`usage_window sai hình dạng (cần ${USAGE_WINDOW_LEN} ô không âm)`);
  }
  if (idx >= BigInt(USAGE_WINDOW_LEN)) return window.map(u => ({ ...u }));
  const i = Number(idx);
  return window.map((u, k) =>
    k === i ? { generated: u.generated + generated, consumed: u.consumed } : { ...u });
}

/** `fires` lượt, lượt j ghi `m` vào ô `firstIdx − j` — gương `vault.ak` ▸ `add_fires_to_window`. */
export function addFiresToWindow(
  window: readonly EpochUsage[], firstIdx: bigint, fires: number, m: bigint,
): EpochUsage[] {
  let w = window.map(u => ({ ...u }));
  for (let j = 0; j < fires; j++) w = windowAddAt(w, firstIdx - BigInt(j), m);
  return w;
}

// ══════════════════════════════════════════════════════════════
// Nhánh KÝ — gương `validate_commit`
// ══════════════════════════════════════════════════════════════

export interface CommitPlanInput {
  vaultDatum     : VaultDatum;
  vaultRef       : VaultOutRef;
  scheduleLength : bigint;            // N ∈ [10, 200]
  lampPerEpoch   : bigint;            // λ (oildrop)
  currentEpoch   : bigint;
  rateParam      : RateParam;         // datum beacon ρ (đã kiểm NFT + địa chỉ ở bộ dựng)
  gbBeacon       : GreenBackBeacon;   // datum beacon GreenBack (đã kiểm NFT + địa chỉ)
  gbShardIn      : GbShard;           // datum shard GB của két
  shardIn        : ScheduleShardDatum;// datum shard LAMP (tổng hợp) của két
  /** apply-param `gb_shard_cap_nanogic` của `gb_shard`. Bỏ trống ⟹ hằng TẠM. */
  gbShardCapNanogic?: bigint;
}

export interface CommitPlan {
  shardId            : number;
  totalLock          : bigint;
  sQ                 : bigint;
  rateLockedQ        : bigint;
  rhoEffectiveQ      : bigint;
  /** `M_i` — chốt lúc ký, cố định suốt N epoch. */
  mPerEpoch          : bigint;
  usageFactorLockedQ : bigint;
  /** Lượng shard GB bị TRỪ: `M × min(N, buffer_ep)`. */
  gbDraw             : bigint;
  /** Nghĩa vụ cộng vào shard LAMP: `M × N`. */
  obligation         : bigint;
  newSchedule        : GenSchedule;
  vaultDatumOut      : VaultDatum;
  shardOut           : ScheduleShardDatum;
  gbShardOut         : GbShard;
}

export function planScheduleCommit(inp: CommitPlanInput): CommitPlan {
  const { vaultDatum: d, scheduleLength: L, lampPerEpoch: lambda, currentEpoch: e } = inp;

  // C-SCH-1 / C-SCH-2 / C-SCH-3 / C-SCH-10
  if (L < SCHEDULE_MIN_LENGTH || L > SCHEDULE_MAX_LENGTH)
    throw new Error(`GEN-SCH-001: L=${L} ∉ [${SCHEDULE_MIN_LENGTH},${SCHEDULE_MAX_LENGTH}]`);
  if (lambda < MIN_LAMP_PER_FIRE)
    throw new Error(`GEN-SCH-002: λ=${lambda} < MIN=${MIN_LAMP_PER_FIRE} oildrop`);
  const totalLock = L * lambda;
  const avail = lAvail(d.lamp_balance, d.lamp_locked);
  if (totalLock > avail)
    throw new Error(`GEN-SCH-003: L×λ=${totalLock} > L_avail=${avail}`);
  if (d.gen_schedules.length >= MAX_GEN_SCHEDULES)
    throw new Error(`GEN-SCH-005: ${d.gen_schedules.length} schedules ≥ MAX=${MAX_GEN_SCHEDULES}`);

  const sQ          = computeSQ(L);
  const rateLockedQ = computeRateLockedQ(SNAPSHOT_BASE_RATE_Q, L);
  if (!checkSchRate(lambda, rateLockedQ))
    throw new Error(`GEN-SCH-004: C-SCH-RATE fail — ⌊λ·rate_locked/Q⌋ = 0. Tăng λ.`);

  // Cửa sổ dịch tới epoch ký TRƯỚC khi đọc hệ số.
  const window = shiftWindow(d.usage_window, d.usage_window_epoch, e);
  const rho = rhoAt(inp.rateParam, e);
  assertGreenBackFresh(inp.gbBeacon, e);

  // M_i = amount_by_lamp(λ, 0, cửa sổ, min(rate_locked, ρ), min(N, 6)). L_lent = 0: két
  // ScheduleGen không đọc két Wakeme (§6.4, chủ dự án chốt 2026-09-30).
  const horizon = min2(L, SCHEDULE_SCALE_HORIZON_CAP);
  const mPerEpoch = amountByLamp(lambda, 0n, window, min2(rateLockedQ, rho), horizon);
  if (mPerEpoch <= 0n)
    throw new Error(`GEN-SCH-GEN-ZERO: M_i = 0 (λ=${lambda}, ρ=${rho}) — không có hợp đồng cấp 0.`);
  const usageFactorLockedQ = usageFactorQ(window);

  // Shard GB của két bị TRỪ `M × min(N, buffer_ep)`.
  const shardId = computeShardId(d.owner);
  if (inp.gbShardIn.shard_id !== BigInt(shardId))
    throw new Error(`GEN-SCH-GB: shard GB mang shard_id ${inp.gbShardIn.shard_id}, két thuộc shard ${shardId}`);
  const gbDraw = mPerEpoch * min2(L, BUFFER_EP);
  const gbShardOut = gbShardAfterDraw(
    inp.gbShardIn, inp.gbBeacon, inp.gbShardCapNanogic ?? GB_SHARD_CAP_NANOGIC, gbDraw);
  // Vế két `reset_amount ≤ ⌊GB/16⌋` (nhánh đặt lại) tự thoả: `gbShardAfterDraw` đặt
  // `reset = min(⌊GB/16⌋, cap)`.

  // Trần mỗi-két-mỗi-epoch (`gb_vault_share_q`); lượng đã rút SUY RA từ datum.
  const drawn = drawnInEpoch(d.gen_schedules, e);
  const vaultShare = gbVaultShare(gbShardOut.reset_amount);
  if (drawn + gbDraw > vaultShare)
    throw new Error(
      `GEN-SCH-GB-VAULT-SHARE: két đã rút ${drawn} trong epoch ${e}, thêm ${gbDraw} vượt trần ` +
      `${vaultShare} (⌊reset_amount × gb_vault_share_q / Q⌋).`);
  const obligation = mPerEpoch * L;

  // Shard LAMP tổng hợp (C-SCH-CAP + cổng κ TẠM).
  const s = inp.shardIn;
  if (s.shard_id !== BigInt(shardId))
    throw new Error(`GEN-SCH-008: shard LAMP mang shard_id ${s.shard_id}, két thuộc shard ${shardId}`);
  if (s.shard_cap !== SHARD_CAP)
    throw new Error(`GEN-SCH-006: shard_cap ${s.shard_cap} ≠ hằng ${SHARD_CAP}`);
  if (s.shard_locked_lamp + totalLock > s.shard_cap)
    throw new Error(`GEN-SCH-006: Shard cap exceeded. shard_locked=${s.shard_locked_lamp}, adding=${totalLock}, cap=${s.shard_cap}`);
  const obligationOut = s.shard_obligation_nanogic + obligation;
  if (obligationOut > SCHEDULE_OBLIGATION_CAP_PER_SHARD)
    throw new Error(
      `GEN-SCH-KAPPA: nghĩa vụ shard ${s.shard_obligation_nanogic} + ${obligation} vượt trần κ TẠM ` +
      `${SCHEDULE_OBLIGATION_CAP_PER_SHARD} (SPEC §6.4).`);
  const shardOut: ScheduleShardDatum = {
    ...s,
    shard_locked_lamp:          s.shard_locked_lamp + totalLock,
    shard_active_count:         s.shard_active_count + 1n,
    shard_cumulative_committed: s.shard_cumulative_committed + totalLock,
    last_updated_epoch:         e,
    shard_obligation_nanogic:   obligationOut,
  };

  const newSchedule: GenSchedule = {
    schedule_id:            computeRefIndexId(inp.vaultRef, BigInt(d.gen_schedules.length)),
    commit_epoch:           e,
    start_fire_epoch:       e + SCHEDULE_DELAY,
    end_fire_epoch:         e + L + 1n,
    schedule_length:        L,
    lamp_per_epoch:         lambda,
    rate_locked_q:          rateLockedQ,
    baseline_at_commit_q:   SNAPSHOT_BASE_RATE_Q,
    multiplier_at_commit_q: sQ,
    fired_count:            0n,
    auto_burn_target:       null,
    m_per_epoch:            mPerEpoch,
    usage_factor_locked_q:  usageFactorLockedQ,
  };

  const newHoldings = selectLampForLock(d.loyalty_holdings, totalLock);
  assertHoldingCapAfterCommit(newHoldings.length, "planScheduleCommit");

  const vaultDatumOut: VaultDatum = {
    ...d,
    lamp_locked:        d.lamp_locked + totalLock,
    loyalty_holdings:   newHoldings,
    gen_schedules:      [...d.gen_schedules, newSchedule],
    last_updated_epoch: e,
    // Ký không sinh batch ⟹ không cộng `generated`; chỉ dịch cửa sổ.
    usage_window:       window,
    usage_window_epoch: e,
  };
  // C-SCH-LOCKSUM (#132): gương `validate_commit` ▸ `sum_locked(output.loyalty_holdings)`.
  assertLockSumMatches(vaultDatumOut.loyalty_holdings, vaultDatumOut.lamp_locked, "planScheduleCommit");

  return {
    shardId, totalLock, sQ, rateLockedQ, rhoEffectiveQ: rho, mPerEpoch, usageFactorLockedQ,
    gbDraw, obligation, newSchedule, vaultDatumOut, shardOut, gbShardOut,
  };
}

// ══════════════════════════════════════════════════════════════
// Nhánh BẮN — gương `validate_fire`. KHÔNG đọc beacon (CC-GEN-SCHEDULE-FIXED).
// ══════════════════════════════════════════════════════════════

export interface FirePlanInput {
  vaultDatum   : VaultDatum;
  vaultRef     : VaultOutRef;
  scheduleId   : string;
  currentEpoch : bigint;
  shardIn      : ScheduleShardDatum;
}

export interface FirePlan {
  shardId           : number;
  firesInTx         : number;
  /** `m_per_epoch` đã chốt lúc ký — KHÔNG tính lại. */
  mPerEpoch         : bigint;
  lampReleased      : bigint;
  /** Epoch danh nghĩa của lượt đầu trong tx này (`start + fired_count`). */
  firstNominalEpoch : bigint;
  newBatches        : MagicBatch[];
  scheduleComplete  : boolean;
  vaultDatumOut     : VaultDatum;
  shardOut          : ScheduleShardDatum;
}

export function planScheduleFire(inp: FirePlanInput): FirePlan {
  const { vaultDatum: d, scheduleId, currentEpoch: e } = inp;

  const sched = d.gen_schedules.find(s => s.schedule_id === scheduleId);
  if (!sched) throw new Error(`Schedule ${scheduleId} not found`);

  // §4.2: thu rác TRƯỚC khi đếm, và chỉ một lần (bản vá ngõ cụt 32 batch chết).
  const liveBatches = d.magic_batches.filter(b => !isExpired(b.created_epoch, b.decay_window, e));
  const firesInTx = countEligibleFires(
    sched.start_fire_epoch, sched.fired_count, sched.schedule_length, e, liveBatches.length);
  if (firesInTx === 0)
    throw new Error(`No eligible fires: next fire at epoch ${sched.start_fire_epoch + sched.fired_count}, current=${e}`);

  const mPerEpoch = sched.m_per_epoch;
  const lampReleased = BigInt(firesInTx) * sched.lamp_per_epoch;

  // BẮN BÙ (SPEC §6.1.2): lượt j mang epoch danh nghĩa `first + j`, batch sinh ở đúng
  // epoch đó. Lượt bù cho epoch đã qua ⟹ batch chết lúc sinh (không tiêu được).
  const firstNominalEpoch = sched.start_fire_epoch + sched.fired_count;
  const newBatches: MagicBatch[] = Array.from({ length: firesInTx }, (_, j) => ({
    batch_id:            computeRefIndexId(inp.vaultRef, d.next_batch_index + BigInt(j)),
    source:              "Schedule" as const,
    created_epoch:       firstNominalEpoch + BigInt(j),
    initial_amount:      mPerEpoch,
    current_amount:      mPerEpoch,
    decay_window:        SCHEDULE_DECAY_WINDOW,
    profile_at_creation: null,
    contract_id:         scheduleId,
    halved:              false,
  }));
  // Cửa sổ: `generated` của lượt j vào ô `e − e_j` (bỏ nếu ≥ 7).
  const windowOut = addFiresToWindow(
    shiftWindow(d.usage_window, d.usage_window_epoch, e), e - firstNominalEpoch, firesInTx, mPerEpoch);

  const updatedBatches = [...liveBatches, ...newBatches];
  if (updatedBatches.length > MAX_BATCHES_PER_VAULT)
    throw new Error(`GEN-VAULT-001: would exceed ${MAX_BATCHES_PER_VAULT} batches`);

  const newFired = sched.fired_count + BigInt(firesInTx);
  const scheduleComplete = newFired === sched.schedule_length;
  const updatedSchedules = scheduleComplete
    ? d.gen_schedules.filter(s => s.schedule_id !== scheduleId)
    : d.gen_schedules.map(s => s.schedule_id === scheduleId ? { ...s, fired_count: newFired } : s);

  // I-ACT-7: GIẢI KHOÁ, không chuyển LAMP.
  const newHoldings = unlockLockedAmount(d.loyalty_holdings, lampReleased);
  if (newHoldings.length > MAX_LOYALTY_HOLDINGS)
    throw new Error(`GEN-SCH-007: fire would leave ${newHoldings.length} holdings > ${MAX_LOYALTY_HOLDINGS}`);

  const shardId = computeShardId(d.owner);
  const s = inp.shardIn;
  if (s.shard_id !== BigInt(shardId))
    throw new Error(`GEN-SCH-008: shard LAMP mang shard_id ${s.shard_id}, két thuộc shard ${shardId}`);
  if (s.shard_cap !== SHARD_CAP)
    throw new Error(`GEN-SCH-006: shard_cap ${s.shard_cap} ≠ hằng ${SHARD_CAP}`);
  const lockedOut = s.shard_locked_lamp - lampReleased;
  if (lockedOut < 0n)
    throw new Error(`GEN-SCH-009: shard_locked_lamp sẽ âm (${lockedOut})`);
  const obligationOut = s.shard_obligation_nanogic - mPerEpoch * BigInt(firesInTx);
  if (obligationOut < 0n)
    throw new Error(`GEN-SCH-KAPPA: shard_obligation_nanogic sẽ âm (${obligationOut})`);
  const shardOut: ScheduleShardDatum = {
    ...s,
    shard_locked_lamp:        lockedOut,
    shard_cumulative_fired:   s.shard_cumulative_fired + lampReleased,
    shard_active_count:       scheduleComplete ? s.shard_active_count - 1n : s.shard_active_count,
    last_updated_epoch:       e,
    shard_obligation_nanogic: obligationOut,
  };

  const vaultDatumOut: VaultDatum = {
    ...d,
    lamp_locked:        d.lamp_locked - lampReleased,
    loyalty_holdings:   newHoldings,
    magic_batches:      updatedBatches,
    next_batch_index:   d.next_batch_index + BigInt(firesInTx),
    gen_schedules:      updatedSchedules,
    last_updated_epoch: e,
    usage_window:       windowOut,
    usage_window_epoch: e,
  };
  // C-SCH-LOCKSUM (#132): gương `validate_fire` ▸ `sum_locked(output.loyalty_holdings)`.
  assertLockSumMatches(vaultDatumOut.loyalty_holdings, vaultDatumOut.lamp_locked, "planScheduleFire");

  return {
    shardId, firesInTx, mPerEpoch, lampReleased, firstNominalEpoch, newBatches,
    scheduleComplete, vaultDatumOut, shardOut,
  };
}
