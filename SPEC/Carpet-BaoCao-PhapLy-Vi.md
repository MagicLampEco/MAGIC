# Carpet — Báo cáo pháp lý chi tiết 6 thị trường (khung utility-floored)

> **Phiên bản:** v0.1 · **Ngày:** 2026-07-01 · **Tiếng Việt thuần** (giữ tiếng Anh cho tên hàm/tham số/thuật-ngữ pháp lý)
>
> **Trạng thái:** phân tích nội bộ — KHÔNG phải ý kiến luật sư. Trước khi mở EU cần **luật sư MiCA**; trước khi mở Mỹ cần **securities/money-transmission counsel**. Tài liệu này chuẩn bị hồ sơ, không thay tư vấn có thẩm quyền tại từng vùng.
>
> **Nguồn chân lý:** `Carpet-CARP-DacTa-Vi.md §8, §11` · `Whitepaper-MagicLamp-Tokenomic-Vi.md §8, §11` · memory `magiclamp-legal-first-principles`, `magiclamp-token-model`, `magiclamp-no-external-inputs`. Khi mâu thuẫn về CARP/ổn-định → theo `Carpet-CARP-DacTa-Vi.md`.

---

## §0. Nguyên tắc phân tích (từ nguyên lý gốc — không dán nhãn bề mặt)

Toàn bộ báo cáo tuân thủ 4 câu hỏi gốc thay cho "dán nhãn theo tên":

1. **Neo vào gì?** — dịch-vụ-nội-sinh (inelastic) ≠ fiat → ngoài khung stablecoin-neo-tiền-tệ; nhưng "neo-BẤT-KỲ-giá-trị/quyền/rổ" vẫn chạm ART.
2. **Ai làm việc?** — nỗ-lực-của-chính-mình (tiêu dịch vụ thật) ≠ nỗ-lực-người-khác → yếu Howey prong-4.
3. **Có bỏ tiền mua quyền không?** — MAGIC được **Gen** (cấp-quyền, không mua) → yếu Howey prong-1; CARP được **mua** → prong-1 chạm.
4. **Nhất quán chuyển-nhượng.** — token chuyển-nhượng-được (CARP) là nơi mọi rủi ro Howey/MiCA-ART/payment tụ; tách-token chỉ **DỜI** rủi-ro, không xoá. Substance-over-form đánh **cả hai chiều**: giúp MAGIC (sạch thật), hại CARP (cơ-chế-ổn-định thật).

**Ba tiên đề cố định xuyên báo cáo (KHÔNG được nới):**

- **A1 — Tiêu MAGIC là công-dân-hạng-nhất.** Giá trị hệ đến từ TIÊU-DỊCH-VỤ, không từ GIỮ-TÀI-SẢN. Mọi thưởng/VP/ưu-đãi keyed vào **MAGIC-tiêu-thực** (HYBRID: mint=hàm-lõm-của-phí-thực-đốt per-DID có cap; VP=bão-hoà-ngưỡng, KHÔNG nhân-LAMP). Nắm LAMP/CARP đơn thuần **KHÔNG** sinh yield thụ động (`INV-MAGIC-CITIZEN`, `INV-NO-PASSIVE-YIELD`). Đây là trụ pháp lý mạnh nhất: nó đưa cơ-chế-thưởng về **staking-reward-điều-kiện-hoá-bởi-nỗ-lực-tiêu**, không về lợi-tức-theo-số-dư.
- **A2 — CARP utility-floored, KHÔNG chuộc-ra-rổ.** Peg giữ bởi **cầu-dịch-vụ-THỰC** (PrepaidGen 1:1 + PSM-par `P_redeem≡1`, arbitrage-qua-tiêu-dùng), KHÔNG bởi rổ-tài-sản. `g_min≥67%` chỉ áp cho **tuyến-phụ-CDP-LAMP** (ai muốn chuộc-ra-LAMP), tự-thanh-lý riêng — KHÔNG phải backing-core-toàn-CARP.
- **A3 — Đỡ-peg đến từ CẦU-KHÁCH-HÀNG phân-tán** (Platform mua CARP vì cần dịch vụ), không từ issuer-mechanism tập trung → làm **NHẸ** ART + phi-tập-trung-thật; nhưng **KHÔNG thoát** ART.

