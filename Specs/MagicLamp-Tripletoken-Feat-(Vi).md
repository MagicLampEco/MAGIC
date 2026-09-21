# MagicLamp — Đặc tả Kỹ thuật Bộ-Ba-Token (LAMP · MAGIC · CARP)

> **Tài liệu:** `MagicLamp-Tripletoken-Feat-(Vi).md` — đặc tả kỹ thuật cho **chuyên gia và lập trình viên**.
> **Đối tượng:** người triển khai on-chain/off-chain, kiểm toán, tích hợp. Phần diễn giải phổ thông (câu chuyện, pháp lý cho người dùng) nằm ở bản công bố `Launch/Whitepaper-MagicLamp-Tokenomic-(Vi).md` — tài liệu này **tham chiếu tới** bản đó, không lặp lại.
> **Phạm vi:** hợp nhất đặc tả **GenMAGIC** (§6) và **ConsumeMAGIC** (§7) vào một nơi. Cơ chế ổn định CARP chi tiết ở `CarpetMint-Core-Spec-Vi.md` (tài liệu này chỉ nêu giao diện).
> **Phiên bản:** v2.1 — 2026-09-19 (xem Changelog 2026-09-19 ngay dưới). v2.0 — 2026-09-17. Nâng cấp từ bản chưa đánh số (mốc Changelog cuối 2026-08-04) vì chủ dự án chốt 2026-09-17 **mô hình sinh MAGIC chung** cho InstantGen và ScheduleGen: cùng ba đầu vào `L` (LAMP trong vault) · `usage_ratio` (consumed/generated, 6 epoch đã qua) · `GB` (thặng dư GreenBack), khác nhau chỉ ở thời tính. Bản trước lấy độ lớn InstantGen từ MAGIC-đã-tiêu tuyệt đối (`g(consumed)`), nên người tiêu 0 nhận 0 — trái ý định trên và chặn người mới có MAGIC ngay. Bump MAJOR vì công thức sinh và bất biến `INV-MAGIC-CITIZEN` đổi nghĩa, kéo theo đổi datum vault ⟹ vault phải deploy lại (§6.1.6).
> **Vai:** spec build-fact tokenomics MAGIC, sống trong repo MAGIC (chủ dự án chốt 2026-08-04: tài liệu chính chủ về MAGIC nằm trong repo MAGIC; whitepaper /Launch + tài liệu LAMP chỉ **tham chiếu**, KHÔNG định-nghĩa-lại). Khi lệch với `MagicLamp-3Token-DacTa-Vi.md`, GenMAGIC/ConsumeMAGIC rời hoặc whitepaper /Launch → tệp này thắng. Khi lệch với MÃ đang chạy → mã là dữ kiện về hiện trạng, lệch phải được ghi ra (không im lặng chọn bên).
>
> **Changelog 2026-09-19 (v2.1):** chủ dự án chốt bốn điểm treo của mô hình sinh (§13, bảng
> *"ĐÃ CHỐT 2026-09-19"*): `CC-GEN-GB-ROLE` · `CC-GEN-SCHEDULE-FIXED` · `CC-GEN-COLD-START` ·
> `CC-GEN-L-TIMING`; và `B` thành một DANH MỤC token (§6.3 F6). **Bump MINOR, không MAJOR:**
> bốn mục là quyết định cho các điểm ĐÃ ĐƯỢC ĐÁNH DẤU treo trong v2.0, không mục nào lật một
> công thức hay một bất biến của v2.0 — `INV-MAGIC-CITIZEN` và `F(L, usage_ratio, GB)` giữ
> nguyên nghĩa. Thêm `CC-GEN-LOCK-FIELD` vào danh mục CHƯA CHỐT (§6.1.4).
>
> Vì sao phải có mục này: bản trước ship bốn quyết định 19/09 dưới nhãn *"v2.0 — 2026-09-17"*,
> nên hai tài liệu khác nhau về HÀNH VI cùng mang một số phiên bản, và `BOUNDARIES.md` trỏ
> *"SPEC v2.0 §13"* thì người tra không phân biệt được bản nào. Một con trỏ có số phiên bản mà
> số đó không phân biệt được hai bản thì nó chỉ trông như đã ghim.
>
> **Changelog 2026-09-17 (v2.0):** (1) §6.1.1–§6.1.6 mới: công thức sinh chung `F(L, usage_ratio, GB)` kèm `scale_limit`, định nghĩa cửa sổ đếm và bắn bù, beacon GreenBack mô phỏng + bộ đếm shard, khoá `INV-INSTANT-LOCK` tách theo script vault, bảng quyền đặc quyền, thời điểm hiệu lực; (2) §6.3 viết lại theo mô hình chung, bỏ `reward(consumed)` khỏi công thức cấp; (3) §6.4 thêm đầu vào chung chốt lúc ký; (4) `INV-MAGIC-CITIZEN` + `INV-CASHBACK-BOUND` viết lại (§2, §12); (5) §6.2 `eligibility` GIỮ nguyên văn, gắn CHƯA CHỐT vì không còn cơ-sở-tính để nhân.
>
> **Changelog 2026-08-04 (chốt; mục (3) bị thay ở v2.0):** (1) §6.2 tư-cách đổi tên biến sang **tiếng Anh** (`eligibility/ageFactor/consumedFactor/offPeakFactor/commitFactor`) + công thức TỔNG-CÓ-TRỌNG-SỐ tường minh (Σw=1.5Q); (2) **`ageFactor` hiện thực bằng EMA số-dư-vault (α=1/6)** thay per-UTXO — GIỮ chính sách thâm-niên-LAMP 6-epoch, né O(n)/DoS/laundering; (3) §6.3 thêm `reward = g(consumed)×eligibility` + ràng buộc `g ≤ 0.4·consumed`; (4) §4.1 + §12 thêm **`INV-VAULT-IDENTITY`** (NFT one-shot, chặn lỗ vault-bịa-2-ADA đã dựng PoC). Chuẩn-hoá 4 hàm rᵢ + slope g → dựng math + vector, chốt ở PR.

---

## §0. Tóm tắt — ba token, ba vai không thể gộp

Hệ MagicLamp có **ba token** với ba vai loại trừ nhau:

- **LAMP** — tài sản nền. Cố định **36 tỷ, không mint thêm, không burn** (giảm lưu hành = chuyển Treasury kế toán). Nguồn sinh MAGIC; tài sản tham gia governance (không token-weighted); nguồn backing hợp đồng tín dụng MAGIC.
- **MAGIC** — quyền-tiêu-dịch-vụ. **Không phải token** (không policy-id, không mint): là **số kế toán trong vault datum**, gắn **VÍ** (khoá thanh toán của chủ vault), **không chuyển nhượng**. PersonDID đi kèm để **quy kết**, không để gác quyền — xem `INV-MAGIC-WALLET-BOUND` (§bất biến). Sinh mỗi epoch, **dùng-hết-trong-epoch-hoặc-mất** (§4). Chỉ chuộc-ra-dịch-vụ, không ra tiền.
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
  1. **Không chuyển nhượng** — không có đường nào chuyển MAGIC từ vault này sang vault khác.
     🔴 **Người tiêu được là chủ VÍ, không phải chủ PersonDID** (chốt 2026-09-12, sửa SPEC cho
     khớp mã đang chạy). Bản cũ của dòng này viết *"chỉ chủ PersonDID tiêu được"* và câu đó
     **chưa bao giờ đúng với mã**: `consume.ak` gác cả ba đường bằng
     `list.has(tx.extra_signatories, <datum>.owner)` (`:238` Consume · `:320` BindDID · `:408`
     đúc thread), và `owner` là `paymentCredential.hash` của ví
     (`scripts/deploy/09_deploy_consume.ts:116-119`). `did_commit` chỉ bị kiểm ĐỘ DÀI và ép bất
     biến (`consume.ak:416-422`, `:759`) — không chỗ nào đối chiếu nó với một chữ ký.
     ⟹ ai giữ khoá thanh toán của ví đó tiêu được MAGIC của thread đó.
  2. **Per-epoch, dùng-hoặc-mất** — sinh ở epoch nào phải tiêu ở epoch đó; snapshot epoch sau **reset về 0** (§4). Không tích trữ, không cộng dồn.
  3. **Không chuộc ra tiền** — chỉ chuộc-ra-DỊCH-VỤ. Không đổi ngược thành LAMP/CARP/fiat.
  4. **Không là token** — là số kế toán trong vault datum; **Gen ≠ Mint**. Cấm viết "mint MAGIC".
- **Đơn vị:** `nanogic = MAGIC × 10⁹` (BigInt, không dùng `Number`).
- **Sinh từ 3 cửa** (§6): InstantGen · ScheduleGen · PrepaidGen.
- **Backing — hai thứ khác nhau, đừng gộp.** (a) Thứ người cầm MAGIC có: **năng-lực-cung-dịch-vụ của hệ** (mô hình gift-card). MAGIC **không** mang quyền đòi một tài sản nào. Vì không hứa chuộc-ra-tiền → thoát khung stablecoin + thoát bài toán Terra. (b) Thứ GreenBack giữ để đo khả năng thanh toán: **`B` — một danh mục tài sản có giá** (§6.3). `B` không phải quyền của người cầm MAGIC; nó là mẫu số của một tỷ lệ nội bộ.

  > Bản trước của dòng này viết *"KHÔNG rổ tài chính"* đứng trơ, và câu đó **đã mâu thuẫn với `br = B/S` từ trước khi `B` được chốt thành danh mục** — một đại lượng được oracle định giá thì tự nó đã là một rổ tài sản. Chỗ đúng của chữ "không rổ tài chính" là vế (a), về quyền của người cầm; đặt nó ở chỗ nói về `B` là khai sai một vế và làm hỏng vế kia. Nhà CarpetMint nêu chỗ lệch này 2026-09-18.
- **Pháp lý:** consumptive-use thuần (Howey prong-3 gãy), không e-money, không payment-instrument. Chi tiết: whitepaper §10.

### §1.3 CARP — đồng-thanh-khoản ổn định (lớp lưu-hành)
- Native token, **policy-id riêng**, chuyển nhượng trong hệ. Neo sức-mua-dịch-vụ nội sinh, **KHÔNG neo fiat**.
- Giữ giá bằng **sàn-tiện-ích** (CARP luôn đổi được sang MAGIC để tiêu; PrepaidGen 1:1 + PSM-par nội bộ) + **3-back** (GreenBack/VacuumBack/RedBack) + Backstop. Chi tiết + tham số: `CarpetMint-Core-Spec-Vi.md`.
- Pháp lý: utility fiat-neutral (thoát EMT; khả năng bị phán ART còn — ESMA xét substance). Chi tiết: whitepaper §10, `CarpetMint-Core-Spec-Vi.md`.

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
| **F6-NO-EXTERNAL-INPUT** | Cổng/ngưỡng solvency chỉ căn số-dư-nội-bộ; oracle **CHỈ định-giá `B`** (một nguồn giá cho TỪNG tài sản trong danh mục — §6.3), KHÔNG điều khiển cổng. |
| **INV-MAGIC-CITIZEN** | Lượng sinh từ LAMP = `F(L, usage_ratio, GB)` (§6.1.1): tiêu thụ thật vào công thức qua **tỷ lệ** `usage_ratio` (điều tiết), không qua độ lớn tuyệt đối; MAGIC **đang cầm** không vào công thức; MAGIC hết hạn không tính là đã tiêu. Quyền lực (VP C1, §10) vẫn keyed MAGIC-đã-tiêu cross-DID. |
| **INV-VAULT-IDENTITY** | Vault hợp-lệ PHẢI mang `vault_id_nft` one-shot; validator kiểm NFT tại MỌI điểm đọc `lamp_balance`/`magic_batches`, KHÔNG chỉ khớp địa-chỉ-script (chặn datum bịa 2-ADA — §4.1). |

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

**Hình dạng nhị phân là hợp đồng, và nguồn của nó là mã, không phải khối dưới đây.**
Đọc `InstantGen/onchain/lib/magiclamp/protocol/types.ak` — `pub type MagicBatch`. Khối dưới
đây là ảnh chụp cho người đọc; lệch một trường hay một thứ tự là đổi cách decode, và mọi UTxO
đã tạo trên chain sẽ không đọc được nữa.

```
MagicBatch {                                      // 9 TRƯỜNG — đếm lại trước khi encode
  batch_id            : ByteArray,   // định danh batch (chống trùng)
  source              : BatchSource, // ENUM, không phải Int — xem bảng bia mộ dưới
  created_epoch       : Natural,     // epoch sinh — quyết định sống/chết
  initial_amount      : Natural,     // bất biến, để soát sổ (KHÔNG bỏ)
  current_amount      : Natural,     // nanogic còn lại (chỉ BurnBatch giảm)
  decay_window        : Natural,     // = 1 (cliff, per-epoch) — xem §4.2
  profile_at_creation : Option<ActivityProfile>,  // Some(P) khi Snapshot; None các cửa khác
  contract_id         : Option<ByteArray>,        // Some với Schedule; None các cửa khác
  halved              : Bool,        // TRƯỜNG CHẾT dưới mô hình cliff. Giữ để hình dạng
                                     // 9 trường còn tương thích byte với datum đã deploy.
                                     // KHÔNG có ràng buộc nào từ chối `halved == True`:
                                     // validator chỉ ĐẶT nó False lúc tạo batch. Đừng dựa
                                     // vào nó như một bất biến.
}
```

`source: BatchSource` là enum, chỉ số constructor đã lên chain: `Snapshot=0, Instant=1,
Vacuum=2, Schedule=3`. `Snapshot` và `Vacuum` là **bia mộ** — hai cửa sinh đó đã bỏ khỏi mô
hình, nhưng variant phải nằm nguyên chỗ cũ. Đánh lại số cho gọn là vỡ decode mọi UTxO đã tạo.

**`VaultDatum` PHẢI gắn NFT định-danh one-shot (`vault_id_nft`) — bất biến `INV-VAULT-IDENTITY` (rà soát đối kháng 2026-08-04, chặn lỗ mức-chặn-mainnet đã dựng PoC).** Mỗi vault hợp-lệ mang một **NFT mint one-shot** (policy neo `output_reference` genesis, gắn PersonDID chủ qua `I-PERSON-5`). Validator `consume` + mọi cửa gen PHẢI kiểm `vault_id_nft` có mặt & đúng policy tại **MỌI** điểm đọc `lamp_balance` / `magic_batches` — **KHÔNG được chỉ khớp địa-chỉ-script** (`is_at_script`). Lý do: nếu chỉ khớp địa-chỉ, kẻ tấn công trả **~2 ADA** tạo UTxO tại địa-chỉ vault với datum bịa `magic_batches:[{current_amount: 10¹⁸}]` → co-spend Engage + BurnBatch → **tiêu MAGIC chưa từng được sinh**, mua bất kỳ dịch-vụ định-giá-MAGIC (PoC `poc_fabricated_magic_burns_ok` PASS 2026-08-04). NFT one-shot ràng UTxO phải đi qua cửa tạo-vault hợp-lệ → đóng lỗ tận gốc cho MỌI cửa gen, độc lập với công thức tư-cách.

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
| Backing | quyền của người cầm: năng-lực-dịch-vụ (gift-card), KHÔNG quyền đòi tài sản. Danh mục `B` mà GreenBack giữ để đo khả năng thanh toán là chuyện khác — §1.2, §6.3 |

