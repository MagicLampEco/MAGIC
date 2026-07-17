# GenMAGIC — BẢN THIẾT KẾ KHOÁ (v0.1, để hội đồng phản biện)

**Ngày:** 2026-07-17 · **Trạng thái:** DRAFT — chờ hội đồng đánh · **Chủ:** MAGIC-team
**Giải blocker:** Wakeme §3.7-1 / B1 — *"engine Gen ĐỌC số dư on-chain"* (Wakeme giao đích danh MAGIC/CARP-team).

> **Neo chuẩn — CHỈ ba nguồn này. Mọi nguồn khác coi như lỗi thời:**
> 1. `PhoenixKeyDID/Wakeme/spec/PhoenixKey-Wakeme-Math.md` (bất biến I-ACT-1..8b, `gen_drip_ok`)
> 2. `PhoenixKeyDID/Wakeme/spec/PhoenixKey-Wakeme-Tech.md` (datum 7-field, §3.6 kiến trúc scale)
> 3. `PhoenixKeyDID/Wakeme/PhoenixKey-MAGIC-Vault-Scale-Analysis.md` (off-chain accounting + Merkle-anchor)
>
> **ĐÃ CHẾT — không được dùng, không được suy luận từ:** cổng-tiêu-thật (consumption-gate);
> trung-bình-7-epoch `M = Σwᵢ·M(Lᵢ)`; TWAB; UM/UMKeeper; PM/LF/B; profile Ember/Flame/Lantern;
> VacuumGen; halving; InstantGen-kiểu-mua (trả LAMP → Treasury); MAGIC-là-native-token.
> Bản cũ + bằng chứng: `MAGIC/Legacy/stale-genmodel-2026-07/`.

---

## §1. Tiên đề (chốt bởi anh Aladin, KHÔNG lật lại)

| # | Tiên đề | Nguồn |
|---|---|---|
| **G1** | **Chỉ cần NẮM LAMP là sinh được MAGIC.** Không có cổng nào. Cả InstantGen lẫn ScheduleGen. | anh, 17/7 |
| **G2** | **Tư-cách CHỈ nhân vào TỶ-LỆ sinh** — đúng **một** tham số, không phải cổng chặn. | anh, 17/7 |
| **G3** | **Tổng gen MAGIC toàn cầu tại một thời điểm phụ thuộc GreenBack + ScheduleGen.** | anh, 17/7 |
| **G4** | **Công dân hạng nhất = người tiêu MAGIC cho dịch vụ THẬT.** Mọi thiết kế ưu tiên họ. | anh, 17/7 |
| **G5** | **LAMP đứng yên khi gen** (I-ACT-7). Engine chỉ ĐỌC. Không spend, không đốt, không chuyển. | Wakeme Math §5.4 |
| **G6** | **MAGIC = account-trong-Vault.** Không mint token, không policy-id, không chuyển nhượng. | Wakeme Math §3 |
| **G7** | **Nguyên tắc tấm-pin:** LAMP đặt TẠM trong vault, user KHÔNG BAO GIỜ nhận LAMP; LAMP rời vault chỉ về **pot**. | Wakeme, chốt 17/7 |
| **G8** | Mọi tham số phải **điều-tiết cung-cầu** — đẩy hành vi về cân bằng, không thưởng tuỳ tiện. | anh (memory) |
| **G9** | **MAGIC decay = dùng-hay-mất, RESET mỗi epoch** (nguyên tắc **pin mặt trời**). Không phải decay hình-học. | anh, chốt trước |

**Hệ quả G9 (quan trọng — đừng bỏ qua):** MAGIC **không tích luỹ được**. Suất mỗi epoch không tiêu thì **mất**, không cộng dồn.
⟹ (a) không có "kho MAGIC" để đầu cơ ⟹ quỹ đạo cung MAGIC **không phân kỳ** dù `nhịp_gen` sai;
⟹ (b) `đã_tiêu / đã_sinh` mỗi epoch **luôn ≤ 1** ⟹ `tỷ_tiêu` (§4.2) chính là **tỷ-lệ-tận-dụng-suất**, có nghĩa vật lý rõ;
⟹ (c) lá chắn pháp lý §8 **khoẻ thêm**: không chuyển nhượng **và** không tích luỹ ⟹ không thể là tài sản đầu tư.

