# AppEconomics v2.1 — Đặc tả module (KHÔNG normative)

> ⚠ **Tệp này KHÔNG phải nguồn chân lý.** Nguồn duy nhất:
> [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](../SPEC/MagicLamp-Tripletoken-Feat-(Vi).md).
> Ràng buộc chung: [`BOUNDARIES.md`](../BOUNDARIES.md).
>
> **Trạng thái module: MỒ CÔI** — xem [`DEVSTATUS.md`](../DEVSTATUS.md). Chưa quyết hội tụ
> vào mô hình ba-token hay dời `Legacy/`. Cho tới khi có quyết định, nội dung dưới đây
> mô tả mô hình GenMAGIC v3.3 (§7–§10 + §19) và **có thể mâu thuẫn với spec canonical**.
> Mâu thuẫn thì spec canonical thắng.
>
> Bản trước tự khai `Trạng thái: NORMATIVE`. Sai — một module chưa hội tụ không thể tự
> phong nguồn chân lý. Dòng đó đã gỡ. Nội dung kỹ thuật **cố ý giữ nguyên**: viết lại
> cần quyết định về PM/tư-cách trước, sửa sớm là sửa mù.

---

## FEAT.md — Mục đích, Actors, Flows

### Mục đích

AppEconomics định nghĩa cách phân bổ phần thưởng MAGIC mỗi epoch cho các **App Operator** dựa trên năm yếu tố đo lường hiệu suất thực tế: khối lượng stake (V), mức độ sử dụng (Φ_util), lưu lượng người dùng (Φ_users), tỷ lệ tranh chấp (Φ_dispute), và tuổi của ứng dụng (Φ_age). Công thức W là hàm thưởng lõi; `distribute` áp dụng **dust gate (sàn 0.5% pool, chặn đáy)** rồi cap 30% (chặn đỉnh) và tái phân phối phần dư.

**Lý do offchain-only:** W chạy mỗi epoch trên toàn bộ tập apps — O(|A|) phép tính với các BigInt lớn và nhiều vòng lặp phân bổ. Chi phí ExUnit on-chain sẽ vượt Cardano block limit khi |A| > ~20. Kết quả W được commit on-chain qua governance Merkle root (§10.3), không cần validator tính lại.

### Actors

| Actor | Vai trò |
|---|---|
| App Operator | Đăng ký app, duy trì stake V và chất lượng dịch vụ |
| Protocol Epoch Runner | Gọi `computeW` + `distribute` mỗi epoch, post Merkle root lên chain |
| Claimer (App Operator) | Nộp Merkle proof để nhận phần thưởng (§10.3) |
| Governance | Phê duyệt thay đổi tham số [Significant]/[Constitutional] |

### Flows

**Happy path — phân bổ một epoch:**

1. Epoch runner thu thập dữ liệu: V (nanogic), utilHistory[6] (Q-format), nBar (số user), deltaQ (Q-format dispute rate), tier, age cho mỗi app a ∈ A.
2. Gọi `computeW(V, utilHistory, nBar, deltaQ, tier, age)` → W(a).
3. Gọi `distribute(weights, X, capBps)` với X = tổng pool epoch (nanogic) → rewards[a].
4. Xây dựng Merkle tree từ `{app_id → reward}`.
5. Post Merkle root lên governance UTxO.
6. App Operator submit proof → claim reward.

**Edge cases (MECE):**

| Trường hợp | Kết quả |
|---|---|
| V = 0 | W = 0 (§9.3 guard đầu hàm) |
| Tất cả W = 0 (Wtotal = 0n) | Tất cả rewards = 0n, không panic |
| Một app W > 30% X | Cap tại `X × capBps / 10000`, excess tái phân phối |
| Tất cả apps đều bị cap | Excess vào BountyPool (không phân bổ tiếp — convergence) |
| utilHistory rỗng | Φ_util_adj = 0n → W = 0n |
| nBar = 0 | Φ_users = 0n → W = 0n |
| deltaQ ≥ Q² / DISPUTE_BETA_Q (= 200_000_000n, tức 20%) | Φ_dispute = 0n → W = 0n |
| age < GRACE_PERIOD | Φ_age < Q, app nhận thưởng giảm dần |
| emergencyPen > 0 và emergencyPen ≤ Q | κ giảm theo penalty, W giảm tỷ lệ |
| emergencyPen > Q | **Được guard** — clamp về Q (kap_eff = 0n → W = 0n). W không bao giờ âm (W-3) |
| emergencyPen < 0 | **Được guard** — clamp về 0 (không phạt), W = W(emergencyPen=0) |
| weights[a] < 0 trong `distribute` | **Được guard** — throw lỗi (W luôn ≥ 0 theo W-3; weight âm = input dị dạng) |
| App có share tự nhiên < 0.5% pool (dust) | **Được gate (W-12)** — reward 0, loại khỏi mẫu số + tái phân phối; excess → BountyPool, không leak |
| Tất cả app đều dưới sàn (A_eligible rỗng) | Tất cả rewards = 0n, không panic (Wtotal=0 sau gate) |
| `minShareBps = 0n` | Tắt gate — giữ hành vi 3-tham-số cũ (dust leak quay lại, đã tài liệu hoá) |

