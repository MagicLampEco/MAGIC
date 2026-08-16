# MAGIC — Hướng dẫn cho người tích hợp

Tài liệu cho dev nhúng `@magiclamp/sdk` vào ứng dụng (PhoenixKey, ví Cardano khác, app nội bộ
MagicLamp Network). Đọc xong thì dựng được: tạo vault → tìm vault → sinh MAGIC → đổi profile →
rút LAMP.

> **Mô hình chuẩn của cả hệ:**
> [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](../SPEC/MagicLamp-Tripletoken-Feat-(Vi).md).
> **Luật validator** mà mã dưới đây phải khớp: [`SPEC_V1.md`](./SPEC_V1.md).
> **Module nào đang sống + số kiểm:** [`DevStatus.md`](../DevStatus.md).

> **Hai điều dễ sai nhất, nói trước:**
> 1. **Tạo vault BẮT BUỘC mint NFT danh tính.** Quên là LAMP kẹt vĩnh viễn — xem [§4](#4-tạo-vault).
> 2. **Sinh MAGIC KHÔNG làm LAMP rời vault** (`I-ACT-7`). Mô hình cũ "trả LAMP sang Treasury
>    để mua MAGIC" đã bị bỏ, tham số `treasuryAddress` đã bị xoá khỏi API — xem [§6](#6-sinh-magic).

---

## Mục lục

- [1. Kiến trúc & khái niệm](#1-kiến-trúc--khái-niệm)
- [2. Cài đặt](#2-cài-đặt)
- [3. Tham số protocol](#3-tham-số-protocol)
- [4. Tạo vault](#4-tạo-vault)
- [5. Tìm vault của người dùng](#5-tìm-vault-của-người-dùng)
- [6. Sinh MAGIC](#6-sinh-magic)
- [7. Đổi profile](#7-đổi-profile)
- [8. Rút LAMP về ví](#8-rút-lamp-về-ví)
- [9. Nhiều vault một chủ](#9-nhiều-vault-một-chủ)
- [10. Bảng lỗi](#10-bảng-lỗi)
- [11. Ba câu hỏi hay gặp](#11-ba-câu-hỏi-hay-gặp)

---

## 1. Kiến trúc & khái niệm

### LAMP so với MAGIC

| | LAMP | MAGIC |
|---|---|---|
| Bản chất | native token Cardano | số kế toán trong `magic_batches[]` của vault datum |
| Ai cấp phát | mint một lần lúc bootstrap | sinh qua một cửa gen (redeemer trên vault) |
| Nằm đâu | trong ví Cardano, hoặc khoá trong vault | trong vault datum — **không phải token trên UTxO** |
| Chuyển giữa ví | ✅ tx Cardano bình thường | ❌ không chuyển nhượng, gắn với vault |

Người dùng nạp LAMP vào vault → LAMP nằm đó **mở tư cách** sinh MAGIC (không bị tiêu, không
đổi chủ — `I-ACT-7`) → vault sinh MAGIC theo công thức của từng cửa. MAGIC được tiêu bằng
redeemer `BurnBatch` trên vault: đó là **trừ vào `current_amount` của batch trong datum**,
không có `tx.mint`, không có token nào di chuyển. Giá nghiệp vụ do validator `ConsumeMAGIC`
đồng-tiêu trong cùng tx cưỡng chế theo dấu bằng `Σburns == required`.

Vì MAGIC không phải token: đừng đi tìm metadata decimals của policy nào cả. Mọi con số qua
biên SDK là số thô kiểu `bigint`.

### Hai loại vault còn sống

Mỗi loại một validator riêng ⇒ một địa chỉ Cardano riêng:

| `vaultType` | Khi nào dùng | LAMP có rời vault? | Phụ thuộc UM | Ghi chú |
|---|---|---|---|---|
| `Instant` | cấp theo lượng MAGIC **đã tiêu** (`consumed_credit`) | **Không** (`I-ACT-7`) | Có (fallback 0.5× khi UM cũ — C-UM-6) | đang fail-closed vì **HAI** chốt: (a) chờ BackingBeacon của CARP, (b) trần theo lịch luôn = 0 — xem §6.2 |
| `Schedule` | hợp đồng kỳ hạn, khoá suất lúc commit | **Không** — fire chỉ mở khoá | Không (suất đã khoá) | cửa dùng được hôm nay |

`SnapshotGen` và `VacuumGen` đã dời sang `Legacy/genmagic-v3.3/` — validator của chúng không
còn trong cây làm việc, `VaultType` chỉ còn hai giá trị trên. Lý do từng module:
[`Legacy/README.md`](../Legacy/README.md); mốc thời gian: [`ChangeLog.md`](../ChangeLog.md).

Một người có thể có N vault thuộc cả hai loại, **cùng một owner PKH**, mỗi vault một datum
riêng.

### Bia mộ trong Plutus Data — đừng nhầm với tính năng sống

`BatchSource::Snapshot`, `::Vacuum` và trường `vacuum_orders` **vẫn nằm nguyên chỗ cũ** trong
lược đồ datum. Chúng là chỉ số constructor / arity của Plutus Data đã lên chain: bỏ đi là vỡ
decode mọi vault đã tạo. Thấy chúng trong `schemas.ts` không có nghĩa hai cơ chế đó còn dùng
được.

### Profile (Ember / Flame / Lantern)

Profile gắn vào **từng vault**, không phải từng người: một người có 3 vault thì được 3 profile
khác nhau. Nó chi phối tham số decay và hệ số nhân của MAGIC sinh ra.

Các hệ số cụ thể **không chép vào đây** — chúng là hằng protocol, sống ở
`InstantGen/onchain/lib/magiclamp/protocol/constants.ak` và bản song sinh TypeScript, và được
`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md` định nghĩa. Chép số vào tài liệu là cách chắc chắn
nhất để có hai giá trị mâu thuẫn.

Điều **không đổi** dù bạn đổi profile: mỗi batch giữ `profile_at_creation` của riêng nó (T4,
`TV-SAMENESS-01`). Batch sinh dưới Flame vẫn decay theo lịch Flame kể cả khi vault đã sang
Ember.

---

## 2. Cài đặt

```bash
npm install @magiclamp/sdk @lucid-evolution/lucid
```

Tiền đề ở repo MAGIC (làm một lần, do đội MAGIC làm):

1. `aiken build` cho `InstantGen`, `ScheduleGen`, `UMKeeper` → sinh `onchain/plutus.json`.
2. Mint LAMP → có `LAMP_POLICY_ID`.
3. Deploy datum UM → có `UM_NFT_POLICY_ID` + hash script UM (cần cho Instant).
4. Deploy 16 shard → có `SHARD_NFT_POLICY_ID` (cần cho Schedule).

Không còn bước chuẩn bị địa chỉ treasury: dưới `I-ACT-7` không handler nào của hai validator
còn sống chuyển LAMP ra khỏi vault.

Lớp ứng dụng nhận các id này qua cấu hình (biến môi trường hoặc tệp JSON do đội MAGIC công
bố).

```ts
import {
  createVault, listVaultsForOwner, updateProfile, withdrawLamp,
} from "@magiclamp/sdk";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";

const lucid = await Lucid(new Blockfrost(URL, BLOCKFROST_KEY), "Preview");
lucid.selectWallet.fromPrivateKey(PRIVATE_KEY);

// plutus.json của module tương ứng loại vault bạn dùng.
const plutus = JSON.parse(await readFile("ScheduleGen/onchain/plutus.json", "utf8"));
const vaultUnappliedCbor = plutus.validators.find(v => v.title === "vault.vault.spend").compiledCode;
```

Giữ nguyên cả object `plutus`: các hành động dùng redeemer (`withdrawLamp`, `updateProfile`)
cần nó để tra chỉ số constructor lúc chạy.

---

## 3. Tham số protocol

Một bộ cho mỗi mạng. Danh sách trường đầy đủ theo loại vault nằm ở `ProtocolParams` trong
`src/types.ts`; chữ ký apply-param thật của từng validator nằm ở header hàm `buildParamsList`
trong `src/validatorScripts.ts` — đó là nơi đối chiếu khi nghi ngờ, không phải tài liệu này.

```ts
const protocolPreview = {
  network:      "Preview" as const,
  lampPolicyId: LAMP_POLICY_ID,
  // lampAssetName: bỏ trống — SDK suy từ network (tLAMP testnet / LAMP mainnet).

  // Chỉ Schedule:
  shardPolicyId: SHARD_NFT_POLICY_ID,

  // Chỉ Instant:
  // umNftPolicyId, umScriptHash, backingNftPolicyId, backingScriptHash
};
```

Ba điều đáng nhớ:

- **`treasuryAddress` không còn tồn tại** trong `ProtocolParams`. Mã cũ truyền nó sẽ không
  biên dịch. Đó là chủ ý, không phải sót.
- **`lampAssetName` là tham số theo mạng**, là apply-param #2 của **mọi** vault. Hardcode giá
  trị testnet là dựng ra một vault mainnet không bao giờ nhìn thấy LAMP của chính nó.
- **`umScriptHash` / `backingScriptHash`** ghim reference input về đúng địa chỉ script chuẩn.
  NFT không phải singleton toàn cục nên chỉ kiểm NFT thôi là giả mạo được.

Mainnet có `ms_per_epoch` khác Preview/Preprod. SDK tự apply qua `network` ⇒ hash validator
khác theo mạng ⇒ địa chỉ vault khác theo mạng.

---

## 4. Tạo vault

### Điều dễ bỏ sót nhất: NFT danh tính (INV-VAULT-IDENTITY)

Cardano chỉ chạy validator lúc UTxO **bị tiêu**, không bao giờ lúc UTxO **được tạo**. Địa chỉ
script vault là công khai, nên ai cũng đặt được vào đó một UTxO 2 ADA với datum bịa
(`consumed_credit` khổng lồ, `magic_batches` giả). Bản vá: mỗi vault mang một NFT one-shot chỉ
ra đời được qua handler `mint` của **chính validator vault** — handler đó ép datum khởi sinh
sạch — và mọi nhánh `spend` đòi NFT còn nguyên trên output nối tiếp.

```
policy id  = chính script hash của vault đã apply param (validator đa mục đích)
asset name = blake2b_256( cbor.serialise(seed) ),  seed : OutputReference
```

`createVault()` dựng đủ bốn mảnh, thiếu một là validator từ chối:

1. seed UTxO nằm trong `inputs` (ép bằng `collectFrom`, không để coin-selection quyết định);
2. mint đúng **1** NFT dưới policy = hash vault;
3. NFT nằm trong output tại địa chỉ vault, cùng LAMP và min-ADA;
4. chủ ký (`addSignerKey(ownerPkh)`).

**Ai tự dựng tx tạo vault mà quên bước mint sẽ tạo ra một UTxO trông như vault, nhận LAMP
thật, và không nhánh spend nào đi qua được. LAMP kẹt vĩnh viễn, không có đường sửa.** Cần tự
dựng thì lấy tên asset bằng `vaultIdAssetName(seed)` và redeemer theo `VaultIdRedeemerSchema`
— cả hai đều xuất qua `@magiclamp/sdk`.

### Mã

```ts
const {
  tx, vaultAddress, vaultScript, vaultScriptHash,
  vaultIdPolicyId, vaultIdAssetName, vaultIdUnit, seedUtxo, summary,
} = await createVault({
  lucid,
  vaultType: "Schedule",          // "Instant" | "Schedule"
  protocol: protocolPreview,
  validators: { vaultUnappliedCbor },
  vault: {
    ownerPkh:    "5b889dfd8fabd0234233dbb2e26b9b8e96ceffe77b0c55aa2e8efc21",
    lampDeposit: 1_000_000_000n,  // 1000 LAMP (1 LAMP = 10^6 oildrop)
    profile:     "Flame",         // Ember | Flame (mặc định) | Lantern
  },
  // seedUtxo: bỏ trống → SDK chọn tất định qua pickSeedUtxo (ưu tiên UTxO
  // chỉ có ADA, nhiều ADA nhất). Truyền vào nếu bạn tự quản UTxO.
});

const signed = await tx.sign.withWallet().complete();
const txHash = await signed.submit();
console.log("Vault:", vaultAddress, "· NFT:", vaultIdUnit, "· TX:", txHash);
```

`summary` in sẵn seed UTxO và tên NFT — hãy log nó, đó là thứ bạn cần khi phải truy vết một
vault về sau.

### Datum khởi sinh phải SẠCH

`validate_mint_vault_id` ép từng trường một. Ba chỗ dễ sai:

- `last_updated_epoch = 0` — **không phải** epoch hiện tại. Đặt epoch thật vào đây là tx fail.
  Mọi handler chỉ so `current_epoch > last_updated_epoch`, nên 0 là an toàn: vault dùng được
  ngay từ epoch kế tiếp.
- `attribution_root` = chuỗi byte **RỖNG** (0 byte), không phải 32 byte 0.
- `personal_delegate = None`. Truyền `vault.personalDelegate` khác `null` ⇒ `createVault` ném
  lỗi ngay. Muốn đặt uỷ quyền cá nhân thì tạo vault trước, rồi gửi một tx riêng với redeemer
  `SetDelegate`.

Chi tiết từng trường: `buildInitialVaultDatum` trong `src/vaultDatum.ts` — mọi hằng trong hàm
đó là một điều kiện on-chain, không phải sở thích.

### Chọn profile lúc tạo

`vault.profile` là profile **đầu tiên** của vault; bỏ trống thì SDK mặc định `"Flame"`. Đổi
sau được qua `updateProfile()` ([§7](#7-đổi-profile)) — nhưng batch đã sinh giữ nguyên
`profile_at_creation`, chỉ batch mới dùng profile mới.

### Trước khi bấm tạo, kiểm

- Ví có ≥ `lampDeposit` LAMP (SDK tự kiểm và ném lỗi nêu rõ thiếu bao nhiêu).
- Ví có ≥ `vaultLovelace` ADA (mặc định 2 ADA) **cộng** phí mạng, **cộng** min-ADA cho chính
  output NFT.
- Ví có ít nhất một UTxO để làm seed. Ví rỗng ⇒ không có seed ⇒ không mint được NFT.
- `Instant`: đủ `umNftPolicyId`, `umScriptHash`, `backingNftPolicyId`, `backingScriptHash`.
- `Schedule`: đủ `shardPolicyId`.

---

## 5. Tìm vault của người dùng

```ts
const vaults = await listVaultsForOwner({
  lucid,
  vaultType:  "Schedule",
  protocol:   protocolPreview,
  validators: { vaultUnappliedCbor },
  ownerPkh:   "5b889dfd…",
});

// vaults: VaultRecord[]
//   { vaultId, utxo, datum, vaultAddress, lampBalanceOildrop, oldestEpoch, profile }
```

Hàm này tự tính địa chỉ vault từ `vaultType` + `protocol` + `validators` (cùng đường mà
`createVault` đi), quét UTxO tại đó, bỏ qua UTxO không giải mã được thành `VaultDatum`, rồi
lọc theo `datum.owner`.

Muốn cả hai loại vault thì gọi hai lần với `vaultType` khác nhau — hai loại nằm ở hai địa chỉ
khác nhau.

Gợi ý giao diện: sắp theo `oldestEpoch` tăng dần = vault già nhất trước = tư cách tích luỹ cao
nhất. Nhãn ("dài hạn" / "thử nghiệm") do ứng dụng tự gán và lưu off-chain; giao thức không có
khái niệm tên vault.

Lớp ứng dụng nên cache ánh xạ `userId → [vaultId, …]` để khỏi quét địa chỉ mỗi lần; nạp lại
sau mỗi tx chạm vào vault.

---

## 6. Sinh MAGIC

### Điều đã đổi: `I-ACT-7` — LAMP không rời vault

Sinh MAGIC **không** làm LAMP đổi chủ. Không có chân Treasury, không có `lampPaid`, không có
`treasuryAddress`. LAMP nằm trong vault chỉ để **mở tư cách**: giữ LAMP là điều kiện, không
phải nhiên liệu.

Hệ quả cho ứng dụng: sau một tx sinh MAGIC, `lamp_balance` **y nguyên**. Màn hình nào đang hứa
"trả X LAMP để lấy Y MAGIC" là hứa sai.

### Đường gọi duy nhất

`@magiclamp/sdk` là mối nối duy nhất. **Đừng import theo đường dẫn repo**
(`InstantGen/offchain/src/instant.js` …) — đó không phải tên gói, ứng dụng không phân giải
được.

```ts
import {
  buildScheduleCommitTx, buildScheduleFireTx,
  buildInstantGenTx, diagnoseCeilings,
  NANOGIC_PER_MAGIC, OILDROP_PER_LAMP,
} from "@magiclamp/sdk";
```

SDK dựng tx và trả về; **ký và gửi là việc của ứng dụng**. SDK không giữ khoá và không bao giờ
đòi khoá.

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

- `commit.rateLockedQ` cố định từ lúc commit (T8) — đổi tham số sau đó không ảnh hưởng hợp
  đồng đã ký.
- `fire.lampReleased` là LAMP **rời khỏi phần bị khoá nhưng vẫn ở trong vault**. Không phải
  LAMP gửi đi đâu cả. Nhầm chỗ này là hiểu sai cả cơ chế.
- Fire là **không cần quyền** (C-SCH-FIRE-PERMISSION): ứng dụng, keeper, hay bất kỳ ai cũng
  chạy được. Bỏ lỡ vài epoch thì bắt kịp được, tối đa `MAX_FIRES_PER_TX_CATCHUP` nhát mỗi tx.
- **Không huỷ được giữa chừng** (C-VAC-12 / T10): đã commit thì fire hoặc hết hạn. Giao diện
  phải nói rõ điều này **trước** khi người dùng bấm, không phải sau.

### 6.2. Instant — cấp theo lượng MAGIC ĐÃ TIÊU

```ts
const result = await buildInstantGenTx({
  lucid, vaultUtxo,
  umDatumUtxo,          // reference input
  backingBeaconUtxo,    // reference input — BẮT BUỘC, xem cảnh báo dưới
  userAddress, vaultScript, lampPolicyId,
  network: "Preview",
});
// result.newLampBalance === vaultDatum.lamp_balance — luôn đúng (I-ACT-7)
```

Lượng cấp khoá theo `consumed_credit` — tức **MAGIC đã tiêu**, không phải LAMP đã trả. Cấp
bằng giá trị nhỏ nhất trong ba trần: phần thưởng theo lượng đã tiêu, trần thặng dư backing, và
trần theo lịch đã cam kết. `consumed_credit` bị đưa về 0 trong chính tx này.

Công thức cụ thể của từng trần: đọc `computeRewardFromConsumed`, `computeCapSurplus`,
`computeCapPp` trong `InstantGen/offchain/src/math.ts` (và bản song sinh Aiken — P8 buộc hai
bên trùng bit). `diagnoseCeilings()` trả về cả ba trần riêng lẻ — dùng nó để nói cho người
dùng biết **trần nào** đang chặn họ, thay vì báo một lỗi trống.

> ⚠ **Hôm nay cửa này ĐANG ĐÓNG, và có HAI chốt chặn ĐỘC LẬP.** Mở một cái không mở được cửa.
>
> 1. **`backingBeaconUtxo` chưa tồn tại** (trần thặng dư backing). Nó là bắt buộc; chừng nào
>    CARP chưa ship beacon thì không reference input nào thoả, `cap_surplus` không tính được,
>    tx bị từ chối. Không có `br` mặc định nào được bịa ra để đi tiếp.
>    ([`DevStatus.md`](../DevStatus.md) "Còn nợ" #2)
> 2. **Trần theo lịch đã cam kết luôn bằng 0.** `computeCapPp` /
>    `compute_cap_pp(schedules) = Σ(gen_schedules) / 2`, mà vault Instant luôn có
>    `gen_schedules = []` ⇒ trần 0 ⇒ `min3(...) = 0` ⇒ `expect grant > 0` fail. Đây KHÔNG
>    phải hệ quả của #1 — nó chặn độc lập, kể cả khi beacon đã có.
>    ([`DevStatus.md`](../DevStatus.md) "Còn nợ" #6 và "Chờ chủ nhân chốt" D1: phải viết lại
>    trần theo SPEC §6.3 **cùng lúc** với `INV-INSTANT-LOCK`, không thì mở đường flash-rent LAMP)
>
> **Ngày CARP giao beacon, InstantGen VẪN cấp 0 nanogic.** Đừng bật nút Instant chỉ vì #1 đã
> xong — `diagnoseCeilings()` sẽ chỉ đúng trần nào đang chặn, dùng nó thay vì đoán.

### 6.3. Không có cửa nào khác qua SDK

`SnapshotGen` và `VacuumGen` đã ở `Legacy/genmagic-v3.3/`: Vacuum chuyển LAMP ra treasury nên
trái `I-ACT-7`; Snapshot chưa bao giờ hội tụ về `VaultDatum` hợp nhất. Không còn validator
trong cây làm việc, nên cũng không có gì để export. Đừng dựng gì trên hai cái tên đó.

`PrepaidGen` là cửa sinh thứ ba trong `SPEC/MagicLamp-Tripletoken-Feat-(Vi).md` §6.5 (nguồn
CARP: app/user khoá CARP, không phải sinh từ số dư LAMP như hai cửa kia). **Chưa có đường gọi
qua SDK** vì mã chưa vào cây làm việc — nhưng mã **còn nguyên**, 24 tệp neo bằng tag
`preserve/prepaidgen-stash-2026-07-30`. Bản trước của đoạn này viết *"mã nguồn đã mất (chỉ còn
bytecode)"*: **sai**, đã đính chính ở [`DevStatus.md`](../DevStatus.md) Nợ #5. Kiểm lại được
bằng một lệnh:

```
git ls-tree -r --name-only "preserve/prepaidgen-stash-2026-07-30^{commit}^3" | grep '^PrepaidGen/'
```

### Đơn vị — luôn thô, luôn BigInt

| Đại lượng | Đơn vị qua SDK | Quy đổi hiển thị |
|---|---|---|
| MAGIC | `nanogic` | `/ NANOGIC_PER_MAGIC` (`10^9`) |
| LAMP | `oildrop` | `/ OILDROP_PER_LAMP` (`10^6`) |

`magic_batches[].current_amount` trong datum vault cũng là nanogic — đó là **sổ kế toán trong
vault**, không phải token trên UTxO.

**Không bao giờ dùng `Number`** cho các đại lượng này (`C-OVERFLOW`) — `2^53` nhỏ hơn số dư
thật, và sai lộ ra dưới dạng số tiền lệch chứ không phải lỗi ném ra.

---

## 7. Đổi profile

**Chỉ vault `Instant` hỗ trợ.** `VaultRedeemer` của ScheduleGen không có variant
`UpdateProfile` (ScheduleGen khoá suất lúc commit, không đọc profile khi tính). Gọi với
`vaultType: "Schedule"` ném `UPDATE-001` trước mọi lệnh gọi mạng.

```ts
const result = await updateProfile({
  lucid,
  vaultUtxo,                       // vault Instant
  newProfile:      "Ember",
  vaultScript,
  vaultType:       "Instant",
  vaultPlutusJson: plutus,         // để tra chỉ số constructor lúc chạy
  network:         "Preview",
});

// result.summary in ra effective_epoch + cảnh báo áp-dụng-trễ
const signed = await result.tx.sign.withWallet().complete();
await signed.submit();
```

### Cơ chế: áp dụng TRỄ

| Bước | Hiệu ứng on-chain |
|---|---|
| **tx `UpdateProfile`** | `pending_profile = Some({ new_profile, effective_epoch: current_epoch + 1 })`. Trường `profile` hiện tại **KHÔNG đổi**. |
| **tx kế tiếp chạm vào vault** ở epoch ≥ `effective_epoch` | Validator gọi `apply_pending_profile` → `profile := pending.new_profile`, `pending_profile := None`. MAGIC sinh ở tx đó đã dùng profile mới. |

Tức là người dùng thấy "đã chuyển profile" sau khi tx tiếp theo chạy, không phải ngay sau tx
`UpdateProfile`. Giao diện phải nói đúng điều này, nếu không người dùng sẽ tưởng lệnh trượt.

### Luật validator đang cưỡng chế

| Luật | Nội dung |
|---|---|
| C-PC-V1 | chủ phải ký |
| C-PC-V2 | thời gian nguội ≥ 2 epoch giữa các lần đổi (chống lật qua lật lại) |
| C-PC-V3 | `new_profile != profile` hiện tại |
| C-PC-V4 | `magic_batches` bất biến — batch cũ giữ `profile_at_creation` (T4) |
| C-PC-V5 | `lamp_balance`, `lamp_locked`, `loyalty_holdings` không đổi |
| C-PC-V6 | `pending_profile.effective_epoch == current_epoch + 1` |

Ngoài ra validator ghim giá trị output: LAMP đúng bằng `lamp_balance` cũ, ADA không giảm, và
NFT danh tính còn nguyên. Hiện thực: `validate_update_profile` trong
`InstantGen/onchain/validators/vault.ak`; luật viết ra: [`SPEC_V1.md §2`](./SPEC_V1.md).

SDK kiểm trước hai điều để khỏi tốn một vòng mạng: `UPDATE-002` khi profile mới trùng profile
cũ, và ném `C-PC-V2` kèm số epoch còn phải chờ khi chưa hết thời gian nguội.

### Gọi lần hai khi lần một chưa áp dụng

Được — pending mới đè pending cũ. Thời gian nguội vẫn tính từ `profile_changed_epoch` đã đặt ở
lần một nên không lách được. Người dùng đổi ý sớm là trường hợp hợp lệ.

---

## 8. Rút LAMP về ví

```ts
const result = await withdrawLamp({
  lucid,
  vaultUtxo,
  amountOildrop:   500_000_000n,   // 500 LAMP — tên trường là amountOildrop
  vaultScript,
  vaultType:       "Schedule",     // "Instant" | "Schedule" — dùng cho log/lỗi
  vaultPlutusJson: plutus,
  network:         "Preview",
  lampPolicyId:    LAMP_POLICY_ID,
  // destinationAddress: mặc định = địa chỉ ví đang chọn
});

const signed = await result.tx.sign.withWallet().complete();
await signed.submit();
```

Khác với bản tài liệu cũ: `withdrawLamp` **có** `destinationAddress`, nên không cần hai tx để
gửi sang ví khác. Bỏ trống thì LAMP về chính ví đang ký.

> ⚠ **Builder đã khớp validator, nhưng CHƯA nghiệm thu trên chain.**
> `withdrawLamp` giữ nguyên `last_updated_epoch` (không gán lại) và chép nguyên
> `vaultUtxo.assets` sang output nên NFT danh tính còn — đúng hai thứ
> `validate_withdraw_lamp` đòi (qua `validate_vault_value`). Việc còn nợ là chạy một tx
> **thật** trên testnet trước khi mở nút "rút" cho người dùng.
>
> Bản tài liệu trước ghi builder đang lệch ở hai điểm này. Mô tả ấy đã hết đúng — **đừng sửa
> code cho khớp nó**: gán `last_updated_epoch: currentEpoch` là reset cửa sổ bắt-kịp và làm
> mất MAGIC đã tích; dựng lại value vault từ `{lovelace, lamp}` là bỏ rơi NFT danh tính ⇒ tx
> bị từ chối. Luật đang cưỡng chế: [`SPEC_V1.md §1`](./SPEC_V1.md). Trạng thái:
> [`DevStatus.md`](../DevStatus.md).

### Chọn holding: mới nhất trước

Khi rút, SDK chọn từ `loyalty_holdings` theo nguyên tắc **rút từ holding MỚI NHẤT trước**:

```
holdings: [
  { acquired_epoch: 10, amount: 100, is_locked: false },   // cũ nhất
  { acquired_epoch: 15, amount: 200, is_locked: false },
  { acquired_epoch: 20, amount: 300, is_locked: false },   // mới nhất
]

rút 250 → ăn vào holding epoch 20 trước (300 → 50)
        → còn lại: [(10, 100), (15, 200), (20, 50)]
```

Lý do: tư cách sinh MAGIC tính theo tuổi holding × lượng. Giữ holding cũ = giữ tuổi đã tích.
Rút mới-nhất-trước hy sinh 0 tuổi. Thuật toán: `removeNewestFirst` trong `src/withdrawLamp.ts`,
song sinh Aiken là `remove_newest_first` — P8 buộc hai bên trùng bit.

### Holding bị khoá không bao giờ bị động vào

Holding `is_locked = true` (do Schedule commit) bị bỏ qua hoàn toàn. Rút quá phần chưa khoá
(`L_avail = lamp_balance - lamp_locked`) bị SDK chặn ở `WITHDRAW-002`, và nếu lọt xuống chain
thì validator từ chối ở luật W-3.

### Rút hết?

- `amount = L_avail` → được; vault còn đúng phần đang khoá. Khi các khoản khoá được mở
  (Schedule fire xong), rút tiếp được.
- `amount = lamp_balance` khi `lamp_locked = 0` → được; vault còn 0 LAMP, danh sách holding
  rỗng. **Vault vẫn tồn tại** (UTxO min-ADA + NFT danh tính), `magic_batches` vẫn decay theo
  lịch.

---

## 9. Nhiều vault một chủ

Validator chỉ chặn "hai vault input trong cùng một tx" (C-VAULT-DS-1), **không** chặn "nhiều
vault một chủ". Cardano hỗ trợ sẵn: N UTxO ở cùng địa chỉ script, mỗi UTxO một datum.

### Ba kỳ hạn cho một người

```ts
const short = await createVault({
  lucid, vaultType: "Schedule", protocol: protocolPreview,
  validators: { vaultUnappliedCbor },
  vault: { ownerPkh, lampDeposit:   500_000_000n, profile: "Ember" },
});

const mid = await createVault({
  lucid, vaultType: "Schedule", protocol: protocolPreview,
  validators: { vaultUnappliedCbor },
  vault: { ownerPkh, lampDeposit: 1_000_000_000n, profile: "Flame" },
});

const long = await createVault({
  lucid, vaultType: "Schedule", protocol: protocolPreview,
  validators: { vaultUnappliedCbor },
  vault: { ownerPkh, lampDeposit: 2_000_000_000n, profile: "Lantern" },
});
```

Ba vault này cùng một địa chỉ (cùng validator ScheduleGen), khác UTxO, khác datum, khác NFT
danh tính. Mỗi vault sinh MAGIC độc lập.

### Trộn hai loại vault

```ts
const forward  = await createVault({ /* … */ vaultType: "Schedule", /* … */ });
const onDemand = await createVault({ /* … */ vaultType: "Instant",  /* … */ });
```

Hai vault ở **hai địa chỉ khác nhau** (hai validator khác nhau), nên `listVaultsForOwner` phải
gọi một lần cho mỗi `vaultType`.

### Gom lại ở lớp ứng dụng

```ts
interface UserVaultMap {
  instant:  VaultRecord[];
  schedule: VaultRecord[];
}

async function getUserVaults(ownerPkh: string): Promise<UserVaultMap> {
  const [instant, schedule] = await Promise.all([
    listVaultsForOwner({ lucid, vaultType: "Instant",  protocol: protocolInstant, validators: instantValidators, ownerPkh }),
    listVaultsForOwner({ lucid, vaultType: "Schedule", protocol: protocolPreview, validators: scheduleValidators, ownerPkh }),
  ]);
  return { instant, schedule };
}
```

Lưu ý `protocol` khác nhau giữa hai loại: Instant cần bộ `um*`/`backing*`, Schedule cần
`shardPolicyId`.

### Tư cách không lây chéo

Tư cách tính theo `loyalty_holdings` của **vault hiện tại**, không cộng chéo giữa các vault.
Rút LAMP khỏi vault ngắn hạn không đụng tới tuổi tích luỹ của vault dài hạn. Đây là tính chất
đáng giá cho người giữ lâu — không phải hy sinh holding già nhất khi cần tiền gấp.

---

## 10. Bảng lỗi

### Lỗi từ SDK (ném TRƯỚC khi dựng tx)

Mã lấy đúng từ `src/`. Mã nào không có ở đây thì không tồn tại.

| Mã | Ném từ | Khi nào | Sửa thế nào |
|---|---|---|---|
| `WITHDRAW-001` | `withdrawLamp` | `amountOildrop <= 0` | truyền số dương |
| `WITHDRAW-002` | `withdrawLamp` | `amountOildrop > L_avail` | giảm lượng, hoặc đợi Schedule fire để mở khoá |
| `WITHDRAW-003` | `removeNewestFirst` | tổng holding chưa khoá không đủ | thường là lệch datum/dữ liệu nạp vào — kiểm lại `vaultUtxo` |
| `UPDATE-001` | `updateProfile` | `vaultType === "Schedule"` | ScheduleGen không có redeemer `UpdateProfile` |
| `UPDATE-002` | `updateProfile` | profile mới trùng profile hiện tại | chọn profile khác |
| `C-PC-V2` | `updateProfile` | chưa hết thời gian nguội | thông điệp có nêu còn phải chờ mấy epoch |

Ngoài ra, các lỗi không mã nhưng nói thẳng vấn đề:

| Thông điệp | Ném từ | Nguyên nhân |
|---|---|---|
| `protocol.lampPolicyId is required` | `createVault` | thiếu policy LAMP |
| `vault.lampDeposit must be > 0 oildrop` | `createVault` | tiền nạp ≤ 0 |
| `Wallet has … need …` | `createVault` | ví không đủ LAMP |
| `<field> required for vaultType="<loại>"` | `buildParamsList` | thiếu tham số bắt buộc theo loại vault |
| `vault.personalDelegate không dùng được ở createVault…` | `createVault` | datum khởi sinh phải có `personal_delegate == None` |
| `Ví không có UTxO nào để làm seed…` | `pickSeedUtxo` | ví rỗng, không mint được NFT danh tính |
| `ownerPkh must be 28-byte hex` | `buildInitialVaultDatum` | PKH sai định dạng |
| `shardUnappliedCbor required when vaultType=Schedule` | `applyShardValidator` | thiếu CBOR validator shard |

### Lỗi từ validator (từ chối tx SAU khi dựng)

Mỗi luật trong [`SPEC_V1.md`](./SPEC_V1.md) ứng một chỗ `expect` trong validator. Khi tx bị từ
chối, đối chiếu vết lỗi với bảng này:

| Luật | Khi nào từ chối | Thường là do |
|---|---|---|
| W-1 | `amount == 0` | SDK đáng lẽ chặn ở `WITHDRAW-001` |
| W-2 | thiếu chữ ký chủ | tx thiếu `addSignerKey(ownerPkh)` |
| W-3 | `amount > L_avail` | SDK đáng lẽ chặn ở `WITHDRAW-002` |
| W-4 | hai vault input trong cùng tx | ứng dụng vô tình chọn 2 UTxO cùng địa chỉ vault |
| W-5 | output datum lệch bất kỳ trường nào | lỗi builder — kể cả `last_updated_epoch`, luật đòi **giữ nguyên** |
| W-6 | LAMP trong output vault ≠ `lamp_balance` mới | lỗi builder |
| W-7 | Σholding ≠ `lamp_balance` | lỗi `removeNewestFirst` |
| C-PC-V1..V6 | luật đổi profile | xem [§7](#7-đổi-profile) |
| — | output vault thiếu NFT danh tính, hoặc ADA giảm | `validate_vault_value` — mọi nhánh spend đều đòi |

---

## 11. Ba câu hỏi hay gặp

### Q1: Người dùng chọn được profile chưa?

**Lúc tạo vault: được.** `createVault({ vault: { profile } })` — profile vào datum, validator
dùng cho mọi tính toán về sau. Bỏ trống thì mặc định `"Flame"`.

**Đổi sau khi tạo: được, nhưng chỉ trên vault `Instant`.** Validator cưỡng chế đủ C-PC-V1..V6
(thời gian nguội, áp dụng trễ, batch bất biến, ghim giá trị output) — hiện thực là
`validate_update_profile`, không còn là stub chỉ kiểm chữ ký như bản tài liệu cũ mô tả. Vault
`Schedule` không có redeemer này.

### Q2: Sinh MAGIC bằng những cửa nào?

Mô hình có **đúng ba** cửa sinh, không hơn: **Schedule** và **Instant** sinh từ số dư LAMP
trong vault của người dùng; **Prepaid** thì người dùng trả CARP. `Snapshot`/`Vacuum` không
phải cửa thứ tư — chúng là mô hình cũ đã bỏ, chỉ còn bia mộ chỉ-số-constructor.

| Cơ chế | Qua `@magiclamp/sdk`? | LAMP có rời vault? | Trạng thái |
|---|---|---|---|
| **Schedule** (hợp đồng kỳ hạn) | ✅ | **Không** — fire chỉ mở khoá | dùng được |
| **Instant** (theo lượng đã tiêu) | ✅ | **Không** | fail-closed vì **HAI** chốt độc lập: chờ BackingBeacon của CARP **và** trần theo lịch luôn = 0 (`gen_schedules = []`) — xem §6.2 |
| **Prepaid** (trả bằng CARP) | ❌ | — | mã CÒN (24 tệp, tag `preserve/prepaidgen-stash-2026-07-30`) nhưng chưa vào cây làm việc ⇒ chưa có đường gọi SDK |
| **Snapshot / Vacuum** | ❌ | — | ở `Legacy/genmagic-v3.3/` |

Không cơ chế nào còn "trả LAMP sang Treasury". Bảng cũ ghi `Transfer → Treasury` cho
Instant/Vacuum/Schedule là mô tả mô hình **đã bỏ**.

Các báo cáo testnet trong `Legacy/genmagic-v3.3/` ghi kết quả Preview của mô hình **trước**
PHA-2 — đọc như tư liệu lịch sử, không phải mô tả hành vi hiện tại.

### Q3: Chuyển LAMP đi ví khác được chưa?

**LAMP trong ví Cardano (không nằm trong vault):** luôn được. LAMP là native token, chuyển như
mọi token khác, không cần SDK.

```ts
await lucid.newTx()
  .pay.ToAddress(receiverAddress, { [lampUnit]: 100_000_000n })
  .complete()
  .then(t => t.sign.withWallet().complete())
  .then(s => s.submit());
```

**LAMP trong vault:** redeemer `WithdrawLamp` **đã tồn tại trên cả hai validator còn sống**
(hiện thực: `validate_withdraw_lamp`), và `withdrawLamp()` có `destinationAddress` nên gửi
thẳng sang ví khác được trong một tx. Builder off-chain **đã khớp** validator (giữ
`last_updated_epoch`, giữ NFT danh tính) — cái còn thiếu là **nghiệm thu**: chưa có tx thật
trên testnet. Xem [§8](#8-rút-lamp-về-ví). Trước khi mở nút "rút" cho người dùng thật, chạy
thử đầu-cuối trên testnet và đối chiếu [`DevStatus.md`](../DevStatus.md).

---

## Tài liệu liên quan

- [`README.md`](./README.md) — bắt đầu nhanh + tham chiếu API
- [`SPEC_V1.md`](./SPEC_V1.md) — luật validator cho `WithdrawLamp` + `UpdateProfile`; các nhánh
  trong `vault.ak` trỏ thẳng về §1/§2/§3 của tệp đó
- [`V1_TESTNET_PLAN.md`](./V1_TESTNET_PLAN.md) — ma trận test; **chưa hội tụ** về mô hình hai
  vault, còn nói về Snapshot/Vacuum
- [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](../SPEC/MagicLamp-Tripletoken-Feat-(Vi).md) — mô
  hình ba token của cả hệ
- [`DevStatus.md`](../DevStatus.md) — module nào đang sống, còn nợ gì, số kiểm hiện hành
