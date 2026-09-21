# UMKeeper — Feature Specification
## Hệ số cầu mạng UM

> Nguồn chân lý: [`Specs/MagicLamp-Tripletoken-Feat-(Vi).md`](../Specs/MagicLamp-Tripletoken-Feat-(Vi).md).
> Các số mục "§8/§9/§10/§14" trong tệp này là di sản đánh số GenMAGIC v3.3 — giữ lại để
> tra cứu lịch sử, KHÔNG phải mục lục của spec canonical. Trạng thái module:
> [`DevStatus.md`](../DevStatus.md).

---

## 1. Mục đích

UMKeeper duy trì giá trị **UM (Network Demand Multiplier)** — tham số Constitutional phản ánh tỷ lệ cung/cầu MAGIC toàn mạng. UM được lưu trong một UTxO riêng biệt (UM datum UTxO), cập nhật mỗi epoch theo cơ chế **permissionless** (khớp pattern VacuumFire/ScheduleFire): bất kỳ ai cũng có thể trigger update. Permissionless MỘT MÌNH KHÔNG an toàn — recompute SMA + double-clamp không đủ để chặn kẻ tấn công một mình (chi tiết + PoC ở §3.3). Thứ đang giữ an toàn LÚC NÀY là hàng rào bước `um_max_step_q` (HÀNG RÀO TẠM — xem §3.3, §4 mục `W-STEP`), không phải double-clamp.

**Vai trò của UM trong hệ sinh thái:**
- **InstantGen** nhân UM vào phần thưởng MAGIC. Công thức đọc ở hàm
  `compute_reward_from_consumed` (`InstantGen/onchain/lib/magiclamp/protocol/math.ak`) —
  ba phép `⌊ × / Q ⌋` TUẦN TỰ, KHÔNG phải một phép chia `Q³`. Đầu vào là `consumed`
  (LAMP đã tiêu), **không phải** số dư LAMP: sau DESIGN-2 LAMP đứng yên (I-ACT-7), không
  handler nào chuyển LAMP. Bản cũ của dòng này ghi `M = L × BASE × UM × PM / Q³` — sai
  cả đầu vào lẫn thứ tự làm tròn; đừng chép lại.
- Nếu UM stale > 1 epoch → InstantGen fallback về `UM_FALLBACK_Q = 0.5×` (C-UM-6) — tức là user nhận rate tệ nhất. Keeper có incentive tự nhiên để update đúng giờ.
- **ScheduleGen** khoá rate lúc commit nên không đọc UM ở lúc fire. UM chỉ có MỘT hộ tiêu
  thụ đang sống: InstantGen.
- SnapshotGen / VacuumGen từng được ghi ở đây là "cố ý không dùng UM (T16)". Hai module đó
  ĐÃ CHẾT — nằm ở `Legacy/genmagic-v3.3/`. Đừng suy ra ràng buộc thiết kế nào từ chúng.

**Giá trị UM dao động từ 0.5× đến 2.0×** (Constitutional limits, không thể vượt on-chain). Giá trị trung lập là 1.0× (burns = mints).

---

## 2. Actors

| Actor | Vai trò |
|---|---|
| **Keeper** | Tác nhân BẤT KỲ (permissionless), submit UMUpdate tx mỗi epoch. Thường là bot chạy tự động (`keeper.ts`) nhưng không có đặc quyền — user nào cũng trigger được. Không cần chữ ký whitelist. |
| **Protocol Deployer** | Khởi tạo UM datum UTxO với `smoothed_q = Q = 1.0×`, `history = []`, `last_updated_epoch = genesisEpoch`. Bake `ms_per_epoch`, `um_policy`, `um_name` vào tham số validator (KHÔNG còn keepers/threshold). |
| **InstantGen user** | Đọc UM datum (reference input hoặc UTxO lookup) trước khi submit Instant purchase — để biết rate hiện tại. Không interact trực tiếp với UMKeeper validator. Cũng có thể tự trigger UMUpdate (permissionless) nếu rate stale. |
| **IndexerOperator** | Cung cấp `getEpochStats()` (burns/mints epoch trước) cho người trigger. Testnet v1: stub neutral. Production: query từ `MagicSupplyShard` UTxOs hoặc Blockfrost tx history. |

---

