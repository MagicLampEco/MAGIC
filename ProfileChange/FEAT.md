# ProfileChange — FEAT.md
## GenMAGIC v3.3 · §12 · C-PC-V1..6 · T4

---

## 1. Mục đích

ProfileChange cho phép chủ vault chuyển đổi **ActivityProfile** (Ember / Flame / Lantern) theo cơ chế **2-step lazy**: user khởi tạo yêu cầu, profile thực sự áp dụng ở lần chạm vault tiếp theo.

Mục tiêu thiết kế:
- Tránh race condition: profile không đổi giữa chừng khi một Snapshot/InstantGen đang được xây dựng ngoài chain.
- Bảo toàn tính bất biến `profile_at_creation` trên toàn bộ batch đã sinh (T4, C-PC-V4/V6).
- Hạn chế "profile flip" lạm dụng bằng cooldown cứng 2 epoch (C-PC-V2).

---

## 2. Actors

| Actor | Vai trò |
|---|---|
| **Vault Owner** | Ký UpdateProfile + ApplyPending. Duy nhất được phép đổi profile. |
| **Bất kỳ vault tx** (off-chain) | Khi xây SnapshotGen / InstantGen / ApplyHalving tx, gọi `applyPendingProfile` helper để tự động apply nếu tới hạn. |
| **On-chain validator** (`vault_profile.ak`) | Kiểm tra tất cả invariants C-PC-V1..6 + bất biến field. |

---

## 3. Flows

### 3.1 Happy path — UpdateProfile

```
Epoch E   (current_epoch - profile_changed_epoch ≥ 2)

Tx UpdateProfile:
  Input  vault:  profile=Flame, pending=None, profile_changed_epoch=E-5
  Output vault:  profile=Flame (CHƯA đổi),
                 pending_profile=Some{Ember, effective: E+1},
                 profile_changed_epoch=E,
                 last_updated_epoch=E
  Extra signatories: [owner]
  Validity range: [E×ms_per_epoch, (E+1)×ms_per_epoch - 1]
```

### 3.2 Happy path — ApplyPending (lazy apply)

```
Epoch E+1 (bất kỳ vault tx sau UpdateProfile)

Khi effective_epoch (E+1) ≤ current_epoch (E+1):
  Input  vault:  profile=Flame, pending=Some{Ember, effective: E+1}
  Output vault:  profile=Ember,
                 pending_profile=None,
                 last_updated_epoch=E+1
                 profile_changed_epoch KHÔNG đổi (vẫn = E)
  Extra signatories: [owner]
```

### 3.3 Edge cases (MECE)

| Case | Kết quả |
|---|---|
| `pending_profile = None` + gọi ApplyPending | Fail: `"No pending profile to apply"` |
| `pending.effective_epoch > current_epoch` | Fail: chưa tới hạn |
| `new_profile == current profile` | Fail C-PC-V3 |
| `current_epoch - profile_changed_epoch < 2` | Fail C-PC-V2 cooldown |
| Owner không ký | Fail C-PC-V1 |
| Output thay đổi bất kỳ field ngoài nhóm được phép | Fail all_other_fields_unchanged (C-PC-V4/V6) |
| Hai vault input cùng script hash (double-satisfaction) | Fail: count_inputs_at_script == 1 |
| Datum không decode được | Fail: expect Some(datum) |

### 3.4 Lazy apply trong các module khác

`applyPendingProfile` (math.ts:13) được gọi bởi:
- SnapshotGen tx builder: trước khi tính toán batch mới
- InstantGen tx builder: trước khi dùng `profile` cho LF/OAC
- ApplyHalving tx builder: trước khi áp halving

Trong mọi trường hợp: `magic_batches` đã có KHÔNG bị ảnh hưởng (T4).

---

## 4. Invariants

| ID | Phát biểu |
|---|---|
| **C-PC-V1** | `owner ∈ tx.extra_signatories` |
| **C-PC-V2** | `current_epoch − profile_changed_epoch ≥ 2` |
| **C-PC-V3** | `new_profile ≠ datum.profile` (UpdateProfile) |
| **C-PC-V4** | `magic_batches` output == input (profile_at_creation bất biến) |
| **C-PC-V5** | `pending_profile.effective_epoch = current_epoch + 1` (UpdateProfile) |
| **C-PC-V6** | MỌI field ngoài nhóm được phép đổi phải nguyên vẹn |
| **T4** | `profile_at_creation` trong từng MagicBatch không thể thay đổi |
| **W-DS** | Đúng 1 input + 1 output tại script hash (chống double-satisfaction) |

**Nhóm field được phép đổi:**
- UpdateProfile: `pending_profile`, `profile_changed_epoch`, `last_updated_epoch`
- ApplyPending: `profile`, `pending_profile`, `last_updated_epoch`

---

## 5. Out-of-scope

- ProfileChange KHÔNG tác động đến `magic_batches` hay `gen_schedules` (bất biến tuyệt đối).
- ProfileChange KHÔNG mint/burn token.
- ProfileChange KHÔNG xử lý `delegation_cert` hay `streak_state`.
- Việc tính MAGIC dựa trên profile mới (ELV, N, decay) thuộc về SnapshotGen/InstantGen/VacuumGen — không phải module này.
- Lazy apply trong SnapshotGen/InstantGen/ApplyHalving là trách nhiệm của module đó; ProfileChange validator chỉ cung cấp redeemer `ApplyPending` cho trường hợp standalone.
