# VacuumGen — Math Specification
## GenMAGIC v3.3 · §10.1 VacuumGen Formula

---

## 1. Ký hiệu

| Ký hiệu | Đơn vị | Mô tả |
|---|---|---|
| `λ` | oildrop (= LAMP × 10⁶) | LAMP cam kết tại commit |
| `VBR` | — | Vacuum Base Rate = 0.5 |
| `UM_smoothed` | Q-format | Network Demand Multiplier, luôn smoothed (C-UM-7) |
| `SM` | Q-format | Streak Multiplier (§6.5) |
| `M_v` | nanogic (= MAGIC × 10⁹) | MAGIC được tạo ra |
| `Q` | — | Cố định = 10⁹ |

---

## 2. Công thức chính

```
M_v = ⌊ (⌊ (⌊ λ × VBR_Q / Q ⌋ × UM_smoothed_Q / Q) ⌋ × SM_Q / Q) ⌋
```

Ba bước nhân tuần tự (sequential ⌊×/Q⌋), không gộp lại (tránh overflow, giới hạn rounding error §6.1 / L4):

```
s1 = ⌊ λ × VBR_Q / Q ⌋          // × VBR (0.5)
s2 = ⌊ s1 × UM_smoothed_Q / Q ⌋  // × UM
M_v = ⌊ s2 × SM_Q / Q ⌋          // × SM
```

Nguồn: `math.ak:compute_vacuum_magic` (dòng 65-73), `math.ts:computeVacuumMagic` (dòng 67-74).

---

## 3. Không có PM và LF

VacuumGen **không** áp dụng Profile Multiplier PM và Loyalty Factor LF.

Chuỗi nhân M_vacuum (§6.10): `λ × VBR × UM × SM` — không có PM, không có LF.

So sánh với InstantGen (`λ × IBR × UM × PM`) và SnapshotGen (`L × SBR × LF × OAC × PM`).

---

## 4. UM cho VacuumGen (C-UM-7)

VacuumFire luôn dùng `um.smoothed_q`:

```
UM_vacuum = UMDatum.smoothed_q    // không có stale check
```

Lý do: `fire_epoch = commit_epoch + 2` cố định. Người dùng không thể điều chỉnh thời điểm fire → áp dụng phạt stale sẽ bất công. Ngoài ra loại bỏ griefing: attacker kích hoạt fire sớm sẽ nhận cùng UM, không có lợi.

Nguồn: `math.ak:get_um_for_vacuum` (dòng 40-42), `math.ts:getUmForVacuum` (dòng 43-45).

Ràng buộc range: `UM_MIN_Q = 500_000_000 (0.5×)`, `UM_MAX_Q = 2_000_000_000 (2.0×)`.

---

## 5. Streak Multiplier (SM, §6.5)

| Streak | SM_Q | Giá trị |
|---|---|---|
| < 3 | 1_000_000_000 | 1.00× |
| 3–5 | 1_050_000_000 | 1.05× |
| 6–11 | 1_100_000_000 | 1.10× |
| ≥ 12 | 1_200_000_000 | 1.20× |

Nguồn: `constants.ak:sm_q_*` (dòng 17-20), `constants.ts:SM_Q` (dòng 16-21).

SM đọc từ `vault.streak_state.current_streak`. Không phụ thuộc vào profile hay UM.

---

## 6. VBR (Vacuum Base Rate)

```
VBR_Q = 500_000_000   // = 0.5×
```

Nghĩa: 1 LAMP (10⁶ oildrop) với UM=1.0, SM=1.0 tạo 0.5 MAGIC.

Nguồn: `constants.ak:vbr_q` (dòng 9), `constants.ts:VBR_Q` (dòng 9).

---

## 7. Decay (Cliff Model)

Vacuum batch dùng cliff model với `decay_window = 1`:

- Tại epoch `created_epoch`: batch còn hiệu lực (`current_epoch - created_epoch = 0 < 1`).
- Từ epoch `created_epoch + 1`: batch hết hạn (`current_epoch - created_epoch >= 1`).

Tức là batch chỉ tồn tại trong đúng 1 epoch sau khi tạo.

Nguồn: `constants.ak:vacuum_decay_window = 1` (dòng 13), validator prune logic `vault.ak:186-189`.

---

## 8. Lock / Unlock Holdings

### Lock tại Commit (youngest-first, T5)

Sắp xếp holdings theo `acquired_epoch` giảm dần, khóa từ youngest:

```
select_lamp_for_lock(holdings, lambda):
  sorted = sort_desc_by_epoch(holdings)
  lock lambda oildrop from youngest, split holding nếu cần
```

Mục tiêu: free holdings = oldest → LF(free) tối đa (LF tăng theo tuổi).

Nguồn: `lock.ak:select_lamp_for_lock` (dòng 21-56), `math.ts:selectLampForLock` (re-export từ protocol-utils).

### Unlock tại Fire (oldest-first)

Xoá `lambda` oildrop từ locked holdings, ưu tiên oldest locked trước:

