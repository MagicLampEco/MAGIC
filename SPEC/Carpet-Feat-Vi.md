# Đặc tả TÍNH NĂNG Carpet (CARP) — Feature Spec cho người triển khai

> Trạng thái: **ĐỀ XUẤT** (draft **v0.1**, đồng bộ Carpet-CARP-DacTa-Vi.md **v0.3**). Cập nhật 2026-07-01.
> Phạm vi: mô tả **user-flow + vai từng tính năng** đủ rõ cho người triển khai (product/backend/onchain). **KHÔNG lặp toán chi tiết** — mọi công thức, ngưỡng, chứng minh trỏ về:
> - Nguồn chân lý kiến trúc/tham số: `Carpet-CARP-DacTa-Vi.md` (v0.3) — dưới đây gọi **[DacTa]**.
> - Toán tuyến-phụ-CDP + phân phối phí + reward: `CARP-Math-Vi.md` — dưới đây gọi **[Math]** (đọc kèm bảng-ánh-xạ-từ-vựng [DacTa §6b]).
> Khi mâu thuẫn: **[DacTa] thắng**. File này KHÔNG được đặt số/ngưỡng mới; chỉ trích lại số đã chốt kèm con trỏ.

---

## §0. Bản đồ tính năng (một trang)

CARP = "Tấm Thảm Thần" = **khả năng mua dịch vụ nội hệ**. Người dùng chạm CARP qua các flow sau:

| # | Flow | Ai dùng | Vai trong hệ | Trỏ [DacTa] |
|---|---|---|---|---|
| A | **Mua CARP** (nhập cửa) | người-chưa-nắm-LAMP, Platform-khách-hàng | đưa sức-mua-dịch-vụ vào tay người ngoài LAMP | §0, §1 |
| B | **PrepaidGen** (khoá CARP → MAGIC) | mọi người | **cửa phổ quát** + **sàn-cứng peg** (utility-floor) | §3.1, §5.1 |
| C | **ScheduleGen** (nắm LAMP, tiêu định kỳ) | holder-LAMP dùng-dài-hạn | cam kết tiêu tương lai, đối ứng GreenBack | §5.2 |
| D | **InstantGen** (nắm LAMP, tiêu ngay) | holder-LAMP cần-gấp | tiêu nhanh có trần-kép, đối ứng GreenBack | §5.3 |
| E | **Chuộc** (CARP → giá-trị) | holder CARP muốn ra | PSM-par (ra "par") **hoặc** CDP-phụ (chuộc-ra-LAMP) | §3.1, §4b |
| F | **Holder-LAMP hoá-lỏng** (mở CDP-phụ) | holder-LAMP cần thanh-khoản không-bán-LAMP | mint CARP tạm bằng LAMP over-collateral | §4b |
| G | **VacuumBack** (commit-khoá cứu hệ) | holder tự-nguyện | huy-động đệm TẠM, đổi ưu-đãi-phí | §4.2 |
| H | **Đăng-ký Registry-mở** (thành khách-hàng hệ) | bất kỳ platform/app/DePIN | mở nguồn cầu-dịch-vụ-thực đỡ-peg | §5b |

**Tiên đề trùm mọi flow — CÔNG DÂN HẠNG NHẤT = TIÊU MAGIC.** Không flow nào thưởng cho **giữ-tài-sản**. Mọi ưu-đãi/reward/VP sinh ra trong các flow này đều **keyed vào lượng-MAGIC-tiêu-thực** (trực tiếp hoặc gián-tiếp-qua-CARP-đã-tiêu). Xem §7 file này + [DacTa §1b].

---

## §1. Nguyên tắc chung cho người triển khai

