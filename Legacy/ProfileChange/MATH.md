# ProfileChange — MATH.md
## GenMAGIC v3.3 · §12 · Formal definitions + Test vectors

---

## 1. Formal Definitions

### 1.1 ActivityProfile

```
ActivityProfile ∈ { Ember, Flame, Lantern }
```

Mỗi profile xác định 2 tham số sinh MAGIC dùng bởi SnapshotGen/InstantGen:

| Profile | N (decay window, epoch) | d (decay rate/epoch) | ELV (effective lifetime value) |
|---|---|---|---|
| Ember   | 3 | 0.70 | 2.19 |
| Flame   | 6 | 0.80 | 3.69 |
| Lantern | 9 | 0.90 | 6.12 |

**ELV** = Effective Lifetime Value = tổng geometric series:
```
ELV(d, N) = Σ_{k=0}^{N-1} d^k = (1 - d^N) / (1 - d)
```
Kiểm tra:
- Ember:   (1 - 0.70^3) / (1 - 0.70) = (1 - 0.343) / 0.30 = 0.657 / 0.30 = 2.19
- Flame:   (1 - 0.80^6) / (1 - 0.80) = (1 - 0.262144) / 0.20 = 0.737856 / 0.20 = 3.689 ≈ 3.69
- Lantern: (1 - 0.90^9) / (1 - 0.90) = (1 - 0.387420489) / 0.10 = 0.612579511 / 0.10 = 6.12

### 1.2 PendingProfile

```
PendingProfile = { new_profile: ActivityProfile, effective_epoch: Natural }
```

Bất biến: `effective_epoch = profile_changed_epoch + 1` (tại thời điểm UpdateProfile).

### 1.3 Epoch tính trên chain

```
epoch(tx) = ⌊ validity_range.lower_bound / ms_per_epoch ⌋
```

Trong đó:
- Preview: `ms_per_epoch = 86_400_000` (1 ngày = 86,400 giây × 1000 ms)
- Mainnet: `ms_per_epoch = 432_000_000` (5 ngày = 432,000 giây × 1000 ms)

Nguồn: `util.ak:get_epoch` (ProfileChange/onchain/lib/magiclamp/protocol/util.ak:15).

**Lưu ý audit (Bug b):** Validator cũ hard-code `slots_per_epoch = 432_000` theo mainnet. Fix đã áp dụng: tham số hóa `ms_per_epoch` thay vì slots, dùng POSIX ms vì `validity_range` Plutus là POSIX milliseconds.

---

## 2. Điều kiện Cooldown (C-PC-V2)

```
can_change(vault, e_current) = (e_current - vault.profile_changed_epoch) ≥ PROFILE_COOLDOWN

PROFILE_COOLDOWN = 2  // [Significant]
```

Nguồn: `vault_profile.ak:32`, `math.ts:5`.

**Ý nghĩa kinh tế:** Ngăn user liên tục flip profile để "chọn profile tốt nhất" ngay trước mỗi Snapshot. Với Snapshot mỗi epoch, cooldown = 2 có nghĩa là tối thiểu 1 epoch phải "chịu" profile đã chọn trước khi đổi tiếp.

### 2.1 Số epoch phải chờ

```
wait_epochs(vault, e_current) =
  0                                        nếu can_change = true
  PROFILE_COOLDOWN - (e_current - profile_changed_epoch)   ngược lại
```

Nguồn: `math.ts:canChangeProfile`.

---

## 3. Apply Pending (§12.2)

```
apply_pending(profile, pending, e_current) =
  (profile, None)              nếu pending = None
  (pending.new_profile, None)  nếu pending.effective_epoch ≤ e_current
  (profile, pending)           ngược lại
```

Nguồn: `math.ts:applyPendingProfile` (ProfileChange/offchain/src/math.ts:13).

Trên chain: `vault_profile.ak:98` — `output.profile == pending.new_profile` + `output.pending_profile == None`.

---

## 4. Bất biến profile_at_creation (T4)

Khi batch được sinh tại epoch `e_c` với profile `p_c`:

