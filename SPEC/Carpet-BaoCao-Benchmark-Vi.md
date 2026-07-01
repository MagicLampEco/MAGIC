# Carpet (CARP) — BÁO CÁO BENCHMARK TỔNG HỢP

> Trạng thái: **TỔNG HỢP** (draft **v0.1-bench**). Cập nhật 2026-07-01.
> Phạm vi: gom **TẤT CẢ benchmark đã chạy** cho CARP — 4 vòng mô phỏng điểm-gãy (MECE) + benchmark 3-back-reflexive (arbitrage-vật-lý + price-impact) + rà-tham-số + 5-lỗ-hổng. Mỗi số ghi rõ **[VỮNG]** (sim khoá) vs **[DAO]** (đo thực địa / DAO chỉnh) + **trục-nhạy** (số phụ thuộc tham số nào).
> Nguồn chân lý: `Carpet-CARP-DacTa-Vi.md` v0.3 (§6 bảng tham số), `Carpet-Excu-Vi.md`, `Carpet-Tech-Vi.md`, `SESSION-STATE-carp-2026-06-26.md` (VÒNG 3/4/5), `Whitepaper-MagicLamp-Tokenomic-Vi.md`.
> **Ghi chú trung thực:** file này KHÔNG hứa "thoát ART". KHÔNG khoá số [DAO] chưa đo thực địa. Bảng-ánh-xạ-từ-vựng: §6b-DacTa (GreenBack=GreenPeg, RedBack=RedPeg, Backstop=Insurance).
> Quy ước: giữ tiếng Anh cho tên hàm/tham-số/thuật-ngữ. **KHÔNG đề cập MagicChange. KHÔNG commit/push.**

---

## §0. Tóm tắt một trang — số VỮNG vs biến-chưa-đo

**Đã khoá được (sim kiểm, phản biện sạch):**

| Nhóm | Số VỮNG | Điểm gãy đã xác định |
|---|---|---|
| Backing tuyến-phụ | `MCR_base=200%`, `LR=130%`, `g_min≥67%` (lamp_frac≤33%) | 300%-MCR vẫn vỡ ở LAMP −67%; flash −90% chỉ sống nếu g≥67% |
| Đệm động | `κ_eff∈[0.43,0.6]`, sàn 0.43 (đệm ~2.3× khi stress) | κ-động = đạt-mức-vốn-đúng, KHÔNG phải phép-màu phản-chu-kỳ |
| InstantGen | `f≤0.10`, `η=0.5`, `M=Σwᵢ·Lᵢ` | f≥0.22 nơi Instant=Schedule (vỡ nhịp) |
| Sizing panic | panic-thiết-kế `15%C`, nền back `50%C` (đỡ-thật ~32%C) | **>18-20%C panic → sụp phi-tuyến** (mọi quỹ cạn trần) |
| RedBack rổ | `ρ≤0.3` (TWAP≥180 ngày), `~15%C`, sàn-cứng `~8%NAV` | ρ*≈0.6 = "giả đa-dạng"; NAV 5%→40% chỉ nhích P(đỡ) 0.012→0.128 |
| Vacuum | commit `≤20%C` + stagger (F3) | cửa-rò `L_max=0.373%C` khi core sát trần lamp_frac0=0.325 |
| Pool | `~20%C` (KHÔNG sâu hơn) | nghịch-lý-pool: pool sâu → cần CARP-panic-tuyệt-đối lớn hơn |
| Reward | `RCR=3.0×` | (sửa "2.5×"→"3.0×" của bản cũ) |
| Buffer Paid | `≥15%C` (F2) | = panic-thiết-kế, đệm-thiết-kế |

**Biến CHƯA đo (blocker thực địa — KHÔNG khoá được từ sim):**

