# MAGIC v1.0 — Onchain Spec

**Mục tiêu:** đóng gói MAGIC validator v1.0 stable trước mainnet. Sau v1.0 cố gắng không đổi validator hash (mọi thay đổi qua offchain SDK / patch không đổi semantics) để tránh migration.

**Scope:** 2 redeemer mới + 1 stub cần implement đầy đủ. Không đụng vault datum shape (tránh re-build) ngoài việc thêm enum variant.

---

## Tổng quan

| # | Item | Module | Loại | Trạng thái hiện tại | Mức |
|---|---|---|---|---|---|
| 1 | `WithdrawLamp { amount }` | Snapshot + Instant + Vacuum + Schedule vault | NEW redeemer | Chưa tồn tại | 🔴 Chặn production |
| 2 | `UpdateProfile { new_profile }` đầy đủ | SnapshotGen vault | STUB → full impl | Stub chỉ check owner sign | 🟡 |
| 3 | `UpdateProfile { new_profile }` thêm vào Instant | InstantGen vault | NEW (Option A) | Chưa tồn tại | 🟡 |

Không thay đổi datum shape. Vault hash sẽ đổi vì validator code đổi → migration plan riêng (xem §6).

---

## §1. `WithdrawLamp { amount: Natural }` — cả 4 vault

### Use case

User rút LAMP unlocked từ vault về ví (hoặc địa chỉ chỉ định). Là 1 chiều ra duy nhất ngoài flow Treasury (Vacuum/Schedule). Không có withdraw thì LAMP locked vĩnh viễn trong vault — blocker cho production.

### Validator rules

```aiken
WithdrawLamp { amount: Natural } -> {
  // W-1: amount > 0
  expect amount > 0

  // W-2: owner signs
  expect list.has(tx.extra_signatories, input_datum.owner)

  // W-3: amount ≤ L_avail (chỉ rút phần unlocked)
  let avail = input_datum.lamp_balance - input_datum.lamp_locked
  expect amount <= avail

  // W-4: chỉ 1 vault input (C-VAULT-DS-1 standard)
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

  // W-5: output vault datum field-by-field (A02 pattern)
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)
  let new_holdings = remove_newest_first(input_datum.loyalty_holdings, amount)

  expect output_datum.owner == input_datum.owner
  expect output_datum.lamp_balance == input_datum.lamp_balance - amount
  expect output_datum.lamp_locked == input_datum.lamp_locked
  expect output_datum.loyalty_holdings == new_holdings
  expect output_datum.magic_batches == input_datum.magic_batches
  expect output_datum.next_batch_index == input_datum.next_batch_index
  expect output_datum.vacuum_orders == input_datum.vacuum_orders
  expect output_datum.gen_schedules == input_datum.gen_schedules
  expect output_datum.profile == input_datum.profile
  expect output_datum.profile_changed_epoch == input_datum.profile_changed_epoch
  expect output_datum.pending_profile == input_datum.pending_profile
  expect output_datum.last_updated_epoch == current_epoch    // advance
  expect output_datum.delegation_cert == input_datum.delegation_cert
  expect output_datum.activity_state == input_datum.activity_state
  expect output_datum.streak_state == input_datum.streak_state
  expect output_datum.personal_delegate == input_datum.personal_delegate
  expect output_datum.attribution == input_datum.attribution

  // W-6: vault output value khớp lamp_balance mới
  let vault_output = find_vault_output(tx.outputs, vault_addr)
  expect quantity_of(vault_output.value, lamp_policy_id, "LAMP") == input_datum.lamp_balance - amount

  // W-7: sum(holdings) invariant
  expect sum_holdings(output_datum.loyalty_holdings) == output_datum.lamp_balance

  True
}
```

### Helper: `remove_newest_first`

Chọn holding **mới nhất** (acquired_epoch cao nhất) trước → preserve loyalty của holdings cũ → max LF cho Snapshot/Instant sau này. Locked holdings không bao giờ bị động vào.

