# InstantGen — Feature Specification
## GenMAGIC v3.3 · §9 InstantGen · v1.0

---

## 1. Mục đích

InstantGen cho phép người dùng mua MAGIC ngay lập tức bằng cách trả LAMP vào Treasury. Đây là cơ chế duy nhất trong bốn cơ chế có thanh toán LAMP tức thời (không delay). MAGIC không phải token — là số kế toán trong `magic_batches[]` bên trong vault datum.

**Phân biệt với các cơ chế khác:**
- SnapshotGen (§8): tự động mỗi epoch, KHÔNG tốn LAMP, KHÔNG dùng UM.
- VacuumGen (§10): 2-phase commit-then-fire, delay 2 epoch, dùng smoothed UM mà không stale check.
- ScheduleGen (§11): forward contract, rate lock tại commit, 16-shard cap.
- InstantGen: on-demand, trả LAMP ngay, dùng UM với stale check C-UM-6.

---

## 2. Actors

| Actor | Vai trò |
|---|---|
| Vault owner | Ký tx, cung cấp LAMP từ vault, nhận MagicBatch mới |
| UMKeeper | Quy trình nền cập nhật UM datum mỗi epoch (§14) |
| Treasury (script) | Nhận LAMP paid — bắt buộc là Script address, không phải wallet |
| Cardano ledger | Đảm bảo eUTxO conservation (C-INST-10) |

---

## 3. Happy path flow

```
User tx
  ├── Input:  vault UTxO (owns LAMP, VaultDatum inline)
  ├── RefIn:  UM datum UTxO (carries UMDatum inline, identified by um_nft_policy)
  ├── Output: vault UTxO (LAMP giảm lamp_paid, magic_batches mới)
  └── Output: treasury UTxO (nhận ≥ lamp_paid LAMP)
```

**Bước chi tiết:**
1. Validator đọc `current_epoch` từ `tx.validity_range.lower_bound` (POSIX ms / `ms_per_epoch`).
2. `apply_pending_profile(input_datum, current_epoch)` — nếu `pending_profile.effective_epoch ≤ current_epoch` thì switch profile, clear pending (`profile.ak:19`).
3. Kiểm tra C-INST-1..7 (xem mục 5).
4. Đọc UM datum qua reference input (NFT marker `um_nft_policy`, asset name `"UMD"=0x554d44`). Áp dụng C-UM-6 stale check → `um_q`.
5. Tính `expected_m = compute_instant_magic(lamp_paid, um_q, pm_q)` (`math.ak:55`).
6. `halve_then_prune(magic_batches, current_epoch)` — halve trước, prune sau (C-PRUNE-2).
7. Tạo `MagicBatch` mới: `source=Instant`, `created_epoch`, `initial_amount=current_amount=expected_m`, `decay_window=2`, `profile_at_creation=None` (C-DECAY-4), `halved=False`.
8. Kiểm tra output datum field-by-field (A02).
9. Kiểm tra Treasury nhận ≥ lamp_paid LAMP (`vault.ak:454`).

---

## 4. Edge cases và invariants

### 4.1 UM stale (C-UM-6)
Nếu `current_epoch - um.last_updated_epoch > 1` → `um_q = UM_FALLBACK_Q = 500_000_000` (0.5×). Không reject tx — fallback là biện pháp kinh tế, không hard-block.

### 4.2 Profile change pending
Nếu `pending_profile != None` và `current_epoch >= effective_epoch`: validator tự apply profile mới trước khi tính M. Output datum phải reflect trạng thái đã apply (profile mới, pending_profile=None).

### 4.3 Vault đầy (C-INST-7)
Nếu số active batches (non-expired trước tx) = 32 → reject. User phải BurnBatch trước. BurnBatch hiện bị lock đến v1.1.

### 4.4 LAMP locked (C-INST-3)
Chỉ `L_avail = lamp_balance - lamp_locked` có thể dùng. LAMP đang lock (VacuumGen/ScheduleGen) không được tính.

### 4.5 Prune trong cùng tx
`halve_then_prune` áp dụng cho tất cả batches hiện có TRƯỚC khi append batch mới. Batch k=1 chưa halve sẽ bị halve trong cùng tx (lazy).

### 4.6 Double-satisfaction (C-VAULT-DS-1)
Chỉ 1 vault input được phép. Count theo address match. Nếu 2 vault UTxO cùng tx → từng UTxO sẽ verify, cộng lại vi phạm single-input guard.

### 4.7 Phantom output
`find_vault_output` count output cùng address == 1 (`vault.ak:315`). Chặn tx cố ý tạo 2 output vault.

---

## 5. Constraint list

| Mã | Nguồn code | Mô tả |
|---|---|---|
| C-INST-1 | `vault.ak:145` | `lamp_paid >= 10_000_000` (10 LAMP) |
| C-INST-2 | `vault.ak:148` | `lamp_paid <= 10_000_000_000_000` (10^13 oildrop) |
| C-INST-3 | `vault.ak:151` | `lamp_paid <= L_avail` |
| C-INST-4 | `vault.ak:199` | Treasury nhận ≥ lamp_paid LAMP; Treasury phải là Script address |
| C-INST-5 | `vault.ak:170` | `expected_m > 0` |
| C-INST-6 | `vault.ak:178` | Batch mới: `halved=False`, `source=Instant`, `profile_at_creation=None` |
| C-INST-7 | `vault.ak:155` | Active batches trước tx < 32 |
| C-INST-10 | `vault.ak:251` | LAMP supply bảo toàn (eUTxO + treasury check) |
| C-UM-6 | `vault.ak:163`, `um.ak:22` | Stale > 1 epoch → fallback 0.5× |
| C-DECAY-4 | `vault.ak:187` | `profile_at_creation=None` cho Instant |
| C-PRUNE-1 | `decay.ak:52` | Output không chứa expired batches |
| C-PRUNE-2 | `decay.ak:62` | Halving trước prune |
| C-VAULT-DS-1 | `vault.ak:130` | Exactly 1 vault input |
| C-VAULT-1 | `vault.ak:237` | `|magic_batches| ≤ 32` |
| C-VAULT-3 | `vault.ak:241` | `next_batch_index` tăng đúng 1 |
| C-VAULT-8 | `vault.ak:228` | `lamp_locked ≤ lamp_balance` |
| C-VAULT-10 | `vault.ak:225` | `Σholdings.amount == lamp_balance` |
| C-VAULT-13 | `vault.ak:231` | `|loyalty_holdings| ≤ 64` |
| A02 | `vault.ak:203` | Output datum field-by-field equality |
| C-ATT-1/2 | `vault.ak:248` | `total_events++`, `last_event_epoch = current_epoch` |

---

## 6. Out-of-scope (v1.0)

- **BurnBatch** — locked đến v1.1 (`vault.ak:93`). ConsumeMAGIC chưa implement.
- **ApplyHalving standalone** — chỉ owner-sign stub (`vault.ak:83`). Halving áp dụng lazily trong mọi tx có `halve_then_prune`.
- **UM smoothing logic** — thuộc UMKeeper (§14), không phải InstantGen.
- **VacuumGen / ScheduleGen UM path** — C-UM-7 (không stale check), separate module.
- **Governance / voting** — ngoài scope protocol.
- **Testnet deploy scripts** — xem `scripts/` top-level.
