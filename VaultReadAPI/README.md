# VaultReadAPI — mặt tiền ĐỌC-THÔI cho vault MAGIC

Sidecar HTTP để một backend **không phải TypeScript** (hiện tại: backend Java của
PhoenixKey) đọc được số MAGIC thật trong vault, mà **không phải chép lại cách giải mã
datum** sang ngôn ngữ thứ hai.

Nó **không** nhận khoá riêng, **không** dựng giao dịch, **không** ghi gì. Chỉ `GET`.

---

## 1. Vì sao thứ này ở nhà MAGIC chứ không ở nhà backend

Định nghĩa `VaultDatum` — thứ tự trường là hợp đồng nhị phân — sống ở
`MagicSDK/src/schemas.ts`. Từ 2026-09-21 nó là **hai** hình dạng chứ không một:
`VaultDatumSchema` (ScheduleGen · PrepaidGen) và `InstantVaultDatumSchema` (InstantGen,
thêm `instant_unlock_ms` ở cuối). Số trường không chép xuống đây — đếm ở chính tệp đó.
Bảo backend Java tự đọc datum là dựng **bản thứ hai** của
định nghĩa ấy, và bản thứ hai sẽ lệch ngay lượt đổi datum đầu tiên. Lệch kiểu đó không
kêu: nó ra một con số trông hợp lý.

Nên đường đọc datum ở lại đúng một chỗ, và mặt tiền này là cái cửa mở ra cho ngôn ngữ
khác. Cụ thể, nó dùng lại — không chép — ba thứ:

| dùng lại | ở đâu | vì sao không chép |
|---|---|---|
| `VaultDatumSchema` | `MagicSDK/src/schemas.ts` | thứ tự trường = hợp đồng nhị phân |
| `isBatchExpired` | `MagicSDK/src/burnBatch.ts` | gương của `ScheduleGen/onchain/validators/vault.ak` ▸ `is_expired` |
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

### `GET /vault/by-owner/{owner}`

| tham số | bắt buộc | nghĩa |
|---|---|---|
| `owner` (đường dẫn) | có | `key:<56 hex>` hoặc `script:<56 hex>` — chủ `Credential` của vault. `<56 hex>` trần là bí danh của `key:<56 hex>` (đường đời cũ `owner_pkh`) |

> Chủ `key:h` và chủ `script:h` cùng 28 byte là **hai chủ khác nhau**: mỗi truy vấn chỉ trả
> vault của đúng chủ đó. Thân bài mang `owner: { type, hash }` ở gốc và trên từng vault;
> `owner_pkh` giữ lại cho bên đọc đời cũ và là `null` khi chủ là script — bên đọc đời cũ
> gặp `null` thì phải đọc `owner`, đừng coi là "không có chủ".
>
> Gọi trong tiến trình (`resolveReadOwner` ở `src/service.ts`) nhận cả `owner` lẫn bí danh
> `ownerPkh`; hai trường cùng có mà chỉ hai chủ khác nhau ⟹ `400 OWNER_ALIAS_MISMATCH`.
| `vault_type` (truy vấn) | không | `Schedule` \| `Instant`. Bỏ trống = đọc mọi loại đã cấu hình |

> 🔴 **`vault_kind` trong thân bài là BẮT BUỘC, và nó không thừa so với `scopes_read`.**
> `scopes_read` nói *"lượt này đã soi những địa chỉ nào"*; `vault_kind` nói *"vault NÀY
> thuộc loại nào"*. Bỏ trống `vault_type` thì một lượt trả về vault của nhiều loại, và
> lúc đó `scopes_read` không ghép được vault nào với loại nào.
>
> Phải có vì **cùng một trường mang hai nghĩa tuỳ loại**: `consumed_credit_nanogic` là
> một **số dư tiêu được** ở vault `Instant` (bị đặt về 0 mỗi lượt InstantGen cấp) và là
> một **bộ đếm luỹ kế** ở vault `Schedule` (không nhánh nào đưa về 0). Chi tiết vòng đời:
> docblock trên `consumedCreditNanogic` ở `src/vaultView.ts`.
>
> Giá trị thuộc **tập ĐÓNG** `Instant | Schedule` (`src/config.ts` ▸ `VAULT_KINDS`), ép ở
> cổng khởi động. Bên gọi nên fail-closed: gặp giá trị ngoài tập đã biết thì **đừng vẽ con
> số**, vì một loại vault mới có thể mang nghĩa mới cho đúng trường đó.
| `at_epoch` (truy vấn) | không | ép epoch **giao thức**. Bỏ trống = lấy từ đỉnh chuỗi |

**Mã trả về — BA CA, BA MÃ. Đây là toàn bộ giá trị của mặt tiền này.**

