# GetMAGIC — Technical Specification
## MagicLamp Protocol · Aiken validators + Lucid SDK · Phase 1

---

## 1. On-chain types (`lib/getmagic/types.ak`)

> **P8:** constr index = thứ tự khai báo field, phải khớp byte-perfect với schema offchain
> (`offchain/src/types.ts`). Field mới ở CUỐI (append-only).

- **`OrderDatum`** — UTxO order chờ settle: `order_id, org_pkh, user_pkh, user_stake_cred,
  magic_per_epoch, total_epochs, fiat_amount_vnd, created_posix_ms, expiry_posix_ms, oracle_vkey`.
- **`AllocationDatum`** — UTxO theo dõi quyền claim: `alloc_id, order_id, org_pkh,
  org_vault_nft_policy, beneficiary_pkh, beneficiary_stake, magic_per_epoch, total_epochs,
  claimed_epochs, start_epoch, expiry_epoch, vouchers, oracle_vkey`.
- **`OrgDatum`** — registry Org (Phase-1 simplified, **chưa có validator** — xem KL-5).
- Redeemers: `OrderRedeemer = Settle | Expire | Cancel`;
  `AllocationRedeemer = ClaimEpoch | ReclaimExpired | Surrender`.

`alloc_id = blake2b_256("MAGIC_ALLOC_ID:v1" ++ 0x00 ++ u8(2) ++ LP(order_id) ++ LP(user_pkh))`
(xem §2.3 — nối thô hai trường độ-dài-thay-đổi không đơn ánh, nợ #26).

---

## 2. Validators

### 2.1 `otc_order(alloc_script_hash)` — spend OrderDatum
- **Settle**: verify oracle Ed25519 sig (`build_oracle_settle_msg`), timestamp tươi ±1h,
  chưa hết hạn, `len(epoch_vouchers) == total_epochs`, có output tại `Script(alloc_script_hash)`.
- **Expire**: `tx_lower >= expiry_posix_ms` → sweep ADA.
- **Cancel**: org ký.

### 2.2 `magic_allocation` — spend AllocationDatum
- **ClaimEpoch { epoch, um_ref }**: beneficiary ký; `epoch ∈ [start, expiry)`; chưa claim;
  voucher tại index `epoch - start_epoch` verify với `datum.oracle_vkey`; continuing output
  mang datum với `claimed_epochs += epoch` (sorted), field khác bất biến. `um_ref` reserved Phase-2.
- **ReclaimExpired**: org ký; `tx_lower > expiry_epoch * 86_400_000`.
- **Surrender**: beneficiary ký; tiêu UTxO, không cần continuing output.

### 2.3 Message formats (P8 — `utils.ak` ↔ `oracle.ts`)

Mọi trường độ-dài-thay-đổi được **đóng khung độ dài**, mọi thông điệp có **tiền tố miền**:
```
LP(s)       = u32be(len(s)) ++ s

alloc_id    = blake2b_256( "MAGIC_ALLOC_ID:v1" ++ 0x00 ++ u8(2)
                           ++ LP(order_id) ++ LP(user_pkh) )

settle_msg  = "MAGIC_ORACLE_SETTLE:v1" ++ 0x00 ++ u8(4)
              ++ LP(order_id) ++ LP(user_pkh) ++ LP(nonce)
              ++ u64be(timestamp)

voucher_msg = "MAGIC_VOUCHER:v1" ++ 0x00 ++ u8(4)
              ++ LP(alloc_id)
              ++ u64be(epoch) ++ u64be(nanogic) ++ u64be(expiry_posix)
```
Tiền tố miền là ASCII (không chứa byte `0x00`) nên `tag ++ 0x00` tách được không nhập nhằng,
và ảnh của ba khuôn rời nhau từng đôi.

`u8(n)` là **số trường** của chính khuôn đó, khai bằng hằng cạnh khuôn
(`fields_*` trong `utils.ak` ↔ `FIELDS_*` trong `oracle.ts`). Nó vá chỗ khuôn cũ còn hở:
đóng khung độ dài làm thông điệp đơn ánh **với cách tách**, nhưng không đơn ánh **với ngữ
nghĩa** — thêm một trường mà giữ nguyên `:v1` thì hai thông điệp khác nghĩa vẫn trùng byte
được qua các phiên bản, và thứ duy nhất chặn là người sửa nhớ tăng `:v1`. Đưa số trường vào
chính tiền ảnh thì thêm trường ⇒ hash đổi, kể cả khi quên tăng phiên bản.

Hai giới hạn, nói rõ để không ai nhận một nửa: (a) nó **không** bắt ca **đổi chỗ** hai trường
cùng độ dài — ca đó do vector vàng ở `tests/vectors.ts` bắt, và vector đã ghim thì **chỉ được
THÊM, không được SỬA**; (b) `:v1` vẫn giữ trong tiền tố — hai thứ bù nhau chứ không thay nhau.

**Vì sao (nợ #26):** nối thô các trường độ-dài-thay-đổi **không đơn ánh** — dời byte qua ranh
giới trường cho ra cùng một dãy byte, nên một chữ ký / một mã băm phủ nhiều bộ trường khác
nhau. Với `LP`, giải mã là hàm toàn phần (đọc 4 byte → đọc bấy nhiêu byte → lặp) ⟹ mã hoá đơn
ánh. Số nguyên cố định 8 byte tự phân định nên đứng CUỐI, không bọc.

Thêm trường độ-dài-thay-đổi mới thì **bắt buộc** bọc `LP`; thêm khuôn mới thì cấp tag mới.

`alloc_id` bị ép đúng 32 byte tại `build_voucher_msg`
(`expect bytearray.length(alloc_id) == 32`) — kiểu khai trong `types.ak` là `ByteArray` tự do.

Encoding Int = big-endian 8-byte (`bytearray.from_int_big_endian` ↔ `DataView.setBigUint64`);
tiền tố độ dài = big-endian 4-byte (`from_int_big_endian(_, 4)` ↔ `DataView.setUint32`).

---

## 3. eUTXO flow

```
OrderDatum @ otc_order ──[Settle: oracle sig + vouchers]──▶ AllocationDatum @ magic_allocation
                                                                   │
                          [ClaimEpoch: beneficiary sig + voucher]──┤── continuing output (claimed += epoch)
                          [ReclaimExpired: org, sau expiry]─────────┘
                          [Surrender: beneficiary]
```

---

## 4. §KNOWN-LIMITS — Phase-1 (BẮT BUỘC đóng trước khi nối asset)

> Phase 1 **không di chuyển MAGIC/asset** nên các lỗ dưới **chưa khai thác lấy tiền**. Nhưng
> chúng định hình mô hình bảo mật và **phải đóng trước khi `ClaimEpoch` phát MAGIC thật**.
> Các marker `KL-*` được tham chiếu trực tiếp trong header 2 validator.

| KL | Mức (khi nối asset) | Mô tả | Hướng vá |
|---|---|---|---|
| **KL-1** | 🔴 CRITICAL | `ClaimEpoch` continuing-output dùng `list.any` so field datum, **không** check output ở đúng **own script address**, **không** bảo toàn **value**, **không** ép **đúng 1** output → off-script / drain value / double-satisfaction. | Tính own address từ `self_ref`; ép đúng 1 continuing output tại địa chỉ đó; bind value conservation (theo pattern value-lock của vault.ak). |
| **KL-2** | 🔴 CRITICAL | **Trust-root vỡ.** `otc_order.Settle` chỉ check "có output tại alloc script", **không ràng nội dung/value** của `AllocationDatum`. `magic_allocation` verify voucher bằng `datum.oracle_vkey` — chính field của datum đó. ⇒ Settler tự đặt `oracle_vkey` của mình, tự ký mọi voucher, đặt `magic_per_epoch`/`beneficiary` tuỳ ý. Settle-sig chỉ phủ `order_id+user_pkh+nonce+timestamp`, **không** phủ tham số allocation. | **(a)** `oracle_vkey` → **validator parameter** (bake per-org lúc deploy), KHÔNG đọc từ datum; **và/hoặc (b)** settle-sig commit cả `AllocationDatum` (oracle_vkey + magic_per_epoch + total_epochs + beneficiary + start/expiry + hash(vouchers)), rồi `otc_order` verify datum tạo ra khớp commitment. |
| **KL-3** | 🟠 (đã guard) | `buildCreateOrderTx` từng đặt order vào `MAGIC_ALLOCATION_HASH` (địa chỉ **allocation**, không phải **order**) → khoá ADA ở sai script. | **Đã vá ở PR này**: yêu cầu `params.orderScript` (order validator đã apply `alloc_hash`); thiếu → throw `GETMAGIC-ORDER-PHASE2`. Deploy thật cung cấp script từ `08_deploy_getmagic.ts`. |
| **KL-4** | 🟡 MAINNET | Độ dài epoch hardcode `86_400_000` ms (Preview = 1 ngày) trong `expiry_posix` (voucher_msg) và `ReclaimExpired`. Mainnet khác → voucher verify sai + reclaim sai thời điểm. | Param hoá `ms_per_epoch` (cả on-chain lẫn công thức pre-sign của oracle). Cân nhắc đổi tên "epoch" nếu nghĩa là "ngày". |
| **KL-5** | 🟠 HIGH | Không có **Org-registry validator**. `OrgDatum`/`OrgRedeemer` có type nhưng không validator nào enforce → quota (`magic_quota`), collateral solvency, và **nonce-replay** (`released_nonces`, G-OTC-3) đều off-chain → org có thể over-issue vượt collateral. | Thêm Org-registry validator on-chain trước mainnet (ràng quota/reserve/nonce). |

**Phụ (LOW):** `Settle` không yêu cầu chữ ký user/org và không ràng ADA của order → settler
có thể tự lấy ADA của order; nên đổi `list.any(... alloc script)` thành "đúng 1".

---

## 5. Deploy dependencies

`otc_order` được parameterize bởi `alloc_script_hash` (hash của `magic_allocation` đã build).
Thứ tự deploy: build `magic_allocation` → lấy hash → apply vào `otc_order` → cả hai mới có
địa chỉ ổn định. Xem `scripts/deploy/08_deploy_getmagic.ts`. SDK build order tx **bắt buộc**
nhận order script đã apply này (`buildCreateOrderTx({ orderScript })`).

---

## 6. Test

`offchain`: 41 vitest (codec P8 + oracle sign/verify + builders). `onchain`: `aiken check`.
KNOWN-LIMITS ở trên hiện **chưa có test phủ** (vì chưa nối asset) — khi vá Phase-2 phải kèm
negative test: value-drain ClaimEpoch (KL-1), forged-AllocationDatum Settle (KL-2).
