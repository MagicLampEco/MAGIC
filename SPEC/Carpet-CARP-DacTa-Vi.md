# Đặc tả Carpet (CARP) — Token Lưu hành & Ổn định của MagicLamp

> Trạng thái: **ĐỀ XUẤT** (draft **v0.3**, chờ duyệt). Cập nhật 2026-07-01.
> Nguồn: đặc tả 3-token + cơ chế đã thảo luận trong /MAGIC, /CARP + **4 vòng mô phỏng có phản biện** (điểm-gãy MECE + benchmark 3-back có reflexivity/arbitrage-vật-lý/price-impact) + khung utility-floored đã chốt.
> CARP = "Tấm Thảm Thần" — **khả năng mua dịch vụ nội hệ**. (MAGIC = "Điều Ước" = quyền tiêu một dịch vụ cụ thể; LAMP = "Đèn Thần" = tài sản nền.)
> **KHÔNG đề cập MagicChange** (theo chỉ đạo). CARP giữ peg bằng **cầu-dịch-vụ-thực** + cơ chế nội bộ, không bằng DEX/sàn ngoài.
> Mọi tham số ghi **[VỮNG]** = sim đã kiểm, khoá được; **[DAO]** = cần đo thực địa / DAO điều chỉnh.

> **CHỐT KIẾN TRÚC v0.3 (khác v0.2):** CARP là **UTILITY-FLOORED**, KHÔNG phải backing-tài-chính-chuộc-ra-rổ.
> - Tuyến **CHÍNH** giữ peg = **utility-floor**: cầu-dịch-vụ-THỰC (PrepaidGen 1:1 + PSM-par + arbitrage-qua-tiêu-dùng). Neo = **sức-mua-dịch-vụ-thực** (inelastic, ổn-định-vĩ-mô-dài-hạn) — KHÔNG neo USD, KHÔNG neo giá-tài-sản.
> - CDP-LAMP chỉ là **TUYẾN-PHỤ** (ai muốn chuộc-ra-LAMP), tự-thanh-lý riêng, **KHÔNG phải backing-core-toàn-CARP**.
> - **GỠ mâu thuẫn g_min:** `g_min≥67%-phi-LAMP` là lo-ngại của mô-hình-chuộc-ra-rổ. CARP-utility-floored KHÔNG chuộc-ra-rổ → **g_min-67% GỠ khỏi CARP-core**; nó chỉ còn là điều-kiện của **tuyến-phụ-CDP** (§tuyến-phụ). Peg giữ bởi **cầu-thực**, không bởi rổ-tài-sản.

---

## §0. Tóm tắt một trang

CARP là **đồng-lưu-hành ổn định** để (a) người chưa/không muốn nắm LAMP vẫn có sức-mua-dịch-vụ, (b) người nắm LAMP hoá-lỏng tài sản mà không bán LAMP.

- **Tiên đề tối cao — CÔNG DÂN HẠNG NHẤT = TIÊU THỤ MAGIC.** Giá trị hệ đến từ **TIÊU-DỊCH-VỤ**, không từ **GIỮ-TÀI-SẢN**. Mọi tiêu-chí/ưu-đãi/hàm-số keyed vào **tiêu-MAGIC** (trực tiếp = lượng-tiêu; gián tiếp = qua CARP), KHÔNG vào holding. Xem §1b.
- **Neo:** `P* = 1` — 1 CARP = 1 MAGIC = **một đơn-vị-sức-mua-dịch-vụ nội sinh**. Tỷ giá: **1 nanogic = 1 KB·ngày lưu trữ** → 1 CARP = 1 TB·ngày ≈ **$0.33** (giá storage ~$0.01/GB/tháng) → **~3 CARP ≈ 1 USD**. **KHÔNG neo fiat, KHÔNG neo giá-tài-sản.** Đề xuất **neo RỔ-dịch-vụ** để trung-hoà deflation. Xem §2.
- **Sàn cứng peg = utility-floor** (PrepaidGen 1:1 + PSM-par): CARP rẻ dưới giá-trị-dịch-vụ → mua CARP rẻ → đổi MAGIC → **tiêu dịch vụ thật** kéo về 1. Sim xác nhận sàn giữ CARP về đúng mép `1−(phí+gas)`, **không đụng LAMP**. Depeg-sót cố hữu = phí+gas (0.5-2%).
- **Kiến trúc ổn định phân tuyến, tự-động theo cung-cầu** (không đặt-tay, không oracle-giá điều khiển): **Tuyến-0 arbitrage-nội-sinh → Tuyến-chính utility-floor → GreenBack → VacuumBack → RedBack (+ quỹ độc lập) → Backstop.** Xem §4.
- **Đỡ-peg đến từ CẦU-KHÁCH-HÀNG** (Platform mua CARP vì cần dịch vụ), không từ issuer-mechanism tập trung → nhẹ ART + phi-tập-trung-thật. Xem §5b (cấu trúc phân-cấp) + §8 (pháp lý).
- **Backing tuyến-phụ = CDP-LAMP over-collateral nội bộ** (không giữ rổ-tài-sản-ngoại-sinh làm dự-trữ-tham-chiếu). `g_min≥67%` **chỉ áp cho tuyến-phụ CDP**, KHÔNG phải backing-core-toàn-CARP **[VỮNG cho tuyến-phụ]**.
- **Pháp lý:** "function-stable crypto asset" / utility-token có sàn-tiện-ích. **Trung thực: ART-risk CÒN** (utility-floored + CDP-phụ-nhỏ + đỡ-peg-cầu-khách-hàng làm NHẸ nhưng KHÔNG thoát) → geofence EU mặc định + luật-sư MiCA. **KHÔNG hứa "thoát ART".** Xem §8.

**Bất biến tối thượng:** không token nào trả lãi/lợi-tức theo số dư (`INV-NO-PASSIVE-YIELD`); CARP trong kho quỹ KHÔNG đếm backing (`F-TÀI-SẢN'`); **tuyệt đối không đỡ-peg bằng LAMP** (vòng phản hồi tự-hủy — sim: pool LAMP nông tụt 61% chỉ để chi 750k par); **mọi ưu-đãi/VP keyed vào tiêu-MAGIC, không vào holding** (`INV-MAGIC-CITIZEN`).

---

## §1. Định vị & quan hệ ba token

