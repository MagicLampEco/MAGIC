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

// Khuôn `wakeme_link` của két Instant (rỗng hoặc 32 byte = `owner_commit` của DID). Lớp dịch vụ
// kiểm đầu vào bằng đúng hàm SDK dùng để dựng datum genesis.
export { normalizeWakemeLink, WAKEME_LINK_RE } from "./vaultDatum.js";

// Cổng `lampPolicyId`. Xuất ra vì lớp ứng dụng thường nhận policy id từ cấu hình của
// CHÍNH NÓ (biến môi trường, tệp JSON) rồi mới gọi SDK — kiểm được ở đó thì lỗi lộ ra
// lúc nạp cấu hình, không phải lúc dựng giao dịch. Xem đầu `lampPolicy.ts` về thứ
// danh sách từ chối chống được và thứ nó KHÔNG chống được.
export {
  assertLampPolicyId,
  isRehearsalAcknowledged,
  NON_LAMP_LOOKALIKE_POLICIES,
  SUPERSEDED_LAMP_POLICIES,
  REHEARSAL_LAMP_POLICIES,
} from "./lampPolicy.js";

// Script tham chiếu CIP-33. Xuất ra vì bên tích hợp nào tự dựng giao dịch cũng cần
// phép kiểm này: đọc từ một UTxO mang script SAI vẫn dựng ra giao dịch, và nó chết
// trên chuỗi SAU khi người dùng đã ký. Xem đầu `refScript.ts` cho số đo trần 16 384 B.
export {
  assertRefScriptMatches,
  assertRefScriptsMatchAll,
  resolveRefScript,
  ACCEPT_INLINE_SCRIPT_CEILING,
  type AcceptInlineScriptCeiling,
} from "./refScript.js";

// NFT danh-tính vault (INV-VAULT-IDENTITY) — mọi integrator tự dựng tx tạo vault
// đều cần đúng hai thứ này, nếu không vault sinh ra sẽ KHÔNG tiêu được.
export {
  vaultIdAssetName,
  vaultIdSeedCbor,
  type VaultIdSeed,
} from "./vaultId.js";
export { VaultIdRedeemerSchema } from "./schemas.js";

// KIỂU của thứ `Data.from(…, VaultDatumSchema)` trả về. Lược đồ đã xuất từ trước, kiểu
// thì chưa — nên mã ngoài đọc được datum nhưng không khai nổi biến giữ nó, và phải tự
// viết lại `ReturnType<typeof Data.from<typeof VaultDatumSchema>>`. Một biểu thức chép
// tay như thế là bản sao sẽ chết im lặng lúc lược đồ đổi hình. Xuất thêm là cộng, không
// phá: không cái tên nào đổi nghĩa.
export type { VaultDatum } from "./schemas.js";

// ── Hai hình dạng datum két (Gen v2.0) ───────────────────────────────────────
// `VaultDatumSchema` tả 19 trường (ScheduleGen), `InstantVaultDatumSchema` 20 trường
// (InstantGen) — cả hai TÁI XUẤT từ gói nền, không chép. Datum đời v1 (18/17 trường)
// ⟹ NÉM `VAULT_DATUM_V1`: v2.0 là hash mới, không di trú. Đã biết loại két ⟹
// `decodeVaultDatumOfKind`; chưa biết ⟹ `decodeVaultDatumEitherShape`.
export {
  InstantVaultDatumSchema,
  OwnerCredentialSchema,
  VAULT_DATUM_FIELD_COUNTS,
  decodeVaultDatumEitherShape,
  decodeVaultDatumOfKind,
} from "./schemas.js";

// Apply-param theo loại két, dựng từ `ProtocolParams` — bộ dựng InstantGen/ScheduleGen
// đòi đúng các giá trị đã apply vào két. Thứ tự tham số do gói nền giữ.
export {
  instantVaultParamsFromProtocol,
  windowOriginOf,
  scheduleScriptParamsFromProtocol,
  buildParamsList,
  buildCommitParamsList,
  type AppliedVault,
} from "./validatorScripts.js";