---

## §2. Đầu vào — engine ĐỌC gì (không sửa gì)

Đọc `ActivationVaultDatum` (Wakeme, **7 field, đúng thứ tự CBOR**) qua **`reference_input`** — KHÔNG spend:

| # | Field | Dùng làm gì trong GenMAGIC |
|---|---|---|
| 0 | `owner_commit` | khoá định danh vault (= vault-NFT name) |
| 1 | `did_commit` | **quy chủ per-DID** — nối lịch-sử-tiêu vào đúng hồ sơ |
| 2 | `vest_start_slot` | **mốc 0** → suy ra tuổi-LAMP |
| 3 | `conditional_lamp` (`c`) | **cơ sở gen** — NGUYÊN-LAMP (1..1001) |
| 4 | `reclaimed_to_pot` (`r`) | (tham chiếu — đã rò vì nhàn rỗi) |
| 5 | `last_tick_day` | (không dùng cho gen) |
| 6 | `last_tick_epoch` | (không dùng cho gen) |

**Bất biến bắc cầu (miễn phí, không cần engine kiểm):** Wakeme đã ép `L(vault) == c × oil_per_lamp`
ở MỌI redeemer ⟹ `c` **không khai man được** — muốn khai `c` cao phải khoá LAMP thật đủ.
⟹ GenMAGIC **không cần** lớp chống-khai-man số dư riêng. *(Đây là chỗ mô hình cũ phải tự dựng, nay Wakeme gánh.)*

**1 DID = 1 vault** (I-ACT-10, vault-NFT singleton name = `owner_commit`) ⟹ **không thể Sybil đa-vault trên cùng DID**.
Sybil đa-DID chặn bởi sinh-trắc Enclave (Wakeme T-3) — **ngoài phạm vi MAGIC**, ghi rõ là giả-định-tin-cậy.

Đọc thêm qua `reference_input` (đọc, không sửa):
- **GreenBack/GlobalState** (CARP-track): `br_q` (tỷ-lệ-bảo-chứng), `gov_params` (`br_safe_q`, `f_max_q`), `S`.
- **ScheduleGen**: `pp_sched` — MAGIC đã cam kết trong hợp đồng lịch.

---

## §3. Công thức sinh — cốt lõi

Mỗi epoch `e`, mỗi vault `v`:

```
M_v(e)  =  ⌊ ⌊ c_v × nhịp_gen(e) / Q ⌋ × tư_cách_v(e) / Q ⌋      [nanogic]
```

- `c_v` = `conditional_lamp` (NGUYÊN-LAMP) — đọc thẳng datum.
- `nhịp_gen(e)` = **nhịp-gen-epoch**, Q-format — công bố ĐẦU epoch (§5).
- `tư_cách_v(e)` = **hệ-số-tư-cách**, Q-format — ĐÚNG MỘT tham số (G2).
- `Q = 10⁹`; `nanogic = MAGIC × 10⁹`; **nhân-chia-floor tuần tự**, KHÔNG gộp một phép (bó sai số/epoch).
- **BigInt bắt buộc** — cấm `Number` (C-OVERFLOW).

**Kiểm G1:** `tư_cách ≥ Q` luôn (sàn 1.0×) ⟹ `c_v > 0` ⟹ `M_v > 0`. **Nắm LAMP là có gen. Không cổng.** ✓
**Kiểm G5:** công thức không chứa biến nào của `c` ở output ⟹ engine không cần spend. ✓

---

## §4. Hệ-số-tư-cách — bốn thành phần (anh chốt 17/7)

```
tư_cách_v(e) = ⌊⌊⌊ tuổi_LAMP × tiêu_thật /Q ⌋ × giờ_thấp_điểm /Q ⌋ × cam_kết_lịch /Q ⌋
```

Tích-nhân (không phải tổng) — cùng khuôn với VP governance (tích ≥4 tham số). Mỗi thành phần **có sàn `Q` (1.0×)** ⟹ tích ≥ Q ⟹ G1 giữ.

### 4.1 `tuổi-LAMP` — LAMP nằm trong vault càng lâu càng nhiều