---

## §5. CARP — giao diện (chi tiết ở CarpetMint-Core-Spec-Vi.md)

Tài liệu này chỉ nêu **điểm nối** CARP ↔ MAGIC. Đặc tả đầy đủ cơ chế ổn định (sàn-tiện-ích, 3-back, Backstop, CDP-phụ, tham số) ở `CarpetMint-Core-Spec-Vi.md`.

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
- **Một công thức sinh chung cho hai cửa LAMP** (INV-MAGIC-CITIZEN, §6.1.1): InstantGen và ScheduleGen cùng đọc `L` · `usage_ratio` · `GB`; khác nhau **chỉ ở thời tính** (§6.1.4). MAGIC đang cầm không vào công thức; tiêu thụ thật vào qua tỷ lệ `usage_ratio`, không qua độ lớn tuyệt đối.

**Wakeme lent-LAMP KHÔNG phải cửa riêng.** Khoản ≤ 1001 LAMP hệ cho người mới mượn là **nguồn-LAMP** để chạy InstantGen/ScheduleGen — cùng hai phương thức áp cho LAMP người dùng tự mua. Không có "cửa GenDrip" ngang hàng.

**Khoản mượn đó KHÔNG BAO GIỜ RỜI két Wakeme.** Nó không sang két của MAGIC, không sang ví người dùng, không đi đâu cả: giá trị LAMP trong két Wakeme là **bất biến qua mọi lượt Gen**. Engine gen **chỉ ĐỌC** số dư ấy qua `reference_input` (CIP-31) — nhất quán với I-ACT-7 ở §6.1 — và két Wakeme **không có redeemer nào cho Gen**. Việc "cho mượn" là một bút toán trong datum của chính két đó (`conditional_lamp` → `owned_lamp`), không phải một lần chuyển tài sản.

> Viết dài đến thế vì bản trước của đoạn này nói *"đặt trong vault closed-loop"* và *"cơ chế tấm-pin (LAMP luân chuyển pot→vault→pot)"*, và hai cụm ấy đọc thành **LAMP vẫn đi, chỉ đi vòng**. Cách đọc sai lại là cách đọc tự nhiên hơn với người đang dựng một cái két — nó suýt dẫn tới một bản ScheduleGen đòi LAMP mượn phải nằm trong két của MAGIC.
>
> Cái hỏng nếu làm theo cách đọc sai: hai đường thu hồi của Wakeme (`Reclaim` khi người dùng ngồi im qua ngày, `ReclaimEpoch` khi ngồi im ≥ 1001 kỳ) chi **từ chính két đó**. LAMP rời két là hai đường ấy chi vào một két rỗng — hệ cho mượn ≤ 1001 LAMP mỗi người và **không còn đường lấy lại**. Không lỗi nào hiện ra; pot chỉ cạn dần theo số người đăng ký. Bất biến bị phá là `L(két) == conditional_lamp + owned_lamp`.

Cơ chế đầy đủ của két Wakeme thuộc `PhoenixKey-Wakeme-{Math,Tech}.md`. Ở kho này chỉ cần đúng một điều: `L_lent` trong §6.3 **đọc từ datum két Wakeme**, không đọc từ `lamp_balance` của két MAGIC.

> **MAGIC là FUNGIBLE — nguyên tắc gốc (chốt 2026-07-30).** Một khi MAGIC đã sinh, hệ **KHÔNG BAO GIỜ phân biệt nó theo nguồn** (Instant/Schedule/Prepaid/LAMP-mượn hay LAMP-sở-hữu). MAGIC hành xử như đơn-vị fungible: mọi MAGIC-đã-tiêu đếm như nhau vào §6.2-thành-phần-2, `usage_ratio` (§6.1.2), §10 C1. Hệ quả thiết kế: **mọi rào chống-lạm-dụng phải đặt Ở TẦNG SINH (generation), không gắn nhãn MAGIC hay lọc theo nguồn ở tầng tiêu/kế-toán.** (Trường `source` trên batch — nếu có — chỉ dùng cho decay-param lúc tạo, KHÔNG được ảnh hưởng giá-trị-tiêu hay C1.)
>
> **Faucet-guard cho LAMP-mượn — chặn TẠI NGUỒN (chốt 2026-07-30).** Vì `lamp_base_amount` tuyến-tính theo LAMP-khả-dụng (§6.1.1), 1001 LAMP-mượn miễn-phí-vốn nếu tính đủ suất sẽ cấp ~1001 MAGIC/epoch mỗi người — biến faucet thành máy in MAGIC. Chốt: **LAMP-mượn chỉ cấp trần cứng nhỏ `LENT_PP_CAP`** (hằng-hệ, ≪ 1001·ρ) cho phần năng-lực đến từ LAMP-mượn; LAMP người dùng **tự mua & nắm** mới hưởng suất tuyến-tính đầy đủ. (`L_avail` chia hai phần: `L_owned` suất đầy đủ + `L_lent` trần `LENT_PP_CAP`.) Vì chặn ngay ở SINH, lượng MAGIC từ LAMP-mượn đã nhỏ sẵn → không cần (và không được) lọc nó khỏi C1 ở tầng governance: nhất quán với fungibility. Rủi ro thổi C1 bằng đèn-mượn bị giới hạn bởi chính `LENT_PP_CAP`.

### §6.1.1 Công thức sinh chung `F(L, usage_ratio, GB)` — InstantGen và ScheduleGen

Chủ dự án chốt 2026-09-17: người dùng tự sinh MAGIC bằng số LAMP trong vault của họ; hai cửa giống nhau ở ba đầu vào, khác nhau chỉ ở thời tính (§6.1.4).

| Đầu vào | Định danh | Nghĩa |
|---|---|---|
| `L` | `lamp_available` | LAMP khả dụng của vault (oildrop), định nghĩa theo từng script vault ở §6.1.4; phần LAMP-mượn theo faucet-guard §6.1 |
| `usage_ratio` | `usage_ratio_q` | consumed / generated của vault trong 6 epoch ĐÃ QUA (§6.1.2), Q-format, kẹp `[0, Q]` |
| `GB` | `greenback_surplus` | thặng dư GreenBack còn cấp được, nanogic, đọc từ beacon và rút qua bộ đếm shard (§6.1.3) |

> Ký hiệu: quyết định 2026-09-17 gọi thặng dư GreenBack là `S`. Tệp này viết **`GB`** vì `S` đã là cung MAGIC hiệu lực trong `br = B/S` (§6.3) và `G_e` đã là một đại lượng trong `INV-RATE-GOVERNED` (§12); các đại lượng khác loại không được dùng chung một chữ.

```
lamp_base_amount  = ⌊ L_owned_avail × generation_rate_q / Q ⌋
                  + min( ⌊ L_lent_avail × generation_rate_q / Q ⌋ , LENT_PP_CAP )
usage_factor_q    = usage_factor_coldstart_q                                        nếu Σ_window generated = 0
                  = usage_factor_floor_q + ⌊ (Q − usage_factor_floor_q) × usage_ratio_q / Q ⌋   ngược lại
usage_factor_coldstart_q = usage_factor_floor_q + ⌊ (Q − usage_factor_floor_q) / 2 ⌋   -- điểm giữa dải; = 0.75Q ở sàn hiện hành
scale_limit       = lamp_base_amount                                                nếu Σ_window generated = 0   -- không ràng buộc
                  = ⌊ Σ_window generated × Q / (horizon × scale_coverage_q) ⌋       ngược lại   -- §6.1.2, horizon ở §6.1.4
amount_by_lamp    = ⌊ lamp_base_amount × usage_factor_floor_q / Q ⌋
                  + ⌊ min(lamp_base_amount, scale_limit) × (usage_factor_q − usage_factor_floor_q) / Q ⌋
amount            = min( amount_by_lamp , GB_available )         -- GB_available = 0 ⟹ không sinh
usage_factor_floor_q = 0.5Q    scale_coverage_q = Q    generation_rate_q = ρ_e (INV-RATE-GOVERNED; §11)
```

> **CHỐT 2026-09-19 (`CC-GEN-GB-ROLE`): `GB` là TRẦN (`min`) và CỔNG — KHÔNG phải hệ số nhân.** Nghĩa là **`GB` chỉ tác động khi thặng dư gần cạn**: lúc dồi dào, lượng sinh hoàn toàn do `L` và `usage_ratio` quyết. Đó là hệ quả có chủ ý, không phải tác dụng phụ — câu "hai cửa dựa trên thặng dư GreenBack" (quyết định 2026-09-17) được hiện thực ở vai **chặn trên**, vì đó là vai duy nhất giữ được phanh vật lý: `GB` không bao giờ nâng được suất mỗi LAMP quá `ρ_e × usage_factor`, nên kẻ chiếm khoá beacon không vượt được `Σ LAMP-khả-dụng × ρ_e` (§6.1.5). Một `GB` dạng NHÂN sẽ phá đúng bất đẳng thức đó.

**Vai của từng thành phần, và vì sao:**
- **`L` — cơ sở NHÂN, tuyến tính.** Muốn sinh nhiều hơn phải nắm thêm LAMP (mục tiêu kinh tế: tạo cầu nắm LAMP). Tuyến tính vì `Σ_vault amount_by_lamp ≤ Σ LAMP-khả-dụng × ρ_e` là phanh vật lý duy nhất độc lập oracle (`INV-ORACLE-INDEP`, §13) — một hàm lồi theo `L` sẽ phá bất đẳng thức đó khi gom LAMP.
- **`usage_ratio` — hệ số NHÂN có sàn, dải `[0.5, 1]`.** Vai: **phanh tự động cho sinh thừa** — vault để MAGIC hết hạn không dùng thì kỳ sau sinh ít hơn. Nó KHÔNG đo cầu thật: tiêu-cho-chính-mình nâng `usage_ratio` gần như miễn phí (MAGIC sắp hết hạn vốn không có giá trị giữ), nên lợi tối đa của đòn đó bị chặn ở `2×` (dưới). Sàn `> 0` vì người mới (chưa có lịch sử) phải có MAGIC ngay. Trần `= Q` (không thưởng quá `ρ_e`) vì: (a) `ρ_e` có trần cứng biên dịch (`INV-RATE-GOVERNED`) — hệ số `> Q` sẽ vượt trần đó; (b) tiêu-tự-mình (wash consumption, §13) nâng `usage_ratio` gần như miễn phí khi `did_commit` còn tắt — trần `Q` chặn lợi của đòn đó ở `Q / usage_factor_floor_q = 2×`. Dạng tuyến tính vì là hàm đơn điệu đơn giản nhất, trùng bit Aiken↔TS dễ (P8), không cần luỹ thừa on-chain. Giá trị sàn `0.5Q`: xem CHƯA CHỐT `CC-GEN-USAGE-FLOOR` (§13).
- **Phần trên sàn không vượt quy mô lịch sử (`scale_limit`).** Tỷ lệ không mang thông tin về quy mô: vault sinh 1 MAGIC và tiêu hết có `usage_ratio = Q` giống vault sinh 10⁶. Không có `scale_limit`, một lịch sử nhỏ "mở khoá" hệ số đầy cho một lượng mới lớn tuỳ ý (nạp thêm LAMP, hoặc ký Schedule lớn). Nên phần hệ số trên sàn chỉ áp cho lượng mỗi epoch ≤ `Σ_window generated / (horizon × scale_coverage)`; phần vượt tính ở sàn. `scale_coverage_q = Q` là mốc "lịch sử phủ đúng một-một lượng mới" — nhỏ hơn thì phần thưởng tỷ lệ lan ra ngoài quy mô đã chứng minh, lớn hơn thì chặt hơn mà không có dẫn xuất cho mức chặt nào. `CC-GEN-SCALE-COVERAGE` (§13). Định nghĩa `usage_ratio` không đổi.
- **`GB` — TRẦN (min) và CỔNG, không phải hệ số nhân** (chốt 2026-09-19, `CC-GEN-GB-ROLE`). `GB` là một lượng tuyệt đối toàn mạng (nanogic), còn `amount_by_lamp` là của một vault; nhân hai đại lượng đó không có đơn vị nghĩa. Đặt `GB` làm trần nghĩa là `GB` chỉ **hạ** được lượng sinh, không bao giờ nâng suất mỗi LAMP quá `ρ_e × usage_factor` — nên kẻ chiếm khoá beacon không vượt được phanh vật lý (§6.1.5).
- **`GB` bằng 0 hoặc "âm".** Beacon mang số tự nhiên; bên ghi đăng `max(0, thặng dư)`. `GB_available = 0` ⟹ `amount = 0` ⟹ giao dịch bị từ chối (luật "không có giao dịch cấp 0"). Thâm hụt (br ≤ br_safe) và depeg đều quy về trạng thái này — fail-closed.
- **Tuần tự sàn** (§11 Q-format): mỗi vế một chuỗi bước `⌊×/Q⌋` riêng, không nhân gộp rồi chia. Ngoại lệ có chủ đích duy nhất: lượng LAMP khoá của `INV-INSTANT-LOCK` chia MỘT lần và làm tròn LÊN (§6.1.4).

**Vì sao đây KHÔNG phải lợi-tức-thụ-động (F3).** F3 cấm trả **giá trị** theo số dư. Thứ `F` sinh ra không có giá trị trao đổi: MAGIC không chuyển nhượng, không chuộc ra tiền/LAMP/CARP (F1, F4), và chết cuối epoch sinh ra nó (§4.2) — nắm LAMP mà không tiêu thì mỗi epoch nhận một quyền-tiêu tan biến, không tích luỹ được gì mang ra khỏi hệ. Thêm `usage_ratio`: ai không tiêu thì quyền-tiêu kỳ sau co về sàn. Lượng sinh theo `L` là **quy mô quyền dùng dịch vụ** tương xứng với cam kết nắm tài sản nền, không phải một dòng giá trị.

Lập luận trên đứng trên giả thiết quyền-tiêu không bị bán lại. Ngoài chuỗi, chủ vault vẫn có thể bán dịch vụ mua bằng MAGIC (hoặc cho người khác dùng ví) ⟹ dòng tiền ∝ LAMP nắm. **CHƯA CHỐT: `CC-GEN-QUOTA-RESALE` · treo:** rào nào chặn bán lại quyền-tiêu ngoài chuỗi · **TẠM:** chỉ chạy testnet. Khuyến nghị cho ví: mặc định sinh **đúng lượng cần dùng** trong epoch, không sinh trần — vừa giữ `usage_ratio` cao, vừa không tạo quyền-tiêu dư để bán lại.

