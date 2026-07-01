# CARP / MagicLamp Design — SESSION STATE 2026-06-26

> Tiếp nối `SESSION-STATE-carp-design.md` (23-25/6). File cũ KHÔNG mâu thuẫn — nó chốt nền (đơn vị
> thread 9 decimals, MCR_floor 1.35, fee, IP, emergency chain) vẫn đúng. File này ghi phần việc LỚN
> ngày 26/6 (chưa có trong file cũ). Khi mâu thuẫn về stabilization/RedPeg → theo file này.
> Repo KHÔNG phải git (`Is a git repository: false`) → không có git state để verify.

---

## A. QUYẾT ĐỊNH ĐÃ CHỐT (ngày 26/6)

1. **Đơn vị peg (xác nhận lại + đã sửa code):** 1 CARP = 1 MAGIC (sức mua); 1 thread = 1 nanogic; 1 CARP = 10⁹ thread (9 decimals). ĐÃ sửa MathCARP-Vi.md từ 10⁶→10⁹ (14 chỗ: atomic unit, MIN_CARP=100_000 thread=0.0001 CARP, MAX=10¹⁸ thread=10⁹ CARP, T7 sai số=10⁻¹¹ CARP, CARP_DECIMALS=9, ví dụ 500×10⁹).

2. **CARP đối nghịch MAGIC (đã thêm vào whitepaper):** cùng mỏ neo (1 CARP=1 MAGIC) nhưng đối nghịch — MAGIC = mặt cam kết/nội bộ (không-chuyển-nhượng, gắn DID, xa chứng khoán); CARP = mặt thanh khoản/lưu thông (chuyển nhượng, phải định vị pháp lý).

3. **Hai quỹ bình ổn ĐỒNG CẤP thuộc Carpet (thay mô hình cũ "RedPeg đốt"):**
   - **BackPeg** = backing thụ động (backing LAMP + Insurance Pool). ĐỘC QUYỀN mint+burn. Thu CARP→BURN (giảm tổng cung, vĩnh viễn). Domain solvency (br<br_safe ∨ bad_debt>0). Không trade DEX trừ §15 khẩn cấp DAO-vote.
   - **RedPeg** = lớp đệm phòng thủ GIÁ chủ động, "vốn đỏ vô chủ của giao thức" (không nhà đầu tư, không token RED, không excess-holder; nguồn = lát phí ổn định genesis + phí vận hành + lãi tái nạp; dư→tràn holder). TRUNG LẬP CUNG (không mint/burn). Chỉ khi peg ĐỎ (d_internal≥d_red ∧ br≥br_safe). Thu CARP→GIỮ reserve (giảm lưu thông, tạm thời)→bán lúc over-peg (buy-low-sell-high). Cách ly rủi ro (T-ISO: về 0 không hại backing).

4. **P_redeem ≡ P\* = 1 (par, hằng số), oracle-free.** RedPeg phòng thủ về peg cố định, không bám backing (bám backing là việc BackPeg). d_internal = 1 − TWAP_par.

5. **Giữ vs đốt:** "đốt = phủ định giá trị CARP" là SAI — đốt TĂNG backing/CARP (buyback-and-cancel). BackPeg đốt (cấu trúc/vĩnh viễn); RedPeg giữ (thanh khoản/tạm thời) — khớp kỳ hạn (maturity matching, IMF WP/18/45).

6. **GreenCheque (Séc Xanh):** công cụ trader cứu peg; trợ giá lồi giảm dần trả bằng tài sản cứng (không CARP mới); redeem gắn ĐIỀU KIỆN PEG-HỒI (giữ anti-farm); fungible epoch-series; GĐ1 DID-gated không-chuyển-nhượng, GĐ2 chuyển-nhượng.

7. **#6 Tổng kho RedPeg CÔNG KHAI** (không mờ trạng thái; Schelling-overhang quản bằng cơ chế CAP/hysteresis, không che giấu).

---

## B-MỚI (cập nhật cuối 26/6) — GỘP MỘT-TOKEN MAGIC (v0.3, đã verify)

**Mô hình CHỐT (thay hẳn "hai-lớp/hai-trạng-thái" bên dưới):** MAGIC = **một token native, một policy-id**, do BackPeg-MintingPolicy kiểm soát, vào lưu thông qua **hai đường đúc**:
1. **CDP** — khoá LAMP ≥200% (MCR_base=200%, NSF≤1.4, floor 110%) → đúc MAGIC; đóng CDP đốt; P_redeem≡1 oracle-free.
2. **SnapshotGen** — hoàn-tiền-tiêu-dùng có-back. Đúc CHỈ vào thặng dư `br−br_safe` (B đã haircut LAMP), cashback ≤ phần-phí-THỰC-ĐỐT của chính DID, cap(br)=0 khi `br≤br_safe ∨ d_internal>0`.

