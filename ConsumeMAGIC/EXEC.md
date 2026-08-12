# ConsumeMAGIC — EXEC v2 (engagement-state, rewrite D1)

> Model v2 = ENGAGEMENT-STATE (KHÔNG token-burn). Tiêu MAGIC = co-spend Engage UTxO
> (consume.ak) + vault input (BurnBatch) với `Σburns == required`. KHÔNG `tx.mint`,
> KHÔNG `MAGIC_POLICY_ID`. Mọi tham chiếu mint của v1 đã bỏ.

## 1. Deploy steps (thứ tự bắt buộc)

`consume.ak` parameterized bởi **7 field, ĐÚNG THỨ TỰ** (đổi thứ tự = sai hash):

```
price_nft_policy, price_nft_name, vault_script_hash, burn_batch_constr,
max_price_stale, ms_per_epoch, price_param_script_hash
```

`vault_script_hash` + `burn_batch_constr` khác nhau per-vault (Instant=2/Schedule=2;
Legacy: Snapshot=1/Vacuum=4) → **1 deploy ConsumeMAGIC / 1 loại vault**.

> **KHÔNG còn `engage_nft_policy` / `engage_nft_name`.** Validator `engage_nft.ak` đã bị
> XOÁ; handler `mint` nằm TRONG chính `consume` (multi-purpose). Policy của thread NFT
> **chính là script hash của `consume` sau khi apply 7 param** — biết qua tự tham chiếu,
> không bake hash lẫn nhau (bake 2 chiều = fixed-point blake2b = không deploy được).
> Tên NFT = `blake2b_256(cbor.serialise(seed))` với `seed : OutputReference` bị tiêu trong
> chính tx mint — **KHÔNG phải hằng `454e47`**. Off-chain: `offchain/src/engageId.ts`.

Chuỗi bake TUYẾN TÍNH (không vòng): `price_nft (genesis_ref)` → `price_param (committee,
threshold, price_nft_policy, price_nft_name, ms_per_epoch)` → `consume (…,
price_param_script_hash)`.

Toàn bộ hạ tầng ConsumeMAGIC deploy trong **một script, một tx** (`09_deploy_consume.ts`):
mint price NFT + post PriceParam beacon + mint thread Engage + tạo Engage UTxO + apply-param
consume validator. Hai genesis UTxO riêng (`g1` cho price_nft one-shot, `g2` làm seed đặt
TÊN thread Engage).

```bash
# Bước 0: build Aiken validators
cd /Users/ductiger/Projects/MAGIC/ConsumeMAGIC/onchain
aiken build   # → onchain/plutus.json (3 validator: consume, price_nft, price_param)

# Bước 1: deploy vault InstantGen (prereq — cho VAULT_INSTANT_HASH)
cd /Users/ductiger/Projects/MAGIC/scripts && npm install
npx tsx deploy/05_create_instant_vault.ts

# Bước 2: sinh MAGIC để có cái mà tiêu
# ⛔ ĐANG KẸT — xem cảnh báo ngay dưới khối này. InstantGen chưa cấp được 1 nanogic.
npx tsx test/instant_only.ts

# Bước 3: deploy toàn bộ hạ tầng ConsumeMAGIC (1 tx, 5 việc)
npx tsx deploy/09_deploy_consume.ts
# → in ra block export: PRICE_NFT_POLICY, PRICE_PARAM_SCRIPT_HASH, CONSUME_SCRIPT_HASH,
#   ENGAGE_NFT_POLICY (== CONSUME_SCRIPT_HASH), ENGAGE_NFT_UNIT, ENGAGE_UTXO

# Bước 4: tiêu MAGIC thật (co-spend Engage + vault BurnBatch)
npx tsx test/consume_only.ts
# Expected: vault.magic_batches GIẢM đúng required, consumed_count tăng đúng op_count
```

