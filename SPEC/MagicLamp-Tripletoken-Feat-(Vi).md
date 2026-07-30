# MagicLamp — Đặc tả Kỹ thuật Bộ-Ba-Token (LAMP · MAGIC · CARP)

> **Tài liệu:** `MagicLamp-Tripletoken-Feat-(Vi).md` — đặc tả kỹ thuật cho **chuyên gia và lập trình viên**.
> **Đối tượng:** người triển khai on-chain/off-chain, kiểm toán, tích hợp. Phần diễn giải phổ thông (câu chuyện, pháp lý cho người dùng) nằm ở bản công bố `Launch/Whitepaper-MagicLamp-Tokenomic-(Vi).md` — tài liệu này **tham chiếu tới** bản đó, không lặp lại.
> **Phạm vi:** hợp nhất đặc tả **GenMAGIC** (§6) và **ConsumeMAGIC** (§7) vào một nơi. Cơ chế ổn định CARP chi tiết ở `Carpet-CARP-DacTa-Vi.md` (tài liệu này chỉ nêu giao diện).
> **Trạng thái:** canonical, chốt mô hình 2026-07-23. Khi mâu thuẫn với bản cũ (`MagicLamp-3Token-DacTa-Vi.md`, các file GenMAGIC/ConsumeMAGIC rời) → **theo file này**.

---

## §0. Tóm tắt — ba token, ba vai không thể gộp

Hệ MagicLamp có **ba token** với ba vai loại trừ nhau:

- **LAMP** — tài sản nền. Cố định **36 tỷ, không mint thêm, không burn** (giảm lưu hành = chuyển Treasury kế toán). Nguồn sinh MAGIC; tài sản tham gia governance (không token-weighted); nguồn backing hợp đồng tín dụng MAGIC.
- **MAGIC** — quyền-tiêu-dịch-vụ. **Không phải token** (không policy-id, không mint): là **số kế toán trong vault datum**, gắn PersonDID, **không chuyển nhượng**. Sinh mỗi epoch, **dùng-hết-trong-epoch-hoặc-mất** (§4). Chỉ chuộc-ra-dịch-vụ, không ra tiền.
- **CARP** — đồng-thanh-khoản ổn định. Native token có policy-id riêng, chuyển nhượng, giữ giá bằng **sàn-tiện-ích** (luôn đổi được sang MAGIC để tiêu). Cổng-vào bằng fiat cho người chưa có LAMP.

Quy luật: **LAMP sinh MAGIC; CARP chở giá trị tới nơi tiêu; MAGIC tiêu xong hoặc tan biến.** Chi tiết ẩn dụ + lý do "ba chứ không một": whitepaper §1–§5.

---

## §1. Định vị từng token

### §1.1 LAMP — tài sản nền
- Native token, policy-id riêng (đã có). Cung **36 tỷ cố định, KHÔNG burn**.
- Vai: (a) nguồn sinh MAGIC (nắm LAMP → InstantGen/ScheduleGen); (b) tài sản governance qua PhoenixKey DID (**KHÔNG nhân số lượng** — chống plutocracy); (c) nguồn backing hợp đồng tín dụng MAGIC (§9).
- Chuyển nhượng được; biến động giá theo thị trường. Nắm giữ là **chủ động** — không sinh lợi-tức-thụ-động theo số dư (firewall F3).

### §1.2 MAGIC — quyền-tiêu-dịch-vụ (lớp tuân-thủ-sạch)
- **Bản chất:** đơn-vị-tiêu-dịch-vụ trả trước, neo **sức-mua-dịch-vụ nội sinh** (`P* = 1`, `base_price` đổi chỉ qua DAO). **KHÔNG neo fiat.**
- **Bốn thuộc tính bất biến (làm nó sạch):**
  1. **Không chuyển nhượng** — chỉ chủ PersonDID tiêu được.
  2. **Per-epoch, dùng-hoặc-mất** — sinh ở epoch nào phải tiêu ở epoch đó; snapshot epoch sau **reset về 0** (§4). Không tích trữ, không cộng dồn.
  3. **Không chuộc ra tiền** — chỉ chuộc-ra-DỊCH-VỤ. Không đổi ngược thành LAMP/CARP/fiat.
  4. **Không là token** — là số kế toán trong vault datum; **Gen ≠ Mint**. Cấm viết "mint MAGIC".
- **Đơn vị:** `nanogic = MAGIC × 10⁹` (BigInt, không dùng `Number`).
- **Sinh từ 3 cửa** (§6): InstantGen · ScheduleGen · PrepaidGen.
- **Backing:** năng-lực-cung-dịch-vụ của hệ (mô hình gift-card), KHÔNG rổ tài chính. Vì không hứa chuộc-ra-tiền → thoát khung stablecoin + thoát bài toán Terra.
- **Pháp lý:** consumptive-use thuần (Howey prong-3 gãy), không e-money, không payment-instrument. Chi tiết: whitepaper §10.

### §1.3 CARP — đồng-thanh-khoản ổn định (lớp lưu-hành)
- Native token, **policy-id riêng**, chuyển nhượng trong hệ. Neo sức-mua-dịch-vụ nội sinh, **KHÔNG neo fiat**.
- Giữ giá bằng **sàn-tiện-ích** (CARP luôn đổi được sang MAGIC để tiêu; PrepaidGen 1:1 + PSM-par nội bộ) + **3-back** (GreenBack/VacuumBack/RedBack) + Backstop. Chi tiết + tham số: `Carpet-CARP-DacTa-Vi.md §3–§4`.
- Pháp lý: utility fiat-neutral (thoát EMT; khả năng bị phán ART còn — ESMA xét substance). Chi tiết: whitepaper §10, `Carpet-CARP-DacTa-Vi.md §8`.

---

## §2. Quan hệ ba token + firewall

