// VaultReadAPI/src/index.ts — mặt tiền công khai của gói.
//
// Xuất TƯỜNG MINH, không `export *`: mọi cái tên ở đây là lời hứa, đổi nó là breaking.

export { readVaultsFromUtxos } from "./vaultView.js";
export type {
  VaultView, BatchView, GenScheduleView, IgnoredUtxo, ReadVaultsResult,
} from "./vaultView.js";

export { VaultReadService, toJsonBody } from "./service.js";
export type { ReadRequest, ReadOutcome } from "./service.js";

export { BlockfrostChainReader, RecordedChainReader } from "./chain.js";
export type { ChainReader, ChainUtxo, ChainTip, BlockfrostReaderOptions } from "./chain.js";

export { handle } from "./http.js";
export type { HttpRequest, HttpResponse, RouterDeps } from "./http.js";

export { loadConfig, parseScopes, isLoopback } from "./config.js";
export type { AppConfig, VaultScope } from "./config.js";

export {
  VaultReadError,
  ChainUnavailableError,
  VaultDatumUndecodableError,
  VaultIdentityDuplicateError,
  BadRequestError,
  UnauthorizedError,
  UnknownVaultScopeError,
} from "./errors.js";
