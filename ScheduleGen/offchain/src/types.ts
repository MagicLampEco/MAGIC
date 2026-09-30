// src/types.ts — TypeScript mirror of Aiken types + Lucid Evolution Data schemas
// Constructor indices must match Aiken type ordering (Plutus Data encoding).

import { Data, Constr } from "@lucid-evolution/lucid";

// ── Primitive ────────────────────────────────────────────────
export type Natural = bigint;

// ── Credential (chủ vault) ───────────────────────────────────
// Gương của `cardano/address/Credential` (blueprint, đối chiếu 2026-09-26):
//   VerificationKey(h) = Constr 0 [bytes 28]   Script(h) = Constr 1 [bytes 28]
// `Data.Static` của lược đồ này trùng kiểu `OwnerCredential` ở `@magiclamp/protocol-utils`.
export const OwnerCredentialSchema = Data.Enum([
  Data.Object({ VerificationKey: Data.Tuple([Data.Bytes({ minLength: 28, maxLength: 28 })]) }),
  Data.Object({ Script: Data.Tuple([Data.Bytes({ minLength: 28, maxLength: 28 })]) }),
]);
export type OwnerCredentialData = Data.Static<typeof OwnerCredentialSchema>;

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
  // ── Gen v2.0 (SPEC §6.1.4, `CC-GEN-SCHEDULE-FIXED`) — NỐI CUỐI, gương `types.ak` ──
  // `M_i` chốt MỘT lần lúc ký; fire chỉ đọc trường này (không đọc beacon).
  m_per_epoch            : Data.Integer(),
  // `usage_factor_q` của két lúc ký — kiểm toán, fire KHÔNG đọc lại.
  usage_factor_locked_q  : Data.Integer(),
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
// into an InstantGen reward. BurnBatch adds Σburns here.
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

// ── EpochUsage — một ô của `usage_window` (SPEC §6.1.2) ─────────────────────
// Gương `types.ak` ▸ `EpochUsage` (constr 0, hai trường, thứ tự `generated, consumed`).
// Kiểu TS thuần cùng hình dạng nằm ở `genFormula.ts` ▸ `EpochUsage` (bản chép có nhãn).
export const EpochUsageSchema = Data.Object({
  generated : Data.Integer(),
  consumed  : Data.Integer(),
});

// ── VaultDatum ───────────────────────────────────────────────
// Gen v2.0: 19 trường. Két đời trước (17 trường) KHÔNG di trú — v2.0 là hash mới;
// giải mã bằng `decodeVaultDatum`, nó NÉM rõ khi gặp datum 17 trường.
export const VaultDatumSchema = Data.Object({
  // Trường 0 — `Credential`. ConsumeMAGIC đọc đúng chỉ số này. Shard: `computeShardId`
  // băm 28 byte BÊN TRONG credential (gương `math.ak` ▸ `compute_shard_id`).
  owner                 : OwnerCredentialSchema,
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
  // ── Gen v2.0 (SPEC §6.1.2) — NỐI CUỐI: trường 17, 18 ⟹ 19 trường ──────────
  // InstantGen đặt hai trường này ở 18–19; mã dùng chung phải gom theo TÊN, không chỉ số.
  // Đúng 7 ô: ô 0 = epoch `usage_window_epoch` (đang mở), ô 1..6 = 6 epoch liền trước.
  usage_window          : Data.Array(EpochUsageSchema),
  usage_window_epoch    : Data.Integer(),
});
export type VaultDatum = Data.Static<typeof VaultDatumSchema>;

/** Số trường `VaultDatum` v2.0 (gương `types.ak` ▸ `VaultDatum`). */
export const VAULT_DATUM_FIELDS_V2 = 19;
/** Số trường của két đời trước Gen v2.0 — gặp số này thì NÉM, không đệm. */
export const VAULT_DATUM_FIELDS_V1 = 17;

// ── ScheduleAggregateShardDatum (§5.5) ───────────────────────
// Gương `types.ak` ▸ `ScheduleAggregateShardDatum`. v2.0 nối `shard_obligation_nanogic`
// (cổng κ TẠM, SPEC §6.4) ⟹ 8 trường. Trước đây lược đồ này nằm nội bộ `schedule.ts`.
export const ScheduleShardDatumSchema = Data.Object({
  shard_id                   : Data.Integer(),
  shard_locked_lamp          : Data.Integer(),
  shard_active_count         : Data.Integer(),
  shard_cumulative_committed : Data.Integer(),
  shard_cumulative_fired     : Data.Integer(),
  last_updated_epoch         : Data.Integer(),
  shard_cap                  : Data.Integer(),
  // Σ m_per_epoch × (schedule_length − fired_count) của mọi hợp đồng hash vào shard.
  // Ký cộng `m × N`, fire trừ `m × số lượt bắn`. NỐI CUỐI.
  shard_obligation_nanogic   : Data.Integer(),
});
export type ScheduleShardDatum = Data.Static<typeof ScheduleShardDatumSchema>;
export const SCHEDULE_SHARD_DATUM_FIELDS_V2 = 8;

