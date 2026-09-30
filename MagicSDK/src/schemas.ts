// MagicSDK/src/schemas.ts — Plutus Data schemas của két (Gen v2.0)
//
// ══ Gen v2.0: HAI HÌNH DẠNG VaultDatum, và SDK KHÔNG còn giữ bản chép nào ══════
//
//   `VaultDatumSchema`        — 19 trường. ScheduleGen v2.0.
//   `InstantVaultDatumSchema` — 20 trường. InstantGen v2.0.
//
// Nguồn: `ScheduleGen/offchain/src/types.ts` ▸ `VaultDatumSchema` và
// `InstantGen/offchain/src/types.ts` ▸ `VaultDatumSchema` — mỗi cái là gương `types.ak`
// của module đó, có vector CBOR ghim hai phía (`InstantGen/tests/vectors.ts` ▸
// `TV_DATUM_V2_*`, `ScheduleGen/onchain/lib/magiclamp/protocol/datum_cbor_vectors.ak`).
// Tệp này TÁI XUẤT, không chép: bản chép 17/18 trường đời trước đã trôi khỏi nguồn ngay
// khi Gen v2.0 đổi datum, và không gì kêu cho tới khi bài `vaultParams` đỏ.
//
// Hai hình dạng nay KHÁC NHAU cả ở giữa, không chỉ ở đuôi: InstantGen tái dụng ô 6
// (`vacuum_orders` → `wakeme_link`), 12 (`delegation_cert` → `cap_epoch`), 14
// (`streak_state` → `cap_nanogic`) và nối 18–19; ScheduleGen giữ 17 trường cũ và nối
// 17–18. Mã dùng chung hai loại phải gom trường theo TÊN, không theo chỉ số.
//
// 🔴 v2.0 là hash két MỚI, KHÔNG di trú UTxO đời trước (chủ dự án chốt). Datum 18 trường
// (InstantGen v1) hay 17 trường (ScheduleGen v1) phải NÉM có tên, không đệm ô thiếu —
// các bộ giải mã dưới đây đi qua bộ giải mã của gói nền, chúng làm đúng việc đó
// (`VAULT_DATUM_V1` / `GEN-SCH-V1-DATUM`).
//
// Bia mộ `BatchSource` (Snapshot/Vacuum) và `vacuum_orders` của két Schedule vẫn nằm
// trong lược đồ nguồn — chỉ số constructor và arity là hợp đồng nhị phân.
// ═══════════════════════════════════════════════════════════════════════════

import { Constr, Data } from "@lucid-evolution/lucid";
import {
  VaultDatumSchema as ScheduleVaultDatumSchema,
  decodeVaultDatum as decodeScheduleVaultDatum,
  VAULT_DATUM_FIELDS_V1 as SCHEDULE_FIELDS_V1,
  VAULT_DATUM_FIELDS_V2 as SCHEDULE_FIELDS_V2,
  type VaultDatum as ScheduleVaultDatum,
} from "@magiclamp/schedulegen-sdk";
import {
  VaultDatumSchema as InstantVaultDatumSchemaSource,
  OwnerCredentialSchema as OwnerCredentialSchemaSource,
  VaultIdRedeemerSchema as VaultIdRedeemerSchemaSource,
  decodeVaultDatum as decodeInstantVaultDatum,
  VAULT_DATUM_FIELDS_V1 as INSTANT_FIELDS_V1,
  VAULT_DATUM_FIELDS_V2 as INSTANT_FIELDS_V2,
  type VaultDatum as InstantVaultDatumSource,
} from "@magiclamp/instantgen-sdk";

/** Credential chủ két — `VerificationKey(h)` = Constr 0, `Script(h)` = Constr 1. */
export const OwnerCredentialSchema = OwnerCredentialSchemaSource;

/** VaultDatum 19 trường — ScheduleGen v2.0. Tên giữ nguyên vì đã xuất ra ngoài. */
export const VaultDatumSchema = ScheduleVaultDatumSchema;

/** VaultDatum 20 trường — InstantGen v2.0. */
export const InstantVaultDatumSchema = InstantVaultDatumSchemaSource;

export type VaultDatum = ScheduleVaultDatum;
export type InstantVaultDatum = InstantVaultDatumSource;