1. **Hai động từ khác nhau, cấm nhầm:** `Mint CARP` = đúc đơn-vị-lưu-thông (có backing). `Gen MAGIC` = phát-sinh quyền-tiêu (tan biến khi tiêu, không tăng cung-tiền). **CẤM code/UI viết "mint MAGIC" hay "gen CARP"** ([DacTa §1] Gen≠Mint).
2. **MAGIC không có đường ra:** MAGIC KHÔNG chuyển-nhượng, KHÔNG đổi ngược ra CARP/LAMP/tiền, **có decay** (use-it-or-lose-it). Mọi flow gen-MAGIC là một-chiều.
3. **Mỗi MAGIC gắn MỘT dịch vụ cụ thể:** ScheduleGen-lưu-trữ chỉ tiêu được lưu-trữ, không đặt-logo. Người triển khai phải gắn `service_tag` vào MAGIC lúc gen ([DacTa §5]).
4. **Peg giữ bởi CẦU-THỰC, không bởi rổ-tài-sản:** khi thiết kế UI/incentive, đừng hứa "chuộc-ra-rổ". CARP là **utility-floored** ([DacTa §3.1, INV-PEG-BY-DEMAND]).
5. **Cấm ngôn từ:** không tự gọi "stablecoin/algorithmic/yield/fund/đầu-tư" trong sản phẩm ([DacTa §7 F-LANG]). Dùng "đồng-lưu-hành ổn định", "sức-mua-dịch-vụ".
6. **Không đỡ-peg bằng LAMP** trong bất kỳ flow nào ([DacTa INV-NO-LAMP-PEG-DEFENSE]).

---

## §2. Flow A — MUA CARP (nhập cửa)

**Ai:** người-chưa/không-muốn-nắm-LAMP; Platform-khách-hàng cần dịch-vụ (GreenSun, PhoenixKey, LampNet, OriLife...).

**Mục đích:** đưa **sức-mua-dịch-vụ** vào tay người ngoài LAMP mà không bắt họ mua/hiểu LAMP.

**Flow:**
1. User nạp fiat/tài-sản-được-chấp-nhận (qua bộ-đệm-app vùng-sáng) → nhận CARP theo tỷ giá neo.
2. Tỷ giá tham chiếu: `1 CARP = 1 MAGIC = 1 TB·ngày dịch-vụ ≈ $0.33` (≈ 3 CARP/USD) — **KHÔNG đọc oracle USD**, đây là numéraire nội sinh ([DacTa §2.1]).
3. CARP nhận về **giữ được, chuyển-nhượng-trong-hệ được**, không decay.

**Vai trong hệ:** CARP mua-vào là **cầu-thực đỡ-peg** khi người mua sẽ tiêu dịch-vụ (Platform). Đây là nguồn sống của utility-floor ([DacTa §3.1, §5b]).

**Tiên đề công-dân áp vào flow này:** mua-và-giữ CARP đơn thuần **KHÔNG sinh quyền-lợi thụ-động** (không lãi, không VP, không reward). Quyền-lợi chỉ phát sinh khi CARP **được tiêu thành dịch-vụ** (chuyển sang flow B/C/D). Người triển khai KHÔNG gắn yield/airdrop-theo-số-dư vào ví CARP ([DacTa INV-NO-PASSIVE-YIELD, INV-MAGIC-CITIZEN]).

**Lưu ý pháp lý triển khai:** geofence EU mặc định; người vùng-xám tiêu MAGIC qua bộ-đệm-app-vùng-sáng, không cầm CARP trực tiếp ([DacTa §8]).

---

## §3. Flow B — PREPAIDGEN (khoá CARP → MAGIC) — CỬA PHỔ QUÁT + SÀN-CỨNG PEG

**Ai:** mọi người (không cần nắm LAMP). Đây là cửa **ai cũng dùng**.

**Mục đích kép:**
- (product) trả-trước để lấy quyền-tiêu dịch-vụ.
- (hệ) là **sàn-cứng peg / utility-floor** — cơ chế giữ CARP quanh 1 ([DacTa §3.1, §5.1]).

**Flow:**
1. User khoá **X CARP** → gen **X MAGIC** (tỷ lệ **1:1 cứng**, luôn ra đúng 1 đơn-vị-dịch-vụ mỗi CARP).
2. CARP khoá **chuyển vào quỹ Paid của platform** cung dịch-vụ đó.
3. MAGIC gen ra gắn `service_tag`, có decay-window theo LOẠI (Prepaid = dài hơn nhưng **có hạn**, không vô hạn — [DacTa §5.4]).
4. **KHÔNG rút GreenBack** (tự-back bằng chính CARP khoá) → **không giới hạn số lượng** gen ([DacTa §5.1]).

