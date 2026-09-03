# ConsumeMAGIC — TECH (mô hình v2: engagement-state)

> **MAGIC KHÔNG phải token.** `SPEC/MagicLamp-Tripletoken-Feat-(Vi).md` §4.1: MAGIC không
> có policy-id, không đúc, không có `tx.mint`. "Tiêu MAGIC" = handler `BurnBatch` của
> **vault generator** hạ `current_amount` trong `VaultDatum.magic_batches`; `consume.ak`
> chỉ là lớp ĐỊNH GIÁ + ENGAGEMENT, ép hai validator khớp nhau trong cùng một tx.
>
> **Kế toán là DẤU BẰNG.** §7.4 C-CM-2: `total_burned == total_required`. Over-burn bị
> CẤM y như under-burn. Bản v1 từng ghi `≥` — sai, đừng chép lại.
>
> Tệp này KHÔNG giữ số test và KHÔNG chép công thức — số ở [`DevStatus.md`](../DevStatus.md),
> công thức đọc thẳng ở tên hàm được trỏ. Neo `file:line` cố tình bị bỏ: chúng chết theo
> commit đầu tiên chạm vào tệp.

## 1. Aiken types + Plutus Data encoding

### 1.1 OpPrice

```aiken
pub type OpPrice {
  op_type    : Int,
  base_price : Int,
}
```

Plutus Data: `Constr 0 [I op_type, I base_price]` (1 constructor duy nhất, index 0).

### 1.2 PriceParam

```aiken
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
pub type EngageDatum {
  owner            : ByteArray,
  consumed_count   : Int,
  last_epoch       : Int,
  did_commit       : ByteArray,
  consumed_nanogic : Int,
}
```

Plutus Data: `Constr 0 [B owner, I consumed_count, I last_epoch, B did_commit, I consumed_nanogic]`.

`did_commit` và `consumed_nanogic` được THÊM Ở CUỐI, cố ý, để không dịch chỉ số ba
field cũ. `consumed_nanogic` là trục kế toán THẬT (giá trị đã trả); `consumed_count`
chỉ đếm LƯỢT — xem docstring trong `types.ak` để biết vì sao count một mình là lỗ.

### 1.4 ConsumeRedeemer

```aiken
pub type ConsumeRedeemer {
  Consume {
    op_type   : Int,
    op_count  : Int,
    price_ref : OutputReference,
    vault_ref : OutputReference,
  }
}
```

Plutus Data: `Constr 0 [I op_type, I op_count, Constr 0 [B txId, I ix], Constr 0 [B txId, I ix]]`.

Lưu ý: `OutputReference` = `Constr 0 [B transaction_id, I output_index]` (Plutus V3 stdlib).

### 1.5 PriceParamRedeemer

```aiken
pub type PriceParamRedeemer { PostPrice }
```

Plutus Data: `Constr 0 []`.

### 1.6 EngageMintRedeemer

```aiken
pub type EngageMintRedeemer { MintEngage { seed: OutputReference } }
```

Plutus Data: `Constr 0 [Constr 0 [B txId, I ix]]`. Redeemer của handler `mint` trong
CHÍNH `consume.ak` (không phải validator riêng — xem docstring `types.ak`).

### 1.7 NftRedeemer

```aiken
pub type NftRedeemer { MintGenesis }
```

Plutus Data: `Constr 0 []`.

**Quy tắc bắt buộc:** Thứ tự khai báo field trong Aiken quyết định constructor index. TypeScript codec phải dùng `Data.Object` / `Data.Enum` theo đúng thứ tự trên. Đảo thứ tự bất kỳ field → decode lỗi câm trên mainnet.

---

## 2. Validator logic

### 2.1 consume (spend)

File: `onchain/validators/consume.ak`

