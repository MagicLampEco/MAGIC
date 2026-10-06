// VaultTxAPI/src/service.ts — nối bốn mảnh: tìm vault → dựng → ĐỌC LẠI CBOR → trả về.
//
// Thứ tự trong `buildOne` không phải chuyện phong cách:
//
//   1. giành khoá mềm TRƯỚC khi đọc chuỗi — khe đua nằm giữa hai lần đọc UTxO, không
//      nằm sau lúc dựng (`locks.ts` nói vì sao khoá giữ tới lúc nộp)
//   2. đọc đỉnh chuỗi TRƯỚC — hỏng ở đây ⟹ `CHAIN_UNAVAILABLE`, không ⟹ "chưa có vault"
//   3. dựng
//   4. ĐỌC LẠI chính CBOR vừa dựng để ra `summary` — bước này KHÔNG nhận tham số yêu cầu
//   5. hỏng ở bất kỳ bước nào ⟹ NHẢ khoá, nếu không một lần lỗi khoá chủ đó suốt thời hạn
//
// Bước 4 là lý do gói này tồn tại ở dạng hiện tại. Xem `summary.ts`.

import { CML, type UTxO } from "@lucid-evolution/lucid";
import {
  FUNDING_MAX_VALIDITY_MS, FundingError, OwnerAuthError, posixMsToEpoch, sameOwner, type Network, type OwnerRef,
} from "@magiclamp/protocol-utils";
import type { InstantGenLimits } from "@magiclamp/instantgen-sdk";
import type { Profile } from "@magiclamp/sdk";
import {
  assertFundingAddresses, checkFundingTx, checkSelfFundedTx, fundingApiErrorOf, fundingWitnessOf,
  readCollateralUtxo, readFeePayerUtxo,
  type DidPaymentAnchorReader, type FundingRequest,
} from "./funding.js";

import type { ChainReader, ChainTip } from "./chain.js";
import { PREPAID_VAULT_TYPE, type Deployment, type VaultScope } from "./config.js";
import {
  checkBindDidTx, checkOpenThreadTx, didCommitOf, parseDidCommit, pickEngageThread, threadsOf,
  type BindDidSummary, type OpenThreadSummary,
} from "./engage.js";
import {
  FEE_PAYER_CODES, assertFeePayerAddress, assertNoOwnerRewardToFeePayer, checkFeePayerTx, inputRefsOf,
  readFeePayerUtxo as readFeePayerUtxoShared, type FeePayerFronting, type FeePayerSharedFronting,
  refStr, type FeePayerRequest, type FeePayerSummary, type OutRefLike,
} from "./feePayer.js";
import {
  BadRequestError, CodedApiError, ConfigMissingError, SubmitRejectedError, TxSummaryUndecodableError,
  TxSupersededError, ownerApiErrorOf,
} from "./errors.js";
import {
  ownerLockKey, type OwnerInput, type OwnerWitnessProvider, type ResolvedOwnerWitness, type ScriptOwnerWitness,
} from "./owner.js";
import { resolveOwnerInput, type DidOwnerResolverPort, type WithResolvedOwner } from "./didOwner.js";
import { IssuedTxRegistry, OwnerLockTable, PendingSpends, submissionStateOf, type IssuedRoute } from "./locks.js";
import {
  summarizeCreateVaultTx, summarizeTx, txBodyHash,
  type CreateVaultSummary, type RequestedIntent, type TxSummary,
} from "./summary.js";
import {
  assertChangeAddress, enterpriseAddressOf, type BuildContext, type CreateVaultContext, type TxBuilderPort,
} from "./txBuilder.js";
import { findVaultsAtScope, pickSingleVault, vaultIdUnitOf, type FoundVault, type IgnoredUtxo } from "./vaultLookup.js";
import { decodeVaultDatumOrThrow } from "./vaultDatumShape.js";
import {
  assertWakemeLinkAllowed, checkWakemeRefInTx, locateWakemeVault, resolveWakemeVault, wakemeNotFoundSummary,
  wakemeNotLinkedSummary,
  type ResolvedWakeme, type WakemeSummary,
} from "./wakeme.js";
import {
  mForBuild, instantCheckpointNeed, instantLimitsOf, instantVaultDatumOf, instantVaultParamsOf,
  readGbBeaconUtxo, readGbShardUtxos, readInstantGenRefs, readRateBeaconUtxo, readVaultRegistryUtxo,
  requireGenV2, requireRefScript, scheduleGenBeaconParamsOf,
} from "./genV2.js";
import { genLimitsSummary } from "./summary.js";
import { assertWitnessesCoverTx } from "./witnessCheck.js";
import {
  DEFAULT_TX_VALIDITY_MS, planValidity, readTxExpiry, type ExpiresReason, type TxExpiry, type ValidityPlan,
} from "./validity.js";
import type { ConsumeBuildParams } from "./txBuilder.js";
import { checkConsumeTx, consumeLineOf, type ConsumePair } from "./consumeLine.js";
import type { EngageThread } from "./engage.js";

/**
 * Thân bài `/tx/consume`: MỘT trong hai dạng — `opType` + `opCount`, HOẶC `pairs` (`consumeLine.ts`).
 * Dịch vụ kiểm lại sự loại trừ ở `consumeLineOf`, không chỉ tin bộ đọc HTTP.
 */
export interface ConsumeRequest extends OwnerRequest {
  opType?: number;
  opCount?: bigint;
  /** ConsumeMany: op_type TĂNG NGẶT, 1..8 cặp, op_count ≥ 1. Một cặp ⟹ dựng `Consume` đơn. */
  pairs?: ReadonlyArray<ConsumePair>;
  engageRef?: OutRefLike;
  wakemeVaultRef?: OutRefLike;
}

const PKH_HEX = /^[0-9a-f]{56}$/;
const HEX = /^[0-9a-f]+$/;

/** Két Wakeme của một lượt (`VaultTxService` ▸ `wakemeSource`): két đã đọc + tham chiếu thật đã
 *  đưa vào tx (app gửi hoặc dịch vụ định vị), và mục `summary.wakeme` sẽ trả. Rỗng ⟹ lượt này
 *  không đọc két Wakeme nào và không nói gì về nó. */
interface WakemeSource {
  resolved?: ResolvedWakeme;
  ref?: OutRefLike;
  summary?: WakemeSummary;
}

export interface BuildResponse {
  /** Giao dịch CHƯA KÝ. */
  txCbor: string;
  /** Hash THÂN giao dịch — app đối chiếu lại sau khi ký. */
  txHash: string;
  summary: TxSummary;
  /** `validTo` của CHÍNH thân tx, ISO 8601 UTC (`validity.ts` ▸ `readTxExpiry`). */
  expiresAt: string;
  /** Cận nào thắng khi chọn `validTo` (`validity.ts` ▸ `ExpiresReason`). */
  expiresReason: ExpiresReason;
  /** UTxO đậu ở địa chỉ vault mà ta cố ý không tính, kèm lý do. Đếm, không nuốt. */
  ignored: IgnoredUtxo[];
  /** Khoá băm phải ký — đọc từ `required_signers` của CHÍNH CBOR vừa dựng. */
  requiredSigners: string[];
  /** Nhân chứng cần thêm ngoài chữ ký (chủ script: mục rút did_stake…). */
  witnessNotes: string[];
}

/** Phần chung của mọi yêu cầu có chủ. */
export interface OwnerRequest {
  /** Chủ như bên gọi khai. `{type:"did"}` được suy thành `Script(did_stake)` + nhân chứng ở
   *  ĐẦU mỗi đường dựng, trước khi giữ khoá (`didOwner.ts` ▸ `resolveOwnerInput`). */
  owner: OwnerInput;
  /** Chỉ cho chủ script; chủ khoá mà gửi kèm ⟹ 400. */
  ownerWitness?: ScriptOwnerWitness;
  /** Địa chỉ đổi tiền thừa + nguồn UTxO trả phí. Vắng: chủ khoá ⟹ suy theo chiến lược cấu
   *  hình (README §7); chủ script ⟹ 400 `CHANGE_ADDRESS_REQUIRED` (không suy được). */
  changeAddress?: string;
  /** Ví trả phí bên thứ ba (`fee_payer`): phí + thế chấp + tiền thối ADA. Loại trừ với
   *  `changeAddress`. Luật: `feePayer.ts`. */
  feePayer?: FeePayerRequest;
}

export interface OpenThreadRequest extends OwnerRequest {
  /** Thân bài có `funding` — chưa hỗ trợ ở đường này (501). */
  fundingRequested?: boolean;
}

export interface OpenThreadResponse {
  txCbor: string;
  txHash: string;
  engageNft: string;
  engageAddress: string;
  owner: OwnerRef;
  requiredSigners: string[];
  witnessNotes: string[];
  summary: OpenThreadSummary;
  /** `validTo` của CHÍNH thân tx, ISO 8601 UTC (`validity.ts` ▸ `readTxExpiry`). */
  expiresAt: string;
  /** Cận nào thắng khi chọn `validTo` (`validity.ts` ▸ `ExpiresReason`). */
  expiresReason: ExpiresReason;
}

export interface BindDidRequest extends OwnerRequest {
  /** 64 ký tự hex thường (32 byte) — `engage.ts` ▸ `parseDidCommit`. */
  didCommit: string;
  /** Chỉ đích danh thread khi chủ có nhiều thread (như `/tx/consume`). */
  engageRef?: OutRefLike;
}

export interface BindDidResponse {
  txCbor: string;
  txHash: string;
  engageNft: string;
  engageAddress: string;
  owner: OwnerRef;
  /** Giá trị sẽ nằm trong datum thread — đọc lại TỪ CBOR (`summary.engage.did_commit`). */
  didCommit: string;
  requiredSigners: string[];
  witnessNotes: string[];
  summary: BindDidSummary;
  /** `validTo` của CHÍNH thân tx, ISO 8601 UTC (`validity.ts` ▸ `readTxExpiry`). */
  expiresAt: string;
  /** Cận nào thắng khi chọn `validTo` (`validity.ts` ▸ `ExpiresReason`). */
  expiresReason: ExpiresReason;
}

export interface CreateVaultRequest extends OwnerRequest {
  kind: "instant" | "schedule";
  /** oildrop. Két schedule: > 0. Két instant: ≥ 0 — `0` là đường của người mới chỉ có LAMP mượn
   *  ở két Wakeme (genesis IG không ép > 0). */
  lampAmount: bigint;
  /** CHỈ két instant: `owner_commit` của DID chủ két (64 hex thường) ⟹ ghi vào `wakeme_link` của
   *  datum genesis, để két Wakeme của DID đó ghim được két này ngay từ genesis bên Wakeme. */
  didCommit?: string;
  /** Đường cũ: nguồn LAMP + phí + đích tiền thối. Có `funding` thì CẤM (xem `funding.ts`). */
  changeAddress?: string;
  profile?: Profile;
  /** Nạp LAMP từ ví Phoenix (`did_payment`), phí từ ví trả phí. */
  funding?: FundingRequest;
}

export interface CreateVaultResponse {
  txCbor: string;
  txHash: string;
  vaultNft: string;
  vaultAddress: string;
  owner: OwnerRef;
  requiredSigners: string[];
  witnessNotes: string[];
  summary: CreateVaultSummary;
  /** `validTo` của CHÍNH thân tx, ISO 8601 UTC (`validity.ts` ▸ `readTxExpiry`). */
  expiresAt: string;
  /** Cận nào thắng khi chọn `validTo` (`validity.ts` ▸ `ExpiresReason`). */
  expiresReason: ExpiresReason;
}

export interface SubmitResponse {
  txHash: string;
  /** `owner_pkh` vừa được nhả khoá, hoặc `null` khi không khoá nào mang hash đó. */
  lockReleasedFor: string | null;
}

