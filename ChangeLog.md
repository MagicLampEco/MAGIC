# ChangeLog — repo MAGIC

> **Vai:** ghi **chuyện đã xảy ra**, mới nhất trên đầu. Mỗi mục nêu đủ ba vế: *đổi gì ·
> vì sao · cái gì gãy nếu ai đó đang bám bản cũ*. Trạng thái hiện tại thì xem
> [`DevStatus.md`](DevStatus.md); mô hình chuẩn xem
> [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](SPEC/MagicLamp-Tripletoken-Feat-(Vi).md).

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
   dù `validate_fire`, genesis và `validate_withdraw_lamp` đều có.
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

**Vì sao.** `SPEC/MagicLamp-Tripletoken-Feat-(Vi).md:174` (§6.1) chốt đúng ba cửa sinh —
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
- `SPEC/MagicLamp-Tripletoken-Feat-(Vi).md` §10: nguồn của C1 đổi từ `consumed_count` sang
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
vụ hai module đó. Đặc tả canonical `SPEC/MagicLamp-Tripletoken-Feat-(Vi).md` được mang về
nhánh làm việc. `README.md` viết lại theo mô hình ba-token. Dựng `ChangeLog.md`,
`DevStatus.md`, `Legacy/README.md`. Tham chiếu treo trong `scripts/` vá cùng đợt.

**Vì sao.** Ba lớp chi phí đo được trong chính repo này: (1) mỗi lần rà soát, người và
agent phải mở lại 52 tệp của hai module đã chết chỉ để kết luận "bỏ rồi"; (2) cả ba tài
liệu-vào-đầu (`README.md`, `CLAUDE.md`, `DEVELOPER_GUIDE.md`) dẫn người đọc vào mô hình đã
bỏ, và mọi con trỏ "nguồn chân lý" trong mã đều treo vì `SPEC/` không có trên nhánh này;
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
