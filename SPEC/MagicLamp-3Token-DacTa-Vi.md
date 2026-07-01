# Đặc tả Kiến trúc 3 Token — MagicLamp (LAMP · MAGIC · CARP)

> Trạng thái: **ĐỀ XUẤT** (draft v0.1, chờ duyệt). Chốt định hướng 2026-06-30.
> Nguồn: tổng hợp các hội đồng phân tích (đa-tài-phán, 1-vs-3-token, cơ-chế-nội-bộ, 12-agent MECE có sim thật) + spec `MAGIC-Token-HopNhat-Vi.md` v0.3 + `Carpet-CARP-DacTa-Vi.md` (đặc tả cơ chế ổn định CARP).
> Tài liệu này ĐÈ phần "một-token MAGIC" của các bản trước. Khi mâu thuẫn về số-token → theo file này.

---

## §0. Tóm tắt một trang — câu chuyện chiếc đèn thần

Hệ MagicLamp có **ba token, ba vai đối nghịch không thể gộp**, lấy đúng truyện Aladin làm ẩn dụ bản chất:

- **LAMP — Chiếc Đèn Thần.** Nguồn phép thuật. Ai sở hữu đèn thì có quyền triệu hồi điều ước. Đèn cố định **36 tỷ chiếc, không huỷ, không đốt**. Đây là **tài sản nền**, biến động theo cung-cầu thị trường.
- **MAGIC — Điều Ước.** Thần đèn ban ra điều ước khi chủ cọ đèn. Điều ước **chỉ phục tùng chủ nhân** (không chuyển nhượng), là **một phép thực thi cụ thể** (tiêu một lượng dịch vụ trong hệ), và **tan biến sau một thời hạn** nếu không dùng (decay). Điều ước **không bán được, không đổi ra vàng** — nó gắn với người đã cọ đèn.
- **CARP — Tấm Thảm Thần.** Phương tiện đưa người đi khắp nơi để **đến chợ dịch vụ mà tiêu**. Thảm **lưu thông, đổi tay, giữ giá** — người ở vùng cho phép trải thảm (trữ CARP) để bay tới nơi tiêu dùng. CARP là **đồng-thanh-khoản ổn định**, mua được bằng tiền mặt.

Quy luật vàng: **Đèn sinh Điều ước; Thảm chở giá trị tới nơi tiêu; Điều ước thì tan biến sau khi phục vụ chủ.** Ba thứ không thể là một, vì *giữ-được* (Thảm) và *tan-biến* (Điều ước) là hai cực loại trừ nhau.

**Vì sao ba chứ không một:** một đồng vừa "tiêu-thì-mất + chỉ-phục-tùng-chủ" (sạch pháp lý) vừa "giữ-giá + chuyển-nhượng-tự-do" (tiện lưu thông) là **bất khả** — hai thuộc tính triệt tiêu nhau. Tách ra cho mỗi vai một token là cách **trung thực với bản chất**, đồng thời đạt mục tiêu **"một đồng tuân thủ rõ (MAGIC) + một đồng vùng-xám-có-giấy-phép (CARP)"** trên phạm vi toàn cầu.

---

## §1. Định vị từng token

### §1.1 LAMP — Chiếc Đèn Thần (tài sản nền)
- **Bản chất:** token tài-sản-nền của hệ sinh thái. Tổng cung **cố định 36 tỷ, KHÔNG burn** (giảm lưu hành = chuyển Treasury kế toán, không đốt).
- **Vai:** (a) nguồn sinh MAGIC (cọ đèn → điều ước); (b) tài sản tham gia governance (qua PhoenixKey DID, **KHÔNG token-weighted**); (c) một trong các nguồn backing cho hợp đồng tín dụng MAGIC.
- **Thuộc tính:** chuyển nhượng được; biến động giá theo thị trường; nắm giữ là **chủ động** (không sinh lợi-tức-thụ-động theo số dư — xem firewall §10).
- **Ẩn dụ:** giữ đèn = giữ quyền-triệu-hồi-phép, không phải giữ một tờ hứa-trả-tiền.

