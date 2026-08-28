# BOUNDARIES — ràng buộc cho ai (người hay agent) sửa mã trong repo này

Tệp này được track, dùng chung cho cả người và agent. `CLAUDE.md` là tệp nội bộ của từng
máy và chỉ `@import` tệp này — đừng chép nội dung sang đó.

> Mô hình chuẩn: [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](SPEC/MagicLamp-Tripletoken-Feat-(Vi).md).
> Trạng thái module: [`DevStatus.md`](DevStatus.md). Lịch sử: [`ChangeLog.md`](ChangeLog.md).

---

## 1. Đây là cái gì

Hợp đồng Cardano L1 (PlutusV3, Aiken) cho hệ ba token:

- **LAMP** — tài sản nền, native token, cố định 36 tỷ, không mint thêm, không burn.
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
theo spec §6.1 / L4. Neo: `InstantGen/onchain/lib/magiclamp/protocol/math.ak:81-83` ↔
`InstantGen/offchain/src/math.ts:73-76`.

> Bản cũ của dòng này viết công thức là `M = L × R × UM × PM / Q³`. **Tên biến đó đã cũ**
> — từ PHA-2, thưởng khoá theo `consumed` chứ không theo `L` (INV-MAGIC-CITIZEN: thưởng
> gắn MAGIC ĐÃ TIÊU, không gắn MAGIC nắm giữ). Hình dạng ba-bước-sàn thì không đổi, và
> đó mới là phần bất biến.

**Ngược lại, `required` của ConsumeMAGIC gộp rồi sàn MỘT lần.** `required =
⌊base_price × demand_mult × op_count / Q⌋` — KHÔNG sàn từng op rồi nhân. Hai quy tắc
làm tròn khác nhau nằm cạnh nhau trong cùng repo; chép nhầm quy tắc này sang chỗ kia là
thu thiếu tới `op_count` nanogic mỗi dòng. Neo:
`ConsumeMAGIC/onchain/lib/magiclamp/consume/pricing.ak:157` ↔
`ConsumeMAGIC/pricing/src/price.ts:174`.

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
từng module, phải giữ đồng bộ: `MAX_BATCHES_PER_VAULT=32`, `MAX_LOYALTY_HOLDINGS=64`,
`MAX_GEN_SCHEDULES=20`, `MAX_FIRES_PER_TX_CATCHUP=8`, `SHARD_COUNT=16`,
`SHARD_CAP=4.5×10¹⁴ oildrop`.

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

  🔴 **Nhưng có một ca `aiken check` thoát 1 mà KHÔNG in một dòng chẩn nào**: hằng hex
  **lẻ ký tự** (`#"a11ce"`). Tự đo trên v1.1.21, cùng cây nguồn, chỉ đổi độ dài hằng:

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
