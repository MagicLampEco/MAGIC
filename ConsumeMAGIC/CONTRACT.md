# ConsumeMAGIC — CONTRACT v1 "Đốt thật + định giá tiêu thụ" (orchestrator ghim 2026-06-07)

**Trạng thái:** interface contract KHÓA, mọi spec/code bám file này. Lý do tồn tại: audit 2026-06-07
phát hiện ConsumeMAGIC hiện **chỉ là math offchain** (31 test) — chưa validator onchain, chưa tx-builder,
chưa interface định giá. App tiêu MAGIC chưa "đốt thật". File này ghim 2 mảnh còn trống:
(A) **định giá tiêu thụ per nghiệp vụ**; (B) **đốt MAGIC thật on-chain an toàn**.

> Nguyên tắc nền (CLAUDE.md): LAMP fixed-supply **KHÔNG BAO GIỜ burn**. MAGIC thì **đốt được** (MAGIC
> sinh từ đốt LAMP qua generator — khác bản chất LAMP). ConsumeMAGIC chỉ chạm policy MAGIC, TUYỆT ĐỐI
> không chạm LAMP/ADA value.

## A. Định giá tiêu thụ (consume-side pricing) — interface `price_per_op`

Gap audit: hiện `computeFee` chỉ là phí % trên `serviceAmount` do **client tự đưa** → không chống spam
(client đặt amount tùy ý). Ghim mô hình có thẩm quyền:

```
price(op_type, t) = base_price[op_type] × demand_mult(t) / Q          (Q = 1e9, scale BigInt)
```

- **`base_price[op_type]`**: bảng giá danh nghĩa per loại nghiệp vụ, **governance param** (DAO chỉnh).
  Ví dụ MVP: `xử lý 1 ảnh = 0.01 MAGIC`, `neo 1 CID = 0.001 MAGIC`. Đơn vị nanogic (1 MAGIC = 1e9).
- **op_type chuẩn (CHỐT, khớp offchain `OP_IMAGE`/`OP_CID` trong `pricing/src/price.ts`):**
  `1 = ảnh` (0.01 MAGIC = 10_000_000 nanogic), `2 = CID` (0.001 MAGIC = 1_000_000 nanogic).
  Mọi fixture/beacon/redeemer onchain PHẢI dùng đúng key này; không được lệch sang `0/1`.
- **`demand_mult(t)`**: hệ số co giãn cung-cầu, **TÁI DÙNG cấu trúc UMKeeper** (lọc FIR: SMA-N của
  `load_raw` rồi `clamp[m_min, m_max]`), **KHÔNG dùng PI**. Lý do (4 trục):
  (1) tối ưu eUTXO — FIR không cần biến trạng thái tích phân trên datum, ít byte;
  (2) ổn định BIBO vô điều kiện, không tinh chỉnh Kp/Ki — audit xác nhận UMKeeper hội tụ;
  (3) **anti-windup miễn phí** (không có khâu tích phân → không windup — đúng kết luận audit);
  (4) nhất quán toàn protocol (đã có tiền lệ UMKeeper chạy đúng, tái dùng `ProtocolUtils.clamp` + SMA).
  `load_raw = ops_served_epoch / target_capacity` (governance param). Mặc định `m_min=0.5, m_max=2.0`.
- **Bất biến:** `price` đơn điệu không-giảm theo `load`; bị chặn `[base×m_min, base×m_max]`; pure BigInt,
  không float; hội tụ về `base×SMA` trong ≤ N epoch khi load ổn định.

## B. Đốt MAGIC thật on-chain — validator + bất biến

### B1. Beacon `PriceParam` (reference input — CIP-31, KHÔNG tiêu)
DAO/keeper post 1 UTxO mang `PriceParam` NFT one-shot (mẫu `beacon_nft.ak`). Datum:
```
PriceParam {
  op_prices    : List<OpPrice>,   // OpPrice{ op_type: Int, base_price: Int }  — bảng giá danh nghĩa
  demand_mult  : Int,             // hệ số co giãn hiện hành (keeper cập nhật, scale Q)
  m_min, m_max : Int,             // chặn clamp (scale Q)
  epoch        : Int,             // epoch cập nhật gần nhất (chống stale)
}
```
Validator consume ĐỌC giá từ đây — **KHÔNG tin amount client mớm**. Giá có thẩm quyền = chống spam thật.

