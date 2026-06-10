# InstantGen — Execution Guide
## GenMAGIC v3.3 · Deploy + Test Plan · v1.0

---

## 1. Deploy steps (thứ tự bắt buộc)

### Bước 0: Chuẩn bị env

```bash
# File: scripts/.env
BLOCKFROST_KEY=preview...        # Blockfrost Preview testnet key
PRIVATE_KEY=ed25519_sk...        # Cardano signing key
NETWORK=Preview

# Sau mỗi bước deploy, điền vào:
LAMP_POLICY_ID=
UM_NFT_POLICY_ID=
VAULT_SCRIPT_HASH=
TREASURY_ADDRESS=
```

### Bước 1: Build Aiken validator

```bash
cd InstantGen/onchain
aiken build
# → plutus.json
aiken blueprint address --testnet-magic 2
# → copy validator hash vào VAULT_SCRIPT_HASH
```

Validator cần 4 parameters: `lamp_policy_id`, `treasury_addr`, `um_nft_policy`, `ms_per_epoch`. Xem `aiken.toml` cho cách apply parameters.

**Verify build:**
```bash
aiken check >check.log 2>&1; echo $?
# Expected: 0 (pass)
```

### Bước 2: Deploy LAMP token

```bash
cd scripts && npm install
npm run deploy:lamp
# → ghi LAMP_POLICY_ID vào .env
# LAMP asset name: "tLAMP" = 0x744c414d50
```

Verify:
```bash
cardano-cli query utxo --address <your_addr> --testnet-magic 2
# Kiểm tra có tLAMP token
```

### Bước 3: Deploy UM datum NFT

```bash
npm run deploy:um
# → ghi UM_NFT_POLICY_ID vào .env
# NFT asset name: "UMD" = 0x554d44
# UM datum initial: smoothed_q=1_000_000_000, last_updated_epoch=<current>, history=[]
```

### Bước 4: Update constants.ts với deployed values

```typescript
// InstantGen/offchain/src/constants.ts
export const TESTNET_CONFIG = {
  vaultScriptHash: "<từ bước 1>",
  lampPolicyId:    "<từ bước 2>",
  lampAssetName:   "744c414d50",    // "tLAMP"
  umNftPolicyId:   "<từ bước 3>",
  umNftAssetName:  "554d44",        // "UMD"
  treasuryAddress: "<script addr>",
};
```

### Bước 5: Deploy vault UTxO

```bash
npm run deploy:vault
# Tạo vault UTxO với VaultDatum initial state + LAMP token
# Xem README.md §5 cho datum structure
```

### Bước 6: Start UMKeeper (optional cho testnet)

```bash
cd UMKeeper/offchain
npx tsx src/keeper.ts
# Chạy background — update UM datum mỗi epoch
# Nếu không chạy: Instant sẽ dùng fallback UM=0.5× sau 1 epoch
```

### Bước 7: Run tests trước khi go-live

```bash
cd InstantGen/offchain
npm install
npm test
# Expected: 314 tests pass (theo README.md)
```

### Bước 8: End-to-end test

```bash
cd scripts
npm run test:e2e
```

---

## 2. Test plan

### 2.1 Positive cases (≥ 3)

**P1: InstantGen cơ bản — 1000 LAMP, Flame, UM fresh**
- Setup: vault với 10_000 LAMP, UM fresh (staleness = 0)
- Input: lamp_paid = 1_000_000_000 oil (1000 LAMP), Flame profile
- Expected: batch mới với 3_150_000_000 nanogic (TV-INST-GEN-01)
- Verify: output datum.lamp_balance = old - 1B, treasury +1B

**P2: InstantGen boundary — MIN purchase (10 LAMP)**
- Input: lamp_paid = 10_000_000 (= MIN)
- Expected: ACCEPT (C-INST-1 boundary = MIN)
- MAGIC: `computeInstantMagic(10_000_000, 1B, pm_flame)` = 31_500_000 nanogic

