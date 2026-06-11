# UMKeeper — Mathematics Specification
## GenMAGIC v3.3 · §14.1 Network Demand Multiplier

---

## 1. Định nghĩa hình thức

| Ký hiệu | Kiểu | Định nghĩa |
|---|---|---|
| `Q` | const | `10^9` — đơn vị Q-format (fixed-point scale) |
| `UM_MIN_Q` | const | `500_000_000` = 0.5 × Q (giới hạn Constitutional tối thiểu) |
| `UM_MAX_Q` | const | `2_000_000_000` = 2.0 × Q (giới hạn Constitutional tối đa) |
| `W` | const | `6` — kích thước cửa sổ SMA (UM_WINDOW) |
| `e` | biến | epoch hiện tại (số nguyên, tính từ genesis Cardano) |
| `B_e` | biến | tổng nanogic burned trong epoch `e` (SnapshotGen accumulation) |
| `M_e` | biến | tổng nanogic minted trong epoch `e` |
| `history` | `List<Int>` | danh sách ≤ W raw UM values gần nhất (được bảo toàn trong datum) |
| `smoothed_q` | `Int` | giá trị UM đã làm mịn, trong Q-format, thuộc `[UM_MIN_Q, UM_MAX_Q]` |
| `last_updated_epoch` | `Int` | epoch của lần update cuối |

---

## 2. Công thức và derivation

### 2.1 Raw UM (§14.1)

```
um_raw(B_e, M_e) = ⌊ B_e × Q / max(M_e, 1) ⌋
```

**Ý nghĩa:** tỷ lệ burn/mint trong epoch, scale về Q-format.
- `B_e = M_e` → `um_raw = Q = 1.0×` (trung lập)
- `B_e > M_e` → `um_raw > Q` (nhu cầu cao, burn nhiều hơn mint)
- `B_e < M_e` → `um_raw < Q` (nhu cầu thấp, mint nhiều hơn burn)
- `M_e = 0` → denominator = 1 (tránh chia cho 0 — xảy ra epoch đầu khi chưa có mint)

**Clamp raw trước khi append vào history:**
```
clamped_raw = clamp(um_raw, UM_MIN_Q, UM_MAX_Q)
```

Note: TypeScript `appendHistory()` lưu `new_raw` chưa clamp (spec stores raw), nhưng Aiken `append_capped()` nhận `clamped_raw`. Sự khác biệt này không ảnh hưởng đến `smoothed_q` vì SMA sau đó vẫn bị clamp. Tuy nhiên đây là điểm cần đồng bộ (xem TECH.md §4).

### 2.2 History sliding window (§14.1, C-UM-2)

```
append_capped(history, new_val, W):
  appended = history ++ [new_val]
  if len(appended) <= W: return appended
  else: return drop(appended, len(appended) - W)   // giữ W entries cuối
```

**Invariant:** `len(history) ≤ W = 6` tại mọi thời điểm sau update.

### 2.3 SMA — Simple Moving Average (§14.1, C-UM-1)

```
SMA(history) = ⌊ sum(history) / len(history) ⌋
             = Q   nếu history = []   (neutral fallback, chỉ xảy ra epoch đầu)
```

**Lý do dùng SMA thay vì raw:** raw UM có thể biến động mạnh nếu 1 epoch có sự kiện bất thường (spike burn hoặc spike mint). SMA 6 epoch làm mịn → tránh manipulation bằng cách pump/dump một epoch.

### 2.4 Smoothed UM (§14.1, C-UM-3)

```
smoothed_q = clamp(SMA(new_history), UM_MIN_Q, UM_MAX_Q)
```

Double clamp: lần 1 khi append (`clamped_raw`), lần 2 tại smoothed output. Đảm bảo Constitutional bounds ngay cả khi SMA vượt do sequence toán học.

### 2.5 Epoch xác định từ tx validity range (§14.3)

```
current_epoch = ⌊ lower_bound_posix_ms / ms_per_epoch ⌋
```

- Preview testnet: `ms_per_epoch = 86_400_000` (1 ngày = 24 × 3600 × 1000 ms)
- Mainnet: `ms_per_epoch = 432_000_000` (5 ngày)
- Keeper phải set `validFrom = currentEpoch × msPerEpoch` trong tx

### 2.6 Staleness check tại InstantGen (C-UM-6)

```
staleness = currentEpoch - um_datum.last_updated_epoch
um_for_instant = if staleness ≤ 1 then smoothed_q else UM_FALLBACK_Q
```

`UM_FALLBACK_Q = 500_000_000 = UM_MIN_Q` — user nhận rate tệ nhất nếu UM stale.

---

## 3. Điều kiện biên (Boundary conditions)

| Trường hợp | Xử lý |
|---|---|
| `M_e = 0` (chưa có mint) | denominator = 1 → `um_raw = B_e × Q` → rất lớn → clamp về `UM_MAX_Q = 2.0×` |
| `B_e = 0` (chưa có burn) | `um_raw = 0` → clamp về `UM_MIN_Q = 0.5×` |
| `history = []` (epoch đầu) | `SMA([]) = Q = 1.0×` → smoothed bắt đầu từ neutral |
| `len(history) = 6` đầy đủ | SMA dùng đủ 6 điểm, drop oldest khi append |
| Epoch bị bỏ (keeper offline) | History chỉ append 1 điểm raw cho epoch quay lại, không điền giả. SMA ít điểm hơn → ít smooth hơn (đây là punishment tự nhiên) |
| `new_raw` ngoài `[UM_MIN_Q, UM_MAX_Q]` | clamp trước khi append → history chỉ chứa giá trị trong bounds |

---

## 4. Test vectors số thật (verifiable)

### TV-UM-01: Neutral epoch, history khởi đầu