| | LAMP (Đèn) | MAGIC (Điều Ước) | CARP (Thảm) |
|---|---|---|---|
| Bản chất kinh tế | tài sản nền | **quyền tiêu 1 dịch vụ cụ thể** | **khả năng mua dịch vụ nội hệ** |
| Hành động tạo | — | **Gen** (cấp-quyền) | **Mint** (đúc-tiền) |
| Chuyển nhượng | có | KHÔNG | có (trong hệ) |
| Decay | không | có (use-it-or-lose-it) | không |
| Vai trò giữ-peg | tuyến-phụ CDP + collateral | **neo sức-mua + động-lực-công-dân** | đơn-vị-lưu-thông cần giữ quanh 1 MAGIC |

**Gen ≠ Mint (kỷ luật thuật ngữ):** *Mint* CARP = đúc một đơn-vị-lưu-thông có backing (monetary creation). *Gen* MAGIC = phát-sinh một quyền-tiêu từ nguồn (entitlement issuance) — không tăng cung-tiền-lưu-thông, tan biến khi tiêu. **Cấm viết "mint MAGIC" hoặc "gen CARP".**

```
   LAMP ──Schedule/InstantGen (đối ứng GreenBack)──► MAGIC ──► TIÊU 1 dịch vụ cụ thể / tan biến
    │                                                  ▲              (= nguồn giá trị hệ)
    │  CDP-LAMP (TUYẾN-PHỤ: chuộc-ra-LAMP, g_min)      │ PrepaidGen: khoá CARP → quỹ Paid platform
    └──────────────► CARP ─────────────────────────────┘
                     (mua bằng fiat/tài sản; giữ; F2: CARP→MAGIC một chiều có ma sát)
   MAGIC ──► KHÔNG có đường ra (không → CARP/LAMP/tiền)
```

---

## §1b. TIÊN ĐỀ CÔNG-DÂN-HẠNG-NHẤT (mọi hàm chứa MAGIC)

**Nguyên lý gốc:** giá trị hệ sinh ra từ **TIÊU-DỊCH-VỤ (đốt MAGIC thật)**, không từ **GIỮ-TÀI-SẢN**. Do đó mọi cơ chế thưởng/ưu-đãi/quyền-lực phải **chứa biến MAGIC** — trực tiếp (lượng-MAGIC-tiêu) hoặc gián tiếp (qua CARP đã dùng để tiêu dịch vụ). Holding LAMP/CARP đơn thuần KHÔNG sinh quyền lợi thụ động.

**Cơ chế HYBRID keyed-MAGIC (BẮT BUỘC):**

| Trục | Công thức | Ràng buộc MAGIC |
|---|---|---|
| **Mint reward** (thưởng đóng-góp) | `reward = f_lõm(phí-thực-đốt)` per-DID, **cap-per-DID** | hàm-lõm-của-phí-thực-đốt (giảm dần lợi suất); trần Σreward ≤ Σ MAGIC_burned |
| **Voting Power** | `VP = bão-hoà-ngưỡng`, **KHÔNG nhân-LAMP** | C1 = MAGIC tiêu thụ **cross-DID** (không self-deal); bão hoà tránh token-weighted trá hình |
| **Ưu-đãi-phí** (VacuumBack, Booster) | trả bằng **MAGIC Generation Rate** (non-transferable) | phần thưởng = quyền-tiêu-thêm, KHÔNG phải yield tài sản |

**Vì sao HYBRID (mint=lõm-phí / VP=bão-hoà-ngưỡng):**
- **Mint reward = hàm-lõm-của-phí-thực-đốt, cap-per-DID:** thưởng theo TIÊU-THỰC (đốt MAGIC có burn-ID), giảm dần biên (chống cá-lớn độc chiếm), cap mỗi DID (chống Sybil-gom). Σreward ≤ Σ MAGIC_burned là rào cứng (§14b-math: bất biến tổng trên sổ burn-ID).
- **VP = bão-hoà-ngưỡng, KHÔNG nhân-LAMP:** cử tri = cá nhân (PhoenixKey DID sinh trắc), KHÔNG token-weighted. VP bão hoà theo ngưỡng tiêu-MAGIC (đạt ngưỡng → đủ tư-cách, không mua thêm quyền bằng vốn). C1 (MAGIC tiêu) đọc cross-DID để chặn tự-burn-vòng mua VP rẻ bằng LAMP.

**Bất biến `INV-MAGIC-CITIZEN`:** mọi hàm reward/VP/ưu-đãi PHẢI có biến MAGIC-tiêu-thực (trực tiếp hoặc qua-CARP-đã-tiêu); CẤM hàm keyed thuần vào số-dư-nắm-giữ LAMP/CARP.

---

## §2. Đơn vị neo, numéraire & TỶ GIÁ

- `P* = 1`: 1 CARP ≡ 1 MAGIC theo **sức-mua-dịch-vụ**, oracle-free.
- `1 thread ≡ 1 nanogic` ⟺ `1 CARP = 1 MAGIC`. Numéraire nội sinh: base_price on-chain, đổi qua DAO ≤10%/lần, ≥1 quý/lần.
- Hai giá tách bạch: `P*` (peg, dịch vụ, oracle-free ở chuộc-par) vs `ρ_LAMP` (giá LAMP bằng CARP, TWAP, **chỉ định-giá-collateral tuyến-phụ-CDP**). `INV-PEG-ENDO`.

### §2.1 ĐƠN VỊ ĐO CHUẨN HOÁ + TỶ GIÁ (chốt v0.3, sửa 1/7) **[VỮNG định-nghĩa]**

**KHÔNG tuyên bố USD/VND/fiat nào.** Số USD/VND chỉ **tham-chiếu-nội-bộ** để ước-lượng + hiệu-chỉnh máy.

**(a) ĐO THEO BYTE (integer-sạch cho Cardano):** Cardano tính **integer thuần**, không float. Nếu lấy `1 nanogic = 1 KB` thì file < 1 KB thành 0,001 nanogic — **không biểu diễn được**. Do đó đo mọi tài nguyên theo **đơn-vị-nguyên-tử integer**: storage = **byte·giây** (`1 ngày ≡ 86400 giây` cứng, không DST). Phí = `Σ(byte × giây × base_price)` — toàn integer.

**(b) base_price là THAM SỐ (DAO/Platform đặt), KHÔNG khoá `1 nanogic = 1 storage-unit cố định`.** 1 MAGIC là **đơn-vị-KẾ-TOÁN** (user trả VND, hệ quy MAGIC), không phải đơn-vị-mua-hàng. Hiệu chỉnh base_price sao cho **1 MAGIC ≈ 2.500 VND (~$0,10), < 1 USD** — đúng vùng "cà phê/bánh mì". (Mốc cũ `1 nanogic=1 KB·ngày → 1 MAGIC=1 TB·ngày ≈ 8.600 VND` là ĐẮT + lẻ-integer → BỎ.)