// ══ Beacon Gen v2.0 — BẢN CHÉP CÓ NHÃN của GenBeacons/onchain/lib/genbeacons/types.ak
// (MAGIC@939feb3e, 2026-09-30), qua bản chép Aiken `ScheduleGen/onchain/lib/magiclamp/
// protocol/types.ak`. HỢP ĐỒNG NHỊ PHÂN: thứ tự trường + chỉ số constructor phải khớp bản
// gốc; sửa bản gốc thì sửa ở đây cùng commit. Bài ghim thứ tự trường với CẢ HAI tệp `.ak`:
// `ScheduleGen/tests/datumV2.test.ts`.
export const RateParamSchema = Data.Object({
  rho_q           : Data.Integer(),
  prev_rho_q      : Data.Integer(),
  effective_epoch : Data.Integer(),
});
export type RateParam = Data.Static<typeof RateParamSchema>;

export const GreenBackBeaconSchema = Data.Object({
  gb_nanogic : Data.Integer(),
  seq        : Data.Integer(),
  epoch      : Data.Integer(),
  depeg      : Data.Boolean(),
});
export type GreenBackBeacon = Data.Static<typeof GreenBackBeaconSchema>;

export const GbShardSchema = Data.Object({
  shard_id     : Data.Integer(),
  seq          : Data.Integer(),
  reset_amount : Data.Integer(),
  remaining    : Data.Integer(),
});
export type GbShard = Data.Static<typeof GbShardSchema>;

// Redeemer shard GB `Draw { amount }`: két đọc nó (purpose `Spend(shard_ref)`) — constr 0 là
// hợp đồng nhị phân. Kiểu Aiken có MỘT biến thể nên mã hoá đúng bằng `Constr 0 [amount]`,
// tức một `Data.Object` một trường. (`Data.Enum` một phần tử của Lucid 0.4.30 ném
// "Could not type cast to integer" lúc `Data.to` — đo 2026-09-30.)
export const GbShardRedeemerSchema = Data.Object({ amount: Data.Integer() });
export type GbShardRedeemer = Data.Static<typeof GbShardRedeemerSchema>;

// ── CommitRedeemer (validator `commit`, withdraw-zero) ─────────
// `pub type CommitRedeemer { vault_ref: OutputReference }` ở `validators/vault.ak`.
// `OutputReference` của stdlib (PlutusV3) = Constr 0 [transaction_id: ByteArray, output_index: Int]
// — cùng hình dạng mà `MintVaultId { seed }` đã dùng. Két so `vault_ref == own_ref` bằng BYTE,
// nên sai một ô ở đây là két bác nhánh ký (`commit_delegated_to`).
export const OutputReferenceSchema = Data.Object({
  transaction_id : Data.Bytes(),
  output_index   : Data.Integer(),
});
export const CommitRedeemerSchema = Data.Object({ vault_ref: OutputReferenceSchema });
export type CommitRedeemer = Data.Static<typeof CommitRedeemerSchema>;

// ── UMDatum ──────────────────────────────────────────────────
export const UMDatumSchema = Data.Object({
  smoothed_q         : Data.Integer(),
  last_updated_epoch : Data.Integer(),
  history            : Data.Array(Data.Integer()),
});
export type UMDatum = Data.Static<typeof UMDatumSchema>;

// ── VaultRedeemer ────────────────────────────────────────────
// Constructor order MUST match Aiken `pub type VaultRedeemer` in
// ScheduleGen/onchain/lib/magiclamp/protocol/types.ak (P8 invariant).
export const VaultRedeemerSchema = Data.Enum([
  Data.Object({ ScheduleCommit: Data.Object({                                // constr 0
    schedule_length: Data.Integer(),
    lamp_per_epoch:  Data.Integer(),
  })}),
  Data.Object({ ScheduleFire: Data.Object({                                  // constr 1
    schedule_id: Data.Bytes(),
  })}),
  Data.Object({ BurnBatch: Data.Object({                                     // constr 2
    burns: Data.Array(Data.Tuple([Data.Bytes(), Data.Integer()])),
  })}),
  Data.Object({ WithdrawLamp: Data.Object({                                  // constr 3
    amount: Data.Integer(),
  })}),
  Data.Object({ SetDelegate: Data.Object({                                   // constr 4
    new_delegate: Data.Nullable(Data.Bytes()),
  })}),
  // constr 5 — PruneExpired: dọn rác batch chết, permissionless, không đụng LAMP.
  // ĐẶT CUỐI: chỉ số constructor là hợp đồng nhị phân, chèn vào giữa là vỡ decode
  // mọi UTxO đã tạo. Một variant không trường mã hoá bằng danh sách RỖNG.
  Data.Object({ PruneExpired: Data.Tuple([]) }),
]);
export type VaultRedeemer = Data.Static<typeof VaultRedeemerSchema>;

