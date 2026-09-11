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
POST /tx/schedule-commit   { owner_pkh, schedule_length, lamp_per_epoch }
POST /tx/schedule-fire     { owner_pkh, schedule_id }
POST /tx/consume           { owner_pkh, op_type, op_count }
POST /tx/submit            { tx_cbor, witness_cbor }
GET  /health
```

Ba đường đầu trả:

```jsonc
{
  "tx_cbor": "84a4…",        // giao dịch CHƯA KÝ
  "tx_hash": "3f1c…",        // hash THÂN giao dịch — app đối chiếu sau khi ký
  "summary": { … },          // §2
  "expires_at": "2026-09-11T16:28:03.000Z",
  "ignored": []              // UTxO ở địa chỉ vault cố ý không tính, kèm lý do
}
```

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
| thiếu/sai thẻ bài | `401 UNAUTHORIZED` |
| chủ **chưa có** vault | `404 VAULT_NOT_FOUND` ← **không phải** `200` với tx rỗng |
| method sai | `405 METHOD_NOT_ALLOWED` |
| chủ đã có một tx dựng xong chưa nộp | `409 OWNER_TX_IN_FLIGHT` |
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

Nên `409 OWNER_TX_IN_FLIGHT`, và khoá **giữ tới lúc nộp**, không nhả ngay sau khi dựng:
nhả sớm thì không chặn được gì, vì UTxO vault vẫn chưa bị tiêu. Ba đường mở khoá:
`/tx/submit` đúng giao dịch đó · hết hạn (`VAULT_TX_API_LOCK_TTL_MS`, mặc định 180 s, cũng
là `expires_at`) · dựng hỏng thì nhả ngay.

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
| `VAULT_TX_API_HOST` | không | `127.0.0.1` |
| `VAULT_TX_API_PORT` | không | `8788` |
| `VAULT_TX_API_TOKEN` | ngoài loopback thì **có** | rỗng |
| `VAULT_TX_API_BLOCKFROST_URL` | không | dẫn theo `NETWORK` |
| `VAULT_TX_API_TIMEOUT_MS` | không | `20000` |
| `VAULT_TX_API_LOCK_TTL_MS` | không | `180000` |

Cổng fail-closed lúc khởi động: thiếu biến bắt buộc · bind ngoài loopback mà thẻ bài rỗng ·
tên tài sản LAMP không khớp mạng (`tLAMP` testnet / `LAMP` mainnet — apply-param #2) · địa
chỉ sai tiền tố mạng · địa chỉ không phải địa chỉ script · hai mục vault trùng địa chỉ ·
blueprint không đọc được. Tất cả **từ chối khởi động**, không cảnh báo rồi chạy tiếp — người
bị chặn lúc khởi động là người vận hành, còn hoãn sang lúc chạy thì người bị chặn là người
dùng.

```jsonc
// VAULT_TX_API_DEPLOYMENT
{
  "source": "Preview, deploy 2026-09-11, tx e5fd34b1…",   // BẮT BUỘC — xem dưới
  "lamp":   { "policy_id": "28e916…", "asset_name_hex": "744c414d50" },
  "vaults": [{ "vault_type": "Schedule", "address": "addr_test1w…" }],
  "shard_address": "addr_test1w…",
  "ref_script_utxos": { "vault": "…#0", "shard": "…#1", "consume": "…#2" },
  "consume": {
    "engage_address": "addr_test1w…",       "engage_nft_unit": "…",
    "price_beacon_address": "addr_test1w…", "price_beacon_nft_unit": "…"
  }
}
```

`script_hash` **không** cấu hình riêng — nó suy từ chính địa chỉ. Hai trường cho một sự
thật là hai trường sẽ lệch nhau.

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
npm test          # 56 bài, không cần mạng, không cần khoá
npm run typecheck
npm start
```

---

## 7. 🔴 Một dữ kiện dịch vụ KHÔNG có: địa chỉ nhận tiền thừa

Yêu cầu chỉ mang `owner_pkh` — một khoá băm thanh toán. Từ đó suy ra địa chỉ ví của người
dùng **chỉ đúng khi ví ấy là địa chỉ enterprise của đúng khoá đó**. Ví dùng địa chỉ **base**
(có phần stake) thì địa chỉ suy ra là một địa chỉ **khác**: tiền thừa rơi vào chỗ người dùng
không kiểm soát bằng ví đang dùng, và không có gì kêu lên cho tới khi họ đi tìm số dư.

Nên `VAULT_TX_API_CHANGE_ADDRESS_STRATEGY` **không có mặc định**. Người vận hành phải viết
ra chiến lược, tức phải biết mình đang khẳng định điều gì về ví của app. Hiện có đúng một
giá trị: `enterprise_from_owner_pkh`. `/health` in lại chiến lược đang chạy.

Cách sửa đúng về lâu dài là app gửi kèm địa chỉ đổi tiền thừa của chính nó. Việc đó đổi
hình dạng thân bài của ba đường dựng, nên nó là một quyết định, không phải một lần vá.

---

## 8. Còn thiếu — nói thẳng, không để người sau tự phát hiện

- **`SdkTxBuilder` CHƯA từng dựng một giao dịch thật trên chuỗi.** Nó qua `tsc --noEmit` và
  qua bài quét không-chạm-khoá, và nó gọi đúng bốn hàm của `@magiclamp/sdk` với chữ ký
  thật. Nhưng chạy nó cần một lần deploy sống (script tham chiếu, shard, beacon giá, thread
  Engage) mà lượt dựng gói này không có. **Đừng đọc "biên dịch xanh" thành "chạy đúng".**
  Phần đã đo bằng thực thi là: bộ định tuyến, khoá mềm, cổng cấu hình, và toàn bộ đường
  `summary` — chúng chạy trên CBOR thật dựng tại chỗ bằng CML.
- **Khoá mềm chỉ đúng với một tiến trình.** Hai bản sau bộ cân tải thì cần một chỗ giữ
  chung (Redis, hoặc một hàng đợi theo `owner_pkh`).
- **Chủ có nhiều vault chưa dựng được.** Hiện trả `409 VAULT_AMBIGUOUS`. Gỡ nó cần một
  trường định danh vault trong thân bài — lại là một quyết định về hình dạng API.
- **`/tx/consume` chọn thread Engage từ cấu hình**, nên một triển khai phục vụ nhiều app
  cùng lúc chưa nói được *tiêu cho app nào*. Cùng họ với gạch trên.
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
