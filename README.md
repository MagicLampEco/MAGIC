# MagicLamp Network — MAGIC Protocol

Hợp đồng thông minh Cardano L1 (PlutusV3) cho hệ **ba token** LAMP · MAGIC · CARP.

> **Nguồn chân lý:** [`Specs/MagicLamp-Tripletoken-Feat-(Vi).md`](Specs/MagicLamp-Tripletoken-Feat-(Vi).md).
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
| **LAMP** | tài sản nền / thế chấp | native token, **trần** 36 tỷ (lazy-mint: tổng đã sinh luôn ≤ trần, không phải 36 tỷ đã nằm sẵn trên chuỗi), không burn — `BOUNDARIES.md` §1 |
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
├── Specs/                 # ĐẶC TẢ CANONICAL — đọc trước khi sửa bất cứ công thức nào
├── ProtocolUtils/        # Thư viện dùng chung (hằng số, Q-format, BigInt) — P8
├── InstantGen/           # Sinh MAGIC theo yêu cầu, vault hợp nhất DESIGN-2
├── ScheduleGen/          # Hợp đồng kỳ hạn, rate khoá lúc commit, 16 shard
├── PrepaidGen/           # Cửa sinh thứ ba — người dùng trả CARP
├── GenBeacons/           # Beacon ρ (RateParam), beacon GreenBack, shard bộ đếm thặng dư GB
├── UMKeeper/             # Cập nhật hệ số cầu mạng UM mỗi epoch (permissionless)
├── ConsumeMAGIC/         # Tiêu thụ MAGIC (đốt theo giá nghiệp vụ) + bộ định giá
│   └── pricing/          # @magiclamp/consumemagic-pricing — gói gọi được (ESM + CJS)
├── Eligibility/          # Tư cách nhận — cổng vào của vòng gen
├── MagicSDK/             # Mặt tiền cho bên tích hợp
├── VaultReadAPI/         # Mặt tiền ĐỌC vault qua HTTP
├── VaultTxAPI/           # Mặt tiền DỰNG giao dịch qua HTTP
├── FlowRate/             # Điều tiết nhịp
├── AppEconomics/         # Lớp thưởng app          (chưa hội tụ ba-token)
├── TestSupport/          # Bộ giả dùng chung cho test off-chain
├── scripts/              # Deploy + kiểm thử testnet
└── Legacy/               # KHO LƯU TRỮ — không đọc, không build, không deploy
```

Mỗi module cùng một khuôn: `onchain/` (Aiken) · `offchain/` (TypeScript + vitest) ·
`tests/` (vector chuẩn). Không có workspace ở gốc — mỗi `offchain/` là một gói npm độc lập.

---

## Chạy kiểm

Từ một checkout sạch, `npm install` trong bất kỳ gói `offchain/` nào là đủ — không có
bước dựng tay nào đi trước:

```bash
cd InstantGen/offchain && npm install && npm test
```

Hai gói `ProtocolUtils` và `ConsumeMAGIC/pricing` xuất bản `dist/` (ESM + CJS) và được
các gói khác nạp qua `file:`. Chúng tự dựng lấy trong `prepare` — kịch bản
`prepare.mjs` tự cài bộ công cụ của chính nó rồi mới gọi `tsc`, nên lần cài đầu tiên
chậm hơn vài chục giây, chỉ vậy. **Không cần** `cd ProtocolUtils && npm run build`
trước. Nếu gặp `tsc: command not found` khi `npm install` thì đó là bản cũ hơn
commit "npm install từ checkout sạch" — cập nhật nhánh, đừng dựng tay.

Chạy cả loạt:

```bash
for m in InstantGen ScheduleGen UMKeeper ConsumeMAGIC AppEconomics; do
  echo "=== $m ===" && (cd $m/offchain && npm install --silent && npm test)
done
```

> `MagicSDK` là ngoại lệ: `npm install` xanh, nhưng nhiều tệp trong `MagicSDK/tests/` đọc
> `onchain/plutus.json` của các module — artifact đã gitignore. Phải `aiken build` các module
> đó trước, nếu không các bài đọc chúng ngã ENOENT. Liệt kê tệp đọc:
> `grep -rln 'plutus.json' MagicSDK/tests`.

```bash
for m in InstantGen ScheduleGen UMKeeper; do
  echo "=== $m ===" && (cd $m/onchain && aiken check)
done
```

> Aiken 1.1.21 qua pipe: khi thành công hoặc khi có bài kiểm đỏ, stdout là JSON đầy đủ; khi
> LỖI BIÊN DỊCH, stdout RỖNG. Cách chạy và đọc đúng: `BOUNDARIES.md` §4.

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
