// src/types.ts — ConsumeMAGIC v2 ENGAGEMENT layer codec (Lucid Evolution Data).
//
// Mirror byte-perfect của onchain/lib/magiclamp/consume/types.ak. Constructor index
// = THỨ TỰ KHAI BÁO field trong Aiken type → Plutus Data encoding. Đảo thứ tự 1 bên
// = vỡ decode bên kia (CLAUDE.md P8). KHÔNG liên quan _appeconomics_legacy.ts (v1).
//
// Bảng constr (khớp types.ak):
//   OutputReference { transaction_id: ByteArray, output_index: Int }   constr 0
//   OpPrice         { op_type, base_price, demand_mult }               constr 0
//   PriceParam      { op_prices, m_min, m_max, epoch }                 constr 0
//   EngageDatum     { owner, consumed_count, last_epoch, did_commit,
//                     consumed_nanogic }                               constr 0
//   ConsumeRedeemer     = Consume     { op_type, op_count, price_ref, vault_ref } constr 0
//                       | BindDID                                                 constr 1
//                       | CloseThread                                             constr 2
//                       | ConsumeMany { pairs: List<OpPair>, price_ref, vault_ref } constr 3
//   OpPair          { op_type, op_count }                              constr 0
//   EngageMintRedeemer  = MintEngage  { seed: OutputReference }                   constr 0
//                       | BurnEngage                                              constr 1

import { Constr, Data } from "@lucid-evolution/lucid";

// ── Credential (chủ thread) ───────────────────────────────────────────────────
// Gương của `cardano/address/Credential` (blueprint, đối chiếu 2026-09-26):
//   VerificationKey(h) = Constr 0 [bytes 28]   Script(h) = Constr 1 [bytes 28]
// `Data.Static` của lược đồ này trùng kiểu `OwnerCredential` ở `@magiclamp/protocol-utils`.
export const OwnerCredentialSchema = Data.Enum([
  Data.Object({ VerificationKey: Data.Tuple([Data.Bytes({ minLength: 28, maxLength: 28 })]) }),
  Data.Object({ Script: Data.Tuple([Data.Bytes({ minLength: 28, maxLength: 28 })]) }),
]);
export type OwnerCredentialData = Data.Static<typeof OwnerCredentialSchema>;

// ── OutputReference (cardano/transaction.OutputReference) ─────────────────────
// Aiken: OutputReference { transaction_id: ByteArray, output_index: Int }.
export const OutputReferenceSchema = Data.Object({
  transaction_id: Data.Bytes(),
  output_index: Data.Integer(),
});
export type OutputReferenceT = Data.Static<typeof OutputReferenceSchema>;

// ── OpPrice — 3 TRƯỜNG (CC-LOAD-COUNT-UNIT, 2026-09-25) ───────────────────────
// `demand_mult` là trường THỨ BA, scale Q. Hệ số co giãn của RIÊNG dòng này — nó đã
// rời khỏi mức `PriceParam`, xem lược đồ ngay dưới.
//
// 🔴 Thêm trường là ĐỔI LƯỢC ĐỒ, không phải thêm tuỳ chọn: giải mã Plutus Data của
// Aiken nghiêm ngặt về SỐ TRƯỜNG theo cả hai chiều, nên một beacon 2-trường đã lên
// chuỗi KHÔNG đọc được bằng lược đồ này và ngược lại. Việc phải làm là bootstrap
// beacon MỚI (NFT one-shot mới), không phải cứu beacon cũ. Không UTxO người dùng nào
// di trú — `EngageDatum` không đụng tới.
export const OpPriceSchema = Data.Object({
  op_type: Data.Integer(),
  base_price: Data.Integer(),
  demand_mult: Data.Integer(),
});
export type OpPriceT = Data.Static<typeof OpPriceSchema>;

