# MATH.md — ScheduleGen Mathematical Specification
## GenMAGIC v3.3 · §11 ScheduleGen · Cardano Preview Testnet

---

## 1. Ký hiệu

| Ký hiệu | Định nghĩa | Đơn vị |
|---|---|---|
| `Q` | Hệ số Q-format = 10^9 | — |
| `L` | Chiều dài schedule (số orders) ∈ [10, 200] | orders |
| `λ` (lambda) | LAMP per fire | oil (LAMP × 10^6) |
| `R_snap` | Snapshot base rate tại thời điểm commit | Q-format |
| `S(L)` | Schedule bonus multiplier, hàm của L | Q-format |
| `rate_locked_q` | Tỷ lệ sinh khóa tại commit | Q-format |
| `M_i` | MAGIC sinh ra mỗi fire order `i` | nanogic (MAGIC × 10^9) |
| `e_i` | Epoch eligible của order `i` | epoch |
| `shard_id` | ID của shard UTxO cần update | 0..15 |
| `oil` | LAMP × 10^6 | oil |
| `nanogic` | MAGIC × 10^9 | nanogic |

---

## 2. S(L) — Schedule Bonus Multiplier (§11.3)

Hàm piecewise tuyến tính, đặc tả ưu đãi cho schedule dài hơn.

```
S(L) = { 1.5 + 0.010 × L              L ∈ [10, 50]      (segment 1)
        { 2.0 + 0.005 × (L - 50)      L ∈ (50, 150]     (segment 2)
        { 2.5 + 0.0025 × (L - 150)    L ∈ (150, 200]    (segment 3)
```

Biểu diễn Q-format (tất cả tính bằng integer, tránh float):

```
S_Q(L) = { 1_500_000_000 + 10_000_000 × L              L ≤ 50
          { 2_000_000_000 + 5_000_000 × (L - 50)       50 < L ≤ 150
          { 2_500_000_000 + 2_500_000 × (L - 150)      150 < L ≤ 200
```

**Nguồn:** `math.ak:36-47`, `math.ts:31-39`, `constants.ak:12-18`, `constants.ts:10-17`.

### Tính chất đã chứng minh

**T11 (Continuity at knees):**
- `seg1(50) = 1.5B + 10M×50 = 2.0B = seg2(50)` ✓
- `seg2(150) = 2.0B + 5M×100 = 2.5B = seg3(150)` ✓

**T12 (Diminishing marginal rate):**
- Slope seg1 = 0.010, seg2 = 0.005, seg3 = 0.0025.
- Mỗi segment có slope nhỏ hơn segment trước: `0.010 > 0.005 > 0.0025` ✓

---

## 3. rate_locked_q — Tỷ lệ sinh khóa tại commit (§11.2, T8)

```
rate_locked_q = ⌊ R_snap_c × S_Q(L) / Q ⌋
```

Trong đó `R_snap_c` là giá trị `snapshot_base_rate_q` tại epoch commit. Giá trị này được lưu vào `GenSchedule.rate_locked_q` và **không bao giờ thay đổi** — mọi fire đều đọc giá trị đã lưu, không recompute (T8).

**Nguồn:** `math.ak:63-66`, `math.ts:54-58`, `vault.ak:164,236`.

### Bảo vệ bởi T8

- `vault.ak:236`: `compute_m_i(sched.lamp_per_epoch, sched.rate_locked_q)` — đọc từ `sched`, không từ global.
- `schedule.ts:268`: `computeMi(sched.lamp_per_epoch, sched.rate_locked_q)` — tương tự.
- DAO nâng `snapshot_base_rate_q` sau commit → chỉ ảnh hưởng schedule mới.

---

## 4. M_i — MAGIC per fire (§11.4, T-DET)

```
M_i = ⌊ λ × rate_locked_q / Q ⌋
```

**T-DET:** Tất cả orders trong cùng 1 schedule cho cùng 1 `M_i` vì `rate_locked_q` và `λ` đều immutable sau commit.

**C-SCH-RATE / T19:** Điều kiện đủ để `M_i ≥ 1`:
```
λ × rate_locked_q ≥ Q
```
Validator enforce tại commit (`vault.ak:168`). Nếu vi phạm → REJECT commit.

**Nguồn:** `math.ak:81-83`, `math.ts:73-75`, `vault.ak:165,236`.

---

## 5. Fire epoch eligibility (C-FIRE-1 ≥)

Order thứ `i` (0-indexed từ `fired_count`) eligible khi:
```
e_i = start_fire_epoch + fired_count + i ≤ current_epoch
```

`start_fire_epoch = commit_epoch + schedule_delay` (delay = 2 epoch, `constants.ak:28`).

Số fires trong 1 tx:
```
fires_in_tx = min(
  count_by_time(start_fire_epoch, fired_count, current_epoch),
  MAX_FIRES_PER_TX_CATCHUP,   // 8
  32 - |current_magic_batches|,
  schedule_length - fired_count
)
```

**Nguồn:** `vault.ak:292-315`, `math.ts:102-120`.

---

## 6. shard_id — Phân bổ vào shard (§5.5, C-SCH-FIRE-SHARD)

```
shard_id(owner_pkh) = blake2b_256(owner_pkh)[0] % 16
```

Deterministic từ PKH của owner. Computed on-chain (`math.ak:99-102`) và off-chain (`math.ts:89-92`) — phải bit-identical (P8).

---

## 7. Shard cap enforcement (T13, C-SCH-CAP)