export interface VaultTxServiceDeps {
  network: Network;
  deployment: Deployment;
  chain: ChainReader;
  builder: TxBuilderPort;
  locks: OwnerLockTable;
  /** Sổ hash thân của giao dịch do CHÍNH dịch vụ này phát ra — `/tx/submit` tra nó. */
  issued: IssuedTxRegistry;
  /** Hạn khoá mềm theo chủ. KHÔNG còn quyết `expires_at` hay hạn sổ phát-hành (`validity.ts`). */
  lockTtlMs: number;
  /** Hạn ký của tx (ms từ đỉnh chuỗi), `AppConfig.txValidityMs`. Vắng ⟹ `DEFAULT_TX_VALIDITY_MS` —
   *  mặc định do chính dịch vụ sở hữu, không phải dữ liệu bên khác. */
  txValidityMs?: number;
  /** Đồng hồ, tiêm được để phép kiểm dựng ca hết hạn mà không phải chờ thật. */
  now?: () => number;
  /** Nhân chứng chủ script (did_stake). Vắng ⟹ chủ script nhận 501
   *  `OWNER_SCRIPT_WITNESS_UNAVAILABLE`; chủ khoá không bị ảnh hưởng. */
  ownerWitness?: OwnerWitnessProvider;
  /** Suy chủ `{type:"did"}` từ anchor trên chuỗi. Vắng (bản deploy thiếu
   *  `did_stake.unapplied_script`) ⟹ chủ DID nhận 501 `OWNER_SCRIPT_WITNESS_UNAVAILABLE`. */
  didOwner?: DidOwnerResolverPort;
  /** Input của giao dịch vừa nộp (`PendingSpends`). Vắng ⟹ không chặn dựng lại trên UTxO vừa
   *  tiêu — hành vi cũ, chỉ để phép kiểm cũ khỏi phải khai. */
  pending?: PendingSpends;
  /** Đọc anchor DID cho `funding` did_payment. Vắng ⟹ 501 `FUNDING_UNAVAILABLE`. Cùng tham số
   *  theo mạng `anchor_nft_policy` với nhân chứng did_stake. */
  didPaymentAnchor?: DidPaymentAnchorReader;
  /** Phép kiểm bộ chứng ký ở `/tx/submit`. Vắng ⟹ `assertWitnessesCoverTx` thật. `server.ts` KHÔNG
   *  truyền, và không env/cấu hình/cờ dòng lệnh nào chạm tới trường này, nên tiến trình thật không
   *  tắt được cổng. Chỉ phép kiểm dùng CBOR ghi sẵn (ký bằng khoá không có trong tay) mới tiêm bản
   *  cho qua, kèm lý do ngay tại chỗ tiêm. */
  witnessCheck?: WitnessCheck;
}

/** Hình dạng phép kiểm chứng ký: ném lỗi có mã khi bộ chứng ký không thể làm tx hợp lệ. */
export type WitnessCheck = (tx: CML.Transaction, witnesses: CML.TransactionWitnessSet) => unknown;

/**
 * Chế độ BÁO GIÁ của một đường dựng (`feeQuote.ts`): dựng + đọc lại CBOR y như đường thật, với
 * UTxO trả phí do người gọi đưa sẵn (UTxO tổng hợp, hoặc UTxO đã đọc ở địa chỉ chủ) thay vì
 * đọc theo tham chiếu trên chuỗi. Ba thứ KHÔNG xảy ra: không giành khoá mềm của chủ, không gắn
 * hash vào khoá, không ghi sổ phát-hành — một báo giá không giữ chỗ gì và không nộp được.
 */
export interface QuoteMode {
  /** UTxO trả phí; tham chiếu + địa chỉ phải trùng `fee_payer` (hoặc `funding.fee_payer`) của yêu cầu. */
  feePayerUtxo: UTxO;
}

export class VaultTxService {
  private readonly now: () => number;
  private readonly witnessCheck: WitnessCheck;

  constructor(private readonly deps: VaultTxServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.witnessCheck = deps.witnessCheck ?? assertWitnessesCoverTx;
  }

  get network(): Network {
    return this.deps.network;
  }

  /** Đọc UTxO ở một địa chỉ — CHỈ ĐỌC, dùng cho nguồn chủ của báo giá. */
  utxosAt(address: string): Promise<UTxO[]> {
    return this.deps.chain.utxosAt(address);
  }

  /**
   * Tài sản LAMP mà bản deploy đang phục vụ nướng vào mọi két (apply-param #1, #2) — `/health` ▸
   * `lamp`. Đọc thẳng từ khối cấu hình đã nạp (`config.ts` ▸ `lamp`), không có bản thứ hai.
   */
  get lampAsset(): { policyId: string; assetNameHex: string } {
    return { policyId: this.deps.deployment.lampPolicyId, assetNameHex: this.deps.deployment.lampAssetNameHex };
  }

  /** Trần thế chấp của ví trả phí do bản deploy đặt (`deployment.feePayerCollateralLovelace`). */
  get feePayerCollateralLovelace(): bigint {
    return this.deps.deployment.feePayerCollateralLovelace;
  }

  /** Tham số giao thức `coinsPerUtxoByte`, lấy từ bộ dựng (cùng ảnh chụp nó dùng để dựng). */
  coinsPerUtxoByte(): Promise<bigint> {
    return this.deps.builder.coinsPerUtxoByte();
  }

  /** Loại két khối này phục vụ — cấu hình, không chạm chuỗi. Bộ định tuyến nhiều khối đọc nó. */
  get vaultTypes(): string[] {
    return this.deps.deployment.vaults.map(v => v.vaultType);
  }

  /** Địa chỉ két của khối này — `/health` ▸ `vault_scopes` lấy HỢP của mọi khối (`blocks.ts`). */
  get vaultScopes(): VaultScope[] {
    return this.deps.deployment.vaults;
  }

  /** Nhãn nguồn của khối triển khai mà dịch vụ này phục vụ (`/health` ▸ `deployment_sources`). */
  get deploymentSource(): string {
    return this.deps.deployment.source;
  }

  /**
   * Chủ có két ở các địa chỉ vault của khối này không — CHỈ ĐỌC, không giữ khoá, không ghi sổ.
   * Cùng luật nhận két với đường dựng (`vaultLookup.ts` ▸ `findVaultsAtScope`: NFT danh-tính +
   * chủ trong datum), nên "có két" ở đây đúng là thứ đường dựng sẽ tìm thấy. Bộ định tuyến nhiều
   * khối (`blockRouter.ts`) gọi nó khi yêu cầu không khai `vault_type`.
   */
  async hasVaultOf(ownerIn: OwnerInput): Promise<boolean> {
    const req = await this.resolveOwner({ owner: ownerIn });
    const owner = assertOwnerRef(req.owner);
    for (const scope of this.deps.deployment.vaults) {
      const utxos = await this.deps.chain.utxosAt(scope.address);
      if (findVaultsAtScope(utxos, scope, owner).vaults.length > 0) return true;
    }
    return false;
  }

  /**
   * ScheduleCommit Gen v2.0 — nhánh ký đọc beacon ρ + beacon GreenBack + sổ két và TIÊU shard
   * GB của két; luật ký uỷ cho validator withdraw-zero `commit`. Cổng cấu hình (khối `gen_v2`,
   * ref-script `commit` + `gb_shard`) chạy TRƯỚC khi giữ khoá chủ ⟹ 501 `CONFIG_MISSING`.
   */
  async scheduleCommit(req: OwnerRequest & { scheduleLength: bigint; lampPerEpoch: bigint }, quote?: QuoteMode): Promise<BuildResponse> {
    const d = this.deps.deployment;
    const route = "/tx/schedule-commit";
    const g = requireGenV2(d, route);
    requireRefScript(d, "commit", route);
    requireRefScript(d, "gbShard", route);
    return this.buildOne("Schedule", "schedule_commit", req, async (ctx, b) => {
      const [rateBeaconUtxo, gbBeaconUtxo, vaultRegistryUtxo, gbShardUtxos] = await Promise.all([
        readRateBeaconUtxo(this.deps.chain, g), readGbBeaconUtxo(this.deps.chain, g),
        readVaultRegistryUtxo(this.deps.chain, g), readGbShardUtxos(this.deps.chain, g),
      ]);
      return b.scheduleCommit(ctx, {
        scheduleLength: req.scheduleLength, lampPerEpoch: req.lampPerEpoch,
        gen: { params: scheduleGenBeaconParamsOf(g), rateBeaconUtxo, gbBeaconUtxo, vaultRegistryUtxo, gbShardUtxos },
      });
    }, quote);
  }

  async scheduleFire(req: OwnerRequest & { scheduleId: string }, quote?: QuoteMode): Promise<BuildResponse> {
    return this.buildOne("Schedule", "schedule_fire", req, (ctx, b) =>
      b.scheduleFire(ctx, { scheduleId: req.scheduleId }), quote);
  }

  /**
   * Tiêu MAGIC.
   *
   * Không ghim `vault_type`: cả vault Instant lẫn vault Schedule đều tiêu MAGIC được.
   * Chủ nào có cả hai thì `pickSingleVault` ném `VAULT_AMBIGUOUS` — xem `errors.ts` cho
   * lý do không chọn đại.
   */
  /**
   * InstantGen Gen v2.0 — vault loại `Instant`, `m` (nanogic) do CHỦ chọn.
   *
   * 🔴 Cổng cấu hình nằm Ở ĐÂY, không ở tầng dựng: một cổng chỉ sống trong MỘT hiện thực
   * của `TxBuilderPort` thì nó gác hiện thực đó, không gác khái niệm. Cùng lý do, trần `m`
   * (`instantGenLimits(..).maxM`) được so ở đây trên đúng các UTxO beacon/shard sẽ giao
   * xuống bộ dựng — vượt trần ⟹ 422 `INSTANT_GEN_M_ABOVE_MAX`, bộ dựng KHÔNG được gọi.
   */
  async instantGen(req: OwnerRequest & { m?: bigint; wakemeVaultRef?: OutRefLike }, quote?: QuoteMode): Promise<BuildResponse> {
    const d = this.deps.deployment;
    const route = "/tx/instant-gen";
    // `m` vắng CHỈ hợp lệ ở chế độ báo giá (`/tx/quote` ▸ trần `max_m` làm `m`); đường dựng thật
    // đã đòi `m` ở `buildRequest.ts`, nên tới đây mà vắng là lệch.
    if (req.m === undefined && quote === undefined) {
      throw new CodedApiError(400, "INSTANT_GEN_M_INVALID", `"m" bắt buộc ở /tx/instant-gen.`, { received_type: "missing" });
    }
    const g = requireGenV2(d, route);
    requireRefScript(d, "gbShard", route);
    // Mạng chưa có két Wakeme ⟹ 501 NGAY (apply-param #8 không có giá trị), trước khi giữ khoá.
    const vaultParams = instantVaultParamsOf(d, g, this.deps.network);
    let src: WakemeSource = {};
    let limits: InstantGenLimits | undefined;
    return this.buildOne("Instant", "instant_gen", req, async (ctx, b) => {
      const vaultDatum = instantVaultDatumOf(ctx.vault.utxo);
      const epoch = posixMsToEpoch(ctx.tip.blockTimePosixMs, this.deps.network);
      // Làm mới checkpoint + két đã nối link ⟹ validator ĐÒI két Wakeme (`checkpoint.ak` ▸
      // `resolve_link`, luật 2). Cùng epoch ⟹ két tuỳ chọn (có thì phải là két đã ghim — két
      // định vị theo `wakeme_link` luôn đúng vế đó).
      const need = instantCheckpointNeed(vaultDatum, epoch);
      // `relinkByLent = true`: bộ dựng InstantGen tự tính L_lent (gương `checkpoint.ts ▸ resolveLink`).
      src = await this.wakemeSource(ctx, req.wakemeVaultRef, need.wakemeLink, need.refresh, true);
      const wakeme = src.resolved;
      const refs = await readInstantGenRefs(this.deps.chain, g, vaultDatum.owner);
      limits = instantLimitsOf({
        vaultUtxo: ctx.vault.utxo, vaultDatum, epoch, refs, wakeme: wakeme?.read ?? null, g,
      });
      const m = mForBuild(req.m, limits);
      return b.instantGen(ctx, {
        m, vaultParams, refs, includeRateBeacon: limits.refreshed,
        vaultRegistryPolicy: g.vaultRegistryPolicy, gbShardCapNanogic: g.gbShardCapNanogic,
        ...(wakeme === undefined ? {} : { wakeme: { utxo: wakeme.utxo, scriptHash: wakeme.scriptHash } }),
      });
    }, quote, (txCbor, summary) => {
      if (limits === undefined) throw new Error("[bất biến nội bộ] instant_gen dựng xong mà chưa tính trần.");
      summary.gen_limits = genLimitsSummary(limits, summary);
      this.wakemeAfterSummary(txCbor, summary, src);
    });
  }

