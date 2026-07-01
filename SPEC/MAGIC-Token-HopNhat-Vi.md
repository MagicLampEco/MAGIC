# MAGIC — Đặc tả Token Hợp nhất (một policy-id)

> ⛔ **LỖI THỜI (SUPERSEDED) — 2026-07-01.** Quyết định mới nhất **ĐẢO NGƯỢC** hướng gộp-1-token của tài liệu này.
> Hệ đã chốt **3 token tách biệt**: LAMP (nền, 36 tỷ no-burn) · MAGIC (thuần Consumable, **KHÔNG chuyển nhượng**, decay, chỉ chuộc-ra-dịch-vụ) · CARP (Exchangeable, chuyển nhượng, ổn định, đồng DUY NHẤT trade nội bộ MagicSwap).
> **Bản chuẩn thay thế:** `SPEC/MagicLamp-3Token-DacTa-Vi.md` (+ `SPEC/Carpet-CARP-DacTa-Vi.md`). Nguồn quyết định: `CARP/SESSION-STATE-carp-2026-06-26.md` §30/6-b.
> Giữ file này chỉ để tham chiếu lịch sử phân tích. **Khi mâu thuẫn về số-token → theo bản 3-token.**

> Đơn vị giá trị duy nhất của MagicLamp Network. **Một token MAGIC, một policy-id**, hai đường đúc.
> Phiên bản v0.3 — sau phản biện 3 lượt + đính chính mô hình. Thay đổi cốt lõi so với v0.2: bỏ kiến trúc hai-lớp; SnapshotMint **đúc MAGIC thật có-back** (không còn lớp tín dụng không-token, không còn decay token lưu hành). Phạm vi: **pháp lý + gaming của MAGIC**. Quản trị (VotingPower/C1–C4) **để Governance lo**, không thuộc tài liệu này.

---

## §0. Tóm tắt một trang

MAGIC là **đơn-vị-tiêu-dịch-vụ nội bộ (utility credit) neo sức mua dịch vụ** của hệ MagicLamp: **một token native** (một policy-id, chuyển nhượng, 9 decimals), do **một MintingPolicy lõi (GreenPeg)** kiểm soát, vào lưu thông qua **hai đường đúc**.

> **Định vị pháp lý cốt lõi (kết luận hội đồng đa-tài-phán):** MAGIC **KHÔNG** tự mô tả là "đơn vị thanh toán / phương tiện settle"; nó là **utility credit để TIÊU dịch vụ nội hệ** (tiêu = redeem-utility, KHÔNG phải settle-thanh-toán-liên-bên). Lá chắn mạnh nhất nằm ở **bản chất + trạng thái**, không ở số-lượng-token: (a) KHÔNG neo fiat (ra ngoài payment-stablecoin GENIUS + EMT MiCA); (b) cashback ràng-tiêu-không-bán, chỉ kích khi tiêu-thật, ≤ phí-thực-đốt, KHÔNG nhân nắm-LAMP, dòng-thụ-động → Treasury-không-claim; (c) **lớp-chuyển-nhượng giữ NHẸ** (không bình-ổn-giá-chủ-động kiểu RedPeg-trade, không trợ-giá); (d) **DID-gate** chuyển-nhượng (chỉ ví đã-KYC) là đòn-bẩy chặn ví-sàn-trá-hình. "Hợp pháp toàn cầu" đạt bằng **phân-vùng-tài-phán** (license nơi cần, geofence nơi chưa) — KHÔNG bằng một-cấu-trúc-token-thần-kỳ (đúng với mọi token, kể cả USDC).

| | Đường CDP | Đường SnapshotMint (hoàn-tiền-trung-thành) |
|---|---|---|
| Bản chất | Nợ thế chấp | Hoàn tiền tiêu dùng thật |
| Điều kiện | Khoá LAMP ≥200% | (1) Nắm LAMP tại snapshot + (2) tiêu dùng thật qua nền tảng đã đăng ký (DAO định) |
| Nguồn back | LAMP khoá trực tiếp (sense pledged) | **Thặng dư backing toàn hệ** (`br > br_safe`), trần `cap(br)` (sense solvent) |
| Lượng | Theo nhu cầu user | Trần biến thiên/epoch, hàm của `br`; quyền-mint **không tích luỹ** |
| Sau khi đúc | MAGIC thật, chuyển nhượng, **không decay** | MAGIC thật, chuyển nhượng, **không decay** |
| Thu hồi | Đóng CDP → đốt | Đốt qua phí tiêu dùng + đóng CDP cộng đồng |

**Bất biến tối cao (INV-NO-UNBACKED):** mọi MAGIC lưu hành luôn nằm trong hệ over-collateralized `Σ MAGIC ≤ B / br_safe`. SnapshotMint **chỉ** đúc khi backing XANH; khi backing **ĐỎ** (`br ≤ br_safe`, RedPeg kích hoạt) thì **khoá mint TOÀN mạng** (cả CDP lẫn SnapshotMint), `M = 0`. Đây là seigniorage-trong-thế-chấp (kiểu surplus buffer MakerDAO), **không phải** phản xạ Terra.

Người dùng phổ thông thấy: "Tôi tiêu MAGIC để **dùng dịch vụ trong hệ** (lưu trữ trên LampNet, thuê việc trên AladinWork, định danh cây trên OriLife). Vì tôi nắm LAMP và tiêu thật, mỗi epoch tôi được **hoàn lại một ít MAGIC** (có trần, không hứa trước, chỉ tiêu-được-không-bán). MAGIC tôi mua là tiền thật, giữ được, không bốc hơi."

> *Lưu ý đặc-tả (pháp lý):* ví dụ phải là **dịch-vụ-nội-hệ**, KHÔNG dùng ví dụ "mua hàng-hóa-bên-thứ-ba" (vd mua nông sản) — đó là **payment-function** đụng thẳng VN-cấm-phương-tiện-thanh-toán. Mua hàng-thật giữa hai bên độc lập phải đi **fiat** (xem §5.2 escrow).

---

## §0.1 Bảng thuật ngữ — đọc trước nếu bạn mới

> Tài liệu này có nhiều thuật ngữ kỹ thuật. Bảng dưới giải thích bằng lời thường. Đọc qua một lượt rồi quay lại khi gặp từ lạ.

| Thuật ngữ | Nghĩa dễ hiểu |
|---|---|
| **MAGIC** | Đồng tiền tiêu dùng nội bộ của hệ MagicLamp (1 MAGIC ≈ một rổ dịch vụ cơ bản). |
| **LAMP** | Đồng tài sản nền của hệ (tổng cố định 36 tỷ, không bao giờ huỷ bớt). |
| **policy-id** | "Mã khai sinh" duy nhất của một loại token trên Cardano — để phân biệt MAGIC thật với hàng giả. |
| **đúc (mint) / đốt (burn)** | Đúc = tạo MAGIC mới. Đốt = huỷ MAGIC vĩnh viễn (giảm lượng lưu hành). |
| **bảo chứng (backing)** | Kho tài sản thật đứng sau mỗi MAGIC để bảo đảm nó có giá trị. |
| **tỷ lệ bảo chứng (br)** | Kho bảo chứng chia cho tổng MAGIC. Ví dụ br = 1,8 nghĩa là mỗi đồng MAGIC có 1,8 giá trị đỡ sau lưng. Càng cao càng vững. |
| **ngưỡng an toàn (br_safe) / khoẻ (br_healthy)** | br_safe = mức tối thiểu chấp nhận được (1,5). Dưới mức này gọi là "đỏ" (nguy). br_healthy = mức khoẻ (1,8). |
| **thế chấp vượt mức (over-collateralized)** | Luôn để kho bảo chứng NHIỀU HƠN giá trị MAGIC phát ra — đệm an toàn. |
| **trần đúc theo phần dư (cap / cap_surplus)** | Mỗi epoch chỉ được đúc thêm trong PHẦN DƯ của kho bảo chứng, không đụng phần lõi. |
| **thế chấp khoá LAMP (CDP / Vault)** | Khoá LAMP làm thế chấp để đúc MAGIC; trả MAGIC thì lấy LAMP về. Như cầm đồ có kỳ hạn. |
| **chiết khấu giá (haircut)** | Khi tính bảo chứng, trừ bớt giá tài sản hay biến động (như LAMP) để phòng nó rớt giá — tính thủ. |
| **neo / ngang giá (peg / par)** | Mức giá mục tiêu của MAGIC (= 1 rổ dịch vụ). "Lệch neo" (depeg) = rời mức đó. |
| **epoch** | Một chu kỳ thời gian của mạng (đơn vị nhịp, ~5 ngày trên Cardano). |
| **quỹ bình ổn Xanh / Đỏ (GreenBack/GreenPeg, RedBack/RedPeg)** | Xanh lo **khả năng chi trả** (bảo chứng đủ không). Đỏ lo **giá** (MAGIC có giữ neo không). Hai vai khác nhau. |
| **kiếm lời chênh giá (arbitrage)** | Mua chỗ rẻ bán chỗ đắt để ăn chênh lệch — lực thị trường tự kéo giá về neo. |
| **không yếu-tố-bên-ngoài / oracle** | Oracle = nguồn báo giá từ ngoài chuỗi. Hệ này **cố ý KHÔNG dùng** oracle cho cơ chế lõi, chỉ dựa số liệu nội bộ → minh bạch, khó thao túng. |
| **trượt giá (slippage)** | Mua/bán lượng lớn trên sàn ít thanh khoản thì giá xấu đi nhiều. |
| **DAO** | Cộng đồng tự quản phi tập trung, không có công ty trung tâm điều khiển. |
| **Terra** | Một đồng "ổn định" đã sụp đổ 2022 vì đúc-không-bảo-chứng — bài học hệ này tránh. |
| **MakerDAO/DAI, DJED, FRAX** | Các hệ tiền-ổn-định có thế chấp thật, được tham chiếu khi thiết kế. |
| **các phép thử pháp lý (Howey, Reves, MiCA, ART...)** | Bộ tiêu chí của Mỹ/EU để xác định một token có bị quản như **chứng khoán / sản phẩm tài chính** không. Thiết kế cố giữ MAGIC là **tài sản tiện ích**, ngoài các nhóm đó. |
| **DID / did_commit / sinh trắc sống (liveness)** | Danh tính số gắn một-người-một-tài-khoản qua đặc điểm sinh học — chống lập nhiều tài khoản ảo. |