**(c) GIÁ STORAGE = LƯU-LẠNH DÀI HẠN, KHÔNG gồm xử-lý.** Chi phí vòng đời một tài nguyên = **ingest(biên) + truyền-tải + phân-tích + lưu-nóng + render → cuối cùng lưu-lạnh**. Mỗi khâu có base_price RIÊNG (§2.3). Phần lớn chi phí ở **xử-lý-ban-đầu**, không phải lưu-trữ.

**Ví dụ tính từ file thật (RealDurian):**
| | Lưu-lạnh 1 năm | Xử-lý vòng đời | Tổng ≈ | ≈ MAGIC |
|---|---|---|---|---|
| 1 ảnh 4k (~3 MB) | ~6 VND | ~80-260 VND | ~90-270 VND | **~0,04-0,1 MAGIC** |
| 1 video 10s (~10-45 MB) | ~80 VND | ~400-1300 VND | ~500-1400 VND | **~0,2-0,6 MAGIC** |

### §2.2 NEO RỔ-DỊCH-VỤ (không neo một-dịch-vụ) **[DAO]**
- Neo một-dịch-vụ (storage thuần) chịu **deflation công nghệ**. Neo **RỔ 4-resource LampNet** — `storage + compute + bandwidth + sensor` (+ lao-động/định-danh) — trọng số DAO. Rổ đa-dịch-vụ inelastic + ổn-định-vĩ-mô-dài-hạn hơn.
- Neo = **sức-mua-dịch-vụ-thực**. Cập nhật rổ qua DAO ≤10%/lần, ≥1 quý/lần.

### §2.3 BẢNG DANH MỤC TÀI NGUYÊN CHUẨN HOÁ (khung LampNet 4-resource) **[chuẩn bắt buộc — Platform đặt giá riêng]**
| Resource | Đơn-vị chuẩn (integer) | Ghi chú |
|---|---|---|
| Storage-lạnh (cold, Mirage) | byte·giây | rẻ nhất, cuối vòng đời |
| Storage-nóng (hot) | byte·giây | truy-cập-nhanh, đắt hơn |
| Compute (Cave) | ExUnit / CPU-giây | xử-lý/phân-tích/render |
| Bandwidth (Beam) | byte-truyền | ingest + serve |
| Sensor/Edge (Probe) | thao-tác | xử-lý-tại-biên |
| Định-danh | thao-tác | ghi bản-ghi DID |

**Đơn-vị chuẩn hoá BẮT BUỘC (để Platform đối chiếu); giá mỗi Platform khác nhau.** Đối chiếu chi tiết pricing: LampNet `ResourceBudget.md` (4 resource: Mirage/Cave/Beam/Probe).

---

## §3. PEG 1:1 CARP/MAGIC — cơ chế giữ (tự động, minh bạch)

### §3.0 Tuyến-0 — arbitrage nội sinh (luôn bật, không keeper) **[VỮNG]**
- `P_CARP < peg`: người mở CDP-phụ **mua CARP rẻ trên DEX rồi burn đóng/giảm nợ** → rẻ hơn trả đủ → lực mua kéo về peg (cơ chế DJED đã chứng minh, không cần ngân hàng can thiệp).
- `P_CARP > peg`: mở CDP-phụ mint CARP bán ra có lời → tăng cung kéo xuống.
- **Lõi Carpet + GreenBack KHÔNG tự trade DEX.** Chỉ RedBack (vệ tinh tách biệt, §4.3) được trade khi peg-đỏ.

### §3.1 Sàn cứng — utility-floor (TUYẾN CHÍNH, luôn bật) **[VỮNG]**
- **PrepaidGen 1:1:** 1 CARP khoá → luôn ra 1 MAGIC = 1 đơn-vị-dịch-vụ. CARP rớt dưới giá-trị-dịch-vụ → mua CARP rẻ → PrepaidGen → **tiêu dịch vụ thật** → arbitrage-qua-tiêu-dùng kéo CARP về 1.
- **PSM-par:** `P_redeem ≡ 1` (oracle-free), arbitrage tự-thưởng qua đóng CDP-phụ. **Lực rẻ nhất** (sim: hút ~1.2M "miễn phí" trước khi cần động quỹ).
- **Đây là NEO-CORE:** peg giữ bởi **cầu-dịch-vụ-THỰC** (cầu tiêu-MAGIC của Platform-khách-hàng, §5b), KHÔNG bởi rổ-tài-sản. Sim: sàn kéo CARP về đúng mép `1−(phí+gas)`, không đụng LAMP. **Biến sống-còn = throughput tiêu dịch vụ MAGIC/epoch** — sàn gãy CHỈ khi panic-CARP-tuyệt-đối > throughput×thời-gian.

### §3.2 Trần — mint CARP qua CDP-phụ
- CARP > 1 → mint CARP mới (qua CDP-phụ) bán ra → tăng cung kéo xuống. Round-trip chịu **phí giao dịch (không lãi)**.

### §3.3 Nghịch lý pool (thiết kế thanh khoản) **[VỮNG]**
- **KHÔNG bơm pool CARP quá sâu.** Pool càng sâu, cùng % depeg cần lượng CARP-panic-tuyệt-đối càng lớn, vượt sức throughput. Tối ưu: **pool vừa (~20% C_circ) + throughput cao**, không pool khổng lồ.

---

## §4. KIẾN TRÚC ỔN ĐỊNH PHÂN TUYẾN (đa-tài-sản, tự-động theo cung-cầu)

| Tầng | Quỹ/cơ chế | Kích hoạt | Tài sản | Trục |
|---|---|---|---|---|
| 0 — arbitrage nội sinh | user tự mua-lại/mint | luôn bật | CARP DEX | PEG |
| 1 — sàn cứng (TUYẾN CHÍNH) | utility-floor + PSM-par | luôn bật, thụ động | cầu-dịch-vụ-thực + CDP-phụ | PEG |
| 2 — back nghĩa-vụ | **GreenBack** (đệm động κ_eff) | thường-trực | MAGIC/CARP-chưa-phát + LAMP-đáy | SOLVENCY |
| 3 — huy-động tạm | **VacuumBack** (commit-khoá kỳ-hạn) | `d ≥ d_vacuum` (§4.7), có commit | CHỈ LAMP + CARP, cách-ly-cứng | PEG+SOLVENCY |
| 4 — đỡ-peg gián-tiếp | **RedBack** (đa-token) + quỹ độc lập | `d ≥ d_red` (TWAP) + `br≥br_safe` | ADA/NIGHT/token-hệ ρ≤0.3 | PEG |
| 5 — bad_debt | **Backstop** (đổi tên từ Insurance) | backing-đỏ (`br<br_safe`) | LAMP + ít cứng | SOLVENCY |

