# MAGIC — Đặc tả tính năng HỢP NHẤT (triple-token, vai CREDIT)

> **Neo chuẩn tối thượng:** `SPEC/Whitepaper-MagicLamp-Tokenomic-Vi.md §7` (Cơ chế Gen MAGIC từ LAMP) — khi mâu thuẫn với module spec cũ, Whitepaper thắng.
> **Ngày:** 2026-07-17 · **Trạng thái:** normative feature-spec, gộp toàn bộ cơ chế MAGIC theo mô hình mới (nắm-LAMP-mở-tư-cách + credit-consume).

---

## 0. Phạm vi + quy ước

Tài liệu này là đặc-tả-tính-năng HỢP NHẤT cho **toàn bộ giao thức MAGIC** trên Cardano PlutusV3 (hệ ba token LAMP·MAGIC·CARP). Nó thay thế các module-spec cũ (`InstantGen/FEAT.md`, `ScheduleGen/FEAT.md`, `SnapshotGen`, …) ở mọi chỗ mâu thuẫn. Các module-spec cũ chỉ còn giá trị **tham chiếu cấu trúc + độ-đầy-đủ**; mọi cơ chế đã bỏ (xem §12) KHÔNG được đưa vào code mới.

Quy ước ký hiệu (Whitepaper §4, §7.1; `InstantGen/MATH.md §1`):

| Ký hiệu | Nghĩa | Đơn vị |
|---|---|---|
| `Q` | thang fixed-point | `10^9` |
| oildrop | LAMP sub-unit | `LAMP × 10^6` |
| nanogic | MAGIC sub-unit | `MAGIC × 10^9` |
| `e` | epoch hiện tại (Cardano, ≈5 ngày) | — |
| `P* = 1` | mức-neo par (1 MAGIC = 1 đơn-vị-dịch-vụ-nền) | — |

**Đơn-vị-dịch-vụ chuẩn (Whitepaper §4, nguồn chân lý):** `1 nanogic = 1 byte·ngày` lưu-lạnh ⟺ `1 MAGIC = 1 GB·ngày`. **KHÔNG neo fiat** — mọi quy đổi USD/VND chỉ để tính nhẩm nội bộ.

**Bất biến kỹ thuật xuyên suốt (áp cho MỌI cơ chế):**
- **BigInt mọi nơi** cho oildrop/nanogic/Q-format (`C-OVERFLOW`; `InstantGen/MATH.md TV-OVERFLOW-07`). Cấm `Number` cho số lượng.
- **Q-format bit-identical Aiken↔TypeScript (P8)** với **sequential-floor multiplications** (mỗi bước `⌊ × / Q ⌋` riêng, không gộp một phép nhân-chia lớn) — `InstantGen/MATH.md §8`, `CLAUDE.md §invariants`.
- **Chỉ số kiến trúc datum-constructor Cardano phải khớp thứ tự Aiken type** (đổi thứ tự variant một bên = vỡ decode bên kia).

---

## 1. Bản chất MAGIC = CREDIT (prepaid service credit)

MAGIC là **vai CREDIT** của một instance Carpet (LAMP=BASE, CARP=UNIT). Nó là **quyền-tiêu-dịch-vụ trả trước** (prepaid service credit), KHÔNG phải tài sản tài chính. (Whitepaper §4; `ConsumeMAGIC/FEAT.md §1`.)

**MAGIC KHÔNG là token:**
- KHÔNG có policy-id, KHÔNG có MintingPolicy, KHÔNG `tx.mint`.
- MAGIC = **số kế toán (entitlement) trong datum vault**: `VaultDatum.magic_batches[].current_amount` (nanogic).
- **Không chuyển nhượng** — chỉ chủ-DID đã sinh ra nó tiêu được.
- **Không chuộc ra tiền** — chỉ chuộc-ra-DỊCH-VỤ (tiêu trong hệ). Cửa một chiều tuyệt đối (firewall F1).
- **Decay/tan biến** — không tiêu trong hạn thì mất (chi tiết mỗi cơ chế; InstantGen reset mỗi epoch, xem §2).

**Neo giá trị:** par `P* = 1` theo **sức-mua-dịch-vụ nội sinh** (`base_price` khoá on-chain, đổi chỉ qua DAO), KHÔNG neo fiat (Whitepaper §4).

**"Tiêu MAGIC" = ĐỐT:** GIẢM `current_amount` của một `MagicBatch` qua handler **`BurnBatch`** của VAULT validator — đây là **nơi DUY NHẤT** giảm MAGIC trong toàn hệ (`ConsumeMAGIC/FEAT.md §1`, `Paymaster/FEAT.md §1`). LAMP cố định 36 tỷ **KHÔNG burn**; ADA bảo toàn.

**Gen ≠ Mint** (Whitepaper §15): **Gen** = cấp-quyền (MAGIC entitlement, không tăng cung-tiền); **Mint** = đúc-tiền (CARP). Cấm dùng "mint MAGIC" / "gen CARP".

### 1.1 Sáu cơ chế của MAGIC (bản đồ)

| # | Cơ chế | Vai trò | Nơi tăng/giảm MAGIC |
|---|---|---|---|
| 1 | **InstantGen** (gộp SnapshotGen cũ) | nắm LAMP mở tư-cách → Gen quyền-tiêu-ngay trong thặng dư | tăng (Gen batch) |
| 2 | **ScheduleGen** | khoá tư-cách LAMP → dòng `pp` MAGIC/epoch × `N` | tăng (Gen batch/fire) |
| 3 | **ConsumeMAGIC** | định giá + tiêu MAGIC lấy dịch vụ | giảm (co-spend `BurnBatch`) |
| 4 | **Consolidate** | gộp `loyalty_holdings`/`magic_batches` phân mảnh | không đổi tổng |
| 5 | **Paymaster** | delegate đốt MAGIC thay owner (fee abstraction) | giảm (co-spend `BurnBatch`) |
| 6 | **FlowRate** | keeper cập nhật `demand_mult` (dual-EMA) cho pricing ConsumeMAGIC | không đụng MAGIC |