```
        (Gen: InstantGen / ScheduleGen — LAMP đứng yên, đối ứng GreenBack)
   LAMP ───────────────────────────────────►  MAGIC  ──► TIÊU 1 dịch vụ cụ thể
    │  (nền)                          (quyền-tiêu, per-epoch)      │
    │                                            ▲                └─► hết epoch → RESET (tan biến)
    │  PSM-par 1:1 nội bộ                         │  PrepaidGen: khoá CARP → quyền-tiêu
    └──────────────► CARP ──────────────────────┘
                    (thanh-khoản, mua bằng fiat)

   MAGIC ──► KHÔNG có đường ra: không → CARP, không → LAMP, không → tiền
```

**Ba dòng vào MAGIC + một dòng ra:**
1. **LAMP → MAGIC** — InstantGen (tiêu ngay) / ScheduleGen (dòng đều dài hạn). LAMP **đứng yên** (chỉ đọc số dư qua reference input, không spend/đốt). Đối ứng GreenBack, chỉ Gen trong thặng-dư backing.
2. **CARP → MAGIC** — PrepaidGen: khoá CARP → quyền-tiêu, một-chiều, cam-kết-tiêu, tự-back (firewall F2).
3. **CARP ⇄ MAGIC PSM-par nội bộ** — giữ peg CARP/MAGIC (arbitrage-qua-tiêu-dùng), KHÔNG DEX ngoài.
4. **MAGIC → dịch vụ** — tiêu hoặc tan biến. **Không đường nào khác.**

**Firewall sống còn (vi phạm = sập kiến trúc):**

| Mã | Nội dung |
|---|---|
| **F1-MAGIC-ONE-WAY** | Không có dòng MAGIC → CARP/LAMP/tiền. |
| **F2-CARP-FRICTION** | CARP → MAGIC là cam-kết-tiêu gắn-DID, một chiều, không hoàn. |
| **F3-NO-PASSIVE-YIELD** | Không token nào trả giá-trị theo số-dư; nắm LAMP/đặt Schedule là chủ động. |
| **F4-MAGIC-CLOSED** | MAGIC non-transferable + per-epoch-reset + không-chuộc-tiền + tiêu-trong-hệ. |
| **F5-CARP-FIAT-NEUTRAL** | CARP neo-dịch-vụ không neo-fiat; 3-back đa-dạng-trung-lập, CẤM thuần-LAMP vào core. |
| **F6-NO-EXTERNAL-INPUT** | Cổng/ngưỡng solvency chỉ căn số-dư-nội-bộ; oracle giá LAMP CHỈ định-giá `B`, KHÔNG điều khiển cổng. |
| **INV-MAGIC-CITIZEN** | Mọi thưởng/ưu-đãi/quyền-lực keyed vào **MAGIC-đã-TIÊU-THỤ thật** (consumed, không gồm decayed). Công-dân-hạng-nhất = người tiêu thật. |

---

## §3. LAMP — đặc tả

| Hạng mục | Nội dung |
|---|---|
| Loại | Native token, policy-id riêng (đã có) |
| Cung | 36 tỷ cố định, không mint thêm, **không burn** |
| Vai backing | nắm-giữ đối ứng InstantGen/ScheduleGen (đối ứng GreenBack); nguồn khoá hợp đồng (§9) |
| Governance | đọc LAMP-nắm cho tư-cách, **KHÔNG nhân số lượng**; VP do PhoenixKey DID |
| Biến động | có; rủi-ro-giá do hệ gánh (GreenBack carry), không đẩy sang người-tiêu-MAGIC |
| Pháp lý | tài-sản-nền; **không yield thụ động** (F3) |

**LAMP đứng yên khi sinh MAGIC.** Engine gen **chỉ ĐỌC** số dư LAMP qua `reference_input` (CIP-31), KHÔNG spend, KHÔNG đốt (bất biến **I-ACT-7**). Đây là điểm phân biệt then chốt với mọi mô hình "thế chấp/đốt để mint".

---

## §4. MAGIC — đặc tả account per-epoch

### §4.1 Mô hình lưu trữ
MAGIC là **số kế toán trong `VaultDatum.magic_batches`** — danh sách `MagicBatch`, mỗi phần tử gắn một `created_epoch` và một `current_amount` (nanogic). MAGIC **không có policy-id, không mint token** (Gen ≠ Mint).

```
MagicBatch {
  batch_id          : ByteArray,   // định danh batch (chống trùng)
  source            : Int,         // 1=Instant 2=Schedule 3=Prepaid (cửa sinh)
  created_epoch     : Int,         // epoch sinh — quyết định sống/chết
  current_amount    : Int,         // nanogic còn lại (chỉ BurnBatch giảm)
  decay_window      : Int,         // = 1 (cliff, per-epoch) — xem §4.2
  profile_at_creation : Int,       // tham số tư-cách đóng băng lúc sinh (bất biến T4)
  contract_id       : ByteArray,   // hợp đồng ScheduleGen (nếu có), else #""
}
```

### §4.2 Per-epoch use-or-lose — bất biến trung tâm
**`decay_window = 1` (cliff).** Một `MagicBatch` **chỉ LIVE trong đúng `created_epoch` của nó**. Sang `created_epoch + 1`, batch **chết** — `current_amount` được coi như 0, không tiêu được, không cộng dồn.

- **Snapshot mỗi epoch reset MAGIC chưa tiêu về 0** ("dùng-hoặc-mất"). Đây là hệ quả trực tiếp của `reward = TRẦN-SUẤT mỗi epoch` (whitepaper §7.2) — MAGIC là **trần-suất tiêu mỗi epoch**, KHÔNG phải bể-quyền-cộng-dồn.
- **Không carry-over, không hoard.** Ai cần tiêu dài hạn → dùng **ScheduleGen** (sinh batch mới `pp` MAGIC **mỗi epoch** trong N epoch — không phải một kho tiêu dần).
- **Hệ quả đơn giản hoá:** không cần cơ chế decay-nhiều-epoch, không cần halving-trong-gen, không cần GC-carry phức tạp. Batch chết = bị bỏ qua khi đọc + dọn rác cơ hội (§7.4 PruneExpired, permissionless, chỉ dọn byte không đổi giá trị).

