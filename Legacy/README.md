# Legacy — kho lưu trữ, KHÔNG phải mã đang chạy

Mọi thứ trong thư mục này đã bị mô hình hiện hành thay thế. Giữ lại **chỉ để tra cứu
lịch sử**: vì sao từng thiết kế thế, số đo cũ, quyết định đã bỏ.

## Ba điều bắt buộc

1. **Không đọc thư mục này** trừ khi được yêu cầu rõ ràng. Đây là lý do nó tồn tại: mỗi
   đợt rà soát trước đây, người và agent đều phải đọc lại mã chết — tốn thời gian, tốn
   token, và tệ nhất là kết luận theo mô hình đã bỏ.
2. **Không build, không cài, không deploy.** Các `package.json` ở đây còn trỏ
   `file:../../ProtocolUtils` — sau khi dời, đường đó giải ra `Legacy/ProtocolUtils`,
   không tồn tại. `npm install` sẽ gãy. Đó là dự tính, không phải lỗi cần sửa.
3. **Không chép mã từ đây ra ngoài.** Cần lại một ý tưởng thì đọc, hiểu, rồi viết lại
   theo mô hình hiện hành — đừng hồi sinh một hàm mang theo giả định đã chết.

## Có gì trong đây

### Mô hình bốn-cơ-chế đã bỏ (2026-08-09)

Mô hình cũ: MAGIC sinh ra qua **bốn** cơ chế (SnapshotGen §8, InstantGen §9, VacuumGen §10,
ScheduleGen §11) với bộ tham số LF · PM · B · UM · OAC · decay.

Mô hình hiện hành (`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`) giữ InstantGen và ScheduleGen
trên một vault hợp nhất, và bỏ hai cơ chế còn lại:

| Đã dời | Nay nằm ở | Vì sao chết |
|---|---|---|
| `SnapshotGen/` | `stale-genmodel-2026-07/SnapshotGen/` | chưa hội tụ lên vault hợp nhất PHA-2; sinh MAGIC không gắn tiêu thụ |
| `VacuumGen/` | `VacuumGen/` | validator còn chuyển LAMP ra Treasury — trái I-ACT-7 (LAMP đứng yên trong vault) |
| báo cáo testnet | `*_TESTNET_REPORT.md`, `TESTNET_RESULTS.md` | của mô hình cũ; công thức trong đó (`M = L×R×UM×PM/Q³`, `lamp_paid ≤ L_avail`, fire chuyển Treasury) nay đều SAI |
| `SnapshotGen-Simulator.HTML` | `SnapshotGen-Simulator.HTML` | mô phỏng LF/OAC — hai tham số đã bỏ |
| `DEVELOPER_GUIDE.md` | `DEVELOPER_GUIDE.md` | hướng dẫn build/deploy theo bốn-cơ-chế |
| 5 tệp deploy/test | `scripts/` | chỉ phục vụ hai module trên |

> **Hai lối đặt tên, một kho.** `stale-genmodel-2026-07/` là đợt lưu kho tháng 7 (có README
> riêng giải thích lý do Wakeme); phần còn lại nằm phẳng ngay dưới `Legacy/`. Đợt hoà nhánh
> 2026-08-28 chọn lối này thay cho `genmagic-v3.3/` để trùng với nhánh chính — không phải vì
> nó gọn hơn, mà vì mọi tham chiếu đang sống đều trỏ vào đây.

**Cái vẫn còn sống dù nghe như đã chết** (đừng dọn nhầm):
- `UMKeeper/` — module SỐNG, nằm ở gốc kho chứ không ở đây. UM vẫn nằm trong công thức
  thưởng của InstantGen PHA-2.
- `InstantGen/`, `Consolidate/`, `AppEconomics/`, `ProfileChange/` — cũng SỐNG ở gốc kho.
  Nhánh chính từng lưu kho một ảnh chụp của chúng; ảnh chụp đó đã bỏ khi hoà nhánh
  2026-08-28 vì bản ở gốc kho đi trước nó (riêng `InstantGen` là +1.328/−413 dòng).
- Hằng `snapshot_base_rate_q` — ScheduleGen dùng thật để tính `rate_locked_q`.
- Variant `Snapshot` / `Vacuum` trong enum `BatchSource`, và trường `vacuum_orders` trong
  `VaultDatum` — là **chỉ số constructor / arity của Plutus Data đã lên chain**. Bỏ đi là
  dịch chỉ số và vỡ decode mọi vault đã tạo. Giữ nguyên làm bia mộ.

---

*Thứ gì đó ở đây có vẻ vẫn đúng? Đối chiếu với `SPEC/` trước, đừng tin file trong Legacy.*