```aiken
// Implement tương tự select_lamp_for_lock trong protocol/lock.ak
pub fn remove_newest_first(
  holdings: List<LoyaltyHolding>,
  amount:   Natural,
) -> List<LoyaltyHolding> {
  // 1. Split locked vs unlocked
  let locked   = list.filter(holdings, fn(h) {  h.is_locked })
  let unlocked = list.filter(holdings, fn(h) { !h.is_locked })

  // 2. Sort unlocked DESC by acquired_epoch (newest first)
  let sorted = list.sort(unlocked, fn(a, b) {
    if a.acquired_epoch > b.acquired_epoch { Less }
    else if a.acquired_epoch < b.acquired_epoch { Greater }
    else { Equal }
  })

  // 3. Iterate, consume from newest first; partial-consume the last item if needed
  let (consumed, remaining_unlocked) = consume_loop(sorted, amount)
  expect consumed == amount   // W-3 guarantees this

  // 4. Locked + remaining unlocked
  list.concat(locked, remaining_unlocked)
}
```

SDK đối chiếu: `MagicSDK/src/withdrawLamp.ts:removeNewestFirst` — cùng thuật toán, P8 cross-check.

### Edge cases

| Scenario | Expected |
|---|---|
| `amount = 0` | W-1 reject |
| `amount > lamp_balance` | W-3 reject (avail < amount) |
| `amount > L_avail` (do locked) | W-3 reject |
| `amount = L_avail` (drain hết unlocked) | OK; sau tx, vault chỉ còn locked holdings |
| `amount = lamp_balance` khi `lamp_locked > 0` | W-3 reject (avail < amount vì có locked) |
| `amount = lamp_balance` khi `lamp_locked = 0` | OK; vault còn 0 LAMP, holdings rỗng |
| No owner sign | W-2 reject |
| Output datum tamper bất kỳ field | W-5 reject |
| Output vault value khác `lamp_balance` mới | W-6 reject |

### Negative test cases

| Tamper | Expected reject rule |
|---|---|
| `output.lamp_balance` không trừ đúng | `expect output.lamp_balance == input.lamp_balance - amount` |
| `output.lamp_locked` thay đổi | `expect output.lamp_locked == input.lamp_locked` |
| `output.holdings` không newest-first | `expect output.holdings == remove_newest_first(...)` |
| `output.magic_batches` mutated | `expect output.magic_batches == input.magic_batches` |
| `output.loyalty_holdings` rút locked holdings | computed expected sẽ khác → reject ở `holdings ==` check |
| Output vault value LAMP ≠ balance mới | W-6 reject |
| Wallet không sign | W-2 reject |
| Tx có 2 vault input | W-4 reject |

---

## §2. `UpdateProfile { new_profile: ActivityProfile }` — SnapshotGen impl đầy đủ

### Trạng thái hiện tại — lỗi bảo mật

```aiken
// SnapshotGen/onchain/validators/vault.ak (CURRENT — STUB)
UpdateProfile { .. } -> {
  expect list.has(tx.extra_signatories, input_datum.owner)
  True   // ← pass mọi datum tamper. CRITICAL BUG.
}
```

Stub hiện tại cho phép tx UpdateProfile thay đổi bất kỳ field nào trong output datum (`lamp_balance`, `magic_batches`, …) — bypass toàn bộ A02 integrity check. Phải fix trước v1.0.

### Spec đã có

`ProfileChange/onchain/validators/vault_profile.ak` (partial) đã định nghĩa rules — copy logic vào SnapshotGen vault. §12 (C-PC-V1..V6, T4) có offchain reference tại `ProfileChange/offchain/src/profile.ts`.

### Validator rules

