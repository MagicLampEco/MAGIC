// lib/types.ak — GenMAGIC v3.3 Data Types (ScheduleGen)
// Extends shared protocol types with shard-specific types.

pub type Natural = Int

pub type BatchSource {
  Snapshot   // constr 0
  Instant    // constr 1
  Vacuum     // constr 2
  Schedule   // constr 3
}

pub type ActivityProfile {
  Ember    // constr 0
  Flame    // constr 1
  Lantern  // constr 2
}

// §4.2 per-epoch use-or-lose: decay_window = 1 for EVERY source. A batch is
// live only inside its own `created_epoch`; at created_epoch + 1 it is DEAD.
pub type MagicBatch {
  batch_id            : ByteArray,
  source              : BatchSource,
  created_epoch       : Natural,   // the ONLY epoch this batch is live
  initial_amount      : Natural,
  current_amount      : Natural,
  decay_window        : Natural,   // = 1 (§4.2)
  profile_at_creation : Option<ActivityProfile>,
  contract_id         : Option<ByteArray>,        // Some(schedule_id) for Schedule
  halved              : Bool,      // DEAD FIELD — always False under the cliff
                                   // model; kept for Plutus Data compatibility
}

pub type LoyaltyHolding {
  amount         : Natural,
  acquired_epoch : Natural,
  is_locked      : Bool,
}

pub type VacuumOrder {
  order_id     : ByteArray,
  commit_epoch : Natural,
  fire_epoch   : Natural,
  lamp_amount  : Natural,
}

pub type AutoBurnConfig {
  delegate          : ByteArray,
  target_app_id     : Option<ByteArray>,
  max_burn_per_fire : Natural,
}

// ── §5.4 GenSchedule ─────────────────────────────────────────
pub type GenSchedule {
  schedule_id              : ByteArray,
  commit_epoch             : Natural,
  start_fire_epoch         : Natural,    // = commit_epoch + 2
  end_fire_epoch           : Natural,    // = commit_epoch + L + 1
  schedule_length          : Natural,    // L ∈ [10,200]
  lamp_per_epoch           : Natural,    // λ
  rate_locked_q            : Natural,    // immutable (T8)
  baseline_at_commit_q     : Natural,    // R_snap_c (audit)
  multiplier_at_commit_q   : Natural,    // S_Q(L) (audit)
  fired_count              : Natural,    // 0..L
  auto_burn_target         : Option<AutoBurnConfig>,
}

// ── §5.5 ScheduleAggregateShardDatum ─────────────────────────
pub type ScheduleAggregateShardDatum {
  shard_id                   : Natural,   // 0..15
  shard_locked_lamp          : Natural,   // current locked (oildrop)
  shard_active_count         : Natural,   // active schedules
  shard_cumulative_committed : Natural,
  shard_cumulative_fired     : Natural,
  last_updated_epoch         : Natural,
  shard_cap                  : Natural,   // 4.5×10^14 oildrop
}

pub type AppAllocation { app_id: ByteArray, weight_bps: Natural }

pub type PendingAllocations {
  allocations: List<AppAllocation>, effective_epoch: Natural,
}

pub type DelegationCertificate {
  current                 : List<AppAllocation>,
  pending                 : Option<PendingAllocations>,
  current_effective_epoch : Natural,
  last_changed_epoch      : Natural,
}

pub type PendingProfile { new_profile: ActivityProfile, effective_epoch: Natural }

pub type VaultAttribution {
  attribution_root : ByteArray,
  last_event_epoch : Natural,
  total_events     : Natural,
}