// Hai reference input của lượt làm mới checkpoint két InstantGen (beacon ρ, két Wakeme).
export {
  readRateBeacon,
  readWakemeForVault,
  readCheckpointRefs,
  vaultIdentityOf,
  type InstantRefParams,
  type CheckpointRefsRead,
} from "./genV2Refs.js";
export type {
  InstantVaultDatum,
  VaultDatumShapeKind,
  VaultDatumEitherShape,
} from "./schemas.js";

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
// Chỉ có InstantGen + ScheduleGen: VacuumGen/SnapshotGen đã ở `Legacy/`.
// Gen v2.0: `diagnoseCeilings` đã BỎ ⟹ `instantGenLimits(ctx).maxM`. Xem generate.ts.
export {
  buildInstantGenTx,
  buildRefreshCheckpointTx,
  instantGenLimits,
  computeInstantGenOutputs,
  computeRefreshCheckpointOutput,
  applyInstantVaultParams,
  vaultShardId,
  shardNftName,
  readWakemeVault,
  expectedCheckpoint,
  expectedCheckpointForGen,
  currentCheckpoint,
  INSTANT_VAULT_PARAM_TITLES,
  buildScheduleCommitTx,
  buildScheduleFireTx,
  buildRegisterCommitStakeTx,
  applyScheduleScripts,
  SCHEDULE_COMMIT_PARAM_NAMES,
  SCHEDULE_VAULT_PARAM_NAMES,
  NANOGIC_DECIMALS,
  NANOGIC_PER_MAGIC,
  OILDROP_DECIMALS,
  OILDROP_PER_LAMP,
  type InstantGenParams,
  type InstantGenResult,
  type InstantGenContext,
  type InstantGenLimits,
  type InstantGenOutputs,
  type RefreshCheckpointParams,
  type RefreshCheckpointResult,
  type InstantVaultParams,
  type Checkpoint,
  type WakemeRead,
  type LentReadContext,
  type RateParam,
  type GreenBackBeacon,
  type GbShard,
  type CommitParams,
  type CommitResult,
  type FireParams,
  type FireResult,
  type GenBeaconParams,
  type RegisterCommitStakeParams,
  type ScheduleScriptParams,
  type ScheduleScripts,
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
  // ConsumeMany (redeemer constr 3, 2026-10-03): nhiều loại nghiệp vụ trong MỘT tx. `required`
  // của nó = Σ sàn TỪNG cặp (`requiredFromBeaconPairs`), KHÁC quy tắc gộp-rồi-sàn của Consume đơn.
  buildConsumeManyTx,
  requiredFromBeaconPairs,
  decodeConsumeLineRedeemer,
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
  type ConsumeManyParams,
  type ConsumeLineRedeemerT,
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
  MVP_PRICE_TABLE,
  FIXED_PRICE_OP_TYPES,
  OP_IMAGE,
  OP_CID,
  OP_RECOGNITION_STORAGE,
  OP_RECOGNITION_COMPUTE,
  // Hình dạng + giá của `pairs` (ConsumeMany) — gương `pricing.valid_pairs` / `required_for_pairs`.
  assertValidPairs,
  requiredForPairs,
  sumPairCounts,
  MAX_CONSUME_PAIRS,
  type OpPairLike,
  M_MIN_Q,
  M_MAX_Q,
  Q as PRICING_Q,
} from "@magiclamp/consumemagic-pricing";

