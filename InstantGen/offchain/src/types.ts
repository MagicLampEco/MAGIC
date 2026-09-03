// src/types.ts — TypeScript mirror of Aiken types + Lucid Evolution Data schemas
// Constructor indices must match Aiken type ordering (Plutus Data encoding).

import { Data } from "@lucid-evolution/lucid";

// ── Primitive ────────────────────────────────────────────────
export type Natural = bigint;

// ── BatchSource ──────────────────────────────────────────────
// Constr 0=Snapshot, 1=Instant, 2=Vacuum, 3=Schedule
export type BatchSource = "Snapshot" | "Instant" | "Vacuum" | "Schedule";

export const BatchSourceSchema = Data.Enum([
  Data.Literal("Snapshot"),   // constr 0
  Data.Literal("Instant"),    // constr 1
  Data.Literal("Vacuum"),     // constr 2
  Data.Literal("Schedule"),   // constr 3
]);

// ── ActivityProfile ──────────────────────────────────────────
// Constr 0=Ember, 1=Flame, 2=Lantern
export type ActivityProfile = "Ember" | "Flame" | "Lantern";

export const ActivityProfileSchema = Data.Enum([
  Data.Literal("Ember"),    // constr 0
  Data.Literal("Flame"),    // constr 1
  Data.Literal("Lantern"),  // constr 2
]);

// ── MagicBatch ───────────────────────────────────────────────
export const MagicBatchSchema = Data.Object({
  batch_id            : Data.Bytes(),
  source              : BatchSourceSchema,
  created_epoch       : Data.Integer(),
  initial_amount      : Data.Integer(),
  current_amount      : Data.Integer(),
  decay_window        : Data.Integer(),
  profile_at_creation : Data.Nullable(ActivityProfileSchema),
  contract_id         : Data.Nullable(Data.Bytes()),
  halved              : Data.Boolean(),
});
export type MagicBatch = Data.Static<typeof MagicBatchSchema>;

// ── LoyaltyHolding ───────────────────────────────────────────
export const LoyaltyHoldingSchema = Data.Object({
  amount         : Data.Integer(),
  acquired_epoch : Data.Integer(),
  is_locked      : Data.Boolean(),
});
export type LoyaltyHolding = Data.Static<typeof LoyaltyHoldingSchema>;

// ── VacuumOrder ──────────────────────────────────────────────
export const VacuumOrderSchema = Data.Object({
  order_id     : Data.Bytes(),
  commit_epoch : Data.Integer(),
  fire_epoch   : Data.Integer(),
  lamp_amount  : Data.Integer(),
});
export type VacuumOrder = Data.Static<typeof VacuumOrderSchema>;

// ── AutoBurnConfig ───────────────────────────────────────────
export const AutoBurnConfigSchema = Data.Object({
  delegate          : Data.Bytes(),
  target_app_id     : Data.Nullable(Data.Bytes()),
  max_burn_per_fire : Data.Integer(),
});
export type AutoBurnConfig = Data.Static<typeof AutoBurnConfigSchema>;

// ── GenSchedule ──────────────────────────────────────────────
export const GenScheduleSchema = Data.Object({
  schedule_id            : Data.Bytes(),
  commit_epoch           : Data.Integer(),
  start_fire_epoch       : Data.Integer(),
  end_fire_epoch         : Data.Integer(),
  schedule_length        : Data.Integer(),
  lamp_per_epoch         : Data.Integer(),
  rate_locked_q          : Data.Integer(),
  baseline_at_commit_q   : Data.Integer(),
  multiplier_at_commit_q : Data.Integer(),
  fired_count            : Data.Integer(),
  auto_burn_target       : Data.Nullable(AutoBurnConfigSchema),
});
export type GenSchedule = Data.Static<typeof GenScheduleSchema>;

// ── DelegationCertificate ────────────────────────────────────
export const AppAllocationSchema = Data.Object({
  app_id     : Data.Bytes(),
  weight_bps : Data.Integer(),
});
export type AppAllocation = Data.Static<typeof AppAllocationSchema>;

export const PendingAllocationsSchema = Data.Object({
  allocations     : Data.Array(AppAllocationSchema),
  effective_epoch : Data.Integer(),
});

export const DelegationCertificateSchema = Data.Object({
  current                 : Data.Array(AppAllocationSchema),
  pending                 : Data.Nullable(PendingAllocationsSchema),
  current_effective_epoch : Data.Integer(),
  last_changed_epoch      : Data.Integer(),
});
export type DelegationCertificate = Data.Static<typeof DelegationCertificateSchema>;

// ── PendingProfile ───────────────────────────────────────────
export const PendingProfileSchema = Data.Object({
  new_profile     : ActivityProfileSchema,
  effective_epoch : Data.Integer(),
});
export type PendingProfile = Data.Static<typeof PendingProfileSchema>;

// ── VaultAttribution ─────────────────────────────────────────
export const VaultAttributionSchema = Data.Object({
  attribution_root : Data.Bytes(),
  last_event_epoch : Data.Integer(),
  total_events     : Data.Integer(),
});
export type VaultAttribution = Data.Static<typeof VaultAttributionSchema>;

