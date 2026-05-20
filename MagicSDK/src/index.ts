// MagicSDK/src/index.ts — public exports for @magiclamp/sdk
//
// This is the SOLE entry point for any integrator (PhoenixKey or otherwise).
// All exported names are part of the public API contract — breaking changes
// require a semver-major bump.

export {
  createVault,
  applyVaultValidator,
  applyShardValidator,
  buildInitialVaultDatum,
  VaultDatumSchema,
} from "./createVault.js";

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