> anh: *"Cùng nắm một lượng LAMP, LAMP giữ nguyên trong vault lớn hơn 6 epoch sẽ cho MAGIC lớn hơn vault có số epoch ít hơn (xét trên từng epoch để user có thể đo lường)."*

```
tuổi_epoch = ⌊ (slot_now − vest_start_slot) / slots_per_epoch ⌋        (slots_per_epoch = 432_000)
tuổi_LAMP  = Q + min(tuổi_epoch, TRẦN_TUỔI) × BƯỚC_TUỔI
```
- `TRẦN_TUỔI = 24` epoch (~4 tháng), `BƯỚC_TUỔI = 0.05Q` ⟹ dải **[1.00× .. 2.20×]**.
- **Bước theo EPOCH nguyên**, không theo slot ⟹ user tự tính đúng con số, không cần tin engine. ✓ ("để user có thể đo lường")
- **Đơn điệu tăng ngặt theo tuổi tới trần** ⟹ vault >6 epoch **luôn** > vault ít epoch hơn (cùng `c`). ✓
- **Cân bằng tự nhiên:** vault già có `tuổi_LAMP` cao nhưng pha Epochy bào `c` 5 LAMP/epoch ⟹ không tích luỹ vô hạn.

### 4.2 `tiêu-thật` — CÔNG DÂN HẠNG NHẤT (G4), dải RỘNG NHẤT

> anh: *"Nắm cùng 1 lượng LAMP, đều tuổi >6 epoch, nhưng hồ sơ tiêu nhiều MAGIC hơn trong 6 epoch vừa qua sẽ sinh nhiều MAGIC hơn."*

```
cửa_sổ    = [e−6, e)                          (nửa mở — epoch hiện tại KHÔNG tính, chống tự-bơm cuối kỳ)
đã_tiêu   = Σ MAGIC hồ sơ did_commit tiêu thật trong cửa_sổ        [nanogic]
đã_sinh   = Σ MAGIC hồ sơ did_commit được sinh   trong cửa_sổ      [nanogic]
tỷ_tiêu   = min(Q, ⌊ đã_tiêu × Q / max(đã_sinh, 1) ⌋)              (kẹp trần 1.0)
tiêu_thật = Q + ⌊ tỷ_tiêu × TRẦN_TIÊU / Q ⌋                        TRẦN_TIÊU = 1.5Q
```
- Dải **[1.00× .. 2.50×]** — **rộng nhất trong 4** ⟹ tiêu-thật **áp đảo** ôm-giữ. ✓ G4
- **Đo TỶ LỆ, không đo LƯỢNG** ⟹ **cá voi không có lợi thế**; user nhỏ tiêu hết vẫn đạt trần. Đây là chỗ chống "giàu càng giàu".
- **Không cổng:** chưa từng tiêu ⟹ `tỷ_tiêu = 0` ⟹ `tiêu_thật = 1.0×` ⟹ **vẫn sinh**, chỉ mức sàn. ✓ G1
- Hồ sơ mới (`đã_sinh = 0`) ⟹ `tỷ_tiêu = 0` ⟹ sàn. Không chia-cho-0 (`max(·,1)`).
- **Chính là "use-it-or-lose-it"** đã chốt trước đây, nay ở dạng hệ-số thay vì decay.

### 4.3 `giờ-thấp-điểm` — điều-tiết cung-cầu (G8)

> anh: *"Cùng 1 lượng MAGIC đã tiêu trong 6 epoch, hồ sơ có tỷ lệ MAGIC tiêu ở thời điểm thấp điểm sẽ sinh nhiều hơn."*

```
tỷ_thấp_điểm  = ⌊ đã_tiêu_lúc_thấp_điểm × Q / max(đã_tiêu, 1) ⌋     (cùng cửa_sổ [e−6, e))
giờ_thấp_điểm = Q + ⌊ tỷ_thấp_điểm × TRẦN_THẤP_ĐIỂM / Q ⌋           TRẦN_THẤP_ĐIỂM = 0.5Q
```
- Dải **[1.00× .. 1.50×]**.
- **"Thấp điểm" xác định thế nào** — tái dùng **FlowRate dual-EMA** đã có trong repo (commit `5292578d`):
  thấp-điểm ⟺ cầu-tức-thời (EMA-nhanh) **dưới** cầu-nền (EMA-chậm) tại slot tiêu.
  Engine thấy TOÀN BỘ dòng tiêu (§6) ⟹ tính được cầu-mạng, không cần oracle ngoài.
