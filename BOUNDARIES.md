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
- **CARP** — đồng-thanh-khoản, native token riêng, chuyển nhượng được.

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
> — từ DESIGN-2, thưởng khoá theo `consumed` chứ không theo `L` (INV-MAGIC-CITIZEN: thưởng
> gắn MAGIC ĐÃ TIÊU, không gắn MAGIC nắm giữ). Hình dạng ba-bước-sàn thì không đổi, và
> đó mới là phần bất biến.

**`DESIGN-2` là gì, và vì sao nó không còn tên `PHA-2`** (đổi 2026-09-12). `DESIGN-2` là
**đời thiết kế thứ hai của kho này** — mốc mà `I-ACT-7` bắt LAMP ĐỨNG YÊN và thưởng khoá
theo `consumed` thay vì theo `L`. Nó là một MỐC THIẾT KẾ, không phải một pha vòng đời của
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
chưa được quét: kho đã về **0** ngoài `Legacy/` (`Legacy/` để yên theo §5).

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
> lý: đo `aiken check` trên giao dịch trọn vẹn (đã trừ chi phí dựng fixture) cho
> ScheduleGen **commit 128,6 %** và **fire 138,9 %** `maxTxExMem` ở 63/64 holding — nghĩa
> là một vault chạm trần cũ thì KHÔNG TIÊU ĐƯỢC, và `validate_fire` là nhánh duy nhất hạ
> được `lamp_locked`. Ở 40: commit 58,4 %, fire 62,2 %. Điểm chết khớp bậc hai: fire
> n ≈ 53, commit n ≈ 55.
>
> Hai điều đi kèm, cả hai đều phản trực giác nên viết ra: **(a) fire chết TRƯỚC commit**
> — cửa RA hẹp hơn cửa VÀO, nên `validate_commit` phải có cổng đếm holding chứ không chỉ
> `validate_fire`; bản cũ thiếu đúng cổng đó. **(b) Thủ phạm bậc hai KHÔNG phải
> `list.sort`** mà là mẫu `foldl` + `merge_into(acc, h)` trong `coalesce_holdings` và
> `list.concat(acc, […])` trong `lock_youngest` (`ScheduleGen/onchain/lib/magiclamp/protocol/lock.ak`).
> Chú thích của chính `coalesce_holdings` đã tự khai *"O(n²)… revisit only if fire
> ExUnits actually bite"* — chúng cắn rồi. Ai đi tối ưu thì nhắm vào hai chỗ đó.

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