### §1.2 MAGIC — Điều Ước (Consumable, lớp tiêu-dùng-sạch)
- **Bản chất:** **đơn-vị-tiêu-dịch-vụ trả trước** (prepaid service credit), neo **sức-mua-dịch-vụ nội sinh** (1 MAGIC = 1 đơn-vị-dịch-vụ-nền, ví dụ 1 lượt định danh, 1 ngày·1MB lưu trữ). **KHÔNG neo fiat.** `P* = 1`, base_price đổi chỉ qua DAO.
- **Ba thuộc tính bất biến (ba chân ghế làm nó sạch):**
  1. **Không chuyển nhượng** — chỉ phục tùng chủ nhân đã cọ đèn (gắn PhoenixKey DID).
  2. **Tan biến (decay)** — không tiêu trong thời hạn thì mất; không tích trữ làm của để dành.
  3. **Không chuộc ra tiền** — chỉ chuộc-ra-DỊCH-VỤ (tiêu trong hệ). Không đổi ngược thành LAMP/CARP/fiat.
- **Gen ≠ Mint:** MAGIC được **Gen** (cấp-quyền, entitlement issuance — không tăng cung-tiền, tan biến khi tiêu), KHÁC CARP được **Mint** (đúc-tiền, monetary creation). Cấm viết "mint MAGIC".
- **Quyền tiêu MỘT dịch vụ cụ thể:** mỗi MAGIC gắn một dịch vụ (ScheduleGen-lưu-trữ chỉ tiêu lưu-trữ, không đặt-logo) → nhà cung cấp điều tiết nguồn lực, hệ nhịp nhàng.
- **Sinh ra từ ba Gen** (chi tiết công thức: `Carpet-CARP-DacTa-Vi.md §5`): (a) **PrepaidGen** — khoá CARP/tài-sản → quỹ Paid platform, **tự-back, không giới hạn**; (b) **ScheduleGen** — nắm LAMP + tiêu định kỳ tương lai, đối ứng GreenBack; (c) **InstantGen** (gộp SnapshotGen+InstantGen cũ) — nắm LAMP + tiêu ngay, đối ứng GreenBack, trần-kép `≤0.5×Schedule`. LAMP **ở-yên-ví** (tư-cách, không thế-chấp) → không phải yield-thụ-động.
- **Backing:** **năng-lực cung dịch vụ của hệ** (mô hình gift-card), KHÔNG cần rổ tài sản tài chính. Vì không hứa chuộc-ra-tiền nên **thoát bài toán Terra + thoát khung stablecoin**.
- **Pháp lý:** **consumptive-use thuần** — Howey prong-3 gãy (mua để tiêu, không kỳ vọng lợi nhuận), không e-money (không chuộc tiền), không payment-instrument (không chuyển bên thứ ba). **Lớp tuân-thủ-rõ.**

### §1.3 CARP — Tấm Thảm Thần (Exchangeable, lớp lưu-hành-ổn-định)
- **Bản chất:** **đồng-thanh-khoản ổn định**, lưu hành, chuyển nhượng, giữ-giá. Có **policy-id riêng** (native token thật). Tên gợi *Carpet* — tấm thảm chở giá trị đến nơi tiêu.
- **Vai:** (a) phương tiện cho người **chưa có LAMP / thấy LAMP đắt** vẫn vào hệ tiêu dùng (mua CARP bằng fiat, trữ); (b) khả-năng-mua-dịch-vụ lưu hành trong hệ; (c) một nguồn backing tuỳ chọn cho hợp đồng tín dụng MAGIC (§6).
- **Thuộc tính:** chuyển nhượng tự do (trong hệ); **neo sức-mua-dịch-vụ nội sinh — KHÔNG neo fiat** (trung lập, không phụ thuộc tiền một quốc gia); mua được bằng fiat nhưng giá-trị đo theo *dịch vụ*, không theo USD.
- **Backing:** **sàn-tiện-ích (utility-floor)** — CARP luôn đổi được sang MAGIC để tiêu dịch vụ ở tỷ giá nội sinh (PrepaidGen 1:1 + pool-1:1-par nội bộ); arbitrage-qua-tiêu-dùng giữ CARP không rớt dưới giá-trị-dịch-vụ. **KHÔNG cần rổ USD, KHÔNG DEX ngoài.** Trên sàn-tiện-ích còn **3-back** đa-tầng (GreenBack đệm-κ / VacuumBack commit-khoá / RedBack đa-token ρ≤0.3 đỡ-peg gián-tiếp) — đệm là công-cụ-bình-ổn, KHÔNG phải cam-kết-chuộc. Chi tiết: `Carpet-CARP-DacTa-Vi.md §3-§4`.
- **Pháp lý (đúng MiCA — sửa lỗi "thoát ART" bản trước):** fiat-neutral → **thoát EMT**, NHƯNG có cơ-chế-ổn-định → **khả năng bị phán ART VẪN CÒN** (ESMA xét substance). Giảm rủi ro (không phải thoát): backing LAMP-nội-bộ không rổ-ngoại-sinh + đỡ-peg-gián-tiếp + không-marketing-stable + **geofence EU mặc định**. Chi tiết: `Carpet-CARP-DacTa-Vi.md §8`. Phân-vùng: mở vùng sáng, geofence vùng xám.

