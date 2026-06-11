# SnapshotGen TECH — Đặc tả kỹ thuật
## GenMAGIC v3.3 · §8 SnapshotGen

---

## 1. Aiken types và Plutus Data encoding

### 1.1 ActivityProfile (types.ak:13-17)

```
pub type ActivityProfile {
  Ember    // constr 0
  Flame    // constr 1
  Lantern  // constr 2
}
```

**QUAN TRỌNG:** Thứ tự khai báo = Plutus Data constructor index. Không được đảo thứ tự. TypeScript sử dụng `Data.Enum` theo cùng thứ tự.

### 1.2 BatchSource (types.ak:6-11)

```
pub type BatchSource {
  Snapshot   // constr 0
  Instant    // constr 1
  Vacuum     // constr 2
  Schedule   // constr 3
}
```

### 1.3 MagicBatch (types.ak:19-29)

```
pub type MagicBatch {
  batch_id            : ByteArray,          -- blake2b_256(ref ++ index)
  source              : BatchSource,        -- Snapshot = constr 0
  created_epoch       : Natural,
  initial_amount      : Natural,            -- bất biến sau khi tạo (audit)
  current_amount      : Natural,            -- mutable (thay đổi khi burn)
  decay_window        : Natural,            -- N(profile) — đóng băng khi tạo
  profile_at_creation : Option<ActivityProfile>,  -- Some(P) cho Snapshot
  contract_id         : Option<ByteArray>,  -- None cho Snapshot
  halved              : Bool,               -- False cho Snapshot (C-DECAY-6)
}
```

### 1.4 VaultDatum (types.ak:96-114)

Trường quan trọng liên quan SnapshotGen (thứ tự = Plutus Data field index):

| Field | Type | Ghi chú |
|---|---|---|
| owner | ByteArray | PubKeyHash, phải ký |
| lamp_balance | Natural | Toàn bộ LAMP (kể cả locked) — C-SS-5 |
| lamp_locked | Natural | Phần đang locked (Schedule/Vacuum) |
| loyalty_holdings | List<LoyaltyHolding> | Dùng tính LF |
| magic_batches | List<MagicBatch> | Tối đa 32 (C-VAULT-1) |
| next_batch_index | Natural | Tăng 1 khi thêm batch |
| profile | ActivityProfile | Profile hiện tại (lazy — chỉ thay sau apply_pending) |
| profile_changed_epoch | Natural | Dùng kiểm tra cooldown C-PC-V2 |
| pending_profile | Option<PendingProfile> | Lazy change chờ effective_epoch |
| last_updated_epoch | Natural | C-SS-1: phải tăng mỗi snapshot |
| activity_state | ActivityState | Dùng tính OAC |
| attribution | VaultAttribution | total_events, last_event_epoch |

### 1.5 VaultRedeemer (types.ak:122-127)

```
pub type VaultRedeemer {
  TriggerSnapshot                                      // constr 0
  BurnBatch { burns: List<(ByteArray, Natural)> }      // constr 1 — LOCKED v1.0
  UpdateProfile { new_profile: ActivityProfile }       // constr 2
  WithdrawLamp  { amount: Natural }                    // constr 3
}
```

**Append-only:** thêm variant mới phải ở cuối. Reindex sẽ phá vỡ tx on-chain.

---

## 2. Validator parameters

```
validator vault(lamp_policy_id: PolicyId, ms_per_epoch: Int)
```

| Network | `ms_per_epoch` |
|---|---|
| Mainnet | 432_000_000 |
| Preview/Preprod | 86_400_000 |

`ms_per_epoch` được hardcode tại deploy time. SDK mirror: `ProtocolUtils.MS_PER_EPOCH_BY_NETWORK`. Nguồn: `vault.ak:44-54`.

---

## 3. Epoch computation

```
current_epoch = lower_bound_posix_ms / ms_per_epoch
```

