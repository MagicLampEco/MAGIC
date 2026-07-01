# Đặc tả Thực thi Carpet (CARP) — Vận hành, Genesis & Lộ trình

> Trạng thái: **ĐỀ XUẤT** (draft **v0.1-excu**, chờ duyệt). Cập nhật 2026-07-01.
> Đây là **đặc-tả-thực-thi (execution)** — đi kèm và **phục tùng tuyệt đối** `Carpet-CARP-DacTa-Vi.md` (v0.3, nguồn chân lý về thiết kế) + `CARP-Math-Vi.md` (đặc-tả-toán tuyến-phụ-CDP).
> Phạm vi file này: **lộ trình triển khai, genesis CARP, tham số khởi tạo, kịch bản vận hành từng epoch, quy trình DAO chỉnh tham-số-[DAO], quy mô triển khai VN, checklist trước genesis.**
> Quy ước: **[VỮNG]** = sim đã kiểm, khoá; **[DAO]** = đo thực địa / DAO điều chỉnh; **[GENESIS]** = phải chốt số trước khi phát-hành.
> KHÔNG đề cập MagicChange. KHÔNG hứa "thoát ART". Mọi số phải nhất quán Carpet-v0.3 §6 (bảng tham số) + khung đã chốt.

---

## §0. Nguyên tắc thực thi (đọc trước)

1. **File này KHÔNG định nghĩa lại thiết kế.** Mọi khái niệm/tham số/bất-biến tra ở `Carpet-CARP-DacTa-Vi.md`. File này chỉ trả lời **"làm thế nào, theo trình tự nào, với số khởi tạo nào"**.
2. **Không phát-hành trước khi checklist §9 xanh hết** — đặc biệt 2 blocker: (a) benchmark throughput tiêu-MAGIC thực địa (§6c-DacTa), (b) ý-kiến-luật-sư-MiCA về ranh ART.
3. **Ba trạng thái phát-hành:** `PRE-GENESIS` (chưa có CARP nào) → `SHADOW` (CARP tồn tại nhưng geofence + hạn-mức, chỉ vùng-sáng nội bộ) → `LIVE` (mở registry). Mỗi bước lên trạng thái cần một cổng-duyệt (§1).
4. **Không đỡ-peg bằng LAMP** ở mọi kịch bản vận hành (`INV-NO-LAMP-PEG-DEFENSE`). Không hàm reward/VP nào keyed vào holding (`INV-MAGIC-CITIZEN`).
5. **Đo trước, cam kết sau.** Mọi số [DAO] trong file này là **giá-trị-khởi-tạo-đề-xuất**, phải xác nhận bằng số-đo-thật (§8, §9) rồi mới khoá.

---

## §1. LỘ TRÌNH TRIỂN KHAI (5 pha, có cổng-duyệt)

Mỗi pha kết thúc bằng một **cổng-duyệt** (gate). Không qua cổng → không sang pha sau.

