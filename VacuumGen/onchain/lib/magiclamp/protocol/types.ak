// lib/types.ak — GenMAGIC v3.3 Data Structures
// Normative: §4.1 MagicBatch, §5 VaultDatum
// All field names and ordering must match on-chain encoding exactly.

// ── Primitive alias ──────────────────────────────────────────
pub type Natural = Int

// ── Batch source (constructor index = Plutus Data tag) ──────
// Snapshot=0, Instant=1, Vacuum=2, Schedule=3
pub type BatchSource {
  Snapshot   // constr 0
  Instant    // constr 1
  Vacuum     // constr 2
  Schedule   // constr 3
}

// ── Activity profile (constructor index) ────────────────────
// Ember=0, Flame=1, Lantern=2
pub type ActivityProfile {
  Ember    // constr 0
  Flame    // constr 1
  Lantern  // constr 2
}

// ── §4.1 MagicBatch ─────────────────────────────────────────
// decay_window: Ember=3, Flame=6, Lantern=9, Instant=2, Vacuum=1, Schedule=1
// NORMATIVE: field order must not change (breaks on-chain encoding).
pub type MagicBatch {
  batch_id            : ByteArray,                   // blake2b256(utxo_ref ∥ index)
  source              : BatchSource,
  created_epoch       : Natural,
  initial_amount      : Natural,                     // immutable audit trail
  current_amount      : Natural,                     // mutable
  decay_window        : Natural,
  profile_at_creation : Option<ActivityProfile>,     // Some(P) Snapshot; None others (C-DECAY-4)
  contract_id         : Option<ByteArray>,           // Some for Schedule; None others
  halved              : Bool,                        // Instant only; False→True one-way (T22)
}

// ── LoyaltyHolding ──────────────────────────────────────────
pub type LoyaltyHolding {
  amount         : Natural,
  acquired_epoch : Natural,   // immutable after creation (T21, C-HOLDING-2)
  is_locked      : Bool,
}

// ── VacuumOrder ─────────────────────────────────────────────
pub type VacuumOrder {
  order_id     : ByteArray,
  commit_epoch : Natural,
  fire_epoch   : Natural,     // = commit_epoch + 2
  lamp_amount  : Natural,
}

// ── AutoBurnConfig ──────────────────────────────────────────
pub type AutoBurnConfig {
  delegate          : ByteArray,          // VerificationKeyHash
  target_app_id     : Option<ByteArray>,
  max_burn_per_fire : Natural,
}

// ── GenSchedule ─────────────────────────────────────────────
pub type GenSchedule {
  schedule_id              : ByteArray,
  commit_epoch             : Natural,
  start_fire_epoch         : Natural,    // = commit_epoch + 2
  end_fire_epoch           : Natural,    // = commit_epoch + L + 1
  schedule_length          : Natural,    // L
  lamp_per_epoch           : Natural,    // λ
  rate_locked_q            : Natural,    // immutable (T8)
  baseline_at_commit_q     : Natural,    // R_snap_c (audit)
  multiplier_at_commit_q   : Natural,    // S_Q(L) (audit)
  fired_count              : Natural,
  auto_burn_target         : Option<AutoBurnConfig>,
}

// ── AppAllocation ───────────────────────────────────────────
pub type AppAllocation {
  app_id     : ByteArray,
  weight_bps : Natural,       // C-DC-2: ≥ 100; C-DC-3: Σ ≤ 10000
}

// ── PendingAllocations ──────────────────────────────────────
pub type PendingAllocations {
  allocations      : List<AppAllocation>,
  effective_epoch  : Natural,
}

// ── DelegationCertificate ───────────────────────────────────
pub type DelegationCertificate {
  current                  : List<AppAllocation>,    // C-DC-1: |current| ≤ 5
  pending                  : Option<PendingAllocations>,
  current_effective_epoch  : Natural,
  last_changed_epoch       : Natural,
}

// ── PendingProfile ──────────────────────────────────────────
pub type PendingProfile {
  new_profile      : ActivityProfile,
  effective_epoch  : Natural,
}

// ── VaultAttribution ────────────────────────────────────────
pub type VaultAttribution {
  attribution_root  : ByteArray,    // blake2b256 hash chain (§7.2)
  last_event_epoch  : Natural,
  total_events      : Natural,      // C-ATT-2: strictly increasing
}

// ── ActivityState ───────────────────────────────────────────
pub type ActivityState {
  recent_burn_epochs : List<(ByteArray, Natural)>,   // (app_id, epoch)
  total_burns_count  : Natural,
}

// ── StreakState ──────────────────────────────────────────────
pub type StreakState {
  current_streak    : Natural,
  last_active_epoch : Natural,
}

// ── §5.1 VaultDatum (full) ───────────────────────────────────
// worst-case ~12KB; tx limit 16KB (§5.1 Datum size note)
pub type VaultDatum {
  owner                 : ByteArray,               // VerificationKeyHash
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

// ── UM Datum ─────────────────────────────────────────────────
pub type UMDatum {
  smoothed_q         : Natural,      // clamp([UM_MIN_Q, UM_MAX_Q])
  last_updated_epoch : Natural,
  history            : List<Natural>,
}

// ── Vault redeemer ───────────────────────────────────────────
pub type VaultRedeemer {
  // VacuumCommit: lock λ oil for fire in 2 epochs (§10.1 Phase 1)
  VacuumCommit { lambda: Natural }
  // VacuumFire: permissionless fire by order_id (§10.1 Phase 2)
  VacuumFire   { order_id: ByteArray }

  // Shared redeemers (other modules)
  InstantGen   { lamp_paid: Natural }
  ApplyHalving
  BurnBatch     { burns: List<(ByteArray, Natural)> }
  UpdateProfile { new_profile: ActivityProfile }
}