| Biến | Vì sao chưa khoá | Ảnh hưởng |
|---|---|---|
| **throughput** (Σ MAGIC_burned/epoch) | Chưa benchmark thực địa; mục-tiêu 5%C + pull-forward 3× là **giả-định** | Biến **sống-còn** của utility-floor — sàn gãy CHỈ khi panic > throughput×Δt |
| **panic_frac** (hành-vi-rút thực) | Số 15%C phụ-thuộc giả-định phân-phối | **Trục-nhạy #1** — quyết định cả sizing quỹ back |
| **X% trong stagger-cap** Vacuum (F3) | Chưa đo mật-độ-commit thực | Chống cliff phụ thuộc số này |
| Trọng-số rổ-dịch-vụ (numéraire) | Chưa chốt storage-thuần vs rổ | Quyết deflation + tỷ-giá CARP/USD |

---

## §1. VÒNG MÔ PHỎNG 1-3 — điểm gãy MCR / backing (sim `mcr_sim3.py`, quét 8 chiều)

**Bối cảnh:** kiểm MCR (Minimum Collateral Ratio) cho CDP-LAMP — nay là **tuyến-phụ** (v0.3), không phải backing-core.

**Số nền P(vỡ nợ) theo MCR_base:**

| MCR_base | P(vỡ nợ) nền |
|---|---|
| 200% | **0.68%** |
| 250% | 0.18% |
| 300% | 0.06% |

**Phát hiện (VỮNG):**
1. **vol LAMP chi phối nhất** — vol 25%→5% đưa P(vỡ) từ mức stress về gần 0 ở cùng MCR 200% → biện minh **NSF động** (`NSF∈[1.0,1.4]`) thay nâng-MCR-tĩnh.
2. **Quản-CDP-topup mạnh hơn nâng MCR.**
3. **Backstop rẻ-hiệu-quả hơn nâng MCR tĩnh.**
4. **Ngưỡng cứng: 300% VẪN vỡ ở LAMP −67%** → đuôi rủi ro để **Backstop + g_min + RedBack** gánh, không chữa bằng MCR.

**Kết luận khoá:** giữ `MCR_base=200%` + NSF động; **BÁC nâng ≥300%** (MCR là đòn-bẩy-nợ không phải bơm-cầu; nâng MCR rút LAMP khỏi DEX → oracle mỏng hơn, phản tác dụng). `MCR_eff=MCR_base×NSF(vol,br,depth)`.

**Trục-nhạy:** P(vỡ nợ) **cực nhạy vol LAMP** (biến chi phối) + độ-sâu-DEX (depth). Ba số 0.68/0.18/0.06% là **P nền ở giả-định-vol cụ thể** — không phải hằng-số tuyệt đối. **BỎ `MCR_floor=1.35`** (hằng-số-chết: MCR_eff≥2.0 luôn > LR=1.30, không bao giờ ràng buộc).

---

## §2. FLASH CRASH — điểm gãy g_min (sim `scheduleback_dyn3.py`)

**Kịch bản:** flash LAMP −80%/−90% trong 1 epoch + RedBack=0 (tắt phòng-thủ-giá để cô lập solvency).

| sàn nonLAMP `g` | LAMP −80% | LAMP −90% |
|---|---|---|
| **g ≥ 67%** | sống | **sống (br 1.27)** |
| g = 50% | sống | **vỡ (br 0.99)** |
| g = 33% | **vỡ (br 0.84)** | vỡ |

**Kết luận khoá [VỮNG]:** **NÂNG g_min ≥ 67% BẮT BUỘC** cho tuyến-phụ-CDP. Flash-crash là phép thử cho **g_min**, KHÔNG phải RedBack (RedBack = phòng-thủ-GIÁ, không phải SOLVENCY).

**Lưu ý MECE quan trọng:** trong mọi kịch bản trên, **deliver=100%, UNMET=0** — nhưng "deliver 100%" là **SỐ-LƯỢNG không phải GIÁ-TRỊ** (br tách rời deliver). Hệ over-collateral tự-ổn-định br khi bank-run; DN không quỵt nghĩa vụ, nhưng br có thể tụt dưới br_safe mà vẫn solvent.

**Trục-nhạy:** ngưỡng g=67% neo vào **biên độ flash-crash −90%**. Nếu chấp nhận stress nhẹ hơn (−70%) thì g thấp hơn cũng sống; 67% là chọn-thủ-cho-đuôi-nặng.

