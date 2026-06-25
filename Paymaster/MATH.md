# Paymaster — MATH (fee accounting, Q-format)

## GenMAGIC v3.3 · Module Paymaster · v1.0

NORMATIVE. P8: Aiken (`math.ak`) ↔ TypeScript (`offchain/src/math.ts`) bit-identical.
Nguồn: `Paymaster/onchain/lib/magiclamp/paymaster/math.ak`; `LAMP/docs/SPEC-Paymaster.md §4-5`.

---

## 1. Định nghĩa hình thức

| Ký hiệu | Đơn vị | Ý nghĩa |
|---|---|---|
| `Q` | — | `10^9` (scale Q-format). `math.ak:12`, `ProtocolUtils.Q`. |
| `oildrop` | — | `LAMP × 10^6`. |
| `nanogic` | — | `MAGIC × 10^9`. |
| `magic_consumed` | nanogic | `Σ BurnBatch.burns` trên vault PHÂN BIỆT. `util.ak:100-118`. |
| `lamp_per_magic_q` | Q-format | `lamp_oil / nanogic`. `Q` = 1 LAMP/MAGIC. `types.ak:28`. |
| `ada_per_magic_q` | Q-format | `lovelace / nanogic`. `types.ak:29`. |
| `lamp_this` | oildrop | LAMP App sponsor op này. `types.ak:71`. |
| `ada_this` | lovelace | ADA App sponsor op này. `types.ak:72`. |

---

## 2. Công thức chính

### 2.1 Trần sponsor (cap)

```
lamp_cap = ⌊ magic_consumed × lamp_per_magic_q / Q ⌋     (oildrop)       math.ak:16-18
ada_cap  = ⌊ magic_consumed × ada_per_magic_q  / Q ⌋     (lovelace)  math.ak:21-23
```

**Single-step floor** (1 nhân, 1 chia) — đại lượng tuyến tính, KHÔNG cần sequential floor
§6.1 (vốn cho `M = L×R×UM×PM/Q³`). 1 phép Q-format = 1 floor → bound rounding 0. `math.ak:6-9`.

Ràng buộc validator: `0 ≤ lamp_this ≤ lamp_cap`, `0 ≤ ada_this ≤ ada_cap` (`paymaster.ak:116-121`).
App có thể sponsor ÍT hơn cap (App tự chịu phần còn lại off-chain).

### 2.2 Magic consumed (dedup)

```
magic_consumed = Σ_{vref ∈ dedup(vault_refs)} Σ_{b ∈ burns(vref)} b.amount      util.ak:100-118
```

`burns(vref)` đọc từ redeemer `BurnBatch{burns}` thật của vault input (KHÔNG tin redeemer Sponsor).

### 2.3 Aggregate cross-meter (PM-12, chống double-satisfaction)

```
magic_total = Σ_{inp ∈ tx.inputs, inp @vault_script, redeemer = BurnBatch} sum_burns   paymaster.ak:246-275
ép: lamp_this ≤ lamp_cap(magic_total)  ∧  ada_this ≤ ada_cap(magic_total)               paymaster.ak:161-163
```

Vì PM-7 ép đúng 1 Meter/tx → `Σ lamp_this` qua mọi Meter = `lamp_this` này. 1 burn không thoả 2 claim
kể cả khi App khai thiếu `vault_refs` để hạ trần giả.

### 2.4 Meter state transition

```
(base_map, base_global) = if meter_in.epoch < current_epoch then ([], 0)              paymaster.ak:126-132
                          else (meter_in.did_lamp_map, meter_in.global_lamp_epoch)
did_spent  = lookup_did(base_map, did_key)                                            util.ak:138-143
meter_out.did_lamp_map     = add_did(base_map, did_key, lamp_this)                    util.ak:146-165
meter_out.global_lamp_epoch = base_global + lamp_this
```

`add_did`: key đã có → cộng dồn giữ vị trí; key mới → append CUỐI (`util.ak:152-164`). Offchain mirror
BYTE-PERFECT ở `math.ts addDid` (`offchain/src/math.ts:50-59`) để `meter_out` builder khớp validator.

---

## 3. Điều kiện biên

| Biên | Kết quả | Vị trí |
|---|---|---|
| `magic_consumed = 0` | fail (ép `> 0`) | `paymaster.ak:105` |
| `lamp_per_magic_q = 0` | `lamp_cap = 0`; nếu `protocol_fee_active` ⇒ fail (sàn) | `math.ak:42`, `paymaster.ak:108-113` |
| `magic_consumed × rate < Q` | `cap = 0` (floor) | `math.ak:46-49` |
| amount lớn (10^15+) | BigInt, KHÔNG overflow | `math.ak:51-54` |

---

## 4. Test vectors (verifiable, số thật)

| ID | Input | Output | Vị trí test |
|---|---|---|---|
| TV-PM-PRICE-01 | `lamp_cap(10_000_000, 500_000_000)` | `5_000_000` oildrop | `math.ak:27-30`, `paymaster.test.ts` |
| TV-PM-PRICE-02 | `ada_cap(50_000_000, 2_000_000_000)` | `100_000_000` lovelace | `math.ak:32-35` |
| TV-PM-UNIT | `lamp_cap(7_777_777, Q)` | `7_777_777` | `math.ak:37-40` |
| TV-PM-ZERO | `lamp_cap(10_000_000, 0)` | `0` | `math.ak:42-44` |
| TV-PM-FLOOR | `lamp_cap(3, 1)` | `0` | `math.ak:46-49` |
| TV-PM-BIG | `lamp_cap(10^15, 2×10^9)` | `2×10^15` | `math.ak:51-54` |

Cả 6 vector pass cả hai phía: Aiken (`aiken check`, math.ak tests) + TypeScript (`paymaster.test.ts` describe "math").

---

## 5. Tính đúng đắn P8 (bit-identical)

`lamp_cap`/`ada_cap`: cùng `magic × rate / Q` floor BigInt hai phía. `add_did`/`lookup_did`/`sum_burns`:
cùng thuật toán list (giữ thứ tự, append cuối). Datum/redeemer encode: constructor index = thứ tự khai
báo field Aiken (`types.ak`) = thứ tự `Data.Object` TS (`offchain/src/types.ts`). Test codec roundtrip +
kiểm tra index Constr runtime trong `paymaster.test.ts` describe "P8 codec".
