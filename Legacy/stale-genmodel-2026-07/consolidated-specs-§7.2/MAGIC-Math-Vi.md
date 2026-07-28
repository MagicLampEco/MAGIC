# MAGIC — Đặc-tả Toán-học HỢP NHẤT (triple-token, vai CREDIT)

> **Neo chuẩn tối thượng:** `SPEC/Whitepaper-MagicLamp-Tokenomic-Vi.md §7` (Gen MAGIC từ LAMP), §4 (bản chất MAGIC), §10 (Firewall F1–F9). File này là đặc-tả-toán HỢP NHẤT cho TOÀN BỘ MAGIC; khi mâu thuẫn với module spec cũ → file này (theo CONTRACT normative 16/7) THẮNG.
> **Ngày:** 2026-07-17. **Trạng thái:** normative cho tầng toán; on-chain chưa compile CI; chưa deploy testnet.

---

## 0. Phạm vi, mô hình, nguồn

**MAGIC = vai CREDIT** của một instance Carpet (LAMP=BASE, CARP=UNIT). Là **quyền-tiêu-dịch-vụ trả-trước** (prepaid service credit), neo par `P* = 1` theo **sức-mua-dịch-vụ nội sinh** — KHÔNG neo fiat (Whitepaper §4, dòng 92, 96–101). Đơn-vị-neo chuẩn: **1 nanogic = 1 byte·ngày** ⟺ `1 MAGIC = 1 GB·ngày` (Whitepaper §4, dòng 96).

**MAGIC KHÔNG có policy-id, KHÔNG phải token, KHÔNG chuyển nhượng.** MAGIC = **entitlement trong datum vault** (`MagicBatch.current_amount`, đơn vị nanogic). Tiêu MAGIC = **ĐỐT** (giảm `current_amount` qua handler `BurnBatch` của vault) — đây là **nơi DUY NHẤT** MAGIC giảm; KHÔNG `tx.mint` (Whitepaper §4 dòng 106–108; ConsumeMAGIC/MATH.md dòng 2–6, 19). Ba thuộc tính bất biến: không-chuyển-nhượng, tan-biến (decay), không-chuộc-ra-tiền (Whitepaper §4 dòng 105–108 = Firewall F1/F4).

**Sáu cơ chế trong phạm vi file này:**

| § | Cơ chế | Vai trò |
|---|---|---|
| 2 | **InstantGen** (gộp SnapshotGen cũ) | Nắm LAMP mở tư-cách → Gen quyền-tiêu-ngay trong thặng-dư |
| 3 | **ScheduleGen** | Khoá tư-cách LAMP → dòng `pp` MAGIC/epoch × `N` epoch |
| 4 | **ConsumeMAGIC** | Tiêu (đốt) MAGIC theo giá `base_price × demand_mult` |
| 5 | **FlowRate** | Keeper cập nhật tín-hiệu-giá động (dual-EMA) cho §4 + §7 |
| 6 | **Consolidate** | Gộp `MagicBatch`/holding phân mảnh (sort-partition-merge) |
| 7 | **Paymaster** | Delegate đốt MAGIC thay owner (fee abstraction) |

**Nguồn (đọc trực tiếp):** `InstantGen/MATH.md` (mới 16/7), `ScheduleGen/MATH.md` (cũ — chỉ giữ khung, BỎ rate-lock/16-shard), `ConsumeMAGIC/MATH.md`, `Consolidate/MATH.md`, `Paymaster/MATH.md`, `FlowRate/offchain/src/math.ts` + `FlowRate/tests/vectors.ts`, `SPEC/Whitepaper-MagicLamp-Tokenomic-Vi.md`.

**BỎ HẲN (không xuất hiện dưới đây):** UM/UMKeeper/hệ-số-cầu-mạng; profile Ember/Flame/Lantern + PM; LF (loyalty factor theo tuổi-nắm-giữ); VacuumGen/vacuum_orders; halving/ApplyHalving; mô hình InstantGen-mua-trả-LAMP cũ (`M = L_paid×R×UM×PM/Q³`); rate-lock (T8)/`rate_locked_q`/`S(L)` và hệ 16-shard của ScheduleGen cũ.

---

## 1. Đơn vị, Q-format, số học

### 1.1 Đơn vị

| Ký hiệu | Nghĩa | Quy đổi |
|---|---|---|
| `Q` | Thang fixed-point | `1_000_000_000 = 10^9` |
| oildrop | Sub-unit LAMP | `1 LAMP = 10^6 oildrop` |
| nanogic | Sub-unit MAGIC | `1 MAGIC = 10^9 nanogic` |
| `e` | Epoch Cardano (chu kỳ kế toán ≈ 5 ngày) | Whitepaper §7.1 dòng 195 |

### 1.2 Q-format — sequential-floor (C-OVERFLOW, P8, L4)

- **BigInt mọi nơi** cho oildrop/nanogic/Q-format. CẤM `Number` (C-OVERFLOW). TypeScript `bigint`, Aiken `Int` (arbitrary precision).
- **Bit-identical Aiken ↔ TypeScript (P8):** `offchain/src/math.ts` và `onchain/lib/*.ak` cho output **giống hệt** với input giống hệt. Không float, không bước trung gian khác nhau.
- **Nhân Q-format = floor-chia tuần-tự:** biểu thức nhiều tầng `× / Q` áp dụng thành **các bước `⌊ · × k / Q ⌋` RIÊNG**, KHÔNG gộp thành một nhân-rồi-chia. Mỗi bước floor có lỗi ≤ 1 đơn-vị-cuối.
- **Đại lượng tuyến-tính 1 tầng** (`⌊ x × r / Q ⌋`) = **single-step floor**, lỗi ≤ 1, KHÔNG cần sequential (Paymaster/MATH.md dòng 34).

### 1.3 Bound lỗi rounding (L4)

Chuỗi floor luôn làm tròn **xuống** → mọi kết quả `≤` giá-trị-thực (bảo thủ, thuận protocol, không bao giờ bơm dư). Lỗi tích luỹ = tổng số bước floor (mỗi bước ≤ 1 đơn-vị-cuối). Ví dụ `M_grant` của InstantGen: `M(L_i)` (7 hạng, sum-then-floor ≤ 1) + `cap_surplus` (2 floor ≤ 2) → tổng ≤ vài nanogic (InstantGen/MATH.md §8).