### §4.3 Bảng đặc tả

| Hạng mục | Nội dung |
|---|---|
| Loại | Số kế toán trong vault datum, **KHÔNG token, KHÔNG transferable** |
| Đơn vị neo | sức-mua-dịch-vụ nội sinh, `P*=1`, `base_price` on-chain, đổi qua DAO. KHÔNG fiat |
| Sinh (Gen) | 3 cửa (§6): InstantGen / ScheduleGen / PrepaidGen |
| Vòng đời | LIVE 1 epoch (created_epoch), snapshot sau **reset 0** |
| Tiêu | giảm `current_amount` qua BurnBatch (§7); tối đa `pp`/epoch với batch ScheduleGen |
| Chuyển nhượng | KHÔNG (chỉ chủ-DID) |
| Chuộc | chỉ ra **dịch vụ**; KHÔNG ra tiền/CARP/LAMP (F1) |
| Backing | năng-lực-dịch-vụ (gift-card); KHÔNG rổ tài chính |

---

## §5. CARP — giao diện (chi tiết ở Carpet-CARP-DacTa-Vi.md)

Tài liệu này chỉ nêu **điểm nối** CARP ↔ MAGIC. Đặc tả đầy đủ cơ chế ổn định (sàn-tiện-ích, 3-back, Backstop, CDP-phụ, tham số) ở `Carpet-CARP-DacTa-Vi.md`.

- **PrepaidGen (§6.4)** = cửa CARP → quyền-tiêu MAGIC, đồng thời là **sàn-tiện-ích của CARP**.
- **PSM-par nội bộ** giữ peg CARP/MAGIC (`P_redeem ≡ 1`), KHÔNG DEX ngoài.
- **VacuumBack** (§8) = back thứ-3 của CARP, **KHÔNG phải cửa gen MAGIC**.

---

## §6. GenMAGIC — ba cửa sinh quyền-tiêu

### §6.1 Nguyên tắc chung
Ba cửa: **InstantGen · ScheduleGen · PrepaidGen**. Chia chung:
- **LAMP/CARP đứng yên** khi sinh MAGIC (I-ACT-7 cho LAMP; CARP khoá-cam-kết cho Prepaid).
- **Gen từ LAMP chỉ trong thặng-dư backing** — không bơm cung khi hệ yếu.
- **MAGIC sinh ra là per-epoch** (§4.2) — mọi cửa đều nạp vào batch của epoch hiện tại.
- **Thưởng keyed-consumed** (INV-MAGIC-CITIZEN): độ lớn thưởng tính theo MAGIC **đã tiêu thụ thật**, không theo LAMP-giữ hay MAGIC-đang-cầm.

**Wakeme lent-LAMP KHÔNG phải cửa riêng.** Khoản ≤ 1001 LAMP hệ cho người mới mượn (đặt trong vault closed-loop, LAMP đứng yên, user không bao giờ sở hữu) là **nguồn-LAMP** để chạy InstantGen/ScheduleGen — cùng hai phương thức áp cho LAMP người dùng tự mua. Không có "cửa GenDrip" ngang hàng. Cơ chế tấm-pin (LAMP luân chuyển pot→vault→pot) thuộc `PhoenixKey-Wakeme-{Math,Tech}.md`.

> **MAGIC là FUNGIBLE — nguyên tắc gốc (anh chốt 2026-07-30).** Một khi MAGIC đã sinh, hệ **KHÔNG BAO GIỜ phân biệt nó theo nguồn** (Instant/Schedule/Prepaid/LAMP-mượn hay LAMP-sở-hữu). MAGIC hành xử như đơn-vị fungible: mọi MAGIC-đã-tiêu đếm như nhau vào §6.2-thành-phần-2, §6.3 reward(consumed), §10 C1. Hệ quả thiết kế: **mọi rào chống-lạm-dụng phải đặt Ở TẦNG SINH (generation), không gắn nhãn MAGIC hay lọc theo nguồn ở tầng tiêu/kế-toán.** (Trường `source` trên batch — nếu có — chỉ dùng cho decay-param lúc tạo, KHÔNG được ảnh hưởng giá-trị-tiêu hay C1.)
>
> **Faucet-guard cho LAMP-mượn — chặn TẠI NGUỒN (anh chốt 2026-07-30).** Vì `pp_schedule` tuyến-tính theo LAMP-khả-dụng (§6.3), 1001 LAMP-mượn miễn-phí-vốn nếu tính đủ suất sẽ cấp ~1001 MAGIC/epoch mỗi người — biến faucet thành máy in MAGIC. Chốt: **LAMP-mượn chỉ cấp trần cứng nhỏ `LENT_PP_CAP`** (hằng-hệ, ≪ 1001·ρ) cho phần năng-lực đến từ LAMP-mượn; LAMP người dùng **tự mua & nắm** mới hưởng suất tuyến-tính đầy đủ. (`L_avail` chia hai phần: `L_owned` suất đầy đủ + `L_lent` trần `LENT_PP_CAP`.) Vì chặn ngay ở SINH, lượng MAGIC từ LAMP-mượn đã nhỏ sẵn → không cần (và không được) lọc nó khỏi C1 ở tầng governance: nhất quán với fungibility. Rủi ro thổi C1 bằng đèn-mượn bị giới hạn bởi chính `LENT_PP_CAP`.

### §6.2 Tư-cách — nhân vào TỶ LỆ sinh (1 tham số, 4 thành phần)
Tư-cách là **một hệ số duy nhất** nhân vào tỷ lệ Gen, gộp 4 thành phần (đóng băng vào `profile_at_creation` lúc sinh batch — bất biến T4):

