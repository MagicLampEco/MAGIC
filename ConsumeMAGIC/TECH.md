# ConsumeMAGIC — TECH v1 (feat/consume-magic-v1)

## 1. Aiken types + Plutus Data encoding

### 1.1 OpPrice

```aiken
// onchain/lib/magiclamp/consume/types.ak:5
pub type OpPrice {
  op_type    : Int,
  base_price : Int,
}
```

Plutus Data: `Constr 0 [I op_type, I base_price]` (1 constructor duy nhất, index 0).

### 1.2 PriceParam

```aiken
// types.ak:14
pub type PriceParam {
  op_prices   : List<OpPrice>,
  demand_mult : Int,
  m_min       : Int,
  m_max       : Int,
  epoch       : Int,
}
```

Plutus Data: `Constr 0 [List<OpPrice>, I demand_mult, I m_min, I m_max, I epoch]`.

### 1.3 EngageDatum

```aiken
// types.ak:27
pub type EngageDatum {
  owner          : ByteArray,
  consumed_count : Int,
  last_epoch     : Int,
}
```

Plutus Data: `Constr 0 [B owner, I consumed_count, I last_epoch]`.

### 1.4 ConsumeRedeemer

```aiken
// types.ak:37
pub type ConsumeRedeemer {
  Consume { op_type: Int, op_count: Int, price_ref: OutputReference }
}
```

Plutus Data: `Constr 0 [I op_type, I op_count, Constr 0 [B txId, I outputIndex]]`.

Lưu ý: `OutputReference` = `Constr 0 [B transaction_id, I output_index]` (Plutus V3 stdlib).

### 1.5 PriceParamRedeemer

```aiken
// types.ak:43
pub type PriceParamRedeemer { PostPrice }
```

Plutus Data: `Constr 0 []`.

### 1.6 NftRedeemer

```aiken
// types.ak:47
pub type NftRedeemer { MintGenesis }
```

Plutus Data: `Constr 0 []`.

**Quy tắc bắt buộc:** Thứ tự khai báo field trong Aiken quyết định constructor index. TypeScript codec phải dùng `Data.Object` / `Data.Enum` theo đúng thứ tự trên. Đảo thứ tự bất kỳ field → decode lỗi câm trên mainnet.

---

## 2. Validator logic

### 2.1 consume (spend)

File: `onchain/validators/consume.ak`

Parameterized:
```
magic_policy, magic_name        : policy MAGIC
price_nft_policy, price_nft_name: authenticity NFT của beacon PriceParam
engage_nft_policy, engage_nft_name: thread token neo EngageDatum
max_price_stale                 : số epoch tối đa giá được dùng
ms_per_epoch                    : POSIX ms / epoch (Preview = 86_400_000)
```

#### Redeemer `Consume`

**Invariant list:**

| ID | Bất biến | Cách ép | Vị trí code |
|---|---|---|---|
| W-CM-1 | `op_count >= 1` | `expect op_count >= 1` | `consume.ak:38` |
| W-CM-2 | PriceParam beacon mang đúng 1 NFT `(price_nft_policy, price_nft_name)` | `read_price_param`: `expect qty == 1` | `consume.ak:read_price_param` |
| W-CM-3 | `pricing.valid_param(pp)` — clamp invariant + base_price ≥ 0 | `expect pricing.valid_param(pp)` | `consume.ak:44` |
| W-CM-4 | `0 ≤ cur_epoch − pp.epoch ≤ max_price_stale` | hai `expect` liên tiếp | `consume.ak:47–48` |
| W-CM-5 | `tx.mint` chứa đúng 1 entry, policy MAGIC, qty âm | `check_only_magic_burn`: `expect [(p,n,q)] = flatten(mint)` | `consume.ak:check_only_magic_burn` |
| W-CM-6 | `magic_burned > 0` | `expect magic_burned > 0` | `consume.ak:53` |
| W-CM-7 | `magic_burned >= total_required` (aggregate qua vault inputs) | `expect magic_burned >= total_required` | `consume.ak:59` |
| W-CM-8 | `#out@script == #in@script` | `expect n_in == n_out` | `consume.ak:65` |
| W-CM-9 | `Σ engage NFT(out@script) == Σ engage NFT(in@script)` | `expect nft_in == nft_out` | `consume.ak:70` |
| W-CM-10 | Non-MAGIC value bảo toàn tuyệt đối giữa input@script và output@script | `expect non_magic_value_preserved(...)` | `consume.ak:82` |
| W-CM-11 | Mỗi out@script: đúng 1 engage NFT, `owner` bảo toàn, `last_epoch = current_epoch` | `list.all(tx.outputs, ...)` trong `enforce_engagement` | `consume.ak:enforce_engagement` |
| W-CM-12 | `Σ consumed_count(out) == Σ consumed_count(in) + Σ op_count` | `consumed_out == consumed_in + total_op` | `consume.ak:enforce_engagement` |