---

## 2. InstantGen — nắm LAMP mở tư-cách, Gen quyền-tiêu-ngay

> Neo: Whitepaper §7.2; chi tiết chuẩn `InstantGen/MATH.md` (16/7). Mô hình **nắm-LAMP-mở-tư-cách** — LAMP **ở-yên-ví**, KHÔNG chuyển đi. Gộp SnapshotGen + InstantGen cũ.

### 2.1 Ký hiệu bổ sung

| Ký hiệu | Nghĩa | Đơn vị |
|---|---|---|
| `W` | Cửa-sổ cộng-dồn tư-cách | `7` epoch (`i = 0..6`) |
| `L_i` | LAMP đủ-tư-cách **TWAB** ở epoch `e−i` | oildrop |
| `R_gen_q` | Suất-nền gen (governance) | Q-format |
| `br_q` | Tỷ-lệ-bảo-chứng `B/S` (đọc GlobalState) | Q-format |
| `br_safe_q` | Ngưỡng an-toàn `= 1.5×` | `1_500_000_000` |
| `f_max_q` | Trần hệ-số thặng-dư `= 0.10×` | `100_000_000` |
| `S` | Cung MAGIC lưu hành (đọc GlobalState) | nanogic |
| `pp_sched` | Dòng MAGIC/epoch của ScheduleGen (đọc GlobalState) | nanogic |

**GIẢ ĐỊNH governance (benchmark sau, KHÔNG hằng chốt):** `R_gen_q = Q = 10^9` → 1 LAMP nắm-giữ ≈ 0.001 MAGIC/epoch quyền-tiêu (1000 LAMP → ~1 MAGIC/epoch, TRƯỚC cổng). `W = 7` (InstantGen/MATH.md dòng 26).

### 2.2 `L_i` — TWAB, cắt-đuôi-khi-bán (bất biến R2)

`L_i` KHÔNG lấy mẫu-điểm. Lấy **số-dư-trung-bình-thời-gian** của LAMP đủ-tư-cách (unlocked) trong epoch `e−i`:

```
L_i = ⌊ ( Σ_j  balance_j × dur_j ) / len_epoch ⌋
```

- `balance_j` = LAMP đủ-tư-cách giữ liên-tục trong khoảng con `j`; `dur_j` = độ dài khoảng (ms); `Σ dur_j = len_epoch`.
- **Cắt-đuôi-khi-bán:** bán ra → `balance_j` tụt NGAY tại thời điểm bán, KHÔNG kéo đuôi 6 epoch. Chống flash-hold + đuôi-hậu-thoát (InstantGen/MATH.md §2).

### 2.3 `M(L)` — gen-nền một epoch

```
M(L) = ⌊ L × R_gen_q / Q ⌋           (oildrop → nanogic, single-step floor)
```

Tuyến tính theo `L` → chẻ ví KHÔNG nhân được lượng (floor còn lỗ). Lỗi ≤ 1 nanogic.

### 2.4 `M_raw` — trung-bình phẳng 7 epoch (`wᵢ = 1/7`)

```
M_raw = ⌊ ( Σ_{i=0..6}  M(L_i) ) / 7 ⌋
```

Trọng số phẳng `1/7` (chốt 15/7): kháng-game mạnh nhất (không spike 1 epoch để thắng), công bằng người nắm dài-hạn tạm-bán-mua-lại (Whitepaper §7.2 dòng 211–219). **Sum-then-floor** (một floor cuối) → lỗi ≤ 1 nanogic.

### 2.5 Cổng thặng-dư + trần-kép + van-đỏ → `M_grant`

Đọc `br_q, S, pp_sched` từ **GlobalState** qua `reference_input` (freshness §2.7).

```
Chế độ:  XANH nếu br_q > br_safe_q ;  ĐỎ nếu br_q ≤ br_safe_q

Van đỏ:  M_grant = 0                       khi ĐỎ  (khoá gen toàn mạng)
Depeg:   M_grant = 0                       khi CARP/MAGIC < P*  (đọc GlobalState)

XANH:
  cap_surplus = ⌊ ⌊ f_max_q × S / Q ⌋ × (br_q − br_safe_q) / br_safe_q ⌋
  double_cap  = ⌊ pp_sched / 2 ⌋           (InstantGen ≤ 0.5× Schedule)
  M_grant     = min( M_raw , cap_surplus , double_cap )
```

- `cap_surplus`: **hai bước floor tuần-tự** (Q-format §1.2) — `⌊f·S/Q⌋` rồi `× (br−br_safe)/br_safe`. Triệt-tiêu-trơn khi `br → br_safe⁺` (không vách cung). Chỉ Gen vào **thặng-dư** `B − br_safe·S`; sau Gen `br' ≥ br_safe` (Whitepaper §7.2 dòng 221).
- **Trần-kép** giữ InstantGen ≤ 0.5× dòng Schedule → hệ nhịp-nhàng.
- **Hai phanh** (Whitepaper §7.2 dòng 223–225): `cap = 0 khi CARP/MAGIC < P*`; **INV-CASHBACK-BOUND** — hoàn/thưởng mỗi DID ≤ phí-thật-đã-ĐỐT của DID đó (kiểm ở lớp tiêu/hoàn §4, KHÔNG ở gen).

### 2.6 Điều kiện cần (cả hai — Whitepaper §7.2 dòng 209)

1. Nắm LAMP đủ tư-cách (§2.2).
2. **Tiêu-thật MAGIC** trong epoch qua nền-tảng-đăng-ký (§4). Không tiêu → không phát suất.

### 2.7 Freshness GlobalState + bất biến R1, R3

**R1 — value-reconciliation (load-bearing).** MỌI lần đọc số-dư LAMP để tính `L_i` PHẢI ép tại chỗ đọc:

```
assets.quantity_of(vault_utxo, lamp_policy, lamp_name) == datum.lamp_balance
```

Cấm tin field datum bắc-cầu → chặn genesis-vault khai-khống `lamp_balance` (LAMP thật ~0) để farm gen/VP (InstantGen/MATH.md §2, dòng 42–46).

