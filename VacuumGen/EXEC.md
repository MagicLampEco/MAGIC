# VacuumGen — Execution Guide
## GenMAGIC v3.3 · Deploy + Test Plan

---

## 1. Deploy Steps (thứ tự bắt buộc)

### Bước 1: Chạy test offchain

```bash
cd /Users/ductiger/Projects/MAGIC/VacuumGen/offchain
npm install
npm test
```

Mong đợi: tất cả test pass. Pass checklist:
- TV-VAC-01: λ=10⁹, UM=1.5, SM=1.10 → 825M nanogic
- TV-VAC-CALIB: §20.3 calibration → 500M nanogic (0.5 MAGIC)
- TV-VAC-MAX: UM=2.0, streak≥12 → 1_200M nanogic
- TV-SM-TABLE: 4 streak tiers (bảng 8 entries)
- TV-UM-SPLIT-VACUUM: stale UM → vẫn smoothed (C-UM-7)
- TV-LOCK-01: youngest-first lock, 3 holdings, lambda=2500
- TV-VAC-FULL: vault full → M=0, LAMP transfer vẫn xảy ra (INV-43)
- TV-VAC-EPOCH: exact epoch match cases (reject early, accept exact, reject late)
- TV-VAC-PERM: permissionless fire
- TV-VAC-NO-CANCEL: không có cancel redeemer
- TV-VAC-CONS: LAMP transfer cả khi M=0
- TV-VAC-BOUNDS: lambda < 1 LAMP reject, orders = 10 reject

### Bước 2: Build Aiken validator

```bash
cd /Users/ductiger/Projects/MAGIC/VacuumGen/onchain
aiken build
```

Kết quả: `onchain/plutus.json` chứa compiled script.

```bash
aiken check
```

Kết quả: tất cả Aiken unit tests pass (WithdrawLamp tests trong vault.ak).

### Bước 3: Set env vars

Sau khi LAMP, UM NFT đã được deploy (từ `scripts/deploy/`):

```bash
# scripts/.env
BLOCKFROST_KEY=preview...
PRIVATE_KEY=ed25519_sk...
NETWORK=Preview
LAMP_POLICY_ID=<từ deploy:lamp>
UM_NFT_POLICY_ID=<từ deploy:um>
TREASURY_ADDRESS=<địa chỉ script treasury>
```

Cập nhật `TESTNET_CONFIG` trong `VacuumGen/offchain/src/constants.ts`:

```typescript
export const TESTNET_CONFIG = {
  network:          "Preview",
  blockfrostUrl:    "https://cardano-preview.blockfrost.io/api/v0",
  vaultScriptHash:  "<hash từ plutus.json>",
  lampPolicyId:     "<LAMP_POLICY_ID>",
  lampAssetName:    "744c414d50",   // "tLAMP"
  umNftPolicyId:    "<UM_NFT_POLICY_ID>",
  umNftAssetName:   "554d44",
  treasuryAddress:  "<TREASURY_ADDRESS>",
};
```

### Bước 4: Deploy vault

```bash
cd /Users/ductiger/Projects/MAGIC/scripts
npm install
npm run deploy:vault
```

### Bước 5: Chạy e2e

```bash
npm run test:e2e
```

Cần UMKeeper đang chạy trong terminal riêng:

```bash
cd /Users/ductiger/Projects/MAGIC/UMKeeper/offchain
npx tsx src/keeper.ts
```

---

## 2. Thứ tự deploy dependencies

```
deploy:lamp       → LAMP_POLICY_ID
  └─ deploy:um    → UM_NFT_POLICY_ID
       └─ deploy:vault (cần cả LAMP + UM + TREASURY_ADDRESS)
            └─ test:e2e
```

VacuumGen phụ thuộc: LAMP policy, UM NFT policy, Treasury script address. Không cần SHARD NFT (chỉ ScheduleGen cần).

### 2.1 Tham số validator (5 params — `scripts/deploy/06_create_vacuum_vault.ts`)

```
vault(lamp_policy_id, treasury_addr, um_nft_policy, um_script_hash, ms_per_epoch)
```

| Param | Nguồn | Ghi chú |
|---|---|---|
| `lamp_policy_id` | step 01 | Policy LAMP |
| `treasury_addr` | env `TREASURY_ADDRESS` | PHẢI Script-cred |
| `um_nft_policy` | step 02 | Policy UM NFT |
| `um_script_hash` | step 02 (`um_datum` hash) | Ghim UM ref input về `Script(um_script_hash)` (MAINNET-BLOCK phòng vệ b) |
| `ms_per_epoch` | `PROTOCOL.MS_PER_EPOCH` | 432_000_000 mainnet / 86_400_000 preview |

`um_script_hash` lấy từ bước 02 (UM_DATUM_HASH). Thiếu nó → deploy script `throw`.

### 2.2 Cross-module runbook — ConsumeMAGIC coupling (BẮT BUỘC trước mainnet)

