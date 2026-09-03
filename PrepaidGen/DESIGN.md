# PrepaidGen — Thiết kế module (v0.1)

> **Phạm vi:** cửa sinh MAGIC thứ ba theo `SPEC/MagicLamp-Tripletoken-Feat-(Vi).md §6.5` —
> khoá CARP vào quỹ Paid của platform, đổi thành quyền-tiêu MAGIC gắn DID, một chiều, tự-back.
> **Nguồn chân lý:** §4 (MAGIC per-epoch), §5 (giao diện CARP), §6.5, §7 (ConsumeMAGIC — interface
> KHOÁ), §11 (hằng số + constructor index), §12 (bất biến). Bổ sung: `Carpet-CARP-DacTa-Vi.md §5.1`
> (quỹ Paid, F2 chống Prepaid-default), `ConsumeMAGIC/CONTRACT.md` v2.
> **Trạng thái:** thiết kế + triển khai đầy đủ on-chain/off-chain; các điểm phía CARP chưa chốt được
> đánh dấu `[CẦN XÁC NHẬN]` và đã gửi thư hỏi
> (`CARP/_Agents/inbox/magic-prepaidgen-quy-paid-schema-2026-07-24.md`).

---

## 1. Bản chất cơ chế + quyết định thiết kế cốt lõi

### 1.1 Hai bước, không phải một

§6.5 viết: "App/user **khoá CARP** → quỹ Paid platform; **mỗi lần user tiêu**, một phần CARP →
quyền-tiêu MAGIC gắn DID." Câu này tách rõ hai thời điểm khác nhau, và §4.2 (`decay_window = 1`,
dùng-hoặc-mất) ép phải tách:

- Nếu khoá X CARP mà sinh ngay X MAGIC vào batch của epoch hiện tại, thì gần như toàn bộ chết ở
  cuối epoch đó. Trả trước 1000 CARP để tiêu dần trong 3 tháng sẽ mất sạch sau một epoch.
- Vì vậy CARP khoá vào quỹ được ghi thành **hạn-mức** (`PrepaidCredit.remaining`, đơn vị carpdrop)
  nằm ở vault người dùng. Hạn-mức **không phải MAGIC**, không hết hạn, không tiêu được trực tiếp.
- Người dùng **rút** (`PrepaidDraw`) đúng lượng cần tiêu trong epoch hiện tại → sinh `MagicBatch`
  với `created_epoch = epoch hiện tại`, `decay_window = 1`.

Kết quả: giữ nguyên bất biến trung tâm §4.2 (MAGIC không cộng dồn, không hoard) mà vẫn đúng nghĩa
"trả trước dùng dần" của Prepaid. Đây cũng là cách hoà giải mâu thuẫn giữa §4.2 (canonical, mọi
batch cliff 1 epoch) và `Carpet-CARP-DacTa-Vi.md §5.4` ("Prepaid → dài hơn"): **cái sống dài là
hạn-mức, không phải MAGIC**.

### 1.2 Par 1:1 chính xác, không làm tròn

`Carpet-CARP-DacTa-Vi.md §3.1`: "1 CARP khoá → luôn ra 1 MAGIC". Đổi ở tầng đơn vị cơ sở:

```
par_scale = nanogic_per_magic / carpdrop_per_carp = 10^9 / 10^6 = 1000
nanogic = carpdrop × par_scale          (phép nhân — chính xác tuyệt đối, không mất số dư)
carpdrop = ⌊ nanogic / par_scale ⌋      (chiều ngược, chỉ dùng cho trần đòi của provider)
```

Không có phí par, không có hệ số Q. `[CẦN XÁC NHẬN]` decimals của CARP = 6 (chưa có tài liệu CARP
xác nhận; suy từ tLAMP decimals 6). Nếu khác, chỉ đổi hằng `par_scale`.

### 1.3 Hết hạn thì trả lại HẠN-MỨC, không trả lại CARP