> ⛔ **Bước 2 hôm nay KHÔNG chạy được — chuỗi e2e đang đứt ở đây.**
>
> `test/instant_only.ts` sẽ fail ở `expect grant > 0`. Không phải lỗi của script: trần thứ
> ba của InstantGen là `compute_cap_pp(schedules) = Σ(gen_schedules) / 2`
> (`InstantGen/onchain/lib/magiclamp/protocol/math.ak`), mà vault Instant luôn có
> `gen_schedules = []` ⇒ trần **0** ⇒ `min3(...) = 0`. Đây là fail-closed có chủ ý, không
> phải thứ đi vòng được bằng env hay tham số. Trạng thái:
> [`DevStatus.md`](../DevStatus.md) — "Còn nợ" #6 và "Chờ chủ nhân chốt" D1.
>
> **Đường thay thế duy nhất để có MAGIC mà tiêu:** ScheduleGen — deploy vault Schedule
> (`deploy/07_create_schedule_vault.ts`), rồi commit + fire
> (`npm run test:schedule-commit` → `npm run test:schedule-fire`). Cửa Schedule đang dùng được.
>
> Nhưng **chưa cắm thẳng vào được**: `09_deploy_consume.ts` hôm nay ghim vault Instant —
> nó ném lỗi nếu thiếu `VAULT_INSTANT_HASH`, và đặt cứng `BURN_BATCH_CONSTR = 2n`
> (constr `BurnBatch` của `VaultRedeemer` InstantGen). Muốn consume từ vault Schedule thì
> phải truyền `vaultScriptHash` = hash vault Schedule **và** constr `BurnBatch` của
> `VaultRedeemer` ScheduleGen vào `consumeParams` — hai giá trị này vào apply-param, sai
> một cái là ra **sai script hash**, tức sai địa chỉ Engage, và không có gì báo. Đối chiếu
> bằng `cd scripts && npm run check:params` trước khi deploy.
>
> **Cái gì gãy nếu bám bản cũ:** người mới đọc sẽ ngồi debug credential / Blockfrost /
> min-ADA cho một bước không bao giờ xanh, vì bản cũ liệt nó như bước thường.

**Chạy cả 4 bước nối env tự động** — `scripts/run_consume_e2e.sh` làm đúng chuỗi trên và
truyền env giữa các bước qua stdout (nên **cũng đứt ở bước 2** vì lý do trên):

```bash
cd /Users/ductiger/Projects/MAGIC
AGENT_SECRETS=<đường dẫn .env của hệ agent> bash scripts/run_consume_e2e.sh Preview   # hoặc Preprod
```

**Secret** (`BLOCKFROST_KEY`, seed ví deploy) đọc từ `$AGENT_SECRETS`, KHÔNG đặt trong
`scripts/.env` — `detect_deploy_wallet.ts` tự dò tên biến seed và chỉ dùng giá trị, không in ra.

**Knob (env, có default — xem `09_deploy_consume.ts:16-20`):**

```
NETWORK=Preview              # Preview | Preprod
VAULT_INSTANT_HASH=<hash>    # BẮT BUỘC — sinh ra ở bước 1
MAX_PRICE_STALE=1            # epoch giá được phép cũ. Baked vào consume hash
PRICE_COMMITTEE=<pkh,pkh>    # default = ví deploy
PRICE_THRESHOLD=1            # M-of-N committee
PRICE_DEMAND_MULT=1000000000 # Q-format, default 1.0×
```

Hằng số baked trong script, không phải env: `PRICE_NFT_NAME=5052494345` ("PRICE"),
`BURN_BATCH_CONSTR=2` (InstantGen).

> **KHÔNG còn** `MAGIC_POLICY_ID` / `MAGIC_ASSET_NAME` (v1 mint — model v2 không mint
> MAGIC). **KHÔNG còn** `ENGAGE_NFT_NAME=454e47`: tên thread NFT là
> `blake2b_256(cbor(seed))`, sinh ra tại thời điểm mint theo UTxO seed, không đặt tay
> được. `PRICE_NFT_POLICY` sinh ở bước 3 (one-shot); `ENGAGE_NFT_POLICY` **không phải
> một policy riêng** — nó BẰNG `CONSUME_SCRIPT_HASH`.

### 1.1 Mint thread Engage cho app khác (sau khi hạ tầng đã deploy)

Thread NFT là **permissionless, N thread / 1 policy** — mỗi app/ví tự đúc thread riêng
bằng seed UTxO của mình, không cần committee. Off-chain: `buildMintEngageTx`
(`offchain/src/consume.ts`), tx **RIÊNG**, KHÔNG gộp với tx consume (C-CM-8).