## 3. Flows

### 3.1 Happy path — Update UM tại epoch boundary

```
Keeper bot (mỗi intervalMs = 60s):
  1. Fetch UM UTxO (by NFT unit `umUtxoUnit`)
  2. Parse UMDatum: smoothed_q, last_updated_epoch, history
  3. Fetch tip slot → tính currentEpoch = ⌊tipPosixMs / msPerEpoch⌋
  4. Kiểm tra: currentEpoch > last_updated_epoch? (C-UM-4)
     - Không → bỏ qua, đợi tick tiếp
     - Có → tiếp tục
  5. Gọi getEpochStats(epoch=currentEpoch) → (totalBurns, totalMints)
  6. Tính newRaw   = ⌊totalBurns × Q / max(totalMints, 1)⌋
  7. Tính newHistory = append_capped(history, clamp(newRaw), 6)
  8. Tính newSmoothed = clamp(SMA(newHistory), UM_MIN_Q, UM_MAX_Q)
  9. Build tx:
     - Input: UM UTxO (redeemer UMUpdate { new_raw: newRaw })
     - Output: UM UTxO cùng địa chỉ, value giữ nguyên, datum mới
     - Validity range: [currentEpoch × msPerEpoch, (currentEpoch+1) × msPerEpoch - 1]
     - extra_signatories: KHÔNG cần keeper ký (permissionless; wallet người trigger vẫn ký để chi phí collateral/fee qua balancer)
  10. Sign + Submit → txHash
  11. Emit onUpdate callback
```

### 3.2 Edge — Epoch bị bỏ qua (keeper offline > 1 epoch)

- UM datum stale: `last_updated_epoch` < `currentEpoch - 1`
- InstantGen đã fallback về 0.5× trong thời gian đó (C-UM-6)
- Keeper có thể update bù một lần duy nhất khi quay lại: validator chỉ yêu cầu `current_epoch > last_updated_epoch` (bất kỳ khoảng nhảy bao nhiêu). Lịch sử SMA ghi nhận 1 điểm raw (không điền giả cho epoch bị bỏ).
- Hệ quả kinh tế: history bị thiếu → SMA ít điểm hơn → ít smooth hơn.

### 3.3 Edge — Permissionless: rủi ro `new_raw` cấp off-chain

- Validator KHÔNG kiểm tra chữ ký — bất kỳ ai cũng submit được UMUpdate.
- Người trigger cấp `new_raw` (tính off-chain từ epoch stats) → validator KHÔNG verify được con số này tự thân (không có on-chain accumulator burns/mints trong v1).
- **Clamp + SMA MỘT MÌNH KHÔNG đủ.** PoC chạy thật, tái hiện bằng test `um_poc_jump_to_max_rejected` (`UMKeeper/onchain/validators/um_datum.ak`): trước khi có trần bước, 6 giao dịch liên tiếp — 0 chữ ký — ghim `smoothed_q` lên `um_max_q`, tức nhân đôi hệ số thưởng của mọi vault đang dùng InstantGen.
- **Hàng rào TẠM đang giữ an toàn:** hằng `um_max_step_q` (= 0.10) + hàm `step_within` (cả hai ở `um_datum.ak`) ép mỗi lượt cập nhật lệch tối đa 0.10 so với `smoothed_q` hiện tại; vượt trần thì validator TỪ CHỐI cả giao dịch (fail-closed). Rào này KHÔNG chặn được kẻ tấn công một mình — chỉ buộc họ tốn nhiều epoch hơn để tới cùng đích.
- **Đích chưa làm:** cổng M-trên-N (nhiều bên ký), khuôn có sẵn ở `price_param.ak` (`ConsumeMAGIC/onchain/validators`). Chừng nào chưa có cổng đó, đừng đọc hàng rào bước như đã giải xong bài toán permissionless.
- v-next: thêm on-chain epoch accumulator (MagicSupplyShard) để validator verify `new_raw` trực tiếp, VÀ cổng M-trên-N — hai việc độc lập, không thay thế nhau.

### 3.4 Edge — Attacker cố đè `smoothed_q` thủ công