// ── ActivityState ────────────────────────────────────────────
// `consumed_credit` occupies the slot previously named `total_burns_count`
// (same position, same Integer type → Plutus Data shape unchanged).
// SEMANTICS (§6.3): nanogic ALREADY CONSUMED via BurnBatch and not yet turned
// into an InstantGen reward. BurnBatch adds Σburns; InstantGen zeroes it.
export const ActivityStateSchema = Data.Object({
  recent_burn_epochs : Data.Array(Data.Tuple([Data.Bytes(), Data.Integer()])),
  consumed_credit    : Data.Integer(),
});
export type ActivityState = Data.Static<typeof ActivityStateSchema>;

// ── StreakState ──────────────────────────────────────────────
export const StreakStateSchema = Data.Object({
  current_streak    : Data.Integer(),
  last_active_epoch : Data.Integer(),
});
export type StreakState = Data.Static<typeof StreakStateSchema>;

// ── VaultDatum ───────────────────────────────────────────────
export const VaultDatumSchema = Data.Object({
  owner                 : Data.Bytes(),
  lamp_balance          : Data.Integer(),
  lamp_locked           : Data.Integer(),
  loyalty_holdings      : Data.Array(LoyaltyHoldingSchema),
  magic_batches         : Data.Array(MagicBatchSchema),
  next_batch_index      : Data.Integer(),
  vacuum_orders         : Data.Array(VacuumOrderSchema),
  gen_schedules         : Data.Array(GenScheduleSchema),
  profile               : ActivityProfileSchema,
  profile_changed_epoch : Data.Integer(),
  pending_profile       : Data.Nullable(PendingProfileSchema),
  last_updated_epoch    : Data.Integer(),
  delegation_cert       : DelegationCertificateSchema,
  activity_state        : ActivityStateSchema,
  streak_state          : StreakStateSchema,
  personal_delegate     : Data.Nullable(Data.Bytes()),
  attribution           : VaultAttributionSchema,
});
export type VaultDatum = Data.Static<typeof VaultDatumSchema>;

// ── UMDatum ──────────────────────────────────────────────────
export const UMDatumSchema = Data.Object({
  smoothed_q         : Data.Integer(),
  last_updated_epoch : Data.Integer(),
  history            : Data.Array(Data.Integer()),
});
export type UMDatum = Data.Static<typeof UMDatumSchema>;

// ── BackingBeaconDatum (§6.3)  [CẦN XÁC NHẬN — chờ CARP] ─────
// Reference-input beacon carrying the backing ratio br = B/S. Field order must
// match types.ak: BackingBeaconDatum exactly.
//
// The deployed CARP `GlobalState` (twap/spot/breaker/nsf/valid_until) is a
// CDP-pricing datum and does NOT carry br_q — it cannot serve as this beacon.
export const BackingBeaconDatumSchema = Data.Object({
  br_q               : Data.Integer(),   // ⌊B/S × Q⌋
  magic_supply       : Data.Integer(),   // S — effective MAGIC supply (nanogic)
  depeg              : Data.Boolean(),   // true ⟹ cap = 0
  last_updated_epoch : Data.Integer(),
});
export type BackingBeaconDatum = Data.Static<typeof BackingBeaconDatumSchema>;

// ── VaultRedeemer ────────────────────────────────────────────
// Constructor index = Aiken enum order (types.ak). MUST stay in lockstep:
//   0 InstantGen, 1 PruneExpired, 2 BurnBatch, 3 UpdateProfile,
//   4 WithdrawLamp, 5 SetDelegate.
//
// constr 2 = BurnBatch is the LOCKED cross-repo interface (ConsumeMAGIC
// CONTRACT.md v2, spec §11 `burn_batch_constr` = 2). Do not move it.
//
// constr 1 was `ApplyHalving`; halving no longer exists under the §4.2 cliff,
// so the (nullary, therefore encoding-identical) slot now carries the §7.4
// permissionless dead-batch collector.
export const VaultRedeemerSchema = Data.Enum([
  Data.Object({ InstantGen: Data.Object({ claimed_amount: Data.Integer() }) }), // constr 0
  Data.Literal("PruneExpired"),                                                 // constr 1
  Data.Object({ BurnBatch: Data.Object({                                      // constr 2
    burns: Data.Array(Data.Tuple([Data.Bytes(), Data.Integer()])),
  })}),
  Data.Object({ UpdateProfile: Data.Object({                                  // constr 3
    new_profile: ActivityProfileSchema,
  })}),
  Data.Object({ WithdrawLamp: Data.Object({                                   // constr 4
    amount: Data.Integer(),
  })}),
  Data.Object({ SetDelegate: Data.Object({                                    // constr 5
    new_delegate: Data.Nullable(Data.Bytes()),
  })}),
]);
export type VaultRedeemer = Data.Static<typeof VaultRedeemerSchema>;

// ── Codec companions ─────────────────────────────────────────
// `Data.to`/`Data.from` infer their result from the SECOND argument, so that
// argument must be a VALUE whose TypeScript type is the plain static shape —
// not the schema object itself. Passing `XxxSchema` directly makes the call
// return `TObject<…>` and every field access below it goes untyped.
//
// These aliases are the lucid-evolution idiom: same name as the type, so call
// sites read `Data.from(utxo.datum!, VaultDatum)`. Runtime value is unchanged —
// it is the very same schema object, only its static type is re-branded.
export const VaultDatum          = VaultDatumSchema          as unknown as VaultDatum;
export const UMDatum             = UMDatumSchema             as unknown as UMDatum;
export const BackingBeaconDatum  = BackingBeaconDatumSchema  as unknown as BackingBeaconDatum;
export const VaultRedeemer       = VaultRedeemerSchema       as unknown as VaultRedeemer;
