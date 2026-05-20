# Integration Gap Analysis — MAGIC ↔ PhoenixKey / App Layer

Phân tích những gì MAGIC layer thiếu cho việc PhoenixKey (hoặc bất kỳ DID provider nào) tích hợp lên app. Dùng làm input cho roadmap.

**Trạng thái:** Survey ngày 2026-05-20, sau khi `@magiclamp/sdk` v0.1.0 đã có `createVault()`.

---

## Tóm tắt

| # | Hạng mục | MAGIC có sẵn? | Ai chủ trì | Block app launch? |
|---|---|---|---|---|
| 1 | Tạo vault (4 type) | ✅ `createVault()` mới | MAGIC SDK | Không |
| 2 | Chọn profile lúc tạo | ✅ Trong `createVault({ vault: { profile }})` | MAGIC SDK | Không |
| 3 | Đổi profile sau khi tạo | ❌ Validator ProfileChange chưa deploy được | MAGIC onchain | ⚠ Tùy app: nếu UX cần đổi profile thì block |
| 4 | Username → PKH mapping | ❌ Không thuộc scope MAGIC | PhoenixKey hoặc DID resolver | Không (PhoenixKey lo) |
| 5 | Session key cho web login | ⚠ `personal_delegate` field tồn tại nhưng validator chưa enforce | MAGIC onchain + PhoenixKey | Có thể, tuỳ design — xem §3 |
| 6 | Xoay khoá (key rotation) | ❌ Không có redeemer đổi `owner` | MAGIC onchain | Có — user mất vault khi đổi key |
| 7 | Chuyển LAMP đi (withdraw) | ❌ Không có redeemer rút LAMP | MAGIC onchain | Có — UX cực kỳ tệ nếu LAMP bị khoá vĩnh viễn |

→ **3 vấn đề CHẶN production app:** key rotation, withdraw LAMP, (tuỳ) session key. Cả 3 đều cần thay đổi onchain validator → cần Tuân redesign + redeploy. **Cần thảo luận spec trước khi code.**

---

## 1. Tạo vault — `createVault()` ✅

Đã có trong `@magiclamp/sdk`. PhoenixKey gọi:

```ts
const { tx, vaultAddress } = await createVault({
  lucid, vaultType: "Snapshot", protocol, validators, vault: { ownerPkh, lampDeposit, profile }
});
```

→ trả tx unsigned. PhoenixKey wallet abstraction sign + submit.

**Không cần thay đổi onchain.** PhoenixKey có thể integrate ngay.

## 2. Chọn profile lúc tạo ✅

Param `vault.profile` trong `createVault`. Default `Flame`. Validator bake profile vào datum genesis. Done.

## 3. Đổi profile sau khi tạo ❌

**Trạng thái onchain:**
- `ProfileChange/onchain/validators/vault_profile.ak` tồn tại nhưng **không có `aiken.toml`** — partial validator, không build/deploy được.
- Spec §12 đã định nghĩa flow (`UpdateProfile { new_profile }` redeemer, 2-epoch cooldown C-PC-V2, lazy apply).
- SDK `ProfileChange/offchain/src/profile.ts` đã có `buildProfileChangeTx` nhưng wrapper validator không thực thi.

**Để fix:**
- (a) Tích hợp `vault_profile.ak` vào 1 trong 4 vault validator có sẵn (thêm redeemer `UpdateProfile` vào SnapshotGen vault chẳng hạn), hoặc
- (b) Tạo `aiken.toml` riêng cho ProfileChange, deploy thêm 1 vault validator nữa (tăng số vault cần tạo cho user)

→ Đề xuất **(a)**: gộp vào SnapshotGen vault vì user nào cũng có Snapshot. Tuân add `UpdateProfile` redeemer handler. Mình ước tính: 50 LoC Aiken + redeploy.

