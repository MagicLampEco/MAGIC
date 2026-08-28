# @magiclamp/sdk

Mặt tiền TypeScript của giao thức MAGIC trên Cardano. **Không phụ thuộc DID** — bất kỳ ví
Cardano nào giữ LAMP đều dùng được.

> Mô hình chuẩn của cả hệ (ba token LAMP · MAGIC · CARP):
> [`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`](../SPEC/MagicLamp-Tripletoken-Feat-(Vi).md).
> Ràng buộc khi sửa mã: [`BOUNDARIES.md`](../BOUNDARIES.md).
> Module nào đang sống + số kiểm: [`DevStatus.md`](../DevStatus.md).
> Chuyện đã xảy ra: [`ChangeLog.md`](../ChangeLog.md).

## Cài đặt

```bash
npm install @magiclamp/sdk @lucid-evolution/lucid
```

## Đọc trước khi viết dòng nào: tạo vault BẮT BUỘC mint NFT danh tính

Cardano chỉ chạy validator lúc UTxO **bị tiêu**, không bao giờ lúc UTxO **được tạo**. Địa
chỉ script vault là công khai, nên ai cũng đặt được một UTxO datum bịa vào đó. Bịt lỗ đó là
bất biến **INV-VAULT-IDENTITY**: mỗi vault mang một NFT one-shot chỉ ra đời được qua handler
`mint` của chính validator vault, và **mọi** nhánh `spend` đòi NFT đó còn nguyên trên output
nối tiếp.

Hệ quả cho người tích hợp:

- `createVault()` dựng sẵn cả 4 mảnh (seed UTxO trong inputs · mint đúng 1 NFT · NFT nằm
  trong output vault · chữ ký chủ). Dùng nó thì không phải lo.
- Ai **tự dựng tx tạo vault** mà quên mint NFT sẽ tạo ra một UTxO trông như vault, nhận LAMP
  thật, và **không nhánh spend nào đi qua được** — LAMP kẹt vĩnh viễn, không có đường sửa.
  Tên asset lấy bằng `vaultIdAssetName(seed)`; redeemer mint theo `VaultIdRedeemerSchema`.
- Datum khởi sinh phải **sạch**: `last_updated_epoch = 0`, `attribution_root` RỖNG (0 byte,
  không phải 32 byte 0), `personal_delegate = None`. Handler mint ép từng trường một. Muốn
  đặt uỷ quyền cá nhân thì tạo vault trước, rồi dùng redeemer `SetDelegate`.

## Quick start

```ts
import { createVault } from "@magiclamp/sdk";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";

// 1. Lucid với ví đã chọn
const lucid = await Lucid(new Blockfrost(URL, KEY), "Preview");
lucid.selectWallet.fromPrivateKey(PRIVATE_KEY);

// 2. Nạp CBOR validator chưa apply param (từ `aiken build` của repo MAGIC)
const plutus = JSON.parse(await readFile("ScheduleGen/onchain/plutus.json", "utf8"));
const vaultUnappliedCbor = plutus.validators.find(v => v.title === "vault.vault.spend").compiledCode;

// 3. Dựng tx chưa ký
const { tx, vaultAddress, vaultScript, vaultIdUnit, seedUtxo, summary } = await createVault({
  lucid,
  vaultType: "Schedule",
  protocol: {
    network:       "Preview",
    lampPolicyId:  LAMP_POLICY_ID,
    shardPolicyId: SHARD_NFT_POLICY_ID,   // Schedule cần cái này
  },
  validators: { vaultUnappliedCbor },
  vault: {
    ownerPkh:    "5b889dfd…",      // 28 byte hex, PKH của ví chủ
    lampDeposit: 1_000_000_000n,   // 1000 LAMP (1 LAMP = 10^6 oildrop)
    profile:     "Flame",          // Ember | Flame (mặc định) | Lantern
  },
});

console.log(summary);   // in cả seed UTxO và tên NFT danh tính

// 4. Ký + gửi. Khoá CHỦ phải ký — tx có addSignerKey(ownerPkh).
const signed = await tx.sign.withWallet().complete();
const txHash = await signed.submit();
```

