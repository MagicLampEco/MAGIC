# BOUNDARIES — ràng buộc cho ai (người hay agent) sửa mã trong repo này

Tệp này được track, dùng chung cho cả người và agent. `CLAUDE.md` là tệp nội bộ của từng
máy và chỉ `@import` tệp này — đừng chép nội dung sang đó.

> Mô hình chuẩn: [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](SPEC/MagicLamp-Tripletoken-Feat-(Vi).md).
> Trạng thái module: [`DevStatus.md`](DevStatus.md). Lịch sử: [`ChangeLog.md`](ChangeLog.md).

---

## 1. Đây là cái gì

Hợp đồng Cardano L1 (PlutusV3, Aiken) cho hệ ba token:

- **LAMP** — tài sản nền, native token. **36 tỷ là TRẦN, không phải số đã đúc.** LAMP
  dùng lazy-mint: token chỉ sinh khi cần, tổng lịch sử luôn ≤ trần, và bộ đếm
  `SupplyState` đơn điệu tăng (không rollback). Nguồn: `LAMP/Papers/Whitepaper.md:25,48`.
  Không burn.

  > Bản cũ của dòng này viết "cố định 36 tỷ, không mint thêm" và câu đó **đọc thành
  > "36 tỷ đang nằm sẵn trên chuỗi"**. Nó tốn thật: 2026-08-28 chuỗi kiểm thử đúc chồng
  > lên tLAMP Preprod, và bên này báo là "gấp đôi cung", trong khi hỏng thật là **vượt
  > trần**. Mainnet lúc đó mới đúc vài triệu LAMP, đúng mô hình lazy-mint. Bất biến phải
  > kiểm là `tổng ≤ 36 tỷ`, không phải `tổng == 36 tỷ`.
- **MAGIC** — quyền-tiêu-dịch-vụ. **Không phải token**: là số kế toán trong datum vault,
  gắn PersonDID, **không chuyển nhượng**, dùng-hết-hoặc-mất theo epoch.

  > Trên Preview **có** một native token hiện ra chữ `MAGIC`, và nó KHÔNG làm sai câu trên.
  > Bất biến này là phát biểu về **hành vi của validator**, không phải về trạng thái mạng
  > Cardano — cùng dạng với việc đúc một token tên `BITCOIN` trên Cardano không phá bất biến
  > 21 triệu của Bitcoin. Mức đúng là **va chạm không gian tên, không chạm giao thức**; rủi
  > ro thật nằm ngoài giao thức (ví và explorer hiện chữ đó), và vá bằng thao tác on-chain
  > cộng một trang công bố, **không vá bằng validator**. Kiểm kê trọn, lịch sử đúc và phép đo
  > chứng minh mã không bao giờ tra tài sản theo tên: `scripts/DEPLOYED.md` ▸ *"Tên hiện ra
  > trong ví KHÔNG phải định danh"*.
- **CARP** — đồng-thanh-khoản, native token riêng, chuyển nhượng được.

**Định danh tài sản = cặp `(policy id, asset name)`. Policy id là điều kiện ĐỦ; asset name
KHÔNG BAO GIỜ là điều kiện đủ.** Ở dòng `4c414d50`, vế asset name đúng với cả hàng thật lẫn
hàng nhái, nên nó không mang thông tin — một cổng hiện thực câu này thành phép so HOẶC vẫn
qua được mọi lần thử. Testnet của kho có **27 dòng tài sản** mang tên của hệ này dưới một
policy chữ-ký-đơn không phải của LAMP; danh sách và hệ quả ở `scripts/DEPLOYED.md`, cổng
chặn tái phát ở `MagicSDK/src/lampPolicy.ts` ▸ `assertLampPolicyId`.

Mỗi module cùng khuôn: `onchain/` (Aiken) · `offchain/` (TypeScript + vitest) · `tests/`
(vector chuẩn). **Không có workspace ở gốc** — mỗi `offchain/` là gói npm độc lập, cài và
chạy riêng.

---

## 2. Bất biến — vi phạm là hỏng tiền thật, không phải lỗi phong cách

**P8 — toán Aiken và TypeScript trùng BIT.** `offchain/src/math.ts` và
`onchain/lib/.../math.ak` (cùng `decay.ak`, `pricing.ak`, …) hiện thực cùng công thức và
phải cho cùng kết quả với cùng đầu vào. Vector chuẩn trong `tests/vectors.ts` là trọng tài.
Sửa một bên thì sửa bên kia **trong cùng commit**.

**BigInt cho mọi số tiền.** `Q = 10⁹`, `oildrop = LAMP × 10⁶`, `nanogic = MAGIC × 10⁹`,
`nanothread = CARP × 10⁹`. Dùng `Number` cho các đại lượng này là lỗi tràn số đang chờ xảy
ra — có vector `TV-OVERFLOW-01/02` bắt đúng ca đó.