---

## 2. InstantGen — nắm LAMP mở tư-cách, tiêu ngay trong thặng dư

> Neo chuẩn chi tiết: `InstantGen/MATH.md` (bản mới 16/7, đã qua phản biện đối kháng) + Whitepaper §7.2. **Gộp SnapshotGen + InstantGen cũ.** BỎ hoàn toàn mô hình mua-trả-LAMP cũ (`M = L_paid×R×UM×PM/Q³`), UM, profile, LF, halving.

### 2.1 Mục đích

Người **nắm LAMP đủ tư-cách** (LAMP **ở-yên-ví**, KHÔNG chuyển đi đâu) được cấp một **trần-suất quyền-tiêu MAGIC mỗi epoch**, CHỈ trong phần **thặng dư bảo chứng** của hệ. Đây là cơ chế **khuyến-khích-tham-gia điều-kiện-hoá-bởi-tiêu-MAGIC-thật**, KHÔNG phải lợi-tức-thụ-động (Whitepaper §7.2; firewall F3/F8).

### 2.2 Điều kiện cần (cả hai — Whitepaper §7.2)

1. **Nắm LAMP đủ tư-cách** (mở tư-cách/gate).
2. **Tiêu dùng thật MAGIC trong epoch** qua nền-tảng-đăng-ký — nếu không tiêu thật thì KHÔNG phát suất.

### 2.3 Công thức lượng cấp (`InstantGen/MATH.md §2–§5`)

Cửa-sổ cộng-dồn tư-cách `W = 7` epoch (`i = 0..6`), trọng số phẳng `wᵢ = 1/7`.

**Bước 1 — `L_i` = LAMP đủ-tư-cách TWAB (R2, `MATH.md §2`):**
```
L_i = ⌊ ( Σ_j balance_j × dur_j ) / len_epoch ⌋      (oildrop)
```
- Lấy **số-dư-trung-bình-thời-gian** (TWAB) trong epoch `e−i`, KHÔNG lấy mẫu-điểm → chống flash-hold.
- **Cắt đuôi khi bán:** bán ra → `balance_j` tụt NGAY, không kéo đuôi → chống đuôi-hậu-thoát.
- Nguồn dữ liệu: bản ghi `loyalty_holdings` (`amount` + `acquired_epoch` + mốc thay đổi).

**Bước 2 — `M(L)` gen-nền một epoch (`MATH.md §3`):**
```
M(L) = ⌊ L × R_gen_q / Q ⌋      (oildrop → nanogic; 1 bước floor)
```
`R_gen_q` = suất-nền gen (**governance, GIẢ ĐỊNH** `= Q = 10^9`, benchmark sau — `MATH.md §1`).

**Bước 3 — `M_raw` trung-bình phẳng 7 epoch (`MATH.md §4`, sum-then-floor):**
```
M_raw = ⌊ ( Σ_{i=0..6} M(L_i) ) / 7 ⌋
```

**Bước 4 — cổng thặng-dư + trần-kép + van-đỏ → `M_grant` (`MATH.md §5`, Whitepaper §7.2):**

Đọc `br_q, S, pp_sched` từ **GlobalState** (GreenBack) qua `reference_input` (freshness §2.5).
```
Chế độ:  xanh nếu br_q > br_safe_q ; đỏ nếu br_q ≤ br_safe_q

Van-đỏ:   M_grant = 0                       khi ĐỎ (khoá gen toàn mạng)
Depeg:    M_grant = 0                       khi CARP/MAGIC < P* (đọc GlobalState)

Xanh:
  cap_surplus = ⌊ ⌊ f_max_q × S / Q ⌋ × (br_q − br_safe_q) / br_safe_q ⌋
  double_cap  = ⌊ pp_sched / 2 ⌋            (InstantGen ≤ 0.5× Schedule)
  M_grant     = min( M_raw , cap_surplus , double_cap )
```
Hằng số: `br_safe_q = 1_500_000_000` (1.5×), `f_max_q = 100_000_000` (0.10×).

### 2.4 Decay — RESET mỗi epoch (pin-mặt-trời, `MATH.md §7`)

`M_grant` là **TRẦN-SUẤT epoch này**, KHÔNG cộng-dồn thành bể-quyền tiêu sau (use-it-or-lose-it). Không tiêu hết epoch `e` → phần dư = 0 ở `e+1`. **BỎ** halving, decay-hình-học nhiều epoch, profile decay_window.

### 2.5 Bất biến riêng InstantGen

| ID | Phát biểu | Nguồn |
|---|---|---|
| **R1** value-reconciliation | Mọi lần đọc lamp_balance để tính `L_i` PHẢI ép `assets.quantity_of(vault_utxo, lamp_policy, lamp_name) == datum.lamp_balance` tại chỗ đọc — chặn genesis-vault khai-khống farm gen | `MATH.md §2`, TV-GEN-VALUE-RECON-06 |
| **R2** TWAB | `L_i` = trung-bình-thời-gian, cắt-đuôi-khi-bán | `MATH.md §2`, TV-GEN-TAIL-05 |
| **R3** per-DID | Tư-cách gen gắn **DID one-shot NFT** (không phải owner pkh tự-khai); **1 suất-gen / DID / epoch** (chống double-gen cùng-LAMP qua nhiều vault); `L_i` gộp theo DID | `MATH.md §6` |
| Freshness | `gs.epoch == e` (hoặc `e − gs.epoch ≤ MAX_GS_STALENESS` nếu GreenBack trễ 1 epoch) — chống ref-input cũ đọc br giả cao | `MATH.md §6` |
| Van-đỏ | `M_grant = 0` khi `br_q ≤ br_safe_q` | `MATH.md §5`, TV-GEN-RED-02 |
| Depeg-brake | `cap = 0` khi CARP/MAGIC rớt dưới `P*` | Whitepaper §7.2, `MATH.md §5` |
| Trần-kép | `M_grant ≤ ⌊pp_sched/2⌋` mọi trạng thái | `MATH.md §5`, TV-GEN-DOUBLECAP-03 |
| INV-CASHBACK-BOUND | hoàn/thưởng mỗi DID ≤ phí-thật-đã-ĐỐT của DID đó (kiểm ở lớp tiêu/hoàn, không ở gen) | `MATH.md §5`, Whitepaper §7.2 |

