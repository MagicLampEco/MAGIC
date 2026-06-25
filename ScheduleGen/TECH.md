# TECH.md — ScheduleGen Technical Specification
## GenMAGIC v3.3 · §11 ScheduleGen · Cardano Preview Testnet

---

## 1. Aiken Types và Plutus Data Encoding

### 1.1 VaultRedeemer

```aiken
// types.ak:129-147
pub type VaultRedeemer {
  ScheduleCommit { schedule_length: Natural, lamp_per_epoch: Natural }   // constr 0
  ScheduleFire   { schedule_id: ByteArray }                               // constr 1
  BurnBatch      { burns: List<(ByteArray, Natural)> }                    // constr 2
  WithdrawLamp   { amount: Natural }                                      // constr 3
}
```

TypeScript mirror (`types.ts:167-178`):
```typescript
Data.Enum([
  Data.Object({ ScheduleCommit: Data.Object({ schedule_length, lamp_per_epoch }) }),  // constr 0
  Data.Object({ ScheduleFire:   Data.Object({ schedule_id }) }),                       // constr 1
  Data.Object({ BurnBatch:      Data.Object({ burns }) }),                             // constr 2
])
```

Lưu ý: `WithdrawLamp` có trong Aiken (constr 3) nhưng chưa trong TypeScript enum `VaultRedeemerSchema`. Thêm khi implement off-chain WithdrawLamp.

### 1.2 ShardRedeemer

```aiken
// types.ak:150-153
pub type ShardRedeemer {
  ShardUpdateCommit { delta_locked: Natural, delta_committed: Natural }  // constr 0
  ShardUpdateFire   { fires_in_tx: Natural,  lambda: Natural }           // constr 1
}
```

TypeScript mirror (`types.ts:182-192`): khớp hoàn toàn.

### 1.3 GenSchedule

```aiken
// types.ak:51-63
pub type GenSchedule {
  schedule_id              : ByteArray,    // blake2b256(utxo_ref ∥ sched_index)
  commit_epoch             : Natural,
  start_fire_epoch         : Natural,      // = commit_epoch + 2
  end_fire_epoch           : Natural,      // = commit_epoch + L + 1
  schedule_length          : Natural,      // L ∈ [10,200]
  lamp_per_epoch           : Natural,      // λ
  rate_locked_q            : Natural,      // immutable (T8)
  baseline_at_commit_q     : Natural,      // R_snap_c (audit field)
  multiplier_at_commit_q   : Natural,      // S_Q(L) (audit field)
  fired_count              : Natural,      // 0..L
  auto_burn_target         : Option<AutoBurnConfig>,
}
```

TypeScript mirror (`types.ts:70-83`): khớp field-for-field.

### 1.4 ScheduleAggregateShardDatum

```aiken
// types.ak:66-74
pub type ScheduleAggregateShardDatum {
  shard_id                   : Natural,    // 0..15
  shard_locked_lamp          : Natural,    // oildrop
  shard_active_count         : Natural,
  shard_cumulative_committed : Natural,
  shard_cumulative_fired     : Natural,
  last_updated_epoch         : Natural,
  shard_cap                  : Natural,    // 4.5×10^14 oildrop
}
```

---

## 2. Validator Logic

### 2.1 Vault validator — `spend`

Entrypoint: `validators/vault.ak:44-89`.

Tham số validator (applied khi deploy):
- `lamp_policy_id: PolicyId` — policy ID của LAMP token
- `treasury_addr: Address` — địa chỉ Treasury script
- `shard_policy_id: PolicyId` — policy ID của SHARD NFT
- `ms_per_epoch: Int` — 86_400_000 (Preview/Preprod), 432_000_000 (Mainnet)

Invariant chung (áp dụng mọi redeemer):
- **C-VAULT-DS-1:** `count(inputs, addr==vault_addr) == 1` (`vault.ak:62`)
- `current_epoch = tx.validity_range.lower_bound / ms_per_epoch`

### 2.2 validate_commit — C-SCH-1..12, C-SCH-CAP

Nguồn: `vault.ak:134-207`.