**Out-of-scope:**
- On-chain validator tính W (xem lý do offchain-only ở trên).
- Mint MAGIC token (MAGIC = số kế toán trong vault datum, không phải token).
- Governance voting mechanics (§13, ngoài phạm vi module này).
- CoStakePool split (§7.2 — logic phân chia reward cho contributors, không phải cho apps).

---

## MATH.md — Formal Definitions

### §3.2 Q-format arithmetic

```
Q = 10^9
mulQ(a, b) = ⌊a × b / Q⌋
```

**Lemma 3.1:** Với a, b ∈ ℤ≥0, mulQ(a, b) ≤ a × b / Q (user-unfavorable).  
**Lemma 3.2:** Sau 5 lần mulQ liên tiếp từ giá trị x, tổng sai số ≤ 7 nanogic.  
Nguồn: `ProtocolUtils/src/index.ts:312` và `AppEconomics/offchain/src/math.ts:33`.

### §9.1 V_dampened — Hàm giảm tuyến tính stake lũy kế

```
V_dampened(V) = ⌊V^(7/10)⌋ = isqrt_10th(V^7)
```

**Tại sao lũy thừa 0.7:** Ngăn app lớn độc chiếm phần thưởng. Sub-linearity: V_d(2V)/V_d(V) = 2^0.7 ≈ 1.624 < 2 (T2).

**Xác minh on-chain (Lemma 9.2):**  
Thay vì tính isqrt_10th on-chain (đắt), validator xác minh claim Vd:  
```
verifyVd(V, Vd) ⟺ Vd^10 ≤ V^7 < (Vd+1)^10
```
Nguồn: `ProtocolUtils/src/index.ts:301–303`.

**isqrt_10th:** Newton's method thuần BigInt (tránh overflow khi V ≈ S_LAMP_TOTAL = 36×10^15, V^7 ≈ 10^110 vượt `Number`). Initial guess qua bit-length.  
Nguồn: `ProtocolUtils/src/index.ts:274–296`.

### §9.2 Năm yếu tố (Five Factors)

#### Φ_util_adj — Hiệu suất sử dụng có điều chỉnh variance

```
ū = mean(utilHistory)                                    — SMA-6
σ²_Q = Σ ⌊(u_i − ū)² / Q⌋ / K                         — Q-format variance §8.3
var_pen = min(σ²_Q × VARIANCE_BETA_Q / Q, PENALTY_CAP_Q)  — AI wash resistance T17

Φ_util_base(ū) = 0                     nếu ū < UTIL_DEAD_Q (5%)
               = min(Q, (ū − UTIL_DEAD_Q) × Q / (UTIL_TARGET_Q − UTIL_DEAD_Q))  — tuyến tính [5%, 50%]

Φ_util_adj = ⌊Φ_util_base(ū) × (Q − var_pen) / Q⌋
```

**Hằng số:**  
- `UTIL_DEAD_Q = 50_000_000n` (5%) [Routine]  
- `UTIL_TARGET_Q = 500_000_000n` (50%) [Significant]  
- `VARIANCE_BETA_Q = 5_000_000_000n` (5Q) [Significant]  
- `PENALTY_CAP_Q = 500_000_000n` (50% max) [Constitutional]  

Nguồn: `AppEconomics/offchain/src/math.ts:49–82`.

> **Lưu ý cho integrator — hành vi khi history rỗng:**  
> `phiUtilAdj([])` trả về `0n` (W = 0, app không được thưởng).  
> Hàm `sma6([])` trong cùng file trả về `Q` (neutral = 100%) — đây là hành vi khác nhau có chủ ý:  
> `sma6` dùng làm UM multiplier độc lập (neutral khi không có lịch sử), còn `phiUtilAdj` dùng trong W — không có dữ liệu = không có cơ sở thưởng.  
> **Không dùng `sma6` thay thế cho `phiUtilAdj` trong pipeline tính W.**

#### Φ_users — Mật độ người dùng

```
Φ_users(N̄) = 0                                   nếu N̄ = 0
           = min(Q, isqrt(N̄ × Q² / n_target))   — n_target = 100
```

