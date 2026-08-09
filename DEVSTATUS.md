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
| `ScheduleGen` | hợp đồng kỳ hạn, rate khoá lúc commit, 16 shard | 39 | 48 |
| `UMKeeper` | cập nhật hệ số cầu mạng UM mỗi epoch | 20 | 10 |
| `ConsumeMAGIC` | tiêu thụ MAGIC (đốt theo giá nghiệp vụ) | 47 | 50 |
| `ConsumeMAGIC/pricing` | `@magiclamp/consumemagic-pricing` — bộ định giá | 46 | (dùng chung) |
| `MagicSDK` | mặt tiền cho bên tích hợp | 47 | — |
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
| `ProfileChange` | 8 | 13 | như trên; `EXEC.md` còn viết "dùng chung vault với SnapshotGen" — vault đó đã chết |
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
