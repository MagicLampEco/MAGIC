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

import { Data } from "@lucid-evolution/lucid";
import { VaultDatumSchema } from "@magiclamp/sdk";

export interface DecodedMagicBatch {
  batch_id: string;
  created_epoch: bigint;
  initial_amount: bigint;
  current_amount: bigint;
  decay_window: bigint;
}

/** Chỉ khai các trường mã này ĐỌC. Phần còn lại của datum vẫn ở đó, chỉ là không dùng. */
export interface DecodedVaultDatum {
  owner: string;
  lamp_balance: bigint;
  lamp_locked: bigint;
  magic_batches: DecodedMagicBatch[];
  gen_schedules: { schedule_id: string }[];
  last_updated_epoch: bigint;
  activity_state: { consumed_credit: bigint };
}

/** Giải mã bằng lược đồ THẬT của SDK. Ném khi không khớp — người gọi chọn mã HTTP. */
export function decodeVaultDatumOrThrow(hex: string): DecodedVaultDatum {
  return Data.from(hex, VaultDatumSchema) as unknown as DecodedVaultDatum;
}
