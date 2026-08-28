// lib/magiclamp/protocol/types.ak — GenMAGIC v3.3 Data Types (shared)
//
// ── AUDIT FIX (Bug 1) ─────────────────────────────────────────────────────
// VaultDatum ở đây là bản ĐẦY ĐỦ (mirror SnapshotGen/onchain/.../types.ak),
// KHÔNG cắt ngắn. Validator vault_consolidate phải decode đúng MỌI field theo
// đúng thứ tự constructor, nếu không CBOR decode sẽ FAIL (vault kẹt) hoặc ví
// chủ có thể reset streak/profile/xoá batches (DRAIN). Đây là xương sống
// interface onchain ↔ offchain nên phải khớp tuyệt đối thứ tự field.

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

pub type MagicBatch {
  batch_id            : ByteArray,
  source              : BatchSource,
  created_epoch       : Natural,
  initial_amount      : Natural,
  current_amount      : Natural,
  decay_window        : Natural,
  profile_at_creation : Option<ActivityProfile>,
  contract_id         : Option<ByteArray>,
  halved              : Bool,
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

pub type GenSchedule {
  schedule_id              : ByteArray,
  commit_epoch             : Natural,
  start_fire_epoch         : Natural,
  end_fire_epoch           : Natural,
  schedule_length          : Natural,
  lamp_per_epoch           : Natural,
  rate_locked_q            : Natural,
  baseline_at_commit_q     : Natural,
  multiplier_at_commit_q   : Natural,
  fired_count              : Natural,
  auto_burn_target         : Option<AutoBurnConfig>,
}

pub type AutoBurnConfig {
  delegate          : ByteArray,
  target_app_id     : Option<ByteArray>,
  max_burn_per_fire : Natural,
}

pub type AppAllocation { app_id: ByteArray, weight_bps: Natural }

pub type PendingAllocations {
  allocations      : List<AppAllocation>,
  effective_epoch  : Natural,
}

pub type DelegationCertificate {
  current                  : List<AppAllocation>,
  pending                  : Option<PendingAllocations>,
  current_effective_epoch  : Natural,
  last_changed_epoch       : Natural,
}

pub type PendingProfile { new_profile: ActivityProfile, effective_epoch: Natural }

pub type VaultAttribution {
  attribution_root  : ByteArray,
  last_event_epoch  : Natural,
  total_events      : Natural,
}

// Trường thứ hai là TỔNG LƯỢNG nanogic đã tiêu, KHÔNG phải số lượt burn. Nhãn cũ
// `total_burns_count` nói sai đơn vị và đã bỏ (Nợ #39, chốt 2026-08-28). Đổi tên KHÔNG
// đụng hợp đồng nhị phân: Plutus Data mã hoá VỊ TRÍ, không mã hoá tên — cùng vị trí,
// cùng kiểu `Natural`, cùng hình dạng. Module này không bao giờ đọc NGHĨA của trường,
// nó chỉ bảo toàn nguyên `activity_state`.
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