### §6.1.2 `usage_ratio` — đếm gì, cửa sổ nào, lưu ở mức ràng buộc

```
generated_e = Σ initial_amount của mọi batch TẠO trong vault ở epoch e      (InstantGen grant, ScheduleGen fire)
consumed_e  = Σ lượng BurnBatch trừ khỏi batch của vault ở epoch e
usage_ratio_q = 0                                          nếu Σ_{e−6..e−1} generated = 0
              = min( Q, ⌊ Σ consumed × Q / Σ generated ⌋ )  ngược lại      (e = epoch hiện tại)
```
- **MAGIC hết hạn KHÔNG tính vào `consumed`, nhưng VẪN nằm trong `generated`.** Đó chính là tín hiệu: cung sinh ra mà không ai dùng kéo tỷ lệ xuống. `PruneExpired` không cộng gì vào `consumed`.
- **Bắn bù ScheduleGen (tối đa `MAX_FIRES_PER_TX_CATCHUP = 8` lượt một giao dịch).** Lượt bắn thuộc epoch danh nghĩa `e' <` epoch hiện tại sinh batch với `created_epoch = e'` — tức **đã hết hạn lúc sinh**, không tiêu được — và `generated` ghi vào epoch `e'` (bỏ nếu `e'` đã ra khỏi cửa sổ). Lý do: bắn muộn không được biến quyền-tiêu của các epoch đã qua thành quyền-tiêu của epoch này (§4.2), và lượng không dùng phải hạ tỷ lệ như mọi MAGIC hết hạn khác. Lệch mã: §6.1.6.
- **`INV-CONSUMED-ATTRIB` (chỉ đếm cross-DID) KHÔNG áp cho `usage_ratio`.** Nó áp cho `eligibility` (§6.2) và C1 (§10). `usage_ratio` đếm mọi lượng BurnBatch; lợi của tự-tiêu đã bị chặn bởi trần `usage_factor_q ≤ Q` và `scale_limit` (§6.1.1).
- **Cửa sổ = 6 epoch ĐÃ QUA, không tính epoch hiện tại** (chủ dự án chốt 2026-09-17). Hệ quả thiết kế: `usage_ratio` **hằng số trong suốt một epoch**, nên nhiều lần InstantGen trong cùng epoch dùng cùng một hệ số, và không có vòng tự tham chiếu "đốt trong epoch để nâng hệ số cho lần sinh kế tiếp của chính epoch đó".
- **Khởi động lạnh — CHỐT 2026-09-19 (`CC-GEN-COLD-START`): vault mới đứng ở mức TRUNG TÍNH, không ở sàn.** `Σ_window generated = 0` ⟹ `usage_factor_q = usage_factor_coldstart_q` = **điểm giữa dải** `[sàn, Q]`, và `scale_limit` **không ràng buộc** ở trạng thái này (§6.1.1).

  Hai điều phải đọc cùng nhau, vì bỏ một vế là hiểu sai quyết định:

  **(a) Vì sao trung tính chứ không phải hệ số đầy.** Người mới chưa chứng minh được gì; cho hệ số đầy là thưởng cho việc không có lịch sử. Điểm giữa dải là mức **không thưởng cũng không phạt** — nó viết theo sàn (`sàn + ⌊(Q − sàn)/2⌋`) chứ không gõ một hằng riêng, nên khi `CC-GEN-USAGE-FLOOR` đổi sàn thì mức trung tính đi theo và không có bản sao nào chết lại.

  **(b) Vì sao `scale_limit` phải nới ở đúng trạng thái này, và cái giá của nó.** Với `Σ generated = 0` thì `scale_limit = 0`, nên nếu giữ nguyên ràng buộc thì phần hệ số trên sàn bị nhân với 0 và vault mới **vẫn** rơi về sàn — quyết định sẽ không có hiệu lực nào. Nới nó ra là điều kiện để quyết định có thật.

  Giá phải trả, ghi thẳng: một vault có lịch sử XẤU (hệ số về sàn) nay **đóng rồi mở lại được để về mức trung tính**. Đây đúng là rủi ro mà bản trước dùng để biện minh cho lựa chọn "sàn", và nó không biến mất — nó được **chuyển** sang một phanh khác: `INV-ONE-PERSON-ONE-VAULT` (`BOUNDARIES.md`). Phanh đó **chưa được ép trong mã**, nên **ràng buộc TẠM đang có hiệu lực: chỉ chạy testnet** cho tới khi cổng genesis khoá theo DID tồn tại. Phanh vật lý thì vẫn đứng: mức trung tính `< Q`, nên `Σ amount ≤ Σ LAMP-khả-dụng × ρ_e` không bị đụng (`INV-ORACLE-INDEP`).

  Hạt giống `wakeme_seed_credit` không đi vào cửa sổ đếm.
- **Kẹp `≤ Q`.** Trong một vault, BurnBatch không đốt được nhiều hơn lượng batch đang giữ nên `consumed ≤ generated` tự thoả; kẹp là phòng thủ cho mọi nguồn cộng thêm về sau.
- **Phạm vi đếm: từng vault.** MAGIC tiêu từ PrepaidGen (vault khác) không tính — xem `CC-GEN-PREPAID-IN-RATIO`; gộp theo DID qua hai vault Instant/Schedule — xem `CC-GEN-RATIO-PER-DID` (§13). Đếm theo vault không phải lọc theo nguồn ở tầng tiêu: mọi lượng BurnBatch trừ khỏi batch của vault đều đếm như nhau (nguyên tắc fungible §6.1).
- **Ràng buộc lưu trữ:** datum vault giữ đúng 6 cặp `(generated, consumed)` của epoch đã đóng + một cặp tích luỹ của epoch đang mở (vế `generated` của cặp đang mở cũng là lượng InstantGen đã sinh trong epoch, dùng cho `scale_limit` và trần mỗi vault ở §6.1.3); lần spend đầu tiên ở epoch mới dịch cửa sổ theo số epoch đã trôi, điền 0 cho epoch không có giao dịch. Kích thước cố định (không tăng theo số batch). Thêm các trường này là đổi số trường datum ⟹ deploy lại vault (§6.1.6).

### §6.1.3 Beacon GreenBack — nguồn của `GB`

- **Hai giai đoạn, một validator.** Khi thuật toán CARP chưa hoàn thiện, `GB` là giá trị **MÔ PHỎNG** do keeper đẩy lên chuỗi. Khi CARP xong, bên ghi tính `GB = ⌊ f·S·(br − br_safe) / br_safe ⌋` khi `br > br_safe`, ngược lại `0` (`f`, `br_safe` ở §11; `B` tuân `INV-BACKING-NO-LAMP`). Validator đọc **cùng một trường** ở cả hai giai đoạn; chuyển giai đoạn chỉ đổi NGUỒN ghi beacon (chủ dự án chốt 2026-09-17).
- **Đọc lúc nào.** InstantGen đọc giá trị mới nhất **ngay trong giao dịch sinh**; không có chu kỳ reset theo lịch. ScheduleGen đọc lúc ký hợp đồng (§6.1.4).
- **`GB_available` là bộ đếm SPEND-decrement, không phải một con số đọc.** Theo `INV-SURPLUS-RATION`: 16 shard, mỗi shard mang `gb_shard_remaining` (nanogic). Mỗi lần ghi beacon **ĐẶT LẠI** (không cộng dồn) mọi shard về `min(⌊GB / 16⌋, gb_shard_cap_nanogic)`, với `GB` là thặng dư CÒN LẠI bên ghi tính được. Mỗi giao dịch sinh chi đúng shard của vault và trừ đúng lượng cấp (InstantGen: `amount`; ScheduleGen lúc ký: `pp × min(N, buffer_ep)`, §6.1.4). `GB_available` = số còn lại của shard đó.
  - `gb_shard_cap_nanogic = ⌊ SHARD_CAP × generation_rate_q / Q ⌋` — hằng biên dịch. Dẫn xuất: bằng lượng MAGIC mỗi epoch mà đúng một shard LAMP (`SHARD_CAP` oildrop, §11) sinh được ở suất tạm; trên mức đó phanh LAMP-khoá chặn trước, nên trần cao hơn không mở thêm gì. Với suất tạm `4·10⁹`: `4.5×10¹⁴ × 4 = 1.8×10¹⁵` nanogic.
  - **Trần mỗi vault mỗi epoch:** tổng rút của một vault trong epoch ≤ `⌊ gb_shard_reset_amount × gb_vault_share_q / Q ⌋`, `gb_vault_share_q = 0.05Q`. Dẫn xuất: chặn cá voi hút cạn shard — mỗi lần đặt lại, một shard phục vụ được ít nhất `Q / gb_vault_share_q = 20` vault trước khi cạn. `CC-GEN-GB-VAULT-SHARE` (§13).
  - **Chừng nào bộ đếm shard chưa có trong mã, `GB` KHÔNG phải trần toàn mạng**: mỗi vault đọc cùng một con số và tự rút, N vault rút tập thể vượt `GB`. Tệp này chỉ gọi `GB` là trần toàn mạng dưới điều kiện đó.
- **Tính duy nhất.** Beacon là UTxO mang NFT one-shot tại script validator beacon; vault **từ chối** khi số beacon hợp lệ trong `reference_inputs` khác 1. Validator beacon ép `last_updated_epoch == epoch(validity_range)` của giao dịch ghi — bên ghi không tự khai được epoch.
- **Độ tươi: `greenback_beacon_max_age_epochs = 0`** — beacon phải được ghi trong chính epoch hiện tại, **chừng nào bộ đếm shard chưa có**. Dẫn xuất: không có bộ đếm thì beacon cũ là giá trị đọc lại được vô hạn lần, nên phải chặt nhất ở độ mịn epoch. **Giá sẵn sàng phải chấp nhận:** từ đầu epoch tới lượt ghi thành công đầu tiên không ai sinh được, và mỗi lượt keeper hỏng kéo dài khoảng đó thêm một chu kỳ keeper (`[NEEDS-EVIDENCE]`: lịch chạy keeper không nằm trong kho, nên độ dài thực chưa kiểm). Khi có bộ đếm, beacon cũ không mở thêm được gì ngoài phần shard còn lại ⟹ nới lên `1` là hợp lệ. Độ mịn slot cho epoch dài: `CC-GEN-BEACON-AGE` (§13).
- **Fail-closed, không giá trị mặc định:** thiếu beacon · nhiều hơn một beacon · sai NFT/sai script · cũ hơn ngưỡng · cờ `depeg` bật ⟹ **giao dịch ĐỌC beacon** bị từ chối. Đó là **InstantGen** và **lượt KÝ hợp đồng ScheduleGen**, KHÔNG phải lượt `ScheduleFire` — fire không đọc beacon (`CC-GEN-SCHEDULE-FIXED`, §6.1.4 · §6.4 · §12). Câu trước của dòng này viết *"giao dịch sinh bị từ chối"* không kèm phạm vi, và fire **là** một giao dịch sinh, nên người đọc dừng ở đây kết luận ngược với quyết định đã chốt. Phạm vi phải nằm trong chính câu, không nằm ở một mục cách đó 200 dòng.
- **Ai được đẩy.** Một khoá riêng `greenback_beacon_writer`, **tách** khỏi: khoá đăng `ρ` (`INV-RATE-KEY-SINGLE`), khoá beacon `PriceParam` (§7.2), `engine_key` (§13) và ví deploy. Lý do: `INV-ORACLE-INDEP` — chiếm một khoá không được đồng thời gỡ hai phanh. Beacon mô phỏng **chỉ được chạy trên testnet**.
- **Hiện trạng mã, lệch với các gạch trên** (kiểm 2026-09-17): `InstantGen/onchain/validators/vault.ak` ▸ `find_backing_datum` lấy UTxO khớp ĐẦU TIÊN (`list.find`), không đếm số beacon; beacon thử nghiệm dựng bởi `scripts/deploy/04_deploy_backing_fixture.ts` nằm ở native script chữ ký đơn của ví deploy (`scriptFromNative … keyHash: ownerPkh`), không có validator beacon ép epoch; `scripts/keeper/keeper.ts` dùng một `WALLET_SEED` cho làm mới backing, `PostPrice` và bắn lịch — một khoá cho hai beacon, trái yêu cầu tách khoá (ví đó có trùng ví deploy không: `[NEEDS-EVIDENCE]`, mã không tự khai).

### §6.1.4 Thời tính — khác biệt duy nhất giữa hai cửa

| | InstantGen | ScheduleGen |
|---|---|---|
| Khi nào tính `amount` | tại giao dịch sinh | một lần, lúc ký hợp đồng |
| `L` | `lamp_available` tại giao dịch | `λ` LAMP khoá cho hợp đồng |
| `usage_ratio`, `GB` | của epoch/giao dịch hiện tại | chốt lúc ký, **fire không đọc lại** |
| `horizon` của `scale_limit` | 6 | `min(N, 6)` |
| Batch sống tới | hết epoch hiện tại | mỗi epoch trong `N` epoch một batch, hết epoch của nó |
| Epoch sau | sinh lại theo số liệu epoch sau | lượng/epoch **cố định tuyệt đối** suốt hợp đồng (chốt 2026-09-19, `CC-GEN-SCHEDULE-FIXED`) |

**InstantGen — cộng dồn trong epoch, khoá LAMP tới hết epoch SAU (`INV-INSTANT-LOCK`, chốt 2026-09-19).** Người dùng xin `m ≤ amount`. Mỗi lần sinh `m` khoá
```
L_used = ⌈ m × Q × Q / (generation_rate_q × usage_factor_q) ⌉        -- chia MỘT lần, làm tròn LÊN
```
**tới hết epoch `instant_lock_epoch + 1`**, tức khoá còn hiệu lực chừng nào `current_epoch <= instant_lock_epoch + 1` (`instant_lock_epoch` = epoch của lần sinh). Dẫn xuất cận: `L_used ≥ m·Q²/(ρ_e·uf)` ⟹ `m ≤ L_used·ρ_e·uf/Q²`; tổng khoá trong epoch `Σ L_used ≤ L₀` (LAMP sở hữu khả dụng đầu epoch) ⟹ `Σ m ≤ L₀·ρ_e·uf/Q²`. Vì `amount_by_lamp` sàn hai lần, `Σ m ≤ amount_by_lamp(L₀) + 1` nanogic. Cận này cần `ρ_e` và `usage_factor_q` hằng trong epoch: `usage_factor_q` hằng theo định nghĩa (§6.1.2); với `ρ_e`, **ràng buộc: giá trị `ρ` đăng mới chỉ có hiệu lực từ epoch SAU epoch đăng** (`INV-RATE-GOVERNED`). Không dùng suất đã làm tròn (`⌊ρ_e·uf/Q⌋`) để tính khoá: làm tròn XUỐNG mẫu số là khoá thiếu.
Vì sao cộng dồn chứ không một-lần/epoch: (a) `GB` đọc tại giao dịch — nếu `GB` chặn lần đầu, chỉ phần LAMP tương ứng lượng đã cấp bị khoá, phần còn lại sinh tiếp được khi `GB` tăng; một-lần/epoch sẽ đốt mất quyền của cả epoch vì một giá trị `GB` thoáng qua; (b) không cần bộ đếm `gen_this_epoch` (đã bỏ 2026-07-30, §6.3); (c) ví sinh đúng lượng cần (§6.1.1).
**LAMP-mượn KHÔNG khoá được bằng `INV-INSTANT-LOCK`:** nó nằm ở két Wakeme, vault MAGIC không có redeemer nào trên két đó. N vault cùng đọc một két ⟹ tới `N × LENT_PP_CAP` mỗi epoch chừng nào `INV-ONE-PERSON-ONE-VAULT` chưa được ép — `CC-GEN-LENT-READ` (§13).