// ── PriceParam (beacon datum) — 4 TRƯỜNG ──────────────────────────────────────
// `demand_mult` ở mức này đã bị BỎ HẲN, không để lại bia mộ. Khác ca
// `BatchSource::Snapshot` (bia mộ giữ chỉ số constructor cho UTxO đã lên chuỗi): ở
// đây đổi số trường của `OpPrice` đã làm mọi beacon cũ không đọc được, nên không có
// UTxO nào cần giữ chỉ số. Giữ lại trường này thì nó thành NGUỒN THỨ HAI cho cùng một
// đại lượng — hai chỗ khai hệ số nhu cầu, không cổng nào nói chỗ nào thắng.
// `m_min`/`m_max` ở lại vì chúng là BAND dùng chung, ghim tuyệt đối về hằng.
export const PriceParamSchema = Data.Object({
  op_prices: Data.Array(OpPriceSchema),
  m_min: Data.Integer(),
  m_max: Data.Integer(),
  epoch: Data.Integer(),
});
export type PriceParamT = Data.Static<typeof PriceParamSchema>;

// ── EngageDatum (state per-app) — 5 TRƯỜNG ────────────────────────────────────
// Thứ tự = thứ tự khai báo trong types.ak. Hai trường được THÊM Ở CUỐI theo
// nguyên tắc APPEND-ONLY (không dịch chỉ số field cũ):
//   did_commit       — rỗng, hoặc đúng 32 byte. Bất biến DƯỚI nhánh `Consume`; đường ghi
//                      thứ hai là redeemer `BindDID` (một chiều, đúng một lần).
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
  owner: OwnerCredentialSchema,
  consumed_count: Data.Integer(),
  last_epoch: Data.Integer(),
  did_commit: Data.Bytes(),
  consumed_nanogic: Data.Integer(),
});
export type EngageDatumT = Data.Static<typeof EngageDatumSchema>;

// ── ConsumeRedeemer — enum 3 variant ──────────────────────────────────────────
//   Consume { op_type, op_count, price_ref, vault_ref }  → Constr 0
//   BindDID                                              → Constr 1
//   CloseThread                                          → Constr 2
//
// 🔴 CHỈ SỐ CONSTRUCTOR LÀ HỢP ĐỒNG NHỊ PHÂN với on-chain (types.ak). Variant mới
//    chỉ được THÊM Ở CUỐI. Các hằng dưới đây tồn tại để chỗ nào cần con số thì ĐỌC
//    chúng, không gõ lại — và `tests/codec.test.ts` ghim từng hằng.
export const CONSUME_REDEEMER_CONSTR = 0;
export const BIND_DID_REDEEMER_CONSTR = 1;
export const CLOSE_THREAD_REDEEMER_CONSTR = 2;
export const CONSUME_MANY_REDEEMER_CONSTR = 3;
export const OP_PAIR_CONSTR = 0;

// Variant `Consume` giữ nguyên lược đồ cũ: Data.Object cho RA ĐÚNG bytes Constr 0.
// KHÔNG chuyển sang Data.Enum để "cho giống enum Aiken" — Lucid 0.4.x cast lỗi
// "Could not type cast to constructor" với variant nhiều field, và đổi lược đồ ở đây
// là đổi bytes của một redeemer ĐÃ LÊN CHUỖI.
export const ConsumeRedeemerSchema = Data.Object({
  op_type: Data.Integer(),
  op_count: Data.Integer(),
  price_ref: OutputReferenceSchema,
  vault_ref: OutputReferenceSchema,
});
export type ConsumeRedeemerT = Data.Static<typeof ConsumeRedeemerSchema>;

/**
 * Redeemer `BindDID` — Constr(1, []), KHÔNG field.
 *
 * Dựng bằng `new Constr(...)` chứ KHÔNG gõ hằng CBOR `"d87a80"`: chỉ số constructor
 * là thứ phải khớp on-chain, còn chuỗi bytes là HỆ QUẢ của nó. Gõ bytes tay là chép
 * một sự thật ra chỗ thứ hai, và chỗ thứ hai đó không có đường báo khi chỉ số đổi.
 * (Cùng lý do `postPrice.ts` dùng `Data.void()` thay vì gõ `"d87980"`.)
 */
export const encodeBindDidRedeemer = (): string =>
  Data.to(new Constr(BIND_DID_REDEEMER_CONSTR, []));