**Vì sao là sàn-cứng:** CARP rớt dưới giá-trị-dịch-vụ → ai đó mua CARP rẻ → PrepaidGen → **tiêu dịch-vụ thật** → arbitrage-qua-tiêu-dùng kéo CARP về 1. Sàn này **không đụng LAMP**; depeg-sót cố hữu chỉ là phí+gas (0.5–2%). Biến sống-còn = **throughput tiêu-MAGIC/epoch** ([DacTa §3.1, §6c]).

**Bảo vệ chống default (F2) — người triển khai BẮT BUỘC cài** ([DacTa §5.1 F2]):
- **`vesting_v = 0`**: quỹ Paid **escrow-theo-delivery** — chỉ nhả cho provider theo **dịch-vụ-đã-giao thật**, không trả-trước.
- **`claim_provider ≤ Σ MAGIC_burned_par`**: provider chỉ đòi được tối đa phần MAGIC **đã-thực-đốt** tương ứng.
- **buffer-Paid ≥ 15% C** (= panic-thiết-kế, đệm-thiết-kế).
- **shortfall → Backstop, KHÔNG đụng LAMP.**

**Tiên đề công-dân:** flow này CHÍNH LÀ hành-vi công-dân-hạng-nhất (tiêu dịch-vụ). Reward/VP đo lượng-MAGIC-tiêu ở đây (qua burn-ID, [DacTa §6c, §1b]). Số toán reward/cap-per-DID: **[Math]**.

---

## §4. Flow C — SCHEDULEGEN (nắm LAMP, tiêu định kỳ tương lai)

**Ai:** holder-LAMP dùng-dài-hạn, biết trước nhu-cầu-tiêu định-kỳ.

**Mục đích:** cam kết tiêu MAGIC theo lịch, đối ứng **GreenBack** (đệm nghĩa-vụ, trục SOLVENCY).

**Flow:**
1. User cam kết `pp` MAGIC/epoch × `N` epoch, xin gen qua **cổng κ_eff** (đệm-động, [DacTa §4.1]).
2. **LAMP ở-yên-ví** — chỉ là **tư-cách** (holding gate), **KHÔNG thế-chấp**, không chuyển đi.
3. Trần `pp`/epoch **cứng**: không cho **rút-dồn** nhiều epoch vào một lần.
4. Hệ carry mua-LAMP-đáy ngược-chu-kỳ khi có thặng-dư (cơ chế nội bộ, không phải quyền user).

**Vai trong hệ:** tạo dòng-tiêu-dự-đoán-được → GreenBack tính đệm-yêu-cầu theo `Σ nghĩa-vụ / κ_eff`. `κ_eff` biến-thiên theo stress (`σ̂` EWMA-có-trễ + `br`), **một-nguồn-tín-hiệu-stress** dùng chung với NSF ([DacTa §4.1, §6.1]). Công thức κ_eff, waterfall-khi-thiếu: **[DacTa §4.1]**; số chi tiết: **[Math]**.

**Bất biến triển khai:** ScheduleBack (bơm-cung + ôm-LAMP) phải **TÁCH khỏi RedBack** (trung-lập-cung, không-LAMP) — `INV-SCHEDULE-NEUTRAL-VS-RED` ([DacTa §4.1]).

**Tiên đề công-dân:** tư-cách = **nắm LAMP** nhưng quyền-lợi phát sinh từ **cam-kết-tiêu MAGIC**, không từ số-dư-LAMP. LAMP chỉ gate tư-cách, không nhân độ-lớn/VP ([DacTa §1b]).

---

## §5. Flow D — INSTANTGEN (nắm LAMP, tiêu ngay)

**Ai:** holder-LAMP cần tiêu-gấp, không đợi lịch.

**Mục đích:** cho tiêu ngay nhưng **có trần-kép** để giữ nhịp-nhàng hệ, đối ứng GreenBack.

