# InstantGen — Technical Specification
## GenMAGIC v3.3 · Aiken PlutusV3 + TypeScript SDK

> ⚠ **ĐÃ LỖI THỜI ở phần redeemer, phần tham số và phần luồng giá trị.** Tệp này còn ghi
> `InstantGen { lamp_paid }`, `ApplyHalving` ở constr 1, apply-param có `treasury_addr`,
> và một output Treasury trong sơ đồ tx. **Không cái nào còn tồn tại.** Mô tả hiện hành ở
> **[`DESIGN-PHASE2.md`](DESIGN-PHASE2.md)**; nguồn chân lý là
> [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](../SPEC/MagicLamp-Tripletoken-Feat-(Vi).md).
>
> **Gãy gì nếu dựng theo tệp này:** lược đồ redeemer sai làm tx không giải mã được đúng
> nhánh; danh sách apply-param sai sinh ra script hash khác vault thật mà không lệnh nào
> báo lỗi — LAMP vào rồi kẹt vĩnh viễn. Danh sách tham số thật đọc ở `parameters[]` trong
> `onchain/plutus.json`, đối chiếu bằng `cd scripts && npm run check:params`.
>
> Còn dùng được: nguyên tắc "thứ tự constructor = hợp đồng nhị phân", bố cục 17 trường
> `VaultDatum`, và kỷ luật song ánh Aiken ↔ TypeScript (P8).

---

## 1. Aiken types và Plutus Data encoding

### 1.1 VaultRedeemer

Nguồn: `onchain/lib/magiclamp/protocol/types.ak`, kiểu `VaultRedeemer`.

```aiken
pub type VaultRedeemer {
  InstantGen    { claimed_amount: Natural }   // constr 0
  PruneExpired                                // constr 1  (nullary)
  BurnBatch     { burns: List<...> }          // constr 2
  UpdateProfile { new_profile: ... }          // constr 3
  WithdrawLamp  { amount: Natural }           // constr 4
  SetDelegate   { new_delegate: Option<...> } // constr 5
}
```

Constr 0 mang `claimed_amount` — khẳng định của người gọi về khoản được cấp; validator
tính lại và đòi **đúng bằng**. Trường `lamp_paid` đã bỏ (I-ACT-7: không có khoản LAMP nào
trả đi).

**QUAN TRỌNG — chỉ số constructor là hợp đồng nhị phân.** Thứ tự biến thể = tag on-chain.
Không reorder, không xoá biến thể ở giữa. `ApplyHalving` ở constr 1 đã nghỉ, nhưng slot
**không** được bỏ: xoá nó đẩy `BurnBatch` từ constr 2 về constr 1 và phá interface liên
repo (`ConsumeMAGIC/CONTRACT.md` v2 khoá `BurnBatch` ở constr 2). Thay bằng
`PruneExpired` — cũng **nullary**, nên mã hoá Plutus Data của constr 1 không đổi một byte.
Chi tiết: [`DESIGN-PHASE2.md`](DESIGN-PHASE2.md) §3.

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

Danh sách apply-param **không chép ở đây** — chép tay là thứ đã sai. Đọc `parameters[]`
trong `onchain/plutus.json` (do `aiken build` sinh từ chính chữ ký `validator vault(...)`),
đối chiếu bằng `cd scripts && npm run check:params`. Ảnh chụp hiện thời, blueprint là
trọng tài: `lamp_policy_id`, `lamp_asset_name` (PARAM theo mạng — `tLAMP` testnet /
`LAMP` mainnet), `um_nft_policy`, `um_script_hash`, `backing_nft_policy`,
`backing_script_hash`, `ms_per_epoch`.

Bản cũ ở đây liệt 4 tham số và có `treasury_addr` — sai cả số lẫn tập. `applyParamsToScript`
không kiểm arity: apply theo danh sách đó vẫn ra script hash 28 byte trông hợp lệ, vault
vẫn nhận LAMP thật, rồi mọi tx spend fail vĩnh viễn.

### Danh sách invariants theo thứ tự thực thi

> **Bảng dưới là ảnh chụp mô hình cũ.** Số dòng `vault.ak:NNN` đã trôi; các dòng
> C-INST-1/2/3 tính trên `lamp_paid`, C-INST-4/4b nói về Treasury, C-PRUNE-2 nói về
> halving — cả sáu đều không còn. Danh sách đang chạy đọc thẳng ở
> `onchain/validators/vault.ak`.

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

> **I-ACT-7 — LAMP ĐỨNG YÊN (PHA-2).** `lamp_balance`, `lamp_locked`,
> `loyalty_holdings` là BẤT BIẾN qua InstantGen: validator ép chúng byte-identical với
> `applied_input` (xem khối `A02` trong `validators/vault.ak`). Bản cũ của bảng này ghi
> `lamp_balance - lamp_paid` và `remove_from_holdings(...)` — mô hình "trả LAMP sang
> Treasury" đã bị bỏ, hàm `remove_from_holdings` đã xoá khỏi `lamp.ak`.

| Field | Giá trị output |
|---|---|
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
[UM UTxO]      ──refIn──> │ (read-only, không consume)
[Beacon UTxO]  ──refIn──> │ (br_q, §6.3 — thiếu là cửa đóng)
                         │
                         ▼
                  [Vault UTxO']
                  (datum updated: batch mới, consumed_credit = 0)
                  (LAMP: GIỮ NGUYÊN từng byte — I-ACT-7)
                  (NFT danh tính vault phải còn nguyên)
```

> Sơ đồ cũ có thêm một nhánh `[Treasury UTxO] (receives LAMP)` và ghi `LAMP: old - paid`.
> Dựng tx theo hình đó là tx bị từ chối.

**Điểm eUTxO quan trọng:**
- UM datum là reference input — không bị consume. Nhiều InstantGen tx trong cùng block đều đọc được cùng UM UTxO.
- Vault UTxO bị consume → chỉ 1 InstantGen/block/vault. Tự nhiên ngăn race condition.
- LAMP: **không** dựa vào bảo toàn của ledger. Validator kiểm tường minh rằng
  `quantity_of(vault_output.value, lamp_policy_id, lamp_asset_name) == output_datum.lamp_balance`
  và ba trường LAMP giống hệt byte với input. Dòng cũ ở đây ghi
  `vault_output.lamp + treasury_output.lamp == vault_input.lamp` "không cần kiểm tường
  minh" — bám theo là mở đúng lỗ mà `ig_neg_value_drained` bắt.

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

Danh sách tham số apply lúc build đọc ở `parameters[]` trong `onchain/plutus.json` —
xem mục 2. Khối 4 dòng cũ ở đây (có `treasury_addr`) đã sai.

**Thứ tự apply phải khớp blueprint, không khớp `aiken.toml`.** Cổng máy:
`cd scripts && npm run check:params` — so tên + thứ tự giữa `parameters[].title` và
`scripts/deployParams.ts`. Nhánh `mint` và nhánh `spend` của cùng script đa-mục-đích phải
nhận **y hệt** danh sách, nếu không NFT danh tính mint ra không thuộc vault nào.

UM datum UTxO phải tồn tại trước khi bất kỳ InstantGen nào có thể chạy (validator `find_um_datum` fail nếu không có reference input với NFT đúng).

---

## 6. Các stub / locked handlers

### ApplyHalving — ĐÃ CHẾT
Không còn handler này. Slot constr 1 nay là `PruneExpired`: dọn rác batch chết,
permissionless (§7.4), có `reject-noop` chống spam và cấm chạm `consumed_credit`.
Xem [`DESIGN-PHASE2.md`](DESIGN-PHASE2.md) §3.

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