**Bỏ:** lớp tín dụng M_cred, decay token lưu hành, uỷ quyền, InstantGen/VacuumGen/ScheduleGen, mô hình "MAGIC=số kế toán không-token". `ConsumeMAGIC` đổi sang token thật + ghi sự kiện (thay đổi kiến trúc lớn repo MAGIC, chưa cài).

**ĐÃ VERIFY (3 workflow + 3 agent đối kháng):**
- "Đổi tên CARP→MAGIC = stablecoin hơn" → SAI (Claude tự sửa). Phân loại theo bản chất không theo tên.
- "SnapshotGen mint = Terra" → SAI nếu có-back (Claude tự sửa). KHÁC Terra: có trần cap(br) + sàn cứng non-LAMP g_min + phanh tự tắt + chuộc oracle-free. Gen-Terra còn sót: LAMP nội sinh phản xạ + thưởng-theo-nắm-giữ.
- Biến thể "phản-chu-kỳ THEO GIÁ LAMP + flywheel đẩy-giá" (anh đề xuất) → BÁC (5/6 trục vỡ): solvency nghịch pha (giá spot nhanh/br TWAP chậm), pháp lý price-targeting=MiCA-algorithmic+kéo LAMP thành security, doanh thu miễn-phí-lúc-đói. Thay bằng **phản-chu-kỳ theo `br−br_safe` nội sinh**.
- **ĐÁNH ĐỔI GỐC (không thoát bằng tham số):** cashback mạnh để kích nắm-LAMP ⟺ cashback thành lợi-tức-gắn-nắm-LAMP (Howey-4, kéo LAMP thành chứng khoán). Closed-loop chỉ sạch prong-1 KHI không-DEX-mở.
- "Tuân thủ tuyệt đối không vùng xám" = BẤT KHẢ cho token chuyển nhượng.

**ĐÃ CHỐT (anh quyết, vòng 2):**
- **Đổi tên:** BackPeg→**GreenPeg**, GreenCheque→**RedCheque**, SnapshotGen→**SnapshotMint** (cả hai quỹ đều "Back", xanh vs đỏ; mint thật). Đã đổi trong MAGIC-Token-HopNhat; cần lan sang các file CARP khác.
- **RedCheque nhánh A** không-chuyển-nhượng.
- **Howey: SAI khi em áp bề mặt.** Cashback = **thưởng-tham-gia kiểu STAKING** (quyền không-mua + nỗ-lực-của-chính-mình + DAO phi-tập-trung tự-lưu-ký = staking PoS, không phải investment-contract). Hai vai trò tách: cashback (không đầu-tư-tiền) ≠ RedCheque (có đầu-tư-tiền, đã giảm bằng nhánh A). Rủi ro mức staking, không mức security.
- **Pháp lý nhất quán:** MAGIC = tài sản tiện ích chuyển-nhượng cùng nhóm LAMP/CARP; nếu LAMP/CARP lên sàn tuân thủ được thì MAGIC cũng vậy. "Closed-loop-hoặc-vỡ" là sai khung.
- **Solvency:** `M=0` khi backing ĐỎ (khoá mint toàn mạng); cổng theo **regime backing** không theo giá spot.
- **Công thức M = tích phân Σwᵢ·M(Lᵢ) qua 6+ epoch** (staking-theo-thời-gian, công bằng người tạm-bán-mua-lại); tuổi-UTXO chỉ xét tư-cách từng khoản, không nhân độ lớn.
- **7 điểm dòng-tiền-holder → Treasury không-claim** (mạnh cho cả chống-Howey-4 lẫn chống-CIS).
- Self-characterization spec nền đã dọn (16 nhãn/5 file). Governance ngoài phạm vi (đọc LAMP-nắm-tại-snapshot/tb-6, KHÔNG khoá).

