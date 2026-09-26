# PrepaidGen — Thiết kế module (v0.1)

> **Phạm vi:** cửa sinh MAGIC thứ ba theo `Specs/MagicLamp-Tripletoken-Feat-(Vi).md §6.5` —
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
par_scale = nanogic_per_magic / carpdrop_per_carp = 10^9 / 10^9 = 1
nanogic = carpdrop × par_scale          (phép nhân — chính xác tuyệt đối, không mất số dư)
carpdrop = ⌊ nanogic / par_scale ⌋      (chiều ngược, chỉ dùng cho trần đòi của provider)
```

Không có phí par, không có hệ số Q. **CARP dùng 9 chữ số thập phân, BẰNG MAGIC** — chốt 2026-09-05,
khớp `nanothread = CARP × 10⁹` ở `BOUNDARIES.md`. Bản trước suy 6 từ tLAMP và gắn nhãn
`[CẦN XÁC NHẬN]`; nhãn đó nay đã được trả lời.

Hai thang bằng nhau ⟹ `par_scale = 1`, tức quy đổi là **phép đồng nhất**. Hệ quả đổi NGỮ NGHĨA chứ
không chỉ đổi số: chiều MAGIC→CARP trước đây SÀN và cố ý lệch về phía an toàn cho quỹ; nay nó chính
xác tuyệt đối, không còn phần dư nào để mất. Mọi lập luận dựa trên "sàn bù cho quỹ" không còn chỗ
dựa — quỹ đúng bằng số. Ngày nào một trong hai token đổi decimals thì `par_scale` khác 1 trở lại và
cái sàn kia sống lại.

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

Sai số: với `par_scale = 1` phép `⌊/par_scale⌋` **không mất gì** — hạn-mức trả lại đúng bằng MAGIC
đã chết. Trước 2026-09-05 nó mất tối đa 999 nanogic mỗi lần dọn và lệch về phía an toàn cho quỹ;
lớp đệm đó nay không còn, nên đừng viện nó làm lý do khi tính backing.

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

### 2.1 Hai script

| Script | Vai | Tham số |
|---|---|---|
| `paid_fund` (spend **+ mint**) | giữ CARP khoá + sổ quỹ; quyết toán (`FundSettle`) và trả provider (`FundClaim`); đồng thời là policy của NFT định danh quỹ (`asset_name = blake2b_256(tx_id ∥ be8(idx))` của một input bị tiêu → không trùng, không đúc lại được; policy id = chính script hash) | `carp_policy_id`, `carp_asset_name`, `ms_per_epoch` |
| `prepaid_vault` (spend **+ mint**) | hạn-mức + `magic_batches` của một người dùng; đồng thời là policy của NFT định danh vault (`asset_name = blake2b_256(cbor.serialise(seed))`, policy id = chính script hash — tự tham chiếu, không tham số, không vòng) | `carp_policy_id`, `carp_asset_name`, `paid_fund_hash`, `ms_per_epoch` |

> **`fund_nft` đã bị GỘP vào `paid_fund` ngày 2026-09-15 và tệp `validators/fund_nft.ak` đã
> xoá.** Đó không phải một lần dọn dẹp — nó là bản vá cho một lỗ rút được sạch quỹ. Một minting
> policy đứng riêng **không kiểm được địa chỉ của output mang NFT**: bản cũ lọc carrier chỉ bằng
> `quantity_of(...) == 1` và tự ghi trong chú thích rằng kiểm địa chỉ sẽ tạo vòng tham chiếu
> `fund_nft → paid_fund → prepaid_vault → fund_nft`. Vòng ấy không có thật — phá bằng đúng khuôn
> tự-trỏ-vào-mình mà kho đã dùng hai lần (`validate_mint_vault_id` ngay dưới, và
> `validate_mint_engage_id` bên ConsumeMAGIC), tức ép `payment_credential == Script(policy_id)`.
> Đường khai thác mà bản cũ để hở, ba bước: (1) đúc NFT quỹ vào một **ví thường**, datum sạch —
> cổng cho qua; (2) tiêu output ví đó bằng chữ ký thường, **không validator nào chạy**, tạo output
> mới ở địa chỉ quỹ với datum bịa `magic_settled` khổng lồ; (3) người dùng khoá CARP vào quỹ đó,
> `FundClaim` rút sạch vì `outstanding` âm kéo `buffer_floor` xuống âm. Bằng chứng lỗ nằm trong
> chính bộ kiểm cũ: `fn_addr()` của `fund_nft.ak` là **một địa chỉ ví**, và mọi bài — kể cả bài
> happy đang xanh — đặt NFT quỹ vào đó.
>
> **Hệ quả tham số: hai apply-param `fund_nft_policy` + `paid_fund_hash` nay là MỘT.** Policy NFT
> quỹ bằng đúng script hash của `paid_fund`, nên mọi chỗ cần nó suy thẳng từ `paid_fund_hash`.
> Hai tham số song song cho phép deploy một bộ bytes mà hai giá trị **lệch nhau** — đúng lớp lỗi
> mà `BOUNDARIES.md §5` gọi là bài học đắt nhất của kho (không test nào đỏ, không compile nào
> gãy, sai chỉ lộ ra dưới dạng một vault không ai tiêu được). Một giá trị thì không lệch được.
>
> **Hai công thức tên tài sản nằm cạnh nhau trong module này, và chúng KHÁC nhau — cố ý.**
> NFT quỹ dùng `blake2b_256(tx_id ∥ be8(idx))` (`compute_fund_id`); NFT vault dùng
> `blake2b_256(cbor.serialise(seed))` (`vault_id_name`). Cùng hàm băm, **khác thứ được băm**.
> Bản thứ hai theo `BOUNDARIES.md §2` ▸ `INV-VAULT-IDENTITY`, là bất biến toàn kho mà
> `ScheduleGen` và `InstantGen` đã theo. Ai định gộp về một công thức thì đó là đổi bytes của
> `paid_fund`, không phải một lần dọn dẹp.
>
> **Định danh một vault là NFT của nó, KHÔNG phải địa chỉ.** Giao dịch đúc được phép để lại một
> output thứ hai ở **đúng địa chỉ vault**, mang datum khai `prepaid_credits` khổng lồ. Output ấy
> **không tiêu được** (chết ở `single_nft_name` vì không mang NFT) nên nó không sinh giá trị
> on-chain — nhưng nó giải mã được thành `PrepaidVaultDatum` và nằm đúng chỗ mọi bảng điều khiển
> gọi `utxosAt(vaultAddress)`. Cho nên **off-chain phải lọc theo `(policy = script hash vault,
> số lượng 1)`**, đừng lọc theo địa chỉ. Cùng câu đó áp cho quỹ: lọc theo
> `(policy = script hash quỹ, tên = fund_id, số lượng 1)`. Đây cố ý **không** vá bằng một cổng
> on-chain — cổng đó phải cấm mọi output phụ ở địa chỉ vault trong giao dịch đúc, tốn ex-unit
> mỗi lần đúc để chặn một thứ không tiêu được; một dòng quy ước off-chain rẻ hơn và đúng chỗ hơn.
>
> **Handler `mint` của `prepaid_vault` là thứ được THÊM ngày 2026-09-15, không phải thứ vốn có.** Trước đó
> `prepaid_vault` chỉ khai `spend` + `else`, nên Cardano — vốn không chạy validator lúc TẠO
> một UTxO — để người tạo tự đặt datum đầu tiên. Dựng được một vault khai `prepaid_credits`
> tuỳ ý mà không khoá một đồng CARP nào, rồi `PrepaidDraw` đọc đúng cái datum đó và cấp MAGIC
> từ hư không. Cổng genesis nay ghim `prepaid_credits == []` ∧ `magic_batches == []` ∧
> `next_batch_index == 0` ∧ `personal_delegate == None` ∧ `attribution` rỗng ∧
> `did_commit == #""` ∧ chủ phải ký, và
> mọi nhánh spend đòi NFT còn nguyên qua MỘT điểm nghẽn trong thân `spend` (cố ý không chép
> cổng vào 5 hàm `validate_*`: chép 5 bản là 5 chỗ sót được, mà sót thì không gì đỏ).
>
> Đo chứ không khai — **đây là nguồn DUY NHẤT của các con số này trong kho; chú thích trong mã
> cố ý không chép chúng xuống.** Phép đo: thay đúng một chốt bằng `expect True`, chạy trọn bộ
> (**134** bài), đếm bài lật từ pass sang không-pass. Đo lại 2026-09-15 trên `aiken v1.1.21+42babe5`,
> sau khi thêm nhánh `SetDidCommit`:
>
> | chốt gỡ ra (neo theo tên hàm) | bài lật |
> |---|---|
> | `vault_identity_preserved` — cả lời gọi trong thân `spend` | **15** |
> | `vault_identity_preserved` ▸ `single_nft_name(vault_output…) == nft_name` | 11 |
> | `single_nft_name` ▸ `expect qty == 1` | 1 (`pp_spend_nft_qty_two`) |
> | `validate_mint_vault_id` ▸ `quantity_of(tx.mint, …) == 1` (cổng chặn ĐỐT) | 1 (`pp_mint_burn_rejected`) |
> | `validate_mint_vault_id` ▸ `single_nft_name(vault_out…) == nft_name` | 1 |
> | `validate_mint_vault_id` ▸ `stake_credential == None` | 1 |
> | `validate_mint_vault_id` ▸ `reference_script == None` | 1 |
> | `validate_mint_fund_nft` ▸ `payment_credential == Script(policy_id)` | 2 |
> | `validate_mint_fund_nft` ▸ `expect qty == 1` (cổng chặn ĐỐT) | 1 |
> | `validate_mint_fund_nft` ▸ `single_nft_name` · `stake_credential` · `reference_script` · `last_updated_epoch == 0` | 1 mỗi chốt |
> | `validate_fund_settle` ▸ `par_carp_from_magic(magic_settled) <= credit_issued` | 1 (`pp_fund_settle_over_issued`) |
> | `validate_mint_vault_id` ▸ `vd.did_commit == #""` | 1 (`pp_mint_did_preset`) |
> | `validate_set_did_commit` ▸ (1) `datum.did_commit == #""` | 1 (`pp_setdid_already_set`) |
> | `validate_set_did_commit` ▸ (2) `list.has(extra_signatories, datum.owner)` | 2 (`pp_setdid_no_owner_sig`, `pp_setdid_by_delegate`) |
> | `validate_set_did_commit` ▸ (3) `new_did != #""` | 1 (`pp_setdid_to_empty`) |
> | `validate_set_did_commit` ▸ (4) `did_len_ok(new_did)` | 1 (`pp_setdid_wrong_length`) |
> | `validate_set_did_commit` ▸ `out.prepaid_credits == datum.prepaid_credits` | 1 (`pp_setdid_mutates_other_field`) |
>
> Con số **15** ở hàng đầu là 13 của bản trước cộng đúng hai bài của nhánh thứ sáu
> (`pp_spend_setdidcommit_forged_vault`, `pp_spend_setdidcommit_nft_escapes`) — tức nhánh mới
> được cổng ở thân `spend` phủ mà không phải tự nhớ gọi lại nó. Đó là phép ĐO câu "cổng nằm ở
> cấu trúc chứ không ở kỷ luật", không phải một lời khai về nó.
>
> Sáu hàng cuối không hàng nào phồng theo cụm: mỗi chốt gỡ ra làm lật đúng những bài mang tên nó.
> Hàng (2) ra **2** vì có hai hình dạng tấn công khác nhau cùng chết ở một dòng — người lạ ký, và
> `personal_delegate` ký — chứ không phải vì một cụm mã bị loại.
>
> Một chi tiết phản trực giác đáng ghi: gỡ `single_nft_name(vault_output…)` làm **11** bài lật chứ
> không phải 1, vì `nft_name` khi đó không còn ai dùng ⟹ lời gọi `single_nft_name` phía **input**
> cũng bị loại như mã chết ⟹ cổng "vault bịa không mang NFT" biến mất theo. Nghĩa là cổng phía
> input sống được là nhờ kết quả của nó được dùng ở phía output; đừng đọc con số 11 thành "chốt
> này canh 11 bài".