- **Là hệ-số-điều-tiết đúng nghĩa:** ai cũng dồn vào thấp-điểm ⟹ chỗ đó thành cao-điểm ⟹ hết ưu đãi ⟹ **tự cân bằng**. ✓ G8
- `đã_tiêu = 0` ⟹ tỷ = 0 ⟹ sàn 1.0× (không phạt thêm — đã bị `tiêu_thật` phạt rồi, tránh phạt kép).

### 4.4 `cam-kết-lịch` — ScheduleGen

> anh: *"Người có lượng MAGIC trong các hợp đồng ScheduleGen nhiều hơn sẽ được gen nhiều MAGIC hơn."*

```
tỷ_cam_kết  = min(Q, ⌊ magic_cam_kết_đang_hiệu_lực × Q / max(sinh_kỳ_vọng_6_epoch, 1) ⌋)
cam_kết_lịch = Q + ⌊ tỷ_cam_kết × TRẦN_LỊCH / Q ⌋                   TRẦN_LỊCH = 0.5Q
```
- Dải **[1.00× .. 1.50×]**. Cũng đo **tỷ lệ** (chống cá voi), chuẩn hoá theo khả năng sinh của chính hồ sơ.
- Lý do kinh tế: cam-kết-trước = **cầu báo trước** ⟹ engine ước lượng được tải ⟹ hạ bất định (G8).

### 4.5 Bảng dải + thứ tự áp đảo

| Hệ số | Dải | Vì sao dải đó |
|---|---|---|
| **tiêu-thật** | 1.00 – **2.50×** | công dân hạng nhất — **rộng nhất** (G4) |
| tuổi-LAMP | 1.00 – 2.20× | trung thành, nhưng **không được thắng người tiêu thật** |
| giờ-thấp-điểm | 1.00 – 1.50× | điều-tiết cung-cầu |
| cam-kết-lịch | 1.00 – 1.50× | cầu báo trước |
| **tư-cách (tích)** | **1.00 – 12.375×** | — |

**Kiểm G4 (số học):** ôm-giữ tối đa không tiêu = `2.20 × 1.0 × 1.0 × 1.0 = 2.20×`.
Người tiêu-thật hết, thấp-điểm, có lịch, mới 0 epoch tuổi = `1.0 × 2.5 × 1.5 × 1.5 = 5.63×`.
⟹ **người tiêu thật ăn đứt người ôm 2.6 lần dù không có tuổi nào.** ✓ G4

---

## §5. Trần toàn cầu — GreenBack + ScheduleGen (G3)

**Bài toán:** trên eUTXO không cộng được tổng toàn cục on-chain. **Lời giải:** engine là **kế-toán off-chain** (§6) ⟹ **tổng toàn cầu TÍNH ĐƯỢC**.

```
ngân_sách_gen(e) = f( br_q, br_safe_q, f_max_q, S, pp_sched )        ← đọc GreenBack + ScheduleGen
tổng_trọng_số(e) = Σ_v ( c_v × tư_cách_v(e) )                        ← engine cộng off-chain
nhịp_gen(e)      = ⌊ ngân_sách_gen(e) × Q / max(tổng_trọng_số(e−1), 1) ⌋
```

**Vì sao dùng `tổng_trọng_số(e−1)` (epoch TRƯỚC), không phải `e`:**
`nhịp_gen(e)` **công bố ĐẦU epoch e** ⟹ trong epoch, mọi user **tự tính chính xác** `M_v` của mình
(*"để user có thể đo lường"* — anh). Nếu dùng `tổng_trọng_số(e)` thì phải chờ hết epoch mới biết → mất tính đo-lường-được,
và thành **cuộc đua đào** (share của tôi phụ thuộc người khác làm gì trong cùng epoch).