---

## §1. Hai bản chất MAGIC bắt buộc mang đồng thời

**(a) Tiền tiện ích ổn định, chuyển nhượng được** — nông dân chuẩn bị 100.000 MAGIC định danh 100.000 sản phẩm, không sợ giá trồi sụt, không sợ bốc hơi, bán lại được phần dư.

**(b) Số đo cam kết/tiêu dùng thật, gắn danh tính** — hệ thưởng đúng người nắm LAMP + tiêu thật, và (về sau) Governance đọc được ai thật sự tiêu tài nguyên mạng.

Cách hợp nhất: KHÔNG cần hai token cũng KHÔNG cần hai lớp on-chain. Một token; bản chất (b) thể hiện qua **điều kiện đúc SnapshotMint** (gắn DID + tiêu-dùng-thật) và **dữ liệu sự kiện tiêu** (cho Governance đọc sau), chứ không qua một loại tài sản riêng. Tính chuyển nhượng của (a) và tính gắn-DID của (b) cùng tồn tại vì (b) nằm ở **luật đúc + sổ sự kiện**, không ở **bản thân đồng tiền**.

---

## §2. Đơn vị và mỏ neo

- Đơn vị nguyên tử: **nanogic**. `1 MAGIC = 10⁹ nanogic` (9 decimals).
- Mỏ neo: **1 MAGIC = sức mua dịch vụ nền** — lượng dịch vụ tương đương `base_price` khoá on-chain (định danh 1 sản phẩm, 1 KB·ngày lưu trữ…). KHÔNG neo USD/ADA.
- `base_price` chỉ đổi qua DAO vote hiến pháp (numéraire nội sinh). Neo par `P* = 1`.
- **Hai khái niệm giá tách bạch:**
  - `P_redeem` (chuộc par) = **oracle-free**: đóng CDP, 1 MAGIC xoá đúng 1 đơn vị nợ.
  - Định giá thế chấp (`MCR_eff`, thanh lý, `br`, định giá rổ) = **oracle-dependent**: phải biết giá LAMP → TWAP đa-DEX. Đây là **cấu trúc DAI** (oracle ở an-toàn-thế-chấp, oracle-free ở chuộc-par) — KHÁC Terra. **Không** dùng "zero-oracle" làm lá chắn pháp lý.

---

## §3. MintingPolicy lõi — một cổng đúc, hai đường

Tất cả MAGIC đúc qua **một MintingPolicy** (kiểm soát bởi GreenPeg, §7). Mọi nhánh mint phải thoả một trong hai vị từ:

1. **Đường CDP** (`mint_via_cdp`): có UTxO CDP hợp lệ khoá LAMP với `collateral_value ≥ MCR_eff × minted`. Đốt khi đóng CDP.
2. **Đường SnapshotMint** (`mint_via_snapshot`): thoả §6 — đủ điều kiện cashback, lượng ≤ `cap(br)` epoch hiện tại, có chứng nhận tiêu-dùng-thật + DID.

**Không có nhánh mint thứ ba.** Mọi mint không qua hai vị từ trên là bất hợp lệ (chống seigniorage tự do).

---

## §4. CDP — đúc và chuộc

> **Đổi tên cho dễ hiểu (khuyến nghị từ hệ chuyên gia — chờ anh xác nhận):** "CDP" khó hiểu → đổi thành **Vault** ("MAGIC Vault"/"LampVault" cho UX; "CDP Position"/"Vault" cho pháp-lý/code) — chuẩn ngành (MakerDAO Vault, Liquity Trove), đúng bản chất "két khoá thế chấp sinh nợ", không hàm-ý-chuyển-nhượng/chứng-khoán. **BỎ hẳn "Cheque"** toàn hệ (séc = negotiable instrument → kích family-resemblance "note" Reves + mâu thuẫn không-chuyển-nhượng). **TRÁNH "Card"** (= payment instrument, kéo về stablecoin-payment). Hành động đúc-qua-thưởng = **SnapshotMint**; tránh "Miner/Option" (gợi PoW-seigniorage / phái-sinh). Nguyên tắc tên: tránh đồng thời 3 hàm-ý — negotiable-instrument, lợi-tức, cổ-phần-quỹ. **Khung "hai cheque đều CDP" → TÁCH** (GreenCheque LÀ CDP→Vault; red-state KHÔNG phải CDP — xem §8).

- Khoá LAMP vào **vị thế CDP** (UTxO, chủ = khoá ký, không NFT, mặc định không chuyển nhượng) → đúc MAGIC.
- `MCR_base = 200%`, `MCR_eff = MCR_base × NSF`, `NSF ∈ [1.0, 1.4]` (chỉ siết, không nới). `MCR_floor = 110%` (hiến pháp).
- Chuộc/đóng: trả MAGIC (+ phí) → nhận LAMP, **đốt** MAGIC. `P_redeem ≡ 1` (oracle-free).
- Thanh lý: tỷ lệ tụt dưới ngưỡng → đấu giá LAMP thu MAGIC bù nợ.
- **Quyết định MCR (sau hệ chuyên gia tiền tệ + mô phỏng Monte-Carlo — BÁC mức tĩnh ≥300%):** MCR là **tham số đòn-bẩy hợp đồng nợ, KHÔNG phải bơm-cầu**. `LAMP_khoá ∝ MCR^(1−ε)`; phân khúc nhạy chi-phí-vốn (`ε≈1`/`>1`) nâng MCR **vừa bóp cung vừa có thể GIẢM LAMP hút vào**. Nâng ≥300% rút LAMP khỏi float DEX → oracle `ρ_LAMP` mỏng hơn (phản tác dụng). DJED 400–800 là **tỷ-lệ-dự-trữ-HỆ**, không phải MCR-per-CDP (sai loại suy).
  - **Bằng chứng mô phỏng (bản kỹ, quét độ nhạy 8 chiều — `scratchpad/mcr_sim3.py`):** kịch bản nền P(vỡ nợ) 200%=0,68% / 250%=0,18% / 300%=0,06%. Ba phát hiện then chốt: (1) **biến động LAMP là biến chi phối** (vol 8%→0,37%, vol 25%→5,03% ở 200%) → biện minh **NSF động**; (2) **quản CDP (topup) mạnh hơn MCR** (0% quản→2,02%, 80% quản→0,22%); (3) **Insurance rẻ-hiệu-quả** (5%→15% giảm 0,68%→0,27% không khoá vốn-chết). Ngưỡng cứng: 300% vẫn vỡ ở −67% → đuôi sâu để Insurance+`g_min`+RedPeg lo.
  - **Quyết định:** giữ `MCR_base = 200%` (sàn hiệu-quả-vốn) + **NSF động** (nâng MCR_eff đúng lúc vol cao) + Insurance/`g_min` mạnh + khuyến khích topup + RedPeg cho đuôi. Nâng MCR tĩnh là đòn bẩy YẾU và đắt; chỉ lên 250% nếu LAMP vol thật ≥18%/epoch kéo dài.
- **MCR là HÀM BIẾN THIÊN + DAO chỉnh trong biên:** `MCR_eff = MCR_base × NSF`, `NSF = clamp(1 + a·vol_thừa + b·br_thiếu + c·depth_mỏng, 1.0, NSF_max)` — tự siết khi LAMP biến động / backing mỏng / DEX cạn. DAO chỉnh `{MCR_base, NSF_max, a,b,c, LR}` trong **biên hiến pháp** `MCR_base ∈ [150%,300%]`, `NSF_max ≤ 1.5`, `MCR_floor = 110%` (bất biến). Vừa phản-ứng-thị-trường vừa quản-trị-được vừa có-trần.