**Thứ tự deploy (không có vòng tham chiếu):** `paid_fund` (chỉ phụ thuộc CARP + `ms_per_epoch`) →
`prepaid_vault` (nhận `paid_fund_hash`).

Chiều ngược (quỹ cần biết vault) **không** đi qua tham số biên dịch — nếu đi thì thành vòng
`vault → fund → vault`. Thay vào đó `PaidFundDatum.vault_hash` được **ghim tại genesis** bởi chính
handler `mint` của `paid_fund` và bất biến sau đó. Nhờ vậy:

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
  did_commit         : ByteArray,          // §7.5 — RỖNG lúc đúc; đặt 1 lần qua
                                           // SetDidCommit (32 byte); rồi BẤT BIẾN
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
  beneficiary        : Address,     // đích nhận CARP của FundClaim, ghim genesis, bất biến
  beneficiary_datum  : Option<Data>, // None ⟹ output NoDatum · Some(d) ⟹ InlineDatum(d)
}
```

Hai trường cuối thêm 2026-09-26 (L1''). THÊM Ở CUỐI giữ chỉ số trường cũ nhưng **không** giữ khả
năng đọc UTxO quỹ 9 trường đời trước (`BOUNDARIES.md` §2) — cụm Preprod đời trước mồ côi
(`DevStatus.md` ▸ Nợ #71 (f), Nợ #85).

### 3.5 Redeemer

```
PrepaidVaultRedeemer                         constr
  PrepaidLock { fund_id, amount_carpdrop }      0
  PrepaidDraw { fund_id, amount_carpdrop }      1
  BurnBatch   { burns }                         2   ← KHOÁ, khớp §7.3 / §11
  PrunePrepaid                                  3
  SetDelegate { new_delegate }                  4
  SetDidCommit { did_commit }                   5   ← thêm 2026-09-15, Ở CUỐI

