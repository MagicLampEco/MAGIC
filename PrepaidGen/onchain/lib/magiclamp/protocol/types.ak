// lib/types.ak — PrepaidGen data types
// Field order == Plutus Data encoding order. Đổi thứ tự một bên là hỏng giải mã
// bên kia (§11) — twin ở offchain/src/types.ts.

use cardano/address.{Address, Credential}
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
  // ── Sổ nợ quyết toán, thêm 2026-09-28 (THÊM Ở CUỐI) ─────────────────────
  // nanogic đã đốt (`BurnBatch`) từ batch của CHÍNH dòng này mà quỹ CHƯA ghi
  // nhận. `BurnBatch` cộng vào đây; `SettleLine` (constr 6) đưa về 0 và cộng
  // đúng bằng ấy vào `PaidFundDatum.magic_settled` trong cùng giao dịch.
  //
  // Vì sao cần một trường datum thay vì đọc delta batch tại chỗ như bản trước:
  // `settle_delta` cũ chỉ đo phần giảm TRONG CHÍNH giao dịch đốt, nên một
  // `BurnBatch` không kèm quỹ là mất dấu vĩnh viễn — CARP đối ứng nằm lại quỹ
  // mà provider không đòi được (F2 chỉ cho đòi phần đã quyết toán) và người
  // dùng cũng không lấy lại được. Và vì `paid_fund.spend` ép đúng MỘT quỹ input
  // mỗi giao dịch, một lượt đốt chạm batch của hai quỹ chỉ quyết toán được một.
  // Ghi nợ vào datum tách hai việc ra: đốt lúc nào cũng được, quyết toán lúc
  // nào cũng được, mỗi quỹ một giao dịch riêng.
  //
  // THÊM Ở CUỐI giữ chỉ số các trường cũ, KHÔNG giữ khả năng đọc UTxO vault đã
  // tạo bằng lược đồ 4 trường (BOUNDARIES.md §2 — Aiken nghiêm về số trường cả
  // hai chiều). Chấp nhận được vì `prepaid_credits` rỗng lúc genesis và cụm
  // Preprod đời trước đã mồ côi.
  consumed_unsettled : Natural,   // nanogic
}

pub type VaultAttribution {
  attribution_root : ByteArray,
  last_event_epoch : Natural,
  total_events     : Natural,
}

// ── PrepaidVaultDatum ─────────────────────────────────────────
// KHÔNG có trường LAMP nào — C-PP-14 (PrepaidGen không chạm backing chung).
pub type PrepaidVaultDatum {
  // Chủ vault: khoá (`VerificationKey`) HOẶC script (`Script`) — xác thực bằng
  // `owner_auth.owner_authorized`. Giữ NGUYÊN vị trí trường 0: `consume` đọc chủ vault
  // theo vị trí (`all_vault_owners_are`), không import kiểu này.
  owner              : Credential,
  did_commit         : ByteArray,            // §7.5 — RỖNG lúc genesis, đặt MỘT LẦN
                                             // qua `SetDidCommit`, rồi bất biến
  prepaid_credits    : List<PrepaidCredit>,
  magic_batches      : List<MagicBatch>,
  next_batch_index   : Natural,
  // 🪦 BIA MỘ — quyền chết 2026-09-16 (Nợ #14), trường ở lại. Không phải vì "gỡ
  // ra thì vỡ decode mọi UTxO đã tạo" (hash đã đổi, UTxO đời trước ở địa chỉ
  // khác), mà vì gỡ nó đẩy mọi trường sau lên một chỉ số — và có bên đọc theo
  // VỊ TRÍ, lấy nhầm trường mà không kêu. §7.6 mô tả đường đã chết; giữ con trỏ
  // để người tra biết nó nói về cái gì, đừng đọc thành đường đang chạy.
  personal_delegate  : Option<ByteArray>,    // 🪦 §7.6 Paymaster (đường đã chết)
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
  // ── Đích nhận CARP của FundClaim (thêm 2026-09-26, L1'') ────
  // Ghim tại genesis, bất biến trọn đời quỹ. Trước bản này đích do người dựng tx
  // FundClaim tự chọn, nên chiếm khoá platform = rút sạch về ví mình; nay kẻ
  // chiếm khoá chỉ đẩy được CARP về ĐÚNG bên hưởng đã ghim.
  //
  // THÊM Ở CUỐI giữ chỉ số các trường cũ, KHÔNG giữ khả năng đọc UTxO quỹ đã tạo
  // bằng lược đồ 9 trường (BOUNDARIES.md §2 — Aiken nghiêm về số trường cả hai
  // chiều). Chấp nhận ở đây vì cụm Preprod đời trước đã mồ côi (DevStatus.md).
  beneficiary        : Address,     // genesis ép: không stake, ≠ script quỹ/vault
  beneficiary_datum  : Option<Data>, // None ⟹ output NoDatum; Some(d) ⟹ InlineDatum(d)
                                     // Script(_) ⟹ BẮT BUỘC Some (genesis ép)
  // ── Thu hồi CARP tài trợ (thêm 2026-10-04, DESIGN-reclaim §10.3) — NỐI CUỐI ──
  // Mười một trường trên GIỮ NGUYÊN CHỖ. Thêm hai trường KHÔNG giữ được khả năng
  // đọc quỹ 11 trường đã tạo (Aiken nghiêm về số trường cả hai chiều) ⟹ chỉ áp
  // cho quỹ mở bằng bộ script deploy mới.
  //
  // `None` = quỹ thường của provider, hành vi y như cũ. `Some(s)` = quỹ tài trợ
  // cho ĐÚNG MỘT DID (`s.owner_commit`), ghim genesis, bất biến ở mọi nhánh.
  sponsorship        : Option<Sponsorship>,
  // carpdrop đã trả về bên tài trợ. 0 ở genesis, ghi MỘT lần ở `FundReclaim`
  // (> 0 ⟹ quỹ đã khép). `credit_issued` vẫn CHỈ TĂNG; phần hạn-mức hiệu lực là
  // `credit_issued − sponsor_reclaimed`.
  sponsor_reclaimed  : Natural,
}