---

## §2. Quan hệ ba token + dòng giá trị + firewall

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

**Bốn dòng được phép:**
1. **LAMP → MAGIC** — Gen qua ScheduleGen (nắm LAMP, tiêu định kỳ) / InstantGen (nắm LAMP, tiêu ngay), đối ứng GreenBack. Backing nội-sinh.
2. **CARP → MAGIC** — PrepaidGen: khoá CARP → quỹ Paid platform lấy quyền-tiêu MAGIC (một chiều, cam kết tiêu, tự-back).
3. **CARP ⇄ MAGIC pool-1:1-par nội bộ** — giữ peg CARP/MAGIC bằng cơ-chế-nội-bộ, KHÔNG DEX ngoài. (Quỹ độc lập có thể mua CARP rẻ bằng ADA/LAMP — market-op, không qua sàn tên riêng.)
4. **MAGIC → dịch vụ** — tiêu (đốt) hoặc tan biến. **KHÔNG có đường nào khác.**

**Ba firewall sống còn (vi phạm = sập kiến trúc):**
- **F1 — MAGIC một chiều.** Không có dòng MAGIC → CARP/LAMP/tiền. Điều ước đã ban thì chỉ để dùng, không hoàn lại thành thảm bán được. (Nếu cho ra → MAGIC thành tài-sản-chuộc-được → mất tính sạch + tái sinh bài toán Terra.)
- **F2 — Ma sát CARP → MAGIC.** Đổi CARP sang quyền-tiêu là **cam kết tiêu** (gắn DID, không hoàn). KHÔNG đổi 1:1 tự do qua lại, kẻo regulator nhìn xuyên "MAGIC = CARP đội lốt."
- **F3 — Không lợi-tức-thụ-động.** Không token nào trả dòng-giá-trị theo số-dư. Nắm LAMP/đặt ScheduleGen là **chủ động** (nắm-giữ, cam kết), không phải yield. (Đây là tường-lửa Howey thật, mạnh hơn tách-token.)

---

## §3. LAMP — đặc tả

| Hạng mục | Nội dung |
|---|---|
| Loại | Native token, policy-id riêng (đã có) |
| Cung | 36 tỷ cố định, không mint thêm, **không burn** |
| Vai backing | nắm-giữ đối ứng Gen MAGIC (ScheduleGen/InstantGen, đối ứng GreenBack); nguồn khoá hợp đồng (§6) |
| Governance | đọc LAMP-nắm-tại-snapshot cho tư-cách, **KHÔNG nhân số lượng** (chống plutocracy); VP do PhoenixKey DID |
| Biến động | có; rủi-ro-giá do **hệ gánh** (g_min, GreenBack carry), không đẩy sang người-tiêu-MAGIC |
| Pháp lý | tài-sản-số/utility nền; rủi ro Howey-4 ở giai đoạn DAO chưa đủ phi-tập-trung; **không yield thụ động** (F3) |

---

## §4. MAGIC — đặc tả (Điều Ước / Consumable)

