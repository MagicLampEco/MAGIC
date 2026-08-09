# ConsumeMAGIC — MATH v2 (engagement-state, rewrite D1)

> Model v2: MAGIC = số kế toán (vault datum), KHÔNG `tx.mint`. Tiêu MAGIC = `Σburns`
> qua handler `BurnBatch` của vault; consume.ak ÉP `total_burned == total_required`
> (`==`, KHÔNG `≥`). Phần PRICING (§2.1, 2.4, 2.5, §5) bất biến giữa 2 model.

## 1. Định nghĩa hình thức

| Ký hiệu | Định nghĩa | Đơn vị |
|---|---|---|
| Q | `1_000_000_000` — scale factor | (không thứ nguyên) |
| nanogic | Đơn vị nhỏ nhất của MAGIC: 1 MAGIC = 10^9 nanogic | nanogic |
| `base_price[t]` | Giá danh nghĩa của op_type `t`, governance param | nanogic |
| `demand_mult` | Hệ số co giãn cung-cầu hiện hành, Q-format ∈ `[m_min, m_max]` | Q-format |
| `m_min`, `m_max` | Chặn clamp của `demand_mult`, Q-format | Q-format |
| `load_raw(e)` | Tải thực `ops_served(e) / target_capacity`, Q-format | Q-format |
| N | Cửa sổ FIR (mặc định 6, khớp `DEMAND_WINDOW` trong `pricing/src/price.ts`) | epoch |
| `required(t, n)` | Tổng nanogic cần giảm (burns) cho `n` ops loại `t` | nanogic |
| `total_burned` | `Σ burns` qua các vault_ref phân biệt (handler `BurnBatch` của vault giảm `current_amount`) — KHÔNG `tx.mint` | nanogic |

Nguồn: `pricing/src/price.ts`, `onchain/lib/magiclamp/consume/pricing.ak`.

---

## 2. Công thức chính

### 2.1 Giá đơn vị

```
price(t) = ⌊ base_price[t] × demand_mult / Q ⌋    (nanogic)
```

- Floor division (BigInt — KHÔNG float).
- `price` đơn điệu không-giảm theo `demand_mult` vì `base_price[t] ≥ 0` và floor không giảm khi nhân tử tăng.
- Chặn: `⌊ base_price[t] × m_min / Q ⌋ ≤ price(t) ≤ ⌊ base_price[t] × m_max / Q ⌋`.

Nguồn: `pricing.ak:price_of`, `price.ts:pricePerOp`.

### 2.2 Required (tổng cho 1 vault input)

```
required(t, n) = price(t) × n
```

### 2.3 Aggregate required + burned (toàn tx)

```
total_required = Σ_{i ∈ engage_inputs}        required(op_type_i, op_count_i)
total_burned   = Σ_{v ∈ distinct vault_refs}  Σ burns(v)
```

Bất biến C-CM-2: `total_burned == total_required` (`==`, KHÔNG `≥`: over-burn =
giảm MAGIC user vô cớ → CẤM). AGGREGATE qua MỌI Engage input + MỌI vault_ref PHÂN
BIỆT (mỗi vault đếm burns 1 lần) → chống pay-once-consume-N (N engage chung 1 vault
burn: `total_required = N× != total_burned = 1×` → REJECT).

Nguồn: `consume.ak:sum_required_over_engage_inputs`,
`consume.ak:distinct_vault_refs_over_engage_inputs`, `consume.ak:sum_burns_over_vault_refs`.

### 2.4 Demand multiplier — FIR (SMA-N + clamp)

```
load_raw(e) = ⌊ ops_served(e) × Q / target_capacity ⌋

SMA_N({load_raw(e−N+1), ..., load_raw(e)}) = ⌊ Σ_{k=e−N+1}^{e} load_raw(k) / N ⌋

demand_mult = clamp( SMA_N , m_min , m_max )
```

**Lý do FIR thay vì PI (theo CONTRACT §A 4 trục):**
1. Không cần biến trạng thái tích phân trên datum — ít byte eUTXO.
2. Ổn định BIBO vô điều kiện: SMA là tổ hợp lồi của các input có giới hạn → output có giới hạn.
3. Không có khâu tích phân → không windup.
4. Nhất quán với UMKeeper đã chạy đúng — tái dùng `ProtocolUtils.clamp + computeSMA`.