### B2. Redeemer + bất biến validator `consume` (Aiken Plutus V3)
Redeemer `Consume { op_type: Int, op_count: Int, price_ref: OutputReference }`. Validator ÉP:

- **C-CM-1 (policy đúng):** `tx.mint` chỉ chứa entry policy MAGIC, **giá trị ÂM** (đốt) đúng lượng.
  ADA + LAMP + mọi asset khác trong value: **bảo toàn tuyệt đối** (chống drain — bài học M1 Treasury).
- **C-CM-2 (đốt ≥ giá quote):** đọc `PriceParam` qua `price_ref` reference input (xác thực bằng NFT
  policy), tính `required = Σ price(op_type)×op_count`, ép `magic_burned ≥ required`. Giá lấy từ beacon,
  KHÔNG từ redeemer.
- **C-CM-3 (double-satisfaction):** đếm theo **payment script hash**; nếu N input vault / N redeemer
  trong 1 tx → GỘP tổng `magic_burned` so với tổng `required` (1 lần mint âm không "thỏa" cho nhiều
  input). Bài học C1/C2 Distribution.
- **C-CM-4 (replay / freshness):** state engagement (OAC window, attribution chain — đã có ở math.ts)
  neo vào **continuing output** của vault UTxO duy nhất (thread/beacon token), không replay được.
- **C-CM-5 (stale price):** ép `current_epoch − PriceParam.epoch ≤ MAX_PRICE_STALE` (param) — chống
  dùng giá cũ khi demand đã tăng.

### B3. Tx-builder offchain + e2e Preview
- `consumeBuilder(op_type, op_count)`: đọc PriceParam, dựng tx mint-âm MAGIC đúng `required`, neo state.
- Script deploy + e2e Preview (mẫu Distribution 01–04): mint MAGIC test → consume thật → verify burned.

## C. Mối nối với module khác (ranh giới)
- **Pricing (A)** = thư viện tính giá, đặt `ConsumeMAGIC/pricing/` (offchain) + phơi `base_price` qua
  PriceParam beacon. Tái dùng `ProtocolUtils` (clamp, SMA, isqrt). KHÔNG đụng AppEconomics (reward-side)
  hay UMKeeper (mint-side) — chỉ MƯỢN cấu trúc FIR.
- **ConsumeMAGIC (B)** đọc giá từ PriceParam, đốt MAGIC. KHÔNG định giá đối tượng (con bò vs gà) — đó
  là việc **app component** (OriLife `animal_fee`), ngoài phạm vi. MAGIC chỉ định giá **nghiệp vụ hạ
  tầng** (ảnh, CID) + đốt.
- Generators sinh MAGIC; ConsumeMAGIC đốt MAGIC. Cùng policy MAGIC (đọc từ config protocol).

## D. Phải build (bám CONTRACT, có Agent audit phản biện mỗi vòng)
- **SPEC**: FEAT (luồng consume: app gọi → đọc giá → đốt → verify; bảng op_type) + MATH (chứng minh
  price đơn điệu/bounded/hội tụ FIR; required = Σ; an toàn BigInt).
- **PRICING (offchain)**: `pricing/price.ts` (`price_per_op`, `demand_mult` FIR) + vitest (đơn điệu,
  clamp biên, hội tụ, test vector ảnh 0.01 / CID 0.001).
- **ONCHAIN**: `onchain/` Aiken — `types.ak` (PriceParam, OpPrice, Consume), validator `consume.ak`
  (C-CM-1..5), `price_param.ak` beacon one-shot; aiken test (burn đúng policy, đốt≥quote, double-sat
  reject, drain ADA/LAMP reject, stale price reject, replay reject).
- **OFFCHAIN**: `consumeBuilder` + datum codec PriceParam + script deploy/e2e Preview.

## E. Bất biến tuyệt đối (mọi spec/code)
- Chỉ chạm policy MAGIC; LAMP + ADA bảo toàn byte-perfect. LAMP KHÔNG burn.
- Giá lấy từ PriceParam beacon (có thẩm quyền), KHÔNG từ client.
- `magic_burned ≥ required`; value preservation `Σ out = Σ in − burned` riêng asset MAGIC.
- Pure BigInt, không float. demand_mult FIR (không PI, không windup).