Parameterized (7 field — đọc `validator consume(...)` để lấy thứ tự chuẩn):
```
price_nft_policy, price_nft_name : authenticity NFT của beacon PriceParam
vault_script_hash                : payment script hash của vault generator
burn_batch_constr                : constr index của BurnBatch trong VaultRedeemer
                                   của vault đó (Instant=2, Schedule=2)
max_price_stale                  : số epoch tối đa giá được dùng
ms_per_epoch                     : POSIX ms / epoch (Preview = 86_400_000)
price_param_script_hash          : địa chỉ bắt buộc của beacon PriceParam
```

> KHÔNG có `magic_policy` / `magic_name` — không có token MAGIC để trỏ tới.
> `engage_nft_policy` / `engage_nft_name` cũng KHÔNG còn là apply-param: policy của
> thread token CHÍNH LÀ script hash của validator này (handler `mint`), biết qua tự
> tham chiếu — tránh bake hash hai chiều (fixed-point blake2b = không deploy được).

#### Redeemer `Consume`

**Invariant list:**

| ID | Bất biến | Hàm ép (đọc thẳng ở đó, đừng chép công thức về đây) |
|---|---|---|
| W-CM-1 | `op_count >= 1` | thân `spend` |
| W-CM-2 | Mọi input do SCRIPT khoá chỉ ở `own_hash` hoặc `vault_script_hash` — chặn double-satisfaction XUYÊN-INSTANCE | `util.script_inputs_confined_to` |
| W-CM-3 | Mọi input@engage mang ĐÚNG 1 thread NFT dưới `own_hash` (cổng định danh, fail-closed với UTxO giả) | `single_thread_nft` trong `list.all` đầu `spend` |
| W-CM-4 | Beacon PriceParam nằm đúng `price_param_script_hash` và mang đúng 1 NFT `(price_nft_policy, price_nft_name)` | `read_price_param` |
| W-CM-5 | `pricing.valid_param(pp)` — **8 ràng buộc**: pin `m_min`/`m_max` về hằng, cap 16 dòng, `op_type` tăng ngặt, GATE `base_price × m_min ≥ Q`, clamp invariant, `epoch ≥ 0`. Bảng đầy đủ: `CONTRACT.md §B1` · tóm tắt + lý do: §2.4 dưới | `pricing.valid_param` |
| W-CM-6 | `0 ≤ current_epoch − pp.epoch ≤ max_price_stale` | hai `expect` sau `util.get_epoch` |
| W-CM-7 | **`total_burned == total_required`** (DẤU BẰNG — over-burn và under-burn đều bị từ chối). `total_required` gộp qua MỌI Engage input; `total_burned` gộp qua các `vault_ref` PHÂN BIỆT | `sum_required_over_engage_inputs` · `distinct_vault_refs_over_engage_inputs` · `sum_burns_over_vault_refs` |
| W-CM-8 | `#out@engage == #in@engage` | `util.count_inputs_at_script` / `util.count_outputs_at_script` |
| W-CM-9 | Value bảo toàn TUYỆT ĐỐI giữa input@engage và output@engage (engage UTxO chỉ giữ ADA + thread NFT) | `engage_value_preserved` |
| W-CM-10 | Mỗi out@engage: đúng 1 thread NFT, `owner` bảo toàn, `did_commit` bất biến, `last_epoch = current_epoch` | `enforce_engagement` |
| W-CM-11 | `Σ consumed_count(out) == Σ(in) + Σ op_count` — mọi LƯỢT được ghi | `enforce_engagement` |
| W-CM-12 | `Σ consumed_nanogic(out) == Σ(in) + total_required` — mọi GIÁ TRỊ được ghi | `enforce_engagement` |
| W-CM-13 | Thread genesis SẠCH: one-shot theo seed, `asset_name = blake2b_256(cbor.serialise(seed))`, NFT neo đúng địa chỉ script, `consumed_count = consumed_nanogic = last_epoch = 0`, `owner` có trong `extra_signatories` | `validate_mint_engage_id` (handler `mint`) |

**else(_):** `fail` — chặn mọi purpose ngoài `spend` và `mint`.