```aiken
UpdateProfile { new_profile } -> {
  let vault_addr = find_own_address(own_ref, tx.inputs)
  expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1

  // C-PC-V1: owner signs
  expect list.has(tx.extra_signatories, input_datum.owner)

  // C-PC-V2: cooldown ≥ 2 epoch
  expect current_epoch - input_datum.profile_changed_epoch >= profile_cooldown  // = 2

  // C-PC-V3: must actually change
  expect new_profile != input_datum.profile

  // C-PC-V4..V6: lazy apply — set pending, profile FIELD unchanged
  let output_datum = find_vault_output_datum(tx.outputs, vault_addr)

  expect output_datum.owner == input_datum.owner
  expect output_datum.lamp_balance == input_datum.lamp_balance
  expect output_datum.lamp_locked == input_datum.lamp_locked
  expect output_datum.loyalty_holdings == input_datum.loyalty_holdings

  // C-PC-V4: existing batches UNCHANGED (profile_at_creation immutable — T4)
  expect output_datum.magic_batches == input_datum.magic_batches
  expect output_datum.next_batch_index == input_datum.next_batch_index
  expect output_datum.vacuum_orders == input_datum.vacuum_orders
  expect output_datum.gen_schedules == input_datum.gen_schedules

  // KEY: profile field UNCHANGED (lazy)
  expect output_datum.profile == input_datum.profile

  // KEY: pending_profile SET với effective_epoch = current + 1
  expect output_datum.pending_profile == Some(PendingProfile {
    new_profile,
    effective_epoch: current_epoch + 1,
  })
  expect output_datum.profile_changed_epoch == current_epoch

  expect output_datum.last_updated_epoch == current_epoch
  expect output_datum.delegation_cert == input_datum.delegation_cert
  expect output_datum.activity_state == input_datum.activity_state
  expect output_datum.streak_state == input_datum.streak_state
  expect output_datum.personal_delegate == input_datum.personal_delegate
  expect output_datum.attribution == input_datum.attribution

  // Vault output value unchanged (no LAMP movement) — implicit qua lamp_balance check
  True
}
```

### Lazy apply cơ chế

`pending_profile` được set ở tx UpdateProfile. Mọi validator handler khác (TriggerSnapshot, InstantGen, …) tự áp dụng pending khi `current_epoch >= pending.effective_epoch`:

```aiken
// Thêm vào shared helper
fn apply_pending_profile(datum: VaultDatum, current_epoch: Int) -> VaultDatum {
  when datum.pending_profile is {
    Some(pp) ->
      if current_epoch >= pp.effective_epoch {
        VaultDatum { ..datum, profile: pp.new_profile, pending_profile: None }
      } else {
        datum
      }
    None -> datum
  }
}
```

**Quan trọng — handler usage pattern:**

```aiken
// Mỗi handler (TriggerSnapshot, InstantGen, …) làm như sau:
let applied_input = apply_pending_profile(input_datum, current_epoch)

// 1. Dùng applied_input cho M computation
let m = compute_snapshot_magic(..., applied_input.profile, ...)

// 2. Dùng applied_input cho A02 output datum check
expect output_datum.profile == applied_input.profile             // = new nếu pending đã áp dụng
expect output_datum.pending_profile == applied_input.pending_profile  // = None nếu đã áp dụng
```

Nếu chỉ apply cho M compute mà không cho output datum check → output datum vẫn giữ `pending_profile` cũ → tx kế tiếp lại apply nữa → infinite pending. Cả 2 phải dùng `applied_input`.

### Negative test cases

| Tamper | Expected reject |
|---|---|
| Đổi `output.profile` trực tiếp (bypass lazy) | `expect output.profile == input.profile` |
| `pending_profile` set sai `effective_epoch` | `expect == current+1` |
| Re-update khi chưa qua cooldown | C-PC-V2 |
| `new_profile == old` | C-PC-V3 |
| Mutate `magic_batches` (vd: change `profile_at_creation` của batch cũ) | A02 + T4 |
| Mutate `lamp_balance` | A02 |

---

## §3. `UpdateProfile` thêm vào InstantGen vault

### Lý do (Option A)

PM_Q dùng ở cả Snapshot + Instant. User có thể có vault Snap profile=Flame và vault Instant profile=Ember (mỗi vault độc lập, datum riêng). Để cho user đổi profile vault Instant: cần `UpdateProfile` redeemer trên InstantGen vault.

### Implementation

Sao chép nguyên logic §2 vào InstantGen vault. Thêm enum variant `UpdateProfile { new_profile: ActivityProfile }` vào `InstantGen/onchain/lib/magiclamp/protocol/types.ak` (constructor index 3, sau `InstantGen=0`, `ApplyHalving=1`, `BurnBatch=2`).

`apply_pending_profile` cũng add vào InstantGen vault handler `InstantGen { lamp_paid }` trước khi compute `M = lamp_paid × R_inst × UM × PM[apply_pending(input_datum).profile]`.

