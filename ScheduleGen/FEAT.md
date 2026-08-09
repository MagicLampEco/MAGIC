# FEAT.md — ScheduleGen Feature Specification
## GenMAGIC v3.3 · §11 ScheduleGen · Cardano Preview Testnet

> ⚠ **PHA 2 — I-ACT-7: LAMP ĐỨNG YÊN.** `ScheduleFire` chỉ **giải phóng khoá**:
> `lamp_balance` và LAMP thật trong vault UTxO bất biến qua một fire; `lamp_locked` giảm
> `fires × λ`, holding tương ứng lật `is_locked = False`. **Không có Treasury** trong luồng
> này — apply-param `treasury_addr` đã xoá, không handler nào chuyển LAMP nữa. Off-chain
> dựng thêm output Treasury theo bản cũ là tx bị từ chối. Xem [`README.md`](./README.md).

---

## 1. Mục đích

ScheduleGen là cơ chế sinh MAGIC theo hợp đồng kỳ hạn (forward contract). Người dùng cam kết trước một lượng LAMP (`L × λ`), khóa nó vào vault, nhận lại MAGIC dần đều theo từng epoch. Tỷ lệ sinh (`rate_locked_q`) được cố định ngay tại thời điểm commit — không bao giờ thay đổi dù DAO nâng hay hạ `R_snap` sau đó (T8).

Hai đặc điểm phân biệt với ba cơ chế kia:
- **Rate lock (T8):** Bảo vệ người cam kết khỏi biến động governance. Phần thưởng tương lai được đảm bảo tại thời điểm ký.
- **Permissionless fire (C-SCH-FIRE-PERMISSION):** Bất kỳ keeper nào cũng có thể kích hoạt fire — người dùng không cần online sau commit.

---

## 2. Actors

| Actor | Vai trò |
|---|---|
| **Owner (vault owner)** | Ký ScheduleCommit tx, chọn L và λ, nạp LAMP vào vault trước |
| **Keeper / Bất kỳ ai** | Submit ScheduleFire tx — permissionless, không cần chữ ký owner |
| **Shard UTxO** | 16 UTxO aggregate theo `shard_id = blake2b256(owner)[0] % 16`; giới hạn tham gia của từng shard |

---

## 3. Flows

### 3.1 Happy path — Commit

1. Owner đã có LAMP trong vault (`lamp_balance ≥ L × λ`, `l_avail ≥ L × λ`).
2. Owner gọi `buildScheduleCommitTx(L, λ)`:
   - Tính `s_q = computeSQ(L)`, `rate_locked_q = ⌊R_snap × S_Q / Q⌋`, `M_i = ⌊λ × rate_locked_q / Q⌋`.
   - Kiểm tra C-SCH-RATE: `λ × rate_locked_q ≥ Q` (đảm bảo `M_i ≥ 1`).
   - Kiểm tra C-SCH-CAP: `shard_locked + L×λ ≤ shard_cap`.
   - Tạo `GenSchedule` với `fired_count=0`, `rate_locked_q` immutable.
   - `select_lamp_for_lock` khóa youngest-first (T5).
   - Output vault datum: `lamp_locked += L×λ`, append `gen_schedules`.
   - Output shard datum: `shard_locked += L×λ`, `shard_active_count += 1`.
3. Owner ký, submit. `start_fire_epoch = commit_epoch + 2`.

### 3.2 Happy path — Fire (catch-up)

1. Keeper kiểm tra: `current_epoch ≥ start_fire_epoch + fired_count` (C-FIRE-1 ≥).
2. Keeper gọi `buildScheduleFireTx(scheduleId)`:
   - Đếm `fires_in_tx = min(eligible_by_time, 8, batch_budget, remaining)`.
   - Đọc `rate_locked_q` từ datum — KHÔNG recompute (T8).
   - Tính `lamp_released = fires_in_tx × λ` — lượng LAMP **rời khỏi hồ khoá**, không rời vault.
   - Tạo `fires_in_tx` `MagicBatch` mới, mỗi batch `initial_amount = M_i`.
   - Giải phóng khoá: `lamp_locked -= lamp_released`, holding tương ứng lật `is_locked = False`.
     `lamp_balance` và LAMP thật trong output **giữ nguyên** (I-ACT-7). KHÔNG dựng output Treasury.
   - Cập nhật shard: `shard_locked -= lamp_released`, `shard_cumulative_fired += lamp_released`.
   - Khi `fired_count == L`: xóa schedule khỏi danh sách (C-FIRE-5).
3. Keeper submit — KHÔNG cần chữ ký owner (C-SCH-FIRE-PERMISSION).

