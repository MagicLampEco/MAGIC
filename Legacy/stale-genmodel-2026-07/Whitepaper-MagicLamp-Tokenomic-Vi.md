# Whitepaper Tokenomic — MagicLamp (LAMP · MAGIC · CARP)

> **Trạng thái:** DRAFT v0.3 (chờ duyệt). Ngày: 2026-07-01.
> **Đối tượng:** người muốn hiểu KINH TẾ TOKEN của hệ MagicLamp.
> **Nguồn chân lý:** `Carpet-CARP-DacTa-Vi.md` (v0.3 — đặc tả CARP utility-floored) + `MagicLamp-3Token-DacTa-Vi.md` (kiến trúc 3 token). Tài liệu này diễn giải đặc tả đó cho cộng đồng; khi mâu thuẫn về CARP/ổn-định, theo `Carpet-CARP-DacTa-Vi.md`.
> **Phạm vi:** chi tiết kinh tế của ba token, cơ chế đúc/tiêu/ổn-định, hợp đồng tín dụng MAGIC, firewall, phân-vùng-pháp-lý, mô phỏng vùng-xám, và các đánh đổi trung thực. Tầm-nhìn-hệ-thống và chi-tiết-các-app KHÔNG nằm ở đây — xem **Whitepaper Hệ-sinh-thái**.

> **CHỐT KIẾN TRÚC v0.3 (khác v0.1):** CARP là **UTILITY-FLOORED** — giữ peg bằng **cầu-dịch-vụ-THỰC** (tiêu MAGIC của các Platform-khách-hàng), KHÔNG phải backing-tài-chính-chuộc-ra-rổ.
> - **Tiên đề tối cao:** CÔNG DÂN HẠNG NHẤT = TIÊU THỤ MAGIC. Giá trị hệ đến từ **TIÊU-DỊCH-VỤ**, không từ **GIỮ-TÀI-SẢN**. Mọi thưởng/ưu-đãi/quyền-lực keyed vào **tiêu-MAGIC**, không vào holding.
> - **Neo = sức-mua-dịch-vụ-thực** (ổn-định-thực > ổn-định-USD): 1 CARP = 1 MAGIC = một đơn-vị-dịch-vụ. Tỷ giá thực **~3 CARP ≈ 1 USD** (§4).
> - **CDP-LAMP chỉ là TUYẾN-PHỤ** (ai muốn chuộc-ra-LAMP), tự-thanh-lý riêng. `g_min ≥ 67%` **chỉ áp tuyến-phụ-CDP**, KHÔNG áp backing-core-toàn-CARP (v0.1 nhầm → GỠ).
> - **Đỡ-peg = CẦU-KHÁCH-HÀNG phân-tán** (không issuer-mechanism tập trung) → nhẹ ART. **Pháp lý: ART-risk CÒN**, không hứa "thoát ART".

---

## Mục lục

