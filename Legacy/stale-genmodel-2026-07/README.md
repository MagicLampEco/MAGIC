# Legacy — mô hình sinh MAGIC LỖI THỜI (chuyển 2026-07-17)

> **Đừng đọc các file ở đây để lấy chuẩn.** Chúng mô tả mô hình sinh MAGIC đã bị **Wakeme** thay.
> Nguồn chuẩn hiện hành: `PhoenixKeyDID/Wakeme/spec/PhoenixKey-Wakeme-{Math,Tech}.md` (module primitive của PhoenixKey).
> Whitepaper tokenomic bản mới: `/LAMP/docs/` (repo LAMP — MAGIC phụ thuộc LAMP một chiều).

## Vì sao lỗi thời

Mô hình THẬT là **GenDrip**: user nắm LAMP-có-điều-kiện (`conditional_lamp`) trong vault Wakeme →
engine Gen **ĐỌC** số dư qua `reference_input` → nhỏ-giọt MAGIC vào tài-khoản-trong-vault.
**LAMP đứng yên** (`gen_drip_ok`: `c′ = c ∧ L(out) = L(in)`, bất biến **I-ACT-7**).
MAGIC = account-trong-Vault, **KHÔNG mint token, KHÔNG policy-id, không chuyển nhượng**.

Wakeme nói thẳng (`PhoenixKey-Wakeme-Math.md:300`, mục §3.7-1, chủ = MAGIC/CARP-team):

> Code MAGIC-repo cũ fire-LAMP→Treasury **LỖI THỜI** — nếu tái dùng **vi phạm I-ACT-7**.

Thêm: **nguyên tắc tấm-pin** (Wakeme chốt 2026-07-17) — LAMP đặt TẠM trong vault để sinh MAGIC,
**user KHÔNG BAO GIỜ sở hữu/nhận LAMP**; mọi LAMP rời vault CHỈ về **pot**. Vòng LAMP đóng kín.

## Bằng chứng từng file

| File | Dấu hiệu lỗi thời | Dòng (bản gốc) |
|---|---|---|
| `Whitepaper-MagicLamp-Tokenomic-Vi.md` | **cổng-tiêu-thật** (consumption-gate) — sai: chỉ cần nắm LAMP là được gen | L209 "Điều kiện cần (cả hai): (1) nắm LAMP đủ tư cách; (2) **tiêu dùng thật** trong epoch" |
| ″ | **trung-bình-có-trọng-số 7 epoch** — không còn dùng | L214 `M = w₀·M(L₀) + w₁·M(L₁) + … + w₆·M(L₆)` |
| `InstantGen-HALVING-SPEC.md` | **halving / ApplyHalving** — cơ chế đã bỏ toàn bộ | toàn file |

## Phần vẫn CÒN GIÁ TRỊ (đã kế thừa sang bản mới, không vứt)

- **Lập luận pháp lý** (Whitepaper §11 + cảnh báo L207): "KHÔNG phải thu-nhập-thụ-động,
  KHÔNG phải lãi-suất — là khuyến-khích-tham-gia". Bản mới GIỮ kết luận này nhưng đổi lá chắn:
  cổng-cứng → **dốc-thưởng** (người tiêu-thật hưởng bội số; người ôm chỉ được mức sàn),
  cộng lá chắn mạnh hơn sẵn có: **MAGIC không chuyển nhượng, không policy-id ⟹ không bán được ⟹ không thể là thu-nhập**.
- Đơn-vị + hệ sinh thái + phần định-tính không dính công-thức-gen.

## Module chuyển vào đây 17/7 (mô hình GenDrip thay)

| Module | Vì sao chết | Ai thay |
|---|---|---|
| `InstantGen/` | purchase-model: trả LAMP → Treasury để mua MAGIC + UM/PM stale-check | **GenMAGIC** (nắm-LAMP → drip, LAMP đứng yên) |
| `SnapshotGen/` | công thức `L × R × LF×OAC × PM × B / Q⁵` — keyed-holding + profile Ember/Flame/Lantern | **GenMAGIC** |
| `Consolidate/` | gộp `loyalty_holdings` phân mảnh | Không cần — mô hình account 1-DID-1-account không phân mảnh |

`scripts/` ở gốc repo (deploy 02_deploy_um, 05_create_instant_vault, 06_create_vacuum_vault, test/*)
tham chiếu các module này ⟹ **cũng thuộc mô hình chết**, cần dựng lại cho GenDrip (chưa làm — flag cho Tuân).

## Bản thay thế

| Nội dung | Chuẩn hiện hành |
|---|---|
| Cơ chế vault + bất biến LAMP | `PhoenixKeyDID/Wakeme/spec/PhoenixKey-Wakeme-Math.md` (I-ACT-1..8b) |
| Kiến trúc engine Gen (scale) | `PhoenixKeyDID/Wakeme/PhoenixKey-MAGIC-Vault-Scale-Analysis.md` + `…-Tech.md §3.6` |
| Công thức sinh MAGIC + tư-cách | `MAGIC/Specs/` (bản GenDrip — đang dựng) |
| Whitepaper tokenomic | `/LAMP/docs/` |
