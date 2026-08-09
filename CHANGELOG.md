# CHANGELOG — repo MAGIC

> **Vai:** ghi **chuyện đã xảy ra**, mới nhất trên đầu. Mỗi mục nêu đủ ba vế: *đổi gì ·
> vì sao · cái gì gãy nếu ai đó đang bám bản cũ*. Trạng thái hiện tại thì xem
> [`DEVSTATUS.md`](DEVSTATUS.md); mô hình chuẩn xem
> [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](SPEC/MagicLamp-Tripletoken-Feat-(Vi).md).

## 2026-08-09 — Dọn mô hình bốn-cơ-chế vào `Legacy/`, dựng lại tài liệu-vào-đầu

**Đổi gì.** `SnapshotGen/` và `VacuumGen/` rời sang `Legacy/genmagic-v3.3/`, cùng 10 báo
cáo testnet, `SnapshotGen-Simulator.HTML`, `DEVELOPER_GUIDE.md` và 5 tệp script chỉ phục
vụ hai module đó. Đặc tả canonical `SPEC/MagicLamp-Tripletoken-Feat-(Vi).md` được mang về
nhánh làm việc. `README.md` viết lại theo mô hình ba-token. Dựng `CHANGELOG.md`,
`DEVSTATUS.md`, `Legacy/README.md`. Tham chiếu treo trong `scripts/` vá cùng đợt.

**Vì sao.** Ba lớp chi phí đo được trong chính repo này: (1) mỗi lần rà soát, người và
agent phải mở lại 52 tệp của hai module đã chết chỉ để kết luận "bỏ rồi"; (2) cả ba tài
liệu-vào-đầu (`README.md`, `CLAUDE.md`, `DEVELOPER_GUIDE.md`) dẫn người đọc vào mô hình đã
bỏ, và mọi con trỏ "nguồn chân lý" trong mã đều treo vì `SPEC/` không có trên nhánh này;
(3) các báo cáo testnet của module **còn sống** lại mô tả công thức **đã chết**
(`M = L×R×UM×PM/Q³`, "fire chuyển Treasury") — nguy hiểm hơn tài liệu chết hẳn vì trông
vẫn còn thời sự.

**Gãy gì nếu đang bám bản cũ.** Mọi đường dẫn `SnapshotGen/…` và `VacuumGen/…` đổi tiền
tố thành `Legacy/genmagic-v3.3/…`. Bốn npm script biến mất khỏi `scripts/package.json`
(`test:snapshot`, `deploy:vacuum-vault`, `test:vacuum-commit`, `test:vacuum-fire`); hai
biến môi trường `VAULT_SNAPSHOT_HASH`, `VAULT_VACUUM_HASH` không còn ai đọc. Mã trong
`Legacy/` **không cài được** — `file:../../ProtocolUtils` sau khi dời giải ra một đường
không tồn tại; đó là dự tính.

**KHÔNG đổi (cố ý).** Variant `BatchSource::Snapshot`, `::Vacuum` và trường
`vacuum_orders` trong `VaultDatum` giữ nguyên vị trí — chúng là chỉ số constructor / arity
của Plutus Data đã lên chain, bỏ đi là vỡ decode mọi vault đã tạo. Hằng
`snapshot_base_rate_q` giữ nguyên vì ScheduleGen dùng thật. `UMKeeper/` **không** bị dọn:
UM vẫn nằm trong công thức thưởng của InstantGen PHA-2.

## 2026-08-09 — `@magiclamp/consumemagic-pricing` thành gói gọi được (ESM + CJS)

**Đổi gì.** `ConsumeMAGIC/pricing` (0.1.0 → 0.2.0) và `ProtocolUtils` (1.0.0 → 1.1.0) nay
build ra `dist/esm` + `dist/cjs` kèm `.d.ts`, khai báo qua `exports` có nhánh
`import`/`require`. Trước đó `main` trỏ thẳng `src/price.ts` và `"type": "module"`.

**Vì sao.** Bên tiêu thụ chạy Node CommonJS **không `require` được**, cũng không có
endpoint HTTP nào — nên mỗi bên phải **chép tay công thức**, và mỗi bản chép là một chỗ
trôi khỏi nguồn trong im lặng. Đã xảy ra thật một lần (AladinWork, báo về 2026-08-09).

**Gãy gì.** Bên nào đang `import` thẳng `…/pricing/src/price.ts` nên chuyển sang tên gói.
`src/` vẫn nằm trong `files` nên đường cũ chưa chết.

## 2026-08-09 — Neo danh tính vault từ lúc sinh (INV-VAULT-IDENTITY)

**Đổi gì.** Bốn validator vault gộp thêm handler `mint` vào chính `validator vault(...)`,
sinh một NFT one-shot lúc tạo vault (`asset_name = blake2b_256(cbor.serialise(seed))`,
policy = chính script hash); mọi nhánh `spend` đòi NFT còn nguyên, đúng tên. Genesis phải
sạch: mọi trường trạng thái tích luỹ rỗng/0, `lamp_balance` bằng đúng LAMP thật trong
output, `owner` nằm trong signatories. `lamp_asset_name` thành apply-param #2 của mọi vault.

**Vì sao.** Cardano chỉ chạy validator lúc **tiêu**, không bao giờ lúc **tạo**. Nên bất kỳ
ai cũng đặt được một UTxO ở địa chỉ script với datum bịa (`current_amount = 10^18`) rồi rút
MAGIC/LAMP thật. Lỗ này chặn mainnet, đã dựng được PoC.

**Gãy gì.** Chữ ký apply-param của cả bốn vault đổi ⇒ **script hash đổi ⇒ địa chỉ đổi**.
Mọi vault tạo bằng bản cũ nằm ở địa chỉ khác. Off-chain **bắt buộc** phải mint NFT khi tạo
vault — không mint thì vault không spend được, LAMP kẹt vĩnh viễn.

**KHÔNG ghim `profile`** trong genesis dù nó nằm trong datum: đó là lựa chọn chiến lược
của người dùng, không phải trạng thái tích luỹ; ghim vào sẽ chặn hết luồng chuẩn.

## 2026-08-09 — Bịt lỗ giá-về-0 và sàn-áp-sai-chỗ trong bộ định giá ConsumeMAGIC

**Đổi gì.** `required_for` (Aiken) và `requiredForOp` (TS) gộp-sàn-**một lần** cho cả tổng
thay vì sàn từng lượt rồi nhân. `valid_param` bắt buộc `m_min`/`m_max` đúng dải đã ghim và
`base_price == 0 || base_price × m_min ≥ Q`. `buildConsumeTx` đọc `base_price` từ beacon,
hết dùng hằng MVP trên đường tiền. Sổ `op_type` trong `CONTRACT.md` thành bảng 1..6.

**Vì sao.** Hai lỗi do bên tiêu thụ báo lên và dựng lại được: sàn áp trước khi nhân số lượt
làm lệch tích luỹ (mà bất biến on-chain là `Σburns == required`, dấu bằng, nên lệch một
nanogic là tx bị từ chối); và `base_price × m_min < Q` kéo giá về 0 ⇒ **nghiệp vụ chạy miễn
phí trong im lặng**, không bài kiểm nào đỏ.

**Gãy gì.** `PriceParam` có `m_min`/`m_max` ngoài dải ghim nay bị từ chối — beacon cũ phải
cập nhật trước khi mở nghiệp vụ mới. Bên nào đang giữ bản chép công thức riêng phải bỏ và
gọi gói (xem mục gói ở trên).