```ts
import { buildMintEngageTx } from "@magiclamp/consumemagic";

const { tx, engageNftUnit, engageAddress, genesisDatum } = await buildMintEngageTx({
  lucid, consumeScript,          // ĐÃ apply 7 param
  seedUtxo,                      // UTxO của ví, bị TIÊU trong chính tx này (one-shot)
  ownerPkh,                      // phải ký tx — validate_mint_engage_id ép
  didCommit: "",                 // MVP rỗng; đặt 1 LẦN ở đây, IMMUTABLE sau đó
  network,
});
```

Genesis SẠCH: `consumed_count = 0`, `consumed_nanogic = 0`, `last_epoch = 0`
(`last_epoch` là "epoch consume gần nhất", **không** phải epoch hiện tại).

---

## 2. Test plan

### 2.1 Positive tests (≥ 3)

| # | Test | Điều kiện vào | Kết quả mong đợi |
|---|---|---|---|
| P1 | Happy — 1 Engage + 1 vault, op_type=1, op_count=1 | `Σburns = 10_000_000`, demand=Q, stale=0 | tx accepted; `consumed_count` +1; value Engage bảo toàn |
| P2 | 2 Engage / 2 vault PHÂN BIỆT, mỗi vault burn 10M | `total_required=20M == total_burned=20M` | tx accepted; 2 output@engage, Σconsumed +2 |
| P3 | 2 Engage share 1 vault, burn ĐỦ 20M | `Σburns=20M == total_required=20M` | tx accepted; batching hợp lệ |
| P4 | Op_type=2 (CID) | `Σburns = 1_000_000`, demand=Q | tx accepted; 1 CID op ghi state |
| P5 | Value preservation — Engage UTxO có ADA + token lạ | ADA+TOK giữ nguyên ở output@engage | tx accepted; ADA và TOK không bị drain |

### 2.2 Negative tests (≥ 5)

| # | Test | Điều kiện vi phạm | Invariant | Kết quả |
|---|---|---|---|---|
| N1 | Under-burn | `Σburns = 9_999_999 < required=10_000_000` | C-CM-2 (`==`) | tx rejected |
| N1b | Over-burn (accounting CẤM) | `Σburns = 10_000_001 > required` | C-CM-2 (`==`, KHÔNG `≥`) | tx rejected |
| N2 | Drain ADA | output@engage ADA = 2 thay vì 100 | C-CM-1 | tx rejected |
| N3 | Beacon NFT giả | beacon UTxO không mang price NFT (qty=0) | C-CM-2 (auth) | tx rejected |
| N4 | Stale price | `cur_epoch=10`, `pp.epoch=1`, `max_stale=5` | C-CM-5 | tx rejected |
| N5 | Multi-engage share vault under-charge | 2 Engage chung 1 vault burn 10M (cần 20M) | C-CM-2 (aggregate) | tx rejected |
| N6 | Output collapse — burn đủ, 2 input → 1 output | 2 Engage input, 1 output@engage | C-CM-3 (W-CM-8) | tx rejected |
| N7 | Thread token drain | 2 input (Σnft=2), 1 output có NFT (Σnft_out=1) | C-CM-3 (W-CM-9) | tx rejected |
| N8 | State under-count | 2 input, 2 output, chỉ 1 output tăng consumed | C-CM-4 (W-CM-12) | tx rejected |
| N9 | Op_type không tồn tại (42) | op_type=42, không có trong PriceParam | C-CM-2 (bảng giá) | tx rejected |
| N10 | Wrong vault constr | vault redeemer constr ≠ burn_batch_constr | C-CM-2 (linkage) | tx rejected |
| N11 | base_price âm trong beacon | beacon datum `base_price=-1` | C-CM-2 (valid_param) | tx rejected |
| N12 | Beacon epoch rollback | committee post `out_epoch ≤ in_epoch` | W-PP-4 (price_param) | tx rejected |
| N13 | Committee insufficient | chỉ 1 trong 2 chữ ký committee | W-PP-3 (price_param) | tx rejected |
| N14 | Drain token khác khỏi Engage | output@engage TOK = 2 thay vì 5 | C-CM-1 | tx rejected |
| N15 | Validity-range gaming — upper vô hạn | `interval.after` (upper = +∞) | get_epoch (vá BLOCK) | tx rejected |
| N16 | Validity-range gaming — under-state epoch | cửa sổ rộng > 1 epoch (lower quá khứ) | get_epoch (vá BLOCK) | tx rejected |
| N17 | Cửa sổ cưỡi ranh giới epoch | `lo` cuối epoch e, `hi` đầu epoch e+1 | get_epoch (`⌊lo/mspe⌋ == ⌊hi/mspe⌋`) | tx rejected |
| N18 | Genesis bẩn — `consumed_nanogic` bịa | mint thread với `consumed_nanogic = 1e18` | C-CM-7 | tx rejected |
| N19 | Genesis không neo địa chỉ | NFT đúc về ví thay vì địa chỉ script consume | C-CM-7 | tx rejected |
| N20 | Under-count GIÁ TRỊ | 2 output@engage, Σ`consumed_nanogic` thiếu | C-CM-6 | tx rejected |
| N21 | Bảng giá không sắp xếp / trùng `op_type` | `op_prices` = `[{2,…},{1,…}]` | `valid_param` (tăng ngặt) | tx rejected |
| N22 | Bảng giá > 16 dòng | 17 dòng `op_prices` | `valid_param` (`max_op_prices`) | tx rejected |