### 2.6 Test vectors NORMATIVE

`InstantGen/MATH.md §9`: TV-GEN-FLAT-01 (nắm ổn định, xanh), TV-GEN-RED-02 (van đỏ M=0), TV-GEN-DOUBLECAP-03 (trần-kép), TV-GEN-SURPLUS-04 (thặng-dư mỏng), TV-GEN-TAIL-05 (TWAB cắt đuôi), TV-GEN-VALUE-RECON-06 (R1 chặn khai-khống), TV-OVERFLOW-07 (BigInt bắt buộc). Dev PHẢI implement khớp bit-identical hai phía.

### 2.7 Cảnh báo pháp-lý + truyền-thông (Whitepaper §7.2, §11)

KHÔNG được hiểu/quảng bá InstantGen như **thu-nhập-thụ-động** hay "giữ LAMP ăn lãi". Thưởng chỉ phát khi **tiêu dùng thật** trong epoch, chỉ trong thặng dư. Mọi narrative "đầu-tư-sinh-lời" là **sai bản chất và bị cấm trong marketing**.

---

## 3. ScheduleGen — khoá tư-cách LAMP, dòng MAGIC đều mỗi epoch

> Neo chuẩn: Whitepaper §7.3. **BỎ khoá-tỷ-giá (`rate_locked_q`/T8) + hệ 16-shard** (contract normative 16/7). Các invariant shard/rate-lock trong `ScheduleGen/FEAT.md` cũ KHÔNG áp dụng.

### 3.1 Mục đích

Một người/đơn vị cần **dòng MAGIC đều dài hạn** (vd trả công đội kỹ thuật) mà không ôm sẵn cả đống MAGIC. Họ **khoá tư-cách một lượng LAMP** (LAMP **vẫn nằm trong ví họ**, không bị mang đi, trả lại nguyên vẹn khi hết hợp đồng) và được đảm bảo dòng `pp` MAGIC/epoch trong `N` epoch (Whitepaper §7.3).

### 3.2 Luồng bốn bước (Whitepaper §7.3)

1. **Ký hợp đồng (Commit):** đăng ký dòng `pp` MAGIC/epoch × `N` epoch. Hệ kiểm tra **cổng giới hạn** (§3.3). Đủ chỗ thì nhận; không thì từ chối/xếp hàng. `start_fire_epoch = commit_epoch + 2` (buffer 2 epoch).
2. **Tạo MAGIC vào quỹ GreenBack:** lượng này **chưa lưu thông** (chưa tính vào cung cần-bảo-chứng) — tạo nó không làm tăng-giảm bảo chứng ngay.
3. **Dùng phần xa-hạn để bình ổn:** hệ luôn giữ đủ cho **2 epoch tới** (`buffer_ep = 2`). Phần MAGIC các epoch xa hơn được GreenBack dùng mua LAMP đáy → góp backing + đỡ giá. (Việc GreenBack, xem §8.)
4. **Trả dần mỗi epoch — TRẦN cứng:** mỗi epoch tiêu **tối đa `pp`** (không rút-dồn nhiều epoch vào một lần). Muốn nhiều hơn → ký hợp đồng gối-đầu (lại qua cổng). Tiêu xong MAGIC bị đốt (qua ConsumeMAGIC/BurnBatch).

**Fire permissionless:** bất kỳ keeper nào cũng kích được fire — owner không cần online sau commit (giữ nguyên tinh thần `ScheduleGen/FEAT.md §3.2`, `C-SCH-FIRE-PERMISSION`).

### 3.3 Cổng giới hạn — vì sao Schedule phải NHỎ (Whitepaper §7.3)

```
Σ nghĩa-vụ-còn-lại  ≤  κ × Sức-tải-các-quỹ-cứu
```
- Sức-tải = số dư các quỹ cứu nội bộ (RedBack + kho dự phòng nền tảng + Kho bạc MagicLamp).
- **`κ = 0.6` cố định**, CẤM đổi giữa vòng đời hợp đồng.
- **TUYỆT ĐỐI KHÔNG dùng giá LAMP** hay bất kỳ dữ liệu giá thị trường nào để tính cổng (firewall F6).
- Hệ quả: quỹ cứu nhỏ → nhận ít hợp đồng; Schedule co-giãn theo sức khoẻ thật.

**Bậc-thang-cứu 5 bậc** (khi GreenBack thiếu tiền trả) do **GreenBack lo**, ngoài scope module MAGIC-Gen (Whitepaper §7.3; §8 tài liệu này).

### 3.4 Bất biến riêng ScheduleGen (giữ lại từ `ScheduleGen/FEAT.md`, LOẠI shard/rate-lock)

