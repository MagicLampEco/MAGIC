# GenMAGIC — MATH (v0.2, chuẩn thi hành)

**Ngày:** 2026-07-17 · **Thay:** `GenMAGIC-CONTRACT-Vi.md` v0.1 (đã bị hội đồng đánh sập 8 điểm chịu lực).
**Biên bản hội đồng:** `Specs/_council/GenMAGIC-v0.1-council-2026-07-17.md` (48 phát hiện / 37 phán quyết).

> **Neo chuẩn — chỉ 3 nguồn:** `PhoenixKeyDID/Wakeme/spec/PhoenixKey-Wakeme-{Math,Tech}.md`,
> `PhoenixKeyDID/Wakeme/PhoenixKey-MAGIC-Vault-Scale-Analysis.md`.
> **ĐÃ CHẾT (không suy luận từ):** cổng-tiêu-thật · 7-epoch `Σwᵢ·M(Lᵢ)` · TWAB · UM/PM/LF · profile Ember/Flame/Lantern ·
> halving · VacuumGen · InstantGen-mua (LAMP→Treasury) · MAGIC-là-token. Bản cũ: `Legacy/stale-genmodel-2026-07/`.

## §1. Tiên đề (anh Aladin chốt — KHÔNG lật)

| # | Tiên đề |
|---|---|
| **G1** | **Chỉ cần NẮM LAMP là sinh được MAGIC.** Không cổng. Cả InstantGen lẫn ScheduleGen. |
| **G2** | Tư-cách CHỈ nhân vào **TỶ LỆ** sinh — đúng **một** tham số. |
| **G3** | Tổng gen toàn cầu phụ thuộc **GreenBack + ScheduleGen**. |
| **G4** | **Công dân hạng nhất = người tiêu MAGIC cho DỊCH VỤ THẬT.** |
| **G5** | **LAMP đứng yên khi gen** (I-ACT-7). Engine chỉ ĐỌC. |
| **G6** | MAGIC = account-trong-Vault. Không mint, không policy-id, không chuyển nhượng. |
| **G7** | Tấm-pin: user KHÔNG BAO GIỜ nhận LAMP; LAMP rời vault chỉ về **pot**. |
| **G8** | Mọi tham số phải **điều-tiết cung-cầu**. |
| **G9** | MAGIC decay = **dùng-hay-mất, RESET mỗi epoch** (pin mặt trời). |

## §2. Đơn vị

```
Q = 10⁹ · oil_per_lamp = 10⁶ · nanogic = MAGIC × 10⁹ · slots_per_epoch = 432_000
c = conditional_lamp ∈ [1, 1001]  (NGUYÊN-LAMP, KHÔNG oildrop)
```
**BigInt bắt buộc.** Cấm `Number` (C-OVERFLOW). Nhân-chia-floor **tuần tự**, không gộp một phép.

**BẢNG THỨ NGUYÊN (bắt buộc — v0.1 chết vì thiếu bảng này):**

| Đại lượng | Đơn vị | Thang |
|---|---|---|
| `c_v` | NGUYÊN-LAMP | 1 |
| `tư_cách_v` | hệ số | **Q** |
| `w_v` | LAMP-hiệu-dụng | 1 |
| `W = Σ w_v` | LAMP-hiệu-dụng | 1 |
| `ngân_sách_gen` | nanogic | 1 |
| `nhịp_gen` | nanogic/LAMP-hiệu-dụng | **Q** |
| `M_v` | nanogic | 1 |

## §3. Đọc vault — engine PHẢI tự xác thực (v0.1 SAI ở đây)

> **v0.1 viết "bất biến bắc cầu — miễn phí, không cần engine kiểm". SAI.** `L == c × oil` là bất biến
> **CHUYỂN-TRẠNG-THÁI** — chỉ được ép KHI validator chạy. UTxO chưa ai spend thì **không validator nào kiểm nó**.
> PoC PASS: UTxO 2 ADA tại địa chỉ vault + datum bịa `c = 10¹²`, không NFT không LAMP → nuốt 99,98% ngân sách;
> `c = 10²⁴` → toàn mạng gen = 0. Giá tấn công: **2 ADA**.

