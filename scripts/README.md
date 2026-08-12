# Deploy Scripts — MagicLamp testnet (Preview / Preprod)

> Nguồn chuẩn cho chuỗi ConsumeMAGIC là [`ConsumeMAGIC/EXEC.md`](../ConsumeMAGIC/EXEC.md).
> Tệp này chỉ mô tả phần **scripts**; chỗ nào hai bên nói khác nhau thì EXEC.md thắng.
> Hiện trạng module + nợ kỹ thuật: [`DevStatus.md`](../DevStatus.md).

---

## Chuẩn bị

```bash
cd scripts
npm install
```

**Secret không nằm ở đây.** `BLOCKFROST_KEY` và seed ví deploy đọc từ `$AGENT_SECRETS` —
xem `.env.example` để biết cách export. `scripts/.env` chỉ giữ giá trị **không bí mật**
(hash, policy id, địa chỉ) sinh ra sau mỗi bước deploy.

```bash
cp .env.example .env      # rồi điền dần hash/policy id sau từng bước
```

Validator **không** build sẵn trong repo. `plutus.json` là artifact, đã gitignore — mỗi
module phải `aiken build` trước khi có hash mà điền:

```bash
cd <Module>/onchain && aiken build
```

> ℹ️ Trước khi deploy bất cứ validator nào nhận apply-param: `npm run check:params`
> — đối chiếu danh sách tham số off-chain với `parameters` trong blueprint. Sai thứ tự,
> sai tên, hay thiếu một param là ra **sai script hash** ⇒ sai địa chỉ, và **không test
> nào đỏ**. `applyParamsToScript` không kiểm arity: thiếu param vẫn trả về một script
> đã-apply-một-phần với hash 28 byte trông hợp lệ.
>
> Phạm vi cổng, nói rõ để không ai đọc "0 lệch" thành "đã phủ hết": nó gác **13
> validator nhận tham số** trong `*/onchain/validators/*.ak`, qua 16 case (một số
> validator đa-mục-đích được gác cả `spend` lẫn `mint`). Nó **không** gác
> `MagicSDK/src/validatorScripts.ts` — đó là đường apply thứ hai, tự gác bằng
> `MagicSDK/tests/vaultParams.test.ts`.

---

## Thứ tự deploy bắt buộc

```
(0) aiken build             → sinh onchain/plutus.json cho từng module
01_mint_lamp.ts             → mint LAMP (tLAMP trên testnet)
02_deploy_um.ts             → UM datum (cần trước InstantGen)
03_deploy_shards.ts         → 16 shard (cần trước ScheduleGen)
05_create_instant_vault.ts  → vault Instant đầu tiên
07_create_schedule_vault.ts → vault Schedule
08_deploy_getmagic.ts       → validator GetMAGIC (MagicAllocation…)
09_deploy_consume.ts        → hạ tầng ConsumeMAGIC trong 1 tx: mint price NFT +
                              post PriceParam beacon + mint thread Engage +
                              tạo Engage UTxO + apply-param consume validator
                              (cần VAULT_INSTANT_HASH từ bước 05)
```

> ⚠️ **Dừng ở 07 là chuỗi CHƯA xong.** Không có bước 09 thì không có beacon giá và không
> có thread Engage ⇒ **không tiêu MAGIC được**, mà không có gì báo thiếu: mọi bước trước
> vẫn xanh.

> ⚠️ Mỗi bước chờ ~20 giây cho tx confirm rồi hãy chạy bước tiếp.

Không có `04` và `06`: `04_create_vault.ts` / `06_create_vacuum_vault.ts` thuộc
SnapshotGen/VacuumGen — mô hình GenMAGIC v3.3 đã bỏ. Số bước giữ nguyên chỗ trống, không
đánh số lại, để hash và lịch sử cũ còn đối chiếu được.

---

## ⛔ Chuỗi e2e đang ĐỨT ở bước sinh MAGIC

`npm run test:instant` **hôm nay không xanh được**, và đó không phải lỗi script: trần thứ
ba của InstantGen là `compute_cap_pp(schedules) = Σ(gen_schedules) / 2`
(`InstantGen/onchain/lib/magiclamp/protocol/math.ak`), mà vault Instant luôn có
`gen_schedules = []` ⇒ trần **0** ⇒ `min3(...) = 0`. Fail-closed có chủ ý, không đi vòng
được bằng env hay tham số. Trạng thái: [`DevStatus.md`](../DevStatus.md) — "Còn nợ" #6 và
"Chờ chủ nhân chốt" D1.

**Đường duy nhất để có MAGIC mà tiêu:** cửa ScheduleGen.

```bash
npm run deploy:schedule-vault
npm run test:schedule-commit
npm run test:schedule-fire
```

Nhưng **chưa cắm thẳng vào ConsumeMAGIC được**: `09_deploy_consume.ts` hôm nay ghim vault
Instant — ném lỗi nếu thiếu `VAULT_INSTANT_HASH`, và đặt cứng `BURN_BATCH_CONSTR = 2n`
(constr `BurnBatch` của `VaultRedeemer` InstantGen). Muốn consume từ vault Schedule thì
phải truyền `vaultScriptHash` = hash vault Schedule **và** constr `BurnBatch` của
`VaultRedeemer` ScheduleGen vào `consumeParams`. Hai giá trị đó vào apply-param — sai một
cái là sai script hash, tức sai địa chỉ Engage, và không có gì báo.