#### Hàm nội bộ quan trọng

Tên hàm là neo duy nhất; thân hàm là lời giải thích. Đừng chép logic về đây.

- `util.script_inputs_confined_to` — mọi input do script khoá phải ở `own_hash` hoặc `vault_script_hash`. Đặt SỚM, fail-fast. Bịt lỗ hai instance consume khác `own_hash` cùng ăn một vault burn.
- `sum_required_over_engage_inputs` — fold qua `tx.inputs`, mỗi input tại `own_hash` đọc redeemer `Consume` → `pricing.required_for` → cộng dồn. Ép mọi Engage input dùng CÙNG `price_ref`.
- `distinct_vault_refs_over_engage_inputs` + `sum_burns_over_vault_refs` — gom các `vault_ref` phân biệt rồi cộng burn đọc từ redeemer `BurnBatch` của vault.
- `engage_value_preserved` — value input@engage == value output@engage, TUYỆT ĐỐI (không trừ hạng nào; engage UTxO không giữ MAGIC/LAMP).
- `enforce_engagement` — per-output: đúng 1 thread NFT, `owner` giữ, `did_commit` giữ, `last_epoch = current_epoch`; aggregate: cả `consumed_count` lẫn `consumed_nanogic`.
- `validate_mint_engage_id` — cổng genesis của thread token (xem W-CM-13).

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

- `price_of(pp, op_type)`: `Some(base * demand_mult / q)` hoặc `None`. Giá NIÊM YẾT (hiển thị).
- `required_for(pp, op_type, op_count)`: `Some(base * demand_mult * op_count / q)` hoặc `None`
  — **fold-floor MỘT lần**, KHÔNG phải `price_of × op_count`. Lý do + hệ quả: MATH.md §2.2.
- `q = 1_000_000_000` — khớp `ProtocolUtils.Q`.

#### `valid_param(pp)` — 8 ràng buộc, **không cái nào thừa**

Bảng ràng buộc chuẩn tắc là **`CONTRACT.md §B1`** — đọc ở đó, đừng chép về đây. Tóm tắt để
biết có bao nhiêu cổng mà không gỡ nhầm:

| # | Ràng buộc | Vì sao load-bearing |
|---|---|---|
| 1 | `pp.m_min == m_min_q` (`500_000_000`) | PIN về hằng. Check tương-đối KHÔNG chặn band-escape |
| 2 | `pp.m_max == m_max_q` (`2_000_000_000`) | Thiếu pin: `PostPrice` đặt `m_max` khổng lồ, `demand` bám theo ⇒ giá nổ ~1e6× mà vẫn "trong band" |
| 3 | `list.length(pp.op_prices) <= max_op_prices` (16) | `valid_param` chạy 1 lần / Engage input ⇒ bảng phình = DoS ex-unit MỌI tx consume, không hạ được vì beacon chỉ committee sửa |
| 4 | `sorted_strict_op_types(pp.op_prices)` | Trùng `op_type`: on-chain `list.find` lấy dòng ĐẦU, map off-chain lấy dòng CUỐI ⇒ hai phía lệch giá 10× mà KHÔNG bên nào báo lỗi |
| 5 | `op.base_price * pp.m_min >= q` (mỗi dòng) | GATE giá-về-0: giá 1 đơn vị ở demand thấp nhất vẫn ≥ 1 nanogic. Bao hàm luôn `base_price == 0` (nhánh chết — `consume` ép `required > 0`) |
| 6 | `pp.m_min >= 0`, `pp.m_min <= pp.m_max` | belt sau khi pin — defense-in-depth, giữ nguyên |
| 7 | `pp.demand_mult ∈ [pp.m_min, pp.m_max]` | clamp invariant |
| 8 | `pp.epoch >= 0` | chống epoch âm trước phép trừ stale |

