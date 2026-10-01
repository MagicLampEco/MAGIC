// tests/genV2Fixtures.ts — datum két Gen v2.0 dạng Plutus Data thô cho bài kiểm của
// `buildConsumeTx` / `checkGenV2Burn` (gói d4, #128).
//
// Chỉ các ô mà phía consume ĐỌC mang giá trị có nghĩa: trường 0 (owner, `consume.ak ▸
// all_vault_owners_are`) và các ô checkpoint Gen v2.0. Mọi ô khác là số 0 giữ chỗ — bộ
// dựng không giải mã chúng, và đặt chúng ở ĐÚNG SỐ TRƯỜNG là thứ duy nhất cần ghim.
// Chỉ số trường: InstantGen/onchain/lib/magiclamp/protocol/types.ak ▸ `VaultDatum` (20),
// ScheduleGen/onchain/lib/magiclamp/protocol/types.ak ▸ `VaultDatum` (19).

import { Constr, Data } from "@lucid-evolution/lucid";

export type Cell = readonly [bigint, bigint];   // (generated, consumed)

export const zeroWindow = (): Cell[] => Array.from({ length: 7 }, () => [0n, 0n] as const);

const windowData = (w: readonly Cell[]) => w.map(([g, c]) => new Constr(0, [g, c]));

export type OwnerCred = { VerificationKey: [string] } | { Script: [string] };

export const ownerData = (o: OwnerCred) =>
  "VerificationKey" in o ? new Constr(0, [o.VerificationKey[0]]) : new Constr(1, [o.Script[0]]);

export interface IgCheckpoint {
  link: string;
  capEpoch: bigint;
  capNanogic: bigint;
  window: readonly Cell[];
  windowEpoch: bigint;
}

/** Datum InstantGen v2.0 — 20 trường. */
export function igDatum(owner: OwnerCred, cp: IgCheckpoint): string {
  const f: unknown[] = Array.from({ length: 20 }, () => 0n);
  f[0] = ownerData(owner);
  f[6] = cp.link;
  f[12] = cp.capEpoch;
  f[14] = cp.capNanogic;
  f[18] = windowData(cp.window);
  f[19] = cp.windowEpoch;
  return Data.to(new Constr(0, f as never[]));
}

/** Datum ScheduleGen v2.0 — 19 trường. */
export function sgDatum(owner: OwnerCred, window: readonly Cell[], windowEpoch: bigint): string {
  const f: unknown[] = Array.from({ length: 19 }, () => 0n);
  f[0] = ownerData(owner);
  f[17] = windowData(window);
  f[18] = windowEpoch;
  return Data.to(new Constr(0, f as never[]));
}

/** Datum với `n` trường bất kỳ (ca đời v1 / hình lạ). */
export function nFieldDatum(owner: OwnerCred, n: number): string {
  const f: unknown[] = Array.from({ length: n }, () => 0n);
  f[0] = ownerData(owner);
  return Data.to(new Constr(0, f as never[]));
}

/** Redeemer `BurnBatch { burns }` — Constr 2, burns = List<[bytes, int]>. */
export function burnRedeemer(amounts: readonly bigint[], constr = 2): string {
  return Data.to(new Constr(constr, [amounts.map((a, i) => [("b" + i).padEnd(64, "0"), a])] as never[]));
}

/** Datum két Wakeme tối thiểu (13 trường) — gương các vế `read_one_vault` đọc. */
export function wakemeDatum(opts: {
  ownerCommit: string;
  pinnedVaultHash: string;
  pinnedVaultName: string;
  conditional?: bigint;
  owned?: bigint;
  pinPeriod?: bigint;
}): string {
  const f: unknown[] = Array.from({ length: 13 }, () => 0n);
  f[0] = opts.ownerCommit;
  f[3] = opts.conditional ?? 0n;
  f[7] = opts.owned ?? 0n;
  f[11] = new Constr(0, [new Constr(0, [opts.pinnedVaultHash, opts.pinnedVaultName])]);
  f[12] = opts.pinPeriod ?? 0n;
  return Data.to(new Constr(0, f as never[]));
}

/** Datum `RateParam { rho_q, prev_rho_q, effective_epoch }`. */
export const rateDatum = (rho: bigint, prev: bigint, effective: bigint): string =>
  Data.to(new Constr(0, [rho, prev, effective]));