```
batch.profile_at_creation = p_c  (bất biến suốt vòng đời batch)
```

Dù vault.profile thay đổi ở epoch `e_x > e_c`, batch tính toán decay/expiry vẫn dùng `p_c`:

```
expired(batch, e_check) = (e_check - batch.created_epoch) ≥ N(batch.profile_at_creation)
```

Kết quả: batch KHÔNG thể "kéo dài" bằng cách đổi sang profile N lớn hơn.

---

## 5. Test Vectors (verifiable)

### TV-PC-01: Cooldown boundary — đủ

```
Input:
  profile_changed_epoch = 98
  current_epoch         = 100
  PROFILE_COOLDOWN      = 2

Tính:
  elapsed = 100 - 98 = 2
  2 ≥ 2 → allowed = true, waitEpochs = 0

Expected: canChangeProfile(98n, 100n) → { allowed: true, waitEpochs: 0n }
Nguồn: tests/profile.test.ts:43
```

### TV-PC-02: Cooldown — chưa đủ (gap = 1)

```
Input:
  profile_changed_epoch = 99
  current_epoch         = 100

Tính:
  elapsed = 100 - 99 = 1
  1 < 2 → allowed = false, waitEpochs = 2 - 1 = 1

Expected: canChangeProfile(99n, 100n) → { allowed: false, waitEpochs: 1n }
Nguồn: tests/profile.test.ts:49
```

### TV-PC-03: Apply pending — tới hạn (boundary exact)

```
Input:
  current_profile = Ember
  pending = { new_profile: Lantern, effective_epoch: 100 }
  current_epoch   = 100

Tính:
  100 ≤ 100 → apply
  profile = Lantern, pending = null

Expected: applyPendingProfile("Ember", {new_profile:"Lantern", effective_epoch:100n}, 100n)
          → { profile: "Lantern", pending: null }
Nguồn: tests/profile.test.ts:12
```

### TV-PC-04: Apply pending — chưa tới hạn

```
Input:
  current_profile = Ember
  pending = { new_profile: Lantern, effective_epoch: 101 }
  current_epoch   = 100

Tính:
  101 > 100 → không apply

Expected: { profile: "Ember", pending: (unchanged) }
Nguồn: tests/profile.test.ts:18
```

### TV-PC-05: T4 — batch dùng profile_at_creation

```
Batch tạo tại epoch 95, profile_at_creation = Flame (N=6).
Profile vault đổi sang Ember (N=3) effective epoch 101.
Kiểm tra tại epoch 101:

  k = 101 - 95 = 6
  N(Flame) = 6
  expired = (6 ≥ 6) = true  ← đúng

Nếu sai (dùng profile vault mới Ember N=3):
  expired = (6 ≥ 3) = true  ← cũng expired, nhưng đã expired sớm hơn (ep98)
                               → batch bị coi expired tại ep98, mất 3 epoch generation

Nguồn: tests/profile.test.ts:24
```

### TV-PC-06: ELV Lantern verification

```
d = 0.90, N = 9
ELV = Σ_{k=0}^{8} 0.90^k
    = 1 + 0.9 + 0.81 + 0.729 + 0.6561 + 0.59049 + 0.531441 + 0.4782969 + 0.43046721
    = 6.12579511 ≈ 6.12  ✓

Nguồn: math.ts:PROFILE_INFO (ProfileChange/offchain/src/math.ts:7)
```

---

## 6. Boundary conditions

| Condition | Kết quả |
|---|---|
| `effective_epoch = current_epoch` (boundary exact) | Apply (≤ là half-open tính inclusive trên) |
| `effective_epoch = current_epoch + 1` | Chưa apply (chờ epoch tiếp) |
| `profile_changed_epoch = 0` (vault mới, chưa đổi bao giờ) | Cooldown tính từ epoch 0; với epoch hiện tại ≥ 2 → allowed |
| Đổi từ epoch 0 → epoch 1: elapsed = 1 < 2 | Blocked |
| Đổi Ember → Flame → Ember: mỗi bước phải cách nhau ≥ 2 epoch | Được phép |