```
Input:
  history     = [Q]   = [1_000_000_000]
  B_e         = 1_000_000_000  (nanogic)
  M_e         = 1_000_000_000  (nanogic)

Tính:
  um_raw      = ⌊ 1_000_000_000 × Q / 1_000_000_000 ⌋ = Q = 1_000_000_000
  clamped_raw = clamp(Q, UM_MIN_Q, UM_MAX_Q) = Q
  new_history = [Q, Q]  (append, len=2 ≤ 6)
  SMA         = ⌊ (Q + Q) / 2 ⌋ = Q = 1_000_000_000
  smoothed_q  = clamp(Q, UM_MIN_Q, UM_MAX_Q) = Q = 1_000_000_000

Expected:
  smoothed_q         = 1_000_000_000
  history            = [1_000_000_000, 1_000_000_000]
  last_updated_epoch = currentEpoch
```

**Nguồn code:** `um_datum.ak:285-301` (test `um_happy_path`, raw=1.2×), `tests/um.test.ts:14-16`

---

### TV-UM-02: Chuỗi 6 epoch demand cao → smoothed tiến gần 2.0×

```
Input:
  history (bắt đầu) = []
  Mỗi epoch: B_e = 2_000_000_000, M_e = 1_000_000_000

Sau epoch 1:
  um_raw = ⌊ 2e9 × Q / 1e9 ⌋ = 2_000_000_000 → clamp = 2_000_000_000
  new_history = [2_000_000_000]
  SMA = 2_000_000_000 / 1 = 2_000_000_000
  smoothed_q = clamp(2e9, 0.5Q, 2Q) = 2_000_000_000

Sau epoch 6 (history đầy đủ):
  history = [2e9, 2e9, 2e9, 2e9, 2e9, 2e9]
  SMA     = 2_000_000_000
  smoothed_q = 2_000_000_000  (= UM_MAX_Q)

Sau epoch 7 (neutral: B=M=1e9):
  um_raw      = Q = 1_000_000_000 → clamp = Q
  new_history = drop [2e9], append [Q] = [2e9, 2e9, 2e9, 2e9, 2e9, Q]
  SMA         = ⌊ (5 × 2_000_000_000 + 1_000_000_000) / 6 ⌋
              = ⌊ 11_000_000_000 / 6 ⌋ = 1_833_333_333
  smoothed_q  = 1_833_333_333  (< UM_MAX_Q, bắt đầu giảm)

Expected epoch 7: smoothed_q = 1_833_333_333
```

**Nguồn code:** `tests/um.test.ts:57-65` (TV-UM-SPLIT), `tests/um.test.ts:100-103`

---

### TV-UM-03: SMA với history mixed 4 điểm

```
Input:
  history = [500_000_000, 1_000_000_000, 1_500_000_000, 2_000_000_000]

Tính:
  sum = 500M + 1B + 1.5B + 2B = 5_000_000_000
  SMA = ⌊ 5_000_000_000 / 4 ⌋ = 1_250_000_000
  clamp(1.25Q, 0.5Q, 2Q) = 1_250_000_000

Expected: smoothed_q = 1_250_000_000 = 1.25×
```

**Nguồn code:** `tests/um.test.ts:76-79`

---

### TV-UM-04: Keeper chọn new_raw cực đại → SMA làm mịn chống manipulation

```
Giả sử attacker kiểm soát 1 keeper (trong 2-of-3) cộng tác:
  history hiện tại = [Q, Q, Q, Q, Q]   (5 điểm = 1.0×)
  Attacker submit new_raw = UM_MAX_Q = 2_000_000_000

  new_history = [Q, Q, Q, Q, Q, 2Q]
  SMA = ⌊ (5Q + 2Q) / 6 ⌋ = ⌊ 7_000_000_000 / 6 ⌋ = 1_166_666_666
  smoothed_q = 1_166_666_666   (chỉ tăng 16.7%, không đạt 2.0×)

Kết luận: SMA chống single-epoch manipulation hiệu quả.
  Để đẩy smoothed_q lên 2.0× cần 6 epoch liên tiếp raw = 2.0×.
```

**Nguồn code:** `um_datum.ak:106-113` (clamp + SMA verify)

---

### TV-UM-05: Staleness 2 epoch → InstantGen fallback

```
um_datum: smoothed_q = 2_000_000_000, last_updated_epoch = 98
currentEpoch (InstantGen tx) = 100

staleness = 100 - 98 = 2 > UM_MAX_STALENESS (=1)
→ um_for_instant = UM_FALLBACK_Q = 500_000_000

L_avail = 1_000_000_000_000  (1_000_000 LAMP in oil)
PM = 1_050_000_000  (Flame profile)

MAGIC_output = ⌊ ⌊ ⌊ L × BASE / Q ⌋ × UM_FALLBACK / Q ⌋ × PM / Q ⌋
             = ⌊ ⌊ ⌊ 1e12 × 3Q / Q ⌋ × 0.5Q / Q ⌋ × 1.05Q / Q ⌋
             = ⌊ ⌊ 3_000_000_000_000 × 0.5 ⌋ × 1.05 ⌋
             = ⌊ 1_500_000_000_000 × 1.05 ⌋
             = 1_575_000_000_000  nanogic  =  1_575  MAGIC

Nếu UM fresh (smoothed = 2.0×):
  = ⌊ ⌊ 3e12 × 2.0 ⌋ × 1.05 ⌋ = 6_300_000_000_000  nanogic  =  6_300  MAGIC

Loss do staleness: 6300 - 1575 = 4725 MAGIC (75% penalty)
```

**Nguồn code:** `InstantGen/offchain/src/math.ts:75-80`, `constants.ts:26-27`