/**
 * Redeemer `CloseThread` — Constr(2, []), KHÔNG field. Đóng thread Engage: `owner` ký,
 * đốt đúng NFT thread (−1, kèm `BurnEngage` ở nhánh mint), không output nào mang NFT
 * quay về địa chỉ engage. Đích của min-ADA do người dựng tx chọn — validator không ép.
 */
export const encodeCloseThreadRedeemer = (): string =>
  Data.to(new Constr(CLOSE_THREAD_REDEEMER_CONSTR, []));

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

// Variant thứ hai `BurnEngage` (Constr 1, không field) — nhánh mint chỉ-đốt, đi cùng
// `CloseThread`. Lược đồ `MintEngage` ở trên GIỮ NGUYÊN (bytes đã lên chuỗi); variant
// mới dựng bằng Constr từ hằng, cùng khuôn `encodeBindDidRedeemer`.
export const MINT_ENGAGE_REDEEMER_CONSTR = 0;
export const BURN_ENGAGE_REDEEMER_CONSTR = 1;
export const encodeBurnEngageRedeemer = (): string =>
  Data.to(new Constr(BURN_ENGAGE_REDEEMER_CONSTR, []));

// ── PriceParamRedeemer = PostPrice (constr 0) ─────────────────────────────────
// 🔴 KHAI BÁO CHO NGƯỜI ĐỌC, KHÔNG PHẢI BỘ MÃ HOÁ DÙNG ĐƯỢC. Đo trên
//    @lucid-evolution/lucid 0.4.30: `Data.to("PostPrice", PriceParamRedeemerSchema)`
//    NÉM "Could not type cast to void" — Data.Enum một variant KHÔNG field bị lucid
//    quy về dạng void và đường cast vỡ. Đường dựng redeemer thật là `Data.void()`
//    (= Constr(0,[]) = `d87980`), xem `postPrice.ts:postPriceRedeemerCbor`. Hai vế
//    được ghim trong `tests/post_price.test.ts`.
//    Cùng cảnh báo áp cho `NftRedeemerSchema` ngay dưới — hình dạng y hệt.
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

// ── ConsumeMany { pairs, price_ref, vault_ref } — Constr 3 (THÊM 2026-10-03) ─────
//   pairs = List<OpPair>, OpPair = Constr 0 [op_type, op_count].
// Dựng bằng `new Constr` từ hằng chỉ số (cùng khuôn `encodeBindDidRedeemer`), KHÔNG
// thêm biến thể vào `ConsumeRedeemerSchema`: lược đồ đó là `Data.Object` cho RA bytes
// Constr 0 của redeemer ĐÃ LÊN CHUỖI, và Lucid 0.4.x cast lỗi với `Data.Enum` nhiều field.
// Bytes ghim chéo với Aiken: `tests/consume_many.test.ts` ↔ `consume_many_redeemer_cbor_pinned`.

export interface OpPairT {
  op_type: bigint;
  op_count: bigint;
}

export interface ConsumeManyRedeemerT {
  pairs: OpPairT[];
  price_ref: OutputReferenceT;
  vault_ref: OutputReferenceT;
}

const refToConstr = (r: OutputReferenceT): Constr<Data> =>
  new Constr(0, [r.transaction_id, r.output_index]);

export const encodeConsumeManyRedeemer = (r: ConsumeManyRedeemerT): string =>
  Data.to(
    new Constr(CONSUME_MANY_REDEEMER_CONSTR, [
      r.pairs.map((p) => new Constr(OP_PAIR_CONSTR, [p.op_type, p.op_count])),
      refToConstr(r.price_ref),
      refToConstr(r.vault_ref),
    ]),
  );