// ── ShardRedeemer ──────────────────────────────────────────────
export const ShardRedeemerSchema = Data.Enum([
  Data.Object({ ShardUpdateCommit: Data.Object({                             // constr 0
    delta_locked:    Data.Integer(),
    delta_committed: Data.Integer(),
  })}),
  Data.Object({ ShardUpdateFire: Data.Object({                               // constr 1
    fires_in_tx: Data.Integer(),
    lambda:      Data.Integer(),
  })}),
]);
export type ShardRedeemer = Data.Static<typeof ShardRedeemerSchema>;

// ── Codec companions ─────────────────────────────────────────
// `Data.to`/`Data.from` infer their result from the SECOND argument, so that
// argument must be a VALUE whose TypeScript type is the plain static shape —
// not the schema object itself. Passing `XxxSchema` directly makes the call
// return `TObject<…>` and every field access below it goes untyped.
//
// Same name as the type, so call sites read `Data.from(utxo.datum!, VaultDatum)`.
// Runtime value is unchanged — the very same schema object, re-branded.
export const VaultDatum    = VaultDatumSchema    as unknown as VaultDatum;
export const UMDatum       = UMDatumSchema       as unknown as UMDatum;
export const VaultRedeemer = VaultRedeemerSchema as unknown as VaultRedeemer;
export const ShardRedeemer = ShardRedeemerSchema as unknown as ShardRedeemer;
export const ScheduleShardDatum = ScheduleShardDatumSchema as unknown as ScheduleShardDatum;
export const RateParam          = RateParamSchema          as unknown as RateParam;
export const GreenBackBeacon    = GreenBackBeaconSchema    as unknown as GreenBackBeacon;
export const GbShard            = GbShardSchema            as unknown as GbShard;
export const GbShardRedeemer    = GbShardRedeemerSchema    as unknown as GbShardRedeemer;
export const CommitRedeemer     = CommitRedeemerSchema     as unknown as CommitRedeemer;

// ── Giải mã có kiểm đời (v1 ⟹ NÉM) ─────────────────────────────
//
// v2.0 là hash mới, KHÔNG di trú UTxO v1 (chủ dự án chốt). Một datum 17 trường đưa vào
// `Data.from(…, VaultDatum)` cũng ném, nhưng bằng câu chung chung của Lucid không nói ra
// đây là két đời trước. Ở đây đếm trường TRƯỚC, nói rõ đời nào, rồi mới giải mã nghiêm.
// KHÔNG đệm hai trường thiếu bằng giá trị mặc định — cửa sổ bịa là nâng `usage_factor`.

/** Mã lỗi khi gặp datum đời trước Gen v2.0. */
export const ERR_DATUM_V1 = "GEN-SCH-V1-DATUM";

function constrFieldCount(raw: string, what: string): number {
  const d = Data.from(raw);
  if (!(d instanceof Constr)) {
    throw new Error(`${what}: datum không phải Constr — không giải mã được.`);
  }
  if (d.index !== 0) {
    throw new Error(`${what}: constructor ${d.index}, cần 0.`);
  }
  return d.fields.length;
}

/** Giải mã `VaultDatum` v2.0 (19 trường). 17 trường ⟹ NÉM `GEN-SCH-V1-DATUM`. */
export function decodeVaultDatum(raw: string): VaultDatum {
  const n = constrFieldCount(raw, "VaultDatum");
  if (n === VAULT_DATUM_FIELDS_V1) {
    throw new Error(
      `${ERR_DATUM_V1}: VaultDatum có ${n} trường — két ScheduleGen đời trước Gen v2.0. ` +
      `v2.0 là script mới (hash mới), không di trú UTxO v1; két này không đi được bộ dựng v2.0.`);
  }
  if (n !== VAULT_DATUM_FIELDS_V2) {
    throw new Error(`VaultDatum có ${n} trường, cần đúng ${VAULT_DATUM_FIELDS_V2} (Gen v2.0).`);
  }
  return Data.from(raw, VaultDatum);
}

/** Giải mã datum shard LAMP v2.0 (8 trường). 7 trường (v1) ⟹ NÉM `GEN-SCH-V1-DATUM`. */
export function decodeScheduleShardDatum(raw: string): ScheduleShardDatum {
  const n = constrFieldCount(raw, "ScheduleAggregateShardDatum");
  if (n === SCHEDULE_SHARD_DATUM_FIELDS_V2 - 1) {
    throw new Error(
      `${ERR_DATUM_V1}: ScheduleAggregateShardDatum có ${n} trường — shard đời trước ` +
      "Gen v2.0 (thiếu `shard_obligation_nanogic`). Không di trú.");
  }
  if (n !== SCHEDULE_SHARD_DATUM_FIELDS_V2) {
    throw new Error(
      `ScheduleAggregateShardDatum có ${n} trường, cần đúng ${SCHEDULE_SHARD_DATUM_FIELDS_V2}.`);
  }
  return Data.from(raw, ScheduleShardDatum);
}