---

## §3. BENCHMARK 3-BACK-REFLEXIVE (arbitrage-vật-lý + price-impact)

**Bối cảnh:** benchmark tích-hợp 3 tầng back với **reflexivity** (giá phản hồi lượng bán) + **price-impact** (bán tài sản đè giá) + **arbitrage-vật-lý** (chỉ hút được lượng thật thị-trường cho phép).

### §3.1 Nghịch-lý-pool (VỮNG)
- **Pool sâu → HẠI:** cùng % depeg, pool càng sâu cần lượng **CARP-panic-tuyệt-đối** càng lớn → vượt sức throughput. Tối ưu: **pool ~20%C + throughput cao**, KHÔNG pool khổng lồ.

### §3.2 Đỡ-peg-bằng-LAMP = vòng tự-hủy (VỮNG — bất biến tối thượng)
- Sim: **pool LAMP nông tụt 61% chỉ để chi 750k par.** → `INV-NO-LAMP-PEG-DEFENSE`: tuyệt đối không đỡ-peg bằng LAMP (tự-tham-chiếu = tái sinh Terra).

### §3.3 Không-chữa-tương-quan-bằng-phình-NAV (VỮNG)
- **NAV RedBack 5%→40% chỉ nhích P(đỡ thành công) 0.012→0.128.** → phình NAV **không cứu** tương-quan; phải tuyển token **ρ-thấp** (ρ≤0.3).
- Điểm gãy **ρ*≈0.6 = "giả đa-dạng"** — trên đó rổ sụp đồng-pha khi LAMP crash. CẤM LAMP (ρ=1 → Terra), CẤM BTC/ETH/fiat.

### §3.4 PSM-par = lực rẻ nhất (VỮNG)
- Sim: PSM-par (`P_redeem≡1`, oracle-free) hút **~1.2M "miễn phí"** trước khi cần động quỹ. Arbitrage TỰ-thưởng qua đóng CDP-phụ (kiểu DAI PSM) → utility-floor kéo CARP về mép `1−(phí+gas)`, depeg-sót cố hữu = phí+gas **(0.5-2%)**.

**Trục-nhạy:** con số `61% / 750k par`, `1.2M miễn phí`, `0.012→0.128` là **artifact của giả-định độ-sâu-pool + phân-phối-panic cụ thể** — chúng chứng minh **HƯỚNG** (pool-sâu-hại, LAMP-đỡ-peg-tự-hủy, phình-NAV-vô-ích, PSM-rẻ-nhất), KHÔNG phải giá-trị-tuyệt-đối để khoá. Hướng thì vững; độ-lớn phụ thuộc thị-trường thật.

---

## §4. SIZING TỔNG (sim sizing)

**Quy luật khoá [VỮNG]:**
- **panic-thiết-kế = 15%C** (trần bảo vệ công khai).
- **nền back = 50%C** → sức-đỡ-thật **~32%C**.
- **vốn-cam-kết ≈ 3.5×panic; sức-đỡ ≈ 2×panic.**
- **>18-20%C panic → sụp phi-tuyến** (mọi quỹ cạn trần đồng thời).

**Bài học first-principles:** **WALL là VỐN, không phải tốc-độ.** → ĐỪNG tối ưu θ/κ/n để chữa đuôi; tăng **CDP-open-depth + vốn-arb-thật + throughput-tiêu-MAGIC**.

**Trục-nhạy (TRUNG THỰC):** con số 15%C và 18-20%C **phụ thuộc HẲN vào phân-phối panic_frac giả-định** — đây là **trục-nhạy #1** (§9 điểm-mở #2-DacTa). Chưa có số thực địa → 15%C là **giá-trị-thiết-kế-đề-xuất**, phải xác nhận bằng đo hành-vi-rút thật trước khi khoá.

---

## §5. VÒNG 5 — thước-đo tiêu-dùng + ScheduleBack (hội đồng đối kháng + sim `scheduleback_dyn2/4.py`)

