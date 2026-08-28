// MagicSDK/src/schemas.ts — Plutus Data schemas (must mirror Aiken types exactly)
// Field order = constructor index. Renaming a field is OK; reordering BREAKS the contract.
//
// P8 invariant: this schema must produce the same CBOR as Aiken's
// `pub type VaultDatum { ... }` definition in
// `<Module>/onchain/lib/magiclamp/protocol/types.ak`.
//
// Mọi loại vault dùng CHUNG một VaultDatum — chỉ code validator (và do đó địa
// chỉ vault theo network) là khác.
//
// ══ BIA MỘ — ĐỪNG XOÁ `Snapshot` / `Vacuum` Ở TỆP NÀY ══════════════════════
// `VaultType` (types.ts) đã thu về "Instant" | "Schedule" vì SnapshotGen và
// VacuumGen dời sang `Legacy/`. Tệp NÀY thì KHÔNG được thu theo:
//   - `BatchSource` (variant Snapshot=0, Instant=1, Vacuum=2, Schedule=3), và
//   - trường `vacuum_orders` trong `VaultDatum`
// là CHỈ SỐ CONSTRUCTOR / ARITY của Plutus Data ĐÃ LÊN CHAIN. Bỏ một variant
// làm dịch chỉ số của các variant sau nó; bỏ một trường làm lệch arity — cả hai
// đều vỡ decode MỌI vault đã tạo, và LAMP trong đó thành không tiêu được.
// Muốn bỏ thật thì phải migrate on-chain, không phải sửa tệp này.
// ═══════════════════════════════════════════════════════════════════════════

import { Data } from "@lucid-evolution/lucid";

const LoyaltyHoldingSchema = Data.Object({
  amount:         Data.Integer(),
  acquired_epoch: Data.Integer(),
  is_locked:      Data.Boolean(),
});

const MagicBatchSchema = Data.Object({
  batch_id:            Data.Bytes(),
  source:              Data.Enum([
    Data.Literal("Snapshot"),
    Data.Literal("Instant"),
    Data.Literal("Vacuum"),
    Data.Literal("Schedule"),
  ]),
  created_epoch:       Data.Integer(),
  initial_amount:      Data.Integer(),
  current_amount:      Data.Integer(),
  decay_window:        Data.Integer(),
  profile_at_creation: Data.Nullable(Data.Enum([
    Data.Literal("Ember"), Data.Literal("Flame"), Data.Literal("Lantern"),
  ])),
  contract_id:         Data.Nullable(Data.Bytes()),
  halved:              Data.Boolean(),
});

const VacuumOrderSchema = Data.Object({
  order_id:     Data.Bytes(),
  commit_epoch: Data.Integer(),
  fire_epoch:   Data.Integer(),
  lamp_amount:  Data.Integer(),
});

const GenScheduleSchema = Data.Object({
  schedule_id:              Data.Bytes(),
  commit_epoch:             Data.Integer(),
  start_fire_epoch:         Data.Integer(),
  end_fire_epoch:           Data.Integer(),
  schedule_length:          Data.Integer(),
  lamp_per_epoch:           Data.Integer(),
  rate_locked_q:            Data.Integer(),
  baseline_at_commit_q:     Data.Integer(),
  multiplier_at_commit_q:   Data.Integer(),
  fired_count:              Data.Integer(),
  auto_burn_target:         Data.Nullable(Data.Object({
    delegate:          Data.Bytes(),
    target_app_id:     Data.Nullable(Data.Bytes()),
    max_burn_per_fire: Data.Integer(),
  })),
});

const ActivityProfileSchema = Data.Enum([
  Data.Literal("Ember"), Data.Literal("Flame"), Data.Literal("Lantern"),
]);

const PendingProfileSchema = Data.Object({
  new_profile:     ActivityProfileSchema,
  effective_epoch: Data.Integer(),
});

