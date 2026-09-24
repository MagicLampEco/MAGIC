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

**Secret không nằm ở đây, và kho này cố ý KHÔNG biết chúng nằm ở đâu.** `BLOCKFROST_KEY` và
`WALLET_SEED` đi vào bằng **giá trị** qua môi trường, đặt ngay trước lệnh để bí mật sống
trong đúng một tiến trình và không đi qua tệp nào:

```bash
BLOCKFROST_KEY=… WALLET_SEED='…' bash scripts/run_wakeme_e2e.sh Preprod
```

Lấy giá trị ở đâu là việc của người vận hành. Một tệp mã biết đường tới kho khoá là một tệp
**chỉ đường** — và nó chỉ đường cho cả người không nên biết, kể cả khi nó không in ra giá trị
nào. `scripts/.env` chỉ giữ giá trị **không bí mật** (hash, policy id, địa chỉ) sinh ra sau
mỗi bước deploy.

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

## Hai cửa sinh MAGIC đều chạy được

> 🔴 **Bản trước của mục này mang nhãn `⛔ Chuỗi e2e đang ĐỨT ở bước sinh MAGIC` và nó đã
> SAI.** Nó viết rằng trần thứ ba của InstantGen là `compute_cap_pp(schedules) =
> Σ(gen_schedules) / 2`, mà vault Instant luôn có `gen_schedules = []` ⟹ trần **0** ⟹ không
> cấp được một nanogic nào. Nguyên nhân đó **không còn tồn tại trong mã**: `compute_cap_pp`
> nhận đúng một tham số, `l_avail_oildrop`
> (`InstantGen/onchain/lib/magiclamp/protocol/math.ak` ▸ `compute_cap_pp`), và
> `grep -c "gen_schedules" math.ak` → **0**. InstantGen đã cấp thật trên Preprod (tx
> `720e1817dc12a418…`, 0,3333 MAGIC).
>
> Vì sao cái sai này đắt hơn một dòng lạc trong tài liệu: đây là **sổ tay người vận hành
> đọc ngay trước khi deploy**, và nó mang một nhãn ⛔ kèm câu *"không đi vòng được"*. Người
> đọc không đi kiểm một cửa đã được dán biển cấm — họ đổi đường. Một nhãn ⛔ **không tự hết
> hạn**; nó già đi theo nhịp của mã mà nó tả, không theo nhịp của tệp chứa nó.

Cả hai cửa đều dùng được. Cửa **ScheduleGen** vẫn là cửa có chuỗi e2e đầy đủ và đã cắm sẵn
vào ConsumeMAGIC, nên nó là đường mặc định khi cần MAGIC để tiêu:

```bash
npm run deploy:schedule-vault
npm run test:schedule-commit
npm run test:schedule-fire
```

Và **đã cắm được vào ConsumeMAGIC** (2026-08-28):

```
bash run_consume_schedule_e2e.sh Preprod 1                    # dựng + cam kết lịch
#  … chờ 2 epoch …
bash run_consume_schedule_e2e.sh Preprod 2 <VAULT_TX_HASH>    # 09 → fire → tiêu MAGIC
```

🔴 **ĐÍNH CHÍNH — bản trước của đoạn này SAI, và cái sai đó làm việc dễ trông như việc khó.**
Nó viết rằng phải truyền *"constr `BurnBatch` của `VaultRedeemer` ScheduleGen"* như thể nó
khác InstantGen. Không khác: `BurnBatch` là **constr 2 ở cả hai** —
`InstantGen/onchain/lib/magiclamp/protocol/types.ak` ▸ `VaultRedeemer` ▸ `BurnBatch` (constr 2) và
`ScheduleGen/onchain/lib/magiclamp/protocol/types.ak:160-163`. Nên `BURN_BATCH_CONSTR = 2n`
dùng nguyên được, và việc phải làm chỉ là truyền `vaultScriptHash` khác.

Không sửa một dòng Aiken nào, vì `consume` **không giải mã `VaultDatum`** — nó đọc đúng
trường 0 (`owner`) qua `un_constr_data` (`ConsumeMAGIC/onchain/validators/consume.ak:443-461`),
cố ý, để một mã nguồn phục vụ được nhiều loại vault, mỗi loại một instance đã apply-param.
`09_deploy_consume.ts`, `test/consume_only.ts`, `test/mint_engage_only.ts` và
`resolve_consume_state.ts` đều đòi `VAULT_KIND=schedule|instant`, không có mặc định. Bộ
khoá consume trong sổ mang hậu tố theo loại vault (`CONSUME_SCRIPT_HASH_SCHEDULE`,
`CONSUME_SCRIPT_HASH_INSTANT`, …) để hai bản consume nằm cạnh nhau không đè nhau — lý do
và danh sách khoá ở [`consumeBook.ts`](consumeBook.ts). Keeper tự nhặt beacon giá của cả
hai bản ([`keeper_beacons.sh`](keeper_beacons.sh)).