> ⚠ **Bốn cổng mới — #1+#2 (pin band), #3 (cap độ dài), #4 (tăng ngặt), #5 (GATE giá-về-0) —
> trông "thừa" nếu chỉ đọc bảng cũ 4 điều.** Bản trước của mục này chỉ
> liệt `m_min ≥ 0` / `m_min ≤ m_max` / clamp / `base_price ≥ 0` — ai "dọn phần thừa" theo
> bản đó sẽ gỡ đúng pin-hằng, cap độ dài, tăng-ngặt và GATE giá-về-0. Mỗi cái là một đường
> tấn công đã được vá. Trọng tài là mã: `onchain/lib/magiclamp/consume/pricing.ak:valid_param`.

Bản gương off-chain: `pricing/src/price.ts:assertValidPriceParam` (+ `toCanonicalOpPrices`
sắp bảng trước khi post), ném `PRICE-010..015`. Chạy TRƯỚC khi post beacon — bảng sai chỉ lộ
ra khi mọi tx consume đã chết hàng loạt.

---

## 3. eUTXO flow

```
Tx ConsumeMAGIC (CO-SPEND — hai validator trong một tx, KHÔNG có mint):
  inputs:
    engage_UTxO_0  (script: consume, datum: EngageDatum, value: ADA + thread_NFT)
    [engage_UTxO_1] ...
    vault_UTxO     (script: vault generator, datum: VaultDatum)
                   -- nơi DUY NHẤT MAGIC giảm: handler BurnBatch hạ current_amount
  reference_inputs:
    price_beacon   (script: price_param, datum: PriceParam, value: ADA + price_NFT)
                   -- CIP-31: tiêu THAM CHIẾU, không spend
  outputs:
    engage_UTxO_0' (script: consume, datum: EngageDatum', value BẢO TOÀN TUYỆT ĐỐI)
    [engage_UTxO_1'] ...
    vault_UTxO'    (magic_batches đã trừ Σburns)
  mint:
    (KHÔNG CÓ — MAGIC không phải token. tx.mint chỉ khác rỗng ở tx genesis
     đúc thread NFT, và khi đó handler `mint` của chính consume.ak chạy.)
  redeemers:
    Spend(engage_UTxO_0): Consume { op_type, op_count, price_ref, vault_ref }
    [Spend(engage_UTxO_1): Consume { ... }]
    Spend(vault_UTxO)   : BurnBatch { ... }   -- constr = burn_batch_constr
```

**Lưu ý eUTXO quan trọng:**
- Mỗi UTxO chỉ được spend 1 lần/tx (ledger rule). Không thể dùng 1 input thỏa 2 redeemer.
- `price_beacon` là reference input — không bị tiêu. Giá giữ nguyên trong suốt tx.
- Double-satisfaction guard (`W-CM-7`..`W-CM-12`) là aggregate — idempotent qua mọi invocation trên cùng tx: validator chạy N lần (N Engage input) nhưng kiểm cùng bộ điều kiện.
- Double-satisfaction XUYÊN-INSTANCE (hai `own_hash` khác nhau, cùng một `vault_script_hash`) KHÔNG đóng được bằng aggregate — nó đóng bằng `W-CM-2`.

---

## 4. Deploy dependencies

```
Step 1: deploy vault generator (InstantGen/ScheduleGen) → VAULT_SCRIPT_HASH
        KHÔNG có bước "deploy magic_policy" — MAGIC không phải token.
Step 2: deploy price_nft.ak (parameterized bởi genesis_ref)
        → PRICE_NFT_POLICY_ID
Step 3: deploy price_param.ak (parameterized bởi committee[], threshold, price_nft_policy, price_nft_name)
        → PRICE_PARAM_SCRIPT_HASH
Step 4: post PriceParam beacon UTxO tại PRICE_PARAM_SCRIPT_HASH
        (tx: mint price_NFT, create datum PriceParam epoch=0, demand_mult=Q)
Step 5: deploy consume.ak (7 param — xem §2.1) → CONSUME_SCRIPT_HASH
Step 6: đúc thread NFT + tạo Engage UTxO genesis tại CONSUME_SCRIPT_HASH
        (handler `mint` của chính consume.ak ép datum genesis sạch — W-CM-13)
```

