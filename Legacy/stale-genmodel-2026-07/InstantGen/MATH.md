# InstantGen — Math Specification
## GenMAGIC v3.3 · §9.1 · §6.1 · §4.3 · §14.4

---

## 1. Định nghĩa ký hiệu

| Ký hiệu | Giá trị / Đơn vị | Nguồn |
|---|---|---|
| Q | 10^9 | `constants.ak:6`, `constants.ts:5` |
| oildrop | LAMP × 10^6 | `constants.ts:14` |
| nanogic | MAGIC × 10^9 | `constants.ts:15` |
| L_paid | oildrop — lượng LAMP thanh toán | `vault.ak:71` redeemer field |
| L_avail | oildrop = lamp_balance − lamp_locked | `lamp.ak:94` |
| R_inst | 3_000_000_000 (Q-format = 3.0×) | `constants.ak:18` |
| UM_q | Q-format — sau stale check | `um.ak:22` |
| PM_q | Q-format — theo profile | `constants.ak:47` |
| UM_FALLBACK_Q | 500_000_000 (= 0.5×) | `constants.ak:39` |
| UM_MAX_STALENESS | 1 epoch | `constants.ak:36` |
| decay_window | 2 epoch (Instant) | `constants.ak:27` |

---

## 2. Công thức chính — InstantGen (§9.1)

```
M_instant = ⌊ L_paid × R_inst / Q ⌋ × UM_q / Q ⌋ × PM_q / Q ⌋
```

Ba bước sequential floor (L4: tổng lỗi ≤ 3 nanogic):

```
s1 = ⌊ L_paid × R_inst / Q ⌋      -- bước 1: áp dụng base rate
s2 = ⌊ s1 × UM_q / Q ⌋            -- bước 2: áp dụng UM
s3 = ⌊ s2 × PM_q / Q ⌋            -- bước 3: áp dụng PM
M_instant = s3                      -- nanogic
```

**Implementation (Aiken):** `math.ak:55`
```aiken
pub fn compute_instant_magic(lamp_paid: Int, um_q: Int, pm_q: Int) -> Int {
  let s  = lamp_paid * instant_base_rate_q / q  // step 1
  let s2 = s * um_q / q                          // step 2
  s2 * pm_q / q                                  // step 3
}
```

**Implementation (TypeScript):** `math.ts:56`
```typescript
export function computeInstantMagic(lampPaid: bigint, umQ: bigint, pmQ: bigint): bigint {
  const s1 = lampPaid * INSTANT_BASE_RATE_Q / Q;
  const s2 = s1 * umQ / Q;
  const s3 = s2 * pmQ / Q;
  return s3;
}
```

P8: cùng input → cùng output (bit-identical). Aiken `/` = floor div; TypeScript BigInt `/` = floor div cho giá trị dương.

---

## 3. UM stale check — C-UM-6 (§14.4)

```
staleness = current_epoch − um.last_updated_epoch

if staleness ≤ UM_MAX_STALENESS (=1):
    um_q = um.smoothed_q
else:
    um_q = UM_FALLBACK_Q = 500_000_000
```

**Implementation:** `um.ak:22` / `math.ts:75`

Stale check chỉ áp dụng cho InstantGen. VacuumGen và ScheduleGen dùng smoothed_q trực tiếp (C-UM-7, module khác).

---

## 4. Profile multiplier PM_q (§3.4, §19.1)

| Profile | PM_q | Giá trị thực |
|---|---|---|
| Ember | 1_150_000_000 | 1.15× |
| Flame | 1_050_000_000 | 1.05× |
| Lantern | 1_000_000_000 | 1.00× |

Nguồn: `constants.ak:47`, `constants.ts:32`. Profile được resolve sau `apply_pending_profile` (`profile.ak:19`).

---

## 5. Instant batch halving — §4.3 (C-DECAY-7/8)

```
k = current_epoch − batch.created_epoch

Quy tắc:
  k=0 → current_amount không đổi; halved=False
  k=1 ∧ halved=False → current_amount = ⌊current_amount / 2⌋; halved=True
  k=1 ∧ halved=True  → không đổi (T22: ngăn double-halve)
  k≥2 → expired (current_amount = 0, prune khỏi vault)
```

**Implementation:** `decay.ak:15` (`should_halve`), `decay.ak:22` (`apply_halving`), `decay.ak:62` (`halve_then_prune`).

C-DECAY-8: nếu tx không phải halving epoch (k≠1), `output.halved MUST == input.halved`. Tấn công TV-HALVED-INJECT: set halved=True ở k=0 → validator reject qua A02 batch comparison.

---

## 6. L_avail (§6.8)

```
L_avail = lamp_balance − lamp_locked
```

**Implementation:** `lamp.ak:94`. Chỉ unlocked LAMP có thể dùng cho InstantGen.

---

## 7. Loyalty holdings removal — oldest-first

Khi InstantGen deduct lamp_paid khỏi vault:
- Tách unlocked holdings, sort theo `acquired_epoch` tăng dần (oldest first).
- Tiêu thụ từ holding cũ nhất trước. Holding mới hơn (LF cao hơn) được bảo toàn.
- Locked holdings không bị chạm.

**Implementation:** `lamp.ak:22` (`remove_from_holdings`).

---

## 8. Test vectors (NORMATIVE — App B)

