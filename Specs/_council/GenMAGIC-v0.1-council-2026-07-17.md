# Hội đồng GenMAGIC v0.1 — biên bản đầy đủ (wf_3a987c73-76b, 2026-07-17)

> 7 trục · 48 phát hiện · 37 phán quyết đối kháng · 1.744.314 token.
> LƯU Ý: khâu ghép phán quyết↔phát hiện trong script hỏng (so khớp tiêu đề chính xác, refuter thêm tiền tố).
> Vì vậy bản TỔNG HỢP dưới tưởng "đối kháng chưa chạy" — SAI. Phán quyết có thật, chép ở §2.

## §1. Tổng hợp (đọc với cảnh báo trên)

Sau khi đọc CONTRACT đầy đủ + xác minh 3 điểm neo tranh chấp (Wakeme-Math §8 T-3, STATUS.md ma trận blocker), đây là danh sách sửa hợp nhất.

---

# GenMAGIC v0.1 — DANH SÁCH SỬA (tổng hợp 7 trục hội đồng)

## 0. CẢNH BÁO QUY TRÌNH — đọc trước

**Đối kháng CHƯA HỀ CHẠY.** Cả 47 phát hiện đều mang cùng một nhãn `PHÁN ĐỐI KHÁNG: CHƯA qua đối kháng (mức TRUNG/THẤP)` — kể cả các phát hiện NGHIÊM TRỌNG có PoC đã chạy thật. Hệ quả:

- **Mục "đã loại + vì sao" là RỖNG** — không có phát hiện nào bị bác_bỏ_hoàn_toàn, vì không có ai bác. Em không tự bác thay hội đồng đối kháng.
- Nhãn "(mức TRUNG/THẤP)" là **rác template**, không phải phán quyết. Em KHÔNG hạ ưu tiên các mục NGHIÊM TRỌNG/CAO theo nhãn đó — hạ ưu tiên một lỗ đã có PoC PASS chỉ vì một chuỗi ký tự mặc định là sai. Anh cần biết em đã bỏ qua quy tắc "chưa đối kháng → ưu tiên thấp" cho các mục có bằng chứng thực thi, và lý do.
- **Trục `auditor-offchain` trả về 0 phát hiện.** Đây là trục phụ trách đúng §6 — lớp kế toán giữ toàn bộ tiền. Trong khi đó trục `adversary` tìm ra 4 lỗ nặng NGAY TRONG §6 (thiếu chữ ký operator trên lá, bond tĩnh, SPOF engine, mâu thuẫn single-writer). Một trục chuyên trách im lặng trên chính địa hạt của nó, trong khi trục khác đào được 4 lỗ ở đó — đây là tín hiệu trục đó không chạy đúng, không phải tín hiệu §6 sạch. **Đề nghị chạy lại auditor-offchain trước khi đóng hội đồng.**

**Xác minh độc lập của em (3 điểm, đều CONFIRM):**
- `Wakeme-Math.md:281,286` + `STATUS.md:31` → T-3 đúng là lỗ mã-hoá-anchor ĐANG MỞ, KHÔNG phải lá chắn. §2:58 đọc ngược nguồn. **XÁC NHẬN.**
- `STATUS.md:34` → B3 (Registry consume-gate) đội gỡ = **"MAGIC team + backend"**, không phải PhoenixKey. §7 D1 ghi sai chủ. **XÁC NHẬN.**
- Đụng số hiệu blocker: `STATUS.md:33` B2 = CARP policy-id (xuyên-module) vs `STATUS.md:80` B2 = Registry (Wakeme-local). CONTRACT §7 trích "B2" không nói hệ nào. **XÁC NHẬN.**

---

## A. NHÓM 1 — CHẶN BUILD NGAY

Tiêu chí: dev đọc CONTRACT hiện tại rồi build sẽ ra một hệ SAI TIỀN hoặc CHẾT. Phải sửa văn bản trước khi giao.

### F1. Lệch thứ nguyên Q + floor-đầu-tiên nuốt G1 — **2 trục cùng thấy (toán + trò chơi)**
`§3:71` + `§5:171-172` + `§3:80`

Hai trục độc lập dựng cùng một phép tính, ra cùng một kết luận: `Σ M_v = ngân_sách_gen / 10⁹`. `tổng_trọng_số` là tích thô `c × tư_cách` nên đã mang sẵn một thừa số Q; `nhịp_gen` chỉ nhân Q một lần trong khi `M_v` chia Q hai lần. Mạng phát ra đúng một phần tỷ ngân sách.

Kèm theo, cùng 2 trục thấy: `⌊c_v × nhịp_gen/Q⌋ = 0` khi `c_v × nhịp_gen < Q` ⟹ `M_v = 0` với MỌI tư_cách (nhân gì với 0 vẫn là 0). **§3:80 "Kiểm G1 ✓" là chứng minh hỏng** — nó bỏ qua chính cái floor mà §3:77 vừa bắt buộc. Vùng chết rộng gấp 1001 lần cho user `c=1` so với `c=1001` — lũy thoái, im lặng, đánh đúng đáy phân phối. Với công thức như đang viết, cổng này bật NGAY (phản ví dụ: 1000 vault c=1001, B=10⁶ MAGIC ⟹ mọi vault gen 0).

**SỬA:**
1. `§5:172` — chọn 1 trong 2 cấu trúc (**xem mâu thuẫn C2**, quyết định của anh). TUYỆT ĐỐI KHÔNG vá bằng cách thổi `ngân_sách_gen` lên 10⁹ — sẽ lệch 10⁹ theo chiều lạm phát.
2. `§3:80` — XOÁ dấu "✓". Thay bằng mệnh đề có định lượng: `M_v > 0 ⟺ nhịp_gen(e) ≥ ⌈Q/c_v⌉`.
3. G1 là tiên đề anh chốt (§1:22) ⟹ phải **ÉP**, không phải "kiểm": `M_v = max(1, ⌊…⌋)` cho mọi `c_v ≥ 1`, trừ vào ngân sách trước khi tính nhịp_gen. Chi phí ≤ N_vault nanogic/epoch (10⁶ vault = 10⁻³ MAGIC/epoch — không đáng kể).
4. Thêm **BẢNG THỨ NGUYÊN** bắt buộc vào CONTRACT (mỗi đại lượng: đơn vị + thang Q) + test vector chốt cứng `|Σ M_v − ngân_sách| / ngân_sách < 10⁻⁶` cho N ∈ {10³,10⁶,10⁷} và bất biến `INV-G1-mọi-c: ∀ c ∈ [1,1001], ∀ tư_cách ∈ [Q, 12.375Q] ⟹ M_v ≥ 1`.

### F2. §2 "Bất biến bắc cầu — miễn phí, không cần engine kiểm" là SAI — **2 trục + PoC ĐÃ CHẠY**
`§2:53-55`, `§2:74` · auditor-onchain (PoC PASS, aiken 1.1.21, code v5 `3d5fdce`) + critic-legal

`L == c × oil` là bất biến **CHUYỂN-TRẠNG-THÁI**, chỉ được ép KHI VALIDATOR CHẠY. UTxO chưa ai spend thì không validator nào kiểm nó. Địa chỉ vault là script address — ai cũng trả tiền vào được.

Hai biến thể đã verify:
- **(i)** UTxO thuần 2 ADA tại đúng địa chỉ vault, inline datum 7-field bịa `conditional_lamp = 10^12`, KHÔNG NFT, KHÔNG LAMP. Engine "đọc thẳng datum" (§2:74) → c = 10^12 → chiếm 99,98% ngân sách. Đặt `c = 10^24` → `nhịp_gen = 0` → **toàn mạng gen = 0**. Giá: 2 ADA.
- **(ii) Param-substitution — đánh gục cả cách vá "kiểm có NFT đúng policy"** (test `poc1_fake_lamp_policy_genesis_passes` PASS): `lamp_policy` VÀ `anchor_nft_policy` đều là apply-param. Attacker apply-param `lamp_policy = <token rác tự mint>`, `lamp_name = "LAMP"` → `genesis_vault_ok` PASS hoàn hảo → vault tự-nhất-quán với 0 LAMP canonical, 0 DID thật.

**SỬA §2:53** — XOÁ "miễn phí, không cần engine kiểm". Thay bằng NGHĨA VỤ BẮT BUỘC của engine, cho mỗi vault:
1. `address.payment_credential == Script(H_did)` với `H_did` = hash apply-param CANONICAL **tự tính lại** (7 param hằng hệ) — không suy từ datum, không tin địa chỉ tự khai.
2. `quantity_of(value, H_did, owner_commit) == 1`.
3. **TỰ ĐO** `L = quantity_of(value, LAMP_POLICY_CANONICAL, LAMP_NAME_CANONICAL)`; dùng `c_dùng = min(c_datum, L/10⁶)` — **không bao giờ tin c trong datum**.
4. Ép `1 ≤ c ≤ 1001` (biên I-ACT-6 chỉ đúng cho UTxO đã thật sự qua `genesis_vault_ok`).
5. Reject nếu > 1 UTxO thoả (xem F5).

Mắt xích khoá: test "Apply-param determinism: cùng DID → cùng script-hash + address" — `Wakeme-Tech §8:478` đang liệt là **CHƯA CÓ**. Nâng lên BLOCKER.

### F3. `vest_start_slot` không bị ràng buộc ở genesis — **1 trục + 2 PoC ĐÃ CHẠY**
auditor-onchain · `activation_logic.ak:655-703` @3d5fdce ↔ `§4.1:98-99`, `§4:91`, `§5:172,182`

`genesis_vault_ok` KHÔNG có một mệnh đề nào chạm `vest_start_slot`; mint-gate còn không đọc `tx_lo`. `Tech §2.1:121` ("khởi tạo = now") là quy ước BACKEND, không phải bất biến. I-ACT-1 (`Math §4:118`) cũng bỏ sót field này.

- **(a) Tuổi giả miễn phí** (`poc4a` PASS): đặt `vest_start_slot = now − 10.368.000` → `tuổi_LAMP = 2.20×` = TRẦN, ngay lúc vault vừa đúc. §4.1:103 "đơn điệu tăng ngặt theo tuổi" bị vô hiệu hoàn toàn.
- **(b) Kíp nổ siêu lạm phát — 1 vault, 1 LAMP** (`poc4b` PASS): `vest_start_slot = 10^18` → `tuổi_epoch ≈ −2,3×10^12` (§4.1 chỉ kẹp TRÊN, không có `max(0,·)`) → `tuổi_LAMP ≈ −1,16×10^20` → **thủng "sàn Q" mà §4:91 dùng để chứng G1** → `tổng_trọng_số` ÂM → `max(tổng_trọng_số, 1)` trả về **1** → `nhịp_gen = ngân_sách × Q / 1`. Van 1.25× chỉ làm chậm (1,25^73 ≈ 3×10⁷ lần/năm). Vault này **BẤT TỬ**: `days_elapsed` clamp 0 → `n = 0` vĩnh viễn → guard `n ≥ grace_days` của reclaim FAIL mãi mãi → anti-idle không dọn được. Giá: 1 LAMP.

**SỬA — GenMAGIC tự vá được ngay, không chờ PhoenixKey (làm cả 3):**
1. `§4.1:98` — kẹp HAI ĐẦU: `tuổi_epoch = max(0, min(⌊(slot_now − vest_start_slot)/slots_per_epoch⌋, TRẦN_TUỔI))`.
2. `§4:91` — ÉP sàn sau khi nhân: `tư_cách = max(Q, tích_4_thành_phần)`. §4:91 đang **tuyên** sàn Q như một tính chất mà không ép ở đâu.
3. `§5:171` — `tổng_trọng_số(e) = Σ_v max(0, c_v × tư_cách_v)`, thêm **trần tuyệt đối** cho nhịp_gen (van 1,25× là chặn TỐC ĐỘ, không phải TRẦN).

**BÁO PhoenixKey** (Wakeme = backend, không tự sửa — tạo Issue): `genesis_vault_ok` phải ép `d.vest_start_slot == tx_lo` (hoặc ∈ [tx_lo, tx_hi]); bổ sung field này vào khuôn I-ACT-1.

### F4. `max(·, 1)` ở §5:172 là kíp nổ, không phải lớp phòng thủ — **2 trục tới từ 2 đường khác nhau**
toán (cold-start) + on-chain (trọng số âm, F3b)

Mẫu "phòng thủ" kinh điển biến lỗi TO TIẾNG (chia 0 → crash) thành lỗi IM LẶNG THẢM HOẠ: mẫu số tụt từ ~10¹⁵ xuống 1 = nhịp_gen nhân lên ~10¹⁵ lần, không một cảnh báo.

CONTRACT **không định nghĩa** giá trị khởi tạo nào cho `nhịp_gen(−1)`, `tổng_trọng_số(−1)`, `ngân_sách_gen(0)`. §9:249 nêu rồi để ngỏ. Hai nhánh, cả hai hỏng:
- **Nhánh A** (van bỏ qua tại e=0): `nhịp_gen(0) = ngân_sách(0) × Q / 1` → vault đầu tiên nhận **1001× ngân sách**. Sau khi sửa Q (×Q²) thì **10¹²×** — hai lỗi ĐỘC LẬP, sửa F1 làm cold-start nặng thêm 10⁹ lần.
- **Nhánh B** (`nhịp_gen(−1) = 0`): van §5:182 là van NHÂN ⟹ `0 × 1.25 = 0` ⟹ **0 là trạng thái HẤP THỤ, hệ không bao giờ sinh được MAGIC, vĩnh viễn.** Và điều này KHÔNG chỉ ở cold-start — 0 là hấp thụ ở MỌI thời điểm (xem F6: ngân sách âm → kẹp 0 → hệ chết ở epoch 2 của đời thật).

**SỬA:**
1. `§5:172` — XOÁ `max(·,1)`. Nhánh tường minh: `nếu tổng_trọng_số(e−1) == 0 thì nhịp_gen(e) = NHỊP_GEN_KHỞI_TẠO` — hằng số **được quản trị**, hiệu chuẩn từ `ngân_sách(0)` + trọng số dự kiến cohort đầu, **chốt trong CONTRACT** (không để dev đoán).
2. `§5:182` — van phải có SÀN: `nhịp_gen(e) ≤ max(NHỊP_GEN_SÀN, nhịp_gen(e−1) × TRẦN_TĂNG/Q)`, `NHỊP_GEN_SÀN > 0`. Xoá trạng thái hấp thụ tại 0.
3. Test vector cold-start bắt buộc: `W(−1)=0, ngân_sách(0)=10¹⁵ ⟹ Σ M_v(0) ≤ 10¹⁵ ∧ nhịp_gen(0) > 0`.

### F5. Van 1.25× GÁC SAI BIẾN — §5:185-186 "chặn trên cứng" là SAI — **2 trục cùng thấy (toán + pháp-lý/phản-biện)**
`§5:180-186`

Với công thức đã sửa: `G(e) = ngân_sách(e) × W(e)/W(e−1)`. **Độ vượt ngân sách = ĐÚNG BẰNG tỷ số tăng trọng số w(e).** `nhịp_gen` KHÔNG nằm trong biểu thức đó. Tệ hơn: `nhịp_gen ∝ 1/W(e−1)` ⟹ khi W tăng vọt, nhịp_gen **GIẢM** ⟹ van (chỉ chặn chiều TĂNG) **không bao giờ kích hoạt trong đúng kịch bản nó sinh ra để chặn**. Van chỉ bind khi W SỤT hoặc ngân sách tăng — tức đúng lúc KHÔNG có nguy cơ.

Phản ví dụ (van đứng yên 1.00 suốt): 1000 vault bật `giờ_thấp_điểm` + `cam_kết_lịch` (hai hệ số nhảy 1.0→1.5 trong ĐÚNG MỘT epoch) ⟹ w = 2.25 ⟹ **225% ngân sách**. Thêm 9000 vault mới ⟹ w = 11.25 ⟹ **1125% ngân sách trong MỘT epoch**. Nếu cộng lỗ §4.4 (F7, hồ sơ mới ăn 1.5× miễn phí) ⟹ **1575%**. Van vẫn 1.00, không chạm.

§5:183 "bù kỳ sau" KHÔNG cứu được: dưới G9, toàn bộ MAGIC đó đã bị TIÊU trong chính epoch e, đổi lấy dịch vụ thật. Trừ vào `ngân_sách(e+1)` không hoàn lại được bảo chứng đã bị rút.

**SỬA — phải hỏi anh Aladin (quyết định chiến lược, xem S4):** đề xuất hội đồng là **ration TRỌNG SỐ, không ration NHỊP** — giữ công bố `nhịp_gen(e)` đầu epoch làm **TRẦN** (giữ nguyên tính đo-lường-được anh yêu cầu), chốt sổ cuối epoch theo pro-rata cứng:
`M_v(e) = ⌊ M_v_thô(e) × min(Q, ⌊ngân_sách(e) × Q / max(G_thô(e),1)⌋) / Q ⌋`
⟹ `Σ M_v(e) ≤ ngân_sách(e)` **theo TỪNG epoch, chứng minh được**. User biết cận TRÊN đầu epoch, biết chính xác cuối epoch. Bỏ hẳn van 1.25×.
Bắt buộc kèm: **sửa §5:185-186** — một ràng buộc bảo chứng (br_q/GreenBack) là điều kiện **khả-thanh-toán TỨC THỜI**, không phải ràng buộc trung bình. "Bám ngân sách trên trung bình trượt" đối với bảo chứng chính là **dự-trữ-một-phần**.

### F6. Bộ tích phân "bù kỳ sau" — phân kỳ khi w ≥ 2, sinh NGÂN SÁCH ÂM sau ĐÚNG 1 epoch
`§5:183` · toán (1 trục, nhưng là hệ quả trực tiếp của F5 mà 2 trục cùng thấy)

Hình thức hoá: `u(e+1) = b − u(e)·(w(e)−1)`. Bộ tích phân THUẦN, gain = 1, trễ 1 bước, **không anti-windup, không kẹp âm, không giảm gain**. Ổn định ⟺ `|w−1| < 1` ⟺ **w < 2**. Nhưng F5 cho thấy w = 2.25 đạt được bằng **hành vi hợp lệ**, w = 11.25 với vault mới.

Lỗi chí mạng đến TRƯỚC cả phân kỳ: một epoch w > 2 ⟹ `u(e+1) < 0` ⟹ `nhịp_gen` ÂM ⟹ **M_v ÂM ⟹ số dư MAGIC ÂM**. Aiken `Int` là số nguyên có dấu vô hạn — nhận âm không kêu; sổ §6 cũng không có bất biến chặn. Nếu kẹp về 0 → rơi thẳng vào bẫy van-nhân (F4 nhánh B) → **hệ chết ở epoch 2**. Nếu kẹp `u = 0` → dao động chu-kỳ-2 vĩnh viễn biên độ 100%: một epoch siêu phát, một epoch cả mạng gen = 0 (G1 vỡ định kỳ).

**SỬA:**
1. Kẹp cứng tại nguồn: `ngân_sách_gen(e) = max(0, ngân_sách_nền(e) − nợ_luỹ_kế(e))` + bất biến `M_v ≥ 0 ∀v`. Số dư MAGIC âm phải là điều **KHÔNG BIỂU DIỄN ĐƯỢC**, không phải "chắc không xảy ra".
2. Giảm gain + anti-windup: `nợ(e+1) = ⌊(nợ(e) + Err(e)) × K_I / Q⌋`, `K_I ≤ 0.25Q`, kẹp `nợ ≤ 0.5 × b` ⟹ ổn định tới w < 5.
3. **Gốc rễ:** nếu chọn ration-pro-rata (F5) thì `w ≤ 1` ở đầu ra ⟹ `Err(e) ≤ 0` luôn ⟹ toàn bộ lớp bất ổn này **biến mất**. Đây là lý do nên chọn ration thay vì van.
4. CONTRACT phải ghi biên ổn định tường minh `|K_I·(w_max−1)| < 1` + test vector `w=3 sustained ⟹ ngân_sách ≥ 0 ∧ nhịp_gen > 0 ∀e ≤ 50`.

### F7. `sinh_kỳ_vọng_6_epoch` (§4.4:143) KHÔNG ĐƯỢC ĐỊNH NGHĨA — phá P8 — **2 trục cùng thấy (toán + tối-giản)**
`§4.4:143` — dùng làm mẫu số nhưng không có trong §2, §3, §5. Hai cách đọc, **cả hai đều hỏng, khác kiểu**:

- **Đọc TIẾN** (nghĩa đen "kỳ vọng"): **tự-tham-chiếu thứ BA** — và khác hai cái §9 đã liệt (§9.4, §9.5 là hồi tiếp CÓ TRỄ, giải được bằng lặp theo epoch). Cái này là **vòng ĐẠI SỐ TRONG CÙNG MỘT EPOCH**, không có trễ để gỡ. Nghiệm tồn tại duy nhất `x = (1 + √(1 + 2K/E₀))/2` — nhưng CONTRACT không ghi phương trình, không ghi nghiệm-thức, không ghi lược đồ lặp, không ghi dung sai. Với căn bậc hai trong số nguyên Q-format, Aiken và TS **chắc chắn lệch** ⟹ vi phạm trực diện **P8 (bit-identical)** — bất biến cấp giao thức theo CLAUDE.md. Trục tối-giản dựng độc lập cùng kết luận: hai implementer đọc khác nhau ⟹ lệch **4.5% MAGIC** cho cùng một DID.
- **Đọc LÙI** (= `đã_sinh`): hết vòng đại số, NHƯNG `max(·,1)` cho hồ sơ mới (`đã_sinh = 0`) ⟹ `tỷ_cam_kết = Q` **ngay lập tức** ⟹ **cam_kết_lịch = 1.5× MIỄN PHÍ cho mọi hồ sơ mới chỉ cần cam kết 1 nanogic (10⁻⁹ MAGIC)**. Đây là cổng-mở cho w-spike ở F5 (9000 vault mới vào ở 1.5× thay vì 1.0× ⟹ w từ 11.25 lên 15.75).

**SỬA — chọn cách đọc là việc của anh, không phải của dev.** Khuyến nghị hội đồng: **cách đọc LÙI**, vì cách TIẾN đưa một vòng đại số vào giữa một công thức tiền, đổi lấy gần như không lợi ích kinh tế nào.
- Nếu LÙI: đổi tên `sinh_kỳ_vọng_6_epoch` → `đã_sinh` (một tên, một nghĩa), VÀ vá: `tỷ_cam_kết = (đã_sinh == 0) ? 0 : min(Q, ⌊K×Q/đã_sinh⌋)` ⟹ hồ sơ mới về sàn, đối xứng với §4.2:120. Ghi rõ ở §4.5 rằng `tiêu_thật` và `cam_kết_lịch` **chia chung mẫu số** ⟹ **không độc lập** (bảng §4.5 đang giả định độc lập).
- Nếu TIẾN: CONTRACT PHẢI có đủ 4 thứ — (a) phương trình ẩn tường minh, (b) nghiệm đóng, (c) **một** cài đặt isqrt chuẩn dùng chung hai phía, (d) test vector ≥5 điểm gồm 2 biên kẹp. Thiếu bất kỳ thứ nào thì P8 không giữ.
- Trước mắt tag `§4.4:143` **[NEEDS-EVIDENCE]** — đừng để dev đọc rồi tự đoán.

### F8. §4.5 "Kiểm G4 (số học)" dựng trên idler bù nhìn — và §8 lá chắn (2) đứng trên chính con số sai đó — **3 trục cùng thấy**
`§4.5:159-161`, `§8:234` · adversary + game-theorist + critic-legal

Ba trục độc lập tấn công cùng một ô, ra ba con số khác nhau (vì giả định khác nhau về hệ số miễn phí nào idler nhặt), nhưng **cùng một kết luận: con số 2.20× ở §4.5:159 là bù nhìn.**

| Trục | Idler tối ưu thật | Cách dựng |
|---|---|---|
| critic-legal | **3.30×** | + cam_kết_lịch (§4.4 không ràng gì vào tiêu_thật) |
| game-theorist | **4.95×** | + cam_kết 1.5× + giờ_thấp_điểm 1.5× (tiêu bụi ở thấp điểm) |
| adversary | **5.32×** | như trên + tiêu_thật nhích lên 1.075× nhờ tiêu bụi |

So với hình mẫu "công dân hạng nhất" mà §4.5 dựng (5.625×): **5.32/5.625 = 94.6%**. Biên bảo vệ G4 mà CONTRACT khoe **"2.6 lần" thực tế là 1.06 lần**. Game-theorist còn dựng được kịch bản **idler THẮNG người tiêu thật**: ôm-tối-ưu 4.95× vs người tiêu thật có cầu K/M = 10% và không canh giờ = 4.74× — **và người tiêu thật là bên DUY NHẤT trả tiền**. Ngưỡng gãy tổng quát: **mọi người tiêu thật có K/M < 13.3% đều thua người ôm.** CONTRACT không có bất kỳ lập luận nào cho thấy hệ nằm ngoài vùng đó.

§4.5 còn lệch chiều thứ hai: nó cho người tiêu "mới 0 epoch tuổi", nhưng `tuổi_epoch` là **đồng hồ treo tường** (§4.1:98) — tự chạy cho mọi vault, miễn phí, trần 120 ngày. Không ai "chọn" trẻ. Ở trạng thái dừng, `tuổi_LAMP = 2.20` cho TẤT CẢ.

**SỬA:**
1. **VIẾT LẠI §4.5:159-161** — so **cùng tuổi**, và so với **idler TỐI ƯU**, không phải idler bù nhìn. Nếu biên mới không chấp nhận được thì chỉnh DẢI, đừng chỉnh cách trình bày.
2. Thêm **"kiểm G4 CHÉO cohort"** (xem F13) — kiểm hiện tại chỉ hợp lệ trong cùng cohort.
3. Bảng §4.5:149-157: ghi rõ 4 dải là dải **BIÊN**, KHÔNG độc lập. `tiêu_thật` là hàm **GIẢM** theo tích 3 hệ số kia (vì `đã_sinh` chứa đúng tích đó). Bằng chứng số: **thưởng tuổi rao 2.20× — thực giao 1.77×** (user già đẩy M lên → ρ = T/M xuống 0.549→0.310 → tiêu_thật xuống 1.823→1.465 → nuốt mất phần thưởng tuổi). Trần 12.375× chỉ đạt tại ρ*=1, tức **cầu thật ≥ 12× mức sinh nền** — với mọi user cầu hữu hạn, đỉnh dải **không tới được**. Thêm cột "thực nhận tại ρ*≈0.55".
4. **§8:234 phải BỎ dựa vào con số "2.6 lần"** — lá chắn pháp lý không được đứng trên số học sai. Lá chắn 1 (không chuyển nhượng) và 3 (tấm-pin) tự đứng được; **lá chắn 2 hiện KHÔNG đứng được**.
5. Nếu rao với user "giữ LAMP 24 epoch → 2.2×" mà thực giao 1.77× — đó là rủi ro pháp lý/uy tín. **Con số công bố phải là con số thực giao.**

### F9. `giờ_thấp_điểm` là tỷ-lệ KHÔNG THANG — tiêu 1 nanogic ăn trọn 1.5× — **2 trục hội tụ về CÙNG MỘT công thức sửa**
`§4.3:128-129,136`

`tỷ_thấp_điểm = đã_tiêu_lúc_thấp_điểm / max(đã_tiêu, 1)` — mẫu số là **chính đã_tiêu** ⟹ hệ số **bất biến theo quy mô**. Tiêu 1 nanogic lúc 3h sáng = tiêu 600 MAGIC lúc 3h sáng = 1.50×. §4.3:136 tự khai đây là CỐ Ý ("tránh phạt kép"). Ý định đúng, hệ quả sai: **bậc nhảy 0.50× giữa 0 và 10⁻⁹ MAGIC.** Toàn bộ +50% nằm trên một hạt bụi. ROI: 1 nanogic đổi lấy ~0.5 × M_v nanogic/epoch = **2,5×10⁹ lần/epoch**.

**Hai trục đề xuất hai công thức, hoá ra ĐỒNG NHẤT** — tín hiệu rất mạnh:
- adversary: `Q + ⌊tỷ_thấp_điểm × tỷ_tiêu × TRẦN/Q²⌋`
- game-theorist: `tỷ_thấp_điểm = min(Q, ⌊đã_tiêu_thấp_điểm × Q / max(đã_sinh,1)⌋)`
- Khai triển: `(đã_tiêu_thấp/đã_tiêu) × (đã_tiêu/đã_sinh) = đã_tiêu_thấp/đã_sinh`. **Cùng một thứ.**

**SỬA §4.3:128** — chuẩn hoá mẫu số về `đã_sinh`: `tỷ_thấp_điểm = min(Q, ⌊đã_tiêu_lúc_thấp_điểm × Q / max(đã_sinh, 1)⌋)`. Bot 5%: 1.025× thay vì 1.50×. Người tiêu 95% ở cao điểm: vẫn 1.00×. Idler tối ưu tụt 5.32 → 3.63×. **Đây KHÔNG phải phạt kép** — phạt kép là trừ lần nữa; cái này chỉ giới hạn phần thưởng theo quy mô đóng góp. Sửa §4.3:136 cho khớp.

### F10. §4.3:132-133 "tái dùng FlowRate dual-EMA đã có trong repo" — SAI SỰ THẬT, sai ba tầng
`§4.3:132-133` · toán, đối chiếu code thật `FlowRate/offchain/src/math.ts`, `types.ts`

1. **Sai granularity 120×.** `updateFlowRate` là hàm **mỗi-EPOCH** (`math.ts:41` chú thích; `math.ts:47` guard `if (flow.epoch <= datum.last_epoch) return datum` — chặn cứng >1 mẫu/epoch). Đầu vào `EpochFlow` (`types.ts:16-19`) là TỔNG toàn epoch. **1 mẫu / 432.000 slot = 1 mẫu / 5 ngày.** §4.3 cần phân loại TỪNG SLOT. ⟹ user tiêu lúc 3h sáng và user tiêu lúc 20h tối nhận **CÙNG MỘT GIÁ TRỊ**. Hệ số 1.5× thành hằng số toàn mạng, mang **0 thông tin**.
2. **Sai đại lượng — ĐẢO DẤU.** `math.ts:50`: `unclamped_raw = total_lamp_oildrop × Q / total_magic_ng` — đây là **GIÁ (LAMP/MAGIC)**, không phải cầu. Giá GIẢM khi cầu MAGIC TĂNG. ⟹ cầu tăng gấp đôi (cao điểm thật) → raw giảm nửa → ema_fast < ema_slow → §4.3:133 phân loại là **"THẤP ĐIỂM" ⟹ thưởng 1.5× cho người tiêu đúng lúc cao điểm nhất.** Đảo ngược hoàn toàn G8. Grep toàn module FlowRate: **0 kết quả** cho off-peak/peak/slot/demand.
3. **Hằng số thời gian sai 240×.** `ALPHA_FAST_Q = Q/3` ⟹ ~3 epoch = 15 ngày; `ALPHA_SLOW_Q = Q/12` ⟹ 60 ngày. "Giờ thấp điểm" có chu kỳ 24h. **Nyquist: 1 mẫu/5 ngày ⟹ tần số cao nhất phân giải được có chu kỳ 10 ngày. Tín hiệu 24h bị chồng phổ 240×.** Không có cách chỉnh tham số nào sửa được — thiếu MẪU, không thiếu lọc.
4. **Cold-start thừa hưởng:** `MIN_MAGIC_EPOCH = 1000 MAGIC` (`math.ts:12`) → dưới ngưỡng EMA **đóng băng**; từ `HARD_FLOOR_Q = 10⁷` leo +25%/epoch cần **21 epoch = 105 ngày** mới hội tụ. CONTRACT không nhắc.

**SỬA §4.3:132-133 — XOÁ khẳng định.** "Đã có trong repo" là sai sự thật; cái có trong repo giải bài toán khác. Ghi thẳng là hạng mục **CHƯA CÓ**, tag `[NEEDS-EVIDENCE]`. Nếu giữ hệ số này thì phải đặc tả bộ đếm MỚI: (a) đại lượng = **cầu** (`Σ nanogic tiêu / bucket`), không phải giá; (b) bucket ≤ 1h ⟹ ≥ 120 mẫu/epoch; (c) EMA-chậm nắm CHU KỲ NGÀY (≥24 bucket), không phải xu thế 60 ngày; (d) khởi tạo tường minh. **Chi phí phải nói thẳng:** sổ §6 phải giữ + neo thêm **≥120 bucket cầu/epoch** — hạng mục kiến trúc mới, §6 chưa tính. → **Xem quyết định S3.**

### F11. §2:58 đọc NGƯỢC nguồn T-3 — phòng tuyến chống Sybil DUY NHẤT của §2 là một trích dẫn nói điều ngược lại — **1 trục, em ĐÃ XÁC MINH**
`§2:58`, `§7 D2:223`

CONTRACT §2:58: *"Sybil đa-DID chặn bởi sinh-trắc Enclave (Wakeme T-3) — ngoài phạm vi MAGIC, ghi rõ là giả-định-tin-cậy."*

Nguồn nói **chính xác điều trái lại** (em đã đọc trực tiếp):
- `Wakeme-Math.md:281` — *"Lỗ ở tầng **mã hoá anchor** (KHÔNG phải sinh trắc): GenesisPerson đúc được anchor did-string bất kỳ với controller của attacker vì HW_Key P-256 KHÔNG verify on-chain. **N anchor-giả → N×D LAMP rút khỏi pot.** Trạng thái: NGOÀI phạm vi vault; chờ PA2 land."*
- `Wakeme-Math.md:286` — *"T-3 là lỗ ANCHOR-uniqueness (mã hoá), KHÔNG phải lo ngại sybil-sinh trắc — lỗ nằm ở anchor did-string không ràng khoá gốc."*
- `Wakeme-Math.md:301` — GV1/PA2 mức **CAO**, yêu cầu *"đóng lỗ đúc-anchor-did-bất kỳ ... **TRƯỚC khi mở GetLAMP-PersonDID production**"*.
- `STATUS.md:31` xác nhận: PA2 *"Đóng hẳn CID-1 (giả mạo anchor did-string — **KHÔNG phải sybil-sinh trắc**)"*.

⟹ CONTRACT biến một **BLOCKER ĐANG MỞ mức CAO** thành một "giả-định-tin-cậy đã có người lo". Đây không phải khác biệt diễn đạt — nó **đảo ngược trạng thái rủi ro**, và nó là phòng tuyến DUY NHẤT §2 đưa ra cho câu hỏi Sybil.

Sát thương: 10.000 anchor giả → 10.010.000 LAMP rút khỏi pot (Wakeme tự tính) + mỗi vault giả chạy hồ sơ ôm-tối-ưu 4.95× ⟹ chiếm 0,87% ngân sách MAGIC; **tuyến tính** ⟹ 10⁶ anchor giả → ~46% ngân sách. Và vì MAGIC vault giả BAY HƠI (G9), đây là **griefing đốt-ngân-sách thuần** — attacker không cần thu lợi, chỉ cần pha loãng người thật.

**SỬA:**
1. **§2:58 — XOÁ mệnh đề.** Thay bằng nguyên trạng nguồn: *"Uniqueness PersonDID hiện là **BLOCKER MỞ mức CAO** (Wakeme-Math:281 T-3, :301 GV1/PA2) — lỗ ở tầng MÃ HOÁ ANCHOR; **sinh trắc KHÔNG đóng được lỗ này**. Nguồn yêu cầu PA2 land TRƯỚC khi mở GetLAMP-PersonDID production. GenMAGIC KHÔNG được giả định uniqueness cho tới khi PA2 land."*
2. **§7 D2** — nâng từ "phụ thuộc" lên **điều kiện chặn phát hành**: GenMAGIC không lên mainnet trước PA2.
3. **Vá bù trong phạm vi MAGIC:** vì phần lớn thiệt hại đến từ 3 hệ số miễn phí (F7, F9, F8), mọi vá đó hạ giá trị mỗi DID giả từ 4.95× xuống 1.00× ⟹ **giảm lợi ích Sybil 4,95 lần mà không cần đợi PA2**. Đây là lý do độc lập, đo được, để làm các vá kia trước.
4. **Rà toàn bộ CONTRACT tìm trích dẫn khác đọc ngược nguồn** — một lỗi loại này đã lọt thì phải giả định còn nữa.

### F12. §7 D1 sai chủ, chờ nhầm cửa, thiếu cạnh D1→D4 — và con số thiệt hại sai — **2 trục cùng thấy**
`§7:222,225`, `§4.2:112` · adversary (2 phát hiện) + critic-legal

**(a) SAI CHỦ — em đã xác minh.** §7 D1 ghi "Chủ = PhoenixKey (blocker B2)". `STATUS.md:34` ghi chủ B3 (Registry consume-gate) = **"MAGIC team + backend"**. **MAGIC đang chờ CHÍNH MÌNH.** Thêm: số hiệu blocker đụng nhau giữa 2 hệ đánh số (`STATUS.md:33` xuyên-module B2 = CARP policy-id; `STATUS.md:80` Wakeme-local B2 = Registry). CONTRACT trích "B2" không nói hệ nào.

**(b) B2 KHÔNG VÁ ĐƯỢC D1 — lỗi phạm trù.** `has_counterparty_consume` là hàm Aiken trả **Bool**, per-NGÀY, trong tx Reclaim, mục đích: "∃ counterparty_did ≠ owner ⟹ active ⟹ Reclaim REJECT". §4.2 cần: (i) TỔNG nanogic trên [e−6,e), (ii) SLOT-timestamp từng sự kiện, (iii) trọng số thực-tài-nguyên. **B2 dù land 100% cũng không đẻ ra thứ nào trong ba thứ đó.** Tệ hơn: B2 land xong, wash VẪN chạy — chỉ cần DID thứ hai đồng loã làm counterparty ⟹ `counterparty_did ≠ owner` ⟹ Bool = True ⟹ cổng mở ⟹ 12.375× nguyên vẹn. Chi phí bổ sung của attacker sau khi B2 land: **một lần bắt tay.**

**(c) Con số 3.75× SAI — thật là 12.375×.** §7 D1 đếm thiếu `cam_kết_lịch` (1.5×, §4.4 không có điều kiện counterparty nào) và `tuổi_LAMP` (2.2×, washer cũng già đi). `2.20 × 2.50 × 1.50 × 1.50 = 12.375×` = **ĐÚNG BẰNG trần tuyệt đối §4.5:157**. Washer đạt trần thiết kế với chi phí ≈ 0.

**(d) Mô tả thiệt hại SAI ⟹ ưu tiên vá đặt sai.** §5:172 chuẩn hoá pro-rata ⟹ wash **KHÔNG lạm phát cung**. Thiệt hại thật là: (i) cướp phần người ngay trong giai đoạn quá độ (5% hồ sơ wash ⟹ chiếm 11.93% ngân sách ⟹ **hệ số vượt phần 2.39×**; người ngay MẤT 119.300 MAGIC/epoch, ≈8,7 triệu/năm, **mất VĨNH VIỄN theo G9**); (ii) **sụp tín hiệu** — ở cân bằng Nash ai cũng wash ⟹ 4 hệ số triệt tiêu trong chuẩn hoá ⟹ mọi người về đúng chỗ cũ, cả mạng nuôi bot + shell ⟹ **mất trắng thuần tuý, §4 thành no-op**, và 4 hệ số trở thành **thuế đánh vào người không biết lập bot**.

**(e) Bảng chống-gian-sổ §6:211 VÔ QUAN với D1.** `Scale-Analysis:89 (C-A)` nói rõ cosign để chống "operator bịa user tiêu X" — mô hình **operator ác ↔ user ngay**. Wash-trade là **operator ≡ user**. Attacker tự ký cho chính mình ⟹ cosign hợp lệ tuyệt đối. Mọi dòng (cosign / hash-chain / nonce / anchor) đều ĐÚNG và đều KHÔNG CHẠM D1.

**(f) `đã_tiêu` đếm MAGIC KHAI, không đếm CARP ĐÃ QUYẾT TOÁN** (§4.2:112). Chữ "tiêu **thật**" trong tên hệ số là **sai tên** — nó đo lời khai đã ký, không đo giá trị đã chuyển. Đây là mắt xích biến D1 từ "khó" thành "miễn phí", và nó là mắt xích **MAGIC TỰ NẮM** (§6:210 tự chốt "MAGIC = lớp kế toán").

**SỬA:**
1. **§7 D1 — sửa NGAY:** chủ = **MAGIC-team** (đối chiếu STATUS.md:34); ghi rõ hệ đánh số blocker; **thêm cạnh D1→D4** (cạnh phụ thuộc load-bearing đang thiếu — mức nghiêm trọng của D1 là **hàm của D4**, không phải của D2/B2).
2. **Tách D1 làm hai việc khác chủ:** (D1a) chống-wash = chi-phí-không-thu-hồi → **MAGIC tự làm trong §6**; (D1b) chuẩn dịch vụ/chất lượng → Registry-team. **Chỉ D1b mới thật sự chờ.**
3. **Sửa con số:** 3.75× → **12.375×**. Sửa mô tả thiệt hại: không phải lạm phát mà là tái phân phối + sụp tín hiệu.
4. **Thêm mục "mô hình đe doạ" vào §6:** ghi thẳng bảng chống-gian-sổ chỉ phủ operator-ác-user-ngay; **KHÔNG có dòng nào chạm đồng loã user+operator**. Cần cột riêng.
5. **§4.4:** bắt buộc counterparty của hợp đồng lịch ≠ owner_commit VÀ provider bonded; chưa có Registry ⟹ `cam_kết_lịch` **KHOÁ ở sàn 1.0×**. Thà mất chức năng còn hơn cho không 1.5×.
6. **D1a — vá lõi (xem S6, cần anh quyết vì đụng D4):** `đã_tiêu` chỉ tính lá có CARP tương ứng **ĐÃ quyết toán về Treasury và đã final (k=5)**. Khi đó wash tốn 1 CARP thật/1 MAGIC, tiền đi vào Treasury (đích cứng), tự-giao-dịch không lấy lại được ⟹ **vòng lặp âm tiền tuyệt đối ⟹ wash chết về kinh tế, không cần Registry**. Hệ quả kỹ thuật: dời cửa sổ §4.2 sang **[e−7, e−1)** (giữ nguyên ĐỘ DÀI 6 — xem mâu thuẫn C4).
7. Nếu không làm (6): **đổi TÊN** `tiêu_thật` → `tiêu_khai`. Tên hiện tại khiến hội đồng và người đọc tin có một tính chất mà hệ không ép.
8. Đẩy `magic-globalstate-brq-2026-07-16.md` (§5:188 ghi CARP chưa hồi) lên **ưu tiên cao nhất** — nó chặn không chỉ `ngân_sách_gen` mà cả đòn chống-wash duy nhất khả thi.

---

## B. NHÓM 2 — SỬA TRƯỚC MAINNET

### F13. I-ACT-10 "1 DID = 1 vault" KHÔNG TỒN TẠI on-chain — **PoC ĐÃ CHẠY**
`§2:57` · auditor-onchain · `poc2_two_vaults_same_did_both_pass` PASS

`genesis_vault_ok` ép `owner_commit == did_commit == name` **BẰNG NHAU** — nó KHÔNG ép **DUY NHẤT**. Không one-shot UTxO, không uniqueness thread, không đọc state. Chính `Math.md:205` tự bác lại tuyên bố ở `Math.md:130`, và comment trong code (`activation_logic.ak:282-284`) nói y hệt. Gate duy nhất là precondition **BACKEND** `VAULT_ALREADY_EXISTS` — off-chain, giả-định-tin-cậy. Và genesis KHÔNG kiểm LAMP đến TỪ POT ⟹ tự cầm LAMP của mình đúc vault, permissionless, không cần backend.

Sát thương 2 lớp: (1) engine code theo §2:57 đọc MỘT vault — vault nào? không định nghĩa; tử số gom cả 10 vault, mẫu số 1 vault ⟹ `tỷ_tiêu` bị kẹp 1.0 ⟹ **tiêu_thật = 2.50× trần miễn phí**. (2) **THỪA HƯỞNG HỒ SƠ:** 3/4 thành phần là per-DID (5.63×), chỉ tuổi-LAMP per-vault ⟹ vault #11 đúc hôm nay ăn NGAY 5.63×. **Ghép với F3a (vest_start_slot lùi 24 epoch → 2.20×): vault mới toanh đạt 12.375× = ĐÚNG TRẦN TUYỆT ĐỐI, ngay từ epoch đầu.**

**SỬA §2:57** — hạ "1 DID = 1 vault" từ BẤT BIẾN xuống **GIẢ-ĐỊNH-TIN-CẬY off-chain**; đưa vào §7 cạnh D2 (chủ: PhoenixKey backend). Engine PHẢI gom **TẤT CẢ** vault theo `did_commit` — tuyệt đối không giả định 1. Cân nhắc: tính tư_cách **per-DID** rồi áp cho `Σ c_v` của DID, thay vì per-vault, để chặn hẳn lớp (2).
**BÁO PhoenixKey:** mẫu uniqueness thread đã có (`lib/phoenixkey/pa2_uniqueness_logic.ak`) — cảnh báo bẫy circular apply-param đã ghi nhận ở PA2.

### F14. GenDrip permissionless + `find_vault_output` chỉ khớp `payment_credential` — **PoC ĐÃ CHẠY**
auditor-onchain · `activation_vault.ak:126-134` + `activation_logic.ak:591-615,221` @3d5fdce · `poc3_gendrip_moves_vault_to_attacker_stake_cred` PASS (`extra_signatories: []` — KHÔNG ai ký)

Nhánh `GenDrip` gọi thẳng `gen_drip_ok` — hàm này KHÔNG nhận `keeper_signed` lẫn `owner_signed`; 8 mệnh đề của nó không có mệnh đề chữ ký nào (`owner_signed`/`keeper_signed` được tính ở validator dòng 118-122 nhưng nhánh GenDrip **không dùng tới**). Ghép với `find_vault_output` lọc bằng `payment_credential` ⟹ `stake_credential` tự do.

⟹ Bất kỳ ai spend vault người khác bằng GenDrip, tái tạo output cùng payment_credential + datum + LAMP + NFT nhưng **stake_credential của attacker**. Vault hợp lệ 100%, `c` không đổi (I-ACT-7 KHÔNG vi phạm) — nhưng **ĐỊA CHỈ BECH32 ĐÃ ĐỔI**. Engine tra theo địa chỉ đầy đủ ⟹ không thấy ⟹ c = 0 ⟹ **victim mất TOÀN BỘ gen MAGIC**. Lặp vô hạn. Giá: ~0,2 ADA/lần. Phụ: attacker ăn staking reward min-ADA (× 10⁶ vault); mỗi lần spend đổi UTxO-ref ⟹ grief keeper-liveness ~0,2 ADA/block.

**SỬA — GenMAGIC tự vá ngay (ghi vào §2):** engine index vault theo cặp **(payment_credential, vault-NFT)**, TUYỆT ĐỐI KHÔNG theo địa chỉ bech32 đầy đủ.
**BÁO PhoenixKey (Issue):** (1) `gen_drip_ok` ép `vault_out.address == own_input.output.address` đầy đủ; (2) gate GenDrip bằng `keeper_signed ∨ owner_signed` — theo chính §6:209 thì GenDrip "chỉ dùng nếu buộc phải spend", để nó permissionless là **bề mặt tấn công thuần, không đổi lấy giá trị nào**; (3) cân nhắc ép địa chỉ đầy đủ ở `find_vault_output` cho MỌI redeemer.

### F15. `plutus.json` đang commit là datum **9-field v4.1** — CONTRACT §2:41 pin 7-field chưa merge
auditor-onchain · `PhoenixKey-Validator/plutus.json` (verified: `n_fields = 9`, hash `94032e38…`) · `Wakeme-Tech §8:475`

v5 (`3d5fdce`) CHỈ tồn tại trên branch `claude/wakeme-closed-loop-pot`. Nhánh `main` vẫn 9-field VÀ mang bug đơn vị `lamp_locked == d.conditional_lamp` (**thiếu `× oil_per_lamp`** — khoá thiếu 10⁶ lần; `Math.md:49` gọi đây là "rigor gap v4.1").

**Chỗ chết người: `conditional_lamp` ở INDEX 3 CẢ HAI BẢN** ⟹ decoder theo vị trí "thành công" trên cả hai, **không có tín hiệu lỗi nào**.
- Đường (1): engine decode lỏng → vault v4.1 khai c=1001 nhưng chỉ khoá 1001 oildrop = **0,001 LAMP** → gen **SAI 10⁶ LẦN**.
- Đường (2): engine-dev lấy script-hash từ plutus.json (đúng quy trình) → hash v4.1 → **địa chỉ vault tính ra SAI HOÀN TOÀN** → đâm thẳng vào mục (1) của vá F2, vô hiệu lớp phòng thủ chính ngay từ tham số đầu vào.

Đường sinh rất tự nhiên: clone repo → nhánh mặc định `main` → thấy 9-field → dựng decoder 9-field. Dòng "aiken check 212/212 PASS" ở `Math.md:345` đúng nhưng ở commit KHÁC nhánh mặc định.

**SỬA — CHẶN Gen production tới khi:** (1) v5 merge vào main; (2) `aiken build` sinh lại plutus.json 7-field + hash mới. Nâng `Wakeme-Tech §8:475` lên **BLOCKER**, đưa vào §7 CONTRACT như phụ thuộc **D5** (chủ: PhoenixKey đội on-chain). Engine PHẢI ép arity CHÍNH XÁC (Constr 0 + đúng 7 field, reject mọi thứ khác — **fail-closed**; một vault v4.1 gen 0 còn hơn gen sai 10⁶ lần). §2 phải ghi rõ nguồn CBOR chuẩn là commit **3d5fdce**, không phải main. Thêm test round-trip CBOR aiken↔engine.

### F16. Lá không có chữ ký OPERATOR ⟹ toàn bộ fraud-proof/bond là bất khả thi như đặc tả
`§6:200,211,214`, `§9:253-254` · adversary — trả lời trực tiếp §9 mục 12

`lá = H(did ‖ Δmagic ‖ nonce ‖ cosign ‖ prev)` (§6:200) — cosign là chữ ký của **user**. **Không có chữ ký OPERATOR ở đâu cả.** Cosign chứng minh "tôi ĐỒNG Ý tiêu", KHÔNG chứng minh "operator ĐÃ NHẬN". Khi operator im lặng không append, user cầm chữ ký của chính mình — vô giá trị làm bằng chứng.

§6:214 tuyên "operator có thể DoS/giấu delta, KHÔNG thể chối delta ĐÃ ANCHOR" — đọc kỹ đó là **lời thú nhận**: delta CHƯA anchor thì chối vô tư, và **không tồn tại bằng chứng nào cho việc giấu**. `Scale-Analysis:295 (L3)` kê "Fraud-proof window + multi-operator fallback" — **không có fraud-proof nào dựng được khi không có bằng chứng đầu vào**. Bond để đó cũng không ai slash được.

**Đòn bẩy 6:1:** giấu 1 epoch ⟹ hạ hệ số 6 epoch (cửa sổ trượt). Kịch bản: đối thủ trả operator 200 USD (hoặc chỉ là shard lỗi 6 tiếng — **không cần ác ý**) → công dân hạng nhất 10.40× tụt về 3.30× ⟹ **mất 68% suất trong 30 ngày**. X đi kiện: cầm 600 delta có chữ ký CỦA CHÍNH X. "Chứng minh O đã nhận?" — không có gì. Không root nào chứa lá ⟹ inclusion proof không dựng được; proof-of-absence vô nghĩa vì không có mốc "lẽ ra phải có". Bond của O: nguyên vẹn.

**G9 ở đây là BỘ KHUẾCH ĐẠI THIỆT HẠI, không phải lá chắn** — nó biến sự cố khả hồi (sổ sai) thành mất mát bất khả hồi (suất bốc hơi).

**SỬA:**
1. **SỬA LÁ — bắt buộc, đây là chỗ gãy gốc.** Operator phải trả **BIÊN NHẬN KÝ** ngay khi append: `receipt = sig_op(H(lá) ‖ epoch ‖ seq)`. User giữ receipt. Cuối epoch, nếu `root(epoch)` không chứa lá mà operator đã ACK ⟹ user xuất receipt + proof-of-absence ⟹ **slash bond tự động**. **Không có receipt thì mọi thứ còn lại trong §6 (bond, fraud-proof, cửa sổ) chỉ là chữ.**
2. Sửa §6:214: viết thẳng **"giấu delta hiện KHÔNG PHÁT HIỆN ĐƯỢC và KHÔNG CHỨNG MINH ĐƯỢC"** thay vì câu trung tính đọc như đã lường trước.
3. Chặn khuếch đại 6:1: operator bị slash ⟹ `đã_tiêu` của user được **ghi nhận bù** từ receipt đã ACK.
4. **Trả lời §9 mục 11:** Có, và nặng hơn mức đang nghĩ — không phải thiếu con số, mà **thiếu cơ chế đầu vào cho fraud-proof**. Định lượng bond trước khi có receipt là định lượng một thứ không dùng được.

### F17. Bond TĨNH vs phơi-nhiễm TĂNG DẦN ⟹ mọi operator THÀNH CÔNG đều đạt điểm bỏ trốn +EV
`§6:206-212`, `§9:253-254` · adversary · `Scale-Analysis:294 (L2)`

Bond B đóng **một lần lúc đăng ký**; phơi nhiễm E = net_CARP nợ Treasury cuối epoch **tăng theo số user**. Với provider ăn nên làm ra, E tăng đơn điệu ⟹ tồn tại epoch T mà E(T) > B ⟹ nước đi duy lý = **ôm E rồi biến, lãi E − B > 0**.

Đây **không phải rủi ro biên — là định lý về mọi operator thành công.** Càng thành công càng sớm tới T. Hệ tự chọn lọc: operator tốt nhất là kẻ có động cơ phản bội mạnh nhất. Ví dụ B = 100.000 ADA: Q1 (2.000 user, E=8.000) trung thực; Q2 (20.000 user, E=80.000) trung thực; **Q3 (60.000 user, E=240.000) ⟹ E−B = +140.000 ADA**. Không cần ác ý — chỉ cần P **phá sản vì lý do khác** là kết quả y hệt.

`Scale-Analysis:294` tự viết **"cần cap net exposure/epoch"** — cái cap đó chính là thứ đóng lỗ, và nó **KHÔNG được mang sang CONTRACT §6**. Bảng §6:206-212 có "bond" nhưng **không có "cap"**.

Cộng hưởng với F12(f): operator vỡ nợ ⟹ user của nó **vẫn giữ nguyên 2.50×** ⟹ shell provider chỉ cần sống tới hết epoch ⟹ wash không cần cả việc trả CARP.

**SỬA:**
1. **Bond động + cầu dao trong lớp kế toán §6** — MAGIC tự làm được: `B ≥ κ × E_max_quan_sát` (κ ≥ 1.5); lớp kế toán **từ chối append delta mới** khi phơi nhiễm chưa quyết toán luỹ kế > B/κ. Bất biến ép được: `E_chưa_quyết_toán ≤ B/κ` tại MỌI thời điểm ⟹ **bỏ trốn luôn −EV**.
2. Mang dòng "cap net exposure/epoch" từ `Scale-Analysis:294` vào bảng §6 — hiện đang rơi mất.
3. Nối D1↔D4 (F12): vỡ nợ ⟹ **tự động thu hồi hệ số** của user provider đó ⟹ user có động cơ chọn provider bonded ⟹ áp lực thị trường làm thay việc Registry chưa có.
4. Định lượng §9 mục 11 theo **κ và E**, KHÔNG theo hằng số tuyệt đối. Hằng số tuyệt đối là chỗ hỏng.

### F18. Engine off-chain là ĐIỂM CHẾT ĐƠN của `nhịp_gen` — không quy tắc dự phòng, không escape-hatch
`§9:254`, `§5:171-182`, `§6:192-214` · adversary — trả lời trực tiếp §9 mục 12

**Trả lời: CHƯA CÓ, và chỗ cần van còn nặng hơn Wakeme.**
- Wakeme: `reclaim_epoch_ok` ép `(keeper_signed ∨ owner_signed)` (`Math:178`) ⟹ keeper chết, owner tự thoát. `Math:279` (T-1): "KHÔNG có redeemer nào phụ thuộc keeper để user thoát vault". `Math:290` còn đề xuất `LeaseExpiry` permissionless.
- GenMAGIC §6: **0 van.**

Điểm chết nặng nhất không phải sổ, mà là `nhịp_gen`: engine không công bố ⟹ **không user nào tính được M_v** ⟹ **sinh MAGIC dừng TOÀN MẠNG**. CONTRACT không có dòng nào nói chuyện gì xảy ra. Van §5:182 giả định đã có `nhịp_gen(e)`; nó không phát biểu gì về sự **VẮNG MẶT** ⟹ hành vi không xác định: nơi coi = 0 (mất trọn ngân sách 1 epoch × toàn mạng, **vĩnh viễn theo G9**), nơi dùng lại giá trị cũ (lệch ngân sách, phá G3).

Ghi cho công bằng: **LAMP an toàn tuyệt đối** trong mọi kịch bản này (I-ACT-7/G5, engine chỉ ĐỌC; Wakeme ReclaimEpoch chạy độc lập). Mất **suất sinh**, không mất **vốn**. Nhưng theo G9, mất suất = mất vĩnh viễn.

**SỬA:**
1. **Quy tắc mặc định khi không công bố** (rẻ, phải có ngay): `nhịp_gen(e) := min(nhịp_gen(e−1), ngân_sách_gen(e) × Q / tổng_trọng_số(e−1))` + hạn chót slot cụ thể. **Không có dòng này thì hệ có trạng thái không xác định ở đúng lúc tệ nhất.**
2. **Van cuối permissionless** — tương đương `LeaseExpiry`: sau `T_max` epoch không anchor, BẤT KỲ ai được trigger anchor root cuối cùng đã ACK + buộc settle. Mượn khuôn `Wakeme-Math:290` (đang chờ anh gate — **nếu Wakeme gate thì GenMAGIC nên gate cùng, cùng luận cứ**).
3. Thêm dòng thứ tư vào bảng "ranh giới tin cậy" §6:214: **engine chết ⟹ sinh dừng toàn mạng**. Hiện chỉ nói mức delta, không nói mức hệ.
4. **Trả lời dứt §9 mục 12: ai chịu = user, 100%; escape-hatch = KHÔNG CÓ.** Đừng để câu hỏi này mở.

### F19. Mâu thuẫn nội tại §6: "single-writer per DID" CẤM chính "multi-operator fallback" mà thiết kế mượn làm giảm nhẹ
`§6:212` · adversary · `Scale-Analysis:266,295`

§6:212 chốt "số dư 1 DID do **đúng 1** shard giữ ⟹ không race". Nhưng giảm nhẹ cho DoS lại là `Scale-Analysis:295 (L3)`: "Fraud-proof window + **multi-operator fallback**". **Hai thứ này loại trừ nhau** — multi-operator cho CÙNG một DID = hai writer = đúng cái race mà sharding sinh ra để diệt. Giao thức bàn giao/đồng thuận: **không tồn tại trong bất kỳ nguồn nào của 4 nguồn**.

⟹ Thực tế: **mỗi shard operator là độc quyền TUYỆT ĐỐI TRỌN ĐỜI** trên mọi DID thuộc shard (hash là hàm của DID, DID gắn sinh trắc ⟹ **cố định trọn đời**). Không đổi nhà cung cấp, không dự phòng, không cạnh tranh. Đây là **điều kiện tiền đề** khiến F16 và F17 trở nên khai thác được — nạn nhân không có lối ra.

**SỬA:**
1. Bỏ "multi-operator fallback" khỏi tập giảm nhẹ, HOẶC đặc tả giao thức bàn giao thật: `HandoffRequest(did, from_shard, to_shard, epoch_boundary)` chỉ hiệu lực **tại ranh giới epoch sau khi root(e) của from_shard đã anchor + final (k=5)**; số dư khởi tạo ở to_shard = số dư đã chứng minh qua inclusion proof. Không race vì hai shard không bao giờ cùng sống trên một DID trong cùng epoch.
2. Cho tới khi có (1): ghi thẳng vào §6 "ranh giới tin cậy" — **operator shard là độc quyền trọn đời; không dự phòng, không lối thoát**. Đây là giả định vận hành NẶNG NHẤT của §6 và đang bị che bởi một dòng giảm nhẹ không dùng được.
3. Nếu (1) quá đắt: tối thiểu cho DID **chọn shard lúc genesis** (thay vì hash cưỡng bức) ⟹ có cạnh tranh trước-khi-vào.

### F20. Thời điểm lấy mẫu `c_v` / `slot_now` / `tổng_trọng_số` KHÔNG ĐỊNH NGHĨA — **2 trục cùng đánh sập §5:176-177**
`§3:71,74`, `§4.1:98`, `§5:171,176-177` · auditor-onchain + game-theorist

`c` là biến **TRÔI trong epoch**: `reclaim_ok` trừ 1 LAMP MỖI NGÀY (5 lần/epoch); `reclaim_epoch_ok` trừ tới 5 LAMP/epoch. Vault idle c=100 đầu epoch → 96 cuối epoch ⟹ **M_v chênh 4%** tuỳ lấy đầu hay cuối. Tệ hơn: keeper là actor tin-cậy off-chain (T-1) tự chọn giờ submit ⟹ **keeper dịch được M_v của bất kỳ user nào** bằng cách sớm/muộn vài giờ, không vi phạm guard on-chain nào.

Hai engine/shard đọc lệch vài slot ⟹ hai `tổng_trọng_số(e−1)` ⟹ hai `nhịp_gen(e)` ⟹ hai M_v cho cùng một user. **`Scale-Analysis §6.3 (T-RECONCILE)` đòi "kế toán cân bằng BIT-EXACT (nanogic)" làm pass-condition ⟹ không có slot chuẩn thì T-RECONCILE KHÔNG THỂ PASS theo định nghĩa.**

Game-theorist bồi thêm từ hướng khác: **user chỉ tự tính được 1/4 hệ số.** `tuổi_LAMP` ✓; `cam_kết_lịch` ~ (mẫu số đệ quy, F7); `tiêu_thật` ✗ (mẫu số `đã_sinh` = Σ M_v 6 epoch, mỗi cái phụ thuộc `nhịp_gen` toàn mạng — datum 7-field không chứa field MAGIC nào); `giờ_thấp_điểm` ✗✗ (cần biết, TẠI TỪNG SLOT quá khứ, EMA toàn mạng — **trạng thái off-chain engine giữ**, user không tái tạo được, **không kiểm chứng được, không phản đối được**). §6:214 chỉ bảo đảm operator "không bịa/sửa delta đã cosign" — **nó KHÔNG bảo đảm gì về việc phân loại thấp/cao điểm**, vì phân loại đó không phải delta có cosign. ⟹ **Engine có thể tuỳ ý gán nhãn cao-điểm cho ai đó và không ai chứng minh được** — kênh rút giá trị âm thầm, tỷ lệ thuận thị phần shard, và phần bị lấy được chia lại cho mọi người khác qua §5:172 **kể cả cho chính vault operator kiểm soát**.

⟹ **Lý do biện minh duy nhất của đánh đổi trễ-một-epoch (§5:175-178) mất căn cứ, nhưng CONTRACT vẫn trả toàn bộ cái giá** (vượt ngân sách, van 1.25×, bộ tích phân, hạ G3 xuống "trung bình trượt").

**SỬA:**
1. Chốt NORMATIVE vào §3 + §5: `c_v`, `slot_now`, `tổng_trọng_số` đều lấy tại **MỘT slot chuẩn duy nhất** — đề xuất slot cuối cùng của epoch e−1, sau `k_finality` (`Scale-Analysis §6.2 L7`: k=5 chuẩn / k=36 archival, tránh reorg đổi nhịp_gen sau khi công bố). `tuổi_epoch` tính từ cùng slot đó.
2. Chọn một trong hai, không được ở giữa (**xem S3**):
 - **(A)** Giữ nguyên tắc "user đo lường được" (anh nêu 2 lần: §4.1:102, §5:177) ⟹ MỌI hệ số phải tính được từ dữ liệu user có ⟹ bỏ `giờ_thấp_điểm` dạng EMA; thay bằng **lịch cửa sổ thấp-điểm CÔNG BỐ TRƯỚC, TẤT ĐỊNH** (engine công bố đầu epoch e, dựa dữ liệu e−1). User biết trước khi tiêu, tự kiểm chứng sau khi tiêu — và **điều tiết cần tín hiệu ĐẾN TRƯỚC quyết định, không phải chấm điểm sau** ⟹ G8 mạnh hơn, không yếu đi.
 - **(B)** Chấp nhận user KHÔNG đo lường được ⟹ **bỏ luôn lý do biện minh §5:176-177**, tính lại đánh đổi bằng lý do khác (chống đua-đào §5:178 — lý do này ĐỘC LẬP và vẫn đứng vững). Và khi đó **BẮT BUỘC** có cơ chế phản đối cho phân loại thấp-điểm (đưa nhãn vào lá có cosign, hoặc fraud-proof cho phân loại), nếu không §6:214 phải viết lại thành "operator có thể tuỳ ý gán nhãn và không ai chứng minh được" — **một ranh giới tin cậy hoàn toàn khác với cái đang tuyên bố**.
 - Hội đồng khuyến nghị **(A)**: rẻ hơn, mạnh hơn về G8, giữ nguyên tắc anh đã chốt.

### F21. `giờ_thấp_điểm` chỉ báo NHỊ PHÂN không tự cân bằng — §4.3:135 khẳng định SAI; nó làm đỉnh/trung-bình TỆ ĐI 3.3× — **2 trục cùng đánh §4.3:135**
`§4.3:135` · toán (chu kỳ giới hạn) + game-theorist (G9 đồng bộ hoá cầu)

**(a) Không tồn tại cân bằng thuần** (chứng minh): f nhỏ ⟹ lệch sang có lợi nghiêm ngặt ⟹ f tăng; f = 1 ⟹ cửa sổ thành đỉnh ⟹ không ai được thưởng ⟹ lệch ra có lợi. Cân bằng duy nhất tại `EMA_fast = EMA_slow` — một **lưỡi dao**. Chỉ báo tất định + ai cũng thấy cùng thông tin ⟹ mọi tác nhân phối hợp về cùng một phía ⟹ **chattering**. Mô phỏng số với đúng α của FlowRate (1/3, 1/12): **chu kỳ giới hạn bền vững ≈ 5-6 bucket**; đỉnh/trung-bình: **1.00 (không có §4.3) → 3.33 (có §4.3)**. ⟹ Cơ chế "điều-tiết cung-cầu" làm **tỷ số đỉnh/trung-bình xấu đi 3.3×** — chính xác ngược G8. Hạ TRẦN_THẤP_ĐIỂM chỉ làm gai nhỏ đi, **không xoá được tính bang-bang**.

**(b) Cầu dịch vụ thật KHÔNG DỜI ĐƯỢC.** G4 định nghĩa công dân hạng nhất = người tiêu cho **dịch vụ THẬT**. Cầu thật là cầu phái sinh: người ta dùng dịch vụ lúc họ CẦN = giờ thức = cao điểm. **Cầu GIẢ thì dời tự do — bot không ngủ.** ⟹ hệ số trao +50% cho đúng nhóm G4 muốn chặn, và 1.00× cho đúng nhóm G4 muốn ưu tiên. §4.3:135 biện hộ "tự cân bằng" **chỉ đúng nếu cầu dời được**. Với cầu không dời được: người thật ở nguyên cao điểm và **trả thuế 33% vĩnh viễn cho bot**. Thứ hệ số này điều tiết là **mức độ tự động hoá**, không phải cung-cầu.

**(c) G9 TẠO RA cơn dồn cuối epoch — hai tiên đề đánh nhau.** G9 là **hạn chót cứng lặp mỗi 5 ngày** gắn với mất mát nhìn thấy được ⟹ dồn cuối kỳ. Và **cuối kỳ của MỌI user là CÙNG MỘT THỜI ĐIỂM** (ranh giới epoch toàn cục). ⟹ **cầu bị ĐỒNG BỘ HOÁ bởi chính giao thức**, tạo đỉnh tuần hoàn 5 ngày/lần mà không ai dịch chuyển được. Dual-EMA phân loại đúng cửa sổ đó là cao điểm ⟹ **§4.3 phạt chính xác cái hành vi mà G9 cưỡng chế**. Chị Lan (tiêu thật, bị hạn chót ép) = 4.29×; bot H (tiêu bụi lúc 3h sáng) = 4.95× ⟹ **bot sinh nhiều hơn người tiêu thật 15%, và bot trả 0 đồng**. §4.3:135 "tự cân bằng" không cứu được: **đỉnh cuối-epoch không do ưu đãi tạo ra — nó do HẠN CHÓT tạo ra, và hạn chót không phản ứng với ưu đãi.**

**SỬA (nếu quyết định S3 = giữ hệ số này):**
1. **Thay ngưỡng nhị phân bằng GRADIENT LIÊN TỤC** — điều kiện CẦN để có cân bằng nội tại: `tỷ_thấp_điểm_slot = clamp(0, Q, ⌊(EMA_slow − EMA_fast) × Q / max(EMA_slow,1)⌋)`, rồi trung bình có trọng số theo lượng tiêu. Phần thưởng biên giảm dần ⟹ tác nhân biên bàng quan ⟹ hết chattering.
2. Chốt phân loại theo **bucket ĐÃ ĐÓNG** + làm trơn ≥3 bucket, triệt vòng "dự đoán → xả → lật".
3. **Lệch pha hạn chót theo vault** (giải (c) tận gốc, và rẻ): suất reset theo chu kỳ 5 ngày RIÊNG mỗi vault, neo vào `vest_start_slot` (**đã có sẵn trong datum**, §2:46, bất biến qua mọi redeemer): `epoch_riêng_v = ⌊(slot_now − vest_start_slot)/432000⌋`. Vì `vest_start_slot` phân tán đều theo thời điểm GetLAMP, hạn chót 10⁶ user trải đều ⟹ **đỉnh đồng bộ biến mất về mặt cấu trúc**. **Giữ nguyên G9** — vẫn dùng-hay-mất, vẫn không tích luỹ; chỉ bỏ tính ĐỒNG BỘ, thứ không phải nội dung của G9. §6 đã là kế toán off-chain per-shard ⟹ gần như miễn phí. *(Lưu ý: điều này lại phụ thuộc F3 — `vest_start_slot` phải được ràng buộc ở genesis trước, nếu không attacker chọn pha.)*
4. **Sửa §4.3:135** — khẳng định "tự cân bằng ✓ G8" hiện là SAI. Nếu chuyển sang gradient thì mới viết lại được, **và kèm mô phỏng số làm bằng chứng, không viết bằng lập luận suông**.
5. Trả lời trước khi giữ: **dịch vụ nào trong hệ có cầu DỜI ĐƯỢC?** Nếu danh mục rỗng hoặc bé, hệ số không điều tiết gì. Nếu giữ: chỉ áp cho `service_id` đánh dấu "dời-được" (batch job, backup, index); dịch vụ tương tác thời gian thực miễn trừ, **không tính vào cả tử lẫn mẫu**.

### F22. G9 chặn TỒN KHO, KHÔNG chặn QUỸ ĐẠO CUNG — bộ điều khiển §5 đo đúng biến SAI ⟹ điểm mù thanh khoản GreenBack 3,3×
`§1:32-35`, `§5:170,183,185-186`, `§6:203`, `§9:252` · game-theorist — trả lời trực tiếp §9 mục 10

Hệ quả G9(a) (§1:33) nhập nhằng **TỒN KHO** với **DÒNG**. G9 chặn tồn kho — đúng. Nhưng đại lượng có nghĩa kinh tế là **DÒNG ĐÃ TIÊU tích luỹ**: mỗi MAGIC được TIÊU là một **yêu sách thật lên bảo chứng**, tổng = `Σ_epoch tiêu(e)` — **hoàn toàn KHÔNG bị G9 chặn**.

**Bộ điều khiển §5:183 đo lượng SINH, trong khi biến ràng buộc khả năng chi trả là lượng TIÊU.** Vì phần lớn MAGIC bay hơi ở tay người ôm, hai đại lượng lệch nhau bởi tỷ lệ người ôm **f** — một biến hành vi mà giao thức **KHÔNG đo, KHÔNG kiểm soát, và có thể dịch chuyển nhanh**.

Định lượng: f = 0.9 ⟹ người tiêu chiếm 21,7% ngân sách ⟹ yêu sách thật = 0,217·B. f = 0.5 (một chiến dịch marketing, một dịch vụ hot, hoặc D1 mở ra) ⟹ 71,4% ⟹ yêu sách = 0,714·B. **Yêu sách lên bảo chứng nhảy 3,29× — trong khi lượng SINH đứng yên đúng B ở cả hai kịch bản.** Bộ điều khiển nhìn thấy: KHÔNG CÓ GÌ THAY ĐỔI, sai lệch = 0, không hiệu chỉnh. Van 1.25× cũng vô hiệu vì nhịp_gen không cần tăng. **Hệ mất khả năng bảo chứng đúng lúc người dùng thật sự dùng sản phẩm — tức đúng lúc thành công.** Đây là điểm mù kiểu bank-run: hệ an toàn CHỈ VÌ phần lớn MAGIC không được dùng.

**SỬA:**
1. **Sửa §1:33** — "G9 chặn TỒN KHO per-user; **KHÔNG** chặn tổng dòng đã tiêu; chặn duy nhất là `ngân_sách_gen`". Câu "quỹ đạo cung MAGIC không phân kỳ dù nhịp_gen sai" **phải bị xoá** — nó tạo cảm giác an toàn giả và có thể khiến f được chọn lỏng.
2. **Bộ điều khiển §5 phải đo TIÊU, không đo SINH:** sai lệch = `ngân_sách_gen(e) − đã_tiêu_toàn_mạng(e)`. Engine đã thấy toàn bộ dòng tiêu (§6:197-203) ⟹ đại lượng này **SẴN CÓ, không tốn thêm gì**.
3. **Công bố + giám sát `f` như tham số rủi ro hạng nhất:** `f(e) = 1 − đã_tiêu_toàn_mạng(e)/đã_sinh_toàn_mạng(e)`. Bất biến vận hành: `ngân_sách_gen` phải chịu được `f → f_min_giả_định` (vd 0.3) mà không phá `br_safe_q`. **Không có tham số này thì §5 đang bảo chứng cho một con số mà chính nó không đo.**
4. Bổ sung §9 mục 10: "G9 **CÓ** phá cam-kết-lịch (F23) và **KHÔNG** chặn quỹ đạo cung. G9 chỉ chặn đầu cơ tồn kho."

### F23. `cam_kết_lịch` = cheap talk chiến lược trội; và `pp_sched` là đường bơm lạm phát toàn cục — **3 trục cùng thấy**
`§4.4:142-147`, `§5:170`, `§2:62`, `§1:30-35`, `§8:233` · game-theorist + adversary + critic-legal (+ optimizer, F7)

CONTRACT KHÔNG nêu: tài sản thế chấp, hình phạt khi không giao, trần cam kết, hay điều kiện hiệu lực nào ⟹ cam kết MIỄN PHÍ ⟹ **cam-kết-tối-đa là CHIẾN LƯỢC TRỘI cho mọi người chơi, kể cả người ôm** (kiểm tính trội: `∂tỷ/∂C > 0` đơn điệu, chi phí = 0 ⟹ mọi user đẩy tới `tỷ = 1`).

Hai hệ quả:
- **Mất hết thông tin:** khi mọi người cam kết max, hệ số thành hằng số, triệt tiêu trong chuẩn hoá §5:172 ⟹ **lý do kinh tế §4.4:147 ("cầu báo trước ⟹ hạ bất định (G8)") SAI NGƯỢC** — tín hiệu không chỉ vô dụng mà **PHẢN THÔNG TIN**.
- **Bơm ngân sách:** §5:170 ghi `ngân_sách_gen = f(br_q, br_safe_q, f_max_q, S, pp_sched)`. Nếu `pp_sched` vào `f` theo chiều **DƯƠNG** (điều mà ngữ nghĩa "cầu báo trước" hàm ý), thì mọi user có động cơ TRỘI bơm cam kết giả. Định lượng: N=10⁶ vault ⟹ `pp_sched` toàn mạng = **2.97×10⁷ MAGIC "cam kết"** trong khi cầu THẬT có thể chỉ 3.3×10⁵ ⟹ **thổi phồng 90×**. **Không cần thông đồng — đây là cân bằng Nash.** [NEEDS-EVIDENCE cho chiều dấu: §5:188 tự ghi "theo hàm nào? Chưa chốt"]

**Mâu thuẫn với G9 (đúng câu §9 mục 10 hỏi):** G9 nói MAGIC "RESET mỗi epoch, không tích luỹ được". Vậy "MAGIC cam kết đang hiệu lực" **là cái gì?** Chỉ hai cách đọc, **CẢ HAI hỏng**:
- **(i) hứa giao MAGIC tương lai từ suất tương lai** ⟹ không có gì để tịch thu, hứa suông, tự do bơm.
- **(ii) khoá MAGIC epoch này vào hợp đồng và nó SỐNG SÓT qua reset** ⟹ **ScheduleGen trở thành LỖ TÍCH LUỸ**: mỗi epoch đẩy suất vào hợp đồng để né decay ⟹ 52 epoch/năm ⟹ tích luỹ 52 × M ⟹ **phá thẳng hệ quả G9(a) ("không có kho MAGIC để đầu cơ", §1:33) VÀ phá lá chắn pháp lý §8 #2** ("không chuyển nhượng VÀ không tích luỹ ⟹ không thể là tài sản đầu tư", §1:35 + §8:233).

CONTRACT **chưa chọn cách đọc nào.**

**SỬA — chốt cách đọc TRƯỚC (xem S5), rồi vá theo:**
- **Nếu (i):** cam kết PHẢI có **chi phí bất khả hồi**, nếu không **XOÁ hệ số**. Chi phí khả dĩ duy nhất trong mô hình này: cam kết ràng buộc **SUẤT** (không phải MAGIC) — user cam kết X% suất epoch tương lai đã bị hợp đồng chiếm chỗ; không giao thì `tiêu_thật` epoch đó bị trừ. Khi đó mới là **tín hiệu tốn kém** và mới hạ được bất định như §4.4 tuyên bố.
- **Nếu (ii):** nói thẳng ScheduleGen là **ngoại lệ của G9**, và **§8 #2 + hệ quả G9(a)/(c) PHẢI viết lại** — không được tuyên bố "không tích luỹ".
- **Cả hai trường hợp:** `ngân_sách_gen` **TUYỆT ĐỐI không được lấy `pp_sched` làm đầu vào** cho tới khi cam kết có chi phí — **một biến mà mọi người chơi có động cơ trội bơm lên thì không được phép điều khiển nguồn cung**. Nếu cần tín hiệu cầu, dùng **`đã_tiêu` THỰC TẾ** các epoch trước (đã xảy ra, không bơm được ex-post).
- Bổ sung §9 mục 10: **"CÓ, G9 phá cam-kết-lịch"** — không phải "reset làm mất cam kết" mà là **"G9 khiến cam kết không có vật để cam kết"**.

### F24. `c` tuyến tính 1001:1 lấn át trần 12.375× ⟹ G4 VỠ GIỮA CÁC COHORT; §4.2:118 "cá voi không có lợi thế" là khẳng định SAI — **2 trục cùng thấy (từ 2 hướng khác nhau)**
`§3:71`, `§4.2:118`, `§4.5:157-161`, `§4.1:101` · adversary + game-theorist

`c_v` vào **tuyến tính, không trần mềm**, dải [1, 1001] = tỷ lệ tối đa 1001:1 = **81× trần tư_cách (12.375×)** ⟹ **tỷ lệ c vượt 12.375:1 thì mọi hành vi đều thua**.

**§4.2:118 SAI như phát biểu** — cả hai trục đồng ý, nhưng chỉ ra hai lý do khác nhau:
- **adversary:** đo-tỷ-lệ khử được lợi thế cá voi **bên trong hệ số**, nhưng `c` vẫn là **LƯỢNG** nhân đằng trước ⟹ lợi thế sống nguyên vẹn ở **cơ số**. Và `c` KHÔNG phải thước đo giàu — `D = min(1001, ⌊pot/10⁶⌋)` (`Math:33`) ⟹ D quyết bởi **THỜI ĐIỂM VÀO**. `Math:303` tự nhận pot cạn tạm thời khi GetLAMP > Reclaim, "đặc biệt giai đoạn đầu". Vĩnh viễn, vì `c` chỉ giảm (MONO-c). **Bác Tám** (vào tháng 1, D=1001, nằm im 3.548×) = trọng số 3.552 vs **Chị Mai** (vào tháng 5, pot cạn, D=80, chơi hoàn hảo 12.375× = trần tuyệt đối) = trọng số 990 ⟹ **bác Tám nhận gấp 3.59 lần**. Chị Mai KHÔNG có đường sửa (MONO-c, 1 DID = 1 vault, tư_cách đã kịch trần). **Mọi cohort vào lúc pot < 287 LAMP đều không thể thắng bác Tám nằm im, dù chơi hoàn hảo.**
- **game-theorist:** "cá voi LAMP" theo nghĩa nắm-nhiều-hơn KHÔNG TỒN TẠI ĐƯỢC (mọi vault khởi đầu D đồng nhất) ⟹ §4.2:118 đang **phòng thủ một mối đe doạ mà cấu trúc đã loại bỏ**, trong khi bỏ hở **hai kênh cá voi THẬT**: (1) **số PersonDID** (F11), (2) **ngưỡng TUYỆT ĐỐI ở biên Wakeme↔MAGIC** (F25). Thêm: `đã_tiêu` có thể bơm bằng **MAGIC/CARP MUA** (`Wakeme-Tech:397` "1 CARP = 1 MAGIC") ⟹ **`tiêu_thật` MUA ĐƯỢC BẰNG TIỀN** [NEEDS-EVIDENCE: chiều CARP→số dư MAGIC chưa chốt ở nguồn nào; §7 D4 để hở].

**SỬA:**
1. **§4.2:118 + §4.4:146 — XOÁ khẳng định "cá voi không có lợi thế".** Thay bằng phát biểu đúng: *"đo tỷ lệ khử lợi thế lượng **trong hệ số**; cơ số `c` vẫn tuyến tính nên lợi thế theo cohort-vào-sớm còn nguyên. Việc mọi vault khởi đầu D đồng nhất là **tính chất của Wakeme** (`Math:33`), KHÔNG phải công của việc đo tỷ lệ. Trục bất bình đẳng thật là (a) số PersonDID [BLOCKER PA2] và (b) các ngưỡng TUYỆT ĐỐI ở biên Wakeme↔MAGIC."* **Khẳng định sai trong CONTRACT nguy hiểm hơn lỗ hổng — nó khiến người ta ngừng tìm.**
2. **Bổ sung "kiểm G4 CHÉO cohort" vào §4.5** với chính con số trên. Nếu không chấp nhận được, chọn 1 trong 2: **(a)** nén cơ số (`base_v = ⌊Q × c_v^(1/2)⌋`-kiểu) ⟹ dải cơ số 1001:1 → ~31:1, cùng bậc với trần tư_cách ⟹ hành vi lại có ý nghĩa — **đánh đổi: bẻ tính đo-lường-được đơn giản, đụng G3/§5, cần anh chốt**; **(b)** chấp nhận và ghi thẳng vào §8 + tài liệu người dùng: "thời điểm vào quyết định phần lớn suất sinh; hành vi chỉ điều chỉnh trong biên 12.375×" — **nếu chọn (b) thì G4 phải viết lại, nó đang hứa thứ hệ không giao**.
3. **Chốt chiều CARP→MAGIC trước khi khoá §4.2:** nếu user nạp được MAGIC bằng tiền thì `tiêu_thật` mua được ⟹ hoặc (a) chỉ đếm MAGIC **ĐƯỢC SINH** vào `đã_tiêu` (loại MAGIC mua), hoặc (b) thừa nhận công khai tư_cách mua được bằng tiền và bỏ tuyên bố chống cá voi. **Không được khoá §4.2 khi D4 còn mở.**

### F25. `MIN_MAGIC_TX` là ngưỡng TUYỆT ĐỐI ⟹ vault nhỏ bị xoá sổ, vault lớn nằm im miễn phí — **2 trục cùng thấy, cùng một đề xuất sửa**
`§4.2:114`, `§4.1:104` · adversary + game-theorist · `Wakeme-Tech:341`, `Wakeme-Math:304`

Hai hệ đo "đã tiêu" song song, **không có ràng buộc nhất quán nào giữa chúng**: Wakeme `active` = ngưỡng **TUYỆT ĐỐI** per-NGÀY nhị phân; GenMAGIC `tiêu_thật` = **TỶ LỆ** trên [e−6,e) liên tục.

Với MIN_MAGIC_TX = 1 MAGIC/ngày (`Math:304` ghi **"TẠM"**, chưa chốt):
- **Vault lớn** c=1001 (sinh 20 MAGIC/ngày): tiêu 1 ⟹ active ⟹ **giữ c=1001 suốt 1001 ngày. Gánh nặng = 5% suất.**
- **Vault nhỏ** c=10 (sinh 0.2 MAGIC/ngày): muốn active phải tiêu **500% suất** ⟹ BẤT KHẢ THI ⟹ luôn idle ⟹ bị bào 1 LAMP/ngày ⟹ **c = 0 sau 10 ngày, vault đóng.**

⟹ Cùng một ngưỡng, gánh nặng **NGHỊCH với quy mô**. **§4.2:118 "user nhỏ tiêu hết vẫn đạt trần" là SAI — user nhỏ tiêu hết bị XOÁ SỔ.** Vòng xoáy: c nhỏ → M nhỏ → không đủ ngưỡng → bị bào → c nhỏ hơn. **Đúng là "giàu càng giàu" mà §4.2 tuyên bố chống, chỉ là nó sống ở tầng dưới.**

Và **§4.1:104 dựa vào một cơ chế bào mà khe này vô hiệu hoá:** "pha Epochy bào c 5 LAMP/epoch ⟹ không tích luỹ vô hạn" — Epochy chỉ tới sau ngày 1001 (`Math:87`) ⟹ bác Tám ôm c=1001 với tuổi_LAMP trần trong **2,7 năm** trước khi cơ chế bào chạm tới. Có **176 epoch liền tuổi đã max mà chưa có lực bào nào**.

**SỬA:**
1. **Chuyển `active` sang ngưỡng TỶ LỆ**, dùng chung một nguồn với §4.2: `active ⟺ tỷ_tiêu_gần_đây ≥ θ` (θ vd 0.25) hoặc `đã_tiêu(epoch) ≥ α × M_v(epoch)`. **Trung lập theo quy mô.** Việc này thuộc Wakeme (I-ACT-3) nhưng **định nghĩa phải do MAGIC cấp** vì MAGIC giữ sổ tiêu (§6:210) — **gửi inbox PhoenixKey, đừng chờ** (`Math:304` ghi "TẠM" ⟹ đúng thời điểm đề xuất). Không vi phạm G1: vẫn sinh ở sàn nếu không active — bào LAMP là cơ chế của Wakeme, không phải cổng của GenMAGIC.
2. **Thêm dòng D-mới vào §7:** "Định nghĩa `active` của Wakeme và `tiêu_thật` của GenMAGIC PHẢI dẫn xuất từ cùng một `đã_tiêu`" — hiện hai bên tự định nghĩa, **sẽ phân kỳ ngay khi Registry land**.
3. **Phản hồi `Math:304`:** MIN_MAGIC_TX không phải "Thấp". Đúng là không đụng conservation, nhưng nó quyết định `tuổi_LAMP` có bị bào hay không **suốt 2,7 năm Daily** ⟹ **đụng thẳng G4/G8. Nâng mức, chốt cùng θ.**
4. **§4.1:104 phải bỏ dựa vào "Epochy bào c"** làm luận cứ cân bằng — cơ chế đó không chạm Daily. Cần cân bằng trong Daily thì phải có cơ chế trong Daily.

### F26. Lá chắn pháp lý (1) bỏ qua đường vòng CARP-settlement — **2 trục cùng thấy**
`§8:229-237`, `§6:202-203` · critic-legal + adversary

§8 lập luận: MAGIC không chuyển nhượng ⟹ không bán được ⟹ không thể là thu-nhập. **Lập luận này chỉ đúng nếu MAGIC là ĐIỂM CUỐI của giá trị.** Nhưng theo chính §6:203 (T-RECONCILE: "net CARP → Treasury") + `Scale-Analysis` (CARP = "đồng-thanh-khoản **chuyển-nhượng-được**"), khi MAGIC được TIÊU — kể cả **tự-tiêu** (`Wakeme-Tech:388`: "Self-consumption **HỢP LỆ**"; §7 D1 xác nhận Registry-gate là placeholder) — nhà cung cấp (có thể là chính user) nhận **CARP = tài sản chuyển nhượng được**.

⟹ Giá trị KHÔNG bị chặn ở khâu "không bán được token MAGIC" — nó **thoát ra qua khâu tiêu-dùng → CARP**. Lá chắn (1) chỉ chứng minh "không bán được CHÍNH TOKEN MAGIC", **không** chứng minh "không rút được GIÁ TRỊ từ việc nắm LAMP" — hai mệnh đề khác nhau về bản chất pháp lý (**hình thức token vs thực chất kinh tế**).

Kịch bản: A giữ LAMP thụ động → nhận MAGIC nhờ sàn G1 → tự đăng ký "provider" (hợp lệ: self-consumption cho phép, D1 placeholder) → tự tiêu MAGIC qua dịch vụ đó → Treasury settle CARP về cho A → A bán CARP lấy ADA/fiat. **A đã biến nắm-giữ-LAMP-thụ-động thành dòng tiền thật, chưa bao giờ "bán MAGIC".**

**SỬA §8** — bổ sung phân tích riêng cho đường CARP-settlement (đặc biệt self-consumption + D1 wash-trade) **trước khi khẳng định lá chắn (1) đứng vững**. Đây là điểm **CẦN LUẬT SƯ SOÁT** theo hướng **thực-chất-hơn-hình-thức** (substance-over-form), không chỉ dựa vào tính không-chuyển-nhượng của bản thân token.

### F27. Lá chắn (2) không phủ nhận được đặc điểm "lãi suất theo thời gian nắm giữ" của `tuổi_LAMP`
`§8:234`, `§4.1:93-104`, `§1:22` · critic-legal

§8 lá chắn (2) là **so sánh TƯƠNG ĐỐI** (ai được nhiều hơn ai), không phải so với **KHÔNG NHẬN GÌ CẢ**. G1 tự thân đã là tuyên bố tuyệt đối: người không làm gì ngoài giữ LAMP **vẫn nhận MAGIC liên tục mỗi epoch**. Nghiêm trọng hơn: **§4.1 là một hệ số ĐỘC LẬP thưởng CHÍNH XÁC theo THỜI GIAN NẮM GIỮ**, không đòi hỏi bất kỳ hoạt động nào khác: 1.00× → 2.20× tuyến tính theo số epoch giữ nguyên LAMP. Trích dẫn chính §4.1:95 (lời anh): *"LAMP giữ nguyên trong vault lớn hơn 6 epoch sẽ cho MAGIC lớn hơn"*.

**Đây là mô tả giáo khoa của "lãi suất tích luỹ theo kỳ hạn"** — chính là điều mà lá chắn cổng-tiêu-thật cũ được dựng lên để tránh. Hai người cùng giữ 1001 LAMP, không ai tiêu: B giữ 0 epoch = 1.00×; C giữ 24 epoch = 2.20×. **Quan hệ nhân-quả "giữ lâu hơn → lợi hơn" kinh điển, hoàn toàn không liên quan tới G4.** So sánh với người tiêu nhiều hơn **không xoá bỏ được đặc điểm này của chính tuổi_LAMP**.

**SỬA §8** — tách phân tích `tuổi_LAMP` ra khỏi lập luận "2.6× hơn người tiêu". Cần trình bày RIÊNG vì sao hệ số thưởng-theo-thời-gian-nắm-giữ KHÔNG cấu thành lãi suất (nếu có lý do chính đáng), thay vì để nó ẩn trong so sánh tương đối. **Điểm CẦN LUẬT SƯ SOÁT trực tiếp** — nó tái hiện chính xác đặc điểm mà lá chắn cũ tránh. → **Xem mâu thuẫn C1.**

---

## C. NHÓM 3 — GHI NHẬN

### F28. Hệ quả G9(c) ở §1:35 là bước nhảy logic (non-sequitur)
critic-legal · *chưa đối kháng, ưu tiên thấp*

"Không tích luỹ ⟹ không thể là tài sản đầu tư" đi quá xa so với tiền đề. Không-tích-luỹ chỉ giới hạn **QUY MÔ** giá trị rút ra tại một thời điểm, không xoá bỏ tính chất **DÒNG CHẢY GIÁ TRỊ ĐỊNH KỲ** — mà đây mới là đặc điểm các khung pháp lý thường xét (một dòng cổ tức "dùng-hay-mất mỗi kỳ" vẫn là cổ tức).
**SỬA:** làm yếu câu (c) — *"không tích luỹ làm giảm quy mô rủi ro tại một thời điểm, nhưng KHÔNG tự động loại trừ đặc trưng đầu tư của dòng phân phối định kỳ — cần luật sư đánh giá riêng"* thay vì khẳng định dứt khoát một kết luận pháp lý ngay trong tiên đề kỹ thuật.

### F29. Bẫy `Number` NGƯỢC ĐỜI: tư_cách nhìn an toàn dưới 2⁵³ trong khi trung gian của nó thì không
`§3:78`, `§4:88` · toán · *chưa đối kháng, ưu tiên thấp*

**Không có tràn cứng ở đâu cả** (Plutus V3 `Int` → GHC `Integer` vô hạn; TS `BigInt` vô hạn). Trục "vỡ vì tràn": **KHÔNG tìm ra vấn đề.** Nhưng có bẫy: dev kiểm "tư_cách max = 1.24×10¹⁰ < 9×10¹⁵ ⟹ vừa Number thoải mái" — **đúng về KẾT QUẢ, sai về TRUNG GIAN**: `tuổi × tiêu = 5.5×10¹⁸` vượt 2⁵³ **610 lần** trước khi chia Q.

Định lượng tần suất P8 vỡ (dựng từ ulp, không phỏng đoán): ulp tại 5.5×10¹⁸ = 1024 ⟹ xác suất lệch/lần ≈ 1.02×10⁻⁶ ⟹ 10⁶ vault × 73 epoch = 7.3×10⁷ lần/năm ⟹ **~75 lần lệch/năm, bậc 10²**. Đủ dày để thành sự cố vận hành thường trực, **đủ thưa để không bao giờ bị bắt bởi unit test ngẫu nhiên**.

**SỬA:** §3:78 hiện chỉ một dòng "cấm Number" **không neo số nào** ⟹ không kiểm chứng được, sẽ bị bỏ qua. Thay bằng **bảng cận-trên có SỐ** (cột cuối: "vượt 2⁵³ bao nhiêu lần"): `tư_cách 1.24×10¹⁰ (34 bit, an toàn ← BẪY)` · `tuổi×tiêu 5.5×10¹⁸ (63 bit, VỠ 610×)` · `W (N=10⁶) 1.24×10¹⁹ (VỠ 1376×)` · `c × nhịp_gen ~8×10¹⁹` · `ngân_sách × Q² = 10³⁶ (120 bit)` ← **số hạng lớn nhất toàn giao thức**.
Thêm test vector: `TV-OVERFLOW-TUCACH` (`tuổi=2_200_000_000, tiêu=2_499_999_999, giờ=1_500_000_000, cam=1_500_000_000` — cài `number` là hỏng ngay), `TV-OVERFLOW-W`, `TV-OVERFLOW-NHIP`.
Ghi rõ `ngân_sách × Q² = 10³⁶` không tràn nhưng **tốn ExUnit** — [NEEDS-EVIDENCE: §5 không nói nhịp_gen được kiểm on-chain hay chỉ công bố off-chain]. **Đặt trần tường minh cho `ngân_sách_gen` và `N_vault`** — hiện cả hai không có cận trên nào.

### F30. `slots_per_epoch = 432_000` hard-code trong khi Wakeme để nó là config có profile preview nén 1440×
`§4.1:98` · auditor-onchain · *chưa đối kháng, ưu tiên thấp*

`aiken.toml [config.preview]`: `slots_per_day = 60`, `slots_per_epoch = 300` (chú thích: "NÉN clock... KHÔNG deploy thật bằng profile này"). Chạy e2e trên Preview: vault chạm Epochy sau ~16,7 giờ và bị rút cạn trong ~3,5 ngày thật, trong khi GenMAGIC tính `tuổi_epoch = 0` **suốt toàn bộ vòng đời vault** ⟹ tuổi_LAMP đứng 1.00× mãi ⟹ **không test được gì về §4.1, mọi con số M_v trên Preview vô nghĩa — mà KHÔNG có lỗi nào bật lên**. Không phải lỗ tiền mainnet (default 86400/432000, chưa có `[config.mainnet]`), nhưng là landmine cho vòng test.
**SỬA:** §4.1 đọc `slots_per_epoch` từ đúng profile instance vault đang deploy (cùng nguồn config với validator); hoặc nếu cố ý giữ đồng hồ riêng thì **ghi RÕ ở §4.1** + nêu hệ quả trên Preview. Thêm 1 dòng vào §7: profile clock của Wakeme là tham số vận hành GenMAGIC phải biết. **Kiểm trước khi chạy e2e Preview để không đọc nhầm số liệu test.**

### F31. `tuổi_LAMP` (§4.1) là mẫu tối giản đúng — trục optimizer nói thẳng "không tìm ra vấn đề"
optimizer · **CHÚ Ý: mâu thuẫn với 3 trục khác, xem C1**

Đọc thẳng field có sẵn (`vest_start_slot`) + `slot_now` (miễn phí) ⟹ **0 luồng state bổ sung**, không tự-tham-chiếu, user tự tính được 100%. Chi phí dữ liệu THẤP NHẤT trong 4 hệ số (so với `tiêu_thật` 2 luồng, `giờ_thấp_điểm` 1 luồng + EMA toàn mạng, `cam_kết_lịch` 2 luồng, 1 chưa định nghĩa). Optimizer đề xuất **GIỮ NGUYÊN**.
*(Lưu ý của em: kết luận này được đưa ra **trước** khi biết F3 — `vest_start_slot` bịa được ở genesis, PoC PASS. "User tự tính được 100%" vẫn đúng; "không cần sửa" thì không.)*

### F32. Không tìm ra vấn đề — ghi nhận trung thực (theo yêu cầu)
- **Tự-tham-chiếu `tỷ_tiêu` (§9 mục 4): HỘI TỤ, chứng minh được.** Vòng cục bộ: `M* = (B + √(B² + 6BT))/2`, `g′(M*) = B/M* − 1 ∈ (−1,0)` ⟹ hội tụ, dao động tắt dần. Vòng toàn cục với cửa sổ 6 epoch: bán kính phổ ≤ λ/3 < **1/3** ⟹ **LUÔN ổn định, biên rất rộng, với MỌI ρ***. Toán nói thẳng: ở trục này **KHÔNG tìm ra lỗi**.
 **NHƯNG — mìn chờ phải ghi vào CONTRACT:** biên ổn định này là **TÌNH CỜ, không phải thiết kế**. Nó tồn tại VÌ `đã_tiêu` và `đã_sinh` dùng **CÙNG một cửa sổ [e−6,e)** ⟹ hai tổng triệt tiêu còn 2 số hạng. Nếu ai đó "tối ưu" cửa sổ về 1-2 epoch (nghe rất hợp lý: "phản hồi nhanh hơn") ⟹ tại ρ*=1 (**đúng chế độ G4 nhắm tới!**) `z₋ = −1.1306` ⟹ **PHÂN KỲ, biên độ ×1.13/epoch ⟹ sau 40 epoch nhiễu 1% thành 132% ⟹ nhịp_gen lật dấu.**
 **SỬA — thêm bất biến có tên vào §4.2:** `INV-cửa-sổ-đối-xứng: đã_tiêu và đã_sinh PHẢI đo trên CÙNG cửa sổ nửa mở độ dài 6 epoch. Đổi ĐỘ DÀI cửa sổ = đổi biên ổn định vòng toàn cục.` Kèm 3 dòng: bán kính phổ ≤ λ/3 với cửa sổ 6; ngưỡng phân kỳ ρ* > 2/3 nếu cửa sổ = 1. **Không có dòng này, người sau sẽ tối ưu vào đúng mìn.**
- **Tràn số:** không có tràn cứng (xem F29).
- **auditor-offchain:** 0 phát hiện — **em KHÔNG coi đây là tín hiệu §6 sạch**, xem mục 0.

---

## D. QUYẾT ĐỊNH CHIẾN LƯỢC — PHẢI HỎI ANH ALADIN

Không agent nào được tự quyết những mục này.

| # | Quyết định | Vì sao phải anh | Liên quan |
|---|---|---|---|
| **S1** | **Tích-nhân vs tổng-có-trọng-số** (§4:88) | Đụng G2 ("đúng một tham số"), G3, §5, và khuôn VP-governance. **2 trục đề xuất đổi sang cộng.** Luận cứ: (a) đạo hàm riêng của tích ∝ tích các hệ số còn lại ⟹ **"giàu càng giàu"** — đúng thứ §4.2:118 tuyên bố chống (X ở 4.95× được **+7.425** cho cùng nỗ lực mà Y ở 1.00× chỉ được **+1.50** ⟹ **tỷ suất biên gấp 4,95×**); (b) tích **NHÂN BẢN bán kính sát thương** của lỗ nghiêm trọng nhất (D1: tích ⟹ +150%; tổng ⟹ +32% ⟹ **tích khuếch đại 4,7×**); (c) **dải hữu ích của tích ở cân bằng CHỈ 2.50×**, không phải 12.375× (3/4 hệ số là hằng số ⟹ triệt tiêu trong chuẩn hoá §5:172) ⟹ **chuyển sang tổng MẤT 0 khả năng phân biệt, chi phí chuyển đổi = 0**; (d) §4:91 biện minh tích bằng "cùng khuôn VP governance" — **phép loại suy này KHÔNG chuyển được: VP nhân 4 tham số ĐỀU TỐN KÉM cho một lá phiếu khan hiếm; ở đây 3/4 hệ số MIỄN PHÍ. Sao chép hình dạng hàm mà không sao chép cấu trúc chi phí là lỗi thiết kế.** Đề xuất cụ thể: `tư_cách = Q + ⌊(w₁·r_tuổi + w₂·r_tiêu + w₃·r_thấp + w₄·r_cam)/Q⌋`, Σwᵢ = 1.5Q, `w_tiêu = 0.90Q` (60% dải — đúng G4), `w_tuổi = 0.30Q`, `w_thấp = 0.20Q`, `w_cam = 0.10Q` ⟹ **G4 thành bất biến số học kiểm được: `ôm_max = 1.60× < tiêu_ở_K/M=0.2 = 1.66×`** (dưới tích cần K/M > 13.3%) | F8, F12, F24 |
| **S2** | **`tuổi_LAMP` — giữ / hạ trần / rút khỏi tư_cách / đổi sang thứ-hạng-cohort** | **4 trục MÂU THUẪN — xem C1** | F27, F24, F31 |
| **S3** | **`giờ_thấp_điểm` — bỏ hẳn / gắn thang / lịch-công-bố-trước / chỉ áp cho service dời-được** | Hệ số này **vừa không đo được** (F10: FlowRate sai 3 tầng, phải xây bộ đếm mới + neo ≥120 bucket/epoch trong §6 — hạng mục kiến trúc mới), **vừa phản tác dụng khi đo được** (F21: đỉnh/TB xấu đi 3.3×, thưởng bot phạt người thật), **vừa không kiểm chứng được** (F20: engine gán nhãn tuỳ ý, không ai chứng minh được), **vừa chiếm 1/4 thừa số tư_cách**. Bỏ hẳn ⟹ dải tư_cách 12.375× → **8.25×**, w_max ở §5 từ 2.25 → 1.5, hệ đơn giản hơn, **và mất 0 chức năng nếu danh mục "dịch vụ cầu dời-được" là rỗng**. **Câu hỏi anh phải trả lời trước: dịch vụ nào trong hệ có cầu DỜI ĐƯỢC?** | F9, F10, F20, F21 |
| **S4** | **Ration-pro-rata cứng thay van 1.25× + bù kỳ sau** | Đổi **phát biểu G3** từ "bám trung bình trượt" sang "≤ ngân sách TỪNG epoch, chứng minh được". Đổi luôn hợp đồng với user: đầu epoch biết **cận TRÊN** thay vì biết **con số**. Ration làm **F6 biến mất hoàn toàn** (w ≤ 1 ⟹ Err ≤ 0 ⟹ không bao giờ sinh nợ). Nhưng đây là ràng buộc **BẢO CHỨNG** — trung bình trượt trên bảo chứng = **dự-trữ-một-phần** | F5, F6, F22 |
| **S5** | **`cam_kết_lịch` — chọn cách đọc (i) hứa-tương-lai vs (ii) khoá-hiện-tại; và nếu giữ thì tốn kém bằng gì** | Nếu (ii) thì **§8 #2 + hệ quả G9(a)/(c) PHẢI viết lại** — không được tuyên bố "không tích luỹ". Nếu (i) thì phải có chi phí bất khả hồi hoặc **XOÁ hệ số**. Và: `pp_sched` **có được vào `ngân_sách_gen` không** (§5:170) — chiều dấu đang [NEEDS-EVIDENCE] | F7, F23 |
| **S6** | **Bind `đã_tiêu` vào CARP ĐÃ QUYẾT TOÁN + final (k=5); dời cửa sổ [e−6,e) → [e−7,e−1)** | Đây là **đòn chống-wash duy nhất khả thi mà MAGIC tự làm được** (vòng lặp âm tiền tuyệt đối ⟹ D1 chết về kinh tế, không cần Registry). Nhưng nó **chặn bởi D4** (settlement chưa chốt). **Giữ ĐỘ DÀI cửa sổ = 6** (xem C4) | F12, F17, F24 |
| **S7** | **`MIN_MAGIC_TX`: tuyệt đối → tỷ lệ (θ)** | Thuộc Wakeme (I-ACT-3) nhưng **định nghĩa phải do MAGIC cấp** vì MAGIC giữ sổ tiêu. `Math:304` ghi "TẠM" ⟹ **đúng thời điểm gửi inbox PhoenixKey, đừng chờ** | F25 |
| **S8** | **Nén cơ số `c` (căn/log) hay chấp nhận + viết lại G4** | Đụng tính đo-lường-được đơn giản + G3/§5. Nếu chấp nhận thì **G4 phải viết lại — nó đang hứa thứ hệ không giao** | F24 |

---

## E. MÂU THUẪN GIỮA CÁC TRỤC — em KHÔNG phân xử, anh quyết

### C1. `tuổi_LAMP` — **4 trục, 4 kết luận khác nhau**
| Trục | Nói gì |
|---|---|
| **optimizer** | **"GIỮ NGUYÊN, không cần sửa"** — mẫu tối giản đúng, 0 luồng state, user tự tính 100%, chi phí dữ liệu thấp nhất trong 4 hệ số. Dùng làm chuẩn đối chiếu cho 3 hệ số kia. |
| **critic-legal** | **RỦI RO PHÁP LÝ** — thưởng chính xác theo thời gian nắm giữ, không đòi hỏi hoạt động nào = **mô tả giáo khoa của lãi suất kỳ hạn**; tái hiện đúng đặc điểm mà lá chắn cổng-tiêu-thật cũ được dựng để tránh. §8 phải trình bày riêng, không được ẩn trong so sánh tương đối. |
| **game-theorist** | **RÚT KHỎI tư_cách hoặc HẠ TRẦN MẠNH** — ở trạng thái dừng (sau ngày 120) nó là **hằng số 2.20 cho mọi người** ⟹ **triệt tiêu trong chuẩn hoá §5:172** ⟹ không phân biệt được ai với ai; chỉ tạo lợi thế theo NGÀY ĐĂNG KÝ trong 120 ngày đầu (người vào ngày 500 chịu **45% suất** của người cũ suốt 24 epoch — **hình phạt onboarding thuần lịch, không hành vi**). Nếu giữ, phải nói thẳng nó là **cơ chế launch-window**, không phải "trung thành". |
| **adversary** | **ĐỔI SANG THỨ-HẠNG-COHORT** — `TRẦN_TUỔI=24` + `BƯỚC_TUỔI=0.05Q` đang **CỘNG THÊM** lợi thế cho đúng cohort vào sớm (họ già trước, và họ cũng là cohort có c cao nhờ pot đầy). **Hai hiệu ứng cùng chiều, NHÂN nhau.** Tính tuổi theo thứ hạng trong cohort thay vì tuổi tuyệt đối. |

**Ghi chú của em (không phải phân xử):** optimizer đưa kết luận **trước khi biết F3** (vest_start_slot bịa được, PoC PASS). "User tự tính được 100%" vẫn đúng; "không cần sửa" thì không — ít nhất phải kẹp `max(0, ·)`. Ba trục còn lại không mâu thuẫn nhau về **chẩn đoán** (đều nói tuổi_LAMP hoặc vô dụng hoặc nguy hiểm), chỉ khác về **liều thuốc**. Mâu thuẫn thật là optimizer vs 3 trục kia.

### C2. Cách sửa lỗi Q (§5:172) — **2 trục, 2 cấu trúc**
- **toán:** giữ nguyên cấu trúc, `nhịp_gen(e) = ⌊ngân_sách × Q² / max(W(e−1), 1)⌋`. Tối thiểu, không đụng §3.
- **trò-chơi:** đổi cấu trúc + **đảo thứ tự nhân**: `w_v = ⌊c_v × tư_cách_v / Q⌋` (đơn vị LAMP-hiệu-dụng); `W = Σ w_v`; `nhịp_gen = ⌊ngân_sách × Q / max(W(e−1),1)⌋`; `M_v = ⌊w_v × nhịp_gen / Q⌋`.

**Không mâu thuẫn về KẾT QUẢ** (cả hai cho `Σ M_v ≈ ngân_sách`), nhưng khác về TÍNH CHẤT: cách của trò-chơi **cũng đẩy lùi cổng floor-về-0 (F1) đi ~5×** vì tư_cách vào TRƯỚC khi floor theo c, và số hạng lớn nhất giảm từ 10³⁶ xuống ~10²⁷ (đỡ ExUnit nếu kiểm on-chain). Đánh đổi: đổi §3:71 nên phải rà lại §3:81 và mọi test vector. **Anh chọn.**

### C3. `cam_kết_lịch` — 3 trục, 3 mức triệt để
- **optimizer:** **GỘP** `magic_cam_kết` vào tử số `đã_tiêu` của §4.2, **bỏ hẳn hệ số riêng** ⟹ 4→3 hệ số, −1 bước floor-div/epoch/vault, −1 luồng state cần audit, **và loại bỏ luôn khái niệm `sinh_kỳ_vọng` chưa định nghĩa**. Đánh đổi: mất khả năng hiển thị riêng "thưởng vì cam kết lịch" trên dashboard; cần chốt lại TRẦN_TIÊU (vd ~1.7Q).
- **toán:** GIỮ hệ số, chọn **cách đọc LÙI** (= `đã_sinh`), vá `max(·,1)` cho hồ sơ mới.
- **game-theorist / adversary:** GIỮ chỉ khi có **chi phí bất khả hồi** hoặc **counterparty bonded**; chưa có thì **KHOÁ ở sàn 1.0×** — *"thà mất chức năng còn hơn cho không 1.5×"*.

Ba mức này **tương thích về hướng** (đều nói hệ số hiện tại vô giá trị), nhưng cho 3 kết quả khác nhau về §4 và §8. **Anh chọn — gắn với S5.**

### C4. Cửa sổ [e−6, e) — hai đề xuất DỊCH, một cảnh báo về ĐỘ DÀI
- **adversary (S6):** dời sang **[e−7, e−1)** để chừa 1 epoch cho CARP settlement final (k=5).
- **toán (F32):** cửa sổ 6 epoch là **LOAD-BEARING cho ổn định** — bán kính phổ ≤ λ/3. **Rút NGẮN xuống 1-2 epoch ⟹ phân kỳ tại ρ*=1.**

**Không mâu thuẫn nếu đọc kỹ:** dịch cửa sổ (giữ độ dài 6) không đụng biên ổn định — phép triệt tiêu chỉ cần hai tổng CÙNG cửa sổ, không cần cửa sổ bắt đầu ở đâu. **Nhưng phải ghi rõ trong CONTRACT**, vì hai thay đổi này sẽ được người khác đọc rời nhau và rất dễ ai đó "gộp tối ưu" thành rút ngắn.

### C5. §4.3 `giờ_thấp_điểm` — 3 công thức sửa, 1 đề nghị xoá
- **toán:** **BỎ HẲN** (vừa không đo được, vừa phản tác dụng).
- **game-theorist:** chuẩn hoá mẫu số về `đã_sinh` **HOẶC** thay bằng **lịch công bố trước, tất định** (giữ "user đo lường được").
- **adversary:** gắn thang bằng `tỷ_tiêu` (**hoá ra ĐỒNG NHẤT với chuẩn-hoá-theo-đã_sinh**, xem F9) + chỉ áp cho `service_id` dời-được.

Ba đề xuất **hội tụ về công thức** nhưng **phân kỳ về việc có giữ hệ số hay không**. → **S3.**

---

## F. ĐÃ LOẠI + VÌ SAO

**RỖNG — không có phát hiện nào bị loại.**

Lý do: đối kháng chưa chạy (mục 0). Cả 47 phát hiện đều mang cùng một nhãn template `CHƯA qua đối kháng (mức TRUNG/THẤP)` — không có phán quyết `bác_bỏ_hoàn_toàn` nào để em thi hành. Em **không tự bác thay hội đồng đối kháng** — đó là vượt quyền và làm mất chính giá trị của bước đối kháng.

Ba mục em ĐÃ tự kiểm chứng độc lập và **CONFIRM** (nên chúng KHÔNG cần đối kháng nữa): T-3 đọc ngược nguồn (F11), §7 D1 sai chủ (F12a), đụng số hiệu blocker (F12a).

Bảy mục có **PoC ĐÃ CHẠY THẬT** (aiken 1.1.21, code v5 `3d5fdce`) — theo em, đối kháng với một test PASS là vô nghĩa; việc cần làm là **tái lập PoC**, không phải tranh luận: F2 (`poc1`), F3 (`poc4a`, `poc4b`), F13 (`poc2`), F14 (`poc3`).

---

## G. VIỆC PHẢI LÀM TRƯỚC KHI ĐÓNG HỘI ĐỒNG

1. **Chạy lại trục `auditor-offchain`** — 0 phát hiện trên §6 trong khi trục khác đào được 4 lỗ nặng ở đó là tín hiệu trục hỏng.
2. **Chạy đối kháng thật** — hiện chưa có trục nào phản biện 47 phát hiện này. Ưu tiên đối kháng: F5/F6 (chứng minh toán, cần kiểm lại đại số), F8 (3 trục ra 3 con số khác nhau — cần chốt con số nào đúng), F22 (định lượng f dựa trên giả định hành vi).
3. **Tái lập 5 PoC** trên máy độc lập trước khi báo PhoenixKey.
4. **Rà toàn CONTRACT tìm trích dẫn đọc ngược nguồn khác** (F11 mục 4) — một lỗi loại này đã lọt thì phải giả định còn nữa.
5. **Gửi inbox PhoenixKey** (3 việc, không tự sửa repo Wakeme): (a) `genesis_vault_ok` ép `vest_start_slot == tx_lo` + bổ sung vào I-ACT-1; (b) `gen_drip_ok` ép địa chỉ đầy đủ + gate `keeper_signed ∨ owner_signed`; (c) đề xuất `MIN_MAGIC_TX` → ngưỡng tỷ lệ θ (`Math:304` đang "TẠM" — đúng lúc).
6. **Đẩy `magic-globalstate-brq-2026-07-16.md`** lên ưu tiên cao nhất — nó chặn cả `ngân_sách_gen` (§5) lẫn đòn chống-wash duy nhất khả thi (S6).

## §2. Phán quyết đối kháng THẬT

### [ĐÚNG_MỘT_PHẦN] [CAO] cam-kết-lịch (§4.4) là hệ số thứ 4 tốn state riêng nhất trong khi hiệu ứng gần như đã được tiêu-thật (§4.2) hấp thụ được — nên gộp CÁCH TÍNH, không cần một tầng nhân riêng
**Điều kiện:** CHỈ đúng ở phần chẩn đoán, KHÔNG đúng ở đơn thuốc. Giữ nguyên phần: `sinh_kỳ_vọng_6_epoch` và `magic_cam_kết_đang_hiệu_lực` chưa định nghĩa = gap thật, phải vá. Bác bỏ phần: gộp vào tử số §4.2. Cách vá đúng là ĐỊNH NGHĨA mẫu số (ví dụ `sinh_kỳ_vọng_6_epoch := đã_sinh` cùng cửa sổ [e−6,e) của §4.2, và `magic_cam_kết_đang_hiệu_lực` = per-DID, phân biệt rõ với `pp_sched` toàn mạng ở dòng 62) — tốn 0 luồng state mới, giữ nguyên kinh tế, đạt trọn mục tiêu optimizer mà phát hiện nêu.
XÁC NHẬN (phần chẩn đoán): grep toàn repo (trừ Legacy) — `sinh_kỳ_vọng_6_epoch` xuất hiện ĐÚNG 1 lần, tại CONTRACT:143, không có công thức ở bất cứ đâu; `magic_cam_kết_đang_hiệu_lực` cũng ĐÚNG 1 lần, cũng không định nghĩa. Dòng 62 chỉ cấp `pp_sched` mức TOÀN MẠNG, còn §4.4 cần per-DID — khác cỡ hạt, gap thật. Dòng 146 ('chuẩn hoá theo khả năng sinh của chính hồ sơ') là gợi ý, không phải công thức. Số học phản ví dụ đúng: 1.30×1.15=1.495 vs 1.30×1.10=1.43, lệch 4.55%.

BÁC BỎ (đơn thuốc gộp) — 4 lý do, lý do 1 là chí mạng:

1. GỘP LÀM LẬT TIÊN ĐỀ G4, không phải 'gộp CÁCH TÍNH'. Phản ví dụ (cùng cửa sổ 6 epoch, đã_sinh=1000): hồ sơ Y = ôm-giữ già + cam kết lịch, tiêu THẬT = 0, cam_kết=1000. HIỆN TẠI (CONTRACT:88,115,129,144): tuổi 2.20 × tiêu_thật 1.00 × thấp_điểm 1.00 (dòng 136: đã_tiêu=0 ⟹ sàn) × cam_kết_lịch 1.50 = 3.30×. Người tiêu thật (0 tuổi, tiêu hết, thấp điểm): 1.00×2.50×1.50×1.00 = 3.75× > 3.30× ⟹ G4 giữ, khớp kiểm ở dòng 159-161. GỘP: đã_tiêu'=0+1000 ⟹ tỷ_tiêu'=1.0 ⟹ tiêu_thật'=2.50 ⟹ Y = 2.20×2.50×1.00 = 5.50× > 3.75× ⟹ NGƯỜI KHÔNG TIÊU GÌ ĂN ĐỨT NGƯỜI TIÊU THẬT. Gộp = định giá 'ý định dùng' bằng đúng giá 'đã dùng', tức gán cho cam-kết dải 2.5× trong khi §4.5 (dòng 153-157) CỐ Ý cho nó dải hẹp nhất 1.5×. Kéo theo §8 dòng 234 ('người tiêu-thật hơn 2.6×') thành SAI về số học ⟹ lá chắn pháp lý sập, đúng thứ §8 dựa vào. Phát hiện tự thừa nhận 'cam kết về bản chất KHÁC tiêu thật' rồi vẫn tính nó cùng tử số — mâu thuẫn nội tại.

2. GỘP PHÁ BẤT BIẾN DẪN TỪ G9 (dòng 32-34): 'đã_tiêu/đã_sinh mỗi epoch LUÔN ≤ 1 ⟹ tỷ_tiêu chính là tỷ-lệ-tận-dụng-suất, có nghĩa vật lý rõ'. Cam kết là MAGIC khoá trong hợp đồng tương lai, KHÔNG bị chặn bởi đã_sinh trong cửa sổ. Ví dụ cam_kết=900, đã_tiêu=200, đã_sinh=1000 ⟹ tử số 1100 > 1000 ⟹ min(Q,·) từ 'không bao giờ chạm' thành 'chạm thường xuyên' ⟹ tỷ_tiêu mất nghĩa vật lý, hệ quả (b) của G9 hỏng. Gộp còn đẻ ra mơ hồ MỚI: §4.3 dòng 128 dùng `max(đã_tiêu,1)` làm mẫu số — sau khi gộp thì là đã_tiêu hay đã_tiêu'? Đơn thuốc chữa 1 chỗ mơ hồ, tạo 1 chỗ mơ hồ khác.

3. LỢI ÍCH OPTIMIZER GẦN BẰNG 0 — hàm mục tiêu của phát hiện không được thoả. (a) 'Giảm luồng state': SAI — công thức gộp VẪN cần `magic_cam_kết_đang_hiệu_lực` (chính là +300 trong tử số). Gộp chỉ bỏ được `sinh_kỳ_vọng`, mà chính phát hiện đã thừa nhận 'nếu nó = đã_sinh thì không tốn thêm data' ⟹ chỉ cần ĐỊNH NGHĨA là bỏ được, không cần gộp. Lợi ích ròng của gộp so với định-nghĩa = 1 bước floor-mul-div. (b) 'Giảm bước nhân': CONTRACT:197 ghi rõ 'TRONG EPOCH (0 giao dịch L1 cho gen)', Wakeme-Math:198 xác nhận 'Engine MAGIC NGOÀI validator này' ⟹ đây là BigInt op trong tiến trình off-chain, không tốn ExUnit, không tốn phí. Tiết kiệm 1 phép nhân/vault/epoch không phải mục tiêu tối ưu. Ngược lại dòng 77 quy định nhân-chia-floor tuần tự chính là để 'bó sai số/epoch' — bỏ bước không hiển nhiên là lãi.

4. NEO SAI: (a) P8 'bit-identical Aiken/TS' không áp dụng — không tồn tại phía Aiken cho `tư_cách` (Wakeme-Math:198; CONTRACT:194-204 chốt engine = kế toán off-chain). Kênh thiệt hại THẬT mạnh hơn mà phát hiện bỏ lỡ: CONTRACT:102 và 176-177 bắt buộc 'user tự tính chính xác M_v của mình' — mẫu số không định nghĩa ⟹ USER không tính được ⟹ vi phạm thẳng yêu-cầu-đo-lường-được, và độ lệch KHÔNG chặn ở 4.5% mà vô hạn (implementer thứ ba đọc 'kỳ vọng' theo share-ngân-sách ra số bất kỳ). (b) §9 mục 11 (dòng 253, 'chưa định lượng bond') nói về bề-mặt-gian-sổ của sổ off-chain per-delta có cosign (§6 dòng 200, 211), KHÔNG phải về số hệ số nhân. `magic_cam_kết` đến từ state ScheduleGen qua reference_input (dòng 60-62) — nằm NGOÀI sổ off-chain, được validator ScheduleGen bảo toàn, không cần cosign. Tách riêng như hiện tại là AN TOÀN HƠN; gộp nó vào tử số của một đại lượng gốc-sổ-off-chain là kéo dữ liệu on-chain vào vùng tin-cậy-operator — ngược đúng hàm mục tiêu 'giảm bề mặt gian sổ' mà phát hiện tự đặt ra.

### [GIỮ_NGUYÊN] 1. [NGHIÊM TRỌNG] Bất biến bắc cầu §2 thiếu tiền đề xác thực vault-NFT của reference_input
Em cố bác bỏ nhưng không bác được phần cốt lõi. CONTRACT dòng 53-55 nói thẳng "không cần engine kiểm" và "GenMAGIC KHÔNG CẦN lớp chống-khai-man số dư riêng" — đây là khẳng định CHỦ ĐỘNG rằng không cần kiểm, không phải chỉ là bỏ sót. Nhưng bất biến (SỔ-VALUE) `L(vault) == c × oil` chỉ được validator ép tại UTxO ĐI QUA validator (Wakeme-Math:98, 236, 331 — liệt kê đúng 4 điểm ép: genesis_vault_ok/gen_drip_ok/reclaim_ok/reclaim_epoch_ok). UTxO không đi qua validator thì bất biến không tồn tại. Tiền đề "phải là vault thật" là bắt buộc và CONTRACT không nêu. Không nguồn nào trong 4 nguồn quy định engine định danh vault thế nào — em đã grep Vault-Scale-Analysis, không có dòng nào về index/địa chỉ/NFT (chỉ dòng 167 proof, 327 ref Mosaic). Gap thật, phải vá bằng một dòng minh thị: engine CHỈ đọc UTxO tại `Script(own_hash)` mang đúng vault-NFT `(policy=own_hash, name=owner_commit)` — neo Wakeme-Tech:72, 75, 188.

HAI CHỖ PHÁT HIỆN NÓI QUÁ, phải sửa khi đưa vào báo cáo:
(a) Câu "toàn bộ tài liệu không có một dòng nào nhắc NFT" là SAI. CONTRACT:45 ("khoá định danh vault (= vault-NFT name)") và CONTRACT:57 ("vault-NFT singleton name = owner_commit") đều nhắc. Nhưng cả hai chỉ MÔ TẢ, không YÊU CẦU engine kiểm ⟹ kết luận vẫn đứng. Thực ra dòng 57 làm phát hiện MẠNH THÊM: chính lập luận chống-Sybil ("không thể Sybil đa-vault trên cùng DID") cũng dựa vào vault-NFT singleton mà không ai kiểm — UTxO giả với did_commit bịa khác nhau = Sybil vô hạn, không cần DID nào.
(b) "Mint MAGIC vô hạn, không giới hạn" là SAI về mô hình thiệt hại. G6: MAGIC không mint. Và §5:171-172 dùng `tổng_trọng_số(e−1)` làm MẪU SỐ của `nhịp_gen` ⟹ vault giả vào mẫu số làm `nhịp_gen` co lại ⟹ TỔNG phát vẫn bám ngân sách. Đây là tấn công ĂN CẮP PHẦN CHIA (dilution), không phải lạm phát tuyệt đối: kẻ tấn công 0 LAMP dựng đủ UTxO giả để chiếm 99% ngân sách gen mỗi epoch, user thật nhận gần 0. Vẫn thảm hoạ, nhưng phải mô tả đúng cơ chế.
Số học kịch bản đúng: conditional_lamp=1001 (trần d_cap Wakeme-Math:33), vest_start 25 epoch ⟹ min(25,24)×0.05Q ⟹ tuổi_LAMP=2.20× (CONTRACT:99, TRẦN_TUỔI=24).

### [ĐÚNG_MỘT_PHẦN] 2. [CAO] Kiểm G4 §4.5 đặt cam_kết_lịch=1.0× cho người ôm-giữ mà không chứng minh
**Điều kiện:** Đúng khi (a) cam kết MAGIC vào ScheduleGen KHÔNG tính là "tiêu" và không cần đối tác thật (CONTRACT không nói gì ⟹ không loại trừ được); VÀ (b) MAGIC đã cam kết sống qua reset G9 để `magic_cam_kết_đang_hiệu_lực > 0` bền vững. Cả (a) và (b) đều là câu hỏi đang treo ở §9 mục 10. Việc phải làm không phụ thuộc điều kiện: §4.5 buộc phải chứng minh cam_kết_lịch=1.0× cho người không tiêu, hoặc sửa lại con số; và §7 phải thêm dòng rủi ro cho cam_kết_lịch.
PHẦN ĐÚNG (không bác được): §4.5:159 viết nguyên văn "ôm-giữ tối đa KHÔNG TIÊU = 2.20 × 1.0 × 1.0 × 1.0 = 2.20×". Điều kiện tự đặt là "không tiêu", nhưng công thức cam_kết_lịch (§4.4:143-144) KHÔNG chứa biến nào của tiêu_thật — nó chỉ so `magic_cam_kết_đang_hiệu_lực` với `sinh_kỳ_vọng_6_epoch`. Vậy hệ số thứ tư = 1.0 là GIẢ ĐỊNH KHÔNG DẪN ĐƯỢC từ §4.4. Số học của phát hiện đúng hết: 2.20×1.0×1.0×1.5 = 3.30; 5.63/3.30 = 1.706 ≈ 1.71; đối chiếu 5.63 = 1.0×2.5×1.5×1.5 = 5.625 ✓; trần tích 2.20×2.50×1.50×1.50 = 12.375 khớp §4.5:157 ✓. Khoảng trống MECE ở bảng §7:220-226 cũng đúng: D1 chỉ ghi wash-trade cho `tiêu-thật`+`giờ-thấp-điểm`, không có dòng nào cho `cam_kết_lịch`.

PHẦN KHÔNG CHỨNG MINH ĐƯỢC (vì sao không cho giữ_nguyên): kịch bản "X đạt 3.30×" cần ScheduleGen có ngữ nghĩa cụ thể, mà CONTRACT KHÔNG định nghĩa ScheduleGen ở đâu cả — chỉ nhắc tên (G1:22, §2:62 `pp_sched`, §4.4). Chính CONTRACT §9 mục 10:252 đang treo câu hỏi này: "G9 decay reset có phá cam-kết-lịch không (cam kết MAGIC tương lai trên suất sẽ reset)?". Nếu G9 (MAGIC reset mỗi epoch, không tích luỹ — §1:30-32) làm MAGIC cam kết bốc hơi cuối epoch thì `magic_cam_kết_đang_hiệu_lực` có thể không giữ được > 0 mà không tiêu. Phát hiện gánh nghĩa vụ chứng minh và chưa trả được. Kết luận đúng phải phát biểu ở mức: con số 2.20× của §4.5 CHƯA ĐƯỢC CHỨNG MINH, kéo theo con số 2.6× ở lá chắn pháp lý §8:234 cũng chưa chứng minh — chứ không phải "đã sai, thực tế 3.30×".

### [BÁC_BỎ_HOÀN_TOÀN] 3. [CAO] Lá chắn pháp lý (1) bỏ qua đường vòng CARP-settlement
Cơ chế của phát hiện NGƯỢC CHIỀU so với chính nguồn nó trích. Phát hiện viết: "Treasury settle CARP về cho A với vai trò provider (theo §6)" rồi "A bán CARP lấy ADA/fiat". Nhưng CARP chảy TỪ provider VỀ Treasury, không có chiều ngược lại — 6 chỗ nói thống nhất, không một chỗ nào nói ngược:
· CONTRACT §6:203 "anchor Merkle root + net CARP → Treasury" — ĐÂY LÀ NEO CỦA CHÍNH PHÁT HIỆN, và nó ghi mũi tên → Treasury. Phát hiện tự mâu thuẫn với neo của mình.
· Vault-Scale-Analysis:64 "chuyển CARP về Treasury"; :69 "provider tổng hợp toàn bộ biến động → một giao dịch settlement chuyển CARP về Treasury"; :240 "chuyển CARP về Treasury (net của epoch)"; :245 "Cuối epoch: 1 tx chốt root + CARP→Treasury"; :285 "1 anchor tx/provider/epoch commit Merkle root + CARP→Treasury".
· Quyết định nhất: :90 và :294 gọi tên rủi ro là "provider mất khả năng TRẢ CARP cuối epoch" — provider là bên PHẢI TRẢ CARP, không phải bên NHẬN. :310 T-RECONCILE: "số dư Vault mới = cũ − net".
⟹ Đóng vai provider là vị thế ÂM CARP: nhận MAGIC (không chuyển nhượng) và PHẢI TRẢ CARP ra. Kịch bản A tự-tiêu qua dịch vụ ma không tạo dòng tiền — nó tạo NGHĨA VỤ TRẢ CARP cho Treasury. Đường rút giá trị mà phát hiện mô tả không tồn tại trong 4 nguồn.

Neo "Self-consumption HỢP LỆ" (Wakeme-Tech:388) cũng yếu: câu đó nằm trong ghi chú map field cho endpoint `vault/{did}`, gắn với `activity_gate.used_this_period = null` — tức nói về activity_gate, chính là cổng-tiêu-thật ĐÃ CHẾT theo CONTRACT:11. Trích một ghi chú về cơ chế đã chết để chứng minh hành vi của mô hình sống là không vững.

GHI LẠI ĐỂ KHÔNG MẤT (phần lõi hợp lệ nhưng phát hiện KHÔNG hề lập luận): bước nhảy "không bán được ⟹ không thể là thu-nhập" ở §8:233 vẫn hở về logic, vì không-chuyển-nhượng ≠ không-có-giá-trị — MAGIC mua được dịch vụ thật, lợi ích tiêu dùng quy đổi được. Nhưng đó là một phản biện KHÁC, không phải phản biện đã nộp. Phát hiện như đã viết bị bác.

### [ĐÚNG_MỘT_PHẦN] 4. [CAO] Lá chắn pháp lý (2) so sánh tương đối, không phủ được đặc tính lãi-suất của tuổi-LAMP §4.1
**Điều kiện:** Đúng khi đọc như phê bình CẤU TRÚC LẬP LUẬN của lá chắn (2): nó tương đối, và nó tự mâu thuẫn với §4.5:159. Việc phải làm: §8 bỏ câu "người ôm chỉ được sàn" (sai theo chính §4.5), và nếu muốn chống khung lãi-suất thì phải nêu căn cứ TUYỆT ĐỐI (G7 không hoàn vốn + G9 không tích luỹ + c bào ở Epochy), không dùng tỷ số 2.6× — nhất là khi con số 2.6× đó còn chưa chứng minh (xem phát hiện 2). SAI khi đọc như khẳng định kinh tế rằng tuổi-LAMP LÀ lãi suất — G7 + G9 bác điều đó.
PHẦN ĐÚNG (không bác được): §8:234 đúng là lập luận THUẦN TƯƠNG ĐỐI ("người tiêu-thật hơn 2.6×"), không nói gì về mức tuyệt đối. Số học kiểm lại đúng: B giữ 0 epoch ⟹ Q + min(0,24)×0.05Q = Q = 1.00×; C giữ 24 epoch ⟹ Q + 24×0.05Q = 2.2Q = 2.20×; tỷ số 2.2 ✓ (CONTRACT:99, 101). §4.1:103 tự xác nhận "đơn điệu tăng ngặt theo tuổi", không đòi hỏi hoạt động nào khác. Và em tìm ra một MÂU THUẪN NỘI BỘ mà phát hiện chưa nêu, nó còn mạnh hơn lập luận của phát hiện: §8:234 viết "người ôm CHỈ ĐƯỢC SÀN" trong khi §4.5:159 viết "ôm-giữ tối đa = 2.20×". Sàn là 1.00×. 2.20× ≠ sàn. Hai câu trong cùng một tài liệu chọi nhau, và lá chắn pháp lý đang đứng trên câu sai.

PHẦN NÓI QUÁ (vì sao không giữ_nguyên): gọi tuổi-LAMP là "mô tả giáo khoa của lãi-suất tích luỹ theo kỳ hạn" là SAI trên ba điểm mà phát hiện bỏ qua, cả ba đều nằm trong nguồn:
· G9 (§1:30-32): MAGIC KHÔNG TÍCH LUỸ — không tiêu là mất, không cộng dồn. "Tích luỹ" là chữ sai; đây là hệ-số-suất trên một khoản tín-dụng mau hỏng.
· G7 (§1:28) + Wakeme-Math:110: user KHÔNG BAO GIỜ nhận LAMP, LAMP rời vault CHỈ về pot. Không có hoàn vốn ⟹ không có "vốn + lãi".
· §4.1:104: pha Epochy bào `c` ⟹ chính "vốn gốc" bị tiêu dần (khớp Wakeme-Math:130: ReclaimEpoch là ĐƯỜNG DUY NHẤT →pot ở Epochy; I-ACT-8 đường LAMP→user đã RESERVED, vô hiệu hoá).
Một công cụ không hoàn vốn, lợi tức bốc hơi mỗi kỳ, hệ số chặn trần ở 24 epoch — không phải lãi suất theo bất kỳ nghĩa giáo khoa nào. Phát hiện cũng đánh §8 lá chắn (2) tách rời trong khi lá chắn (3) tấm-pin (§8:235) mới là chỗ trả lời khung "lãi suất".

### [GIỮ_NGUYÊN] 5. [CAO] Van cứng 1.25× §5 chặn sai trục — không chạm rủi ro tổng_trọng_số tăng vọt
Em dựng lại toàn bộ đại số và phát hiện ĐÚNG. Đặt Ŵ(e) = tổng_trọng_số thực. Từ §5:171-172: nhịp_gen(e) = ngân_sách_gen(e)×Q/Ŵ(e−1). Tổng phát trong epoch e = Σ_v M_v(e) ∝ nhịp_gen(e) × Ŵ(e). Thay vào:
  tổng_phát(e) / ngân_sách_gen(e) = Ŵ(e) / Ŵ(e−1).
Tỷ số vượt-ngân-sách phụ thuộc ĐÚNG MỘT đại lượng: Ŵ(e)/Ŵ(e−1). Van cứng (§5:182) ràng buộc nhịp_gen(e) ≤ nhịp_gen(e−1)×1.25 — nó KHÔNG xuất hiện trong biểu thức trên. Van không chặn được thứ nó được quảng cáo là chặn.

Tệ hơn thế: van NGHỊCH BIẾN với chính rủi ro. Ŵ tăng ⟹ mẫu số của nhịp_gen tăng ⟹ nhịp_gen GIẢM ⟹ van (một chặn TRÊN) càng lỏng. Đúng lúc cần nhất thì van chắc chắn không kích hoạt. Van chỉ siết khi nhịp_gen MUỐN TĂNG, tức khi ngân_sách tăng hoặc Ŵ(e−1) SỤT — nguyên nhân khác hẳn nguyên nhân §5:180 mô tả. Gọi "hai lớp vá" cho cùng một rủi ro là không chính xác; chỉ có lớp "bù kỳ sau" chạm tới, và nó ex-post.

Kiểm phản ví dụ: Ŵ(e−2)=Ŵ(e−1)=1000, ngân_sách phẳng ⟹ nhịp_gen(e)/nhịp_gen(e−1) = 1.0 ≤ 1.25 ⟹ van lỏng ✓. Ŵ(e)=5000 ⟹ tổng phát = 5× ngân sách trong MỘT epoch, van mù hoàn toàn ✓ (phản ví dụ nhất quán, cần Ŵ(e−2)≈Ŵ(e−1) và điều đó thoả).

MỘT LỖI TRONG KỊCH BẢN, phải sửa khi báo cáo (không phá kết luận): "nhiều vault cùng vượt NGƯỠNG tuổi_LAMP 6-epoch" — KHÔNG CÓ ngưỡng nào như vậy. §4.1:99 là tuyến tính từ epoch 0: `Q + min(tuổi_epoch,24)×0.05Q`. Con số "6 epoch" ở dòng 95 là lời anh nói, không phải bậc thang trong công thức. Riêng tuổi_LAMP chỉ đẩy Ŵ tối đa +5%/vault/epoch, KHÔNG thể 5× trong một epoch. Nhưng động cơ đúng nằm ngay trong chính kịch bản: "nhiều vault được tạo cùng lúc" — genesis vault mới cộng THẲNG số hạng c_v mới vào Ŵ, không bị chặn trên nào ⟹ Ŵ 5× hoàn toàn đạt được lúc ra mắt. Phản ví dụ sống, chỉ cần đổi động cơ.

Hai điểm em kiểm thêm, đều làm phát hiện nặng hơn: (a) G9 (§1:30-32) khiến windfall KHÔNG THU HỒI ĐƯỢC — MAGIC phải tiêu trong epoch nếu không mất, tiêu rồi thì đã thành nghĩa vụ CARP settle cuối epoch (Vault-Scale-Analysis:240), bù ở e+1 là bù vào hư không; (b) bù kỳ sau cho vượt 4× ngân sách có thể đẩy ngân_sách_gen(e+1) xuống ÂM — CONTRACT không nói xử lý thế nào. §9 mục 3:245 hỏi đúng câu này và phần "vá" §5:181-183 chưa trả lời được.

### [BÁC_BỎ_HOÀN_TOÀN] D1 chờ B2 = chờ nhầm cửa; B2 không vá được D1 và chủ B2 là MAGIC-team
Câu quyết định ("B2 không vá được D1") sai trên chính nguồn chuẩn.

(a) LỖI PHẠM TRÙ NGƯỢC. Phát hiện chấm B2 theo 3 yêu cầu (i) tổng nanogic, (ii) slot-timestamp, (iii) trọng số thực-tài-nguyên, rồi kết luận B2 "không đẻ ra thứ nào". Nhưng (i)+(ii) GenMAGIC TỰ SẢN XUẤT, không cần Wakeme: §6:197-200 (Specs/GenMAGIC-CONTRACT-Vi.md) — engine ghi MỌI delta tiêu có cosign vào sổ off-chain per-shard; §4.3:134 nói thẳng "Engine thấy TOÀN BỘ dòng tiêu (§6) ⟹ tính được cầu-mạng, không cần oracle ngoài". Thứ duy nhất GenMAGIC cần từ D1 là (iii) bộ lọc tính-hợp-lệ — và đó CHÍNH LÀ Registry. Phát hiện chấm B2 bằng các yêu cầu B2 chưa bao giờ nhận, rồi gọi việc chờ nó là lỗi phạm trù.

(b) NGUỒN CHUẨN NÓI NGƯỢC LẠI. Wakeme-Math.md §9 mục 6.1 ghi nguyên văn mục tiêu B2: "Registry-chuẩn dịch vụ (thay counterparty-gate) — cổng chống-wash = dịch vụ Registry tiêu tài nguyên thật". Registry ĐƯỢC ĐẶC TẢ LÀ CỔNG CHỐNG-WASH. Wakeme-Math.md:283 (T-5) ép thêm: cổng "PHẢI trả về đúng 'tiêu thật qua dịch vụ Registry hợp chuẩn'". Wakeme-Math §8 (ghi chú production) chỉ rõ hướng: "provider phải Registry-bonded (có cọc, chịu fraud-proof); BỎ self-consumption". Phát hiện đọc B2 = đúng một hàm Bool `counterparty_did ≠ owner`; đó là PLACEHOLDER hiện tại (activation_logic.ak:326-335 — comment tự ghi "Placeholder trả False (chưa có event) — MVP tin keeper"), KHÔNG phải phạm vi blocker.

(c) KỊCH BẢN SỤP THEO. "B chỉ cần mua tài khoản 5 USD trên chợ" chỉ đúng với placeholder. Với Registry như đặc tả (bonded + fraud-proof + bỏ self-consumption), đồng loã B phải vận hành dịch vụ Registry CÓ CỌC và chịu fraud-proof. Đó đúng là "chi phí không thu hồi được" mà chính phát hiện (c) đòi. Nghĩa là: đòn bẩy phát hiện đề xuất ĐÃ NẰM TRONG B2. Kết luận "B2 land xong wash VẪN CHẠY 100%, chi phí bổ sung = một lần bắt tay" sai vì bỏ qua cọc.

(d) SAI CHỦ — không đứng. Wakeme-Math.md:283 ghi chủ T-5 = "Registry-team", KHÔNG phải MAGIC-team. STATUS.md:34 (nguồn phát hiện dùng) KHÔNG nằm trong 4 nguồn chuẩn, VÀ tự khai phi-chuẩn tại STATUS.md:3: "File này là báo cáo hiện trạng, KHÔNG phải đặc tả... Khi hai bên lệch → spec là mục tiêu". Dùng STATUS đè spec là ngược thứ tự chính STATUS quy định. Kết luận "MAGIC đang chờ CHÍNH MÌNH" không đứng.

(e) SỐ HIỆU ĐỤNG NHAU — tự giải. CONTRACT:4 tự neo hệ đánh số: "Wakeme §3.7-1 / B1" = engine Gen, khớp hệ Wakeme-local (STATUS:80). Vậy "B2" tại §7 D1 rõ ràng = Wakeme-local B2 = Registry. Không có mơ hồ cần giải.

(f) "D1 bị chặn bởi D4" — chỉ đúng NẾU nhận đề xuất riêng của phát hiện (bind credit vào CARP đã quyết toán). D1 như CONTRACT viết (Registry) không có cạnh đó. Phát hiện suy cạnh phụ thuộc từ phương án vá của chính mình rồi tuyên đó là "cạnh thật đang thiếu" của CONTRACT. Thêm nữa D1 ghi phụ thuộc B2, không ghi D2 — vế "không phải D2/B2" đánh vào thứ CONTRACT không nói.

CÒN LẠI (không đỡ được tiêu đề): (1) placeholder với ngữ nghĩa trần `counterparty_did ≠ owner` thật sự thủng trước thông đồng 2 bên — đúng, nhưng đó là lý do PHẢI có Registry đúng chuẩn, tức lý do CHỜ B2, không phải lý do bỏ chờ. (2) Wakeme-Math:283 (Registry-team) vs STATUS:34 (MAGIC team + backend) vs CONTRACT:222 (PhoenixKey) — ba nguồn ghi ba chủ khác nhau, đáng mở phiếu chốt chủ. Nhưng nó không chứng minh chủ = MAGIC-team, và không đỡ câu quyết định.

### [ĐÚNG_MỘT_PHẦN] Wash-trade thật là 12.375× (không phải 3.75×); bảng chống-gian-sổ §6 vô hiệu khi user ≡ operator
**Điều kiện:** Giữ nửa sau: (a) bảng chống-gian-sổ §6:211 trực giao hoàn toàn với wash (neo Scale-Analysis:89) — đúng vô điều kiện; (b) thiệt hại = deadweight + sụp tín hiệu, không phải lạm phát (neo §5:172) — đúng vô điều kiện, và đây là chỗ D1:222 mô tả sai. Bác nửa đầu: con số wash-attributable đúng là 3.75× (D1 đúng), tối đa 5.625× NẾU chứng minh được cam_kết_lịch shell-able VÀ đồng thời với tiêu_thật=2.5 dưới G9 — cả hai chưa chứng minh (§9 mục 10:252 để mở). Thiệt hại/epoch phải sửa 119.300 → 69.318.
Nửa sau ĐÚNG và quan trọng. Nửa đầu (con số tiêu đề) SAI hai lần, và một con số thiệt hại sai 1.72×.

BÁC BỎ 12.375×:
(1) tuổi_LAMP KHÔNG phải lợi ích wash — đếm chồng. §7 D1:222 nói "ăn 2.5×1.5 = 3.75× miễn phí" = phần wash MANG LẠI so với sàn (tiêu_thật 1.0 × giờ_thấp_điểm 1.0 → 2.5 × 1.5). Đúng chính xác. tuổi_LAMP 2.20× (§4.1:99-101) người ngay thật cùng tuổi CŨNG được, miễn phí, không cần wash. Nhân nó vào rồi bảo "D1 đếm thiếu" là lẫn "tổng tư_cách của washer" với "lợi ích wash mang lại". Chính phát hiện #3 tự bác mình: "G4 vẫn đứng theo HƯỚNG khi so cùng tuổi".
(2) Số của chính phát hiện chứng minh D1 ĐÚNG HƠN nó. Trong kịch bản: honest = 4.807, washer = 12.375 ⟹ ưu thế wash thực tế = 2.57×, THẤP HƠN con số 3.75× mà D1 khai. D1 không đếm thiếu — nó khai phần wash-attributable so với sàn, đúng.
(3) 2.50 × 1.50 đồng thời chưa chứng minh được. tỷ_tiêu = 1.0 (§4.2:114) đòi đã_tiêu = đã_sinh (tiêu HẾT); tỷ_cam_kết = 1.0 (§4.4:143) đòi cam kết ≥ sinh_kỳ_vọng_6_epoch. Dưới G9 (:32-34 — MAGIC không tích luỹ, reset mỗi epoch) hai thứ giành cùng một suất khan hiếm. Nếu a + b ≤ 1 thì max (1+1.5a)(1+0.5b) = 2.5 tại a=1, b=0 — KHÔNG phải 3.75. Trần 12.375× (§4.5:157) khi đó tụt còn 8.25×. §9 mục 10:252 tự nêu đúng câu này là CÂU HỎI MỞ ("reset mỗi epoch có phá cam-kết-lịch không"). Phát hiện giả định thuận lợi rồi trình như đã chốt.
(4) Ngữ nghĩa `magic_cam_kết_đang_hiệu_lực` KHÔNG được định nghĩa ở BẤT KỲ nguồn nào trong 4 nguồn (grep Wakeme: chỉ Tech.md:62 nhắc tên ScheduleGen). "Bên kia là shell của chính mình" là [NEEDS-EVIDENCE] — không nguồn nào nói hợp đồng lịch CÓ counterparty.

BÁC BỎ con số thiệt hại 119.300: đó là phần washer NHẬN, không phải phần người ngay thật MẤT. Kiểm: nền tất-cả-ngay-thật ⟹ 9.500 hồ sơ nhận 950.000. Có washer ⟹ 45.714.000/51.907.500 × 1.000.000 = 880.682. Mất thật = 69.318/epoch, không phải 119.300 (washer nhận 119.318, trong đó 50.000 vốn dĩ đã là của họ). Sai 1.72×. Kéo theo "8,7 triệu/năm" sai — đúng là 5,06 triệu.

GIỮ (mạnh, đã xác minh):
(a) Bảng §6:211 trực giao với D1. Scale-Analysis:89 (C-A) ghi rõ mục đích cosign: chống "operator bịa 'user tiêu X'" — dựng theo trục operator-ác ↔ user-ngay. Wash là operator ≡ user ⟹ attacker tự ký cho mình ⟹ cosign hợp lệ tuyệt đối. §6:214 ("KHÔNG thể bịa/sửa delta đã cosign") đúng và vô quan. Đây là kết luận sạch, có neo.
(b) Bản chất thiệt hại: §5:172 chuẩn hoá pro-rata ⟹ hệ số đều tăng thì triệt tiêu ⟹ wash không lạm phát cung, thiệt hại = cướp phần giai đoạn quá độ + sụp tín hiệu (§4 thành no-op ở cân bằng). Kiểm 12.375/4.807 = 2.574 ✓. D1:222 mô tả "ăn 3.75× miễn phí" quả thật hàm ý sai bản chất ⟹ đặt sai ưu tiên vá. Điểm này đáng đưa vào CONTRACT.
(c) Hệ số vượt phần 2.39× (11.93%/5%) ✓ đúng.

### [ĐÚNG_MỘT_PHẦN] §4.5 kiểm G4 dùng bù nhìn — idler tối ưu 5.32× chứ không 2.20×; biên 2.6 lần thực ra 1.06 lần
**Điều kiện:** Đúng nếu phát biểu lại thành: "§4.5:159 lấy trần idler là hồ sơ sàn-cả-ba-hệ-số, không phải tối ưu của chiến lược ôm-giữ; chỉ riêng giờ_thấp_điểm-với-tiêu-bụi (§4.3:128+136, đã xác minh) đã nâng idler lên ≥3.548× ⟹ trần §4.5 khai thiếu 61%, biên G4 = 1.59× không phải 2.6×, và lá chắn §8:234 mỏng theo". Con số 5.32×/1.06× chỉ đúng thêm NẾU chứng minh được cam_kết_lịch đạt trần miễn phí dưới G9 — hiện §9 mục 10:252 để mở. Trục `c` (anti-idle bào nền) phải được đưa vào so sánh; nếu MIN_MAGIC_TX chốt ở 10% daily-gen-able (Exec:96) thì hồ sơ tiêu-bụi 5% không sống được như kịch bản mô tả.
Phê phán PHƯƠNG PHÁP đứng vững; con số cụ thể thì không.

GIỮ (lõi): §4.5:159 định nghĩa vế idler là "ôm-giữ TỐI ĐA không tiêu = 2.20 × 1.0 × 1.0 × 1.0" và dùng nó làm TRẦN của chiến lược ôm-giữ. Nhưng nó chỉ là trần của MỘT hồ sơ cụ thể (sàn cả ba hệ số), không phải trần của chiến lược. §4.3:128-129 + :136 cho phép người tiêu bụi ăn TRỌN giờ_thấp_điểm = 1.50× — đã xác minh, không cần giả định gì thêm. Chỉ riêng thứ đó: idler tối ưu ≥ 2.20 × 1.075 × 1.50 = 3.548×, tức trần §4.5 khai THẤP HƠN thực tế 61%, và biên G4 = 5.625/3.548 = 1.59× chứ không phải 2.6×. Luận cứ số học §4.5 dùng để biện minh dải hệ số hỏng ở mức đó. §8:234 quả thật kê chính con số này làm lá chắn pháp lý ("người tiêu-thật hơn 2.6× (§4.5) ⟹ narrative giữ LAMP ăn lãi sai về số học") ⟹ lá chắn mỏng đi theo. Điểm này thật, đáng vá §4.5.

BÁC 5.32× / 94.6% / 1.06×: cả ba treo trên cam_kết_lịch = 1.50× "miễn phí". Chưa chứng minh: `magic_cam_kết_đang_hiệu_lực` (§4.4:143) không được định nghĩa ở bất kỳ nguồn nào trong 4 nguồn chuẩn (Wakeme chỉ nhắc tên ScheduleGen ở Tech.md:62); và §9 mục 10:252 tự nêu G9-reset-vs-cam-kết-lịch là câu hỏi MỞ. Dưới G9 (:32-34), cam kết ≥ sinh_kỳ_vọng_6_epoch trong khi suất reset mỗi epoch là chưa rõ có thực hiện được không. Bỏ hệ số này: 3.548× và biên 1.59×, không phải 5.32× và 1.06×.

BÁC neo MIN_MAGIC_TX: phát hiện ghi "MIN_MAGIC_TX = 1 MAGIC/ngày (Wakeme-Math:304 ghi TẠM)". Đã đọc :304 — dòng đó là "ngưỡng active mỗi epoch (keeper attest); granularity daily-gen-able vs cumulative | Thấp | TẠM". KHÔNG có "1 MAGIC/ngày". Giá trị TẠM thật nằm ở Wakeme-Exec.md:96: "MIN_MAGIC_TX = 10% gen-able... 10% daily-gen-able từ conditional_lamp". Neo bịa. (Không tải trọng cho phép tính — §4.2/§4.3 không có sàn tối thiểu — nhưng vi phạm quy tắc neo.)

BÁC "idler không mất gì": phát hiện chỉ so trên trục tư_cách, bỏ trục `c`. §3:71 — M_v ∝ c × tư_cách, tuyến tính theo c. Hồ sơ tiêu 5% suất rơi DƯỚI ngưỡng active TẠM (10% daily-gen-able, Exec:96) ⟹ anti-idle Reclaim bào c 1 LAMP/ngày (I-ACT-4, Math.md:122); MONO-c (Math.md §3) — c CHỈ GIẢM, không có đường tăng. Chính §4.1:104 viện dẫn cơ chế này ("pha Epochy bào c 5 LAMP/epoch"). Idler bụi mất nền tuyến tính, không phải "KHÔNG MẤT GÌ". Giảm nhẹ cho phát hiện: cổng active này chạy qua đúng placeholder I-ACT-3 (Math.md:120) ⟹ lập luận vòng, nên đây là điều kiện chứ không phải bác sạch.

### [ĐÚNG_MỘT_PHẦN] giờ_thấp_điểm là tỷ-lệ không thang: tiêu bụi ăn trọn 1.5×; thưởng bot phạt người thật — ngược G4/G8
**Điều kiện:** Giữ vô điều kiện lỗi (1): giờ_thấp_điểm không có thang ⟹ tiêu 1 nanogic đúng slot ăn trọn 1.5×, có bậc nhảy 0→1.5× tại hạt bụi đầu tiên (neo §4.3:128 + :136). Lỗi (2) chỉ đúng trong điều kiện độ co giãn thời điểm của cầu thật ≈ 0 — chưa chứng minh, và sai với dịch vụ dời được (batch/nền). Bỏ tiêu đề "ngược G4" (số của chính phát hiện cho Lan thắng 5.335 vs 3.548) và bỏ kết "hoà" (bất đối xứng do xếp bài). Phát biểu còn lại đứng được: giờ_thấp_điểm chọn lọc theo ĐỘ CO GIÃN THỜI ĐIỂM chứ không theo cung-cầu, nên G8 chỉ thoả với phần cầu dời được.
Lỗi (1) ĐÚNG SẠCH. Lỗi (2) đúng một nửa; tiêu đề "ngược đúng G4" bị chính số của phát hiện bác.

GIỮ (1) KHÔNG THANG — xác minh trực tiếp: §4.3:128 `tỷ_thấp_điểm = ⌊đã_tiêu_lúc_thấp_điểm × Q / max(đã_tiêu, 1)⌋` — mẫu số CHÍNH LÀ đã_tiêu ⟹ bất biến theo quy mô. Cộng :136 ("đã_tiêu = 0 ⟹ tỷ = 0 ⟹ sàn") ⟹ hàm bậc thang thật: 0 nanogic → 1.00×, 1 nanogic đặt đúng slot → 1.50×. Toàn bộ +50% nằm trên một hạt bụi. Không cần giả định nào. Đây là khiếm khuyết thật, cần cổng thang (ví dụ nhân tỷ_thấp_điểm với min(Q, đã_tiêu×Q/đã_sinh) để hệ số dời-giờ không vượt mức tận-dụng-suất).

BÁC tiêu đề "ngược đúng G4": số của CHÍNH phát hiện cho Lan 5.335 > bot 3.548. G4 KHÔNG bị đảo — người tiêu thật vẫn thắng, đúng như §4.5:153-154 thiết kế (dải tiêu_thật 2.5× cố ý rộng nhất để áp đảo các hệ số phụ). Kết luận "trao +50% cho đúng nhóm G4 muốn chặn, 1.0× cho nhóm G4 muốn ưu tiên" mô tả đúng MỘT hệ số, rồi tuyên về toàn hệ — sai altitude.

BÁC kết "hoà": chỉ ra được bằng cách cho bot cam_kết_lịch = 1.5 mà GIỮ Lan ở 1.0, trong khi setup tự khai "cùng cam_kết_lịch = 1.0". cam_kết_lịch (§4.4:143-144) đối xứng — Lan lấy được thì 8.00 vs bot 5.32, khoảng cách 1.5× y nguyên. Xếp bài.

BÁC "cầu thật không dời được": khẳng định không neo, và sai với một lớp lớn dịch vụ thật (batch, đồng bộ, sao lưu, tải agent, job nền — dời giờ tự do). Biện hộ tự-cân-bằng §4.3:135 đòi ĐỘ CO GIÃN > 0, không đòi co giãn hoàn hảo. "Thuế 33% VĨNH VIỄN" chỉ đứng ở giới hạn co giãn = 0, chưa chứng minh.

BÁC chỉ số "hiệu suất/MAGIC-tiêu": bot hiệu quả gấp 12.6× — phép tính đúng (0.1183/0.00936) nhưng CONTRACT không tối ưu đại lượng này ở đâu cả; hệ chia pro-rata theo tư_cách tuyệt đối (§5:171-172). Chỉ số tự chọn, không neo, mang tính tu từ.

### [ĐÚNG_MỘT_PHẦN] Giấu delta không chứng minh được — lá thiếu chữ ký operator ⟹ fraud-proof/bond bất khả thi như đặc tả
**Điều kiện:** Đúng vô điều kiện ở lõi: lá (§6:200 / Scale-Analysis:230) không có chữ ký operator ⟹ withholding không có bằng chứng ⟹ giảm nhẹ L3 "fraud-proof window" (Scale-Analysis:295) không dựng được; cộng thêm single-writer per-DID (§6:212) khoá luôn nửa còn lại của L3 ("multi-operator fallback"). Phải sửa hai chỗ trước khi dùng: (1) bỏ "tỷ số khuếch đại 6:1" — thiệt hại tích phân là 1:1 trải trên 6 epoch, vì tiêu_thật tuyến tính theo tỷ_tiêu (§4.2:115); (2) đổi mục tiêu từ :257 (bond cho net_CARP — hợp lệ, slash được) sang :295 (L3 — hở thật), và bỏ chữ "toàn bộ" ở tiêu đề. Vá đề xuất: operator ký ACK per-delta trả về user.
Lõi cấu trúc ĐÚNG và đã xác minh. Hai vế phụ sai; chữ "toàn bộ" trong tiêu đề quá tay.

GIỮ (lõi, đã kiểm từng ký tự): §6:200 `lá = H(did ‖ Δmagic ‖ nonce ‖ cosign ‖ prev)`; Scale-Analysis:230 `leaf_i = H(did_key ‖ Δmagic_i ‖ nonce_i ‖ user_cosign_sig_i ‖ prev_commit)` — KHÔNG có chữ ký operator ở cả hai. Suy luận đúng: cosign chứng minh "tôi ĐỒNG Ý tiêu", không chứng minh "operator ĐÃ NHẬN" ⟹ giấu delta không tồn tại bằng chứng đầu vào ⟹ không dựng được fraud-proof cho trường hợp withhold. Đây là khiếm khuyết thật, vá được rẻ (operator ký ACK có nonce trả về user; user cầm ACK làm bằng chứng "đã nhận" ⟹ proof-of-absence có mốc).

GIỮ (mạnh, phát hiện chưa nêu hết): Scale-Analysis:295 kê giảm nhẹ L3 = "Fraud-proof window + multi-operator fallback", nhưng §6:212 chốt shard theo `hash(did_commit)` ⟹ "số dư 1 DID do ĐÚNG 1 shard giữ". Single-writer per-DID CẤU TRÚC LOẠI BỎ multi-operator fallback cho chính DID đó. Hai dòng trong hai nguồn chuẩn mâu thuẫn nhau — cả hai giảm nhẹ của L3 đều không dùng được. Điểm này còn nặng hơn điều phát hiện nêu.

GIỮ kịch bản 6-epoch: kiểm lại đúng — 2.20×2.425×1.30×1.50 = 10.403; sau khi đã_tiêu = 0 ⟹ tiêu_thật = 1.00 (§4.2:114-115), giờ_thấp_điểm = 1.00 (§4.3:136) ⟹ 2.20×1.5 = 3.30; mất 68.3% ✓. G9 (:32-34) đúng là biến sự cố sổ khả-hồi thành mất mát bất-khả-hồi. Vế 1-epoch cũng đúng: 0.95×5/6 = 0.7917 ⟹ 1+0.7917×1.5 = 2.19 ✓.

BÁC "tỷ số khuếch đại 6:1": sai. tiêu_thật TUYẾN TÍNH theo tỷ_tiêu (§4.2:115 — `Q + ⌊tỷ_tiêu × 1.5Q/Q⌋`). Giấu 1 epoch ⟹ mỗi epoch trong 6 epoch kế mất 1/6 cửa sổ ⟹ thiệt hại tích phân ≈ ĐÚNG 1 epoch-tương-đương, trải trên 6 epoch. Số của chính phát hiện xác nhận: 2.425 → 2.19 = −10% cho một epoch bị giấu, không phải −60%. Đây là tính DAI DẲNG (6 epoch bị chạm), không phải khuếch đại 6×. Sai hệ số 6.

BÁC "Bond để đó không ai slash được": Scale-Analysis:257 gắn bond+fraud-proof-window vào ĐÚNG MỘT thứ — "operator gian lận net_CARP" — chứ không phải withhold. net_CARP gian lận CHỨNG MINH ĐƯỢC tại settlement (so root anchor với CARP chuyển Treasury) ⟹ bond slash được cho đúng mục đích nó được kê. Phát hiện đánh vào công dụng nguồn chưa từng gán. Chỗ hở thật nằm ở :295 (L3), không phải :257.

BÁC chữ "toàn bộ" ở tiêu đề: theo trên, fraud-proof/bond KHÔNG bất khả thi toàn bộ — bất khả thi ĐÚNG cho nhánh withhold.

### [ĐÚNG_MỘT_PHẦN] Bond tĩnh vs phơi-nhiễm tăng dần ⟹ mọi operator thành công đều đạt điểm bỏ trốn +EV
**Điều kiện:** Giữ hai điểm, bỏ "định lý": (1) CONTRACT §6:206-212 nhập "bond" từ Scale-Analysis nhưng bỏ rơi đòi hỏi kèm theo của chính nguồn đó — "cần cap net exposure/epoch" (:294) và `request_topup`; đây là thiếu sót đối chiếu được, phải vá bằng cách thêm dòng cap vào bảng §6. (2) §4.2:112 đếm MAGIC KHAI không đếm CARP đã quyết toán ⟹ operator vỡ nợ, user của nó vẫn giữ 2.50× suốt 6 epoch — đúng, độc lập, phải vá. Bác phần "định lý": chỉ đúng trong điều kiện bond TĨNH đóng-một-lần, mà không nguồn chuẩn nào đặc tả (Scale-Analysis:257 ghi "≥100k ADA" = sàn, cho phép thang; §9:253 tự khai chưa định lượng). Với bond thang theo phơi-nhiễm hoặc cap E/epoch, E − B không dương theo thiết kế và "định lý" biến mất.
Hai điểm cụ thể ĐÚNG và kiểm được. "Định lý" thì không — nó treo trên giả định không có trong nguồn nào.

GIỮ (1) — BỎ RƠI GIẢM NHẸ, xác minh trực tiếp: Scale-Analysis:294 (L2) ghi "Bond + `request_topup` che MỘT PHẦN; **cần cap net exposure/epoch**". CONTRACT §6:211 bê sang "user-cosign + hash-chain + nonce + anchor + bond" — bảng §6:206-212 KHÔNG có dòng cap, và KHÔNG có `request_topup`. Nguồn tự nói bond chỉ che một phần và ĐÒI cap; CONTRACT lấy phần bond, bỏ phần cap. Đây là thiếu sót cụ thể, đối chiếu được, phải vá.

GIỮ (2) — CỘNG HƯỞNG, xác minh trực tiếp: §4.2:112 `đã_tiêu = Σ MAGIC hồ sơ did_commit tiêu thật trong cửa_sổ` — đếm MAGIC KHAI, không điều kiện "CARP đã quyết toán". Operator vỡ nợ ⟹ user của nó giữ nguyên tiêu_thật tới 2.50× suốt cửa sổ [e−6, e) (§4.2:111) và tiếp tục hút phần pro-rata (§5:172) dù CARP đối ứng chưa từng vào Treasury. Đúng, độc lập, đáng vá (điều kiện hoá đã_tiêu theo epoch đã settle, hoặc claw-back hệ số khi settlement fail).

BÁC "định lý về mọi operator thành công": treo trên "bond B đóng MỘT LẦN lúc đăng ký", tĩnh. Không nguồn nào trong 4 nguồn nói vậy. Scale-Analysis:257 ghi "bond **≥100k ADA**, 7-day window" — dấu ≥ là SÀN, không phải hằng số, không cấm bond theo thang phơi-nhiễm. CONTRACT §9:253 tự khai "chưa định lượng bond + cửa-sổ-fraud-proof". Vậy trạng thái thật = CHƯA ĐẶC TẢ, còn phát hiện dựng một tham số hoá tĩnh (mượn B = 100.000 từ Mosaic §15.5) rồi chứng minh nó hỏng. Đó là bác bỏ một phương án chưa ai chọn, không phải bác bỏ CONTRACT. Đúng dạng: "NẾU bond tĩnh THÌ tồn tại T mà E(T) > B" — đúng nhưng tầm thường, và chính là lý do :294 đòi cap.

BÁC "hệ tự chọn lọc: operator tốt nhất có động cơ phản bội mạnh nhất": hệ quả của cùng giả định tĩnh; với bond thang theo E (hoặc cap E/epoch như :294 đòi) thì E − B không bao giờ dương theo thiết kế. Kết luận cấu trúc sụp cùng giả định.

GIỮ có điều kiện: "chỉ cần P PHÁ SẢN vì lý do khác là kết quả y hệt" — đúng và đáng lưu, vì nó cho thấy cap là cần cho cả trường hợp không-ác-ý, không chỉ chống phản bội duy lý. Con số kịch bản (E−B = +140.000 tại quý 3) tính đúng, nhưng chỉ minh hoạ giả định tĩnh.

### [GIỮ_NGUYÊN] 1. [NGHIÊM TRỌNG] §5 nhịp_gen lệch đúng một thừa số Q = 10⁹
Em cố bác nhưng không bác được — phân tích thứ nguyên đóng kín, và em chạy lại số ra ĐÚNG như phát hiện.

Kiểm neo: CONTRACT:76 ghi 'tư_cách_v(e) = hệ-số-tư-cách, Q-format' ✓. CONTRACT:171 ghi `tổng_trọng_số(e) = Σ_v ( c_v × tư_cách_v(e) )` — tích thô, KHÔNG chia Q ✓ ⟹ W mang đơn vị [NGUYÊN-LAMP × Q] ✓. CONTRACT:77 ('nhân-chia-floor tuần tự, KHÔNG gộp một phép') xác nhận không được tự ý gộp/rút gọn Q ⟹ không có đường đọc nào cứu được :171.

Kiểm đại số: G(e) = Σ_v M_v = nhịp_gen × W(e)/Q² từ :71. Muốn G = ngân_sách khi W đứng yên ⟹ nhịp_gen = ngân_sách × Q²/W. :172 chỉ có ×Q ⟹ thiếu đúng một Q ✓.

Kiểm số (chạy thật, BigInt): W = 1001×10⁹ = 1.001×10¹²; ngân_sách = 10¹² nanogic.
  nhịp_gen(:172 như viết) = 999_000_999 ✓ (khớp phát hiện)
  M_v = 999 nanogic; tỷ số M_v/ngân_sách = 9.99×10⁻¹⁰ ✓ — đúng một thừa số Q.
  Sửa ×Q²: nhịp_gen = 999_000_999_000_999_000; M_v = 999_999_999_999; tỷ số = 0.999999999999 ✓ khớp ngân sách.

Đường bác duy nhất em tìm được — 'ngân_sách_gen chưa định nghĩa đơn vị (:170 là f(...) bỏ ngỏ, :188 ghi rõ chưa chốt) nên có thể nó vốn là Q-format-nanogic' — KHÔNG cứu được: (a) không dòng nào trong CONTRACT nói vậy; (b) 'ngân sách sinh MAGIC' đọc tự nhiên chỉ có thể là nanogic; (c) chính chỗ mơ hồ đó là cái làm chiều-lạm-phát của phát hiện thành thật — nếu dev vá bằng cách thổi ngân_sách_gen ×10⁹ thay vì sửa :172 thành ×Q², thì br_q/pp_sched hạ nguồn lệch 10⁹ theo chiều phát tiền.

Không tìm ra lỗi nào trong phát hiện này.

### [GIỮ_NGUYÊN] 2. [NGHIÊM TRỌNG] §5 van TRẦN_TĂNG=1.25Q gác sai biến — không chặn được vượt ngân sách
Không bác được. Đây là kết quả đại số, không phải trực giác.

Kiểm đại số: G(e) = ngân_sách(e) × W(e)/W(e−1) ⟹ độ vượt = w(e) = W(e)/W(e−1), và w(e) KHÔNG chứa nhịp_gen ✓. Van :182 ràng nhịp_gen(e)/nhịp_gen(e−1) = [ngân_sách(e)/ngân_sách(e−1)] × [W(e−2)/W(e−1)] — biến hoàn toàn khác. Em thử tìm đường ghép hai biến: KHÔNG có. Ngược lại, khi W(e−1) tăng thì nhịp_gen(e) GIẢM ⟹ van (chỉ chặn chiều tăng) im lặng đúng lúc cần nhất ✓. Van chỉ bind khi W(e−1) sụt hoặc ngân sách tăng — nhưng lúc W sụt thì w<1 ⟹ hụt, không vượt ⟹ van gác đúng cái không cần gác ✓.

Kiểm số: W = 1000×1001×10⁹ = 1.001×10¹⁵ ✓; nhịp_gen(e)/nhịp_gen(e−1) = 1.00 ✓ không chạm 1.25; W(e) 2.25×: G = 225% ✓; thêm 9000 vault: W(e) = 1.126×10¹⁶, w = 11.25, G = 1125% ✓ — em cộng lại khớp.

Hai hệ số nhảy-1-epoch có thật: :128-129 (tỷ_thấp_điểm = đã_tiêu_lúc_thấp_điểm/đã_tiêu — tỷ số, đạt Q chỉ bằng một epoch tiêu đúng chỗ) ✓; :143-144 (cam_kết_lịch — chỉ cần ký hợp đồng) ✓. Không có cơ chế làm mượt nào trên hai hệ số này trong CONTRACT.

Phát hiện còn NHẸ TAY hơn thực tế: nếu hồ sơ tiêu ở e−1 để bật giờ_thấp_điểm=1.5, thì tiêu_thật (:114-115) cũng bật theo (đã_tiêu > 0 ⟹ tỷ_tiêu > 0). Với hồ sơ tiêu-1-trong-6-epoch: tiêu_thật = 1.25× ⟹ tư_cách = 1.25×1.5×1.5 = 2.8125 chứ không phải 2.25 ⟹ w lớn hơn. Phản ví dụ vẫn đúng, chỉ là dưới mức.

⟹ Khẳng định :185-186 'có chặn trên cứng theo epoch (van 1.25×)' SAI như phát hiện nói. Không tìm ra lỗi.

### [GIỮ_NGUYÊN] 3. [NGHIÊM TRỌNG] §5 cold-start max(tổng_trọng_số(e−1),1) — siêu phát hoặc chết vĩnh viễn
Em thử bác bằng lập luận 'CONTRACT đã tự nêu ở §9:249, nên chưa-định-nghĩa không phải lỗi mà là câu hỏi để ngỏ'. Bác KHÔNG được, vì hai lý do:

(a) :249 chỉ hỏi 'khởi động thế nào?'. Nhưng :172 ĐÃ VIẾT một cơ chế cụ thể — `max(tổng_trọng_số(e−1), 1)` — và cơ chế đã viết đó tự nó hỏng. `max(·,1)` biến mẫu số từ ~10¹⁵ xuống 1 ⟹ nhịp_gen ×10¹⁵ im lặng, không lỗi, không cảnh báo. Đây là văn bản đang nằm trong CONTRACT, không phải chỗ trống.

(b) Điểm mạnh nhất của phát hiện KHÔNG nằm ở cold-start mà §9:249 hoàn toàn không đụng tới: **van :182 là van NHÂN ⟹ 0 là trạng thái HẤP THỤ ở MỌI epoch.** Em kiểm: :182 là chặn-trên thuần `nhịp_gen(e) ≤ nhịp_gen(e−1) × 1.25Q/Q`; nhịp_gen ≥ 0 (floor của số không âm) ⟹ nhịp_gen(e−1)=0 ⟹ nhịp_gen(e) ≤ 0 ⟹ = 0 ⟹ ∀e. CONTRACT không có bất kỳ redeemer/tham số/sàn nào cho nhịp_gen thoát 0. Đây là lỗi thật, mới, ngoài phạm vi :249.

Kiểm số: nhánh A như viết: nhịp_gen(0) = 10¹⁵×10⁹/1 = 10²⁴ ✓; M_v = 1001×10¹⁵ = 1.001×10⁹ MAGIC ⟹ vượt 1001× ✓. Sau khi sửa Q: 10³³ ⟹ M_v ≈ 10¹⁸ MAGIC ⟹ vượt 10¹²× ✓. Quan sát 'sửa lỗi Q làm cold-start nặng thêm 10⁹ lần' đúng và quan trọng — hai lỗi độc lập, vá một cái không xong.

Không tìm ra lỗi.

### [GIỮ_NGUYÊN] 4. [NGHIÊM TRỌNG] §5 bộ-điều-khiển-tích-phân 'bù kỳ sau' — phân kỳ khi w ≥ 2, ngân sách âm sau 1 epoch
Lõi đúng, kiểm lại từng bước. CÓ MỘT SỐ SAI nhưng ở chỗ trang trí, không đỡ được kết luận — em nêu rõ bên dưới.

Kiểm hình thức hoá: :183 ghi 'thừa/thiếu epoch e trừ/cộng vào ngân_sách_gen(e+1)' ⟹ u(e+1) = b − u(e)(w(e)−1), gain 1, trễ 1 ✓. CONTRACT không có anti-windup / kẹp / giảm-gain ở bất kỳ dòng nào ✓. Điểm bất động u* = b/w; độ dốc = −(w−1) ⟹ ổn định ⟺ |w−1|<1 ⟺ w<2 ✓ đúng.

Kiểm số (chạy thật): u(0)=10¹⁵, w=2.25 ⟹ Err(0)=1.25×10¹⁵ ⟹ u(1) = −2.5×10¹⁴ ✓ ÂM sau đúng một epoch. nhịp_gen(1) ≈ −1.11×10¹⁷ ✓; M_v ≈ −2.5×10¹¹ nanogic = −250 MAGIC/vault ✓. Em soát CONTRACT tìm mệnh đề cấm số dư âm: không có ở §3, §5, §6. Aiken `Int` là số nguyên có dấu ⟹ nhận âm không kêu ✓.

Bẫy ghép với finding 3 đúng: kẹp nhịp_gen(1)=0 ⟹ van nhân ⟹ chết vĩnh viễn từ epoch 2 ✓. Kẹp u(1)=0 ⟹ chu-kỳ-2 [2.25×, 0, 2.25×, 0…] ✓ em kiểm lại đúng.

G9 KHÔNG cứu được — và phát hiện đã đón đúng chỗ này. :33 khẳng định 'quỹ đạo cung MAGIC không phân kỳ dù nhịp_gen sai', nhưng G9 chặn TỒN (stock), còn cái phân kỳ ở đây là DÒNG (flow) mỗi epoch + biến trạng thái u(e) của bộ điều khiển. MAGIC siêu phát ở epoch e đã đổi lấy dịch vụ thật NGAY trong epoch e ⟹ trừ vào ngân_sách(e+1) không hoàn lại bảo chứng đã rút.

**SAI SỐ PHẢI SỬA (không đỡ được kết luận):** '1.81¹⁰ ≈ 350×' — em tính lại: 1.81¹⁰ = **377.4**, không phải 350. Con số này chỉ là kiểm-chứng phụ minh hoạ tốc độ phân kỳ; ba khẳng định gánh lực (ngưỡng ổn định w<2, u(1) = −2.5×10¹⁴, hấp thụ tại 0) em kiểm ĐÚNG CHÍNH XÁC. Đề nghị sửa 350 → 377 trước khi trình.

### [GIỮ_NGUYÊN] 5. [CAO] §4.3 không thể tái dùng FlowRate dual-EMA — sai granularity + sai đại lượng
Em đọc thẳng code, cả bốn tầng đều đúng, kể cả câu grep.

(1) Granularity ✓ — `FlowRate/offchain/src/math.ts:40` chú thích 'called by FlowRateKeeper each epoch'; `:47` `if (flow.epoch <= datum.last_epoch) return datum;` chặn cứng >1 mẫu/epoch; `types.ts:16-19` `EpochFlow` là TỔNG epoch. Em kiểm thêm `keeper.ts:15-24` `aggregateEpochFlow` — gộp SponsorMeter theo `m.epoch === epoch`. **Trong toàn module KHÔNG tồn tại dữ liệu mức slot** ⟹ không có gì để tái dùng cho '(tại) slot tiêu' (:133).

(2) Sai đại lượng ✓ — `math.ts:50` `total_lamp_oildrop × Q / total_magic_ng` = GIÁ (LAMP/MAGIC). Trường lưu tên `lamp_per_magic_q` (`types.ts:7`). Cầu MAGIC tăng ⟹ raw giảm ⟹ EMA_fast<EMA_slow ⟹ §4.3:133 đánh dấu 'thấp điểm' đúng lúc cao điểm — đảo dấu ✓.

(3) Hằng số thời gian ✓ — `math.ts:5-6` α=1/3 (≈3 epoch=15 ngày), α=1/12 (60 ngày). 1 mẫu/5 ngày ⟹ giới hạn Nyquist = chu kỳ 10 ngày; tín hiệu 24h không thể phân giải ✓. Đây là thiếu MẪU, chỉnh α không sửa được ✓.

(4) Cold-start ✓ — `math.ts:12` MIN_MAGIC_EPOCH = 10¹² nanogic; `:43-45` dưới ngưỡng thì EMA đóng băng (trả datum, chỉ tiến epoch) ✓. `:10` HARD_FLOOR_Q=10⁷; `:85-87` max_rate = prev×(Q+cap)/Q, cap ≤ 25% (`:6`) ⟹ log(100)/log(1.25) = 20.6 ⟹ 21 epoch ≈ 105 ngày ✓ em tính lại khớp.

Câu grep ✓ — em chạy `grep -rniE "off.?peak|[^a-z]peak|slot|demand" offchain/src tests` trong `/Users/ductiger/Projects/MAGIC/FlowRate` → **exit 1, không kết quả nào**. Khẳng định của phát hiện đúng nguyên văn.

Đường bác duy nhất em thấy: đọc :132 'tái dùng dual-EMA' theo nghĩa 'mượn KỸ THUẬT hai-EMA, xây đường ống lấy mẫu theo slot mới'. Nhưng :132-133 viết 'đã có trong repo (commit 5292578d)' + 'tại slot tiêu' ⟹ cách đọc chữ là tái dùng cái ĐANG CÓ, và cái đang có không làm được. Kể cả theo cách đọc rộng lượng, (2) vẫn sống: kỹ thuật ấy đang đo giá, muốn đo cầu phải thiết kế lại đại lượng chứ không phải chỉnh tham số. ⟹ 'lời hứa suông' là mô tả đúng. Không tìm ra lỗi.

### [ĐÚNG_MỘT_PHẦN] 6. [CAO] §4.3 chỉ báo nhị phân không tự cân bằng — sinh chu kỳ giới hạn, đỉnh/trung-bình xấu đi 3.3×
**Điều kiện:** Đúng KHI: (1) tác nhân đồng nhất + phối hợp đồng bộ trên cùng một chỉ báo tất định công khai; (2) chi phí trì hoãn ≈ 0 — điều kiện này THẬT trong hệ này vì G9 (:30) reset theo EPOCH, nên hoãn vài giờ trong cùng epoch gần như miễn phí ⟹ đây là kịch bản đáng tin, không phải trường hợp bịa; (3) chỉ báo giữ dạng ngưỡng nhị phân. Đúng VÔ ĐIỀU KIỆN ở phần: 'không tồn tại cân bằng thuần' + ':135 chưa chứng minh được tự-cân-bằng'. KHÔNG đúng ở: con số 3.33 (số học tự mâu thuẫn, phải bỏ hoặc dựng lại), và ở tuyên bố tệ-đi như một định lý phổ quát. Đề xuất sửa phát hiện: giữ lập luận cấu trúc + đòi §4.3 thay ngưỡng nhị phân bằng chỉ báo liên tục, BỎ con số 3.33 khỏi văn bản trình hội đồng.
Phần cấu trúc ĐÚNG, phần định lượng KHÔNG chống được soi.

ĐÚNG (giữ): (a) Chứng minh không-tồn-tại-cân-bằng-thuần dưới ngưỡng nhị phân là lập luận chặt, không phải giả định mô hình: f nhỏ ⟹ lệch vào có lợi nghiêm ngặt; f=1 ⟹ hết ưu đãi ⟹ lệch ra có lợi ⟹ không có cân bằng thuần; cân bằng duy nhất là hỗn hợp trên lưỡi dao EMA_fast=EMA_slow ✓. (b) Do đó khẳng định :135 'tự cân bằng ✓ G8' là **chưa chứng minh** — nó mượn lập luận tâtonnement vốn chỉ chạy với phần thưởng có GRADIENT LIÊN TỤC, đem áp cho ngưỡng NHỊ PHÂN mà không nói gì về bước nhảy. Chỗ này phát hiện chỉ đúng, và :135 phải sửa. (c) Em chạy lại mô phỏng bằng đúng α=1/3, 1/12: k=0 fast=96.667 < slow=99.167 → THẤP ĐIỂM; k=1 r=700 → fast=297.778 > slow=149.236 → cao điểm; k=2..k=5 cao điểm; **k=6 fast=126.045 < slow=131.867 → THẤP ĐIỂM** ⟹ chu kỳ giới hạn ≈5-6 bucket ✓ tồn tại thật, dấu lật đúng chỗ phát hiện nói (số lẻ của phát hiện ở slow lệch nhẹ do làm tròn tích luỹ: k=4 thật 137.924 vs ghi 137.8; k=6 thật 131.867 vs ghi 131.7 — không đổi kết luận).

KHÔNG ĐỠ ĐƯỢC (bác): con số **'đỉnh/trung-bình 1.0 → 3.33'**. Số học tự mâu thuẫn: dãy bucket phát hiện dùng (800, 100, 100, 100, 100) tổng = 1200 trên 5 bucket, trong khi cầu bảo toàn của chính mô phỏng là 5×200 = 1000. Cầu không tự sinh — hoặc trung bình = 200 (⟹ tỷ số 4.0), hoặc dãy bucket sai. Mẫu số 240 không dựng lại được từ giả thiết. Chiều (xấu đi so với 1.00) đúng, ĐỘ LỚN 3.33 không đứng.

Cũng bác: câu 'làm tỷ số đỉnh/trung-bình TỆ ĐI' phát biểu như định lý, nhưng nó là kết quả của MỘT mô hình tác nhân cụ thể (đồng nhất, đồng bộ hoàn hảo, cùng đọc một chỉ báo công khai, chi phí trì hoãn = 0). Với tác nhân dị biệt / thời điểm lệch nhau / có chi phí trì hoãn, dao động tắt dần về cân bằng hỗn hợp và biên độ nhỏ hơn nhiều.

### [GIỮ_NGUYÊN] 7. [CAO] §3:80 'Kiểm G1 ✓' sai về toán — floor thứ nhất tạo ra một cổng
Không bác được, và thực tế phát hiện còn NHẸ hơn sự thật.

Kiểm logic: :80 viết 'tư_cách ≥ Q luôn ⟹ c_v > 0 ⟹ M_v > 0'. Đây là non-sequitur ✓ — :71 đặt floor BÊN TRONG chạy trước: `⌊c_v × nhịp_gen/Q⌋ = 0` khi `c_v × nhịp_gen < Q`, và `⌊0 × tư_cách/Q⌋ = 0` với MỌI tư_cách. :77 ('nhân-chia-floor tuần tự, KHÔNG gộp một phép') khoá chặt không cho gộp để né floor trong ✓. Điều kiện cổng `nhịp_gen < Q/c_v` đúng ✓.

Kiểm số (chạy thật): nhịp_gen = 999_000_999 theo :172 như viết ✓; c=1 ⟹ ⌊999000999/10⁹⌋ = 0 ⟹ M_v = 0 kể cả tư_cách = 12.375× ✓; c=2 ⟹ ⌊1.998⌋ = 1 nanogic ✓; ngưỡng c ≥ 2 ✓. Tất cả khớp.

c=1 hợp lệ ✓ — Wakeme-Math:33 `genesis_vault_ok` ép `1 ≤ conditional ≤ d_cap`.

**Phát hiện bỏ sót một chỗ làm nó NẶNG hơn:** cổng không chỉ đánh 'user nhỏ nhất'. Wakeme-Math:104 (MONO-c) + :126 (I-ACT-8b, q = min(5,c)) ⟹ `c` chỉ GIẢM, đơn điệu, qua Reclaim (−1/ngày) và ReclaimEpoch (−q/epoch). ⟹ **MỌI vault, kể cả cá voi c=1001, đều đi qua c ∈ {1,2,3,4,5} ở cuối đời.** Vùng chết không phải chuyện của user nghèo — nó là chặng cuối bắt buộc của mọi vault trong hệ.

Điểm phát hiện tự thú nhận đúng và em xác nhận: sau khi sửa ×Q² thì ngưỡng lùi rất xa (cần W > ngân_sách×10⁹; với tư_cách trung bình 12.375× thì ≈8×10¹⁰ vault — con số 8×10¹⁰ khớp nếu tư_cách=12.375, không khớp nếu tư_cách=Q (ra ~10¹² vault); nên ghi rõ giả thiết). Nhưng đó không đỡ được :80: G1 là tiên đề (:22) và :80 'kiểm' nó bằng suy luận hỏng ⟹ khẳng định sai đang nằm trong CONTRACT phải rút hoặc chứng lại. Không tìm ra lỗi.

### [GIỮ_NGUYÊN] 8. [CAO] §4.4 sinh_kỳ_vọng_6_epoch không được định nghĩa — vòng đại số tự-tham-chiếu, phá P8
Xác nhận bằng grep + đại số. Có một số sai ở tiêu đề, em nêu rõ.

Kiểm 'không định nghĩa' ✓ — `grep -n "sinh_kỳ_vọng\|kỳ_vọng" Specs/GenMAGIC-CONTRACT-Vi.md` trả **đúng 1 dòng: :143**, chính là chỗ dùng nó. Không có ở §2 (bảng đầu vào :43-52), không §3, không §5. Cách xử lý của phát hiện (nêu chỗ mơ hồ, phân tích cả hai cách đọc, không tự chọn) là đúng vai.

Cách đọc 1 (tiến) ✓ — em dựng lại độc lập: x = 1 + 0.5·min(1, K/(E₀x)) ⟹ x² − x − 0.5K/E₀ = 0 ⟹ x = (1+√(1+2K/E₀))/2 ✓; kẹp khi K/E₀ ≥ 1.5 ✓. Chạy số: K/E₀ = 0.60545…, x = **1.2434565**. Phát hiện ghi 1.2434380 — lệch ở chữ số thứ 6 vì phát hiện làm tròn K/E₀ = 0.6054 rồi mới khai căn. Chỗ này KHÔNG phải lỗi phá phát hiện — trớ trêu là nó minh hoạ chính điều phát hiện đang tố: cùng một phương trình, hai đường tính, hai kết quả khác nhau.

Điểm mạnh nhất và em xác nhận: đây là vòng ĐẠI SỐ TRONG CÙNG EPOCH, khác hẳn hai tự-tham-chiếu §9.4/§9.5 (hồi tiếp CÓ TRỄ, giải được bằng lặp theo epoch) ⟹ §9 chưa hề tính tới nó. CONTRACT không ghi phương trình, không nghiệm-thức, không lược đồ lặp, không dung sai ⟹ Aiken (không có căn bậc hai sẵn) và TS (BigInt isqrt) chắc chắn lệch ⟹ vỡ P8 (CLAUDE.md: 'Bit-identical math between Aiken and TypeScript (P8)', bất biến cấp giao thức) ⟹ sổ off-chain §6 ≠ kiểm on-chain.

Cách đọc 2 (lùi) ✓ — nếu ≡ `đã_sinh` (:113): hồ sơ mới `đã_sinh=0` ⟹ `max(·,1)`=1 ⟹ tỷ_cam_kết = min(Q, K×Q) = Q với mọi K ≥ 1 nanogic ⟹ cam_kết_lịch = 1.5Q ✓ em kiểm đúng. 1.5× với chi phí 10⁻⁹ MAGIC. Quan sát 'dùng chung mẫu số ⟹ tiêu_thật và cam_kết_lịch tương quan cứng ⟹ phá giả định độc lập bảng :149-157' cũng đúng.

**SAI PHẢI SỬA:** tiêu đề ghi 'nâng w từ 11.25 lên **16.9**' nhưng thân bài tính ra **15.75**. Em chạy lại: W(e) = 2.25225×10¹⁵ + 9000×1001×1.5×10⁹ = 1.576575×10¹⁶ ⟹ w = **15.75**. Thân bài đúng, tiêu đề sai — sửa 16.9 → 15.75 trước khi trình. Đây là con số minh hoạ mượn từ finding 2, không gánh lực cho ba khẳng định lõi (không-định-nghĩa / vòng đại số+P8 / 1.5× miễn phí) — cả ba em kiểm đều đúng.

### [GIỮ_NGUYÊN] §2 "c không khai man được vì Wakeme đã ép L==c×oil" là SAI — (SỔ-VALUE) là bất biến CHUYỂN-TRẠNG-THÁI
Bác không nổi. Em kiểm từng mắt xích và tất cả đều đứng.

(1) Văn CONTRACT đúng nguyên văn: GenMAGIC-CONTRACT-Vi.md:53-55 viết 'Bất biến bắc cầu (miễn phí, KHÔNG CẦN ENGINE KIỂM)... c không khai man được' và kết 'GenMAGIC KHÔNG CẦN lớp chống-khai-man số dư riêng'. :74 chỉ thị 'c_v = conditional_lamp — đọc thẳng datum'. Đây đúng là chỉ-thị nguy hiểm, không phải diễn giải ác ý.

(2) (SỔ-VALUE) THẬT SỰ chỉ là bất biến chuyển-trạng-thái: PhoenixKey-Wakeme-Math.md:97-98 tự ghi 'Ép ở MỌI redeemer GIỮ-VAULT-SỐNG' — tức chỉ khi validator chạy. UTxO chưa ai spend thì không validator nào chạy. Đây là ngữ nghĩa ledger eUTXO, không tranh cãi được: địa chỉ vault là script address, ai cũng trả tiền vào được với inline datum bất kỳ, và output KHÔNG bị validate lúc tạo.

(3) grep 'nft|script.?hash|policy|address|apply.?param' toàn CONTRACT: chỉ ra :27 và :233 (nói MAGIC không có policy-id — không liên quan), :45 (mô tả), :57 (khẳng định). KHÔNG có MỘT mệnh đề kiểm nào. Đúng như phát hiện nêu.

(4) Biến thể (ii) em TỰ DỰNG LẠI và CHẠY THẬT: test `audit_f1ii_fake_lamp_policy_genesis_passes` PASS trên activation_logic.ak @3d5fdce — genesis_vault_ok PASS với lamp_policy apply-param = policy rác, đồng thời khẳng định `lamp_in(v, t_lamp_policy, t_lamp_name) == 0` (0 LAMP canonical). Cơ chế: genesis_vault_ok:687 `lamp_locked == d.conditional_lamp * oil_per_lamp` đọc qua `lamp_policy` vốn là apply-param, và :689 `only_expected_policies` cũng lấy chính lamp_policy giả ⟹ tự-nhất-quán hoàn hảo.

(5) Số học đúng: 10^6 vault × 1001 × 2×10^9 = 2,002×10^18; vault ma 10^12 × 12,375×10^9 = 1,2375×10^22 ⟹ share = 99,984%. Với c=10^24, tư_cách sàn Q: trọng số = 10^33 ⟹ nhịp_gen = ngân_sách×10^9/10^33 → floor 0 ⟹ M_v = 0 toàn mạng. Van :182 `nhịp_gen(e) ≤ nhịp_gen(e−1) × 1,25` chỉ chặn TRÊN, không có sàn — đúng.

Ghi chú công bằng cho hội đồng: biến thể (ii) đánh gục cách vá 'kiểm NFT đúng policy' (vì policy ≡ script-hash của chính instance — tự tham chiếu), NHƯNG nó KHÔNG đánh gục cách vá đúng: engine so địa chỉ vault với địa chỉ suy ra từ apply-param CANONICAL của DID đó. Biến thể (i) mới là mũi đâm không vá được bằng chỗ khác ngoài engine. Đây là ranh giới cần nói rõ khi giao việc vá, không làm giảm giá trị phát hiện.

### [GIỮ_NGUYÊN] `vest_start_slot` KHÔNG bị ràng buộc ở genesis ⟹ tuổi-LAMP bịa được; tuổi_epoch ÂM ⟹ trọng số ÂM ⟹ max(·,1) thành kíp nổ siêu lạm phát
Bác không nổi — đây là phát hiện mạnh nhất trong bộ, và nó nằm ĐÚNG trên sân GenMAGIC (không đổ được sang PhoenixKey).

(1) Đọc trọn genesis_vault_ok (activation_logic.ak:655-703 @3d5fdce): ép name/c∈[1,1001]/r=0/td=0/te=−1/did_commit≠∅/did_commit==owner_commit/lamp_locked/only_expected_policies/anchor_controller_ok. KHÔNG có MỘT chữ `vest_start_slot`. Không đọc `tx_lo`. Xác nhận.

(2) I-ACT-1 (Math.md:118) liệt khuôn genesis cũng BỎ SÓT vest_start_slot — đúng. Tech.md:121 'Khởi tạo (Genesis): now (slot submit)' nằm ở CỘT 'Khởi tạo' của bảng datum = quy ước backend, không phải mệnh đề ép. Đúng.

(3) CHẠY THẬT, em tự viết: `audit_f2a_vest_start_backdated_genesis_passes` PASS — vest_start lùi 24×432.000 = 10.368.000 slot, genesis PASS, đồng thời khẳng định tuổi_epoch = 24 ngay lúc đúc và days_elapsed = 120 ≤ 1001 (vẫn Daily, Reclaim vẫn chạy). §4.1: tuổi_LAMP = Q + min(24,24)×0,05Q = 2,20Q = TRẦN, giá 0. ⟹ §4.1 'đơn điệu tăng ngặt theo tuổi' + 'vault >6 epoch LUÔN > vault ít epoch hơn' (:103) bị vô hiệu.

(4) CHẠY THẬT: `audit_f2b_vest_start_future_genesis_passes_and_immortal` PASS — vest_start = 10^18, genesis PASS, days_elapsed(1,5×10^8, 10^18) == 0, và khẳng định !(0 ≥ grace_days) ∧ !(0 > phase1_last) ⟹ reclaim_ok VÀ reclaim_epoch_ok FAIL VĨNH VIỄN ⟹ vault BẤT TỬ, anti-idle không bao giờ dọn được. Neo clamp: activation_logic.ak:167-174 đúng.

(5) Sàn Q là LỜI KHẲNG ĐỊNH, không phải mệnh đề: grep 'max(0|sàn|clamp' toàn CONTRACT → :80, :91, :119, :120, :136 đều chỉ TUYÊN 'có sàn Q'. `max(·,1)` ở :120 chỉ là mẫu-số chống chia-0, KHÔNG phải sàn hệ số. §4.1:99 `tuổi_LAMP = Q + min(tuổi_epoch, TRẦN_TUỔI) × BƯỚC_TUỔI` — `min` chỉ kẹp TRÊN. KHÔNG có `max(0,·)`. Xác nhận.

(6) Số học chuỗi nổ đúng: tuổi_epoch = ⌊(1,5×10^8 − 10^18)/432.000⌋ ≈ −2,3148×10^12; tuổi_LAMP = 10^9 − 2,3148×10^12 × 5×10^7 ≈ −1,157×10^20; c=1 ⟹ trọng số ≈ −1,16×10^20; tổng mạng 2×10^18 ⟹ tổng_trọng_số ≈ −1,14×10^20 < 0 ⟹ max(·,1) = 1 ⟹ nhịp_gen = ngân_sách × 10^9. Đúng toàn bộ.

MỘT LỖI SỐ em bắt được (không đủ để bác): phát hiện ghi '1,25^73 ≈ 3×10^7'. Tính lại: log10(1,25)×73 = 7,074 ⟹ 1,25^73 ≈ 1,19×10^7, KHÔNG phải 3×10^7 — lệch 2,5 lần. Đây là con số PHỤ (mô tả van làm chậm bao lâu), không nằm trong phản-ví-dụ lõi; lõi (trường không ràng + thiếu clamp dưới) em đã tự chạy PASS. Sửa con số, kết luận không đổi: ~10^7 lần sau 1 năm vẫn là thảm hoạ.

Một chỗ nói quá nhẹ: '(a) Không mất gì' — lùi 120 ngày có rút ngắn đường chạy Daily 120/1001 ngày. Nhỏ, không đụng kết luận.

### [GIỮ_NGUYÊN] I-ACT-10 (1 DID = 1 vault) KHÔNG tồn tại on-chain; Math.md tự mâu thuẫn với chính comment trong code
Bác không nổi ở phần lõi. Phần sát thương thì có một nhánh phụ thuộc hiện thực, em tách ra dưới.

LÕI — ĐÃ CHẠY THẬT: `audit_f3_two_vaults_same_did_both_pass` (em tự viết) PASS — hai tx genesis KHÁC tx-id, CÙNG name = CÙNG owner_commit = CÙNG did_commit, cả hai đều PASS genesis_vault_ok. Cơ chế: genesis_vault_ok:665-666 chỉ ép `moved == [Pair(name, qty)] ∧ qty == 1` = 'tx NÀY đúc đúng 1', KHÔNG ép tổng cung asset đó = 1. Cardano cho mint lại cùng (policy, name) ở tx sau nếu policy không chặn. Không tiêu UTxO one-shot, không thread token, không đọc state.

MÂU THUẪN TÀI LIỆU — xác nhận từng dòng:
- CONTRACT:57 'I-ACT-10... ⟹ KHÔNG THỂ Sybil đa-vault trên cùng DID' — khẳng định.
- Math.md:130 'I-ACT-10 (1-DID-1-vault) ép qua owner_commit == did_commit == name ở genesis_vault_ok' — hậu thuẫn khẳng định đó.
- Math.md:205 'vì owner_commit là field datum do người đúc chọn, genesis KHÔNG ép duy-nhất' — TỰ BÁC LẠI, trong CÙNG tài liệu.
- activation_logic.ak:281-284 comment nói y hệt: 'owner_commit là field DATUM do người đúc chọn (genesis KHÔNG ép duy-nhất)'.
Code ép BẰNG NHAU (:674 name == d.owner_commit; :685 d.did_commit == d.owner_commit) — bằng nhau ≠ duy nhất. Suy luận của phát hiện chính xác.

Gate thật chỉ ở backend: Tech.md:393 'Precondition 1-DID-1-vault (VAULT_ALREADY_EXISTS 1350)' — off-chain, thuộc giả-định-tin-cậy. Và genesis KHÔNG kiểm LAMP đến từ pot: Math.md:280 (T-2) tự thừa nhận 'genesis_vault_ok chỉ gác VAULT dựng đúng khuôn... KHÔNG gác pot chi đúng' ⟹ tự cầm LAMP mua ngoài thị trường đúc vault được, chỉ cần controller DID của chính mình ký. D-cap 1001 per-person đổ. Xác nhận.

SÁT THƯƠNG (2) THỪA HƯỞNG HỒ SƠ — đứng vững, và đây mới là phần đáng sợ: §4.2:112-113 định nghĩa đã_tiêu/đã_sinh theo 'hồ sơ did_commit', §4.3:128 cùng cửa sổ, §4.4:143 theo hồ sơ ⟹ 3/4 thành phần là per-DID, chỉ tuổi-LAMP per-vault. Vault thứ 11 đúc hôm nay ăn ngay 2,5×1,5×1,5 = 5,625×. Ghép finding #2(a): 2,20 × 5,625 = 12,375× = ĐÚNG trần tuyệt đối §4.5:157, từ epoch đầu. Số khớp chính xác với bảng của chính CONTRACT.

TÁCH RA — sát thương (1) là ĐÚNG-CÓ-ĐIỀU-KIỆN: 'engine đọc 1 vault ⟹ tỷ_tiêu vọt ⟹ 2,50× miễn phí' phụ thuộc engine gom tử số 10 vault nhưng mẫu số 1 vault. CONTRACT không định nghĩa 'vault nào' (đó chính là lỗ), nên kịch bản hợp lý — nhưng con số 2,50× là hệ quả của một lựa chọn hiện thực cụ thể, không phải tất yếu. Không làm giảm lõi.

### [GIỮ_NGUYÊN] "Đọc qua reference_input" (§2:41, §6:208) KHÔNG cho bảo đảm on-chain nào — mượn chữ Wakeme-Tech nhưng đổi nghĩa
Bác không nổi. Em đọc thẳng nguồn bị mượn chữ và phát hiện đúng.

(1) Wakeme-Tech.md:266 nguyên văn: 'Hot-UTxO contention: VAULT là 1 UTxO — eUTXO chỉ cho MỘT tx chi nó mỗi block. GenDrip theo mẫu spend+recreate mang rủi ro này nếu dùng tần suất cao → reference-input (đọc, KHÔNG spend) là ĐIỀU KIỆN SỐNG CÒN, không chỉ tối ưu.' Nó nằm trong §3.6(a) 'Vì sao 1-L1-tx-mỗi sự kiện bất khả thi' — bàn THÔNG LƯỢNG. Không một chữ về an ninh hay chống khai man.

(2) CONTRACT:208 mượn đúng cụm 'điều kiện sống còn' + trích đúng nguồn (Wakeme-Tech §3.6), nhưng đặt nó ở hàng 'Đọc số dư' của bảng Quyết định §6 — vị trí hàm ý đây là cơ chế bảo chứng cho c. Hai chuyện khác hẳn nhau. Phát hiện mô tả chính xác.

(3) Phản chứng của phát hiện đúng về ngữ nghĩa ledger: CONTRACT:197 tự viết 'TRONG EPOCH (0 giao dịch L1 cho gen)'. reference_input là MỘT TRƯỜNG của tx. Không tx ⟹ không trường ⟹ không kiểm phase-1 ⟹ không bảo đảm. Cái engine thật sự làm là truy vấn indexer off-chain — thứ CONTRACT không đặc tả một dòng. Đối lập đúng: một tx THẬT mang reference_inputs thì ledger CÓ ép UTxO đó tồn tại + chưa bị tiêu tại thời điểm validate. Thiết kế hiện tại không có tx nào để hưởng bảo đảm đó. Toàn bộ chuỗi này đúng.

GHI CHÚ CHO HỘI ĐỒNG (đừng đếm trùng mức nghiêm trọng): #4 KHÔNG phải lỗ thứ hai độc lập — nó là CƠ CHẾ GIẢI THÍCH của #1. Cùng một gốc (không validator nào chạy ⟹ c không được bảo chứng), nhìn từ hai phía: #1 nhìn từ phía attacker (dựng UTxO ma), #4 nhìn từ phía lập luận (câu chữ biện minh sai). Vá #1 đúng chỗ (engine kiểm địa chỉ canonical + NFT + LAMP policy) là đóng luôn #4. Nên xếp #4 là luận-cứ hậu thuẫn #1, không phải hạng mục ngân sách sửa riêng.

### [GIỮ_NGUYÊN] Thời điểm lấy mẫu `c_v` / `slot_now` / `tổng_trọng_số` không được định nghĩa ⟹ "user tự tính chính xác" sai; keeper lái được M_v
Bác không nổi. Đây là phát hiện kiểu ĐẶC-TẢ-THIẾU, và cái thiếu là có thật, kiểm được bằng grep.

(1) grep 'slot_now' toàn CONTRACT → xuất hiện ĐÚNG MỘT LẦN, tại :98, trong công thức `tuổi_epoch = ⌊(slot_now − vest_start_slot)/slots_per_epoch⌋`. Được DÙNG, không bao giờ được ĐỊNH NGHĨA. Xác nhận.

(2) :71 `M_v(e) = ⌊⌊c_v × nhịp_gen(e)/Q⌋ × tư_cách_v(e)/Q⌋` và :74 'đọc thẳng datum' — không nói slot nào. :171 `tổng_trọng_số(e) = Σ_v (c_v × tư_cách_v(e))` cộng c_v của ~10^6 vault đang trôi, không mốc. Xác nhận.

(3) `c` THẬT SỰ trôi trong epoch — neo code đúng chính xác: reclaim_ok (activation_logic.ak:374-427) ép `d_out.conditional_lamp == d_in.conditional_lamp - reclaim_unit` (:401) với reclaim_unit = 1, guard `n > d_in.last_tick_day` (:397) ⟹ 1 LAMP/NGÀY, 5 lần/epoch. reclaim_epoch_ok (:490+) ép `c − q`, q = min(5,c) (:519). Xác nhận.

(4) Keeper lái được: reclaim_ok chỉ ép `n > td_in` — hạt NGÀY, KHÔNG ép giờ. Keeper tự chọn giờ submit trong ngày ⟹ dịch được c_v của bất kỳ user nào qua mốc lấy mẫu mà không vi phạm guard nào. Keeper là actor tin-cậy off-chain (Math.md:279, T-1). ⟹ :176-177 'trong epoch, mọi user TỰ TÍNH CHÍNH XÁC M_v của mình' không đứng được — c_v của chính user phụ thuộc keeper. Kết luận đúng.

(5) T-RECONCILE: PhoenixKey-MAGIC-Vault-Scale-Analysis.md:310 đúng nguyên văn 'Pass: kế toán cân bằng bit-exact (nanogic)'. Không có slot chuẩn thì không thể bit-exact theo định nghĩa. Đúng. Bổ sung: §6:212 shard theo hash(did_commit) chỉ đảm bảo 'số dư 1 DID do đúng 1 shard giữ' — KHÔNG giải quyết `tổng_trọng_số` vốn là tổng TOÀN CỤC cắt ngang mọi shard, cần ảnh chụp nhất quán mà CONTRACT không định nghĩa. Phát hiện đúng.

Quibble nhỏ, không đụng kết luận: ví dụ ghi 'c = 100 → 99 → 98 → 97 → 96 ... chênh 4%' — 5 ngày/epoch có thể là 5 lần trừ (100→95, 5%) tuỳ căn biên epoch/ngày. Con số minh hoạ, không phải phản-ví-dụ lõi.

### [GIỮ_NGUYÊN] GenDrip KHÔNG đòi chữ ký + find_vault_output chỉ khớp payment_credential ⟹ ai cũng đổi được địa chỉ vault người khác
Bác không nổi. Em tự dựng lại và CHẠY THẬT.

(1) `audit_f6_gendrip_accepts_attacker_stake_cred` (em tự viết) PASS: tx với `extra_signatories: []` (KHÔNG ai ký), vault tái tạo ở CÙNG payment_credential nhưng `stake_credential = Some(Inline(VerificationKey(attacker)))` → find_vault_output VẪN trả Some → gen_drip_ok PASS. Test khẳng định luôn `tx.extra_signatories == []`.

(2) Neo dòng đúng từng con số:
- activation_vault.ak:126-134 @3d5fdce: nhánh `GenDrip -> { ... gen_drip_ok(d_in, d_out, lamp_in_amt, lamp_out_amt, in_v, out_v, lamp_policy, own_policy) }` — KHÔNG truyền chữ ký nào.
- `owner_signed` tính ở :118-119, `keeper_signed` ở :122 — nhánh GenDrip KHÔNG dùng tới. Hai biến này chỉ phục vụ Reclaim/ReclaimEpoch.
- gen_drip_ok (activation_logic.ak:591-615): chữ ký hàm không có tham số Bool chữ ký nào; 8 mệnh đề bên trong không có mệnh đề chữ ký. Chứng minh bằng KIỂU, không cần chạy.
- find_vault_output:221 `o.address.payment_credential == Script(own_policy)` — truy cập tường minh .payment_credential, stake_credential bị bỏ qua hoàn toàn; gen_drip_ok cũng không kiểm địa chỉ.

(3) I-ACT-7 KHÔNG bị vi phạm (c không đổi, LAMP đứng yên) — đúng như phát hiện tự nhận. Đó chính là chỗ hiểm: mọi định lý money-safety §7 Math.md vẫn đúng, mà vault vẫn bị chiếm địa chỉ. Định lý bảo toàn tiền không bao hàm bảo toàn ĐỊA CHỈ. Nhận xét sắc.

(4) Mỉa mai đúng: Wakeme-Tech.md:266 nói reference-input là 'điều kiện sống còn' để tránh hot-UTxO — nhưng cửa spend permissionless vẫn mở, nên attacker chủ động tạo đúng cái hot-UTxO đó (grief keeper liveness, huỷ UTxO-ref của mọi tx đang dựng).

HAI ĐIỀU KIỆN em ghi rõ để hội đồng không đọc quá:
- 'Victim mất TOÀN BỘ gen' đúng NẾU engine tra theo địa chỉ bech32 đầy đủ. Engine tra theo payment_credential thì không mất gen — nhưng vẫn ăn đủ hai sát thương phụ (đoạt staking reward min-ADA; huỷ UTxO-ref ⟹ grief keeper ~0,2 ADA/lần). CONTRACT không chỉ dẫn cách tra ⟹ rủi ro thật, nhưng mức phụ thuộc hiện thực.
- Đây là lỗi VALIDATOR PhoenixKey, ngoài ranh giới sửa code của MAGIC (CLAUDE.md: PhoenixKey backend → KHÔNG sửa, báo anh / Issue giao đội on-chain). Nhưng nó phá thẳng giả định §6 của GenMAGIC nên MAGIC phải nêu, không được im.

### [ĐÚNG_MỘT_PHẦN] "7 field, đúng thứ tự CBOR" chưa tồn tại ở nguồn thật: plutus.json đang commit là datum 9-field (v4.1) kèm bug đơn vị ×10⁶
**Điều kiện:** ĐÚNG ở phần nguồn .ak: v5 (3d5fdce) chưa merge, `main` vẫn là datum 9-field VÀ vẫn mang bug đơn vị thiếu ×10⁶ ở genesis — em xác nhận từng dòng. CONTRACT §2:41 pin khuôn 7-field chỉ tồn tại trên nhánh chưa merge: đó là lệch spec-vs-nguồn có thật, phải vá.

SAI ở tiền đề load-bearing 'plutus.json ĐANG COMMIT trong repo': file này CHƯA BAO GIỜ được track. `git log --all -- plutus.json` rỗng; `.gitignore:5` liệt `plutus.json` với chú thích 'Generated blueprint — re-build when needed', có từ commit a02c8f2. `git check-ignore -v plutus.json` xác nhận đang bị ignore. Blueprint DUY NHẤT được track trên cả 3 nhánh là `deploy/plutus-preprod.json`, và em đã parse: nó KHÔNG chứa ActivationVaultDatum (chỉ có lamp_policy/magic_policy/taad). Nên hash `94032e38…` + 9-field mà phát hiện trích là artifact `aiken build` CŨ nằm local trên đúng máy này, không phải thứ repo phát cho ai.

HỆ QUẢ: đường lây mà phát hiện mô tả — 'engine-dev clone repo → thấy plutus.json 9-field → dựng decoder 9-field' — GÃY. Clone mới KHÔNG có plutus.json; dev buộc chạy `aiken build`, sinh lại từ .ak của nhánh đang checkout. Nhánh (2) ('dev lấy script-hash từ plutus.json ⟹ địa chỉ vault SAI ⟹ vô hiệu hoá lớp phòng thủ chính của fix #1') SẬP theo, vì dev không bao giờ nhận được file đó.

CÒN ĐÚNG, nhưng qua đường KHÁC: nhánh (1) sống — dev clone, nhánh mặc định `main`, đọc THẲNG main:lib/phoenixkey/activation_logic.ak (9-field) và dựng decoder 9-field. Bẫy index-3 là thật: conditional_lamp ở index 3 ở CẢ hai khuôn ⟹ decoder theo vị trí 'thành công' im lặng trên cả hai, không tín hiệu lỗi. Và main:798 `lamp_locked == d.conditional_lamp` THIẾU `* oil_per_lamp` — em xác nhận nguyên văn, `oil_per_lamp` không xuất hiện lần nào trong genesis của main (chỉ :783 và :798 nhắc lamp_locked). Nếu main deploy như hiện trạng thì khoá thiếu 10^6 lần — đúng 'rigor gap v4.1' mà Math.md:49 mô tả đã vá ở v5.

RỦI RO VẬN HÀNH còn lại (khác cách phát hiện phát biểu): nguy hiểm không nằm ở git mà ở việc ai đó phát tán plutus.json build cũ NGOÀI git — copy tay sang backend/rust_core, hoặc bước deploy/CI ăn phải build local cũ. Wakeme-Tech.md:475 liệt 'Rebuild plutus.json khớp v5' là CẦN THÊM — đúng, và nhất quán với việc nó là artifact chứ không phải file commit.
Bác được PHẦN KHUNG, giữ phần lõi. Đây là phát hiện duy nhất em bác được một mảng thật.

ĐÃ KIỂM ĐÚNG (giữ):
- `git branch --contains 3d5fdce` → duy nhất `claude/wakeme-closed-loop-pot`; `git merge-base --is-ancestor 3d5fdce main` → NOT merged. Xác nhận.
- main:lib/phoenixkey/activation_logic.ak datum 9-field, thứ tự ĐÚNG như phát hiện liệt: [owner_commit, did_commit, vest_start_slot, conditional_lamp, vested_unlocked, reclaimed_to_pot, last_tick_day, idle_epochs_p2, last_tick_epoch]. Xác nhận.
- main:798 `lamp_locked == d.conditional_lamp` — thiếu ×oil. Xác nhận NGUYÊN VĂN.
- v5 7-field: [owner_commit, did_commit, vest_start_slot, conditional_lamp, reclaimed_to_pot, last_tick_day, last_tick_epoch] — conditional_lamp index 3 ở CẢ HAI. Xác nhận.
- File plutus.json TRÊN ĐĨA: em parse ra n_fields = 9, đúng layout v4.1, hash 94032e38891a4a44a2e7e137b50dae420d1cc463385be2c196754048 — KHỚP CHÍNH XÁC con số phát hiện đưa. Người viết đã đọc thật, không bịa.

BÁC (tiền đề sai):
- 'File plutus.json ĐANG COMMIT trong repo... đây chính là thứ backend/rust_core/engine tiêu thụ' — SAI. Chưa từng track, gitignore từ a02c8f2, và blueprint được track duy nhất (deploy/plutus-preprod.json) không hề chứa ActivationVaultDatum. Người viết đọc file trên đĩa rồi SUY RA nó được commit, không kiểm `git ls-tree`/`git log`. Đúng bẫy mà chính nhiệm vụ này cảnh báo: đọc artifact local, tưởng là nguồn.
- Theo đó nhánh (2) sập, và cụm 'lớp phòng thủ chính bị vô hiệu ngay từ tham số đầu vào' — vốn là phần đẩy phát hiện lên mức CAO — không còn chống đỡ được.

HẠ MỨC ĐỀ NGHỊ: từ CAO xuống TRUNG BÌNH. Phát biểu lại cho đúng: 'CONTRACT §2:41 pin datum 7-field chỉ tồn tại trên nhánh CHƯA MERGE; nhánh mặc định main vẫn 9-field + bug đơn vị ×10⁶; conditional_lamp trùng index 3 nên decoder theo vị trí hỏng im lặng. Vá: merge v5 (hoặc CONTRACT ghi rõ commit neo), và cấm phát tán plutus.json build tay — buộc sinh từ CI theo commit đã pin.'

### [GIỮ_NGUYÊN] 1. §3+§5 lệch thứ nguyên đúng Q: Σ M_v = ngân_sách/10⁹, floor đầu tiên đưa M_v = 0
Em cố bác nhưng không bác được. Kiểm đại số: W = Σ c·τ = Q·Σ c·t (τ Q-format, CONTRACT:171); nhịp = B·Q/W = B/Σ(c·t); M_v = c·nhịp·τ/Q² = c·t·nhịp/Q (CONTRACT:71 chia Q hai lần) ⟹ Σ M_v = nhịp·W/Q² = B/Q. Đúng. Muốn Σ M_v = B phải có nhịp = B·Q²/W — CONTRACT:172 thiếu đúng một thừa số Q.

Chạy số thật (N=10⁶, c=1001, τ̄=4.95×10⁹, W=4.955×10¹⁸): B=5×10⁶ MAGIC ⟹ nhịp=1.009.091, bước-1 = ⌊1001×1.009.091/10⁹⌋ = 1, M_v = ⌊1×4.95⌋ = 4 nanogic, Σ = 4×10⁶ nanogic = 0,004 MAGIC (lệch 1,25×10⁹ lần). B=10⁶ MAGIC ⟹ bước-1 = ⌊0,202⌋ = 0 ⟹ M_v = 0 cho MỌI user, mọi tư_cách. Từng con số khớp chính xác.

Đường bác duy nhất em tìm được — coi `ngân_sách_gen` là Q-format (CONTRACT:170 KHÔNG ghi đơn vị; §5:188 tự nhận hàm f chưa chốt) — không cứu được: nó chỉ đổi lỗi 'phát sai 10⁹ lần' thành lỗi 'đơn vị của đại lượng nền không định nghĩa, sai một chỗ mất 10⁹ lần'. Với tiền thật đây vẫn phải vá. Chứng minh G1 ở CONTRACT:80 quả thật thiếu: M_v > 0 cần nhịp_gen ≥ Q/c_v, dòng 80 bỏ qua cả hai floor — đúng bất kể chọn cách đọc đơn vị nào.

Ba chỗ phóng đại phải trừ, KHÔNG lật được kết luận: (a) vách lượng-tử lệch một đơn vị — c=991 cho 1 (991×1.009.091 = 1.000.009.181 > 10⁹), vách thật ở c=990/991; hiện tượng còn sắc hơn finding nói (0,1% LAMP → 0 vs 4 nanogic), nên đây là lỗi mô tả, không phải lỗi lập luận. (b) 'hệ quả kép' là một lỗi, không phải hai: vá thừa số Q thì bước-1 ≈ 10⁹, floor thành bụi, và luận điểm 'thứ tự nhân đặt nhịp TRƯỚC tư_cách là lỗi' tự tan — nó không phải khiếm khuyết độc lập. (c) Câu chốt 'mọi tranh luận về G1/G4/dải-hệ-số đều vô nghĩa cho tới khi vá' SAI: thiếu-Q là lỗi THANG, mà §5:172 chuẩn hoá theo tổng trọng số nên chỉ TỶ SỐ trọng số quyết định phần chia — toàn bộ finding #2/#3/#6/#10 không đụng gì tới nó.

### [GIỮ_NGUYÊN] 2. §4.3 `giờ-thấp-điểm` là hệ số MIỄN PHÍ: 1 nanogic tiêu ở thấp điểm = trọn vẹn 1.50×
Không bác được. Đọc thẳng CONTRACT:128 — `tỷ_thấp_điểm = ⌊đã_tiêu_lúc_thấp_điểm × Q / max(đã_tiêu,1)⌋`: mẫu số LÀ CHÍNH tử-số-mở-rộng, không có mẫu độc lập, không ngưỡng tuyệt đối, không chuẩn hoá theo `đã_sinh`. Bất biến theo thang là tính chất đại số của biểu thức, không phải suy đoán. 6 nanogic/6 epoch, 100% thấp điểm ⟹ tỷ = ⌊6×10⁹/6⌋ = 10⁹ = Q ⟹ giờ = Q + 0,5Q = 1,50× TRẦN. Đúng. Bậc nhảy 0,50× giữa đã_tiêu = 0 (CONTRACT:136 sàn) và đã_tiêu = 1 nanogic là có thật, và chính dòng 136 tạo ra nó.

Hai tiền đề của kịch bản em đi kiểm riêng, cả hai đều được nguồn XÁC NHẬN chứ không bác: (a) tiêu bụi có hợp lệ không → PhoenixKey-Wakeme-Tech.md:388 'Self-consumption HỢP LỆ' + CONTRACT:222 Registry còn placeholder; (b) tiêu bụi có cần tx L1 không → CONTRACT:197 '0 giao dịch L1 cho gen'. Vậy chi phí ≈ 0 đứng vững.

Điểm em định dùng để bác — 'bot phải canh EMA hoàn hảo, mà finding #9 của chính bộ này nói EMA là trạng thái engine không ai đọc được' — không đủ lực: hệ số tuyến tính theo tỷ, bot tiêu bụi lúc 3 giờ sáng đạt ~90% thấp điểm ⟹ 1,45×, vẫn gần trần. Mâu thuẫn đó là mâu thuẫn giữa #2 và #9, không phải lỗi của #2.

Hệ quả 'CONTRACT:159 ôm-giữ tối đa = 2,20× là SAI, thật ra ≥ 3,30×' — kiểm: 2,20 × 1,00 × 1,50 = 3,30. Đúng. Đây là lỗi thật trong phép kiểm G4 của CONTRACT.

### [ĐÚNG_MỘT_PHẦN] 3. G4 GÃY — hồ sơ ôm-tối-ưu 4.95× vượt người tiêu-thật 4.74× và trả 0 đồng
**Điều kiện:** Đúng như một phát hiện về CHỨNG MINH: phép kiểm G4 ở CONTRACT:159 sai số, người ôm là 4,95× không phải 2,20× — phải vá. Sai như một phát hiện về CƠ CHẾ: chỉ thành lập ở vùng K/M < 13,3% (MAGIC dư 7,5 lần) — đúng vùng mà thứ hạng tư_cách không có hệ quả, vì MAGIC thừa không chuyển nhượng được và bay hơi. Ở vùng G4 ràng buộc (M ≲ K): C = 12,375 vs H = 4,95, G4 giữ.
Số học đúng tuyệt đối (em chạy lại: H = 4,9500; C = 4,7438; ngưỡng K/M = 13,33%; C canh giờ hoàn hảo = 5,6925 ⟹ +15%). Và phần vạch lỗi CONTRACT:159 GIỮ: phép kiểm G4 gán cho người ôm 1,0×1,0 ở giờ + cam kết, trong khi cả hai miễn phí ⟹ người ôm thật là 4,95× chứ không phải 2,20×. Chứng minh G4 của CONTRACT hỏng — đó là finding thật.

Nhưng KẾT LUẬN 'G4 gãy' thì bác. Bốn chỗ:

(1) So sánh SAI ĐẠI LƯỢNG. MAGIC không chuyển nhượng (G6; Wakeme-Math:110), reset mỗi epoch (G9), và KHÔNG có đường MAGIC→user cash — GetMAGIC là fiat→CARP một chiều (Wakeme-Tech:358-362, 397). Nên 4,95× của H là 4,95× của một thứ H không bán được, không giữ được, không dùng được. Payoff của H = 0. 'Người ôm thắng' là so hệ số danh nghĩa, không phải so lợi nhuận ròng — đúng câu hỏi mà finding tự nhận là trục của nó.

(2) CỬA SỔ GÃY LÀ CỬA SỔ VÔ NGHĨA. K/M < 13,3% ⟺ M > 7,5K ⟺ MAGIC dư thừa gấp 7,5 lần nhu cầu thật. Trong vùng đó không ai bị ràng buộc bởi tư_cách — thứ hạng không có hệ quả kinh tế. Vùng G4 THỰC SỰ ràng buộc là M ≲ K; ở đó tỷ_tiêu → 1 ⟹ tiêu_thật = 2,50 ⟹ C = 12,375 vs H = 4,95 = ăn đứt 2,5 lần. G4 giữ đúng ở vùng nó có nghĩa. Finding không đưa lập luận nào cho thấy hệ nằm ở vùng kia.

(3) 'H trả 0 đồng' phái sinh từ #2 (tiêu bụi), mà #2 sống nhờ Registry placeholder — CONTRACT:222 đã tự khai đây là 'lỗ hổng NGHIÊM TRỌNG NHẤT'. Đây là hệ quả của D1, không phải điểm gãy độc lập.

(4) Lỗi logic: 'cả hai lệch đều có lợi cho kết luận' SAI. Gán người tiêu tuổi 0 làm YẾU con số 2,6× (nó thành chặn dưới), tức lệch NGƯỢC hướng kết luận. Ý đúng của finding là 'phải so cùng tuổi', không phải 'CONTRACT gian lận hai chiều'.

Bổ sung phản ví dụ: người ôm THẬT (không tiêu gì) bị Wakeme-Math:22 bào 1 LAMP/ngày từ ngày 7 ⟹ ngày 1001 còn c ≈ 7 ⟹ M sụp. 'Người ôm' duy nhất tồn tại được là bot-tiêu-bụi.

### [ĐÚNG_MỘT_PHẦN] 4. §4.4 `cam-kết-lịch` = cheap talk chiến lược trội + đường bơm lạm phát qua pp_sched
**Điều kiện:** Đúng nếu — và chỉ nếu — cam kết ScheduleGen thật sự không thế chấp/không phạt/không trần. CONTRACT không nói có, cũng không nói không; đây là khoảng trống spec phải chốt, chưa phải lỗi đã chứng minh. Nhánh 'bơm ngân sách 90×' bác cho tới khi f được định nghĩa và chiều dấu pp_sched được chốt (CONTRACT:188). Thế lưỡng nan G9 đúng nhưng trùng mục đã treo CONTRACT:252.
Chứng minh trội đúng: tỷ·(1 + 0,5·tỷ) = C/(6B_v) đơn điệu tăng theo C ⟹ cam kết tới tỷ = 1, C* = 9·B_v. Số học 90× nhất quán với định nghĩa của chính finding. Không sai chỗ nào.

Nhưng đây là chẩn-đoán-khoảng-trống, không phải phát hiện lỗi. CONTRACT KHÔNG định nghĩa cơ chế cam kết ScheduleGen ở đâu cả — §2:62 chỉ nói `pp_sched` là 'MAGIC đã cam kết trong hợp đồng lịch', §4.4:142-147 chỉ có công thức tỷ lệ. Finding đặt giả thiết 'cam kết miễn phí' rồi suy ra trội. Giả thiết đó không có trong nguồn, và cũng không bị nguồn bác. Kết luận đúng phải là: '§4.4 dựng hệ số trên một cơ chế chưa định nghĩa; nếu cam kết không có thế chấp/phạt thì trội' — chứ không phải '§4.4 gãy'. Gánh nặng chứng minh chưa được gánh.

Nhánh bơm lạm phát yếu gấp đôi: (a) chiều dấu của pp_sched trong f — finding TỰ tag [NEEDS-EVIDENCE]; (b) bản thân f chưa tồn tại — CONTRACT:188 'ngân_sách_gen từ br_q/pp_sched theo hàm nào? Chưa chốt'; (c) CONTRACT:224 D3 còn chưa xác nhận GlobalState có br_q. Xây một kịch bản đòn bẩy 90× trên một hàm chưa ai viết thì bác — nó là cảnh báo cho người sắp viết f, không phải lỗi của bản thiết kế hiện có.

GIỮ phần sắc nhất: thế lưỡng nan G9. 'MAGIC cam kết đang hiệu lực' dưới G9 reset chỉ có hai cách đọc, (i) hứa suông ⟹ không tịch thu được gì; (ii) sống sót qua reset ⟹ ScheduleGen thành lỗ tích luỹ, phá G9(c) (CONTRACT:35) và lá chắn pháp lý §8:233. Đó là chỗ thật cần chốt. Nhưng nó KHÔNG mới: CONTRACT:252 (§9 mục 10) tự hỏi đúng câu này — finding xác nhận một mục đã treo, không phát hiện điều bị giấu.

### [ĐÚNG_MỘT_PHẦN] 5. G9 chặn tồn kho chứ không chặn dòng; bộ điều khiển §5 điều tiết biến SAI → điểm mù thanh khoản 3,3×
**Điều kiện:** Hợp lệ ở dạng đã thu hẹp: vòng ngân sách qua br_q là PHẢN ỨNG (sau khi bảo chứng đã bị bào), độ lợi và độ trễ chưa định lượng — vì f chưa chốt (CONTRACT:188) và GlobalState chưa xác nhận có br_q (CONTRACT:224, D3). Nên tính đầy đủ của nó KHÔNG chứng minh được theo cả hai chiều. Đó là khoảng trống thật đáng ghi. Bác phần 'giao thức KHÔNG đo, KHÔNG kiểm soát tiêu' và 'hệ an toàn CHỈ VÌ phần lớn MAGIC không được dùng' — CONTRACT:170+61 đọc br_q, biến mà tiêu bào mòn.
Phân biệt stock/flow là đúng và có giá trị: CONTRACT:33 G9(a) quả thật nhảy từ 'không có kho để đầu cơ' sang 'quỹ đạo cung không phân kỳ' — hai mệnh đề khác nhau. Kênh MAGIC tiêu → net CARP → Treasury có thật (CONTRACT:203; Scale-Analysis:240). Số học đúng (em chạy lại: 21,74% → 71,43% = 3,286×).

Nhưng tiêu đề 'ĐIỂM MÙ' thì bác — nó chỉ sai đối tượng. CONTRACT:170: `ngân_sách_gen(e) = f(br_q, br_safe_q, f_max_q, S, pp_sched)`, và CONTRACT:61 ghi rõ `br_q` = TỶ-LỆ-BẢO-CHỨNG đọc từ GreenBack/GlobalState. Tức đầu vào CHÍNH của ngân sách đúng là biến trạng thái mà tiêu-tích-luỹ bào mòn. Tiêu tăng 3,3× ⟹ br_q tụt ⟹ f co ngân sách. Vòng phản hồi tồn tại ngay ở dòng đầu tiên của §5. Finding nhắm vào CONTRACT:183 (bộ điều khiển tích phân) và gọi nó là 'bộ điều khiển' của hệ — nhưng dòng 183 chỉ là lớp bù cho ĐỘ TRỄ MỘT EPOCH (dòng 180-183 nói rõ nó vá cái gì), không phải cơ quan điều tiết khả năng chi trả. Bác nhầm bộ phận.

Tiền đề dân số cũng gãy: 'f = 0.9 ôm — hoàn toàn thực tế cho phân phối MIỄN PHÍ' đặt 900.000 vault ở c = 1001 với tư_cách 4,95× (tức giờ 1,50 + cam kết 1,50). Muốn giữ c = 1001 và giờ = 1,50 thì phải tiêu bụi ở thấp điểm mỗi epoch — tức 900.000 con bot, không phải người nhận-rồi-quên. Người nhận-rồi-quên bị Wakeme-Math:22 bào 1 LAMP/ngày ⟹ trọng số tự tan ⟹ pha loãng tự biến mất. Kịch bản định lượng 3,29× dựa trên một dân số không tự duy trì được.

Còn lại phần hợp lệ (xem điều kiện).

### [ĐÚNG_MỘT_PHẦN] 6. Dải 12.375× là ẢO; tích-nhân NHÂN BẢN thiệt hại thay vì bó nó
**Điều kiện:** Đúng: dải 12,375× là danh nghĩa chứ không phải phân tán thật NẾU #2 (giờ miễn phí) và #4 (cam kết miễn phí) đứng vững, và chỉ trong dân số chín/không tăng trưởng. Đúng: CONTRACT:104 sai thời điểm (176 epoch trống). Sai: 'tích ⟹ giàu càng giàu' — dưới chuẩn hoá §5:172 tích cho phản ứng tỷ lệ ĐỒNG ĐỀU (×2,5 cho cả X lẫn Y), tổng mới là hàm phá trung lập. Sai: 'CONTRACT:222 tính thiếu' — chính số của finding cho độ lợi wash 2,5× < 3,75×.
GIỮ hai chỗ: (a) dải danh nghĩa ≠ dải phân tán thật, nếu giờ + cam kết miễn phí thì chúng triệt tiêu trong chuẩn hoá CONTRACT:172 — đúng về cấu trúc; (b) CONTRACT:104 'pha Epochy bào c ⟹ không tích luỹ vô hạn' sai về thời điểm — kiểm: tuổi max ngày 120, Epochy ngày 1002, (1002−120)/5 = 176,4 epoch trống. Đúng.

BÁC lõi lập luận — 'tích = giàu càng giàu' (Đo 1) NGƯỢC. §5:172 chuẩn hoá theo tổng trọng số ⟹ chỉ TỶ SỐ trọng số quyết định phần chia; delta trọng số TUYỆT ĐỐI (+7,425 vs +1,50) không có nghĩa kinh tế. Kiểm phản ứng tỷ lệ: X 4,95 → 12,375 = ×2,500; Y 1,00 → 2,50 = ×2,500. BẰNG NHAU CHÍNH XÁC. Tích là hàm duy nhất cho động cơ biên tỷ-lệ ĐỒNG ĐỀU — bất biến theo thang. Chính TỔNG mới phá trung lập: theo số của finding, X 1,90 → 2,50 = ×1,32 còn Y 1,00 → 1,60 = ×1,60 — tổng thưởng người ở vị thế thấp nhiều hơn. Đo 1 kết luận ngược dấu.

BÁC Đo 2 — tự mâu thuẫn. Finding nói CONTRACT:222 'còn tính thiếu'. Nhưng 3,75× của §7 là ĐỘ LỢI BIÊN của wash-trade (2,5/1,0 × 1,5/1,0), tính đúng; còn kịch bản của chính finding cho wash-trader 12,375/4,95 = 2,50× — ÍT HƠN 3,75×. Theo số của chính finding thì §7 tính THỪA, không phải thiếu. Nhầm hệ số tuyệt đối với độ lợi biên.

BÁC tiền đề 'tuổi = hằng số ở cân bằng': chỉ đúng với dân số chín và không tăng trưởng. Mạng có onboarding liên tục thì các lứa khác tuổi — tuổi phân biệt thật trong 24 epoch đầu của mỗi lứa, đúng việc §4.1 sinh ra để làm. Và vault ôm THẬT bị anti-idle bào từ ngày 7 (Wakeme-Math:22) — CONTRACT:104 sai TÊN cơ chế đối trọng, không phải sai về việc có đối trọng.

Còn lại: Đo 3 ('chuyển sang tổng không mất gì') phái sinh hoàn toàn từ #2 + #4; vá ngưỡng cho giờ hoặc thế chấp cho cam kết là dải phục hồi và Đo 3 tan.

### [GIỮ_NGUYÊN] 7. §2 đọc NGƯỢC nguồn T-3: phòng tuyến chống Sybil dựa trên trích dẫn nói điều ngược lại
Không bác được — đối chiếu nguyên văn là đủ. CONTRACT:58 viết 'Sybil đa-DID chặn bởi sinh-trắc Enclave (Wakeme T-3) — ngoài phạm vi MAGIC, ghi rõ là giả-định-tin-cậy'. Nguồn được trích, PhoenixKey-Wakeme-Math.md:281, nói: 'Lỗ ở tầng mã hoá anchor (KHÔNG phải sinh trắc): GenesisPerson đúc được anchor did-string bất kỳ với controller của attacker vì HW_Key P-256 KHÔNG verify on-chain'; hệ quả 'N anchor-giả → N×D LAMP rút khỏi pot'; trạng thái 'chờ PA2 land'. Math:286 nhấn thêm: 'T-3 là lỗ ANCHOR-uniqueness (mã hoá), KHÔNG phải lo ngại sybil-sinh trắc'. Math:301 xếp GV1/PA2 mức CAO, 'TRƯỚC khi mở GetLAMP-PersonDID production'.

Tức CONTRACT lấy đúng mã của một BLOCKER ĐANG MỞ mức CAO làm tên của phòng tuyến. Đây không phải khác biệt diễn đạt — nó đảo trạng thái rủi ro, và §2 không đưa phòng tuyến nào khác cho Sybil. Số kiểm: 10⁴ anchor giả → 10.010.000 LAMP khỏi pot (khớp cách tính của chính Math:281); chiếm 0,862% ngân sách (finding ghi 0,87% — làm tròn, chấp nhận).

Ba chỗ trừ điểm, KHÔNG lật kết luận: (a) CONTRACT:223 (D2) CÓ khai uniqueness là phụ thuộc ngoài kèm chế độ hỏng 'Sybil đa-DID → nhiều vault → né trần' — nên GenMAGIC không im lặng hoàn toàn; lỗi nằm ở §2:58 phát biểu là ĐÃ CHẶN thứ mà §7 khai là có thể hỏng, hai chỗ trong cùng tài liệu chỏi nhau. (b) Ngoại suy tuyến tính tới 10⁶ anchor → 46% quá lạc quan cho kẻ tấn công: D = min(1001, ⌊pot/10⁶⌋) (Math:33; Tech:398 phơi cờ `saturated`) nên pot cạn thì D tụt, đòn tự giới hạn. (c) Mỗi vault giả phải chạy bot tiêu bụi mới giữ được 4,95× (phái sinh #2/D1) — vault giả nằm im bị bào 1 LAMP/ngày (Math:22). Cả ba không đụng lõi: spec khẳng định một phòng tuyến mà nguồn nó trích đang phủ nhận.

### [ĐÚNG_MỘT_PHẦN] 8. §4.2 chống cá voi phòng thủ mối đe doạ KHÔNG TỒN TẠI, bỏ hở hai kênh cá voi THẬT
**Điều kiện:** Đúng và đáng vá: MIN_MAGIC_TX là ngưỡng tuyệt đối, lũy thoái theo quy mô, nằm ở biên hai spec, còn 'TẠM' (Math:304) — phản ví dụ c=40 / M=0,2 / MIN=0,5 kiểm được. Sai: tuyên bố '§4.2 phòng thủ mối đe doạ không tồn tại' — dải c là [1,1001] (1000×, chính kịch bản của finding dùng 25×), và đo-tỷ-lệ chính là thứ chặn dải đó nhân vào tư_cách. Sai: 'mọi vault khởi đầu bằng nhau' — D phụ thuộc pot (Math:33, Tech:398).
GIỮ kênh (3) — đây là phần có giá trị thật và cụ thể. MIN_MAGIC_TX là ngưỡng TUYỆT ĐỐI (Wakeme-Tech:340 `active = M_profile(n) ≥ MIN_MAGIC_TX`), còn ghi 'TẠM' (Wakeme-Math:304), và nó nằm đúng đường nối hai spec nên không bên nào soi. Phản ví dụ kiểm được: c = 40 ⟹ M_B ≈ 5×40/1001 = 0,2 MAGIC/epoch < MIN = 0,5 ⟹ B tiêu 100% suất vẫn không 'active' ⟹ tiếp tục bị bào 1 LAMP/ngày (Math:22) ⟹ c → 0. Vòng lặp lũy thoái có thật. Đáng vá.

BÁC tiền đề (1) — nó tự bẻ mình. Finding tuyên bố 'cá voi LAMP KHÔNG TỒN TẠI ĐƯỢC, mọi vault khởi đầu với ĐÚNG cùng một lượng LAMP', rồi kịch bản của chính nó dựng A ở c = 1001 và B ở c = 40 — chênh 25 lần. Dải cấu trúc là c ∈ [1, 1001] (Math:118 I-ACT-1; MONO-c :104) = 1000 lần. Và §4.2:118 'đo TỶ LỆ, không đo LƯỢNG' chính là thứ chặn dải 1000× đó khỏi nhân tiếp vào tư_cách: nếu tỷ_tiêu đo LƯỢNG, vault c=1001 (M=5) đè bẹp vault c=40 (M=0,2) ở cả hệ số; đo tỷ lệ thì c=40 tiêu hết vẫn chạm trần tư_cách. Đó là tính chất thật, phòng thủ mối đe doạ thật.

BÁC 'mọi vault khởi đầu bằng nhau': D = min(1001, ⌊pot_oildrop/10⁶⌋) (Math:33) — D phụ thuộc trạng thái pot lúc genesis, Tech:398 phơi hẳn `current_d_lamp` + `saturated`. Bằng nhau chỉ khi pot bão hoà.

BÁC kênh (2): nó không phải nội dung của #8, chỉ trỏ sang #7.

Kênh CARP: finding tự tag [NEEDS-EVIDENCE] — đúng, và Tech:358-362/397 cho thấy GetMAGIC là fiat→CARP; không nguồn nào trong 4 nói CARP mua được cộng vào `đã_tiêu`. Bác cho tới khi có neo.

Lỗi khung: #8 lấy một ngưỡng ở tầng LAMP (Wakeme) để tuyên bố một khẳng định ở tầng MAGIC (§4.2) là sai. §4.2 chỉ phát biểu về hệ số tư_cách, và ở phạm vi đó nó đúng. Trộn tầng để dựng mâu thuẫn.

### [ĐÚNG_MỘT_PHẦN] 9. User KHÔNG thể tự tính `tư_cách` ⟹ lý do biện minh trễ-một-epoch của §5 mất căn cứ
**Điều kiện:** Đúng và phải vá: `giờ_thấp_điểm` không kiểm chứng được, nằm ngoài ranh giới tin cậy CONTRACT:214, và kênh gán-nhãn-sai → −6,7% âm thầm + chia lại cho vault của operator là lỗ hổng thật (CONTRACT:253 tự nhận chưa định lượng bond/fraud-proof). Sai: '§5 chỉ có MỘT lý do' — CONTRACT:178 có lý do chống-đua-đào độc lập, sống nguyên; và trễ-một-epoch vẫn giao được 'đo-lường-được' vì cửa sổ [e−6,e) nửa mở khoá tư_cách trước khi epoch bắt đầu.
GIỮ phần quan trọng nhất: `giờ_thấp_điểm` không kiểm chứng được. CONTRACT:132-134 định nghĩa thấp-điểm bằng dual-EMA trên TOÀN BỘ dòng tiêu mạng, và dòng 134 tự nói engine giữ dữ liệu đó. CONTRACT:214 bảo đảm operator 'KHÔNG thể bịa/sửa delta đã cosign' — nhưng NHÃN thấp/cao điểm không phải delta có cosign, nên nó nằm NGOÀI ranh giới tin cậy. Kênh rút giá trị là thật: gán nhãn sai 20% ⟹ tỷ 1,0 → 0,8 ⟹ giờ 1,50 → 1,40 ⟹ −6,7% suất vĩnh viễn, không phát hiện được, và phần bị lấy chia lại qua chuẩn hoá §5:172 — kể cả cho vault operator kiểm soát. CONTRACT:253 tự nhận bond + cửa-sổ-fraud-proof chưa định lượng. Đây là gap thật, nên vá.

BÁC kết luận — 'MỘT lý do duy nhất' SAI. CONTRACT:178 nêu lý do THỨ HAI, độc lập: '...và thành cuộc đua đào (share của tôi phụ thuộc người khác làm gì trong cùng epoch)'. Lý do này không dính gì tới user-tự-tính: dùng tổng_trọng_số(e) thì phần chia của mỗi người phụ thuộc hành vi đồng thời của người khác — đó là lý do cấu trúc, sống nguyên vẹn dù #9 đúng 100%. Nên 'toàn bộ đánh đổi là khoản chi không mua được gì' sụp: van 1,25× và bộ bù kỳ sau vẫn mua được tính chất chống-đua-đào.

BÁC luôn phần đánh tráo khái niệm: 'đo-lường-được' (biết suất từ ĐẦU epoch) ≠ 'tự-kiểm-chứng-được' (tái tạo độc lập không cần tin engine). Trễ-một-epoch giao cái thứ nhất bất kể ai tính: cửa sổ §4.2:111 là [e−6, e) NỬA MỞ ⟹ tư_cách_v(e) đã CỐ ĐỊNH lúc epoch e bắt đầu ⟹ engine công bố nhịp_gen + tư_cách đầu epoch là user biết chính xác M_v cả epoch. CONTRACT:102 chỉ tuyên bố tự-tính cho `tuổi_LAMP`, và ở đó nó đúng. Văn CONTRACT:176 dùng chữ 'tự tính' là lỏng — nhưng đó là lỗi CHỮ, không phải mất tính chất.

### [ĐÚNG_MỘT_PHẦN] 10. G9 dùng-hay-mất TẠO cơn dồn cuối epoch — chính là cao điểm mà §4.3 phạt
**Điều kiện:** Đúng như một căng thẳng ĐÁNG SOI khi chốt hằng-số-thời-gian EMA và TRẦN_THẤP_ĐIỂM: hạn chót G9 toàn cục, không phản ứng với ưu đãi, nên §4.3:135 'tự cân bằng' không áp cho đỉnh do hạn chót sinh ra. Sai như một cơ chế: (a) cơn dồn chỉ tồn tại khi M ≲ K, chế độ ngược với tiền đề #3 — trong kịch bản M = 5K của chính finding, 4 MAGIC thừa không mua được gì nên không có gì để dồn; (b) ở chế độ M ≲ K, người tiêu dồn cuối kỳ = 8,25× vs bot 4,95× — vẫn thắng 1,67 lần; (c) nhãn cao/thấp điểm phụ thuộc hằng số EMA chưa chốt (CONTRACT:132-133).
Căng thẳng hai tiên đề là thật và đáng ghi; số học đúng (Lan = 4,2900; bot = 4,9500; +15,4%). Hạn chót epoch là toàn cục thật (432.000 slot, CONTRACT:98).

Nhưng kịch bản TỰ MÂU THUẪN, và đó là chỗ bác. Cơn dồn cần MAGIC sắp mất phải CÓ GIÁ TRỊ với chị Lan. MAGIC không chuyển nhượng (G6; Wakeme-Math:110), không cash ra được (Tech:358-362, 397 — GetMAGIC là fiat→CARP một chiều), chỉ tiêu được vào dịch vụ THẬT. Trong chính kịch bản, cầu thật của Lan là 1 MAGIC còn suất là 5 ⟹ 4 MAGIC kia không mua được thứ gì Lan cần ⟹ KHÔNG có mất mát để mà ác cảm ⟹ không có cơn dồn. Muốn Lan dùng hết 5 thì K = 5, không phải 1. App báo 'còn 6 giờ, 4 MAGIC sắp mất' chỉ là hoảng loạn về một thứ vô dụng.

Cơn dồn chỉ hình thành khi MAGIC KHAN so với cầu thật (M ≲ K) — đúng chế độ NGƯỢC với tiền đề của finding #3 (K/M = 0,10). Hai finding cần hai thế giới đối nghịch. Và trong chế độ cơn-dồn có thật (M ≲ K): tỷ_tiêu → 1 ⟹ tiêu_thật = 2,50 ⟹ người tiêu dồn cuối kỳ = 2,20 × 2,50 × 1,00 × 1,50 = 8,25× vs bot 4,95× ⟹ người tiêu thật vẫn thắng 1,67 lần DÙ ăn sàn ở giờ. Kết luận 'cơ chế chuyển giá trị từ người dùng thật sang bot' bị chính phản ví dụ này bác ở đúng chế độ mà finding cần.

Thêm: 'cửa sổ cuối epoch = CAO ĐIỂM' phụ thuộc hoàn toàn hằng-số-thời-gian của dual-EMA, thứ CONTRACT:132-133 KHÔNG chốt. Đỉnh tuần hoàn 5 ngày/lần được EMA-chậm phủ trọn chu kỳ HỌC vào nền ⟹ thành cầu-nền, không phải cao điểm. Đây là bài toán tham số, không phải gãy cấu trúc — nên 'hai tiên đề đánh nhau' quá mạnh so với bằng chứng.

Finding tự tag [NEEDS-EVIDENCE] cho biên độ. Đúng — và không có neo nào trong 4 nguồn.

## §3. Phát hiện gốc từng trục

### [CAO] cam-kết-lịch (§4.4) là hệ số thứ 4 tốn state riêng nhất trong khi hiệu ứng gần như đã được tiêu-thật (§4.2) hấp thụ được — nên gộp CÁCH TÍNH, không cần một tầng nhân riêng
- **Neo:** CONTRACT §4.4 dòng 138-147, §4.2 dòng 110-121, §9 mục 2 dòng 244, §9 mục 11 dòng 253
- **Mô tả:** VẤN ĐỀ GỐC: engine cần một cơ chế thưởng cho hồ sơ có MAGIC đang cam kết trong ScheduleGen (chỉ đạo của anh, §4.4 dòng 138-147), nhưng KHÔNG có ràng buộc vật lý/giao thức nào buộc đây phải là MỘT HỆ SỐ NHÂN RIÊNG trong chuỗi tích-4. GIẢ ĐỊNH BỎ ĐƯỢC: 'mỗi mục tiêu kinh tế = một hệ số nhân riêng' — đây là thói quen thiết kế (giống cấu trúc VP-governance tích-4-tham-số) chứ không phải yêu cầu bắt buộc; tiêu_thật (§4.2) đã có sẵn cơ chế tỷ_tiêu = đã_tiêu/đã_sinh đúng dạng cần để thưởng 'cam kết dùng MAGIC' — cam kết ScheduleGen về bản chất KHÁC 'tiêu thật' (chưa tiêu, chỉ khoá lịch) nhưng CÙNG là tín hiệu 'ý định dùng MAGIC trong tương lai gần', có thể cộng thẳng vào tử số đã_tiêu của §4.2 thay vì mở một chuỗi floor-div riêng. So sánh chi phí dữ liệu: cam_kết_lịch hiện tại cần engine theo dõi thêm 2 luồng mới per-DID/epoch (magic_cam_kết_đang_hiệu_lực — đọc từ ScheduleGen state, VÀ sinh_kỳ_vọng_6_epoch — MỘT KHÁI NIỆM CHƯA ĐỊNH NGHĨA RÕ trong contract, dòng 143 chỉ viết 'max(sinh_kỳ_vọng_6_epoch,1)' không có công thức). Việc thiếu định nghĩa sinh_kỳ_vọng_6_epoch là gap thật (không phải suy đoán) — nếu nó = đã_sinh (tái dùng dữ liệu §4.2) thì không tốn thêm data, nhưng contract không nói rõ ràng buộc này, để mỗi implementer tự đoán → rủi ro lệch Aiken/TS (vi phạm P8 bit-identical, CLAUDE.md 'Bit-identical math'). HÀM MỤC TIÊU: giảm số luồng state độc lập engine phải audit (mỗi luồng thêm = thêm bề mặt gian sổ mà §9 mục 11 đã cảnh báo là 'chưa định lượng bond'), và giảm số bước floor-multiply-divide/epoch/vault (hiện 3 bước nhân tuần tự cho 4 hệ số, dòng 88).
- **Kịch bản:** DID X có c=100 LAMP, cửa sổ 6 epoch: đã_sinh=1000 (đơn vị nanogic quy đổi), đã_tiêu thật=200, magic_cam_kết_đang_hiệu_lực trong ScheduleGen=300. Cách hiện tại: tỷ_tiêu=200/1000=0.2 → tiêu_thật=Q+0.2×1.5Q=1.30Q. Giả sử sinh_kỳ_vọng_6_epoch được implementer A hiểu là 'đã_sinh của chính vault' =1000: tỷ_cam_kết=300/1000=0.3 → cam_kết_lịch=Q+0.3×0.5Q=1.15Q. Tổng nhân 2 bước=1.30×1.15=1.495Q. Nhưng implementer B (đọc contract khác, vì không có định nghĩa) hiểu sinh_kỳ_vọng_6_epoch = 'dự báo tuyến tính từ nhịp_gen(e-1)×c_v×6' — ra một con số khác hẳn (VD 1500) → tỷ_cam_kết=300/1500=0.2 → cam_kết_lịch=1.10Q → tổng=1.30×1.10=1.43Q. Hai implementation cho cùng input ra kết quả LỆCH 4.5% MAGIC phát cho cùng một DID — đúng loại lỗi P8 (bit-identical) mà CLAUDE.md coi là nghiêm trọng (TV-OVERFLOW class). Nếu gộp thẳng vào đã_tiêu: đã_tiêu'=200+300=500 → tỷ_tiêu'=0.5 → tiêu_thật'=Q+0.5×1.5Q=1.75Q (1 bước, không mơ hồ, không cần định nghĩa sinh_kỳ_vọng).
- **Đề xuất:** 1) Nếu giữ tách 4 hệ số: bổ sung NGAY định nghĩa chính xác sinh_kỳ_vọng_6_epoch bằng công thức đóng (đề xuất: = đã_sinh của cùng cửa sổ [e-6,e), tái dùng dữ liệu §4.2, không cần luồng mới) vào CONTRACT trước khi giao dev — đây là gap phải vá bất kể chọn phương án nào. 2) Phương án tối giản hơn: gộp magic_cam_kết_đang_hiệu_lực vào tử số đã_tiêu của §4.2 (coi cam kết ScheduleGen là 'tiêu cam kết'), bỏ hẳn bước nhân cam_kết_lịch riêng — giảm 4→3 hệ số, giảm 1 bước floor-div/epoch/vault, giảm 1 luồng state cần audit trong sổ off-chain (§6), đồng thời loại bỏ khái niệm sinh_kỳ_vọng chưa định nghĩa. ĐÁNH ĐỔI: mất khả năng hiển thị riêng 'thưởng vì cam kết lịch' cho user trên dashboard (chỉ còn 1 con số tổng hợp tiêu_thật) — cần cân nhắc TRẦN_TIÊU mới nếu gộp (vd nâng lên ~1.7Q để bù phần cam_kết cũ) vì dải kết quả không tương đương y hệt, cần hội đồng chốt lại số.

### [TRUNG] Tích-nhân tuần tự 4 hệp số khiến sai lệch/lỗi ở MỘT hệ số phụ (giờ-thấp-điểm hoặc cam-kết-lịch, dải chỉ 1.00-1.50×) nhân dồn vào TOÀN BỘ multiplier của trục chính G4 (tiêu-thật, dải 1.00-2.50×) — trong khi 2 hệ số phụ này là 2 hệ số duy nhất có state TỰ-THAM-CHIẾU (đã bị §9 mục 4,5 cảnh báo dao động/cộng hưởng)
- **Neo:** CONTRACT §3 dòng 88-91, §4.3 dòng 128-136, §4.4 dòng 143, §9 mục 2 dòng 244, §9 mục 5 dòng 247
- **Mô tả:** HÀM MỤC TIÊU đang xét: độ ổn định số học (không cho lỗi/nhiễu ở 1 tầng lan sang toàn bộ), và chi phí dữ liệu/audit. Thiết kế tích tuần tự (dòng 88: ⌊⌊⌊tuổi×tiêu_thật/Q⌋×giờ_thấp_điểm/Q⌋×cam_kết_lịch/Q⌋) nghĩa là NẾU giờ-thấp-điểm hoặc cam-kết-lịch bị thao túng/tính sai (2 hệ số này phụ thuộc dữ liệu tự-tham-chiếu: EMA cầu-mạng tính từ chính dòng tiêu mà nó điều khiển — §4.3 dòng 133-135; sinh_kỳ_vọng có thể vòng lặp với chính tư_cách — §4.4 dòng 143), sai số đó KHÔNG bị giới hạn ở phần đóng góp của nó (tối đa ±50% biên) mà nhân thẳng vào kết quả cuối, kéo theo cả phần tiêu-thật (G4, trục chính, đáng tin cậy nhất vì tính trực tiếp từ sổ tiêu có cosign) cũng bị lệch theo tỷ lệ. Ngược lại, nếu 2 hệ số phụ dùng dạng CỘNG-BÙ (additive bonus trên nền tích tuổi×tiêu_thật) thì lỗi ở chúng chỉ cộng thêm sai số TUYỆT ĐỐI giới hạn, không nhân dồn vào trục chính đã được audit tốt hơn (tiêu_thật dựa trực tiếp trên cosign sổ tiêu, không qua EMA/dự báo).
- **Kịch bản:** Giả sử vault Y có tuổi_LAMP=2.20Q (max), tiêu_thật=2.50Q (max, tiêu hết đúng hạn — công dân hạng nhất thật sự). Nền tảng (tích 2 trục chính) = 2.20×2.50=5.50Q — đây là con số MUỐN thưởng đúng cho G4. Nhưng nếu giờ_thấp_điểm bị lỗi tính (do EMA dao động cộng hưởng mà §9 mục 5 nêu) lệch xuống 0.90Q thay vì đúng phải là 1.20Q (lỗi 25% ở TẦNG PHỤ) → kết quả cuối = 5.50×0.90×cam_kết=4.95×cam_kết thay vì đúng 5.50×1.20×cam_kết=6.60×cam_kết — người tiêu-thật-nhất bị THIỆT khoảng 25% MAGIC vì một lỗi hoàn toàn nằm ở tầng phụ giờ-thấp-điểm, không liên quan gì tới hành vi tiêu-thật của họ. Nếu dùng cộng-bù: kết quả = 5.50×(1 + bonus_thấp_điểm + bonus_cam_kết) với bonus mỗi phần cộng dồn tối đa +0.5/+0.5, lỗi 25% ở bonus_thấp_điểm chỉ làm lệch phần cộng đó (tối đa ±0.125 trên tổng số ~2.0), tức lệch tuyệt đối nhỏ hơn nhiều lần so với nhân dồn.
- **Đề xuất:** Xét chuyển 2 hệ số phụ (giờ-thấp-điểm, cam-kết-lịch — cả hai đều dải hẹp 1.00-1.50× và đều dựa trên dữ liệu tự-tham-chiếu/dự báo) sang dạng CỘNG-CÓ-TRẦN trên nền tích 2 trục chính (tuổi × tiêu-thật, vốn đã đủ thoả G2+G4): tư_cách = (tuổi × tiêu_thật/Q) × (Q + bonus_thấp_điểm + bonus_cam_kết), mỗi bonus kẹp trần riêng như cũ. ĐÁNH ĐỔI: dải tối đa giảm nhẹ (tích 2×1.5×1.5=4.5 vs cộng 1+0.5+0.5=2.0 nhân với nền — cần hội đồng chốt lại số cho khớp mục tiêu kinh tế ban đầu, đây KHÔNG phải thay đổi trung tính, cần review G3/G8 lại). Nếu hội đồng thấy việc 'nhân dồn lỗi tầng phụ vào trục chính' là CHỦ Ý (muốn phạt mạnh khi sai lệch điều-tiết cung-cầu) thì GIỮ NGUYÊN tích tuần tự — nhưng phải nói rõ đây là lựa chọn có ý thức, không phải mặc định vô can.

### [THẤP] tuổi-LAMP (§4.1) là mẫu tối giản đúng — không tìm ra vấn đề, nên dùng làm chuẩn đối chiếu cho 3 hệ số còn lại
- **Neo:** CONTRACT §4.1 dòng 93-104, §2 dòng 47
- **Mô tả:** Không tìm ra vấn đề tối giản ở hệ số này. tuổi_LAMP đọc thẳng field có sẵn trong ActivationVaultDatum (vest_start_slot, đã có sẵn cho mục đích khác — §2 dòng 47) + slot_now (miễn phí từ tx context) — KHÔNG cần engine lưu thêm bất kỳ state nào, KHÔNG tự-tham-chiếu, user tự tính được 100% (đúng tinh thần 'để user có thể đo lường' mà anh yêu cầu, dòng 102). Đây là chi phí dữ liệu THẤP NHẤT trong 4 hệ số — 0 luồng bổ sung, so với tiêu_thật (2 luồng), giờ_thấp_điểm (1 luồng + EMA toàn mạng), cam_kết_lịch (2 luồng, 1 chưa định nghĩa). Nêu ra để làm điểm neo so sánh: nếu hội đồng chấp nhận đề xuất gộp/cộng ở 2 finding trên, kết quả cuối (tuổi × tiêu_thật là trục chính, 2 hệ số phụ nhẹ hơn) sẽ giống cấu trúc 'lõi rẻ + phụ trợ nhẹ' mà tuổi-LAMP đang minh hoạ, thay vì 'bốn tầng ngang hàng cùng chi phí'.
- **Kịch bản:** Không có phản ví dụ — đây là ghi nhận điểm KHÔNG có vấn đề, theo yêu cầu 'nếu không tìm ra vấn đề thì nói thẳng'.
- **Đề xuất:** GIỮ NGUYÊN tuổi-LAMP như hiện tại (§4.1). Không cần sửa.

**Đã điểm qua:** Track được giao: NGUYÊN LÝ GỐC + TỐI GIẢN (không phải rà toàn bộ §9). Đã tập trung vào §9 mục 2 (tích-nhân 4 hệ số đúng hay tổng-có-trọng-số — TRẢ LỜI: nên xét chuyển 2 hệ số phụ sang cộng-có-trần, xem finding 2) và câu hỏi riêng về §4.4 cam-kết-lịch (TRẢ LỜI: có thể gộp cách tính vào tiêu-thật §4.2, không cần tầng nhân riêng — finding 1, kèm phát hiện gap thật: sinh_kỳ_vọng_6_epoch chưa có công thức đóng, rủi ro vi phạm P8 bit-identical).

Có chạm nhẹ (không đào sâu, vì ngoài phạm vi track Optimizer): §9 mục 4/5 (tự-tham-chiếu tỷ_tiêu và EMA giờ-thấp-điểm) — dùng làm căn cứ cho finding 2 về rủi ro nhân-dồn-lỗi, nhưng KHÔNG tự đánh giá hội tụ toán học (đó là việc của track khác). §9 mục 11 (an ninh sổ off-chain) — chạm vì mỗi hệ số thêm = thêm luồng cần audit, nhưng không đánh giá bond/fraud-proof cụ thể.

KHÔNG đụng tới (ngoài phạm vi track này, để track khác đánh): §9 mục 1 (D1 wash-trade), mục 3 (trễ-một-epoch §5), mục 6 (G4 số học), mục 7 (cold-start), mục 8 (đối chiếu Wakeme/I-ACT), mục 9 (pháp lý), mục 10 (G9 decay reset vs §4.4 — có liên quan tới finding 1 nhưng không phân tích sâu góc quỹ đạo cung dài hạn), mục 12 (vận hành/escape-hatch).

Kết luận tổng quát của track: 3/4 hệ số (tuổi, tiêu-thật, và phần lõi của tích) là hợp lý và chi phí dữ liệu thấp — GIỮ NGUYÊN. 2 hệ số phụ (giờ-thấp-điểm, cam-kết-lịch) là nơi có thể tối giản CÁCH THỰC HIỆN (không phải bỏ hiệu ứng anh đã chốt) để giảm luồng state, giảm bước nhân tuần tự, và giảm rủi ro nhân-dồn-lỗi vào trục chính G4.

### [NGHIÊM TRỌNG] "Bất biến bắc cầu" (§2) chỉ đúng cho vault THẬT — CONTRACT không nói engine xác thực reference_input là vault chính chủ (vault-NFT), mở đường mint MAGIC vô hạn từ UTxO giả
- **Neo:** MAGIC/Specs/GenMAGIC-CONTRACT-Vi.md §2 dòng 39-63 (đặc biệt dòng 53-57); đối chiếu Wakeme-Tech §1.2 dòng 72 (vault-NFT singleton) + §2.4 dòng 165-177 (own_policy ≡ script-hash apply-param per-DID, pot_address/keeper_pkh là tham số apply-param riêng từng vault)
- **Mô tả:** CONTRACT §2 khẳng định "Bất biến bắc cầu (miễn phí, không cần engine kiểm)": vì Wakeme ép L(vault)==c×oil_per_lamp ở MỌI redeemer nên c không khai man được, do đó GenMAGIC không cần lớp chống-khai-man riêng. Lập luận này ĐÚNG nhưng chỉ với điều kiện tiền đề không được nêu ra: reference_input mà engine đọc phải THẬT SỰ là vault sinh bởi genesis_vault_ok (tức mang đúng vault-NFT, policy = own_hash apply-param theo DID, name = owner_commit). CONTRACT không hề nói engine kiểm tra điều này — toàn bộ tài liệu (đã grep từ khoá NFT/policy/script-hash/address) không có một dòng nào yêu cầu GenMAGIC xác thực vault-NFT hay địa chỉ script khi đọc datum. Nếu engine off-chain chỉ decode bất kỳ UTxO nào có inline datum ĐÚNG HÌNH DẠNG 7-field CBOR (ActivationVaultDatum) mà không lọc theo vault-NFT/địa chỉ canonical, thì bất biến (SỔ-VALUE) của Wakeme — vốn chỉ được validator ép tại các UTxO THẬT SỰ đi qua genesis_vault_ok — trở nên vô nghĩa với những UTxO không đi qua validator đó.
- **Kịch bản:** Kẻ tấn công không nắm LAMP thật nào. Họ dựng một UTxO bất kỳ (kể cả tại địa chỉ ví thường, không cần script) mang inline datum Constr 0 7-field: owner_commit=<did giả>, did_commit=<did giả>, vest_start_slot=<slot cách đây 25 epoch để đạt trần tuổi_LAMP>, conditional_lamp=1001 (trần D), reclaimed_to_pot=0, last_tick_day=0, last_tick_epoch=-1. Không có LAMP token thật nào bị khoá kèm UTxO này (hoặc chỉ gắn một token tên trùng "LAMP" dưới policy tự mint, vì không ai kiểm lamp_policy khớp canonical). Nếu engine GenMAGIC index theo hình-dạng-datum thay vì theo vault-NFT, mỗi epoch UTxO giả này vẫn được tính M_v(e) = ⌊⌊1001 × nhịp_gen(e) / Q⌋ × tư_cách_v(e) / Q⌋ với tư_cách sàn ≥Q — tạo ra MAGIC thật (nanogic) không có LAMP backing nào. Nhân bản UTxO này N lần = N lần lượng MAGIC đó, không giới hạn, không tốn gì ngoài phí ADA tạo UTxO.
- **Đề xuất:** Bổ sung vào §2 một mệnh đề ép rõ ràng: engine CHỈ chấp nhận reference_input thoả (a) address == script address canonical của activation_vault (apply-param theo did_commit), VÀ (b) UTxO mang đúng vault-NFT (policy=own_hash, name=owner_commit) đã mint qua genesis_vault_ok. Không có 2 điều kiện này, toàn bộ tuyên bố "miễn phí, không cần engine kiểm" là sai với mô hình đe doạ thật (adversarial input), không chỉ với mô hình honest-vault.

### [CAO] "Kiểm G4" (§4.5) tính sai trần ôm-giữ — cam-kết-lịch không bị chặn bởi tiêu-thật, người ôm-giữ thuần có thể đạt 3.30× chứ không phải 2.20×
- **Neo:** MAGIC/Specs/GenMAGIC-CONTRACT-Vi.md §4.4 dòng 138-147, §4.5 dòng 159-161, §7 dòng 220-226 (bảng D1-D4 không có mục cho cam_kết_lịch)
- **Mô tả:** §4.5 khẳng định người ôm-giữ tối đa chỉ đạt 2.20× (chỉ nhờ tuổi_LAMP, ba hệ số còn lại ở sàn 1.0×), và người tiêu-thật hết đạt 5.63× ⟹ "ăn đứt 2.6 lần". Nhưng công thức cam_kết_lịch (§4.4) không có điều kiện nào ràng buộc vào tiêu_thật — nó chỉ so magic_cam_kết_đang_hiệu_lực với sinh_kỳ_vọng_6_epoch, hoàn toàn độc lập với việc có "tiêu MAGIC cho dịch vụ THẬT" (G4) hay không. Một người chưa từng tiêu gì (tiêu_thật=1.0×, giờ_thấp_điểm=1.0× theo đúng logic sàn ở dòng 119, 136) vẫn có thể đưa MAGIC do mình tự sinh (nhờ G1 — nắm LAMP là có gen) vào hợp đồng ScheduleGen để lấy cam_kết_lịch tới 1.5×. Đây thậm chí là lối thoát TỰ NHIÊN dưới áp lực G9 (MAGIC dùng-hay-mất mỗi epoch) — một người ôm-giữ hợp lý sẽ ưu tiên "cam kết" MAGIC (không mất, không cần dịch vụ thật) hơn là để nó bốc hơi. §7 (bảng phụ thuộc D1-D4) chỉ liệt kê rủi ro wash-trade cho tiêu_thật/giờ_thấp_điểm, không hề nhắc tới lỗ tương tự ở cam_kết_lịch — một khoảng trống MECE trong chính bảng rủi ro của CONTRACT.
- **Kịch bản:** Người dùng X: tuổi_LAMP đã tối đa (2.20×, giữ LAMP ≥24 epoch), chưa từng tiêu MAGIC cho dịch vụ thật (tiêu_thật=1.0×, giờ_thấp_điểm=1.0× vì đã_tiêu=0), nhưng mỗi epoch đưa toàn bộ MAGIC vừa sinh vào một hợp đồng ScheduleGen (có thể tự lập, không cần đối tác thật vì §4.4 không đòi hỏi Registry-gate) để magic_cam_kết_đang_hiệu_lực ≈ sinh_kỳ_vọng_6_epoch ⟹ tỷ_cam_kết=Q ⟹ cam_kết_lịch=1.5×. Tư_cách_X = 2.20×1.0×1.0×1.5 = 3.30×, không phải 2.20× như §4.5 khẳng định. So với người tiêu-thật-hết-mọi-mặt (5.63×), tỷ lệ ăn-đứt thực tế chỉ còn 5.63/3.30 ≈ 1.71 lần, không phải 2.6 lần — làm yếu cả mục tiêu G4 lẫn lá chắn pháp lý (2) ở §8 (dựa trên con số 2.6×).
- **Đề xuất:** Hoặc (a) gate cam_kết_lịch bằng một ngưỡng tiêu_thật tối thiểu trong cùng cửa_sổ 6-epoch, hoặc (b) tính lại "Kiểm G4" với kịch bản ôm-giữ-tối-ưu bao gồm cam_kết_lịch (3.30×, không phải 2.20×) và đánh giá lại liệu tỷ lệ 1.71× có còn đủ để giữ tuyên bố G4 hay không, đồng thời bổ sung dòng cho cam_kết_lịch vào bảng phụ thuộc §7.

### [CAO] Lá chắn pháp lý (1) "MAGIC không chuyển nhượng ⟹ không bán được ⟹ không thể là thu-nhập" bỏ qua đường vòng CARP-settlement
- **Neo:** MAGIC/Specs/GenMAGIC-CONTRACT-Vi.md §8 dòng 229-237; §6 dòng 202-203 (T-RECONCILE, net CARP → Treasury); PhoenixKeyDID/Wakeme/PhoenixKey-MAGIC-Vault-Scale-Analysis.md dòng 6-7 ("Mô hình Triple Token"; CARP = pay-in-CARP, đồng-thanh-khoản); PhoenixKeyDID/Wakeme/spec/PhoenixKey-Wakeme-Tech.md dòng 388 ("Self-consumption HỢP LỆ")
- **Mô tả:** §8 lập luận: MAGIC không policy-id, không chuyển nhượng ⟹ không bán được ⟹ không thể là thu-nhập. Lập luận này chỉ đúng nếu MAGIC là ĐIỂM CUỐI của giá trị. Nhưng theo chính kiến trúc §6 (T-RECONCILE: "anchor Merkle root + net CARP → Treasury") và Vault-Scale-Analysis (CARP = "đồng-thanh-khoản chuyển-nhượng-được"), khi MAGIC được TIÊU (kể cả tự-tiêu — Wakeme-Tech §5 ghi rõ "Self-consumption HỢP LỆ", và D1 ở §7 xác nhận Registry-gate hiện là placeholder lỏng), nhà cung cấp dịch vụ (có thể là chính người dùng tự đăng ký) nhận được CARP — MỘT TÀI SẢN CHUYỂN NHƯỢNG ĐƯỢC. Vậy giá trị của MAGIC KHÔNG bị chặn ở khâu "không bán được token MAGIC" — nó thoát ra qua khâu tiêu-dùng → CARP. Lập luận (1) chỉ chứng minh "không bán được CHÍNH TOKEN MAGIC", không chứng minh "không rút được GIÁ TRỊ từ việc nắm LAMP" — hai mệnh đề khác nhau về bản chất pháp lý (hình thức token so với thực chất kinh tế).
- **Kịch bản:** Người dùng A giữ LAMP trong Wakeme vault (thụ động, không làm gì thêm), mỗi epoch nhận MAGIC nhờ sàn G1. A cũng tự đăng ký làm "provider" cho một dịch vụ hình thức tối thiểu (hợp lệ theo Wakeme-Tech vì self-consumption được cho phép và D1 xác nhận Registry-gate hiện là placeholder). A tự tiêu MAGIC của mình qua chính dịch vụ đó → cuối epoch, Treasury settle CARP về cho A với vai trò provider (theo §6). CARP là token chuyển nhượng được — A bán CARP lấy ADA/fiat. Kết quả: A đã biến việc nắm-giữ-LAMP-thụ-động thành dòng tiền thật, dù chưa bao giờ "bán MAGIC" theo đúng nghĩa đen. Lá chắn (1) không đề cập tới đường này.
- **Đề xuất:** §8 cần bổ sung phân tích riêng cho đường CARP-settlement (đặc biệt kết hợp self-consumption + D1 wash-trade) trước khi khẳng định lá chắn (1) đứng vững — đây là điểm CẦN LUẬT SƯ SOÁT theo hướng thực-chất-hơn-hình-thức (substance-over-form), không chỉ dựa vào tính không-chuyển-nhượng của bản thân token MAGIC.

### [CAO] Lá chắn pháp lý (2) không phủ nhận được đặc điểm "lãi suất theo thời gian nắm giữ" của tuổi-LAMP (§4.1) — chỉ so sánh tương đối, không so sánh với KHÔNG-CÓ-GÌ
- **Neo:** MAGIC/Specs/GenMAGIC-CONTRACT-Vi.md G1 dòng 22, §4.1 dòng 93-104 (đặc biệt câu trích dẫn dòng 95: "LAMP giữ nguyên trong vault lớn hơn 6 epoch sẽ cho MAGIC lớn hơn"), §8 lá chắn (2) dòng 234
- **Mô tả:** §8 lá chắn (2) lập luận: người ôm chỉ được sàn, người tiêu-thật hơn 2.6× ⟹ "giữ LAMP ăn lãi" sai về số học. Nhưng đây là so sánh TƯƠNG ĐỐI (ai được nhiều hơn ai), không phải so sánh với việc KHÔNG NHẬN GÌ CẢ. G1 tự thân đã là tuyên bố tuyệt đối: "chỉ cần NẮM LAMP là sinh được MAGIC" — người không làm gì ngoài giữ LAMP vẫn nhận MAGIC liên tục mỗi epoch (sàn 1.0×). Nghiêm trọng hơn, §4.1 (tuổi-LAMP) là một hệ số ĐỘC LẬP thưởng CHÍNH XÁC theo THỜI GIAN NẮM GIỮ (không đòi hỏi bất kỳ hoạt động nào khác): 1.00× → 2.20× tuyến tính theo số epoch giữ nguyên LAMP trong vault. Đây là mô tả giáo khoa của "lãi suất tích luỹ theo kỳ hạn" — chính là điều mà lá chắn cổng-tiêu-thật cũ được dựng lên để tránh ("không phải lãi-suất"). So sánh với người tiêu nhiều hơn không xoá bỏ được đặc điểm này của chính tuổi-LAMP.
- **Kịch bản:** Hai người cùng giữ 1001 LAMP, không ai tiêu MAGIC cho dịch vụ thật. Người B giữ 0 epoch: tư_cách=1.00×. Người C giữ 24 epoch: tư_cách=2.20×. Cả hai không làm gì khác ngoài việc KHÔNG ĐỘNG tới LAMP — số MAGIC C nhận mỗi epoch gấp 2.2 lần B, chỉ vì thời gian nắm giữ dài hơn. Đây là quan hệ nhân-quả "giữ lâu hơn → lợi hơn" kinh điển của lãi suất kỳ hạn, hoàn toàn không liên quan tới "tiêu MAGIC cho dịch vụ thật" (G4) mà §8 dùng làm cơ sở phản bác "lãi suất".
- **Đề xuất:** §8 nên tách phân tích tuổi-LAMP ra khỏi lập luận "2.6× hơn người tiêu" — cần trình bày riêng vì sao hệ số thưởng-theo-thời-gian-nắm-giữ KHÔNG cấu thành lãi suất (nếu có lý do chính đáng), thay vì để nó ẩn trong so sánh tương đối. Đây là điểm CẦN LUẬT SƯ SOÁT trực tiếp, vì nó tái hiện chính xác đặc điểm mà lá chắn cũ (cổng-tiêu-thật) tránh.

### [CAO] §5 "hai lớp vá" (van cứng 1.25× + bù kỳ sau) không thực sự chặn đúng kịch bản "tổng trọng số tăng vọt trong epoch" mà chính đoạn văn đó nêu ra làm rủi ro
- **Neo:** MAGIC/Specs/GenMAGIC-CONTRACT-Vi.md §5 dòng 165-188 (đặc biệt "đánh đổi phải nói thẳng" dòng 180 và "vá bằng hai lớp" dòng 181-183); liên quan §9 mục 3 (dòng 245) tự CONTRACT đã đặt câu hỏi này nhưng phần "vá" chưa trả lời đúng cơ chế
- **Mô tả:** §5 nêu rủi ro: "nếu tổng trọng số tăng vọt trong epoch e, tổng phát vượt ngân sách epoch đó", rồi tuyên bố "vá bằng hai lớp: (1) van cứng nhịp_gen(e) ≤ nhịp_gen(e−1)×1.25; (2) bù kỳ sau". Nhưng van cứng ràng buộc trên trục nhịp_gen(e) so với nhịp_gen(e−1) — một đại lượng đã CHỐT XONG trước khi epoch e bắt đầu, dựa trên tổng_trọng_số(e−1). Rủi ro được nêu lại nằm ở trục KHÁC: tổng_trọng_số(e) — đại lượng THỰC TẾ trong epoch e — tăng vọt so với tổng_trọng_số(e−1) (là mẫu số đã dùng để tính nhịp_gen(e)). Van cứng không hề đọc hay giới hạn tổng_trọng_số(e); nó chỉ giới hạn TỐC ĐỘ nhịp_gen tăng giữa hai epoch liên tiếp — một cơ chế phòng vệ cho một NGUYÊN NHÂN KHÁC (ngân_sách_gen nhảy vọt do br_q/gov_params thay đổi đột ngột), không phải cho nguyên nhân "cohort trọng số tăng vọt" mà đoạn văn liền kề mô tả. Gọi đây là "hai lớp vá" cho CÙNG một rủi ro là không chính xác — chỉ có "bù kỳ sau" thực sự chạm tới rủi ro tổng_trọng_số tăng vọt, và nó chỉ khấu trừ SAU KHI MAGIC đã phát vượt mức trong epoch e (khấu hao ở epoch e+1, không ngăn được windfall đã xảy ra ở epoch e).
- **Kịch bản:** tổng_trọng_số(e−1) = 1000 (đơn vị Q-scaled), ngân_sách_gen(e) không đổi so với epoch trước ⟹ nhịp_gen(e) = ngân_sách_gen(e)×Q/1000 — KHÔNG tăng so với nhịp_gen(e−1), van cứng không kích hoạt (vì van chỉ chặn khi nhịp_gen(e) MUỐN tăng >1.25× nhịp_gen(e−1)). Giả sử một đợt onboarding lớn khiến nhiều vault cùng vượt ngưỡng tuổi_LAMP 6-epoch đồng thời trong epoch e (kịch bản hợp lý ở giai đoạn ra mắt vì nhiều vault được tạo cùng lúc), khiến tổng_trọng_số(e) thực tế = 5000 (gấp 5 lần epoch trước). Tổng MAGIC phát ra thực tế trong epoch e = nhịp_gen(e) × 5000 = 5 × ngân_sách_gen(e) — vượt ngân sách 5 lần trong một epoch DUY NHẤT, mà van cứng hoàn toàn không phát hiện lẫn không chặn (vì nó theo dõi nhịp_gen chứ không theo dõi tổng_trọng_số).
- **Đề xuất:** Làm rõ trong §5: van cứng KHÔNG bảo vệ khỏi kịch bản trọng số tăng vọt trong-epoch; cần một cơ chế RIÊNG theo dõi/ước lượng tổng_trọng_số dự phóng (vd trần % tăng trọng số dự kiến giữa hai epoch, dựa trên số vault sắp chạm ngưỡng tuổi mà engine đã biết trước vì tuổi tính được xác định), hoặc chấp nhận明 minh bạch rủi ro này là "chưa vá", không gộp chung với van cứng thành "đã có hai lớp bảo vệ". Cần mathematician xác nhận bound định lượng thật của toàn bộ vòng lặp trễ-một-epoch.

### [TRUNG] Hệ quả G9(c) ở §1 ("không tích luỹ ⟹ không thể là tài sản đầu tư") là bước nhảy logic (non-sequitur)
- **Neo:** MAGIC/Specs/GenMAGIC-CONTRACT-Vi.md §1 dòng 32-35 ("Hệ quả G9")
- **Mô tả:** §1 liệt kê hệ quả của G9 (MAGIC dùng-hay-mất, reset mỗi epoch): "(c) lá chắn pháp lý §8 khoẻ thêm: không chuyển nhượng và không tích luỹ ⟹ không thể là tài sản đầu tư." Đây là một suy luận không chặt: việc KHÔNG TÍCH LUỸ chỉ giới hạn QUY MÔ giá trị có thể rút ra tại một thời điểm (không có "kho MAGIC" để đầu cơ), nhưng không xoá bỏ tính chất DÒNG CHẢY GIÁ TRỊ ĐỊNH KỲ (recurring value stream) — mà đây mới là đặc điểm các khung pháp lý về "lợi tức đầu tư" thường xét (vd "kỳ vọng lợi nhuận" trong Howey không đòi hỏi lợi nhuận phải tích luỹ được, một dòng cổ tức "dùng-hay-mất mỗi kỳ" vẫn là cổ tức). Kết luận "không thể là tài sản đầu tư" đi quá xa so với tiền đề "không tích luỹ".
- **Kịch bản:** Người giữ LAMP 100 epoch liên tục, không tiêu gì cho dịch vụ thật, mỗi epoch nhận MAGIC ở mức sàn rồi đưa hết vào ScheduleGen (theo kịch bản finding #2) để không mất. Dù không epoch nào MAGIC "tích luỹ" (số dư không cộng dồn qua các epoch), người này đã nhận một CHUỖI 100 LẦN phân phối giá trị định kỳ, xuất phát TRỰC TIẾP và DUY NHẤT từ hành vi nắm-giữ-LAMP — về bản chất kinh tế không khác gì một dòng cổ tức trả định kỳ. Tuyên bố "không tích luỹ ⟹ không thể là tài sản đầu tư" bỏ qua chính đặc điểm dòng-chảy-định-kỳ này.
- **Đề xuất:** Bỏ hoặc làm yếu câu (c) trong §1 — thay bằng phát biểu thận trọng hơn ("không tích luỹ làm giảm quy mô rủi ro tại một thời điểm, nhưng KHÔNG tự động loại trừ đặc trưng đầu tư của dòng phân phối định kỳ — cần luật sư đánh giá riêng") thay vì khẳng định dứt khoát một kết luận pháp lý ngay trong tiên đề kỹ thuật.

**Đã điểm qua:** Trục được giao: LOGIC + PHÁP LÝ, tập trung §8 (nhiệm vụ chính) + giả định ngầm toàn CONTRACT, đặc biệt §2 "Bất biến bắc cầu" và §5 "Phát biểu trung thực về G3".

ĐÃ TÌM RA VẤN ĐỀ:
- §2 "Bất biến bắc cầu" — finding #1 (NGHIÊM TRỌNG): claim chỉ đúng cho vault thật, CONTRACT không nêu cơ chế engine xác thực vault-NFT/địa chỉ canonical khi đọc reference_input.
- §5 "Phát biểu trung thực về G3" — finding #5 (CAO): "hai lớp vá" nêu ra không thực sự chặn đúng kịch bản mà chính đoạn văn mô tả (nhầm trục nhịp_gen với trục tổng_trọng_số) — cùng phạm vi câu hỏi §9 mục 3 (trễ-một-epoch), nhưng tôi tiếp cận từ góc LOGIC (khớp mục tiêu tuyên bố với cơ chế thật), không chạy mô hình định lượng đầy đủ — đề nghị mathematician xác nhận bound số.
- §9 mục 6 (G4 có thật sự thoả?) — finding #2 (CAO): tìm được hồ sơ ôm-giữ vượt được người tiêu-thật một phần, qua đường cam_kết_lịch không bị gate bởi tiêu_thật — phá vỡ chính con số "Kiểm G4" ở §4.5. Đồng thời phát hiện khoảng trống MECE ở bảng phụ thuộc §7 (D1-D4 không có mục cho cam_kết_lịch).
- §9 mục 9 (pháp lý §8, có chặt về LOGIC/SỐ HỌC không) — nhiệm vụ chính, findings #3, #4, #6: lá chắn (1) bỏ qua đường CARP-settlement (self-consumption + wash), lá chắn (2) không phủ nhận được đặc điểm lãi-suất-theo-thời-gian của tuổi-LAMP, và hệ quả G9(c) ở §1 là bước nhảy logic. Cả ba đều gắn nhãn "cần luật sư soát" theo đúng giới hạn được giao (không tự phán quyết pháp lý).

§9 mục 8 (Đối chiếu Wakeme, đặc biệt I-ACT-7/G7) — ĐÃ SOÁT, KHÔNG TÌM RA vi phạm trực tiếp: công thức §3 không chứa biến đầu ra làm thay đổi c, kiến trúc reference_input/GenDrip khớp gen_drip_ok (LAMP-preserved). Tấm-pin G7 (LAMP không bao giờ về user) không bị công thức GenMAGIC vi phạm trực tiếp — nhưng lưu ý phát hiện #1 cho thấy điểm yếu nằm ở XÁC THỰC INPUT chứ không phải ở công thức, và finding #3/#4 cho thấy dù G7 chặn được đường LAMP-về-user, nó không chặn đường MAGIC→CARP (một kênh trích xuất giá trị khác mà G7 không bao phủ).

§9 mục 7 (cold-start) — soát nhanh tron

### [NGHIÊM TRỌNG] D1 chờ B2 = chờ nhầm cửa. B2 KHÔNG vá được D1, và chủ B2 chính là MAGIC-team
- **Neo:** CONTRACT §7 D1 = Specs/GenMAGIC-CONTRACT-Vi.md:222 · /Users/ductiger/Projects/PhoenixKeyDID/PhoenixKey-Validator/lib/phoenixkey/activation_logic.ak:326-335 (TODO + `False`) · /Users/ductiger/Projects/PhoenixKeyDID/Anchorme/PhoenixKey-STATUS.md:34 (chủ = MAGIC team + backend) vs :80 (Wakeme-local B2) · Wakeme-Math.md:120 (I-ACT-3 placeholder), :283 (T-5) · CONTRACT §7 D4 = :225
- **Mô tả:** CÂU QUYẾT ĐỊNH — trả lời thẳng: KHÔNG buộc chờ B2, vì B2 không vá D1. Hai lỗi độc lập trong 1 ô bảng §7 D1.

(a) LỖI PHẠM TRÙ. `has_counterparty_consume(_tx, _owner_commit) -> Bool { False }` là hàm Aiken TRONG validator Wakeme, mục đích ghi ngay trên đầu hàm: "nếu ∃ counterparty_did ≠ owner ⟹ active ⟹ Reclaim REJECT". Nó là cổng NHỊ PHÂN, per-NGÀY, chạy trong tx Reclaim, để quyết định anti-idle có bào 1 LAMP hay không. GenMAGIC §4.2 cần: (i) TỔNG nanogic trên cửa sổ [e−6, e), (ii) SLOT-timestamp từng sự kiện (cho §4.3), (iii) trọng số thực-tài-nguyên. B2 dù land 100% cũng không đẻ ra thứ nào trong ba thứ đó. Tệ hơn: B2 land xong wash-trade VẪN chạy — chỉ cần DID thứ hai đồng loã làm counterparty là `counterparty_did ≠ owner` ⟹ Bool = True ⟹ cổng mở ⟹ 12.375× nguyên vẹn.

(b) SAI CHỦ. §7 D1 ghi "Chủ = PhoenixKey (blocker B2)". Ma trận xuyên-module STATUS.md:34 ghi chủ B3 (Registry consume-gate) = **"MAGIC team + backend"**. MAGIC đang chờ CHÍNH MÌNH. Thêm nữa số hiệu blocker đụng nhau giữa 2 hệ đánh số (STATUS.md:80 Wakeme-local B2 = Registry; STATUS.md:34 cross-module B2 = CARP policy-id, B3 = Registry) — CONTRACT trích "B2" không nói hệ nào.

(c) VÁ ĐƯỢC TRONG MAGIC — vì thứ chặn wash KHÔNG phải "thực-tài-nguyên", mà là **chi phí không thu hồi được**. Registry cần cho tính hợp-pháp/chất-lượng dịch vụ; wash cần cost. Gộp hai thứ đó chính là cái làm D1 trông như việc của người khác. Đòn bẩy nằm trọn trong lớp kế toán §6 mà MAGIC sở hữu — xem đề xuất sửa.

(d) NHƯNG D1 bị chặn thật bởi **D4**, không phải D2/B2: nếu MAGIC→CARP settlement chưa chốt (§7 D4) thì không bind được credit vào CARP đã quyết toán. §7 liệt D1 và D4 thành 2 dòng độc lập, KHÔNG có cạnh nối — đó là cạnh phụ thuộc thật đang thiếu.
- **Kịch bản:** Giả sử B2/B3 land đầy đủ hôm nay. Attacker A (DID-A) + đồng loã B (DID-B, mua 5 USD trên chợ tài khoản, KHÔNG cần Sybil sinh trắc — 2 người thật đổi chác). A "tiêu" 600 MAGIC/6-epoch tại dịch vụ `svc-B-01` do B đứng tên; B "tiêu" 600 MAGIC tại `svc-A-01` do A đứng tên. Với mỗi tx: counterparty_did ≠ owner_commit ⟹ `has_counterparty_consume` = True ⟹ Wakeme coi cả hai là active ⟹ không Reclaim. Đồng thời GenMAGIC ghi nhận đã_tiêu = 600, đã_sinh = 600 ⟹ tỷ_tiêu = 1.0 ⟹ tiêu_thật = 2.50× cho CẢ HAI. Cổng B2 đã pass hoàn hảo. B2 = ĐÃ LAND. Wash = VẪN CHẠY 100%. Chi phí bổ sung của attacker so với trước khi có B2: một lần bắt tay.
- **Đề xuất:** 1) SỬA §7 D1 NGAY: chủ = MAGIC-team (đối chiếu STATUS.md:34), không phải PhoenixKey; ghi rõ hệ đánh số blocker; thêm cạnh D1→D4.
2) Tách D1 thành hai việc khác chủ: (D1a) chống-wash = chi-phí-không-thu-hồi → **MAGIC tự làm trong §6**; (D1b) chuẩn dịch vụ/chất lượng → Registry-team. Chỉ D1b mới thật sự chờ.
3) D1a — vá lõi: **`đã_tiêu` chỉ tính lá có CARP tương ứng ĐÃ quyết toán về Treasury và đã final (k=5)**. Wash khi đó tốn 1 CARP thật/1 MAGIC, tiền đi vào Treasury, tự-giao-dịch không lấy lại được ⟹ vòng lặp âm tiền ⟹ chết về kinh tế. Đây là luật về "lá nào được đếm", nằm trọn trong lớp kế toán MAGIC, KHÔNG cần Registry.
   Hệ quả kỹ thuật: dời cửa sổ §4.2 sang [e−7, e−1) để chừa 1 epoch cho settlement final.
4) D1a bổ trợ: bond động (xem finding riêng) + trần tập trung theo `service_id`: `đã_tiêu_hiệu_lực = Σ_svc min(đã_tiêu_svc, α × đã_tiêu_tổng)`, α = 0.5 ⟹ buộc washer dựng ≥2 dịch vụ trông độc lập.
5) Nói thẳng trong CONTRACT: các đòn trên KHÔNG chứng minh thực-tài-nguyên. Chúng chỉ ép chi phí. Đó là đủ cho wash, và đó là điều MAGIC làm được mà không chờ ai.

### [NGHIÊM TRỌNG] Wash-trade thật là 12.375× (không phải 3.75×); và toàn bộ bảng chống-gian-sổ §6 vô hiệu khi user ≡ operator
- **Neo:** CONTRACT §7 D1 = :222 · §4.4 = :143-144 (không có điều kiện counterparty) · §4.5 trần 12.375× = :157 · §6 bảng chống-gian-sổ = :211, ranh giới tin cậy = :214 · §5 pro-rata = :172 · Scale-Analysis §2.2 (C-A) = :89, §5.3 = :249-260
- **Mô tả:** §7 D1 tự khai "2.5×1.5 = 3.75× miễn phí". Đếm thiếu 2 hệ số:

(1) `cam_kết_lịch` (§4.4) cũng miễn phí: `tỷ_cam_kết = magic_cam_kết / sinh_kỳ_vọng_6_epoch`, KHÔNG có điều kiện counterparty, KHÔNG có điều kiện ràng buộc/không-huỷ nào được nêu trong CONTRACT. Cam kết MAGIC vào hợp đồng lịch mà bên kia là shell của chính mình ⟹ +1.50×. Sự VẮNG MẶT của yêu cầu counterparty ở §4.4 chính là lỗ.
(2) `tuổi_LAMP` nhân chồng: washer cũng già đi ⟹ +2.20×.
⟹ 2.20 × 2.50 × 1.50 × 1.50 = **12.375×** = ĐÚNG BẰNG trần tuyệt đối §4.5 tự khai. Washer đạt trần thiết kế với chi phí thật ≈ 0.

Cosign vô nghĩa: §6:211 liệt "user-cosign mỗi delta" làm cột chống-gian-sổ; Scale-Analysis:89 (C-A) nói rõ cosign để chống "operator bịa user tiêu X". Toàn bộ bảng đó dựng theo mô hình **operator ác ↔ user ngay**. Wash-trade là **operator ≡ user**. Attacker tự ký cho chính mình ⟹ cosign hợp lệ tuyệt đối. Mọi dòng trong bảng (cosign / hash-chain / nonce / anchor) đều ĐÚNG và đều VÔ QUAN tới D1. §6:214 tuyên "operator KHÔNG thể bịa/sửa delta đã cosign" — đúng, và không liên quan.

GIẢM NHẸ (phải nói thật): §5:172 chuẩn hoá pro-rata ⟹ wash KHÔNG lạm phát cung MAGIC. Thiệt hại không phải in tiền, mà là (a) cướp phần của người ngay trong giai đoạn quá độ, (b) **sụp tín hiệu**: khi ai cũng wash, tổng_trọng_số dâng đều, nhịp_gen tụt bù lại, mọi người về đúng chỗ cũ — 4 hệ số triệt tiêu trong phép chuẩn hoá, trở thành **thuế đánh vào người không biết lập bot**. §7 D1 mô tả sai bản chất thiệt hại ("ăn 3.75× miễn phí" hàm ý lạm phát) ⟹ ưu tiên vá bị đặt sai.
- **Kịch bản:** Ngân sách 1.000.000 MAGIC/epoch. 10.000 hồ sơ ngay thật, mỗi hồ sơ c=1001, tuổi trần, tiêu 60%, thấp-điểm 30%, không lịch:
  tiêu_thật = 1+0.6×1.5 = 1.90 · giờ_thấp_điểm = 1+0.3×0.5 = 1.15 · tư_cách = 2.20×1.90×1.15×1.00 = 4.807 · trọng số/hồ sơ = 1001×4.807 = 4.812.
Giai đoạn quá độ, 500 hồ sơ (5%) chuyển sang wash: tư_cách = 12.375 ⟹ trọng số = 12.387 mỗi hồ sơ.
  Σ washer = 500×12.387 = 6.193.500 · Σ ngay thật = 9.500×4.812 = 45.714.000 · tổng = 51.907.500.
  Phần washer = 11.93% ngân sách từ 5% LAMP ⟹ **hệ số vượt phần 2.39×**; người ngay thật MẤT 119.300 MAGIC/epoch (≈8,7 triệu MAGIC/năm ở 73 epoch) chảy sang tiêu-giả. Theo G9 (:32-35) MAGIC không tích luỹ ⟹ phần mất đi là MẤT VĨNH VIỄN, không có kỳ sau bù.
Cân bằng Nash: wash chi phí ≈ 0 và không phát hiện được ⟹ mọi hồ sơ duy lý đều wash ⟹ tổng_trọng_số ×2.57 ⟹ nhịp_gen ÷2.57 ⟹ ai cũng nhận đúng như cũ, nhưng cả mạng phải nuôi bot + shell. Mất trắng thuần tuý (deadweight), và 4 hệ số truyền tải ZERO thông tin. Toàn bộ §4 thành no-op.
- **Đề xuất:** 1) Sửa con số §7 D1: 3.75× → **12.375×**, và sửa mô tả thiệt hại: không phải lạm phát mà là (a) tái phân phối từ người ngay thật, (b) sụp tín hiệu về no-op.
2) Thêm mục "mô hình đe doạ" vào §6 nói rõ bảng chống-gian-sổ chỉ phủ operator-ác-user-ngay; ghi thẳng: **KHÔNG có dòng nào trong bảng chạm tới đồng loã user+operator**. Đây là lỗ hổng riêng, cần cột riêng.
3) §4.4: bắt buộc counterparty của hợp đồng lịch ≠ owner_commit VÀ provider phải bonded; nếu chưa có Registry thì `cam_kết_lịch` phải bị KHOÁ ở sàn 1.0× cho tới khi có — thà mất chức năng còn hơn cho không 1.5×.
4) Vì pro-rata làm hệ số chỉ tái phân phối: nếu D1a (bind CARP đã quyết toán) chưa xong, cân nhắc **hạ trần 3 hệ số hành vi xuống 1.0× (tắt)** cho tới khi tín hiệu có chi phí. Hệ chạy với tuổi_LAMP thuần còn tốt hơn hệ có 4 hệ số giả — hệ số giả tệ hơn không có hệ số, vì nó thu thuế người không lập bot.

### [CAO] §4.5 "kiểm G4 (số học)" dùng bù nhìn — idler tối ưu đạt 5.32× chứ không 2.20×; biên "2.6 lần" thực ra 1.06 lần
- **Neo:** CONTRACT §4.5 kiểm G4 = :159-161 · §4.3 công thức tỷ lệ thuần = :128-129, ghi chú sàn = :136 · §4.4 = :143-144 · §4.2 = :114-115 · §8 lá chắn pháp lý dựa số này = :234
- **Mô tả:** §4.5:159-161 chứng minh G4 bằng: "ôm-giữ tối đa không tiêu = 2.20 × 1.0 × 1.0 × 1.0 = 2.20×" vs "tiêu-thật... = 5.63× ⟹ ăn đứt 2.6 lần". Cả hai vế đều dựng sai.

Vế idler là BÙ NHÌN: nó giả định người ôm để cả ba hệ số hành vi ở sàn. Nhưng không gì buộc thế — ba hệ số kia gần như MIỄN PHÍ với người ôm:
- `giờ_thấp_điểm` là **tỷ lệ thuần, không có thang** (§4.3:128): tiêu 5 MAGIC toàn bộ lúc 3h sáng ⟹ tỷ_thấp_điểm = 1.0 ⟹ **1.50× trọn vẹn**, y hệt người tiêu 600 MAGIC.
- `cam_kết_lịch`: không counterparty, không cost ⟹ **1.50×**.
- `tiêu_thật`: tiêu bụi vẫn nhích lên 1.075×.
⟹ Idler tối ưu thật = 2.20 × 1.075 × 1.50 × 1.50 = **5.32×**, cao hơn con số §4.5 dùng làm chứng cứ **2.4 lần**.

So với chính hình mẫu "công dân hạng nhất" mà §4.5 dựng (5.625×): 5.32/5.625 = **94.6%**. Biên bảo vệ G4 mà CONTRACT khoe "2.6 lần" thực tế là **1.06 lần**. Toàn bộ luận cứ số học chọn dải hệ số (§4.5) sụp.

(G4 vẫn đứng theo HƯỚNG khi so cùng tuổi: 12.375 vs 5.32 = 2.33×. Nhưng con số CONTRACT dùng để biện minh cho dải là sai, và §8:234 dùng chính con số đó làm **lá chắn pháp lý** — "narrative giữ LAMP ăn lãi sai về số học". Với 5.32×, lá chắn ấy mỏng đi rõ rệt.)
- **Kịch bản:** Hồ sơ "ôm-giữ nỗ lực tối thiểu", c = 1001, tuổi 24 epoch, MIN_MAGIC_TX = 1 MAGIC/ngày (Wakeme-Math:304 ghi "TẠM", chưa chốt), vault sinh 100 MAGIC/epoch:
  Cửa sổ [e−6, e) = 30 ngày ⟹ đã_tiêu = 30 MAGIC; đã_sinh = 600 MAGIC.
  tỷ_tiêu = ⌊30×Q/600⌋ = 0.05Q ⟹ tiêu_thật = Q + ⌊0.05Q × 1.5Q/Q⌋ = **1.075×**
  Bot đặt cả 30 lần tiêu vào slot EMA-nhanh < EMA-chậm ⟹ tỷ_thấp_điểm = Q ⟹ giờ_thấp_điểm = **1.50×** (trần, dù chỉ tiêu 5% suất)
  Cam kết MAGIC vào hợp đồng lịch của shell mình ⟹ cam_kết_lịch = **1.50×**
  tuổi_LAMP = **2.20×**
  ⟹ tư_cách = 2.20 × 1.075 × 1.50 × 1.50 = **5.32×**
So với §4.5 nói idler trần = 2.20×: sai **+142%**. So với hình mẫu công dân hạng nhất 5.625×: đạt **94.6%** — trong khi tiêu thật 5% suất, phần 95% còn lại bốc hơi theo G9 nhưng ANH TA KHÔNG MẤT GÌ vì chưa từng định dùng.
- **Đề xuất:** 1) VIẾT LẠI §4.5 "kiểm G4" — so cùng tuổi và so với idler TỐI ƯU (5.32×), không phải idler bù nhìn (2.20×). Nếu biên mới không chấp nhận được thì phải chỉnh dải, đừng chỉnh cách trình bày.
2) Gắn thang cho `giờ_thấp_điểm` (xem finding riêng) — đây là nguồn lớn nhất của khoảng cách 2.20 → 5.32.
3) `cam_kết_lịch` khoá ở sàn tới khi có counterparty bonded.
4) §8 phải bỏ dựa vào con số "2.6 lần" — lá chắn pháp lý không được đứng trên số học sai. Lá chắn 1 (không chuyển nhượng) và 3 (tấm-pin) tự đứng được; lá chắn 2 (dốc-thưởng) hiện KHÔNG đứng được.

### [CAO] `giờ_thấp_điểm` là tỷ-lệ không thang: tiêu bụi ăn trọn 1.5×; và nó thưởng bot, phạt người dùng thật — ngược đúng G4/G8
- **Neo:** CONTRACT §4.3 = :127-136 (công thức :128-129, biện hộ tự-cân-bằng :135, ghi chú tránh phạt kép :136) · G4 = §1:25 · G8 = §1:29 · §4.2 "đo TỶ LỆ không đo LƯỢNG" = :118
- **Mô tả:** Hai lỗi trong 1 công thức (§4.3:128-129).

(1) KHÔNG THANG. `tỷ_thấp_điểm = đã_tiêu_lúc_thấp_điểm / max(đã_tiêu, 1)` — mẫu số là chính đã_tiêu, nên hệ số **bất biến theo quy mô**. Tiêu 1 nanogic lúc 3h sáng = tiêu 600 MAGIC lúc 3h sáng = 1.50×. §4.3:136 tự khai đây là CỐ Ý ("đã_tiêu = 0 ⟹ sàn 1.0× — không phạt thêm, tránh phạt kép"). Ý định đúng (tránh phạt kép), hệ quả sai: nó tạo bậc thang nhảy — 0 MAGIC ⟹ 1.0×, còn 1 nanogic đặt đúng chỗ ⟹ 1.5×. Toàn bộ +50% nằm trên một hạt bụi.

(2) NGƯỢC MỤC ĐÍCH. G4 (§1:25) định nghĩa công dân hạng nhất = người tiêu MAGIC cho **dịch vụ THẬT**. Cầu dịch vụ thật là cầu phái sinh, **không dời được**: người ta gọi API/dùng dịch vụ lúc họ CẦN, tức giờ thức = giờ cao điểm. Cầu GIẢ thì dời tự do — bot không ngủ. ⟹ hệ số trao +50% cho đúng nhóm mà G4 muốn chặn, và trao 1.0× cho đúng nhóm G4 muốn ưu tiên. §4.3:135 biện hộ "ai cũng dồn vào thấp-điểm ⟹ chỗ đó thành cao-điểm ⟹ tự cân bằng" — chỉ đúng nếu cầu dời được. Với cầu không dời được, không có cân bằng nào: người thật ở nguyên cao điểm và trả thuế 33% (1.0/1.5) vĩnh viễn cho bot.

Đây là hệ số "điều-tiết cung-cầu" (G8) nhưng thứ nó điều tiết là **mức độ tự động hoá**, không phải cung-cầu.
- **Kịch bản:** Hai hồ sơ, cùng c = 1001, cùng tuổi 24 epoch, cùng cam_kết_lịch = 1.0:
  **Chị Lan** (công dân hạng nhất thật): dùng dịch vụ tra cứu cho công việc, 08h–17h. Tiêu 570/600 MAGIC (95% suất). Toàn bộ rơi vào cao điểm vì đó là giờ chị làm việc.
    tỷ_tiêu = 0.95 ⟹ tiêu_thật = 1 + 0.95×1.5 = 2.425 · tỷ_thấp_điểm = 0 ⟹ giờ_thấp_điểm = **1.00**
    tư_cách = 2.20 × 2.425 × 1.00 × 1.00 = **5.335**
  **Bot của A**: tiêu 30/600 MAGIC (5% suất), tất cả lúc 03h12 khi EMA-nhanh < EMA-chậm.
    tỷ_tiêu = 0.05 ⟹ tiêu_thật = 1.075 · tỷ_thấp_điểm = 1.0 ⟹ giờ_thấp_điểm = **1.50**
    tư_cách = 2.20 × 1.075 × 1.50 × 1.00 = **3.548**
  Chị Lan vẫn thắng (5.335 vs 3.548) — NHƯNG chị tiêu gấp **19 lần**, mà chỉ hơn **1.5 lần**. Hiệu suất/MAGIC-tiêu-thật: Lan = 5.335/570 = 0.0094; bot = 3.548/30 = 0.118 ⟹ **bot hiệu quả gấp 12.6×**. Cho bot thêm cam_kết_lịch (miễn phí, §4.4 không chặn) ⟹ 5.32 vs 5.335: **hoà**, với 5% nỗ lực.
- **Đề xuất:** 1) Gắn thang bằng chính tỷ_tiêu — chỉ ăn ưu đãi thấp-điểm tương ứng lượng đã thật sự tiêu:
   `giờ_thấp_điểm = Q + ⌊ tỷ_thấp_điểm × tỷ_tiêu × TRẦN_THẤP_ĐIỂM / Q² ⌋` (nhân-chia-floor tuần tự, BigInt).
   Bot 5%: 1 + 1.0×0.05×0.5 = 1.025× (thay vì 1.50×). Lan 95% cao điểm: vẫn 1.00×. Idler tối ưu tụt từ 5.32 → 3.63×.
   Đây KHÔNG phải phạt kép — nó là gắn thang. Phạt kép là trừ lần nữa; cái này chỉ giới hạn phần thưởng theo quy mô đóng góp.
2) Trước khi giữ hệ số này, trả lời: dịch vụ nào trong hệ có cầu DỜI ĐƯỢC? Nếu danh mục đó rỗng hoặc bé, `giờ_thấp_điểm` không điều tiết gì — bỏ hẳn, giảm dải tư_cách từ 12.375× xuống 8.25×, hệ đơn giản hơn và mất 0 chức năng.
3) Nếu giữ: chỉ áp cho `service_id` được đánh dấu "dời-được" (batch job, backup, index) — dịch vụ tương tác thời gian thực miễn trừ, không tính vào cả tử lẫn mẫu.

### [CAO] Giấu delta KHÔNG chứng minh được — lá thiếu chữ ký operator ⟹ toàn bộ chuyện fraud-proof/bond là bất khả thi như đặc tả
- **Neo:** CONTRACT §6 lá = :200, chống gian sổ = :211, ranh giới tin cậy = :214 · §9 mục 12 = :254, mục 11 ("chưa định lượng bond + cửa-sổ-fraud-proof") = :253 · §1 hệ quả G9 = :32-35 · §4.2 cửa sổ = :111 · Scale-Analysis lá = :230-233, §5.3 = :249-260, §6.2 L3 = :295
- **Mô tả:** §9 mục 12 hỏi "operator DoS / từ chối ghi delta: ai chịu, có escape-hatch không". Trả lời sau khi soi: **user chịu 100%, và không chứng minh được, theo đúng cấu trúc lá.**

Lá theo đặc tả: `lá = H(did ‖ Δmagic ‖ nonce ‖ cosign ‖ prev)` (§6:200, y hệt Scale-Analysis:230-233). Trong đó cosign là chữ ký của **user**. Không có chữ ký OPERATOR ở đâu cả.

Hệ quả: cosign chứng minh "tôi ĐỒNG Ý tiêu", KHÔNG chứng minh "operator ĐÃ NHẬN". Khi operator im lặng không append, user cầm trên tay một chữ ký của chính mình — vô giá trị làm bằng chứng, vì user tự ký được vô số cái. §6:214 tuyên trust boundary "operator có thể DoS/giấu delta, KHÔNG thể chối delta ĐÃ ANCHOR" — đọc kỹ thì đó là lời thú nhận: delta CHƯA anchor thì chối vô tư, và **không tồn tại bằng chứng nào cho việc giấu**. Scale-Analysis:295 (L3) kê giảm nhẹ "Fraud-proof window + multi-operator fallback" — không có fraud-proof nào dựng được khi không có bằng chứng đầu vào. Bond để đó cũng không ai slash được vì không ai chứng minh nổi.

Thiệt hại KHÔNG HỒI PHỤC do G9: §1:32-35 — MAGIC không tích luỹ, suất epoch không tiêu thì mất. Nên dù delta bị giấu có được anchor muộn, phần MAGIC user KHÔNG sinh ra trong 6 epoch bị hạ hệ số là mất vĩnh viễn. Không có đường bù. G9 vốn được kê là lá chắn (§1 hệ quả (a)(b)(c)) — ở đây nó là **bộ khuếch đại thiệt hại**: biến một sự cố khả hồi (sổ sai) thành mất mát bất khả hồi (suất bốc hơi).

Đòn bẩy tấn công: giấu 1 epoch ⟹ hạ hệ số 6 epoch (cửa sổ trượt [e−6, e)). **Tỷ số khuếch đại 6:1.**
- **Kịch bản:** Operator O phục vụ shard chứa hash(did_X). Đối thủ trả O 200 USD để bóp X trong 1 epoch (hoặc chỉ là shard O bị lỗi 6 tiếng — không cần ác ý).
  Trước: X là công dân hạng nhất — tiêu 95%, tư_cách = 2.20×2.425×1.30×1.50 = **10.40×**
  O lặng lẽ drop mọi BalanceDelta của X trong epoch e. Không trả lỗi, không ACK, không log.
  Epoch e+1: đã_tiêu của X trong [e−5, e+1) rớt 1/6 ⟹ tỷ_tiêu ≈ 0.79 ⟹ tiêu_thật = 2.19. Nếu O drop 6 epoch liên tiếp: đã_tiêu = 0 ⟹ tỷ_tiêu = 0 ⟹ tiêu_thật = **1.00**, và §4.3:136 ⟹ giờ_thấp_điểm = **1.00** (đã_tiêu = 0 ⟹ tỷ = 0 ⟹ sàn).
  tư_cách X: 10.40 → 2.20 × 1.00 × 1.00 × 1.50 = **3.30×** ⟹ **mất 68% suất sinh trong 6 epoch (30 ngày)**.
  X đi kiện: cầm ra 600 delta có chữ ký CỦA CHÍNH X. Trọng tài hỏi "chứng minh O đã nhận?" — X không có gì. O nói "tôi chưa từng nhận". Không có root nào chứa lá đó ⟹ inclusion proof không dựng được ⟹ proof-of-absence cũng vô nghĩa vì không có mốc "lẽ ra phải có".
  Bond của O: nguyên vẹn. Thiệt hại của X: 30 ngày suất, mất vĩnh viễn theo G9.
  Chi phí tấn công: 200 USD (hoặc 0, nếu chỉ là bug).
- **Đề xuất:** 1) **SỬA LÁ — bắt buộc, đây là chỗ gãy gốc.** Operator phải trả BIÊN NHẬN KÝ ngay khi append: `receipt = sig_op( H(lá) ‖ epoch ‖ seq )`. User giữ receipt. Cuối epoch, nếu root(epoch) không chứa lá mà operator đã ACK ⟹ user xuất receipt + proof-of-absence ⟹ **slash bond tự động**. Không có receipt thì mọi thứ còn lại trong §6 (bond, fraud-proof, cửa sổ) chỉ là chữ.
2) Sửa §6:214: viết thẳng "giấu delta hiện KHÔNG PHÁT HIỆN ĐƯỢC và KHÔNG CHỨNG MINH ĐƯỢC" thay vì câu trung tính "operator có thể DoS/giấu delta" — câu hiện tại đọc như đã lường trước, thực tế là chưa có đường xử.
3) Chặn khuếch đại 6:1: nếu operator bị slash vì giấu, `đã_tiêu` của user trong cửa sổ phải được **ghi nhận bù** từ receipt đã ACK (khôi phục hệ số). Không khôi phục được MAGIC đã mất (G9), nhưng chặn được vệt thiệt hại 5 epoch còn lại.
4) §9 mục 11 tự hỏi "CONTRACT chưa định lượng bond + cửa-sổ-fraud-proof — có phải gap thật?" → **Có, và nặng hơn mức đang nghĩ**: không phải thiếu con số, mà là thiếu cơ chế đầu vào cho fraud-proof. Định lượng bond trước khi có receipt là định lượng một thứ không dùng được.

### [CAO] Bond tĩnh vs phơi-nhiễm tăng dần ⟹ MỌI operator thành công đều đạt điểm bỏ trốn +EV (hỏng cấu trúc, không phải rủi ro biên)
- **Neo:** CONTRACT §6 bảng (có bond, KHÔNG có cap) = :206-212 · §9 mục 11 = :253, mục 12 = :254 · §4.2 đã_tiêu đếm MAGIC khai = :112 · §7 D4 = :225 · Scale-Analysis §6.2 L2 = :294 ("cần cap net exposure/epoch" — không được mang sang CONTRACT), §5.3 bond row = :257
- **Mô tả:** §9 mục 12 hỏi "mất khả năng trả CARP cuối epoch — ai chịu thiệt". Scale-Analysis:294 (L2) xếp "Trung", giảm nhẹ "Bond + request_topup che một phần; cần cap net exposure/epoch". CONTRACT §6:211 bê nguyên "bond" sang, §9:253 tự nhận chưa định lượng.

Chỗ gãy: bond B đóng **một lần lúc đăng ký**; phơi nhiễm E = net_CARP nợ Treasury cuối epoch **tăng theo số user của provider**. Với provider ăn nên làm ra, E tăng đơn điệu. Tồn tại epoch T mà E(T) > B. Từ T trở đi, nước đi duy lý của operator là **ôm E rồi biến, mất B**, lãi E − B > 0.

Đây không phải rủi ro biên — nó là **định lý về mọi operator thành công**. Càng thành công càng sớm tới T. Hệ tự chọn lọc: operator tốt nhất là kẻ có động cơ phản bội mạnh nhất. Scale-Analysis:294 tự viết "cần cap net exposure/epoch" — cái cap đó chính là thứ đóng lỗ, và nó KHÔNG được mang sang CONTRACT §6. Bảng §6:206-212 có "bond" nhưng không có "cap".

Cộng hưởng với D1: vì `tiêu_thật` (§4.2:112) đếm MAGIC **khai**, không đếm CARP **đã quyết toán**, nên khi operator vỡ nợ, user của nó **vẫn giữ nguyên 2.50×**. Vỡ nợ không thu hồi hệ số ⟹ shell provider chỉ cần sống tới hết epoch là đủ ⟹ wash-trade không cần cả việc trả CARP.
- **Kịch bản:** Bond đăng ký B = 100.000 ADA (mượn con số Mosaic §15.5 mà Scale-Analysis:257 dẫn). Provider P chạy dịch vụ thật, tử tế, 3 quý liền.
  Quý 1: 2.000 user, net_CARP/epoch E = 8.000 CARP ≈ 8.000 ADA. E ≪ B ⟹ P trung thực (bỏ trốn lỗ 92.000).
  Quý 2: 20.000 user, E = 80.000. Vẫn E < B ⟹ trung thực, biên lãi bỏ trốn còn −20.000.
  Quý 3: 60.000 user, E = 240.000 ADA. **E − B = +140.000 ADA.** Nước đi duy lý: nhận trọn epoch, không settle, mất bond, ôm 240.000.
  Người chịu: Treasury ôm khoản phải thu 240.000 CARP không đòi được. User của P **vẫn giữ tiêu_thật = 2.50×** cả 6 epoch tiếp (§4.2 đếm MAGIC khai) ⟹ họ tiếp tục hút phần pro-rata của người ngay thật ở §5:172 dù CARP đối ứng chưa từng vào Treasury.
  Không cần ác ý: đúng cấu trúc này, chỉ cần P PHÁ SẢN vì lý do khác ở quý 3 là kết quả y hệt.
  Với shell provider của D1: attacker cố tình dựng E lớn rồi biến — không đóng bond thật (chưa có Registry để bắt đóng), nên còn không mất B.
- **Đề xuất:** 1) **Bond động + cầu dao (circuit breaker) trong lớp kế toán §6** — MAGIC tự làm được, không chờ ai:
   `B ≥ κ × E_max_quan_sát` (κ ≥ 1.5). Lớp kế toán **từ chối append delta mới** khi phơi nhiễm chưa quyết toán luỹ kế > B/κ. Provider muốn lớn thì nạp bond trước. Bất biến ép được: `E_chưa_quyết_toán ≤ B/κ` tại MỌI thời điểm ⟹ bỏ trốn luôn −EV.
2) Mang dòng "cap net exposure/epoch" từ Scale-Analysis:294 vào bảng §6 — hiện đang rơi mất khi bê "bond" sang.
3) Nối D1↔D4 (xem finding D1): `đã_tiêu` chỉ tính lá có CARP đã quyết toán + final. Khi đó vỡ nợ **tự động thu hồi hệ số** của user provider đó ⟹ user có động cơ chọn provider bonded ⟹ áp lực thị trường làm thay việc Registry chưa có.
4) Định lượng §9 mục 11 theo κ và E, KHÔNG theo hằng số tuyệt đối. Hằng số tuyệt đối là chỗ hỏng.

### [TRUNG] Engine off-chain là điểm chết đơn (SPOF) của `nhịp_gen`; không quy tắc dự phòng, và GenMAGIC KHÔNG có escape-hatch permissionless như Wakeme
- **Neo:** CONTRACT §9 mục 12 = :254 · §5 tổng_trọng_số off-chain = :171-172, công bố đầu epoch = :176-177, van 1.25× = :182 · §3 M_v phụ thuộc nhịp_gen = :71,75 · §6 (không có van) = :192-214 · §1 G5/G9 = :26,30 · Wakeme-Math `keeper ∨ owner` = :178, T-1 liveness = :279, LeaseExpiry đề xuất = :290
- **Mô tả:** §9 mục 12 hỏi thẳng: "Wakeme có `ReclaimEpoch` permissionless làm van cuối — GenMAGIC có tương đương chưa?" **Trả lời: CHƯA, và chỗ cần van còn nặng hơn Wakeme.**

Đối chiếu:
- Wakeme: `reclaim_epoch_ok` ép `(keeper_signed ∨ owner_signed)` (Wakeme-Math:178) ⟹ keeper chết, owner tự đẩy về pot, thu min-ADA, đóng vault. Math:279 (T-1) khẳng định "KHÔNG có redeemer nào phụ thuộc keeper để user thoát vault". Và Math:290 còn đề xuất `LeaseExpiry` permissionless cho trường hợp keeper+owner đều chết.
- GenMAGIC §6: **0 van**. Không đường user tự-anchor, không đường ai đó cưỡng bức settle.

Điểm chết nặng nhất KHÔNG phải sổ, mà là `nhịp_gen`:
  §5:171-172 — `tổng_trọng_số(e)` do **engine cộng off-chain**; `nhịp_gen(e) = ngân_sách × Q / tổng_trọng_số(e−1)`.
  §3:75 — mọi `M_v` phụ thuộc `nhịp_gen(e)`.
  §5:176 — `nhịp_gen(e)` "công bố ĐẦU epoch e".
⟹ Engine không công bố ⟹ **không user nào tính được M_v** ⟹ sinh MAGIC **dừng toàn mạng**. CONTRACT không có dòng nào nói chuyện gì xảy ra khi không công bố. Van cứng §5:182 (`nhịp_gen(e) ≤ nhịp_gen(e−1) × 1.25`) giả định đã có nhịp_gen(e); nó không phát biểu gì về sự VẮNG MẶT.

Giảm nhẹ thật (ghi cho công bằng): LAMP an toàn tuyệt đối trong mọi kịch bản này — I-ACT-7 / G5, engine chỉ ĐỌC qua reference_input, và Wakeme ReclaimEpoch vẫn chạy độc lập. Đây là mất **suất sinh**, không mất **vốn**. Nhưng theo G9 mất suất = mất vĩnh viễn.
- **Kịch bản:** Engine (hoặc chỉ shard điều phối tính tổng_trọng_số) chết lúc 23h50 trước ranh giới epoch 512. Không ai công bố `nhịp_gen(512)`.
  Mọi user mở app: `M_v(512) = ⌊⌊c_v × nhịp_gen(512)/Q⌋ × tư_cách_v/Q⌋` — thiếu nhịp_gen(512) ⟹ **không tính được**. Không có quy tắc mặc định trong CONTRACT ⟹ hành vi không xác định: nơi thì coi = 0 (mất trắng 1 epoch × TOÀN MẠNG = trọn ngân_sách_gen, ví dụ 1.000.000 MAGIC, mất vĩnh viễn theo G9), nơi thì dùng lại giá trị cũ (lệch ngân sách, phá G3).
  Engine sống lại sau 3 ngày (giữa epoch 512): giờ công bố nhịp_gen(512) muộn được không? §5:176-178 nói mục đích công bố đầu epoch là để "user tự tính" và tránh "cuộc đua đào". Công bố giữa epoch phá đúng tính chất đó. CONTRACT không nói.
  Đối chiếu: cùng lúc đó, keeper Wakeme cũng chết → user vẫn tự ký `ReclaimEpoch` (Math:178) đẩy LAMP về pot, đóng vault, thu min-ADA. **Wakeme có đường thoát, GenMAGIC không.**
  Trường hợp hẹp hơn: chỉ shard chứa hash(did_X) chết. X mất toàn bộ khả năng ghi tiêu ⟹ 6 epoch sau hệ số về sàn (xem finding giấu-delta) ⟹ **mất 68% suất, 30 ngày** dù không ai ác ý.
- **Đề xuất:** 1) **Quy tắc mặc định khi không công bố** (rẻ, phải có ngay): `nhịp_gen(e) := min( nhịp_gen(e−1), ngân_sách_gen(e) × Q / tổng_trọng_số(e−1) )` với `nhịp_gen(e−1)` là giá trị công bố gần nhất; kèm hạn chót slot cụ thể. Bảo toàn tính đo-lường-được (§5:176) và không phá van 1.25×. KHÔNG có dòng này thì hệ có trạng thái không xác định ở đúng lúc tệ nhất.
2) **Van cuối permissionless — tương đương LeaseExpiry**: sau `T_max` epoch không anchor, BẤT KỲ ai được trigger anchor root cuối cùng đã ACK + buộc settle. Mượn thẳng khuôn Wakeme-Math:290 (đang là đề xuất chờ anh gate) — nếu Wakeme gate thì GenMAGIC nên gate cùng, cùng một luận cứ.
3) Ghi vào §6 bảng "ranh giới tin cậy" dòng thứ tư còn thiếu: **engine chết ⟹ sinh dừng toàn mạng**. Hiện §6:214 chỉ nói về DoS/giấu ở mức delta, không nói mức hệ.
4) Trả lời dứt §9 mục 12: **ai chịu = user, 100%; escape-hatch = KHÔNG CÓ.** Đừng để câu hỏi này mở.

### [TRUNG] Mâu thuẫn nội tại: "single-writer per DID" cấm chính "multi-operator fallback" mà thiết kế mượn làm giảm nhẹ
- **Neo:** CONTRACT §6 chia tải single-writer = :212 · Scale-Analysis §5.4 sharding lý do = :264-267, §5.5 = :269-273, §6.2 L3 "multi-operator fallback" = :295, L6 cross-shard = :298
- **Mô tả:** §6:212 chốt: "shard theo `hash(did_commit)` ⟹ số dư 1 DID do **đúng 1** shard giữ ⟹ không race". Nguồn Scale-Analysis:266 cùng nội dung (single-writer per shard).

Nhưng giảm nhẹ cho rủi ro DoS lại là Scale-Analysis:295 (L3): "Fraud-proof window + **multi-operator fallback**".

Hai thứ này loại trừ nhau. Multi-operator fallback cho CÙNG một DID = hai writer = đúng cái race mà sharding sinh ra để diệt (double-spend số dư off-chain, Scale-Analysis §5.4:264-267). Muốn có cả hai phải có giao thức bàn giao/đồng thuận giữa operator — **không tồn tại trong bất kỳ nguồn nào của 4 nguồn**.

⟹ CONTRACT §6 kế thừa một biện pháp giảm nhẹ mà chính kiến trúc của nó cấm. Thực tế: **mỗi shard operator là độc quyền tuyệt đối trên toàn bộ đời sống MAGIC của các DID thuộc shard đó.** Không đổi được nhà cung cấp, không có dự phòng, không có cạnh tranh. Đây là điều kiện tiền đề khiến finding "giấu delta" và finding "bond" trở nên khai thác được — nạn nhân không có lối ra.
- **Kịch bản:** did_X thuộc shard 7 theo hash(did_commit) — X không chọn, không đổi được (hash là hàm của DID, DID gắn sinh trắc ⟹ **cố định trọn đời**).
  Operator shard 7 tăng phí / giảm chất lượng / giấu delta của X (xem finding trên). X muốn chuyển sang shard 3.
  Không được: §6:212 ép "số dư 1 DID do ĐÚNG 1 shard giữ". Chuyển = 2 shard cùng biết số dư X trong lúc bàn giao = đúng race mà §6:212 tồn tại để chặn. Không có giao thức bàn giao nào được đặc tả.
  Thử áp "multi-operator fallback" (Scale-Analysis:295): shard 3 nhận song song delta của X ⟹ X tiêu 100 MAGIC ở shard 7 và 100 MAGIC ở shard 3 trong cùng epoch, mỗi shard thấy số dư đủ ⟹ **chi âm 100 MAGIC**, đúng thứ Scale-Analysis §5.4:265 nói single-writer sinh ra để chặn.
  ⟹ Với X, operator shard 7 là nhà nước. Suốt đời.
- **Đề xuất:** 1) Bỏ "multi-operator fallback" khỏi tập giảm nhẹ, HOẶC đặc tả giao thức bàn giao thật: `HandoffRequest(did, from_shard, to_shard, epoch_boundary)` chỉ hiệu lực **tại ranh giới epoch sau khi root(e) của from_shard đã anchor + final (k=5)**, số dư khởi tạo ở to_shard = số dư đã chứng minh qua inclusion proof. Không race vì hai shard không bao giờ cùng sống trên một DID trong cùng epoch.
2) Cho tới khi có (1): ghi thẳng vào §6 "ranh giới tin cậy" — **operator shard là độc quyền trọn đời trên DID thuộc shard; không có dự phòng, không có lối thoát**. Đây là giả định vận hành nặng nhất của §6 và hiện đang bị che bởi một dòng giảm nhẹ không dùng được.
3) Nếu (1) quá đắt: tối thiểu cho DID chọn shard lúc genesis (thay vì hash cưỡng bức) ⟹ có cạnh tranh trước-khi-vào, dù không có sau.

### [TRUNG] G4 vỡ giữa các cohort: `c` tuyến tính tới 1001 lấn át trần 12.375× của tư_cách — người vào sớm nằm im thắng người vào muộn tiêu thật
- **Neo:** CONTRACT §3 công thức = :71 · §4.2 "cá voi không có lợi thế" = :118 · §4.5 trần 12.375× = :157, kiểm G4 = :159-161 · §1 G4 = :25 · Wakeme-Math D = min(1001, ⌊pot/10⁶⌋) = :33 · Wakeme-Math MONO-c = :104 · Wakeme-Math §9 mục 6.5 pot cạn tạm thời = :303 · Wakeme-Tech endpoint 7 (`current_d_lamp`, `saturated`) = :398
- **Mô tả:** §9 mục 6 yêu cầu "tìm hồ sơ ôm-giữ nào vượt được người tiêu-thật". Tìm ra một lớp, và nó không phải cá voi.

§3:71 — `M_v = ⌊⌊c_v × nhịp_gen/Q⌋ × tư_cách_v/Q⌋`. `c_v` vào **tuyến tính, không trần mềm**, dải [1, 1001]. `tư_cách` **trần cứng 12.375×** (§4.5:157). ⟹ tỷ lệ c vượt 12.375:1 thì **mọi hành vi đều thua**. Dải c cho tỷ lệ tối đa 1001:1 = **81× trần tư_cách**.

§4.2:118 tuyên: "Đo TỶ LỆ, không đo LƯỢNG ⟹ **cá voi không có lợi thế**". Sai như phát biểu: đo-tỷ-lệ bỏ được lợi thế cá voi **bên trong hệ số**, nhưng `c` vẫn là **LƯỢNG** nhân đằng trước. Lợi thế sống nguyên vẹn ở cơ số.

Điểm đắt: `c` KHÔNG phải thước đo giàu — Wakeme-Math:33 `D = min(1001, ⌊pot_oildrop/10⁶⌋)`. D quyết bởi **số dư pot lúc GetLAMP**, tức **THỜI ĐIỂM VÀO**. Wakeme-Math:303 (§6.5) tự nhận pot cạn tạm thời khi tốc độ GetLAMP > tốc độ Reclaim trả về, "đặc biệt giai đoạn đầu". ⟹ cohort vào lúc pot đầy có D = 1001; cohort vào lúc pot cạn có D nhỏ. Vĩnh viễn — vì `c` chỉ giảm (MONO-c, Wakeme-Math:104), không có đường tăng.

⟹ G4 ("công dân hạng nhất = người tiêu MAGIC cho dịch vụ THẬT") **vỡ giữa các cohort**. §4.5:159-161 "kiểm G4 (số học)" chỉ kiểm **trong cùng cohort** (ngầm định cùng c) — nó chưa từng kiểm cái này.
- **Kịch bản:** **Bác Tám** — vào tháng 1, pot đầy ⟹ D = 1001. Không quan tâm dịch vụ, chỉ tiêu MIN_MAGIC_TX/ngày cho khỏi bị Reclaim. Tuổi 24 epoch. tư_cách = 2.20 × 1.075 × 1.50 × 1.00 = **3.548×** (xem finding idler tối ưu).
  Trọng số = 1001 × 3.548 = **3.552**
**Chị Mai** — vào tháng 5 lúc pot cạn còn 80 LAMP ⟹ D = 80 (Wakeme-Math:33). Công dân hạng nhất tuyệt đối: tiêu 100% suất, thấp-điểm 100%, cam kết lịch đầy, tuổi 24 epoch. tư_cách = **12.375×** (trần tuyệt đối của thiết kế).
  Trọng số = 80 × 12.375 = **990**
⟹ Bác Tám nhận MAGIC gấp **3.59 lần** chị Mai. Bác Tám tiêu 5% suất, chị Mai tiêu 100%.
  Chị Mai KHÔNG có đường sửa: `c` chỉ giảm (MONO-c), không GetLAMP lại được (I-ACT-10, 1 DID = 1 vault, Wakeme-Math:130), tư_cách đã kịch trần.
  Ngưỡng hoà: chị Mai cần c ≥ 1001 × 3.548/12.375 = **287 LAMP** mới bằng bác Tám nằm im. Mọi cohort vào lúc pot < 287 LAMP đều **không thể thắng bác Tám dù chơi hoàn hảo**.
- **Đề xuất:** 1) Sửa §4.2:118 — bỏ khẳng định "cá voi không có lợi thế". Đúng phải là: "đo tỷ lệ khử lợi thế lượng **trong hệ số**; cơ số `c` vẫn tuyến tính nên lợi thế theo cohort-vào-sớm còn nguyên". Khẳng định sai trong CONTRACT nguy hiểm hơn lỗ hổng — nó khiến người ta ngừng tìm.
2) Bổ sung "kiểm G4 CHÉO cohort" vào §4.5, với chính con số trên. Nếu kết quả không chấp nhận được thì chọn 1 trong 2:
   (a) Nén cơ số: dùng `base_v = ⌊Q × c_v^(1/2)⌋`-kiểu (căn/log) thay vì `c_v` tuyến tính ⟹ dải cơ số từ 1001:1 tụt xuống ~31:1, cùng bậc với trần tư_cách ⟹ hành vi lại có ý nghĩa. Đánh đổi: bẻ tính "đo lường được" đơn giản, và cần chốt lại với anh vì đụng G3/§5.
   (b) Chấp nhận và ghi thẳng vào §8 + tài liệu người dùng: "thời điểm vào quyết định phần lớn suất sinh; hành vi chỉ điều chỉnh trong biên 12.375×". Nếu chọn (b) thì G4 phải viết lại — nó đang hứa thứ hệ không giao.
3) Bất kể chọn gì: `TRẦN_TUỔI = 24` + `BƯỚC_TUỔI = 0.05Q` (§4.1:101) đang **cộng thêm** lợi thế cho đúng cohort vào sớm (họ già trước). Hai hiệu ứng cùng chiều, nhân nhau. Cân nhắc tính tuổi theo **thứ hạng trong cohort** thay vì tuổi tuyệt đối.

### [TRUNG] `tiêu_thật` ăn theo MAGIC KHAI, không theo CARP ĐÃ QUYẾT TOÁN — §7 thiếu hẳn cạnh D1→D4
- **Neo:** CONTRACT §4.2 = :112-115 · §6 lá = :200, ranh giới Mosaic/MAGIC = :210, anchor+net CARP = :203 · §7 D1 = :222, D4 = :225 · §9 mục 1 = :243 · Scale-Analysis §5.2 settlement = :236-242, §6.2 L2 = :294 · Wakeme-Tech §4.5 "1 CARP = 1 MAGIC" = :360-361,:397
- **Mô tả:** §4.2:112-113 định nghĩa `đã_tiêu = Σ MAGIC hồ sơ did_commit tiêu thật trong cửa_sổ`. Nguồn của con số đó là lá off-chain có user-cosign (§6:200). **Không có bất kỳ điều kiện nào buộc CARP đối ứng phải đã về Treasury.**

Hệ quả dây chuyền:
- Chữ "tiêu **thật**" trong tên hệ số là sai tên. Nó đo **lời khai đã ký**, không đo giá trị đã chuyển.
- Provider vỡ nợ / bỏ trốn ⟹ user của nó **vẫn giữ 2.50×** suốt 6 epoch (finding bond).
- Shell provider của D1 **không cần trả gì** — chỉ cần lá được append.
⟹ Đây chính là mắt xích biến D1 từ "khó" thành "miễn phí". Và nó là mắt xích **MAGIC tự nắm** (§6 là lớp kế toán của MAGIC — §6:210 tự chốt "MAGIC = lớp kế toán (số dư + cosign + CARP)").

Lỗi cấu trúc ở §7: D1 (:222) và D4 (:225) nằm hai dòng độc lập, không cạnh nối. Nhưng **mức nghiêm trọng của D1 là hàm của D4**: D4 chốt xong + bind credit vào CARP-đã-quyết-toán ⟹ D1 tự chết về kinh tế. D4 chưa chốt ⟹ D1 không vá được bằng bất kỳ đòn nào trong MAGIC. Bảng §7 hiện tại khiến người đọc kết luận sai rằng D1 chờ D2/Registry — thực ra nó chờ D4.
- **Kịch bản:** Attacker A, vault c = 1001, tuổi trần. Dựng shell `svc-ma-01`, đăng ký làm provider (D1 placeholder ⟹ không thẩm định, không bond).
  Epoch e: bot của A phát 600 BalanceDelta{did_A, svc-ma-01, Δ, cosign_A, nonce, prev}. Cosign hợp lệ tuyệt đối — A ký cho chính A (§6:211 "user-cosign" bảo vệ user khỏi operator; ở đây **là một người**).
  Lá vào Lazy-MMR, root anchor cuối epoch. §6:214 tuyên "operator KHÔNG thể bịa/sửa delta đã cosign" — đúng, và A **không cần bịa**: mọi delta của A là thật, đã ký, đã anchor. Hệ **không có gì để phát hiện**.
  Cuối epoch, `svc-ma-01` nợ Treasury 600 CARP. A: không settle. Không bond ⟹ mất 0.
  Epoch e+1: `đã_tiêu = 600`, `đã_sinh = 600` ⟹ tỷ_tiêu = 1.0 ⟹ **tiêu_thật = 2.50×**. Hệ chưa từng hỏi 600 CARP đâu.
  Đối chứng — NẾU bind vào CARP đã quyết toán: A phải nạp 600 CARP thật (mua bằng fiat qua GetMAGIC, Wakeme-Tech:360) → chảy về Treasury → A KHÔNG lấy lại được (đích cứng Treasury). Thu về: hệ số cao hơn ⟹ thêm MAGIC ⟹ MAGIC không bán được (G6 :27, non-transferable) ⟹ muốn quy ra giá trị lại phải tiêu ⟹ lại tốn CARP. **Vòng lặp âm tiền tuyệt đối. Wash chết không cần Registry.**
- **Đề xuất:** 1) **Nối cạnh D1→D4 trong bảng §7 ngay** và ghi rõ: mức nghiêm trọng D1 là hàm của D4; D1 KHÔNG vá được chừng nào D4 treo. Đây là cạnh phụ thuộc load-bearing đang thiếu.
2) Đổi định nghĩa §4.2: `đã_tiêu = Σ Δmagic của các lá mà (a) nằm trong root đã anchor, (b) có CARP đối ứng đã về Treasury, (c) settlement đã final (k=5)`. Dời cửa sổ [e−6,e) → **[e−7, e−1)** để chừa 1 epoch cho settlement final.
3) Đổi TÊN hệ số nếu không làm (2): `tiêu_thật` → `tiêu_khai`. Tên hiện tại khiến hội đồng và người đọc tin có một tính chất mà hệ không ép. Đặt tên gợi nhớ là rule (Forall §Đặt tên) — tên sai còn tệ hơn tên trơ.
4) Đẩy `magic-globalstate-brq-2026-07-16.md` (§5:188 ghi CARP chưa hồi) lên ưu tiên cao nhất — nó đang chặn không chỉ `ngân_sách_gen` mà cả đòn chống-wash duy nhất khả thi.

### [THẤP] Hai định nghĩa "tiêu" không ràng buộc nhất quán: `tiêu_thật` (tỷ lệ, 6 epoch) vs Wakeme `active` (tuyệt đối, MIN_MAGIC_TX/ngày) — khe cho hồ sơ nỗ-lực-tối-thiểu
- **Neo:** CONTRACT §4.2 (tỷ lệ) = :114 · §4.1 dựa vào bào c = :104 · Wakeme-Tech anti-idle `active = M_profile(n) ≥ MIN_MAGIC_TX` = :341 · Wakeme-Math I-ACT-3 = :120, MIN_MAGIC_TX "TẠM" = :304 · Wakeme-Math Đ-1/ranh giới pha = :87
- **Mô tả:** Hai hệ đo "đã tiêu" song song, cùng nguồn Registry chưa xây, **không có ràng buộc nhất quán nào giữa chúng**:
- Wakeme `active`: ngưỡng **TUYỆT ĐỐI** `M_profile(n) ≥ MIN_MAGIC_TX`, per-NGÀY, nhị phân, quyết định Reclaim có bào 1 LAMP không (Wakeme-Tech:341).
- GenMAGIC `tiêu_thật`: **TỶ LỆ** `đã_tiêu/đã_sinh` trên [e−6,e), liên tục (CONTRACT §4.2:114).

Khe: ngưỡng tuyệt đối không co giãn theo quy mô vault. Vault c=1001 sinh gấp bội MIN_MAGIC_TX ⟹ **thoả `active` gần như miễn phí** trong khi tỷ_tiêu ≈ 0.05. Vault c=10 muốn `active` phải tiêu tỷ lệ lớn hơn nhiều lần so với suất của mình. ⟹ cùng một ngưỡng, gánh nặng **nghịch** với quy mô — đúng chiều sai.

Hệ quả đã dùng ở finding "idler tối ưu": chính khe này cho phép bác Tám giữ c=1001 suốt 1001 ngày Daily mà chỉ tiêu 5% suất. Nếu `active` là ngưỡng TỶ LỆ thì anti-idle của Wakeme sẽ bào c của bác — và §4.1:104 ("vault già có tuổi_LAMP cao nhưng pha Epochy bào c 5 LAMP/epoch ⟹ không tích luỹ vô hạn") mới thành thật. Hiện §4.1:104 đang dựa vào một cơ chế bào mà khe này vô hiệu hoá trong suốt Daily (1001 ngày ≈ 2,7 năm).

MIN_MAGIC_TX còn chưa chốt — Wakeme-Math:304 xếp "TẠM", ảnh hưởng "Thấp — tham số ngưỡng active, không đụng conservation". Đúng về conservation, **sai về động cơ**: nó là tham số quyết định toàn bộ hiệu lực của tuổi_LAMP.
- **Kịch bản:** MIN_MAGIC_TX = 1 MAGIC/ngày (chưa chốt, Wakeme-Math:304).
  **Vault lớn** c = 1001, sinh 100 MAGIC/epoch = 20 MAGIC/ngày. Tiêu 1 MAGIC/ngày ⟹ `active` = True ⟹ **không Reclaim, c giữ 1001 suốt 1001 ngày**. Gánh nặng thực = **5% suất**. tỷ_tiêu = 0.05 ⟹ tiêu_thật = 1.075.
  **Vault nhỏ** c = 10, sinh 1 MAGIC/epoch = 0.2 MAGIC/ngày. Muốn `active` phải tiêu 1 MAGIC/ngày = **500% suất** ⟹ BẤT KHẢ THI ⟹ luôn idle ⟹ Reclaim bào 1 LAMP/ngày ⟹ **c = 0 sau 10 ngày, vault đóng**.
  ⟹ Cùng ngưỡng: vault lớn trả 5%, vault nhỏ trả 500% và **bị xoá sổ**. Ngưỡng tuyệt đối biến anti-idle thành cơ chế **diệt vault nhỏ, nuôi vault lớn nằm im** — cộng hưởng đúng chiều với finding cohort ở trên.
  Và §4.1:104 ("pha Epochy bào c 5 LAMP/epoch ⟹ không tích luỹ vô hạn") chỉ bắt đầu áp sau ngày 1001 (Wakeme-Math:87) ⟹ bác Tám ôm c=1001 với tuổi_LAMP trần trong **2,7 năm** trước khi cơ chế bào chạm tới.
- **Đề xuất:** 1) Chuyển `active` sang ngưỡng **TỶ LỆ**, dùng chung một nguồn với §4.2: `active(n) ⟺ tỷ_tiêu_gần_đây ≥ θ` (θ ví dụ 0.25). Trung lập theo quy mô: vault lớn và nhỏ trả cùng % suất. Việc này thuộc Wakeme (I-ACT-3) nhưng **định nghĩa phải do MAGIC cấp** vì MAGIC giữ sổ tiêu (§6:210) — gửi đề xuất qua inbox, đừng chờ.
2) Ghi vào CONTRACT §7 một dòng D-mới: "Định nghĩa `active` của Wakeme và `tiêu_thật` của GenMAGIC PHẢI dẫn xuất từ cùng một `đã_tiêu`" — hiện hai bên tự định nghĩa, sẽ phân kỳ ngay khi Registry land.
3) Phản hồi Wakeme-Math:304: MIN_MAGIC_TX không phải "Thấp". Đúng là không đụng conservation, nhưng nó quyết định `tuổi_LAMP` có bị bào hay không suốt 2,7 năm Daily ⟹ đụng thẳng G4/G8. Nâng mức và chốt cùng θ.
4) §4.1:104 phải bỏ dựa vào "Epochy bào c" làm luận cứ cân bằng — cơ chế đó không chạm Daily. Nếu cần cân bằng trong Daily thì phải có cơ chế trong Daily.

**Đã điểm qua:** **Given (1 dòng, theo yêu cầu):** Sybil đa-DID KHÔNG đào — CONTRACT §2:57-58 nhận ngoài phạm vi, chặn bởi sinh trắc Enclave (Wakeme-Math T-3 :281). Lưu ý duy nhất: mọi kịch bản wash của em dựng bằng **2 người thật đồng loã**, không cần Sybil — nên given này không che được D1.

**§9 mục 1 (D1 wash-trade) — TÌM RA, nặng nhất.** 5 finding: (a) chờ B2 là chờ nhầm cửa — B2 là cổng Bool trong Reclaim của Wakeme, không đẻ ra nanogic-sum/slot-timestamp mà §4.2/§4.3 cần, và B2 land xong wash vẫn chạy 100% với 1 DID đồng loã; (b) chủ sai — STATUS.md:34 ghi chủ Registry consume-gate = "MAGIC team + backend", MAGIC đang chờ chính mình; (c) con số sai — 12.375× chứ không 3.75× (thiếu cam_kết_lịch + tuổi_LAMP); (d) bảng chống-gian-sổ §6 dựng theo mô hình operator-ác-user-ngay, vô hiệu toàn bộ khi user ≡ operator; (e) D1 thật ra bị chặn bởi **D4**, không phải D2 — §7 thiếu hẳn cạnh này.
→ **CÂU QUYẾT ĐỊNH: KHÔNG buộc chờ B2. Vá được trong MAGIC** — vì thứ giết wash là *chi phí không thu hồi được*, không phải *thực-tài-nguyên*. Đòn: bind `đã_tiêu` vào CARP **đã quyết toán + final**, nằm trọn trong lớp kế toán §6 mà MAGIC sở hữu (§6:210). Điều kiện: **D4 phải chốt trước** — đó là blocker thật, và nó cũng không phải B2.

**§9 mục 6 (G4 có thật sự thoả?) — TÌM RA.** 3 finding: (a) §4.5:159-161 "kiểm G4 (số học)" dùng bù nhìn — idler tối ưu đạt **5.32×** không phải 2.20×, biên "2.6 lần" thực là **1.06 lần**, và §8:234 đang dựng lá chắn pháp lý trên chính con số hỏng này; (b) G4 **vỡ chéo cohort** — `c` tuyến tính tới 1001 (Wakeme-Math:33, D theo pot lúc vào) lấn át trần 12.375×; bác Tám vào sớm nằm im ăn gấp **3.59 lần** chị Mai vào muộn chơi hoàn hảo, và §4.2:118 "cá voi không có lợi thế" **sai như phát biểu**; (c) khe hai định nghĩa "tiêu" (active tuyệt đối vs tiêu_thật tỷ lệ) nuôi vault lớn nằm im, diệt vault nhỏ.

**§9 mục 12 (vận hành) — TÌM RA.** Trả lời trực tiếp 3 câu hỏi con: **ai chịu = user 100%** · **escape-hatch = KHÔNG CÓ** · **GenMAGIC chưa có tương đương ReclaimEpoch**.

**Đã điểm qua:** LĨNH VỰC: đã nạp `~/.claude/_knowledge/audit-security.md` (38k, checklist appsec tích luỹ). Đã đọc Forall v10.

ĐÃ VERIFY THỰC THI: CÓ. PoC BigInt Q-format cài đúng §4 CONTRACT:88 (nhân-chia-floor tuần tự, cấm Number theo C-OVERFLOW). Chứng thực cài đúng trước khi công kích: tái tạo KHỚP trần 12.375× mà chính CONTRACT:157 công bố. Kết quả: tư_cách ôm-giữ H = 2.200×, tiêu-THẬT R (cầu thật 40% suất) = 4.400×, WASH C = 12.375× ⟹ C/H = 5.625×, **C/R = 2.813×** (kẻ tiêu giả đè người tiêu thật — G4 bị lật). Pha loãng zero-sum: φ=0.10 → wash ăn 3.846× phần công bằng, honest mất 31.6%; φ=0.25 → mất 53.6%; φ=0.50 → mất 69.8%. Van 1.25×/epoch: phồng luỹ kế 3.815× (6 ep) / 14.55× (12 ep) / 211.8× (24 ep) / 1.19×10^7 (73 ep). Kẹp min(Q,·): đã_tiêu = 100 / 200 / 1000 trên đã_sinh = 100 đều cho ra ĐÚNG 2.500×.

§9 MỤC 11 (an-ninh sổ off-chain — cosign+hash-chain+nonce+anchor+bond có đủ theo 6 phép thử?) — ĐÁP: KHÔNG ĐỦ, và hỏng ở tầng mô hình mối-đe-doạ chứ không phải tầng crypto. 7 phát hiện: (1) reference_input không xác thực — 2 ADA → gen vô hạn, do chính câu "miễn phí, không cần engine kiểm" ở CONTRACT:53-55 ra lệnh, mâu thuẫn với :57 vốn dựa vào NFT; (2) cosign đảo chiều động cơ — bê từ PM-1 "ký = bị trừ tiền" sang "ký = được thưởng", cả 5 lớp và cả 6 phép thử PASS trên sổ bịa 100%; (3) fraud-proof không tồn tại cho gian-lận-tư-cách + leaf thiếu chữ ký operator ⟹ bond không slash được; (4) payload cosign không đặc tả + leaf thiếu provider/service/slot/epoch (3 biến thể leaf mâu thuẫn giữa 3 nguồn); (5) mâu thuẫn shard ⟹ bội-chi chéo provider N×; (6) nhịp_gen/tổng_trọng_số không bảo vệ; (8) kẹp min() nuốt bằng chứng bội-chi.
→ Kết luận trục cho mục 11: 6 phép thử §6.3 ĐỀU là phép thử TÍNH TOÀN VẸN (sổ có được ghi trung thực không), KHÔNG phép nào kiểm TÍNH ĐÚNG (dịch vụ có thật không). Thiếu T-COLLUSION + T-REFINPUT-FORGE.

§9 MỤC 12 (vận hành / DoS / ai chịu / escape-hatch) — ĐÁP: CHƯA có tương đương `ReclaimEpoch`. Phát hiện (7) + (9). Wakeme bảo đảm "KHÔNG có redeemer nào 

### [NGHIÊM TRỌNG] §5 nhịp_gen lệch ĐÚNG một thừa số Q = 10⁹ — hệ sinh ra 10⁻⁹ lần ngân sách (hoặc lạm phát 10⁹× nếu ai đó "vá" nhầm phía)
- **Neo:** /Users/ductiger/Projects/MAGIC/Specs/GenMAGIC-CONTRACT-Vi.md:172 (nhịp_gen ×Q) đối chiếu :71 (M_v ÷Q²) và :76 (tư_cách Q-format), :171 (W = Σ c×tư_cách, tích thô)
- **Mô tả:** Phân tích thứ nguyên. §3:76 định nghĩa `tư_cách` là Q-format; §5:171 định nghĩa `tổng_trọng_số W = Σ_v (c_v × tư_cách_v)` — tích THÔ, không chia Q ⟹ W có đơn vị [NGUYÊN-LAMP × Q].

Đặt rate = nanogic/LAMP. §3:71 áp `M_v = ⌊⌊c_v × nhịp_gen/Q⌋ × tư_cách_v/Q⌋` ⟹ nhịp_gen PHẢI là Q-format của rate, tức nhịp_gen = rate × Q.
Tổng: G(e) = Σ_v M_v = nhịp_gen(e) × W(e) / Q².
Muốn G(e) = ngân_sách(e) khi W(e)=W(e−1) ⟹ nhịp_gen = ngân_sách × Q² / W.
Nhưng §5:172 viết `nhịp_gen(e) = ⌊ngân_sách_gen(e) × Q / max(tổng_trọng_số(e−1),1)⌋` — CHỈ MỘT Q.

⟹ G(e) = ngân_sách(e) × W(e) / (W(e−1) × Q). Khi W đứng yên: G = ngân_sách / 10⁹.

Đây là lỗi CHẾT NGƯỜI hai chiều: viết như hiện tại thì hệ sinh gần-như-0 (fail-closed, lộ ngay); nhưng nếu ai đó "chữa cháy" bằng cách nhân ngân_sách_gen lên 10⁹ thay vì sửa nhịp_gen thành ×Q², thì mọi công thức hạ nguồn (§5 bù-kỳ-sau, GreenBack br_q) đều lệch 10⁹ theo chiều LẠM PHÁT. Trên mainnet đây là chênh 10⁹ lần tiền thật.
- **Kịch bản:** 1 vault, c = 1001 NGUYÊN-LAMP (trần d_cap, Wakeme-Math:33), tư_cách = Q = 10⁹ (sàn 1.0×).
W(e−1) = 1001 × 10⁹ = 1.001×10¹².
ngân_sách_gen(e) = 1000 MAGIC = 10¹² nanogic.

Theo §5:172 như viết:
nhịp_gen(e) = ⌊10¹² × 10⁹ / 1.001×10¹²⌋ = ⌊10⁹/1.001⌋ = 999_000_999.
M_v = ⌊⌊1001 × 999_000_999 / 10⁹⌋ × 10⁹/10⁹⌋ = ⌊999_999_999_999/10⁹⌋ = ⌊999.999…⌋ = 999 nanogic.

Ngân sách 10¹² nanogic → phát THẬT 999 nanogic ≈ 10⁻⁶ MAGIC. Tỷ số 999/10¹² ≈ 10⁻⁹. ✓ đúng thừa số Q.

Sửa đúng (×Q²): nhịp_gen = ⌊10¹² × 10¹⁸ / 1.001×10¹²⌋ ≈ 9.99×10¹⁷ → M_v = ⌊1001×9.99×10¹⁷/10⁹⌋ = 9.99×10¹¹ ≈ 10¹² nanogic = 1000 MAGIC ✓ khớp ngân sách.
- **Đề xuất:** Sửa §5:172 thành `nhịp_gen(e) = ⌊ngân_sách_gen(e) × Q² / max(tổng_trọng_số(e−1), 1)⌋`. TUYỆT ĐỐI KHÔNG vá bằng cách thổi ngân_sách_gen lên 10⁹.
Bổ sung vào CONTRACT một BẢNG THỨ NGUYÊN bắt buộc (mỗi đại lượng: đơn vị + thang Q) và một test vector chốt cứng: `c=1001, tư_cách=Q, 1 vault, ngân_sách=10¹² nanogic ⟹ Σ M_v = 10¹² nanogic ± 10³`. Test này bắt được cả hai chiều lệch Q.

### [NGHIÊM TRỌNG] §5 van TRẦN_TĂNG=1.25Q GÁC SAI BIẾN — chứng minh nó KHÔNG THỂ chặn vượt ngân sách; phản ví dụ vượt 1125% mà van không hề chạm
- **Neo:** /Users/ductiger/Projects/MAGIC/Specs/GenMAGIC-CONTRACT-Vi.md:182 (van), :185-186 (khẳng định "chặn trên cứng"), :172 (nhịp_gen từ W(e−1)), :128-129 (giờ_thấp_điểm nhảy 1 epoch), :143-144 (cam_kết_lịch nhảy 1 epoch)
- **Mô tả:** §9 mục 3 hỏi thẳng: van 1.25× + bù kỳ sau có thật sự chặn vượt-ngân-sách không? **KHÔNG. Chứng minh được.**

Với công thức ĐÃ SỬA (×Q², xem finding Q-factor):
G(e) = nhịp_gen(e) × W(e)/Q² = [ngân_sách(e)×Q²/W(e−1)] × W(e)/Q² = **ngân_sách(e) × W(e)/W(e−1)**.

⟹ ĐỘ VƯỢT NGÂN SÁCH = ĐÚNG BẰNG TỶ SỐ TĂNG TRỌNG SỐ w(e) = W(e)/W(e−1). Không hơn không kém.

Van §5:182 ràng buộc `nhịp_gen(e) ≤ nhịp_gen(e−1) × 1.25`. Nhưng nhịp_gen KHÔNG nằm trong biểu thức w(e). Tệ hơn: nhịp_gen tỷ lệ NGHỊCH với W(e−1) ⟹ khi W tăng vọt, nhịp_gen **GIẢM** ⟹ van (vốn chỉ chặn chiều TĂNG) **không bao giờ kích hoạt trong đúng kịch bản nó sinh ra để chặn**.

Van chỉ bind khi W(e−1) SỤT hoặc ngân sách tăng — tức đúng lúc KHÔNG có nguy cơ vượt.

⟹ Khẳng định §5:185-186 ("có chặn trên cứng theo epoch (van 1.25×)") là **SAI**. Không có chặn trên cứng nào cả. Đây là véc-tơ lạm phát.

Ghi chú thêm: tốc độ nhảy 1-epoch của tư_cách KHÔNG bị chặn bởi 6-epoch window như trực giác. tuổi_LAMP nhảy tối đa ×1.05/epoch (§4.1 BƯỚC_TUỔI), tiêu_thật ×1.25/epoch (cửa sổ lấp 1/6 mỗi epoch). NHƯNG **giờ_thấp_điểm (§4.3) và cam_kết_lịch (§4.4) nhảy 1.0→1.5 trong ĐÚNG MỘT epoch**: giờ_thấp_điểm là tỷ_số đã_tiêu_thấp/đã_tiêu — hồ sơ tiêu 0 suốt [e−6,e−1) rồi tiêu toàn bộ ở thấp-điểm tại e−1 ⟹ tỷ = Q ngay; cam_kết_lịch chỉ cần ký hợp đồng lịch ⟹ K nhảy tức thì.
- **Kịch bản:** ngân_sách_gen = 10⁶ MAGIC = 10¹⁵ nanogic, cố định.

Epoch e−2, e−1: N=1000 vault, c=1001, tư_cách = 1.0× = 10⁹.
W(e−2) = W(e−1) = 1000 × 1001 × 10⁹ = 1.001×10¹⁵.
nhịp_gen(e−1) = nhịp_gen(e) = ⌊10¹⁵ × 10¹⁸ / 1.001×10¹⁵⌋ = 9.99×10¹⁷.
**Van: nhịp_gen(e)/nhịp_gen(e−1) = 1.00 < 1.25 ⟹ KHÔNG BIND.**

Trong epoch e, 1000 hồ sơ đó phối hợp bật 2 hệ số nhảy-1-epoch:
giờ_thấp_điểm 1.0→1.5, cam_kết_lịch 1.0→1.5 ⟹ tư_cách = 2.25× = 2.25×10⁹.
W(e) = 1000 × 1001 × 2.25×10⁹ = 2.252×10¹⁵.
G(e) = ngân_sách × W(e)/W(e−1) = 10¹⁵ × 2.25 = 2.25×10¹⁵ nanogic = **2.25×10⁶ MAGIC = 225% ngân sách. Van vẫn 1.00, không chạm.**

Cộng thêm 9000 vault mới vào (c=1001, tư_cách sàn 1.0×) trong cùng epoch e:
W(e) = 2.252×10¹⁵ + 9000×1001×10⁹ = 1.126×10¹⁶ ⟹ w(e) = 11.25.
G(e) = 10¹⁵ × 11.25 = 1.125×10¹⁶ nanogic = **1.125×10⁷ MAGIC = 1125% ngân sách trong MỘT epoch.**
nhịp_gen(e)/nhịp_gen(e−1) vẫn = 1.00. **Van 1.25× không hề chạm. 10.25×10⁶ MAGIC phát vượt trần GreenBack.**

Và §5:183 "bù kỳ sau" KHÔNG cứu được: dưới G9 (dùng-hay-mất, reset mỗi epoch) toàn bộ 1.125×10⁷ MAGIC đó đã bị TIÊU trong chính epoch e, đổi lấy dịch vụ thật. Trừ vào ngân_sách(e+1) không hoàn lại được bảo chứng đã bị rút ở epoch e.
- **Đề xuất:** 1. **Bỏ hẳn van trên nhịp_gen** — nó gác biến không liên quan.
2. **Ration TRỌNG SỐ, không ration NHỊP.** Giữ công bố `nhịp_gen(e)` đầu epoch (giữ tính đo-lường-được của anh) NHƯNG coi nó là **TRẦN**, và chốt sổ cuối epoch theo pro-rata cứng:
   `M_v(e) = ⌊ M_v_thô(e) × min(Q, ⌊ngân_sách(e) × Q / max(G_thô(e),1)⌋) / Q ⌋`
   ⟹ Σ M_v(e) ≤ ngân_sách(e) **theo từng epoch, chứng minh được**, không phải "trung bình dài hạn".
   User biết đầu epoch cận TRÊN của mình, biết chính xác cuối epoch. Đây là điều duy nhất tương thích với một ràng buộc BẢO CHỨNG (xem điểm 3).
3. **Sửa §5:185-186.** Một ràng buộc bảo chứng (br_q/GreenBack) là điều kiện KHẢ-THANH-TOÁN TỨC THỜI, KHÔNG phải ràng buộc trung bình. "Bám ngân sách trên trung bình trượt" đối với bảo chứng chính là dự-trữ-một-phần: vỡ ở epoch e là vỡ THẬT ở epoch e; epoch e+1 phát ít đi không phục hồi tài sản đã rút. CONTRACT phải phát biểu lại đánh đổi này trung thực trước khi hội đồng gật.

### [NGHIÊM TRỌNG] §5 cold-start: `max(tổng_trọng_số(e−1),1)` biến chia-0 thành chia-1 — phát 1001× ngân sách cho vault đầu tiên (10¹²× sau khi sửa Q); nhánh còn lại là chết-vĩnh-viễn
- **Neo:** /Users/ductiger/Projects/MAGIC/Specs/GenMAGIC-CONTRACT-Vi.md:172 (`max(tổng_trọng_số(e−1),1)`), :182 (van NHÂN — hấp thụ tại 0), :249 (§9.7 nêu nhưng không giải)
- **Mô tả:** §9 mục 7 hỏi cold-start. Trả lời: **hỏng, cả hai nhánh, và nhánh nào xảy ra phụ thuộc một hằng số spec KHÔNG hề định nghĩa.**

`max(·,1)` (§5:172) là mẫu "phòng thủ" kinh điển biến một lỗi TO TIẾNG (chia 0 → crash) thành một lỗi IM LẶNG THẢM HOẠ: mẫu số tụt từ ~10¹⁵ xuống 1, tức nhịp_gen bị nhân lên ~10¹⁵ lần mà không một cảnh báo nào.

CONTRACT KHÔNG định nghĩa BẤT KỲ giá trị khởi tạo nào cho: `nhịp_gen(−1)`, `tổng_trọng_số(−1)`, `ngân_sách_gen(0)`. §9:249 chỉ nêu vấn đề rồi để ngỏ. Hai nhánh:

**Nhánh A — van bỏ qua tại e=0 (hoặc nhịp_gen(−1) chưa có):** nhịp_gen(0) = ngân_sách(0)×Q/1 → siêu phát (số bên dưới).
**Nhánh B — nhịp_gen(−1) khởi tạo = 0:** van §5:182 là van NHÂN ⟹ nhịp_gen(0) ≤ 0 × 1.25 = 0 ⟹ nhịp_gen(1) ≤ 0 × 1.25 = 0 ⟹ **0 là trạng thái HẤP THỤ. Hệ không bao giờ sinh được MAGIC, vĩnh viễn.**

Nhánh B không chỉ là chuyện cold-start: **0 là hấp thụ ở MỌI thời điểm.** Bất cứ khi nào nhịp_gen chạm 0 (ngân sách ≤ 0 do bộ tích phân — xem finding kế; hoặc W tăng đủ mạnh để ⌊ngân_sách×Q²/W⌋ = 0), hệ khoá chết vĩnh viễn. Van nhân KHÔNG CÓ đường thoát khỏi 0.
- **Kịch bản:** ngân_sách_gen(0) = 10⁶ MAGIC = 10¹⁵ nanogic. W(−1) = 0 (chưa vault nào).

**Nhánh A, công thức như viết (×Q):**
nhịp_gen(0) = ⌊10¹⁵ × 10⁹ / max(0,1)⌋ = 10¹⁵ × 10⁹ = **10²⁴**.
Vault đầu tiên: c=1001, tư_cách = Q (sàn).
M_v = ⌊⌊1001 × 10²⁴/10⁹⌋ × 10⁹/10⁹⌋ = 1001 × 10¹⁵ = 1.001×10¹⁸ nanogic = **1.001×10⁹ MAGIC**.
Ngân sách 10⁶ MAGIC ⟹ **vượt 1001×, dồn hết vào MỘT vault, ngay epoch 0.**

**Nhánh A, sau khi sửa Q (×Q²) — TỆ HƠN:**
nhịp_gen(0) = 10¹⁵ × 10¹⁸ / 1 = 10³³.
M_v = ⌊1001 × 10³³/10⁹⌋ = 1.001×10²⁷ nanogic = **10¹⁸ MAGIC ⟹ vượt 10¹²×.**
(Lưu ý: hai lỗi ĐỘC LẬP — sửa lỗi Q làm cold-start nặng thêm 10⁹ lần. Không được sửa một cái rồi tưởng xong.)

**Nhánh B:** nhịp_gen(−1)=0 ⟹ nhịp_gen(e)=0 ∀e ⟹ G1 ("nắm LAMP là có gen") vỡ vĩnh viễn, không có redeemer/tham số nào cứu được.

**Nhánh B tái phát ngoài cold-start:** từ finding bộ-tích-phân, ngân_sách(1) = −2.5×10¹⁴ → kẹp 0 → nhịp_gen(1)=0 → van: nhịp_gen(2) ≤ 0 → **hệ chết ở epoch 2 của đời thật.**
- **Đề xuất:** 1. **XOÁ `max(·,1)`.** Thay bằng nhánh tường minh: `nếu tổng_trọng_số(e−1) == 0 thì nhịp_gen(e) = NHỊP_GEN_KHỞI_TẠO` — một HẰNG SỐ ĐƯỢC QUẢN TRỊ, hiệu chuẩn từ ngân_sách(0) và trọng số dự kiến của cohort đầu, chốt trong CONTRACT (không để dev tự đoán).
2. **Van phải là CỘNG-TÍNH hoặc có sàn, không được thuần NHÂN:** `nhịp_gen(e) ≤ max(NHỊP_GEN_SÀN, nhịp_gen(e−1) × TRẦN_TĂNG/Q)` với NHỊP_GEN_SÀN > 0. Xoá trạng thái hấp thụ tại 0. (Nếu áp cách ration-pro-rata ở finding trước thì van biến mất luôn — càng gọn.)
3. Kẹp cứng `ngân_sách_gen(e) ≥ 0` tại nguồn (xem finding bộ-tích-phân).
4. Thêm test vector cold-start bắt buộc: `W(−1)=0, ngân_sách(0)=10¹⁵ ⟹ Σ M_v(0) ≤ 10¹⁵` và `nhịp_gen(0) > 0`.

### [NGHIÊM TRỌNG] §5 bộ-điều-khiển-tích-phân "bù kỳ sau": phân kỳ khi w ≥ 2, sinh NGÂN SÁCH ÂM sau đúng 1 epoch quá phát, rồi ghép với van-nhân khoá hệ ở 0 vĩnh viễn
- **Neo:** /Users/ductiger/Projects/MAGIC/Specs/GenMAGIC-CONTRACT-Vi.md:183 (bù kỳ sau — bộ tích phân), :182 (van nhân), :172 (nhịp_gen ∝ ngân_sách), :185-186 (khẳng định "bám ngân sách trên trung bình dài hạn")
- **Mô tả:** §9 mục 3 hỏi bộ tích phân có ổn định không. **Không. Chứng minh + phản ví dụ.**

§5:183: thừa/thiếu epoch e trừ/cộng vào ngân_sách(e+1). Hình thức hoá (b = ngân sách nền, u(e) = ngân sách hiệu dụng):
Err(e) = G(e) − u(e) = u(e)·(w(e) − 1)   [dùng G(e) = u(e)·w(e), đã chứng ở finding van]
u(e+1) = b − Err(e) = b − u(e)·(w(e) − 1)

Đây là bộ tích phân THUẦN, hệ số khuếch đại = 1, trễ 1 bước, **không có anti-windup, không kẹp âm, không giảm gain** — spec không nêu bất kỳ thứ nào.

Ánh xạ tuyến tính, độ dốc = −(w−1). **Ổn định ⟺ |w−1| < 1 ⟺ w < 2.**
- w = 2: độ dốc −1 ⟹ dao động chu-kỳ-2 KHÔNG TẮT (biên ổn định).
- w > 2: |độ dốc| > 1 ⟹ **phân kỳ mũ, đổi dấu mỗi bước.** w = 2.81 ⟹ biên độ ×1.81/epoch.
- w = 1.5: hội tụ nhưng có dao động tắt dần + vọt lố.

Từ finding van: w(e) = 2.25 đạt được chỉ bằng phối hợp giờ_thấp_điểm + cam_kết_lịch (2 hệ số nhảy-1-epoch), w = 11.25 nếu thêm vault mới. **Cả hai đều > 2 ⟹ vùng phân kỳ, đạt được bằng hành vi hợp lệ, không cần khai thác lỗi nào.**

Nhưng lỗi chí mạng đến TRƯỚC cả phân kỳ: chỉ MỘT epoch với w > 2 là u(e+1) < 0. `nhịp_gen = ⌊ngân_sách × Q²/W⌋` với ngân_sách âm ⟹ **nhịp_gen âm ⟹ M_v âm ⟹ số dư MAGIC âm** (Aiken Int là số nguyên có dấu vô hạn — nhận âm không kêu; sổ off-chain §6 cũng không có bất biến chặn). Nếu ai đó kẹp về 0 thì rơi thẳng vào bẫy van-nhân: nhịp_gen = 0 ⟹ hấp thụ vĩnh viễn.

**⟹ Hai đường ra, cả hai đều là mất tiền: số dư âm, hoặc hệ chết.**
- **Kịch bản:** b = ngân_sách nền = 10⁶ MAGIC = 10¹⁵ nanogic. Dùng đúng cấu hình phản ví dụ van (1000 vault, c=1001).

**Epoch 0:** u(0) = 10¹⁵. Nhóm bật giờ_thấp_điểm+cam_kết_lịch ⟹ w(0) = 2.25.
G(0) = u(0)·w(0) = 2.25×10¹⁵ nanogic (2.25×10⁶ MAGIC — đã bị tiêu hết trong epoch 0, G9 reset).
Err(0) = G(0) − u(0) = 1.25×10¹⁵.
**Epoch 1:** u(1) = b − Err(0) = 10¹⁵ − 1.25×10¹⁵ = **−2.5×10¹⁴ nanogic. NGÂN SÁCH ÂM sau ĐÚNG MỘT epoch.**
nhịp_gen(1) = ⌊−2.5×10¹⁴ × 10¹⁸ / 2.252×10¹⁵⌋ = **−1.11×10¹⁷ (ÂM)**.
M_v(1) = ⌊⌊1001 × (−1.11×10¹⁷)/10⁹⌋ × 2.25×10⁹/10⁹⌋ ≈ **−2.5×10¹¹ nanogic ⟹ mỗi vault bị TRỪ 250 MAGIC. Spec không có mệnh đề nào cấm.**

**Nếu kẹp nhịp_gen(1) = 0:** van §5:182 ⟹ nhịp_gen(2) ≤ 0 × 1.25 = 0 ⟹ nhịp_gen(e) = 0 ∀ e ≥ 1. **Hệ chết ở epoch 2.**

**Nếu kẹp u(1) = 0 (không kẹp nhịp_gen):** Err(1) = 0 − 0 = 0, u(2) = b = 10¹⁵. Nhóm lại bật w=2.25 ⟹ lặp vô hạn chu kỳ [2.25× ngân sách, 0, 2.25× ngân sách, 0…]. **Dao động chu-kỳ-2 vĩnh viễn, biên độ 100%: một epoch siêu phát, một epoch không ai sinh được gì (G1 vỡ định kỳ).**

Kiểm chứng phân kỳ w=2.81 (không kẹp): u(0)=10¹⁵ → u(1)=−0.81×10¹⁵ → |u| ×1.81 mỗi bước ⟹ sau 10 epoch biên độ ×1.81¹⁰ ≈ 350×.
- **Đề xuất:** 1. **Kẹp cứng tại nguồn:** `ngân_sách_gen(e) = max(0, ngân_sách_nền(e) − nợ_luỹ_kế(e))` và bất biến on-chain/sổ `M_v ≥ 0 ∀v`. Số dư MAGIC âm phải là điều KHÔNG BIỂU DIỄN ĐƯỢC, không phải điều "chắc không xảy ra".
2. **Giảm gain + anti-windup:** thay bù-100%-một-kỳ bằng bù rải có hệ số: `nợ(e+1) = ⌊(nợ(e) + Err(e)) × K_I / Q⌋` với K_I ≤ 0.25Q, và kẹp `nợ ≤ NỢ_TRẦN` (vd 0.5 × b). Với K_I = 0.25, độ dốc = −0.25(w−1) ⟹ ổn định tới w < 5 thay vì w < 2.
3. **Gốc rễ:** nếu áp ration-pro-rata cứng (finding van, đề xuất 2) thì w(e) không bao giờ vượt 1 ở đầu ra ⟹ Err(e) ≤ 0 luôn ⟹ bộ tích phân chỉ còn nhiệm vụ trả LẠI phần thiếu, không bao giờ sinh nợ ⟹ **toàn bộ lớp bất ổn này biến mất.** Đây là lý do nên chọn ration thay vì van.
4. Trước khi hội đồng gật §5: CONTRACT phải ghi biên ổn định tường minh (`|K_I·(w_max−1)| < 1`) và test vector `w=3 sustained ⟹ ngân_sách ≥ 0 ∧ nhịp_gen > 0 ∀e ≤ 50`.

### [CAO] §4.3 KHÔNG THỂ tái dùng FlowRate dual-EMA: sai granularity 120× (epoch vs slot) và sai đại lượng (đo GIÁ lamp/magic, không đo CẦU)
- **Neo:** /Users/ductiger/Projects/MAGIC/Specs/GenMAGIC-CONTRACT-Vi.md:132-133 (khẳng định tái dùng) đối chiếu /Users/ductiger/Projects/MAGIC/FlowRate/offchain/src/math.ts:41 (mỗi-epoch), :47 (guard 1 mẫu/epoch), :50 (đo GIÁ lamp/magic), :5-6 (α=1/3, 1/12), :12 (MIN_MAGIC_EPOCH đóng băng), :10,:85-87 (cold-start 21 epoch); /Users/ductiger/Projects/MAGIC/FlowRate/offchain/src/types.ts:16-19 (EpochFlow = tổng epoch)
- **Mô tả:** §4.3:132-133 chốt cứng: "'Thấp điểm' xác định thế nào — tái dùng **FlowRate dual-EMA** đã có trong repo (commit 5292578d): thấp-điểm ⟺ cầu-tức-thời (EMA-nhanh) dưới cầu-nền (EMA-chậm) **tại slot tiêu**."

Đọc code thật — khẳng định này **sai ba tầng, không phải chuyện tinh chỉnh tham số**:

**(1) Sai granularity.** `updateFlowRate` là hàm mỗi-EPOCH (`math.ts:41` chú thích "called by FlowRateKeeper each epoch"; `math.ts:47` guard `if (flow.epoch <= datum.last_epoch) return datum;` — chặn cứng >1 mẫu/epoch). Đầu vào `EpochFlow` (`types.ts:16-19`) là TỔNG toàn epoch: `total_lamp_oildrop`, `total_magic_ng`, `epoch`. **Một mẫu / 432.000 slot = 1 mẫu / 5 ngày.** §4.3 cần phân loại TỪNG SLOT.

**(2) Sai đại lượng.** `math.ts:50`: `unclamped_raw = flow.total_lamp_oildrop × Q / flow.total_magic_ng` — đây là **GIÁ (LAMP trên mỗi MAGIC)**, không phải cầu. `lamp_per_magic_q` giảm khi cầu MAGIC TĂNG (cùng LAMP mua được nhiều MAGIC hơn). Dùng thẳng làm chỉ báo cầu là **đảo dấu**: EMA_fast < EMA_slow sẽ đánh dấu lúc CAO ĐIỂM là "thấp điểm". Grep toàn module FlowRate: 0 kết quả cho off-peak/peak/slot/demand.

**(3) Hằng số thời gian sai 240×.** `ALPHA_FAST_Q = Q/3` (`math.ts:5`) ⟹ hằng số thời gian ≈ 3 mẫu = **3 epoch = 15 ngày**. `ALPHA_SLOW_Q = Q/12` ⟹ 12 epoch = 60 ngày. "Giờ thấp điểm" có chu kỳ 24h. **Nyquist: với 1 mẫu/5 ngày, tần số phân giải cao nhất có chu kỳ 10 ngày. Tín hiệu 24h bị chồng phổ (aliasing) 240×.** Không tồn tại cách chỉnh tham số nào sửa được — thiếu MẪU, không thiếu lọc.

**(4) Cold-start EMA (kèm theo).** `math.ts:12` `MIN_MAGIC_EPOCH = 1000 MAGIC`: dưới ngưỡng, EMA **đóng băng** (`math.ts:43-45` trả datum nguyên, chỉ tiến epoch). Và `math.ts:85-87`: `max_rate = prev × (Q+cap)/Q` — nếu `prev = HARD_FLOOR_Q = 10⁷` (`math.ts:10`) thì rate chỉ leo tối đa +25%/epoch. Từ sàn 10⁷ lên mức thực 10⁹ cần `log(100)/log(1.25) ≈ 20.6` ⟹ **21 epoch = 105 ngày mới hội tụ.** §4.3 thừa hưởng nguyên cold-start này mà CONTRACT không hề nhắc.

⟹ §4.3 hiện là một **lời hứa suông**. "Đã có trong repo" là sai sự thật; cái có trong repo giải bài toán khác.
- **Kịch bản:** Thử dùng ĐÚNG như §4.3:132-133 nói, không sửa gì.

Epoch 100: mạng tiêu 500.000 MAGIC, tổng LAMP quy đổi 10⁶ oildrop-đơn-vị.
`updateFlowRate` chạy MỘT lần, cho ra 1 cặp (ema_fast_q, ema_slow_q) cho **toàn bộ 432.000 slot của epoch 100**.

Bây giờ §4.3 hỏi: user A tiêu tại slot 43.200.000 (3h sáng, thật sự vắng) và user B tiêu tại slot 43.243.200 (20h tối, thật sự đông). Chỉ báo trả về gì?
**CÙNG MỘT GIÁ TRỊ** — vì chỉ có 1 mẫu/epoch. tỷ_thấp_điểm của A và B **bằng nhau**. Hệ số giờ_thấp_điểm không phân biệt được 3h sáng với 20h tối. **Hệ số 1.5× trở thành hằng số toàn mạng, không mang thông tin nào.**

Tệ hơn — đảo dấu. Epoch 101 cầu MAGIC tăng gấp đôi (cao điểm thật), LAMP nạp không đổi:
raw = total_lamp × Q / total_magic ⟹ total_magic ×2 ⟹ **raw giảm một nửa**.
ema_fast (α=1/3) đuổi xuống nhanh; ema_slow (α=1/12) còn cao.
⟹ ema_fast < ema_slow ⟹ theo §4.3:133 = **"THẤP ĐIỂM" ⟹ thưởng 1.5×**.
**Chỉ báo thưởng 1.5× cho người tiêu đúng lúc cao điểm nhất. Đảo ngược hoàn toàn G8.**
- **Đề xuất:** 1. **Xoá khẳng định §4.3:132-133.** FlowRate KHÔNG dùng lại được cho §4.3. Ghi thẳng là hạng mục CHƯA CÓ, tag `[NEEDS-EVIDENCE]` — đừng để dev đọc CONTRACT rồi tưởng chỉ cần import.
2. Nếu vẫn giữ giờ_thấp_điểm thì phải đặc tả một bộ đếm MỚI, độc lập: (a) đại lượng = **cầu** (`Σ nanogic tiêu / bucket`), KHÔNG phải giá; (b) bucket ≤ 1h (≤ 3600 slot) ⟹ ≥ 120 mẫu/epoch; (c) EMA-chậm phải nắm CHU KỲ NGÀY (≥ 24 bucket) chứ không phải xu thế 60 ngày; (d) khởi tạo tường minh, không kế thừa `HARD_FLOOR_Q` của FlowRate.
3. Chi phí phải nói thẳng: sổ off-chain §6 sẽ phải giữ và neo thêm **≥120 bucket cầu/epoch** — đây là hạng mục kiến trúc mới, không miễn phí. §6 hiện chưa tính tới.
4. Cân nhắc BỎ HẲN giờ_thấp_điểm (xem finding bang-bang kế): nó vừa chưa có cơ sở đo, vừa phản tác dụng khi có.

### [CAO] §4.3 chỉ báo NHỊ PHÂN (bang-bang) KHÔNG tự cân bằng như §4.3:135 khẳng định — nó sinh chu kỳ giới hạn và làm tỷ số đỉnh/trung-bình TỆ ĐI (1.0 → 3.3)
- **Neo:** /Users/ductiger/Projects/MAGIC/Specs/GenMAGIC-CONTRACT-Vi.md:135 (khẳng định "tự cân bằng ✓ G8"), :128-129 (tỷ_thấp_điểm/giờ_thấp_điểm — chỉ báo nhị phân), :133 (ngưỡng EMA_fast < EMA_slow); tham số EMA thật: /Users/ductiger/Projects/MAGIC/FlowRate/offchain/src/math.ts:5-6
- **Mô tả:** §9 mục 5 hỏi tự-tham-chiếu EMA có cộng hưởng/dao động không. **Có. Và §4.3:135 khẳng định ngược lại — khẳng định đó sai.**

§4.3:135 viết: "Là hệ-số-điều-tiết đúng nghĩa: ai cũng dồn vào thấp-điểm ⟹ chỗ đó thành cao-điểm ⟹ hết ưu đãi ⟹ **tự cân bằng**. ✓ G8".

Lập luận này bỏ sót một bước và bước đó lật ngược kết luận. **Tự cân bằng đòi hỏi phần thưởng có GRADIENT LIÊN TỤC; §4.3 lại dùng NGƯỠNG NHỊ PHÂN.**

Chứng minh không tồn tại cân bằng thuần:
Gọi f = tỷ lệ cầu-trì-hoãn-được dồn vào cửa sổ đang được đánh "thấp điểm". Phần thưởng = +50% (§4.3:129 TRẦN_THẤP_ĐIỂM = 0.5Q), chi phí trì hoãn ≈ 0 (MAGIC dùng-hay-mất trong epoch, hoãn vài giờ không mất gì).
- f nhỏ ⟹ cửa sổ vẫn thấp điểm ⟹ mọi tác nhân lệch sang đó có lợi NGHIÊM NGẶT ⟹ f tăng. **f nhỏ không phải cân bằng.**
- f = 1 ⟹ cửa sổ thành đỉnh ⟹ KHÔNG AI được thưởng ⟹ lệch ra ngoài có lợi. **f = 1 không phải cân bằng.**
⟹ **Không tồn tại cân bằng thuần.** Cân bằng duy nhất là hỗn hợp tại EMA_fast = EMA_slow — một **lưỡi dao**. Nhưng chỉ báo là tất định và ai cũng thấy cùng thông tin ⟹ mọi tác nhân phối hợp về cùng một phía ⟹ nhảy khỏi lưỡi dao ⟹ **chattering, lật mỗi mẫu.**

Hệ quả kinh tế **ngược hẳn G8**: cơ chế lẽ ra để SAN PHẲNG cầu lại **DỒN CỤC** cầu thành các gai định kỳ. Hạ tầng (sổ off-chain §6, accumulator 10⁴ append/s/shard theo Scale-Analysis §6.2 L4) phải chịu tải đỉnh cao hơn hẳn so với khi KHÔNG có cơ chế này.

Đây là sai lầm cấu trúc, không phải chỉnh tham số: đổi TRẦN_THẤP_ĐIỂM từ 0.5Q xuống 0.1Q chỉ làm gai nhỏ đi, không xoá được tính bang-bang.
- **Kịch bản:** Mô phỏng số, dùng ĐÚNG α của FlowRate (`math.ts:5-6`): α_fast = 1/3, α_slow = 1/12.
Cầu tự nhiên (không trì hoãn được) = 100 đơn vị/bucket, PHẲNG. Cầu trì hoãn được = 100/bucket, giữ lại khi bị đánh "cao điểm", xả toàn bộ tồn khi "thấp điểm". Tác nhân dự đoán bằng EMA(k−1) (không thể dùng EMA(k) — chưa biết).
Trạng thái đầu: EMA_fast = EMA_slow = 100.

k=0: một cú sụt nhẹ r(0)=90.
  EMA_fast(0) = ⅓·90 + ⅔·100 = 96.67 ; EMA_slow(0) = 1/12·90 + 11/12·100 = 99.17
  96.67 < 99.17 ⟹ **THẤP ĐIỂM**
k=1: xả toàn bộ tồn (6 bucket × 100 = 600) + 100 tự nhiên ⟹ r(1) = 700.
  EMA_fast(1) = ⅓·700 + ⅔·96.67 = **297.8** ; EMA_slow(1) = 1/12·700 + 11/12·99.17 = **149.2**
  297.8 > 149.2 ⟹ CAO ĐIỂM ⟹ giữ lại
k=2: r=100 → fast = 231.8 ; slow = 145.1 → cao điểm, giữ
k=3: fast = 187.9 ; slow = 141.3 → cao điểm, giữ
k=4: fast = 158.6 ; slow = 137.8 → cao điểm, giữ
k=5: fast = 139.0 ; slow = 134.6 → cao điểm, giữ
k=6: fast = **126.0** ; slow = **131.7** → **THẤP ĐIỂM** ⟹ k=7 xả 700+100 = **800**
k=7: fast = ⅓·800 + ⅔·126.0 = **350.7** ; slow = 187.4 → cao điểm…

⟹ **Chu kỳ giới hạn bền vững, chu kỳ ≈ 5-6 bucket, biên độ tăng dần rồi bão hoà.**

**Đo tác hại định lượng:**
- KHÔNG có §4.3: cầu = 200/bucket phẳng ⟹ **đỉnh/trung-bình = 1.00**
- CÓ §4.3: 800 dồn vào 1 bucket, ~100 ở 4 bucket còn lại ⟹ trung bình = (800+400)/5 = 240 ⟹ **đỉnh/trung-bình = 800/240 = 3.33**

⟹ **Cơ chế "điều-tiết cung-cầu" làm tỷ số đỉnh/trung-bình xấu đi 3.3×.** Chính xác ngược mục tiêu G8 (§1:29). Và phần thưởng 1.5× trở thành xổ số theo thời điểm, không theo hành vi: hai user cùng hành vi, lệch nhau 1 bucket, một người ăn 1.5× một người ăn 1.0×.
- **Đề xuất:** 1. **Thay ngưỡng nhị phân bằng gradient liên tục** — đây là điều kiện CẦN để có cân bằng nội tại:
   `tỷ_thấp_điểm_slot = clamp(0, Q, ⌊(EMA_slow − EMA_fast) × Q / max(EMA_slow,1)⌋)`
   rồi lấy trung bình có trọng số theo lượng tiêu trên cửa sổ [e−6,e). Phần thưởng biên giảm dần khi ai cũng dồn vào ⟹ tác nhân biên bàng quan ⟹ **cân bằng nội tại tồn tại, hết chattering.**
2. **Thêm trễ + trơn:** chốt phân loại theo bucket ĐÃ ĐÓNG (không cho phản ứng trong cùng bucket) và làm trơn qua ≥3 bucket, để triệt vòng "dự đoán → xả → lật".
3. **Sửa §4.3:135.** Khẳng định "tự cân bằng ✓ G8" hiện là SAI với chỉ báo nhị phân. Nếu chuyển sang gradient liên tục thì mới viết được — và kèm mô phỏng số làm bằng chứng, không viết bằng lập luận suông.
4. **Cân nhắc bỏ hẳn §4.3.** Ghép với finding FlowRate (chưa có bộ đo): hệ số này vừa không đo được, vừa phản tác dụng khi đo được, vừa chiếm 1 trong 4 thừa số của tư_cách. Bỏ nó ⟹ dải tư_cách tụt 12.375× → 8.25×, tự động thu hẹp cả véc-tơ lạm phát §5 (w_max từ 2.25 → 1.5).

### [CAO] §3:80 "Kiểm G1 ✓" SAI về toán: floor thứ nhất ⌊c×nhịp_gen/Q⌋ = 0 khi c×nhịp_gen < Q ⟹ M_v = 0. Đó CHÍNH LÀ một cổng — thứ G1 cấm
- **Neo:** /Users/ductiger/Projects/MAGIC/Specs/GenMAGIC-CONTRACT-Vi.md:80 ("Kiểm G1 ✓" — suy luận sai), :71 (M_v, floor lồng), :77 (bắt buộc floor tuần tự), :22 (tiên đề G1 "không có cổng nào"), :118 ("cá voi không có lợi thế"); trần/sàn c: /Users/ductiger/Projects/PhoenixKeyDID/Wakeme/spec/PhoenixKey-Wakeme-Math.md:33 (D = min(1001,…), genesis ép c ∈ [1,1001])
- **Mô tả:** §3:80 khẳng định: "**Kiểm G1:** `tư_cách ≥ Q` luôn (sàn 1.0×) ⟹ `c_v > 0` ⟹ `M_v > 0`. **Nắm LAMP là có gen. Không cổng.** ✓"

**Suy luận này bỏ qua chính floor mà §3:77 vừa bắt buộc.** `tư_cách ≥ Q` và `c_v > 0` KHÔNG kéo theo `M_v > 0`, vì:

`M_v = ⌊⌊c_v × nhịp_gen(e)/Q⌋ × tư_cách_v/Q⌋`

Floor **BÊN TRONG** chạy TRƯỚC, và tư_cách không cứu được nó: nếu `c_v × nhịp_gen(e) < Q` thì `⌊c_v × nhịp_gen/Q⌋ = 0`, và `⌊0 × tư_cách/Q⌋ = 0` **với MỌI tư_cách**, kể cả 12.375×. Nhân bất cứ thứ gì với 0 vẫn là 0.

**Điều kiện cổng chính xác:** `M_v = 0 ⟺ nhịp_gen(e) < Q/c_v = 10⁹/c_v`.

Đây là một **cổng im lặng, lũy thoái** — đánh đúng người nhỏ nhất:
- c = 1 LAMP (sàn Wakeme, `genesis_vault_ok` ép `c ∈ [1,1001]`): cổng bật khi nhịp_gen < 10⁹
- c = 1001 LAMP (trần d_cap): cổng bật khi nhịp_gen < 998.002
⟹ **Vùng chết rộng gấp 1001 lần cho user nhỏ nhất so với cá voi.** Trái thẳng tinh thần §4.2:118 ("cá voi không có lợi thế", "chống giàu càng giàu").

**Với công thức §5 NHƯ ĐANG VIẾT, cổng này bật NGAY LẬP TỨC** (xem kịch bản) — không phải rủi ro lý thuyết. Sau khi sửa lỗi Q (×Q²) thì ngưỡng lùi rất xa (cần W > 10²⁴ ⟹ >8×10¹⁰ vault) — nhưng **§3:80 vẫn là một khẳng định SAI đang nằm trong CONTRACT**, và G1 là tiên đề anh chốt KHÔNG LẬT LẠI (§1:22). Một tiên đề không thể được "kiểm" bằng lập luận hỏng.
- **Kịch bản:** Dùng ĐÚNG §5:172 như đang viết (chưa sửa Q) — cấu hình khiêm tốn, không cực đoan:

1000 vault, mỗi vault c = 1001, tư_cách = Q (sàn 1.0×).
W(e−1) = 1000 × 1001 × 10⁹ = 1.001×10¹⁵.
ngân_sách_gen(e) = 10⁶ MAGIC = 10¹⁵ nanogic.
nhịp_gen(e) = ⌊10¹⁵ × 10⁹ / 1.001×10¹⁵⌋ = **999_000_999**.

Ngưỡng cổng: nhịp_gen < 10⁹/c.
- **Vault c = 1** (user nhỏ nhất, hợp lệ theo `genesis_vault_ok`):
  ⌊1 × 999_000_999 / 10⁹⌋ = ⌊0.999000999⌋ = **0**
  M_v = ⌊0 × tư_cách/10⁹⌋ = **0 nanogic.**
  Cho tư_cách = **12.375×** (tối đa tuyệt đối — tuổi 24 epoch + tiêu hết + toàn thấp điểm + full cam kết lịch):
  M_v = ⌊0 × 12.375×10⁹/10⁹⌋ = **VẪN 0.**

⟹ **Một user khoá LAMP thật, đạt tư-cách hoàn hảo 12.375×, chờ 24 epoch — nhận ĐÚNG 0 MAGIC, vĩnh viễn, không thông báo.** G1 vỡ.

- Ngưỡng chính xác: vault cần `c ≥ ⌈10⁹/999_000_999⌉ = 2` mới thoát 0. Với c=2: ⌊2×999_000_999/10⁹⌋ = ⌊1.998⌋ = 1 nanogic = 10⁻⁹ MAGIC.
⟹ **c=1 nhận 0; c=2 nhận 10⁻⁹ MAGIC.** Bậc thang nhị phân tại đúng đáy phân phối.
- **Đề xuất:** 1. **Xoá/viết lại §3:80.** Không được ghi "✓" cho một kiểm chứng sai. Mệnh đề đúng phải là điều kiện có định lượng: `M_v > 0 ⟺ ⌊c_v × nhịp_gen(e)/Q⌋ ≥ 1 ⟺ nhịp_gen(e) ≥ ⌈Q/c_v⌉`.
2. **Nếu G1 là tiên đề thật (§1:22 — anh chốt, không lật lại) thì phải ÉP nó, không phải "kiểm" nó.** Hai cách:
   (a) **Sàn cứng:** `M_v = max(1, ⌊⌊c_v × nhịp_gen/Q⌋ × tư_cách_v/Q⌋)` với mọi `c_v ≥ 1` — ép M_v ≥ 1 nanogic. Chi phí ngân sách: ≤ N_vault nanogic/epoch (10⁶ vault ⟹ 10⁻³ MAGIC/epoch — không đáng kể). Phải trừ vào ngân_sách trước khi tính nhịp_gen để không phá trần.
   (b) **Đảo thứ tự floor:** `M_v = ⌊c_v × ⌊nhịp_gen × tư_cách_v/Q⌋ / Q⌋` — nhân tư_cách vào nhịp_gen TRƯỚC khi floor theo c. Đẩy ngưỡng chết xuống 12.375× lần, nhưng KHÔNG xoá được cổng ⟹ chỉ là giảm nhẹ, không phải sửa.
   ⟹ **Khuyến nghị (a).** Chỉ (a) mới biến G1 thành bất biến kiểm được.
3. **Thêm bất biến + test vector chốt cứng:** `INV-G1-mọi-c: ∀ c_v ∈ [1,1001], ∀ tư_cách ∈ [Q, 12.375Q] ⟹ M_v ≥ 1`. Test biên bắt buộc: `c=1, tư_cách=Q, nhịp_gen=1 ⟹ M_v ≥ 1`. Test này bắt lỗi ngay hôm nay.

### [CAO] §4.4 `sinh_kỳ_vọng_6_epoch` KHÔNG được định nghĩa — một trong hai cách đọc là phương trình ẩn tự-tham-chiếu không có nghiệm-thức, phá P8 (bit-identical Aiken↔TS)
- **Neo:** /Users/ductiger/Projects/MAGIC/Specs/GenMAGIC-CONTRACT-Vi.md:143 (`sinh_kỳ_vọng_6_epoch` — dùng nhưng không định nghĩa), :144 (cam_kết_lịch), :88 (tư_cách chứa cam_kết_lịch), :113 (`đã_sinh` — ứng viên cách đọc 2), :120 (`max(·,1)` cho hồ sơ mới), :149-157 (bảng §4.5 giả định độc lập); P8: CLAUDE.md "Bit-identical math between Aiken and TypeScript (P8)"
- **Mô tả:** §4.4:143 dùng `sinh_kỳ_vọng_6_epoch` làm mẫu số nhưng **CONTRACT không định nghĩa nó ở bất cứ đâu** (không có trong §2 bảng đầu vào, không trong §3, không trong §5). Theo vai trò của tôi: mệnh đề mơ hồ ⟹ nêu chỗ mơ hồ, **không đoán**. Hai cách đọc đều dẫn tới hỏng, khác kiểu:

**Cách đọc 1 — TIẾN (đúng nghĩa đen "kỳ vọng"): MAGIC dự kiến sinh trong 6 epoch TỚI.**
⟹ **Tự-tham-chiếu thứ BA**, và khác hẳn hai cái §9 đã liệt (§9.4, §9.5): hai cái kia là hồi tiếp CÓ TRỄ (giải được bằng lặp theo epoch); cái này là **vòng ĐẠI SỐ TRONG CÙNG MỘT EPOCH** — không có trễ để gỡ.
  `cam_kết_lịch` ← `tỷ_cam_kết` ← `sinh_kỳ_vọng` ← `M_v` ← `tư_cách` ← `cam_kết_lịch`.

Hình thức hoá. Đặt x = cam_kết_lịch/Q ∈ [1, 1.5]; A = tuổi×tiêu×giờ (tích 3 hệ số kia, thang thường); E₀ = 6·c·rate·A (sinh kỳ vọng nếu x=1); K = magic_cam_kết_đang_hiệu_lực.
  E = E₀·x  và  x = 1 + 0.5·min(1, K/E) = 1 + 0.5·min(1, K/(E₀x))
Nhánh không kẹp: x² − x − 0.5K/E₀ = 0 ⟹ **x = (1 + √(1 + 2K/E₀))/2**.
(Có nghiệm dương duy nhất, hợp lệ khi K/E₀ < 1.5; K/E₀ ≥ 1.5 ⟹ kẹp x = 1.5.)

**Nghiệm TỒN TẠI và DUY NHẤT — nhưng CONTRACT không ghi phương trình, không ghi nghiệm-thức, không ghi lược đồ lặp, không ghi dung sai.** Với căn bậc hai trong số nguyên Q-format, hai đội (Aiken + TS) **chắc chắn** cho kết quả lệch. Đây là vi phạm trực diện P8 (bit-identical math) — CLAUDE.md ghi P8 là bất biến cấp giao thức. Nếu dev tự chế vòng lặp bất-động-điểm: **số vòng lặp và tiêu chí dừng khác nhau ⟹ tư_cách khác nhau ⟹ M_v khác nhau ⟹ sổ off-chain §6 và kiểm tra on-chain BẤT ĐỒNG ⟹ tx bị reject hoặc kế toán lệch.**

**Cách đọc 2 — LÙI: `sinh_kỳ_vọng_6_epoch` ≡ `đã_sinh` (§4.2:113, cửa sổ [e−6,e)).**
⟹ Hết vòng đại số. NHƯNG khi đó §4.4 mâu thuẫn với chính tên gọi của nó, VÀ tạo ghép nối mới: `cam_kết_lịch` và `tiêu_thật` dùng **CHUNG mẫu số** `đã_sinh` ⟹ hai trong bốn thừa số của tư_cách tương quan cứng, phá giả định độc lập của bảng §4.5. Với hồ sơ mới (`đã_sinh = 0`): `max(·,1)` ⟹ tỷ_cam_kết = min(Q, K×Q/1) = **Q ngay lập tức** ⟹ **cam_kết_lịch = 1.5× MIỄN PHÍ cho mọi hồ sơ mới chỉ cần cam kết K ≥ 1 nanogic.** Đây là cổng-mở cho w-spike ở §5 (xem finding van): 9000 vault mới có thể vào thẳng ở 1.5× thay vì sàn 1.0×, nâng w từ 11.25 lên 16.9.
- **Kịch bản:** **Cách đọc 1 (tiến) — phá P8, số cụ thể:**
c = 1001, rate = 10⁹ nanogic/LAMP, A = 2.2×2.5×1.5 = 8.25 (ba hệ số kia kịch trần).
E₀ = 6 × 1001 × 10⁹ × 8.25 = 4.955×10¹³ nanogic.
K = 3×10¹³ nanogic (30.000 MAGIC cam kết lịch).
K/E₀ = 0.6054.
x = (1 + √(1 + 2×0.6054))/2 = (1 + √2.2108)/2 = (1 + 1.486876…)/2 = **1.2434380…**
⟹ cam_kết_lịch = 1_243_438_0xx — **và chữ số cuối phụ thuộc HOÀN TOÀN vào cách khai căn.**

Hai cách cài đặt hợp lý, cùng "đúng", cho kết quả KHÁC NHAU:
- TS `BigInt` Newton isqrt trên `(Q² + 2KQ²/E₀)`: cho một giá trị.
- Aiken lặp bất-động-điểm 8 vòng từ x₀=Q: `x₁ = Q + ⌊min(Q, ⌊K×Q/(E₀×x₀/Q)⌋) × 0.5Q/Q⌋` … hội tụ tuyến tính ⟹ sau 8 vòng còn sai ~10⁻³ tương đối ⟹ lệch **~10⁶ đơn vị Q**.
⟹ tư_cách lệch ⟹ `M_v` lệch ⟹ **sổ off-chain §6 ≠ kiểm tra on-chain. P8 vỡ.**

**Cách đọc 2 (lùi) — 1.5× miễn phí, số cụ thể:**
Hồ sơ mới, epoch đầu: `đã_sinh = 0`.
tỷ_cam_kết = min(Q, ⌊K × Q / max(0,1)⌋) = min(10⁹, K×10⁹) = **10⁹ = Q** với mọi K ≥ 1 nanogic.
cam_kết_lịch = Q + ⌊Q × 0.5Q/Q⌋ = **1.5Q = 1.5×.**
⟹ **Cam kết 1 nanogic (10⁻⁹ MAGIC) ⟹ ăn trọn 1.5×.** Chi phí ≈ 0.
Áp vào phản ví dụ van: 9000 vault mới vào ở 1.5× thay vì 1.0× ⟹ W(e) = 2.252×10¹⁵ + 9000×1001×1.5×10⁹ = 1.577×10¹⁶ ⟹ w = 15.75 ⟹ **G(e) = 15.75× ngân sách** (thay vì 11.25×). Van vẫn không chạm.
- **Đề xuất:** 1. **CHỌN VÀ GHI RÕ cách đọc trong §4.4 — đây là việc của anh, không phải của dev.** Khuyến nghị **cách đọc LÙI** (dùng `đã_sinh` của §4.2:113), vì cách đọc TIẾN đưa một vòng đại số vào giữa một công thức tiền, đổi lấy gần như không lợi ích kinh tế nào.
2. **Nếu chọn LÙI:** đổi tên `sinh_kỳ_vọng_6_epoch` → `đã_sinh` (dùng lại đúng ký hiệu §4.2 — một tên, một nghĩa), VÀ vá `max(·,1)` cho hồ sơ mới: `tỷ_cam_kết = (đã_sinh == 0) ? 0 : min(Q, ⌊K×Q/đã_sinh⌋)` ⟹ hồ sơ mới về sàn 1.0×, đối xứng với §4.2:120 ("hồ sơ mới ⟹ tỷ_tiêu = 0 ⟹ sàn"). Ghi rõ ở §4.5 rằng `tiêu_thật` và `cam_kết_lịch` **chia chung mẫu số** ⟹ không độc lập.
3. **Nếu vẫn chọn TIẾN:** CONTRACT PHẢI ghi (a) phương trình ẩn tường minh, (b) nghiệm đóng `x = (Q + isqrt(Q² + 2KQ²/E₀))/2`, (c) **một** cài đặt isqrt chuẩn (Newton số nguyên, điều kiện dừng chốt cứng) dùng chung cả hai phía, (d) test vector cho x tại ≥5 điểm gồm 2 biên kẹp. Không có đủ 4 thứ đó thì P8 không thể giữ.
4. Trước mắt tag §4.4:143 `[NEEDS-EVIDENCE]` — đừng để dev đọc rồi tự đoán.

### [TRUNG] (a) tỷ_tiêu HỘI TỤ (chứng minh được, không phân kỳ) — nhưng bảng dải §4.5 SAI về số học: bốn hệ số KHÔNG độc lập, thưởng tuổi 2.20× thực nhận chỉ 1.77×
- **Neo:** /Users/ductiger/Projects/MAGIC/Specs/GenMAGIC-CONTRACT-Vi.md:149-157 (bảng dải §4.5 — giả định độc lập), :159-161 ("Kiểm G4 (số học)"), :114 (tỷ_tiêu — mẫu số `đã_sinh` chứa tư_cách), :111 (cửa sổ 6 epoch — triệt tiêu load-bearing), :99-101 (tuổi_LAMP dải 1.00–2.20×), :88 (tư_cách = tích 4), :172 (nhịp_gen từ W ⟹ vòng toàn cục)
- **Mô tả:** §9 mục 4 hỏi: `tỷ_tiêu = đã_tiêu/đã_sinh` tự-tham-chiếu — có hội tụ không, có điểm bất động lạ không?

**Phần 1 — TRẢ LỜI: HỘI TỤ. Không phân kỳ, không chu-kỳ-2. Chứng minh dưới. Ở trục này tôi KHÔNG tìm ra lỗi.**

*Vòng cục bộ (nhịp_gen ngoại sinh):* M = B(1+1.5ρ), ρ = T/M (T = cầu thật/epoch, B = c·rate·A).
Điểm bất động: M*² − BM* − 1.5BT = 0 ⟹ **M* = (B + √(B² + 6BT))/2** — dương, duy nhất.
Đạo hàm ánh xạ 1-trễ: g′(M*) = −1.5BT/M*² = −(M*² − BM*)/M*² = **B/M* − 1 ∈ (−1, 0)** (vì M* > B khi T > 0). |g′| < 1 ⟹ **hội tụ, dao động tắt dần.** ∎

*Vòng toàn cục (nhịp_gen phản hồi qua W — chỗ dễ vỡ hơn):* thêm trễ thứ hai DẤU DƯƠNG.
M(e) = y*·(1 + 1.5T/M̄(e−1))/(1 + 1.5T/M̄(e−2)) với y* = ngân_sách/N (điểm bất động — **độc lập với tư_cách**, đúng như thiết kế: hệ số quyết định PHẦN CHIA, không quyết định tổng).
Tuyến tính hoá, đặt λ = 1.5ρ*/(1+1.5ρ*) ∈ (0,1):
- **Nếu cửa sổ = 1 epoch:** ε(e) = −λ·ε(e−1) + λ·ε(e−2). Đa thức đặc trưng z² + λz − λ = 0. |z₋| < 1 ⟺ **λ < 0.5 ⟺ ρ* < 2/3.** Tại ρ* = 1 (đúng chế độ G4 nhắm tới!): λ = 0.6, z₋ = **−1.1306 ⟹ PHÂN KỲ, chu-kỳ-2, +13%/epoch.** Kiểm số: nhiễu +10 → −5.94 → +9.58 → −9.24 → +11.35 → −12.26 → +14.28 → −15.79 → +18.20 → −20.04 (tỷ số →1.13 ✓).
- **Nhưng cửa sổ THẬT = 6 epoch (§4.2:111) ⟹ TRIỆT TIÊU LỚN:**
  ε(e) = −(λ/6)Σ_{j=1..6}ε(e−j) + (λ/6)Σ_{j=2..7}ε(e−j) = **−(λ/6)·ε(e−1) + (λ/6)·ε(e−7)**
  Chặn tổng-hàng (Gershgorin trên ma trận companion): bán kính phổ ≤ 2λ/6 = λ/3 < **1/3**.
  ⟹ **LUÔN ổn định, biên rất rộng, với MỌI ρ* ∈ [0,1].** ∎

**Điểm phải nói thẳng:** biên ổn định này là **TÌNH CỜ, không phải thiết kế.** Nó tồn tại vì `đã_tiêu` và `đã_sinh` dùng **CÙNG một cửa sổ [e−6,e)** ⟹ hai tổng triệt tiêu nhau còn 2 số hạng. CONTRACT **không ghi đây là ràng buộc load-bearing**, không có phân tích ổn định nào. Ai đó "tối ưu" cửa sổ về 1-2 epoch (nghe rất hợp lý: "phản hồi nhanh hơn") ⟹ **rơi thẳng vào ρ* > 2/3 phân kỳ.** Đây là mìn chờ.

**Phần 2 — LỖI TÌM ĐƯỢC: bảng §4.5 cộng dồn bốn dải như thể chúng độc lập. Chúng KHÔNG.**
`tiêu_thật` là hàm **GIẢM** theo tích của ba hệ số kia — vì `đã_sinh` (mẫu số của ρ, §4.2:114) chứa đúng tích đó. Ba hệ số "trung thành/hành vi" **tự ăn mòn nhau** qua tiêu_thật.

Hai điểm mút (ρ*=0 và ρ*=1) thì bảng đúng, nên "Kiểm G4" (§4.5:159-161) **về kết luận vẫn đứng** (G4 thoả). Nhưng **toàn bộ vùng trong — nơi mọi user thật sống — thì sai**, và các con số quảng cáo cho user ("tuổi-LAMP 1.00–2.20×") không phải cái họ nhận.
- **Kịch bản:** **Bằng chứng số cho Phần 2** — hai user, chấp-nhận-giá (mạng lớn, rate ngoại sinh), **giống hệt nhau trừ tuổi**:
c bằng nhau, cầu thật T = 1000 MAGIC/epoch bằng nhau, B = c·rate = 1000.

- **User Mới** (tuổi 0 ⟹ a = 1.00×, §4.1):
  M = (aB + √(a²B² + 6aBT))/2 = (1000 + √(10⁶ + 6×10⁶))/2 = (1000 + 2645.75)/2 = **1822.9**
  ρ* = T/M = 1000/1822.9 = 0.5486 ⟹ tiêu_thật = 1 + 1.5×0.5486 = **1.823×**
- **User Già** (24 epoch = 120 ngày ⟹ a = 2.20×, trần §4.1):
  M = (2200 + √(2200² + 6×2.2×1000×1000))/2 = (2200 + √(4.84×10⁶ + 13.2×10⁶))/2 = (2200 + 4249.7)/2 = **3224.9**
  ρ* = 1000/3224.9 = 0.3101 ⟹ tiêu_thật = 1 + 1.5×0.3101 = **1.465×**

**Kết quả: 3224.9/1822.9 = 1.769×.**
⟹ **Thưởng tuổi §4.5 rao 2.20× — thực giao 1.77×. Mất 20%.** Cơ chế: tuổi đẩy M lên ⟹ `đã_sinh` lên ⟹ ρ = T/M **xuống** (0.549 → 0.310) ⟹ tiêu_thật **xuống** (1.823 → 1.465) ⟹ nuốt mất một phần thưởng tuổi. User Già đợi 120 ngày để nhận 1.77×, trong khi CONTRACT hứa 2.20×.

Trần tích 12.375× (§4.5:157) cũng vậy: chỉ đạt được tại ρ* = 1, tức **T ≥ M = 12.375·B** — chỉ user có cầu thật vượt 12× mức sinh nền. Với mọi user cầu hữu hạn, đỉnh dải **không tới được**.

**Bằng chứng số cho mìn-chờ cửa sổ:** giữ nguyên mọi thứ, chỉ đổi cửa sổ §4.2:111 từ [e−6,e) thành [e−1,e):
Tại ρ*=1: λ = 0.6, z₋ = −1.1306 ⟹ **|z₋| > 1 ⟹ phân kỳ.** Biên độ ×1.13/epoch ⟹ sau 40 epoch (200 ngày) nhiễu ban đầu 1% thành **132%** ⟹ nhịp_gen lật dấu. **Một thay đổi trông vô hại ("cho phản hồi nhanh hơn") biến hệ ổn định thành hệ phân kỳ.**
- **Đề xuất:** 1. **Ghi CỬA SỔ BẰNG NHAU thành bất biến có tên**, ngay tại §4.2: `INV-cửa-sổ-đối-xứng: đã_tiêu và đã_sinh PHẢI đo trên CÙNG cửa sổ nửa mở [e−6,e). Đổi độ dài cửa sổ = đổi biên ổn định vòng toàn cục.` Kèm 3 dòng: bán kính phổ ≤ λ/3 với cửa sổ 6; ngưỡng phân kỳ ρ* > 2/3 nếu cửa sổ = 1. **Không có dòng này, người sau sẽ tối ưu vào đúng mìn.**
2. **Sửa bảng §4.5:149-157.** Ghi rõ bốn dải là dải BIÊN (marginal), KHÔNG độc lập; `tiêu_thật` giảm theo tích ba hệ số kia. Thêm một cột "thực nhận tại ρ*≈0.55 (cầu = mức sinh nền)" bên cạnh cột dải danh nghĩa, và thay tích 12.375× bằng phát biểu đúng: **"12.375× là cận trên chỉ đạt tại ρ*=1 (cầu thật ≥ 12× mức sinh nền); user cầu hữu hạn luôn nhận ít hơn tích danh nghĩa."**
3. **Giữ "Kiểm G4" (§4.5:159-161)** — kết luận đúng, vì so tại hai điểm mút. Nhưng ghi chú rõ nó chỉ hợp lệ tại ρ*∈{0,1}, không nội suy vào vùng trong.
4. Về mặt truyền thông cho user: nếu rao "giữ LAMP 24 epoch → 2.2×" mà thực giao 1.77×, đó là rủi ro pháp lý/uy tín. Con số công bố phải là con số thực giao.

### [TRUNG] (e) Tràn số: KHÔNG có overflow (Aiken Int + BigInt đều vô hạn) — nhưng có BẪY `Number` ngược đời: tư_cách (1.24×10¹⁰) NHÌN AN TOÀN dưới 2⁵³ trong khi trung gian của nó (5.5×10¹⁸) thì không
- **Neo:** /Users/ductiger/Projects/MAGIC/Specs/GenMAGIC-CONTRACT-Vi.md:78 ("BigInt bắt buộc — cấm Number (C-OVERFLOW)" — không con số nào), :88 (tư_cách = tích 3 floor ⟹ trung gian 5.5×10¹⁸), :71 (c × nhịp_gen), :157 (tư_cách ≤ 12.375×), :171-172 (W, ngân_sách×Q); c ≤ 1001: /Users/ductiger/Projects/PhoenixKeyDID/Wakeme/spec/PhoenixKey-Wakeme-Math.md:33; P8: CLAUDE.md
- **Mô tả:** §9/(e) hỏi tràn số. Trả lời trung thực: **không có tràn cứng ở đâu cả.** Plutus V3 `Int` (Aiken) ánh xạ sang GHC `Integer` = độ chính xác vô hạn; TS `BigInt` cũng vô hạn. **Ở trục "vỡ vì tràn" tôi KHÔNG tìm ra vấn đề.**

**Bảng giá trị lớn nhất (tính đủ, dùng ràng buộc thật):**
| Đại lượng | Cận trên | Bit | So 2⁵³ = 9.007×10¹⁵ |
|---|---|---|---|
| c (Wakeme-Math:33, d_cap) | 1001 | 10 | an toàn |
| Q | 10⁹ | 30 | an toàn |
| tư_cách (§4.5:157) | 1.2375×10¹⁰ | 34 | **an toàn ← BẪY** |
| tuổi × tiêu (§4:88, trung gian 1) | 2.2e9 × 2.5e9 = **5.5×10¹⁸** | 63 | **VỠ (610×)** |
| W = Σ c×tư_cách, N=10⁶ vault | 1.24×10¹⁹ | 64 | **VỠ (1376×)** |
| W, N=10⁹ (trần dân số) | 1.24×10²² | 74 | **VỠ** |
| c × nhịp_gen (§3:71, trung gian) | ~8×10¹⁹ | 67 | **VỠ** |
| ngân_sách × Q² (§5:172 đã sửa) | 10¹⁸ × 10¹⁸ = **10³⁶** | 120 | **VỠ (10²⁰×)** |

**Bẫy chính xác — và nó ngược trực giác:** một dev kiểm tra "tư_cách tối đa = 12.375×10⁹ < 9×10¹⁵ ⟹ vừa Number thoải mái" ⟹ dùng `number` cho §4. **Kết luận đúng về KẾT QUẢ, sai về TRUNG GIAN.** `tuổi × tiêu = 5.5×10¹⁸` vượt 2⁵³ **610 lần** trước khi chia Q. Đây đúng loại lỗi mà `C-OVERFLOW`/TV-OVERFLOW-01/02 (CLAUDE.md) sinh ra để bắt — nhưng **CONTRACT §3:78 chỉ ghi một dòng "BigInt bắt buộc — cấm Number" mà không nêu MỘT con số nào**, nên người đọc không có cách nào tự kiểm.

**Tác hại thật = phá P8, không phải crash.** Sai số double không đủ lớn để lộ ra ngay (thường bị floor nuốt), nên nó **im lặng và lẻ tẻ** — dạng lỗi tệ nhất để tìm.
- **Kịch bản:** **Định lượng tần suất P8 vỡ — dựng từ ulp, không phỏng đoán:**

5.5×10¹⁸ nằm giữa 2⁶² = 4.61×10¹⁸ và 2⁶³ = 9.22×10¹⁸ ⟹ số mũ 62 ⟹ mantissa 52 bit ⟹ **ulp = 2^(62−52) = 1024**.
⟹ `tuổi × tiêu` trong `number` bị làm tròn về bội của 1024; sai số ≤ 512.

Bước kế là `⌊(tuổi×tiêu)/Q⌋` với Q = 10⁹. Kết quả LỆCH 1 ⟺ làm tròn đẩy tích qua một bội của 10⁹, tức khi `(tuổi×tiêu) mod 10⁹` rơi trong dải rộng ~1024 quanh biên.
Xác suất mỗi lần tính ≈ 1024/10⁹ ≈ **1.02×10⁻⁶**.

Số lần tính/năm: 10⁶ vault × 73 epoch/năm = **7.3×10⁷**.
⟹ Số lần lệch/năm ≈ 7.3×10⁷ × 1.02×10⁻⁶ ≈ **~75, bậc 10²/năm.**

**Mỗi lần lệch = tư_cách lệch ±1 ⟹ M_v lệch ⟹ sổ off-chain §6 ≠ giá trị Aiken tính ⟹ tx reject, HOẶC (tệ hơn) neo Merkle root một số dư mà on-chain không tái tạo được.** Bậc 10² lần/năm là đủ dày để thành sự cố vận hành thường trực, nhưng đủ thưa để **không bao giờ bị bắt bởi unit test ngẫu nhiên** — phải test đúng biên mới thấy.

Ví dụ cụ thể một cặp gây lệch: tuổi = 2_200_000_000 (trần 24 epoch), tiêu = 2_499_999_999 (ρ = Q−1).
Tích chính xác = 5_499_999_997_800_000_000. Aiken/BigInt: `⌊·/10⁹⌋ = 5_499_999_997`.
Trong `number`: tích bị ép về bội gần nhất của 1024 ⟹ tuỳ giá trị mà `⌊·/10⁹⌋` cho 5_499_999_997 **hoặc** 5_499_999_998. **Bit-identical vỡ ngay tại một cặp đầu vào hoàn toàn hợp lệ, nằm đúng ở biên trần mà user tối ưu sẽ nhắm tới.**
- **Đề xuất:** 1. **Thay §3:78 bằng bảng cận-trên có SỐ** (bảng ở trên), cột cuối ghi rõ "vượt 2⁵³ bao nhiêu lần". Một dòng "cấm Number" không neo số thì không kiểm chứng được và sẽ bị bỏ qua.
2. **Thêm test vector biên bắt buộc** vào `tests/vectors.ts` (theo chuẩn TV-OVERFLOW-01/02 đã có):
   - `TV-OVERFLOW-TUCACH`: `tuổi=2_200_000_000, tiêu=2_499_999_999, giờ=1_500_000_000, cam=1_500_000_000` ⟹ chốt cứng tư_cách kỳ vọng. Cài `number` là **hỏng ngay**.
   - `TV-OVERFLOW-W`: `N=10⁶, c=1001, tư_cách=12.375e9` ⟹ W = 1.2387×10¹⁹.
   - `TV-OVERFLOW-NHIP`: `ngân_sách=10¹⁸, Q²=10¹⁸` ⟹ trung gian 10³⁶ (120 bit).
3. **Ghi rõ `ngân_sách × Q² = 10³⁶ (120 bit)` là số hạng lớn nhất toàn giao thức.** Không tràn Plutus Integer, nhưng **tốn ExUnit** — nếu nhịp_gen được kiểm on-chain thì phải đo ExUnit thật trước khi chốt (§5 hiện không nói nhịp_gen được kiểm on-chain hay chỉ công bố off-chain ⟹ `[NEEDS-EVIDENCE]`).
4. Đặt trần tường minh cho `ngân_sách_gen` và `N_vault` trong CONTRACT — hiện cả hai **không có cận trên nào**, nên bảng trên phải dùng giả định của tôi (10⁹ MAGIC, 10⁹ vault) thay vì hằng số spec.

**Đã điểm qua:** Đã đọc Forall v10. Đã đọc đủ 4 nguồn chuẩn + FlowRate math.ts/types.ts. KHÔNG dùng bất kỳ khái niệm nào trong danh sách RÁC LỖI THỜI (UM/PM/LF/B/profile/halving/VacuumGen/TWAB/cổng-tiêu-thật/trung-bình-7-epoch/InstantGen-kiểu-mua/MAGIC-native-token). Không đọc Legacy/.

═══ §9 CÁC MỤC ĐƯỢC GIAO ═══

**§9 mục 3 (trễ-một-epoch §5: van 1.25× + bù kỳ sau có chặn vượt ngân sách không?)** — CÓ VẤN ĐỀ, NẶNG NHẤT. 2 finding NGHIÊM TRỌNG:
· Van gác SAI BIẾN. Chứng minh: G(e) = ngân_sách(e) × W(e)/W(e−1) ⟹ độ vượt = ĐÚNG tỷ số tăng trọng số w(e), mà van không đụng tới W. Tệ hơn: W tăng ⟹ nhịp_gen GIẢM ⟹ van (chỉ chặn chiều tăng) không bao giờ kích hoạt trong đúng kịch bản nó sinh ra để chặn. Phản ví dụ: 1125% vượt ngân sách, van đo 1.00 < 1.25, không chạm. ⟹ §5:185-186 ("có chặn trên cứng theo epoch") là SAI.
· Bộ tích phân bù-kỳ-sau: u(e+1) = b − u(e)(w(e)−1). Độ dốc −(w−1) ⟹ phân kỳ khi w ≥ 2 (w=2 là chu-kỳ-2 không tắt). Đạt w=2.25 chỉ bằng 2 hệ số nhảy-1-epoch (giờ_thấp_điểm + cam_kết_lịch) ⟹ ngân sách ÂM sau ĐÚNG 1 epoch ⟹ nhịp_gen âm ⟹ M_v âm; kẹp 0 thì van-NHÂN khoá 0 vĩnh viễn. Không anti-windup, không kẹp âm, không giảm gain.
· Điểm sâu nhất: dưới G9 (dùng-hay-mất) MAGIC vượt phát đã bị TIÊU trong chính epoch đó. Ràng buộc BẢO CHỨNG là điều kiện khả-thanh-toán TỨC THỜI — không thể thoả "trên trung bình". Đề xuất thay van bằng ration pro-rata cứng cuối epoch (giữ tính đo-lường-được, chặn được từng epoch, và triệt luôn bất ổn tích phân).

**§9 mục 4 (tỷ_tiêu tự-tham-chiếu: hội tụ? điểm bất động lạ?)** — **KHÔNG tìm ra phân kỳ. HỘI TỤ, đã chứng minh.**
· Vòng cục bộ: M* = (B+√(B²+6BT))/2, g′(M*) = B/M* − 1 ∈ (−1,0) ⟹ hội tụ, dao động tắt dần.
· Vòng toàn cục (qua W → nhịp_gen): với cửa sổ 6, ε(e) = −(λ/6)ε(e−1) + (λ/6)ε(e−7) ⟹ bán kính phổ ≤ λ/3 < 1/3 ⟹ LUÔN ổn định, biên rộng, mọi ρ*.
· Điểm bất động y* = ngân_sách/N — độc lập tư_cách (đúng thiết kế: hệ số quyết PHẦN CHIA, không quyết tổng). Không có điểm bất động lạ.
· NHƯNG tìm ra 2 thứ (1 finding TRUNG): (i) biên ổn 

### [NGHIÊM TRỌNG] §2 "c không khai man được vì Wakeme đã ép L==c×oil" là SAI — (SỔ-VALUE) là bất biến CHUYỂN-TRẠNG-THÁI, không phải bất biến TRẠNG-THÁI. Không có neo danh tính vault nào trong CONTRACT.
- **Neo:** Specs/GenMAGIC-CONTRACT-Vi.md:53,74 (+ §2:41,48) ↔ PhoenixKey-Validator/lib/phoenixkey/activation_logic.ak:655-703 @3d5fdce (genesis_vault_ok)
- **Mô tả:** CONTRACT §2:53 tuyên "Bất biến bắc cầu (miễn phí, không cần engine kiểm): Wakeme đã ép L(vault) == c × oil_per_lamp ⟹ c không khai man được" và §2:74 chỉ thị "c_v = conditional_lamp — đọc thẳng datum". Cả hai sai. `L == c×oil` chỉ được ép KHI VALIDATOR CHẠY, tức khi có người spend vault. Một UTxO chưa ai spend thì KHÔNG validator nào kiểm nó — và địa chỉ vault là script address, ai cũng trả tiền vào được. Nặng hơn: cả 7 tham số validator (kể cả `lamp_policy` VÀ `anchor_nft_policy`) là apply-param do người deploy chọn, còn policy vault-NFT ≡ script-hash của chính instance ⟹ một instance tự deploy sinh ra vault TỰ-NHẤT-QUÁN hoàn hảo mà 0 LAMP thật. CONTRACT không có MỘT chữ nào về kiểm script-hash / NFT / policy LAMP (grep `nft|script.?hash|policy|address|apply.?param` trên toàn CONTRACT chỉ ra §2:45 mô tả và §2:57 — không có mệnh đề kiểm nào).
- **Kịch bản:** ĐÃ VERIFY THỰC THI (aiken 1.1.21, code v5 canonical 3d5fdce, test `poc1_fake_lamp_policy_genesis_passes` PASS trong 217/217).

BIẾN THỂ (i) — UTxO thuần, giá 2 ADA, KHÔNG cần gì cả: attacker gửi 1 output tới đúng địa chỉ vault canonical, inline datum 7-field {owner_commit:X, did_commit:X, vest_start_slot:<bất kỳ>, conditional_lamp: 10^12, 0, 0, −1}, KHÔNG NFT, KHÔNG LAMP. Không ai spend ⟹ không validator nào chạy ⟹ (SỔ-VALUE) không hề được kiểm. Engine "đọc thẳng datum" → c = 10^12. §5:171 tổng_trọng_số(e) = Σ_v (c_v × tư_cách_v): mạng thật ~10^6 vault × 1001 LAMP × ~2×10^9 ≈ 2×10^18; vault ma = 10^12 × 12.375×10^9 ≈ 1.2×10^22 ⟹ attacker chiếm 99,98% ngân_sách_gen. Đổi c = 10^24 → nhịp_gen = ⌊ngân_sách × Q / 10^33⌋ = 0 ⟹ TOÀN MẠNG gen = 0 (van 1.25× §5:182 chỉ chặn TĂNG, không chặn sập). Giá: 2 ADA.

BIẾN THỂ (ii) — PARAM-SUBSTITUTION, đánh gục cả cách vá "kiểm có NFT đúng policy" (ĐÃ CHẠY THẬT): attacker copy activation_vault.ak, apply-param `lamp_policy = <policy token rác họ tự mint vô hạn>`, `lamp_name = "LAMP"` (CÙNG TÊN). Mint 1001×10^6 token rác (giá 0). Chạy GenesisVault → `genesis_vault_ok` PASS: `lamp_locked = quantity_of(value, lamp_fake, "LAMP") = 1001×10^6 == 1001 × oil` ✓, `only_expected_policies` ✓ (vì lamp_policy CHÍNH LÀ token rác). Vault thu được GIỐNG HỆT vault thật về cấu trúc: NFT policy == script-hash của chính địa chỉ nó, name == owner_commit == did_commit, datum đúng khuôn, L==c×oil tự-nhất-quán — mà 0 LAMP canonical (test khẳng định `lamp_in(value, lamp_canon, "LAMP") == 0`). Vì `anchor_nft_policy` CŨNG là apply-param, attacker đặt anchor policy giả ⟹ không cần cả DID thật lẫn LAMP thật. Lặp vô hạn (đổi keeper_pkh → hash khác → "instance" khác).
- **Đề xuất:** Sửa §2:53 — XOÁ "miễn phí, không cần engine kiểm". Thay bằng nghĩa vụ BẮT BUỘC của engine, cho MỖI vault đọc: (1) `address.payment_credential == Script(H_did)` với H_did = hash apply-param CANONICAL tự tính lại cho DID đó (7 param hằng hệ) — KHÔNG suy ra từ datum, KHÔNG tin địa chỉ tự khai; (2) `quantity_of(value, H_did, owner_commit) == 1`; (3) TỰ ĐO `L = quantity_of(value, LAMP_POLICY_CANONICAL, LAMP_NAME_CANONICAL)` và dùng `c_dùng = min(c_datum, L/10^6)` — không bao giờ tin c trong datum; (4) ép `1 ≤ c ≤ 1001` (biên I-ACT-6 chỉ đúng cho UTxO đã thật sự qua genesis_vault_ok); (5) reject nếu >1 UTxO thoả (xem finding I-ACT-10). Mắt xích khoá của cả lớp phòng thủ này là test "Apply-param determinism: cùng DID → cùng script-hash + address" — Wakeme-Tech §8:478 đang liệt nó là CHƯA CÓ. Nâng lên BLOCKER trước Gen production.

### [NGHIÊM TRỌNG] `vest_start_slot` KHÔNG bị ràng buộc ở genesis ⟹ tuổi-LAMP §4.1 bịa được (2.20× miễn phí); chiều tương-lai cho tuổi_epoch ÂM ⟹ thủng sàn Q ⟹ trọng số ÂM ⟹ `max(·,1)` §5 biến thành kíp nổ siêu lạm phát
- **Neo:** PhoenixKey-Validator/lib/phoenixkey/activation_logic.ak:655-703 @3d5fdce (không có mệnh đề vest_start_slot) ↔ Specs/GenMAGIC-CONTRACT-Vi.md:98-99 (§4.1) + :91 ("Mỗi thành phần có sàn Q") + :171-172,182 (§5)
- **Mô tả:** `genesis_vault_ok` ép name/c/r/td/te/did_commit/lamp_locked/anchor — nhưng KHÔNG có MỘT mệnh đề nào chạm `vest_start_slot`; nó thậm chí không đọc `tx_lo` ở mint-gate. Tech §2.1:121 ghi "Khởi tạo (Genesis): `now` (slot submit)" — đó là quy ước BACKEND, không phải bất biến. I-ACT-1 (Math §4:118) liệt kê khuôn genesis cũng BỎ SÓT vest_start_slot. GenMAGIC §4.1 dựng toàn bộ hệ số tuổi-LAMP trên đúng field bịa được này, và công thức `tuổi_LAMP = Q + min(tuổi_epoch, TRẦN_TUỔI) × BƯỚC_TUỔI` chỉ kẹp TRÊN — KHÔNG có `max(0, ·)`.
- **Kịch bản:** ĐÃ VERIFY THỰC THI — `poc4a_vest_start_in_past_unconstrained` PASS, `poc4b_vest_start_in_future_unconstrained` PASS (aiken, code v5 canonical 3d5fdce).

(a) TUỔI GIẢ, MIỄN PHÍ: now ≈ slot 150.000.000. Đúc vault đặt `vest_start_slot = 150.000.000 − 10.368.000` (lùi đúng 24 epoch = 120 ngày). genesis PASS (đã chạy). GenMAGIC §4.1: tuổi_epoch = 24 → tuổi_LAMP = Q + 24×0,05Q = 2,20× = TRẦN, ngay lúc vault vừa đúc. Không mất gì: n = 120 ≤ 1001 ⟹ vẫn Daily; `last_tick_day = 0 < 120` nên Reclaim vẫn chạy bình thường. ⟹ §4.1 "đơn điệu tăng ngặt theo tuổi" + "vault >6 epoch LUÔN > vault ít epoch hơn" bị vô hiệu hoàn toàn: mọi vault mới mua được trần tuổi với giá 0.

(b) SIÊU LẠM PHÁT — MỘT vault, MỘT LAMP: đặt `vest_start_slot = 10^18`. genesis PASS (đã chạy). §4.1 không clamp dưới ⟹ tuổi_epoch = ⌊(1,5×10^8 − 10^18)/432.000⌋ ≈ −2,3×10^12 ⟹ tuổi_LAMP = 10^9 − 2,3×10^12 × 5×10^7 ≈ −1,16×10^20 ⟹ THỦNG "sàn Q" mà §4:91 dùng để chứng G1. Với c = 1 (đúng 1 LAMP): trọng số = 1 × (−1,16×10^20) ≈ −1,16×10^20. Tổng mạng thật chỉ ~2×10^18 ⟹ MỘT vault này kéo `tổng_trọng_số(e)` xuống ÂM ⟹ `max(tổng_trọng_số(e−1), 1)` — vốn đặt để chống chia-0 — trả về 1 ⟹ `nhịp_gen(e) = ngân_sách_gen × Q / 1` = astronomically large ⟹ MỌI vault trung thực mint MAGIC không chặn. Van cứng §5:182 (`nhịp_gen(e) ≤ nhịp_gen(e−1) × 1,25`) CHỈ làm chậm: 1,25^73 ≈ 3×10^7 lần sau 1 năm — và vault này BẤT TỬ vì `days_elapsed` clamp 0 (activation_logic.ak:167-174) ⟹ `n = 0` vĩnh viễn ⟹ guard `n ≥ grace_days` của reclaim_ok FAIL mãi mãi ⟹ anti-idle không bao giờ dọn được nó. Giá: 1 LAMP.
- **Đề xuất:** GenMAGIC TỰ VÁ ĐƯỢC NGAY, không cần chờ PhoenixKey (làm cả 3): (1) §4.1 kẹp HAI ĐẦU: `tuổi_epoch = max(0, min(⌊(slot_now − vest_start_slot)/slots_per_epoch⌋, TRẦN_TUỔI))`; (2) ép sàn sau khi nhân: `tư_cách = max(Q, tích_4_thành_phần)` — §4:91 đang tuyên sàn Q như một tính chất mà KHÔNG ép ở đâu; (3) §5 dùng `tổng_trọng_số(e) = Σ_v max(0, c_v × tư_cách_v)` và thêm trần tuyệt đối cho nhịp_gen (van 1,25× chỉ là chặn tốc độ, KHÔNG phải trần — cùng mẫu lỗ ORACLE-NỘI KHÔNG-CAP ρ). BÁO PhoenixKey (Wakeme là repo backend, KHÔNG tự sửa): `genesis_vault_ok` phải ép `d.vest_start_slot == tx_lo` (hoặc ∈ [tx_lo, tx_hi]) — hiện mint-gate chưa đọc tx_lo; và bổ sung vest_start_slot vào khuôn I-ACT-1 (Math §4:118).

### [CAO] I-ACT-10 (1 DID = 1 vault) KHÔNG tồn tại on-chain. §2:57 dựa vào một bất biến không có thật — và Math.md tự mâu thuẫn với chính comment trong code
- **Neo:** Specs/GenMAGIC-CONTRACT-Vi.md:57 ↔ Wakeme/spec/PhoenixKey-Wakeme-Math.md:130 (tuyên) vs :205 (tự bác) ↔ activation_logic.ak:282-284 + :655-703 @3d5fdce ↔ Wakeme/spec/PhoenixKey-Wakeme-Tech.md:393 (gate chỉ ở backend)
- **Mô tả:** CONTRACT §2:57 khẳng định "1 DID = 1 vault (I-ACT-10, vault-NFT singleton name = owner_commit) ⟹ KHÔNG THỂ Sybil đa-vault trên cùng DID". Math.md:130 hậu thuẫn: "I-ACT-10 (1-DID-1-vault) ép qua `owner_commit == did_commit == name` ở `genesis_vault_ok`". Đọc code: genesis_vault_ok ép ba field BẰNG NHAU — nó KHÔNG ép DUY NHẤT. Không tiêu UTxO one-shot, không thread uniqueness, không đọc state nào. Chính Math.md:205 tự bác lại ("owner_commit là field datum do người đúc chọn, genesis KHÔNG ép duy-nhất"), và comment trong code nói y hệt tại activation_logic.ak:282-284. Gate duy nhất là precondition BACKEND `VAULT_ALREADY_EXISTS`(1350) — off-chain, thuộc giả-định-tin-cậy chứ không phải bất biến. Và genesis KHÔNG kiểm LAMP đến TỪ POT — chỉ ép `lamp_locked == c × oil` trong output ⟹ tự cầm LAMP của mình đúc vault, permissionless, không cần backend.
- **Kịch bản:** ĐÃ VERIFY THỰC THI — `poc2_two_vaults_same_did_both_pass` PASS: hai tx genesis KHÁC NHAU (khác tx-id), CÙNG name = CÙNG owner_commit = CÙNG DID, cả hai đều PASS `genesis_vault_ok`.

Kịch bản: chủ DID X (1 DID thật, 1 anchor thật, sinh-trắc thật — T-3/D2 KHÔNG chặn được vì đây không phải Sybil DID) có 10.010 LAMP mua trên thị trường. Tự đúc 10 vault trên CÙNG DID X, mỗi vault c = 1001, tự bơm LAMP của mình, chỉ cần chữ ký controller của chính họ. Không đụng pot, không đụng backend, không qua endpoint 1a. ⟹ D-cap 1001 (I-ACT-6) — vốn là trần LAMP PER-PERSON — không còn ràng gì.

Sát thương lên GenMAGIC, hai lớp:
(1) Engine code theo đúng §2:57 (được CONTRACT cho phép giả định 1 vault/DID) sẽ đọc MỘT vault. Vault nào? Không định nghĩa. §6:212 shard "theo hash(did_commit) ⟹ số dư 1 DID do đúng 1 shard giữ" và §4.2 quy `đã_tiêu`/`đã_sinh` theo hồ sơ did_commit ⟹ mẫu số `tỷ_tiêu = đã_tiêu/đã_sinh` tính trên 1 vault trong khi tử số gom cả 10 ⟹ `tỷ_tiêu` vọt lên, bị kẹp `min(Q, ·)` = 1,0 ⟹ tiêu_thật = 2,50× TRẦN miễn phí dù thực tế chỉ tiêu 10% lượng sinh.
(2) THỪA HƯỞNG HỒ SƠ: 3/4 thành phần tư_cách (tiêu_thật 2,50× · giờ_thấp_điểm 1,50× · cam_kết_lịch 1,50× = 5,63×) là per-DID, chỉ tuổi-LAMP là per-vault. ⟹ vault #11 đúc hôm nay ăn NGAY 5,63× của hồ sơ đã chín, không cần một epoch lịch sử nào. Ghép với finding vest_start_slot (lùi 24 epoch → 2,20×): vault mới toanh đạt 2,20 × 5,63 = 12,375× = ĐÚNG TRẦN TUYỆT ĐỐI của §4.5, ngay từ epoch đầu tiên.
- **Đề xuất:** Sửa §2:57 — hạ "1 DID = 1 vault" từ BẤT BIẾN xuống GIẢ-ĐỊNH-TIN-CẬY off-chain, và đưa vào bảng §7 cạnh D2 (chủ: PhoenixKey backend). Engine PHẢI gom TẤT CẢ vault theo did_commit (`đã_sinh` = Σ trên mọi vault của DID; §5 cộng mọi vault) — tuyệt đối không giả định 1. Cân nhắc: tư_cách nên tính per-DID rồi áp cho tổng Σc_v của DID đó, thay vì per-vault, để chặn hẳn lớp (2). BÁO PhoenixKey: mẫu uniqueness thread đã có sẵn trong repo (lib/phoenixkey/pa2_uniqueness_logic.ak) — nhưng cảnh báo bẫy circular apply-param đã ghi nhận ở PA2 (taad ↔ uniqueness_thread bake hash lẫn nhau = không có fixed point).

### [CAO] "Đọc qua reference_input" (§2:41, §6:208) KHÔNG cho bảo đảm on-chain nào — vì chính §6:197 nói gen có 0 giao dịch L1. Mượn chữ của Wakeme-Tech nhưng đổi nghĩa từ chống-hot-UTxO thành an-ninh.
- **Neo:** Specs/GenMAGIC-CONTRACT-Vi.md:41,208 + :197-198 (§6, "0 giao dịch L1 cho gen") ↔ Wakeme/spec/PhoenixKey-Wakeme-Tech.md:266 (nguyên văn: bàn về hot-UTxO, không phải an ninh)
- **Mô tả:** reference_input là MỘT TRƯỜNG CỦA GIAO DỊCH. §6:197 tuyên "TRONG EPOCH (0 giao dịch L1 cho gen)" — không có tx ⟹ không có reference_input ⟹ không có validator chạy, không có kiểm phase-1 "UTxO còn sống", không có gì hết. Cái engine thực sự làm là truy vấn chain-state off-chain qua indexer. Wakeme-Tech §3.6:266 dùng câu "reference-input là điều kiện sống còn" để nói về CHỐNG HOT-UTXO CONTENTION (hoàn toàn đúng, đó là bài toán eUTXO). CONTRACT §2:208 mượn nguyên câu đó, trích dẫn đúng nguồn, nhưng dùng nó như thể là cơ chế AN NINH bảo chứng cho `c`. Hai chuyện khác hẳn nhau. Đây chính là chỗ trống mà finding #1 đâm thủng: khi không validator nào chạy, toàn bộ bảo đảm về `c` rơi về code indexer — thứ CONTRACT không đặc tả một dòng nào.
- **Kịch bản:** Hệ quả kiểm chứng được bằng phản chứng: nếu "reference_input" thật sự bảo chứng `c`, thì UTxO 2-ADA datum-bịa ở finding #1 phải bị chặn. Nó không bị chặn — vì không có tx nào, không có validator nào, không có luật ledger nào áp lên một UTxO đứng yên. Cụ thể hoá: engine chạy `queryUtxosByAddress(vault_addr)` lúc 14:00 epoch e. Ledger không hề biết cuộc gọi đó tồn tại; không ai xác nhận UTxO đó hợp lệ, không ai xác nhận nó chưa bị tiêu lúc 14:00:01, không ai xác nhận datum của nó từng qua genesis_vault_ok. Bảo đảm on-chain thu được = 0. So sánh: một tx THẬT có `reference_inputs: [vault_ref]` thì ledger CÓ ép vault_ref phải tồn tại và chưa bị tiêu tại thời điểm validate (phase-1) — đó là bảo đảm thật, nhưng thiết kế hiện tại không có tx nào để hưởng nó.
- **Đề xuất:** Viết lại §2:41 + §6:208 nói thẳng: "engine đọc chain-state OFF-CHAIN qua indexer; `reference_input` chỉ có nghĩa (và chỉ cho bảo đảm) BÊN TRONG một tx thật — trong thiết kế này là tx settlement/anchor cuối epoch". Mọi bảo đảm về `c` phải được phát biểu lại thành NGHĨA VỤ CỦA INDEXER (đúng danh mục 5 mục ở fix của finding #1) chứ không phải hệ quả của ledger. Nếu muốn bảo đảm on-chain thật: neo `c` vào tx anchor cuối epoch — đọc vault bằng reference_input THẬT trong tx settlement, lúc đó chữ "reference_input" mới đúng nghĩa và mới có phase-1 bảo vệ.

### [CAO] Thời điểm lấy mẫu `c_v` / `slot_now` / `tổng_trọng_số` không được định nghĩa ⟹ §5 "user tự tính chính xác" là sai; keeper lái được M_v; sổ off-chain không thể bit-exact
- **Neo:** Specs/GenMAGIC-CONTRACT-Vi.md:71,74 (§3) + :98 (§4.1 `slot_now`) + :171,176-177 (§5) ↔ activation_logic.ak:374-427 (reclaim_ok, c−1/NGÀY) + :490-539 (reclaim_epoch_ok, c−q/epoch) @3d5fdce
- **Mô tả:** §3:71 viết `M_v(e) = ⌊⌊c_v × nhịp_gen(e)/Q⌋ × tư_cách_v(e)/Q⌋` mà không nói `c_v` lấy tại slot nào. Nhưng `c` là biến TRÔI trong epoch: reclaim_ok trừ 1 LAMP MỖI NGÀY (5 lần/epoch), reclaim_epoch_ok trừ tới 5 LAMP/epoch. Tương tự §4.1 dùng `slot_now` không định nghĩa, và §5:171 `tổng_trọng_số(e)` cộng c_v của ~10^6 vault đang trôi. §5:176-177 dựa vào đây để khẳng định "trong epoch, mọi user TỰ TÍNH CHÍNH XÁC M_v của mình" (dẫn lời anh: "để user có thể đo lường") — khẳng định này không đứng được.
- **Kịch bản:** Vault idle, c = 100 đầu epoch e. Keeper chạy job anti-idle NGÀY (Tech §4.3:338-343) ⟹ trong 5 ngày của epoch: c = 100 → 99 → 98 → 97 → 96. M_v(e) dùng cái nào? Chênh 4% giữa lấy đầu và lấy cuối epoch. Tệ hơn: keeper là actor TIN-CẬY off-chain (T-1) và tự chọn giờ submit Reclaim trong ngày ⟹ keeper dịch được M_v của bất kỳ user nào bằng cách sớm/muộn vài giờ, không cần vi phạm bất kỳ guard on-chain nào (reclaim_ok chỉ ép `n > last_tick_day`, không ép giờ). ⟹ §5:176 "user tự tính chính xác" sai: c_v của chính user phụ thuộc keeper.

Sát thương hệ thống: hai engine/shard đọc lệch nhau vài slot ⟹ hai `tổng_trọng_số(e−1)` khác nhau ⟹ hai `nhịp_gen(e)` khác nhau ⟹ hai M_v khác nhau cho cùng một user. Sổ off-chain §6 không đối chiếu được — trong khi PhoenixKey-MAGIC-Vault-Scale-Analysis.md §6.3 (T-RECONCILE) đòi "kế toán cân bằng BIT-EXACT (nanogic)" làm pass-condition. Không có slot chuẩn thì T-RECONCILE không thể pass theo định nghĩa.
- **Đề xuất:** Chốt NORMATIVE vào §3 + §5: `c_v`, `slot_now`, và `tổng_trọng_số` đều lấy tại MỘT slot cố định duy nhất — đề xuất slot cuối cùng của epoch e−1, sau khi đã qua k_finality (Scale-Analysis §6.2 mục L7 khuyến nghị k=5 chuẩn / k=36 archival, tránh reorg đổi nhịp_gen sau khi đã công bố). Đây cũng chính là điều kiện để §5 "công bố ĐẦU epoch e" có nghĩa và để §5:176 "user tự tính chính xác" trở thành đúng. Ghi thêm: `tuổi_epoch` phải tính từ cùng slot chuẩn đó, không phải "slot_now" trôi.

### [CAO] GenDrip KHÔNG đòi chữ ký + find_vault_output chỉ khớp payment_credential ⟹ bất kỳ ai đổi được địa chỉ đầy đủ của vault người khác ⟹ engine mất dấu vault, nạn nhân mất sạch gen, giá 1 phí tx
- **Neo:** PhoenixKey-Validator/validators/activation_vault.ak:126-134 @3d5fdce (nhánh GenDrip, không mệnh đề chữ ký) + lib/phoenixkey/activation_logic.ak:591-615 (gen_drip_ok) + :221 (chỉ payment_credential) ↔ Specs/GenMAGIC-CONTRACT-Vi.md:209 (§6: "GenDrip chỉ dùng nếu buộc phải spend")
- **Mô tả:** Nhánh `GenDrip` ở validator (activation_vault.ak:126-134 @3d5fdce) gọi thẳng `gen_drip_ok` — hàm này (activation_logic.ak:591-615) KHÔNG nhận `keeper_signed` lẫn `owner_signed`, và toàn bộ 8 mệnh đề của nó không có mệnh đề chữ ký nào. `owner_signed`/`keeper_signed` được tính ở validator (dòng 118-122) nhưng nhánh GenDrip KHÔNG dùng tới. ⟹ spend permissionless. Ghép với `find_vault_output` (activation_logic.ak:221) lọc bằng `o.address.payment_credential == Script(own_policy)` — CHỈ payment credential, `stake_credential` hoàn toàn tự do và gen_drip_ok cũng không kiểm địa chỉ. Đây đúng là cái hot-UTxO mà Wakeme-Tech §3.6:266 nói phải tránh, nhưng cửa vẫn mở.
- **Kịch bản:** ĐÃ VERIFY THỰC THI — `poc3_gendrip_moves_vault_to_attacker_stake_cred` PASS: tx với `extra_signatories: []` (KHÔNG ai ký), vault tái tạo ở CÙNG payment_credential nhưng `stake_credential = Inline(VerificationKey(deadbeef…))` của attacker → `find_vault_output` VẪN tìm thấy → `gen_drip_ok` PASS.

Kịch bản: attacker spend vault của victim bằng redeemer GenDrip, không cần chữ ký của victim, keeper, hay ai cả. Tái tạo output: cùng payment_credential, cùng datum, cùng LAMP, cùng NFT — nhưng stake_credential của attacker. Validator chấp nhận (đã chạy thật). Vault vẫn hợp lệ 100%, nội dung y nguyên, `c` không đổi (I-ACT-7 KHÔNG bị vi phạm) — nhưng ĐỊA CHỈ BECH32 ĐÃ ĐỔI. Engine tra vault theo địa chỉ đầy đủ (cách tự nhiên nhất, và §2 không hề chỉ dẫn khác) ⟹ không thấy ⟹ c = 0 ⟹ victim mất TOÀN BỘ gen MAGIC. Attacker lặp lại vô hạn mỗi lần bị sửa. Chi phí: ~0,2 ADA/lần.

Hai sát thương phụ: (a) attacker ăn staking reward của min-ADA vault (nhỏ, ~2 ADA/vault, nhưng × 10^6 vault); (b) mỗi lần spend đổi UTxO-ref ⟹ mọi tx đang dựng tham chiếu vault đó chết — kể cả tx Reclaim của keeper (Tech §4.3) và mọi tx settlement dùng reference_input THẬT ⟹ grief keeper-liveness ~0,2 ADA/block.
- **Đề xuất:** GenMAGIC tự vá NGAY (ghi vào §2): engine index vault theo cặp (payment_credential, vault-NFT), TUYỆT ĐỐI KHÔNG theo địa chỉ bech32 đầy đủ. BÁO PhoenixKey (Wakeme = backend, không tự sửa — tạo Issue): (1) `gen_drip_ok` ép `vault_out.address == own_input.output.address` (đầy đủ, không chỉ payment_credential); (2) gate GenDrip bằng `keeper_signed ∨ owner_signed` — theo chính §6:209 CONTRACT thì GenDrip "chỉ dùng nếu buộc phải spend", để nó permissionless là bề mặt tấn công thuần, không đổi lấy bất cứ giá trị nào; (3) cân nhắc ép địa chỉ đầy đủ ở find_vault_output cho MỌI redeemer (Reclaim/ReclaimEpoch cũng dính).

### [CAO] "7 field, đúng thứ tự CBOR" (§2:41) chưa tồn tại ở nguồn thật: plutus.json đang commit là datum 9-field (v4.1) kèm bug đơn vị ×10⁶; v5 CHƯA merge. `conditional_lamp` cùng index 3 ở cả hai ⟹ decoder theo vị trí "thành công" mà lệch 10⁶ lần.
- **Neo:** PhoenixKey-Validator/plutus.json (ActivationVaultDatum = 9 fields — verified) + main:lib/phoenixkey/activation_logic.ak:114-126 (9-field) + main:798 (`lamp_locked == d.conditional_lamp`, thiếu ×oil) ↔ Specs/GenMAGIC-CONTRACT-Vi.md:41 ↔ Wakeme/spec/PhoenixKey-Wakeme-Tech.md:475
- **Mô tả:** CONTRACT §2:41 pin datum "7 field, đúng thứ tự CBOR" và bảng §2:45-51 khớp chính xác code v5. NHƯNG v5 CHỈ tồn tại trên branch chưa merge: `git branch --contains 3d5fdce` → duy nhất `claude/wakeme-closed-loop-pot`. Nhánh mặc định `main` vẫn là v4.1 datum 9-field, VÀ mang bug đơn vị `lamp_locked == d.conditional_lamp` (main:798 — THIẾU `× oil_per_lamp`, tức khoá thiếu 10^6 lần; chính Math.md:49 mô tả đây là "rigor gap v4.1" đã vá ở v5). File `plutus.json` đang commit trong repo (đã verify bằng script: `n_fields = 9`, hash `94032e38891a4a44a2e7e137b50dae420d1cc463385be2c196754048`) là artifact v4.1 — đây chính là thứ backend/rust_core/engine tiêu thụ. Wakeme-Tech §8:475 đã liệt "Rebuild plutus.json khớp v5" là CẦN THÊM, chưa làm.
- **Kịch bản:** Bố cục hai bản: v4.1 = [owner_commit, did_commit, vest_start_slot, conditional_lamp, vested_unlocked, reclaimed_to_pot, last_tick_day, idle_epochs_p2, last_tick_epoch] (9); v5 = [owner_commit, did_commit, vest_start_slot, conditional_lamp, reclaimed_to_pot, last_tick_day, last_tick_epoch] (7). `conditional_lamp` ở INDEX 3 CẢ HAI — đây là chỗ chết người: decoder đọc theo vị trí sẽ "thành công" trên cả hai bản, không có tín hiệu lỗi nào.

Hai đường hỏng:
(1) Engine decode lỏng (Lucid/CBOR đọc field 3, bỏ qua field thừa): vault v4.1 khai c = 1001 nhưng ép `lamp_locked == conditional_lamp` = 1001 oildrop = 0,001 LAMP (main:798). Engine gen như thể 1001 LAMP ⟹ SAI 10^6 LẦN. Attacker khoá 0,001 LAMP, gen bằng người khoá 1001 LAMP.
(2) Engine-dev lấy script-hash từ plutus.json để tính địa chỉ vault (đúng quy trình): hash `94032e38…` là hash v4.1 ⟹ địa chỉ vault tính ra SAI HOÀN TOÀN ⟹ đâm thẳng vào mục (1) của fix finding #1 ("so address với hash apply-param canonical") — lớp phòng thủ chính bị vô hiệu ngay từ tham số đầu vào.
Đường sinh ra rất tự nhiên: engine-dev clone repo → nhánh mặc định là `main` → thấy 9-field + plutus.json 9-field → dựng decoder 9-field. Dòng "verify: aiken check 212/212 PASS" ở Math.md:345 đúng nhưng ở commit KHÁC nhánh mặc định.
- **Đề xuất:** CHẶN Gen production tới khi: (1) v5 (3d5fdce) merge vào main; (2) `aiken build` sinh lại plutus.json 7-field + hash mới — nâng Wakeme-Tech §8:475 từ "CẦN thêm" lên BLOCKER và đưa vào §7 CONTRACT như một phụ thuộc D5 (chủ: PhoenixKey đội on-chain). Engine PHẢI ép arity CHÍNH XÁC: Constr 0 + đúng 7 field, reject mọi thứ khác — TUYỆT ĐỐI không "bỏ qua field thừa" (fail-closed, một vault v4.1 gen 0 còn hơn gen sai 10^6 lần). §2 phải ghi rõ nguồn CBOR chuẩn là commit nào (3d5fdce), không phải main. Thêm test round-trip CBOR aiken↔engine (Tech §8:476 cũng đang liệt là chưa có).

### [THẤP] §4.1 hard-code `slots_per_epoch = 432_000` trong khi Wakeme để nó là config có profile preview nén 1440× — e2e trên Preview sẽ cho kết quả vô nghĩa mà không báo lỗi
- **Neo:** Specs/GenMAGIC-CONTRACT-Vi.md:98 (§4.1) ↔ PhoenixKey-Validator/aiken.toml ([config.preview]: slots_per_day = 60, slots_per_epoch = 300) + activation_logic.ak:96 ("Đọc từ config") @3d5fdce
- **Mô tả:** CONTRACT §4.1:98 hard-code `slots_per_epoch = 432_000` cho công thức tuổi-LAMP. Nhưng ở Wakeme, `slots_per_day`/`slots_per_epoch` là CONFIG đọc từ aiken.toml, và profile `[config.preview]` nén chúng xuống 60/300 (chú thích trong aiken.toml: "NÉN clock để chạm PHA-2/forfeit trong phút thay vì năm. KHÔNG deploy thật bằng profile này"). Đồng hồ nội bộ của vault và đồng hồ mà GenMAGIC dùng để đo tuổi vì thế lệch 1440× trên Preview. Không phải lỗ tiền trên mainnet (default profile = 86400/432000, và aiken.toml chưa có [config.mainnet] nên default áp dụng), nhưng là landmine cho vòng test — đúng lớp "TIME-LOCK ĐƠN-VỊ landmine" đã ghi nhận ở audit Carpet.
- **Kịch bản:** Chạy e2e GenMAGIC trên Preview (đúng như Wakeme-Tech §8:477 yêu cầu: "Testnet e2e Preview: GetLAMP genesis → Reclaim → ReclaimEpoch"). Vault build bằng profile preview: 1 "ngày" = 60 slot, 1 "epoch" = 300 slot ⟹ vault chạm Epochy (n > 1001) sau 1001×60 = 60.060 slot ≈ 16,7 giờ, và bị ReclaimEpoch rút cạn (5 LAMP/300 slot) trong ~3,5 ngày thật. Trong khi đó GenMAGIC tính `tuổi_epoch = ⌊(slot_now − vest_start)/432.000⌋` = 0 suốt toàn bộ vòng đời vault ⟹ tuổi_LAMP đứng ở 1,00× mãi ⟹ không test được gì về §4.1, và mọi con số M_v thu được trên Preview là vô nghĩa — nhưng KHÔNG có lỗi nào bật lên, chỉ là số liệu sai lặng lẽ.
- **Đề xuất:** §4.1 KHÔNG hard-code 432_000. Đọc `slots_per_epoch` từ đúng profile mà instance vault đang deploy dùng (cùng nguồn config với validator), hoặc nếu GenMAGIC cố ý giữ đồng hồ riêng thì ghi RÕ ở §4.1 rằng nó độc lập với đồng hồ Wakeme + nêu hệ quả trên Preview. Thêm 1 dòng vào §7 (phụ thuộc ngoài): profile clock của Wakeme là tham số vận hành GenMAGIC phải biết. Kiểm lại trước khi chạy e2e Preview để không đọc nhầm số liệu test.

**Đã điểm qua:** TRỤC ĐƯỢC GIAO = §9 mục 8 ("Đối chiếu Wakeme — có chỗ nào vi phạm I-ACT-1..8b, đặc biệt I-ACT-7 và tấm-pin G7?"). Chỉ mục 8 được soi đầy đủ. Các mục §9 khác (1 D1-wash-trade, 2 tích-nhân, 3 trễ-một-epoch, 4-5 tự-tham-chiếu, 6 G4, 7 cold-start, 9 pháp lý, 10 G9-decay, 11 an-ninh-sổ, 12 vận-hành) KHÔNG thuộc trục này và KHÔNG được soi — trừ chỗ giao cắt bắt buộc: mục 3 (van 1,25× §5) bị đụng vì trọng số ÂM biến `max(·,1)` thành kíp nổ, và mục 11/12 bị đụng vì thiếu slot chuẩn thì T-RECONCILE "bit-exact" không pass được theo định nghĩa.

CHECKLIST MỤC 8 — TỪNG BẤT BIẾN:
· (SỔ-VALUE) L(vault)==c×oil_per_lamp — **VI PHẠM Ở TẦNG SUY LUẬN** (2 finding NGHIÊM TRỌNG): CONTRACT §2:53 đọc nó như bất biến TRẠNG-THÁI trên UTxO bất kỳ, trong khi nó là bất biến CHUYỂN-TRẠNG-THÁI chỉ ép khi validator chạy; và nó tương đối theo apply-param `lamp_policy` của từng instance (param-substitution, PoC PASS).
· I-ACT-1 (khuôn genesis) — **VI PHẠM**: `vest_start_slot` không có mệnh đề nào ở `genesis_vault_ok`; chính bảng I-ACT-1 (Math §4:118) cũng bỏ sót field này. PoC PASS cả quá-khứ lẫn tương-lai.
· I-ACT-10 (1 DID = 1 vault) — **VI PHẠM**: không ép on-chain; Math.md:130 tuyên có, Math.md:205 + code comment activation_logic.ak:282-284 tự bác. PoC PASS (2 vault cùng DID).
· I-ACT-6 (D-cap ≤ 1001) — **VI PHẠM GIÁN TIẾP**: mệnh đề `c ≤ d_cap` ĐÚNG per-vault, nhưng vì I-ACT-10 rỗng nên nó không còn là trần per-person; và engine không được tin biên 1..1001 (§2:48) cho UTxO chưa qua genesis thật.
· **I-ACT-7 (GenDrip LAMP-preserved) — KHÔNG TÌM RA VI PHẠM trong thiết kế GenMAGIC.** `gen_drip_ok` ép đủ (c′==c, L(out)==L(in)==c′×oil, mọi field bất biến, anti-drain — activation_logic.ak:591-615); GenMAGIC §3 "Kiểm G5" đúng: công thức không có `c` ở output nên engine không cần spend; §6:209 xếp GenDrip là fallback. Vấn đề tôi tìm ra ở GenDrip là **thiếu chữ ký + địa chỉ chỉ khớp payment_credential** (finding CAO) — đó là lỗ AVAILABILITY/định-danh, KHÔNG phải vi phạm I-ACT-7 (LAMP thật sự đứng yên).

### [NGHIÊM TRỌNG] §3 + §5 lệch thứ nguyên đúng Q: Σ M_v = ngân_sách_gen / 10⁹ — và floor đầu tiên đưa M_v = 0 cho MỌI user
- **Neo:** CONTRACT §3 (dòng 71, 80) + §5 (dòng 171-172); đối chiếu đơn vị c_v: CONTRACT §2 dòng 48 (`c` NGUYÊN-LAMP 1..1001) và PhoenixKey-Wakeme-Math.md:40,47 (`c` đếm NGUYÊN-LAMP, d_cap=1001)
- **Mô tả:** §5 định nghĩa `tổng_trọng_số(e) = Σ_v (c_v × tư_cách_v)` — `tư_cách` là Q-format nên W đã mang sẵn một thừa số Q. Nhưng `nhịp_gen = ⌊ngân_sách × Q / W⌋` chỉ NHÂN Q một lần, trong khi §3 `M_v = ⌊⌊c_v × nhịp/Q⌋ × tư_cách/Q⌋` CHIA Q hai lần. Cộng lại: Σ_v M_v ≈ nhịp·W/Q² = (B·Q/W)·(W/Q²) = B/Q. Mạng phát ra ĐÚNG 1 phần tỷ ngân sách. Tệ hơn: `⌊c_v × nhịp/Q⌋ ≈ B/(N·τ̄)` — với τ̄ ≈ 5×10⁹ (tư_cách trung bình 5.0×) thì biểu thức này < 1 trừ khi ngân sách ≥ 5 MAGIC/user/epoch, và floor cắt về 0. Hệ quả kép: (1) §3 dòng 80 'Kiểm G1: tư_cách ≥ Q luôn ⟹ c_v > 0 ⟹ M_v > 0' là chứng minh SAI — nó bỏ qua floor đầu tiên; M_v > 0 chỉ đúng dưới điều kiện phụ KHÔNG được nêu là nhịp_gen ≥ Q/c_v. (2) Thứ tự phép nhân đặt nhịp TRƯỚC tư_cách nên tư_cách không bao giờ cứu được cơ số đã bị floor về 0 — hệ số tư_cách 12.375× nhân vào số 0 vẫn là 0. Đây là lỗi nền: mọi tranh luận về G1/G4/dải-hệ-số đều vô nghĩa cho tới khi vá.
- **Kịch bản:** N = 10⁶ vault, c_v = 1001 (mọi người, vì D = min(1001, pot) — Wakeme-Math:33), τ̄ = 4.95×10⁹ (tư_cách 4.95× — hồ sơ trội, xem finding kế). W = 10⁶ × 1001 × 4.95×10⁹ = 4.955×10¹⁸. Ngân sách hào phóng B = 5×10⁶ MAGIC/epoch = 5×10¹⁵ nanogic (5 MAGIC/user/epoch). ⟹ nhịp_gen = ⌊5×10¹⁵ × 10⁹ / 4.955×10¹⁸⌋ = 1.009×10⁶. Bước 1: ⌊c_v × nhịp/Q⌋ = ⌊1001 × 1.009×10⁶ / 10⁹⌋ = ⌊1.0100⌋ = 1. Bước 2: M_v = ⌊1 × 4.95×10⁹/10⁹⌋ = 4 nanogic = 4×10⁻⁹ MAGIC. Σ M_v = 10⁶ × 4 = 4×10⁶ nanogic = 0.004 MAGIC cho toàn mạng — trong khi ngân sách là 5.000.000 MAGIC. Lệch 1,25×10⁹ lần. Nếu B = 10⁶ MAGIC/epoch (1 MAGIC/user/epoch, vẫn hào phóng): ⌊1001 × 201.800/10⁹⌋ = ⌊0.202⌋ = 0 ⟹ **M_v = 0 cho MỌI user, mọi tư_cách**. Nắm 1001 LAMP, tư_cách 12.375×, gen = 0. G1 vi phạm toàn cục. Thêm: ở B = 5×10⁶ MAGIC, cơ số ⌊c·nhịp/Q⌋ ∈ {1} với c=1001 và {0} với c ≤ 991 ⟹ vault c=1001 gen 4 nanogic, vault c=991 gen 0 — chênh 1% LAMP → tỷ lệ vô hạn về MAGIC (vách lượng tử hoá).
- **Đề xuất:** Khử Q ở trọng số VÀ đảo thứ tự nhân để tư_cách vào trước nhịp: đặt `w_v = ⌊c_v × tư_cách_v / Q⌋` (đơn vị LAMP-hiệu-dụng, ≈ 4954 với c=1001, τ=4.95× — không còn floor về 0); `tổng_trọng_số(e) = Σ_v w_v`; `nhịp_gen(e) = ⌊ngân_sách_gen(e) × Q / max(tổng_trọng_số(e−1),1)⌋`; `M_v(e) = ⌊w_v × nhịp_gen(e) / Q⌋`. Khi đó Σ M_v ≈ ngân_sách_gen ✓ và floor chỉ cắn khi nhịp < Q/w_v (chậm hơn 5× so với hiện tại). Bắt buộc: thêm test vector kiểm ĐỒNG NHẤT THỨ NGUYÊN `|Σ_v M_v(e) − ngân_sách_gen(e)| / ngân_sách_gen(e) < 10⁻⁶` cho N ∈ {10³, 10⁶, 10⁷} và B ∈ {10⁴, 10⁶, 10⁸} MAGIC — đây là bất biến chưa hề tồn tại trong CONTRACT.

### [NGHIÊM TRỌNG] §4.3 `giờ-thấp-điểm` là hệ số MIỄN PHÍ: 1 nanogic tiêu ở thấp điểm = trọn vẹn 1.50×
- **Neo:** CONTRACT §4.3 (dòng 127-136), phá vỡ tuyên bố §4.5 (dòng 159-161)
- **Mô tả:** §4.3 đo `tỷ_thấp_điểm = ⌊đã_tiêu_lúc_thấp_điểm × Q / max(đã_tiêu, 1)⌋` — một TỶ LỆ TRÊN CHÍNH `đã_tiêu`, KHÔNG có mẫu số độc lập, KHÔNG có ngưỡng tối thiểu, KHÔNG chuẩn hoá theo `đã_sinh`. Hệ số này vì thế BẤT BIẾN THEO TỶ LỆ (scale-free): chỉ cần 100% lượng đã tiêu (dù lượng đó bằng bụi) rơi vào thấp điểm là ăn trần. Chính dòng 136 ('đã_tiêu = 0 ⟹ tỷ = 0 ⟹ sàn 1.0× — không phạt kép') TẠO RA lỗ: hệ đặt sàn cho đã_tiêu = 0 nhưng đặt TRẦN cho đã_tiêu = 1 nanogic. Có một bậc nhảy 0.50× (50% sinh) giữa 0 và 10⁻⁹ MAGIC. Đây là lỗi thiết kế cổ điển: dùng tỷ-lệ-nội-bộ (đã_tiêu_thấp_điểm/đã_tiêu) làm hệ số thưởng mà không neo mẫu số vào một đại lượng tốn kém. Hệ quả: §4.5 dòng 159 'ôm-giữ tối đa không tiêu = 2.20 × 1.0 × 1.0 × 1.0 = 2.20×' là SAI — người ôm tối ưu đạt ≥ 3.30× chỉ với bụi.
- **Kịch bản:** Vault H (ôm-giữ). c = 1001, tuổi ≥ 24 epoch ⟹ tuổi_LAMP = 2.20×. Mỗi epoch H gửi ĐÚNG 1 delta tiêu = 1 nanogic (10⁻⁹ MAGIC), canh đúng slot mà FlowRate dual-EMA (§4.3 dòng 132-133: EMA-nhanh < EMA-chậm) báo thấp điểm — bot làm việc này hoàn hảo, chi phí ≈ phí giao dịch = 0 vì gen là 0-tx-L1 trong epoch (§6 dòng 197). Tính: đã_tiêu = 1 (nanogic, cửa sổ 6 epoch = 6). đã_tiêu_lúc_thấp_điểm = 6. tỷ_thấp_điểm = ⌊6 × 10⁹ / max(6,1)⌋ = 10⁹ = Q. giờ_thấp_điểm = Q + ⌊Q × 0.5Q/Q⌋ = 1.5Q = **1.50× TRẦN**. Trong khi đó tiêu_thật của H: đã_sinh trong 6 epoch ≈ 6 × M_H (hàng tỷ nanogic) ⟹ tỷ_tiêu = ⌊6 × 10⁹/6×10⁹×...⌋ ≈ 0 ⟹ tiêu_thật = 1.00×. ⟹ tư_cách_H = ⌊⌊⌊2.20 × 1.00⌋ × 1.50⌋ × 1.50⌋ = **3.30×** (chưa tính cam_kết_lịch). H đã tiêu 10⁻⁹ MAGIC để mua +50% sản lượng vĩnh viễn. Tỷ suất: 1 nanogic đổi lấy ~0.5 × M_H nanogic/epoch. Với M_H = 5 MAGIC/epoch ⟹ ROI = 2,5×10⁹ lần/epoch. Đối chiếu: cổng anti-idle của Wakeme CÓ ngưỡng tuyệt đối `MIN_MAGIC_TX` (Wakeme-Tech:340 `active = M_profile(n) ≥ MIN_MAGIC_TX`; Wakeme-Math:304 ghi nhận MIN_MAGIC_TX còn 'TẠM') — nhưng §4.3 của GenMAGIC KHÔNG có ngưỡng nào. H tiêu đúng MIN_MAGIC_TX (thay vì 1 nanogic) là vừa thoát anti-idle drain, vừa ăn trọn 1.50×.
- **Đề xuất:** Neo mẫu số vào một đại lượng TỐN KÉM, không vào chính tử số. Thay: `tỷ_thấp_điểm = min(Q, ⌊đã_tiêu_lúc_thấp_điểm × Q / max(đã_sinh, 1)⌋)` — tức đo 'bao nhiêu phần SUẤT SINH của anh được tiêu ở thấp điểm', không phải 'bao nhiêu phần cái anh đã tiêu'. Khi đó 1 nanogic cho tỷ ≈ 0 ⟹ sàn 1.0×, còn người tiêu hết suất ở thấp điểm mới đạt 1.50×. Cách này cũng gộp đúng ngữ nghĩa G8 (điều-tiết cung-cầu đo trên CUNG, không đo trên chính hành vi). Nếu muốn giữ ngữ nghĩa 'tỷ lệ trong hành vi', bắt buộc thêm cổng lượng: `giờ_thấp_điểm = Q` nếu `đã_tiêu < NGƯỠNG_HIỆU_LỰC` với NGƯỠNG_HIỆU_LỰC ≥ một tỷ lệ cố định của `đã_sinh` (vd 10%) — nhưng cách này lại tạo bậc nhảy tại ngưỡng, nên phương án chuẩn-hoá-theo-đã_sinh tốt hơn (liên tục, đơn điệu, không có bậc).

### [NGHIÊM TRỌNG] G4 GÃY — §4.5 so lệch hai chiều; hồ sơ ôm-tối-ưu 4.95× vượt người tiêu-thật có cầu hữu hạn (4.74×), và trả 0 đồng
- **Neo:** CONTRACT §4.5 (dòng 149-161) + §4.1 (dòng 98-99, 101) + §4.2 (dòng 114-115) + §4.3 (dòng 129) + §4.4 (dòng 143-144); tiên đề G4 dòng 25
- **Mô tả:** §4.5 dòng 159-161 dựng phép so RIGGED theo hai chiều ngược nhau, cả hai đều có lợi cho kết luận: (1) CHO NGƯỜI ÔM quá ít — gán giờ_thấp_điểm = 1.0 và cam_kết_lịch = 1.0, trong khi cả hai đều MIỄN PHÍ (finding §4.3 dust + finding §4.4 cheap-talk) ⟹ người ôm thật sự đạt 2.20 × 1.00 × 1.50 × 1.50 = **4.95×**, không phải 2.20×. (2) CHO NGƯỜI TIÊU quá ít — gán 'mới 0 epoch tuổi'. Nhưng `tuổi_epoch = ⌊(slot_now − vest_start_slot)/432000⌋` (§4.1 dòng 98) là ĐỒNG HỒ TREO TƯỜNG, không phải lựa chọn: nó tự chạy cho MỌI vault, miễn phí, và chạm trần 24 epoch = 120 ngày. Không ai 'chọn' trẻ. Ở trạng thái dừng (ngày > 120) tuổi_LAMP = 2.20 cho TẤT CẢ. Sửa cả hai lệch ⟹ tỷ số thật không phải 2.6×. Sâu hơn: sức mạnh THẬT của G4 = đúng một số hạng `1.5 × min(1, K/M)` với K = cầu dịch vụ THẬT/epoch, M = suất sinh. Ba hệ số kia triệt tiêu (đều max cho mọi người). ⟹ **G4 xung đột cấu trúc với G3/G8: ngân sách càng hào phóng (M càng lớn) thì K/M càng nhỏ, tiêu_thật → 1.0, và người tiêu thật HỘI TỤ VỀ ĐÚNG người ôm.** CONTRACT không hề chặn K/M ở đâu, không nêu K/M kỳ vọng, và §5 để ngỏ `ngân_sách_gen`. Về LỢI NHUẬN RÒNG (đúng câu hỏi được giao): người ôm trả 0 và giữ vị thế tối đa miễn phí; người tiêu thật trả tiền cho dịch vụ thật. Với K/M < 13.3% người ôm thắng cả GỘP lẫn RÒNG.
- **Kịch bản:** Cả hai vault ở ngày 400 (tuổi ≥ 24 epoch ⟹ tuổi_LAMP = 2.20 cho cả hai; Epochy chưa tới vì cần n > 1001 ngày — Wakeme-Math:23,87). c = 1001 cho cả hai (Wakeme-Math:33, D = min(1001, pot)).
• **H (ôm-giữ tối ưu, bot)**: tiêu đúng MIN_MAGIC_TX mỗi epoch, 100% ở thấp điểm; cam kết ScheduleGen tối đa (miễn phí). tuổi 2.20 × tiêu_thật 1.00 × giờ 1.50 × cam_kết 1.50 = **4.95×**. Chi phí tiền thật: **0**.
• **C (người tiêu thật, con người)**: cầu dịch vụ thật K = 10% suất sinh (K/M = 0.10 — hoàn toàn thực tế nếu ngân sách được thiết kế 'hào phóng' để MAGIC phủ phí); tiêu khi CẦN dùng dịch vụ chứ không canh EMA ⟹ giả sử 50% lượng tiêu rơi vào thấp điểm do ngẫu nhiên; có cam kết. tiêu_thật = Q + ⌊0.10Q × 1.5Q/Q⌋ = 1.15×. giờ_thấp_điểm = Q + ⌊0.5Q × 0.5Q/Q⌋ = 1.25×. tư_cách_C = ⌊⌊⌊2.20 × 1.15⌋ × 1.25⌋ × 1.50⌋ = 2.53 × 1.25 × 1.50 = **4.74×**. Chi phí tiền thật: giá của K dịch vụ mỗi epoch.
⟹ **4.95× > 4.74×. Người ôm sinh NHIỀU MAGIC HƠN người tiêu thật, trong khi người tiêu thật là bên duy nhất trả tiền.** G4 ('công dân hạng nhất = người tiêu MAGIC cho dịch vụ THẬT') GÃY cả về hệ số gộp lẫn lợi nhuận ròng.
• **Ngưỡng gãy tổng quát**: H = 4.95 = 2.20 × T_C × 1.25 × 1.50 ⟹ T_C = 1.20 ⟹ 1.5 × min(1, K/M) = 0.20 ⟹ **K/M = 13.3%**. Mọi người tiêu thật có cầu thật dưới 13.3% suất sinh và không canh giờ đều THUA người ôm. CONTRACT không đưa ra bất kỳ lập luận nào cho thấy hệ nằm ngoài vùng này.
• **Kể cả khi C canh giờ hoàn hảo (giờ = 1.50)**: tư_cách_C = 2.20 × 1.15 × 1.50 × 1.50 = 5.69× vs H 4.95× ⟹ lợi thế chỉ **+15%**, không phải 'ăn đứt 2.6 lần'. Và +15% đó là +15% trên một thứ KHÔNG chuyển nhượng, KHÔNG tích luỹ (G6/G9) — tức 15% thêm của một khoản bù phí mà C đằng nào cũng chỉ dùng được tới mức K.
- **Đề xuất:** Ba việc, theo thứ tự: (1) **XOÁ 'Kiểm G4 (số học)' ở §4.5** — nó là lỗi phạm trù: hệ số nhân của một đơn vị không-chuyển-nhượng + không-tích-luỹ KHÔNG PHẢI payoff. Thay bằng chứng minh trên LỢI NHUẬN RÒNG, và chứng minh đó BẮT BUỘC phải định nghĩa MAGIC mua được gì và ai chịu chi phí — hiện CONTRACT không nêu (§7 D4 đẩy sang PhoenixKey B4) nên G4 hiện KHÔNG THỂ ĐÁNH GIÁ ĐƯỢC bằng chính tài liệu này. (2) **Rút tuổi_LAMP ra khỏi tư_cách hoặc hạ trần mạnh**: ở trạng thái dừng nó là hằng số 2.20 cho mọi người, triệt tiêu trong chuẩn hoá `nhịp_gen = ngân_sách/Σtrọng_số` (§5 dòng 172) ⟹ nó KHÔNG phân biệt được ai với ai sau ngày 120, chỉ tạo lợi thế theo NGÀY ĐĂNG KÝ trong 120 ngày đầu (người vào ngày 500 chịu 1/2.2 = 45% suất của người cũ suốt 24 epoch — hình phạt onboarding thuần lịch, không hành vi). Nếu giữ, phải nói thẳng nó là cơ chế launch-window chứ không phải 'trung thành'. (3) **Làm tiêu_thật thành hệ số DUY NHẤT có dải rộng và không bị ba hệ số miễn phí pha loãng** — xem đề xuất tổng-có-trọng-số ở finding về tích-nhân. Đồng thời đặt trần cứng: `tư_cách_ôm_tối_đa < tư_cách_tiêu_tối_thiểu_hợp_lệ` phải là một BẤT BIẾN có test, không phải một dòng văn ở bảng §4.5.

### [NGHIÊM TRỌNG] §4.4 `cam-kết-lịch` = cheap talk chiến lược trội; và nếu `pp_sched` vào `ngân_sách_gen` theo chiều dương thì đây là đường bơm lạm phát toàn cục
- **Neo:** CONTRACT §4.4 (dòng 142-147) + §5 (dòng 170) + §2 (dòng 62) + G9 và hệ quả G9 (dòng 30, 32-35) + §8 (dòng 233). Chiều dấu của `pp_sched` trong `f`: [NEEDS-EVIDENCE] — §5 dòng 188 tự ghi 'ngân_sách_gen từ br_q/pp_sched theo hàm nào? Chưa chốt'.
- **Mô tả:** §4.4 thưởng 1.50× cho `tỷ_cam_kết = min(Q, ⌊magic_cam_kết_đang_hiệu_lực × Q / max(sinh_kỳ_vọng_6_epoch,1)⌋)`. CONTRACT KHÔNG nêu: tài sản thế chấp, hình phạt khi không giao, trần cam kết, hay điều kiện hiệu lực nào. ⟹ cam kết MIỄN PHÍ ⟹ cam-kết-tối-đa là CHIẾN LƯỢC TRỘI cho mọi người chơi (kể cả người ôm). Hai hệ quả: (1) **Mất hết thông tin**: khi mọi người cam kết max, tỷ_cam_kết = 1 cho tất cả, hệ số thành hằng số, triệt tiêu trong chuẩn hoá §5 ⟹ lý do kinh tế nêu ở dòng 147 ('cam-kết-trước = cầu báo trước ⟹ engine ước lượng được tải ⟹ hạ bất định (G8)') SAI NGƯỢC — tín hiệu không chỉ vô dụng mà PHẢN THÔNG TIN. (2) **Bơm ngân sách**: §5 dòng 170 ghi `ngân_sách_gen(e) = f(br_q, br_safe_q, f_max_q, S, pp_sched)`, với `pp_sched` = 'MAGIC đã cam kết trong hợp đồng lịch' (§2 dòng 62). Nếu `pp_sched` vào `f` theo chiều DƯƠNG — điều mà ngữ nghĩa 'cầu báo trước' hàm ý — thì mọi user có động cơ TRỘI bơm cam kết giả, và tổng bơm đó nâng ngân sách toàn cục. Đây không cần thông đồng: nó là cân bằng Nash, mỗi người đơn phương làm vì có lợi. Thêm mâu thuẫn với G9 (mục 10 §9 hỏi đúng chỗ này): G9 dòng 30-32 nói MAGIC 'RESET mỗi epoch, không tích luỹ được'. Vậy 'MAGIC cam kết đang hiệu lực' là cái gì? Chỉ có hai cách đọc, CẢ HAI đều hỏng: **(i) cam kết = hứa giao MAGIC tương lai từ suất tương lai** ⟹ không có gì để tịch thu, hứa suông, tự do bơm (chính là kịch bản trên); **(ii) cam kết = khoá MAGIC epoch này vào hợp đồng và nó SỐNG SÓT qua reset** ⟹ ScheduleGen trở thành LỖ TÍCH LUỸ: mỗi epoch đẩy suất vào 'hợp đồng lịch' để né decay ⟹ phá thẳng hệ quả G9(a) ('không có kho MAGIC để đầu cơ', dòng 33) VÀ phá lá chắn pháp lý §8 #2 ('không chuyển nhượng VÀ không tích luỹ ⟹ không thể là tài sản đầu tư', dòng 35 + 233). CONTRACT chưa chọn cách đọc nào.
- **Kịch bản:** Kiểm tính trội (không cần giả định gì ngoài §4.4). Đặt B_v = c_v·nhịp·tuổi·tiêu_thật·giờ (phần không phụ thuộc cam kết), M = B_v(1 + 0.5·tỷ), sinh_kỳ_vọng_6 = 6M. Cam kết C ⟹ tỷ = min(1, C/6M). ∂tỷ/∂C > 0 (C vào tử số tuyến tính, chỉ vào mẫu qua số hạng 0.5·tỷ) ⟹ đơn điệu tăng ⟹ **user cam kết tới khi tỷ = 1, tức C* = 6M|_(tỷ=1) = 9·B_v**. Chi phí = 0 (CONTRACT không quy định chi phí nào). ⟹ MỌI user, ôm lẫn tiêu, đặt cam_kết_lịch = 1.50×.
Bơm ngân sách: N = 10⁶ vault, B_v tương ứng M_base = 3.3 MAGIC/epoch ⟹ C* = 9 × 3.3 = 29.7 MAGIC/vault. `pp_sched` toàn mạng = 10⁶ × 29.7 = **2.97×10⁷ MAGIC 'cam kết'** — trong đó lượng cầu THẬT (K) có thể chỉ là 10⁶ × 0.33 = 3.3×10⁵ MAGIC. **pp_sched thổi phồng 90× so với cầu thật.** Nếu `f` nâng ngân sách theo pp_sched dù chỉ tuyến tính-có-trần, đây là đòn bẩy 90× lên nguồn cung MAGIC, do một hành động chi phí bằng 0 mà mọi user đều có động cơ đơn phương thực hiện. Không ai 'tấn công' — đây là cân bằng.
Đọc cách (ii): user đẩy 100% suất mỗi epoch vào hợp đồng lịch, 52 epoch/năm ⟹ tích luỹ 52 × M MAGIC 'trong hợp đồng' trong khi CONTRACT tuyên bố MAGIC không tích luỹ được. Lá chắn pháp lý §8 #2 và hệ quả G9(c) (dòng 35) sụp.
- **Đề xuất:** Chốt cách đọc TRƯỚC, rồi vá theo: **Nếu (i) hứa-tương-lai** — cam kết PHẢI có chi phí bất khả hồi, nếu không hệ số này phải bị XOÁ. Chi phí khả dĩ duy nhất trong mô hình này: cam kết ràng buộc SUẤT (không phải MAGIC) — user cam kết rằng X% suất epoch tương lai đã bị hợp đồng chiếm chỗ và KHÔNG dùng được cho mục đích khác; không giao thì `tiêu_thật` epoch đó bị trừ. Khi đó cam kết mới là tín hiệu tốn kém (costly signal) và mới hạ được bất định như §4.4 tuyên bố. **Nếu (ii) khoá-hiện-tại** — phải nói thẳng ScheduleGen là ngoại lệ của G9, và §8 #2 + hệ quả G9(a)/(c) PHẢI viết lại (không được tuyên bố 'không tích luỹ'). **Trong cả hai trường hợp**: `ngân_sách_gen` TUYỆT ĐỐI không được lấy `pp_sched` làm đầu vào cho tới khi cam kết có chi phí — một biến mà mọi người chơi có động cơ trội bơm lên thì không được phép điều khiển nguồn cung. Nếu cần tín hiệu cầu, dùng `đã_tiêu` THỰC TẾ của các epoch trước (đã xảy ra, không bơm được ex-post) thay cho `pp_sched` (lời hứa). Bổ sung §9 mục 10: câu trả lời là **CÓ, G9 phá cam-kết-lịch** — không phải 'reset làm mất cam kết' mà là 'G9 khiến cam kết không có vật để cam kết'.

### [CAO] §9 mục 10 — G9 chặn TỒN KHO chứ không chặn QUỸ ĐẠO CUNG; bộ điều khiển §5 điều tiết đúng biến SAI (sinh, không phải tiêu) → điểm mù thanh khoản GreenBack 3,3×
- **Neo:** CONTRACT §9 mục 10 (dòng 252) + hệ quả G9 dòng 32-35 + §5 dòng 170, 183, 185-186, 188 + §6 dòng 203; kênh MAGIC→CARP→Treasury: PhoenixKey-MAGIC-Vault-Scale-Analysis.md:241-245 (§5.2 settlement 'chuyển CARP về Treasury (net của epoch)') và :310 (T-RECONCILE 'net MAGIC→CARP đúng, CARP về Treasury khớp tổng')
- **Mô tả:** Đây là câu trả lời trực tiếp cho §9 mục 10 ('Quỹ đạo cung MAGIC dài hạn có bị chặn thật bởi G9 không?'): **KHÔNG.** Hệ quả G9(a) (dòng 33: 'không có kho MAGIC để đầu cơ ⟹ quỹ đạo cung MAGIC không phân kỳ dù nhịp_gen sai') nhập nhằng TỒN KHO (stock) với DÒNG (flow). G9 chặn tồn kho — đúng. Nhưng đại lượng có nghĩa kinh tế là DÒNG ĐÃ TIÊU tích luỹ qua các epoch: MAGIC được tiêu tại nhà cung cấp → net CARP về Treasury (§6 dòng 203; Scale-Analysis §5.2 và T-RECONCILE §6.3) ⟹ **mỗi MAGIC được TIÊU là một yêu sách thật lên bảo chứng, và tổng yêu sách = Σ_epoch tiêu(e) — hoàn toàn KHÔNG bị G9 chặn.** Chặn duy nhất là `ngân_sách_gen(e)`, mà §5 dòng 188 tự thừa nhận chưa chốt hàm. Nghiêm trọng hơn: **bộ điều khiển tích phân §5 dòng 183 ('thừa/thiếu epoch e trừ/cộng vào ngân_sách_gen(e+1)') đo lượng SINH, trong khi biến ràng buộc khả năng chi trả là lượng TIÊU.** Vì phần lớn MAGIC sinh ra sẽ bay hơi (G9) ở tay người ôm, hai đại lượng này lệch nhau bởi tỷ lệ người ôm f — một biến hành vi mà giao thức KHÔNG đo, KHÔNG kiểm soát, và có thể dịch chuyển nhanh. Bộ điều khiển sẽ báo 'bám ngân sách' hoàn hảo trong khi yêu sách thật lên GreenBack nhảy vài lần. Đây là điểm mù thanh khoản kiểu bank-run: hệ an toàn CHỈ VÌ phần lớn MAGIC không được dùng.
- **Kịch bản:** Cùng tham số, chỉ đổi tỷ lệ người ôm f. Mọi vault c = 1001, tuổi 2.20, giờ 1.50, cam_kết 1.50 (ba hệ số miễn phí — max cho tất cả). Người ôm: tiêu_thật 1.00 ⟹ trọng số 1001 × 4.95. Người tiêu (đủ cầu, tỷ_tiêu = 1): tiêu_thật 2.50 ⟹ trọng số 1001 × 12.375. Ngân sách B cố định.
• **f = 0.9** (90% ôm — hoàn toàn thực tế cho một phân phối MIỄN PHÍ: mọi DID nhận D = 1001 LAMP không tốn gì, Wakeme-Math:33): Σtrọng_số = N·1001·(0.9×4.95 + 0.1×12.375) = N·1001·5.6925. Phần người tiêu = 1.2375/5.6925 = **21,7%**. ⟹ **78,3% ngân sách sinh vào tài khoản người ôm rồi BAY HƠI.** Lượng TIÊU thật = 0,217·B.
• **f = 0.5** (một nửa chuyển sang tiêu — do một chiến dịch marketing, một dịch vụ hot, hoặc D1 wash-trade mở ra): Σtrọng_số = N·1001·(0.5×4.95 + 0.5×12.375) = N·1001·8.6625. Phần người tiêu = 6.1875/8.6625 = **71,4%**. Lượng TIÊU thật = 0,714·B.
⟹ **Yêu sách lên bảo chứng GreenBack nhảy 0,217·B → 0,714·B = 3,29× — trong khi lượng SINH đứng yên đúng B ở cả hai kịch bản.** Bộ điều khiển tích phân §5 nhìn thấy: KHÔNG CÓ GÌ THAY ĐỔI, sai lệch = 0, không hiệu chỉnh. Van cứng 1.25×/epoch (§5 dòng 182) cũng vô hiệu vì nhịp_gen không hề cần tăng. Nếu `br_q`/`f_max_q` được hiệu chuẩn trên lượng SINH ở f = 0.9, hệ mất khả năng bảo chứng đúng lúc người dùng thật sự dùng sản phẩm — tức đúng lúc thành công.
- **Đề xuất:** (1) **Ghi thẳng vào CONTRACT rằng G9 KHÔNG chặn quỹ đạo cung** — sửa hệ quả G9(a) dòng 33 thành 'G9 chặn TỒN KHO per-user; KHÔNG chặn tổng dòng đã tiêu; chặn duy nhất là ngân_sách_gen'. Câu 'quỹ đạo cung MAGIC không phân kỳ dù nhịp_gen sai' phải bị xoá — nó tạo cảm giác an toàn giả và có thể khiến `f` được chọn lỏng. (2) **Bộ điều khiển §5 phải đo TIÊU, không đo SINH**: sai lệch tích phân = `ngân_sách_gen(e) − đã_tiêu_toàn_mạng(e)`, không phải `− đã_sinh(e)`. Engine đã thấy toàn bộ dòng tiêu (§6 dòng 197-203, §4.3 dòng 134) nên đại lượng này SẴN CÓ, không tốn thêm gì. (3) **Công bố và giám sát `f` (tỷ lệ suất bay hơi) như một tham số rủi ro hạng nhất**: `f(e) = 1 − đã_tiêu_toàn_mạng(e)/đã_sinh_toàn_mạng(e)`. Đặt bất biến vận hành: `ngân_sách_gen` phải chịu được kịch bản `f → f_min_giả_định` (vd 0.3) mà không phá `br_safe_q`. Không có tham số này thì §5 đang bảo chứng cho một con số mà chính nó không đo. (4) Bổ sung §9 mục 10 câu trả lời: 'G9 CÓ phá cam-kết-lịch (xem finding §4.4) và KHÔNG chặn quỹ đạo cung. G9 chỉ chặn đầu cơ tồn kho.'

### [CAO] §9 mục 2 — dải 12.375× là ẢO: 3/4 hệ số là hằng số ở cân bằng; tích-nhân NHÂN BẢN thiệt hại của mọi hệ số hỏng thay vì bó nó
- **Neo:** CONTRACT §9 mục 2 (dòng 244) + §4 dòng 88, 91 + §4.1 dòng 99, 101, 104 + §4.2 dòng 118 + §4.5 bảng dòng 151-157 + §5 dòng 172 + §7 D1 dòng 222; mốc Epochy n > 1001 ngày: PhoenixKey-Wakeme-Math.md:23, 87
- **Mô tả:** Trả lời trực tiếp §9 mục 2 ('Tích-nhân 4 hệ số — đúng hay nên tổng-có-trọng-số? Tích cho dải 12.4× — quá rộng?'). Câu hỏi 'quá rộng?' đặt sai: dải THẬT ở cân bằng KHÔNG PHẢI 12.375×. Ở trạng thái dừng: `tuổi_LAMP` = 2.20 cho mọi vault (đồng hồ treo tường, trần 120 ngày, Epochy chỉ tới ngày 1002 — Wakeme-Math:23,87 — tức có **176 epoch liền tuổi đã max mà chưa có lực bào nào**, nên lập luận 'cân bằng tự nhiên' ở §4.1 dòng 104 sai về thời điểm); `giờ_thấp_điểm` = 1.50 (miễn phí, chiến lược trội); `cam_kết_lịch` = 1.50 (miễn phí, chiến lược trội). Cả ba triệt tiêu trong chuẩn hoá `nhịp_gen = ngân_sách/Σtrọng_số` (§5 dòng 172) vì chỉ TỶ SỐ trọng số mới quyết định phần chia. ⟹ **cơ chế thực tế là MỘT tham số (`tiêu_thật`), dải 2.5×.** Ba hệ số kia không phân biệt ai với ai — chúng chỉ đóng góp: độ phức tạp, bề mặt tấn công, và chi phí nhận thức. Về HÌNH DẠNG hàm, tích sai vì hai lý do đo được: (1) **Đạo hàm riêng của tích tỷ lệ thuận với tích các hệ số còn lại** ⟹ ai đã ở vị thế tốt thì cùng một nỗ lực lại được thưởng nhiều hơn — đúng cơ chế 'giàu càng giàu' mà §4.2 dòng 118 tuyên bố chống. (2) **Bán kính sát thương của một hệ số hỏng bị NHÂN với mọi hệ số khác** — đây là điểm chí mạng khi §9 mục 1 đã tự nhận D1 wash-trade là 'lỗ hổng NGHIÊM TRỌNG NHẤT' (§7 dòng 222). CONTRACT nhận diện đúng lỗ nhưng lại chọn đúng hàm khuếch đại nó. §4 dòng 91 biện minh tích bằng 'cùng khuôn với VP governance (tích ≥4 tham số)' — **phép loại suy này không chuyển được**: VP nhân 4 tham số ĐỀU TỐN KÉM (MAGIC đã tiêu, LAMP cam kết, uy tín, LAMP nắm giữ có cap) cho một lá phiếu khan hiếm; ở đây 3/4 hệ số MIỄN PHÍ. Sao chép hình dạng hàm mà không sao chép cấu trúc chi phí là lỗi thiết kế.
- **Kịch bản:** **Đo (1) — bất đối xứng động cơ biên.** User X ở (2.20, 1.00, 1.50, 1.50) = 4.95×; User Y ở (1.00, 1.00, 1.00, 1.00) = 1.00×. Cả hai bỏ CÙNG một nỗ lực để nâng `tiêu_thật` 1.00 → 2.50. X: 4.95 → 12.375, được **+7.425**. Y: 1.00 → 2.50, được **+1.50**. **Tỷ suất biên của X gấp 4,95× của Y cho cùng một hành động.** Với tổng-có-trọng-số `tư_cách = Q + Σ wᵢ·rᵢ`, cả hai đều được đúng `w_tiêu` — tỷ suất biên bằng nhau, đúng 1,00×.
**Đo (2) — bán kính sát thương khi D1 vỡ.** Kẻ dựng dịch vụ ma tự tiêu cho mình (§7 dòng 222). Dưới TÍCH: hắn đi từ hồ sơ ôm-tối-ưu 4.95× lên 2.20 × 2.50 × 1.50 × 1.50 = **12.375×** ⟹ **+150%**, và §7 còn tính thiếu — dòng 222 ghi '2.5 × 1.5 = 3.75× miễn phí' nhưng thực tế wash-trader ăn 12.375× vì tuổi và cam_kết cũng nhân vào. Dưới TỔNG (đề xuất bên dưới, dải 1.0–2.5×, w_tiêu = 0.60Q): hắn đi từ 1 + 0.48 + 0.06 + 0.06·... ≈ 1.90× lên 2.50× ⟹ **+32%**. **Tích khuếch đại thiệt hại của lỗ nghiêm trọng nhất lên gấp ~4,7 lần so với tổng.**
**Đo (3) — dải hữu ích.** Tích, danh nghĩa: 12.375×. Tích, ở cân bằng (3 hệ số = hằng): dải phân tán thật = 2.50×. Tổng-có-trọng-số, danh nghĩa = ở cân bằng = 2.50×. **Chuyển sang tổng KHÔNG mất một chút khả năng phân biệt nào** — vì khả năng phân biệt hiện có đã chỉ đến từ `tiêu_thật`. Chi phí chuyển đổi = 0. Lợi ích = bó bán kính sát thương + động cơ biên đồng đều + user hiểu nổi.
- **Đề xuất:** Thay §4 dòng 88 bằng tổng-có-trọng-số trên các tỷ lệ đã chuẩn hoá: `tư_cách_v(e) = Q + ⌊(w₁·r_tuổi + w₂·r_tiêu + w₃·r_thấp_điểm + w₄·r_cam_kết)/Q⌋` với mọi `rᵢ ∈ [0, Q]` và `Σwᵢ = 1.5Q` ⟹ dải [1.00× .. 2.50×]. Phân bổ theo đúng thứ tự ưu tiên G4 mà §4.5 tuyên bố nhưng không thực thi được: `w_tiêu = 0.90Q` (60% toàn bộ dải — công dân hạng nhất, đúng G4), `w_tuổi = 0.30Q`, `w_thấp_điểm = 0.20Q`, `w_cam_kết = 0.10Q`. Ba tính chất đạt được ĐỒNG THỜI, kiểm được bằng test: (a) **G4 thành bất biến số học**: `tư_cách_ôm_max = Q + 0.30Q + 0.20Q + 0.10Q = 1.60×` < `tư_cách_tiêu_max = 2.50×` và < `tư_cách_tiêu_ở_K/M=0.2 = Q + 0.30Q + 0.9Q×0.2 + ... = 1.66×` ⟹ người tiêu thật thắng ngay ở cầu rất thấp — trong khi dưới tích thì cần K/M > 13.3%. (b) **Bó sát thương**: mỗi hệ số hỏng gây thiệt hại tối đa đúng `wᵢ`, không nhân với gì. Wash-trade D1 ăn tối đa +0.90Q thay vì ×2.5 trên nền 4.95. (c) **Động cơ biên đồng đều** — không còn 'giàu càng giàu' xuyên hệ số. Kèm theo, BẮT BUỘC: sửa `giờ_thấp_điểm` và `cam_kết_lịch` theo hai finding riêng (chuẩn hoá mẫu số về `đã_sinh`; cam kết phải tốn kém) — nếu không thì dù dùng tổng, hai hệ số đó vẫn là hằng số vô nghĩa, chỉ khác là chúng chỉ ăn 0.30Q thay vì nhân 2.25×.

### [NGHIÊM TRỌNG] §2 đọc NGƯỢC nguồn T-3: toàn bộ phòng tuyến chống Sybil dựa trên một trích dẫn nói điều ngược lại
- **Neo:** CONTRACT §2 (dòng 57-58) và §7 D2 (dòng 223, 'Uniqueness PersonDID (sinh-trắc Enclave) | PhoenixKey (T-3)') ĐỐI CHIẾU PhoenixKey-Wakeme-Math.md:281 (bảng T-3) và :286 (ghi chú phân tách) và :301 (§9 hàng GV1/PA2, mức CAO, 'TRƯỚC khi mở GetLAMP-PersonDID production')
- **Mô tả:** CONTRACT §2 dòng 57-58 viết: '**1 DID = 1 vault** (I-ACT-10, vault-NFT singleton name = owner_commit) ⟹ không thể Sybil đa-vault trên cùng DID. **Sybil đa-DID chặn bởi sinh-trắc Enclave (Wakeme T-3)** — ngoài phạm vi MAGIC, ghi rõ là giả-định-tin-cậy.' Vế đầu đúng. **Vế thứ hai đọc ngược nguồn được trích.** Wakeme-Math T-3 nói CHÍNH XÁC điều trái lại: rủi ro của T-3 KHÔNG PHẢI Sybil sinh trắc, mà là một lỗ MẬT MÃ ở tầng anchor, và sinh trắc KHÔNG đóng được nó. Nguyên văn Wakeme-Math:281: 'Lỗ ở tầng **mã hoá anchor** (KHÔNG phải sinh trắc): GenesisPerson đúc được anchor did-string bất kỳ với controller của attacker vì HW_Key P-256 KHÔNG verify on-chain (I-CURVE-4 carry-by-equality). N anchor-giả → N×D LAMP rút khỏi pot.' Và Wakeme-Math:286 nhấn mạnh lần nữa: 'T-3 là lỗ ANCHOR-uniqueness (mã hoá), KHÔNG phải lo ngại sybil-sinh trắc — sinh trắc Secure Enclave đủ chống trùng người; **lỗ nằm ở anchor did-string không ràng khoá gốc**.' Trạng thái nguồn ghi: 'NGOÀI phạm vi vault; chờ PA2 land' (Wakeme-Math:281) và Wakeme-Math:301 xếp GV1/PA2 mức **CAO**, yêu cầu 'đóng lỗ đúc-anchor-did-bất kỳ ở tầng structural/cryptographic **TRƯỚC khi mở GetLAMP-PersonDID production**'. ⟹ CONTRACT biến một BLOCKER ĐANG MỞ mức CAO thành một 'giả-định-tin-cậy đã có người lo'. Đây không phải khác biệt diễn đạt — nó đảo ngược trạng thái rủi ro, và nó là phòng tuyến DUY NHẤT mà §2 đưa ra cho câu hỏi Sybil. Hệ quả trực tiếp lên trục của em: nếu 3/4 hệ số miễn phí (các finding trên), mỗi DID giả bê nguyên hồ sơ ôm-tối-ưu 4.95× với chi phí vận hành ~0 ⟹ Sybil là chiến lược trội và lợi ích tuyến tính theo số anchor giả.
- **Kịch bản:** Kẻ tấn công khai thác đúng lỗ mà Wakeme-Math:281 mô tả (đúc anchor did-string bất kỳ với controller của mình, vì HW_Key P-256 không verify on-chain). Dựng N = 10.000 anchor giả. Mỗi anchor → 1 PersonDID → 1 vault (I-ACT-10 chỉ ép 1 vault/DID, không ép 1 DID/người) → nhận D = 1001 LAMP từ pot (Wakeme-Math:33). Hai tầng thiệt hại:
• **Tầng LAMP (Wakeme tự tính)**: N×D = 10.000 × 1001 = **10.010.000 LAMP rút khỏi pot** — LAMP lẽ ra dành cho user thật. Wakeme-Math:281 gọi đúng tên: 'N anchor-giả → N×D LAMP rút khỏi pot'.
• **Tầng MAGIC (CONTRACT không tính)**: mỗi vault giả chạy hồ sơ ôm-tối-ưu bằng bot — tiêu MIN_MAGIC_TX ở thấp điểm (giữ 'active', né anti-idle drain, ăn giờ_thấp_điểm 1.50×), cam kết ScheduleGen max (1.50×), chờ 120 ngày ăn tuổi 2.20× ⟹ trọng số mỗi vault giả = 1001 × 4.95 = 4.955. Tổng trọng số giả = 4,955×10⁷. Với dân số thật 10⁶ vault (f = 0.9 ôm) Σtrọng_số_thật = 10⁶ × 1001 × 5.6925 = 5,70×10⁹ ⟹ kẻ tấn công chiếm **0,87% ngân sách MAGIC toàn mạng** chỉ với 10.000 anchor. Tuyến tính: 10⁶ anchor giả → chiếm ~46% ngân sách. Và vì MAGIC của vault giả BAY HƠI (G9, bot không có nhu cầu thật), đây là **griefing đốt-ngân-sách thuần**: kẻ tấn công không cần thu lợi gì từ MAGIC — hắn chỉ cần pha loãng người dùng thật, đồng thời rút LAMP khỏi pot. Chi phí biên mỗi DID giả ≈ chi phí đúc anchor. Không có cơ chế nào trong CONTRACT phát hiện hay phạt.
- **Đề xuất:** (1) **Sửa NGAY §2 dòng 57-58** — bỏ mệnh đề 'Sybil đa-DID chặn bởi sinh-trắc Enclave (Wakeme T-3)'. Thay bằng nguyên trạng của nguồn: 'Uniqueness PersonDID hiện là BLOCKER MỞ mức CAO (Wakeme-Math:281 T-3, :301 GV1/PA2) — lỗ ở tầng MÃ HOÁ ANCHOR (đúc anchor did-string bất kỳ, HW_Key P-256 không verify on-chain), **sinh trắc KHÔNG đóng được lỗ này**. Nguồn yêu cầu PA2 land TRƯỚC khi mở GetLAMP-PersonDID production. GenMAGIC KHÔNG được giả định uniqueness cho tới khi PA2 land.' (2) **Đưa D2 (§7 dòng 223) từ 'phụ thuộc' lên 'điều kiện chặn phát hành'**: ghi rõ GenMAGIC không được lên mainnet trước PA2, vì hệ số miễn phí × Sybil = pha loãng tuyến tính không chặn được ở tầng MAGIC. (3) **Vá bù trong phạm vi MAGIC (giảm nhẹ, không thay PA2)**: vì phần lớn thiệt hại đến từ 3 hệ số miễn phí, mọi vá ở các finding trên đều hạ giá trị mỗi DID giả từ 4.95× xuống 1.00× (sàn) — tức **giảm lợi ích Sybil ở tầng MAGIC 4,95 lần** mà không cần đợi PA2. Đây là lý do độc lập, đo được, để làm các vá kia trước. (4) Rà toàn bộ CONTRACT tìm các trích dẫn khác đọc ngược nguồn — một lỗi loại này đã lọt qua thì phải giả định còn nữa.

### [CAO] §4.2 tuyên bố chống cá voi phòng thủ một mối đe doạ KHÔNG TỒN TẠI, trong khi bỏ hở hai kênh cá voi THẬT
- **Neo:** CONTRACT §4.2 (dòng 113, 118) + §4.4 (dòng 146) + §7 D4 (dòng 226); ĐỐI CHIẾU PhoenixKey-Wakeme-Math.md:33 (D = min(1001, ⌊pot_oildrop/10⁶⌋)), :118 (I-ACT-1 c = D ∈ [1,1001]), :123 (I-ACT-6 d_cap), :104 (MONO-c chỉ giảm), :304 (MIN_MAGIC_TX 'TẠM'); PhoenixKey-Wakeme-Tech.md:340 (active = M_profile(n) ≥ MIN_MAGIC_TX), :397 (1 CARP = 1 MAGIC)
- **Mô tả:** Trả lời trực tiếp câu (c). §4.2 dòng 118 và §4.4 dòng 146 tuyên bố 'Đo TỶ LỆ, không đo LƯỢNG ⟹ cá voi không có lợi thế; user nhỏ tiêu hết vẫn đạt trần'. Ba vấn đề. **(1) Vô nghĩa trong phạm vi vault**: 'cá voi LAMP' KHÔNG TỒN TẠI ĐƯỢC. Wakeme ép `c = D = min(1001, ⌊pot_oildrop/10⁶⌋)` ở genesis (Wakeme-Math:33, I-ACT-1 :118) và `d_cap = 1001` (I-ACT-6 :123), và `c` chỉ GIẢM (MONO-c, :104). ⟹ **mọi vault khởi đầu với ĐÚNG cùng một lượng LAMP**, và khác biệt duy nhất về `c` đến từ việc đã bị bào bao nhiêu vì nhàn rỗi. Không có ai 'nhiều LAMP hơn'. Tuyên bố chống cá voi đang phòng thủ một mối đe doạ mà cấu trúc đã loại bỏ — và CONTRACT không nói nó đang chống loại cá voi nào. **(2) Kênh cá voi thật thứ nhất — số DID**: trục bất bình đẳng thật là số PersonDID, không phải lượng LAMP; §2 đẩy nó ra ngoài bằng một trích dẫn đọc ngược nguồn (xem finding T-3). **(3) Kênh cá voi thật thứ hai — ngưỡng TUYỆT ĐỐI ở biên với Wakeme**: `MIN_MAGIC_TX` (Wakeme-Tech:340 `active = M_profile(n) ≥ MIN_MAGIC_TX`; Wakeme-Math:304 còn 'TẠM') là ngưỡng theo LƯỢNG, không theo tỷ lệ. Nó nhẹ như bụi với vault c = 1001 và có thể nuốt trọn suất sinh của vault c nhỏ. Đây chính là chỗ 'đo LƯỢNG' quay lại — và nó nằm đúng ở đường nối giữa hai spec nên không spec nào soi. Thêm: `đã_tiêu` (§4.2 dòng 113) có thể được bơm bằng MAGIC/CARP MUA (Wakeme-Tech:397 'GetMAGIC (fiat→CARP); 1 CARP = 1 MAGIC') ⟹ `tiêu_thật` MUA ĐƯỢC BẰNG TIỀN, và khả năng mua tương quan với giàu có [NEEDS-EVIDENCE: chiều CARP→số dư MAGIC của user chưa được chốt ở bất kỳ nguồn nào trong 4 nguồn — §7 D4 dòng 226 đẩy sang PhoenixKey B4].
- **Kịch bản:** **Phản ví dụ cho 'user nhỏ tiêu hết vẫn đạt trần' (§4.2 dòng 118).** Giả sử MIN_MAGIC_TX = 0,5 MAGIC/epoch (một con số 'nhỏ' hợp lý — phải nhỏ, vì nếu lớn nó thành cổng-tiêu-thật mà G1 dòng 22 cấm).
• Vault A (c = 1001, chưa từng nhàn rỗi): suất sinh M_A ≈ 5 MAGIC/epoch. Để giữ 'active' và né anti-idle drain, A tiêu 0,5 MAGIC = **10% suất** — vặt. A giữ nguyên c = 1001 mãi mãi.
• Vault B (c = 40, đã bị bào 961 ngày nhàn rỗi lúc mới vào — Wakeme Reclaim 1 LAMP/ngày idle, Wakeme-Math:22): suất sinh M_B ≈ 0,2 MAGIC/epoch. MIN_MAGIC_TX = 0,5 MAGIC > **250% toàn bộ suất sinh của B**. ⟹ B KHÔNG THỂ đạt 'active' bằng chính suất của mình, dù B tiêu 100% (tỷ_tiêu = 1.0, 'tiêu hết'). B tiếp tục bị bào 1 LAMP/ngày → c → 0 → vault đóng. **User nhỏ tiêu hết KHÔNG đạt trần — user nhỏ bị xoá sổ.** Đây là ngưỡng tuyệt đối kinh điển: nó lũy thoái theo quy mô, và nó nằm ở tầng LAMP nên §4.2 (chỉ đo tỷ lệ ở tầng MAGIC) không nhìn thấy.
• **Vòng lặp khuếch đại**: c nhỏ → M nhỏ → không đủ MIN_MAGIC_TX → bị bào → c nhỏ hơn. Trong khi c lớn → M lớn → MIN_MAGIC_TX là vặt → giữ c. **Đây đúng là 'giàu càng giàu' mà §4.2 tuyên bố chống, chỉ là nó sống ở tầng dưới.**
- **Đề xuất:** (1) **Sửa §4.2 dòng 118 và §4.4 dòng 146** cho trung thực: nói rõ 'cá voi LAMP không tồn tại vì D = min(1001, pot) đồng nhất cho mọi vault (Wakeme-Math:33) — đây là tính chất của Wakeme, KHÔNG phải công của việc đo tỷ lệ. Trục bất bình đẳng thật là (a) số PersonDID [BLOCKER PA2] và (b) các ngưỡng TUYỆT ĐỐI ở biên Wakeme↔MAGIC.' Xoá tuyên bố 'cá voi không có lợi thế' vì nó che mất hai kênh thật. (2) **Chuyển MIN_MAGIC_TX sang ngưỡng TƯƠNG ĐỐI**: `active ⟺ đã_tiêu(epoch) ≥ α × M_v(epoch)` với α ∈ (0,1] (vd 0.1) thay cho một hằng số tuyệt đối. Cách này giữ đúng tinh thần 'đo tỷ lệ' xuyên suốt cả hai tầng, xoá vòng xoáy tử vong của vault nhỏ, và KHÔNG vi phạm G1 (vẫn sinh ở sàn nếu không active — chỉ là bị Wakeme bào LAMP, đó là cơ chế của Wakeme chứ không phải cổng của GenMAGIC). Việc này cần gửi inbox PhoenixKey vì MIN_MAGIC_TX là của Wakeme (Wakeme-Math:304 ghi 'TẠM', chưa chốt — đúng thời điểm để đề xuất). (3) **Chốt chiều CARP→MAGIC trước khi khoá §4.2**: nếu user nạp được MAGIC bằng tiền thì `đã_tiêu` mua được ⟹ `tiêu_thật` mua được ⟹ phải hoặc (a) chỉ đếm MAGIC ĐƯỢC SINH vào `đã_tiêu` (loại MAGIC mua), hoặc (b) thừa nhận công khai rằng tư_cách mua được bằng tiền và bỏ tuyên bố chống cá voi. Hiện §7 D4 dòng 226 để hở — không được khoá §4.2 khi D4 còn mở.

### [CAO] (e) User KHÔNG thể tự tính `tư_cách` ⟹ lý do biện minh của §5 (trễ-một-epoch 'để user đo lường') mất căn cứ, nhưng CONTRACT vẫn trả toàn bộ cái giá
- **Neo:** CONTRACT §5 (dòng 175-186) + §4.3 (dòng 132-134) + §4.2 (dòng 112-114) + §4.1 (dòng 102) + §6 (dòng 214, ranh giới tin cậy)
- **Mô tả:** §5 dòng 175-178 dựng một đánh đổi lớn dựa trên MỘT lý do duy nhất: dùng `tổng_trọng_số(e−1)` thay vì `(e)` vì 'nhịp_gen(e) công bố ĐẦU epoch e ⟹ trong epoch, mọi user **tự tính chính xác** M_v của mình (*để user có thể đo lường* — anh). Nếu dùng tổng_trọng_số(e) thì phải chờ hết epoch mới biết → mất tính đo-lường-được'. **Tiền đề này SAI cho 2/4 hệ số**, nên toàn bộ đánh đổi là một khoản chi không mua được gì. Cụ thể user tự tính được gì: `tuổi_LAMP` ✓ (§4.1 dòng 102 đúng — bước theo epoch nguyên, đọc datum, tự tính được). `cam_kết_lịch` ~ (biết C của mình, nhưng mẫu số `sinh_kỳ_vọng_6_epoch` phụ thuộc chính tư_cách ⟹ đệ quy). `tiêu_thật` ✗ — mẫu số `đã_sinh` là tổng M_v 6 epoch trước, mà mỗi M_v lại phụ thuộc `nhịp_gen` từng epoch (= hàm của trọng số TOÀN MẠNG) và `tư_cách` từng epoch ⟹ user phải lưu lịch sử 6 epoch của một đại lượng do engine tính. `giờ_thấp_điểm` ✗✗ — cần biết, TẠI TỪNG SLOT đã tiêu trong quá khứ, liệu EMA-nhanh có dưới EMA-chậm không (§4.3 dòng 132-133, FlowRate dual-EMA). Đây là **trạng thái toàn mạng, off-chain, engine giữ** (dòng 134 tự nói: 'Engine thấy TOÀN BỘ dòng tiêu (§6) ⟹ tính được cầu-mạng'). User KHÔNG có cách nào tái tạo, không có cách nào kiểm chứng, và **không có cách nào phản đối nếu engine tính sai** — §6 dòng 214 chỉ bảo đảm operator 'KHÔNG thể bịa/sửa delta đã cosign', nó KHÔNG bảo đảm gì về việc phân loại thấp-điểm/cao-điểm, vì phân loại đó không phải delta có cosign. ⟹ **Engine có thể tuỳ ý gán nhãn cao-điểm cho ai đó và không ai chứng minh được.** Cái giá đã trả cho lý do không tồn tại này: vượt ngân sách khi trọng số tăng vọt (dòng 180), phải thêm van cứng 1.25× (dòng 182), phải thêm bộ điều khiển tích phân (dòng 183), và §5 dòng 185-186 phải hạ tuyên bố G3 xuống 'bám theo trung bình trượt' thay vì bằng ngân sách.
- **Kịch bản:** User Minh muốn kiểm chứng M_v epoch 40 của mình. Đầu epoch 40 engine công bố nhịp_gen = 1.009×10⁶. Minh đọc datum: c = 1001, vest_start_slot ⟹ tuổi_epoch = 40 > 24 ⟹ tuổi_LAMP = 2.20× ✓ (tự tính được). Rồi Minh cần `tiêu_thật`: phải cộng `đã_sinh` các epoch 34-39 = Σ M_v(e) — mỗi số này Minh phải đã lưu lại từ trước (không có on-chain, vault datum không chứa MAGIC — Wakeme-Math:110 'MAGIC = account-trong-Vault, KHÔNG mint token'; datum 7 field CONTRACT §2 dòng 44-51 không có field MAGIC nào). Rồi `giờ_thấp_điểm`: Minh đã tiêu 14 lần trong 6 epoch; với MỖI lần, Minh cần biết EMA-nhanh và EMA-chậm của DÒNG TIÊU TOÀN MẠNG tại đúng slot đó. Minh không chạy engine, không có dòng tiêu toàn mạng, và §6 dòng 197-203 nói rõ dữ liệu này sống trong sổ off-chain per-shard, chỉ neo Merkle root cuối epoch (root chứng minh delta TỒN TẠI, không chứng minh delta được phân loại thế nào). ⟹ **Minh tính được đúng 1/4 hệ số.** Engine báo Minh tư_cách = 3.10×; Minh tin hoặc không tin — không có đường thứ ba.
**Hệ quả động cơ (không chỉ là bất tiện)**: giả sử engine (hoặc một shard operator) gán nhãn cao-điểm sai cho 20% giao dịch của Minh. giờ_thấp_điểm của Minh: 1.50× → 1.40×. Suất sinh của Minh giảm 6,7% vĩnh viễn. Minh không phát hiện được, không tố cáo được, không có fraud-proof nào áp dụng (§9 mục 11 dòng 253 tự nhận 'CONTRACT chưa định lượng bond + cửa-sổ-fraud-proof'). Phần suất bị lấy đi được chia cho mọi người khác qua chuẩn hoá §5 — **kể cả cho chính các vault mà operator kiểm soát.** Đây là một kênh rút giá trị âm thầm, tỷ lệ thuận với thị phần shard, và nó tồn tại CHÍNH VÌ hệ số này không kiểm chứng được.
- **Đề xuất:** Chọn một trong hai, không được ở giữa: **(A) Nếu giữ 'user đo lường được' làm nguyên tắc thiết kế** (anh đã nêu 2 lần — §4.1 dòng 102, §5 dòng 177) thì MỌI hệ số phải tính được từ dữ liệu user có: bỏ `giờ_thấp_điểm` dạng EMA hiện tại, thay bằng một định nghĩa thấp-điểm **CÔNG BỐ TRƯỚC và TẤT ĐỊNH** — vd engine công bố ĐẦU epoch e một lịch cửa sổ thấp-điểm cố định (theo slot) cho epoch đó, dựa trên dữ liệu epoch e−1. Khi đó: user biết trước khi tiêu, tự kiểm chứng sau khi tiêu, và cơ chế điều-tiết G8 vẫn hoạt động (thậm chí TỐT HƠN — điều tiết cần tín hiệu ĐẾN TRƯỚC quyết định, không phải chấm điểm sau). Đánh đổi phải nói thẳng: lịch công bố trước tạo cơ hội dồn-vào-cửa-sổ; nhưng đó chính là hiệu ứng tự-cân-bằng mà §4.3 dòng 135 đã tuyên bố là tính năng. **(B) Nếu chấp nhận user KHÔNG đo lường được** thì phải bỏ luôn lý do biện minh của §5 và tính lại đánh đổi `tổng_trọng_số(e−1)` vs `(e)` bằng lý do khác (vd chống đua-đào, dòng 178 — lý do này ĐỘC LẬP và vẫn đứng vững). Và khi đó BẮT BUỘC phải có cơ chế phản đối cho phân loại thấp-điểm (đưa nhãn thấp-điểm vào leaf có cosign, hoặc dựng fraud-proof cho phân loại) — nếu không, §6 dòng 214 phải viết lại thành 'operator KHÔNG thể bịa delta, NHƯNG có thể tuỳ ý gán nhãn cao/thấp điểm và không ai chứng minh được', và đó là một ranh giới tin cậy hoàn toàn khác với cái đang được tuyên bố. Khuyến nghị (A) — nó rẻ hơn, mạnh hơn về G8, và giữ được nguyên tắc anh đã chốt.

### [CAO] (e) G9 'dùng-hay-mất' TẠO RA cơn dồn cuối epoch — chính là cao điểm mà §4.3 phạt; hai tiên đề đánh nhau, và bot thắng
- **Neo:** CONTRACT G9 (dòng 30) + hệ quả G9 (dòng 32-33) + §4.3 (dòng 129, 133, 135-136) + G4 (dòng 25) + G8 (dòng 29) + §4.1 (dòng 98, slots_per_epoch)
- **Mô tả:** Xung đột hành vi trực diện giữa hai tiên đề, chưa ai nhận ra vì cả hai được thiết kế độc lập. **G9** (dòng 30, 32): MAGIC reset mỗi epoch, 'suất mỗi epoch không tiêu thì mất, không cộng dồn'. Đây là một HẠN CHÓT CỨNG lặp lại mỗi 5 ngày, gắn với một khoản mất mát cụ thể, nhìn thấy được. **§4.3** (dòng 129, 135): thưởng 1.50× cho ai tiêu ở thấp điểm, và tự tin rằng 'ai cũng dồn vào thấp-điểm ⟹ chỗ đó thành cao-điểm ⟹ hết ưu đãi ⟹ tự cân bằng'. Vấn đề: **cơ chế tự-cân-bằng đó giả định user CÓ THỂ dịch chuyển thời điểm tiêu. G9 lấy mất chính khả năng đó.** Với một hạn chót cứng + ác cảm mất mát (loss aversion), hành vi dự đoán được là dồn về cuối kỳ — và cuối kỳ của MỌI user là CÙNG MỘT THỜI ĐIỂM (ranh giới epoch là toàn cục, `slots_per_epoch = 432_000`, §4.1 dòng 98). ⟹ **cầu bị đồng bộ hoá bởi chính giao thức**, tạo một đỉnh tuần hoàn 5 ngày/lần mà không ai dịch chuyển được (không thể dời SAU hạn chót — suất đã bay hơi; dời TRƯỚC thì phải dự đoán nhu cầu 5 ngày). Dual-EMA sẽ phân loại đúng cửa sổ đó là cao điểm ⟹ **§4.3 phạt chính xác cái hành vi mà G9 cưỡng chế.** Đây là điểm mấu chốt của câu (e): cơ chế 'đúng lý thuyết' hỏng vì trái tâm lý thật. Tệ hơn — nó KHÔNG hỏng đồng đều: bot không có nhu cầu thật nên tiêu bụi bất cứ lúc nào EMA báo thấp ⟹ bot ăn 1.50×; con người có nhu cầu thật, bị hạn chót ép, tiêu lúc cao điểm ⟹ ăn 1.00×. **Cơ chế chuyển giá trị từ người dùng thật sang bot** — ngược đúng 180° với G4 (dòng 25) và G8 (dòng 29). [NEEDS-EVIDENCE] cho biên độ định lượng của hiệu ứng dồn-cuối-kỳ dưới hạn chót 'dùng-hay-mất': đây là mẫu hành vi đã biết (tài khoản chi tiêu có hạn dùng, ngày phép năm) nhưng em không có số liệu neo được trong 4 nguồn — cần khảo cứu trước khi chốt tham số TRẦN_THẤP_ĐIỂM.
- **Kịch bản:** Epoch 5 ngày = 432.000 slot. Chị Lan có suất 5 MAGIC/epoch, cầu thật ~1 MAGIC/epoch. Ngày 1-4 chị không nghĩ tới. Ngày 5 app báo 'còn 6 giờ, 4 MAGIC của bạn sắp mất' ⟹ chị vào tiêu. **Toàn bộ 10⁶ user nhận cùng thông báo trong cùng 6 giờ** (hạn chót toàn cục). Dòng tiêu trong 6 giờ cuối = có thể vài lần dòng nền ⟹ EMA-nhanh vọt trên EMA-chậm ⟹ toàn bộ cửa sổ đó = CAO ĐIỂM. Kết quả cho chị Lan: đã_tiêu_lúc_thấp_điểm ≈ 0 ⟹ tỷ_thấp_điểm ≈ 0 ⟹ **giờ_thấp_điểm = 1.00× (sàn)**. Chị Lan — người tiêu THẬT, đúng đối tượng G4 gọi là công dân hạng nhất — nhận hệ số sàn.
Bot H cùng lúc: tiêu 1 nanogic vào giờ 3 sáng ngày 2 (EMA-nhanh chạm đáy) ⟹ tỷ_thấp_điểm = 100% ⟹ **giờ_thấp_điểm = 1.50×**.
So tư_cách (cùng tuổi 2.20, cùng cam_kết 1.50): Lan = 2.20 × (1 + 1.5×min(1, 1/5)) × 1.00 × 1.50 = 2.20 × 1.30 × 1.00 × 1.50 = **4.29×**. Bot H = 2.20 × 1.00 × 1.50 × 1.50 = **4.95×**. ⟹ **Bot sinh nhiều hơn người tiêu thật 15%, và bot trả 0 đồng.** Cơ chế chống-đầu-cơ (G9) đã trực tiếp cấp lợi thế cho kẻ đầu cơ, thông qua cơ chế điều-tiết (§4.3).
Lưu ý §4.3 dòng 135 tuyên bố 'tự cân bằng' KHÔNG cứu được ở đây: đỉnh cuối-epoch không tự cân bằng vì nó không do ưu đãi tạo ra — nó do HẠN CHÓT tạo ra, và hạn chót không phản ứng với ưu đãi.
- **Đề xuất:** Ba lựa chọn, xếp theo mức độ em khuyến nghị: **(1) TỐT NHẤT — lệch pha hạn chót theo vault.** Cho suất reset theo chu kỳ 5 ngày RIÊNG của từng vault, neo vào `vest_start_slot` (đã có sẵn trong datum, CONTRACT §2 dòng 46; bất biến qua mọi redeemer — Wakeme-Math:145 identity_preserved): `epoch_riêng_v = ⌊(slot_now − vest_start_slot)/432000⌋`. Vì `vest_start_slot` phân tán đều theo thời điểm GetLAMP, hạn chót của 10⁶ user trải đều trên 432.000 slot ⟹ **đỉnh đồng bộ biến mất về mặt cấu trúc**, dòng tiêu nền phẳng hơn, EMA có ý nghĩa, và §4.3 mới thật sự đo được lựa chọn thời điểm thay vì đo 'anh có bị hạn chót ép không'. Chi phí: engine phải xử lý epoch lệch pha per-vault — nhưng §6 đã là kế toán off-chain per-shard (dòng 197-212), nên đây gần như miễn phí. Giữ nguyên G9 (vẫn dùng-hay-mất, vẫn không tích luỹ) — chỉ bỏ tính ĐỒNG BỘ, thứ không phải là nội dung của G9. **(2) Nếu giữ epoch toàn cục**: loại cửa sổ cuối-epoch khỏi phép phân loại thấp/cao điểm (vd 20% slot cuối không tính vào cả tử lẫn mẫu của tỷ_thấp_điểm) — vá triệu chứng, kém hơn (1) vì vẫn để đỉnh tải thật tồn tại. **(3) Bắt buộc trong mọi trường hợp**: kết hợp với vá `giờ_thấp_điểm` chuẩn-hoá-theo-`đã_sinh` (finding riêng) — nó xoá lợi thế bot ngay cả khi đỉnh còn: bot tiêu bụi sẽ có tỷ_thấp_điểm ≈ 0 thay vì 100%. Hai vá này ĐỘC LẬP và cộng dồn; (3) rẻ nhất, làm trước.

**Đã điểm qua:** **ĐƯỢC GIAO (§9 mục 2, 6, 10) — cả ba đều TÌM RA vấn đề, không mục nào sạch:**

• **Mục 2 (tích-nhân 4 hệ số / dải 12.375× quá rộng? nên tổng-có-trọng-số?)** — TÌM RA. Câu hỏi đặt sai tiền đề: dải 12.375× là ẢO. Ở cân bằng, 3/4 hệ số là hằng số (`tuổi_LAMP` = 2.20 cho mọi vault sau ngày 120 — đồng hồ treo tường; `giờ_thấp_điểm` = 1.50 và `cam_kết_lịch` = 1.50 — chiến lược trội vì miễn phí) và triệt tiêu trong chuẩn hoá §5 ⟹ cơ chế thực chất là 1 tham số (`tiêu_thật`), dải 2.5×. Tích sai hình dạng vì (a) đạo hàm riêng ∝ tích các hệ số còn lại → 'giàu càng giàu' xuyên hệ số, chênh 4,95× tỷ suất biên; (b) nhân bản bán kính sát thương của hệ số hỏng — D1 wash-trade ăn 12.375× chứ không phải 3.75× như §7 dòng 222 tính. Loại suy 'cùng khuôn VP governance' KHÔNG chuyển được (VP nhân 4 tham số ĐỀU TỐN KÉM; ở đây 3/4 miễn phí). Đề xuất tổng-có-trọng-số dải 1.0–2.5× với 3 đánh đổi đo được; chi phí chuyển đổi = 0 vì không mất khả năng phân biệt nào.

• **Mục 6 (G4 có thật sự thoả? tìm hồ sơ ôm-giữ vượt người tiêu-thật)** — TÌM RA, **G4 GÃY**. §4.5 so lệch hai chiều cùng có lợi cho kết luận (cho người ôm quá ít: bỏ 2 hệ số miễn phí → thật ra 4.95× chứ không 2.20×; cho người tiêu quá ít: gán tuổi = 0 trong khi tuổi là đồng hồ tự chạy miễn phí cho tất cả). Phản ví dụ có số: ôm-tối-ưu **4.95×** vs người tiêu thật (K/M = 0.10, không canh giờ) **4.74×** — người ôm sinh nhiều hơn VÀ trả 0 đồng. Ngưỡng gãy tổng quát: mọi người tiêu thật có **K/M < 13.3%** đều thua. Sức mạnh thật của G4 = đúng số hạng `1.5 × min(1, K/M)` ⟹ **G4 xung đột cấu trúc với G3/G8: ngân sách càng hào phóng, G4 càng yếu, hội tụ về 0.** Kèm lỗi phạm trù: 'Kiểm G4 (số học)' chứng minh về hệ số nhân, không về payoff — mà payoff thì CONTRACT không định nghĩa nổi (§7 D4 để mở) ⟹ G4 hiện KHÔNG THỂ ĐÁNH GIÁ bằng chính tài liệu này.

• **Mục 10 (G9 reset có phá cam-kết-lịch? quỹ đạo cung có bị chặn thật?)** — TÌM RA, cả hai vế. (i) **CÓ phá cam-kết-lịch**, nhưng không theo cách §9 đoán ('cam kết sẽ reset') — mà là G9 kh