`lower_bound_posix_ms` lấy từ `tx.validity_range.lower_bound.bound_type` (phải là `Finite`). Nếu không có finite lower bound → validator fail.

Epoch numbering là POSIX-derived, không phải Cardano-genesis-relative. Cả validator và SDK dùng cùng công thức nên delta và ordering nhất quán. Nguồn: `vault.ak:219-224`.

---

## 4. Validator logic per redeemer

### 4.1 TriggerSnapshot (vault.ak:69 → validate_snapshot:100)

**Invariants theo thứ tự kiểm tra:**

| ID | Kiểm tra | Code ref |
|---|---|---|
| C-SS-1 | `current_epoch > input_datum.last_updated_epoch` | vault.ak:108 |
| Owner sig | `list.has(tx.extra_signatories, input_datum.owner)` | vault.ak:112 |
| C-VAULT-DS-1 | `vault_input_count == 1` | vault.ak:116-118 |
| apply_pending | `apply_pending_profile(input_datum, current_epoch)` → `applied_input` | vault.ak:124 |
| C-SS-5 | `lamp_balance = applied_input.lamp_balance` (FULL) | vault.ak:127 |
| LF compute | `lf_q = compute_lf_q(holdings, current_epoch)` | vault.ak:130 |
| OAC compute | `oac_q = compute_oac_q(activity_state, current_epoch)` | vault.ak:131 |
| C-SS-6 | `delta_e = current_epoch - applied_input.last_updated_epoch` | vault.ak:137 |
| C-SS-2 | `m_one = compute_snapshot_magic(...)` | vault.ak:138 |
| — | `m_total = delta_e × m_one` | vault.ak:139 |
| C-PRUNE-1 | `prune_expired_batches(batches, current_epoch)` | vault.ak:143 |
| C-SS-7/8 | `can_add_batch(pruned) && m_total > 0` | vault.ak:146-158 |
| C-SS-3/4/T4 | `create_snapshot_batch(own_ref, idx, profile, m_total, epoch)` | vault.ak:148-155 |
| A02 | Field-by-field output datum check | vault.ak:162-208 |
| C-VAULT-1 | `|output.magic_batches| <= 32` | vault.ak:184 |
| C-VAULT-OUT-1 | exactly 1 output at vault_addr | vault.ak:241 |
| Activity prune | `prune_stale_activity(activity_state, current_epoch)` | vault.ak:198-199 |
| C-ATT-2 | `total_events + 1` nếu batch_added | vault.ak:202-203 |
| C-SS-8 | `last_updated_epoch = current_epoch` kể cả SKIP | vault.ak:194 |

**Không có kiểm tra UM** (T16) — không có reference input UM trong tx.

### 4.2 BurnBatch (vault.ak:73-79)

```
BurnBatch { .. } -> fail @"BurnBatch locked until v1.1 (ConsumeMAGIC)"
```

Mọi tx với redeemer này đều bị reject. Không có exception.

### 4.3 UpdateProfile (vault.ak:83 → validate_update_profile:327)

**Invariants:**

| ID | Kiểm tra | Code ref |
|---|---|---|
| C-VAULT-DS-1 | `vault_input_count == 1` | vault.ak:335 |
| C-PC-V1 | owner ký | vault.ak:338 |
| C-PC-V2 | `current_epoch - profile_changed_epoch >= 2` | vault.ak:342 |
| C-PC-V3 | `new_profile != input_datum.profile` | vault.ak:345 |
| C-PC-V6 | output.profile == input.profile (KHÔNG thay ngay) | vault.ak:365 |
| C-PC-V6 | `output.pending_profile == Some(PendingProfile{new, current+1})` | vault.ak:369-373 |
| — | `output.profile_changed_epoch == current_epoch` | vault.ak:376 |
| — | `output.last_updated_epoch == current_epoch` | vault.ak:379 |
| T4 | `output.magic_batches == input.magic_batches` (bất biến) | vault.ak:355 |