---

## §5. Tiêu thụ + cam kết — HỆ BA VAN phân-miền theo bản chất giao dịch

Quy tắc "tiêu" MAGIC **không đồng nhất** — phân miền MECE theo **CÓ tiêu thụ tài nguyên giao thức hay không**. Ba van tác động ba biến độc lập, một bất biến solvency `Σ MAGIC ≤ B/br_safe` phủ cả ba:

| Loại giao dịch | Van | Tác động cung | Ví dụ |
|---|---|---|---|
| **Tiêu dịch-vụ-mạng** (tiêu thụ tài nguyên giao thức) | THU-HỒI có trần | `Σ↓` (đốt tới `br_healthy`, vượt→Treasury) + phần provider | mint DID → PhoenixKey; lưu trữ → LampNet |
| **Cam kết P2P** (không tiêu tài nguyên mạng, chỉ bảo chứng) | TRUNG-LẬP | `Δcung = 0` (khoá-thả) | escrow hợp đồng AladinWork (§5.2) |
| **Thưởng nắm-giữ** | PHÁT (nguồn) | `Σ↑` chỉ trong thặng dư | SnapshotMint (§6) |

> **Không có "burn-on-spend không trần":** đốt-khi-tiêu CHỈ tới `br_healthy` rồi route Treasury không-claim. "Lợi ích về giao thức đóng góp" KHÔNG đi qua burn (bất khả toán học: lợi-ích-đốt là tỉ-lệ-toàn-hệ chia pro-rata mọi holder, không "chỉ tên" được) — mà qua **phần provider** trong split phí. PhoenixKey là provider dịch vụ DID → nhận phần provider, không cần burn-và-route.

### §5.1 Van THU-HỒI — tiêu dịch-vụ-mạng

MAGIC tiêu trên **nền tảng đã đăng ký** (DAO định: AladinWork, OriLife, LampNet, VeData…). Một thao tác giá `price(op) = base_price[op] × demand_mult`, chia hai dòng (mô hình `collectToTreasury`):

- **Phí mạng (cut giao thức)** = `price × protocol_cut_bps / 10000`. Định tuyến:

  | Nguồn | Xử lý | Lý do |
  |---|---|---|
  | Phí mạng (M lưu hành) | Đốt **chỉ tới `br_healthy`**, vượt → Treasury không-claim | Đốt-quá làm tăng-backing/đơn-vị = lợi tức deflation thụ động (Howey-4) |
  | Chuộc/đóng CDP | Đốt (xoá nợ) | Trung lập |
- **Trả nhà cung cấp** = phần còn lại → provider.

Việc "tiêu dùng thật chỉ qua nền tảng đăng ký" có hai tác dụng: (i) là **điều kiện cần** để đủ tư cách cashback (§6) — bằng chứng đóng-góp-thật kiểu staking; (ii) củng cố định vị MAGIC là **đơn vị thanh toán tiện ích** dùng cho dịch vụ nội hệ (xem §11). Mỗi sự kiện tiêu gắn `consumption_id` duy nhất (chống đếm-trùng) + `did_commit`; sổ sự kiện này để Governance đọc về sau (ngoài phạm vi tài liệu).

### §5.2 Van TRUNG-LẬP — cam kết escrow hợp đồng P2P

Hợp đồng việc làm (vd AladinWork): mỗi bên **khoá MAGIC cam kết** (performance bond, vd 100 MAGIC/bên) + trả **phí mạng phân biệt theo vai** (vd thợ 10, chủ 5 — xem dưới). Xong việc → cọc **trả lại**, thanh toán công việc bằng **fiat ngoài chuỗi**. Đặc tính:
- **Trung lập cung tuyệt đối:** `Δ(Σ MAGIC) = 0`, chỉ `Δ(C_circ) < 0` khi khoá (đồng cấu trúc `INV-RF-3'` của RedPeg) — escrow là "reserve do người dùng tự tạo", một bộ giảm-chấn velocity.
- **Cọc là performance-bond, KHÔNG phải thanh-toán-lao-động** — tách bạch để tránh framing nợ-lao-động (thanh toán công việc hoàn toàn fiat ngoài chuỗi).
- **Nhánh tranh chấp = time-lock release ĐỐI XỨNG:** sau `T_max` mỗi bên tự lấy lại **cọc của mình** bất kể bên kia (không deadlock). Slashing (nếu DAO định) → **Treasury không-claim** (đốt sẽ đụng `INV-BURN-EXCL`).
- **Phí phân biệt theo vai KHÔNG "điều tiết cung":** cung MAGIC không đổi do phí; đây là **phí Pigovian phân biệt điều tiết HÀNH VI** (ai chịu phí cao thì ít khởi tạo loại giao dịch đó). Hình thức hoá `f(vai, Imbalance)` qua `demand_mult`/ScarcityWeight có sẵn (đối xứng 5=5 là trường-hợp-riêng khi `Imbalance=0`), KHÔNG đặt tay. Phí → Treasury qua split §5.1.
- Cọc định-danh theo **MAGIC-neo-sức-mua** (100 MAGIC = 100 rổ base_price bất kể giá DEX) → vô hiệu grief-qua-giá.

> Tiền điều kiện build: cần nền **native token** + validator escrow (đã chốt hướng ở §10, "cài sau").

---

## §6. SnapshotMint — hoàn-tiền-trung-thành có-back, capped

**Khung bản chất: thưởng-tham-gia kiểu STAKING** (không phải lợi-tức-thụ-động). Người nắm LAMP = **stake vốn vào sự ổn định hệ** qua thời gian; người tiêu khi peg thấp = **nỗ lực chủ động cứu peg**. Thưởng cho chính nỗ lực + đóng góp của họ, từ vận hành cơ học của DAO phi tập trung — cùng nhóm pháp lý với staking reward PoS, KHÔNG phải investment-contract (xem §11).

**Cơ chế** (đường đúc thứ hai, thay mọi generator cũ):
- **Điều kiện cần (cả hai):** (1) nắm LAMP (tích phân theo lịch sử — xem công thức); (2) **tiêu dùng thật** trong epoch qua nền tảng đăng ký (tiêu chí DAO định).
- **Công thức M (tích phân đóng-góp-theo-thời-gian):**
  `M = w₀·M(L₀) + w₁·M(L₁) + … + w₆·M(L₆)` (mở rộng số epoch được)
  - `Lᵢ` = số dư LAMP **đủ tư cách** ở epoch thứ-i lùi về quá khứ; `wᵢ` trọng số riêng từng epoch.
  - **Tuổi-epoch (theo UTXO vật lý) chỉ xét TƯ CÁCH từng khoản LAMP trong mỗi `Mᵢ`** — chống lợi-dụng-snapshot + biến động giá theo thời điểm snapshot. KHÔNG nhân vào độ lớn thưởng.
  - Vì sao tích phân 6+ epoch: công bằng với doanh nghiệp nắm dài hạn **tạm bán LAMP lấy vốn rồi mua lại** (chỉ tính LAMP-hiện-tại sẽ phạt họ + mời gọi nắm-tạm-thời). Người mới vẫn hưởng phần `M₀…` → khuyến khích tích luỹ dần.
- **Cổng GreenPeg (regime, không phải giá):** `M` thực cấp = `min(M, cap_surplus(br))`; `cap_surplus = f·S·(br−br_safe)/br_safe` khi backing XANH; **`M = 0` khi backing ĐỎ** (`br ≤ br_safe`, khoá mint toàn mạng). `f` nhỏ + trần tuyệt đối.
- **Không tích luỹ quyền:** không tiêu thật epoch này thì mất suất epoch này (use-it-or-lose-it ở mức quyền).
- Nắm LAMP **không bị khoá** — đọc số dư đủ-tư-cách qua lịch sử.

**Vì sao có-back, không Terra** (chứng minh — đã qua kiểm-định đối kháng):
- `B` = backing thật = LAMP (giá oracle, **haircut theo biến động**) + tài sản cứng (ADA/stable). **Sàn cứng non-LAMP `g_min ≥ 67%`** (nâng từ 50% — mô phỏng flash crash §6.2-B xác nhận lằn ranh sống/chết; xem §12 INV-HARD-FLOOR; [chờ chủ dự án chốt cứng]) để khi LAMP→0 đáy `br_floor = g_min·br` còn gần par. `cap(br)` tính trên `B` đã haircut (đúc trong thặng-dư-sau-stress, không spot).
- SnapshotMint đúc **chỉ vào thặng dư** `B − br_safe·S`; sau đúc `br' ≥ br_safe`. Tương phản Terra: không trần, không sàn, không phanh, collateral nội sinh thuần.
- **Hai phanh bổ sung (bắt buộc, từ kiểm-định):**
  - `cap(br) = 0 khi đang depeg` (`d_internal > 0`) — đúc thêm lúc dưới par là phản tác dụng; `cap` phải nhìn cả giá lẫn solvency.
  - **`INV-CASHBACK-BOUND` siết:** cashback/DID ≤ **phần phí THỰC-ĐỐT** của DID đó (không phải tổng phí trả). Vì phí chia hai dòng (§5) chỉ cut-giao-thức bị đốt; nếu cashback tính trên tổng phí thì ròng toàn hệ là bơm cung.

