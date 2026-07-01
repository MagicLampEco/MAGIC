# Fee Abstraction + MagicSwap — Đặc tả chi tiết (Feat + Math + Benchmark)

> Người dùng chỉ giữ **MAGIC** (token ổn định, neo sức mua tiêu dùng, thế chấp vượt mức đa tài sản nhiều tầng). Hệ ngầm lo ADA (phí mạng Cardano) và DUST (phí giao dịch bảo mật Midnight). Mỗi lệnh ký thu một khoản MAGIC cố định, quy ra ADA về Treasury ngay; phần lớn hơn chi phí thực được tích luỹ làm đệm.
>
> Trạng thái: **ĐỀ XUẤT** (draft, chờ duyệt). Mọi benchmark là output Monte-Carlo (numpy, N=20.000/kịch bản). Chốt định hướng 2026-06-29.

---

## §0. Tóm tắt một trang

- **Dịch vụ ví dụ:** định danh 1 cây sầu riêng = **30 MAGIC**, ổn định dài hạn (neo sức mua, không phải con số ADA).
- **Phí mạng:** trong 30 MAGIC có **5 MAGIC** quy ra ADA, thu về PhoenixKey Treasury **ngay lúc nông dân ký**.
- **Chi phí ADA thực ≈ 4 ADA/giao dịch** (phí mạng Cardano = lovelace gần cố định theo protocol params, **không** theo giá USD).
- **net(p) = 5/p − 4** ADA, với `p` = giá ADA tính bằng MAGIC. Hoà vốn `p* = 1,25`. Hiện `p = 0,15` → **+29,33 ADA/giao dịch**, markup **~8,3×**.
- **Khi ADA đắt dần:** hệ **báo trước** sẽ tăng phí vào ngày X; trong thời gian chờ, Treasury **gánh** phần chênh bằng kho ADA tích luỹ giai đoạn rẻ → user không sốc.
- **Nguồn ADA/NIGHT:** **MagicSwap** — DEX nội bộ hệ sinh thái (cặp MAGIC/ADA, MAGIC/LAMP, MAGIC/NIGHT), seed bằng Protocol-Owned-Liquidity từ kho ADA Treasury.
- **NIGHT→DUST:** hệ **giữ NIGHT** (token giao dịch được) để **tự sinh DUST** trả phí Midnight thay user. KHÔNG "thu DUST" (DUST không chuyển nhượng).
- **MAGIC là stablecoin đa tài sản nhiều tầng:** `Σ MAGIC ≤ B/br_safe`, br_safe=1,5; B = LAMP(haircut) + tài sản cứng ADA/stable; **sàn non-LAMP g_min ≥ 67%**; MCR=200%×NSF; PSM `P_redeem≡1` oracle-free; RedPeg 3-trạng-thái; Insurance.

**Phán quyết tổng:** mô hình **bền về định lượng** trong vùng tham số thực tế. Điều kiện sống còn không phải "phí luôn > ADA" (tuyệt đối — bất khả) mà là **bất đẳng thức markup–nhịp-nâng** `m ≥ T/S − 1` + **giữ markup ≥ 1** (cận spam/depeg) + **đệm kho tích từ giai đoạn rẻ**.

---

## §1. Vấn đề & nguyên tắc nền

### 1.1 Vấn đề
Người dùng kinh tế thực (nông dân, doanh nghiệp nhỏ) không nên phải hiểu ADA, DUST, LAMP, UTxO, collateral. Họ cần một con số ổn định để lập kế hoạch: "định danh 1 cây = 30 MAGIC". Mọi phức tạp onchain phải nằm dưới mui xe.

### 1.2 Vì sao mô hình này khác crypto đầu cơ (nguyên lý gốc)
- **Phí mạng Cardano cố định theo lovelace** (txFeeFixed ~0,155 ADA + perByte + ExUnit + min-UTxO), KHÔNG đổi theo giá ADA/USD. "ADA đắt" chỉ là đắt theo MAGIC/USD; SỐ lovelace cần trả mỗi giao dịch gần bất biến.
- **Volume decorrelated giá ADA.** Driver của cầu là biến kinh tế thực: mùa vụ, sản lượng, kế hoạch sản xuất, tiêu dùng, giải trí. Không có kênh nhân quả giá→volume như crypto đầu cơ (nơi hoạt động chính là lướt giá). → Lập luận "wrong-way risk" (volume cao đúng lúc ADA đắt) **không áp dụng**.
- Hệ quả: kịch bản giết Treasury KHÔNG phải "suy thoái" (volume giảm làm CHẬM cạn kho), mà là "ADA tăng dài + phí không được nâng".