**Đánh đổi phải nói thẳng:** trễ một epoch ⟹ nếu tổng trọng số **tăng vọt** trong epoch `e`, tổng phát **vượt** ngân sách epoch đó.
Vá bằng **hai lớp**:
1. **Van cứng:** `nhịp_gen(e) ≤ nhịp_gen(e−1) × TRẦN_TĂNG / Q` (`TRẦN_TĂNG = 1.25Q`) — chống nhảy bậc.
2. **Bù kỳ sau:** thừa/thiếu epoch `e` trừ/cộng vào `ngân_sách_gen(e+1)` (bộ-điều-khiển tích phân) ⟹ **bám ngân sách trên trung bình dài hạn**, không bám từng epoch.

**⟹ Phát biểu trung thực về G3:** tổng gen **bám** GreenBack+ScheduleGen theo **trung bình trượt**, có **chặn trên cứng theo epoch**
(van 1.25×) — **KHÔNG** phải bằng đúng ngân sách từng epoch. Hội đồng cần đánh giá đánh đổi này.

*(Bỏ ngỏ cho hội đồng: `ngân_sách_gen` từ `br_q`/`pp_sched` theo hàm nào? Chưa chốt — cần CARP xác nhận GlobalState có `br_q` không: `CARP/_Agents/inbox/magic-globalstate-brq-2026-07-16.md` chưa hồi.)*

---

## §6. Kiến trúc engine — off-chain accounting + Merkle-anchor

Theo `PhoenixKey-MAGIC-Vault-Scale-Analysis.md` §5 + Wakeme-Tech §3.6. **Bắt buộc, không tuỳ chọn** — vault là **1 UTxO** ⟹ per-event on-chain **bất khả thi** (lệch 10⁵ lần trần L1 + hot-UTxO tuần tự hoá).

```
TRONG EPOCH (0 giao dịch L1 cho gen):
  reference_input đọc VaultDatum (KHÔNG spend)  ─┐
  dòng tiêu MAGIC có user-cosign                 ├─► sổ off-chain per-shard (single-writer theo hash(did))
  lá = H(did ‖ Δmagic ‖ nonce ‖ cosign ‖ prev)  ─┘   → Lazy-MMR tích luỹ

CUỐI EPOCH (1 giao dịch/provider/epoch):
  anchor Merkle root + net CARP → Treasury  (T-RECONCILE)
```

| Quyết định | Chốt |
|---|---|
| Đọc số dư | **`reference_input`** — KHÔNG spend (Wakeme-Tech §3.6: *"điều kiện sống còn"*) |
| Redeemer `GenDrip` | **chỉ dùng nếu buộc phải spend**; đã ép LAMP-preserved sẵn |
| Ranh giới | **Mosaic = lớp neo (root); MAGIC = lớp kế toán (số dư + cosign + CARP)** |
| Chống gian sổ | user-cosign mỗi delta + hash-chain `prev_commit` + nonce đơn điệu + anchor + bond |
| Chia tải | shard theo `hash(did_commit)` ⟹ số dư 1 DID do **đúng 1** shard giữ ⟹ không race |

**Ranh giới tin cậy (nói thẳng):** operator có thể **DoS/giấu** delta, **KHÔNG thể bịa/sửa** delta đã cosign, **KHÔNG thể chối** delta đã anchor.

---

## §7. Phụ thuộc ngoài — KHÔNG tự quyết (báo, không vá lén)

| # | Phụ thuộc | Chủ | Nếu hỏng thì sao |
|---|---|---|---|
| **D1** | **Registry dịch vụ tiêu tài nguyên thật** (`has_counterparty_consume` — hiện là **placeholder**) | PhoenixKey (blocker **B2**) | **`tiêu-thật` + `giờ-thấp-điểm` bị wash-trade**: user dựng dịch vụ ma, tự "tiêu" cho mình → ăn 2.5×1.5 = **3.75×** miễn phí. **Đây là lỗ hổng NGHIÊM TRỌNG NHẤT của thiết kế này.** |
| **D2** | Uniqueness PersonDID (sinh-trắc Enclave) | PhoenixKey (T-3) | Sybil đa-DID → nhiều vault → né trần |
| **D3** | GlobalState có `br_q`/`gov_params`? | CARP/CarpetMint | `ngân_sách_gen` không tính được (§5) |
| **D4** | GreenBack settlement + `fee_refill_lamp` | PhoenixKey (B4) | MAGIC→CARP không chốt được |