**Gen-Terra còn sót (ghi trung thực):** collateral chính LAMP nội sinh (phản xạ, `ρ_LAMP` nội sinh). Khác biệt với MakerDAO (collateral ngoại sinh). Khử bằng `g_min` cao + haircut + stress-test, KHÔNG xoá hoàn toàn.

**Về Howey (giải bằng khung staking — không phải đường-biên-bất-khả như lo ngại trước):** Thưởng gắn nắm-LAMP KHÔNG tự động = Howey-4, vì: (1) quyền M **không được mua** (không "đầu tư tiền" để lấy quyền — LAMP nắm vì utility); (2) thưởng đến từ **nỗ lực của chính người tham gia** (stake vốn vào ổn định + chi tiêu cứu peg), không từ nỗ lực promoter; (3) vận hành **cơ học, DAO phi tập trung, tự lưu ký**. Đây là cấu hình **staking reward PoS**, không phải investment-contract. Phép so này hợp lệ vì tích phân-6-epoch chính là **stake-theo-thời-gian**. (Phân tích đầy đủ + rủi ro còn lại ở §11.)

**Hai đòn farm cần chặn:** (a) self-platform (tự lập nền tảng tự tiêu) → bond/slashing cho nền tảng đăng ký (whitelist là phương án cuối, trái Open SDK); (b) collusion-ring nếu `cashback_bps > burn_bps` → ràng `cashback_bps ≤ protocol_cut_bps` + PhoenixKey-liveness (did_commit thật).

> **Khoảng cách thực thi:** `SnapshotMint/MATH.md` hiện hành VẪN là mô hình cũ (`M = L × R_snap × LF × OAC`, không `cap(br)`, không tích phân-lịch-sử, không ràng cashback, không cổng đỏ). Toàn bộ §6 là **thiết kế đích chưa cài**. Trước genesis phải viết lại MATH + code.

### §6.1 Phán quyết cơ chế (sau 2 lượt kiểm-định + chỉnh của chủ dự án)

**ĐÃ BÁC** biến thể *phản-chu-kỳ-theo-GIÁ-LAMP-spot + flywheel-đẩy-giá*: solvency nghịch pha (giá spot nhanh / `br` TWAP chậm), pháp lý price-targeting = MiCA-algorithmic, doanh thu miễn-phí-lúc-đói.

**ĐÃ CHỐT thiết kế đích:**
- **Cổng theo REGIME backing (xanh/đỏ), không theo giá spot:** đúc khi xanh, `M=0` khi đỏ (khoá mint toàn mạng, RedPeg kích hoạt). Giải nghịch-pha.
- **Độ lớn M = tích phân đóng-góp-theo-thời-gian** `M = Σ wᵢ·M(Lᵢ)` qua 6+ epoch (staking thật) — công bằng người giữ dài hạn tạm-bán-mua-lại + cho người mới tích luỹ. Hợp lệ về Howey nhờ khung staking (§11).
- **Tuổi-UTXO (theo UTXO vật lý) chỉ xét TƯ CÁCH từng khoản LAMP** trong mỗi `Mᵢ` — chống lợi-dụng-snapshot, KHÔNG nhân độ lớn.
- cashback ≤ **phần-phí-thực-đốt** (`cashback_bps ≤ protocol_cut_bps`); trần thặng dư `cap_surplus(br)`.
- **Cấm narrative "đẩy giá LAMP".** Cầu LAMP đến từ: stake-vào-ổn-định (thưởng staking) + collateral CDP + governance + truy cập dịch vụ.

**Về cách gọi "Pot M" (hệ chuyên gia tiền tệ làm rõ):** `M` là **TRẦN-SUẤT mỗi epoch** `cap_surplus(br)`, KHÔNG phải **bể tích quyền** cộng dồn. Nếu hiểu là bể tích luỹ nhiều epoch → tạo **overhang cung** (một cú xả đẩy `br` từ healthy về safe) + vi phạm `INV-CASHBACK-BOUND` → giữ use-it-or-lose-it, `br' ≥ br_safe` sau mỗi lần đúc.

**HAI KÊNH ĐÚC khác nhau về backing (làm rõ "tạo-cầu kéo LAMP vào backing"):**
| Kênh | Khoá LAMP? | GreenPeg | br |
|---|---|---|---|
| **CDP** (khoá LAMP `MCR`) | Có, **atomic** | `+MCR×` giá-trị-LAMP/MAGIC | **hội tụ về MCR** (tăng nếu `br<MCR`, giảm nếu `br>MCR`) |
| **SnapshotMint** (thặng dư) | Không | **0** | **giảm** về `br_safe` |
- Khi người dùng **tự đáp cầu của mình bằng CDP** (khoá LAMP đúc MAGIC để hoạt động): liên kết "cầu → LAMP vào backing" là **CƠ HỌC, trực tiếp** (không gián tiếp) — đúc 1 MAGIC nạp `MCR` giá-trị-LAMP, tức backing tăng nhanh hơn cung **khi `br < MCR`**. Đây là kênh tự-nạp-backing đúng hướng.
- SnapshotMint thì **không** nạp LAMP (dùng thặng dư) → giữ nhỏ. Cầu nên đáp **chủ yếu qua CDP** (tự-nạp-backing 2:1), SnapshotMint chỉ là thưởng staking nhỏ.
- Lưu ý: CDP **hội tụ br về MCR**, không đẩy vô hạn — "backing tăng nhanh hơn cung" chỉ đúng khi hệ đang dưới MCR.

**Cấm gọi "Option/quyền chọn" cho suất-mint** (dù đúng cấu trúc option-like): option tài chính LÀ chứng khoán phái sinh (MiFID II/CFTC) → tự dán nhãn phái sinh. Gọi **"suất-mint" / "quyền-tham-gia"** (entitlement). Khác option thật: không-chuyển-nhượng + không-trả-premium + "strike"=tham-gia-thật + hết-hạn-vô-giá-trị. **Bản chất sau mint** = token tiện ích thanh toán fungible (tính option chỉ ở suất TRƯỚC mint; sau exercise là MAGIC thường).

### §6.2 ScheduleMint — "Đăng-ký-trước" (gói mua-trước năng lực tiêu, có ScheduleBack đỡ)

> SnapshotMint có **hai chế độ** (cùng một policy-id, cùng đúc-trong-thặng-dư): **Tiêu-ngay** (Instant, §6 ở trên — hoàn tiền ngay khi tiêu) và **Đăng-ký-trước** (Schedule, mục này). Tên kỹ thuật chung là SnapshotMint; tên dân thường: "Tiêu-ngay" vs "Đăng-ký-trước".

**Mục đích (nói cho dễ hiểu):** một người hay một đơn vị cần **một khoản MAGIC đều đặn trong dài hạn** (ví dụ: trả công cho đội kỹ thuật suốt vài tháng, hoặc một khoản chi tiêu cố định hằng kỳ). Thay vì phải bỏ tiền mua sẵn cả đống MAGIC rồi ôm, họ **khoá một lượng LAMP** và được hệ **bảo đảm một dòng MAGIC cố định mỗi epoch** để tiêu dùng. LAMP **vẫn nằm yên trong ví của họ** (không bị mang đi, không bị tịch thu, vẫn được tính các quyền của người nắm giữ như thường), và được **trả lại nguyên vẹn khi hết hợp đồng**.