**P3: InstantGen với UM stale → fallback**
- Setup: UM stale 2 epochs (staleness = 2 > UM_MAX_STALENESS)
- Input: 1000 LAMP, Flame
- Expected: ACCEPT, MAGIC = 1_575_000_000 nanogic (thay vì 3_150_000_000)
- Verify: TV-UM-SPLIT (vectors.ts:129)

**P4: InstantGen với pending profile apply**
- Setup: vault có pending_profile Ember, effective_epoch = current_epoch
- Input: 1000 LAMP
- Expected: profile tự switch Ember trong tx, MAGIC tính theo PM_Ember = 1.15×
- Output datum: profile=Ember, pending_profile=None

**P5: InstantGen với halving lazy trong cùng tx**
- Setup: vault có batch Instant ở k=1 (chưa halved)
- Input: InstantGen tx
- Expected: batch k=1 được halve (current_amount / 2), batch mới append sau

---

### 2.2 Negative cases (≥ 5)

**N1: lamp_paid < MIN (C-INST-1)**
- Input: lamp_paid = 9_999_999
- Expected: REJECT (`vault.ak:145`)
- Vector: TV-INST-MIN

**N2: lamp_paid > MAX (C-INST-2)**
- Input: lamp_paid = 10_000_000_000_001
- Expected: REJECT (`vault.ak:148`)
- Vector: TV-INST-MAX

**N3: lamp_paid > L_avail — LAMP đang lock (C-INST-3)**
- Setup: lamp_balance = 100_000_000_000, lamp_locked = 60_000_000_000, L_avail = 40_000_000_000
- Input: lamp_paid = 40_000_000_001
- Expected: REJECT (`vault.ak:151`)
- Vector: TV-INST-AVAIL

**N4: Vault đầy 32 batches (C-INST-7)**
- Setup: vault với 32 active non-expired batches
- Input: InstantGen (lamp_paid hợp lệ)
- Expected: REJECT (`vault.ak:155`)
- Vector: TV-INST-VAULT-FULL

**N5: halved=True inject ở k=0 (C-DECAY-8)**
- Setup: vault với batch k=0 (chưa đến epoch halve)
- Attacker output: batch với halved=True (forged)
- Expected: REJECT — A02 check `expected_batches` không match
- Vector: TV-HALVED-INJECT (vectors.ts:191)

**N6: Treasury không nhận LAMP (C-INST-4)**
- Tx không có output đến treasury_addr, hoặc treasury_addr là wallet
- Expected: REJECT (`vault.ak:199` — Script credential check, `vault.ak:200` — amount check)

**N7: Không có owner signature (C-PC-V1)**
- Tx thiếu `owner ∈ extra_signatories`
- Expected: REJECT (`vault.ak:135`)

**N8: Output datum sai — lamp_balance không giảm (A02)**
- Attacker giữ lamp_balance cũ trong output datum
- Expected: REJECT (`vault.ak:218`)

**N9: BigInt overflow check (C-OVERFLOW)**
- Dùng JavaScript Number thay vì BigInt cho 36×10^15 oil
- Expected: test fail (incorrect result, không phải exception)
- Vector: TV-OVERFLOW-01 (vectors.ts:161)

**N10: Double-satisfaction — 2 vault inputs (C-VAULT-DS-1)**
- Tx có 2 vault UTxO cùng address làm input
- Expected: REJECT (`vault.ak:130`)

---

## 3. Chạy test suite

```bash
cd InstantGen/offchain
npm install
npm test
# 314 tests expected (theo README.md, deploy checklist §E.3)
```

Test coverage bắt buộc (§E.3 deploy checklist):
- TV-INST-01..03 ✓
- TV-UM-SPLIT ✓
- TV-OVERFLOW-01..02 ✓
- TV-HALVED-INJECT ✓
- TV-CONS-01 ✓

Aiken tests (32 tests theo README.md):
```bash
cd InstantGen/onchain
aiken check
# 32 Aiken tests expected
```