  /**
   * RefreshCheckpoint — chủ ký, làm mới năm ô checkpoint (`cap_epoch`, `cap_nanogic`,
   * `usage_window`, `usage_window_epoch`, `wakeme_link`) mà không sinh/tiêu gì. Luôn cần
   * beacon ρ; `wakeme_vault_ref` có ⟹ ghim/giữ két Wakeme, vắng ⟹ gỡ ghim (`wakeme_link := ""`).
   */
  async refreshCheckpoint(req: OwnerRequest & { wakemeVaultRef?: OutRefLike }, quote?: QuoteMode): Promise<BuildResponse> {
    const d = this.deps.deployment;
    const g = requireGenV2(d, "/tx/refresh-checkpoint");
    const vaultParams = instantVaultParamsOf(d, g, this.deps.network);
    // KHÔNG tự định vị ở đường này: vắng `wakeme_vault_ref` MANG NGHĨA "gỡ ghim"
    // (`FollowVaultOrUnlink` ⟹ `wakeme_link := ""`). Tự tìm két rồi đưa vào là đảo ý người gọi.
    const wakemeRef = req.wakemeVaultRef;
    let src: WakemeSource = {};
    return this.buildOne("Instant", "refresh_checkpoint", req, async (ctx, b) => {
      if (wakemeRef !== undefined) {
        const resolved = await this.resolveWakeme(ctx, wakemeRef);
        src = { resolved, ref: wakemeRef, summary: resolved.summary };
      }
      const rateBeaconUtxo = await readRateBeaconUtxo(this.deps.chain, g);
      return b.refreshCheckpoint(ctx, {
        vaultParams, rateBeaconUtxo, ...(src.resolved === undefined ? {} : { wakemeVaultUtxo: src.resolved.utxo }),
      });
    }, quote, (txCbor, summary) => this.wakemeAfterSummary(txCbor, summary, src));
  }

  /**
   * Két Wakeme cho một lượt đọc nó — MỘT luật cho `/tx/instant-gen` và `/tx/consume`:
   *   1. app gửi `wakeme_vault_ref` ⟹ dùng đúng tham chiếu đó (đọc + kiểm ở `resolveWakemeVault`);
   *   2. vắng, két IG chưa nối link ⟹ không két nào, `reason: "vault_not_linked"`;
   *   3. vắng, đã nối link ⟹ định vị theo NFT `(wakeme_vault_hash, wakeme_link)`
   *      (`locateWakemeVault`): thấy 1 ⟹ đọc + kiểm như vế 1, `source: "located"`; ≥ 2 ⟹ 409
   *      `WAKEME_VAULT_AMBIGUOUS`; 0 ⟹ `required` ? 400 `WAKEME_VAULT_REF_REQUIRED` (validator
   *      sẽ từ chối tx thiếu két) : `reason: "wakeme_vault_not_found"`, tx vẫn dựng.
   * Mọi két đọc được đi qua `assertWakemeLinkAllowed` (luật 6, siết 2026-10-03): két IG link
   * rỗng mà app gửi két Wakeme không ghim két này ⟹ 422 `WAKEME_LINK_CHANGE_REJECTED` kèm câu
   * chỉ đường RefreshCheckpoint, bộ dựng KHÔNG được gọi.
   */
  private async wakemeSource(
    ctx: BuildContext, ref: OutRefLike | undefined, link: string, refresh: boolean, relinkByLent: boolean,
  ): Promise<WakemeSource> {
    const required = refresh && link !== "";
    if (ref !== undefined) {
      const resolved = await this.resolveWakeme(ctx, ref);
      assertWakemeLinkAllowed(resolved, link, { refresh, relinkByLent });
      return { resolved, ref, summary: resolved.summary };
    }
    if (link === "") return { summary: wakemeNotLinkedSummary() };
    const located = await locateWakemeVault(this.deps.chain, link, this.deps.network);
    if (located === undefined) {
      if (required) {
        throw new CodedApiError(400, "WAKEME_VAULT_REF_REQUIRED",
          `Két này đã nối két Wakeme (${link.slice(0, 16)}…) và lượt này làm mới checkpoint — validator ` +
          `đòi két Wakeme ở reference input, nhưng dịch vụ không tìm thấy két nào mang NFT đó trên chuỗi. ` +
          `Gửi "wakeme_vault_ref" nếu két vừa tạo (chưa vào khối), hoặc gỡ link bằng /tx/refresh-checkpoint.`,
          { wakeme_link: link, located_count: 0 });
      }
      return { summary: wakemeNotFoundSummary() };
    }
    const resolved = await this.resolveWakeme(ctx, located);
    // Định vị theo NFT tên = link ⟹ owner_commit == link luôn; gọi để một luật duy nhất gác cả hai đường.
    assertWakemeLinkAllowed(resolved, link, { refresh, relinkByLent });
    return { resolved, ref: located, summary: { ...resolved.summary, source: "located" } };
  }

  private resolveWakeme(ctx: BuildContext, ref: OutRefLike): Promise<ResolvedWakeme> {
    const d = this.deps.deployment;
    return resolveWakemeVault(this.deps.chain, ref, {
      vaultUtxo: ctx.vault.utxo,
      vaultScriptHash: ctx.vault.scope.scriptHash,
      network: this.deps.network,
      tipPosixMs: ctx.tip.blockTimePosixMs,
      lampPolicyId: d.lampPolicyId,
      lampAssetNameHex: d.lampAssetNameHex,
    });
  }

  /** Đọc lại CBOR: két Wakeme đã giao xuống phải là reference input, không phải input bị tiêu. */
  private wakemeAfterSummary(txCbor: string, summary: TxSummary, src: WakemeSource): void {
    if (src.resolved !== undefined) {
      if (src.ref === undefined) throw new Error("[bất biến nội bộ] có két Wakeme mà không có tham chiếu.");
      checkWakemeRefInTx(txCbor, src.ref);
    }
    if (src.summary !== undefined) summary.wakeme = src.summary;
  }

  /**
   * Két Instant v2.0 tiêu lần đầu trong epoch mới (`cap_epoch < e`) ⟹ nhánh BurnBatch làm mới
   * checkpoint ⟹ cần beacon ρ, và két Wakeme đang ghim nếu `wakeme_link` khác "".
   * Két Schedule, hoặc cùng epoch ⟹ `undefined` (không đọc gì — ScheduleGen không đọc két Wakeme).
   */
  private async consumeCheckpointFor(
    ctx: BuildContext, wakemeRef: OutRefLike | undefined,
  ): Promise<{ params: ConsumeBuildParams["checkpoint"]; wakeme: WakemeSource }> {
    if (ctx.vault.scope.vaultType !== "Instant") return { params: undefined, wakeme: {} };
    const datum = instantVaultDatumOf(ctx.vault.utxo);
    const need = instantCheckpointNeed(datum, posixMsToEpoch(ctx.tip.blockTimePosixMs, this.deps.network));
    if (!need.refresh) return { params: undefined, wakeme: {} };
    const d = this.deps.deployment;
    const g = requireGenV2(d, "/tx/consume (két Instant tiêu lần đầu trong epoch mới)");
    const vaultParams = instantVaultParamsOf(d, g, this.deps.network);
    // Đã nối link ⟹ bắt buộc có két (luật 2); app không gửi thì dịch vụ tự định vị.
    // `relinkByLent = false`: `checkGenV2Burn` không tính L_lent nên ném mọi lượt đổi/nối link.
    const src = await this.wakemeSource(ctx, wakemeRef, need.wakemeLink, true, false);
    const rateBeaconUtxo = await readRateBeaconUtxo(this.deps.chain, g);
    return {
      params: { vaultParams, rateBeaconUtxo, ...(src.resolved === undefined ? {} : { wakemeVaultUtxo: src.resolved.utxo }) },
      wakeme: src,
    };
  }

  /**
   * Thread Engage chọn theo CHỦ lúc chạy (`engage.ts` ▸ `pickEngageThread`), trong vùng khoá
   * chủ — không còn một NFT thread cố định trong cấu hình. `engageRef` chỉ đích danh khi chủ
   * có nhiều thread.
   */
  async consume(req: ConsumeRequest, quote?: QuoteMode): Promise<BuildResponse> {
    const d = this.deps.deployment.consume;
    // Hình dạng lượt tiêu kiểm TRƯỚC khi giữ khoá chủ (`consumeLine.ts`): `pairs` sai là 400, và
    // một yêu cầu hỏng hình dạng không được chiếm chỗ của chủ.
    const line = consumeLineOf(req);
    let wakeme: WakemeSource = {};
    let readback: { thread: EngageThread; vaultInputRef: OutRefLike } | undefined;
    return this.buildOne(undefined, "consume", req, async (ctx, b) => {
      const thread = await pickEngageThread(this.deps.chain, d.engageAddress, d.engageScriptHash, ctx.owner, req.engageRef);
      const cp = await this.consumeCheckpointFor(ctx, req.wakemeVaultRef);
      wakeme = cp.wakeme;
      readback = { thread, vaultInputRef: ctx.vault.utxo };
      return b.consume(ctx, {
        ...(line.kind === "single" ? { opType: line.opType, opCount: line.opCount } : { pairs: line.pairs }),
        engageUtxo: thread.utxo,
        ...(cp.params === undefined ? {} : { checkpoint: cp.params }),
      });
    }, quote, (txCbor, summary) => {
      this.wakemeAfterSummary(txCbor, summary, wakeme);
      if (readback === undefined) throw new Error("[bất biến nội bộ] /tx/consume đọc lại khi chưa chọn thread.");
      // Đọc lại redeemer + datum thread từ CBOR; `burned_nanogic` là lượng két đốt, đã suy từ
      // CÙNG CBOR ở `summarizeTx`.
      summary.consume = checkConsumeTx(txCbor, {
        engageAddress: d.engageAddress, thread: readback.thread, vaultInputRef: readback.vaultInputRef,
        line, burnedNanogic: BigInt(summary.magic.burned_nanogic),
      });
    });
  }