**Số học Q-format nhân-chia tuần tự.** Chuỗi thưởng ba hệ số áp thành **ba** bước
`⌊ × / Q ⌋` riêng, không phải một lần nhân hết rồi chia. Đây là thứ chặn sai số làm tròn
theo spec §6.1 / L4. Neo — **theo TÊN HÀM, không theo số dòng**:
`InstantGen/onchain/lib/magiclamp/protocol/math.ak` ▸ `compute_reward_from_consumed` ↔
`InstantGen/offchain/src/math.ts` ▸ `computeRewardFromConsumed`.

> Neo cũ ở đây là số dòng, và nó **đã trôi mà vẫn trỏ vào một dòng có thật** — chèn thêm
> khối chú thích phía trên đẩy công thức xuống, nên `math.ak:81-83` nay là văn xuôi chứ
> không phải mã. Đó là kiểu hỏng im lặng: người tra thấy một dòng hợp lệ và tưởng đã kiểm.

> Bản cũ của dòng này viết công thức là `M = L × R × UM × PM / Q³`. **Tên biến đó đã cũ**
> — lượng sinh nay theo công thức chung ở `SPEC/MagicLamp-Tripletoken-Feat-(Vi).md` v2.0 §6.1.1
> (xem mục **INV-MAGIC-CITIZEN** bên dưới). Hình dạng ba-bước-sàn thì không đổi, và
> đó mới là phần bất biến.

**`DESIGN-2` là gì, và vì sao nó không còn tên `PHA-2`** (đổi 2026-09-12). `DESIGN-2` là
**đời thiết kế thứ hai của kho này** — mốc mà `I-ACT-7` bắt LAMP ĐỨNG YÊN (công thức lượng sinh
hiện hành: SPEC v2.0 §6.1.1). Nó là một MỐC THIẾT KẾ, không phải một pha vòng đời của
thứ gì.

Chuỗi `PHA-2` bị bỏ vì tới lúc đó **ba khái niệm khác nhau cùng đội lốt "phase 2"**, và
không bản nào tự khai:

| chuỗi | nghĩa | chủ |
|---|---|---|
| `PHA-2` (cũ, kho này) | đời thiết kế thứ hai → nay là **`DESIGN-2`** | kho MAGIC |
| `PHA-2` (Wakeme) | pha vòng đời vault, `n > 1001` → nay là **`Epochy`** (pha đầu là `Daily`) | PhoenixKey |
| `phase-2` / `PHASE2` | **kiểm tra pha 2 của sổ cái Cardano** (script chạy rồi từ chối), đối lại pha 1 | thuật ngữ Cardano |

Mục thứ ba là thuật ngữ chuẩn của nền tảng — **không đổi, không đụng**. Nó xuất hiện hợp lệ
trong mã bắt lỗi, ví dụ `CarpetMint/offchain/src/16_deadman_gates.ts` ▸ hằng `PHASE2` phân
biệt "bị từ chối lúc chạy script" với "bị từ chối ở tầng sổ cái". Chính vì nó là claim mạnh
nhất trên cái tên đó mà hai mục kia phải nhường.

Giá đã trả trước khi đổi: một vòng hỏi-đáp của chủ dự án để tìm ra `PHA-2` của kho này
KHÔNG phải `PHA-2` của Wakeme. Cùng hình dạng với bẫy `28e916b0…` — cùng tên hiển thị,
khác đời, không bản nào tự khai. Ai gặp `PHA-1`/`PHA-2` trong kho này thì đó là tài liệu
chưa được quét: dạng **có gạch nối** đã về **0** ngoài `Legacy/` (`Legacy/` để yên theo §5).

> **Dạng có KHOẢNG TRẮNG thì chưa** — `PHA 1` / `PHA 2` còn **45 dòng / 22 tệp** (đo
> 2026-09-14, ngoài `Legacy/` và ngoài `.claude/`), gồm cả `ScheduleGen/onchain/validators/vault.ak`,
> `InstantGen/tests/vectors.ts` và một tệp mang tên `InstantGen/DESIGN-PHASE2.md`.
>
> Bản trước của dòng này viết "kho đã về **0**" mà không kèm chữ "có gạch nối". Đợt dọn
> đo bằng `grep "PHA-[12]"`, thấy 0, rồi phát biểu như thể **khái niệm** đã biến mất —
> `grep` đo VĂN BẢN, không đo KHÁI NIỆM. Câu sai đó nằm trong chính tệp mà mọi agent
> `@import` mỗi phiên, nên nó không chỉ sai, nó còn được đọc mỗi ngày: người gặp `PHA 2`
> trong `vault.ak` rồi tra ở đây sẽ kết luận mình đang nhìn tài liệu của kho khác — đúng
> vòng hỏi-đáp mà việc đổi tên này sinh ra để tránh.

**Ngược lại, `required` của ConsumeMAGIC gộp rồi sàn MỘT lần.** `required =
⌊base_price × demand_mult × op_count / Q⌋` — KHÔNG sàn từng op rồi nhân. Hai quy tắc
làm tròn khác nhau nằm cạnh nhau trong cùng repo; chép nhầm quy tắc này sang chỗ kia là
thu thiếu tới `op_count` nanogic mỗi dòng. Neo — **theo TÊN HÀM**:
`ConsumeMAGIC/onchain/lib/magiclamp/consume/pricing.ak` ▸ `required_for` ↔
`ConsumeMAGIC/pricing/src/price.ts` ▸ `requiredForOp` (bản Σ-nhiều-op là `requiredBurn`).

