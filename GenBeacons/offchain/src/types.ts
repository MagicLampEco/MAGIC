// GenBeacons/offchain/src/types.ts — lược đồ Plutus Data của ba beacon Gen v2.0 + sổ két.
//
// 🔴 HỢP ĐỒNG NHỊ PHÂN. Nguồn chân lý là mã Aiken:
//   GenBeacons/onchain/lib/genbeacons/types.ak ▸ `RateParam`, `GreenBackBeacon`, `GbShard`,
//   `VaultRegistry`, `GbShardRedeemer`.
// Thứ tự trường ở đây = thứ tự trường ở đó; `Data.Object` mã hoá thành Constr 0 theo thứ tự
// khai báo khoá. Giải mã Aiken nghiêm ngặt số trường CẢ HAI chiều (BOUNDARIES.md §2) — thêm,
// bớt, đảo một trường là mọi UTxO beacon đã tạo không đọc được nữa.
// Vector CBOR ghim hai bên: GenBeacons/onchain/lib/genbeacons/cbor_vectors.ak ↔
// tests/cborVectors.test.ts (đọc thẳng hằng hex từ tệp .ak, không chép số).

import { Data } from "@lucid-evolution/lucid";

/** Độ dài script hash / key hash (blake2b-224), byte. Khớp `constants.script_hash_length`. */
export const SCRIPT_HASH_BYTES = 28;

// ── RateParam — beacon suất sinh ρ ────────────────────────────────────────────

/** `RateParam { rho_q, prev_rho_q, effective_epoch }` — Q-format `Q = 10⁹`. */
export const RateParamSchema = Data.Object({
  rho_q: Data.Integer(),
  prev_rho_q: Data.Integer(),
  effective_epoch: Data.Integer(),
});
export type RateParam = Data.Static<typeof RateParamSchema>;
export const RateParam = RateParamSchema as unknown as RateParam;

// ── GreenBackBeacon — beacon thặng dư GreenBack ───────────────────────────────

/** `GreenBackBeacon { gb_nanogic, seq, epoch, depeg }`. `depeg: Bool` = Constr 0 (False) / 1 (True). */
export const GreenBackBeaconSchema = Data.Object({
  gb_nanogic: Data.Integer(),
  seq: Data.Integer(),
  epoch: Data.Integer(),
  depeg: Data.Boolean(),
});
export type GreenBackBeacon = Data.Static<typeof GreenBackBeaconSchema>;
export const GreenBackBeacon = GreenBackBeaconSchema as unknown as GreenBackBeacon;

// ── GbShard — một trong 16 shard của bộ đếm GB_available ─────────────────────

/** `GbShard { shard_id, seq, reset_amount, remaining }`. */
export const GbShardSchema = Data.Object({
  shard_id: Data.Integer(),
  seq: Data.Integer(),
  reset_amount: Data.Integer(),
  remaining: Data.Integer(),
});
export type GbShard = Data.Static<typeof GbShardSchema>;
export const GbShard = GbShardSchema as unknown as GbShard;

// ── VaultRegistry — sổ script két được phép đồng tiêu với shard ───────────────

/** `VaultRegistry { vault_script_hashes: List<ScriptHash> }` — Constr 0 bọc MỘT danh sách. */
export const VaultRegistrySchema = Data.Object({
  vault_script_hashes: Data.Array(
    Data.Bytes({ minLength: SCRIPT_HASH_BYTES, maxLength: SCRIPT_HASH_BYTES }),
  ),
});
export type VaultRegistry = Data.Static<typeof VaultRegistrySchema>;
export const VaultRegistry = VaultRegistrySchema as unknown as VaultRegistry;

// ── Redeemer ──────────────────────────────────────────────────────────────────

/**
 * `GbShardRedeemer::Draw { amount }` — constructor DUY NHẤT, chỉ số 0. Két đọc redeemer này
 * (purpose `Spend(shard_ref)`) để ép lượng nó sinh khớp `amount`, nên chỉ số 0 cũng là hợp
 * đồng nhị phân. Kiểu một-constructor của Aiken mã hoá y như bản ghi ⟹ `Data.Object`.
 */
export const GbShardRedeemerSchema = Data.Object({
  amount: Data.Integer(),
});
export type GbShardRedeemer = Data.Static<typeof GbShardRedeemerSchema>;
export const GbShardRedeemer = GbShardRedeemerSchema as unknown as GbShardRedeemer;

/**
 * Redeemer mint của cả bốn validator và redeemer spend của `rate_param` / `greenback_beacon`
 * có kiểu `Data` và bị BỎ QUA (`_redeemer: Data`). Dùng `Data.void()` (Constr 0 []) — mọi
 * giá trị đều qua, chọn một giá trị cố định cho giao dịch tất định.
 */
export const IGNORED_REDEEMER: string = Data.void();

// ── Apply-param ───────────────────────────────────────────────────────────────

/** `cardano/transaction.OutputReference { transaction_id, output_index }` (stdlib v3, PlutusV3 —
 *  `transaction_id` là ByteArray trần, KHÔNG bọc `TransactionId` như V2). */
export const OutputReferenceSchema = Data.Object({
  transaction_id: Data.Bytes({ minLength: 32, maxLength: 32 }),
  output_index: Data.Integer(),
});
export type OutputReference = Data.Static<typeof OutputReferenceSchema>;
export const OutputReference = OutputReferenceSchema as unknown as OutputReference;

// ── Mã hoá / giải mã có kiểm hình dạng ───────────────────────────────────────

export function encodeRateParam(d: RateParam): string {
  return Data.to(d, RateParam);
}
export function encodeGreenBackBeacon(d: GreenBackBeacon): string {
  return Data.to(d, GreenBackBeacon);
}
export function encodeGbShard(d: GbShard): string {
  return Data.to(d, GbShard);
}
export function encodeVaultRegistry(d: VaultRegistry): string {
  return Data.to(d, VaultRegistry);
}
export function encodeGbShardRedeemer(d: GbShardRedeemer): string {
  return Data.to(d, GbShardRedeemer);
}

/**
 * Giải mã datum inline theo lược đồ. Hình dạng lạ ⟹ NÉM kèm tên kiểu, không đệm giá trị.
 * `Data.from(raw, type)` của Lucid đã ném khi lệch lược đồ; bọc lại để thông điệp nói rõ
 * đang giải mã kiểu gì và từ UTxO nào.
 */
function decodeWith<T>(raw: string | undefined | null, type: T, typeName: string, where: string): T {
  if (raw == null || raw.length === 0) {
    throw new Error(`${where}: không có datum inline — không giải mã được ${typeName}.`);
  }
  try {
    return Data.from(raw, type);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${where}: datum không đúng hình dạng ${typeName} (${msg}).`);
  }
}

export function decodeRateParam(raw: string | undefined | null, where = "beacon ρ"): RateParam {
  return decodeWith(raw, RateParam, "RateParam", where);
}
export function decodeGreenBackBeacon(
  raw: string | undefined | null,
  where = "beacon GreenBack",
): GreenBackBeacon {
  return decodeWith(raw, GreenBackBeacon, "GreenBackBeacon", where);
}
export function decodeGbShard(raw: string | undefined | null, where = "shard GB"): GbShard {
  return decodeWith(raw, GbShard, "GbShard", where);
}
export function decodeVaultRegistry(
  raw: string | undefined | null,
  where = "sổ két",
): VaultRegistry {
  return decodeWith(raw, VaultRegistry, "VaultRegistry", where);
}