| Hạng mục | Nội dung |
|---|---|
| Loại | **Số-dư-quyền-tiêu gắn DID trong vault datum, KHÔNG chuyển nhượng** (có thể không cần policy-id riêng; validator xác minh quyền tiêu) |
| Đơn vị neo | sức-mua-dịch-vụ nội sinh, `P*=1`, base_price khoá on-chain, đổi qua DAO. KHÔNG fiat. |
| Sinh ra (Gen) | (a) **PrepaidGen** (khoá CARP → quỹ Paid platform, tự-back, không giới hạn); (b) **ScheduleGen** (nắm LAMP, tiêu định kỳ/epoch, đối ứng GreenBack); (c) **InstantGen** (nắm LAMP, tiêu ngay, đối ứng GreenBack, trần-kép ≤0.5×Schedule, M=Σwᵢ·Lᵢ tuổi-chỉ-gate; M=0 khi backing đỏ). Chi tiết: `Carpet-CARP-DacTa-Vi.md §5` |
| Tiêu | đốt khi dùng dịch vụ; **tối đa `pp`/epoch** (INV-SCHEDULE-CAP-PER-EPOCH) |
| Decay | không tiêu trong thời hạn → mất (chống tích-trữ, củng cố consumptive-use) |
| Chuyển nhượng | KHÔNG (chỉ chủ-DID tiêu) |
| Chuộc | chỉ ra **dịch vụ**; KHÔNG ra tiền/CARP/LAMP (F1) |
| Backing | năng-lực-dịch-vụ của hệ (gift-card); KHÔNG rổ tài chính |
| Pháp lý | consumptive-use/prepaid-credit; sạch nhất hệ |

**Vì sao MAGIC không phải stablecoin:** nó không hứa trả 1 USD, không hứa trả 1 đồng nào — nó hứa **giao một lượng dịch vụ**. "Ổn định" của MAGIC là *1 điều-ước luôn đổi được 1 lượng-dịch-vụ-nền*, không phải *1 MAGIC = 1 USD*. Giá fiat/MAGIC dao động mặc kệ; điều ước vẫn thực thi đúng phép đã hứa.

---

## §5. CARP — đặc tả (Tấm Thảm / Exchangeable)

| Hạng mục | Nội dung |
|---|---|
| Loại | Native token, **policy-id riêng**, chuyển nhượng (trong hệ) |
| Vai | đồng-thanh-khoản: cổng-vào bằng fiat + đồng lưu-hành trong hệ + nguồn khoá hợp đồng (§6) |
| Ổn định | **sàn-tiện-ích** (CARP→MAGIC→tiêu, arbitrage-qua-tiêu-dùng; PrepaidGen 1:1 + pool-1:1-par nội bộ) là neo CHÍNH — KHÔNG cần rổ USD, KHÔNG DEX ngoài. Trên đó là **3-back** (GreenBack đệm-κ / VacuumBack commit-khoá / RedBack đa-token ρ≤0.3 đỡ-peg gián-tiếp), đệm là công-cụ-bình-ổn KHÔNG cam-kết-chuộc. Ổn định theo **sức-mua-dịch-vụ**, KHÔNG theo USD. Chi tiết: `Carpet-CARP-DacTa-Vi.md §3-§4` |
| Cơ chế đúc/chuộc | **[ĐANG THIẾT KẾ]** — Mint khi có cầu vào (fiat/LAMP → CARP); giữ peg bằng **pool-1:1-par nội bộ + utility-floor**, KHÔNG chuộc-ra-tiền-từ-issuer (giữ fiat-neutral + thoát EMT). 3-back bình ổn khi rớt dưới intrinsic |
| Chuyển nhượng | tự do trong hệ; **không kỳ vọng giao dịch ngoài hệ** (ai muốn ra ngoài tự lo) |
| Pháp lý | **function-stable crypto asset / utility fiat-neutral** — fiat-neutral → **thoát EMT**, NHƯNG có cơ-chế-ổn-định → **khả năng bị phán ART còn** (không hứa thoát); giảm rủi ro bằng backing-nội-bộ + đỡ-peg-gián-tiếp + không-marketing-stable + **geofence EU mặc định**. Xám vì chuyển-nhượng/đầu-cơ (Howey-4). License/geofence theo vùng |

**CARP gánh rủi ro chuyển-nhượng thay cả hệ.** Vì là token duy-nhất-lưu-hành-tự-do, mọi rủi ro thị-trường-thứ-cấp + đầu-cơ + Howey-4 tụ vào CARP. Cô lập vào một token là **chủ đích**, để MAGIC + phần-lớn-người-dùng đứng ngoài. Lưu ý trung thực: CARP fiat-neutral **thoát EMT**, nhưng có cơ-chế-ổn-định nên **khả năng bị phán ART còn** — khác USDC là **đánh đổi** (thoát EMT/yield, gánh ART/Howey-4), KHÔNG "nhẹ hơn".

