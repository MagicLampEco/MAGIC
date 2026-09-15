// src/types.ts — bản soi gương của types.ak + schema Lucid Evolution.
// THỨ TỰ trường/nhánh Ở ĐÂY LÀ MÃ HOÁ PLUTUS DATA. Đổi thứ tự một bên là hỏng
// giải mã bên kia (§11) — cùng bất biến với ScheduleGen/InstantGen.

import { Data } from "@lucid-evolution/lucid";

export type Natural = bigint;

// ── MagicBatch (§4.1 canonical, 7 trường) ────────────────────
export const MagicBatchSchema = Data.Object({
  batch_id: Data.Bytes(),
  source: Data.Integer(), // 1=Instant 2=Schedule 3=Prepaid
  created_epoch: Data.Integer(),
  current_amount: Data.Integer(), // nanogic
  decay_window: Data.Integer(), // luôn 1 (§4.2)
  profile_at_creation: Data.Integer(), // luôn 0
  contract_id: Data.Bytes(), // = fund_id
});
export type MagicBatch = Data.Static<typeof MagicBatchSchema>;

// ── PrepaidCredit ────────────────────────────────────────────
export const PrepaidCreditSchema = Data.Object({
  fund_id: Data.Bytes(),
  remaining: Data.Integer(), // carpdrop
  issued_epoch: Data.Integer(),
  last_draw_epoch: Data.Integer(),
});
export type PrepaidCredit = Data.Static<typeof PrepaidCreditSchema>;

// ── VaultAttribution ─────────────────────────────────────────
export const VaultAttributionSchema = Data.Object({
  attribution_root: Data.Bytes(),
  last_event_epoch: Data.Integer(),
  total_events: Data.Integer(),
});
export type VaultAttribution = Data.Static<typeof VaultAttributionSchema>;

// ── PrepaidVaultDatum ────────────────────────────────────────
export const PrepaidVaultDatumSchema = Data.Object({
  owner: Data.Bytes(),
  did_commit: Data.Bytes(),
  prepaid_credits: Data.Array(PrepaidCreditSchema),
  magic_batches: Data.Array(MagicBatchSchema),
  next_batch_index: Data.Integer(),
  personal_delegate: Data.Nullable(Data.Bytes()),
  last_updated_epoch: Data.Integer(),
  attribution: VaultAttributionSchema,
});
export type PrepaidVaultDatum = Data.Static<typeof PrepaidVaultDatumSchema>;

// ── PaidFundDatum ────────────────────────────────────────────
export const PaidFundDatumSchema = Data.Object({
  fund_id: Data.Bytes(),
  platform: Data.Bytes(),
  vault_hash: Data.Bytes(),
  carp_locked: Data.Integer(),
  credit_issued: Data.Integer(),
  magic_settled: Data.Integer(),
  provider_claimed: Data.Integer(),
  buffer_bps: Data.Integer(),
  last_updated_epoch: Data.Integer(),
});
export type PaidFundDatum = Data.Static<typeof PaidFundDatumSchema>;

// ── PrepaidVaultRedeemer ─────────────────────────────────────
// Constr 0 Lock · 1 Draw · 2 BurnBatch · 3 PrunePrepaid · 4 SetDelegate ·
// 5 SetDidCommit.
// BurnBatch PHẢI ở 2 — ConsumeMAGIC ghim burn_batch_constr = 2 (§7.3).
//
// `SetDidCommit` nằm CUỐI, không nằm cạnh `SetDelegate` dù hai nhánh nghe giống
// nhau: `Data.Enum` mã hoá tag constructor theo THỨ TỰ PHẦN TỬ trong mảng này,
// nên chèn vào giữa là mọi redeemer đã mã hoá cho một nhánh ≥ 3 trỏ sang nhánh
// khác — không lỗi cú pháp, không test kiểu nào đỏ, chỉ sai lúc chạy trên chuỗi.
export const PrepaidVaultRedeemerSchema = Data.Enum([
  Data.Object({
    PrepaidLock: Data.Object({
      fund_id: Data.Bytes(),
      amount_carpdrop: Data.Integer(),
    }),
  }),
  Data.Object({
    PrepaidDraw: Data.Object({
      fund_id: Data.Bytes(),
      amount_carpdrop: Data.Integer(),
    }),
  }),
  Data.Object({
    BurnBatch: Data.Object({
      burns: Data.Array(Data.Tuple([Data.Bytes(), Data.Integer()])),
    }),
  }),
  Data.Literal("PrunePrepaid"),
  Data.Object({
    SetDelegate: Data.Object({
      new_delegate: Data.Nullable(Data.Bytes()),
    }),
  }),
  Data.Object({
    // constr 5 — gắn PersonDID MỘT LẦN. On-chain đòi `datum.did_commit == #""`,
    // chữ ký của CHÍNH `owner`, và giá trị mới dài ĐÚNG 32 byte (64 ký tự hex).
    SetDidCommit: Data.Object({
      did_commit: Data.Bytes(),
    }),
  }),
]);
export type PrepaidVaultRedeemer = Data.Static<typeof PrepaidVaultRedeemerSchema>;

