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

| | GetMAGIC | InstantGen | SnapshotGen |
|---|---|---|---|
| Nguồn giá trị | **Fiat (VND) qua OTC** | LAMP on-chain | Không (tự sinh) |
| Trigger | User claim per-epoch | User mua | Tự động mỗi epoch |
| Cấp quyền | **Voucher Ed25519 (oracle)** | UM + PM | LF × OAC |
| Phát MAGIC | **Phase 2 (chưa nối)** | Ngay (batch) | Ngay (batch) |
| Lifecycle | Order → Settle → Allocation (drip) | 1 bước | 1 bước |
| Permission claim | **Beneficiary ký** (G-ALLOC-3) | Owner | Owner |

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
    └── getmagic.test.ts    # 41 vitest
```

\* `buildCreateOrderTx` **bắt buộc** truyền `params.orderScript` (order validator đã apply
`alloc_hash` lúc deploy). Không truyền → throw `GETMAGIC-ORDER-PHASE2` (chống đặt order vào
sai địa chỉ — xem KL-3).

---

## Chạy tests

```bash
cd GetMAGIC/offchain && npm install && npm test     # 41/41 pass
npm run typecheck                                    # 0 lỗi
cd ../onchain && aiken check                          # validators
```

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
