# SnapshotGen MATH — Đặc tả toán học
## GenMAGIC v3.3 · §8 SnapshotGen

---

## 1. Ký hiệu và định nghĩa

| Ký hiệu | Định nghĩa | Đơn vị |
|---|---|---|
| `Q` | Precision factor = 10⁹ | — |
| `L` | `lamp_balance` (toàn bộ, kể cả locked) | oildrop = LAMP × 10⁶ |
| `R_snap` | Base rate = 5 × 10⁹ / Q = 5.0 | Q-format |
| `LF` | Loyalty Factor ∈ [1.00, 1.50] | Q-format |
| `OAC` | On-chain Activity Coefficient ∈ [0.80, 1.00] | Q-format |
| `PM` | Profile Multiplier | Q-format |
| `B` | Profile Bonus | Q-format |
| `M_snapshot` | MAGIC tạo ra mỗi epoch | nanogic = MAGIC × 10⁹ |
| `k` | Tuổi batch (số epoch kể từ tạo) | epoch |
| `N(P)` | Decay window của profile P | epoch |
| `r(P)` | Decay rate của profile P | — |
| `m₀` | initial_amount của batch khi tạo | nanogic |
| `Δe` | `current_epoch - last_updated_epoch` (catch-up) | epoch |

---

## 2. Profile parameters

Nguồn: `constants.ak`, `constants.ts`.

| Profile | `r` | `N` | `PM_Q` | `B_Q` | ELV |
|---|---|---|---|---|---|
| Ember | 3 | 3 | 1_150_000_000 (1.15) | 1_300_000_000 (1.30) | 2.19 |
| Flame | 2 | 6 | 1_050_000_000 (1.05) | 1_100_000_000 (1.10) | 3.69 |
| Lantern | 1 | 9 | 1_000_000_000 (1.00) | 1_000_000_000 (1.00) | 6.12 |

---

## 3. Loyalty Factor LF (§6.3)

### 3.1 Hàm piecewise linear theo tuổi holding

Định nghĩa tại `lf_oac.ak:26`, mirror tại `math.ts:22`:

```
LF_pwl(age) =
  age ≤ 0          → 1.00
  0  < age ≤ 6     → 1.00 + 0.10 × age/6        ∈ [1.00, 1.10)
  6  < age ≤ 12    → 1.10 + 0.10 × (age-6)/6    ∈ [1.10, 1.20)
  12 < age ≤ 24    → 1.20 + 0.30 × (age-12)/12  ∈ [1.20, 1.50)
  age > 24         → 1.50  (cap)
```

Tất cả phép chia là `floor` (integer division). Ví dụ: `age=6` → `Q + Q/10*6/6 = Q + Q/10 = 1_100_000_000`.

### 3.2 Weighted average LF

`LF_Q = Σ(h.amount × LF_pwl(current_epoch - h.acquired_epoch)) / Σ(h.amount)`

Nguồn: `lf_oac.ak:42-54`, `math.ts:32-39`. Tất cả holdings tham gia, kể cả `is_locked = True` (C-SS-5, L3). Nếu tổng = 0 → `LF_Q = Q` (mặc định 1.00).

### 3.3 Boundary values (TV-LF-BOUNDARIES)

| `age` | `LF_Q` |
|---|---|
| 0 | 1_000_000_000 |
| 6 | 1_100_000_000 |
| 12 | 1_200_000_000 |
| 24 | 1_500_000_000 |
| 25 | 1_500_000_000 |
| 100 | 1_500_000_000 |

---

## 4. OAC — On-chain Activity Coefficient (§6.4)

### 4.1 Công thức

```
OAC_Q = 0.80 + 0.05 × min(active_apps, 4)
      = oac_base_q + oac_increment_q × min(n, oac_cap_apps)
```

`active_apps` = số app_id phân biệt có burn trong cửa sổ `[current_epoch - 12, current_epoch)`.

Nguồn: `lf_oac.ak:96-98`, `math.ts:53-55`.

### 4.2 OAC boundary — window half-open (TV-OAC-BOUNDARY)

Cửa sổ là **half-open `[current-12, current)`** — burn TẠI `current_epoch` KHÔNG được tính cho epoch hiện tại, chỉ tính cho epoch sau. Nguồn: `lf_oac.ak:77-79`.

Ví dụ (TV-OAC-BOUNDARY, `vectors.ts:200-222`):
- `current_epoch = 103`, window = `[91, 103)`
- app3 ep=91 ∈ [91,103) → counted
- app4 ep=100 ∈ [91,103) → counted
- app5 ep=103 → NOT counted (current epoch)
- Kết quả: `active_apps = 2` → `OAC_Q = 800M + 50M×2 = 900_000_000`

### 4.3 Giá trị OAC theo số app active