/** Số trường theo loại két và đời — đọc từ gói nền, không gõ tay. */
export const VAULT_DATUM_FIELD_COUNTS = {
  Instant:  { v2: INSTANT_FIELDS_V2,  v1: INSTANT_FIELDS_V1 },
  Schedule: { v2: SCHEDULE_FIELDS_V2, v1: SCHEDULE_FIELDS_V1 },
} as const;

/** Loại két suy ra từ SỐ TRƯỜNG của datum. Tập ĐÓNG, khớp `VaultType` của `types.ts`. */
export type VaultDatumShapeKind = "Instant" | "Schedule";

export type VaultDatumEitherShape =
  | { kind: "Instant";  datum: InstantVaultDatum; instantUnlockMs: bigint }
  | { kind: "Schedule"; datum: VaultDatum;        instantUnlockMs: null };

/** Giải mã datum két khi ĐÃ biết loại. Đời trước v2.0 hay sai loại ⟹ NÉM (lỗi gói nền). */
export function decodeVaultDatumOfKind(kind: "Instant", hex: string): InstantVaultDatum;
export function decodeVaultDatumOfKind(kind: "Schedule", hex: string): VaultDatum;
export function decodeVaultDatumOfKind(kind: VaultDatumShapeKind, hex: string): VaultDatum | InstantVaultDatum;
export function decodeVaultDatumOfKind(kind: VaultDatumShapeKind, hex: string): VaultDatum | InstantVaultDatum {
  return kind === "Instant" ? decodeInstantVaultDatum(hex) : decodeScheduleVaultDatum(hex);
}

/**
 * Giải mã một datum két khi CHƯA biết loại — rẽ theo SỐ TRƯỜNG rồi giao cho bộ giải mã
 * của đúng gói nền: 20 ⟹ InstantGen, 19 ⟹ ScheduleGen.
 *
 * 18 hoặc 17 trường là két đời trước Gen v2.0 ⟹ NÉM `VAULT_DATUM_V1`. Số khác ⟹ NÉM.
 * 🔴 KHÔNG NUỐT LỖI: trả `null` ở đây là để một két không đọc được và một két rỗng ra
 * cùng một màn hình.
 */
export function decodeVaultDatumEitherShape(hex: string): VaultDatumEitherShape {
  const raw = Data.from(hex);
  if (!(raw instanceof Constr) || raw.index !== 0) {
    throw new Error(`VAULT_DATUM_SHAPE: datum két không phải Constr 0 — không phải VaultDatum.`);
  }
  const n = raw.fields.length;
  if (n === INSTANT_FIELDS_V2) {
    const datum = decodeInstantVaultDatum(hex);
    return { kind: "Instant", datum, instantUnlockMs: datum.instant_unlock_ms };
  }
  if (n === SCHEDULE_FIELDS_V2) {
    return { kind: "Schedule", datum: decodeScheduleVaultDatum(hex), instantUnlockMs: null };
  }
  if (n === INSTANT_FIELDS_V1 || n === SCHEDULE_FIELDS_V1) {
    throw new Error(
      `VAULT_DATUM_V1: datum ${n} trường là két đời TRƯỚC Gen v2.0 ` +
      `(${n === INSTANT_FIELDS_V1 ? "InstantGen" : "ScheduleGen"} v1, hash cũ). Gen v2.0 là ` +
      `script mới và KHÔNG di trú UTxO v1 — két này không đi được qua SDK v2.0.`,
    );
  }
  throw new Error(
    `VAULT_DATUM_SHAPE: datum ${n} trường, không khớp hình dạng nào đang sống ` +
    `(InstantGen ${INSTANT_FIELDS_V2} · ScheduleGen ${SCHEDULE_FIELDS_V2}).`,
  );
}

// ── VaultIdRedeemer — redeemer của handler `mint` trên chính validator vault ──
//
// Nguồn: `pub type VaultIdRedeemer` trong InstantGen/onchain/validators/vault.ak (và bản
// song sinh ở ScheduleGen): MintVaultId { seed } = Constr 0, BurnVaultId = Constr 1.
// Tái xuất từ `@magiclamp/instantgen-sdk` ▸ `VaultIdRedeemerSchema`, không chép.
export const VaultIdRedeemerSchema = VaultIdRedeemerSchemaSource;

export type VaultIdRedeemer = ReturnType<typeof Data.from<typeof VaultIdRedeemerSchema>>;
