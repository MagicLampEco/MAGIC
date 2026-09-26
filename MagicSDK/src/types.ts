// MagicSDK/src/types.ts — public types for createVault and friends
import type { LucidEvolution, TxBuilder, TxSignBuilder, UTxO, Validator } from "@lucid-evolution/lucid";
import type { Network, OwnerAuth, OwnerRef } from "@magiclamp/protocol-utils";
import type { PlutusJson } from "./redeemerIndex.js";
import type { DidPaymentFundingInput } from "./didPaymentLucid.js";

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
 * different addresses).
 *
 * 🔴 Hình dạng datum KHÔNG còn giống nhau giữa hai loại: két `Instant` mang thêm
 * trường 17 `instant_unlock_ms` (18 trường) trong khi `Schedule` giữ 17. Lược đồ
 * và lý do: `schemas.ts` đầu tệp. Bản trước của dòng này khai ngược.
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
   *  Người GHI beacon là keeper tầng GreenBack của CHÍNH kho này (khoá
   *  `greenback_beacon_writer`, SPEC v2.0 §6.3), không phải nhà CARP — xem
   *  `BOUNDARIES.md` ▸ "`B` là một DANH MỤC token". Lược đồ datum: `DevStatus.md` Nợ #2.
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
  /** Chủ vault — `Credential` dạng JSON (`{ type: "key" | "script", hash }`). Chủ là người
   *  DUY NHẤT qua được `owner_authorized` ở các nhánh cần quyền chủ (InstantGen,
   *  ScheduleCommit, UpdateProfile, BurnBatch, WithdrawLamp — và cả genesis).
   *  ScheduleFire không cần chủ. Truyền `owner` HOẶC bí danh `ownerPkh`; cả hai thì phải
   *  cùng chủ (xem `ownerInput.ts`). */
  owner?: OwnerRef;
  /** Bí danh nhánh khoá: `ownerPkh: h` ≡ `owner: { type: "key", hash: h }`. */
  ownerPkh?: string;
  /** Initial LAMP locked into the vault, in oildrop (1 LAMP = 10^6 oildrop).
   *  Caller's wallet MUST hold ≥ this amount of LAMP. */
  lampDeposit: bigint;
  /** Profile at creation. Default "Flame". */
  profile?: Profile;
  /** Lovelace gắn vào UTxO két. **Bỏ trống là đường ĐÚNG** — SDK tính min-ADA
   *  từ chính datum sắp ghi (`minAdaVault.ts`).
   *
   *  Vì sao không còn một hằng: UTxO két mang datum cộng LAMP cộng NFT danh-tính,
   *  và datum phình theo `magic_batches` (trần 32) và `loyalty_holdings`
   *  (trần 40). Hằng 2 ADA của bản trước đúng ở két rỗng và thiếu 0,23 ADA ngay
   *  từ batch ĐẦU TIÊN; ở trần thì thiếu gần 13 ADA. Sổ cái từ chối một output
   *  thiếu min-ADA ở lúc GỬI — tức sau khi người dùng đã ký.
   *
   *  Truyền tay thì chỉ được LỚN HƠN mức tính được; nhỏ hơn thì `createVault`
   *  NÉM chứ không âm thầm nâng lên. Âm thầm nâng là dựng một vỏ im lặng ở đúng
   *  chỗ người gọi cần biết mình đã nhầm. */
  vaultLovelace?: bigint;
  /** @deprecated 🪦 KHÔNG còn đường nào dùng được — nhánh uỷ nhiệm bị bỏ khỏi mô
   *  hình ngày 2026-09-16 (Nợ #14). `validate_mint_vault_id` ép
   *  `personal_delegate == None` ở datum khởi sinh, và redeemer `SetDelegate`
   *  nay chỉ XOÁ được. Truyền giá trị khác null ⇒ createVault ném lỗi.
   *
   *  Trường ở lại trong kiểu để người gọi cũ nhận một câu nói rõ chuyện gì đã
   *  đổi, thay vì một lỗi kiểu không nói gì. */
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
  /** Validator script CBOR (unapplied). Truyền ĐÚNG MỘT trong `validators` và
   *  `appliedVault`. */
  validators?: ValidatorBundle;
  /** Script vault ĐÃ apply (ví dụ đọc từ UTxO script tham chiếu của lần deploy). Dùng khi
   *  bên gọi không giữ blueprint + đủ tham số để tự apply. `expectedScriptHash` BẮT BUỘC:
   *  script băm ra khác nó ⟹ NÉM, không tạo vault ở một địa chỉ ngoài cấu hình. */
  appliedVault?: { script: Validator; expectedScriptHash: string };
  /** Chứng minh quyền chủ ở genesis (`validate_mint_vault_id` ép `owner_authorized`).
   *  Bỏ trống: chủ khoá ⟹ `addSignerKey(pkh)`; chủ script ⟹ NÉM
   *  `OWNER_SCRIPT_WITNESS_UNAVAILABLE`. */
  ownerAuth?: OwnerAuth<TxBuilder>;
  /** Initial vault state. */
  vault: InitialVaultConfig;
  /** Override current epoch derivation (for deterministic tests). */
  tipPosixMs?: bigint;
  /** Seed UTxO cho NFT danh-tính vault (INV-VAULT-IDENTITY). Bỏ trống thì SDK
   *  tự chọn tất định từ UTxO của ví. UTxO này BẮT BUỘC là input của tx tạo
   *  vault; tên NFT = blake2b_256(cbor.serialise(OutputReference của nó)). */
  seedUtxo?: UTxO;
  /** Nạp LAMP + min-ADA của vault từ ví Phoenix (script `did_payment`) thay vì từ ví đang
   *  chọn. Có trường này thì ví đang chọn CHỈ trả phí + làm tài sản thế chấp + làm seed;
   *  phần thối của `did_payment` về lại `funding.address`. Xem `didPaymentLucid.ts`. */
  funding?: DidPaymentFundingInput;
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
  /** Chủ đã ghi vào datum. */
  owner: OwnerRef;
  /** Human-readable summary for logs / UI. */
  summary: string;
  /** Chỉ khi có `funding`: UTxO `did_payment` đã chi, tổng chi, và output thối về ví Phoenix. */
  funding?: {
    selected: UTxO[];
    spent: Record<string, bigint>;
    returned: Record<string, bigint> | null;
  };
}
