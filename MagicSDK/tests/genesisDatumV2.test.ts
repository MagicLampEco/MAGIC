// MagicSDK/tests/genesisDatumV2.test.ts — datum khởi sinh do SDK dựng, so TỪNG BYTE với
// vector của gói nền (Gen v2.0).
//
// Hai nguồn đối chiếu, mỗi nguồn là hợp đồng nhị phân của module mình:
//   Instant  ▸ `InstantGen/tests/vectors.ts` ▸ `TV_DATUM_V2_GENESIS` (20 trường) — cùng chuỗi
//              được bài Aiken `datum_vectors_test.ak` ghim ở phía on-chain.
//   Schedule ▸ `ScheduleGen/onchain/lib/magiclamp/protocol/datum_cbor_vectors.ak`
//              ▸ `tv_cbor_vault_genesis_hex` (19 trường) — bytes do chính Aiken sinh.
//
// Cả hai vector được ĐỌC DẠNG VĂN BẢN từ tệp nguồn, không import: `tsconfig.test.json` đặt
// `rootDir` ở gói này, và một bản chép tay chuỗi hex vào đây là bản sao chết im lặng khi gói
// nền đổi vector. Không thấy hằng ⟹ bài NÉM, không xanh trên chuỗi rỗng.
//
// Giá trị dựng khớp đúng giá trị của vector: owner khoá, `lamp_balance`, profile `Flame`,
// epoch tạo 0 (⟹ holding `acquired_epoch = 0`). Bytes bằng nhau ⟹ mọi ô bằng nhau, kể cả
// những ô SDK tự đặt (hạt giống Wakeme, cửa sổ 7 ô 0, `usage_window_epoch = 0`).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Data } from "@lucid-evolution/lucid";

import { buildInitialVaultDatum } from "../src/vaultDatum.js";
import { InstantVaultDatumSchema, VaultDatumSchema } from "../src/schemas.js";

const repoFile = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");

/** `cbor:` của một vector trong `vectors.ts` — nối mọi mảnh `"…"` tới dấu `,` kết thúc. */
function tsVectorCbor(name: string): string {
  const src = repoFile("InstantGen/tests/vectors.ts");
  const start = src.indexOf(`export const ${name} = {`);
  if (start < 0) throw new Error(`không thấy ${name} trong InstantGen/tests/vectors.ts`);
  const body = src.slice(start, src.indexOf("\n};", start));
  const m = body.match(/\bcbor\s*:\s*((?:\s*"[0-9a-f]*"\s*\+?)+)/);
  if (!m) throw new Error(`${name}: không thấy trường cbor`);
  const hex = [...m[1]!.matchAll(/"([0-9a-f]*)"/g)].map(x => x[1]).join("");
  if (hex.length === 0 || hex.length % 2 !== 0) throw new Error(`${name}: cbor rỗng hoặc lẻ ký tự`);
  return hex;
}

/** Hằng `ByteArray` trong `datum_cbor_vectors.ak` — cùng phép đọc `ScheduleGen/tests/datumV2.test.ts`. */
function akVectorHex(name: string): string {
  const src = repoFile("ScheduleGen/onchain/lib/magiclamp/protocol/datum_cbor_vectors.ak");
  const m = src.match(new RegExp(`const ${name}: ByteArray =\\s*#"([0-9a-f]+)"`));
  if (!m) throw new Error(`không thấy hằng ${name} trong datum_cbor_vectors.ak`);
  return m[1]!;
}

// ── Giá trị của hai vector ──────────────────────────────────────────────────────
const INSTANT_OWNER = "11".repeat(28);        // TV_DATUM_V2_GENESIS.value.owner
const INSTANT_LAMP  = 100_000_000n;           // TV_DATUM_V2_GENESIS.value.lamp_balance
const SCHEDULE_OWNER = "0a".repeat(28);       // datum_cbor_vectors.ak ▸ tv_owner_pkh
const SCHEDULE_LAMP  = 100_000_000_000n;      // datum_cbor_vectors.ak ▸ tv_genesis.lamp_balance