**Lằn ranh trung thực (nhắc lại để không tái phạm):** "fiat-neutral → thoát ART" là **SAI**. Fiat-neutral chỉ thoát **EMT** (e-money token, neo MỘT đồng tiền chính thức). **ART** = duy-trì-giá-ổn-định bằng tham chiếu **BẤT KỲ** giá-trị/quyền/rổ nào — CARP có cơ-chế-ổn-định nên **rủi ro ART CÒN**. Không được ghi "thoát ART / Title II nhẹ / nhẹ hơn USDC". So USDC = **đánh đổi** (thoát EMT/yield, gánh ART/Howey-4), không "nhẹ hơn".

---

## §1. Bản đồ 3 token theo bản chất (nền cho mọi thị trường)

| Token | Bản chất | Chuyển nhượng | Neo | Rủi ro pháp lý chính | Vùng dùng |
|---|---|---|---|---|---|
| **LAMP** | Tài sản nền, 36 tỷ cố định, KHÔNG burn | Có | — (tài sản gốc) | Tài-sản-số chuyển-nhượng (Howey-4 giai đoạn DAO chưa đủ phi-tập-trung) | Sáng + xám (tư-cách, không thế-chấp core) |
| **MAGIC** | **Consumptive-use thuần** — quyền tiêu MỘT dịch vụ | **KHÔNG** (gắn PhoenixKey DID) | Sức-mua-dịch-vụ nội sinh `P*=1` | **Lớp sạch nhất** — Howey-3 gãy, không EMT/ART, không payment-instrument | Sáng + **xám** (closed-loop) |
| **CARP** | **Exchangeable** — khả năng mua dịch vụ nội hệ | Có | Sức-mua-dịch-vụ-thực (rổ-dịch-vụ, không fiat) | **Đồng DUY NHẤT gánh backing + rủi ro pháp lý**: Howey-4, ART-risk-còn, VASP/CASP | **Chỉ sáng** (geofence xám) |

**Hệ quả kiến trúc pháp lý:** MAGIC là "van thoát" đưa được dịch vụ vào cả vùng xám (nơi CARP bị geofence); CARP là "lớp chuyển-nhượng" tập trung toàn bộ rủi ro để geofence gọn về nó. Người vùng xám tiêu dịch vụ qua MAGIC nhờ **bộ-đệm-app-vùng-sáng** (app mua CARP hộ, cấp MAGIC cho người dùng xám) — dòng CARP không chảy vào tay người vùng xám.

---

## §2. MAGIC — vì sao sạch ở gần như mọi tài phán (phân tích chung trước 6 thị trường)

MAGIC được phân tích **một lần** ở đây vì kết luận gần như đồng nhất 6 thị trường; phần per-market chỉ ghi ngoại lệ.

- **Không phải chứng khoán (Howey / tương đương):** prong-3 (kỳ vọng lợi nhuận) **gãy** — mua/Gen để **tiêu**, decay hết epoch, không hold-to-appreciate. prong-1 yếu — MAGIC được **Gen** (cấp-quyền), không "đầu tư tiền vào doanh nghiệp chung". prong-4 yếu — giá trị nhận về = **dịch vụ do chính mình tiêu**, không phụ thuộc nỗ-lực-người-khác sinh lời.
- **Không phải e-money / payment token:** không chuộc-ra-tiền, không chuyển bên-thứ-ba, **closed-loop**. Không "monetary value" → ngoài EMT (EU), ngoài GENIUS/payment-stablecoin (Mỹ), ngoài e-money (Úc/Ấn/Phi).
- **Không phải ART:** không giữ rổ-tham-chiếu, không cơ-chế-giữ-giá-thị-trường (neo nội sinh `P*=1` qua base_price, không đọc giá ngoài).
- **Rủi ro CÒN LẠI của MAGIC (không giấu):** (a) **consumer-protection** — decay = phí-cưỡng-tiêu, một số tài phán bảo vệ người tiêu dùng với credit hết-hạn (VN, EU, Úc); (b) **prepaid/stored-value / gift-card law** — MAGIC là "prepaid service credit"; vài bang Mỹ + Úc có luật quà-tặng/thẻ-trả-trước (escheatment, cấm hết-hạn dưới N năm). Đây là rủi ro **hành-chính-tiêu-dùng**, KHÔNG phải securities — xử bằng điều-khoản dịch-vụ + thời-hạn-decay hợp lý theo từng vùng.
- **Cấm marketing:** KHÔNG được quảng bá MAGIC (hay InstantGen) như "thu-nhập-thụ-động / giữ LAMP ăn lãi". Thưởng chỉ phát khi **tiêu dùng thật** trong epoch. Narrative "đầu-tư-sinh-lời" là sai bản chất và bị cấm.