| ID | Phát biểu | Nguồn |
|---|---|---|
| C-SCH-1 | `L ∈ [10, 200]` | `ScheduleGen/FEAT.md` C-SCH-1 |
| C-SCH-2 | `λ ≥ 1_000_000 oildrop` (1 LAMP) | C-SCH-2 |
| C-SCH-3 | `L × λ ≤ l_avail` (LAMP đủ tư-cách, unlocked) | C-SCH-3 |
| C-SCH-7 | `start_fire_epoch = commit_epoch + 2` | C-SCH-7; Whitepaper §7.3 |
| C-SCH-10 | `|gen_schedules| < MAX_GEN_SCHEDULES (20)` | C-SCH-10 |
| C-SCH-GATE | `Σ nghĩa-vụ-còn-lại ≤ 0.6 × sức-tải-quỹ-cứu` (đọc nội bộ, KHÔNG giá LAMP) | Whitepaper §7.3 |
| C-SCH-PP-CAP | Mỗi epoch tiêu ≤ `pp` (trần cứng, bất khả xâm) | Whitepaper §7.3, §4 |
| C-FIRE-1 | Fire hợp lệ: `fires_in_tx > 0`, `e_i ≤ current_epoch` (catch-up) | C-FIRE-1 |
| C-FIRE-5 | Xoá schedule khi `fired_count == N` | C-FIRE-5 |
| C-SCH-FIRE-PERMISSION | Fire KHÔNG cần chữ ký owner | C-SCH-FIRE-PERMISSION |
| MAX_FIRES_PER_TX_CATCHUP | `fires_in_tx ≤ 8` | constants |
| MAX_BATCHES_PER_VAULT | `|magic_batches| ≤ 32` | constants |
| C-VAULT-DS-1 / OUT-1 | đúng 1 vault input + đúng 1 vault output theo script hash | C-VAULT-DS-1/OUT-1 |
| No-cancel (T10) | KHÔNG commit-cancel/refund — commit rồi thì fire hết hoặc hết hạn | `ScheduleGen/FEAT.md §5`, Whitepaper §12 |

> [NEEDS-EVIDENCE] Chi tiết on-chain của cổng `κ×sức-tải-quỹ-cứu` và cơ chế `pp`-per-epoch trong datum ScheduleGen mới chưa có file MATH.md/vectors chuẩn (bản MATH tương đương InstantGen). Whitepaper §7.3 cho nguyên tắc; số học chính xác + datum schema cần chốt trước khi build (giống `InstantGen/MATH.md` đã có cho InstantGen).

---

## 4. ConsumeMAGIC — định giá + tiêu MAGIC lấy dịch vụ

> Neo chuẩn: `ConsumeMAGIC/FEAT.md` (v2 engagement-state) + `ConsumeMAGIC/CONTRACT.md §B`.

### 4.1 Mục đích

ConsumeMAGIC là lớp **PRICING + ENGAGEMENT/ATTRIBUTION**: định giá có thẩm quyền cho một nghiệp vụ và ghi state per-app, ÉP cùng tx có vault input spend bằng `BurnBatch` với `Σ burns == required`. "Tiêu MAGIC" = GIẢM `current_amount` qua `BurnBatch` của VAULT validator (nơi DUY NHẤT giảm MAGIC). KHÔNG mint, KHÔNG burn LAMP; ADA bảo toàn (`ConsumeMAGIC/FEAT.md §1`).

### 4.2 Pricing qua PriceParam beacon (reference input)

```
required = price(op_type) × op_count
price    = base_price × demand_mult / Q      (đọc từ PriceParam beacon)
```
- PriceParam beacon = UTxO mang NFT one-shot (`price_nft.ak`), datum `{epoch, base_price/op_prices, demand_mult}`. `demand_mult` do **FlowRate** cập nhật (§7).
- Giá đọc **từ beacon xác thực NFT**, KHÔNG tin amount client (`C-CM-2`).
- `demand_mult` clamp `[m_min, m_max]`; `base_price` phải hợp lệ (`pricing.valid_param`).

### 4.3 Luồng người dùng

**4.3.1 Happy path — 1 Engage + 1 vault, 1 nghiệp vụ (co-spend 2-validator):**
1. Holder gọi `buildConsumeTx(op_type, op_count)`.
2. Tx-builder đọc PriceParam beacon (ref-input) → tính `required` offchain.
3. Build tx (KHÔNG mint): spend Engage UTxO (redeemer `Consume`), spend vault UTxO (`BurnBatch` với `Σ burns == required`), output Engage UTxO (`consumed_count += op_count`, value bảo toàn), output vault UTxO (`magic_batches −= burns`), validity-range ≤ 1 epoch.
4. Submit → validator `consume.ak` (C-CM-1..5) + vault `BurnBatch`.

**Điều kiện kết thúc:** `consumed_count` tăng đúng `op_count`; `magic_batches` giảm đúng `required`; value Engage UTxO bảo toàn tuyệt đối; KHÔNG mint.

**4.3.2 N Engage input (batch):** mỗi Engage input có redeemer riêng (cùng `price_ref`). Validator kiểm **AGGREGATE idempotent**:
- `total_required = Σ price(op_type_i)×op_count_i` qua MỌI Engage input.
- `total_burned = Σ burns` qua MỌI `vault_ref` PHÂN BIỆT (mỗi vault đếm 1 lần).
- `total_burned == total_required` (`==`, KHÔNG `≥` — over-burn = giảm MAGIC vô cớ → CẤM).
- `#out@engage == #in@engage`; `Σ engageNFT(out) == Σ engageNFT(in)`; `Σ consumed_count(out) == Σ(in) + Σ op_count`.
- **Chống pay-once-consume-N:** N Engage cùng trỏ 1 vault-burn → `total_required (N×) != total_burned (1×)` → REJECT.

**4.3.3 Cập nhật PriceParam (Committee M-of-N):** spend beacon UTxO, re-create với `epoch` tăng đơn điệu (chống rollback về giá cũ), `demand_mult` mới, bảng `op_prices` có thể đổi (governance).

### 4.4 did_commit PROVIDER-AGNOSTIC (contract normative)

Attribution burn-ID phát `consumer_did / provider_did / service_id / resource_type`. `did_commit` được ràng **qua beacon resolver + allow-list DAO**, **KHÔNG hardcode PhoenixKey** — hệ có nhiều nhà cung cấp DID; việc resolve DID↔signer là của nhà cung cấp DID (PhoenixKey), **ngoài scope MAGIC**.

### 4.5 Bất biến riêng ConsumeMAGIC (`ConsumeMAGIC/FEAT.md §4`)