Với **mỗi** vault đọc qua `reference_input`, engine ép **đủ 5 bước, thiếu 1 là loại**:

```
(1) address.payment_credential == Script(H_did)
    H_did = script-hash apply-param CANONICAL do engine TỰ TÍNH LẠI (7 param hằng hệ).
    KHÔNG suy từ datum. KHÔNG tin địa chỉ tự khai.        ← chống param-substitution
(2) quantity_of(value, H_did, owner_commit) == 1          ← vault-NFT singleton
(3) L_đo = quantity_of(value, LAMP_POLICY_CANONICAL, LAMP_NAME_CANONICAL)   ← TỰ ĐO từ value
(4) c_dùng = min(c_datum, ⌊L_đo / oil_per_lamp⌋)          ← KHÔNG BAO GIỜ tin c trong datum
(5) 1 ≤ c_dùng ≤ 1001, ngược lại LOẠI vault
```
**(SỔ-VALUE) tự nó ĐÚNG** (Wakeme ép ở mọi redeemer) — cái sai là suy nó **tự bắc cầu sang read-time**.
Bất biến chứng ở **spend-time KHÔNG tự bắc cầu sang read-time**.

**Sybil đa-vault:** `I-ACT-10` (1 DID = 1 vault) **KHÔNG tồn tại on-chain** (hội đồng xác minh, refuter không bác nổi).
⟹ **KHÔNG được dựa vào nó.** Engine tự khử trùng theo `did_commit`: nhiều vault cùng `did_commit` → **gộp `c`, tính MỘT tư-cách**.
Uniqueness PersonDID (sinh-trắc Enclave) = giả-định-tin-cậy ngoài phạm vi, **`T-3` là lỗ ĐANG MỞ, KHÔNG phải lá chắn**.

## §4. Hệ-số-tư-cách — TỔNG-CÓ-TRỌNG-SỐ (anh chốt 17/7; v0.1 dùng tích → G4 GÃY)

> **Vì sao bỏ tích:** đạo hàm riêng của tích ∝ tích các hệ số còn lại ⟹ **"giàu càng giàu"** — đúng thứ ta chống.
> Đo được: ôm-tối-ưu **4.95×** > tiêu-thật **4.74×** mà trả **0 đồng** ⟹ **G4 lật**. Và dải hữu ích ở cân bằng
> chỉ **2.50×** (3/4 hệ số thành hằng số, triệt tiêu khi chuẩn hoá §5) ⟹ **đổi sang tổng mất 0 khả năng phân biệt.**

**Bốn tỷ-lệ thành phần, mỗi cái ∈ [0, Q]** — cửa sổ nửa mở `[e−6, e)` (epoch hiện tại KHÔNG tính):

```
tuổi_epoch  = max(0, min(⌊(slot_now − vest_start_slot)/slots_per_epoch⌋, TRẦN_TUỔI))     TRẦN_TUỔI = 24
r_tuổi      = ⌊tuổi_epoch × Q / TRẦN_TUỔI⌋
r_tiêu      = min(Q, ⌊đã_tiêu       × Q / max(đã_sinh, 1)⌋)
r_thấp_điểm = min(Q, ⌊tiêu_thấp_điểm × Q / max(đã_sinh, 1)⌋)     ← chuẩn hoá theo đã_SINH, KHÔNG theo đã_tiêu
r_cam_kết   = min(Q, ⌊magic_cam_kết  × Q / max(đã_sinh, 1)⌋)
```

