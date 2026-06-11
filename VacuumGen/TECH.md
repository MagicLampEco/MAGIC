# VacuumGen — Technical Specification
## GenMAGIC v3.3 · §10 Aiken/TypeScript Implementation

---

## 1. Cấu trúc file

```
VacuumGen/
├── onchain/
│   ├── aiken.toml
│   └── lib/magiclamp/protocol/
│       ├── types.ak       # Data types + Plutus Data constructor indices
│       ├── constants.ak   # VBR, SM, VACUUM_DELAY, limits
│       ├── math.ak        # compute_vacuum_magic, get_sm_q, get_um_for_vacuum
│       └── lock.ak        # select_lamp_for_lock, remove_locked_amount, remove_newest_first
│   └── validators/
│       └── vault.ak       # VacuumCommit + VacuumFire + WithdrawLamp + BurnBatch + SetDelegate
├── offchain/src/
│   ├── constants.ts       # Mirror của constants.ak
│   ├── math.ts            # computeVacuumMagic, getSmQ, getUmForVacuum (P8)
│   ├── types.ts           # VaultDatumSchema, VaultRedeemerSchema (Lucid Data)
│   └── vacuum.ts          # buildVacuumCommitTx, buildVacuumFireTx
└── tests/
    ├── vectors.ts          # NORMATIVE test vectors (App B)
    └── vacuum.test.ts      # Unit + integration tests
```

---

## 2. Aiken Types và Plutus Data Encoding

### 2.1 BatchSource — constructor index

```aiken
// types.ak:10-15
pub type BatchSource {
  Snapshot   // constr 0
  Instant    // constr 1
  Vacuum     // constr 2
  Schedule   // constr 3
}
```

VacuumGen tạo batch với `source = Vacuum` (constructor 2).

### 2.2 VaultRedeemer — constructor index

```aiken
// types.ak — VaultRedeemer (8 variants, append-only)
pub type VaultRedeemer {
  VacuumCommit { lambda: Natural }            // constr 0
  VacuumFire   { order_id: ByteArray }        // constr 1
  InstantGen   { lamp_paid: Natural }         // constr 2
  ApplyHalving                                // constr 3
  BurnBatch    { burns: List<(ByteArray, Int)> } // constr 4 — datum-consume (D1)
  UpdateProfile { new_profile: ActivityProfile } // constr 5
  WithdrawLamp  { amount: Natural }           // constr 6
  SetDelegate  { new_delegate: Option<ByteArray> } // constr 7 — set/clear consume-delegate
}
```

VacuumGen module xử lý các redeemer: `VacuumCommit` (0), `VacuumFire` (1),
`WithdrawLamp` (6), `BurnBatch` (4), `SetDelegate` (7). Các redeemer còn lại
(`InstantGen`, `ApplyHalving`, `UpdateProfile`) thuộc module khác cùng vault và
bị catch-all của validator này từ chối.

**Quan trọng**: enum này append-only. Variant mới chỉ được thêm ở CUỐI. Constructor
index khớp 1-1 với `VaultRedeemerSchema` trong `offchain/src/types.ts` (constr 0-7) —
nguồn đối chiếu chuẩn (types.ts:171-186).

### 2.3 MagicBatch — field order (bất biến, A02)

```aiken
// types.ak:28-38
pub type MagicBatch {
  batch_id            : ByteArray,
  source              : BatchSource,
  created_epoch       : Natural,
  initial_amount      : Natural,
  current_amount      : Natural,
  decay_window        : Natural,
  profile_at_creation : Option<ActivityProfile>,  // None cho Vacuum
  contract_id         : Option<ByteArray>,        // None cho Vacuum
  halved              : Bool,                     // False cho Vacuum
}
```

VacuumGen batch: `decay_window = 1`, `profile_at_creation = None`, `contract_id = None`, `halved = False`.

### 2.4 VacuumOrder

```aiken
// types.ak:48-53
pub type VacuumOrder {
  order_id     : ByteArray,   // blake2b256(utxo_ref ∥ commit_epoch ∥ lambda)
  commit_epoch : Natural,
  fire_epoch   : Natural,     // = commit_epoch + 2
  lamp_amount  : Natural,
}
```

### 2.5 VaultDatum — các field liên quan VacuumGen

```aiken
// types.ak:124-142
pub type VaultDatum {
  owner                 : ByteArray,
  lamp_balance          : Natural,
  lamp_locked           : Natural,
  loyalty_holdings      : List<LoyaltyHolding>,
  magic_batches         : List<MagicBatch>,
  next_batch_index      : Natural,
  vacuum_orders         : List<VacuumOrder>,
  // ...
  last_updated_epoch    : Natural,
  streak_state          : StreakState,
  personal_delegate     : Option<ByteArray>,  // consume-delegate (paymaster); None = owner-only
  attribution           : VaultAttribution,   // engagement accounting (BurnBatch tăng total_events)
  // ...
}
```