**Flow:**
1. User xin gen ngay. Độ-lớn tính `M_instant = Σᵢ wᵢ·Lᵢ` — **tuổi-đời-LAMP CHỈ gate tư-cách, KHÔNG nhân độ-lớn** ([DacTa §5.3], mô hình cũ LF-nhân-size đã bị bác: nhỏ-lâu-vượt-lớn-mới là vô lý).
2. **Trần-kép** (người triển khai CÀI CỨNG): `cap_instant = min( f·S·(br−br_safe)/br_safe , η·pp_schedule )` với **f ≤ 0.10**, **η = 0.5** → Instant ≤ 0.5×Schedule mọi trạng thái ([DacTa §5.3]).
3. **Van đỏ tuyệt đối:** `cap = 0` khi `br ≤ br_safe` (đúc-khi-đỏ = 0).
4. MAGIC gen gắn **nhóm-dịch-vụ** (rộng hơn Schedule 1-dịch-vụ, hẹp hơn any-service; biên do DAO xác nhận — [DacTa §5.3]).

**Vai trong hệ:** lấp khoảng-trống tiêu-nhanh mà không phá đệm-solvency (van-đỏ + trần-kép). `LAMP-hiện-tại là trục chính (trần tuyệt đối); tuổi-đời chỉ điều tiết tốc-độ/phí` — size vẫn trội, không cho nhỏ-vượt-lớn ([DacTa §5.3]).

**Tiên đề công-dân:** như Schedule — LAMP gate tư-cách, giá-trị đến từ tiêu-MAGIC.

---

## §6. Flow E/F — CHUỘC + HOLDER-LAMP HOÁ-LỎNG

Có **hai đường ra** khác bản chất; người triển khai phải tách rõ UI để không gây hiểu-nhầm "chuộc-ra-rổ".

### §6.1 Flow E — Chuộc PSM-par (tuyến CHÍNH)
**Ai:** holder CARP muốn ra "par" nhanh, không quan tâm LAMP.

**Flow:**
1. `P_redeem ≡ 1` (oracle-free) — chuộc CARP về **par** qua PSM, arbitrage tự-thưởng qua việc đóng CDP-phụ ([DacTa §3.1]).
2. Đây là **lực rẻ nhất** giữ peg (sim: hút ~1.2M "miễn phí" trước khi cần động quỹ).

**Vai:** đường-ra-par phổ-thông + đồng-thời là sàn-cứng phía trên/dưới. **KHÔNG phải "chuộc-ra-rổ-tài-sản"** — chỉ là par-nội-sinh.

### §6.2 Flow F — Holder-LAMP hoá-lỏng (mở CDP-phụ, TUYẾN-PHỤ)
**Ai:** holder-LAMP cần thanh-khoản **mà không bán LAMP trên DEX**.

**Mục đích:** hoá-lỏng LAMP tạm thời; đây là **TUYẾN-PHỤ**, KHÔNG phải backing-core-toàn-CARP ([DacTa §4b]).

**Flow:**
1. Khoá LAMP **over-collateral** → mint CARP mới. `MCR_base = 200%`, `LR = 130%`, NSF siết-khi-căng ∈[1.0,1.4].
2. Dùng CARP (tiêu/chuyển), sau đó **mua CARP đóng/giảm nợ** để lấy lại LAMP.
3. **`g_min ≥ 67%` (lamp_frac ≤ 33%) CHỈ áp cho tuyến-phụ này** — điều-kiện giữ CDP khỏi vòng-phản-hồi-LAMP, **KHÔNG áp CARP-core** ([DacTa §4b, INV-LAMP-CORE-CAP]).
4. **Thanh lý:** partial 50% → Dutch Auction bám-TWAP-hiện-tại. Bad_debt → **Backstop**.
5. Cô-lập-rủi-ro về **từng con nợ** (không haircut-tập-thể như 2-coin).

**Vai kép của CDP-phụ** (ngoài hoá-lỏng): (a) trần-kỹ-thuật khi CARP>1 (mint bán ra), (b) nguồn arbitrage-đóng-nợ khi CARP<1 ([DacTa §3.0, §3.2, §4b]).

**Định-giá collateral:** dùng `ρ_LAMP` (giá LAMP bằng CARP, TWAP) — **CHỈ để định-giá-collateral tuyến-phụ**, tách bạch với `P*` (peg) ([DacTa §2]). Toán đầy đủ CDP/NSF/thanh-lý/đấu-giá: **[Math §3–§13, §16–§21]**.