| ID | Phát biểu |
|---|---|
| C-CM-1 | Value preservation @engage: Engage UTxO chỉ giữ ADA + thread NFT (KHÔNG MAGIC/LAMP); `Σ value(out) == Σ value(in)` tuyệt đối; KHÔNG `tx.mint` |
| C-CM-2 | `total_burned == total_required` (AGGREGATE qua mọi Engage input/vault_ref phân biệt; `==`); giá từ beacon xác thực NFT; vault input ở `vault_script_hash` + redeemer constr == `burn_batch_constr` |
| C-CM-3 | Double-satisfaction guard: `#out@engage == #in@engage`; `Σ engageNFT` bảo toàn; `Σ consumed_count(out) == Σ(in) + Σ op_count` |
| C-CM-4 | Mỗi output@engage đúng 1 thread NFT; `owner` bảo toàn; `last_epoch = current_epoch`; `did_commit` IMMUTABLE |
| C-CM-5 | Stale price: `0 ≤ current_epoch − PriceParam.epoch ≤ max_price_stale`; `current_epoch` tính từ UPPER bound + cửa sổ validity ≤ 1 epoch |
| INV-CASHBACK-BOUND | hoàn/DID ≤ phí-thật-đã-đốt (contract normative; Whitepaper §7.2) |

### 4.6 Out-of-scope

Định giá đối tượng nghiệp vụ cụ thể của app (việc app component); token-hoá MAGIC; burn LAMP; nghiệp vụ ngoài `op_type` khai báo; quản lý membership committee.

---

## 5. Consolidate — gộp holdings/batches phân mảnh

> Neo chuẩn: `Consolidate/FEAT.md` (§6.9, T23). Cơ chế thuần tái-cơ-cấu kế toán, KHÔNG di chuyển LAMP thực, KHÔNG tạo/giảm MAGIC.

### 5.1 Mục đích

Vault giữ LAMP dưới dạng `loyalty_holdings[]` (mỗi entry `{amount, acquired_epoch, is_locked}`). Nhận LAMP mới → thêm entry (`age=0`). Sau nhiều giao dịch danh sách phân mảnh → tốn ExUnit, và có nguy cơ chạm `MAX_LOYALTY_HOLDINGS = 64` (khoá không thêm được holding). Consolidate gộp các entry gần nhau (sort-partition-merge, cùng `is_locked`, `|epoch_diff| ≤ 1`) → giảm chiều dài, bảo toàn tổng số dư + cấu trúc khoá.

### 5.2 Luồng (happy path)

`canConsolidate(holdings)` → `consolidateHoldings(holdings)` → `validateConsolidate` → build tx spend vault (redeemer `Consolidate`), output vault datum **giống hệt cũ trừ `loyalty_holdings`**, gắn owner signature. Merge hội tụ đa-round (while-changed, T23).

### 5.3 Bất biến riêng Consolidate (`Consolidate/FEAT.md §4`)

| ID | Phát biểu |
|---|---|
| C-PC-V1 | `datum.owner ∈ tx.extra_signatories` (luôn cần owner ký) |
| C-DOUBLE-SAT | đúng 1 input + 1 output theo script hash |
| C-FIELD-LOCK | mọi field output == input ngoại trừ `loyalty_holdings` (chặn đổi profile/streak/magic_batches) |
| C-CONSOLIDATE-1 | chỉ merge holdings cùng `is_locked` |
| C-CONSOLIDATE-2 | `merged.acquired_epoch = min(A, B)` |
| C-CONSOLIDATE-3 | `merged.amount = A.amount + B.amount` |
| C-CONSOLIDATE-4 | `|output| < |input|` (phải thực sự giảm) |
| C-CONSOLIDATE-5 | `Σ output.amount == Σ input.amount` |
| C-CONSOLIDATE-6 | `Σ locked(output) == Σ locked(input)` |
| C-VAULT-8 | `lamp_locked ≤ lamp_balance` |
| C-VAULT-10 | `Σ output.amount == lamp_balance` |

### 5.4 Out-of-scope

Thay đổi `lamp_balance`/`lamp_locked`; merge khi `|epoch_diff| > 1`; auto-consolidate (luôn cần owner ký); tương tác `magic_batches` hay bất kỳ Gen mechanism nào.

---

## 6. Paymaster — delegate đốt MAGIC thay owner (fee abstraction)

> Neo chuẩn: `Paymaster/FEAT.md` (App Sponsor, MAGIC-as-gas).

### 6.1 Mục đích

**App** (nền tảng) đứng ra trả **ADA (phí mạng) + LAMP (phí giao thức) hộ user**, đổi lại user chỉ cần **tiêu MAGIC** (nhiên liệu họ đã có). App đồng trigger `BurnBatch` của VAULT validator để giảm `current_amount` của user — App là `personal_delegate` đã được user uỷ quyền. Phí App chi ra được **hạch toán** trong datum `SponsorMeter` (quota per-DID + global theo epoch). **KHÔNG chuyển MAGIC, KHÔNG mint** — Paymaster ĐỌC lượng tiêu từ redeemer `BurnBatch{burns}` của vault input co-spend (mirror `consume.ak`), KHÔNG đọc `tx.mint` (`Paymaster/FEAT.md §1`).

### 6.2 Luồng 3 vai trong 1 tx (`Paymaster/FEAT.md §3`)

App ký (cosign) + trả phí mạng; vault user spend bằng `BurnBatch` (App là delegate → user không cần ký); SponsorMeter UTxO cập kế toán. Tất cả atomic. Điều kiện: user đã đặt App làm delegate (qua `SetDelegate` của vault, ngoài scope Paymaster); App có Meter UTxO epoch hiện tại; budget chưa cạn.

### 6.3 Bất biến riêng Paymaster (`Paymaster/FEAT.md §4`)