Bước 2–6 chạy trong MỘT script, MỘT tx — xem [`EXEC.md`](EXEC.md) §1.

Danh sách env (tên biến + default) là của script deploy, KHÔNG chép về đây — xem
[`EXEC.md`](EXEC.md) §1 "Knob". Không còn `MAGIC_POLICY_ID` / `MAGIC_ASSET_NAME`
(v1 mint), không còn `ENGAGE_NFT_POLICY_ID` là input (policy = script hash, sinh ra
lúc apply-param).

---

## 5. Pricing offchain (TypeScript)

File: `pricing/src/price.ts`

- `computeLoadRaw(opsServedEpoch, targetCapacity)`: Q-format, floor, defensive den=1.
- `appendLoadHistory(history, newRaw, window)`: giữ tối đa `window` mẫu gần nhất (FIR window).
- `smaLoad(history)`: SMA Q-format, rỗng → `M_NEUTRAL_Q`.
- `demandMult(history, mMinQ, mMaxQ)`: `clamp(smaLoad(history), mMinQ, mMaxQ)`.
- `pricePerOp(opType, demandMultQ, basePriceTable)`: giá 1 op để HIỂN THỊ, floor BigInt, throw nếu `opType` không có trong bảng.
- `requiredForOp(opType, opCount, demandMultQ)`: số phải trả cho MỘT dòng op.
- `requiredBurn(items, demandMultQ)`: Σ `requiredForOp` trên các dòng.

> **Đừng chép công thức `requiredBurn` bằng tay.** Bản cũ viết `Σ pricePerOp × opCount`
> — floor TRƯỚC rồi nhân — mất phần dư mỗi op × count ⇒ thu THIẾU ⇒ `Σburns < required`
> on-chain ⇒ MỌI consume tx bị từ chối. Bản đúng là fold-floor-MỘT-LẦN, khớp bit với
> `pricing.required_for` (P8). Cần công thức thì đọc docstring của `requiredForOp` trong
> `pricing/src/price.ts`, đừng suy ra từ tên.

Tất cả tham số BigInt. Không `Number` cho nanogic/Q values.

---

## 6. Aiken test coverage (consume.ak)

Danh sách tên test KHÔNG chép về đây — bản chép tay từng sống lâu hơn code (nó còn ghi
`consume_overburn_ok — over-burn cho phép`, trong khi test thật tên `consume_overburn_fail`,
vì C-CM-2 là dấu BẰNG). Lấy danh sách thật:

```bash
grep -n '^test ' ConsumeMAGIC/onchain/validators/consume.ak
```

Các nhóm đang có, để biết chỗ nào còn hở khi thêm bất biến mới:

| Nhóm | Cái được canh |
|---|---|
| happy | 1 engage, nhiều burn, 2 engage / 1 vault, 2 engage / 2 vault, value bảo toàn, input ví thường, bảng giá đầy đủ (worst-case ExUnit) |
| kế toán | under-burn, over-burn, multi-engage share vault under-charge, `consumed_nanogic` khai thừa / khai thiếu |
| định danh | thiếu thread NFT, engage input giả không NFT, thread token drain, output collapse, `did_commit` bị đổi |
| giá | stale, op_type không có trong bảng, beacon không NFT, `base_price` âm, beacon đặt ở ví / ở script khác |
| liên kết vault | sai `burn_batch_constr`, vault không ở `vault_script_hash`, double-satisfaction xuyên-instance |
| validity range | upper vô hạn, cửa sổ rộng quá 1 epoch, cửa sổ chặt hợp lệ |
| genesis thread (`mint`) | datum bịa (nanogic / count / last_epoch), output sai địa chỉ, seed không tiêu, owner không ký, sai tên, hai tên, token lạ kèm |

Số test hiện tại: [`DevStatus.md`](../DevStatus.md).