### 1.3 MAGIC là token ổn định nhiều tầng (tiền đề)
MAGIC là **native token một policy-id, trao đổi được** (spec v0.3), đóng vai **đơn-vị-kế-toán neo sức mua tài nguyên** — token ổn định, không phải token tự do rớt giá. Phòng thủ nhiều tầng (chi tiết: `MAGIC-Token-HopNhat-Vi.md` §6–§8, §12): `Σ MAGIC ≤ B/br_safe` (br_safe=1,5); thế chấp vượt mức đa tài sản (sàn non-LAMP **g_min ≥ 67%**); PSM `P_redeem≡1` oracle-free; RedPeg 3-trạng-thái; MCR 200%×NSF; Insurance.

→ Tham số này là tiền đề định lượng cho benchmark §3. **Đây là spec PHÍ + SWAP — solvency chỉ trích làm nền, không lặp lại.**

---

## §2. Cơ chế phí (Math)

### 2.1 Công thức lõi
Gọi `F` = phí MAGIC quy-ra-ADA mỗi lệnh ký (=5 MAGIC danh nghĩa), `C` = chi phí ADA thực (≈4 ADA), `p` = giá ADA tính bằng MAGIC.

```
ADA thu được mỗi giao dịch  = F / p              (giữ ngay dưới dạng ADA vào Treasury)
net(p)                      = F/p − C  =  5/p − 4
Điểm hoà vốn                 p* = F/C = 1,25 MAGIC/ADA
```

`net(p)` lồi, nghịch biến: dưới `p*` luôn dương; **ADA càng rẻ thu càng nhiều ADA**.

| p (MAGIC/ADA) | ADA thu | net ADA/gd |
|---|---|---|
| 0,10 | 50,0 | **+46,0** |
| **0,15** (hiện tại) | 33,3 | **+29,33** |
| 0,50 | 10,0 | +6,0 |
| 1,00 | 5,0 | +1,0 |
| **1,25** | 4,0 | **0,00** (hoà vốn) |
| 2,00 | 2,5 | −1,5 |
| 5,00 | 1,0 | −3,0 |

### 2.2 Phí neo SỨC MUA, không phải con số danh nghĩa cứng
"30 MAGIC/cây" = 30 đơn-vị-sức-mua-dịch-vụ (base_price), KHÔNG phải 30×giá-ADA. Khi MAGIC rẻ đi (so dịch vụ), SỐ MAGIC/lệnh tự co giãn để giữ giá trị thực. Đây là phanh chống spam/arbitrage (xem §6 họ C/E): nếu khoá cứng 30 danh nghĩa, kẻ tấn công mua MAGIC rẻ rồi rút giá trị; neo sức mua thì số MAGIC tự tăng khi MAGIC rẻ.

### 2.3 Nấc nâng phí + Treasury gánh chuyển tiếp
- Khi `p` tiến tới `p*` (markup mỏng), hệ **báo trước** `d` ngày sẽ nâng phí lên một nấc.
- Trong cửa sổ `d` ngày chờ, nếu giá tiếp tục tăng, **Treasury gánh** phần `net < 0` bằng kho tích luỹ — user không sốc.
- Nấc nâng giữ markup mục tiêu `m`: `F_mới = p · C · (1+m)`.

**Trigger nâng phí — đọc giá từ đâu (gỡ mâu thuẫn INV-NO-EXTERNAL-INPUT):**
- Giá tham chiếu `p_ref` = **TWAP dài (≥ vài giờ) của pool MagicSwap MAGIC/ADA**, KHÔNG phải spot. Đây là **loại-3** (quy-đổi-phí-vận-hành, §4.2) — chỉ chạm quyết-định-nấc-phí, KHÔNG chạm cổng solvency → không vi phạm nguyên tắc.
- **Quy tắc rời rạc, cam kết trước** (commit-reveal + hysteresis, I-D3): khi `p_ref` vượt ngưỡng `p_trig` trong `k` epoch liên tiếp → công bố lịch nâng (sau `d` ngày). Hysteresis (ngưỡng lên ≠ ngưỡng xuống) chống dao động + chống front-run.
- **Ai ký:** DAO (hoặc module thuật toán trong biên hiến pháp, I-D2 ±5%/chu kỳ + timelock). KHÔNG để cá nhân chỉnh tức thời.
- Vì quy tắc công khai + có độ trễ, đệm kho phải phủ cửa sổ `d` (I-TREASURY-BUFFER-MIN, §3.1).

### 2.4 Bất đẳng thức bền vững (điều kiện sống còn)
Kho không bao giờ cạn (bền vĩnh viễn) khi markup `m` vượt ngưỡng phụ thuộc tốc độ tăng giá `r_p` và nhịp nâng `T` epoch:
```
m ≥ m_break = T/S − 1,   S = Σ_{k=0}^{T−1} (1+r_p)^(−k)
```

