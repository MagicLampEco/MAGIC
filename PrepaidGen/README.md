# PrepaidGen — cửa sinh MAGIC từ CARP (§6.5)

Cửa thứ ba trong ba cửa GenMAGIC. Khác hai cửa kia ở chỗ nguồn không phải LAMP:
platform **khoá CARP** vào một quỹ Paid, người dùng **rút hạn-mức thành quyền-tiêu MAGIC**
gắn DID, một chiều và không hoàn. Đồng thời là **sàn-tiện-ích của CARP**.

| | InstantGen | ScheduleGen | **PrepaidGen** |
|---|---|---|---|
| Nguồn | nắm LAMP | khoá LAMP | **khoá CARP** |
| Cổng thặng dư `br` | có | có (κ) | **không cần — tự back** |
| Chạm backing chung | có | có | **không** |
| Kích hoạt | theo yêu cầu | mỗi epoch, tự động | **theo yêu cầu, rút dần hạn-mức** |
| Vòng đời MAGIC | 1 epoch | 1 epoch | 1 epoch |

Lý do thiết kế, bất biến `C-PP-1..15`, bảng quyền, và danh sách `[CẦN XÁC NHẬN]`:
**`DESIGN.md`**. File này chỉ nói cách chạy.

## Điểm cần nắm trước khi sửa code

- **Hạn-mức ≠ MAGIC.** CARP khoá vào quỹ trở thành `PrepaidCredit.remaining` (carpdrop) ở
  vault người dùng — không hết hạn. Chỉ khi `PrepaidDraw` nó mới thành `MagicBatch`, và
  batch đó sống **đúng một epoch** (`decay_window = 1`, §4.2). Gộp hai bước làm một là làm
  người trả trước mất tiền sau một epoch.
- **Par 1:1 là phép nhân, không phải Q-format.** `nanogic = carpdrop × 1000`. Không phí,
  không làm tròn ở chiều CARP→MAGIC.
- **MAGIC hết hạn trả lại HẠN-MỨC, không trả lại CARP.** `PrunePrepaid` cộng
  `⌊current_amount / 1000⌋` về dòng hạn-mức tương ứng. Không đồng CARP nào rời quỹ (F2).
- **Chỉ MAGIC tiêu THẬT mới vào `magic_settled`.** Quyết toán bỏ qua mọi batch đã chết —
  đây là `INV-MAGIC-CITIZEN`, và là thứ quyết định provider được đòi bao nhiêu.
- **`BurnBatch` phải ở constructor index 2.** ConsumeMAGIC ghim `burn_batch_constr = 2` cho
  vault này (§7.3). Chèn nhánh redeemer vào giữa là hỏng giải mã bên kia.

## Bố cục

```
PrepaidGen/
├── DESIGN.md                 # thiết kế + bất biến + [CẦN XÁC NHẬN]
├── onchain/
│   ├── lib/magiclamp/protocol/{constants,types,math,vectors}.ak
│   └── validators/{prepaid,fund_nft}.ak    # prepaid_vault + paid_fund + policy NFT quỹ
├── offchain/src/{constants,types,math,prepaid,index}.ts
└── tests/{vectors,math…}.ts  # p8 · prepaid · codec
```

`vectors.ak` giữ **bảng vector chung** cho cả hai bên — xem mục P8 bên dưới.

## Chạy

```bash
# on-chain
cd onchain && aiken check && aiken build

# off-chain
cd offchain && npm install && npm test && npm run typecheck
```

Trên máy này `aiken check` in chẩn đoán qua terminal thật; khi chạy trong đường ống mà mất
màu thì phần lỗi có thể rỗng. Bọc bằng `script -q /tmp/out.txt aiken check` rồi đọc file để
thấy đầy đủ.

## Cổng P8 — bit-identical Aiken ↔ TypeScript

Bảng vector chỉ tồn tại **một bản**, ở `onchain/lib/magiclamp/protocol/vectors.ak`:

- test Aiken trong chính file đó chạy hàm on-chain trên bảng;
- `tests/p8.test.ts` **đọc file `.ak`**, trích các cột literal, chạy hàm TypeScript trên
  đúng cột đó, và đối chiếu thêm từng hằng số giữa `constants.ak` ↔ `constants.ts`;
- `tests/codec.test.ts` đọc `types.ak` để so thứ tự trường datum và constructor index
  redeemer với bảng thứ tự khai báo trong `types.ts`.

Nghĩa là sửa lệch một bên thì một trong hai bộ test đỏ ngay, không đợi tới lúc giao dịch
thật hỏng trên chuỗi.

## Trạng thái

`aiken check` 72 kiểm tra xanh · `aiken build` sinh `plutus.json` với ba validator ·
vitest 75 kiểm tra xanh · `tsc --noEmit` sạch cả `src` lẫn `tests`.

Chưa làm: dựng giao dịch bằng Lucid (`prepaid.ts` mới là máy trạng thái thuần), script
deploy Preview, và luồng end-to-end ghép với ConsumeMAGIC.
