// VaultTxAPI/src/index.ts — mặt tiền của gói, dùng cho phép kiểm và cho ai nhúng thẳng.
//
// Gói này KHÔNG xuất bất cứ thứ gì liên quan tới ký. Nó dựng giao dịch CHƯA KÝ; việc ký
// xảy ra trong Secure Enclave của máy người dùng, ngoài tầm tiến trình này.

export { loadConfig, parseDeployment, isLoopback, PREPAID_VAULT_TYPE } from "./config.js";
export type {
  AppConfig, Deployment, VaultScope, ConsumeDeployment, OutRefConfig, ChangeAddressStrategy,
  PrepaidDeployment,
} from "./config.js";

export {
  TxApiError, BadRequestError, UnauthorizedError, VaultNotFoundError, VaultAmbiguousError,
  VaultIdentityDuplicateError, OwnerTxInFlightError, TxBuildRejectedError, ChainUnavailableError,
  VaultDatumUndecodableError, TxSummaryUndecodableError, SubmitRejectedError, TxSupersededError, newReferenceCode,
  CodedApiError, ownerApiErrorOf,
} from "./errors.js";

export {
  parseOwnerFields, parseOwnerWitness, ownerLockKey, isDidOwner, DidStakeWitnessProvider,
} from "./owner.js";
export type {
  ScriptOwnerWitness, ResolvedOwnerWitness, OwnerWitnessProvider, DidStakeProviderDeps,
  DidOwnerInput, OwnerInput,
} from "./owner.js";
export { DidOwnerResolver, resolveOwnerInput, taadFieldsOf, TAAD_DATUM_FIELD_COUNT } from "./didOwner.js";
export type {
  DidOwnerResolverDeps, DidOwnerResolverPort, ResolvedDidOwner, WithResolvedOwner,
} from "./didOwner.js";

export { BlockfrostChainReader, RecordedChainReader } from "./chain.js";
export type { ChainReader, ChainTip, OutRef } from "./chain.js";

export { IssuedTxRegistry, OwnerLockTable, PendingSpends, PENDING_TX_HASH, ISSUED_ROUTES } from "./locks.js";
export type { IssuedRoute, IssuedTxMeta, IssuedTxEntry } from "./locks.js";
export { FeeProxy } from "./feeProxy.js";
export type { FeeProxyDeps, FetchLike } from "./feeProxy.js";
export type { LockRecord } from "./locks.js";

export { summarizeTx, summarizeCreateVaultTx, txBodyHash } from "./summary.js";
export type {
  TxSummary, SummaryContext, RequestedIntent, OutputView, CreateVaultSummary,
} from "./summary.js";

export { decodeVaultDatumOrThrow } from "./vaultDatumShape.js";
export type { DecodedVaultDatum, DecodedMagicBatch } from "./vaultDatumShape.js";

export { findVaultsAtScope, pickSingleVault, vaultIdUnitOf } from "./vaultLookup.js";
export type { FoundVault, IgnoredUtxo } from "./vaultLookup.js";

export { SdkTxBuilder, RecordedTxBuilder, enterpriseAddressOf, vaultModuleOf } from "./txBuilder.js";
export type {
  TxBuilderPort, BuildContext, BuiltTx, SdkTxBuilderDeps, OpenThreadContext, BuiltOpenThread, BindDidContext,
} from "./txBuilder.js";
export {
  pickEngageThread, threadsOf, checkOpenThreadTx, parseEngageRef, checkBindDidTx, parseDidCommit, didCommitOf,
} from "./engage.js";
export type { EngageThread, OpenThreadSummary, BindDidSummary } from "./engage.js";
export { parseWakemeVaultRef, resolveWakemeVault, checkWakemeRefInTx, referenceInputRefsOf } from "./wakeme.js";
export type { WakemeSummary, WakemeNotCountedReason, ResolvedWakeme } from "./wakeme.js";
export { checkFeePayerTx, parseFeePayer } from "./feePayer.js";
export type { FeePayerRequest, FeePayerSummary } from "./feePayer.js";

export { VaultTxService, toBuildBody, toOpenThreadBody, toBindDidBody, toSubmitBody } from "./service.js";
export type {
  BuildResponse, OpenThreadResponse, BindDidRequest, BindDidResponse, SubmitResponse, VaultTxServiceDeps,
} from "./service.js";

export {
  SponsorTxService, sponsorRoute, sponsorPlanBody, sponsorApiErrorOf, parseSponsorRequest, toSponsorBody,
  SPONSOR_ERROR_STATUS, SPONSOR_STEP_OF_PATH,
} from "./sponsor.js";
export type {
  SponsorTxServiceDeps, SponsorBuildResponse, SponsorSigner, SponsorStep, LucidForWallet,
  SponsorT1Request, SponsorT2Request, SponsorT3Request, SponsorT4Request,
} from "./sponsor.js";
export type { SponsorRoute } from "./locks.js";

export { handle } from "./http.js";
export type { HttpRequest, HttpResponse, RouterDeps } from "./http.js";

export {
  decimal, raw, oildropToLamp, nanogicToMagic, lovelaceToAda,
  OILDROP_PER_LAMP, NANOGIC_PER_MAGIC, Q,
} from "./units.js";