  /**
   * Mở thread Engage cho chủ (genesis, đúc NFT one-shot dưới policy consume).
   *
   * Nguồn min-ADA của thread là thứ quyết định hình dạng yêu cầu:
   *   · `change_address` — ví đó trả min-ADA + phí + thế chấp.
   *   · `fee_payer` — ví trả phí trả phí + thế chấp và ỨNG min-ADA của output thread (NFT đúc
   *     trong tx ⟹ khoản ứng = trọn lovelace output, có trần `fee_payer_fronting_max_lovelace`).
   *     Seed one-shot là chính UTxO trả phí, và đó là input DUY NHẤT (`otherInputAddresses: []`):
   *     chủ — người dùng mới 0 ADA — không góp UTxO nào, kể cả thế chấp.
   *   · `funding` (ví Phoenix trả min-ADA) ⟹ 501 `OPEN_THREAD_FUNDING_UNSUPPORTED`.
   * Chủ đã có thread ⟹ 409 `ENGAGE_THREAD_EXISTS` (mở thêm là khoá thêm min-ADA vô ích và làm
   * `/tx/consume` rơi vào `ENGAGE_THREAD_AMBIGUOUS`).
   */
  async openThread(reqIn: OpenThreadRequest, quote?: QuoteMode): Promise<OpenThreadResponse> {
    const req = await this.resolveOwner(reqIn);
    const owner = assertOwnerRef(req.owner);
    if (req.fundingRequested === true) {
      throw new CodedApiError(501, "OPEN_THREAD_FUNDING_UNSUPPORTED",
        `Mở thread bằng "funding" (ví Phoenix trả min-ADA) chưa được hỗ trợ. Gửi "change_address": ` +
        `ví đó trả min-ADA của thread + phí.`);
    }
    // 400 trước khi giữ khoá: một yêu cầu hỏng hình dạng không được chiếm chỗ của chủ.
    const feePayer = this.feePayerFor(req);
    const changeAddress = feePayer?.address ?? this.changeAddressFor(req);
    this.assertWitnessShapeFor(req);
    assertQuoteMatches(quote, feePayer);
    const d = this.deps.deployment.consume;
    const ownerKey = ownerLockKey(owner);
    const startedAt = this.now();
    const lockGen = quote === undefined ? this.deps.locks.acquire(ownerKey, startedAt) : undefined;
    try {
      const tip = await this.deps.chain.tip();
      const plan = this.validityPlan(tip, false);
      const existing = threadsOf(await this.deps.chain.utxosAt(d.engageAddress), d.engageScriptHash, owner);
      if (existing.length > 0) {
        throw new CodedApiError(409, "ENGAGE_THREAD_EXISTS",
          `Chủ ${owner.type}:${owner.hash.slice(0, 12)}… đã có thread Engage — dùng nó cho /tx/consume, ` +
          `không mở thêm.`, { threads: existing.map(t => refStr(t.utxo)) });
      }
      const feePayerUtxo = feePayer === undefined
        ? undefined
        : quote?.feePayerUtxo ?? await readFeePayerUtxoShared(this.deps.chain, feePayer, FEE_PAYER_CODES);
      const witness = await this.witnessFor(req);
      if (feePayer !== undefined) assertNoOwnerRewardToFeePayer(witness?.ownerReward);
      const built = await this.deps.builder.openThread({
        owner, ownerAuth: witness?.auth, tip, changeAddress, validToMs: plan.capMs,
        ...(feePayerUtxo === undefined ? {} : this.feePayerBuildFields(feePayerUtxo)),
      });
      const expiry = this.expiryOf(built.txCbor, plan, tip);
      const summary = checkOpenThreadTx(built.txCbor, {
        engageAddress: d.engageAddress, engageScriptHash: d.engageScriptHash,
        declaredUnit: built.engageNftUnit, owner, network: this.deps.network,
      });
      if (req.ownerDid !== undefined) summary.owner_did = req.ownerDid;
      if (feePayer !== undefined) {
        // Output thread MỚI (NFT đúc trong tx) là output duy nhất được ứng; UTxO trả phí là input duy nhất.
        summary.fee_payer = await this.checkFeePayer(built.txCbor, feePayer, feePayerUtxo!, tip, {
          fronting: { address: d.engageAddress, nftUnit: summary.engage.nft_unit }, otherInputAddresses: [],
        });
      }
      const txHash = txBodyHash(built.txCbor);
      if (quote === undefined) {
        this.deps.locks.bindTxHash(ownerKey, txHash, lockGen);
        // Mã ghi sổ Feecover của tx mở thread = tên NFT thread, khi nó đúng khuôn hash 64 hex.
        this.deps.issued.record(txHash, this.now(), {
          route: "open-thread", feeRef: hash64NameOf(summary.engage.nft_unit), lockKeys: [ownerKey],
          validToMs: Number(expiry.validToMs),
          ...(feePayer === undefined ? {} : { feePayerUtxo: refStr(feePayer.utxoRef) }),
        });
      }
      return {
        txCbor: built.txCbor,
        txHash,
        engageNft: summary.engage.nft_unit,
        engageAddress: d.engageAddress,
        owner,
        requiredSigners: requiredSignersOf(built.txCbor),
        witnessNotes: this.notesFor(owner, witness, changeAddress, feePayer),
        summary,
        expiresAt: expiry.expiresAt,
        expiresReason: expiry.reason,
      };
    } catch (e) {
      if (quote === undefined) this.deps.locks.release(ownerKey, lockGen);
      throw asOwnerApiError(e);
    }
  }

  /**
   * Gắn PersonDID vào thread Engage của chủ (redeemer `BindDID`, Constr 1). Một chiều, đúng một lần.
   *
   * Hình dạng yêu cầu, và vì sao:
   *   · `did_commit` sai dạng ⟹ 400 `DID_COMMIT_INVALID` (kiểm lại ở đây cho lời gọi thẳng vào dịch vụ);
   *   · `fee_payer` ⟹ ví trả phí trả phí + thế chấp, hạn dùng ≤ 1 giờ (`buildBindDidTx` ▸
   *     `validToMs`); input khác UTxO trả phí chỉ được nằm ở địa chỉ engage (đúng thread đang gắn).
   *     KHÔNG ứng min-ADA: value thread bảo toàn TUYỆT ĐỐI, và 2 ADA đã trên min-ADA của datum thread
   *     ở cỡ trần (`tests/minAdaFloor.test.ts`). Validator vẫn đòi quyền của CHÍNH chủ (không có vế
   *     `personal_delegate`) — ví trả phí không ký thay chủ;
   *   · chủ chưa có thread ⟹ 404 `ENGAGE_THREAD_NOT_FOUND`; nhiều thread ⟹ 409
   *     `ENGAGE_THREAD_AMBIGUOUS` (gửi `engage_ref`) — cùng `pickEngageThread` với `/tx/consume`;
   *   · thread đã gắn DID ⟹ 409 `DID_ALREADY_BOUND`, `details.did_commit` = giá trị đang nằm trên chuỗi.
   *
   * Khoá mềm theo CHỦ, giữ từ trước lúc đọc thread tới lúc nộp: thread là của đúng một chủ, nên khoá
   * chủ là khoá thread. Hai lượt gắn DID (hoặc gắn DID + tiêu MAGIC) cho cùng chủ: lượt sau THAY lượt
   * trước; tx nào nộp trước thắng, tx kia nhận 409 `TX_SUPERSEDED` lúc nộp (`locks.ts`).
   */
  async bindDid(reqIn: BindDidRequest, quote?: QuoteMode): Promise<BindDidResponse> {
    const req = await this.resolveOwner(reqIn);
    const owner = assertOwnerRef(req.owner);
    const didCommit = parseDidCommit(req.didCommit);
    // 400 trước khi giữ khoá (xung đột `change_address`, sai mạng), như mọi đường.
    const feePayer = this.feePayerFor(req);
    const changeAddress = feePayer?.address ?? this.changeAddressFor(req);
    this.assertWitnessShapeFor(req);
    assertQuoteMatches(quote, feePayer);
    const d = this.deps.deployment.consume;
    const ownerKey = ownerLockKey(owner);
    const startedAt = this.now();
    const lockGen = quote === undefined ? this.deps.locks.acquire(ownerKey, startedAt) : undefined;
    try {
      const tip = await this.deps.chain.tip();
      const plan = this.validityPlan(tip, false);
      const thread = await pickEngageThread(
        this.deps.chain, d.engageAddress, d.engageScriptHash, owner, req.engageRef, "/tx/bind-did");
      const existing = didCommitOf(thread);
      if (existing !== "") {
        throw new CodedApiError(409, "DID_ALREADY_BOUND",
          `Thread ${refStr(thread.utxo).slice(0, 16)}… đã gắn DID. BindDID đi một chiều và đúng một lần — ` +
          `không đổi được sang giá trị khác, kể cả ghi lại chính giá trị cũ.`,
          { did_commit: existing, engage_ref: refStr(thread.utxo), engage_nft: thread.nftUnit });
      }
      this.assertNotPendingSpent(thread.utxo, "thread Engage này");
      const feePayerUtxo = feePayer === undefined
        ? undefined
        : quote?.feePayerUtxo ?? await readFeePayerUtxoShared(this.deps.chain, feePayer, FEE_PAYER_CODES);
      const witness = await this.witnessFor(req);
      if (feePayer !== undefined) assertNoOwnerRewardToFeePayer(witness?.ownerReward);
      const built = await this.deps.builder.bindDid(
        {
          owner, ownerAuth: witness?.auth, tip, changeAddress, validToMs: plan.capMs,
          ...(feePayerUtxo === undefined ? {} : this.feePayerBuildFields(feePayerUtxo)),
        },
        { engageUtxo: thread.utxo, didCommit },
      );
      const expiry = this.expiryOf(built.txCbor, plan, tip);
      const summary = checkBindDidTx(built.txCbor, {
        engageAddress: d.engageAddress, engageScriptHash: d.engageScriptHash, thread, owner, didCommit,
        network: this.deps.network,
      });
      if (req.ownerDid !== undefined) summary.owner_did = req.ownerDid;
      if (feePayer !== undefined) {
        // Không output nào được ứng (value thread bảo toàn); input khác chỉ là thread ở địa chỉ engage.
        summary.fee_payer = await this.checkFeePayer(built.txCbor, feePayer, feePayerUtxo!, tip, {
          otherInputAddresses: [d.engageAddress],
        });
      }
      const txHash = txBodyHash(built.txCbor);
      if (quote === undefined) {
        this.deps.locks.bindTxHash(ownerKey, txHash, lockGen);
        // Mã ghi sổ Feecover = hash thân tx (không có NFT mới). Không ví trả phí ⟹ `/fee/sign` từ chối.
        this.deps.issued.record(txHash, this.now(), {
          route: "bind-did", lockKeys: [ownerKey], validToMs: Number(expiry.validToMs),
          ...(feePayer === undefined ? {} : { feePayerUtxo: refStr(feePayer.utxoRef) }),
        });
      }
      return {
        txCbor: built.txCbor,
        txHash,
        engageNft: thread.nftUnit,
        engageAddress: d.engageAddress,
        owner,
        didCommit: summary.engage.did_commit,
        requiredSigners: summary.required_signers,
        witnessNotes: [
          ...this.notesFor(owner, witness, changeAddress, feePayer),
          `BindDID đi một chiều: sau khi giao dịch này vào khối, did_commit của thread khoá vĩnh viễn.`,
        ],
        summary,
        expiresAt: expiry.expiresAt,
        expiresReason: expiry.reason,
      };
    } catch (e) {
      if (quote === undefined) this.deps.locks.release(ownerKey, lockGen);
      throw asOwnerApiError(e);
    }
  }

  /**
   * Cận trên `validTo` cho một lượt dựng (`validity.ts` ▸ `planValidity`). `epochBound` = route mà
   * validator đòi hai cận cùng một epoch giao thức (gen/consume/schedule — mọi đường qua `buildOne`).
   */
  private validityPlan(tip: ChainTip, epochBound: boolean): ValidityPlan {
    return planValidity({
      tipPosixMs: tip.blockTimePosixMs, network: this.deps.network,
      txValidityMs: this.deps.txValidityMs ?? DEFAULT_TX_VALIDITY_MS, epochBound,
    });
  }

  /** Hạn đọc NGƯỢC từ chính CBOR vừa dựng — nguồn duy nhất của `expires_at` và hạn dòng sổ phát-hành. */
  private expiryOf(txCbor: string, plan: ValidityPlan, tip: ChainTip): TxExpiry {
    return readTxExpiry(txCbor, this.deps.network, plan, tip.blockTimePosixMs);
  }