**Freshness (chống ref-input cũ đọc `br` giả cao):**
```
expect gs.epoch == e        (hoặc  e − gs.epoch ≤ MAX_GS_STALENESS  nếu keeper CARP trễ 1 epoch)
```

**R3 — kế-toán per-DID, KHÔNG per-vault.** Tư-cách gen gắn **DID one-shot NFT** (khớp PhoenixKey C4), KHÔNG phải `owner` pkh tự-khai. **Một suất gen / DID / epoch**: chặn double-gen cùng-LAMP qua nhiều vault/tx. `L_i` gộp theo DID, không theo UTxO rời (InstantGen/MATH.md §6).

### 2.8 Decay — RESET mỗi epoch (pin-mặt-trời, chốt 16/7)

`M_grant` là **TRẦN-SUẤT epoch này**, KHÔNG cộng-dồn thành bể-quyền tiêu sau.

```
Không tiêu hết trong epoch e  →  phần dư = 0 ở epoch e+1  (reset, use-it-or-lose-it)
```

Tư-cách epoch sau: cần thoả lại điều-kiện-tiêu-thật (§2.6). BỎ hẳn halving, decay-hình-học nhiều epoch, profile decay_window (InstantGen/MATH.md §7; Whitepaper §7.2 dòng 227).

### 2.9 Ranh cross-track (GreenBack lo — InstantGen KHÔNG thực thi)

- `cap_surplus` là **ngân-sách-mạng**; phân bổ **pro-rata theo M-đủ-tư-cách** (KHÔNG FCFS — chống bot giành sạch) do GreenBack điều-phối. InstantGen chỉ đọc phần còn khả-cấp + draw ≤ đó.
- `br_q`/peg đo **TWAP + đệm-trễ N epoch** chống thao-túng-nháy-van-đỏ — thuộc GlobalState (InstantGen/MATH.md §5).

### 2.10 Test vectors (NORMATIVE — giữ nguyên từ InstantGen/MATH.md §9; `R_gen_q = Q` giả định)

**TV-GEN-FLAT-01 — nắm ổn định, xanh, không chạm cap**
```
L_0..L_6 = 1_000_000_000 oildrop (1000 LAMP, TWAB đều 7 epoch);  R_gen_q = 1_000_000_000
M(L_i)  = ⌊1_000_000_000 × 1_000_000_000 / 10^9⌋ = 1_000_000_000  (mỗi i)
M_raw   = ⌊ 7 × 1_000_000_000 / 7 ⌋ = 1_000_000_000               (= 1 MAGIC)
GlobalState: br_q=2_000_000_000 (2.0×), S=100_000_000_000_000, pp_sched=10_000_000_000
cap_surplus = ⌊ ⌊100_000_000×S/Q⌋ × (2.0−1.5)/1.5 ⌋
            = ⌊ 10_000_000_000_000 × 500_000_000 / 1_500_000_000 ⌋ = 3_333_333_333_333
double_cap  = ⌊10_000_000_000 / 2⌋ = 5_000_000_000
M_grant = min(1_000_000_000, 3_333_333_333_333, 5_000_000_000) = 1_000_000_000  (= 1 MAGIC)
```

**TV-GEN-RED-02 — van đỏ**
```
br_q = 1_400_000_000 (1.4× ≤ br_safe 1.5×) → ĐỎ  →  M_grant = 0  (bất kể L_i, M_raw)
```

**TV-GEN-DOUBLECAP-03 — trần-kép cột vào Schedule**
```
M_raw = 8_000_000_000 (nắm nhiều LAMP), xanh, cap_surplus lớn
pp_sched = 6_000_000_000 → double_cap = 3_000_000_000
M_grant = min(8_000_000_000, cap_surplus, 3_000_000_000) = 3_000_000_000
```

**TV-GEN-SURPLUS-04 — cổng thặng-dư mỏng**
```
M_raw = 2_000_000_000, br_q=1_550_000_000 (1.55×, xanh mỏng), S=100_000_000_000_000
cap_surplus = ⌊ 10_000_000_000_000 × 50_000_000 / 1_500_000_000 ⌋ = 333_333_333_333
double_cap  = 5_000_000_000
M_grant = min(2_000_000_000, 333_333_333_333, 5_000_000_000) = 2_000_000_000
(cap cắn khi S nhỏ / br sát ngưỡng)
```

**TV-GEN-TAIL-05 — bán hết giữa epoch, TWAB cắt đuôi (R2)**
```
Epoch e−0: giữ 1000 LAMP nửa đầu, bán hết nửa sau (dur mỗi nửa = len/2)
L_0 = ⌊ (1_000_000_000 × len/2 + 0 × len/2) / len ⌋ = 500_000_000
→ M(L_0) = 500_000_000 (chỉ nửa). Đuôi hậu-bán = 0.
```

**TV-GEN-VALUE-RECON-06 — R1 chặn khai-khống**
```
datum.lamp_balance = 1_000_000_000_000  (khai khống 1 triệu LAMP)
assets.quantity_of(vault_utxo, lamp) = 2_000_000  (thật: 2 LAMP, min-UTxO)
→ R1: 2_000_000 ≠ 1_000_000_000_000 → VALIDATOR REJECT (không cho gen)
```

**TV-OVERFLOW-07 — BigInt bắt buộc (C-OVERFLOW)**
```
L_i = 36_000_000_000_000_000 oildrop (toàn cung LAMP), R_gen_q = Q
Trung gian 36×10^15 × 10^9 = 3.6×10^25 > Number.MAX_SAFE_INTEGER (~9×10^15) → phải BigInt
M(L_i) = 36×10^15 nanogic
```

---

## 3. ScheduleGen — khoá tư-cách LAMP → dòng `pp` MAGIC/epoch × `N`

> Neo: Whitepaper §7.3. Mô hình MỚI: khoá **tư-cách** LAMP (LAMP **ở-yên-ví**, trả lại nguyên vẹn khi hết hợp đồng) → hệ bảo đảm dòng `pp` MAGIC mỗi epoch trong `N` epoch. **BỎ** rate-lock (T8/`rate_locked_q`), `S(L)` bonus, hệ 16-shard, `MAX_FIRES_PER_TX_CATCHUP`-shard-cap của ScheduleGen cũ.