> **`max(0, ·)` ở `tuổi_epoch` là LOAD-BEARING.** v0.1 chỉ kẹp TRÊN ⟹ `vest_start_slot = 10¹⁸` → tuổi ÂM →
> tư-cách ÂM → `W` ÂM → `max(W,1)` trả **1** → `nhịp_gen = ngân_sách × Q / 1`. **PoC PASS, giá 1 LAMP.**
>
> **Chuẩn hoá `r_thấp_điểm` theo `đã_sinh` (không theo `đã_tiêu`) là LOAD-BEARING.** v0.1 chia cho `đã_tiêu`
> ⟹ **tỷ lệ không có thang** ⟹ tiêu **1 nanogic** lúc thấp điểm ăn **trọn 1.5×**. Chia cho `đã_sinh` thì
> muốn ăn trọn phải tiêu THẬT nhiều VÀ đúng giờ.

**Gộp:**
```
tư_cách = Q + ⌊(w_tuổi·r_tuổi + w_tiêu·r_tiêu + w_thấp·r_thấp_điểm + w_cam·r_cam_kết) / Q⌋

w_tuổi = 0.30Q   w_tiêu = 0.90Q   w_thấp = 0.20Q   w_cam = 0.10Q     Σwᵢ = 1.50Q
⟹ tư_cách ∈ [Q, 2.5Q] = [1.00×, 2.50×]
```
Vẫn **ĐÚNG MỘT tham số** (G2 giữ). Bốn yếu tố + hướng đơn điệu anh chốt đều giữ nguyên.

### INV-G4 — công-dân-hạng-nhất thành bất biến SỐ HỌC kiểm được

```
INV-G4:  w_tiêu  >  w_tuổi + w_thấp + w_cam
         0.90Q   >  0.30Q + 0.20Q + 0.10Q = 0.60Q     ✓
```
**Hệ quả (chứng minh, không phải tuyên bố):** người tiêu-thật hoàn toàn (`r_tiêu = Q`, **mọi thứ khác = 0**)
đạt `1.90×`; người **không tiêu** dù **tối đa mọi thứ khác** chỉ đạt `1.60×`.
⟹ **1.90 > 1.60 — người tiêu thật LUÔN thắng người ôm, không có ngoại lệ.**
*(v0.1 §4.5 là bù nhìn: gán cho người ôm `1.0×` ở giờ-thấp-điểm và cam-kết-lịch, trong khi cả hai đều MIỄN PHÍ — người ôm vẫn lấy được.)*

**Ép sàn tường minh** (v0.1 chỉ TUYÊN sàn Q mà không ép ở đâu):
```
tư_cách = max(Q, min(2.5Q, tư_cách_tính_được))
```

### Nguồn `tiêu_thấp_điểm` — giao diện, KHÔNG tự đo

Engine **KHÔNG tự dựng EMA đo cầu** (v0.1 định tái dùng FlowRate dual-EMA — **không dùng được**:
sai granularity (α=Q/3 ⟹ 15 ngày, không phân giải tín hiệu 24h) + sai đại lượng (`math.ts:50` tính GIÁ, không tính CẦU)).

Engine **ĐỌC** nhãn thấp-điểm từ **biểu phí do dịch vụ công bố TRƯỚC** (giao diện dưới). Nguồn thuộc lớp dịch vụ — **ngoài phạm vi MAGIC**.

```
tiêu_thấp_điểm = Σ Δmagic của các delta có cờ thấp_điểm = true
cờ thấp_điểm  ← biểu phí công bố TRƯỚC thời điểm tiêu (tất định, user thấy giá trước khi tiêu)
```
**Chưa có nguồn ⟹ `w_thấp = 0` (tắt hệ số, KHÔNG bịa số).** Bật lại khi có nguồn — **không đổi công thức, chỉ đổi trọng số**.
Khi bật: `Σwᵢ` giữ 1.50Q bằng cách chia lại; INV-G4 phải kiểm lại (test ép).

## §5. Trần toàn cầu (G3)