## Khái niệm: vault và các cửa sinh MAGIC

MAGIC **không phải native token** — là số kế toán trong `magic_batches[]` của **vault** (một
UTxO ở địa chỉ script vault). Có LAMP trong ví ≠ có MAGIC. Muốn sinh MAGIC: tạo vault → gọi
một cửa sinh.

🔴 **Mô hình có ĐÚNG BA cửa sinh, không phải hai** (`SPEC/MagicLamp-Tripletoken-Feat-(Vi).md`
§6): **ScheduleGen · InstantGen · PrepaidGen**. Hai cửa đầu sinh từ **số dư LAMP trong vault
của người dùng**; cửa thứ ba, PrepaidGen, người dùng **trả CARP** (§6.5). SDK này hiện gọi
được **hai** cửa — không phải vì mô hình chỉ có hai, mà vì mã PrepaidGen chưa vào cây làm
việc (còn nguyên, neo bằng tag `preserve/prepaidgen-stash-2026-07-30`). Chi tiết:
[`INTEGRATOR_GUIDE_V1.md`](INTEGRATOR_GUIDE_V1.md) §6.3.

**Hai loại vault SDK gọi được hôm nay, mỗi loại một validator riêng ⇒ một địa chỉ riêng:**

| `vaultType` | Khi nào dùng | LAMP có rời vault? | UM | Cần thêm gì trong `protocol` |
|---|---|---|---|---|
| `Instant` | Cấp theo lượng MAGIC **đã tiêu** (`consumed_credit`) | **Không** (I-ACT-7) | Có, kèm kiểm tra cũ (C-UM-6) | `umNftPolicyId`, `umScriptHash`, `backingNftPolicyId`, `backingScriptHash` |
| `Schedule` | Hợp đồng kỳ hạn, khoá suất lúc commit | **Không** — fire chỉ mở khoá | Không (suất đã khoá) | `shardPolicyId` |

`SnapshotGen` và `VacuumGen` **đã dời sang `Legacy/`**: validator của chúng
không còn trong cây làm việc, nên `VaultType` chỉ còn hai giá trị trên. Truyền
`vaultType: "Snapshot"` hay `"Vacuum"` là lỗi kiểu — không có gì để apply param. **Đừng đọc
`VaultType` chỉ-có-hai-giá-trị thành "mô hình bỏ PrepaidGen"** — hai chuyện khác nhau:
Snapshot/Vacuum **đã chết**, PrepaidGen **chưa vào cây**.

Muốn dùng cả hai cơ chế thì cần **hai vault riêng** (hai UTxO ở hai địa chỉ). Hình dạng
`VaultDatum` giống hệt nhau; chỉ mã validator (và do đó địa chỉ) khác.

### LAMP không rời vault (I-ACT-7)

Sinh MAGIC **không** làm LAMP đổi chủ. Không có chân Treasury, không có `lampPaid`. LAMP nằm
trong vault để **mở tư cách**, không phải nhiên liệu bị đốt. Vì vậy `ProtocolParams` **không
còn trường `treasuryAddress`** — validator duy nhất từng đọc nó (Vacuum) đã ở `Legacy/`. Màn
hình nào còn hứa "trả X LAMP lấy Y MAGIC" là hứa sai.

## API

Toàn bộ tên public nằm ở `src/index.ts`. Thứ không xuất qua đó là chi tiết hiện thực.

### `createVault(params): Promise<CreateVaultResult>`

Dựng tx **chưa ký** tạo vault mới (kèm mint NFT danh tính). Không ký, không gửi — việc đó của
người gọi.

**`params: CreateVaultParams`**