**"Thêm trường ở cuối" KHÔNG giữ được UTxO đã tạo.** Giải mã Plutus Data của Aiken
NGHIÊM NGẶT VỀ SỐ TRƯỜNG, **cả hai chiều** — đo trên v1.1.21: datum 2 trường đọc bằng
type 3 trường FAIL; datum 3 trường đọc bằng type 2 trường **cũng** FAIL; cả hai chết
đúng dòng `expect n: NewD = d`. Nên câu "THÊM Ở CUỐI để KHÔNG dịch chỉ số field cũ"
(`ConsumeMAGIC/onchain/lib/magiclamp/consume/types.ak:51`) đúng **đúng phạm vi của nó**:
nó giữ *chỉ số* các trường cũ, nó KHÔNG giữ *khả năng đọc* các UTxO đã tạo bằng type cũ.
Thêm một trường là buộc di trú mọi UTxO đang sống, không phải nâng cấp tương thích ngược.

**Chỉ số constructor Plutus Data là hợp đồng nhị phân.** Lược đồ TypeScript trong
`types.ts` dùng `Data.Enum`/`Data.Object` mà **thứ tự mã hoá tag constructor**. Đổi thứ tự
một variant, hoặc bỏ một field, là đổi cách decode — mọi UTxO đã tạo trên chain sẽ không
đọc được nữa. Thứ đã bỏ khỏi mô hình (`BatchSource::Snapshot`, `::Vacuum`, trường
`vacuum_orders`) vẫn phải **nằm nguyên chỗ cũ làm bia mộ**.

**`lamp_asset_name` là tham số theo mạng.** `tLAMP` trên testnet, `LAMP` trên mainnet; nó
là apply-param **#2** của mọi vault. Hardcode giá trị testnet vào code là dựng ra một vault
mainnet không bao giờ nhìn thấy LAMP của chính nó.

**INV-VAULT-IDENTITY.** Vault nào cũng mang một NFT one-shot sinh cùng lúc với vault
(`asset_name = blake2b_256(cbor.serialise(seed))`, policy = chính script hash của vault).
Mọi nhánh spend đòi NFT còn nguyên. Off-chain tạo vault **bắt buộc** mint NFT — quên là
LAMP kẹt vĩnh viễn. Lý do: Cardano chỉ chạy validator lúc tiêu, không bao giờ lúc tạo.

**INV-ONE-PERSON-ONE-VAULT — mỗi người MỘT DID, mỗi DID MỘT vault.** Chốt 2026-09-16. Đây là
bất biến chống Sybil cho mọi thứ được cấp một lần cho mỗi vault — hiện là hạt giống
`wakeme_seed_credit` ghim ở genesis (`InstantGen/onchain/lib/magiclamp/protocol/constants.ak`).
Không có nó, "một lần mỗi vault" chỉ bằng "một lần mỗi lần trả phí mở vault".

Bất biến này nói HÌNH DẠNG cưỡng chế chứ không chỉ nói mục tiêu: buộc vault vào DID rồi ép tính
duy nhất ở cổng genesis. Ba lối khác — hạ giá trị hạt giống, thêm hàng rào tỷ lệ, đếm theo thiết
bị — đều KHÔNG thoả, và đã loại.

**Trạng thái cưỡng chế, đo 2026-09-17: repo này CHƯA ép vế nào.**

- `validate_mint_vault_id` (`InstantGen/onchain/validators/vault.ak`) đọc **0** reference input;
  hai chỗ duy nhất dùng `tx.reference_inputs` đều nằm ở nhánh spend (`:409` UM, `:418` beacon).
- `grep -rn "taad|anchor_nft|person_did" InstantGen/onchain --include="*.ak"` → **0 dòng**.

Hai vế đang được ép ở repo danh tính: `PhoenixKeyDID/Validator` ▸ `validators/taad.ak` ▸
`genesis_uniqueness_ok` cho vế *một người = một DID*. Vế *một DID = một két* của két Wakeme bên
đó được ép bằng hai chỗ: `validators/wakeme_vault.ak` ▸ `anchor_nft_name` (apply-param
`= blake2b_256(did)`) buộc két vào DID, và `lib/phoenixkey/wakeme_logic.ak` ▸
`genesis_anchor_flip_ok` CHI anchor rồi lật cờ `wakeme_vault_policy` từ `None` sang `Some` (khoá
vĩnh viễn). Vault của InstantGen là một script KHÁC, nên không cơ chế nào ở trên phủ nó.

Một tham chiếu tới NFT anchor ở cổng genesis là **CẦN nhưng chưa ĐỦ**. Reference input được
**đọc**, không bị **tiêu**, nên nó buộc vault vào một DID có thật mà không chặn được N vault cùng
một DID. One-shot của `INV-VAULT-IDENTITY` cũng không cứu, vì `asset_name = blake2b_256(seed)`
khoá theo UTxO, mà một người giữ được nhiều UTxO. Cây danh tính mang đúng một bit mỗi DID (có /
không). Datum anchor có một ô cờ, nhưng ô đó thuộc riêng két Wakeme; thêm ô cho vault của repo
này là đổi lược đồ datum anchor bên kia, cùng loại chi phí với lối bị loại ngay dưới.

