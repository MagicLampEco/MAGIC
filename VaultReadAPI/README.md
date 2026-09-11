# VaultReadAPI — mặt tiền ĐỌC-THÔI cho vault MAGIC

Sidecar HTTP để một backend **không phải TypeScript** (hiện tại: backend Java của
PhoenixKey) đọc được số MAGIC thật trong vault, mà **không phải chép lại cách giải mã
datum** sang ngôn ngữ thứ hai.

Nó **không** nhận khoá riêng, **không** dựng giao dịch, **không** ghi gì. Chỉ `GET`.

---

## 1. Vì sao thứ này ở nhà MAGIC chứ không ở nhà backend

Định nghĩa `VaultDatum` — 17 trường, thứ tự trường là hợp đồng nhị phân — sống ở
`MagicSDK/src/schemas.ts`. Bảo backend Java tự đọc datum là dựng **bản thứ hai** của
định nghĩa ấy, và bản thứ hai sẽ lệch ngay lượt đổi datum đầu tiên. Lệch kiểu đó không
kêu: nó ra một con số trông hợp lý.

Nên đường đọc datum ở lại đúng một chỗ, và mặt tiền này là cái cửa mở ra cho ngôn ngữ
khác. Cụ thể, nó dùng lại — không chép — ba thứ:

| dùng lại | ở đâu | vì sao không chép |
|---|---|---|
| `VaultDatumSchema` | `MagicSDK/src/schemas.ts` | thứ tự trường = hợp đồng nhị phân |
| `isBatchExpired` | `MagicSDK/src/burnBatch.ts` | gương của `is_expired`, `ScheduleGen/onchain/validators/vault.ak:630-632` |
| `posixMsToEpoch` | `ProtocolUtils/src/index.ts` | epoch giao thức ≠ epoch Cardano |

## 2. Vì sao chọn HTTP sidecar

Ba hình dạng khả dĩ, và lý do loại hai:

- **Gói npm** — Java không gọi được. Loại ngay.
- **CLI xuất JSON** — Java phải sinh một tiến trình mỗi lượt hỏi: cộng thêm ~1 giây khởi
  động Node cho mỗi lần tra số dư, và PKH phải đi qua ranh giới shell. Vẫn giữ **một
  bản** cho thao tác tay và để đối chứng: `npm run probe` (§6).
- **Sidecar HTTP** ✅ — Java gọi bằng bất kỳ thư viện HTTP nào, không FFI, không sinh
  tiến trình, một lần khởi động phục vụ mọi lượt.

Giá phải trả, nói thẳng: thêm một tiến trình phải chạy và phải canh. Đó là lý do có các
cổng fail-closed ở §5.

## 3. Hợp đồng

### `GET /vault/by-owner/{owner_pkh}`

| tham số | bắt buộc | nghĩa |
|---|---|---|
| `owner_pkh` (đường dẫn) | có | 56 ký tự hex thường — khoá băm thanh toán 28 byte của chủ vault |
| `vault_type` (truy vấn) | không | `Schedule` \| `Instant`. Bỏ trống = đọc mọi loại đã cấu hình |
| `at_epoch` (truy vấn) | không | ép epoch **giao thức**. Bỏ trống = lấy từ đỉnh chuỗi |

**Mã trả về — BA CA, BA MÃ. Đây là toàn bộ giá trị của mặt tiền này.**

| tình huống | mã | thân bài |
|---|---|---|
| chủ **có** vault | `200` | `{ vaults: [ … ], totals: { … } }` |
| chủ **chưa có** vault | `200` | `{ vaults: [], totals: { vault_count: 0, … } }` ← **không phải 404** |
| **không đọc được chuỗi** | `502` | `{ error: { code: "CHAIN_UNAVAILABLE", … } }` |
| datum của một vault **không giải mã được** | `502` | `{ error: { code: "VAULT_DATUM_UNDECODABLE", … } }` |
| hai UTxO cùng một NFT danh-tính | `409` | `{ error: { code: "VAULT_IDENTITY_DUPLICATE", … } }` |
| `owner_pkh` / `at_epoch` sai định dạng | `400` | `BAD_REQUEST` |
| thiếu/sai thẻ bài | `401` | `UNAUTHORIZED` |
| `vault_type` không có trong cấu hình | `404` | `UNKNOWN_VAULT_SCOPE` |
| method khác `GET` | `405` | `METHOD_NOT_ALLOWED` |

