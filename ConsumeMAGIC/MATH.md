# ConsumeMAGIC — MATH v1 (feat/consume-magic-v1)

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
| `required(t, n)` | Tổng nanogic cần đốt cho `n` ops loại `t` | nanogic |
| `magic_burned` | `−mint(MAGIC)` trong tx (qty dương) | nanogic |

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

### 2.3 Aggregate required (toàn tx)

```
total_required = Σ_{i ∈ vault_inputs} required(op_type_i, op_count_i)
```

Bất biến C-CM-2: `magic_burned ≥ total_required`.

Nguồn: `consume.ak:sum_required_over_vault_inputs`.

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
0 ≤ m_min ≤ m_max
m_min ≤ demand_mult ≤ m_max
∀ OpPrice p: p.base_price ≥ 0
```

Lý do ép `base_price ≥ 0`: nếu `base_price < 0` thì `required < 0`, điều kiện `magic_burned ≥ required` thoả ngay cả khi `magic_burned = 0` → drain miễn phí. Đây là finding medium được vá tại `valid_param`.

Nguồn: `pricing.ak:valid_param`, `pricing.ak` test `valid_param_negative_base_price_fail`.

### 2.6 Value preservation (không-MAGIC)

```
Σ value(out@script) = Σ value(in@script) − MAGIC_burned_component
```

Chính xác hơn: diff = `Σ in − Σ out`; sau khi zero-hóa thành phần MAGIC: `diff_no_magic = 0` (qua `assets.is_zero`). ADA + LAMP + mọi token khác bảo toàn tuyệt đối.

Nguồn: `consume.ak:non_magic_value_preserved`.

---

## 3. Điều kiện biên

| Điều kiện | Xử lý |
|---|---|
| `target_capacity = 0` | `computeLoadRaw` dùng `den = 1` (defensive, `price.ts:29`) |
| Lịch sử load rỗng | `smaLoad` trả `M_NEUTRAL_Q = Q` (neutral 1.0×) |
| `op_type` không có trong bảng | `lookup_base` trả `None` → `required_for` trả `None` → validator fail |
| `op_count = 0` | Validator ép `op_count >= 1` trước khi tính required |
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

### TV-CM-PRICE-05: Aggregate 2 vault input (double-satisfaction check)

```
vault_input_0: op_type=1, op_count=1 → required_0 = 10_000_000
vault_input_1: op_type=1, op_count=1 → required_1 = 10_000_000
total_required = 20_000_000

magic_burned = 10_000_000  → REJECT (< 20_000_000)
magic_burned = 20_000_000  → ACCEPT
magic_burned = 25_000_000  → ACCEPT (over-burn cho phép)
```

Nguồn: `consume.ak:consume_double_satisfaction_fail`, `consume.ak:consume_two_inputs_happy`.

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
