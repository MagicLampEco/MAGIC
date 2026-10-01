// VaultTxAPI/src/vaultDatumShape.ts — hình dạng ĐÃ GIẢI MÃ của VaultDatum, khai một chỗ.
//
// ── VÌ SAO PHẢI CÓ TỆP NÀY ─────────────────────────────────────────────────────
// `@magiclamp/sdk` xuất cả `VaultDatumSchema` lẫn kiểu `VaultDatum`, và LƯỢC ĐỒ thì
// dùng lại được nguyên vẹn — tệp này KHÔNG khai lại nó, đó vẫn là nguồn duy nhất.
// Nhưng kiểu `VaultDatum` không phải kiểu của GIÁ TRỊ giải mã ra. Đo trên
// `@lucid-evolution/plutus` 0.4.30:
//
//     declare function from<T = Data>(raw: Datum | Redeemer, type?: T): T;
//
// tức `Data.from<typeof VaultDatumSchema>` trả về ĐÚNG kiểu của lược đồ — một đối
// tượng TypeBox — chứ không phải kiểu của dữ liệu. Lúc chạy nó trả dữ liệu; lúc biên
// dịch nó khai lược đồ. Hệ quả đo được: `datum.lamp_locked - other.lamp_locked` đỏ với
// câu "number không gán được cho bigint", và câu đó không nhắc gì tới nguyên nhân.
//
// Kho đã sống chung với chuyện này bằng cách ép kiểu tại từng chỗ dùng
// (`MagicSDK/src/burnBatch.ts` ▸ `MagicBatchLike`, `VaultReadAPI/src/vaultView.ts` ▸
// `RawBatch`). Tệp này gom về MỘT chỗ ép, để chỗ ép có tên và có lý do viết cạnh nó.
//
// ⚠ Đây là BẢN CHÉP hình dạng, nên nó có thể chết im lặng: thêm/đổi một trường trong
// `VaultDatumSchema` mà không sửa ở đây thì mã vẫn biên dịch. Cái CANH nó là
// `tests/summary.test.ts` — mẫu ở đó đi qua chính `Data.to(..., VaultDatumSchema)`, nên
// lược đồ đổi hình là mẫu đổi theo và phép kiểm nói cho biết.
//
// ── HAI HÌNH DẠNG, VÀ DỊCH VỤ NÀY KHÔNG BIẾT TRƯỚC LOẠI KÉT ────────────────────
// Gen v2.0: két InstantGen mang 20 trường, ScheduleGen 19 (`MagicSDK/src/schemas.ts` đầu tệp).
// Datum v1 (18/17 trường) KHÔNG giải mã được — SDK ném `VAULT_DATUM_V1`, và tệp này để lỗi đó
// đi thẳng lên (v2.0 là hash mới, không di trú; đọc một két v1 như v2 là đọc sai ô 6/12/14).
// `VaultTxAPI` phục vụ cả bốn đường `instant_gen · schedule_commit · schedule_fire ·
// consume`, và `service.ts` ▸ `scopesFor` chấp nhận `vaultType` BỎ TRỐNG — lúc đó nó
// quét mọi scope và loại két chỉ biết được SAU khi đọc xong datum. Nên chỗ này phải
// giải mã được cả hai hình dạng, và nó dùng `decodeVaultDatumEitherShape` của SDK
// (nguồn duy nhất) chứ không tự thử hai lần.

import { decodeVaultDatumEitherShape, type VaultDatumShapeKind } from "@magiclamp/sdk";
import { ownerRefOf, OwnerAuthError, type OwnerRef } from "@magiclamp/protocol-utils";

export interface DecodedMagicBatch {
  batch_id: string;
  created_epoch: bigint;
  initial_amount: bigint;
  current_amount: bigint;
  decay_window: bigint;
}

/** Chỉ khai các trường mã này ĐỌC. Phần còn lại của datum vẫn ở đó, chỉ là không dùng. */
export interface DecodedVaultDatum {
  /** Chủ là `Credential` trên chuỗi; ở đây đã đọc thành `{ type, hash }`. */
  owner: OwnerRef;
  lamp_balance: bigint;
  lamp_locked: bigint;
  magic_batches: DecodedMagicBatch[];
  gen_schedules: { schedule_id: string }[];
  last_updated_epoch: bigint;
  activity_state: { consumed_credit: bigint };
  /** Hình dạng datum ĐÃ ĐỌC ĐƯỢC — `"Instant"` (18 trường) hay `"Schedule"` (17).
   *  Suy từ chính datum, không phải từ tham số của yêu cầu. */
  vault_datum_kind: VaultDatumShapeKind;
  /** Trường 17 của két Instant. `null` ở két Schedule, nơi trường KHÔNG TỒN TẠI —
   *  không đệm `0n`, vì `0n` là giá trị hợp lệ của một két Instant chưa từng sinh. */
  instant_unlock_ms: bigint | null;
  /** Ô 12 két Instant (`cap_epoch`). `null` ở két Schedule — ô 12 ở đó vẫn là `delegation_cert`. */
  cap_epoch: bigint | null;
  /** Ô 14 két Instant (`cap_nanogic`, nanogic). `null` ở két Schedule. */
  cap_nanogic: bigint | null;
  /** Ô 6 két Instant (`wakeme_link`: "" hoặc owner_commit). `null` ở két Schedule. */
  wakeme_link: string | null;
  /** Cửa sổ dùng 7 ô — có ở CẢ HAI loại két từ v2.0. */
  usage_window: { generated: bigint; consumed: bigint }[];
  usage_window_epoch: bigint;
}

/** Giải mã bằng lược đồ THẬT của SDK, thử cả hai hình dạng. Ném khi không hình dạng
 *  nào khớp — người gọi chọn mã HTTP. Không có nhánh nào trả `null`. */
export function decodeVaultDatumOrThrow(hex: string): DecodedVaultDatum {
  const decoded = decodeVaultDatumEitherShape(hex);
  const datum = decoded.datum as unknown as DecodedVaultDatum;
  return {
    ...datum,
    owner: ownerRefOf((decoded.datum as unknown as { owner: unknown }).owner),
    vault_datum_kind: decoded.kind,
    instant_unlock_ms: decoded.instantUnlockMs,
    cap_epoch: decoded.kind === "Instant" ? decoded.datum.cap_epoch : null,
    cap_nanogic: decoded.kind === "Instant" ? decoded.datum.cap_nanogic : null,
    wakeme_link: decoded.kind === "Instant" ? decoded.datum.wakeme_link : null,
  };
}

/** pkh của chủ két — CHỈ cho két chủ-khoá. Các route theo `owner_pkh` chỉ phục vụ nhánh
 *  khoá; gặp két chủ-script thì NÉM, không trả hash script dưới nhãn `owner_pkh`. */
export function keyOwnerPkh(owner: OwnerRef): string {
  if (owner.type !== "key") {
    throw new OwnerAuthError(
      "OWNER_CREDENTIAL_SHAPE",
      `két này có chủ là script ${owner.hash}; trường owner_pkh chỉ mang được pkh của chủ-khoá.`,
    );
  }
  return owner.hash;
}
