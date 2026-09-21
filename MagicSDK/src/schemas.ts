// MagicSDK/src/schemas.ts — Plutus Data schemas (must mirror Aiken types exactly)
// Field order = constructor index. Renaming a field is OK; reordering BREAKS the contract.
//
// P8 invariant: this schema must produce the same CBOR as Aiken's
// `pub type VaultDatum { ... }` definition in
// `<Module>/onchain/lib/magiclamp/protocol/types.ak`.
//
// ══ HAI HÌNH DẠNG VaultDatum, KHÔNG CÒN MỘT ════════════════════════════════
// Bản trước của dòng này khai *"Mọi loại vault dùng CHUNG một VaultDatum"*. Câu
// đó **nay SAI**, và nó sai từ lúc `InstantGen` thêm trường 17.
//
//   `VaultDatumSchema`        — 17 trường. ScheduleGen · PrepaidGen, và là hình
//                               dạng mà mọi bên đọc chung đã nhập từ trước.
//   `InstantVaultDatumSchema` — 17 trường ĐÓ cộng `instant_unlock_ms` ở CUỐI
//                               (chỉ số 17) ⟹ 18 trường. Chỉ InstantGen.
//
// VÌ SAO KHÁC NHAU, chứ không phải "chưa kịp đồng bộ". `instant_unlock_ms` là
// mốc khoá LAMP sau một lượt sinh Instant (`CC-GEN-L-TIMING`). Két ScheduleGen
// **không có nhánh sinh Instant**, nên ở đó trường này sẽ là một ô KHÔNG CÓ
// NGƯỜI GHI — và một ô như thế phải trả bằng một cổng đông-cứng ở mỗi nhánh
// spend, hai trong số đó permissionless. Lý lẽ đầy đủ nằm ở nguồn, đừng chép
// xuống đây: `InstantGen/onchain/lib/magiclamp/protocol/types.ak` ▸ khối chú
// thích của `instant_unlock_ms`.
//
// 🔴 LỆCH SỐ TRƯỜNG LÀM DECODE HỎNG ỒN ÀO — ĐÓ LÀ TÍNH CHẤT MUỐN CÓ.
// Đo 2026-09-21 trên `@lucid-evolution/lucid` 0.4.30, cả HAI chiều:
//
//     Data.from(<CBOR 18 trường>, <lược đồ 17 trường>)
//       → ném: "Could not type cast to object. Fields do not match."
//     Data.from(<CBOR 17 trường>, <lược đồ 18 trường>)
//       → ném: "Could not type cast to object. Fields do not match."
//
// Cùng chiều với Aiken (`expect n: NewD = d` nghiêm ngặt về số trường, cả hai
// chiều — xem `BOUNDARIES.md` §2). Nên đọc nhầm hình dạng là một ngoại lệ có
// tên, không phải một trường `undefined` đi tiếp vào phép tính ở nơi khác. Ai
// cần đọc két mà CHƯA biết loại thì gọi `decodeVaultDatumEitherShape` bên dưới;
// **đừng** bọc `Data.from` trong một `catch` trả `null` — đó đúng là cái vỏ im
// lặng mà kho này cấm.
//
// Hai lược đồ dựng từ MỘT danh sách trường chung (`VAULT_DATUM_COMMON_FIELDS`),
// không chép hai lần: một bản chép sẽ trôi khỏi bản gốc mà không gì báo.
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