**Hướng đã chốt (2026-09-17): repo này giữ một accumulator RIÊNG, khoá theo DID.** Mở vault = một
lượt chuyển trạng thái của accumulator (DID từ *chưa có vault* sang *đã có vault*) trong cùng giao
dịch genesis, cộng bằng chứng thành viên DID ở cây danh tính. Lối bị loại là nới cấu trúc lá của
cây danh tính: nó đổi encoding lá ⟹ đổi `root` ⟹ đổi hash validator bên đó, và đặt một bất biến
của repo này vào cấu trúc mà repo khác có quyền đổi.

Bước chuyển là **MỘT CHIỀU**: đóng vault KHÔNG đưa DID về *chưa có vault*. Nếu đưa về được, người
dùng đóng rồi mở lại là nhận lại hạt giống.

**CHƯA CHỐT — giá trị của lá accumulator.** Một bit (*đã có vault*) là đủ cho tính duy nhất, nhưng
sau genesis thì không tra ngược được vault nào thuộc DID nào (DID không nằm trong datum,
`asset_name` suy từ `seed`). Ràng buộc tạm: không luồng nào trong repo này được giả định tra ngược
được từ vault ra DID.

**CHƯA CHỐT — hình dạng bằng chứng.** Đo 2026-09-17 bằng `aiken check` v1.1.21 trên thư viện SMT
của repo danh tính: ở chiều sâu 256, `verify` tốn 4.459.801 mem, `register_transition_ok` tốn
8.921.112 mem; và hai danh sách 256 sibling dạng Plutus Data dài khoảng 17.412 byte, **vượt trần
kích thước giao dịch 16.384 byte** (tính bằng bộ sinh, chưa dựng giao dịch thật). Nên hình dạng
"hai bằng chứng SMT đầy đủ trong giao dịch genesis" không dựng được. Ràng buộc tạm: chưa viết mã cổng
genesis nào cho tới khi hình dạng được chốt.

Không vế nào ở trên là một trường danh tính trong `VaultDatum` của repo này: thêm trường là đổi số trường của datum ⟹
đổi lược đồ ⟹ buộc di trú mọi UTxO đang sống (xem "Thêm trường ở cuối" bên dưới).

Hệ quả vận hành phải biết TRƯỚC khi dựng:
- **Trần song song của việc mở vault = số shard của accumulator**, không phải số block: đổi
  `root` là tiêu một UTxO rồi tạo lại. Số shard vì thế là tham số công suất, và đổi nó sau khi
  dựng là dựng lại cụm.
- **Cụm accumulator là điều kiện tiên quyết của mọi vault.** Một lượt dựng lại bỏ sót nó thì cổng
  genesis đòi chi một UTxO shard của accumulator không tồn tại ⟹ không vault nào mở được.

Ràng buộc TẠM đang có hiệu lực cho tới khi vá, fail-closed: **chỉ chạy testnet**.

**INV-MAGIC-CITIZEN — InstantGen và ScheduleGen sinh theo MỘT công thức chung của ba đầu vào: LAMP
trong vault, tỷ lệ consumed/generated, thặng dư GreenBack; không gắn MAGIC đang cầm.** Nguồn duy
nhất của công thức, vai từng thành phần và danh mục CHƯA CHỐT:
`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md` v2.0 §6.1.1–§6.1.6 và bảng §12 — đừng chép công thức
xuống đây. Chủ dự án chốt 2026-09-17, thay bản trước của mục này (độ lớn thưởng do MAGIC đã tiêu
quyết, LAMP chỉ làm cổng/trần/hệ số, người tiêu 0 nhận 0) — bản đó trái ý định "người dùng tự sinh
MAGIC bằng LAMP của họ" và bị bỏ, không giữ kèm đính chính.

Ba điều phải giữ khi sửa mã, vì chúng là hình dạng chứ không phải con số:
- "Đã tiêu" = bị trừ khỏi `magic_batches` qua nhánh `BurnBatch`; MAGIC **hết hạn KHÔNG tính** là
  đã tiêu nhưng **vẫn tính** là đã sinh.
- Tỷ lệ tiêu thụ chỉ **hạ** được lượng sinh xuống sàn, không nâng quá suất `ρ`; thặng dư GreenBack
  chỉ là **trần + cổng**, không nhân. Hai điều này là thứ giữ phanh vật lý theo LAMP-khoá đứng vững
  khi khoá beacon bị chiếm (SPEC v2.0 §6.1.5).
- Quyền biểu quyết KHÔNG đổi: vẫn keyed MAGIC-đã-tiêu cross-DID, theo
  `LAMP/Governance/VotingPower/CONTRACT.md`.

**Bốn điểm treo của mô hình sinh đã được chủ dự án chốt 2026-09-19** (chi tiết + cái giá từng
mục: SPEC v2.0 §13, bảng *"ĐÃ CHỐT 2026-09-19"*). Hai mục dưới đây đổi thứ người sửa mã phải làm,
nên nêu ở đây thay vì chỉ trỏ:

- **`CC-GEN-L-TIMING` — LAMP dùng để sinh bị khoá tới hết epoch SAU**, không phải hết epoch hiện
  tại. Cổng `current_epoch > instant_lock_epoch + 1` phải áp ở **MỌI** nhánh đọc `lamp_available`
  hoặc rút LAMP (`InstantGen` · `WithdrawLamp` · `UpdateProfile`) — sót một nhánh là thủng, và
  đây đúng là ca mà `§5` cảnh báo: đổi ràng buộc thì grep TOÀN BỘ nơi gọi.
- **`CC-GEN-COLD-START` — vault chưa có lịch sử đứng ở mức TRUNG TÍNH**, và ở trạng thái đó
  `scale_limit` không ràng buộc. Hệ quả: đóng vault rồi mở lại là một cách xoá lịch sử xấu có lợi.
  **Ràng buộc TẠM đang có hiệu lực, fail-closed: chỉ chạy testnet** tới khi
  `INV-ONE-PERSON-ONE-VAULT` được ép ở cổng genesis.

**`B` là một DANH MỤC token** (chủ dự án chốt 2026-09-18), không phải một tài sản đơn: ADA, NIGHT,
CHECK, WORK, có thể thêm. Ba hệ quả cho người sửa mã — một danh mục cần **một nguồn giá mỗi tài
sản** (F6 đổi hình dạng, SPEC §6.3); `INV-BACKING-NO-LAMP` **không đổi**; và người ghi beacon
backing là **keeper tầng GreenBack của kho này**, không phải engine CarpetMint. Ba chỗ trong kho
còn khai ngược điều cuối và phải sửa khi đụng tới: `scripts/config.ts` ▸ mặc định `backing` ·
`scripts/test/instant_only.ts` ▸ câu `"SHUT until CARP ships the beacon"` · `DevStatus.md` Nợ #2.
Hành vi fail-closed (mặc định all-zero) thì **giữ nguyên** — chỗ sai là lời khai, không phải cổng.

Hiệu lực: chỉ cho vault **deploy lại**; không hồi tố vault Preprod đang sống (SPEC v2.0 §6.1.6).

**Hiện trạng mã — CHƯA theo mục trên** (kiểm 2026-09-17). Chỗ đang chạy, theo TÊN HÀM:
- `InstantGen/onchain/lib/magiclamp/protocol/math.ak` ▸ `compute_reward_from_consumed` — vế thưởng,
  nhận `consumed`, `um_q` (UM) và `pm_q` (enum hồ sơ), không nhận tham số LAMP. Lượng cấp thật là
  `compute_instant_grant = min(vế thưởng, cap_surplus, compute_cap_pp(L_avail))`: LAMP chỉ vào ở vế
  TRẦN, và `compute_cap_pp` còn chia đôi suất.
- Ở vault InstantGen và ScheduleGen (`onchain/validators/vault.ak` của mỗi module),
  `consumed_credit` chỉ tăng ở `validate_burn_batch`; `validate_prune_expired` không cộng gì vào
  nó. Không tệp mã nào đếm tỷ lệ consumed/generated.
- Genesis của InstantGen ghim `consumed_credit == wakeme_seed_credit`. Dưới mô hình mới hạt giống
  không vào công thức sinh; vai còn lại của nó là CHƯA CHỐT `CC-GEN-SEED-CREDIT` (SPEC v2.0 §13).
- MAGIC tiêu từ PrepaidGen không ghi vào `consumed_credit` nào (`grep consumed_credit` trong
  `prepaid.ak` → 0 dòng) — khớp ràng buộc tạm `CC-GEN-PREPAID-IN-RATIO` (SPEC v2.0 §13).

Phép thử một dòng trước khi sửa công thức sinh: *"hệ số tiêu thụ có nâng được suất quá `ρ` không,
và thặng dư GreenBack có đang NHÂN vào lượng sinh thay vì chặn trên không?"* Một trong hai là có ⟹
kẻ chiếm khoá beacon hoặc kẻ tự-tiêu-cho-mình vượt được phanh LAMP-khoá ⟹ vi phạm.

**Apply-param được phép thay đổi theo LOẠI script, KHÔNG theo từng thực thể.** Đây là
kết luận của D12, chốt 2026-08-28 sau khi hai kiến trúc `INV-VAULT-IDENTITY` không tương
thích nhị phân cùng tồn tại trong kho. Bản được giữ là bản đang mô tả ngay bên trên: mint
gộp vào chính script vault, `asset_name` suy từ `seed`, một policy phát N vault-NFT.

Nghĩa đen, cho người sắp sửa mã: **apply-param là tham số lúc BIÊN DỊCH.** Đổi giá trị của
nó là đổi bytes ⟹ đổi script hash ⟹ đổi địa chỉ ⟹ phải công bố một script tham chiếu
CIP-33 mới. Cho nên số bản đã biên dịch phải nuôi bằng đúng số **giá trị khác nhau** mà
apply-param nhận. Từ đó ra một phép thử một dòng, dùng được ở mọi module:

