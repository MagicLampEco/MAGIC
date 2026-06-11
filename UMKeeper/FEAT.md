# UMKeeper — Feature Specification
## GenMAGIC v3.3 · §14 Network Demand Multiplier

---

## 1. Mục đích

UMKeeper duy trì giá trị **UM (Network Demand Multiplier)** — tham số Constitutional phản ánh tỷ lệ cung/cầu MAGIC toàn mạng. UM được lưu trong một UTxO riêng biệt (UM datum UTxO), cập nhật mỗi epoch bởi keeper được uỷ quyền (M-of-N whitelist).

**Vai trò của UM trong hệ sinh thái:**
- InstantGen (§9) nhân UM vào công thức tính MAGIC output: `M = L × BASE × UM × PM / Q³`
- Nếu UM stale > 1 epoch → InstantGen fallback về `UM_FALLBACK_Q = 0.5×` (C-UM-6) — tức là user nhận rate tệ nhất. Keeper có incentive tự nhiên để update đúng giờ.
- SnapshotGen (§8) và VacuumGen (§10) KHÔNG dùng UM (T16 — đây là sự khác biệt có chủ ý).

**Giá trị UM dao động từ 0.5× đến 2.0×** (Constitutional limits, không thể vượt on-chain). Giá trị trung lập là 1.0× (burns = mints).

---

## 2. Actors

| Actor | Vai trò |
|---|---|
| **Keeper** | Tác nhân được whitelist (M-of-N), submit UMUpdate tx mỗi epoch. Thường là bot chạy tự động (`keeper.ts`). Không cần phép đặc biệt ngoài chữ ký. |
| **Protocol Deployer** | Khởi tạo UM datum UTxO với `smoothed_q = Q = 1.0×`, `history = []`, `last_updated_epoch = genesisEpoch`. Bake `keepers` và `threshold` vào tham số validator. |
| **InstantGen user** | Đọc UM datum (reference input hoặc UTxO lookup) trước khi submit Instant purchase — để biết rate hiện tại. Không interact trực tiếp với UMKeeper validator. |
| **IndexerOperator** | Cung cấp `getEpochStats()` (burns/mints epoch trước) cho keeper. Testnet v1: stub neutral. Production: query từ `MagicSupplyShard` UTxOs hoặc Blockfrost tx history. |

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
     - extra_signatories: ≥ threshold keepers ký
  10. Sign + Submit → txHash
  11. Emit onUpdate callback
```

### 3.2 Edge — Epoch bị bỏ qua (keeper offline > 1 epoch)

- UM datum stale: `last_updated_epoch` < `currentEpoch - 1`
- InstantGen đã fallback về 0.5× trong thời gian đó (C-UM-6)
- Keeper có thể update bù một lần duy nhất khi quay lại: validator chỉ yêu cầu `current_epoch > last_updated_epoch` (bất kỳ khoảng nhảy bao nhiêu). Lịch sử SMA ghi nhận 1 điểm raw (không điền giả cho epoch bị bỏ).
- Hệ quả kinh tế: history bị thiếu → SMA ít điểm hơn → ít smooth hơn.

### 3.3 Edge — Keeper bị chiếm: chữ ký không đủ threshold

- Validator check `count_keeper_sigs(keepers, tx.extra_signatories) >= threshold`
- Transaction bị từ chối on-chain. UM datum không thay đổi.
- Keeper không trong whitelist (stranger) cũng bị từ chối (test `um_stranger_signer`).

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
| **C-UM-1** | `smoothed_q = clamp(SMA(history), UM_MIN_Q, UM_MAX_Q)` — SMA tính từ history sau khi append new_raw đã clamp | `um_datum.ak:112-116`, `math.ts:38-41` |
| **C-UM-2** | `len(history) ≤ 6` tại mọi thời điểm | `um_datum.ak:124`, `math.ts:23` |
| **C-UM-3** | `UM_MIN_Q ≤ smoothed_q ≤ UM_MAX_Q` (double clamp: raw + smoothed) | `um_datum.ak:116`, `constants.ts:24-25` |
| **C-UM-4** | `current_epoch > last_updated_epoch` tại mỗi update | `um_datum.ak:103` |
| **C-UM-5** | UM NFT luôn còn trong output, value không đổi | `um_datum.ak:98-100` |
| **C-UM-6** | Staleness = `currentEpoch - last_updated_epoch`; nếu > 1 → fallback 0.5× (chỉ InstantGen) | `math.ts (InstantGen):75-80`, `constants.ts:26` |
| **W-AUTH** | Chỉ keeper trong whitelist mới ký được, cần ≥ threshold chữ ký | `um_datum.ak:82-83` |
| **W-SINGLE** | Đúng 1 input và 1 output tại script hash (đếm theo payment credential) | `um_datum.ak:88-89` |

---

## 5. Out-of-scope

- UMKeeper KHÔNG tính MAGIC, KHÔNG tương tác vault, KHÔNG đụng LAMP token.
- UM datum KHÔNG phải vault — không có `magic_batches`, không có loyalty holdings.
- Keeper KHÔNG được permissionless theo thiết kế hiện tại (audit fix Bug 3). Đây là lựa chọn có chủ ý để chống thao túng rate.
- `getEpochStats()` là stub trong testnet v1 — production cần indexer thực.
- Không hỗ trợ thêm/xoá keeper on-chain (cần redeploy validator nếu muốn đổi whitelist).