| Trường | Kiểu | Bắt buộc | Ghi chú |
|---|---|---|---|
| `lucid` | `LucidEvolution` | ✅ | Ví đã chọn; chính ví này nạp LAMP và trả phí |
| `vaultType` | `"Instant"` \| `"Schedule"` | ✅ | |
| `protocol` | `ProtocolParams` | ✅ | xem bảng dưới |
| `validators.vaultUnappliedCbor` | `string` (CBOR hex) | ✅ | từ `<Module>/onchain/plutus.json`, `title === "vault.vault.spend"` |
| `validators.shardUnappliedCbor` | `string` (CBOR hex) | Schedule | từ plutus.json của ScheduleGen |
| `validators.vaultPlutusJson` | `PlutusJson` | | cần cho hành động DÙNG redeemer (`withdrawLamp`, `updateProfile`), không cần cho `createVault` |
| `vault.ownerPkh` | `string` (28 byte hex) | ✅ | khoá chủ — người duy nhất ký được hành động đòi chủ |
| `vault.lampDeposit` | `bigint` (oildrop) | ✅ | ví người gọi phải có ≥ số này |
| `vault.profile` | `"Ember"` \| `"Flame"` \| `"Lantern"` | | mặc định `"Flame"` |
| `vault.vaultLovelace` | `bigint` | | mặc định `2_000_000` |
| `vault.personalDelegate` | `string \| null` | | **không dùng được lúc tạo** — truyền khác `null` là ném lỗi; dùng redeemer `SetDelegate` sau |
| `seedUtxo` | `UTxO` | | seed one-shot cho NFT danh tính; bỏ trống thì SDK tự chọn tất định qua `pickSeedUtxo` |
| `tipPosixMs` | `bigint` | | ép epoch hiện tại, dùng cho test tất định |

**`protocol: ProtocolParams`**

| Trường | Kiểu | Bắt buộc | Ghi chú |
|---|---|---|---|
| `network` | `"Preview"` \| `"Preprod"` \| `"Mainnet"` | ✅ | quyết định `ms_per_epoch` **và** `lamp_asset_name` |
| `lampPolicyId` | `string` (56 hex) | ✅ | policy mint LAMP |
| `lampAssetName` | `string` (hex) | | suy từ `network` nếu bỏ trống (`tLAMP` testnet / `LAMP` mainnet) — **đừng hardcode** |
| `umNftPolicyId` | `string` (56 hex) | Instant | NFT mang datum UM |
| `umScriptHash` | `string` (hex) | Instant | ghim reference input UM về đúng địa chỉ script UM |
| `backingNftPolicyId` | `string` (56 hex) | Instant | BackingBeacon (§6.3) — xem cảnh báo fail-closed dưới |
| `backingScriptHash` | `string` (hex) | Instant | ghim reference input beacon |
| `shardPolicyId` | `string` (56 hex) | Schedule | NFT shard |
| `msPerEpoch` | `bigint` | | ép giá trị (nâng cao); mặc định suy từ `network` |

Thiếu trường bắt buộc theo loại vault ⇒ ném ngay lúc apply param, thông điệp dạng
``<tên trường> required for vaultType="<loại>"`` — chưa gọi mạng, chưa dựng tx.

**Trả về `CreateVaultResult`:**

```ts
{
  tx:               TxSignBuilder;  // .sign.withWallet().complete() rồi .submit()
  vaultAddress:     string;   // địa chỉ vault sau khi apply param
  vaultScriptHash:  string;   // hash — khác nhau giữa các mạng
  vaultScript:      Validator; // script đã apply, truyền tiếp cho builder gen
  vaultIdPolicyId:  string;   // BẰNG ĐÚNG vaultScriptHash (validator đa mục đích)
  vaultIdAssetName: string;   // blake2b_256(cbor.serialise(seed))
  vaultIdUnit:      string;   // policyId + assetName, dùng thẳng với Lucid
  seedUtxo:         UTxO;     // UTxO đã bị ép vào inputs làm seed one-shot
  summary:          string;   // bản tóm tắt cho log / UI
}
```

### `applyVaultValidator(vaultType, validators, protocol)`

Tính địa chỉ + script đã apply mà không cần dựng tx. Dùng để kiểm tra vault đã tồn tại chưa
trước khi tạo mới. Bảng chữ ký apply-param sống ở `buildParamsList` (cùng tệp) — đọc header
của hàm đó để biết validator từng loại nhận đúng những tham số nào, thứ tự nào.

