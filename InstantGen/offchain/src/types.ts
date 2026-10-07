// src/types.ts — TypeScript mirror of Aiken types + Lucid Evolution Data schemas
// Constructor indices must match Aiken type ordering (Plutus Data encoding).
//
// Nguồn chân lý hình dạng nhị phân: `InstantGen/onchain/lib/magiclamp/protocol/types.ak`.
// Lệch THỨ TỰ trường hay CHỈ SỐ constructor là dựng ra datum/redeemer mà validator
// không giải mã được. Vector CBOR ghim hai bên trùng byte: `tests/vectors.ts` ▸
// `TV_DATUM_V2_*` ↔ `onchain/lib/magiclamp/protocol/datum_vectors_test.ak`.

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
// Không còn trong VaultDatum từ Gen v2.0 (ô 6 nay là `wakeme_link`). Giữ lược đồ vì
// `types.ak` vẫn khai kiểu này.
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
// Không còn trong VaultDatum từ Gen v2.0 (ô 12 nay là `cap_epoch`). Giữ lược đồ vì
// `types.ak` vẫn khai kiểu này.
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
// Gen v2.0: nhánh sinh KHÔNG còn xoá trường này (datum ra `..applied`); BurnBatch cộng
// Σburns. Vai của nó dưới mô hình mới là CHƯA CHỐT `CC-GEN-SEED-CREDIT` (SPEC v2.0 §13).
export const ActivityStateSchema = Data.Object({
  recent_burn_epochs : Data.Array(Data.Tuple([Data.Bytes(), Data.Integer()])),
  consumed_credit    : Data.Integer(),
});
export type ActivityState = Data.Static<typeof ActivityStateSchema>;

// ── StreakState ──────────────────────────────────────────────
// Không còn trong VaultDatum từ Gen v2.0 (ô 14 nay là `cap_nanogic`).
export const StreakStateSchema = Data.Object({
  current_streak    : Data.Integer(),
  last_active_epoch : Data.Integer(),
});
export type StreakState = Data.Static<typeof StreakStateSchema>;

// ── EpochUsage — một ô của `usage_window` (SPEC §6.1.2) ─────
// Constr 0 [generated, consumed]. Kiểu TS cùng tên sống ở `genFormula.ts` ▸
// `EpochUsage` (interface, trùng hình dạng) — ở đây chỉ khai LƯỢC ĐỒ, không khai lại kiểu,
// để `index.ts` tái xuất cả hai tệp mà không đụng tên.
export const EpochUsageSchema = Data.Object({
  generated : Data.Integer(),
  consumed  : Data.Integer(),
});

// ── Ba kiểu beacon GenBeacons — CHÉP CÓ NHÃN ─────────────────
// Nguồn: `GenBeacons/onchain/lib/genbeacons/types.ak` ▸ `RateParam`, `GreenBackBeacon`,
// `GbShard`, `VaultRegistry`, `GbShardRedeemer` (MAGIC@939feb3e, 2026-09-30); bản chép
// on-chain phía két: `InstantGen/onchain/lib/magiclamp/protocol/types.ak`. Nguồn đổi
// hình ⟹ ba nơi đổi trong CÙNG commit. Két chỉ ĐỌC ba beacon; ai được ghi chúng là việc
// của validator GenBeacons.

/** Beacon suất ρ. ρ hiệu lực ở `e`: `rho_q` nếu `e >= effective_epoch`, ngược lại `prev_rho_q`. */
export const RateParamSchema = Data.Object({
  rho_q           : Data.Integer(),
  prev_rho_q      : Data.Integer(),
  effective_epoch : Data.Integer(),
});
export type RateParam = Data.Static<typeof RateParamSchema>;

/** Beacon thặng dư GreenBack. */
export const GreenBackBeaconSchema = Data.Object({
  gb_nanogic : Data.Integer(),
  seq        : Data.Integer(),
  epoch      : Data.Integer(),
  depeg      : Data.Boolean(),
});
export type GreenBackBeacon = Data.Static<typeof GreenBackBeaconSchema>;

/** Một shard của bộ đếm `GB_available`. */
export const GbShardSchema = Data.Object({
  shard_id     : Data.Integer(),
  seq          : Data.Integer(),
  reset_amount : Data.Integer(),
  remaining    : Data.Integer(),
});
export type GbShard = Data.Static<typeof GbShardSchema>;

/**
 * Redeemer shard: `Draw { amount }` = Constr 0 [amount]. Lượng két rút ở lượt sinh.
 * Kiểu Aiken có MỘT biến thể nên mã hoá y như bản ghi ⟹ `Data.Object` một trường.
 * (`Data.Enum` một phần tử của Lucid 0.4.30 ném "Could not type cast to integer" lúc
 * `Data.to` — bài `instantTxWindow.test.ts` ▸ E bắt được ngày 2026-09-30.)
 */