Nguồn: `price.ts:demandMult`, `price.ts:smaLoad`, `price.ts:computeLoadRaw`.

### 2.5 Bất biến datum PriceParam

```
m_min == 500_000_000  ∧  m_max == 2_000_000_000        (PIN về hằng compile-time)
0 ≤ m_min ≤ m_max
m_min ≤ demand_mult ≤ m_max
epoch ≥ 0
len(op_prices) ≤ 16                                     (max_op_prices)
op_type TĂNG NGẶT theo chỉ số dòng                      (dạng chuẩn tắc)
∀ OpPrice p: p.base_price × m_min ≥ Q                   (GATE giá-tối-thiểu)
```

- **PIN `m_min`/`m_max`**: check tương-đối `m_min ≤ demand ≤ m_max` KHÔNG chặn được
  band-escape, vì `demand` bám theo `m_max`: đặt `m_max` khổng lồ thì giá nổ ~1e6× mà
  vẫn "trong band". Phải neo về hằng compile-time.
- **Trần 16 dòng**: `valid_param` chạy MỘT LẦN / Engage input ⇒ bảng vài nghìn dòng làm
  MỌI tx consume vượt ex-unit = DoS toàn cơ chế, không hạ được vì beacon chỉ committee
  sửa. Số 16 chọn theo số đo `aiken check` (ràng buộc BINDING là MEM: n=16 → 940 K mem
  / invocation; n=32 → 3,05 M ⇒ loại).
- **TĂNG NGẶT theo `op_type`**: trùng `op_type` thì on-chain `list.find` lấy dòng ĐẦU
  còn off-chain viết bằng map lấy dòng CUỐI ⇒ hai phía lệch giá (10×) mà KHÔNG bên nào
  báo lỗi. Tăng ngặt bao hàm "không trùng" VÀ loại luôn bảng cùng-tập-khác-thứ-tự
  (một biểu giá chỉ có ĐÚNG MỘT cách viết hợp lệ). Hệ quả bắt buộc cho off-chain: **sắp
  xếp bảng trước khi post** (`toCanonicalOpPrices`).
- **GATE `base_price × m_min ≥ Q`**: bảo đảm giá 1 đơn vị ở demand THẤP NHẤT vẫn ≥ 1
  nanogic ⇒ đóng collapse-to-0 (`base` quá nhỏ ⇒ giá làm tròn về 0 ⇒ drain miễn phí).
  GATE này **bao hàm** `base_price ≥ 0` và cấm luôn `base_price == 0` (nhánh chết:
  `consume` ép `required > 0` nên dòng giá 0 không bao giờ dùng được). Nó cũng là chỗ
  chặn sớm toán hạng âm — điều kiện tiên quyết của P8, xem §5.1.

**Bản gương off-chain: `price.ts:assertValidPriceParam`** — chạy TRƯỚC khi post beacon,
ném `PRICE-010..015`. Không có nó, bên tiêu thụ không có cách nào tự biết bảng của mình
hợp lệ; sai chỉ lộ ra khi mọi tx consume đã chết hàng loạt.

Nguồn: `pricing.ak:valid_param`, `pricing.ak:sorted_strict_op_types`,
`pricing.ak:max_op_prices`, `price.ts:assertValidPriceParam`.

### 2.6 Value preservation @engage (TUYỆT ĐỐI)

```
Σ value(out@engage) == Σ value(in@engage)
```

Engage UTxO chỉ giữ ADA + thread NFT (KHÔNG MAGIC/LAMP) → bảo toàn TUYỆT ĐỐI:
`diff = Σin@engage − Σout@engage`; `assets.is_zero(diff)`. MAGIC giảm KHÔNG xảy ra ở
Engage UTxO mà ở VAULT UTxO (handler BurnBatch, validator khác). Không `tx.mint`.

Nguồn: `consume.ak:engage_value_preserved`.

---

## 3. Điều kiện biên

