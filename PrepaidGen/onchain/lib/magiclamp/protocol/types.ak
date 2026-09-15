// lib/types.ak — PrepaidGen data types
// Field order == Plutus Data encoding order. Đổi thứ tự một bên là hỏng giải mã
// bên kia (§11) — twin ở offchain/src/types.ts.

use cardano/transaction.{OutputReference}

pub type Natural = Int

// ── MagicBatch — theo ĐÚNG §4.1 canonical (7 trường) ──────────
// `source` để Int (1=Instant 2=Schedule 3=Prepaid) đúng như §4.1 viết, không
// dùng enum: tránh nhập nhằng giữa "số 3" của spec và constructor index.
pub type MagicBatch {
  batch_id            : ByteArray,
  source              : Natural,
  created_epoch       : Natural,
  current_amount      : Natural,   // nanogic
  decay_window        : Natural,   // luôn = 1 (§4.2)
  profile_at_creation : Natural,   // luôn = 0 (PrepaidGen không dùng tư-cách)
  contract_id         : ByteArray, // = fund_id
}

// ── PrepaidCredit — hạn-mức CARP đã khoá, chưa rút thành MAGIC ─
// Khoá theo fund_id: mỗi vault có TỐI ĐA 1 dòng cho mỗi quỹ, và dòng KHÔNG BAO
// GIỜ bị xoá (kể cả remaining == 0) — nếu xoá thì batch chết sau đó không còn
// chỗ để trả hạn-mức về (PrunePrepaid).
pub type PrepaidCredit {
  fund_id         : ByteArray,
  remaining       : Natural,   // carpdrop
  issued_epoch    : Natural,
  last_draw_epoch : Natural,
}

pub type VaultAttribution {
  attribution_root : ByteArray,
  last_event_epoch : Natural,
  total_events     : Natural,
}

// ── PrepaidVaultDatum ─────────────────────────────────────────
// KHÔNG có trường LAMP nào — C-PP-14 (PrepaidGen không chạm backing chung).
pub type PrepaidVaultDatum {
  owner              : ByteArray,
  did_commit         : ByteArray,            // §7.5 — RỖNG lúc genesis, đặt MỘT LẦN
                                             // qua `SetDidCommit`, rồi bất biến
  prepaid_credits    : List<PrepaidCredit>,
  magic_batches      : List<MagicBatch>,
  next_batch_index   : Natural,
  personal_delegate  : Option<ByteArray>,    // §7.6 Paymaster
  last_updated_epoch : Natural,
  attribution        : VaultAttribution,
}

// ── PaidFundDatum — quỹ Paid của platform ─────────────────────
// vault_hash ghim tại genesis (handler `mint` của paid_fund) và bất biến: đây là thứ phá vòng tham
// chiếu vault ⇄ fund mà vẫn cho quỹ có thẩm quyền khi quyết toán.
pub type PaidFundDatum {
  fund_id            : ByteArray,   // == asset name NFT quỹ
  platform           : ByteArray,   // pkh provider
  vault_hash         : ByteArray,   // script hash của prepaid_vault
  carp_locked        : Natural,     // carpdrop — LUÔN == CARP thật trong UTxO
  credit_issued      : Natural,     // cộng dồn, chỉ tăng ở Lock
  magic_settled      : Natural,     // nanogic cộng dồn đã chứng minh tiêu thật
  provider_claimed   : Natural,     // carpdrop cộng dồn đã trả provider
  buffer_bps         : Natural,     // ≥ 1500, bất biến
  last_updated_epoch : Natural,
}

// ── Vault redeemer ────────────────────────────────────────────
// NORMATIVE: enum CHỈ THÊM Ở CUỐI. BurnBatch PHẢI ở constr 2 —
// ConsumeMAGIC ghim `burn_batch_constr = 2` cho vault này (§7.3, §11).
pub type PrepaidVaultRedeemer {
  // constr 0 — khoá CARP vào quỹ, cấp hạn-mức cho vault này
  PrepaidLock { fund_id: ByteArray, amount_carpdrop: Natural }

  // constr 1 — rút hạn-mức thành MagicBatch của epoch hiện tại (par 1:1)
  PrepaidDraw { fund_id: ByteArray, amount_carpdrop: Natural }

  // constr 2 — tiêu MAGIC dạng kế toán (D1). KHÔNG tx.mint, KHÔNG token.
  BurnBatch { burns: List<(ByteArray, Natural)> }

  // constr 3 — dọn batch chết, TRẢ LẠI hạn-mức. Permissionless (§7.4).
  PrunePrepaid

  // constr 4 — owner đặt/đổi consume-delegate (§7.6)
  SetDelegate { new_delegate: Option<ByteArray> }

  // constr 5 — owner gắn PersonDID MỘT LẦN, không đảo ngược (§7.5).
  //
  // ĐẶT Ở CUỐI, KHÔNG PHẢI CẠNH `SetDelegate` vì hai nhánh nghe giống nhau: chỉ
  // số constructor đi theo THỨ TỰ KHAI BÁO, nên chèn vào giữa là đẩy
  // `SetDelegate` sang 5 và — nặng hơn — đẩy mọi nhánh sau `BurnBatch` đi một
  // bậc. `burn_batch_constr = 2` mà ConsumeMAGIC ghim thì đứng yên ở đây, nhưng
  // mọi redeemer đã mã hoá ngoài chuỗi cho một nhánh ≥ 3 sẽ chạy NHẦM NHÁNH mà
  // không lỗi cú pháp nào. Thứ tự khai báo ≠ thứ tự vòng đời.
  SetDidCommit { did_commit: ByteArray }
}

// ── Paid fund redeemer ────────────────────────────────────────
pub type PaidFundRedeemer {
  FundLock                                 // constr 0 — co-spend với PrepaidLock
  FundSettle                               // constr 1 — co-spend với BurnBatch
  FundClaim { amount_carpdrop: Natural }   // constr 2 — provider rút, trần F2
}

// ── Vault-identity NFT redeemer (INV-VAULT-IDENTITY) ──────────
// Redeemer của handler `mint` trên chính validator `prepaid_vault`. Policy id của
// NFT = script hash của vault ⇒ không có tham số biên dịch nào trỏ chéo, không có
// vòng tham chiếu (cùng khuôn `VaultIdRedeemer` của ScheduleGen, giữ nguyên hình
// dạng dây để SDK dùng chung một bộ mã hoá).
//
// KHÔNG có nhánh đốt: mọi nhánh spend đều đòi NFT còn nguyên trên output tiếp nối
// (`vault_identity_preserved`) và không nhánh nào đóng vault, nên một nhánh đốt sẽ
// là mã chết — thêm vào chỉ tạo một cửa sẵn sàng mở ra nếu sau này ai đó nới cổng
// bảo toàn. Hệ quả phải biết trước: NFT vault và phần ADA tối thiểu đi kèm là VĨNH
// VIỄN, y như NFT quỹ ở handler `mint` của `paid_fund`.
pub type PrepaidVaultIdRedeemer {
  // constr 0 — đúc NFT định danh + đỗ một UTxO vault ở trạng thái genesis sạch.
  // `seed` là UTxO bị tiêu trong chính giao dịch đúc: nó là thứ làm tên tài sản
  // duy nhất (một UTxO tiêu được tối đa một lần).
  MintVaultId { seed: OutputReference }
}
