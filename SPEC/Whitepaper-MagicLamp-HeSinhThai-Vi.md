# Whitepaper — Hệ sinh thái MagicLamp

> **Trạng thái:** DRAFT v0.2 (chờ duyệt). Soạn 2026-06-30, cập nhật 2026-07-01 (thêm cấu-trúc-phân-cấp + Registry-mở).
> **Đối tượng:** người mới, đối tác, cộng đồng — tài liệu tổng quát.
> **Nguồn chân lý:** `MagicLamp-3Token-DacTa-Vi.md` (kiến trúc 3 token) + `Carpet-CARP-DacTa-Vi.md` v0.3 §5b (cấu-trúc-phân-cấp + Registry-mở). Whitepaper này diễn giải tầm nhìn + kiến trúc hệ sinh thái ở mức cao; **không** đi vào tokenomics chi tiết (xem Whitepaper Tokenomic) hay kỹ thuật từng dự án.
>
> **Đọc cái nào để biết gì:** *Whitepaper này* — bức tranh tổng quát, đọc trước để nắm tầm nhìn và vai từng phần. *Whitepaper Tokenomic* — đi sâu vào con số, cơ chế đúc/chuộc, tham số kinh tế. *Đặc tả 3-token* (`MagicLamp-3Token-DacTa-Vi.md`) — quy tắc kỹ thuật và pháp lý chi tiết của ba token. Người mới chỉ cần tài liệu này; ai muốn chi tiết kinh tế hoặc kỹ thuật thì lần lượt sang hai tài liệu kia.
>
> **Lưu ý rủi ro (đọc trước):** LAMP và CARP là token **chuyển nhượng, biến động giá**; tài liệu này **không** là lời mời đầu tư và **không** cam kết lợi nhuận hay lợi tức thụ động. MAGIC thì không bán lại được — chỉ để tiêu dịch vụ. Cân nhắc rủi ro trước khi tham gia.

---

## Mục lục