### Pha 0 — PRE-GENESIS (chuẩn bị, chưa có token)
- **Việc:** hoàn tất `Carpet-CARP-DacTa-Vi.md` v0.3 + `CARP-Math-Vi.md` + `Carpet-Excu-Vi.md`; dựng testnet Preview validator (CDP-phụ, GreenBack, PrepaidGen, PSM-par); viết bộ sim tích-hợp (§9 điểm-mở #4).
- **Cổng 0 → 1 (BENCHMARK):** benchmark throughput tiêu-MAGIC thực địa đạt ngưỡng đo được (không cần đạt mục-tiêu 5%C, chỉ cần **có số thật để hiệu chỉnh**) + sim-tích-hợp chạy không phát hiện deadzone (§4.7-DacTa) + validator cưỡng-chế F1 (leak≡0) pass on-chain test.

### Pha 1 — GENESIS (đúc lô CARP đầu, geofence tuyệt đối)
- **Việc:** khởi tạo GlobalState (§2), nạp quỹ khởi-tạo (§3), mở PrepaidGen + PSM-par, KHÔNG mở CDP-phụ công khai (chỉ nội bộ để test trần §3.2-DacTa).
- **Trạng thái token:** `SHADOW` — CARP chỉ lưu-thông trong pháp-nhân-con-MLF + Platform vùng-sáng (OriLife, AladinWork, LampNet). Geofence EU + VN-vùng-xám cứng.
- **Cổng 1 → 2 (SÀN-GIỮ):** quan sát ≥8 epoch: utility-floor kéo CARP về mép `1−(phí+gas)` không đụng LAMP; buffer-Paid ≥15% giữ vững; không bad_debt.

### Pha 2 — SHADOW-MỞ-RỘNG (thêm CDP-phụ + Vacuum, vẫn geofence)
- **Việc:** mở CDP-phụ (tuyến-phụ, `MCR_base=200%`, `LR=130%`, `g_min≥67%`); bật VacuumBack (commit ≤20%C, stagger F3); bật RedBack với rổ token ρ≤0.3 đã đo TWAP≥180 ngày.
- **Cổng 2 → 3 (STRESS):** chạy ≥1 kịch-bản-stress thực (panic mô-phỏng ~10%C): 3-back + quỹ-độc-lập đỡ đúng theo hàm-điều-phối-2-trục (§4.7-DacTa); F1 leak đo được ≡0; VacuumBack không cliff (F3).

### Pha 3 — LIVE-VN (mở registry vùng-sáng VN)
- **Việc:** mở registry cho did:tiger/did:elephant + Platform/App VN (§5b-DacTa); triển khai quy mô 100-nông-dân (§7); geofence EU vẫn giữ.
- **Cổng 3 → 4 (PHÁP-LÝ):** có **ý-kiến-luật-sư-MiCA** bằng văn bản về ranh ART; FinCEN/MTL nếu chạm Mỹ; xác nhận VacuumBack = giảm-phí-không-lãi (non-securities), Backstop = đệm-nội-bộ.

### Pha 4 — LIVE-MỞ (bỏ geofence theo vùng luật-sư duyệt)
- **Việc:** mở registry rộng theo từng vùng-tài-phán luật-sư đã duyệt; mở EU CHỈ nếu MiCA-ART được đánh giá tuân-thủ-được hoặc geofence-EU giữ vĩnh viễn.
- **Bất biến:** không marketing "stable"; không tự gọi stablecoin/algorithmic/yield/fund (`F-LANG`).

---

## §2. GENESIS CARP — khởi tạo GlobalState

### §2.1 Nguyên tắc genesis
- **CARP genesis KHÔNG đúc-sẵn-lưu-thông.** CARP chỉ ra đời qua **Mint có backing** (PrepaidGen khoá CARP đối-ứng, hoặc CDP-phụ over-collateral). Không airdrop, không pre-mint bán ra (chống Howey, §8-DacTa).
- **`C_circ` khởi tạo = 0.** Cung lưu-thông lớn dần theo cầu-thực (PrepaidGen của Platform-khách-hàng).
- **Quỹ khởi-tạo (§3) nạp trước** để 3-back + Backstop có năng-lực ngày-đầu, nhưng **CARP trong kho quỹ KHÔNG đếm backing** (`F-TÀI-SẢN'`).

### §2.2 GlobalState datum khởi tạo **[GENESIS]**
Tham chiếu cấu trúc: `CARP-Math-Vi.md §5.2 GlobalState Datum`. Giá-trị khởi tạo:

| Trường | Giá trị genesis | Ghi chú |
|---|---|---|
| `C_circ` (CARP lưu-thông) | 0 | lớn dần theo Mint-có-backing |
| `base_price` | 1 nanogic = 1 KB·ngày (hoặc 3 KB·ngày nếu chọn 1 CARP≈$1) | §2.1-DacTa; chốt ở Cổng-genesis |
| `P*` | 1 | neo nội sinh, oracle-free |
| `magic_burned_this_epoch` | 0 | thread đo throughput (§6c-DacTa) |
| `epoch_index` | 0 | |
| `br` (backing-ratio tuyến-phụ) | n/a (chưa có CDP) | tính khi CDP-phụ mở (Pha 2) |
| `br_safe / br_healthy` | 1.5 / 1.8 | [VỮNG] |
| lamp_frac (tuyến-phụ-CDP) | 0 (chưa CDP), trần ≤33% | [VỮNG] g_min≥67% chỉ-tuyến-phụ |

### §2.3 Numéraire genesis — chốt đơn-vị
- **Quyết định phải chốt ở Cổng-genesis:** `1 nanogic = 1 KB·ngày` (→ 1 CARP=1 TB·ngày ≈ $0.33, ~3 CARP≈1 USD) **HAY** `1 nanogic = 3 KB·ngày` (→ 1 CARP ≈ $1).
- **Đề xuất khởi tạo:** dùng **rổ-dịch-vụ** (storage+định-danh+compute+lao-động, §2.2-DacTa) làm base_price ngay từ genesis để trung-hoà deflation storage, với trọng-số khởi tạo do DAO đặt (§4 file này). Nếu chưa kịp dựng rổ → tạm dùng storage-thuần, chuyển sang rổ ở quý đầu.
- **KHÔNG đọc oracle USD** để chốt — chỉ dùng USD làm **tham chiếu-cảm-nhận** khi truyền thông, không vào cơ chế.

---

## §3. THAM SỐ KHỞI TẠO QUỸ & CƠ CHẾ

Toàn bộ số dưới đây **phải khớp Carpet-v0.3 §6**. Cột "khởi tạo" là giá-trị-nạp-ngày-đầu; cột "loại" cho biết khoá hay đo-thực-địa.

### §3.1 Quỹ back (nạp theo % C_circ mục-tiêu-vận-hành)
> Ngày genesis `C_circ=0` nên quỹ nạp theo **C_circ dự-phóng pha-đầu** (đề xuất mốc 100k CARP cho Pha 3-VN, §7), rồi tái-cân theo C_circ thực mỗi epoch.

| Quỹ/cơ chế | Mức khởi tạo | Loại | Nguồn tham số |
|---|---|---|---|
| Nền back tổng | 50% C_circ (sức-đỡ-thật ~32%C) | [VỮNG] | §4.5-DacTa |
| panic-thiết-kế (trần công khai) | 15% C_circ | [VỮNG] | §4.5-DacTa |
| GreenBack đệm (κ_eff) | κ_eff∈[0.43, 0.6], sàn 0.43 | [VỮNG] | §4.1-DacTa |
| VacuumBack commit-cap | ≤ 20% C_circ + stagger (F3) | [VỮNG] | §4.2-DacTa |
| RedBack rổ đa-token | ~15% C_circ, sàn-cứng ~8%NAV | [DAO] | §4.3-DacTa |
| buffer-Paid (quỹ Paid platform) | ≥ 15% C | [VỮNG] | F2, §5.1-DacTa |
| pool CARP (thanh khoản) | ~20% C_circ (KHÔNG sâu hơn) | [VỮNG] | §3.3-DacTa nghịch-lý-pool |
| Backstop (bad_debt) | nạp đủ phủ bad_debt dự-phóng | [DAO] | §4 tầng-5-DacTa |

### §3.2 Cơ chế Gen & CDP-phụ
| Tham số | Giá trị | Loại | Nguồn |
|---|---|---|---|
| PrepaidGen tỷ lệ | 1 CARP khoá → 1 MAGIC | [VỮNG] | §5.1-DacTa |
| PrepaidGen vesting_v (F2) | 0 (escrow-theo-delivery) | [VỮNG] | F2 |
| claim_provider trần (F2) | ≤ Σ MAGIC_burned_par | [VỮNG] | F2 |
| InstantGen f | ≤ 0.10 | [VỮNG] | §5.3-DacTa |
| InstantGen η (trần-kép) | 0.5 (Instant ≤ 0.5×Schedule) | [VỮNG] | §5.3-DacTa |
| M_instant | Σwᵢ·Lᵢ (tuổi chỉ-gate tư-cách) | [VỮNG] | §5.3-DacTa |
| CDP-phụ MCR_base | 200% | [VỮNG] | CARP-Math §4 |
| CDP-phụ LR | 130% | [VỮNG] | CARP-Math §6 |
| CDP-phụ g_min (lamp_frac) | ≥67% (≤33% LAMP) — CHỈ tuyến-phụ | [VỮNG] | §4b-DacTa |
| NSF siết-khi-căng | ∈[1.0, 1.4] | [VỮNG] | CARP-Math §4 |
| RCR reward-CARP (INV-5) | 3.0× | [VỮNG] | §6-DacTa (sửa 2.5×→3.0×) |
| ρ token rổ RedBack | ≤ 0.3 (TWAP≥180 ngày, PHẢI ĐO) | [VỮNG] | §4.6-DacTa |

> **BỎ `MCR_floor=1.35`** (hằng-số-chết, §6.1-DacTa). Chỉ giữ `MCR_base=2.0`, `LR=1.30`.

### §3.3 Thang-ngưỡng-peg (điều phối 2 trục) **[DAO khởi tạo]**
```
d_soft = 2%  <  d_red = 4%  <  d_vacuum = 6%  <  d_emergency
```
- Vùng chồng-lấn `br ∈ [1.5, 1.6]` (GreenBack↔RedBack overlap, F4).
- Hàm `dispatch(d, br)` khởi tạo **đúng bảng §4.7-DacTa** — cài nguyên, không sửa.

### §3.4 Một-nguồn-tín-hiệu-stress
- `σ̂` (EWMA-có-trễ) + `br` tính **1 lần/epoch**, feed CẢ NSF (CDP-phụ) LẪN κ_eff (GreenBack). Không tính stress hai đường mâu thuẫn (§6.1-DacTa).

---

## §4. QUY TRÌNH DAO CHỈNH THAM-SỐ-[DAO]

> Chỉ tham số gắn **[DAO]** được chỉnh. Tham số **[VỮNG]** khoá vào hiến-pháp — sửa cần hard-fork + siêu-đa-số (không phải quy trình thường).

### §4.1 Danh mục tham-số-[DAO] có thể chỉnh
- `base_price` / trọng-số rổ-dịch-vụ (§2.2-DacTa).
- `κ_eff` hệ-số `a, b` (theo σ̂ EWMA).
- Ngưỡng peg: `d_red`, `d_vacuum` (giữ thứ tự `d_soft<d_red<d_vacuum<d_emergency`).
- RedBack: quy-mô ~15%C, sàn-cứng ~8%NAV, whitelist token rổ.
- `throughput` mục-tiêu, `κ_reward` per-loại (hàm-lõm-phí, cap-per-DID), ngưỡng bão-hoà VP.
- Gói-thời-hạn decay ("30/90/365 ngày", §5.4-DacTa).

### §4.2 Ràng buộc chống-thao-túng (cứng, không DAO gỡ được)
- **base_price / trọng-số-rổ:** thay đổi **≤10%/lần, ≥1 quý/lần** (chống stale-price + thao-túng, CARP-Math §1.2b). Cưỡng-chế on-chain.
- **Thang-ngưỡng-peg:** DAO chỉ chỉnh giá-trị, KHÔNG đổi **thứ tự** (`d_soft<d_red<d_vacuum<d_emergency` là bất-biến cấu trúc).
- **Whitelist rổ RedBack:** token mới phải đo `ρ(token,LAMP)≤0.3` bằng TWAP≥180 ngày **trước** khi vote; CẤM LAMP/BTC/ETH/fiat/stablecoin-USD (`INV-REDBACK-DIVERSE-NEUTRAL`).
- **VP quản-trị:** cử-tri = cá-nhân (PhoenixKey DID sinh-trắc), **KHÔNG token-weighted**; VP bão-hoà-ngưỡng theo tiêu-MAGIC cross-DID (§1b-DacTa). Không mua thêm quyền-vote bằng vốn.

### §4.3 Quy trình vote (5 bước)
1. **Đề xuất** — nêu tham-số, giá-trị-cũ→mới, lý-do neo 4-trục (dài-hạn / first-principles / tối-ưu eUTXO-ExUnit-phí-đơn-giản / lợi-ích-user-bền-vững). Ghi lý do vào spec/report.
2. **Kiểm bất-biến** — validator/kiểm-tra-tự-động bác nếu vi phạm §4.2 hoặc chạm tham-số-[VỮNG].
3. **Thời-gian-chờ (timelock)** — công bố công khai trước khi có hiệu lực (chống vote-nhanh-rút-vốn).
4. **Vote DID** — bão-hoà-ngưỡng, không token-weighted.
5. **Áp on-chain** — cập nhật GlobalState/PriceParam; log thay-đổi + lý-do để đối-chiếu.

### §4.4 Van-khẩn-cấp (emergency)
- `d ≥ d_emergency`: chuỗi-khẩn-cấp DAO-vote (§4.7-DacTa hàng cuối). Có thể tạm-đóng Mint-mới, KHÔNG được đỡ-peg-bằng-LAMP, KHÔNG được rút tài-sản-RedBack vào GreenBack.

---

## §5. KỊCH BẢN VẬN HÀNH TỪNG EPOCH (runbook)

> Mỗi epoch, hệ chạy vòng-lặp cố định. Mọi ngưỡng đọc **TWAP** (không tick tức-thời) để chống thao-túng nhất-thời.

### §5.1 Vòng-lặp chuẩn mỗi epoch (theo thứ tự)
1. **Đo tín-hiệu (1 lần):** tính `σ̂` (EWMA-có-trễ) + `br` (backing-ratio tuyến-phụ) + `d` (độ-lệch-peg TWAP) + `magic_burned_this_epoch` (throughput). Feed NSF + κ_eff từ **cùng nguồn** (§3.4).
2. **Cập nhật κ_eff:** `κ_eff = clamp(0.6 − a·σ̂ − b·max(0, br_safe−br), 0.43, 0.6)`.
3. **Điều phối 2 trục:** chạy `dispatch(d, br)` (§3.3) → xác định tầng-nào-kích. **Không tầng nào được đọc chung một biến cho điều-kiện-kích lẫn độ-lớn-năng-lực** (`INV-2-AXIS`).
4. **Xử lý Gen:** PrepaidGen (tự-back, không rút GreenBack); ScheduleGen/InstantGen qua cổng κ_eff; ghi `magic_burned` khi MAGIC bị tiêu (burn-ID).
5. **Xử lý CDP-phụ:** kiểm H per-CDP; H dưới ngưỡng → partial-50% → Dutch-Auction bám-TWAP; bad_debt → Backstop (KHÔNG LAMP).
6. **Tái-cân quỹ:** back về ~50%C; pool về ~20%C; RedBack phình → trích CARP về MLF Treasury; buffer-Paid giữ ≥15%.
7. **Ghi sổ:** log throughput, br, κ_eff, các tầng đã kích + lý-do; reset `magic_burned_this_epoch=0` sau khi cộng-tổng off-chain theo burn-ID.

### §5.2 Kịch bản A — CARP dưới peg (`d>0` giá thấp)
| `d` | `br≥br_safe` | `br<br_safe` |
|---|---|---|
| `<d_soft` (2%) | Tuyến-0 arbitrage nội-sinh (user mua CARP rẻ burn đóng nợ / PrepaidGen tiêu dịch-vụ) | Tuyến-0 + theo dõi |
| `[d_soft, d_red)` | Tuyến-0 + utility-floor (PrepaidGen 1:1, PSM-par) | utility-floor + cảnh báo |
| `[d_red, d_vacuum)` | **RedBack** hút CARP rẻ (sàn-cứng 8%NAV) + utility-floor | **KHÔNG hút bằng RedBack** (br đỏ) → chỉ utility-floor + chuẩn-bị Backstop |
| `[d_vacuum, d_emergency)` | **VacuumBack** (commit-khoá, cách-ly-cứng F1) + RedBack | VacuumBack + Backstop-chuẩn-bị |
| `≥d_emergency` | chuỗi-khẩn-cấp DAO | **Backstop** + chuỗi-khẩn-cấp |

> **Ưu tiên tuyệt đối:** utility-floor (cầu-dịch-vụ-thực) gánh phần lớn. RedBack/Vacuum chỉ vào khi utility-floor không kịp. **Không đụng LAMP** ở mọi ô.

### §5.3 Kịch bản B — CARP trên peg (`d<0` giá cao)
- Mint CARP mới qua CDP-phụ bán ra → tăng cung kéo xuống (§3.2-DacTa). Round-trip chịu phí-giao-dịch (không lãi).
- Không cần động quỹ back (trần là cơ-chế-cung, không phải cơ-chế-vốn).

### §5.4 Kịch bản C — VacuumBack đáo hạn (chống cliff, F3)
- **Stagger BẮT BUỘC:** validator cấm >X% commit **cùng epoch đáo hạn**. Nếu nhiều commit trùng epoch → tự-dời rải theo hàng-đợi.
- `|Δcap|/epoch ≤ cap_surplus` — năng-lực-đệm giới hạn tốc-độ rút; KÈM cách-ly-cứng F1 (LAMP-Vacuum không vào backing_core).

### §5.5 Kịch bản D — stress phối-hợp (chống coordinated-ART, F5)
- Các quỹ đỡ-peg **lệch-biến** (RedBack đọc `P_CARP` / Rice đọc `ρ_LAMP` / Phoenix đọc `TWAP-dài`) + **lệch-ngưỡng** (`gap≥5%`) + **CẤM oracle-chung**.
- Nếu phát hiện quỹ đồng-pha (dấu-hiệu issuer-mechanism-tập-trung) → cảnh báo DAO, KHÔNG tự-động phối-hợp.

### §5.6 Bảng-kiểm cuối mỗi epoch (invariant guard)
- [ ] Không input mang token-Vacuum vào backing_core (F1, leak≡0).
- [ ] lamp_frac tuyến-phụ ≤33% (INV-LAMP-CORE-CAP).
- [ ] Không khoản nào chảy ra holder-theo-số-dư (INV-NO-PASSIVE-YIELD).
- [ ] Mọi reward/VP chứa biến MAGIC-tiêu-thực (INV-MAGIC-CITIZEN).
- [ ] Không đỡ-peg bằng LAMP (INV-NO-LAMP-PEG-DEFENSE).
- [ ] CARP-trong-kho-quỹ không đếm backing (F-TÀI-SẢN').
- [ ] base_price không đổi quá 10%/quý.

---

## §6. THEO DÕI & CẢNH BÁO (observability)

### §6.1 Chỉ số phải track on-chain
- `C_circ`, `br`, `κ_eff`, `d` (TWAP), `magic_burned_this_epoch`, lamp_frac-tuyến-phụ, buffer-Paid, bad_debt, quy-mô từng quỹ back.
- **throughput** (§6c-DacTa): `Σ MAGIC_burned_thật / epoch` đo qua burn-ID; mục-tiêu ≥5%C/epoch + pull-forward ~3×.

### §6.2 Cảnh báo phân cấp
| Mức | Điều kiện | Hành động |
|---|---|---|
| Xanh | `d<d_soft` ∧ `br≥br_healthy` (1.8) | vận hành thường |
| Vàng | `d∈[d_soft,d_red)` hoặc `br∈[br_safe,br_healthy)` | tăng tần-suất-đo, cảnh báo DAO |
| Cam | `d∈[d_red,d_vacuum)` hoặc `br<br_safe` | kích tầng theo dispatch; chuẩn-bị Backstop |
| Đỏ | `d≥d_vacuum` hoặc bad_debt>0 | VacuumBack/Backstop; xem xét van-khẩn-cấp |
| Đen | `d≥d_emergency` | chuỗi-khẩn-cấp DAO-vote |

### §6.3 Ngưỡng-panic quan sát
- panic-thiết-kế công-khai = 15%C. **Trên ~18-20%C panic → sụp phi-tuyến** (§4.5-DacTa): mọi quỹ cạn trần đồng thời. WALL là **VỐN** không phải tốc-độ → khi panic tiến gần 15%C, ưu tiên **CDP-open-depth + vốn-arb-thật + throughput-tiêu-MAGIC**, KHÔNG tinh-chỉnh θ/κ/n.

---

## §7. QUY MÔ TRIỂN KHAI VN (PrepaidGen sạch nhất)

> **Bối cảnh:** VN = vùng triển-khai-đầu (Pha 3 LIVE-VN). Đối tượng: **100 nông dân** dùng OriLife (truy-xuất-nguồn-gốc) + AladinWork (lao-động/hợp-đồng) + LampNet (hạ-tầng). PrepaidGen là cửa **sạch pháp-lý nhất** (tự-back, consumptive-use, không đầu-cơ).

### §7.1 Vì sao PrepaidGen cho lô-VN-đầu
- **Tự-back, không rút GreenBack** (§5.1-DacTa) → không tạo áp-lực-solvency ngày-đầu khi quỹ còn mỏng.
- **Consumptive-use rõ ràng:** nông dân khoá CARP → gen MAGIC → **tiêu dịch-vụ-thật** (lưu-trữ hồ-sơ truy-xuất, xác-thực lao-động). Đây là **cầu-dịch-vụ-thực** đỡ utility-floor (§3.1-DacTa) + là bằng-chứng-throughput sạch nhất.
- **F2 bảo vệ:** vesting_v=0 (escrow-theo-delivery), claim_provider ≤ Σ MAGIC_burned_par, buffer-Paid ≥15% → nếu provider không giao dịch-vụ, nông dân không mất trắng.

### §7.2 Dự-phóng lượng CARP (~440-480k CARP / 100 nông dân)
> Con số khung, hiệu-chỉnh sau benchmark throughput thực-địa (§9 #1). Đơn-vị neo: `1 CARP = 1 TB·ngày` (storage-thuần) hoặc rổ-dịch-vụ.

| Cụm dịch-vụ | Ước tiêu/nông-dân/năm | Cơ sở |
|---|---|---|
| OriLife (truy-xuất-nguồn-gốc, lưu-trữ hồ-sơ+ảnh+cảm-biến) | ~3.000-3.300 CARP | lưu-trữ dữ-liệu canh-tác quanh năm |
| AladinWork (hợp-đồng, xác-thực lao-động, chữ-ký) | ~800-1.000 CARP | định-danh + compute xác-thực |
| LampNet (hạ-tầng, đồng-bộ, băng-thông) | ~600-700 CARP | truyền/đồng-bộ dữ-liệu |
| **Tổng/nông-dân/năm** | **~4.400-4.800 CARP** | |
| **× 100 nông dân** | **~440.000-480.000 CARP** | **mốc C_circ Pha-3-VN** |

- **Đây là mốc `C_circ` dự-phóng** để nạp quỹ back Pha-3 (§3.1): back ~50%×460k ≈ **230k CARP-tương-đương**, panic-thiết-kế 15%×460k ≈ **69k**, buffer-Paid 15% ≈ **69k**, pool ~20% ≈ **92k**.
- **Prepaid theo-mùa:** nông dân khoá CARP đầu-vụ, tiêu MAGIC rải cả vụ → **throughput đều** (tốt cho utility-floor). Gói-thời-hạn decay khớp chu-kỳ-vụ (§5.4-DacTa).

### §7.3 Bộ-đệm-app vùng-xám
- Nông dân ở **vùng-xám pháp-lý** dùng **MAGIC qua bộ-đệm-app-vùng-sáng** (§8-DacTa): họ tương-tác app (OriLife/AladinWork), app vùng-sáng ôm CARP; người-dùng-cuối chỉ thấy dịch-vụ, không cầm CARP trực-tiếp → geofence sạch.
- CARP geofence: chỉ pháp-nhân-con-MLF + Platform vùng-sáng cầm/lưu-thông CARP.

### §7.4 Trình tự triển khai lô-VN
1. Onboard Platform vùng-sáng (OriLife, AladinWork, LampNet) làm **khách-hàng mua CARP** (§5b-DacTa) — họ là nguồn cầu-thực.
2. Nạp quỹ Paid mỗi Platform (buffer ≥15%, escrow-theo-delivery).
3. Nông-dân (hoặc app-đệm) khoá CARP → PrepaidGen → MAGIC → tiêu dịch-vụ.
4. Đo throughput thật 1-2 vụ → hiệu-chỉnh mốc C_circ + quỹ back → mới mở registry rộng.

---

## §8. ĐO-LƯỜNG & HIỆU-CHỈNH (đo trước, cam kết sau)

### §8.1 Benchmark BẮT BUỘC trước genesis (blocker Cổng 0→1)
- **Throughput tiêu-MAGIC thực-địa** (§6c-DacTa): đo `Σ MAGIC_burned/epoch` từ lô-thử OriLife/AladinWork. Không cần đạt 5%C ngay — cần **số thật** để hiệu-chỉnh mục-tiêu.
- **Phân phối panic_frac thực-địa** (§9 #2-DacTa): trục-nhạy #1; số 15%C phụ-thuộc giả-định — đo hành-vi-rút thật.

### §8.2 Sim-tích-hợp (blocker Cổng 0→1, §9 #4-DacTa)
- Một run tích-hợp: utility-floor + PSM + 3-back + quỹ-độc-lập + hàm-điều-phối-2-trục (§4.7-DacTa) **đồng thời**.
- **Kiểm:** tổng-lực-đỡ đủ; deadzone (F4) đã gỡ; F1 leak≡0 cưỡng-chế; VacuumBack không cliff (F3); quỹ lệch-biến/lệch-ngưỡng (F5) không đồng-pha.

### §8.3 Chạy lại κ_eff (§9 #3-DacTa)
- κ_eff với σ̂ EWMA-lag (một-nguồn) + so cùng-vốn-đệm (xác nhận κ-động = đạt mức-vốn-đúng, KHÔNG phải phép-màu-phản-chu-kỳ) + thực thi lamp-cap-tuyến-phụ + cưỡng-chế F1.

---

## §9. CHECKLIST TRƯỚC GENESIS

> Không tick đủ → không phát-hành. Chia theo cổng-duyệt §1.

### §9.1 Cổng 0→1 (BENCHMARK) — bắt buộc
- [ ] Benchmark **throughput tiêu-MAGIC thực-địa** có số thật (§8.1). **[BLOCKER]**
- [ ] Sim-tích-hợp §8.2 pass: tổng-lực-đỡ đủ + deadzone gỡ + F1 leak≡0 + F3 no-cliff + F5 no-đồng-pha.
- [ ] Validator cưỡng-chế **F1 (INV-VACUUM-ISOLATION)** pass on-chain test (input token-Vacuum vào backing_core bị TỪ CHỐI).
- [ ] κ_eff chạy lại (§8.3) + xác nhận cùng-vốn-đệm.
- [ ] Numéraire chốt (§2.3): storage-thuần hay rổ-dịch-vụ; 1 KB·ngày hay 3 KB·ngày.
- [ ] GlobalState datum genesis (§2.2) review đúng mọi trường.

### §9.2 Cổng 1→2 (SÀN-GIỮ)
- [ ] ≥8 epoch: utility-floor kéo CARP về mép `1−(phí+gas)`, KHÔNG đụng LAMP.
- [ ] buffer-Paid ≥15% giữ vững; bad_debt = 0.
- [ ] Bảng-kiểm-invariant §5.6 xanh mọi epoch.

### §9.3 Cổng 2→3 (STRESS)
- [ ] CDP-phụ mở đúng: MCR_base=200%, LR=130%, g_min≥67% cưỡng-chế on-chain.
- [ ] VacuumBack: commit ≤20%C + stagger (F3); leak đo được ≡0.
- [ ] RedBack: rổ token đã đo ρ≤0.3 (TWAP≥180 ngày, PHẢI ĐO không giả-định); không LAMP/BTC/ETH/fiat.
- [ ] Kịch-bản-stress ~10%C panic: 3-back+quỹ đỡ đúng dispatch(d,br); không deadzone.

### §9.4 Cổng 3→4 (PHÁP-LÝ) — bắt buộc
- [ ] **Ý-kiến-luật-sư-MiCA** bằng văn bản về ranh ART (utility-floored làm nhẹ đủ không). **[BLOCKER]**
- [ ] Geofence EU mặc-định kích-hoạt; VN-vùng-xám qua bộ-đệm-app (§7.3).
- [ ] Xác nhận VacuumBack = giảm-phí-không-lãi (non-securities); Backstop = đệm-nội-bộ-không-bán-bảo-hiểm.
- [ ] FinCEN MSB / MTL nếu chạm Mỹ; Howey-4 giảm-thiểu (phân-phối-không-bán, không-đầu-cơ).
- [ ] `F-LANG`: không marketing "stable/stablecoin/algorithmic/yield/fund/đầu-tư".

### §9.5 Cổng 3→4b + Pha-4 (VN-scale + mở rộng)
- [ ] Quy mô 100-nông-dân (§7): Platform vùng-sáng onboard làm khách-hàng; quỹ Paid nạp.
- [ ] Mốc C_circ ~440-480k dự-phóng + quỹ back tái-cân theo C_circ thật.
- [ ] Đo throughput 1-2 vụ → hiệu-chỉnh trước khi mở registry rộng.
- [ ] Registry-MỞ điều-kiện: tiêu-MAGIC + dùng-CARP + đăng-ký (§5b-DacTa).

---

## §10. ĐIỂM MỞ THỰC-THI (chưa khoá)
1. Numéraire cuối (§2.3) — storage-thuần vs rổ-dịch-vụ + trọng-số rổ khởi tạo.
2. Số throughput mục-tiêu chính xác sau benchmark (§8.1) — thay giả-định 5%C.
3. Dự-phóng CARP/nông-dân (§7.2) — hiệu-chỉnh bằng số-tiêu thật 1-2 vụ.
4. `X%` trong stagger-cap VacuumBack (§5.4, F3) — đo mật-độ-commit thực.
5. Trọng-số 4-trục cụ-thể cho DAO-vote (§4.3) — khung ghi lý-do.
6. Ranh-vùng-tài-phán mở Pha-4 — chờ luật-sư-MiCA từng vùng.

---

> **Ghi chú nhất quán:** file này KHÔNG định-nghĩa lại thiết-kế. Khi mâu-thuẫn về số/tham-số/bất-biến → theo `Carpet-CARP-DacTa-Vi.md` v0.3 (§6 bảng tham số) + `CARP-Math-Vi.md` (tuyến-phụ-CDP). Bảng-ánh-xạ-từ-vựng: §6b-DacTa. KHÔNG commit/push. KHÔNG đề cập MagicChange. KHÔNG hứa "thoát ART".