/** Giải mã CBOR redeemer constr 3. Ném ở mọi hình dạng lạ — không trả giá trị đệm. */
export function decodeConsumeManyRedeemer(cbor: string): ConsumeManyRedeemerT {
  const d = Data.from(cbor);
  const bad = (why: string): never => {
    throw new Error(`CONSUME-017: redeemer không phải ConsumeMany (constr 3): ${why}`);
  };
  if (!(d instanceof Constr) || d.index !== CONSUME_MANY_REDEEMER_CONSTR) bad("sai constr");
  const c = d as Constr<Data>;
  if (c.fields.length !== 3) bad(`cần 3 trường, có ${c.fields.length}`);
  const [pairsD, priceD, vaultD] = c.fields;
  if (!Array.isArray(pairsD)) bad("pairs không phải danh sách");
  const ref = (x: Data, name: string): OutputReferenceT => {
    if (!(x instanceof Constr) || x.index !== 0 || x.fields.length !== 2) bad(`${name} sai hình dạng`);
    const [id, ix] = (x as Constr<Data>).fields;
    if (typeof id !== "string" || typeof ix !== "bigint") bad(`${name} sai kiểu trường`);
    return { transaction_id: id as string, output_index: ix as bigint };
  };
  const pairs = (pairsD as Data[]).map((x, i) => {
    if (!(x instanceof Constr) || x.index !== OP_PAIR_CONSTR || x.fields.length !== 2) bad(`cặp #${i} sai hình dạng`);
    const [t, n] = (x as Constr<Data>).fields;
    if (typeof t !== "bigint" || typeof n !== "bigint") bad(`cặp #${i} sai kiểu trường`);
    return { op_type: t as bigint, op_count: n as bigint };
  });
  return { pairs, price_ref: ref(priceD!, "price_ref"), vault_ref: ref(vaultD!, "vault_ref") };
}

// ── Giải mã redeemer của MỘT lượt tiêu: `Consume` (constr 0) hoặc `ConsumeMany` (constr 3) ──
// Bên ĐỌC LẠI một tx vừa dựng (VaultTxAPI ▸ `consumeLine.ts` ▸ `checkConsumeTx`) cần biết redeemer trên thread
// Engage nói gì — không tin lời khai của bộ dựng. Hai biến thể khác hình dạng nên trả về một kiểu
// có nhãn; constr khác (BindDID, CloseThread, lạ) ⟹ NÉM, không đoán.

/** Một lượt tiêu đọc từ redeemer: `single` = `Consume`, `many` = `ConsumeMany`. */
export type ConsumeLineRedeemerT =
  | { kind: "single"; op_type: bigint; op_count: bigint; price_ref: OutputReferenceT; vault_ref: OutputReferenceT }
  | ({ kind: "many" } & ConsumeManyRedeemerT);

/**
 * Giải mã redeemer Spend của thread Engage thành một lượt tiêu. Ném `CONSUME-018` ở mọi
 * hình dạng khác `Consume` / `ConsumeMany` — kể cả `BindDID`, `CloseThread`.
 */
export function decodeConsumeLineRedeemer(cbor: string): ConsumeLineRedeemerT {
  const d = Data.from(cbor);
  const bad = (why: string): never => {
    throw new Error(`CONSUME-018: redeemer không phải Consume (constr 0) hay ConsumeMany (constr 3): ${why}`);
  };
  if (!(d instanceof Constr)) return bad("không phải Constr");
  const c = d as Constr<Data>;
  if (c.index === CONSUME_MANY_REDEEMER_CONSTR) return { kind: "many", ...decodeConsumeManyRedeemer(cbor) };
  if (c.index !== CONSUME_REDEEMER_CONSTR) return bad(`constr ${c.index}`);
  if (c.fields.length !== 4) return bad(`Consume cần 4 trường, có ${c.fields.length}`);
  const [t, n, priceD, vaultD] = c.fields;
  if (typeof t !== "bigint" || typeof n !== "bigint") return bad("op_type/op_count không phải số nguyên");
  const ref = (x: Data, name: string): OutputReferenceT => {
    if (!(x instanceof Constr) || x.index !== 0 || x.fields.length !== 2) return bad(`${name} sai hình dạng`);
    const [id, ix] = (x as Constr<Data>).fields;
    if (typeof id !== "string" || typeof ix !== "bigint") return bad(`${name} sai kiểu trường`);
    return { transaction_id: id as string, output_index: ix as bigint };
  };
  return {
    kind: "single", op_type: t as bigint, op_count: n as bigint,
    price_ref: ref(priceD!, "price_ref"), vault_ref: ref(vaultD!, "vault_ref"),
  };
}