| Điều kiện | Xử lý |
|---|---|
| `target_capacity = 0` | `computeLoadRaw` dùng `den = 1` (defensive, `price.ts:29`) |
| Lịch sử load rỗng | `smaLoad` trả `M_NEUTRAL_Q = Q` (neutral 1.0×) |
| `op_type` không có trong bảng | `lookup_base` trả `None` → `required_for` trả `None` → validator fail |
| `op_count ≤ 0` | On-chain: `expect op_count >= 1`. Off-chain: **ném** `PRICE-002` / `CONSUME-008` (trước 2026-08-09 trả `0` im lặng = fail-open: app hiện "0 MAGIC", cấp dịch vụ, rồi tx mới bị từ chối) |
| `demand_mult = m_min` (load thấp) | `price(t) = ⌊ base_price[t] × m_min / Q ⌋` (sàn giá) |
| `demand_mult = m_max` (load cao) | `price(t) = ⌊ base_price[t] × m_max / Q ⌋` (trần giá) |
| Floor division làm tròn xuống | `required` có thể thấp hơn giá thực chính xác ≤ 1 nanogic; user-favorable |

---

## 4. Test vectors (verifiable, số thật)

### TV-CM-PRICE-01: Giá đơn vị tại demand 1.0×

```
base_price[1]   = 10_000_000   (ảnh, 0.01 MAGIC)
demand_mult     = 1_000_000_000  (Q = 1.0×)
price(1)        = ⌊ 10_000_000 × 1_000_000_000 / 1_000_000_000 ⌋ = 10_000_000
required(1, 1)  = 10_000_000

base_price[2]   = 1_000_000   (CID, 0.001 MAGIC)
price(2)        = ⌊ 1_000_000 × 1_000_000_000 / 1_000_000_000 ⌋ = 1_000_000
required(2, 1)  = 1_000_000
```

Nguồn: `pricing.ak:price_unit_demand`, `pricing.ak:required_multiplies_count`.

### TV-CM-PRICE-02: Giá tại demand 2.0× (trần)

```
base_price[1]   = 10_000_000
demand_mult     = 2_000_000_000  (2.0×)
price(1)        = ⌊ 10_000_000 × 2_000_000_000 / 1_000_000_000 ⌋ = 20_000_000
```

Nguồn: `pricing.ak:price_high_demand`, `consume.ak` test `consume_happy` (demand=Q → price=10M).

### TV-CM-PRICE-03: Giá tại demand 0.5× (sàn)

```
base_price[1]   = 10_000_000
demand_mult     = 500_000_000  (0.5×)
price(1)        = ⌊ 10_000_000 × 500_000_000 / 1_000_000_000 ⌋ = 5_000_000
```

Nguồn: `pricing.ak:price_low_demand`.

### TV-CM-PRICE-04: required 5 ops loại ảnh tại demand 1.0×

```
base_price[1]   = 10_000_000
demand_mult     = 1_000_000_000
price(1)        = 10_000_000
required(1, 5)  = 10_000_000 × 5 = 50_000_000
```

Nguồn: `pricing.ak:required_multiplies_count`.

### TV-CM-PRICE-05: Aggregate 2 Engage input (`==`, over-burn CẤM)

```
engage_input_0: op_type=1, op_count=1 → required_0 = 10_000_000
engage_input_1: op_type=1, op_count=1 → required_1 = 10_000_000
total_required = 20_000_000

total_burned = 10_000_000  → REJECT (< 20_000_000, under-charge)
total_burned = 20_000_000  → ACCEPT (== total_required)
total_burned = 25_000_000  → REJECT (over-burn — accounting cấm giảm MAGIC vô cớ)
```

Nguồn: `consume.ak:consume_two_engage_share_vault_undercharge_fail` (10M REJECT),
`consume.ak:consume_two_engage_full_burn_happy` (20M ACCEPT),
`consume.ak:consume_overburn_fail` (25M-tương-tự REJECT qua `==`).

### TV-CM-STALE: Stale price

```
pp.epoch      = 1
cur_epoch     = 10
max_stale     = 5
10 − 1 = 9 > 5  →  REJECT
```

Nguồn: `consume.ak:consume_stale_price_fail`.

### TV-CM-DEMAND-FIR: Hội tụ SMA-6 về load ổn định