### 4.4 WithdrawLamp (vault.ak:89 → validate_withdraw_lamp:258)

**Invariants:**

| ID | Kiểm tra | Code ref |
|---|---|---|
| W-1 | `amount > 0` | vault.ak:270 |
| W-2 | owner ký | vault.ak:272 |
| W-3 | `amount <= lamp_balance - lamp_locked` | vault.ak:274 |
| W-4 | `vault_input_count == 1` | vault.ak:277-279 |
| W-5 | Field-by-field output datum check | vault.ak:283-307 |
| — | `last_updated_epoch` KHÔNG đổi | vault.ak:307 |
| W-6 | `vault_lamp_qty == new_lamp_balance` (asset name `#"744c414d50"`) | vault.ak:310-313 |
| W-7 | `sum_holdings == lamp_balance` | vault.ak:316 |
| C-VAULT-13 | `|holdings| <= 64` | vault.ak:319 |

**Lý do `last_updated_epoch` bất biến:** Nếu nó tăng khi withdraw, catch-up window bị reset và user mất MAGIC của các epoch bị bỏ qua. Withdraw là thao tác LAMP-only, độc lập với snapshot.

---

## 5. A02 — Output datum field invariants (TriggerSnapshot)

Các field KHÔNG thay đổi trong TriggerSnapshot:

```
output.owner               == applied_input.owner
output.lamp_balance        == applied_input.lamp_balance
output.lamp_locked         == applied_input.lamp_locked
output.loyalty_holdings    == applied_input.loyalty_holdings
output.vacuum_orders       == applied_input.vacuum_orders
output.gen_schedules       == applied_input.gen_schedules
output.profile             == applied_input.profile
output.profile_changed_epoch == applied_input.profile_changed_epoch
output.pending_profile     == applied_input.pending_profile   // đã cleared nếu pending fired
output.delegation_cert     == applied_input.delegation_cert
output.streak_state        == applied_input.streak_state
output.personal_delegate   == applied_input.personal_delegate
```

Các field THAY ĐỔI:

```
output.magic_batches       == expected_batches
output.next_batch_index    == applied_input.next_batch_index + 1  (nếu batch added)
                           == applied_input.next_batch_index      (nếu SKIP)
output.last_updated_epoch  == current_epoch
output.activity_state      == prune_stale_activity(applied_input.activity_state, current_epoch)
output.attribution         == (total_events+1, last_event_epoch=current)  (nếu batch added)
                           == applied_input.attribution  (nếu SKIP)
```

So sánh với `applied_input` (không phải `input_datum`) để pending_profile được clear chính xác nếu nó fire trong cùng tx. Nguồn: `vault.ak:162-208`.

---

## 6. Batch ID computation

```
batch_id = blake2b_256(own_ref.transaction_id ++ encode_int(own_ref.output_index) ++ encode_int(next_index))
```

Nguồn: `snapshot.ak:132-140`. `encode_int` = `bytearray.from_int_big_endian(n, 8)` (8 bytes big-endian).

Batch ID là hàm của (UTxO ref, index counter) → mỗi batch có ID duy nhất trong vault, phân biệt giữa các vault.

---

## 7. eUTXO flow

### 7.1 TriggerSnapshot

```
Inputs:
  [0] vault_utxo        -- spend, redeemer: TriggerSnapshot
      datum: VaultDatum (inline)
      value: ... + lamp_balance LAMP

Outputs:
  [0] vault_utxo_new    -- continuing vault output
      datum: VaultDatum' (inline) -- updated
      value: ... + lamp_balance LAMP  (KHÔNG ĐỔI — T16, C-SS-5)

Extra signatories: [owner]
Validity range: [posix_lower, +inf)  -- lower_bound = current_epoch × ms_per_epoch
Reference inputs: (none — T16: không cần UM)
```

Không có Treasury output (SnapshotGen không tốn LAMP).