**Lemma 9.4:** |Φ_users − Q√(N̄/n_t)| ≤ 1 với N̄ ≤ n_target.  
Nguồn: `AppEconomics/offchain/src/math.ts:87–93`.

#### Φ_dispute — Chất lượng dịch vụ

```
δ_q = conf × Q / (totalBurns + DRATE_PRIOR)      — Bayesian smoothed §8.9
Φ_dispute(δ_q) = max(0n, Q − δ_q × DISPUTE_BETA_Q / Q)
```

**Hằng số:**  
- `DRATE_PRIOR = 10n` [Routine] — đảm bảo mẫu số ≥ 10 (T20, không chia cho 0)  
- `DISPUTE_BETA_Q = 5_000_000_000n` (5Q) [Significant]  

**Lý do Bayesian:** App mới (conf=1, burns=1) không bị phạt 100% (sẽ → Φ_dispute=0). Với prior=10: δ_q = Q/11 ≈ 9.1%, Φ_dispute ≈ 55% > 0.  
Nguồn: `AppEconomics/offchain/src/math.ts:97–117`.

#### Φ_age — Tuổi ứng dụng

```
Φ_age(age) = min(Q, (age + 1) × Q / (GRACE_PERIOD + 1))
```

**Hằng số:** `GRACE_PERIOD = 6n` [Routine]  
**Lemma 9.5:**  
- (i) Φ_age(0) = Q/7 > 0 — app mới vẫn nhận thưởng từ ngày 1  
- (ii) Φ_age(age ≥ 6) = Q — tốt nghiệp sau 6 epoch  
- (iii) Φ_age(age > 6) = Q — capped  

Nguồn: `AppEconomics/offchain/src/math.ts:105–108`.

#### κ (Tier kappa) — Hệ số nhân theo tier

```
κ = { Tier1: Q, Tier2: 1.2Q, Tier3: 1.5Q }
ep_clamped  = clamp(emergencyPen, 0, Q)          — guard W-3 (xem dưới)
κ_effective = κ × (Q − ep_clamped) / Q           nếu ep_clamped > 0
```

**Guard W-3 (emergencyPen):** `computeW` clamp `emergencyPen` về `[0, Q]` trước khi
tính `kap_eff`. `emergencyPen > Q` → clamp về Q → `kap_eff = 0` → W = 0 (không âm);
`emergencyPen < 0` → clamp về 0 (không phạt). Không còn là "caller invariant" — code
tự đảm bảo W ≥ 0 với mọi giá trị `emergencyPen`.

Nguồn: `AppEconomics/offchain/src/math.ts:25`, guard tại `computeW`.

### §9.3 W — Hàm phần thưởng

```
W(a, e) = 0                              nếu V = 0
         = mulQ(mulQ(mulQ(mulQ(mulQ(Vd, Φ_util_adj), Φ_users), Φ_dispute), κ_eff), Φ_age)
```

**Năm lần mulQ tuần tự** — không gộp thành một phép chia lớn (C-OVERFLOW; sai số ≤ 7 nanogic per Lemma 3.2).

**Theorem 9.3 Monotonicity (T6):**  
- W tăng đơn điệu theo V (với các tham số khác cố định)  
- W giảm đơn điệu theo deltaQ  

Nguồn: `AppEconomics/offchain/src/math.ts:123–150`.

### §10 Phân bổ reward có sàn (dust gate) + cap

```
W_total_all = Σ_{a ∈ A} W(a)                         — mẫu số trên TOÀN tập
minShare    = X × minShareBps / 10000                — sàn tuyệt đối theo pool

# §10.0 Dust gate (W-12) — lọc trước khi cap
A_eligible = { a ∈ A : ⌊W(a) × X / W_total_all⌋ ≥ minShare }   nếu minShareBps > 0
           = A                                                   nếu minShareBps = 0 (tắt gate)
r(a) = 0  với mọi a ∉ A_eligible          — dust nhận 0, loại khỏi mẫu số + tái phân phối

# §10.1 Cap redistribution — chỉ trên A_eligible
W_total = Σ_{a ∈ A_eligible} W(a)         — re-normalise theo survivors
cap     = X × capBps / 10000
r₀(a)   = W(a) × X / W_total               — phân bổ tỷ lệ ban đầu (a ∈ A_eligible)

Lặp cho đến khi excess = 0:
  excess = Σ max(0, r(a) − cap)
  r(a)   = cap  nếu r(a) > cap
  Tái phân bổ excess theo tỷ lệ W cho các apps trong A_eligible chưa hit cap
```

**§10.0 Dust gate — cơ chế chống dust-app (W-12).**