| tình huống | mã | thân bài |
|---|---|---|
| chủ **có** vault | `200` | `{ vaults: [ … ], totals: { … } }` |
| chủ **chưa có** vault | `200` | `{ vaults: [], totals: { vault_count: 0, … } }` ← **không phải 404** |
| **không đọc được chuỗi** | `502` | `{ error: { code: "CHAIN_UNAVAILABLE", … } }` |
| datum của một vault **không giải mã được** | `502` | `{ error: { code: "VAULT_DATUM_UNDECODABLE", … } }` |
| hai UTxO cùng một NFT danh-tính | `409` | `{ error: { code: "VAULT_IDENTITY_DUPLICATE", … } }` |
| `owner` / `at_epoch` sai định dạng (tag lạ, hex sai, chữ hoa) | `400` | `BAD_REQUEST` |
| `owner` và bí danh `ownerPkh` (gọi trong tiến trình) chỉ hai chủ khác nhau | `400` | `OWNER_ALIAS_MISMATCH` |
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
      "vault_kind": "Schedule",
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

### Chỉ mục DID ⟹ thread: `GET /threads/*`

Thread = UTxO ở địa chỉ script `consume` (ConsumeMAGIC) mang **đúng một** NFT dưới policy
= script hash `consume` (tên 32 byte, `validate_mint_engage_id`), datum `EngageDatum` 5 trường.
Mỗi lần consume thread bị tiêu và tạo lại: UTxO đổi, NFT giữ nguyên. Bên dùng chính là
Wakeme, lấy UTxO thread làm reference input cho genesis. Nên **dữ liệu cũ phải lộ ra**, không
được trả như dữ liệu mới.

Cách chạy: một vòng đồng bộ **nền** (`src/threadIndex.ts` ▸ `ThreadIndex`) giữ bảng trong bộ
nhớ. Vòng đầu dựng từ ảnh chụp UTxO; các vòng sau **gia tăng** — đọc giao dịch mới ở từng địa
chỉ consume, gỡ đầu vào bị tiêu, thêm đầu ra mới. Reference input **không** tính là bị tiêu;
giao dịch trượt pha 2 chỉ tiêu collateral (`src/chain.ts` ▸ `normalizeTxEffect`). Lượt tra
chỉ đọc bảng, **không gọi chuỗi**.

**Độ trễ** = (đỉnh quan sát lần cuối − điểm đã đồng bộ) + ⌊thời gian trôi từ lần quan sát đó
/ `VAULT_READ_API_BLOCK_TIME_MS`⌋. Vế thứ hai bắt ca vòng đồng bộ đã chết: không có nó, một
chỉ mục ngừng từ hôm qua vẫn tự khai trễ 0. `tip_slot` cũng ngoại suy theo cùng đồng hồ.

Mọi đường `/threads/*` đòi thẻ bài như `/vault/by-owner`. Mọi số nguyên trong `datum` đi ra
dạng **chuỗi** thập phân (cùng lý do ở §3); slot và `lag_blocks` là số JSON.

#### `GET /threads/by-did/{did_commit}` — `did_commit` đúng 64 hex **thường**

Một DID có thể có nhiều thread, trên nhiều hash `consume`; sắp theo `consume_hash` rồi `utxo`.

```json
{
  "synced_slot": 20020, "tip_slot": 20020, "lag_blocks": 0,
  "threads": [{
    "consume_hash": "c1c1…c1", "policy": "c1c1…c1",
    "name": "d11bcc087038d0995a136690fe2ecf91259119db8e8d963df5fc86b745408d19",
    "utxo": "<txhash>#0",
    "datum": {
      "owner": { "type": "key", "hash": "1111…11" },
      "consumed_count": "12", "last_epoch": "20751",
      "did_commit": "9f9f…9f", "consumed_nanogic": "36000000"
    }
  }],
  "skipped_count": 0
}
```

`skipped_count` là số UTxO **mang NFT thread** trên **toàn chỉ mục** mà datum không đọc được —
chúng không gán được cho DID nào, nên khác 0 nghĩa là danh sách trên **có thể thiếu**. Chi
tiết từng cái ở `/threads/status`. DID không có thread (chỉ mục tươi) ⟹ `200` + `threads: []`.

#### `GET /threads/by-asset/{policy}.{name}` — policy 56 hex, tên 64 hex, chữ thường

```json
{ "synced_slot": 20020, "tip_slot": 20020, "lag_blocks": 0,
  "thread": { "consume_hash": "…", "policy": "…", "name": "…", "utxo": "<txhash>#0", "datum": { … } } }
```

#### `GET /threads/status` — chẩn đoán, không bao giờ 503 vì cũ

Điểm đồng bộ, `fresh`, số vòng, lỗi vòng gần nhất, và theo từng địa chỉ consume: số thread,
số `skipped`, số `ignored_no_nft` (UTxO ở địa chỉ consume **không** mang NFT đúng policy — ai
cũng đỗ được thứ đó, nên nó **không** vào chỉ mục). Liệt kê từng UTxO bị `skipped` kèm lý do
(`NO_INLINE_DATUM` · `DATUM_UNDECODABLE` · `OWNER_SHAPE` · `DID_COMMIT_LENGTH`).

#### Mã lỗi của `/threads/*`

