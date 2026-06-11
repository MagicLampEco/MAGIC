# ConsumeMAGIC — FEAT v1 (feat/consume-magic-v1)

## 1. Mục đích

ConsumeMAGIC cho phép holder đốt MAGIC từ vault để claim quyền sử dụng hạ tầng của ứng dụng (app delegation). MAGIC là số kế toán trong datum vault — **KHÔNG phải token native**; "đốt" thực hiện qua `tx.mint` âm trên policy MAGIC. Module này chỉ chạm policy MAGIC; LAMP và ADA bảo toàn tuyệt đối.

Nguồn: `ConsumeMAGIC/CONTRACT.md §B`.

---

## 2. Actors

| Actor | Vai trò |
|---|---|
| **Holder** | Sở hữu vault UTxO mang EngageDatum; gửi tx tiêu MAGIC |
| **Keeper (Committee)** | Post/cập nhật PriceParam beacon epoch-đơn-điệu; M-of-N multi-sig |
| **App component** | Đọc `consumed_count` từ EngageDatum để xác nhận nghiệp vụ đã thanh toán |
| **Ledger / Cardano** | Ép `tx.mint` — tổng supply MAGIC giảm đúng `magic_burned` |

---

## 3. Flows

### 3.1 Happy path — 1 vault input, 1 nghiệp vụ

```
Holder                      Lucid tx-builder                Cardano ledger
  │                               │                               │
  │── consumeBuilder(op=1, n=1) ──►                               │
  │                               │── read PriceParam beacon ─────►
  │                               │◄── PriceParam (epoch, dm) ────│
  │                               │── compute required = price(1)×1 ──► [offchain]
  │                               │── build tx:                   │
  │                               │    mint  MAGIC −required      │
  │                               │    spend vault UTxO           │
  │                               │    output vault UTxO+1        │
  │                               │    (EngageDatum.consumed_count++)
  │                               │── submit ──────────────────────►
  │                               │                               │── validate consume.ak
  │                               │                               │   C-CM-1..5 ✓
  │◄── confirmed ─────────────────│◄────────────────────────── tx │
```

**Điều kiện kết thúc:** `consumed_count` tăng đúng `op_count`; MAGIC bị đốt; ADA/LAMP bảo toàn.

### 3.2 Happy path — N vault input cùng owner (batch tx)

N vault input cùng owner trong 1 tx. Mỗi input có redeemer `Consume{op_type, op_count, price_ref}` riêng. Validator chạy 1 lần/input nhưng kiểm tra **aggregate**:
- `magic_burned ≥ Σ required` (qua tất cả vault input tại `own_hash`).
- `#out@script == #in@script` (không collapse).
- `Σ engage NFT(out) == Σ engage NFT(in)` (không rút thread token).
- `Σ consumed_count(out) == Σ consumed_count(in) + Σ op_count` (không bỏ sót state).

Tham chiếu: `consume.ak:sum_required_over_vault_inputs`, `consume.ak:enforce_engagement`.

### 3.3 Cập nhật PriceParam

Committee M-of-N spend beacon UTxO, re-create với:
- `epoch` tăng đơn điệu (chống rollback về giá cũ).
- `demand_mult` mới từ FIR (SMA-N load_raw, clamp `[m_min, m_max]`).
- Bảng `op_prices` có thể thay đổi (governance).

Tham chiếu: `price_param.ak`.

### 3.4 Genesis deploy beacon

Mint NFT one-shot (`price_nft.ak`, parameterized bởi `genesis_ref`). Post UTxO tại địa chỉ `price_param` validator mang NFT + PriceParam datum.

---

## 4. Invariants (bất biến giao thức)

| ID | Phát biểu | Nguồn |
|---|---|---|
| C-CM-1 | `tx.mint` chỉ chứa đúng 1 entry (magic_policy, magic_name, qty âm); ADA + LAMP + mọi asset khác bảo toàn tuyệt đối giữa `Σin@script` và `Σout@script` | `consume.ak:check_only_magic_burn`, `non_magic_value_preserved` |
| C-CM-2 | `magic_burned ≥ Σ price(op_type,demand_mult) × op_count`; giá đọc từ PriceParam beacon (xác thực NFT), không tin amount client | `consume.ak:sum_required_over_vault_inputs` |
| C-CM-3 | Double-satisfaction guard: aggregate `magic_burned` so với tổng required tất cả vault input tại `own_hash`; `#out == #in`; `Σ nft_out == Σ nft_in` | `consume.ak:n_in==n_out`, `nft_in==nft_out` |
| C-CM-4 | Continuing output vault mang đúng 1 engage NFT; `owner` bảo toàn; `last_epoch = current_epoch`; `Σ consumed_count(out) == Σ consumed_count(in) + Σ op_count` | `consume.ak:enforce_engagement` |
| C-CM-5 | Stale price: `current_epoch − PriceParam.epoch ≤ max_price_stale` | `consume.ak` dòng `current_epoch - pp.epoch <= max_price_stale` |

---

## 5. Edge cases (MECE)

| Tình huống | Xử lý |
|---|---|
| `op_type` không có trong bảng giá | `pricing.required_for` trả `None` → `expect Some(req)` fail → tx reject |
| `magic_burned < required` (under-burn) | `expect magic_burned >= total_required` fail |
| Over-burn (`magic_burned > required`) | Cho phép — holder trả dư, giao thức không hoàn lại |
| Price stale (`cur_epoch − pp.epoch > max_stale`) | fail `C-CM-5` |
| Beacon NFT qty ≠ 1 (datum hijacking) | `expect ... == 1` trong `read_price_param` fail |
| `base_price` âm trong beacon | `valid_param` fail trước khi tính giá |
| Drain ADA từ vault | `non_magic_value_preserved` fail |
| Drain token khác (không phải MAGIC) từ vault | `non_magic_value_preserved` fail |
| N input cùng owner, chỉ 1 output (collapse) | `n_in == n_out` fail |
| N input, rút 1 engage NFT ở output | `nft_in == nft_out` fail |
| State dưới-đếm (1 input không tăng consumed_count) | `Σ consumed == Σ in + Σ op` fail |
| Epoch rollback (price_param cập nhật epoch thấp hơn) | `out_datum.epoch > datum.epoch` trong `price_param.ak` fail |
| `demand_mult > m_max` trong beacon | `valid_param` fail → consume fail |

---

## 6. Out-of-scope

- Định giá đối tượng nghiệp vụ cụ thể của app (ví dụ: bò vs gà trong OriLife) — đó là việc app component.
- Token-hóa MAGIC thành native asset riêng biệt.
- Burn LAMP.
- Bất kỳ nghiệp vụ nào ngoài `op_type` được khai báo trong PriceParam beacon.
- Quản lý membership committee (ngoài threshold M-of-N đã có).
