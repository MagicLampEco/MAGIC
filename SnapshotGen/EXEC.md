# SnapshotGen EXEC — Deploy & Test Plan
## GenMAGIC v3.3 · §8 SnapshotGen

---

## 1. Deploy steps (Preview Testnet)

### Bước 1 — Build Aiken validators

```bash
cd /Users/ductiger/Projects/MAGIC/SnapshotGen/onchain
aiken build
```

Sản phẩm: `onchain/plutus.json`. Hash validator (`vault`) được đọc từ file này bởi deploy scripts.

### Bước 2 — Cài dependencies offchain

```bash
cd /Users/ductiger/Projects/MAGIC/SnapshotGen/offchain
npm install
```

### Bước 3 — Chạy test (bắt buộc pass trước khi deploy)

```bash
cd /Users/ductiger/Projects/MAGIC/SnapshotGen/offchain
npm test
```

Xem §2 — Test plan bên dưới để biết danh sách test bắt buộc pass.

### Bước 4 — Deploy LAMP policy (nếu chưa có)

```bash
cd /Users/ductiger/Projects/MAGIC/scripts
npm install
npm run deploy:lamp
```

Ghi `LAMP_POLICY_ID` vào `scripts/.env`.

### Bước 5 — Deploy vault

```bash
cd /Users/ductiger/Projects/MAGIC/scripts
npm run deploy:vault
```

**Env vars cần có trước bước này:**

| Var | Giá trị |
|---|---|
| `BLOCKFROST_KEY` | API key Preview |
| `PRIVATE_KEY` | Private key ví deploy |
| `NETWORK` | `Preview` |
| `LAMP_POLICY_ID` | Từ bước 4 |

**Env vars được ghi sau bước này:**

| Var | Ghi chú |
|---|---|
| `VAULT_SCRIPT_HASH` | Hash của vault validator |
| `VAULT_ADDRESS` | Bech32 address trên Preview |

### Bước 6 — Cập nhật constants.ts

Sau deploy, cập nhật `SnapshotGen/offchain/src/constants.ts`:

```typescript
export const TESTNET_CONFIG = {
  network:          "Preview",
  blockfrostUrl:    "https://cardano-preview.blockfrost.io/api/v0",
  vaultScriptHash:  "<VAULT_SCRIPT_HASH từ bước 5>",
  lampPolicyId:     "<LAMP_POLICY_ID từ bước 4>",
  lampAssetName:    "744c414d50",  // "tLAMP" — không đổi
  treasuryAddress:  "<REPLACE_WITH_TREASURY_ADDRESS>",
};
```

### Bước 7 — Test end-to-end

```bash
cd /Users/ductiger/Projects/MAGIC/scripts
npm run test:e2e
```

---

## 2. Test plan

### 2.1 Test bắt buộc (chạy qua `npm test`)

Các test này phải pass trước khi deploy. Tất cả ở `SnapshotGen/tests/` + `SnapshotGen/offchain/`.

| ID | Mô tả | File |
|---|---|---|
| TV-SS-01 | Lantern decay k=0..9 (10 steps, hard cutoff k=9) | math.test.ts |
| TV-SS-02 | Flame decay k=0..6 (cutoff k=6) | math.test.ts |
| TV-SS-03 | Ember decay k=0..3 (cutoff k=3) | math.test.ts |
| TV-SS-04 | Scale-back burn Lantern k=3 m₀=10⁹ burn=200M → diff=0 (T17) | math.test.ts |
| TV-LF-01 | LF(age=0) = 1.00 | math.test.ts |
| TV-LF-02 | LF(age=24) = 1.50 (cap) | math.test.ts |
| TV-LF-03 | Weighted LF 2 holdings → 1.30 | math.test.ts |
| TV-SNAPGEN-01 | 1000 LAMP Flame LF=1.0 OAC=0.8 → 4_620_000_000 nanogic | math.test.ts |
| TV-SNAPGEN-MATURE | 1000 LAMP Ember LF=1.5 OAC=1.0 → 11_212_500_000 nanogic | math.test.ts |
| TV-CATCHUP-01 | Δe=5 → 28_586_250_000 nanogic | math.test.ts |
| TV-SAMENESS-01 | profile_at_creation immutable (T4): Flame batch vẫn N=6 sau đổi sang Ember | math.test.ts |
| TV-OAC-BOUNDARY | burn tại epoch 103, current=103 → KHÔNG tính OAC (window half-open) | math.test.ts |
| TV-CONS-SNAPSHOT | lamp_balance không đổi trước/sau snapshot (T16) | snapshot.test.ts |
| TV-SS-SKIP | Vault 32 batches → batch không tạo, epoch vẫn cập nhật (C-SS-8) | snapshot.test.ts |