  private async buildOne(
    vaultType: string | undefined,
    intent: RequestedIntent,
    reqIn: OwnerRequest,
    build: (ctx: BuildContext, b: TxBuilderPort) => Promise<{ txCbor: string }>,
    quote?: QuoteMode,
    /** Phép đọc lại CBOR riêng của một đường, chạy SAU `summarizeTx` và TRƯỚC khi ghi sổ phát-hành. */
    afterSummary?: (txCbor: string, summary: TxSummary) => void,
  ): Promise<BuildResponse> {
    const req = await this.resolveOwner(reqIn);
    const owner = assertOwnerRef(req.owner);
    const ownerKey = ownerLockKey(owner);
    const scopes = this.scopesFor(vaultType);
    assertScopesSupported(scopes, intent);
    // 400 trước khi giữ khoá: một yêu cầu hỏng hình dạng không được chiếm chỗ của chủ.
    const feePayer = this.feePayerFor(req);
    const changeAddress = feePayer?.address ?? this.changeAddressFor(req);
    this.assertWitnessShapeFor(req);
    assertQuoteMatches(quote, feePayer);
    const startedAt = this.now();
    const lockGen = quote === undefined ? this.deps.locks.acquire(ownerKey, startedAt) : undefined;
    try {
      const tip = await this.deps.chain.tip();
      const feePayerUtxo = feePayer === undefined
        ? undefined
        : quote?.feePayerUtxo ?? await readFeePayerUtxoShared(this.deps.chain, feePayer, FEE_PAYER_CODES);
      const witness = await this.witnessFor(req);
      if (feePayer !== undefined) assertNoOwnerRewardToFeePayer(witness?.ownerReward);

      const found: FoundVault[] = [];
      const ignored: IgnoredUtxo[] = [];
      for (const scope of scopes) {
        const utxos = await this.deps.chain.utxosAt(scope.address);
        const r = findVaultsAtScope(utxos, scope, owner);
        found.push(...r.vaults);
        ignored.push(...r.ignored);
      }
      const vault = pickSingleVault(found, ownerKey, vaultType ?? "bất kỳ", scopes.map(s => s.address));
      this.assertNotPendingSpent(vault.utxo);

      const plan = this.validityPlan(tip, true);
      const ctx: BuildContext = {
        owner,
        ownerAuth: witness?.auth,
        vault,
        tip,
        changeAddress,
        validityMaxAheadMs: plan.maxAheadMs,
        ...(feePayerUtxo === undefined ? {} : {
          feePayerUtxo, collateralLovelace: this.deps.deployment.feePayerCollateralLovelace,
        }),
      };
      const built = await build(ctx, this.deps.builder);

      // ── Bước KHÔNG được bỏ: đọc lại chính CBOR vừa dựng ─────────────────────
      // Không tham số nào của yêu cầu đi vào đây. `inputVaultDatumHex` là datum của
      // UTxO đang bị tiêu — một dữ kiện của CHUỖI, đọc ở trên, không phải thứ người
      // gọi khai.
      const inputDatum = vault.utxo.datum;
      if (typeof inputDatum !== "string" || inputDatum === "") {
        throw new TxSummaryUndecodableError(
          "UTxO vault đang bị tiêu không mang datum inline — không suy được phần THÊM/BỚT",
          { utxo_ref: `${vault.utxo.txHash}#${vault.utxo.outputIndex}` },
        );
      }
      const summary = summarizeTx(built.txCbor, {
        vaultAddress: vault.scope.address,
        inputVaultDatumHex: inputDatum,
        lampUnit: this.deps.deployment.lampPolicyId + this.deps.deployment.lampAssetNameHex,
        network: this.deps.network,
        requestedIntent: intent,
      });
      if (req.ownerDid !== undefined) summary.owner_did = req.ownerDid;
      if (feePayer !== undefined) {
        // Két của CHÍNH chủ nhận khoản ứng khi datum dài ra; shard GreenBack (dùng chung) cũng vậy —
        // nhánh sinh dựng lại shard với datum dài hơn, và trên đường chủ tự trả thì chủ trả phần đó.
        const g = this.deps.deployment.genV2;
        summary.fee_payer = await this.checkFeePayer(built.txCbor, feePayer, feePayerUtxo!, tip, {
          fronting: { address: vault.scope.address, nftUnit: vault.vaultIdUnit, inputRef: vault.utxo },
          ...(g === undefined ? {} : { sharedFrontings: [{ address: g.gbShardAddress, policyId: g.gbShardPolicyId }] }),
        });
      }
      afterSummary?.(built.txCbor, summary);
      const expiry = this.expiryOf(built.txCbor, plan, tip);
      const txHash = txBodyHash(built.txCbor);
      if (quote === undefined) {
        this.deps.locks.bindTxHash(ownerKey, txHash, lockGen);
        // Ghi vào sổ phát-hành TRƯỚC khi trả về: `/tx/submit` chỉ nộp thứ có trong sổ, và
        // `/fee/sign` đọc route + UTxO ví trả phí từ đây chứ không nhận từ app.
        this.deps.issued.record(txHash, this.now(), {
          route: routeOfIntent(intent), lockKeys: [ownerKey], validToMs: Number(expiry.validToMs),
          ...(feePayer === undefined ? {} : { feePayerUtxo: refStr(feePayer.utxoRef) }),
        });
      }

      return {
        txCbor: built.txCbor,
        txHash,
        summary,
        expiresAt: expiry.expiresAt,
        expiresReason: expiry.reason,
        ignored,
        requiredSigners: requiredSignersOf(built.txCbor),
        witnessNotes: this.notesFor(owner, witness, changeAddress, feePayer),
      };
    } catch (e) {
      if (quote === undefined) this.deps.locks.release(ownerKey, lockGen);
      throw asOwnerApiError(e);
    }
  }

  /**
   * UTxO vault là input của một giao dịch vừa nộp qua dịch vụ này mà nút đọc chưa thấy bị tiêu
   * ⟹ 409. Dựng tiếp trên nó thì người dùng ký xong mới bị chuỗi từ chối vì input không còn.
   */
  private assertNotPendingSpent(u: UTxO, subject = "vault này"): void {
    const ref = `${u.txHash}#${u.outputIndex}`;
    if (this.deps.pending?.has(ref, this.now())) {
      throw new CodedApiError(409, "PREVIOUS_TX_PENDING",
        `Giao dịch trước của ${subject} đã nộp nhưng chưa vào khối — UTxO ${ref} đang bị nó tiêu. ` +
        `Thử lại sau khi giao dịch đó vào khối (thường dưới một phút).`,
        { utxo_ref: ref });
    }
  }

  /** `fee_payer`: loại trừ với `change_address`, địa chỉ đúng mạng + khoá. Kiểm TRƯỚC khi giữ khoá. */
  /**
   * Chủ `{type:"did"}` ⟹ `Script(did_stake)` + nhân chứng, suy TRƯỚC mọi khoá: khoá mềm vì thế
   * mang đúng khoá `script:<hash>` như chủ script khai tường minh, và hai cách khai cùng một chủ
   * tranh CÙNG một khoá. Chủ khác ⟹ trả nguyên.
   */
  private resolveOwner<R extends OwnerRequest>(req: R): Promise<WithResolvedOwner<R>> {
    return resolveOwnerInput(req, this.deps.didOwner);
  }

  private feePayerFor(req: WithResolvedOwner<OwnerRequest>): FeePayerRequest | undefined {
    const fp = req.feePayer;
    if (fp === undefined) return undefined;
    if (req.changeAddress !== undefined) {
      throw new CodedApiError(400, "FEE_PAYER_CHANGE_ADDRESS_CONFLICT",
        `"change_address" và "fee_payer" không đi cùng nhau: có "fee_payer" thì phí, thế chấp và tiền ` +
        `thối ADA đều về "fee_payer.address". Bỏ "change_address".`);
    }
    assertFeePayerAddress(this.deps.network, fp, FEE_PAYER_CODES);
    return fp;
  }

  /** Hai trường bộ dựng nhận khi đi ví trả phí: UTxO đó (ví lucid + seed) và trần thế chấp của bản
   *  deploy. Hạn dùng KHÔNG còn ở đây: mọi đường đặt `validToMs = plan.capMs` (`validityPlan`), và
   *  `txValidityMs` ≤ 1 giờ (`config.ts`) nên vẫn trong trần `checkValidTo` của ví trả phí. */
  private feePayerBuildFields(feePayerUtxo: UTxO): { feePayerUtxo: UTxO; collateralLovelace: bigint } {
    return { feePayerUtxo, collateralLovelace: this.deps.deployment.feePayerCollateralLovelace };
  }

  /** Đọc lại CBOR theo luật ví trả phí. Input khác UTxO trả phí được tra từ CHUỖI, không từ bộ dựng. */
  private async checkFeePayer(
    txCbor: string, fp: FeePayerRequest, fpUtxo: UTxO, tip: ChainTip,
    opts: {
      fronting?: Omit<FeePayerFronting, "maxLovelace">;
      sharedFrontings?: readonly Omit<FeePayerSharedFronting, "maxLovelace">[];
      otherInputAddresses?: readonly string[];
    } = {},
  ): Promise<FeePayerSummary> {
    const feeKey = refStr(fp.utxoRef);
    const others = inputRefsOf(txCbor).filter(r => refStr(r) !== feeKey);
    const otherInputs = others.length === 0 ? [] : await this.deps.chain.utxosByOutRef(others);
    return checkFeePayerTx(txCbor, {
      network: this.deps.network,
      tipPosixMs: tip.blockTimePosixMs,
      feePayer: fp,
      feePayerUtxo: fpUtxo,
      maxCollateralLovelace: this.deps.deployment.feePayerCollateralLovelace,
      otherInputs,
      ...(opts.fronting === undefined ? {} : {
        fronting: { ...opts.fronting, maxLovelace: this.deps.deployment.feePayerFrontingMaxLovelace },
      }),
      ...(opts.sharedFrontings === undefined ? {} : {
        sharedFrontings: opts.sharedFrontings.map(s => ({ ...s, maxLovelace: this.deps.deployment.feePayerFrontingMaxLovelace })),
      }),
      ...(opts.otherInputAddresses === undefined ? {} : { otherInputAddresses: opts.otherInputAddresses }),
    });
  }

