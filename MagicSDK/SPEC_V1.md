# MAGIC v1.0 — Onchain Spec

**Mục tiêu:** đóng gói MAGIC validator v1.0 stable trước mainnet. Sau v1.0 cố gắng không đổi validator hash (mọi thay đổi qua offchain SDK / patch không đổi semantics) để tránh migration.

**Scope:** 2 redeemer mới + 1 stub cần implement đầy đủ. Không đụng vault datum shape (tránh re-build) ngoài việc thêm enum variant.

**Audience:** dev onchain (Aiken). Cho integrator dev offchain xem [`INTEGRATOR_GUIDE_V1.md`](./INTEGRATOR_GUIDE_V1.md). Cho test matrix xem [`V1_TESTNET_PLAN.md`](./V1_TESTNET_PLAN.md).

---

## Tổng quan

| # | Item | Module | Loại | Trạng thái hiện tại | Mức |
|---|---|---|---|---|---|
| 1 | `WithdrawLamp { amount }` | Snapshot + Instant + Vacuum + Schedule vault | NEW redeemer | Chưa tồn tại | 🔴 Chặn production |
| 2 | `UpdateProfile { new_profile }` đầy đủ | SnapshotGen vault | STUB → full impl | Stub chỉ check owner sign | 🟡 |
| 3 | `UpdateProfile { new_profile }` đầy đủ | InstantGen vault | STUB → full impl | Stub chỉ check owner sign (giống Snap) | 🟡 |

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

### Design call — UpdateProfile khi đang có pending

Nếu user gọi `UpdateProfile` lần 2 trước khi `pending_profile` của lần 1 được apply (chưa có handler nào chạm vào vault sau effective_epoch của pending) — chấp nhận hay reject?

**Quyết định:** **chấp nhận override.** Pending mới thay pending cũ. Vẫn enforce C-PC-V2 cooldown tính từ `profile_changed_epoch` (đã được set ở lần 1) → không bypass được cooldown. Lý do: user đổi ý sớm hơn là use case hợp lệ; bắt user đợi pending fire xong thì kẹt.

Implement: validator không có branch `if pending == None`. Mọi tx UpdateProfile xử lý cùng pattern, set pending mới. Test case `UP-EDGE-1` trong `V1_TESTNET_PLAN.md` verify behavior này.

---

## §3. `UpdateProfile` đầy đủ — InstantGen vault

### Lý do (Option A)

PM_Q dùng ở cả Snapshot + Instant. User có thể có vault Snap profile=Flame và vault Instant profile=Ember (mỗi vault độc lập, datum riêng). Cần đổi được profile riêng cho từng vault.

### Trạng thái hiện tại — cùng lỗi như §2

Enum `InstantGen/onchain/lib/magiclamp/protocol/types.ak` **đã có** `UpdateProfile { new_profile }` (constructor index 3). Handler trong `InstantGen/onchain/validators/vault.ak`:

```aiken
UpdateProfile { .. } -> {
  // TODO: §12 Profile change.
  expect list.has(tx.extra_signatories, input_datum.owner)
  True
}
```

Stub PASS mọi tamper — cùng security bug như SnapshotGen §2.

### Implementation

Sao chép nguyên logic §2 vào InstantGen vault handler. `apply_pending_profile` add vào InstantGen vault handler `InstantGen { lamp_paid }` trước khi compute `M = lamp_paid × R_inst × UM × PM[apply_pending(input_datum).profile]`.

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

### Offchain test (xem chi tiết trong [`V1_TESTNET_PLAN.md`](./V1_TESTNET_PLAN.md))

- [ ] `scripts/test/withdraw_only.ts` — 11 case withdraw (3 positive + 8 negative) cho mỗi vault module
- [ ] `scripts/test/update_profile_only.ts` — 11 case UpdateProfile + lazy apply scenarios cho Snap + Inst
- [ ] `scripts/test/multi_vault_only.ts` — 4 case multi-vault (W-CROSS + MV)
- [ ] Regression run — 37 case v0 vẫn pass sau khi merge v1.0 code
- [ ] Update [`MASTER_TESTNET_REPORT.md`](../MASTER_TESTNET_REPORT.md) với section v1.0 (~32+ case mới)
- [ ] 3 report mới (repo root): `WITHDRAW_TESTNET_REPORT.md`, `UPDATE_PROFILE_TESTNET_REPORT.md`, `MULTI_VAULT_TESTNET_REPORT.md`

### Offchain SDK (đã hoàn tất)

- ✅ `MagicSDK/src/withdrawLamp.ts` — `removeNewestFirst` algorithm khớp §1 spec
- ✅ `MagicSDK/src/updateProfile.ts` — cooldown + lazy apply
- ✅ `MagicSDK/src/listVaults.ts` — multi-vault discovery (chạy ngay trên v0)
- ✅ Unit tests 18/18 pass

### Redeemer constructor indices — SDK tự resolve runtime

SDK KHÔNG còn hardcode index. Thay vì duy trì bảng đếm tay (dễ desync khi Aiken enum reorders), SDK đọc trực tiếp từ `plutus.json` mà Aiken sinh ra:

```
plutus.json
├── validators[].title = "vault.vault.spend"
│   └── redeemer.schema.$ref → "#/definitions/<path>/VaultRedeemer"
└── definitions["…/VaultRedeemer"].anyOf[]
    ├── { title: "WithdrawLamp",  index: 6, ... }
    └── ...
```

Caller pass `vaultPlutusJson` qua `ValidatorBundle.vaultPlutusJson`; SDK helper `resolveConstrIndex(plutusJson, validatorTitle, variantTitle)` tự lookup index. Nếu enum reorders trong v1.0 hoặc tương lai → SDK pick up tự động qua plutus.json mới.

Implementation hiện tại (Aiken enum trên main, để tham khảo — SDK không hardcode):

| Module | Enum variant trên main | WithdrawLamp index (sau khi add) |
|---|---|---|
| SnapshotGen | 0 Trigger · 1 Burn · 2 UpdateProfile | 3 (NEW) |
| InstantGen | 0 Instant · 1 Halving · 2 Burn · 3 UpdateProfile | 4 (NEW) |
| VacuumGen | 0 VCommit · 1 VFire · 2 Instant · 3 Halving · 4 Burn · 5 UpdateProfile | 6 (NEW) |
| ScheduleGen | 0 SCommit · 1 SFire · 2 Burn | 3 (NEW) |

→ Implementer thêm `WithdrawLamp` ở cuối enum mỗi module. SDK không cần update khi index khác kỳ vọng — chỉ cần `aiken build` sinh plutus.json mới, SDK tự resolve.