Số test (aiken / offchain / pricing) KHÔNG ghi ở đây — nó hết hạn ngay commit sau và
bản chép tay ở tệp này từng lệch thật. Nguồn duy nhất: [`DevStatus.md`](../DevStatus.md),
hoặc chạy thẳng lệnh ở §3.

---

## 3. Chạy tests

```bash
# Aiken onchain tests (yêu cầu aiken >= 1.1.0)
cd /Users/ductiger/Projects/MAGIC/ConsumeMAGIC/onchain
aiken check   # chạy tất cả test trong validators/ + lib/

# TypeScript pricing tests
cd /Users/ductiger/Projects/MAGIC/ConsumeMAGIC/pricing
npm install && npm test

# TypeScript offchain (codec round-trip + builder typecheck)
cd /Users/ductiger/Projects/MAGIC/ConsumeMAGIC/offchain
npm install && npm test           # số ca: xem DevStatus.md
npm run typecheck                 # tsc --noEmit: types.ts + engageId.ts + consume.ts + index.ts
```

> ⚠ `offchain` typecheck đọc **types của `pricing` từ `pricing/dist/`** (`package.json`
> field `types`), mà `dist/` bị gitignore. Thêm/đổi export trong `pricing/src/price.ts`
> mà chưa `cd ../pricing && npm run build` ⇒ `tsc` báo `TS2305: has no exported member`
> dù mã nguồn đúng. `npm install` trong `pricing` cũng chạy `prepare` → build.

---

## 4. Known limits (v2)

| Giới hạn | Mô tả | Tác động |
|---|---|---|
| e2e Preview chưa chạy live | `buildConsumeTx` đã viết + typecheck sạch; codec P8 round-trip pass; chưa submit tx thật lên Preview (cần BLOCKFROST_KEY + ví funded) | Trước mainnet: chạy bước 6 e2e thật, verify `consumed_count` + `magic_batches` on-chain |
| `consumeBuilder` không tự dựng vault BurnBatch redeemer | constr index khác per-vault → caller truyền `vaultBurnRedeemerCbor` (tránh coupling type cross-module) | Đúng thiết kế; tích hợp app phải dựng redeemer vault đúng module |
| `ms_per_epoch` network-param | Preview `86_400_000`; MAINNET `432_000_000` (5 ngày) | Apply đúng giá trị khi deploy mainnet (param consume validator + builder network) |
| committee = static list | Governance committee thay đổi cần re-deploy `price_param.ak` | v-next: multi-sig dynamic / governance NFT (trước khi khoá mainnet) |
| `PRICE_THRESHOLD=1` cho phép **chặn dịch vụ nhắm đúng một người** | `price_param.ak` chỉ đòi `count_sigs(committee, extra_signatories) >= threshold`, mặc định ngưỡng 1 (§1 knob). Beacon `PriceParam` là **reference input** của mọi tx Consume ⇒ một khoá committee thấy tx nạn nhân đang tham chiếu beacon hiện tại có thể chèn một `PostPrice` hợp lệ ngay trước: beacon bị chi, reference input biến mất, tx nạn nhân invalid từ gốc. Lặp lại không giới hạn, không cần chạm khoá hay danh tính nạn nhân | Với `op_type` thương mại là phiền. Với `op_type=7 did.rotate` (xoay khoá sau khi nghi lộ) là **chặn quyền tự vệ**. Điều kiện W2 do PhoenixKey đặt: committee phải hơn 1-of-N trước khi `did.rotate` lên mainnet. Phát hiện: Phoenix, thư 2026-08-10 |
| `max_price_stale` mainnet | 1 epoch mainnet = 5 ngày → stale=1 đã là 5 ngày trễ giá | Đặt ≤ 1-2 epoch + keeper offchain post demand_mult mỗi epoch (v-next) |
| `did_commit` MVP rỗng | append-only, chưa bind DID PhoenixKey sinh trắc | Governance C1/C3 attribution chưa thực thi — known-limit, không giả định đã bind |