**Cách hoạt động (bốn bước):**
1. **Ký hợp đồng:** người dùng đăng ký một dòng `pp` MAGIC mỗi epoch, trong `N` epoch. Hệ kiểm tra **cổng giới hạn** (xem dưới). Nếu đủ chỗ thì nhận; nếu không thì xếp hàng / từ chối.
2. **GreenBack tạo MAGIC đưa vào quỹ ScheduleBack:** lượng MAGIC này **chưa được đưa ra lưu thông** (còn nằm trong quỹ, chưa tính vào cung cần-bảo-chứng) — nên việc tạo nó **không làm tăng-giảm bảo chứng** ngay.
3. **Tạm dùng phần xa-hạn để bình ổn:** hệ **luôn giữ đủ tiền cho 2 epoch tới** (đệm an toàn). Phần MAGIC còn lại (của các epoch xa hơn) được ScheduleBack dùng **mua LAMP khi giá LAMP rẻ** — đây vừa là đầu-tư-ngược-chu-kỳ (lời khi giá hồi) vừa **góp thêm bảo chứng + đỡ giá LAMP lúc sập**. Khi giá hồi, bán LAMP ra để trả nghĩa vụ. **Đây chính là vì sao Schedule càng dài/càng nhiều thì hệ càng có nhiều vốn để cứu giá** — Schedule là NGUỒN LỰC bình ổn, không chỉ là gánh nặng.
4. **Trả dần mỗi epoch — có TRẦN cứng:** mỗi epoch người dùng tiêu **tối đa `pp`** (không thể rút-dồn nhiều epoch vào một lần — đây là bản chất hợp đồng, muốn tiêu nhiều hơn phải ký thêm hợp đồng gối-đầu, và hợp đồng mới lại qua cổng). Khi thị trường căng (bảo chứng thấp), người dùng thường **tự tiêu ít hơn** → nghĩa vụ giao giảm → áp lực giảm. Tiêu xong thì MAGIC bị đốt.

**Cổng giới hạn — vì sao Schedule phải NHỎ (đây là điểm cốt):** Schedule chỉ là một **đặc quyền ưu tiên** dành cho người chịu khoá LAMP, KHÔNG phải nguồn phát hành vô hạn. Hệ chỉ nhận thêm hợp đồng tới khi:
> `Tổng nghĩa-vụ-còn-lại ≤ κ × Sức-tải-các-quỹ-cứu`
- **Sức-tải = số dư các quỹ cứu nội bộ** (RedBack + kho dự phòng của các nền tảng + Kho bạc MagicLamp). **Tuyệt đối KHÔNG dùng giá LAMP hay bất kỳ dữ liệu giá thị trường nào** để tính cổng — đây là **nguyên tắc bất di bất dịch: cơ chế lõi không lệ thuộc yếu-tố-bên-ngoài, để minh bạch tuyệt đối và không ai thao túng được** (xem §0/§12). `κ` (hệ số an toàn) đề xuất `0,6`.
- Hệ quả: nếu các quỹ cứu nhỏ thì số hợp đồng nhận được cũng nhỏ. Schedule co-giãn theo sức khoẻ thật của hệ, không phình ra được.

**Bậc thang cứu (khi quỹ ScheduleBack thiếu tiền trả):** trả lần lượt theo 5 bậc, hết bậc trên mới xuống bậc dưới:
1. GreenBack điều chỉnh tỷ giá hợp đồng (giảm nhẹ phần giao, ghi nhận thiếu hụt);
2. bán bớt LAMP mà ScheduleBack đang giữ;
3. RedBack (vốn vô chủ);
4. kho dự phòng của các nền tảng (tích từ phí dịch vụ, ví dụ một đơn 100 MAGIC trên nền tảng thì nền tảng giữ lại một phần);
5. Kho bạc MagicLamp.

**Quan hệ với RedPeg/RedBack — TÁCH RIÊNG, không gộp:** ScheduleBack **bơm cung** (khi mua LAMP) và **ôm LAMP**; RedPeg thì **trung-lập-cung** và **cố ý không ôm LAMP** để sống sót khi LAMP sụp. Hai vai ngược nhau, nên là **hai quỹ riêng**; gộp lại sẽ phá đúng hai trụ giúp RedPeg trụ được lúc khủng hoảng.

---

#### §6.2-A. Giả định & Giới hạn — đã kiểm bằng mô phỏng tấn công (minh bạch cho cộng đồng)

Toàn bộ thiết kế trên **đã được mô phỏng kinh tế qua từng epoch và tấn công có chủ đích** (mã: `scheduleback_dyn3.py`). Dưới đây là những gì cơ chế **chịu được** và những **giả định bắt buộc** phải giữ — nếu phá giả định thì cơ chế hỏng, nên chúng tôi nói thẳng:

**Cơ chế CHỊU ĐƯỢC (trả đủ 100%, hệ vẫn còn khả năng chi trả) ở các cú sốc sau:**
- **Giá LAMP rớt sâu** (50%, 70%, 85%, kể cả rớt 80–90% chỉ trong một epoch — "flash crash"): vẫn trả đủ. Giá rớt **không** làm vỡ việc trả, vì tiền trả lấy từ quỹ đã chuẩn bị, không lệ thuộc giá.
- **Rút tiền hàng loạt (bank-run):** nghịch lý, lại làm **tỷ lệ bảo chứng tốt lên** (vì hệ bảo chứng vượt mức, người rút đổi ở mức ngang giá làm phần còn lại "đặc" hơn). Không tạo vòng xoáy sụp đổ.
- **Đăng-ký dồn đột biến / đáo-hạn cùng lúc / giá dao động răng-cưa / tiêu không hết:** cổng giới hạn và quy-tắc-tiền-nhàn-rỗi-bảo-thủ chặn được hết.

**Về "rút dồn" (tiêu nhanh hơn lịch) — KHÔNG xảy ra do thiết kế:** mỗi epoch chỉ tiêu được tối đa `pp` (trần cứng). Một mô phỏng từng thử cho phép "rút dồn" và thấy nó phá hệ ở ~3,5 lần — nhưng kịch bản đó **không thể xảy ra** vì hợp đồng giới hạn `pp`/epoch ngay từ đầu. Đây là **bản chất**, không phải lỗ hổng cần vá. (Ghi lại để minh bạch: nếu tương lai ai đó nới trần này thì hệ mới gặp rủi ro — nên trần `pp`/epoch là bất khả xâm.)

**Carry buffer-2 đã kiểm — kịch bản blackswan:** giá rớt sâu giữa kỳ (ví dụ epoch 2), đệm 2 epoch bảo vệ trước mắt; phần vốn xa-hạn đã mua LAMP đáy; khi giá hồi (epoch 4-5) bán LAMP ra → trả đủ, **bảo chứng vọt lên trên mức ban đầu** (mô phỏng: br_end 1,685, phục hồi 1 epoch). Nếu giá **không** hồi: vẫn trả đủ 100%, vì **cổng giới hạn đã bảo đảm quỹ-cứu luôn ≥ tổng nghĩa vụ** — dù carry mất sạch vào LAMP, bậc-thang-cứu vẫn gánh đủ. Cổng là tuyến phòng thủ cuối.

**Hai sự thật phải nói rõ (không giấu):**
- **"Trả đủ 100%" là đủ về SỐ LƯỢNG MAGIC, không phải về GIÁ TRỊ.** Khi tỷ lệ bảo chứng tụt sâu, MAGIC có thể mất giá trên thị trường, nên giá-trị-thực người dùng nhận có thể thấp hơn. Người dùng tiêu MAGIC vào dịch vụ trong hệ (đúng mục đích) thì ít chịu ảnh hưởng này; ai mang ra bán mới chịu.
- **Khả-năng-chi-trả của người GIỮ MAGIC tách rời việc trả cho người Đăng-ký.** Khi backing nghiêng nặng về LAMP và LAMP sụp, tỷ lệ bảo chứng có thể tụt rất sâu trong khi người Đăng-ký vẫn nhận đủ. Đây là **rủi ro cố hữu, không sửa được bằng tham số** — chỉ có thể minh bạch cảnh báo + giữ **sàn cứng phi-LAMP đủ cao** (xem điều kiện dưới).

#### §6.2-B. Tham số phải chốt trước genesis (từ mô phỏng)
1. **Trần `pp`/epoch** — là bản chất hợp đồng (bất khả xâm); muốn tiêu nhiều hơn thì ký hợp đồng gối-đầu, mỗi hợp đồng vẫn qua cổng. Carry giữ **đệm 2 epoch**, phần xa-hạn mua LAMP đáy (bình ổn) — `buffer_ep=2`, `carry_frac` quét tối ưu.
2. **Sàn cứng phi-LAMP `g_min ≥ 67%`** — mô phỏng flash crash cho thấy đây là lằn ranh sống/chết: ở `g_min ≥ 67%` hệ sống qua cả cú rớt 90% trong một epoch (tỷ lệ bảo chứng còn ~1,27, vẫn trên 1); ở `g_min = 50%` thì cú rớt 90% đẩy về ~0,99 (mất khả năng chi trả). **Nâng `g_min` từ "≥50% hướng 67%" (§6) thành "≥67% bắt buộc".**
3. **`κ = 0,6` cố định** — và **cấm thay đổi qua biểu quyết giữa vòng đời hợp đồng** (khe hở quản trị đã nhận diện).
4. **Sàn-bảo-vệ quỹ cứu:** RedBack/Kho bạc **không được rút xuống dưới ngưỡng** `pp·N/κ` khi còn hợp đồng chưa đáo hạn — nếu không, cổng đóng và toàn bộ kênh Đăng-ký tê liệt dù dòng tiền vẫn lành.
5. **Quy-tắc-tiền-nhàn-rỗi bảo thủ** (chỉ dùng phần vượt toàn bộ nghĩa vụ) — GIỮ; mô phỏng cho thấy thiệt hại do nó tối đa chỉ 0,003 tỷ lệ bảo chứng, vô hại.