*Vector tấn công:* 1 app thật bị cap tại 30% sẽ nhả 70% pool dạng excess. Không có sàn, excess được tái phân phối theo raw weight → 1 app rác `W=1` (không tiêu thụ MAGIC thật) hút trọn 70% chỉ nhờ "chưa hit cap". Cap chặn **đỉnh**; gate chặn **đáy**.

*Cơ chế đã chọn — minimum-activity gate (sàn theo share tương đối pool):* App chỉ tham gia nếu **share tự nhiên (pre-cap)** `⌊W·X/W_total_all⌋ ≥ minShare`. Gate đánh trên share tự nhiên (KHÔNG phải reward sau tái phân phối) — đây là điểm mấu chốt: đảm bảo excess tái phân phối không bao giờ "hồi sinh" một dust app. App bị gate nhận reward 0 và bị loại khỏi mẫu số chia phần + khỏi vòng tái phân phối, dồn pool về các app có hoạt động thật.

*Tại sao chọn gate thay vì sàn weight tuyệt đối / hybrid:*
- **Sàn weight tuyệt đối (mỗi app được đảm bảo ≥ floor_bps):** SAI hướng — nó *bảo đảm* cho dust một phần pool, giải bài toán ngược (giúp app nhỏ trung thực), không chống dust. Bác bỏ.
- **Minimum-activity gate (đã chọn):** đánh đúng gốc — dust `W=1` đơn giản không phải người tham gia. "Muốn chia pool phải làm việc thật."
- **Hybrid = gate (đáy) + cap (đỉnh):** đây chính là thiết kế cuối. Gate và cap là đối ngẫu, cùng bound mỗi participant về `[0 nếu ngoài gate, cap nếu trong gate]`.

*Tại sao sàn tương đối (% pool) thay vì ngưỡng nanogic tuyệt đối:* ngưỡng tuyệt đối lỗi thời khi pool tăng. Sàn theo share tự pool — "phải đại diện ≥ X% hoạt động thật" — tự co giãn, ổn định tham số.

**Theorem 10.1 Hội tụ:** Vòng lặp cap kết thúc sau ≤ |A_eligible| + 1 bước vì mỗi iteration ≥ 1 app hit cap và ra khỏi tập uncapped. Gate chỉ co tập (monotone exclusion), không thêm vòng lặp.  
**MAX_SINGLE_APP_REWARD_BPS = 3000n** (30%) [Constitutional]  
**MIN_APP_SHARE_BPS = 50n** (0.5% pool) [Constitutional] — sàn dust gate; `minShareBps=0n` tắt gate (giữ tương thích caller 3-tham-số cũ).  

**Guard W-10 (weight âm):** `distribute` throw lỗi nếu bất kỳ `weights[a] < 0`. W
luôn ≥ 0 theo W-3, nên weight âm là input dị dạng. Nếu cho phép, một app weight-âm
có thể bị tái phân phối thành reward dương qua vòng lặp cap (Wunc biến contributor âm
thành kẻ chiếm cap), và Wtotal sẽ sai lệch mẫu số chia phần. Fail loud thay vì phân
bổ sai âm thầm.

**Guard W-12 (dust gate):** `distribute` loại mọi app có share tự nhiên
`⌊W·X/W_total_all⌋ < minShare = X·minShareBps/10000` TRƯỚC vòng cap. App bị loại
nhận reward 0, không tham gia mẫu số chia phần hay tái phân phối excess. Đây là phòng
thủ chống dust-app value-leak (xem §10.0). `minShareBps=0n` tắt gate. Guard W-10 (weight
âm) vẫn chạy trên TOÀN tập app trước gate, nên weight âm trên app sẽ-bị-gate vẫn throw.

Nguồn: `AppEconomics/offchain/src/math.ts` — gate + cap trong `distribute`.

### Boundary conditions

| Điều kiện | Kết quả | Nguồn |
|---|---|---|
| V = 0 | W = 0 | `math.ts:133` |
| utilHistory = [] | Φ_util_adj = 0 → W = 0 | `math.ts:76` |
| nBar = 0 | Φ_users = 0 → W = 0 | `math.ts:88` |
| deltaQ ≥ Q²/DISPUTE_BETA_Q (= 200_000_000n, 20%) | Φ_dispute = 0 → W = 0 | `math.ts:98–99` |
| Wtotal = 0 | Tất cả rewards = 0, không NaN | `math.ts:163` |
| V < 0 (không thể, BigInt) | N/A | N/A |

---

## Test Vectors (normative — §20)

### TV-001: V_dampened

```
Input:  V = 1_000_000_000_000n (10^12 nanogic)
Output: Vd = 251_188_643n
Verify: 251_188_643^10 ≤ (10^12)^7 < 251_188_644^10 ✓

Input:  V = 1_000n
Output: Vd = 125n
Verify: 125^10 ≤ 1000^7 < 126^10 ✓
```

