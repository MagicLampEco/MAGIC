# Code Review — MagicLamp MAGIC Protocol (BẢN GHI LỊCH SỬ, ĐÃ ĐÓNG)

> **Đây là biên bản một đợt review ĐÃ XONG, không phải mô tả hệ hiện tại.** Nó ghi
> "lúc ấy hỏng gì, vá ra sao" — giá trị nằm ở LÝ DO, không ở đường dẫn.
>
> - Đường dẫn `SnapshotGen/...` và `VacuumGen/...` trong tệp này **đã chết**: hai module
>   nằm ở `Legacy/genmagic-v3.3/`. Đừng lần theo, đừng khôi phục.
> - Số test ở cuối tệp là ảnh chụp cũ. Số đang đúng: [`DEVSTATUS.md`](../DEVSTATUS.md).
> - Mô hình đang đúng: [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](../SPEC/MagicLamp-Tripletoken-Feat-(Vi).md).
>
> Không cập nhật tệp này theo code nữa. Review mới thì mở biên bản mới.

---

## Trạng thái

| Mức độ | Số vấn đề | Đã apply trong code |
|---|---|---|
| 🔴 Critical | 2 | ✅ Verified |
| 🟠 Moderate | 4 | ✅ Verified |
| 🟡 Minor | 3 | ✅ Verified |

> **Lịch sử:** Bản review trước đánh dấu các fix là ✅ nhưng thực tế **0/5 fix
> được integrate vào module code** — ProtocolUtils tồn tại nhưng không module nào
> import từ đó. Bản hiện tại đã sửa: tất cả 9 module có dependency
> `@magiclamp/protocol-utils` và thay thế phần duplicated bằng import. Toàn bộ
> 278/278 tests pass (10 module).

---

## 🔴 CRITICAL

### 1. OAC window boundary inconsistency — FIXED

**Vị trí:** [ConsumeMAGIC/offchain/src/math.ts:377](ConsumeMAGIC/offchain/src/math.ts), [SnapshotGen/offchain/src/math.ts:42](SnapshotGen/offchain/src/math.ts), [ProtocolUtils/src/index.ts:186](ProtocolUtils/src/index.ts)

**Vấn đề:** Hai filter có ngữ nghĩa khác nhau bị nhầm lẫn:
- Prune window (ConsumeMAGIC STEP 0e): `ep ≥ e − 12` — giữ entry cho epoch sau.
- OAC count (SnapshotGen §6.4): `ep ∈ [e − 12, e)` — chỉ đếm burns đã hoàn thành.

ConsumeMAGIC.`countActiveAppsInWindow` mang tên gợi ý OAC nhưng impl thiếu upper
bound → developer dùng nó cho OAC sẽ sai.

**Fix đã apply:**
- `ProtocolUtils.countActiveAppsInOacWindow(entries, e)` — canonical OAC count, exclusive upper bound.
- `ProtocolUtils.pruneActivityWindow(entries, e)` — canonical prune (no upper bound).
- ConsumeMAGIC.`countActiveAppsInWindow` đã thêm `&& ep < e` (khớp với tên).
- SnapshotGen.`countActiveApps` delegate sang `countActiveAppsInOacWindow`.
- Regression test: TV-ACT-003b — burn tại `ep == e` không được count cho OAC epoch e.

---

### 2. isqrt_10th dùng float initial guess — overflow risk — FIXED

**Vị trí:** [AppEconomics/offchain/src/math.ts:46](AppEconomics/offchain/src/math.ts), [ProtocolUtils/src/index.ts:231](ProtocolUtils/src/index.ts)

**Vấn đề:** `BigInt(Math.floor(Number(n) ** 0.1) + 2)` — với `n = V^7` (V ≈
S_LAMP_TOTAL = 36×10^15 → V^7 ≈ 10^110), `Number(n) = Infinity` → `Infinity **
0.1 = Infinity` → `BigInt(Infinity)` **crash RangeError**.

**Fix đã apply:** Pure BigInt initial guess qua bit-length:
```typescript
const bits = n.toString(2).length;
let x = 1n << BigInt(Math.ceil((bits - 1) / 10) + 1);
```
AppEconomics chuyển sang `export const isqrt10th = isqrt10thShared`
(re-export từ ProtocolUtils). Regression test: `vDampened(36_000_000_000_000_000n)` không throw.