| r_p (tăng giá) | nâng mỗi T epoch | markup tối thiểu |
|---|---|---|
| 1%/epoch | 4 | +1,5% |
| 3%/epoch | 8 | +10,6% |
| 5%/epoch | 8 | +17,9% |
| 10%/epoch | 8 | +36,3% |
| 10%/epoch | 20 | +113,6% |

→ Nâng càng dày (T nhỏ), markup cần càng nhỏ. Markup hiện tại 8,3× phủ thừa.

---

## §3. Benchmark mô phỏng (output Monte-Carlo thật)

> Số dưới đây là output Monte-Carlo (numpy, N=20.000 đường/kịch bản). Script + output cần đưa vào repo có version (xem §10.3).

### 3.1 Độ bền quỹ phí Treasury (`treasury_sim5.py`, `treasury_sim6.py`)

| Chỉ số | Kết quả |
|---|---|
| P(cạn kho) ở tham số chuẩn (mọi kịch bản giá × vol 15/25/40%) | **~0%** (≤0,01%) |
| Đệm sống qua cửa sổ báo-trước d=30 ngày (10k gd/epoch, ADA tăng xấu nhất) | **~49.250 ADA** (tuyến tính theo volume) |
| Đệm nếu KHÔNG BAO GIỜ nâng phí (ADA ×5/năm, P(cạn)<1%) | **~1,5 triệu ADA** / 10k gd/epoch |
| Tích 1 năm ở p=0,15 (10k gd/epoch) | **21,4 triệu ADA** → gánh **19,6 năm** ở p=2,0 / **9,8 năm** ở p=5,0 |
| Bootstrap muộn (vào khi p=1,0, markup mỏng) | **P(cạn)=20,5%** → phải tích kho từ giai đoạn rẻ |
| Stress ADA×5 TRÙNG volume giảm 70% | P(cạn)=0% — volume giảm LÀM CHẬM cạn kho (lỗ tỉ lệ volume) |

**Kết luận:** markup + nâng-báo-trước là **BẮT BUỘC** (nếu phí kẹt không nâng: P(cạn)=4,63% dù đệm 0). Nhịp nâng: step ≥ 2× với lag ≤ 6 epoch → bền. Báo trước càng dài thì step nâng phải càng mạnh.

### 3.2 Solvency MAGIC dưới khủng hoảng kép D1 (`d1_clean.py`)

D1 = khủng hoảng kinh tế thực TRÙNG crypto sụp (macro factor chung kéo LAMP + ADA + volume cùng xuống, tương quan ρ). Mô hình first-principles: `br = B/C_circ`, B = LAMP(haircut) + stable + ADA; vỡ peg ⟺ `br_post < 1,0` (backing không phủ nổi lưu hành ở par); mất xanh ⟺ `br_post < br_safe (1,5)`. ADA rớt **thật** tới mức quét; quét cả stable depeg + tranche nghiêng ADA. Monte-Carlo N=20.000, br0=2,0.

> **Đính chính so với bản trước:** con số "P(vỡ)=0% qua sốc kép −95%" ở vòng mô phỏng đầu là SAI — do (a) sim cũ giới hạn ADA chỉ rớt ~57% dù dán nhãn −95%, (b) một script kiểm hiệu chỉnh ngược về đáp án. Bảng dưới chạy từ `d1_clean.py` (ADA rớt thật, không fit ngược).

| Kịch bản tranche cứng | g_min | macro | **P(vỡ peg)** | P(mất xanh) | br_floor p1 |
|---|---|---|---|---|---|
| 70% stable giữ / 30% ADA | 0,50 | −60% | 6,48% | 98,2% | 0,881 |
| 70% stable giữ / 30% ADA | **0,67** | **−60%** | **0,00%** | 85,6% | 1,178 |
| 70% stable giữ / 30% ADA | 0,67 | −85% (cực đoan) | **1,08%** | 99,6% | 0,996 |
| 70% stable giữ / 30% ADA | 0,75 | −85% (cực đoan) | **0,00%** | 97,1% | 1,142 |
| **stable DEPEG đuôi (−25%)** + macro −85% | 0,67 | −85% | **34,5%** | 99,9% | 0,724 |
| stable depeg + macro −85% | 0,75 | −85% | 13,0% | 99,7% | 0,833 |
| **tranche NGHIÊNG ADA (60%)** + macro −85% | 0,67 | −85% | **60,0%** | 100% | 0,560 |
| nghiêng ADA (60%) + macro −85% | 0,75 | −85% | 39,2% | 99,9% | 0,658 |
| tệ nhất: ADA 60% + stable depeg | 0,85 | −85% | 46,4% | 99,9% | 0,572 |