**else(_):** `fail` — chặn mọi purpose ngoài `spend` (withdraw, mint, cert,...).

#### Hàm nội bộ quan trọng

- `check_only_magic_burn`: ép `flatten(tx.mint)` có đúng 1 tuple → policy và name khớp → qty âm → trả `-qty`. Bất kỳ entry khác (LAMP, ADA, asset lạ) → fail (`consume.ak:fn check_only_magic_burn`).
- `sum_required_over_vault_inputs`: fold qua `tx.inputs`, với mỗi input tại `own_hash` đọc redeemer `Consume` qua `find_spend_redeemer` → gọi `pricing.required_for` → cộng dồn. Tham chiếu `consume.ak:sum_required_over_vault_inputs`.
- `non_magic_value_preserved`: tính diff = `Σin − Σout`; zero-hóa thành phần MAGIC (`assets.add(diff, magic_policy, magic_name, -magic_diff)`); kiểm `assets.is_zero`. Nguồn: `consume.ak:non_magic_value_preserved`.
- `enforce_engagement`: (a) `list.all` trên `tx.outputs`: mỗi output@script phải có đúng 1 engage NFT, `owner == in_datum.owner`, `last_epoch == current_epoch`. (b) `Σ consumed_out == Σ consumed_in + Σ op_count`. Nguồn: `consume.ak:enforce_engagement`.

### 2.2 price_param (spend)

File: `onchain/validators/price_param.ak`

Parameterized: `committee: List<ByteArray>`, `threshold: Int`, `price_nft_policy`, `price_nft_name`.

| ID | Bất biến | Cách ép |
|---|---|---|
| W-PP-1 | `tx.mint = zero` — không mint/burn trong tx cập nhật beacon | `expect assets.is_zero(tx.mint)` |
| W-PP-2 | Đúng 1 input + 1 output tại script | count == 1 với cả hai |
| W-PP-3 | M-of-N committee đồng thuận | `count_sigs >= threshold` |
| W-PP-4 | `out_datum.epoch > datum.epoch` (đơn điệu tăng) | `expect out_datum.epoch > datum.epoch` |
| W-PP-5 | `pricing.valid_param(out_datum)` | `expect pricing.valid_param(out_datum)` |
| W-PP-6 | NFT bảo toàn (1 in, 1 out) | `nft_in == 1`, `nft_out == 1` |

### 2.3 price_nft (mint — one-shot)

File: `onchain/validators/price_nft.ak`

Parameterized: `genesis_ref: OutputReference`.

| ID | Bất biến | Cách ép |
|---|---|---|
| W-NFT-1 | `genesis_ref` được tiêu trong tx (one-shot) | `list.any(tx.inputs, ... == genesis_ref)` |
| W-NFT-2 | Đúng 1 asset name thuộc policy này trong `tx.mint` | `dict.size(own_tokens) == 1` |
| W-NFT-3 | Qty = +1 (không burn, không mint thêm) | `quantity_of(tx.mint, policy_id, price_nft_name) == 1` |

`else(_): fail` — chặn burn NFT.

### 2.4 pricing.ak (thư viện)

File: `onchain/lib/magiclamp/consume/pricing.ak`

- `valid_param(pp)`: kiểm `m_min ≥ 0`, `m_min ≤ m_max`, `demand_mult ∈ [m_min, m_max]`, mọi `base_price ≥ 0`. Defense-in-depth trước khi tính giá.
- `price_of(pp, op_type)`: `Some(base * demand_mult / q)` hoặc `None`.
- `required_for(pp, op_type, op_count)`: `Some(price * op_count)` hoặc `None`.
- `q = 1_000_000_000` — khớp `ProtocolUtils.Q`.

---

## 3. eUTXO flow

```
Tx ConsumeMAGIC:
  inputs:
    vault_UTxO_0   (script: consume, datum: EngageDatum, value: ADA + engage_NFT + ?)
    [vault_UTxO_1] ...
  reference_inputs:
    price_beacon   (script: price_param, datum: PriceParam, value: ADA + price_NFT)
                   -- CIP-31: tiêu THAM CHIẾU, không spend
  outputs:
    vault_UTxO_0'  (script: consume, datum: EngageDatum', value: ADA + engage_NFT)
    [vault_UTxO_1'] ...
  mint:
    (magic_policy, magic_name, −magic_burned)   -- ÂM = đốt MAGIC
  redeemers:
    Spend(vault_UTxO_0): Consume { op_type, op_count, price_ref }
    [Spend(vault_UTxO_1): Consume { ... }]
```