---

## 5. v-next

| Hạng mục | Trạng thái / Mô tả |
|---|---|
| `buildConsumeTx` TypeScript | ✅ ĐÃ LÀM (`offchain/src/consume.ts`): đọc PriceParam ref-input, tính `required`, co-spend Engage+vault, validity-range chặt ≤1 epoch, KHÔNG mint |
| Engage thread NFT | ✅ ĐÃ LÀM — nhưng KHÔNG phải validator riêng: handler `mint` nằm TRONG `onchain/validators/consume.ak` (policy = chính script hash, biết qua tự tham chiếu). Không còn tệp `engage_nft.ak` |
| Offchain codec | ✅ ĐÃ LÀM (`offchain/src/types.ts`): EngageDatum **5 trường**/PriceParam/ConsumeRedeemer/**EngageMintRedeemer** khớp constr 0 + test round-trip P8. Tên thread NFT: `offchain/src/engageId.ts` |
| Cổng bảng giá off-chain | ✅ ĐÃ LÀM (`pricing/src/price.ts:assertValidPriceParam` + `toCanonicalOpPrices`) — bản gương `valid_param`, chạy TRƯỚC khi post beacon, ném `PRICE-010..015` |
| `09_deploy_consume.ts` khai `EngageDatumSchema` tại chỗ | ✅ ĐÃ LÀM — khối khai tạm đã xoá; `scripts/deploy/09_deploy_consume.ts` nay `import { encodePriceParam, EngageDatumSchema }` thẳng từ `ConsumeMAGIC/offchain/src/types.js`. Một datum một lược đồ; hai bản là thứ trôi khỏi nhau trong im lặng |
| Keeper cập nhật demand_mult | Tương tự UMKeeper: đọc `ops_served_epoch`, tính FIR, post PriceParam mới (committee/keeper) — TRƯỚC mainnet |
| E2E Preview script live | Tạo Engage genesis → consume thật → verify `consumed_nanogic` (+ `consumed_count`) và `magic_batches` vault giảm đúng on-chain (cần credential) |
| committee → governance NFT động | Thay static list bằng multi-sig/NFT trước khi khoá mainnet |
| `did_commit` ↔ DID PhoenixKey | blake2b256 commitment bind engagement ↔ DID sinh trắc (Governance C1/C3) |
| Tích hợp OriLife app | App đọc **delta `consumed_nanogic`** của EngageDatum (giá trị datum SAU tx trừ giá trị TRƯỚC tx) để xác nhận thanh toán — xem cảnh báo ngay dưới bảng |

### ⚠ Xác nhận thanh toán: đọc GÌ của EngageDatum

**KHÔNG đọc `consumed_count`.** Nó đếm **LƯỢT**, không mang giá trị. Ai trả tiền một op
rẻ (`op_type=2`, CID, 1e6 nanogic) cũng làm `consumed_count` tăng đúng +1 — rồi đòi app
cấp một op đắt (`op_type=1`, ảnh, 1e7). Trả thiếu 10×, mà mọi bất biến on-chain vẫn thoả.

**KHÔNG đọc giá trị TUYỆT ĐỐI** của `consumed_nanogic` như "hạn mức còn lại". Nó là tổng
tích luỹ đời thread, chỉ có ý nghĩa khi so hai mốc.

**ĐỌC delta `consumed_nanogic`**: lấy `EngageDatum` ở UTxO **trước** tx và ở UTxO **sau**
tx của cùng thread; `delta = sau − trước`. Cấp dịch vụ khi `delta ≥ giá niêm yết của
nghiệp vụ đang phục vụ`. Validator đã ép `Σ consumed_nanogic(out) == Σ(in) + total_required`
(TECH.md W-CM-12), nên delta chính là số nanogic đã thực trả trong tx đó.
