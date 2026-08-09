# UMKeeper — Execution Guide
## GenMAGIC v3.3 · §14 Deploy, Test, Run

---

## 1. Deploy steps (thứ tự bắt buộc)

### Bước 1 — Build Aiken validator

```bash
cd /Users/ductiger/Projects/MAGIC/UMKeeper/onchain
aiken build
# Tạo ra: onchain/plutus.json
# Lấy un-applied CBOR từ: plutus.json → validators[0].compiledCode
```

Env var cần lưu sau bước này:
```
UM_VALIDATOR_CBOR=<compiledCode hex từ plutus.json>
```

### Bước 2 — Apply params và tính script hash

Trong `scripts/` (hoặc script riêng):
```typescript
import { applyParamsToScript, validatorToScriptHash } from "@lucid-evolution/lucid";

const msPerEpoch  = 86_400_000;  // Preview testnet
const umPolicy    = process.env.UM_NFT_POLICY_ID!;
const umName      = "554d44";    // "UMD" hex

// Permissionless — KHÔNG còn keepers/threshold.
const appliedScript = applyParamsToScript(UM_VALIDATOR_CBOR, [
  msPerEpoch, umPolicy, umName
]);
const scriptHash = validatorToScriptHash({ type: "PlutusV3", script: appliedScript });
```

Env vars cần lưu:
```
UM_SCRIPT_HASH=<scriptHash>
UM_APPLIED_CBOR=<appliedScript>
```

### Bước 3 — Mint UM authority NFT

Dùng one-shot minting policy (tham khảo `scripts/deploy/02_deploy_um_nft.ts` khi có). NFT phải là unique — policy ID + asset name `554d44`.

```
UM_NFT_POLICY_ID=<policyId>
UM_NFT_UNIT=<policyId>554d44
```

### Bước 4 — Deploy UM UTxO (initial datum)

```typescript
const genesisEpoch = posixMsToEpoch(BigInt(Date.now()), "Preview");
const initialDatum = {
  smoothed_q:         1_000_000_000n,  // Q = 1.0× neutral
  last_updated_epoch: genesisEpoch,
  history:            [],
};

await lucid.newTx()
  .pay.ToAddressWithData(
    umScriptAddr,
    { kind: "inline", value: Data.to(initialDatum, UMDatumSchema) },
    { lovelace: 2_000_000n, [UM_NFT_UNIT]: 1n }
  )
  .complete();
```

### Bước 5 — Start keeper process

```bash
cd /Users/ductiger/Projects/MAGIC/UMKeeper/offchain
npm install

# .env trong UMKeeper/offchain:
# BLOCKFROST_KEY=...
# KEEPER_KEY=ed25519_sk...   (private key hex)
# UM_NFT_UNIT=<policyId>554d44
# UM_SCRIPT_HASH=<hash>
# KEEPER_1_PKH=...
# KEEPER_2_PKH=...

npx tsx src/keeper.ts
```

Keeper chạy long-lived. Nên dùng `pm2` hoặc `screen` trên server:
```bash
pm2 start "npx tsx src/keeper.ts" --name um-keeper --cwd /path/to/UMKeeper/offchain
```

---

## 2. Phụ thuộc deploy

```
UMKeeper deploy PHẢI sau:
  - LAMP policy deployed  (cần LAMP_POLICY_ID cho hệ sinh thái)
  - UM NFT minting policy deployed  (cần UM_NFT_POLICY_ID để apply params)

UMKeeper deploy PHẢI trước:
  - InstantGen deploy  (InstantGen cần UM_NFT_UNIT để query UM datum)
                       — đây là hộ tiêu thụ UM DUY NHẤT đang sống.
                       (VacuumGen từng đứng ở đây; module đó nay ở Legacy/genmagic-v3.3/)
```

---

## 3. Test plan

### 3.1 Tests dương tính (happy path)

**P1 — Aiken test: happy path permissionless (KHÔNG cần chữ ký)**
```bash
cd /Users/ductiger/Projects/MAGIC/UMKeeper/onchain
aiken check
# Test: um_happy_path — extra_signatories = []
# Expected: PASS
# Verify: history = [Q, 1.2Q], smoothed = 1.1Q, epoch = 5
```

**P2 — TypeScript: neutral epoch giữ smoothed ổn định**
```bash
cd /Users/ductiger/Projects/MAGIC/UMKeeper/offchain
npm test -- --reporter=verbose
# Test: "computeNewUM / Neutral epoch (burns=mints) → smoothed converges"
# (tests/um.test.ts:86-97)
# Expected: newSmoothed < 1_500_000_000n (converging down), ≥ UM_MIN_Q
```

**P3 — TypeScript: history sliding window không vượt 6 sau 10 updates**
```bash
# Test: "History stays ≤ 6 entries after 10 updates"
# (tests/um.test.ts:113-119)
# Expected: mỗi iteration newHistory.length <= 6
```