> **HÀM-ĐIỀU-PHỐI-2-TRỤC (§4.7) là gốc gỡ deadzone F4:** các tầng đọc **hai trục độc lập** (PEG = độ-lệch-giá `d`; SOLVENCY = `br`). Không dùng chung một biến cho cả điều-kiện-kích lẫn độ-lớn-năng-lực.

### §4.1 GreenBack — đệm nghĩa-vụ Schedule+Instant (trục SOLVENCY)
- **Đệm-yêu-cầu = Σ nghĩa-vụ-Schedule / κ_eff.** κ_eff là **hàm biến thiên** (tự-đạt mức-vốn-đệm khi stress):
  `κ_eff = clamp(0.6 − a·σ̂ − b·max(0, br_safe−br), 0.43, 0.6)`
  với `σ̂` = **ước-lượng-có-trễ (EWMA)** từ **một-nguồn-tín-hiệu-stress duy nhất** (§tinh-gọn), KHÔNG dùng σ tương-lai.
- **Ghi chú trung thực [DAO]:** sim cho thấy giá-trị của κ-động = đạt **mức-vốn-đệm đúng** (đệm ~2.3× khi stress), KHÔNG phải "phép-màu phản-chu-kỳ" (κ-tĩnh cùng-vốn cho kết quả y hệt). `a,b` là **tham-số-DAO** theo σ̂ EWMA, không hard-code.
- Waterfall khi thiếu: GreenBack-điều-chỉnh-tỷ-giá → bán-LAMP-thặng-dư → RedBack → tín-dụng-platform → Treasury.
- `INV-SCHEDULE-NEUTRAL-VS-RED`: GreenBack/ScheduleBack (bơm-cung+ôm-LAMP) TÁCH khỏi RedBack (trung-lập-cung+không-LAMP).

### §4.2 VacuumBack — huy-động đệm tạm (back thứ 3) **[VỮNG có điều kiện]**
- **Vai MECE riêng:** holder tự-nguyện **commit-khoá LAMP/CARP kỳ-hạn (2 epoch)**, đổi **ưu-đãi-phí (không lãi, non-transferable — keyed-MAGIC §1b)**, huy-động đệm TẠM khi hệ cần. Khác GreenBack (thường-trực) + RedBack (đỡ-peg-phản-ứng).
- **Độc lập RedBack:** hàm Vacuum KHÔNG chứa biến RedBack (d_red). Kích hoạt theo commit + ngưỡng-nội-tại (`d ≥ d_vacuum`, §4.7), không theo ngưỡng-peg của Red.

- **F1 — QUY TẮC SINH-TỬ (leak≡0, cưỡng-chế on-chain) — Sev5 INV-VACUUM-ISOLATION:** LAMP-commit-Vacuum đặt ở **UTxO/policy RIÊNG**. **Validator-core TỪ CHỐI mọi input mang token-Vacuum vào `backing_core`** (leak≡0 **cưỡng-chế**, không chỉ khai báo). LAMP-Vacuum chỉ vào `hard_cap-cứu` (cổng Schedule) + đỡ-peg-tạm, **KHÔNG vào backing-core**. Sim: cửa-rò `L_max = 0.373%C` cực mỏng (khi core khởi tạo sát trần lamp_frac0=0.325) → **commit-Vacuum ≤ 20% C_circ**.

- **F3 — chống Vacuum-cliff (Sev4):** **stagger BẮT BUỘC** — validator **cấm >X% commit cùng epoch đáo hạn** (tránh cliff khi rút đồng loạt) + `|Δcap|/epoch ≤ cap_surplus` + **KÈM cách-ly-cứng F1**. (`cap_surplus` là năng-lực-đệm, KHÔNG dùng chung biến với điều-kiện-kích — xem F4.)

- **Hỗ trợ Instant:** nâng cap-Instant tối đa lên **đúng trần-kép 0.5×Schedule, không hơn** (Vacuum chỉ "lấp khoảng trống" giữa cap_surplus và trần-kép). η=0.5 mặc định (η không đổi kết quả khi commit≥10%). **Kích hoạt theo ngưỡng `d ≥ d_vacuum`**, không thường-trực (commit lớn ở pool nông có thể lỗ ròng).

### §4.3 RedBack — đỡ-peg gián-tiếp (đa-token) **[VỮNG cấu trúc]** (trục PEG)
- Giữ **rổ đa-token đủ tiêu chí** (§4.6), KHÔNG LAMP/BTC/ETH/fiat. Khi peg-đỏ (`d ≥ d_red` TWAP, `d_red=4%` [DAO]) VÀ `br≥br_safe` → **BÁN tài sản rổ HÚT CARP rẻ** (nghiệp-vụ-thị-trường-mở, giảm C_circ tạm) → bán lại khi over-peg. **TUYỆT ĐỐI không rót tài sản RedBack vào GreenBack.**
- Quy mô ~**15% C_circ** [DAO]. Khi RedBack phình → trích CARP về MagicLamp Treasury.

- **F4 — sàn-cứng RedBack (gỡ deadzone peg→backing, Sev4):**
  - **Ranh GreenPeg↔RedPeg CHỒNG-LẤN-CÓ-CHỦ-ĐÍCH `[1.5, 1.6]`** thay ranh-cứng (xoá deadzone nơi cả hai đều "chờ").
  - **Sàn-cứng RedBack tính theo `C_circ`** (không theo cap_res co-về-0): cho **SÀN CỨNG ~8% NAV độc-lập-cap_res** khi peg-đỏ-sâu + `br≥br_safe` + `bad_debt=0` (hút CARP rẻ = market-op trung-lập-cung, không hại solvency).
  - **KHÔNG dùng chung một biến cho cả điều-kiện-kích (`d`) lẫn độ-lớn-năng-lực (`cap_res`/`C_circ`)** — đây là gốc của deadzone.
  - (Thay `cap_res(br)=0.25·clamp((br−1.5)/0.3)` cũ tê-liệt-đúng-lúc-cần bằng sàn-cứng-theo-C_circ.)

