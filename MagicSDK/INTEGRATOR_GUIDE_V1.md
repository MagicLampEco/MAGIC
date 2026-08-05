# MAGIC v1.0 — Integrator Guide

Tài liệu cho dev tích hợp MagicSDK vào app (PhoenixKey, ví Cardano khác, app nội bộ MagicLamp Network). Sau khi đọc xong dev có thể: tạo vault → chọn/đổi profile → sinh MAGIC → rút LAMP về ví.

> **Đổi lớn — `I-ACT-7`:** sinh MAGIC KHÔNG làm LAMP rời vault. Mô hình cũ
> "trả LAMP sang Treasury để mua MAGIC" đã bị bỏ. Xem [mục 6](#6-sinh-magic).

> **Tiền đề:** v1.0 onchain đã ship (Tuân đã merge `WithdrawLamp` + `UpdateProfile` full impl theo `SPEC_V1.md`). Trước v1.0, một số flow ở dưới sẽ bị validator reject — chi tiết ở từng phần.

---

## Mục lục

- [1. Kiến trúc & khái niệm](#1-kiến-trúc--khái-niệm)
- [2. Cài đặt](#2-cài-đặt)
- [3. Tham số protocol](#3-tham-số-protocol)
- [4. Tạo vault](#4-tạo-vault)
- [5. Tìm vault của user](#5-tìm-vault-của-user)
- [6. Sinh MAGIC](#6-sinh-magic)
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
| Ai cấp phát | Mint qua `01_mint_lamp` (1 lần) | Sinh ra qua một cửa gen (vault redeemer) |
| Lưu ở đâu | Trong ví Cardano hoặc khoá trong vault | Trong vault datum (không phải native token) |
| Transfer giữa ví | ✅ Cardano transfer tx bình thường | ❌ MAGIC không transfer được — gắn với vault |

User nạp LAMP vào vault → LAMP nằm đó **mở tư cách** sinh MAGIC (không bị tiêu, không đổi chủ — `I-ACT-7`) → vault sinh MAGIC theo công thức của từng cửa. MAGIC được "burn" (claim) bằng `BurnBatch` redeemer trên mỗi vault validator — đây là off-scope guide này; xem handler `BurnBatch { .. }` trong [`SnapshotGen/onchain/validators/vault.ak`](../SnapshotGen/onchain/validators/vault.ak) (hiện stub, sẽ implement đầy đủ ở bản sau v1.0).

### Vault types

4 vault type, mỗi cái 1 validator riêng → 1 địa chỉ Cardano riêng:

| Vault type | Khi nào dùng | LAMP có rời vault? | UM dependency | Lifetime batch |
|---|---|---|---|---|
| `Snapshot` | Passive, tự động mỗi epoch | Không | Không | N(profile) epoch |
| `Instant` | Khoá theo lượng MAGIC đã tiêu | **Không** (`I-ACT-7`) | Có (fallback 0.5× nếu stale) | 1 epoch (cliff) |
| `Vacuum` | 2-phase commit-then-fire | **Có → treasury** — trái `I-ACT-7`, legacy | Có (always smoothed UM) | 1 epoch (cliff) |
| `Schedule` | Hợp đồng kỳ hạn, khoá suất | **Không** — fire chỉ mở khoá | Không (locked rate) | 1 epoch (cliff) |

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
5. Treasury address — CHỈ còn cần cho module Vacuum (legacy). Các cửa sinh
   đang mở không dùng tới nó nữa (`I-ACT-7`).

App layer nhận các id này qua config (env var hoặc file JSON do team MAGIC publish).

```ts
import { createVault, listVaultsForOwner, updateProfile, withdrawLamp } from "@magiclamp/sdk";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";

const lucid = await Lucid(new Blockfrost(URL, BLOCKFROST_KEY), "Preview");
lucid.selectWallet.fromPrivateKey(PRIVATE_KEY);

const plutus = JSON.parse(await readFile("SnapshotGen/onchain/plutus.json", "utf8"));
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
- `Instant`: cần `umNftPolicyId`, `umScriptHash`, `backingNftPolicyId`, `backingScriptHash`.
  KHÔNG cần `treasuryAddress` nữa (`I-ACT-7`).
- `Schedule`: cần `shardPolicyId`. Cũng không cần `treasuryAddress`.
- `Vacuum` (legacy): vẫn cần `treasuryAddress` + `umNftPolicyId`.

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

## 6. Sinh MAGIC

> **Đọc mục này trước khi viết dòng nào.** Bản trước của tài liệu mô tả mô hình
> "trả LAMP sang Treasury để mua MAGIC". Mô hình đó **đã bị bỏ**. Ai còn dựng theo
> nó sẽ dựng ra một tx mà validator từ chối.

### Điều đổi: `I-ACT-7` — LAMP không rời vault

Sinh MAGIC **không** làm LAMP đổi chủ. Không có chân Treasury, không có
`lampPaid`, không có `treasuryAddress`. LAMP nằm trong vault chỉ để **mở tư cách**:
giữ LAMP là điều kiện, không phải nhiên liệu.

Hệ quả cho ứng dụng: sau một tx sinh MAGIC, `lamp_balance` **y nguyên**.
Màn hình nào đang hứa với người dùng "trả X LAMP để lấy Y MAGIC" là hứa sai.

### Đường gọi duy nhất

`@magiclamp/sdk` là seam duy nhất. **Đừng import theo đường dẫn repo**
(`InstantGen/offchain/src/instant.js` …) — đó không phải tên gói, ứng dụng
không phân giải được.

```ts
import {
  buildScheduleCommitTx, buildScheduleFireTx,
  buildInstantGenTx, diagnoseCeilings,
  NANOGIC_PER_MAGIC, OILDROP_PER_LAMP,
} from "@magiclamp/sdk";
```

SDK dựng tx và trả về; **ký và submit là việc của ứng dụng** (ví/Enclave của
người dùng). SDK không giữ khoá và không bao giờ đòi khoá.

### 6.1. Schedule — hợp đồng kỳ hạn, khoá suất tại commit

Đây là cửa sinh **dùng được hôm nay**: không cần BackingBeacon.

```ts
// Pha 1 — commit: khoá suất + khoá LAMP (LAMP vẫn nằm trong vault)
const commit = await buildScheduleCommitTx({
  lucid,
  vaultUtxo,                    // từ listVaultsForOwner
  shardUtxos,                   // CẢ 16 shard UTxO — builder tự tìm đúng shard
  scheduleLength: 12n,          // L ∈ [10, 200]
  lampPerEpoch:   10_000_000n,  // λ, đơn vị oildrop (10 LAMP)
  userAddress,
  vaultScript, shardScript,
  lampPolicyId,
  network: "Preview",
});
const signed = await commit.tx.sign.withWallet().complete();
await signed.submit();

// Pha 2 — fire: mỗi epoch một nhát, KHÔNG cần chữ ký chủ vault
const fire = await buildScheduleFireTx({
  lucid, vaultUtxo, shardUtxos,
  scheduleId: commit.scheduleId,
  vaultScript, shardScript, lampPolicyId,
  network: "Preview",
});
```

- `commit.rateLockedQ` cố định từ lúc commit (T8) — thay đổi tham số sau đó
  không ảnh hưởng hợp đồng đã ký.
- `fire.lampReleased` là LAMP **rời khỏi phần bị khoá nhưng vẫn ở trong vault**.
  Không phải LAMP gửi đi đâu cả. Nhầm chỗ này là hiểu sai cả cơ chế.
- Fire là **permissionless** (C-SCH-FIRE-PERMISSION): ứng dụng, keeper, hay bất
  kỳ ai cũng chạy được. Bỏ lỡ vài epoch thì bắt kịp được, tối đa 8 nhát/tx.
- **Không huỷ được giữa chừng** (C-VAC-12 / T10): đã commit thì fire hoặc hết hạn.
  UI phải nói rõ điều này **trước** khi người dùng bấm, không phải sau.

### 6.2. Instant — khoá theo lượng MAGIC ĐÃ TIÊU

```ts
const result = await buildInstantGenTx({
  lucid, vaultUtxo,
  umDatumUtxo,          // reference input
  backingBeaconUtxo,    // reference input — BẮT BUỘC, xem cảnh báo dưới
  userAddress, vaultScript, lampPolicyId,
  network: "Preview",
});
// result.newLampBalance === vaultDatum.lamp_balance  — luôn đúng (I-ACT-7)
```

Lượng cấp khoá theo `activity_state.consumed_credit` — tức **MAGIC đã tiêu**, không
phải LAMP đã trả:

```
grant = min( reward(consumed), cap_surplus(br), 0.5 × pp_schedule )
```

`consumed_credit` bị đưa về 0 trong chính tx này. `diagnoseCeilings()` trả về cả ba
trần riêng lẻ — dùng nó để nói cho người dùng biết **trần nào** đang chặn họ, thay vì
báo một lỗi trống.

> ⚠ **Hôm nay cửa này ĐANG ĐÓNG, và đóng có chủ ý.** `backingBeaconUtxo` là bắt buộc;
> chừng nào CARP chưa ship beacon thì không reference input nào thoả, `cap_surplus`
> không tính được, và tx bị từ chối. Đây là fail-closed theo thiết kế — không có
> `br` mặc định nào được bịa ra để đi tiếp. Ứng dụng **không nên** hiện nút Instant
> cho tới khi beacon có thật.

### 6.3. Snapshot / Vacuum — chưa mở qua SDK

Cố ý không export:

- **Vacuum** — validator của nó **vẫn chuyển LAMP ra khỏi vault sang treasury**.
  Trái `I-ACT-7`. Module này ở trạng thái legacy cho tới khi được đưa về mô hình
  PHA-2. Đừng dựng gì trên nó.
- **Snapshot** — chưa hội tụ lên `VaultDatum` hợp nhất của PHA-2.

### Đơn vị — luôn thô, luôn BigInt

| Đại lượng | Đơn vị qua SDK | Quy đổi hiển thị |
|---|---|---|
| MAGIC | `nanogic` | `/ 10^9` (`NANOGIC_PER_MAGIC`) |
| LAMP  | `oildrop` | `/ 10^6` (`OILDROP_PER_LAMP`) |

Mọi con số qua biên SDK là **thô**, kiểu `bigint`. Không có "decimals" nào cần đoán.
`magic_batches[].current_amount` trong datum vault cũng là nanogic — đó là **sổ kế
toán trong vault**, không phải token trên UTxO, nên đừng đi tìm metadata decimals của
một policy nào cả.

**Không bao giờ dùng `Number`** cho các đại lượng này (`C-OVERFLOW`) — `2^53` nhỏ hơn
số dư thật, và sai số hiện ra dưới dạng số tiền lệch chứ không phải lỗi ném ra.

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

Bốn cơ chế được thiết kế; **hai** trong số đó mở qua SDK hôm nay.

| Cơ chế | Qua `@magiclamp/sdk`? | LAMP có rời vault? | Trạng thái |
|---|---|---|---|
| **Schedule** (hợp đồng kỳ hạn) | ✅ có | **Không** — fire chỉ mở khoá | Dùng được |
| **Instant** (khoá theo lượng đã tiêu) | ✅ có | **Không** | Fail-closed: chờ BackingBeacon của CARP |
| **Vacuum** (2 pha commit/fire) | ❌ không | **Có** — trái `I-ACT-7` | Legacy, đừng dựng lên nó |
| **Snapshot** (tích luỹ thụ động) | ❌ không | Không | Chưa hội tụ lên `VaultDatum` PHA-2 |

Không cơ chế nào còn "trả LAMP sang Treasury". Bảng cũ ghi `Transfer → Treasury` cho
Instant/Vacuum/Schedule là mô tả mô hình **đã bỏ**.

`MASTER_TESTNET_REPORT.md` ghi kết quả Preview của mô hình **trước** PHA-2 — đọc nó
như tư liệu lịch sử, không phải mô tả hành vi hiện tại.

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
| Sinh MAGIC qua SDK — Schedule | ✅ | ✅ |
| Sinh MAGIC qua SDK — Instant | ⚠ fail-closed, chờ BackingBeacon (CARP) | ✅ |
| Sinh MAGIC — Vacuum / Snapshot | ❌ chưa mở qua SDK | — |
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