---

## 🟠 MODERATE

### 3. Code trùng lặp 7× — FIXED

**Trước:**

| Function | Copies |
|---|---|
| `nanogicToMagicStr` | 10 |
| `slotToEpoch` | 5 |
| `selectLampForLock` | 4 |
| `removeLockedAmount` | 4 |
| `isqrt` / `isqrt10th` | 2 |

**Sau:** Single source of truth tại `ProtocolUtils/src/index.ts`. Mỗi module
trong 9 module SDK có dependency `"@magiclamp/protocol-utils": "file:../../ProtocolUtils"`
và replace local impls bằng import + re-export (để giữ public API).

| Module | Imports từ ProtocolUtils |
|---|---|
| InstantGen | slotToEpoch, nanogicToMagicStr, qToStr, lampToOildrop, oildropToLamp, getTipSlot, cmpBigIntAsc |
| SnapshotGen | slotToEpoch, lampToOildrop, nanogicToMagicStr, qToStr, countActiveAppsInOacWindow, getTipSlot |
| VacuumGen | slotToEpoch, lampToOildrop, lAvail, nanogicToMagicStr, qToStr, selectLampForLock, removeLockedAmount, getTipSlot |
| ScheduleGen | (same as VacuumGen) + getTipSlot |
| UMKeeper | SLOTS_PER_EPOCH, slotToEpoch (cũng đã hợp nhất 2 bản UM math khác nhau trong keeper.ts vs math.ts) |
| Consolidate | LoyaltyHolding, cmpBigIntAsc |
| ProfileChange | SLOTS_PER_EPOCH, slotToEpoch |
| ConsumeMAGIC | nanogicToMagicStr |
| AppEconomics | isqrt, isqrt10th, vDampened, verifyVd, nanogicToMagicStr |

---

### 4. `getTipSlot` fallback hardcode genesis Preview — FIXED

**Vị trí:** [ProtocolUtils/src/index.ts:46](ProtocolUtils/src/index.ts) (canonical)

`1666656000` (Preview genesis) bị hardcode trong fallback của 4 module —
deploy lên Mainnet/Preprod sẽ tính lệch ~800 epoch.

**Fix đã apply:** ProtocolUtils export `getTipSlot(lucid, network)` và
`getCurrentEpoch(lucid, network)` với lookup table:
```typescript
GENESIS_UNIX = { Preview: 1666656000, Preprod: 1654041600, Mainnet: 1596491091 };
```
Các local `getTipSlot` trong vacuum.ts/instant.ts/schedule.ts/snapshot.ts đã
được xóa và replace bằng import. Default vẫn là Preview (giữ behavior cũ);
deploy Mainnet/Preprod cần pass `network` ở call site.

---

### 5. `Number()` trong sort comparators — FIXED

**Trước:** 6 chỗ dùng `.sort((a, b) => Number(b.acquired_epoch - a.acquired_epoch))`.

**Sau:** Tất cả đã chuyển sang `cmpBigIntAsc` / `cmpBigIntDesc` từ ProtocolUtils
(pure BigInt). Bao gồm:
- Consolidate (3 chỗ trực tiếp dùng `cmpBigIntAsc`).
- InstantGen.instant.ts (`cmpBigIntAsc` trong removal helper).
- VacuumGen.math.ts + ScheduleGen.math.ts — đã được thay thế bằng `selectLampForLock` / `removeLockedAmount` từ ProtocolUtils (chúng dùng `cmpBigIntDesc/Asc` nội bộ).

Tests cập nhật: VacuumGen test cũ expect `GEN-VAC-001` → nay expect canonical
`GEN-LOCK-001`.

---

### 6. `selectLampForLock` sort toàn bộ mỗi lần gọi — Acceptable, no change

Holdings ≤ 64 phần tử; O(n log n) ≈ 384 ops. Tối ưu insert-in-order sẽ tạo
inconsistency với Aiken validator. Giữ nguyên.

---

## 🟡 MINOR

### 7. `vitest.config.ts` thiếu trong tarballs gốc — FIXED (lần review trước)

Tất cả modules hiện có `vitest.config.ts`.

### 8. VaultDatumSchema hardcode trong deploy scripts — Open, defer to Aiken build