### 3.1 Ký hiệu

| Ký hiệu | Nghĩa | Đơn vị |
|---|---|---|
| `pp` | Dòng MAGIC trả mỗi epoch (trần cứng/epoch) | nanogic |
| `N` | Số epoch của hợp đồng | epoch |
| `commit_epoch` | Epoch ký hợp đồng | epoch |
| `buffer_ep` | Đệm an-toàn = `2` | epoch |
| `fired_count` | Số epoch đã trả | — |
| `O_rem` | Nghĩa-vụ còn lại của một hợp đồng | nanogic |
| `κ` (kappa) | Hệ số cổng = `0.6` cố định (Q: `600_000_000`) | Q-format |
| `rescue_capacity` | Sức-tải các quỹ cứu nội-bộ (đọc GlobalState) | nanogic MAGIC-tương-đương |

### 3.2 Nghĩa-vụ + dòng trả

```
Tổng nghĩa-vụ 1 hợp đồng:   O_total = pp × N
Nghĩa-vụ còn lại tại fire:   O_rem   = pp × (N − fired_count)
Trả mỗi epoch eligible:      payout  = pp    (TRẦN CỨNG — không rút-dồn nhiều epoch)
```

MAGIC của mỗi epoch được tạo vào quỹ **GreenBack** (chưa lưu-thông, chưa tính vào `S` cần-bảo-chứng); mỗi epoch release ≤ `pp`, người dùng **tiêu = đốt** qua `BurnBatch` (§4) (Whitepaper §7.3 dòng 238–241).

### 3.3 Fire eligibility (catch-up defer, KHÔNG forfeit)

```
start_fire_epoch = commit_epoch + buffer_ep          (buffer_ep = 2)
Order thứ i (0-indexed từ fired_count) eligible khi:
    e_i = start_fire_epoch + fired_count + i ≤ current_epoch
```

Nhiều epoch bị bỏ lỡ được trả bù (defer), KHÔNG mất (giữ khung catch-up của ScheduleGen cũ; BỎ shard/rate). `buffer_ep = 2`: hệ luôn giữ đủ tiền cho 2 epoch tới (Whitepaper §7.3 dòng 240).

### 3.4 Cổng giới hạn `κ` (Firewall F6 — KHÔNG dùng giá thị trường)

Hệ chỉ nhận thêm hợp đồng tới khi tổng nghĩa-vụ-còn-lại toàn hệ (gồm hợp đồng mới) không vượt `κ` lần sức-tải quỹ cứu:

```
Σ_{c ∈ hợp_đồng_sống} O_rem(c)  ≤  ⌊ κ × rescue_capacity / Q ⌋      (κ = 600_000_000)
```

- `rescue_capacity` = số dư quỹ cứu nội-bộ (RedBack + kho dự phòng nền-tảng + Kho bạc MagicLamp), đọc từ GlobalState. **TUYỆT ĐỐI KHÔNG dùng giá LAMP / dữ-liệu-giá thị trường** (F6). `κ = 0.6` **cố định, cấm đổi giữa vòng đời hợp đồng** (Whitepaper §7.3 dòng 243–250).
- Quỹ cứu nhỏ → số hợp đồng nhận nhỏ. Schedule co-giãn theo sức-khoẻ-thật, không phình.

**Bậc-thang-cứu 5 bậc** (khi GreenBack thiếu tiền trả) do **GreenBack** thực thi, KHÔNG thuộc MAGIC-Gen: (1) điều chỉnh tỷ giá hợp đồng; (2) bán LAMP thặng-dư; (3) RedBack; (4) kho dự phòng nền-tảng; (5) Kho bạc (Whitepaper §7.3 dòng 252–257).

### 3.5 Không-commit-cancel

Một khi ký, hợp đồng **fire hoặc hết-hạn, KHÔNG hoàn mid-flight** (giữ tinh thần C-VAC-12/T10 cũ). LAMP khoá-tư-cách trả về owner khi hết `N` epoch.

### 3.6 Test vectors (NORMATIVE — tính tay, mô hình mới)

**TV-SCH-FLOW-01 — dòng đều pp × N**
```
pp = 10_000_000_000 (10 MAGIC), N = 12, commit_epoch = 50
O_total = 10_000_000_000 × 12 = 120_000_000_000  (= 120 MAGIC)
start_fire_epoch = 50 + 2 = 52
Tại current_epoch = 52, fired_count = 0:  e_0 = 52 ≤ 52 → payout = pp = 10_000_000_000
O_rem sau fire = 10_000_000_000 × (12 − 1) = 110_000_000_000
```

**TV-SCH-CATCHUP-02 — 3 epoch bỏ lỡ, defer**
```
start_fire_epoch = 52, fired_count = 0, current_epoch = 55
e_0=52≤55 ✓  e_1=53≤55 ✓  e_2=54≤55 ✓  e_3=55≤55 ✓  e_4=56>55 → dừng
fires = 4 → tổng trả = 4 × 10_000_000_000 = 40_000_000_000 (= 40 MAGIC); fired_count → 4
```

**TV-SCH-GATE-03 — cổng κ nhận/từ chối**
```
κ = 600_000_000 (0.6);  rescue_capacity = 1_000_000_000_000 (1000 MAGIC-tương-đương)
Ngưỡng = ⌊ 600_000_000 × 1_000_000_000_000 / 10^9 ⌋ = 600_000_000_000  (= 600 MAGIC)
Nghĩa-vụ hiện có Σ = 500_000_000_000 (500 MAGIC)
Hợp đồng mới O_total = 120_000_000_000 (TV-SCH-FLOW-01):
    500_000_000_000 + 120_000_000_000 = 620_000_000_000 > 600_000_000_000 → REJECT
Hợp đồng mới nhỏ hơn O_total = 80_000_000_000 (pp=10 MAGIC, N=8):
    500_000_000_000 + 80_000_000_000 = 580_000_000_000 ≤ 600_000_000_000 → ACCEPT
```

**TV-SCH-OVERFLOW-04 — BigInt**
```
κ × rescue_capacity = 600_000_000 × 1_000_000_000_000 = 6×10^20 > Number.MAX_SAFE_INTEGER → BigInt
```