**ĐÃ CHỐT (vòng 3, hệ chuyên gia tiền tệ wv37a3z9r — 12 agent):**
- **P1 MCR ≥300% → BÁC, giữ 200%.** MCR là đòn-bẩy-nợ không phải bơm-cầu; LAMP_khoá ∝ MCR^(1−ε), ε≥1 thì nâng MCR GIẢM LAMP hút; rút LAMP khỏi DEX làm oracle mỏng hơn (phản tác dụng); DJED 400-800 là tỷ-lệ-HỆ không phải MCR-per-CDP (sai loại suy). Chỉ nâng ≤250% nếu stress-test chứng minh thiếu đệm; ưu tiên siết-động NSF.
- **P2 burn-on-spend-có-tên → BÁC.** Bất khả toán học: lợi-ích-đốt = Δbr tỉ-lệ-toàn-hệ chia pro-rata mọi holder, không "chỉ tên" về PhoenixKey được (3 cửa đều đụng bất biến đã chốt). Ý anh ĐÃ đạt: giảm cung = đốt-có-trần-br_healthy; lợi-ích-PhoenixKey = phần-provider trong split §5.1. Không gộp.
- **P3 escrow → NHẬN-có-sửa.** Sạch nhất (trung-lập-cung Δ=0). Sửa: cần native-token+validator; phí-phân-biệt mô tả lại (Pigovian điều-tiết-hành-vi không điều-tiết-cung); nhánh tranh chấp = time-lock-release-đối-xứng, slashing→Treasury; cọc = performance-bond tách thanh-toán-fiat.
- **P4 Pot-M → NHẬN-có-sửa.** Là SnapshotMint đổi tên, có-back. Sửa: M = TRẦN-SUẤT-mỗi-epoch KHÔNG bể-tích-luỹ (kẻo overhang); mắt xích "tạo-cầu→LAMP-vào-backing" là GIÁN-TIẾP-qua-thị-trường không cơ học (đừng đóng gói flywheel).
- **HỆ BA VAN** phân-miền MECE theo bản chất giao dịch (§5): tiêu-dịch-vụ-mạng (THU-HỒI có trần Σ↓) / cam-kết-P2P (TRUNG-LẬP Δ=0) / thưởng-nắm-giữ (PHÁT Σ↑ thặng dư). Một bất biến `Σ MAGIC ≤ B/br_safe` phủ cả ba. Ranh giới = CÓ tiêu thụ tài nguyên giao thức hay không.

**CHỜ ANH QUYẾT (sau vòng 3):** (1) wᵢ + số epoch; (2) g_min %; (3) protocol_cut_bps; (4) η cọc escrow; (5) đa dạng collateral (chờ stress-test).

