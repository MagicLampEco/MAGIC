# ChangeLog — repo MAGIC

> **Vai:** ghi **chuyện đã xảy ra**, mới nhất trên đầu. Mỗi mục nêu đủ ba vế: *đổi gì ·
> vì sao · cái gì gãy nếu ai đó đang bám bản cũ*. Trạng thái hiện tại thì xem
> [`DevStatus.md`](DevStatus.md); mô hình chuẩn xem
> [`Specs/MagicLamp-Tripletoken-Feat-(Vi).md`](Specs/MagicLamp-Tripletoken-Feat-(Vi).md).

## 2026-10-07 — VaultReadAPI: không thẻ bài thì không nhận yêu cầu đã qua proxy (cùng cổng với VaultTxAPI)

**Đổi gì.** (1) Đặt `VAULT_READ_API_BASE_PATH` mà `VAULT_READ_API_TOKEN` rỗng ⟹ từ chối khởi động, kể cả khi bind
loopback. (2) Thẻ rỗng mà yêu cầu mang `Forwarded` / `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP` (không
phân biệt hoa thường) ⟹ `401 UNAUTHORIZED`; `/health` vẫn mở. Nguồn: `VaultReadAPI/src/config.ts` ▸ `loadConfig`
(khối sau `parseBasePath`); `VaultReadAPI/src/http.ts` ▸ `requireToken`, `forwardedBy`.
**Vì sao.** Mặt tiền đọc có đúng lỗ đã vá ở VaultTxAPI cùng ngày: cổng cũ chỉ đòi thẻ khi host không phải loopback,
mà đứng sau proxy hay đường hầm thì loopback là cổng mở ra ngoài. Ở mặt tiền đọc, cái mất là khoá Blockfrost của
người vận hành và một phép tra `PKH → số dư` hàng loạt giá rẻ.
**Cái gì gãy.** Triển khai VaultReadAPI đang đặt tiền tố đường mà chưa có thẻ sẽ KHÔNG khởi động sau bản này: đặt
thẻ, trao thẻ cho bên gọi trước. Bên gọi đi qua proxy tới một mặt tiền không thẻ nhận 401.

## 2026-10-07 — VaultTxAPI: open-vault tài trợ gửi `ref` = owner_commit cả khi không chở genesis quỹ

**Đổi gì.** Mọi tx `/tx/sponsor/open-vault` ghi `feeRef` = owner_commit của DID, kể cả khi DID đã có quỹ nên tx
không chở genesis. Bước dựng khai mã ghi sổ qua `ctx.noteFeeRef` (open-vault, open-fund), tách khỏi `holdDid`.
Nguồn: `VaultTxAPI/src/sponsor.ts` ▸ `noteFeeRef`.
**Vì sao.** Feecover đòi `ref` = tên anchor DID cho MỌI `sponsor_open` (luật L29), có quỹ hay không. Bản trước chỉ
gửi owner_commit khi tx chở genesis, nên open-vault cho chủ thứ hai của một DID đã có quỹ bị từ chối ký. Feecover
đếm một-quỹ-mỗi-DID chỉ trên `open_sponsor_fund` và `sponsor_open` có genesis, nên tx không chở quỹ mang
owner_commit không xung đột.
**Cái gì gãy.** Không gì ở thân yêu cầu hay lời đáp. Nhật ký Feecover tra open-vault theo owner_commit, không theo
hash thân tx.

## 2026-10-07 — VaultTxAPI: `/fee/sign` gửi `ref` = owner_commit cho tx genesis quỹ tài trợ và claim

**Đổi gì.** Tx genesis quỹ tài trợ (open-vault chở quỹ, open-fund) ghi `feeRef` = owner_commit của DID vào sổ
phát-hành; claim trên quỹ có DID ghi `feeRef` = owner_commit trong datum quỹ. `/fee/sign` gửi `feeRef` đó làm `ref`
cho Feecover. Tx tài trợ còn lại (open-vault không chở quỹ, bind-did, fund-vault, draw-magic, first-consume, claim
quỹ `sponsorship = None`) vẫn gửi hash thân tx. Nguồn: `VaultTxAPI/src/sponsor.ts` ▸ `genesisDids` trong lượt dựng
bước, khối ghi sổ của claim; `VaultTxAPI/src/feeProxy.ts` ▸ nhánh `entry.feeRef`.
**Vì sao.** Feecover đếm "mỗi DID một quỹ trọn đời" theo `ref` của `sponsor_open` / `open_sponsor_fund`, và đòi
`ref` là owner_commit 64 hex. Bản cũ gửi hash thân tx ⟹ Feecover từ chối ký open-fund.
**Cái gì gãy.** Bên đọc nhật ký Feecover theo `ref` = hash thân tx sẽ không thấy hash ở ba loại tx trên nữa; tra theo
owner_commit. Không đổi gì ở thân yêu cầu hay lời đáp của VaultTxAPI.

## 2026-10-07 — VaultTxAPI: `/tx/sponsor/plan` nói ai GỌI từng bước (`actor`), lọc được theo vai

**Đổi gì.** Mỗi bước trong `steps` / `fallback_steps` mang `actor`: `app` (open-vault, bind-did, draw-magic, Wakeme,
open-fund), `sponsor` (fund-vault, claim), `module` (first-consume). Thân có `actor` ⟹ chỉ trả bước của vai đó;
giá trị lạ ⟹ 400. Nguồn: `VaultTxAPI/src/sponsor.ts` ▸ `ACTOR_OF_STEP`, `sponsorPlanBody`.
**Vì sao.** Consume do backend module làm, app không làm; app và module cùng đọc một kế hoạch, và lọc theo tên bước
là bắt bên gọi giữ danh sách tên phải bỏ.
**Cái gì gãy.** Không gì: thân không có `actor` trả đủ bước như trước, chỉ thêm một trường.

## 2026-10-07 — VaultTxAPI: không thẻ bài thì không nhận yêu cầu đã qua proxy

**Đổi gì.** (1) Đặt `VAULT_TX_API_BASE_PATH` mà `VAULT_TX_API_TOKEN` rỗng ⟹ từ chối khởi động, kể cả khi bind
loopback. (2) Thẻ rỗng mà yêu cầu mang `Forwarded` / `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP` ⟹
`401 UNAUTHORIZED`; `/health` vẫn mở. Nguồn: `VaultTxAPI/src/config.ts` ▸ `loadConfig` (khối thẻ bài);
`VaultTxAPI/src/http.ts` ▸ `requireToken`, `forwardedBy`.
**Vì sao.** Cổng cũ chỉ đòi thẻ khi host không phải loopback. Đứng sau proxy hay đường hầm thì loopback là cổng mở ra
ngoài: đo 2026-10-07, tiến trình bind `127.0.0.1` sau đường hầm, tiền tố `/vaulttx/preprod`, không thẻ, trả 200 cho
`POST /tx/consume` gửi từ internet không kèm `Authorization`, dựng tx và giữ khoá két chủ.
**Cái gì gãy.** Triển khai đang đặt tiền tố đường mà chưa có thẻ sẽ KHÔNG khởi động sau bản này: đặt thẻ, trao thẻ
cho bên gọi trước. Bên gọi đi qua proxy tới một dịch vụ không thẻ nhận 401.

## 2026-10-07 — VaultTxAPI: vá audit chồng #157→#162 @5274b8c8 — claim không kẹt vì mã hoá datum / đổi cấu hình; giữ DID ở fund-vault; VaultReadAPI buildInfo

**Đổi gì.** (1) `paid_fund.sponsor.beneficiary_datum` được chuẩn hoá MỘT lần lúc nạp cấu hình (giải mã rồi mã hoá
lại như `Data.to` của Lucid); hàm ký platform so datum output claim trên dạng chuẩn hoá và từ chối khởi động nếu
datum ghim chưa chuẩn; lời từ chối nói rõ là lệch CẤU TRÚC. (2) claim chỉ từ chối `missing` / `ambiguous` /
`undecodable` / `foreign_platform` / `foreign_beneficiary` — đúng thứ hàm ký kiểm; quỹ lệch đệm, ví bên tài trợ,
két, mốc thu hồi, đã thu hồi vẫn claim được; claim so lại platform + đích cho mọi quỹ có datum. (3) open-vault /
open-fund coi MỌI quỹ của DID do platform đã ghim ký (trừ `foreign_platform`, `foreign_beneficiary`) là "đã có quỹ"
⟹ không ký genesis quỹ thứ hai sau một lần đổi cấu hình; `wrong_vault` nay mang `owner_commit`; 409 kèm
`details.labels`. (4) fund-vault giữ `did-fund:<did_commit>` tới hết hạn tx; fund-vault trên quỹ khác của cùng DID
trong khe ⟹ `409 SPONSOR_DID_FUND_IN_FLIGHT`; dựng lại trên cùng quỹ thay lượt cũ. (5) claim kèm `fee_payer` không
nhận `amount` ⟹ `400 SPONSOR_CLAIM_AMOUNT_WITH_FEE_PAYER`; `change_address` vẫn nhận. (6) Lời khai về
`scrubPlatformKey` sửa: chỉ chặn tiến trình con, không chặn `ps eww` / `/proc/<pid>/environ`; dòng nhật ký khởi
động nêu pkh platform khi hàm ký bật thay vì "KHÔNG giữ khoá riêng". (7) `VaultReadAPI/src/buildInfo.ts` lấy lại thân
của bản `VaultTxAPI` (môi trường tường minh cho `git`), thêm `childProcessEnv` ở `VaultReadAPI/src/config.ts` — CI
`npm · VaultReadAPI` đỏ vì bài so thân hai bản. Nguồn: `VaultTxAPI/src/config.ts` ▸ `parseFundBeneficiary`;
`VaultTxAPI/src/platformSigner.ts` ▸ `createPlatformSigner`; `VaultTxAPI/src/sponsorFund.ts` ▸ `claimRefusal`,
`fundsBlockingOpen`, `classifySponsorFunds`; `VaultTxAPI/src/sponsor.ts` ▸ `claimFund`, `fundVault`,
`parseClaimRequest`, `serviceKeyStatusLine`; `VaultTxAPI/src/locks.ts` ▸ `DidGenesisHolds`.

**Vì sao.** Audit chồng PR #157→#162 trên `5274b8c8`: cấu hình datum dạng định độ dài làm hàm ký từ chối MỌI claim
(Lucid dựng output dạng không định độ dài); đổi một tham số cấu hình làm mọi quỹ cũ không claim được và mở đường ký
genesis quỹ thứ hai cho cùng DID; khoá chủ của fund-vault hết trước tx; rút lẻ qua `fee_payer` bắt ví phí ứng
min-ADA mỗi lượt.

**Cái gì gãy nếu bám bản cũ.** `parseDeployment(...).prepaid.sponsor.beneficiary.datumCbor` nay là dạng chuẩn hoá,
không phải chuỗi gõ vào. `createPlatformSigner` ném lúc khởi động nếu `beneficiary.datumCbor` chưa chuẩn. claim
`fee_payer` + `amount` từ 200 thành 400. open-fund cho DID có quỹ lệch cấu hình từ 200 thành 409. fund-vault thứ hai
của cùng DID trên quỹ khác trong khe từ 200 thành 409. `fundsBlockingOpen` đếm cả quỹ lệch cấu hình.
`DidGenesisHolds.claim` nhận thêm tham số `tag` (tuỳ chọn).

## 2026-10-07 — VaultTxAPI: vá review #162 — ví trả phí ≠ khoá platform, route claim, giữ DID khi genesis

**Đổi gì.** (1) Ví trả phí mang khoá thanh toán nằm trong `platform_pkhs` ⟹ `422 SPONSOR_FEE_WALLET_IS_PLATFORM`
ở mọi bước tài trợ và ở claim; hàm ký platform nay nhận kèm MỌI input + thế chấp đã giải và từ chối input/thế
chấp ở địa chỉ khoá platform, mục rút từ tài khoản thưởng của khoá đó, chứng chỉ, biểu quyết; lúc khởi động
dịch vụ CẢNH BÁO (không từ chối) khi địa chỉ enterprise của khoá giữ UTxO. (2) Route mới `POST
/tx/sponsor/claim` (thẻ vai sponsor; `fund_id`, `amount` tuỳ chọn): dịch vụ dựng `FundClaim` hoặc lượt rút cuối
đóng quỹ đã thu hồi rồi ký platform; CARP chỉ tới beneficiary ghim trong datum, quỹ chỉ được nhận khi beneficiary
đó khớp cấu hình. Hàm ký có nhánh thứ hai, hẹp: đúng một input `paid_fund` tiêu bằng `FundClaim`, CARP chỉ tới
beneficiary ghim hoặc về lại quỹ, mint rỗng hoặc chỉ đốt NFT của chính quỹ, `required_signers` ∋ platform. Khoá
route `sponsor-claim`, purpose Feecover `sponsor_claim`; `/tx/sponsor/plan` thêm bước claim sau first-consume.
(3) Genesis quỹ (open-vault chở quỹ, open-fund) giữ `did:<did_commit>` tới hết hạn tx ⟹ lượt thứ hai trong khe
`409 SPONSOR_DID_GENESIS_IN_FLIGHT`. (4) `VAULT_TX_API_PLATFORM_KEY` bị gỡ khỏi môi trường tiến trình ngay sau khi
đọc; `git` của `buildInfo.ts` chạy với môi trường tường minh. (5) README: hệ quả khi khoá lộ viết lại đủ ba điều,
quy trình xoay khoá, bảng lỗi. Nguồn: `VaultTxAPI/src/platformSigner.ts` ▸ `createPlatformSigner`;
`VaultTxAPI/src/sponsor.ts` ▸ `claimFund`, `assertFeeWalletNotPlatform`, `platformAddressFundedWarning`;
`VaultTxAPI/src/locks.ts` ▸ `DidGenesisHolds`; `VaultTxAPI/src/config.ts` ▸ `scrubPlatformKey`, `childProcessEnv`.

**Vì sao.** Review PR #162: witness platform thoả mọi chữ ký khoá đó đòi trong thân tx, nên ví trả phí đặt ở
địa chỉ khoá platform được "dịch vụ trả hộ"; `FundClaim` đòi chữ ký platform mà chỉ dịch vụ giữ khoá, không có
route thì E kẹt trong quỹ; hai genesis cho cùng DID dựng được trước khi tx đầu vào khối.

**Cái gì gãy nếu bám bản cũ.** `createPlatformSigner(...)` trả hàm nhận `{ kind, tx, inputs }` thay cho một
`CML.Transaction`; tuỳ chọn thêm `network`, `carpUnit`, `beneficiary`. `SPONSOR_ROUTES` thêm `sponsor-claim` —
bảng purpose Feecover không có khoá đó thì `/tx/sponsor/claim` qua `fee_payer` trả `400 FEE_PROXY_PURPOSE_UNMAPPED`.
`/tx/sponsor/plan` có thêm một dòng `claim`. Quỹ đúc bằng khoá platform cũ không claim được qua dịch vụ chạy khoá
mới (README ▸ "Xoay khoá platform").

## 2026-10-07 — VaultTxAPI: vá review #161 — trần khoản ứng, chủ ký open-fund, ghim quỹ chặt hơn

**Đổi gì.** (1) Hành trình tài trợ: `thread_lovelace` đi cùng `fee_payer` ⟹ `400
SPONSOR_THREAD_LOVELACE_WITH_FEE_PAYER`; `checkSponsorFeePayerTx` kẹp khoản ứng ≤ Σ min-UTxO output script +
`SPONSOR_FRONTING_SLACK_LOVELACE` (1 ADA) ⟹ `422 FEE_PAYER_FRONTING_ABOVE_MAX`. Lỗ có từ `main` (sponsor
open-vault nhận `thread_lovelace` không trần, khoản ứng không trần; CloseThread không ràng output nên chủ lấy
lại ADA ví trả phí ứng). (2) open-fund: chủ KÝ (mục rút did_stake / khoá chủ), bảng `signers` thêm vai `owner`,
`summary.withdrawals`. (3) `assertOwnerDid` (mọi bước tài trợ): ngoài tên anchor, `did_stake` chưa apply apply
`(anchor_nft_policy, tên anchor)` phải băm ra `owner.hash` — lệch ⟹ `422 SPONSOR_OWNER_DID_MISMATCH`; thiếu
`did_stake.unapplied_script` ⟹ `501 SPONSOR_OWNER_DID_UNVERIFIABLE`. (4) fund-vault: UTxO CARP phải do khoá
trong `sponsorship.sponsor` của quỹ ⟹ `422 SPONSOR_UTXO_NOT_FUND_SPONSOR`; vai `sponsor` ký bằng khoá trong
datum; DID đã nhận tài trợ ở quỹ khác (`credit_issued > 0`) ⟹ `409 SPONSOR_DID_FUNDED_ELSEWHERE`.
(5) `classifySponsorFunds`: `buffer_mismatch` (đệm ≠ cấu hình), `reclaim_too_far` (`reclaim_after_epoch` > epoch
đỉnh chuỗi + 200 + `SPONSOR_RECLAIM_EPOCH_SLACK`), `reclaimed` (`sponsor_reclaimed > 0`); open-fund vẫn coi
quỹ đã thu hồi là "đã có quỹ". `GET /sponsor/funds` đọc đỉnh chuỗi để tính epoch. Nguồn: `VaultTxAPI/src/sponsor.ts`
▸ `parseSponsorRequest`, `checkSponsorFeePayerTx`, `openFund`, `assertOwnerDid`, `assertSponsorUtxosOfFundSponsor`;
`VaultTxAPI/src/sponsorFund.ts` ▸ `classifySponsorFunds`, `fundsBlockingOpen`, `assertDidNotFundedElsewhere`.

**Vì sao.** Review PR #161 + red-team hành trình tài trợ (2026-10-07): ví trả phí bên thứ ba bị rút ADA qua
lovelace người gọi tự khai; CBOR did_stake và `anchor_ref` đều do người gọi đưa nên phép so tên anchor một mình
không buộc chủ vào DID; `addresses` nhiều ví làm tx đòi khoá A mà bảng ký kê khoá B; người giữ khoá platform
đúc được quỹ đệm/mốc thu hồi lạ; nạp lần hai cho cùng DID qua `fund_id` hoặc quỹ đã thu hồi.

**Gãy gì nếu bám bản cũ.** Bên gọi gửi `thread_lovelace` cùng `fee_payer` nhận 400. open-fund nay cần chữ ký
chủ (bên ký phải thêm chữ ký did_stake). Bản deploy có chủ script mà thiếu `did_stake.unapplied_script` nhận 501
ở mọi bước tài trợ. Cấu hình `paid_fund.sponsor` phải khai `buffer_bps` đúng đệm của các quỹ đang có (vắng ⟹
`MIN_BUFFER_BPS`), không thì quỹ cũ thành `buffer_mismatch`. `classifySponsorFunds` và
`checkSponsorFeePayerTx` nhận thêm trường bắt buộc (`bufferBps`, `reclaimHorizon`, `coinsPerUtxoByte`).

