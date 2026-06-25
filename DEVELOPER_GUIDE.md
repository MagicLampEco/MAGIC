# Developer Guide — MagicLamp MAGIC Protocol

## Đã làm xong ✅

### Math engine (278/278 tests pass)
Toàn bộ logic tính toán theo spec GenMAGIC v3.3 + ConsumeMAGIC v2.2 + AppEconomics v2.1 đã implement và test:

- Decay formulas (§4.2) — Snapshot geometric, Instant halving, Vacuum/Schedule cliff
- LF (§6.3) — Loyalty Factor piecewise linear, weighted average
- OAC (§6.4) — On-chain Activity Coefficient, window `[e-12, e)` (exclusive upper, fixed)
- SM (§6.5) — Streak Multiplier 4 tiers
- UM (§14) — Network Demand Multiplier, SMA-6, clamp [0.5, 2.0]
- Tất cả 4 cơ chế sinh: SnapshotGen, InstantGen, VacuumGen, ScheduleGen
- ConsolidateHoldings sort-partition-merge (P8 deterministic)
- ProfileChange 2-step lazy
- ConsumeMAGIC v2.2 — burn flow, delegation, attribution chain
- AppEconomics v2.1 — W function, reward distribution, V_dampened

### ProtocolUtils — Single source of truth (P8)
Các primitives shared được gom vào `ProtocolUtils/` package:
- Display: `nanogicToMagicStr`, `qToStr`
- Epoch: `slotToEpoch`, `getCurrentEpoch(lucid, network)`, `getTipSlot(lucid, network)`
- Conversions: `lampToOildrop`, `oildropToLamp`, `lAvail`
- Sort comparators: `cmpBigIntAsc`, `cmpBigIntDesc` (pure BigInt)
- LAMP lock: `selectLampForLock`, `removeLockedAmount`, `sumHoldings`, `sumLocked` (canonical implementations)
- OAC: `pruneActivityWindow`, `countActiveAppsInOacWindow`, `addBurnToActivity`
- Math: `isqrt`, `isqrt10th`, `vDampened`, `verifyVd`, `mulQ`, `clamp`
- Constants: `Q`, `SLOTS_PER_EPOCH`, `OILDROP_PER_LAMP`, `NANOGIC_PER_MAGIC`, `S_LAMP_TOTAL`, `DRM_LOOKBACK`, `GENESIS_UNIX`

Mỗi module SDK dependent qua `"@magiclamp/protocol-utils": "file:../../ProtocolUtils"` và re-export từ local `math.ts`. **Không copy-paste primitives nữa** — sửa 1 chỗ, áp dụng toàn bộ.

Xem `ProtocolUtils/CODE_REVIEW.md` để biết các critical bugs đã fix (isqrt10th overflow, OAC window upper bound) và rationale design.

### Aiken validators — `aiken check` 0 errors trên 5 modules
Đã migrate stdlib v1 → v2 (cardano/interval → aiken/interval, ScriptContext relocated, `aiken/list` → `aiken/collection/list`, `list.sort` lấy Ordering, `list.foldl` arg order swapped, module path khớp `lib/magiclamp/protocol/`). Còn warnings unused imports — không block deploy.

```bash
for m in InstantGen SnapshotGen VacuumGen ScheduleGen UMKeeper; do
  (cd $m/onchain && aiken check)   # phải báo Summary 0 errors
done
```

---

## Dev cần làm — theo thứ tự

### Bước 1: Cài đặt môi trường

```bash
# Aiken (Cardano smart contract compiler)
curl -sSfL https://install.aiken-lang.org | bash
aiken --version  # phải >= 1.1.0 (đã verify với 1.1.21)

# Node.js >= 20
node --version

# Cardano CLI (optional, dùng cho deploy scripts)
# https://github.com/input-output-hk/cardano-node/releases
```

### Bước 2: Verify checks pass trên máy của bạn

```bash
# JS tests (278/278)
for dir in InstantGen SnapshotGen VacuumGen ScheduleGen UMKeeper Consolidate ProfileChange ConsumeMAGIC AppEconomics; do
  echo "=== $dir ===" && cd $dir/offchain && npm install --silent && npm test && cd ../..
done
cd ProtocolUtils && npm install --silent && npm test && cd ..

# Aiken check (0 errors mỗi module)
for m in InstantGen SnapshotGen VacuumGen ScheduleGen UMKeeper; do
  echo "=== $m ===" && (cd $m/onchain && aiken check)
done
```

