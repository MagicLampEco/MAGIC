# VacuumGen — Feature Specification
## GenMAGIC v3.3 · §10 VacuumGen

---

## 1. Mục đích

VacuumGen là cơ chế tạo MAGIC theo mô hình **two-phase commit-then-fire** (cam kết trước, kích hoạt sau 2 epoch). Người dùng khóa LAMP tại commit; keeper (hoặc bất kỳ ai) kích hoạt fire đúng epoch. Mục tiêu:

- **Chống griefing**: sau khi commit, LAMP không thể rút lại. Attacker không thể lợi dụng cửa sổ phí thấp rồi huỷ.
- **Permissionless fire**: user có thể mất key sau commit mà không bị kẹt LAMP vĩnh viễn.
- **UM smoothed, không stale check**: fire_epoch cố định trước → người dùng không chọn được thời điểm → phạt stale sẽ bất công (C-UM-7).

---

## 2. Actors

| Actor | Vai trò |
|---|---|
| **Owner** | Chủ vault — ký VacuumCommit; không cần ký VacuumFire |
| **Keeper** | Bot monitor epoch và submit VacuumFire đúng lúc |
| **Anyone** | Bất kỳ ví nào đều có thể submit VacuumFire (C-VAC-FIRE-PERMISSION) |
| **Treasury** | Địa chỉ script nhận LAMP tại fire (INV-43) |
| **UMKeeper** | Cập nhật UMDatum mỗi epoch; VacuumFire đọc qua reference input |
| **Consume-delegate** (`personal_delegate`) | Bên thứ ba (paymaster) được owner uỷ quyền kích hoạt BurnBatch — tiêu MAGIC thay owner. Owner đặt/xoá qua SetDelegate |
| **ConsumeMAGIC validator** | Validator engagement co-spend cưỡng chế `Σ burns == required` theo PriceParam beacon (ngoài module này) |

---

## 3. Happy Path Flows

### 3.1 Phase 1 — VacuumCommit

1. Owner chọn `lambda` (oil) sao cho `lambda >= 1 LAMP` (C-VAC-3) và `lambda <= L_avail` (C-VAC-2).
2. Kiểm tra `|vacuum_orders| < 10` (C-VAC-5).
3. Tính `order_id = blake2b256(own_ref ∥ commit_epoch ∥ lambda)`.
4. Tính `fire_epoch = commit_epoch + 2` (C-VAC-4, `vacuum_delay = 2`).
5. Gọi `select_lamp_for_lock(holdings, lambda)` — khóa youngest-first (T5).
6. Ghi VacuumOrder mới vào `vacuum_orders` (append).
7. Cập nhật datum: `lamp_locked += lambda`, `last_updated_epoch = commit_epoch`.
8. Submit tx có chữ ký owner (C-VAC-1). LAMP vẫn ở vault (không transfer).

### 3.2 Phase 2 — VacuumFire

1. Keeper/anyone tìm order theo `order_id`.
2. Kiểm tra `current_epoch == order.fire_epoch` (C-VAC-6 — EXACT match).
3. Đọc UMDatum qua reference input; lấy `um_q = um.smoothed_q` (C-UM-7).
4. Tính `sm_q = compute_sm_q(streak_state)`.
5. Prune expired batches trước (C-VAC-PRUNE): giữ `b` nếu `current_epoch - b.created_epoch < b.decay_window`.
6. Nếu `|pruned_batches| < 32`: tính `M_v = compute_vacuum_magic(lambda, um_q, sm_q)`, tạo MagicBatch mới.
7. Nếu vault đầy sau prune: M=0, không tạo batch (C-VAC-FIRE-FULL-VAULT), nhưng LAMP vẫn chuyển (INV-43).
8. Gọi `remove_locked_amount(holdings, lambda)` — unlock oldest-first.
9. Cập nhật datum: `lamp_balance -= lambda`, `lamp_locked -= lambda`, xoá order, cập nhật batches.
10. Transfer `lambda` LAMP sang Treasury (INV-43, C-VAC-7).
11. Submit tx **không có** chữ ký owner (C-VAC-FIRE-PERMISSION).

