// src/types.ts — Paymaster codec (Lucid Evolution Data). Mirror BYTE-PERFECT
// onchain/lib/magiclamp/paymaster/types.ak. Constructor index = THỨ TỰ KHAI BÁO
// field trong Aiken type → Plutus Data encoding (CLAUDE.md P8). Đảo thứ tự 1 bên
// = vỡ decode bên kia. BigInt mọi amount (oil/nanogic/lovelace/Q-format).
//
// Bảng constr (khớp types.ak:23-79):
//   OutputReference     { transaction_id, output_index }                       constr 0
//   SponsorPolicy       { app_id, app_authority, max_per_did_per_epoch,
//                         max_global_per_epoch, lamp_per_magic_q,
//                         ada_per_magic_q, oracle_nft_policy, epoch }           constr 0
//   SponsorMeter        { app_id, epoch, did_lamp_map, global_lamp_epoch }     constr 0
//   ProtocolFeeParams   { min_lamp_per_magic_q, protocol_fee_active, epoch }   constr 0
//   PaymasterRedeemer = Sponsor { vault_refs, policy_ref, protocol_ref,
//                                 did_key, lamp_this, ada_this }                constr 0
//   NftRedeemer = MintGenesis                                                  constr 0
//
// LƯU Ý mã hoá phụ:
//   Option<ByteArray>  → Some(x)=Constr(0,[Bytes]); None=Constr(1,[])  (Data.Nullable)
//   Bool               → False=Constr(0,[]); True=Constr(1,[])         (Data.Boolean — KHỚP
//                        Aiken: builtin tag False=0, True=1)
//   (ByteArray, Int)   → tuple 2 phần tử = Constr(0,[Bytes, Int])      (Data.Tuple)

import { Data } from "@lucid-evolution/lucid";

// ── OutputReference (cardano/transaction.OutputReference) ─────────────────────
export const OutputReferenceSchema = Data.Object({
  transaction_id: Data.Bytes(),
  output_index: Data.Integer(),
});
export type OutputReferenceT = Data.Static<typeof OutputReferenceSchema>;

// ── SponsorPolicy (beacon datum, reference input) ─────────────────────────────
// types.ak:23-32. oracle_nft_policy = Option<ByteArray> (MVP None).
export const SponsorPolicySchema = Data.Object({
  app_id: Data.Bytes(),
  app_authority: Data.Bytes(),
  max_per_did_per_epoch: Data.Integer(),
  max_global_per_epoch: Data.Integer(),
  lamp_per_magic_q: Data.Integer(),
  ada_per_magic_q: Data.Integer(),
  oracle_nft_policy: Data.Nullable(Data.Bytes()),
  epoch: Data.Integer(),
});
export type SponsorPolicyT = Data.Static<typeof SponsorPolicySchema>;

// ── SponsorMeter (thread UTxO datum) ──────────────────────────────────────────
// types.ak:39-44. did_lamp_map = List<(ByteArray, Int)>.
export const DidLampEntrySchema = Data.Tuple([Data.Bytes(), Data.Integer()]);
export type DidLampEntryT = Data.Static<typeof DidLampEntrySchema>;

export const SponsorMeterSchema = Data.Object({
  app_id: Data.Bytes(),
  epoch: Data.Integer(),
  did_lamp_map: Data.Array(DidLampEntrySchema),
  global_lamp_epoch: Data.Integer(),
});
export type SponsorMeterT = Data.Static<typeof SponsorMeterSchema>;

// ── ProtocolFeeParams (beacon DAO sàn, reference input) ───────────────────────
// types.ak:51-55. protocol_fee_active = Bool.
export const ProtocolFeeParamsSchema = Data.Object({
  min_lamp_per_magic_q: Data.Integer(),
  protocol_fee_active: Data.Boolean(),
  epoch: Data.Integer(),
});
export type ProtocolFeeParamsT = Data.Static<typeof ProtocolFeeParamsSchema>;

// ── PaymasterRedeemer = Sponsor { ... } (spend SponsorMeter) ──────────────────
// types.ak:65-74. Enum 1 constr → Plutus Constr(0, [...6 fields...]).
// Dùng Data.Object (1-variant enum encode = Constr 0, theo thứ tự khai báo) — KHÔNG
// Data.Enum 1-phần-tử (Lucid 0.4.x cast lỗi khi variant >1 field; cùng lý do consume.ts).
export const PaymasterRedeemerSchema = Data.Object({
  vault_refs: Data.Array(OutputReferenceSchema),
  policy_ref: OutputReferenceSchema,
  protocol_ref: OutputReferenceSchema,
  did_key: Data.Bytes(),
  lamp_this: Data.Integer(),
  ada_this: Data.Integer(),
});
export type PaymasterRedeemerT = Data.Static<typeof PaymasterRedeemerSchema>;

// ── NftRedeemer = MintGenesis (constr 0) — policy NFT + meter NFT one-shot ─────
export const NftRedeemerSchema = Data.Enum([Data.Literal("MintGenesis")]);

// ── codec helpers (datum/redeemer ⇄ CBOR hex) ─────────────────────────────────
// Lucid 0.4.x idiom: `Data.to/from(value, Schema as unknown as T)`.
export const encodeSponsorPolicy = (p: SponsorPolicyT): string =>
  Data.to(p, SponsorPolicySchema as unknown as SponsorPolicyT);
export const decodeSponsorPolicy = (cbor: string): SponsorPolicyT =>
  Data.from(cbor, SponsorPolicySchema as unknown as SponsorPolicyT);

export const encodeSponsorMeter = (m: SponsorMeterT): string =>
  Data.to(m, SponsorMeterSchema as unknown as SponsorMeterT);
export const decodeSponsorMeter = (cbor: string): SponsorMeterT =>
  Data.from(cbor, SponsorMeterSchema as unknown as SponsorMeterT);

export const encodeProtocolFeeParams = (p: ProtocolFeeParamsT): string =>
  Data.to(p, ProtocolFeeParamsSchema as unknown as ProtocolFeeParamsT);
export const decodeProtocolFeeParams = (cbor: string): ProtocolFeeParamsT =>
  Data.from(cbor, ProtocolFeeParamsSchema as unknown as ProtocolFeeParamsT);

export const encodePaymasterRedeemer = (r: PaymasterRedeemerT): string =>
  Data.to(r, PaymasterRedeemerSchema as unknown as PaymasterRedeemerT);
export const decodePaymasterRedeemer = (cbor: string): PaymasterRedeemerT =>
  Data.from(cbor, PaymasterRedeemerSchema as unknown as PaymasterRedeemerT);
