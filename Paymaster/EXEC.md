# Paymaster — EXEC (build, deploy, test)

## GenMAGIC v3.3 · Module Paymaster · v1.0

Nguồn: `Paymaster/onchain/`, `Paymaster/offchain/`; mẫu `ConsumeMAGIC/EXEC.md`.

> ⚠ **Ba điều phải biết trước khi đụng vào Paymaster** (chi tiết ở §2):
> 1. `validator paymaster(...)` nhận **11** tham số, không phải 9.
> 2. Paymaster **chưa có script deploy** trong `scripts/deploy/`.
> 3. Cổng đối chiếu tham số: `cd scripts && npm run check:params`.

---

## 1. Build + test

```bash
# Onchain — Aiken validators
cd Paymaster/onchain && aiken check

# Offchain — TypeScript SDK
cd Paymaster/offchain && npm install && npm test

# Typecheck builder (Lucid types)
cd Paymaster/offchain && npx tsc --noEmit   # exit 0
```

Số ca test KHÔNG chép về đây — nguồn duy nhất: [`DEVSTATUS.md`](../DEVSTATUS.md), hoặc chạy
lệnh trên. Bản trước chép cứng con số vào tệp này và nó là thứ trôi khỏi mã trong im lặng.

Kiểm thêm (chạy được ngay, không cần credential):
- `npx tsc --noEmit` → **exit 0**.
- `grep -rn '\.mint' --include='*.ak' --include='*.ts'` (trừ build) → chỉ comment + NFT
  one-shot `MintGenesis`, **KHÔNG** mint MAGIC.
- `cd scripts && npm run check:params` → đối chiếu danh sách apply-param với blueprint.

---

## 2. Deploy steps (thứ tự bắt buộc — phụ thuộc forward)

> ⛔ **Paymaster CHƯA có script deploy.** Không có tệp nào trong `scripts/deploy/` dựng
> Paymaster (chuỗi hiện có: `01, 02, 03, 05, 07, 08, 09`). Các bước dưới là **mô tả việc phải
> làm**, không phải lệnh chạy được. Ai viết script đầu tiên phải qua cổng đối chiếu tham số
> trước khi ký bất cứ tx nào:
>
> ```bash
> cd scripts && npm run check:params    # case Paymaster đã có sẵn trong check_param_names.ts
> ```
>
> Cổng này được thêm **trước** cái nó gác, cố ý: `paymaster.ts` từng mô tả "đã apply 9 param"
> trong khi validator nhận **11**, và hai cái thiếu đúng là hai bản vá SEC-01 mới nhất
> (`treasury_addr` + `lamp_asset_name`). Người tin mô tả cũ sẽ dựng ra một Paymaster vừa gửi
> LAMP đi đâu cũng được, vừa không nhìn thấy LAMP của chính nó.
>
> **Trọng tài là blueprint, không phải bảng tay.** Danh sách dưới đây chép từ
> `Paymaster/onchain/validators/paymaster.ak` lúc viết; thứ đúng lúc bạn đọc là
> `Paymaster/onchain/plutus.json` sau `aiken build`. Sai **thứ tự** hay **thiếu** một param
> đều ra **sai script hash** ⇒ sai địa chỉ ⇒ tiền vào một địa chỉ không ai spend được, mà
> không test nào đỏ và không compile nào gãy.

```bash
# Bước 0: build validators
cd Paymaster/onchain && aiken build   # → plutus.json (đọc hash)

# Bước 1: deploy policy_nft (one-shot minting policy — SponsorPolicy beacon NFT)
#   genesis_ref RIÊNG → ghi POLICY_NFT_POLICY_ID; name = 504f4c ("POL")

# Bước 2: deploy meter_nft (one-shot — thread NFT neo SponsorMeter)
#   genesis_ref RIÊNG → ghi METER_NFT_POLICY_ID; name = 4d4554 ("MET")

# Bước 3: deploy protocol_nft (one-shot — ProtocolFeeParams beacon NFT)
#   genesis_ref RIÊNG → ghi PROTOCOL_NFT_POLICY_ID; name = 50524f ("PRO")

# Bước 4: apply 11 param vào paymaster validator → PAYMASTER_SCRIPT_HASH
#   ĐÚNG THỨ TỰ (đổi thứ tự = sai hash). Đối chiếu blueprint, đừng tin bảng này:
#    1 vault_script_hash    = hash generator vault muốn sponsor (vd InstantGen)
#    2 burn_batch_constr    = constr BurnBatch của vault đó (Instant=2, Schedule=2)
#                             — Snapshot/Vacuum đã ở Legacy/, đừng dùng lại số của chúng
#    3 lamp_policy_id
#    4 policy_nft_policy
#    5 meter_nft_policy
#    6 protocol_nft_policy
#    7 max_policy_stale     (vd 10)
#    8 max_did_entries      (vd 64)
#    9 ms_per_epoch         (Preview = 86_400_000)
#   10 treasury_addr        (SEC-01 — ÉP LAMP đến đúng Treasury; thiếu = LAMP đi đâu cũng được)
#   11 lamp_asset_name      (SEC-01 — tLAMP testnet / LAMP mainnet; KHÔNG hardcode #"744c414d50")

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

### 3.1 Đã có

Số ca: [`DEVSTATUS.md`](../DEVSTATUS.md) hoặc chạy `aiken check` / `npm test` (§1).

- **Onchain** (`paymaster.ak`): happy path + negative phủ PM-1..PM-17 + math vectors.
- **Offchain** (`tests/paymaster.test.ts`):
  - P8 codec: roundtrip SponsorPolicy/Meter/ProtocolFeeParams/Sponsor redeemer + kiểm tra index Constr runtime + thứ tự field + Bool tag + oracle Some/None.
  - Math: TV-PM-PRICE-01/02 + unit/zero/floor/overflow-safe + q==1e9.
  - Meter state: sumBurns, lookupDid hit/miss, addDid append/cộng-dồn, state transition khớp validator, dedup magic_consumed.

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