  /**
   * Tạo vault — giao dịch CHƯA KÝ, đúc NFT danh-tính one-shot (INV-VAULT-IDENTITY), datum
   * khởi sinh sạch, chủ = `owner`. Bộ dựng là `@magiclamp/sdk` ▸ `createVault`, không phải
   * một bản thứ hai (`txBuilder.ts` ▸ `SdkTxBuilder.createVault`).
   *
   * Khác các đường còn lại ở hai chỗ, cả hai có chủ đích:
   *   · `change_address` BẮT BUỘC — LAMP nạp vào vault lấy từ UTxO ở đó; không có địa chỉ
   *     thì không có LAMP nào để khoá, và suy nó từ pkh là khẳng định điều dịch vụ không biết.
   *   · Không đọc vault đầu vào (chưa có), nên bản tóm tắt ĐỌC THẲNG output vault trong CBOR
   *     (`summarizeCreateVaultTx`) và đối chiếu chủ trong datum với chủ yêu cầu.
   */
  async createVault(reqIn: CreateVaultRequest, quote?: QuoteMode): Promise<CreateVaultResponse> {
    const req = await this.resolveOwner(reqIn);
    const owner = assertOwnerRef(req.owner);
    if (req.kind !== "instant" && req.kind !== "schedule") {
      throw new BadRequestError(`"kind" phải là "instant" hoặc "schedule".`);
    }
    if (typeof req.lampAmount !== "bigint" || req.lampAmount < 0n || (req.lampAmount === 0n && req.kind !== "instant")) {
      throw new CodedApiError(400, "LAMP_AMOUNT_INVALID",
        `"lamp_amount" phải là số nguyên oildrop: > 0 với két schedule, ≥ 0 với két instant.`,
        { kind: req.kind, received: typeof req.lampAmount === "bigint" ? req.lampAmount.toString() : typeof req.lampAmount });
    }
    if (req.didCommit !== undefined) {
      parseDidCommit(req.didCommit);
      if (req.kind !== "instant") {
        throw new CodedApiError(400, "DID_COMMIT_UNEXPECTED",
          `"did_commit" chỉ dùng cho két instant (ghi vào wakeme_link); két schedule không có trường đó.`);
      }
    }
    const scopes = this.scopesFor(req.kind === "instant" ? "Instant" : "Schedule");
    assertScopesSupported(scopes, "create_vault");
    if (scopes.length !== 1) {
      throw new BadRequestError(
        `Cấu hình có ${scopes.length} địa chỉ vault loại ${req.kind}; không chọn đại một cái để tạo vault.`,
        { addresses: scopes.map(s => s.address) },
      );
    }
    const scope = scopes[0]!;
    // `fee_payer` ở gốc thân bài: CHỈ két instant "lamp_amount": "0" không `funding` (người dùng mới,
    // 0 ADA, không có LAMP nào để nạp). Ví trả phí trả phí + thế chấp, làm seed one-shot, và ỨNG
    // min-ADA của output két mới (NFT đúc trong tx ⟹ trọn lovelace output, có trần). Két có LAMP
    // nạp nhận ví trả phí qua "funding.fee_payer" như cũ.
    if (req.feePayer !== undefined && (req.kind !== "instant" || req.lampAmount !== 0n || req.funding !== undefined)) {
      throw new CodedApiError(400, "FEE_PAYER_UNSUPPORTED",
        `"fee_payer" ở gốc thân bài chỉ dùng cho két instant "lamp_amount": "0" không kèm "funding". Két ` +
        `có LAMP nạp nhận ví trả phí qua "funding.fee_payer".`,
        { kind: req.kind, lamp_amount: req.lampAmount.toString(), funding: req.funding !== undefined });
    }
    const feePayer = req.feePayer === undefined ? undefined : this.feePayerFor(req);
    const funding = req.funding;
    if (funding !== undefined && req.changeAddress !== undefined) {
      throw new CodedApiError(400, "FUNDING_CHANGE_ADDRESS_CONFLICT",
        `"change_address" và "funding" không đi cùng nhau: có "funding" thì phí + tiền thối ADA về ` +
        `"funding.fee_payer.address" (hoặc, với fee_source "did_payment", mọi tiền thối về "funding.address"), ` +
        `tiền thối LAMP/token về "funding.address". Bỏ "change_address".`);
    }
    // Ví Phoenix tự trả phí: ví khoá của người dùng chỉ làm thế chấp.
    const selfFunded = funding?.feeSource === "did_payment";
    if (funding === undefined && feePayer === undefined && (typeof req.changeAddress !== "string" || req.changeAddress === "")) {
      throw new CodedApiError(400, "CHANGE_ADDRESS_REQUIRED",
        `"change_address" bắt buộc khi tạo vault (hoặc gửi "funding" để nạp từ ví Phoenix).`);
    }
    // Địa chỉ ví của lucid. Chế độ tự trả phí: ví thế chấp — lucid thối gì về đây thì phép đọc
    // lại CBOR (`checkSelfFundedTx`) chặn; nó chỉ được nhận `collateral_return`.
    const changeAddress = feePayer !== undefined ? feePayer.address : funding === undefined
      ? assertChangeAddress(this.deps.network, req.changeAddress!)
      : selfFunded ? funding.collateral!.address : funding.feePayer!.address;
    this.assertWitnessShapeFor(req);
    let fundingSigners: ReturnType<typeof fundingWitnessOf> | undefined;
    if (funding !== undefined) {
      if (this.deps.didPaymentAnchor === undefined) {
        throw new CodedApiError(501, "FUNDING_UNAVAILABLE",
          `Dịch vụ chưa được cấu hình đọc anchor DID (thiếu mục \`did_stake\` trong bản deploy) — ` +
          `không dựng được giao dịch chi did_payment.`, { missing: "deployment.did_stake" });
      }
      assertFundingAddresses(this.deps.network, funding);
      fundingSigners = fundingWitnessOf(funding, req.ownerWitness);
    }
    assertQuoteMatches(quote, feePayer ?? funding?.feePayer);
    const ownerKey = ownerLockKey(owner);
    const startedAt = this.now();
    const lockGen = quote === undefined ? this.deps.locks.acquire(ownerKey, startedAt) : undefined;
    try {
      const tip = await this.deps.chain.tip();
      const plan = this.validityPlan(tip, false);
      if (req.kind === "instant") await this.assertNoInstantVaultYet(scope, owner, req.didCommit);
      const witness = await this.witnessFor(req);
      if (feePayer !== undefined) assertNoOwnerRewardToFeePayer(witness?.ownerReward);
      const rootFeePayerUtxo = feePayer === undefined
        ? undefined
        : quote?.feePayerUtxo ?? await readFeePayerUtxoShared(this.deps.chain, feePayer, FEE_PAYER_CODES);
      let fundingCtx: CreateVaultContext["funding"];
      if (funding !== undefined) {
        const anchor = await this.deps.didPaymentAnchor!.read(fundingSigners!.anchorRef);
        const utxos = await this.deps.chain.utxosAt(funding.address);
        const input = {
          didPaymentScriptCbor: funding.didPaymentScriptCbor, address: funding.address, utxos,
          anchorRefUtxo: anchor, controllerPkh: fundingSigners!.controllerPkh, deviceKeyHash: fundingSigners!.deviceKeyHash,
        };
        if (selfFunded) {
          const collateralUtxo = await readCollateralUtxo(this.deps.chain, funding);
          fundingCtx = { input: { ...input, feeSource: "did_payment", collateralUtxo }, collateralUtxo };
        } else {
          const feePayerUtxo = quote?.feePayerUtxo ?? await readFeePayerUtxo(this.deps.chain, funding);
          fundingCtx = { input, feePayerUtxo };
        }
      }
      const built = await this.deps.builder.createVault(
        {
          owner, ownerAuth: witness?.auth, scope, tip, changeAddress, funding: fundingCtx, validToMs: plan.capMs,
          ...(fundingCtx === undefined ? {} : { collateralLovelace: this.deps.deployment.feePayerCollateralLovelace }),
          ...(rootFeePayerUtxo === undefined ? {} : this.feePayerBuildFields(rootFeePayerUtxo)),
        },
        { lampAmount: req.lampAmount, profile: req.profile, ...(req.didCommit === undefined ? {} : { wakemeLink: req.didCommit }) },
      );
      const lampUnit = this.deps.deployment.lampPolicyId + this.deps.deployment.lampAssetNameHex;
      const summary = summarizeCreateVaultTx(built.txCbor, {
        vaultAddress: scope.address,
        vaultNftUnit: built.vaultNftUnit,
        lampUnit,
        network: this.deps.network,
      });
      if (req.ownerDid !== undefined) summary.owner_did = req.ownerDid;
      if (funding !== undefined && fundingCtx !== undefined && selfFunded) {
        summary.funding = checkSelfFundedTx(built.txCbor, {
          network: this.deps.network,
          tipPosixMs: tip.blockTimePosixMs,
          vaultAddress: scope.address,
          vaultNftUnit: built.vaultNftUnit,
          lampUnit,
          fundingAddress: funding.address,
          collateralAddress: funding.collateral!.address,
          collateralUtxo: fundingCtx.collateralUtxo!,
          didPaymentUtxos: fundingCtx.input.utxos,
          signers: [fundingSigners!.controllerPkh, fundingSigners!.deviceKeyHash],
          maxCollateralLovelace: this.deps.deployment.feePayerCollateralLovelace,
        });
      } else if (funding !== undefined && fundingCtx !== undefined) {
        summary.funding = checkFundingTx(built.txCbor, {
          network: this.deps.network,
          tipPosixMs: tip.blockTimePosixMs,
          vaultAddress: scope.address,
          vaultNftUnit: built.vaultNftUnit,
          lampUnit,
          fundingAddress: funding.address,
          feePayerAddress: funding.feePayer!.address,
          feePayerUtxo: fundingCtx.feePayerUtxo!,
          didPaymentUtxos: fundingCtx.input.utxos,
          signers: [fundingSigners!.controllerPkh, fundingSigners!.deviceKeyHash],
          maxCollateralLovelace: this.deps.deployment.feePayerCollateralLovelace,
          // Ví trả phí ứng min-ADA output vault mới (`funding.ts` khối đầu tệp), cùng trần với đường
          // `fee_payer` ở gốc.
          frontingMaxLovelace: this.deps.deployment.feePayerFrontingMaxLovelace,
        });
      }
      if (feePayer !== undefined) {
        // Output két MỚI (NFT đúc trong tx) là output duy nhất được ứng; UTxO trả phí là input duy nhất.
        summary.fee_payer = await this.checkFeePayer(built.txCbor, feePayer, rootFeePayerUtxo!, tip, {
          fronting: { address: scope.address, nftUnit: built.vaultNftUnit }, otherInputAddresses: [],
        });
      }
      // Đọc hạn SAU các cổng đọc-lại có mã (funding/fee_payer): tx thiếu validTo hoặc hạn quá trần
      // ví trả phí phải ra 422 FUNDING_TX_MISMATCH nói rõ trường lệch, không ra 500 bất biến nội bộ.
      // Cổng hạn vẫn chạy trước mọi lần giữ khoá / ghi sổ bên dưới.
      const expiry = this.expiryOf(built.txCbor, plan, tip);
      if (!sameOwner(summary.vault.owner, owner)) {
        throw new TxSummaryUndecodableError(
          `datum vault vừa dựng mang chủ ${summary.vault.owner.type}:${summary.vault.owner.hash} ` +
          `khác chủ yêu cầu ${owner.type}:${owner.hash}`,
        );
      }
      if (summary.vault.lamp_deposit_oildrop !== req.lampAmount.toString()) {
        throw new TxSummaryUndecodableError(
          `vault vừa dựng mang ${summary.vault.lamp_deposit_oildrop} oildrop, yêu cầu ${req.lampAmount}`,
        );
      }
      // `wakeme_link` đọc lại TỪ CBOR phải đúng thứ yêu cầu khai (két instant), hoặc vắng (schedule).
      const wantLink = req.kind === "instant" ? (req.didCommit ?? "") : null;
      if (summary.vault.wakeme_link !== wantLink) {
        throw new TxSummaryUndecodableError(
          `vault vừa dựng mang wakeme_link ${JSON.stringify(summary.vault.wakeme_link)}, yêu cầu ${JSON.stringify(wantLink)}`,
        );
      }
      const txHash = txBodyHash(built.txCbor);
      // Mã ghi sổ Feecover cho `create_vault` = vault_id = tên NFT vault (blake2b_256 ⟹ 64 hex).
      const vaultNftName = hash64NameOf(built.vaultNftUnit);
      if (vaultNftName === undefined) {
        throw new Error(`NFT vault vừa dựng không mang tên 64 hex (unit dài ${built.vaultNftUnit.length}).`);
      }
      if (quote === undefined) {
        this.deps.locks.bindTxHash(ownerKey, txHash, lockGen);
        this.deps.issued.record(txHash, this.now(), {
          route: "create-vault", feeRef: vaultNftName, lockKeys: [ownerKey], validToMs: Number(expiry.validToMs),
          ...((feePayer ?? funding?.feePayer) === undefined ? {} : { feePayerUtxo: refStr((feePayer ?? funding!.feePayer!).utxoRef) }),
        });
      }
      return {
        txCbor: built.txCbor,
        txHash,
        vaultNft: built.vaultNftUnit,
        vaultAddress: scope.address,
        owner,
        requiredSigners: summary.required_signers,
        witnessNotes: funding === undefined
          ? this.notesFor(owner, witness, changeAddress, feePayer)
          : fundingNotes(owner, witness, funding, fundingSigners!),
        summary,
        expiresAt: expiry.expiresAt,
        expiresReason: expiry.reason,
      };
    } catch (e) {
      if (quote === undefined) this.deps.locks.release(ownerKey, lockGen);
      throw asOwnerApiError(e);
    }
  }

  /** Địa chỉ đổi tiền thừa: app gửi thì kiểm; chủ khoá không gửi thì suy theo chiến lược. */
  private changeAddressFor(req: WithResolvedOwner<OwnerRequest>): string {
    if (req.changeAddress !== undefined) return assertChangeAddress(this.deps.network, req.changeAddress);
    if (req.owner.type === "key") return enterpriseAddressOf(this.deps.network, req.owner.hash);
    throw new CodedApiError(400, "CHANGE_ADDRESS_REQUIRED",
      `Chủ script không có địa chỉ ví suy được — gửi "fee_payer" (ví trả phí bên thứ ba: phí + thế ` +
      `chấp) hoặc "change_address" (ví trả phí + nhận tiền thừa).`);
  }

  /** Lỗi hình dạng của nhân chứng — kiểm TRƯỚC khi giữ khoá. */
  private assertWitnessShapeFor(req: WithResolvedOwner<OwnerRequest>): void {
    if (req.owner.type === "key" && req.ownerWitness !== undefined) {
      throw new CodedApiError(400, "OWNER_WITNESS_UNEXPECTED",
        `"owner_witness" chỉ dành cho chủ script; chủ khoá chứng minh quyền bằng chữ ký.`);
    }
    if (req.owner.type === "script") {
      if (this.deps.ownerWitness === undefined) {
        throw new CodedApiError(501, "OWNER_SCRIPT_WITNESS_UNAVAILABLE",
          `Dịch vụ chưa được cấu hình nhân chứng chủ script (thiếu mục \`did_stake\` trong bản ` +
          `deploy). Không có nó thì không dựng được mục rút Script(h) mà validator đòi.`,
          { missing: "deployment.did_stake" });
      }
      if (req.ownerWitness === undefined) {
        throw new CodedApiError(400, "OWNER_SCRIPT_WITNESS_UNAVAILABLE",
          `Chủ là script: yêu cầu phải kèm "owner_witness" (did_stake_script_cbor, anchor_ref, ` +
          `controller_pkh, device_key_hash).`,
          { missing: "owner_witness" });
      }
    }
  }