Sau `aiken build`, dùng `aiken blueprint generate-types` để generate
TypeScript types tự động thay vì hardcode. Chưa làm vì chưa có `plutus.json`
(Aiken build chưa chạy).

### 9. `getBlock("latest")` thay vì `validity_range` — Acceptable

Tx builder dùng đúng `validity_range`. `getBlock("latest")` chỉ để estimate epoch
cho summary string, không ảnh hưởng tx correctness.

---

## Housekeeping đã dọn

- Đã xóa 7 thư mục literal `{...}` (artifact của `mkdir` bị brace-expansion fail trên shell không hỗ trợ).
- Đã xóa nested duplicate `ProtocolUtils/ProtocolUtils/` (bản copy hoàn toàn giống outer, ngoại trừ thiếu `main`/`exports` trong package.json).
- Đã sửa `.gitignore` lặp `.DS_Store` 2 lần → 1 lần.
- Thêm `main` / `types` / `exports` map vào `ProtocolUtils/package.json` để vitest và TS resolver tìm được entry `src/index.ts`.

---

## Bug mới phát hiện và đã fix

**UMKeeper double-impl mismatch** — `UMKeeper/offchain/src/keeper.ts` định nghĩa
lại `appendHistory` clamp `newRaw` trước khi append, trong khi
`UMKeeper/offchain/src/math.ts` giữ raw values theo spec. Spec §14.1 C-UM-2 yêu
cầu raw values; tests chạy vào math.ts (đúng); keeper.ts khi build tx dùng impl
sai. Đã fix: keeper.ts import từ math.ts (single source).

---

## Test status

Bảng số của đợt review này đã gỡ: nó liệt kê cả `SnapshotGen` / `VacuumGen` (nay ở
`Legacy/`) và mọi con số đều hết hạn. Số đang đúng, kèm lệnh kiểm:
[`DEVSTATUS.md`](../DEVSTATUS.md).

Regression tests đợt đó thêm mới:
- `AppEconomics`: isqrt10th với V=S_LAMP_TOTAL (V^7 ≈ 10^110) không throw.
- `ConsumeMAGIC`: TV-ACT-003b — burn tại `ep == e` không count cho OAC epoch e.

---

## Action items còn lại

### Trước testnet
- [ ] Aiken build các validators → ghi `plutus.json` → cập nhật hash trong `scripts/config.ts`.
- [ ] Quyết định canonical version cho `UMKeeper/onchain/` vs `UMKeeper/onchain/onchain/` (2 bản nhau Aiken validator khác nhau — xem chú thích bên dưới).
- [ ] Tương tự cho `ScheduleGen/onchain/onchain/`.

### Trước Mainnet
- [ ] Pass `network` xuống các call site `getTipSlot(lucid, network)` thay vì để default Preview.
- [ ] Replace `aiken blueprint` generated schemas thay vì hardcoded VaultDatumSchema.
- [ ] Formal verification scope (Q8 in ConsumeMAGIC open questions).

### Lưu ý về `onchain/onchain/`

Trong `UMKeeper/onchain/` và `ScheduleGen/onchain/` có thư mục con `onchain/`
nữa với nội dung **không giống** bên ngoài:
- `aiken.toml` khác `name` ("magiclamp/protocol" vs "magiclamp/umkeeper") và format `[[dependencies]]` vs `[dependencies]`.
- Aiken validator code dùng syntax khác (full path types vs `use` imports).

Tôi không xóa vì không rõ bản nào là canonical. Dev cần xác nhận và chọn 1
trước khi `aiken build`.

---

## Bảo mật — Không có vấn đề mới

| Concern | Status |
|---|---|
| BigInt overflow | ✅ Dùng BigInt toàn bộ (isqrt10th regression test) |
| Division by zero | ✅ DRATE_PRIOR=10 luôn > 0 (T20) |
| Cycle trong re-allocation | ✅ topo_level O(K), formal proof T14.13 |
| OAC gaming | ✅ C-ACTIVITY-DEDUP enforced + upper bound exclusive |
| Timestamp manipulation | ✅ Validator dùng tx validity_range |
| isqrt_10th overflow | ✅ Pure BigInt + regression test |
| Cross-network deploy bug | ✅ Network-aware genesis lookup |

---

*Review completed — 278/278 tests pass (ProtocolUtils + 9 modules)*