> [NEEDS-EVIDENCE] Đơn-vị/định-giá chính-xác của `rescue_capacity` (quy quỹ cứu → nanogic MAGIC-tương-đương) do **GreenBack/GlobalState** định nghĩa; nguồn cung cấp chỉ có prose Whitepaper §7.3, chưa có công thức số. MAGIC-Gen đọc qua `reference_input`.

---

## 4. ConsumeMAGIC — tiêu (đốt) MAGIC theo giá `base_price × demand_mult`

> Neo: Whitepaper §4 dòng 121; `ConsumeMAGIC/MATH.md`. Model v2: MAGIC = số kế-toán (vault datum), tiêu = `Σ burns` qua handler `BurnBatch`. `consume.ak` ép `total_burned == total_required` (`==`, KHÔNG `≥`).

### 4.1 Ký hiệu

| Ký hiệu | Nghĩa | Đơn vị |
|---|---|---|
| `base_price[t]` | Giá danh nghĩa op-type `t` (governance) | nanogic |
| `demand_mult` | Hệ số co-giãn cung-cầu, `∈ [m_min, m_max]` | Q-format |
| `price(t)` | Giá đơn vị op-type `t` | nanogic |
| `required(t,n)` | Tổng cần đốt cho `n` ops loại `t` | nanogic |
| `total_burned` | `Σ burns` qua các vault_ref **phân biệt** | nanogic |

### 4.2 Giá đơn vị + required (single-step floor)

```
price(t)       = ⌊ base_price[t] × demand_mult / Q ⌋           (nanogic, floor BigInt)
required(t, n) = price(t) × n
total_required = Σ_{i ∈ engage_inputs}       required(op_type_i, op_count_i)
total_burned   = Σ_{v ∈ distinct vault_refs} Σ burns(v)
```

`price` đơn-điệu-không-giảm theo `demand_mult`. Chặn: `⌊base_price×m_min/Q⌋ ≤ price ≤ ⌊base_price×m_max/Q⌋` (ConsumeMAGIC/MATH.md §2.1).

### 4.3 Bất biến kế-toán

- **C-CM-2:** `total_burned == total_required` (`==`, KHÔNG `≥`). Over-burn = giảm MAGIC user vô cớ → CẤM. Under-burn = under-charge → REJECT. Aggregate qua MỌI Engage input + MỌI vault_ref **phân biệt** (mỗi vault đếm burns 1 lần) → chống pay-once-consume-N (ConsumeMAGIC/MATH.md §2.3).
- **Value preservation @engage (TUYỆT ĐỐI):** `Σ value(out@engage) == Σ value(in@engage)`. Engage UTxO chỉ giữ ADA + thread NFT (KHÔNG MAGIC/LAMP); MAGIC giảm xảy ra ở **VAULT** UTxO (BurnBatch), KHÔNG `tx.mint` (ConsumeMAGIC/MATH.md §2.6).
- **PriceParam datum:** `0 ≤ m_min ≤ m_max`; `m_min ≤ demand_mult ≤ m_max`; `∀ OpPrice p: p.base_price ≥ 0` (base_price âm → required âm → reject sớm tại `valid_param`) (ConsumeMAGIC/MATH.md §2.5).
- **Stale price:** `cur_epoch − pp.epoch ≤ max_stale` (nếu vượt → REJECT).

### 4.4 `did_commit` PROVIDER-AGNOSTIC + burn-ID

Ràng qua **beacon resolver + allow-list DAO**, KHÔNG hardcode PhoenixKey (hệ nhiều nhà-cung-cấp DID; resolve DID↔signer là việc PhoenixKey, NGOÀI scope MAGIC). Burn-ID phát `consumer_did / provider_did / service_id / resource_type`.

**INV-CASHBACK-BOUND:** hoàn/thưởng theo DID **≤ phí-thật-đã-đốt** của DID đó (Whitepaper §7.2 dòng 225; Firewall F8).

### 4.5 `demand_mult` — nguồn tín-hiệu

`demand_mult` là hệ-số Q-format do **keeper FlowRate** (§5, dual-EMA) cập nhật theo nhịp cung-cầu tiêu-dịch-vụ. Bản dual-EMA (§5) là **canonical** và **thay** bản SMA-N/FIR trong `ConsumeMAGIC/MATH.md §2.4` (CONTRACT normative: dual-EMA THẮNG). Pricing đọc `demand_mult` từ PriceParam beacon (`reference_input`), clamp `[m_min, m_max]` tại chỗ đọc.

> [NEEDS-EVIDENCE] Đường-dây chính xác FlowRate → `demand_mult`: module FlowRate as-built (§5) tính `lamp_per_magic_q` (tỷ-giá LAMP/MAGIC, tiêu-thụ bởi Paymaster §7), KHÔNG đặt tên `demand_mult`. Việc ConsumeMAGIC đọc trực-tiếp output FlowRate làm `demand_mult`, hay FlowRate phát cả hai tín-hiệu, chưa có mã nối. Toán dual-EMA §5 là chuẩn; tên biến + wiring cần xác minh.

### 4.6 Điều kiện biên

| Điều kiện | Xử lý |
|---|---|
| `target_capacity = 0` | dùng `den = 1` (defensive) |
| Lịch sử load rỗng | trả `M_NEUTRAL_Q = Q` (1.0×) |
| `op_type` không có bảng | `lookup_base = None` → validator fail |
| `op_count = 0` | ép `op_count ≥ 1` |
| Floor làm tròn xuống | `required` thấp hơn giá-thực ≤ 1 nanogic (user-favorable) |

### 4.7 Test vectors (NORMATIVE — ConsumeMAGIC/MATH.md §4)