export const GbShardRedeemerSchema = Data.Object({ amount: Data.Integer() });
export type GbShardRedeemer = Data.Static<typeof GbShardRedeemerSchema>;

/** Sổ script két được phép đồng tiêu với shard GB (NFT "VRG"). */
export const VaultRegistrySchema = Data.Object({
  vault_script_hashes : Data.Array(Data.Bytes({ minLength: 28, maxLength: 28 })),
});
export type VaultRegistry = Data.Static<typeof VaultRegistrySchema>;

// ── VaultDatum — Gen v2.0, 20 trường, RIÊNG của InstantGen ──
//
// Thứ tự trường = `types.ak ▸ VaultDatum`. Ba ô chết ≤ 15 được TÁI DỤNG (két Wakeme đọc
// theo VỊ TRÍ `[6, 12, 14]`):
//   6  `vacuum_orders`   → `wakeme_link`   (ByteArray: "" hoặc owner_commit 32 byte)
//   12 `delegation_cert` → `cap_epoch`     (Int)
//   14 `streak_state`    → `cap_nanogic`   (Int)
// Nối cuối: 18 `usage_window` (ĐÚNG 7 ô), 19 `usage_window_epoch`.
//
// v2.0 là hash MỚI, không di trú UTxO đời trước. Giải mã một datum 18 trường (v1) bằng
// lược đồ này phải NÉM — dùng `decodeVaultDatum`, đừng gọi `Data.from` trần: `Data.from`
// cũng ném khi lệch số trường, nhưng câu của nó ("Fields do not match") không nói người
// đọc đang cầm một két đời cũ.
export const VaultDatumSchema = Data.Object({
  // Trường 0 — `Credential`. ConsumeMAGIC đọc đúng chỉ số này.
  owner                 : OwnerCredentialSchema,
  lamp_balance          : Data.Integer(),
  lamp_locked           : Data.Integer(),
  loyalty_holdings      : Data.Array(LoyaltyHoldingSchema),
  magic_batches         : Data.Array(MagicBatchSchema),
  next_batch_index      : Data.Integer(),
  // Trường 6 — SUY RA từ reference input két Wakeme ở lượt làm mới checkpoint.
  wakeme_link           : Data.Bytes(),
  gen_schedules         : Data.Array(GenScheduleSchema),
  profile               : ActivityProfileSchema,
  profile_changed_epoch : Data.Integer(),
  pending_profile       : Data.Nullable(PendingProfileSchema),
  last_updated_epoch    : Data.Integer(),
  // Trường 12 — epoch của lượt làm mới cap gần nhất (luôn == usage_window_epoch).
  cap_epoch             : Data.Integer(),
  activity_state        : ActivityStateSchema,
  // Trường 14 — `amount_by_lamp` tại `cap_epoch`, nanogic. Validator tự tính.
  cap_nanogic           : Data.Integer(),
  // Trường 15 — bia mộ (Nợ #14), trường ở lại; két Wakeme đọc datum InstantGen theo vị trí, chỉ số ≤ 15.
  personal_delegate     : Data.Nullable(Data.Bytes()),
  attribution           : VaultAttributionSchema,
  // Trường 17 — mốc POSIX ms LAMP được rời két. Chỉ nhánh sinh ghi nó.
  instant_unlock_ms     : Data.Integer(),
  // Trường 18 — ô 0 = epoch `usage_window_epoch`, ô 1..6 = 6 epoch đã đóng.
  usage_window          : Data.Array(EpochUsageSchema),
  usage_window_epoch    : Data.Integer(),
});
export type VaultDatum = Data.Static<typeof VaultDatumSchema>;

/** Số trường của VaultDatum InstantGen theo đời. */
export const VAULT_DATUM_FIELDS_V2 = 20;
export const VAULT_DATUM_FIELDS_V1 = 18;

/**
 * Giải mã datum két InstantGen v2.0, NÉM có tên khi hình dạng không phải v2.0.
 *
 *  - 18 trường ⟹ `VAULT_DATUM_V1`: két Gen v1 (hash cũ). v2.0 KHÔNG di trú UTxO v1
 *    (SPEC v2.0 §6.1.6), nên không có đường đọc tiếp — trả lỗi thay vì đệm ô thiếu.
 *  - số trường khác ⟹ `VAULT_DATUM_SHAPE` (vd 19 trường = két ScheduleGen v2.0).
 *  - đúng 20 trường mà lược đồ con sai ⟹ lỗi của `Data.from`, bọc lại cùng mã
 *    `VAULT_DATUM_SHAPE`.
 */
