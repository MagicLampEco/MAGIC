// VaultReadAPI/src/index.ts — mặt tiền công khai của gói.
//
// Xuất TƯỜNG MINH, không `export *`: mọi cái tên ở đây là lời hứa, đổi nó là breaking.

export { readVaultsFromUtxos } from "./vaultView.js";
export type {
  VaultView, BatchView, GenScheduleView, EpochUsageView, IgnoredUtxo, ReadVaultsResult,
} from "./vaultView.js";
export { readPrepaidVaultsFromUtxos } from "./prepaidView.js";
export type {
  PrepaidVaultView, PrepaidBatchView, PrepaidCreditView, ReadPrepaidVaultsResult,
} from "./prepaidView.js";

export { VaultReadService, toJsonBody } from "./service.js";
export type { ReadRequest, ReadOutcome, AnyVaultView } from "./service.js";

export { BlockfrostChainReader, RecordedChainReader, normalizeTxEffect } from "./chain.js";
export type {
  ChainReader, ChainUtxo, ChainTip, BlockfrostReaderOptions,
  ChainHistoryReader, ChainPoint, AddressTx, OutRef, AddressedUtxo, ChainTxEffect,
} from "./chain.js";

export { ThreadIndex, classifyThreadUtxo, threadToJson, freshnessToJson } from "./threadIndex.js";
export type {
  ThreadEntry, ThreadOwner, SkippedThread, SkipReason, ThreadClass, FreshnessView, ThreadIndexOptions,
} from "./threadIndex.js";

export { handle } from "./http.js";
export type { HttpRequest, HttpResponse, RouterDeps } from "./http.js";

export { loadConfig, parseScopes, parseConsumeScopes, isLoopback } from "./config.js";
export type { AppConfig, VaultScope, ConsumeScope, ThreadIndexConfig } from "./config.js";

export {
  VaultReadError,
  ChainUnavailableError,
  VaultDatumUndecodableError,
  VaultDatumV1Error,
  VaultIdentityDuplicateError,
  BadRequestError,
  UnauthorizedError,
  UnknownVaultScopeError,
  IndexStaleError,
  ThreadIndexDisabledError,
  ThreadNotFoundError,
  UnknownConsumeScopeError,
  ThreadDatumUndecodableError,
  ThreadIdentityDuplicateError,
} from "./errors.js";
