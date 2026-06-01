// LampDistribution datum/redeemer codec — Plutus Data (Lucid Evolution).
//
// PHẢI khớp byte-perfect với onchain `types.ak`. Constr index = thứ tự khai báo
// trong types.ak (Aiken đánh số constructor theo thứ tự xuất hiện, bắt đầu 0).
//
//   ClaimAccountDatum{owner, claimed_cumulative, redeemed_cumulative, last_claim_epoch}
//     = Constr(0, [bytes, int, int, int])
//
//   ClaimAccountRedeemer:
//     Claim {amount}                                = Constr(0, [int])
//     Redeem {won_cumulative, lottery_epoch, proof} = Constr(1, [int, int, List<bytes>])
//
//   BeaconKind:  PParam = Constr(0,[]), Randomness = Constr(1,[]), MerkleRoot = Constr(2,[])
//   BeaconDatum{epoch, kind, value}                 = Constr(0, [int, kind, bytes])
//   BeaconRedeemer: PostBeacon                       = Constr(0, [])
//
//   TreasuryDatum{committee_hash}                    = Constr(0, [bytes])
//   TreasuryRedeemer: ReleaseForRedeem               = Constr(0, [])
//
// LƯU Ý ORCHESTRATOR: onchain repo CHƯA có plutus.json/validators build output
// (chỉ có lib/types.ak). Không thể resolve constr index runtime như withdrawLamp.ts
// → ta hardcode index theo types.ak ĐÃ XÁC NHẬN. Khi onchain build ra plutus.json,
// nên thêm cross-check (resolveConstrIndex) để chống desync.

import { Constr, Data } from "@lucid-evolution/lucid";
import type { BeaconDatum, BeaconKind, ClaimAccountDatum, TreasuryDatum } from "./types.js";

// ── Constructor index map (mirror types.ak declaration order) ──────────

/** ClaimAccountRedeemer variants. */
export const CLAIM_ACCOUNT_REDEEMER = { Claim: 0, Redeem: 1 } as const;

/** BeaconKind variants (PParam | Randomness | MerkleRoot). */
export const BEACON_KIND_INDEX: Record<BeaconKind, number> = {
  PParam:     0,
  Randomness: 1,
  MerkleRoot: 2,
};

const BEACON_KIND_FROM_INDEX: Record<number, BeaconKind> = {
  0: "PParam",
  1: "Randomness",
  2: "MerkleRoot",
};

// ── helpers ────────────────────────────────────────────────────────────

/** Strip leading `0x` and lowercase a hex string (Plutus bytes are bare hex). */
function normHex(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return h.toLowerCase();
}

function asConstr(d: Data, ctx: string): Constr<Data> {
  if (d instanceof Constr) return d;
  // Robust với trường hợp có 2 bản @lucid-evolution/lucid khác nhau (offchain vs scripts):
  // `instanceof` fail vì khác class identity, dù object đúng cấu trúc Constr {index:number, fields:[]}.
  if (
    d !== null && typeof d === "object" &&
    typeof (d as { index?: unknown }).index === "number" &&
    Array.isArray((d as { fields?: unknown }).fields)
  ) {
    return d as unknown as Constr<Data>;
  }
  throw new Error(`DATUM-000: expected Constr for ${ctx}`);
}

function asBytes(d: Data, ctx: string): string {
  if (typeof d !== "string") throw new Error(`DATUM-001: expected bytes for ${ctx}`);
  return d;
}

function asInt(d: Data, ctx: string): bigint {
  if (typeof d !== "bigint") throw new Error(`DATUM-002: expected int for ${ctx}`);
  return d;
}

// ── BeaconKind ─────────────────────────────────────────────────────────

export function encodeBeaconKind(kind: BeaconKind): Constr<Data> {
  return new Constr(BEACON_KIND_INDEX[kind], []);
}

export function decodeBeaconKind(d: Data): BeaconKind {
  const c = asConstr(d, "BeaconKind");
  if (c.fields.length !== 0) throw new Error("DATUM-010: BeaconKind takes no fields");
  const kind = BEACON_KIND_FROM_INDEX[c.index];
  if (kind === undefined) throw new Error(`DATUM-011: unknown BeaconKind index ${c.index}`);
  return kind;
}

// ── ClaimAccountDatum ──────────────────────────────────────────────────
// Constr(0, [owner:bytes, claimed_cumulative:int, redeemed_cumulative:int, last_claim_epoch:int])

export function encodeClaimAccountDatum(d: ClaimAccountDatum): Constr<Data> {
  return new Constr(0, [
    normHex(d.owner),
    d.claimed_cumulative,
    d.redeemed_cumulative,
    d.last_claim_epoch,
  ]);
}

