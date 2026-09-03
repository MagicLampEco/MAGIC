// MagicSDK/src/types.ts — public types for createVault and friends
import type { LucidEvolution, TxSignBuilder, UTxO, Validator } from "@lucid-evolution/lucid";
import type { Network } from "@magiclamp/protocol-utils";
import type { PlutusJson } from "./redeemerIndex.js";

export type Profile = "Ember" | "Flame" | "Lantern";

/**
 * The 2 LIVE vault types correspond to 2 on-chain validators:
 *   - "Instant":  on-demand grant keyed to MAGIC consumed (LAMP stays put)
 *   - "Schedule": forward contract with locked rate (LAMP stays put; the fire
 *                 only releases the lock — I-ACT-7)
 *
 * SnapshotGen và VacuumGen ĐÃ dời sang `Legacy/`: validator của
 * chúng không còn trong cây làm việc, nên không có gì để `applyParamsToScript`.
 * Chào bán hai loại đó ở đây là nhánh chết — người tích hợp đi vào chỗ không có
 * validator. Chúng KHÔNG được thêm lại nếu không kèm validator sống.
 * (Lưu ý: enum `BatchSource` trong schemas.ts vẫn giữ nguyên `Snapshot`/`Vacuum`
 * — đó là Plutus Data đã lên chain, xem bia mộ trong tệp đó.)
 *
 * A user who wants both mechanisms needs 2 separate vaults (2 UTxOs at 2
 * different addresses). The VaultDatum shape is identical across both, but the
 * validator code (and hence the address) differs.
 */
export type VaultType = "Instant" | "Schedule";

/**
 * Unapplied (raw aiken-built) validator script CBOR strings.
 * Caller is responsible for sourcing these — typically by reading
 * `<Module>/onchain/plutus.json` of the MAGIC repo for the matching
 * `<vaultType>` (and `Shard` for ScheduleGen).
 *
 * Keeping CBOR strings (not file paths) here makes the SDK environment-
 * agnostic: works in Node, browser bundlers, edge runtimes — anywhere
 * Lucid Evolution runs.
 */
export interface ValidatorBundle {
  /** Unapplied vault validator CBOR hex (from plutus.json). */
  vaultUnappliedCbor: string;
  /** Unapplied shard validator CBOR hex (REQUIRED for vaultType "Schedule"). */
  shardUnappliedCbor?: string;
  /** Full plutus.json content for the vault module. REQUIRED for actions that
   *  use a redeemer (withdrawLamp, updateProfile, trigger…) — SDK reads
   *  `validators[].redeemer.schema.$ref` → `definitions[].anyOf[]` to resolve
   *  constructor indices by title. Avoids hardcoded indices that desync when
   *  the Aiken enum reorders. Optional for createVault (no redeemer needed). */
  vaultPlutusJson?: PlutusJson;
  /** Shard module plutus.json (REQUIRED for ScheduleGen actions). */
  shardPlutusJson?: PlutusJson;
}

/**
 * Required network/protocol params that the validator will be applied with.
 * `ms_per_epoch` is auto-derived from `network` if omitted.
 *
 * KHÔNG còn `treasuryAddress`. Dưới I-ACT-7 không handler nào của hai validator
 * còn sống chuyển LAMP ra khỏi vault, nên tham số đó không còn ai đọc. Validator
 * duy nhất từng nhận nó (Vacuum) đã ở `Legacy/`.
 */
export interface ProtocolParams {
  /** "Preview" | "Preprod" | "Mainnet". */
  network: Network;
  /** LAMP minting-policy ID. Required for both Instant and Schedule — it pins
   *  the vault's LAMP UTxO asset unit. */
  lampPolicyId: string;
  /** LAMP asset name as hex. Bỏ trống thì DẪN THEO MẠNG qua
   *  `lampAssetName(network)`: Mainnet "4c414d50" = "LAMP", Preview/Preprod
   *  "744c414d50" = "tLAMP" (`ProtocolUtils/src/index.ts:48-52`). KHÔNG có mặc
   *  định cứng — mặc định testnet ở đây là đường bake một vault tLAMP vào lần
   *  deploy mainnet, đúng thứ tham số này sinh ra để chặn. Chỉ đặt tay khi LAMP
   *  được mint dưới một tên phi chuẩn. */
  lampAssetName?: string;
  /** UM datum NFT policy ID. Required for Instant. */
  umNftPolicyId?: string;
  /** UM script hash (= applied UMKeeper validator hash). Required for
   *  Instant. Pins the UM reference input to the canonical UM
   *  script address (MAINNET-BLOCK fix, defense-in-depth layer b). */
  umScriptHash?: string;
  /** Shard NFT policy ID. Required for Schedule. */
  shardPolicyId?: string;
  /** BackingBeacon NFT policy ID. Required for Instant (§6.3).
   *  [CẦN XÁC NHẬN — beacon schema pending CARP]
   *  Pass the all-zero placeholder while the beacon is not deployed: no
   *  reference input can then match and InstantGen stays SHUT (fail-closed). */
  backingNftPolicyId?: string;
  /** BackingBeacon script hash. Required for Instant (§6.3). */
  backingScriptHash?: string;
  /** Override ms_per_epoch (advanced). Derived from `network` otherwise. */
  msPerEpoch?: bigint;
}