Nguồn: `AppEconomics/tests/appeconomics.test.ts:19–56`.

### TV-002: Φ_util_adj với burst (AI wash resistance)

```
Input:  utilHistory = [Q, Q, Q, 0, 0, 0]
Steps:
  ū = 500_000_000n (Q/2)
  σ²_Q = 250_000_000n (Q/4)
  var_pen = min(250M × 5B / Q, 500M) = min(1250M, 500M) = 500_000_000n
  Φ_util_base(500M) = (500M − 50M) × Q / (500M − 50M) = Q
Output: Φ_util_adj = Q × (Q − 500M) / Q = 500_000_000n

Ý nghĩa: App burst dùng cao 50% thời gian bị phạt 50% — ngăn AI wash.
```

Nguồn: `AppEconomics/tests/appeconomics.test.ts:64–82`.

### TV-003: δ_q Bayesian

```
Input:  confirmed=1, totalBurns=1
Without prior: δ_q = Q → Φ_dispute = 0 (bất công với app mới)
With prior=10: δ_q = Q / 11 ≈ 90_909_090 → Φ_dispute = Q − 90.9M × 5 = 545M > 0

Input:  confirmed=0, totalBurns=0
Output: δ_q = 0 (app mới không bị phạt)

Input:  confirmed=1, totalBurns=10
Output: δ_q = Q / 20 = 50_000_000n (5%)
```

Nguồn: `AppEconomics/tests/appeconomics.test.ts:88–124`.

### TV-004: Φ_age

```
age=0  → Q/7  = 142_857_142n  (app mới, dương tính ngay từ ngày 1)
age=3  → 4Q/7 = 571_428_571n
age=6  → Q    = 1_000_000_000n (tốt nghiệp)
age=9  → Q    (capped)
```

Nguồn: `AppEconomics/tests/appeconomics.test.ts:129–147`.

### TV-005: W full computation

```
Input:
  V = 50_000 MAGIC = 50_000 × Q nanogic = 5×10^13
  utilHistory = [800M, 820M, 790M, 810M, 800M, 780M]  (ổn định ~80%)
  nBar = 200 (> USERS_TARGET=100 → Φ_users = Q)
  deltaQ = 30_000_000n (3%) → Φ_dispute = Q − 150M = 850_000_000n
  tier = Tier2 (κ = 1.2Q = 1_200_000_000n)
  age = 20 (→ Φ_age = Q)
  emergencyPen = 0n

Intermediate:
  Vd ≈ 3_888_000_000n  (xác minh: verifyVd(5×10^13, Vd) = true)
  Φ_util_adj ≈ 999_166_670n  (ū=800M, σ²=166_666n → var_pen=833_330n → Φ_util_adj = Q×(Q−833_330)/Q)
  Φ_users = Q
  Φ_dispute = 850_000_000n
  κ_eff = 1_200_000_000n
  Φ_age = Q

Output:
  W ∈ (3_900_000_000n, 4_100_000_000n) ≈ 3.966 MAGIC
  nanogicToMagicStr(W) starts with "3."
```

Nguồn: `AppEconomics/tests/appeconomics.test.ts:154–184`.

### TV-006: Reward distribution với cap

```
Input:
  X = 1_000_000 MAGIC
  weights = { Aladin: 700K MAGIC, OriLife: 200K MAGIC, PhoenixKey: 100K MAGIC }
  capBps = 3000 (30%)

Expected:
  cap = 300_000 MAGIC
  Aladin: min(700K, 300K) = 300K; excess = 400K

  Vòng 1 — redistribute 400K cho OriLife và PhoenixKey (tỷ lệ W 2:1):
    OriLife:    200K + 266.7K = 466.7K > cap → bị cắt tại 300K; newExcess += 166.7K
    PhoenixKey: 100K + 133.3K = 233.3K ≤ cap → giữ nguyên
  (excess còn lại 166.7K → vào BountyPool vì tất cả uncapped đã hit cap)

  Kết quả cuối: Aladin=300K, OriLife=300K, PhoenixKey≈233K; total≈833K ≤ X ✓
  (T3 Conservation: tổng ≤ X — phần dư BountyPool không tái phân bổ tiếp khi Wunc=0)
```

Nguồn: `AppEconomics/tests/appeconomics.test.ts:205–231`.

### TV-014: Dust gate (W-12 — minimum-activity floor)