**Tiên đề công-dân:** mở CDP để hoá-lỏng **KHÔNG tự sinh reward/VP**. Chỉ khi CARP-mint-ra được **tiêu thành dịch-vụ** mới tính công-dân ([DacTa §1b]).

---

## §7. Flow G — VACUUMBACK (commit-khoá cứu hệ, ưu-đãi CHỈ-GIẢM-PHÍ)

**Ai:** holder LAMP/CARP tự-nguyện muốn giúp hệ qua stress, đổi ưu-đãi-phí.

**Mục đích:** huy-động **đệm TẠM** khi hệ cần (khác GreenBack thường-trực, khác RedBack đỡ-peg-phản-ứng) ([DacTa §4.2]).

**Flow:**
1. Hệ đạt ngưỡng `d ≥ d_vacuum` (= 6% độ-lệch-peg, [DacTa §4.7]) + có người commit.
2. User **commit-khoá LAMP/CARP kỳ-hạn (2 epoch)** vào **UTxO/policy RIÊNG**.
3. Đổi lại: **ưu-đãi-phí = MAGIC Generation Rate tăng thêm (non-transferable, không-lãi)** — tức **quyền-tiêu-thêm dịch-vụ**, KHÔNG phải yield tài-sản ([DacTa §1b, §8]).
4. Hết kỳ-hạn: nhả commit về ví.

**Ưu-đãi-VacuumBack là CHỈ-GIẢM-PHÍ (BẮT BUỘC hiểu đúng khi triển khai):**
- Trả bằng **quyền-gen-MAGIC-thêm** (non-transferable), KHÔNG bằng token/tiền/lãi.
- Vì thế **không-securities** ([DacTa §8]). UI KHÔNG được mô tả là "lãi suất staking" hay "yield".
- Keyed-MAGIC: ưu-đãi = quyền-tiêu, đúng tiên-đề công-dân ([DacTa §1b]).

**Quy tắc sinh-tử người triển khai PHẢI cưỡng-chế on-chain:**
- **F1 — INV-VACUUM-ISOLATION (Sev5):** LAMP-commit-Vacuum ở **UTxO/policy riêng**; **validator-core TỪ CHỐI mọi input mang token-Vacuum vào `backing_core`** (leak≡0 **cưỡng-chế**, không chỉ khai-báo). LAMP-Vacuum chỉ vào `hard_cap-cứu` (cổng Schedule) + đỡ-peg-tạm ([DacTa §4.2 F1, INV-VACUUM-ISOLATION]).
- **commit-Vacuum ≤ 20% C_circ** (cửa-rò `L_max = 0.373%C` cực mỏng).
- **F3 — stagger BẮT BUỘC (Sev4):** validator **cấm >X% commit cùng epoch đáo hạn** (tránh cliff rút đồng loạt) + `|Δcap|/epoch ≤ cap_surplus` + kèm cách-ly-cứng F1 ([DacTa §4.2 F3]).
- Kích hoạt theo ngưỡng-nội-tại (`d ≥ d_vacuum`), **KHÔNG chứa biến RedBack** — độc lập RedBack ([DacTa §4.2]).
- Hỗ-trợ-Instant: nâng cap-Instant tối đa lên **đúng trần-kép 0.5×Schedule, không hơn**.

---

## §8. Flow H — ĐĂNG-KÝ REGISTRY-MỞ (thành khách-hàng đỡ-peg)

**Ai:** bất kỳ platform/app/DePIN/datacenter/kênh-chat muốn vào hệ.

**Mục đích:** mở nguồn **cầu-dịch-vụ-thực** — nền tảng đỡ-peg phân-tán (không issuer-mechanism tập trung) ([DacTa §5b]).

**Cấu trúc phân-cấp (người triển khai định vị đúng vai):**
```
Ecosystem   MLF (DAO) → pháp-nhân-con vùng-sáng vận hành Carpet + RedBack   = ISSUER (duy nhất)
Platform    GreenSun(Rice) / PhoenixKey(Phoenix) / LampNet / OriLife        = KHÁCH-HÀNG (mua CARP vì cần dịch vụ)
App         AladinContract(Aladin) / DDC(TonFarm)
Registry-MỞ did:tiger / did:elephant · DePIN/Datacenter · chat Telegram/Zalo
```

