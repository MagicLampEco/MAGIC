# ApplyHalving Spec — InstantGen vault

**Version:** v1.1
**Status:** Implemented + aiken check 20/20 PASS
**Scope:** InstantGen module only. SnapshotGen/VacuumGen/ScheduleGen không có Instant batches và không có ApplyHalving redeemer.

---

## FEAT.md — Mục đích, Actors, Flows, Invariants

### Mục đích

`ApplyHalving` là redeemer độc lập cho phép bất kỳ ai (permissionless) gọi một tx để:

1. Áp dụng `pending_profile` đang chờ (nếu `current_epoch >= pending.effective_epoch`) — cùng cơ chế lazy-apply như mọi handler khác (SPEC_V1 §2).
2. Halve tất cả Instant batch đang ở tuổi `k=1` (age = 1 epoch) có `halved=False` → `current_amount = ⌊current_amount / 2⌋`, `halved = True` (C-DECAY-7).
3. Prune tất cả batch đã hết hạn (`k ≥ decay_window`) — C-PRUNE-1.

Không tạo batch mới, không chuyển LAMP, không cần chữ ký owner.

**Tại sao cần redeemer riêng?**

Halving Instant batch xảy ra ở epoch `created_epoch + 1`. Nếu user không phát giao dịch nào trong epoch đó (không InstantGen, không WithdrawLamp), batch ở lại vault với `halved=False`. ApplyHalving cho phép bất kỳ keeper nào đẩy trạng thái mà không cần owner online.

### Actors

| Actor | Vai trò |
|---|---|
| Owner | Có thể gọi (không bắt buộc) |
| Keeper / bất kỳ bên thứ ba | Có thể gọi — permissionless |

### Flows

**Happy path — batch cần halve:**
1. Caller xây tx với validity_range lower_bound = `(created_epoch + 1) × ms_per_epoch`.
2. Validator xác nhận: chỉ 1 vault input, gọi `apply_pending_profile`, gọi `halve_then_prune`.
3. Output datum: batches đã halve+prune, `last_updated_epoch = current_epoch`, mọi field LAMP không đổi.

**Happy path — không có batch cần halve (k=0 hoặc k≥2):**
1. Tx hợp lệ — `halve_then_prune` không thay đổi batch (k=0) hoặc chỉ prune (k≥2).
2. Output datum: batches tương ứng, `last_updated_epoch = current_epoch`.

**Happy path — pending_profile fires cùng lúc:**
1. `current_epoch >= pending.effective_epoch` → `apply_pending_profile` trả datum với `profile = new_profile`, `pending_profile = None`.
2. Output datum phản ánh profile mới, pending đã xóa.

**Edge cases:**

| Trường hợp | Kết quả |
|---|---|
| Vault không có batch nào | Hợp lệ — output giống input (+ `last_updated_epoch`) |
| Batch đã `halved=True` tại k=1 | Không halve lại — `should_halve` trả False |
| Nhiều batch, một số k=1, một số k=0, một số k≥2 | Chỉ k=1 halve; k=0 giữ nguyên; k≥2 bị prune |
| Không có pending_profile | `apply_pending_profile` trả datum không đổi |
| Caller không sign | Hợp lệ — permissionless |
| 2 vault input cùng địa chỉ | Reject H-1 |

### Invariants

| ID | Phát biểu |
|---|---|
| H-1 | Đúng 1 vault input (C-VAULT-DS-1) |
| H-2 | `apply_pending_profile` được gọi trước mọi tính toán |
| H-3 | `output.magic_batches == halve_then_prune(applied_input.magic_batches, current_epoch)` |
| H-4 | `lamp_balance`, `lamp_locked`, `loyalty_holdings` không thay đổi |
| H-5 | Permissionless — không cần owner signature |
| H-6 | `output.last_updated_epoch == current_epoch` |
| H-7 | Tất cả field khác (`vacuum_orders`, `gen_schedules`, `delegation_cert`, `attribution`, v.v.) không thay đổi so với `applied_input` |

### Out-of-scope

- SnapshotGen / VacuumGen / ScheduleGen không có Instant batch, không triển khai ApplyHalving.
- Halving batch của nguồn khác (Snapshot, Vacuum, Schedule) — không có theo protocol (chỉ Instant batch có `halved` flag, C-DECAY-6).
- Tính toán MAGIC mới — ApplyHalving không phát sinh batch mới.
- BurnBatch / ConsumeMAGIC — scope v1.1 riêng.

---

## MATH.md — Định nghĩa chính thức, Công thức, Test vectors

### Định nghĩa

```
k(batch, epoch) := epoch - batch.created_epoch          -- tuổi batch
should_halve(b, e) := b.source == Instant ∧ k(b,e) == 1 ∧ ¬b.halved
is_expired(b, e)   := k(b, e) ≥ b.decay_window          -- decay_window = 2 cho Instant

apply_halving(b) := MagicBatch {
  ..b,
  current_amount: ⌊b.current_amount / 2⌋,   -- floor division
  halved:         True,
}

apply_halving_all(batches, e) :=
  map(batches, fn(b) → if should_halve(b,e) then apply_halving(b) else b)

prune_expired(batches, e) :=
  filter(batches, fn(b) → ¬is_expired(b, e))

halve_then_prune(batches, e) :=
  prune_expired(apply_halving_all(batches, e), e)   -- C-PRUNE-2: halve trước prune
```