const DelegationCertificateSchema = Data.Object({
  current: Data.Array(Data.Object({
    app_id:     Data.Bytes(),
    weight_bps: Data.Integer(),
  })),
  pending: Data.Nullable(Data.Object({
    allocations:     Data.Array(Data.Object({
      app_id:     Data.Bytes(),
      weight_bps: Data.Integer(),
    })),
    effective_epoch: Data.Integer(),
  })),
  current_effective_epoch: Data.Integer(),
  last_changed_epoch:      Data.Integer(),
});

// NOTE (PHA 2): InstantGen and ScheduleGen renamed the second field to
// `consumed_credit` — nanogic actually consumed via BurnBatch, the base for the
// §6.3 InstantGen reward. Same POSITION and same Integer type, so the Plutus
// Data encoding is identical and this schema stays wire-compatible. The name
// here is kept as `total_burns_count` because Consolidate / ProfileChange still
// use that label on their side (SnapshotGen / VacuumGen dùng nhãn đó trước khi
// sang Legacy — đổi tên ở đây chỉ tổ làm lệch nhãn giữa các module còn sống).
const ActivityStateSchema = Data.Object({
  recent_burn_epochs: Data.Array(Data.Tuple([Data.Bytes(), Data.Integer()])),
  total_burns_count:  Data.Integer(),
});

const StreakStateSchema = Data.Object({
  current_streak:    Data.Integer(),
  last_active_epoch: Data.Integer(),
});

const VaultAttributionSchema = Data.Object({
  attribution_root: Data.Bytes(),
  last_event_epoch: Data.Integer(),
  total_events:     Data.Integer(),
});

/** Full VaultDatum schema — used to serialize the initial datum at vault creation
 *  and to decode existing vault UTxOs in downstream builders (Instant/Schedule). */
export const VaultDatumSchema = Data.Object({
  owner:                 Data.Bytes(),
  lamp_balance:          Data.Integer(),
  lamp_locked:           Data.Integer(),
  loyalty_holdings:      Data.Array(LoyaltyHoldingSchema),
  magic_batches:         Data.Array(MagicBatchSchema),
  next_batch_index:      Data.Integer(),
  vacuum_orders:         Data.Array(VacuumOrderSchema),
  gen_schedules:         Data.Array(GenScheduleSchema),
  profile:               ActivityProfileSchema,
  profile_changed_epoch: Data.Integer(),
  pending_profile:       Data.Nullable(PendingProfileSchema),
  last_updated_epoch:    Data.Integer(),
  delegation_cert:       DelegationCertificateSchema,
  activity_state:        ActivityStateSchema,
  streak_state:          StreakStateSchema,
  personal_delegate:     Data.Nullable(Data.Bytes()),
  attribution:           VaultAttributionSchema,
});

export type VaultDatum = ReturnType<typeof Data.from<typeof VaultDatumSchema>>;

// ── VaultIdRedeemer — redeemer của handler `mint` trên chính validator vault ──
//
// Nguồn (ĐỌC, đừng nhớ): `pub type VaultIdRedeemer` trong
//   InstantGen/onchain/validators/vault.ak  (và bản song sinh ở ScheduleGen)
//     MintVaultId { seed: OutputReference }   → constructor 0
//     BurnVaultId                             → constructor 1
// Thứ tự khai báo = chỉ số constructor. Đảo một biến thể bên Aiken mà không đảo
// ở đây ⇒ tx mint bị validator đọc thành BurnVaultId và fail.
const OutputReferenceSchema = Data.Object({
  transaction_id: Data.Bytes(),   // 32 byte
  output_index:   Data.Integer(),
});

export const VaultIdRedeemerSchema = Data.Enum([
  Data.Object({ MintVaultId: Data.Object({ seed: OutputReferenceSchema }) }),
  Data.Literal("BurnVaultId"),
]);

export type VaultIdRedeemer = ReturnType<typeof Data.from<typeof VaultIdRedeemerSchema>>;