Nếu kết quả khác kỳ vọng (test fail, aiken error), STOP và liên hệ PM trước khi tiếp tục.

### Bước 3: Build Aiken validators → `plutus.json`

```bash
cd InstantGen/onchain  && aiken build && cd ../..
cd SnapshotGen/onchain && aiken build && cd ../..
cd VacuumGen/onchain   && aiken build && cd ../..
cd ScheduleGen/onchain && aiken build && cd ../..
cd UMKeeper/onchain    && aiken build && cd ../..
```

Mỗi lệnh sinh `plutus.json` trong folder đó. **Thành công** = không có error. Warning về unused imports là chấp nhận được (không block).

Lấy script hash mỗi validator:
```bash
cat InstantGen/onchain/plutus.json  | jq '.validators[0].hash'
cat SnapshotGen/onchain/plutus.json | jq '.validators[0].hash'
cat VacuumGen/onchain/plutus.json   | jq '.validators[0].hash'
cat ScheduleGen/onchain/plutus.json | jq '.validators[].hash'  # vault + shard
cat UMKeeper/onchain/plutus.json    | jq '.validators[0].hash'
```

> Lưu ý: `Consolidate/onchain/` và `ProfileChange/onchain/` chỉ có `validators/` (không có `aiken.toml`). Chúng là partial validators — không build standalone. Dev cần quyết định gộp vào module chính (vd. tích hợp vault_consolidate.ak vào VacuumGen) hoặc tạo aiken.toml riêng cho từng cái.

### Bước 4: Cập nhật config

File `scripts/config.ts` đã có sẵn struct. Set qua env vars hoặc edit trực tiếp:

```typescript
// scripts/config.ts — hiện tại
export const SCRIPT_HASHES = {
  vault_instant:   process.env.VAULT_INSTANT_HASH   ?? "FILL_AFTER_AIKEN_BUILD",
  vault_snapshot:  process.env.VAULT_SNAPSHOT_HASH  ?? "FILL_AFTER_AIKEN_BUILD",
  vault_vacuum:    process.env.VAULT_VACUUM_HASH    ?? "FILL_AFTER_AIKEN_BUILD",
  vault_schedule:  process.env.VAULT_SCHEDULE_HASH  ?? "FILL_AFTER_AIKEN_BUILD",
  shard:           process.env.SHARD_HASH           ?? "FILL_AFTER_AIKEN_BUILD",
  um_datum:        process.env.UM_DATUM_HASH        ?? "FILL_AFTER_AIKEN_BUILD",
};
```

Điền hash từ Bước 3 qua `.env`:
```bash
VAULT_INSTANT_HASH=...
VAULT_SNAPSHOT_HASH=...
VAULT_VACUUM_HASH=...
VAULT_SCHEDULE_HASH=...
SHARD_HASH=...
UM_DATUM_HASH=...
```

### Bước 5: Lấy testnet credentials

1. **Blockfrost API key**: https://blockfrost.io → Create project → Preview testnet
2. **Wallet**: tạo wallet Cardano, export private key
3. **tADA**: https://docs.cardano.org/cardano-testnet/tools/faucet

Bổ sung vào `scripts/.env`:
```bash
BLOCKFROST_KEY=previewXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
PRIVATE_KEY=ed25519_sk...
NETWORK=Preview
```

### Bước 6: Deploy theo thứ tự

```bash
cd scripts && npm install

# Bắt buộc theo thứ tự này — mỗi bước depend vào bước trước
npx ts-node deploy/01_mint_lamp.ts       # Mint testnet LAMP token
npx ts-node deploy/02_deploy_um.ts       # Deploy UM datum UTxO
npx ts-node deploy/03_deploy_shards.ts   # Deploy 16 shard UTxOs
npx ts-node deploy/04_create_vault.ts    # Tạo Vault UTxO đầu tiên
```

Mỗi script in các address/hash + policy IDs cần thiết. Copy vào `.env` để các script sau dùng.