**P4 — TypeScript: high demand clamped tại UM_MAX**
```bash
# Test: "High demand (burns >> mints) → smoothed approaches UM_MAX"
# (tests/um.test.ts:100-103)
# Expected: newSmoothed = 2_000_000_000n
```

**P5 — TypeScript: mọi boundary cases đều trong [UM_MIN, UM_MAX]**
```bash
# Test: "Smoothed always in [UM_MIN_Q, UM_MAX_Q] — C-UM-3"
# (tests/um.test.ts:122-135)
# Expected: tất cả 4 cases pass
```

### 3.2 Tests âm tính (rejection)

Lưu ý: KHÔNG còn test auth (um_unauthorized/um_stranger_signer) vì permissionless. An toàn được đảm bảo bằng các guard eUTXO + recompute SMA dưới đây.

**N1 — Aiken: double-satisfaction qua stake credential**
```bash
# Test: um_double_satisfaction_stake_cred
# Expected: rejected (count_inputs = 2 ≠ 1)
```

**N2 — Aiken: UM NFT bị rút (authority strip)**
```bash
# Test: um_authority_nft_stripped
# Expected: rejected (quantity_of = 0 ≠ 1)
```

**N3 — Aiken: update cùng epoch (replay)**
```bash
# Test: um_same_epoch
# Expected: rejected (current_epoch = last_updated_epoch = 5)
```

**N4 — Aiken: khai gian smoothed_q trong output datum**
```bash
# Test: um_forged_smoothed
# Expected: rejected (output_datum.smoothed_q = 2e9 ≠ computed 1.1e9)
```

**N7 — TypeScript: staleness > 1 → fallback UM (InstantGen)**
```bash
# Test trong InstantGen: TV-UM-SPLIT
# cd InstantGen/offchain && npm test
# Verify: getUmForInstant({smoothed_q: 2e9, last_updated_epoch: 98n}, 100n) = 500_000_000n
```

**N8 — TypeScript: mints=0 không gây division by zero**
```bash
# Test: "mints=0 → denominator=1"
# (tests/um.test.ts:23-26)
# Expected: result = very large bigint (không crash)
```

### 3.3 Chạy toàn bộ tests

```bash
# Aiken (on-chain — 5 tests: 1 happy + 4 reject; KHÔNG còn test auth)
cd /Users/ductiger/Projects/MAGIC/UMKeeper/onchain
aiken check

# TypeScript (off-chain — 20 test cases)
cd /Users/ductiger/Projects/MAGIC/UMKeeper/offchain
npm install && npm test

# Expected output:
#   Aiken: 5/5 PASS
#   TS:    20/20 PASS
```

---

## 4. Known limits (v1.0)

| Giới hạn | Mô tả | Tác động |
|---|---|---|
| **Stub epoch stats** | `getEpochStats()` trả về neutral (1:1) — không đọc dữ liệu thực | UM luôn drift về 1.0× trong testnet; production cần indexer |
| **`new_raw` cấp off-chain** | Permissionless → ai cũng trigger; validator KHÔNG verify được `new_raw` tự thân (chỉ clamp + SMA) | Người trigger có thể chọn raw trong `[0.5×, 2.0×]`; tác động bị SMA 6-epoch làm mịn. v-next: on-chain epoch accumulator |
| **Không có keeper incentive on-chain** | Người trigger tự trả gas; nếu không ai trigger → UM stale, InstantGen fallback 0.5× | v-next: thêm fee reward cho người trigger từ protocol fee |
| **Single-epoch catch-up** | Nếu không ai trigger nhiều epoch, chỉ update 1 điểm raw khi quay lại | History SMA ít điểm hơn → ít smooth hơn (punishment tự nhiên) |
| **No on-chain epoch stats** | Burns/mints không được tích luỹ on-chain trong UMKeeper | Phải tin vào off-chain indexer hoặc MagicSupplyShard |

---

## 5. v-next roadmap

| Item | Mô tả |
|---|---|
| **On-chain epoch accumulator** | Tích luỹ burns/mints on-chain (MagicSupplyShard) để validator verify `new_raw` trực tiếp → loại bỏ rủi ro `new_raw` cấp off-chain của permissionless |
| **Real epoch stats** | Thay stub bằng query từ `MagicSupplyShard` UTxOs (shard_minted + shard_burned per epoch) |
| **Trigger fee incentive** | Protocol trả fee nhỏ cho người trigger từ treasury khi update thành công → đảm bảo liveness |
| **Reference input cho InstantGen** | Để InstantGen read UM datum mà không cần separate lookup, tránh contention |
| **Multi-epoch fill** | Nếu không ai trigger N epoch, có thể submit N transactions liên tiếp để fill history đầy đủ |

> P8 clamp-before-append đã ĐỒNG BỘ trong v1.0 này (Aiken + TS đều lưu `clamped_raw` vào history) — không còn là mục v-next.
