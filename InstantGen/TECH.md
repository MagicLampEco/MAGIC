# InstantGen — Technical Specification
## GenMAGIC v3.3 · Aiken PlutusV3 + TypeScript SDK

---

## 1. Aiken types và Plutus Data encoding

### 1.1 VaultRedeemer (types.ak:153)

```aiken
pub type VaultRedeemer {
  InstantGen    { lamp_paid: Natural }   // constr 0
  ApplyHalving                           // constr 1
  BurnBatch     { burns: List<...> }     // constr 2
  UpdateProfile { new_profile: ... }     // constr 3
  WithdrawLamp  { amount: Natural }      // constr 4
}
```

Plutus Data encoding: `Constr 0 [I lamp_paid]`. TypeScript: `VaultRedeemerSchema` (`types.ts:165`).

**QUAN TRỌNG:** Thứ tự constructor = tag on-chain. Không được reorder.

### 1.2 MagicBatch (types.ak:28)

```aiken
pub type MagicBatch {
  batch_id            : ByteArray,
  source              : BatchSource,           // Snapshot=0, Instant=1, Vacuum=2, Schedule=3
  created_epoch       : Natural,
  initial_amount      : Natural,
  current_amount      : Natural,
  decay_window        : Natural,
  profile_at_creation : Option<ActivityProfile>, // None cho Instant (C-DECAY-4)
  contract_id         : Option<ByteArray>,       // None cho Instant
  halved              : Bool,                    // False tại creation, True after k=1 halving
}
```

TypeScript mirror: `MagicBatchSchema` (`types.ts:31`). Thứ tự field = thứ tự Plutus Data list.

### 1.3 VaultDatum (types.ak:124) — 17 fields

Thứ tự field on-chain:
1. owner (ByteArray)
2. lamp_balance
3. lamp_locked
4. loyalty_holdings
5. magic_batches
6. next_batch_index
7. vacuum_orders
8. gen_schedules
9. profile
10. profile_changed_epoch
11. pending_profile
12. last_updated_epoch
13. delegation_cert
14. activity_state
15. streak_state
16. personal_delegate
17. attribution

TypeScript mirror: `VaultDatumSchema` (`types.ts:135`). Sai field-order = decode lỗi on-chain.

### 1.4 UMDatum (types.ak:145)

```aiken
pub type UMDatum {
  smoothed_q         : Natural,
  last_updated_epoch : Natural,
  history            : List<Natural>,   // |history| ≤ 6
}
```

Identified on-chain bởi NFT có policy `um_nft_policy`, asset name `"UMD" = #"554d44"` (`vault.ak:303`).

### 1.5 ActivityProfile (types.ak:18)

```aiken
Ember=0, Flame=1, Lantern=2
```

PM_q: Ember=1.15×, Flame=1.05×, Lantern=1.00×. Nguồn: `constants.ak:47`.

---

## 2. Validator logic — InstantGen redeemer

File: `validators/vault.ak`, function `validate_instant_gen` (line 115).

Validator được parameterize bởi:
- `lamp_policy_id`: PolicyId LAMP token
- `treasury_addr`: Address Treasury (phải là Script credential, kiểm tra tại line 199)
- `um_nft_policy`: PolicyId UM datum NFT
- `ms_per_epoch`: POSIX ms / epoch (Mainnet=432_000_000; Preview=86_400_000)

### Danh sách invariants theo thứ tự thực thi

**W-n = WithdrawLamp; C-n = InstantGen; A02 = output datum check**

| # | Invariant | Code location | Mô tả |
|---|---|---|---|
| I-1 | Datum present | `vault.ak:63` | `datum_opt = Some(_)` bắt buộc |
| I-2 | current_epoch | `vault.ak:67` | Từ POSIX ms lower bound chia ms_per_epoch |
| C-DS-1 | 1 vault input | `vault.ak:130` | Count inputs cùng vault address = 1 |
| C-PC-V1 | Owner sign | `vault.ak:135` | `owner ∈ tx.extra_signatories` |
| C-PP | Pending profile | `vault.ak:142` | `apply_pending_profile` trước tính M |
| C-INST-1 | Min purchase | `vault.ak:145` | `lamp_paid ≥ 10_000_000` |
| C-INST-2 | Max purchase | `vault.ak:148` | `lamp_paid ≤ 10_000_000_000_000` |
| C-INST-3 | L_avail | `vault.ak:151` | `lamp_paid ≤ lamp_balance - lamp_locked` |
| C-INST-7 | Batch count | `vault.ak:155` | active (non-expired) batches < 32 |
| C-UM-3 | UM range | `vault.ak:164` | `smoothed_q ∈ [500M, 2B]` |
| C-UM-2 | UM history | `vault.ak:165` | `|history| ≤ 6` |
| C-UM-6 | UM stale | `vault.ak:166` | staleness > 1 → fallback 0.5× |
| C-INST-5 | M > 0 | `vault.ak:171` | sanity check sau compute |
| C-PRUNE-2 | Halve first | `vault.ak:175` | `halve_then_prune` (halving trước prune) |
| C-INST-6 | New batch | `vault.ak:178` | `halved=False`, `source=Instant`, `profile_at_creation=None` |
| C-INST-4 | Treasury Script | `vault.ak:199` | treasury_addr phải là Script credential |
| C-INST-4b | Treasury LAMP | `vault.ak:200` | treasury nhận ≥ lamp_paid |
| A02-1..n | Output datum | `vault.ak:203` | 17 fields field-by-field |
| C-VAULT-10 | Holdings sum | `vault.ak:225` | Σholdings = lamp_balance |
| C-VAULT-8 | lamp_locked | `vault.ak:228` | lamp_locked ≤ lamp_balance |
| C-VAULT-13 | Holdings count | `vault.ak:231` | |holdings| ≤ 64 |
| C-VAULT-1 | Batch count | `vault.ak:237` | |magic_batches| ≤ 32 |
| C-VAULT-3 | Index++ | `vault.ak:241` | next_batch_index = old + 1 |
| C-VAULT-TS | Epoch update | `vault.ak:244` | last_updated_epoch = current_epoch |
| C-ATT-1/2 | Attribution | `vault.ak:248` | total_events++, last_event_epoch |