export function decodeClaimAccountDatum(d: Data): ClaimAccountDatum {
  const c = asConstr(d, "ClaimAccountDatum");
  if (c.index !== 0) throw new Error(`DATUM-020: ClaimAccountDatum expects Constr 0, got ${c.index}`);
  if (c.fields.length !== 4) throw new Error(`DATUM-021: ClaimAccountDatum expects 4 fields, got ${c.fields.length}`);
  return {
    owner:               asBytes(c.fields[0]!, "owner"),
    claimed_cumulative:  asInt(c.fields[1]!, "claimed_cumulative"),
    redeemed_cumulative: asInt(c.fields[2]!, "redeemed_cumulative"),
    last_claim_epoch:    asInt(c.fields[3]!, "last_claim_epoch"),
  };
}

/** CBOR datum hex string (inline datum). */
export function claimAccountDatumToCbor(d: ClaimAccountDatum): string {
  return Data.to(encodeClaimAccountDatum(d));
}

export function claimAccountDatumFromCbor(cbor: string): ClaimAccountDatum {
  return decodeClaimAccountDatum(Data.from(cbor));
}

// ── ClaimAccountRedeemer ───────────────────────────────────────────────

/** Claim { amount } = Constr(0, [int]). */
export function encodeClaimRedeemer(amount: bigint): Constr<Data> {
  return new Constr(CLAIM_ACCOUNT_REDEEMER.Claim, [amount]);
}

/**
 * Redeem { won_cumulative, lottery_epoch, proof } = Constr(1, [int, int, List<bytes>]).
 * `proof` là danh sách sibling hash (hex) từ buildMerkleTree (foundation).
 */
export function encodeRedeemRedeemer(
  wonCumulative: bigint,
  lotteryEpoch:  bigint,
  proofHex:      string[],
): Constr<Data> {
  const proof: Data[] = proofHex.map(normHex);
  return new Constr(CLAIM_ACCOUNT_REDEEMER.Redeem, [wonCumulative, lotteryEpoch, proof]);
}

export function claimRedeemerToCbor(amount: bigint): string {
  return Data.to(encodeClaimRedeemer(amount));
}

export function redeemRedeemerToCbor(
  wonCumulative: bigint,
  lotteryEpoch:  bigint,
  proofHex:      string[],
): string {
  return Data.to(encodeRedeemRedeemer(wonCumulative, lotteryEpoch, proofHex));
}

// ── BeaconDatum ────────────────────────────────────────────────────────
// Constr(0, [epoch:int, kind:BeaconKind, value:bytes])

export function encodeBeaconDatum(d: BeaconDatum): Constr<Data> {
  return new Constr(0, [d.epoch, encodeBeaconKind(d.kind), normHex(d.value)]);
}

export function decodeBeaconDatum(d: Data): BeaconDatum {
  const c = asConstr(d, "BeaconDatum");
  if (c.index !== 0) throw new Error(`DATUM-030: BeaconDatum expects Constr 0, got ${c.index}`);
  if (c.fields.length !== 3) throw new Error(`DATUM-031: BeaconDatum expects 3 fields, got ${c.fields.length}`);
  return {
    epoch: asInt(c.fields[0]!, "epoch"),
    kind:  decodeBeaconKind(c.fields[1]!),
    value: asBytes(c.fields[2]!, "value"),
  };
}

export function beaconDatumToCbor(d: BeaconDatum): string {
  return Data.to(encodeBeaconDatum(d));
}

export function beaconDatumFromCbor(cbor: string): BeaconDatum {
  return decodeBeaconDatum(Data.from(cbor));
}

/** BeaconRedeemer: PostBeacon = Constr(0, []). */
export function encodeBeaconRedeemer(): Constr<Data> {
  return new Constr(0, []);
}

export function beaconRedeemerToCbor(): string {
  return Data.to(encodeBeaconRedeemer());
}

// ── TreasuryDatum ──────────────────────────────────────────────────────
// Constr(0, [committee_hash:bytes])

export function encodeTreasuryDatum(d: TreasuryDatum): Constr<Data> {
  return new Constr(0, [normHex(d.committee_hash)]);
}

export function decodeTreasuryDatum(d: Data): TreasuryDatum {
  const c = asConstr(d, "TreasuryDatum");
  if (c.index !== 0) throw new Error(`DATUM-040: TreasuryDatum expects Constr 0, got ${c.index}`);
  if (c.fields.length !== 1) throw new Error(`DATUM-041: TreasuryDatum expects 1 field, got ${c.fields.length}`);
  return { committee_hash: asBytes(c.fields[0]!, "committee_hash") };
}

export function treasuryDatumToCbor(d: TreasuryDatum): string {
  return Data.to(encodeTreasuryDatum(d));
}

export function treasuryDatumFromCbor(cbor: string): TreasuryDatum {
  return decodeTreasuryDatum(Data.from(cbor));
}

/** TreasuryRedeemer: ReleaseForRedeem = Constr(0, []). */
export function encodeTreasuryRedeemer(): Constr<Data> {
  return new Constr(0, []);
}

export function treasuryRedeemerToCbor(): string {
  return Data.to(encodeTreasuryRedeemer());
}