| ID | Bất biến |
|---|---|
| PM-1 | App cosign (`app_authority ∈ extra_signatories`) |
| PM-1.5 | App = `personal_delegate` của MỌI vault trong `vault_refs` |
| PM-2 | `magic_consumed = Σ BurnBatch.burns` trên vault_refs PHÂN BIỆT (đọc redeemer thật, dedup); ép `> 0` |
| PM-3/4 | `0 ≤ lamp_this ≤ lamp_cap(magic_consumed)`; `0 ≤ ada_this ≤ ada_cap(magic_consumed)` |
| PM-3.5 | sàn DAO `policy.lamp_per_magic_q ≥ protocol.min_lamp_per_magic_q`; chống sponsor=0 |
| PM-5/6 | per-DID cap (`did_spent + lamp_this ≤ max_per_did_per_epoch`) + global cap |
| PM-7 | đúng 1 Meter in + 1 Meter out @paymaster, mỗi cái đúng 1 Meter NFT |
| PM-8 | epoch lock: `meter_out.epoch == current_epoch`, `meter_in.epoch ≤ current_epoch`; nếu `<` → reset base `([],0)` (chống replay budget cũ) |
| PM-10 | SponsorPolicy beacon NFT auth + freshness (`current_epoch − policy.epoch ≤ max_policy_stale`) + cùng `app_id` |
| PM-11 | value Meter bảo toàn tuyệt đối (`meter_out.value == meter_in.value`) |
| PM-12 | aggregate cross-meter: `lamp_this ≤ lamp_cap(magic_total)` với `magic_total = Σ burns MỌI vault input toàn tx` (chống double-satisfaction) |

### 6.4 Edge / Fallback

`magic_consumed = 0` → fail PM-2. Budget cạn → tx từ chối on-chain (PM-5/6), user tự trả hoặc chờ epoch sau. Epoch rollover → reset base trước khi cộng op mới.

### 6.5 Out-of-scope (MVP)

Oracle giá LAMP/ADA (CIP-31; MVP App tự định tỷ giá); settlement value-check LAMP on-chain; AppEconomics reward payout (module riêng); DID per-user thật (MVP `did_key` = owner-key — sẽ nâng khi liên-kết-DID sẵn sàng).

---

## 7. FlowRate — keeper cập nhật demand_mult (dual-EMA)

> Neo chuẩn: mã nguồn `FlowRate/offchain/src/{math,types,keeper}.ts` + `FlowRate/tests/vectors.ts`. (Chưa có FEAT.md riêng — spec dưới đây suy từ code + contract normative.)

### 7.1 Mục đích

FlowRate là **keeper off-chain permissionless** (giống UMKeeper cũ về hình thức, KHÁC về bản chất): mỗi epoch nó đọc toàn bộ SponsorMeter UTxO, tổng hợp `Σ LAMP` và `Σ MAGIC` tiêu-thật, tính một **tín-hiệu-cầu làm mượt bằng dual-EMA**, rồi cập nhật beacon để ConsumeMAGIC dùng làm `demand_mult` khi định giá (§4.2). FlowRate **KHÔNG đụng MAGIC** (không gen, không burn) — chỉ là oracle-nội-bộ đo throughput.

### 7.2 Thuật toán (dual-EMA + adaptive cap + blend — `FlowRate/offchain/src/math.ts`)

Mỗi epoch, từ `EpochFlow{total_lamp_oildrop, total_magic_ng, epoch}` (aggregate mọi app):
```
raw_rate_q = total_lamp_oildrop × Q / total_magic_ng          (Q-format)
ema_fast'  = (α_fast × raw + (Q−α_fast) × ema_fast) / Q        α_fast = Q/3  (≈0.333)
ema_slow'  = (α_slow × raw + (Q−α_slow) × ema_slow) / Q        α_slow = Q/12 (≈0.083)
div_q      = |ema_fast' − ema_slow'| × Q / ema_slow'
cap_q      = clamp( BASE_CAP × Q / (Q + 3×div_q) , MIN_CAP , BASE_CAP )   (25% → 5%)
w_fast     = (div ≥ 10% ? 0 : (10% − div) × 70% / 10%)         (tin fast khi calm)
rate_blend = (w_fast × ema_fast' + (Q−w_fast) × ema_slow') / Q
rate_out   = clamp( rate_blend , prev×(Q−cap_q)/Q , prev×(Q+cap_q)/Q )   (giới hạn tốc độ đổi)
output     = clamp( rate_out , HARD_FLOOR (0.01) , HARD_CEIL (10) )
```
Hằng số: `BASE_CAP_Q = 250_000_000` (25%), `MIN_CAP_Q = 50_000_000` (5%), `HARD_FLOOR_Q = 10_000_000`, `HARD_CEIL_Q = 10_000_000_000`, `MIN_MAGIC_EPOCH = 1_000_000_000_000` (1000 MAGIC).

### 7.3 Bảo vệ (guards)

| Guard | Xử lý |
|---|---|
| Hoạt động thấp | `total_magic_ng < MIN_MAGIC_EPOCH` hoặc `total_lamp = 0` → giữ nguyên EMA, chỉ advance `last_epoch` |
| Epoch không tiến | `epoch ≤ last_epoch` → no-op |
| Overflow/thao-túng | `raw > HARD_CEIL` → giữ EMA, output bound theo cap đã lưu (không cho spike vô lý) |
| Rate-of-change cap | mọi thay đổi bị kẹp trong `±cap_q` so với `prev` (adaptive theo divergence) |
| Hard floor/ceil | output luôn ∈ `[0.01, 10]` LAMP/MAGIC |

### 7.4 Bootstrap

`bootstrapFlowRate(initial_rate_q, epoch)`: DAO đặt `lamp_per_magic_q` khởi tạo; `ema_fast = ema_slow = initial`; `cap_q = 25%` (full cap lúc bootstrap).

> [NEEDS-EVIDENCE] Contract normative gọi output của FlowRate là **`demand_mult`** (dùng trong PriceParam beacon `price = base_price × demand_mult / Q`), nhưng code hiện xuất field **`lamp_per_magic_q`** (tỷ giá LAMP/MAGIC). Ánh xạ chính xác `lamp_per_magic_q → demand_mult` trong PriceParam beacon chưa có file normative nối hai bên (FlowRate chưa có validator Aiken on-chain, `types.ts` ghi "matches Aiken FlowRateDatum **when deployed**"). Cần chốt trước khi build: FlowRate cập nhật trực tiếp `demand_mult`, hay ConsumeMAGIC/Committee đọc `lamp_per_magic_q` rồi suy `demand_mult`.