**Firewall riêng cho CARP:** (a) KHÔNG mint-tự-do-từ-tiêu-MAGIC (= Terra, F1 áp ngược); (b) đệm-3-back phải **đa-dạng-trung-lập** — CẤM thuần-LAMP-biến-động vào core (tự-tham-chiếu = Terra) VÀ CẤM thiên-một-fiat (mất trung lập); (c) rổ-đệm là **công-cụ-bình-ổn, KHÔNG phải cam-kết-chuộc-giá-rổ** (kẻo thành ART).

---

## §6. Hợp đồng mua tín dụng MAGIC — đa-nguồn (LAMP hoặc CARP)

Khi một app đặt hợp đồng cấp MAGIC cho người dùng, app **chọn nguồn khoá** linh hoạt theo tình huống thị trường:

**Nguồn A — nắm LAMP.**
- App nắm LAMP (ở-yên-ví, tư-cách) → ScheduleGen/InstantGen sinh quyền-tiêu MAGIC cho người dùng (gắn DID người đó), đối ứng GreenBack.
- Hết thời hạn hợp đồng, LAMP vẫn thuộc app để tái dùng.
- **Khi nào dùng:** backing khoẻ → người-nắm-LAMP đang được Gen MAGIC **tỷ giá cao hơn thông thường** (nhiều MAGIC/LAMP) → hiệu quả vốn cao.
- **Đánh đổi:** app gánh rủi-ro-giá-LAMP trong thời hạn khoá.

**Nguồn B — khoá CARP.**
- App khoá CARP → mỗi lần người dùng tiêu, một phần CARP chuyển thành quyền-tiêu MAGIC (F2: một chiều, cam kết).
- **Khi nào dùng:** app **kỳ vọng giá LAMP sắp sụp** → không muốn giữ LAMP, muốn giữ CARP-stable để **mua lại LAMP giá thấp sau**; hoặc app chỉ sẵn CARP.
- **Đánh đổi:** dùng tài sản đắt hơn (stable) nhưng ổn định, không gánh rủi-ro-giá-LAMP.

> **Tình huống động cơ tinh tế (lý do phải cho cả hai nguồn):** một người nắm LAMP có thể *đồng thời* (i) đang được quyền Gen MAGIC tỷ giá cao (thặng dư lớn) và (ii) kỳ vọng LAMP sắp sụp. Họ tận dụng quyền-Gen-cao bằng **Nguồn A** cho hợp đồng, đồng thời chuẩn bị **CARP** để mua lại LAMP rẻ sau cú sụp. Hệ cho phép cả hai nguồn → app/người dùng tối ưu được theo kỳ vọng riêng, không bị kẹt một lựa chọn.

**Bất biến chung cho cả hai nguồn:**
- Quyền-tiêu MAGIC sinh ra **chỉ người-dùng-đích (DID) tiêu được** (cần `did_commit` thật — §8 blocker).
- Người dùng được đảm bảo **đúng lượng dịch vụ đã mua** (vd 3000 lượt/3 tháng) **bất kể giá LAMP** — vì MAGIC neo-dịch-vụ, hệ gánh rủi-ro-giá.
- Phí mạng (ADA + DUST) cho mỗi thao tác đã **gói trong giá MAGIC**; PhoenixKey thu phần tương ứng về Treasury (qua CARP) để bù — người dùng không cần cầm ADA/DUST.

---

## §7. Cơ sở pháp lý

### §7.1 Nguyên tắc nền
- **Phán theo bản chất, không theo nhãn.** Mỗi token bị xử theo thuộc tính thật của nó, bất kể chung thương hiệu "MagicLamp."
- **"Tuân thủ tuyệt đối không vùng xám" là BẤT KHẢ** cho mọi token chuyển nhượng (đúng cả USDC). Mục tiêu thực tế: **phân-vùng-tài-phán** (license nơi cần, geofence nơi chưa) + **cô lập rủi ro vào CARP**, giữ MAGIC sạch tuyệt đối.
- **Tách-vai bằng ba-token + ba-firewall** là *substance-over-form* thật, mạnh hơn lá-chắn-hình-thức.