**ScheduleGen — chốt lúc ký.** Lúc ký: `GB_available ≥ pp × min(N, buffer_ep)` và giao dịch ký **trừ** đúng lượng đó khỏi shard (không chỉ đọc); cổng `κ` trên tổng nghĩa-vụ-còn-lại (§6.4); `usage_factor_q` và `scale_limit` (horizon `min(N, 6)`) tính một lần, lưu cùng hợp đồng. Dẫn xuất `min(N, buffer_ep)`: shard chỉ ứng được phần nghĩa vụ mà GreenBack cam kết giữ đệm (`buffer_ep = 2`, §6.4); phần còn lại của hợp đồng do cổng `κ` gánh, nên **với ScheduleGen, trần gộp toàn mạng là cổng `κ`, không phải `GB`**. Lượng mỗi epoch: `M_i = ⌊ min(⌊λ·rate_locked_q/Q⌋, ⌊λ·ρ_e/Q⌋) × usage_factor_locked_q / Q ⌋` (áp `scale_limit` như §6.1.1).

**CHỐT 2026-09-19 (`CC-GEN-SCHEDULE-FIXED`): `M_i` tính MỘT lần lúc ký và CỐ ĐỊNH TUYỆT ĐỐI suốt `N` epoch.** Cả hai vế của `min` — `rate_locked_q` và `ρ_e` — lấy giá trị **tại thời điểm ký** và đóng băng cùng hợp đồng; `INV-LOCKED-RATE-CAPPED` vì thế là một cổng **lúc ký**, không phải một phép đánh giá lại mỗi lượt fire. `usage_factor_locked_q` và `scale_limit` đã đóng băng từ trước. Fire **không** đọc `GB`, không đọc `ρ_e` hiện hành, không đọc `usage_ratio` hiện hành, và **không dừng khi beacon báo `depeg`**.

Đây là lựa chọn có giá, và giá nằm ở đâu thì nói thẳng: **toàn bộ rủi ro thiếu hụt GreenBack sau khi ký dồn lên cổng `κ`** (§6.4) — `κ` là thứ quyết định một hợp đồng có được ký hay không, và sau chữ ký thì không còn van nào hạ nghĩa vụ xuống nữa. Đổi lại, người dùng nhận đúng thứ được hứa: *một lượng MAGIC cố định mỗi epoch, không đổi bất kỳ điều gì*. Bậc thang cứu (§6.4) vì thế **không được** dùng bậc "điều chỉnh tỷ giá hợp đồng" cho hợp đồng ĐÃ ký.

**Không dùng cùng một LAMP hai lần.** InstantGen và ScheduleGen là **hai script vault khác nhau**; một LAMP nằm ở đúng một UTxO, nên LAMP trong vault này không phải LAMP trong vault kia. Trong mỗi script:
- **Vault InstantGen:** `lamp_available = lamp_balance − instant_locked` khi `current_epoch <= instant_lock_epoch + 1`, ngược lại `lamp_balance` (khoá tự hết hạn theo epoch, không cần đường thả). `instant_locked` + `instant_lock_epoch` là trường riêng. InstantGen hiện KHÔNG có nhánh commit (`InstantGen/onchain/lib/magiclamp/protocol/types.ak` ▸ `VaultRedeemer`, **6 nhánh**: `InstantGen` (constr 0) · `PruneExpired` (1) · `BurnBatch` (2) · `UpdateProfile` (3) · `WithdrawLamp` (4) · `SetDelegate` (5, 🪦 nay chỉ xoá được); `WithdrawLamp` phải từ chối rút phần `instant_locked` còn hiệu lực), nên không có phần khoá Schedule trong vault này.

  > 🔴 **CHƯA CHỐT — `CC-GEN-LOCK-FIELD`: `instant_locked` là trường MỚI hay dùng lại `lamp_locked`?**
  > Đây không phải câu hỏi phong cách; nó là một cái bẫy đang mở. Vault InstantGen **đã có**
  > trường `lamp_locked` (di sản khuôn datum dùng chung), và `InstantGen/onchain/validators/vault.ak:401`
  > đã trừ nó rồi: `l_avail(applied_input.lamp_balance, applied_input.lamp_locked)`. Nhưng §6.3 của
  > chính tệp này lại viết khoá Instant là `lamp_locked += L_used`. Hai mục cùng tệp, hai tên cho
  > một khoá — người hiện thực đọc §6.3 sẽ cộng khoá Instant vào đúng trường mà mục này bảo phải
  > tách ra, và **không phép kiểm nào đỏ** vì cả hai đều là `Int` trong cùng datum.
  >
  > Cái giá của mỗi lối, để chốt được bằng một câu: thêm trường ⟹ đổi số trường datum ⟹ **di trú
  > mọi UTxO đang sống** (`BOUNDARIES.md` §2 ▸ *"Thêm trường ở cuối KHÔNG giữ được UTxO đã tạo"*);
  > dùng lại `lamp_locked` ⟹ không di trú, nhưng một trường mang hai nghĩa ở hai script, và ngày
  > InstantGen có nhánh commit thì hai nghĩa chồng nhau không tách được nữa.
  >
  > **Ràng buộc TẠM đang có hiệu lực, fail-closed:** chưa viết nhánh mã nào GHI vào khoá Instant
  > cho tới khi tên trường được chốt. Đo được: `grep -rn "instant_locked" --include=*.ak` → 0 dòng,
  > và không nhánh nào trong 6 redeemer đặt `lamp_locked` khác 0.
- **Vault ScheduleGen:** `lamp_available = lamp_balance − lamp_locked`; `lamp_locked` là khoá hợp đồng, giải dần theo từng lượt fire (`validate_fire` ▸ `lamp_released`).
LAMP-mượn đọc qua reference input thì KHÔNG có bảo toàn trên — `CC-GEN-LENT-READ` (§13).

**Thời điểm tính `L` — CHỐT 2026-09-19 (`CC-GEN-L-TIMING`): tính NGAY, nhưng KHOÁ tới hết epoch SAU.** LAMP nạp vào vault giữa epoch vào `lamp_available` ngay lập tức (giữ nguyên chốt 2026-07-30, §6.3); đổi lại, phần LAMP đã dùng để sinh bị giữ **qua trọn một epoch nữa** (`INV-INSTANT-LOCK`, ngay trên).

Vì sao hai vế này đi cùng nhau chứ không phải chọn một: chúng trả lời **hai câu khác nhau**, và bản trước gộp làm một.
- *"Tính ngay"* trả lời **ai được sinh** — hỏi LAMP phải nằm đủ lâu mới tính là dựng một hàng rào chống người dùng thật (mua LAMP xong phải chờ), trong khi kẻ thuê LAMP thì chờ được.
- *"Khoá tới hết epoch sau"* trả lời **thuê có rẻ không** — và đó mới là chỗ rủi ro thật nằm.

**Rủi ro đã đóng:** thuê LAMP vài phút cuối epoch, sinh, rồi trả ở epoch kế. Với khoá một-epoch thì chi phí thuê chỉ là vài phút; với khoá tới hết epoch **sau**, người thuê phải giữ LAMP qua trọn một epoch mà **không sinh thêm được gì bằng chính số LAMP đó** — chi phí thuê tăng theo độ dài epoch, còn lượng MAGIC thu về không đổi và vẫn chết cuối epoch sinh ra nó (§4.2).

**Cận sinh chặt hơn, không lỏng hơn.** Cận cũ `Σ m ≤ amount_by_lamp(L₀) + 1` trong MỘT epoch vẫn đúng. Vế mới thêm: `L₀` của epoch kế đã **trừ sẵn** phần còn khoá, nên tổng qua hai epoch liên tiếp bị chặn chặt hơn trước. Không mệnh đề nào của `INV-GEN-BUDGET` bị nới.

**Cái giá, ghi thẳng:** người dùng THẬT cũng chịu khoá dài gấp đôi — sinh hôm nay thì phần LAMP tương ứng tới hết ngày mai mới dùng lại được để sinh. `WithdrawLamp` cũng phải từ chối phần còn khoá trong cả hai epoch. Đây là đánh đổi có chủ ý: chống thuê chớp nhoáng bằng thời gian giữ, không bằng một hàng rào thời-gian-nắm-giữ ở đầu vào.

### §6.1.5 Bảng quyền đặc quyền của mô hình sinh

| Quyền | Ai giữ · ngưỡng | Thu hồi được không | Khoá bị chiếm — thiệt hại tối đa bị chặn bởi |
|---|---|---|---|
| **Nâng cấp validator** | Không có quyền này. Script Plutus bất biến; đổi mã = script mới, hash mới, vault mới | — | Không áp dụng; vault cũ tiếp tục chạy theo mã cũ |
| **Tạm dừng** | Không có công tắc dừng trong vault. Dừng thực tế xảy ra khi `greenback_beacon_writer` ngừng ghi, đẩy `GB = 0` hoặc bật `depeg` · 1-of-1 | **Không có đường thu hồi** tới khi đổi beacon bằng deploy lại (`CC-GEN-BEACON-ROTATION`) — rủi ro chấp nhận ở testnet | **Mất sẵn sàng toàn mạng**: không vault nào sinh InstantGen hay ký ScheduleGen mới. Ghi beacon ở mỗi block (đặt lại shard, đổi UTxO beacon) làm trượt mọi giao dịch sinh đang bay vì reference input đã bị tiêu. Không tạo thêm MAGIC, không di chuyển LAMP; fire của hợp đồng đã ký không đọc `GB` nên **chạy tiếp, kể cả khi `depeg` bật** — chốt 2026-09-19 (`CC-GEN-SCHEDULE-FIXED`), và đó là chỗ đắt nhất của đòn chiếm khoá beacon: nó không dừng được dòng đã ký, chỉ chặn được hợp đồng mới. Ràng buộc: `WithdrawLamp` KHÔNG được phụ thuộc beacon |
| **Giữ khoá ký** | Chủ vault (`datum.owner`) ký giao dịch sinh | Có — khoá của người dùng | Kẻ chiếm khoá chủ vault sinh và tiêu MAGIC của vault đó: ≤ `amount_by_lamp` của vault đó mỗi epoch. Rủi ro rút LAMP bằng khoá chủ là rủi ro sẵn có của vault, mô hình này không mở thêm |
| **Đổi tham số** | `ρ_e`: khoá đăng `ρ` 1-of-1 (`INV-RATE-GOVERNED`, trần cứng biên dịch, hiệu lực từ epoch sau). `GB`: `greenback_beacon_writer` 1-of-1. `usage_factor_floor_q`, cửa sổ 6, `scale_coverage_q`, `gb_shard_cap_nanogic`, `gb_vault_share_q`, `greenback_beacon_max_age_epochs`, `LENT_PP_CAP`: hằng biên dịch — đổi = deploy lại | `ρ`: không (khoá đơn, `INV-RATE-KEY-SINGLE`). `GB`: không có đường thu hồi — rủi ro chấp nhận ở testnet (`CC-GEN-BEACON-ROTATION`) | **Kịch bản bắt buộc — khoá beacon GreenBack bị chiếm, đẩy `GB` lớn nhất có thể:** mỗi lần ghi đặt lại shard về `gb_shard_cap_nanogic`, và ghi lặp lại được ⟹ phanh `GB` mất tác dụng. Mỗi vault vẫn bị chặn ở `amount_by_lamp ≤ ⌊L × ρ_e / Q⌋ + 1` (`usage_factor ≤ Q`, `ρ_e ≤` trần biên dịch); LAMP sở hữu đã dùng khoá tới hết epoch ⟹ tổng mỗi epoch ≤ `Σ LAMP-sở-hữu-khả-dụng-trên-chuỗi × trần ρ`, cộng phần LAMP-mượn `N × LENT_PP_CAP` (§6.1.4). ScheduleGen ký mới vẫn bị cổng `κ` chặn (đọc số dư quỹ cứu nội bộ, không đọc beacon — F6). **Thiên vị thời điểm:** kẻ giữ khoá chọn lúc `GB` cao để ký ScheduleGen cho mình hoặc đồng bọn, rồi hạ `GB` với người khác; lượng đã ký cố định suốt hợp đồng. MAGIC không ra khỏi hệ (F1/F4) ⟹ thiệt hại là pha loãng năng lực dịch vụ và mất sẵn sàng tới khi đổi beacon, không mất LAMP/CARP |
| **Rút quỹ** | Không có quyền này trong mô hình sinh: giao dịch sinh không spend LAMP (I-ACT-7), vault không giữ quỹ chung; quỹ GreenBack thuộc `CarpetMint-Core-Spec-Vi.md` | — | Không áp dụng |
| **Đổi ánh xạ nhãn→hash** | On-chain: danh tính beacon (policy NFT + script hash) là apply-param của vault, cố định lúc biên dịch — không đổi được lúc chạy. Off-chain: tệp cấu hình deploy theo mạng ánh xạ tên → hash, do người duyệt PR của kho giữ | On-chain: không (đổi = vault mới). Off-chain: có, qua PR | Apply-param trỏ nhầm beacon khi deploy ⟹ vault đọc beacon của bên khác: thiệt hại bị chặn như kịch bản `GB` ở trên. Cấu hình off-chain trỏ nhầm script vault ⟹ người dùng khoá LAMP vào script sai: `[NEEDS-EVIDENCE]` — chưa kiểm có cổng off-chain đối chiếu hash vault |

### §6.1.6 Thời điểm hiệu lực

Mô hình §6.1.1–§6.1.5 áp cho **vault deploy lại** sau v2.0 của tệp này. **Không hồi tố** vault Preprod đang sống: chúng tiếp tục chạy theo mã đã biên dịch của chúng cho tới khi bị thay. Chưa có vault mainnet ⟹ **không có di trú validator**. Chủ dự án chấp nhận deploy lại vault Preprod (2026-09-17).