---

## §4. Multi-vault per user — không cần thay đổi onchain ✅

### Hiện trạng

```aiken
// SnapshotGen + 3 module: chỉ check 1 vault input per tx
expect list.count(tx.inputs, fn(i) { i.output.address == vault_addr }) == 1
```

Không có check "1 vault per owner". User có thể có N vault tại cùng vault address với cùng owner PKH — mỗi vault 1 UTxO riêng, datum riêng, holdings riêng. Cardano hỗ trợ sẵn pattern này.

### Use case

User có 3 khoản LAMP với thời hạn khác nhau (ngắn / trung / dài hạn). Mỗi khoản 1 vault SnapshotGen riêng. Tiêu LAMP của vault ngắn hạn (qua Withdraw + Instant) **không ảnh hưởng tới LF của vault dài hạn** vì LF tính theo `loyalty_holdings` của vault hiện tại (không cross-vault).

### SDK support

`MagicSDK/src/listVaults.ts:listVaultsForOwner` — discover N vault của 1 owner. Trả về danh sách `VaultRecord` kèm `vaultId`, `oldestEpoch`, `lampBalanceOil`, `profile` để app layer label / sort / chọn.

Mỗi action (snapshot / instant / withdraw / updateProfile) chỉ định vault cụ thể qua `vaultUtxo` param — đã chuẩn pattern. SDK không cần thay đổi.

### Khuyến nghị cho app layer

- Cache mapping `userDID → [vaultId₁, vaultId₂, ...]` off-chain
- UI: "My vaults" list với label do user gán (short/mid/long)
- Mỗi action UX: chọn vault → call SDK với `vaultUtxo` tương ứng

---

## §5. Design decisions

| Câu hỏi | Quyết định |
|---|---|
| Withdraw có fee tokenomics không? | Không — free, user trả ADA network fee như mọi tx Cardano |
| Session key nằm đâu? | PhoenixKey domain. MAGIC không lo. `personal_delegate` field giữ nguyên (reserved, purpose chưa rõ) |
| ProfileChange validator riêng hay gộp? | Option A — gộp `UpdateProfile` redeemer vào Snapshot + Instant vault (vì PM_Q dùng ở cả 2) |
| Multi-vault per user? | Có — native support, SDK thêm `listVaultsForOwner` |

---

## §6. Migration plan v0 → v1

### Cardano property

Vault hash đổi → vault cũ bị kẹt ở địa chỉ cũ. Validator cũ vẫn chạy được (immutable). User có private key + biết validator CBOR cũ vẫn spend được UTxO.

### Lựa chọn

| Hướng | Mô tả | Pros/Cons |
|---|---|---|
| **(a) Drop v0** | Preview chỉ là testnet, drop hết, không support v0 sau khi v1 deploy | Đơn giản. Test users mất tLAMP nhưng testnet rẻ |
| **(b) Withdraw-then-create** | User call `WithdrawLamp` (v0 cũng cần có) → wallet → `createVault` v1 | v0 phải có WithdrawLamp trước → vướng vòng luẩn quẩn (v0 đã deploy, không add được) |
| **(c) 1-tx atomic migration** | Spend v0 vault + create v1 vault trong 1 tx | Cần custom redeemer "MigrateOut" ở v0 — v0 chưa có. Không khả thi cho v0 hiện tại |
| **(d) Không migrate** | v0 chỉ trên Preview, không lên mainnet | **Recommend** |

**Đề xuất hướng (d):**

- v0 (trạng thái hiện tại) chỉ trên Preview testnet
- KHÔNG launch v0 lên mainnet
- v1.0 = v0 + WithdrawLamp + UpdateProfile (đầy đủ) → đóng gói stable → audit → mainnet
- Sau mainnet, mỗi thay đổi onchain (= validator hash đổi) = đợt migration nghiêm túc với kế hoạch riêng

### Preview testnet hiện tại

Khi v1.0 sẵn sàng:
- Redeploy validator → vault address mới
- Test users tự tạo vault mới (tLAMP testnet vẫn còn — re-mint nếu cần qua `01_mint_lamp`)
- v0 vault cũ trên Preview bị kẹt — bỏ qua. Rút kinh nghiệm, không mất production data

