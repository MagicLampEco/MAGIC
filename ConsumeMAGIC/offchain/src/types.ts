// src/types.ts — ConsumeMAGIC v2 ENGAGEMENT layer codec (Lucid Evolution Data).
//
// Mirror byte-perfect của onchain/lib/magiclamp/consume/types.ak. Constructor index
// = THỨ TỰ KHAI BÁO field trong Aiken type → Plutus Data encoding. Đảo thứ tự 1 bên
// = vỡ decode bên kia (CLAUDE.md P8). KHÔNG liên quan _appeconomics_legacy.ts (v1).
//
// Bảng constr (khớp types.ak):
//   OutputReference { transaction_id: ByteArray, output_index: Int }   constr 0
//   OpPrice         { op_type, base_price }                            constr 0
//   PriceParam      { op_prices, demand_mult, m_min, m_max, epoch }    constr 0
//   EngageDatum     { owner, consumed_count, last_epoch, did_commit }  constr 0
//   ConsumeRedeemer = Consume { op_type, op_count, price_ref, vault_ref }  constr 0

import { Data } from "@lucid-evolution/lucid";

// ── OutputReference (cardano/transaction.OutputReference) ─────────────────────
// Aiken: OutputReference { transaction_id: ByteArray, output_index: Int }.
export const OutputReferenceSchema = Data.Object({
  transaction_id: Data.Bytes(),
  output_index: Data.Integer(),
});
export type OutputReferenceT = Data.Static<typeof OutputReferenceSchema>;

// ── OpPrice ───────────────────────────────────────────────────────────────────
export const OpPriceSchema = Data.Object({
  op_type: Data.Integer(),
  base_price: Data.Integer(),
});
export type OpPriceT = Data.Static<typeof OpPriceSchema>;

// ── PriceParam (beacon datum) ─────────────────────────────────────────────────
export const PriceParamSchema = Data.Object({
  op_prices: Data.Array(OpPriceSchema),
  demand_mult: Data.Integer(),
  m_min: Data.Integer(),
  m_max: Data.Integer(),
  epoch: Data.Integer(),
});
export type PriceParamT = Data.Static<typeof PriceParamSchema>;

// ── EngageDatum (state per-app) ───────────────────────────────────────────────
// did_commit APPEND-ONLY (field cuối). MVP = "" (empty hex). Immutable on-chain.
export const EngageDatumSchema = Data.Object({
  owner: Data.Bytes(),
  consumed_count: Data.Integer(),
  last_epoch: Data.Integer(),
  did_commit: Data.Bytes(),
});
export type EngageDatumT = Data.Static<typeof EngageDatumSchema>;

// ── ConsumeRedeemer = Consume { op_type, op_count, price_ref, vault_ref } ──────
// Aiken: enum 1 constr → Plutus Constr(0, [op_type, op_count, price_ref, vault_ref]).
// Lucid: 1-variant enum encode = Data.Object (Constr 0, field theo thứ tự khai báo).
// KHÔNG dùng Data.Enum 1-phần-tử (Lucid 0.4.x cast lỗi "Could not type cast to
// constructor" khi variant >1 field). Data.Object cho RA ĐÚNG bytes Constr 0.
export const ConsumeRedeemerSchema = Data.Object({
  op_type: Data.Integer(),
  op_count: Data.Integer(),
  price_ref: OutputReferenceSchema,
  vault_ref: OutputReferenceSchema,
});
export type ConsumeRedeemerT = Data.Static<typeof ConsumeRedeemerSchema>;

// ── PriceParamRedeemer = PostPrice (constr 0) ─────────────────────────────────
export const PriceParamRedeemerSchema = Data.Enum([Data.Literal("PostPrice")]);

// ── NftRedeemer = MintGenesis (constr 0) — dùng cho price_nft & engage_nft ─────
export const NftRedeemerSchema = Data.Enum([Data.Literal("MintGenesis")]);

// ── codec helpers (datum/redeemer ⇄ CBOR hex) ─────────────────────────────────
// Lucid 0.4.x: `Data.to(value, Schema)` cần Schema ép `as unknown as T` (idiom
// chính thống lucid-evolution — TSchema runtime ≠ Data.Static<T> ở mức type).
export const encodeEngageDatum = (d: EngageDatumT): string =>
  Data.to(d, EngageDatumSchema as unknown as EngageDatumT);
export const decodeEngageDatum = (cbor: string): EngageDatumT =>
  Data.from(cbor, EngageDatumSchema as unknown as EngageDatumT);

export const encodePriceParam = (p: PriceParamT): string =>
  Data.to(p, PriceParamSchema as unknown as PriceParamT);
export const decodePriceParam = (cbor: string): PriceParamT =>
  Data.from(cbor, PriceParamSchema as unknown as PriceParamT);

export const encodeConsumeRedeemer = (r: ConsumeRedeemerT): string =>
  Data.to(r, ConsumeRedeemerSchema as unknown as ConsumeRedeemerT);
