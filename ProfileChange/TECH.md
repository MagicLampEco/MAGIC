# ProfileChange — TECH.md
## GenMAGIC v3.3 · §12 · Aiken types, validator logic, eUTXO flow

---

## 1. Aiken Types + Plutus Data Encoding

### 1.1 ActivityProfile (types.ak:19)

```aiken
pub type ActivityProfile {
  Ember    // constr 0
  Flame    // constr 1
  Lantern  // constr 2
}
```

Plutus Data: `Constr(0, [])` / `Constr(1, [])` / `Constr(2, [])`.
TypeScript: string union `"Ember" | "Flame" | "Lantern"` — serialize theo thứ tự enum khai báo.

**Cảnh báo:** Đổi thứ tự variant trong Aiken = đổi constructor index = break decode phía off-chain.

### 1.2 PendingProfile (types.ak:84)

```aiken
pub type PendingProfile {
  new_profile     : ActivityProfile,
  effective_epoch : Natural,
}
```

Plutus Data: `Constr(0, [<ActivityProfile>, <Int>])`.
Bọc trong `Option`: `None = Constr(1, [])`, `Some(p) = Constr(0, [<PendingProfile>])`.

### 1.3 ProfileRedeemer (vault_profile.ak:34)

```aiken
pub type ProfileRedeemer {
  UpdateProfile { new_profile: ActivityProfile }   // constr 0
  ApplyPending                                     // constr 1
}
```

Plutus Data:
- `UpdateProfile{Ember}` → `Constr(0, [Constr(0, [])])` 
- `ApplyPending` → `Constr(1, [])`

Off-chain redeemer:
```typescript
Data.to({ UpdateProfile: { new_profile: newProfile } })  // profile.ts:77
```

### 1.4 VaultDatum (types.ak:102)

17 fields theo đúng thứ tự khai báo (constructor 0). Field index:

| # | Field | Type |
|---|---|---|
| 0 | owner | ByteArray |
| 1 | lamp_balance | Natural |
| 2 | lamp_locked | Natural |
| 3 | loyalty_holdings | List<LoyaltyHolding> |
| 4 | magic_batches | List<MagicBatch> |
| 5 | next_batch_index | Natural |
| 6 | vacuum_orders | List<VacuumOrder> |
| 7 | gen_schedules | List<GenSchedule> |
| 8 | profile | ActivityProfile |
| 9 | profile_changed_epoch | Natural |
| 10 | pending_profile | Option<PendingProfile> |
| 11 | last_updated_epoch | Natural |
| 12 | delegation_cert | DelegationCertificate |
| 13 | activity_state | ActivityState |
| 14 | streak_state | StreakState |
| 15 | personal_delegate | Option<ByteArray> |
| 16 | attribution | VaultAttribution |

**Audit note:** VaultDatum đầy đủ 17 fields. Phiên bản cũ cắt ngắn datum → decode FAIL hoặc cho phép ví chủ reset field ẩn (drain). Fix (Bug 1): `types.ak` dùng bản đầy đủ. Bản đối chiếu SỐNG là `InstantGen/onchain/lib/magiclamp/protocol/types.ak` — đã kiểm 2026-08-09: 17 field, đúng thứ tự, khớp tuyệt đối. (Bản cũ trỏ `SnapshotGen/onchain/.../types.ak`, nay ở `Legacy/genmagic-v3.3/`.)

---

## 2. Validator Logic per Redeemer

### Validator: `vault_profile(ms_per_epoch: Int)`

File: `ProfileChange/onchain/validators/vault_profile.ak`

**Tham số deploy:** `ms_per_epoch` — Preview: `86_400_000`, Mainnet: `432_000_000`.

#### Common guards (mọi redeemer):

```
W-1: datum_opt = Some(datum)        // có inline datum
W-2: current_epoch = get_epoch(tx, ms_per_epoch)
W-3: own_hash = script_hash(own_addr)
W-4: count_inputs_at_script(tx.inputs, own_hash) == 1   // chống double-satisfaction
W-5: count_outputs_at_script(tx.outputs, own_hash) == 1
W-6: output datum decode thành VaultDatum
```

#### Redeemer: UpdateProfile { new_profile }

```
C-PC-V1: owner ∈ tx.extra_signatories
C-PC-V2: current_epoch - datum.profile_changed_epoch ≥ 2
C-PC-V3: new_profile ≠ datum.profile
C-PC-V5: output.pending_profile = Some{ new_profile, effective_epoch: current_epoch+1 }
C-PC-V6a: output.profile_changed_epoch = current_epoch
C-PC-V6b: output.last_updated_epoch = current_epoch
C-PC-V4:  output.profile = datum.profile  (chưa apply)
C-PC-V6c: all_other_fields_unchanged(output, datum)
```

`all_other_fields_unchanged` kiểm tra 13 fields còn lại (vault_profile.ak:120-134):
`owner`, `lamp_balance`, `lamp_locked`, `loyalty_holdings`, `magic_batches`, `next_batch_index`, `vacuum_orders`, `gen_schedules`, `delegation_cert`, `activity_state`, `streak_state`, `personal_delegate`, `attribution`.