// `consumed_credit` occupies the slot previously named `total_burns_count`
// (same position, same type Natural → Plutus Data shape unchanged).
// SEMANTICS (§6.3 keyed-consumed): running total of MAGIC (nanogic) the owner
// has ACTUALLY CONSUMED via BurnBatch and not yet converted into an InstantGen
// reward. BurnBatch adds Σburns here; only InstantGen (in the InstantGen vault)
// spends it. Kept identical in both vault types so the datum stays portable.
// 🔴 VA CHẠM HAI NHÁNH — Nợ #39. Trường THỨ HAI của kiểu này mang HAI NGHĨA
// KHÁC NHAU trên cùng một ô byte:
//     origin/main : total_burns_count : Natural   — ĐẾM số lượt burn
//     nhánh này   : consumed_credit   : Natural   — nanogic đã tiêu, chưa quy thưởng
// Cùng vị trí, cùng kiểu, CÙNG HÌNH DẠNG Plutus Data ⇒ decode KHÔNG BAO GIỜ báo lỗi.
// Off-chain viết theo main ghi số ĐẾM vào ô mà InstantGen nhánh này đọc là NGÂN SÁCH
// THƯỞNG. Spec im lặng hoàn toàn về ActivityState ở CẢ HAI bản, nên không có trọng tài.
// Hoà hai nhánh theo tên trường sẽ im lặng đổi nghĩa dữ liệu đã nằm trên chuỗi.
// Đây là quyết định của chủ nhân, không phải việc sửa được bằng đổi tên.
pub type ActivityState {
  recent_burn_epochs : List<(ByteArray, Natural)>,
  consumed_credit    : Natural,
}

pub type StreakState {
  current_streak    : Natural,
  last_active_epoch : Natural,
}

pub type VaultDatum {
  owner                 : ByteArray,
  lamp_balance          : Natural,
  lamp_locked           : Natural,
  loyalty_holdings      : List<LoyaltyHolding>,
  magic_batches         : List<MagicBatch>,
  next_batch_index      : Natural,
  vacuum_orders         : List<VacuumOrder>,
  gen_schedules         : List<GenSchedule>,
  profile               : ActivityProfile,
  profile_changed_epoch : Natural,
  pending_profile       : Option<PendingProfile>,
  last_updated_epoch    : Natural,
  delegation_cert       : DelegationCertificate,
  activity_state        : ActivityState,
  streak_state          : StreakState,
  personal_delegate     : Option<ByteArray>,
  attribution           : VaultAttribution,
}

// ── Vault Redeemer (ScheduleGen operations) ───────────────────
// NORMATIVE: append-only enum. New variants at END only.
pub type VaultRedeemer {
  // constr 0  Phase 1: User commits — locks L×λ LAMP, creates GenSchedule
  ScheduleCommit {
    schedule_length  : Natural,   // L ∈ [10,200]
    lamp_per_epoch   : Natural,   // λ (oildrop)
  }

  // constr 1  Phase 2: Fire — permissionless (C-SCH-FIRE-PERMISSION)
  // Fires up to 8 pending orders for a specific schedule.
  ScheduleFire {
    schedule_id  : ByteArray,
  }

  // constr 2  BurnBatch: datum-consume MAGIC (D1) — giảm current_amount của
  //           các batch theo `burns = [(batch_id, amount)]`. KHÔNG tx.mint,
  //           KHÔNG token. Auth: owner HOẶC personal_delegate (consume-delegate).
  BurnBatch { burns: List<(ByteArray, Natural)> }

  // constr 3  WithdrawLamp: withdraw unlocked LAMP back to wallet (SPEC_V1 §1)
  WithdrawLamp { amount: Natural }

  // constr 4  SetDelegate: owner đặt/đổi consume-delegate (personal_delegate).
  //           Tách concern khỏi commit/withdraw; KHÔNG cooldown (đổi rẻ).
  SetDelegate { new_delegate: Option<ByteArray> }
}

// ── Shard Redeemer ────────────────────────────────────────────
pub type ShardRedeemer {
  ShardUpdateCommit { delta_locked: Natural, delta_committed: Natural }
  ShardUpdateFire   { fires_in_tx: Natural,  lambda: Natural }
}
