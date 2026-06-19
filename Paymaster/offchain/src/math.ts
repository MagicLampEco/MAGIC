// src/math.ts — Paymaster Q-format tỷ giá + meter-state helpers. Pure BigInt,
// KHÔNG Number. P8 mirror BYTE-IDENTICAL onchain/lib/magiclamp/paymaster/math.ak
// + util.ak (lookup_did, add_did, sum_burns, dedup). NORMATIVE: SPEC-Paymaster §4.3.
//
//   lamp_cap = ⌊ magic_consumed × lamp_per_magic_q / Q ⌋    (oil)
//   ada_cap  = ⌊ magic_consumed × ada_per_magic_q  / Q ⌋    (lovelace)
//
// magic_consumed = Σ BurnBatch.burns (nanogic). Single-step floor (1 nhân, 1 chia) —
// đại lượng tuyến tính, bound rounding 0 (math.ak:6-9).

import { Q } from "@magiclamp/protocol-utils";

/** Scale factor Q (1 MAGIC = 1e9 nanogic). Khớp ProtocolUtils.Q + math.ak:12. */
export const q: bigint = Q; // 1_000_000_000n

/**
 * Trần LAMP (oil) app được sponsor cho magic_consumed (nanogic) tại tỷ giá Q-format.
 * Floor division BigInt. magic_consumed ≥ 0, rate ≥ 0 → kết quả ≥ 0. Mirror math.ak:16-18.
 */
export function lampCap(magicConsumed: bigint, lampPerMagicQ: bigint): bigint {
  return (magicConsumed * lampPerMagicQ) / q;
}

/** Trần ADA (lovelace) app được sponsor cho magic_consumed (nanogic). Mirror math.ak:21-23. */
export function adaCap(magicConsumed: bigint, adaPerMagicQ: bigint): bigint {
  return (magicConsumed * adaPerMagicQ) / q;
}

// ── BurnBatch reader helpers (mirror util.ak sum_burns / dedup) ────────────────

export type Burn = readonly [string, bigint]; // (asset_name_hex, amount_nanogic)

/** Σ amount trong burns. Mirror util.ak:93-95. */
export function sumBurns(burns: readonly Burn[]): bigint {
  return burns.reduce((acc, b) => acc + b[1], 0n);
}

// ── did_lamp_map helpers (mirror util.ak:138-165) ─────────────────────────────

export type DidLampEntry = readonly [string, bigint]; // (did_key_hex, lamp_sponsored_oil)

/** Lượng oil đã sponsor cho did_key trong map (0 nếu chưa có). Mirror util.ak:138-143. */
export function lookupDid(map: readonly DidLampEntry[], didKey: string): bigint {
  const e = map.find((x) => x[0] === didKey);
  return e ? e[1] : 0n;
}

// ── global_magic_epoch helper (mirror paymaster.ak global_magic_epoch transition) ──

/**
 * Tích lũy global_magic_epoch: reset về 0 ở epoch mới, cộng dồn cùng epoch.
 * base_magic = 0 khi epoch_rollover, ngược lại = meter_in.global_magic_epoch.
 * Mirror Aiken: global_magic_epoch = base_magic + magic_consumed.
 */
export function updateGlobalMagic(
  base_magic: bigint,
  magic_consumed: bigint,
): bigint {
  return base_magic + magic_consumed;
}

/**
 * Cộng `add` vào entry did_key (tạo mới ở CUỐI nếu chưa có). Giữ thứ tự; tối đa 1
 * entry/key. Mirror util.ak:146-165 BYTE-PERFECT để meter_out_datum.did_lamp_map ==
 * expected_map (validator ép bằng nhau, paymaster.ak:142-143).
 */
export function addDid(
  map: readonly DidLampEntry[],
  didKey: string,
  add: bigint,
): DidLampEntry[] {
  if (map.some((e) => e[0] === didKey)) {
    return map.map((e) => (e[0] === didKey ? ([e[0], e[1] + add] as DidLampEntry) : e));
  }
  return [...map, [didKey, add] as DidLampEntry];
}
