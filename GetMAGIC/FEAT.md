# GetMAGIC — Feature Specification
## MagicLamp Protocol · OTC fiat→MAGIC allocation (Phase 1)

---

## 1. Mục đích

GetMAGIC cho phép người dùng **mua quyền nhận MAGIC bằng tiền pháp định (VND)** thay vì
bằng LAMP on-chain. Mô hình:

1. Org (tổ chức đã đăng ký) nhận VND của user qua cổng thanh toán (AlePay/VeData).
2. Oracle (VeData) xác nhận đã nhận tiền → ký một **settle signature**.
3. Settle tạo một **AllocationDatum** ghi quyền claim MAGIC **drip theo epoch**
   (`magic_per_epoch` mỗi epoch, trong `total_epochs` epoch).
4. Mỗi epoch, beneficiary claim phần của mình bằng cách xuất một **voucher Ed25519** mà
   oracle đã ký sẵn cho đúng epoch đó tại thời điểm settle.

**Phase 1 chỉ theo dõi quyền claim** (accounting trong datum). Phát MAGIC thật (giảm
`current_amount` qua BurnBatch của generator vault) là **Phase 2**.

---

## 2. Actors

| Actor | Vai trò |
|---|---|
| **User / Beneficiary** | Trả VND; ký mọi `ClaimEpoch`; có thể `Surrender` phần còn lại (G-ALLOC-3) |
| **Org** | Tổ chức nhận VND; tạo order; `Cancel` trước khi oracle settle; `ReclaimExpired` sau hạn |
| **Oracle (VeData)** | Ký settle-sig (xác nhận thanh toán) + pre-sign vouchers per-epoch. Khóa Ed25519 |
| **VeData relayer** | Build tx `CreateOrder` / `Settle` |
| **Keeper / bất kỳ ai** | Có thể submit tx (nhưng `ClaimEpoch` cần chữ ký beneficiary) |

---

## 3. Happy-path flows

### 3.1 CreateOrder
1. VeData match user↔Org, chọn `magic_per_epoch`, `total_epochs`, `fiat_amount_vnd`.
2. Build `OrderDatum` UTxO (ký quỹ ADA tối thiểu) tại **địa chỉ order script** (order
   validator đã apply `alloc_hash`).
3. `expiry_posix_ms = created + 4h` (ORDER_EXPIRY_MS).

### 3.2 Settle (oracle xác nhận thanh toán)
1. Oracle ký `settle_msg` (Ed25519) — khuôn đóng-khung-độ-dài, xem `TECH.md §2.3`.
2. Oracle pre-sign `total_epochs` vouchers theo `voucher_msg` — cùng nguồn khuôn.
3. Redeemer `Settle { nonce, timestamp, signature, epoch_vouchers }` tiêu OrderDatum,
   tạo `AllocationDatum` tại `magic_allocation` script.
4. Validator kiểm: sig hợp lệ (G-OTC-1), timestamp tươi ±1h (G-OTC-2), chưa hết hạn (G-OTC-5),
   số voucher == `total_epochs`, có output tại alloc script (G-OTC-4).

### 3.3 ClaimEpoch (drip mỗi epoch)
1. Beneficiary ký; chọn `epoch ∈ [start_epoch, expiry_epoch)`.
2. Epoch chưa nằm trong `claimed_epochs` (G-ALLOC-2 monotonic).
3. Voucher tại index `epoch - start_epoch` verify với `oracle_vkey` (G-ALLOC-1/5).
4. Continuing output mang `AllocationDatum` với `claimed_epochs += epoch` (sorted), mọi
   field khác giữ nguyên.
5. *(Phase 2)* phát `magic_per_epoch` MAGIC cho beneficiary.

### 3.4 Kết thúc
- **ReclaimExpired**: org ký, `tx_lower > expiry_epoch * ms_per_epoch` → org thu UTxO.
- **Surrender**: beneficiary ký, bỏ toàn bộ epoch còn lại (UTxO bị tiêu, không continuing output).
- **Expire / Cancel** (order chưa settle): sweep ADA về caller / org.

---

## 4. Edge cases

| Trường hợp | Kết quả |
|---|---|
| Claim epoch ngoài `[start, expiry)` | Reject (epoch_in_range) |
| Claim lại epoch đã claim | Reject (G-ALLOC-2 `not_claimed`) |
| Voucher index ngoài range | `get_voucher_for_epoch` = None → reject |
| Không có chữ ký beneficiary | Reject (G-ALLOC-3) |
| Settle sau `expiry_posix_ms` | Reject (G-OTC-5 `not_expired`) |
| Settle voucher count ≠ `total_epochs` | Reject (`vouchers_ok`) |
| Settle timestamp lệch > 1h | Reject (G-OTC-2) |

---

## 5. Invariants

| ID | Phát biểu |
|---|---|
| G-OTC-1 | Oracle sig phủ `settle_msg` đơn ánh (tag miền + `LP` mỗi trường, `TECH.md §2.3`) |
| G-OTC-2 | Oracle timestamp tươi ±1h so với tx lower bound |
| G-OTC-3 | Nonce uniqueness — **off-chain** (xem KL-5) |
| G-OTC-4 | Settle tạo output tại `alloc_script_hash` (xem KL-2 cho giới hạn) |
| G-OTC-5 | Hết hạn 4h |
| G-ALLOC-1 | Voucher per-epoch là Ed25519 của oracle (pre-signed) |
| G-ALLOC-2 | `claimed_epochs` đơn điệu tăng, không xoá |
| G-ALLOC-3 | Chỉ beneficiary claim/surrender; chỉ org reclaim sau hạn |
| G-ALLOC-4 | Claimable = `total_epochs - len(claimed_epochs)` |
| G-ALLOC-5 | Voucher index `(epoch - start_epoch)` ủy quyền đúng epoch đó |

---

## 6. Out-of-scope (Phase 2 / known-limit)

- Phát MAGIC thật (BurnBatch generator vault) — chưa nối asset.
- Đóng các lỗ on-chain KL-1..KL-5 (xem [TECH.md §KNOWN-LIMITS](./TECH.md)) — **bắt buộc
  trước khi nối asset.**
- Org registry validator on-chain (quota/collateral/nonce).
- DID thật (hiện MVP = owner key).
