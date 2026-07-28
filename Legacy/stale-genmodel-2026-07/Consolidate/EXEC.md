# EXEC — ConsolidateHoldings (§6.9)
GenMAGIC v3.3 · Deploy + Test Plan

---

## 1. Deploy steps (có thứ tự + env vars)

### Bước 0 — Chuẩn bị môi trường

```bash
# Kiểm tra env (scripts/.env)
cat scripts/.env | grep -E "BLOCKFROST_KEY|PRIVATE_KEY|NETWORK|LAMP_POLICY_ID"
# NETWORK phải = Preview
# LAMP_POLICY_ID phải đã có (từ deploy:lamp trước đó)
```

### Bước 1 — Build + apply params Aiken validator

`vault_consolidate` nhận 2 param THEO THỨ TỰ: `(lamp_policy_id: PolicyId, ms_per_epoch: Int)`.

- `lamp_policy_id` — PolicyId của LAMP native asset (= `LAMP_POLICY_ID` trong `.env`).
  BẮT BUỘC apply ĐÚNG giá trị mạng: value-leak guard bind LAMP token thật trong
  vault output theo policy này. Sai policy → hash sai → guard vô hiệu.
- `ms_per_epoch` — POSIX-ms/epoch: Preview/Preprod `86_400_000`, Mainnet `432_000_000`.

```bash
cd /Users/ductiger/Projects/MAGIC/Consolidate/onchain
aiken build
# Tạo: plutus.json (validator CHƯA apply param — còn 2 tham số tự do)
```

Apply param khi build tx (Lucid `applyParamsToScript`) hoặc dùng `aiken blueprint apply`:
```bash
# Apply lamp_policy_id rồi ms_per_epoch (đúng thứ tự khai báo validator)
aiken blueprint apply -v vault_consolidate.spend <LAMP_POLICY_ID_cbor>   > /tmp/c1.json
aiken blueprint apply -m /tmp/c1.json <MS_PER_EPOCH_cbor>                > /tmp/c2.json
# Đọc hash đã apply → điền CONSOLIDATE_SCRIPT_HASH vào scripts/.env
cat /tmp/c2.json | jq -r '.validators[] | select(.title == "vault_consolidate.spend") | .hash'
```

Hoặc lấy hash chưa-apply (nếu offchain tự apply param qua Lucid):
```bash
cat plutus.json | jq -r '.validators[] | select(.title == "vault_consolidate.spend") | .hash'
```

Điền vào `scripts/.env`:
```
CONSOLIDATE_SCRIPT_HASH=<hash từ lệnh trên>
```

### Bước 2 — Install offchain dependencies

```bash
cd /Users/ductiger/Projects/MAGIC/Consolidate/offchain
npm install
```

### Bước 3 — Chạy test suite

```bash
npm test
# Kỳ vọng offchain: 12/12 pass
# Onchain (cd ../onchain && aiken check): 21/21 pass, 0 warning
#   gồm value-leak/ADA-drain/token-stuffing/output-restake guards (MAINNET-BLOCK)
```

### Bước 4 — Deploy script (nếu có tx deploy)

ConsolidateHoldings là redeemer của vault script chính. Không cần deploy contract riêng nếu vault script đã live. Nếu vault chưa deploy:

```bash
cd /Users/ductiger/Projects/MAGIC/scripts
npm run deploy:vault
# → Ghi VAULT_SCRIPT_HASH vào .env
```

### Bước 5 — Verify trên Preview

```bash
# Tạo vault test (dùng deploy script hoặc tx thủ công)
# Thực hiện vài giao dịch để tạo fragmentation (≥ 2 holdings gần epoch)
# Chạy consolidate:
cd scripts && npx tsx src/consolidate_tx.ts
# Verify trên explorer:
echo "https://preview.cardanoscan.io/transaction/<TX_HASH>"
```

---

## 2. Test plan

### 2a. Positive tests (≥ 3)