### Boundary conditions

| k | should_halve | is_expired | Hành động |
|---|---|---|---|
| 0 | False | False | Giữ nguyên |
| 1, halved=False | True | False | Halve |
| 1, halved=True | False | False | Giữ nguyên (đã halve rồi) |
| 2 | False | True | Prune |

Với `decay_window = 2` (Instant batch), một batch chỉ tồn tại tối đa 2 epoch (k=0, k=1), bị prune tại k=2.

### Test vectors (verifiable)

**TV-AH-01:** Batch k=1, amount=1000

```
Input:  batch = { created_epoch: 9, current_amount: 1000, halved: False, source: Instant, decay_window: 2 }
        current_epoch = 10  →  k = 1
should_halve = True
apply_halving: current_amount = ⌊1000/2⌋ = 500, halved = True
is_expired at k=1: 1 < 2 → False (không prune)
Output batch: { current_amount: 500, halved: True }
```

**TV-AH-02:** Batch k=2, amount=500 (đã halve)

```
Input:  batch = { created_epoch: 8, current_amount: 500, halved: True, source: Instant, decay_window: 2 }
        current_epoch = 10  →  k = 2
should_halve = False (k≠1)
is_expired at k=2: 2 ≥ 2 → True
Output: batch bị prune → không có trong output list
```

**TV-AH-03:** Batch k=1, amount lẻ — floor division

```
Input:  current_amount = 999, current_epoch = 10, created_epoch = 9 → k=1
apply_halving: ⌊999/2⌋ = 499   (không phải 500)
Output: current_amount = 499, halved = True
```

**TV-AH-04:** Pending profile fires đồng thời (current_epoch = effective_epoch)

```
Input datum:
  profile = Flame
  pending_profile = Some({ new_profile: Ember, effective_epoch: 10 })
  magic_batches = []
  current_epoch = 10

apply_pending_profile:
  10 >= 10 → True
  → profile = Ember, pending_profile = None

Output datum:
  profile = Ember
  pending_profile = None
  magic_batches = []
  last_updated_epoch = 10
```

**TV-AH-05:** Hai batch — một k=0, một k=1

```
Input batches:
  B1: { created_epoch: 10, current_amount: 2000, halved: False }  → k=0
  B2: { created_epoch: 9,  current_amount: 1500, halved: False }  → k=1
  current_epoch = 10

apply_halving_all:
  B1: should_halve(k=0) = False → không đổi
  B2: should_halve(k=1, halved=False) = True → current_amount = ⌊1500/2⌋ = 750, halved=True

prune_expired:
  B1: k=0 < 2 → giữ
  B2: k=1 < 2 → giữ

Output batches: [B1_unchanged, B2_halved]
```

---

## TECH.md — Aiken types, Validator logic, eUTXO flow, Deploy deps

### Plutus Data encoding

`ApplyHalving` là constructor index 1 trong `VaultRedeemer` (xem `InstantGen/onchain/lib/magiclamp/protocol/types.ak:158`):

```aiken
pub type VaultRedeemer {
  InstantGen    { lamp_paid: Natural }   // constr 0
  ApplyHalving                           // constr 1
  BurnBatch     { burns: List<...> }     // constr 2
  UpdateProfile { new_profile: ... }     // constr 3
  WithdrawLamp  { amount: Natural }      // constr 4
}
```

Plutus Data cho redeemer `ApplyHalving`:
```
Constr(1, [])
```

### Validator logic (H-1..H-7)

File: `InstantGen/onchain/validators/vault.ak:validate_apply_halving`

```
validate_apply_halving(input_datum, current_epoch, own_ref, tx):
  H-1: list.count(tx.inputs, addr == vault_addr) == 1
  H-2: applied_input = apply_pending_profile(input_datum, current_epoch)
  H-3: expected_batches = halve_then_prune(applied_input.magic_batches, current_epoch)
  output_datum = find_vault_output_datum(tx.outputs, vault_addr)
  H-4: output_datum.lamp_balance == applied_input.lamp_balance
       output_datum.lamp_locked == applied_input.lamp_locked
       output_datum.loyalty_holdings == applied_input.loyalty_holdings
  H-6: output_datum.magic_batches == expected_batches
       list.length(output_datum.magic_batches) <= 32
       output_datum.next_batch_index == applied_input.next_batch_index
       output_datum.last_updated_epoch == current_epoch
  H-7: tất cả field còn lại == applied_input.*
```

### eUTXO flow

