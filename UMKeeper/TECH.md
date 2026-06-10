# UMKeeper — Technical Specification
## GenMAGIC v3.3 · §14 On-chain + Off-chain Architecture

---

## 1. Aiken types và Plutus Data encoding

### 1.1 UMDatum

```aiken
// um_datum.ak:39-43
pub type UMDatum {
  smoothed_q         : Int,       // Plutus Data: constr 0 field 0
  last_updated_epoch : Int,       // Plutus Data: constr 0 field 1
  history            : List<Int>, // Plutus Data: constr 0 field 2
}
```

Plutus Data encoding (PlutusV3, constructor index = thứ tự khai báo):
```
Constr 0 [
  I(smoothed_q),
  I(last_updated_epoch),
  List([I(h0), I(h1), ...])
]
```

TypeScript schema (`keeper.ts:68-72`):
```typescript
const UMDatumSchema = Data.Object({
  smoothed_q:          Data.Integer(),
  last_updated_epoch:  Data.Integer(),
  history:             Data.Array(Data.Integer()),
});
```

### 1.2 UMRedeemer

```aiken
// um_datum.ak:45-49
pub type UMRedeemer {
  UMUpdate { new_raw: Int }  // Plutus Data: constr 0 { new_raw: Int }
}
```

Plutus Data encoding:
```
Constr 0 [Constr 0 [I(new_raw)]]  // outer = UMUpdate variant, inner = record
```

TypeScript schema (`keeper.ts:74-76`):
```typescript
const UMRedeemerSchema = Data.Enum([
  Data.Object({ UMUpdate: Data.Object({ new_raw: Data.Integer() }) }),
]);
```

**Quan trọng:** `Data.Enum` wrap `Data.Object` → constructor index outer là 0 (UMUpdate). `Data.Object` inner encode như Plutus record. Nếu thêm variant vào `UMRedeemer`, index sẽ dịch chuyển → cần update cả Aiken lẫn TypeScript đồng thời.

---

## 2. Validator parameters (baked at deploy time)

```aiken
// um_datum.ak:60-66
validator um_datum_validator(
  ms_per_epoch : Int,          // 86_400_000 (Preview) hoặc 432_000_000 (Mainnet)
  keepers      : List<ByteArray>,  // payment key hash của từng keeper
  threshold    : Int,          // M trong M-of-N (thường = ceil(N/2)+1)
  um_policy    : PolicyId,     // policy ID của UM authority NFT
  um_name      : ByteArray,    // asset name của UM NFT (e.g. #"554d44" = "UMD")
)
```

Tất cả params được bake vào script hash qua `applyParamsToScript` trong Lucid. Đây là `PlutusScript` applied — phải lưu lại applied script bytes để sử dụng lại khi build tx.

---

## 3. Validator logic theo redeemer — invariant list

### Redeemer: `UMUpdate { new_raw }`

Thứ tự kiểm tra trong validator (`um_datum.ak:79-126`):

| Bước | Invariant | Code | Lý do |
|---|---|---|---|
| 1 | **W-AUTH** | `count_keeper_sigs(keepers, tx.extra_signatories) >= threshold` | Chỉ keeper whitelist có thể update |
| 2 | **W-SINGLE-IN** | `count_inputs_at_script(tx.inputs, own_hash) == 1` | Chống double-satisfaction — đếm theo payment credential, không full Address |
| 3 | **W-SINGLE-OUT** | `count_outputs_at_script(tx.outputs, own_hash) == 1` | Đúng 1 output UM (không fork datum) |
| 4 | **C-UM-5a** | `assets.quantity_of(um_out.value, um_policy, um_name) == 1` | UM NFT authority phải còn trong output |
| 5 | **C-UM-5b** | `um_out.value == um_in.value` | Value preservation toàn bộ (không rút min-ADA, không chèn token lạ) |
| 6 | **C-UM-4** | `current_epoch > datum.last_updated_epoch` | Mỗi epoch chỉ update 1 lần |
| 7 | **C-UM-1a** | `clamped_raw = clamp(new_raw, UM_MIN_Q, UM_MAX_Q)` | Raw vào history phải trong bounds |
| 8 | **C-UM-2** | `new_history = append_capped(history, clamped_raw, 6)` | Sliding window ≤ 6 |
| 9 | **C-UM-1b** | `new_smoothed = compute_sma(new_history)` | SMA từ history mới |
| 10 | **C-UM-3** | `new_smoothed_clamped = clamp(new_smoothed, UM_MIN_Q, UM_MAX_Q)` | Smoothed trong Constitutional bounds |
| 11 | **A02** | Verify output datum fields khớp với giá trị tính được | Chống khai gian datum |

### `else(_) { fail }`

Mọi script purpose khác (mint, withdrawal, cert, vote) đều fail — validator chỉ xử lý spend.

---

## 4. eUTXO Flow