// ── PaidFundRedeemer ─────────────────────────────────────────
export const PaidFundRedeemerSchema = Data.Enum([
  Data.Literal("FundLock"), // constr 0
  Data.Literal("FundSettle"), // constr 1
  Data.Object({
    FundClaim: Data.Object({ amount_carpdrop: Data.Integer() }), // constr 2
  }),
]);
export type PaidFundRedeemer = Data.Static<typeof PaidFundRedeemerSchema>;

// ── OutputReference ──────────────────────────────────────────
// Trên PlutusV3 `TxOutRef` mã hoá PHẲNG: `Constr 0 [B <32 byte>, I idx]` — lớp
// bọc `TxId` của V2 đã bỏ. Đây là lý do `transaction_id` là `Data.Bytes()` chứ
// không phải một `Data.Object` lồng thêm một tầng.
export const OutputReferenceSchema = Data.Object({
  transaction_id: Data.Bytes(), // 32 byte
  output_index: Data.Integer(),
});
export type OutputReference = Data.Static<typeof OutputReferenceSchema>;

// ── PrepaidVaultIdRedeemer ───────────────────────────────────
// Redeemer của handler `mint` trên CHÍNH validator `prepaid_vault`
// (INV-VAULT-IDENTITY). Policy id của NFT = script hash của vault, nên không có
// tham số biên dịch nào trỏ chéo và không có vòng tham chiếu.
//
// `seed` là một **OutputReference đầy đủ**, KHÔNG phải tx hash trần: tên tài sản
// là `blake2b_256(cbor.serialise(seed))`, và `cbor.serialise` của Aiken mã hoá cả
// constructor lẫn hai trường. Đưa vào tx hash trần thì băm ra một tên khác, ví
// dựng được giao dịch, và nó chết lúc submit chứ không lúc build.
//
// KHÔNG có nhánh đốt — đúng theo `types.ak`. Thêm một `Data.Literal` thứ hai vào
// đây là dựng ra constr 1 mà on-chain không có, và mọi tx dùng nó bị từ chối.
export const PrepaidVaultIdRedeemerSchema = Data.Enum([
  Data.Object({
    MintVaultId: Data.Object({ seed: OutputReferenceSchema }), // constr 0
  }),
]);
export type PrepaidVaultIdRedeemer = Data.Static<
  typeof PrepaidVaultIdRedeemerSchema
>;

// ══════════════════════════════════════════════════════════════
// Bảng THỨ TỰ — nguồn để kiểm chéo với types.ak
// ══════════════════════════════════════════════════════════════
// Mã hoá Plutus Data phụ thuộc thứ tự khai báo. codec.test.ts đọc types.ak, rút
// thứ tự thật bên Aiken, và so với các bảng dưới đây — nên một lần đổi thứ tự ở
// một bên là đỏ ngay, không đợi tới lúc giải mã hỏng trên chuỗi.

export const VAULT_REDEEMER_ORDER = [
  "PrepaidLock",
  "PrepaidDraw",
  "BurnBatch", // constr 2 — ConsumeMAGIC ghim (§7.3)
  "PrunePrepaid",
  "SetDelegate",
  "SetDidCommit", // constr 5 — thêm 2026-09-15, CHỈ THÊM Ở CUỐI
] as const;

/// Chỉ số constructor của `SetDidCommit`. Viết ra thành hằng để bài kiểm codec ép
/// được một con số cụ thể: một nhánh chèn nhầm vị trí không làm hỏng biên dịch,
/// không làm hỏng suy luận kiểu, và chỉ lộ ra khi giao dịch chạy nhầm nhánh trên
/// chuỗi — đúng lớp hỏng im lặng mà bảng thứ tự này sinh ra để chặn.
export const SET_DID_COMMIT_CONSTR = 5;

/// Độ dài hợp lệ của `did_commit` khi GHI (blake2b-256). Gương của
/// `did_len_ok` bên Aiken: rỗng là "chưa gắn", còn nhánh ghi đòi đúng 32 byte.
export const DID_COMMIT_BYTES = 32;

export const FUND_REDEEMER_ORDER = ["FundLock", "FundSettle", "FundClaim"] as const;

export const VAULT_ID_REDEEMER_ORDER = ["MintVaultId"] as const;

export const OUTPUT_REFERENCE_FIELDS = ["transaction_id", "output_index"] as const;

export const MAGIC_BATCH_FIELDS = [
  "batch_id",
  "source",
  "created_epoch",
  "current_amount",
  "decay_window",
  "profile_at_creation",
  "contract_id",
] as const;

export const PREPAID_CREDIT_FIELDS = [
  "fund_id",
  "remaining",
  "issued_epoch",
  "last_draw_epoch",
] as const;

export const VAULT_ATTRIBUTION_FIELDS = [
  "attribution_root",
  "last_event_epoch",
  "total_events",
] as const;

export const PREPAID_VAULT_DATUM_FIELDS = [
  "owner",
  "did_commit",
  "prepaid_credits",
  "magic_batches",
  "next_batch_index",
  "personal_delegate",
  "last_updated_epoch",
  "attribution",
] as const;

export const PAID_FUND_DATUM_FIELDS = [
  "fund_id",
  "platform",
  "vault_hash",
  "carp_locked",
  "credit_issued",
  "magic_settled",
  "provider_claimed",
  "buffer_bps",
  "last_updated_epoch",
] as const;
