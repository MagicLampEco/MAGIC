# DEVSTATUS — module nào đang sống, đang chết, đang mồ côi

> **Vai của tệp này:** trả lời "**cái gì đang đúng LÚC NÀY**". Chuyện *đã xảy ra* nằm ở
> [`CHANGELOG.md`](CHANGELOG.md); mô hình *phải thế nào* nằm ở
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
| `Consolidate` | 12 | 21 | validator một phần, không có `aiken.toml` riêng để build standalone |
| `ProfileChange` | 8 | 13 | như trên; là script hash RIÊNG nên vault ở địa chỉ InstantGen không bao giờ chạy được validator của nó — tàn dư mô hình "4 module chung một vault" |
| `AppEconomics` | 54 | — | `SPEC.md` còn bám GenMAGIC v3.3 và tự khai NORMATIVE, mâu thuẫn với spec canonical |

Ba module này **chưa được quyết**: hội tụ vào mô hình ba-token, hay dời tiếp vào `Legacy/`.
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
| 5 | Nguồn gốc `PrepaidGen` đã mất | chỉ còn `plutus.json` (bytecode); `git log --all --diff-filter=A` không trả về tệp nguồn nào |
| 6 | **InstantGen chưa bao giờ cấp được 1 nanogic** | trần thứ ba còn là `0.5 × Σ(gen_schedules)` kiểu cũ; vault thường có `gen_schedules = []` ⇒ trần 0 ⇒ `expect grant > 0` fail. SPEC §6.3 đòi `⌊L_avail × RATE_REF_Q / Q⌋`. **Chờ chủ nhân chốt** — phải vá CÙNG LÚC với `INV-INSTANT-LOCK`, không thì mở đường flash-rent LAMP |
| 7 | `ConsumeMAGIC` chưa có `buildPostPriceTx` | bất biến "giữ nguyên phần non-ADA của beacon" chưa có bên off-chain nào thực thi |
| 8 | `buildConsumeTx` mới dựng 1 Engage input | on-chain là bất biến AGGREGATE qua N input — tập con hợp lệ, nhưng chưa gộp được nhiều thread |
| 9 | Không có đường đóng thread Engage / vault | mint ép `qty == 1` nên burn bất khả ⇒ min-ADA khoá vĩnh viễn mỗi thread. Cố ý, nhưng là quyết định cần biết |

## Chờ chủ nhân chốt

| # | Câu hỏi | Vì sao không tự quyết |
|---|---|---|
| D1 | Viết lại trần InstantGen theo SPEC §6.3 + hiện thực `INV-INSTANT-LOCK`? | là viết lại công thức sinh MAGIC + thêm trường datum, không phải sửa lỗi. §6.2 (tư-cách 4 thành phần) cũng chưa từng tồn tại trong code |
| D2 | `ScheduleGen` cho suất ≈0,0113 MAGIC/LAMP/epoch, spec chốt ρ=1 — chính sách siết thêm hay drift? | spec cho phép lớp dịch vụ siết dưới trần, nhưng trần `⌊L_avail×RATE_REF_Q/Q⌋` thì không tồn tại ở đâu trong ScheduleGen |
| D3 | `did_commit` lúc genesis: để tự do hay ép rỗng? | ép rỗng khoá chết đường bind DID PhoenixKey sau; mở thì người đúc đặt được `did_commit` của người khác |
| D4 | `AppEconomics` · `ProfileChange` · `Consolidate` — hội tụ hay dời `Legacy/`? | chờ chốt PM/tư-cách trong spec canonical; dọn trước là dọn mù |
| D5 | `_appeconomics_legacy.ts` + 31 ca test bám vào nó | buộc chung số phận với `AppEconomics` (D4) — nó là bản sao math của module đó |
| D6 | `MagicSDK/V1_TESTNET_PLAN.md` — viết lại theo 2 vault hay dời `Legacy/`? | chưa deploy mạng nào; viết ma trận nghiệm thu bây giờ là viết mù lần hai |
| D7 | `MAX_PRICE_STALE = 1` có đúng ý định? | mainnet 1 epoch = 5 ngày ⇒ `stale=1` là chấp nhận giá trễ 5 ngày. Và **chưa có keeper** post lại giá ⇒ hệ tự khoá sau 1 epoch |

---

## Bất biến đang được cưỡng chế (đừng phá khi sửa)

- **INV-VAULT-IDENTITY** — mọi vault mang một NFT one-shot sinh cùng lúc với vault
  (`asset_name = blake2b_256(cbor.serialise(seed))`, policy = chính script hash). Không có
  NFT thì không nhánh spend nào đi qua. Bịt lỗ "đặt UTxO giả ở địa chỉ script với datum bịa".
- **P8** — toán Aiken và TypeScript trùng bit, vector chuẩn trong `tests/` là trọng tài.
- **Σburns == required** (ConsumeMAGIC) — dấu bằng, lệch một nanogic là tx bị từ chối.
- **Chỉ số constructor Plutus Data là hợp đồng nhị phân** — variant đã bỏ khỏi mô hình
  (`BatchSource::Snapshot`, `::Vacuum`) và trường `vacuum_orders` vẫn phải nằm nguyên chỗ cũ.
- **`lamp_asset_name` là apply-param #2 của mọi vault**, suy ra từ mạng, không hardcode.