MAGIC đã rút mà không tiêu hết trong epoch thì chết (§4.2). Nếu để chết luôn thì phần CARP đối ứng
kẹt vĩnh viễn trong quỹ: người dùng mất, provider cũng không đòi được (F2 chỉ cho đòi phần đã tiêu
thật). Quỹ tích tụ CARP vô chủ.

Xử: `PrunePrepaid` (permissionless, §7.4) khi dọn batch chết sẽ **cộng lại** `⌊current_amount /
par_scale⌋` vào `PrepaidCredit.remaining` của đúng quỹ đó.

Điều này **không phá F2**: không có CARP nào rời quỹ, không có đường về LAMP/tiền, hạn-mức vẫn chỉ
đi được một chiều duy nhất là thành dịch vụ. Nó chỉ tránh phạt người dùng vì lỡ nhịp epoch. Đối
chiếu `Forall §Cơ chế phạt`: phần chưa giao dịch vụ là **quyền chưa hình thành**, không được tịch
thu bằng một lỗi canh giờ.

Sai số: `⌊/par_scale⌋` làm mất tối đa 999 nanogic (< 10⁻⁶ MAGIC) mỗi lần dọn — lệch về phía **an
toàn** (hạn-mức trả lại ít hơn, quỹ không bao giờ thiếu backing).

### 1.4 Không đụng backing chung

§6.5: "Không cần cổng-thặng-dư/br". Triển khai theo nghĩa **cấu trúc**, không phải theo nghĩa "quên
kiểm tra": validator PrepaidGen **không nhận tham số nào liên quan LAMP**, không đọc `br`, không đọc
GreenBack, không đọc oracle. Không có đường code nào chạm backing chung (C-PP-14). Đây là thứ khiến
PrepaidGen "không giới hạn số lượng" mà vẫn an toàn.

### 1.5 Ranh giới với ConsumeMAGIC (interface KHOÁ)

PrepaidGen là một **generator vault** theo đúng mô hình §7.3: `consume.ak` co-spend vault, đọc
redeemer `BurnBatch` qua `un_constr_data` với `burn_batch_constr` per-vault. Vì vậy:

- `BurnBatch` của PrepaidGen đặt ở **constructor index 2**, giống InstantGen và ScheduleGen
  (bảng §11). `[CẦN XÁC NHẬN]` §11 chưa có dòng cho PrepaidGen — chọn 2 để `burn_batch_constr` đồng
  nhất trên mọi vault đang deploy.
- Chữ ký `BurnBatch { burns: List<(ByteArray, Int)> }` giữ **y hệt** ScheduleGen/InstantGen để
  `consume.ak` giải mã không cần biết vault nào.
- PrepaidGen **không** định giá, **không** ghi `EngageDatum`, **không** `tx.mint`. Giá đến từ beacon
  `PriceParam` phía ConsumeMAGIC.

---

## 2. Kiến trúc trên chuỗi

```
       CARP ví platform/user
              │  PrepaidLock (vault authoritative)
              ▼
  ┌──────────────────────┐        đọc để quyết toán
  │  PaidFund UTxO       │◄───────────────────────────┐
  │  NFT one-shot        │                            │
  │  carp_locked         │                            │
  │  credit_issued       │        FundSettle          │
  │  magic_settled       │  (fund authoritative)      │
  │  provider_claimed    │                            │
  └──────────┬───────────┘                            │
             │ FundClaim ≤ trần F2                    │
             ▼                                        │
        ví provider                                   │
                                                      │
  ┌──────────────────────┐   PrepaidDraw   ┌──────────┴──────────┐
  │ PrepaidVault UTxO    │ ─────────────►  │  MagicBatch epoch e │
  │ prepaid_credits      │   hạn-mức→MAGIC │  decay_window = 1   │
  │ magic_batches        │                 └─────────┬───────────┘
  │ did_commit           │   PrunePrepaid            │ BurnBatch
  │ personal_delegate    │ ◄─────────────  (chết)    ▼
  └──────────────────────┘   trả lại hạn-mức    dịch vụ (ConsumeMAGIC)
```

