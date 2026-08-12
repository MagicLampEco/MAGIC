# DevStatus — module nào đang sống, đang chết, đang mồ côi

> **Vai của tệp này:** trả lời "**cái gì đang đúng LÚC NÀY**". Chuyện *đã xảy ra* nằm ở
> [`ChangeLog.md`](ChangeLog.md); mô hình *phải thế nào* nằm ở
> [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](SPEC/MagicLamp-Tripletoken-Feat-(Vi).md).
>
> **Đây là nơi DUY NHẤT ghi trạng thái + số kiểm.** Đừng chép số test sang README, sang
> spec, sang PR body. Bài học đo được: một con số test từng sống ở 28 vị trí với 12 giá
> trị khác nhau, và bản sai lọt ra trang công khai. Cần số thì trỏ về đây, hoặc chạy lệnh.

**Đo lúc:** 2026-08-09 · **trên nhánh** `feat/converge-tripletoken-code`.
Số dưới đây là ảnh chụp — hết hạn ngay khi có commit mới. Lệnh kiểm chứng nằm ngay cạnh.

---

## Đang sống — nằm trong mô hình ba-token

| Module | Vai | vitest | `aiken check` |
|---|---|---|---|
| `ProtocolUtils` | thư viện dùng chung (hằng, Q-format, BigInt) | 26 | — |
| `InstantGen` | sinh MAGIC theo yêu cầu, vault hợp nhất PHA-2 | 55 | 83 |
| `ScheduleGen` | hợp đồng kỳ hạn, rate khoá lúc commit, 16 shard | 39 | 51 |
| `UMKeeper` | cập nhật hệ số cầu mạng UM mỗi epoch | 20 | 10 |
| `ConsumeMAGIC` | tiêu thụ MAGIC (đốt theo giá nghiệp vụ) | 67 | 98 |
| `ConsumeMAGIC/pricing` | `@magiclamp/consumemagic-pricing` — bộ định giá | 62 | (dùng chung) |
| `MagicSDK` | mặt tiền cho bên tích hợp | 51 | — |
| `GetMAGIC` | cổng vào, Phase 1 (chưa nối vault) | 41 | 0 lỗi |
| `Paymaster` | trả phí hộ (SponsorMeter) | 26 | 28 |
| `FlowRate` | điều tiết nhịp | 19 | (không có `aiken.toml`) |

```bash
# vitest một module
cd <Module>/offchain && npm test          # ConsumeMAGIC/pricing và MagicSDK: npm test tại chính thư mục đó

# aiken — 1.1.21 không in gì khi bị pipe
cd <Module>/onchain && script -q /tmp/out.txt aiken check && cat /tmp/out.txt
```

## Mồ côi — còn dùng được nhưng chưa có nhà rõ ràng

| Module | vitest | `aiken check` | Vướng ở đâu |
|---|---|---|---|
| `Consolidate` | 12 | 21 | là script hash RIÊNG nên vault ở địa chỉ InstantGen không bao giờ chạy được validator của nó — tàn dư mô hình "4 module chung một vault" |
| `ProfileChange` | 8 | 13 | như trên |
| `AppEconomics` | 54 | — | `SPEC.md` còn bám GenMAGIC v3.3 |

> Bản trước ghi hai module đầu "không có `aiken.toml` riêng để build standalone". **Sai** — cả
> hai đều có `onchain/aiken.toml` được track, và `aiken build` chạy 0 lỗi. Vật cản được nêu
> không tồn tại, nên D4 suýt treo vì lý do sai: người gỡ treo sẽ đi tạo một tệp đã có sẵn thay
> vì xử lý vật cản thật (script hash riêng). Bản trước cũng ghi `AppEconomics/SPEC.md` "tự khai
> NORMATIVE" — dòng đó đã được gỡ khỏi tệp kia rồi.

**Cả ba đều KHÔNG có NFT danh tính.** `vault_consolidate.ak` và `vault_profile.ak` chỉ có
handler `spend`, không có `mint`, và đếm được 0 tham chiếu tới NFT vault. Chưa hại vì chưa có
tài sản đi qua; nhưng nếu D4 chốt hội tụ thì phải nối `INV-VAULT-IDENTITY` **trước**, không thì
mở lại lỗ 2-ADA-datum-bịa.