#### §6.2-C. Điểm còn mở (chờ chủ dự án quyết)
- **Cách chuộc (redeem) khi backing yếu:** hiện chốt `P_redeem ≡ 1` (ngang giá, không-oracle — §8). Mô phỏng phát hiện điều này tạo **bất công thời gian** (người chuộc trước lấy hết tài sản cứng ở ngang giá, người đến sau kẹt với backing đã teo). Phương án thay thế: **chuộc theo tỷ-lệ-bảo-chứng** thay vì ngang-giá-rồi-khoá. *Đánh đổi:* bỏ bất công nhưng đụng trụ `P_redeem≡1` (vốn chống Terra + không-oracle). **[CHỜ QUYẾT]**
- **"Giá đồng loạt xuống" có gồm MAGIC mất-giá đồng thời không** — nếu có, đó là vùng phòng-thủ-giá RedPeg, cần mô phỏng riêng giá MAGIC. **[CHỜ LÀM RÕ]**

---

## §7. Bình ổn — Carpet (hai quỹ đồng cấp)

- **GreenPeg** — giữ **MintingPolicy lõi** (§3) + **độc quyền burn**. Lo **solvency** (`br < br_safe` ∨ `bad_debt > 0`). `INV-BURN-EXCL`: đốt theo `f(backing, bad_debt)`, **không** theo peg. **Không quảng cáo "đốt → tăng backing/đơn vị" như lợi ích holder**: đốt chỉ tới `br_healthy`, vượt → Treasury không-claim.
- **RedPeg** — lớp đệm phòng thủ **giá**, "vốn đỏ vô chủ" (nguồn = lát phí ổn định + phí vận hành). **Trung lập cung** (`INV-RF-3'`). Chỉ kích khi **peg đỏ** (`d_internal ≥ d_red ∧ br ≥ br_safe`). **MUA MAGIC trên DEX bằng doanh thu vô chủ** (KHÔNG nhận MAGIC trader nộp — pooling = CISA/AIFMD) → giữ reserve → bán lúc over-peg. `F-tài-sản'`: MAGIC-reserve **không đếm vào backing**. `INV-RF-CAP` (≤25% NAV, co về 0 khi backing yếu), `INV-RF-UNWIND`. Rổ **không chứa LAMP**; sàn cứng `g_reserve_min > 0` từ tranche stable bất khả xâm.
- **RedBack** — chế độ phòng thủ peg-đỏ, KHÔNG phát chứng từ tài chính (xem §8).

---

## §8. RedBack — chế độ phòng thủ peg-đỏ (BỎ RedCheque tài chính)

**Quyết định (sau hệ chuyên gia, 4 lăng kính hội tụ): BỎ phần tài chính RedCheque** (`INV-NO-REDCHEQUE`). Lý do:
1. **Bất khả cơ học:** bỏ pooling (RedPeg tự mua-DEX) thì biến `q_E` ("MAGIC trader nộp") biến mất → `V_redeem` sụp; và giao thức **KHÔNG quan sát được** lệnh-mua-cứu-peg vs lệnh-mua-lướt-sóng (cùng một swap trên cùng DEX). Mọi cách gate lại buộc tái lập sự-kiện-nộp = chính pooling vừa bỏ.
2. **Động cơ cứu-peg KHÔNG khan hiếm:** `P_redeem ≡ 1` (oracle-free) làm **arbitrage tự thưởng** — mua MAGIC dưới par → đóng CDP xoá đúng 1 nợ par → ăn ngay biên `d_internal`, không trần, mở cho mọi người (cơ chế PSM kiểu DAI). Thị trường tự trả công người mua đáy.
3. RedCheque **không nâng trần phòng thủ** (không nhận vốn mới), chỉ thêm bề-mặt Howey-4 + Reves. ROI âm.

**RedBack là một REGIME ba trạng thái (MECE), không phải một công cụ:**

| Trạng thái | Điều kiện | Phòng thủ |
|---|---|---|
| **Peg XANH** | `d_internal < d_red` | Arbitrage nội sinh đủ; không quỹ can thiệp |
| **Peg ĐỎ** | `d_internal ≥ d_red ∧ br ≥ br_safe ∧ bad_debt=0` | **3 lực** (dưới); SnapshotMint khoá (`cap=0`) |
| **Backing ĐỎ** | `br < br_safe ∨ bad_debt > 0` | GreenPeg/solvency: khoá mint toàn mạng, Insurance hấp thụ — **KHÔNG thuộc RedBack** |

**Ba lực phòng thủ ở Peg-ĐỎ (xếp theo vai):**
- **Lực 1 — Arbitrage-PSM (CHÍNH, sàn cứng):** vốn của trader, biên lời `= d_internal`, không trần, không bề-mặt-pháp-lý, tự khuếch đại theo độ sâu depeg. `P_redeem≡1` neo cận dưới.
- **Lực 2 — RedPeg mua-DEX bằng vốn-vô-chủ (bổ trợ):** mua MAGIC rẻ → giữ reserve (`F-tài-sản'`: không đếm backing) → bán Dutch-auction khi `TWAP > P_redeem·(1+δ_sell)`, `δ_sell > δ_buy` (mỗi chu kỳ `ΔNAV>0`). **Trung lập tổng cung** (`INV-RF-3'`). Trần `INV-RF-CAP` (≤ min(25%·NAV, κ·C_circ), co về 0 khi `br→br_safe`). KHÔNG nhận tài sản trader. Rổ không-LAMP, sàn `g_reserve_min>0`.
- **Lực 3 — Insurance/`g_min` (CHỈ khi chuyển sang Backing-ĐỎ, KHÔNG bắn ở peg-đỏ thuần):** vì peg-đỏ theo định nghĩa `br ≥ br_safe`, Insurance là công cụ **solvency**, chưa kích. Khi sóng-nối-sóng kéo `br < br_unwind` → `INV-RF-UNWIND`: RedPeg cắt-lỗ-xả-kho, trả công cụ về GreenPeg-burn (chuyển miền).

> **Đính chính tầng:** cụm cũ "RedPeg + Insurance phòng thủ peg-đỏ" **lệch tầng** — ở peg-đỏ thuần chỉ có Lực 1 + Lực 2; Insurance thuộc miền backing-đỏ liền kề.

**Lớp ghi-công phi-tiền TUỲ CHỌN (phương án C — không bắt buộc cho phòng thủ):** **RedGuard Badge** = DID-attestation cấp cho ví đã net-buy MAGIC trong cửa-sổ-đỏ (đọc sau-sự-thật từ DEX-fill của ví đã-gắn-PhoenixKey; KHÔNG nộp/khoá/claim, KHÔNG tiền, KHÔNG chuyển nhượng → ngoài Howey/Reves/CISA/MiFID tuyệt đối). Có thể feed C3-uy-tín (Governance, ngoài phạm vi). Biến coordination-failure nhẹ của Lực-1 thành lực-kéo-xã-hội, không tốn pháp lý. Phụ thuộc `did_commit` thật (giao Long). Nếu attribution không rẻ/sạch → bỏ luôn C, giữ A thuần.

**Cần dọn (mâu thuẫn nội bộ trước genesis):** Math `§4.1 q_E` + Feat `§3.4` ("đóng MAGIC vào RedPeg") vẫn là pooling cũ → **xoá `q_E`, `V_redeem`, series**. `Đủ phòng thủ không`: cần mô phỏng xác nhận ngân-sách-vốn-vô-chủ ≥ vài %·C_circ + độ-sâu-DEX (POL) dưới stress; điểm yếu A = cú bán ≥5% cung khi DEX float mỏng → bù bằng nâng-trần-vốn-vô-chủ + POL (rẻ + sạch hơn RedCheque).

---

## §9. Cung tiền — đáp án câu hỏi bảo toàn vs GreenPeg-mint

**Cung bám-backing, một token, hai đường — không phải nhị phân:**
- GreenPeg **mint** qua hai đường (CDP + SnapshotMint) và **thu lại** qua đóng-CDP + đốt-phí. Đúng vế "GreenPeg mint + thu back từ cộng đồng theo phương thức CDP" mà anh nêu.
- "Bảo toàn/siết nhỏ" áp cho **riêng nhánh SnapshotMint**: trần `cap(br)` giữ phần seigniorage rất nhỏ và chỉ trong thặng dư.
- Mọi MAGIC đều có-back ở **mức hệ** (`br ≥ br_safe`). Không có MAGIC nào ra đời ngoài over-collateralization.

**Bất biến cung:** `Σ MAGIC ≤ B / br_safe`, với `B` có sàn cứng non-LAMP `B_hard ≥ g_min`.