| active_apps | `OAC_Q` |
|---|---|
| 0 | 800_000_000 (0.80) |
| 1 | 850_000_000 (0.85) |
| 2 | 900_000_000 (0.90) |
| 3 | 950_000_000 (0.95) |
| ≥ 4 | 1_000_000_000 (1.00) |

---

## 5. Công thức M_snapshot (§8.1)

### 5.1 Formal

```
M_snapshot = ⌊ L × R_snap × LF × OAC × PM × B / Q⁵ ⌋
```

Thực hiện như 5 bước `floor(× / Q)` riêng lẻ (C-OVERFLOW, L4):

```
s1 = ⌊ L × R_snap / Q ⌋          -- × R_snap
s2 = ⌊ s1 × LF_Q   / Q ⌋          -- × LF
s3 = ⌊ s2 × OAC_Q  / Q ⌋          -- × OAC
s4 = ⌊ s3 × PM_Q   / Q ⌋          -- × PM
M_snapshot = ⌊ s4 × B_Q / Q ⌋     -- × B
```

Nguồn: `snapshot.ak:63-67`, `math.ts:77-81`.

### 5.2 Error bound

**L4**: Sai số tích lũy ≤ 5 nanogic (1 nanogic mỗi bước floor). `M_actual ≤ M_true`.

### 5.3 BigInt requirement

Tất cả giá trị phải là `BigInt` (TypeScript) / `Int` (Aiken — arbitrary precision). KHÔNG dùng `Number`. Kiểm tra: TV-OVERFLOW-01/02. Nguồn: `CLAUDE.md:§C-OVERFLOW`.

---

## 6. Catch-up (C-SS-6)

Nếu `Δe = current_epoch - last_updated_epoch > 1` (vault không được chạm trong nhiều epoch):

```
M_catchup = Δe × M_snapshot(current_state)
```

Chỉ tạo **một batch duy nhất** tại `current_epoch` với `initial_amount = M_catchup`. Dùng trạng thái LF, OAC, profile của current_epoch (không phải trạng thái cũ). Điều này thường có lợi cho user (LF tăng theo tuổi), trừ khi OAC giảm do user ngưng burn.

Nguồn: `vault.ak:137-139`, `snapshot.ak:81-93`, `math.ts:87-95`.

---

## 7. Batch decay (§4.2, §6.2)

### 7.1 Công thức

```
balance(k) = ⌊ m₀ × (10-r)^k / 10^k ⌋    k ∈ [0, N(P))
balance(k) = 0                              k ≥ N(P)
```

Nguồn: `decay.ak:45-58`, `math.ts:112-124`.

**L1**: Sai số tích lũy ≤ N(P) nanogic qua N bước floor.
**L2**: `balance(k+1) ≤ balance(k)` — monotone giảm.
**T2**: Hard cutoff tại k = N(P).

### 7.2 Test vectors (TV-SS-01..03)

**TV-SS-01 — Lantern (r=1, N=9), m₀=10⁹:**

| k | balance |
|---|---|
| 0 | 1_000_000_000 |
| 1 | 900_000_000 |
| 2 | 810_000_000 |
| 3 | 729_000_000 |
| 4 | 656_100_000 |
| 5 | 590_490_000 |
| 6 | 531_441_000 |
| 7 | 478_296_900 |
| 8 | 430_467_210 |
| 9 | 0 (cutoff) |

**TV-SS-02 — Flame (r=2, N=6), m₀=10⁹:**

| k | balance |
|---|---|
| 0 | 1_000_000_000 |
| 1 | 800_000_000 |
| 2 | 640_000_000 |
| 3 | 512_000_000 |
| 4 | 409_600_000 |
| 5 | 327_680_000 |
| 6 | 0 (cutoff) |

**TV-SS-03 — Ember (r=3, N=3), m₀=10⁹:**

| k | balance |
|---|---|
| 0 | 1_000_000_000 |
| 1 | 700_000_000 |
| 2 | 490_000_000 |
| 3 | 0 (cutoff) |

---

## 8. Scale-back burn (§6.6)

Khi burn `b` nanogic từ batch ở tuổi `k`:

```
initial_scale_burn = ⌊ b × 10^k / (10-r)^k ⌋
new_initial = m₀ - initial_scale_burn
new_balance = ⌊ new_initial × (10-r)^k / 10^k ⌋
```

**T17 (user-favorable):** `new_balance ≥ current - b`. Sai số `diff = current - b - new_balance ∈ {0, -1}`.

Nguồn: `decay.ak:92-113`, `math.ts:157-178`.

**TV-SS-04 — Lantern k=3, m₀=10⁹, burn=200M:**