**Kết luận MAGIC:** đi được vào **cả vùng xám lẫn sáng** ở 6/6 thị trường, với điều kiện tuân thủ consumer-protection về decay/prepaid tại vùng có luật đó.

---

## §3. CARP — khung phân tích chung (áp cho 6 thị trường)

CARP là trọng tâm. Bốn trục đánh giá lặp lại per-market:

**Trục 1 — EMT (e-money / payment-stablecoin):** CARP **fiat-neutral** (neo sức-mua-dịch-vụ, KHÔNG USD/ADA/giá-tài-sản, KHÔNG chuộc-ra-tiền-từ-issuer) → **thoát EMT / payment-stablecoin** ở mọi tài phán. Đây là kết quả VỮNG, ghi được.

**Trục 2 — ART (asset-referenced / giữ-giá bằng tham chiếu bất kỳ):** CARP có **cơ-chế-ổn-định** → **rủi ro ART CÒN**. 4 yếu tố làm NHẸ (không thoát):
- (a) peg-core = **cầu-dịch-vụ-THỰC**, không rổ-ngoại-sinh-chuộc-giá (khác backing-tài-chính điển hình);
- (b) đỡ-peg = **cầu-khách-hàng phân-tán** (§5b), không issuer-mechanism tập trung;
- (c) quỹ đỡ-peg **lệch-biến/lệch-ngưỡng** (F5: RedBack đọc `P_CARP` / Rice đọc `ρ_LAMP` / Phoenix đọc `TWAP-dài`, gap≥5%, cấm oracle-chung) → không đồng-pha thành issuer đơn;
- (d) không-marketing-stable + **geofence EU mặc định**.
- **CDP-LAMP là TUYẾN-PHỤ nhỏ**, tự-thanh-lý riêng, `g_min≥67%` chỉ áp cho nó — KHÔNG phải backing-core → không kéo toàn-CARP vào khung "chuộc-rổ".

**Trục 3 — Howey / securities:** CARP chuyển-nhượng-tự-do → **Howey-4 CÒN** (giai đoạn DAO chưa đủ phi-tập-trung, còn kỳ vọng lợi-nhuận từ nỗ-lực-đội-ngũ). Giảm: **phân-phối-không-bán-đầu-cơ**, backing = **vốn-vô-chủ** (không ai bảo-lãnh-giá), quản trị **DAO không-token-weighted** (PhoenixKey DID), không-yield-thụ-động (A1). KHÔNG thoát hoàn toàn — đúng cả với USDC.

**Trục 4 — VASP/CASP + money-transmission:** CARP là tài-sản-số chuyển-nhượng → cần **đăng-ký/license VASP/CASP** nơi mở (KHÔNG phải EMI vì không neo-fiat), + **money-transmission** (MSB/MTL Mỹ) nếu có chuyển-giá-trị.

**Cấu phần phụ — kết luận cố định (áp mọi thị trường):**
- **VacuumBack:** chỉ **giảm-phí-không-lãi** (ưu-đãi = quyền-tiêu-thêm non-transferable, keyed-MAGIC) → **KHÔNG securities**, không phải tiền-gửi-sinh-lãi.
- **Backstop** (đổi tên từ Insurance): **đệm-nội-bộ-không-bán-bảo-hiểm** — không phát-hành hợp-đồng-bảo-hiểm ra ngoài → không chạm **insurance-regulation**. Cấm tự gọi "insurance/fund/đầu-tư" (`F-LANG`).
- **Registry-MỞ (did:tiger/did:elephant, DePIN/Datacenter, chat Telegram/Zalo — ai đăng-ký + tiêu-MAGIC + dùng-CARP đều vào):** là **bằng chứng phi-tập-trung** chống **look-through** "một-thực-thể-điều-khiển-tất-cả". Issuer = pháp-nhân-con-MLF vận-hành Carpet+RedBack; Platform/App/Registry là **khách-hàng phân-tán**.

