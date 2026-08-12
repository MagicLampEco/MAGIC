# GetMAGIC — OTC fiat→MAGIC Allocation (Phase 1)
## MagicLamp Protocol · Kênh OTC trả VND nhận MAGIC drip theo epoch · Cardano Preview

---

## GetMAGIC là gì

GetMAGIC là kênh **OTC fiat→MAGIC**: user trả VND qua một Org đã đăng ký, oracle (VeData)
xác nhận thanh toán, rồi user nhận một **allocation** MAGIC được **drip theo từng epoch**
(mỗi epoch claim được `magic_per_epoch`, tổng `total_epochs`). Quyền claim mỗi epoch được
oracle cấp trước dưới dạng **voucher Ed25519 ký sẵn** tại thời điểm settle.

> **Trạng thái: Phase 1 — module ĐỘC LẬP, CHƯA nối generator vault.** Lớp này mới chỉ
> *theo dõi quyền claim per-epoch* trong datum; **không có MAGIC/asset nào di chuyển**.
> Việc phát MAGIC thật (qua BurnBatch của generator vault) là Phase 2. Xem
> [§KNOWN-LIMITS trong TECH.md](./TECH.md) — có các lỗ on-chain **bắt buộc đóng trước khi
> nối asset**.

---

## So sánh nhanh với các module GEN

| | GetMAGIC | InstantGen |
|---|---|---|
| Nguồn giá trị | **Fiat (VND) qua OTC** | Nắm LAMP trong vault — LAMP **đứng yên**, không có khoản chi (I-ACT-7) |
| Trigger | User claim per-epoch | Owner gọi InstantGen (**không phải "mua"**) |
| Cấp quyền | **Voucher Ed25519 (oracle)** | Cửa mở: `lamp_balance` và `L_avail ≥ min_instant_holding`. Độ lớn tính từ **MAGIC đã tiêu thụ thật** (`consumed_credit`, §6.3), rồi nhân UM × PM |
| Phát MAGIC | **Phase 2 (chưa nối)** | Ngay, thành batch sống **đúng 1 epoch** (cliff §4.2, không halving) |
| Lifecycle | Order → Settle → Allocation (drip) | 1 bước |
| Permission claim | **Beneficiary ký** (G-ALLOC-3) | Owner |

> Bản cũ của bảng này có thêm cột **SnapshotGen** đặt ngang hàng module sống, và mô tả
> InstantGen theo mô hình trước PHA 2 ("User mua", "UM + PM", "Ngay"). SnapshotGen **đã
> chết** — nằm ở `Legacy/genmagic-v3.3/`, không phải nguồn để so chiếu. InstantGen thì
> không còn là mua-MAGIC-bằng-LAMP: LAMP không rời vault, và độ lớn cấp phát bám vào MAGIC
> đã tiêu thụ chứ không bám khoản chi. Ai thiết kế GetMAGIC Phase 2 theo bảng cũ sẽ dựng
> luồng "trả tiền → chuyển LAMP → phát MAGIC" không tồn tại ở đâu trong hệ. Mô tả hiện
> hành: [`InstantGen/DESIGN-PHASE2.md`](../InstantGen/DESIGN-PHASE2.md); nguồn chân lý:
> [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](../SPEC/MagicLamp-Tripletoken-Feat-(Vi).md).

---

## Cấu trúc project

```
GetMAGIC/
├── onchain/
│   ├── lib/getmagic/
│   │   ├── types.ak        # OrderDatum, AllocationDatum, OrgDatum + redeemers
│   │   └── utils.ak        # build_*_msg (oracle), voucher/epoch helpers
│   └── validators/
│       ├── otc_order.ak        # Settle / Expire / Cancel (param: alloc_script_hash)
│       └── magic_allocation.ak # ClaimEpoch / ReclaimExpired / Surrender
├── offchain/src/
│   ├── oracle.ts           # Ed25519 sign + message builders (khớp utils.ak — P8)
│   ├── order.ts            # buildCreateOrderTx* / buildSettleOrderTx / buildExpireOrderTx
│   ├── allocation.ts       # build claim / reclaim / surrender tx
│   ├── widget.ts           # tiện ích UI/tx hỗ trợ
│   └── types.ts            # Data schemas (constr index khớp Aiken — P8)
└── tests/
    ├── vectors.ts          # test vectors
    └── getmagic.test.ts    # vitest suite
```

\* `buildCreateOrderTx` **bắt buộc** truyền `params.orderScript` (order validator đã apply
`alloc_hash` lúc deploy). Không truyền → throw `GETMAGIC-ORDER-PHASE2` (chống đặt order vào
sai địa chỉ — xem KL-3).

---

## Chạy tests

```bash
cd GetMAGIC/offchain && npm install && npm test
npm run typecheck
cd ../onchain && aiken check                          # validators
```

Số kiểm giữ ở một nơi duy nhất: [`DevStatus.md`](../DevStatus.md). Muốn số tươi thì chạy
đúng ba lệnh trên, đừng chép con số vào tài liệu.

---

## Vòng đời (Phase 1)

```
VeData match user↔Org
   │
   ▼  buildCreateOrderTx (cần orderScript đã apply)        ┌────────────┐
OrderDatum UTxO @ otc_order ───────────────────────────▶ │  Settle    │ (oracle sig)
   │                                                       │  Expire    │ (sau 4h)
   │                                                       │  Cancel    │ (org)
   ▼  buildSettleOrderTx (oracle sig + vouchers)           └────────────┘
AllocationDatum UTxO @ magic_allocation
   │
   ├─ ClaimEpoch  (beneficiary ký, voucher hợp lệ, epoch trong [start,expiry))  ── Phase 2: release MAGIC
   ├─ ReclaimExpired (org, sau expiry_epoch)
   └─ Surrender   (beneficiary, bỏ phần còn lại)
```

---

## Cảnh báo bảo mật (đọc trước khi nối Phase 2)

Các lỗ on-chain dưới đây là **known-limit Phase 1** — không khai thác được khi chưa có
asset, nhưng **phải vá trước khi ClaimEpoch phát MAGIC thật**:

- **KL-1** ClaimEpoch chưa ràng value / own-address / single-output (double-satisfaction).
- **KL-2** otc_order Settle không ràng nội dung AllocationDatum; `oracle_vkey` đọc từ chính
  datum → settler tự đặt key, tự ký voucher. **Gốc rễ trust-root.**
- **KL-3** `buildCreateOrderTx` từng đặt order vào địa chỉ allocation (placeholder) — đã
  **guard throw**, yêu cầu `orderScript` đã apply.
- **KL-4** Độ dài epoch hardcode `86_400_000` ms (Preview) → mainnet vỡ.
- **KL-5** Org registry (quota/collateral/nonce-replay) hoàn toàn off-chain.

Chi tiết + hướng vá: [TECH.md §KNOWN-LIMITS](./TECH.md).
