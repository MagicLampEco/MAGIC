# SnapshotGen FEAT — Functional Specification
## GenMAGIC v3.3 · §8 SnapshotGen · Phiên bản spec: v1.0

---

## 1. Mục đích

SnapshotGen là cơ chế sinh MAGIC tự động theo epoch, không tốn LAMP, không cần keeper. Mỗi khi owner gửi bất kỳ giao dịch nào chạm vault, validator kiểm tra xem đã qua epoch mới chưa; nếu có, nó tính M_snapshot cho tất cả các epoch bị bỏ qua (catch-up) và tạo một MagicBatch mới trong datum. MAGIC chỉ tồn tại dưới dạng số kế toán trong datum — không có token hóa, không có MintPolicy.

---

## 2. Actors

| Actor | Vai trò |
|---|---|
| Owner | Địa chỉ sở hữu vault. Ký giao dịch TriggerSnapshot (extra_signatories). |
| Vault UTxO | UTxO duy nhất tại vault script address. Mang datum VaultDatum + LAMP tokens. |
| Cardano Ledger | Cung cấp validity_range → current_epoch. |

Không có keeper, oracle, hay UM reference input (T16 — P10).

---

## 3. Flows

### 3.1 Happy path — TriggerSnapshot

**Điều kiện kích hoạt:** owner gửi tx có redeemer `TriggerSnapshot`, validity_range lower bound ở epoch mới hơn `last_updated_epoch`.

**Các bước (theo thứ tự validator thực hiện):**

1. Lấy `current_epoch = lower_bound_posix_ms / ms_per_epoch` từ validity_range (`vault.ak:64`).
2. Kiểm tra `current_epoch > last_updated_epoch` (C-SS-1).
3. Kiểm tra owner ký (`extra_signatories` có chứa `owner`).
4. Kiểm tra đúng 1 vault input + đúng 1 vault output (C-VAULT-DS-1, C-VAULT-OUT-1).
5. `apply_pending_profile(input_datum, current_epoch)` → `applied_input` (profile.ak). Nếu `pending_profile` đến hạn, profile field chuyển, pending xóa.
6. Lấy `lamp_balance = applied_input.lamp_balance` — **toàn bộ, kể cả locked** (C-SS-5, L3).
7. Tính `lf_q = compute_lf_q(holdings, current_epoch)` (lf_oac.ak:42).
8. Tính `oac_q = compute_oac_q(activity_state, current_epoch)` (lf_oac.ak:96) — window `[current-12, current)` (TV-OAC-BOUNDARY).
9. `delta_e = current_epoch - applied_input.last_updated_epoch` (C-SS-6 catch-up).
10. `m_one = compute_snapshot_magic(lamp_balance, lf_q, oac_q, profile)` (snapshot.ak:55).
11. `m_total = delta_e × m_one`.
12. Prune batches hết hạn: `prune_expired_batches(applied_input.magic_batches, current_epoch)` (snapshot.ak:152).
13. Nếu `|pruned_batches| < 32` và `m_total > 0`:
    - Tạo `new_batch = create_snapshot_batch(own_ref, next_batch_index, profile, m_total, current_epoch)` (snapshot.ak:111).
    - `expected_batches = pruned_batches ++ [new_batch]`.
    - `batch_added = True`.
14. Nếu không: `expected_batches = pruned_batches`, `batch_added = False` (C-SS-8 — generation LOST).
15. Prune stale activity: `prune_stale_activity(activity_state, current_epoch)` (lf_oac.ak:103) — thực hiện SAU khi tính OAC.
16. Xác nhận output datum field-by-field (A02). Xem §TECH.md §5 để biết danh sách đầy đủ.
17. `last_updated_epoch` trong output = `current_epoch` (kể cả khi SKIP — C-SS-8).
18. Attribution: nếu `batch_added`, tăng `total_events` và cập nhật `last_event_epoch` (C-ATT-2).

**Kết quả:** vault datum cập nhật với batch mới (hoặc không có batch), `last_updated_epoch` tiến lên.

---

### 3.2 Happy path — UpdateProfile

Owner muốn chuyển profile (Flame → Ember, v.v.):

1. Kiểm tra cooldown: `current_epoch - profile_changed_epoch >= 2` (C-PC-V2).
2. Kiểm tra `new_profile != profile` (C-PC-V3) — so sánh với `input_datum.profile` (profile hiện tại đang có hiệu lực), KHÔNG phải `pending_profile`.
3. Set `pending_profile = Some(PendingProfile { new_profile, effective_epoch: current_epoch + 1 })` (C-PC-V6 — lazy).
4. `profile` field trong output KHÔNG thay đổi (lazy apply).
5. `profile_changed_epoch = current_epoch`, `last_updated_epoch = current_epoch`.

Profile thực sự áp dụng ở tx tiếp theo (TriggerSnapshot hoặc redeemer khác) khi `apply_pending_profile` thấy `current_epoch >= effective_epoch`.