---

## §4. Phân tích per-market (6 thị trường)

### §4.1 Việt Nam (VN) — vùng XÁM mặc định

**Bối cảnh quy định:** Luật Công nghiệp công nghệ số (hiệu lực 2026) lần đầu công nhận "tài sản số / tài sản mã hoá" nhưng khung con (nghị định hướng dẫn, sandbox, thuế, chống rửa tiền) **chưa hoàn chỉnh**. Thanh toán bằng crypto **không được công nhận là phương tiện thanh toán hợp pháp** (NHNN giữ quan điểm này). Không có khung EMT/ART riêng.

| Token | Kết luận VN |
|---|---|
| **LAMP** | Tài-sản-số; nắm-giữ/chuyển-nhượng chưa cấm, nhưng thiếu khung rõ. Không chào-bán công-chúng như đầu-tư. |
| **MAGIC** | **Sạch, dùng được** — closed-loop tiêu-dịch-vụ, không-chuyển-nhượng, không-neo-fiat, không-chuộc-tiền → không chạm "phương tiện thanh toán". Chú ý consumer-protection về decay (điều-khoản dịch-vụ rõ ràng). |
| **CARP** | **GEOFENCE — không mở cho người dùng vùng xám VN.** Lý do: (i) rủi ro bị coi là công-cụ-thanh-toán/tài-sản-tài-chính khi khung chưa rõ; (ii) chuyển-nhượng-tự-do + cơ-chế-ổn-định = bề mặt rủi ro cao nhất khi chưa có sandbox. |

**Mô hình triển khai VN (điều kiện cụ thể):**
1. Người dùng VN chỉ chạm **LAMP → MAGIC → tiêu-dịch-vụ** (closed-loop hoàn toàn, không CARP).
2. Dịch vụ mà người xám cần (định-danh, lưu-trữ…) do **app vùng-sáng** làm bộ-đệm: app mua CARP (ở pháp-nhân vùng-sáng), cấp MAGIC cho người dùng VN. Dòng CARP **không** chảy tới tay người VN.
3. Cổng **Register/DAO** cưỡng-chế phân-vùng: DID vùng-xám không mở được ví CARP.
4. Theo dõi sandbox/nghị định VN; khi có khung rõ + pháp-nhân-VN đủ điều kiện → xét mở CARP có kiểm soát (không tự động).

**Kết luận VN:** MAGIC triển khai được ngay (closed-loop); **CARP geofence** đến khi có khung pháp lý + sandbox rõ ràng.

---

### §4.2 Hoa Kỳ (Mỹ) — vùng SÁNG có điều kiện

**Bối cảnh quy định:** liên-bang + 50 bang chồng lớp. Trục chính: (a) **securities** (Howey, SEC); (b) **commodities/derivatives** (CFTC); (c) **money transmission** (FinCEN MSB liên-bang + MTL từng bang); (d) **payment stablecoin** (khung GENIUS — áp cho stablecoin neo monetary-value).

| Token | Kết luận Mỹ |
|---|---|
| **LAMP** | Tài-sản-số; rủi ro Howey ở giai đoạn phân-phối sớm (nếu chào-bán như đầu-tư). Phân-phối-không-bán + tiện-ích-thật giảm rủi ro. |
| **MAGIC** | **Sạch** — Howey-3 gãy (tiêu, không lợi-nhuận), closed-loop, không monetary-value. Chú ý luật prepaid/gift-card một số bang (không hết-hạn dưới N năm / escheatment) → decay phải tuân luật bang nơi phục vụ. |
| **CARP** | **Thoát GENIUS** (không neo monetary-value → không phải payment-stablecoin). Nhưng về **Howey-4** (kỳ vọng lợi-nhuận từ nỗ-lực-đội-ngũ giai đoạn DAO chưa đủ phi-tập-trung) + **khả năng CFTC** (commodity). Cần **FinCEN MSB + MTL** nếu có chuyển-giá-trị. |