---

## 4. Known limits (v1.0)

### 4.1 BurnBatch locked
**Không thể claim MAGIC** cho đến v1.1. `BurnBatch` redeemer trả về `fail` ngay lập tức (`vault.ak:93`). User có thể accumulate batches nhưng không redeem.

**Hậu quả:** Batches sẽ expire sau 2 epochs nếu không có BurnBatch. MAGIC sẽ mất sau k≥2.

### 4.2 ApplyHalving stub
Redeemer `ApplyHalving` chỉ check owner sign, không thực hiện halving thực sự. Halving vẫn xảy ra lazily trong `validate_instant_gen` qua `halve_then_prune`. Standalone `ApplyHalving` tx không có effect thực tế ngoài confirm owner.

### 4.3 attribution_root chưa implement đầy đủ
`vault.ak:248` chỉ kiểm tra `total_events++` và `last_event_epoch`. Hash chain của `attribution_root` chưa được verify on-chain (TODO v1.1).

### 4.4 activity_state không check trong InstantGen
Field `activity_state` không có trong A02 check của `validate_instant_gen`. Off-chain cần giữ nguyên giá trị (không được thay đổi). Xem v1.1 để bổ sung.

### 4.5 Vault datum size
Worst case ~12KB (§5.1). Tx limit 16KB. Vault với 32 batches + 64 holdings + delegation tiệm cận limit.

---

## 5. v-next (v1.1 items)

| Item | Mô tả | Spec ref |
|---|---|---|
| ConsumeMAGIC | Implement BurnBatch đầy đủ với A02 + apply_pending_profile | SPEC_V1 §3 |
| ApplyHalving full | Wiring apply_pending_profile + A02 datum check | SPEC_V1 §2 |
| attribution_root hash chain | Verify `blake2b256(prev_root ∥ event_bytes)` on-chain | §7.2 C-ATT-1 |
| activity_state A02 check | Thêm activity_state vào invariant list InstantGen | §5.5 |
| Testnet deploy automation | Script tự động chạy toàn bộ 8 bước deploy | §E.3 |
| ScheduleGen shard cap | SHARD_COUNT=16, SHARD_CAP=4.5×10^14 oil | §11 |

---

## 6. Env variables reference

| Biến | Mô tả | Set khi nào |
|---|---|---|
| BLOCKFROST_KEY | Preview testnet API key | Trước deploy |
| PRIVATE_KEY | ed25519 signing key | Trước deploy |
| NETWORK | "Preview" | Trước deploy |
| LAMP_POLICY_ID | PolicyId LAMP token | Sau deploy:lamp |
| UM_NFT_POLICY_ID | PolicyId UM datum NFT | Sau deploy:um |
| VAULT_SCRIPT_HASH | Hash của vault validator | Sau aiken build |
| TREASURY_ADDRESS | Script address Treasury | Sau deploy:vault |
| SHARD_NFT_POLICY_ID | PolicyId shard NFTs (ScheduleGen) | Sau deploy:shards |

---

## 7. Lỗi thường gặp

| Mã lỗi | Nguyên nhân | Xử lý |
|---|---|---|
| GEN-INST-001 | lamp_paid < 10 LAMP | Tăng amount ≥ 10_000_000 |
| GEN-INST-002 | lamp_paid > 10^13 oil | Giảm amount |
| GEN-INST-003 | lamp_paid > L_avail | Kiểm tra lamp_locked; đợi VacuumGen/ScheduleGen hoàn thành |
| GEN-VAULT-001 | Vault đầy 32 batches | Đợi v1.1 BurnBatch; hoặc đợi batches expire |
| UM stale fallback | Keeper không chạy hoặc bị trễ | Khởi động UMKeeper; chấp nhận UM=0.5× hoặc đợi |
| BurnBatch locked | v1.0 stub | Đợi v1.1 |
| treasury Script check | treasury_addr là wallet address | Đảm bảo treasury_addr là Script credential |
