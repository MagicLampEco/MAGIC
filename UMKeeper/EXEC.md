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

const keepers     = [process.env.KEEPER_1_PKH!, process.env.KEEPER_2_PKH!];
const threshold   = 2;
const msPerEpoch  = 86_400_000;  // Preview testnet
const umPolicy    = process.env.UM_NFT_POLICY_ID!;
const umName      = "554d44";    // "UMD" hex

const appliedScript = applyParamsToScript(UM_VALIDATOR_CBOR, [
  msPerEpoch, keepers, threshold, umPolicy, umName
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
  - VacuumGen deploy   (VacuumGen cần UM nếu dùng rate lock)
```

---

## 3. Test plan

### 3.1 Tests dương tính (happy path)

**P1 — Aiken test: happy path với 2 keeper ký hợp lệ**
```bash
cd /Users/ductiger/Projects/MAGIC/UMKeeper/onchain
aiken check
# Test: um_happy_path (um_datum.ak:285-301)
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

**N1 — Aiken: chỉ 1 keeper ký (dưới threshold)**
```bash
# Test: um_unauthorized (um_datum.ak:304-319) — test fail expected
# aiken check bắt bằng `test ... fail`
# Expected: tx rejected (count=1 < threshold=2)
```

**N2 — Aiken: kẻ lạ ký (không trong whitelist)**
```bash
# Test: um_stranger_signer (um_datum.ak:322-337)
# Expected: rejected (count_keeper_sigs = 0 < threshold)
```

**N3 — Aiken: double-satisfaction qua stake credential**
```bash
# Test: um_double_satisfaction_stake_cred (um_datum.ak:341-367)
# Expected: rejected (count_inputs = 2 ≠ 1)
```

**N4 — Aiken: UM NFT bị rút (authority strip)**
```bash
# Test: um_authority_nft_stripped (um_datum.ak:370-386)
# Expected: rejected (quantity_of = 0 ≠ 1)
```

**N5 — Aiken: update cùng epoch (replay)**
```bash
# Test: um_same_epoch (um_datum.ak:389-404)
# Expected: rejected (current_epoch = last_updated_epoch = 5)
```

**N6 — Aiken: khai gian smoothed_q trong output datum**
```bash
# Test: um_forged_smoothed (um_datum.ak:406-421)
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
# Aiken (on-chain — 6 tests: 1 happy + 5 reject)
cd /Users/ductiger/Projects/MAGIC/UMKeeper/onchain
aiken check

# TypeScript (off-chain — 14 test cases)
cd /Users/ductiger/Projects/MAGIC/UMKeeper/offchain
npm install && npm test

# Expected output:
#   Aiken: 6/6 PASS
#   TS:    14/14 PASS
```

---

## 4. Known limits (v1.0)

| Giới hạn | Mô tả | Tác động |
|---|---|---|
| **Stub epoch stats** | `getEpochStats()` trả về neutral (1:1) — không đọc dữ liệu thực | UM luôn drift về 1.0× trong testnet; production cần indexer |
| **Whitelist cố định** | Keepers bake vào script hash — không thể thêm/xoá on-chain | Cần redeploy validator + migrate UM UTxO nếu muốn đổi keeper |
| **Không có keeper incentive on-chain** | Keeper tự trả gas; nếu không có incentive → có thể delay | v-next: thêm fee reward cho keeper từ protocol fee |
| **Single-epoch catch-up** | Nếu keeper offline nhiều epoch, chỉ update 1 điểm raw khi quay lại | History SMA ít điểm hơn → ít smooth hơn (punishment tự nhiên) |
| **No on-chain epoch stats** | Burns/mints không được tích luỹ on-chain trong UMKeeper | Keeper phải tin vào off-chain indexer hoặc MagicSupplyShard |

---

## 5. v-next roadmap

| Item | Mô tả |
|---|---|
| **Real epoch stats** | Thay stub bằng query từ `MagicSupplyShard` UTxOs (shard_minted + shard_burned per epoch) |
| **On-chain keeper registry** | Cho phép governance thêm/xoá keeper mà không cần redeploy validator |
| **Keeper fee incentive** | Protocol trả fee nhỏ cho keeper từ treasury khi update thành công |
| **Reference input cho InstantGen** | Để InstantGen read UM datum mà không cần separate lookup, tránh contention |
| **P8 consistency fix** | Đồng bộ convention clamp-before-append giữa Aiken (`append_capped` nhận `clamped_raw`) và TypeScript (`appendHistory` nhận raw) |
| **Multi-epoch fill** | Nếu keeper offline N epoch, có thể submit N transactions liên tiếp để fill history đầy đủ |
