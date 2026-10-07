# VaultTxAPI — dịch vụ DỰNG GIAO DỊCH CHƯA KÝ cho app di động

App là React Native trên Hermes. **Hermes không có WebAssembly**, mà bộ dựng giao dịch
(`@lucid-evolution/lucid`) là WASM — nên app không dựng nổi giao dịch tại chỗ. Dịch vụ này
là lớp trung gian: nó dựng, app ký, app nộp lại qua đây.

---

## 1. 🔴 Bất biến số một

**Dịch vụ KHÔNG BAO GIỜ giữ, đọc, nhận hay chạm vào vật liệu ký.** Nó trả về **CBOR của
một giao dịch CHƯA KÝ**; app ký trong Secure Enclave của máy, nơi khoá không rời khỏi.

Cụ thể, và kiểm được:

| điều được khẳng định | chỗ cưỡng chế |
|---|---|
| không tham số / biến môi trường / trường JSON nào là vật liệu ký | `tests/noSigningMaterial.test.ts` quét toàn bộ `src/**` + `tests/**` |
| không đường ký nào của lucid được gọi | cùng bài quét đó |
| ví của lucid là ví **chỉ-đọc** (`selectWallet.fromAddress`) | `src/txBuilder.ts` |
| chỉ `config.ts` chạm biến môi trường, và tập biến là danh sách **ĐÓNG** | cùng bài quét đó |
| bí mật duy nhất là **GIÁ TRỊ** khoá Blockfrost, không phải đường dẫn tới kho khoá | `src/config.ts` |

Bài quét ghép mẫu cấm **từ mảnh** thay vì viết thẳng chuỗi. Viết thẳng thì chính tệp kiểm
vi phạm phép quét của nó, và lối thoát duy nhất là loại tệp kiểm ra khỏi vùng quét — tức
tự đục một lỗ đúng bằng kích thước của thứ đang canh.

Ký là việc của app. Nộp thì đi qua `/tx/submit`, nơi dịch vụ **ghép** bộ chứng ký của app
vào thân giao dịch và **đối chiếu hash thân trước/sau** — không phải giả định nó không đổi.

---

## 2. 🔴 `summary` suy TỪ `tx_cbor`, không chép lại yêu cầu

App hiện `summary` cho người dùng đọc **trước khi họ ký**. Nếu `summary` dựng từ tham số
của chính yêu cầu thì nó **không chứng minh gì** về thứ sắp được ký: một máy chủ bị chiếm
dựng một giao dịch khác hẳn rồi kèm một `summary` đẹp đẽ chép lại đúng thứ người dùng vừa
nhập, và màn hình xác nhận trông y hệt lúc bình thường.

Nên mọi con số trong `summary` đi qua đúng một đường: **giải mã lại chính CBOR vừa dựng**.
Chữ ký của `summarizeTx` là chỗ ràng buộc đó được cưỡng chế — hàm **không nhận** tham số
yêu cầu nào để mà chép:

```ts
summarizeTx(txCborHex, { vaultAddress, inputVaultDatumHex, lampUnit, network, requestedIntent })
```

Thứ duy nhất đi vào ngoài CBOR là `inputVaultDatumHex` — datum của UTxO vault **đang bị
tiêu**, đọc từ chuỗi trước lúc dựng. Đó là dữ kiện của chuỗi, không phải thứ người gọi
khai. Không có nó thì chỉ nói được số tuyệt đối sau giao dịch, không nói được *khoá THÊM
bao nhiêu*.

`requested_intent` mang tên như thế vì nó là **nhãn của đường HTTP đã gọi**, thứ duy nhất
trong `summary` không suy từ CBOR. Mọi con số thì có.

### Phép đo cắn được

`tests/service.test.ts` ▸ *"summary KHÔNG phải tiếng vọng của yêu cầu"* bơm vào một tầng
dựng trả về giao dịch khoá `3 × λ` trong khi yêu cầu xin `17 × λ`, rồi đòi bản tóm tắt nói
`21 000 000` và **không** nói `119 000 000`.

Đã chạy phép đo đột biến, không chỉ đọc màu: thay `after` (datum trong output của giao
dịch) bằng `before` — tức bỏ đúng tính chất "suy từ CBOR" — thì **7 bài đỏ** trên hai tệp
kiểm. Hoàn nguyên thì 56/56 xanh.

---

## 3. Bề mặt HTTP

```
POST /tx/instant-gen       { owner, [owner_witness], change_address | fee_payer, m, [wakeme_vault_ref] }
POST /tx/refresh-checkpoint { owner, [owner_witness], change_address | fee_payer, [wakeme_vault_ref] }
POST /tx/schedule-commit   { owner, [owner_witness], change_address | fee_payer, schedule_length, lamp_per_epoch }
POST /tx/schedule-fire     { owner, [owner_witness], change_address | fee_payer, schedule_id }
POST /tx/consume           { owner, [owner_witness], change_address | fee_payer, op_type, op_count | pairs, [engage_ref], [wakeme_vault_ref] }
POST /tx/open-thread       { owner, [owner_witness], change_address }
POST /tx/bind-did          { owner, [owner_witness], [change_address], did_commit, [engage_ref] }
POST /tx/create-vault      { kind, owner, [owner_witness], lamp_amount, change_address | funding, [profile], [did_commit] }
POST /tx/submit            { tx_cbor, witness_cbor }
GET  /tx/status/{tx_hash}  — chỉ đọc: tx đã vào khối / ở mempool / chưa thấy, xem dưới
POST /tx/quote             { route, params, [owner_fee_addresses] } [X-Feecover-Token] — báo giá phí, xem dưới
POST /fee/utxo             { route }        [X-Feecover-Token]   — proxy ví trả phí, xem dưới
POST /fee/sign             { tx_cbor }      [X-Feecover-Token]
GET  /health
```

Chủ khoá được bỏ trống `change_address` (dịch vụ suy địa chỉ enterprise của khoá, §7); chủ
script thì phải gửi một trong hai trường.

### Một tiến trình, nhiều loại két: `vault_type`

Một khối triển khai chỉ phục vụ MỘT loại két (một ô `ref_script_utxos.vault`; bản `consume` —
kéo theo địa chỉ thread Engage và beacon giá — apply-param bằng hash của đúng loại két đó). Nạp
thêm khối phụ (§6, `VAULT_TX_API_EXTRA_DEPLOYMENT_FILES`) thì một tiến trình phục vụ cả Instant
lẫn Schedule. Yêu cầu được định tuyến tới khối (`src/blockRouter.ts` ▸ `VaultBlockRouter`):

| đường | khối |
|---|---|
| `create-vault` | theo `kind` (`instant` → Instant, `schedule` → Schedule) |
| `instant-gen`, `refresh-checkpoint` | Instant |
| `schedule-commit`, `schedule-fire` | Schedule |
| `consume`, `open-thread`, `bind-did` | trường TUỲ CHỌN `vault_type` (`"Instant"` \| `"Schedule"`) |
| `/tx/submit`, `/fee/*`, `/tx/sponsor/*` | khối chính (sổ phát-hành và khoá mềm dùng CHUNG giữa các khối) |

`consume` / `open-thread` / `bind-did`: có `vault_type` ⟹ đúng khối đó. Vắng ⟹ một khối thì như
trước; nhiều khối thì dịch vụ tra két của chủ ở từng khối — đúng một khối có két ⟹ khối đó; không
khối nào ⟹ khối chính (trả đúng lỗi hiện có, ví dụ `VAULT_NOT_FOUND`); nhiều khối ⟹
`409 VAULT_TYPE_AMBIGUOUS`, `details.vault_types` kê các loại có két, gửi lại kèm `vault_type`.
`open-thread` và `bind-did` cũng theo loại két vì thread Engage sống ở địa chỉ của bản `consume`
của loại két đó — mở thread ở khối sai là mở thread mà `/tx/consume` của két kia không thấy. Với
`/tx/quote`, `vault_type` nằm trong `params`. Chủ chưa có két mà gọi `open-thread` không kèm
`vault_type` thì thread mở ở khối CHÍNH.

`vault_type` sai giá trị ⟹ `400 VAULT_TYPE_INVALID`; loại không khối nào phục vụ ⟹
`400 VAULT_TYPE_NOT_SERVED`; gửi kèm đường có loại cố định mà trái loại đó ⟹
`400 VAULT_TYPE_ROUTE_CONFLICT`. Một khối thì đường có loại cố định trả lỗi như trước
(`400 BAD_REQUEST`, "không có địa chỉ vault nào được cấu hình cho loại …").

`/health` khai commit của mã đang chạy để bên gọi tự đối chiếu, khỏi hỏi người vận hành:
`commit` (40 hex), `commit_dirty` (cây có tệp track bị sửa tại chỗ ⟹ commit không đủ mô tả mã
chạy), `commit_source`. Commit ĐO bằng `git rev-parse HEAD` ở cây mã lúc khởi động, không nhận
qua biến môi trường (`src/buildInfo.ts`). Không đo được thì `commit: null`,
`commit_source: "unavailable"` kèm `commit_unavailable_reason` — không đoán.

`/health` còn khai tài sản LAMP mà bản deploy nướng vào mọi két, dạng máy đọc:
`"lamp": { "policy_id": "<56 hex>", "asset_name_hex": "<hex>" }` — cùng nguồn với bộ dựng
(khối `lamp` của tệp deploy), không gõ tay. App so `policy_id` này với policy LAMP mà két Wakeme
phát trước khi mở luồng Sinh MAGIC. `deployment_source` (nhãn chữ) giữ nguyên văn như cũ.

Nhiều khối: `vault_scopes` là HỢP địa chỉ két của mọi khối, khối chính trước — app mở lối
ScheduleGen khi thấy mục `vault_type: "Schedule"` ở đây. `deployment_source` vẫn là nhãn của
khối CHÍNH (app cũ dò mẫu trong chuỗi này); nhãn của mọi khối ở trường mới
`deployment_sources` (mảng, khối chính trước; một khối ⟹ mảng một phần tử). `lamp` không đổi:
mọi khối buộc cùng tài sản LAMP lúc khởi động.

`/health` còn khai GỐC KỲ giao thức, để app tính kỳ mà khỏi gõ cứng hằng theo mạng. Kỳ trên
chuỗi là `⌊(t − O) / P⌋` với `O = window_origin_ms`, `P = ms_per_epoch` — KHÔNG phải lưới Unix
`⌊t / P⌋` (lệch ~3.800 kỳ trên Preprod: t=1_790_553_600_000 là kỳ **316**, lưới Unix cho 4144).
`O` và `P` lấy từ `windowOriginMs` / `msPerEpoch` của `@magiclamp/protocol-utils` — CÙNG hàm mà
bộ dựng tx dùng để apply-param validator (`genV2.ts` ▸ `instantVaultParamsOf`), không có bản chép
thứ hai (`src/http.ts` ▸ `epochHealthFields`):

```jsonc
"epoch": {
  "origin_ms": "1654041600000",   // O — chuỗi số
  "ms_per_epoch": "432000000",    // P — chuỗi số
  "current": 316,                 // kỳ hiện tại theo GIỜ MÁY CHỦ (chỉ số kỳ nhỏ ⟹ số JSON)
  "start_ms": "1790553600000",    // O + current·P, ĐẦU kỳ (gồm mốc này)
  "end_ms": "1790985600000"       // O + (current+1)·P: kết thúc ĐỘC QUYỀN = start_ms của kỳ kế
}
```

Khoảng của kỳ là nửa mở `[start_ms, end_ms)`: `t = end_ms` đã thuộc kỳ kế. App tính kỳ cho một
mốc bất kỳ `t` bằng `⌊(t − origin_ms) / ms_per_epoch⌋` (chia sàn; `t < O` cho số âm) từ chính
hai trường này. Mạng không có gốc (**Preview**, `WIN-PREVIEW` — LAMP `Specs/Window/CONTRACT.md`
v1.0 §4) thì `/health` VẪN trả 200 nhưng khai tường minh, không đệm 0:
`"epoch": null, "epoch_unavailable_reason": "WINDOW_ORIGIN_UNAVAILABLE"`. Các đường dựng tx trên
mạng đó vẫn trả 501 cùng mã như trước.

Năm đường dựng trên vault có sẵn (`instant-gen`, `refresh-checkpoint`, `schedule-commit`,
`schedule-fire`, `consume`) trả:

```jsonc
{
  "tx_cbor": "84a4…",        // giao dịch CHƯA KÝ
  "tx_hash": "3f1c…",        // hash THÂN giao dịch — app đối chiếu sau khi ký
  "summary": { … },          // §2
  "expires_at": "2026-09-11T16:28:03.000Z", // = validTo của CHÍNH thân tx (ISO 8601) — xem dưới
  "expires_reason": "tx_validity",           // cận nào quyết validTo — xem dưới
  "server_time": "2026-09-11T16:13:03.412Z", // giờ dịch vụ lúc trả phản hồi (ISO 8601, mili-giây)
  "ignored": [],             // UTxO ở địa chỉ vault cố ý không tính, kèm lý do (trừ vault của chủ khác)
  "ignored_other_owner_count": 0, // vault của CHỦ KHÁC ở cùng địa chỉ — chỉ đếm, không liệt kê
  "required_signers": ["…"], // đọc từ required_signers của CHÍNH tx_cbor
  "witness_notes": ["…"]     // việc phải làm ngoài chữ ký (chủ script: mục rút did_stake…);
                             // dòng cuối luôn là dòng hạn (`validity.ts` ▸ `expiryNote`)
}
```

### Hạn của tx: một nguồn duy nhất, `validTo` trong thân tx

Từ 2026-10-06 mọi tx dịch vụ phát ra — kể cả `open-thread`, `bind-did`, `create-vault` đi đường
`change_address`, và các bước `/tx/sponsor/*` — đều mang `validTo` (ttl) trong thân. Đó là nguồn
hạn **duy nhất**: sổ cái từ chối tx sau mốc đó, nên mọi mốc khác dịch vụ khai ra đều suy từ nó.

- **Cận trên** (`src/validity.ts` ▸ `planValidity`): `validTo` = mốc SỚM nhất trong ba cận, căn
  xuống slot — `tip + VAULT_TX_API_TX_VALIDITY_MS` (mặc định `DEFAULT_TX_VALIDITY_MS` = 15 phút) ·
  cuối epoch hiện tại · `reserved_until` của UTxO ví trả phí lấy qua `/fee/utxo` (tra ở sổ
  phát-hành, `IssuedTxRegistry.feeReservationForBuild`). Giờ giữ chỗ đó đã qua, hoặc còn dưới một slot
  ⟹ `409 FEE_PAYER_RESERVATION_EXPIRED` (`details.reservation: "expired"`): xin lại `/fee/utxo` rồi
  dựng lại. UTxO ở địa chỉ Feecover (sổ nhớ mọi địa chỉ `/fee/utxo` đã trả) mà sổ KHÔNG còn lượt giữ
  — bộ quét 30 s đã dọn nó sau `reserved_until`, hoặc tx dùng nó đã bị thay — cũng ⟹ cùng mã 409
  (`reservation: "absent"`, `reserved_until: null`), KHÔNG dựng một tx không kẹp hạn. Ví trả phí không
  phải của Feecover (ví của chính chủ) không có giờ giữ chỗ.
- **`expires_at`** — `validTo` đọc NGƯỢC từ chính `tx_cbor` (`readTxExpiry`), dạng ISO 8601.
  Không còn là "lúc gọi + `VAULT_TX_API_LOCK_TTL_MS`".
- **`expires_reason`** — cận nào quyết `validTo`, kiểu `ExpiresReason` trong `src/validity.ts`:
  `tx_validity` (hạn ký cấu hình) · `epoch_end` (cuối epoch) · `fee_reservation` (giờ giữ chỗ
  Feecover) · `builder_cap` (`validTo` trong CBOR sớm hơn mọi cận đã lên kế hoạch — bộ dựng tự kẹp
  chặt hơn; suy ở `reasonOfValidTo`). Hoà nhau thì cận khai trước thắng theo đúng thứ tự trên.
- **`server_time`** — giờ của chính dịch vụ lúc trả phản hồi, ISO 8601 có mili-giây; có ở MỌI
  phản hồi mang `expires_at` (route dựng và `/tx/sponsor/*`), gắn ở `src/http.ts` ▸ `withServerTime`.
  Đồng hồ là `VaultTxService.serverNowMs` — cùng đồng hồ quyết `410 TX_EXPIRED` ở `/tx/submit`.
  App đừng so `expires_at` với đồng hồ điện thoại (máy để giờ nhanh vài phút sẽ thấy mọi bản dựng
  "đã quá hạn"); hạn trên máy = lúc nhận + (`expires_at` − `server_time`). Header `Date` chỉ tới
  giây và proxy có thể bỏ hoặc viết lại, nên không dùng làm nguồn.
- **Hết hạn phía dịch vụ** = `validTo + CLOCK_SKEW_MARGIN_MS` (biên lệch đồng hồ giữa dịch vụ và
  nút, `src/validity.ts`). Trong biên đó dịch vụ vẫn gửi tx và để nút phán. Quá biên, tx dịch vụ đã
  phát nhận `410 TX_EXPIRED` ở cả `/tx/submit` lẫn `/fee/sign`, cùng một hàm dựng
  (`src/locks.ts` ▸ `expiredErrorFor`):

  ```jsonc
  { "error": { "code": "TX_EXPIRED", "details": {
      "tx_hash": "…",
      "expired_at": "2026-10-06T02:15:00.000Z", // = validTo, cùng khuôn expires_at
      "rebuild_safe": true,    // tx chưa từng được gửi tới nút ⟹ dựng bản mới không thể ra hai tx
      "submission": "none"     // "accepted" | "unconfirmed" | "none" — như details.submission của 409
  } } }
  ```

  `rebuild_safe: false` ⟹ tx từng được gửi tới nút, có thể đã lên chuỗi trước mốc: tra chuỗi theo
  `tx_hash` trước khi dựng lại. Sổ phát-hành giữ dòng hết hạn thêm `EXPIRED_RETENTION_MS`
  (`src/locks.ts`); quá khoảng đó, hoặc tx chưa từng do dịch vụ phát ⟹ mã cũ của đường đó
  (`502 SUBMIT_REJECTED` ở `/tx/submit`, `403 FEE_PROXY_TX_NOT_ISSUED` ở `/fee/sign`).
- **Tx đã nộp mà không biết số phận** — tra `GET /tx/status/{tx_hash}` (mục ngay dưới). Quy tắc
  kết luận "tx không bao giờ lên chuỗi được": `state = "not_found"` **và** giờ hiện tại (tính theo
  `server_time` của chính phản hồi đó) > `expires_at`, cộng biên an toàn vài phút cho lệch đồng hồ.
- **`VAULT_TX_API_LOCK_TTL_MS` nay CHỈ là khoá mềm theo chủ** (§4) — không còn quyết `expires_at`,
  hạn sổ phát-hành hay hạn sổ input vừa nộp. Sổ input vừa nộp (`PendingSpends`) có biến riêng,
  `VAULT_TX_API_PENDING_SPENDS_TTL_MS`, đo theo độ trễ chỉ mục của nút đọc chứ không theo hạn ký.

### `GET /tx/status/{tx_hash}`: tx đã lên chuỗi chưa

Chỉ đọc: không khoá, không ghi sổ, không chạm `PendingSpends`. Cùng thẻ bài như các đường `/tx/*`
khác (nó tiêu hạn mức nhà cung cấp chuỗi của người vận hành, như `/tx/quote`). Tra **chuỗi trước,
rồi mempool** (`src/chain.ts` ▸ `BlockfrostChainReader.txStatus`: `/txs/{hash}` rồi `/mempool/{hash}`).

```jsonc
// 200 — tx đã vào khối
{ "tx_hash": "…", "state": "in_chain",
  "block": "<hash khối>", "slot": 108806400, "block_time": "2026-09-11T03:46:40.000Z" }
// 200 — đang ở mempool của nhà cung cấp
{ "tx_hash": "…", "state": "in_mempool" }
// 200 — chưa thấy ở đâu; tx do CHÍNH dịch vụ này phát ⟹ kèm expires_at + server_time
{ "tx_hash": "…", "state": "not_found",
  "expires_at": "2026-10-06T02:15:00.000Z", "server_time": "2026-10-06T02:20:01.123Z" }
```

- **`expires_at`** = `validTo` của thân tx, cùng nguồn với `expires_at` của các route dựng (sổ
  phát-hành `src/locks.ts` ▸ `IssuedTxRegistry.validToOf`). Có khi tx do tiến trình này phát và sổ
  còn dòng — kể cả khi đã quá hạn, trong `EXPIRED_RETENTION_MS`. Vắng ⟹ dịch vụ không biết hạn của
  tx này (không do nó phát, dòng đã quá khoảng giữ lại, hoặc tiến trình đã khởi động lại — sổ nằm
  trong bộ nhớ). Vắng `expires_at` thì **không** kết luận được "tx chết" từ `not_found`.
- **`server_time`** đi kèm `expires_at` (`http.ts` ▸ `withServerTime`), như mọi phản hồi khác.
- **`block_time`** ISO 8601 (Blockfrost trả giây POSIX; đổi đơn vị ở `blockTimeSecondsToPosixMs`).
- **Mempool là của nhà cung cấp.** Blockfrost chỉ thấy tx nộp qua chính nó; dịch vụ nộp qua đúng
  nhà cung cấp đó, nên tx nộp qua `/tx/submit` hiện ra. Tx nộp qua đường khác có thể ra `not_found`
  cho tới khi vào khối — lại là lý do quy tắc kết luận phải chờ qua `expires_at`.
- `tx_hash` không phải đúng 64 hex thường (kể cả vắng: `/tx/status`, `/tx/status/`) ⟹
  `400 TX_HASH_INVALID`, không gọi chuỗi.
- Nhà cung cấp lỗi / quá giờ / hết hạn mức / trả hình dạng lạ ở bước nào ⟹
  `502 TX_STATUS_PROVIDER_UNAVAILABLE` (`details.stage` = `chain` | `mempool`, kèm
  `node_http_status` / `transport`). **Không bao giờ** thành `not_found`: chỉ hai câu 404 của nhà
  cung cấp (`/txs` rồi `/mempool`) mới ra `not_found`.

### Gen v2.0: `summary.gen` trên mọi đường dựng vault

`summary.gen` đọc năm ô sinh từ datum ĐẦU RA giải mã lại từ `tx_cbor` (`summary.ts` ▸
`TxSummary.gen`), không từ tham số yêu cầu:

```jsonc
"gen": {
  "cap_epoch": "1234",          // két Schedule ⟹ null (ô đó không tồn tại ở két Schedule)
  "cap_nanogic": "750750000",   // két Schedule ⟹ null
  "wakeme_link": "",            // "" = chưa ghim két Wakeme; két Schedule ⟹ null
  "usage_window_epoch": "1234",
  "usage_factor_q": "1000000000" // `usageFactorQ(usage_window)` của instantgen-sdk, Q = 10⁹
}
```

### `POST /tx/instant-gen`: `m` do chủ chọn, trần `max_m`