### §4.4 Quỹ độc lập (gián-tiếp, ngoài RedBack)
- **Rice-AladinWork** (LAMP mua CARP rẻ), **Treasury-Phoenix** (ADA/NIGHT mua CARP rẻ). **Mỗi quỹ mandate riêng, KHÔNG phối-hợp-điều-khiển-tập-trung.**

- **F5 — chống coordinated-ART (Sev3.5):**
  - **LỆCH-BIẾN:** RedBack đọc `P_CARP` / Rice đọc `ρ_LAMP` / Phoenix đọc `TWAP-dài`. Mỗi quỹ đọc tín-hiệu-khác → không đồng-pha thành issuer-mechanism-tập-trung.
  - **LỆCH-NGƯỠNG:** `gap ≥ 5%` giữa các ngưỡng-kích của từng quỹ.
  - **CẤM chia-sẻ-oracle-chung.**
  - → điều kiện để lập luận "market-participant tự-lợi" đứng vững (giảm ART, §8).

### §4.5 Sizing tổng (sim) **[VỮNG]**
- **panic-thiết-kế = 15% C_circ** (trần bảo vệ, tuyên bố công khai). Nền back **50% C_circ** cho sức-đỡ-thật ~32%C. Quy luật: **vốn-cam-kết ≈ 3.5×panic; sức-đỡ ≈ 2×panic**. **Trên ~18-20%C panic → sụp phi-tuyến** (mọi quỹ cạn trần đồng thời). WALL là **VỐN**, không phải tốc-độ → đừng tối ưu θ/κ/n chữa đuôi; tăng **CDP-open-depth + vốn-arb thật + throughput-tiêu-MAGIC**.

### §4.6 Tiêu chí tài sản rổ RedBack (DAO whitelist)
Đạt CẢ (dựa Resource-Taxonomy + tiêu chí độc-lập-LAMP):
1. **Giá-trị-sử-dụng cao / mô-hình-kinh-tế thật** (ADA: phí Cardano; NIGHT: DUST privacy; token-hệ: cầu-thật như FARM-bảo-hiểm-canh-tác).
2. **Phi tập trung, tỷ lệ thâu tóm thấp.**
3. **`ρ(token, LAMP) ≤ 0.3`** (đo TWAP ≥180 ngày — PHẢI ĐO, không giả định) **[VỮNG]**. Điểm gãy ρ*≈0.6 = "giả đa-dạng". **CẤM LAMP (ρ=1 → Terra).**
4. KHÔNG BTC/ETH/fiat/stablecoin-USD (giữ fiat-neutral + tránh tulip-FOMO).
- **Không chữa tương-quan bằng phình NAV** (sim: NAV 5%→40% chỉ nhích P(đỡ) 0.012→0.128) — ưu tiên tuyển token ρ-thấp.

### §4.7 THANG-NGƯỠNG-PEG-CÓ-THỨ-TỰ + HÀM-ĐIỀU-PHỐI-2-TRỤC **[chốt v0.3 — hàm thiếu quan trọng nhất]**

**Thang-ngưỡng-peg có thứ tự** (`d` = độ-lệch |P_CARP − P*|/P*, TWAP):
```
d_soft = 2%   <   d_red = 4%   <   d_vacuum = 6%   <   d_emergency
```

**Hai trục độc lập (gốc gỡ deadzone F4):**
- **Trục PEG:** `d` (độ-lệch-giá) → quyết định TẦNG-NÀO-KÍCH.
- **Trục SOLVENCY:** `br` (backing-ratio tuyến-phụ) → quyết định NĂNG-LỰC + có được phép hút-CARP không.

**Hàm điều phối** `dispatch(d, br)` (không trộn hai trục vào một biến):

| `d` | `br ≥ br_safe` (lành) | `br < br_safe` (đỏ) |
|---|---|---|
| `< d_soft` | Tuyến-0 arbitrage nội sinh | Tuyến-0 + theo dõi |
| `[d_soft, d_red)` | Tuyến-0 + utility-floor | utility-floor + cảnh báo |
| `[d_red, d_vacuum)` | **RedBack** (sàn-cứng 8%NAV) + utility-floor | **KHÔNG hút-peg bằng RedBack** (br đỏ) → chỉ utility-floor + chuẩn-bị Backstop |
| `[d_vacuum, d_emergency)` | **VacuumBack** (commit-khoá) + RedBack | VacuumBack (cách-ly-cứng F1) + Backstop-chuẩn-bị |
| `≥ d_emergency` | chuỗi-khẩn-cấp DAO-vote | **Backstop** (bad_debt) + chuỗi-khẩn-cấp |

- **Vùng chồng-lấn `[1.5, 1.6]` của `br`** (F4): GreenBack↔RedBack overlap-có-chủ-đích — không có khe `br` nào mà cả hai đều "chờ".
- **RedBack CHỈ hút-CARP khi `br≥br_safe`** (hút-CARP-rẻ khi br-đỏ = hại solvency → cấm). Khi br-đỏ, độ-lệch-giá xử bằng utility-floor (không tốn backing) + Backstop lo bad_debt.

---

## §4b. TUYẾN-PHỤ — CDP-LAMP (chuộc-ra-LAMP, g_min chỉ ở đây)

> **Định vị v0.3:** CDP-LAMP là **TUYẾN-PHỤ**, dành cho ai muốn **chuộc-ra-LAMP** (hoá-lỏng LAMP mà không bán trên DEX). Nó **tự-thanh-lý riêng** (thanh lý cá nhân, cô lập rủi ro về từng con nợ), **KHÔNG phải backing-core-toàn-CARP**. Đặc tả toán đầy đủ: `CARP-Math-Vi.md §3–§13, §16–§21`.