### 3.3 Edge cases

| Trường hợp | Xử lý |
|---|---|
| Bỏ lỡ nhiều epoch | C-FIRE-1 ≥: bắt kịp tối đa 8 orders/tx; gọi lại cho đến hết |
| `|magic_batches|` sắp vượt 32 | `fires_in_tx` bị cap bởi `batch_budget = 32 - current_batches` |
| DAO nâng `R_snap` sau commit | Không ảnh hưởng — validator đọc stored `rate_locked_q` (T8) |
| Shard cap đầy | Commit mới bị reject; schedules hiện tại vẫn fire bình thường |
| Schedule hoàn thành (`fired_count == L`) | Xóa khỏi `gen_schedules` (C-FIRE-5); shard `active_count -= 1` |
| Vault output = 2 | Validator fail (C-VAULT-OUT-1: đúng 1 output tại `vault_addr`) |
| Double-spend vault | Validator fail (C-VAULT-DS-1: đúng 1 input tại `vault_addr`) |
| Tx fire rút LAMP ra khỏi vault output | Validator fail — `lamp_balance` phải bất biến qua fire (I-ACT-7) |
| BurnBatch redeemer | Fail cứng ("BurnBatch locked until v1.1") |

---

## 4. Invariants (enforced on-chain)

| ID | Phát biểu | Nguồn |
|---|---|---|
| C-SCH-1 | `L ∈ [10, 200]` | `vault.ak:149` |
| C-SCH-2 | `λ ≥ 1_000_000 oildrop (1 LAMP)` | `vault.ak:152` |
| C-SCH-3 | `L × λ ≤ l_avail` | `vault.ak:155-157` |
| C-SCH-RATE | `λ × rate_locked_q ≥ Q → M_i ≥ 1` | `vault.ak:168`, `math.ak:87-89` |
| C-SCH-CAP | `shard_locked + L×λ ≤ shard_cap` | `vault.ak:173`, `shard validator:109` |
| C-SCH-10 | `|gen_schedules| < 20` | `vault.ak:160` |
| C-SCH-7 | `start_fire_epoch = commit_epoch + 2` | `vault.ak:181` |
| T8 | `rate_locked_q` không thay đổi sau commit | `vault.ak:184`, `types.ak:58` |
| C-FIRE-1 | `fires_in_tx > 0`, `e_i ≤ current_epoch` | `vault.ak:233,240` |
| C-FIRE-3 | Kế toán atomic; `lamp_balance` bất biến, `lamp_locked` giảm `fires × λ` | `validate_fire` |
| C-FIRE-5 | Schedule bị xóa khi `fired_count == L` | `vault.ak:256-259` |
| C-FIRE-6 | `loyalty_holdings` chỉ lật `is_locked`, `amount` giữ nguyên | `validate_fire` |
| C-SCH-FIRE-PERMISSION | Không yêu cầu chữ ký owner khi fire | `vault.ak:223-224` |
| C-SCH-FIRE-SHARD | Đúng shard UTxO được spend theo `blake2b256(owner)[0] % 16` | `vault.ak:271-273` |
| C-VAULT-DS-1 | Đúng 1 vault input | `vault.ak:62` |
| C-VAULT-OUT-1 | Đúng 1 vault output | `vault.ak:388-389` |
| MAX_FIRES_PER_TX_CATCHUP | `fires_in_tx ≤ 8` | `vault.ak:303`, `constants.ak:34` |
| MAX_BATCHES_PER_VAULT | `|magic_batches| ≤ 32` | `vault.ak:251` |

---

## 5. Out-of-scope

- **Cancel/refund:** Không tồn tại trong ScheduleGen (T10). LAMP bị khoá cho tới khi từng đơn fire giải phóng dần — nó **không rời vault** đi đâu cả (I-ACT-7). Chủ vault rút phần đã mở khoá bằng `WithdrawLamp`.
- **UM (Network Demand Multiplier):** ScheduleGen không dùng UM. Rate được lock tại commit từ `R_snap × S(L)`. Chỉ InstantGen dùng UM với stale check.
- **Token MAGIC:** MAGIC là số kế toán trong `magic_batches[]`. Không có MintPolicy. Không token-hóa.
- **BurnBatch:** Locked until v1.1 (`vault.ak:76-81`).
- **ProfileChange/cooldown:** Không ảnh hưởng ScheduleGen. `profile_at_creation = None` cho Schedule batches.
- **Auto-burn:** `auto_burn_target` field có trong datum nhưng chưa được xử lý trong v1.0.
- **Cross-vault schedules:** Mỗi schedule gắn với đúng 1 vault.