```
current = ⌊10⁹ × 9³/10³⌋ = ⌊10⁹ × 729/1000⌋ = 729_000_000
isb     = ⌊200M × 10³/9³⌋ = ⌊200M × 1000/729⌋ = 274_348_422
  Verify: 274_348_422 × 729 = 199_999_999_638; remainder=362 < 729 ✓
new_initial = 10⁹ - 274_348_422 = 725_651_578
new_balance = ⌊725_651_578 × 729/1000⌋ = 529_000_000
diff = 729M - 200M - 529M = 0 ✓ (T17)
```

---

## 9. Test vectors số thật

### TV-SNAPGEN-01 (vectors.ts:112-132)

**Input:** 1000 LAMP Flame, LF=1.0, OAC=0.8

```
L = 1_000_000_000 oildrop  (1000 × 10^6)
R_snap_Q = 5_000_000_000
LF_Q = 1_000_000_000
OAC_Q = 800_000_000
PM_Q = 1_050_000_000   (Flame)
B_Q  = 1_100_000_000   (Flame)

s1 = 1_000_000_000 × 5_000_000_000 / 10^9 = 5_000_000_000
s2 = 5_000_000_000 × 1_000_000_000 / 10^9 = 5_000_000_000   (LF=1.0, no-op)
s3 = 5_000_000_000 × 800_000_000  / 10^9 = 4_000_000_000
s4 = 4_000_000_000 × 1_050_000_000 / 10^9 = 4_200_000_000
M  = 4_200_000_000 × 1_100_000_000 / 10^9 = 4_620_000_000 nanogic ≈ 4.62 MAGIC ✓
```

### TV-SNAPGEN-MATURE (vectors.ts:135-148)

**Input:** 1000 LAMP Ember, LF=1.5, OAC=1.0

```
L = 1_000_000_000 oildrop
PM_Q = 1_150_000_000  (Ember)
B_Q  = 1_300_000_000  (Ember)

s1 = 5_000_000_000
s2 = 5_000_000_000 × 1_500_000_000 / 10^9 = 7_500_000_000
s3 = 7_500_000_000 × 1_000_000_000 / 10^9 = 7_500_000_000   (OAC=1.0, no-op)
s4 = 7_500_000_000 × 1_150_000_000 / 10^9 = 8_625_000_000
M  = 8_625_000_000 × 1_300_000_000 / 10^9 = 11_212_500_000 nanogic ≈ 11.21 MAGIC ✓
```

### TV-CATCHUP-01 (vectors.ts:153-170)

**Input:** 1000 LAMP Flame, LF=1.1, OAC=0.9, Δe=5

```
s1 = 1_000_000_000 × 5_000_000_000 / 10^9 = 5_000_000_000
s2 = 5_000_000_000 × 1_100_000_000 / 10^9 = 5_500_000_000
s3 = 5_500_000_000 × 900_000_000   / 10^9 = 4_950_000_000
s4 = 4_950_000_000 × 1_050_000_000 / 10^9 = 5_197_500_000
  Note: 4_950_000_000 × 1_050_000_000 = 5_197_500_000_000_000_000 / 10^9 = 5_197_500_000
M_one = 5_197_500_000 × 1_100_000_000 / 10^9 = 5_717_250_000 nanogic

M_total = 5 × 5_717_250_000 = 28_586_250_000 nanogic ≈ 28.586 MAGIC ✓
```

### TV-LF-03 (vectors.ts:85-97)

**Input:** 2 holdings: [{10⁹ oildrop, acq=50}, {10⁹ oildrop, acq=68}], current_epoch=74

```
age1 = 74-50 = 24 → LF_pwl(24) = Q + Q/5 + 3Q/10 × 12/12 = Q + 200M + 300M = 1_500_000_000
age2 = 74-68 =  6 → LF_pwl(6)  = Q + Q/10 × 6/6 = Q + 100M = 1_100_000_000
weighted = (10^9 × 1_500_000_000 + 10^9 × 1_100_000_000) / (2 × 10^9)
         = (1_500_000_000 + 1_100_000_000) / 2
         = 1_300_000_000 ✓
```

---

## 10. Boundary conditions

- **L = 0 oildrop:** M_snapshot = 0. Không tạo batch.
- **LF = Q (1.0):** Bước s2 là no-op (`s2 = s1`).
- **OAC tối đa (4 apps):** OAC_Q = 1_000_000_000 → bước s3 là no-op.
- **Δe = 1:** M_catchup = M_one (trường hợp thông thường, không catch-up thực sự).
- **Batch đầy (32):** SKIP — `last_updated_epoch` vẫn cập nhật nhưng MAGIC mất vĩnh viễn.
- **k = N(P) - 1:** `balance > 0`; k = N(P) → `balance = 0` (hard cutoff T2).
- **Profile change pending chưa đến hạn:** LF, OAC, formula dùng profile cũ cho epoch này.
