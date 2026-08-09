# InstantGen — Thiết kế PHA 2

**Trạng thái:** đã triển khai. Số kiểm giữ ở một nơi duy nhất —
[`DEVSTATUS.md`](../DEVSTATUS.md); muốn số tươi thì chạy `aiken check` trong `onchain/`
và `npm test` trong `offchain/`.
**Nguồn chân lý:** `SPEC/MagicLamp-Tripletoken-Feat-(Vi).md` §4.2, §6.1, §6.3, §11, §12.
**Tài liệu này thay thế:** `HALVING-SPEC.md` (halving không còn tồn tại) và mọi mô tả
"InstantGen = mua MAGIC bằng LAMP" trong `README.md` / `FEAT.md` / `MATH.md` / `TECH.md`.

---

## 1. Ba thay đổi cốt lõi

| Trước (mô hình cũ) | Sau (PHA 2) | Neo |
|---|---|---|
| Mua MAGIC: `lamp_paid` chuyển từ vault → Treasury | LAMP **đứng yên tuyệt đối** trong vault | I-ACT-7 |
| Batch sống 2 epoch, có halving ở `k=1` | Batch sống **đúng 1 epoch** (`decay_window = 1`, cliff) | §4.2 |
| Độ lớn ∝ `lamp_paid` | Độ lớn ∝ **MAGIC đã tiêu thụ thật** | §6.3 |

Hệ quả trực tiếp lên tham số triển khai: validator InstantGen bỏ `treasury_addr`
và nhận thêm hai tham số ghim beacon backing (mục 4).

---

## 2. LAMP đứng yên — I-ACT-7

`validate_instant_gen` khẳng định từng trường mang LAMP là **giống hệt byte**
giữa datum vào và datum ra:

```
expect output_datum.lamp_balance     == applied_input.lamp_balance
expect output_datum.lamp_locked      == applied_input.lamp_locked
expect output_datum.loyalty_holdings == applied_input.loyalty_holdings
```

và ràng buộc datum vào **giá trị thật** trong UTxO đầu ra:

```
expect quantity_of(vault_output.value, lamp_policy_id, lamp_asset_name) == output_datum.lamp_balance
```