/**
 * Initial vault datum shape — what gets baked into the new vault UTxO.
 * Most fields have sensible defaults; advanced callers can override.
 */
export interface InitialVaultConfig {
  /** Owner payment key hash (28-byte hex). The only key authorized to
   *  sign owner-required actions (InstantGen, ScheduleCommit, UpdateProfile,
   *  BurnBatch, WithdrawLamp). ScheduleFire is permissionless. */
  ownerPkh: string;
  /** Initial LAMP locked into the vault, in oildrop (1 LAMP = 10^6 oildrop).
   *  Caller's wallet MUST hold ≥ this amount of LAMP. */
  lampDeposit: bigint;
  /** Profile at creation. Default "Flame". */
  profile?: Profile;
  /** Min-ADA lovelace to attach to vault UTxO (default 2_000_000). */
  vaultLovelace?: bigint;
  /** @deprecated KHÔNG dùng được lúc tạo vault.
   *  `validate_mint_vault_id` ép `personal_delegate == None` ở datum khởi sinh
   *  (genesis phải sạch). Truyền giá trị khác null ⇒ createVault ném lỗi.
   *  Đặt uỷ quyền cá nhân bằng redeemer `SetDelegate` sau khi vault đã tồn tại. */
  personalDelegate?: string | null;
}

/** Inputs to `createVault()`. */
export interface CreateVaultParams {
  /** Lucid Evolution instance with a wallet already selected. */
  lucid: LucidEvolution;
  /** Which mechanism this vault will be used for. */
  vaultType: VaultType;
  /** Network + policy configuration. */
  protocol: ProtocolParams;
  /** Validator script CBOR (unapplied). */
  validators: ValidatorBundle;
  /** Initial vault state. */
  vault: InitialVaultConfig;
  /** Override current epoch derivation (for deterministic tests). */
  tipPosixMs?: bigint;
  /** Seed UTxO cho NFT danh-tính vault (INV-VAULT-IDENTITY). Bỏ trống thì SDK
   *  tự chọn tất định từ UTxO của ví. UTxO này BẮT BUỘC là input của tx tạo
   *  vault; tên NFT = blake2b_256(cbor.serialise(OutputReference của nó)). */
  seedUtxo?: UTxO;
}

/** Result of `createVault()` — ready for caller to sign + submit. */
export interface CreateVaultResult {
  /** Built tx (TxSignBuilder). Caller calls `.sign.withWallet().complete()` then `.submit()`. */
  tx: TxSignBuilder;
  /** Network-specific vault address (where the vault UTxO will live). */
  vaultAddress: string;
  /** Network-specific vault script hash (after applyParamsToScript). */
  vaultScriptHash: string;
  /** Applied vault script (for downstream tx builders that need
   *  `.attach.SpendingValidator(vaultScript)`). */
  vaultScript: Validator;
  /** Policy ID của NFT danh-tính vault. BẰNG ĐÚNG `vaultScriptHash`: vault là
   *  validator đa-mục-đích, handler `mint` chạy dưới chính script hash đó. */
  vaultIdPolicyId: string;
  /** Tên asset (hex) của NFT danh-tính = blake2b_256(cbor.serialise(seed)). */
  vaultIdAssetName: string;
  /** `policyId + assetName` — unit dùng trực tiếp với Lucid. */
  vaultIdUnit: string;
  /** UTxO đã dùng làm seed one-shot (đã được ép vào inputs của tx). */
  seedUtxo: UTxO;
  /** Human-readable summary for logs / UI. */
  summary: string;
}