1. **tuổi-LAMP** — xét trên **6 epoch**: cùng lượng LAMP, ở vault lâu hơn (trong cửa sổ 6 epoch) → sinh nhiều hơn. Xét từng epoch để user đo lường được.
2. **MAGIC-đã-tiêu** — cùng LAMP + cùng tuổi: hồ sơ tiêu nhiều MAGIC hơn trong 6 epoch qua → sinh nhiều hơn.
3. **giờ-thấp-điểm** — cùng lượng tiêu: tỷ lệ tiêu lúc thấp-điểm cao hơn → sinh nhiều hơn (điều tiết cung-cầu).
4. **cam-kết-lịch** — MAGIC cam kết trong hợp đồng ScheduleGen nhiều hơn → sinh nhiều hơn.

> Tư-cách **mở cổng và định tỷ-lệ**; **độ lớn** InstantGen còn nhân thêm biến MAGIC-đã-tiêu-thụ ở §6.3. Hai thứ ghép: tư-cách là hệ-số-nhân, consumed là cơ-sở-tính.

### §6.3 InstantGen — nắm LAMP, tiêu ngay, độ lớn theo MAGIC-đã-tiêu-thụ
**Bản chất:** thưởng-tham-gia điều-kiện-hoá-bởi-tiêu-MAGIC-thật, KHÔNG phải lợi-tức-thụ-động. Nắm LAMP chỉ **mở tư-cách**; **độ lớn ∝ MAGIC người đó ĐÃ TIÊU THỤ thật** (consumed, đo qua account có định danh).

- MAGIC tiêu từ **MỌI nguồn đều tính**, gồm cả từ PrepaidGen. MAGIC bị reset (chưa tiêu) **KHÔNG tính**.
- *Ví dụ:* người có 1000 MAGIC đã tiêu 900 → InstantGen **nhiều hơn** người có 2000 MAGIC chỉ tiêu 500.

**Cổng thặng dư + trần cộng-dồn theo năng-lực-ScheduleGen (anh chốt 2026-07-30):**

Trần InstantGen là phần **CÒN LẠI** của ngân-sách-gen-chung của DID trong epoch, sau khi trừ phần đã sinh:
```
cấp thực = min( reward(consumed), cap_surplus(br), pp_schedule − gen_this_epoch )
cap_surplus = f · S · (br − br_safe) / br_safe   khi xanh (f ≤ 0.10)
cap_surplus = 0                                   khi đỏ
```
- **`pp_schedule` = năng-lực-ScheduleGen-theo-hồ-sơ của DID** (notional — MAGIC/epoch mà hồ sơ DID *có thể* đặt ScheduleGen sinh), tính **TUYẾN TÍNH theo LAMP khả-dụng tức-thời**:
  ```
  pp_schedule[nanogic/ep] = ⌊ L_avail_oildrop × RATE_REF_Q / Q ⌋
  RATE_REF_Q = 10¹²   Q = 10⁹   L_avail = lamp_balance − lamp_locked   (ρ = 1 MAGIC/LAMP/epoch)
  ```
  Thêm LAMP làm trần tăng **NGAY** trong epoch (đẩy nhu cầu nắm LAMP — mục tiêu kinh tế). Muốn gen nhiều hơn → phải MUA & NẮM thêm LAMP.
  - **`INV-INSTANT-LOCK` — khoá LAMP-nền intra-epoch, chống flash-rent (anh chốt 2026-07-30).** Khi InstantGen sinh dùng `L_used` LAMP-khả-dụng, **`L_used` bị KHOÁ tới hết epoch hiện tại** (`lamp_locked += L_used`), giải-phóng khi sang epoch mới — giống ScheduleGen nhưng áp trong CHÍNH epoch này. Hệ quả: (a) không thể **thuê LAMP 1 tx rồi trả ngay** để đội trần — muốn hưởng suất phải để LAMP nằm khoá trọn epoch; (b) `L_avail = lamp_balance − lamp_locked` **tự co lại** sau mỗi lần gen trong epoch → trần tự siết, LAMP-khoá vật lý trở thành thước đo ngân sách. LAMP-khoá cho InstantGen KHÔNG chuyển đi đâu (I-ACT-7 giữ nguyên: `lamp_balance` bất biến, chỉ `lamp_locked` đổi). MAGIC sinh ra là **use-or-lose trong epoch** (§4.2): tiêu ngay trong epoch, phần dư **huỷ hết** khi snapshot sang epoch.
- **`gen_this_epoch` = ngân-sách-gen-chung ĐÃ DÙNG** — đếm **TỔNG** MAGIC DID sinh trong epoch hiện tại từ **CẢ InstantGen LẪN ScheduleGen-fire** (một ngân sách, hai cửa cùng rút). Đây là bộ đếm SINH **cộng-dồn on-chain** (trường datum), reset khi sang epoch mới. **KHÔNG suy từ số dư MAGIC** — nếu suy từ số dư thì đốt MAGIC sẽ "trả chỗ" → gen lại vô hạn (**`INV-GEN-BUDGET`**).
- *Ví dụ (anh chốt):* hồ sơ cho phép ScheduleGen 1000 MAGIC/epoch; đã gen 800 (Instant + Schedule) → InstantGen còn tối đa 200. Nạp thêm LAMP nâng `pp_schedule` → trần nới ngay.
- `br = B/S`: `B` = backing thật (oracle LAMP CHỈ định-giá B — F6), `S` = cung MAGIC hiệu lực (đã Gen chưa tiêu chưa reset). `br_safe = 1.5`.
- **Xanh** (`br > br_safe`): được Gen. **Đỏ** (`br ≤ br_safe`): `cap = 0` (khoá Gen). Sau Gen: `br' ≥ br_safe`.

> **Vì sao bỏ hệ-số `0.5×` cũ:** bản trước chặn `InstantGen ≤ 0.5 × pp_schedule` để (a) giữ Instant < Schedule cho kênh tích-backing sống, (b) chặn cá voi hút cạn `cap_surplus`. Vai (a) nay do **ngân-sách-gen-chung** đảm nhiệm (Instant + Schedule cùng rút một `pp_schedule`, không double-dip 2×pp); vai (b) do chính `cap_surplus` giữ. Dùng **full `pp_schedule`** làm trần khớp đúng 3 ví dụ anh (1000/500/+200).