### 2.1 Ba script

| Script | Vai | Tham số |
|---|---|---|
| `fund_nft` (minting) | đúc NFT định danh quỹ, tên = `blake2b_224(tx_id ∥ idx)` của một input bị tiêu → không trùng, không đúc lại được | không có |
| `paid_fund` (spend) | giữ CARP khoá + sổ quỹ; quyết toán (`FundSettle`) và trả provider (`FundClaim`) | `carp_policy_id`, `carp_asset_name`, `fund_nft_policy`, `ms_per_epoch` |
| `prepaid_vault` (spend) | hạn-mức + `magic_batches` của một người dùng | `carp_policy_id`, `carp_asset_name`, `fund_nft_policy`, `paid_fund_hash`, `ms_per_epoch` |

**Thứ tự deploy (không có vòng tham chiếu):** `fund_nft` (không phụ thuộc gì) → `paid_fund` (nhận
`fund_nft_policy`) → `prepaid_vault` (nhận `paid_fund_hash` + `fund_nft_policy`).

Chiều ngược (quỹ cần biết vault) **không** đi qua tham số biên dịch — nếu đi thì thành vòng
`vault → fund → vault`. Thay vào đó `PaidFundDatum.vault_hash` được **ghim tại genesis** bởi chính
`fund_nft` và bất biến sau đó. Nhờ vậy:

- Vault xác thực quỹ bằng **địa chỉ** (`paid_fund_hash`) **+ NFT** → người dùng không thể bị lừa
  khoá CARP vào một "quỹ" giả.
- Quỹ xác thực vault bằng `datum.vault_hash` → không thể bị một datum vault giả bơm `magic_settled`.

Đây là chỗ thiết kế này **khác** khuôn ScheduleGen: `shard.ak` chấp nhận bất kỳ input nào giải mã
được thành `VaultDatum` (không ghim hash), vì ở đó shard chỉ là bên phụ thuộc. Ở PrepaidGen quỹ là
bên **có thẩm quyền** khi quyết toán, nên phải ghim hash — nếu bê nguyên khuôn shard thì kẻ tấn công
dựng script luôn-đúng với datum trông giống vault là bơm được `magic_settled` rồi rút CARP.

### 2.2 Ai có thẩm quyền cho từng delta

Nguyên tắc: **mỗi biến đổi có đúng MỘT bên kiểm toàn bộ delta**, bên kia chỉ chứng minh có bên kia
cùng tiêu trong giao dịch (chống desync — bài học `C-SCH-SHARD-BIND`).

| Việc | Bên có thẩm quyền | Bên còn lại kiểm gì |
|---|---|---|
| `PrepaidLock` | **vault** — kiểm cả delta quỹ (`carp_locked`, `credit_issued`) lẫn delta hạn-mức | quỹ: có đúng 1 vault input tại `datum.vault_hash` tiêu bằng constr 0; các trường bất biến của quỹ không đổi; `carp_locked` khớp value |
| `PrepaidDraw` | **vault** (quỹ không tham gia giao dịch) | — |
| `PrunePrepaid` | **vault** (quỹ không tham gia) | — |
| `BurnBatch` | **vault** | ConsumeMAGIC ép `Σburns == required` |
| `FundSettle` | **quỹ** — đọc thẳng cặp datum vào/ra của vault | vault chạy `BurnBatch` như thường, không biết đến quỹ |
| `FundClaim` | **quỹ** | — |

---

## 3. Datum / Redeemer

Thứ tự trường = thứ tự mã hoá Plutus Data. Đổi thứ tự một bên là hỏng giải mã bên kia (§11).

### 3.1 `MagicBatch` — theo đúng §4.1 canonical (7 trường)

```
MagicBatch {
  batch_id            : ByteArray,
  source              : Int,        // 3 = Prepaid  (§4.1: 1=Instant 2=Schedule 3=Prepaid)
  created_epoch       : Int,
  current_amount      : Int,        // nanogic
  decay_window        : Int,        // luôn = 1
  profile_at_creation : Int,        // luôn = 0 — PrepaidGen không dùng tư-cách (§6.5 không có cổng)
  contract_id         : ByteArray,  // = fund_id (quỹ Paid nào đứng sau batch này)
}
```