// ── Bên VAULT của một lần tiêu MAGIC ─────────────────────────────────────────
// `buildConsumeTx` lo bên Engage + định giá, nhưng hai tham số thuộc về vault thì nó
// đòi caller tự dựng: `vaultBurnRedeemerCbor` và `vaultOutDatumCbor`. Trước khi có
// `burnBatch.ts`, chỗ duy nhất trong kho biết dựng chúng là một kịch bản test — nên
// mọi app tích hợp phải tự đọc `VaultDatum` 17 trường và tự làm kế toán A02, mà sai
// một trường là vault từ chối tx không nói trường nào. Đó là mảnh chặn thật giữa
// "SDK xuất đủ tên ConsumeMAGIC" và "OriLife/AladinWork gọi được".
export {
  buildVaultBurnBatch,
  planBurnBatch,
  isBatchExpired,
  applyPendingProfile,
  type VaultModule,
  type BuildVaultBurnBatchParams,
  type BuildVaultBurnBatchResult,
  type BurnBatchPlan,
  type BurnEntry,
  type MagicBatchLike,
} from "./burnBatch.js";

// ── Chủ là `Credential` — đọc tham số chủ + nhân chứng chủ `did_stake` (PhoenixKey) ──
// Chủ script chứng minh quyền bằng một mục rút `Script(h)`; `didStakeOwnerAuthLucid` dựng
// `OwnerAuth` đó cho đúng một loại script chủ. Chính sách nằm ở `@magiclamp/protocol-utils`.
export { resolveOwnerInput } from "./ownerInput.js";
export {
  didStakeLucidPorts, didStakeOwnerAuthLucid, didAnchorNftName, didStakeScriptForDid,
  type DidStakeScriptForDidInput,
} from "./didStakeLucid.js";
export {
  OwnerAuthError, didStakeOwnerAuth, DID_STAKE_AUTHORIZE_REDEEMER,
  ownerRefOf, ownerRefToString, sameOwner,
  type OwnerAuth, type OwnerRef, type OwnerAuthErrorCode,
  type DidStakeOwnerAuth, type DidStakeWitnessInput, type DidStakeWitnessDetails,
  type RewardAccountState,
} from "@magiclamp/protocol-utils";

// ── Nạp LAMP từ ví Phoenix (script `did_payment`) — `createVault({ funding })` ──
export {
  didPaymentLucidPorts, DID_PAYMENT_FEE_HEADROOM_LOVELACE, type DidPaymentFundingInput,
} from "./didPaymentLucid.js";
export {
  FundingError, assertDidPaymentAddress, planDidPaymentFunding,
  DID_PAYMENT_SPEND_REDEEMER, FUNDING_MAX_VALIDITY_MS,
  type FundingErrorCode, type DidPaymentPorts, type DidPaymentPlan, type FundingUtxoLike,
} from "@magiclamp/protocol-utils";

// ── Hành trình tài trợ consume đầu của người mới (két PrepaidGen) ───────────
// T1 mở két + thread · T2 CARP bên tài trợ vào quỹ đã ghim (mang anchor DID) · T3 Draw · T4 consume
// đầu, T3/T4 cùng kỳ. SDK ép hình dạng; chính sách tài trợ (mỗi DID một lần) là của bên tài trợ.
export {
  buildSponsorT1OpenPrepaid,
  buildSponsorT2Fund,
  buildSponsorT3Draw,
  buildSponsorT4FirstConsume,
  planSponsorJourney,
  assertSponsorDidCommit,
  assertSponsorCarpOutputs,
  txOutputsOf as sponsorTxOutputsOf,
  txReferenceInputsOf as sponsorTxReferenceInputsOf,
  txWithdrawalCountOf as sponsorTxWithdrawalCountOf,
  SponsorJourneyError,
  type SponsorJourneyErrorCode,
  type SponsorTxOutput,
  type SponsorTxResult,
  type NewcomerAnchorRef,
  type SponsorCarpExpect,
  type SponsorT1Params,
  type SponsorT1Summary,
  type SponsorT2Params,
  type SponsorT2Summary,
  type SponsorT3Params,
  type SponsorT3Summary,
  type SponsorT4Params,
  type SponsorT4Summary,
  type SponsorJourneyPlanInput,
  type SponsorJourneyStep,
  type SponsorJourneyPlan,
} from "./sponsorJourney.js";