```
┌──────────────┐                     ┌──────────────────────────────────┐
│  Vault UTxO  │ ──[ApplyHalving]──▶ │  Vault UTxO (updated)            │
│  input_datum │                     │  output_datum:                   │
│              │                     │   magic_batches = halved+pruned  │
│  (lưu trên   │                     │   last_updated_epoch = current   │
│   chain)     │                     │   [all other fields unchanged]   │
└──────────────┘                     └──────────────────────────────────┘
```

Không có input/output nào khác cần thiết. Không cần reference input (không cần UM datum).

### Constraint checklist

| Constraint | Nguồn | Implement |
|---|---|---|
| C-DECAY-7 | §4.3 | `apply_halving` trong `decay.ak:22` |
| C-DECAY-8 | §4.3 | A02 check `output.magic_batches == expected_batches` |
| C-PRUNE-1 | §4 | `prune_expired` trong `decay.ak:54` |
| C-PRUNE-2 | §4 | `halve_then_prune` — halve trước prune |
| C-VAULT-DS-1 | §5.8 | H-1 check count==1 |
| C-VAULT-OUT-1 | PR#11 | `find_vault_output` enforces count==1 |
| C-VAULT-1 | §5.8 | `list.length(output.magic_batches) <= 32` |
| SPEC_V1 §2 | Lazy profile | `apply_pending_profile` gọi trước A02 check |

### Deploy dependencies

ApplyHalving không thêm tham số mới vào validator. Validator đã được parameterized bởi:
- `lamp_policy_id`
- `treasury_addr`
- `um_nft_policy`
- `ms_per_epoch`

Không cần deploy lại reference script khi chỉ thêm ApplyHalving — validator hash thay đổi do code thay đổi. Migration cùng kế hoạch với SPEC_V1 §6 (drop v0, redeploy v1).

---

## EXEC.md — Deploy steps, Test plan, Known limits, v-next

### Deploy steps

ApplyHalving không có deploy step riêng. Quy trình là quy trình chung của InstantGen v1.1:

```bash
# 1. Build validator
cd InstantGen/onchain && aiken build
# → sinh plutus.json mới (validator hash thay đổi)

# 2. Update hash trong scripts/.env
# INSTANT_VAULT_HASH=<new_hash>

# 3. Deploy với scripts/deploy/03_deploy_instant_vault.ts (nếu có)
# hoặc tích hợp vào deploy flow hiện tại

# 4. Verify on-chain
# curl Blockfrost: check script hash tại địa chỉ mới
```

### Test plan

**Positive (3 tối thiểu):**

| ID | Mô tả | Expected |
|---|---|---|
| H-POS-1 | Batch k=1, amount=1000 → halve thành 500 | PASS, output có `current_amount=500, halved=True` |
| H-POS-2 | Batch k=0 → không halve, không prune | PASS, batch giữ nguyên |
| H-POS-3 | Batch k=2 → prune khỏi output | PASS, output `magic_batches=[]` |
| H-POS-4 | Permissionless — empty signers | PASS |
| H-POS-5 | Pending profile fires cùng lúc | PASS, `profile` cập nhật, `pending=None` |

**Negative (5 tối thiểu, MECE):**

| ID | Tamper | Expected reject |
|---|---|---|
| H-NEG-1 | Output giữ batch chưa halve (k=1 nhưng `halved=False`) | `expect output.magic_batches == expected_batches` |
| H-NEG-2 | Output giữ batch đã hết hạn (k≥2) | `expect output.magic_batches == expected_batches` |
| H-NEG-3 | `output.lamp_balance` bị giảm | `expect output.lamp_balance == applied_input.lamp_balance` |
| H-NEG-4 | `output.last_updated_epoch` không advance (giữ 0) | `expect output.last_updated_epoch == current_epoch` |
| H-NEG-5 | 2 vault output cùng địa chỉ (phantom output) | `C-VAULT-OUT-1` trong `find_vault_output` |

Tất cả 10 test trên đã được implement trong `vault.ak` (xem section `-- ApplyHalving --` cuối file) và pass `aiken check 20/20`.

### Known limits

- **Batch đã `halved=True` tại k=1**: `should_halve` trả False → không tác dụng gì. Idempotent nếu gọi lại ApplyHalving ở epoch sau (batch k=2 → sẽ prune).
- **`halved` flag chỉ tồn tại trên Instant batch**: Các batch nguồn Snapshot/Vacuum/Schedule luôn có `halved=False` tại creation (C-DECAY-6), validator không halve chúng.
- **Không thể ApplyHalving ngay tại epoch tạo batch (k=0)**: `should_halve` yêu cầu `k==1` — gọi ở epoch tạo là no-op hợp lệ.

### v-next

| Item | Scope | Ưu tiên |
|---|---|---|
| Offchain helper `buildApplyHalvingTx` trong MagicSDK | SDK | Trung bình |
| UMKeeper tích hợp ApplyHalving trigger (keeper chủ động halve vault khi batch đến k=1) | UMKeeper | Thấp |
| BurnBatch (ConsumeMAGIC) với full A02 — cần gọi `apply_pending_profile` + `halve_then_prune` trước khi tính burn amount | v1.1 | Cao |