### 3.3 WithdrawLamp

Owner rút LAMP chưa khóa bất kỳ lúc nào (W-1..W-7). `last_updated_epoch` không đổi để không reset cửa sổ Snapshot catch-up.

### 3.4 BurnBatch — tiêu MAGIC (datum-consume)

MAGIC là số kế toán trong `magic_batches`; tiêu MAGIC = hạ `current_amount`.

1. Owner HOẶC `personal_delegate` ký (auth).
2. Prune batch hết hạn trước (cliff), rồi áp từng `(batch_id, amount)`: trừ tại chỗ, prune batch về 0.
3. `attribution.total_events += 1`, `last_event_epoch = current_epoch`.
4. LAMP KHÔNG đổi (chỉ chạm magic_batches).
5. Coupling giá (`Σ burns == required`) do validator ConsumeMAGIC co-spend cưỡng chế qua PriceParam beacon. Handler vault chỉ đảm bảo phép trừ đúng + bảo toàn value + auth.

### 3.5 SetDelegate — đặt/xoá consume-delegate

Owner (chỉ owner) ký, đặt `personal_delegate = new_delegate` (`None` = chỉ owner, `Some(d)` = owner hoặc d). Mọi field khác bất biến. Không cooldown.

---

## 4. Edge Cases (MECE)

| Trường hợp | Xử lý |
|---|---|
| Fire sớm hơn 1 epoch | Reject: `current_epoch < fire_epoch` (C-VAC-6) |
| Fire muộn hơn 1 epoch | Reject: `current_epoch > fire_epoch` (C-VAC-6) |
| Vault đầy (32 batch) sau prune | M=0, tạo event `VacuumFiredZeroMagic`; LAMP vẫn chuyển (INV-43) |
| UM ngoài `[0.5, 2.0]` | Reject: `validate_um_range` fail |
| `lambda < 1 LAMP` | Reject C-VAC-3 |
| `lambda > L_avail` | Reject C-VAC-2 |
| `|orders| >= 10` | Reject C-VAC-5 |
| 2+ vault inputs | Reject C-VAULT-DS-1 |
| 2+ vault outputs | Reject C-VAULT-OUT-1 |
| Thử huỷ order | Không có redeemer Cancel → validator `fail` catch-all |
| Key mất sau commit | Fire vẫn thực hiện được — permissionless |
| Datum mismatch (tamper) | Từng field được kiểm tra riêng trong A02 ở MỌI redeemer (VacuumCommit, VacuumFire, WithdrawLamp, BurnBatch, SetDelegate) — bao gồm `activity_state`, `attribution`, `personal_delegate` |
| Withdrawal tăng last_updated_epoch | Reject W-5 |
| Withdrawal của LAMP đang locked | Reject W-3: `amount > L_avail` |
| BurnBatch không có owner/delegate ký | Reject (AUTH) |
| BurnBatch over-burn (`amount > current_amount`) | Reject (`apply_burns`) |
| BurnBatch batch_id không tồn tại / trùng | Reject (count khớp == 1) |
| BurnBatch rỗng (`burns == []`) | Reject (no-op vô nghĩa) |
| BurnBatch đụng LAMP / siphon LAMP | Reject (value-leak guard + `lamp_balance` bất biến) |
| SetDelegate do delegate (không phải owner) ký | Reject (chỉ owner) |
| SetDelegate output delegate ≠ redeemer | Reject (A02) |
| Tx span nhiều epoch / upper-bound mở | Reject `get_current_epoch` (cả 2 biên Finite + `lo/ms == hi/ms`) — chống validity-range gaming |
| UM ref input giả mạo (NFT đúng, sai script) | Reject `find_um_datum` (ghim `Script(um_script_hash)`) |

