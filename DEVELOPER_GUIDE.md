# Developer Guide — MagicLamp MAGIC Protocol

## Đã làm xong ✅

### Math engine (190/190 tests pass trên máy PM)
Toàn bộ logic tính toán theo spec GenMAGIC v3.3 đã được implement và test:
- Decay formulas (§4.2) — Snapshot geometric, Instant halving, Vacuum/Schedule cliff
- LF (§6.3) — Loyalty Factor piecewise linear, weighted average
- OAC (§6.4) — On-chain Activity Coefficient, window [e-12, e)
- SM (§6.5) — Streak Multiplier 4 tiers
- UM (§14) — Network Demand Multiplier, SMA-6, clamp [0.5, 2.0]
- Tất cả 4 cơ chế sinh: SnapshotGen, InstantGen, VacuumGen, ScheduleGen
- ConsolidateHoldings sort-partition-merge (P8 deterministic)
- ProfileChange 2-step lazy

### Aiken validators (chưa build)
Tất cả `.ak` files đã được viết. Chưa compile — cần `aiken build`.

---

## Dev cần làm — theo thứ tự

### Bước 1: Cài đặt môi trường

```bash
# Aiken (Cardano smart contract compiler)
curl -sSfL https://install.aiken-lang.org | bash
aiken --version  # phải >= 1.1.0

# Node.js >= 20
node --version

# Cardano CLI (optional, dùng cho deploy scripts)
# https://github.com/input-output-hk/cardano-node/releases
```

### Bước 2: Build Aiken validators

```bash
cd InstantGen/onchain  && aiken build && cd ../..
cd SnapshotGen/onchain && aiken build && cd ../..
cd VacuumGen/onchain   && aiken build && cd ../..
cd ScheduleGen/onchain && aiken build && cd ../..
cd UMKeeper/onchain    && aiken build && cd ../..
```

Mỗi lệnh sẽ tạo `plutus.json` trong folder đó.

**✅ Thành công** = không có error. Warning là bình thường.

Lấy script hash:
```bash
# Ví dụ cho InstantGen
cat InstantGen/onchain/plutus.json | jq '.validators[0].hash'
```

### Bước 3: Cập nhật config

Sau khi build, điền hash vào `scripts/config.ts`:
```typescript
export const CONFIG = {
  VAULT_SCRIPT_HASH:  "paste_hash_here",
  SHARD_SCRIPT_HASH:  "paste_hash_here",
  UM_SCRIPT_HASH:     "paste_hash_here",
  // ...
};
```

### Bước 4: Lấy testnet credentials

1. **Blockfrost API key**: https://blockfrost.io → Create project → Preview testnet
2. **Wallet**: tạo wallet Cardano, export private key
3. **tADA**: https://docs.cardano.org/cardano-testnet/tools/faucet

Tạo file `.env` ở thư mục `scripts/`:
```bash
BLOCKFROST_KEY=previewXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
PRIVATE_KEY=ed25519_sk...
NETWORK=Preview
```

### Bước 5: Deploy theo thứ tự

```bash
cd scripts && npm install

# Bắt buộc theo thứ tự này — mỗi bước depend vào bước trước
npx ts-node deploy/01_mint_lamp.ts       # Mint testnet LAMP token
npx ts-node deploy/02_deploy_um.ts       # Deploy UM datum UTxO
npx ts-node deploy/03_deploy_shards.ts   # Deploy 16 shard UTxOs
npx ts-node deploy/04_create_vault.ts    # Tạo Vault UTxO đầu tiên
```

Mỗi script sẽ in ra các address/hash cần thiết. Copy vào `config.ts`.

### Bước 6: Chạy UMKeeper

```bash
# Terminal riêng — chạy liên tục
cd UMKeeper/offchain
BLOCKFROST_KEY=xxx PRIVATE_KEY=xxx npx ts-node src/keeper.ts
```

Keeper sẽ update UM datum mỗi epoch (~5 ngày). Nếu không có keeper, InstantGen dùng fallback rate 0.5×.

### Bước 7: Test từng cơ chế

```bash
cd scripts
npx ts-node test/e2e_flow.ts
```

Script này sẽ chạy theo thứ tự:
1. SnapshotGen trigger
2. InstantGen purchase 100 LAMP
3. VacuumGen commit 50 LAMP → chờ 2 epoch → fire
4. ScheduleGen commit L=10, λ=10 LAMP → fire

---

## Định nghĩa "Thành công" ở mỗi bước

| Bước | Thành công là |
|---|---|
| Tests | 190/190 passed (✅ đã xong) |
| Aiken build | `plutus.json` tạo ra, không có error |
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
| `GEN-INST-003` | lamp_paid > L_avail | Kiểm tra lamp_locked |
| `GEN-VAULT-001` | Vault có 32 batches | Burn bớt batches trước |
| `GEN-SCH-006` | Shard cap exceeded | Chờ fires giải phóng, hoặc dùng shard khác |
| UM fallback 0.5× | UMKeeper chưa chạy | Start UMKeeper |
| `C-VAC-6` | Fire sai epoch | Đợi đúng fire_epoch |

---

## Quan trọng — KHÔNG làm những việc này

❌ Không commit `node_modules/` (đã có `.gitignore`)
❌ Không commit `.env` (chứa private key)
❌ Không dùng `Number` cho BigInt (oil/nanogic) — luôn dùng `BigInt`
❌ Không cancel VacuumGen/ScheduleGen sau khi commit (C-VAC-12, T10)
❌ Không đổi profile 2 lần trong 2 epoch liên tiếp (cooldown §12)

---

## Cần hỗ trợ thêm

Liên hệ PM khi:
- Aiken build ra error không hiểu
- Deploy script fail
- Testnet transaction bị reject với error code lạ