## 2026-10-07 — VaultTxAPI: open-vault chở genesis quỹ tài trợ của DID; dịch vụ giữ MỘT khoá, ký vai platform

**Đổi gì.** `POST /tx/sponsor/open-vault` dựng MỘT tx: két Prepaid + thread consume + genesis quỹ `paid_fund`
của DID (`owner_commit` = `did_commit` của thread trong chính tx đó; seed quỹ = seed két). Dịch vụ gắn vkey
witness platform vào `tx_cbor`; `signers` thêm `{ role: "platform", how: "service" }`; `summary.fund` mới
(`created` | `existing`). DID đã có quỹ dùng được ⟹ không genesis quỹ thứ hai. `open-fund` thành bước BÙ (két mở
trước bản này), cũng do dịch vụ ký platform; `/tx/sponsor/plan` đưa nó sang `fallback_steps`. Khoá ở biến mới
`VAULT_TX_API_PLATFORM_KEY` (GIÁ TRỊ bech32 `ed25519_sk…`), chỉ nằm trong `VaultTxAPI/src/platformSigner.ts`
▸ `createPlatformSigner`: lúc khởi động suy pkh, đòi `== paid_fund.sponsor.platform_pkhs[0]`, đòi khác mọi thẻ
bài; hàm ký chỉ nhận đối tượng tx dịch vụ vừa dựng, có đúng một mint +1 NFT `paid_fund` và `required_signers`
chứa pkh platform. Vắng khoá ⟹ route cần tạo quỹ trả `501 CONFIG_MISSING` (`details.missing` nêu tên biến).
`MagicSDK` ▸ `buildSponsorT1OpenPrepaid` nhận thêm `extend` (tuỳ chọn) để chở phần dựng thêm vào cùng tx.

**Vì sao.** Chủ dự án chốt 2026-10-07: bớt một bước của người mới, bên trả phí không phải giữ khoá platform.
Thay quyết định sáng cùng ngày ("Feecover ký platform"). Bất biến số một của VaultTxAPI viết lại theo nghĩa mới
(README §1); `tests/noSigningMaterial.test.ts` đo nó: đúng một mô-đun mang vật liệu ký, đúng một biến mang khoá.

**Cái gì gãy nếu bám bản cũ.** (1) Tx open-vault (DID chưa có quỹ) có thêm một output quỹ, một mint, một
required signer và một vkey witness sẵn: bên ký phải GIỮ witness đã có khi ghép chữ ký (`assemble` của Lucid giữ).
Ví trả phí ứng thêm min-ADA quỹ (đo Emulator: output quỹ 2.366.190 lovelace; tổng khoản ứng két + thread + quỹ 5.775.560 lovelace). (2) Cấu hình có `fund_units` (tập đóng) hoặc thiếu khoá: open-vault cho DID chưa có
quỹ nay trả 501 thay vì dựng két không quỹ. (3) Thứ tự kế hoạch: open-fund không còn trong `steps`.
(4) open-fund: `CONFIG_MISSING` nay nêu thêm `VAULT_TX_API_PLATFORM_KEY`; tx trả về mang witness platform.

## 2026-10-07 — VaultTxAPI: `POST /tx/sponsor/open-fund` — tạo quỹ tài trợ cho một DID, platform ký

**Đổi gì.** Route mới `/tx/sponsor/open-fund` (route sổ phát-hành / `/fee/utxo` `sponsor-open-fund`;
purpose Feecover đề xuất `open_sponsor_fund`) dựng tx genesis `paid_fund` với `sponsorship = Some {
sponsor = addresses[0], owner_commit = did_commit của thread, reclaim_after_epoch = epoch(validTo) + 200 }`,
`platform = platform_pkhs[0]`, 0 CARP. `required_signers = [platform]`; chủ két không ký. Đứng sau
bind-did, trước fund-vault; `/tx/sponsor/plan` trả sáu bước. Mã mới: `SPONSOR_FUND_ALREADY_OPEN` 409,
`SPONSOR_FUND_SET_CLOSED` 501; thiếu `platform_pkhs`/`beneficiary` ⟹ `CONFIG_MISSING` 501. Khoá cấu
hình tuỳ chọn mới: `paid_fund.sponsor.beneficiary`, `beneficiary_datum`, `buffer_bps`. Nguồn:
`VaultTxAPI/src/sponsor.ts` ▸ `openFund`; bộ dựng `PrepaidGen/offchain/src/tx/builders.ts` ▸ `planMintPaidFund`.
open-fund nhận `fee_payer` và đi qua cổng `reservation_id` như mọi bước tài trợ; danh sách đóng route kiểm
mã ở README thêm `/tx/sponsor/open-fund` (13 → 14 route).
Ghim đích nhận CARP khi đọc quỹ: có `paid_fund.sponsor.beneficiary` ⟹ quỹ có `beneficiary` (bech32) hoặc
`beneficiary_datum` (CBOR chuẩn hoá; vắng ⟺ vắng) khác ghim mang `problem: foreign_beneficiary`, fund-vault không
chọn (`VaultTxAPI/src/sponsorFund.ts` ▸ `classifySponsorFunds`); quét theo `platform_pkhs` mà không có `fund_units`
thì `beneficiary` bắt buộc. Lý do: ở đường quét mọi quỹ do khoá platform đúc đều được tin, nên người giữ khoá đó
(khoá lộ) đúc được quỹ đúng ví bên tài trợ + đúng DID nạn nhân mà trả CARP về ví mình qua `FundClaim`.
PrepaidGen SDK thêm `plutusDataFromCbor` / `plutusDataToCbor` (`PrepaidGen/offchain/src/tx/codec.ts`): VaultTxAPI và SDK
giữ hai bản `@lucid-evolution/lucid`, nên `Constr` dựng bằng `Data` của VaultTxAPI làm `encodeFundDatum` ném
"Unsupported type" — open-fund với `beneficiary_datum` nay dựng datum bằng codec của SDK.

**Vì sao.** Chủ dự án chốt 2026-10-07: mỗi DID một quỹ, và Feecover ký vai `platform` cùng lượt trả
phí tx tạo quỹ. Genesis quỹ (`PrepaidGen/onchain/validators/prepaid.ak` ▸ `validate_mint_fund_nft`) chỉ
đòi chữ ký platform; CARP không vào lúc genesis (`carp_locked == 0`) mà ở fund-vault. Dịch vụ vẫn không
giữ khoá nào — chỉ đặt pkh platform vào `required_signers`.

**Cái gì gãy nếu bám bản cũ.** Bên đọc `/tx/sponsor/plan` theo chỉ số mảng: open-fund chèn ở vị trí 3.
Cấu hình có `fund_units` không dùng được open-fund (501 `SPONSOR_FUND_SET_CLOSED`) — quỹ mới không nằm
trong tập đóng; chuyển sang `platform_pkhs`. `SPONSOR_FUND_NOT_OPENED` nay trỏ tới open-fund. Cấu hình có
`platform_pkhs`, không `fund_units`, thiếu `beneficiary` ⟹ từ chối khởi động; `beneficiary_datum` không giải mã
được thành Plutus Data ⟹ từ chối khởi động.

## 2026-10-07 — VaultTxAPI: hành trình tài trợ theo DID — đổi tên đường, mỗi DID một quỹ, bước `bind-did`, ghim `platform_pkhs`

**Đổi gì.**
- Đổi tên đường tài trợ: `/tx/sponsor/{t1-open,t2-fund,t3-draw,t4-first-consume}` →
  `/tx/sponsor/{open-vault,fund-vault,draw-magic,first-consume}`; route sổ phát-hành / `/fee/utxo`
  `sponsor-t*` → `sponsor-open-vault` … `sponsor-first-consume`. Bảng mục đích Feecover trong cấu
  hình vẫn nhận bốn khoá tên cũ làm bí danh (`VaultTxAPI/src/config.ts` ▸ `LEGACY_SPONSOR_PURPOSE_KEYS`).
- fund-vault nạp vào **quỹ tài trợ của DID** (`sponsorship = Some`, `owner_commit` == `did_commit`
  của thread); `fund_id` thành tuỳ chọn — vắng thì dịch vụ tự tìm (`VaultTxAPI/src/sponsorFund.ts` ▸
  `resolveSponsorFund`). Quỹ chung `sponsorship = None` bị loại khỏi hành trình. Mã mới:
  `SPONSOR_FUND_NOT_OPENED` 409, `SPONSOR_FUND_AMBIGUOUS` 409, `SPONSOR_FUND_DID_MISMATCH` 422,
  `SPONSOR_VAULT_DID_UNSET` 409, `SPONSOR_VAULT_DID_MISMATCH` 422; `SPONSOR_FUND_NOT_ALLOWED` 422 kèm
  `details.problem`. Đường đọc mới `GET /sponsor/funds`.
- Bước mới `POST /tx/sponsor/bind-did` (`SetDidCommit`, gắn `did_commit` của thread vào két Prepaid,
  một lần; `SPONSOR_VAULT_DID_ALREADY_SET` 409), giữa open-vault và fund-vault; `/tx/sponsor/plan` trả
  năm bước. Bộ dựng ở PrepaidGen SDK: `PrepaidGen/offchain/src/tx/builders.ts` ▸ `planSetDidCommit` /
  `addSetDidCommit`, redeemer `codec.ts` ▸ `setDidCommitRedeemer`.
- Khoá cấu hình tuỳ chọn `paid_fund.sponsor.platform_pkhs`: có mặt ⟹ dịch vụ chỉ nhận quỹ có
  `datum.platform` thuộc tập này; vắng `fund_units` ⟹ quét địa chỉ quỹ thay vì tra tập ghim. Cần ít
  nhất một trong `fund_units` / `platform_pkhs`.
- Cổng `reservation_id` (mục cùng ngày bên dưới) áp nguyên cho các bước tài trợ tên mới, gồm cả bind-did: mọi
  bước đi chung `VaultTxAPI/src/sponsor.ts` ▸ `planSponsorValidity`. Danh sách đóng route kiểm mã ở
  README ▸ *Proxy phí* ▸ `reservation_id` đổi sang tên mới và thêm `/tx/sponsor/bind-did` (12 → 13 route).

**Vì sao.** Chủ dự án chốt 2026-10-07: mỗi DID một quỹ tài trợ — CARP bên tài trợ góp phải thu hồi
được, mà validator chỉ cho thu hồi khi quỹ buộc vào đúng một DID (`PrepaidGen/onchain/validators/prepaid.ak`
▸ `validate_lock`, khối `sponsorship`). Két Prepaid đúc với `did_commit` rỗng, nên hành trình thiếu
một bước gắn DID trước lượt nạp — trước đây chỉ bài kiểm tự dựng tx `SetDidCommit` thô. Ghim
`platform` vì lượt đúc quỹ chỉ đòi chữ ký platform, không đòi bên tài trợ: quét địa chỉ quỹ mà chỉ lọc
theo ví bên tài trợ là nạp CARP vào quỹ kẻ gọi tự đúc. Tên `t1`…`t4` là ký hiệu số của bộ dựng, không
nói bước làm gì.

**Cái gì gãy nếu bám bản cũ.** Gọi đường tên cũ ⟹ `404 NOT_FOUND`; `/fee/utxo` với `route` tên cũ ⟹
bị từ chối. fund-vault trên két chưa gắn DID ⟹ `409 SPONSOR_VAULT_DID_UNSET` (gọi bind-did trước). Quỹ
chung (`sponsorship = None`) trong `fund_units` không còn được nạp (`problem: not_sponsored`). Cấu hình
`paid_fund.sponsor` thiếu cả `fund_units` lẫn `platform_pkhs` ⟹ từ chối khởi động. Chưa có route tạo
quỹ cho một DID: quỹ tạo trước bằng công cụ vận hành.

## 2026-10-07 — VaultTxAPI: nguồn Feecover xác nhận phải khớp nguồn đã xin; `/tx/quote` đọc `X-Feecover-Token`

**Đổi gì.** `/fee/utxo` và `/fee/sign`: Feecover trả `source` khác nguồn đã xin (vắng = `feecover`) ⟹
`502 FEE_SOURCE_NOT_CONFIRMED` (`details.confirmed_source` = giá trị Feecover trả); `/fee/utxo` không ghi
lượt giữ, `/fee/sign` không giao chữ ký. `/fee/sign` kiểm `source` của Feecover theo enum
(`feecover` | `sponsor`) như `/fee/utxo`; giá trị khác ⟹ `502 FEE_PROXY_UPSTREAM`. `/tx/quote` đọc tiêu đề
`X-Feecover-Token` như `/fee/*` và hỏi `/v1/fee-sources` dưới đúng ứng dụng đó (`FeeProxy.feeSources` nhận
thêm `callerToken`); token không khớp ⟹ `401 FEE_PROXY_APP_UNKNOWN`. README sửa câu L38: Feecover từ chối
chủ không DID lúc ký, không phải lúc xin UTxO.

**Vì sao.** Review #159: thân trả vọng nguyên `source` lệch với 200, nên app có thể nhận chữ ký dưới nguồn
khác nguồn nó xin (tưởng tài trợ mà bị trừ CARP); báo giá hỏi Feecover dưới ứng dụng mặc định trong khi
`/fee/*` dùng ứng dụng của token, nên `fee_sources` có thể lệch ứng dụng thật.

**Cái gì gãy nếu bám bản cũ.** Client dựa vào việc thân 200 vọng `source` khác yêu cầu (để tự từ chối) nay
nhận 502. Client gửi `X-Feecover-Token` sai tới `/tx/quote` (trước đây bị bỏ qua) nay nhận 401.

## 2026-10-07 — VaultTxAPI: `fee_sources` trong báo giá; `source` ở `/fee/utxo` + `/fee/sign`

**Đổi gì.** `POST /tx/quote` trả thêm `fee_sources` = ba khối `owner_address` / `feecover` / `sponsor`
NGUYÊN như Feecover trả ở `GET /v1/fee-sources` (trường vắng giữ vắng); chủ là DID ⟹ hỏi kèm
`owner_commit` = tên anchor của DID. Không hỏi được Feecover ⟹ `feecover` + `sponsor` =
`{available:false, reason, message}`, báo giá vẫn 200; `owner_address` do dịch vụ dựng khi Feecover không
gửi (`feeQuote.ts` ▸ `OWNER_ADDRESS_SOURCE`). `/fee/utxo` và `/fee/sign` nhận `source` (`feecover` |
`sponsor`, vắng = `feecover`; khác ⟹ `400 FEE_PROXY_SOURCE_INVALID`), chuyển tiếp sang `/v1/utxo` +
`/v1/sign`; nguồn Feecover xác nhận ghi vào lượt giữ, `/fee/sign` lệch nguồn ⟹ `400
FEE_PROXY_SOURCE_MISMATCH`. Thân trả vọng `source` LẤY TỪ câu trả lời Feecover; xin `sponsor` mà Feecover
không trả `source` ⟹ `502 FEE_SOURCE_NOT_CONFIRMED`. Không có giá CARP nào do dịch vụ đặt ra.

**Vì sao.** Thư SuperApp `sa1007mg-fs` / `sa1007mg-fs2` (cửa sổ ba nguồn phí) và OriLife `ol1007mg-a`
(chuyển `source` ở `/fee/sign`), theo hợp đồng Feecover nhánh nguồn sponsor (L38).

**Cái gì gãy nếu bám bản cũ.** Client so thân `/tx/quote` bằng phép bằng chặt gặp thêm `fee_sources`.
Client gửi `source` khác hai giá trị trên (kể cả `null`) trước đây bị bỏ qua, nay 400.
`IssuedTxRegistry.noteFeeReservation` có thêm tham số thứ năm `source` (mặc định `feecover`).
`FeeProxy.feeSources` nhận thêm `ownerCommit`, kết quả `answered: true` có thêm `blocks`.

## 2026-10-07 — VaultTxAPI: mã lượt giữ `reservation_id` (bước 1, tuỳ chọn)

**Đổi gì.** `POST /fee/utxo` trả thêm `fee_payer.reservation_id` (32 hex = 128 bit ngẫu nhiên, sinh mỗi
lượt giữ, lưu cạnh lượt giữ ở `VaultTxAPI/src/locks.ts` ▸ `IssuedTxRegistry`). Mọi route nhận `fee_payer`
(danh sách đóng 12 route ở README ▸ *Proxy phí* ▸ `reservation_id`) nhận `fee_payer.reservation_id` /
`funding.fee_payer.reservation_id` tuỳ chọn: lệch mã lượt giữ đang sống ⟹ `409
FEE_PAYER_RESERVATION_EXPIRED` với `reservation: "foreign"`; sai khuôn ⟹ `400 FEE_PAYER_SHAPE` /
`FUNDING_SHAPE`; vắng ⟹ như cũ, và được đếm (một dòng nhật ký JSON `fee_reservation_id_missing` mang số
đếm luỹ kế theo route; KHÔNG lộ ra HTTP, `/health` không cần thẻ). Chỉ lượt dựng đã ghi sổ mới đếm. Sổ
phát-hành ghi mã của lượt giữ mà cổng dựng ĐÃ THẤY (chụp lúc qua cổng, không tra lại lúc ghi sổ); `/fee/sign`
so với mã đang sống, lệch ⟹ 409 `foreign`, Feecover không bị gọi. Tx bị thay chỉ bỏ đúng lượt giữ cùng mã.

**Vì sao.** Thư `mg1007sa-b` / `sa1007mg-rid`: sổ giữ chỗ khoá theo UTxO; mọi bản app đi chung thẻ dịch
vụ, nên khi Feecover giao lại cùng UTxO cho B, A còn cầm `fee_payer` cũ vẫn dựng được trên lượt giữ của B.
Bước 2 (bắt buộc mã) chỉ bật sau khi đo tỉ lệ thiếu mã và SuperApp báo số bản app gửi mã.

**Cái gì gãy nếu bám bản cũ.** Client so `fee_payer` của `/fee/utxo` bằng phép bằng chặt gặp thêm
`reservation_id`. `/fee/sign` cho tx dựng khi CHƯA có lượt giữ nào mà nay UTxO đang được giữ: trước ra
`exceeded`/được ký, nay `foreign`. `details.reservation` có thêm giá trị `foreign`. `IssuedTxRegistry`
nhận một hàm ghi nhật ký tuỳ chọn ở hàm dựng; `noteFeeReservation` trả mã lượt giữ;
`feeReservationForBuild` trả `{ untilMs, id }` thay vì một số, và không còn nhận `route`.