Ba module này **chưa được quyết**: hội tụ vào mô hình ba-token, hay **xoá**. (Không còn lựa
chọn "dời `Legacy/`" — chủ nhân đã bãi bỏ `Legacy/` ngày 2026-08-09; xem `## Không được xoá`.)
Chờ chốt PM/tư-cách trong spec canonical rồi mới xử — dọn sớm là dọn mù.

## Đã chết — ở `Legacy/genmagic-v3.3/`, không đọc

`SnapshotGen` · `VacuumGen` · 10 báo cáo testnet · `SnapshotGen-Simulator.HTML` ·
`DEVELOPER_GUIDE.md` · 5 tệp script phục vụ riêng hai module trên.
Lý do từng cái: [`Legacy/README.md`](Legacy/README.md).

---

## Còn nợ — biết rõ, chưa làm

| # | Việc | Vì sao chưa |
|---|---|---|
| 1 | Chưa deploy mạng nào | cần credential + quyết định của chủ nhân |
| 2 | `BackingBeacon` (§6.3) chưa có bytes thật | chờ CarpetMint deploy lại — policy id của CARP **sẽ đổi**, đang để all-zero fail-closed nên InstantGen đóng cửa an toàn |
| 3 | Chưa có CI | không có `.github/`; mọi kiểm hiện chạy tay |
| 4 | `AppEconomics` chưa hội tụ | xem mục mồ côi |
| 5 | Nguồn `PrepaidGen` **chưa mất** — đang treo trong `refs/stash@{0}` | 24 tệp nguồn (`prepaid.ak`, `fund_nft.ak`, trọn `offchain/src`, `tests/`, `DESIGN.md`). Bản ghi cũ ở đây kết luận "đã mất" vì `git log --all --diff-filter=A` trả rỗng — nhưng `--all` **không quét `refs/stash`**, nên rỗng ở đó không có nghĩa là mất. Nguyên nhân gốc: code viết trên `feat/genmagic-v0.2-handoff`, **chưa từng commit**, bị `git stash` tự hứng lúc chuyển nhánh 2026-07-30 và không ai `pop` lại. Đã neo bằng tag `preserve/prepaidgen-stash-2026-07-30` để `git stash clear/drop` không xoá được. Kiểm: `git ls-tree -r --name-only preserve/prepaidgen-stash-2026-07-30^{commit}^3 \| grep -c '^PrepaidGen/'` → 24 |
| 6 | **InstantGen chưa bao giờ cấp được 1 nanogic** | trần thứ ba còn là `0.5 × Σ(gen_schedules)` kiểu cũ; vault thường có `gen_schedules = []` ⇒ trần 0 ⇒ `expect grant > 0` fail. SPEC §6.3 đòi `⌊L_avail × RATE_REF_Q / Q⌋`. **Chờ chủ nhân chốt** — phải vá CÙNG LÚC với `INV-INSTANT-LOCK`, không thì mở đường flash-rent LAMP |
| 7 | `ConsumeMAGIC` chưa có `buildPostPriceTx` | bất biến "giữ nguyên phần non-ADA của beacon" chưa có bên off-chain nào thực thi |
| 8 | `buildConsumeTx` mới dựng 1 Engage input | on-chain là bất biến AGGREGATE qua N input — tập con hợp lệ, nhưng chưa gộp được nhiều thread |
| 9 | Không có đường đóng thread Engage / vault | mint ép `qty == 1` nên burn bất khả ⇒ min-ADA khoá vĩnh viễn mỗi thread. Cố ý, nhưng là quyết định cần biết |
| 10 | `UMKeeper/offchain/src/keeper.ts` **chưa từng chạy với node thật** | Tệp này trước đây **không biên dịch được** (4 lỗi kiểu) và không ai biết: gói không có `tsconfig.json` nên `tsc --noEmit` chưa từng chạy, còn vitest chỉ chạm `math.ts`. Nó cũng import `@lucid-evolution/lucid` mà `package.json` không khai. Đã vá cả ba (thêm `tsconfig.json`, khai dep, dựng cặp `Data.Static` mà lucid-evolution bắt buộc) ⇒ nay `npm run typecheck` xanh, `npm test` 20/20. Nhưng **xanh kiểu ≠ chạy đúng**: `getEpochStats` vẫn là bản giả trả số cố định, và chưa có lần chạy nào với Blockfrost. Liên quan D7 |
| 11 | ~~4 gói + `scripts/` chưa có `tsconfig.json`~~ **ĐÃ VÁ 2026-08-12, trừ `scripts/`** | Bản ghi cũ ở đây **sai hai chiều**: nó bỏ sót `FlowRate/offchain` và `ProtocolUtils` (gói P8 chuẩn, 25 tệp import). Nay cả sáu đều có `tsconfig.json` + script `typecheck`. Năm gói xanh 0 lỗi. Còn hai chỗ đỏ, ghi riêng ở #12 và #13 |
| 12 | `scripts/` typecheck **19 lỗi** | Gói duy nhất chạm ví thật. Nay đã có `tsconfig.json` + `npm run typecheck`, và cổng bắt được ngay một lỗi THẬT: `test/consume_only.ts` dựng `EngageDatum` thiếu `consumed_nanogic` ⇒ tx dựng ra bị validator từ chối (W-CM-12) — đã vá. 19 lỗi còn lại thuộc hai lớp: (a) `Data.to(x, Schema)` truyền lược đồ thay vì kiểu tĩnh — cùng lớp đã vá ở UMKeeper; (b) hai bản `@lucid-evolution/lucid` (`scripts/node_modules` vs `InstantGen/offchain/node_modules`) cho hai định danh kiểu khác nhau. Con số này chỉ được phép GIẢM |
| 13 | `ProfileChange/offchain` typecheck **3 lỗi** | `src/profile.ts` import `Tx` — lucid-evolution 0.4.30 không export tên đó; và một `Data.to` truyền lược đồ. Trước 2026-08-12 gói không có `tsconfig.json` nên chưa ai thấy. Buộc chung số phận D4 |
| 14 | 🔴 `validate_burn_batch` **không đòi ConsumeMAGIC co-spend** — liên kết giá MỘT CHIỀU | `InstantGen/onchain/validators/vault.ak:851-936`: auth = chủ HOẶC `personal_delegate`, và không ràng buộc input nào ở địa chỉ `consume`, không đọc PriceParam beacon. `consume.ak:95` ép chặt chiều consume→vault; chiều ngược lại bỏ ngỏ. Hệ quả: một delegate ký được tx BurnBatch trần trụi, không giao dịch vụ gì, đốt sạch MAGIC của chủ vault (LAMP và ADA vẫn an toàn — hai chốt dưới chặn đúng). `personal_delegate` hiện là `Option<ByteArray>` trần: không hạn mức, không phạm vi op, không hạn dùng. Vá đụng validator ⇒ xem D8 |
| 15 | Không ai kiểm chữ ký chủ trên nhánh **spend** của Engage | `ConsumeMAGIC/onchain/validators/consume.ak` dùng `extra_signatories` đúng MỘT lần, ở nhánh **mint** (`:253`). Nhánh spend chỉ ép `owner` được bảo toàn. Hôm nay đây là TÍNH NĂNG (nó cho phép Feecover ứng trước cho ví 0 MAGIC — đã trả lời PhoenixKey 2026-08-12), nhưng nó cũng nghĩa là ai cũng bơm được `consumed_count`/`consumed_nanogic` của người khác. Sẽ thành lỗ ngay khi attribution/ISPO đọc hai trục đó |
| 16 | `GetMAGIC/onchain` biên dịch sạch nhưng **0 test Aiken** | `aiken check` → `0 checks, 0 errors`. Không có `test` nào định nghĩa trong validator. Biên dịch được không có nghĩa có bài kiểm — cùng họ với Nợ #10 |
| 17 | `Paymaster`: `ada_per_magic_q` không có chặn âm | `paymaster.ak:111` chặn `lamp_per_magic_q` bằng sàn giao thức, `ada_per_magic_q` thì không. Với giá âm, Aiken `/` (làm tròn xuống) cho `-1` còn TS BigInt `/` (cắt về 0) cho `0` ⇒ off-chain dựng tx mà on-chain từ chối. Fail-closed, không mất tiền, nhưng là chỗ P8 lệch theo dấu |
| 18 | `scripts/config.ts:75-76` khai lại `SHARD_COUNT`/`SHARD_CAP` độc lập | Giá trị hiện đang bằng ScheduleGen. Hai nguồn cho một sự thật — đổi một bên là lệch im lặng |