**Edge case — ghi đè pending (C-PC-V3 vs pending_profile):** Nếu đang có `pending_profile = Some(Ember)` và `profile = Flame`, user vẫn có thể gọi `UpdateProfile(Ember)` vì C-PC-V3 chỉ so sánh với `input_datum.profile` (= Flame ≠ Ember → pass). Kết quả: pending bị ghi đè với `effective_epoch` mới, kéo dài thêm 1 epoch. Đây không phải lỗ hổng bảo mật (không có lợi ích kinh tế) nhưng là hành vi không trực quan — user nên biết để tránh gọi UpdateProfile khi pending đang chờ cùng giá trị. Validator không chặn trường hợp này theo thiết kế.

**T4 — immutable:** Các batch đã tạo KHÔNG bị thay đổi profile khi pending fire. `profile_at_creation` đóng băng tại thời điểm tạo batch.

---

### 3.3 Happy path — WithdrawLamp

Owner rút LAMP không bị locked:

1. `amount > 0` (W-1), owner ký (W-2), `amount <= lamp_balance - lamp_locked` (W-3).
2. Tính `new_holdings = remove_newest_first(holdings, amount)` (lock.ak).
3. Output: `lamp_balance -= amount`, holdings giảm tương ứng.
4. `last_updated_epoch` KHÔNG thay đổi (bảo toàn catch-up window — vault.ak:307).
5. Verify vault output value chứa đúng `new_lamp_balance` LAMP (W-6).
6. `sum_holdings(output.loyalty_holdings) == output.lamp_balance` (W-7).

---

### 3.4 BurnBatch — bị khóa

`BurnBatch` redeemer → `fail "BurnBatch locked until v1.1"` (vault.ak:79). Không thể thực hiện ở v1.0.

---

### 3.5 Edge cases

| Tình huống | Hành vi |
|---|---|
| `m_total = 0` | SKIP: không tạo batch, `last_updated_epoch` vẫn cập nhật |
| `\|batches\| = 32` (vault full) | SKIP — C-SS-8: generation mất vĩnh viễn |
| Pending profile đến hạn cùng epoch snapshot | `apply_pending_profile` fire trước khi tính M; profile mới dùng cho cả catch-up |
| `delta_e > 1` (catch-up) | Một batch duy nhất với `m_total = delta_e × m_one` (không phải nhiều batch) |
| OAC với burn tại current epoch | Burn đó KHÔNG được tính (window `[current-12, current)`) |
| LF với holdings = 0 | Mặc định trả về Q (LF = 1.00) |
| `profile_changed_epoch = current` (cooldown = 0) | Không được đổi profile ngay lập tức; phải chờ thêm 2 epoch |

---

## 4. Invariants

| ID | Phát biểu | Nguồn |
|---|---|---|
| C-SS-1 | `current_epoch > last_updated_epoch` | vault.ak:108 |
| C-SS-2 | M được tính từ `lamp_balance` đầy đủ × 5 multiplier | snapshot.ak:55 |
| C-SS-3 | Batch source = `Snapshot`, decay_window = N(profile) | snapshot.ak:119-125 |
| C-SS-4 | `profile_at_creation = Some(profile)` đóng băng tại tạo batch | snapshot.ak:126 |
| C-SS-5 | `lamp_balance` = toàn bộ (kể cả locked), không dùng L_avail | vault.ak:127 |
| C-SS-6 | Catch-up: `delta_e × m_one`, một batch duy nhất | vault.ak:139 |
| C-SS-7 | `\|batches\| < 32` để tạo batch | snapshot.ak:103 |
| C-SS-8 | Nếu vault full hoặc M=0 → SKIP; `last_updated_epoch` vẫn cập nhật | vault.ak:156-158 |
| T4 | `profile_at_creation` bất biến trên batch đã tạo | types.ak:27 |
| T16 | SnapshotGen không sử dụng UM (UM-independent) | vault.ak comment:7 |
| C-VAULT-DS-1 | Đúng 1 vault input | vault.ak:116-118 |
| C-VAULT-OUT-1 | Đúng 1 vault output | vault.ak:241-245 |
| C-ATT-2 | `total_events` tăng 1 khi tạo batch | vault.ak:202-203 |
| W-3 | Chỉ rút LAMP không locked (`lamp_balance - lamp_locked`) | vault.ak:274 |
| W-7 | `sum_holdings == lamp_balance` sau rút | vault.ak:316 |
| C-PC-V2 | Cooldown đổi profile ≥ 2 epoch | vault.ak:342 |
| C-PC-V6 | Profile thay đổi lazy (pending, không trực tiếp) | vault.ak:365-373 |

---

## 5. Out-of-scope

- **BurnBatch / ConsumeMAGIC** — bị khóa ở v1.0, triển khai ở v1.1.
- **Keeper-triggered snapshot** — chỉ owner-triggered ở v1.0 (vault.ak comment:112).
- **UM reference input** — SnapshotGen chủ ý không dùng UM (T16).
- **Cross-vault interactions** — Mỗi vault độc lập.
- **Token hóa MAGIC** — MAGIC là số kế toán trong datum, không phải on-chain asset.
- **MintPolicy** — Không tồn tại cho MAGIC.
- **AutoBurn trong SnapshotGen** — AutoBurn chỉ dành cho ScheduleGen.