`source` để **Int** đúng như §4.1 viết, không dùng enum — tránh nhập nhằng giữa "số 3" của spec và
constructor index của một enum cục bộ. ScheduleGen dùng enum 4 nhánh + thêm `initial_amount`,
`halved`, `Option<...>`; đó là hình dạng **cũ** (trước mô hình chốt 2026-07-23) và §4.1 là bản đè.

### 3.2 `PrepaidCredit` — một dòng cho mỗi quỹ

```
PrepaidCredit {
  fund_id         : ByteArray,   // khoá — mỗi fund_id tối đa 1 dòng trong một vault
  remaining       : Int,         // carpdrop chưa rút thành MAGIC
  issued_epoch    : Int,         // epoch khoá lần đầu
  last_draw_epoch : Int,
}
```

Khoá theo `fund_id` (không có `credit_id` riêng) để `PrunePrepaid` biết trả hạn-mức về đâu **không
nhập nhằng**. Dòng hạn-mức **không bao giờ bị xoá**, kể cả `remaining == 0` — nếu xoá thì batch chết
sau đó không còn chỗ để trả lại. Trần `MAX_PREPAID_CREDITS = 20` quỹ / vault.

### 3.3 `PrepaidVaultDatum`

```
PrepaidVaultDatum {
  owner              : ByteArray,          // payment pkh
  did_commit         : ByteArray,          // §7.5 — đặt 1 lần lúc tạo vault, BẤT BIẾN
  prepaid_credits    : List<PrepaidCredit>,
  magic_batches      : List<MagicBatch>,
  next_batch_index   : Int,
  personal_delegate  : Option<ByteArray>,  // §7.6 Paymaster
  last_updated_epoch : Int,
  attribution        : VaultAttribution,   // {attribution_root, last_event_epoch, total_events}
}
```

Không có `lamp_balance`, `lamp_locked`, `loyalty_holdings`, `gen_schedules`, `profile` — PrepaidGen
không chạm LAMP (C-PP-14) và không dùng tư-cách.

### 3.4 `PaidFundDatum`

```
PaidFundDatum {
  fund_id            : ByteArray,   // == asset name của NFT quỹ, bất biến
  platform           : ByteArray,   // pkh provider — người ký FundClaim, bất biến
  vault_hash         : ByteArray,   // script hash prepaid_vault, ghim genesis, bất biến
  carp_locked        : Int,         // carpdrop — LUÔN == CARP thật trong UTxO
  credit_issued      : Int,         // cộng dồn, chỉ tăng ở Lock
  magic_settled      : Int,         // nanogic cộng dồn đã chứng minh tiêu thật
  provider_claimed   : Int,         // carpdrop cộng dồn đã trả provider
  buffer_bps         : Int,         // ≥ 1500, bất biến
  last_updated_epoch : Int,
}
```

### 3.5 Redeemer

```
PrepaidVaultRedeemer                         constr
  PrepaidLock { fund_id, amount_carpdrop }      0
  PrepaidDraw { fund_id, amount_carpdrop }      1
  BurnBatch   { burns }                         2   ← KHOÁ, khớp §7.3 / §11
  PrunePrepaid                                  3
  SetDelegate { new_delegate }                  4

PaidFundRedeemer                             constr
  FundLock                                      0
  FundSettle                                    1
  FundClaim { amount_carpdrop }                 2
```

`PrepaidVaultRedeemer` là enum **chỉ thêm ở cuối** (append-only) — thêm nhánh giữa chừng làm lệch
`burn_batch_constr = 2` mà ConsumeMAGIC đã ghim.

---

## 4. Bất biến `C-PP-*`