Từ Gen v2.0 lượng sinh `m` (nanogic) là **bắt buộc** và do chủ chọn; validator chỉ ép TRẦN.
`m` là CHUỖI chữ số thập phân `> 0` — vắng / số JSON / không phải chữ số / `"0"` ⟹
`400 INSTANT_GEN_M_INVALID`. Dịch vụ đọc beacon ρ, beacon GreenBack, sổ két và shard GB của
két MỘT lần, tính `max_m` bằng `@magiclamp/instantgen-sdk` ▸ `instantGenLimits` trên đúng các
UTxO đó rồi giao chúng xuống bộ dựng (`genV2.ts`). `m > max_m` ⟹ `422 INSTANT_GEN_M_ABOVE_MAX`
kèm `details.max_m` và `details.m` — bộ dựng không được gọi. App chưa biết `max_m` thì hỏi
`POST /tx/quote` route `instant-gen` KHÔNG gửi `m` (hoặc `"0"`): báo giá dựng tại `m = max_m` và
trả trần trong `summary.gen_limits` (xem §Báo giá). Đường dựng thật vẫn đòi `m`. Dựng xong,
`summary.gen_limits`:

```jsonc
"gen_limits": {
  "max_m_nanogic": "750750000",
  "remaining_after_nanogic": "746750000",  // max_m − lượng đúc đọc từ CBOR (âm ⟹ 422 TX_SUMMARY_UNDECODABLE)
  "l_lent_oildrop": "0",
  "gen_so_far_nanogic": "0",
  "cap_nanogic": "750750000",
  "cap_lamp_nanogic": "4004000000",
  "gb_available_nanogic": "1000000000000000",
  "checkpoint_refreshed": true             // lượt này làm mới checkpoint ⟹ beacon ρ vào tx
}
```