- **CDP mở:** khoá LAMP over-collateral → mint CARP. `MCR_base = 200%`, `LR = 130%`, NSF siết-khi-căng ∈[1.0,1.4] (chi tiết CARP-Math §4, §6, §7).
- **`g_min ≥ 67%` (lamp_frac ≤ 33%) CHỈ áp cho tuyến-phụ này** **[VỮNG cho tuyến-phụ]** — là điều-kiện giữ **tuyến-phụ-CDP** khỏi vòng-phản-hồi-LAMP, **KHÔNG phải backing-core-toàn-CARP**. (v0.2 nhầm g_min là backing-core → GỠ; xem CHỐT KIẾN TRÚC đầu file.)
- **Thanh lý:** partial 50% → Dutch Auction bám-TWAP-hiện-tại (CARP-Math §8). Bad_debt → **Backstop** (§4 tầng 5).
- **Vì sao CDP thay vì 2-coin (DJED-style):** ρ_LAMP nội-sinh (định-lý-DJED giả-định-giá-ngoại-sinh không áp được); ReserveCoin sinh-lời = Howey; 2-coin haircut-tập-thể hại người-không-đòn-bẩy. CDP cô-lập-rủi-ro về từng con nợ (CARP-Math §0).
- **Tuyến-phụ KHÔNG gánh peg-core:** peg giữ bởi **cầu-dịch-vụ-thực** (§3.1), không bởi backing-CDP. CDP-phụ chỉ (a) cho lối chuộc-ra-LAMP, (b) là trần-kỹ-thuật khi CARP>1 (§3.2), (c) nguồn arbitrage-đóng-nợ khi CARP<1 (§3.0).

---

## §5. BA CỬA GENMAGIC (thuật toán)

MAGIC gen qua 3 cửa; **mỗi MAGIC gắn MỘT dịch vụ cụ thể** (ScheduleGen-lưu-trữ chỉ tiêu lưu-trữ, không đặt-logo) → nhà cung cấp điều tiết nguồn lực, hệ nhịp nhàng.

### §5.1 PrepaidGen — trả trước (tự-back, không giới hạn)
- User khoá **X CARP** (hoặc tài sản tương ứng) → gen **X MAGIC**. CARP khoá chuyển vào **quỹ Paid của platform** cung dịch vụ đó.
- **KHÔNG rút GreenBack** (tự-back bằng chính CARP khoá) → **không giới hạn số lượng**.

- **F2 — chống Prepaid-default (Sev4):**
  - **`vesting_v = 0`** (escrow-theo-delivery — quỹ Paid nhả theo dịch-vụ-đã-giao, không trả trước cho provider).
  - **`claim_provider ≤ Σ MAGIC_burned_par`** (provider chỉ đòi được tối đa phần MAGIC đã-thực-đốt tương ứng).
  - **buffer-Paid ≥ 15%** (= panic-thiết-kế, đệm-thiết-kế).
  - **shortfall → Backstop, KHÔNG đụng LAMP.**
- Đây đồng thời là **sàn cứng peg** (§3.1) — cửa phổ quát, ai cũng dùng.

### §5.2 ScheduleGen — nắm LAMP + tiêu định kỳ tương lai (đối ứng GreenBack)
- Cam kết `pp` MAGIC/epoch × `N` epoch qua **cổng κ_eff** (§4.1). **LAMP ở-yên-ví** (tư-cách, không thế-chấp). Carry mua-LAMP-đáy ngược-chu-kỳ. Trần `pp`/epoch cứng (không rút-dồn).

### §5.3 InstantGen — nắm LAMP + tiêu ngay (đối ứng GreenBack)
- `M_instant = Σᵢ wᵢ·Lᵢ` — **tuổi-đời CHỈ gate tư-cách, KHÔNG nhân độ-lớn** **[VỮNG]** (mô hình cũ LF-nhân-size gãy: nhỏ-lâu vượt lớn-mới — vô lý).
- **Trần kép [VỮNG]:** `cap_instant = min( f·S·(br−br_safe)/br_safe , η·pp_schedule )`, **f ≤ 0.10** (điểm gãy f≥0.22 nơi Instant=Schedule), **η = 0.5** → Instant ≤ 0.5×Schedule mọi trạng thái → giữ nhịp-nhàng.
- Van đỏ tuyệt đối: `cap=0` khi `br≤br_safe` (đúc-khi-đỏ = 0).
- **Instant gắn nhóm-dịch-vụ** (rộng hơn Schedule 1-dịch-vụ, hẹp hơn any-service) [DAO xác nhận biên].
- **LAMP-hiện-tại là trục chính (trần tuyệt đối); tuổi-đời chỉ điều tiết tốc-độ/phí** — size vẫn trội, không cho nhỏ-vượt-lớn tuyệt đối.

### §5.4 Decay (theo LOẠI Gen)
- **Decay-window theo LOẠI Gen** (không bắt user chọn profile): Instant → dùng-ngay (rất ngắn); Schedule → tiêu-trong-kỳ; Prepaid → dài hơn (đã trả tiền) nhưng **có hạn** (không vô hạn → giữ consumptive-use). Nếu cần linh hoạt: gói-thời-hạn dễ hiểu ("30/90/365 ngày").

---

## §5b. CẤU TRÚC PHÂN-CẤP + REGISTRY-MỞ (giải ART look-through)

**Nguyên lý:** đỡ-peg đến từ **CẦU-KHÁCH-HÀNG** (Platform mua CARP vì **cần dịch vụ**), KHÔNG từ issuer-mechanism tập trung → nhẹ ART + phi-tập-trung-thật.

```
Ecosystem   MLF (DAO)  ──►  pháp-nhân-con vùng-sáng vận hành Carpet + RedBack  (= ISSUER)
                │
Platform    GreenSun(Rice) / PhoenixKey(Phoenix) / LampNet / OriLife   (= KHÁCH-HÀNG mua CARP vì cần dịch vụ)
                │
App         AladinContract(Aladin) / DDC(TonFarm)
                │
Registry-MỞ did:tiger / did:elephant · DePIN/Datacenter · chat Telegram/Zalo
            (miễn: TIÊU-MAGIC + DÙNG-CARP + ĐĂNG-KÝ)
```

- **Ecosystem = MLF (DAO)** → pháp-nhân-con vùng-sáng vận hành **Carpet + RedBack** (= issuer duy nhất chịu vai phát-hành).
- **Platform = khách-hàng** (GreenSun/Rice, PhoenixKey/Phoenix, LampNet, OriLife) — **mua CARP vì cần dịch vụ**, KHÔNG phải issuer. Đây là nguồn **cầu-thực đỡ-peg** (§3.1).
- **App** = AladinContract/Aladin, DDC/TonFarm.
- **Registry-MỞ:** did:tiger/did:elephant, DePIN/Datacenter, chat Telegram/Zalo — **bất kỳ ai đăng-ký đều vào được**, miễn thoả 3 điều: **tiêu-MAGIC + dùng-CARP + đăng-ký**. Mở → phi-tập-trung-thật (không phải hệ đóng một-issuer-điều-khiển-tất-cả).
- **Hệ quả pháp lý (§8):** đỡ-peg = **cầu-khách-hàng phân-tán** (không issuer-mechanism) → làm **NHẸ ART** (không thoát) + chống look-through "một-thực-thể-điều-khiển".