**Lưu ý — LAMP quantity check trong TriggerSnapshot (v1.0 gap):**

Validator hiện tại kiểm tra `output_datum.lamp_balance == applied_input.lamp_balance` (A02 datum field — vault.ak:168) nhưng **không gọi `assets.quantity_of`** để xác nhận rằng vault output UTxO thực sự chứa đúng số lượng LAMP token trên ledger (so với WithdrawLamp có check tương đương tại vault.ak:311-313).

Hệ quả: một owner ký giao dịch TriggerSnapshot có thể đưa vào vault output datum giữ `lamp_balance` cũ trong khi giá trị UTxO thực tế chứa ít LAMP hơn. Điều này tạo trạng thái `lamp_balance` trong datum cao hơn số LAMP thực trên ledger. Trạng thái lệch này sẽ làm WithdrawLamp thất bại (W-6 tại vault.ak:313 sẽ reject vì `vault_lamp_qty < new_lamp_balance`) — tức là user tự hại chính mình nếu gây ra. Không có actor nào khác (keeper, Treasury) bị ảnh hưởng do SnapshotGen không có LAMP transfer.

Mức độ: state corruption tự gây ra, không ảnh hưởng bên ngoài. Cần bổ sung check `assets.quantity_of` trong v1.1 để loại bỏ hoàn toàn.

Để thêm check trong v1.1 (mirror W-6 vào TriggerSnapshot):
```
// Sau A02 datum checks trong validate_snapshot:
let vault_output_utxo = find_vault_output(tx.outputs, vault_addr)
let vault_lamp_qty = assets.quantity_of(vault_output_utxo.value, lamp_policy_id, #"744c414d50")
expect vault_lamp_qty == applied_input.lamp_balance
```

Nguồn gap: vault.ak:162-210 (không có `quantity_of`). WithdrawLamp reference: vault.ak:309-313.

### 7.2 Double-satisfaction guard

Validator dùng `own_ref` (OutputReference của vault input đang spend) để tìm chính xác vault address, rồi kiểm tra `vault_input_count == 1`. Điều này ngăn một tx spend 2 vaults khác nhau và ghi kết quả chỉ cho 1 — tấn công double-satisfaction. Nguồn: `vault.ak:115-118`, `vault.ak:241-244`.

---

## 8. apply_pending_profile — mandatory pattern

`apply_pending_profile` (profile.ak:19) phải được gọi ở ĐẦU mỗi handler (TriggerSnapshot, WithdrawLamp...) và kết quả `applied_input` phải dùng cho **cả 2 việc:**
1. Tính toán M.
2. Kiểm tra output datum.

Nếu chỉ dùng cho tính M nhưng không dùng cho output datum check → `pending_profile` sẽ không được clear → lần sau lại fire → "infinite pending bug". Nguồn: `profile.ak:4-15`.

Lưu ý: WithdrawLamp không gọi `apply_pending_profile` vì nó không advance `last_updated_epoch` và không tính M. Profile change chỉ có hiệu lực thực sự khi trigger snapshot.

---

## 9. Deploy dependencies

| Thứ tự | Artifact | Env var sau deploy |
|---|---|---|
| 1 | LAMP minting policy | `LAMP_POLICY_ID` |
| 2 | Vault validator (`aiken build` → `plutus.json`) | `VAULT_SCRIPT_HASH` |
| 3 | (UM NFT — không cần cho SnapshotGen riêng) | `UM_NFT_POLICY_ID` |

Vault validator nhận 2 tham số compile-time:
- `lamp_policy_id = LAMP_POLICY_ID`
- `ms_per_epoch = 86_400_000` (Preview) hoặc `432_000_000` (Mainnet)

Asset name LAMP: `#"744c414d50"` = UTF-8 "tLAMP" (canonical — PR `bcbd8205`). Nguồn: `vault.ak:312`.

Không cần Shard NFT hay UM NFT trong SnapshotGen transactions (T16).