```
w_v         = ⌊c_v × tư_cách_v / Q⌋                       [LAMP-hiệu-dụng] ← nhân tư_cách TRƯỚC khi floor theo c
W(e)        = Σ_v max(0, w_v)
nhịp_gen(e) = min( NHỊP_TRẦN,
                   min( ⌊nhịp_gen(e−1) × TRẦN_TĂNG / Q⌋,        TRẦN_TĂNG = 1.25Q
                        ⌊ngân_sách_gen(e) × Q / max(W(e−1), 1)⌋ ) )
M_v(e)      = max(1, ⌊w_v × nhịp_gen(e) / Q⌋)
```

**Kiểm thứ nguyên (v0.1 chết đúng ở đây — 2 trục độc lập cùng phát hiện):**
`Σ M_v = Σ w_v × nhịp/Q = W × (B×Q/W)/Q = B` ✓
*(v0.1: `W = Σ(c × tư_cách)` là tích THÔ nên đã mang sẵn một thừa số Q, mà `nhịp_gen` chỉ nhân Q một lần còn
`M_v` chia Q hai lần ⟹ `Σ M_v = ngân_sách/10⁹` — mạng phát đúng **một phần tỷ**.)*

**`max(1, ·)` ở `M_v` ép G1** (v0.1 chỉ "kiểm G1 ✓" — chứng minh hỏng, bỏ qua chính cái floor nó vừa bắt buộc):
`⌊c_v × nhịp/Q⌋ = 0` khi `c_v × nhịp < Q` ⟹ `M_v = 0` với MỌI tư-cách. Vùng chết rộng gấp 1001 lần cho `c=1`
so với `c=1001` — **luỹ thoái, im lặng, đánh đúng đáy phân phối**. G1 là tiên đề ⟹ phải **ÉP**, không phải "kiểm".
Chi phí: ≤ N_vault nanogic/epoch (10⁶ vault = 10⁻³ MAGIC/epoch — không đáng kể). Trừ vào ngân sách TRƯỚC khi tính nhịp.

**`NHỊP_TRẦN` (trần tuyệt đối) thay cho `max(·,1)` làm phòng thủ:**
`max(W,1)` là **kíp nổ**, không phải lớp phòng thủ — nó biến lỗi TO TIẾNG (chia 0 → dừng) thành lỗi
IM LẶNG THẢM HOẠ (mẫu số tụt 10¹⁵ → nhịp nhân 10¹⁵ lần, không một cảnh báo). Van `TRẦN_TĂNG` chặn **TỐC ĐỘ**,
không phải **MỨC** ⟹ phải có trần tuyệt đối riêng.

**Cold-start `e = 0`** (v0.1 để ngỏ): `W(−1)` không tồn tại ⟹ **KHÔNG dùng công thức trên**. Epoch 0 chia
**pro-rata cuối epoch** (`M_v = ⌊ngân_sách(0) × w_v / W(0)⌋`), **công bố trước là "epoch 0 không đoán trước được"**.
Từ `e ≥ 1` dùng `W(e−1)`. Trung thực: đánh đổi tính-đoán-trước **đúng một epoch**, không giấu.

**Phát biểu trung thực G3:** tổng gen **bám** ngân sách theo **trung bình trượt**, có **trần cứng tuyệt đối mỗi epoch**
(`NHỊP_TRẦN`) — **KHÔNG** bằng đúng ngân sách từng epoch. `ngân_sách_gen(e) = f(br_q, gov_params, S, pp_sched)`:
**hàm CHƯA CHỐT** — chặn bởi **D3** (`GlobalState` đã deploy là CDP-pricing 5-field, **KHÔNG có `br_q`**;
inbox CARP `magic-globalstate-brq-FOLLOWUP-2026-07-17.md` chưa hồi). Testnet dùng **fixture**, đánh dấu TẠM.

## §6. Kiến trúc engine