### A02 fields bất biến (không đổi trong InstantGen)

Từ `applied_input` (sau profile apply): `owner`, `lamp_locked`, `vacuum_orders`, `gen_schedules`, `profile`, `profile_changed_epoch`, `pending_profile`, `delegation_cert`, `streak_state`, `personal_delegate`.

### A02 fields thay đổi

| Field | Giá trị output |
|---|---|
| lamp_balance | `applied_input.lamp_balance - lamp_paid` |
| loyalty_holdings | `remove_from_holdings(applied_input.loyalty_holdings, lamp_paid)` |
| magic_batches | `halve_then_prune(...) ++ [new_batch]` |
| next_batch_index | `applied_input.next_batch_index + 1` |
| last_updated_epoch | `current_epoch` |
| attribution.total_events | `+ 1` |
| attribution.last_event_epoch | `current_epoch` |

**Lưu ý activity_state:** Không được liệt kê trong A02 check của `validate_instant_gen`. Đây là điểm để theo dõi cho v1.1.

---

## 3. eUTxO flow

```
[Vault UTxO] ──spend──> Validator
                         │
[UM UTxO]    ──refIn──>  │ (read-only, không consume)
                         │
                ┌────────┴────────┐
                │                 │
         [Vault UTxO']     [Treasury UTxO]
         (datum updated)   (receives LAMP)
         (LAMP: old - paid) (LAMP: +paid)
```

**Điểm eUTxO quan trọng:**
- UM datum là reference input — không bị consume. Nhiều InstantGen tx trong cùng block đều đọc được cùng UM UTxO.
- Vault UTxO bị consume → chỉ 1 InstantGen/block/vault. Tự nhiên ngăn race condition.
- LAMP conservation: `vault_output.lamp + treasury_output.lamp == vault_input.lamp` (không cần check tường minh — eUTxO ledger enforce).

---

## 4. Batch ID computation

```
batch_id = blake2b_256(serialize(own_ref) ∥ encode_int(next_batch_index, 8))
```

`own_ref = OutputReference { transaction_id: TxId, output_index: Int }`

Serialization (`vault.ak:473`):
- `transaction_id` (32 bytes) concat `encode_int(output_index, 8-byte big-endian)`
- Index: `bytearray.from_int_big_endian(n, 8)`

P8: off-chain SDK phải dùng cùng encoding. Xem `instant.ts` phần `computeBatchId`.

---

## 5. Deploy dependencies

Validator `vault` cần 4 parameters được apply lúc compile/build:

```
lamp_policy_id  : PolicyId   -- từ deploy LAMP token
treasury_addr   : Address    -- Script address (phải verify là Script credential)
um_nft_policy   : PolicyId   -- từ deploy UM NFT
ms_per_epoch    : Int        -- 86_400_000 (Preview) hoặc 432_000_000 (Mainnet)
```

**Thứ tự apply parameters phải match `aiken.toml`.**

UM datum UTxO phải tồn tại trước khi bất kỳ InstantGen nào có thể chạy (validator `find_um_datum` fail nếu không có reference input với NFT đúng).

---

## 6. Các stub / locked handlers

### ApplyHalving (vault.ak:78)
Hiện chỉ check `owner ∈ extra_signatories`. TODO v1.1: gọi `apply_pending_profile` và tính halving đúng + A02 check.

### BurnBatch (vault.ak:89)
**Hard-locked** với `fail @"BurnBatch locked until v1.1"`. Không thể claim MAGIC đến khi ConsumeMAGIC được implement đầy đủ. Lý do: stub cũ `expect owner_sign; True` không có output constraint → LAMP drain vector.

---

## 7. Off-chain SDK — TypeScript

Các file chính:
- `offchain/src/math.ts` — `computeInstantMagic`, `getUmForInstant`, `shouldHalve`, `applyHalving`, `isExpired`
- `offchain/src/types.ts` — Lucid Data schemas (mirror Aiken types)
- `offchain/src/constants.ts` — constants (P8: phải match constants.ak)
- `offchain/src/instant.ts` — transaction builder `buildInstantGenTx`

**BigInt invariant (C-OVERFLOW):** Mọi amount (oildrop, nanogic, Q-format intermediate) phải dùng `bigint`. Không được dùng `number` cho arithmetic. TV-OVERFLOW-01/02 detect regression.

---

## 8. Protocol-utils dependency

`math.ts` re-export từ `@magiclamp/protocol-utils`:
- `slotToEpoch`, `nanogicToMagicStr`, `qToStr`, `lampToOildrop`, `oildropToLamp`

Các primitive này shared giữa modules — không duplicate trong InstantGen.
