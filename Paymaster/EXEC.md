# Paymaster — EXEC (build, deploy, test)

## GenMAGIC v3.3 · Module Paymaster · v1.0

Nguồn: `Paymaster/onchain/`, `Paymaster/offchain/`; mẫu `ConsumeMAGIC/EXEC.md`.

---

## 1. Build + test (đã verify)

```bash
# Onchain — Aiken validators (28 tests pass, exit 0)
cd Paymaster/onchain && aiken check
# → 28× "status": "pass"

# Offchain — TypeScript SDK (21 tests pass)
cd Paymaster/offchain && npm install && npm test
# → Tests  21 passed (21)

# Typecheck builder (Lucid types)
cd Paymaster/offchain && npx tsc --noEmit   # exit 0
```

Verify đã chạy thật:
- `aiken check` → `grep -c '"status": "pass"'` = **28**.
- `npm test` → **21 passed (21)**.
- `npx tsc --noEmit` → **exit 0**.
- `grep -rn '\.mint' --include='*.ak' --include='*.ts'` (trừ build) → **chỉ comment + NFT one-shot `MintGenesis`**, KHÔNG mint MAGIC.

---

## 2. Deploy steps (thứ tự bắt buộc — phụ thuộc forward)

```bash
# Bước 0: build validators
cd Paymaster/onchain && aiken build   # → plutus.json (đọc hash)

# Bước 1: deploy policy_nft (one-shot minting policy — SponsorPolicy beacon NFT)
#   genesis_ref RIÊNG → ghi POLICY_NFT_POLICY_ID; name = 504f4c ("POL")

# Bước 2: deploy meter_nft (one-shot — thread NFT neo SponsorMeter)
#   genesis_ref RIÊNG → ghi METER_NFT_POLICY_ID; name = 4d4554 ("MET")

# Bước 3: deploy protocol_nft (one-shot — ProtocolFeeParams beacon NFT)
#   genesis_ref RIÊNG → ghi PROTOCOL_NFT_POLICY_ID; name = 50524f ("PRO")

# Bước 4: apply 9 param vào paymaster validator → PAYMASTER_SCRIPT_HASH
#   vault_script_hash    = hash generator vault muốn sponsor (vd InstantGen)
#   burn_batch_constr    = constr BurnBatch của vault đó (Instant=2/Snapshot=1/Vacuum=4/Schedule=2)
#   lamp_policy_id, policy_nft_policy, meter_nft_policy, protocol_nft_policy
#   max_policy_stale (vd 10), max_did_entries (vd 64), ms_per_epoch (Preview=86_400_000)

# Bước 5: DAO post SponsorPolicy beacon (mint 1 policy NFT)
#   datum: app_id, app_authority=<vkh App>, max_per_did/global, lamp_per_magic_q≥sàn, ada_per_magic_q,
#          oracle_nft_policy=None (MVP), epoch=<hiện tại>

# Bước 6: DAO post ProtocolFeeParams beacon (mint 1 protocol NFT)
#   datum: min_lamp_per_magic_q=<sàn>, protocol_fee_active=<bool>, epoch=<hiện tại>

# Bước 7: App khởi tạo SponsorMeter UTxO (mint 1 meter NFT)
#   datum: app_id, epoch=<hiện tại>, did_lamp_map=[], global_lamp_epoch=0

# TIỀN ĐỀ user (ngoài Paymaster): user đặt App làm personal_delegate qua SetDelegate của vault.
```

---

## 3. Test plan

### 3.1 Đã có (28 onchain + 21 offchain)

- **Onchain** (`paymaster.ak:290-901`): 4 happy + 15+ negative phủ PM-1..PM-17 + 6 math vectors.
- **Offchain** (`tests/paymaster.test.ts`):
  - P8 codec (8 test): roundtrip SponsorPolicy/Meter/ProtocolFeeParams/Sponsor redeemer + kiểm tra index Constr runtime + thứ tự field + Bool tag + oracle Some/None.
  - Math (7 test): TV-PM-PRICE-01/02 + unit/zero/floor/overflow-safe + q==1e9.
  - Meter state (6 test): sumBurns, lookupDid hit/miss, addDid append/cộng-dồn, state transition khớp validator, dedup magic_consumed.

### 3.2 E2E live Preview (chưa chạy — chờ credential + vault deploy)

1. Deploy theo §2 → điền `.env`.
2. User đặt App delegate (vault module SetDelegate).
3. `buildSponsorTx`: Meter UTxO + 1 InstantGen vault (BurnBatch CBOR) + 2 beacon ref → App ký → submit.
4. Verify on-chain: vault `current_amount` giảm = `magic_consumed`; Meter `global_lamp_epoch` += `lamp_this`; Meter NFT + ADA bảo toàn.
5. Negative live: budget cạn (lamp_this > cap) → tx reject; App không phải delegate → reject.

---

## 4. Gap còn lại (v1.x)

- **Settlement value-check on-chain**: validator chưa ép App THỰC SỰ chuyển LAMP/ADA `lamp_this`/`ada_this` tới user (param `lamp_policy_id` giữ sẵn, `paymaster.ak:49`). MVP: kế toán Meter; App settlement do tx App tự dựng + trust App cosign. v1.x thêm guard value.
- **Deploy scripts** (`scripts/deploy/*paymaster*.ts`) + **e2e runner** chưa viết — chỉ có spec EXEC + builder SDK.
- **Oracle giá** (CIP-31): `oracle_nft_policy` field đã có, logic chưa.
- **AppEconomics reward payout**: module riêng.