> Trước khi thêm một apply-param, hỏi: **giá trị này đổi theo cái gì?** Đổi theo *loại*
> script (mỗi cửa gen một bản: Schedule, Instant, Prepaid) thì được — N nhỏ, hữu hạn, và
> mỗi bản là một thứ khác nhau thật. Đổi theo *từng người dùng / từng UTxO / từng lần tạo*
> thì KHÔNG — định danh thực thể phải nằm ở **datum** hoặc ở **tên tài sản**, không nằm ở
> apply-param.

Bản bị loại chết đúng phép thử đó, và chính nó tự khai ra: `origin/main:ConsumeMAGIC/onchain/validators/vault_id_nft.ak:14-16`
viết *"MVP là MỘT policy / MỘT vault — mỗi vault deploy một `genesis_ref` riêng nên policy
id khác nhau, và `consume.ak` được apply-param bởi đúng cặp policy/name của vault nó phục
vụ"*. Ghép hai vế lại: `genesis_ref` đổi theo từng lần tạo vault ⟹ policy id đổi theo từng
vault ⟹ `consume` đổi hash theo từng vault. Mỗi người dùng mở vault là kho phải biên dịch,
deploy và công bố ref-script một bản `consume` RIÊNG. Cộng với Nợ #20 (`consume` đã phải
tách giao dịch vì vượt trần 16.384 byte) thì chi phí mở một vault tăng tuyến tính theo số
người dùng — trong khi mô hình là **mỗi PersonDID một vault**.

Bản được giữ vẫn có `vault_script_hash` làm apply-param (`ConsumeMAGIC/onchain/validators/consume.ak:75-83`,
7 tham số) và điều đó ĐÚNG phép thử: nó đổi theo *loại* vault, không theo từng vault. Ba
cửa gen ⟹ ba bản `consume`, hết. Cùng lý do đó, `consume` cố ý không giải mã `VaultDatum`
mà chỉ đọc trường 0 qua `un_constr_data` (`consume.ak:442-461`) — để một mã nguồn phục vụ
được nhiều loại vault.

Hệ quả phải làm ngay khi mở một loại vault mới: deploy thêm MỘT bản `consume` apply-param
bằng hash của nó. Không phải sửa Aiken. Xem `scripts/run_consume_schedule_e2e.sh`.

**`Σburns == required`** (ConsumeMAGIC) — dấu bằng. Lệch một nanogic là giao dịch bị từ
chối. Nên mọi thay đổi trong bộ định giá phải giữ hai phía khớp tuyệt đối.

**Giới hạn cứng cưỡng chế on-chain** — khai ở cả `constants.ts` lẫn `constants.ak` của
từng module, phải giữ đồng bộ: `MAX_BATCHES_PER_VAULT=32`, `MAX_LOYALTY_HOLDINGS=40`,
`MAX_GEN_SCHEDULES=20`, `MAX_FIRES_PER_TX_CATCHUP=8`, `SHARD_COUNT=16`,
`SHARD_CAP=4.5×10¹⁴ oildrop`.

