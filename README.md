# MagicLamp Network — MAGIC Protocol

Hợp đồng thông minh Cardano L1 (PlutusV3) cho hệ **ba token** LAMP · MAGIC · CARP.

> **Nguồn chân lý:** [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](SPEC/MagicLamp-Tripletoken-Feat-(Vi).md).
> Mâu thuẫn giữa README này (hoặc bất kỳ tài liệu nào khác) với spec đó → **theo spec**.
> README chỉ dẫn đường, không định nghĩa lại mô hình.
>
> **Trạng thái từng module:** [`DevStatus.md`](DevStatus.md) — một nơi duy nhất, kèm lệnh
> kiểm chứng. Đừng chép số test ra chỗ khác.
>
> **Lịch sử thay đổi:** [`ChangeLog.md`](ChangeLog.md).

---

## Ba token, ba vai không gộp được

| Token | Vai | Bản chất |
|---|---|---|
| **LAMP** | tài sản nền / thế chấp | native token, cố định 36 tỷ, không mint thêm, không burn |
| **MAGIC** | quyền-tiêu-dịch-vụ (tín dụng) | **không phải token** — số kế toán trong datum vault, gắn PersonDID, không chuyển nhượng |
| **CARP** | đồng-thanh-khoản | native token có policy riêng, chuyển nhượng được, giữ giá bằng sàn-tiện-ích |

Quy luật: **LAMP sinh MAGIC · CARP chở giá trị tới nơi tiêu · MAGIC tiêu xong hoặc tan biến.**
Chi tiết: spec §0–§4.

Đơn vị nhỏ nhất — mỗi token một tên riêng, cố ý không trùng nhau:
`nanogic` (MAGIC) · `nanothread` (CARP) · `oildrop` (LAMP). Tên `nanothread` do repo
CarpetMint sở hữu (`CarpetMint-Core-Spec-Vi.md §T1`); MAGIC chỉ tham chiếu.

---

## Repo có gì

```
MAGIC/
├── SPEC/                 # ĐẶC TẢ CANONICAL — đọc trước khi sửa bất cứ công thức nào
├── ProtocolUtils/        # Thư viện dùng chung (hằng số, Q-format, BigInt) — P8
├── InstantGen/           # Sinh MAGIC theo yêu cầu, vault hợp nhất PHA-2
├── ScheduleGen/          # Hợp đồng kỳ hạn, rate khoá lúc commit, 16 shard
├── UMKeeper/             # Cập nhật hệ số cầu mạng UM mỗi epoch (permissionless)
├── ConsumeMAGIC/         # Tiêu thụ MAGIC (đốt theo giá nghiệp vụ) + bộ định giá
│   └── pricing/          # @magiclamp/consumemagic-pricing — gói gọi được (ESM + CJS)
├── GetMAGIC/             # Cổng vào (Phase 1, độc lập, chưa nối vault)
├── MagicSDK/             # Mặt tiền cho bên tích hợp
├── Paymaster/            # Trả phí hộ (SponsorMeter)
├── FlowRate/             # Điều tiết nhịp
├── Consolidate/          # Gộp holding phân mảnh   (validator một phần)
├── ProfileChange/        # Đổi profile 2 bước      (validator một phần)
├── AppEconomics/         # Lớp thưởng app          (chưa hội tụ ba-token)
├── scripts/              # Deploy + kiểm thử testnet
└── Legacy/               # KHO LƯU TRỮ — không đọc, không build, không deploy
```

Mỗi module cùng một khuôn: `onchain/` (Aiken) · `offchain/` (TypeScript + vitest) ·
`tests/` (vector chuẩn). Không có workspace ở gốc — mỗi `offchain/` là một gói npm độc lập.

---

## Chạy kiểm

```bash
for m in InstantGen ScheduleGen UMKeeper Consolidate ProfileChange ConsumeMAGIC AppEconomics; do
  echo "=== $m ===" && (cd $m/offchain && npm install --silent && npm test)
done
```

```bash
for m in InstantGen ScheduleGen UMKeeper; do
  echo "=== $m ===" && (cd $m/onchain && aiken check)
done
```

> Aiken 1.1.21 không in gì khi bị đưa qua pipe. Muốn giữ output thì
> `script -q /tmp/out.txt aiken check` rồi đọc `/tmp/out.txt`.

Validator không được build sẵn trong repo — phải `aiken build` từng module trước khi
deploy (`onchain/plutus.json` là artifact, đã gitignore).

---

## Ràng buộc phải biết trước khi sửa code

Đầy đủ ở [`BOUNDARIES.md`](BOUNDARIES.md). Bốn cái hay bị vi phạm nhất:

1. **Toán Aiken ↔ TypeScript phải trùng bit (P8).** Sửa một bên thì sửa bên kia, và
   vector chuẩn trong `tests/` là trọng tài.
2. **BigInt cho mọi số tiền.** `Number` cho oildrop/nanogic là lỗi tràn số đang chờ xảy ra.
3. **Chỉ số constructor Plutus Data là hợp đồng nhị phân.** Đổi thứ tự một variant
   (`BatchSource`, redeemer) hay bỏ một field (`vacuum_orders`) = vỡ decode mọi UTxO đã tạo.
   Thứ đã bỏ khỏi mô hình vẫn phải giữ làm bia mộ.
4. **`lamp_asset_name` là tham số theo mạng** (`tLAMP` testnet / `LAMP` mainnet), không
   bao giờ hardcode — nó là apply-param #2 của mọi vault.

---

## Liên kết

- PhoenixKey SDK: https://github.com/PhoenixKeyDID/PhoenixKey-SDK
- Cardano Preview faucet: https://docs.cardano.org/cardano-testnet/tools/faucet
- Blockfrost: https://blockfrost.io
- Aiken: https://aiken-lang.org