> 🔴 **Đừng gộp hàng 2 với hàng 3.** Gộp chúng là dựng lại đúng con số `0` mà backend
> đang trả cứng hôm nay: người dùng **có** MAGIC mà đường đọc gãy thì vẫn thấy `0`, và
> không có gì kêu lên. Mặt tiền đã đo: nút chuỗi chết ⇒ `502` **kể cả** khi hỏi một PKH
> không hề có vault.

### Thân bài `200`

```json
{
  "network": "Preview",
  "owner_pkh": "2e5e1418afd402e48232b143876104cac6188a44b867ffb7538318f4",
  "at_epoch": 20700,
  "at_epoch_source": "caller",
  "chain_tip": { "block_height": 4651991, "block_hash": "8059ee…", "block_time_posix_ms": "1789101326000" },
  "scopes_read": [ { "vault_type": "Schedule", "address": "addr_test1w…" } ],
  "vaults": [
    {
      "utxo_ref": "e5fd34b1…#0",
      "vault_address": "addr_test1w…",
      "vault_id_unit": "76a5aaa6…f181a6",
      "owner_pkh": "2e5e1418…",
      "available_nanogic": "64000000",
      "accrued_nanogic":   "64000000",
      "expired_nanogic":   "0",
      "consumed_credit_nanogic": "0",
      "lamp_balance_oildrop": "1001000000",
      "lamp_locked_oildrop":  "2000000",
      "profile": "Flame",
      "last_updated_epoch": 20700,
      "rate_locked_q": "8000000000",
      "batches": [ { "batch_id": "21f46e33…", "source": "Schedule", "created_epoch": 20700,
                     "decay_window": 1, "expires_at_epoch": 20701,
                     "initial_amount_nanogic": "8000000", "current_amount_nanogic": "8000000",
                     "live": true, "contract_id": "88ab4f79…" } ],
      "gen_schedules": [ { "schedule_id": "88ab4f79…", "rate_locked_q": "8000000000", "fired_count": 8, "…": "…" } ]
    }
  ],
  "totals": { "available_nanogic": "64000000", "accrued_nanogic": "64000000",
              "expired_nanogic": "0", "vault_count": 1 },
  "ignored": []
}
```

### 🔴 BA thứ bên Java PHẢI đọc đúng

**(a) MỌI trường tiền là CHUỖI chữ số, không phải số JSON.**
Đọc bằng `new BigInteger(s)`, **đừng** để Jackson ánh xạ vào `double`/`long` từ literal
số. Trần LAMP là `36×10^15` oildrop, còn `2^53 ≈ 9,007×10^15` — nghĩa là một trường
oildrop **có thật** vượt được ngưỡng an toàn của số dấu-phẩy-động, và lúc vượt thì nó
không lỗi, nó **làm tròn**. Đơn vị nằm ở **tên trường** (`_nanogic`, `_oildrop`, `_q`),
không nằm ở giá trị.

**(b) `available_nanogic` ≠ `accrued_nanogic`, và bạn cần CẢ HAI.**

- `available_nanogic` — Σ batch **còn sống** tại `at_epoch`. Đây là số **tiêu được**.
- `accrued_nanogic` — Σ **mọi** batch còn ghi trong datum, kể cả đã chết.
- `expired_nanogic` = `accrued − available`. MAGIC đã mất trắng, sẽ bị dọn ở lần tiêu kế.

MAGIC là **dùng-hết-hoặc-mất theo epoch** (§4.2), và với ScheduleGen thì
`decay_window = 1` (`ScheduleGen/onchain/lib/magiclamp/protocol/constants.ak:35`) —
batch chỉ sống đúng epoch sinh ra nó. Nên một vault **vừa** "đã sinh 64 000 000 nanogic"
**vừa** "tiêu được 0 nanogic hôm nay", và cả hai câu đều đúng. Màn hình chỉ hiện một con
số là buộc người dùng đoán nó là con số nào.