### §5.1 Cổng-solvency ScheduleBack (VỮNG cơ chế)
- **Cổng theo SỐ-DƯ quỹ-cứu nội bộ, KHÔNG dùng giá LAMP** (INV-NO-EXTERNAL-INPUT): nhận hợp đồng tới khi `Σ nghĩa-vụ-còn-lại ≤ κ·hard_cap`, `κ≈0.6`.
- **Sim `scheduleback_dyn2.py`:** UNMET=0, deliver 100% ở **MỌI** tấn công (dồn-ký 3000 / V8 50000-ký-crash-99.5%-pool-50k → rejected gần hết). Phục hồi 7 epoch khi LAMP hồi.
- **Sim v4 (`scheduleback_dyn4.py`) blackswan-ep2-hồi-ep4:** deliver 100%, **br_end 1.685** (vọt nhờ carry mua-LAMP-đáy), phục hồi 1 epoch. Không-hồi: vẫn 100% (cổng đảm bảo quỹ-cứu ≥ tổng-nghĩa-vụ).

### §5.2 HAI SAI-PHƯƠNG-PHÁP đã ghi nhận (trung thực — không được tái phạm)
1. **"Vỡ 7/7 + cần 2 fix" là SAI** — red-team bản THIẾU CỔNG (dựng bù-nhìn). Cơ chế đúng có cổng-solvency từ đầu.
2. **"Carry cải thiện br +0.18" là SAI** (artifact). Carry đúng = buffer-2-epoch (mua LAMP đáy = bình-ổn ngược-chu-kỳ, bán khi hồi).
3. **FRONT-LOAD (rút-dồn ngưỡng ~3.5×) KHÔNG có thật** — Schedule có TRẦN pp/epoch by-design (`INV-SCHEDULE-CAP-PER-EPOCH`), không rút-dồn được. Hội đồng làm quá một thứ không thể xảy ra.
4. **Tự thêm oracle-giá-lúc-ký** — thừa, đã bỏ (vi phạm INV-NO-EXTERNAL-INPUT).

### §5.3 Thước-đo tiêu-dùng (VỮNG — hội đồng 10-lăng-kính)
- **gross-spend nguyên bản BÁC** (11/50 phiếu: wash-consumption + plutocracy-VP).
- **Thắng = HYBRID hai-hàm-tách:** mint = hàm-LÕM(phí-thực-đốt) per-DID cap-per-DID (`Σreward≤Σ MAGIC_burned`); VP = bão-hoà-ngưỡng, KHÔNG-nhân-LAMP, cross-DID (chống self-deal). **Tiền MUA được mint (có trần) nhưng KHÔNG mua được VP.**

**Trục-nhạy:** các số ScheduleBack (br 1.685, phục hồi 1-7 epoch) phụ thuộc **kịch bản blackswan cụ thể + κ=0.6 + tốc-độ-hồi-LAMP**. Chúng chứng minh **cổng-solvency hoạt động**, không phải bảo-đảm-tuyệt-đối cho mọi thị trường.

---

## §6. 5 LỖ HỔNG (sim số-đo-thật) — điểm gãy + fix + số nhạy