**Kết luận D1 (trung thực, có điều kiện):**
- **Vùng vận hành thường** (macro tới −60%, tranche cứng ≥70% stable giữ giá): g_min ≥ 67% → **P(vỡ peg)=0%**. MAGIC giữ peg, đáy hội tụ về tài sản cứng — KHÔNG phải Terra. Đây là vùng thực tế cao.
- **Đuôi cực đoan:** g_min 67% **KHÔNG đủ một mình**. Ở macro −85% còn P(vỡ)≈1%; và nếu stable depeg HOẶC tranche nghiêng ADA thì P(vỡ) vọt lên **34–60%**.
- **Lằn ranh sống/chết KHÔNG nằm ở LAMP** mà ở **chất lượng + tỷ trọng tranche cứng**. PSM giúp ít ở đuôi (+0,02–0,07 br) — không cứu khi tài sản nền sụp; vai chính là sàn cứng + chất lượng tranche.

**Điều kiện ĐỦ thực sự (đưa vào §10.1):**
1. g_min ≥ 67% (sàn tối thiểu).
2. Trong tranche cứng, **≥70% là stable THẬT giữ giá** (không phải ADA) — bắt buộc.
3. **Cap ADA trong tranche cứng ≤ 30%.**
4. Đuôi cực đoan (macro ≤ −85% hoặc nghi stable depeg): nâng g_min → 75% + Insurance 5–10%.

**Rủi ro còn lại:** (a) "mất xanh" (khoá mint) gần như chắc xảy ra ở sốc ≥−85% — đúng thiết kế GreenPeg, là đóng băng tăng trưởng chứ không vỡ; (b) **stable depeg là rủi ro chưa khử được** — chọn rổ stable đa dạng + giám sát; (c) bất công thời gian khi P_redeem≡1 lúc có run (rủi ro công bằng, không phải solvency).

### 3.3 MAGIC depeg đa-epoch — phí có sống không (`d2_depeg_pol.py` SIM C)

Phí sống nhờ giá MAGIC ≥ ngưỡng hoà vốn `q_be = C/F = 0,8 ADA/MAGIC`. Hiện `q0 = 6,67` → markup **8,3×** (MAGIC phải rớt ~88% mới chạm hoà vốn). Mô phỏng depeg kéo dài (cầu yếu, bán một chiều) + hai phanh: PSM kéo về intrinsic, và `I-TREASURY-PEGRED-OFF` (ngừng bán MAGIC vào pool khi depeg).

| Áp lực bán ròng/epoch | PSM | PEGRED-OFF | q cân bằng | #epoch lỗ phí |
|---|---|---|---|---|
| 2% | tắt | tắt | 0,12 | 96 (sau ep 104) |
| 5% | tắt | tắt | 0,05 | 159 |
| 10% | tắt | tắt | 0,05 | 180 |
| 2–10% | **0,05** | tắt | 1,0–1,76 | **0** |
| 2–10% | tắt | **bật** | ~2,1 | **0** |

**Kết luận:** depeg đa-epoch chỉ phá phí khi **mất CẢ hai phanh** (không PSM + không tắt-quy-ADA) VÀ áp lực bán ròng dai dẳng. Chỉ cần **một** phanh hoạt động (PSM nhỏ 5% HOẶC PEGRED-OFF — cả hai đã trong thiết kế) là q giữ trên hoà vốn ở mọi mức bán thử. Rủi ro = kịch bản mất đồng thời cả hai phanh.

### 3.4 POL bootstrap mỏng — slippage cú swap Treasury (`d2_depeg_pol.py` SIM D)

POL mỏng giai đoạn đầu là nguy thật. Net-bán MAGIC/epoch = `volume × 5 × (1−β)`, `β` = tỷ lệ cầu mua MAGIC hữu cơ bù lại. POL tối thiểu để slippage ≤ 1%:

| volume/epoch | β (cầu bù) | **POL_min (ADA)** |
|---|---|---|
| 10k | 0,7 | **9,9 triệu** |
| 10k | 0,9 | 3,3 triệu |
| 100k | 0,7 | 99 triệu |
| 100k | 0,9 | 33 triệu |

- Kho tích ~21,4M ADA/năm ở p=0,15 → đạt POL_min (9,9M, vol 10k/β0,7) sau **~169 ngày**.
- **Giai đoạn NGUY** = trước khi kho đạt POL_min → **bắt buộc fallback ADA-app-tự-nạp** (§4.4) ở đầu đời.
- `β` (cầu hai chiều) là đòn bẩy lớn: β 0,7→0,9 giảm POL_min **3×**. → ưu tiên giữ cầu MAGIC mạnh + slippage-cap chia nhỏ swap. POL_min ∝ volume → quy mô lớn (100k/ep) cần nuôi POL dần, không bật MagicSwap làm nguồn ADA chính tới khi đủ sâu.

---

## §4. MagicSwap — thiết kế DEX nội bộ