```
TV-CM-PRICE-01  base_price[1]=10_000_000, demand_mult=Q  → price=⌊10^7×10^9/10^9⌋=10_000_000; required(1,1)=10_000_000
                base_price[2]=1_000_000,  demand_mult=Q  → price=1_000_000
TV-CM-PRICE-02  base_price[1]=10_000_000, demand_mult=2_000_000_000 (2.0×) → price=20_000_000  (trần)
TV-CM-PRICE-03  base_price[1]=10_000_000, demand_mult=500_000_000  (0.5×) → price=5_000_000   (sàn)
TV-CM-PRICE-04  price(1)=10_000_000, n=5 → required(1,5)=50_000_000
TV-CM-PRICE-05  engage_0(t=1,n=1)=10_000_000 + engage_1(t=1,n=1)=10_000_000 → total_required=20_000_000
                total_burned=10_000_000 → REJECT (under);  =20_000_000 → ACCEPT (==);  =25_000_000 → REJECT (over)
TV-CM-STALE     pp.epoch=1, cur_epoch=10, max_stale=5 → 9>5 → REJECT
```

---

## 5. FlowRate — keeper tín-hiệu-giá động (dual-EMA)

> Neo: `FlowRate/offchain/src/math.ts`, `FlowRate/tests/vectors.ts`. Keeper permissionless, mỗi epoch cập-nhật một tín-hiệu Q-format `lamp_per_magic_q` (tỷ-giá LAMP/MAGIC quan-sát từ dòng gen thực) bằng **dual-EMA (nhanh + chậm) + adaptive-cap + blend**. Kháng thao-túng-nháy. Tiêu-thụ bởi Paymaster (§7) và pricing ConsumeMAGIC (§4, xem [NEEDS-EVIDENCE] §4.5).

### 5.1 Hằng số (math.ts:5–12)

```
ALPHA_FAST_Q   = Q/3    ≈ 0.333        (EMA nhanh)
ALPHA_SLOW_Q   = Q/12   ≈ 0.083        (EMA chậm, cửa-sổ 12 epoch)
BASE_CAP_Q     = 250_000_000  (25% trần rate-of-change lúc thị-trường-êm)
MIN_CAP_Q      = 50_000_000   (5%  trần khi bị thao-túng mạnh)
DIV_BLEND_PIVOT= 100_000_000  (10% divergence = mốc chuyển blend)
BLEND_FAST_MAX = 700_000_000  (70% trọng-số tối-đa cho EMA nhanh)
HARD_FLOOR_Q   = 10_000_000       (0.01 LAMP/MAGIC sàn tuyệt-đối)
HARD_CEIL_Q    = 10_000_000_000   (10 LAMP/MAGIC trần tuyệt-đối)
MIN_MAGIC_EPOCH= 1_000_000_000_000 (1000 MAGIC ngưỡng hoạt-động tối-thiểu)
```

### 5.2 Thuật toán một epoch (math.ts:41–99)

```
Guard hoạt-động: nếu total_magic_ng < MIN_MAGIC_EPOCH ∨ total_lamp_oildrop = 0
                 → giữ nguyên state, chỉ advance last_epoch.
Guard epoch:     nếu flow.epoch ≤ last_epoch → giữ nguyên.

unclamped_raw = ⌊ total_lamp_oildrop × Q / total_magic_ng ⌋
Overflow guard:  nếu unclamped_raw > HARD_CEIL_Q  → dữ-liệu lỗi/thao-túng:
                 giữ EMA cũ; lamp_per_magic_q = clamp(prev, HARD_FLOOR, prev×(Q+cap)/Q); advance epoch.

raw = unclamped_raw
new_fast = ⌊ (ALPHA_FAST_Q × raw + (Q − ALPHA_FAST_Q) × ema_fast_old) / Q ⌋
new_slow = ⌊ (ALPHA_SLOW_Q × raw + (Q − ALPHA_SLOW_Q) × ema_slow_old) / Q ⌋

div_q = |new_fast − new_slow| × Q / new_slow        (0 nếu new_slow=0)
cap_q = clamp( ⌊ BASE_CAP_Q × Q / (Q + 3×div_q) ⌋ , MIN_CAP_Q , BASE_CAP_Q )   (25%/(1+3·div))
w_fast = (div_q ≥ DIV_BLEND_PIVOT) ? 0 : ⌊ (DIV_BLEND_PIVOT − div_q) × BLEND_FAST_MAX / DIV_BLEND_PIVOT ⌋
w_slow = Q − w_fast
rate_blended = ⌊ (w_fast × new_fast + w_slow × new_slow) / Q ⌋

prev = lamp_per_magic_q_old
max_rate = ⌊ prev × (Q + cap_q) / Q ⌋
min_rate = ⌊ prev × (Q − cap_q) / Q ⌋
rate_capped = clamp(rate_blended, min_rate, max_rate)

OUT: ema_fast = clamp(new_fast, HARD_FLOOR, HARD_CEIL)
     ema_slow = clamp(new_slow, HARD_FLOOR, HARD_CEIL)
     lamp_per_magic_q = clamp(rate_capped, HARD_FLOOR, HARD_CEIL)
     last_epoch = flow.epoch; div_q; cap_q
```

**Ý nghĩa:** EMA-nhanh bám thay-đổi-thật; EMA-chậm chống spike. `div` cao (nhanh lệch chậm nhiều = nghi thao-túng) → cap **siết** (25%→5%) + blend **dồn về chậm** (70%→0% nhanh). Thay-đổi-thật kéo dài → nhanh+chậm hội-tụ, `div→0`, cap nới, rate theo kịp.

### 5.3 Test vectors (NORMATIVE — FlowRate/tests/vectors.ts; INITIAL_STATE: EMAs=100M, rate=100M, cap=250M)

```
TV-FR-01 STABLE     lamp=100_000_000_000, magic=10^12 → raw=100M = rate cũ → rate=100M, div=0, cap=250M
TV-FR-02 GENUINE    raw=200M (0.2 LAMP/MAGIC) lặp 15 epoch → rate hội-tụ vào [150M, 200M] (cap 25%/epoch)
TV-FR-03 MANIP-1ep  raw=500M 1 epoch: fast≈233.3M, slow≈133.4M, div≈74.9% → cap≈7.7%, blend→slow
                    → rate ≈ 100M×1.077 = 107.7M  (thay đổi ≤ 10%, không theo spike)
TV-FR-04 MANIP-6ep  raw=500M × 6 epoch → slow EMA < 300M (target tấn-công 500M bị chặn)
TV-FR-05 ZERO       lamp=0, magic=0 → state giữ nguyên, chỉ advance epoch
TV-FR-06 BELOW-THR  magic=999_999_999_999 (< 10^12) → state giữ nguyên
TV-FR-07 FLOOR      lamp=1, magic=10^12 → raw=⌊1×Q/10^12⌋=0 → EMA phân-rã về HARD_FLOOR 10_000_000
TV-FR-08 OVERFLOW   lamp=10^16, magic=10^12 → raw=10^13 > HARD_CEIL 10^10 → clamp ≤ 10_000_000_000 (BigInt)
TV-FR-09 CAP        raw=Q (1.0 LAMP/MAGIC, 10× khởi-điểm), div cao → output ≤ ~130M (cap siết)
TV-FR-10 LAMPNET    perm 200 nanogic/KB, 1MB=1024KB → 204_800 nanogic; @rate 100M: lamp_cap = ⌊204_800×100M/Q⌋ = 20_480 oildrop
```