// Bên tài trợ + người dùng được tài trợ. Gộp trong MỘT `Option` để không có
// trạng thái nửa vời (có bên tài trợ mà thiếu `owner_commit`).
pub type Sponsorship {
  // ĐỊA CHỈ ĐẦY ĐỦ (so cả phần stake). Genesis ép payment = VerificationKey.
  sponsor      : Address,
  // 32 byte = `blake2b_256(UTF8(did))` = ô [0] két Wakeme = tên vault-NFT Wakeme.
  owner_commit : ByteArray,
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

  // constr 4 — 🪦 owner nay CHỈ XOÁ ĐƯỢC (`new_delegate == None`). Vế "đặt/đổi
  // consume-delegate (§7.6)" chết 2026-09-16 (Nợ #14). Variant ở lại nguyên chỗ
  // làm bia mộ nhị phân — chính khối chú thích dưới đây nói vì sao không được
  // xê dịch nó. Xem bia mộ ở `validate_set_delegate` và ở `authed_owner`.
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

  // constr 6 — quyết toán MỘT dòng hạn-mức: đưa `consumed_unsettled` của dòng
  // `fund_id` về 0 và cộng đúng bằng ấy vào `magic_settled` của quỹ đó trong
  // CÙNG giao dịch. Permissionless như `PrunePrepaid`: nó không lấy gì của ai
  // (không CARP nào rời quỹ, không hạn-mức nào sinh ra), nó chỉ chuyển một con
  // số đã ghi trong datum vault sang sổ quỹ — mà người hưởng lợi là provider,
  // không phải chủ vault, nên đòi chữ ký chủ vault là để provider phụ thuộc
  // thiện chí của con nợ.
  //
  // THÊM Ở CUỐI: `BurnBatch` phải đứng yên ở constr 2 (ConsumeMAGIC ghim), và
  // mọi redeemer đã mã hoá cho một nhánh ≥ 3 sẽ chạy nhầm nhánh nếu chèn vào
  // giữa — không lỗi cú pháp nào, chỉ sai lúc chạy trên chuỗi.
  SettleLine { fund_id: ByteArray }
}

// ── Paid fund redeemer ────────────────────────────────────────
pub type PaidFundRedeemer {
  FundLock                                 // constr 0 — co-spend với PrepaidLock
  FundSettle                               // constr 1 — co-spend với SettleLine (constr 6)
  FundClaim { amount_carpdrop: Natural }   // constr 2 — provider rút, trần F2
  // constr 3 — NỐI CUỐI (2026-10-04). Trả phần hạn-mức CHƯA giao của quỹ tài trợ
  // về `sponsorship.sponsor`, chỉ khi két Wakeme của đúng DID bị `ReclaimEpoch`
  // trong cùng giao dịch. Không trường: lượng suy từ datum, không do người dựng
  // giao dịch khai. Permissionless (cùng tính chất với `ReclaimEpoch`).
  FundReclaim
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