> `MAX_LOYALTY_HOLDINGS` hạ **64 → 40** ngày 2026-09-14. Bản cũ đặt trần TRÊN trần vật
> lý: một vault chạm trần cũ thì **KHÔNG TIÊU ĐƯỢC**, và `validate_fire` là nhánh duy
> nhất hạ được `lamp_locked`.
>
> Ba điều phản trực giác, viết ra vì chúng là **kết luận**, không phải số đo — nên chúng
> không già đi theo mỗi lần đo lại.
>
> **(a)** `validate_commit` phải có cổng đếm holding chứ không chỉ `validate_fire`; bản
> cũ thiếu đúng cổng đó.
>
> **(b) Và cổng ở nhánh commit mang dấu NGHIÊM (`<`), không phải `<=`** như ba cổng kia.
> Đường RA tự nó dài thêm ĐÚNG một phần tử: `unlock_oldest` cắt holding ở biên lượt nhả
> thành `(epoch, đã mở)` + `(epoch, còn khoá)`, mà `same_bucket` đòi trùng cả `is_locked`
> nên `coalesce_holdings` không gộp hai mảnh đó. Chạm đúng trần ở bước commit vì thế là
> dựng một vault khoá LAMP vĩnh viễn — vào được, không ra được, và không có cửa phụ vì
> `lamp_locked` chỉ giảm ở nhánh fire. Một suất là **đủ** và là **tối thiểu**; chứng minh
> chặn trên nằm cạnh chính cổng đó trong `validators/vault.ak`, cùng hai bài canh
> (`c_commit_full_lock_at_cap_rejected`, `cf_commit_at_cap_then_fire_ok`).
>
> **(c) Hai nhánh có hai thủ phạm KHÁC NHAU** — câu "thủ phạm không phải `list.sort`"
> đúng cho FIRE và **sai cho COMMIT**. Nhánh nào đang hẹp nhất thì **đã đảo một lần** sau
> bản vá cho **Nợ #48** (`DevStatus.md`), và có thể đảo nữa; đừng nhớ thứ tự, hãy tra.
>
> `#48` một mình là chuỗi MƠ HỒ trong kho này và đừng viết nó trơ: nó vừa là **Nợ #48** ở
> `DevStatus.md` vừa là một **PR #48** trên GitHub nói về chuyện khác hẳn. Cùng hình dạng
> với bẫy `PHA-2` và bẫy `28e916b0…` — cùng ký hiệu, khác đời, không bản nào tự khai. Viết
> `Nợ #48` hoặc `PR #48`, đủ chữ để người tra không phải đoán.
>
> **Số đo KHÔNG nằm ở đây, và cũng không nằm ở `constants.ak`** — chỉ ở MỘT chỗ:
> `ScheduleGen/onchain/validators/vault.ak` ▸ khối *"Chi phí ExUnit theo TRỤC `loyalty_holdings`"*,
> ngay trên `t_fire_datum_n`, cùng với cách đo, **BA** cặp thang đo (tên từng cặp khai
> tại mục *"THANG ĐO"* trong chính tệp đó — đừng chép xuống đây), mốc kích hoạt phần còn
> nợ, và lý do KHÔNG nâng trần theo phần biên vừa mua được. Đo lại là một lệnh
> `aiken check`.
>
> Bản trước của dòng này liệt kê **hai** cặp và gọi tên chúng ra (`probe_commit_fixture_cap` /
> `probe_fire_fixture_cap`). Liệt kê thiếu vì nhánh commit có **hai họ fixture** cho cùng
> một nhánh mã — khoá TRỌN và khoá MỘT PHẦN — và chúng cho hai trần khác nhau ở cùng một
> `n`, vì `select_lamp_for_lock` cắt một holding ở họ thứ hai nên độ dài SAU commit lệch
> một. Một danh sách tên gọi trong tài liệu thì già đi theo mỗi cặp mới; một con trỏ tới
> mục khai thì không.
>
> Bản trước của khối này vẫn chép số xuống dù chính nó dặn đừng chép — và phần chép lại
> là phần sai, đúng lần thứ hai. Chú thích ở `constants.ak` cũng chép, cũng sai, và nằm
> đúng chỗ người ta tra để chọn trần. Hai bản sao đó nay đã gỡ.
>
> 🔴 **Và bản hoà này đã bỏ một câu của nhánh kia: "fire chết TRƯỚC commit".** Câu đó
> đúng lúc viết và **đã bị chính phép đo lật** sau bản vá cho Nợ #48 — nay commit là nhánh hẹp
> nhất. Nó bị bỏ chứ không được giữ kèm đính chính, vì trí nhớ thì nạp cùng lúc: giữ cả
> hai bản là giữ một mâu thuẫn, và không bản nào tự khai là đã bị bác. Vế còn sống của
> câu đó — *cửa RA hẹp hơn cửa VÀO nên commit phải có cổng* — nằm nguyên ở mục (a) và (b)
> bên trên, và mục (b) không phụ thuộc nhánh nào đang hẹp hơn.

---

## 3. Quy tắc giao thức ảnh hưởng tới cách sửa code

- **Không huỷ giữa chừng với ScheduleGen** (C-VAC-12, T10) — đã commit thì hoặc fire hoặc
  hết hạn, không hoàn giữa dòng.
- **`profile_at_creation` bất biến trên một batch** (T4, TV-SAMENESS-01) — tham số decay
  đóng băng lúc tạo batch, không bao giờ suy lại từ profile hiện tại của vault.
- **Đổi profile có thời gian nguội** — không đổi hai lần trong 2 epoch liên tiếp.
- **Kiểm tra UM cũ (C-UM-6) chỉ áp cho InstantGen.**

---

## 4. Công cụ