| mã | HTTP | nghĩa |
|---|---|---|
| `INDEX_STALE` | 503 | trễ > `VAULT_READ_API_THREAD_STALE_BLOCKS`, hoặc **chưa đồng bộ lần nào**. KHÔNG kèm danh sách. `details`: `synced_slot`, `tip_slot`, `lag_blocks` (`null` khi chưa đồng bộ), `stale_threshold_blocks`, `reason` (`NEVER_SYNCED` \| `LAG_EXCEEDED`), `last_sync_error` |
| `THREAD_INDEX_DISABLED` | 503 | tiến trình không cấu hình địa chỉ consume nào |
| `THREAD_NOT_FOUND` | 404 | **chỉ khi tươi**: không UTxO nào đang mang NFT này |
| `UNKNOWN_CONSUME_SCOPE` | 404 | policy không nằm trong tập đang theo dõi — **không biết**, khác "không có" |
| `THREAD_DATUM_UNDECODABLE` | 502 | UTxO mang đúng NFT nhưng datum không đọc được |
| `THREAD_IDENTITY_DUPLICATE` | 409 | hai UTxO cùng mang một NFT — chỉ mục không nhất quán, không chọn hộ |
| `BAD_REQUEST` | 400 | DID / tài sản sai khuôn |

Ví dụ `503`:

```json
{ "error": { "code": "INDEX_STALE",
  "message": "Chỉ mục thread trễ 5 khối, quá ngưỡng 3. Danh sách có thể chứa UTxO đã bị tiêu — không trả.",
  "details": { "synced_slot": 20020, "tip_slot": 20120, "lag_blocks": 5, "stale_threshold_blocks": 3,
               "reason": "LAG_EXCEEDED", "last_sync_error": "CHAIN_UNAVAILABLE: …" } } }
```

Giới hạn đã biết của độ tươi: trong **một nhịp đồng bộ** (mặc định 20 giây) chỉ mục có thể
chưa thấy một lần tiêu vừa xảy ra mà vẫn tự khai tươi. Ngưỡng `lag_blocks` chặn phần trễ dài
hơn thế, không chặn phần này.

## 4. Vault nào được tính — và vault nào KHÔNG

Một UTxO ở địa chỉ vault chỉ được tính khi **mang NFT danh-tính vault**: đúng một token
có `policy_id == script hash của vault`, số lượng 1.

Lọc theo `datum.owner` **không đủ**. Địa chỉ script là công cộng: ai cũng đặt được một
UTxO ở đó với datum tự soạn, khai `owner` là PKH của người khác và khai bao nhiêu MAGIC
tuỳ thích. Validator từ chối đúng những UTxO ấy —
`ScheduleGen/onchain/validators/vault.ak` ▸ `validate_vault_value` và ▸ `has_vault_id_nft`
— nên mặt tiền đọc phải từ chối y hệt; nếu không nó báo một số dư mà **không giao dịch nào
chi ra được**.

> Neo ở đây cố ý là **tên hàm**, không phải số dòng: bản đầu của tệp này neo `:266` và
> `:867-869`, và hai neo đó chết ngay trong lần hoà kế tiếp — chúng vẫn trỏ vào dòng CÓ
> THẬT, chỉ là dòng khác. Đó là kiểu hỏng không kêu.

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
| `VAULT_READ_API_BASE_PATH` | không | rỗng — tiền tố đường khi đứng sau proxy định tuyến theo đường, ví dụ `/vaultread/preprod`; dịch vụ tự cắt nó (`src/basePath.ts`) |
| `VAULT_READ_API_TOKEN` | ngoài loopback thì **có** | rỗng |
| `VAULT_READ_API_BLOCKFROST_URL` | không | dẫn theo `NETWORK` |
| `VAULT_READ_API_TIMEOUT_MS` | không | `15000` |
| `VAULT_READ_API_CONSUME_SCOPES` | không (vắng ⟹ `/threads/*` trả 503 `THREAD_INDEX_DISABLED`) | — JSON `[{ "address", "source" }]`, cùng các cổng như `VAULT_READ_API_VAULTS` |
| `VAULT_READ_API_THREAD_STALE_BLOCKS` | không | `3` |
| `VAULT_READ_API_THREAD_SYNC_INTERVAL_MS` | không | `20000` |
| `VAULT_READ_API_BLOCK_TIME_MS` | không | `20000` (chỉ để ngoại suy độ trễ) |

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
npm test          # không cần mạng, không cần khoá (số bài: đọc dòng `Tests` của chính lệnh này)
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
- **Chỉ mục thread mới kiểm trên chuỗi GIẢ.** Ba luật chuẩn hoá của Blockfrost (cờ
  `reference`, cờ `collateral`, `valid_contract`) đã ghim bằng bài kiểm trên hình dạng tự
  dựng, **chưa** đối chiếu với phản hồi thật; thiếu cờ thì ném, không đoán.
- **Chỉ mục thread chưa tự chữa cuộn lại (rollback).** Đỉnh lùi dưới điểm đã đồng bộ thì dựng
  lại từ ảnh chụp; một cuộn lại ngắn không làm đỉnh lùi thì chưa bị phát hiện. Chưa có vòng
  dựng lại định kỳ.
- **Mới đo trên Preview + ScheduleGen.** Vault InstantGen dùng **cùng** `VaultDatum` nên
  đường đọc không đổi, nhưng chưa có lượt đo thật nào trên vault Instant.