const instantGenesis = () => buildInitialVaultDatum({
  ownerPkh: INSTANT_OWNER, lampBalanceOildrop: INSTANT_LAMP, profile: "Flame",
  currentEpoch: 0n, vaultType: "Instant",
});
const scheduleGenesis = () => buildInitialVaultDatum({
  ownerPkh: SCHEDULE_OWNER, lampBalanceOildrop: SCHEDULE_LAMP, profile: "Flame",
  currentEpoch: 0n, vaultType: "Schedule",
});

describe("genesis Instant (20 trường) — trùng byte TV_DATUM_V2_GENESIS", () => {
  const vector = tsVectorCbor("TV_DATUM_V2_GENESIS");

  it("Data.to(buildInitialVaultDatum) == vector, từng byte", () => {
    expect(Data.to(instantGenesis() as never, InstantVaultDatumSchema)).toBe(vector);
  });

  it("giải mã vector bằng lược đồ SDK ra đúng datum SDK dựng", () => {
    expect(Data.from(vector, InstantVaultDatumSchema)).toEqual(instantGenesis());
  });

  // Cực đối: mỗi ô dưới đây đổi một giá trị mà cổng đúc ép. Bytes phải khác — nếu bằng thì
  // phép so ở trên không phân biệt được ô đó, tức nó không ghim gì.
  it.each([
    ["usage_window_epoch 0→1", { usage_window_epoch: 1n }],
    ["cap_epoch 0→1",          { cap_epoch: 1n }],
    ["cap_nanogic 0→1",        { cap_nanogic: 1n }],
    ["instant_unlock_ms 0→1",  { instant_unlock_ms: 1n }],
    ["wakeme_link \"\"→32B",   { wakeme_link: "ef".repeat(32) }],
  ] as const)("đổi %s ⟹ bytes khác vector", (_n, over) => {
    expect(Data.to({ ...instantGenesis(), ...over } as never, InstantVaultDatumSchema)).not.toBe(vector);
  });

  it("hạt giống consumed_credit là một phần của bytes — Instant ≠ 0", () => {
    const g = instantGenesis();
    const zeroSeed = { ...g, activity_state: { ...g.activity_state, consumed_credit: 0n } };
    expect(Data.to(zeroSeed as never, InstantVaultDatumSchema)).not.toBe(vector);
  });
});

describe("genesis Schedule (19 trường) — trùng byte tv_cbor_vault_genesis_hex", () => {
  const vector = akVectorHex("tv_cbor_vault_genesis_hex");

  it("Data.to(buildInitialVaultDatum) == vector Aiken, từng byte", () => {
    expect(Data.to(scheduleGenesis() as never, VaultDatumSchema)).toBe(vector);
  });

  it("giải mã vector bằng lược đồ SDK ra đúng datum SDK dựng", () => {
    expect(Data.from(vector, VaultDatumSchema)).toEqual(scheduleGenesis());
  });

  it.each([
    ["usage_window_epoch 0→1",       (d: ReturnType<typeof scheduleGenesis>) => ({ ...d, usage_window_epoch: 1n })],
    ["usage_window ô 0 generated 0→1", (d: ReturnType<typeof scheduleGenesis>) => ({
      ...d, usage_window: d.usage_window.map((u, i) => (i === 0 ? { ...u, generated: 1n } : u)),
    })],
    ["consumed_credit 0→hạt giống",  (d: ReturnType<typeof scheduleGenesis>) => ({
      ...d, activity_state: { ...d.activity_state, consumed_credit: 1_001_000_000_000n },
    })],
  ] as const)("đổi %s ⟹ bytes khác vector", (_n, mutate) => {
    expect(Data.to(mutate(scheduleGenesis()) as never, VaultDatumSchema)).not.toBe(vector);
  });

  it("hai module ghim HAI hình dạng: bytes Instant ≠ bytes Schedule dù cùng owner/LAMP", () => {
    const common = { ownerPkh: INSTANT_OWNER, lampBalanceOildrop: INSTANT_LAMP, profile: "Flame" as const, currentEpoch: 0n };
    const i = Data.to(buildInitialVaultDatum({ ...common, vaultType: "Instant" }) as never, InstantVaultDatumSchema);
    const s = Data.to(buildInitialVaultDatum({ ...common, vaultType: "Schedule" }) as never, VaultDatumSchema);
    expect(i).not.toBe(s);
  });
});