  private async witnessFor(req: WithResolvedOwner<OwnerRequest>): Promise<ResolvedOwnerWitness | undefined> {
    if (req.owner.type === "key") return undefined;
    return this.deps.ownerWitness!.resolve(req.owner, req.ownerWitness!);
  }

  private notesFor(
    owner: OwnerRef, w: ResolvedOwnerWitness | undefined, changeAddress: string, feePayer?: FeePayerRequest,
  ): string[] {
    const fee = feePayer !== undefined
      ? `Phí + tài sản thế chấp: UTxO ${refStr(feePayer.utxoRef)} của ${feePayer.address}; tiền thối ADA ` +
        `và collateral_return về đúng địa chỉ đó. Bên trả phí ký bằng khoá thanh toán của địa chỉ đó; ` +
        `hạn dùng ≤ 1 giờ kể từ lúc dựng.`
      : `Input trả phí + tài sản thế chấp lấy từ ${changeAddress}: khoá thanh toán của địa chỉ ` +
        `đó cũng phải ký.`;
    if (owner.type === "key") return [`Chủ khoá: ký bằng khoá ${owner.hash}.`, fee];
    return [...(w?.notes ?? []), fee];
  }

  /**
   * Ghép chứng ký của app vào giao dịch rồi nộp.
   *
   * Dịch vụ KHÔNG ký gì ở đây: nó nhận một `TransactionWitnessSet` đã ký sẵn từ app và
   * ghép vào.
   *
   * 🔴 Phép so `bodyHashBefore`/`bodyHashAfter` dưới đây ĐỪNG đọc thành một cổng. Bản
   * trước của khối chú thích này viết *"hash trước và sau phải bằng nhau — và đó là thứ
   * được kiểm, chứ không phải được giả định"*; câu đó nói quá. `assembled` được dựng từ
   * **chính `tx.body()`**, nên hai vế băm cùng một vật: không có hình dạng đầu vào nào
   * làm nó đỏ, và không ca kiểm nào làm nó đỏ. Nó đo dư âm mã hoá CBOR khi CML tuần tự
   * hoá lại, không đo tính toàn vẹn của việc ghép chứng ký — việc ghép, theo cấu trúc,
   * không chạm thân. Giữ lại vì rẻ; đừng tính nó vào độ phủ.
   *
   * Cổng THẬT của đường này là phép tra sổ phát-hành ngay dưới.
   *
   * Còn một thứ nữa chưa vá và phải nói ra: phép so với hash của nút chuỗi chạy SAU
   * `chain.submitTx`, nên khi nó đỏ thì giao dịch đã lên chuỗi rồi — lời "từ chối" ấy
   * là một báo cáo, không phải một cái chặn.
   */
  async submit(req: { txCbor: string; witnessCbor: string }): Promise<SubmitResponse> {
    assertHex(req.txCbor, "tx_cbor");
    assertHex(req.witnessCbor, "witness_cbor");

    let tx: CML.Transaction;
    try {
      tx = CML.Transaction.from_cbor_hex(req.txCbor);
    } catch (e) {
      throw new BadRequestError(`tx_cbor không giải mã được thành một giao dịch: ${(e as Error).message}`);
    }
    let witnesses: CML.TransactionWitnessSet;
    try {
      witnesses = CML.TransactionWitnessSet.from_cbor_hex(req.witnessCbor);
    } catch (e) {
      throw new BadRequestError(
        `witness_cbor không giải mã được thành TransactionWitnessSet: ${(e as Error).message}. ` +
        `App phải gửi TRỌN bộ chứng ký, không phải riêng một chữ ký.`,
      );
    }
    const vkeys = witnesses.vkeywitnesses();
    if (vkeys === undefined || vkeys.len() === 0) {
      // Bộ chứng ký RỖNG không phải "chưa ký xong" — nó là một giao dịch chắc chắn bị
      // chuỗi từ chối, bằng một câu không nhắc gì tới chữ ký. Chặn ở đây, nói thẳng.
      throw new BadRequestError(
        "witness_cbor không chứa chữ ký vkey nào. Giao dịch này sẽ bị chuỗi từ chối; " +
        "app cần ký thân giao dịch rồi gửi bộ chứng ký thật.",
      );
    }
    // Chữ ký phải đúng trên body hash và phủ đủ `required_signers` TRƯỚC mọi lần ghi sổ hay gửi nút
    // (`witnessCheck.ts`): chữ ký rác không được làm tx thật của chủ rơi vào "bị thay".
    this.witnessCheck(tx, witnesses);

    const bodyHashBefore = CML.hash_transaction(tx.body()).to_hex();

    // ── XUẤT XỨ: chỉ nộp thứ CHÍNH dịch vụ này đã dựng ──────────────────────────
    // Cổng này phải đứng TRƯỚC `chain.submitTx`. Không có nó, đường này nhận một
    // `tx_cbor` bất kỳ — giao dịch của dapp khác, giao dịch rác, giao dịch hàng loạt —
    // và nộp bằng khoá nhà cung cấp của người vận hành. Điều kiện duy nhất là thẻ bài
    // chia sẻ, thứ nằm sẵn trong mọi bản app.
    //
    // Nó KHÔNG phải cổng uỷ quyền: nó không nói người gọi có quyền với `owner_pkh`
    // nào (Nợ #78). Nó chỉ chặn việc mượn đường nộp.
    const issuedEntry = this.deps.issued.lookup(bodyHashBefore, this.now());
    if (issuedEntry === null) {
      throw new SubmitRejectedError(
        "Giao dịch này không do dịch vụ dựng ra, hoặc đã quá hạn nộp. Dịch vụ chỉ nộp " +
        "giao dịch chính nó vừa phát hành — hãy gọi lại một trong các đường /tx/* để " +
        "dựng bản mới rồi ký bản đó.",
        { body_hash: bodyHashBefore },
      );
    }

    // ── BỊ THAY: xung đột giữa hai lượt dựng bắt Ở ĐÂY, không ở lúc dựng (`locks.ts`) ──────
    // Mốc "bị thay" là một lượt NỘP (cần chữ ký chủ), không phải một lượt DỰNG (ai cũng gọi
    // được) — nên tx người lạ dựng không bao giờ làm tx của chủ rơi vào nhánh này.
    // Tx đã nộp mà sau đó bị một tx chung khoá nộp sau thay VẪN nhận 409 ở đây (không miễn trừ):
    // nộp lại nó là đường ra két thứ hai cho cùng chủ (`locks.ts` ▸ `markSubmitted`).
    const submission = submissionStateOf(issuedEntry);
    if (issuedEntry.supersededBy !== undefined) {
      throw new TxSupersededError(bodyHashBefore, {
        superseded_by: issuedEntry.supersededBy, previously_submitted: submission !== "none", submission,
      });
    }
    const inputRefs = inputRefsOf(req.txCbor).map(refStr);
    const conflicting = this.deps.pending?.conflicts(inputRefs, this.now(), bodyHashBefore) ?? [];
    if (conflicting.length > 0) {
      throw new TxSupersededError(bodyHashBefore, {
        conflicting_inputs: conflicting, previously_submitted: submission !== "none", submission,
      });
    }

    // ── NỘP LẠI tx nút đã NHẬN: trả lại kết quả cũ, KHÔNG gửi lần nữa ──────────────────
    // Lượt đầu đã vào mempool; gửi lại không thêm gì nếu nó còn đó, và nếu nó đã rơi khỏi mempool
    // thì gửi lại là hồi sinh một tx mà sổ này không còn theo dõi xung đột cho nó được nữa (tx chung
    // khoá dựng sau lượt đầu không bị nó thay). Tx rơi khỏi mempool ⟹ app tra chuỗi rồi dựng lại.
    if (issuedEntry.submittedAtMs !== undefined) {
      return { txHash: bodyHashBefore, lockReleasedFor: issuedEntry.submittedResult?.lockReleasedFor ?? null };
    }

    const builder = CML.TransactionWitnessSetBuilder.new();
    builder.add_existing(tx.witness_set());
    builder.add_existing(witnesses);
    const assembled = CML.Transaction.new(tx.body(), builder.build(), tx.is_valid(), tx.auxiliary_data());

    const bodyHashAfter = CML.hash_transaction(assembled.body()).to_hex();
    if (bodyHashAfter !== bodyHashBefore) {
      throw new SubmitRejectedError(
        "Ghép chứng ký làm đổi hash thân giao dịch — chữ ký của người dùng sẽ không còn đúng. " +
        "Từ chối nộp.",
        { body_hash_before: bodyHashBefore, body_hash_after: bodyHashAfter },
      );
    }

    // Đã gửi mà không có xác nhận: tx có thể đang ở mempool ⟹ ghi như một lượt nộp (input vào sổ
    // chờ, tx chung khoá dựng trước bị thay) nhưng ở trạng thái `unconfirmed`. Không ghi thì lượt
    // nộp lại bị đối xử như tx chưa từng gửi, và tx chung khoá nộp sau không bị chặn.
    const noteUnconfirmed = (): void => {
      this.deps.pending?.note(inputRefs, this.now(), bodyHashBefore);
      this.deps.issued.markSubmitted(bodyHashBefore, this.now(), "unconfirmed");
    };
    let chainHash: string;
    try {
      chainHash = await this.deps.chain.submitTx(assembled.to_cbor_hex());
    } catch (e) {
      // Nút TỪ CHỐI (không phải mất kết nối) ⟹ giao dịch này không bao giờ lên chuỗi, nên giữ
      // khoá tới hết hạn chỉ chặn chủ dựng lại bản đúng. Mất kết nối / quá giờ thì KHÔNG nhả:
      // không biết giao dịch đã vào mempool hay chưa — và ghi `unconfirmed`.
      if (e instanceof SubmitRejectedError) this.deps.locks.releaseByTxHash(bodyHashBefore);
      else noteUnconfirmed();
      throw e;
    }
    if (chainHash !== bodyHashBefore) {
      // Tx ĐÃ được gửi; lời "từ chối" này là một báo cáo, không phải một cái chặn.
      noteUnconfirmed();
      throw new SubmitRejectedError(
        "Nút chuỗi báo một tx hash khác với hash thân giao dịch mà dịch vụ vừa nộp.",
        { submitted_hash: bodyHashBefore, node_hash: chainHash },
      );
    }
    this.deps.pending?.note(inputRefs, this.now(), bodyHashBefore);
    const lockReleasedFor = this.deps.locks.releaseByTxHash(bodyHashBefore);
    this.deps.issued.markSubmitted(bodyHashBefore, this.now(), "accepted", { lockReleasedFor });
    return { txHash: bodyHashBefore, lockReleasedFor };
  }

  /**
   * Chủ đã có két instant ở địa chỉ được cấu hình, hoặc (khi yêu cầu khai `did_commit`) một két
   * instant đã nối đúng DID đó ⟹ 409 `VAULT_ALREADY_EXISTS`, kèm tham chiếu két đang có. Không dựng
   * két thứ hai: két thứ hai cùng chủ làm mọi đường dựng sau rơi vào 409 `VAULT_AMBIGUOUS`, và két
   * thứ hai cùng DID là đúng thứ `INV-ONE-PERSON-ONE-VAULT` cấm.
   *
   * MỨC ĐÚNG của cổng này: lưới an toàn của DỊCH VỤ (chống bấm hai lần, app gửi lại), KHÔNG phải
   * cổng chống Sybil — bất biến chưa được ép on-chain (BOUNDARIES §2), ai cũng dựng được tx genesis
   * không qua dịch vụ. Tx tạo két vừa nộp mà chưa vào khối thì phép đọc này không thấy; chỗ chặn ca
   * đó là khoá mềm theo chủ (`OwnerLockTable`) trong hạn TTL.
   */
  private async assertNoInstantVaultYet(scope: VaultScope, owner: OwnerRef, didCommit: string | undefined): Promise<void> {
    const utxos = await this.deps.chain.utxosAt(scope.address);
    // Đọc theo đúng luật của đường tra két (`findVaultsAtScope`): UTxO không mang NFT danh-tính
    // không phải két; mang NFT mà datum hỏng ⟹ NÉM (lược đồ đã trôi), không bỏ qua im lặng.
    const { vaults } = findVaultsAtScope(utxos, scope, owner);
    const existing: { vault_ref: string; vault_nft: string; matched_by: "owner" | "did_commit" }[] =
      vaults.map(v => ({ vault_ref: refStr(v.utxo), vault_nft: v.vaultIdUnit, matched_by: "owner" }));
    if (didCommit !== undefined) {
      for (const u of utxos) {
        const unit = vaultIdUnitOf(u, scope.scriptHash);
        if (unit === null || typeof u.datum !== "string" || u.datum === "") continue;
        if (existing.some(e => e.vault_ref === refStr(u))) continue;
        if (decodeVaultDatumOrThrow(u.datum).wakeme_link === didCommit) {
          existing.push({ vault_ref: refStr(u), vault_nft: unit, matched_by: "did_commit" });
        }
      }
    }
    if (existing.length > 0) {
      throw new CodedApiError(409, "VAULT_ALREADY_EXISTS",
        `Đã có ${existing.length} két instant cho ${existing[0]!.matched_by === "owner" ? "chủ này" : "DID này"} — ` +
        `không dựng két thứ hai. Dùng két đang có (vault_ref).`,
        { vault_type: "Instant", existing });
    }
  }