**VÒNG 4 (cuối phiên, chuẩn bị compact):**
- **MCR — mô phỏng kỹ (`scratchpad/mcr_sim3.py`, quét độ nhạy 8 chiều):** giữ **MCR_base 200% + NSF động + Insurance/g_min mạnh + topup**. Số nền P(vỡ nợ): 200%=0,68%/250%=0,18%/300%=0,06%. Phát hiện: (1) vol LAMP chi phối nhất (vol25%→5% ở 200%) → biện minh NSF động; (2) quản-CDP-topup mạnh hơn MCR; (3) Insurance rẻ-hiệu-quả hơn nâng MCR tĩnh. Ngưỡng cứng: 300% vẫn vỡ ở −67% → đuôi để Insurance+g_min+RedPeg. MCR = **hàm biến thiên** `MCR_eff=MCR_base×NSF(vol,br,depth)` + DAO chỉnh trong biên `[150%,300%]`, floor 110% bất biến (§4 spec).
- **SnapshotMint không hại quyền CDP** nếu nhỏ+capped (br'≥br_safe, cap=0 khi depeg): dilution chạm buffer-chung/MAGIC-holder, KHÔNG đụng collateral/nợ CDP-holder (con-nợ, MAGIC dưới-par còn lợi khi trả nợ). Thêm INV-CDP-NO-HARM (§12).
- **Đổi tên (ĐANG CHỐT — workflow `w61yf5sxj` chạy nền):** CDP→**GreenMint** (đồng ý đổi, khó hiểu). "Cheque" **nghi ngại pháp lý** (séc=negotiable→Reves note) → nghiêng **Vault/Két/Vị-thế**; "Miner"→cân **Backer/Người-bảo-chứng**. Vướng kiến trúc: GreenMint(+cung) ngược red-state(−cung) → gộp tên "cheque" dễ nhầm.
- **RedCheque/RedBack — workflow `w61yf5sxj` XONG, ĐÃ tích hợp vào §8:** verdict = **BỎ phần tài chính (A)** + tuỳ-chọn badge phi-tiền (C). Lý do: (1) bất khả cơ học (không observable phân biệt mua-cứu vs lướt-sóng sau khi bỏ pooling); (2) `P_redeem≡1` làm arbitrage TỰ thưởng (PSM kiểu DAI) → động cơ không khan hiếm; (3) RedCheque không nâng trần phòng thủ, chỉ thêm Howey-4+Reves; (4) B bị bác (thưởng-từ-đâu bất khả sạch + ≈pooling dưới CISA). **RedBack = REGIME 3 trạng thái** (peg-xanh/peg-đỏ/backing-đỏ), peg-đỏ phòng thủ bằng 3 lực (arbitrage-PSM chính + RedPeg-mua-DEX bổ trợ + Insurance CHỈ khi sang backing-đỏ). Thêm `INV-NO-REDCHEQUE`. **Đính chính:** Insurance KHÔNG bắn ở peg-đỏ thuần (br≥br_safe).
- **Khung "hai cheque đều CDP" → TÁCH (verdict):** GreenCheque LÀ CDP (4 lăng kính đồng ý) → đổi tên **Vault**; red-state KHÔNG phải CDP (ngược-dấu-cung + nợ-vs-tài-sản + kỳ-vọng-lợi-nhuận + regime-loại-trừ). Gộp tên kéo rủi-ro-Howey sang CDP-sạch.
- **ĐẶT TÊN (khuyến nghị workflow, chờ anh xác nhận):** CDP/GreenCheque→**Vault**; BỎ "Cheque" + tránh "Card" toàn hệ; Miner→SnapshotMint, tránh Miner/Option. Đã ghi §4 spec.
- **PHẢI DỌN trước genesis:** Math §4.1 `q_E` + Feat §3.4 (pooling cũ) → xoá `q_E`/`V_redeem`/series; grep đổi tên Cheque→Vault toàn hệ.

**File chính:** `MAGIC-Token-HopNhat-Vi.md` v0.3 (một-token, SnapshotMint-staking, GreenPeg/RedPeg, RedCheque-A, bootstrap §9.1).

**Blocker cứng trước genesis:** did_commit thật (giao Long) + stress-test LAMP −50/−70/−85% + `g_min≥50%` + haircut-LAMP-trong-cap(br) + viết lại SnapshotGen/MATH+code (hiện vẫn mô hình cũ).

---

## B-MỚI-2 (VÒNG 5, cuối phiên — thước-đo-tiêu-dùng + ScheduleMint, đều qua hội đồng đối kháng + SIM thật)

**Bối cảnh:** anh đề xuất (a) "người TIÊU DÙNG MAGIC = công dân hạng nhất", lấy mức-tiêu-dùng làm thước đo mint+VP; (b) đưa lại ScheduleMint (khoá LAMP để có MAGIC dài hạn). 4 hội đồng + nhiều sim đã chạy.

**1. THƯỚC ĐO (hội đồng 10-lăng-kính + đấu):** gross-spend nguyên bản BÁC (11/50, wash-consumption + plutocracy-VP). Thắng = **HYBRID hai-hàm-tách dùng-chung-một-sổ-nguồn:** (a) MINT = hàm LÕM (sqrt/log) của **phí-THỰC-ĐỐT per-DID**, cap-per-DID, `mint_i ≤ phí-thực-đốt_i`, tổng ≤ `cap_surplus(br)`; (b) VP = **bão-hoà-ngưỡng** (rộng×liên-tục×có-đi-có-lại), tối đa 1 đơn-vị/epoch, KHÔNG nhân LAMP, ex-post. Tiền MUA được mint (có trần) nhưng KHÔNG mua được VP. **GIỮ triết lý "công dân hạng nhất" = tham-gia-đều-đặn-đa-dạng-có-đi-có-lại, KHÔNG phải chi-nhiều-nhất.**

**2. BÁC:** cưỡng-bức-tiêu + trừ-uy-tín (đẻ wash, đánh người yếu); dùng-chung-1-con-số-tuyến-tính cho VP+mint (plutocracy cửa sau); Vacuum (P*=1 làm trục locked-rate sụp = ô thừa); ScheduleCheque (Reves-note, tái tạo RedCheque đã bỏ); ScheduleBack-như-quỹ-thứ-tư-độc-lập (cũ).

**3. HOWEY — ĐÍNH CHÍNH (anh đúng, em áp bề mặt):** MAGIC-tiêu-dùng ràng-tiêu-chặt KHÔNG phải security — consumptive-use, prong-3 (kỳ vọng LỢI NHUẬN) KHÔNG thoả khi chỉ-để-tiêu-không-bán. Điều kiện sạch: (a) không-bán-lại/closed-loop, (b) không-tiêu-thì-mất, (c) vị-thế-không-chuyển-nhượng, (d) CẤM chữ "hưu trí/lợi tức/yield". Gọng kìm pháp lý NỚI → còn lại là **solvency** (vấn đề thật). Cập nhật [[magiclamp-legal-first-principles]].

**4. MÂU THUẪN LÕI (anh quyết B):** "cố định LƯỢNG (DN tự trả, sạch, trung-tính-backing)" XOR "cố định SỨC-MUA (Back gánh)". **Anh chọn B — hệ gánh rủi ro**, lý lẽ: khoá LAMP giảm-float = lợi hệ nên hệ gánh. LAMP-khoá: ở-yên-ví, bảo-toàn, KHÔNG vào B, KHÔNG slash, vẫn tính VP (rời ví = mất staking).

**5. ScheduleBack (cơ chế anh chốt — SIM ĐỘNG xác minh, sau khi SỬA lỗi phương pháp của em):** GreenBack mint MAGIC vào ScheduleBack (CHƯA-phát-hành, KHÔNG tính cung lưu thông cần-back → "không tăng giảm back") → carry mua LAMP khi rẻ (MAGIC ra DEX, LAMP vào B) → trả dần mỗi epoch (DN tiêu=đốt, net 0 cung) → **waterfall 5 tầng**: T1 GreenBack-tỷ-giá / T2 bán-LAMP-thặng-dư / T3 RedBack / T4 tín-dụng-platform(phí 15%) / T5 MagicLamp-Treasury.
- **CỐT LÕI = CỔNG GIỚI HẠN theo SỐ DƯ quỹ-cứu nội bộ, KHÔNG dùng giá LAMP** (nguyên tắc minh-bạch-tuyệt-đối [[magiclamp-no-external-inputs]]): nhận hợp đồng tới khi `Σ nghĩa-vụ-còn-lại ≤ kappa·hard_cap`, `hard_cap` = RedBack+platform+Treasury (KHÔNG gồm nonLAMP-đang-back-cung), kappa≈0,6.
- **Sim (scheduleback_dyn2.py) chứng minh: UNMET=0, deliver 100% ở MỌI tấn công** (dồn-ký 3000 / V8 50000-ký-crash-99,5%-pool-50k đều rejected gần hết, UNMET=0). Phục hồi 7 epoch khi LAMP hồi.
- **ĐÍNH CHÍNH PHƯƠNG PHÁP (anh sửa):** kết quả "vỡ 7/7 + cần 2 fix" trước là SAI — em red-team bản THIẾU CỔNG mà anh chưa từng đề xuất (dựng bù-nhìn). Anh đã nói Schedule phải giới-hạn-theo-sức-tải từ đầu. Em cũng tự thêm oracle-giá không cần thiết → bỏ.
- **Schedule NHỎ (đúng bản chất "một sự ưu tiên"):** quỹ-cứu 180k, kappa 0,6 → tối đa ~180 hợp đồng. Đặc quyền khuyến-khích-nắm-LAMP + tạo-cầu, không phải kênh phát hành lớn.
- **Rủi ro còn lại = thị-trường-thuần** (độc lập cơ chế): LAMP crash sâu không-hồi → br kẹt ~1,22 (<br_safe nhưng >1,0 solvent, deliver 100%, DN không quỵt). Để br≥1,5 cả khi LAMP≈0 = câu hỏi vốn-genesis (nonLAMP), tách khỏi Schedule.
- **MECE: TÁCH ScheduleBack khỏi RedPeg** (bất biến đối nghịch: ScheduleBack bơm-cung-khi-carry+ôm-LAMP+chạy-mọi-epoch vs RedPeg trung-lập-cung+rổ-không-LAMP+chỉ-peg-đỏ).

**Sim files (scratchpad):** `scheduleback_dyn2.py` (ĐÚNG — có cổng, không giá), `scheduleback_dyn.py` (cũ — thiếu cổng, kết quả KHÔNG đáng tin), `buy_and_lock4.py`. **Lỗi đã ghi nhận:** (a) v3 báo "mua-khoá cải thiện br +0.18" SAI (artifact); (b) red-team bản thiếu-cổng → "vỡ 7/7" SAI.

**FLASH CRASH + MECE (anh ép kiểm, sim scheduleback_dyn3.py):** flash LAMP −80/−90% trong 1 epoch + RedBack=0 → vẫn deliver 100%, UNMET=0; nhưng SOLVENCY phụ thuộc HẲN sàn nonLAMP g: g≥67% sống qua −90% (br 1,27), g=50% vỡ ở −90% (br 0,99), g=33% vỡ ở −80% (br 0,84). KẾT: flash là phép thử cho g_min KHÔNG phải RedBack (RedBack=phòng-thủ-GIÁ không phải SOLVENCY). → **NÂNG g_min ≥ 67% BẮT BUỘC.** Red-team MECE 8-agent: vector DUY NHẤT phá deliver = **FRONT-LOAD (rút-dồn, tiêu>pp/epoch, ngưỡng ~3,5×)** → **khoá tốc-độ-tiêu ≤ pp/epoch** (INV-SCHEDULE-CONSUME-LOCK). Bank-run TỰ-ỔN-ĐỊNH br (over-collateralized). "deliver 100%" là SỐ-LƯỢNG không phải GIÁ-TRỊ (br tách rời deliver — minh bạch cảnh báo).

**NGUYÊN TẮC anh CHỐT + đã lưu memory [[magiclamp-no-external-inputs]]:** cơ chế lõi KHÔNG dùng oracle/giá-ngoài, chỉ số-dư-Back nội bộ. Em đã SAI 2 lần: (a) red-team bản thiếu-cổng → "vỡ 7/7"; (b) tự thêm oracle-giá-lúc-ký. Đã sửa.

**ĐÃ GHI SPEC (MAGIC-Token-HopNhat-Vi.md):** §6.2 ScheduleMint "Đăng-ký-trước" (cơ chế + cổng-số-dư + carry + waterfall, ngôn ngữ dễ hiểu cho cộng đồng) + §6.2-A giả-định-tấn-công + §6.2-B tham-số-chốt + §6.2-C điểm-mở; §10 (Schedule tái sinh, bỏ Vacuum/ScheduleCheque); §12 (INV-NO-EXTERNAL-INPUT, INV-SCHEDULE-GATE, INV-SCHEDULE-CONSUME-LOCK, INV-SCHEDULE-NEUTRAL-VS-RED, g_min↑67%); §13.

**ĐÍNH CHÍNH (anh sửa, sim v4 scheduleback_dyn4.py):** (a) FRONT-LOAD KHÔNG có thật — Schedule có TRẦN pp/epoch by-design, không rút-dồn được (muốn nhiều hơn → ký gối-đầu qua cổng). Hội đồng+em làm quá một thứ không thể xảy ra. INV đổi tên INV-SCHEDULE-CAP-PER-EPOCH (bản chất, không phải vá). (b) Carry: v3 "carry-cap bảo thủ" TẮT NHẦM cơ chế mua-LAMP-đáy của anh (mọi run T2=0). Đúng = carry buffer-2-epoch (v2/v4): giữ đệm 2 epoch, phần xa mua LAMP đáy = BÌNH ỔN ngược-chu-kỳ, bán khi hồi. Sim v4 kịch bản blackswan-ep2-hồi-ep4: deliver 100%, br_end 1,685 (vọt lên nhờ mua đáy), phục hồi 1 epoch. Không-hồi: vẫn 100% (cổng đảm bảo quỹ-cứu ≥ tổng nghĩa-vụ → carry mất sạch thì waterfall gánh). DN tự-giảm-tiêu khi stress → giảm áp lực. Schedule dài/nhiều = nhiều vốn carry cứu-giá-sập (NGUỒN LỰC, không chỉ gánh nặng). Spec §6.2/§6.2-A/§6.2-B/§12 đã sửa theo.

**CÒN MỞ:** (1) chuộc khi backing yếu — P_redeem≡1 (bất-công-thời-gian) hay chuộc-theo-br (đụng trụ §8); (2) "giá đồng loạt" có gồm MAGIC-depeg không; (3) HYBRID hai-hàm CHƯA ghi §6 (mint vẫn M=Σwᵢ·M(Lᵢ)) — anh chưa quyết (chuyển sang phản biện front-load); (4) ĐANG LÀM: rà jargon toàn spec + bảng thuật ngữ (anh chốt CÓ).

**Tên (VÒNG cũ, vẫn áp):** SnapshotMint = tên kỹ-thuật on-chain gồm {Instant, Schedule}; đối-mặt-DN tách "Tiêu-ngay" vs "Đăng-ký-trước". CDP/GreenCheque → Vault. Bỏ "Cheque" toàn hệ.

---

## B-CŨ (lưu lịch sử) — GỘP VỀ MỘT ĐỒNG MAGIC (hai-trạng-thái)

Anh Aladin muốn gộp CARP+MAGIC → một đồng tên MAGIC, thiết kế hai-trạng-thái:
- **Trạng thái A** ("điểm/lượt", từ GenMAGIC/SnapshotGen): không-chuyển-nhượng, chỉ tự tiêu (không uỷ quyền), không tiêu thì bốc hơi (decay). Giữ thuộc tính MAGIC cũ.
- **Trạng thái B** ("đồng"): khi tiêu A → mint thành MAGIC lưu thông, chuyển-nhượng-được. Giữ thuộc tính CARP cũ.
- Governance: đo PHÍ MẠNG gắn DID (vd 1000 MAGIC phí khi thuê AladinWork), không phải giá-trị-P2P.

**VERDICT MECE (workflow wgek90h6u): GO-CÓ-ĐIỀU-KIỆN với 1 ràng buộc cứng:**
- **"Tiêu A → mint TỰ DO B ổn định" = TERRA (bất khả).** Receipt-dịch-vụ-quá-khứ KHÔNG phải backing.
- **Đường vòng an toàn = Reward-CARP đổi nhãn:** "tiêu A → đẩy LAMP tương ứng vào Treasury (backing 300%) → Treasury mint B-có-backing". KHÔNG mint tự do. BackPeg/RedPeg/CDP GIỮ NGUYÊN, vẫn cần.
- **"Tuân thủ tuyệt đối không vùng xám" = BẤT KHẢ** cho token chuyển-nhượng. Mức tối đa: A tuyệt đối sạch; B utility sạch tối đa (mint-khi-tiêu sạch hơn CDP-vay ở Howey, nhưng chỉ bảo vệ phát hành sơ cấp, không bảo vệ thị trường thứ cấp); lớp ổn định cô lập, cấp phép từng tài phán.
- **Gộp TÊN "MAGIC" LÀM GIẢM tuân thủ + rối hơn cho dân.** Khuyến nghị: KHÔNG gộp tên — A="điểm/lượt", B=CARP/"đồng"; "một hệ gắn kết" đạt bằng truyền thông, không bằng gộp tên on-chain.
- **Mâu thuẫn trung tâm:** B không thể vừa ổn-định-như-CARP vừa sạch-pháp-lý-như-MAGIC. Chọn B-utility (thả nổi, sạch) HOẶC B-stable (peg, bị quản như stablecoin/ART) — hoặc B-utility mặc định + lớp peg opt-in DID-gated.
- **Governance:** đo-phí-mạng đúng tín hiệu nhưng KHÔNG tự nó chống mua-phiếu (sức chống vẫn ở geometric+cap+BFT≤ΣVP/21+thời gian). C1 phải đọc `consumed_count` (sự kiện tiêu A), TUYỆT ĐỐI không đọc số dư B.

### 4 ĐIỂM ANH ALADIN PHẢI QUYẾT (chưa quyết):
1. Gộp tên hay không? (khuyến nghị KHÔNG)
2. Chấp nhận "mint tự do bất khả", dùng đường Reward-CARP (tiêu A đẩy LAMP→Treasury rồi mint B)?
3. B-utility hay B-stable (hay B-utility + lớp peg opt-in DID-gated)?
4. Giao blocker did_commit cho Long?

---

## C. SPEC FILES HIỆN CÓ (trong /Users/ductiger/Projects/CARP/)

| File | Trạng thái |
|---|---|
| `MathCARP-Vi.md` | v1.0 nền (CDP/peg/precision). ĐÃ sửa thread 10⁶→10⁹ (26/6) + Midnight overclaim→Q9. CÒN: mâu thuẫn payment role (:174 "CARP không daily" vs co-che:189), vết tích MAGIC `Transferable: Có` (:212) — chưa dọn (chờ quyết 3A/3C) |
| `CARP-Math-Vi.md`, `CARP-Feat-Vi.md` | spec gốc. ĐÃ thêm pointer 2-quỹ, P_redeem≡1, reconcile founder-decision, §15 gỡ căng thẳng BackPeg-trade-DEX |
| `co-che-he-token-noi-sinh-kinh-te-khep-kin-Vi.md` | Whitepaper (đổi tên từ Whitepaper-3Token). ĐÃ thêm 2-quỹ + CARP↔MAGIC + sửa đơn vị peg |
| `Stabilization/CARP-Stabilization-{Feat,Math}-Vi.md` | Spec 2-quỹ chính (BackPeg/RedPeg, GreenCheque, INV-RF-*, P_redeem≡1, INV-RF-DEADMAN/FUND, trần kép). ĐÃ dọn sạch ngôn ngữ cá-nhân-hoá |
| `Stabilization/CARP-Privacy-Vi.md` | Privacy (I1-I8, ZK vs Midnight, vai Carpet/PhoenixKey/VeData — KHÔNG Glint). [CHƯA THIẾT KẾ]: Midnight×CARP Q9 |
| `Stabilization/CARP-Legal-Vi.md` | Pháp lý đa tài phán (MiCA/MAS/VARA/FSA/FINMA/HK/VN/Mỹ). Né-stablecoin = lá chắn mạnh nhất |
| `Stabilization/CARP-References-Vi.md` | Dẫn chứng thật (Diamond-Dybvig, DJED, Terra/Briola, BoE 1992, MakerDAO, FRAX) |
| `Resource-Taxonomy-Vi.md` | Khung phân loại tài nguyên (4 nhóm A/B/C/D, 4 tiêu chí MECE, Resource Manifest, DAO duyệt). ĐÃ dọn jargon Anh→Việt (rail→kênh thưởng) |
| `SESSION-STATE-carp-design.md` | State CŨ (23-25/6) — nền, không đè |
| (RedPeg/ dir) | ĐÃ XOÁ (superseded, gộp vào Stabilization/) |

---

## D. BLOCKER + VIỆC TREO

1. **[BLOCKER cross-repo] `did_commit` = `#""` rỗng** (`MAGIC/ConsumeMAGIC/onchain/.../consume.ak:438`, `types.ak:41-50`). C1 governance + tính không-chuyển-nhượng của A đang là MVP rỗng. Cần commitment thật blake2b256 liên kết engagement↔PhoenixKey DID. Thuộc PhoenixKey backend → **giao Long, Claude KHÔNG sửa** (ranh giới CLAUDE.md).
2. **[Spec hở] Bất biến khử-trùng LIÊN-KÊNH** (`Σ thưởng(consumption_id) ≤ 1`): một lô hàng/dữ liệu chạm nhiều kênh → thưởng nhiều lần. Resource-Taxonomy §4.4 đánh `[CHƯA RÕ]`. Chưa có spec. Cộng guard chống collusion-ring cho C1.
3. **[CẦN MÔ PHỎNG] tham số Stabilization:** δ_sell/δ_buy, κ, γ, s_max, br_*, θ_unwind, T_mat, br_safe. Chạy GO/NO-GO trước genesis.
4. **[Sub-spec] numéraire TWAP_par** (quy CARP về par bằng tỉ lệ giá-dịch-vụ nội sinh) — chốt ở pricing.
5. **[Cần quyết] thêm `op_class: NETWORK_FEE | UTILITY`** vào EngageDatum để C1 chỉ đếm phí-mạng-lõi (chạm interface `consume/types.ak`, đụng did_commit D9).

---

## E. PROMPT GỌI LẠI SAU COMPACT (anh paste)

"Tiếp tục thiết kế MAGIC/MagicLamp. Đọc `/Users/ductiger/Projects/CARP/SESSION-STATE-carp-2026-06-26.md`
(mục B-MỚI-2 / VÒNG 5 là MỚI NHẤT) và `MAGIC-Token-HopNhat-Vi.md` v0.3. Sim ScheduleBack ở
`scratchpad/scheduleback_dyn.py`. THƯỚC ĐO đã chốt = HYBRID hai-hàm. ScheduleMint = cơ chế ScheduleBack
(GreenBack mint→carry→waterfall 5 tầng), verdict SỐNG-CÓ-ĐIỀU-KIỆN với FIX1 mint-dần + FIX2 cổng-solvency.

ĐANG CHỜ TÔI QUYẾT (VÒNG 5): (1) vốn nonLAMP ~1,8M hay br_safe-trên-giá-stress; (2) cơ chế hàng-đợi khi
cổng từ chối; (3) oracle giá-LAMP-lúc-ký chống thao túng; (4) tách ngân sách RedPeg khỏi waterfall.
Tôi chọn [...]. Việc tiếp có thể: ghi HYBRID+ScheduleMint+waterfall vào MAGIC-Token-HopNhat-Vi.md (§6/§10/§12);
áp 2 FIX vào sim+chốt tham số; soạn giao did_commit (D1) + bất biến khử-trùng-liên-kênh (D2) cho Long.

CÒN TREO VÒNG 4 (chưa đụng VÒNG 5): RedBack A-thuần/badge-C; MCR 200%+NSF; tham số wᵢ/g_min/η; collateral.
DỌN trước genesis: q_E+pooling khỏi Math§4.1+Feat§3.4; grep Cheque→Vault; viết SnapshotMint/MATH."

---

## F. NGUYÊN TẮC LÀM VIỆC ĐÃ HỌC TRONG PHIÊN (để không tái phạm)
- Mọi prompt agent: ÉP "tiếng Việt thuần, không pha tiếng Anh giữa câu" + cấm anchor ẩn dụ.
- Agent PHẢI đọc spec/code thật (Read/Grep), cấm "không cần đọc" — vòng đọc code thật bắt được did_commit rỗng + thread 10⁶ drift + Glint-không-phải-privacy.
- Spec viết KHÁCH QUAN — không "anh Aladin"/"QUYẾT ĐỊNH #"/ngôn ngữ giải-thích-cá-nhân (đã dọn).
- Verify, không từ trí nhớ. Tách "vấn đề thật đã verify" khỏi "phản xạ thận trọng/bias".