### `applyShardValidator(validators, protocol)`

Script shard đã apply (chỉ có nghĩa với ScheduleGen).

### `listVaultsForOwner(params): Promise<VaultRecord[]>`

Quét địa chỉ vault theo `vaultType` + `protocol` + `validators`, lọc theo `ownerPkh`, trả về
một bản ghi cho mỗi UTxO. Một người **được phép có nhiều vault cùng loại** — validator chỉ
chặn "hai vault input trong một tx", không chặn "nhiều vault một chủ".

### `withdrawLamp(params)` · `updateProfile(params)`

Rút LAMP chưa khoá về ví, và đặt lịch đổi profile. Hai hàm này cần `vaultPlutusJson` để tự
tra chỉ số constructor của redeemer lúc chạy (`resolveConstrIndex`) — SDK không giữ bảng chỉ
số viết tay, nên enum Aiken đổi thứ tự thì chỉ cần `aiken build` lại.

`updateProfile` chỉ áp cho vault `Instant`: ScheduleGen không có variant `UpdateProfile` trong
`VaultRedeemer`, gọi với `vaultType: "Schedule"` sẽ ném `UPDATE-001` trước mọi lệnh gọi mạng.

### `buildInstantGenTx` · `diagnoseCeilings` · `buildScheduleCommitTx` · `buildScheduleFireTx`

Đường gọi **duy nhất** để sinh MAGIC. `@magiclamp/sdk` xuất lại các builder theo TÊN; đừng
import theo đường dẫn repo (`InstantGen/offchain/src/instant.js`…) — đó không phải tên gói,
ứng dụng không phân giải được.