### 4.1 Cặp giao dịch
| Cặp | Vai trò | Ai dùng |
|---|---|---|
| **MAGIC/ADA** | Xương sống. Nguồn ADA trả phí mạng + nơi quy 5 MAGIC→ADA về Treasury. Cửa vào/ra cho người mua MAGIC. | Treasury, user mới, POL |
| **MAGIC/LAMP** | Nối hai trụ token. Nơi RedPeg mua MAGIC + ScheduleBack mua LAMP đáy. | RedPeg, ScheduleBack |
| **MAGIC/NIGHT** | Nguồn NIGHT để hệ giữ → sinh DUST. **KHÔNG niêm yết user-facing** (chống cổng privacy-coin, §6 họ E + pháp lý). | Treasury only |

AMM constant-product (x·y=k) v2 mỗi cặp; không v3 concentrated giai đoạn đầu.

### 4.2 Tỷ-giá-engine — TÁCH 3 loại giá (chìa khoá giải INV-NO-EXTERNAL-INPUT)
| Loại giá | Vai trò | Nguyên tắc |
|---|---|---|
| **1. Định phí dịch vụ** (số MAGIC/cây) | base_price nội sinh, oracle-free | KHÔNG lấy từ MagicSwap. Cố định công khai, đổi qua DAO. |
| **2. Định giá thế chấp** (br, MCR, thanh lý) | TWAP đa-DEX | Đã chấp nhận (cấu trúc DAI). |
| **3. Quy MAGIC→ADA** (thanh khoản hoá phí) | TWAP MagicSwap | Chỉ chạm biên-lời nhà cung cấp, KHÔNG chạm cổng solvency. |

→ Giá MagicSwap chỉ đứng ở **loại 3**, không leo lên loại 1. Một kẻ thao túng giá pool chỉ làm nhà cung cấp mua ADA đắt/rẻ hơn (rủi ro kinh doanh), KHÔNG phá `Σ MAGIC ≤ B/br_safe`, KHÔNG mở suất đúc. Vì vậy **không vi phạm tinh thần INV-NO-EXTERNAL-INPUT** — với điều kiện giá dịch vụ KHÔNG auto-điều-chỉnh theo feed DEX.

**Đề xuất câu chữ làm-rõ-phạm-vi cho INV-NO-EXTERNAL-INPUT:**
> "Cấm áp dụng cho: cổng Schedule, kích waterfall, ngưỡng đúc/khoá-mint, mọi quyết-định-solvency on-chain. KHÔNG áp dụng cho quy-đổi phí-vận-hành (MAGIC→ADA/DUST). Ranh giới kiểm tra: nếu đổi giá đó làm đổi LƯỢNG MAGIC đúc hoặc trạng-thái-regime ⇒ vi phạm; nếu chỉ đổi biên-lời nhà cung cấp ⇒ không."

### 4.3 Cân dòng hai chiều
- Dòng **bán MAGIC → ADA** (phí, áp lực giảm giá MAGIC) ⟷ dòng **mua MAGIC ← ADA** (cầu dịch vụ, áp lực tăng).
- MAGIC user tiêu chính là MAGIC phải mua trước → ở steady-state hai chân **gần triệt tiêu** trên pool. Bác reflexivity-Terra máy móc: volume là cầu dịch vụ thực, không phải vòng giá→bán→giá.
- Lệch tạm thời → POL hấp thụ. Lệch cấu trúc (cầu chết) → POL chỉ trì hoãn (rủi ro thật, §6 họ C).

### 4.4 Bootstrap bằng POL
- Kho ADA Treasury tích giai đoạn rẻ (§3.1: 21,4M ADA/năm ở p=0,15) → seed POL pool MAGIC/ADA.
- ADA là **vốn xoay vòng** (bán MAGIC lấy ADA ↔ mua MAGIC bằng ADA), chỉ cần đệm chênh lệch ròng + biến động, **không cần vô hạn**.
- Điều kiện thanh khoản tối thiểu (số từ §3.4): **POL_min ≈ 9,9M ADA** ở vol 10k/ep, β=0,7 để slippage ≤ 1% (tăng theo volume, giảm theo β). Trước khi kho đạt POL_min (~169 ngày tích ở p=0,15) → **fallback ADA-app-tự-nạp bắt buộc**; cũng dùng fallback khi peg đỏ.

---

## §5. NIGHT → DUST (Midnight)

- **Mô hình đúng:** hệ GIỮ NIGHT (mua minh bạch qua Treasury) → tự sinh DUST (tài nguyên phí Midnight, không chuyển nhượng) → trả phí giao dịch bảo mật thay user. Giá trị của USER **không xuyên lớp privacy** → an toàn AML.
- **KHÔNG** "thu DUST của user" (DUST không chuyển nhượng được — bất khả).
- **KHÔNG** niêm yết cặp MAGIC/NIGHT user-facing (chống vai on/off-ramp privacy-coin).
- Tồn kho NIGHT tối thiểu: `NIGHT_stock ≥ 3 × (cầu DUST đỉnh / gen_rate)` (I-E1). Cần spike đọc tài liệu phí Midnight (gen_rate, dust_per_tx, third-party-fee-payer) TRƯỚC khi code.

