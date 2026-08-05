# @magiclamp/sdk

MAGIC protocol SDK cho Cardano integrators. **DID-agnostic** — bất kỳ wallet Cardano nào có LAMP đều dùng được.

## Cài đặt

```bash
npm install @magiclamp/sdk @lucid-evolution/lucid
```

## Quick start

```ts
import { createVault } from "@magiclamp/sdk";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { readFile } from "node:fs/promises";

// 1. Lucid với wallet đã selected
const lucid = await Lucid(new Blockfrost(URL, KEY), "Preview");
lucid.selectWallet.fromPrivateKey(PRIVATE_KEY);

// 2. Load unapplied vault validator CBOR (từ aiken build của MAGIC repo)
const plutus = JSON.parse(await readFile("Legacy/SnapshotGen/onchain/plutus.json", "utf8"));
const vaultUnappliedCbor = plutus.validators.find(v => v.title === "vault.vault.spend").compiledCode;

// 3. Build unsigned tx
const { tx, vaultAddress, vaultScript, summary } = await createVault({
  lucid,
  vaultType: "Snapshot",
  protocol: {
    network:      "Preview",
    lampPolicyId: LAMP_POLICY_ID,
  },
  validators: { vaultUnappliedCbor },
  vault: {
    ownerPkh:    "5b889dfd...",      // 28-byte hex từ wallet PKH
    lampDeposit: 1_000_000_000n,      // 1000 LAMP (in oildrop)
    profile:     "Flame",             // Ember | Flame (default) | Lantern
  },
});

console.log(summary);

// 4. Sign + submit
const signed = await tx.sign.withWallet().complete();
const txHash = await signed.submit();
```

## Concept: vault và 4 cơ chế sinh MAGIC

MAGIC không phải native token — là số ghi trong `magic_batches[]` của **vault** (1 UTxO ở vault script address). User có tLAMP trong ví ≠ có MAGIC. Để sinh MAGIC: tạo vault → trigger 1 generator.

**4 vault types — mỗi cái 1 validator riêng, 1 địa chỉ riêng:**

| Vault type | Khi nào dùng | LAMP cost | UM | Lifetime batch |
|---|---|---|---|---|
| `Snapshot` | Tự động mỗi epoch | **Free** (T16) | Không | N(profile) epochs |
| `Instant` | On-demand purchase | Transfer ngay → Treasury | Có (C-UM-6 stale fallback 0.5×) | 2 epochs |
| `Vacuum` | Lock-then-fire 2-phase | Transfer tại fire → Treasury | Có (C-UM-7 always smoothed) | 1 epoch (cliff) |
| `Schedule` | Forward contract rate-locked | Transfer per fire → Treasury | Không (locked rate) | 1 epoch (cliff) |

User muốn dùng nhiều cơ chế → cần nhiều vault (mỗi cái deposit LAMP riêng).

## API

### `createVault(params): Promise<CreateVaultResult>`

Build unsigned tx tạo vault mới. Không sign, không submit — caller làm.

**`params: CreateVaultParams`**

| Field | Type | Required | Note |
|---|---|---|---|
| `lucid` | `LucidEvolution` | ✅ | Wallet đã selected; sẽ là người fund LAMP |
| `vaultType` | `"Snapshot"` \| `"Instant"` \| `"Vacuum"` \| `"Schedule"` | ✅ | |
| `protocol.network` | `"Preview"` \| `"Preprod"` \| `"Mainnet"` | ✅ | Quyết định `ms_per_epoch` |
| `protocol.lampPolicyId` | `string` (56-hex) | ✅ | LAMP minting policy |
| `protocol.lampAssetName` | `string` (hex) | | Default `"744c414d50"` = `"tLAMP"` |
| `protocol.treasuryAddress` | `string` (bech32) | Instant/Vacuum/Schedule | Phải là địa chỉ TÁCH RIÊNG khỏi ví user |
| `protocol.umNftPolicyId` | `string` (56-hex) | Instant/Vacuum | UM datum NFT |
| `protocol.shardPolicyId` | `string` (56-hex) | Schedule | Shard NFT |
| `validators.vaultUnappliedCbor` | `string` (CBOR hex) | ✅ | Từ `<Module>/onchain/plutus.json` |
| `validators.shardUnappliedCbor` | `string` (CBOR hex) | Schedule | Từ ScheduleGen plutus.json |
| `vault.ownerPkh` | `string` (28-byte hex) | ✅ | Owner key — duy nhất sign được owner-required actions |
| `vault.lampDeposit` | `bigint` (oildrop) | ✅ | 1 LAMP = 10^6 oildrop; ví caller phải có ≥ số này |
| `vault.profile` | `"Ember"` \| `"Flame"` \| `"Lantern"` | | Default `"Flame"` |
| `vault.vaultLovelace` | `bigint` | | Default `2_000_000` (2 ADA min-UTxO) |
| `vault.personalDelegate` | `string \| null` | | Reserved cho future session-key delegation |
| `tipPosixMs` | `bigint` | | Override để test deterministic |

**Returns `CreateVaultResult`:**