| Invariant | Code | Mô tả |
|---|---|---|
| C-VAC-1 equiv | `vault.ak:146` | Owner phải ký tx (`extra_signatories` chứa `datum.owner`) |
| C-SCH-1 | `vault.ak:149` | `L ∈ [10, 200]` |
| C-SCH-2 | `vault.ak:152` | `λ ≥ 1_000_000 oildrop` |
| C-SCH-3 | `vault.ak:155-157` | `L×λ ≤ l_avail(lamp_balance, lamp_locked)` |
| C-SCH-10 | `vault.ak:160` | `|gen_schedules| < 20` |
| C-SCH-RATE | `vault.ak:168` | `check_sch_rate(λ, rate_locked_q)` → `M_i ≥ 1` |
| C-SCH-CAP | `vault.ak:173` | `shard_locked + L×λ ≤ shard_cap` (via find_shard_input) |
| C-SCH-7 | `vault.ak:181` | `start_fire_epoch = current_epoch + schedule_delay` |
| T8 | `vault.ak:184` | `rate_locked_q` ghi vào datum, không recompute sau |
| C-SCH-8/T5 | `vault.ak:193` | `select_lamp_for_lock` khóa youngest-first |
| A02 (output) | `vault.ak:196-205` | Field-by-field check output datum |
| C-VAULT-10 | `vault.ak:204` | `sum_holdings == lamp_balance` |
| C-VAULT-OUT-1 | `vault.ak:388-389` | Đúng 1 output tại vault_addr |

### 2.3 validate_fire — C-FIRE-1..8, C-SCH-FIRE-PERMISSION

Nguồn: `vault.ak:212-289`.

| Invariant | Code | Mô tả |
|---|---|---|
| C-SCH-FIRE-PERMISSION | `vault.ak:223-224` | Không yêu cầu chữ ký owner (comment, không check) |
| C-FIRE-1 ≥ | `vault.ak:232-240` | `count_eligible_fires > 0` |
| T8 | `vault.ak:236` | `compute_m_i(sched.lamp_per_epoch, sched.rate_locked_q)` |
| C-FIRE-3 | `vault.ak:244-245` | Treasury phải là script credential |
| C-FIRE-3 | `vault.ak:245` | `treasury_lamp_received ≥ lamp_transfer` |
| MAX_BATCHES | `vault.ak:251` | `|updated_batches| ≤ 32` |
| C-FIRE-5 | `vault.ak:256-259` | Remove schedule khi `fired_count == L` |
| C-FIRE-6 | `vault.ak:268` | `remove_locked_amount` unlock LAMP |
| C-SCH-FIRE-SHARD | `vault.ak:271-273` | `shard_datum.shard_id == shard_id_val` |
| A02 (output) | `vault.ak:276-286` | `lamp_balance -= lamp_transfer`, `lamp_locked -= lamp_transfer`, etc. |
| C-VAULT-10 | `vault.ak:286` | `sum_holdings == lamp_balance` |

### 2.4 Shard validator

Nguồn: `vault.ak:95-129`.

**ShardUpdateCommit:**
| Invariant | Code | Mô tả |
|---|---|---|
| | `shard:108-109` | `shard_locked += delta_locked`, `≤ shard_cap` |
| C-SCH-CAP (T13) | `shard:109` | `output.shard_locked ≤ shard_cap` |
| | `shard:110` | `shard_active_count += 1` |
| | `shard:111` | `shard_cumulative_committed += delta_committed` |
| | `shard:112` | `shard_cumulative_fired` không đổi |
| | `shard:113-114` | `shard_id` và `shard_cap` bất biến |

**ShardUpdateFire:**
| Invariant | Code | Mô tả |
|---|---|---|
| | `shard:120-121` | `shard_locked -= fires_in_tx × lambda` |
| | `shard:122` | `shard_cumulative_fired += fires_in_tx × lambda` |
| | `shard:123` | `shard_active_count ≤ input` (có thể giảm nếu complete) |

### 2.5 validate_withdraw_lamp — W-1..W-7

Nguồn: `vault.ak:396-451`.