**Hai phanh bổ sung:**
- `cap = 0` khi CARP/MAGIC đang rớt-dưới-mức-neo (depeg).
- **`INV-CASHBACK-BOUND`**: hoàn-tiền/thưởng mỗi DID ≤ MAGIC thật đã tiêu thụ của DID đó.

**Use-or-lose:** `reward` là **trần-suất mỗi epoch** — nạp vào batch epoch hiện tại, không cộng dồn (§4.2). Ngân-sách `gen_this_epoch` reset theo epoch: sang epoch mới, cả Instant lẫn Schedule-fire lại có đủ `pp_schedule`.

### §6.4 ScheduleGen — dòng đều dài hạn, GreenBack đỡ
**Mục đích:** cần **dòng MAGIC đều đặn nhiều epoch** (ví dụ trả công đội kỹ thuật vài tháng). Nắm/khoá LAMP, hệ bảo đảm `pp` MAGIC **mỗi epoch** trong `N` epoch. LAMP đứng yên, trả nguyên vẹn khi hết hợp đồng.

**Bốn bước:** (1) Ký hợp đồng `pp` MAGIC/epoch × `N` epoch qua cổng-giới-hạn; (2) Tạo MAGIC vào GreenBack (chưa lưu thông); (3) GreenBack mua LAMP khi rẻ → góp backing + đỡ giá lúc sập (giữ đủ `buffer_ep = 2` epoch); (4) **Mỗi epoch sinh batch mới ≤ `pp`** (trần cứng per-epoch), tiêu trong epoch đó — vẫn use-or-lose, KHÔNG hoard.

> **Schedule-fire rút từ NGÂN-SÁCH-GEN-CHUNG (anh chốt 2026-07-30).** Mỗi lần fire nạp MAGIC cũng **cộng vào `gen_this_epoch`** của DID (§6.3) — Instant và Schedule cùng rút một `pp_schedule`, không double-dip. Hệ quả: nếu DID đã dùng hết ngân sách qua InstantGen thì Schedule-fire epoch đó bằng 0 (và ngược lại). Reset theo epoch.

**Cổng-giới-hạn (vì sao Schedule phải nhỏ):**
```
Tổng nghĩa-vụ-còn-lại ≤ κ × Sức-tải-các-quỹ-cứu       (κ = 0.6, cấm đổi giữa vòng đời hợp đồng)
```
Sức-tải = số dư quỹ cứu nội bộ (RedBack + kho dự phòng + Kho bạc). **KHÔNG dùng giá LAMP** (F6).

**Hệ-số-năng-lực theo từng dịch vụ (anh chốt 2026-07-18).** ScheduleGen KHÔNG áp một hệ số chung. Mỗi dịch vụ có khả-năng-mở-rộng-cung khác nhau → trần neo vào năng-lực-cung thực của chính nó:
- Cung-hữu-hạn-theo-vùng (ship trong huyện) → hệ số thường ~60%.
- Cung-co-giãn-lớn (lưu-trữ LampNet, mở rộng chỉ là chỉnh tỷ-lệ-thưởng hút thiết bị người dùng) → gần như không giới hạn.
- **Nguyên tắc:** không phát dòng MAGIC vượt năng-lực-tiêu-dịch-vụ-thực (nếu không MAGIC không có dịch vụ để tiêu → phá sàn-tiện-ích). Thuật toán cụ thể per-dịch-vụ nằm ở spec dịch-vụ riêng, ngoài phạm vi tài liệu này.

> **Quan hệ với `pp_schedule` on-chain (§6.3).** Trần **on-chain** dùng `pp_schedule` notional TUYẾN TÍNH theo LAMP-khả-dụng (`⌊ L_avail × RATE_REF_Q / Q ⌋`) — đây là **trần trên** đủ tất-định để validator kiểm không cần oracle. Hệ-số-năng-lực per-dịch-vụ là lớp **SIẾT THÊM** (off-chain / spec dịch-vụ), chỉ **thu hẹp** dòng thực dưới trần on-chain, **không bao giờ nới rộng** vượt nó. Nhờ vậy khoảng-trống-spec "công thức năng-lực per-dịch-vụ" (từng chặn cài đặt) không còn chặn: on-chain đã có công thức tất-định; per-dịch-vụ tinh-chỉnh bên trên.

**Bậc thang cứu (GreenBack thiếu) — 5 bậc:** (1) điều chỉnh tỷ giá hợp đồng; (2) bán LAMP thặng dư GreenBack; (3) RedBack; (4) kho dự phòng; (5) Kho bạc.

### §6.5 PrepaidGen — nguồn CARP, tự-back
- App/user **khoá CARP** → quỹ Paid platform; mỗi lần user tiêu, một phần CARP → quyền-tiêu MAGIC gắn DID.
- **Tự-back, một-chiều, cam-kết-tiêu** (F2): không hoàn, KHÔNG đổi 1:1 tự do qua lại.
- **Không cần cổng-thặng-dư/br** (tự-back bằng chính CARP đã khoá, không moi backing chung).
- MAGIC tiêu ra từ PrepaidGen **CŨNG tính** vào cơ-sở-consumed cho InstantGen (§6.3).
- Đồng thời là **sàn-tiện-ích của CARP** (§5).

---

## §7. ConsumeMAGIC — tiêu dạng kế toán (interface KHOÁ v2)

> Nguồn chân lý interface: `ConsumeMAGIC/CONTRACT.md` v2 (2026-06-10, KHOÁ). Mọi code/spec bám file đó. Tài liệu này tổng hợp để đọc liền mạch.