BurnBatch (datum-consume) chỉ đảm bảo phép trừ đúng trong vault. Coupling giá
(`Σ burns == required` theo PriceParam beacon) do validator **ConsumeMAGIC**
co-spend cưỡng chế — bất biến CROSS-MODULE, không nằm trong vault.ak.

- Vault CHỈ được khởi tạo cùng hệ với engagement validator ConsumeMAGIC; mọi
  BurnBatch coupling-giá BẮT BUỘC co-spend PriceParam beacon. Thiếu ràng buộc
  này, accounting "delegate-consume-right" bị bỏ qua (owner/delegate hạ MAGIC
  tuỳ ý — vô hại kinh tế vì chỉ tự huỷ, NHƯNG bỏ qua giá engagement).
- TRƯỚC MAINNET cần test integration cross-module (Vacuum vault ↔ ConsumeMAGIC)
  — hiện CHƯA có trong module này (ghi nợ).

---

## 3. Test Plan

### 3.1 Positive Tests (≥3)

| ID | Scenario | Input | Expected |
|---|---|---|---|
| P-VAC-01 | Commit thành công, fire đúng epoch | lambda=1000 LAMP, streak=0, UM=1.0 | Batch tạo, M=500M, LAMP → treasury |
| P-VAC-02 | Fire permissionless bởi keeper | Owner commit, Keeper fire (khác wallet) | Accept — không yêu cầu owner sig |
| P-VAC-03 | Fire với vault gần đầy (31 batch) | 31 active batches, prune=0 | Batch thứ 32 tạo, M > 0 |
| P-VAC-04 | Fire sau khi prune đưa vault về < 32 | 32 batch cũ (expired), 0 active | Prune 32, tạo batch mới, M > 0 |
| P-VAC-05 | Streak cao SM=1.20 | streak=15, UM=1.5, lambda=1000 LAMP | M = 1000 × 0.5 × 1.5 × 1.2 = 900M nanogic |
| P-VAC-06 | Withdraw LAMP chưa locked | balance=2000, locked=1000, withdraw=500 | L_avail=1000, accept |
| P-VAC-07 | Multiple orders trong cùng vault | 3 orders khác nhau | Mỗi order fire độc lập |

### 3.2 Negative Tests (≥5)

| ID | Scenario | Expected |
|---|---|---|
| N-VAC-01 | Fire sớm hơn 1 epoch (`current < fire_epoch`) | Reject C-VAC-6 |
| N-VAC-02 | Fire muộn hơn 1 epoch (`current > fire_epoch`) | Reject C-VAC-6 |
| N-VAC-03 | Commit lambda < 1 LAMP (999_999 oil) | Reject C-VAC-3 |
| N-VAC-04 | Commit lambda > L_avail | Reject C-VAC-2 |
| N-VAC-05 | Commit khi đã có 10 orders | Reject C-VAC-5 |
| N-VAC-06 | Commit không có chữ ký owner | Reject C-VAC-1 |
| N-VAC-07 | Fire vault full, không prune trước | M=0, LAMP transfer vẫn (INV-43) |
| N-VAC-08 | Withdraw LAMP đang locked | Reject W-3 (`amount > L_avail`) |
| N-VAC-09 | Withdraw không có chữ ký owner | Reject W-2 |
| N-VAC-10 | Withdraw amount = 0 | Reject W-1 |
| N-VAC-11 | Output datum tăng `last_updated_epoch` trong Withdraw | Reject W-5 |
| N-VAC-12 | Commit với 2 vault inputs (double-spend attempt) | Reject C-VAULT-DS-1 |
| N-VAC-13 | Fire với 2 vault outputs (phantom output) | Reject C-VAULT-OUT-1 |
| N-VAC-14 | Treasury không nhận đủ LAMP tại fire | Reject INV-43 |
| N-VAC-15 | UM_smoothed_q ngoài range [0.5, 2.0] | Reject validate_um_range |
| N-VAC-16 | BurnBatch không owner/delegate ký | Reject (AUTH) |
| N-VAC-17 | BurnBatch over-burn / batch_id sai / rỗng | Reject (`apply_burns` / no-op) |
| N-VAC-18 | BurnBatch siphon LAMP khỏi vault | Reject (value-leak guard) |
| N-VAC-19 | SetDelegate do delegate (không phải owner) ký | Reject (chỉ owner) |
| N-VAC-20 | Tx span nhiều epoch hoặc upper-bound mở (validity-range gaming) | Reject `get_current_epoch` |
| N-VAC-21 | UM ref input đúng NFT nhưng sai script address | Reject `find_um_datum` (ghim script) |

### 3.3 Aiken Unit Tests (đã có trong vault.ak)

Cover: `WithdrawLamp` (6), `BurnBatch` (14), `SetDelegate` (5), `get_current_epoch`
validity-range (4). Tổng 29 (27 pass + 2 `fail`-annotated). Chưa có Aiken unit test
on-chain trực tiếp cho `VacuumCommit`/`VacuumFire` (đường happy-path đó cover bằng
35 test offchain P8/value-leak) — gap đã biết (xem V-NEXT-5).

