# TECH — ConsolidateHoldings (§6.9)
GenMAGIC v3.3 · Aiken PlutusV3 + TypeScript offchain

> **Module MỒ CÔI — chưa được quyết hội tụ hay dời `Legacy/`.** Xem
> [`DEVSTATUS.md`](../DEVSTATUS.md). Nguồn chân lý mô hình:
> [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](../SPEC/MagicLamp-Tripletoken-Feat-(Vi).md);
> số mục "§6.9" là di sản đánh số GenMAGIC v3.3, không phải mục lục spec canonical.
> Validator ở đây là **script hash RIÊNG** (`vault_consolidate`, `onchain/aiken.toml`
> riêng, build standalone bình thường), nên UTxO nằm ở địa chỉ vault InstantGen **không
> bao giờ chạy** validator này — mọi mô tả eUTXO dưới đây chỉ đúng trong phạm vi địa chỉ
> của chính `vault_consolidate`.

---

## 1. Aiken types và Plutus Data encoding

### 1a. LoyaltyHolding

File: `onchain/lib/magiclamp/protocol/types.ak:37-41`

```aiken
pub type LoyaltyHolding {
  amount         : Natural,   // Int (BigInt onchain)
  acquired_epoch : Natural,
  is_locked      : Bool,
}
```

Plutus Data: `Constr 0 [Integer(amount), Integer(acquired_epoch), Bool(is_locked)]`
- `Bool(True)` = `Constr 1 []`; `Bool(False)` = `Constr 0 []`

### 1b. VaultDatum (đầy đủ 17 field)

File: `onchain/lib/magiclamp/protocol/types.ak:102-120`

Thứ tự constructor (index ↔ Plutus tag) — KHÔNG được đảo:

```
index  field                   type
0      owner                   ByteArray
1      lamp_balance            Natural
2      lamp_locked             Natural
3      loyalty_holdings        List<LoyaltyHolding>
4      magic_batches           List<MagicBatch>
5      next_batch_index        Natural
6      vacuum_orders           List<VacuumOrder>
7      gen_schedules           List<GenSchedule>
8      profile                 ActivityProfile
9      profile_changed_epoch   Natural
10     pending_profile         Option<PendingProfile>
11     last_updated_epoch      Natural
12     delegation_cert         DelegationCertificate
13     activity_state          ActivityState
14     streak_state            StreakState
15     personal_delegate       Option<ByteArray>
16     attribution             VaultAttribution
```

**Lý do quan trọng:** Validator `vault_consolidate.ak` decode toàn bộ 17 field (audit fix Bug 1). Nếu offchain encode thiếu field hoặc sai thứ tự → CBOR decode fail onchain → vault bị khoá. File: `vault_consolidate.ak:8-18`.

### 1c. ActivityProfile

```aiken
pub type ActivityProfile {
  Ember    // Constr 0 []
  Flame    // Constr 1 []
  Lantern  // Constr 2 []
}
```

File: `types.ak:19-23`.

### 1d. ConsolidateRedeemer

```aiken
pub type ConsolidateRedeemer {
  Consolidate   // Constr 0 []
}
```

File: `vault_consolidate.ak:31-33`.

---

## 2. Validator logic (vault_consolidate.ak)

File: `vault_consolidate.ak:36-103`.

### Invariant list

| Ký hiệu | Code line | Phát biểu |
|---|---|---|
| W-1 (C-PC-V1) | :48 | `datum.owner ∈ tx.extra_signatories` |
| W-2 (C-DOUBLE-SAT) | :51 | `count_inputs_at_script(inputs, own_hash) = 1` |
| W-3 (C-DOUBLE-SAT) | :52 | `count_outputs_at_script(outputs, own_hash) = 1` |
| W-4 (C-FIELD-LOCK owner) | :61 | `output.owner = datum.owner` |
| W-5 (C-FIELD-LOCK lamp_balance) | :62 | `output.lamp_balance = datum.lamp_balance` |
| W-6 (C-FIELD-LOCK lamp_locked) | :63 | `output.lamp_locked = datum.lamp_locked` |
| W-7 (C-FIELD-LOCK magic_batches) | :64 | `output.magic_batches = datum.magic_batches` |
| W-8 (C-FIELD-LOCK next_batch_index) | :65 | `output.next_batch_index = datum.next_batch_index` |
| W-9 (C-FIELD-LOCK vacuum_orders) | :66 | `output.vacuum_orders = datum.vacuum_orders` |
| W-10 (C-FIELD-LOCK gen_schedules) | :67 | `output.gen_schedules = datum.gen_schedules` |
| W-11 (C-FIELD-LOCK profile) | :68 | `output.profile = datum.profile` |
| W-12 (C-FIELD-LOCK profile_changed_epoch) | :69 | `output.profile_changed_epoch = datum.profile_changed_epoch` |
| W-13 (C-FIELD-LOCK pending_profile) | :70 | `output.pending_profile = datum.pending_profile` |
| W-14 (C-FIELD-LOCK last_updated_epoch) | :71 | `output.last_updated_epoch = datum.last_updated_epoch` |
| W-15 (C-FIELD-LOCK delegation_cert) | :72 | `output.delegation_cert = datum.delegation_cert` |
| W-16 (C-FIELD-LOCK activity_state) | :73 | `output.activity_state = datum.activity_state` |
| W-17 (C-FIELD-LOCK streak_state) | :74 | `output.streak_state = datum.streak_state` |
| W-18 (C-FIELD-LOCK personal_delegate) | :75 | `output.personal_delegate = datum.personal_delegate` |
| W-19 (C-FIELD-LOCK attribution) | :76 | `output.attribution = datum.attribution` |
| W-20 (C-CONSOLIDATE-4) | :79-80 | `|output.loyalty_holdings| < |datum.loyalty_holdings|` |
| W-21 (C-CONSOLIDATE-5) | :83-85 | `Σ output.amounts = Σ input.amounts` |
| W-22 (C-CONSOLIDATE-6) | :87-90 | `Σ locked output = Σ locked input` |
| W-23 (C-VAULT-10) | :93 | `sum_out = datum.lamp_balance` |
| W-24 (C-VAULT-8) | :96 | `datum.lamp_locked ≤ datum.lamp_balance` |