---

## 6. Consolidate — gộp holding phân mảnh (sort-partition-merge)

> Neo: `Consolidate/MATH.md`. Gộp các `MagicBatch`/holding phân mảnh của vault, **bảo toàn tổng**. Thuật-toán thuần kế-toán, không dùng cơ-chế đã BỎ.

### 6.1 Định nghĩa

`H = { (aᵢ, eᵢ, lᵢ) }`: `aᵢ` = số dư (oildrop, BigInt), `eᵢ` = `acquired_epoch`, `lᵢ` = `is_locked`.
Bất biến vault trước consolidate: `lamp_balance = Σ aᵢ` (C-VAULT-10); `lamp_locked = Σ_{lᵢ=T} aᵢ` (C-VAULT-9); `lamp_locked ≤ lamp_balance` (C-VAULT-8).

### 6.2 Thuật toán

```
1. Partition:  H_L = {h | is_locked}, H_U = {h | ¬is_locked}   (partition TRƯỚC sort → tránh tie không xác định, P8)
2. Sort mỗi nhóm theo eᵢ tăng dần.
3. mergeGroup(G): while ∃ cặp kề (i,i+1) có e_{i+1} − eᵢ ≤ 1:
        a' = aᵢ + a_{i+1};  e' = min(eᵢ, e_{i+1});  l' = lᵢ = l_{i+1}
   lặp đến ổn định.
4. H' = sort( mergeGroup(H_L) ∪ mergeGroup(H_U) ) theo (acquired_epoch asc, is_locked=True trước).
```

**Kết thúc:** mỗi pass `|G|` giảm ≥ 1 → ≤ ⌊n/2⌋ pass (T23). **Idempotent:** `mergeGroup(mergeGroup(G)) = mergeGroup(G)`.

**Bảo toàn:** `Σ aᵢ` không đổi (C-CONSOLIDATE-5); `Σ_locked` không đổi (partition tách hẳn L/U, C-CONSOLIDATE-6); `|H'| < |H|` nếu có ≥1 gộp (C-CONSOLIDATE-4).

> **Lưu ý reframe:** `Consolidate/MATH.md §4` biện-minh `e' = min` để "giữ LF cao". **LF đã BỎ.** `e' = min` vẫn giữ (bảo thủ user-favorable: không reset tuổi-holding dùng cho tư-cách TWAB/R2); ngưỡng gộp `epoch_diff ≤ 1` giữ nguyên.

### 6.3 Điều kiện biên + TV (NORMATIVE — Consolidate/MATH.md §5)

Biên: `|H|≤1` → không merge; `epoch_diff=0` → merge (`e'=e`); `epoch_diff=2` → KHÔNG merge; L và U cùng epoch → KHÔNG merge (khác nhóm).

```
TV-CONSOLIDATE-01  [ {1,5,L},{1,6,L},{1,7,L} ]  Σ=3, Σ_L=3
   Pass1: (5,6) diff=1 → {2,5,L}; còn [{2,5,L},{1,7,L}]. Pass2: (5,7) diff=2 → stable
   → [ {2,5,L},{1,7,L} ]  Σ=3 ✓  Σ_L=3 ✓  |H'|=2<3 ✓
TV-CONSOLIDATE-02  [ {1,5,L},{1,6,U},{1,6,L},{1,7,U} ]  Σ=4, Σ_L=2, Σ_U=2
   H_L=[{1,5,L},{1,6,L}]→{2,5,L};  H_U=[{1,6,U},{1,7,U}]→{2,6,U}
   → [ {2,5,L},{2,6,U} ]  Σ=4 ✓  Σ_L=2 ✓  (3 permutation input → cùng output, P8)
TV-CONSOLIDATE-03  holdings=[{1000,50,L},{500,51,L},{200,60,U}], lamp_balance=1700, lamp_locked=1500
   H_L: diff=1 → {1500,50,L};  H_U: {200,60,U}  → [{1500,50,L},{200,60,U}]  (1500+200=1700 ✓)
   Fire λ=200 (Schedule): {1500,50,L}→{1300,50,L}; lamp_locked'=1300 ✓
```

---

## 7. Paymaster — delegate đốt MAGIC thay owner (fee abstraction)

> Neo: `Paymaster/MATH.md`. App sponsor phí (LAMP/ADA) cho op của user, **trần** theo lượng MAGIC user đã đốt. KHÔNG chuyển MAGIC; MAGIC giảm chỉ qua `BurnBatch` vault.

### 7.1 Ký hiệu + công thức (single-step floor)

| Ký hiệu | Đơn vị | Nghĩa |
|---|---|---|
| `magic_consumed` | nanogic | `Σ BurnBatch.burns` trên vault **phân biệt** (dedup) |
| `lamp_per_magic_q` | Q-format | `lamp_oil / nanogic` (Q = 1 LAMP/MAGIC) — nguồn từ FlowRate §5 |
| `ada_per_magic_q` | Q-format | `lovelace / nanogic` |
| `lamp_this` / `ada_this` | oildrop / lovelace | LAMP/ADA App sponsor op này |

