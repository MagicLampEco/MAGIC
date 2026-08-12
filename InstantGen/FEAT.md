# InstantGen — Feature Specification
## GenMAGIC v3.3 · §9 InstantGen · v1.0

> ⚠ **ĐÃ LỖI THỜI ở phần cơ chế.** Tệp này còn mô tả mô hình trước PHA 2: "mua MAGIC
> bằng cách trả LAMP vào Treasury", redeemer mang `lamp_paid`, ràng buộc C-INST-1..4
> tính trên khoản chi, batch sống 2 epoch có halving ở `k=1`. **Không cái nào còn tồn
> tại.** Mô tả cơ chế hiện hành ở **[`DESIGN-PHASE2.md`](DESIGN-PHASE2.md)**; nguồn
> chân lý là [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](../SPEC/MagicLamp-Tripletoken-Feat-(Vi).md).
>
> **Gãy gì nếu dựng theo tệp này:** dựng một tx chuyển LAMP sang Treasury thì validator
> từ chối thẳng — I-ACT-7 ép `lamp_balance` / `lamp_locked` / `loyalty_holdings` giống
> hệt byte giữa datum vào và datum ra. Tính độ lớn theo `lamp_paid` cũng ra sai số:
> độ lớn nay tính từ MAGIC **đã tiêu thụ thật** (`consumed_credit`), không từ LAMP.
>
> Còn dùng được: định nghĩa MAGIC là số kế toán trong datum, vai trò UM và stale check
> C-UM-6, các trần cấu trúc (32 batch, 64 holding), và các ca biên double-satisfaction.

---

## 1. Mục đích

InstantGen cấp MAGIC ngay trong một giao dịch, dựa trên **MAGIC người dùng đã tiêu thụ
thật** (`consumed_credit`) chứ không phải trên một khoản LAMP trả đi. LAMP đứng yên
trong vault (I-ACT-7): nắm LAMP chỉ mở tư cách tham gia
(`lamp_balance ≥ min_instant_holding`), không phải giá phải trả. MAGIC không phải token —
là số kế toán trong `magic_batches[]` bên trong vault datum.

> Bản cũ của mục này viết "mua MAGIC ngay lập tức bằng cách trả LAMP vào Treasury".
> Sai mô hình: không có chân Treasury, không có khoản chi.

**Phân biệt với các cơ chế khác:**
- ScheduleGen (§11): forward contract, rate lock tại commit, 16-shard cap.
- InstantGen: on-demand, LAMP đứng yên, dùng UM với stale check C-UM-6.
- SnapshotGen (§8) / VacuumGen (§10): **đã chết**, nằm ở `Legacy/`. Đừng suy ra ràng
  buộc thiết kế nào từ hai cơ chế đó.

---

## 2. Actors

| Actor | Vai trò |
|---|---|
| Vault owner | Ký tx, nhận MagicBatch mới. **Không** chi LAMP — LAMP đứng yên (I-ACT-7) |
| UMKeeper | Quy trình nền cập nhật UM datum mỗi epoch (§14) |
| BackingBeacon (CARP) | Cấp `br_q` qua reference input để tính trần thặng dư (§6.3). Thiếu beacon ⟹ cửa Gen đóng |
| Cardano ledger | Đảm bảo eUTxO conservation |

> Dòng "Treasury (script) — nhận LAMP paid" đã bỏ: không handler nào chuyển LAMP nữa.

---

## 3. Happy path flow

```
User tx
  ├── Input:  vault UTxO (giữ LAMP + NFT danh tính vault, VaultDatum inline)
  ├── RefIn:  UM datum UTxO (UMDatum inline, ghim bằng um_nft_policy + um_script_hash)
  ├── RefIn:  BackingBeacon UTxO (br_q, ghim bằng backing_nft_policy + backing_script_hash)
  └── Output: vault UTxO (LAMP GIỮ NGUYÊN từng byte, magic_batches thêm batch mới,
              consumed_credit đặt về 0)
```

> Luồng cũ ghi thêm một `Output: treasury UTxO (nhận ≥ lamp_paid LAMP)` và "LAMP giảm
> lamp_paid". Dựng tx theo hình đó là tx bị từ chối.

**Bước chi tiết** (bước 5, 6, 9 dưới đây theo mô hình cũ — đã sai; xem chú thích cuối
danh sách)**:**
1. Validator đọc `current_epoch` từ `tx.validity_range.lower_bound` (POSIX ms / `ms_per_epoch`).
2. `apply_pending_profile(input_datum, current_epoch)` — nếu `pending_profile.effective_epoch ≤ current_epoch` thì switch profile, clear pending (`profile.ak:19`).
3. Kiểm tra C-INST-1..7 (xem mục 5).
4. Đọc UM datum qua reference input (NFT marker `um_nft_policy`, asset name `"UMD"=0x554d44`). Áp dụng C-UM-6 stale check → `um_q`.
5. Tính `expected_m = compute_instant_magic(lamp_paid, um_q, pm_q)` (`math.ak:55`).
6. `halve_then_prune(magic_batches, current_epoch)` — halve trước, prune sau (C-PRUNE-2).
7. Tạo `MagicBatch` mới: `source=Instant`, `created_epoch`, `initial_amount=current_amount=expected_m`, `decay_window=2`, `profile_at_creation=None` (C-DECAY-4), `halved=False`.
8. Kiểm tra output datum field-by-field (A02).
9. Kiểm tra Treasury nhận ≥ lamp_paid LAMP (`vault.ak:454`).