| Mã | Ràng buộc | Ép ở đâu |
|---|---|---|
| **C-PP-1** par chính xác | MAGIC sinh ở `PrepaidDraw` == `amount_carpdrop × par_scale`, đúng bằng phép nhân, không phí, không làm tròn | vault `validate_draw` |
| **C-PP-2** không sinh MAGIC nếu không khoá CARP | `PrepaidDraw` chỉ giảm `remaining` của một dòng hạn-mức đã có; hạn-mức chỉ được tạo/tăng bởi `PrepaidLock` mà `PrepaidLock` bắt buộc tăng `carp_locked` của quỹ đúng bằng lượng đó **và** CARP thật trong UTxO quỹ tăng đúng bằng đó | vault `validate_lock` + `validate_draw` |
| **C-PP-3** sổ quỹ khớp value | mọi đường ra/vào quỹ đều ép `carp_locked(out) == CARP thật trong output quỹ`; `carp_locked == credit_issued − provider_claimed` | quỹ, mọi nhánh |
| **C-PP-4** một chiều, không hoàn (F2) | không redeemer nào trả CARP về người khoá; hạn-mức không đổi ngược thành CARP; lối ra CARP **duy nhất** là `FundClaim` cho provider | cấu trúc — không tồn tại nhánh nào khác |
| **C-PP-5** cliff per-epoch | mọi batch sinh ra có `created_epoch == epoch hiện tại`, `decay_window == 1`; `BurnBatch` **từ chối** batch có `created_epoch ≠ epoch hiện tại`; batch chết chỉ có thể bị dọn | vault `validate_draw`, `validate_burn_batch`, `validate_prune` |
| **C-PP-6** trần đòi của provider (F2) | `provider_claimed' ≤ ⌊magic_settled / par_scale⌋` **và** `carp_locked' ≥ outstanding' + ⌊outstanding' × buffer_bps / 10000⌋`, với `outstanding' = credit_issued − ⌊magic_settled/par_scale⌋` | quỹ `validate_claim` |
| **C-PP-7** chỉ quyết toán MAGIC TIÊU THẬT | `FundSettle` chỉ cộng phần `current_amount` giảm trên batch có `contract_id == fund_id`, `source == 3`, **và** `created_epoch == epoch hiện tại`; và bắt buộc vault được tiêu bằng redeemer constr 2 (`BurnBatch`). MAGIC hết hạn hoặc bị dọn **không bao giờ** thành `magic_settled` | quỹ `validate_settle` (INV-MAGIC-CITIZEN) |
| **C-PP-8** DID bất biến | `did_commit` giống hệt input↔output ở **mọi** redeemer của vault | vault, mọi nhánh |
| **C-PP-9** phân quyền | Lock: `platform` HOẶC `owner` ký · Draw: `owner` HOẶC `personal_delegate` ký · BurnBatch: `owner` HOẶC `personal_delegate` · Prune: **không cần chữ ký** · SetDelegate: **chỉ** `owner` · FundClaim: `platform` | vault + quỹ |
| **C-PP-10** chống thoả-mãn-kép | đúng 1 vault input tại địa chỉ vault; đúng 1 output vault; đúng 1 input và đúng 1 output mang NFT quỹ; không đúc/đốt token của `fund_nft_policy` trong mọi giao dịch vận hành | vault + quỹ |
| **C-PP-11** epoch không nhập nhằng | cả hai biên `validity_range` là `Finite` và cùng rơi vào một epoch (`e_lo == e_hi`) | `get_epoch` (SEC-02, giống ScheduleGen) |
| **C-PP-12** trần cứng | `MAX_BATCHES_PER_VAULT = 32`, `MAX_PREPAID_CREDITS = 20`, `MIN_LOCK_CARPDROP = 10⁶` (1 CARP), `MIN_DRAW_CARPDROP = 10³` | vault |
| **C-PP-13** không đúc token | MAGIC không phải token; không nhánh nào của module này gọi `tx.mint` cho CARP; token quỹ chỉ đúc đúng một lần ở `fund_nft` | vault + quỹ |
| **C-PP-14** không chạm backing chung | validator PrepaidGen không có tham số LAMP, không đọc `br`/GreenBack/oracle | cấu trúc — kiểm bằng đọc chữ ký tham số |
| **C-PP-15** genesis quỹ sạch | NFT quỹ chỉ đúc được khi output mang nó có `PaidFundDatum` với `credit_issued = magic_settled = provider_claimed = carp_locked = 0`, `fund_id == asset name`, `buffer_bps ≥ 1500` | `fund_nft` |

