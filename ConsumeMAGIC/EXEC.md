# ConsumeMAGIC — EXEC v1 (feat/consume-magic-v1)

## 1. Deploy steps (thứ tự bắt buộc)

Mỗi bước viết output vào `scripts/.env`. Bước sau phụ thuộc env var của bước trước.

```bash
cd /Users/ductiger/Projects/MAGIC/scripts && npm install

# Bước 0: build Aiken validators
cd /Users/ductiger/Projects/MAGIC/ConsumeMAGIC/onchain
aiken build   # → onchain/plutus.json

# Bước 1: deploy price_nft (one-shot minting policy)
# Đọc genesis_ref từ ví (UTXO chưa spend), set trong deploy script
npm run deploy:consume:price-nft
# → ghi PRICE_NFT_POLICY_ID vào scripts/.env

# Bước 2: deploy price_param (beacon spend validator)
npm run deploy:consume:price-param
# → ghi PRICE_PARAM_SCRIPT_HASH vào scripts/.env
# → mint 1 price NFT, post PriceParam beacon epoch=0, demand_mult=1_000_000_000

# Bước 3: deploy consume validator
npm run deploy:consume:vault
# → ghi CONSUME_SCRIPT_HASH vào scripts/.env

# Bước 4: tạo vault UTxO test (engage NFT + EngageDatum rỗng)
npm run deploy:consume:vault-init

# Bước 5: e2e consume
npm run test:consume:e2e
# Expected: MAGIC bị đốt, consumed_count tăng đúng op_count
```

**Env vars cần trước bước 1:**

```
BLOCKFROST_KEY=<preview key>
PRIVATE_KEY=<hex>
NETWORK=Preview
MAGIC_POLICY_ID=<từ generator deploy>
MAGIC_ASSET_NAME=<từ generator>
ENGAGE_NFT_POLICY_ID=<one-shot>
ENGAGE_NFT_NAME=454e47
MAX_PRICE_STALE=5
MS_PER_EPOCH=86400000
COMMITTEE_PKH_1=<hex>
COMMITTEE_PKH_2=<hex>
COMMITTEE_THRESHOLD=2
```

---

## 2. Test plan

### 2.1 Positive tests (≥ 3)

| # | Test | Điều kiện vào | Kết quả mong đợi |
|---|---|---|---|
| P1 | Happy — 1 vault input, op_type=1, op_count=1 | `magic_burned = 10_000_000`, demand=Q, stale=0 | tx accepted; `consumed_count` tăng 1; ADA bảo toàn |
| P2 | Over-burn — đốt dư (1.5× required) | `magic_burned = 15_000_000`, required=10_000_000 | tx accepted; dư được đốt, không hoàn lại |
| P3 | N=2 vault input cùng owner | `magic_burned = 20_000_000`, 2 input × required=10M | tx accepted; 2 output@script, Σconsumed tăng 2 |
| P4 | Op_type=2 (CID) | `magic_burned = 1_000_000`, demand=Q | tx accepted; 1 CID op ghi state |
| P5 | Value preservation — vault có ADA + token lạ | `magic_burned = 10_000_000`; ADA+TOK giữ nguyên ở output | tx accepted; ADA và TOK không bị drain |

### 2.2 Negative tests (≥ 5)