**Lưu ý:** W-4..W-19 là kết quả audit fix Bug 1 (vault_consolidate.ak:8-18) — validator cũ dùng VaultDatum rút ngắn, không thấy field bị tamper → nguy cơ DRAIN. Fix: dùng VaultDatum đầy đủ + so sánh field-by-field.

### Luồng thực thi validator

```
spend(datum_opt, _redeemer, own_ref, tx):
  1. datum     = unwrap(datum_opt)
  2. own_addr  = util.own_address(own_ref, tx.inputs)  -- tìm UTxO đang spend
  3. own_hash  = script hash từ own_addr.payment_credential
  4. W-1: owner ký
  5. W-2,W-3: đúng 1 input + 1 output (script hash, không phải Address)
  6. output    = decode InlineDatum từ output UTxO
  7. W-4..W-19: field-by-field equality (16 field cố định)
  8. W-20: length reduction
  9. W-21: sum conservation
  10. W-22: locked sum conservation
  11. W-23: Σholdings = lamp_balance
  12. W-24: lamp_locked ≤ lamp_balance
  return True
```

### else handler

```aiken
else(_) { fail }
```

Từ chối mọi redeemer không phải `Consolidate` (vault_consolidate.ak:101-103).

---

## 3. eUTXO flow

```
[Wallet]
   │
   ├─ Đọc vault UTxO (datum: VaultDatum_in)
   │
   ├─ Tính toán offchain:
   │   newHoldings = consolidateHoldings(VaultDatum_in.loyalty_holdings)
   │   validateConsolidate(old, new) → ok
   │
   └─ Build + submit tx:
       ┌─────────────────────────────────────────────────────┐
       │  INPUTS                      OUTPUTS                │
       │  ─────                       ───────                │
       │  vault UTxO                  vault UTxO'            │
       │    addr: ScriptAddr(hash)      addr: ScriptAddr(hash)│
       │    datum: VaultDatum_in        datum: VaultDatum_out │
       │    redeemer: Consolidate       (chỉ loyalty_holdings │
       │                                thay đổi)            │
       │                                                     │
       │  SIGNATORIES                                        │
       │    datum.owner (pubkey hash)                        │
       └─────────────────────────────────────────────────────┘
```

**Điểm quan trọng — double-satisfaction:**
- `util.count_inputs_at_script` đếm theo `payment_credential` (Script hash), không theo `Address` đầy đủ (util.ak:30-33).
- Một attacker có thể tạo 2 vault UTxO: `ScriptAddr(hash, None)` và `ScriptAddr(hash, stakeKey)`. Nếu đếm theo Address → cả 2 khác Address → validator chỉ thấy 1 → double-satisfaction thành công.
- Fix: đếm theo script hash → cả 2 cùng hash → count = 2 → validator reject (test `consolidate_double_satisfaction_stake_cred` tại `vault_consolidate.ak:216-235`).

---

## 4. Offchain SDK (TypeScript)

File: `offchain/src/consolidate.ts`.

### Functions

| Hàm | Mô tả | Ref |
|---|---|---|
| `consolidateHoldings(holdings)` | Entry point chính; trả `LoyaltyHolding[]` đã merge | `:25` |
| `mergeGroup(group)` | Sort + lặp merge adjacent pairs `epoch_diff ≤ 1` | `:50` |
| `validateReduced(in, out)` | C-CONSOLIDATE-4 check | `:86` |
| `validateTotalConserved(in, out)` | C-CONSOLIDATE-5 check | `:91` |
| `validateLockedConserved(in, out)` | C-CONSOLIDATE-6 check | `:98` |
| `validateConsolidate(in, out)` | Gọi cả 3 check trên; throw nếu vi phạm | `:105` |
| `canConsolidate(holdings)` | Kiểm tra nhanh trước khi build tx | `:122` |

### Kiểu dữ liệu (TypeScript ↔ Aiken P8)

```typescript
// @magiclamp/protocol-utils
type LoyaltyHolding = {
  amount         : bigint;   // ← BigInt (không Number)
  acquired_epoch : bigint;   // ← BigInt
  is_locked      : boolean;
};
```

BigInt bắt buộc cho `amount` và `acquired_epoch` (C-OVERFLOW invariant). `cmpBigIntAsc` từ `@magiclamp/protocol-utils` so sánh BigInt an toàn (consolidate.ts:10).

---

## 5. Deploy dependencies

ConsolidateHoldings là module độc lập — không phụ thuộc UM NFT, Shard NFT, hay bất kỳ oracle nào. Chỉ cần:

1. Vault script đã deploy (script hash tham chiếu trong địa chỉ vault UTxO).
2. `LAMP_POLICY_ID` (để encode LAMP amounts trong value — nếu LAMP native asset trong UTxO).
3. Owner pubkey hash (có sẵn trong `datum.owner`).

Build onchain:
```bash
cd Consolidate/onchain && aiken build
# Tạo plutus.json chứa script hash
```

Test offchain:
```bash
cd Consolidate/offchain && npm install && npm test
# TV-CONSOLIDATE-01/02/03 + 6 test bổ sung = 9 test tổng
```
