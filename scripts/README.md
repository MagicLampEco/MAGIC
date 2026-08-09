# Deploy Scripts — MagicLamp Preview Testnet

## Chuẩn bị trước khi chạy

```bash
cd scripts
npm install

cp .env.example .env
# Mở .env và điền BLOCKFROST_KEY + PRIVATE_KEY
```

---

## Thứ tự deploy bắt buộc

```
01_mint_lamp.ts            → Mint LAMP token
02_deploy_um.ts            → Deploy UM datum (cần trước InstantGen)
03_deploy_shards.ts        → Deploy 16 shards (cần trước ScheduleGen)
05_create_instant_vault.ts → Tạo vault Instant đầu tiên
07_create_schedule_vault.ts→ Tạo vault Schedule (nếu cần ScheduleGen)
08_deploy_getmagic.ts      → Deploy validator GetMAGIC (MagicAllocation…)
09_deploy_consume.ts       → Hạ tầng ConsumeMAGIC trong 1 tx: mint price NFT +
                             post PriceParam beacon + mint thread Engage +
                             tạo Engage UTxO + apply-param consume validator
                             (cần VAULT_INSTANT_HASH từ bước 05)
```

> ⚠️ **Dừng ở 07 là chuỗi CHƯA xong.** Không có bước 09 thì không có beacon giá và
> không có Engage thread ⇒ **không tiêu MAGIC được**, mà không có gì báo thiếu: mọi
> bước trước vẫn xanh, script chỉ đơn giản không tồn tại để chạy. Bước 08 và 09 có
> thật trong `scripts/deploy/`; `npm run deploy:consume` gọi 09.

> `04_create_vault.ts` / `06_create_vacuum_vault.ts` đã dời sang
> `Legacy/genmagic-v3.3/scripts/deploy/` cùng SnapshotGen/VacuumGen (mô hình
> GenMAGIC v3.3, đã bỏ).

> ⚠️ Mỗi bước phải chờ ~20 giây để tx được confirm trước khi chạy bước tiếp.

> ℹ️ Trước khi deploy bất cứ validator nào nhận apply-param: `npm run check:params`
> — đối chiếu danh sách tham số off-chain với blueprint. Sai thứ tự / thiếu một
> param là ra **sai script hash** ⇒ sai địa chỉ, không test nào đỏ.

---

## Chạy từng bước

```bash
npm run deploy:lamp
# → Copy LAMP_POLICY_ID vào .env

npm run deploy:um
# → Copy UM_NFT_POLICY_ID vào .env

npm run deploy:shards
# → Copy SHARD_NFT_POLICY_ID vào .env

npm run deploy:instant-vault
# → Copy VAULT_OWNER_PKH + VAULT_INSTANT_HASH vào .env

npx tsx deploy/07_create_schedule_vault.ts
# → Copy VAULT_SCHEDULE_HASH vào .env

npx tsx deploy/08_deploy_getmagic.ts
# → Ghi hash + address các validator GetMAGIC

npm run deploy:consume        # = npx tsx deploy/09_deploy_consume.ts
# → Copy PRICE_NFT_POLICY, PRICE_PARAM_SCRIPT_HASH, CONSUME_SCRIPT_HASH,
#   ENGAGE_NFT_POLICY (== CONSUME_SCRIPT_HASH), ENGAGE_NFT_UNIT, ENGAGE_UTXO
```

---

## Test sau khi deploy

```bash
# Start UMKeeper (terminal riêng)
cd ../UMKeeper/offchain
BLOCKFROST_KEY=xxx PRIVATE_KEY=xxx npx tsx src/keeper.ts

# Chạy smoke test từng cơ chế
cd ../scripts
npm run test:instant
npm run test:withdraw
npm run test:update-profile
```

---

## Định nghĩa thành công cho mỗi bước

| Script | Thành công là |
|---|---|
| 01_mint_lamp | TX hash xuất hiện + thấy LAMP trên cardanoscan |
| 02_deploy_um | UTxO tại um_script_address có datum với smoothed_q=1B |
| 03_deploy_shards | 16 UTxOs tại shard_script_address, mỗi cái có shard_id 0-15 |
| 05_create_instant_vault | UTxO tại vault_script_address có VaultDatum với đúng owner **và mang đúng 1 NFT danh tính** (INV-VAULT-IDENTITY — thiếu là LAMP kẹt vĩnh viễn) |
| 07_create_schedule_vault | UTxO tại shard/vault address có VaultDatum với đúng owner + NFT danh tính |
| 08_deploy_getmagic | In ra hash + address của các validator GetMAGIC, khớp `plutus.json` sau `aiken build` |
| 09_deploy_consume | 1 tx làm 5 việc: UTxO beacon `PriceParam` mang đúng 1 price NFT ở `PRICE_PARAM_SCRIPT_HASH`; UTxO Engage mang đúng 1 thread NFT ở `CONSUME_SCRIPT_HASH`; `ENGAGE_NFT_POLICY == CONSUME_SCRIPT_HASH` (policy = chính script hash, tự tham chiếu) |

---

## Kiểm tra trên Cardano Explorer

```
https://preview.cardanoscan.io/transaction/{TX_HASH}
https://preview.cardanoscan.io/address/{SCRIPT_ADDRESS}
```

---

## Nếu bị stuck

| Lỗi | Xử lý |
|---|---|
| `BLOCKFROST_KEY missing` | Điền key vào .env |
| `Need at least 5 tADA` | Lấy tADA từ faucet |
| `FILL_AFTER_AIKEN_BUILD` | Chạy `aiken build` trước |
| `Vault UTxO not found` | Chạy 05_create_instant_vault.ts trước |
| Tx timeout | Tăng fee hoặc thử lại — Preview testnet đôi khi chậm |