PaidFundRedeemer                             constr
  FundLock                                      0
  FundSettle                                    1
  FundClaim { amount_carpdrop }                 2
```

`PrepaidVaultRedeemer` là enum **chỉ thêm ở cuối** (append-only) — thêm nhánh giữa chừng làm lệch
`burn_batch_constr = 2` mà ConsumeMAGIC đã ghim.

> `SetDidCommit` đặt ở **5**, không đặt cạnh `SetDelegate`, dù hai nhánh nghe giống nhau (đều là
> "owner đổi một trường cấu hình"). Thứ tự khai báo **≠** thứ tự vòng đời: chèn vào 5 thì
> `SetDelegate` dịch sang 6, và mọi redeemer đã mã hoá ngoài chuỗi cho một nhánh ≥ 3 trỏ sang
> nhánh khác — không lỗi cú pháp, không phép kiểm kiểu nào đỏ, chỉ sai lúc chạy. Chốt này được ép
> bằng ba phép trong `tests/codec.test.ts`, và chỉ phép thứ ba đo được thứ thật sự lên chuỗi:
> (a) chỉ số trong `types.ak`; (b) chỉ số trong bảng `VAULT_REDEEMER_ORDER`; (c) **byte thật** —
> `Data.to(…, PrepaidVaultRedeemerSchema)` phải bắt đầu bằng thẻ CBOR `d87e` (= 121+5), kèm một
> vế đối chứng rằng `SetDelegate` vẫn ra `d87d`. Thiếu vế đối chứng thì bài (c) vẫn xanh khi CẢ
> HAI nhánh cùng dịch một bậc.

---

## 4. Bất biến `C-PP-*`

| Mã | Ràng buộc | Ép ở đâu |
|---|---|---|
| **C-PP-1** par chính xác | MAGIC sinh ở `PrepaidDraw` == `amount_carpdrop × par_scale`, đúng bằng phép nhân, không phí, không làm tròn | vault `validate_draw` |
| **C-PP-2** không sinh MAGIC nếu không khoá CARP | `PrepaidDraw` chỉ giảm `remaining` của một dòng hạn-mức đã có; hạn-mức chỉ được tạo/tăng bởi `PrepaidLock` mà `PrepaidLock` bắt buộc tăng `carp_locked` của quỹ đúng bằng lượng đó **và** CARP thật trong UTxO quỹ tăng đúng bằng đó | vault `validate_lock` + `validate_draw` |
| **C-PP-3** sổ quỹ khớp value | mọi đường ra/vào quỹ đều ép `carp_locked(out) == CARP thật trong output quỹ`; `carp_locked == credit_issued − provider_claimed` | quỹ, mọi nhánh |
| **C-PP-4** một chiều, không hoàn (F2) | không redeemer nào trả CARP về người khoá; hạn-mức không đổi ngược thành CARP; lối ra CARP **duy nhất** là `FundClaim` cho provider | cấu trúc — không tồn tại nhánh nào khác |
| **C-PP-5** cliff per-epoch | mọi batch sinh ra có `created_epoch == epoch hiện tại`, `decay_window == 1`; `BurnBatch` **từ chối** batch có `created_epoch ≠ epoch hiện tại`; batch chết chỉ có thể bị dọn | vault `validate_draw`, `validate_burn_batch`, `validate_prune` |
| **C-PP-6** trần đòi của provider (F2) + đích | `provider_claimed' ≤ ⌊magic_settled / par_scale⌋` **và** `carp_locked' ≥ outstanding' + ⌊outstanding' × buffer_bps / 10000⌋`, với `outstanding' = credit_issued − ⌊magic_settled/par_scale⌋`. **Đích (2026-09-26):** không input nào tại `beneficiary`; **đúng một** output tại `beneficiary` (so địa chỉ ĐẦY ĐỦ); CARP ở output đó == `amount`; datum output == `NoDatum` khi `beneficiary_datum = None`, == `InlineDatum(d)` khi `Some(d)`. `beneficiary`/`beneficiary_datum` bất biến ở mọi nhánh spend quỹ | quỹ `validate_fund_claim`; bất biến ở `fund_common_checks` + khối delta quỹ của `validate_lock` |
| **C-PP-7** chỉ quyết toán MAGIC TIÊU THẬT | `FundSettle` chỉ cộng phần `current_amount` giảm trên batch có `contract_id == fund_id`, `source == 3`, **và** `created_epoch == epoch hiện tại`; và bắt buộc vault được tiêu bằng redeemer constr 2 (`BurnBatch`). MAGIC hết hạn hoặc bị dọn **không bao giờ** thành `magic_settled` | quỹ `validate_settle` (INV-MAGIC-CITIZEN) |
| **C-PP-8** DID ghi MỘT LẦN rồi bất biến | genesis ép `did_commit == #""`; `SetDidCommit` là nhánh **GHI duy nhất** và chỉ chạy được khi giá trị hiện tại còn rỗng, giá trị mới khác rỗng và dài đúng 32 byte; năm redeemer còn lại ép `did_commit` giống hệt input↔output. Ràng buộc độ dài đặt ở **chỗ GHI**, cố ý KHÔNG đặt ở nhánh bảo toàn — đặt ở đó là biến mọi vault đã nằm trên chuỗi với did sai khuôn thành bất khả tiêu | vault: `validate_mint_vault_id` + `validate_set_did_commit` + năm nhánh còn lại |
| **C-PP-9** phân quyền | Lock **mở dòng mới** (vault chưa có dòng hạn-mức cho `fund_id` — cùng vị từ `has_credit_line` mà `add_credit` dùng): **chỉ** `owner` ký (siết 2026-09-26 — genesis quỹ ai cũng lập được, nên "platform nào cũng được" để người lạ lấp 20 chỗ `MAX_PREPAID_CREDITS` vĩnh viễn và tranh UTxO vault vô hạn) · Lock **nạp thêm** vào dòng đã có: `platform` HOẶC `owner` (luồng app khoá hộ giữ nguyên) · Draw: **chỉ** `owner` · BurnBatch: **chỉ** `owner` (vế `personal_delegate` chết 2026-09-16, Nợ #14) · Prune: **không cần chữ ký** · SetDelegate: **chỉ** `owner`, và chỉ xoá được · SetDidCommit: **chỉ** `owner` (uỷ quyền TRẢ PHÍ không phải uỷ quyền KHAI DANH TÍNH, và vì cổng chỉ cho ghi một lần nên một delegate ghi trước là nạn nhân mất luôn đường gắn DID thật) · FundClaim: `platform` · genesis quỹ: `platform` (2026-09-26) | vault + quỹ |
| **C-PP-10** chống thoả-mãn-kép | đúng 1 vault input tại địa chỉ vault; đúng 1 output vault; đúng 1 input và đúng 1 output mang NFT quỹ; không đúc/đốt token của policy NFT quỹ (= script hash `paid_fund`) trong mọi giao dịch vận hành | vault + quỹ |
| **C-PP-11** epoch không nhập nhằng | cả hai biên `validity_range` là `Finite` và cùng rơi vào một epoch (`e_lo == e_hi`) | `get_epoch` (SEC-02, giống ScheduleGen) |
| **C-PP-12** trần cứng | `MAX_BATCHES_PER_VAULT = 32`, `MAX_PREPAID_CREDITS = 20`, `MIN_LOCK_CARPDROP = 10⁹` (1 CARP), `MIN_DRAW_CARPDROP = 10⁶` | vault |
| **C-PP-13** không đúc token | MAGIC không phải token; không nhánh nào của module này gọi `tx.mint` cho CARP; token quỹ chỉ đúc đúng một lần ở handler `mint` của `paid_fund`, và số lượng âm bị chặn ở đó (không có đường ĐỐT) | vault + quỹ |
| **C-PP-14** không chạm backing chung | validator PrepaidGen không có tham số LAMP, không đọc `br`/GreenBack/oracle | cấu trúc — kiểm bằng đọc chữ ký tham số |
| **C-PP-15** genesis quỹ sạch | NFT quỹ chỉ đúc được khi output mang nó **nằm ở đúng địa chỉ quỹ** (`payment_credential == Script(policy_id)`, `stake_credential == None`, không `reference_script`, chỉ MỘT tên dưới policy quỹ) và có `PaidFundDatum` với `credit_issued = magic_settled = provider_claimed = carp_locked = last_updated_epoch = 0`, `fund_id == asset name`, `buffer_bps ≥ 1500`, `platform`/`vault_hash` dài đúng 28 byte. **Từ 2026-09-26:** `platform` **ký** giao dịch genesis (chặn quỹ mạo danh platform thật); `beneficiary.stake_credential == None`; hash của `beneficiary.payment_credential` dài 28 byte; `beneficiary.payment_credential ∉ {Script(policy_id), Script(vault_hash)}`; `Script(_) ⟹ beneficiary_datum = Some(_)`. Ràng buộc datum là CẦN, chưa ĐỦ: khả năng tiêu lại của cặp `(beneficiary, beneficiary_datum)` phải thử ngoài chuỗi (`DevStatus.md` ▸ Nợ #85) | `paid_fund.mint` ▸ `validate_mint_fund_nft` |

---

## 5. Luồng giao dịch

### 5.1 Genesis quỹ (handler `mint` của `paid_fund`)
Input: một UTxO bất kỳ của platform (làm nguồn tên duy nhất) → mint 1 NFT tên
`blake2b_256(tx_id ∥ be8(output_index))` → output **tại chính địa chỉ `paid_fund`** (đây là mệnh
đề mà bản tách-script không viết được — xem §2.1) mang NFT + `PaidFundDatum` toàn số 0,
`vault_hash` = hash của `prepaid_vault` đã deploy, `buffer_bps ≥ 1500`, và cặp đích
`beneficiary` + `beneficiary_datum` (C-PP-15). `signers: platform` — bắt buộc từ 2026-09-26.

### 5.2 `PrepaidLock` — 2 script co-spend
```
inputs : vault UTxO (constr 0) · quỹ UTxO (constr 0) · UTxO CARP của người khoá
outputs: vault' (hạn-mức +amount) · quỹ' (carp_locked +amount, CARP thật +amount)
signers: MỞ DÒNG MỚI → owner · NẠP THÊM vào dòng đã có → platform HOẶC owner   (2026-09-26)
```
Vault ép **toàn bộ** delta hai bên; quỹ ép "có vault thật cùng tiêu + trường bất biến không đổi +
sổ khớp value".

### 5.3 `PrepaidDraw` — chỉ vault
```
inputs : vault UTxO (constr 1)
outputs: vault' (remaining −amount; thêm 1 MagicBatch amount×1000 nanogic, epoch hiện tại)
signers: owner   (vế personal_delegate chết 2026-09-16, Nợ #14)
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
inputs : quỹ UTxO (constr 2) · UTxO trả phí — KHÔNG ở địa chỉ `beneficiary`
outputs: quỹ' (carp_locked −amount) · ĐÚNG MỘT output tại `beneficiary`: `amount` CARP + datum ghim
signers: platform
```
Trần + đích: C-PP-6. Phí và tiền thừa đi từ một địa chỉ khác `beneficiary` (vd địa chỉ base của
cùng khoá — nó khác địa chỉ enterprise của bên hưởng, vì claim so địa chỉ đầy đủ).

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
| giữ khoá ký | `platform` (1-of-1) của từng quỹ | 1 chữ ký | có, nhưng chỉ bằng cách mở quỹ mới | khoá platform bị chiếm → kẻ chiếm chạy `FundClaim` tới trần C-PP-6 — nhưng từ 2026-09-26 CARP chỉ tới được **`beneficiary` đã ghim** ở genesis, không tới ví kẻ chiếm; phần mất còn lại là chọn thời điểm claim. Kẻ chiếm khoá platform vẫn tranh được UTxO vault của những người dùng **đã tự mở dòng** cho quỹ đó (nạp thêm nhận chữ ký platform). **Trần đó chặn được bao nhiêu:** không rút quá phần MAGIC người dùng đã **tiêu thật**, tức phần dịch vụ platform đã nợ và đã giao. Hạn-mức chưa tiêu của người dùng **không** rút được. Thiệt hại tối đa = doanh thu đã kiếm được của chính platform |
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
| 1 | ~~decimals của CARP~~ **ĐÃ CHỐT 2026-09-05: 9 ⇒ `par_scale = 1`** | — | — |
| 2 | ~~asset name CARP~~ **ĐÃ ĐO 2026-09-11** — xem bảng ngay dưới | — | — |
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

### 9.1 CARP theo mạng — đo 2026-09-11

Nguồn: nhà **CarpetMint**, giữ chủ quyền CARP. Kho này KHÔNG tự đặt, tự suy, tự điền.
Giá trị sống ở `offchain/src/constants.ts` (`CARP_POLICY_ID`, `CARP_ASSET_NAME`,
`carpAssetClass`); bảng dưới là bản chép có nhãn, **không** phải nguồn.

| mạng | có CARP? | ghi chú |
|---|---|---|
| Preprod | **có** | `policy_id` + `asset_name`, cả hai 28 byte — xem `constants.ts` |
| Preview | **KHÔNG** | instance duy nhất sống ở Preview là **LACE**, vai BASE, token khác. Điền policy LACE vào chỗ CARP là dựng một quỹ Paid không bao giờ thấy đồng CARP nào |
| Mainnet | chưa deploy | — |

Hai điểm dễ sai, đã tốn một lần:

1. `carp_asset_name` **không phải** hex của ticker. Nó là một **băm 28 byte**. Bản trước
   của kho ghi `43415250` (hex ASCII "CARP", 4 byte) và một bài kiểm ghim đúng con số sai
   đó, nên bộ kiểm xanh trong lúc cấu hình sai.
2. Preview **fail-closed**: `carpAssetClass("Preview")` **ném**, không trả chuỗi rỗng.
   `assets.quantity_of(value, "", "")` trả 0 một cách im lặng — đó là cái vỏ im lặng, không
   phải một cấu hình.

**Hệ quả lịch trình:** PrepaidGen khoá CARP thật, nên **không có đường chạy thử nào trên
Preview**. Mọi bước nghiệm thu PrepaidGen phải chạy trên **Preprod**.

Đo lại: hỏi nhà CarpetMint, rồi đối chiếu on-chain
`curl "$BLOCKFROST_URL/assets/<policy><asset_name>"` trên đúng mạng đó.