Vẫn đúng một điều trong đoạn cũ, và nó là điều quan trọng nhất: các giá trị đó đi vào
**apply-param** — sai một cái là sai script hash, tức sai địa chỉ Engage, và không có gì
báo. Vì thế `consume_only.ts` nay **ném lỗi** khi hash dựng lại lệch env, chứ không còn
chỉ cảnh báo: hỏng ở đó rẻ hơn hỏng trên chuỗi, nơi mỗi lần thử lại tốn một cửa sổ epoch.

---

## Chạy từng bước

```bash
npm run deploy:lamp             # → LAMP_POLICY_ID
npm run deploy:um               # → UM_NFT_POLICY_ID, UM_DATUM_HASH
npm run deploy:shards           # → SHARD_NFT_POLICY_ID
npm run deploy:instant-vault    # → VAULT_OWNER_PKH, VAULT_INSTANT_HASH
npm run deploy:schedule-vault   # → VAULT_SCHEDULE_HASH
VAULT_KIND=schedule npm run deploy:consume   # → *_SCHEDULE: PRICE_NFT_POLICY, PRICE_PARAM_HASH,
VAULT_KIND=instant  npm run deploy:consume   #   CONSUME_SCRIPT_HASH, ENGAGE_NFT_POLICY (== CONSUME_SCRIPT_HASH),
                                             #   ENGAGE_NFT_UNIT, ENGAGE_UTXO, REF_CONSUME_UTXO — *_INSTANT tương tự
```

Chép giá trị in ra vào `.env` sau mỗi bước.

**Hoặc chạy cả chuỗi, tự nối env giữa các bước:**

```bash
BLOCKFROST_KEY=… WALLET_SEED='…' bash scripts/run_consume_e2e.sh Preview
```

---

## Test sau khi deploy

```bash
npm run test:instant
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

Cần sẵn trong env **hai** ref-script CIP-33, nếu không tx không dựng nổi (attach cả
hai validator = 17.310 byte, vượt trần 16.384):

- `REF_VAULT_INSTANT_UTXO` — bước `05_create_instant_vault.ts` in ra.
- `REF_CONSUME_UTXO_INSTANT` — bước `09_deploy_consume.ts` (chạy với `VAULT_KIND=instant`) in ra.

Bước nào tính ra hash thì bước đó công bố ref-script; `06_publish_ref_scripts.ts` chỉ
lo hai script ScheduleGen. Bãi đỗ dùng chung ở [`refScripts.ts`](refScripts.ts).

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
| `Thiếu biến môi trường BLOCKFROST_KEY.` | Đặt `BLOCKFROST_KEY=…` ngay trước lệnh. ĐỪNG ghi khoá xuống tệp |
| `Thiếu biến môi trường: cần PRIVATE_KEY hoặc WALLET_SEED.` | Đặt `WALLET_SEED='…'` ngay trước lệnh. ĐỪNG ghi seed xuống tệp |
| `KEEPER_STEPS có N tên không tồn tại` | Gõ sai tên bước. Tập hợp lệ in ngay dòng dưới; xem `ALL_STEPS` trong `keeper/keeper.ts` |
| `Need at least 5 tADA` | Lấy tADA từ faucet |
| `FILL_AFTER_AIKEN_BUILD` | Chạy `aiken build` ở `<Module>/onchain` rồi điền hash |
| `Vault UTxO not found` | Chạy `npm run deploy:instant-vault` trước |
| `expect grant > 0` ở `test:instant` | Một trong ba trần đang bằng 0. Trần thứ ba là `compute_cap_pp(l_avail_oildrop)` ⟹ soi LAMP khả dụng trong két trước; hai trần kia là vế thưởng và `cap_surplus`. Nhãn cũ ở đây khai nguyên nhân là `Σ(gen_schedules)/2` — nguyên nhân đó không còn trong mã |
| Sai địa chỉ script sau deploy | `npm run check:params` — gần như luôn là lệch apply-param |
| Tx timeout | Tăng fee hoặc thử lại — Preview đôi khi chậm |