---

## §6. Tấn công MECE + benchmark (output thật)

> Script: `rt_A_price.py`, `rt_B_liquidity.py`, `rt_C_volume.py`, `rt_D_governance.py`, `rt_E_night.py`. Quan sát xuyên suốt: **3/5 họ (A, C, E) sụp về cùng một biến — markup giá.** Markup ≥ 1 thì tấn công kinh tế gần như vô lợi.

| Họ | Ngưỡng kích | Chi phí kẻ tấn công | Thiệt hại hệ | Invariant chặn | Tồn dư |
|---|---|---|---|---|---|
| **A — Giá/depeg** | đẩy MAGIC < par | giữ q=0,8/ngày: **lỗ ≥18,7M par/ngày**; vỡ MCR cần đánh sập đa-TS −50% ≈ 6,0M | tạm thời, cap = quỹ PSM ~1,0M | I-A1..A4 | hao PSM trong cửa sổ; rồi RedPeg bật |
| **B — Pool** | lệch TWAP | giữ +20%/180 block: POL 200k→**1,73M ADA**; sandwich Treasury swap no-cap **9,78k ADA/lệnh** | → **0 khi slip_cap 1%** | I-B1..B5 | slip_cap × volume; nhỏ |
| **C — Volume/spam** | **p < 0,8** (markup âm) | mỗi 100k lệnh hắn **lỗ 2,94M ADA** ở giá hiện | 0 ở markup hiện; dương chỉ khi markup<1 | I-C1..C4 | capped bởi rate-limit DID + cap/epoch |
| **D — Quản trị** | >50% VP hoặc front-run nấc phí | 51% cần **~1.667 DID người-thật** (C4 capped, không mua bằng vốn) | ~0 nếu commit-reveal + biên hiến pháp | I-D1..D4 | ~0 kỹ thuật |
| **E — NIGHT** | cầu DUST vọt / NIGHT spot rơi | DoS dòng DUST: kho 1M NIGHT hút cạn **3,33M ADA/ngày**; lệch-pha pool **~50k ADA** | tạm thời + lệch-pha | I-E1..E4 | cap = POL_NIGHT × band |

**Top-3 nguy nhất (theo số):**
1. **E4 — lệch pha pool MAGIC/NIGHT** (rẻ nhất, ~50k ADA, gần như không cần vốn lớn). → bắt buộc TWAP + oracle-band cho NIGHT, không định giá tĩnh.
2. **C khi markup lật âm** (p<0,8): vector duy nhất tự bật khi MAGIC rẻ. → hysteresis nâng phí (I-C3) là cứu cánh sống còn.
3. **B — sandwich Treasury swap thiếu slip_cap**: 9,78k ADA/lệnh → 0 khi cap 1%. Rủi ro cấu hình dễ quên.

(A depeg và D governance phi kinh tế: A đốt 187% thế chấp/ngày; D cần gom 1.667 người thật.)

---

## §7. Bộ bất biến (Invariant)

**Phí (FEE/TREASURY):**
- **I-FEE-ENDO:** định phí theo base_price nội sinh, KHÔNG lấy spot MagicSwap.
- **I-FEE-PURCHASING-POWER:** số MAGIC/lệnh = N rổ base_price (tự co theo giá), không phải hằng số danh nghĩa.
- **I-FEE-MARKUP-STEP:** giữ `m ≥ T/S − 1`; nâng phí có báo trước, step ≥ 2× khi lag ≤ 6 epoch.
- **I-FEE-HYSTERESIS (I-C3):** giữ `F·p ≥ br_safe × C_ada` (markup ≥ 1,5) — chống spam khi MAGIC rẻ.
- **I-TREASURY-SWAP-TWAP (I-B1/B2):** quy MAGIC→ADA dùng TWAP_W (W ≥ 180 block ~1h) + slippage_cap ≤ 1%/lệnh, vượt → chia nhỏ/hoãn.
- **I-TREASURY-BUFFER-MIN:** kho ADA ≥ volume × cửa-sổ-báo-trước × C_ada.
- **I-TREASURY-PEGRED-OFF:** tắt quy-ADA-Treasury khi `d_internal ≥ d_red` (đừng bán MAGIC vào pool đang yếu).

**Solvency (kế thừa + xác nhận bằng sim):**
- **INV-NO-UNBACKED:** `Σ MAGIC ≤ B/br_safe`.
- **INV-HARD-FLOOR (I-A3):** g_min ≥ 67% non-LAMP; không tài sản nào > 33%; trong non-LAMP ≥70% là stable thật.
- **I-A1:** PSM P_redeem≡1 sàn cứng par. **I-A2:** MCR_live ≥ 200%×NSF mỗi block. **I-A4:** Insurance phủ khe (par−tt).