## 2026-10-07 — VaultTxAPI: UTxO Feecover không còn lượt giữ chỗ ⟹ không dựng, không ký

**Đổi gì.** Sổ phát-hành (`VaultTxAPI/src/locks.ts` ▸ `IssuedTxRegistry`) nhớ thêm địa chỉ ví trả phí
mà `/fee/utxo` đã trả. Lượt dựng tiêu một UTxO ở địa chỉ Feecover mà sổ không còn lượt giữ chỗ ⟹
`409 FEE_PAYER_RESERVATION_EXPIRED` (`feeReservationForBuild`; dùng ở `service.ts` ▸ `validityPlan` và
`sponsor.ts` ▸ `planSponsorValidity`). `/fee/sign` tra LẠI lượt giữ lúc ký (`feeSignProblem`): không có,
đã qua, hoặc `validTo` của tx vượt nó ⟹ cùng mã 409, Feecover không bị gọi. `details` của mã này có
thêm `fee_payer_utxo` và `reservation` (`absent` · `expired` · `exceeded`); `reserved_until` là `null`
khi sổ không có lượt giữ. Hai lỗi cùng mã vì app làm cùng một việc: xin `/fee/utxo` rồi dựng lại.

**Vì sao.** Thư SuperApp `sa1007mg-fc`: bộ quét 30 s (`server.ts`) xoá lượt giữ khi `reserved_until`
đã qua, và `feeReservationOf` trả `undefined` — bộ lập hạn đọc thành "ví không giữ chỗ ⟹ không kẹp".
Dựng lại với `fee_payer` cũ ra tx hạn 15 phút, ghi sổ với hạn ký = hạn nộp, và `/fee/sign` xin Feecover
ký tới hết hạn đó — trong khi Feecover có thể đã giao UTxO cho người khác. Tx GỐC thì vô hại (`validTo`
≤ `reserved_until`); hỏng thật là tx DỰNG LẠI sau khi bị quét. Thiếu dữ liệu giữ chỗ nay là từ chối,
không phải mặc định thoải mái.

**Cái gì gãy nếu bám bản cũ.** App dựng lại với `fee_payer` Feecover cũ sau khi `reserved_until` qua
nay nhận 409 thay vì một tx — xin UTxO mới qua `/fee/utxo`. `/fee/sign` cho tx tiêu UTxO Feecover
KHÔNG lấy qua `/fee/utxo` của chính tiến trình này (app tự xin Feecover bằng token riêng, hoặc tiến
trình vừa khởi động lại) nay nhận `409` thay vì được ký: bản cũ gọi đó là "app tự đưa ⟹ hạn ký = hạn
sổ". Ví trả phí là ví của chính chủ (app tự ký, không gọi `/fee/sign`) không đổi gì. Client kiểm
`details` của `FEE_PAYER_RESERVATION_EXPIRED` chặt sẽ gặp hai trường mới.

**Chưa vá, cần quyết hợp đồng.** Sổ giữ chỗ khoá theo UTxO, không theo NGƯỜI được giữ: Feecover phát
lại cùng UTxO cho B (lượt giữ mới R2) thì A dựng lại với `fee_payer` cũ cũng được kẹp vào R2 và xin
ký được. Dịch vụ không phân biệt A với B (mọi người dùng app `magic` đi chung một token). Bịt cần
`/fee/utxo` trả một mã giữ chỗ mà lượt dựng phải gửi kèm, hoặc Feecover tự ràng lượt ký vào lượt giữ.

## 2026-10-07 — Xoá module `Paymaster/`

**Đổi gì.** `git rm -r Paymaster` (21 tệp: `onchain/`, `offchain/`, `tests/`, bốn tệp tài liệu).
`scripts/deployParams.ts` bỏ `PaymasterParamInputs` + `paymasterParams`; `scripts/check_param_names.ts`
bỏ ca `paymaster.paymaster.spend`, hai ca âm/dương của chốt stake Treasury gọi thẳng
`assertTreasuryStakeDecided` (chốt giữ lại, gác D14). `scripts/BUILD-RECORD.md` sinh lại, mất khối
`Paymaster/onchain`. README bỏ dòng cây thư mục. `DevStatus.md` bỏ dòng bảng module, đóng Nợ #17,
#73, #74, #77, nửa `Paymaster/` của D11 và D16, thêm mục `## Đã xoá khỏi kho — 2026-10-07`. Dòng
D16 ở `Specs/MagicLamp-Tripletoken-Feat-(Vi).md` §7.6 và `ConsumeMAGIC/CONTRACT.md` ghi trạng thái
mới. Chú thích nêu `Paymaster` là bên đọc thô trường 15 của `VaultDatum` nay nêu bên đọc theo vị trí
còn lại, két Wakeme (datum InstantGen, chỉ số ≤ 15); chỉ chú thích đổi, không định danh on-chain
nào đổi. Spec `Specs/MagicLamp-Tripletoken-Feat-(Vi).md` lên v2.4.5 (D16 đánh dấu đã đóng, bỏ dòng
lộ trình "Paymaster runner"). `DevStatus.md` ghi hai con trỏ ở kho anh em còn trỏ vào module đã xoá.