`lamp_asset_name` là **tham số theo mạng** (apply-param #2), không phải chuỗi cố định:
`tLAMP` trên testnet, `LAMP` trên mainnet. Bản cũ của khối trên viết thẳng `"tLAMP"` —
sai theo `BOUNDARIES.md §2`. Bám bản cũ thì trên mainnet `quantity_of` trả 0, ép
`lamp_balance = 0`, không vault nào đạt `min_instant_holding`, InstantGen chết vĩnh viễn
trên mainnet. Chính `validators/vault.ak` đã ghi cảnh báo này ngay trên khối tham số.

Không còn nhánh `treasury_receives_lamp`, không còn `treasury_addr` trong
apply-param. Test chứng minh: `ig_neg_lamp_moved` (datum tự nhất quán nhưng
LAMP rời vault → từ chối) và `ig_neg_value_drained` (datum nói không đổi nhưng
giá trị thiếu → từ chối).

Nắm LAMP chỉ còn tác dụng **mở cửa**:

- `lamp_balance ≥ min_instant_holding` (10 LAMP) — ngưỡng trên **số dư**, không
  phải trên khoản chi, vì không có khoản chi nào.
- `L_avail = lamp_balance − lamp_locked ≥ min_instant_holding` — LAMP đã khoá
  hết vào hợp đồng ScheduleGen thì không đồng thời mua được tư cách Instant.

ScheduleGen cùng nguyên tắc: `validate_fire` không chuyển LAMP nữa, nó **giải
phóng khoá**. `lamp_balance` bất biến, `lamp_locked` giảm `fires × λ`, và các
`loyalty_holdings` tương ứng chỉ lật `is_locked` (hàm mới
`lock.unlock_locked_amount`, đối chiếu TS `unlockLockedAmount`). Σholdings bất
biến nên `C-VAULT-10` (Σholdings == lamp_balance) vẫn đúng.

---

## 3. Cliff 1 epoch — §4.2

`decay_window = 1` cho **mọi nguồn**. Một batch chỉ LIVE trong đúng
`created_epoch` của nó; sang `created_epoch + 1` là chết: không tiêu được, giá
trị coi như 0, và được dọn rác.

Toàn bộ máy móc halving bị gỡ:

- `decay.ak` không còn `should_halve` / `apply_halving` / `apply_halving_all` /
  `halve_then_prune`. Còn lại `is_expired` / `is_live` / `prune_expired` /
  `count_expired` / `batch_balance` / `live_total`.
- `MagicBatch.halved` **giữ nguyên vị trí trường** để hình dạng Plutus Data
  (9 trường) không đổi so với datum đã deploy và với các module anh em, nhưng
  là **trường chết**: luôn `False`, không đường code nào ghi.
- `apply_burns` nhận thêm `current_epoch` và từ chối burn vào batch đã chết
  (`expect !is_expired(b, current_epoch)`), sau đó `prune_expired` dọn phần còn
  lại. Test: `bb_dead_batch_rejected` (InstantGen và ScheduleGen).

### Đề nghị về nhánh `ApplyHalving` — và cách đã làm

Với cliff 1 epoch, halving mất hết ý nghĩa: không còn `k=1` để giảm nửa. Nhưng
**không được xoá slot constr 1**: `VaultRedeemer` là enum append-only và
`BurnBatch` phải ở constr 2 (`ConsumeMAGIC/CONTRACT.md` v2 khoá, spec §11 bảng
`burn_batch_constr`). Xoá một biến thể ở giữa sẽ đẩy `BurnBatch` về constr 1 và
phá interface liên repo.

**Đề nghị đã thực hiện:** đổi biến thể constr 1 từ `ApplyHalving` thành
`PruneExpired` — dọn rác batch chết, permissionless, đúng §7.4. Lý do:

1. `ApplyHalving` là **nullary** và `PruneExpired` cũng **nullary** → mã hoá
   Plutus Data của constr 1 không đổi một byte. Chỉ cái nhãn đổi.
2. Cliff vẫn sinh rác: batch chết nằm lại trong datum, ăn byte và ExUnit. §7.4
   đã yêu cầu sẵn một redeemer dọn rác permissionless. Tái dùng đúng slot vừa
   trống là lựa chọn rẻ nhất, không đẻ thêm biến thể.
3. Toàn bộ lớp gia cố chống quấy rối của `ApplyHalving` giữ nguyên và vẫn cần,
   vì đường này vẫn permissionless: giữ nguyên `last_updated_epoch` (chống người
   lạ đẩy đồng hồ nạn nhân), khoá ADA + tập policy ≤ 2 (chống rút ADA / nhồi
   bụi), và **thêm** `reject-noop` (không có gì chết thì từ chối, chống spam) +
   cấm chạm `consumed_credit`.

`HALVING-SPEC.md` do đó là tài liệu **đã chết** — giữ để đọc code cũ, không dùng
để triển khai.

---

## 4. Độ lớn theo MAGIC đã tiêu thụ — §6.3

```
cấp thực = min( reward(consumed), cap_surplus(br), 0.5 × pp_schedule )
```

Hai tầng tách bạch: tầng **dữ liệu nội bộ vault** (đã đủ, chạy được ngay) và
tầng **beacon ngoài** (chờ CARP).

### 4.1 `consumed` lấy từ đâu

`VaultDatum.activity_state` có sẵn hai trường; trường thứ hai
(`total_burns_count`) chưa có bất kỳ handler nào ghi — nó là trường chết. PHA 2
đặt lại tên trường đó thành **`consumed_credit`**, **cùng vị trí, cùng kiểu
`Natural`** → hình dạng Plutus Data không đổi, datum vẫn tương thích byte với
các module anh em và với các UTxO đã tạo.

Ngữ nghĩa: tổng nanogic người dùng **đã tiêu thật** qua `BurnBatch` và **chưa
đổi thành thưởng**.

- `BurnBatch` cộng `Σburns` vào `consumed_credit` (cả InstantGen lẫn ScheduleGen
  vault, để kế toán thống nhất ở cả hai cửa).
- `InstantGen` đổi **toàn bộ** credit thành một khoản thưởng rồi **đặt về 0**.

Đây là chỗ chốt của `INV-CASHBACK-BOUND`: credit tiêu một lần rồi mất, nên cùng
một lượng tiêu không bao giờ được thưởng hai lần. Test:
`ig_neg_credit_not_spent`, `bb_neg_consumed_credit_not_advanced`,
`bb_neg_consumed_credit_inflated`, `pe_neg_consumed_credit_inflated`.

> **Ghi chú giới hạn (thành thật).** Đây là nguồn **phía vault**, không phải
> `EngageDatum.consumed_count` phía engage mà §10 yêu cầu cho Governance C1.
> Với thưởng InstantGen, nguồn phía vault là **an toàn về kinh tế** vì
> `reward ≤ 0.46 × consumed < consumed` (mục 4.2): vòng tự-đốt-để-lấy-thưởng
> luôn âm. Với C1 governance thì **không** dùng số này — §10 giữ nguyên yêu cầu
> đọc cross-DID phía engage. Hai chỗ dùng hai nguồn khác nhau là có chủ ý.

### 4.2 `reward(consumed)` — nội bộ vault, đã xong

```
reward = ⌊ ⌊ ⌊ consumed × R_reward / Q ⌋ × UM / Q ⌋ × PM / Q ⌋
```

Ba bước floor tuần tự (Q-format, sai số ≤ 3 nanogic, kết quả luôn ≤ giá trị
thật). `R_reward = instant_reward_rate_q = 0.20` **[CẦN XÁC NHẬN — spec §6.3
không cho dạng hàm cụ thể, đây là tham số MAGIC đề xuất]**.

- `UM` = hệ số cầu mạng, giữ nguyên kiểm tra cũ `C-UM-6` (stale > 1 epoch →
  fallback 0.5×). Đây là phần "điều tiết cung-cầu".
- `PM` = tư-cách (§6.2), Ember 1.15 / Flame 1.05 / Lantern 1.00.

`INV-CASHBACK-BOUND` đúng **theo cấu tạo tham số**, không cần kiểm tra runtime:

```
R_reward × UM_MAX × PM_MAX = 0.20 × 2.00 × 1.15 = 0.46 < 1
```

Test chứng minh: `TV-IG-REWARD-03` (đúng biên xấu nhất) và một vòng quét mọi
profile × 6 độ lớn từ 1 nanogic tới toàn bộ cung.

**Hệ quả kinh tế (chống Sybil tay-trái-tạo-tay-phải-tiêu):** vì `s = 0.46 < 1`
và MAGIC tiêu là sink (giảm `current_amount`, không chảy về ví ai), điều kiện
`s + γ < 1` với `γ = 0` thoả — vòng tự bơm net-âm.

### 4.3 `0.5 × pp_schedule` — nội bộ vault, đã xong

```
pp_schedule = Σ over gen_schedules of ⌊ λ_i × rate_locked_q_i / Q ⌋
cap_pp      = ⌊ pp_schedule / 2 ⌋
```

`gen_schedules` nằm ngay trong `VaultDatum`, không cần nguồn ngoài.

> **[CẦN XÁC NHẬN] — hai cách đọc "trần-kép".**
> Cách đã cài: **per-vault** — InstantGen của một vault ≤ nửa dòng ScheduleGen
> mà chính vault đó đã cam kết. Cách còn lại: **toàn hệ** — tổng InstantGen của
> cả mạng ≤ nửa tổng ScheduleGen của cả mạng, cần một beacon tổng hợp.
> Cách per-vault chọn vì (a) chỉ dùng dữ liệu vault, (b) không cần thêm nguồn tin
> cậy nào, (c) chặt hơn nên an toàn hơn.
>
> **Hệ quả vận hành cần anh biết:** trong mô hình triển khai hiện tại,
> InstantGen và ScheduleGen là **hai vault riêng, hai địa chỉ riêng**. Vault
> InstantGen luôn có `gen_schedules = []` → `pp = 0` → `cap = 0` → **cửa
> InstantGen đóng**. Muốn mở, phải chọn một trong hai:
> 1. **Gộp vault** — một vault duy nhất cho cả hai cơ chế (đúng tinh thần
>    `VaultDatum` gốc, vốn đã có sẵn cả `magic_batches` lẫn `gen_schedules`); hoặc
> 2. **Tham chiếu chéo** — InstantGen đọc vault ScheduleGen của cùng owner qua
>    reference input, cần thêm apply-param ghim địa chỉ ScheduleGen.
>
> Đây là **quyết định kiến trúc**, không tự quyết. Trạng thái hiện tại (đóng) là
> hướng an toàn đúng với "đỏ thì khoá Gen".

### 4.4 `cap_surplus(br)` — cần beacon CARP

```
xanh (br >  br_safe = 1.5):  cap = f · S · (br − br_safe) / br_safe   (f = 0.10)
đỏ   (br ≤  br_safe):        cap = 0
```

Q-format floor tuần tự:

```
s1 = ⌊ S  × f_q          / Q ⌋      -- f·S
s2 = ⌊ s1 × (br − safe)  / Q ⌋      -- f·S·(br − br_safe)
s3 = ⌊ s2 × Q / br_safe_q ⌋         -- ÷ br_safe
```

`br = B/S` là thông tin **phía CARP**, vault MAGIC không tự suy ra được.

#### Schema beacon do MAGIC đề xuất — [CẦN XÁC NHẬN, gửi CARP đối chiếu]

```aiken
pub type BackingBeaconDatum {
  br_q               : Natural,   // ⌊B/S × Q⌋, Q = 10^9 — tỷ lệ backing có thẩm quyền
  magic_supply       : Natural,   // S — cung MAGIC hiệu lực (nanogic): đã Gen, chưa tiêu, chưa reset
  depeg              : Bool,      // True = CARP/MAGIC rớt dưới neo → cap = 0 (phanh §6.3)
  last_updated_epoch : Natural,   // epoch cập nhật gần nhất — chống stale
}
```

Ràng buộc vận hành:

| Hạng mục | Giá trị |
|---|---|
| Kiểu UTxO | **reference input** (CIP-31), KHÔNG tiêu |
| Định danh | NFT one-shot, asset name `"BRQ"` = `#"425251"` |
| Ghim địa chỉ | payment credential == `Script(backing_script_hash)` |
| Cửa sổ stale | `0 ≤ current_epoch − last_updated_epoch ≤ max_backing_stale` (= 1) |
| Đơn vị `br_q` | Q-format, `Q = 10^9`; `br_safe_q = 1_500_000_000` |
| Đơn vị `magic_supply` | nanogic (`MAGIC × 10^9`) |

Ghim hai lớp giống hệt UM datum: **NFT + địa chỉ script**. Chỉ NFT là không đủ
vì policy NFT không phải singleton toàn cục — một UTxO giả ở địa chỉ kẻ tấn công
mang NFT trùng vẫn qua được nếu thiếu lớp địa chỉ.

**FAIL-CLOSED — không có `br` mặc định.** Thiếu beacon / sai địa chỉ / không có
NFT / stale / `depeg = true` ⟹ tx **không hợp lệ**, cửa Gen đóng. Không có
đường nào cho một giá trị `br` bịa ra chạy vào công thức. Deploy khi CARP chưa
có beacon: đặt `backing_nft_policy` và `backing_script_hash` = 28 byte 0 — không
UTxO nào thoả được, cửa đóng sạch. Test:
`ig_neg_missing_beacon`, `ig_neg_forged_beacon_address`, `ig_neg_stale_beacon`,
`ig_neg_depeg`, `ig_neg_red_backing`.

> **Không dùng được `GlobalState` đã deploy.** Bản CARP hiện tại là datum
> CDP-pricing 5 trường (`twap` / `spot` / `breaker` / `nsf` / `valid_until`),
> **không có `br_q`** và không có `magic_supply`. Nó không phục vụ được cổng
> thặng dư này. Câu hỏi đã gửi CARP, chưa có trả lời.

---

## 5. Apply-param mới

### Nguồn duy nhất: blueprint, không phải bảng chép tay

Danh sách tham số thật đọc từ **`parameters[]` trong `<Module>/onchain/plutus.json`** —
blueprint do `aiken build` sinh thẳng từ chữ ký `validator vault(...)`, nên nó không thể
lệch với mã đã biên dịch. Cổng đối chiếu:

```bash
cd InstantGen/onchain && aiken build       # sinh plutus.json (artifact, đã gitignore)
cd ../../scripts && npm run check:params   # đối chiếu TÊN + THỨ TỰ
```

`scripts/check_param_names.ts` đặt cạnh nhau `parameters[].title` của blueprint và danh
sách mà `scripts/deployParams.ts` cấp cho từng validator, rồi khẳng định trùng cả tên lẫn
thứ tự. Phải có cổng máy vì `applyParamsToScript` **không kiểm arity**: thiếu một tham số
vẫn ra script hash 28 byte trông hợp lệ, vault vẫn nhận LAMP thật, và mọi tx spend về sau
fail vĩnh viễn — LAMP kẹt, không đường nào gỡ. Không test nào đỏ, không lệnh biên dịch nào
gãy.

> **Bảng dưới chỉ là ảnh chụp cho người đọc — blueprint mới là trọng tài.** Lệch nhau thì
> tin blueprint và chạy `npm run check:params`. Bản trước của chính bảng này ghi InstantGen
> 6 tham số / ScheduleGen 3 tham số, bỏ sót `lamp_asset_name` ở cả hai — đúng kiểu sai mà
> bảng chép tay sinh ra.

### InstantGen `vault` — 7 tham số

| # | Tên | Ghi chú |
|---|---|---|
| 1 | `lamp_policy_id` | không đổi |
| 2 | `lamp_asset_name` | **PARAM theo mạng** — `tLAMP` testnet / `LAMP` mainnet. Hardcode = vault mainnet không nhìn thấy LAMP của chính nó (`BOUNDARIES.md §2`) |
| 3 | `um_nft_policy` | không đổi |
| 4 | `um_script_hash` | không đổi |
| 5 | `backing_nft_policy` | ghim NFT beacon (§6.3) |
| 6 | `backing_script_hash` | ghim địa chỉ beacon (§6.3) |
| 7 | `ms_per_epoch` | không đổi |

Đây là **một** danh sách dùng chung cho cả hai handler của script đa-mục-đích: nhánh
`mint` (NFT danh tính vault) và nhánh `spend` phải nhận y hệt tham số, nếu không hai bên ra
hai script hash khác nhau và NFT mint ra không thuộc vault nào.

`treasury_addr` **không còn tồn tại** — sau khi bỏ nhánh chuyển LAMP (I-ACT-7), đã rà toàn
bộ 6 handler (`InstantGen`, `PruneExpired`, `BurnBatch`, `UpdateProfile`, `WithdrawLamp`,
`SetDelegate`) và không handler nào đọc tới nó.

### ScheduleGen `vault` — 4 tham số

| # | Tên |
|---|---|
| 1 | `lamp_policy_id` |
| 2 | `lamp_asset_name` (PARAM theo mạng — như trên) |
| 3 | `shard_policy_id` |
| 4 | `ms_per_epoch` |

`treasury_addr` đã xoá; đã rà 5 handler (`ScheduleCommit`, `ScheduleFire`, `BurnBatch`,
`WithdrawLamp`, `SetDelegate`), không handler nào còn đọc.

`shard` validator: không đổi (`shard_policy_id_param`).

Nơi phải cập nhật đồng thời (đã làm): `MagicSDK/src/validatorScripts.ts`,
`scripts/config.ts`, `scripts/deploy/05_create_instant_vault.ts`,
`scripts/deploy/07_create_schedule_vault.ts`, `scripts/verify_per_network.ts`,
`scripts/test/{instant_only,schedule_commit_only,schedule_fire_only,withdraw_only,update_profile_only,multi_vault_only}.ts`.

Biến môi trường mới: `BACKING_NFT_POLICY_ID`, `BACKING_SCRIPT_HASH` (mặc định
28 byte 0 = beacon chưa có = Gen đóng).

---

## 6. Interface KHÔNG bị phá

| Ràng buộc | Trạng thái |
|---|---|
| `BurnBatch` = constr 2, chữ ký `{ burns: List<(ByteArray, Int)> }` | **giữ nguyên** cả InstantGen lẫn ScheduleGen |
| `ConsumeMAGIC/CONTRACT.md` v2 | không đụng; `consume.ak` không giải mã `VaultDatum` (§7.4) nên đổi ngữ nghĩa trường datum không ảnh hưởng |
| Hình dạng Plutus Data của `VaultDatum` | không đổi (17 trường; `ActivityState` vẫn 2 trường; `MagicBatch` vẫn 9 trường) |
| `VaultRedeemer` số biến thể + chỉ số | không đổi (0..5); chỉ nhãn constr 1 đổi tên, vẫn nullary |

`ConsumeMAGIC/offchain` vẫn xanh sau thay đổi (số kiểm: [`DEVSTATUS.md`](../DEVSTATUS.md)).

---

## 7. Danh sách [CẦN XÁC NHẬN]

1. **Schema `BackingBeaconDatum`** (mục 4.4) — chờ CARP đối chiếu và cấp beacon.
   Trước khi có: InstantGen đóng.
2. **`instant_reward_rate_q = 0.20`** — spec §6.3 không cho dạng hàm
   `reward(consumed)`; 0.20 là đề xuất. Ràng buộc cứng duy nhất từ spec là
   `INV-CASHBACK-BOUND` (reward ≤ consumed), thoả với biên rộng (0.46 ở trường
   hợp xấu nhất).
3. **"Trần-kép" per-vault hay toàn hệ** (mục 4.3) — và kèm theo là quyết định
   gộp vault InstantGen + ScheduleGen, hoặc thêm apply-param tham chiếu chéo.
   Chưa quyết thì cửa InstantGen đóng.
4. **`consumed` phía vault vs phía engage** (mục 4.1) — đã chọn phía vault cho
   thưởng InstantGen (an toàn nhờ `s < 1`), giữ phía engage cho Governance C1.
   Nếu muốn thống nhất một nguồn thì phải quyết ở tầng kiến trúc.
5. **Đề xuất sửa spec** (không tự sửa): §11 bảng constructor index nên ghi
   constr 1 của InstantGen là `PruneExpired` thay vì để trống, để khớp §7.4 vốn
   đã yêu cầu một redeemer dọn rác permissionless.