### §9.1 Bootstrap (khởi động lạnh) — ví dụ GreenSun tạo OrgDID

Tình huống: chưa có MAGIC nào, LAMP chưa có giá DEX. GreenSun muốn tạo OrgDID (tốn 1 MAGIC).

**Thứ tự khởi động (CDP đi trước, SnapshotMint theo sau):**
1. **Genesis đặt hai mốc hiến pháp:** (a) `base_price` — 1 MAGIC = một rổ dịch vụ nền (định nghĩa **sức mua** MAGIC, độc lập giá LAMP); (b) **giá LAMP khởi tạo** (từ phân phối/IDO, tính bằng ADA) — dùng cho `MCR` tới khi có thanh khoản DEX, sau đó chuyển sang TWAP.
2. **MAGIC đầu tiên = từ CDP, KHÔNG từ SnapshotMint.** SnapshotMint cần thặng dư backing (`br > br_safe`) — genesis chưa có backing nên `cap_surplus = 0`, SnapshotMint **chờ**. Vậy GreenSun mở CDP: khoá LAMP trị giá **≥ 200% × 1 MAGIC** (theo giá LAMP khởi tạo) → đúc 1 MAGIC. **Cái MAGIC đầu tiên này được back bằng chính LAMP GreenSun khoá** (over-collateralized 200%).
3. **MAGIC sau khi đúc đi đâu:** GreenSun tiêu 1 MAGIC tạo OrgDID. Chia hai dòng (§5): **phí mạng (cut)** → đốt tới `br_healthy`/Treasury; **phần provider** → bên cung cấp hạ tầng định danh (nếu thuần giao thức thì cũng về Treasury). Sau tiêu, 1 MAGIC rời lưu thông (đốt/Treasury).
4. **Trạng thái GreenSun sau cùng:** một CDP mở (LAMP khoá, **nợ 1 MAGIC**), 0 MAGIC trong ví. Muốn đóng CDP lấy LAMP về, GreenSun phải tái-tạo 1 MAGIC (mua trên thị trường hoặc đúc tiếp). Đây là vị thế nợ CDP bình thường — đúng cơ chế.
5. **SnapshotMint bật khi nào:** sau khi nhiều CDP tạo nền backing có thặng dư (`br > br_safe`) và LAMP có thanh khoản DEX cho oracle. Lúc đó GreenSun nắm LAMP dài hạn + tiêu thật → bắt đầu nhận cashback (hoàn một phần phí), tài trợ bằng thặng dư.

**Chốt:** không có "mint từ hư không" lúc genesis. Đồng MAGIC đầu tiên luôn có thế chấp LAMP 200% qua CDP. Vòng xoáy khởi động đến từ **nhiều bên cùng mở CDP + giao dịch**, không từ seigniorage. SnapshotMint là tầng-khuyến-khích-thứ-hai, không phải nguồn-khởi-động.

---

## §10. Đã loại bỏ + chuyển phạm vi

- **Xoá hẳn:** uỷ quyền (`SetDelegate`/`personal_delegate`), **VacuumGen** (hai-pha khoá-tỉ-giá — vô nghĩa khi `P*=1`, trục locked-rate sụp), **ScheduleCheque** (chứng-từ-hứa-trả-tương-lai = Reves-note, tái tạo RedCheque đã bỏ), mô hình "MAGIC = số kế toán không-token", **decay token lưu hành**, lớp tín dụng `M_cred`.
- **InstantGen / ScheduleGen — KHÔNG xoá, mà TÁI SINH dưới dạng mới** thành hai chế độ của SnapshotMint (§6/§6.2): "Tiêu-ngay" (Instant) và "Đăng-ký-trước" (Schedule + ScheduleBack). Bản mới KHÁC bản generator cũ: đúc-trong-thặng-dư, có cổng-theo-số-dư-nội-bộ, không khoá-tỉ-giá, không chứng-từ-chuyển-nhượng.
- **Thay:** MAGIC thành **native token** một policy-id; `ConsumeMAGIC` đổi từ "giảm batch kế toán" sang "chuyển/đốt token + ghi sự kiện". (Thay đổi kiến trúc lớn ở repo MAGIC — ghi nhận, triển khai sau.)
- **Chuyển cho Governance (ngoài phạm vi tài liệu này):** VotingPower/C1–C4. Ghi nhận của anh: VP đọc **LAMP nắm giữ tại snapshot** (hoặc trung bình 6 snapshot gần nhất), **không bao giờ khoá LAMP**. Tiêu chí sẽ chỉnh **sau khi token nhất quán**. Tài liệu này chỉ giữ một móc: sự kiện tiêu có `consumption_id` + `did_commit` để Governance đọc.

---

## §11. Định vị pháp lý

**Tiền đề nhất quán:** MAGIC là **tài sản tiện ích chuyển-nhượng**, cùng nhóm tuân thủ với LAMP và CARP — khác ở chỗ MAGIC **ổn định** (neo sức-mua-dịch-vụ) và **có back nội+ngoại sinh**. Nếu LAMP (chuyển nhượng, có utility+governance) và CARP (chuyển nhượng) tuân thủ được, MAGIC tuân thủ trên **cùng cơ sở**. Cho LAMP lên sàn thì MAGIC cũng lên sàn — DEX-chuyển-nhượng KHÔNG tự nó phá tuân thủ (lập luận "closed-loop-hoặc-vỡ" trước là sai khung).

1. **Phân theo bản chất, không theo tên** — gộp tên trung tính.
2. **Ngoài stablecoin-FIAT (chắc):** EMT/payment-stablecoin/SCS/FRVA/EPI/FRS đều đòi neo fiat; MAGIC neo đơn-vị-dịch-vụ → ngoài. Lá chắn mạnh nhất.
3. **MAGIC = đơn vị thanh toán tiện ích chuyển-nhượng (utility settlement asset):** định vị như LAMP — token tiện ích giao dịch được, giá trị từ công dụng (mua dịch vụ nội hệ + thế chấp + governance), không phải kỳ-vọng-lợi-nhuận-từ-promoter. Mỏ-neo-dịch-vụ làm yếu Howey **prong-1/3**. DEX-niêm yết không phá điều này (đồng nhất với LAMP/CARP).
4. **SnapshotMint cashback = thưởng-tham-gia kiểu STAKING, KHÔNG phải lợi-tức-chứng-khoán-thụ-động** (sửa đánh giá bề mặt trước):
   - **Prong-1 "đầu tư tiền": yếu** — quyền M không được mua; LAMP nắm vì utility, không bỏ tiền RA để lấy quyền cashback.
   - **Prong-4 "nỗ lực người khác": yếu** — thưởng cho **nỗ lực của chính người tham gia** (stake LAMP vào ổn định qua thời gian + chi tiêu cứu peg khi đỏ) + vận hành **cơ học DAO phi tập trung, tự lưu ký**. Đây là cấu hình **staking reward PoS** (ADA/ETH), không phải investment-contract. Tích phân-6-epoch = stake-theo-thời-gian củng cố phép so.
   - **Hai vai trò tách bạch:** cashback (người tham gia, không đầu tư tiền) ≠ RedCheque (người KHÁC mua vào hỗ trợ — đây mới có "đầu tư tiền", đã giảm bằng nhánh A không-chuyển-nhượng).
   - **Rủi ro còn lại (trung thực):** phép-staking đòi DAO **đủ phi tập trung** (giai đoạn đầu còn promoter → rủi ro cao hơn); Mỹ chưa ngã ngũ về token-staking (ADA/SOL bị nêu trong vài đơn SEC); staking-AS-A-SERVICE custodial mới nguy — cashback ta là cơ-học-tự-lưu-ký → dạng an toàn. Rủi ro **mức staking**, không phải mức investment-contract. EU/CH/SG/UAE đãi tốt hơn Mỹ.
5. **ART (MiCA) — chưa chắc ngoài:** ART neo "any value"; `base_price` là "a value". Art.39 đòi mọi-holder-chuộc-par xung đột kiến trúc CDP. Cần luật sư EU.
6. **Rủi ro còn lại:** Reves/MiFID qua RedCheque (giảm bằng nhánh A); **CISA/AIFMD** nếu pool tài sản (né bằng RedPeg mua-DEX); không tuyên "zero-oracle" (cấu trúc DAI).
7. **Mâu thuẫn nội bộ phải gỡ:** `MathCARP §20.4` "No interest paid to holders" >< `D883/977` (LAMP holders 25% phí + 10% thanh lý). Phải nhất quán: **route → Treasury không-claim** (mạnh cho cả chống-Howey-4 LẪN chống-CIS, vì không-ai-có-quyền-đòi rõ hơn dư-trả-holder); giữ tỉ lệ, đổi đích.