```ts
{
  tx:               TxSignBuilder;  // .sign.withWallet().complete().submit()
  vaultAddress:     string;          // địa chỉ vault sau khi apply params
  vaultScriptHash:  string;          // hash, khác nhau giữa các network
  vaultScript:      Validator;       // applied script (pass vào builder Snapshot/Instant/... downstream)
  summary:          string;          // human-readable log
}
```

### `applyVaultValidator(vaultType, validators, protocol)`

Tính địa chỉ + applied script không cần submit tx. Dùng để **check vault address tồn tại** trước khi tạo mới.

### `buildInitialVaultDatum(inputs)`

Build initial VaultDatum object (chưa serialize). Dùng để inspect / debug / test.

### `VaultDatumSchema`

CBOR schema cho VaultDatum. Dùng `Data.from(utxo.datum, VaultDatumSchema)` để decode vault hiện có.

## Sau khi vault tạo xong

Để **thực sự sinh MAGIC**, cần gọi các builder ở repo MAGIC (module tương ứng):

- `Legacy/SnapshotGen/offchain/src/snapshot.ts` → `buildSnapshotGenTx({...})` — trigger per epoch
- `Legacy/InstantGen/offchain/src/instant.ts` → `buildInstantGenTx({...})` — purchase MAGIC
- `Legacy/VacuumGen/offchain/src/vacuum.ts` → `buildVacuumCommitTx` / `buildVacuumFireTx`
- `ScheduleGen/offchain/src/schedule.ts` → `buildScheduleCommitTx` / `buildScheduleFireTx`

Mỗi builder cần `vaultScript` (lấy từ `createVault()` result hoặc `applyVaultValidator()`). Đây là same applied script — phải match đúng địa chỉ vault.

## Pre-requisites trên repo MAGIC

Trước khi gọi SDK, MAGIC repo phải đã:

1. `aiken build` cho 5 module (Snapshot/Instant/Vacuum/Schedule/UMKeeper) → sinh `plutus.json`
2. Mint LAMP token (`scripts/deploy/01_mint_lamp.ts`) → có `LAMP_POLICY_ID`
3. Deploy UM datum (`02_deploy_um.ts`) → có `UM_NFT_POLICY_ID` (cần cho Instant/Vacuum)
4. Deploy 16 shards (`03_deploy_shards.ts`) → có `SHARD_POLICY_ID` (cần cho Schedule)
5. Có treasury address tách riêng (KHÔNG dùng wallet address)

## Network parameterization

Mỗi network có `ms_per_epoch` khác nhau (PlutusV3 validity_range = POSIX ms):

| Network | ms_per_epoch | Epoch length |
|---|---|---|
| Mainnet | 432,000,000 | 5 days |
| Preview / Preprod | 86,400,000 | 1 day |

Vault validator được apply với `ms_per_epoch` tương ứng → hash khác per-network → địa chỉ vault khác. **Vault tạo trên Preview KHÔNG tương thích với Mainnet.**

## Tài liệu v1.0

| File | Audience | Nội dung |
|---|---|---|
| [`SPEC_V1.md`](./SPEC_V1.md) | Onchain dev (Aiken) | Validator rules + helper + A02 datum check + lazy apply pattern |
| [`V1_TESTNET_PLAN.md`](./V1_TESTNET_PLAN.md) | Onchain dev | Test matrix (32+ case mới) sau khi implement |
| [`INTEGRATOR_GUIDE_V1.md`](./INTEGRATOR_GUIDE_V1.md) | Offchain dev (app/PhoenixKey) | Full lifecycle: create → profile → 4 cách sinh MAGIC → withdraw. Code samples + error reference + FAQ |
| `README.md` (file này) | Quick start | API reference SDK |

**Onchain status:** v1.0 đã ship trên branch `feat/v1.0-onchain` (WithdrawLamp + UpdateProfile full impl, 4 module). Đang chờ testnet exec + audit trước mainnet launch.

### SDK functions

| Function | v0 (legacy) | v1.0 (current branch) |
|---|---|---|
| `createVault()` | ✅ | ✅ |
| `listVaultsForOwner()` | ✅ (multi-vault native) | ✅ |
| `updateProfile()` | ⚠ Stub validator chỉ check sign — không enforce | ✅ Full per spec §12 — cooldown + lazy apply enforced onchain |
| `withdrawLamp()` | ❌ Validator reject (no redeemer) | ✅ Full per spec §1 — W-1..W-7 enforced onchain |

### Nằm ngoài scope MAGIC (PhoenixKey hoặc app layer)

- **Username → PKH mapping** — PhoenixKey DID resolver
- **Session key cho web login** — PhoenixKey wallet abstraction (CIP-30 hoặc custodial). MAGIC validator chỉ thấy tx signed by owner PKH, không phân biệt cơ chế signing
- **Key rotation (đổi master key)** — chưa có spec; sau v1.0 nếu cần

## Stability contract

`@magiclamp/sdk` v0.x — pre-1.0, **API có thể break giữa minor versions**. Production users nên ghim cụ thể `0.1.x` cho đến khi 1.0.0.

Mọi exported name trong `src/index.ts` là public API. Mọi thứ khác (validatorScripts.ts, vaultDatum.ts internals) là implementation detail.

## Test

```bash
cd MagicSDK
npm install
npm test        # 10/10 unit tests
```

End-to-end testnet test do team MAGIC làm (per-module smoke scripts trong `scripts/test/`).