---

## §8. Pháp lý — lá chắn đổi hình, không mất

Whitepaper cũ dùng **cổng-tiêu-thật** làm lá chắn: *"không phải thu-nhập-thụ-động, không phải lãi-suất"*.
Bỏ cổng (G1) ⟹ lá chắn đó mất. **Thay bằng hai lá chắn mạnh hơn:**
1. **MAGIC không chuyển nhượng, không policy-id ⟹ không bán được ⟹ không thể là thu-nhập.** (Mạnh hơn cổng: bản chất tài sản, không phải điều kiện phát.)
2. **Dốc-thưởng thay cổng-cứng:** người ôm chỉ được sàn; người tiêu-thật hơn **2.6×** (§4.5) ⟹ narrative "giữ LAMP ăn lãi" **sai về số học**, không chỉ sai về lời.
3. **Tấm-pin (G7):** user KHÔNG BAO GIỜ nhận LAMP ⟹ không có đường rút vốn+lãi.

⟹ Kết luận pháp lý cũ (khuyến-khích-tham-gia, không phải chứng khoán) **GIỮ**, lập luận **khoẻ hơn**. *(Cần luật sư soát — ngoài phạm vi agent.)*

---

## §9. Việc hội đồng phải đánh (không phải khen)

1. **D1 wash-trade** — `tiêu-thật`+`giờ-thấp-điểm` = 3.75× miễn phí nếu Registry lỏng. Có vá được **trong MAGIC** không, hay buộc chờ B2?
2. **Tích-nhân 4 hệ số** — đúng hay nên tổng-có-trọng-số? Tích cho dải 12.4× — quá rộng? Cá voi/hồ sơ tối ưu có bào được không?
3. **Trễ-một-epoch §5** — van 1.25× + bù kỳ sau có thật sự chặn được vượt-ngân-sách không? Dựng phản ví dụ.
4. **`tỷ_tiêu = đã_tiêu/đã_sinh`** — tự-tham-chiếu (sinh phụ thuộc tiêu, tiêu chuẩn hoá theo sinh). Có hội tụ không? Có điểm bất động lạ không?
5. **`giờ-thấp-điểm` tự-tham-chiếu** — EMA cầu tính từ chính dòng tiêu mà hệ số này điều khiển. Dao động/cộng hưởng?
6. **G4 có thật sự thoả?** — tìm hồ sơ ôm-giữ nào vượt được người tiêu-thật.
7. **Cold-start** — epoch đầu: `tổng_trọng_số(e−1)` = 0, mọi hồ sơ `tỷ_tiêu = 0`. Khởi động thế nào?
8. **Đối chiếu Wakeme** — có chỗ nào vi phạm I-ACT-1..8b, đặc biệt I-ACT-7 và tấm-pin G7?
9. **Pháp lý §8** — lá chắn mới (không-chuyển-nhượng + không-tích-luỹ G9 + dốc-thưởng) có thật sự thay được cổng cũ về LOGIC/SỐ HỌC không? *(Không hỏi ý kiến luật sư — chỉ hỏi lập luận có chặt không.)*
10. **G9 decay reset vs 4 hệ số** — reset mỗi epoch có phá `cam-kết-lịch` (§4.4) không (cam kết MAGIC tương lai trên suất sẽ reset)? Có phá `tỷ_tiêu` cửa-sổ-6-epoch không? Quỹ đạo cung MAGIC dài hạn có bị chặn thật bởi G9 không?
11. **An-ninh sổ off-chain (§6)** — cosign + hash-chain + nonce + anchor + bond có đủ chống operator gian sổ theo 6 phép thử `T-TAMPER/T-DOUBLESPEND/T-RECONCILE` (`PhoenixKey-MAGIC-Vault-Scale-Analysis.md §6.3`)? **CONTRACT chưa định lượng bond + cửa-sổ-fraud-proof — có phải gap thật?**
12. **Vận hành** — operator DoS / từ chối ghi delta / mất khả năng trả CARP cuối epoch: thiệt hại đo được, ai chịu, có **escape-hatch** không? (Wakeme có `ReclaimEpoch` permissionless làm van cuối — GenMAGIC có tương đương chưa?)