### Mainnet launch

Chỉ launch v1.0 (đã có Withdraw + UpdateProfile đầy đủ). Quy trình: thêm 2 redeemer + Aiken test pass → audit → deploy production. Sau deploy, validator hash đóng cứng cho mọi mainnet user.

---

## §7. Implementation checklist

### Onchain (Aiken)

- [ ] SnapshotGen vault: implement full `UpdateProfile` (§2) — thay stub hiện tại
- [ ] SnapshotGen vault: thêm `WithdrawLamp { amount }` redeemer (§1)
- [ ] InstantGen vault: thêm `UpdateProfile { new_profile }` enum variant + handler (§3)
- [ ] InstantGen vault: thêm `WithdrawLamp { amount }` redeemer (§1)
- [ ] VacuumGen vault: thêm `WithdrawLamp { amount }` redeemer (§1)
- [ ] ScheduleGen vault: thêm `WithdrawLamp { amount }` redeemer (§1)
- [ ] Helper `remove_newest_first` add vào `protocol/lock.ak` (shared)
- [ ] Helper `apply_pending_profile` add vào shared lib
- [ ] Mọi handler (TriggerSnapshot, InstantGen, ApplyHalving, BurnBatch) gọi `apply_pending_profile` rồi dùng `applied_input` cho cả M computation và A02 output datum check (xem §2 handler usage pattern)
- [ ] `aiken check` pass 0 errors cho 4 module
- [ ] `aiken build` → cập nhật plutus.json cho 4 module

### Offchain test (theo per-module smoke test pattern hiện tại)

- [ ] `scripts/test/withdraw_only.ts` — smoke test WithdrawLamp (positive + 5 negative tampers)
- [ ] `scripts/test/update_profile_only.ts` — smoke test UpdateProfile (positive + 5 negative)
- [ ] `scripts/test/multi_vault_only.ts` — verify 1 owner có 2 vault, tiêu vault1 không ảnh hưởng vault2's LF
- [ ] Update `MASTER_TESTNET_REPORT.md` với 11+ case mới (Withdraw × 4 module × ~3 case + UpdateProfile × 2 module × 2 case)

### Offchain SDK (đã hoàn tất)

- ✅ `MagicSDK/src/withdrawLamp.ts` — `removeNewestFirst` algorithm khớp §1 spec
- ✅ `MagicSDK/src/updateProfile.ts` — cooldown + lazy apply
- ✅ `MagicSDK/src/listVaults.ts` — multi-vault discovery (chạy ngay trên v0)
- ✅ Unit tests 18/18 pass

### Redeemer constructor indices đề xuất

Implementer có thể chỉnh khi cần. SDK hiện đang dùng:

| Vault type | Index | Redeemer |
|---|---|---|
| SnapshotGen | 0 | TriggerSnapshot |
| SnapshotGen | 1 | BurnBatch |
| SnapshotGen | 2 | UpdateProfile (existing — full impl) |
| SnapshotGen | **3** | **WithdrawLamp** (NEW) |
| InstantGen | 0 | InstantGen |
| InstantGen | 1 | ApplyHalving |
| InstantGen | 2 | BurnBatch (existing) |
| InstantGen | **3** | **UpdateProfile** (NEW Option A) |
| InstantGen | **4** | **WithdrawLamp** (NEW) |
| VacuumGen | 0 | VacuumCommit |
| VacuumGen | 1 | VacuumFire |
| VacuumGen | 2 | BurnBatch |
| VacuumGen | **3** | **WithdrawLamp** (NEW) |
| ScheduleGen | 0 | ScheduleCommit |
| ScheduleGen | 1 | ScheduleFire |
| ScheduleGen | 2 | BurnBatch |
| ScheduleGen | **3** | **WithdrawLamp** (NEW) |

Nếu indices thay đổi → update 2 chỗ trong SDK: `MagicSDK/src/withdrawLamp.ts:WITHDRAW_LAMP_CONSTR_INDEX` và `updateProfile.ts:UPDATE_PROFILE_CONSTR_INDEX`.