**Kết luận (cân bằng, không phóng đại hai chiều):** MAGIC là **tài sản tiện ích ổn định chuyển-nhượng**, tuân thủ trên cùng cơ sở LAMP/CARP. Ngoài stablecoin-FIAT (chắc). Cashback = **staking-like** (rủi ro mức staking, không phải security thụ động — em đã sửa đánh giá bề mặt). "Tuân thủ tuyệt đối không vùng xám" vẫn bất khả cho mọi token chuyển-nhượng (đúng với cả LAMP/CARP/MAGIC) — nhưng MAGIC KHÔNG ở mức rủi ro cao hơn LAMP/CARP. Cần luật sư đa tài phán cho: ART-Art.39, RedCheque-Reves, độ-phi-tập-trung-DAO cho khung staking.

---

## §12. Bất biến tối cao

- **INV-NO-UNBACKED:** `Σ MAGIC ≤ B / br_safe`; SnapshotMint chỉ đúc vào thặng dư `br − br_safe` (với `B` đã haircut LAMP), phanh tự tắt.
- **INV-MINT-TWO-PATH:** mọi mint qua đúng một trong hai vị từ §3; không nhánh ba.
- **INV-CASHBACK-BOUND:** cashback/DID/epoch ≤ **phần phí THỰC-ĐỐT** của DID đó (≤ `protocol_cut`); tổng ≤ `cap_surplus(br)`; `M = 0` khi backing ĐỎ (`br ≤ br_safe`).
- **INV-STAKE-ACTIVE:** cashback luôn đòi **hành vi tiêu-thật trong epoch** (không thuần nắm-giữ) — giữ tính staking-tham-gia, tách khỏi lợi-tức-thụ-động.
- **INV-CDP-NO-HARM:** SnapshotMint đúc-từ-thặng-dư pha loãng **buffer chung** (ảnh hưởng MAGIC-holder), KHÔNG đụng collateral/nợ của CDP-holder; giữ nhỏ + `cap` để `br' ≥ br_safe` + `cap=0 khi depeg` → dilution bị chặn, không hại quyền CDP. (CDP-holder là con-nợ; MAGIC chớm dưới par còn lợi cho họ lúc trả nợ.)
- **INV-HARD-FLOOR:** `B_hard` (non-LAMP) ≥ `g_min`. **`g_min ≥ 67%` (nâng từ ≥50% — mô phỏng flash crash §6.2-B cho thấy 67% là lằn ranh sống/chết: ở 67% sống qua cú LAMP rớt 90%/1-epoch, ở 50% thì vỡ khả-năng-chi-trả).** [chờ chủ dự án chốt cứng]
- **INV-NO-EXTERNAL-INPUT (nguyên tắc bất di bất dịch):** cơ chế lõi (cổng Schedule, kích waterfall, mọi ngưỡng/quyết-định on-chain) **chỉ căn số dư nội bộ**, **KHÔNG dùng giá thị trường / oracle ngoài**. Mục tiêu: minh bạch tuyệt đối + không bề-mặt-thao-túng. (Giá LAMP chỉ vào `B` để TÍNH-BÁO-CÁO `br`, không điều khiển cơ chế.)
- **INV-SCHEDULE-GATE:** ScheduleMint nhận hợp đồng tới khi `Σ nghĩa-vụ-còn-lại ≤ κ·hard_cap`, `hard_cap` = số-dư-quỹ-cứu-nội-bộ (RedBack+platform+Treasury), `κ≈0,6` **cố định, cấm đổi-động qua biểu quyết giữa vòng đời**. Schedule co-giãn theo sức-tải thật, không phình.
- **INV-SCHEDULE-CAP-PER-EPOCH:** tiêu **tối đa `pp`/epoch** là TRẦN bản chất by-design (không rút-dồn được; tiêu thêm phải ký hợp đồng gối-đầu qua cổng). Bất khả xâm. Quỹ-cứu không được rút dưới `pp·N/κ` khi còn hợp đồng chưa đáo hạn.
- **INV-SCHEDULE-CARRY-BUFFER:** ScheduleBack giữ đệm `buffer_ep=2` epoch nghĩa-vụ; chỉ phần xa-hạn dùng mua-LAMP-đáy (bình ổn ngược-chu-kỳ, bán khi giá hồi). An toàn vì cổng đảm bảo quỹ-cứu ≥ tổng nghĩa-vụ → carry mất sạch thì waterfall vẫn gánh đủ (deliver 100% bảo toàn).
- **INV-SCHEDULE-NEUTRAL-VS-RED:** ScheduleBack TÁCH khỏi RedPeg (ScheduleBack bơm-cung+ôm-LAMP vs RedPeg trung-lập-cung+không-LAMP); không gộp ngân sách (tránh tranh-đạn lúc khủng hoảng).
- **INV-NO-PASSIVE-YIELD:** không dòng giá trị **thuần-thụ-động** (phí/thanh lý/rổ-tràn) về holder chỉ-theo-số-dư-không-hành-vi → route Treasury không-claim. (KHÁC cashback staking: cashback đòi tiêu-thật.)
- **INV-PEG-ENDO:** `P*=1` theo `base_price`; oracle-free ở chuộc-par, oracle-dependent ở thế-chấp.
- **INV-NO-REDCHEQUE:** không phát chứng từ tài chính nào cho trader cứu-peg; đóng-góp được thị-trường tự trả qua arbitrage (`P_redeem≡1`). Xoá `q_E`/`V_redeem`/series.
- **INV-BURN-EXCL / INV-RF-3' / F-tài-sản' / INV-RF-CAP / INV-RF-UNWIND:** như §7-§8.

---

## §13. Việc tiếp + tiền điều kiện

**Đã chốt:** RedCheque **nhánh A** (§8); một policy-id; SnapshotMint đúc-có-back tích-phân-6-epoch (staking), cổng regime (`M=0` khi đỏ); đổi tên GreenPeg/RedCheque/SnapshotMint; khung pháp lý **staking-reward** (§11); 7 điểm dòng-tiền-holder → Treasury không-claim. **Sau hệ chuyên gia tiền tệ:** **MCR giữ 200%** (BÁC ≥300% — phản tác dụng, §4); **hệ BA VAN** phân-miền theo bản chất giao dịch (§5); **BÁC burn-on-spend-có-tên** (P2 — bất khả toán học, lợi-ích-provider đi qua split §5.1); **escrow trung-lập-cung** (§5.2); **Pot-M = trần-suất-mỗi-epoch** (không bể tích luỹ, §6.1).

**Cần anh chốt:** (1) trọng số `wᵢ` + số epoch tích phân; (2) **`g_min ≥ 67%` bắt buộc** (mô phỏng flash crash xác nhận lằn ranh — §6.2-B); (3) `protocol_cut_bps`; (4) cọc escrow `B = max(B_min, η·V_job)` quét `η`; (5) đa dạng collateral — chờ stress-test. **ScheduleMint (mới):** (6) cách chuộc khi backing yếu — giữ `P_redeem≡1` (có bất-công-thời-gian) hay đổi chuộc-theo-tỷ-lệ-bảo-chứng (đụng trụ); (7) "giá đồng loạt xuống" có gồm MAGIC mất-giá đồng thời không (cần mô phỏng giá MAGIC riêng nếu có); (8) `κ` cổng (đề xuất 0,6) + `pp`/`N` biên hợp đồng.

**ScheduleMint đã kiểm bằng mô phỏng động + tấn công MECE** (§6.2-A): chịu được sốc giá sâu/flash, bank-run, đăng-ký-dồn, đáo-hạn-đồng-pha; điểm yếu DUY NHẤT = rút-dồn (đã khoá bằng `INV-SCHEDULE-CONSUME-LOCK`). Mã: `scratchpad/scheduleback_dyn3.py`.

**Tham số cần mô phỏng (từ hệ chuyên gia):** MCR 200/250/300 dưới stress LAMP −50/−70/−85%; độ co giãn cầu `ε` theo phân khúc (quyết P1 hút hay đẩy LAMP); độ sâu DEX-LAMP theo MCR; buffer `MCR_đúc→LR` vs `σ_epoch`; `f` + `cap_surplus(br)` (overhang nếu tích luỹ); tham số FIR `demand_mult`/ScarcityWeight cho phí-bất-đối-xứng; tương tác `GLOBAL_LAMP_CAP 30%` với MCR.

**Trong ranh giới em:** dọn self-characterization spec nền (đang làm); tham số hoá `cap(br)`, `f`, `br_safe`, `br_healthy`.

**Cross-repo — giao Long (Claude KHÔNG sửa PhoenixKey):** `did_commit = #""` rỗng → blake2b256 thật + PhoenixKey-liveness chống bán-DID (tiền điều kiện cho cashback-gating + chống farm).

**Tiền điều kiện trước genesis:** stress-test LAMP −50/−70/−85% → đo %CDP under-collateral, độ sâu DEX-LAMP, bad_debt, Insurance còn ≥target, vòng loãng; xác nhận `B_hard` đủ đáy. Chưa có thì INV-NO-UNBACKED là khẩu hiệu.