**Điều kiện triển khai Mỹ:**
- **Phân-phối-không-bán-đầu-cơ:** CARP mint qua giao-thức on-chain khi có **cầu-dịch-vụ vào**, không ICO/bán-token-như-đầu-tư.
- **Không-yield-thụ-động (A1):** cấm mọi narrative "giữ LAMP/CARP ăn lãi"; thưởng chỉ theo tiêu-MAGIC-thật → tránh Howey-4 qua "profit from others' efforts".
- **Backing = vốn-vô-chủ:** không ai bảo-lãnh-giá CARP; chỉ sàn-tiện-ích (CARP→MAGIC→dịch-vụ) là cam kết → giảm "investment contract".
- **FinCEN MSB** đăng ký + **MTL** từng bang trước khi mở chuyển-giá-trị; hoặc giới hạn CARP ở phạm-vi-tiêu-dịch-vụ-nội-hệ trước.
- **Marketing:** cấm "stablecoin/algorithmic/yield/fund/đầu-tư" (`F-LANG`); InstantGen KHÔNG được mô tả là passive-income.
- **Cần securities counsel** đánh giá Howey-4 theo tình trạng phi-tập-trung DAO thực tế tại thời điểm mở.

**Kết luận Mỹ:** MAGIC sạch (chú ý prepaid-law bang); CARP mở được **có điều kiện** (MSB+MTL + phân-phối-không-bán + counsel Howey), thoát GENIUS nhưng KHÔNG thoát Howey-4.

---

### §4.3 Liên minh châu Âu (EU) — GEOFENCE MẶC ĐỊNH (chờ luật sư MiCA)

**Bối cảnh quy định:** MiCA phân crypto-asset thành 3 nhóm: **EMT** (neo một fiat), **ART** (neo bất-kỳ giá-trị/quyền/rổ), **other crypto-assets** (utility…). ESMA/EBA xét **substance** ("purport to maintain a stable value") — không xét tuyên bố.

| Token | Kết luận EU |
|---|---|
| **LAMP** | "Other crypto-asset" (utility/tài-sản-nền); cần whitepaper MiCA + CASP nếu chào-bán/niêm-yết. |
| **MAGIC** | Nhiều khả năng **ngoài EMT/ART** (không neo-fiat, không giữ-giá-thị-trường, closed-loop, không-chuyển-nhượng). Có thể xét "other" hoặc ngoài phạm-vi-MiCA nếu thuần-utility-non-transferable. Chú ý consumer-protection EU (credit hết-hạn). |
| **CARP** | **Rủi ro bị phán ART là điểm nóng nhất trong 6 thị trường.** Fiat-neutral → thoát EMT; nhưng "duy-trì-giá-ổn-định bằng tham-chiếu sức-mua-dịch-vụ/rổ-dịch-vụ + có 3-back" = **đúng định nghĩa ART theo substance**. |

**Vì sao EU là nơi rủi ro CARP cao nhất:** MiCA-ART có yêu cầu nặng (authorization như tổ-chức-tín-dụng/CASP-ART, reserve, whitepaper phê-duyệt, giới-hạn phát-hành nếu "dùng rộng như phương-tiện-trao-đổi"). "Không gọi là stable" KHÔNG tự cứu vì ESMA xét substance. 4 yếu-tố-làm-nhẹ (§3 Trục 2) **giảm** khả năng bị phán ART nhưng **chưa chắc thoát** — cần luật sư MiCA phán ranh.

**Điều kiện triển khai EU:**
- **GEOFENCE EU mặc định** cho CARP đến khi có **ý kiến luật sư MiCA** khẳng định utility-floored làm nhẹ đủ (hoặc xác định phải xin phép ART).
- Nếu counsel kết luận ART → cân nhắc: (a) xin authorization ART (nặng, tốn) so (b) tiếp tục geofence EU, phục vụ EU qua MAGIC-closed-loop.
- MAGIC có thể phục vụ người EU (closed-loop) trong khi CARP geofence.
- Không-marketing-stable tuyệt đối; tài liệu tránh mọi từ ngụ-ý "maintain stable value".

**Kết luận EU:** MAGIC nhiều khả năng dùng được (chờ xác nhận "other/ngoài-phạm-vi"); **CARP geofence mặc định**, mở chỉ sau ý-kiến-luật-sư-MiCA. KHÔNG hứa "thoát ART".

