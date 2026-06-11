# ConsumeMAGIC — EXEC v2 (engagement-state, rewrite D1)

> Model v2 = ENGAGEMENT-STATE (KHÔNG token-burn). Tiêu MAGIC = co-spend Engage UTxO
> (consume.ak) + vault input (BurnBatch) với `Σburns == required`. KHÔNG `tx.mint`,
> KHÔNG `MAGIC_POLICY_ID`. Mọi tham chiếu mint của v1 đã bỏ.

## 1. Deploy steps (thứ tự bắt buộc)

Mỗi bước viết output vào `scripts/.env`. Bước sau phụ thuộc env var của bước trước.
`consume.ak` parameterized bởi 8 field — `vault_script_hash` + `burn_batch_constr`
khác nhau per-vault (Instant=2/Snapshot=1/Vacuum=4/Schedule=2) → **1 deploy
ConsumeMAGIC / 1 loại vault**.

```bash
cd /Users/ductiger/Projects/MAGIC/scripts && npm install

# Bước 0: build Aiken validators
cd /Users/ductiger/Projects/MAGIC/ConsumeMAGIC/onchain
aiken build   # → onchain/plutus.json (4 validator: consume, price_nft, price_param, engage_nft)

# Bước 1: deploy price_nft (one-shot minting policy — beacon authenticity NFT)
# Đọc PRICE genesis_ref từ ví (UTXO chưa spend), set trong deploy script
npm run deploy:consume:price-nft
# → ghi PRICE_NFT_POLICY_ID vào scripts/.env

# Bước 2: deploy engage_nft (one-shot minting policy — thread NFT neo EngageDatum)
# Đọc ENGAGE genesis_ref RIÊNG (khác PRICE genesis_ref → policy id phân biệt)
npm run deploy:consume:engage-nft
# → ghi ENGAGE_NFT_POLICY_ID vào scripts/.env (name = 454e47 "ENG")

# Bước 3: deploy price_param (beacon spend validator) + post beacon genesis
npm run deploy:consume:price-param
# → ghi PRICE_PARAM_SCRIPT_HASH vào scripts/.env
# → mint 1 price NFT, post PriceParam beacon epoch=<epoch hiện tại>, demand_mult=1_000_000_000

# Bước 4: deploy consume validator (apply 8 param)
#   price_nft_policy/name, engage_nft_policy/name, vault_script_hash,
#   burn_batch_constr, max_price_stale, ms_per_epoch
npm run deploy:consume:vault
# → ghi CONSUME_SCRIPT_HASH vào scripts/.env

# Bước 5: tạo Engage UTxO genesis (mint engage NFT + EngageDatum{consumed_count:0,
#         last_epoch:0, did_commit đặt 1 lần (MVP rỗng), owner})
npm run deploy:consume:engage-init

# Bước 6: e2e consume (co-spend Engage + vault BurnBatch)
npm run test:consume:e2e
# Expected: vault.magic_batches GIẢM đúng required, consumed_count tăng đúng op_count
```

**Env vars cần trước bước 1:**

```
BLOCKFROST_KEY=<preview key>
PRIVATE_KEY=<hex>
NETWORK=Preview
# Vault liên kết (generator vault — module khác). PHẢI khớp param consume validator:
VAULT_SCRIPT_HASH=<payment script hash của generator vault>
BURN_BATCH_CONSTR=2          # Instant=2, Snapshot=1, Vacuum=4, Schedule=2
ENGAGE_NFT_NAME=454e47       # "ENG"
PRICE_NFT_NAME=5052494345    # "PRICE"
MAX_PRICE_STALE=1            # epoch. Mainnet ≤ 1-2 (1 epoch = 5 ngày — xem §4)
MS_PER_EPOCH=86400000        # Preview = 1 ngày. MAINNET = 432000000 (5 ngày)
COMMITTEE_PKH_1=<hex>
COMMITTEE_PKH_2=<hex>
COMMITTEE_THRESHOLD=2
```

> **KHÔNG còn** `MAGIC_POLICY_ID` / `MAGIC_ASSET_NAME` (v1 mint — model v2 không mint
> MAGIC). `ENGAGE_NFT_POLICY_ID` / `PRICE_NFT_POLICY_ID` sinh ra ở bước 1-2 (one-shot).

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

Aiken tests (module): `consume.ak` 24 (N1–N16 + happy + validity-range),
`pricing.ak` 9 (số học giá), `price_param.ak` 4, `price_nft.ak` 3,
`engage_nft.ak` 4 (one-shot) = 44 test module. Tổng `aiken check`: 88 pass, 0 fail,
0 warning (gồm stdlib test). Offchain: 42 vitest pass (31 AppEconomics legacy + 11
codec P8). Pricing: 44 vitest pass.

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
npm install && npm test           # 42 pass (31 legacy AppEconomics + 11 codec P8)
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
| Engage NFT minting policy | ✅ ĐÃ LÀM (`onchain/validators/engage_nft.ak`): one-shot parameterized bởi genesis ref riêng |
| Offchain codec | ✅ ĐÃ LÀM (`offchain/src/types.ts`): EngageDatum/PriceParam/ConsumeRedeemer khớp constr 0 + test round-trip P8 |
| Keeper cập nhật demand_mult | Tương tự UMKeeper: đọc `ops_served_epoch`, tính FIR, post PriceParam mới (committee/keeper) — TRƯỚC mainnet |
| E2E Preview script live | Tạo Engage genesis → consume thật → verify `consumed_count` + `magic_batches` vault giảm on-chain (cần credential) |
| committee → governance NFT động | Thay static list bằng multi-sig/NFT trước khi khoá mainnet |
| `did_commit` ↔ DID PhoenixKey | blake2b256 commitment bind engagement ↔ DID sinh trắc (Governance C1/C3) |
| Tích hợp OriLife app | App component đọc `consumed_count` từ EngageDatum để xác nhận thanh toán |