| # | Test | Điều kiện vi phạm | Invariant | Kết quả |
|---|---|---|---|---|
| N1 | Under-burn | `magic_burned = 9_999_999 < required=10_000_000` | C-CM-2 | tx rejected |
| N2 | Drain ADA | output ADA = 2 ADA thay vì 100 ADA | C-CM-1 | tx rejected |
| N3 | Beacon NFT giả | beacon UTxO không mang price NFT (qty=0) | C-CM-2 (auth) | tx rejected |
| N4 | Stale price | `cur_epoch=10`, `pp.epoch=1`, `max_stale=5` | C-CM-5 | tx rejected |
| N5 | Double-satisfaction — 2 input, burn chỉ 1× | `magic_burned=10M`, 2 vault input × 10M each | C-CM-3 | tx rejected |
| N6 | Output collapse — burn đủ, 2 input → 1 output | `magic_burned=20M`, 2 input, 1 output | C-CM-3 (W-CM-8) | tx rejected |
| N7 | Thread token drain | 2 input (Σnft=2), 1 output có NFT (Σnft_out=1) | C-CM-3 (W-CM-9) | tx rejected |
| N8 | State under-count | 2 input, 2 output, chỉ 1 output tăng consumed | C-CM-4 (W-CM-12) | tx rejected |
| N9 | Op_type không tồn tại (42) | op_type=42, không có trong PriceParam | C-CM-2 (bảng giá) | tx rejected |
| N10 | Extra mint entry (LAMP/asset khác trong tx.mint) | `tx.mint` có 2 entries | C-CM-1 | tx rejected |
| N11 | base_price âm trong beacon | beacon datum `base_price=-1` | C-CM-2 (valid_param) | tx rejected |
| N12 | Beacon epoch rollback | committee post `out_epoch ≤ in_epoch` | W-PP-4 (price_param) | tx rejected |
| N13 | Committee insufficient | chỉ 1 trong 2 chữ ký committee | W-PP-3 (price_param) | tx rejected |
| N14 | Drain token khác từ vault | output TOK = 2 thay vì 5 | C-CM-1 (W-CM-10) | tx rejected |

Aiken tests tương ứng nằm trong `consume.ak` cuối file (13 test function, bao phủ N1–N14).
Aiken tests pricing nằm trong `pricing.ak` (9 test function, bao phủ số học giá).
Aiken tests price_param nằm trong `price_param.ak` (4 test function).
Aiken tests price_nft nằm trong `price_nft.ak` (3 test function).

---

## 3. Chạy tests

```bash
# Aiken onchain tests (yêu cầu aiken >= 1.1.0)
cd /Users/ductiger/Projects/MAGIC/ConsumeMAGIC/onchain
aiken check   # chạy tất cả test trong validators/ + lib/

# TypeScript pricing tests
cd /Users/ductiger/Projects/MAGIC/ConsumeMAGIC/pricing
npm install && npm test

# TypeScript offchain + e2e (khi đã có tx-builder)
cd /Users/ductiger/Projects/MAGIC/ConsumeMAGIC/offchain
npm install && npm test
```

---

## 4. Known limits (v1)

| Giới hạn | Mô tả | Tác động |
|---|---|---|
| Tx-builder offchain chưa có | `consumeBuilder` chưa được implement (branch chỉ có pricing + onchain) | Cần bổ sung trước khi e2e Preview |
| Engage NFT minting policy chưa chỉ định | ENGAGE_NFT_POLICY_ID cần one-shot tương tự price_nft | Deploy step 4 cần tạo riêng |
| `ms_per_epoch` hardcoded Preview | `86_400_000 ms` — Mainnet khác (432_000_000 ms / 5 ngày) | Cần tham số hoá khi lên mainnet |
| committee = static list | Governance committee thay đổi cần re-deploy `price_param.ak` | v-next: multi-sig dynamic hoặc governance NFT |
| `max_price_stale = 5` mặc định | Với epoch Preview = 1 ngày: giá có thể cũ 5 ngày | Tuỳ chỉnh qua governance nếu keeper chậm |
| Over-burn không hoàn lại | `magic_burned > required` → phần dư bị đốt, không trả lại | User phải tính đúng `requiredBurn` trước khi submit |

---

## 5. v-next

| Hạng mục | Mô tả |
|---|---|
| `consumeBuilder` TypeScript | Tx-builder đọc PriceParam, tính `requiredBurn`, build + submit tx |
| Engage NFT minting policy | One-shot tương tự `price_nft.ak`, parameterized bởi genesis vault ref |
| Keeper cập nhật demand_mult | Tương tự UMKeeper: đọc `ops_served_epoch`, tính FIR, post PriceParam mới |
| E2E Preview script | Mint MAGIC test → consume thật → verify `consumed_count` + `magic_burned` trên chain |
| Offchain codec PriceParam | `Data.Object` TypeScript khớp constructor index Aiken |
| Tích hợp OriLife app | App component đọc `consumed_count` từ EngageDatum để xác nhận thanh toán |