  scopesFor(vaultType: string | undefined): VaultScope[] {
    if (vaultType === undefined) return this.deps.deployment.vaults;
    const hit = this.deps.deployment.vaults.filter(s => s.vaultType === vaultType);
    if (hit.length === 0) {
      throw new BadRequestError(
        `Không có địa chỉ vault nào được cấu hình cho loại "${vaultType}".`,
        { configured: this.deps.deployment.vaults.map(s => s.vaultType) },
      );
    }
    return hit;
  }
}

function assertHex(v: string, name: string): void {
  if (typeof v !== "string" || v === "" || !HEX.test(v) || v.length % 2 !== 0) {
    throw new BadRequestError(`${name} phải là chuỗi hex thường, số ký tự CHẴN, khác rỗng.`);
  }
}

// ── Thân bài JSON ───────────────────────────────────────────────────────────────
//
// Mọi số tiền là CHUỖI chữ số — xem `units.ts` cho lý do đo được, không phải sở thích.

/** `OwnerAuthError` (ném từ bộ dựng / nhân chứng) → lỗi API có mã; lỗi khác đi nguyên. */
function asOwnerApiError(e: unknown): unknown {
  if (e instanceof OwnerAuthError) return ownerApiErrorOf(e);
  if (e instanceof FundingError) return fundingApiErrorOf(e);
  return e;
}

/**
 * Ghi chú ký cho đường `funding`. Thứ tự là thứ bắt buộc, không phải gợi ý: chữ ký nào cũng
 * ký trên hash THÂN giao dịch, nên thân phải chốt TRƯỚC mọi chữ ký, và đổi thân sau đó thì
 * mọi chữ ký đã có đều mất hiệu lực.
 */
function fundingNotes(
  owner: OwnerRef, w: ResolvedOwnerWitness | undefined, f: FundingRequest,
  s: { controllerPkh: string; deviceKeyHash: string },
): string[] {
  const ownerNotes = owner.type === "key" ? [`Chủ khoá: ký bằng khoá ${owner.hash}.`] : (w?.notes ?? []);
  if (f.feeSource === "did_payment") {
    const c = f.collateral!;
    return [
      ...ownerNotes,
      `LAMP + min-ADA của vault + PHÍ chi từ ví Phoenix ${f.address} (script did_payment, redeemer Spend, ` +
        `script đính inline); seed NFT két là một UTxO did_payment trong số đó; phần thối về lại đúng địa chỉ đó.`,
      `Ví Phoenix ký bằng controller ${s.controllerPkh} VÀ khoá thiết bị ${s.deviceKeyHash}.`,
      `Thế chấp: UTxO ${refStr(c.utxoRef)} của ${c.address} — ví này KHÔNG góp input tiêu nào, chỉ nhận ` +
        `collateral_return; nó vẫn phải ký bằng khoá thanh toán của địa chỉ đó (input thế chấp cần chữ ký).`,
      `Thứ tự: thân giao dịch này là bản CHỐT — ký trên đúng tx_hash trả về; đổi bất kỳ byte nào ` +
        `của thân sau đó thì mọi chữ ký đã có mất hiệu lực. Hạn dùng ≤ 1 giờ kể từ lúc dựng.`,
    ];
  }
  const fp = `${f.feePayer!.utxoRef.txHash}#${f.feePayer!.utxoRef.outputIndex}`;
  return [
    ...ownerNotes,
    `LAMP + min-ADA của vault chi từ ví Phoenix ${f.address} (script did_payment, redeemer Spend, ` +
      `script đính inline); phần thối về lại đúng địa chỉ đó.`,
    `Ví Phoenix ký bằng controller ${s.controllerPkh} VÀ khoá thiết bị ${s.deviceKeyHash}.`,
    `Phí + tài sản thế chấp: UTxO ${fp} của ${f.feePayer!.address}; tiền thối ADA và collateral_return ` +
      `về đúng địa chỉ đó. Bên trả phí ký bằng khoá thanh toán của địa chỉ đó.`,
    `Thứ tự: thân giao dịch này là bản CHỐT — ký trên đúng tx_hash trả về; đổi bất kỳ byte nào ` +
      `của thân sau đó thì mọi chữ ký đã có mất hiệu lực. Hạn dùng ≤ 1 giờ kể từ lúc dựng.`,
  ];
}

/**
 * Chế độ báo giá chỉ chạy khi yêu cầu MANG ví trả phí và UTxO đưa sẵn đúng là UTxO đó. Lệch là
 * lỗi của người gọi trong gói này (`feeQuote.ts`), không phải của app ⟹ NÉM, không đoán.
 */
function assertQuoteMatches(quote: QuoteMode | undefined, fp: FeePayerRequest | undefined): void {
  if (quote === undefined) return;
  const u = quote.feePayerUtxo;
  if (fp === undefined || refStr(fp.utxoRef) !== refStr(u) || fp.address !== u.address) {
    throw new Error("[bất biến nội bộ] chế độ báo giá: UTxO trả phí đưa sẵn không khớp ví trả phí của yêu cầu.");
  }
}

/** Chủ phải là `{ type: "key" | "script", hash: 56 hex thường }` — dịch vụ gọi thẳng cũng bị kiểm. */
function assertOwnerRef(o: OwnerRef): OwnerRef {
  if (o === null || typeof o !== "object" || (o.type !== "key" && o.type !== "script")) {
    throw new CodedApiError(400, "OWNER_CREDENTIAL_SHAPE", `"owner.type" phải là "key" hoặc "script".`);
  }
  if (typeof o.hash !== "string" || !PKH_HEX.test(o.hash)) {
    throw new CodedApiError(400, "OWNER_HASH_INVALID", `"owner.hash" phải là 56 ký tự hex thường.`);
  }
  return { type: o.type, hash: o.hash };
}

/** `required_signers` của thân tx, theo thứ tự. Không trường ⟹ mảng rỗng (đó là câu trả lời thật). */
function requiredSignersOf(txCbor: string): string[] {
  const rs = CML.Transaction.from_cbor_hex(txCbor).body().required_signers();
  const out: string[] = [];
  for (let i = 0; rs !== undefined && i < rs.len(); i++) out.push(rs.get(i).to_hex());
  return out;
}

export function toCreateVaultBody(r: CreateVaultResponse): Record<string, unknown> {
  return {
    tx_cbor: r.txCbor,
    tx_hash: r.txHash,
    vault_nft: r.vaultNft,
    vault_address: r.vaultAddress,
    owner: { type: r.owner.type, hash: r.owner.hash },
    required_signers: r.requiredSigners,
    witness_notes: r.witnessNotes,
    summary: r.summary,
    expires_at: r.expiresAt,
    expires_reason: r.expiresReason,
  };
}

export function toOpenThreadBody(r: OpenThreadResponse): Record<string, unknown> {
  return {
    tx_cbor: r.txCbor,
    tx_hash: r.txHash,
    engage_nft: r.engageNft,
    engage_address: r.engageAddress,
    owner: { type: r.owner.type, hash: r.owner.hash },
    required_signers: r.requiredSigners,
    witness_notes: r.witnessNotes,
    summary: r.summary,
    expires_at: r.expiresAt,
    expires_reason: r.expiresReason,
  };
}

export function toBindDidBody(r: BindDidResponse): Record<string, unknown> {
  return {
    tx_cbor: r.txCbor,
    tx_hash: r.txHash,
    engage_nft: r.engageNft,
    engage_address: r.engageAddress,
    owner: { type: r.owner.type, hash: r.owner.hash },
    did_commit: r.didCommit,
    required_signers: r.requiredSigners,
    witness_notes: r.witnessNotes,
    summary: r.summary,
    expires_at: r.expiresAt,
    expires_reason: r.expiresReason,
  };
}

export function toBuildBody(r: BuildResponse): Record<string, unknown> {
  return {
    tx_cbor: r.txCbor,
    tx_hash: r.txHash,
    summary: r.summary,
    expires_at: r.expiresAt,
    expires_reason: r.expiresReason,
    // UTxO của CHỦ KHÁC chỉ được ĐẾM, không liệt kê: danh sách đó lớn theo số vault của cả hệ
    // (mỗi lượt dựng trả về tham chiếu vault của mọi người khác), không nói gì với chủ đang hỏi.
    ignored: r.ignored.filter(x => x.reason !== "OWNER_MISMATCH").map(x => ({ utxo_ref: x.utxoRef, reason: x.reason })),
    ignored_other_owner_count: r.ignored.filter(x => x.reason === "OWNER_MISMATCH").length,
    required_signers: r.requiredSigners,
    witness_notes: r.witnessNotes,
  };
}

export function toSubmitBody(r: SubmitResponse): Record<string, unknown> {
  return { tx_hash: r.txHash, lock_released_for: r.lockReleasedFor };
}

// ── sổ phát-hành: route + mã ghi sổ Feecover ─────────────────────────────────

const ROUTE_OF_INTENT: Record<string, IssuedRoute> = {
  schedule_commit: "schedule-commit",
  schedule_fire: "schedule-fire",
  instant_gen: "instant-gen",
  refresh_checkpoint: "refresh-checkpoint",
  consume: "consume",
};

/** Ý định dựng → tên route. Ý định lạ ⟹ NÉM: ghi sai route là xin ký dưới sai mục đích. */
function routeOfIntent(intent: string): IssuedRoute {
  const r = ROUTE_OF_INTENT[intent];
  if (r === undefined) throw new Error(`Ý định dựng "${intent}" chưa có route trong sổ phát-hành.`);
  return r;
}

/** Tên tài sản của một unit (`policy 56 hex + tên`) khi tên đúng khuôn hash 64 hex; khác ⟹ `undefined`. */
function hash64NameOf(unit: string): string | undefined {
  const name = unit.slice(56);
  return /^[0-9a-f]{64}$/.test(name) ? name : undefined;
}

/**
 * Két Prepaid đã có khuôn cấu hình (`config.ts` ▸ `PREPAID_VAULT_TYPE`) nhưng CHƯA route nào
 * dựng tx cho nó: bộ tìm két, bộ giải datum và bộ dựng của mọi route hiện có là của
 * Instant/Schedule. Để scope Prepaid lọt vào đó thì nó chết ở một chỗ không nói gì về loại két
 * (datum "không giải được" 502, `vaultModuleOf` 422, `requireShard` 501). Chặn ở ĐÂY, trước
 * khi đọc chuỗi, bằng một mã đọc được.
 */
function assertScopesSupported(scopes: VaultScope[], route: string): void {
  const prepaid = scopes.filter(s => s.vaultType === PREPAID_VAULT_TYPE);
  if (prepaid.length > 0) {
    throw new CodedApiError(501, "VAULT_KIND_UNSUPPORTED",
      `Loại két ${PREPAID_VAULT_TYPE} không đi qua route ${route} — két Prepaid chỉ được dựng qua ` +
      `hành trình tài trợ "/tx/sponsor/*" (t1-open · t2-fund · t3-draw · t4-first-consume).`,
      { vault_type: PREPAID_VAULT_TYPE, route, addresses: prepaid.map(s => s.address), use_instead: "/tx/sponsor/*" });
  }
}