---

## 5. Luồng giao dịch

### 5.1 Genesis quỹ (`fund_nft` mint)
Input: một UTxO bất kỳ của platform (làm nguồn tên duy nhất) → mint 1 NFT tên
`blake2b_224(tx_id ∥ output_index)` → output tại địa chỉ `paid_fund` mang NFT + `PaidFundDatum`
toàn số 0, `vault_hash` = hash của `prepaid_vault` đã deploy, `buffer_bps ≥ 1500`.

### 5.2 `PrepaidLock` — 2 script co-spend
```
inputs : vault UTxO (constr 0) · quỹ UTxO (constr 0) · UTxO CARP của người khoá
outputs: vault' (hạn-mức +amount) · quỹ' (carp_locked +amount, CARP thật +amount)
signers: platform HOẶC owner
```
Vault ép **toàn bộ** delta hai bên; quỹ ép "có vault thật cùng tiêu + trường bất biến không đổi +
sổ khớp value".

### 5.3 `PrepaidDraw` — chỉ vault
```
inputs : vault UTxO (constr 1)
outputs: vault' (remaining −amount; thêm 1 MagicBatch amount×1000 nanogic, epoch hiện tại)
signers: owner HOẶC personal_delegate
```
Quỹ **không** tham gia → không tranh chấp UTxO quỹ ở đường nóng.

### 5.4 Tiêu (`BurnBatch`) + quyết toán (`FundSettle`)
```
inputs : vault UTxO (constr 2) · quỹ UTxO (constr 1) · Engage UTxO (ConsumeMAGIC)
outputs: vault' (current_amount giảm) · quỹ' (magic_settled += Σ giảm) · Engage'
```
Quỹ tự tính `Σ` từ cặp datum vault vào/ra, chỉ đếm batch của **chính quỹ này** và **còn sống**.
`FundSettle` là tuỳ chọn về mặt kỹ thuật (vault tiêu được mà không cần quỹ), nhưng provider **phải**
kèm quỹ vào giao dịch nếu muốn được ghi nhận — không quyết toán thì không đòi được (F2).

### 5.5 `PrunePrepaid` — permissionless
Bỏ mọi batch `created_epoch < epoch hiện tại`, cộng `⌊current_amount / 1000⌋` về đúng dòng hạn-mức
`fund_id` tương ứng. Từ chối nếu không có gì để dọn (reject-noop, §7.4).

### 5.6 `FundClaim`
```
inputs : quỹ UTxO (constr 2)
outputs: quỹ' (carp_locked −amount) + CARP tới ví provider
signers: platform
```
Trần: C-PP-6.

---

## 6. Cổng THỜI + CHÍNH (Forall §Thiết kế cơ chế)

### 6.1 THỜI — nâng cấp và hồi tố
- **Đường nâng cấp:** không có redeemer `Migrate` ở v0.1. Nâng cấp = deploy bộ script mới; quỹ cũ
  tiếp tục sống tới khi `outstanding == 0` rồi `FundClaim` rút hết. Vault người dùng có thể tiêu hết
  MAGIC rồi bỏ. **Hệ quả thành thật:** không có đường di trú hạn-mức từ quỹ cũ sang quỹ mới — người
  dùng phải tiêu hết ở quỹ cũ. `[CẦN XÁC NHẬN]` có cần `Migrate` (quỹ cũ → quỹ mới, giữ nguyên
  `credit_issued`/`magic_settled`) trước khi lên mainnet không.