### 2.2 Positive tests — hành vi đúng

| # | Kịch bản | Kết quả mong đợi |
|---|---|---|
| P-01 | TriggerSnapshot Δe=1, vault trống | 1 batch mới, next_batch_index += 1, last_updated_epoch = current |
| P-02 | TriggerSnapshot Δe=5 (catch-up) | 1 batch với m_total = 5 × m_one |
| P-03 | UpdateProfile Flame→Ember với cooldown đủ (≥2 epoch) | pending_profile set, profile giữ nguyên Flame |
| P-04 | TriggerSnapshot sau khi pending fire | profile chuyển Ember, batch tính theo Ember, pending_profile = None |
| P-05 | WithdrawLamp một phần | lamp_balance giảm, holdings pruned LIFO, last_updated_epoch không đổi |

### 2.3 Negative tests — validator phải reject

| # | Kịch bản | Vi phạm | Validator action |
|---|---|---|---|
| N-01 | TriggerSnapshot không có chữ ký owner | Owner sig | fail |
| N-02 | TriggerSnapshot cùng epoch (không tiến) | C-SS-1: `current_epoch > last_updated_epoch` | fail |
| N-03 | Output datum giữ nguyên lamp_balance nhưng thay đổi magic_batches sai | A02 | fail |
| N-04 | Output có 2 vault UTxO (phantom second output) | C-VAULT-OUT-1 | fail |
| N-05 | WithdrawLamp amount > L_avail (LAMP bị locked) | W-3 | fail |
| N-06 | WithdrawLamp với amount = 0 | W-1 | fail |
| N-07 | BurnBatch (bất kỳ input) | Locked v1.0 | fail "BurnBatch locked until v1.1" |
| N-08 | UpdateProfile khi cooldown chưa đủ (delta < 2) | C-PC-V2 | fail |
| N-09 | UpdateProfile với new_profile == profile hiện tại | C-PC-V3 | fail |
| N-10 | UpdateProfile nhưng output set profile trực tiếp (bypass lazy) | C-PC-V6 | fail |
| N-11 | WithdrawLamp với output advance last_updated_epoch | Preserve constraint | fail |
| N-12 | TriggerSnapshot khi validity_range lower bound không có Finite slot | get_finite_slot → None | fail |
| N-13 | 2 vault inputs trong cùng tx | C-VAULT-DS-1 | fail |

### 2.4 Aiken tests (co-located trong vault.ak)

Các test inline tại `vault.ak:389-553`:

| Test | Redeemer | Expected |
|---|---|---|
| `w_positive_partial` | WithdrawLamp amount=5 | pass |
| `w_amount_zero` | WithdrawLamp amount=0 | fail (W-1) |
| `w_over_avail` | WithdrawLamp vượt L_avail | fail (W-3) |
| `w_no_owner_sig` | WithdrawLamp không ký | fail (owner sig) |
| `w_phantom_second_output` | 2 vault outputs | fail (C-VAULT-OUT-1) |
| `w_advance_last_updated_rejected` | Output advance last_updated | fail (preserve) |
| `up_positive` | UpdateProfile Flame→Ember | pass |
| `up_cooldown_not_met` | cooldown delta=1 < 2 | fail (C-PC-V2) |
| `up_bypass_lazy` | Output set profile trực tiếp | fail (C-PC-V6) |
| `up_same_profile` | new == current | fail (C-PC-V3) |

Chạy: `cd SnapshotGen/onchain && aiken check`.

**Test gap — TriggerSnapshot chưa có Aiken inline test (v1.0):**

`validate_snapshot` (vault.ak:100-211) hiện **không có test block nào** trong vault.ak. Các ràng buộc sau chỉ được kiểm tra qua TypeScript (`snapshot.test.ts`, `math.test.ts`) nhưng chưa có test Aiken tương đương:

| Constraint chưa có test Aiken | Invariant | Ghi chú |
|---|---|---|
| C-SS-1: new epoch gate | `current_epoch > last_updated_epoch` | Cần `ss_same_epoch() fail` |
| Owner sig | `list.has(extra_signatories, owner)` | Cần `ss_no_owner_sig() fail` |
| Double-satisfaction guard | `vault_input_count == 1` | Cần `ss_two_vault_inputs() fail` |
| Batch creation + next_batch_index | A02 + batch_added=True | Cần `ss_positive()` |
| C-SS-8 SKIP | vault full → epoch updates, no batch | Cần `ss_skip_vault_full() pass` |
| Catch-up Δe > 1 | `m_total = delta_e × m_one` | Cần `ss_catchup_delta_e()` |

Việc bổ sung các test này được đưa vào backlog v1.1. Hiện tại coverage TriggerSnapshot chỉ ở tầng TypeScript (TV-CONS-SNAPSHOT, TV-SS-SKIP trong `snapshot.test.ts`).

---

## 3. Môi trường và env vars

### 3.1 scripts/.env template

```
BLOCKFROST_KEY=preview...
PRIVATE_KEY=58...
NETWORK=Preview

# Điền sau deploy:
LAMP_POLICY_ID=
UM_NFT_POLICY_ID=
VAULT_SCRIPT_HASH=
VAULT_ADDRESS=
```

### 3.2 ms_per_epoch per network

| Network | Giá trị |
|---|---|
| Mainnet | 432_000_000 |
| Preview | 86_400_000 |
| Preprod | 86_400_000 |

Validator nhận giá trị này như tham số deploy — phải khớp với `ProtocolUtils.MS_PER_EPOCH_BY_NETWORK` trong offchain SDK.

---

## 4. Known limits và warnings

### 4.1 C-SS-8 — Vault full warning

Nếu `|magic_batches| >= 28` (cảnh báo sớm), wallet nên thông báo user cần burn MAGIC để giải phóng slot. Nếu `|magic_batches| = 32` khi snapshot trigger → generation mất vĩnh viễn, không thể backfill.

Nguồn: `README.md:103-104`.

### 4.2 Catch-up dùng current state

Catch-up tính M với LF, OAC của **epoch hiện tại**, không phải epoch cũ. Nếu user ngưng burn apps trong thời gian catch-up → OAC giảm → M thấp hơn so với tính theo từng epoch. Ngược lại, LF tăng theo tuổi holding thường bù đắp. Đây là thiết kế chủ ý (không lưu lịch sử trạng thái).

Nguồn: `snapshot.ak:78-80`.

### 4.3 BurnBatch locked

Không thể claim MAGIC ở v1.0. User có thể trigger snapshot, tích lũy MAGIC trong batches, nhưng không thể tiêu cho đến v1.1 (ConsumeMAGIC).

### 4.4 T16 — Không cần UM UTxO

SnapshotGen transactions không cần UM reference input. Không cần UMKeeper chạy để SnapshotGen hoạt động. Đây là điểm khác biệt với InstantGen.

### 4.5 Profile change cooldown

Sau khi gọi `UpdateProfile`, phải chờ thêm 2 epoch trước khi có thể đổi profile lần nữa. Pending profile sẽ áp dụng ở tx tiếp theo chạm vault (`current_epoch >= effective_epoch`).

---

## 5. v-next (v1.1+)

| Feature | Mô tả | Spec ref |
|---|---|---|
| ConsumeMAGIC / BurnBatch | Unlock BurnBatch redeemer với full A02 + apply_pending_profile | SPEC_V1 §2 |
| Keeper-triggered snapshot | Cho phép permissionless keeper trigger thay vì chỉ owner | vault.ak comment:112 |
| Streak bonus | `streak_state` đã có trong datum nhưng chưa dùng trong formula | §15.2 |
| Governance voting power | LAMP cam kết + MAGIC tiêu thụ tham gia tính VP | LAMP/Governance/VotingPower/CONTRACT.md |
| Cross-module consolidation | Consolidate fragmented loyalty holdings | §6.9 |