## Chờ chủ nhân chốt

| # | Câu hỏi | Vì sao không tự quyết |
|---|---|---|
| D1 | Viết lại trần InstantGen theo SPEC §6.3 + hiện thực `INV-INSTANT-LOCK`? | là viết lại công thức sinh MAGIC + thêm trường datum, không phải sửa lỗi. §6.2 (tư-cách 4 thành phần) cũng chưa từng tồn tại trong code |
| D2 | `ScheduleGen` cho suất ≈0,0113 MAGIC/LAMP/epoch, spec chốt ρ=1 — chính sách siết thêm hay drift? | spec cho phép lớp dịch vụ siết dưới trần, nhưng trần `⌊L_avail×RATE_REF_Q/Q⌋` thì không tồn tại ở đâu trong ScheduleGen |
| D3 | `did_commit` lúc genesis: để tự do hay ép rỗng? | ép rỗng khoá chết đường bind DID PhoenixKey sau; mở thì người đúc đặt được `did_commit` của người khác |
| D4 | `AppEconomics` · `ProfileChange` · `Consolidate` — hội tụ hay xoá? | chờ chốt PM/tư-cách trong spec canonical; dọn trước là dọn mù |
| D5 | `_appeconomics_legacy.ts` + 31 ca test bám vào nó | buộc chung số phận với `AppEconomics` (D4) — nó là bản sao math của module đó |
| D6 | `MagicSDK/V1_TESTNET_PLAN.md` — viết lại theo 2 vault hay xoá? | chưa deploy mạng nào; viết ma trận nghiệm thu bây giờ là viết mù lần hai |
| D7 | `MAX_PRICE_STALE = 1` có đúng ý định? | mainnet 1 epoch = 5 ngày ⇒ `stale=1` là chấp nhận giá trễ 5 ngày. Và **chưa có keeper** post lại giá ⇒ hệ tự khoá sau 1 epoch |
| D8 | Siết `personal_delegate` + bắt buộc co-spend ở `BurnBatch`? (Nợ #14) | Đụng validator đang sống VÀ đụng lược đồ datum. Hai việc, hai mức: (a) đòi ≥1 input ở `engage_script_hash` khi người ký là delegate — chỉ đổi logic, không đổi datum; (b) đổi `personal_delegate` từ `Option<ByteArray>` sang bản có `max_nanogic_per_epoch`/`expires_epoch`/`allowed_op_types` — đổi datum, trường mới phải THÊM Ở CUỐI để không lệch chỉ số constructor. Không tự quyết vì (b) là thay đổi mô hình uỷ nhiệm, không phải sửa lỗi |
| D9 | `PRICE_THRESHOLD` mặc định 1 — giữ hay bắt buộc M-of-N trước mainnet? | Beacon `PriceParam` là **reference input** của mọi tx Consume. Một khoá committee chèn `PostPrice` hợp lệ ngay trước là beacon bị chi, tx nạn nhân invalid từ gốc, lặp không giới hạn ⇒ **chặn dịch vụ nhắm đúng một người**. PhoenixKey đặt thành điều kiện W2 cho `op_type=7 did.rotate` (xoay khoá sau khi nghi lộ) — ở đó nó là chặn quyền tự vệ. Ghi chi tiết ở `ConsumeMAGIC/EXEC.md §4` |
| D10 | `op_type` nào được **giá cố định** (không nhân `demand_mult`)? | `demand_mult` tính từ `ops_served_epoch` gộp toàn hệ nên tải của module không liên quan định giá thao tác an ninh của DID, và một đợt lộ khoá hàng loạt làm Rotate đắt lên đúng lúc cần rẻ. Hai hình dạng: cờ `fixed` trong `OpPrice` (đổi lược đồ datum beacon đang sống, phải post lại mọi beacon) hoặc **dải `op_type` quy ước** (chỉ đổi hàm giá, không migrate). MAGIC nghiêng về dải quy ước. Chi tiết + đính chính "giá cố định thì khỏi đọc beacon" (SAI): `ConsumeMAGIC/CONTRACT.md §A` |

---

## Bất biến đang được cưỡng chế (đừng phá khi sửa)

- **INV-VAULT-IDENTITY** — vault **sống** (`InstantGen`, `ScheduleGen`) mang một NFT one-shot
  sinh cùng lúc với vault (`asset_name = blake2b_256(cbor.serialise(seed))`, policy = chính
  script hash). Không có NFT thì không nhánh spend nào đi qua. Bịt lỗ "đặt UTxO giả ở địa chỉ
  script với datum bịa". *Hai validator mồ côi chưa được nối — xem mục Mồ côi.*
- **P8** — toán Aiken và TypeScript trùng bit, vector chuẩn trong `tests/` là trọng tài.
- **Σburns == required** (ConsumeMAGIC) — dấu bằng, lệch một nanogic là tx bị từ chối.
  ⚠️ **MỘT CHIỀU.** Bất biến này sống trong `consume.ak`, nên nó chỉ tồn tại ở tx CÓ
  ConsumeMAGIC co-spend. `validate_burn_batch` của vault không đòi ConsumeMAGIC có mặt —
  xem Nợ #14. Đừng đọc dòng này thành "MAGIC chỉ giảm khi có dịch vụ".
- **`halved` KHÔNG phải bất biến.** Không có `expect` nào từ chối `halved == True`;
  validator chỉ không bao giờ SINH ra True. Chú thích cũ trong `types.ak` ghi "Any True
  value is rejected" — đã đính chính 2026-08-12.
- **Chỉ số constructor Plutus Data là hợp đồng nhị phân** — variant đã bỏ khỏi mô hình
  (`BatchSource::Snapshot`, `::Vacuum`) và trường `vacuum_orders` vẫn phải nằm nguyên chỗ cũ.
- **`lamp_asset_name` là apply-param #2 của mọi vault**, suy ra từ mạng, không hardcode.

---

## Không được xoá

> Mục cố định theo `_rules/agent-hygiene.md §4`. Chủ nhân đã **bãi bỏ `Legacy/`** ngày
> 2026-08-09: tệp lỗi thời thì **xoá**, không dồn sang đó. `Legacy/` đang có thì để yên, xoá
> dần khi đụng tới. Nguyên tắc chung: **định danh đã lên chain không bao giờ là tệp lỗi thời.**
>
> Danh sách này tồn tại vì `git log` trả lời được "cái gì đã bị xoá" nhưng không trả lời được
> "cái gì trông giống thứ đã xoá mà đừng đụng vào".

| Thứ | Nghe như chết vì | Thật ra sống ở đâu | Vỡ gì nếu bỏ |
|---|---|---|---|
| `UMKeeper/` | tên module nghe như tiện ích phụ | apply-param #3/#4 của `InstantGen/onchain/validators/vault.ak`; ref input UM bị ghim theo `um_script_hash` | InstantGen mất hệ số cầu mạng — công thức thưởng PHA-2 không tính được |
| hằng `snapshot_base_rate_q` | có chữ "snapshot", mà `SnapshotGen` đã chết | `ScheduleGen/onchain/validators/vault.ak` (`compute_rate_locked_q`, `baseline_at_commit_q`) + bản off-chain `SNAPSHOT_BASE_RATE_Q` | ScheduleGen mất mốc suất khoá lúc commit |
| variant `BatchSource::Snapshot` (0) và `::Vacuum` (2) | hai cửa sinh đó đã bỏ khỏi mô hình | `types.ak` của 4 module + `types.ts` tương ứng | 🔴 **chỉ số constructor đã lên chain** — đánh lại số là vỡ decode **mọi UTxO đã tạo** |
| trường `vacuum_orders` (index 6 của `VaultDatum`) | tên trỏ về cửa đã chết | 4 module vault, đúng vị trí thứ 7 | như trên — lệch vị trí là lệch toàn bộ trường phía sau |
| trường `halved` (index 8 của `MagicBatch`) | tự khai "DEAD FIELD", luôn `False` | `InstantGen/.../types.ak` | giữ hình dạng 9 trường tương thích byte với datum đã deploy |
| tag `preserve/prepaidgen-stash-2026-07-30` | trông như tag rác | neo 24 tệp nguồn `PrepaidGen` đang treo trong `refs/stash@{0}` | `git stash clear/drop` sẽ xoá thật cây nguồn đó — xem "Còn nợ #5" |
