# ConsumeMAGIC — EXEC v2 (engagement-state, rewrite D1)

> Model v2 = ENGAGEMENT-STATE (KHÔNG token-burn). Tiêu MAGIC = co-spend Engage UTxO
> (consume.ak) + vault input (BurnBatch) với `Σburns == required`. KHÔNG `tx.mint`,
> KHÔNG `MAGIC_POLICY_ID`. Mọi tham chiếu mint của v1 đã bỏ.

## 1. Deploy steps (thứ tự bắt buộc)

`consume.ak` parameterized bởi 8 field — `vault_script_hash` + `burn_batch_constr`
khác nhau per-vault (Instant=2/Snapshot=1/Vacuum=4/Schedule=2) → **1 deploy
ConsumeMAGIC / 1 loại vault**.

Toàn bộ hạ tầng ConsumeMAGIC deploy trong **một script, một tx** (`09_deploy_consume.ts:52`):
mint price NFT + post PriceParam beacon + mint engage NFT + tạo Engage UTxO + apply-param
consume validator. Hai genesis UTxO riêng (`g1`, `g2`) cho hai one-shot policy phân biệt.

```bash
# Bước 0: build Aiken validators
cd /Users/ductiger/Projects/MAGIC/ConsumeMAGIC/onchain
aiken build   # → onchain/plutus.json (4 validator: consume, price_nft, price_param, engage_nft)

# Bước 1: deploy vault InstantGen (prereq — cho VAULT_INSTANT_HASH)
cd /Users/ductiger/Projects/MAGIC/scripts && npm install
npx tsx deploy/05_create_instant_vault.ts

# Bước 2: sinh MAGIC để có cái mà tiêu
npx tsx test/instant_only.ts

# Bước 3: deploy toàn bộ hạ tầng ConsumeMAGIC (1 tx, 5 việc)
npx tsx deploy/09_deploy_consume.ts
# → in ra block export: PRICE_NFT_POLICY_ID, ENGAGE_NFT_POLICY_ID,
#   PRICE_PARAM_SCRIPT_HASH, CONSUME_SCRIPT_HASH

# Bước 4: tiêu MAGIC thật (co-spend Engage + vault BurnBatch)
npx tsx test/consume_only.ts
# Expected: vault.magic_batches GIẢM đúng required, consumed_count tăng đúng op_count
```

**Chạy cả 4 bước nối env tự động** — `scripts/run_consume_e2e.sh` làm đúng chuỗi trên và
truyền env giữa các bước qua stdout:

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
`ENGAGE_NFT_NAME=454e47` ("ENG"), `BURN_BATCH_CONSTR=2` (InstantGen).

> **KHÔNG còn** `MAGIC_POLICY_ID` / `MAGIC_ASSET_NAME` (v1 mint — model v2 không mint
> MAGIC). `ENGAGE_NFT_POLICY_ID` / `PRICE_NFT_POLICY_ID` sinh ra ở bước 3 (one-shot).

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

Số test (aiken / offchain / pricing) KHÔNG ghi ở đây — nó hết hạn ngay commit sau và
bản chép tay ở tệp này từng lệch thật. Nguồn duy nhất: [`DEVSTATUS.md`](../DEVSTATUS.md),
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
npm install && npm test           # số ca: xem DEVSTATUS.md
npm run typecheck                 # tsc --noEmit: types.ts + consume.ts + index.ts
```

---

## 4. Known limits (v2)

| Giới hạn | Mô tả | Tác động |
|---|---|---|
| e2e Preview chưa chạy live | `buildConsumeTx` đã viết + typecheck sạch; codec P8 round-trip pass; chưa submit tx thật lên Preview (cần BLOCKFROST_KEY + ví funded) | Trước mainnet: chạy bước 6 e2e thật, verify `consumed_count` + `magic_batches` on-chain |
| `consumeBuilder` không tự dựng vault BurnBatch redeemer | constr index khác per-vault → caller truyền `vaultBurnRedeemerCbor` (tránh coupling type cross-module) | Đúng thiết kế; tích hợp app phải dựng redeemer vault đúng module |
| `ms_per_epoch` network-param | Preview `86_400_000`; MAINNET `432_000_000` (5 ngày) | Apply đúng giá trị khi deploy mainnet (param consume validator + builder network) |
| committee = static list | Governance committee thay đổi cần re-deploy `price_param.ak` | v-next: multi-sig dynamic / governance NFT (trước khi khoá mainnet) |
| `max_price_stale` mainnet | 1 epoch mainnet = 5 ngày → stale=1 đã là 5 ngày trễ giá | Đặt ≤ 1-2 epoch + keeper offchain post demand_mult mỗi epoch (v-next) |
| `did_commit` MVP rỗng | append-only, chưa bind DID PhoenixKey sinh trắc | Governance C1/C3 attribution chưa thực thi — known-limit, không giả định đã bind |

---

## 5. v-next

| Hạng mục | Trạng thái / Mô tả |
|---|---|
| `buildConsumeTx` TypeScript | ✅ ĐÃ LÀM (`offchain/src/consume.ts`): đọc PriceParam ref-input, tính `required`, co-spend Engage+vault, validity-range chặt ≤1 epoch, KHÔNG mint |
| Engage thread NFT | ✅ ĐÃ LÀM — nhưng KHÔNG phải validator riêng: handler `mint` nằm TRONG `onchain/validators/consume.ak` (policy = chính script hash, biết qua tự tham chiếu). Không còn tệp `engage_nft.ak` |
| Offchain codec | ✅ ĐÃ LÀM (`offchain/src/types.ts`): EngageDatum/PriceParam/ConsumeRedeemer khớp constr 0 + test round-trip P8 |
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
