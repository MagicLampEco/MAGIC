# ConsumeMAGIC — FEAT v2 (engagement-state, rewrite D1)

## 1. Mục đích

ConsumeMAGIC cho phép holder TIÊU MAGIC để claim quyền dùng hạ tầng app (xử lý ảnh,
neo CID). MAGIC là **số kế toán** trong `VaultDatum.magic_batches` của generator vault
— **KHÔNG phải token native, KHÔNG MintingPolicy, KHÔNG `tx.mint`**. "Tiêu MAGIC" =
GIẢM `current_amount` của `MagicBatch` qua handler `BurnBatch` của VAULT validator
(nơi DUY NHẤT giảm MAGIC). ConsumeMAGIC là lớp **PRICING + ENGAGEMENT/ATTRIBUTION**:
nó định giá có thẩm quyền + ghi state per-app, ÉP cùng tx có vault input spend bằng
`BurnBatch` với `Σburns == required`. LAMP cố định 36 tỷ KHÔNG burn; ADA bảo toàn.

Nguồn: `ConsumeMAGIC/CONTRACT.md §B` (v2). Thay model token-burn v1 (PR #13).

---

## 2. Actors

| Actor | Vai trò |
|---|---|
| **Holder** | Sở hữu Engage UTxO (EngageDatum + thread NFT); gửi tx co-spend Engage + vault |
| **Keeper (Committee)** | Post/cập nhật PriceParam beacon epoch-đơn-điệu; M-of-N multi-sig |
| **App component** | Xác nhận đã thanh toán bằng **delta `consumed_nanogic`** của EngageDatum (giá trị SAU tx trừ giá trị TRƯỚC tx). **KHÔNG đọc `consumed_count`** — xem cảnh báo §2.1 |
| **Vault validator** | Module generator — `BurnBatch` GIẢM `current_amount`; nơi DUY NHẤT giảm MAGIC |

### 2.1 ⚠ App cấp dịch vụ theo GIÁ TRỊ, không theo LƯỢT

`consumed_count` chỉ đếm **số thao tác**, không mang giá trị. Ai trả một op rẻ
(`op_type=2`, neo CID, 1e6 nanogic) cũng làm `consumed_count` tăng đúng +1 — rồi đòi app
cấp một op đắt (`op_type=1`, xử lý ảnh, 1e7). Trả thiếu **10×**, mà mọi bất biến on-chain
vẫn thoả: validator không biết app định phục vụ nghiệp vụ nào.

App PHẢI đọc **delta `consumed_nanogic`** và chỉ cấp dịch vụ khi
`delta ≥ giá niêm yết của nghiệp vụ đang phục vụ`. Validator ép
`Σ consumed_nanogic(out) == Σ(in) + total_required` (TECH.md W-CM-12), nên delta chính là
số nanogic đã thực trả trong tx đó. Cũng KHÔNG đọc giá trị TUYỆT ĐỐI của
`consumed_nanogic` như "hạn mức còn lại" — nó là tổng tích luỹ đời thread.

Nguồn: `CONTRACT.md §E`, `onchain/lib/magiclamp/consume/types.ak` (docstring
`consumed_nanogic`), `EXEC.md §5`.

---

## 3. Flows

### 3.1 Happy path — 1 Engage + 1 vault, 1 nghiệp vụ (co-spend 2-validator)

```
Holder                      Lucid tx-builder                Cardano ledger
  │                               │                               │
  │── buildConsumeTx(op=1, n=1) ──►                               │
  │                               │── read PriceParam beacon (ref-input) ►
  │                               │◄── PriceParam (epoch, demand_mult) ──│
  │                               │── required = ⌊base×demand_mult×n/Q⌋ [offchain, từ beacon]
  │                               │── build tx (KHÔNG mint):       │
  │                               │    spend Engage UTxO (Consume) │
  │                               │    spend vault UTxO  (BurnBatch Σburns==required)
  │                               │    output Engage UTxO (consumed_count++, value preserved)
  │                               │    output vault  UTxO (magic_batches −= burns)
  │                               │    validity-range CHẶT ≤ 1 epoch
  │                               │── submit ──────────────────────►
  │                               │                               │── validate consume.ak (C-CM-1..5)
  │                               │                               │── validate vault BurnBatch
  │◄── confirmed ─────────────────│◄────────────────────────── tx │
```

**Điều kiện kết thúc:** `consumed_nanogic` tăng đúng `required` (đây là thứ app đọc);
`consumed_count` tăng đúng `op_count` (thống kê/attribution); `vault.magic_batches` giảm
đúng `required`; value Engage UTxO bảo toàn tuyệt đối; KHÔNG mint.

### 3.2 Happy path — N Engage input (batch tx)

N Engage input trong 1 tx, mỗi cái redeemer `Consume{op_type, op_count, price_ref,
vault_ref}` riêng (cùng `price_ref` — cùng beacon). Validator chạy 1 lần/input nhưng
kiểm tra **AGGREGATE idempotent** (mirror qua mọi invocation):
- `total_required = Σ price(op_type_i)×op_count_i` qua MỌI Engage input.
- `total_burned   = Σ burns` qua MỌI `vault_ref` PHÂN BIỆT (mỗi vault đếm 1 lần).
- `total_burned == total_required` (`==`, KHÔNG `≥` — over-burn = giảm MAGIC vô cớ → CẤM).
- `#out@engage == #in@engage` (không collapse).
- `Σ engageNFT(out) == Σ engageNFT(in)` (không rút thread token).
- `Σ consumed_count(out) == Σ(in) + Σ op_count` (không bỏ sót state).

**Chống pay-once-consume-N:** N Engage cùng `op_count=1` trỏ CHUNG 1 vault burn 10M →
`total_required = N×10M != total_burned = 10M` → REJECT.

Tham chiếu: `consume.ak:sum_required_over_engage_inputs`,
`consume.ak:distinct_vault_refs_over_engage_inputs`, `consume.ak:enforce_engagement`.

### 3.3 Cập nhật PriceParam

Committee M-of-N spend beacon UTxO, re-create với:
- `epoch` tăng đơn điệu (chống rollback về giá cũ khi demand đã lên).
- `demand_mult` mới từ FIR (SMA-N load_raw, clamp `[m_min, m_max]`).
- Bảng `op_prices` có thể thay đổi (governance).

Tham chiếu: `price_param.ak`.

### 3.4 Genesis deploy

- Mint NFT one-shot beacon (`price_nft.ak`, parameterized bởi `genesis_ref`). Post UTxO
  tại địa chỉ `price_param` validator mang NFT + PriceParam datum.
- Mint thread NFT bằng **handler `mint` của chính `consume`** (redeemer `MintEngage { seed }`)
  — KHÔNG còn `engage_nft.ak`. Policy = script hash `consume` (tự tham chiếu); tên NFT =
  `blake2b_256(cbor.serialise(seed))` với `seed` là UTxO bị tiêu trong chính tx đó
  (one-shot, permissionless, N thread / 1 policy).
  Tạo Engage UTxO tại địa chỉ `consume` validator mang NFT + EngageDatum
  `{owner, consumed_count:0, last_epoch:0, did_commit, consumed_nanogic:0}` — ba trục kế
  toán đều 0, `did_commit` đặt 1 lần (MVP rỗng), immutable sau đó.
  Off-chain: `offchain/src/consume.ts:buildMintEngageTx` — tx RIÊNG, không gộp với consume.

---

## 4. Invariants (bất biến giao thức)

| ID | Phát biểu | Nguồn |
|---|---|---|
| C-CM-1 | Value preservation @engage: Engage UTxO chỉ giữ ADA + thread NFT (KHÔNG MAGIC/LAMP); `Σ value(out@engage) == Σ value(in@engage)` TUYỆT ĐỐI. KHÔNG `tx.mint` | `consume.ak:engage_value_preserved` |
| C-CM-2 | `total_burned == total_required` (AGGREGATE qua mọi Engage input/vault_ref phân biệt; `==`, KHÔNG `≥`); giá đọc từ PriceParam beacon (xác thực NFT), không tin amount client; vault input phải ở `vault_script_hash` + redeemer constr == `burn_batch_constr` | `consume.ak:sum_required_over_engage_inputs`, `sum_burns_over_vault_refs` |
| C-CM-3 | Double-satisfaction guard (đếm theo payment script hash): `#out@engage == #in@engage`; `Σ engageNFT(out) == Σ engageNFT(in)`; `Σ consumed_count(out) == Σ(in) + Σ op_count` | `consume.ak:n_in==n_out`, `nft_in==nft_out`, `enforce_engagement` |
| C-CM-4 | Mỗi output@engage mang đúng 1 thread NFT; `owner` bảo toàn; `last_epoch = current_epoch`; `did_commit` IMMUTABLE (`out == in`) | `consume.ak:enforce_engagement` |
| C-CM-5 | Stale price: `0 ≤ current_epoch − PriceParam.epoch ≤ max_price_stale`; `current_epoch` tính từ UPPER bound, hai biên Finite, cửa sổ nằm TRỌN trong MỘT epoch (`⌊lo/mspe⌋ == ⌊hi/mspe⌋`) | `consume.ak` dòng stale + `util.get_epoch` |
| C-CM-6 | GIÁ TRỊ đã trả: `Σ consumed_nanogic(out@engage) == Σ(in@engage) + total_required`. Song song C-CM-3 (LƯỢT) — count không phân biệt op rẻ/đắt nên chỉ đếm lượt là trả thiếu 10× vẫn hợp lệ. App cấp dịch vụ theo **delta** trường này | `consume.ak:enforce_engagement` (`sum_nanogic_inputs/outputs`) |
| C-CM-7 | Genesis SẠCH: thread NFT chỉ ra đời qua `MintEngage { seed }` của chính `consume`; seed bị tiêu (one-shot); tên = `blake2b_256(cbor(seed))`; đúng 1 output tại địa chỉ script này mang NFT; `owner ∈ extra_signatories`; `consumed_count == consumed_nanogic == last_epoch == 0`; ≤ 2 policy trên output | `consume.ak:validate_mint_engage_id` |
| C-CM-8 | Mint và spend KHÔNG đi chung 1 tx: `script_inputs_confined_to(inputs, own_hash, vault_script_hash)` + cổng "mọi input @engage mang đúng 1 thread NFT" | `consume.ak` + `util.script_inputs_confined_to` |
| C-CM-9 | Bảng giá `op_prices`: `op_type` TĂNG NGẶT (dạng chuẩn tắc), ≤ 16 dòng, mọi dòng `base_price × m_min ≥ Q`, `m_min`/`m_max` PIN về hằng | `pricing.ak:valid_param`, `sorted_strict_op_types`; gương off-chain `price.ts:assertValidPriceParam` |

---

## 5. Edge cases (MECE)

| Tình huống | Xử lý |
|---|---|
| `op_type` không có trong bảng giá | `pricing.required_for` trả `None` → `expect Some(req)` fail → reject |
| Under-burn (`Σburns < required`) | `expect total_burned == total_required` fail |
| Over-burn (`Σburns > required`) | `==` fail → REJECT (accounting cấm giảm MAGIC vô cớ) |
| Multi-engage share vault under-charge | `total_required (N×) != total_burned (1×)` fail |
| Price stale (`cur_epoch − pp.epoch > max_stale`) | fail `C-CM-5` |
| Validity-range under-state (upper vô hạn / cửa sổ > 1 epoch) | `util.get_epoch` expect fail (get_finite upper + cửa sổ ≤ ms_per_epoch) |
| Beacon NFT qty ≠ 1 (datum hijacking) | `expect ... == 1` trong `read_price_param` fail |
| `base_price` âm trong beacon | `pricing.valid_param` fail trước khi tính giá |
| Drain ADA / token khác khỏi Engage UTxO | `engage_value_preserved` fail |
| N input cùng owner, chỉ 1 output (collapse) | `n_in == n_out` fail |
| N input, rút 1 engage NFT ở output | `nft_in == nft_out` fail |
| State dưới-đếm (1 output không tăng consumed_count) | `Σ consumed == Σ in + Σ op` fail |
| Vault input redeemer constr ≠ burn_batch_constr | `expect idx == burn_batch_constr` fail |
| Epoch rollback (price_param cập nhật epoch ≤ cũ) | `out_datum.epoch > datum.epoch` trong `price_param.ak` fail |
| `demand_mult > m_max` trong beacon | `valid_param` fail → consume fail |
| Bảng giá không sắp xếp / trùng `op_type` | `sorted_strict_op_types` fail. Off-chain chặn sớm: `assertValidPriceParam` ném `PRICE-014` |
| Bảng giá > 16 dòng | `list.length ≤ max_op_prices` fail (chống DoS ex-unit). Off-chain: `PRICE-013` |
| Genesis bẩn (`consumed_nanogic` bịa lúc mint) | `validate_mint_engage_id` ép `== 0` — bất biến delta ở spend chỉ khoá phần TĂNG, không khoá GỐC |
| `op_count ≤ 0` từ app | On-chain `expect op_count >= 1`. Off-chain **ném** `PRICE-002`/`CONSUME-008` (trả 0 im lặng = fail-open: app cấp dịch vụ rồi tx mới chết) |

---

## 6. Out-of-scope

- Định giá đối tượng nghiệp vụ cụ thể của app (bò vs gà trong OriLife) — việc app component.
- Token-hoá MAGIC thành native asset (mâu thuẫn ràng buộc nền: MAGIC = accounting).
- Burn LAMP.
- Nghiệp vụ ngoài `op_type` khai báo trong PriceParam beacon.
- Quản lý membership committee (ngoài threshold M-of-N đã có).