`personal_delegate` (field 15) là consume-delegate: khi `Some(d)`, cả owner và `d`
được phép kích hoạt `BurnBatch`; khi `None`, chỉ owner. `SetDelegate` (owner-only)
đổi giá trị này.

---

## 3. Validator Logic

### 3.1 validate_vacuum_commit — Invariant list

| Ref | Code (vault.ak) | Kiểm tra |
|---|---|---|
| C-VAULT-DS-1 | dòng 89-91 | Đúng 1 vault input |
| C-VAC-1 | dòng 93-94 | `extra_signatories` chứa `input_datum.owner` |
| C-VAC-3 | dòng 96-97 | `lambda >= min_vacuum_amount (1_000_000)` |
| C-VAC-2 | dòng 99-101 | `lambda <= l_avail(lamp_balance, lamp_locked)` |
| C-VAC-5 | dòng 103-104 | `|vacuum_orders| < max_vacuum_orders (10)` |
| — | dòng 106-113 | Tính `order_id`, tạo `VacuumOrder` với `fire_epoch = commit_epoch + 2` |
| T5 | dòng 115-116 | `new_holdings = select_lamp_for_lock(holdings, lambda)` |
| A02 | dòng 118-145 | Kiểm tra từng field của output datum |
| C-VAULT-9 | dòng 138-139 | `lamp_locked == sum_locked(new_holdings)` |
| C-VAULT-10 | dòng 141-142 | `sum_holdings(output_holdings) == lamp_balance` |

**Output datum changes tại Commit**:
- `lamp_locked += lambda`
- `loyalty_holdings` = new holdings sau lock
- `vacuum_orders` = concat cũ + [new_order]
- `last_updated_epoch = current_epoch`
- Tất cả field khác bất biến

### 3.2 validate_vacuum_fire — Invariant list

| Ref | Code (vault.ak) | Kiểm tra |
|---|---|---|
| C-VAULT-DS-1 | dòng 167-168 | Đúng 1 vault input |
| C-VAC-FIRE-PERMISSION | dòng 169-170 | Không check owner signature |
| — | dòng 172-173 | Tìm order theo `order_id` — fail nếu không tồn tại |
| C-VAC-6 | dòng 175-177 | `current_epoch == order.fire_epoch` (EXACT) |
| C-UM-7 | dòng 179-181 | `um_q = get_um_for_vacuum(um_datum)` — smoothed, no stale |
| — | dòng 183-184 | `sm_q = compute_sm_q(streak_state)` |
| C-VAC-PRUNE | dòng 186-189 | Prune batches: giữ nếu `current_epoch - created < decay_window` |
| C-VAC-FIRE-FULL-VAULT | dòng 192-211 | Tính M_v nếu còn slot; M=0 nếu đầy |
| INV-43 / C-VAC-7 | dòng 213-217 | `treasury_receives_lamp >= order.lamp_amount`; treasury phải là Script |
| — | dòng 219-220 | Xoá order khỏi `vacuum_orders` |
| — | dòng 222-223 | `remove_locked_amount(holdings, order.lamp_amount)` |
| A02 | dòng 225-254 | Kiểm tra từng field output datum, bao gồm `activity_state` và `attribution` |
| C-VAULT-OUT-1 | dòng 281-284 | Đúng 1 vault output (`find_vault_output`) |
| C-VAULT-10 | dòng 253-254 | `sum_holdings == lamp_balance` |

**Output datum changes tại Fire**:
- `lamp_balance -= lambda`
- `lamp_locked -= lambda`
- `loyalty_holdings` = sau `remove_locked_amount`
- `magic_batches` = pruned_batches ± new_batch
- `next_batch_index += 1` nếu batch_created, giữ nguyên nếu M=0
- `vacuum_orders` = bỏ order đã fire
- `last_updated_epoch = current_epoch`
- Tất cả field khác bất biến (bao gồm `activity_state` và `attribution` — A02 kiểm tra tường minh)

### 3.3 validate_withdraw_lamp — Invariant list (W-1..W-7)