Gợi ý hiển thị: số lớn là `available` (tiêu được **bây giờ**); `accrued`/`expired` là
dòng phụ ("đã sinh trong kỳ" / "đã hết hạn"). Đừng cộng `available` với `expired`.

**(c) `at_epoch` là epoch GIAO THỨC, không phải epoch Cardano.**
Validator tính `epoch = posix_ms / ms_per_epoch` và **không trừ genesis**, nên hai số
không bao giờ gặp nhau. Đo thật trên Preview 2026-09-11: epoch Cardano = **1417**, epoch
giao thức = **20707**. Đem `at_epoch` so với số epoch của explorer là đọc nhầm đồng hồ.
Thân bài luôn kèm `chain_tip` để bên gọi tự đối chiếu được.

### `GET /health`

Không cần thẻ bài, không chạm chuỗi. In lại **nhãn nguồn** của từng địa chỉ vault đang
phục vụ — thứ duy nhất trả lời được câu *"địa chỉ này chép từ đâu, bao giờ"*.

## 4. Vault nào được tính — và vault nào KHÔNG

Một UTxO ở địa chỉ vault chỉ được tính khi **mang NFT danh-tính vault**: đúng một token
có `policy_id == script hash của vault`, số lượng 1.

Lọc theo `datum.owner` **không đủ**. Địa chỉ script là công cộng: ai cũng đặt được một
UTxO ở đó với datum tự soạn, khai `owner` là PKH của người khác và khai bao nhiêu MAGIC
tuỳ thích. Validator từ chối đúng những UTxO ấy
(`ScheduleGen/onchain/validators/vault.ak:266` và `:867-869`), nên mặt tiền đọc phải từ
chối y hệt — nếu không nó báo một số dư mà **không giao dịch nào chi ra được**.

UTxO bị bỏ qua được **đếm và khai** ở `ignored[]` kèm lý do (`NO_VAULT_ID_NFT`,
`NO_INLINE_DATUM`, `OWNER_MISMATCH`). Rỗng là bình thường; khác rỗng là thứ người vận
hành nên nhìn.

Ngược lại: **một chủ có nhiều vault là hợp lệ** (khác thời hạn, khác profile) và chúng
**được cộng dồn**. Cái không hợp lệ là hai UTxO mang **cùng một** NFT danh-tính — bất
khả trên sổ cái đã lắng, nên thấy là `409`, không cộng. Đó là lá chắn chống đếm hai lần
khi nhà cung cấp dữ liệu trả ảnh chụp giữa chừng một lần tiêu.

## 5. Ranh giới an toàn — ai phân quyền cho ai

**Mặt tiền này KHÔNG phân quyền theo người dùng cuối, và đó là quyết định có chủ đích.**
Nó không có phiên, không có DID, không có cách nào xác thực rằng người gọi *là* chủ của
PKH đang hỏi. Dựng một lớp phân quyền ở đây là diễn kịch.

Dữ liệu nó trả về vốn **công khai**: datum vault nằm trên chuỗi, ai có một nút Cardano
cũng đọc được y hệt. Cái mặt tiền đổi là **chi phí** — nó biến một phép tra cứu đắt
thành một lời gọi rẻ, nên nó hạ giá của việc dò hàng loạt `PKH → số dư`, và việc đó ghép
với liên kết PersonDID↔PKH mới là chỗ đau. Nó cũng chạy bằng **khoá Blockfrost của người
vận hành**, nên phơi ra ngoài là biếu luôn hạn mức.

Ranh giới đúng, hai vế:

1. **Mặt tiền** — mặc định bind `127.0.0.1`. Muốn bind ra ngoài loopback thì **bắt buộc**
   có `VAULT_READ_API_TOKEN`; thiếu là **từ chối khởi động** (fail-closed, không cảnh báo
   rồi chạy tiếp).