- Validator tính lại `new_smoothed_clamped` từ `new_raw` và `history` hiện tại
- So sánh với `output_datum.smoothed_q` → nếu sai → reject (test `um_forged_smoothed`)
- Attacker có thể chọn `new_raw` trong [UM_MIN_Q, UM_MAX_Q] → tác động giới hạn, SMA làm mịn theo thời gian

### 3.5 Edge — Double-satisfaction qua stake credential

- 2 UTxO cùng payment credential (script hash) nhưng khác stake credential → cùng validator
- Validator đếm theo payment credential: `count_inputs_at_script(inputs, own_hash) == 1`
- Full-Address equality KHÔNG đủ — test `um_double_satisfaction_stake_cred` bắt lỗi này

### 3.6 Edge — UM NFT bị rút khỏi output (authority strip attack)

- Validator yêu cầu `assets.quantity_of(um_out.value, um_policy, um_name) == 1`
- Thêm: `um_out.value == um_in.value` (value preservation toàn bộ)
- Attacker không thể tách NFT sang UTxO khác để giả mạo UM authority sau đó

### 3.7 Edge — Update cùng epoch (same-epoch replay)

- `current_epoch > datum.last_updated_epoch` (strictly greater, C-UM-4)
- Nếu `current_epoch == last_updated_epoch` → reject (test `um_same_epoch`)
- Chống replay: mỗi epoch chỉ update 1 lần

### 3.8 Edge — Không có datum trong UTxO

- `expect Some(datum) = datum_opt` → script fail nếu datum None
- Deploy phải dùng InlineDatum, không NoDatum

---

## 4. Invariants

| ID | Phát biểu | Nguồn |
|---|---|---|
| **C-UM-1** | `smoothed_q = clamp(SMA(history), UM_MIN_Q, UM_MAX_Q)` — SMA tính từ history sau khi append `clamped_raw` (clamp-before-append, P8) | `um_datum.ak`, `math.ts:computeNewUM` |
| **C-UM-2** | `len(history) ≤ 6` tại mọi thời điểm | `um_datum.ak`, `math.ts:appendHistory` |
| **C-UM-3** | `UM_MIN_Q ≤ smoothed_q ≤ UM_MAX_Q` (double clamp: clamped_raw vào history + smoothed output) | `um_datum.ak`, `math.ts:clampUM` |
| **C-UM-4** | `current_epoch > last_updated_epoch` tại mỗi update | `um_datum.ak` |
| **C-UM-5** | UM NFT luôn còn trong output, value không đổi (`um_out.value == um_in.value`) | `um_datum.ak` |
| **C-UM-6** | Staleness = `currentEpoch - last_updated_epoch`; nếu > 1 → fallback 0.5× (chỉ InstantGen) | `math.ts (InstantGen)`, `constants.ts` |
| **W-PERM** | Permissionless — KHÔNG kiểm tra chữ ký. MỘT MÌNH KHÔNG an toàn; an toàn hiện tại tới từ `W-STEP` dưới đây, không phải từ SMA recompute + double-clamp | `um_datum.ak` |
| **W-SINGLE** | Đúng 1 input và 1 output tại script hash (đếm theo payment credential) | `um_datum.ak` |
| **W-STEP** | `\|clamped_raw − datum.smoothed_q\| ≤ um_max_step_q` (= 0.10) mỗi lượt. HÀNG RÀO TẠM, không phải bản vá gốc — đích là cổng M-trên-N (khuôn `ConsumeMAGIC/onchain/validators/price_param.ak:54-57`), CHƯA làm | `um_datum.ak` (hằng `um_max_step_q`, hàm `step_within`) |

---

## 5. Out-of-scope

- UMKeeper KHÔNG tính MAGIC, KHÔNG tương tác vault, KHÔNG đụng LAMP token.
- UM datum KHÔNG phải vault — không có `magic_batches`, không có loyalty holdings.
- Keeper được permissionless theo thiết kế (khớp VacuumFire/ScheduleFire). SMA + double-clamp KHÔNG đủ để an toàn một mình — an toàn hiện tại dựa vào hàng rào TẠM `um_max_step_q` (xem §3.3, §4 `W-STEP`); đích cuối (cổng M-trên-N) CHƯA làm.
- `getEpochStats()` là stub trong testnet v1 — production cần indexer thực.
- Không có whitelist keeper → không cần quản lý thêm/xoá keeper on-chain.
