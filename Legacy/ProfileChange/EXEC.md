# ProfileChange — EXEC.md
## GenMAGIC v3.3 · §12 · Deploy steps, Test plan, Known limits

---

## 1. Deploy Steps (Preview testnet)

### Thứ tự bắt buộc

ProfileChange validator standalone — không phụ thuộc LAMP/UM/Shard NFT. Chỉ cần vault đã có UTxO.

```
Step 1: Compile Aiken validator
Step 2: Apply tham số ms_per_epoch
Step 3: Deploy vault UTxO (nếu chưa có)
Step 4: Verify hash + test on-chain
```

### Step 1 — Compile

```bash
cd /Users/ductiger/Projects/MAGIC/ProfileChange/onchain
aiken build
# Kết quả: plutus.json
```

Kiểm tra validator xuất hiện trong `plutus.json`:

```bash
jq '.validators[] | .title' ProfileChange/onchain/plutus.json
# → "vault_profile.spend"
```

### Step 2 — Apply tham số + lấy hash

```typescript
// scripts/config.ts hoặc deploy script
import { applyParamsToScript, validatorToScriptHash, Data } from "@lucid-evolution/lucid";
import rawPlutus from "../../ProfileChange/onchain/plutus.json" assert { type: "json" };

const raw = rawPlutus.validators.find(v => v.title === "vault_profile.spend");
const validator = {
  type: "PlutusV3",
  script: applyParamsToScript(raw.compiledCode, [Data.Integer(86_400_000n)]),
};
const VAULT_PROFILE_HASH = validatorToScriptHash(validator);
// → set VAULT_SCRIPT_HASH=<hash> trong scripts/.env
```

### Step 3 — Deploy vault UTxO

Vault UTxO được tạo bởi deploy script tổng (`scripts/deploy/04_deploy_vault.ts`). ProfileChange dùng chung vault UTxO với SnapshotGen/InstantGen.

Env vars cần thiết (`scripts/.env`):
```
BLOCKFROST_KEY=preview...
PRIVATE_KEY=<ed25519 hex>
NETWORK=Preview
VAULT_SCRIPT_HASH=<từ Step 2>
LAMP_POLICY_ID=<từ deploy LAMP>
```

### Step 4 — Smoke test on-chain

```bash
cd /Users/ductiger/Projects/MAGIC/scripts
npx tsx test/profilechange_smoke.ts
# Expected: UpdateProfile tx confirmed, ApplyPending tx confirmed
```

---

## 2. Test Plan

### 2.1 TypeScript unit tests (hiện có)

```bash
cd /Users/ductiger/Projects/MAGIC/ProfileChange/offchain
npm install
npm test
```

File test: `ProfileChange/tests/profile.test.ts` (7 test cases).

Kết quả mong đợi: 7/7 pass.

### 2.2 Aiken on-chain tests

```bash
cd /Users/ductiger/Projects/MAGIC/ProfileChange/onchain
aiken check
# Expected: 8 tests pass (2 happy + 6 reject)
```

Xem chi tiết test trong `vault_profile.ak:209-303`.

### 2.3 Positive tests (≥3)

| # | Mô tả | Input | Expected output |
|---|---|---|---|
| P1 | UpdateProfile happy path | Flame, changed@0, current=5 | pending=Some{Ember,6}, profile=Flame, changed=5 |
| P2 | ApplyPending exact boundary | pending{Ember,6}, current=6 | profile=Ember, pending=None |
| P3 | Cooldown gap = 2 (boundary) | changed=98, current=100 | allowed=true |
| P4 | Apply không ảnh hưởng batches | vault có magic_batches=[...], ApplyPending | magic_batches nguyên vẹn (T4) |
| P5 | Đổi lần 2 sau đủ cooldown | changed=5, current=8 | allowed: 8-5=3 ≥ 2 → pass |

### 2.4 Negative tests (≥5)

| # | Invariant | Tình huống | Expected: fail |
|---|---|---|---|
| N1 | C-PC-V1 | Owner không ký tx UpdateProfile | `expect list.has` fail |
| N2 | C-PC-V2 | gap = 1 (last=4, current=5) | cooldown check fail |
| N3 | C-PC-V3 | new_profile = current (Flame→Flame) | `new_profile != datum.profile` fail |
| N4 | C-PC-V4 | Tamper streak trong UpdateProfile | `all_other_fields_unchanged` fail |
| N5 | W-DS | 2 vault UTxO cùng script hash trong 1 tx | `count_inputs == 1` fail |
| N6 | W-P1 | ApplyPending khi pending = None | `"No pending profile to apply"` |
| N7 | W-P2 | ApplyPending khi effective_epoch > current | `pending.effective_epoch ≤ current` fail |
| N8 | W-P3 | ApplyPending nhưng output.profile ≠ pending.new_profile | `output.profile == pending.new_profile` fail |

### 2.5 Integration test (TypeScript + on-chain mock)

Khi SnapshotGen được gọi sau UpdateProfile:
1. `applyPendingProfile` trả về profile mới.
2. Batch mới dùng profile mới cho N, decay.
3. Batch cũ trong `magic_batches` giữ nguyên `profile_at_creation` (T4).

---

## 3. Known Limits

### 3.1 Cooldown 2 epoch là cứng (không cấu hình được)

`PROFILE_COOLDOWN = 2` hard-code trong cả `vault_profile.ak:32` và `math.ts:5`. Thay đổi yêu cầu re-deploy validator (đổi hash).

### 3.2 Lazy apply không tự kích hoạt

`pending_profile` không tự apply theo thời gian. Nó chỉ apply khi:
1. Vault được touch bởi bất kỳ tx nào gọi `applyPendingProfile` off-chain.
2. User gửi tx `ApplyPending` standalone.

Trong thời gian chờ: `vault.profile` vẫn là profile cũ — ảnh hưởng đến tính toán SnapshotGen/InstantGen nếu chúng không gọi `applyPendingProfile` trước.

### 3.3 profile_changed_epoch không cập nhật khi ApplyPending

Cooldown tính từ lần `UpdateProfile`, không phải lần `ApplyPending`. Sau khi ApplyPending xong, user có thể gọi UpdateProfile ngay nếu đã đủ 2 epoch kể từ lần UpdateProfile cuối.

### 3.4 Không có cơ chế hủy pending

Không có redeemer `CancelPending`. Một khi `pending_profile` đã set, nó tồn tại cho đến khi:
- Được apply (effective_epoch ≤ current).
- Bị ghi đè bởi UpdateProfile mới (nếu cooldown đã đủ).

### 3.5 ms_per_epoch phải khớp chính xác với network

Dùng sai `ms_per_epoch` (ví dụ: mainnet value `432_000_000` trên Preview) sẽ tính sai epoch — validator có thể chặn tx hợp lệ hoặc cho phép tx sai cooldown. Đây là lý do tham số hóa thay vì hard-code.

---

## 4. v-next (đề xuất)

- **CancelPending redeemer:** Cho phép user hủy pending_profile trước khi tới hạn (hiện tại phải chờ apply rồi mới đổi lại).
- **Admin override cooldown:** Governance có thể điều chỉnh `PROFILE_COOLDOWN` theo thông số mạng (hiện tại re-deploy).
- **Event log:** Thêm field `profile_change_history: List<(ActivityProfile, Natural)>` trong VaultDatum để audit trail (cân nhắc ExUnit cost).
- **Batch migration opt-in:** Cho phép user đồng ý migrate `profile_at_creation` của batch cũ sang profile mới (cần governance approval, outside T4 scope hiện tại).