---

## Chạy từng bước

```bash
npm run deploy:lamp             # → LAMP_POLICY_ID
npm run deploy:um               # → UM_NFT_POLICY_ID, UM_DATUM_HASH
npm run deploy:shards           # → SHARD_NFT_POLICY_ID
npm run deploy:instant-vault    # → VAULT_OWNER_PKH, VAULT_INSTANT_HASH
npm run deploy:schedule-vault   # → VAULT_SCHEDULE_HASH
npx tsx deploy/08_deploy_getmagic.ts
npm run deploy:consume          # → PRICE_NFT_POLICY, PRICE_PARAM_SCRIPT_HASH,
                                #   CONSUME_SCRIPT_HASH, ENGAGE_NFT_POLICY
                                #   (== CONSUME_SCRIPT_HASH), ENGAGE_NFT_UNIT, ENGAGE_UTXO
```

Chép giá trị in ra vào `.env` sau mỗi bước.

**Hoặc chạy cả chuỗi, tự nối env giữa các bước** (cũng đứt ở bước sinh MAGIC, vì lý do trên):

```bash
cd /Users/ductiger/Projects/MAGIC
AGENT_SECRETS=<đường dẫn secret của hệ agent> bash scripts/run_consume_e2e.sh Preview
```

---

## Test sau khi deploy

```bash
npm run test:instant           # ⛔ chưa xanh được — xem mục ĐỨT ở trên
npm run test:schedule-commit
npm run test:schedule-fire
npm run test:withdraw
npm run test:update-profile
npm run test:multi-vault
npm run verify:hashes          # hash per-network
```

Tiêu MAGIC (sau bước 09):

```bash
npx tsx test/consume_only.ts
# Mong đợi: vault.magic_batches giảm đúng `required`; EngageDatum tăng
# `consumed_nanogic` đúng số đã trả.
```

> App xác nhận thanh toán phải đọc **delta `consumed_nanogic`**, KHÔNG đọc
> `consumed_count` (nó đếm LƯỢT, không mang giá trị — trả 1 op rẻ cũng +1). Lý do đầy đủ:
> `ConsumeMAGIC/EXEC.md §5`.

**UMKeeper không có CLI.** `UMKeeper/offchain/src/keeper.ts` là thư viện — nó export
`startUMKeeper(config)` chứ không tự chạy; `npx tsx src/keeper.ts` chỉ nạp module rồi
thoát. Muốn chạy keeper thì viết một entry gọi `startUMKeeper` với `lucid` đã chọn ví.
Và `getEpochStats` hiện là **bản giả** trả số trung tính — chưa nối indexer thật
([`DevStatus.md`](../DevStatus.md) nợ #10).

---

## Định nghĩa thành công cho mỗi bước

| Script | Thành công là |
|---|---|
| 01_mint_lamp | TX hash xuất hiện + thấy LAMP trên cardanoscan |
| 02_deploy_um | UTxO tại `um_script_address` có datum `smoothed_q = 1e9` |
| 03_deploy_shards | 16 UTxO tại `shard_script_address`, `shard_id` 0-15 |
| 05_create_instant_vault | UTxO tại `vault_script_address` có `VaultDatum` đúng owner **và mang đúng 1 NFT danh tính** (INV-VAULT-IDENTITY — thiếu là LAMP kẹt vĩnh viễn) |
| 07_create_schedule_vault | UTxO có `VaultDatum` đúng owner + NFT danh tính |
| 08_deploy_getmagic | In hash + address validator GetMAGIC, khớp `plutus.json` sau `aiken build` |
| 09_deploy_consume | 1 tx làm 5 việc: UTxO beacon `PriceParam` mang đúng 1 price NFT ở `PRICE_PARAM_SCRIPT_HASH`; UTxO Engage mang đúng 1 thread NFT ở `CONSUME_SCRIPT_HASH`; `ENGAGE_NFT_POLICY == CONSUME_SCRIPT_HASH` (policy = chính script hash, tự tham chiếu) |

---

## Kiểm trên Cardano Explorer

```
https://preview.cardanoscan.io/transaction/{TX_HASH}
https://preview.cardanoscan.io/address/{SCRIPT_ADDRESS}
```

---

## Nếu bị kẹt

| Lỗi | Xử lý |
|---|---|
| `BLOCKFROST_KEY missing in .env` | Export từ `$AGENT_SECRETS` — xem `.env.example`. ĐỪNG ghi khoá vào `.env` |
| `Either PRIVATE_KEY or WALLET_SEED required` | Export `WALLET_SEED` từ `$AGENT_SECRETS`; biến seed dò bằng `npx tsx detect_deploy_wallet.ts` |
| `Need at least 5 tADA` | Lấy tADA từ faucet |
| `FILL_AFTER_AIKEN_BUILD` | Chạy `aiken build` ở `<Module>/onchain` rồi điền hash |
| `Vault UTxO not found` | Chạy `npm run deploy:instant-vault` trước |
| `expect grant > 0` ở `test:instant` | KHÔNG phải lỗi cấu hình — trần thứ ba bằng 0, xem mục ĐỨT ở trên |
| Sai địa chỉ script sau deploy | `npm run check:params` — gần như luôn là lệch apply-param |
| Tx timeout | Tăng fee hoặc thử lại — Preview đôi khi chậm |