1. [Tóm tắt — câu chuyện chiếc đèn thần](#1-tóm-tắt--câu-chuyện-chiếc-đèn-thần)
2. [Vì sao ba token, không phải một](#2-vì-sao-ba-token-không-phải-một)
3. [LAMP — Chiếc Đèn Thần (tài sản nền)](#3-lamp--chiếc-đèn-thần-tài-sản-nền)
4. [MAGIC — Điều Ước (Consumable, lớp sạch)](#4-magic--điều-ước-consumable-lớp-sạch)
5. [CARP — Tấm Thảm Thần (Exchangeable, lớp lưu hành)](#5-carp--tấm-thảm-thần-exchangeable-lớp-lưu-hành)
6. [Bốn dòng giá trị được phép](#6-bốn-dòng-giá-trị-được-phép)
7. [Cơ chế Gen MAGIC từ LAMP — ScheduleGen và InstantGen](#7-cơ-chế-gen-magic-từ-lamp--schedulegen-và-instantgen)
8. [Cơ chế ổn định CARP — sàn-tiện-ích và 3-back + Backstop](#8-cơ-chế-ổn-định-carp--sàn-tiện-ích-và-3-back--backstop)
9. [Hợp đồng tín dụng MAGIC đa-nguồn](#9-hợp-đồng-tín-dụng-magic-đa-nguồn)
10. [Firewall (bất biến hiến pháp)](#10-firewall-bất-biến-hiến-pháp)
11. [Phân-vùng-pháp-lý — nguyên tắc](#11-phân-vùng-pháp-lý--nguyên-tắc)
12. [Mô phỏng vùng-xám — token-flow đóng-vòng](#12-mô-phỏng-vùng-xám--token-flow-đóng-vòng)
13bis. [Rủi ro cho người dùng — nói thẳng](#13bis-rủi-ro-cho-người-dùng--nói-thẳng)
13. [Đánh đổi trung thực](#13-đánh-đổi-trung-thực)
14. [Điểm mở + lộ trình](#14-điểm-mở--lộ-trình)
15. [Bảng thuật ngữ](#15-bảng-thuật-ngữ)

---

## 1. Tóm tắt — câu chuyện chiếc đèn thần

Hệ MagicLamp có **ba token, ba vai đối nghịch không thể gộp**, lấy đúng truyện Aladin làm ẩn dụ bản chất:

- **LAMP — Chiếc Đèn Thần.** Nguồn phép thuật. Ai giữ đèn thì có quyền triệu hồi điều ước. Đèn cố định **36 tỷ chiếc, không huỷ, không đốt**. Đây là **tài sản nền**, biến động theo cung-cầu thị trường.
- **MAGIC — Điều Ước.** Thần đèn ban điều ước khi chủ cọ đèn. Điều ước **chỉ phục tùng chủ nhân** (không chuyển nhượng), là **một phép thực thi cụ thể** (tiêu một lượng dịch vụ trong hệ), và **tan biến sau một thời hạn** nếu không dùng (decay). Điều ước **không bán được, không đổi ra vàng** — nó gắn với người đã cọ đèn.
- **CARP — Tấm Thảm Thần.** Phương tiện chở người tới **chợ dịch vụ để tiêu**. Thảm **lưu thông, đổi tay, giữ-giá-theo-dịch-vụ** — người ở vùng cho phép trải thảm (trữ CARP) để bay tới nơi tiêu dùng. CARP là **đồng-thanh-khoản ổn-định-theo-dịch-vụ**, mua được bằng tiền mặt.

**Quy luật vàng:** Đèn sinh Điều ước; Thảm chở giá trị tới nơi tiêu; Điều ước tan biến sau khi phục vụ chủ.

> **Tiên đề tối cao — công dân hạng nhất = người TIÊU MAGIC.** Giá trị hệ sinh ra từ **tiêu-dịch-vụ (đốt MAGIC thật)**, không từ giữ-tài-sản. Mọi thưởng, ưu-đãi, quyền-biểu-quyết đều **keyed vào lượng MAGIC đã tiêu** (trực tiếp, hoặc gián tiếp qua CARP đã dùng để tiêu) — nắm LAMP/CARP đơn thuần KHÔNG sinh quyền lợi thụ động. Đây là bất biến `INV-MAGIC-CITIZEN`, chi phối toàn bộ tokenomic dưới đây.

> **Ba cảnh báo rủi ro — đọc trước (chi tiết §13bis).** (1) **LAMP** biến động theo thị trường, **có thể mất giá** — không phải kênh đầu tư đảm-bảo-lời. (2) **CARP** "ổn định" chỉ nghĩa là luôn đổi được một lượng dịch vụ nhất định (neo **sức-mua-dịch-vụ-thực**, không neo USD); **tính theo tiền mặt nó có thể mất giá** — KHÔNG phải stablecoin neo-USD. Tỷ giá tham chiếu hiện tại **~3 CARP ≈ 1 USD** (§4), nhưng đây là hệ-quả-định-nghĩa-đơn-vị chứ không phải cam-kết-giá. (3) **MAGIC** sẽ **tan biến** nếu không tiêu trong hạn (như gói cước có hạn dùng). Không token nào trong hệ là cam-kết-sinh-lời.

Đây là whitepaper **kinh tế token**. Nó giải thích từng đồng *là gì*, *sinh ra thế nào*, *giữ giá ra sao*, *tiêu đi đâu* — và vì sao kiến trúc này vừa trung thực với bản chất vừa đạt mục tiêu pháp lý: **một đồng tuân-thủ-rõ (MAGIC) + một đồng vùng-xám-có-giấy-phép (CARP)** trên phạm vi toàn cầu.

> **Bối cảnh hệ sinh thái (chỉ một đoạn):** MagicLamp là SDK mở cho mọi đội Cardano, vận hành qua các app (PhoenixKey DID, OriLife, AladinWork, LampNet…) và governance không-token-weighted dựa trên PhoenixKey DID sinh trắc. Vai trò từng app, tầm nhìn hệ thống và lộ trình sản phẩm thuộc **Whitepaper Hệ-sinh-thái** — tài liệu này không lặp lại.

---

## 2. Vì sao ba token, không phải một

Một đồng tiền không thể đồng thời mang hai cặp thuộc tính loại trừ nhau:

| Cặp thuộc tính | Mục đích | Token gánh |
|---|---|---|
| **tiêu-thì-mất + chỉ-phục-tùng-chủ** | sạch pháp lý (không phải tài sản tài chính) | MAGIC |
| **giữ-giá + chuyển-nhượng-tự-do** | tiện lưu thông, vào hệ bằng tiền mặt | CARP |
| **nguồn-phép + tài-sản-nền-cố-định** | gốc giá trị, governance, thế chấp | LAMP |

*Giữ-được* (Thảm) và *tan-biến* (Điều ước) là hai cực triệt tiêu nhau. Nếu nhồi cả hai vào một token, đồng đó vừa hứa-giữ-giá-chuyển-nhượng (kéo về khung chứng-khoán/stablecoin) vừa hứa-tan-biến (mâu thuẫn nội tại) — kết quả là một đồng *vừa bẩn pháp lý vừa khó dùng*.

Tách ra cho mỗi vai một token là cách **trung thực với bản chất**. Quan trọng hơn: tách-vai cho phép **cô lập toàn bộ rủi ro chuyển-nhượng/đầu-cơ vào đúng một token (CARP)**, để MAGIC và phần-lớn-người-dùng đứng ngoài vùng xám. Đây là *substance-over-form* thật, mạnh hơn lá-chắn-hình-thức.

---

## 3. LAMP — Chiếc Đèn Thần (tài sản nền)

**Bản chất.** Token tài-sản-nền của hệ. Native token Cardano, policy-id riêng (đã có). Tổng cung **cố định 36 tỷ, KHÔNG mint thêm, KHÔNG burn**. Giảm lưu hành = chuyển vào Treasury (bút toán kế toán), **không đốt** — đây là bất biến hiến pháp của LAMP.

**Vai trò kinh tế.**
1. **Nguồn sinh MAGIC** — nắm LAMP đủ điều kiện thì được Gen Điều ước (cọ đèn → điều ước) qua ScheduleGen/InstantGen (§7).
2. **Tài sản governance** — tư cách bỏ phiếu đọc số LAMP nắm tại snapshot, nhưng **KHÔNG nhân số lượng** (chống plutocracy). Quyền biểu quyết (VP) do PhoenixKey DID sinh trắc quyết định, theo công thức tích nhân ≥4 tham số cá nhân — không token-weighted.
3. **Một nguồn thế chấp** cho hợp đồng tín dụng MAGIC (§9, Nguồn A).

**Thuộc tính.** Chuyển nhượng được; biến động giá theo thị trường; nắm giữ là **chủ động** — KHÔNG sinh lợi-tức-thụ-động theo số dư (firewall F3). Giữ đèn là giữ *quyền-triệu-hồi-phép*, không phải giữ một tờ hứa-trả-tiền.

**Ai gánh rủi ro giá LAMP.** Khi LAMP biến động, rủi-ro-giá do **hệ gánh** (qua chiết-khấu-an-toàn + GreenBack carry), KHÔNG đẩy sang người tiêu MAGIC. Một người mua "3000 lượt định danh" nhận đúng 3000 lượt bất kể giá LAMP lên xuống — vì MAGIC neo theo *dịch vụ*, không theo giá đèn.

> **Cảnh báo rủi ro cho người nắm LAMP.** "Hệ gánh rủi-ro-giá" chỉ áp cho người **tiêu MAGIC** (họ nhận đúng lượng dịch vụ đã mua). Người **nắm LAMP** thì KHÔNG được bảo vệ: giá LAMP biến động theo cung-cầu thị trường và **có thể mất giá**. LAMP KHÔNG phải kênh đầu tư đảm-bảo-sinh-lời; giữ đèn là giữ quyền-triệu-hồi-phép, không phải một tờ hứa-trả-tiền. Ai nắm LAMP tự chịu rủi-ro-giá.

---

## 4. MAGIC — Điều Ước (Consumable / tiêu-thì-hết, lớp sạch)

**Bản chất.** MAGIC là **đơn-vị-tiêu-dịch-vụ trả trước** (prepaid service credit). Một MAGIC = một đơn-vị-dịch-vụ-nền (ví dụ 1 lượt định danh, hoặc một lượng lưu trữ theo `base_price` khoá on-chain). Neo par `P* = 1`, theo **sức-mua-dịch-vụ nội sinh** — **KHÔNG neo USD/ADA/bất kỳ fiat nào**. `base_price` chỉ đổi qua DAO vote hiến pháp.

Đơn vị nguyên tử: **nanogic** — `1 MAGIC = 10⁹ nanogic` (9 decimals).

**Tỷ giá thực (định-nghĩa-đơn-vị, không đọc oracle USD).**
- Đơn vị nền: **1 nanogic = 1 KB·ngày** lưu trữ trên mạng phân tán → `1 MAGIC = 1 CARP = 10⁹ nanogic = 1 TB·ngày`.
- Giá storage thế giới ~$0.01/GB/tháng ⟹ 1 TB·ngày ≈ **$0.33** ⟹ **~3 CARP ≈ 1 USD**.
- Đây là **hệ-quả-định-nghĩa-đơn-vị**, KHÔNG phải neo-USD: nếu muốn 1 CARP ≈ $1, chỉ cần đặt lại `1 nanogic ≈ 3 KB·ngày` (đổi định-nghĩa, không đọc giá USD). Mốc MB/epoch cũ đẩy CARP lên triệu-đô (sai numéraire) → **đã bỏ**.

**Neo RỔ-dịch-vụ để trung-hoà deflation (đề xuất v0.3).** Neo một-dịch-vụ (storage thuần) chịu deflation công nghệ (giá storage giảm dài hạn → CARP "đắt lên" theo USD). Đề xuất neo `base_price` vào **RỔ dịch-vụ** — `storage + định-danh + compute + lao-động` (trọng số DAO) — inelastic + ổn-định-vĩ-mô-dài-hạn hơn (lao-động/định-danh không deflate như storage). Neo = **sức-mua-dịch-vụ-thực**, cập nhật qua DAO ≤10%/lần, ≥1 quý/lần.

**Ba thuộc tính bất biến (ba chân ghế làm nó sạch).**
1. **Không chuyển nhượng** — chỉ phục tùng chủ-DID đã cọ đèn (gắn PhoenixKey DID). Không gửi cho người khác, không bán lại.
2. **Tan biến (decay)** — không tiêu trong thời hạn thì mất. Không tích-trữ-làm-của-để-dành. Điều này củng cố tính tiêu-dùng-thật và chống đầu cơ.
3. **Không chuộc ra tiền** — chỉ chuộc-ra-DỊCH-VỤ (tiêu trong hệ). Không đổi ngược thành LAMP/CARP/fiat. Đây là cửa-một-chiều tuyệt đối (firewall F1).

> **Decay nghĩa là gì cho người dùng — và có mất trắng không?** "Tan biến" KHÔNG có nghĩa trả tiền xong là mất ngay. Khi đặt hợp đồng cấp MAGIC (ví dụ "3000 lượt trong 3 tháng"), hệ dùng ScheduleGen **rải đều quyền-tiêu qua từng epoch** (xem §7), chứ không dồn hết một cục để rồi hết hạn cùng lúc — mục đích là để bạn dùng kịp, không phí. Phần tan biến chỉ là **phần bạn thực sự không dùng trong hạn**, giống gói cước có hạn dùng. Về **đổi ý / mua nhầm**: chính sách là **hoàn lại tiền (fiat) TRƯỚC khi bắt đầu tiêu**; một khi đã tiêu (đã đốt thành dịch vụ) thì phần đã tiêu không hoàn được — vì nó đã thành dịch vụ thật, không phải số dư giữ hộ. Nhà cung cấp phải truyền thông rõ "gói có hạn dùng" ngay khi bán.

**Backing — mô hình thẻ-quà-tặng (gift-card), không phải rổ tài chính.** MAGIC được bảo chứng bằng **năng-lực cung dịch vụ của hệ**, không cần rổ tài sản tài chính. Vì không hứa chuộc-ra-tiền, MAGIC **thoát bài toán Terra** (không có vòng xoáy chuộc-par-rút-cạn) và **thoát khung stablecoin** hoàn toàn.

**Vì sao MAGIC KHÔNG phải stablecoin.** Nó không hứa trả 1 USD, không hứa trả một đồng nào — nó hứa **giao một lượng dịch vụ**. "Ổn định" của MAGIC nghĩa là *1 điều-ước luôn đổi được 1 lượng-dịch-vụ-nền*, không phải *1 MAGIC = 1 USD*. Giá fiat/MAGIC trên thị trường dao động mặc kệ; điều ước vẫn thực thi đúng phép đã hứa. Đây là khác biệt cốt lõi giữa "neo-dịch-vụ" và "neo-tiền".

**Ba cửa Gen MAGIC** (Gen = cấp-quyền, KHÁC Mint CARP = đúc-tiền).
- **(a) PrepaidGen** — khoá CARP → quỹ Paid của platform, **tự-back, không giới hạn** (§9); đây cũng là sàn-tiện-ích của CARP (§8.1).
- **(b) ScheduleGen** — nắm LAMP, đặt hợp đồng nhận một dòng MAGIC đều mỗi epoch, đối ứng GreenBack (§7).
- **(c) InstantGen** — nắm LAMP, Gen Điều ước tiêu ngay **trong phần thặng dư backing**, đối ứng GreenBack, trần-kép ≤0.5×Schedule (§7).

**Tiêu MAGIC.** Khi dùng dịch vụ trên nền-tảng-đã-đăng-ký, MAGIC bị **đốt** (consumptive use). Với hợp đồng Schedule, mỗi epoch tiêu tối đa `pp` (trần cứng — xem §7).

**Vòng đời một đồng MAGIC (góc nhìn người dùng).**

```
mua gói dịch vụ (trả fiat)  →  nhận quyền-tiêu MAGIC (gắn DID, chỉ mình bạn)
   →  tiêu dần qua từng epoch (mỗi lần dùng dịch vụ → đốt một phần)
   →  hết hạn: phần CHƯA dùng → tan biến (decay)
```

Khác với sơ đồ §6 (mô tả dòng-giá-trị của cả hệ), đây là **hành trình một người dùng**: bạn không bao giờ cầm LAMP/CARP, không bao giờ "bán lại" MAGIC — bạn chỉ tiêu nó thành dịch vụ thật.

**Định vị pháp lý — lớp sạch nhất hệ.** Consumptive-use thuần: Howey prong-3 gãy (mua để tiêu, không kỳ vọng lợi nhuận), không e-money (không chuộc tiền), không payment-instrument (không chuyển bên-thứ-ba), **closed-loop**. Dùng được ở **cả vùng xám lẫn sáng** (chi tiết §11).

---

## 5. CARP — Tấm Thảm Thần (Exchangeable / đổi-tay-được, lớp lưu hành)

> **Trạng thái (đọc trước).** Lõi-tiền-tệ của CARP (cơ chế đúc/chuộc + ổn định) **đang thiết kế, chưa vận hành** — xem §8.3 và §14. Phần lớn module on-chain mới của hệ nằm ở đây. Các tính chất mô tả dưới đây là **mục tiêu thiết kế**, không phải trạng thái đã chạy.

> **Cảnh báo "ổn định" — đọc kỹ.** "Ổn định" của CARP nghĩa là **luôn đổi được một lượng dịch vụ nhất định** (ổn-định-theo-dịch-vụ), KHÔNG có nghĩa giữ-giá theo USD hay bất kỳ tiền nào. CARP **có thể mất giá khi quy ra tiền mặt**. CARP KHÔNG phải stablecoin neo-USD, KHÔNG đảm-bảo-không-mất-giá. Ai giữ CARP để đầu cơ tự chịu rủi-ro-giá.

**Bản chất.** CARP là **đồng-thanh-khoản ổn-định-theo-dịch-vụ**: lưu hành, chuyển nhượng, giữ-giá-theo-dịch-vụ (không theo fiat). Native token thật, **policy-id riêng**. Tên gợi *Carpet* — tấm thảm chở giá trị đến nơi tiêu.

**Vai trò kinh tế.**
1. **Cổng vào bằng fiat** — người **chưa có LAMP** hoặc **thấy LAMP đắt/biến động** vẫn vào hệ tiêu dùng được: mua CARP bằng tiền mặt, trữ ở vùng sáng, rồi đổi lấy quyền-tiêu MAGIC.
2. **Đồng lưu-hành trong hệ** — CARP đổi tay trong hệ, giữ chân người dùng và tạo độ sâu thanh-khoản. Peg CARP/MAGIC giữ bằng **cơ-chế-nội-bộ** (utility-floor + PSM-par `P_redeem≡1`), **KHÔNG DEX ngoài**.
3. **Một nguồn thế chấp** tuỳ chọn cho hợp đồng tín dụng MAGIC (§9, Nguồn B).

**Thuộc tính then chốt — neo-dịch-vụ, fiat-NEUTRAL.** CARP chuyển nhượng tự do (trong hệ); **neo sức-mua-dịch-vụ nội sinh, KHÔNG neo fiat**. Mua được bằng tiền mặt, nhưng *giá-trị đo theo dịch vụ*, không theo USD. Đây là điểm phân biệt CARP với mọi stablecoin: nó trung lập với tiền của mọi quốc gia.

**Fiat-neutral giúp gì, và không giúp gì (nói thẳng).** Vì không neo-fiat, CARP **thoát EMT** (e-money token). NHƯNG CARP **có cơ-chế-ổn-định** (giữ peg quanh giá-trị-dịch-vụ), nên **khả năng bị phán ART (asset-referenced token) VẪN CÒN** — ESMA xét *bản chất* chứ không xét *tuyên bố*, nên "không gọi là stable" không tự cứu. So với USDC, CARP là **đánh đổi** chứ KHÔNG "nhẹ hơn": USDC gánh EMT + phải giữ dự-trữ-fiat, còn CARP thoát EMT nhưng **gánh rủi-ro-ART + Howey-4**. Giảm (không phải thoát) rủi-ro-ART bằng: backing-nội-bộ (không rổ-ngoại-sinh-tham-chiếu) + đỡ-peg-gián-tiếp qua quỹ độc lập + không-marketing-stable + **geofence EU mặc định** + chờ luật sư MiCA. Rủi ro còn lại: tài-sản-số chuyển-nhượng (Howey-4 giai đoạn DAO chưa đủ phi-tập-trung).

**CARP gánh rủi ro thay cả hệ — đây là chủ đích.** Vì là token *duy-nhất-lưu-hành-tự-do*, mọi rủi ro thị-trường-thứ-cấp + đầu-cơ + Howey-4 tụ vào CARP. Cô lập rủi ro vào một token là **thiết kế có chủ đích**, để MAGIC và phần-lớn-người-dùng đứng ngoài.

**Ai phát hành CARP, ai giữ đệm, ai chịu trách nhiệm khi CARP rớt giá.** CARP Mint qua **giao thức on-chain MagicLamp** (MintingPolicy native) khi có cầu vào — không có một công-ty-phát-hành-trung-tâm hứa chuộc-tiền. Đệm-bình-ổn (**3-back + Backstop**: GreenBack/VacuumBack/RedBack + Backstop) là **vốn-vô-chủ** (ownerless): các rổ tài sản trên hợp đồng, không thuộc cá nhân/đơn vị nào, chỉ làm-mượt biến động theo quy tắc mã-hoá-sẵn — nó KHÔNG hứa-trả-giá-rổ cho người giữ CARP. Hệ quả: **không có ai "bảo lãnh giá" CARP**; khi CARP rớt giá theo tiền mặt, người giữ CARP tự chịu — chỉ có sàn-tiện-ích (đổi sang dịch vụ, §8.1) là cam kết. Quản trị các tham số đệm thuộc **DAO không-token-weighted** (qua PhoenixKey DID), không thuộc một chủ-sở-hữu.

Cơ chế giữ-giá của CARP (sàn-tiện-ích + kiến-trúc-phân-tuyến) trình bày ở §8.

---

## 6. Bốn dòng giá trị được phép

```
        (Gen: ScheduleGen/InstantGen, đối ứng GreenBack)
   LAMP ───────────────────────────────────►  MAGIC  ──► TIÊU 1 dịch vụ cụ thể (đốt)
    │  (Đèn)                                  (Điều ước)        │
    │                                            ▲             └─► hết hạn → TAN BIẾN (decay)
    │  Pool-Cân-Bằng 1:1 par (nội bộ)            │  PrepaidGen: khoá CARP → quỹ Paid platform
    └──────────────► CARP ──────────────────────┘
                    (Thảm, mua bằng fiat, trữ ở vùng sáng)

   MAGIC ──► (KHÔNG có đường ra: không → CARP, không → LAMP, không → tiền)
```

**Bốn dòng — và chỉ bốn:**

1. **LAMP → MAGIC** — Gen qua ScheduleGen (nắm LAMP, tiêu định kỳ) hoặc InstantGen (nắm LAMP, tiêu ngay), đối ứng GreenBack. Backing nội-sinh.
2. **CARP → MAGIC** — PrepaidGen: khoá CARP → quỹ Paid platform lấy quyền-tiêu MAGIC. **Một chiều, cam kết tiêu, tự-back** (firewall F2).
3. **CARP → MAGIC (utility-floor + PSM-par nội bộ)** — giữ peg CARP/MAGIC bằng cơ-chế-nội-bộ (arbitrage-qua-tiêu-dùng), **KHÔNG DEX ngoài**. (Quỹ độc lập có thể mua CARP rẻ bằng ADA/LAMP — market-op.)
4. **MAGIC → dịch vụ** — tiêu (đốt) hoặc tan biến. **Không có đường nào khác.**

MAGIC **không có đường ra**: không → CARP, không → LAMP, không → tiền. Điều ước đã ban thì chỉ để dùng hoặc tan biến.

---

## 7. Cơ chế Gen MAGIC từ LAMP — ScheduleGen và InstantGen

Hai cửa Gen Điều ước từ LAMP (đối ứng **GreenBack**). Cả hai chia chung nguyên tắc: **chỉ Gen trong thặng dư backing**, không bao giờ bơm cung khi hệ yếu. (Cửa thứ ba, PrepaidGen từ CARP, tự-back nên nằm ở §8.1/§9.)

> **Thưởng-Gen keyed-MAGIC (tiên đề công-dân-hạng-nhất, §1).** Mọi thưởng/ưu-đãi/quyền-lực dưới đây đều **chứa biến MAGIC-tiêu-thực**, theo cơ chế HYBRID: **(a) mint reward** = *hàm-lõm-của-phí-thực-đốt* per-DID, **cap-per-DID** (thưởng theo tiêu-thật có burn-ID, giảm dần biên chống cá-lớn, cap chống Sybil; trần `Σreward ≤ Σ MAGIC_burned`); **(b) Voting Power** = *bão-hoà-theo-ngưỡng-tiêu-MAGIC*, **KHÔNG nhân-LAMP** (cử tri = cá-nhân qua PhoenixKey DID, đạt-ngưỡng-là-đủ-tư-cách, không mua thêm quyền bằng vốn; đọc MAGIC tiêu **cross-DID** để chặn tự-burn-vòng); **(c) ưu-đãi-phí** (VacuumBack, Booster) trả bằng **quyền-tiêu-thêm non-transferable**, KHÔNG phải yield tài sản. Nắm LAMP/CARP đơn thuần KHÔNG sinh thưởng thụ động (`INV-MAGIC-CITIZEN`).

### 7.1 Khái niệm tỷ lệ bảo chứng (`br`) và chế độ xanh/đỏ

> **Epoch là gì?** Epoch là **chu kỳ kế toán của Cardano**, dài khoảng **5 ngày**. Mọi mốc "mỗi epoch" trong hệ (rải quyền-tiêu, trần tiêu, tính thặng dư) đếm theo nhịp này.

Gọi `B` là backing thật (tài-sản-đỡ) của hệ và `S` là cung MAGIC đang lưu hành. `br` (**tỷ lệ bảo chứng** `= B/S` = tài-sản-đỡ / lượng MAGIC đang lưu hành) đo "mỗi đồng MAGIC có bao nhiêu tài sản đỡ phía sau". *Ví dụ: `br = 1,2` nghĩa là cứ 1 đồng MAGIC có 1,2 đồng tài sản đỡ.* Một ngưỡng an-toàn `br_safe = 1,5` (mức bảo-chứng tối-thiểu để được phép đúc thưởng; đặt `> 1`, tức luôn đòi dư so với 1:1) chia hệ thành hai chế độ:
- **Chế độ xanh** (`br > br_safe`): có thặng dư, được phép Gen thưởng.
- **Chế độ đỏ** (`br ≤ br_safe`): khoá Gen toàn mạng, cơ chế phòng thủ kích hoạt.

**Phân biệt quan trọng (oracle dùng để làm gì):** oracle giá LAMP chỉ dùng để **ĐỊNH GIÁ tài-sản-đỡ `B`** (quy phần LAMP trong rổ ra một con số để tính `br`). Nó **KHÔNG** dùng để điều khiển **cổng/ngưỡng** Gen: cổng Gen đọc **chế độ bảo-chứng nội bộ** (so `br` với `br_safe`), KHÔNG đọc giá LAMP spot để bật/tắt Gen hay đặt giá-mục-tiêu (tránh nghịch-pha và price-targeting). Đây chính là tinh thần firewall F6: *giá để tính giá-trị-tài-sản, KHÔNG để cầm-lái-cơ-chế.*

### 7.2 InstantGen — nắm LAMP, tiêu ngay, có trần-kép

**Khung bản chất:** thưởng-tham-gia **điều-kiện-hoá-bởi-tiêu-MAGIC-thật**, KHÔNG phải lợi-tức-thụ-động theo số-dư. Nắm LAMP chỉ **mở tư-cách** (gate) Gen quyền-tiêu-ngay; thưởng CHỈ phát khi người nắm **tiêu dùng thật** trong epoch — biến quyết định là lượng-MAGIC-tiêu, không phải lượng-LAMP-giữ (`INV-MAGIC-CITIZEN`, §1). Đây là cơ chế khuyến-khích-tham-gia, cùng nhóm pháp lý với staking reward PoS. (InstantGen gộp SnapshotGen + InstantGen cũ: nắm LAMP → Gen quyền-tiêu-ngay.)

> **Cảnh báo (pháp lý + truyền thông).** KHÔNG được hiểu hay quảng bá InstantGen như **nguồn thu-nhập-thụ-động** hay "giữ LAMP để ăn lãi". Thưởng chỉ phát khi người nắm LAMP **tiêu dùng thật** trong epoch (điều kiện cần dưới đây) và chỉ trong giới hạn thặng dư — đây là cơ chế khuyến-khích-tham-gia, KHÔNG phải lãi-suất. Mọi narrative "đầu-tư-sinh-lời" quanh InstantGen là sai bản chất và bị cấm trong marketing (§11, mục Mỹ).

**Điều kiện cần (cả hai):** (1) nắm LAMP đủ tư cách; (2) **tiêu dùng thật** trong epoch qua nền-tảng-đăng-ký.

**Công thức lượng đúc — cộng-dồn-có-trọng-số qua nhiều epoch:** (thưởng tính từ lịch-sử-nắm-giữ nhiều epoch, không chỉ số dư hiện tại)

```
M = w₀·M(L₀) + w₁·M(L₁) + … + w₆·M(L₆)
```

- `Lᵢ` = số dư LAMP đủ tư cách ở epoch thứ-i lùi về quá khứ; `wᵢ` là trọng số từng epoch.
- Cộng-dồn qua ≥6 epoch để **công bằng với người nắm dài hạn tạm-bán-mua-lại** (chỉ tính LAMP-hiện-tại sẽ phạt họ và mời gọi nắm-tạm-thời). Người mới vẫn hưởng phần `M₀…` → khuyến khích tích luỹ dần.
- Tuổi-epoch (theo UTXO vật lý) chỉ xét **tư cách** từng khoản LAMP, KHÔNG nhân vào độ lớn thưởng.

**Cổng thặng dư + trần-kép:** lượng thực cấp `= min(M, cap_surplus(br), 0.5×pp_schedule)`. **Thặng dư bảo chứng (surplus)** là phần tài-sản-đỡ DƯ ra trên mức an-toàn — chỉ Gen thưởng vào phần dư này, không bao giờ moi vào phần đỡ tối-thiểu. Công thức `cap_surplus = f·S·(br − br_safe)/br_safe` (`f ≤ 0.10`) khi ở chế độ xanh; **`M = 0` khi ở chế độ đỏ**. **Trần-kép** giữ InstantGen ≤ 0.5×Schedule mọi trạng thái → hệ nhịp-nhàng. InstantGen Gen **chỉ vào thặng dư** `B − br_safe·S`; sau khi Gen, `br' ≥ br_safe` (bảo chứng vẫn trên ngưỡng an-toàn).

**Hai phanh bổ sung (bắt buộc):**
- `cap = 0 khi CARP/MAGIC đang rớt-dưới-mức-neo` (depeg = rớt dưới `P*`, mức-neo gốc) — đúc thêm lúc dưới mức-neo là phản tác dụng.
- **Quy tắc hoàn-tiền có-trần** (`INV-CASHBACK-BOUND`): hoàn-tiền/thưởng cho mỗi người (DID) ≤ **phần phí thật đã bị đốt** của người đó (không phải tổng phí đã trả). Nếu không, ròng toàn hệ thành bơm cung.

**Dùng-thì-được-không-thì-mất (use-it-or-lose-it):** không tiêu thật epoch này thì mất suất epoch này. `M` là **trần-suất mỗi epoch**, KHÔNG phải một bể-quyền-cộng-dồn để tiêu sau (nếu hiểu sai sẽ tạo **lượng cung tồn-đọng chực-chờ-bán**).

**Vì sao có-back, không phải Terra.** GreenBack `B` = LAMP (định giá qua oracle, có **chiết-khấu-an-toàn theo độ biến động** — cắt bớt giá trị LAMP khi tính backing để phòng giá rớt) + tài sản cứng (ADA/stable). Van đỏ tuyệt đối `cap = 0 khi br ≤ br_safe` + trần-kép + cổng-thặng-dư = ba phanh khử vòng-phản-xạ-LAMP. Tương phản Terra: Terra không trần, không sàn, không phanh, collateral nội sinh thuần. Trung thực: gen-Terra còn sót ở chỗ collateral GreenBack chính là LAMP nội sinh (phản xạ) — khử bằng chiết-khấu-an-toàn + ba phanh + stress-test, KHÔNG xoá hoàn toàn.

> **Lưu ý v0.3 — `g_min` KHÔNG phải sàn-backing-toàn-hệ.** Bản v0.1 dùng `g_min ≥ 67%` như "lằn ranh sống/chết" cho backing-core-toàn-CARP. **Đã gỡ:** CARP là utility-floored — peg-core giữ bởi **cầu-dịch-vụ-thực** (tiêu MAGIC của Platform-khách-hàng), KHÔNG bởi rổ-tài-sản-chuộc-ra. `g_min ≥ 67%` **chỉ còn là điều-kiện của tuyến-phụ CDP-LAMP** (§9, chuộc-ra-LAMP), giữ tuyến-phụ đó khỏi vòng-phản-hồi-LAMP — KHÔNG áp cho toàn CARP.

### 7.3 ScheduleGen — Đăng-ký-trước, có GreenBack đỡ

**Mục đích:** một người/đơn vị cần **một dòng MAGIC đều đặn dài hạn** (ví dụ trả công đội kỹ thuật vài tháng) mà không phải ôm sẵn cả đống MAGIC. Họ **khoá một lượng LAMP** và được hệ bảo đảm một dòng `pp` MAGIC mỗi epoch trong `N` epoch. **LAMP vẫn nằm trong ví họ** (không bị mang đi), được trả lại nguyên vẹn khi hết hợp đồng.

**Bốn bước:**
1. **Ký hợp đồng:** đăng ký dòng `pp` MAGIC/epoch × `N` epoch. Hệ kiểm tra **cổng giới hạn**. Đủ chỗ thì nhận; không thì xếp hàng/từ chối.
2. **Tạo MAGIC vào quỹ GreenBack:** lượng MAGIC này **chưa lưu thông** (còn trong quỹ, chưa tính vào cung cần-bảo-chứng) — tạo nó không làm tăng-giảm bảo chứng ngay.
3. **Dùng phần xa-hạn để bình ổn:** hệ luôn giữ đủ tiền cho **2 epoch tới** (đệm an toàn `buffer_ep = 2`). Phần MAGIC của các epoch xa hơn được GreenBack dùng **mua LAMP khi giá rẻ** — vừa đầu-tư-ngược-chu-kỳ vừa **góp backing + đỡ giá LAMP lúc sập**. Khi giá hồi, bán LAMP ra trả nghĩa vụ. **Vì thế Schedule càng dài/nhiều thì hệ càng có nhiều vốn cứu giá** — Schedule là NGUỒN LỰC bình ổn, không chỉ là gánh nặng.
4. **Trả dần mỗi epoch — có TRẦN cứng:** mỗi epoch tiêu **tối đa `pp`** (không rút-dồn nhiều epoch vào một lần). Muốn tiêu nhiều hơn phải ký hợp đồng gối-đầu, hợp đồng mới lại qua cổng. Tiêu xong thì MAGIC bị đốt.

**Cổng giới hạn — vì sao Schedule phải NHỎ:** hệ chỉ nhận thêm hợp đồng tới khi

```
Tổng nghĩa-vụ-còn-lại ≤ κ × Sức-tải-các-quỹ-cứu
```

- Sức-tải = số dư các quỹ cứu nội bộ (RedBack + kho dự phòng các nền tảng + Kho bạc MagicLamp). **Tuyệt đối KHÔNG dùng giá LAMP hay bất kỳ dữ liệu giá thị trường nào** để tính cổng (firewall F6 — minh bạch tuyệt đối, không ai thao túng được). `κ = 0,6` cố định, **cấm đổi giữa vòng đời hợp đồng**.
- Hệ quả: quỹ cứu nhỏ thì số hợp đồng nhận được cũng nhỏ. Schedule co-giãn theo sức khoẻ thật của hệ, không phình ra.

**Bậc thang cứu (khi GreenBack thiếu tiền trả) — 5 bậc, hết bậc trên mới xuống bậc dưới:**
1. GreenBack điều chỉnh tỷ giá hợp đồng (giảm nhẹ phần giao, ghi nhận thiếu hụt);
2. bán bớt LAMP thặng dư mà GreenBack đang giữ;
3. RedBack (vốn vô chủ);
4. kho dự phòng các nền tảng (tích từ phí dịch vụ);
5. Kho bạc MagicLamp.

**Bằng chứng mô phỏng.** Cơ chế trả đủ 100% (về *số lượng* MAGIC) qua: LAMP rớt 50/70/85%, flash-crash 80–90% trong một epoch, bank-run, đăng-ký-dồn, đáo-hạn-cùng-lúc. Bank-run nghịch lý lại làm `br` **tốt lên** (người rút đổi ngang giá → phần còn lại đặc hơn). Mô phỏng cho thấy trong **tuyến-phụ CDP-LAMP** (§9), sàn phi-LAMP `lamp_frac ≤ 33%` (tức `g_min ≥ 67%`) là an-toàn: ở 67% tuyến-phụ sống qua cú rớt 90%/epoch (`br ≈ 1,27`); ở 50% thì cú rớt 90% đẩy về `≈ 0,99` (mất khả năng chi trả). Vì thế **ngưỡng `g_min ≥ 67%` được chốt làm sàn bất-khả-xâm CỦA TUYẾN-PHỤ CDP** (không phải của toàn CARP — xem lưu-ý §7.2 và CHỐT KIẾN TRÚC đầu tài liệu); cái còn lại để DAO tinh-chỉnh chỉ là giá-trị-chính-xác *bên trên* sàn đó (xem §14).

### 7.4 GreenBack vs RedBack — hai quỹ riêng

GreenBack **bơm cung** (khi mua LAMP) và **ôm LAMP**; RedBack thì **trung-lập-cung** và **cố ý không ôm LAMP** (giữ rổ đa-token ρ≤0.3) để sống sót khi LAMP sụp. Hai vai ngược nhau → **hai quỹ riêng**. Gộp lại sẽ phá đúng hai trụ giúp RedBack trụ lúc khủng hoảng. (Back thứ ba, **VacuumBack** — commit-khoá LAMP/CARP kỳ-hạn để huy-động đệm tạm — chi tiết ở `Carpet-CARP-DacTa-Vi.md §4.2`.)

---

## 8. Cơ chế ổn định CARP — sàn-tiện-ích và 3-back + Backstop

CARP giữ giá KHÔNG bằng rổ USD, KHÔNG bằng DEX ngoài, mà bằng **sàn-tiện-ích (neo CHÍNH) + kiến-trúc-phân-tuyến làm mượt**. Nguyên lý gốc: **peg giữ bởi cầu-dịch-vụ-THỰC**, không bởi rổ-tài-sản.

### 8.1 Sàn-tiện-ích (utility-floor) — neo CHÍNH, giữ bởi cầu-thực

CARP **luôn đổi được sang MAGIC** để tiêu dịch vụ, ở tỷ giá nội sinh theo `base_price` (**PrepaidGen 1:1** + **PSM-par nội bộ `P_redeem ≡ 1`**). Vì MAGIC luôn tiêu được thành dịch-vụ-thật, **mua-rẻ-bán-đắt qua việc tiêu thật** (arbitrage-qua-tiêu-dùng) giữ CARP không rớt dưới giá-trị-dịch-vụ: nếu CARP rẻ hơn lượng dịch vụ nó mua được, người ta mua CARP rẻ rồi đổi ra MAGIC để tiêu thành dịch vụ, kéo giá CARP về sàn. Đây là neo **không cần rổ USD, không DEX ngoài**, không cần issuer-chuộc-tiền.

**Biến sống-còn = throughput tiêu-dịch-vụ MAGIC/epoch.** Sàn utility-floor gãy **CHỈ khi** panic-CARP-tuyệt-đối vượt năng-lực-tiêu-dịch-vụ trong cửa-sổ-thời-gian (`throughput × Δt ≥ panic`). Nguồn throughput = **cầu-khách-hàng-Platform** (§11 hệ-sinh-thái): các Platform mua CARP vì **cần dịch-vụ-thật** → tiêu MAGIC → throughput cao ⟺ hệ khoẻ. (Đây là lý do peg-core là utility-floored chứ không backing-tài-chính: đỡ-peg đến từ **cầu phân-tán của khách-hàng**, không từ issuer-mechanism tập trung.) Mục tiêu `throughput ≥ 5% C_circ/epoch` — **cần benchmark thực địa trước genesis** (§14).

Cửa CARP → MAGIC là **một chiều, cam kết tiêu** (firewall F2): đổi CARP lấy quyền-tiêu thì gắn DID, không hoàn lại. KHÔNG đổi 1:1 tự do qua lại — nếu cho đổi qua-lại tự do, regulator nhìn xuyên "MAGIC = CARP đội lốt", và MAGIC mất tính sạch.

> **Nghịch lý pool (thiết kế thanh khoản).** KHÔNG bơm pool CARP quá sâu (~20% C_circ là đủ): pool càng sâu, cùng % depeg cần lượng CARP-panic-tuyệt-đối càng lớn, vượt sức throughput. Tối ưu = **pool vừa + throughput cao**, không pool khổng lồ. Cơ chế chi tiết (giá-bóng làm *trần bảo vệ*; khoá-tạm CARP nguyên tử chống quỵt) thuộc `Carpet-CARP-DacTa-Vi.md`.

### 8.2 Kiến-trúc-ổn-định phân-tuyến (3-back + Backstop, tự-động theo cung-cầu)

Trên sàn-tiện-ích, CARP có nhiều tầng làm-mượt (vốn-vô-chủ), **kích hoạt theo hai trục độc lập** — **PEG** (độ-lệch-giá `d`) và **SOLVENCY** (`br`) — chứ không đặt-tay, không oracle-giá điều khiển:

| Tầng | Quỹ/cơ chế | Kích hoạt | Vai |
|---|---|---|---|
| 0 — arbitrage nội sinh | user tự mua-lại / mint qua CDP-phụ | luôn bật | PEG |
| 1 — **sàn-tiện-ích** (TUYẾN CHÍNH) | utility-floor + PSM-par | luôn bật, thụ động | PEG |
| 2 — **GreenBack** | đệm nghĩa-vụ (đệm động κ), thường-trực | thường-trực | SOLVENCY |
| 3 — **VacuumBack** | commit-khoá LAMP/CARP kỳ-hạn | `d ≥ d_vacuum` (6%), có commit | PEG+SOLVENCY |
| 4 — **RedBack** (+ quỹ độc lập) | rổ đa-token ρ≤0.3, đỡ-peg gián-tiếp | `d ≥ d_red` (4%) **và** `br ≥ br_safe` | PEG |
| 5 — **Backstop** (đổi tên từ Insurance) | đệm bad_debt nội-bộ | backing-đỏ (`br < br_safe`) | SOLVENCY |

**Thang-ngưỡng-peg có thứ tự:** `d_soft = 2% < d_red = 4% < d_vacuum = 6% < d_emergency`. **Hàm-điều-phối-2-trục** đọc `d` (quyết định tầng-nào-kích) và `br` (quyết định năng-lực + có được hút-CARP không) **tách biệt** — không dùng chung một biến cho cả điều-kiện-kích lẫn độ-lớn-năng-lực. Riêng RedBack **chỉ hút-CARP khi `br ≥ br_safe`** (hút khi br-đỏ = hại solvency → cấm); khi br-đỏ, độ-lệch-giá xử bằng utility-floor + Backstop lo bad_debt.

**Ba ràng buộc cứng cho mỗi back** (firewall F5):
- **CẤM thuần-LAMP-biến-động** vào backing-core — tự-tham-chiếu = tái sinh Terra. **TUYỆT ĐỐI không đỡ-peg bằng LAMP** (vòng tự-hủy — sim: pool LAMP nông tụt 61% chỉ để chi 750k par).
- **CẤM thiên-một-fiat** — mất tính trung lập, kéo CARP về EMT/ART.
- Rổ là **công-cụ-bình-ổn, KHÔNG phải cam-kết-chuộc-giá-rổ** — nếu hứa chuộc theo giá rổ thì thành ART.

**Năm phanh-lỗ-hổng (mức nguyên-lý, sim đã cài):**
- **F1 — cách-ly Vacuum (leak≡0, cưỡng-chế on-chain):** LAMP-commit-Vacuum đặt ở UTxO/policy RIÊNG; validator-core TỪ CHỐI mọi input mang token-Vacuum vào backing_core (leak≡0 cưỡng-chế, không chỉ khai báo). Commit-Vacuum ≤ 20% C_circ.
- **F2 — chống Prepaid-default:** `vesting = 0` (escrow-theo-delivery), `claim_provider ≤ Σ MAGIC_burned_par`, buffer-Paid ≥ 15% (= panic-thiết-kế), shortfall → Backstop, **KHÔNG đụng LAMP**.
- **F3 — chống Vacuum-cliff:** stagger BẮT BUỘC (validator cấm >X% commit cùng epoch đáo hạn) + kèm cách-ly-cứng F1.
- **F4 — gỡ deadzone peg→backing:** ranh GreenBack↔RedBack **chồng-lấn-có-chủ-đích** thay ranh-cứng; sàn-cứng RedBack tính theo `C_circ` (không co-về-0 đúng lúc cần).
- **F5 — chống coordinated-ART:** các quỹ đỡ-peg **lệch-biến** (RedBack đọc `P_CARP` / Rice đọc `ρ_LAMP` / Phoenix đọc `TWAP-dài`) + **lệch-ngưỡng** (gap ≥ 5%) + cấm chia-sẻ-oracle-chung → không đồng-pha thành issuer-mechanism-tập-trung.

**Sizing (sim):** panic-thiết-kế = **15% C_circ** (trần bảo vệ công khai), nền back ~50% C_circ cho sức-đỡ-thật ~32%C. **Trên ~18-20%C panic → sụp phi-tuyến**; WALL là **VỐN**, không phải tốc-độ. Chi tiết: `Carpet-CARP-DacTa-Vi.md §4`.

### 8.3 Vào/ra CARP + tuyến-phụ CDP-LAMP (chuộc-ra-LAMP)

- **Vào:** Mint CARP khi có cầu vào (fiat/LAMP → CARP, cơ-chế-nội-bộ qua CDP-phụ).
- **Ra (tuyến chính):** đổi CARP → MAGIC để tiêu dịch vụ, hoặc lưu-hành trong hệ; **KHÔNG chuộc-ra-tiền-từ-issuer** (giữ fiat-neutral + thoát EMT). Đệm bình ổn khi giá rớt dưới giá-trị-nội-sinh.
- **Ra (tuyến-PHỤ — CDP-LAMP):** ai **muốn chuộc-ra-LAMP** (hoá-lỏng LAMP mà không bán trên DEX) mở CDP-LAMP over-collateral (`MCR_base = 200%`, `LR = 130%`), mint CARP; sàn phi-LAMP `g_min ≥ 67%` **chỉ áp riêng cho tuyến-phụ này** để cô-lập vòng-phản-hồi-LAMP. Tuyến-phụ **tự-thanh-lý riêng** (thanh lý cá nhân từng con nợ), bad_debt → Backstop; **KHÔNG gánh peg-core toàn-CARP** — nó chỉ (a) cho lối chuộc-ra-LAMP, (b) là trần-kỹ-thuật khi CARP>1, (c) nguồn arbitrage-đóng-nợ khi CARP<1. Đặc-tả-toán đầy đủ: `CARP-Math-Vi.md`.

> **Trạng thái:** cơ chế Mint CARP cụ thể (**PSM-par + CDP-phụ nội bộ**) + utility-floor + sim phòng-thủ-giá vẫn **đang thiết kế** (§14). Đây là lõi-tiền-tệ thật còn phải xây — phần lớn module on-chain mới của hệ nằm ở CARP, vì MAGIC tái dùng được mô hình vault-datum sẵn có.

---

## 9. Hợp đồng tín dụng MAGIC đa-nguồn

Khi một app đặt hợp đồng cấp MAGIC cho người dùng, app **chọn nguồn khoá** linh hoạt theo kỳ vọng thị trường. Hai nguồn:

**Nguồn A — nắm LAMP.**
- App nắm LAMP (ở-yên-ví, tư-cách) → ScheduleGen/InstantGen sinh quyền-tiêu MAGIC gắn DID người dùng, đối ứng GreenBack. Hết hạn, LAMP vẫn thuộc app.
- **Khi nào dùng:** backing khoẻ → người-nắm-LAMP đang được Gen MAGIC **tỷ giá cao** (nhiều MAGIC/LAMP) → hiệu quả vốn cao.
- **Đánh đổi:** app gánh rủi-ro-giá-LAMP trong thời hạn cam kết.

**Nguồn B — khoá CARP (PrepaidGen).**
- App khoá CARP → quỹ Paid platform, mỗi lần người dùng tiêu, một phần CARP chuyển thành quyền-tiêu MAGIC (F2: một chiều, cam kết, tự-back).
- **Khi nào dùng:** app **kỳ vọng giá LAMP sắp sụp** → không muốn giữ LAMP, muốn giữ CARP-stable để **mua lại LAMP rẻ sau**; hoặc app chỉ sẵn CARP.
- **Đánh đổi:** dùng tài sản ổn định hơn nhưng không gánh rủi-ro-giá-LAMP.

**Vì sao phải cho cả hai nguồn (động cơ tinh tế):** một người nắm LAMP có thể *đồng thời* (i) đang được quyền Gen MAGIC tỷ giá cao (thặng dư lớn) và (ii) kỳ vọng LAMP sắp sụp. Họ dùng **Nguồn A** cho hợp đồng để tận dụng quyền-Gen-cao, đồng thời chuẩn bị **CARP** để mua lại LAMP rẻ sau cú sụp. Cho cả hai nguồn → app/người dùng tối ưu theo kỳ vọng riêng, không bị kẹt một lựa chọn.

**Bất biến chung cho cả hai nguồn:**
- Quyền-tiêu MAGIC sinh ra **chỉ người-dùng-đích (DID) tiêu được** (liên-kết-DID chặt — xem việc-kỹ-thuật-còn-chặn §14).
- Người dùng được đảm bảo **đúng lượng dịch vụ đã mua** (vd 3000 lượt/3 tháng) **bất kể giá LAMP** — MAGIC neo-dịch-vụ, hệ gánh rủi-ro-giá.
- Phí mạng (ADA + DUST) đã **gói trong giá MAGIC**; PhoenixKey thu phần tương ứng về Treasury (qua CARP) để trả phí mạng thay — **người dùng không cần cầm ADA/DUST**.
- **Ai gánh khi phí ADA tăng vọt?** Phí mạng ADA biến động theo giá ADA/thị trường, còn MAGIC neo-dịch-vụ-không-neo-fiat — nên **rủi-ro-giá-ADA do hệ (Treasury) hấp thụ**, KHÔNG đẩy sang người tiêu. Người dùng đã trả đủ lượng dịch vụ vẫn nhận đúng lượng đó dù phí ADA lên cao; phần chênh phí mạng do bộ-đệm Treasury (tích từ phần phí gói sẵn + phí dịch vụ) bù. Nếu phí ADA tăng kéo dài, DAO điều-chỉnh phần-phí-gói-sẵn cho hợp đồng *mới* — hợp đồng *đang chạy* được giữ nguyên cam kết.

---

## 10. Firewall (bất biến hiến pháp)

Vi phạm bất kỳ firewall nào = sập kiến trúc. Đây là các bất biến hiến pháp của hệ.

| Mã | Nội dung |
|---|---|
| **F1 — MAGIC một chiều** | Không có dòng MAGIC → CARP/LAMP/tiền. Điều ước chỉ để tiêu hoặc tan biến. (Nếu cho ra → MAGIC thành tài-sản-chuộc-được → mất tính sạch + tái sinh bài toán Terra.) |
| **F2 — Ma sát CARP → MAGIC** | CARP → MAGIC là **cam kết tiêu** gắn DID, một chiều, không hoàn. KHÔNG đổi 1:1 tự do qua lại (kẻo regulator nhìn xuyên "MAGIC = CARP đội lốt"). |
| **F3 — Không lợi-tức-thụ-động** | Không token nào trả dòng-giá-trị theo số-dư. Nắm LAMP/đặt ScheduleGen là **chủ động** (nắm-giữ, cam kết), không phải yield. Đây là tường-lửa Howey thật. |
| **F4 — MAGIC closed-loop** | MAGIC không-chuyển-nhượng + decay + không-chuộc-tiền + tiêu-trong-hệ. |
| **F5 — CARP fiat-neutral** | CARP neo-dịch-vụ, KHÔNG neo-fiat, KHÔNG chuộc-ra-tiền. Sàn = utility-floor (CARP→MAGIC, PrepaidGen 1:1 + PSM-par nội bộ), KHÔNG DEX ngoài. Đệm phân-tuyến (GreenBack/VacuumBack/RedBack + Backstop) đa-dạng-trung-lập: CẤM thuần-LAMP vào core (Terra) VÀ CẤM thiên-một-fiat; rổ là công-cụ-bình-ổn không phải cam-kết-chuộc. |
| **F6 — Không yếu-tố-bên-ngoài** | Cơ chế lõi (cổng Schedule, ngưỡng solvency) chỉ căn số-dư-nội-bộ, KHÔNG để oracle-giá điều khiển. Minh bạch tuyệt đối, chống thao túng. |
| **F7 — Bộ-đệm vùng-xám** | Ở nơi chặn LAMP/CARP, người dùng chỉ chạm fiat + MAGIC; token nằm ở app vùng-sáng; app bán-đứt-không-hoàn-tiền. |
| **F8 — Công-dân-hạng-nhất = tiêu-MAGIC** (`INV-MAGIC-CITIZEN`) | Mọi hàm reward/VP/ưu-đãi PHẢI chứa biến MAGIC-tiêu-thực (trực tiếp hoặc qua-CARP-đã-tiêu); CẤM keyed thuần vào số-dư-nắm-giữ LAMP/CARP. Giá trị hệ từ TIÊU-DỊCH-VỤ, không từ GIỮ-TÀI-SẢN (§1). |
| **F9 — Không đỡ-peg bằng LAMP + điều-phối-2-trục** | TUYỆT ĐỐI không đỡ-peg bằng LAMP (`INV-NO-LAMP-PEG-DEFENSE` — vòng tự-hủy). Điều-phối đọc HAI trục độc lập: PEG (`d`) và SOLVENCY (`br`); cấm dùng chung một biến cho điều-kiện-kích lẫn độ-lớn-năng-lực (`INV-2-AXIS`, §8.2). Peg-core giữ bởi **cầu-dịch-vụ-thực**, không bởi rổ-tài-sản (`INV-PEG-BY-DEMAND`). |

---

## 11. Phân-vùng-pháp-lý — nguyên tắc

**Nguyên tắc nền.** Phán theo **bản chất, không theo nhãn**: mỗi token bị xử theo thuộc tính thật, bất kể chung thương hiệu "MagicLamp". "Tuân thủ tuyệt đối không vùng xám" là **bất khả** cho mọi token chuyển nhượng (đúng cả USDC). Mục tiêu thực tế: **phân-vùng-tài-phán** (license nơi cần, geofence nơi chưa) + **cô lập rủi ro vào CARP**, giữ MAGIC sạch tuyệt đối.

**Phân vùng vận hành:**

| Vùng | LAMP | MAGIC | CARP |
|---|---|---|---|
| **Sáng** (Mỹ, EU-MiCA, Úc, Ấn-độ…) | mở | mở | **mở** (đăng ký VASP/CASP; KHÔNG phải EMI vì không neo-fiat) |
| **Xám** (VN, nơi chặn) | chặn nắm giữ | **mở** (qua app vùng-sáng, closed-loop) | chặn |

**Nguyên tắc phân-vùng (áp cho mọi thị trường).** Whitepaper kinh-tế-token chỉ nêu *nguyên-tắc* và *lý-do*, không liệt kê giấy-phép từng nước (chi tiết license/thuế từng tài phán thuộc **bản-phân-tích-pháp-lý-chi-tiết**, §14):
- **MAGIC sạch ở khắp nơi** vì closed-loop-tiêu-dịch-vụ + không-neo-fiat + không-chuyển-nhượng: ngoài securities (Howey-3 gãy), ngoài e-money/payment-stablecoin, ngoài EMT/ART. Đây là token đi được vào cả vùng xám.
- **CARP cần license/đăng-ký nơi mở, geofence nơi chưa** vì nó chuyển-nhượng-tự-do (rủi ro Howey-4 + thị-trường-thứ-cấp). Nhờ fiat-neutral, CARP **thoát EMT**, NHƯNG có cơ-chế-ổn-định nên **khả năng bị phán ART còn** (KHÔNG hứa thoát ART) → **geofence EU mặc định + chờ luật sư MiCA**. Khác USDC là **đánh đổi** (thoát EMT/yield, gánh ART/Howey-4), không "nhẹ hơn"; vẫn là tài-sản-số cần khung VASP/CASP nơi vận hành.
- **LAMP** là tài-sản-nền: mở vùng sáng, geofence vùng xám nơi cần.

Quy luật chung: ở **vùng xám chặn LAMP/CARP**, người dùng chỉ chạm fiat + MAGIC (bộ-đệm-app vùng-sáng, firewall F7); ở **vùng sáng**, CARP mở qua đăng-ký phù hợp. Một lưu ý bất biến: nếu sau này CARP thêm cơ-chế-chuộc-par-theo-fiat thì sẽ chạm EMT/ART — **phải tránh** để giữ vị thế nhẹ.

**Geofence là điều kiện ĐỦ, không tự đủ một mình.** Tiền lệ (BitMEX, Binance/CZ, Tornado Cash, Bitfinex): regulator truy **hành vi + ý định**, không truy IP-block. Geofence chỉ tính khi kèm: DID/KYC-gate thật (PhoenixKey) + chặn-VPN + log + không-solicit vào tài phán chặn + không-tài-liệu-chỉ-cách-né + AML-program + đăng ký MSB/VASP nơi có user thật. Geofence-dán-nhãn-rồi-làm-ngơ = **tăng nặng** hình sự.

---

## 12. Mô phỏng vùng-xám — token-flow đóng-vòng

Mục này chứng minh tính **closed-loop của MAGIC** ở vùng xám bằng một ví dụ token-flow trừu tượng. *(Chi tiết vận hành một app cụ thể — trụ sở, license, cổng thanh toán, dòng fiat, KYC — thuộc **Whitepaper Hệ-sinh-thái**, không nằm ở đây.)*

**Bối cảnh:** quốc gia vùng-xám chặn **cả LAMP lẫn CARP**; chỉ cho ADA làm crypto trả phí mạng. Một người dùng (có DID PhoenixKey) cần **3000 MAGIC** để dùng dịch vụ trong 3 tháng qua **một app vùng-sáng**.

**Token-flow (chỉ phần token, không phần vận-hành-app):**
1. Người dùng trả **fiat** mua "gói dịch vụ 3 tháng". Họ **không chạm** LAMP/CARP/token đầu cơ nào.
2. App đặt hợp đồng cấp MAGIC, **chọn nguồn khoá** (§9):
   - **Nguồn A:** app nắm LAMP → ScheduleGen sinh 3000 quyền-tiêu MAGIC **gắn DID người dùng** (chỉ họ tiêu). Hết hạn, LAMP vẫn thuộc app.
   - **Nguồn B:** app khoá CARP (PrepaidGen) → mỗi lần dùng, một phần CARP → MAGIC.
   - App chọn A khi đang Gen tỷ giá cao; chọn B khi kỳ vọng LAMP sụp.
3. Mỗi lần dùng dịch vụ: trừ MAGIC tương ứng; **phí mạng (ADA + DUST) đã gói trong giá MAGIC** — hệ thu phần đó về Treasury và trả phí mạng thay. **Người dùng không cần cầm ADA.**
4. Quyền-tiêu MAGIC **chỉ người-dùng-đích dùng được**, **tan biến** nếu hết hạn chưa dùng hết (ScheduleGen rải đều để khỏi phí).

**Vì sao token-flow này đóng-vòng và sạch:** người dùng chỉ (a) trả fiat mua dịch vụ; (b) nhận quyền-tiêu-dịch-vụ không-chuyển-nhượng (không phải tài sản tài chính); (c) không nắm LAMP/CARP. **Toàn bộ token nằm ở app vùng-sáng** — bộ-đệm-pháp-lý (firewall F7): crypto dưới mui xe ở vùng sáng, người dùng vùng xám chỉ chạm fiat + điều-ước-phục-tùng-chủ.

**Bất biến token để token-flow đứng vững** (điều kiện vận-hành-app phía nhà cung cấp — license, cổng thanh toán hợp pháp, KYC, ngoại hối/AML — xem WP Hệ-sinh-thái):
- LAMP/CARP **không bao giờ** vào quyền-sở-hữu người dùng vùng xám.
- MAGIC giữ ba thuộc tính (không-chuyển-nhượng + decay + không-chuộc-tiền).
- App **bán đứt gói dịch vụ**, KHÔNG hứa hoàn-MAGIC-thành-fiat (kẻo thành custody/e-money).
- Chính sách **hoàn fiat trước khi tiêu** + truyền thông rõ "gói có hạn dùng".

---

## 13bis. Rủi ro cho người dùng — nói thẳng

Mục này viết cho **người mua/người dùng thường**, bằng ngôn ngữ phổ thông (khác §13, vốn viết cho người-thiết-kế-hệ). Đọc kỹ trước khi tham gia:

- **Mua MAGIC (gói dịch vụ):** MAGIC **không** đổi lại ra tiền. Nếu **không tiêu hết trong hạn**, phần dư **tan biến** — giống gói cước có hạn dùng. Bạn được hoàn fiat **trước khi bắt đầu tiêu**; đã tiêu rồi thì phần đã tiêu không hoàn. Hãy mua đúng nhu cầu, đừng mua dư.
- **Giữ CARP:** CARP **có thể mất giá khi quy ra tiền mặt**. "Ổn định" chỉ nghĩa là luôn đổi được một lượng dịch vụ nhất định, KHÔNG đảm bảo giá theo USD/VND. CARP KHÔNG phải stablecoin. Nếu giữ CARP để đầu cơ, bạn tự chịu rủi-ro-giá; không có ai bảo-lãnh-giá.
- **Nắm LAMP:** giá LAMP **biến động theo thị trường, có thể giảm**. LAMP KHÔNG phải kênh đầu-tư-đảm-bảo-lời; InstantGen KHÔNG phải lãi-suất hay thu-nhập-thụ-động (chỉ phát khi bạn tiêu dùng thật, trong giới hạn thặng dư). Đừng nắm LAMP với kỳ vọng "ăn lãi".
- **Vùng pháp lý:** ở một số nơi (vùng xám), bạn **không được phép nắm LAMP/CARP**; chỉ được dùng MAGIC qua app vùng-sáng. "Mở" trong bảng phân-vùng KHÔNG có nghĩa tự-do-dùng mọi token ở mọi nước — phải theo điều kiện từng vùng (§11).

Tóm: **không token nào trong hệ là cam-kết-sinh-lời.** MAGIC để tiêu (rồi tan biến), CARP để đổi-lấy-dịch-vụ (giá tiền-mặt có thể xuống), LAMP là tài-sản-nền biến-động. Tham gia với đúng kỳ vọng đó.

---

## 13. Đánh đổi trung thực

Whitepaper này không giấu các điểm yếu. Bốn đánh đổi lớn:

1. **Gen-Terra còn sót trong MAGIC.** Collateral GreenBack của MAGIC vẫn là LAMP nội sinh (`ρ_LAMP` phản xạ). Khử bằng chiết-khấu-an-toàn (haircut) + ba-phanh (van-đỏ `cap=0`, trần-kép, cổng-thặng-dư) + stress-test, **KHÔNG xoá hoàn toàn**. Khác MakerDAO (collateral ngoại sinh). Hệ trung thực thừa nhận lằn ranh này tồn tại. (Riêng tuyến-phụ CDP-LAMP có thêm sàn `g_min ≥ 67%` cô-lập phản-xạ — §9.)

2. **"Trả đủ 100%" là về SỐ LƯỢNG MAGIC, không phải GIÁ TRỊ.** Khi `br` tụt sâu (LAMP sụp), người Đăng-ký vẫn nhận đủ *số* MAGIC, nhưng MAGIC có thể mất giá *trên thị trường*. Người **tiêu MAGIC vào dịch vụ** (đúng mục đích) ít chịu ảnh hưởng; ai **mang ra bán** mới chịu. Khả-năng-chi-trả của người-giữ-MAGIC tách rời việc trả cho người-Đăng-ký — đây là rủi ro **cố hữu, không sửa được bằng tham số**, chỉ minh bạch cảnh báo + giữ chiết-khấu-an-toàn đủ chặt (và `g_min` đủ cao ở tuyến-phụ CDP).

3. **Capital-efficiency vs an-toàn.** Khoá LAMP để cấp MAGIC (Nguồn A) hiệu quả vốn cao nhưng app gánh rủi-ro-giá-LAMP; dùng CARP (Nguồn B) an toàn hơn nhưng vốn đắt hơn. Hệ không chọn thay — để app/người dùng tối ưu theo kỳ vọng riêng.

4. **CARP gánh rủi ro pháp lý của cả hệ.** Cô lập rủi ro chuyển-nhượng/Howey-4 vào CARP là chủ đích, nhưng nghĩa là CARP **chắc chắn** cần license/geofence theo vùng — không có đường né. Fiat-neutral cho CARP **thoát EMT**, NHƯNG có cơ-chế-ổn-định nên **khả năng bị phán ART còn** (không hứa thoát) — khác USDC là **đánh đổi** (thoát EMT/yield, gánh ART/Howey-4), không "nhẹ hơn". Giảm rủi-ro-ART bằng backing-nội-bộ + đỡ-peg-gián-tiếp + không-marketing-stable + geofence EU mặc định.

---

## 14. Điểm mở + lộ trình

**Còn quyết (tham số/cơ chế):**
1. Cơ chế Mint CARP cụ thể (**PSM-par + CDP-phụ nội bộ**) + utility-floor + hàm-điều-phối-2-trục + sim phòng-thủ-giá (chi tiết `Carpet-CARP-DacTa-Vi.md §3, §4`).
2. CARP genesis: Mint khi có cầu vào; cỡ + thành phần 3-back + Backstop đa-dạng-trung-lập (không-fiat).
2b. **Benchmark throughput tiêu-dịch-vụ MAGIC thực địa** — biến sống-còn của sàn utility-floor (§8.1); chưa đo.
3. Các tham số còn tinh-chỉnh: tỷ trọng tranche, trọng số `wᵢ` + số epoch cộng-dồn InstantGen, `κ_eff` cổng ScheduleGen, phần-cắt-giao-thức, cọc escrow `η`, thang-ngưỡng-peg `d_soft/d_red/d_vacuum`, `κ_reward` per-loại (hàm-lõm-phí, cap-per-DID) + ngưỡng bão-hoà VP (§7). *(Lưu ý: **sàn `g_min ≥ 67%` đã CHỐT** là bất-khả-xâm **CỦA TUYẾN-PHỤ CDP** — xem §7.3, §9, §13; KHÔNG áp backing-core-toàn-CARP.)*
4. MAGIC: policy-id riêng hay thuần validator-entitlement (nghiêng entitlement — sạch hơn).

**Việc kỹ thuật còn chặn (tóm tắt, mức nguyên-tắc):**
- Liên kết "chỉ chủ-DID tiêu" giữa quyền-tiêu MAGIC ↔ PhoenixKey DID (thuộc backend PhoenixKey, ngoài phạm vi whitepaper này).
- Lớp trả-phí-thay (fee-abstraction quy CARP → ADA, cơ-chế-nội-bộ) — đang xây.
- Hỗ trợ dịch vụ cần quyền-riêng-tư (privacy) — chưa thiết kế.

**Lộ trình:**
1. Chốt điểm mở 1–3 → viết bản-phân-tích-pháp-lý-chi-tiết theo 3-token.
2. Hoàn tất liên-kết-DID → demo kịch bản chị Oanh.
3. Xây lõi CARP (cơ chế Mint + ổn định) — phần xây-mới thật.
4. Lớp trả-phí-thay (cơ-chế-nội-bộ).
5. Kiểm thử tích hợp end-to-end.

---

## 15. Bảng thuật ngữ

| Thuật ngữ | Nghĩa |
|---|---|
| **LAMP** | Token tài-sản-nền, 36 tỷ cố định, không burn. "Chiếc Đèn Thần." |
| **MAGIC** | Điều Ước — đơn-vị-tiêu-dịch-vụ trả trước, **quyền tiêu MỘT dịch vụ cụ thể**, không-chuyển-nhượng, decay, không-chuộc-tiền. |
| **Gen vs Mint** | **Gen** = cấp-quyền (MAGIC, entitlement, không tăng cung-tiền); **Mint** = đúc-tiền (CARP, monetary creation). Cấm "mint MAGIC"/"gen CARP". |
| **CARP** | Tấm Thảm — đồng-thanh-khoản ổn-định-theo-dịch-vụ (KHÔNG neo-fiat), chuyển-nhượng được, fiat-neutral. Giá tiền-mặt có thể biến động. |
| **nanogic** | Đơn vị nguyên tử của MAGIC; `1 MAGIC = 10⁹ nanogic`. Định-nghĩa-đơn-vị v0.3: **1 nanogic = 1 KB·ngày** lưu trữ → 1 CARP = 1 TB·ngày ≈ $0.33 (~3 CARP ≈ 1 USD). |
| **epoch** | Chu kỳ kế toán Cardano, ~5 ngày; nhịp đếm cho mọi mốc "mỗi epoch". |
| **`base_price`** | Giá dịch-vụ-nền khoá on-chain; mỏ neo của MAGIC/CARP; đổi chỉ qua DAO (≤10%/lần, ≥1 quý/lần). Đề xuất v0.3: neo **RỔ-dịch-vụ** (storage+định-danh+compute+lao-động) để trung-hoà deflation. |
| **`P*` (mức-neo gốc / par)** | Mục tiêu neo par; `P* = 1` (1 MAGIC = 1 đơn-vị-dịch-vụ-nền). "Rớt-dưới-mức-neo" (depeg) = giá tụt dưới `P*`. |
| **`B` (tài-sản-đỡ)** | Backing thật của hệ; gồm LAMP (định-giá-oracle có chiết-khấu-an-toàn) + tài sản cứng. |
| **`br` (tỷ lệ bảo chứng)** | `= B/S` = tài-sản-đỡ / lượng MAGIC lưu hành. Ví dụ `br=1,2` → 1 MAGIC có 1,2 tài sản đỡ. Xanh nếu `> br_safe`, đỏ nếu `≤ br_safe`. |
| **`br_safe` (mức bảo-chứng an-toàn)** | Ngưỡng tối-thiểu để được Gen thưởng; đặt `> 1` (luôn đòi dư so 1:1). Trên ngưỡng = chế-độ-xanh (được Gen), dưới/bằng = chế-độ-đỏ (khoá Gen). |
| **thặng dư bảo chứng (surplus)** | Phần tài-sản-đỡ DƯ trên mức an-toàn (`B − br_safe·S`); InstantGen chỉ Gen vào phần dư này. |
| **`g_min`** | Sàn cứng phi-LAMP **của tuyến-phụ CDP-LAMP**; **≥ 67%** (lằn ranh sống/chết của tuyến-phụ, bất-khả-xâm). **KHÔNG áp backing-core-toàn-CARP** (v0.1 nhầm → GỠ; peg-core giữ bởi cầu-dịch-vụ-thực). |
| **chiết-khấu-an-toàn (haircut)** | Cắt bớt giá-trị LAMP khi tính `B`, phòng giá LAMP rớt. |
| **PrepaidGen** | Cửa Gen MAGIC: khoá CARP → quỹ Paid platform, tự-back, không giới hạn; đồng thời là sàn-tiện-ích CARP. |
| **InstantGen** | Cửa Gen MAGIC (gộp SnapshotGen+InstantGen cũ): nắm LAMP → tiêu ngay trong thặng dư; `M=Σwᵢ·Lᵢ` cộng-dồn ≥6 epoch, tuổi-chỉ-gate; trần-kép ≤0.5×Schedule. KHÔNG phải thu-nhập-thụ-động. |
| **ScheduleGen** | Cửa Gen MAGIC: nắm LAMP → dòng `pp` MAGIC/epoch × `N`, đối ứng GreenBack. |
| **GreenBack** | Quỹ đối ứng ScheduleGen/InstantGen; mua LAMP đáy, ôm LAMP, bơm-cung. (KHÔNG gọi "Reserve" — tránh lẫn Reserve-phân-phối-LAMP.) |
| **VacuumBack** | Back thứ ba: commit-khoá LAMP/CARP kỳ-hạn, huy-động đệm tạm khi hệ cần. |
| **RedBack** | Quỹ phòng thủ trung-lập-cung, rổ đa-token ρ≤0.3, cố ý không ôm LAMP/fiat; vốn-vô-chủ; đỡ-peg gián-tiếp (chỉ hút-CARP khi `br ≥ br_safe`). |
| **Backstop** (đổi tên từ Insurance) | Tầng-5 đệm bad_debt nội-bộ; kích hoạt khi `br < br_safe`. = đệm-nội-bộ-không-bán-bảo-hiểm (không phát-hành hợp-đồng-bảo-hiểm ra ngoài). |
| **throughput** | `= Σ MAGIC_burned_thật / epoch` (đo qua burn-ID). Biến sống-còn của sàn utility-floor: sàn gãy CHỈ khi panic vượt `throughput × Δt`. Mục tiêu ≥5% C_circ/epoch — cần benchmark thực địa. |
| **utility-floor (sàn-tiện-ích)** | Neo-CORE: CARP luôn đổi được sang MAGIC để tiêu dịch-vụ-thật (PrepaidGen 1:1 + PSM-par); peg giữ bởi **cầu-dịch-vụ-thực**, không rổ-tài-sản. |
| **PSM-par** | `P_redeem ≡ 1` (oracle-free); arbitrage tự-thưởng qua đóng CDP-phụ — lực-đỡ-rẻ-nhất. |
| **tuyến-phụ CDP-LAMP** | Đường chuộc-ra-LAMP (hoá-lỏng LAMP không bán DEX): CDP over-collateral, `MCR=200%`, `g_min≥67%` chỉ-áp-đây, tự-thanh-lý riêng. KHÔNG gánh peg-core. |
| **thang-ngưỡng-peg `d`** | `d = |P_CARP−P*|/P*` (TWAP). Thứ tự `d_soft=2% < d_red=4% < d_vacuum=6% < d_emergency` quyết định tầng-nào-kích. |
| **điều-phối-2-trục** | Hàm `dispatch(d, br)` đọc PEG (`d`) và SOLVENCY (`br`) tách biệt; gốc gỡ deadzone (`INV-2-AXIS`). |
| **C_circ** | Lượng CARP lưu-hành; mốc quy-chiếu sizing (panic 15%C, pool ~20%C, commit-Vacuum ≤20%C). |
| **`κ_eff`** | Hệ số an toàn cổng ScheduleGen (đệm động theo σ̂ LAMP); cấm đổi giữa vòng đời hợp đồng. |
| **`pp`** | Trần MAGIC tiêu mỗi epoch trong một hợp đồng Schedule (bất khả xâm). |
| **DID** | Định danh phi-tập-trung PhoenixKey (sinh trắc); gắn quyền-tiêu MAGIC + VP governance. |
| **EMT/ART** | E-money token / Asset-referenced token (MiCA); CARP fiat-neutral → **thoát EMT**, nhưng có cơ-chế-ổn-định → **khả năng bị phán ART còn** (không hứa thoát). |
| **Howey** | Test chứng-khoán Mỹ; MAGIC gãy prong-3, CARP rủi ro prong-4 giai đoạn đầu. |

---

> **Ghi chú nhất quán:** tài liệu này diễn giải kinh tế-token theo `Carpet-CARP-DacTa-Vi.md` (v0.3 — nguồn chân lý cho CARP/ổn-định) + `MagicLamp-3Token-DacTa-Vi.md` (kiến trúc 3-token). Khi mâu thuẫn về CARP/peg/tuyến-chính → theo `Carpet-CARP-DacTa-Vi.md`. Các đặc tả cũ (`MAGIC-Token-HopNhat-Vi.md`, CARP-Math bản CDP-USD / g_min-backing-core-toàn-CARP / neo-USD) **đã lỗi thời** — đè theo khung utility-floored v0.3. Vai-trò-app và tầm-nhìn-hệ-thống: xem **Whitepaper Hệ-sinh-thái**.