> ⚠ **InstantGen hôm nay ĐANG ĐÓNG, và có HAI chốt chặn ĐỘC LẬP — không phải một.**
>
> 1. **`backingBeaconUtxo` chưa tồn tại.** Nó là bắt buộc; chừng nào CARP chưa ship
>    BackingBeacon thì không reference input nào thoả, `cap_surplus` không tính được, tx bị
>    từ chối. ([`DevStatus.md`](../DevStatus.md) "Còn nợ" #2)
> 2. **Trần thứ ba luôn bằng 0.** `compute_cap_pp(schedules) = Σ(gen_schedules) / 2`, mà
>    vault Instant luôn có `gen_schedules = []` ⇒ trần 0 ⇒ `min3(...) = 0` ⇒
>    `expect grant > 0` fail. ([`DevStatus.md`](../DevStatus.md) "Còn nợ" #6, "Chờ chủ nhân
>    chốt" D1 — phải vá cùng lúc với `INV-INSTANT-LOCK`)
>
> Cả hai đều fail-closed theo thiết kế, không phải lỗi để đi vòng. **Ngày CARP giao beacon,
> InstantGen VẪN cấp 0 nanogic** cho tới khi #2 được chốt và vá. Đừng hiện nút Instant dựa
> trên mỗi tin "beacon đã có". Dùng `diagnoseCeilings()` để biết trần nào đang chặn.

### `buildInitialVaultDatum(inputs)` · `VaultDatumSchema` · `VaultIdRedeemerSchema`

Dựng object `VaultDatum` khởi sinh (chưa mã hoá) để soi/kiểm thử; và hai lược đồ để
`Data.from` / `Data.to`. Mọi hằng trong `buildInitialVaultDatum` là một điều kiện on-chain của
`validate_mint_vault_id`, không phải sở thích — đối chiếu hàm đó trước khi đổi.

### `vaultIdAssetName(seed)` · `vaultIdSeedCbor(seed)`

Tên asset của NFT danh tính, và bước CBOR trung gian. Ai tự dựng tx tạo vault thì đây là hai
hàm không được đoán: dạng CBOR của `OutputReference` ở PlutusV3 **không** bọc `transaction_id`
trong một `Constr` như V1/V2; bọc thừa một lớp là hash khác là mint hỏng.

### Đơn vị — luôn thô, luôn `BigInt`

| Đại lượng | Đơn vị qua SDK | Hằng quy đổi |
|---|---|---|
| MAGIC | `nanogic` | `NANOGIC_PER_MAGIC` (`10^9`) |
| LAMP | `oildrop` | `OILDROP_PER_LAMP` (`10^6`) |

**Không bao giờ dùng `Number`** cho các đại lượng này (C-OVERFLOW): `2^53` nhỏ hơn số dư
thật, và sai lộ ra dưới dạng số tiền lệch chứ không phải lỗi ném ra.

## Tiền đề trên repo MAGIC

Trước khi gọi SDK, repo MAGIC phải đã:

1. `aiken build` cho các module đang dùng (`InstantGen`, `ScheduleGen`, `UMKeeper`) → sinh
   `onchain/plutus.json` (artifact, đã gitignore).
2. Mint LAMP → có `LAMP_POLICY_ID`.
3. Deploy datum UM → có `UM_NFT_POLICY_ID` + hash script UM (cần cho Instant).
4. Deploy 16 shard → có `SHARD_NFT_POLICY_ID` (cần cho Schedule).

Không còn bước "chuẩn bị địa chỉ treasury": dưới I-ACT-7 không handler nào của hai validator
còn sống chuyển LAMP ra khỏi vault.

## Tham số theo mạng

Mỗi mạng có `ms_per_epoch` riêng (validity_range của PlutusV3 là POSIX ms) **và** tên asset
LAMP riêng:

| Mạng | `ms_per_epoch` | Độ dài epoch | `lamp_asset_name` |
|---|---|---|---|
| Mainnet | 432.000.000 | 5 ngày | `LAMP` |
| Preview / Preprod | 86.400.000 | 1 ngày | `tLAMP` |

Cả hai đều là apply-param, nên hash validator khác theo mạng ⇒ **địa chỉ vault khác theo
mạng**. Vault tạo trên Preview không dùng được trên Mainnet. Hardcode tên asset testnet vào
mã là dựng ra một vault mainnet không bao giờ nhìn thấy LAMP của chính nó.

## Tài liệu liên quan

| Tệp | Cho ai | Nội dung |
|---|---|---|
| [`INTEGRATOR_GUIDE_V1.md`](./INTEGRATOR_GUIDE_V1.md) | dev off-chain (app / ví) | Trọn vòng đời: tạo vault → đổi profile → sinh MAGIC → rút LAMP, kèm mã mẫu + bảng lỗi |
| [`SPEC_V1.md`](./SPEC_V1.md) | dev on-chain (Aiken) | Luật của `WithdrawLamp` + `UpdateProfile` mà validator đang cưỡng chế; các nhánh trong `vault.ak` trỏ thẳng về §1/§2/§3 của tệp này |
| [`V1_TESTNET_PLAN.md`](./V1_TESTNET_PLAN.md) | dev on-chain | Ma trận test — **chưa hội tụ về mô hình hai vault**, còn nói về Snapshot/Vacuum |
| `README.md` (tệp này) | mọi người | Bắt đầu nhanh + tham chiếu API |

Ngoài phạm vi MAGIC (thuộc PhoenixKey hoặc lớp ứng dụng): ánh xạ tên người dùng → PKH; khoá
phiên cho đăng nhập web; xoay khoá chủ. Validator chỉ thấy một tx được ký bởi PKH chủ, không
phân biệt cơ chế ký phía sau.

## Hợp đồng ổn định

`@magiclamp/sdk` đang ở `0.x` — **API có thể gãy giữa các bản minor**. Ai chạy thật nên ghim
`0.1.x` cho tới khi có `1.0.0`.

## Kiểm thử

```bash
cd MagicSDK && npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```

Số ca test hiện hành nằm ở [`DevStatus.md`](../DevStatus.md) — chỗ duy nhất giữ số. Đừng chép
con số đó sang đây; nó hết hạn ngay khi có commit mới.