#### Redeemer: ApplyPending

```
C-PC-V1: owner ∈ tx.extra_signatories
W-P1:    datum.pending_profile = Some(pending)  // fail nếu None
W-P2:    pending.effective_epoch ≤ current_epoch
C-PC-V4: output.profile = pending.new_profile
W-P3:    output.pending_profile = None
C-PC-V6d: output.last_updated_epoch = current_epoch
C-PC-V6e: output.profile_changed_epoch = datum.profile_changed_epoch  (KHÔNG đổi)
C-PC-V6f: all_other_fields_unchanged(output, datum)
```

---

## 3. eUTXO Flow

### 3.1 UpdateProfile Tx

```
Inputs:
  [vault UTxO] — script vault_profile (own_ref)
  [fee UTxO]   — ví user (lovelace)

Outputs:
  [vault UTxO] — cùng địa chỉ script, cùng assets, datum mới
                 (profile=old, pending=Some{...}, profile_changed_epoch=E, last_updated=E)
  [change UTxO] — ví user

Signatories: [owner]
Validity range: [E × ms_per_epoch, (E+1) × ms_per_epoch - 1]
Redeemer: UpdateProfile { new_profile }
```

**Quan trọng:** Validity range upper bound phải < `(E+1) × ms_per_epoch` để `get_epoch` tính đúng epoch E. Nếu tx cần thêm thời gian, upper bound phải trong epoch E (không vượt sang E+1).

### 3.2 ApplyPending Tx (standalone)

```
Inputs:
  [vault UTxO] — có pending_profile = Some{new, effective: E_eff}
  [fee UTxO]

Outputs:
  [vault UTxO] — profile=new, pending=None, last_updated=E_current

Validity range: [E_current × ms_per_epoch, ...]
  với E_current ≥ E_eff
Redeemer: ApplyPending
```

### 3.3 Lazy apply trong module khác

Khi SnapshotGen/InstantGen tx builder gọi `applyPendingProfile` (math.ts:13):
1. Off-chain kiểm tra `pending_profile.effective_epoch ≤ current_epoch`.
2. Nếu cần apply: include logic apply trong datum output (profile ← new, pending ← None).
3. Redeemer của module đó (TriggerSnapshot, Purchase) tự xử lý — không cần redeemer ProfileChange.

Đây là thiết kế "lazy": ProfileChange validator chỉ guard standalone tx `UpdateProfile` / `ApplyPending`. Các module khác tự guard việc apply trong validator của họ.

### 3.4 Double-satisfaction guard

Dùng `count_inputs_at_script(tx.inputs, own_hash) == 1` — đếm theo **payment credential** (script hash), không phải full Address. Đảm bảo kẻ tấn công không thể đưa 2 vault UTxO (cùng script nhưng khác stake credential) vào cùng tx để bypass kiểm tra.

Nguồn: `util.ak:44` + test `util.ak:91`.

---

## 4. Deploy Dependencies

### 4.1 Compile

```bash
cd ProfileChange/onchain && aiken build
# → plutus.json (chứa validator hash)
```

Validator tham số: `ms_per_epoch: Int` — phải apply khi hash.

### 4.2 Apply tham số (Preview)

```typescript
// deploy script (scripts/deploy/05_create_instant_vault.ts — bản cũ trỏ
// 04_deploy_vault.ts, script đó nay ở Legacy/genmagic-v3.3/scripts/)
const validator = applyParamsToScript(
  plutusJson.validators.find(v => v.title === "vault_profile.spend"),
  [Data.Integer(86_400_000n)],  // ms_per_epoch Preview
);
const vaultHash = validatorToScriptHash(validator);
```

Mainnet: thay `86_400_000n` → `432_000_000n`.

### 4.3 Không phụ thuộc module khác

ProfileChange validator standalone — không cần LAMP policy, UM NFT, hay Shard NFT. Chỉ cần vault UTxO đã deployed.

### 4.4 Env vars liên quan

```
VAULT_SCRIPT_HASH=<hash sau apply tham số>
NETWORK=Preview
```

---

## 5. Aiken Tests trong Validator

File: `vault_profile.ak` — 8 test cases inline:

| Test | Type | Mô tả |
|---|---|---|
| `update_happy_path` | pass | Flame→Ember, epoch 5, cooldown OK |
| `apply_happy_path` | pass | pending Ember effective@6, current=6 |
| `update_streak_tamper` | fail | reset streak trong UpdateProfile bị chặn |
| `update_double_satisfaction_stake_cred` | fail | 2 vault input cùng script hash |
| `update_cooldown_via_ms_per_epoch` | fail | last=4, current=5 → gap=1 < cooldown |
| `update_same_profile` | fail | Flame→Flame bị C-PC-V3 chặn |
| `apply_not_yet_effective` | fail | effective=6 > current=5 |
| `apply_wrong_profile` | fail | pending=Ember nhưng output=Lantern |