### §7.1 Nguyên tắc nền
MAGIC = số kế toán trong vault datum, **KHÔNG token, KHÔNG `tx.mint`**. Tiêu MAGIC = **GIẢM `current_amount`** của `MagicBatch` qua handler `BurnBatch` của VAULT validator — vault là nơi **DUY NHẤT** giảm MAGIC. ConsumeMAGIC là lớp **PRICING + ENGAGEMENT/ATTRIBUTION** per-app, KHÔNG chạm MAGIC trực tiếp. LAMP + ADA bảo toàn byte-perfect.

### §7.2 Định giá — beacon `PriceParam` (reference input, có thẩm quyền)
Giá lấy từ beacon **on-chain**, KHÔNG tin amount client mớm (chống spam thật).
```
price(op_type, t) = base_price[op_type] × demand_mult(t) / Q          (Q = 10⁹, BigInt)
```
```
PriceParam {                       -- NFT one-shot, reference input (CIP-31), KHÔNG tiêu
  op_prices   : List<OpPrice>,     -- OpPrice{ op_type: Int, base_price: Int }
  demand_mult : Int,               -- hệ số co giãn (keeper cập nhật, scale Q)
  m_min, m_max: Int,               -- clamp (scale Q); mặc định m_min=0.5Q, m_max=2.0Q
  epoch       : Int,               -- epoch cập nhật gần nhất (chống stale)
}
```
- **op_type chuẩn (CHỐT):** `1 = ảnh` (0.01 MAGIC = 10_000_000 nanogic), `2 = CID` (0.001 MAGIC = 1_000_000 nanogic). Mọi fixture/beacon/redeemer PHẢI dùng đúng key này.
- **`demand_mult`** dùng cấu trúc FIR (SMA-N của `load_raw = ops_served_epoch / target_capacity` rồi `clamp[m_min, m_max]`), **KHÔNG PI** — không biến tích phân trên datum, ổn định BIBO, anti-windup miễn phí, nhất quán UMKeeper.
- **Bất biến giá:** đơn-điệu-không-giảm theo load; chặn `[base×m_min, base×m_max]`; pure BigInt; hội tụ `base×SMA` trong ≤ N epoch.

### §7.3 Mô hình 2-validator co-spend
Tiêu MAGIC = **1 tx spend 2 validator**:
- **Vault input** (generator vault, module khác) spend bằng `BurnBatch { burns }` → giảm `current_amount`.
- **Engage UTxO** (`consume.ak`) spend bằng `Consume { op_type, op_count, price_ref, vault_ref }` → ghi state per-app, ép `Σburns == required`.

`consume.ak` đọc redeemer `BurnBatch` của `vault_ref` qua `tx.redeemers`, giải mã `burns` bằng `un_constr_data` với `burn_batch_constr` = constr index BurnBatch của vault đó (**per-vault deploy** — bảng §11). Hai validator đọc **CÙNG** `PriceParam` beacon + **CÙNG** `op_type/op_count` → giá không lệch. KHÔNG `tx.mint`.

```
EngageDatum { owner, consumed_count, last_epoch, did_commit }
```

### §7.4 Bất biến validator `consume` (C-CM-1..5)

| Mã | Ràng buộc |
|---|---|
| **C-CM-1** value preservation @engage | Engage UTxO chỉ giữ ADA + thread NFT (KHÔNG MAGIC/LAMP); `Σvalue(out) == Σvalue(in)`; KHÔNG `tx.mint`. |
| **C-CM-2** Σburns == required (AGGREGATE) | `total_required = Σ [price(op_type_i)×op_count_i]` trên MỌI Engage input (cùng `price_ref`); `total_burned = Σ burns` trên MỌI `vault_ref` phân biệt. Ép `total_burned == total_required` (`==`, KHÔNG `≥`: over-burn = giảm MAGIC vô cớ → CẤM). **Lý do AGGREGATE:** chặn pay-once-consume-N (N Engage cùng trỏ 1 vault burn). |
| **C-CM-3** double-satisfaction @engage | Đếm theo payment script hash; `#out==#in`; `Σ engageNFT(out)==Σ(in)`; `Σ consumed_count(out) == Σ(in) + Σ op_count`. |
| **C-CM-4** replay / state | Mỗi output@engage đúng 1 thread NFT one-shot; `owner` bảo toàn; `last_epoch == current_epoch`; `did_commit` **immutable** (`out==in`). |
| **C-CM-5** stale price | `0 ≤ current_epoch − PriceParam.epoch ≤ MAX_PRICE_STALE`. |

**Chống tiêu-trùng (per-epoch):** kết hợp C-CM-2 (`Σburns==required`) + eUTXO one-spend (mỗi vault UTxO spend đúng 1 lần/tx) + reset-snapshot (§4.2) → không double-spend trong epoch, không carry sang epoch sau.

**PruneExpired (dọn rác, permissionless).** Batch chết (`created_epoch < current_epoch`) được ai cũng dọn qua redeemer riêng — chỉ **bỏ byte batch đã reset, KHÔNG đổi giá trị sống** (reject-noop nếu không có gì để dọn). Không đụng `consume.ak` (validator này không giải mã VaultDatum).

### §7.5 `did_commit` — liên kết tiêu ↔ DID
`did_commit` (MVP = `#""` rỗng) → tương lai = `blake2b256` commitment liên kết engagement ↔ PhoenixKey DID sinh trắc (Governance C1/C3 attribution). Đặt 1 lần genesis, immutable. **Thuộc PhoenixKey backend → giao Long** (ranh giới: MAGIC-team không sửa).

### §7.6 Paymaster — tiêu hộ, MAGIC không rời vault
App đặt `personal_delegate = Some(app_pkh)` qua `SetDelegate` ở vault → app ký `BurnBatch` tiêu MAGIC HỘ user (trả phí tx) mà **MAGIC vẫn nằm trong vault user**. Đạt UX paymaster KHÔNG vi phạm "MAGIC không transfer".

---

## §8. Vacuum = VacuumBack (KHÔNG phải cửa gen)