Cần khối `gen_v2` và `ref_script_utxos.gb_shard` trong bản deploy (§6); thiếu ⟹
`501 CONFIG_MISSING` với `details.missing` nêu đúng khoá. Mạng chưa có két Wakeme ⟹
`501 WAKEME_VAULT_UNAVAILABLE` (apply-param #8 của két không có giá trị).

**Két cũ chưa nối két Wakeme (`wakeme_link` rỗng): chạy RefreshCheckpoint trước.** Từ
2026-10-03 lượt sinh (và lượt tiêu) **không nối link** được nữa (`checkpoint.ak` ▸
`resolve_link`, luật 6): két IG link rỗng mà kèm `wakeme_vault_ref` trỏ tới một két Wakeme
không ghim két này ⟹ `422 WAKEME_LINK_CHANGE_REJECTED`, bộ dựng không được gọi. Lượt nối đầu
chỉ qua genesis (`did_commit` ở `/tx/create-vault`) hoặc `POST /tx/refresh-checkpoint` kèm
`wakeme_vault_ref`; xong thì gọi lại `instant-gen`. Bỏ `wakeme_vault_ref` thì lượt sinh vẫn
chạy với `L_lent = 0`. Ngoại lệ duy nhất: lượt sinh làm mới checkpoint mà két Wakeme đưa vào
đang ghim chính két này (`L_lent > 0`) — validator nhận, dịch vụ cũng nhận. `/tx/consume` thì
không có ngoại lệ đó (bộ dựng consume không tính `L_lent`), nên ở đó luôn RefreshCheckpoint trước.

### `POST /tx/refresh-checkpoint`

Chủ ký, két Instant làm mới năm ô checkpoint (`cap_epoch`, `cap_nanogic`, `usage_window`,
`usage_window_epoch`, `wakeme_link`) mà không sinh/tiêu gì. Luôn đọc beacon ρ (vắng trên
chuỗi ⟹ `502 CHAIN_UNAVAILABLE`, không dựng). `wakeme_vault_ref` có ⟹ ghim/giữ két Wakeme đó;
vắng ⟹ gỡ ghim (`wakeme_link := ""`). Cần khối `gen_v2` (thiếu ⟹ `501 CONFIG_MISSING`).

### `POST /tx/consume` trên két Instant sang epoch mới

Lượt tiêu đầu tiên trong epoch mới (`cap_epoch < e`) của két Instant làm mới checkpoint ở nhánh
BurnBatch ⟹ tx cần beacon ρ ở reference input (vắng ⟹ `502 CHAIN_UNAVAILABLE`), và két Wakeme
nếu két đã nối link (`wakeme_link` khác ""). Ca đó mà thân bài không kèm `wakeme_vault_ref` thì
dịch vụ tự định vị két (mục `wakeme_vault_ref` dưới); không tìm thấy két nào ⟹
`400 WAKEME_VAULT_REF_REQUIRED` (`details.wakeme_link`, `details.located_count`), không dựng một
tx chắc chắn chết. Cùng
epoch, hoặc két Schedule ⟹ không đọc gì thêm (ScheduleGen không đọc két Wakeme).

### `POST /tx/consume` nhiều loại nghiệp vụ trong MỘT tx: `pairs`

Thân bài nhận **một trong hai** dạng: cặp đơn `"op_type": 1, "op_count": "2"`, hoặc `pairs`. Ví dụ
một tác vụ OriLife dùng bốn mã nghiệp vụ:

```json
{ "owner": { "type": "key", "hash": "<56 hex>" }, "fee_payer": { … },
  "pairs": [ { "op_type": 1, "op_count": "1" }, { "op_type": 2, "op_count": "1" },
             { "op_type": 3, "op_count": "1" }, { "op_type": 4, "op_count": "3" } ] }
```

Luật (nguồn duy nhất: `assertValidPairs`, gương `pricing.valid_pairs` on-chain; ánh xạ mã ở
`src/consumeLine.ts`): 1..8 cặp (`MAX_CONSUME_PAIRS`); `op_type` là số nguyên JSON trong
[0, 1000000], **tăng ngặt** — trùng loại thì gộp `op_count` lại; `op_count` là **chuỗi** chữ số ≥ 1.
Gửi `pairs` cùng `op_type`/`op_count` ⟹ `400 CONSUME_PAIRS_CONFLICT`: dịch vụ không chọn hộ bên
nào thắng. Mọi lỗi hình dạng ra 400 TRƯỚC khi giữ khoá chủ và trước khi đọc chuỗi.

**`required` của ConsumeMany = Σ sàn TỪNG cặp** (`requiredFromBeaconPairs`, gương
`required_for_pairs`) — KHÁC quy tắc gộp-rồi-sàn của Consume đơn. Hai quy tắc lệch tới (n−1)
nanogic, và validator đòi `Σburns == required` (dấu bằng). Bài Emulator
(`MagicSDK/tests/sponsorJourney.test.ts`, khối ConsumeMany) chọn giá lẻ để hai quy tắc lệch đúng
1 nanogic: két đốt theo gộp-rồi-sàn ⟹ validator từ chối; đốt theo sàn-từng-cặp ⟹ qua.

**`pairs` đúng MỘT phần tử ⟹ dựng `Consume` đơn (constr 0)**, không dựng ConsumeMany một cặp: kế
toán giống hệt (một cặp sàn một lần ở cả hai quy tắc), còn chi phí thì không. Đo 2026-10-03 trên
Emulator (script `consume` + vault Prepaid chạy thật, cùng op 2 × 1, tổng mọi redeemer của tx):

| redeemer | byte tx | mem | steps |
|---|---|---|---|
| `Consume` (constr 0) | 1.193 | 1.698.217 | 608.679.596 |
| `ConsumeMany` 1 cặp (constr 3) | 1.199 | 1.795.933 | 638.418.101 |
| `ConsumeMany` 4 cặp (op 1–4) | 1.217 | 2.152.109 | 755.134.607 |

Bài đo khẳng định ConsumeMany một cặp đắt hơn ở cả ba trục; số đo lật chiều thì bài đỏ và quyết định
này phải xét lại. Bên gọi không phải rẽ nhánh: `summary.consume` luôn in `pairs` dạng danh sách.

**`summary.consume`** đọc lại TỪ CBOR (`checkConsumeTx`), cho MỌI lượt tiêu — cả cặp đơn:
`redeemer` (`Consume` | `ConsumeMany`), `pairs`, `required_nanogic`/`required_magic`,
`engage_input_ref`. Phép đọc lại ép: thread là input và mang đúng một redeemer Spend; redeemer
đúng dạng + đúng các cặp đã yêu cầu, `vault_ref` = két đang tiêu, `price_ref` trong
`reference_inputs`; đúng một output ở địa chỉ engage, mang NFT thread, value bảo toàn tuyệt đối;
datum thread giữ chủ, `consumed_count` tăng Σ `op_count`, `consumed_nanogic` tăng `required` > 0
và bằng `magic.burned_nanogic` của két. Lệch ⟹ `422 CONSUME_TX_MISMATCH`, không có tx nào để ký.

**Trần số lô đốt trong MỘT tx tiêu.** Redeemer `BurnBatch { burns }` có một mục cho mỗi lô bị
đốt, và `apply_burns` duyệt toàn bộ danh sách lô cho mỗi mục, nên chi phí ExUnit tăng theo tích
số lô × số mục. Bộ dựng của SDK giới hạn số mục ở `MagicSDK/src/burnBatch.ts` ▸
`MAX_BURN_ENTRIES_PER_TX` (giá trị, phép đo và phần CHƯA ĐO nằm ở chú thích của chính hằng đó —
đừng chép số xuống đây). Chọn lô: đốt lô sắp hết hạn trước; cách đó cần quá trần thì đổi sang lô
lớn trước (ít mục nhất); vẫn quá trần ⟹ `422 CONSUME_TOO_MANY_BATCHES`, ném TRƯỚC khi dựng tx,
`details` = `{ burn_entries_needed, burn_entries_cap, live_batches }`. App rẽ nhánh theo mã này để
gợi ý chia lượt tiêu nhỏ hơn. Lô còn sống mà số dư đã về 0 (két Instant giữ lô đốt sạch tới hết
epoch) không thành mục đốt — validator đòi mỗi mục `amt > 0`.

### `POST /tx/schedule-commit`: validator `commit`

Nhánh ký của két Schedule v2.0 uỷ cho validator withdraw-zero `commit`, và lượt commit đọc
beacon ρ + beacon GreenBack + sổ két, TIÊU shard GB. Cần khối `gen_v2`,
`ref_script_utxos.commit` và `ref_script_utxos.gb_shard`; thiếu khoá nào ⟹ `501 CONFIG_MISSING`
với `details.missing` nêu đúng khoá đó. Stake credential của `commit` phải được đăng ký trước
(`buildRegisterCommitStakeTx` của SDK) — dịch vụ không dựng lượt đăng ký.

### `wakeme_vault_ref`: két Wakeme cho mượn LAMP

Két InstantGen v2.0 đọc `(owner_commit, L_lent)` từ **đúng một** két Wakeme nằm trong
**reference inputs** của giao dịch — két có `gen_vault` (datum trường 11) ghim chính vault
này — ở lượt làm mới checkpoint và ở nhánh sinh. Không két ⟹ `L_lent = 0`, hợp lệ; hai két
trở lên ⟹ chuỗi từ chối. Mã đọc: `@magiclamp/instantgen-sdk` ▸ `explainWakemeVault` (gương
`checkpoint.ak` ▸ `wakeme_lent.ak` ▸ `wakeme_read`). Trường này nhận ở `instant-gen`,
`refresh-checkpoint` và `consume`.

- **Có** `"wakeme_vault_ref": "<tx_hash 64 hex>#<i>"` ⟹ dịch vụ dùng đúng UTxO đó (ưu tiên), kiểm
  trước khi dựng: mạng có két Wakeme (`@magiclamp/protocol-utils` ▸ `wakemeVaultHash`), UTxO còn
  sống, nằm ở script két, datum đọc được. Vế nào hỏng thì trả lỗi có mã (bảng dưới), không dựng
  một tx mà chuỗi sẽ từ chối.
- **Vắng**, két IG **đã nối link** (`wakeme_link` = `owner_commit` của DID chủ két) ⟹ dịch vụ
  **tự định vị** két Wakeme bằng NFT định danh `(policy = wakeme_vault_hash, name = wakeme_link)`
  — tra theo đơn vị tài sản, chi phí theo MỘT két, không quét địa chỉ script dùng chung. Chỉ giữ
  UTxO có payment credential = script két Wakeme (validator lọc reference input đúng như thế).
  Tìm thấy 1 ⟹ đọc + kiểm như trên, `summary.wakeme.source = "located"`; 2 trở lên ⟹
  `409 WAKEME_VAULT_AMBIGUOUS` (`details.candidates`); 0 ⟹ `reason: "wakeme_vault_not_found"`,
  trừ khi lượt này làm mới checkpoint (validator đòi két) ⟹ `400 WAKEME_VAULT_REF_REQUIRED`.
- **Vắng**, két IG chưa nối link ⟹ không két nào, `L_lent = 0`,
  `summary.wakeme = { lent_lamp: "0", counted: false, reason: "vault_not_linked" }`.
- `refresh-checkpoint` cố ý **không** tự định vị: ở đường đó vắng `wakeme_vault_ref` mang nghĩa
  "gỡ ghim" (`wakeme_link := ""`).

Ba ca chuỗi **cho qua với `L_lent = 0`** thì dịch vụ cũng cho qua, nhưng nói ra:

```jsonc
"summary": {
  …,
  "wakeme": {
    "ref": "<tx_hash>#<i>",
    "lent_lamp": "500000000",   // oildrop, chuỗi — đúng con số validator tính
    "counted": true
    // "source": "located"         chỉ khi dịch vụ tự định vị (app không gửi ref)
    // counted: false ⟹ lent_lamp: "0" và "reason":
    //   "not_pinned_to_this_vault"  két chưa ghim vault này (kèm "seen_pin", null = chưa ghim) —
    //                               KHÔNG còn là lỗi 409: chủ két IG nối link trước, két Wakeme ghim sau
    //   "pinned_in_current_period"  két ĐỔI ghim sang vault này trong chính kỳ đang sinh
    //   "lamp_short_of_datum"       value két giữ ít LAMP hơn conditional + owned của datum
    //   "wakeme_vault_not_found"    tự định vị không thấy két nào (không có "ref")
    //   "vault_not_linked"          két IG chưa nối link, app không gửi ref (không có "ref")
  }
}
```

Dịch vụ đọc lại `tx_cbor`: két phải nằm trong `reference_inputs` và không nằm trong `inputs`
(lệch ⟹ `422 WAKEME_VAULT_TX_MISMATCH`). `lent_lamp`/`counted` là dữ kiện chuỗi đọc trước lúc
dựng — CBOR chỉ mang tham chiếu, không mang nội dung reference input.

### Chủ vault: `owner`, và bí danh `owner_pkh`

Chủ là một `Credential`, hai dạng:

```jsonc
"owner": { "type": "key",    "hash": "<56 hex thường>" }   // khoá thanh toán
"owner": { "type": "script", "hash": "<56 hex thường>" }   // script — hiện là did_stake của PhoenixKey
"owner": { "type": "did",    "did": "did:…" }              // DID — dịch vụ tự suy Script(did_stake), xem dưới
```

`owner_pkh: "<56 hex>"` vẫn nhận, và nghĩa là đúng `{ "type": "key", "hash": owner_pkh }`.
Gửi cả hai mà chúng chỉ hai chủ khác nhau ⟹ `400 OWNER_ALIAS_MISMATCH`. Hai chủ cùng 28 byte
khác tag là **hai chủ khác nhau**: không vault nào của người này khớp yêu cầu của người kia,
và khoá mềm (§4) cũng tách riêng.

**Chủ script cần nhân chứng.** Validator đòi giao dịch rút từ tài khoản thưởng `Script(h)`.
Dịch vụ không ký và không giữ khoá, nên nó chỉ dựng được mục rút đó khi có đủ hai thứ:

1. cấu hình triển khai có mục `did_stake` (§6) — thiếu ⟹ `501 OWNER_SCRIPT_WITNESS_UNAVAILABLE`;
2. yêu cầu mang `owner_witness` — thiếu ⟹ `400 OWNER_SCRIPT_WITNESS_UNAVAILABLE`:

```jsonc
"owner_witness": {
  "did_stake_script_cbor": "…",          // did_stake ĐÃ apply tham số của DID này
  "anchor_ref": "<tx_hash 64 hex>#<i>",  // UTxO anchor DID, đi vào tx làm reference input
  "controller_pkh": "<56 hex>",
  "device_key_hash": "<56 hex>"
}
```

Script app gửi **không được tin**: dịch vụ băm lại, lệch `owner.hash` ⟹ `400
OWNER_AUTH_MISMATCH`. Anchor phải mang một NFT anchor (tên 32 byte, số lượng 1) dưới
`anchor_nft_policy` của mạng, không ⟹ `400 OWNER_ANCHOR_INVALID`; token shard/cursor của
`taad` cùng policy KHÔNG phải anchor. Thứ tự kiểm: đọc anchor TRƯỚC, so hash SAU — nên một
yêu cầu sai cả hai nhận `OWNER_ANCHOR_INVALID`. Tài khoản thưởng chưa đăng
ký ⟹ `422 OWNER_STAKE_NOT_REGISTERED`. Lượng rút là **đúng số dư thưởng lúc dựng** (ledger
đòi vậy), nên một ranh giới epoch có cộng thưởng xen giữa dựng và nộp làm tx hết hợp lệ —
dựng lại. Validator từ chối tx mang chứng chỉ đăng ký / huỷ đăng ký / uỷ thác cho chính
`Script(h)` — đó là hình dạng tx thu hồi, nên đổi vòng đời stake phải nằm ở tx riêng. Trạng
thái Active của anchor **không** kiểm ở đây: lược đồ datum anchor thuộc repo
danh tính, và `did_stake` từ chối trên chuỗi nếu anchor không Active.

Chủ khoá mà gửi `owner_witness` ⟹ `400 OWNER_WITNESS_UNEXPECTED`.

#### Chủ khai bằng DID: `owner: { "type": "did" }` — app chỉ gửi DID

Mọi hành động MAGIC ký bằng khoá DID PhoenixKey; chủ vault trên chuỗi là `Script(did_stake)`
(`InstantGen/onchain/lib/magiclamp/protocol/owner_auth.ak` ▸ `owner_authorized`). App không phải
tự dựng `owner_witness`:

```jsonc
"owner": { "type": "did", "did": "did:…", "device_key_hash": "<56 hex>" }   // device_key_hash tuỳ chọn
```

Dịch vụ suy, ở ĐẦU mỗi đường dựng và TRƯỚC khi giữ khoá mềm (`src/didOwner.ts` ▸ `DidOwnerResolver`):
tên NFT anchor = `blake2b_256(utf8(did))` · đọc UTxO đang giữ `anchor_nft_policy ‖ tên` · đọc datum
inline như `TAADDatum` 18 trường (PhoenixKey-Validator ▸ `lib/phoenixkey/types.ak` @ `c9050b9`:
`controller_pkh` #2, `status` #5 với Active = constructor 0, `device_pkh` #14, `aux_device_pkhs` #15)
· script = `did_stake` chưa apply (cấu hình, §6) apply `(anchor_nft_policy, tên)`. Kết quả giao cho
CÙNG đường nhân chứng với chủ script tường minh ở trên — mọi phép kiểm sau đó (NFT anchor, tài khoản
thưởng đã đăng ký, `required_signers`) là một đường mã. Một yêu cầu `{type:"did"}` và cùng yêu cầu viết
tường minh ra **cùng `tx_cbor` từng byte** và cùng khoá mềm `script:<hash>` (bài
`tests/didOwner.test.ts` ▸ *TƯƠNG ĐƯƠNG*). Thân trả về: `owner` là `Script(hash)` đã suy,
`summary.owner_did` là DID đã khai, `required_signers` là controller + khoá thiết bị đã chọn.

- `device_key_hash` vắng ⟹ `device_pkh` chính của anchor; có thì phải là `device_pkh` hoặc nằm trong
  `aux_device_pkhs`, không ⟹ `400 OWNER_DEVICE_NOT_LISTED`.
- `did` phải bắt đầu bằng `did:`, chỉ ký tự ASCII in được không khoảng trắng, 5..256 byte ⟹ không thì
  `400 OWNER_DID_SHAPE`. Kèm `owner_witness` hoặc `owner_pkh` ⟹ `400 OWNER_DID_CONFLICT` (hai nguồn cho
  một chủ, chọn một bên là đoán).
- Anchor: không có ⟹ `422 OWNER_ANCHOR_NOT_FOUND`; nhiều hơn một UTxO giữ NFT ⟹ `422
  OWNER_ANCHOR_AMBIGUOUS`; datum không phải Constr đúng 18 trường đúng kiểu ⟹ `422 OWNER_ANCHOR_SCHEMA`
  (lược đồ bên PhoenixKey đổi thì lỗi kêu ở đây, không dựng trên trường đọc nhầm chỗ); không Active ⟹
  `422 OWNER_ANCHOR_NOT_ACTIVE`. Với chủ DID, trạng thái Active **được** kiểm lúc dựng — khác chủ script
  tường minh ở trên.
- Bản deploy không khai `did_stake.unapplied_script` ⟹ `501 OWNER_SCRIPT_WITNESS_UNAVAILABLE`; chủ script
  tường minh vẫn chạy.
- Mọi đường nhận `owner` đều nhận dạng DID: bảy đường `/tx/*`, `/tx/quote` (qua `params`),
  `/tx/create-vault`, và `/tx/sponsor/*` (kể cả `plan`, cần dịch vụ tài trợ bật để suy).

**Điều kiện TRƯỚC khi tạo vault: `did_stake` phải ĐÃ ĐĂNG KÝ làm stake credential.** Genesis cũng gọi
`owner_authorized` (`InstantGen/onchain/validators/vault.ak` ▸ nhánh mint `MintVaultId`, dòng `expect owner_authorized(tx, vd.owner)` của genesis), nên tx tạo
vault đã cần mục rút `Script(h)`, và mục rút chỉ hợp lệ trên tài khoản đã đăng ký. Đăng ký **không gộp
được** vào tx của vault: `owner_auth` từ chối tx mang chứng chỉ vòng đời stake cho chính `Script(h)`,
và ledger xử lý mục rút TRƯỚC chứng chỉ nên một tx "đăng ký + rút" vẫn rút trên tài khoản chưa có.
Đăng ký là một tx riêng do máy chủ PhoenixKey dựng ngay sau genesis DID (cọc do PhoenixKey trả);
chưa đăng ký ⟹ dịch vụ này trả `422 OWNER_STAKE_NOT_REGISTERED` như trước.

**Ai ký.** Dịch vụ không ký gì. App đưa `tx_cbor` cho PhoenixKey ký bằng controller + khoá thiết bị đã
chọn — đúng hai khoá trong `required_signers` của thân trả về.

**Đối chiếu phép suy.** Máy chủ PhoenixKey có `GET /api/v1/identity/{did}/stake-script-hash`, trả hash
`did_stake` ĐÃ apply cho từng DID; nó phải bằng `owner.hash` mà dịch vụ này trả cho cùng DID. Lệch ⟹
`did_stake.unapplied_script` của bản deploy không cùng đời với bên PhoenixKey.

**`change_address`**: chủ khoá bỏ trống thì dịch vụ suy theo chiến lược ở §7 như trước. Chủ
script **bắt buộc** gửi (`400 CHANGE_ADDRESS_REQUIRED`) — một script hash không suy ra được ví
nào. Gửi thì địa chỉ phải đúng mạng và phần thanh toán phải là khoá (`400
CHANGE_ADDRESS_INVALID`): UTxO trả phí + tài sản thế chấp lấy từ đó, nên khoá ấy cũng phải ký.

### `POST /tx/create-vault`

```jsonc
// vào
{
  "kind": "instant" | "schedule",
  "owner": { "type": "key" | "script", "hash": "…" },   // hoặc bí danh owner_pkh
  "owner_witness": { … },                               // chỉ chủ script
  "lamp_amount": "1001000000",                          // CHUỖI oildrop: > 0 két schedule, ≥ 0 két instant
  "did_commit": "<64 hex thường>",                      // chỉ két instant, tuỳ chọn ⟹ wakeme_link của datum genesis
  "change_address": "addr_test1…",                      // ĐÚNG MỘT trong change_address / funding
  "funding": { … },                                     // nạp từ ví Phoenix — xem dưới
  "profile": "Ember" | "Flame" | "Lantern"              // bỏ trống = Flame
}
// ra 200
{
  "tx_cbor": "…", "tx_hash": "…",
  "vault_nft": "<policy><asset_name>",      // NFT danh-tính one-shot, đúc trong chính tx này
  "vault_address": "addr_test1w…",
  "owner": { "type": "…", "hash": "…" },
  "required_signers": ["…"],                // đọc từ tx_cbor
  "witness_notes": ["…"],
  "summary": {
    "requested_intent": "create_vault", "network": "Preview",
    "fee_lovelace": "…", "fee_ada": "…",
    "vault": { "address": "…", "output_index": 0, "nft_unit": "…", "owner": { … },
               "lamp_deposit_oildrop": "…", "lamp_deposit_lamp": "…", "lovelace": "…", "ada": "…",
               "wakeme_link": "" },                // két instant: "" hoặc did_commit đọc lại từ CBOR; két schedule ⟹ null
    "required_signers": ["…"], "outputs": [ … ]
  },
  "expires_at": "…"
}
```

Bộ dựng là `@magiclamp/sdk` ▸ `createVault`, với script vault lấy từ ref-script của bản deploy
(`ref_script_utxos.vault`) và băm lại để so với địa chỉ vault đã cấu hình. `summary` đọc thẳng
output vault trong `tx_cbor`: đúng một output ở địa chỉ vault, mang đúng 1 NFT, NFT được đúc
trong chính tx, trường 0 của datum là `Credential`, `lamp_balance` bằng LAMP trong output. Sau
đó dịch vụ đối chiếu chủ trong datum với `owner` yêu cầu và lượng LAMP với `lamp_amount`; lệch
⟹ `422 TX_SUMMARY_UNDECODABLE`, không phát tx. `kind` không có vault tương ứng trong cấu hình
⟹ lỗi cấu hình, không chọn đại một địa chỉ.

**Két instant của người mới** (chỉ có PersonDID + LAMP mượn ở két Wakeme): `lamp_amount: "0"`
hợp lệ với `kind: "instant"` (két schedule vẫn đòi `> 0`, sai ⟹ `400 LAMP_AMOUNT_INVALID`);
output két khi đó không mang LAMP. `did_commit` (64 hex thường, tuỳ chọn, CHỈ két instant —
gửi cho schedule ⟹ `400 DID_COMMIT_UNEXPECTED`) được ghi vào ô `wakeme_link` của datum genesis,
để két Wakeme của DID đó ghim được két này. `summary.vault.wakeme_link` đọc lại TỪ CBOR (két
schedule ⟹ `null`); lệch `did_commit` ⟹ `422 TX_SUMMARY_UNDECODABLE`.

Trước khi dựng két instant, dịch vụ đọc địa chỉ két: chủ đã có két instant, hoặc (khi gửi
`did_commit`) đã có két nối đúng DID đó ⟹ `409 VAULT_ALREADY_EXISTS` với
`details.existing: [{ vault_ref, vault_nft, matched_by: "owner" | "did_commit" }]`, bộ dựng
không được gọi. Đây là lưới an toàn của DỊCH VỤ (chống bấm hai lần), **không** phải cổng chống
Sybil — `INV-ONE-PERSON-ONE-VAULT` chưa được ép on-chain; tx tạo két vừa nộp mà chưa vào khối thì
phép đọc này không thấy (khoá mềm theo chủ, §4, chặn ca đó ở lúc NỘP: tx tạo két thứ hai, dựng trước
khi tx thứ nhất được nộp, nhận `409 TX_SUPERSEDED`).

#### Nguồn LAMP: `change_address` (đường cũ) hoặc `funding` (ví Phoenix)

Không có `funding` ⟹ hành vi cũ: LAMP, phí và tài sản thế chấp lấy từ UTxO ở `change_address`,
tiền thối về đó.

Có `funding` ⟹ LAMP đến từ ví Phoenix, một địa chỉ **script** `did_payment`. Tài sản thế chấp
không được là UTxO script, nên phí + thế chấp buộc phải từ một ví khoá ký thứ hai (mô hình
bên trả phí):

```jsonc
"funding": {
  "type": "did_payment",
  "did_payment_script_cbor": "<hex>",      // did_payment ĐÃ apply (anchor_nft_policy, blake2b_256(utf8(did)))
  "address": "addr_test1w…",               // ví Phoenix: payment credential = Script(hash của cbor trên)
  "fee_payer": {
    "utxo": "<tx_hash 64 hex>#<i>",        // ĐÚNG MỘT UTxO thuần ADA: trả phí + thế chấp + seed NFT
    "address": "addr_test1v…"              // địa chỉ khoá ký chứa UTxO đó
  },
  // Ba trường dưới: chủ SCRIPT có owner_witness ⟹ bỏ trống, dùng chung bộ của owner_witness
  // (khai thì phải TRÙNG). Chủ KHOÁ ⟹ BẮT BUỘC (did_payment vẫn đòi anchor + hai chữ ký).
  "anchor_ref": "<tx_hash 64 hex>#<i>",
  "controller_pkh": "<56 hex>",
  "device_key_hash": "<56 hex>"
}
```

Vai của từng ví, và dịch vụ ĐỌC LẠI từ `tx_cbor` rằng giao dịch đúng như thế (lệch bất kỳ vế
nào ⟹ `422 FUNDING_TX_MISMATCH`, không phát tx):

| | ví Phoenix (`funding.address`) | ví trả phí (`fee_payer`) |
|---|---|---|
| input | UTxO `did_payment`, mỗi cái redeemer `Spend` = `Constr 0 []` (`d87980`), script đính inline | đúng `fee_payer.utxo` |
| chọn UTxO | tiền tố ngắn nhất của dãy sắp theo LAMP giảm dần đủ LAMP + min-ADA phần thối của chính nó (tối thiểu với riêng vế LAMP; có vế ADA thì là tham lam) | không chọn — chỉ UTxO đã khai |
| trả cho | LAMP của output vault — **không lovelace nào** | phí + **ứng** min-ADA output vault mới (trọn lovelace output đó, tới trần `fee_payer_fronting_max_lovelace`); là tài sản thế chấp |
| tiền thối | LAMP / token khác, **trọn** lovelace của các UTxO đã chi, cộng mục rút `did_stake` nếu chủ là script ⟹ **về `funding.address`**, không bao giờ về ví trả phí | ADA thối + `collateral_return` ⟹ về `fee_payer.address`; ví này góp đúng `phí + khoản ứng + thối` |
| reference input | anchor DID (Active) | — |
| ký | controller + khoá thiết bị | khoá thanh toán của `fee_payer.address` |

Output nào khác ba địa chỉ vault / `funding.address` / `fee_payer.address` ⟹ `422`. Hạn dùng
(`validTo`) ≤ 1 giờ kể từ đỉnh chuỗi lúc dựng. Dịch vụ **không** gọi dịch vụ trả phí nào — nó
chỉ nhận UTxO của bên trả phí qua tham số.

**`change_address` cùng `funding` ⟹ `400 FUNDING_CHANGE_ADDRESS_CONFLICT`.** Ở đường cũ
`change_address` gánh ba vai (nguồn LAMP, nguồn phí, đích tiền thối); `funding` đã tách ba vai
đó ra hai địa chỉ có tên. Nhận thêm `change_address` là nhận một địa chỉ không có vai nào — chọn
nghĩa cho nó là đoán ý người gọi, và đoán sai là thối tiền về một ví không ai khai.

`summary` có thêm khối `funding` (mọi số là chuỗi):

```jsonc
"funding": {
  "type": "did_payment", "address": "addr_test1w…",
  "did_payment_inputs": ["<tx>#<i>", …],                       // UTxO ví Phoenix bị chi
  "spent":    { "lovelace": "…", "lamp_oildrop": "…", "other_assets": [ … ] },  // tổng chi
  "returned": { "lovelace": "…", "lamp_oildrop": "…", "other_assets": [ … ] },  // thối về ví Phoenix
  "withdrawal_lovelace": "…",                                  // mục rút did_stake (chủ script), đã tính vào phần thối
  "fee_payer": { "address": "…", "utxo": "…", "input_lovelace": "…", "fee_lovelace": "…",
                 "change_lovelace": "…", "collateral_return_lovelace": "…" | null },
  "valid_to_posix_ms": "…"
}
```

**Thứ tự ký.** Mọi chữ ký ký trên hash THÂN giao dịch (`tx_hash`):

1. Dịch vụ dựng; thân giao dịch trả về là bản **chốt**.
2. Ví Phoenix ký bằng controller + khoá thiết bị (và, nếu chủ là khoá, khoá chủ).
3. Bên trả phí ký UTxO của họ bằng khoá thanh toán của `fee_payer.address`.
4. Ghép mọi chứng ký rồi `/tx/submit`.

Bước 2 và 3 đổi chỗ cho nhau được; điều không được là **đổi thân sau khi đã có chữ ký**: đổi
một byte của thân (kể cả để "sửa phí") là đổi `tx_hash`, và mọi chữ ký đã có mất hiệu lực —
phải dựng lại, không vá.

#### Ví Phoenix tự trả phí: `funding.fee_source = "did_payment"` (opt-in)

`fee_source` vắng hoặc `"fee_payer"` ⟹ đúng như trên. `"did_payment"` ⟹ ví Phoenix trả **mọi
thứ** — LAMP, min-ADA của vault và **phí**; tiền thối về `funding.address`. Ví khoá của người
dùng chỉ **đứng thế chấp** (ledger cấm thế chấp là UTxO script, nên vẫn cần một ví khoá ký):

```jsonc
"funding": {
  "type": "did_payment",
  "did_payment_script_cbor": "<hex>",
  "address": "addr_test1w…",
  "fee_source": "did_payment",
  "collateral": {
    "utxo": "<tx_hash 64 hex>#<i>",        // ĐÚNG MỘT UTxO thuần ADA, không script tham chiếu: CHỈ làm thế chấp
    "address": "addr_test1v…"              // địa chỉ KHOÁ chứa UTxO đó; nhận collateral_return
  },
  "anchor_ref": "…", "controller_pkh": "…", "device_key_hash": "…"   // như trên
}
```

Hai chế độ loại trừ nhau về TRƯỜNG: `fee_source: "did_payment"` kèm `fee_payer`, hoặc chế độ
mặc định kèm `collateral` ⟹ `400 FUNDING_SHAPE` (một trường không có vai là dấu người gọi đang
tưởng mình ở chế độ kia). `fee_source` khác hai giá trị trên ⟹ `400 FUNDING_SHAPE`.
`collateral.address` không phải khoá / sai mạng, hoặc UTxO không ở đó / không thuần ADA ⟹
`400 FUNDING_COLLATERAL_INVALID`.

| | ví Phoenix (`funding.address`) | ví thế chấp (`collateral`) |
|---|---|---|
| input | UTxO `did_payment` đã chọn — **không input nào khác** | không input tiêu nào; chỉ `collateral_inputs` = `collateral.utxo` |
| seed NFT két | tên NFT = `blake2b_256(cbor(seed))` với seed là **một UTxO did_payment bị chi** | — |
| trả cho | LAMP + min-ADA vault + phí | không đồng nào (trừ khi script thất bại: mất phần thế chấp) |
| tiền thối | mọi phần dư ⟹ về `funding.address` | chỉ `collateral_return`; **không output nào** về ví này |
| ký | controller + khoá thiết bị | khoá thanh toán của `collateral.address` (input thế chấp đòi chữ ký) |

Phép đọc lại CBOR của chế độ này (`funding.ts` ▸ `checkSelfFundedTx`) ném `422
FUNDING_TX_MISMATCH` khi: có input ngoài tập did_payment đã biết (kể cả UTxO của ví thế chấp) ·
tên NFT két không băm từ đúng một input did_payment · thế chấp không phải `collateral.utxo` hoặc
`collateral_return` không về `collateral.address` hoặc lượng có thể mất vượt
`fee_payer_collateral_lovelace` · có output về ví thế chấp hay địa chỉ lạ · bảo toàn lệch
(`did_payment chi + mục rút = vault (trừ NFT) + thối + phí`) · thiếu chữ ký controller/thiết bị ·
hạn dùng quá 1 giờ.

`summary.funding` ở chế độ này KHÔNG có khối `fee_payer`; thay bằng:

```jsonc
"self_funded": {
  "fee_source": "did_payment",
  "seed_utxo": "<tx>#<i>",                  // một phần tử của did_payment_inputs
  "fee_lovelace": "…",                      // phí đọc từ CBOR, trả từ ví Phoenix
  "collateral": { "address": "…", "utxo": "…",
                  "collateral_at_risk_lovelace": "…",       // Σ collateral_inputs − collateral_return
                  "collateral_return_lovelace": "…" | null }
}
```

**Giới hạn của Lucid Evolution 0.4.30 — vì sao bộ dựng đi hai lượt.** `complete()` dùng MỘT địa
chỉ cho cả tiền thối lẫn `collateral_return`. Đặt nó là `funding.address` thì thối đúng chỗ nhưng
`collateral_return` rơi vào ví Phoenix; đặt là ví thế chấp thì phần dư bị thối sang ví thế chấp.
Nên SDK (`MagicSDK/src/createVault.ts` ▸ `completeSelfFunded`) dựng hai lượt, cả hai không tự chọn
coin và chỉ cho lucid thấy đúng `collateral.utxo`: lượt ĐO với địa chỉ thối = ví Phoenix để lấy
phí, rồi lượt THẬT với địa chỉ thối = ví thế chấp và output thối về ví Phoenix ghi TƯỜNG MINH =
phần dư − phí đo (bù chênh độ dài địa chỉ; hụt vài byte thì cộng dần, tối đa 4 lượt). Hình dạng
cuối được SDK đọc lại (`assertSelfFundedShape`) rồi dịch vụ đọc lại lần nữa (`checkSelfFundedTx`).
Việc CHỌN UTxO did_payment giữ chỗ phí bằng `DID_PAYMENT_FEE_HEADROOM_LOVELACE` (3 ADA — biên an
toàn, không phải số đo); phí đo vượt phần giữ chỗ ⟹ `422 FUNDING_INSUFFICIENT`.

`/tx/quote` không áp cho chế độ này (không có ví trả phí nào để báo giá) ⟹ `400
FEE_QUOTE_SELF_FUNDED`; phí thật nằm ở `summary.funding.self_funded.fee_lovelace`.

### Ví trả phí bên thứ ba: `fee_payer`

Năm đường dựng trên vault có sẵn (`instant-gen`, `refresh-checkpoint`, `schedule-commit`,
`schedule-fire`, `consume`), cùng `open-thread`, `bind-did`, `create-vault` két instant
`"lamp_amount": "0"` và bốn bước tài trợ `/tx/sponsor/*`, nhận `fee_payer` thay cho
`change_address`. Người dùng mới chưa có ADA nào đi được trọn đường bằng ví trả phí:

```jsonc
"fee_payer": {
  "utxo": "<tx_hash 64 hex>#<i>",   // ĐÚNG MỘT UTxO thuần ADA của ví trả phí
  "address": "addr_test1v…",        // địa chỉ khoá ký chứa UTxO đó
  "reservation_id": "<32 hex>"      // tuỳ chọn: mã lượt giữ /fee/utxo trả (§3 ▸ Proxy phí ▸ reservation_id)
}
```

UTxO đó trả phí và làm tài sản thế chấp; tiền thối ADA và `collateral_return` về đúng
`fee_payer.address`. Lượng thế chấp đặt **tường minh** bằng `fee_payer_collateral_lovelace`
của cấu hình (§6), và cũng là trần mà phép đọc lại ép lên phần thế chấp có thể mất. Dịch vụ
đọc lại `tx_cbor` (input, output, thế chấp, hạn dùng) và trả `summary.fee_payer`; lệch ⟹
`422 FEE_PAYER_TX_MISMATCH`, không phát tx. Ví trả phí chỉ được mất đúng **phí cộng khoản ứng
min-ADA** (mục dưới); input khác ngoài UTxO trả phí chỉ được đến từ địa chỉ của chính luồng đó
(địa chỉ vault, địa chỉ engage), không từ ví nào khác.

- `fee_payer` cùng `change_address` ⟹ `400 FEE_PAYER_CHANGE_ADDRESS_CONFLICT`.
- `/tx/create-vault` nhận `fee_payer` ở gốc thân bài **chỉ** cho két `instant` với
  `"lamp_amount": "0"` và không kèm `funding` (tx không cần LAMP của ai); mọi ca khác ⟹
  `400 FEE_PAYER_UNSUPPORTED`. Két có LAMP nạp nhận ví trả phí qua `funding.fee_payer` như cũ.
- `/tx/open-thread` và `/tx/bind-did` nhận `fee_payer`. Open-thread: UTxO trả phí là input duy
  nhất, ví trả phí ứng trọn lovelace của output thread. Bind-did: input chỉ là UTxO trả phí và
  thread của chủ ở địa chỉ engage; value thread giữ nguyên nên không có khoản ứng.
- Chủ `Script(did_stake)` mà tài khoản thưởng đang có số dư R > 0: nhân chứng chủ rút TRỌN R, và qua
  ví trả phí thì tiền thối về ví trả phí. Nên dịch vụ quyết TRƯỚC khi dựng (`feePayer.ts` ▸
  `planOwnerRewardReturn`):
  - suy được ví Phoenix của chủ (địa chỉ BASE: payment = `did_payment` đã apply, stake = chính
    `did_stake` của chủ; `didOwner.ts` ▸ `didPaymentAddressFor`) và R ≥ min-ADA của một output thuần
    ADA ở đó ⟹ tx có thêm ĐÚNG MỘT output R lovelace, không datum, tới ví đó; phép đọc lại CBOR đòi
    mục rút đúng R và output đó đúng R (`checkOwnerRewardReturn`). Phản hồi có
    `summary.fee_payer.owner_reward` = `{ reward_address, withdraw_lovelace, did_payment_address,
    output_index }`, và `witness_notes` có một dòng nêu R;
  - R < min-ADA đó ⟹ `422 FEE_PAYER_OWNER_REWARD_BELOW_MIN_ADA` (`details`: `withdraw_lovelace`,
    `min_lovelace`, `did_payment_address`). Ví trả phí KHÔNG ứng phần thiếu, vì phần ứng vào ví riêng
    của chủ tiêu tự do được;
  - không suy được ví Phoenix (bản deploy thiếu `did_stake.did_payment_unapplied_script` hoặc
    `did_stake.unapplied_script`, hoặc anchor của nhân chứng không phải anchor của chủ) ⟹ `422
    FEE_PAYER_OWNER_REWARD_NONZERO`, `details.missing` nêu thiếu gì. Không chuyển thưởng tới một
    đích đoán.

  Trạng thái kỹ thuật của đường Feecover (2026-10-06): với route khác `create_vault`, luật L9 của
  Feecover hiện từ chối output thưởng này, nên `open_thread` / `bind_did` có thưởng R > 0 dựng qua
  Feecover vẫn bị từ chối ở bước Feecover ký, cho tới khi luật đó nhận output về ví Phoenix của chủ.
  Phần của dịch vụ này (dựng + đọc lại CBOR) không phụ thuộc luật đó.

#### Khoản ứng min-ADA: ví trả phí trả trước tiền ký quỹ của output két/thread

Một output trên Cardano phải giữ đủ min-ADA, tính theo số byte của nó. Người dùng mới không có
ADA, nên ví trả phí **ứng** khoản đó cho ĐÚNG MỘT output mang NFT két/thread của chính chủ, tới
trần `fee_payer_fronting_max_lovelace` của cấu hình (§6; vắng ⟹ 5 ADA; `"0"` tắt hẳn). Phép đọc
lại CBOR đo khoản ứng:

- output mang NFT vừa đúc trong cùng tx (tạo két, mở thread) ⟹ khoản ứng = toàn bộ lovelace của
  output đó;
- output tiếp nối một két đã có ⟹ khoản ứng = lovelace output − lovelace input của két đó (datum
  lớn lên thì min-ADA tăng theo).

Khoản ứng vượt trần ⟹ `422 FEE_PAYER_FRONTING_ABOVE_MAX` (`details.fronted_lovelace`,
`details.fronted_max_lovelace`, `details.output_index`), không phát tx. `summary.fee_payer.fronted_lovelace`
ghi khoản đã ứng. Khoản ứng nằm lại trong output của chủ, không về ví trả phí: thread không có
nhánh nào nâng value sau khi mở, và két instant không có nhánh đóng.

**Ngoại lệ thứ hai, chỉ ở các đường két: shard `gb_shard` dùng chung.** Nhánh sinh tiêu một shard
GreenBack rồi dựng lại nó; lượt sinh đầu trên một shard làm datum dài ra và đòi thêm min-ADA (đo
2026-10-04 trên Preprod: 73.270 lovelace). Trên đường chủ tự trả thì chủ trả phần đó, nên qua ví trả
phí thì ví trả phí ứng — chỉ cho output ở `gen_v2.gb_shard_address` mang đúng một NFT shard mà input
mang cùng NFT cũng ở đó (shard dựng lại, không phải output mới), mỗi output ≤ cùng trần trên.
`summary.fee_payer.shared_fronted_lovelace` + `shared_fronted_outputs` tách riêng phần này;
`fronted_lovelace` là tổng. Khoản ứng nằm lại trong shard, là chi phí vĩnh viễn của bên trả phí.

Số đo min-ADA (CML `min_ada_required`, `coinsPerUtxoByte` 4310; địa chỉ script không stake /
có stake), để chọn trần:

| output | không stake | có stake |
|---|---|---|
| két instant genesis (datum 178 B) | 2.129.140 | 2.249.820 |
| két instant, 1 lô MAGIC | 2.499.800 | 2.620.480 |
| két instant, 8 lô | 4.430.680 | 4.551.360 |
| két instant, 16 lô | 6.637.400 | 6.758.080 |
| két instant, 32 lô (`MAX_BATCHES_PER_VAULT`) | 11.055.150 | 11.175.830 |
| két instant chạm trần datum (3187 B) | 15.119.480 | 15.240.160 |
| thread genesis | 1.361.960 | 1.482.640 |
| thread chạm trần | 1.607.630 | 1.728.310 |

Thread mở với `ENGAGE_MIN_LOVELACE` = 2.000.000, cao hơn min-ADA của nó ở trần, nên mở thread ứng
đúng 2 ADA và không bao giờ phải ứng thêm. Két instant genesis cần 2,13–2,25 ADA, dưới trần mặc
định; sau đó mỗi lô MAGIC thêm vào datum nâng min-ADA khoảng 0,37 ADA (1 lô − genesis = 370.660
lovelace), và lượt dựng chỉ ứng đúng phần chênh đó. Ca vượt trần nhận `422` có số cụ thể.
Không đặt sàn lovelace lúc tạo két: phủ trần datum ngay từ đầu là khoá ~13 ADA mỗi két mà không
có nhánh nào trả lại.

**Ví trả phí không nhất thiết là Feecover.** Một UTxO thuần ADA trên **địa chỉ khoá của chính
chủ** dùng được làm `fee_payer` (hoặc `funding.fee_payer`), cùng luật như trên. Khi đó không cần
Feecover: app tự ký phần ví trả phí bằng khoá của chủ, **không** gọi `/fee/sign` (đường đó xin
Feecover ký cho một UTxO không phải của Feecover).
`POST /tx/quote` báo trước UTxO của chủ có đủ không (`owner_address.available`) và chọn sẵn
UTxO đó (`owner_address.fee_payer`).

### Báo giá phí: `POST /tx/quote`

```jsonc
// vào
{ "route": "consume",                       // một trong tám đường dựng
  "params": { "owner_pkh": "…", "op_type": 1, "op_count": "2" },   // đúng thân bài của đường đó,
                                                                   // KHÔNG kèm fee_payer / funding.fee_payer
  "owner_fee_addresses": ["addr_test1v…", "addr_test1q…"] }        // tuỳ chọn: 1..10 địa chỉ khoá của chủ
// ra (số minh hoạ)
{ "feecover":      { "fee_lovelace": "175016", "fronted_lovelace": "0", "available": true },
  "owner_address": { "fee_lovelace": "172552", "fronted_lovelace": "0", "available": true,
                     "needed_lovelace": "3969750",
                     "collateral_lovelace": "3000000",
                     "fee_payer": { "utxo": "0e0e…0e#2", "address": "addr_test1v…" } },
  "fee_sources": {                                  // NGUYÊN ba khối của Feecover GET /v1/fee-sources
    "owner_address": { "available": true, "requires_app_check": true, "user_pays": "network_fee_ada", "message": "…" },
    "feecover":      { "available": true, "user_pays": "carp", "payer_proof_required": false },
    "sponsor":       { "available": true, "user_pays": "nothing", "budget_remaining_24h_lovelace": "…",
                       "did": { "owner_commit": "<64 hex>", "remaining_24h_lovelace": "…", "remaining_txs_24h": 3 } } },
  "valid_until": "2026-09-27T10:03:00.000Z" }
```

**Route `instant-gen`: báo giá được khi chưa biết `m`.** `params.m` vắng hoặc `"0"` ⟹ báo giá
dựng tại `m = max_m` (trần còn lại của epoch, tính như đường dựng thật). Phản hồi của route này
có thêm khối `summary`, lấy từ lượt dựng đầu:

```jsonc
"summary": {
  "m_nanogic": "4000000",        // lượng đúc đọc lại TỪ CBOR của lượt dựng báo giá
  "m_source": "max_m",           // "max_m" = người gọi không gửi m; "request" = m người gọi gửi
  "gen_limits": { "max_m_nanogic": "…", "remaining_after_nanogic": "…", … }   // y khối gen_limits ở trên
}
```

`max_m = 0` mà không gửi `m` ⟹ `422 INSTANT_GEN_MAX_M_ZERO` (kèm trần trong `details`): không có
`m > 0` nào dựng được, và báo giá trên một `m` bịa là con số phí cho một giao dịch không tồn tại.

Dịch vụ chạy **đúng đường dựng** của `route` với `params` cộng một `fee_payer` do nó chèn, rồi
đọc phí lại **từ CBOR** như `summary`. Báo giá **không** giữ khoá của chủ, **không** giữ chỗ
UTxO nào, **không** ghi sổ phát-hành (tx của báo giá không nộp được, không xin ký được),
**không** xin Feecover UTxO hay chữ ký — không `/v1/utxo`, không `/v1/sign`, nên hỏi giá không
làm cạn kho UTxO của Feecover. Lượt gọi Feecover duy nhất là câu hỏi `GET /v1/fee-sources`
(dưới đây), vốn không giữ chỗ.

- **`feecover`** — dựng trên một UTxO **tổng hợp** (không có trên chuỗi; lucid đánh giá script
  cục bộ từ UTxO được đưa). `fee_lovelace` là **ước lượng chặn trên**: UTxO tổng hợp lấy địa chỉ
  base (dài hơn enterprise), lượng và chỉ số output có mã hoá rộng nhất, khoá khác khoá chủ. Đo
  (lucid 0.4.30): cao hơn phí thật trên một ví enterprise chỉ số nhỏ tối đa 3 168 lovelace, không
  thấp hơn theo các trục đó (trục chưa ghim: địa chỉ con trỏ); số đo + cách đo lại ở khối chú thích `SYNTH_*` trong `src/feeQuote.ts`.
  - **Nguồn của `available`: chính Feecover.** Dịch vụ tra mục đích của `route` trong bảng
    `feecover.apps.magic.purposes` (cùng bảng `/fee/utxo` dùng), rồi hỏi
    `GET <feecover.url>/v1/fee-sources?purpose=<mục đích>` với `Authorization: Bearer
    <FEECOVER_APP_TOKEN>`, hết giờ `min(feecover.timeout_ms, FEE_SOURCES_TIMEOUT_MS = 3 000 ms)`.
    Câu trả lời `{ purpose, feecover: { available, rule?, message? } }` được chuyển **nguyên**:
    `available`, và `rule` / `message` khi Feecover gửi. Feecover không giữ chỗ UTxO cho câu hỏi
    này. Lượt dựng đầu chạy trước: `params` hỏng thì Feecover không bị hỏi.
  - **Fail-closed:** `available=true` **chỉ** khi Feecover trả 200, đúng hình dạng, đúng mục đích
    đã hỏi, và `feecover.available === true`. Mọi lối khác là `available=false` kèm `reason`:

    | `reason` | khi nào | trường kèm |
    |---|---|---|
    | `FEE_QUOTE_FEECOVER_DECLINED` | Feecover trả lời `available: false` (ví dụ `rule: "L14"`, cửa sổ Catalyst) | `rule`, `message` nếu Feecover gửi |
    | `FEE_QUOTE_FEECOVER_UNCONFIGURED` | bản deploy không khai `feecover` | — |
    | `FEE_QUOTE_FEECOVER_NO_DEFAULT_APP` | không có ứng dụng mặc định `magic` | — |
    | `FEE_QUOTE_FEECOVER_TOKEN_ABSENT` | có ứng dụng `magic` nhưng dịch vụ không cầm token của nó | — |
    | `FEE_QUOTE_FEECOVER_PURPOSE_UNMAPPED` | ứng dụng `magic` chưa có mục đích cho `route` | — |
    | `FEE_QUOTE_FEECOVER_PURPOSE_FOREIGN` | mục đích mang tiền tố của ứng dụng khác | — |
    | `FEE_QUOTE_FEECOVER_TIMEOUT` | Feecover không trả lời trong hạn | — |
    | `FEE_QUOTE_FEECOVER_UNREACHABLE` | không gọi được (DNS, TCP, TLS…) — câu lỗi thư viện không chuyển | — |
    | `FEE_QUOTE_FEECOVER_HTTP_STATUS` | Feecover trả mã khác 200 | `upstream_status`; với 4xx thêm `rule`, `message` nếu có |
    | `FEE_QUOTE_FEECOVER_BAD_RESPONSE` | 200 nhưng thân không phải JSON, thiếu/sai kiểu `feecover.available`, `rule`/`message` không phải chuỗi, hoặc `purpose` khác mục đích đã hỏi | — |

    Năm lý do cấu hình (`UNCONFIGURED` tới `PURPOSE_FOREIGN`) quyết tại chỗ, Feecover **không**
    bị hỏi.
    Token không đi vào phản hồi: một `rule`/`message` của Feecover chứa token thì câu trả lời 200
    bị coi là `BAD_RESPONSE`, còn ở 4xx thì hai trường đó bị bỏ.
  - Phí vẫn có khi `available=false`.
  - `fronted_lovelace` (chuỗi thập phân) — xem mục **`fronted_lovelace`** ngay dưới khối này; cùng số ở hai nguồn.
- **`owner_address`** — nguồn trả phí là **ví khoá của chính chủ**.
  - `needed_lovelace` là lượng tối thiểu một UTxO thuần ADA phải có để tx dựng được với nó làm
    `fee_payer`: `max(phí + khoản ứng, thế chấp) + min-ADA` (khoản ứng = 0 trừ đường có khoản ứng
    min-ADA, mục ví trả phí ở trên), suy từ cách lucid chọn input trả phí và thế chấp
    trên cùng một UTxO (không cộng dồn phí với thế chấp: hai khoản không bị thu cùng lúc). Mỗi
    địa chỉ có ngưỡng riêng (phí phụ thuộc độ dài địa chỉ), tính bằng một lượt dựng tổng hợp ở
    đúng địa chỉ đó.
  - `collateral_lovelace` **luôn có**: trần thế chấp bản deploy đặt cho ví trả phí
    (`VAULT_TX_API_DEPLOYMENT.fee_payer_collateral_lovelace`) — khoản UTxO trả phí mất nếu script chết ở
    pha 2. Là cấu hình, không đọc từ tx.
  - `owner_fee_addresses`: mảng 1..10 địa chỉ, không trùng, mỗi phần tử phải là địa chỉ khoá
    đúng mạng. Dịch vụ đọc UTxO ở mọi địa chỉ (chỉ đọc) rồi **chọn** theo quy tắc:
    1. chỉ UTxO **thuần ADA, không script tham chiếu** — UTxO mang token bị bỏ qua dù lớn đến đâu;
    2. chỉ UTxO có lovelace ≥ `needed_lovelace` **của chính địa chỉ chứa nó**;
    3. chọn UTxO **nhỏ nhất** còn lại (giữ UTxO lớn cho việc khác);
    4. hoà lovelace ⟹ địa chỉ đứng trước trong mảng; cùng địa chỉ ⟹ `tx_hash` nhỏ hơn, rồi chỉ số
       output nhỏ hơn (so theo **số**: `#9` trước `#10`).
  - Chọn được ⟹ `available=true`, `fee_lovelace` là phí của lượt dựng với chính UTxO đó, và
    `fee_payer` = `{ "utxo": "<tx_hash>#<i>", "address": "<địa chỉ chứa UTxO>" }` — đúng hình dạng
    thân `fee_payer` của đường dựng, app chép thẳng. `fee_payer` **chỉ có** khi `available=true`.
  - Không chọn được ⟹ `available=false`, không `fee_payer`; `fee_lovelace` và `needed_lovelace` là
    số **lớn nhất** qua mọi địa chỉ (một UTxO thuần ADA cỡ đó gửi tới địa chỉ nào trong mảng cũng
    đủ). Lý do: `FEE_QUOTE_OWNER_ADDRESSES_ABSENT` (không gửi mảng, hoặc mảng rỗng — hai con số là
    của ví tổng hợp, một ước lượng), `FEE_QUOTE_OWNER_NO_ADA_UTXO` (không địa chỉ nào có UTxO thuần
    ADA), `FEE_QUOTE_OWNER_INSUFFICIENT` (có UTxO thuần ADA nhưng không cái nào đủ ngưỡng).
  - Dùng UTxO đó làm `fee_payer`: app **tự ký** phần ví trả phí bằng khoá của chủ, **không** gọi
    `/fee/sign`. Báo giá không giữ chỗ UTxO: giữa lúc hỏi và lúc dựng, UTxO có thể đã bị tiêu.
- **`fronted_lovelace`** — có ở **cả** `feecover` lẫn `owner_address`: min-ADA mà ví trả phí phải
  **ứng** cho output két / thread mới (và phần shard GreenBack dùng chung dựng lại). Là chi phí
  chìm của bên trả phí: két không có nhánh nào trả lovelace ra. App cần số này để biết ví trả
  phí phải có bao nhiêu **ngoài phí** (nó đã nằm trong `needed_lovelace`, vế `phí + khoản ứng`).
  - Đọc lại **từ CBOR** của lượt dựng báo giá, bằng đúng hàm đường dựng thật dùng
    (`summary.fee_payer.fronted_lovelace`; create-vault: `summary.funding.fee_payer.fronted_lovelace`)
    — không có công thức thứ hai.
  - **Luôn có**, kể cả `available=false` (lượt dựng nào cũng đọc được nó). `"0"` là số đo thật:
    route không ứng output nào (ví dụ `consume`, `schedule-commit`). Trường không bao giờ vắng
    để thay cho `"0"`.
  - `owner_address.available=true` ⟹ số của lượt dựng với UTxO đã chọn; `false` ⟹ số lớn nhất
    qua các ngưỡng đã đo (hoặc của ví tổng hợp khi không gửi địa chỉ). Khoản ứng không phụ thuộc
    ví trả phí là ai, nên hai nguồn cùng số.
  - Cũng như phí, là số **lúc hỏi giá**: số thật là `summary.fee_payer.fronted_lovelace` của lượt dựng.
- **`valid_until`** — hạn ngắn nhất giữa hạn dùng (`validTo`) của tx trong CBOR và `expires_at`
  mà đường dựng trả, qua mọi lượt dựng của lần hỏi. Báo giá không sống lâu hơn tx nó mô tả.
- **`fee_sources`** — ba phương thức trả phí cho cửa sổ chọn nguồn của app, **nguyên** như Feecover
  trả ở `GET /v1/fee-sources` (cùng lượt hỏi với khối `feecover`, không giữ chỗ UTxO nào).
  - **Vắng giữ vắng.** Trường Feecover không gửi (`rule`, `message`, `sponsor.did`…) thì không có
    trong khối — không bao giờ thành `null`, không đệm. Trường Feecover thêm sau này đi qua nguyên.
  - **Chủ khai bằng DID** (`params.owner = { "type": "did", … }`) ⟹ dịch vụ hỏi kèm
    `owner_commit` = tên anchor của DID (`blake2b_256(utf8(did))`), Feecover báo thêm
    `sponsor.did` (suất sponsor 24 giờ còn lại của DID đó). Chủ khoá thường không gửi `owner_commit`.
    Chủ không có DID: Feecover từ chối nguồn sponsor theo luật L38 **lúc ký** (`/fee/sign` ⟹ `/v1/sign`,
    nơi Feecover thấy chủ trong tx). `/fee/utxo` không gửi chủ nào nên lúc xin UTxO Feecover chưa biết
    chủ là ai — dịch vụ không thêm cổng riêng.
  - **Ứng dụng hỏi Feecover = ứng dụng của `/fee/*`.** Báo giá đọc tiêu đề `X-Feecover-Token` đúng như
    `/fee/utxo` / `/fee/sign`: vắng ⟹ ứng dụng mặc định `magic`; có ⟹ ứng dụng khai `token_sha256` đó,
    mục đích tra trong bảng của ứng dụng đó, token chuyển tiếp nguyên. Token không khớp ứng dụng nào
    (kể cả chuỗi rỗng, kể cả token `magic` gửi qua tiêu đề) ⟹ `401 FEE_PROXY_APP_UNKNOWN`, Feecover
    không bị hỏi — cùng mã với `/fee/*`, vì đó là lỗi của người gọi chứ không phải "nguồn không có".
  - **Không hỏi được Feecover** (bản deploy không khai, hết giờ, lỗi mạng, mã khác 200, thân sai) ⟹
    `feecover` và `sponsor` = `{ "available": false, "reason": "<FEE_QUOTE_FEECOVER_*>", "message": "…" }`
    (4xx của Feecover có `rule` thì kèm `rule`), báo giá **vẫn** trả 200 với số phí. `owner_address`
    là ví của chủ, không qua Feecover: Feecover không gửi khối này thì dịch vụ tự dựng cùng hình dạng
    (`feeQuote.ts` ▸ `OWNER_ADDRESS_SOURCE`).
  - Feecover trả lời mà **không** có khối `sponsor` (bản Feecover trước nguồn sponsor) ⟹ `sponsor` =
    `{ available: false, reason: "FEE_QUOTE_SPONSOR_NOT_REPORTED", message }`; khối `sponsor` sai hình
    dạng hoặc chứa token ⟹ `reason: "FEE_QUOTE_FEECOVER_BAD_RESPONSE"` — chỉ riêng khối đó, khối
    `feecover` vẫn dùng được.
  - **Giá CARP: dịch vụ không đặt ra số nào.** Khối `feecover` có trường giá thì đi qua nguyên. Bản
    Feecover hiện tại không định giá (sổ Feecover ghi `repayTcarp` = `null`), nên khối không có trường
    giá — app hiện "chưa có giá", không tự tính. Nhãn hiển thị là việc của app: trên testnet Feecover
    gọi đơn vị là "tCARP".

**Phí thật luôn là `summary.fee_payer.fee_lovelace`** (hoặc `summary.funding.fee_payer.fee_lovelace`)
của lượt dựng thật — chuỗi thay đổi giữa lúc hỏi giá và lúc dựng thì hai số lệch nhau.

Lỗi của thân báo giá mang mã `FEE_QUOTE_*`; lỗi của `params` (vault không có, số JSON cho trường
tiền, …) mang **đúng mã** mà đường dựng trả. Hai ca đặc biệt:
- `/tx/create-vault` chỉ báo giá được khi `params` có `funding` (đường duy nhất có ví trả phí);
  vắng ⟹ `400 FEE_QUOTE_FUNDING_REQUIRED`.
- Đường có khoản ứng min-ADA (`open-thread`, `create-vault` két instant 0 LAMP) cộng khoản ứng
  vào vế phí: `needed_lovelace` = `max(phí + khoản ứng, thế chấp) + min-ADA`.

### Thread Engage: chọn theo chủ, `engage_ref`, `POST /tx/open-thread`

`/tx/consume` cần thread Engage của **chính chủ** (validator `consume` ép chủ thread == chủ
vault). Dịch vụ tìm thread theo chủ ở địa chỉ `consume.engage_address`, với policy NFT thread
= script hash của `consume` (suy từ địa chỉ, không cấu hình riêng).

- Chủ chưa có thread ⟹ `404 ENGAGE_THREAD_NOT_FOUND` — mở bằng `POST /tx/open-thread`.
- Chủ có nhiều thread ⟹ `409 ENGAGE_THREAD_AMBIGUOUS`; gửi `"engage_ref": "<tx_hash>#<i>"`
  để chỉ đích danh. `engage_ref` không phải thread của chủ ⟹ `400 ENGAGE_REF_MISMATCH`.

`POST /tx/open-thread` dựng giao dịch đúc NFT thread và tạo output thread genesis cho chủ.
Chủ đã có thread ⟹ `409 ENGAGE_THREAD_EXISTS`. Dịch vụ đọc lại NFT, output và datum genesis
từ `tx_cbor` (lệch ⟹ `422 OPEN_THREAD_TX_MISMATCH`). Lời đáp:

```jsonc
{
  "tx_cbor": "…", "tx_hash": "…",
  "engage_nft": "<policy 56 hex><tên>", "engage_address": "addr_test1w…",
  "owner": { "type": "key", "hash": "…" },
  "required_signers": ["…"], "witness_notes": ["…"], "summary": { … }, "expires_at": "…"
}
```

`funding` ở đường này chưa hỗ trợ ⟹ `501 OPEN_THREAD_FUNDING_UNSUPPORTED`.

### Gắn DID vào thread: `POST /tx/bind-did`

Dựng giao dịch `BindDID` (redeemer `Constr 1 []` của `consume`) trên thread Engage của chủ, bằng
`@magiclamp/consumemagic` ▸ `buildBindDidTx`. Script `consume` đọc qua ref CIP-33 ở
`ref_script_utxos.consume`, như `/tx/consume`. Một chiều, đúng một lần: đã gắn thì không đổi được,
kể cả ghi lại chính giá trị cũ.

```jsonc
// vào
{ "owner": { "type": "key", "hash": "<56 hex>" },   // hoặc "owner_pkh"
  "did_commit": "<ĐÚNG 64 ký tự hex thường — 32 byte>",
  "change_address": "addr_test1v…",                 // tuỳ chọn với chủ khoá (§7); chủ script phải gửi
  "engage_ref": "<tx_hash>#<i>",                    // tuỳ chọn: chỉ khi chủ có nhiều thread
  "owner_witness": { … } }                          // chỉ chủ script
// ra
{
  "tx_cbor": "…", "tx_hash": "…",
  "engage_nft": "<policy 56 hex><tên>", "engage_address": "addr_test1w…",
  "owner": { "type": "key", "hash": "…" },
  "did_commit": "<64 hex — đọc lại từ datum output trong tx_cbor>",
  "required_signers": ["…"], "witness_notes": ["…"], "expires_at": "…",
  "summary": {
    "requested_intent": "bind_did", "network": "Preview", "fee_lovelace": "…",
    "engage": { "nft_unit": "…", "address": "…", "input_ref": "<tx_hash>#<i>", "output_index": 0,
                "lovelace": "…", "owner": { … }, "consumed_count": "…", "last_epoch": "…",
                "consumed_nanogic": "…", "did_commit_before": "", "did_commit": "…" },
    "required_signers": ["…"]
  }
}
```

| tình huống | mã |
|---|---|
| `did_commit` vắng / rỗng / không đúng 64 ký tự / không phải hex thường | `400 DID_COMMIT_INVALID` |
| chủ chưa có thread | `404 ENGAGE_THREAD_NOT_FOUND` |
| chủ có nhiều thread, không kèm `engage_ref` | `409 ENGAGE_THREAD_AMBIGUOUS` |
| thread đã gắn DID | `409 DID_ALREADY_BOUND` — `details.did_commit` = giá trị đang trên chuỗi, kèm `engage_ref`, `engage_nft` |
| tx vừa dựng lệch (redeemer · value thread · datum · chữ ký chủ) | `422 BIND_DID_TX_MISMATCH` |

Dịch vụ đọc lại `tx_cbor` trước khi trả: thread là input với redeemer đúng `BindDID`; không đúc/đốt
gì dưới policy consume; đúng một output ở địa chỉ engage, mang NFT thread, value BẰNG tuyệt đối value
thread đầu vào; datum giữ nguyên chủ + ba trục kế toán, chỉ `did_commit` đổi sang đúng giá trị yêu
cầu; chủ khoá nằm trong `required_signers`. Validator đòi chữ ký của CHÍNH chủ — không có đường ký
thay (`personal_delegate`) như `/tx/consume`.

Khoá mềm theo chủ (§4): hai lượt gắn DID — hoặc gắn DID và tiêu MAGIC — cho cùng chủ trước khi nộp
đều dựng được; lượt NỘP sau của tx dựng trước ⟹ `409 TX_SUPERSEDED`.

### Proxy phí Feecover: `POST /fee/utxo`, `POST /fee/sign`

Feecover là dịch vụ ký phần ví trả phí của giao dịch, theo **mục đích**, và nhận ra ứng
dụng gọi bằng token. Token nằm trong app di động là token công khai, nên token của ứng dụng
`magic` chỉ nằm ở dịch vụ này (`FEECOVER_APP_TOKEN`); app đi qua hai đường proxy. Cả hai vẫn
đòi thẻ bài của dịch vụ (`Authorization: Bearer …`) như mọi đường khác.

**`POST /fee/utxo {route}`** — `route` là tên đường dựng sẽ dùng (`"consume"`,
`"create-vault"`…). Dịch vụ tra mục đích theo bảng của ứng dụng, gọi `GET /v1/utxo` của
Feecover, và trả đúng hình dạng mà `fee_payer` / `funding.fee_payer` nhận — app chép thẳng:

```jsonc
{
  "fee_payer": {
    "utxo": "<tx_hash>#<i>", "address": "addr_test1v…",
    "reservation_id": "<32 hex>"                  // mã lượt giữ — mới mỗi lượt /fee/utxo, xem dưới
  },
  "reserved_until": "2026-09-26T12:10:00.000Z",   // Feecover giữ UTxO này cho ứng dụng tới mốc đó
  "purpose": "consume_magic"
}
```

**`POST /fee/sign {tx_cbor}`** — chỉ cho giao dịch **chính dịch vụ này đã phát**, có ví trả
phí, và còn hạn ký. App **không** gửi `purpose` hay `ref`: dịch vụ lấy route (⟹ mục đích) và
mã ghi sổ từ sổ phát-hành của mình, nên app không giả được cả hai. Mã ghi sổ (`ref`) gửi
Feecover: `create-vault` ⟹ tên NFT vault (64 hex cuối `vault_nft`); `open-thread` ⟹ tên NFT
thread; route khác ⟹ hash thân tx. Lời đáp:

```jsonc
{ "tx_hash": "…", "witness_set": "<CBOR hex>", "net_lovelace": "…", "fee_lovelace": "…" }
```

`witness_set` là bộ chứng ký của ví trả phí. Dịch vụ đối chiếu `txHash` Feecover trả với hash
thân tự tính; lệch ⟹ `502 FEE_PROXY_UPSTREAM_MISMATCH`, không trả chữ ký.

**Hạn ký và giữ chỗ.** UTxO lấy qua `/fee/utxo` thì tx tiêu nó chỉ xin ký được tới `reserved_until`;
sau mốc đó ⟹ `403 FEE_PROXY_TX_NOT_ISSUED` (Feecover có thể đã giao UTxO cho người khác) — xin
UTxO mới và dựng lại. Dịch vụ đã kẹp `validTo` của tx vào mốc này lúc dựng (§3 ▸ *Hạn của tx*).
Thời lượng giữ chỗ do **Feecover** đặt: dịch vụ không tự chọn, chỉ chép `reserved_until` Feecover trả
ở `GET /v1/utxo` (`feeProxy.ts` ▸ `utxo`) vào sổ. Lượt ký **tra lại** lượt giữ ngay lúc ký
(`locks.ts` ▸ `feeSignProblem`), không chỉ dựa vào mốc chốt lúc dựng: sổ không còn lượt giữ cho UTxO
phí (bộ quét đã dọn, tiến trình vừa khởi động lại, hoặc UTxO không lấy qua `/fee/utxo` của tiến trình
này), lượt giữ đã qua, hoặc `validTo` của tx vượt `reserved_until` hiện có ⟹ `409
FEE_PAYER_RESERVATION_EXPIRED` (`details.tx_hash`, `fee_payer_utxo`, `reserved_until`, `reservation`:
`absent` · `expired` · `exceeded`), Feecover không bị gọi. Từ 2026-10-07 không còn ngoại lệ "`fee_payer`
app tự đưa ⟹ hạn ký = hạn nộp": `/fee/sign` chỉ có nghĩa với UTxO của Feecover, nên lấy UTxO qua
`/fee/utxo`. Tx dịch vụ đã phát mà quá `validTo + biên` ⟹ `410 TX_EXPIRED`, cùng `details` với
`/tx/submit`; Feecover không bị gọi.

#### `source` — nguồn trả phí Feecover ký (từ 2026-10-07)

`POST /fee/utxo {route, source?}` và `POST /fee/sign {tx_cbor, source?}` nhận `source`:
`"feecover"` (ví Feecover, app trả CARP) hoặc `"sponsor"` (ngân sách tài trợ của Feecover, luật L38 —
người dùng không trả gì). Vắng = `"feecover"`. Nguồn `owner_address` không đi qua proxy: ví của chủ tự ký.

- Giá trị khác hai giá trị trên (kể cả `null`, `"owner_address"`) ⟹ `400 FEE_PROXY_SOURCE_INVALID`,
  Feecover không bị gọi.
- `source` có mặt thì chuyển tiếp: `GET /v1/utxo?…&source=…`, thân `POST /v1/sign` có `source`. Vắng thì
  không gửi trường đó (bản Feecover trước nguồn sponsor không biết nó).
- **`source` ở thân trả LẤY TỪ câu trả lời của Feecover**, không từ yêu cầu, và phải **khớp** nguồn đã xin
  (vắng = `feecover`). Feecover trả `source` KHÁC nguồn đã xin ⟹ `502 FEE_SOURCE_NOT_CONFIRMED`
  (`details.source` = nguồn đã xin, `details.confirmed_source` = nguồn Feecover trả; ở `/fee/sign` có thêm
  `tx_hash`): ở `/fee/utxo` lượt giữ **không** được ghi, ở `/fee/sign` chữ ký **không** được giao — dùng nó
  là để app tưởng tx được tài trợ trong khi bị trừ CARP, hoặc ngược lại. `/fee/sign` nhận `source` ngoài
  `"feecover"` / `"sponsor"` từ Feecover ⟹ `502 FEE_PROXY_UPSTREAM` (thân sai hình dạng), cùng phép kiểm với
  `/fee/utxo`. Feecover không trả `source`:
  - đã xin `"sponsor"` ⟹ `502 FEE_SOURCE_NOT_CONFIRMED` (`details.source: "sponsor"`; ở `/fee/sign` có
    thêm `tx_hash`) — bản Feecover đó ký bằng ví Feecover, nên chữ ký / UTxO KHÔNG được giao như thể
    sponsor đã trả; ở `/fee/utxo` lượt giữ cũng không được ghi;
  - đã xin `"feecover"` hoặc vắng ⟹ thân trả **không có** `source` (tương thích bản Feecover đang chạy).
- `/fee/utxo` ghi nguồn Feecover xác nhận (vắng = `feecover`) vào lượt giữ. `/fee/sign` với `source`
  (vắng = `feecover`) khác nguồn đó ⟹ `400 FEE_PROXY_SOURCE_MISMATCH` (`details.source`,
  `reserved_source`, `tx_hash`), Feecover không bị gọi. Cổng này đứng SAU cổng lượt giữ (`409
  FEE_PAYER_RESERVATION_EXPIRED`).
- Lời từ chối L38 của Feecover (`403` ở `/v1/utxo`, `422` ở `/v1/sign`) đi ra nguyên mã dưới
  `FEE_PROXY_REJECTED`, `details` giữ `rule` + `message` (+ `reasons` ở 422).

```jsonc
// POST /fee/sign  { "tx_cbor": "84a4…", "source": "sponsor" }   — lượt giữ ghi nguồn "sponsor"
// → Feecover nhận { tx_cbor_hex, purpose: "consume_magic", ref: "<hash thân tx>", source: "sponsor" }
// ← 200
{ "tx_hash": "…", "witness_set": "a100", "net_lovelace": "178000", "fee_lovelace": "178000", "source": "sponsor" }
```

#### `reservation_id` — mã lượt giữ (từ 2026-10-07, BƯỚC 1: tuỳ chọn)

Lượt giữ khoá theo UTxO, và mọi bản app đi chung một thẻ dịch vụ, nên dịch vụ không phân biệt được
hai người dùng. Feecover phát lại cùng UTxO cho B thì A, còn cầm `fee_payer` cũ, trước bản này vẫn
dựng được trên lượt giữ của B. Hợp đồng:

- **`/fee/utxo` trả `fee_payer.reservation_id`**: 32 chữ hex thường = 128 bit ngẫu nhiên mật mã
  (`locks.ts` ▸ `newReservationId`), sinh MỖI lượt giữ và lưu cạnh lượt giữ. Feecover giao lại UTxO ⟹
  lượt giữ mới ⟹ mã mới. App chép nguyên khối `fee_payer` vào route dựng.
- **Route dựng nhận `fee_payer.reservation_id`** (và `funding.fee_payer.reservation_id` ở
  `/tx/create-vault`; `funding.collateral` thì KHÔNG — đó là UTxO của chính chủ, gửi ⟹ `400` trường lạ):
  - có mặt, khớp mã lượt giữ đang sống ⟹ dựng bình thường;
  - có mặt, KHÁC mã lượt giữ đang sống ⟹ `409 FEE_PAYER_RESERVATION_EXPIRED`, `details.reservation:
    "foreign"`, `reserved_until: null` (giờ giữ của lượt kia là của người khác, không trả ra);
  - có mặt mà sổ không có lượt giữ nào cho UTxO đó ⟹ `409 … "absent"`;
  - sai kiểu (không phải chuỗi 32 hex thường) ⟹ `400 FEE_PAYER_SHAPE` / `FUNDING_SHAPE`,
    `details.field: "<trường>.reservation_id"`, trước mọi lượt đọc chuỗi;
  - **vắng** ⟹ hành vi trước bản này (BƯỚC 1), và được ĐẾM: một dòng nhật ký JSON
    `{"event":"fee_reservation_id_missing","route","fee_payer_utxo","without_id","with_id"}` ở stderr;
    `without_id` / `with_id` là số đếm LUỸ KẾ của route đó từ lúc tiến trình khởi động, tính tới lúc dòng
    đó in (lượt CÓ mã không in dòng nào, nên `with_id` của dòng mới nhất là cận dưới). Bộ đếm KHÔNG lộ ra HTTP (kể cả `/health`, vốn không cần thẻ). Chỉ đếm lượt dựng
    ĐÃ GHI SỔ (`IssuedTxRegistry.record`) trên một lượt giữ Feecover đang sống — báo giá, và lượt dựng
    hỏng sau cổng, không đếm.
- **`/fee/sign` kiểm mã, app KHÔNG gửi gì thêm.** Sổ phát-hành ghi mã của lượt giữ mà cổng dựng ĐÃ THẤY
  (chụp lúc qua cổng, không tra lại lúc ghi sổ — giữa hai mốc lượt dựng còn đọc chuỗi, lượt giữ có thể bị
  quét và UTxO giao cho người khác); lúc ký so với mã lượt giữ đang sống của UTxO. Lệch, hoặc tx dựng khi
  chưa có lượt giữ nào mà nay UTxO đang được giữ ⟹ `409 … "foreign"` (kèm `tx_hash`), Feecover không bị
  gọi. Tx bị thay khi một tx chung khoá được nộp chỉ bỏ ĐÚNG lượt giữ của nó (cùng mã).

**Danh sách ĐÓNG route dựng kiểm mã** — mọi route gọi cổng `IssuedTxRegistry.feeReservationForBuild`
(`service.ts` ▸ `validityPlan`, `sponsor.ts` ▸ `planSponsorValidity`), tức mọi route nhận `fee_payer`:
`/tx/instant-gen` · `/tx/refresh-checkpoint` · `/tx/schedule-commit` · `/tx/schedule-fire` · `/tx/consume` ·
`/tx/open-thread` · `/tx/bind-did` · `/tx/create-vault` (`fee_payer` và `funding.fee_payer`) ·
`/tx/sponsor/t1-open` · `/tx/sponsor/t2-fund` · `/tx/sponsor/t3-draw` · `/tx/sponsor/t4-first-consume`.
Lệnh liệt kê lại — cổng chỉ có hai nơi gọi, nên phải đếm nơi gọi CỦA HAI HÀM bọc nó, cộng bảng ý định
của `buildOne` (mỗi khoá là một route gen/consume/schedule):
`command grep -rn 'this.validityPlan(\|planSponsorValidity(' VaultTxAPI/src` và
`command grep -n -A10 '^const ROUTE_OF_INTENT' VaultTxAPI/src/service.ts`.

**BƯỚC 2 (bắt buộc mã) CHƯA bật, và chỉ bật khi đủ HAI điều kiện:** (1) SuperApp báo số bản dựng có gửi
`reservation_id` ở cả hai app (Aladin, CheckFarm); (2) dòng nhật ký `fee_reservation_id_missing` của VTA
Preprod (số đếm luỹ kế `without_id` / `with_id`) cho thấy tỉ lệ lượt dựng Feecover thiếu mã đủ thấp.
Lý do: bản app cũ đã nằm trên máy người dùng không bao giờ gửi mã; bắt buộc sớm ⟹ mọi lượt dựng Feecover
của các bản đó ra 409 vĩnh viễn. Bật bước 2 = nhánh "vắng" đổi thành `409 … "absent"` ở cổng dựng.

**Ứng dụng khác `magic`.** Không gửi tiêu đề `X-Feecover-Token` ⟹ đi dưới ứng dụng `magic`.
Ứng dụng khác (ví dụ `orilife`) gửi token Feecover **của chính họ** ở `X-Feecover-Token`;
dịch vụ băm SHA-256, tra ra ứng dụng khai `token_sha256` đó, dùng bảng mục đích của ứng dụng
đó và chuyển tiếp đúng token người gọi gửi (không lưu, không ghi nhật ký). Mục đích mang tiền
tố `<app>_` chỉ đi với đúng ứng dụng `<app>`, và ứng dụng khác `magic` chỉ dùng mục đích tiền
tố tên mình; vi phạm ⟹ `403 FEE_PROXY_APP_PURPOSE`. Token không khớp ứng dụng nào ⟹ `401
FEE_PROXY_APP_UNKNOWN`, Feecover không bị gọi.

**Lời từ chối của Feecover** (4xx) đi ra nguyên mã trạng thái dưới `FEE_PROXY_REJECTED`, với
`details` = `{ upstream_status, rule?, message?, reasons? }` — ví dụ `422` kèm `rule: "L12"`,
`403 rule: "L14"` (ứng dụng bị chặn trong cửa sổ Catalyst), `429` (hết suất giữ chỗ), `409`
(UTxO đang giữ cho ứng dụng khác), `400`. Feecover không trả lời trong hạn chót, trả 5xx, trả
thân sai hình dạng, hoặc trả **`401`/`404`** (token của DỊCH VỤ với Feecover hỏng, đường sai —
lỗi cấu hình phía dịch vụ, chuyển nguyên thì app đọc `401` thành "token của app sai") ⟹
`502 FEE_PROXY_UPSTREAM`, `details.upstream_status` giữ mã gốc. Chuỗi nào trong
`rule`/`message`/`reasons` chứa token của dịch vụ thì bị bỏ, không đi ra app.

### Luồng cho app dùng ví PhoenixKey

1. `POST /fee/utxo {"route": "consume"}` ⟹ `fee_payer`, `reserved_until`.
2. Gọi đường dựng với đúng `fee_payer` đó (`/tx/consume` … `"fee_payer": {…}`; với
   `/tx/create-vault` đặt vào `funding.fee_payer`) ⟹ `tx_cbor`, `tx_hash`.
3. App ký phần của chủ trên `tx_hash` (khoá chủ, hoặc controller + khoá thiết bị của ví
   Phoenix) ⟹ bộ chứng ký của chủ.
4. `POST /fee/sign {"tx_cbor": …}` ⟹ `witness_set` của ví trả phí. Bước 3 và 4 đổi chỗ được;
   cả hai phải xong trước `reserved_until`.
5. Ghép hai bộ chứng ký thành một `TransactionWitnessSet`, rồi
   `POST /tx/submit {"tx_cbor": …, "witness_cbor": …}`.

Không bước nào được đổi thân giao dịch: đổi một byte là đổi `tx_hash`, và mọi chữ ký đã có
mất hiệu lực — dựng lại, không vá.

### Route tài trợ consume đầu: `POST /tx/sponsor/*`

Người mới chưa có CARP vẫn làm được lượt consume đầu: bên tài trợ góp CARP vào một quỹ
`paid_fund` đã ghim, két Prepaid của người mới rút MAGIC từ hạn mức đó rồi tiêu ngay trong cùng
kỳ. Chỉ chạy trên bản deploy có khối két Prepaid (§6, khối `paid_fund` kèm `carp_unit`) và trên
mạng có gốc kỳ (Preprod, Mainnet); Preview ⟹ `501 SPONSOR_NETWORK_UNSUPPORTED`.

**Ai được tài trợ, bao nhiêu lần, KHÔNG do dịch vụ này quyết.** Feecover vận hành chính sách
tài trợ và đếm **một lần mỗi DID**, theo anchor DID mà T2 mang ở `reference_inputs`. Dịch vụ chỉ
dựng hình dạng giao dịch; nó không giữ sổ đếm nào. (Chặn két thứ hai ở T1 —
`409 VAULT_ALREADY_EXISTS` — là lưới an toàn cho thao tác bấm lặp, không phải chính sách.)

| đường | bước | dựng gì | ai ký (theo thứ tự) |
|---|---|---|---|
| `/tx/sponsor/plan` | — | kế hoạch thuần: ai ký bước nào, đường của bước; không chạm chuỗi | — |
| `/tx/sponsor/t1-open` | T1 | đúc két Prepaid + thread consume trong MỘT tx; `did_commit` ghi vào **thread** (két genesis giữ `did_commit` rỗng) | ví trả phí · chủ |
| `/tx/sponsor/t2-fund` | T2 | `PrepaidLock` + `FundLock`: CARP từ UTxO bên tài trợ vào quỹ đã ghim, thối về bên tài trợ; anchor DID ở `reference_inputs` | ví trả phí · **bên tài trợ** · chủ |
| `/tx/sponsor/t3-draw` | T3 | `PrepaidDraw` ⟹ một lô MAGIC sống đúng kỳ hiện tại | ví trả phí · chủ |
| `/tx/sponsor/t4-first-consume` | T4 | consume đầu + `BurnBatch` trên két Prepaid | ví trả phí · chủ |

Nguồn bảng đường → bước: `src/sponsor.ts` ▸ `SPONSOR_STEP_OF_PATH`. Vai ký đọc ở mảng `signers`
của từng đáp ứng; `required_signers` đọc từ chính CBOR vừa dựng. Ví trả phí và bên tài trợ ký
vì tx chi UTxO khoá của họ — chúng **không** nằm trong `required_signers`; chủ khoá thì có.

**Ràng buộc cùng kỳ.** Lô MAGIC Prepaid chỉ sống đúng kỳ rút. T3 trả `summary.epoch` và
`summary.epoch_end_ms` (biên kỳ sau, POSIX mili-giây). T4 — và genesis Wakeme nếu app làm tiếp
— phải vào khối **trước** `epoch_end_ms`. T4 gửi `draw_epoch` = đúng `summary.epoch` của T3;
lệch kỳ hiện tại ⟹ `409 SPONSOR_EPOCH_MISMATCH`, không dựng gì.

**Thân yêu cầu.** Mọi bước nhận `owner` (+ `owner_witness` nếu chủ là script) và ĐÚNG MỘT trong
hai cách trả phí — gửi cả hai ⟹ `400 FEE_PAYER_CHANGE_ADDRESS_CONFLICT`. Tiền là chuỗi chữ số.

- `change_address` = địa chỉ KHOÁ của ví trả phí; bộ dựng chọn UTxO tự do trong ví đó (chủ
  script bắt buộc gửi một trong hai cách).
- `fee_payer` (Feecover) — cùng hình dạng với mục "Ví trả phí bên thứ ba" ở trên, đặt ở **gốc**
  thân bài; `funding` ở route này ⟹ `400 SPONSOR_REQUEST_SHAPE`:

  ```jsonc
  "fee_payer": { "utxo": "<tx_hash>#<i>", "address": "addr_test1v…" }
  ```

  Dịch vụ chi ĐÚNG UTxO đó (thuần ADA), dùng nó làm tài sản thế chấp DUY NHẤT với lượng
  `fee_payer_collateral_lovelace` của cấu hình, đặt hạn dùng ≤ 1 giờ (T2/T3 vẫn theo cửa sổ
  10 phút của kỳ), và trả mọi tiền thối ADA về `fee_payer.address`. Chủ **không** góp lovelace
  nào: người mới 0 ADA đi trọn T1→T4 (bài `tests/sponsorEmulator.test.ts` ▸ hành trình
  `fee_payer`, ví chủ còn 0 UTxO sau T4). Khác các route ở trên, **ở đây ví trả phí ỨNG
  min-ADA** cho output két + thread ở T1 — vì người mới không có ADA, không ai khác trả được;
  T2–T4 ứng phần min-ADA tăng thêm ở output của luồng (datum két lớn lên, output quỹ ở T2) —
  `fronted_lovelace` = Σ lovelace output địa chỉ luồng − Σ lovelace input địa chỉ luồng.

  Phép đọc lại CBOR (`src/sponsor.ts` ▸ `checkSponsorFeePayerTx`) chạy sau mỗi lượt dựng, lệch ⟹
  `422 FEE_PAYER_TX_MISMATCH`, không trả tx:
  1. input = UTxO trả phí + UTxO ở các địa chỉ của luồng (T1: két, thread · T2: két, quỹ, bên
     tài trợ · T3: két · T4: két, thread). Không input nào khác của khoá ví trả phí.
  2. thế chấp đúng UTxO đó, phần có thể mất ≤ lượng cấu hình (luật chung `checkCollateral`).
  3. output về ví trả phí chỉ mang ADA; không output nào ra ngoài ví trả phí + địa chỉ luồng.
  4. bên tài trợ (T2) nhận lại ĐÚNG số lovelace nó góp (phần CARP do các ghim T2 kiểm) — ví trả
     phí không chảy ADA sang đó, bên tài trợ không trả phí; `fee_in = phí + thối + phần ứng`, và
     phần ứng ≥ 0.
  5. hạn dùng ≤ 1 giờ (luật chung `checkValidTo`).

  `summary.fee_payer` trả: `address`, `utxo`, `input_lovelace`, `fee_lovelace`,
  `change_lovelace`, `fronted_lovelace` (min-ADA đã ứng), `collateral_at_risk_lovelace`,
  `collateral_return_lovelace`, `valid_to_posix_ms`. UTxO trả phí mang khoá `utxo:<ref>`: một lượt khác dựng lại trên cùng UTxO
  vẫn dựng được và THAY lượt cũ; nộp tx cũ sau khi tx mới đã nộp ⟹ `409 TX_SUPERSEDED` (§4).

**Vai ký không đổi theo cách trả phí.** Mảng `signers` vẫn mang vai `fee-wallet` (khoá thanh toán
của `fee_payer.address`, hoặc của `change_address`), rồi `sponsor` (chỉ T2), rồi `owner`. Ví trả
phí ký vì tx chi UTxO của nó; nó không vào `required_signers`.

| bước | trường riêng |
|---|---|
| T1 | `did_commit` (64 hex thường), `thread_lovelace` (tuỳ chọn) |
| T2 | `fund_id`, `carp_amount`, `sponsor: { utxo_refs: ["<tx>#<i>", …] (1–20) }`, `vault_ref` (tuỳ chọn) — **không** có `sponsor.change_address` (gửi ⟹ `400 SPONSOR_REQUEST_SHAPE`) |
| T3 | `fund_id`, `carp_amount`, `vault_ref` (tuỳ chọn) |
| T4 | `op_type`, `op_count`, `draw_epoch` (số nguyên), `vault_ref` / `engage_ref` (tuỳ chọn) |

**T2 chi tiền bên tài trợ ⟹ mọi thứ quyết tiền lấy từ CẤU HÌNH, không từ thân bài.**

- **Đích thối không do người gọi viết.** Phần thối của bên tài trợ về lại ĐÚNG địa chỉ chung của
  các UTxO trong `sponsor.utxo_refs`; `summary.sponsor_change_address` trả địa chỉ đó. Bản trước
  nhận `sponsor.change_address` từ thân bài, nên người gọi lái được toàn bộ phần thối về ví mình.
- **Ghim ở bản deploy** — khối `paid_fund.sponsor` (§6): `fund_units` (tập quỹ được nạp),
  `addresses` (địa chỉ khoá bên tài trợ, dạng bech32 chính tắc), `max_carp_amount` (trần một lượt,
  chuỗi chữ số carpdrop). Vắng khối ⟹ T2 trả `501 CONFIG_MISSING`. Cổng: `src/sponsor.ts` ▸
  `assertT2PinnedInputs` (quỹ + trần, trước khi giữ khoá), `assertSponsorUtxosPinned` (UTxO chung
  một địa chỉ đã ghim, cái nào cũng mang CARP), `assertT2PinnedOutputs` (đọc lại CBOR: đúng một
  output quỹ nhận đúng `carp_amount`; đúng một output thối có giá trị trọn = Σ vào − `carp_amount`;
  không output nào khác mang CARP).
- **Thẻ vai.** `/tx/sponsor/t2-fund` chỉ mở bằng thẻ `VAULT_TX_API_SPONSOR_TOKEN` (§6) — thẻ
  thường ⟹ `403 SPONSOR_ROLE_REQUIRED`; dịch vụ chưa đặt thẻ vai ⟹ `501 CONFIG_MISSING`, kể cả trên
  loopback. Thẻ vai dùng ở route khác ⟹ `401`. Nguồn: `src/http.ts` ▸ `SPONSOR_ROLE_PATHS`,
  `requireRole`. T1/T3/T4 giữ thẻ thường.
- **Khoá theo UTxO.** Mỗi T2 giữ khoá `utxo:<ref>` cho từng UTxO bên tài trợ (cùng TTL với khoá
  chủ): hai T2 cùng một UTxO đều dựng được, lượt sau THAY lượt trước; tx nộp sau ⟹ `409 TX_SUPERSEDED` (§4).
- **Chủ phải là DID.** T1/T2 chỉ nhận chủ `Script(did_stake)` kèm `owner_witness` (chủ khoá ⟹
  `422 SPONSOR_OWNER_NOT_DID`), và tên anchor trong nhân chứng phải bằng `did_commit` của hành
  trình (T1: của thân bài; T2: của thread) — lệch ⟹ `422 SPONSOR_OWNER_DID_MISMATCH`. Nguồn:
  `src/sponsor.ts` ▸ `assertOwnerDid`. Lối chủ khoá chỉ mở qua tham số hàm dựng `allowKeyOwner`
  của `SponsorTxService`, thứ `server.ts` không truyền — nó chỉ để bài kiểm dùng.

Đáp ứng mọi bước: `{ step, tx_cbor, tx_hash, required_signers, signers, witness_notes, summary,
expires_at }`. Mẫu dưới là một lượt T2 THẬT trong `tests/sponsorEmulator.test.ts` (Emulator,
UPLC thật; khoá thử sinh trong bộ nhớ nên các hash đổi mỗi lần chạy; `tx_cbor` cắt ngắn, mảng
`outputs` lược còn ba phần tử đầu). Mẫu chụp TRƯỚC bản vá ghim T2 và đã chỉnh tay đúng hai chỗ cho
khớp hình dạng mới: bỏ `sponsor.change_address` khỏi yêu cầu, thêm `summary.sponsor_change_address`
(giá trị lấy từ output thối `#0` của chính mẫu):

```json
{
  "owner": { "type": "key", "hash": "73736f1884b5adf25b7245235e9bbb864673b417edf00bb1e6926377" },
  "change_address": "addr_test1vzfsrm9aycqfxyhx75wh6s25mt35ky6ys8vdqdcrd3lm62szqa8j4",
  "fund_id": "2ce668504a204db3f693f7ed11a024cc5525b76c5222d4e740976267d0a49d37",
  "carp_amount": "1000000000",
  "sponsor": {
    "utxo_refs": ["390b7bd625f93ad3386141661e99602aa9184e359895ce135ae9e31b8f8b2425#1"]
  }
}
```

```json
{
  "step": "T2",
  "tx_cbor": "84ab00d90102848258200000…",
  "tx_hash": "fdae3dba48890d544a38c0bfa7cbf329279123585270aee54a9c58bf4bd8f2ca",
  "required_signers": ["73736f1884b5adf25b7245235e9bbb864673b417edf00bb1e6926377"],
  "signers": [
    { "role": "fee-wallet", "key_hashes": ["9301ecbd26009312e6f51d7d4154dae34b134481d8d037036c7fbd2a"],
      "how": "ví khoá addr_test1vzfsrm9aycqfxyhx75wh6s25mt35ky6ys8vdqdcrd3lm62szqa8j4: phí + thế chấp + tiền thừa" },
    { "role": "sponsor", "key_hashes": ["23ae09893e7ec45cf59a76bd8e490de3eeec054769779613678629b8"],
      "how": "chi các UTxO CARP đã đưa trong sponsor.utxo_refs" },
    { "role": "owner", "key_hashes": ["73736f1884b5adf25b7245235e9bbb864673b417edf00bb1e6926377"],
      "how": "chữ ký khoá 73736f1884b5adf25b7245235e9bbb864673b417edf00bb1e6926377" }
  ],
  "witness_notes": [
    "Chủ khoá: ký bằng khoá 73736f1884b5adf25b7245235e9bbb864673b417edf00bb1e6926377.",
    "Ví trả phí: input phí + tài sản thế chấp lấy từ addr_test1vzfsrm9aycqfxyhx75wh6s25mt35ky6ys8vdqdcrd3lm62szqa8j4; khoá thanh toán 9301ecbd26009312e6f51d7d4154dae34b134481d8d037036c7fbd2a phải ký.",
    "Bên tài trợ ký bằng 23ae09893e7ec45cf59a76bd8e490de3eeec054769779613678629b8 (chi các UTxO CARP đã đưa); phần thối về addr_test1vq36uzvf8elvgh84nfmtmrjfph37amq9ga5h09snv7rznwqqj7lal.",
    "Thứ tự: thân giao dịch này là bản CHỐT — mọi bên ký trên đúng tx_hash trả về; đổi bất kỳ byte nào của thân thì mọi chữ ký đã có mất hiệu lực."
  ],
  "summary": {
    "step": "T2",
    "epoch": 330,
    "epoch_end_ms": "1797033600000",
    "vault_out_ref": "fdae3dba48890d544a38c0bfa7cbf329279123585270aee54a9c58bf4bd8f2ca#1",
    "fund_id": "2ce668504a204db3f693f7ed11a024cc5525b76c5222d4e740976267d0a49d37",
    "fund_unit": "e73e5fe0b2707e119482c6405d6c528233071dafa82d5323b15278f52ce668504a204db3f693f7ed11a024cc5525b76c5222d4e740976267d0a49d37",
    "carp_amount": "1000000000",
    "opens_new_line": true,
    "anchor_ref": "2498905883e5ec227bcb4d6947a381ecfebede4943bfb9eb74b8fa43cbab2d30#0",
    "owner_commit": "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
    "sponsor_signers": ["23ae09893e7ec45cf59a76bd8e490de3eeec054769779613678629b8"],
    "sponsor_change_address": "addr_test1vq36uzvf8elvgh84nfmtmrjfph37amq9ga5h09snv7rznwqqj7lal",
    "withdrawals": 0,
    "outputs": [
      { "index": 0, "address": "addr_test1vq36uzvf8elvgh84nfmtmrjfph37amq9ga5h09snv7rznwqqj7lal",
        "assets": { "lovelace": "4872111902", "2222…5a5a": "99000000000" } },
      { "index": 1, "address": "addr_test1wpxkdmuftxelrq3c9rpnvpf83ysfq4lg8xxq3d62s7x26fg2jakda",
        "assets": { "lovelace": "1637800", "4d66ef89…12392a": "1" } },
      { "index": 2, "address": "addr_test1wrnnuhlqkfc8uyv5stryqhtv22prxpca475z65erk9f83agwr5fw5",
        "assets": { "lovelace": "2155000", "e73e5fe0…a49d37": "1", "2222…5a5a": "1000000000" } }
    ]
  },
  "expires_at": "2026-12-07T00:04:40.000Z"
}
```

`summary.owner_commit` đọc từ `did_commit` của **thread** của chủ, rồi dịch vụ tìm đúng một UTxO
mang NFT `did_stake.anchor_nft_policy ‖ owner_commit`. Bản deploy không khai
`did_stake.anchor_nft_policy` ⟹ T2 trả `501 CONFIG_MISSING` — dịch vụ không bao giờ đoán policy
anchor.

**Mã lỗi.** Nguồn mức HTTP của mọi mã do SDK ném: `src/sponsor.ts` ▸ `SPONSOR_ERROR_STATUS`
(bảng kín theo kiểu: thêm mã ở SDK mà không thêm ở đây thì không biên dịch được); danh sách mã
của dịch vụ: khối chú thích đầu `src/errors.ts`. Phần người gọi thường gặp:

| mã | HTTP | nghĩa / sửa thế nào |
|---|---|---|
| `SPONSOR_REQUEST_SHAPE` · `DID_COMMIT_INVALID` · `SPONSOR_CHANGE_ADDRESS_INVALID` | 400 | thân bài sai hình dạng; `details.field` chỉ trường |
| `VAULT_ALREADY_EXISTS` | 409 | chủ đã có két Prepaid — đi tiếp từ T2 với két đang có |
| `SPONSOR_ANCHOR_NOT_FOUND` · `SPONSOR_FUND_NOT_FOUND` | 404 | chưa có anchor DID / quỹ `fund_id` trên chuỗi |
| `SPONSOR_EPOCH_MISMATCH` | 409 | `draw_epoch` không phải kỳ hiện tại — lô đã hết hạn, rút lại ở T3 |
| `SPONSOR_VALIDITY_SPANS_EPOCHS` | 422 | đang sát biên kỳ; thử lại sau biên |
| `SPONSOR_CARP_INSUFFICIENT` · `SPONSOR_FUND_NOT_PINNED` | 422 | UTxO bên tài trợ không đủ CARP / quỹ không đúng quỹ đã ghim |
| `SPONSOR_FUND_NOT_ALLOWED` · `SPONSOR_CARP_ABOVE_CAP` | 422 | `fund_id` ngoài `paid_fund.sponsor.fund_units` / `carp_amount` vượt `max_carp_amount` |
| `SPONSOR_UTXO_NOT_ALLOWED` · `SPONSOR_UTXO_NO_CARP` | 422 | `utxo_refs` không chung một địa chỉ đã ghim / có UTxO không mang CARP |
| `SPONSOR_UTXO_NOT_KEY` | 400 | UTxO bên tài trợ không do khoá giữ |
| `SPONSOR_UTXO_NOT_FOUND` | 404 | có `utxo_refs` không phải UTxO chưa tiêu |
| `SPONSOR_FEE_WALLET_IS_SPONSOR` | 422 | ví trả phí (`change_address` hoặc `fee_payer.address`) trùng địa chỉ bên tài trợ, HOẶC cùng khoá thanh toán với nó (khác phần stake vẫn bị chặn) — dùng ví trả phí khác |
| `FEE_PAYER_CHANGE_ADDRESS_CONFLICT` | 400 | gửi cả `fee_payer` lẫn `change_address` — chọn một |
| `FEE_PAYER_SHAPE` · `FEE_PAYER_INVALID` | 400 | `fee_payer` sai khuôn / sai mạng / không phải khoá; UTxO trả phí không phải UTxO chưa tiêu, không ở `fee_payer.address`, hoặc không thuần ADA |
| `FEE_PAYER_TX_MISMATCH` | 422 | tx vừa dựng lệch một trong năm luật đọc lại ở trên — lỗi phía dịch vụ, báo vận hành |
| `SPONSOR_BUILD_FAILED` | 422 | bộ dựng không cân được tx — thường là UTxO trả phí không đủ ADA cho phí + thế chấp + min-ADA phải ứng; nạp UTxO lớn hơn |
| `SPONSOR_OWNER_NOT_DID` · `SPONSOR_OWNER_DID_MISMATCH` | 422 | T1/T2 với chủ khoá / anchor của nhân chứng không mang tên `did_commit` |
| `SPONSOR_ROLE_REQUIRED` | 403 | T2 gọi bằng thẻ thường — cần thẻ vai sponsor |
| `TX_SUPERSEDED` | 409 | lúc NỘP: tx đã bị thay — một tx khác chung khoá (chủ, quỹ, UTxO bên tài trợ / ví trả phí) đã được nộp, hoặc input của nó vừa bị tx khác tiêu (§4) |
| `OWNER_TX_IN_FLIGHT` | 409 | **đã nghỉ** — bản cũ trả ở lúc DỰNG; nay không đường nào trả (§4) |
| `SPONSOR_THREAD_DID_INVALID` | 422 | thread của chủ không mang `did_commit` 32 byte — két không mở bằng T1 |
| `SPONSOR_TX_MISMATCH` | 422 | tx vừa dựng không có đúng output két/thread ở địa chỉ đã cấu hình — lệch cấu hình, báo vận hành |
| `SPONSOR_PREPAID_UNAVAILABLE` · `SPONSOR_PREPAID_SCRIPTS_MISMATCH` · `CONFIG_MISSING` · `SPONSOR_UNAVAILABLE` | 501 | bản deploy không phục vụ được hành trình này |

Lỗi của bộ dựng đi qua `src/sponsor.ts` ▸ `asSponsorApiError`, một danh sách ĐÓNG: chỉ
`PrepaidTxError` và `PrepaidRuleError` (lỗi luật của PrepaidGen, mang `code`) thành `422`; mọi
`Error` thường khác ra `500` kèm `reference_code` — bản trước đổi mọi lỗi thành `422`, nên một
lỗi nội bộ đọc thành "yêu cầu sai" và người gọi đi sửa thân bài.

### 🔴 Số tiền là CHUỖI chữ số, cả vào lẫn ra

Trần LAMP là `36×10^15` oildrop; `2^53 ≈ 9,007×10^15`. Một trường oildrop **có thật** vượt
được ngưỡng an toàn của số dấu-phẩy-động, và lúc vượt thì nó **không lỗi — nó làm tròn**.
Một con số đã tròn vẫn dựng ra một giao dịch hợp lệ khoá nhầm số LAMP.

Nên:

- **Gửi lên**: `schedule_length`, `lamp_per_epoch`, `op_count` phải là **chuỗi** thập phân.
  Gửi số JSON thì nhận `400` kèm lý do. `op_type` là số nguyên — nó là nhãn (1 = ảnh,
  2 = CID), không phải tiền.
- **Nhận về**: mọi trường tiền là chuỗi. Đơn vị nằm ở **tên trường**, không nằm ở giá trị:
  `_oildrop` / `_nanogic` / `_lovelace` là số nguyên thô; `_lamp` / `_magic` / `_ada` là
  cùng con số đó đã đặt dấu phẩy, để hiển thị.

### Mã trả về

| tình huống | mã |
|---|---|
| dựng xong | `200` |
| tham số sai khuôn, số JSON cho trường tiền, bộ chứng ký rỗng | `400 BAD_REQUEST` |
| `owner` sai hình dạng / hash sai khuôn | `400 OWNER_CREDENTIAL_SHAPE` / `400 OWNER_HASH_INVALID` |
| `owner` và `owner_pkh` chỉ hai chủ khác nhau | `400 OWNER_ALIAS_MISMATCH` |
| `vault_type` sai giá trị / không khối nào phục vụ / trái loại cố định của đường | `400 VAULT_TYPE_INVALID` / `400 VAULT_TYPE_NOT_SERVED` / `400 VAULT_TYPE_ROUTE_CONFLICT` |
| nhiều khối, vắng `vault_type`, chủ có két ở nhiều loại | `409 VAULT_TYPE_AMBIGUOUS` |
| `owner_witness` sai hình dạng / chủ khoá mà gửi kèm | `400 OWNER_WITNESS_SHAPE` / `400 OWNER_WITNESS_UNEXPECTED` |
| chủ script, thiếu `owner_witness` | `400 OWNER_SCRIPT_WITNESS_UNAVAILABLE` |
| script gửi lên không băm ra `owner.hash` | `400 OWNER_AUTH_MISMATCH` |
| UTxO anchor không mang tài sản dưới `anchor_nft_policy` | `400 OWNER_ANCHOR_INVALID` |
| chủ `did`: `did` sai khuôn / kèm `owner_witness` hay `owner_pkh` / thiết bị không có trong anchor | `400 OWNER_DID_SHAPE` / `400 OWNER_DID_CONFLICT` / `400 OWNER_DEVICE_NOT_LISTED` |
| chủ `did`: anchor không có / nhiều hơn một / datum không phải `TAADDatum` 18 trường / không Active | `422 OWNER_ANCHOR_NOT_FOUND` / `422 OWNER_ANCHOR_AMBIGUOUS` / `422 OWNER_ANCHOR_SCHEMA` / `422 OWNER_ANCHOR_NOT_ACTIVE` |
| chủ `did`, bản deploy thiếu `did_stake.unapplied_script` | `501 OWNER_SCRIPT_WITNESS_UNAVAILABLE` |
| thiếu / sai `change_address` | `400 CHANGE_ADDRESS_REQUIRED` / `400 CHANGE_ADDRESS_INVALID` |
| `funding` sai hình dạng / trường lạ / chủ khoá thiếu anchor·controller·thiết bị | `400 FUNDING_SHAPE` |
| `did_payment_script_cbor` không băm ra payment credential `Script(h)` của `funding.address` | `400 FUNDING_SCRIPT_MISMATCH` |
| `fee_payer.address` không phải khoá / sai mạng; UTxO trả phí không ở đó hoặc không thuần ADA | `400 FUNDING_FEE_PAYER_INVALID` |
| `funding.fee_source = "did_payment"`: `collateral.address` không phải khoá / sai mạng; UTxO thế chấp không ở đó hoặc không thuần ADA | `400 FUNDING_COLLATERAL_INVALID` |
| `funding.fee_source` lạ · thiếu `collateral` (tự trả phí) · trộn `fee_payer` với `fee_source: "did_payment"` · `collateral` ở chế độ mặc định | `400 FUNDING_SHAPE` |
| `funding` cùng `change_address` | `400 FUNDING_CHANGE_ADDRESS_CONFLICT` |
| `funding` khai anchor/controller/thiết bị khác `owner_witness` | `400 FUNDING_WITNESS_MISMATCH` |
| anchor của `funding` không mang tài sản dưới `anchor_nft_policy` | `400 FUNDING_ANCHOR_INVALID` |
| ví `did_payment` không đủ LAMP + min-ADA | `422 FUNDING_INSUFFICIENT` |
| tx vừa dựng lệch hợp đồng `funding` (input/output/redeemer/thế chấp/chữ ký/hạn dùng) | `422 FUNDING_TX_MISMATCH` |
| `funding`, dịch vụ chưa cấu hình `did_stake` (đọc anchor) | `501 FUNDING_UNAVAILABLE` |
| tài khoản thưởng `Script(h)` chưa đăng ký | `422 OWNER_STAKE_NOT_REGISTERED` |
| chủ script, dịch vụ chưa cấu hình `did_stake` | `501 OWNER_SCRIPT_WITNESS_UNAVAILABLE` |
| `fee_payer` sai khuôn / sai mạng · không phải khoá · UTxO không ở đó hoặc không thuần ADA | `400 FEE_PAYER_SHAPE` / `400 FEE_PAYER_INVALID` |
| `fee_payer` cùng `change_address` | `400 FEE_PAYER_CHANGE_ADDRESS_CONFLICT` |
| `fee_payer` ở gốc thân bài của `/tx/create-vault`, trừ két `instant` `"lamp_amount": "0"` không kèm `funding` | `400 FEE_PAYER_UNSUPPORTED` |
| ví trả phí phải ứng min-ADA vượt `fee_payer_fronting_max_lovelace` | `422 FEE_PAYER_FRONTING_ABOVE_MAX` |
| chủ `Script(did_stake)` có thưởng > 0, dựng qua `fee_payer`, không suy được ví Phoenix (`details.missing`) | `422 FEE_PAYER_OWNER_REWARD_NONZERO` |
| chủ `Script(did_stake)` có thưởng > 0 nhưng dưới min-ADA của output về ví Phoenix | `422 FEE_PAYER_OWNER_REWARD_BELOW_MIN_ADA` |
| tx vừa dựng lệch luật ví trả phí | `422 FEE_PAYER_TX_MISMATCH` |
| `engage_ref` sai khuôn / không phải thread của chủ | `400 ENGAGE_REF_SHAPE` / `400 ENGAGE_REF_MISMATCH` |
| `/tx/instant-gen`: `m` vắng / số JSON / không phải chữ số / `"0"` | `400 INSTANT_GEN_M_INVALID` |
| `/tx/instant-gen`: `m > max_m` (`details.max_m`, `details.m`) | `422 INSTANT_GEN_M_ABOVE_MAX` |
| `/tx/quote` route `instant-gen` không gửi `m`, trần còn lại = 0 | `422 INSTANT_GEN_MAX_M_ZERO` |
| `/tx/create-vault`: `lamp_amount` sai (schedule cần > 0, instant cần ≥ 0) | `400 LAMP_AMOUNT_INVALID` |
| `/tx/create-vault`: `did_commit` không đúng 64 hex thường / gửi cho két schedule | `400 DID_COMMIT_INVALID` / `400 DID_COMMIT_UNEXPECTED` |
| `/tx/create-vault` instant: chủ (hoặc `did_commit`) đã có két (`details.existing`) | `409 VAULT_ALREADY_EXISTS` |
| bản deploy thiếu `gen_v2` / `ref_script_utxos.commit` / `ref_script_utxos.gb_shard` mà đường cần (`details.missing`, `details.route`) | `501 CONFIG_MISSING` |
| bản deploy là khối két Prepaid mà route chưa có bộ dựng cho loại két đó (`details.route`) | `501 VAULT_KIND_UNSUPPORTED` |
| beacon ρ / GreenBack / sổ két vắng trên chuỗi, hoặc hai UTxO cùng NFT (`details.what`) | `502 CHAIN_UNAVAILABLE` |
| `/tx/instant-gen` · `/tx/consume` làm mới checkpoint của két đã nối link, không gửi `wakeme_vault_ref` và dịch vụ không tìm thấy két (`details.located_count`) | `400 WAKEME_VAULT_REF_REQUIRED` |
| tự định vị thấy ≥ 2 UTxO mang NFT két Wakeme của `wakeme_link` (`details.candidates`) | `409 WAKEME_VAULT_AMBIGUOUS` |
| `wakeme_vault_ref` sai khuôn | `400 WAKEME_VAULT_REF_SHAPE` |
| `wakeme_vault_ref` trên mạng chưa có két Wakeme | `501 WAKEME_VAULT_UNAVAILABLE` |
| `wakeme_vault_ref` không có trên chuỗi / đã bị tiêu | `404 WAKEME_VAULT_NOT_FOUND` / `409 WAKEME_VAULT_SPENT` |
| `wakeme_vault_ref` không nằm ở script két Wakeme | `409 WAKEME_VAULT_SCRIPT_MISMATCH` |
| datum / NFT két không đạt luật đọc `L_lent` | `422 WAKEME_VAULT_UNREADABLE` |
| tx vừa dựng tiêu két, hoặc thiếu két trong `reference_inputs` | `422 WAKEME_VAULT_TX_MISMATCH` |
| `wakeme_vault_ref` không phải két đã nối (`wakeme_link` rỗng hoặc khác) và lượt này không nối/đổi link được, luật 6 (`details.wakeme_link`, `details.owner_commit`, `details.next_route`) — chạy `/tx/refresh-checkpoint` trước | `422 WAKEME_LINK_CHANGE_REJECTED` |
| chủ chưa có thread Engage | `404 ENGAGE_THREAD_NOT_FOUND` |
| chủ có nhiều thread, không kèm `engage_ref` | `409 ENGAGE_THREAD_AMBIGUOUS` |
| `/tx/consume`: `pairs` đi cùng `op_type`/`op_count` | `400 CONSUME_PAIRS_CONFLICT` |
| `pairs` không phải mảng / phần tử sai hình (null, mảng, khoá lạ) | `400 CONSUME_PAIRS_SHAPE` |
| `pairs` rỗng / quá 8 cặp | `400 CONSUME_PAIRS_EMPTY` / `400 CONSUME_PAIRS_TOO_MANY` |
| `op_type` không tăng ngặt (kể cả trùng) | `400 CONSUME_PAIRS_NOT_INCREASING` |
| `op_count` không phải chuỗi chữ số ≥ 1, ≤ 20 chữ số / `op_type` ngoài số nguyên [0, 1000000] | `400 CONSUME_PAIR_COUNT_INVALID` / `400 CONSUME_PAIR_TYPE_INVALID` |
| tx tiêu vừa dựng lệch lượt tiêu đã yêu cầu (thread, redeemer, output, datum, Σburns) | `422 CONSUME_TX_MISMATCH` |
| lượt tiêu phải đốt từ nhiều lô hơn một tx chở được, kể cả cách ít lô nhất (`MAX_BURN_ENTRIES_PER_TX`) | `422 CONSUME_TOO_MANY_BATCHES` (`details.burn_entries_needed` · `burn_entries_cap` · `live_batches`) |
| `/tx/open-thread` khi chủ đã có thread | `409 ENGAGE_THREAD_EXISTS` |
| `engage_ref` mang NFT nhưng datum không giải được | `422 ENGAGE_THREAD_DATUM_UNDECODABLE` |
| tx mở thread vừa dựng lệch (NFT / output / datum genesis) | `422 OPEN_THREAD_TX_MISMATCH` |
| `/tx/open-thread` kèm `funding` | `501 OPEN_THREAD_FUNDING_UNSUPPORTED` |
| `/tx/bind-did`: `did_commit` không đúng 64 ký tự hex thường | `400 DID_COMMIT_INVALID` |
| `/tx/bind-did`: thread đã gắn DID | `409 DID_ALREADY_BOUND` (`details.did_commit`) |
| tx gắn DID vừa dựng lệch (redeemer / value / datum / chữ ký chủ) | `422 BIND_DID_TX_MISMATCH` |
| `/tx/quote`: thân sai hình dạng · `route` lạ | `400 FEE_QUOTE_SHAPE` / `400 FEE_QUOTE_ROUTE_UNKNOWN` |
| `/tx/quote`: `params` mang `fee_payer` / `funding.fee_payer` | `400 FEE_QUOTE_FEE_PAYER_IN_PARAMS` |
| `/tx/quote` cho `create-vault` không có `params.funding` | `400 FEE_QUOTE_FUNDING_REQUIRED` |
| `/tx/quote` cho `create-vault` với `params.funding.fee_source = "did_payment"` | `400 FEE_QUOTE_SELF_FUNDED` |
| `/tx/quote`: gửi trường cũ `owner_fee_address` (số ít) · `owner_fee_addresses` không phải mảng chuỗi | `400 FEE_QUOTE_SHAPE` |
| `/tx/quote`: một phần tử `owner_fee_addresses` không phải địa chỉ khoá / sai mạng | `400 FEE_QUOTE_OWNER_ADDRESS_INVALID` |
| `/tx/quote`: `owner_fee_addresses` quá 10 phần tử | `400 FEE_QUOTE_OWNER_ADDRESSES_TOO_MANY` |
| `/tx/quote`: `owner_fee_addresses` có địa chỉ trùng | `400 FEE_QUOTE_OWNER_ADDRESSES_DUPLICATE` |
| `X-Feecover-Token` (ở `/fee/*` hoặc `/tx/quote`) không khớp ứng dụng nào | `401 FEE_PROXY_APP_UNKNOWN` |
| ứng dụng chưa có mục đích cho route đó | `400 FEE_PROXY_PURPOSE_UNMAPPED` |
| mục đích thuộc ứng dụng khác / thiếu tiền tố tên ứng dụng | `403 FEE_PROXY_APP_PURPOSE` |
| `/fee/sign` cho tx không do dịch vụ phát, hoặc còn hạn nộp nhưng quá `reserved_until` | `403 FEE_PROXY_TX_NOT_ISSUED` |
| `/tx/submit` / `/fee/sign` cho tx dịch vụ ĐÃ phát mà quá `validTo + CLOCK_SKEW_MARGIN_MS` | `410 TX_EXPIRED` (`details.tx_hash`, `expired_at`, `rebuild_safe`, `submission`) |
| UTxO ví trả phí hết giờ giữ chỗ Feecover trước khi tx kịp có khoảng hiệu lực; UTxO ở địa chỉ Feecover mà sổ không còn lượt giữ (lúc dựng); `fee_payer.reservation_id` khác mã lượt giữ đang sống (lúc dựng); `/fee/sign` cho tx mà UTxO phí không còn lượt giữ / lượt giữ đang sống không phải lượt tx được dựng trên / `validTo` vượt lượt giữ | `409 FEE_PAYER_RESERVATION_EXPIRED` (`details.reserved_until` — `null` khi không có lượt giữ hoặc `foreign`, `fee_payer_utxo`, `reservation`: `absent`·`expired`·`exceeded`·`foreign`; ở `/fee/sign` thêm `tx_hash`) |
| `fee_payer.reservation_id` / `funding.fee_payer.reservation_id` không phải chuỗi 32 hex thường | `400 FEE_PAYER_SHAPE` / `400 FUNDING_SHAPE` (`details.field`) |
| `/tx/submit`: một chữ ký không khớp thân tx / thiếu chữ ký của khoá trong `required_signers` | `400 WITNESS_SIGNATURE_INVALID` / `400 WITNESS_MISSING_SIGNER` |
| `/fee/sign` cho tx không dùng ví trả phí | `400 FEE_PROXY_NO_FEE_PAYER` |
| Feecover từ chối (`400`/`403`/`409`/`422`/`429`) | mã đó + `FEE_PROXY_REJECTED` |
| dịch vụ không cấu hình `feecover` | `501 FEE_PROXY_UNAVAILABLE` |
| Feecover không trả lời / 5xx / `401` / `404` / thân sai hình dạng | `502 FEE_PROXY_UPSTREAM` |
| `GET /tx/status`: `tx_hash` không phải đúng 64 hex thường (kể cả vắng) | `400 TX_HASH_INVALID` |
| `GET /tx/status`: nhà cung cấp chuỗi lỗi / quá giờ / hình dạng lạ (`details.stage` = `chain` \| `mempool`) — **không** phải `not_found` | `502 TX_STATUS_PROVIDER_UNAVAILABLE` |
| tham chiếu UTxO (ví trả phí, anchor) không có trên chuỗi / sai số output | `400 UTXO_NOT_FOUND` |
| tham chiếu UTxO đã bị tiêu | `409 UTXO_SPENT` (`details.consumed_by_tx`) |
| UTxO vault là input của một tx vừa nộp qua dịch vụ mà chưa vào khối | `409 PREVIOUS_TX_PENDING` — thử lại sau khi tx đó vào khối |
| beacon giá trễ quá `consume.max_price_stale` epoch | `422 TX_BUILD_REJECTED` với câu `CONSUME-011` |
| Feecover ký một tx có hash khác | `502 FEE_PROXY_UPSTREAM_MISMATCH` |
| `/fee/utxo` / `/fee/sign`: `source` khác `"feecover"` / `"sponsor"` | `400 FEE_PROXY_SOURCE_INVALID` |
| `/fee/sign`: `source` (vắng = `feecover`) khác nguồn của lượt giữ UTxO phí | `400 FEE_PROXY_SOURCE_MISMATCH` |
| xin `source: "sponsor"` mà Feecover trả lời không kèm `source`; hoặc Feecover trả `source` khác nguồn đã xin (vắng = `feecover`) ở `/fee/utxo` / `/fee/sign` | `502 FEE_SOURCE_NOT_CONFIRMED` (`details.source`, `details.confirmed_source` khi Feecover có trả) |
| thiếu/sai thẻ bài | `401 UNAUTHORIZED` |
| chủ **chưa có** vault | `404 VAULT_NOT_FOUND` ← **không phải** `200` với tx rỗng |
| method sai | `405 METHOD_NOT_ALLOWED` |
| nộp một tx đã bị tx khác chung khoá (đã NỘP) thay, hoặc input đã bị tx vừa nộp tiêu | `409 TX_SUPERSEDED` (`details.superseded_by` / `details.conflicting_inputs`, kèm `details.submission` + `details.previously_submitted`) — **không** chứng minh tx chưa lên chuỗi (§4) |
| nộp lại một tx nút đã NHẬN, chưa bị thay | `200` với **đúng** kết quả lượt đầu; **không** gửi lên chuỗi lần nữa (§4) |
| chủ đã có một tx dựng xong chưa nộp | **không còn lỗi** — lượt dựng mới thay lượt cũ; `OWNER_TX_IN_FLIGHT` đã nghỉ (§4) |
| hai UTxO cùng một NFT danh-tính | `409 VAULT_IDENTITY_DUPLICATE` |
| chủ có nhiều vault, yêu cầu không nói cái nào | `409 VAULT_AMBIGUOUS` |
| giao thức từ chối (L×λ > L_avail, MAGIC sống < required, shard hết chỗ) | `422 TX_BUILD_REJECTED` |
| dựng ra CBOR mà không đọc lại được | `422 TX_SUMMARY_UNDECODABLE` |
| không đọc được chuỗi | `502 CHAIN_UNAVAILABLE` |
| datum vault không khớp lược đồ | `502 VAULT_DATUM_UNDECODABLE` |
| nút chuỗi từ chối tx | `502 SUBMIT_REJECTED` |
| ngoài dự kiến | `500 INTERNAL` + **mã tham chiếu** |

> **Đừng gộp `404 VAULT_NOT_FOUND` với `502 CHAIN_UNAVAILABLE`.** Gộp là dựng một màn hình
> mời người dùng tạo vault thứ hai trong khi vault thứ nhất vẫn ở đó, chỉ là đường đọc gãy.

`500` **không** trả traceback, không trả đường dẫn nội bộ, không trả tên biến môi trường.
Nó trả `reference_code` dạng `ref_<12 hex>`, và mã đó tra ngược được ở nhật ký của chính
dịch vụ. Có bài kiểm đòi đúng điều đó: mã trả ra ngoài phải bằng mã đã ghi vào nhật ký.
Câu của **nút chuỗi** thì ngược lại — nó được giữ nguyên văn ở `SUBMIT_REJECTED`, vì
"giá trị đã bị tiêu" nói được người dùng phải làm gì, còn "có lỗi xảy ra" thì không.

---

## 4. Đua UTxO — vì sao có khoá mềm và vì sao nó giữ lâu

Mỗi chủ có một UTxO vault. Dựng giao dịch nghĩa là **chọn** đúng UTxO đó làm input. Hai
yêu cầu tới gần nhau cho cùng `owner_pkh` chọn **trùng** input, và eUTXO chỉ cho một trong
hai lên chuỗi. Cái thua **không hỏng lúc dựng** — nó hỏng *sau khi người dùng đã ký*, và
câu của chuỗi lúc đó không nhắc gì tới chuyện có hai giao dịch.

**Xung đột bắt ở lúc NỘP, không ở lúc dựng** (đổi 2026-10-03, `src/locks.ts` đầu tệp). Bản cũ
trả `409 OWNER_TX_IN_FLIGHT` cho lượt DỰNG thứ hai suốt TTL; nhưng chủ là công khai, dựng tx không
cần chữ ký chủ, và dịch vụ có một thẻ Bearer dùng chung ⟹ ai có thẻ gọi lặp là khoá két người khác
vô thời hạn. Luật hiện hành:

- lượt dựng mới cho một khoá **không bao giờ** nhận 409 vì một lượt dựng khác: nó lấy khoá, lượt cũ bị
  THAY, mọi khoá phụ lượt cũ còn giữ (UTxO quỹ / UTxO ví trả phí ở `/tx/sponsor/*`) nhả ngay, và chỗ
  giữ phí của tx bị thay được trả lại;
- một tx chỉ bị coi là đã thay khi một tx KHÁC chung khoá với nó được **NỘP** (cần chữ ký chủ), không
  phải khi được dựng — nên người lạ dựng lặp không làm tx của chủ bị từ chối;
- `/tx/submit` (và `/fee/sign`) với tx đã bị thay, hoặc tx có input đã bị một tx vừa nộp (chưa vào khối)
  tiêu ⟹ `409 TX_SUPERSEDED` với `details.superseded_by` (hash tx đã nộp) và/hoặc
  `details.conflicting_inputs`. App dựng lại từ đầu;
- tx **đã được nộp** vẫn bị thay khi một tx chung khoá được nộp SAU nó. Không có miễn trừ cho tx đã
  nộp, vì miễn trừ đó mở lại đúng ca mà khoá theo chủ tồn tại để chặn: ví A nộp tx tạo két T1, T1 rơi
  khỏi mempool; ví B nộp T2, T2 lên chuỗi; app nộp lại T1 ⟹ két thứ hai cho cùng chủ, và mọi đường
  dựng sau đó trả `409 VAULT_AMBIGUOUS`. Validator chưa ép mỗi DID một két, nên cổng này là cổng duy
  nhất;
- **nộp lại một tx nút đã NHẬN** (rớt mạng ở chiều trả lời) mà chưa bị thay ⟹ `200` với đúng kết quả
  lượt đầu, **không gửi lên chuỗi lần nữa**, và không thay tx nào đã dựng sau lượt nộp đầu. Hệ quả phải
  biết: tx đã nhận mà rơi khỏi mempool thì **không hồi sinh được** qua đường này — app tra chuỗi theo
  `tx_hash`, không thấy thì dựng lại;
- dịch vụ **đã gửi mà không nhận được xác nhận** (mất kết nối / quá giờ ở `chain.submitTx`, hoặc nút
  báo một hash khác hash thân) ⟹ tx được ghi trạng thái `unconfirmed`: input vào sổ chờ như một lượt
  nộp, và tx chung khoá dựng TRƯỚC bị thay — tx có thể đã ở mempool. Nộp lại tx đó thì dịch vụ GỬI lại
  (không biết lượt đầu đã tới chưa); nút nhận thì nó thành `accepted` mà không thay thêm gì. Nút TỪ
  CHỐI lượt gửi lại đó (`502 SUBMIT_REJECTED`) cũng không chứng minh tx chưa lên chuỗi — lượt đầu có
  thể đã vào, và chính vì thế mà input của nó không còn;
- lỗi 409 luôn kèm `details.submission`: `accepted` (nút đã nhận tx này), `unconfirmed` (đã gửi, chưa
  rõ), `none` (**tiến trình này** chưa gửi); `details.previously_submitted` = `submission ≠ "none"`.
  **Cả hai KHÔNG nói gì về trạng thái chuỗi.** `none` không có nghĩa là "chưa lên chuỗi": sổ nằm trong
  bộ nhớ một tiến trình — khởi động lại, bản sao khác sau bộ cân tải, hay một đường nộp khác đều có
  thể đã đưa tx lên. 409 chỉ nói đừng nộp nữa; muốn biết tx cũ đã vào khối chưa thì tra chuỗi theo
  `tx_hash`, đừng suy từ mã lỗi.

Mã `OWNER_TX_IN_FLIGHT` đã nghỉ: không đường nào trả nữa, giữ lại trong tài liệu để app đời cũ còn
nhận ra. Khoá vẫn **giữ tới lúc nộp** để `/tx/submit` biết tx nào chung khoá. Ba đường mở khoá:
`/tx/submit` đúng giao dịch đó · hết hạn (`VAULT_TX_API_LOCK_TTL_MS`, mặc định 180 s; từ
2026-10-06 KHÔNG còn là `expires_at` — hạn tx là `validTo`, §3 ▸ *Hạn của tx*) · dựng hỏng thì nhả ngay · nút chuỗi TỪ CHỐI giao dịch lúc nộp (mất kết nối
lúc nộp thì KHÔNG nhả — không biết giao dịch đã vào mempool chưa). Khoá mang thẻ thế hệ: một
lượt dựng chậm quá hạn không nhả, cũng không gắn hash lên khoá của lượt sau.

**Sau khi nộp**, khoá nhả nhưng nút đọc chuỗi chỉ thấy input bị tiêu khi giao dịch vào khối.
Trong khe đó dịch vụ giữ input của giao dịch vừa nộp (`VAULT_TX_API_PENDING_SPENDS_TTL_MS`, tách
khỏi TTL khoá từ 2026-10-06): dựng lại trên đúng UTxO
vault ấy ⟹ `409 PREVIOUS_TX_PENDING`; bộ dựng không chọn lại UTxO ví/shard ấy làm input.

**Giới hạn đã biết:** khoá nằm trong bộ nhớ của **một tiến trình**. Chạy hai bản sau một
bộ cân tải thì hai bảng khoá không thấy nhau và khoá không còn nghĩa. Xem §8.

---

## 5. Vault nào được chọn làm input

Một UTxO ở địa chỉ vault chỉ được tính khi mang **NFT danh-tính vault**: đúng một tài sản
có `policy_id == script hash của vault`, số lượng 1 (`INV-VAULT-IDENTITY`).

Lọc theo `datum.owner` **không đủ**: địa chỉ script là công cộng, ai cũng đặt được một
UTxO ở đó với datum tự soạn khai `owner` là PKH của người khác. Validator từ chối đúng
những UTxO ấy (`ScheduleGen/onchain/validators/vault.ak` ▸ `validate_vault_value`,
▸ `has_vault_id_nft` — neo bằng **tên hàm**, không bằng số dòng), nên bên dựng phải từ chối
y hệt. UTxO bị bỏ được **đếm và khai** ở `ignored[]` kèm lý do.

Một chủ có **nhiều** vault là hợp lệ, và bên **đọc** cộng dồn chúng. Bên **dựng** thì
không cộng được: phải chọn một UTxO. Chọn đại là chọn hộ người dùng một cái vault họ không
nhắc tới — nên `409 VAULT_AMBIGUOUS`, kèm danh sách để bên gọi chọn. Xem §8.

---

## 6. Chạy

### Biến môi trường — đặt ngay trước lệnh, đừng ghi vào tệp

| biến | bắt buộc | mặc định |
|---|---|---|
| `VAULT_TX_API_NETWORK` | có | — (`Preview` \| `Preprod` \| `Mainnet`) |
| `BLOCKFROST_PROJECT_ID` | có | — **GIÁ TRỊ** khoá, không phải đường dẫn |
| `VAULT_TX_API_DEPLOYMENT` | có | — JSON, xem dưới |
| `VAULT_TX_API_CHANGE_ADDRESS_STRATEGY` | có | — **không có mặc định**, xem §7 |
| `VAULT_TX_API_VAULT_PLUTUS_JSON` | có | — đường dẫn `plutus.json` của module vault |
| `VAULT_TX_API_EXTRA_DEPLOYMENT_FILES` | không | rỗng ⟹ một khối. Danh sách ĐƯỜNG DẪN tệp JSON khối triển khai phụ, ngăn bằng dấu phẩy (khác khối chính: khối chính là JSON thô) |
| `VAULT_TX_API_EXTRA_VAULT_PLUTUS_JSONS` | cùng biến trên | rỗng. Blueprint của module vault cho từng khối phụ, ngăn bằng dấu phẩy, ghép theo VỊ TRÍ |
| `VAULT_TX_API_HOST` | không | `127.0.0.1` |
| `VAULT_TX_API_PORT` | không | `8788` |
| `VAULT_TX_API_BASE_PATH` | không | rỗng — tiền tố đường khi đứng sau proxy định tuyến theo đường, ví dụ `/vaulttx/preprod`; dịch vụ tự cắt nó (`src/basePath.ts`), vẫn nhận đường không tiền tố từ loopback |
| `VAULT_TX_API_TOKEN` | ngoài loopback thì **có** | rỗng |
| `VAULT_TX_API_SPONSOR_TOKEN` | khi phục vụ T2 | rỗng ⟹ `/tx/sponsor/t2-fund` trả `501 CONFIG_MISSING`. **GIÁ TRỊ** thẻ vai sponsor, đưa cho bên vận hành tài trợ; trùng `VAULT_TX_API_TOKEN` ⟹ từ chối khởi động |
| `VAULT_TX_API_BLOCKFROST_URL` | không | dẫn theo `NETWORK` |
| `VAULT_TX_API_TIMEOUT_MS` | không | `20000` |
| `VAULT_TX_API_LOCK_TTL_MS` | không | `180000` — CHỈ khoá mềm theo chủ (§4), khoảng `[1000, 3600000]` |
| `VAULT_TX_API_TX_VALIDITY_MS` | không | `900000` (`DEFAULT_TX_VALIDITY_MS`) — hạn ký: cận `tip + giá trị này` của `validTo`, khoảng `[60000, 3600000]` (`src/config.ts` ▸ `loadConfig`) |
| `VAULT_TX_API_PENDING_SPENDS_TTL_MS` | không | `300000` — sổ input vừa nộp (`PendingSpends`) nhớ một input bao lâu, khoảng `[30000, 3600000]` |
| `FEECOVER_APP_TOKEN` | khi cấu hình có `feecover.apps.magic` | — **GIÁ TRỊ** token ứng dụng Feecover (token API, không phải khoá ký) |

Cổng fail-closed lúc khởi động: thiếu biến bắt buộc · bind ngoài loopback mà thẻ bài rỗng ·
policy LAMP nhái hoặc thuộc một đời đã bị thay (`assertLampPolicyId`; lối tập dượt đã đóng, xem dưới) ·
tên tài sản LAMP không khớp mạng (`tLAMP` testnet / `LAMP` mainnet — apply-param #2) · địa
chỉ sai tiền tố mạng · địa chỉ không phải địa chỉ script · hai mục vault trùng địa chỉ ·
blueprint không đọc được · khối `feecover` có ứng dụng `magic` mà `FEECOVER_APP_TOKEN` rỗng ·
URL Feecover không phải `https://` (hoặc `http://` loopback) · bảng mục đích nêu route không
có · khối phụ (`src/config.ts` ▸ `loadExtraBlocks`, `assertCompatibleBlocks`): hai danh sách
lệch độ dài hoặc có mục rỗng · tệp khối/blueprint không đọc được · khác tài sản LAMP · nhãn
`source` mở đầu bằng tên mạng khác `VAULT_TX_API_NETWORK` (Preview và Preprod cùng tiền tố
`addr_test` nên nhãn là dấu duy nhất tách hai mạng đó; nhãn không mở đầu bằng tên mạng ⟹ phần
đó không đo được) · hai khối cùng `vault_type` · khối phụ là Prepaid, hoặc khối chính Prepaid
mà có khối phụ · khác `did_stake` · khối phụ khai `feecover`. Tất cả **từ chối khởi động**, không cảnh báo rồi chạy tiếp — người
bị chặn lúc khởi động là người vận hành, còn hoãn sang lúc chạy thì người bị chặn là người
dùng.

```jsonc
// VAULT_TX_API_DEPLOYMENT
{
  "source": "Preview, deploy 2026-09-11, tx e5fd34b1…",   // BẮT BUỘC — xem dưới
  "lamp":   { "policy_id": "<56 hex>", "asset_name_hex": "744c414d50" },  // + "rehearsal_ack" tuỳ chọn — xem dưới
  "vaults": [{ "vault_type": "Schedule", "address": "addr_test1w…" }],
  "shard_address": "addr_test1w…",
  "ref_script_utxos": {
    "vault": "…#0", "shard": "…#1", "consume": "…#2",
    "commit": "…#3",     // tuỳ chọn — validator withdraw-zero `commit` (ScheduleGen v2.0); vắng ⟹ schedule-commit 501
    "gb_shard": "…#4"    // tuỳ chọn — validator `gb_shard`; vắng ⟹ instant-gen + schedule-commit 501
  },
  "gen_v2": {                                   // tuỳ chọn; CÓ thì đủ mọi trường — vắng ⟹ các đường Gen v2.0 trả 501
    "rate_beacon_address": "addr_test1w…",      // Script(rate_script_hash) — hash suy từ địa chỉ
    "rate_nft_policy": "<56 hex>",              // NFT "RHO"
    "greenback_beacon_address": "addr_test1w…", // Script(gb_beacon_script_hash)
    "greenback_beacon_nft_policy": "<56 hex>",  // NFT "GBB"
    "gb_shard_address": "addr_test1w…",         // Script(gb_shard_policy_id) — 16 shard NFT "GBS"‖id
    "gb_shard_cap_nanogic": "1000000000000000", // CHUỖI chữ số > 0, đúng apply-param của gb_shard
    "vault_registry_address": "addr_test1w…"    // sổ két, NFT "VRG"
  },
  "consume": {
    "engage_address": "addr_test1w…",       // thread Engage chọn theo chủ lúc chạy
    "price_beacon_address": "addr_test1w…", "price_beacon_nft_unit": "…",
    "max_price_stale": "1"                  // tuỳ chọn — apply-param #5 của consume; có ⟹ từ chối sớm CONSUME-011
  },
  "fee_payer_collateral_lovelace": "3000000",      // tuỳ chọn, CHUỖI; thế chấp khi có ví trả phí
  "fee_payer_fronting_max_lovelace": "5000000",    // tuỳ chọn, CHUỖI; trần khoản ứng min-ADA, "0" tắt
  "did_stake": { "anchor_nft_policy": "<56 hex>", "unapplied_script": { "cbor": "<hex>", "hash": "<56 hex>" }, "did_payment_unapplied_script": { "cbor": "<hex>", "hash": "<56 hex>" } }, // tuỳ chọn — chủ script + funding did_payment; unapplied_script bật chủ {type:"did"}; did_payment_unapplied_script cho thưởng did_stake qua ví trả phí
  "feecover": {                                     // tuỳ chọn — proxy phí, xem §3
    "url": "https://feecover.example",              // https://, hoặc http:// tới loopback
    "timeout_ms": 15000,                            // tuỳ chọn, mặc định 15000
    "apps": {
      "magic":   { "purposes": { "create-vault": "create_vault", "consume": "consume_magic" } },
      "orilife": { "token_sha256": "<SHA-256 hex của token orilife>",
                   "purposes": { "consume": "orilife_consume_magic" } }
    }
  }
}
```

Khoá cũ `consume.engage_nft_unit` đã bị gỡ: khai nó thì dịch vụ từ chối khởi động (một NFT
thread cố định chỉ phục vụ được một người). Khoá cũ `instant` (datum UM + beacon backing, Gen
v1) cũng vậy: UM không còn trong công thức sinh, beacon backing thay bằng beacon GreenBack +
shard GB của khối `gen_v2` — khai `instant` thì dịch vụ từ chối khởi động và câu lỗi nêu các
trường `gen_v2` cần khai. Script hash / policy của `gen_v2` suy từ địa chỉ, như `vaults`. Trong `feecover.apps`, ứng dụng `magic` không có
`token_sha256` — token của nó vào qua `FEECOVER_APP_TOKEN`; ứng dụng khác khai SHA-256 của
token của họ, dịch vụ không giữ token đó. Khoá của `purposes` là tên route: tám đường dựng
(`create-vault`, `instant-gen`, `refresh-checkpoint`, `schedule-commit`, `schedule-fire`,
`consume`, `open-thread`, `bind-did`) và bốn bước tài trợ (`sponsor-t1-open`, `sponsor-t2-fund`,
`sponsor-t3-draw`, `sponsor-t4-first-consume`); tên lạ ⟹ dịch vụ từ chối khởi động. Giá trị là
tên mục đích của Feecover và do Feecover đặt (bốn bước tài trợ bên đó dùng `sponsor_open` /
`sponsor_fund` / `sponsor_draw` / `sponsor_first_consume`). Route vắng khỏi bảng thì proxy trả
`400 FEE_PROXY_PURPOSE_UNMAPPED` cho tx của route đó. T2 cũng là khoá hợp lệ: `/tx/sponsor/t2-fund`
nhận `fee_payer` như ba bước kia, nhà tài trợ chỉ ký thêm cho UTxO CARP của mình; Feecover có trả
phí T2 hay không là việc của bảng mục đích, không phải của dịch vụ này.

`lamp.policy_id` đi qua `@magiclamp/sdk` ▸ `assertLampPolicyId` ngay lúc khởi động
(`parseDeployment`): policy nhái đã biết và LAMP THẬT của một đời đã bị thay đều bị từ chối,
dù chúng đúng 56 hex. Mẫu cũ ở đây ghi `28e916…` — đó chính là một policy nhái trong bảng
chặn, nên nay nó làm dịch vụ từ chối khởi động; đừng chép nó ra.

`lamp.rehearsal_ack` (tuỳ chọn, chuỗi) từng mở **lối tập dượt** cho một đời đã bị thay: chỉ có
tác dụng khi policy nằm trong `MagicSDK/src/lampPolicy.ts` ▸ `REHEARSAL_LAMP_POLICIES`,
giá trị bằng **ĐÚNG** `lamp.policy_id`, và `VAULT_TX_API_NETWORK` là `Preview`/`Preprod`.
**Lối này ĐÃ ĐÓNG từ 2026-10-04**: cụm tập dượt `8169b76c…` dừng, cụm phục vụ chạy trên
policy tLAMP Preprod cuối `493002cc…cfac`, và bảng tập dượt của SDK RỖNG. Nên mọi đời đã
bị thay, kể cả `8169b76c…` kèm ack đúng trên mạng thử, đều bị từ chối khởi động với câu lỗi
đời-đã-bị-thay. Trường `lamp.rehearsal_ack` vẫn được đọc và giữ trong `Deployment` (một ack
thừa cạnh policy cuối không làm hỏng gì), nhưng không còn mở được cửa nào. Hai đời `53bc12ad…` ·
`7ecbffe2…` cũng nằm trong bảng đã-bị-thay của SDK. Policy cuối KHÔNG gõ cứng trong dịch vụ
hay SDK — nó đi vào qua `lamp.policy_id`. `scripts/gen_vault_tx_api_deployment.ts` vẫn phát
trường này khi lượt sinh chạy với `LAMP_REHEARSAL_ACK` trong môi trường — không lấy từ sổ
trạng thái.

`script_hash` **không** cấu hình riêng — nó suy từ chính địa chỉ. Hai trường cho một sự
thật là hai trường sẽ lệch nhau.

**Khối két Prepaid** (`vault_type: "Prepaid"`, đường tài trợ PrepaidGen) có khuôn riêng,
quyết theo `vault_type` chứ không theo khoá nào có mặt:

```jsonc
{
  "vaults": [{ "vault_type": "Prepaid", "address": "addr_test1w…" }],   // Script(prepaid_vault)
  "paid_fund": { "address": "addr_test1w…",                            // BẮT BUỘC — Script(paid_fund)
                 "carp_unit": "<policy‖tên CARP>",                     // route /tx/sponsor/* cần; vắng ⟹ 501 CONFIG_MISSING
                 "sponsor": {                                          // ghim của T2; vắng ⟹ T2 trả 501 CONFIG_MISSING
                   "fund_units": ["<policy paid_fund‖fund_id>"],       // quỹ được nạp; policy phải là script paid_fund
                   "addresses": ["addr_test1v…"],                      // địa chỉ KHOÁ bên tài trợ, bech32 chính tắc, đúng mạng
                   "max_carp_amount": "1000000000" } },                // trần một lượt, CHUỖI 1–20 chữ số carpdrop, > 0
  "did_stake": { "anchor_nft_policy": "<56 hex>" },                    // T2 cần để định vị anchor DID
  "ref_script_utxos": {
    "vault": "…#0",       // ref-script prepaid_vault
    "paid_fund": "…#0",   // BẮT BUỘC — ref-script paid_fund
    "consume": "…#2"      // bản consume apply-param bằng hash két Prepaid
  }
  // KHÔNG có "shard_address" / "ref_script_utxos.shard": két Prepaid không có shard — khai ⟹ từ chối khởi động
}
```

Ba luật, mỗi luật từ chối khởi động khi vi phạm: két Prepaid không đứng chung khối với
loại khác (một ô `ref_script_utxos.vault`, một bản `consume` cho một loại két); khối không
phải Prepaid mà mang `paid_fund` là cấu hình lạc chỗ; khối Instant/Schedule vẫn **bắt buộc**
`shard_address` + `ref_script_utxos.shard` như cũ. Hiện chưa route nào dựng tx cho két
Prepaid ngoài `/tx/sponsor/*`: mọi route khác đụng tới nó trả `501 VAULT_KIND_UNSUPPORTED`. Bộ sinh:
`scripts/gen_vault_tx_api_deployment.ts --vault Prepaid`.

> Mọi địa chỉ và UTxO ở đây là **bản chép**: nguồn thật là lần deploy (`aiken build` +
> apply-param). Nên `source` là bắt buộc và `/health` in lại nguyên văn. Không có nhãn thì
> vài tháng nữa không ai trả lời được câu *"địa chỉ này còn đúng không"* — và một địa chỉ
> hết đúng thì dịch vụ trả `VAULT_NOT_FOUND` mãi mãi, im lặng, giống hệt "chủ này chưa có
> vault".

`ref_script_utxos` **không phải tối ưu**: đính kèm cả hai validator vào một giao dịch cho
**17 303 byte** đo thật trên Preview, vượt trần giao thức 16 384 — không có script tham
chiếu thì ScheduleCommit và Consume *không dựng nổi giao dịch nào*. Dịch vụ lấy chính
`scriptRef` từ các UTxO đó và **đối chiếu hash** với script hash của địa chỉ đang dùng;
lệch thì từ chối, vì một cấu hình trỏ nhầm sang lần deploy cũ vẫn dựng ra giao dịch trông
bình thường.

### Lệnh

```bash
npm install
npm test          # không cần mạng, không cần khoá — số bài: đọc dòng `Tests` của lệnh, đừng chép ra đây
npm run typecheck
npm start
```

---

## 7. 🔴 Một dữ kiện dịch vụ KHÔNG có: địa chỉ nhận tiền thừa

Khi app không gửi `change_address` (§3), yêu cầu chỉ mang khoá băm của chủ. Từ đó suy ra địa chỉ ví của người
dùng **chỉ đúng khi ví ấy là địa chỉ enterprise của đúng khoá đó**. Ví dùng địa chỉ **base**
(có phần stake) thì địa chỉ suy ra là một địa chỉ **khác**: tiền thừa rơi vào chỗ người dùng
không kiểm soát bằng ví đang dùng, và không có gì kêu lên cho tới khi họ đi tìm số dư.

Nên `VAULT_TX_API_CHANGE_ADDRESS_STRATEGY` **không có mặc định**. Người vận hành phải viết
ra chiến lược, tức phải biết mình đang khẳng định điều gì về ví của app. Hiện có đúng một
giá trị: `enterprise_from_owner_pkh`. `/health` in lại chiến lược đang chạy.

App nay gửi được `change_address` của chính nó (§3), và nên gửi. Chiến lược suy địa chỉ
chỉ còn áp cho chủ khoá không gửi trường đó; chủ script và `/tx/create-vault` luôn đòi nó.

Mục `did_stake` tuỳ chọn của `VAULT_TX_API_DEPLOYMENT`:

```jsonc
"did_stake": {
  "anchor_nft_policy": "<56 hex thường>",                    // tham số theo mạng của did_stake
  "unapplied_script": { "cbor": "<hex>", "hash": "<56 hex>" }, // tuỳ chọn — bật chủ {type:"did"}
  "did_payment_unapplied_script": { "cbor": "<hex>", "hash": "<56 hex>" } // tuỳ chọn — ví Phoenix nhận thưởng did_stake qua ví trả phí
}
```

Có thì đủ trường và đúng hình dạng, không thì cổng khởi động ném. `unapplied_script` là `did_stake`
CHƯA apply tham số, lấy từ sổ deploy của PhoenixKey-Validator cho đúng mạng; hai trường đi cặp (thiếu
một ⟹ lỗi cấu hình), và lúc khởi động dịch vụ băm lại `cbor` — lệch `hash` ⟹ **từ chối khởi động**
(mọi chủ DID sẽ được suy ra một script không phải của họ). Hash này đổi theo đời validator bên
PhoenixKey, nên nó chỉ sống ở cấu hình theo mạng, không ở mã. `scripts/gen_vault_tx_api_deployment.ts`
**chưa** sinh mục này — xem §8.

`did_payment_unapplied_script` là `did_payment` CHƯA apply, cùng nguồn, cùng luật băm-lại-và-so
(lệch ⟹ từ chối khởi động). Nó là bytecode công khai, không phải bí mật. Cần CẢ nó lẫn
`unapplied_script` để suy ví Phoenix của chủ: `unapplied_script` apply `(anchor_nft_policy, tên
anchor)` phải ra đúng hash của chủ — đó là phép nối anchor của nhân chứng với chủ. Vắng ⟹ chủ script
có thưởng > 0 đi qua ví trả phí nhận `422 FEE_PAYER_OWNER_REWARD_NONZERO`.

---

## 8. Còn thiếu — nói thẳng, không để người sau tự phát hiện

- **`did_stake.unapplied_script` chỉ được sinh khi có `--did-stake-blueprint <tệp>`.** Bộ sinh
  (`scripts/gen_vault_tx_api_deployment.ts` ▸ `didStakeScriptFromBlueprint`) đọc validator
  `did_stake.did_stake.withdraw` trong blueprint của PhoenixKey, băm lại `compiledCode` và so với
  khoá sổ trạng thái `DID_STAKE_UNAPPLIED_HASH`; sổ không có khoá đó hoặc hash lệch ⟹ bộ sinh ném,
  không đoán. Không có cờ ⟹ không phát `unapplied_script`, chủ `{type:"did"}` nhận `501
  OWNER_SCRIPT_WITNESS_UNAVAILABLE`. Chưa sổ cụm nào ghi khoá `DID_STAKE_UNAPPLIED_HASH`.
- **Trạng thái Active của anchor không kiểm off-chain.** Anchor bị thu hồi thì tx dựng xong
  vẫn bị `did_stake` từ chối lúc nộp, không phải lúc dựng.
- **Chưa có lượt nộp thật nào của đường chủ script hay `/tx/create-vault`.** Bài kiểm dùng
  bộ dựng ghi sẵn và nhân chứng giả; `SdkTxBuilder.createVault` chưa chạy trên Preview.

- **`funding` did_payment và `fee_payer` chưa qua Lucid thật, chưa lên chuỗi.** Bài kiểm của
  SDK dùng một trình dựng ghi lại lượt gọi, bài kiểm của dịch vụ đọc lại CBOR dựng bằng CML.
  Thế chấp được đặt tường minh (`fee_payer_collateral_lovelace`) chứ không để trình dựng tự
  chọn, và phép đọc lại CBOR ném `422` nếu thế chấp không lấy từ `fee_payer.utxo` hoặc
  `collateral_return` không về `fee_payer.address`. Chưa đo: ExUnit của `did_payment`; trạng
  thái Active của anchor không kiểm ở đây.
- **`fee_source: "did_payment"` chưa lên chuỗi, và dịch vụ chưa chạy nó qua Lucid.** Bài kiểm
  SDK (`MagicSDK/tests/didPaymentSelfFunded.test.ts`) dựng bằng Lucid thật, ngoại tuyến, với hai
  script luôn-đúng — nên nó kiểm HÌNH DẠNG giao dịch, không kiểm validator thật. Bài kiểm dịch vụ
  dùng CBOR ghi sẵn dựng bằng CML; `SdkTxBuilder.createVault` ở chế độ này chưa chạy lần nào. Chưa
  đo: phí thật khi đính inline vault + did_payment thật so với phần giữ chỗ 3 ADA; ExUnit.
- **Proxy phí mới chạy với Feecover giả.** Bài kiểm tiêm một `fetch` giả; chưa có lượt ký thật
  nào qua Feecover. Proxy không soi nội dung `witness_set` Feecover trả (chỉ đối chiếu
  `txHash`); app ghép rồi nộp, và nút chuỗi là nơi bác một chữ ký sai.
- **Sổ phát-hành và bảng giữ chỗ nằm trong bộ nhớ một tiến trình**, như khoá mềm: hai bản sau
  bộ cân tải thì `/fee/sign` chỉ nhận tx do chính bản đó phát.

- **`SdkTxBuilder` đã dựng giao dịch thật trên Preprod cho BỐN route, và chỉ bốn route đó.**
  Ngày 2026-09-27, trên một cụm tập dượt (tLAMP `8169b76c…`, chủ vault dạng khoá), dịch vụ
  chạy cục bộ đã dựng, được ký, nộp và vào khối: `create-vault` `7eed3990…` (khối 5225018),
  `instant-gen` qua `fee_payer` `66185661…`, `open-thread` qua `change_address` `a5c59940…`,
  `consume` qua `fee_payer` `64d33314…`. Hash đầy đủ tra được trên explorer Preprod theo tiền
  tố. Ba lỗi lộ ra ở lượt đó đã vá ở `370d3b49`.
  **Chưa chạy thật:** `schedule-commit`, `schedule-fire`, `burn-batch`, chủ dạng script
  (`did_stake`), `funding` did_payment (xem trên), và mọi route qua Feecover thật. Phần
  không-chuỗi (bộ định tuyến, khoá mềm, cổng cấu hình, đường `summary`) đo bằng CBOR thật dựng
  tại chỗ bằng CML.
- **Khoá mềm chỉ đúng với một tiến trình.** Hai bản sau bộ cân tải thì cần một chỗ giữ
  chung (Redis, hoặc một hàng đợi theo `owner_pkh`).
- **Cổng policy LAMP lúc khởi động chỉ chặn những gì ĐÃ BIẾT là sai.** `parseDeployment`
  nay gọi `assertLampPolicyId` (`MagicSDK/src/lampPolicy.ts`) — policy nhái đã biết và LAMP
  thật của một đời đã bị thay bị từ chối khởi động (`tests/config.test.ts` ▸ khối
  *"cổng policy LAMP"*). Nó KHÔNG chứng minh policy là chính danh: một policy nhái mới, chưa
  vào bảng, vẫn qua. Mẫu của bộ kiểm dùng một policy id **tổng hợp**
  (`tests/fixtures/preview.ts`), cố ý không phải giá trị có thật trên mạng nào, để không ai
  chép nhầm từ đó ra. Lối tập dượt (`lamp.rehearsal_ack`) từng là ngoại lệ **tạm** và đã
  đóng 2026-10-04: khoá `8169b76c…` gỡ khỏi bảng của SDK (cụm tập dượt dừng), không phải sửa
  dịch vụ.
- **Thẻ bài là MỘT bí mật dùng chung, không gắn với `owner_pkh` nào.** Đường `/tx/submit`
  đã chặn việc mượn dịch vụ để nộp giao dịch lạ (chỉ nộp thứ chính nó vừa dựng), nhưng
  người cầm thẻ bài vẫn dựng được giao dịch mang `owner_pkh` của người khác và qua đó giữ
  khoá mềm của họ. Trạng thái và hình dạng bản vá ghi ở `DevStatus.md` ▸ Nợ #78.
- **Chủ có nhiều vault chưa dựng được.** Hiện trả `409 VAULT_AMBIGUOUS`. Gỡ nó cần một
  trường định danh vault trong thân bài — lại là một quyết định về hình dạng API.
- **Thread Engage chọn theo chủ, chưa theo app.** Một chủ dùng nhiều app thì có nhiều thread
  và phải gửi `engage_ref`; dịch vụ chưa tự biết *tiêu cho app nào*.
- **Chưa có bộ nhớ đệm.** Mỗi lượt dựng là vài lượt gọi Blockfrost.
- **Chỉ Blockfrost.** `ChainReader` là giao diện; thêm Kupo/Ogmios là thêm một lớp hiện
  thực, không phải sửa lõi.
- **`DecodedVaultDatum` (`src/vaultDatumShape.ts`) là bản chép hình dạng.** Lược đồ thì
  dùng lại của MagicSDK, nhưng kiểu `VaultDatum` mà SDK xuất là kiểu của **lược đồ**, không
  phải của **giá trị** giải mã ra (`Data.from<T>(raw, type?: T): T`). Cái canh bản chép ấy
  là `tests/summary.test.ts`: mẫu ở đó đi qua chính `Data.to(…, VaultDatumSchema)`, nên
  lược đồ đổi hình là mẫu đổi theo.

---

## 9. Vì sao KHÔNG nhập vào `VaultReadAPI`

`VaultReadAPI` cố ý **ĐỌC-THÔI**: chỉ `GET`, không nhận khoá, không dựng giao dịch, không
ghi gì. Thêm một đường ghi vào đó là phá đúng thuộc tính khiến nó an toàn — và thuộc tính
ấy đọc được từ bề mặt của gói, không phải từ một lời hứa trong tài liệu.

Hai gói đứng cạnh nhau, không gói nào phụ thuộc gói nào. Vài hằng của Preview trong
`tests/fixtures/preview.ts` là **bản chép có nhãn** từ bộ mẫu của gói kia, và nhãn ghi rõ
chép từ đâu, ngày nào.