Vault = **1 UTxO** ⟹ per-event on-chain **bất khả thi** (lệch 10⁵ lần trần L1 + hot-UTxO tuần tự hoá).
⟹ **kế-toán off-chain + Merkle-anchor**, 1 anchor tx/provider/epoch. Đọc bằng **`reference_input`** (KHÔNG spend) —
Wakeme-Tech §3.6 gọi là *"điều kiện sống còn"*. Redeemer `GenDrip` chỉ dùng nếu buộc phải spend (đã ép LAMP-preserved).

**Ranh giới tin cậy — nói thẳng:** operator có thể **DoS/giấu** delta; **không thể bịa/sửa** delta đã cosign;
**không thể chối** delta đã anchor. **Cosign chỉ có giá trị khi hai bên ĐỐI KHÁNG lợi ích** — ở đây user và provider
**cùng** hưởng lợi từ khai khống ⟹ cosign **không** chặn được khai khống tư-cách. Chặn thật nằm ở **INV-G4 + trần 2.5×**:
tiêu 1000 MAGIC **không lấy lại nổi bao nhiêu** epoch sau (anh Aladin, 17/7) — wash **tự chết về kinh tế**.

## §7. Bất biến bắt buộc (test phải ép)

| # | Bất biến |
|---|---|
| `INV-G1-mọi-c` | `∀ c ∈ [1,1001], ∀ tư_cách ∈ [Q, 2.5Q] ⟹ M_v ≥ 1` |
| `INV-G4` | `w_tiêu > w_tuổi + w_thấp + w_cam` (0.90 > 0.60) |
| `INV-tổng` | `\|Σ M_v − ngân_sách\| / ngân_sách < 10⁻⁶` với N ∈ {10³, 10⁶, 10⁷} |
| `INV-sàn-trần` | `Q ≤ tư_cách ≤ 2.5Q` với MỌI đầu vào, kể cả `vest_start_slot` ác ý |
| `INV-không-âm` | `tuổi_epoch ≥ 0 ∧ w_v ≥ 0 ∧ W ≥ 0` |
| `INV-vault-thật` | vault không qua đủ 5 bước §3 ⟹ **loại**, không đóng góp vào `W` |
| `INV-cửa-sổ-đối-xứng` | `đã_tiêu` và `đã_sinh` PHẢI đo trên **CÙNG** cửa sổ nửa mở độ dài **6**. Đổi độ dài = đổi biên ổn định vòng toàn cục (bán kính phổ ≤ λ/3 với cửa sổ 6; **phân kỳ tại ρ*>2/3 nếu cửa sổ = 1**). |
| `INV-LAMP-đứng-yên` | gen KHÔNG spend vault, KHÔNG đổi `c`, KHÔNG mint token (G5/G6/I-ACT-7) |

## §8. Pháp lý

1. **MAGIC không chuyển nhượng, không policy-id ⟹ không bán được ⟹ không thể là thu-nhập.**
   *(Hội đồng thử bác qua "đường vòng CARP-settlement" → **BÁC BỎ HOÀN TOÀN**: CARP chảy provider→Treasury, **không có chiều ngược về user**. Lá chắn này ĐỨNG VỮNG.)*
2. **G9 không tích luỹ** ⟹ không có kho để đầu cơ.
3. **Dốc-thưởng thay cổng-cứng**: INV-G4 ⟹ người tiêu-thật **luôn** hơn người ôm.
4. **Tấm-pin G7**: user không bao giờ nhận LAMP ⟹ không có đường rút vốn+lãi.

**Rủi ro còn mở (hội đồng giữ nguyên, phải ghi):** `tuổi_LAMP` thưởng thuần theo thời gian nắm giữ, không đòi hoạt động
— mang **đặc tính lãi-suất-kỳ-hạn**. Đã hạ từ `2.20×` (v0.1, tích) xuống đóng góp tối đa `+0.30×` (w_tuổi = 0.30Q).
**Cần luật sư soát — ngoài phạm vi agent.**