Hiện trạng mã, tách khỏi ý hướng trên (kiểm 2026-09-17): `InstantGen/onchain/lib/magiclamp/protocol/math.ak` ▸ `compute_instant_grant` vẫn là `min3(compute_reward_from_consumed, compute_cap_surplus, compute_cap_pp)`, và `compute_cap_pp` chia đôi suất (`per_epoch / 2`); `InstantGen/onchain/validators/vault.ak` ▸ `validate_instant_gen` không khoá LAMP khi sinh và chấp nhận beacon cũ tới `max_backing_stale = 1` epoch (`constants.ak`); không tệp mã nào có `usage_ratio`, `scale_limit` hay bộ đếm shard `GB`. `ScheduleGen/onchain/validators/vault.ak` ▸ `validate_fire` đóng dấu MỌI batch bắn bù bằng epoch HIỆN TẠI (`create_fire_batches(…, current_epoch)`), nên `k` lượt bắn bù cho `k × M_i` MAGIC còn tiêu được trong epoch này — lệch ràng buộc bắn bù ở §6.1.2.

### §6.2 Tư-cách (`eligibility`) — hệ-số-NHÂN vào TỶ LỆ sinh (1 tham số, 4 thành phần)

> **CHƯA CHỐT: `CC-GEN-ELIGIBILITY` · treo:** mục này (chủ dự án chốt 2026-08-04) nhân `eligibility` vào `g(consumed)`; từ v2.0 công thức cấp (§6.1.1) không còn `g(consumed)`, và thành phần `consumedFactor` trùng vai với `usage_ratio`. Quyết định 2026-09-17 không nói gì trực tiếp về `eligibility` nên mục dưới đây GIỮ NGUYÊN VĂN. **Ràng buộc TẠM:** `eligibility` KHÔNG được nhân vào `F` (§6.1.1). Fail-closed: `eligibility ≥ Q`, bỏ nó chỉ làm lượng sinh nhỏ hơn hoặc bằng. Mã hiện tại cũng không hiện thực nó (`compute_reward_from_consumed` nhận `pm_q` enum, không phải `eligibility`). **Phần lập luận trong mục giữ nguyên văn không còn hiệu lực:** đoạn "Vì sao F8-sạch", ghi chú "Ngưỡng đóng-góp" (đầu-cơ thuần bị `g(consumed)=0` chặn) và mọi con trỏ "§6.3" tới `g(consumed)` đều đứng trên mô hình cũ; từ v2.0 người tiêu 0 vẫn sinh ở sàn, lý giải F3 ở §6.1.1. **Cái giá của ràng buộc tạm:** bỏ `eligibility` là bỏ luôn `offPeakFactor` — tín hiệu thấp-điểm duy nhất đi vào lượng sinh; `F` hiện không có thành phần nào thay nó.
Tư-cách là **một hệ số duy nhất `eligibility`** nhân vào cơ-sở-tính `g(consumed)` ở §6.3. Gộp 4 thành phần dưới dạng **TỔNG-CÓ-TRỌNG-SỐ** (KHÔNG phải tích — tích làm gãy bất biến chống-ôm-tối-ưu; chốt 2026-07-17, rà soát lại 2026-08-04):

```
eligibility_q = max( Q,  Q + ( W_AGE·ageFactor + W_CONSUMED·consumedFactor
                              + W_OFFPEAK·offPeakFactor + W_COMMIT·commitFactor ) / Q )

mỗi rᵢ ∈ [0, Q]   (kẹp CẢ HAI đầu: rᵢ = max(0, min(Q, rᵢ_thô)) TRƯỚC khi nhân trọng số — chống input bẩn)
Q = 10⁹ ·  Σ W = 1.5Q
W_CONSUMED = 0.90Q  ·  W_OFFPEAK = 0.25Q  ·  W_COMMIT = 0.20Q  ·  W_AGE = 0.15Q
```

**Vì sao F8-sạch (rà soát 2026-08-04 — bác lo ngại lợi-tức-thụ-động):** `eligibility` là **hệ-số-NHÂN** lên `g(consumed)`, mà `g(0) = 0`. Người nắm LAMP / cam-kết-lịch nhưng **tiêu 0** → `eligibility` có thể > Q nhưng **cấp thực = g(0)·eligibility = 0**. Tư-cách chỉ **khuếch đại** người ĐÃ tiêu, KHÔNG BAO GIỜ tự-sinh reward → không phải lợi-tức-thụ-động (F3/INV-MAGIC-CITIZEN giữ nguyên). Trần lý-thuyết `eligibility = 2.5×` (mọi rᵢ=Q); thực-tế ~1.6× ở cân bằng.

Bốn thành phần (đóng băng vào `profile_at_creation` lúc sinh batch — bất biến T4):

1. **`ageFactor` — thâm-niên LAMP, cửa sổ 6 epoch (`W_AGE = 0.15Q`).** Đo bằng **EMA số-dư-LAMP của vault**, KHÔNG duyệt tuổi từng UTXO (chốt 2026-08-04 — né O(n) ExUnit, DoS phân mảnh, xung đột Consolidate, age-laundering `vest_start_slot`):
   ```
   lamp_ema_q ← lamp_ema_q + (lamp_balance − lamp_ema_q)·α      (cập nhật mỗi lần spend vault, kẹp theo epoch)
   α = 1/6    (cửa sổ 6 epoch; nâng 9/12 sau = đổi α → 1/9, 1/12, MỘT hằng số — không đổi cấu trúc)
   ```
   **Ngữ nghĩa:** thưởng LAMP **cam-kết-ở-lại-lâu** (EMA cao & ổn định), phạt mua-sát-snapshot (EMA < balance) và không thưởng đã-buông (balance tụt → phanh `L_avail` §6.3 tự siết). Dạng đề xuất: `ageFactor = ⌊ min(lamp_ema_q, lamp_balance·Q) / max(1, lamp_balance) ⌋`, kẹp `[0,Q]`. Tiền lệ dual-EMA: FlowRate (`5292578d`).
   > *Ngưỡng đóng-góp:* đầu-cơ THUẦN đã bị `g(consumed)=0` (§6.3) chặn, KHÔNG do ageFactor. ageFactor chỉ tinh-chỉnh TỶ-LỆ (≤ +0.15×) cho người ĐÃ tiêu → thiên về **chính-sách điều-tiết-cung-cầu + khuyến-khích-nắm-LAMP** hơn là phòng-tuyến-đầu-cơ.
   > **Chuẩn-hoá chính xác 4 hàm `rᵢ` → dựng math thuần + vector, chốt ở PR.** Hàm chuẩn-hoá rᵢ hiện `[NEEDS-EVIDENCE]` — chưa đủ bằng chứng để cố định. Tài liệu này chốt **CƠ CHẾ** (EMA α=1/6) + **trọng số**, KHÔNG chốt hằng-số-chuẩn-hoá.