**Pool/NIGHT:**
- **I-B3:** POL_min sao cho cost_hold(+20%, W) > giá trị thao túng. **I-B4:** base_price không đọc spot pool. **I-B5:** POL protocol-owned, rút rate-limit.
- **I-E1:** NIGHT_stock ≥ 3×(cầu DUST đỉnh/gen_rate). **I-E3:** cặp MAGIC/NIGHT TWAP + oracle-band, không tĩnh; không user-facing.

**Volume/Quản trị:**
- **I-C1:** mọi lệnh kèm did_commit hợp lệ. **I-C2:** rate-limit/DID/epoch + cap/epoch + circuit-breaker khi net Treasury < 0 kéo dài.
- **I-D2:** biên hiến pháp ±5%/chu kỳ + timelock trên base_price. **I-D3:** commit-reveal nấc nâng phí + hysteresis.

---

## §8. Pháp lý & framing (4 trụ)

> Phân tích đầy đủ Howey/Reves/MiCA/CISA ở `MAGIC-Token-HopNhat-Vi.md` §11 — mục này chỉ nêu phần riêng của fee-abstraction, không lặp.

Mô hình ĐÚNG (giá dịch vụ cố định công khai, nhà cung cấp tự lo vốn) cắt được money-transmission + chuỗi thuế-user, nếu giữ đủ 4 trụ:
1. **Giá công khai, cố định, neo nội sinh** — "30 MAGIC = 1 cây", đổi chỉ qua DAO; TUYỆT ĐỐI không auto-điều-chỉnh theo feed DEX.
2. **Không spread ẩn** — biên-lời ghi sổ Treasury minh bạch, không giấu trong quote.
3. **Nhà-cung-cấp-tự-lo** — swap MAGIC→ADA→DUST là sự kiện của nhà cung cấp (như AWS tự lo điện), trình bày thuần "mua dịch vụ".
4. **Không lưu ký token user** — user tự ký, MAGIC đốt/chuyển atomically; hệ không giữ tiền user để "đổi sau".
5. (NIGHT) **giá trị user không xuyên lớp privacy.**

**Vướng còn lại:** pháp nhân "nhà cung cấp" phải rõ (App Operator có pháp nhân, KHÔNG ở lõi giao thức); MagicSwap pool tự vận hành có thể chạm CISA/AIFMD → cần định vị rõ; ART/MiCA Art.39 vẫn mở (cần luật sư EU).

---

## §9. Trạng thái Preview (bằng chứng onchain thật)

### 9.1 Đã chứng minh trên Preview
- Credential Preview thật + ví funded **8.792 tADA** (network_magic=2, đã xác nhận Preview, KHÔNG mainnet).
- **Lõi kinh tế-phí đã có tx thật** (consume-LAMP-từ-vault qua validator, 2 redeemer, valid:true, block 4421229):
  `https://preview.cardanoscan.io/transaction/eee0193df276228cebdf168dbd019be6e3193b9adb8f0ddd760d72f972a66f9b`
- 37 case GenMAGIC v3.3 (Snapshot/Instant/Vacuum/Schedule) đã chạy (MASTER_TESTNET_REPORT).

### 9.2 Tx fee-abstraction ĐẦY ĐỦ chưa chạy được — blocker
- **Blocker 0 (kiến trúc):** Paymaster + `paymaster.ak` hiện code theo mô hình **MAGIC-số-kế-toán-không-token** (`FEAT.md`: "MAGIC không là token, không MintingPolicy") — đây là mô hình **lỗi thời** (§10.2). Phải **refactor sang MAGIC native** (đọc `magic_consumed` từ mint field thay redeemer BurnBatch) trước khi demo fee-abstraction đúng thiết kế mới.
- **Blocker 1 (chưa code):** Paymaster có validator (28 test) + SDK `buildSponsorTx` (21 test) nhưng **chưa có runner + deploy script** (cần 3 one-shot NFT + 9 param + 2 beacon DAO + SponsorMeter + user SetDelegate).
- **Blocker 2 (mất cấu hình):** `scripts/.env` chỉ có NETWORK/KEY/SEED; thiếu LAMP_POLICY_ID/VAULT_*_HASH/UM_*/TREASURY_ADDRESS đời mới (gitignore, không có lịch sử).
- **Blocker 3 (đổi khoá):** vault đời cũ owner khác ví hiện tại + LAMP policy đã đổi.
- **MagicSwap:** chưa tồn tại → swap thật không làm được.