**"Vacuum" trong hệ hiện tại = VacuumBack** — back **thứ-3** trong kiến-trúc-ổn-định CARP, KHÔNG phải một cửa sinh MAGIC.

- Cơ chế: **commit-khoá LAMP/CARP kỳ-hạn**; kích hoạt khi `d ≥ d_vacuum = 6%` (peg lệch); vai PEG+SOLVENCY.
- **INV-VACUUM-ISOLATION:** leak ≡ 0 — VacuumBack cách-ly cứng khỏi `backing_core` (chống Vacuum-cliff).
- Thưởng người commit = **ưu-đãi-phí** = quyền-tiêu-MAGIC-thêm (non-transferable), KHÔNG phải yield tài sản.
- Chi tiết: `Carpet-CARP-DacTa-Vi.md §4.2`.

> **Lịch sử:** "VacuumGen" (cửa gen commit-then-fire 2 epoch) trong code cũ = **CHẾT**. Đừng nhầm với VacuumBack.

---

## §9. Hợp đồng tín dụng MAGIC đa-nguồn (LAMP hoặc CARP)

Khi app đặt hợp đồng cấp MAGIC cho user, app **chọn nguồn khoá**:

- **Nguồn A — nắm LAMP:** LAMP đứng-yên-ví → InstantGen/ScheduleGen sinh quyền-tiêu gắn DID user. Hết hạn LAMP vẫn thuộc app. Dùng khi backing khoẻ (tỷ giá Gen cao). App gánh rủi-ro-giá-LAMP.
- **Nguồn B — khoá CARP:** PrepaidGen → mỗi lần user tiêu, phần CARP → quyền-tiêu (F2). Dùng khi kỳ vọng LAMP sụp (giữ CARP-stable mua lại LAMP rẻ). Không gánh rủi-ro-giá-LAMP.

**Bất biến chung:** quyền-tiêu chỉ user-đích (DID) tiêu được; user được đảm bảo đúng lượng dịch vụ bất kể giá LAMP (hệ gánh rủi-ro-giá); phí mạng (ADA + DUST) gói trong giá MAGIC, PhoenixKey thu về Treasury (qua CARP) bù — user không cần cầm ADA/DUST.

Mô phỏng ví dụ vùng-xám (chị Oanh) + cơ sở pháp lý đầy đủ: whitepaper §9–§10.

---

## §10. Governance — C1 keyed vào MAGIC-đã-tiêu-thụ

**Voting Power KHÔNG token-weighted** (cử tri = cá nhân qua PhoenixKey DID sinh trắc). VP = tích-nhân ≥4 tham số; **C1 = MAGIC tiêu thụ**.

- **Nguồn C1 = `consumed_count` engage-side** (`EngageDatum.consumed_count`, §7.3), cửa-sổ ~18 epoch, đọc **cross-DID** — KHÔNG đọc tổng-sự-kiện-vault (số này self-burn bơm được).
- Điều này đóng phụ-thuộc-mở **D9** trong `LAMP/Governance/VotingPower/CONTRACT.md` (chống-mượn-C1: MAGIC xác nhận = consumed thật, không phải MAGIC-cầm).
- Nguồn chân lý công thức VP: `LAMP/Governance/VotingPower/CONTRACT.md`.

---

## §11. Cơ sở kỹ thuật on-chain — hằng số + constructor index

**Bit-identical Aiken ↔ TypeScript (P8).** `offchain/src/math.ts` và `onchain/lib/math.ak` phải cho output y hệt cho input y hệt, kiểm bằng test vector (App B). Đổi một bên → đổi bên kia.

**BigInt mọi nơi (C-OVERFLOW).** `Q = 10⁹`; `oildrop = LAMP × 10⁶`; `nanogic = MAGIC × 10⁹`. Cấm `Number` cho amount.

**Q-format = floor tuần tự.** `M = L × R × ... / Qⁿ` áp thành từng bước `⌊× / Q⌋` riêng, không one-shot multiply-then-divide (bound rounding per §6.1/L4).

**Hằng số cứng enforced on-chain (đồng bộ `constants.ak` ↔ `constants.ts`):**

| Hằng | Giá trị |
|---|---|
| `MAX_BATCHES_PER_VAULT` | 32 |
| `MAX_LOYALTY_HOLDINGS` | 64 |
| `MAX_GEN_SCHEDULES` | 20 |
| `SHARD_COUNT` | 16 |
| `SHARD_CAP` | 4.5×10¹⁴ oildrop |
| `br_safe` | 1.5 |
| `κ` (ScheduleGen) | 0.6 |
| `buffer_ep` | 2 |
| `f` (cap_surplus) | ≤ 0.10 |
| `m_min / m_max` | 0.5Q / 2.0Q |
| `RATE_REF_Q` (pp_schedule) | 10¹² |
| `ρ` (MAGIC/LAMP/epoch) | 1 |
| `Q` | 10⁹ |
| `LENT_PP_CAP` (trần LAMP-mượn, §6.1) | *chốt sau (hằng-hệ, ≪ 1001·ρ)* |

**Constructor index BurnBatch per-vault** (TypeScript `Data.Enum`/`Data.Object` phải khớp thứ tự Aiken — đổi thứ tự một bên là hỏng decode bên kia):

| Vault | `burn_batch_constr` |
|---|---|
| InstantGen | 2 |
| ScheduleGen | 2 |
| (Snapshot — legacy, không dùng) | 1 |
| (Vacuum — legacy, không dùng) | 4 |

> Ghi chú: `decay_window = 1` (§4.2) ⟹ nhiều cơ chế legacy (carry-over, halving-trong-gen, SnapshotGen, VacuumGen) **không còn trong mô hình canonical**. Constr index 1/4 giữ trong bảng chỉ để đọc code cũ, KHÔNG deploy.

---

## §12. Bất biến tổng hợp (tra nhanh)