- **Hồi tố:** **KHÔNG**. `buffer_bps` ghim vào datum quỹ **tại genesis** và bất biến — DAO đổi ngưỡng
  chỉ áp cho **quỹ mở sau đó**. `par_scale` là hằng hiến pháp; đổi nó = deploy script mới, quỹ cũ
  không đổi. Hạn-mức đã cấp không bị tính lại tỷ giá.

### 6.2 CHÍNH — bảng quyền

| Loại quyền | Ai giữ | Ngưỡng | Thu hồi được? | Kẻ này ác / khoá bị chiếm thì mất gì |
|---|---|---|---|---|
| nâng cấp validator | không ai (không có `Migrate`) | — | — | không tồn tại bề mặt tấn công |
| tạm dừng | **không ai** — không có nút dừng | — | — | không tồn tại |
| giữ khoá ký | `platform` (1-of-1) của từng quỹ | 1 chữ ký | có, nhưng chỉ bằng cách mở quỹ mới | khoá platform bị chiếm → kẻ chiếm chạy `FundClaim` tới trần C-PP-6. **Trần đó chặn được bao nhiêu:** không rút quá phần MAGIC người dùng đã **tiêu thật**, tức phần dịch vụ platform đã nợ và đã giao. Hạn-mức chưa tiêu của người dùng **không** rút được. Thiệt hại tối đa = doanh thu đã kiếm được của chính platform |
| đổi tham số | không ai (`buffer_bps` bất biến) | — | — | không tồn tại |
| rút quỹ | `platform`, chặn cứng bởi C-PP-6 | 1 chữ ký + trần on-chain | — | như trên |
| đổi ánh xạ nhãn→hash | không ai — `fund_id` = tên NFT one-shot, `vault_hash` ghim genesis, cả hai bất biến | — | — | không tồn tại |

`[CẦN XÁC NHẬN]` `platform` 1-of-1 là điểm yếu đã biết (cùng loại với `engine_key` ở §13 điểm mở 2).
Đề xuất khi lên mainnet: `platform` là script multisig M-of-N thay vì pkh — thiết kế hiện tại đã
chịu được (`list.has(extra_signatories, platform)` đổi thành kiểm chữ ký script), không phải sửa
kiến trúc.

### 6.3 Chống self-dealing (Forall §"tay trái tạo — tay phải tiêu")
PrepaidGen **không phát thưởng**, nên `s = 0` trong `Π = V·(s + γ − 1) − …`. Kẻ tự khoá CARP rồi tự
tiêu chỉ đang mua dịch vụ của chính mình: `Π < 0` với mọi `γ ≤ 1`. Vòng self-dealing tại đây net-âm
theo cấu trúc.

Cửa gián tiếp còn lại: MAGIC tiêu từ PrepaidGen **có tính** vào cơ-sở-consumed của InstantGen (§6.3),
mà InstantGen thì có thưởng. Chặn nằm ở phía InstantGen chứ không phải ở đây: `INV-CASHBACK-BOUND`
(thưởng mỗi DID ≤ MAGIC thật đã tiêu) khiến vòng "mua CARP → tiêu → lấy thưởng InstantGen" tối đa
hoàn lại một phần chi phí, không bao giờ vượt. Ngoài ra §10 lấy C1 từ `EngageDatum.consumed_count`
**engage-side cross-DID**, không lấy từ số đếm trong vault — nên bộ đếm phía vault ở đây là **kiểm
toán, không phải nguồn quyền lực**, và không bơm được gì.

---

## 7. Đối chiếu bất biến toàn hệ (§12)