> **Ranh giới firewall F6:** FlowRate đo **cầu-dịch-vụ-thực nội bộ** (throughput MAGIC/LAMP tiêu-thật qua SponsorMeter), KHÔNG đọc giá thị trường LAMP/ADA. Nó chỉ **tính giá-trị/định-giá**, KHÔNG cầm-lái cổng Gen (cổng Gen đọc `br` nội bộ — §2, §3). Đây là oracle-nội-sinh, không phải price-oracle ngoài.

---

## 8. Ranh giới client GreenBack / GlobalState (Carpet-Tech §T2)

**GreenBack / GlobalState là hệ track CARP** (BASE/UNIT), KHÔNG thuộc module MAGIC. MAGIC-Gen là **CLIENT chỉ-đọc** các tham số sau qua `reference_input`:

| Tham số | Nguồn | Dùng ở |
|---|---|---|
| `br_q` (tỷ-lệ-bảo-chứng `B/S`, TWAP + đệm-trễ) | GlobalState | van-đỏ + cổng thặng-dư InstantGen (§2.3) |
| `br_safe_q`, `f_max_q`, `eta_q` (gov_params) | GlobalState | cổng thặng-dư (§2.3) |
| `S` (cung MAGIC lưu hành) | GlobalState | `cap_surplus` (§2.3) |
| `pp_sched` (dòng Schedule/epoch) | GlobalState | trần-kép InstantGen (§2.3) |
| peg CARP/MAGIC (depeg flag) | GlobalState | depeg-brake `cap=0` (§2.3) |

**MAGIC KHÔNG xây:** GreenBack, GlobalState, PSM, RedBack, VacuumBack, Backstop, bậc-thang-cứu-5-bậc, phân bổ `cap_surplus` pro-rata, TWAP `br` + đệm-trễ. Những cái đó là việc **GreenBack/CARP** (`InstantGen/MATH.md §5` cross-track; Whitepaper §7.3, §8). MAGIC chỉ đọc phần còn-khả-cấp và draw ≤ đó.

---

## 9. Firewall F1–F9 (bất biến hiến pháp — Whitepaper §10)

Vi phạm bất kỳ firewall nào = sập kiến trúc. Áp cho toàn bộ code MAGIC.

| Mã | Nội dung (rút gọn) |
|---|---|
| **F1** MAGIC một chiều | KHÔNG có dòng MAGIC → CARP/LAMP/tiền. Chỉ tiêu hoặc tan biến. |
| **F2** Ma sát CARP→MAGIC | CARP→MAGIC là cam-kết-tiêu gắn DID, một chiều, không hoàn; KHÔNG đổi 1:1 qua lại. |
| **F3** Không lợi-tức-thụ-động | Không token nào trả dòng-giá-trị theo số-dư. Nắm LAMP / đặt Schedule là **chủ động**, không yield. |
| **F4** MAGIC closed-loop | không-chuyển-nhượng + decay + không-chuộc-tiền + tiêu-trong-hệ. |
| **F5** CARP fiat-neutral | (thuộc CARP; MAGIC-Gen tuân thủ khi đọc backing) rổ là công-cụ-bình-ổn, không cam-kết-chuộc; cấm thuần-LAMP vào core. |
| **F6** Không yếu-tố-bên-ngoài | Cơ chế lõi (cổng Schedule, ngưỡng solvency, van-đỏ) chỉ căn số-dư-nội-bộ; **KHÔNG oracle-giá điều khiển cổng/ngưỡng**. Giá chỉ để ĐỊNH GIÁ tài-sản, KHÔNG cầm-lái cơ chế. |
| **F7** Bộ-đệm vùng-xám | Nơi chặn LAMP/CARP, user chỉ chạm fiat + MAGIC; token ở app vùng-sáng; bán-đứt-không-hoàn. |
| **F8** Công-dân-hạng-nhất = tiêu-MAGIC (`INV-MAGIC-CITIZEN`) | Mọi hàm reward/VP/ưu-đãi PHẢI chứa biến **MAGIC-tiêu-thực** (trực tiếp hoặc qua-CARP-đã-tiêu); CẤM keyed thuần vào số-dư-nắm-giữ LAMP/CARP. |
| **F9** Không đỡ-peg bằng LAMP + điều-phối-2-trục | (thuộc CARP) TUYỆT ĐỐI không đỡ-peg bằng LAMP; điều-phối đọc PEG (`d`) và SOLVENCY (`br`) tách biệt. |

### 9.1 INV-MAGIC-CITIZEN — diễn giải cho code MAGIC

Tiên đề tối cao (Whitepaper §1): **công dân hạng nhất = người TIÊU MAGIC.** Hệ quả bắt buộc trong code:
- InstantGen: điều-kiện-(b) **tiêu-thật trong epoch** là bắt buộc — không tiêu thì không phát suất (§2.2). Biến quyết định là lượng-MAGIC-tiêu, KHÔNG phải lượng-LAMP-giữ.
- Reward keyed **MAGIC-tiêu-thực có burn-ID** (`throughput = Σ MAGIC_burned/epoch`), hàm-lõm-của-phí-thực-đốt, cap-per-DID, trần `Σ reward ≤ Σ MAGIC_burned` (`INV-CASHBACK-BOUND`).
- Voting Power = bão-hoà-theo-ngưỡng-tiêu-MAGIC, **KHÔNG nhân-LAMP**, đọc tiêu **cross-DID** (chống tự-burn-vòng). (Whitepaper §7.)
- Nắm LAMP/CARP đơn thuần KHÔNG sinh thưởng thụ động.

---

## 10. Cảnh báo pháp-lý + truyền-thông (Whitepaper §11, §13bis)