**Điều kiện vào Registry (3 điều, ai thoả đều vào được):**
1. **TIÊU-MAGIC** (có hành-vi đốt MAGIC thật, đo qua burn-ID).
2. **DÙNG-CARP** (dùng CARP làm phương-tiện mua dịch-vụ).
3. **ĐĂNG-KÝ** (khai báo vào registry công khai).

**Vai trong hệ:**
- **Issuer duy nhất** = pháp-nhân-con-MLF vận hành Carpet + RedBack. Chỉ nơi này chịu vai phát-hành.
- **Platform/App/Registry = khách-hàng phân-tán**, mua CARP vì **cần dịch-vụ-thật** → đây là **cầu-thực đỡ-peg** ([DacTa §3.1]).
- Mở → **phi-tập-trung-thật**, chống look-through "một-thực-thể-điều-khiển-tất-cả" → làm **NHẸ ART** (không thoát — [DacTa §8]).

**Tiên đề công-dân:** điều-kiện-1 (tiêu-MAGIC) chính là cổng công-dân-hạng-nhất áp ở tầng registry — không tiêu-MAGIC thì không phải công-dân hệ.

---

## §9. Cách tiên-đề CÔNG-DÂN-HẠNG-NHẤT áp vào TỪNG flow (bảng tra nhanh)

| Flow | Có sinh reward/VP/ưu-đãi? | Keyed vào gì | Cấm |
|---|---|---|---|
| A Mua CARP | KHÔNG | — | cấm yield/airdrop-theo-số-dư CARP |
| B PrepaidGen | **CÓ** (đây là hành-vi công-dân) | lượng-MAGIC-tiêu-thực (burn-ID), hàm-lõm-phí cap-per-DID | cấm keyed-holding |
| C ScheduleGen | CÓ (qua tiêu định-kỳ) | MAGIC-cam-kết-tiêu, VP bão-hoà-ngưỡng | LAMP chỉ gate, không nhân VP |
| D InstantGen | CÓ (qua tiêu ngay) | MAGIC-tiêu | LAMP chỉ gate |
| E Chuộc-par | KHÔNG | — | cấm coi chuộc là "đầu-tư" |
| F CDP-hoá-lỏng | KHÔNG (tự thân) | chỉ khi CARP→tiêu-dịch-vụ | cấm reward-cho-mở-CDP |
| G VacuumBack | CÓ (ưu-đãi-phí) | quyền-gen-MAGIC-thêm (non-transferable) | cấm gọi "lãi/yield" |
| H Registry | Gate tư-cách | điều-kiện-1 = tiêu-MAGIC | cấm vào-registry-mà-không-tiêu-MAGIC |

**Ba cơ chế HYBRID keyed-MAGIC (chi tiết [DacTa §1b], số [Math §14b]):**
- **Mint reward** = `f_lõm(phí-thực-đốt)` per-DID, **cap-per-DID**; trần `Σreward ≤ Σ MAGIC_burned`.
- **Voting Power** = **bão-hoà-ngưỡng**, KHÔNG nhân-LAMP; C1 = MAGIC-tiêu **cross-DID** (chặn self-deal).
- **Ưu-đãi-phí** (VacuumBack, Booster) = MAGIC Generation Rate non-transferable.

**Bất biến trùm:** `INV-MAGIC-CITIZEN` — mọi hàm reward/VP/ưu-đãi PHẢI chứa biến MAGIC-tiêu-thực; **CẤM keyed thuần vào holding LAMP/CARP** ([DacTa §7]).

---

## §10. Bản đồ tính năng ↔ tầng ổn định (để không gọi nhầm cơ chế)

Người triển khai KHÔNG được để user-flow gọi trực-tiếp cơ-chế-đỡ-peg sai tầng. Ánh xạ:

| Tầng ([DacTa §4]) | Kích hoạt | Flow user liên quan | Trục |
|---|---|---|---|
| 0 — arbitrage nội sinh | luôn bật | E (chuộc-par), F (đóng nợ) | PEG |
| 1 — sàn-cứng utility-floor | luôn bật, thụ động | **B (PrepaidGen)** + E (PSM-par) | PEG |
| 2 — GreenBack | thường-trực | **C, D** (đối ứng) | SOLVENCY |
| 3 — VacuumBack | `d ≥ d_vacuum` + commit | **G** | PEG+SOLVENCY |
| 4 — RedBack + quỹ độc lập | `d ≥ d_red` + `br≥br_safe` | (hệ tự chạy, user không gọi) | PEG |
| 5 — Backstop | bad_debt | (nội bộ; nhận shortfall từ B, F) | SOLVENCY |

**Hàm-điều-phối-2-trục** `dispatch(d, br)` quyết định tầng-nào-kích: đọc **hai trục độc lập** (PEG = `d`; SOLVENCY = `br`), KHÔNG trộn một biến ([DacTa §4.7, INV-2-AXIS]). Bảng dispatch đầy đủ + thang-ngưỡng `d_soft=2% < d_red=4% < d_vacuum=6% < d_emergency`: **[DacTa §4.7]**.

**Điểm người triển khai hay sai:**
- RedBack **CHỈ hút-CARP khi `br≥br_safe`**. Khi br-đỏ, độ-lệch-giá xử bằng utility-floor (flow B), KHÔNG dùng RedBack ([DacTa §4.7]).
- **Không bơm pool CARP quá sâu** (~20% C_circ) — pool sâu làm sàn dễ gãy hơn, không dễ hơn ([DacTa §3.3]).

---

## §11. Checklist triển khai (rút gọn — evidence trước khi báo xong)

Trước khi tuyên bố một flow "sẵn sàng", cần bằng-chứng-output-thật, không chỉ compile-pass:

- [ ] **B (PrepaidGen):** verify escrow-theo-delivery thật (vesting_v=0), buffer-Paid≥15%, shortfall→Backstop (không LAMP). Test bằng payload thật.
- [ ] **C/D (Schedule/Instant):** verify van-đỏ `cap=0` khi `br≤br_safe`; trần-kép Instant ≤0.5×Schedule; LAMP-ở-yên-ví (không thế-chấp Schedule).
- [ ] **F (CDP-phụ):** verify `lamp_frac≤33%` cưỡng-chế **on-chain** (không chỉ khai báo); thanh-lý partial-50%→Dutch-Auction; bad_debt→Backstop.
- [ ] **G (Vacuum):** verify validator **TỪ CHỐI** token-Vacuum vào backing_core (leak≡0, test input độc-hại thật); commit≤20%C; stagger cấm >X%/epoch.
- [ ] **Trùm:** grep toàn-bộ reward/VP/ưu-đãi → mỗi hàm CÓ biến MAGIC-tiêu; không hàm nào keyed-holding.
- [ ] **Ngôn từ:** grep UI/copy → không "stablecoin/yield/lãi/fund/đầu-tư"; VacuumBack mô tả "giảm-phí" không "lãi".

---

## §12. Điểm mở ảnh hưởng tính năng (chưa khoá)
1. **Benchmark throughput tiêu-MAGIC thực địa** ([DacTa §6c, §9#1]) — quyết định flow B có giữ sàn được không. Chưa đo.
2. Genesis quỹ Paid: buffer≥15%, escrow-delivery, biên nhóm-dịch-vụ Instant, trọng-số rổ-dịch-vụ ([DacTa §9#5, §2.2]).
3. `κ_reward` per-loại + ngưỡng bão-hoà VP — ảnh hưởng độ-lớn reward/VP các flow B/C/D ([DacTa §9#7]).
4. Ranh ART EU: chờ luật-sư MiCA trước khi mở registry cho EU-entity ([DacTa §8, §9#6]).

---

> **Ghi chú nhất quán:** file này KHÔNG đặt số/ngưỡng mới. Mọi con số trích từ [DacTa v0.3]; mọi toán trỏ [Math] (đọc kèm bảng-ánh-xạ [DacTa §6b]: GreenBack=GreenPeg, RedBack=RedPeg, Backstop=Insurance Pool, br=H). Khi mâu thuẫn → theo [DacTa]. KHÔNG đề cập MagicChange.