---

## 5. Invariants (Protocol-level)

| ID | Phát biểu |
|---|---|
| C-VAC-1 | VacuumCommit phải có chữ ký owner |
| C-VAC-2 | `lambda <= L_avail` tại commit |
| C-VAC-3 | `lambda >= 1_000_000 oil` (1 LAMP) |
| C-VAC-4 | `fire_epoch = commit_epoch + 2` (cố định, không thay đổi) |
| C-VAC-5 | `|vacuum_orders| < MAX_VACUUM_ORDERS (10)` trước khi thêm |
| C-VAC-6 | VacuumFire phải submit đúng `fire_epoch` (EXACT, không ≥) |
| C-VAC-7 | LAMP luôn chuyển sang Treasury tại fire |
| C-VAC-12 | Không có redeemer Cancel — commit không thể huỷ |
| C-VAC-FIRE-PERMISSION | VacuumFire không yêu cầu chữ ký owner |
| C-VAC-PRUNE | Prune expired batches trước khi kiểm tra vault đầy |
| C-VAC-FIRE-FULL-VAULT | Vault đầy sau prune → M=0; LAMP vẫn chuyển |
| C-UM-7 | VacuumFire dùng `um.smoothed_q`, không có stale check |
| INV-43 | LAMP transfer xảy ra kể cả khi M=0 |
| C-VAULT-DS-1 | Đúng 1 vault input / tx |
| C-VAULT-OUT-1 | Đúng 1 vault output / tx |
| C-VAULT-9 | `lamp_locked == sum_locked(holdings)` — enforce tại VacuumCommit (dòng 137-139); không enforce tại VacuumFire (lamp_locked thay đổi đúng bởi các check tường minh trên từng field) |
| C-VAULT-10 | `sum_holdings(holdings) == lamp_balance` |
| C-VAC-BURN-1 | BurnBatch: auth = owner HOẶC `personal_delegate`; `burns` không rỗng; mỗi burn `0 < amount ≤ current_amount`, đúng 1 batch khớp `batch_id` |
| C-VAC-BURN-2 | BurnBatch: chỉ `magic_batches` + `last_updated_epoch` + `attribution` đổi; LAMP bất biến; `attribution.total_events += 1` |
| C-VAC-BURN-3 | Coupling giá (`Σ burns == required`) cưỡng chế bởi ConsumeMAGIC co-spend (PriceParam beacon) — cross-module |
| C-VAC-DELEG-1 | SetDelegate: chỉ owner đổi `personal_delegate`; mọi field khác bất biến; không cooldown |
| C-VAC-EPOCH-1 | `get_current_epoch`: cả 2 biên validity_range Finite VÀ `lo/ms == hi/ms` (tx trọn 1 epoch) — chống validity-range gaming, bảo vệ EXACT C-VAC-6 + stamp epoch |
| C-UM-SCRIPT | `find_um_datum` ghim UM ref input về `Script(um_script_hash)` ngoài UM NFT — chống UM giả mạo |
| T5 | Lock youngest-first tại commit → free = oldest → LF(free) tối đa |
| P8 | Aiken ↔ TypeScript bit-identical cho cùng input |

---

## 6. Out of Scope

- **Cancel order sau commit** — không có và không được thêm (C-VAC-12).
- **Profile Multiplier (PM)** — VacuumGen không dùng PM (§6.10 M_vacuum chain).
- **Loyalty Factor (LF)** — không áp dụng cho VacuumGen.
- **UM staleness fallback** — VacuumGen không có, chỉ dùng smoothed (C-UM-7).
- **Catch-up fire (≥ fire_epoch)** — VacuumGen dùng EXACT match; chỉ ScheduleGen mới dùng ≥ (C-FIRE-1).
- **Partial fire** — mỗi order fired toàn bộ lambda, không chia nhỏ.
- **Token MAGIC on-chain** — MAGIC là số kế toán trong datum, không phải token.