### §7.2 Phân loại từng token
- **LAMP** — tài-sản-số/utility nền. Vùng xám có thể hạn chế nắm giữ; geofence nơi cần.
- **MAGIC** — prepaid-service-credit/consumptive-use. **Ngoài** securities (Howey-3 gãy), **ngoài** e-money (không chuộc tiền), **ngoài** payment-instrument (không chuyển bên thứ ba), **closed-loop**. Lớp sạch — dùng được ở **cả vùng xám lẫn sáng** (qua bộ-đệm-app vùng sáng ở nơi chặn LAMP/CARP).
- **CARP** — **utility-token fiat-neutral có cơ-chế-ổn-định**: fiat-neutral → **thoát EMT**, NHƯNG có cơ-chế-ổn-định → **khả năng bị phán ART còn** (ESMA xét substance; KHÔNG hứa thoát ART). Giảm rủi ro bằng backing-nội-bộ + đỡ-peg-gián-tiếp + không-marketing-stable + **geofence EU mặc định**. Xám vì **chuyển-nhượng-tự-do + thị-trường-thứ-cấp** (Howey-4 giai đoạn DAO chưa đủ phi-tập-trung; một số tài phán coi mọi crypto-asset = financial-product). Mở vùng sáng (đăng ký VASP/CASP nơi cần); geofence vùng xám. Chi tiết: `Carpet-CARP-DacTa-Vi.md §8`.

### §7.3 Phân vùng vận hành (cổng Register / DAO đặt chuẩn)
| Vùng | LAMP | MAGIC | CARP |
|---|---|---|---|
| **Sáng** (Mỹ, EU-MiCA, Úc, Ấn-độ…) | mở | mở | **mở (đăng ký VASP/CASP; KHÔNG phải EMI vì không neo-fiat)** |
| **Xám** (VN, nơi chặn) | chặn nắm giữ | **mở** (qua app vùng sáng, closed-loop) | chặn |

### §7.4 Tóm 6 thị trường (chi tiết: hội đồng wtt6njmdo / w6w33ub2c)
- **Việt Nam:** rủi-ro số một = **payment-function**. MAGIC closed-loop-tiêu-dịch-vụ + không-neo-fiat = an toàn; CARP **không** mở cho user VN (geofence) hoặc qua 1/5 sàn thí điểm NQ05; cấm dùng làm phương tiện thanh toán hàng bên-thứ-ba.
- **Mỹ:** MAGIC ngoài GENIUS payment-stablecoin (không neo fiat) + Howey-3 gãy; CARP cần FinCEN MSB + state MTL nếu mở. Marketing cấm narrative đầu-tư.
- **EU:** CARP fiat-neutral → **thoát EMT**, NHƯNG có cơ-chế-ổn-định → **khả năng bị phán ART còn** (ESMA xét substance) → **geofence EU mặc định + chờ luật sư MiCA**, KHÔNG hứa thoát ART. MAGIC (consumptive-use, không-chuộc-tiền) ngoài EMT/ART.
- **Úc:** AUSTRAC đăng ký cho cổng đổi CARP; AFSL nếu CARP = non-cash-payment/financial-product. MAGIC utility-tiêu ngoài diện.
- **Ấn Độ:** không security-test; gánh thuế 30%+1%TDS mỗi giao dịch CARP; MAGIC-tiêu ít chạm.
- **Châu Phi (Nigeria/Nam Phi):** dễ thở hơn EU; Nam Phi FSCA coi mọi crypto-asset = financial-product → CARP cần license; minh bạch dự trữ.

### §7.5 Geofence — điều kiện ĐỦ (không tự đủ một mình)
Tiền lệ (BitMEX, Binance/CZ, Tornado Cash, Bitfinex): regulator truy **hành vi + ý định**, không truy IP-block. Geofence chỉ tính khi kèm: **DID/KYC-gate thật** (PhoenixKey) + chặn-VPN + log + **không-solicit** vào tài phán chặn + không-tài-liệu-chỉ-cách-né + **AML-program** + đăng ký MSB/VASP nơi có user thật. Geofence-dán-nhãn-rồi-làm-ngơ = **tăng nặng** hình sự.

---

## §8. Cơ sở kỹ thuật

### §8.1 Kiến trúc on-chain mỗi token
- **LAMP:** native token sẵn có (policy-id riêng). Vault khoá có điều kiện (thời hạn/owner) đã có, tái dùng được.
- **MAGIC:** **số-dư-quyền-tiêu trong vault datum gắn DID, non-transferable** — validator xác minh: chỉ tiêu khi `signer == DID-owner`, trừ dần, decay theo epoch. **Tin tốt:** đây CHÍNH LÀ mô hình code MAGIC hiện có ("số kế toán trong VaultDatum") — cái từng bị gọi "phải xây mới" thực ra **dùng lại được cho MAGIC**; chỉ **CARP** cần native-token-mới. Phạm vi xây-mới **co lại**, không phình.
- **CARP:** **cần xây mới** — MintingPolicy native + cơ chế ổn định (rổ backing, br, g_min) + đúc/chuộc. Đây là lõi-tiền-tệ thật.