2. **Backend Java** — nó đã biết phiên thuộc PersonDID nào, nên **nó** tự tra `DID → PKH`
   và **không bao giờ** chuyển tiếp một PKH do người gọi đưa vào.

Ngoài ra: chỉ nhận `GET`; nhánh lỗi không in traceback, không in đường dẫn nội bộ, không
in khoá; `/health` không lộ URL đầy đủ của nút chuỗi, chỉ lộ host.

## 6. Chạy

### Cấu hình (biến môi trường — đặt ngay trước lệnh, đừng ghi vào tệp)

| biến | bắt buộc | mặc định |
|---|---|---|
| `VAULT_READ_API_NETWORK` | có | — (`Preview` \| `Preprod` \| `Mainnet`) |
| `BLOCKFROST_PROJECT_ID` | có | — **GIÁ TRỊ** khoá, không phải đường dẫn |
| `VAULT_READ_API_VAULTS` | có | — JSON, xem dưới |
| `VAULT_READ_API_HOST` | không | `127.0.0.1` |
| `VAULT_READ_API_PORT` | không | `8787` |
| `VAULT_READ_API_TOKEN` | ngoài loopback thì **có** | rỗng |
| `VAULT_READ_API_BLOCKFROST_URL` | không | dẫn theo `NETWORK` |
| `VAULT_READ_API_TIMEOUT_MS` | không | `15000` |

`VAULT_READ_API_VAULTS` — mỗi mục **bắt buộc** có `source`:

```json
[{ "vault_type": "Schedule",
   "address":    "addr_test1wpm2t24x02y7lkqw3f8yyarz5j844x8a3jzsx9wcrv5900cv2wj6x",
   "source":     "Preview ScheduleGen, đọc từ chuỗi 2026-09-11 qua tx e5fd34b1…" }]
```

`script_hash` **không** cấu hình riêng — nó suy từ chính địa chỉ. Hai trường cho một sự
thật là hai trường sẽ lệch nhau.

> Địa chỉ vault là một **bản chép**: nguồn thật của nó là lần deploy
> (`aiken build` + apply-param), không phải tệp cấu hình này. Nên `source` là bắt buộc
> và `/health` in lại nguyên văn. Không có nhãn thì vài tháng nữa không ai trả lời được
> câu "địa chỉ này còn đúng không" — và một địa chỉ hết đúng thì mặt tiền trả
> `{vaults: []}` mãi mãi, im lặng, giống hệt "chủ này chưa có vault".

### Lệnh

```bash
npm install
npm test          # 44 bài, không cần mạng, không cần khoá
npm run typecheck
npm start                     # sidecar
npm run probe -- <owner_pkh> [at_epoch]    # hỏi một lần, in JSON, không mở cổng
```

`probe` đi qua **cùng** `VaultReadService` với sidecar, nên nó cũng là phép đối chứng:
hai đường ra hai số khác nhau thì một trong hai sai.

## 7. Còn thiếu — nói thẳng, không để người sau tự phát hiện

- **Địa chỉ vault vẫn là bản chép có nhãn, chưa phải bản sinh.** Mức đúng hơn là suy địa
  chỉ từ `plutus.json` + apply-param bằng `applyVaultValidator` của MagicSDK. Chưa làm vì
  `plutus.json` là hiện vật `aiken build` (đã gitignore), nên sidecar sẽ đòi một bước dựng
  Aiken trước khi chạy. Đánh đổi đã chọn: nhãn bắt buộc + `/health` in nhãn.
- **Chưa có bộ nhớ đệm.** Mỗi lượt hỏi là một lượt gọi Blockfrost. Đủ cho lưu lượng hiện
  tại; không đủ cho một màn hình tự làm mới.
- **Chỉ Blockfrost.** `ChainReader` là giao diện, thêm Kupo/Ogmios là thêm một lớp hiện
  thực, không phải sửa lõi.
- **Mới đo trên Preview + ScheduleGen.** Vault InstantGen dùng **cùng** `VaultDatum` nên
  đường đọc không đổi, nhưng chưa có lượt đo thật nào trên vault Instant.