| Invariant | Code | Mô tả |
|---|---|---|
| W-1 | `vault.ak:406` | `amount > 0` |
| W-2 | `vault.ak:408` | Owner ký |
| W-3 | `vault.ak:410-411` | `amount ≤ l_avail` |
| W-5 | `vault.ak:415-438` | Field-by-field output datum — tất cả fields khác PRESERVED |
| W-5 (key) | `vault.ak:438` | `last_updated_epoch` PRESERVED — không advance (PR #11 pt4) |
| W-6 | `vault.ak:441-444` | Vault output LAMP value = `new_lamp_balance` |
| W-7 | `vault.ak:447` | `sum_holdings == lamp_balance` |

---

## 3. eUTXO Flow

### 3.1 Commit Tx

```
Inputs:
  - Vault UTxO (spend, redeemer: ScheduleCommit{L, λ})
  - Shard UTxO [shard_id] (spend, redeemer: ShardUpdateCommit{delta_locked, delta_committed})

Outputs:
  - Vault UTxO' (updated datum: lamp_locked += L×λ, gen_schedules appended)
  - Shard UTxO' (updated datum: shard_locked += L×λ, active_count += 1)

Signatories: [owner.pkh]   (required by C-VAC-1 equivalent)
Validity: [tipPosixMs .. (commit_epoch+1) × ms_per_epoch - 1]
```

### 3.2 Fire Tx

```
Inputs:
  - Vault UTxO (spend, redeemer: ScheduleFire{schedule_id})
  - Shard UTxO [shard_id] (spend, redeemer: ShardUpdateFire{fires_in_tx, lambda})

Outputs:
  - Vault UTxO' (lamp_balance -= N×λ, lamp_locked -= N×λ, magic_batches += N new)
  - Shard UTxO' (shard_locked -= N×λ, cumulative_fired += N×λ)
  - Treasury (LAMP: N×λ)

Signatories: []   (EMPTY — C-SCH-FIRE-PERMISSION)
Validity: [tipPosixMs .. (current_epoch+1) × ms_per_epoch - 1]
```

`N = fires_in_tx` (1..8).

### 3.3 Quan hệ eUTXO

- Vault và Shard đều bị spend trong cùng 1 tx (không thể reference).
- **Không** có double-spend guard phức tạp giữa vault và shard vì chúng là 2 địa chỉ khác nhau.
- Guard double-spend vault: `C-VAULT-DS-1` (`count(inputs, addr==vault_addr)==1`).
- Shard chỉ có 1 UTxO per shard_id tại một thời điểm → không cần guard thêm.

---

## 4. Deploy Dependencies

### 4.1 Thứ tự deploy

```
1. Deploy LAMP policy (mint tLAMP) → LAMP_POLICY_ID
2. Deploy UMKeeper (optional — không dùng trong ScheduleGen)
3. Deploy Shard validator → SHARD_SCRIPT_HASH
4. Deploy Vault validator (4 params: LAMP_POLICY_ID, TREASURY_ADDR, SHARD_NFT_POLICY_ID, MS_PER_EPOCH)
   → VAULT_SCRIPT_HASH
5. Deploy 16 Shard UTxOs (one per shard_id 0..15)
6. Update scripts/.env
```

### 4.2 Env vars cần thiết

```
LAMP_POLICY_ID=<hash>
VAULT_SCRIPT_HASH=<hash>       # từ aiken build → plutus.json
SHARD_SCRIPT_HASH=<hash>       # từ aiken build → plutus.json
SHARD_NFT_POLICY_ID=<hash>     # one-shot minting policy cho SHARD NFTs
TREASURY_ADDRESS=<addr>        # PHẢI là script address, không phải wallet
MS_PER_EPOCH=86400000          # Preview/Preprod; 432000000 Mainnet
BLOCKFROST_KEY=<key>
PRIVATE_KEY=<hex>
```

### 4.3 Build command

```bash
cd ScheduleGen/onchain && aiken build
# → plutus.json chứa vault và shard compiled validators
```

---

## 5. ID Computation (P8 — bit-identical on/off chain)

### schedule_id

```
schedule_id = blake2b_256(tx_hash ∥ u64BE(output_index) ∥ u64BE(sched_index))
```

Onchain: `math.ak:119-127`.
Offchain: `schedule.ts:382-384` via `h(vaultUtxo, BigInt(schedIndex))`.

### batch_id

```
batch_id = blake2b_256(tx_hash ∥ u64BE(output_index) ∥ u64BE(batch_index))
```

Onchain: `math.ak:130-137`.
Offchain: `schedule.ts:385-387`.

### shard_id

```
shard_id = blake2b_256(owner_pkh)[0] % 16
```

Onchain: `math.ak:99-102` (`crypto.blake2b_256 + bytearray.at(hash,0) % 16`).
Offchain: `math.ts:89-92` (`blake2b(Buffer.from(pkh,"hex"),{dkLen:32})[0] % 16`).

---

## 6. Aiken Tests (on-chain)

Có 6 test trong `vault.ak:575-623`:

| Test | Loại | Mô tả |
|---|---|---|
| `w_positive_partial` | positive | WithdrawLamp bình thường |
| `w_amount_zero` | negative (fail) | amount=0 bị reject (W-1) |
| `w_over_avail` | negative (fail) | amount > l_avail bị reject (W-3) |
| `w_no_owner_sig` | negative (fail) | Không có chữ ký owner bị reject (W-2) |
| `w_phantom_second_output` | negative (fail) | 2 vault outputs bị reject (C-VAULT-OUT-1) |
| `w_advance_last_updated_rejected` | negative (fail) | Advance `last_updated_epoch` bị reject (W-5) |