export function decodeVaultDatum(datumCbor: string): VaultDatum {
  const raw = Data.from(datumCbor);
  if (!(raw instanceof Constr) || raw.index !== 0) {
    throw new Error(`VAULT_DATUM_SHAPE: datum két không phải Constr 0 — không phải VaultDatum InstantGen.`);
  }
  const n = raw.fields.length;
  if (n === VAULT_DATUM_FIELDS_V1) {
    throw new Error(
      `VAULT_DATUM_V1: datum ${n} trường là két InstantGen Gen v1 (hash cũ). Gen v2.0 cần ` +
      `${VAULT_DATUM_FIELDS_V2} trường và KHÔNG di trú UTxO v1 — két này không đi được ` +
      `qua bộ dựng v2.0.`,
    );
  }
  if (n !== VAULT_DATUM_FIELDS_V2) {
    throw new Error(
      `VAULT_DATUM_SHAPE: datum ${n} trường, VaultDatum InstantGen v2.0 cần ` +
      `${VAULT_DATUM_FIELDS_V2} (19 trường là két ScheduleGen v2.0).`,
    );
  }
  try {
    return Data.from(datumCbor, VaultDatum);
  } catch (e) {
    throw new Error(`VAULT_DATUM_SHAPE: datum 20 trường nhưng sai lược đồ con — ${(e as Error).message}`);
  }
}

// ── VaultRedeemer ────────────────────────────────────────────
// Constructor index = Aiken enum order (types.ak). MUST stay in lockstep:
//   0 InstantGen{claimed_amount}, 1 PruneExpired, 2 BurnBatch{burns},
//   3 UpdateProfile{new_profile}, 4 WithdrawLamp{amount},
//   5 SetDelegate{new_delegate}, 6 RefreshCheckpoint.
//
// constr 0: Gen v2.0 — `claimed_amount` = lượng sinh `m` (nanogic) do CHỦ KÉT CHỌN;
// validator ép `m` qua các cổng IG-4..IG-12 chứ không tự tính lại một con số.
//
// constr 2 = BurnBatch is the LOCKED cross-repo interface (ConsumeMAGIC
// CONTRACT.md v2, spec §11 `burn_batch_constr` = 2). Do not move it.
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
  Data.Literal("RefreshCheckpoint"),                                            // constr 6
]);
export type VaultRedeemer = Data.Static<typeof VaultRedeemerSchema>;

// ── VaultIdRedeemer — redeemer nhánh MINT của validator vault ─
// `validators/vault.ak ▸ VaultIdRedeemer`: 0 MintVaultId{seed: OutputReference},
// 1 BurnVaultId. OutputReference (stdlib v3) = Constr 0 [transaction_id, output_index].
export const OutputReferenceSchema = Data.Object({
  transaction_id : Data.Bytes({ minLength: 32, maxLength: 32 }),
  output_index   : Data.Integer(),
});
export const VaultIdRedeemerSchema = Data.Enum([
  Data.Object({ MintVaultId: Data.Object({ seed: OutputReferenceSchema }) }),  // constr 0
  Data.Literal("BurnVaultId"),                                                 // constr 1
]);
export type VaultIdRedeemer = Data.Static<typeof VaultIdRedeemerSchema>;

// ── Codec companions ─────────────────────────────────────────
// `Data.to`/`Data.from` infer their result from the SECOND argument, so that
// argument must be a VALUE whose TypeScript type is the plain static shape —
// not the schema object itself. Passing `XxxSchema` directly makes the call
// return `TObject<…>` and every field access below it goes untyped.
//
// These aliases are the lucid-evolution idiom: same name as the type, so call
// sites read `Data.from(utxo.datum!, VaultDatum)`. Runtime value is unchanged —
// it is the very same schema object, only its static type is re-branded.
export const VaultDatum       = VaultDatumSchema       as unknown as VaultDatum;
export const VaultRedeemer    = VaultRedeemerSchema    as unknown as VaultRedeemer;
export const VaultIdRedeemer  = VaultIdRedeemerSchema  as unknown as VaultIdRedeemer;
export const RateParam        = RateParamSchema        as unknown as RateParam;
export const GreenBackBeacon  = GreenBackBeaconSchema  as unknown as GreenBackBeacon;
export const GbShard          = GbShardSchema          as unknown as GbShard;
export const GbShardRedeemer  = GbShardRedeemerSchema  as unknown as GbShardRedeemer;
export const VaultRegistry    = VaultRegistrySchema    as unknown as VaultRegistry;