### Bước 7: Chạy UMKeeper

```bash
# Terminal riêng — chạy liên tục
cd UMKeeper/offchain
BLOCKFROST_KEY=xxx PRIVATE_KEY=xxx npx ts-node src/keeper.ts
```

Keeper update UM datum mỗi epoch (~5 ngày trên Preview). Nếu không có keeper, InstantGen dùng fallback rate 0.5× (C-UM-6).

### Bước 8: Test từng cơ chế

```bash
cd scripts
npx ts-node test/e2e_flow.ts
```

Script này chạy theo thứ tự:
1. SnapshotGen trigger
2. InstantGen purchase 100 LAMP
3. VacuumGen commit 50 LAMP → chờ 2 epoch → fire
4. ScheduleGen commit L=10, λ=10 LAMP → fire

---

## Định nghĩa "Thành công" ở mỗi bước

| Bước | Thành công là |
|---|---|
| JS tests | 278/278 passed (✅ đã xong) |
| `aiken check` | 0 errors mỗi module (✅ đã xong; còn warnings unused imports) |
| `aiken build` | `plutus.json` tạo ra, không có error |
| Deploy UM | UTxO xuất hiện tại um_script_address trên Preview |
| Deploy Shards | 16 UTxOs tại shard_script_address |
| Create Vault | 1 UTxO với VaultDatum tại vault_script_address |
| SnapshotGen | Vault có thêm 1 MagicBatch sau 1 epoch |
| InstantGen | LAMP giảm, MagicBatch mới với source=Instant |
| VacuumGen | LAMP locked tại commit; MAGIC xuất hiện sau fire |
| ScheduleGen | Rate locked; MAGIC đều đặn mỗi epoch |

---

## Lỗi thường gặp

| Lỗi | Nguyên nhân | Xử lý |
|---|---|---|
| `aiken build` không có `plutus.json` | Aiken chưa cài đúng | Cài lại Aiken >= 1.1.0 |
| `unknown module: cardano/interval` | Aiken stdlib v1 syntax sót | Đã fix — pull main mới nhất; nếu vẫn còn, xem session migration trong git log |
| `aiken check` báo unused import | Cosmetic | Xoá import thừa hoặc bỏ qua (không block deploy) |
| `GEN-INST-003` | lamp_paid > L_avail | Kiểm tra lamp_locked |
| `GEN-LOCK-001` | Holdings không đủ để lock/remove (canonical từ ProtocolUtils) | Kiểm tra `loyalty_holdings` tổng amount |
| `GEN-VAULT-001` | Vault có 32 batches | Burn bớt batches trước |
| `GEN-SCH-006` | Shard cap exceeded | Chờ fires giải phóng, hoặc dùng shard khác |
| UM fallback 0.5× | UMKeeper chưa chạy | Start UMKeeper |
| `C-VAC-6` | Fire sai epoch | Đợi đúng fire_epoch |

---

## Quan trọng — KHÔNG làm những việc này

❌ Không commit `node_modules/` (đã có `.gitignore`)
❌ Không commit `.env` (chứa private key)
❌ Không dùng `Number` cho BigInt (oildrop/nanogic) — luôn dùng `BigInt`
❌ Không cancel VacuumGen/ScheduleGen sau khi commit (C-VAC-12, T10)
❌ Không đổi profile 2 lần trong 2 epoch liên tiếp (cooldown §12)
❌ **Không copy-paste primitives đã có trong ProtocolUtils** (`nanogicToMagicStr`, `slotToEpoch`, `selectLampForLock`, `isqrt10th`, `cmpBigIntAsc/Desc`, ...). Sửa 1 chỗ trong ProtocolUtils, không sửa 9 nơi.
❌ Không hardcode `1666656000` (Preview genesis). Dùng `getTipSlot(lucid, network)` / `getCurrentEpoch(lucid, network)` từ ProtocolUtils.

---

## Cần hỗ trợ thêm

Liên hệ PM khi:
- Aiken build ra error không hiểu (sau khi pull main mới nhất)
- Deploy script fail
- Testnet transaction bị reject với error code lạ
- Behavior offchain SDK khác kỳ vọng — kiểm tra `ProtocolUtils/CODE_REVIEW.md` xem có related fix nào không