- **Aiken** ≥ 1.1.0, `plutus = "v3"` trong mỗi `onchain/aiken.toml`. Bản 1.1.21 qua pipe
  **đổi định dạng chứ không im lặng**: bảng cho người đọc chỉ ra khi stdout là terminal,
  còn khi bị chuyển hướng thì stdout là **JSON đầy đủ** (đo 2026-08-27: 4.254 byte qua
  pipe / 4.255 byte ghi thẳng tệp — chênh đúng một ký tự xuống dòng). Nên
  `aiken check > /tmp/out.json 2>&1` rồi `json.load` sau khi bỏ mấy dòng tiến-độ trước
  dấu `{` đầu tiên. Bản cũ của dòng này viết "không in gì khi bị đưa qua pipe" và bảo
  dùng `script -q` — **sai**, và cái sai đó tốn nhiều lượt chạy lại.

  🔴 **Và ca im lặng RỘNG HƠN một hằng hex lẻ — đo lại 2026-09-14.** Trên v1.1.21, khi
  stdout KHÔNG phải terminal, `aiken check` in **rỗng cho MỌI lỗi biên dịch**, không chỉ
  ca hằng hex. Đo bằng một lỗi kiểu cố ý (`let x: Int = #"aa"`): chuyển hướng ⟹ stdout
  RỖNG, stderr chỉ hai dòng `Compiling`; **cùng lệnh đó** chạy dưới `script -q /dev/null`
  ⟹ in đủ khối `× I struggled to unify…`. Nên câu "qua pipe đổi định dạng chứ không im
  lặng" ở ngay trên đúng cho ca **THÀNH CÔNG** và sai cho ca **LỖI** — và đó là chiều
  hỏng tệ hơn, vì nó im đúng lúc có thứ cần đọc.

  **Quy trình đúng, hai bước, đừng bỏ bước hai:**
  `aiken check 2>/dev/null > out.json` → mã thoát 0 thì `json.load(out.json)`; mã thoát
  KHÁC 0 thì **chạy lại dưới `script -q /dev/null aiken check`** rồi đọc output đó. Đi
  thẳng vào `json.load` ở nhánh lỗi sẽ ném `ValueError` trên một tệp rỗng, và lỗi bạn
  đọc được là lỗi của trình phân tích JSON — nó trỏ đi chỗ khác.

  Ca hằng hex **lẻ ký tự** (`#"a11ce"`) vẫn ghi lại ở đây vì nó là ca đầu tiên tìm ra và
  vì nó cho một số đo gọn:

  ```
  #"a11ce"   (5)  → exit=1, TOÀN BỘ stdout+stderr = 42 byte: "Compiling magiclamp/… (.)"
  #"a11ce0"  (6)  → exit=0, JSON đầy đủ
  ```

  Nghĩa là công thức `json.load` ở trên sẽ ném `ValueError` trên chuỗi 42 byte đó, và lỗi
  bạn đọc được là lỗi của **trình phân tích JSON**, không phải lỗi biên dịch thật — nó trỏ
  đi chỗ khác. Nên khi `aiken check` thoát khác 0 mà output không có dấu `{`, hãy in
  nguyên output thô ra rồi đi soi hằng hex, đừng đi soi pipe. Nguồn phát hiện: nhà LAMP
  (`magic-etags-r`, 2026-08-28); kho này tự dựng lại phép đo để xác minh.
- **Node.js** ≥ 20, ES modules. Off-chain dùng `@lucid-evolution/lucid` + `vitest`. Script
  deploy chạy thẳng bằng `tsx`.
- **`npm install` phải chạy được từ checkout sạch, không có bước dựng tay đi trước.** Vì
  không có workspace ở gốc, gói nào xuất bản `dist/` (`ProtocolUtils`,
  `ConsumeMAGIC/pricing`) đều được nạp qua `file:` — mà npm chạy `prepare` của một
  dependency `file:` ngay trong thư mục gói đó **và không cài `devDependencies` ở đó**.
  Nên `prepare` không được gọi thẳng `tsc`: nó gọi `prepare.mjs`, kịch bản tự cài bộ công
  cụ rồi dựng các `file:` dep có `prepare` riêng trước khi build. Thêm gói có `dist/` mới
  thì chép `prepare.mjs` sang, đừng viết `"prepare": "npm run build"`.
- Validator **không** được build sẵn trong repo: `aiken build` sinh `onchain/plutus.json`
  (artifact, đã gitignore) trước khi deploy.

---

## 5. Ranh giới khi sửa

- **Đổi ràng buộc / chữ ký / đường import → grep TOÀN BỘ nơi gọi + test, sửa đồng thời.**
  Bài học đắt nhất của repo này là một danh sách apply-param lệch với chữ ký validator:
  không test nào đỏ, không compile nào gãy, và sai chỉ lộ ra dưới dạng một vault trên
  mainnet có LAMP thật mà không ai spend được.
- **Tệp lỗi thời thì XOÁ. `Legacy/` đã bãi bỏ** (chủ nhân chốt 2026-08-09, nguồn
  `_rules/agent-hygiene.md §4`). `Legacy/` đang có thì **để yên** — xoá dần khi đụng tới, mỗi
  lần một mục. Đừng dọn ngược cả loạt, và đừng dồn thêm gì vào đó. Ba điều kiện khi xoá,
  thiếu một là chưa xong:
  1. 🔴 Chỉ xoá thẳng thứ **đã commit** — git nhớ hộ nên hoàn tác được. Tệp chưa track thì xoá
     là mất vĩnh viễn: commit trước, hoặc hỏi.
  2. Xoá phải **kèm vá tham chiếu, chứng minh bằng lệnh** — dán output `grep` cho thấy 0 tham
     chiếu treo, cộng một lệnh build/typecheck xanh. Nhãn "đã dọn" không kèm output thô là
     **chưa dọn**.
  3. **Rà lại mã đã viết DỰA TRÊN tệp vừa xoá.** Xem bài học ở cuối mục này.
- **Trước khi xoá, tra `DevStatus.md` mục `## Không được xoá`.** Định danh đã lên chain (chỉ
  số constructor, tên asset, thứ tự trường datum, thứ tự apply-param) **không bao giờ** là tệp
  lỗi thời — bỏ đi là vỡ decode mọi UTxO đã tạo.
- **Không đọc `Legacy/`** trừ khi được yêu cầu rõ. Nó là kho lịch sử, không phải nguồn.
- **Một sự thật một nơi giữ.** Cần số test thì trỏ `DevStatus.md` hoặc chạy lệnh, đừng chép.
- **Commit đặt tên tác giả thật**, không đặt tên công cụ.