Mỗi shard có `shard_cap = 4.5 × 10^14 oil = 450,000,000 LAMP`.

Có thể suy ra từ:
```
shard_cap = TOTAL_LAMP × SCHEDULE_PARTICIPATION_CAP_BPS / (10000 × SHARD_COUNT)
          = 36 × 10^15 × 2000 / (10000 × 16)
          = 4.5 × 10^14 oil
```

Tức là mỗi shard có tối đa 450M LAMP bị khóa = tổng 20% LAMP cung ứng chia đều cho 16 shards.

Điều kiện tại commit:
```
shard_datum.shard_locked_lamp + L × λ ≤ shard_cap
```

Nguồn: `vault.ak:173` (check trong validate_commit), `shard validator:109` (enforced trong ShardUpdateCommit).

---

## 8. Test vectors (normative — App B §B.5)

### TV-SCH-01: S_Q(L) piecewise

| L | S_Q | Segment | Tính toán |
|---|---|---|---|
| 10 | 1_600_000_000 | seg1 | 1.5B + 10M×10 = 1.6B |
| 50 | 2_000_000_000 | T11 | seg1(50) = seg2(50) = 2.0B |
| 100 | 2_250_000_000 | seg2 | 2.0B + 5M×50 = 2.25B |
| 150 | 2_500_000_000 | T11 | seg2(150) = seg3(150) = 2.5B |
| 200 | 2_625_000_000 | seg3 | 2.5B + 2.5M×50 = 2.625B |

Nguồn: `vectors.ts:7-18`.

### TV-SCH-02: L=100, λ=4000 LAMP → 45 MAGIC/fire

Inputs:
- `L = 100`, `λ = 4_000 LAMP = 4_000_000_000 oil`
- `R_snap = 5_000_000_000`

Tính:
```
S_Q(100)      = 2_000_000_000 + 5_000_000 × (100 - 50) = 2_250_000_000
rate_locked_q = ⌊5_000_000_000 × 2_250_000_000 / 10^9⌋ = 11_250_000_000
M_i           = ⌊4_000_000_000 × 11_250_000_000 / 10^9⌋ = 45_000_000_000  (= 45 MAGIC)
total_MAGIC   = 100 × 45 = 4_500 MAGIC
total_lock    = 100 × 4_000_000_000 = 400_000_000_000_000 oil (= 400,000 LAMP)
```

Kiểm tra C-SCH-RATE: `4_000_000_000 × 11_250_000_000 = 4.5×10^19 ≥ 10^9` ✓

Nguồn: `vectors.ts:23-40`.

### TV-SCH-06: Catch-up 4 epoch bị bỏ lỡ

Inputs:
- `start_fire_epoch = 52`, `fired_count = 0`, `current_epoch = 55`

Eligible orders:
- `e_0 = 52 + 0 = 52 ≤ 55` ✓
- `e_1 = 52 + 1 = 53 ≤ 55` ✓
- `e_2 = 52 + 2 = 54 ≤ 55` ✓
- `e_3 = 52 + 3 = 55 ≤ 55` ✓
- `e_4 = 52 + 4 = 56 > 55` → dừng

```
fires_in_tx   = 4  (< 8 catch-up limit)
total_MAGIC   = 4 × 45_000_000_000 = 180_000_000_000  (= 180 MAGIC)
lamp_transfer = 4 × 4_000_000_000  = 16_000_000_000   (= 16,000 LAMP)
fired_count_out = 0 + 4 = 4
```

Nguồn: `vectors.ts:99-113`.

### TV-SCH-CATCHUP-LIMIT: 18 eligible → 8 fires (MAX cap)

Inputs:
- `start_fire_epoch = 52`, `fired_count = 0`, `schedule_length = 20`, `current_epoch = 69`
- Eligible by time: `e_0..e_17` đều ≤ 69 → 18 orders eligible
- `fires_in_tx = min(18, 8, ...) = 8` (capped tại MAX_FIRES_PER_TX_CATCHUP)
- 10 orders còn lại: defer, KHÔNG forfeit (gọi fire lại trong tx tiếp theo)

Nguồn: `vectors.ts:118-129`.

### TV-SCH-05: C-SCH-RATE reject khi M_i = 0

Inputs:
- `R_snap = 100`, `λ = 1_000_000 oil (1 LAMP)`, `L = 10`

Tính:
```
S_Q(10)       = 1_500_000_000 + 10_000_000 × 10 = 1_600_000_000
rate_locked_q = ⌊100 × 1_600_000_000 / 10^9⌋    = 160
M_i           = ⌊1_000_000 × 160 / 10^9⌋         = 0
check_sch_rate: 1_000_000 × 160 = 160_000_000 < 10^9 → FAIL → REJECT commit
```

Nguồn: `vectors.ts:82-95`.

---

## 9. BigInt và overflow

Tất cả giá trị oil, nanogic, Q-format dùng `BigInt` (TypeScript) / `Int` (Aiken). Không dùng `Number`.

- `λ × rate_locked_q` có thể lên đến `~10^22` (TV-SCH-02: `4×10^9 × 11.25×10^9 = 4.5×10^19`).
- `L × λ` trong TV-SCH-02: `100 × 4×10^9 = 4×10^11` (an toàn trong 64-bit integer).
- Tuy nhiên một số trường hợp extreme (`L=200`, `λ` lớn) có thể vượt 2^63. Aiken dùng arbitrary precision Integer, TypeScript dùng `BigInt` — đều an toàn.

Nguồn: `constants.ts:2-3`, CLAUDE.md (C-OVERFLOW).