> **Ba bước trên đã sai mô hình.** PHA 2 thay: (5) độ lớn =
> `min( reward(consumed_credit), cap_surplus(br), 0.5 × pp_schedule )`, không đọc
> `lamp_paid`; (6) không halving — batch chỉ sống trong đúng `created_epoch`
> (`decay_window = 1`), phần chết bị `prune_expired` dọn; (9) không có chân Treasury —
> thay bằng khẳng định LAMP đứng yên và giá trị thật trong output khớp `lamp_balance`.
> Dựng tx theo bản cũ thì validator từ chối, không phải cảnh báo.

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
`prune_expired` áp dụng cho tất cả batch hiện có TRƯỚC khi thêm batch mới. Không có bước
halving: batch qua `created_epoch` là chết thẳng, giá trị coi như 0 (`decay_window = 1`,
§4.2). Bản cũ mô tả `halve_then_prune` và "batch k=1 bị halve lazy" — hàm đó đã gỡ khỏi
`decay.ak`; đợi một khoản halving là đợi thứ không đến, MAGIC hết hạn mất trắng.

### 4.6 Double-satisfaction (C-VAULT-DS-1)
Chỉ 1 vault input được phép. Count theo address match. Nếu 2 vault UTxO cùng tx → từng UTxO sẽ verify, cộng lại vi phạm single-input guard.

### 4.7 Phantom output
`find_vault_output` count output cùng address == 1 (`vault.ak:315`). Chặn tx cố ý tạo 2 output vault.

---

## 5. Constraint list

> **Bảng này là ảnh chụp mô hình cũ.** Số dòng `vault.ak:NNN` đã trôi và bốn dòng đầu nói
> về một khoản chi LAMP không còn tồn tại. Danh sách ràng buộc đang chạy đọc thẳng ở
> `InstantGen/onchain/validators/vault.ak`; diễn giải ở
> [`DESIGN-PHASE2.md`](DESIGN-PHASE2.md) §2–§4.

| Mã | Nguồn code | Mô tả |
|---|---|---|
| ~~C-INST-1~~ | — | cũ: `lamp_paid >= 10_000_000`. Nay là ngưỡng trên **số dư**: `lamp_balance ≥ min_instant_holding` |
| ~~C-INST-2~~ | — | cũ: trần `lamp_paid`. Nay trần nằm ở `min(reward, cap_surplus, ½·pp_schedule)` |
| ~~C-INST-3~~ | — | cũ: `lamp_paid ≤ L_avail`. Nay: `L_avail ≥ min_instant_holding` — LAMP khoá hết vào ScheduleGen thì không đồng thời đủ tư cách Instant |
| ~~C-INST-4~~ | — | **đã chết** — không có Treasury, không handler nào chuyển LAMP (I-ACT-7) |
| C-INST-5 | `vault.ak:170` | `expected_m > 0` |
| C-INST-6 | `vault.ak:178` | Batch mới: `halved=False`, `source=Instant`, `profile_at_creation=None` |
| C-INST-7 | `vault.ak:155` | Active batches trước tx < 32 |
| C-INST-10 | — | cũ: LAMP bảo toàn qua eUTxO + kiểm Treasury. Nay mạnh hơn: LAMP **bất động**, giá trị thật trong output phải khớp `lamp_balance` |
| C-UM-6 | `vault.ak:163`, `um.ak:22` | Stale > 1 epoch → fallback 0.5× |
| C-DECAY-4 | `vault.ak:187` | `profile_at_creation=None` cho Instant |
| C-PRUNE-1 | `decay.ak:52` | Output không chứa expired batches |
| ~~C-PRUNE-2~~ | — | **đã chết** — không còn halving, nên không còn thứ tự "halve trước prune" |
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

- **BurnBatch** — mục này đã cũ: `BurnBatch` nay sống, ở constr 2, và còn cộng `Σburns`
  vào `consumed_credit`. Trạng thái module: [`DevStatus.md`](../DevStatus.md).
- **ApplyHalving standalone** — **đã chết**. Slot constr 1 nay là `PruneExpired` (§7.4).
- **UM smoothing logic** — thuộc UMKeeper (§14), không phải InstantGen.
- **VacuumGen / ScheduleGen UM path** — C-UM-7 (không stale check), separate module.
- **Governance / voting** — ngoài scope protocol.
- **Testnet deploy scripts** — xem `scripts/` top-level.