| Mã | PrepaidGen thoả bằng cách nào |
|---|---|
| F1-MAGIC-ONE-WAY | không có redeemer nào đổi MAGIC → CARP; `PrunePrepaid` trả **hạn-mức**, không trả CARP, và hạn-mức chỉ đi tiếp một chiều thành MAGIC |
| F2-CARP-FRICTION | C-PP-4 + C-PP-6; CARP khoá chỉ ra được cho provider và chỉ tương ứng dịch vụ đã giao |
| F3-NO-PASSIVE-YIELD | không có lợi tức theo số dư; hạn-mức không sinh thêm theo thời gian |
| F4-MAGIC-CLOSED | `decay_window = 1`, MAGIC không transferable (nằm trong datum vault gắn `owner` + `did_commit`), không chuộc ra tiền |
| F5 / F6 | không đọc oracle, không đọc giá LAMP, không có cổng dựa số ngoài (C-PP-14) |
| INV-MAGIC-CITIZEN | C-PP-7 — chỉ MAGIC **tiêu thật** vào `magic_settled`; hết hạn không tính |
| INV-CASHBACK-BOUND | thuộc InstantGen; PrepaidGen chỉ cung cấp cơ-sở-consumed đúng (tiêu thật) |
| I-ACT-7 | không chạm LAMP |
| P8 | `math.ak` ↔ `math.ts` cùng công thức + bảng vector chung, có test đối chiếu chéo đọc thẳng file `.ak` |
| C-OVERFLOW | TS dùng `bigint` toàn bộ; Aiken `Int` là số nguyên lớn |
| C-CM-1..5 | không đụng — PrepaidGen chỉ phơi `BurnBatch` constr 2 đúng chữ ký |

---

## 8. P8 — chứng minh bit-identical thế nào

Không chấp nhận "hai bên viết cùng công thức nên chắc giống nhau". Cách làm:

1. Bảng vector nằm ở **một chỗ**: `onchain/lib/magiclamp/protocol/vectors.ak`, dạng hằng
   `List<Int>` đọc được bằng máy.
2. Test Aiken chạy hàm on-chain trên bảng đó và so với cột kết quả.
3. Test TypeScript **đọc thẳng file `.ak`**, trích hai cột bằng regex, chạy hàm TS trên cột vào và
   so với cột ra.

Cả hai bên bị buộc về **cùng những con số literal**, và con số đó chỉ tồn tại một bản. Sửa lệch một
bên là đỏ ngay.

---

## 9. Danh sách `[CẦN XÁC NHẬN]`

| # | Điểm | Đang chọn gì | Ảnh hưởng nếu chốt khác |
|---|---|---|---|
| 1 | decimals của CARP | 6 ⇒ `par_scale = 1000` | đổi 1 hằng số ở `constants.ak` + `constants.ts` |
| 2 | asset name CARP trên mainnet | tham số validator, testnet `43415250` | không sửa code (đã là tham số) |
| 3 | `burn_batch_constr` của PrepaidGen | 2 (đồng nhất Instant/Schedule) | đổi thứ tự nhánh redeemer + bảng §11 |
| 4 | quỹ Paid là cấu trúc CARP-side đã có hay MAGIC tự định nghĩa | MAGIC tự định nghĩa `PaidFundDatum` | có thể phải ghép vào schema CARP |
| 5 | ranh giới một quỹ | mỗi (platform × dịch vụ) một quỹ | chỉ là quy ước vận hành |
| 6 | `buffer-Paid ≥ 15%` đo trên gì | trên `outstanding` của chính quỹ | đổi công thức trần ở `validate_claim` |
| 7 | hạn-mức có hạn dùng không (30/90/365) | **không** hết hạn | thêm `expiry_epoch` vào `PrepaidCredit` + luật CARP dư về đâu |
| 8 | trả lại hạn-mức khi MAGIC hết hạn (§1.3) | **có** | bỏ nhánh restore trong `PrunePrepaid` |
| 9 | `Migrate` quỹ cũ → mới | chưa có ở v0.1 | thêm redeemer + bất biến bảo toàn tổng |
| 10 | `platform` 1-of-1 | pkh đơn | đổi sang script M-of-N |
| 11 | quỹ có phải báo cáo `GlobalState` CarpetMint không | không | thêm reference input + kiểm tra |
| 12 | đốt NFT quỹ để đóng quỹ | chưa cho (`else(_) { fail }`) | mở nhánh burn có điều kiện `outstanding == 0` |
