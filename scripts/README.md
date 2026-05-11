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
01_mint_lamp.ts         → Mint LAMP token
02_deploy_um.ts         → Deploy UM datum (cần trước InstantGen)
03_deploy_shards.ts     → Deploy 16 shards (cần trước ScheduleGen)
04_create_vault.ts      → Tạo vault đầu tiên
```

> ⚠️ Mỗi bước phải chờ ~20 giây để tx được confirm trước khi chạy bước tiếp.

---

## Chạy từng bước

```bash
npm run deploy:lamp
# → Copy LAMP_POLICY_ID vào .env

npm run deploy:um
# → Copy UM_NFT_POLICY_ID vào .env

npm run deploy:shards
# → Copy SHARD_NFT_POLICY_ID vào .env

npm run deploy:vault
# → Copy VAULT_OWNER_PKH vào .env
```

---

## Test sau khi deploy

```bash
# Start UMKeeper (terminal riêng)
cd ../UMKeeper/offchain
BLOCKFROST_KEY=xxx PRIVATE_KEY=xxx npx tsx src/keeper.ts

# Chạy e2e test
cd ../scripts
npm run test:e2e
```

---

## Định nghĩa thành công cho mỗi bước

| Script | Thành công là |
|---|---|
| 01_mint_lamp | TX hash xuất hiện + thấy LAMP trên cardanoscan |
| 02_deploy_um | UTxO tại um_script_address có datum với smoothed_q=1B |
| 03_deploy_shards | 16 UTxOs tại shard_script_address, mỗi cái có shard_id 0-15 |
| 04_create_vault | UTxO tại vault_script_address có VaultDatum với đúng owner |
| e2e_flow | "All basic flows working! ✅" in ra cuối script |

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
| `Vault UTxO not found` | Chạy 04_create_vault.ts trước |
| Tx timeout | Tăng fee hoặc thử lại — Preview testnet đôi khi chậm |