### §8.2 Blocker đã biết (chặn demo đúng kịch bản §9)
1. **`did_commit` thật** (hiện `#""` rỗng, `consume.ak`) — "chỉ chủ-DID tiêu" đòi commitment blake2b256 liên kết quyền-tiêu ↔ PhoenixKey DID. **Thuộc PhoenixKey backend → giao Long** (ranh giới: Claude không sửa).
2. **Paymaster runner + deploy** — fee-abstraction (quy CARP→ADA trả phí thay user, cơ-chế-nội-bộ). Có validator+SDK (28+21 test) nhưng chưa có runner/deploy.
3. **DUST/Midnight spike** — nếu dịch vụ cần privacy (Midnight). Hệ giữ NIGHT → sinh DUST trả thay; chưa thiết kế.

### §8.3 Tham số phải chốt trước khi xây lõi (B0)
`g_min ≥ 67%` (**CHỈ áp tuyến-phụ-CDP**, KHÔNG phải backing-core-toàn-CARP — CARP là utility-floored, giữ peg bằng cầu-dịch-vụ-thực); tỷ trọng tranche cứng tuyến-phụ; `wᵢ` + epoch tích phân InstantGen; `κ_eff` cổng ScheduleGen; `protocol_cut_bps`; cọc escrow `η`; cơ chế Mint CARP (pool-1:1-par nội bộ) + utility-floor + sim phòng-thủ-giá. **Tỷ giá:** 1 nanogic = 1 KB·ngày (SI) → 1 MAGIC = 1 TB·ngày (tham-chiếu ~3 CARP/USD, KHÔNG neo fiat). Chi tiết: `Carpet-CARP-DacTa-Vi.md §2, §5-§6`.

---

## §9. Mô phỏng ví dụ — vùng xám hoàn toàn (chị Oanh)

**Bối cảnh:** quốc gia vùng-xám chặn **cả LAMP lẫn CARP**; chỉ cho ADA làm crypto chi trả phí mạng. Chị Oanh cần **3000 MAGIC** để định danh sầu riêng trong 3 tháng tới qua **Farm app**; chị có **PersonDID** PhoenixKey.

**Luồng:**
1. Chị Oanh dùng **fiat** mua "gói định danh 3 tháng" trên Farm app (Farm có trụ sở **vùng sáng**, có license + cổng thanh toán hợp pháp). Chị không chạm LAMP/CARP/token đầu cơ nào.
2. Farm app đặt hợp đồng cấp MAGIC, **chọn nguồn** (§6):
   - **Nguồn A:** Farm nắm **LAMP** của Farm (ở-yên-ví) → ScheduleGen sinh 3000 quyền-tiêu MAGIC **gắn DID chị Oanh** (chỉ chị tiêu). Hết 3 tháng, LAMP vẫn thuộc Farm tái dùng.
   - **Nguồn B:** Farm khoá **CARP** (PrepaidGen) → mỗi lệnh định danh, một phần CARP → MAGIC cho chị tiêu.
   - Farm chọn A khi đang được Gen tỷ giá cao; chọn B khi kỳ vọng LAMP sụp (giữ CARP mua lại rẻ).
3. Mỗi lần chị Oanh ký một lệnh định danh: trừ MAGIC tương ứng; **phí mạng (ADA + DUST) đã gói trong giá MAGIC** — PhoenixKey thu phần đó về Treasury (qua CARP) và trả phí mạng thay. **Chị Oanh không cần cầm ADA.**
4. Quyền-tiêu MAGIC **chỉ chị Oanh dùng được**, **tan biến** nếu hết 3 tháng chưa dùng hết (ScheduleGen rải đều để chị không phí).