```
remove_locked_amount(holdings, lambda):
  locked   = filter is_locked==True, sort ASC by epoch
  unlocked = filter is_locked==False
  consume oldest locked until lambda consumed
  return concat(unlocked, remaining_locked)
```

Nguồn: `lock.ak:remove_locked_amount` (dòng 65-75).

---

## 9. Test Vectors Normative

### TV-VAC-01 (App B §B.4)

```
Input:  λ = 1_000_000_000 oildrop (1000 LAMP)
        UM_smoothed_Q = 1_500_000_000 (1.5×)
        streak = 8  →  SM_Q = 1_100_000_000 (1.10×)
        VBR_Q = 500_000_000

s1 = 1_000_000_000 × 500_000_000 / 1_000_000_000 = 500_000_000
s2 = 500_000_000   × 1_500_000_000 / 1_000_000_000 = 750_000_000
M_v = 750_000_000  × 1_100_000_000 / 1_000_000_000 = 825_000_000

Expected: 825_000_000 nanogic = 0.825 MAGIC
```

### TV-VAC-CALIB (§20.3 calibration)

```
Input:  λ = 1_000_000_000 oildrop
        UM_smoothed_Q = 1_000_000_000 (1.0×)
        streak = 0  →  SM_Q = 1_000_000_000 (1.00×)

s1 = 500_000_000
s2 = 500_000_000
M_v = 500_000_000

Expected: 500_000_000 nanogic = 0.5 MAGIC (baseline calibration)
```

### TV-VAC-MAX

```
Input:  λ = 1_000_000_000 oildrop
        UM_smoothed_Q = 2_000_000_000 (2.0× — max)
        streak = 12  →  SM_Q = 1_200_000_000 (1.20×)

s1 = 500_000_000
s2 = 500_000_000 × 2_000_000_000 / 1_000_000_000 = 1_000_000_000
M_v = 1_000_000_000 × 1_200_000_000 / 1_000_000_000 = 1_200_000_000

Expected: 1_200_000_000 nanogic = 1.2 MAGIC (trần lý thuyết với λ=1000 LAMP, UM=2.0×, streak≥12)
```

### TV-LOCK-01 (App B §B.8)

```
Holdings:
  {amount: 1_000, acquired_epoch: 50, locked: false}
  {amount: 2_000, acquired_epoch: 80, locked: false}
  {amount: 1_500, acquired_epoch: 60, locked: false}

Lock lambda = 2_500

Sorted youngest-first: [2000@80, 1500@60, 1000@50]
Step 1: Lock 2000@80 fully (rem = 500)
Step 2: Lock 500@60 (split 1500@60 → 500@60:L + 1000@60:F)

Result:
  {2000, epoch=80, locked=true}
  {500,  epoch=60, locked=true}
  {1000, epoch=60, locked=false}
  {1000, epoch=50, locked=false}

T5 verified: free holdings có epoch 60, 50 — oldest, LF(free) tối đa.
```

### TV-UM-SPLIT-VACUUM (App B §B.13, C-UM-7)

```
UMDatum:
  smoothed_q         = 2_000_000_000 (2.0×)
  last_updated_epoch = 98
  current_epoch      = 100
  staleness          = 2 epochs (> UM_MAX_STALENESS=1)

VacuumGen result: um_q = 2_000_000_000  (smoothed, bất kể staleness)
InstantGen result: um_q = 500_000_000   (fallback, staleness > 1)

Expected VacuumGen: 2_000_000_000 (C-UM-7 — never fallback)
```

---

## 10. Boundary Conditions

| Điều kiện | Giá trị | Kết quả |
|---|---|---|
| `lambda < 1 LAMP` | `< 1_000_000 oildrop` | Reject C-VAC-3 |
| `lambda == 1 LAMP` | `= 1_000_000 oildrop` | Accept |
| `UM < UM_MIN` | `< 500_000_000` | Reject validate_um_range |
| `UM == UM_MIN` | `= 500_000_000` | Accept |
| `UM > UM_MAX` | `> 2_000_000_000` | Reject validate_um_range |
| `streak == 2` | SM_Q = 1_000_000_000 | 1.00× (< 3 tier) |
| `streak == 3` | SM_Q = 1_050_000_000 | 1.05× (3-5 tier) |
| `streak == 11` | SM_Q = 1_100_000_000 | 1.10× (6-11 tier) |
| `streak == 12` | SM_Q = 1_200_000_000 | 1.20× (≥12 tier) |
| Vault full sau prune | `|batches| == 32` | M_v = 0, batch không tạo; LAMP transfer vẫn xảy ra (INV-43) |
| `lambda = L_avail` | toàn bộ free LAMP | Accept (edge: lamp_locked = lamp_balance sau commit) |

---

## 11. BigInt + Q-format Safety (C-OVERFLOW)

- Tất cả tính toán dùng `Int` (Aiken) / `bigint` (TypeScript).
- Không dùng `Number` cho `oildrop`, `nanogic`, `Q`.
- Sequential floor division: 3 bước `⌊×/Q⌋` riêng lẻ.
- TV-OVERFLOW-01/02 trong test suite bắt regression nếu dùng `Number`.
