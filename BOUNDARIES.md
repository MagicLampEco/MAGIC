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

**Số học Q-format nhân-chia tuần tự.** `M = L × R × UM × PM / Q³` áp thành **ba** bước
`⌊ × / Q ⌋` riêng, không phải một lần nhân hết rồi chia. Đây là thứ chặn sai số làm tròn
theo spec §6.1 / L4.

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

- **Aiken** ≥ 1.1.0, `plutus = "v3"` trong mỗi `onchain/aiken.toml`. Bản 1.1.21 **không in
  gì khi bị đưa qua pipe** — muốn giữ output thì `script -q /tmp/out.txt aiken check`.
- **Node.js** ≥ 20, ES modules. Off-chain dùng `@lucid-evolution/lucid` + `vitest`. Script
  deploy chạy thẳng bằng `tsx`.
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