| Ref | Code (vault.ak) | Kiểm tra |
|---|---|---|
| W-1 | dòng 308-309 | `amount > 0` |
| W-2 | dòng 310-311 | Owner signature |
| W-3 | dòng 312-314 | `amount <= l_avail` (LAMP chưa locked) |
| W-4 | dòng 315-316 | Đúng 1 vault input |
| W-5 | dòng 317-338 | A02 field-by-field; `last_updated_epoch` bất biến (PR #11) |
| W-6 | dòng 340-346 | Vault output LAMP value = `new_lamp_balance` |
| W-7 | dòng 348-349 | `sum_holdings == lamp_balance` |

`remove_newest_first` dùng cho Withdraw (khác với `remove_locked_amount` cho Fire).

### 3.4 validate_burn_batch — datum-consume (D1)

MAGIC là số kế toán trong `magic_batches[]`; "tiêu MAGIC" = hạ `current_amount`
của các batch đích. KHÔNG có token, KHÔNG `tx.mint`. Coupling giá (`Σ burns ==
required`) do validator co-spend `ConsumeMAGIC` (đọc PriceParam beacon) cưỡng chế —
handler này chỉ sở hữu tính đúng của phép trừ + A02 + bảo toàn value + auth.

| Ref | Code (vault.ak) | Kiểm tra |
|---|---|---|
| DS-1 | `validate_burn_batch` | Đúng 1 vault input + đúng 1 vault output |
| AUTH | — | `owner` HOẶC `personal_delegate` ký (consume-delegate, paymaster) |
| — | — | `burns` không rỗng (no-op vô nghĩa) |
| Decay | `prune_expired` | Prune batch hết hạn TRƯỚC khi áp burns (cliff `decay_window=1`) |
| Subtract | `apply_burns` | Mỗi `(batch_id, amount)`: đúng 1 batch khớp id; `0 < amount ≤ current_amount`; trừ tại chỗ; prune nếu về 0; thứ tự batch khác giữ nguyên |
| A02 | — | 17 field; chỉ `magic_batches` + `last_updated_epoch` + `attribution` đổi |
| Attribution | — | `total_events += 1`, `last_event_epoch = current_epoch` |
| Value | — | LAMP value của vault output == `lamp_balance` (BurnBatch KHÔNG đụng LAMP) |

**Cross-module invariant**: vault chỉ được khởi tạo cùng địa chỉ engagement
validator; mọi BurnBatch coupling-giá BẮT BUỘC co-spend PriceParam beacon. Owner
tự-burn MAGIC của chính mình (không coupling) là hợp lệ vì chỉ tự huỷ tài sản
mình. Xem EXEC.md mục deploy-runbook + monitoring.

### 3.5 validate_set_delegate — owner đặt/xoá consume-delegate

| Ref | Code (vault.ak) | Kiểm tra |
|---|---|---|
| DS-1 | `validate_set_delegate` | Đúng 1 vault input + đúng 1 vault output |
| AUTH | — | CHỈ `owner` được đổi delegate (delegate không tự đổi được) |
| A02 | — | Mọi field bất biến trừ `personal_delegate` (= `new_delegate`) + `last_updated_epoch` |
| Value | — | LAMP value của vault output == `lamp_balance` |

Không cooldown — đổi delegate rẻ về kinh tế và đảo ngược được.

---

## 4. eUTXO Flow

### 4.1 VacuumCommit

```
Inputs:
  - Vault UTxO (spend, redeemer VacuumCommit{lambda})

Outputs:
  - Vault UTxO (inline datum updated: lamp_locked+lambda, new order)

Required signatories:
  - owner (C-VAC-1)

LAMP movement: không (vẫn ở vault)
```

### 4.2 VacuumFire

```
Inputs:
  - Vault UTxO (spend, redeemer VacuumFire{order_id})

Reference inputs:
  - UM NFT UTxO (chứa UMDatum — C-UM-7, không spend)

Outputs:
  - Vault UTxO (inline datum updated: lamp-lambda, order removed, batch±)
  - Treasury (lambda LAMP — INV-43)

Required signatories: NONE (C-VAC-FIRE-PERMISSION)

LAMP movement: vault → treasury (lambda)
```

**Double-satisfaction guard**: validator dùng `own_ref` để tìm địa chỉ vault, sau đó `list.count == 1` trên cả inputs và outputs. Ngăn 2 vault UTxOs bị spend trong cùng 1 tx.

### 4.3 WithdrawLamp

```
Inputs:
  - Vault UTxO (spend, redeemer WithdrawLamp{amount})

Outputs:
  - Vault UTxO (inline datum: lamp_balance-amount, holdings trimmed newest-first)
  - User wallet (amount LAMP)

Required signatories: owner (W-2)
```

### 4.4 BurnBatch (datum-consume)

```
Inputs:
  - Vault UTxO (spend, redeemer BurnBatch{burns})
  - [co-spend] ConsumeMAGIC engagement UTxO (ép Σburns == required)

Reference inputs:
  - PriceParam beacon (do ConsumeMAGIC đọc — ngoài phạm vi module này)

Outputs:
  - Vault UTxO (inline datum: magic_batches giảm current_amount, attribution++)

Required signatories: owner HOẶC personal_delegate

LAMP movement: không (BurnBatch chỉ chạm magic_batches)
```

### 4.5 SetDelegate

```
Inputs:
  - Vault UTxO (spend, redeemer SetDelegate{new_delegate})

Outputs:
  - Vault UTxO (inline datum: personal_delegate = new_delegate)

Required signatories: owner (chỉ owner đổi delegate)

LAMP movement: không
```

---

## 5. Order ID và Batch ID

### Order ID

```
order_id = blake2b_256(tx_id ∥ output_index_u64be ∥ commit_epoch_u64be ∥ lambda_u64be)
```

Nguồn: `vault.ak:compute_order_id` (dòng 390-400), `vacuum.ts:computeOrderId` (dòng 315-323). Bit-identical (P8).

Chứa `lambda` trong preimage → hai lệnh commit cùng epoch, cùng vault sẽ có order_id khác nhau nếu lambda khác nhau.

### Batch ID

```
batch_id = blake2b_256(tx_id ∥ output_index_u64be ∥ next_batch_index_u64be)
```

Nguồn: `vault.ak:compute_batch_id` (dòng 380-387), `vacuum.ts:computeBatchId` (dòng 306-313). Bit-identical (P8).

---

## 6. Validator Parameters (tham số compile-time)

```aiken
validator vault(
  lamp_policy_id : PolicyId,     // Policy ID của LAMP token
  treasury_addr  : Address,      // Địa chỉ Treasury script (phải là Script-cred, PR #11)
  um_nft_policy  : PolicyId,     // Policy ID của UM NFT
  um_script_hash : ByteArray,    // Hash của UMKeeper validator — pin UM ref input (MAINNET-BLOCK)
  ms_per_epoch   : Int,          // 432_000_000 mainnet / 86_400_000 preview
)
```

5 tham số (đối chiếu `scripts/06_create_vacuum_vault.ts`). `um_script_hash` ghim
reference input UM về đúng địa chỉ script chuẩn `Script(um_script_hash)` — vì UM NFT
một mình không phải singleton toàn cục nên có thể bị giả mạo; ghim script address là
phòng vệ chiều sâu (b).

Epoch được tính từ POSIX timestamp: `epoch = posix_ms / ms_per_epoch`.

**MAINNET-BLOCK fix (validity-range gaming)** — `get_current_epoch` ràng buộc CẢ HAI
biên `validity_range` phải `Finite` VÀ tx nằm trọn 1 epoch (`lower/ms == upper/ms`).
Đọc lower-only cho phép kẻ tấn công đặt `lower = start_of(E)` với upper mở/trễ, được
ledger đưa vào block ở epoch thật E+k nhưng validator vẫn tin `current_epoch == E` →
phá bất biến EXACT C-VAC-6 (fire trễ) và backdate `fire_epoch` / `last_updated_epoch` /
attribution. Khớp mẫu chuẩn `ProfileChange/.../util.ak:get_epoch`. Off-chain
(`vacuum.ts`) đã đặt `validTo = cuối epoch` nên happy-path không vỡ.

---

## 7. UM NFT Lookup

```aiken
fn find_um_datum(ref_inputs, um_nft_policy, um_script_hash) -> UMDatum
  // tìm reference input có quantity > 0 của um_nft_policy / "554d44"
  // VÀ output.address.payment_credential == Script(um_script_hash)
  // vault.ak:find_um_datum
```

Asset name `554d44` = hex của `"UMD"`. Việc ghim `Script(um_script_hash)` (cùng với
UM NFT) là MAINNET-BLOCK fix phòng vệ chiều sâu (b): NFT một mình không đảm bảo
singleton toàn cục, ghim script address từ chối UM UTxO giả mạo (fail-closed).
LAMP asset name `744c414d50` = hex của `"tLAMP"` (canonical name sau fix/lamp-name-canonical).

---

## 8. Treasury Script Credential Guard (PR #11 review)

```aiken
// vault.ak:215-216
expect Script(_) = treasury_addr.payment_credential
```

Nếu treasury là wallet, `treasury_receives_lamp` kiểm tra aggregate `≥` sẽ trivially pass với nhiều UTxOs cùng địa chỉ. Guard Script-credential ngăn vector tấn công này.

---

## 9. TypeScript Schema (Lucid Data)

Thứ tự field trong `VaultDatumSchema` và `VaultRedeemerSchema` trong `types.ts` phải khớp chính xác với thứ tự khai báo trong `types.ak`. Bất kỳ thay đổi thứ tự field nào trên Aiken đều phải cập nhật đồng thời TypeScript schema.

Lucid `Data.Enum` encode constructor index theo thứ tự khai báo — đúng với Plutus Data constr tag.