**Lưu ý eUTXO quan trọng:**
- Mỗi vault UTxO chỉ được spend 1 lần/tx (ledger rule). Không thể dùng 1 input thỏa 2 redeemer.
- `price_beacon` là reference input — không bị tiêu. Giá giữ nguyên trong suốt tx.
- Double-satisfaction guard (`W-CM-8`, `W-CM-9`, `W-CM-12`) là aggregate — idempotent qua mọi invocation của validator trên cùng tx. Validator chạy N lần (N vault input) nhưng kiểm tra cùng bộ conditions → kết quả như nhau mỗi lần → an toàn.

---

## 4. Deploy dependencies

```
Step 1: deploy magic_policy (từ generator đã deploy — đọc từ scripts/.env MAGIC_POLICY_ID)
Step 2: deploy price_nft.ak (parameterized bởi genesis_ref)
        → PRICE_NFT_POLICY_ID
        → mint 1 NFT vào ví committee
Step 3: deploy price_param.ak (parameterized bởi committee[], threshold, price_nft_policy, price_nft_name)
        → PRICE_PARAM_SCRIPT_HASH
Step 4: post PriceParam beacon UTxO tại PRICE_PARAM_SCRIPT_HASH
        (tx: mint price_NFT, create datum PriceParam epoch=0, demand_mult=Q)
Step 5: deploy consume.ak (parameterized bởi 6 policy/name + max_price_stale + ms_per_epoch)
        → CONSUME_SCRIPT_HASH
Step 6: tạo vault UTxO tại CONSUME_SCRIPT_HASH
        (EngageDatum{ owner=pkh, consumed_count=0, last_epoch=0 }, engage_NFT)
```

Env vars cần có trong `scripts/.env`:
```
MAGIC_POLICY_ID
PRICE_NFT_POLICY_ID
PRICE_NFT_NAME=5052494345
PRICE_PARAM_SCRIPT_HASH
ENGAGE_NFT_POLICY_ID
ENGAGE_NFT_NAME=454e47
CONSUME_SCRIPT_HASH
MAX_PRICE_STALE=5
MS_PER_EPOCH=86400000
```

---

## 5. Pricing offchain (TypeScript)

File: `pricing/src/price.ts`

- `computeLoadRaw(opsServedEpoch, targetCapacity)`: Q-format, floor, defensive den=1.
- `appendLoadHistory(history, newRaw, window)`: giữ tối đa `window` mẫu gần nhất (FIR window).
- `smaLoad(history)`: SMA Q-format, rỗng → `M_NEUTRAL_Q`.
- `demandMult(history, mMinQ, mMaxQ)`: `clamp(smaLoad(history), mMinQ, mMaxQ)`.
- `pricePerOp(opType, demandMultQ, basePriceTable)`: floor BigInt, throw nếu `opType` không có trong bảng.
- `requiredBurn(items, demandMultQ)`: Σ `pricePerOp × opCount`.

Tất cả thao số BigInt. Không Number cho nanogic/Q values.

---

## 6. Aiken test coverage (consume.ak)

| Test | Loại | Invariant |
|---|---|---|
| `consume_happy` | Happy | C-CM-1..5 đều thoả |
| `consume_overburn_ok` | Happy | over-burn cho phép |
| `consume_two_inputs_happy` | Happy | N=2 input đúng |
| `consume_value_preserved_happy` | Happy | ADA + token khác bảo toàn |
| `consume_underburn_fail` | Negative | C-CM-2 |
| `consume_extra_mint_entry_fail` | Negative | C-CM-1 (entry rác trong mint) |
| `consume_no_thread_token_fail` | Negative | C-CM-4 (NFT qty=0 ở output) |
| `consume_double_satisfaction_fail` | Negative | C-CM-3 (burn chỉ đủ 1 trong 2) |
| `consume_output_collapse_burn_enough_fail` | Negative | C-CM-3 (#out=1 < #in=2) |
| `consume_thread_token_drain_fail` | Negative | C-CM-3 (Σnft_out < Σnft_in) |
| `consume_state_undercount_fail` | Negative | C-CM-4 (Σconsumed không tăng đủ) |
| `consume_stale_price_fail` | Negative | C-CM-5 |
| `consume_price_from_redeemer_fail` | Negative | C-CM-2 (op_type=42 không có trong bảng) |
| `consume_fake_beacon_no_nft_fail` | Negative | C-CM-2 (beacon NFT qty=0) |
| `consume_drain_ada_fail` | Negative | C-CM-1 (drain ADA) |
| `consume_drain_other_token_fail` | Negative | C-CM-1 (drain token khác) |
| `consume_negative_base_price_fail` | Negative | C-CM-2 (base_price âm → valid_param fail) |