**Vì sao hợp pháp ở vùng xám:** chị Oanh chỉ (a) trả fiat mua dịch vụ từ nhà cung cấp nước ngoài (như mua SaaS); (b) nhận quyền-tiêu-dịch-vụ non-transferable (không phải tài sản tài chính); (c) không nắm LAMP/CARP. Toàn bộ token nằm ở **Farm app vùng sáng**. Đây là **bộ-đệm-pháp-lý**: crypto dưới mui xe ở vùng sáng, người dùng vùng xám chỉ chạm fiat + điều-ước-phục-tùng-chủ.

**Điều kiện để kịch bản đứng vững:**
- LAMP/CARP **không bao giờ** vào quyền-sở-hữu chị Oanh (✓).
- MAGIC giữ ba thuộc tính (non-transferable + decay + không-chuộc-tiền) (✓).
- Farm **bán đứt gói dịch vụ**, KHÔNG hứa hoàn-MAGIC-thành-fiat (kẻo thành custody/e-money).
- Dòng fiat ra nước ngoài qua **cổng thanh toán hợp pháp** (tuân ngoại hối/AML); Farm có pháp nhân + KYC (PersonDID).
- Chính sách **hoàn fiat trước khi tiêu** + truyền thông rõ "gói có hạn dùng" (xử consumer-protection vs decay).

---

## §10. Bất biến (firewall) — bản tổng hợp

| Mã | Nội dung |
|---|---|
| **F1-MAGIC-ONE-WAY** | Không có dòng MAGIC → CARP/LAMP/tiền. Điều ước chỉ để tiêu hoặc tan biến. |
| **F2-CARP-FRICTION** | CARP → MAGIC là cam-kết-tiêu gắn-DID, một chiều, không hoàn; không đổi 1:1 tự do qua lại. |
| **F3-NO-PASSIVE-YIELD** | Không token nào trả dòng-giá-trị theo số-dư; nắm LAMP/đặt ScheduleGen là chủ động. |
| **F4-MAGIC-CLOSED** | MAGIC non-transferable + decay + không-chuộc-tiền + tiêu-trong-hệ. |
| **F5-CARP-FIAT-NEUTRAL** | CARP neo-dịch-vụ, KHÔNG neo-fiat, KHÔNG chuộc-ra-tiền. Sàn = utility-floor (CARP→MAGIC, PrepaidGen 1:1 + pool-1:1-par nội bộ), KHÔNG DEX ngoài. 3-back (GreenBack/VacuumBack/RedBack) đa-dạng-trung-lập: CẤM thuần-LAMP vào core (Terra) VÀ CẤM thiên-một-fiat; rổ là công-cụ-bình-ổn không phải cam-kết-chuộc. |
| **F6-NO-EXTERNAL-INPUT** | Cơ chế lõi (cổng, ngưỡng solvency) chỉ căn số-dư-nội-bộ, KHÔNG oracle-giá điều khiển. |
| **F7-VUNG-XAM-BUFFER** | Ở nơi chặn LAMP/CARP, người dùng chỉ chạm fiat + MAGIC; token nằm ở app vùng sáng; app bán-đứt-không-hoàn-tiền. |

---

## §11. Điểm mở + lộ trình

**Còn quyết:**
1. Cơ chế Mint CARP cụ thể (pool-1:1-par nội bộ) + utility-floor + sim phòng-thủ-giá (chi tiết `Carpet-CARP-DacTa-Vi.md §3, §6`).
2. CARP genesis: Mint khi có cầu vào (fiat/LAMP→CARP); cỡ + thành phần 3-back đa-dạng-trung-lập (không-fiat).
3. Tham số B0 (§8.3).
4. MAGIC có cần policy-id riêng hay thuần validator-entitlement (nghiêng entitlement — sạch hơn).

**Lộ trình:**
1. Chốt §11.1-3 → viết bản-phân-tích-pháp-lý-chi-tiết theo 3-token.
2. did_commit thật (giao Long) → demo kịch bản §9 trên Preview.
3. Xây lõi CARP (MintingPolicy + ổn định) — phần xây-mới thật.
4. Paymaster runner (fee-abstraction cơ-chế-nội-bộ).
5. CI link-test-thực-tế (anh duyệt push).

---

> **Ghi chú nhất quán:** tài liệu này thay khái niệm "một-token MAGIC" trong các bản trước. Spec cơ chế ổn định CARP + 3 Gen (PrepaidGen/ScheduleGen/InstantGen, GreenBack, 3-back, g_min, invariants) ở `Carpet-CARP-DacTa-Vi.md` — khi mâu thuẫn về CARP/ổn-định → theo file đó.