---

### §4.4 Úc (Australia) — vùng SÁNG có điều kiện

**Bối cảnh quy định:** ASIC áp khung **financial product** hiện hành lên crypto (INFO 225); token có thể là managed investment scheme / derivative / non-cash payment facility tuỳ bản chất. Chính phủ đang xây khung **Digital Asset Platform** + stablecoin (Stored-Value Facility theo cải cách payment). Consumer-protection (ACL) mạnh với credit hết-hạn.

| Token | Kết luận Úc |
|---|---|
| **LAMP** | Tài-sản-số; rủi ro "financial product" nếu chào-bán như đầu-tư → tiện-ích-thật + không-bán-đầu-cơ giảm rủi ro. |
| **MAGIC** | **Sạch** — không-chuộc-tiền, closed-loop → khó là "non-cash payment facility"; không-lợi-nhuận → khó là "managed investment scheme". Chú ý **ACL** với decay (credit hết-hạn có thể bị coi unfair term) — thời-hạn-decay hợp lý + điều-khoản minh bạch. |
| **CARP** | Fiat-neutral → không là "payment stablecoin / stored-value facility neo-fiat". Nhưng cơ-chế-ổn-định + chuyển-nhượng → rủi ro **"financial product"** (managed investment scheme nếu bị coi là gộp-vốn-đỡ-giá-vì-lợi-ích-người-giữ). 4 yếu-tố-làm-nhẹ + backing-vô-chủ + không-yield giảm rủi ro. Cần **AFSL** nếu bị coi financial product; **AUSTRAC** (registration + AML/CTF) cho digital-currency-exchange nếu có mua/bán. |

**Điều kiện triển khai Úc:**
- **AUSTRAC** đăng ký (AML/CTF) nếu có sàn mua/bán CARP.
- Đánh giá **AFSL** với counsel Úc (CARP có phải financial product không, sau khi tính backing-vô-chủ + không-yield).
- **ACL:** thời-hạn-decay MAGIC + điều-khoản không bị coi unfair.
- Phân-phối-không-bán-đầu-cơ; theo dõi khung Digital-Asset-Platform mới.

**Kết luận Úc:** MAGIC sạch (chú ý ACL decay); CARP mở được **có điều kiện** (AUSTRAC + đánh giá AFSL). Rủi ro trung bình — thấp hơn EU-ART, cao hơn không.

---

### §4.5 Ấn Độ (India) — vùng SÁNG rủi ro thuế/hạn chế cao

**Bối cảnh quy định:** không có luật crypto toàn diện; RBI thận trọng, nhưng crypto (VDA — Virtual Digital Asset) được **đánh thuế nặng** (30% lãi + 1% TDS mỗi giao dịch). Không công nhận là legal tender. **PMLA** áp lên VASP (đăng ký FIU-IND, AML/CTF). Chưa có khung stablecoin riêng.

| Token | Kết luận Ấn |
|---|---|
| **LAMP** | VDA — chịu thuế 30%+1% TDS khi giao-dịch; đăng ký FIU-IND nếu vận hành sàn. |
| **MAGIC** | **Sạch về bản chất** (closed-loop, không-chuộc-tiền), nhưng rủi ro **thuế VDA**: nếu cơ-quan-thuế coi Gen/tiêu MAGIC là "transfer of VDA" → có thể vướng TDS 1%. Cần cấu trúc để Gen (cấp-quyền-non-transferable) KHÔNG bị coi transfer chịu TDS. |
| **CARP** | VDA chuyển-nhượng → **thuế 30% + 1% TDS mỗi giao-dịch** (ma-sát lớn cho token-lưu-hành). PMLA/FIU-IND đăng ký. Không khung EMT/ART nên rủi-ro-phân-loại-chứng-khoán thấp hơn EU, nhưng **rủi-ro-thuế + rủi-ro-thay-đổi-chính-sách-đột-ngột** cao. |