| ID | Mô tả | Input | Kỳ vọng | Nguồn |
|---|---|---|---|---|
| TP-01 | TV-CONSOLIDATE-01: cascade merge 3 locked entries | `[{1,5,L},{1,6,L},{1,7,L}]` | `[{2,5,L},{1,7,L}]` — 2 entries, Σ=3, Σ_L=3 | `consolidate.test.ts:19-33` |
| TP-02 | TV-CONSOLIDATE-02: mixed locked/unlocked, P8 determinism | `[{1,5,L},{1,6,U},{1,6,L},{1,7,U}]` | `[{2,5,L},{2,6,U}]`, 3 permutation inputs → cùng output | `consolidate.test.ts:40-83` |
| TP-03 | TV-CONSOLIDATE-03: consolidate + fire giữ C-VAULT-9 | `[{1000,50,L},{500,51,L},{200,60,U}]`, lamp_locked=1500 | Sau merge: `[{1500,50,L},{200,60,U}]`; sau fire λ=200: `{1300,50,L}`, C-VAULT-9 intact | `consolidate.test.ts:88-121` |
| TP-04 | Large scenario 20 entries | 20 entries xen kẽ locked/unlocked | Σ bảo toàn | `consolidate.test.ts:169-177` |
| TP-05 | Onchain happy path: 3→2 holdings | `[{100,5,F},{50,5,F},{30,9,T}]` | Accept tx | `vault_consolidate.ak:184-191` |

### 2b. Negative tests (≥ 5)

| ID | Mô tả | Input/điều kiện | Kỳ vọng | Nguồn |
|---|---|---|---|---|
| TN-01 | Profile tamper: Flame→Ember trong output | Output.profile = Ember ≠ Flame | Validator reject (W-11) | `vault_consolidate.ak:195-202` |
| TN-02 | Streak tamper: reset streak 7→0 | Output.streak_state.current_streak = 0 ≠ 7 | Validator reject (W-17) | `vault_consolidate.ak:205-212` |
| TN-03 | Double-satisfaction qua stake credential | 2 vault inputs: `ScriptAddr(hash,None)` và `ScriptAddr(hash,stakeKey)` | count_inputs_at_script = 2 → reject (W-2) | `vault_consolidate.ak:216-235` |
| TN-04 | Conservation vỡ: rút lén 50 LAMP | Output holdings sum = 100 ≠ 150 | Reject (W-21) | `vault_consolidate.ak:238-245` |
| TN-05 | Không giảm entries | `|output| = |input| = 1` | Reject (W-20) | `vault_consolidate.ak:248-255` |
| TN-06 | Owner không ký | `extra_signatories = []` | Reject (W-1) | `vault_consolidate.ak:258-265` |
| TN-07 | C-CONSOLIDATE-1: locked + unlocked KHÔNG merge (cùng epoch) | `[{100,5,L},{100,5,U}]` → output vẫn 2 entries | `canConsolidate` trả False; không build tx | `consolidate.test.ts:130-136` |
| TN-08 | epoch_diff = 2: không merge | `[{100,5,L},{100,7,L}]` | Output vẫn 2 entries | `consolidate.test.ts:143-146` |

---

## 3. Known limits

| Giới hạn | Giá trị | Nguồn |
|---|---|---|
| `MAX_LOYALTY_HOLDINGS` | 64 | `README.md:8`; CLAUDE.md hard limits |
| Ngưỡng gợi ý consolidate | ≥ 50 holdings | `README.md:12` |
| Số pass tối đa `mergeGroup` | ≤ ⌊n/2⌋ | T23 convergence; `consolidate.ts:7` |
| ExUnit exhaustion risk | Khi holdings tiến gần 64 | A5; `README.md:8-9` |
| `epoch_diff` tối đa để merge | 1 | `README.md:21`; `consolidate.ts:62` |
| Redeemer chấp nhận | Chỉ `Consolidate` | `vault_consolidate.ak:101-103` |
| Thay đổi field cho phép | Chỉ `loyalty_holdings` | 16 field khoá (W-4..W-19) |

---

## 4. v-next (việc cần làm tiếp)

| Mục | Ưu tiên | Ghi chú |
|---|---|---|
| Compile Aiken và verify `aiken check` sạch | Cao | Chưa có CI chạy Aiken; cần thêm vào `.github/workflows/` |
| Test e2e trên Preview testnet | Cao | Cần BLOCKFROST_KEY + ví test có LAMP fragmented |
| Tích hợp vào deploy script `scripts/` | Trung bình | Hiện chưa có `consolidate_tx.ts` trong `scripts/src/` |
| Wallet UI: gợi ý khi `|holdings| ≥ 50` | Trung bình | Cần offchain SDK expose `canConsolidate` qua public API |
| Thêm `epoch_diff` tối đa làm tham số config | Thấp | Hiện hardcode = 1; có thể nới cho merge epoch_diff ≤ 2 với bảo thủ LF tương ứng |
| Audit: kiểm tra C-VAULT-9 với ScheduleGen lock/unlock | Thấp | Sau consolidate, lamp_locked phải phản ánh đúng Σ_L holdings |