```
Input:
  X = 1_000_000 MAGIC
  weights = { Real: 1_000_000 MAGIC, D0..D9: 1 nanogic mỗi app }
  capBps = 3000 (30%), minShareBps = 50 (0.5%)

Trước fix (gate tắt, minShareBps=0):
  Real bị cap 30%; 70% excess tái phân phối cho 10 dust → dustTotal ≈ 69.99% (VALUE LEAK)

Sau fix (gate = 50 bps):
  share tự nhiên mỗi dust = ⌊1 × X / W_total_all⌋ = 0 ≪ minShare = 5_000 MAGIC → bị gate
  Real = đúng 300_000 MAGIC (cap 30%); mỗi dust = 0; dustTotal = 0
  Excess 70% → BountyPool (KHÔNG leak); Σ rewards ≤ X (W-5)

Boundary:
  weights = { Big: 9901, Edge: 50, Dust: 49 }  (Σ = 10000)
  Edge share = 0.50% = minShare → survives;  Dust share = 0.49% < minShare → reward 0

Regression: A70/B20/C10 (mỗi ≥ 10% ≫ 0.5%) phân bổ y nguyên — không app nào bị gate.
Escape hatch: minShareBps=0n → khôi phục hành vi leak cũ (tài liệu hoá).
```

Nguồn: `AppEconomics/tests/appeconomics.test.ts` — describe "TV-014: dust-app gate".

### TV-007: Merkle claim (T11 Soundness)

Cây Merkle blake2b256. Forging proof đòi second preimage — độ khó 2^256 classical.  
Implementation tại `scripts/deploy/` (ngoài scope module này).  
Nguồn: `AppEconomics/tests/appeconomics.test.ts:237–242`.

> **Lưu ý thực thi:** Test TV-007 hiện là stub `expect(true).toBe(true)` — T11 Soundness **không được kiểm tra** trong bộ 54/54 tests. Merkle verification thực tế nằm trong `scripts/deploy/` và chưa được tích hợp vào test suite AppEconomics. Integrator không nên dựa vào TV-007 như bằng chứng kiểm thử T11.

### TV-008: Sai số Q-format ≤ 7 nanogic

```
Vd = 1_000_000_000n, tất cả phi = Q:
  w0 = Vd
  w1 = mulQ(w0, Q) = w0 (ε = 0)
  ... 5 lần
  |w5 − Vd| ≤ 7n  (Lemma 3.2 ✓)
```

Nguồn: `AppEconomics/tests/appeconomics.test.ts:260–275`.

---

## TECH.md — Kiến trúc kỹ thuật

### Offchain-only — không có Aiken validator

AppEconomics không có `onchain/` directory. Lý do:

1. **Chi phí ExUnit:** W tính V_dampened (Newton iteration), 5 mulQ, distribute loop — O(|A|) iterations. Với |A| > ~20 apps, tổng ExUnit vượt block limit.
2. **Governance commit:** Kết quả W được tổng hợp off-chain, commit lên chain qua Merkle root trong governance UTxO (§10.3). Validator chỉ cần xác minh Merkle proof, không tính lại W.
3. **Verifiable claim:** `verifyVd(V, Vd)` — on-chain verification rẻ (xem §9.1) — đủ để audit Vd nếu cần.

### Dependencies

```
AppEconomics/offchain/package.json:
  "@magiclamp/protocol-utils": "file:../../ProtocolUtils"
```

Các hàm import từ ProtocolUtils (single source of truth, P8):
- `isqrt`, `isqrt10th`, `vDampened`, `verifyVd` — `ProtocolUtils/src/index.ts:257–307`
- `nanogicToMagicStr` — `ProtocolUtils/src/index.ts:106`

### Types

```typescript
// AppEconomics/offchain/src/math.ts:27
export type Tier = "Tier1" | "Tier2" | "Tier3";

// TIER_KAPPA (Q-format multipliers):
// Tier1: 1.0Q, Tier2: 1.2Q, Tier3: 1.5Q
```

Không có Datum/Redeemer Aiken type vì module offchain-only.

### Invariants (offchain)