```
┌─────────────────────────────────────────────────────────────┐
│  UMUpdate Transaction                                       │
│                                                             │
│  Inputs:                                                    │
│    [0] UM UTxO @ um_script_addr                             │
│        datum:   UMDatum { smoothed_q, last_updated_epoch,   │
│                           history }                         │
│        value:   2 ADA + UM NFT (um_policy.um_name × 1)     │
│        redeemer: UMUpdate { new_raw }                       │
│                                                             │
│  Outputs:                                                   │
│    [0] UM UTxO @ um_script_addr  (SAME address)             │
│        datum:   UMDatum { new_smoothed_clamped,             │
│                           current_epoch,                    │
│                           new_history }                     │
│        value:   2 ADA + UM NFT  (UNCHANGED)                 │
│                                                             │
│  Validity range: [currentEpoch×msPerEpoch,                  │
│                   (currentEpoch+1)×msPerEpoch - 1]          │
│                                                             │
│  extra_signatories: [keeper_pkh_1, keeper_pkh_2, ...]       │
│    (≥ threshold keepers từ whitelist)                       │
│                                                             │
│  Scripts attached: um_datum_validator (applied)             │
└─────────────────────────────────────────────────────────────┘
```

**Không có fee output riêng** — Lucid tự balancer thêm collateral và change output (wallet của keeper).

---

## 5. Epoch derivation on-chain

```aiken
// um_datum.ak:166-168
fn get_epoch(tx: Transaction, ms_per_epoch: Int) -> Int {
  expect Some(s) = tx.validity_range.lower_bound.bound_type |> get_finite
  s / ms_per_epoch
}
```

Keeper phải set `validFrom` = `currentEpoch × ms_per_epoch` để validator tính đúng epoch. Nếu `validFrom` lùi về epoch cũ → tx fail C-UM-4.

Trong TypeScript (`keeper.ts:113-114`):
```typescript
const lowerTime = Number(tipMs);
const upperTime = Number((currentEpoch + 1n) * msPerEpoch(network) - 1n);
```

`tipMs` = POSIX ms của tip hiện tại (từ slot → posix conversion). `msPerEpoch(network)` từ `@magiclamp/protocol-utils`.

---

## 6. Deploy dependencies

```
Bước 1: aiken build → plutus.json
  Output: validator "um_datum_validator" → cbor bytes (un-applied)

Bước 2: applyParamsToScript(cbor, [ms_per_epoch, keepers, threshold, um_policy, um_name])
  → applied script hash = UM_SCRIPT_HASH (lưu vào .env)

Bước 3: Mint UM authority NFT
  policy_id = UM_NFT_POLICY_ID  (one-shot minting policy)
  asset_name = #"554d44"  ("UMD")
  quantity = 1
  → UM_NFT_UNIT = UM_NFT_POLICY_ID + "554d44"

Bước 4: Deploy UM UTxO
  tx:
    Output @ um_script_addr:
      value: 2 ADA + UM NFT
      datum: UMDatum {
        smoothed_q: 1_000_000_000,     // Q = 1.0× (neutral)
        last_updated_epoch: genesisEpoch,
        history: [],
      }

Bước 5: Start keeper bot
  env vars cần: BLOCKFROST_KEY, KEEPER_KEY (signing key), UM_NFT_UNIT, UM_SCRIPT_HASH
```

---

## 7. Consistency giữa Aiken và TypeScript (P8)

| Hàm | Aiken | TypeScript |
|---|---|---|
| `um_raw` | `um_datum.ak:106` (`new_raw` từ keeper, clamped) | `math.ts:9-12` (`computeUMRaw` — raw chưa clamp) |
| `append_capped` | `um_datum.ak:149-154` (nhận `clamped_raw`) | `math.ts:20-23` (`appendHistory` — nhận `new_raw` chưa clamp) |
| `compute_sma` | `um_datum.ak:139-145` | `math.ts:26-29` (`computeSMA`) |
| `clamp` | `um_datum.ak:156-158` | `math.ts:14-18` (`clampUM`) |

**Lưu ý không nhất quán (cần theo dõi):** Aiken `append_capped` nhận `clamped_raw` (đã clamp); TypeScript `appendHistory` nhận `new_raw` nguyên bản và clamp xảy ra muộn hơn trong `computeNewUM`. Kết quả `smoothed_q` cuối cùng vẫn đúng (double clamp), nhưng `history` trong datum có thể chứa giá trị khác nhau giữa 2 bên nếu `new_raw` ngoài `[UM_MIN_Q, UM_MAX_Q]`. Nên đồng bộ về 1 convention (clamp trước khi append) cho P8 hoàn chỉnh.

---

## 8. InstantGen integration (C-UM-6)

InstantGen đọc UM datum qua UTxO lookup (không phải reference input — cần spend UM UTxO). Tuy nhiên thiết kế hiện tại: UM datum là UTxO riêng chỉ do UMKeeper spend. InstantGen chỉ READ UM datum off-chain trước khi xây tx (không cần UM UTxO là input của tx InstantGen).

Off-chain (`InstantGen/offchain/src/math.ts:75-80`):
```typescript
export function getUmForInstant(um: UMDatum, currentEpoch: bigint): bigint {
  const staleness = currentEpoch - um.last_updated_epoch;
  if (staleness <= UM_MAX_STALENESS) return um.smoothed_q;
  return UM_FALLBACK_Q;
}
```

On-chain (InstantGen validator) cần đọc UM từ reference input để tránh contention UTxO. Kiến trúc hiện tại cần xác nhận thêm trong deploy phase.