1. [Tóm tắt](#1-tóm-tắt)
2. [Vấn đề chúng tôi giải](#2-vấn-đề-chúng-tôi-giải)
3. [Tầm nhìn — chiếc đèn thần mở cho mọi người](#3-tầm-nhìn--chiếc-đèn-thần-mở-cho-mọi-người)
4. [Ba token, ba vai — ở mức cao](#4-ba-token-ba-vai--ở-mức-cao)
5. [Danh tính nền: PhoenixKey DID sinh trắc](#5-danh-tính-nền-phoenixkey-did-sinh-trắc)
6. [Quản trị cá nhân — không token-weighted](#6-quản-trị-cá-nhân--không-token-weighted)
7. [Cổng Register / DAO đặt chuẩn](#7-cổng-register--dao-đặt-chuẩn)
8. [Cấu trúc phân cấp — Ecosystem · Platform · App](#8-cấu-trúc-phân-cấp--ecosystem--platform--app)
9. [Registry mở — ai cũng vào, cạnh tranh bình đẳng](#9-registry-mở--ai-cũng-vào-cạnh-tranh-bình-đẳng)
10. [MagicLamp là SDK mở cho mọi Cardano team](#10-magiclamp-là-sdk-mở-cho-mọi-cardano-team)
11. [Phân vùng tài phán — sáng và xám](#11-phân-vùng-tài-phán--sáng-và-xám)
12. [Lộ trình](#12-lộ-trình)
13. [Lời kết](#13-lời-kết)

---

## 1. Tóm tắt

MagicLamp là một hệ sinh thái mở trên Cardano, dựng quanh một ý tưởng đơn giản: **biến giá trị thành dịch vụ có ích cho con người, theo cách trung thực với pháp luật và bền vững với cộng đồng.**

Cốt lõi gồm ba phần khớp nhau:

- **Một tài sản nền** — LAMP, cố định 36 tỷ, không đốt — làm gốc giá trị và gốc quản trị.
- **Một danh tính thật** — PhoenixKey DID sinh trắc — để mỗi người là một người, không phải một số dư ví.
- **Một lớp dịch vụ sạch** — các app nông nghiệp, lưu trữ, việc làm, truy xuất nguồn gốc — nơi giá trị được tiêu thành điều có ích thực.

Ba token (LAMP · MAGIC · CARP) chia ba vai đối nghịch, để hệ vừa **tuân thủ rõ ràng** ở nơi cần, vừa **lưu thông linh hoạt** ở nơi cho phép. Mục tiêu cuối cùng: LAMP/MagicLamp trở thành một **SDK mở** mà bất kỳ đội ngũ Cardano nào cũng dựng được ứng dụng có token, có danh tính, có quản trị — mà không phải tự xây lại từ đầu.

---

## 2. Vấn đề chúng tôi giải

Phần lớn dự án token hôm nay vướng cùng một bộ bài toán:

1. **Một token gánh quá nhiều vai.** Người ta muốn một đồng vừa giữ giá để lưu thông, vừa "tiêu là mất" cho sạch pháp lý, vừa làm phiếu bầu. Ba nhu cầu này **triệt tiêu nhau**: thứ giữ-được-và-bán-được thì không thể đồng thời là thứ tiêu-thì-tan-biến. Gộp lại là tự mâu thuẫn, và regulator nhìn xuyên.

2. **Quản trị bị tiền mua.** "Một token một phiếu" nghe dân chủ nhưng thực chất là **tài phiệt**: ai giàu hơn nắm nhiều quyền hơn. Cộng đồng mất tiếng nói vào tay người gom vốn.

3. **Danh tính giả tràn lan (Sybil).** Không có danh tính thật, một người tạo nghìn ví, airdrop và bỏ phiếu bị thao túng.

4. **Pháp lý dán nhãn bề mặt.** Nhiều dự án dán nhãn "utility" rồi vận hành như chứng khoán, hoặc hứa chuộc-ra-tiền như stablecoin mà không gánh nổi rủi ro. Khi vỡ, người dùng thiệt.

5. **Mỗi đội tự xây lại từ số 0.** Token, danh tính, quản trị, tích hợp — mỗi dự án Cardano dựng riêng, tốn kém và dễ sai.

MagicLamp giải cả năm: **tách vai bằng ba token**, **quản trị theo người chứ không theo ví**, **danh tính sinh trắc chống Sybil**, **phán theo bản chất chứ không theo nhãn**, và **đóng gói tất cả thành SDK mở**.

---

## 3. Tầm nhìn — chiếc đèn thần mở cho mọi người

Chúng tôi mượn đúng truyện Aladin làm ẩn dụ bản chất, vì nó nói chính xác cách hệ vận hành:

- **LAMP — Chiếc Đèn Thần.** Nguồn phép thuật. Ai giữ đèn thì có quyền triệu hồi điều ước. Đèn cố định **36 tỷ chiếc, không huỷ, không đốt**. Đây là tài sản nền.
- **MAGIC — Điều Ước.** Thần đèn ban điều ước khi chủ cọ đèn. Điều ước **chỉ phục tùng chủ nhân**, là một phép thực thi cụ thể (một lượng dịch vụ), và **tan biến** nếu không dùng. Không bán được, không đổi ra vàng.
- **CARP — Tấm Thảm Thần.** Phương tiện chở người tới chợ dịch vụ mà tiêu. Thảm **lưu thông, đổi tay** — ai ở vùng cho phép thì mua thảm (bằng tiền) để bay tới nơi tiêu dùng. Thảm này phải **mua** và **lên xuống giá theo thị trường**, không phải phương tiện miễn phí hay an toàn tuyệt đối.

Quy luật vàng: **Đèn sinh Điều ước; Thảm chở giá trị tới nơi tiêu; Điều ước tan biến sau khi phục vụ chủ.**

Tầm nhìn không dừng ở một ứng dụng. Đèn thần này **mở**: bất kỳ đội ngũ Cardano nào cũng có thể cọ đèn cho cộng đồng của mình — dựng app nông nghiệp, lưu trữ, việc làm, truy xuất nguồn gốc — trên cùng một nền giá trị, một danh tính, một bộ quản trị. Đó là lý do mục tiêu cuối là **SDK mở**, không phải một sản phẩm đóng.

---

## 4. Ba token, ba vai — ở mức cao

> Phần này chỉ nêu **vai** ở mức cao. Cơ chế đúc/chuộc, công thức, tham số, firewall chi tiết nằm ở **Whitepaper Tokenomic** và đặc tả 3-token — whitepaper này không lặp lại.

| Token | Ẩn dụ | Vai một câu | Tính chất nổi bật |
|---|---|---|---|
| **LAMP** | Đèn Thần | Tài sản nền + gốc quản trị | Cố định 36 tỷ, không đốt, chuyển nhượng, biến động theo thị trường |
| **MAGIC** | Điều Ước | Quyền tiêu **một dịch vụ cụ thể** — lớp sạch | Không chuyển nhượng, tan biến nếu không dùng, chỉ đổi ra **dịch vụ** (không ra tiền) |
| **CARP** | Thảm Thần | Đồng thanh khoản ổn định | Chuyển nhượng, có **sàn dưới** theo **dịch vụ** (không theo USD), trung lập với mọi đồng fiat; vẫn biến động giá, có rủi ro thị trường |

Ba điểm cần nhớ:

- **MAGIC là lớp tuân-thủ-rõ.** Vì tiêu-là-mất, chỉ-phục-tùng-chủ, và không bao giờ đổi ngược ra tiền, nó là tín-dụng-dịch-vụ-trả-trước sạch — như một thẻ quà tặng số. Đây là thứ người dùng cuối thực sự chạm khi dùng app. MAGIC có **hạn dùng**: không tiêu trong thời hạn thì tan biến. Đây là điều cần thiết để giữ MAGIC luôn là "phiếu tiêu dịch vụ" chứ không thành của để dành đầu cơ; và để người dùng không mất oan, MAGIC được **rải đều theo lịch** (ScheduleGen) đúng nhịp người dùng tiêu, kèm truyền thông rõ "gói có hạn dùng".
- **CARP gánh rủi ro lưu thông thay cả hệ.** Vì là token duy nhất chuyển nhượng tự do, mọi rủi ro thị trường thứ cấp được **cô lập có chủ đích** vào CARP, để MAGIC và phần lớn người dùng đứng ngoài.
- **LAMP là gốc.** Giữ LAMP là giữ quyền-triệu-hồi-phép và tư cách tham gia quản trị — không phải giữ một tờ hứa-trả-tiền, và **không** sinh lợi tức thụ động theo số dư.

Về **cung**: chỉ LAMP có tổng cung cố định (36 tỷ). **MAGIC** không có tổng cung định trước — nó được **sinh ra khi có người cọ đèn** (khoá LAMP/CARP để nhận quyền tiêu) và **mất đi khi tiêu hoặc tan biến**, nên lượng lưu hành luôn co theo nhu cầu dùng thật. **CARP** được **đúc khi có cầu vào** (người mua bằng tiền hoặc đổi từ LAMP) chứ không phát hành một lần. Con số và cách đúc/chuộc cụ thể nằm ở Whitepaper Tokenomic.

Dòng giá trị **chính** chảy xuôi: **LAMP sinh ra MAGIC → MAGIC tiêu thành dịch vụ → dịch vụ phục vụ con người.** Bên cạnh đó, CARP là tấm thảm giúp người chưa có LAMP vẫn vào được chợ dịch vụ (CARP đổi sang MAGIC để tiêu), và LAMP ⇄ CARP ⇄ ADA gặp nhau ở chỗ đổi để tạo thanh khoản. MAGIC **không có đường ra** — đã ban thì chỉ để dùng.

> **Lưu ý "giữ giá":** với CARP, "giữ giá theo dịch vụ" **không** có nghĩa giá cố định như một stablecoin. CARP vẫn **lên xuống theo thị trường**; cơ chế chỉ đảm bảo một **sàn dưới** — CARP luôn đổi được sang một lượng dịch vụ tương ứng, nên không rớt dưới giá-trị-dịch-vụ. Mua CARP **không** an toàn tuyệt đối; nó là token chuyển nhượng, có rủi ro thị trường (xem §11).

---

## 5. Danh tính nền: PhoenixKey DID sinh trắc

Cả hệ đứng trên một nền danh tính: **PhoenixKey DID** — mỗi con người thật ứng với đúng một danh tính số, neo bằng đặc trưng sinh trắc.

Vì sao điều này quyết định:

- **Một người, một tiếng nói.** Quản trị tính theo người, nên DID sinh trắc là điều kiện để "một người = một phiếu nền", chặn Sybil từ gốc.
- **Điều ước gắn chủ.** MAGIC chỉ phục tùng chủ-DID đã cọ đèn — không ai tiêu hộ, không ai bán lại. Tính sạch của MAGIC dựa trên việc DID là thật.
- **Quyền riêng tư trong tay người dùng.** PhoenixKey là lớp danh tính các app gọi qua SDK; app không cần biết cơ chế bên dưới, chỉ cần "người này là người này".

PhoenixKey cũng là cổng để người dùng vùng-xám tham gia an toàn: họ chỉ cần một danh tính thật và một khoản fiat, phần token phức tạp nằm ở tầng app vùng-sáng (xem §11).

> **Vùng sáng / vùng xám (nói gọn):** *vùng sáng* là nơi đã có khung pháp lý cho tài sản số, token mở ra được; *vùng xám* là nơi luật còn chặn hoặc chưa rõ, nên token không mở trực tiếp cho người dùng. §11 nói kỹ.

---

## 6. Quản trị cá nhân — không token-weighted

MagicLamp **không** dùng "một token một phiếu". Quyền lực không mua được bằng vốn.

Nguyên lý nền:

1. **Quyền tham gia ≠ quyền lực.** Ai có DID đều bỏ phiếu được; trọng số (Voting Power) phải **kiếm**, không mua.
2. **Chi phí thâu tóm = chi phí đóng góp thật.** Không có đường tắt mua quyền lực.
3. **Token đơn thuần bị vô hiệu hóa** — yếu tố "nắm giữ LAMP" có **trần cứng (cap)**, không cho người giàu áp đảo.
4. **Sybil chết từ gốc** — DID sinh trắc khoá cùng lịch sử đóng góp, uy tín, và cam kết LAMP.

Voting Power được tính bằng cách **nhân nhiều tham số bổ trợ lại với nhau**, mỗi tham số có **ngưỡng trần** nên tổng VP **bị chặn trên** — không ai vượt quá một trần hữu hạn. Thêm một lớp **chống một nhóm nhỏ thâu tóm**: với quyết định trọng yếu, mỗi DID bị giới hạn ảnh hưởng tối đa, và quyết định cần **điều kiện kép** — đủ tỉ lệ VP **và** đủ số DID độc lập đồng thuận. Nhờ vậy không một cá nhân hay nhóm nhỏ nào chiếm được đa số.

> Công thức, tham số trọng số, và chứng minh toán nằm trong đặc tả Governance / VotingPower — whitepaper này chỉ nêu nguyên lý.

---

## 7. Cổng Register / DAO đặt chuẩn

Để một hệ sinh thái mở không loạn, cần một **cổng đặt chuẩn**: nơi các app, đối tác, và tài phán đăng ký vào hệ theo một bộ quy tắc chung.

Cổng Register / DAO đảm nhận:

- **Phân vùng tài phán.** Quyết định token nào mở ở vùng nào (xem §11) — vùng sáng mở CARP, vùng xám chỉ chạy lớp closed-loop.
- **Chuẩn tích hợp.** App nào muốn vào hệ phải tuân các bất biến chung (danh tính qua PhoenixKey, MAGIC giữ ba thuộc tính sạch, không tạo đường-ra cho MAGIC).
- **Đặt và đổi tham số nền.** Những thay đổi gốc (ví dụ base_price của đơn vị dịch vụ) chỉ đổi qua quyết định DAO, không do một bên đơn phương.

Cổng này là cách hệ vừa mở cho mọi đội, vừa giữ được tính nhất quán và an toàn pháp lý trên phạm vi toàn cầu.

---

## 8. Cấu trúc phân cấp — Ecosystem · Platform · App

Đây là **mục đích thiết kế cốt lõi** của cả hệ: MagicLamp không phải một sản phẩm đóng do một công ty vận hành, mà là một **hệ sinh thái mở nhiều tầng**, nơi mỗi tầng có vai riêng và **cạnh tranh bình đẳng** với các bên khác cùng tầng. Ba tầng, một mẫu số chung:

```
Ecosystem   MLF (DAO)  ──►  pháp-nhân-con vùng-sáng vận hành Carpet + lớp đỡ-peg   (= NGƯỜI PHÁT HÀNH)
                │
Platform    GreenSun · PhoenixKey · LampNet · OriLife                (= KHÁCH HÀNG — mua CARP vì cần dịch vụ)
                │
App         AladinContract · DDC (TonFarm) · …                       (= sản phẩm chạm người dùng cuối)
                │
Registry-mở did:tiger · did:elephant · DePIN/Datacenter · chat Telegram/Zalo/Messenger
            (ai đăng ký cũng vào — miễn: TIÊU MAGIC + DÙNG CARP + ĐĂNG KÝ)
```

**Tầng Ecosystem — MLF (DAO).** Trên cùng là **MagicLamp Foundation (MLF)**, vận hành theo mô hình **DAO** (quản trị cá-nhân-không-token-weighted, §6). MLF không tự nó bán dịch vụ; nó lập một **pháp-nhân-con ở vùng-sáng** để vận hành lõi CARP (Carpet) và lớp đỡ-peg — **đây là bên phát hành duy nhất** chịu vai phát-hành đồng lưu thông. Mọi tham số nền, chuẩn tích hợp, phân vùng tài phán đều do DAO quyết (qua cổng Register, §7).

**Tầng Platform — khách hàng, không phải người phát hành.** Đây là điểm mấu chốt về bản chất: **GreenSun, PhoenixKey, LampNet, OriLife** không phát hành token — họ là **khách hàng mua CARP vì cần dịch vụ thật** (lưu trữ, định danh, compute, lao động) cho cộng đồng của mình. Chính **cầu mua-để-tiêu** này là lực giữ giá CARP: giá không được đỡ bằng một cơ chế phát-hành tập trung, mà bằng **nhu cầu tiêu dịch vụ có thật, phân tán trên nhiều platform độc lập**. Các platform **cạnh tranh bình đẳng**: không ai được ưu tiên, ai phục vụ người dùng tốt hơn thì tiêu nhiều MAGIC hơn và lớn lên.

**Tầng App — sản phẩm chạm người dùng.** Dưới platform là các app cụ thể: **AladinContract (Aladin)**, **DDC (TonFarm)**, và các app khác — nơi người dùng cuối thực sự dùng dịch vụ. App có thể do platform trong hệ dựng, hoặc do một đội ngoài dựng rồi đăng ký vào (xem §9).

**Hạ tầng dùng chung** (cắt ngang mọi tầng): PhoenixKey DID (định danh sinh trắc), ba token LAMP/MAGIC/CARP (lớp giá trị), cơ-chế-nội-bộ đổi LAMP/CARP/ADA (thanh khoản + quy phí mạng để người dùng cuối không cần cầm ADA; peg CARP/MAGIC giữ bằng **pool-1:1-par nội bộ + utility-floor**, KHÔNG DEX ngoài), và LampNet (lưu trữ phi tập trung mã-hoá-đầu-cuối). Các dịch vụ thật đang chạy — truy xuất nguồn gốc (OriLifeTrace), việc làm nông nghiệp (AladinWork), chat nông dân ↔ chuyên gia (ProofChat), lớp dữ liệu xác thực (VeData) — là nơi **MAGIC được tiêu thành điều có ích thật**.

Mạch chung: **người dùng chạm app → app gọi PhoenixKey định danh → app tiêu MAGIC cho mỗi tác vụ → dữ liệu lưu ở LampNet → giá trị neo về LAMP.** Người dùng cuối không cần biết token nào bên dưới; họ chỉ thấy dịch vụ chạy.

> **MAGIC là mẫu số chung của toàn hệ.** Dù ở tầng nào, dù platform hay app do ai dựng, tất cả đều **quy về một hành động chung: tiêu MAGIC để nhận dịch vụ**. Đây chính là tiên đề "công-dân-hạng-nhất = tiêu MAGIC" — giá trị hệ sinh từ **tiêu-dịch-vụ**, không từ giữ-tài-sản. Cơ chế token và công thức chi tiết ở **Whitepaper Tokenomic**; whitepaper này chỉ nêu cấu trúc và tầm nhìn.

---

## 9. Registry mở — ai cũng vào, cạnh tranh bình đẳng

Tầng dưới cùng của cấu trúc là **Registry mở** — và đây là nơi tinh thần "chiếc đèn thần mở cho mọi người" thành cụ thể. Bất kỳ ai cũng đăng ký vào hệ được, **không cần xin phép một cổng đóng**, miễn thoả **ba điều kiện duy nhất**:

1. **Tiêu MAGIC** — có tiêu dịch vụ thật trong hệ (điều kiện công-dân-hạng-nhất).
2. **Dùng CARP** — dùng đồng lưu thông chung của hệ.
3. **Đăng ký** — khai báo qua cổng Register để tuân các bất biến chung (danh tính, giữ MAGIC sạch, không tạo đường-ra cho MAGIC).

Ai vào được Registry mở? **Bất kỳ ai** — kể cả các bên **cạnh tranh trực tiếp** với thành phần trong hệ:

- **Danh tính khác cạnh PhoenixKey.** `did:tiger`, `did:elephant` — một hệ danh tính do đội khác dựng trên blockchain khác — vẫn vào được, **cạnh tranh sòng phẳng với PhoenixKey**. Hệ không khoá người dùng vào một nhà cung cấp danh tính duy nhất.
- **Hạ tầng lưu trữ / tính toán khác.** Nhà cung cấp **DePIN** hoặc **datacenter** độc lập tự chào bán năng lực lưu trữ/compute vào hệ, cạnh tranh với LampNet.
- **Kênh giao tiếp khác.** Chat qua **Telegram, Zalo, Messenger** — không bắt buộc dùng đúng một kênh của hệ.

Nguyên tắc xuyên suốt: **cạnh tranh bình đẳng ở mỗi tầng.** Không thành phần nào — kể cả thành phần "gốc" như PhoenixKey hay LampNet — được đặc quyền độc quyền. Ai phục vụ tốt hơn, rẻ hơn, được người dùng chọn nhiều hơn thì lớn lên. Mẫu số chung giữ mọi bên trong cùng một hệ vẫn là **MAGIC + CARP**: dù bạn dùng danh tính nào, hạ tầng nào, kênh chat nào, bạn vẫn tiêu MAGIC và dùng CARP.

**DAO cũng mở tương ứng.** Quyền ứng cử vào DAO của MLF **không giới hạn ở người dùng PhoenixKey**. Mọi DID có **vault đo được** (có lịch sử tiêu MAGIC thật, đo được on-chain) đều đủ tư cách ứng cử — không bắt buộc phải là `did:phoenix`. Quản trị mở cho mọi người đóng góp thật, bất kể họ vào hệ qua cửa nào.

> **Vì sao điều này vừa là tầm nhìn, vừa là bằng chứng phi tập trung.** Một hệ mà **ai cũng vào được và cạnh tranh bình đẳng ở mỗi tầng** thì không thể bị mô tả là "một thực thể điều khiển tất cả". Đỡ-peg đến từ **cầu của nhiều khách-hàng phân tán** (các platform mua CARP vì cần dịch vụ), không từ một cơ chế phát-hành tập trung. Đây vừa là mục tiêu thiết kế, vừa là **bằng chứng phi-tập-trung** làm **nhẹ** rủi ro pháp lý (ART / Howey) — không phải thoát hẳn, nhưng khác rõ với một hệ đóng do một bên nắm mọi đầu mối. Xem §11 và phân tích pháp lý chi tiết ở đặc tả.

---

## 10. MagicLamp là SDK mở cho mọi Cardano team

Mục tiêu cuối cùng của toàn bộ kiến trúc: **biến MagicLamp thành một SDK mở** — bộ công cụ để bất kỳ đội ngũ Cardano nào cũng dựng được ứng dụng có token, có danh tính, có quản trị, mà không xây lại từ đầu. SDK ở đây là **cả hệ** — PhoenixKey DID, mô hình quản trị, các module SuperApp, và ba token — chứ không riêng token LAMP.

Cụ thể, một đội ngoài có thể:

- **Cọ đèn** — dùng LAMP làm nền để sinh MAGIC cho cộng đồng app của họ.
- **Mượn danh tính** — gọi PhoenixKey DID qua SDK thay vì tự xây hệ định danh chống Sybil.
- **Dùng quản trị có sẵn** — áp mô hình Voting Power cá-nhân-không-token-weighted cho DAO của mình.
- **Lắp ghép module** — qua SuperApp, ráp các khối dịch vụ (truy xuất, chat, việc làm) thành app riêng.

Triết lý LAMP củng cố điều này: LAMP phân bổ **qua đóng góp, không bán** (không ICO/IDO), tổng cung cố định tuyệt đối 36 tỷ. Đây là cách phân phối một tài sản nền theo công sức thực, không phải lời mời đầu tư sinh lời; LAMP **không** hứa lợi tức thụ động. Một nền mở, gắn với người đóng góp, là nền đáng để các đội khác xây lên.

---

## 11. Phân vùng tài phán — sáng và xám

MagicLamp **phán theo bản chất, không theo nhãn**: mỗi token bị xử theo thuộc tính thật của nó, dù chung thương hiệu. Vì "tuân thủ tuyệt đối, không vùng xám" là bất khả với mọi token chuyển nhượng (đúng cả với stablecoin lớn), chiến lược thực tế là **phân vùng** + **cô lập rủi ro vào CARP**.

| Vùng | LAMP | MAGIC | CARP |
|---|---|---|---|
| **Sáng** (Mỹ, EU, Úc, Ấn Độ…) | mở | mở | mở (đăng ký nơi cần) |
| **Xám** (nơi chặn token) | chặn nắm giữ | **mở** (qua app vùng sáng, closed-loop) | chặn |

Ý tưởng then chốt — **bộ đệm vùng-xám**: ở nơi chặn token, người dùng **chỉ chạm fiat + dịch vụ**. Họ trả tiền mua một gói dịch vụ từ một app có trụ sở vùng-sáng (hợp pháp, có license); app khoá token bên dưới và cấp cho người dùng quyền-tiêu MAGIC gắn DID của họ. Người dùng nhận đúng lượng dịch vụ đã mua, không bao giờ nắm token đầu cơ. Như mua một phần mềm SaaS nước ngoài — sạch và an toàn.

Nhờ thiết kế này, MAGIC dùng được ở **cả vùng sáng lẫn vùng xám**, còn CARP — đồng lưu thông tự do — chỉ mở ở vùng sáng nơi có khung pháp lý phù hợp; ở vùng xám CARP bị **chặn theo vùng địa lý**.

> **Nhắc về rủi ro:** trong ba token, **CARP** là đồng **chuyển nhượng tự do** nên là đồng duy nhất **có rủi ro thị trường** — giá có thể lên xuống, có yếu tố đầu cơ. **LAMP** cũng chuyển nhượng và biến động theo cung-cầu. Cả hai **không cam kết lợi nhuận** và **không trả lợi tức thụ động**. Riêng **MAGIC** thì khác hẳn: nó không bán lại được, chỉ để tiêu dịch vụ — không phải tài sản đầu tư. Đừng coi ba token an toàn như nhau.

> Chi tiết phân loại pháp lý từng token, từng thị trường, và điều kiện chặn theo vùng địa lý nằm ở đặc tả 3-token và phân tích pháp lý — whitepaper này chỉ nêu nguyên tắc.

---

## 12. Lộ trình

Lộ trình bám theo nguyên tắc "chạy thật rồi mới tuyên bố xong":

1. **Nền giá trị (đang chạy).** Lớp phân phối LAMP và lớp tiêu MAGIC đã chạy thử nghiệm trên mạng thử Cardano (Preview) — chưa lên mạng chính.
2. **Danh tính thật.** Hoàn thiện liên kết quyền-tiêu MAGIC với PhoenixKey DID để "chỉ chủ-DID tiêu" thành thật.
3. **Demo dịch vụ vùng-xám.** Trình diễn kịch bản người dùng vùng-xám mua gói dịch vụ bằng fiat, tiêu MAGIC qua app vùng-sáng.
4. **Lõi thanh khoản CARP.** Xây cơ chế đúc và ổn định CARP cùng sàn-dưới đổi CARP sang dịch vụ.
5. **Hạ tầng phí + thanh khoản.** Hoàn thiện cơ-chế-đổi-nội-bộ (LAMP/CARP/ADA) và lớp trả-phí-thay-người-dùng để người dùng không cần cầm ADA.
6. **Mở SDK + quản trị.** Đưa quản trị (Voting Power) lên mạng thử, mở cổng Register/DAO, công bố SDK cho các đội Cardano ngoài.

> Cách làm và các mốc kỹ thuật/kinh tế chi tiết của mỗi bước (tham số kinh tế, ngưỡng ổn định, cơ chế đúc/chuộc CARP) thuộc Whitepaper Tokenomic và đặc tả từng dự án — whitepaper này chỉ nêu thứ tự ưu tiên ở mức cao.

---

## 13. Lời kết

MagicLamp không cố làm một đồng token "thần kỳ" gánh mọi vai. Nó làm điều ngược lại: **trung thực với bản chất.** Tài sản nền là tài sản nền (LAMP). Điều ước là điều ước — tiêu rồi tan biến, sạch (MAGIC). Tấm thảm là tấm thảm — chở giá trị, lưu thông (CARP). Con người là con người — một danh tính thật, một tiếng nói (PhoenixKey DID).

Khi mỗi thứ làm đúng vai, hệ vừa tuân thủ rõ ràng, vừa lưu thông linh hoạt, vừa quản trị công bằng. Và khi đóng gói tất cả thành một SDK mở, chiếc đèn thần này không còn của riêng ai — nó thành nền cho **mọi đội Cardano** thắp lên dịch vụ có ích cho cộng đồng của họ.

Đó là MagicLamp: một chiếc đèn, mở cho mọi người.

---

> **Tài liệu liên quan:** đặc tả kiến trúc 3 token (`MagicLamp-3Token-DacTa-Vi.md`) · Whitepaper Tokenomic (tokenomics chi tiết) · đặc tả Governance / VotingPower · đặc tả từng dự án (PhoenixKey, OriLifeTrace, AladinWork, LampNetCloud, SuperApp, VeData).