| ID | Phát biểu | Nguồn |
|---|---|---|
| W-1 | V = 0 → W = 0 (guard) | `math.ts:133` |
| W-2 | W ≤ W_exact (user-unfavorable, Lemma 3.2) | `math.ts:142–149` |
| W-3 | W ≥ 0 với **mọi** giá trị emergencyPen — `computeW` clamp emergencyPen về [0, Q] (>Q→Q, <0→0), kap_eff ∈ [0, κ] ⇒ W không bao giờ âm | guard trong `computeW` |
| W-4 | Wtotal = 0 → distribute trả về tất cả 0, không panic | `math.ts:163` |
| W-5 | Σ rewards ≤ X (T3 Conservation) | `math.ts:165–191` |
| W-6 | rewards[a] ≤ cap với mọi a (§10) | `math.ts:173–174` |
| W-7 | Vòng lặp distribute kết thúc trong ≤ |A|+1 bước (T10.1) | `math.ts:177` |
| W-8 | δ_q denominator ≥ DRATE_PRIOR = 10 > 0 (T20, không chia 0) | `math.ts:113` |
| W-9 | BigInt everywhere — không dùng Number cho amounts (C-OVERFLOW) | toàn bộ math.ts |
| W-10 | `distribute` throw nếu bất kỳ `weights[a] < 0` — weight âm là input dị dạng (W luôn ≥ 0 theo W-3); fail-loud thay vì mis-allocate qua vòng cap | guard trong `distribute` |
| W-11 | `distribute` throw nếu pool `X < 0` — pool reward (nanogic) ≥ 0 theo cấu tạo; X âm sẽ lật dấu mọi reward, phòng thủ-theo-tầng | guard trong `distribute` |
| W-12 | Dust gate — app có share tự nhiên `⌊W·X/W_total_all⌋ < X·minShareBps/10000` nhận reward 0 và bị loại khỏi phân bổ; gate đánh trên share PRE-cap nên excess không hồi sinh dust; `minShareBps=0n` tắt gate | gate trong `distribute` |

### eUTXO flow

AppEconomics không tương tác trực tiếp với UTxO trong module này. Flow tổng:

```
[Off-chain epoch runner]
  ↓ computeW cho mỗi app
  ↓ distribute(weights, X, capBps)
  ↓ Build Merkle tree {app_id → reward}
  ↓ Submit tx: update governance UTxO với Merkle root
  
[Claimer (App Operator)]
  ↓ Submit Merkle proof
  ↓ Governance validator: verifyMerkleProof(root, proof, app_id, amount)
  ↓ MAGIC credited vào vault datum
```

---

## EXEC.md — Deploy và Test

### Deploy steps

AppEconomics là module offchain-only — không có bước deploy riêng. Phụ thuộc:

1. LAMP policy đã deploy (`scripts/deploy/01_mint_lamp.ts`).
2. Governance UTxO tồn tại (chứa Merkle root slot — chưa có trong v1.0, defer).

**Cài đặt:**
```bash
cd /Users/ductiger/Projects/MAGIC/AppEconomics/offchain
npm install
```

**Env vars cần thiết:** Không có — module tính toán thuần, không kết nối Blockfrost.

### Test plan

**Positive tests (≥3):**

| ID | Input | Expected output |
|---|---|---|
| T+1 | TV-005: V=50K MAGIC, util~80%, N̄=200, δ=3%, Tier2, age=20 | W ∈ (3.9B, 4.1B) nanogic |
| T+2 | TV-006: Aladin 70%, OriLife 20%, PhoenixKey 10%, pool=1M MAGIC | Tất cả ≤ 300K; total ≤ X |
| T+3 | TV-001: vDampened(10^12) | Vd=251_188_643n, verifyVd=true |
| T+4 | Φ_age(6) | Q (tốt nghiệp chính xác) |
| T+5 | isqrt_10th(S_LAMP_TOTAL^7) | Không throw, Vd^10 ≤ S_LAMP_TOTAL^7 |

**Negative tests (≥5):**

| ID | Input | Expected output |
|---|---|---|
| T-1 | V=0 | W=0 (guard) |
| T-2 | utilHistory=[] | Φ_util_adj=0 → W=0 |
| T-3 | nBar=0 | Φ_users=0 → W=0 |
| T-4 | conf=1, burns=1 (không prior) → so sánh | Φ_dispute > 0 với Bayesian |
| T-5 | TV-002: utilHistory=[Q,Q,Q,0,0,0] | Φ_util_adj=Q/2 (burst penalty) |
| T-6 | weights={} hoặc Wtotal=0 | Tất cả rewards=0, không panic |
| T-7 | verifyVd(V, Vd+1) | false (over-claim bị bắt) |
| T-8 | TV-011: emergencyPen=1.5Q (>Q) | W=0, KHÔNG âm (W-3 guard) |
| T-9 | TV-011: emergencyPen<0 | W=W(emergencyPen=0) (clamp về 0) |
| T-10 | TV-012: weights có app weight âm | throw `negative weight` (W-10 guard) |
| T-11 | TV-013: pool X < 0 | throw `negative pool` (W-11 guard); X=0 → tất cả 0 |
| T-12 | TV-014: 1 real (cap) + 10 dust(W=1) | dust = 0 (KHÔNG 70%), Real = 30%, Σ ≤ X (W-12 gate) |
| T-13 | TV-014 boundary: share 0.50% vs 0.49% | 0.50% survives, 0.49% gated |
| T-14 | TV-014 escape: minShareBps=0n | gate tắt, dust leak quay lại (regression doc) |

