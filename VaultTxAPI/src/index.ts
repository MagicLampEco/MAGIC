// VaultTxAPI/src/index.ts — mặt tiền của gói, dùng cho phép kiểm và cho ai nhúng thẳng.
//
// Gói này KHÔNG xuất bất cứ thứ gì liên quan tới ký. Nó dựng giao dịch CHƯA KÝ; việc ký
// xảy ra trong Secure Enclave của máy người dùng, ngoài tầm tiến trình này.

export { loadConfig, parseDeployment, isLoopback } from "./config.js";
export type {
  AppConfig, Deployment, VaultScope, ConsumeDeployment, OutRefConfig, ChangeAddressStrategy,
} from "./config.js";

export {
  TxApiError, BadRequestError, UnauthorizedError, VaultNotFoundError, VaultAmbiguousError,
  VaultIdentityDuplicateError, OwnerTxInFlightError, TxBuildRejectedError, ChainUnavailableError,
  VaultDatumUndecodableError, TxSummaryUndecodableError, SubmitRejectedError, newReferenceCode,
} from "./errors.js";

export { BlockfrostChainReader, RecordedChainReader } from "./chain.js";
export type { ChainReader, ChainTip, OutRef } from "./chain.js";

export { OwnerLockTable, PENDING_TX_HASH } from "./locks.js";
export type { LockRecord } from "./locks.js";

export { summarizeTx, txBodyHash } from "./summary.js";
export type { TxSummary, SummaryContext, RequestedIntent, OutputView } from "./summary.js";

export { decodeVaultDatumOrThrow } from "./vaultDatumShape.js";
export type { DecodedVaultDatum, DecodedMagicBatch } from "./vaultDatumShape.js";

export { findVaultsAtScope, pickSingleVault, vaultIdUnitOf } from "./vaultLookup.js";
export type { FoundVault, IgnoredUtxo } from "./vaultLookup.js";

export { SdkTxBuilder, RecordedTxBuilder, enterpriseAddressOf, vaultModuleOf } from "./txBuilder.js";
export type { TxBuilderPort, BuildContext, BuiltTx, SdkTxBuilderDeps } from "./txBuilder.js";

export { VaultTxService, toBuildBody, toSubmitBody } from "./service.js";
export type { BuildResponse, SubmitResponse, VaultTxServiceDeps } from "./service.js";

export { handle } from "./http.js";
export type { HttpRequest, HttpResponse, RouterDeps } from "./http.js";

export {
  decimal, raw, oildropToLamp, nanogicToMagic, lovelaceToAda,
  OILDROP_PER_LAMP, NANOGIC_PER_MAGIC, Q,
} from "./units.js";