### 9.3 Bước tái lập (chạy được consume-MAGIC ngay, không cần code mới)
```bash
# (chạy trong MAGIC/scripts)
# Cách A: điền lại scripts/.env bộ tham số deploy đời mới (giữ ở runbook nội bộ session deploy gần nhất)
# Cách B: deploy lại sạch (ví đủ tADA):
NETWORK=Preview npm run deploy:lamp
NETWORK=Preview npm run deploy:um
NETWORK=Preview npm run deploy:instant-vault
NETWORK=Preview LAMP_PAID=100 npm run test:instant   # in TX hash + link preview
```

### 9.4 Khoảng cách tới demo đầy đủ
- Lõi consume-MAGIC/chuyển-LAMP: **đã verify Preview**.
- Paymaster đầy đủ: validator+SDK+unit xong, cần runner + deploy (vài giờ code, không phải credential).
- Settlement value-check còn gap (`paymaster.ak`): chưa ép App chuyển ADA/LAMP thật tới user — cần guard này cho demo "trả phí thật" đúng nghĩa.
- MagicSwap: cần build mới.

---

## §10. Tham số phải chốt + lộ trình

### 10.1 Tham số bắt buộc (từ benchmark)
| Tham số | Giá trị khuyến nghị | Nguồn |
|---|---|---|
| g_min (sàn non-LAMP) | **≥ 67%** sàn; **75% + Insurance 5–10%** cho đuôi cực đoan (macro ≤ −85% / nghi stable depeg) | §3.2 |
| Trong tranche non-LAMP, tỷ lệ stable THẬT giữ giá | **≥ 70% (bắt buộc)** — đây là lằn ranh sống/chết, không phải LAMP | §3.2 |
| Cap ADA trong tranche cứng | **≤ 30%** | §3.2 |
| markup mục tiêu | ≥ max(1,5 ; T/S−1) | §2.4, §6 |
| nhịp nâng phí | step ≥ 2×, lag ≤ 6 epoch | §3.1 |
| cửa sổ báo trước d | 15–30 ngày (đệm tương ứng 16.6k–49.2k ADA/10k gd) | §3.1 |
| TWAP window quy-MAGIC→ADA | ≥ 180 block (~1h) | §6 B |
| slippage_cap/lệnh Treasury | ≤ 1% | §6 B |
| NIGHT_stock | ≥ 3×(cầu DUST đỉnh/gen_rate) | §6 E |

### 10.2 Hai quyết định nền (chốt 2026-06-29)
1. **MAGIC = NATIVE token một policy-id, trao đổi được** — theo thiết kế mới spec v0.3 (`MAGIC-Token-HopNhat-Vi.md`). MAGIC đồng thời đóng vai **đơn-vị-kế-toán neo sức mua tài nguyên** (token native + neo sức mua cùng tồn tại). Mô hình "số-trong-datum-không-token" của `ConsumeMAGIC/CONTRACT.md` v1 là **lỗi thời — bỏ**; viết lại CONTRACT.md theo v0.3 (PLAN B4→B7).
2. **MagicSwap tự xây** (đang xây) — DEX nội bộ hệ sinh thái, không tích hợp DEX ngoài. → Cần định vị pháp lý pool tự-vận-hành (CISA/AIFMD, §8) + bộ I-SWAP-NO-MINT (§7) ngay từ thiết kế.

### 10.3 Lộ trình
1. Chốt §10.1 + §10.2.
2. Spike Midnight (mô hình phí DUST + third-party-fee-payer) — tiền đề cho §5.
3. Phục hồi `scripts/.env` → chạy lại tx consume-MAGIC Preview làm mốc.
4. Viết runner + deploy Paymaster → tx fee-abstraction đầu tiên trên Preview (bịt settlement value-check trước).
5. MAGIC native (PLAN-refactor B4→B7) → MagicSwap pool validator (+ I-SWAP-NO-MINT).
6. Bù FX quỹ riêng + nấc-nâng-phí + tỷ-giá-engine 3 loại.

---

## Phụ lục — file mô phỏng (cần đưa vào repo có version)
- Solvency D1: **`d1_clean.py`** (first-principles, ADA rớt thật + quét stable depeg + tranche nghiêng ADA). *(BỎ `d1_multiasset_sim.py` — cap ADA ~57% sai nhãn; BỎ `d1_floor_check.py` — fit ngược về đáp án.)*
- Depeg đa-epoch + POL bootstrap: **`d2_depeg_pol.py`** (SIM C giá MAGIC vs hoà vốn phí + PSM/PEGRED-OFF; SIM D POL_min vs slippage swap Treasury).
- Quỹ phí: `treasury_sim5.py`, `treasury_sim6.py` (+ treasury_sim*.py cũ)
- Tấn công MECE: `rt_A_price.py`, `rt_B_liquidity.py`, `rt_C_volume.py`, `rt_D_governance.py`, `rt_E_night.py`
- Phí red-team cũ: `fee_redteam.py`, `fee_redteam2.py`
