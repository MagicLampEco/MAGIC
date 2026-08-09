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
//   EngageDatum     { owner, consumed_count, last_epoch, did_commit,
//                     consumed_nanogic }                               constr 0
//   ConsumeRedeemer     = Consume     { op_type, op_count, price_ref, vault_ref } constr 0
//   EngageMintRedeemer  = MintEngage  { seed: OutputReference }                   constr 0

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

// ── EngageDatum (state per-app) — 5 TRƯỜNG ────────────────────────────────────
// Thứ tự = thứ tự khai báo trong types.ak. Hai trường được THÊM Ở CUỐI theo
// nguyên tắc APPEND-ONLY (không dịch chỉ số field cũ):
//   did_commit       — MVP = "" (rỗng). Immutable on-chain sau genesis.
//   consumed_nanogic — tổng GIÁ TRỊ (nanogic) đã tiêu tích luỹ trên thread.
//
// ⚠ consumed_nanogic KHÔNG phải trường trang trí: validator ép bất biến THỨ HAI
//   `Σ consumed_nanogic(out) == Σ(in) + total_required`, song song với bất biến
//   đếm LƯỢT. App xác nhận thanh toán PHẢI đọc DELTA của trường này, KHÔNG đọc
//   consumed_count (count không phân biệt op rẻ / op đắt — trả 1e6 rồi đòi dịch
//   vụ 1e7 vẫn làm count +1). Xem EXEC.md §"Xác nhận thanh toán".
//   Thiếu trường này ⇒ Constr 0 có 4 field ⇒ `expect ed: EngageDatum` on-chain
//   nổ ⇒ mọi tx mint/spend Engage bị từ chối.
export const EngageDatumSchema = Data.Object({
  owner: Data.Bytes(),
  consumed_count: Data.Integer(),
  last_epoch: Data.Integer(),
  did_commit: Data.Bytes(),
  consumed_nanogic: Data.Integer(),
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

// ── EngageMintRedeemer = MintEngage { seed } (constr 0) ───────────────────────
// Handler `mint` nằm TRONG chính validator `consume` (multi-purpose): policy id
// của thread NFT == script hash của `consume` sau khi apply 7 param. KHÔNG còn
// validator `engage_nft.ak`, KHÔNG còn apply-param engage_nft_policy/name.
//
// Aiken: `EngageMintRedeemer { MintEngage { seed: OutputReference } }` — enum 1
// variant, 1 field ⇒ Constr 0 [ Constr 0 [bytes, int] ]. Dùng Data.Object vì lý do
// y hệt ConsumeRedeemer (Lucid 0.4.x cast lỗi với Data.Enum 1-phần-tử nhiều field).
export const EngageMintRedeemerSchema = Data.Object({
  seed: OutputReferenceSchema,
});
export type EngageMintRedeemerT = Data.Static<typeof EngageMintRedeemerSchema>;

// ── PriceParamRedeemer = PostPrice (constr 0) ─────────────────────────────────
export const PriceParamRedeemerSchema = Data.Enum([Data.Literal("PostPrice")]);

// ── NftRedeemer = MintGenesis (constr 0) — CHỈ còn price_nft ──────────────────
// (`engage_nft.ak` đã bị XOÁ on-chain; thread NFT Engage dùng EngageMintRedeemer.)
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

export const encodeEngageMintRedeemer = (r: EngageMintRedeemerT): string =>
  Data.to(r, EngageMintRedeemerSchema as unknown as EngageMintRedeemerT);
export const decodeEngageMintRedeemer = (cbor: string): EngageMintRedeemerT =>
  Data.from(cbor, EngageMintRedeemerSchema as unknown as EngageMintRedeemerT);
