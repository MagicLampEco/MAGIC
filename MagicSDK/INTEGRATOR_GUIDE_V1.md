# MAGIC v1.0 — Integrator Guide

Tài liệu cho dev tích hợp MagicSDK vào app (PhoenixKey, ví Cardano khác, app nội bộ MagicLamp Network). Sau khi đọc xong dev có thể: tạo vault → chọn/đổi profile → sinh MAGIC bằng 4 phương thức → rút LAMP về ví.

> **Tiền đề:** v1.0 onchain đã ship (Tuân đã merge `WithdrawLamp` + `UpdateProfile` full impl theo `SPEC_V1.md`). Trước v1.0, một số flow ở dưới sẽ bị validator reject — chi tiết ở từng phần.

---

## Mục lục

- [1. Kiến trúc & khái niệm](#1-kiến-trúc--khái-niệm)
- [2. Cài đặt](#2-cài-đặt)
- [3. Tham số protocol](#3-tham-số-protocol)
- [4. Tạo vault](#4-tạo-vault)
- [5. Tìm vault của user](#5-tìm-vault-của-user)
- [6. Sinh MAGIC — 4 phương thức](#6-sinh-magic--4-phương-thức)
- [7. Đổi profile](#7-đổi-profile)
- [8. Rút LAMP về ví](#8-rút-lamp-về-ví)
- [9. Multi-vault patterns](#9-multi-vault-patterns)
- [10. Error reference](#10-error-reference)
- [11. FAQ — trả lời 3 câu hỏi quan trọng](#11-faq--trả-lời-3-câu-hỏi-quan-trọng)

---

## 1. Kiến trúc & khái niệm

### LAMP vs MAGIC

| | LAMP | MAGIC |
|---|---|---|
| Bản chất | Cardano native token | Số ghi trong `magic_batches[]` của vault datum |
| Ai cấp phát | Mint qua `01_mint_lamp` (1 lần) | Sinh ra qua 1 trong 4 generator (vault redeemer) |
| Lưu ở đâu | Trong ví Cardano hoặc khoá trong vault | Trong vault datum (không phải native token) |
| Transfer giữa ví | ✅ Cardano transfer tx bình thường | ❌ MAGIC không transfer được — gắn với vault |

User nạp LAMP vào vault → vault giữ LAMP làm "collateral" → vault sinh MAGIC theo công thức (LAMP × profile × loyalty × UM × …). MAGIC được "burn" (claim) bằng `BurnBatch` redeemer trên mỗi vault validator — đây là off-scope guide này; xem handler `BurnBatch { .. }` trong [`Legacy/SnapshotGen/onchain/validators/vault.ak`](../Legacy/SnapshotGen/onchain/validators/vault.ak) (hiện stub, sẽ implement đầy đủ ở bản sau v1.0).

### Vault types

4 vault type, mỗi cái 1 validator riêng → 1 địa chỉ Cardano riêng:

| Vault type | Khi nào dùng | LAMP cost | UM dependency | Lifetime batch |
|---|---|---|---|---|
| `Snapshot` | Passive, tự động mỗi epoch | **Free** — LAMP ở lại vault | Không | N(profile) epoch |
| `Instant` | On-demand purchase | Transfer ngay → Treasury | Có (fallback 0.5× nếu stale) | 2 epoch |
| `Vacuum` | 2-phase commit-then-fire | Transfer tại fire → Treasury | Có (always smoothed UM) | 1 epoch (cliff) |
| `Schedule` | Forward contract rate-locked | Transfer per fire → Treasury | Không (locked rate) | 1 epoch (cliff) |

User có thể có N vault thuộc các type khác nhau, **cùng 1 owner PKH**, mỗi vault datum riêng.

### Profile (Ember / Flame / Lantern)

3 profile ảnh hưởng decay + multiplier:

| Profile | B_Q (bonus) | r (decay rate) | N (lifetime) | PM_Q (multiplier) | Khi nào dùng |
|---|---|---|---|---|---|
| `Ember` | 1.30 | 3 | 3 | 1.15 | Ngắn hạn — sinh nhiều MAGIC nhanh nhưng tắt nhanh |
| `Flame` (default) | 1.10 | 2 | 6 | 1.05 | Trung hạn — cân bằng |
| `Lantern` | 1.00 | 1 | 9 | 1.00 | Dài hạn — tổng MAGIC cao nhất, decay chậm |

Profile gắn vào từng vault — không phải user. 1 user 3 vault = 3 profile khác nhau, hợp lệ.

---

## 2. Cài đặt

```bash
npm install @magiclamp/sdk @lucid-evolution/lucid
```

Tiền đề ở repo MAGIC (1 lần, do team MAGIC làm):

1. `aiken build` cho 5 module (Snapshot/Instant/Vacuum/Schedule/UMKeeper) → sinh `plutus.json`
2. Deploy LAMP token → có `LAMP_POLICY_ID`
3. Deploy UM datum → có `UM_NFT_POLICY_ID` (cần cho Instant/Vacuum)
4. Deploy 16 shards → có `SHARD_POLICY_ID` (cần cho Schedule)
5. Treasury address tách riêng khỏi mọi user wallet

App layer nhận các id này qua config (env var hoặc file JSON do team MAGIC publish).

```ts
import { createVault, listVaultsForOwner, updateProfile, withdrawLamp } from "@magiclamp/sdk";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";

const lucid = await Lucid(new Blockfrost(URL, BLOCKFROST_KEY), "Preview");
lucid.selectWallet.fromPrivateKey(PRIVATE_KEY);

const plutus = JSON.parse(await readFile("Legacy/SnapshotGen/onchain/plutus.json", "utf8"));
```

---

## 3. Tham số protocol

3 nhóm tham số cố định cho mỗi network:

```ts
const protocolPreview = {
  network:           "Preview" as const,
  lampPolicyId:      "4942de4a226f43c524c1273d752712366511d5fd7ae28bc1a1576077",
  lampAssetName:     "744c414d50", // hex của "tLAMP", default trong SDK
  umNftPolicyId:     "...",       // cần cho Instant + Vacuum
  shardPolicyId:     "...",       // cần cho Schedule
  treasuryAddress:   "addr_test1...",
};
```

Mainnet protocol params khác — `ms_per_epoch` của Mainnet là 432.000.000ms (5 ngày), Preview/Preprod là 86.400.000ms (1 ngày). SDK tự apply qua `network` param → validator hash khác per-network.

---

## 4. Tạo vault

```ts
const { tx, vaultAddress, vaultScript, summary } = await createVault({
  lucid,
  vaultType: "Snapshot",  // hoặc "Instant" / "Vacuum" / "Schedule"
  protocol: protocolPreview,
  validators: {
    vaultUnappliedCbor: plutus.validators.find(v => v.title === "vault.vault.spend").compiledCode,
  },
  vault: {
    ownerPkh:    "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21",
    lampDeposit: 1_000_000_000n,    // 1000 LAMP (1 LAMP = 10^6 oildrop)
    profile:     "Flame",            // Ember | Flame (default) | Lantern
  },
});

const signed = await tx.sign.withWallet().complete();
const txHash = await signed.submit();
console.log("Vault created:", vaultAddress, "TX:", txHash);
```

### Profile chọn lúc tạo

Đây là điểm chốt **profile đầu tiên** của vault. Có 3 lựa chọn:
- `"Ember"` — `B_Q = 1.30`, `r = 3`, `N = 3`
- `"Flame"` (default, nếu không truyền) — `B_Q = 1.10`, `r = 2`, `N = 6`
- `"Lantern"` — `B_Q = 1.00`, `r = 1`, `N = 9`

Profile có thể đổi sau qua `updateProfile()` (xem §7), nhưng **existing magic batches giữ nguyên `profile_at_creation`** (immutable T4) — chỉ batch mới sinh sau effective epoch dùng profile mới.

### Tiền đề trước khi tạo

- Ví đã có `lampDeposit` LAMP (transferred từ deploy hoặc faucet)
- Ví có ≥ `vaultLovelace` ADA (default 2 ADA min-UTxO) + network fee (~0.5 ADA)
- Đối với `Instant` / `Vacuum` / `Schedule`: phải truyền thêm `treasuryAddress` + `umNftPolicyId` (hoặc `shardPolicyId` cho Schedule)

### Multi-vault — tạo nhiều vault cùng owner

Cardano cho phép. User có thể tạo 3 vault SnapshotGen cùng PKH owner — mỗi vault 1 UTxO ở cùng vault address, datum khác nhau. SDK không hạn chế. Xem §9 patterns.

---

## 5. Tìm vault của user

```ts
const vaults = await listVaultsForOwner({
  lucid,
  vaultAddress,                 // địa chỉ vault script (từ createVault)
  ownerPkh: "5b889dfd...",
});

// vaults: VaultRecord[]
//   { utxo, datum, vaultId, lampBalance, lampLocked, lampAvailable,
//     profile, pendingProfile, batchesCount, oldestEpoch, ageInEpochs }
```

App layer cache mapping `userId → [vaultUtxoRef, …]` để không phải scan address mỗi lần. Khi vault state thay đổi (snapshot trigger, withdraw, …) re-fetch.

---

## 6. Sinh MAGIC — 4 phương thức

Sau khi tạo vault, để **thực sự sinh ra MAGIC**, gọi 1 trong 4 generator builders. SDK chưa wrap mấy hàm này (chúng nằm trong repo MAGIC per-module), nhưng pattern giống nhau:

### 6.1. Snapshot — passive accrual

```ts
import { buildSnapshotGenTx } from "Legacy/SnapshotGen/offchain/src/snapshot.js";

const result = await buildSnapshotGenTx({
  lucid,
  vaultUtxo,                       // từ listVaultsForOwner
  vaultScript,                     // từ createVault hoặc applyVaultValidator
  network: "Preview",
});
const signed = await result.tx.sign.withWallet().complete();
await signed.submit();
```

Free — `lamp_balance` không thay đổi. Validator compute:

```
M = base × LF × B_Q[profile] × LH(holdings) × decay(profile, age) × lamp_balance / q
```

→ Thêm 1 batch vào `magic_batches[]`. Batch decay theo `r(profile)` mỗi epoch, hết hạn sau `N(profile)` epoch.

Trigger được 1 lần/epoch/vault. Bot/keeper hoặc app UI nhắc user trigger.

### 6.2. Instant — purchase MAGIC ngay

```ts
import { buildInstantGenTx } from "Legacy/InstantGen/offchain/src/instant.js";

const result = await buildInstantGenTx({
  lucid,
  vaultUtxo,
  vaultScript,
  umUtxo,                          // UM datum UTxO
  treasuryAddress,
  lampPaid: 100_000_000n,          // 100 LAMP — transfer ngay sang Treasury
  network: "Preview",
});
```

LAMP chuyển sang Treasury **tại tx này**. Validator compute:

```
M = lamp_paid × R_inst × UM_smoothed × PM_Q[profile] / q²
```

Nếu UM stale (`current_epoch - um.last_updated > drm_lookback`) → fallback `UM = 0.5 × q` (C-UM-6).

Batch lifetime = 2 epoch (cliff). Sinh ngay, decay nhanh.

### 6.3. Vacuum — 2-phase commit-then-fire

```ts
import { buildVacuumCommitTx, buildVacuumFireTx } from "Legacy/VacuumGen/offchain/src/vacuum.js";

// Phase 1: commit (lock LAMP, fire epoch = current + delay)
await buildVacuumCommitTx({
  lucid, vaultUtxo, vaultScript,
  lampAmount:   50_000_000n,
  fireDelay:    1n,                  // fire ở epoch current + 1
  network: "Preview",
}).then(r => r.tx.sign.withWallet().complete()).then(s => s.submit());

// Phase 2: fire (chạy ở epoch >= commit.fire_epoch — permissionless)
await buildVacuumFireTx({
  lucid, vaultUtxo, vaultScript,
  umUtxo, treasuryAddress,
  orderIndex: 0,                    // index trong vacuum_orders[]
  network: "Preview",
}).then(r => r.tx.sign.withWallet().complete()).then(s => s.submit());
```

Lock LAMP từ commit. Fire mới transfer Treasury + sinh MAGIC. Dùng UM smoothed (không có fallback — luôn chờ UM available).

### 6.4. Schedule — forward contract rate-locked

```ts
import { buildScheduleCommitTx, buildScheduleFireTx } from "ScheduleGen/offchain/src/schedule.js";

// Phase 1: lock rate ở R_cur, schedule N fire
await buildScheduleCommitTx({
  lucid, vaultUtxo, vaultScript,
  shardUtxo,
  lampPerFire:  10_000_000n,
  fireCount:    12,                 // 12 fire = 12 epoch tiếp theo
  network: "Preview",
});

// Phase 2: fire mỗi epoch theo schedule
await buildScheduleFireTx({
  lucid, vaultUtxo, vaultScript,
  treasuryAddress,
  scheduleIndex: 0,
  network: "Preview",
});
```

Rate lock tại commit time → không phụ thuộc UM tại fire. Dùng cho user muốn "DCA-style" predictable MAGIC stream.

### Khi nào dùng cơ chế nào

| Mục tiêu user | Vault type khuyến nghị |
|---|---|
| "Tôi có LAMP, không muốn động vào, để sinh MAGIC dần" | Snapshot (free) |
| "Tôi muốn MAGIC ngay bây giờ" | Instant |
| "Tôi muốn batch order, fire 1 hôm khác" | Vacuum |
| "Tôi muốn rate cố định lock cho 12 tháng" | Schedule |

User mix-and-match: 1 vault Snapshot dài hạn + 1 vault Instant cho ad-hoc.

---

## 7. Đổi profile

> ⚠ **v0 (chưa v1.0):** validator handler `UpdateProfile` là stub — chỉ check owner sign, **không enforce cooldown/lazy apply/datum integrity**. Tx submit thành công nhưng không có ý nghĩa bảo mật. App layer **không nên** expose chức năng này cho user cho đến khi v1.0 ship.
>
> **v1.0:** Full validator rules đã enforce theo §12 protocol. App có thể expose UI đổi profile.

```ts
const result = await updateProfile({
  lucid,
  vaultUtxo,                       // chỉ Snapshot hoặc Instant vault — Vacuum/Schedule không support
  newProfile: "Ember",
  vaultScript,
  vaultType: "Snapshot",
  vaultPlutusJson: plutus,
  network: "Preview",
});

// result.summary in ra effective_epoch + cảnh báo lazy apply
const signed = await result.tx.sign.withWallet().complete();
await signed.submit();
```

### Cơ chế

| Bước | Onchain effect |
|---|---|
| **Tx UpdateProfile** | `pending_profile = Some({ new_profile, effective_epoch: current_epoch + 1 })` được set vào datum. **`profile` field hiện tại KHÔNG đổi.** |
| **Tx kế tiếp chạm vào vault** (Snapshot/Instant/BurnBatch) ở epoch ≥ effective_epoch | Validator call `apply_pending_profile()` → `profile := pending.new_profile`, `pending_profile := None`. M sinh ra ở tx này đã dùng profile mới. |

Tức là user thấy "đã chuyển profile" sau khi tx tiếp theo fire, không phải ngay sau UpdateProfile tx.

### Quy tắc (Tuân implement)

| Rule | Mô tả |
|---|---|
| C-PC-V1 | Owner phải sign |
| C-PC-V2 | Cooldown ≥ 2 epoch giữa các lần đổi (chống flip-flop) |
| C-PC-V3 | `new_profile != current.profile` (đổi sang chính nó = reject) |
| C-PC-V4 | `magic_batches` immutable (batch cũ giữ `profile_at_creation`) |
| C-PC-V5 | `lamp_balance`, `lamp_locked`, `loyalty_holdings` không đổi |
| C-PC-V6 | `pending_profile.effective_epoch == current_epoch + 1` |

### Edge case quan trọng — existing batches

Tại sao "lazy"? Vì batches sinh ra dưới Flame (`r = 2, N = 6`) phải decay theo lịch trình Flame, không vì user đổi Ember mà thành `r = 3, N = 3`. Mỗi batch có `profile_at_creation` riêng — immutable. Chỉ **batch mới** sinh sau effective_epoch dùng profile mới.

---

## 8. Rút LAMP về ví

> ⚠ **v0:** redeemer `WithdrawLamp` chưa tồn tại trên validator. Tx submit sẽ bị reject. **LAMP đang trong vault BỊ KẸT** cho đến khi v1.0 ship. Đây là lý do **không launch v0 lên mainnet**.
>
> **v1.0:** Withdraw flow đầy đủ. Free (chỉ trả ADA network fee).

```ts
const result = await withdrawLamp({
  lucid,
  vaultUtxo,
  amountOil:        500_000_000n,   // 500 LAMP
  vaultScript,
  vaultType:        "Snapshot",
  vaultPlutusJson:  plutus,
  network:          "Preview",
});

const signed = await result.tx.sign.withWallet().complete();
await signed.submit();
```

LAMP rút sẽ trở về ví user (caller của tx), không phải địa chỉ tuỳ chọn. Nếu user muốn chuyển sang ví khác → 2 tx:
1. `withdrawLamp` → LAMP về ví hiện tại
2. `lucid.newTx().pay.ToAddress(otherAddress, { [lampUnit]: amount })` → Cardano transfer thường

### Selection: newest-first

Khi user rút `amount` LAMP, SDK chọn từ `loyalty_holdings` theo nguyên tắc **rút từ holding MỚI NHẤT trước**:

```
holdings: [
  { acquired_epoch: 10, amount: 100, is_locked: false },   // cũ nhất
  { acquired_epoch: 15, amount: 200, is_locked: false },
  { acquired_epoch: 20, amount: 300, is_locked: false },   // mới nhất
]

withdraw 250 → consume holding ở epoch 20 (300 → 50) trước
             → remaining holdings: [(10, 100), (15, 200), (20, 50)]
```

Lý do: LF (Loyalty Factor) là weighted-average tuổi × amount. Holdings cũ → tuổi cao → LF cao → Snapshot sinh nhiều MAGIC. Rút newest-first = sacrifice 0 tuổi loyalty.

(Ngược lại: Instant subtractFromHoldings rút **oldest-first** vì burn không discretionary.)

### Locked holdings không bao giờ bị động vào

Holdings có `is_locked = true` (do Vacuum commit hoặc Schedule commit) — bị skip hoàn toàn trong withdraw. Nếu `amount > L_avail` (= `lamp_balance - lamp_locked`) → validator reject với error W-3.

### Rút toàn bộ?

`amount = L_avail` → OK, vault còn lại đúng `lamp_locked` (chỉ holdings locked). Khi mọi locked holdings unlock (Vacuum/Schedule fire xong), user có thể rút tiếp.

`amount = lamp_balance` khi `lamp_locked = 0` → OK, vault còn 0 LAMP, holdings rỗng. **Vault vẫn tồn tại** ở vault address (UTxO với 0 LAMP), magic_batches vẫn decay theo lịch. User cần "đóng vault" thì sau khi rút LAMP, gọi burn các batch còn lại để claim MAGIC, sau đó dust UTxO ở vault — tự dọn nếu cần (off-scope guide này).

---

## 9. Multi-vault patterns

### Use case: 1 user, 3 horizon (ngắn / trung / dài)

```ts
// Tạo 3 vault Snapshot, profile khác nhau, mỗi vault deposit riêng
const short = await createVault({
  ..., vault: { ownerPkh, lampDeposit: 500_000_000n, profile: "Ember" },
});

const mid = await createVault({
  ..., vault: { ownerPkh, lampDeposit: 1_000_000_000n, profile: "Flame" },
});

const long = await createVault({
  ..., vault: { ownerPkh, lampDeposit: 2_000_000_000n, profile: "Lantern" },
});
```

3 vault này cùng ở `vaultAddress` (cùng SnapshotGen script), khác UTxO, khác datum. Mỗi vault sinh MAGIC độc lập.

### Use case: 1 user, mix vault types

```ts
const passive = await createVault({ ..., vaultType: "Snapshot", vault: {...} });
const purchase = await createVault({ ..., vaultType: "Instant",  vault: {...} });
```

`passive` ở SnapshotGen address, `purchase` ở InstantGen address (2 địa chỉ khác nhau). SDK `listVaultsForOwner` cần gọi cho mỗi vault address user có.

### App layer recommendation

```ts
interface UserVaultMap {
  snapshot: VaultRecord[];
  instant:  VaultRecord[];
  vacuum:   VaultRecord[];
  schedule: VaultRecord[];
}

async function getUserVaults(userId: string): Promise<UserVaultMap> {
  const ownerPkh = await did.resolvePkh(userId);  // PhoenixKey hoặc app DID
  const [snapshot, instant, vacuum, schedule] = await Promise.all([
    listVaultsForOwner({ vaultAddress: SNAPSHOT_ADDR, ownerPkh, lucid }),
    listVaultsForOwner({ vaultAddress: INSTANT_ADDR,  ownerPkh, lucid }),
    listVaultsForOwner({ vaultAddress: VACUUM_ADDR,   ownerPkh, lucid }),
    listVaultsForOwner({ vaultAddress: SCHEDULE_ADDR, ownerPkh, lucid }),
  ]);
  return { snapshot, instant, vacuum, schedule };
}
```

UX: hiện label do user gán cho mỗi vault (e.g. "Vault dài hạn", "Vault thử nghiệm Ember") — mapping lưu off-chain ở app DB.

### Chia LF không lây chéo

LF tính theo `loyalty_holdings` của VAULT HIỆN TẠI, không cross-vault. Tiêu vault `short` qua Instant không ảnh hưởng LF của vault `long`. Đây là property đáng giá cho user dài hạn — tránh "phải sacrifice oldest LF khi cần tiền ngắn hạn".

---

## 10. Error reference

### SDK-side errors (throws trước khi build tx)

| Code | Khi nào | Fix |
|---|---|---|
| `CREATE_VAULT_001` | `lampDeposit <= 0` | Truyền số dương |
| `CREATE_VAULT_002` | Missing `treasuryAddress` cho Instant/Vacuum/Schedule | Thêm vào `protocol` |
| `CREATE_VAULT_003` | Missing `umNftPolicyId` cho Instant/Vacuum | Thêm vào `protocol` |
| `WITHDRAW_001` | `amountOil <= 0` | Truyền số dương |
| `WITHDRAW_002` | `amountOil > L_avail` | Giảm amount hoặc đợi Vacuum/Schedule fire để unlock |
| `WITHDRAW_003` | Sum holdings sau khi trừ ≠ lamp_balance new | Bug nội bộ — file issue |
| `PROFILE_001` | `newProfile == currentProfile` | Đổi sang profile khác |
| `PROFILE_002` | Vault type là Vacuum hoặc Schedule | Chỉ Snapshot/Instant support |
| `PROFILE_003` | Pending profile chưa apply (đã có pending) | Đợi pending fire xong |

### Validator-side errors (reject tx sau khi build)

Mỗi rule trong `SPEC_V1.md` ánh xạ 1-1 với 1 trace label trong validator. Khi tx fail, Cardano log show trace label — đối chiếu với rule:

| Rule | Khi nào reject | Tampering scenario |
|---|---|---|
| W-1 | `amount == 0` | SDK đáng lẽ chặn ở `WITHDRAW_001` |
| W-2 | Không có owner sign | Tx thiếu `addSignerKey(ownerPkh)` |
| W-3 | `amount > L_avail` | SDK đáng lẽ chặn ở `WITHDRAW_002` |
| W-4 | 2 vault input trong cùng tx | App vô tình chọn 2 UTxO cùng vault address |
| W-5 | Output datum tamper bất kỳ field | Bug builder |
| W-6 | Output value LAMP không khớp `lamp_balance` mới | Bug builder |
| W-7 | Sum holdings ≠ balance | Bug `removeNewestFirst` |
| C-PC-V1..V6 | Profile change rules | Xem §7 |

---

## 11. FAQ — trả lời 3 câu hỏi quan trọng

> Phần này tổng hợp 3 câu hỏi quan trọng nhất khi tích hợp MAGIC vào app. So sánh trạng thái v0 (đang chạy trên Preview) vs v1.0 (sau khi Tuân ship spec này).

### Q1: User có lựa chọn được profile chưa?

**Lúc tạo vault (chọn ban đầu): ✅ ĐƯỢC NGAY** (cả v0 và v1.0)

`createVault({ vault: { profile: "Ember" | "Flame" | "Lantern" } })` — profile gắn vào datum, validator dùng cho mọi compute downstream. Nếu app không truyền `profile`, SDK default `"Flame"`.

**Đổi profile sau khi tạo:**

| | v0 (hiện tại) | v1.0 (sau Tuân ship) |
|---|---|---|
| Tx submit thành công? | ✅ Có (validator chỉ check sign) | ✅ Có (validator enforce đầy đủ) |
| Cooldown enforce? | ❌ Không | ✅ 2 epoch |
| `magic_batches` integrity? | ❌ Validator KHÔNG check — attacker có thể tampering | ✅ C-PC-V4 enforce |
| Lazy apply đúng? | ❌ Không enforce — output có thể set `profile` trực tiếp, bypass batches lock-in | ✅ C-PC-V6 enforce |
| **App nên expose UI?** | **KHÔNG** — security bug | **CÓ** |

→ **v0: cho user chọn lúc tạo, không cho đổi.** v1.0: cho cả 2.

### Q2: Sinh MAGIC bằng những phương thức nào?

4 phương thức, all available trên v0 + v1.0:

| Phương thức | Vault type | Cost LAMP | Use case |
|---|---|---|---|
| **Snapshot** (passive accrual) | Snapshot vault | **Free** (LAMP ở lại vault) | Hold LAMP dài hạn, sinh MAGIC mỗi epoch |
| **Instant** (on-demand purchase) | Instant vault | Transfer ngay → Treasury | Cần MAGIC ngay tức thì |
| **Vacuum** (2-phase commit/fire) | Vacuum vault | Transfer tại fire → Treasury | Lock-in LAMP, fire epoch tiếp |
| **Schedule** (forward contract) | Schedule vault | Transfer per fire → Treasury | Rate-locked DCA stream |

Tất cả 4 đều enabled trên Preview testnet v0. Tuân đã chạy 37 test case pass cho cả 4 module (xem [`MASTER_TESTNET_REPORT.md`](../MASTER_TESTNET_REPORT.md)).

**Sau v1.0 thay đổi:**
- 4 phương thức trên: không đổi
- Thêm `WithdrawLamp` để rút LAMP back về ví (không phải sinh MAGIC mà là exit)
- Thêm `UpdateProfile` full impl để đổi profile của vault (ảnh hưởng cách 4 phương thức tính M)

→ **v0: 4 phương thức đã hoạt động trên Preview.** v1.0: 4 phương thức không đổi + 2 control ops bổ sung.

### Q3: User có chuyển được LAMP đi ví khác chưa?

Phải tách 2 trường hợp:

**LAMP trong ví Cardano (không trong vault):**
- ✅ **LUÔN LUÔN ĐƯỢC** — cả v0 lẫn v1.0
- LAMP là Cardano native token, transfer như mọi token bình thường
- Không cần SDK, dùng Lucid `pay.ToAddress` hoặc bất kỳ ví Cardano nào

```ts
await lucid.newTx()
  .pay.ToAddress(receiverAddress, { [lampUnit]: 100_000_000n })
  .complete()
  .then(t => t.sign.withWallet().complete())
  .then(s => s.submit());
```

**LAMP trong vault:**

| | v0 (hiện tại) | v1.0 (sau Tuân ship) |
|---|---|---|
| Withdraw redeemer tồn tại? | ❌ Không | ✅ |
| Có cách nào rút LAMP về ví? | **❌ KẸT VĨNH VIỄN** | ✅ Qua `withdrawLamp()` |
| → Chuyển sang ví khác? | ❌ Không | ✅ 2 tx: withdraw → transfer |
| Mất giá trị LAMP? | ⚠ Trên Preview chỉ là tLAMP test, không mất gì thực sự | N/A |

→ **v0: KHÔNG — LAMP nạp vào vault bị kẹt.** Đây là lý do KHÔNG launch v0 lên mainnet. v1.0: Withdraw đầy đủ → user rút LAMP về ví, sau đó transfer như Cardano token thường.

---

## Tóm tắt sau v1.0

| Capability | v0 (Preview hiện tại) | v1.0 (target) |
|---|---|---|
| Tạo vault chọn profile | ✅ | ✅ |
| 4 phương thức sinh MAGIC | ✅ | ✅ |
| Đổi profile sau khi tạo (an toàn) | ❌ Stub | ✅ |
| Rút LAMP về ví | ❌ Không tồn tại | ✅ |
| Chuyển LAMP giữa các ví Cardano | ✅ (luôn) | ✅ |
| Multi-vault per user | ✅ | ✅ |
| Multi-profile per user (qua multi-vault) | ✅ | ✅ |
| Mainnet ready? | ❌ KHÔNG | ✅ (sau audit) |

---

## Tài liệu liên quan

- [`SPEC_V1.md`](./SPEC_V1.md) — onchain spec cho Tuân: validator rules, helper, A02 datum checks, lazy apply pattern
- [`V1_TESTNET_PLAN.md`](./V1_TESTNET_PLAN.md) — test matrix Tuân chạy sau implement
- [`README.md`](./README.md) — quick start
- [`MASTER_TESTNET_REPORT.md`](../MASTER_TESTNET_REPORT.md) (MAGIC repo root) — 37 case v0 đã pass trên Preview