**Điều kiện triển khai Ấn:**
- **FIU-IND** đăng ký (PMLA, AML/CTF) trước khi mở.
- Cấu trúc thuế: xác nhận với tax-counsel Ấn rằng **Gen MAGIC (non-transferable) không bị TDS**; CARP-giao-dịch chịu 30%+1% — cân nhắc mô-hình giảm số-lần-transfer chịu thuế.
- 1% TDS mỗi giao-dịch có thể **phá utility-floor-arbitrage** (arbitrage-qua-tiêu-dùng bị đánh thuế mỗi bước) → đánh giá tác động kinh tế trước khi mở.
- Theo dõi thay-đổi-chính-sách (rủi-ro-cấm-đột-ngột lịch sử cao).

**Kết luận Ấn:** MAGIC sạch về bản chất nhưng cần chốt xử-lý-thuế-VDA; CARP mở được nhưng **ma-sát-thuế + rủi-ro-chính-sách cao** — ưu tiên MAGIC-closed-loop, CARP xét sau khi rõ tax + chính sách.

---

### §4.6 Philippines (Phi) — vùng SÁNG (khung VASP tương đối rõ)

**Bối cảnh quy định:** BSP (ngân-hàng-trung-ương) có khung **VASP** (Circular 1108) — đăng ký, AML/CTF, vốn tối thiểu. SEC-Phi áp khung securities lên token có tính đầu-tư. Có khung stablecoin thí điểm (sandbox BSP cho PHP-pegged). Là một trong các tài phán ASEAN có khung VASP rõ hơn.

| Token | Kết luận Phi |
|---|---|
| **LAMP** | Tài-sản-số; SEC-Phi xét securities nếu chào-bán như đầu-tư → không-bán-đầu-cơ + tiện-ích giảm rủi ro. |
| **MAGIC** | **Sạch** — closed-loop, không-chuộc-tiền → ngoài VASP-payment và securities. Consumer-protection về decay ở mức thông thường. |
| **CARP** | Fiat-neutral → không phải PHP-stablecoin (ngoài sandbox stablecoin-fiat). Nhưng chuyển-nhượng + cơ-chế-ổn-định → cần **BSP VASP registration** (Circular 1108) + đánh giá **SEC-Phi** (Howey-tương-đương, "investment contract"). 4 yếu-tố-làm-nhẹ + backing-vô-chủ + không-yield giảm rủi ro securities. |

**Điều kiện triển khai Phi:**
- **BSP VASP** đăng ký (Circular 1108: AML/CTF, vốn tối thiểu, quản-trị).
- Đánh giá **SEC-Phi** với counsel: CARP có phải "investment contract/securities" không (sau khi tính không-yield + phân-phối-không-bán).
- Không-marketing-stable; F-LANG áp dụng.

**Kết luận Phi:** MAGIC sạch; CARP mở được **có điều kiện** (BSP VASP + đánh giá SEC-Phi). Khung VASP rõ tương đối → khả thi hơn VN/Ấn về mặt thủ tục.

---

## §5. Bảng tổng hợp per-market

| Thị trường | MAGIC | CARP | Điều kiện chính CARP | Rủi ro CARP nổi bật |
|---|---|---|---|---|
| **VN** | ✅ dùng ngay (closed-loop) | ❌ **geofence** | Chờ khung/sandbox VN rõ | Chưa có khung → geofence |
| **Mỹ** | ✅ (chú ý prepaid-law bang) | ⚠️ mở có điều kiện | FinCEN MSB + MTL + phân-phối-không-bán + counsel Howey | Howey-4 (không thoát), CFTC-khả-năng; **thoát GENIUS** |
| **EU** | ✅ (chờ "other/ngoài-phạm-vi") | ❌ **geofence mặc định** | **Chờ luật sư MiCA** | **ART-risk cao nhất** (không hứa thoát); thoát EMT ✅ |
| **Úc** | ✅ (chú ý ACL decay) | ⚠️ mở có điều kiện | AUSTRAC + đánh giá AFSL | "financial product" khả-năng; thoát stored-value-fiat ✅ |
| **Ấn** | ✅ về bản chất (chốt thuế VDA) | ⚠️ mở có ma-sát | FIU-IND + tax-counsel (30%+1% TDS) | Thuế-VDA + chính-sách-đột-ngột; TDS phá arbitrage |
| **Phi** | ✅ | ⚠️ mở có điều kiện | BSP VASP + đánh giá SEC-Phi | securities-tương-đương; khung VASP rõ hơn |