Áp cho mọi mô tả sản phẩm / marketing dùng các cơ chế trên:

- **Không quảng bá yield / thu-nhập-thụ-động.** InstantGen/ScheduleGen KHÔNG phải lãi-suất; thưởng chỉ phát khi tiêu-thật, trong thặng dư (§2.7). Narrative "giữ LAMP ăn lãi" bị cấm.
- **MAGIC KHÔNG phải stablecoin, KHÔNG neo-USD.** Nó hứa giao **một lượng dịch vụ** (1 GB·ngày/MAGIC), không hứa 1 USD.
- **MAGIC sẽ tan biến** nếu không tiêu trong hạn (như gói cước có hạn dùng). Truyền thông rõ "gói có hạn dùng" ngay khi bán.
- **Hoàn fiat TRƯỚC khi bắt đầu tiêu**; đã tiêu (đã đốt thành dịch vụ) thì không hoàn. App bán-đứt-không-hứa-hoàn-MAGIC-thành-fiat (kẻo thành custody/e-money).
- **Phân-vùng:** vùng-xám (chặn LAMP/CARP) → user chỉ chạm fiat + MAGIC qua app vùng-sáng (F7). "Mở" trong bảng phân-vùng KHÔNG có nghĩa tự-do-dùng mọi token ở mọi nước.
- Không token nào trong hệ là **cam-kết-sinh-lời**.

---

## 11. Datum vault dùng chung (tham chiếu cấu trúc)

Mọi cơ chế thao tác trên cùng `VaultDatum` (structure từ `InstantGen`/`ScheduleGen`/`Consolidate`). Field chính:
- `owner` (pkh) — và **DID one-shot NFT** cho tư-cách gen (R3, §2.5).
- `lamp_balance`, `lamp_locked` (`lamp_locked ≤ lamp_balance`, C-VAULT-8).
- `loyalty_holdings[]` `{amount, acquired_epoch, is_locked}` — `|·| ≤ 64` (MAX_LOYALTY_HOLDINGS); `Σ amount == lamp_balance` (C-VAULT-10); nguồn TWAB `L_i` (§2.3).
- `magic_batches[]` `{source, created_epoch, current_amount, …}` — `|·| ≤ 32` (MAX_BATCHES_PER_VAULT); **`current_amount` = MAGIC (nanogic)**; giảm CHỈ qua `BurnBatch`.
- `gen_schedules[]` — `|·| < 20` (MAX_GEN_SCHEDULES).
- `personal_delegate` — App uỷ quyền cho Paymaster (PM-1.5).

**Hard limits giữ đồng bộ `constants.ts` ↔ `constants.ak`:** `MAX_BATCHES_PER_VAULT=32`, `MAX_LOYALTY_HOLDINGS=64`, `MAX_GEN_SCHEDULES=20`, `MAX_FIRES_PER_TX_CATCHUP=8` (`CLAUDE.md §hard-limits`). **BỎ:** `MAX_VACUUM_ORDERS`, `SHARD_COUNT`, `SHARD_CAP` (thuộc cơ chế đã loại — §12).

> [NEEDS-EVIDENCE] Datum vault hiện tại (`InstantGen/onchain/lib/types.ak`) còn chứa các field của cơ chế đã bỏ (`profile`, `profile_at_creation`, `halved`, `pending_profile`, `streak_state`, `auto_burn_target`, shard-fields). Khi refactor sang mô hình mới, các field này phải bị loại/di-trú — cần một MIGRATION note riêng đối chiếu type cũ↔mới trước khi build (ngoài phạm vi feature-spec này).

---

## 12. BỎ HẲN — tuyệt đối không đưa vào code mới

Các cơ chế sau đã bị loại khỏi mô hình MAGIC (contract normative 16/7). Nếu module-spec cũ còn nhắc → **bỏ, không chép**:

- **UM / UMKeeper / Network-Demand-Multiplier** (C-UM-6, stale check, UM_FALLBACK) — InstantGen không còn dùng UM.
- **Profile Ember/Flame/Lantern + PM** (profile multiplier), `pending_profile`, ProfileChange/cooldown.
- **LF** (loyalty factor theo tuổi-nắm-giữ) — tuổi chỉ còn gate tư-cách, KHÔNG nhân độ lớn thưởng.
- **VacuumGen / vacuum_orders / VacuumBack-on-MAGIC-side** — 2-phase commit-then-fire đã loại.
- **Halving / ApplyHalving / `halved` / decay-hình-học nhiều epoch** — decay giờ = RESET mỗi epoch (§2.4).
- **InstantGen mua-trả-LAMP cũ** (`M = L_paid × R × UM × PM / Q³`, LAMP chuyển vào Treasury) — thay bằng nắm-LAMP-ở-yên-ví (§2).
- **ScheduleGen rate-lock (`rate_locked_q`/T8) + 16-shard system** — thay bằng cổng `κ×sức-tải-quỹ-cứu` + trần `pp` (§3).
- **SnapshotGen như cơ chế riêng** — đã gộp vào InstantGen.

---

## 13. Nguồn tham chiếu

- Whitepaper (neo tối thượng): `SPEC/Whitepaper-MagicLamp-Tokenomic-Vi.md` (§4 MAGIC, §7 Gen, §10 Firewall, §11 pháp-lý, §15 thuật-ngữ).
- InstantGen số học normative: `InstantGen/MATH.md` (§1–§9, TV-GEN-*).
- Module-spec cấu trúc: `InstantGen/FEAT.md`, `ScheduleGen/FEAT.md`, `ConsumeMAGIC/FEAT.md`, `Consolidate/FEAT.md`, `Paymaster/FEAT.md` (đã strip cơ chế §12).
- FlowRate: `FlowRate/offchain/src/{math,types,keeper}.ts`, `FlowRate/tests/vectors.ts`.
- Ràng buộc kỹ thuật: `CLAUDE.md` (bit-identical P8, hard limits, C-OVERFLOW).