| Mã | Lỗ hổng (Sev) | Số-đo-thật | Fix khoá | Số nhạy tham số nào |
|---|---|---|---|---|
| **F1** | Vacuum-leak (Sev5) | cửa-rò `L_max=0.373%C` khi core sát trần `lamp_frac0=0.325` | `INV-VACUUM-ISOLATION` cưỡng-chế on-chain (policy-riêng + `assert_no_vacuum_token`); commit-Vacuum `≤20%C` | L_max nhạy **lamp_frac0** (khởi-tạo sát trần → rò cao nhất); leak≡0 sau cưỡng-chế |
| **F2** | Prepaid-default (Sev4) | — (thiết-kế, không sim-số) | `vesting_v=0` (escrow-delivery); `claim≤Σ MAGIC_burned_par`; buffer-Paid `≥15%`; shortfall→Backstop KHÔNG-LAMP | buffer 15% = panic-thiết-kế (cùng trục-nhạy panic_frac) |
| **F3** | Vacuum-cliff (Sev4) | — (mật-độ-commit chưa đo) | stagger BẮT BUỘC (cấm `>X%` commit cùng epoch-đáo-hạn) + `\|Δcap\|/epoch≤cap_surplus` + KÈM F1 | **X% CHƯA ĐO** — biến thực địa (§10 #4-Excu) |
| **F4** | deadzone peg→backing (Sev4) | — (lỗi-cấu-trúc, phát hiện qua phân tích) | ranh GreenPeg↔RedPeg **chồng-lấn** `[1.5,1.6]` thay ranh-cứng; sàn-cứng RedBack theo `C_circ`; KHÔNG dùng-chung-biến kích-vs-năng-lực | overlap `[1.5,1.6]` = giá-trị-đề-xuất quanh br_safe=1.5 |
| **F5** | coordinated-ART (Sev3.5) | — (lỗi-phối-hợp) | LỆCH-BIẾN (RedBack đọc P_CARP / Rice đọc ρ_LAMP / Phoenix đọc TWAP-dài) + LỆCH-NGƯỠNG `gap≥5%` + cấm oracle-chung | gap≥5% = ngưỡng-đề-xuất chống đồng-pha |

**Ghi chú F1:** `L_max=0.373%C` là **số-đo-thật** duy nhất trong nhóm 5-lỗ-hổng — nó là cửa-rò-còn-lại TRƯỚC cưỡng-chế. Sau khi cài `assert_no_vacuum_token` (từ-chối cấu-trúc mọi input mang token-Vacuum), leak **≡0 bất-khả-thi-về-cấu-trúc**. Cap 20%C là biên-an-toàn phủ trên L_max.

---

## §7. TỔNG HỢP TRỤC-NHẠY (trung thực — số nào nhạy tham số nào)

| Số benchmark | Nhạy nhất với | Mức tin cậy |
|---|---|---|
| P(vỡ nợ) 0.68/0.18/0.06% | **vol LAMP** (biến chi phối) + depth-DEX | Hướng vững; giá-trị-tuyệt-đối theo giả-định-vol |
| g_min=67% | **biên flash-crash −90%** | Vững cho đuôi-nặng; nới nếu chấp nhận stress nhẹ |
| panic 15%C / sụp 18-20%C | **panic_frac phân-phối** (trục-nhạy #1, CHƯA ĐO) | Giá-trị-thiết-kế; PHẢI đo thực địa |
| pool 20%C | nghịch-lý-pool (vững về hướng) | Vững |
| L_max=0.373%C | **lamp_frac0** khởi-tạo | Số-đo-thật; leak≡0 sau cưỡng-chế |
| ρ*≈0.6 / NAV 0.012→0.128 | phân-phối-panic + độ-sâu | Hướng vững (phình-NAV vô-ích); độ-lớn theo giả-định |
| PSM hút 1.2M / LAMP-đỡ tụt 61% | độ-sâu-pool + phân-phối | Hướng vững; độ-lớn artifact |
| ScheduleBack br 1.685 / hồi 1-7 epoch | kịch-bản-blackswan + κ=0.6 + tốc-độ-hồi | Cổng hoạt-động; không bảo-đảm-tuyệt-đối |
| **throughput ≥5%C + pull-forward 3×** | **CHƯA ĐO — giả-định** | **BLOCKER thực địa** |

**Nguyên tắc đọc bảng:** phần lớn số benchmark chứng minh **HƯỚNG thiết kế** (đúng về định-tính), độ-lớn-tuyệt-đối phụ thuộc giả-định thị-trường/phân-phối. Hai biến **throughput** và **panic_frac** là **chưa đo được từ sim** — phải benchmark thực địa trước genesis (blocker Cổng 0→1, §9-Excu).

---

## §8. BIẾN CHƯA ĐO — chi tiết blocker thực địa

### §8.1 throughput (biến sống-còn utility-floor) — CHƯA ĐO
- **Định nghĩa:** `throughput = Σ MAGIC_burned_thật / epoch` (đo qua burn-ID).
- **Điều kiện sàn-không-gãy:** `throughput × Δt ≥ panic-CARP-tuyệt-đối`. Sàn gãy CHỈ khi panic vượt năng-lực-tiêu.
- **Mục-tiêu [DAO] giả-định:** `≥5%C/epoch` + pull-forward `~3×` — **CHƯA có số thật để hiệu chỉnh**.
- **Đo ở đâu:** lô-thử OriLife/AladinWork (§7-Excu, 100-nông-dân, ~440-480k CARP dự-phóng).

### §8.2 panic_frac (trục-nhạy #1) — CHƯA ĐO
- Số **15%C** phụ-thuộc giả-định phân-phối hành-vi-rút. Phải đo **hành-vi-rút thật** — số này chi phối cả sizing quỹ back (50%C) lẫn ngưỡng sụp-phi-tuyến (18-20%C).

### §8.3 X% stagger-cap Vacuum (F3) — CHƯA ĐO
- Chống-cliff cấm `>X%` commit cùng epoch-đáo-hạn. `X%` phải đo **mật-độ-commit thực** (§10 #4-Excu).

### §8.4 Trọng-số rổ-dịch-vụ (numéraire) — CHƯA CHỐT
- storage-thuần (`1 nanogic=1 KB·ngày` → ~3 CARP≈$1) vs rổ-dịch-vụ (storage+định-danh+compute+lao-động, trung-hoà deflation). Ảnh hưởng tỷ-giá + cảm-nhận-USD, không phải solvency.

---

## §9. KẾT LUẬN BENCHMARK

1. **Khung utility-floored v0.3 vững về định-tính:** peg-core giữ bởi **cầu-dịch-vụ-thực** (throughput), không bởi rổ-tài-sản. Sim xác nhận utility-floor + PSM-par kéo CARP về mép `1−(phí+gas)` không đụng LAMP.
2. **Các số sizing/backing khoá được về HƯỚNG** (MCR 200%+NSF, g_min 67%, panic 15%C, pool 20%C, ρ≤0.3, κ_eff sàn 0.43, RCR 3.0×, commit-Vacuum 20%C, buffer 15%). Độ-lớn-tuyệt-đối phụ thuộc giả-định vol/panic/depth.
3. **5 lỗ-hổng đã có fix cưỡng-chế** (F1 cách-ly-cứng leak≡0, F2 escrow-delivery, F3 stagger, F4 overlap-2-trục, F5 lệch-biến-lệch-ngưỡng). Số-đo-thật duy nhất = F1 `L_max=0.373%C`, đã bọc bằng cap 20%C + cưỡng-chế on-chain.
4. **HAI blocker thực địa CHƯA giải được từ sim:** `throughput` (biến sống-còn) + `panic_frac` (trục-nhạy #1). **Không khoá số cuối trước khi benchmark thực địa** (Cổng 0→1, §9-Excu).
5. **Bài học first-principles:** WALL là **VỐN, không phải tốc-độ** — đừng tinh-chỉnh θ/κ/n chữa đuôi; tăng CDP-open-depth + vốn-arb + throughput-tiêu-MAGIC.

**Pháp lý (trung thực):** ART-risk **CÒN** (utility-floored + CDP-phụ-nhỏ + đỡ-peg-cầu-khách-hàng làm NHẸ nhưng KHÔNG thoát) → geofence-EU-mặc-định + luật-sư-MiCA. KHÔNG hứa "thoát ART".

---

> **Ghi chú nhất quán:** báo cáo này TỔNG HỢP, không định-nghĩa lại thiết kế. Khi mâu-thuẫn về số/tham-số → theo `Carpet-CARP-DacTa-Vi.md` v0.3 (§6). Sim files gốc ở `scratchpad/` (`mcr_sim3.py`, `scheduleback_dyn2/3/4.py`, `buy_and_lock4.py`). KHÔNG commit/push. KHÔNG đề cập MagicChange.