| Nhóm test | Redeemer | Bao phủ |
|---|---|---|
| `w_*` (6) | WithdrawLamp | partial/zero/over-avail/no-sig/phantom-output/advance-last-updated |
| `bb_*` (14) | BurnBatch | partial/full-prune/delegate-auth/multi/no-auth/delegate-not-set/over-burn/unknown-batch/value-leak/lamp-mutated/attribution/empty/phantom/ref-script |
| `sd_*` (5) | SetDelegate | set-some/clear/delegate-cannot-change/mismatch/tamper-field |
| `vr_*` (4) | `get_current_epoch` | single-epoch/tight-bounds (pass); span-2-epochs/unbounded-upper (`fail`) — chống validity-range gaming |

---

## 4. Known Limits

| Giới hạn | Giá trị | Nguồn |
|---|---|---|
| `MAX_VACUUM_ORDERS` | 10 orders / vault | `constants.ak:max_vacuum_orders` |
| `MAX_BATCHES_PER_VAULT` | 32 batches | `constants.ak:max_batches_per_vault` |
| `MAX_LOYALTY_HOLDINGS` | 64 holdings | `constants.ak:max_loyalty_holdings` |
| Datum size tối đa | ~12KB | §5.1 (tx limit 16KB) |
| Fire window | 1 epoch (EXACT) | C-VAC-6 — không có catch-up |
| Batch lifetime | 1 epoch (cliff) | `vacuum_decay_window = 1` |
| LAMP minimum | 1 LAMP (10⁶ oil) | C-VAC-3 |

**Lưu ý C-VAC-6**: VacuumGen KHÔNG có catch-up mechanism. Nếu keeper bỏ lỡ `fire_epoch`, order bị kẹt vĩnh viễn trong vault (LAMP bị khóa, không thể fire, không thể huỷ). Keeper phải đảm bảo monitor liên tục.

**Lưu ý vacuum_orders kẹt**: Không có cơ chế expire order — order tồn tại mãi trong datum nếu không được fire. Điều này chiếm slot trong `max_vacuum_orders = 10`. Đây là rủi ro đã biết nếu keeper ngừng hoạt động.

---

## 5. v-next (Cải tiến đã biết)

| ID | Mô tả | Mức độ |
|---|---|---|
| V-NEXT-1 | Thêm `expire_epoch` cho VacuumOrder — cho phép prune order bị bỏ lỡ | Significant |
| V-NEXT-2 | Catch-up mechanism cho fire (≥ fire_epoch thay vì exact) — phức tạp hơn do LAMP đã locked | Constitutional |
| V-NEXT-3 | Keeper SDK tự động scan và fire tất cả orders đến hạn | Routine |
| V-NEXT-4 | Tăng `MAX_VACUUM_ORDERS` nếu datum size còn cho phép | Routine |
| V-NEXT-5 | Thêm Aiken unit test cho VacuumCommit và VacuumFire on-chain (hiện chỉ có 6 test WithdrawLamp) | Routine |

---

## 6. Monitoring Events

SDK phát ra các event string trong `summary` field của `CommitResult` và `FireResult`:

| Event | Điều kiện |
|---|---|
| `VacuumGen Commit` | Commit thành công |
| `VacuumGen Fire` | Fire thành công, batch tạo |
| `VacuumFiredZeroMagic` | Fire thành công, vault full, M=0 |
| `VacuumBurnBatch` | BurnBatch thành công — log `vaultRef`, `burns`, `totalBurned`, `actor` (owner/delegate) |
| `VacuumSetDelegate` | SetDelegate thành công — log `vaultRef`, `oldDelegate`, `newDelegate` |

Keeper nên log `orderId`, `fireEpoch`, `lambdaOil` sau mỗi commit để không bỏ lỡ fire window.

**Giám sát UM keeper (phòng vệ kinh tế)**: VacuumFire đọc UM smoothed không stale
check (C-UM-7). Nếu UM beacon bị giữ ở max (2.0×) do keeper thông đồng, mọi fire ăn
UM=2.0×. Range-clamp `[0.5, 2.0]` (validate_um_range) chặn outlier, nhưng vẫn nên
giám sát chuỗi `smoothed_q` theo epoch + cảnh báo khi giữ trần liên tục. Smoothing
window là phòng vệ kinh tế chính.

---

## 7. Script Hash Verification

Sau khi `aiken build`, verify hash khớp với `TESTNET_CONFIG.vaultScriptHash`:

```bash
# Lấy hash từ plutus.json
cat onchain/plutus.json | jq -r '.validators[0].hash'
```

Hash thay đổi khi thay đổi bất kỳ tham số validator hoặc logic. Sau mỗi thay đổi onchain, phải deploy lại và cập nhật config.