---

## §6. THAM SỐ (tinh gọn)

**[VỮNG] — khoá vào spec/hiến pháp:**
| Tham số | Giá trị | Nguồn |
|---|---|---|
| lamp_frac (LAMP trong **tuyến-phụ-CDP**) | **≤ 33%** (g_min≥67% **chỉ-tuyến-phụ**) | sim flash-crash |
| br_safe / br_healthy | 1.5 / 1.8 | sim |
| InstantGen f | **≤ 0.10** | điểm gãy f≥0.22 |
| InstantGen η (trần-kép) | 0.5 | sim |
| M_instant | Σwᵢ·Lᵢ, tuổi chỉ-gate | sim |
| ρ token rổ RedBack | **≤ 0.3** (TWAP≥180 ngày) | sim đa-dạng-hoá |
| κ_eff sàn | 0.43 (đệm ~2.3× khi stress) | sim vốn-đệm |
| panic-thiết-kế | 15% C_circ (trần công khai) | sim sizing |
| commit-Vacuum | ≤ 20% C_circ + stagger (F3) | sim leak* (L_max=0.373%C) |
| buffer-Paid (F2) | ≥ 15% C | panic-thiết-kế |
| pool CARP | ~20% C_circ | sim nghịch-lý-pool |
| RCR reward-CARP (INV-5) | **3.0×** | sim reward-solvency |

**Thang-ngưỡng-peg [DAO]:** `d_soft=2% < d_red=4% < d_vacuum=6% < d_emergency` (§4.7).

**[DAO] — cần đo thực địa / điều chỉnh:**
- `throughput` tiêu dịch vụ MAGIC/epoch (mục tiêu ≥5%C + pull-forward ~3× — **BENCHMARK THỰC ĐỊA trước khi cam kết**).
- `κ_eff` a,b (theo σ̂ EWMA-có-trễ, một-nguồn-tín-hiệu). `d_red`=4%, `d_vacuum`=6%, RedBack~15%C, sàn-cứng RedBack~8%NAV.
- `κ_reward` per-loại (hàm-lõm-phí, cap-per-DID — §1b, §14b-math).

### §6.1 TINH-GỌN THAM SỐ (chốt v0.3)
- **BỎ `MCR_floor = 1.35`** (hằng-số-chết — vì MCR_eff ≥ 2.0 luôn > LR=1.30, không bao giờ ràng buộc). Giữ nguyên `MCR_base=2.0`, `LR=1.30` cho tuyến-phụ.
- **MỘT-NGUỒN-TÍN-HIỆU-STRESS:** `σ̂` + `br` tính **1 lần**, feed CẢ NSF (tuyến-phụ) LẪN κ_eff (GreenBack). Không tính stress hai đường mâu thuẫn.
- **SỬA lỗi số:** fee-distribution — **giữ bậc-thang §13.2 của CARP-Math** (bỏ bảng 60/25/10/5 mâu-thuẫn). INV-5 số **"3.0×"** (sửa "2.5×" ở §21.3/Phụ-lục B của CARP-Math cũ — bản chuẩn là 3.0×/300%).
- **ĐỔI TÊN `Insurance → Backstop`** (đệm-nội-bộ-không-bán-bảo-hiểm, tránh hàm ý "bán bảo hiểm").

---

## §6b. BẢNG-ÁNH-XẠ TỪ-VỰNG (đối chiếu 2 file)

Hai file dùng tên khác nhau cho cùng khái niệm. Bảng chuẩn hoá:

| Đặc-tả (file này) | CARP-Math-Vi.md | Ý nghĩa |
|---|---|---|
| **GreenBack** | **GreenPeg** | phía backing thụ động (solvency), độc-quyền mint/burn |
| **RedBack** | **RedPeg** | lớp đệm giá chủ động, quỹ vệ tinh, trung-lập-cung |
| **Backstop** | **Insurance Pool (IP)** | đệm bad_debt nội-bộ (đổi tên §6.1) |
| **br** | **H** (per-CDP) / backing-ratio | tỷ-lệ-thế-chấp / sức-khoẻ |
| **RCR** | **RCR** | Reward Collateral Ratio = 3.0× (reward-CARP) |
| **d (độ-lệch-peg)** | `d_internal` / CARP_premium | độ-lệch |P_CARP−P*|/P* |
| **utility-floor** | PrepaidGen 1:1 + PSM-par | sàn-cứng cầu-dịch-vụ-thực |
| **Tuyến-phụ CDP** | §0–§13 CDP-core | chuộc-ra-LAMP, g_min-chỉ-đây |

---

## §6c. ĐẶC-TẢ THROUGHPUT (biến sống-còn của utility-floor)

Peg-core giữ bởi **throughput tiêu-dịch-vụ MAGIC/epoch**. Đặc tả:

- **Định nghĩa:** `throughput = Σ MAGIC_burned_thật / epoch` (đo qua burn-ID, §14b-math).
- **Điều kiện sàn-không-gãy:** `throughput × Δt ≥ panic-CARP-tuyệt-đối`. Sàn utility-floor gãy CHỈ khi panic vượt năng-lực-tiêu trong cửa-sổ-thời-gian.
- **Mục tiêu vận hành [DAO]:** `throughput ≥ 5% C_circ/epoch` + khả-năng pull-forward ~3× (tiêu-trước dịch-vụ tương-lai khi CARP rẻ).
- **Nguồn throughput = cầu-khách-hàng-Platform** (§5b): Platform tiêu MAGIC vì cần dịch-vụ-thật → throughput cao ⟺ hệ khoẻ.
- **BENCHMARK THỰC ĐỊA BẮT BUỘC trước genesis** — chưa đo (§9 điểm-mở #1).
- **Đo on-chain:** GlobalState track `magic_burned_this_epoch` (thread); off-chain cộng tổng theo burn-ID.

---

## §7. BẤT BIẾN (FIREWALL)

| Mã | Nội dung |
|---|---|
| **F-TÀI-SẢN'** | CARP trong kho quỹ KHÔNG đếm backing/br/NAV. |
| **INV-NO-PASSIVE-YIELD** | Không khoản nào chảy ra holder-theo-số-dư. Phí ≠ lãi. |
| **INV-MAGIC-CITIZEN** | Mọi hàm reward/VP/ưu-đãi PHẢI chứa biến MAGIC-tiêu-thực; CẤM keyed thuần vào holding (§1b). |
| **INV-NO-LAMP-PEG-DEFENSE** | TUYỆT ĐỐI không đỡ-peg bằng LAMP (vòng tự-hủy — sim). |
| **INV-LAMP-CORE-CAP** | lamp_frac **tuyến-phụ-CDP** ≤ 33%, thực thi CỨNG on-chain (không chỉ khai báo). **g_min chỉ áp tuyến-phụ, KHÔNG áp CARP-core.** |
| **INV-VACUUM-ISOLATION** (F1) | LAMP-Vacuum ở UTxO/policy riêng; validator-core TỪ CHỐI mọi input mang token-Vacuum vào backing_core (leak≡0 **cưỡng-chế**). |
| **INV-PEG-ENDO** | P*=1 nội sinh, oracle-free ở chuộc-par. |
| **INV-PEG-BY-DEMAND** | Peg-core giữ bởi **cầu-dịch-vụ-thực** (utility-floor), KHÔNG bởi rổ-tài-sản/backing-CDP. |
| **F2-CARP→MAGIC-FRICTION** | CARP→MAGIC một chiều, cam-kết-tiêu gắn-DID, không đổi 1:1 tự do qua lại. |
| **INV-REDBACK-DIVERSE-NEUTRAL** | Rổ RedBack ρ≤0.3, không LAMP, không fiat; đệm là công-cụ-bình-ổn KHÔNG cam-kết-chuộc-giá-rổ. |
| **INV-NO-EXTERNAL-INPUT** | Cổng/ngưỡng solvency chỉ căn số-dư-nội-bộ, không giá-thị-trường điều khiển. |
| **INV-FUNDS-INDEPENDENT** (F5) | Các quỹ đỡ-peg lệch-biến + lệch-ngưỡng (gap≥5%) + cấm oracle-chung; không phối-hợp-điều-khiển-tập-trung. |
| **INV-2-AXIS** | Điều-phối đọc HAI trục độc lập (PEG=`d` / SOLVENCY=`br`); cấm dùng chung một biến cho điều-kiện-kích lẫn độ-lớn-năng-lực (§4.7, F4). |
| **F-LANG** | Cấm tự gọi "stablecoin/algorithmic/yield/fund/đầu-tư". Đổi Insurance→Backstop. |

---

## §8. CƠ SỞ PHÁP LÝ — TRUNG THỰC (không hứa "thoát ART")

- **EMT:** CARP **fiat-neutral** (neo sức-mua-dịch-vụ, không USD, không giá-tài-sản) → **thoát EMT**. ✓
- **ART:** ART = "maintain stable value by referencing **any value/right/basket**". CARP có cơ-chế-ổn-định → **rủi ro bị phán ART VẪN CÒN**. Utility-floored + CDP-phụ-nhỏ + đỡ-peg-cầu-khách-hàng làm **NHẸ nhưng KHÔNG thoát**:
  - (a) peg-core = **cầu-dịch-vụ-THỰC** (không rổ-ngoại-sinh-tham-chiếu) → khác backing-chuộc-rổ điển-hình;
  - (b) đỡ-peg = **CẦU-KHÁCH-HÀNG phân-tán** (Platform mua CARP vì cần dịch-vụ, §5b) — không phải issuer-mechanism tập trung;
  - (c) quỹ đỡ-peg **lệch-biến/lệch-ngưỡng** (F5) → không đồng-pha thành issuer đơn;
  - (d) không-marketing-stable; **geofence EU mặc định** + chờ **luật-sư MiCA**.
  - **KHÔNG ghi "Title II nhẹ / nhẹ hơn USDC / thoát ART".**
- **VacuumBack:** chỉ-**giảm-phí-không-lãi** (ưu-đãi = quyền-tiêu-thêm non-transferable, keyed-MAGIC) → **không-securities**.
- **Backstop:** = **đệm-nội-bộ-không-bán-bảo-hiểm** (không phát-hành hợp-đồng-bảo-hiểm ra ngoài).
- **Registry-MỞ + cấu-trúc-phân-cấp (§5b):** issuer = pháp-nhân-con-MLF vận-hành Carpet+RedBack; Platform/App/Registry là **khách-hàng phân-tán** → chống look-through "một-thực-thể-điều-khiển-tất-cả".
- **Mỹ:** thoát GENIUS (không neo monetary-value) nhưng về **Howey-4 + khả năng CFTC**. Giảm: phân-phối-không-bán, không-đầu-cơ, FinCEN MSB + MTL nếu mở.
- **VN/vùng xám:** geofence CARP; người vùng xám dùng MAGIC qua bộ-đệm-app-vùng-sáng.
- **So sánh USDC:** CARP **khác** USDC (thoát EMT/yield, gánh ART/Howey-4) — **đánh đổi**, không "nhẹ hơn".

---

## §9. ĐIỂM MỞ (trước khi khoá số cuối)
1. **Benchmark throughput dịch vụ MAGIC thực địa** (§6c) — biến sống-còn của sàn utility-floor; chưa đo.
2. **Phân phối panic_frac thực địa** — trục nhạy #1; số 15%C phụ thuộc giả định.
3. Chạy lại κ_eff với σ̂ EWMA-lag (một-nguồn) + so cùng-vốn-đệm + thực thi lamp-cap-tuyến-phụ + cưỡng-chế F1 (leak≡0).
4. Một run tích-hợp utility-floor + PSM + 3-back + quỹ + hàm-điều-phối-2-trục (§4.7) đồng thời (đo tổng-lực-đỡ + kiểm deadzone đã gỡ).
5. Genesis CARP + tham số quỹ Paid (buffer≥15%, escrow-delivery F2) + biên nhóm-dịch-vụ Instant + trọng-số rổ-dịch-vụ (§2.2).
6. Ý kiến luật sư MiCA về ranh ART trước khi mở EU (utility-floored có làm nhẹ đủ không).
7. Chốt `κ_reward` per-loại (hàm-lõm-phí, cap-per-DID) + ngưỡng bão-hoà VP (§1b).

---

> **Ghi chú nhất quán:** đè phần CARP-cũ trong /CARP (CDP-300%-backing-core/RedCheque/neo-USD lỗi thời) + phần "thoát ART" + phần "g_min-backing-core-toàn-CARP" của v0.2. `CARP-Math-Vi.md` là đặc-tả-toán **tuyến-phụ-CDP** (không phải backing-core-toàn-CARP) — đọc kèm bảng-ánh-xạ §6b. Khi mâu thuẫn về CARP/ổn-định/tuyến-chính → theo file này.