**Chạy tests:**
```bash
cd /Users/ductiger/Projects/MAGIC/AppEconomics/offchain
npm test
# Expected: 54/54 pass
```

### Known limits

| Limit | Giá trị | Lý do |
|---|---|---|
| MAX_SINGLE_APP_REWARD_BPS | 3000 (30%) [Constitutional] | Ngăn monopoly phần thưởng (chặn đỉnh) |
| MIN_APP_SHARE_BPS | 50 (0.5% pool) [Constitutional] | Dust gate — chặn dust-app hút excess (chặn đáy, W-12) |
| USERS_TARGET | 100 [Routine] | Ngưỡng Φ_users = Q |
| GRACE_PERIOD | 6 epochs [Routine] | ~30 ngày Preview |
| isqrt_10th max input | V ≤ S_LAMP_TOTAL = 36×10^15 → V^7 ≈ 10^110 | BigInt safe (đã test) |
| distribute iterations | ≤ |A|+1 | T10.1 convergence proof |
| W error | ≤ 7 nanogic | Lemma 3.2 (5 mulQ steps) |

### v-next

- [ ] Onchain Merkle root validator (governance) để verify W claims trên Preview testnet.
- [ ] Parameterize USERS_TARGET, GRACE_PERIOD qua governance parameter UTxO (hiện hardcode).
- [ ] CoStakePool split integration (§7.2): sau khi có rewards[app], chia cho contributors.
- [ ] Formal verification Theorem 10.1 bằng Agda/Lean.

---

## Design Rationale

### Tại sao V_dampened dùng lũy thừa 0.7 (không phải 0.5 hay log)?

- **0.5 (sqrt):** Sub-linear tốt nhưng quá agressive — app có V=1B nhận √(1B) ≈ 31K, app 4B nhận 63K (ratio=2). Stake 4× chỉ thưởng 2×. Không khuyến khích stake lớn.
- **log:** Gần như phẳng hoàn toàn khi V lớn — mất tín hiệu differentiation.
- **0.7 (7/10):** Cân bằng: stake 2× → thưởng 1.624× (2^0.7). Khuyến khích stake lớn nhưng không độc chiếm. Còn được gọi là "power law với exponent hợp lý cho DeFi".
- **Lý do 7/10 thay vì float:** isqrt_10th(V^7) thuần BigInt, tránh float precision issue (C-OVERFLOW).

### Tại sao offchain, không onchain?

Xem mục "Offchain-only" ở TECH.md. Ngắn gọn: ExUnit cost O(|A|) prohibitive; Merkle commit đủ trust.

### Tại sao Bayesian prior cho dispute rate?

App mới hoàn toàn bị oan với 1 dispute đầu tiên nếu dùng raw rate (δ = 100%). Prior=10 = "tương đương 10 giao dịch sạch từ trước" — đủ buffer cho app mới, đủ nhạy cảm cho app lâu dài với nhiều disputes.

### Tại sao dust gate (sàn) thay vì chỉ cap?

Cap 30% chặn **đỉnh** (chống monopoly), nhưng để hở **đáy**: khi app thật bị cap, 70% pool nhả ra dạng excess và được tái phân phối theo raw weight — một app rác `W=1` (không tiêu thụ MAGIC thật) hút trọn 70% chỉ nhờ "chưa hit cap". Đây là value-leak nghiêm trọng (đã đo: dust 10 app `W=1` hút 69.99% pool trước fix).

First-principles: gốc lỗi không phải cap mà là **quyền nhận** chưa từng bị gate theo đóng góp thật. Ba lựa chọn:
- **Sàn weight tuyệt đối** (mỗi app đảm bảo ≥ floor): SAI hướng — *bảo đảm* cho dust một phần, giải bài toán ngược. Bác bỏ.
- **Minimum-activity gate** (đã chọn): app phải có share tự nhiên ≥ 0.5% pool mới được chia. Dust `W=1` đơn giản không phải participant.
- **Hybrid = gate + cap** (thiết kế cuối): gate và cap đối ngẫu — bound mỗi app về `[0 nếu ngoài gate, cap nếu trong]`.

Sàn **tương đối theo % pool** (không phải ngưỡng nanogic tuyệt đối) để tự co giãn khi pool tăng. Gate đánh trên share **pre-cap** để excess tái phân phối không hồi sinh dust. 0.5% với cap 30% ⇒ tối đa ~3 app hit cap, phần còn lại trải trên các app mỗi app ≥ 0.5% — số participant bị bound, hết dust.

### Tại sao variance penalty?

Ngăn "AI wash": app mua traffic giả có thể đẩy ū cao nhưng variance cũng cao. Φ_util_adj giảm mạnh khi σ² lớn, dù ū đẹp. App dịch vụ thật thường có utilization ổn định, variance thấp.
