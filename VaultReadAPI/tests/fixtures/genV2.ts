// VaultReadAPI/tests/fixtures/genV2.ts — datum két Gen v2.0 lấy từ VECTOR GỐC, không chép hex.
//
// Hai nguồn, cả hai là vector hai phía (Aiken ↔ TypeScript) đã ghim byte-đối-byte:
//   · két Instant (20 trường) — `InstantGen/tests/vectors.ts` ▸ `TV_DATUM_V2_GENESIS`,
//     `TV_DATUM_V2_FULL`. Nạp CHÍNH module đó lúc chạy, nên đổi vector là mẫu đổi theo.
//     Nạp bằng `import()` với specifier là BIẾN, không phải `import` tĩnh: tệp vector
//     không sạch dưới cấu hình `strict` của gói này (đo 2026-09-30: 29 lỗi TS2353 ở các
//     bảng vector KHÁC, không ở hai vector dùng đây), và `tsc -p .` của gói này đi theo
//     import tĩnh sang kiểm cả tệp đó. Kiểu của hai vector khai ở `DatumVectorV2` dưới —
//     bản chép hình dạng; lệch thì bài `genV2View.test.ts` đỏ vì giá trị so không khớp.
//   · két Schedule (19 trường) — `ScheduleGen/onchain/lib/magiclamp/protocol/datum_cbor_vectors.ak`
//     ▸ hằng `tv_cbor_vault_one_schedule_hex`. ĐỌC từ tệp .ak lúc chạy, cùng cách
//     `ScheduleGen/tests/datumV2.test.ts` làm — không có bản TS nào của chuỗi này để nhập.
//
// Các biến thể (bỏ trường ⟹ v1, đổi một ô) dựng bằng `Constr` trên CHÍNH chuỗi vector, để
// mỗi cặp ca chỉ khác nhau đúng một chỗ.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Constr, Data } from "@lucid-evolution/lucid";

/** Chỉ các trường bài kiểm đọc. Nguồn: `InstantGen/tests/vectors.ts` ▸ `TV_DATUM_V2_FULL`. */
export interface DatumVectorV2 {
  id: string;
  cbor: string;
  value: {
    lamp_balance: bigint;
    lamp_locked: bigint;
    magic_batches: readonly { current_amount: bigint }[];
    wakeme_link: string;
    gen_schedules: readonly { fired_count: bigint }[];
    profile: string;
    last_updated_epoch: bigint;
    cap_epoch: bigint;
    activity_state: { consumed_credit: bigint };
    cap_nanogic: bigint;
    instant_unlock_ms: bigint;
    usage_window: readonly { generated: bigint; consumed: bigint }[];
    usage_window_epoch: bigint;
  };
}

const INSTANT_VECTORS_URL = new URL("../../../InstantGen/tests/vectors.ts", import.meta.url).href;
const instantVectors = (await import(INSTANT_VECTORS_URL)) as Record<string, unknown>;

function vector(name: string): DatumVectorV2 {
  const v = instantVectors[name] as DatumVectorV2 | undefined;
  if (v === undefined || typeof v.cbor !== "string") {
    throw new Error(`fixture: InstantGen/tests/vectors.ts không xuất ${name}`);
  }
  return v;
}

export const TV_DATUM_V2_FULL = vector("TV_DATUM_V2_FULL");
export const TV_DATUM_V2_GENESIS = vector("TV_DATUM_V2_GENESIS");

const SCHEDULE_VECTORS_AK = fileURLToPath(new URL(
  "../../../ScheduleGen/onchain/lib/magiclamp/protocol/datum_cbor_vectors.ak", import.meta.url,
));

/** Đọc một hằng `ByteArray` hex từ tệp vector Aiken. Không thấy ⟹ NÉM (không trả rỗng). */
function readAkHex(name: string): string {
  const src = readFileSync(SCHEDULE_VECTORS_AK, "utf8");
  const m = src.match(new RegExp(`const ${name}: ByteArray =\\s*#"([0-9a-f]+)"`));
  if (m === null) throw new Error(`fixture: không thấy hằng ${name} trong datum_cbor_vectors.ak`);
  return m[1]!;
}

/** Két Schedule v2.0 sau MỘT lượt ký (`tv_one_schedule` trong tệp .ak). */
export const SCHEDULE_V2_ONE_SCHEDULE_HEX = readAkHex("tv_cbor_vault_one_schedule_hex");

/** Giá trị của `tv_one_schedule` / `tv_schedule` — CHÉP CÓ NHÃN từ
 *  `datum_cbor_vectors.ak` ▸ `tv_one_schedule`, `tv_schedule` (2026-09-30, HEAD 1509d2c5).
 *  Bài kiểm so hex đọc từ tệp với các số này; tệp .ak đổi mà đây không đổi ⟹ bài đỏ. */
export const SCHEDULE_V2_EXPECT = {
  ownerPkh: "0a".repeat(28),
  lampBalance: 100_000_000_000n,
  lampLocked: 10_000_000_000n,
  lastUpdatedEpoch: 100n,
  usageWindowEpoch: 100n,
  mPerEpoch: 3_000_000_000n,
  usageFactorLockedQ: 750_000_000n,
  rateLockedQ: 8_000_000_000n,
} as const;

// ── Biến thể dựng trên chuỗi vector ────────────────────────────────────────────

function outer(hex: string): Constr<Data> {
  const d = Data.from(hex);
  if (!(d instanceof Constr) || d.index !== 0) throw new Error("fixture: datum không phải Constr 0");
  return d;
}

/** Bỏ `n` trường CUỐI — 20 → 18 là đúng hình dạng két Instant v1, 19 → 17 là Schedule v1
 *  (v2.0 chỉ NỐI CUỐI hai ô cửa sổ; phần đầu giữ nguyên chỉ số). */
export function dropTrailingFields(hex: string, n: number): string {
  const d = outer(hex);
  return Data.to(new Constr(0, d.fields.slice(0, d.fields.length - n)));
}

/** Thay đúng MỘT trường ở chỉ số `idx`, giữ nguyên mọi trường khác. */
export function withField(hex: string, idx: number, value: Data): string {
  const d = outer(hex);
  if (idx < 0 || idx >= d.fields.length) throw new Error(`fixture: chỉ số ${idx} ngoài datum`);
  const fields = [...d.fields];
  fields[idx] = value;
  return Data.to(new Constr(0, fields));
}

/** Một ô `EpochUsage { generated, consumed }` dạng Plutus Data. */
export const epochUsage = (generated: bigint, consumed: bigint): Data => new Constr(0, [generated, consumed]);
