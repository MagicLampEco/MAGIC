// MagicSDK/src/index.ts — public exports for @magiclamp/sdk
//
// This is the SOLE entry point for any integrator (PhoenixKey or otherwise).
// All exported names are part of the public API contract — breaking changes
// require a semver-major bump.

export {
  createVault,
  pickSeedUtxo,
  applyVaultValidator,
  applyShardValidator,
  buildInitialVaultDatum,
  VaultDatumSchema,
} from "./createVault.js";

// NFT danh-tính vault (INV-VAULT-IDENTITY) — mọi integrator tự dựng tx tạo vault
// đều cần đúng hai thứ này, nếu không vault sinh ra sẽ KHÔNG tiêu được.
export {
  vaultIdAssetName,
  vaultIdSeedCbor,
  type VaultIdSeed,
} from "./vaultId.js";
export { VaultIdRedeemerSchema } from "./schemas.js";

export {
  listVaultsForOwner,
  type VaultRecord,
  type ListVaultsParams,
} from "./listVaults.js";

export {
  withdrawLamp,
  removeNewestFirst,
  type WithdrawLampParams,
  type WithdrawLampResult,
} from "./withdrawLamp.js";

export {
  updateProfile,
  PROFILE_COOLDOWN,
  type UpdateProfileParams,
  type UpdateProfileResult,
} from "./updateProfile.js";

export {
  resolveConstrIndex,
  loadPlutusJson,
  type PlutusJson,
} from "./redeemerIndex.js";

// MAGIC generation — the only supported way for an app to trigger a gen tx.
// Chỉ có InstantGen + ScheduleGen: VacuumGen/SnapshotGen đã ở
// `Legacy/` (xem generate.ts). Cũng xem generate.ts cho điều kiện
// fail-closed của BackingBeacon trên InstantGen.
export {
  buildInstantGenTx,
  diagnoseCeilings,
  buildScheduleCommitTx,
  buildScheduleFireTx,
  NANOGIC_DECIMALS,
  NANOGIC_PER_MAGIC,
  OILDROP_DECIMALS,
  OILDROP_PER_LAMP,
  type InstantGenParams,
  type InstantGenResult,
  type CommitParams,
  type CommitResult,
  type FireParams,
  type FireResult,
} from "./generate.js";

export type {
  Profile,
  VaultType,
  ProtocolParams,
  ValidatorBundle,
  InitialVaultConfig,
  CreateVaultParams,
  CreateVaultResult,
} from "./types.js";

// Re-export Network for convenience so callers don't need a separate import
// from @magiclamp/protocol-utils for the most common type.
export type { Network } from "@magiclamp/protocol-utils";

// ── ConsumeMAGIC — TIÊU MAGIC ────────────────────────────────────────────────
// Trước 2026-08-29 kho có đủ lớp ConsumeMAGIC nhưng SDK không xuất một tên nào
// của nó: một app tích hợp sinh được MAGIC mà không có API nào để tiêu. Đó là
// chốt chặn thật giữa "E2E chạy được một lần" và "OriLife/AladinWork gọi được".
//
// Xuất TƯỜNG MINH, không `export *`: `consume.ts` re-export `toUnit` của lucid và
// `types.ts` mang nhiều schema nội bộ — gom hết vào mặt tiền công khai là dựng ra
// những cái tên mà đổi đi là breaking change, dù không ai định hứa.
export {
  buildConsumeTx,
  buildMintEngageTx,
  buildPostPriceTx,
  postPriceRedeemerCbor,
  requiredFromBeacon,
  signAndSubmit as submitConsumeTx,
  engageAssetName,
  engageNftUnit,
  engageSeedCbor,
  encodeEngageDatum,
  decodeEngageDatum,
  encodePriceParam,
  decodePriceParam,
  type ConsumeParams,
  type ConsumeResult,
  type MintEngageParams,
  type MintEngageResult,
  type PostPriceParams,
  type PostPriceResult,
  type EngageIdSeed,
  type EngageDatumT,
  type PriceParamT,
  type OpPriceT,
} from "@magiclamp/consumemagic";

// Bảng giá + số học định giá: app cần chúng để BÁO GIÁ TRƯỚC cho người dùng, chứ
// không phải để tính tiền — `required` có thẩm quyền luôn đọc từ beacon
// (`requiredFromBeacon`). Hai đường phải cho cùng số; lệch là tx bị từ chối.
export {
  requiredForOp,
  pricePerOp,
  demandMult,
  assertValidPriceParam,
  MVP_BASE_PRICE,
  OP_IMAGE,
  OP_CID,
  M_MIN_Q,
  M_MAX_Q,
  Q as PRICING_Q,
} from "@magiclamp/consumemagic-pricing";