**Vì sao.** Cơ chế uỷ quyền mà đường Sponsor dựa vào đã bị bỏ khỏi mô hình 2026-09-16 (Nợ #14):
cổng PM-1.5 không thoả được, `buildSponsorTx` ném `PM-000`. Module chưa từng deploy
(`scripts/DEPLOYED.md` nhắc nó 0 lần). Yêu cầu "app trả phí hộ" do Feecover (kho
`PhoenixKeyDID/Feecover`) đảm nhận.

**Cái gì gãy nếu bám bản cũ.** Mã import `paymasterParams` / `PaymasterParamInputs` từ
`scripts/deployParams.ts` không biên dịch nữa. Không UTxO nào mất đường giải mã.

## 2026-10-06 — MagicSDK + VaultTxAPI: trần số lô đốt mỗi tx tiêu; bỏ mục đốt 0

**Đổi gì.** `MagicSDK/src/burnBatch.ts` ▸ `planBurnBatch` giới hạn số mục trong redeemer
`BurnBatch { burns }` ở `MAX_BURN_ENTRIES_PER_TX` (hằng của bộ dựng, không phải hằng on-chain).
Chọn lô: thứ tự chết tăng dần như cũ; cần quá trần thì đổi sang lô lớn trước (tập ít mục nhất);
vẫn quá trần ⟹ ném `BurnEntriesOverCapError` (mã `CONSUME_TOO_MANY_BATCHES`). Hai tên mới xuất ở
`MagicSDK/src/index.ts`. VaultTxAPI (`txBuilder.ts` ▸ `asProtocolError`) ánh xạ lỗi đó thành
`422 CONSUME_TOO_MANY_BATCHES` kèm `details.burn_entries_needed` · `burn_entries_cap` ·
`live_batches`, trước khi dựng tx. Cùng đợt: lô còn sống mà số dư 0 không còn thành mục đốt.

**Vì sao.** `apply_burns` duyệt toàn bộ danh sách lô cho mỗi mục đốt, nên một lượt tiêu đốt nhiều lô
vượt ngân sách ExUnit của tx; trước bản này lỗi chỉ lộ ở bước đánh giá script của lucid, với một
thông báo ExUnit không nói người dùng phải làm gì. Phép đo và phần chưa đo nằm ở chú thích của
`MAX_BURN_ENTRIES_PER_TX`. Lỗi mục 0: két Instant giữ lô đã đốt sạch (số dư 0) tới hết epoch, bản cũ
đưa lô đó vào `burns` với lượng 0, mà validator đòi mỗi mục `amt > 0` (`InstantGen/onchain/validators/vault.ak`
▸ `apply_burns`) ⟹ tx tiêu bị từ chối. Tái hiện: đặt bản `burnBatch.ts` trước sửa vào chỗ, ca
"lô đã đốt sạch" của `MagicSDK/tests/burnBatch.test.ts` ra `[['z0', 0n], ['b1', 100n]]`.

**Cái gì gãy nếu bám bản cũ.** Lượt tiêu cần đốt quá trần nay nhận `422 CONSUME_TOO_MANY_BATCHES`
thay vì `422 TX_BUILD_REJECTED` (hoặc một tx không lên được chuỗi) — app rẽ nhánh theo mã cũ cần
thêm mã mới. Thứ tự lô bị đốt có thể khác bản cũ đúng ở ca thứ tự chết cần quá trần. Bên gọi
`planBurnBatch` trực tiếp phải bắt `BurnEntriesOverCapError`.

## 2026-10-06 — VaultTxAPI: `GET /tx/status/{tx_hash}` (chuỗi rồi mempool, chỉ đọc)

**Đổi gì.** Đường mới `GET /tx/status/{tx_hash}` trả `{ tx_hash, state: "in_chain" | "in_mempool" |
"not_found", block?, slot?, block_time? }` — tra khối trước (`/txs/{hash}`), rồi mempool của nhà
cung cấp (`/mempool/{hash}`). Tx do chính dịch vụ phát và sổ phát-hành còn dòng ⟹ kèm `expires_at`
(= `validTo` của thân tx, cùng nguồn với các route dựng; `IssuedTxRegistry.validToOf`) và
`server_time` (`withServerTime`). Chỉ đọc: không khoá, không ghi sổ. Thẻ bài như mọi đường `/tx/*`.
`tx_hash` sai khuôn ⟹ `400 TX_HASH_INVALID` (không gọi chuỗi); nhà cung cấp lỗi / quá giờ / hình dạng
lạ ⟹ `502 TX_STATUS_PROVIDER_UNAVAILABLE` (`details.stage`). `ChainReader` có thêm phương thức
`txStatus`; phép giây → mili-giây của giờ khối gom về một hàm có tên, `blockTimeSecondsToPosixMs`,
dùng chung cho `tip` và `txStatus`.

**Vì sao.** OriLife Core phải biết một tx đã ký và nộp có lên chuỗi hay không để tính nợ, và MAGIC
đã nhận dựng đường này (thư trả `ol1005mg-b`). Quy tắc kết luận là `not_found` ∧ `now > expires_at`
⟹ tx không bao giờ lên chuỗi được, nên phản hồi phải mang `expires_at` khi dịch vụ biết nó. Một lượt
gọi hỏng mà đọc thành `not_found` là ghi nợ cho một tx đang nằm trong khối, nên chỉ hai câu 404 của
nhà cung cấp mới ra `not_found`; mọi lỗi khác ra 502 mã riêng.

**Cái gì gãy nếu bám bản cũ.** Không đường cũ nào đổi hành vi. Hiện thực `ChainReader` ngoài gói
(nếu có) phải thêm `txStatus` mới qua kiểm kiểu. `expires_at` chỉ có khi tiến trình đang chạy còn
dòng trong sổ phát-hành (sổ nằm trong bộ nhớ một tiến trình, giữ dòng quá hạn thêm
`EXPIRED_RETENTION_MS`); vắng nó thì bên gọi không kết luận được "tx chết" từ `not_found`.

## 2026-10-06 — VaultTxAPI: hạn tx một nguồn `validTo`; `expires_reason`; 410 `TX_EXPIRED`

**Đổi gì.** Mọi tx VaultTxAPI phát ra mang `validTo` trong thân, kể cả `open-thread`, `bind-did`,
`create-vault` đường `change_address` và các bước `/tx/sponsor/*`. `validTo` = mốc sớm nhất trong
ba cận (`VaultTxAPI/src/validity.ts` ▸ `planValidity`): `tip + VAULT_TX_API_TX_VALIDITY_MS` (biến
mới, mặc định `DEFAULT_TX_VALIDITY_MS` = 15 phút) · cuối epoch · `reserved_until` của UTxO ví trả phí
lấy qua `/fee/utxo`. `expires_at` nay là `validTo` đọc ngược từ chính `tx_cbor` (`readTxExpiry`),
kèm trường mới `expires_reason` (kiểu `ExpiresReason`: `tx_validity` · `epoch_end` ·
`fee_reservation` · `builder_cap`) và một dòng hạn ở cuối `witness_notes` (`expiryNote`). Tx dịch vụ
đã phát mà quá `validTo + CLOCK_SKEW_MARGIN_MS` ⟹ `410 TX_EXPIRED` ở cả `/tx/submit` lẫn
`/fee/sign` (`details.tx_hash`, `expired_at`, `rebuild_safe`, `submission`; một hàm dựng chung
`VaultTxAPI/src/locks.ts` ▸ `expiredErrorFor`). Giờ giữ chỗ phí đã qua trước khi tx kịp có khoảng
hiệu lực ⟹ `409 FEE_PAYER_RESERVATION_EXPIRED`. `VAULT_TX_API_LOCK_TTL_MS` chỉ còn điều khiển khoá
mềm theo chủ; sổ input vừa nộp có biến riêng `VAULT_TX_API_PENDING_SPENDS_TTL_MS`. `/tx/submit` kiểm
chữ ký với `required_signers` trước mọi lần ghi sổ (`witnessCheck.ts`: `400 WITNESS_SIGNATURE_INVALID`
/ `WITNESS_MISSING_SIGNER`). SDK gen/consume/schedule nhận tham số tuỳ chọn `validityMaxAheadMs` /
`validityTtlMs`; `createVault` của SDK nhận `validToMs` ≤ 1 giờ khi có `funding`. Mọi phản hồi mang
`expires_at` có thêm `server_time` (giờ dịch vụ lúc trả, ISO 8601 có mili-giây; `http.ts` ▸
`withServerTime`), đọc từ cùng đồng hồ quyết 410 ở `/tx/submit`.

**Vì sao.** Trước đây `expires_at` = lúc gọi + `lock_ttl` (180 s) — một con số dịch vụ tự khai,
không nằm trong tx. Sổ cái không biết mốc đó; vài đường (`change_address`) dựng tx không có `validTo`
nên tx sống vô hạn trong khi dịch vụ đã quên nó. App không phân biệt được "tx hết hạn, dựng lại an
toàn" với "tx không do dịch vụ phát", vì cả hai cùng ra 502 ở `/tx/submit` và 403 ở `/fee/sign`. Một
nguồn hạn duy nhất nằm trong chính thân tx thì app, dịch vụ và sổ cái đọc cùng một mốc.

**Cái gì gãy nếu bám bản cũ.** Client tự tính hạn = lúc gọi + 180 s sẽ chặn sớm tx còn tới 15 phút
hạn — đọc `expires_at` thay vì tự tính. Client đợi `502 SUBMIT_REJECTED` (ở `/tx/submit`) hoặc `403
FEE_PROXY_TX_NOT_ISSUED` (ở `/fee/sign`) cho tx hết hạn nay nhận `410 TX_EXPIRED`; nhánh "dựng lại"
phải bắt mã mới, và với `rebuild_safe: false` thì tra chuỗi theo `tx_hash` trước khi dựng lại.
Client so `expires_at` với đồng hồ của máy mình thì lệch theo độ lệch đồng hồ máy — tính hạn trên máy
= lúc nhận + (`expires_at` − `server_time`). Client kiểm lược đồ lời đáp chặt (không cho trường lạ)
sẽ gãy ở `expires_reason` và `server_time`. Tx `open-thread` /
`bind-did` / `create-vault` đường `change_address` nay hết hạn sau 15 phút thay vì sống vô hạn. Ai
đặt `VAULT_TX_API_LOCK_TTL_MS` để kéo dài hạn nộp thì biến đó không còn tác dụng ấy — dùng
`VAULT_TX_API_TX_VALIDITY_MS` (khoảng `[60000, 3600000]`). Bộ chứng ký có chữ ký sai hoặc thiếu khoá
bắt buộc nay bị `400` trước khi tới nút, thay vì để nút từ chối.

## 2026-10-06 — thưởng `did_stake` qua ví trả phí về ví Phoenix của chủ, thay vì 422

**Đổi gì.** Chủ `Script(did_stake)` có số dư thưởng R > 0 dựng qua ví trả phí (`fee_payer` ở
`/tx/open-thread`, `/tx/bind-did`, `/tx/create-vault`, và đường sponsor) không còn nhận `422
FEE_PAYER_OWNER_REWARD_NONZERO` mặc nhiên. Dịch vụ quyết trước khi dựng
(`VaultTxAPI/src/feePayer.ts` ▸ `planOwnerRewardReturn`): suy ví Phoenix của chủ (địa chỉ BASE
`did_payment` + `did_stake`, `didOwner.ts` ▸ `didPaymentAddressFor`, khớp vector DID #1 của
PhoenixKey-Core) rồi thêm đúng một output R lovelace, không datum, tới đó
(`withOwnerRewardReturn`); phép đọc lại CBOR đòi mục rút và output cùng đúng R
(`checkOwnerRewardReturn`). Phản hồi thêm `summary.fee_payer.owner_reward` và một dòng
`witness_notes`. Mã mới `422 FEE_PAYER_OWNER_REWARD_BELOW_MIN_ADA` khi R dưới min-ADA của output đó
— ví trả phí không ứng phần thiếu. Cấu hình `did_stake` thêm khoá tuỳ chọn
`did_payment_unapplied_script` (cùng luật băm-lại-và-so).

**Vì sao.** Nhân chứng chủ `did_stake` rút TRỌN số dư thưởng, và qua ví trả phí thì tiền thối về ví
trả phí: thưởng của chủ chảy sang bên trả phí. Chặn bằng 422 thì người dùng mới (0 ADA, đúng người
cần ví trả phí) kẹt tới khi tự rút thưởng — mà tự rút thì cần ADA.

**Cái gì gãy nếu bám bản cũ.** `FEE_PAYER_OWNER_REWARD_NONZERO` nay chỉ còn ca không suy được ví
Phoenix (`details.missing`); bên gọi đang coi mã đó là "mọi thưởng > 0" sẽ thấy 200 khi bản deploy có
`did_payment_unapplied_script`. Tx dựng ra có thêm một output thuần ADA tới ví Phoenix. Đường
Feecover cho route khác `create_vault`: luật L9 của Feecover hiện còn từ chối output đó.

## 2026-10-06 — Báo giá `/tx/quote` trả `fronted_lovelace` ở cả hai nguồn trả phí

**Đổi gì.** `VaultTxAPI/src/feeQuote.ts`: khối `feecover` và `owner_address` thêm
`fronted_lovelace` (chuỗi thập phân) = min-ADA ví trả phí phải ỨNG cho output két/thread mới và
shard dùng chung. Số được đọc lại từ CBOR của lượt dựng báo giá bằng đúng hàm đường dựng thật
(`feePayer.ts` ▸ `checkFeePayerTx`), không có công thức thứ hai. Luôn có, kể cả `available=false`;
`"0"` là số đo thật (route không ứng output nào), không phải số đệm. README `VaultTxAPI` ghi hình
dạng mới.

**Vì sao.** Khoản ứng là chi phí chìm (két không có nhánh nào trả lovelace ra); SuperApp cần biết
ví trả phí phải có bao nhiêu ngoài phí. Trước đây số này chỉ nằm trong `needed_lovelace` (gộp với
phí), còn `owner_address` không trả riêng — đo 2026-10-06 trên `origin/main` @ `c7dd1f9e`.

**Cái gì gãy nếu bám bản cũ.** Không gãy: chỉ thêm trường. Bên đọc phản hồi bằng so khớp nguyên
đối tượng (`toEqual`) phải thêm `fronted_lovelace`.

## 2026-10-05 — `create-vault` đọc script vault qua ref CIP-33, không đính inline

**Đổi gì.** `MagicSDK/src/createVault.ts` nhận tham số BẮT BUỘC `vaultRefScriptUtxo` (cùng khuôn
`withdrawLamp`/`updateProfile`, `refScript.ts` ▸ `resolveRefScript`): có UTxO ⟹ kiểm hash rồi
`readFrom`; đường inline chỉ khi bên gọi truyền `ACCEPT_INLINE_SCRIPT_CEILING`.
`VaultTxAPI/src/txBuilder.ts` ▸ `createVault` truyền UTxO `ref_script_utxos.vault` vốn đã đọc để
lấy script.

**Vì sao.** Script vault InstantGen dài 14.520 byte. Create-vault cho chủ DID nạp từ did_payment
phải mang thêm script did_payment (3.134 byte) và mục rút `did_stake` của chủ: VTA Preprod @
`85247003` dựng ra tx **21.385 byte**, vượt trần 16.384 ⟹ `422 TX_BUILD_REJECTED`. Mọi create-vault
chủ DID qua did_payment đều chết ở đây.

**Cái gì gãy nếu bám bản cũ.** Bên gọi `createVault` của SDK không truyền `vaultRefScriptUtxo` sẽ
không biên dịch được; muốn giữ inline thì truyền `ACCEPT_INLINE_SCRIPT_CEILING`. Tx VTA dựng ra có
thêm một reference input (UTxO script vault) và không còn script vault trong nhân chứng.

## 2026-10-05 — `create-vault` nạp từ did_payment: ví trả phí ứng min-ADA của két

**Đổi gì.** Ở chế độ ví trả phí bên thứ ba (`funding.fee_payer`, không đặt `feeSource =
"did_payment"`), `MagicSDK/src/createVault.ts` chỉ lấy LAMP từ did_payment; min-ADA của output két
mới do ví trả phí ứng, và trọn lovelace của các UTxO did_payment đã chi về lại did_payment. Két
Instant 0 LAMP mà chủ không có mục rút thì giao dịch không chi UTxO did_payment nào (quyền chủ vẫn
ép như cũ). `VaultTxAPI/src/funding.ts` ▸ `checkFundingTx` đổi phương trình bảo toàn theo đúng hình
dạng đó: ví trả phí góp đúng phí + thối + khoản ứng (= trọn lovelace output két, trần
`fee_payer_fronting_max_lovelace`, vượt ⟹ `422 FEE_PAYER_FRONTING_ABOVE_MAX`); did_payment không mất
lovelace. Bản tóm tắt `funding.fee_payer` thêm `fronted_lovelace`, `fronted_max_lovelace`; báo giá
create-vault tính khoản ứng vào số ví trả phí phải có. Chế độ ví Phoenix tự trả phí không đổi.

**Vì sao.** DID mới thường chỉ có LAMP + khoảng 1,2 ADA ở did_payment, dưới min-ADA của két
(khoảng 2,1 ADA). Bắt did_payment trả nó thì đúng người dùng cần ví trả phí bị `FUNDING_INSUFFICIENT`
(đo trên Preprod 2026-10-05 với một DID thật: UTxO 1.000 LAMP + 1.240.954 lovelace).

**Cái gì gãy nếu đang bám bản cũ.** Giao dịch create-vault hình dạng cũ (did_payment trả min-ADA két)
nay bị `checkFundingTx` từ chối `FUNDING_TX_MISMATCH`, nên bên nào tự dựng giao dịch theo hình dạng
cũ rồi gửi qua VTA phải dựng lại theo SDK mới. Ví trả phí cần thêm tới
`fee_payer_fronting_max_lovelace` lovelace cho mỗi két. Mã Aiken và hash validator không đổi.

## 2026-10-05 — PrepaidGen: quỹ tài trợ có đường thu hồi DỰ PHÒNG (bên tài trợ ký + qua mốc)

**Đổi gì.** `Sponsorship` nối cuối `reclaim_after_epoch : Int` (Aiken `types.ak`, TS `types.ts`).
Hằng `sponsor_reclaim_delay_epochs = 200` (`constants.ak` ↔ `SPONSOR_RECLAIM_DELAY_EPOCHS`,
`constants.ts`). Genesis quỹ tài trợ (`validate_mint_fund_nft`) đòi cận TRÊN validity hữu hạn và mốc
`>= epoch(cận trên) + 200`. `reclaim_preconditions` bước 3: cospend `ReclaimEpoch` của két Wakeme
HOẶC (bên tài trợ ký VÀ (epoch giao dịch ≥ mốc HOẶC `credit_issued == 0`)); phần còn lại (vault
`CloseSponsoredLine` khi đã cấp, đích trả) không đổi. TS: `planMintPaidFund` nhận `sponsorship` +
`validity`, `planFundReclaim` có `path: "sponsor"`. Hash chưa apply: `paid_fund` `dce08696…`,
`prepaid_vault` `6476592e…` (`scripts/BUILD-RECORD.md`).

**Vì sao.** Cửa thu hồi duy nhất trước đây là `ReclaimEpoch` của két Wakeme cùng giao dịch — ai
cũng chạy được, chỉ chạy một lần; chạy riêng là CARP tài trợ + NFT quỹ kẹt vĩnh viễn. Wakeme deploy
lại, DID không có két, quỹ chưa nạp cũng chỉ thu hồi được qua cửa đó.

**Cái gì gãy nếu đang bám bản cũ.** Datum `Sponsorship` thêm một trường ⟹ quỹ tài trợ dựng theo
lược đồ cũ không decode được (chưa quỹ nào lên chuỗi). Hash cả hai validator PrepaidGen đổi ⟹ công
bố lại cặp ref-script và bản `consume` của loại vault Prepaid. `FundReclaimResult.wakeme` nay có thể
`null` (đường dự phòng).

## 2026-10-04 — Đóng lối mở tập dượt: `8169b76c…` kèm xác nhận đúng cũng bị chặn

**Đổi gì.** `REHEARSAL_LAMP_POLICIES` rỗng ở cả hai bản chép tay (`MagicSDK/src/lampPolicy.ts`,
`scripts/config.ts`). Hàm cổng không đổi: bảng rỗng thì `isRehearsalAcknowledged` /
`checkLampPolicyId` không cho qua khoá nào. `8169b76c…` vẫn nằm trong
`SUPERSEDED_LAMP_POLICIES`. Ba bộ kiểm đảo dấu (`MagicSDK/tests/lampPolicy.test.ts`,
`VaultTxAPI/tests/config.test.ts`, `scripts/test_lamp_policy_gate.ts`): ca `8169b76c…` kèm ack
đúng trên Preprod/Preview nay phải NÉM, mỗi ca âm có cực đối là policy cuối `493002cc…cfac`
(có hoặc không ack) đi qua. Chú thích điều kiện gỡ, `VaultTxAPI/README.md`, `DevStatus.md`,
`scripts/DEPLOYED.md`, chú thích `ProtocolParams.lampRehearsalAck` sửa theo.

**Vì sao.** Điều kiện gỡ ghi sẵn trong chú thích đã thoả: cụm tập dượt dừng, cụm phục vụ chạy
trên policy cuối từ 2026-10-04. Để khoá lại là để một lệnh có `LAMP_REHEARSAL_ACK` đúng vẫn dựng
được vault trên một đời LAMP đã chết.

**Cái gì gãy nếu đang bám bản cũ.** Lượt sinh cấu hình hay lượt chạy `scripts/` với
`LAMP_POLICY_ID=8169b76c…` và `LAMP_REHEARSAL_ACK` đúng ⟹ ném câu lỗi đời-đã-bị-thay; tệp
`VAULT_TX_API_DEPLOYMENT` mang `lamp.policy_id` = `8169b76c…` ⟹ `VaultTxAPI` từ chối khởi động.
Mã Aiken và hash validator không đổi. Mở lại lối này cần một quyết định mới của chủ dự án và một
khoá mới trong cả hai bảng (`scripts/test_lamp_policy_gate.ts` bắt hai bảng lệch tập khoá).

## 2026-10-05 — Nộp lại tx đã nộp: trả kết quả cũ, không gửi lại; gửi không xác nhận ghi `unconfirmed`

**Đổi gì.** `VaultTxAPI/src/locks.ts` ▸ `IssuedTxRegistry.markSubmitted` ghi trạng thái gửi của tx
(`accepted` khi nút nhận, `unconfirmed` khi đã gửi mà không có xác nhận) và chỉ thay tx chung khoá ở
lượt gửi ĐẦU TIÊN. `VaultTxAPI/src/service.ts` ▸ `submit`: nộp lại tx nút đã nhận ⟹ trả lại kết quả
lượt đầu, không gửi lên chuỗi lần nữa; `chain.submitTx` mất kết nối / quá giờ, hoặc nút báo hash khác
⟹ ghi `unconfirmed` (input vào sổ chờ, tx chung khoá dựng trước bị thay). `TxSupersededError` thêm
`details.submission` (`accepted` · `unconfirmed` · `none`) và `details.previously_submitted`.

**Vì sao.** Nộp lại một tx đã nộp từng thay luôn tx chủ dựng sau lượt nộp đầu (lượt kế tiếp hợp lệ của
chủ), và lượt gửi mất kết nối bị coi như chưa từng gửi. Tx đã nộp VẪN bị thay khi một tx chung khoá
nộp sau nó: không thay thì ví A nộp tạo két T1 (rơi khỏi mempool), ví B nộp T2 (lên chuỗi), nộp lại
T1 ⟹ két thứ hai cho cùng chủ — validator chưa ép mỗi DID một két.

**Cái gì gãy nếu bám bản cũ.** Bên gọi trông vào việc nộp lại một tx đã được nhận để HỒI SINH nó sau
khi rơi khỏi mempool: nay lượt nộp lại trả 200 mà không gửi gì — tra chuỗi theo `tx_hash`, không thấy
thì dựng lại. Bên gọi suy "409 `TX_SUPERSEDED` ⟹ tx chưa lên chuỗi" thì suy sai ở mọi bản — đọc
`details.submission`, rồi tra chuỗi.

## 2026-10-04 — VaultTxAPI: một tiến trình phục vụ nhiều loại két (khối chính + khối phụ)

**Đổi gì.**
- Biến mới `VAULT_TX_API_EXTRA_DEPLOYMENT_FILES` + `VAULT_TX_API_EXTRA_VAULT_PLUTUS_JSONS`: danh sách
  đường dẫn khối triển khai phụ và blueprint tương ứng, ghép theo vị trí. Vắng ⟹ một khối, y như trước.
  Nạp NÉM khi: khác LAMP, khác mạng, trùng `vault_type`, có khối Prepaid, khác `did_stake`, khối phụ
  khai `feecover` (`config.ts` ▸ `loadExtraBlocks`, `assertCompatibleBlocks`).
- Mỗi khối một `VaultTxService` + bộ dựng riêng; dùng CHUNG chuỗi, khoá mềm theo chủ, sổ phát-hành và sổ
  chi-đang-chờ (`blocks.ts` ▸ `makeBlockServices`).
- `blockRouter.ts` ▸ `VaultBlockRouter`: `create-vault` theo `kind`; `instant-gen`/`refresh-checkpoint`
  → Instant; `schedule-commit`/`schedule-fire` → Schedule; `consume`/`open-thread`/`bind-did` (và
  `/tx/quote` cho các đường đó) nhận `vault_type` tuỳ chọn, vắng thì tra két của chủ ở từng khối.
  Mã mới: 409 `VAULT_TYPE_AMBIGUOUS`, 400 `VAULT_TYPE_INVALID`, `VAULT_TYPE_NOT_SERVED`,
  `VAULT_TYPE_ROUTE_CONFLICT`.
- `/health`: `vault_scopes` là hợp mọi khối (khối chính trước); `deployment_source` giữ nhãn khối chính;
  thêm `deployment_sources`.

**Vì sao.** App đọc MỘT URL VaultTxAPI và chỉ mở lối ScheduleGen khi `/health` của URL đó khai scope
`Schedule`. Một khối chỉ phục vụ được một loại két (`ref_script_utxos.vault` một ô, `consume`
apply-param theo loại két), nên chạy dịch vụ thứ hai thì app không thấy.

**Cái gì gãy nếu bám bản cũ.** Không gì gãy khi chỉ một khối. Có nhiều khối: người gọi `consume`/
`open-thread`/`bind-did` không gửi `vault_type` mà chủ có két ở hai loại sẽ nhận 409
`VAULT_TYPE_AMBIGUOUS` thay vì được dựng trên khối đầu tiên. Thread mở khi chủ chưa có két đi khối
chính.

## 2026-10-04 — PrepaidGen: `FundReclaim` gỡ dòng hạn-mức ở vault, quỹ tài trợ đóng được; CARP Preprod đời 6

**Đổi gì.**
- `PrepaidVaultRedeemer` thêm `CloseSponsoredLine { fund_id }` (**constr 7**, nối cuối; thẻ CBOR
  1280 `d90500`). Quỹ tài trợ đã cấp (`credit_issued > 0`) chỉ `FundReclaim` được khi cùng giao dịch
  tiêu vault mang dòng của nó bằng redeemer này: dòng + mọi batch của quỹ bị gỡ, và
  `consumed_unsettled` (u) của dòng vào `magic_settled` trước khi tính R. Hàm P8 mới:
  `math.ak` ▸ `reclaim_outstanding` ↔ `math.ts` ▸ `reclaimOutstanding`, vector V5.
- `PrepaidLock` vào quỹ tài trợ đòi vault đã gắn đúng DID được tài trợ, và quỹ chỉ mở dòng khi
  `credit_issued == 0` (một dòng trọn đời). Quỹ chưa cấp đồng nào thu hồi không kèm vault (R = 0, đóng).
- `FundClaim` rút trọn `carp_locked` của quỹ đã thu hồi ⟹ đóng quỹ: đốt NFT, min-ADA về bên tài trợ
  (output datum `fund_id`). Handler `mint` của `paid_fund` nhận đốt từ `FundReclaim` hoặc `FundClaim`.
- Ngoài chuỗi: `prepaid.ts` (`reclaimUnsettled`, `vaultAfterCloseLine`, `fundAfterReclaim(…, u)`,
  `assertSponsoredLock`, `fundClaimClose`), `builders.ts` (`planFundReclaim` nhận `vaultUtxo`,
  `planFundClaim` có nhánh đóng). Bài emulator đọc hai script qua ref-script CIP-33.
- CARP Preprod trỏ sang đời 6 `71968a8d…/59d0bc48…` (nguồn: instance công khai của CarpetMint);
  đời 5 `86ea6717…/110d0c97…` vào danh sách đã thay. `PrepaidGen/offchain/src/carpInstance.ts` đọc
  instance; bước deploy 10 đối chiếu cặp CARP với instance lúc chạy, lệch ⟹ dừng.

**Vì sao.** Bản `FundReclaim` trước không đụng vault: phần MAGIC đã tiêu mà chưa `SettleLine` bị trả
cho bên tài trợ, và người dùng quay lại được phục vụ không công. Quỹ `E = 0` hoặc rút cạn sau thu hồi
giữ min-ADA vĩnh viễn. Đời CARP 5 đã bị thay trên Preprod nên apply-param ghim nó là dựng quỹ không
thấy CARP thật.

**Cái gì gãy nếu đang bám bản cũ.** Bytes `paid_fund` + `prepaid_vault` đổi ⟹ hash + địa chỉ đổi.
Hai validator đính kèm cùng một giao dịch nay vượt trần 16.384 byte ⟹ mọi giao dịch tiêu cả vault
lẫn quỹ phải dùng ref-script. `fundAfterReclaim`/`reclaimAmount` nhận thêm `u`; `planFundClaim` trả
`fundDatumOut: null` ở nhánh đóng; `fundAfterClaim` ném khi lượt rút phải đi nhánh đóng. Bên dựng T2
phải mở quỹ tài trợ cho vault đã `SetDidCommit` đúng DID.

## 2026-10-04 — PrepaidGen: quỹ tài trợ thu hồi phần CARP chưa giao về ví bên tài trợ (`FundReclaim`)

**Đổi gì.**
- `PaidFundDatum` từ 11 lên **13 trường**, nối cuối: `sponsorship: Option<Sponsorship { sponsor:
  Address, owner_commit: ByteArray }>` (ghim ở genesis, bất biến) và `sponsor_reclaimed: Int` (0 ở
  genesis, ghi một lần). `PaidFundRedeemer` thêm `FundReclaim` (constr 3, không trường).
- `paid_fund` thêm apply-param thứ năm `wakeme_vault_hash` (cuối). Giá trị theo mạng lấy từ
  `ProtocolUtils` ▸ `wakemeVaultHash(network)`; `PrepaidScriptParams.wakemeVaultHash` và
  `scripts/deployParams.ts` ▸ `PaidFundParamInputs.wakemeVaultHash` là bắt buộc.
- Nhánh `FundReclaim` (`prepaid.ak` ▸ `validate_fund_reclaim`, `validate_fund_close`): quỹ tài trợ,
  chưa thu hồi, đồng-tiêu đúng một két Wakeme mang vault-NFT `owner_commit` bằng `ReclaimEpoch` ⟹
  trả `R = outstanding_effective(...)` CARP về địa chỉ đầy đủ của bên tài trợ. Phần provider đã kiếm
  ở lại quỹ. Khi phần đó bằng 0, quỹ đóng: đốt NFT quỹ (handler `mint` nhận lượng −1), ADA của quỹ
  về bên tài trợ.
- Output trả bên tài trợ phải mang **inline datum = `fund_id`** của chính quỹ đó.
- `FundLock` vào quỹ tài trợ đòi chữ ký bên tài trợ và bị chặn sau thu hồi. `FundSettle`/`FundClaim`
  dùng hạn-mức hiệu lực `credit_issued − sponsor_reclaimed`. C-PP-3 thành
  `carp_locked == credit_issued − provider_claimed − sponsor_reclaimed`. Hàm mới cho P8:
  `math.ak` ▸ `outstanding_effective` ↔ `math.ts` ▸ `outstandingEffective`, vector V4.
- Ngoài chuỗi: `codec.ts` ▸ `fundReclaimRedeemer`; `builders.ts` ▸ `planFundReclaim` /
  `addFundReclaim` (phần quỹ; phần két Wakeme bên gọi ghép vào); `planPrepaidLock` thêm chữ ký bên
  tài trợ khi quỹ có `sponsorship`. `scripts/deploy/10_deploy_prepaid.ts` nạp lược đồ quỹ từ
  `PrepaidGen/offchain` thay vì giữ bản chép riêng.

**Vì sao.** Bên tài trợ (vai Feecover) nạp CARP cho lượt tiêu đầu của một người dùng mới. Người đó
bỏ đi thì trước đây phần CARP chưa dùng không có đường ra nào ngoài `FundClaim` của provider. Thu
hồi được gắn vào đúng sự kiện két Wakeme của DID đó bị `ReclaimEpoch`, nên quỹ không tự tính thời
gian và không cần oracle. Datum `fund_id` ở output trả chặn thoả-mãn-kép: hai quỹ ở hai bản deploy
`paid_fund` cùng bên tài trợ, cùng DID, cùng lượng `R` từng cùng ăn được một output trả. Thiết kế
đầy đủ: tài liệu thiết kế nội bộ §10 (`DESIGN-reclaim`).

**Cái gì gãy nếu đang bám bản cũ.** UTxO quỹ 11 trường không đọc được bằng lược đồ 13 trường và
ngược lại (Aiken nghiêm số trường cả hai chiều). Bytes của cả `paid_fund` lẫn `prepaid_vault` đổi
⟹ hash, địa chỉ và ref-script của cặp Prepaid phải deploy lại, kèm bản `consume` apply bằng hash
két Prepaid mới. Mọi chỗ gọi `derivePrepaidScripts` / `prepaidScriptPair` thiếu `wakemeVaultHash`
nay gãy lúc typecheck. Đổi bản deploy Wakeme cũng đổi hash quỹ. Bên dựng giao dịch trả bên tài trợ
mà không gắn datum `fund_id` bị validator từ chối.

## 2026-10-04 — Cụm Preprod đời 2 theo két Wakeme v5; ví trả phí ứng min-ADA cho shard `gb_shard`

**Đổi gì.**
- `ProtocolUtils/src/index.ts` ▸ `WAKEME_VAULT_HASH_BY_NETWORK.Preprod` = `118d5352…` (két Wakeme v5),
  thay `4da780c4…` (v4). Cụm Preprod dựng lại trọn, giá trị ở `scripts/DEPLOYED.md`.
- `VaultTxAPI/src/feePayer.ts` ▸ `checkFeePayerTx` nhận thêm `sharedFrontings`: ví trả phí được ứng
  phần min-ADA TĂNG của output shard `gb_shard` được tiêu rồi dựng lại, mỗi output ≤
  `fee_payer_fronting_max_lovelace`. Summary thêm `shared_fronted_lovelace` + `shared_fronted_outputs`;
  `fronted_lovelace` nay là TỔNG (két/thread + shard).

**Vì sao.** Két Instant đọc két Wakeme theo apply-param #8, nên người dùng nhận LAMP ở két v5 chỉ sinh
được trên két Instant nướng hash v5; sổ `vault_registry` một-lần kéo theo cả cụm. Lượt sinh đầu trên một
shard làm datum shard dài ra, đòi thêm 73.270 lovelace; bản cũ của cổng chỉ cho ứng ở output két/thread
của chủ, nên mọi lượt sinh qua ví trả phí trên shard mới trả 422 `FEE_PAYER_TX_MISMATCH`.

**Cái gì gãy nếu bám bản cũ.** Mọi hash cụm Preprod đời 1 (két `ec25a91c…`, `consume` `bb26d9d5…`) không
còn được phục vụ. Bên đối chiếu `fronted_lovelace` với phần tăng của riêng két sẽ thấy lệch đúng bằng
`shared_fronted_lovelace`.

## 2026-10-04 — Người dùng 0 ADA đi trọn đường bằng ví trả phí: ứng min-ADA có trần, mở thread, gắn DID, tạo két instant 0 LAMP

**Đổi gì.**
- `VaultTxAPI/src/feePayer.ts` ▸ `checkFeePayerTx`: ví trả phí được ỨNG min-ADA cho đúng một
  output mang NFT két/thread của chủ, tới trần cấu hình mới `fee_payer_fronting_max_lovelace`
  (vắng ⟹ 5 ADA, `"0"` tắt). Tập địa chỉ được phép làm input khác ngoài UTxO trả phí là danh sách
  đóng theo từng đường. Mã mới: `422 FEE_PAYER_FRONTING_ABOVE_MAX`, `422
  FEE_PAYER_OWNER_REWARD_NONZERO` (chủ `did_stake` có thưởng > 0 thì không dựng qua ví trả phí).
- `/tx/open-thread` và `/tx/bind-did` nhận `fee_payer`; `/tx/create-vault` nhận `fee_payer` ở gốc
  thân bài cho két `instant` `"lamp_amount": "0"` không kèm `funding`. `BindDidParams`
  (ConsumeMAGIC) và `CreateVaultParams` (MagicSDK) thêm `validToMs` tuỳ chọn để đặt hạn dùng mà
  luật ví trả phí đòi.
- `/tx/quote`: `needed_lovelace = max(phí + khoản ứng, thế chấp) + min-ADA`.
- Bảng mục đích Feecover (`feecover.apps.*.purposes`) nhận thêm bốn route tài trợ
  `sponsor-t1-open` … `sponsor-t4-first-consume` (`locks.ts` ▸ `FEE_PURPOSE_ROUTES`). `/tx/quote`
  vẫn chỉ báo giá tám đường dựng.
- `scripts/gen_vault_tx_api_deployment.ts`: cờ `--did-stake-blueprint <tệp>` phát
  `did_stake.unapplied_script`, sau khi so hash băm lại với khoá sổ `DID_STAKE_UNAPPLIED_HASH`.

**Vì sao.** Người dùng mới của SuperApp ký bằng DID PhoenixKey và không có ADA. Luật cũ cho ví trả
phí mất đúng bằng phí, nên mọi output phải giữ min-ADA (thread, két mới) đều cần ví của chủ, và
ba đường đầu tiên của người dùng mới bị chặn. Ứng có trần giữ được giới hạn thiệt hại của bên trả
phí mà không khoá sẵn một sàn lovelace lớn vào mỗi két. Số đo min-ADA dùng để chọn trần ở
README VaultTxAPI ▸ mục khoản ứng min-ADA.

**Cái gì gãy nếu đang bám bản cũ.** Hai mã đã bỏ: `422 FEE_PAYER_DEPOSIT_UNSOURCED` (open-thread
chỉ có `fee_payer` nay dựng được) và `501 BIND_DID_FEE_PAYER_UNSUPPORTED` (bind-did nay nhận
`fee_payer`). `400 FEE_PAYER_UNSUPPORTED` hẹp lại, không còn trả cho két instant 0 LAMP. App rẽ
nhánh theo ba mã đó cần đổi. Bên trả phí đọc `summary.fee_payer.fronted_lovelace` để biết khoản đã
ứng; bên nào ký mà chỉ chấp nhận "mất đúng bằng phí" sẽ từ chối tx có khoản ứng.

## 2026-10-03 — ρ hiệu lực ngay kỳ dựng beacon; chủ két khai bằng DID; lượt dựng không còn khoá két

**Đổi gì.**
- `GenBeacons/onchain/validators/rate_param.ak` ▸ `mint`: beacon ρ đầu tiên hiệu lực NGAY epoch
  đăng (`effective_epoch == now`, vẫn `prev_rho_q == 0`). Nhánh cập nhật giữ nguyên (giá trị mới
  từ epoch sau). `GenBeacons/offchain/src/build.ts` ▸ `genesisRateParam` dựng theo luật mới. Hash
  `rate_param` đổi ⟹ đổi apply-param của mọi vault đọc ρ.
- VaultTxAPI nhận `owner: {"type":"did","did":"did:…","device_key_hash"?}`. Dịch vụ tự suy
  `Script(did_stake)`, tìm anchor theo `anchor_nft_policy ++ blake2b_256(utf8(did))`, đọc datum
  anchor 18 trường rồi đi đúng đường nhân chứng `did_stake` sẵn có (`VaultTxAPI/src/didOwner.ts` ▸
  `DidOwnerResolver`). Cấu hình mới `did_stake.unapplied_script {cbor, hash}`, kiểm lúc khởi động.
  SDK xuất `didAnchorNftName`, `didStakeScriptForDid`. Mã mới: `OWNER_DID_SHAPE`,
  `OWNER_DID_CONFLICT`, `OWNER_DEVICE_NOT_LISTED` (400) · `OWNER_ANCHOR_NOT_FOUND`,
  `OWNER_ANCHOR_AMBIGUOUS`, `OWNER_ANCHOR_SCHEMA`, `OWNER_ANCHOR_NOT_ACTIVE` (422).
- Khoá mềm (`VaultTxAPI/src/locks.ts`): lượt dựng không còn trả `409 OWNER_TX_IN_FLIGHT`. Một tx bị
  thay khi một tx KHÁC cùng khoá chủ được NỘP; nộp tx đã bị thay, hoặc tx có input mà một tx đang
  chờ đã tiêu ⟹ `409 TX_SUPERSEDED`. Giữ chỗ UTxO phí của tx bị thay được nhả.
- `ProtocolUtils` ▸ `WAKEME_VAULT_HASH_BY_NETWORK.Preprod` = `4da780c4…cab` (két Wakeme v4, lưới O).

**Vì sao.** Beacon cũ ép ρ đầu tiên hiệu lực từ kỳ sau, nên suốt kỳ dựng mọi két Sinh được 0
MAGIC dù có LAMP và GreenBack thặng dư. Chủ két phải là khoá DID của người dùng để mọi app dùng
chung một đường ký (PhoenixKey ký controller + thiết bị), thay vì mỗi app tự dựng khoá. Khoá mềm
cũ cho bất kỳ ai biết hash chủ (công khai trên chuỗi) khoá két người khác 180 giây mỗi lượt.

**Cái gì gãy nếu đang bám bản cũ.** Kịch bản dựng beacon theo `effective_epoch = now + 1` ⟹ bị
từ chối. App rẽ nhánh theo `409 OWNER_TX_IN_FLIGHT` ở bước dựng sẽ không còn gặp mã đó; xung đột
nay ra ở `/tx/submit` với `TX_SUPERSEDED`. Chủ DID cần `did_stake` đã đăng ký làm stake credential
trước khi tạo két, vì genesis cũng gọi `owner_authorized`; chưa đăng ký ⟹ `OWNER_STAKE_NOT_REGISTERED`.

## 2026-10-03 — `/tx/consume` nhận `pairs` (ConsumeMany); mọi lượt tiêu được đọc lại từ CBOR

**Đổi gì.** `POST /tx/consume` nhận thêm `pairs: [{ op_type, op_count }, …]` (1..8 cặp, `op_type`
tăng ngặt, `op_count` ≥ 1), loại trừ với cặp đơn; dịch vụ dựng redeemer `ConsumeMany` (constr 3)
qua `buildConsumeManyTx`, `required` = `requiredFromBeaconPairs` (sàn TỪNG cặp rồi cộng). `pairs`
một phần tử quy về `Consume` đơn — số đo ở README VaultTxAPI §`pairs`. Phép đọc lại mới
`VaultTxAPI/src/consumeLine.ts` ▸ `checkConsumeTx` chạy cho MỌI lượt tiêu, ghi `summary.consume`.
Mã mới: `CONSUME_PAIRS_CONFLICT` · `_SHAPE` · `_EMPTY` · `_TOO_MANY` · `_NOT_INCREASING` ·
`CONSUME_PAIR_COUNT_INVALID` · `CONSUME_PAIR_TYPE_INVALID` (400) · `CONSUME_TX_MISMATCH` (422).
SDK xuất thêm `buildConsumeManyTx`, `requiredFromBeaconPairs`, `decodeConsumeLineRedeemer`,
`assertValidPairs`, `requiredForPairs`, `sumPairCounts`, `MAX_CONSUME_PAIRS`.

**Vì sao.** OriLife cần một tác vụ trả cho tối đa bốn loại nghiệp vụ trong một giao dịch. Phép đọc
lại áp cho cả cặp đơn vì `summary` phải suy TỪ `tx_cbor` (README §2): đường không được đọc lại là
đường mà bộ dựng nói gì cũng qua.

**Cái gì gãy nếu đang bám bản cũ.** Bộ dựng thay thế (`TxBuilderPort`) mà trả CBOR tiêu không có
thread Engage làm input, hoặc không mang redeemer Consume trên thread ⟹ nay `422
CONSUME_TX_MISMATCH` thay vì `200`. Bản ghi CBOR trong năm tệp kiểm cũ đã được dựng lại đủ vế
thread (`VaultTxAPI/tests/fixtures/consume.ts`), không kỳ vọng nào bị nới. Không đổi tệp `.ak` nào.

## 2026-10-03 — Tài trợ consume đầu; năm bản vá on-chain

**Đổi gì.** Năm bản vá validator, cộng phần off-chain dựng luồng tài trợ consume đầu:

- (a) `PrepaidGen/onchain/validators/prepaid.ak` ▸ `validate_draw` không còn đặt
  `consumed_unsettled` về 0 trên dòng được rút; chỉ `remaining` và `last_draw_epoch` đổi.
- (b) `InstantGen/onchain/lib/magiclamp/protocol/checkpoint.ak` ▸ `resolve_link`, luật 6: nhánh
  `FollowVault` chỉ đổi được `wakeme_link` khi `owner_commit` trùng link cũ, hoặc khi két đọc được
  đang ghim chính két này (`L_lent > 0`); đổi sang két Wakeme khác thì bị từ chối. Link cũ RỖNG
  không còn là ngoại lệ: lượt nối đầu chỉ qua genesis (link khai sẵn) hoặc RefreshCheckpoint.
- (c) `ScheduleGen/onchain/validators/vault.ak` ▸ `C-SCH-LOCKSUM` (issue #132): ở commit, fire và
  rút LAMP, `sum_locked(output.loyalty_holdings) == output.lamp_locked`; kèm `lock.ak ▸
  select_lamp_for_lock` chỉ chọn trong holding đang mở. Bộ dựng TS kiểm trước đẳng thức này bằng
  `ScheduleGen/offchain/src/math.ts ▸ assertLockSumMatches` (mã lỗi `GEN-LOCK-SUM`).
- (d) `GenBeacons/onchain/lib/genbeacons/util.ak` ▸ `continuing_pair`, `genesis_single` và
  `validators/gb_shard.ak` ▸ `genesis_shard_ok` đòi `reference_script == None` ở đầu ra tiếp nối
  và đầu ra genesis.
- (e) `Paymaster/onchain/lib/magiclamp/paymaster/util.ak` ▸ `get_epoch` đòi `lo_epoch == hi_epoch`.
- (f) `reference_script == None` ở output két InstantGen/ScheduleGen (`validate_vault_value`,
  genesis, RefreshCheckpoint), shard ScheduleGen (`find_shard_output_by_policy`) và `UMUpdate`
  (`UMKeeper/onchain/validators/um_datum.ak`).
- (g) `ConsumeMAGIC/onchain/validators/consume.ak`: `reference_script == None` ở mọi output thread
  Engage — `enforce_engagement` (Consume, ConsumeMany), `validate_bind_did`,
  `validate_mint_engage_id`; cùng cổng ở beacon giá `price_param.ak` (spend) và `price_nft.ak`
  (genesis).

Phần off-chain: luồng tài trợ T1–T4 (`MagicSDK/src/sponsorJourney.ts`; route
`POST /tx/sponsor/*` ở `VaultTxAPI/src/sponsor.ts`), `vault_kind: "Prepaid"` ở `VaultReadAPI`
(`prepaidView.ts`, `VAULT_KINDS`), và `scripts/gen_vault_read_api_config.ts` sinh cấu hình
`VaultReadAPI` từ sổ trạng thái. Bộ dựng khớp (b): `ConsumeMAGIC/offchain/src/genV2Checkpoint.ts`
▸ `checkGenV2Burn` ném `CONSUME-013` khi két link rỗng mà có két Wakeme; `VaultTxAPI` ném
`422 WAKEME_LINK_CHANGE_REJECTED` (`wakeme.ts` ▸ `assertWakemeLinkAllowed`) với câu chỉ đường
RefreshCheckpoint, trước khi gọi bộ dựng.

**Vì sao.**
- (a) Rút một CARP đang xoá nợ quyết toán của quỹ, CARP đối ứng phần đã tiêu kẹt lại trong quỹ.
- (b) Người dựng giao dịch thay két Wakeme thật X bằng két Wakeme thật Y mà chủ ký cho việc khác,
  nên link và cap bị đổi mà luật 2 bị lách.
- (c) Commit lần hai trên két có holding trẻ nhất đang khoá làm `lamp_locked` tăng nhiều hơn tổng
  khoá thật, lượt nhả cuối chết và phần lệch kẹt vĩnh viễn.
- (d) Output tiếp nối của beacon/shard là thứ mọi giao dịch sau đều chạm; gắn script tham chiếu
  vào đó là đánh phí lên giao dịch của người khác.
- (e) Cửa sổ validity bắc ngang biên epoch trả epoch kế tiếp, nên bộ đếm trần của Paymaster reset
  sớm một kỳ.
- (b, vế link rỗng) Người dựng tx nối một két chưa link sang két Wakeme lạ; sau đó két Wakeme thật
  của chủ không ghim được két này nữa, chủ mất phần mượn tới khi tự RefreshCheckpoint.
- (f, g) Nhánh không chữ ký (PruneExpired, ScheduleFire, UMUpdate) hoặc bên thứ ba có quyền tiêu
  (`personal_delegate` của thread) gắn được script lớn vào output, làm mọi giao dịch sau đắt thêm
  theo byte.

**Cái gì gãy nếu ai đó đang bám bản cũ.** Hash validator đổi, ghi ở `scripts/BUILD-RECORD.md`
— đếm lại bằng `git -C <kho> diff origin/main -- scripts/BUILD-RECORD.md` (2026-10-03, nhánh
`feat/prepaid-sponsor-first-consume`: bốn validator GenBeacons, `vault.vault` InstantGen,
`paymaster.paymaster`, `prepaid.prepaid_vault`, `vault.commit` + `vault.vault` + `vault.shard`
ScheduleGen, `um_datum.um_datum_validator`, `consume.consume`, `price_nft.price_nft`,
`price_param.price_param`) ⟹ cụm đang chạy phải đúc lại. Datum ra lệch `C-SCH-LOCKSUM` bị bộ dựng
ném trước khi ký. Két IG cũ link rỗng muốn nối két Wakeme thì chạy RefreshCheckpoint trước; lượt
sinh/tiêu kèm két Wakeme lạ nay bị từ chối. Mới chỉ nằm trên nhánh, **chưa deploy**.

## 2026-10-03 — Cổng policy LAMP: chặn `53bc12ad…` và `7ecbffe2…`, policy tLAMP Preprod CUỐI là `493002cc…`

**Đổi gì.** `53bc12ade5ee24d43750b9560f152a54b48b804fab34dab810fb8743` và
`7ecbffe2b41f68c917035f52a1053efbd2323dfd85a81cf840089ea2` vào `SUPERSEDED_LAMP_POLICIES` ở cả
hai bảng (`scripts/config.ts`, `MagicSDK/src/lampPolicy.ts`), lý do nêu policy thay thế
`493002cc03004e3e14fd607cfba59312bd946e478e69d6ab431ccfac` (asset `744c414d50`). Ba bộ kiểm cổng
(`scripts/test_lamp_policy_gate.ts`, `MagicSDK/tests/lampPolicy.test.ts`,
`VaultTxAPI/tests/config.test.ts`) lấy `493002cc…` làm cực dương. Lối mở tập dượt cho
`8169b76c…` giữ nguyên; điều kiện gỡ đổi từ "khi có policy cuối" sang "khi runner tập dượt dừng
hẳn". Không đổi mã Aiken, không đổi hash nào.

**Vì sao.** Thư kho LAMP `lam1003mg-a` (2026-10-03): policy tLAMP Preprod CUỐI là `493002cc…`
(mã LAMP `main` = `17934d8`); `53bc12ad…` và `7ecbffe2…` bỏ — cái sau tính ra rồi huỷ 2026-10-02
vì thiếu nhãn marker đọc ra nghĩa. Genesis của policy cuối CHƯA gửi: id chắc chắn (script genesis
bên LAMP có cổng `EXPECTED_LAMP_PID`), nhưng chưa có tLAMP nào trên chuỗi. Cụm Preprod phục vụ
người dùng chưa dựng. Policy cuối cố ý KHÔNG gõ cứng vào mã: cổng là danh sách TỪ CHỐI.

**Cái gì gãy nếu ai đó đang bám bản cũ.** Sổ trạng thái hay tệp deploy nào ghi `53bc12ad…` (hay
`7ecbffe2…`) nay bị chặn lúc nạp — `POLICY_IDS.lamp` ở `scripts/`, `parseDeployment` ở
`VaultTxAPI`, `createVault`/`buildParamsList`/`withdrawLamp` ở SDK. `lamp_rehearsal_ack` không mở
được cho hai policy này: chúng không nằm trong bảng tập dượt.

## 2026-10-02 — Cửa sổ epoch tính từ gốc epoch Cardano: apply-param `window_origin_ms`

**Đổi gì.** Mọi validator nhận `ms_per_epoch` nhận thêm `window_origin_ms` làm apply-param CUỐI:
`consume`, `price_param`, `greenback_beacon`, `rate_param`, `um_datum_validator`, `paymaster`,
két InstantGen, két + `commit` ScheduleGen, `prepaid_vault` + `paid_fund`. Thời gian → epoch là
`(t − window_origin_ms) / ms_per_epoch`; epoch → biên là `window_origin_ms + e × ms_per_epoch`.
Chỗ cộng `ms_per_epoch` như một độ dài (`instant_unlock_ms`) không đổi. Off-chain lấy gốc từ một
nguồn: `ProtocolUtils/src/index.ts` ▸ `WINDOW_ORIGIN_MS_BY_NETWORK` (Mainnet `1_506_203_091_000`,
Preprod `1_654_041_600_000`; Preview chưa có gốc ⟹ `windowOriginMs` ném `WIN-PREVIEW`).
`scripts/deployParams.ts` đặt tham số mới cuối danh sách.

**Vì sao.** Đặc tả LAMP `Specs/Window/CONTRACT.md` v1.0: chỉ số cửa sổ phải bằng số epoch Cardano
và biên cửa sổ trùng biên epoch (mốc snapshot stake). Lưới cũ chia từ gốc Unix nên lệch biên epoch
Cardano 345.600.000 ms trên Preprod.

**Cái gì gãy nếu ai đó đang bám bản cũ.** Hash mọi validator kể trên đổi ⟹ cụm Preprod đang sống
không dùng được với mã này; phải đúc lại. Chỉ số epoch trên Preprod rơi từ khoảng 4.146 xuống
khoảng 316. Mã off-chain nào tự chia `t / ms_per_epoch` sẽ lệch một chỉ số với validator. Két
Wakeme còn ghi `gen_pin_period` theo gốc Unix ⟹ InstantGen đọc `L_lent = 0` cho tới khi Wakeme
chuyển cùng gốc (hướng lỗi an toàn: không nới gì). Preview không dựng được két cho tới khi chốt
gốc Preview, trừ khi truyền `ProtocolParams.windowOriginMs` tường minh.

## 2026-09-29 — PrepaidGen tách đốt và quyết toán: `consumed_unsettled` + `SettleLine`

**Đổi gì.** `PrepaidCredit` thêm trường thứ 5 `consumed_unsettled`; `BurnBatch` ghi nợ vào đó;
redeemer vault mới `SettleLine` (constr 6, permissionless) đưa nợ về 0 và cộng đúng bằng ấy vào
`magic_settled` của quỹ trong cùng giao dịch. `FundSettle` chỉ còn nhận co-spend với `SettleLine`.
Output quỹ và output vault tiếp nối không được mang reference script; quỹ không được rút ADA.
CARP Preprod trỏ sang `86ea6717…/110d0c97…`. `scripts/consumeBook.ts` nhận loại két `prepaid`.

**Vì sao.** Bản trước đo quyết toán bằng phần batch giảm TRONG giao dịch đốt: đốt không kèm quỹ
thì mất dấu vĩnh viễn (CARP đối ứng kẹt trong quỹ), và `paid_fund.spend` chỉ nhận một quỹ mỗi tx
nên lượt đốt chạm hai quỹ chỉ quyết toán được một.

**Cái gì gãy nếu ai đó đang bám bản cũ.** Lược đồ datum vault đổi ⟹ hash đổi
(`prepaid_vault 80d2ce80…`, `paid_fund bf12f3a4…`); cụm Preprod PrepaidGen 2026-09-20 không đọc
được bằng mã mới. Ai dựng `FundSettle` cùng `BurnBatch` sẽ bị từ chối — phải gửi `SettleLine`.

## 2026-09-15 — Hai giới hạn được ghi vào sổ nợ trước khi chúng thành mã: `Paymaster` và `C1`

**Đổi gì.** Chỉ `DevStatus.md`. Không một dòng mã nào đổi, có chủ ý.

1. **Nợ #73 mới — `Paymaster/onchain/validators/paymaster.ak:145` so `Address` ĐẦY ĐỦ với
   apply-param `treasury_addr`.** Phía kho LAMP, nhánh `Refill` chỉ ràng payment credential
   của output (`util.ak:118-123` ▸ `is_at_script`), nên stake part đổi được sau deploy. Một
   lần đổi là `lamp_to_treasury` cộng ra 0 vĩnh viễn ⟹ mọi giao dịch bảo trợ phí bị từ chối.
2. **Nợ #47 thêm khối CHỐT** — ràng buộc tạm, fail-closed: `C1` không quy kết qua
   `did_commit` trần · không tài liệu nào trong kho gán nhãn "chống-Sybil" cho `C1`/`C2` ·
   vế xác thực đi cùng chuyến đúc của `consume`, không mở chuyến đổi hash riêng.

**Vì sao.** Cả hai đều là giới hạn ĐÃ ĐO ĐƯỢC mà chưa có chỗ neo trong kho — chúng chỉ sống
trong thư giữa các nhà, và thư thì già đi lặng lẽ. Vế (2) là ràng buộc **phòng ngừa**: phép
liệt kê đóng trong kho cho 7 dòng chứa chữ "Sybil" và không dòng nào đang gán nhãn đó cho
`C1`/`C2`.

**Cái gì gãy nếu ai đó đang bám bản cũ.** Không gì gãy ở tầng mã. Ai đang định nới
`o.address == treasury_addr` thành so payment credential thì đọc Nợ #73 trước: nới ở đó
không gỡ bảo đảm mà dời nó sang chỗ không ai canh.

## 2026-09-15 — Sổ hash validator đã sai 1 ngày, và cổng canh nó chạy ở không chỗ nào

**Đổi gì.**

1. **`scripts/BUILD-RECORD.md` dựng lại.** Hai dòng sai:
   `ScheduleGen` ▸ `vault.vault` `b7d68fc9…` → `1c4cd06e…`, và
   `PrepaidGen` ▸ `prepaid.prepaid_vault` `5d54273f…` → `7454612c…`.
2. **`verify:build-record` nay chạy ở CI** — job `sổ BUILD-RECORD khớp hiện vật` trong
   `.github/workflows/pr-verify.yml`, **không bám phạm vi**, và `result` coi mọi kết quả
   khác `success` (kể cả `skipped`) là ĐỎ.
3. **`deploy:all` đổi `record:build` → `build:blueprints && verify:build-record`.**
4. **Thêm `scripts/build_blueprints.sh`** — dựng `plutus.json` cho cả 9 project rồi ĐẾM
   hai đầu (số `aiken.toml` so số `plutus.json`), đỏ khi lệch hoặc khi bằng 0.
5. **Văn xuôi trong `BUILD-RECORD.md` dời xuống dưới mốc `MÁY SINH — HẾT`.**

**Vì sao.**

`vault.vault` ghi sai trong sổ từ **2026-09-14 12:07** — `c95f1acf` đổi `lock.ak` (đổi
bytes), lượt chạm sổ gần nhất trước đó là `69c39a89` lúc 10:17. Cùng một trình biên dịch
hai phía (`v1.1.21+42babe5`), nên đây là lệch thật, không phải chuyện công cụ.

Cổng bắt được chuyện này **đã tồn tại từ trước**. Nó chỉ không chạy ở đâu cả:
`grep -rn 'verify:build-record\|record:build' .github/` trả về rỗng. Và `deploy:all` gọi
`record:build` — *ghi đè* — chứ không gọi `verify:build-record` — *so sánh*. Nên ở đúng
lúc một con số sai nhất có thể gây hại, quy trình deploy **xoá bằng chứng** thay vì nêu nó
lên, và không bước nào đỏ.

Gạch 4 tồn tại vì không có nó thì cổng mới xanh đúng lúc nó không đo gì: `verify:build-record`
so sổ với hiện vật **đang nằm trên đĩa**, không tự dựng. Hiện vật cũ hơn mã nguồn thì phép
so đối chiếu một bản cũ với một bản cũ khác rồi in "khớp" — trạng thái KHÔNG ĐO ĐƯỢC mang
màu của KHỚP.

Gạch 5 tồn tại vì `record:build` ghi đè **toàn bộ** khối máy sinh. Một bản vá trước đã đặt
chú thích và một khối văn xuôi giải thích `fund_nft` biến mất vào trong khối đó; lượt dựng
lại đầu tiên xoá sạch. Bộ kiểm không đỏ, `git status` vẫn sạch — văn xuôi không có bài kiểm
nào canh.

**Cái gì gãy nếu ai đó đang bám bản cũ.**

- Ai đã chép `b7d68fc9…` hoặc `5d54273f…` ra khỏi kho đang giữ hash của bytes không còn tồn
  tại. `prepaid_vault` chưa lên mạng nào nên không có di trú; `vault.vault` thì phải đối
  chiếu lại với `scripts/DEPLOYED.md` trước khi dùng con số cũ cho bất cứ việc gì.
- `npm run deploy:all` nay **DỪNG** khi sổ lệch, thay vì lặng lẽ ghi đè sổ rồi deploy tiếp.
  Đó là chiều đúng: sổ lệch nghĩa là không ai biết bytes sắp lên chuỗi là bytes nào.
- Viết chữ vào giữa khối `MÁY SINH` của `BUILD-RECORD.md` nay làm CI ĐỎ, chứ không còn
  biến mất trong im lặng ở lượt `record:build` kế tiếp.

**Đo bằng cách nào.** Gỡ-chốt, hai chiều: đổi `vault.vault` trong sổ về hash cũ ⟹
`verify:build-record` `exit=1`; khôi phục ⟹ `exit=0`.

## 2026-09-14 — Kho thôi tự đúc "LAMP": ba runner dừng thay vì đúc, và cổng dời về một chỗ

**Đổi gì.**

1. **Ba runner E2E không còn gọi `deploy/01_mint_lamp.ts`.** `run_wakeme_e2e.sh`,
   `run_consume_e2e.sh` và `run_consume_schedule_e2e.sh` nay **DỪNG** khi thiếu
   `LAMP_POLICY_ID`, kèm câu chỉ đúng chỗ lấy giá trị canonical theo mạng.
2. **`POLICY_IDS.lamp` thành cổng** (`scripts/config.ts` ▸ `requireLampPolicyId`): kiểm
   56 ký tự hex, ném khi thiếu, **cộng một danh sách TỪ CHỐI** các policy đã biết là
   không phải LAMP. Bỏ chuỗi giữ chỗ `"FILL_AFTER_MINT"`.

   Cổng hình dạng một mình KHÔNG đủ: `28e916b0…` đúng 56 ký tự hex và hiện ra đúng chữ
   `tLAMP`. Mà `scripts/state.*.sh` bị `.gitignore` chặn (`.gitignore:27`), nên bản vá
   trong kho **không với tới** sổ cũ đang nằm trên đĩa từng máy — máy nào còn sổ cũ thì
   vẫn nạp đúng giá trị đó vào môi trường. Danh sách từ chối là thứ duy nhất chặn được
   đường đó từ trong kho.

   Là danh sách TỪ CHỐI chứ không phải CHO PHỘP, và chỗ đó có lý do: gõ cứng một giá trị
   cho phép là dựng một bản sao sẽ chết im lặng khi nguồn đổi — nguồn thật sắp đổi, vì
   kho LAMP đang đổi tên bốn nhãn NFT mà nhãn là apply-param nằm TRONG policy id. Gõ cứng
   một giá trị từ chối thì hỏng về phía an toàn: sai lắm là chặn nhầm, và người bị chặn
   biết mình bị chặn.
3. **Hai sổ trạng thái thôi mang `28e916b0…`** (`scripts/state.Preprod.sh`,
   `state.Preview.sh`).
4. **`resolve_lamp_policy.ts` thôi in khoá `LAMP_POLICY_ID=`** — nay in
   `WALLET_DERIVED_LOOKALIKE_POLICY_ID=`, và tự khai là công cụ chẩn đoán.
5. Dán nhãn ở `scripts/DEPLOYED.md` và `VaultReadAPI/tests/fixtures/preview-e5fd34b1.ts`.

**Vì sao.** `28e916b0…` **không phải LAMP**. Nó là chính sách chữ-ký-đơn suy tất định từ
khoá ví deploy: không trần phát hành, không `SupplyState`, không cổng WHO — và đúc lần hai
thì cộng dồn lên tài sản cũ, nên ngày 2026-08-28 cung tLAMP Preprod lên 72 tỷ, gấp đôi trần
36 tỷ, không gì đỏ. Đo trên ví deploy hôm nay: policy đó đang giữ cả `tLAMP`, `prodLAMP`,
`REG`, `SUPPLY` và một dòng đã bị đổi tên thành `E2ENOTLAMP` — tức nó bắt chước TRỌN hình
dạng của `lamp_mint` thật, không chỉ một dòng token.

**Ba chỗ đáng ghi lại vì cùng một mẫu "cẩn thận đúng một nửa".**

- **Cổng chặn ĐÚC không chặn DÙNG NHẦM.** `run_consume_schedule_e2e.sh` đã bỏ lệnh đúc và
  thay bằng `resolve_lamp_policy.ts`, tự mô tả là "hỏi chuỗi, chỉ đọc, không đúc". Vế đó
  đúng. Nhưng hàm ấy suy policy TỪ KHOÁ VÍ, nên thứ nó tìm thấy chính là token nhái — và
  đường này đi qua êm hơn hẳn vì nó không ghi gì lên chuỗi. Một lượt chạy xanh với token
  nhái trông y hệt một lượt xanh với token thật.
- **Sổ thắng mã.** Mã chỉ đọc biến môi trường (`config.ts`), còn giá trị thật đi vào lượt
  chạy nằm ở `state.$NET.sh`. Sửa hết mã mà bỏ sổ thì lượt sau vẫn dùng token cũ.
- **Cổng rải khắp nơi thì sót đúng chỗ nguy hiểm nhất.** Vài nơi gọi có kiểm chuỗi
  `"FILL_AFTER_MINT"`, nhưng `deploy/03_deploy_shards.ts` và `deploy/06_publish_ref_scripts.ts`
  đưa thẳng nó vào **apply-param** không kiểm gì. Apply-param là tham số lúc biên dịch: giá
  trị rác vẫn ra bytes, vẫn ra script hash, vẫn deploy êm — địa chỉ sai vĩnh viễn. Nên cổng
  dời về **một** chỗ ở `config.ts`, che mọi nơi gọi cùng lúc.

**Gãy gì.** Mọi lượt chạy E2E nay **bắt buộc** có `LAMP_POLICY_ID` đặt sẵn ở môi trường;
không còn đường nào tự sinh ra nó. Đây là fail-closed cố ý. Script nào `grep` khoá
`LAMP_POLICY_ID=` từ đầu ra của `resolve_lamp_policy.ts` sẽ không khớp nữa — cũng cố ý.
`deploy/01_mint_lamp.ts` **giữ lại** nhưng đứng ngoài mọi đường chạy, và vẫn cần
`LAMP_MINT_CONFIRM` khớp mạng cùng lệnh từ chối Mainnet.

## 2026-09-14 — Nợ #48: hạ bậc hai ở nhánh fire, và một phép đo lật ngược hai kết luận của chính hôm qua

**Đổi gì.** Ba thay đổi trong `ScheduleGen/onchain/lib/magiclamp/protocol/lock.ak`, tất cả
**giữ nguyên kết quả từng bit** nên phía TypeScript không đổi dòng nào (P8):

1. `lock_youngest` và `unlock_oldest` cộng dồn bằng nối-ĐẦU rồi `list.reverse` một lần ở
   nhánh dừng, thay cho `list.concat(acc, […])` mỗi bước đệ quy. O(n²) → O(n).
2. `coalesce_holdings` giữ bộ tích luỹ NGƯỢC suốt vòng lặp và lật một lần ở cuối. Nhánh
   không-gộp-được — nhánh thường gặp — từ O(|acc|) xuống O(1).
3. `unlock_locked_amount` gộp theo HAI ĐOẠN thay vì gộp cả dãy: `unlocked ++ freed` mang
   `is_locked=False`, `still_locked` mang `True`, mà `same_bucket` đòi trùng cả `is_locked`
   — nên không phần tử nào của đoạn sau gộp được với đoạn trước. n² → n₁² + n₂².

Cộng một **thang đo giữ lại trong tệp** (`probe_commit_fixture_cap`,
`probe_fire_fixture_cap` ở `validators/vault.ak`). Bản trước gỡ thang đo ra sau khi đọc số,
và cái giá là lần đo lại phải dựng từ đầu — đủ đắt để không ai đo lại.

**Vì sao.** `coalesce_holdings` tự khai *"revisit only if fire ExUnits actually bite"*.
Chúng đã cắn: mục bên dưới ghi fire 138,9 % `maxTxExMem` ở 64 holding.

**Số đo** (`aiken check`, validator đã trừ chi phí fixture, 96/96 bài xanh):
fire **61,3 % → 51,1 %** (−16,6 %); commit **55,1 % → 54,6 %** (−1,1 %).

**Hai kết luận của mục bên dưới bị lật, cả hai do đo lại chứ không do suy luận.**

- **Hai nhánh có hai thủ phạm KHÁC NHAU.** Mục dưới viết "thủ phạm không phải `list.sort`
  … đừng nhắm vào `list.sort`". Đúng cho **fire**, sai cho **commit**. Bản vá này chạm mọi
  thứ TRỪ `list.sort`, và commit đứng yên (−1,1 %) — tức phần đã chạm không phải thủ phạm
  của nó. `list.sort` của Aiken là sắp-xếp-chèn; `lock_youngest` trong fixture đó chỉ chạm
  ~11 phần tử nên không thể tạo ra mức đã đo.
- **Thứ tự chết đảo: commit n ≈ 52 giờ đứng trước fire n ≈ 55.** Cổng đếm holding ở
  `validate_commit` vẫn cần, nhưng lý do đã đổi — nay nó canh chính nhánh hẹp nhất.

**Trần giữ nguyên 40, KHÔNG nâng.** Phần biên vừa mua được rơi vào nhánh fire, trong khi
nhánh hẹp nhất bây giờ là commit và nó không nhúc nhích. Số đo cũng là của validator trong
bài kiểm, chưa mang kích thước giao dịch thật.

**Còn nợ.** P4 — thay `list.sort` bằng sắp-xếp-trộn đảo-phần-tử-hoà — **chưa làm, cố ý**.
Ở trần 40, commit mới dùng 54,6 % nên nó không mua được gì. Mốc kích hoạt và điều kiện
(bài kiểm tính chất trên đầu vào dày phần tử hoà phải xanh TRƯỚC, vì `list.sort` ĐẢO phần
tử hoà còn sắp-xếp-trộn thường thì không) ghi tại `validators/vault.ak` ▸ khối *"Trần
ExUnit của hai nhánh mang LAMP"*.

**Gãy gì.** `lock.ak` đổi bytes ⟹ **đổi script hash `vault.vault` và `vault.shard` của
ScheduleGen ⟹ đổi địa chỉ**, cùng đợt với các thay đổi ở mục dưới. Hành vi không đổi: mọi
danh sách vào/ra giống hệt bản cũ, nên bên dựng tx không phải sửa gì ngoài việc trỏ sang
địa chỉ và ref-script mới.

## 2026-09-14 — Đóng một ngõ cụt khoá LAMP vĩnh viễn ở ScheduleGen, và hạ hai tham số về dưới trần vật lý

**Đổi gì.** Bốn thay đổi, ba trong số đó đổi bytes validator ⟹ đổi script hash ⟹ **đổi địa chỉ**.

1. **`validate_fire` prune TRƯỚC khi đếm** (`ScheduleGen/onchain/validators/vault.ak`). Bản
   cũ tính `batch_budget` trên `datum.magic_batches` chưa lọc, rồi vài dòng sau mới dựng
   `updated_batches` trên danh sách ĐÃ lọc. Bản vá lọc **một lần** và dùng cho cả hai chỗ.
   Bản sao y hệt ở off-chain (`ScheduleGen/offchain/src/schedule.ts` truyền
   `magic_batches.length` thô) vá cùng commit theo P8.
2. **Thêm redeemer `PruneExpired`** cho ScheduleGen, **constr 5, đặt CUỐI danh sách** —
   khuôn lấy từ `InstantGen/onchain/validators/vault.ak` ▸ `validate_prune_expired`.
   Permissionless, không đụng LAMP, từ chối lượt rỗng, giữ nguyên `last_updated_epoch`.
3. **`max_loyalty_holdings` 64 → 40** ở cả ScheduleGen lẫn InstantGen, hai bên P8, cộng
   **một cổng đếm holding mới trong `validate_commit`** — nhánh này trước đây không có,
   dù `validate_fire`, genesis và `validate_withdraw_lamp` đều có. Cổng ấy mang **dấu
   NGHIÊM `<`**, không phải `<=` như ba cổng kia, và chênh lệch một ký tự đó là toàn bộ
   nội dung của nó — xem đoạn riêng bên dưới. Gương off-chain:
   `ScheduleGen/offchain/src/math.ts` ▸ `assertHoldingCapAfterCommit`, gọi ở
   `schedule.ts` ▸ `buildScheduleCommit` (mã lỗi `GEN-SCH-007`).
4. **`f_cap_surplus_q` 0,10 → 0,001** (InstantGen) và **`um_max_step_q = 0,10`** (UMKeeper,
   chốt mới) — hai hàng rào TẠM, xem `DevStatus.md` Nợ #49 và #50.

**Vì sao.** Ngõ cụt ở (1) là đường **khoá LAMP vĩnh viễn**, cùng lớp với bài học đắt nhất
của kho ghi ở `BOUNDARIES.md §5`. Ba vế khoá lẫn nhau: `ScheduleFire` là nhánh DUY NHẤT hạ
được `lamp_locked`; nó tự chặn mình khi danh sách batch đầy, kể cả khi cả 32 batch đã chết;
`BurnBatch` không cứu được vì nó đòi batch CÒN SỐNG, mà `schedule_decay_window = 1` giết cả
32 ở epoch kế. Trước bản vá, `prune_expired` chỉ được gọi ở hai chỗ và **không chỗ nào là
một cửa độc lập** — nên (2) không phải tiện tay dọn dẹp mà là van an toàn cho cả họ ngõ cụt
cùng dạng. Cửa sổ thoát rộng đúng một epoch: bắn tới đúng 32 batch trong epoch E mà không
tiêu hết ngay trong E thì E+1 là khoá vĩnh viễn.

(3) vì 64 nằm **trên** trần vật lý. Đo `aiken check` trên giao dịch trọn vẹn, đã trừ chi phí
dựng fixture, đối chiếu `maxTxExMem = 16 500 000`: commit **128,6 %** ở 63 holding, fire
**138,9 %** ở 64; ở 40 thì 58,4 % / 62,2 %. Điểm chết khớp bậc hai: fire n ≈ 53, commit
n ≈ 55 — **fire chết TRƯỚC commit**, tức cửa RA hẹp hơn cửa VÀO, và đó là lý do cổng đếm
holding phải có mặt ở nhánh commit chứ không chỉ ở nhánh fire.

**Và cổng ấy phải mang dấu NGHIÊM — bản đầu của chính đợt vá này viết `<=`, và như thế
là thay một ngõ cụt bằng một ngõ cụt khác.** Đường RA tự nó làm danh sách dài thêm ĐÚNG
một phần tử: `unlock_oldest` cắt holding ở biên lượt nhả thành `(epoch, đã mở)` +
`(epoch, còn khoá)`, mà `same_bucket` đòi trùng **cả** `is_locked` nên `coalesce_holdings`
không gộp hai mảnh đó lại. Với `<=`, tồn tại một trạng thái vào được mà không ra được:
commit khoá **trọn** số dư giữ nguyên độ dài danh sách (mọi holding khoá nguyên cái, không
cắt cái nào), chạm đúng trần, được nhận; rồi **mọi** lượt fire đều cho trần + 1 và bị
`validate_fire` từ chối — với mọi `k ∈ [1, max_fires_per_tx_catchup]`, nên không có lựa
chọn epoch nào cứu được. Cửa phụ cũng không có: `lamp_locked` chỉ giảm ở nhánh fire, và
`validate_withdraw_lamp` chết ở `amount <= avail` với `avail = balance − locked = 0`.
Kết cục là LAMP khoá vĩnh viễn **cộng** một suất `shard_active_count` không bao giờ trả
lại, tức mất vĩnh viễn một phần `SHARD_CAP` của 1/16 số người dùng.

Một suất là **đủ** và là **tối thiểu**: nhả đi từ epoch già nhất theo thứ tự, nên tại mỗi
thời điểm chỉ một epoch mang đồng thời hai mảnh; lượt sau cắt tiếp cùng epoch đó thì mảnh
mở mới gộp vào mảnh mở cũ (+0), và biên chỉ dời sang epoch kế khi epoch cũ đã cạn. Vậy
đỉnh danh sách trong suốt vòng đời = (độ dài sau commit) + 1. Ba bài canh, cả ba đỏ khi
đảo dấu về `<=` (đã đo bằng cách đảo thật rồi chạy lại): `c_commit_full_lock_at_cap_rejected`
chặn lối vào, `cf_commit_at_cap_then_fire_ok` chạy một lượt fire **thật** trên datum do
commit sinh ra để chứng minh cửa ra còn mở, `hc_full_lock_keeps_length_then_fire_adds_one`
giữ phần số học để hai bài kia không thành số ma thuật.

**Đính chính một kết luận cũ của chính đợt đo này.** Thủ phạm bậc hai **không phải
`list.sort`**: nhánh fire không sort danh sách đầy đủ mà vẫn bậc hai. Nguồn là mẫu `foldl` +
`merge_into(acc, h)` trong `coalesce_holdings` và `list.concat(acc, […])` trong
`lock_youngest` (`ScheduleGen/onchain/lib/magiclamp/protocol/lock.ak`) — chú thích của chính
`coalesce_holdings` đã tự khai *"O(n²)… revisit only if fire ExUnits actually bite"*.

> 🔴 **Đoạn đính chính ngay trên ĐÃ BỊ THAY** bởi mục ngày 2026-09-14 ở đầu tệp. Nó đúng cho
> nhánh **fire** và sai cho nhánh **commit** — hai nhánh có hai thủ phạm khác nhau, và câu
> "đừng nhắm vào `list.sort`" đọc như một lời khuyên cho cả hai. Cả hai vế "fire chết trước
> commit" và "thủ phạm không phải `list.sort`" đều không còn đúng sau khi đo lại. Giữ đoạn
> này ở nguyên chỗ vì nó là chuyện đã xảy ra; đừng dùng nó làm căn cứ.

**Gãy gì.** **Địa chỉ ScheduleGen và InstantGen đổi.** Vault đang sống trên Preview/Preprod
nằm ở địa chỉ cũ và vẫn tiêu được bằng script cũ (ref-script CIP-33 cũ còn trên chuỗi), nhưng
**không** đọc được bằng bản mới — phải deploy lại và di trú. Không có gì trên mainnet. Thêm
`PruneExpired` là thêm constr **ở cuối**, nên mọi UTxO đã tạo vẫn giải mã được; bên dựng tx
nào tự gõ chỉ số constructor thay vì dùng `VaultRedeemerSchema` thì phải soát lại. Hai vector
chuẩn của InstantGen (`TV-IG-GRANT-02`, và ca `LAMP nâng TRẦN…` trong `instant.test.ts`) đổi
`magic_supply` đầu vào — bắt buộc, vì `cap_surplus` co 100 lần sẽ thành cái chặn thay cho
`cap_pp` và hai ca đó sẽ xanh vì lý do khác với tên chúng mang.

## 2026-09-14 — `GetMAGIC/` ra khỏi kho: cửa sinh MAGIC thứ tư trong một mô hình chỉ có ba cửa

**Đổi gì.** Xoá `GetMAGIC/` (22 tệp) cùng `scripts/deploy/08_deploy_getmagic.ts`,
`scripts/test/getmagic_claim.ts`, `scripts/test/getmagic_flow.ts`. Vá tham chiếu ở `README.md`,
`scripts/README.md`, `scripts/BUILD-RECORD.md`, `scripts/deployParams.ts` (bỏ `otcOrderParams`),
`scripts/check_param_names.ts` (bỏ import + ca kiểm), `DevStatus.md`, và một chú thích trong
`ScheduleGen/onchain/validators/vault.ak` từng trỏ sang nợ của module này.

**Vì sao.** `Specs/MagicLamp-Tripletoken-Feat-(Vi).md:174` (§6.1) chốt đúng ba cửa sinh —
*"Ba cửa: InstantGen · ScheduleGen · PrepaidGen"* — và chuỗi `GetMAGIC` không xuất hiện một lần
nào trong đặc tả. Một cửa fiat→MAGIC sinh quyền-tiêu mà không có LAMP hay CARP đứng sau, nên nó
không phải tính năng còn dở mà là tính năng **mâu thuẫn với bất biến**: MAGIC là quyền-tiêu suy
ra từ tài sản đã khoá, không phải hàng bán. Ba lỗ ở tầng validator đi kèm — khoá công xác minh
là trường của **chính datum nó xác minh**; nhánh `Settle` ràng output theo `order_id` nhưng
không theo nội dung; mốc hết hạn tính bằng `expiry_epoch × 86_400_000` nên với `expiry_epoch = 7`
ngưỡng rơi vào 1970-01-08 và luôn đúng — là hệ quả của việc module đứng ngoài mô hình, không phải
nguyên nhân độc lập.

**Gãy gì.** Không có gì trên chuỗi: `scripts/DEPLOYED.md` nhắc module này 0 lần, nên không định
danh on-chain nào mất đường giải mã. `npm run deploy:all` không đi qua bước 08. Ai đang gọi
`otcOrderParams` từ `scripts/deployParams.ts` sẽ gãy lúc biên dịch — đó là ý định. Bản mã cuối
cùng của module ở `8cfd5295`.

Ba lớp lỗi thì **vẫn còn hiệu lực** cho mọi module khác, đã ghi lại trong các dòng nợ đóng ở
`DevStatus.md`: nối `ByteArray` độ-dài-tự-do rồi ký là không đơn ánh · khoá công xác minh không
được là trường của datum được xác minh · ghim `payment_credential` mà bỏ `stake_credential` là
chưa ghim địa chỉ.

## 2026-09-11 — Ba con số CARP đều sai · SPEC §10 trích sai chính tệp nó viện dẫn · sổ ghi "chờ" cho việc đã xong

**Đổi gì.**
- `PrepaidGen/offchain/src/constants.ts`: `CARP_POLICY_ID` cho cả ba mạng chuyển sang `null`
  và **ném** khi bị hỏi, thay cho ba giá trị hex đã gõ sẵn. Preview **không có CARP**; Mainnet
  chưa deploy. Bài kiểm cũ ghim đúng con số sai nên nó xanh suốt.
- `Specs/MagicLamp-Tripletoken-Feat-(Vi).md` §10: nguồn của C1 đổi từ `consumed_count` sang
  `consumed_nanogic` — đúng tên trường mà chính §10 viện dẫn.
- `DevStatus.md` + `scripts/DEPLOYED.md`: dòng `ScheduleFire` ghi "chờ" trong khi Preview đã
  bắn 8 lượt (`fired_count: 8`, 64.000.000 nanogic). Đo lại trên chuỗi và ghi kèm **lệnh
  đo lại**, không chỉ kết quả. Sáu dòng nợ trỏ vào một kho không còn tồn tại cũng đo lại.

**Vì sao.** Một hằng đệm cho dữ liệu của bên khác là "cái vỏ im lặng": `CARP_POLICY_ID` trông
như đã cấu hình, nên không ai đi hỏi. Fail-closed phải **ném**, không được trả chuỗi rỗng.

**Gãy gì.** Mã nào đang đọc `CARP_POLICY_ID` sẽ ném thay vì trả hex sai — đó là ý định. Nối
CARP thật thì lấy giá trị từ nhà phát hành, đừng gõ lại vào tệp này.

## 2026-09-07 — Shard hết tin HÌNH DẠNG DATUM · `did_commit` ép khuôn ở mọi chỗ ghi · `INV-CASHBACK-BOUND` ra khỏi một dòng chú thích

**Đổi gì.**
- **ScheduleGen** (`onchain/validators/vault.ak` ▸ `vault_cospend_matches`): nhận diện vault
  đối tác nay đòi **cả hai** — input nằm ở `Script(vault_script_hash)` *và* mang NFT danh
  tính vault — thay cho việc giải mã datum rồi tin nội dung nó khai.
- **ConsumeMAGIC** (`onchain/validators/consume.ak` ▸ `did_len_ok`): `did_commit` bị ép
  **độ dài 0 hoặc đúng 32 byte** ở mọi điểm GHI (mint genesis Engage, BindDID). Cố ý KHÔNG
  ép ở nhánh `Consume` — đó là cổng RA, ép ở đó biến mọi thread đã tồn tại sai khuôn thành
  bất khả tiêu, khoá min-ADA vĩnh viễn.
- **InstantGen** (`onchain/lib/magiclamp/protocol/math.ak` ▸ `compute_reward_from_consumed`):
  bất biến `INV-CASHBACK-BOUND` được viết thành một khối lập luận có số, và tham số `pm_q`
  được gọi đúng tên — **hệ số hồ sơ hoạt động**, không phải hệ số tư-cách §6.2.

**Vì sao.** Hình dạng datum là thứ **người gửi tự đặt**, nên nó không chứng minh gì; chỉ địa
chỉ (ledger ép chạy validator) hoặc NFT one-shot mới chứng minh được. `did_commit` dài tuỳ ý
vừa phình UTxO vừa buộc mọi bên đọc tự đoán khuôn — và "tự đoán khuôn" ở lớp định danh là chỗ
hai bên đọc ra hai người khác nhau từ cùng một chuỗi byte. Còn hai hệ số kia cùng mang chữ
"multiplier", cùng định dạng Q, cùng nhân vào một biểu thức: **không dấu hiệu nào trong kiểu
phân biệt được chúng, và không bài kiểm nào đỏ nếu ai đó hoán chỗ**. Hoán nhầm thì
`0,20 × 2,00 × 2,50 = 1,00` — hoà vốn, vòng tiêu-rồi-được-hoàn thôi hội tụ.

**Gãy gì.** Về LOGIC thì cả ba đều **siết thêm**, không nới: giao dịch hợp lệ theo bản cũ vẫn
hợp lệ, trừ đúng những ca mà bản cũ lẽ ra phải từ chối.

🔴 **Nhưng về BYTES thì hai script đổi hash, và đó mới là thứ gãy:**

| script | đổi gì | hệ quả |
|---|---|---|
| `ScheduleGen` ▸ `validator shard` | apply-param **1 → 2** (`shard_policy_id_param` + `vault_script_hash` mới) | bytes đổi ⟹ **script hash đổi ⟹ ĐỊA CHỈ đổi** |
| `ConsumeMAGIC` ▸ `validator consume` | thêm variant `BindDID` vào `ConsumeRedeemer` | bytes đổi ⟹ **script hash đổi** |

Hệ quả phải làm, không phải tuỳ chọn:

- **Mọi script tham chiếu CIP-33 đã công bố cho hai script này là của bản CŨ.** `REF_SHARD_UTXO`
  ghi trong `scripts/DEPLOYED.md` trỏ một ref-script không còn khớp hash nào đang dùng. Phải
  công bố ref-script mới rồi mới chạy được lượt triển khai kế tiếp.
- **Mọi UTxO shard đang sống nằm ở địa chỉ CŨ** và chỉ tiêu được bằng bản cũ. Không có đường
  "nâng cấp tại chỗ" — apply-param là tham số lúc **biên dịch**, nên đây là một cụm shard đời
  mới, không phải một bản vá cho cụm đang chạy.
- `ConsumeRedeemer` nay có **hai** variant. `BindDID` ĐẶT Ở CUỐI để `Consume` giữ nguyên
  `Constr 0` — mã đang mã hoá `Consume` không phải sửa. Nhưng lần thêm variant sau **không
  được** chiếm `Constr 1`, chỗ đó đã có chủ.
- `did_commit` là **bất biến sau khi đặt** ⟹ mọi thread mở từ nay mang khuôn 32 byte vĩnh
  viễn; đặt sai là khoá chết ngoài lớp tư-cách.

## 2026-09-11 — `VaultReadAPI`: mặt tiền ĐỌC-THÔI để backend không-TypeScript đọc được số MAGIC thật

**Đổi gì.** Thêm gói `VaultReadAPI/` — sidecar HTTP `GET /vault/by-owner/{owner_pkh}`
trả số MAGIC của vault dưới dạng JSON, cộng một CLI `npm run probe` đi qua **cùng** một
đường đọc. Thêm một tên vào mặt tiền MagicSDK: `export type { VaultDatum }`
(`MagicSDK/src/index.ts`) — lược đồ đã xuất từ trước, kiểu thì chưa, nên mã ngoài đọc
được datum mà không khai nổi biến giữ nó.

**Vì sao.** Backend Java hiện trả cứng `0` cho số MAGIC của mọi người dùng. Bảo nó tự
đọc datum vault là dựng **bản thứ hai** của `VaultDatum` 17 trường sang ngôn ngữ khác,
và bản thứ hai lệch ngay lượt đổi datum đầu tiên — lệch mà không gì báo. Định nghĩa
datum ở nhà MAGIC nên đường đọc nó ở lại đây; gói này chỉ mở một cái cửa HTTP cho ngôn
ngữ khác. Nó dùng lại `VaultDatumSchema` + `isBatchExpired` của MagicSDK và
`posixMsToEpoch` của ProtocolUtils, không chép lại cái nào.

Ba quyết định đáng nêu, vì cả ba đều là chỗ một mặt tiền ngây thơ sẽ nói dối:

1. **BA CA, BA MÃ.** "chủ chưa có vault" → `200 {vaults:[]}`; "không đọc được chuỗi" →
   `502 CHAIN_UNAVAILABLE`. Gộp hai ca là dựng lại đúng con số `0` đang sai — người dùng
   **có** MAGIC mà đường đọc gãy thì vẫn thấy `0`. Đã đo: nút chuỗi chết ⇒ `502` kể cả
   khi hỏi PKH không có vault.
2. **HAI con số, không một.** `available_nanogic` (Σ batch còn sống tại `at_epoch`) tách
   khỏi `accrued_nanogic` (Σ mọi batch trên sổ). Với ScheduleGen `decay_window = 1`, một
   vault vừa "đã sinh 64 000 000 nanogic" vừa "tiêu được 0 hôm nay", và cả hai đều đúng.
3. **Đòi NFT danh-tính vault, không chỉ `datum.owner`.** Địa chỉ script là công cộng: lọc
   theo `owner` thôi thì ai cũng đặt được một UTxO datum tự soạn ở đó và mặt tiền sẽ báo
   một số dư không giao dịch nào chi ra được. On-chain từ chối đúng ca đó —
   `ScheduleGen/onchain/validators/vault.ak` ▸ `validate_vault_value`, ▸ `has_vault_id_nft`.

**Gãy gì nếu đang bám bản cũ.** Riêng mục này không gãy gì: gói mới, không đụng `onchain/`
nên **mục này** không đổi script hash nào; thay đổi duy nhất ngoài gói là **thêm** một
`export type` ở MagicSDK
— cộng, không phá. `MagicSDK/src/listVaults.ts` giữ nguyên hành vi (xem mục "còn nợ" ở
`VaultReadAPI/README.md §7` và ghi chú về `catch { continue }` ở `listVaults.ts:64`).

## 2026-08-26 — `npm install` chạy được từ checkout sạch: `prepare` tự cài bộ công cụ của chính nó

**Đổi gì.** `ProtocolUtils` và `ConsumeMAGIC/pricing` đổi `prepare` từ `npm run build`
sang `node prepare.mjs`; thêm `prepare.mjs` (giống nhau ở hai gói) vào cây và vào `files`.
Kịch bản làm ba bước: tự `npm ci --ignore-scripts` bộ công cụ của gói nếu thiếu → dựng
tường minh các dependency `file:` có `prepare` riêng → mới `npm run build`. `README.md`
thêm mục cài đặt lần đầu.

**Vì sao.** Dev tuanzoro2k báo `cd InstantGen/offchain && npm install` chết ngay từ gói
đầu: `npm error code 127 … sh: tsc: command not found`, path `…/ProtocolUtils`. npm chạy
`prepare` của một dependency `file:` ngay trong thư mục gói đó nhưng **không** cài
`devDependencies` ở đó, nên `tsc` không tồn tại và npm cuộn ngược cả cây. Thứ tự đúng
(`cd ProtocolUtils && npm install && npm run build`) không được ghi ở `README.md` hay
`DevStatus.md` — nghĩa là mọi con số test trong repo chỉ dựng lại được trên máy đã lỡ
build tay một lần. Vá bằng tài liệu thôi là để nguyên cái bẫy; vá thật thì thứ tự dựng
tự lo được. Bước hai của kịch bản là bắt buộc chứ không phải trang trí: `pricing` vừa có
`prepare` vừa phụ thuộc `file:` `ProtocolUtils`, mà `tsc` của nó cần `.d.ts` từ `dist/`
của gói kia.

**Gãy gì nếu đang bám bản cũ.** Không gãy gì: `npm run build` giữ nguyên chuỗi lệnh,
`exports`/`main`/`types` không đổi, `dist/` sinh ra y hệt (kiểm lại vector CJS của bản
0.2.0: `requiredForOp(2, 1000n, 1_333_333_333n, {2: 1_000_000n})` → `1333333333n`).
Không đụng `src/`, không đụng vector, không đụng `onchain/` — script hash validator
không đổi. Ai đang có `node_modules` cũ thì không thấy khác biệt; khác biệt chỉ lộ ở
máy sạch. Một cái bẫy khác **vẫn còn**, chỉ được ghi chứ chưa vá: `MagicSDK` cài xanh
nhưng 6 test trong `tests/vaultParams.test.ts` ngã `ENOENT` vì đọc
`{InstantGen,ScheduleGen}/onchain/plutus.json` — artifact đã gitignore, phải
`aiken build` trước.

## 2026-08-12 — Đổi tên `CHANGELOG.md`/`DEVSTATUS.md`, và `scripts/README.md` thôi dạy cất khoá vào `.env`

**Đổi gì.** `CHANGELOG.md` → `ChangeLog.md`, `DEVSTATUS.md` → `DevStatus.md`; 32 tệp có
con trỏ tới hai tên cũ vá cùng đợt. `scripts/README.md` viết lại theo
[`ConsumeMAGIC/EXEC.md`](ConsumeMAGIC/EXEC.md) — nó nay là nguồn chuẩn cho chuỗi
ConsumeMAGIC, README chỉ mô tả phần scripts. `scripts/.env.example` bỏ hai ô
`BLOCKFROST_KEY`/`PRIVATE_KEY` và hai biến chết `VAULT_SNAPSHOT_HASH`/`VAULT_VACUUM_HASH`.

**Vì sao.** Tên viết hoa toàn bộ là quy ước của **nhật ký phát hành theo phiên bản** (Keep
a Changelog / SemVer) và là thứ `release-please`/`semantic-release` đi tìm — hai tệp này
không phải loại đó, chúng ghi quyết định spec (`_rules/agent-hygiene.md §3.1`, chủ nhân
chốt 2026-08-09). Còn `.env.example`: nó dạy đúng cái repo cấm — chép khoá Blockfrost và
private key xuống đĩa, trong khi bí mật chỉ nên đi vào bằng **giá trị** qua môi trường và
`run_consume_e2e.sh` đã nhận theo đường đó sẵn. Một mẫu bảo "điền khoá vào đây" là một bản
sao thứ hai của thứ chỉ nên có một bản.

**Gãy gì nếu đang bám bản cũ.** Mọi liên kết `DEVSTATUS.md`/`CHANGELOG.md` từ repo khác
trỏ sang MAGIC sẽ chết — trên máy phân biệt hoa-thường (Linux, CI) là 404 thật, trên macOS
thì im lặng mở đúng tệp nên không lộ. `.env` cũ **vẫn chạy**: `config.ts` đọc
`process.env` nên `dotenv` vẫn nạp khoá nếu ai đã điền; nhưng nó không còn được tài liệu
nào ủng hộ. `scripts/README.md` không còn liệt `npx tsx src/keeper.ts` như cách chạy
UMKeeper — lệnh đó chưa bao giờ chạy được gì, `keeper.ts` là thư viện không có entry.

## 2026-08-09 — Dọn mô hình bốn-cơ-chế vào `Legacy/`, dựng lại tài liệu-vào-đầu

**Đổi gì.** `SnapshotGen/` sang `Legacy/stale-genmodel-2026-07/`, `VacuumGen/` sang `Legacy/`, cùng 10 báo
cáo testnet, `SnapshotGen-Simulator.HTML`, `DEVELOPER_GUIDE.md` và 5 tệp script chỉ phục
vụ hai module đó. Đặc tả canonical `Specs/MagicLamp-Tripletoken-Feat-(Vi).md` được mang về
nhánh làm việc. `README.md` viết lại theo mô hình ba-token. Dựng `ChangeLog.md`,
`DevStatus.md`, `Legacy/README.md`. Tham chiếu treo trong `scripts/` vá cùng đợt.

**Vì sao.** Ba lớp chi phí đo được trong chính repo này: (1) mỗi lần rà soát, người và
agent phải mở lại 52 tệp của hai module đã chết chỉ để kết luận "bỏ rồi"; (2) cả ba tài
liệu-vào-đầu (`README.md`, `CLAUDE.md`, `DEVELOPER_GUIDE.md`) dẫn người đọc vào mô hình đã
bỏ, và mọi con trỏ "nguồn chân lý" trong mã đều treo vì `Specs/` không có trên nhánh này;
(3) các báo cáo testnet của module **còn sống** lại mô tả công thức **đã chết**
(`M = L×R×UM×PM/Q³`, "fire chuyển Treasury") — nguy hiểm hơn tài liệu chết hẳn vì trông
vẫn còn thời sự.

**Gãy gì nếu đang bám bản cũ.** Mọi đường dẫn `SnapshotGen/…` và `VacuumGen/…` đổi tiền
tố thành đường dẫn dưới `Legacy/…`. Bốn npm script biến mất khỏi `scripts/package.json`
(`test:snapshot`, `deploy:vacuum-vault`, `test:vacuum-commit`, `test:vacuum-fire`); hai
biến môi trường `VAULT_SNAPSHOT_HASH`, `VAULT_VACUUM_HASH` không còn ai đọc. Mã trong
`Legacy/` **không cài được** — `file:../../ProtocolUtils` sau khi dời giải ra một đường
không tồn tại; đó là dự tính.

**KHÔNG đổi (cố ý).** Variant `BatchSource::Snapshot`, `::Vacuum` và trường
`vacuum_orders` trong `VaultDatum` giữ nguyên vị trí — chúng là chỉ số constructor / arity
của Plutus Data đã lên chain, bỏ đi là vỡ decode mọi vault đã tạo. Hằng
`snapshot_base_rate_q` giữ nguyên vì ScheduleGen dùng thật. `UMKeeper/` **không** bị dọn:
UM vẫn nằm trong công thức thưởng của InstantGen DESIGN-2.

## 2026-08-09 — `@magiclamp/consumemagic-pricing` thành gói gọi được (ESM + CJS)

**Đổi gì.** `ConsumeMAGIC/pricing` (0.1.0 → 0.2.0) và `ProtocolUtils` (1.0.0 → 1.1.0) nay
build ra `dist/esm` + `dist/cjs` kèm `.d.ts`, khai báo qua `exports` có nhánh
`import`/`require`. Trước đó `main` trỏ thẳng `src/price.ts` và `"type": "module"`.

**Vì sao.** Bên tiêu thụ chạy Node CommonJS **không `require` được**, cũng không có
endpoint HTTP nào — nên mỗi bên phải **chép tay công thức**, và mỗi bản chép là một chỗ
trôi khỏi nguồn trong im lặng. Đã xảy ra thật một lần (AladinWork, báo về 2026-08-09).

**Gãy gì.** Bên nào đang `import` thẳng `…/pricing/src/price.ts` nên chuyển sang tên gói.
`src/` vẫn nằm trong `files` nên đường cũ chưa chết.

## 2026-08-09 — Neo danh tính vault từ lúc sinh (INV-VAULT-IDENTITY)

**Đổi gì.** Hai validator vault SỐNG (`InstantGen`, `ScheduleGen`) gộp thêm handler `mint`
vào chính `validator vault(...)`,
sinh một NFT one-shot lúc tạo vault (`asset_name = blake2b_256(cbor.serialise(seed))`,
policy = chính script hash); mọi nhánh `spend` đòi NFT còn nguyên, đúng tên. Genesis phải
sạch: mọi trường trạng thái tích luỹ rỗng/0, `lamp_balance` bằng đúng LAMP thật trong
output, `owner` nằm trong signatories. `lamp_asset_name` thành apply-param #2 của mọi vault.

**Vì sao.** Cardano chỉ chạy validator lúc **tiêu**, không bao giờ lúc **tạo**. Nên bất kỳ
ai cũng đặt được một UTxO ở địa chỉ script với datum bịa (`current_amount = 10^18`) rồi rút
MAGIC/LAMP thật. Lỗ này chặn mainnet, đã dựng được PoC.

**Gãy gì.** Chữ ký apply-param của cả hai vault đổi ⇒ **script hash đổi ⇒ địa chỉ đổi**.
Mọi vault tạo bằng bản cũ nằm ở địa chỉ khác. Off-chain **bắt buộc** phải mint NFT khi tạo
vault — không mint thì vault không spend được, LAMP kẹt vĩnh viễn.

**Chưa phủ.** `Consolidate/onchain/validators/vault_consolidate.ak` và
`ProfileChange/onchain/validators/vault_profile.ak` **không** có handler `mint` và **không**
kiểm NFT danh tính ở đâu cả (đếm được 0 tham chiếu). Hai module đó đang mồ côi và mang script
hash riêng nên chưa có tài sản nào đi qua chúng — nhưng ngày nào hội tụ (D4) thì phải nối
INV-VAULT-IDENTITY trước, không thì mở lại đúng lỗ 2-ADA-datum-bịa mà bất biến này sinh ra để
bịt. Bản ghi cũ ở đây viết "bốn vault", làm người rà tưởng đã phủ hết.

**KHÔNG ghim `profile`** trong genesis dù nó nằm trong datum: đó là lựa chọn chiến lược
của người dùng, không phải trạng thái tích luỹ; ghim vào sẽ chặn hết luồng chuẩn.

## 2026-08-09 — Bịt lỗ giá-về-0 và sàn-áp-sai-chỗ trong bộ định giá ConsumeMAGIC

**Đổi gì.** `required_for` (Aiken) và `requiredForOp` (TS) gộp-sàn-**một lần** cho cả tổng
thay vì sàn từng lượt rồi nhân. `valid_param` bắt buộc `m_min`/`m_max` đúng dải đã ghim và
`base_price × m_min ≥ Q` — **không có nhánh thoát cho `base_price == 0`**; dòng giá 0 bị từ
chối thẳng. (Bản ghi đầu ở đây viết `base_price == 0 || …`, sai: ai post beacon theo đó sẽ bị
từ chối không hiểu vì sao, còn ai "sửa mã cho khớp" thì mở lại lỗ giá-về-0.) `buildConsumeTx` đọc `base_price` từ beacon,
hết dùng hằng MVP trên đường tiền. Sổ `op_type` trong `CONTRACT.md` thành bảng 1..6.

**Vì sao.** Hai lỗi do bên tiêu thụ báo lên và dựng lại được: sàn áp trước khi nhân số lượt
làm lệch tích luỹ (mà bất biến on-chain là `Σburns == required`, dấu bằng, nên lệch một
nanogic là tx bị từ chối); và `base_price × m_min < Q` kéo giá về 0 ⇒ **nghiệp vụ chạy miễn
phí trong im lặng**, không bài kiểm nào đỏ.

**Gãy gì.** `PriceParam` có `m_min`/`m_max` ngoài dải ghim nay bị từ chối — beacon cũ phải
cập nhật trước khi mở nghiệp vụ mới. Bên nào đang giữ bản chép công thức riêng phải bỏ và
gọi gói (xem mục gói ở trên).