2. **`consumedFactor` — MAGIC-đã-tiêu, cửa sổ 6 epoch (`W_CONSUMED = 0.90Q`, chiếm ưu thế 60% dải).** Cùng LAMP + cùng thâm-niên: hồ sơ tiêu nhiều MAGIC hơn 6 epoch qua → sinh nhiều hơn. **`INV-CONSUMED-ATTRIB` (2026-07-31):** consumed đầu vào thành-phần này CHỈ đếm khi consumer-DID ⟂ provider/backer-DID (cross-DID, did_commit-gate) — chống **reflexive-gen-amplifier** (vòng LAMP→CARP→PrepaidGen→MAGIC→tự-tiêu tự nhân suất-sinh mỗi epoch). MVP `did_commit=#""` → thành-phần này TẮT tới khi Long giao did_commit thật (lộ trình #1).
3. **`offPeakFactor` — giờ-thấp-điểm (`W_OFFPEAK = 0.25Q`).** Cùng lượng tiêu: tỷ lệ tiêu lúc thấp-điểm cao hơn → sinh nhiều hơn (điều tiết cung-cầu). Tín hiệu thấp-điểm lấy từ **giá-dịch-vụ công bố sẵn**, KHÔNG tự dựng EMA (chốt 17/7).
4. **`commitFactor` — cam-kết-lịch ScheduleGen (`W_COMMIT = 0.20Q`).** MAGIC cam kết trong hợp đồng ScheduleGen nhiều hơn → sinh nhiều hơn.

> **Tên biến chuẩn (code Aiken + TS, thay tên tiếng Việt cũ — chốt quốc-tế-hoá 2026-08-04):** `eligibility` (tư_cách) · `ageFactor` (r_tuổi/tuoi) · `consumedFactor` (r_tiêu) · `offPeakFactor` (r_thấp_điểm) · `commitFactor` (r_cam_kết) · trường datum mới `lamp_ema_q`.

> Tư-cách **mở cổng và định tỷ-lệ**; **độ lớn** InstantGen = `⌊ g(consumed) × eligibility_q / Q ⌋` (§6.3). Ràng buộc SỐNG-CÒN của dải tư-cách: `g(consumed) ≤ 0.4·consumed` (2026-08-04) — nếu không, cap-per-DID cắt phẳng cả dải về ~1.1× (§6.3).

### §6.3 InstantGen — nắm LAMP, sinh ngay, dùng tới hết epoch
**Bản chất:** người dùng tự sinh MAGIC bằng LAMP trong vault, lượng tính **tại thời điểm giao dịch** theo công thức chung `F(L, usage_ratio, GB)` (§6.1.1); batch sống tới hết epoch hiện tại; epoch sau sinh lại theo số liệu của epoch sau. Không phải lợi-tức-thụ-động — lý giải ở §6.1.1.

- Người mới (vault chưa có lịch sử) sinh được ngay ở sàn `usage_factor_floor_q` (§6.1.2).
- *Ví dụ (LAMP đã nằm trong vault, không phải LAMP-mượn):* hai vault cùng 1000 LAMP khả dụng, cùng `GB` dồi dào, lượng sinh mỗi epoch nằm trong `scale_limit`. Vault A 6 epoch qua sinh 600, tiêu 540 (`usage_ratio = 0.9` ⟹ hệ số `0.95`); vault B sinh 600, tiêu 60 (`0.1` ⟹ `0.55`). A sinh `≈ 1.73×` B. Cả hai đều > 0.

**Cổng thặng dư + trần theo LAMP-khoá:**
```
cấp thực = m ≤ min( amount_by_lamp , GB_available )    -- §6.1.1, §6.1.4
```
- **`lamp_base_amount` tuyến tính theo LAMP khả-dụng tức-thời** (định nghĩa §6.1.1; giá trị `generation_rate_q` ở §11 — ràng buộc tạm `4·10⁹`, tức 0,004 MAGIC/LAMP/epoch). Thêm LAMP làm trần tăng **NGAY** trong epoch (đẩy nhu cầu nắm LAMP — mục tiêu kinh tế; rủi ro thuê chớp nhoáng: `CC-GEN-L-TIMING`, §6.1.4). Muốn sinh nhiều hơn → phải MUA & NẮM thêm LAMP.
- **`GB_available`** = phần còn lại của shard `GB` của vault (§6.1.3), theo `INV-SURPLUS-RATION` (dưới).
  - **`INV-INSTANT-LOCK` — khoá LAMP-nền chống flash-rent (chốt 2026-07-30; kéo dài tới hết epoch SAU, chốt 2026-09-19).** Khi InstantGen sinh dùng `L_used` LAMP-khả-dụng, **`L_used` bị KHOÁ tới hết epoch `instant_lock_epoch + 1`** (`lamp_locked += L_used`), giải-phóng khi `current_epoch > instant_lock_epoch + 1`. Hệ quả: (a) không thể **thuê LAMP 1 tx rồi trả ngay** để đội trần — muốn hưởng suất phải để LAMP nằm khoá trọn epoch sinh **và** trọn epoch kế, nên chi phí thuê tăng theo độ dài epoch trong khi lượng MAGIC thu về không đổi (§6.1.4); (b) `L_avail = lamp_balance − lamp_locked` **tự co lại** sau mỗi lần gen trong epoch → trần tự siết, LAMP-khoá vật lý trở thành thước đo ngân sách. LAMP-khoá cho InstantGen KHÔNG chuyển đi đâu (I-ACT-7 giữ nguyên: `lamp_balance` bất biến, chỉ `lamp_locked` đổi). MAGIC sinh ra là **use-or-lose trong epoch** (§4.2): tiêu ngay trong epoch, phần dư **huỷ hết** khi snapshot sang epoch.
- **KHÔNG có bộ đếm `gen_this_epoch` (chốt bỏ 2026-07-30).** Vì gen KHOÁ LAMP (`INV-INSTANT-LOCK`), `L_avail_hiện_tại = lamp_balance − lamp_locked` **đã tự trừ** mọi phần đã sinh trong epoch (Schedule-commit + Instant-gen trước). Chứng minh: `Σ_vault gen ≤ Σ_vault lamp_balance = LAMP-DID-kiểm-soát` (bảo toàn LAMP: 1 token ở đúng 1 UTxO) → **số vault không xuất hiện trong bất đẳng thức**; chia N vault vô hại; "một ngân sách hai cửa" là hệ quả miễn phí của khoá. Bỏ hẳn trường datum đếm.
  - **`INV-GEN-BUDGET` giữ KHÔNG cần đếm — hai điều kiện CỨNG:** (1) **khoá giải phóng CHỈ theo chuyển-epoch, CẤM giải theo burn** (đốt MAGIC không được "trả chỗ" LAMP-khoá) — cổng `current_epoch > instant_lock_epoch + 1` (khoá coi như hết hiệu lực — chốt 2026-09-19) áp ở **MỌI** nhánh đọc `lamp_available` hoặc rút LAMP (InstantGen/WithdrawLamp/UpdateProfile), sót một nhánh là thủng; (2) **làm tròn LÊN LAMP-khoá** cho mỗi `m` MAGIC (`⌈ m × Q × Q / (generation_rate_q × usage_factor_q) ⌉`, chia MỘT lần, §6.1.4) — không bao giờ khoá thiếu tỷ lệ. **Không cần đường thả riêng:** `instant_lock_epoch` tự hết theo epoch (§6.1.4), không giao dịch nào phải giải khoá. Mất khoá chủ thì LAMP vẫn không rút được, vì `WithdrawLamp` đòi chữ ký owner (`InstantGen/onchain/validators/vault.ak` ▸ `validate_withdraw_lamp`, kiểm `extra_signatories` chứa `owner`) — đó là rủi ro giữ khoá, không phải rủi ro kẹt do cơ chế khoá.
- *Ví dụ:* DID nắm 1000 LAMP (`L_avail`=1000). Schedule-commit khoá 600 → `L_avail`=400 → InstantGen còn tối đa ⌊400·ρ·usage_factor⌋ ≤ 400 MAGIC/epoch (ví dụ đặt ρ = 1 MAGIC/LAMP/epoch cho dễ đọc; suất tạm hiện hành ở §11 nhỏ hơn). Mua & khoá thêm LAMP nâng trần ngay; LAMP đã khoá không dùng lại tới sang epoch.
- `br = B/S`: `B` = backing thật, `S` = cung MAGIC hiệu lực (đã Gen chưa tiêu chưa reset). `br_safe = 1.5`.

- **`B` là một DANH MỤC token, chọn bằng biểu quyết quản trị, mỗi hệ một danh mục riêng** (chủ dự án chốt 2026-09-18). Danh mục của hệ MagicLamp: ADA, NIGHT, CHECK, WORK, và có thể thêm. Hệ khác tự chọn danh mục của họ.
  - **Hệ quả cho oracle, và nó đổi hình dạng F6:** một danh mục nhiều tài sản cần **một nguồn giá cho TỪNG tài sản**, không phải một oracle giá LAMP duy nhất. Câu cũ *"oracle giá LAMP CHỈ định-giá `B`"* đúng khi `B` là một thứ; nay nó là một tập. Vế **không điều khiển cổng** của F6 thì không đổi — đó mới là phần bất biến.
  - **`INV-BACKING-NO-LAMP` không đổi:** LAMP không nằm trong danh mục (chốt 2026-09-12, ngay dưới).
  - **CHƯA CHỐT: `CC-GEN-B-BASKET` · treo:** quy tắc kết nạp và loại bỏ một token khỏi danh mục · ai bỏ phiếu · chiết khấu theo thanh khoản · **trần tỷ trọng cho mỗi tài sản**. Vế cuối là vế có răng: một danh mục không có trần tỷ trọng thì một token kém thanh khoản chiếm chỗ của cả danh mục, và `br` vẫn đọc ra một con số đẹp. **Ràng buộc TẠM, fail-closed:** danh mục CHƯA được dùng để tính `br` thật — `GB` vẫn là giá trị **mô phỏng** do keeper đẩy (§6.1.3), và không luồng nào trong kho định giá một tài sản nào của danh mục.
  - **Ai ghi beacon backing:** keeper tầng GreenBack của MagicLamp. **Không phải** engine CarpetMint: `GlobalStateDatum` của engine mang giá của tài sản thế chấp CDP, không mang `B` lẫn `S`, nên về nguyên tắc nó không tính được `br` (đo 2026-09-19). Keeper của kho này đã ghi beacon thật trên Preprod từ 2026-09-17.
- **`INV-BACKING-NO-LAMP` — `B` KHÔNG được chứa LAMP (chốt 2026-09-12).** MAGIC sinh trên **thặng
  dư của GreenBack**, tức trên phần ĐÃ được back; `B` không việc gì phải tự đi neo vào chính tài
  sản mà nó đang cấp quyền-tiêu để đổi lấy.

  Vì sao thành bất biến chứ không phải sở thích — nó đã hỏng một lần trong thiết kế, ở đúng phía
  sai. `B` chứa LAMP ⟹ `B ∝ P_LAMP` ⟹ giá LAMP sập thì `br` sập ⟹ `cap_surplus = 0` ⟹ **khoá Gen
  đúng lúc thị trường gấu**: nông dân không trồng được cây vì giá token sập. Đó là nghịch đúng
  mục tiêu "phục vụ kinh tế thực". Chiều lên cũng hỏng nhưng nhẹ hơn: `P_LAMP` tăng ⟹ `B` tăng ⟹
  `cap_surplus` nới, trong khi số cây trồng được không đổi.

  Nguyên tắc này **đã có sẵn cho CARP** — `F5-CARP-FIAT-NEUTRAL` cấm "thuần-LAMP vào core". Đây
  là áp cùng nguyên tắc cho `B` của MAGIC; không phải luật mới, là chỗ luật cũ chưa phủ tới.

  ⚠️ **CHƯA HOÀ GIẢI VỚI §6.4 BƯỚC (3)** — xem ghi chú ở §6.4. Bất biến này đã chốt; cách hoà
  giải thì chưa. Ràng buộc TẠM THỜI: coi LAMP mà GreenBack nắm là **tồn kho**, KHÔNG đưa vào `B`
  của `br`. Fail-closed (`B` nhỏ hơn ⟹ `cap_surplus` nhỏ hơn ⟹ gen ít hơn).
- **Xanh** (`br > br_safe`): được Gen. **Đỏ** (`br ≤ br_safe`): `cap = 0` (khoá Gen). Sau Gen: `br' ≥ br_safe`.
- **`INV-SURPLUS-RATION` — cap_surplus phải RATIONED toàn-mạng (chốt 2026-07-31, 16-shard).** `cap_surplus` rút từ **pool backing CHUNG** → nếu mỗi DID đọc một `br`-beacon (reference-input, KHÔNG trừ-dần) rồi tự rút phần mình, **N chủ-thể (kể cả trung thực) mint/gen tập-thể VƯỢT backing → depeg** (đây là "lỗ Q2" — phía SINH/rút, KHÔNG phải phía mint-CDP: mint qua CDP `MCR≥2` là **accretive**, `Σcol≥2·Σdebt ⟹ cr_carp≥2` tự-động, không cần accumulator).

> 🔴 **`cr_carp` KHÔNG phải `br` — đổi ký hiệu 2026-09-12, hai dòng trên từng dùng chung một chữ.**
> `br = B/S` (dòng đầu mục này): `S` = cung **MAGIC**. `cr_carp = Σcol/Σdebt`: `Σdebt` = nợ
> **CARP** của CDP. Hai đại lượng khác loại, khác mẫu số, khác token.
>
> Suy ngược từ chính hệ quả đã viết: mệnh đề `Σcol ≥ 2·Σdebt ⟹ (tỷ lệ) ≥ 2` **chỉ hợp lệ về
> đại số** nếu tỷ lệ đó `:= Σcol/Σdebt`. Từ `Σcol ≥ 2·Σdebt` không suy ra được gì về `B/S` nếu
> không có một giả thiết nối `Σdebt` với `S` — và giả thiết đó không có ở đâu trong tệp này.
> Mint CARP qua CDP không đổi `S` một chút nào (`F1-MAGIC-ONE-WAY`).
>
> **Vì sao phải ghi rõ chứ không sửa lặng:** vế trong ngoặc là thứ ấn định **PHẠM VI** của
> `INV-SURPLUS-RATION` — nó nói lỗ Q2 chỉ ở phía SINH, phía mint-CDP tự lành. Lập luận đó đứng
> trên việc hai ký hiệu là một. Tách ra rồi thì câu *"phía mint-CDP tự lành"* **chưa được chứng
> minh trong tệp này**; nó có thể vẫn đúng, nhưng đúng vì lý do khác. Cho tới khi có chứng minh,
> đọc nó là một **giả định đang có hiệu lực**, không phải một kết luận.
>
> Ràng buộc TẠM THỜI đang áp trong lúc chờ: `INV-SURPLUS-RATION` giữ nguyên phạm vi hiện hành
> (chỉ gác phía SINH). Đây là fail-closed về phía MAGIC và **không** gác phía CDP. Vá: tổng-surplus-khả-cấp mỗi epoch chia vào **16 shard** (tái dùng `SHARD_COUNT`/`SHARD_CAP` của ScheduleGen); keeper refresh đầu epoch; mỗi lần gen/rút-tồn **SPEND-và-DECREMENT** một shard → **trần toàn-cục CỨNG = Σ shard-cap**, atomic on-chain, "số chủ-thể" biến mất, contention chia 16. KHÔNG pro-rata theo beacon-read (stale = chính lỗ). Neo cuối fail-safe vẫn là `⌊L_avail×RATE/Q⌋` (LAMP-khoá vật lý, độc-lập-oracle).

> **Vì sao không có hệ số `0.5×` giữa Instant và Schedule:** một hệ số như vậy từng có hai vai — (a) giữ Instant < Schedule cho kênh tích-backing sống, (b) chặn cá voi hút cạn thặng dư. Vai (a) do **LAMP-khoá** đảm nhiệm (một LAMP nằm ở đúng một vault; trong mỗi vault phần đã khoá không dùng lại được, không double-dip — §6.1.4); vai (b) do trần mỗi vault `gb_vault_share_q` trên shard `GB` giữ (§6.1.3). Mã hiện tại vẫn chia đôi (`compute_cap_pp` ▸ `per_epoch / 2`) — lệch, sửa khi deploy lại (§6.1.6).

**Hai phanh bổ sung:**
- Cờ `depeg` trên beacon bật ⟹ không sinh InstantGen, và không ký được hợp đồng ScheduleGen MỚI (§6.1.3). **`ScheduleFire` của hợp đồng ĐÃ ký thì chạy tiếp** — chốt 2026-09-19, xem §6.1.4 `CC-GEN-SCHEDULE-FIXED` và §6.4 mục (2). Lý do là lý do sản phẩm, không phải chỗ chưa làm: lượt fire tiêu LAMP đã khoá từ **trước** lúc depeg, nên chặn nó là phạt một người không gây ra việc — và nó đụng thẳng `C-VAC-12` (đã commit thì hoặc fire hoặc hết hạn, không hoàn giữa dòng). Fail-closed đúng ở cửa VÀO, không đúng ở cửa RA của một cam kết đã đóng băng. Cái giá đã ghi ở §12: kẻ chiếm khoá beacon không dừng được dòng đã ký, chỉ chặn được hợp đồng mới.
- **`INV-CASHBACK-BOUND`**: hoàn-tiền/ưu-đãi-phí mỗi DID (VacuumBack §8 và mọi khoản cashback) ≤ MAGIC thật đã tiêu thụ của DID đó. **Không áp** cho lượng sinh từ LAMP của §6.1.1 — lượng đó bị chặn bởi `L × ρ_e` và `GB`, không bởi lượng đã tiêu.

**Use-or-lose:** lượng sinh là **trần-suất mỗi epoch** — nạp vào batch epoch hiện tại, không cộng dồn qua epoch (§4.2). Sang epoch mới, `lamp_locked` giải phóng → `L_avail` phục hồi → cả Instant lẫn Schedule-fire lại có đủ trần.

### §6.4 ScheduleGen — dòng đều dài hạn, GreenBack đỡ
**Mục đích:** cần **dòng MAGIC đều đặn nhiều epoch** (ví dụ trả công đội kỹ thuật vài tháng). Nắm/khoá LAMP, hệ bảo đảm `pp` MAGIC **mỗi epoch** trong `N` epoch. LAMP đứng yên, trả nguyên vẹn khi hết hợp đồng.

**Đầu vào chung, chốt lúc ký (§6.1.1, §6.1.4).** Lúc ký, hợp đồng đọc `λ` (LAMP khoá), `usage_ratio` của vault và `GB` từ bộ đếm shard (trừ `pp × min(N, buffer_ep)`); `pp` tính theo `F` (kèm `scale_limit` horizon `min(N, 6)`) và **không đổi suốt `N` epoch** — chốt 2026-09-19, `CC-GEN-SCHEDULE-FIXED` dưới. Ví dụ theo quyết định 2026-09-17: vault có 1001 LAMP **đã nằm trong vault ScheduleGen** (còn lại từ Wakeme hoặc mua thêm; LAMP-mượn còn ở két Wakeme không tính) đặt ScheduleGen 10 hay 100 epoch để nhận một lượng MAGIC cố định mỗi epoch cho hoạt động thường ngày. Fire không đọc lại `usage_ratio` hay `GB`.

**Bốn bước:** (1) Ký hợp đồng `pp` MAGIC/epoch × `N` epoch qua cổng-giới-hạn; (2) Tạo MAGIC vào GreenBack (chưa lưu thông); (3) GreenBack mua LAMP khi rẻ → **đỡ giá** lúc sập (giữ đủ `buffer_ep = 2` epoch). **LAMP mua về là TỒN KHO của GreenBack, KHÔNG vào `B`** — xem khối ngay dưới; (4) **Mỗi epoch sinh batch mới ≤ `pp`** (trần cứng per-epoch), tiêu trong epoch đó — vẫn use-or-lose, KHÔNG hoard.

> **HOÀ GIẢI ĐÃ CHỐT (chủ dự án, 2026-09-12): LAMP GreenBack nắm là TỒN KHO, không vào `B`.**
> Bản cũ của bước (3) viết LAMP mua về *"góp backing"*, và câu đó nghịch `INV-BACKING-NO-LAMP`
> (§6.3). Gốc của mâu thuẫn là **hai vai khác nhau bị gộp trong một dòng**: **đỡ giá** (GreenBack
> NẮM LAMP để mua vào lúc thị trường sập) và **góp backing** (đưa LAMP vào mẫu số của `br`). Vai
> đầu không đòi vai sau — `§6.4` bậc cứu (2) *"bán LAMP thặng dư GreenBack"* cũng chỉ cần GreenBack
> NẮM LAMP, không cần nó nằm trong `B`.
>
> Cho nên phân biệt phải giữ ở mọi chỗ sau: GreenBack **có hai loại tài sản**. Tồn kho LAMP dùng
> để can thiệp giá và để bán khi cần cứu; `B` là thứ duy nhất đi vào `br` và vào `cap_surplus`.
> Trộn hai loại lại là dựng đúng cái vòng mà `INV-BACKING-NO-LAMP` sinh ra để chặn: `B ∝ P_LAMP`
> ⟹ giá LAMP sập ⟹ `cap_surplus = 0` ⟹ khoá Gen đúng lúc thị trường gấu.

> **Schedule-fire chung ngân sách qua LAMP-KHOÁ (chốt 2026-07-30).** Schedule-commit khoá LAMP hợp-đồng (`lamp_locked += Y`) trong vault ScheduleGen; vault InstantGen là script khác, nên LAMP đó không có mặt ở vault InstantGen. Không cần bộ đếm chung: tổng lượng sinh mỗi epoch của hai vault `≤ ⌊(lamp_balance_Schedule + lamp_balance_Instant) × ρ_e / Q⌋` (+1 nanogic mỗi vault do làm tròn, §6.1.4) nhờ bảo toàn LAMP. Nếu DID đưa hết LAMP vào vault ScheduleGen thì InstantGen epoch đó = 0 (và ngược lại). Sang epoch: khoá giải, cả hai phục hồi.

**Cổng-giới-hạn (vì sao Schedule phải nhỏ):**
```
Tổng nghĩa-vụ-còn-lại ≤ κ × Sức-tải-các-quỹ-cứu       (κ = 0.6, cấm đổi giữa vòng đời hợp đồng)
```
Sức-tải = số dư quỹ cứu nội bộ (RedBack + kho dự phòng + Kho bạc). **KHÔNG dùng giá LAMP** (F6).

**Hệ-số-năng-lực theo từng dịch vụ (chốt 2026-07-18).** ScheduleGen KHÔNG áp một hệ số chung. Mỗi dịch vụ có khả-năng-mở-rộng-cung khác nhau → trần neo vào năng-lực-cung thực của chính nó:
- Cung-hữu-hạn-theo-vùng (ship trong huyện) → hệ số thường ~60%.
- Cung-co-giãn-lớn (lưu-trữ LampNet, mở rộng chỉ là chỉnh tỷ-lệ-thưởng hút thiết bị người dùng) → gần như không giới hạn.
- **Nguyên tắc:** không phát dòng MAGIC vượt năng-lực-tiêu-dịch-vụ-thực (nếu không MAGIC không có dịch vụ để tiêu → phá sàn-tiện-ích). Thuật toán cụ thể per-dịch-vụ nằm ở spec dịch-vụ riêng, ngoài phạm vi tài liệu này.

> **Quan hệ với trần on-chain `amount_by_lamp` (§6.1.1).** Trần **on-chain** TUYẾN TÍNH theo LAMP-khả-dụng (`⌊ L × ρ_e / Q ⌋` nhân `usage_factor ≤ Q`) — đây là **trần trên** đủ tất-định để validator kiểm không cần oracle. Hệ-số-năng-lực per-dịch-vụ là lớp **SIẾT THÊM** (off-chain / spec dịch-vụ), chỉ **thu hẹp** dòng thực dưới trần on-chain, **không bao giờ nới rộng** vượt nó. Nhờ vậy khoảng-trống-spec "công thức năng-lực per-dịch-vụ" (từng chặn cài đặt) không còn chặn: on-chain đã có công thức tất-định; per-dịch-vụ tinh-chỉnh bên trên.

**Bậc thang cứu (GreenBack thiếu) — 4 bậc:** (1) bán LAMP thặng dư GreenBack; (2) RedBack; (3) kho dự phòng; (4) Kho bạc.

> Bậc *"điều chỉnh tỷ giá hợp đồng"* **đã bỏ 2026-09-19**, không giữ kèm đính chính. Nó là một van hạ nghĩa vụ của hợp đồng **đã ký**, và `CC-GEN-SCHEDULE-FIXED` vừa chốt rằng lượng mỗi epoch cố định tuyệt đối từ lúc ký (§6.1.4). Giữ cả hai là giữ một mâu thuẫn mà không bản nào tự khai là đã bị bác. Hệ quả phải nhận: bốn bậc còn lại đều là **nguồn bù bên ngoài hợp đồng**, nên phanh duy nhất còn đứng TRƯỚC chữ ký là cổng `κ` — và vì thế `κ` nay gánh phần rủi ro mà bậc (1) từng gánh.

> **CHỐT 2026-09-19 (`CC-GEN-SCHEDULE-FIXED`) — hai vế, trả lời cùng một lúc:**
> **(1) Lượng/epoch CỐ ĐỊNH TUYỆT ĐỐI từ lúc ký.** Câu chủ dự án nói 2026-09-17 — *"luôn luôn có được 1 lượng MAGIC cố định qua mỗi epoch … và nó không thay đổi bất kỳ điều gì"* — nay được thoả theo nghĩa đen. Hai cơ chế từng cho lượng/epoch **giảm** đã đổi vai chứ không bị bỏ: `INV-LOCKED-RATE-CAPPED` thành cổng **lúc ký** (§6.1.4), bậc cứu *"điều chỉnh tỷ giá hợp đồng"* bị **bỏ** (ngay trên).
> **(2) Fire KHÔNG dừng khi beacon báo `depeg` hoặc `GB = 0`.** Fire không đọc beacon, và đó nay là một tính chất được chọn, không phải một chỗ chưa làm.
>
> **Điều phải đọc kèm, vì nó là cái giá:** phanh duy nhất còn đứng trước một hợp đồng ScheduleGen là cổng `κ` tại thời điểm ký. Sau chữ ký, hệ **không còn van nào** hạ nghĩa vụ xuống — kể cả khi GreenBack cạn. Một `κ` đặt lỏng vì thế không hiện ra ở lượt ký; nó hiện ra ở epoch thứ `i` của một hợp đồng đã không thể sửa. Đây là chỗ phải soi khi chọn giá trị `κ`, và nó không phải chỗ mà một phép kiểm on-chain bắt được.

### §6.5 PrepaidGen — nguồn CARP, tự-back
- App/user **khoá CARP** → quỹ Paid platform; mỗi lần user tiêu, một phần CARP → quyền-tiêu MAGIC gắn DID.
- **Tự-back, một-chiều, cam-kết-tiêu** (F2): không hoàn, KHÔNG đổi 1:1 tự do qua lại.
- **Không cần cổng-thặng-dư/br** (tự-back bằng chính CARP đã khoá, không moi backing chung).
- MAGIC tiêu ra từ PrepaidGen **KHÔNG** vào `usage_ratio` của vault LAMP (§6.1.2): tỷ lệ đó đo cung sinh-từ-LAMP có được dùng hay không, còn MAGIC PrepaidGen tự-back bằng CARP, không rút thặng dư GreenBack. Xem `CC-GEN-PREPAID-IN-RATIO` (§13).
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

**Nguồn hình dạng: `ConsumeMAGIC/onchain/lib/magiclamp/consume/types.ak`.** Khối dưới là ảnh chụp.

```
EngageDatum {                        // 5 TRƯỜNG
  owner            : ByteArray,
  consumed_count   : Int,            // ĐẾM số thao tác — KHÔNG phải bằng chứng thanh toán
  last_epoch       : Int,
  did_commit       : ByteArray,
  consumed_nanogic : Int,            // giá trị đã tiêu; đây mới là thứ app phải đọc
}
```

🔴 **App cấp dịch vụ theo delta `consumed_nanogic`, KHÔNG theo `consumed_count`.**
`count` chỉ đếm số thao tác, không mang giá trị. Trả một thao tác rẻ (`op_type` giá 10⁶) rồi
đòi dịch vụ đắt (`op_type` giá 10⁷) làm `count` tăng đúng 1 trong cả hai trường hợp — mọi bất
biến on-chain vẫn thoả, mà bên bán thiếu 10×. `consumed_nanogic` được thêm chính vì lỗ này.

### §7.4 Bất biến validator `consume` (C-CM-1..9)

> Bảng dưới liệt C-CM-1..5. Validator hiện ép thêm **C-CM-6/7/8/9**; nguồn đầy đủ và đang đúng
> là [`ConsumeMAGIC/CONTRACT.md`](../ConsumeMAGIC/CONTRACT.md) §B. Đừng gỡ một ràng buộc chỉ
> vì nó không có trong bảng này — phòng thủ mồ côi là cách các cổng bị dọn nhầm.
>
> Một chỗ trong bảng đã hết hạn: C-CM-1 ghi "KHÔNG `tx.mint`". Nay `validator consume` là
> validator **đa mục đích** — handler `mint` của chính nó đúc thread token Engage để neo
> genesis của thread, nên `policy_id == script_hash` qua tự tham chiếu. `engage_nft.ak` đã bị
> xoá và `engage_nft_policy`/`engage_nft_name` không còn là apply-param.

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
**Mục tiêu KHÔNG đổi:** app trả phí giao dịch hộ người dùng, mà **MAGIC vẫn nằm trong vault người dùng** — đạt UX paymaster không vi phạm "MAGIC không transfer".

🪦 **Cơ chế cũ đã bị bỏ khỏi mô hình 2026-09-16.** Bản trước của mục này viết: *"App đặt `personal_delegate = Some(app_pkh)` qua `SetDelegate` ở vault → app ký `BurnBatch` tiêu MAGIC HỘ user."* Nhánh uỷ nhiệm nay không còn: `SetDelegate` ở cả ba vault chỉ **XOÁ** được (`expect new_delegate == None`), cửa đúc ép `personal_delegate == None`, và `BurnBatch` chỉ nhận chữ ký chủ sở hữu. Không có hình dạng giao dịch nào dựng lại được đường đó.

Đừng hiện thực hoá cơ chế cũ từ mục này. Cái mất là một **cơ chế**, không phải một **yêu cầu**.

| mã | trạng thái | ràng buộc đang có hiệu lực (fail-closed) | khai ở |
|---|---|---|---|
| D16 | cơ chế uỷ quyền thay thế để ngỏ | cổng PM-1.5 (`all_vaults_delegate_app`) đứng ở trạng thái không thoả được · `buildSponsorTx` ném `PM-000` thay vì dựng · Paymaster chưa deploy ở mạng nào | `DevStatus.md` ▸ D16 · Nợ #74 |

---

## §8. Vacuum = VacuumBack (KHÔNG phải cửa gen)

**"Vacuum" trong hệ hiện tại = VacuumBack** — back **thứ-3** trong kiến-trúc-ổn-định CARP, KHÔNG phải một cửa sinh MAGIC.

- Cơ chế: **commit-khoá LAMP/CARP kỳ-hạn**; kích hoạt khi `d ≥ d_vacuum = 6%` (peg lệch); vai PEG+SOLVENCY.
- **INV-VACUUM-ISOLATION:** leak ≡ 0 — VacuumBack cách-ly cứng khỏi `backing_core` (chống Vacuum-cliff).
- Thưởng người commit = **ưu-đãi-phí** = quyền-tiêu-MAGIC-thêm (non-transferable), KHÔNG phải yield tài sản.
- Chi tiết: `CarpetMint-Core-Spec-Vi.md`.

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

- **Nguồn C1 = `consumed_nanogic` engage-side** (`EngageDatum.consumed_nanogic`, §7.3), cửa-sổ ~18 epoch, đọc **cross-DID** — KHÔNG đọc tổng-sự-kiện-vault (số này self-burn bơm được).

  > Dòng này trước viết `consumed_count`, và đó là lỗi chọi thẳng với §7.3 ngay trên. Sửa
  > 2026-09-11 theo bốn nguồn cùng chiều: §7.3 của chính tệp này (*"`count` chỉ đếm số thao
  > tác, không mang giá trị"*) · `LAMP/Governance/VotingPower/CONTRACT.md` — mục định nghĩa
  > C1 nói *"tiền × thời gian"* và **không nhắc `consumed_count`** ở đâu · chú thích trên
  > `EngageDatum` trong `ConsumeMAGIC/onchain/lib/magiclamp/consume/types.ak` (*"App PHẢI
  > cấp dịch vụ theo delta của trường này, KHÔNG theo `consumed_count`"*) · và mô hình VP
  > đã chốt. Đáng nói nhất: bản cũ **tự bác chính lý do nó đưa** — nó chống việc bơm số,
  > mà `count` dễ bơm hơn `nanogic`, vì trả `op_type` rẻ nhất rồi lặp thì `count` tăng đều
  > còn giá trị thì không. Đây là sửa một dòng mô tả sai mô hình, **không** phải đổi mô hình.
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
| `MAX_LOYALTY_HOLDINGS` | 40 |
| `MAX_GEN_SCHEDULES` | 20 |
| `SHARD_COUNT` | 16 |
| `SHARD_CAP` | 4.5×10¹⁴ oildrop |
| `br_safe` | 1.5 |
| `κ` (ScheduleGen) | 0.6 |
| `buffer_ep` | 2 |
| `f` (cap_surplus) | ≤ 0.10 |
| `m_min / m_max` | 0.5Q / 2.0Q |
| `RATE_REF_Q` (giá trị spec của `generation_rate_q`, §6.1.1) | 10¹² |
| `usage_factor_floor_q` (§6.1.1) | 0.5Q — `CC-GEN-USAGE-FLOOR` |
| `scale_coverage_q` (§6.1.1) | Q — `CC-GEN-SCALE-COVERAGE` |
| `gb_shard_cap_nanogic` (dẫn xuất ở §6.1.3) | 1.8×10¹⁵ nanogic ở suất tạm — `CC-GEN-SURPLUS-SHARD` |
| `gb_vault_share_q` (dẫn xuất ở §6.1.3) | 0.05Q — `CC-GEN-GB-VAULT-SHARE` |
| cửa sổ `usage_ratio` (§6.1.2) | 6 epoch đã qua |
| `greenback_beacon_max_age_epochs` (§6.1.3) | 0 — `CC-GEN-BEACON-AGE` |
| `ρ` (MAGIC/LAMP/epoch) | TẠM `generation_rate_q = 4·10⁹` (= `instant_rate_q/2` hiện hành, tức 0,004); giá trị spec 1 = `RATE_REF_Q` — `CC-GEN-RATE-VALUE` |
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
| **F6-NO-EXTERNAL-INPUT** | cổng/ngưỡng chỉ căn số-dư-nội-bộ; oracle CHỈ định-giá `B` (một nguồn giá mỗi tài sản trong danh mục), KHÔNG điều khiển cổng — bản đầy đủ ở §2 |
| **INV-MAGIC-CITIZEN** | Lượng sinh từ LAMP (InstantGen + ScheduleGen) = `min(amount_by_lamp, GB_available)` (§6.1.1): `L` là cơ sở nhân, `usage_ratio` (consumed/generated, 6 epoch đã qua, không gồm hết hạn) là hệ số nhân dải `[0.5, 1]`, phần hệ số trên sàn chỉ áp tới `scale_limit`, `GB` là trần + cổng; với ScheduleGen, trần gộp toàn mạng là cổng `κ` (§6.1.4). MAGIC đang cầm không vào công thức. Vault CÓ lịch sử mà tiêu 0 sinh ở **sàn**; vault CHƯA có lịch sử sinh ở **mức trung tính** (`CC-GEN-COLD-START`, chốt 2026-09-19) — hai trạng thái khác nhau, đừng gộp; người không nắm LAMP sinh 0. VP C1 (§10) vẫn keyed MAGIC-đã-tiêu cross-DID |
| **INV-CASHBACK-BOUND** | hoàn-tiền/ưu-đãi-phí mỗi DID ≤ MAGIC thật đã tiêu; KHÔNG áp cho lượng sinh từ LAMP (§6.3) |
| **INV-INSTANT-LOCK** | InstantGen khoá `⌈m × Q × Q / (generation_rate_q × usage_factor_q)⌉` LAMP (`instant_locked`) **tới hết epoch SAU** — còn hiệu lực khi `current_epoch <= instant_lock_epoch + 1` (chốt 2026-09-19, `CC-GEN-L-TIMING`); khoá chỉ hết theo chuyển epoch, CẤM giải theo burn (§6.3, §6.1.4). Mã hiện tại chưa hiện thực |
| **I-ACT-7** | LAMP đứng yên khi gen (chỉ đọc reference_input) |
| **I-PERSON-5** | 1 PersonDID / 1 biometric_hash (chống Sybil-account) |
| **INV-VAULT-IDENTITY** | vault mang `vault_id_nft` one-shot; kiểm NFT mọi điểm đọc balance/batches (chặn vault bịa 2-ADA) |
| **INV-CONSUMED-ATTRIB** | consumed vào tư-cách chỉ đếm cross-DID (consumer ⟂ provider/backer) — chống reflexive-gen. Chỉ áp cho `eligibility` (§6.2) và C1 (§10), KHÔNG áp cho `usage_ratio` (§6.1.2) |
| **INV-SURPLUS-RATION** | cap_surplus rationed 16-shard spend-decrement (trần toàn-cục cứng, chống N-DID vượt backing) |
| **INV-VACUUM-ISOLATION** | VacuumBack leak ≡ 0 khỏi backing_core |
| **INV-MAGIC-WALLET-BOUND** | MAGIC gắn **VÍ** (`datum.owner` = `paymentCredential.hash`), KHÔNG gắn PersonDID. Quyền tiêu do chữ ký khoá thanh toán quyết định (`consume.ak:238,320,408`); `did_commit` là **commitment quy kết**, chỉ bị kiểm độ dài và ép bất biến (`:416-422`, `:759`), không gác quyền. Chốt 2026-09-12 — SPEC sửa theo mã, không sửa mã theo SPEC. **Hệ quả phải giữ trên mọi giao diện:** không được hứa "chỉ chủ danh tính mới tiêu được"; câu đúng là MAGIC gắn với **ví này**, mỗi lần tiêu ghi kèm một danh tính để truy nguồn |
| **INV-BACKING-NO-LAMP** | `B` KHÔNG chứa LAMP (chốt 2026-09-12, §6.3). `B ∝ P_LAMP` ⟹ `cap_surplus = 0` đúng lúc thị trường gấu ⟹ khoá Gen khi kinh tế thực cần nhất. Cùng nguyên tắc `F5` đã áp cho CARP. ⚠️ chưa hoà giải với §6.4 bước (3) — ràng buộc tạm: LAMP GreenBack nắm là TỒN KHO, không vào `B` |
| **INV-RATE-GOVERNED** | Suất sinh `ρ` KHÔNG phải hằng biên dịch. **Giai-đoạn-1 (chốt 2026-09-12): tham số quản trị đăng bằng tx, quyền đăng nằm ở MỘT khoá công ty, và `trần cứng biên dịch` cho giá trị đăng được là ĐIỀU KIỆN ĐỦ để mở đường đăng** — trần phải vào CÙNG lượt với đường đăng, không để sau (`compute_cap_pp` hiện không có trần trên). Giai-đoạn-2 (đích): nội sinh `ρ_{e+1} = clamp(ρ_e·D_e/G_e, ρ_e/2, ρ_e·2)`, zero oracle — mở khi `did_commit` sống. Giai-đoạn-1 là **tình thế**, không phải đích |
| **INV-RATE-KEY-SINGLE** | Khoá đăng `ρ` giai-đoạn-1 là **một khoá đơn**, và điều đó được chấp nhận CÓ ĐIỀU KIỆN: rủi ro "đặt sai một lần" bị chặn bởi trần cứng biên dịch, **không** bị chặn bởi động cơ của bên giữ khoá. 🔴 Mọi câu biện minh cho chỗ lỏng quanh `ρ` phải có **cùng chủ ngữ với mối đe doạ**: đe doạ là *"bất kỳ ai chiếm được quyền đặt"*, không phải *"bên đặt không có động cơ đặt sai"*. Trần chặn được **biên độ**, KHÔNG chặn được **tần suất** — đó là phần rủi ro còn hở, đã biết, chấp nhận cho giai-đoạn-1 |
| **INV-LOCKED-RATE-CAPPED** | T8 giữ đúng chữ (suất đã ký không TĂNG) bằng cổng **lúc ký**: `M_i = ⌊min(λ·rate_locked_q/Q, λ·ρ_e/Q) × usage_factor_locked_q / Q⌋`, cả hai vế `min` lấy giá trị tại thời điểm ký rồi đóng băng (§6.1.4, chốt 2026-09-19). Chặn đòn khoá `L=200` ngay trước khi hạ suất để giữ suất cũ 2,7 năm. **Không còn là trần trôi** — từ 2026-09-19 nó không đánh giá lại mỗi lượt fire, vì lượng/epoch cố định tuyệt đối (`CC-GEN-SCHEDULE-FIXED`) |
| **P8** | bit-identical Aiken ↔ TS |
| **C-OVERFLOW** | BigInt mọi amount |
| **C-CM-1..5** | bất biến ConsumeMAGIC (§7.4) |

---

## §13. Điểm mở + lộ trình

**`engine_key` gen — mô hình chốt (chốt 2026-07-30):** engine uỷ-quyền qua **anchor Service-DID**. `engine_key` là chữ ký **ORACLE hệ thống** chứng thực sổ tiêu-thụ off-chain (validator không tự đo được), KHÔNG phải chữ ký user. Chữ ký user trên giao dịch sinh thì khác theo cửa: **InstantGen đòi chữ ký owner** (`InstantGen/onchain/validators/vault.ak` ▸ `validate_instant_gen`, kiểm `tx.extra_signatories` chứa `owner`); **ScheduleGen fire là permissionless** (`ScheduleGen/onchain/validators/vault.ak`, chú thích đầu tệp ▸ `ScheduleFire: permissionless`) — dòng drip tự động nằm ở cửa này. Thay `engine_key: ByteArray` 1-of-1 hardcode bằng `(engine_anchor_policy, engine_anchor_name)` trỏ Service-DID; validator `expect anchor_controller_ok(...)` đọc controller hiện tại từ TAAD anchor qua `reference_input` (mẫu PhoenixKey `I-SPEND-2OF2`). Nhờ đó: **xoay khoá / thu-hồi / kill-switch (`status=Revoked`) miễn phí, không redeploy**; guardian-recovery làm escape-hatch. `anchor_controller_ok` **vendor ~30 dòng** vào `lib/` (không kéo aiken-dep repo PhoenixKey). Cardano không verify sinh-trắc on-chain → "2 yếu tố" = 2 khoá Ed25519, sinh-trắc gate off-chain (enclave).

> **`INV-ORACLE-INDEP` — hai oracle phải ĐỘC LẬP (rà soát đối kháng 2026-07-30).** `engine_key`-oracle (chứng thực sổ tiêu-thụ off-chain) và **backing-price-oracle** (định giá `B` cho `br` — F6) **PHẢI là hai thực thể / hai bộ khoá tách biệt**. Nếu chung một bên vận hành, kẻ chiếm 1 khoá vô hiệu **đồng thời** nhiều phanh. Từ v2.0, đường sinh không đọc `engine_key` (`usage_ratio` đếm on-chain, §6.1.2); nguyên tắc tách khoá áp cho `greenback_beacon_writer` (§6.1.3) đối với khoá đăng `ρ`, beacon `PriceParam` và `engine_key`. Phanh **duy nhất độc-lập-oracle** là `lamp_base_amount` (suy TUYẾN TÍNH từ LAMP THẬT trên chuỗi — §6.1.1) cùng `INV-INSTANT-LOCK` (LAMP khoá vật lý): dù oracle nói dối, không sinh vượt được LAMP-khoá-thật. ⟹ giữ nó là trần cứng on-chain, và giữ `usage_factor_q ≤ Q`, là điều kiện sống-còn cho fail-safe. Kill-switch `status=Revoked` phải tách quyền: bên giữ engine_key KHÔNG đồng thời giữ quyền chặn revoke.

> **Self-dealing / wash-consumption phụ thuộc `did_commit` (rà soát đối kháng 2026-07-30).** Vì MAGIC fungible + reward/C1 keyed theo consumed, một chủ thể vừa "user" vừa "merchant" có thể tự-trả-mình để bơm `consumed_nanogic` giả (nâng `usage_ratio` + C1; lợi ở lượng sinh bị chặn tối đa `Q / usage_factor_floor_q = 2×` vì `usage_factor_q ≤ Q`, §6.1.1). ConsumeMAGIC (`C-CM-1..5`) **không** kiểm "ai trả ai". Phanh đúng = `did_commit` (liên kết engagement ↔ DID sinh-trắc, §7.5) phát hiện pattern tự-giao — nhưng MVP `did_commit=#""` ⟹ **phanh TẮT tới khi `did_commit` thật được giao** (lộ trình #1). Đo lại 2026-09-11: trường `did_commit` **đã có** trong `EngageDatum`, và nhánh spend ép nó **bất biến** ⟹ mọi thread đang sống mang `#""` không có đường điền vào. Đường ghi một chiều (redeemer `BindDID`) đã dựng nhưng **chưa lên nhánh chính** — nên phanh vẫn TẮT, và lý do nay là "chờ đường ghi", không còn là "chờ thêm trường". Ghi nhận rủi ro: `usage_ratio` và C1 dễ bị wash-trade tới khi did_commit bật; cân nhắc trần-suất consumed/epoch/DID như phanh tạm.

**Còn chốt:**
1. Cơ chế Mint CARP + utility-floor + sim phòng-thủ-giá (`CarpetMint-Core-Spec-Vi.md`).
2. Tham số hệ-số-năng-lực per-dịch-vụ (spec dịch-vụ riêng) — siết-thêm dưới trần on-chain (§6.4).
3. `LENT_PP_CAP` (trần cứng LAMP-mượn, §6.1) — chọn giá trị hằng-hệ.

**ĐÃ CHỐT 2026-09-19 — bốn mục rời khỏi danh sách dưới.** Ghi lại ở đây vì một mã biến mất khỏi danh sách treo mà không để dấu thì người tra lần sau không phân biệt được *"đã quyết"* với *"bị quên"*:

| mã | chốt gì | cái giá phải nhận, và nó nằm ở đâu |
|---|---|---|
| `CC-GEN-GB-ROLE` | `GB` là **trần + cổng**, không nhân (§6.1.1) | lúc thặng dư dồi dào, `GB` không tác động gì — lượng sinh do `L` và `usage_ratio` quyết |
| `CC-GEN-SCHEDULE-FIXED` | lượng/epoch **cố định tuyệt đối** từ lúc ký; fire không dừng khi `depeg` (§6.1.4, §6.4) | sau chữ ký không còn van hạ nghĩa vụ — toàn bộ rủi ro dồn lên cổng `κ` lúc ký; bậc cứu "điều chỉnh tỷ giá hợp đồng" đã bỏ |
| `CC-GEN-COLD-START` | vault mới ở **mức trung tính** (điểm giữa dải), `scale_limit` không ràng buộc ở trạng thái này (§6.1.2) | đóng-rồi-mở-lại vault xoá được lịch sử xấu ⟹ **chỉ chạy testnet** tới khi `INV-ONE-PERSON-ONE-VAULT` được ép |
| `CC-GEN-L-TIMING` | LAMP tính **ngay**, nhưng khoá tới hết **epoch SAU** (§6.1.4, `INV-INSTANT-LOCK`) | người dùng thật cũng chịu khoá dài gấp đôi; `WithdrawLamp` phải từ chối phần khoá trong cả hai epoch |

**CHƯA CHỐT của mô hình sinh chung (v2.0)** — dạng `mã · treo gì · ràng buộc TẠM (fail-closed)`:
- `CC-GEN-B-BASKET` · quy tắc kết nạp/loại bỏ token khỏi danh mục `B` · ai bỏ phiếu · chiết khấu theo thanh khoản · trần tỷ trọng mỗi tài sản (§6.3) · TẠM: danh mục chưa dùng để tính `br` thật; `GB` vẫn là giá trị mô phỏng do keeper đẩy.
- `CC-GEN-SCALE-COVERAGE` · giá trị θ = `scale_coverage_q` của `scale_limit` (§6.1.1) · TẠM: `Q`.
- `CC-GEN-GB-VAULT-SHARE` · trần mỗi vault mỗi epoch trên shard `GB` (§6.1.3) · TẠM: `gb_vault_share_q = 0.05Q`.
- `CC-GEN-QUOTA-RESALE` · rào nào chặn bán lại quyền-tiêu ngoài chuỗi (§6.1.1) · TẠM: chỉ chạy testnet.
- `CC-GEN-USAGE-FLOOR` · giá trị `usage_factor_floor_q` chưa có dẫn xuất kinh tế (chỉ có ràng buộc `0 < sàn ≤ Q` và tiền lệ `m_min = 0.5Q` ở §11) · TẠM: `0.5Q`, không hạ về 0, không nâng quá Q.
- `CC-GEN-RATE-VALUE` · giá trị `generation_rate_q`: giá trị spec ρ = 1 MAGIC/LAMP/epoch (`RATE_REF_Q`, §11) và mã InstantGen `instant_rate_q` (`constants.ak`) chia đôi còn 0,004 · TẠM: `4·10⁹`.
- `CC-GEN-ELIGIBILITY` · §6.2 `eligibility` không còn cơ-sở-tính để nhân; bỏ nó là mất tín hiệu thấp-điểm · TẠM: không nhân vào `F`.
- `CC-GEN-PREPAID-IN-RATIO` · MAGIC tiêu từ PrepaidGen có vào `usage_ratio` không (§6.5) · TẠM: không.
- `CC-GEN-RATIO-PER-DID` · gộp `usage_ratio` theo DID qua vault Instant và vault Schedule · TẠM: tính riêng từng vault.
- `CC-GEN-LENT-READ` · đọc `L_lent` từ két Wakeme qua reference input chưa có ở kho nào; khi mở, N vault cùng đọc một két nhận tới `N × LENT_PP_CAP` mỗi epoch (§6.1.4) · TẠM: `L_lent_avail = 0` ở mọi vault.
- `CC-GEN-BEACON-AGE` · độ tươi beacon, và độ mịn slot cho epoch dài (§6.1.3) · TẠM: `0` epoch khi chưa có bộ đếm shard, `1` khi có.
- `CC-GEN-BEACON-ROTATION` · xoay/thu hồi `greenback_beacon_writer` không cần deploy lại vault · TẠM: không có đường xoay; chấp nhận vì chỉ chạy testnet.
- `CC-GEN-SURPLUS-SHARD` · bộ đếm shard `GB` (`INV-SURPLUS-RATION`, đơn vị nanogic, trần `gb_shard_cap_nanogic`) chưa có trong mã · TẠM: chỉ chạy testnet.
- `CC-GEN-SEED-CREDIT` · vai của `wakeme_seed_credit` khi lượng sinh không còn lấy từ `consumed_credit` · TẠM: hạt giống không vào cửa sổ `usage_ratio` và không vào `F`.

**Lộ trình:**
1. `did_commit` thật (giao Long) → khoá attribution Governance C1.
2. Compile Aiken (`aiken build` mỗi module) → deploy Preview theo thứ tự (thứ tự ở `scripts/README.md`).
3. Test Preview 3 cửa gen → tx thật.
4. Xây lõi CARP (MintingPolicy + ổn định).
5. Paymaster runner + fee-abstraction.
6. **Merkle-verify `so_lieu` (bỏ hẳn oracle `engine_key`)** — lộ trình sau-Preview; hiện dùng oracle anchor ở trên.

---

> **Nhất quán tài liệu:** file này ĐÈ `MagicLamp-3Token-DacTa-Vi.md` và các file GenMAGIC/ConsumeMAGIC rời. Cơ chế ổn định CARP → `CarpetMint-Core-Spec-Vi.md`. Diễn giải phổ thông (câu chuyện, pháp lý người dùng, mô phỏng) → `Launch/Whitepaper-MagicLamp-Tokenomic-(Vi).md`.