**Kết luận cố định 6/6:** CARP **thoát EMT/payment-stablecoin-neo-fiat** ở mọi thị trường (fiat-neutral). CARP **KHÔNG thoát** rủi-ro-securities-địa-phương (Howey/financial-product) và **KHÔNG thoát ART ở EU**. VacuumBack (không-securities), Backstop (không-bảo-hiểm), Registry-mở (phi-tập-trung) là cấu-phần-làm-nhẹ nhất-quán mọi thị trường.

---

## §6. Chiến lược geofence + lộ trình mở

**Nguyên tắc:** "toàn-cầu-hợp-pháp-hoàn-toàn cho token-chuyển-nhượng = BẤT KHẢ" (đúng cả USDC). Đạt tuân-thủ bằng **phân-vùng-tài-phán** (license nơi cần, geofence nơi chưa), KHÔNG bằng một-cấu-trúc-token-thần-kỳ.

**Mặc định khởi đầu:**
- **MAGIC:** mở 6/6 (closed-loop), tuân consumer-protection/prepaid-law từng vùng.
- **CARP geofence:** VN + EU mặc định đóng; Mỹ/Úc/Ấn/Phi mở **sau** khi hoàn tất điều kiện per-market (đăng-ký + counsel).

**Cổng cưỡng-chế:** Register/DAO phân-vùng theo DID; vùng-xám (VN + EU-chưa-mở) không mở được ví CARP. App vùng-sáng làm bộ-đệm cấp MAGIC cho người vùng-xám.

**Thứ tự ưu tiên mở CARP (đề xuất):** Phi (khung VASP rõ) → Úc (đánh giá AFSL) → Mỹ (MSB+MTL, tốn thủ tục bang) → Ấn (chốt thuế) → EU (chờ luật sư MiCA, có thể giữ đóng dài). VN theo sandbox.

---

## §7. Điểm mở pháp lý (cần đóng trước khi khoá triển khai từng vùng)

1. **Ý kiến luật sư MiCA** — ranh ART cho CARP utility-floored (điều kiện BẮT BUỘC trước khi mở EU). KHÔNG tự kết luận "thoát ART".
2. **Securities counsel Mỹ** — Howey-4 theo tình trạng phi-tập-trung DAO thực tế tại thời điểm mở + có cần đăng-ký-chứng-khoán không.
3. **Tax-counsel Ấn** — xác nhận Gen MAGIC (non-transferable) không chịu TDS; đánh giá tác động 30%+1% lên arbitrage utility-floor.
4. **AFSL counsel Úc** — CARP có phải financial product sau khi tính backing-vô-chủ + không-yield.
5. **SEC-Phi + BSP** — phân loại CARP + thủ tục VASP.
6. **Prepaid/gift-card law** từng bang Mỹ + ACL Úc — thời-hạn-decay MAGIC hợp lệ.
7. **Khung VN** — theo dõi nghị định hướng dẫn + sandbox; điều kiện mở CARP có kiểm soát.

---

## §8. Lằn ranh trung thực (nhắc lại — không được nới trong bất kỳ tài liệu phái sinh nào)

- KHÔNG ghi "CARP thoát ART / nhẹ hơn USDC / Title II nhẹ". So USDC = **đánh đổi**.
- KHÔNG marketing "stablecoin / algorithmic / yield / fund / đầu-tư" (`F-LANG`).
- KHÔNG mô tả InstantGen/nắm-LAMP như thu-nhập-thụ-động.
- KHÔNG hứa "tuân-thủ-tuyệt-đối-không-vùng-xám" cho token-chuyển-nhượng — bất khả.
- Backing = **vốn-vô-chủ**, KHÔNG ai bảo-lãnh-giá CARP; chỉ sàn-tiện-ích là cam kết.
- Mọi kết luận per-market là **phân tích nội bộ** — cần counsel có thẩm quyền tại từng vùng xác nhận trước khi triển khai.

---

*Hết báo cáo v0.1. Đồng bộ với `Carpet-CARP-DacTa-Vi.md §8/§11` và `Whitepaper-MagicLamp-Tokenomic-Vi.md §8/§11`. Khi mâu thuẫn về CARP/ổn-định → theo `Carpet-CARP-DacTa-Vi.md`.*