| Mã | Nội dung |
|---|---|
| **F1-MAGIC-ONE-WAY** | MAGIC không → CARP/LAMP/tiền |
| **F2-CARP-FRICTION** | CARP→MAGIC cam-kết-tiêu gắn-DID, không hoàn |
| **F3-NO-PASSIVE-YIELD** | Không yield theo số-dư |
| **F4-MAGIC-CLOSED** | non-transferable + per-epoch-reset + không-chuộc-tiền |
| **F5-CARP-FIAT-NEUTRAL** | neo-dịch-vụ, 3-back đa-dạng-trung-lập |
| **F6-NO-EXTERNAL-INPUT** | cổng/ngưỡng chỉ căn số-dư-nội-bộ |
| **INV-MAGIC-CITIZEN** | thưởng/VP keyed MAGIC-đã-tiêu (không gồm decayed) |
| **INV-CASHBACK-BOUND** | thưởng mỗi DID ≤ MAGIC thật đã tiêu |
| **I-ACT-7** | LAMP đứng yên khi gen (chỉ đọc reference_input) |
| **I-PERSON-5** | 1 PersonDID / 1 biometric_hash (chống Sybil-account) |
| **INV-VACUUM-ISOLATION** | VacuumBack leak ≡ 0 khỏi backing_core |
| **P8** | bit-identical Aiken ↔ TS |
| **C-OVERFLOW** | BigInt mọi amount |
| **C-CM-1..5** | bất biến ConsumeMAGIC (§7.4) |

---

## §13. Điểm mở + lộ trình

**`engine_key` gen — mô hình chốt (anh chốt 2026-07-30):** engine uỷ-quyền qua **anchor Service-DID**. `engine_key` là chữ ký **ORACLE hệ thống** chứng thực sổ tiêu-thụ off-chain (validator không tự đo được), KHÔNG phải chữ ký user; gen tx không có chữ ký user (giữ UX drip tự-động). Thay `engine_key: ByteArray` 1-of-1 hardcode bằng `(engine_anchor_policy, engine_anchor_name)` trỏ Service-DID; validator `expect anchor_controller_ok(...)` đọc controller hiện tại từ TAAD anchor qua `reference_input` (mẫu PhoenixKey `I-SPEND-2OF2`). Nhờ đó: **xoay khoá / thu-hồi / kill-switch (`status=Revoked`) miễn phí, không redeploy**; guardian-recovery làm escape-hatch. `anchor_controller_ok` **vendor ~30 dòng** vào `lib/` (không kéo aiken-dep repo PhoenixKey). Cardano không verify sinh-trắc on-chain → "2 yếu tố" = 2 khoá Ed25519, sinh-trắc gate off-chain (enclave).

> **`INV-ORACLE-INDEP` — hai oracle phải ĐỘC LẬP (adversary 2026-07-30).** `engine_key`-oracle (chứng thực sổ tiêu-thụ off-chain) và **backing-price-oracle** (định giá `B` cho `br` — F6) **PHẢI là hai thực thể / hai bộ khoá tách biệt**. Nếu chung một bên vận hành, kẻ chiếm 1 khoá vô hiệu **đồng thời** hai phanh reward(consumed) và cap_surplus(br). Phanh **duy nhất độc-lập-oracle** là `pp_schedule` (suy TUYẾN TÍNH từ LAMP THẬT trên chuỗi — §6.3) cùng `INV-INSTANT-LOCK` (LAMP khoá vật lý): dù oracle nói dối, không gen vượt được LAMP-khoá-thật. ⟹ giữ `pp_schedule` là trần cứng on-chain là điều kiện sống-còn cho fail-safe. Kill-switch `status=Revoked` phải tách quyền: bên giữ engine_key KHÔNG đồng thời giữ quyền chặn revoke.

> **Self-dealing / wash-consumption phụ thuộc `did_commit` (adversary 2026-07-30).** Vì MAGIC fungible + reward/C1 keyed theo consumed, một chủ thể vừa "user" vừa "merchant" có thể tự-trả-mình để bơm `consumed_count` giả (nâng reward InstantGen + C1). ConsumeMAGIC (`C-CM-1..5`) **không** kiểm "ai trả ai". Phanh đúng = `did_commit` (liên kết engagement ↔ DID sinh-trắc, §7.5) phát hiện pattern tự-giao — nhưng MVP `did_commit=#""` ⟹ **phanh TẮT tới khi Long giao `did_commit` thật** (lộ trình #1). Ghi nhận rủi ro: reward(consumed) và C1 dễ bị wash-trade tới khi did_commit bật; cân nhắc trần-suất consumed/epoch/DID như phanh tạm.

**Còn chốt:**
1. Cơ chế Mint CARP + utility-floor + sim phòng-thủ-giá (`Carpet-CARP-DacTa-Vi.md §3, §6`).
2. Tham số hệ-số-năng-lực per-dịch-vụ (spec dịch-vụ riêng) — siết-thêm dưới trần on-chain (§6.4).
3. `LENT_PP_CAP` (trần cứng LAMP-mượn, §6.1) — chọn giá trị hằng-hệ.

**Lộ trình:**
1. `did_commit` thật (giao Long) → khoá attribution Governance C1.
2. Compile Aiken (`aiken build` mỗi module) → deploy Preview theo thứ tự (§14 scripts).
3. Test Preview 3 cửa gen → tx thật.
4. Xây lõi CARP (MintingPolicy + ổn định).
5. Paymaster runner + fee-abstraction.
6. **Merkle-verify `so_lieu` (bỏ hẳn oracle `engine_key`)** — lộ trình sau-Preview; hiện dùng oracle anchor ở trên.

---

> **Nhất quán tài liệu:** file này ĐÈ `MagicLamp-3Token-DacTa-Vi.md` và các file GenMAGIC/ConsumeMAGIC rời. Cơ chế ổn định CARP → `Carpet-CARP-DacTa-Vi.md`. Diễn giải phổ thông (câu chuyện, pháp lý người dùng, mô phỏng) → `Launch/Whitepaper-MagicLamp-Tokenomic-(Vi).md`.