// Trường thứ hai là TỔNG LƯỢNG nanogic đã tiêu qua BurnBatch và chưa quy thành thưởng
// InstantGen (§6.3) — KHÔNG phải số lượt. Nhãn cũ `total_burns_count` nói sai đơn vị và
// đã bỏ khỏi mọi module còn sống (Nợ #39, chốt 2026-08-28).
//
// Đổi tên KHÔNG đụng hợp đồng nhị phân: `Data.Object` mã hoã theo THỨ TỰ KHAI, tên khoá
// JS chỉ là hình dạng đối tượng. Cùng vị trí, cùng `Data.Integer()` ⇒ cùng byte trên
// chuỗi, mọi UTxO đã tạo vẫn đọc được.
//
// 🔴 CÁI VỠ LÀ API CỦA SDK, KHÔNG PHẢI CHUỖI. Mã ngoài đọc `.total_burns_count` nay nhận
// `undefined` — im lặng, không lỗi biên dịch nếu bên đó viết bằng JS. Đây là thay đổi
// BREAKING của SDK; xem `MagicSDK/INTEGRATOR_GUIDE_V1.md`.
const ActivityStateSchema = Data.Object({
  recent_burn_epochs: Data.Array(Data.Tuple([Data.Bytes(), Data.Integer()])),
  consumed_credit:    Data.Integer(),
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

/** 17 trường chung của MỌI loại két, theo ĐÚNG thứ tự khai = chỉ số trường Plutus.
 *  Đây là NGUỒN: hai lược đồ bên dưới trải danh sách này vào, không chép lại nó. */
const VAULT_DATUM_COMMON_FIELDS = {
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
};

/** VaultDatum 17 trường — ScheduleGen, PrepaidGen, và mọi bên đọc chung.
 *
 *  Tên này KHÔNG đổi dù nay nó chỉ tả một trong hai hình dạng: nó đã xuất ra ngoài
 *  và nhiều nhà đang nhập. Đổi tên là một breaking change của SDK để đổi lấy đúng
 *  một chữ. */
export const VaultDatumSchema = Data.Object({ ...VAULT_DATUM_COMMON_FIELDS });

/** VaultDatum 18 trường — CHỈ InstantGen. 17 trường chung + `instant_unlock_ms`
 *  ở chỉ số 17. Thêm ở CUỐI nên chỉ số 0..16 giữ nguyên, và các bên đọc theo VỊ TRÍ
 *  (`Paymaster` ▸ `vault_delegate_is` đọc trường 15, `ConsumeMAGIC` ▸ `consume.ak`
 *  đọc trường 0) không phải đụng gì. */
export const InstantVaultDatumSchema = Data.Object({
  ...VAULT_DATUM_COMMON_FIELDS,
  instant_unlock_ms:     Data.Integer(),
});

export type VaultDatum = ReturnType<typeof Data.from<typeof VaultDatumSchema>>;
export type InstantVaultDatum = ReturnType<typeof Data.from<typeof InstantVaultDatumSchema>>;

/** Loại két suy ra từ SỐ TRƯỜNG của datum. Tập ĐÓNG, khớp `VaultType` của `types.ts`. */
export type VaultDatumShapeKind = "Instant" | "Schedule";

export interface VaultDatumEitherShape {
  /** `"Instant"` khi datum có 18 trường, `"Schedule"` khi có 17. */
  kind: VaultDatumShapeKind;
  datum: VaultDatum | InstantVaultDatum;
  /** Trường 17 khi `kind === "Instant"`; `null` khi `"Schedule"` — ở đó trường
   *  KHÔNG TỒN TẠI, và `null` nói đúng điều đó. Đừng đệm `0n`: `0n` là một giá
   *  trị hợp lệ của một két Instant chưa từng sinh, nên đệm nó là xoá mất chỗ
   *  phân biệt "không có trường" với "có trường, bằng 0". */
  instantUnlockMs: bigint | null;
}

/**
 * Giải mã một datum két khi CHƯA biết nó thuộc loại nào — thử hình dạng 18 trường
 * trước, rồi 17.
 *
 * Thử Instant trước là có chủ ý: hai lược đồ loại trừ nhau (Lucid ném ở cả hai
 * chiều lệch số trường — xem đầu tệp), nên thứ tự không đổi KẾT QUẢ, chỉ đổi số
 * lần thử ở đường đi phổ biến hơn.
 *
 * 🔴 KHÔNG NUỐT LỖI. Cả hai hình dạng đều không khớp ⟹ NÉM, và câu lỗi nêu đích
 * danh hai hình dạng đã thử cùng câu lỗi gốc của từng lần. Trả `null` hay `{}` ở
 * đây là dựng một cái vỏ im lặng: một két không đọc được và một két rỗng sẽ ra
 * cùng một màn hình.
 */
export function decodeVaultDatumEitherShape(hex: string): VaultDatumEitherShape {
  let instantError: string;
  try {
    const datum = Data.from(hex, InstantVaultDatumSchema);
    return {
      kind: "Instant",
      datum,
      instantUnlockMs: (datum as unknown as { instant_unlock_ms: bigint }).instant_unlock_ms,
    };
  } catch (e) {
    instantError = (e as Error).message;
  }

  try {
    return { kind: "Schedule", datum: Data.from(hex, VaultDatumSchema), instantUnlockMs: null };
  } catch (e) {
    throw new Error(
      `Datum két không khớp hình dạng nào trong hai hình dạng đang sống. ` +
      `InstantVaultDatumSchema (18 trường): ${instantError} — ` +
      `VaultDatumSchema (17 trường): ${(e as Error).message}`,
    );
  }
}

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