### TV-INST-GEN-01: 1000 LAMP, Flame, UM=1.0

```
Input: L_paid = 1_000_000_000 oildrop (= 1000 × 10^6)
       um_q   = 1_000_000_000  (UM = 1.0)
       pm_q   = 1_050_000_000  (Flame)

Tính:
  s1 = 1_000_000_000 × 3_000_000_000 / 10^9
     = 3_000_000_000_000_000_000 / 10^9
     = 3_000_000_000

  s2 = 3_000_000_000 × 1_000_000_000 / 10^9
     = 3_000_000_000_000_000_000 / 10^9
     = 3_000_000_000

  s3 = 3_000_000_000 × 1_050_000_000 / 10^9
     = 3_150_000_000_000_000_000 / 10^9
     = 3_150_000_000

Kết quả: 3_150_000_000 nanogic = 3.15 MAGIC
```

Nguồn: `vectors.ts:75` (TV-INST-GEN-01), xác nhận §20.3 calibration.

---

### TV-INST-GEN-02: 1000 LAMP, Ember, UM=1.5

```
Input: L_paid = 1_000_000_000, um_q = 1_500_000_000, pm_q = 1_150_000_000

  s1 = 1_000_000_000 × 3_000_000_000 / Q = 3_000_000_000
  s2 = 3_000_000_000 × 1_500_000_000 / Q = 4_500_000_000
  s3 = 4_500_000_000 × 1_150_000_000 / Q = 5_175_000_000

Kết quả: 5_175_000_000 nanogic = 5.175 MAGIC
```

Nguồn: `vectors.ts:98` (TV-INST-GEN-02).

---

### TV-INST-GEN-03: 500 LAMP, Lantern, UM=2.0 (max)

```
Input: L_paid = 500_000_000, um_q = 2_000_000_000, pm_q = 1_000_000_000

  s1 = 500_000_000 × 3_000_000_000 / Q = 1_500_000_000
  s2 = 1_500_000_000 × 2_000_000_000 / Q = 3_000_000_000
  s3 = 3_000_000_000 × 1_000_000_000 / Q = 3_000_000_000

Kết quả: 3_000_000_000 nanogic = 3.0 MAGIC
```

Nguồn: `vectors.ts:113` (TV-INST-GEN-03).

---

### TV-UM-SPLIT: UM stale fallback

```
Input: um.smoothed_q = 2_000_000_000, um.last_updated_epoch = 98
       current_epoch = 100

staleness = 100 - 98 = 2 > UM_MAX_STALENESS (=1)
→ Instant nhận UM_FALLBACK_Q = 500_000_000 (không phải smoothed)

Nếu tính 1000 LAMP Flame với stale UM:
  s1 = 3_000_000_000
  s2 = 3_000_000_000 × 500_000_000 / Q = 1_500_000_000
  s3 = 1_500_000_000 × 1_050_000_000 / Q = 1_575_000_000

Kết quả: 1_575_000_000 nanogic = 1.575 MAGIC (thay vì 3.15 MAGIC nếu UM fresh)
```

Nguồn: `vectors.ts:129` (TV-UM-SPLIT).

---

### TV-INST-01: Batch lifecycle

```
created_epoch = 100, decay_window = 2, initial_amount = 1_000_000_000

k=0 (epoch 100): balance = 1_000_000_000, halved = false
k=1 (epoch 101): halve  → balance = ⌊1_000_000_000 / 2⌋ = 500_000_000, halved = true
k=2 (epoch 102): expired → balance = 0 (pruned)
```

Nguồn: `vectors.ts:13` (TV-INST-01).

---

### TV-OVERFLOW-01: BigInt bắt buộc

```
L = 36_000_000_000_000_000 oildrop (toàn bộ nguồn cung LAMP)
R_inst = 3_000_000_000

Intermediate s1 = L × R_inst = 36×10^15 × 3×10^9 = 108×10^24

Number.MAX_SAFE_INTEGER ≈ 9×10^15 — overflow tại bước nhân!
BigInt: 108_000_000_000_000_000_000_000_000n → sau /Q = 108_000_000_000_000_000n ✓
```

Nguồn: `vectors.ts:161` (TV-OVERFLOW-01). C-OVERFLOW invariant.

---

## 9. Boundary conditions

| Điều kiện | Giá trị | Kết quả |
|---|---|---|
| lamp_paid = MIN - 1 | 9_999_999 | REJECT C-INST-1 |
| lamp_paid = MIN | 10_000_000 | ACCEPT |
| lamp_paid = MAX | 10_000_000_000_000 | ACCEPT |
| lamp_paid = MAX + 1 | 10_000_000_000_001 | REJECT C-INST-2 |
| lamp_paid > L_avail | bất kỳ | REJECT C-INST-3 |
| active_batches = 32 | — | REJECT C-INST-7 |
| UM stale > 1 epoch | — | ACCEPT với um_q = 0.5× fallback |
| M_instant = 0 | edge case nhỏ | REJECT (expect > 0, `vault.ak:171`) |

---

## 10. Lỗi rounding (L4)

Chuỗi 3 sequential floor multiplications → tổng lỗi ≤ 3 nanogic (≤ 3×10^-9 MAGIC). Không tích lũy vì mỗi bước tính độc lập. `M_actual ≤ M_true` (luôn thuận lợi cho protocol, bảo thủ cho user).