```
lamp_cap = ⌊ magic_consumed × lamp_per_magic_q / Q ⌋      (oildrop,  single-step floor, lỗi 0)
ada_cap  = ⌊ magic_consumed × ada_per_magic_q  / Q ⌋      (lovelace)
Ràng buộc: 0 ≤ lamp_this ≤ lamp_cap ;  0 ≤ ada_this ≤ ada_cap    (App được sponsor ÍT hơn cap)

magic_consumed = Σ_{vref ∈ dedup(vault_refs)} Σ_{b ∈ burns(vref)} b.amount   (đọc redeemer BurnBatch THẬT, không tin Sponsor)
```

### 7.2 Cross-meter (PM-12) + meter state

```
magic_total = Σ_{inp @vault_script, redeemer=BurnBatch} sum_burns
ép:  lamp_this ≤ lamp_cap(magic_total)  ∧  ada_this ≤ ada_cap(magic_total)     (1 burn không thoả 2 claim)

Reset theo epoch:  (base_map, base_global) = (meter_in.epoch < e) ? ([], 0) : (meter_in.did_lamp_map, meter_in.global_lamp_epoch)
meter_out.did_lamp_map      = add_did(base_map, did_key, lamp_this)   (key có → cộng-dồn giữ vị-trí; key mới → append CUỐI)
meter_out.global_lamp_epoch = base_global + lamp_this
```

`add_did`/`lookup_did` mirror BYTE-PERFECT offchain (`math.ts`) ↔ onchain (`util.ak`) để `meter_out` builder khớp validator (P8).

### 7.3 Điều kiện biên + TV (NORMATIVE — Paymaster/MATH.md §3–4)

Biên: `magic_consumed = 0` → fail (ép `>0`); `lamp_per_magic_q = 0` → `cap=0`, nếu `protocol_fee_active` → fail (sàn); `magic×rate < Q` → `cap=0` (floor); amount 10^15+ → BigInt, không overflow.

```
TV-PM-PRICE-01  lamp_cap(10_000_000, 500_000_000)   = 5_000_000 oildrop
TV-PM-PRICE-02  ada_cap (50_000_000, 2_000_000_000) = 100_000_000 lovelace
TV-PM-UNIT      lamp_cap(7_777_777, Q)              = 7_777_777
TV-PM-ZERO      lamp_cap(10_000_000, 0)             = 0
TV-PM-FLOOR     lamp_cap(3, 1)                       = 0
TV-PM-BIG       lamp_cap(10^15, 2×10^9)             = 2×10^15   (BigInt)
```

---

## 8. Bất biến hợp-nhất (bake — kiểm khi đổi bất kỳ toán nào)

| Mã | Nội dung | Nơi áp |
|---|---|---|
| **R1** value-reconciliation | Mọi đọc `lamp_balance` ép `assets.quantity_of(utxo)==datum.lamp_balance` tại chỗ đọc (chống genesis-vault khai-khống) | §2.7 |
| **R2** TWAB | `L_i` = trung-bình-thời-gian, cắt-đuôi-khi-bán (chống flash-hold + đuôi-hậu-thoát) | §2.2 |
| **R3** per-DID | DID one-shot NFT, 1 suất-gen/DID/epoch (owner pkh tự-khai KHÔNG đủ) | §2.7 |
| **P8** bit-identical | Aiken ↔ TypeScript output giống hệt; constructor index datum khớp thứ-tự field | toàn hệ |
| **C-OVERFLOW** | BigInt mọi oildrop/nanogic/Q-format; CẤM `Number` | toàn hệ |
| **Sequential-floor / L4** | Nhân Q nhiều tầng = floor tuần-tự; kết-quả ≤ thực (bảo thủ) | §1.2–1.3 |
| **INV-CASHBACK-BOUND** | Hoàn/thưởng/DID ≤ phí-thật-đã-đốt/DID | §2.5, §4.4 |
| **C-CM-2** | `total_burned == total_required` (`==`) | §4.3 |

**Firewall hiến-pháp (Whitepaper §10):** F1 MAGIC một-chiều (không → CARP/LAMP/tiền); F3 không lợi-tức-thụ-động (nắm LAMP/Schedule là **chủ-động**, không yield); F4 MAGIC closed-loop (không-chuyển-nhượng + decay + không-chuộc + tiêu-trong-hệ); F6 giá-để-tính-giá-trị KHÔNG cầm-lái-cơ-chế (cổng Schedule/ngưỡng solvency chỉ căn số-dư-nội-bộ); F8 INV-MAGIC-CITIZEN (thưởng/VP keyed **MAGIC-tiêu-thực**, KHÔNG số-dư LAMP/CARP nắm-giữ).

**Hard limits (giữ đồng-bộ `constants.ak` ↔ `constants.ts`):** `MAX_BATCHES_PER_VAULT=32`, `MAX_LOYALTY_HOLDINGS=64`. (BỎ: `MAX_VACUUM_ORDERS`, `MAX_GEN_SCHEDULES`/shard-cap của mô hình cũ — ScheduleGen mới dùng cổng κ động §3.4, không cap-shard tĩnh.)

---

## 9. Ranh giới GreenBack/GlobalState (Carpet-Tech §T2)

GreenBack/GlobalState **track CARP**. MAGIC-Gen là **CLIENT** đọc qua `reference_input`: `br_q`, `gov_params (br_safe_q, f_max_q, eta_q)`, `S`, `pp_sched`, `rescue_capacity`, CARP/MAGIC peg. MAGIC **KHÔNG** xây GreenBack/GlobalState/PSM. `cap_surplus` pro-rata + `br` TWAP + đệm-trễ + bậc-thang-cứu-5-bậc + định-giá `rescue_capacity` = việc **GreenBack**, ngoài scope file này.

---

## 10. Mục [NEEDS-EVIDENCE]

1. **§3.6 / §3.4 `rescue_capacity`** — đơn-vị + công-thức quy quỹ-cứu → nanogic MAGIC-tương-đương chưa có mã/số, chỉ prose Whitepaper §7.3. Do GreenBack định nghĩa.
2. **§4.5 FlowRate → `demand_mult`** — module FlowRate as-built tính `lamp_per_magic_q` (cho Paymaster), KHÔNG đặt tên `demand_mult`; wiring FlowRate→pricing ConsumeMAGIC chưa có mã nối. CONTRACT normative chốt dual-EMA là canonical (thay SMA-N cũ); tên biến + đường-dây cần xác minh khi ráp code.