```
load ổn định = 1.5 × Q = 1_500_000_000 trong 6 epoch liên tiếp
SMA_6 = 1_500_000_000 / 1 = 1_500_000_000
demand_mult = clamp(1_500_000_000, 500_000_000, 2_000_000_000) = 1_500_000_000

Hội tụ sau tối đa N=6 epoch. Minh chứng BIBO:
  |demand_mult| ≤ m_max = 2_000_000_000 cho mọi input.
```

Nguồn: `price.ts:demandMult`, `M_MIN_Q`, `M_MAX_Q`, `DEMAND_WINDOW`.

---

## 5. Tính đúng đắn P8 (bit-identical Aiken ↔ TypeScript)

Cùng input `(base_price, demand_mult, Q, op_count)`:
- Aiken: `base_price * demand_mult / q` (BigInt integer division).
- TypeScript: `(base * demandMultQ) / Q` (BigInt integer division, `price.ts:pricePerOp`).

Hai biểu thức giống nhau → P8 thoả. Không có float, không có bước trung gian khác nhau.

Nguồn: `pricing.ak:price_of`, `price.ts:pricePerOp`.

### 5.1 ⚠ ĐIỀU KIỆN của P8: MỌI toán hạng phải `≥ 0`

**P8 KHÔNG phải một đẳng thức vô điều kiện.** Phép chia nguyên của hai ngôn ngữ khác
nhau trên số âm:

| | Aiken `/` | JavaScript BigInt `/` |
|---|---|---|
| Ngữ nghĩa | **floor** (làm tròn xuống, về `−∞`) | **trunc** (cắt về `0`) |
| `−7 / 2` | `−4` | `−3n` |

Phản ví dụ cụ thể trên chính công thức `required`:

```
base_price = −3 , demand_mult = 1_500_000_000 , op_count = 1 , Q = 1e9

tích     = −3 × 1_500_000_000 × 1 = −4_500_000_000
Aiken    ⌊ −4_500_000_000 / 1e9 ⌋ = −5      (floor)
TypeScript  −4_500_000_000n / Q   = −4n     (trunc-về-0)
                                    ↑ LỆCH 1 nanogic
```

**Vì sao đường tiền KHÔNG chạm nó:** on-chain `pricing.valid_param` từ chối
`base_price` không thoả GATE `base_price × m_min ≥ Q`, mà mọi `base_price ≤ 0` đều rớt
GATE ⇒ beacon hợp lệ không bao giờ chứa toán hạng âm. `demand_mult` bị chặn trong
`[m_min, m_max]` (cả hai dương), `op_count ≥ 1` (validator ép, off-chain nay cũng ném
`PRICE-002` / `CONSUME-008` thay vì trả 0 im lặng).

**Vì sao vẫn phải ghi ra đây:** gói `@magiclamp/consumemagic-pricing` được **xuất bản
cho bên ngoài dùng**. Người gọi có thể đưa vào một bảng giá chưa qua beacon (mô phỏng,
tính thử, dựng datum sắp post). Với họ, P8 chỉ là lời hứa có điều kiện:

> **Hợp đồng P8:** `pricePerOp` / `requiredForOp` / `requiredBurn` khớp bit-identical
> với `pricing.ak` **khi và chỉ khi** `base_price ≥ 0`, `demand_mult ≥ 0`, `op_count ≥ 1`.
> Ngoài miền đó, hai bên có thể lệch 1 đơn vị và **không bên nào sai** — chúng chỉ định
> nghĩa phép chia khác nhau.

**Chặn sớm:** gọi `assertValidPriceParam(pp)` (`pricing/src/price.ts`) **trước khi post
beacon**. Nó là bản gương off-chain của `pricing.ak:valid_param` và ném `PRICE-015` cho
mọi `base_price` rớt GATE — bao gồm toàn bộ miền âm. Không có phương án "trả giá trị
mặc định": bảng giá không hợp lệ thì không có giá đúng nào để trả.

Nguồn: `pricing.ak:valid_param`, `price.ts:assertValidPriceParam`,
test `PRICE-015: base_price ÂM → ném` (`pricing/tests/price.test.ts`).