**Impact nếu không fix:** profile = vĩnh viễn từ lúc tạo vault. User muốn đổi → phải tạo vault mới + transfer LAMP (nhưng không withdraw được → đụng vấn đề #7).

## 4. Username → PKH mapping — PhoenixKey domain

MAGIC validator chỉ biết `owner: PKH`. Username là off-chain identity, hoàn toàn nằm trong PhoenixKey:

- PhoenixKey lưu mapping `username → DID → PKH`
- Lúc user login, PhoenixKey resolve username → PKH → query vault address
- MAGIC SDK chỉ cần PKH

**Không có gì cần làm ở MAGIC.** Đề xuất PhoenixKey lưu `vaultAddressByOwnerPkh` map (cache) để tránh re-derive mỗi request.

## 5. Session key — `personal_delegate` chưa active ⚠

**Trạng thái onchain:**
- `VaultDatum` đã có field `personal_delegate: Option<ByteArray>` (28-byte PKH)
- Field này hiện **không được validator nào enforce** — nghĩa là set/unset nó không thay đổi behavior tx

**Use case:** user login web/app, app muốn sign tx (TriggerSnapshot, InstantGen, ...) thay user. Hiện validator yêu cầu `tx.extra_signatories` chứa `owner` (master PKH). Master key không thể giao cho session → user phải sign mỗi tx manual.

**Design proposal cho session key:**

```aiken
// Hiện tại (mọi vault validator):
expect list.has(tx.extra_signatories, input_datum.owner)

// Đề xuất:
expect list.has(tx.extra_signatories, input_datum.owner)
    || when input_datum.personal_delegate is {
         Some(delegate) -> list.has(tx.extra_signatories, delegate)
         None -> False
       }
```

→ Owner HOẶC delegate đều sign được.

**Bổ sung:** cần redeemer `RotateDelegate { new_delegate: Option<ByteArray> }` để user (master key) set/clear delegate. Lifetime của delegate có thể có epoch expiry:

```aiken
personal_delegate: Option<{ pkh: ByteArray, expires_epoch: Natural }>
```

→ Session key hết hạn theo epoch. PhoenixKey rotate session key định kỳ (e.g., mỗi 7 epoch = 1 tuần Preview).

**Impact nếu không fix:** PhoenixKey không cấp session key được. User phải sign mọi tx bằng master key (CIP-30 popup mỗi lần) — UX rất tệ cho web app.

**Estimate:** Aiken change ~30 LoC mỗi vault validator (4 validators). + 1 redeemer mới. + SDK function `rotateSessionKey()`. ~2-3 ngày work.

## 6. Xoay khoá master (key rotation) ❌

**Trạng thái:** Không có redeemer nào thay đổi `owner` field trong datum.

**Use case:** user mất master key, hoặc rotate định kỳ. Hiện tại user mất key = mất vĩnh viễn vault + LAMP locked + MAGIC batches.

**Design proposal:**

```aiken
RotateOwner { new_owner: ByteArray, multi_sig_proof: ByteArray }
```

Validator check:
- `old_owner` sign (mandatory) → giả sử user còn key cũ và rotate proactive
- HOẶC `multi_sig_proof` (M-of-N social recovery): cần thêm `recovery_guardians: List<ByteArray>` trong datum, M trong N guardians sign

→ Phức tạp. Tối thiểu phase 1: chỉ support proactive rotation (old + new sign). Social recovery phase 2.

**Workaround tạm thời:** không có. User mất key = mất vault.

**Estimate:** Aiken ~80 LoC + redeemer + SDK + UI flow PhoenixKey. ~1 tuần work nếu chỉ proactive; ~2-3 tuần nếu social recovery.

## 7. Chuyển LAMP đi (withdraw) ❌ **CỰC KỲ QUAN TRỌNG**

**Trạng thái:** VaultRedeemer hiện có:

| Redeemer | LAMP flow |
|---|---|
| `TriggerSnapshot` | Không động LAMP (T16) |
| `InstantGen { lamp_paid }` | `lamp_paid` → Treasury |
| `VacuumCommit { lambda }` | Lock trong vault |
| `VacuumFire { order_id }` | Locked LAMP → Treasury |
| `ScheduleCommit { L, λ }` | Lock `L × λ` trong vault |
| `ScheduleFire { schedule_id }` | Per fire → Treasury |
| `BurnBatch { burns }` | Không động LAMP (chỉ burn MAGIC batches) |
| `UpdateProfile { new_profile }` | Không động LAMP |
| `ApplyHalving` | Không động LAMP |

**Không có redeemer nào trả LAMP về wallet.** LAMP locked vào vault chỉ có 1 chiều: flow sang Treasury qua Vacuum/Schedule, hoặc stay forever.

**Use case:** user muốn rút LAMP về để transfer cho người khác / bán / dùng app khác.

**Design proposal:**

```aiken
WithdrawLamp { amount: Natural }
```

Validator check:
- Owner sign
- `amount <= l_avail(lamp_balance, lamp_locked)` (chỉ rút phần unlocked)
- Output datum: `lamp_balance -= amount`, `loyalty_holdings` trừ amount theo oldest-first (T5 reverse: rút oldest, giữ youngest cho LF — hoặc spec lại)
- Output: `amount` LAMP → wallet user
- `last_updated_epoch` advance

**Cân nhắc spec:**
- Có nên áp dụng "cooldown" / "withdraw fee" để incentivize không rút? (Vd: 5% LAMP burned khi withdraw)
- Hoặc free withdraw → MAGIC protocol = pure utility, không lock-in
- Withdraw có ảnh hưởng `magic_batches` không? Spec hiện current_amount của batch là độc lập LAMP — nên không

→ Đề xuất phase 1: **free withdraw, oldest-first**. Đơn giản nhất. Có thể thêm cooldown sau nếu cần tokenomics control.

**Estimate:** Aiken ~50 LoC mỗi vault validator (4 validators) + SDK function. ~3-4 ngày work.

**Impact nếu không fix:** UX disaster. User deposit 1000 LAMP vào vault → KHÔNG BAO GIỜ rút được. Marketing này không bán cho ai được.

---

## Đề xuất roadmap để integrate app

### Phase 1 — Launch alpha (1-2 tuần)
Chỉ cần `createVault()` + đảm bảo PR #3 merged. Limitations rõ ràng, label "Alpha — Preview testnet only".

**MAGIC team:** Tuân merge PR #3 + fix UMKeeper agent.
**PhoenixKey team:** integrate `@magiclamp/sdk createVault()`. Username/DID resolver theirs.

**App có thể:**
- ✅ Tạo vault cho user
- ✅ Trigger Snapshot/Instant/Vacuum/Schedule (đã có SDK trong MAGIC repo)
- ❌ Không support: withdraw LAMP, rotate key, session key, change profile

### Phase 2 — Production-ready (4-6 tuần)
Cần Tuân thêm 4 redeemer onchain:

1. **#7 WithdrawLamp** — 🔴 CRITICAL — block production launch
2. **#5 Session key (RotateDelegate + delegate-can-sign)** — 🟡 HIGH — block web UX
3. **#3 Tích hợp ProfileChange vào SnapshotGen vault** — 🟢 MEDIUM
4. **#6 RotateOwner (proactive)** — 🟢 MEDIUM — block long-term user retention

Validator changes → đổi hash → redeploy → user phải migrate vault. Cần migration plan.

### Phase 3 — Social recovery + advanced (8+ tuần)
Multi-sig social recovery cho #6 nếu PhoenixKey muốn full key rotation UX.

---

## Decision points cho user

Mình cần anh quyết:

1. **Withdraw LAMP** — design phase 1 (free oldest-first) hay có tokenomics control (cooldown/fee)?
2. **Session key** — lifetime epoch-based hay block-based? Mặc định bao nhiêu epoch?
3. **Profile change** — gộp vào SnapshotGen vault (đề xuất) hay deploy validator riêng?
4. **Migration:** khi onchain change → user phải migrate vault. Cho phép withdraw từ vault cũ + auto-create vault mới qua SDK? Hay cần migrate tool riêng?

Trả lời được 4 câu này thì Tuân (hoặc anh) có thể code Aiken phase 2.
