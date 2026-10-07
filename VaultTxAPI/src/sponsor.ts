// VaultTxAPI/src/sponsor.ts — hành trình tài trợ consume đầu (năm bước) trên két PrepaidGen, ở dạng route.
//
//   POST /tx/sponsor/plan              { owner, sponsor_pkh }                         — thuần, không chạm chuỗi
//   POST /tx/sponsor/open-vault           { owner, [owner_witness], [change_address | fee_payer], did_commit, [thread_lovelace] }
//                                         — két Prepaid + thread consume + genesis quỹ tài trợ CỦA DID; dịch vụ ký platform
//   POST /tx/sponsor/bind-did             { owner, [owner_witness], [change_address | fee_payer], [vault_ref] }
//                                         — SetDidCommit: gắn did_commit của thread vào két (một lần)
//   POST /tx/sponsor/open-fund            { owner, [owner_witness], [change_address | fee_payer] }
//                                         — BƯỚC BÙ: genesis quỹ cho DID có két mở trước khi open-vault chở quỹ; dịch vụ ký platform
//   POST /tx/sponsor/fund-vault          { owner, …, [fund_id], carp_amount, sponsor: { utxo_refs }, [vault_ref] }   [thẻ vai sponsor]
//   GET  /sponsor/funds                   tình trạng các quỹ tài trợ đã ghim (`sponsorFund.ts`)
//
// ── MỖI DID MỘT QUỸ TÀI TRỢ ─────────────────────────────────────────────────────
// fund-vault nạp CARP vào quỹ tài trợ CỦA DID người mới (`sponsorship.owner_commit` == `did_commit`),
// không vào quỹ chung: CARP đó thu hồi về bên tài trợ theo DID (`sponsorFund.ts`, đầu tệp). `fund_id`
// vắng ⟹ dịch vụ tìm quỹ đó trong tập ghim; có ⟹ quỹ phải đúng của DID, không thì từ chối trước khi dựng.
//
// ── GENESIS QUỸ: AI KÝ, VÌ SAO NẰM TRONG open-vault ─────────────────────────────────
// Genesis quỹ (`PrepaidGen/onchain/validators/prepaid.ak` ▸ `validate_mint_fund_nft`) đòi ĐÚNG MỘT chữ ký:
// `platform` (`expect list.has(tx.extra_signatories, fd.platform)`). Không đòi bên tài trợ (CARP KHÔNG vào
// lúc genesis — `carp_locked == 0`; CARP vào ở fund-vault, nơi `validate_fund_lock` đòi bên tài trợ ký),
// không đòi chủ két. `platform` = phần tử đầu của `paid_fund.sponsor.platform_pkhs`.
// Chủ dự án chốt 2026-10-07: dịch vụ giữ MỘT khoá, chỉ cho vai này (`platformSigner.ts`), và đồng ký genesis
// quỹ ngay trong tx open-vault — bớt một bước, bên trả phí không phải giữ khoá platform. DID của quỹ
// (`owner_commit`) = `did_commit` của thread đúc trong CHÍNH tx đó (đã qua `assertOwnerDid`). Seed one-shot
// của quỹ = seed của két (UTxO ví trả phí, `collectSeed: false` ở phía quỹ) — `fund_id` vẫn là
// `computeFundId(seed)`. open-fund còn lại làm bước BÙ cho két mở trước bản này; DID của nó đọc từ thread.
//   POST /tx/sponsor/draw-magic           { owner, …, fund_id, carp_amount, [vault_ref] }
//   POST /tx/sponsor/first-consume  { owner, …, op_type, op_count, draw_epoch, [vault_ref], [engage_ref] }
//
// ── VÌ SAO MỖI BƯỚC MỘT ROUTE ───────────────────────────────────────────────────
// Mỗi bước tiêu output của bước trước (két, thread, lô MAGIC), nên tx bước sau chỉ dựng được khi tx
// bước trước ĐÃ vào khối. Và fund-vault có người ký khác (bên tài trợ). Một route "dựng cả bốn" sẽ phải dựng
// trên trạng thái chưa tồn tại — ra bốn tx mà ba cái sau chết sau khi người dùng đã ký.
//
// ── MAGIC KHÔNG GIỮ CHÍNH SÁCH TÀI TRỢ ──────────────────────────────────────────
// Một-lần-mỗi-DID, hạn mức: việc của Feecover (bên vận hành tài trợ), đếm theo `owner_commit` qua
// anchor DID ở reference input của fund-vault. Dịch vụ này chỉ dựng HÌNH DẠNG tx; bộ dựng là
// `@magiclamp/sdk` ▸ `buildSponsorT*`, không phải một bản thứ hai.
//
// ── THÂN BÀI KHÔNG QUYẾT TIỀN CỦA BÊN TÀI TRỢ ĐI ĐÂU ─────────────────────────────
// Ba thứ của fund-vault ghim ở cấu hình (`paid_fund.sponsor`), không lấy từ thân bài: tập quỹ được nạp, tập
// địa chỉ ví bên tài trợ (UTxO vào + thối ra, NGUYÊN VĂN cả phần stake), trần CARP. Đối chiếu hai lần:
// trước khi dựng (`assertFundPinnedInputs`, `assertSponsorUtxosPinned`) và trên CBOR vừa dựng
// (`assertFundPinnedOutputs`), cả hai lần so với giá trị ĐÃ GHIM, không với thân bài. fund-vault chỉ mở bằng thẻ
// vai sponsor (`http.ts` ▸ `requireRole`).
//
// ── CHỦ open-vault/fund-vault PHẢI LÀ DID ───────────────────────────────────────────────────────
// Feecover đếm một-lần-mỗi-DID theo `did_commit`. Chủ khoá tự khai `did_commit` bất kỳ được ⟹ giành
// được suất của DID người khác. Nên open-vault/fund-vault chỉ nhận chủ `Script(did_stake)`, và tên NFT anchor trong
// nhân chứng phải bằng `did_commit` của thread (`assertOwnerDid`) — `did_stake` ép trên chuỗi rằng
// anchor đó là của chính DID ký. Lối chủ khoá chỉ mở qua `allowKeyOwner` của hàm dựng, thứ mà
// `server.ts` không truyền và không cấu hình nào đặt được.
//
// ── KHÔNG GIỮ KHOÁ CHI TIỀN ────────────────────────────────────────────────────
// Khoá DUY NHẤT dịch vụ giữ là khoá platform của genesis quỹ (`platformSigner.ts`); nó chỉ ký tx chính dịch vụ
// vừa dựng trong cùng lượt, có đúng một mint +1 NFT quỹ và `required_signers` chứa pkh platform.
// fund-vault nhận UTxO của bên tài trợ dưới dạng THAM CHIẾU (`sponsor.utxo_refs`), đọc lại từ chuỗi, và trả
// tx CHƯA KÝ. Bên tài trợ, ví trả phí, chủ két ký bằng khoá của chính họ, ngoài dịch vụ.
//
// ── HAI CÁCH TRẢ PHÍ: `change_address` HOẶC `fee_payer` ─────────────────────────
// `change_address`: ví KHOÁ của bên trả phí; dịch vụ đưa MỌI UTxO của ví đó cho chọn-coin.
// `fee_payer` `{ utxo, address }` (mô hình Feecover, cùng hình dạng + cùng mã lỗi `FEE_PAYER_*` như
// mọi đường dựng khác — `feePayer.ts`): tx tiêu ĐÚNG UTxO đó, nó vừa là tài sản thế chấp DUY NHẤT
// (lượng tường minh `fee_payer_collateral_lovelace`), hạn dùng ≤ 1 giờ, tiền thối ADA về lại đúng
// `fee_payer.address`. Hai trường loại trừ nhau (400 `FEE_PAYER_CHANGE_ADDRESS_CONFLICT`).
//
// Khác các đường dựng khác ở MỘT chỗ có chủ đích: ví trả phí ở đây được phép mất THÊM khoản min-ADA
// ứng cho output két/thread/quỹ (open-vault: két Prepaid + thread mới; các bước sau: phần min-ADA tăng nếu
// datum lớn lên) — người mới có 0 ADA, nên không ai khác ứng được. Bù lại, phép đọc lại CBOR
// (`checkSponsorFeePayerTx`) ép tập địa chỉ ĐÓNG: input chỉ gồm UTxO trả phí + đúng các UTxO script
// của luồng (+ UTxO bên tài trợ ở fund-vault); output chỉ tới ví trả phí, các script của luồng, và bên tài trợ
// ở fund-vault; khoản ứng = đúng phần lovelace tăng ở output script, bên tài trợ không được nhận thêm ADA.

import {
  CML, applyParamsToScript, getAddressDetails, validatorToAddress, validatorToScriptHash, valueToAssets,
  type Assets, type LucidEvolution, type Network as SlotNetwork, type Script, type TxBuilder, type UTxO, type Validator,
} from "@lucid-evolution/lucid";
import {
  OwnerAuthError, WindowOriginError, applyOwnerAuth, collateralCompleteOptions, msPerEpoch, resolveOwnerAuth, sameOwner,
  wakemeVaultHash, windowOriginMs, windowStartMs,
  type Network, type OwnerAuth, type OwnerRef,
} from "@magiclamp/protocol-utils";
import {
  SponsorJourneyError, buildSponsorT1OpenPrepaid, buildSponsorT2Fund, buildSponsorT3Draw,
  buildSponsorT4FirstConsume, planSponsorJourney, sponsorTxOutputsOf, sponsorTxWithdrawalCountOf,
  type SponsorJourneyErrorCode, type SponsorTxOutput,
} from "@magiclamp/sdk";
import {
  MIN_BUFFER_BPS, PrepaidRuleError, PrepaidTxError, SPONSOR_RECLAIM_DELAY_EPOCHS, addSetDidCommit, applyPlan, derivePrepaidScripts, planMintPaidFund,
  maxClaimable, planFundClaim,
  plutusDataFromCbor, readVaultUtxo, validityInEpoch, withRefScripts,
  type PlutusAddress, type PrepaidBlueprint, type PrepaidScripts, type TxValidity,
} from "@magiclamp/prepaidgen-sdk";

import { ownerReq, reqBigint, reqSmallInt } from "./buildRequest.js";
import type { ChainReader, ChainTip } from "./chain.js";
import { PREPAID_VAULT_TYPE, type Deployment, type DidStakeDeployment, type SponsorPins, type VaultScope } from "./config.js";
import { didCommitOf, parseDidCommit, parseEngageRef, pickEngageThread } from "./engage.js";
import {
  ChainUnavailableError, CodedApiError, ConfigMissingError, TxApiError, TxBuildRejectedError,
  VaultAmbiguousError, VaultDatumUndecodableError, VaultNotFoundError, ownerApiErrorOf,
} from "./errors.js";
import {
  FEE_PAYER_CODES, assertFeePayerAddress, parseFeePayer, checkCollateral, feePayerRecordFields, checkOwnerRewardReturn, checkValidTo, inputRefsOf,
  ownerRewardNote, ownerRewardSummaryOf, planOwnerRewardReturn, readFeePayerUtxo, refStr, withOwnerRewardReturn,
  type FeePayerRequest, type OutRefLike, type OwnerRewardReturn, type OwnerRewardSummary,
} from "./feePayer.js";
import { pickByNft } from "./genV2.js";
import {
  assertDidNotFundedElsewhere, classifySponsorFunds, fundsBlockingOpen, resolveSponsorFund, sponsorFundsStatusBody,
  type SponsorFundBusyReason, type SponsorFundEntry,
} from "./sponsorFund.js";
import {
  DidGenesisHolds, IssuedTxRegistry, OwnerLockTable, PendingSpends, type FeeReservation, type SponsorRoute,
} from "./locks.js";
import { isDidOwner, ownerLockKey, type OwnerWitnessProvider, type ResolvedOwnerWitness } from "./owner.js";
import { didPaymentAddressFor, resolveOwnerInput, type DidOwnerResolverPort, type WithResolvedOwner } from "./didOwner.js";
import type { OwnerRequest } from "./service.js";
import { txBodyHash } from "./summary.js";
import { assertChangeAddress, enterpriseAddressOf } from "./txBuilder.js";
import { raw } from "./units.js";
import {
  DEFAULT_TX_VALIDITY_MS, expiryNote, planValidity, readTxExpiry, type ExpiresReason, type ValidityPlan,
} from "./validity.js";

/** Tên biến môi trường mang khoá platform — để nêu trong `details.missing` (giá trị đọc ở `config.ts`). */
const PLATFORM_KEY_ENV = "VAULT_TX_API_PLATFORM_KEY";

// ── Bảng mã lỗi SDK → HTTP ─────────────────────────────────────────────────────

/**
 * `SponsorJourneyError.code` → mã HTTP. `Record` trên ĐÚNG kiểu mã của SDK ⟹ SDK thêm một mã mà bảng
 * chưa có thì `tsc` đỏ ở đây, không lọt thành 500 im lặng.
 *
 *   "internal" ⟹ 500 `INTERNAL` + `reference_code` (nhật ký giữ nguyên nhân). Hai mã đó chỉ nổ khi
 *   CHÍNH dịch vụ dựng sai: lưới kỳ do dịch vụ apply từ mạng (`GRID_MISMATCH`), và anchor dịch vụ
 *   luôn truyền — SDK báo thiếu nghĩa là tx dựng ra mất reference input (`ANCHOR_REF_MISSING`).
 *   Thiếu anchor ở phía người gọi đã chặn trước bằng 404 `SPONSOR_ANCHOR_NOT_FOUND`.
 */
export const SPONSOR_ERROR_STATUS: Readonly<Record<SponsorJourneyErrorCode, number | "internal">> = {
  SPONSOR_DID_COMMIT_LENGTH: 400,
  SPONSOR_VALIDITY_SPANS_EPOCHS: 422,
  SPONSOR_EPOCH_MISMATCH: 409,
  SPONSOR_GRID_MISMATCH: "internal",
  SPONSOR_ANCHOR_REF_MISSING: "internal",
  SPONSOR_ANCHOR_REF_WRONG: 422,
  SPONSOR_FUND_NOT_PINNED: 422,
  SPONSOR_CARP_INSUFFICIENT: 422,
  SPONSOR_CARP_OUTPUT_UNPINNED: 422,
  SPONSOR_WITHDRAW_COUNT: 422,
  SPONSOR_BUILD_FAILED: 422,
};

/** `SponsorJourneyError` → lỗi API có mã (giữ NGUYÊN `code`), hoặc chính lỗi đó khi là lỗi nội bộ. */
export function sponsorApiErrorOf(e: SponsorJourneyError): TxApiError | SponsorJourneyError {
  const status = SPONSOR_ERROR_STATUS[e.code];
  if (status === "internal") return e;
  const prefix = `[${e.code}] `;
  const message = e.message.startsWith(prefix) ? e.message.slice(prefix.length) : e.message;
  return new CodedApiError(status, e.code, message);
}

/**
 * Lỗi bộ dựng (SDK, PrepaidGen, ConsumeMAGIC) → lỗi API, theo DANH SÁCH ĐÓNG các lớp có mã.
 *
 * Mọi lỗi KHÁC — `Error` thường, lỗi lập trình (`TypeError`…), lỗi của thư viện ngoài — đi NGUYÊN để
 * `http.ts` biến thành 500 + `reference_code` (nguyên nhân chỉ vào nhật ký). Bản trước gộp mọi `Error`
 * vào 422 `TX_BUILD_REJECTED` kèm `e.message` thô: vừa bảo người dùng "giao thức từ chối" khi thật ra mã
 * hỏng, vừa đưa ra ngoài câu chữ mà không ai duyệt là thông điệp cho người dùng (đường dẫn, tên biến,
 * CBOR). Hệ quả biết trước: `Error` thường của ConsumeMAGIC/PrepaidGen nay ra 500 — muốn nó là 422 thì
 * bộ dựng phải ném lớp có mã, không phải dịch vụ đoán.
 */
export function asSponsorApiError(e: unknown): unknown {
  if (e instanceof TxApiError) return e;
  if (e instanceof SponsorJourneyError) return sponsorApiErrorOf(e);
  if (e instanceof WindowOriginError) return networkUnsupported(e.code);
  // Hai lớp `OwnerAuthError` (protocol-utils, và bản riêng của PrepaidGen) cùng tên + cùng `code`.
  if (e instanceof OwnerAuthError || (e instanceof Error && e.name === "OwnerAuthError" && typeof (e as { code?: unknown }).code === "string")) {
    return ownerApiErrorOf(e as unknown as { code: string; message: string });
  }
  if ((e instanceof PrepaidTxError || e instanceof PrepaidRuleError) && typeof e.code === "string") {
    return new TxBuildRejectedError(e.message, { thrown_by: e.name, rule_code: e.code });
  }
  return e;
}

function networkUnsupported(causeCode: string): CodedApiError {
  return new CodedApiError(501, "SPONSOR_NETWORK_UNSUPPORTED",
    `Mạng này chưa có gốc cửa sổ kỳ (window_origin_ms): két Prepaid ép mọi validity gọn trong một kỳ theo ` +
    `gốc đó, nên hành trình tài trợ không dựng được ở đây.`, { cause_code: causeCode });
}

// ── Yêu cầu ───────────────────────────────────────────────────────────────────

export type SponsorStep = "open-vault" | "bind-did" | "open-fund" | "fund-vault" | "draw-magic" | "first-consume" | "claim";

/** Đường → bước, theo THỨ TỰ hành trình. Một bảng, đọc ở router và ở README. */
export const SPONSOR_STEP_OF_PATH: Readonly<Record<string, SponsorStep>> = {
  "/tx/sponsor/open-vault": "open-vault",
  "/tx/sponsor/bind-did": "bind-did",
  "/tx/sponsor/open-fund": "open-fund",
  "/tx/sponsor/fund-vault": "fund-vault",
  "/tx/sponsor/draw-magic": "draw-magic",
  "/tx/sponsor/first-consume": "first-consume",
  "/tx/sponsor/claim": "claim",
};

const ISSUED_ROUTE_OF_STEP: Readonly<Record<SponsorStep, SponsorRoute>> = {
  "open-vault": "sponsor-open-vault", "bind-did": "sponsor-bind-did", "open-fund": "sponsor-open-fund",
  "fund-vault": "sponsor-fund-vault", "draw-magic": "sponsor-draw-magic", "first-consume": "sponsor-first-consume",
  "claim": "sponsor-claim",
};

/**
 * Tên bước của bộ dựng SDK (`@magiclamp/sdk` ▸ `planSponsorJourney`, còn ký hiệu `T1`…`T5`) → tên bước
 * của dịch vụ. Dịch vụ không trả ký hiệu số ra ngoài: `/tx/sponsor/plan` đổi ở đây, MỘT chỗ. `T5` là
 * genesis két Wakeme — không phải route của dịch vụ này, nên không có đường.
 */
const STEP_OF_SDK_STEP: Readonly<Record<string, SponsorStep | "wakeme-genesis">> = {
  T1: "open-vault", T2: "fund-vault", T3: "draw-magic", T4: "first-consume", T5: "wakeme-genesis",
};

function stepOfSdk(sdkStep: string): SponsorStep | "wakeme-genesis" {
  const s = STEP_OF_SDK_STEP[sdkStep];
  // SDK thêm bước mà bảng chưa có ⟹ NÉM (thành 500 + mã tham chiếu), không trả ký hiệu thô ra ngoài.
  if (s === undefined) throw new Error(`[bất biến nội bộ] bước SDK "${sdkStep}" chưa có tên ở STEP_OF_SDK_STEP.`);
  return s;
}

/** Ký hiệu bước SDK (`T1`…`T5`) lọt trong câu chữ của SDK (`requires`) → tên bước của dịch vụ. */
function renameSdkSteps(text: string): string {
  return text.replace(/(?<![A-Za-z0-9_])T([1-5])(?![0-9A-Za-z_])/g, (_m, d: string) => stepOfSdk(`T${d}`));
}

/**
 * Cận trên `validTo` cho một bước tài trợ (`validity.ts` ▸ `planValidity`) — cùng nguồn hạn với
 * `service.ts`. fund-vault, draw-magic, first-consume: validator đòi hai cận cùng một epoch ⟹ `epochBound`. open-vault không có cửa sổ kỳ.
 * Tx tiêu một UTxO ví trả phí xin qua `/fee/utxo` ⟹ kẹp thêm vào `reserved_until` của nó (sổ
 * phát-hành ghi lúc phát UTxO, `feeProxy.ts`). UTxO ở địa chỉ Feecover mà sổ không còn lượt giữ ⟹
 * 409 (`locks.ts` ▸ `feeReservationForBuild`). Ví không phải Feecover ⟹ không có giờ giữ chỗ.
 */
export function planSponsorValidity(p: {
  step: SponsorStep; tipPosixMs: bigint; network: Network; txValidityMs: number;
  issued: IssuedTxRegistry; feePayer?: { utxoRef: string; address: string; reservationId?: string };
}): ValidityPlan & { feeReservation?: FeeReservation } {
  // Lượt giữ cổng đã thấy đi kèm kế hoạch tới `record` (`feePayer.ts` ▸ `feePayerRecordFields`) — cùng
  // luật với `service.ts` ▸ `validityPlan`: sổ ghi ĐÚNG lượt đã qua cổng, không tra lại sau các `await`.
  const reserved = p.feePayer === undefined
    ? undefined : p.issued.feeReservationForBuild(p.feePayer.utxoRef, p.feePayer.address,
      p.feePayer.reservationId === undefined ? {} : { reservationId: p.feePayer.reservationId });
  return {
    ...planValidity({
      // open-fund: genesis quỹ không đọc kỳ (chỉ đòi cận TRÊN hữu hạn để tính `reclaim_after_epoch`).
      tipPosixMs: p.tipPosixMs, network: p.network, txValidityMs: p.txValidityMs,
      epochBound: p.step !== "open-vault" && p.step !== "open-fund",
      ...(reserved === undefined ? {} : { feeReservedUntilMs: reserved.untilMs, feePayerUtxoRef: p.feePayer!.utxoRef }),
    }),
    ...(reserved === undefined ? {} : { feeReservation: reserved }),
  };
}

/**
 * Phần tham số hạn giao cho bộ dựng SDK của từng bước. MỌI bước đều nhận một cận — kể cả open-vault đường
 * `change_address` (bản trước chỉ đặt `validTo` cho open-vault khi có `fee_payer`, nên tx open-vault không có hạn).
 */
export function sponsorValidityArgs(step: SponsorStep, plan: ValidityPlan):
  { validToMs: bigint } | { validityTtlMs: bigint } | { validityMaxAheadMs: bigint } {
  if (step === "open-vault") return { validToMs: plan.capMs };
  if (step === "first-consume") return { validityMaxAheadMs: plan.maxAheadMs };
  return { validityTtlMs: plan.maxAheadMs };
}

export interface SponsorOpenVaultRequest extends OwnerRequest { didCommit: string; threadLovelace?: bigint }
/** bind-did: không nhận `did_commit` từ thân bài — DID gắn vào két là `did_commit` của THREAD (open-vault đã ghim). */
export interface SponsorBindDidRequest extends OwnerRequest { vaultRef?: OutRefLike }
/** open-fund: không nhận DID, platform, bên tài trợ hay bên hưởng từ thân bài — DID từ thread, phần còn lại ghim ở cấu hình. */
export type SponsorOpenFundRequest = OwnerRequest;
export interface SponsorFundVaultRequest extends OwnerRequest {
  vaultRef?: OutRefLike;
  /** Vắng ⟹ dịch vụ tìm quỹ tài trợ của DID của két trong tập ghim (`sponsorFund.ts` ▸ `resolveSponsorFund`). */
  fundId?: string;
  carpAmount: bigint;
  sponsorUtxoRefs: OutRefLike[];
}
export interface SponsorDrawMagicRequest extends OwnerRequest { vaultRef?: OutRefLike; fundId: string; carpAmount: bigint }
export interface SponsorFirstConsumeRequest extends OwnerRequest {
  vaultRef?: OutRefLike;
  engageRef?: OutRefLike;
  opType: number;
  opCount: bigint;
  drawEpoch: bigint;
}

/**
 * claim: không có chủ két. `fund_id` chỉ đích danh quỹ; `amount` vắng ⟹ toàn bộ phần claim được (`maxClaimable`).
 * Đích CARP, platform và bên tài trợ KHÔNG lấy từ thân bài — đích là beneficiary ghim ở datum quỹ và cấu hình.
 */
export interface SponsorClaimRequest { fundId: string; amount?: bigint; changeAddress?: string; feePayer?: FeePayerRequest }

const OUTREF = /^([0-9a-f]{64})#(0|[1-9][0-9]{0,4})$/;
const HEX28 = /^[0-9a-f]{56}$/;
const FUND_ID = /^(?:[0-9a-f]{2}){1,32}$/;
/** Trần số UTxO bên tài trợ một lượt: đủ cho mọi ví thật, chặn thân bài phình. */
const MAX_SPONSOR_UTXOS = 20;

function shape(message: string, details: Record<string, unknown> = {}): CodedApiError {
  return new CodedApiError(400, "SPONSOR_REQUEST_SHAPE", message, details);
}

function outRefOf(v: unknown, field: string): OutRefLike {
  const m = typeof v === "string" ? OUTREF.exec(v) : null;
  if (m === null) throw shape(`"${field}" phải là chuỗi "<tx_hash 64 hex>#<index>".`, { field });
  return { txHash: m[1]!, outputIndex: Number(m[2]!) };
}

function optOutRef(body: Record<string, unknown>, field: string): OutRefLike | undefined {
  return body[field] === undefined ? undefined : outRefOf(body[field], field);
}

function fundIdOf(body: Record<string, unknown>): string {
  const v = body.fund_id;
  if (typeof v !== "string" || !FUND_ID.test(v)) {
    throw shape(`"fund_id" phải là hex thường 1–32 byte (tên NFT quỹ dưới policy paid_fund).`, { field: "fund_id" });
  }
  return v;
}

/** Thân bài một bước → yêu cầu của dịch vụ. Sai ⟹ 400 có mã. */
export function parseSponsorRequest(step: "open-vault", body: Record<string, unknown>): SponsorOpenVaultRequest;
export function parseSponsorRequest(step: "bind-did", body: Record<string, unknown>): SponsorBindDidRequest;
export function parseSponsorRequest(step: "open-fund", body: Record<string, unknown>): SponsorOpenFundRequest;
export function parseSponsorRequest(step: "fund-vault", body: Record<string, unknown>): SponsorFundVaultRequest;
export function parseSponsorRequest(step: "draw-magic", body: Record<string, unknown>): SponsorDrawMagicRequest;
export function parseSponsorRequest(step: "first-consume", body: Record<string, unknown>): SponsorFirstConsumeRequest;
export function parseSponsorRequest(step: "claim", body: Record<string, unknown>): SponsorClaimRequest;
export function parseSponsorRequest(
  step: SponsorStep, body: Record<string, unknown>,
): SponsorOpenVaultRequest | SponsorBindDidRequest | SponsorOpenFundRequest | SponsorFundVaultRequest
  | SponsorDrawMagicRequest | SponsorFirstConsumeRequest | SponsorClaimRequest {
  // `funding` là khối nạp LAMP từ ví Phoenix của `/tx/create-vault`; ở đây không có gì để nạp. Gửi nó
  // (kể cả chỉ để mang `funding.fee_payer`) ⟹ 400, không lặng lẽ bỏ qua rồi dựng bằng ví khác.
  if (body.funding !== undefined) {
    throw shape(`"funding" không dùng ở hành trình tài trợ. Ví trả phí bên thứ ba đi qua "fee_payer" ` +
      `{ "utxo", "address" } ở gốc thân bài.`, { field: "funding" });
  }
  if (step === "claim") return parseClaimRequest(body);
  const base = ownerReq(body);
  const vaultRef = optOutRef(body, "vault_ref");
  const withVaultRef = vaultRef === undefined ? {} : { vaultRef };
  switch (step) {
    case "open-vault":
      // `thread_lovelace` là lovelace người gọi tự khai cho output SCRIPT (thread). Có `fee_payer` thì chính ví trả
      // phí bên thứ ba ứng khoản đó, rồi chủ đóng thread (CloseThread không ràng output) lấy lại ⟹ rút ADA của bên
      // trả phí. Đường `fee_payer` dùng sàn mặc định của bộ dựng thread; trường này chỉ còn ở đường `change_address`
      // (chủ tự trả). Từ chối, không lặng lẽ bỏ qua: bên gọi cần biết lượng họ khai không được dùng.
      if (body.thread_lovelace !== undefined && base.feePayer !== undefined) {
        throw new CodedApiError(400, "SPONSOR_THREAD_LOVELACE_WITH_FEE_PAYER",
          `"thread_lovelace" không đi cùng "fee_payer": lovelace của thread do ví trả phí ứng, nên dịch vụ dùng sàn ` +
          `mặc định của thread. Bỏ "thread_lovelace", hoặc tự trả bằng "change_address".`, { field: "thread_lovelace" });
      }
      return {
        ...base,
        didCommit: parseDidCommit(body.did_commit),
        ...(body.thread_lovelace === undefined ? {} : { threadLovelace: reqBigint(body, "thread_lovelace") }),
      } satisfies SponsorOpenVaultRequest;
    case "bind-did":
      // `did_commit` trong thân bài bị từ chối, không lặng lẽ bỏ qua: bên gọi tưởng mình chọn được DID.
      if (body.did_commit !== undefined) {
        throw shape(`"did_commit" không nhận ở bind-did: DID gắn vào két là did_commit của thread consume mà ` +
          `open-vault đã đúc. Bỏ trường này.`, { field: "did_commit" });
      }
      return { ...base, ...withVaultRef } satisfies SponsorBindDidRequest;
    case "open-fund": {
      // Mọi trường định tiền đi đâu / quỹ thuộc ai bị từ chối, không lặng lẽ bỏ qua: bên gọi tưởng mình chọn
      // được. DID = did_commit của thread; platform, bên tài trợ, bên hưởng, đệm = cấu hình `paid_fund.sponsor`.
      for (const f of ["did_commit", "owner_commit", "platform", "platform_pkh", "sponsor", "beneficiary", "buffer_bps",
        "fund_id", "vault_ref"]) {
        if (body[f] !== undefined) {
          throw shape(`"${f}" không nhận ở open-fund: DID của quỹ là did_commit của thread consume mà open-vault đã ` +
            `đúc; platform, bên tài trợ, bên hưởng và đệm do cấu hình dịch vụ ghim. Bỏ trường này.`, { field: f });
        }
      }
      return base satisfies SponsorOpenFundRequest;
    }
    case "fund-vault": {
      const sp = body.sponsor;
      if (sp === null || typeof sp !== "object" || Array.isArray(sp)) {
        throw shape(`"sponsor" phải là đối tượng { utxo_refs, change_address } của bên tài trợ.`, { field: "sponsor" });
      }
      const s = sp as Record<string, unknown>;
      if (!Array.isArray(s.utxo_refs) || s.utxo_refs.length === 0 || s.utxo_refs.length > MAX_SPONSOR_UTXOS) {
        throw shape(`"sponsor.utxo_refs" phải là mảng 1–${MAX_SPONSOR_UTXOS} tham chiếu UTxO chứa CARP của bên tài trợ.`,
          { field: "sponsor.utxo_refs" });
      }
      const refs = s.utxo_refs.map((r, i) => outRefOf(r, `sponsor.utxo_refs[${i}]`));
      if (new Set(refs.map(refStr)).size !== refs.length) {
        throw shape(`"sponsor.utxo_refs" có tham chiếu trùng.`, { field: "sponsor.utxo_refs" });
      }
      // Đích thối KHÔNG do người gọi viết: bản trước nhận `sponsor.change_address` từ thân bài và chỉ
      // kiểm phần thanh toán là khoá ⟹ kẻ gọi đặt ví mình vào đó, và TOÀN BỘ phần dư của các UTxO bên
      // tài trợ (ADA + mọi token + CARP thừa) đi sang ví kẻ gọi với status 200. Nay đích thối = địa chỉ
      // chung của `utxo_refs`, đã ghim ở cấu hình (`assertSponsorUtxosPinned`). Gửi trường này ⟹ 400,
      // không lặng lẽ bỏ qua: bên gọi cũ cần biết trường của họ không còn tác dụng.
      if (s.change_address !== undefined) {
        throw shape(`"sponsor.change_address" không còn nhận: phần thối về lại ĐÚNG địa chỉ của các UTxO trong ` +
          `"sponsor.utxo_refs" (địa chỉ bên tài trợ đã ghim ở cấu hình dịch vụ). Bỏ trường này.`,
          { field: "sponsor.change_address" });
      }
      return {
        ...base,
        ...withVaultRef,
        // TUỲ CHỌN: vắng ⟹ dịch vụ tìm quỹ tài trợ của DID. Có mặt thì phải đúng hình dạng (và thuộc DID đó).
        ...(body.fund_id === undefined ? {} : { fundId: fundIdOf(body) }),
        carpAmount: reqBigint(body, "carp_amount"),
        sponsorUtxoRefs: refs,
      } satisfies SponsorFundVaultRequest;
    }
    case "draw-magic":
      return {
        ...base,
        ...withVaultRef,
        fundId: fundIdOf(body),
        carpAmount: reqBigint(body, "carp_amount"),
      } satisfies SponsorDrawMagicRequest;
    case "first-consume": {
      const de = body.draw_epoch;
      if (typeof de !== "number" || !Number.isSafeInteger(de) || de < 0) {
        throw shape(`"draw_epoch" phải là số nguyên ≥ 0 — đúng \`summary.epoch\` mà draw-magic trả.`, { field: "draw_epoch" });
      }
      const engageRef = parseEngageRef(body.engage_ref);
      return {
        ...base,
        ...withVaultRef,
        ...(engageRef === undefined ? {} : { engageRef }),
        opType: reqSmallInt(body, "op_type"),
        opCount: reqBigint(body, "op_count"),
        drawEpoch: BigInt(de),
      } satisfies SponsorFirstConsumeRequest;
    }
  }
}

function parseClaimRequest(body: Record<string, unknown>): SponsorClaimRequest {
  // Mọi trường định CARP đi đâu, quỹ thuộc ai, ai là chủ bị từ chối, không lặng lẽ bỏ qua.
  for (const f of ["owner", "owner_pkh", "owner_did", "owner_witness", "beneficiary", "beneficiary_datum", "platform",
    "platform_pkh", "sponsor", "destination", "to", "did_commit", "vault_ref"]) {
    if (body[f] !== undefined) {
      throw shape(`"${f}" không nhận ở claim: CARP chỉ đi tới beneficiary đã ghim trong datum quỹ và cấu hình dịch vụ; ` +
        `claim không có chủ két. Bỏ trường này.`, { field: f });
    }
  }
  const changeAddress = body.change_address;
  if (changeAddress !== undefined && (typeof changeAddress !== "string" || changeAddress === "")) {
    throw shape(`"change_address" phải là chuỗi địa chỉ bech32 khác rỗng.`, { field: "change_address" });
  }
  const amount = body.amount === undefined ? undefined : reqBigint(body, "amount");
  if (amount !== undefined && amount <= 0n) throw shape(`"amount" phải > 0 (CARP, đơn vị nhỏ nhất).`, { field: "amount" });
  const feePayer = parseFeePayer(body);
  return {
    fundId: fundIdOf(body),
    ...(amount === undefined ? {} : { amount }),
    ...(changeAddress === undefined ? {} : { changeAddress: changeAddress as string }),
    ...(feePayer === undefined ? {} : { feePayer }),
  };
}

// ── Đáp ứng ───────────────────────────────────────────────────────────────────

export interface SponsorSigner {
  role: "fee-wallet" | "sponsor" | "platform" | "owner";
  /** Khoá băm phải ký theo vai này. Chủ script: controller + thiết bị của `did_stake`. */
  keyHashes: string[];
  how: string;
}

export interface SponsorBuildResponse {
  step: SponsorStep;
  txCbor: string;
  txHash: string;
  /** `required_signers` đọc từ CHÍNH CBOR vừa dựng. */
  requiredSigners: string[];
  /** Ai ký, theo vai và theo thứ tự `planSponsorJourney`. */
  signers: SponsorSigner[];
  witnessNotes: string[];
  summary: Record<string, unknown>;
  /** `validTo` của CHÍNH thân tx, ISO 8601 UTC (`validity.ts` ▸ `readTxExpiry`). */
  expiresAt: string;
  expiresReason: ExpiresReason;
}

export function toSponsorBody(r: SponsorBuildResponse): Record<string, unknown> {
  return {
    step: r.step,
    tx_cbor: r.txCbor,
    tx_hash: r.txHash,
    required_signers: r.requiredSigners,
    signers: r.signers.map(s => ({ role: s.role, key_hashes: s.keyHashes, how: s.how })),
    witness_notes: [...r.witnessNotes, expiryNote({ expiresAt: r.expiresAt, reason: r.expiresReason })],
    summary: r.summary,
    expires_at: r.expiresAt,
    expires_reason: r.expiresReason,
  };
}

function assetsJson(a: Assets): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, q] of Object.entries(a)) out[k] = q.toString();
  return out;
}

function outputsJson(outs: SponsorTxOutput[]): Array<Record<string, unknown>> {
  return outs.map(o => ({ index: o.index, address: o.address, assets: assetsJson(o.assets) }));
}

// ── Kế hoạch (thuần) ──────────────────────────────────────────────────────────

/** `POST /tx/sponsor/plan` — ai ký tx nào, đường của từng bước. Không chạm chuỗi, không cấu hình. */
export function sponsorPlanBody(
  body: Record<string, unknown>,
  /** Chủ đã suy (chủ `{type:"did"}` — `sponsorRoute` suy qua dịch vụ trước khi gọi). */
  resolved?: { owner: OwnerRef; ownerDid?: string },
): Record<string, unknown> {
  const parsed = ownerReq(body).owner;
  if (isDidOwner(parsed) && resolved === undefined) {
    throw new Error("[bất biến nội bộ] sponsorPlanBody nhận chủ DID chưa suy.");
  }
  const owner: OwnerRef = resolved?.owner ?? (parsed as OwnerRef);
  const sponsorPkh = body.sponsor_pkh;
  if (typeof sponsorPkh !== "string" || !HEX28.test(sponsorPkh)) {
    throw shape(`"sponsor_pkh" phải là 56 ký tự hex thường (khoá băm của bên tài trợ ký fund-vault).`, { field: "sponsor_pkh" });
  }
  const plan = planSponsorJourney({ owner, sponsorPkh });
  const pathOf = Object.fromEntries(Object.entries(SPONSOR_STEP_OF_PATH).map(([p, s]) => [s, p]));
  return {
    // bind-did là bước của DỊCH VỤ, không của bộ lập kế hoạch SDK (SDK chưa có SetDidCommit trong hành
    // trình): chèn ngay sau open-vault, và fund-vault đòi thêm nó — quỹ tài trợ chỉ nạp vào két đã mang
    // đúng DID (`PrepaidGen/onchain/validators/prepaid.ak` ▸ `validate_lock`, khối `sponsorship`).
    steps: plan.steps.flatMap(s => {
      const step = stepOfSdk(s.step);
      const row = {
        step, path: pathOf[step], action: s.action,
        signers: s.signers.map(x => ({ role: x.role, how: x.how })),
        requires: [
          ...s.requires.map(renameSdkSteps),
          ...(step === "fund-vault"
            ? ["bind-did đã vào khối (két mang did_commit của thread)",
               "quỹ tài trợ của DID đã có (open-vault tạo; két mở trước bản này: open-fund)"]
            : []),
        ],
      };
      if (step === "first-consume") {
        // claim: bước sau first-consume, chạy được khi quỹ có E > 0 (phần CARP bên hưởng rút được).
        return [row, {
          step: "claim" as const, path: pathOf["claim"],
          action: "FundClaim: CARP từ quỹ tài trợ tới beneficiary ĐÃ GHIM (datum quỹ + cấu hình); dịch vụ ký vai platform",
          signers: [
            { role: "fee-wallet", how: "ví trả phí: phí + thế chấp + min-ADA output tới bên hưởng" },
            { role: "platform", how: "service" },
          ],
          requires: [
            "first-consume đã vào khối",
            "SettleLine đã đưa MAGIC đã tiêu của két vào magic_settled của quỹ",
            "khi quỹ có E > 0 (E = phần claim được, PrepaidGen ▸ maxClaimable)",
          ],
        }];
      }
      if (step !== "open-vault") return [row];
      const owner = row.signers.find(x => x.role === "owner");
      // open-vault chở thêm genesis quỹ tài trợ của DID; dịch vụ đồng ký vai platform.
      const openRow = {
        ...row,
        action: `${row.action} + genesis quỹ tài trợ CỦA DID (paid_fund, sponsorship = Some { sponsor, owner_commit, ` +
          `reclaim_after_epoch }, 0 CARP) — bỏ qua khi DID đã có quỹ dùng được`,
        signers: [...row.signers, { role: "platform", how: "service" }],
      };
      return [openRow, {
        step: "bind-did" as const, path: pathOf["bind-did"],
        action: "SetDidCommit: gắn did_commit của thread vào két Prepaid — MỘT LẦN, không đổi được về sau",
        signers: [
          { role: "fee-wallet", how: "ví trả phí: phí + thế chấp" },
          ...(owner === undefined ? [] : [owner]),
        ],
        requires: ["open-vault đã vào khối"],
      }];
    }),
    // Bước BÙ, ngoài hành trình chính: chỉ cho DID có két mở TRƯỚC khi open-vault chở genesis quỹ.
    fallback_steps: [{
      step: "open-fund" as const, path: pathOf["open-fund"],
      when: "chỉ khi két của DID mở trước bản open-vault chở quỹ, và DID chưa có quỹ tài trợ dùng được",
      action: "Genesis quỹ tài trợ CỦA DID (paid_fund, sponsorship = Some { sponsor, owner_commit, reclaim_after_epoch }); " +
        "0 CARP — CARP vào ở fund-vault",
      signers: [
        { role: "fee-wallet", how: "ví trả phí: phí + thế chấp + min-ADA của quỹ" },
        { role: "platform", how: "service" },
      ],
      requires: ["open-vault đã vào khối (thread mang did_commit)"],
    }],
    same_epoch: plan.sameEpoch.map(stepOfSdk),
    ...(resolved?.ownerDid === undefined ? {} : { owner_did: resolved.ownerDid }),
  };
}

// ── Dịch vụ ───────────────────────────────────────────────────────────────────

/** Lucid với ví CHỈ-ĐỌC mang đúng các UTxO đã cho. Dịch vụ thật: `SdkTxBuilder.lucidForWallet`. */
export type LucidForWallet = (walletAddress: string, walletUtxos: UTxO[]) => Promise<LucidEvolution>;

export interface SponsorTxServiceDeps {
  network: Network;
  deployment: Deployment;
  /** Đọc két, quỹ, anchor, thread, beacon, UTxO bên tài trợ (bản gốc — để trả 409 PREVIOUS_TX_PENDING có tên). */
  chain: ChainReader;
  /** Đọc UTxO ví trả phí — bản lọc input vừa nộp. Vắng ⟹ `chain`. */
  walletChain?: ChainReader;
  locks: OwnerLockTable;
  issued: IssuedTxRegistry;
  pending?: PendingSpends;
  lockTtlMs: number;
  /** Hạn ký của tx (ms từ đỉnh chuỗi), `AppConfig.txValidityMs`. Vắng ⟹ `DEFAULT_TX_VALIDITY_MS`. */
  txValidityMs?: number;
  now?: () => number;
  /** Nhân chứng chủ script (`did_stake`). Vắng ⟹ chủ script nhận 501 `OWNER_SCRIPT_WITNESS_UNAVAILABLE`. */
  ownerWitness?: OwnerWitnessProvider;
  /** Suy chủ `{type:"did"}` từ anchor. Vắng ⟹ chủ DID nhận 501 `OWNER_SCRIPT_WITNESS_UNAVAILABLE`. */
  didOwner?: DidOwnerResolverPort;
  /** Blueprint PrepaidGen (`aiken build PrepaidGen/onchain`) — ở khối Prepaid đó là tệp
   *  `VAULT_TX_API_VAULT_PLUTUS_JSON`. Dịch vụ apply tham số rồi đối chiếu hash với cấu hình. */
  prepaidBlueprint: PrepaidBlueprint;
  lucidForWallet: LucidForWallet;
  /**
   * CHỈ cho bài kiểm: nhận chủ KHOÁ ở open-vault/fund-vault. Mặc định `false` ⟹ chủ khoá nhận 422
   * `SPONSOR_OWNER_NOT_DID`. Cố ý là tham số HÀM DỰNG, không phải khoá cấu hình hay biến môi trường:
   * `server.ts` không truyền nó, nên không người vận hành nào bật được nó trên dịch vụ thật — một khoá
   * cấu hình "chỉ bài kiểm bật" vẫn là một khoá mà tệp deploy chép nhầm bật được. Bài Emulator cần nó
   * vì nhánh chủ script đòi nhân chứng PhoenixKey thật (`did_stake` + anchor Active), thứ Emulator không có.
   */
  allowKeyOwner?: boolean;
  /**
   * Lưới slot ↔ POSIX ms của chuỗi mà bộ dựng ghi `ttl` (Lucid đổi `validTo` ms sang slot theo lưới
   * của CHÍNH nó). Vắng ⟹ `network`. Chỉ bài Emulator khác: Lucid "Custom" lấy gốc giờ = lúc dựng
   * Emulator, nên đọc `ttl` đó bằng lưới Preprod ra một mốc năm 2022. `server.ts` không truyền.
   * `network` vẫn là lưới EPOCH (kẹp cuối epoch, `windowOriginMs`) và lưới địa chỉ.
   */
  slotNetwork?: SlotNetwork;
  /**
   * Hàm ký vai platform của genesis quỹ tài trợ (`platformSigner.ts` ▸ `createPlatformSigner`, `server.ts` dựng
   * lúc khởi động). Chỉ open-vault (khi chở genesis quỹ) và open-fund gọi nó, trên tx chính dịch vụ VỪA dựng.
   * Vắng ⟹ hai route đó trả 501 `CONFIG_MISSING` khi cần tạo quỹ (`details.missing` nêu tên biến môi trường).
   */
  platformSign?: (r: {
    kind: "fund-genesis" | "fund-claim";
    tx: CML.Transaction;
    inputs: Array<{ ref: string; address: string; datumCbor?: string; assets?: Record<string, bigint> }>;
  }) => CML.Vkeywitness;
  /** Giữ `did:<did_commit>` của genesis quỹ tới hết hạn tx (`locks.ts` ▸ `DidGenesisHolds`). Vắng ⟹ bảng riêng của dịch vụ. */
  didHolds?: DidGenesisHolds;
}

interface Prepared {
  scope: VaultScope;
  scripts: PrepaidScripts;
  consumeScript: Validator;
  consumeRef: UTxO;
  P: bigint;
  O: bigint;
}

interface StepCtx {
  owner: OwnerRef;
  ownerAuth: OwnerAuth<TxBuilder>;
  witness?: ResolvedOwnerWitness;
  feeAddress: string;
  feeKeyHash: string;
  tip: ChainTip;
  /** Cận trên `validTo` của bước này — mọi bộ dựng nhận nó (`sponsorValidityArgs`). */
  plan: ValidityPlan;
  /** Có ⟹ ví trả phí bên thứ ba: ví của Lucid mang ĐÚNG `utxo`, thế chấp tường minh. */
  feePayer?: { req: FeePayerRequest; utxo: UTxO; collateralLovelace: bigint };
  /**
   * Giữ thêm một khoá mềm SAU khi lượt dựng đã bắt đầu — cho khoá chỉ biết được sau một lượt đọc chuỗi
   * (fund-vault: `fund:<unit>` của quỹ tìm theo DID). Khoá đó nhả cùng mọi khoá khác của lượt dựng.
   */
  claimLock: (key: string) => void;
  /**
   * Giữ `did:<did_commit>` cho genesis quỹ tới hết hạn của tx (`DidGenesisHolds`). Đang có tx genesis khác cho DID
   * đó còn hạn ⟹ 409 `SPONSOR_DID_GENESIS_IN_FLIGHT`.
   */
  holdDid: (didCommit: string) => void;
}

/** Địa chỉ mà một bước được chạm, cho phép đọc lại CBOR của đường `fee_payer`. */
interface FeeFlow {
  /** Script của luồng (két, thread, quỹ): input được tiêu; output nhận được khoản min-ADA ví trả phí ứng. */
  scriptAddresses: string[];
  /** Bên tài trợ (fund-vault): input được tiêu, output nhận lại — nhưng KHÔNG được nhận thêm ADA nào. */
  passAddresses: string[];
}

/** Ví của Lucid: đường `fee_payer` ⟹ đúng UTxO trả phí; đường `change_address` ⟹ mọi UTxO ở đó. */
function feeWallet(ctx: StepCtx, all: () => Promise<UTxO[]>): Promise<UTxO[]> {
  return ctx.feePayer === undefined ? all() : Promise.resolve([ctx.feePayer.utxo]);
}

/** Lượng thế chấp tường minh — chỉ khi có `fee_payer`. */
function collateralOf(ctx: StepCtx): { collateralLovelace: bigint } | Record<string, never> {
  return ctx.feePayer === undefined ? {} : { collateralLovelace: ctx.feePayer.collateralLovelace };
}

export class SponsorTxService {
  private readonly now: () => number;
  private derived: PrepaidScripts | undefined;
  private readonly didHolds: DidGenesisHolds;

  constructor(private readonly deps: SponsorTxServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.didHolds = deps.didHolds ?? new DidGenesisHolds();
  }

  /** Giờ máy chủ (POSIX ms) mà tầng HTTP đóng dấu thành `server_time` (`http.ts` ▸ `withServerTime`).
   *  Cùng đồng hồ đã lập cận `validTo` (`planSponsorValidity`). */
  serverNowMs(): number {
    return this.now();
  }

  /** Chủ `{type:"did"}` ⟹ `Script(did_stake)` + nhân chứng (`didOwner.ts`); chủ khác trả nguyên. */
  resolveOwner<R extends OwnerRequest>(req: R): Promise<WithResolvedOwner<R>> {
    return resolveOwnerInput(req, this.deps.didOwner);
  }

  /**
   * open-vault — đúc két Prepaid + thread consume, CỘNG genesis quỹ tài trợ của DID (`planMintPaidFund`, cùng
   * seed), trong MỘT tx. Dịch vụ gắn sẵn vkey witness platform (`cosignPlatform`); ví trả phí + chủ ký thêm.
   * DID đã có quỹ dùng được ⟹ không genesis quỹ thứ hai: tx như cũ, `summary.fund.status = "existing"`.
   */
  async openVault(req: SponsorOpenVaultRequest): Promise<SponsorBuildResponse> {
    const prepaid = this.requirePrepaid("open-vault");
    return this.run("open-vault", req, [], async (p, ctx) => {
      // TRƯỚC mọi lượt đọc két: `did_commit` của thread mới phải là DID của chính chủ ký.
      assertOwnerDid("open-vault", ctx.owner, ctx.witness, req.didCommit, this.deps.deployment.didStake);
      const scope = p.scope;
      // Lưới an toàn của DỊCH VỤ (bấm hai lần, app gửi lại) — KHÔNG phải chính sách một-lần-mỗi-DID:
      // việc đó Feecover đếm. Két thứ hai cùng chủ làm mọi bước sau rơi vào 409 `VAULT_AMBIGUOUS`.
      const existing = this.prepaidVaultsOf(await this.deps.chain.utxosAt(scope.address), p.scripts, ctx.owner);
      if (existing.length > 0) {
        throw new CodedApiError(409, "VAULT_ALREADY_EXISTS",
          `Chủ ${ctx.owner.type}:${ctx.owner.hash.slice(0, 12)}… đã có két Prepaid — không dựng két thứ hai. ` +
          `Đi tiếp từ fund-vault với két đang có.`,
          { vault_type: PREPAID_VAULT_TYPE, existing: existing.map(v => ({ vault_ref: refStr(v.utxo), vault_nft: v.nftUnit })) });
      }
      // Mỗi DID một quỹ: DID đã có quỹ dùng được ⟹ không genesis. Không có ghim ⟹ `fundGenesisPins` ném 501.
      // Quỹ đã thu hồi vẫn là quỹ của DID (`fundsBlockingOpen`): không genesis quỹ thứ hai cho DID đã được tài trợ.
      const mine = prepaid.sponsor === undefined ? [] : fundsBlockingOpen(
        await this.readSponsorFunds(prepaid, prepaid.sponsor, epochAt(ctx.tip.blockTimePosixMs, p)), req.didCommit);
      const genesis = mine.length === 0 ? this.fundGenesisPins("open-vault") : undefined;
      // Hai open-vault chở genesis cho cùng DID trong khe nộp → vào khối ⟹ hai quỹ. Giữ DID tới hết hạn tx.
      if (genesis !== undefined) ctx.holdDid(req.didCommit);
      const wallet = await feeWallet(ctx, () => this.walletUtxos(ctx.feeAddress));
      const sorted = [...wallet].sort((a, b) =>
        a.txHash === b.txHash ? a.outputIndex - b.outputIndex : a.txHash < b.txHash ? -1 : 1);
      const seedUtxo = sorted.find(u => Object.keys(u.assets).every(k => k === "lovelace")) ?? sorted[0]!;
      const lucid = await this.deps.lucidForWallet(ctx.feeAddress, wallet);
      // Genesis quỹ dùng CHUNG seed với két + thread (bộ dựng két tiêu nó; `collectSeed: false` ở đây).
      const fund = genesis === undefined ? undefined : planMintPaidFund({
        scripts: p.scripts, seedUtxo, platformPkh: genesis.platform,
        beneficiary: plutusAddressOf(genesis.beneficiary.address),
        beneficiaryDatum: genesis.beneficiary.datumCbor === undefined ? null : plutusDataFromCbor(genesis.beneficiary.datumCbor),
        bufferBps: genesis.pins.bufferBps ?? MIN_BUFFER_BPS, collectSeed: false,
        sponsorship: { sponsor: plutusAddressOf(genesis.pins.addresses[0]!), owner_commit: req.didCommit },
        validity: { fromMs: ctx.tip.blockTimePosixMs, toMs: ctx.plan.capMs },
      });
      const r = await buildSponsorT1OpenPrepaid({
        lucid, prepaidScripts: p.scripts, consumeScript: p.consumeScript, consumeRefUtxo: p.consumeRef,
        seedUtxo, owner: ctx.owner, ownerAuth: ctx.ownerAuth, didCommit: req.didCommit, network: this.deps.network,
        ...(req.threadLovelace === undefined ? {} : { threadLovelace: req.threadLovelace }),
        // open-vault không có cửa sổ kỳ; mọi đường (cả `change_address`) đều có `validTo` = cận đã chọn.
        ...sponsorValidityArgs("open-vault", ctx.plan),
        ...collateralOf(ctx),
        ...(fund === undefined ? {} : { extend: (tx: TxBuilder) => applyPlan(tx, fund.plan, { mode: "deferred" }) }),
      });
      const s = r.summary;
      const vaultOut = this.nftOutput(s.outputs, s.vaultUnit, scope.address, "két Prepaid", "open-vault");
      const threadOut = this.nftOutput(s.outputs, s.threadUnit, this.deps.deployment.consume.engageAddress, "thread", "open-vault");
      if (!s.vaultUnit.startsWith(scope.scriptHash) || !s.threadUnit.startsWith(this.deps.deployment.consume.engageScriptHash)) {
        throw txMismatch("open-vault", `NFT két/thread không nằm dưới policy đã cấu hình.`, { vault_unit: s.vaultUnit, thread_unit: s.threadUnit });
      }
      const txHash = txBodyHash(r.txCbor);
      let txCbor = r.txCbor;
      let fundSummary: Record<string, unknown>;
      if (fund !== undefined) {
        const fundOut = this.nftOutput(s.outputs, fund.nftUnit, prepaid.fundAddress, "quỹ tài trợ", "open-vault");
        // Ký vai platform trên ĐỐI TƯỢNG tx vừa dựng (không qua CBOR của thân bài).
        txCbor = await this.cosignPlatform(r.tx.toTransaction(), "fund-genesis", wallet);
        const sponsorship = fund.datum.sponsorship!;
        fundSummary = {
          status: "created",
          fund_id: fund.fundId, fund_unit: fund.nftUnit, fund_address: prepaid.fundAddress, fund_out_ref: `${txHash}#${fundOut}`,
          owner_commit: req.didCommit, platform_pkh: genesis!.platform, sponsor_address: genesis!.pins.addresses[0],
          beneficiary: genesis!.beneficiary.address, buffer_bps: fund.datum.buffer_bps.toString(),
          reclaim_after_epoch: sponsorship.reclaim_after_epoch.toString(), seed_ref: refStr(seedUtxo),
        };
      } else {
        fundSummary = {
          status: "existing",
          funds: mine.map(e => ({ fund_id: e.fundId, fund_unit: e.unit, fund_ref: e.utxo === undefined ? null : refStr(e.utxo) })),
        };
      }
      return {
        txCbor,
        ...(fund === undefined ? {} : { platformSigners: [genesis!.platform] }),
        feeFlow: {
          scriptAddresses: [scope.address, this.deps.deployment.consume.engageAddress, ...(fund === undefined ? [] : [prepaid.fundAddress])],
          passAddresses: [],
        },
        summary: {
          step: "open-vault",
          vault_unit: s.vaultUnit, vault_address: s.vaultAddress, vault_out_ref: `${txHash}#${vaultOut}`,
          thread_unit: s.threadUnit, thread_address: s.threadAddress, thread_out_ref: `${txHash}#${threadOut}`,
          did_commit: s.didCommit, owner: { type: s.owner.type, hash: s.owner.hash },
          fund: fundSummary,
          withdrawals: s.withdrawals, outputs: outputsJson(s.outputs),
        },
      };
    });
  }

  /**
   * Ghim cấu hình + khoá cần cho genesis quỹ tài trợ của DID (open-vault khi DID chưa có quỹ, open-fund).
   * Thiếu ⟹ 501 `CONFIG_MISSING` nêu ĐỦ thứ thiếu; tập quỹ đóng (`fund_units`) ⟹ 501 `SPONSOR_FUND_SET_CLOSED`.
   */
  private fundGenesisPins(step: "open-vault" | "open-fund"): {
    platform: string; beneficiary: NonNullable<SponsorPins["beneficiary"]>; pins: SponsorPins;
  } {
    const route = `/tx/sponsor/${step}`;
    const pins = this.deps.deployment.prepaid?.sponsor;
    const platform = pins?.platformPkhs?.[0];
    const missing = [
      ...(pins === undefined ? ["paid_fund.sponsor"] : []),
      ...(pins !== undefined && platform === undefined ? ["paid_fund.sponsor.platform_pkhs"] : []),
      ...(pins !== undefined && pins.beneficiary === undefined ? ["paid_fund.sponsor.beneficiary"] : []),
      ...(this.deps.platformSign === undefined ? [PLATFORM_KEY_ENV] : []),
    ];
    if (missing.length > 0) {
      throw new ConfigMissingError(
        `${step} dựng genesis quỹ tài trợ của DID: cần khoá platform đã ghim (platform_pkhs) và đích nhận CARP ` +
        `(beneficiary) ở cấu hình "paid_fund.sponsor", cùng khoá platform của dịch vụ (biến môi trường ` +
        `${PLATFORM_KEY_ENV}). Không có chế độ không-khoá.`, { missing, route });
    }
    if (pins!.fundUnits !== undefined) {
      // Tập quỹ ghim là tập ĐÓNG: quỹ vừa tạo không nằm trong đó ⟹ fund-vault không bao giờ thấy nó.
      throw new CodedApiError(501, "SPONSOR_FUND_SET_CLOSED",
        `Cấu hình ghim "paid_fund.sponsor.fund_units" (tập quỹ đóng), nên quỹ ${step} tạo sẽ không nằm trong tập ` +
        `fund-vault đọc. Bỏ "fund_units", giữ "platform_pkhs" (dịch vụ quét địa chỉ quỹ theo khoá platform).`,
        { route, conflict: ["paid_fund.sponsor.fund_units"] });
    }
    return { platform: platform!, beneficiary: pins!.beneficiary!, pins: pins! };
  }

  /**
   * Gắn vkey witness platform vào tx dịch vụ VỪA dựng (đối tượng CML, không phải CBOR của thân bài). Hàm ký
   * (`platformSigner.ts`) tự kiểm tx có đúng một mint +1 NFT quỹ và `required_signers` ∋ platform, không thì ném.
   * Thân tx không đổi: các bên ký sau vẫn ký đúng `tx_hash` trả về.
   */
  private async cosignPlatform(tx: CML.Transaction, kind: "fund-genesis" | "fund-claim", known: readonly UTxO[]): Promise<string> {
    const sign = this.deps.platformSign;
    if (sign === undefined) {
      throw new Error("[bất biến nội bộ] cosignPlatform gọi khi không có hàm ký platform — fundGenesisPins phải chặn.");
    }
    const bodyHash = CML.hash_transaction(tx.body()).to_hex();
    // Hàm ký đòi MỌI input + thế chấp đã giải (`platformSigner.ts` vế (a)): UTxO bộ dựng đã có, phần còn lại đọc chuỗi.
    // Thiếu một ⟹ hàm ký từ chối (không ký mù).
    const b = tx.body();
    const refs: Array<{ txHash: string; outputIndex: number }> = [];
    const ins = b.inputs();
    const col = b.collateral_inputs();
    for (let i = 0; i < ins.len(); i++) refs.push({ txHash: ins.get(i).transaction_id().to_hex(), outputIndex: Number(ins.get(i).index()) });
    for (let i = 0; col !== undefined && i < col.len(); i++) {
      refs.push({ txHash: col.get(i).transaction_id().to_hex(), outputIndex: Number(col.get(i).index()) });
    }
    const byRef = new Map(known.map(u => [refStr(u), u] as const));
    const missing = refs.filter(r => !byRef.has(refStr(r)));
    if (missing.length > 0) for (const u of await this.deps.chain.utxosByOutRef(missing)) byRef.set(refStr(u), u);
    const inputs = [...new Set(refs.map(refStr))].flatMap(r => {
      const u = byRef.get(r);
      return u === undefined ? [] : [{
        ref: r, address: u.address, assets: u.assets, ...(typeof u.datum === "string" ? { datumCbor: u.datum } : {}),
      }];
    });
    const witness = sign({ kind, tx, inputs });
    const wsb = CML.TransactionWitnessSetBuilder.new();
    wsb.add_existing(tx.witness_set());
    wsb.add_vkey(witness);
    const aux = tx.auxiliary_data();
    const cbor = CML.Transaction.new(tx.body(), wsb.build(), tx.is_valid(), aux).to_cbor_hex();
    if (txBodyHash(cbor) !== bodyHash) {
      throw new Error("[bất biến nội bộ] gắn chữ ký platform làm đổi thân tx.");
    }
    return cbor;
  }

  /**
   * bind-did — SetDidCommit: gắn `did_commit` của THREAD consume vào két Prepaid, một lần
   * (`PrepaidGen/onchain/validators/prepaid.ak` ▸ `validate_set_did_commit`; bộ dựng
   * `@magiclamp/prepaidgen-sdk` ▸ `addSetDidCommit`). Đứng giữa open-vault và fund-vault: két Prepaid đúc
   * với `did_commit` rỗng, còn `PrepaidLock` trên quỹ tài trợ đòi két mang đúng `owner_commit`.
   *
   * DID lấy từ thread, KHÔNG từ thân bài: on-chain nhánh này không chứng minh DID thuộc về người ký (chép
   * được cam kết của người khác), nên dịch vụ chỉ gắn đúng DID mà nhân chứng `did_stake` của chủ đã khớp
   * (`assertOwnerDid`) — cùng cổng với open-vault/fund-vault.
   */
  async bindDid(req: SponsorBindDidRequest): Promise<SponsorBuildResponse> {
    return this.run("bind-did", req, [], async (p, ctx) => {
      const vault = await this.pickVault(p, ctx.owner, req.vaultRef);
      const d = this.deps.deployment.consume;
      const thread = await pickEngageThread(this.deps.chain, d.engageAddress, d.engageScriptHash, ctx.owner,
        undefined, "/tx/sponsor/bind-did");
      const didCommit = didCommitOf(thread);
      if (!/^[0-9a-f]{64}$/.test(didCommit)) {
        throw new CodedApiError(422, "SPONSOR_THREAD_DID_INVALID",
          `Thread ${refStr(thread.utxo)} mang did_commit dài ${didCommit.length / 2} byte; bind-did cần đúng 32 byte. ` +
          `Thread này không mở bằng open-vault.`, { engage_ref: refStr(thread.utxo) });
      }
      assertOwnerDid("bind-did", ctx.owner, ctx.witness, didCommit, this.deps.deployment.didStake);
      if (vault.datum.did_commit !== "") {
        // Nhánh on-chain tự khoá sau lần chạy đầu: két đã gắn thì không có tx nào để dựng.
        const same = vault.datum.did_commit === didCommit;
        throw new CodedApiError(same ? 409 : 422, same ? "SPONSOR_VAULT_DID_ALREADY_SET" : "SPONSOR_VAULT_DID_MISMATCH",
          same
            ? `Két ${refStr(vault.utxo)} đã gắn đúng DID ${didCommit.slice(0, 16)}… — bỏ qua bind-did, đi tiếp fund-vault.`
            : `Két ${refStr(vault.utxo)} đã gắn DID KHÁC DID của thread (${didCommit.slice(0, 16)}…); did_commit của két ` +
              `không đổi được, két này không đi tiếp hành trình tài trợ.`,
          { vault_ref: refStr(vault.utxo), vault_did_commit: vault.datum.did_commit, did_commit: didCommit });
      }
      const wallet = await feeWallet(ctx, () => this.walletUtxos(ctx.feeAddress));
      const lucid = await this.deps.lucidForWallet(ctx.feeAddress, wallet);
      // SetDidCommit ghi `last_updated_epoch = epoch hiện hành` ⟹ hai cận phải cùng một kỳ (như draw-magic).
      let validity: TxValidity;
      try {
        validity = validityInEpoch(ctx.tip.blockTimePosixMs, p.P, p.O, ctx.plan.maxAheadMs);
      } catch (e) {
        throw new SponsorJourneyError("SPONSOR_VALIDITY_SPANS_EPOCHS", e instanceof Error ? e.message : String(e));
      }
      const r = addSetDidCommit(lucid.newTx(), {
        scripts: p.scripts, vaultUtxo: vault.utxo, didCommit, validity, ownerProof: { mode: "deferred" },
      });
      const planOwner = r.plan.owner as OwnerRef;
      const c = await applyOwnerAuth(r.tx, resolveOwnerAuth(planOwner, ctx.ownerAuth))
        .completeSafe(collateralCompleteOptions(ctx.feePayer?.collateralLovelace));
      if (c._tag === "Left") {
        const err = c.left as { message?: unknown };
        throw new SponsorJourneyError("SPONSOR_BUILD_FAILED", `bind-did: Lucid không dựng được tx — ${String(err?.message ?? c.left)}`);
      }
      const txCbor = c.right.toCBOR();
      // Chủ script ⟹ ĐÚNG một mục rút did_stake; chủ khoá ⟹ không mục nào (cùng luật với các bước SDK).
      const withdrawals = sponsorTxWithdrawalCountOf(txCbor);
      const wantW = planOwner.type === "script" ? 1 : 0;
      if (withdrawals !== wantW) {
        throw new SponsorJourneyError("SPONSOR_WITHDRAW_COUNT",
          `bind-did: tx có ${withdrawals} mục rút, chủ ${planOwner.type} đòi ĐÚNG ${wantW}.`);
      }
      const outs = sponsorTxOutputsOf(txCbor);
      const txHash = txBodyHash(txCbor);
      const vaultOut = this.nftOutput(outs, vault.nftUnit, p.scope.address, "két Prepaid", "bind-did");
      return {
        txCbor,
        feeFlow: { scriptAddresses: [p.scope.address], passAddresses: [] },
        summary: {
          step: "bind-did", epoch: Number(r.epoch), epoch_end_ms: windowStartMs(r.epoch + 1n, p.P, p.O).toString(),
          vault_out_ref: `${txHash}#${vaultOut}`, did_commit: didCommit, engage_ref: refStr(thread.utxo),
          withdrawals, outputs: outputsJson(outs),
        },
      };
    });
  }

  /**
   * open-fund — genesis quỹ tài trợ CỦA DID (`paid_fund`, nhánh mint `validate_mint_fund_nft`; bộ dựng
   * `@magiclamp/prepaidgen-sdk` ▸ `planMintPaidFund`). Datum: `platform` = `platform_pkhs[0]`, `sponsorship = Some {
   * sponsor = addresses[0], owner_commit = did_commit của thread, reclaim_after_epoch = epoch(validTo) + 200 }`,
   * `beneficiary` + `buffer_bps` từ cấu hình, mọi số kế toán = 0. Seed one-shot = một UTxO của ví trả phí.
   *
   * DID có quỹ dùng được rồi ⟹ 409 `SPONSOR_FUND_ALREADY_OPEN` (mỗi DID một quỹ — `sponsorFund.ts`).
   */
  async openFund(req: SponsorOpenFundRequest): Promise<SponsorBuildResponse> {
    const prepaid = this.requirePrepaid("open-fund");
    // Ghim của cấu hình + khoá platform TRƯỚC khi giữ khoá. Ba thứ quyết quỹ thuộc ai và CARP đi đâu, đều không
    // lấy từ thân bài.
    const { platform, pins: sp } = this.fundGenesisPins("open-fund");
    return this.run("open-fund", req, [], async (p, ctx) => {
      const d = this.deps.deployment.consume;
      const thread = await pickEngageThread(this.deps.chain, d.engageAddress, d.engageScriptHash, ctx.owner,
        undefined, "/tx/sponsor/open-fund");
      const didCommit = didCommitOf(thread);
      if (!/^[0-9a-f]{64}$/.test(didCommit)) {
        throw new CodedApiError(422, "SPONSOR_THREAD_DID_INVALID",
          `Thread ${refStr(thread.utxo)} mang did_commit dài ${didCommit.length / 2} byte; open-fund cần đúng 32 byte ` +
          `(owner_commit của quỹ). Thread này không mở bằng open-vault.`, { engage_ref: refStr(thread.utxo) });
      }
      assertOwnerDid("open-fund", ctx.owner, ctx.witness, didCommit, this.deps.deployment.didStake);
      const mine = fundsBlockingOpen(
        await this.readSponsorFunds(prepaid, sp, epochAt(ctx.tip.blockTimePosixMs, p)), didCommit);
      if (mine.length > 0) {
        throw new CodedApiError(409, "SPONSOR_FUND_ALREADY_OPEN",
          `DID ${didCommit.slice(0, 16)}… đã có quỹ tài trợ (mỗi DID một quỹ, kể cả quỹ đã thu hồi) — bỏ qua open-fund.`,
          { did_commit: didCommit, fund_ids: mine.map(e => e.fundId), fund_refs: mine.map(e => refStr(e.utxo!)),
            reclaimed: mine.filter(e => e.problem === "reclaimed").map(e => e.fundId) });
      }
      const wallet = await feeWallet(ctx, () => this.walletUtxos(ctx.feeAddress));
      const sorted = [...wallet].sort((a, b) =>
        a.txHash === b.txHash ? a.outputIndex - b.outputIndex : a.txHash < b.txHash ? -1 : 1);
      const seedUtxo = sorted.find(u => Object.keys(u.assets).every(k => k === "lovelace")) ?? sorted[0];
      if (seedUtxo === undefined) throw noWalletUtxo(ctx.feeAddress, "");
      ctx.holdDid(didCommit);
      const lucid = await this.deps.lucidForWallet(ctx.feeAddress, wallet);
      // Cận TRÊN = cận đã chọn (`planSponsorValidity`, không kẹp kỳ); mốc thu hồi suy từ đó (`sponsorReclaimAfterEpoch`).
      const validity: TxValidity = { fromMs: ctx.tip.blockTimePosixMs, toMs: ctx.plan.capMs };
      const ben = sp.beneficiary!;
      const r = planMintPaidFund({
        scripts: p.scripts, seedUtxo, platformPkh: platform,
        beneficiary: plutusAddressOf(ben.address),
        // Codec của SDK, không `Data` của gói này: hai bản lucid ⟹ `Constr` bên này làm `encodeFundDatum` ném.
        beneficiaryDatum: ben.datumCbor === undefined ? null : plutusDataFromCbor(ben.datumCbor),
        bufferBps: sp.bufferBps ?? MIN_BUFFER_BPS, collectSeed: true,
        sponsorship: { sponsor: plutusAddressOf(sp.addresses[0]!), owner_commit: didCommit },
        validity,
      });
      // Chủ KÝ open-fund (mục rút did_stake như mọi bước khác; chủ khoá: chữ ký khoá). Genesis quỹ không đòi chủ,
      // nhưng dịch vụ đòi: không có chữ ký này thì ai biết owner của một thread cũng xin được quỹ cho DID đó.
      const c = await applyOwnerAuth(applyPlan(lucid.newTx(), r.plan, { mode: "deferred" }),
        resolveOwnerAuth(ctx.owner, ctx.ownerAuth))
        .completeSafe(collateralCompleteOptions(ctx.feePayer?.collateralLovelace));
      if (c._tag === "Left") {
        const err = c.left as { message?: unknown };
        throw new SponsorJourneyError("SPONSOR_BUILD_FAILED", `open-fund: Lucid không dựng được tx — ${String(err?.message ?? c.left)}`);
      }
      const unsigned = c.right.toCBOR();
      const withdrawals = sponsorTxWithdrawalCountOf(unsigned);
      const wantW = ctx.owner.type === "script" ? 1 : 0;
      if (withdrawals !== wantW) {
        throw new SponsorJourneyError("SPONSOR_WITHDRAW_COUNT",
          `open-fund: tx có ${withdrawals} mục rút, chủ ${ctx.owner.type} đòi ĐÚNG ${wantW}.`);
      }
      const outs = sponsorTxOutputsOf(unsigned);
      const fundOut = this.nftOutput(outs, r.nftUnit, prepaid.fundAddress, "quỹ tài trợ", "open-fund");
      // Ký vai platform trên ĐỐI TƯỢNG tx vừa dựng (không qua CBOR của thân bài).
      const txCbor = await this.cosignPlatform(c.right.toTransaction(), "fund-genesis", wallet);
      const txHash = txBodyHash(txCbor);
      const sponsorship = r.datum.sponsorship!;
      return {
        txCbor,
        platformSigners: [platform],
        feeFlow: { scriptAddresses: [prepaid.fundAddress], passAddresses: [] },
        summary: {
          step: "open-fund",
          fund_id: r.fundId, fund_unit: r.nftUnit, fund_address: prepaid.fundAddress, fund_out_ref: `${txHash}#${fundOut}`,
          owner_commit: didCommit, engage_ref: refStr(thread.utxo),
          platform_pkh: platform, sponsor_address: sp.addresses[0], beneficiary: ben.address,
          buffer_bps: r.datum.buffer_bps.toString(),
          reclaim_after_epoch: sponsorship.reclaim_after_epoch.toString(),
          seed_ref: refStr(seedUtxo), withdrawals, outputs: outputsJson(outs),
        },
      };
    });
  }

  /** fund-vault — PrepaidLock + FundLock: CARP từ UTxO bên tài trợ vào quỹ đã ghim; anchor DID ở reference input. */
  async fundVault(req: SponsorFundVaultRequest): Promise<SponsorBuildResponse> {
    const prepaid = this.requirePrepaid("fund-vault");
    const callerUnit = req.fundId === undefined ? undefined : prepaid.fundScriptHash + req.fundId;
    // Ghim của cấu hình, TRƯỚC khi giữ khoá: yêu cầu ngoài ghim không được chiếm khoá của quỹ.
    const pins = assertFundPinnedInputs(prepaid.sponsor, callerUnit, req.carpAmount);
    // `utxo:<ref>` cho từng UTxO bên tài trợ: hai fund-vault đang chờ ký không được dựng trên cùng một bộ UTxO
    // (cái nộp sau chết trên chuỗi sau khi bên tài trợ đã ký). Khoá `fund:<unit>` do `run` giữ (`fund`).
    const lockKeys = req.sponsorUtxoRefs.map(r => `utxo:${refStr(r)}`);
    return this.run("fund-vault", req, lockKeys, async (p, ctx) => {
      const anchorPolicy = this.deps.deployment.didStake?.anchorNftPolicy;
      if (anchorPolicy === undefined) {
        throw new ConfigMissingError(
          `fund-vault phải mang anchor DID của người mới ở reference input, mà bản deploy không khai policy anchor.`,
          { missing: ["did_stake.anchor_nft_policy"], route: "/tx/sponsor/fund-vault" });
      }
      const vault = await this.pickVault(p, ctx.owner, req.vaultRef);
      // `did_commit` của hành trình nằm ở THREAD consume, không ở két: két Prepaid genesis bắt buộc
      // `did_commit == #""` (`PrepaidGen/offchain/src/tx/builders.ts` ▸ `planMintPrepaidVault`). Bản trước đọc
      // ở két ⟹ mọi két mở bằng open-vault chết ở đây với 422 — bài Emulator qua route bắt được.
      const d = this.deps.deployment.consume;
      const thread = await pickEngageThread(this.deps.chain, d.engageAddress, d.engageScriptHash, ctx.owner,
        undefined, "/tx/sponsor/fund-vault");
      const didCommit = didCommitOf(thread);
      if (!/^[0-9a-f]{64}$/.test(didCommit)) {
        throw new CodedApiError(422, "SPONSOR_THREAD_DID_INVALID",
          `Thread ${refStr(thread.utxo)} mang did_commit dài ${didCommit.length / 2} byte; fund-vault cần đúng 32 byte để định ` +
          `vị anchor DID của người mới. Thread này không mở bằng open-vault.`, { engage_ref: refStr(thread.utxo) });
      }
      // Suất tài trợ đếm theo `did_commit` này ⟹ nó phải là DID của chính chủ ký, không phải của ai khác.
      assertOwnerDid("fund-vault", ctx.owner, ctx.witness, didCommit, this.deps.deployment.didStake);
      const anchor = await this.uniqueByUnit(anchorPolicy + didCommit, undefined, "SPONSOR_ANCHOR",
        `anchor DID của người mới (owner_commit ${didCommit.slice(0, 16)}…)`);
      // Quỹ tài trợ CỦA DID này (mỗi DID một quỹ — `sponsorFund.ts`). Tìm SAU khi biết `did_commit` của
      // thread; khoá chủ đã giữ, và quỹ của một DID chỉ chủ của DID đó chạm tới, nên không có cuộc đua
      // giữa lượt đọc này và lượt giữ `fund:<unit>` ngay dưới.
      const funds = await this.readSponsorFunds(prepaid, pins, epochAt(ctx.tip.blockTimePosixMs, p));
      const { entry, selection } = resolveSponsorFund(funds, didCommit, req.fundId);
      assertDidNotFundedElsewhere(funds, didCommit, entry.unit);
      const fundUnit = entry.unit;
      const fund = entry.utxo!;
      // PrepaidLock trên quỹ tài trợ đòi két mang ĐÚNG `owner_commit` (prepaid.ak ▸ `validate_lock`,
      // khối `sponsorship`). Két Prepaid đúc với `did_commit` rỗng; gắn DID là nhánh `SetDidCommit` riêng.
      if (vault.datum.did_commit !== didCommit) {
        const unset = vault.datum.did_commit === "";
        throw new CodedApiError(unset ? 409 : 422, unset ? "SPONSOR_VAULT_DID_UNSET" : "SPONSOR_VAULT_DID_MISMATCH",
          unset
            ? `Két ${refStr(vault.utxo)} chưa gắn DID (did_commit rỗng); quỹ tài trợ chỉ nạp vào két mang đúng DID ` +
              `${didCommit.slice(0, 16)}… — gắn DID cho két (nhánh SetDidCommit) trước fund-vault.`
            : `Két ${refStr(vault.utxo)} mang DID khác DID của thread (${didCommit.slice(0, 16)}…); quỹ tài trợ của DID ` +
              `này không nạp vào két đó được.`,
          { vault_ref: refStr(vault.utxo), vault_did_commit: vault.datum.did_commit, did_commit: didCommit });
      }
      ctx.claimLock(`fund:${fundUnit}`);
      this.assertNotPendingSpent(fund, "quỹ tài trợ này");
      const sponsorUtxos = await this.deps.chain.utxosByOutRef(req.sponsorUtxoRefs);
      if (sponsorUtxos.length !== req.sponsorUtxoRefs.length) {
        const got = new Set(sponsorUtxos.map(refStr));
        throw new CodedApiError(404, "SPONSOR_UTXO_NOT_FOUND",
          `Có tham chiếu trong "sponsor.utxo_refs" không phải UTxO chưa tiêu.`,
          { missing: req.sponsorUtxoRefs.map(refStr).filter(r => !got.has(r)) });
      }
      for (const u of sponsorUtxos) this.assertNotPendingSpent(u, "UTxO bên tài trợ này");
      const sponsorAddress = assertSponsorUtxosPinned(sponsorUtxos, pins, p.scripts.carpUnit);
      // UTxO CARP phải thuộc ĐÚNG bên tài trợ ghi trong datum quỹ (FundLock đòi chữ ký khoá đó; thu hồi trả CARP về
      // địa chỉ đó). Ghim `addresses` nhiều phần tử ⟹ "thuộc tập ghim" chưa đủ.
      const fundSponsorKey = assertSponsorUtxosOfFundSponsor(sponsorAddress, entry);
      if (ctx.feeAddress === sponsorAddress || ctx.feeKeyHash === getAddressDetails(sponsorAddress).paymentCredential!.hash) {
        // Ví trả phí trùng ví bên tài trợ ⟹ tiền thừa của phí cũng về địa chỉ đó, và phép ghim "thối
        // = vào − carp_amount" phải trừ thêm phí. Không mở đường đó: ví trả phí là một ví khác. So cả
        // KHOÁ, không chỉ chuỗi địa chỉ: cùng khoá khác phần stake thì một chữ ký chi được cả hai, và
        // luật `fee_payer` coi output cùng khoá khác địa chỉ là thối nhầm.
        const field = ctx.feePayer === undefined ? "change_address" : "fee_payer.address";
        throw new CodedApiError(422, "SPONSOR_FEE_WALLET_IS_SPONSOR",
          `"${field}" (ví trả phí) trùng ví bên tài trợ (cùng địa chỉ hoặc cùng khoá thanh toán); dùng một ví khoá ` +
          `khác để trả phí fund-vault.`,
          { [field]: ctx.feeAddress });
      }
      // Ví trả phí KHÔNG được góp CARP: chọn-coin kéo CARP của ví đó vào thì nó thành output CARP
      // ngoài quỹ (SDK ném `SPONSOR_CARP_OUTPUT_UNPINNED`). Chỉ đưa cho Lucid các UTxO không CARP.
      const wallet = (await feeWallet(ctx, () => this.walletUtxos(ctx.feeAddress)))
        .filter(u => (u.assets[p.scripts.carpUnit] ?? 0n) === 0n);
      if (wallet.length === 0) throw noWalletUtxo(ctx.feeAddress, "không giữ CARP");
      const lucid = await this.deps.lucidForWallet(ctx.feeAddress, wallet);
      const r = await buildSponsorT2Fund({
        lucid, prepaidScripts: p.scripts, vaultUtxo: vault.utxo, fundUtxo: fund, pinnedFundUnit: fundUnit,
        carpAmount: req.carpAmount, sponsorCarpUtxos: sponsorUtxos, sponsorChangeAddress: sponsorAddress,
        newcomerAnchor: { utxo: anchor, anchorNftPolicyId: anchorPolicy, ownerCommit: didCommit },
        ownerAuth: ctx.ownerAuth, network: this.deps.network, nowMs: ctx.tip.blockTimePosixMs,
        ...sponsorValidityArgs("fund-vault", ctx.plan),
        ...collateralOf(ctx),
      });
      // Đọc lại CBOR (không qua summary của SDK) và so với giá trị ĐÃ GHIM + UTxO đọc từ chuỗi.
      assertFundPinnedOutputs(sponsorTxOutputsOf(r.txCbor), {
        pins, carpUnit: p.scripts.carpUnit, fundScriptHash: prepaid.fundScriptHash, fundAddress: prepaid.fundAddress,
        fundIn: fund, sponsorIn: sponsorUtxos, sponsorAddress, carpAmount: req.carpAmount,
      });
      const s = r.summary;
      const txHash = txBodyHash(r.txCbor);
      const vaultOut = this.nftOutput(s.outputs, vault.nftUnit, p.scope.address, "két Prepaid", "fund-vault");
      return {
        txCbor: r.txCbor,
        // Khoá bên tài trợ lấy từ DATUM quỹ (thứ validator đòi), không từ input.
        sponsorSigners: [fundSponsorKey],
        sponsorChangeAddress: sponsorAddress,
        feeFlow: { scriptAddresses: [p.scope.address, prepaid.fundAddress], passAddresses: [sponsorAddress] },
        summary: {
          step: "fund-vault", epoch: Number(s.epoch), epoch_end_ms: windowStartMs(s.epoch + 1n, p.P, p.O).toString(),
          vault_out_ref: `${txHash}#${vaultOut}`, fund_id: s.fundId, fund_unit: s.fundUnit,
          // "caller": bên gọi gửi `fund_id` (đã đối chiếu DID); "did_lookup": dịch vụ tìm quỹ của DID.
          fund_selection: selection,
          carp_amount: s.carpAmount.toString(), opens_new_line: s.opensNewLine,
          anchor_ref: refStr(s.anchorRef), owner_commit: didCommit, sponsor_signers: [fundSponsorKey],
          sponsor_change_address: sponsorAddress,
          withdrawals: s.withdrawals, outputs: outputsJson(s.outputs),
        },
      };
    });
  }

  /** draw-magic — PrepaidDraw ⟹ một lô MAGIC sống ĐÚNG kỳ e. */
  async drawMagic(req: SponsorDrawMagicRequest): Promise<SponsorBuildResponse> {
    return this.run("draw-magic", req, [], async (p, ctx) => {
      const vault = await this.pickVault(p, ctx.owner, req.vaultRef);
      const wallet = await feeWallet(ctx, () => this.walletUtxos(ctx.feeAddress));
      const lucid = await this.deps.lucidForWallet(ctx.feeAddress, wallet);
      const r = await buildSponsorT3Draw({
        lucid, prepaidScripts: p.scripts, vaultUtxo: vault.utxo, fundId: req.fundId, carpAmount: req.carpAmount,
        ownerAuth: ctx.ownerAuth, network: this.deps.network, nowMs: ctx.tip.blockTimePosixMs,
        ...sponsorValidityArgs("draw-magic", ctx.plan),
        ...collateralOf(ctx),
      });
      const s = r.summary;
      const txHash = txBodyHash(r.txCbor);
      const vaultOut = this.nftOutput(s.outputs, vault.nftUnit, p.scope.address, "két Prepaid", "draw-magic");
      return {
        txCbor: r.txCbor,
        feeFlow: { scriptAddresses: [p.scope.address], passAddresses: [] },
        notes: [`first-consume (và genesis két Wakeme) PHẢI chạy trong kỳ ${s.epoch}, trước mốc ${windowStartMs(s.epoch + 1n, p.P, p.O)} ms — ` +
          `lô MAGIC Prepaid chỉ sống đúng kỳ rút.`],
        summary: {
          step: "draw-magic", epoch: Number(s.epoch), epoch_end_ms: windowStartMs(s.epoch + 1n, p.P, p.O).toString(),
          vault_out_ref: `${txHash}#${vaultOut}`, batch_id: s.batchId, magic_nanogic: s.magicNanogic.toString(),
          withdrawals: s.withdrawals, outputs: outputsJson(s.outputs),
        },
      };
    });
  }

  /** first-consume — consume đầu + BurnBatch trên két Prepaid, CÙNG kỳ với draw-magic. */
  async firstConsume(req: SponsorFirstConsumeRequest): Promise<SponsorBuildResponse> {
    return this.run("first-consume", req, [], async (p, ctx) => {
      const d = this.deps.deployment.consume;
      const vault = await this.pickVault(p, ctx.owner, req.vaultRef);
      const thread = await pickEngageThread(this.deps.chain, d.engageAddress, d.engageScriptHash, ctx.owner,
        req.engageRef, "/tx/sponsor/first-consume");
      this.assertNotPendingSpent(thread.utxo, "thread này");
      const beacon = pickByNft(await this.deps.chain.utxosAt(d.priceBeaconAddress), d.priceBeaconNftUnit, "beacon PriceParam");
      const wallet = await feeWallet(ctx, () => this.walletUtxos(ctx.feeAddress));
      const lucid = await this.deps.lucidForWallet(ctx.feeAddress, wallet);
      const r = await buildSponsorT4FirstConsume({
        lucid, prepaidScripts: p.scripts, consumeScript: p.consumeScript, consumeRefUtxo: p.consumeRef,
        engageUtxo: thread.utxo, vaultUtxo: vault.utxo, priceBeaconUtxo: beacon,
        opType: req.opType, opCount: req.opCount, ownerAuth: ctx.ownerAuth, network: this.deps.network,
        tipPosixMs: ctx.tip.blockTimePosixMs, drawEpoch: req.drawEpoch,
        ...(d.maxPriceStale === undefined ? {} : { maxPriceStale: d.maxPriceStale }),
        ...sponsorValidityArgs("first-consume", ctx.plan),
        ...collateralOf(ctx),
      });
      const s = r.summary;
      this.nftOutput(s.outputs, vault.nftUnit, p.scope.address, "két Prepaid", "first-consume");
      this.nftOutput(s.outputs, s.threadUnit, d.engageAddress, "thread", "first-consume");
      return {
        txCbor: r.txCbor,
        feeFlow: { scriptAddresses: [p.scope.address, d.engageAddress], passAddresses: [] },
        summary: {
          step: "first-consume", epoch: Number(s.epoch), required_nanogic: s.requiredNanogic.toString(),
          burns: s.burns.map(([batchId, n]) => ({ batch_id: batchId, nanogic: n.toString() })),
          thread_unit: s.threadUnit, withdrawals: s.withdrawals, outputs: outputsJson(s.outputs),
        },
      };
    });
  }

  // ── khung chung của bốn bước ────────────────────────────────────────────────

  /**
   * Thứ tự như `service.ts` ▸ `buildOne`: kiểm hình dạng + cấu hình TRƯỚC khi giữ khoá (yêu cầu hỏng
   * không chiếm chỗ của chủ) · giữ khoá · đọc đỉnh chuỗi · dựng · đọc lại CBOR · ghi sổ phát-hành ·
   * hỏng ở đâu thì NHẢ mọi khoá đã giữ.
   */
  private async run(
    step: SponsorStep,
    reqIn: OwnerRequest,
    extraLockKeys: string[],
    build: (p: Prepared, ctx: StepCtx) => Promise<{
      txCbor: string; summary: Record<string, unknown>; sponsorSigners?: string[]; sponsorChangeAddress?: string;
      platformSigners?: string[]; notes?: string[]; feeFlow: FeeFlow;
    }>,
  ): Promise<SponsorBuildResponse> {
    // Suy chủ DID TRƯỚC mọi khoá: khoá chủ là `script:<hash>` như chủ script tường minh.
    const req = await this.resolveOwner(reqIn);
    const owner = assertOwner(req.owner);
    if ((step === "open-vault" || step === "bind-did" || step === "open-fund" || step === "fund-vault") && owner.type === "key"
      && this.deps.allowKeyOwner !== true) {
      // 422 chứ không 409: không có trạng thái nào để chờ đổi — yêu cầu sai loại chủ từ gốc.
      throw new CodedApiError(422, "SPONSOR_OWNER_NOT_DID",
        `${step} của hành trình tài trợ chỉ nhận chủ Script(did_stake) kèm "owner_witness": suất tài trợ đếm theo ` +
        `DID, và chủ khoá khai được did_commit của bất kỳ ai.`, { step, owner_type: owner.type });
    }
    this.requireNetworkGrid();
    this.requirePrepaid(step);
    // Cùng luật với `service.ts` ▸ `feePayerFor`: loại trừ `change_address`, địa chỉ đúng mạng + khoá.
    const fpReq = req.feePayer;
    if (fpReq !== undefined) {
      if (req.changeAddress !== undefined) {
        throw new CodedApiError(400, "FEE_PAYER_CHANGE_ADDRESS_CONFLICT",
          `"change_address" và "fee_payer" không đi cùng nhau: có "fee_payer" thì phí, thế chấp, min-ADA ứng ` +
          `trước và tiền thối ADA đều đi qua "fee_payer.address". Bỏ "change_address".`);
      }
      assertFeePayerAddress(this.deps.network, fpReq, FEE_PAYER_CODES);
    }
    const feeAddress = fpReq?.address ?? this.feeAddressFor(req);
    this.assertFeeWalletNotPlatform(step, feeAddress,
      fpReq !== undefined ? "fee_payer.address" : req.changeAddress !== undefined ? "change_address" : "owner");
    this.assertWitnessShape(req);
    const ownerKey = ownerLockKey(owner);
    // `utxo:<UTxO trả phí>`: hai tx đang chờ ký không được tiêu cùng một UTxO của ví trả phí.
    const restKeys = [...extraLockKeys, ...(fpReq === undefined ? [] : [`utxo:${refStr(fpReq.utxoRef)}`])];
    const keys: string[] = [ownerKey];
    const gens: Array<[string, number]> = [];
    const didGens: Array<[string, number]> = [];
    try {
      const startedAt = this.now();
      keys.push(...restKeys);
      for (const k of keys) gens.push([k, this.deps.locks.acquire(k, startedAt)]);
      const claimLock = (k: string): void => {
        if (keys.includes(k)) return;
        keys.push(k);
        gens.push([k, this.deps.locks.acquire(k, this.now())]);
      };
      const p = await this.prepare();
      const tip = await this.deps.chain.tip();
      const witness = owner.type === "key" ? undefined : await this.deps.ownerWitness!.resolve(owner, req.ownerWitness!);
      const plan = planSponsorValidity({
        step, tipPosixMs: tip.blockTimePosixMs, network: this.deps.network,
        txValidityMs: this.deps.txValidityMs ?? DEFAULT_TX_VALIDITY_MS, issued: this.deps.issued,
        ...(fpReq === undefined ? {} : { feePayer: {
          utxoRef: refStr(fpReq.utxoRef), address: fpReq.address,
          ...(fpReq.reservationId === undefined ? {} : { reservationId: fpReq.reservationId }),
        } }),
      });
      let feePayer: StepCtx["feePayer"];
      let rewardReturn: OwnerRewardReturn | undefined;
      let coinsPerUtxoByte = 0n;
      if (fpReq !== undefined) {
        const utxo = await readFeePayerUtxo(this.deps.chain, fpReq, FEE_PAYER_CODES);
        this.assertNotPendingSpent(utxo, "ví trả phí");
        // Tham số giao thức của chính lucid bộ dựng dùng — trần khoản ứng ở `checkSponsorFeePayerTx`.
        coinsPerUtxoByte = BigInt((await this.deps.lucidForWallet(fpReq.address, [utxo])).config().protocolParameters!.coinsPerUtxoByte);
        feePayer = {
          req: fpReq, utxo, collateralLovelace: this.deps.deployment.feePayerCollateralLovelace,
        };
        // Thưởng did_stake về ví Phoenix của chủ, không vào tiền thối của ví trả phí — cùng luật với
        // `service.ts` (`feePayer.ts` ▸ khối "MỤC RÚT did_stake"). Tham số giao thức đọc từ chính lucid
        // bộ dựng sẽ dùng, và chỉ khi thưởng > 0.
        rewardReturn = await planOwnerRewardReturn(
          witness?.ownerReward,
          () => didPaymentAddressFor({
            didStake: this.deps.deployment.didStake, anchorNftName: witness?.anchorNftName,
            ownerHash: owner.hash, network: this.deps.network,
          }),
          async () => BigInt((await this.deps.lucidForWallet(feeAddress, [utxo])).config().protocolParameters!.coinsPerUtxoByte),
        );
      }
      const ownerAuth: OwnerAuth<TxBuilder> =
        withOwnerRewardReturn(witness?.auth, rewardReturn) ?? { kind: "key", pkh: owner.hash };
      const ctx: StepCtx = {
        owner, ownerAuth, ...(witness === undefined ? {} : { witness }),
        feeAddress, feeKeyHash: getAddressDetails(feeAddress).paymentCredential!.hash, tip, plan,
        ...(feePayer === undefined ? {} : { feePayer }),
        claimLock,
        holdDid: (didCommit: string): void => {
          const key = `did:${didCommit}`;
          if (didGens.some(([k]) => k === key)) return;
          const h = this.didHolds.claim(key, this.now(), this.deps.lockTtlMs);
          if (!h.ok) {
            throw new CodedApiError(409, "SPONSOR_DID_GENESIS_IN_FLIGHT",
              `DID ${didCommit.slice(0, 16)}… đang có một tx genesis quỹ tài trợ khác chưa hết hạn — chờ nó vào khối ` +
              `(khi đó DID đã có quỹ) hoặc hết hạn rồi gọi lại.`,
              { did_commit: didCommit, tx_hash: h.txHash, held_until: new Date(h.untilMs).toISOString() });
          }
          didGens.push([key, h.gen]);
        },
      };
      const out = await build(p, ctx);
      if (req.ownerDid !== undefined) out.summary.owner_did = req.ownerDid;
      const txHash = txBodyHash(out.txCbor);
      if (feePayer !== undefined) {
        // Đọc lại CBOR — input khác UTxO trả phí tra từ CHUỖI, không từ bộ dựng.
        const feeKey = refStr(feePayer.req.utxoRef);
        const others = inputRefsOf(out.txCbor).filter(r => refStr(r) !== feeKey);
        const otherInputs = others.length === 0 ? [] : await this.deps.chain.utxosByOutRef(others);
        out.summary.fee_payer = checkSponsorFeePayerTx(out.txCbor, {
          network: this.deps.slotNetwork ?? this.deps.network, tipPosixMs: tip.blockTimePosixMs, feePayer: feePayer.req,
          feePayerUtxo: feePayer.utxo, maxCollateralLovelace: feePayer.collateralLovelace, otherInputs, ...out.feeFlow,
          coinsPerUtxoByte,
          ...(rewardReturn === undefined ? {} : { ownerRewardReturn: rewardReturn }),
        });
      }
      // Hạn đọc NGƯỢC từ chính CBOR, SAU cổng ví trả phí (như create-vault ở `service.ts`): tx thiếu
      // hạn ở đường `fee_payer` ra 422 của cổng đó, không 500 bất biến.
      const expiry = readTxExpiry(out.txCbor, this.deps.slotNetwork ?? this.deps.network, plan, tip.blockTimePosixMs);
      for (const [k, g] of gens) this.deps.locks.bindTxHash(k, txHash, g);
      for (const [k, g] of didGens) this.didHolds.bind(k, g, txHash, Number(expiry.validToMs));
      this.deps.issued.record(txHash, this.now(), {
        route: ISSUED_ROUTE_OF_STEP[step], lockKeys: keys, validToMs: Number(expiry.validToMs),
        ...feePayerRecordFields(feePayer?.req, plan.feeReservation),
      });
      return {
        step,
        txCbor: out.txCbor,
        txHash,
        requiredSigners: requiredSignersOf(out.txCbor),
        signers: signersFor(step, ctx, out.sponsorSigners ?? [], out.platformSigners ?? []),
        witnessNotes: [
          ...(owner.type === "key" ? [`Chủ khoá: ký bằng khoá ${owner.hash}.`] : (witness?.notes ?? [])),
          ctx.feePayer === undefined
            ? `Ví trả phí: input phí + tài sản thế chấp lấy từ ${feeAddress}; khoá thanh toán ${ctx.feeKeyHash} phải ký.`
            : `Ví trả phí (fee_payer): tx tiêu ĐÚNG UTxO ${refStr(ctx.feePayer.req.utxoRef)} ở ${feeAddress} — phí, ` +
              `thế chấp${step === "open-vault" ? `, min-ADA của két và thread${(out.platformSigners ?? []).length > 0 ? " và quỹ" : ""}` : step === "open-fund" ? ", min-ADA của quỹ" : ""}` +
              `; tiền thối ADA về lại địa chỉ đó; khoá ` +
              `thanh toán ${ctx.feeKeyHash} phải ký. Chủ két không góp UTxO nào cho phí.`,
          ...(rewardReturn === undefined ? [] : [ownerRewardNote(rewardReturn)]),
          ...(step === "fund-vault"
            ? [`Bên tài trợ ký bằng ${(out.sponsorSigners ?? []).join(", ")} (chi các UTxO CARP đã đưa); phần thối về ${out.sponsorChangeAddress ?? "?"} — đúng địa chỉ của các UTxO đó.`]
            : []),
          ...((out.platformSigners ?? []).length > 0
            ? [`Vai platform (${(out.platformSigners ?? []).join(", ")}): dịch vụ ĐÃ ký — vkey witness nằm sẵn trong ` +
              `tx_cbor (genesis quỹ tài trợ đòi chữ ký platform). Các bên còn lại ký thêm trên đúng tx_hash này, ` +
              `giữ nguyên witness đã có.`]
            : []),
          ...(out.notes ?? []),
          `Thứ tự: thân giao dịch này là bản CHỐT — mọi bên ký trên đúng tx_hash trả về; đổi bất kỳ byte nào ` +
            `của thân thì mọi chữ ký đã có mất hiệu lực.`,
        ],
        summary: out.summary,
        expiresAt: expiry.expiresAt,
        expiresReason: expiry.reason,
      };
    } catch (e) {
      for (const [k, g] of gens) this.deps.locks.release(k, g);
      for (const [k, g] of didGens) this.didHolds.release(k, g);
      throw asSponsorApiError(e);
    }
  }

  /** Ví trả phí (input + thế chấp) có khoá thanh toán là một khoá platform đã ghim ⟹ 422, ở MỌI bước. */
  private assertFeeWalletNotPlatform(step: SponsorStep, feeAddress: string, field: string): void {
    const pkhs = this.deps.deployment.prepaid?.sponsor?.platformPkhs ?? [];
    const c = getAddressDetails(feeAddress).paymentCredential;
    if (c?.type === "Key" && pkhs.includes(c.hash)) {
      // Witness platform mà dịch vụ gắn vào tx cũng thoả chữ ký tiêu input của ví đó: kẻ gọi được ví trả phí
      // "do khoá platform trả". Hàm ký tự từ chối input của khoá này; đây là lớp sớm, có mã rõ nghĩa.
      throw new CodedApiError(422, "SPONSOR_FEE_WALLET_IS_PLATFORM",
        `"${field}" (ví trả phí) mang khoá thanh toán là khoá platform đã ghim (paid_fund.sponsor.platform_pkhs). ` +
        `Khoá platform không phải ví: dùng một ví khoá khác để trả phí.`, { [field]: feeAddress, step });
    }
  }

  /**
   * claim — `FundClaim` (hoặc lượt rút cuối đóng quỹ đã thu hồi): CARP từ quỹ tài trợ tới beneficiary ĐÃ GHIM;
   * dịch vụ ký vai platform (`prepaid.ak` ▸ `validate_fund_claim` / `validate_fund_claim_close`). Không có chủ két:
   * khoá mềm là `fund:<unit>` (+ `utxo:<UTxO trả phí>`). Không ký thì CARP đã tiêu thật kẹt trong quỹ vĩnh viễn.
   */
  async claimFund(req: SponsorClaimRequest): Promise<SponsorBuildResponse> {
    const route = "/tx/sponsor/claim";
    this.requireNetworkGrid();
    const prepaid = this.requirePrepaid("claim");
    const pins = prepaid.sponsor;
    const platform = pins?.platformPkhs?.[0];
    const missing = [
      ...(pins === undefined ? ["paid_fund.sponsor"] : []),
      ...(pins !== undefined && platform === undefined ? ["paid_fund.sponsor.platform_pkhs"] : []),
      ...(pins !== undefined && pins.beneficiary === undefined ? ["paid_fund.sponsor.beneficiary"] : []),
      ...(this.deps.platformSign === undefined ? [PLATFORM_KEY_ENV] : []),
    ];
    if (missing.length > 0) {
      throw new ConfigMissingError(`claim cần khoá platform đã ghim (platform_pkhs), đích nhận CARP đã ghim ` +
        `(beneficiary) và khoá platform của dịch vụ (${PLATFORM_KEY_ENV}).`, { missing, route });
    }
    const ben = pins!.beneficiary!;
    const fpReq = req.feePayer;
    if (fpReq !== undefined) {
      if (req.changeAddress !== undefined) {
        throw new CodedApiError(400, "FEE_PAYER_CHANGE_ADDRESS_CONFLICT",
          `"change_address" và "fee_payer" không đi cùng nhau. Bỏ "change_address".`);
      }
      assertFeePayerAddress(this.deps.network, fpReq, FEE_PAYER_CODES);
    } else if (req.changeAddress === undefined) {
      throw new CodedApiError(400, "CHANGE_ADDRESS_REQUIRED",
        `claim không có chủ két để suy ví trả phí — gửi "fee_payer" { utxo, address } hoặc "change_address".`);
    }
    const feeAddress = fpReq?.address ?? assertChangeAddress(this.deps.network, req.changeAddress!);
    const field = fpReq !== undefined ? "fee_payer.address" : "change_address";
    this.assertFeeWalletNotPlatform("claim", feeAddress, field);
    if (feeAddress === ben.address) {
      throw new CodedApiError(422, "SPONSOR_FEE_WALLET_IS_BENEFICIARY",
        `"${field}" là đúng địa chỉ nhận CARP của quỹ; validator cấm mọi input ở địa chỉ đó — phí và tiền thừa phải đi ` +
        `từ một địa chỉ khác (vd. địa chỉ base của cùng khoá).`, { [field]: feeAddress });
    }
    const feeKeyHash = getAddressDetails(feeAddress).paymentCredential!.hash;
    const fundUnit = prepaid.fundScriptHash + req.fundId;
    const keys = [`fund:${fundUnit}`, ...(fpReq === undefined ? [] : [`utxo:${refStr(fpReq.utxoRef)}`])];
    const gens: Array<[string, number]> = [];
    try {
      for (const k of keys) gens.push([k, this.deps.locks.acquire(k, this.now())]);
      const p = await this.prepare();
      const tip = await this.deps.chain.tip();
      const plan = planSponsorValidity({
        step: "claim", tipPosixMs: tip.blockTimePosixMs, network: this.deps.network,
        txValidityMs: this.deps.txValidityMs ?? DEFAULT_TX_VALIDITY_MS, issued: this.deps.issued,
        ...(fpReq === undefined ? {} : { feePayer: {
          utxoRef: refStr(fpReq.utxoRef), address: fpReq.address,
          ...(fpReq.reservationId === undefined ? {} : { reservationId: fpReq.reservationId }),
        } }),
      });
      // Quỹ: tra đúng NFT của nó (không quét địa chỉ quỹ), cùng phép phân loại với fund-vault.
      const [entry] = await this.readSponsorFunds(prepaid, pins!, epochAt(tip.blockTimePosixMs, p), [fundUnit]);
      if (entry?.utxo === undefined || entry.datum === undefined) {
        throw new CodedApiError(404, "SPONSOR_FUND_NOT_FOUND", `Không có quỹ tài trợ ${req.fundId} trên chuỗi.`,
          { fund_id: req.fundId, fund_unit: fundUnit });
      }
      if (entry.problem !== undefined && entry.problem !== "reclaimed") {
        throw new CodedApiError(422, "SPONSOR_FUND_NOT_CLAIMABLE",
          `Quỹ ${req.fundId} không phải quỹ dịch vụ này tin (problem: ${entry.problem}) — không ký claim cho nó.`,
          { fund_id: req.fundId, problem: entry.problem });
      }
      const fund = entry.utxo;
      this.assertNotPendingSpent(fund, "quỹ tài trợ này");
      const max = maxClaimable(entry.datum);
      if (max === 0n) {
        throw new CodedApiError(409, "SPONSOR_FUND_NOTHING_TO_CLAIM",
          `Quỹ ${req.fundId} chưa có CARP nào claim được (E = 0): MAGIC đã tiêu phải được quyết toán vào quỹ ` +
          `(SettleLine) trước.`, {
            fund_id: req.fundId, carp_locked: raw(entry.datum.carp_locked), magic_settled: raw(entry.datum.magic_settled),
            provider_claimed: raw(entry.datum.provider_claimed),
          });
      }
      const amount = req.amount ?? max;
      if (amount > max) {
        throw new CodedApiError(422, "SPONSOR_CLAIM_ABOVE_MAX",
          `"amount" ${amount} vượt phần claim được ${max}.`, { amount: raw(amount), max_claimable: raw(max) });
      }
      let feePayer: StepCtx["feePayer"];
      let coinsPerUtxoByte = 0n;
      if (fpReq !== undefined) {
        const utxo = await readFeePayerUtxo(this.deps.chain, fpReq, FEE_PAYER_CODES);
        this.assertNotPendingSpent(utxo, "ví trả phí");
        coinsPerUtxoByte = BigInt((await this.deps.lucidForWallet(fpReq.address, [utxo])).config().protocolParameters!.coinsPerUtxoByte);
        feePayer = { req: fpReq, utxo, collateralLovelace: this.deps.deployment.feePayerCollateralLovelace };
      }
      // Ví trả phí không góp CARP: CARP thối về ví đó là output CARP ngoài đích, hàm ký từ chối.
      const wallet = (feePayer !== undefined ? [feePayer.utxo] : await this.walletUtxos(feeAddress))
        .filter(u => (u.assets[p.scripts.carpUnit] ?? 0n) === 0n);
      if (wallet.length === 0) throw noWalletUtxo(feeAddress, "không giữ CARP");
      const lucid = await this.deps.lucidForWallet(feeAddress, wallet);
      const r = planFundClaim({
        scripts: p.scripts, fundUtxo: fund, amount, validity: { fromMs: tip.blockTimePosixMs, toMs: plan.capMs },
      });
      if (r.beneficiaryAddress !== ben.address) {
        throw txMismatch("claim", `đích CARP của quỹ khác beneficiary đã ghim.`, { fund_beneficiary: r.beneficiaryAddress, pinned: ben.address });
      }
      const c = await applyPlan(lucid.newTx(), r.plan, { mode: "deferred" })
        .completeSafe(collateralCompleteOptions(feePayer?.collateralLovelace));
      if (c._tag === "Left") {
        const err = c.left as { message?: unknown };
        throw new SponsorJourneyError("SPONSOR_BUILD_FAILED", `claim: Lucid không dựng được tx — ${String(err?.message ?? c.left)}`);
      }
      const unsigned = c.right.toCBOR();
      // Đọc lại CBOR: CARP chỉ tới beneficiary đã ghim (ĐÚNG một output, đúng lượng) hoặc về lại quỹ.
      const outs = sponsorTxOutputsOf(unsigned);
      const carpOuts = outs.filter(o => (o.assets[p.scripts.carpUnit] ?? 0n) > 0n);
      const stray = carpOuts.filter(o => o.address !== ben.address && o.address !== prepaid.fundAddress);
      const toBen = carpOuts.filter(o => o.address === ben.address);
      if (stray.length > 0 || toBen.length !== 1 || toBen[0]!.assets[p.scripts.carpUnit] !== amount) {
        throw txMismatch("claim", `output CARP lệch đích đã ghim.`, { outputs: outputsJson(outs) });
      }
      const txCbor = await this.cosignPlatform(c.right.toTransaction(), "fund-claim", [fund, ...wallet]);
      const txHash = txBodyHash(txCbor);
      let feeSummary: SponsorFeePayerSummary | undefined;
      if (feePayer !== undefined) {
        const feeKey = refStr(feePayer.req.utxoRef);
        const others = inputRefsOf(txCbor).filter(x => refStr(x) !== feeKey);
        const otherInputs = others.length === 0 ? [] : await this.deps.chain.utxosByOutRef(others);
        feeSummary = checkSponsorFeePayerTx(txCbor, {
          network: this.deps.slotNetwork ?? this.deps.network, tipPosixMs: tip.blockTimePosixMs, feePayer: feePayer.req,
          feePayerUtxo: feePayer.utxo, maxCollateralLovelace: feePayer.collateralLovelace, otherInputs, coinsPerUtxoByte,
          // Bên hưởng (min-ADA của output CARP do ví trả phí ứng) và, ở nhánh đóng, bên tài trợ (nhận lại ADA của quỹ).
          scriptAddresses: [prepaid.fundAddress, ben.address, ...(r.sponsorAddress === null ? [] : [r.sponsorAddress])],
          passAddresses: [],
        });
      }
      const expiry = readTxExpiry(txCbor, this.deps.slotNetwork ?? this.deps.network, plan, tip.blockTimePosixMs);
      for (const [k, g] of gens) this.deps.locks.bindTxHash(k, txHash, g);
      this.deps.issued.record(txHash, this.now(), {
        route: ISSUED_ROUTE_OF_STEP.claim, lockKeys: keys, validToMs: Number(expiry.validToMs),
        ...feePayerRecordFields(feePayer?.req, plan.feeReservation),
      });
      const fundOut = r.closing ? undefined : outs.findIndex(o => o.address === prepaid.fundAddress && (o.assets[fundUnit] ?? 0n) === 1n);
      return {
        step: "claim", txCbor, txHash, requiredSigners: requiredSignersOf(txCbor),
        signers: [
          { role: "fee-wallet", keyHashes: [feeKeyHash], how: feePayer === undefined
            ? `ví khoá ${feeAddress}: phí + thế chấp + min-ADA output tới bên hưởng + tiền thừa`
            : `fee_payer ${feeAddress}: chi đúng UTxO ${refStr(feePayer.req.utxoRef)} — phí + thế chấp + min-ADA output tới bên hưởng; tiền thối ADA về lại địa chỉ đó` },
          { role: "platform", keyHashes: [platform!], how: "service" },
        ],
        witnessNotes: [
          `Vai platform (${platform}): dịch vụ ĐÃ ký — vkey witness nằm sẵn trong tx_cbor (FundClaim đòi chữ ký platform).`,
          `Ví trả phí: khoá thanh toán ${feeKeyHash} ký thêm trên đúng tx_hash này, giữ nguyên witness đã có.`,
          `Thứ tự: thân giao dịch này là bản CHỐT — đổi bất kỳ byte nào của thân thì mọi chữ ký đã có mất hiệu lực.`,
        ],
        summary: {
          step: "claim", fund_id: req.fundId, fund_unit: fundUnit, fund_ref: refStr(fund), amount: raw(amount),
          max_claimable: raw(max), closing: r.closing, beneficiary: ben.address, epoch: Number(r.epoch),
          ...(r.fundDatumOut === null ? {} : { carp_locked_after: raw(r.fundDatumOut.carp_locked) }),
          ...(fundOut === undefined || fundOut < 0 ? {} : { fund_out_ref: `${txHash}#${fundOut}` }),
          ...(r.sponsorAddress === null ? {} : { sponsor_address: r.sponsorAddress }),
          outputs: outputsJson(outs),
          ...(feeSummary === undefined ? {} : { fee_payer: feeSummary }),
        },
        expiresAt: expiry.expiresAt,
        expiresReason: expiry.reason,
      };
    } catch (e) {
      for (const [k, g] of gens) this.deps.locks.release(k, g);
      throw asSponsorApiError(e);
    }
  }

  // ── quỹ tài trợ theo DID ─────────────────────────────────────────────────────

  /**
   * `GET /sponsor/funds` — tình trạng từng quỹ trong tập ghim + CARP ở ví bên tài trợ. Chỉ đọc. Không
   * đọc được nhà cung cấp chuỗi ⟹ 502 `CHAIN_UNAVAILABLE` (không bao giờ trả một bảng rỗng thay cho lỗi).
   */
  async fundsStatus(): Promise<Record<string, unknown>> {
    const d = this.deps.deployment;
    if (d.prepaid === undefined || d.vaults.length !== 1 || d.vaults[0]!.vaultType !== PREPAID_VAULT_TYPE) {
      throw new CodedApiError(501, "SPONSOR_PREPAID_UNAVAILABLE",
        `Bản deploy này không phục vụ két ${PREPAID_VAULT_TYPE} — không có quỹ tài trợ để đọc.`,
        { vault_types: d.vaults.map(v => v.vaultType) });
    }
    const prepaid = d.prepaid;
    const missing = [
      ...(prepaid.sponsor === undefined ? ["paid_fund.sponsor"] : []),
      ...(prepaid.carpUnit === undefined ? ["paid_fund.carp_unit"] : []),
    ];
    if (missing.length > 0) {
      throw new ConfigMissingError(`Bản deploy chưa ghim quỹ tài trợ.`, { missing, route: "/sponsor/funds" });
    }
    const pins = prepaid.sponsor!;
    this.requireNetworkGrid();
    // Epoch hiện tại theo ĐỈNH CHUỖI (cùng nguồn với các bước dựng) — trần mốc thu hồi ở `classifySponsorFunds`.
    const tip = await chainRead(() => this.deps.chain.tip(), "đỉnh chuỗi");
    const entries = await this.readSponsorFunds(prepaid, pins,
      epochAt(tip.blockTimePosixMs, { P: msPerEpoch(this.deps.network), O: windowOriginMs(this.deps.network) }));
    const wallets = await Promise.all(pins.addresses.map(async address => ({
      address, utxos: await chainRead(() => this.deps.chain.utxosAt(address), "ví bên tài trợ"),
    })));
    const nowMs = this.now();
    return sponsorFundsStatusBody({
      entries, carpUnit: prepaid.carpUnit!, busyOf: e => this.fundBusyOf(e, nowMs), wallets,
      maxCarpAmount: pins.maxCarpAmount, nowMs,
    });
  }

  /**
   * Ảnh chụp tập quỹ ứng viên. `fund_units` có ⟹ mỗi quỹ ghim một lượt tra theo NFT (số lượt = số quỹ
   * ghim). Vắng ⟹ `platform_pkhs` có (cấu hình ép một trong hai) ⟹ QUÉT địa chỉ quỹ, rồi chỉ giữ quỹ
   * giải mã được và mang platform đã ghim: quỹ platform lạ là thứ ai cũng đúc được, bảng tình trạng không
   * liệt kê chúng (không để kẻ đúc rác làm phình `GET /sponsor/funds`).
   */
  private async readSponsorFunds(
    prepaid: NonNullable<Deployment["prepaid"]>, pins: SponsorPins, currentEpoch: bigint,
    /** Có ⟹ chỉ tra đúng các NFT này (claim), không quét địa chỉ quỹ. */
    onlyUnits?: string[],
  ): Promise<SponsorFundEntry[]> {
    const common = {
      // Cùng hai giá trị open-fund ghi vào quỹ (`openFund` ▸ `planMintPaidFund`).
      bufferBps: pins.bufferBps ?? MIN_BUFFER_BPS,
      reclaimHorizon: { currentEpoch, delayEpochs: SPONSOR_RECLAIM_DELAY_EPOCHS },
      fundScriptHash: prepaid.fundScriptHash, fundAddress: prepaid.fundAddress,
      vaultScriptHash: this.deps.deployment.vaults[0]!.scriptHash, sponsorAddresses: pins.addresses,
      network: this.deps.network,
      ...(pins.platformPkhs === undefined ? {} : { platformPkhs: pins.platformPkhs }),
      // Ghim đích nhận CARP: quỹ do khoá platform đúc mà trả CARP đi nơi khác ⟹ `foreign_beneficiary`. Ở đường
      // quét dưới đây pin này luôn có (`config.ts` ▸ `parseSponsorPins` ép).
      ...(pins.beneficiary === undefined ? {} : { beneficiary: pins.beneficiary }),
    };
    const pinnedUnits = onlyUnits ?? pins.fundUnits;
    if (pinnedUnits !== undefined) {
      const lists = await Promise.all(pinnedUnits.map(async u =>
        [u, await chainRead(() => this.deps.chain.utxosByUnit(u), "quỹ tài trợ")] as const));
      return classifySponsorFunds({ ...common, units: pinnedUnits, utxosOfUnit: new Map(lists) });
    }
    if (pins.platformPkhs === undefined) {
      throw new Error("[bất biến nội bộ] paid_fund.sponsor thiếu cả fund_units lẫn platform_pkhs — config.ts phải chặn.");
    }
    if (pins.beneficiary === undefined) {
      throw new Error("[bất biến nội bộ] paid_fund.sponsor quét theo platform_pkhs mà thiếu beneficiary — config.ts phải chặn.");
    }
    const atFund = await chainRead(() => this.deps.chain.utxosAt(prepaid.fundAddress), "địa chỉ quỹ tài trợ");
    const byUnit = new Map<string, UTxO[]>();
    for (const u of atFund) {
      for (const [k, q] of Object.entries(u.assets)) {
        if (k === "lovelace" || !k.startsWith(prepaid.fundScriptHash) || q !== 1n) continue;
        byUnit.set(k, [...(byUnit.get(k) ?? []), u]);
      }
    }
    const units = [...byUnit.keys()].sort();
    // `foreign_beneficiary` KHÔNG bị lọc: quỹ đó do khoá platform ĐÃ GHIM đúc (ai cũng đúc được quỹ platform
    // lạ, không ai ngoài người giữ khoá đúc được quỹ này) ⟹ nó là tín hiệu khoá platform lộ hoặc dùng sai, phải
    // hiện ở `GET /sponsor/funds`.
    return classifySponsorFunds({ ...common, units, utxosOfUnit: byUnit })
      .filter(e => e.problem !== "foreign_platform" && e.problem !== "undecodable");
  }

  /**
   * Quỹ bận khi: một lượt dựng còn giữ khoá mềm `fund:<unit>` (tx chưa nộp, chưa hết TTL) — hoặc UTxO
   * quỹ là input của một tx vừa nộp mà chưa vào khối. Chỉ để báo ở `GET /sponsor/funds`: fund-vault không
   * chọn quỹ theo độ rảnh (mỗi DID một quỹ; tx đang chờ của chính DID đó do khoá chủ + sổ phát-hành xử).
   */
  private fundBusyOf(e: SponsorFundEntry, nowMs: number): SponsorFundBusyReason | null {
    if (this.deps.locks.peek(`fund:${e.unit}`, nowMs) !== null) return "in_flight";
    if (e.utxo !== undefined && this.deps.pending?.has(refStr(e.utxo), nowMs) === true) return "pending_submit";
    return null;
  }

  private requireNetworkGrid(): void {
    try {
      windowOriginMs(this.deps.network);
      msPerEpoch(this.deps.network);
    } catch (e) {
      if (e instanceof WindowOriginError) throw networkUnsupported(e.code);
      throw e;
    }
  }

  private requirePrepaid(step: SponsorStep): NonNullable<Deployment["prepaid"]> & { carpUnit: string } {
    const d = this.deps.deployment;
    if (d.prepaid === undefined || d.vaults.length !== 1 || d.vaults[0]!.vaultType !== PREPAID_VAULT_TYPE) {
      throw new CodedApiError(501, "SPONSOR_PREPAID_UNAVAILABLE",
        `Bản deploy này không phục vụ két ${PREPAID_VAULT_TYPE} (khối "paid_fund" + vaults[].vault_type ` +
        `"${PREPAID_VAULT_TYPE}") — hành trình tài trợ chạy trên két Prepaid.`,
        { vault_types: d.vaults.map(v => v.vaultType), step });
    }
    if (d.prepaid.carpUnit === undefined) {
      throw new ConfigMissingError(
        `Hành trình tài trợ cần CARP của bộ script Prepaid, mà bản deploy không khai "paid_fund.carp_unit".`,
        { missing: ["paid_fund.carp_unit"], route: `/tx/sponsor/${step.toLowerCase()}` });
    }
    if (d.refScriptUtxos.paidFund === undefined) {
      throw new ConfigMissingError(`Bản deploy Prepaid thiếu "ref_script_utxos.paid_fund".`,
        { missing: ["ref_script_utxos.paid_fund"], route: `/tx/sponsor/${step.toLowerCase()}` });
    }
    return d.prepaid as NonNullable<Deployment["prepaid"]> & { carpUnit: string };
  }

  /**
   * Bộ script Prepaid: apply `(carp, ms_per_epoch, window_origin_ms)` của MẠNG vào blueprint, rồi đòi
   * hash/địa chỉ trùng cấu hình — lệch ⟹ 501 `SPONSOR_PREPAID_SCRIPTS_MISMATCH` (cấu hình và blueprint
   * nói về hai lần deploy khác nhau; dựng tiếp là dựng tx chết trên chuỗi). Ref-script của két + quỹ +
   * consume đọc từ chuỗi và phải băm ra đúng script đó.
   */
  private async prepare(): Promise<Prepared> {
    const d = this.deps.deployment;
    const prepaid = d.prepaid!;
    const scope = d.vaults[0]!;
    const P = msPerEpoch(this.deps.network);
    const O = windowOriginMs(this.deps.network);
    if (this.derived === undefined) {
      const carp = prepaid.carpUnit!;
      // `paid_fund` apply-param #5 (2026-10-04, nhánh FundReclaim): script hash két Wakeme
      // của mạng — nguồn duy nhất ProtocolUtils. Mạng chưa có két ⟹ không suy được hash quỹ.
      let wakemeHash: string;
      try {
        wakemeHash = wakemeVaultHash(this.deps.network);
      } catch (e) {
        throw scriptsMismatch(
          `kho chưa có script hash két Wakeme cho ${this.deps.network} — thiếu apply-param #5 của paid_fund: ` +
            (e instanceof Error ? e.message : String(e)),
          {});
      }
      let base: PrepaidScripts;
      try {
        base = derivePrepaidScripts(this.deps.prepaidBlueprint, this.deps.network, {
          carpPolicyId: carp.slice(0, 56), carpAssetName: carp.slice(56), msPerEpoch: P, windowOriginMs: O,
          wakemeVaultHash: wakemeHash,
        });
      } catch (e) {
        throw scriptsMismatch(`không apply được blueprint PrepaidGen: ${e instanceof Error ? e.message : String(e)}`, {});
      }
      const want = { vault_hash: scope.scriptHash, fund_hash: prepaid.fundScriptHash, vault_address: scope.address };
      const got = {
        vault_hash: base.vault.hash, fund_hash: base.paidFund.hash,
        vault_address: validatorToAddress(this.deps.network, base.vault.script),
      };
      if (got.vault_hash !== want.vault_hash || got.fund_hash !== want.fund_hash || got.vault_address !== want.vault_address) {
        throw scriptsMismatch(
          `blueprint + (paid_fund.carp_unit, lưới mạng ${this.deps.network}) cho ra script khác địa chỉ đã cấu hình.`,
          { configured: want, derived: got });
      }
      this.derived = base;
    }
    const [vaultRef, fundRef, consumeRef] = await this.deps.chain.utxosByOutRef([
      d.refScriptUtxos.vault, d.refScriptUtxos.paidFund!, d.refScriptUtxos.consume,
    ]);
    let scripts: PrepaidScripts;
    try {
      scripts = withRefScripts(this.derived, { vault: vaultRef!, paidFund: fundRef! });
    } catch (e) {
      throw new ChainUnavailableError(
        `ref_script_utxos của két/quỹ không mang đúng script đã cấu hình: ${e instanceof Error ? e.message : String(e)}`,
        { what: "ref_script_utxos.vault|paid_fund" });
    }
    const consumeScript = scriptOfRef(consumeRef, "consume");
    const consumeHash = validatorToScriptHash(consumeScript);
    if (consumeHash !== d.consume.engageScriptHash) {
      throw new ChainUnavailableError(
        `Script tham chiếu của consume băm ra ${consumeHash.slice(0, 16)}… nhưng engage_address có script hash ` +
        `${d.consume.engageScriptHash.slice(0, 16)}…. ref_script_utxos.consume trỏ vào một lần deploy khác.`,
        { what: "consume", script_hash_from_chain: consumeHash, script_hash_from_address: d.consume.engageScriptHash });
    }
    return { scope, scripts, consumeScript: consumeScript as Validator, consumeRef: consumeRef!, P, O };
  }

  private feeAddressFor(req: WithResolvedOwner<OwnerRequest>): string {
    if (req.changeAddress !== undefined) return assertChangeAddress(this.deps.network, req.changeAddress);
    if (req.owner.type === "key") return enterpriseAddressOf(this.deps.network, req.owner.hash);
    throw new CodedApiError(400, "CHANGE_ADDRESS_REQUIRED",
      `Chủ script không có địa chỉ ví suy được — gửi "change_address": địa chỉ KHOÁ của ví trả phí ` +
      `(phí + thế chấp + tiền thừa).`);
  }

  /** Cùng luật với `service.ts` ▸ `assertWitnessShapeFor` — kiểm TRƯỚC khi giữ khoá. */
  private assertWitnessShape(req: WithResolvedOwner<OwnerRequest>): void {
    if (req.owner.type === "key" && req.ownerWitness !== undefined) {
      throw new CodedApiError(400, "OWNER_WITNESS_UNEXPECTED",
        `"owner_witness" chỉ dành cho chủ script; chủ khoá chứng minh quyền bằng chữ ký.`);
    }
    if (req.owner.type === "script") {
      if (this.deps.ownerWitness === undefined) {
        throw new CodedApiError(501, "OWNER_SCRIPT_WITNESS_UNAVAILABLE",
          `Dịch vụ chưa được cấu hình nhân chứng chủ script (thiếu mục \`did_stake\` trong bản deploy).`,
          { missing: "deployment.did_stake" });
      }
      if (req.ownerWitness === undefined) {
        throw new CodedApiError(400, "OWNER_SCRIPT_WITNESS_UNAVAILABLE",
          `Chủ là script: yêu cầu phải kèm "owner_witness" (did_stake_script_cbor, anchor_ref, ` +
          `controller_pkh, device_key_hash).`, { missing: "owner_witness" });
      }
    }
  }

  private async walletUtxos(address: string): Promise<UTxO[]> {
    const utxos = await (this.deps.walletChain ?? this.deps.chain).utxosAt(address);
    if (utxos.length === 0) throw noWalletUtxo(address, "");
    return utxos;
  }

  private assertNotPendingSpent(u: UTxO, subject: string): void {
    const ref = refStr(u);
    if (this.deps.pending?.has(ref, this.now())) {
      throw new CodedApiError(409, "PREVIOUS_TX_PENDING",
        `Giao dịch trước của ${subject} đã nộp nhưng chưa vào khối — UTxO ${ref} đang bị nó tiêu. ` +
        `Thử lại sau khi giao dịch đó vào khối.`, { utxo_ref: ref });
    }
  }

  /**
   * Két Prepaid của `owner` ở scope. UTxO mang NFT dưới policy két mà không đọc được ⟹ NÉM 502
   * (lược đồ trôi), không bỏ qua im lặng — cùng luật `vaultLookup.ts` ▸ `findVaultsAtScope`.
   */
  private prepaidVaultsOf(utxos: UTxO[], scripts: PrepaidScripts, owner: OwnerRef): PrepaidVault[] {
    const out: PrepaidVault[] = [];
    for (const u of utxos) {
      if (!Object.keys(u.assets).some(k => k !== "lovelace" && k.startsWith(scripts.vault.hash))) continue;
      let v: ReturnType<typeof readVaultUtxo>;
      try {
        v = readVaultUtxo(scripts, u);
      } catch (e) {
        throw new VaultDatumUndecodableError(refStr(u), e instanceof Error ? e.message : String(e));
      }
      const o = v.datum.owner as { VerificationKey?: [string]; Script?: [string] };
      const vOwner: OwnerRef = o.VerificationKey !== undefined
        ? { type: "key", hash: o.VerificationKey[0] }
        : { type: "script", hash: o.Script![0] };
      if (sameOwner(vOwner, owner)) out.push({ utxo: u, nftUnit: v.nftUnit, datum: { did_commit: v.datum.did_commit } });
    }
    return out;
  }

  private async pickVault(p: Prepared, owner: OwnerRef, vaultRef?: OutRefLike): Promise<PrepaidVault> {
    const mine = this.prepaidVaultsOf(await this.deps.chain.utxosAt(p.scope.address), p.scripts, owner);
    let v: PrepaidVault;
    if (vaultRef !== undefined) {
      const hit = mine.find(x => refStr(x.utxo) === refStr(vaultRef));
      if (hit === undefined) {
        throw new CodedApiError(400, "SPONSOR_VAULT_REF_MISMATCH",
          `"vault_ref" ${refStr(vaultRef).slice(0, 16)}… không phải két Prepaid chưa tiêu của chủ này.`,
          { vault_ref: refStr(vaultRef) });
      }
      v = hit;
    } else if (mine.length === 0) {
      throw new VaultNotFoundError(ownerLockKey(owner), [p.scope.address]);
    } else if (mine.length > 1) {
      throw new VaultAmbiguousError(ownerLockKey(owner), PREPAID_VAULT_TYPE, mine.map(x => refStr(x.utxo)));
    } else {
      v = mine[0]!;
    }
    this.assertNotPendingSpent(v.utxo, "két này");
    return v;
  }

  /** ĐÚNG MỘT UTxO chưa tiêu mang `unit` (tuỳ chọn: ở `address`). 0 ⟹ 404 `<prefix>_NOT_FOUND`; >1 ⟹ 409 `<prefix>_AMBIGUOUS`. */
  private async uniqueByUnit(unit: string, address: string | undefined, prefix: string, what: string): Promise<UTxO> {
    const hits = (await this.deps.chain.utxosByUnit(unit))
      .filter(u => (u.assets[unit] ?? 0n) === 1n && (address === undefined || u.address === address));
    if (hits.length === 0) {
      throw new CodedApiError(404, `${prefix}_NOT_FOUND`, `Không có UTxO chưa tiêu nào mang ${what}.`, { unit });
    }
    if (hits.length > 1) {
      throw new CodedApiError(409, `${prefix}_AMBIGUOUS`,
        `Có ${hits.length} UTxO cùng mang ${what} — bất khả trên sổ cái đã lắng; từ chối chọn đại.`,
        { unit, utxo_refs: hits.map(refStr) });
    }
    return hits[0]!;
  }

  /** Chỉ số output mang ĐÚNG 1 `unit` ở `address`, đọc từ CBOR (qua `summary.outputs` của SDK). */
  private nftOutput(outs: SponsorTxOutput[], unit: string, address: string, what: string, step: SponsorStep): number {
    const hits = outs.filter(o => (o.assets[unit] ?? 0n) === 1n);
    if (hits.length !== 1 || hits[0]!.address !== address) {
      throw txMismatch(step, `tx vừa dựng không có đúng một output ${what} (${unit.slice(0, 20)}…) ở ${address.slice(0, 24)}….`,
        { unit, expected_address: address, outputs_with_unit: hits.map(o => ({ index: o.index, address: o.address })) });
    }
    return hits[0]!.index;
  }
}

interface PrepaidVault { utxo: UTxO; nftUnit: string; datum: { did_commit: string } }

// ── phụ trợ ────────────────────────────────────────────────────────────────────

/**
 * Một lượt đọc chuỗi của quỹ tài trợ chung. Lỗi có mã của bộ đọc (`ChainUnavailableError`…) đi nguyên;
 * lỗi KHÔNG mã của bộ đọc cũng thành 502 `CHAIN_UNAVAILABLE` — đọc hỏng không bao giờ thành "bể rỗng".
 */
async function chainRead<T>(read: () => Promise<T>, what: string): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof TxApiError) throw e;
    throw new ChainUnavailableError(`Không đọc được ${what} từ nhà cung cấp chuỗi.`, { what }, e);
  }
}

function assertOwner(o: OwnerRef): OwnerRef {
  if (o === null || typeof o !== "object" || (o.type !== "key" && o.type !== "script")) {
    throw new CodedApiError(400, "OWNER_CREDENTIAL_SHAPE", `"owner.type" phải là "key" hoặc "script".`);
  }
  if (typeof o.hash !== "string" || !HEX28.test(o.hash)) {
    throw new CodedApiError(400, "OWNER_HASH_INVALID", `"owner.hash" phải là 56 ký tự hex thường.`);
  }
  return { type: o.type, hash: o.hash };
}

// ── ghim của chủ (lỗ: giành suất DID) ───────────────────────────────────────────

/**
 * Chủ script: tên NFT anchor mà nhân chứng `did_stake` dùng phải bằng `didCommit` của thread.
 * `did_stake` được apply `blake2b_256(utf8(did))` và ép trên chuỗi rằng anchor mang đúng tên đó, nên
 * phép so này buộc `did_commit` của hành trình vào DID của CHÍNH người ký. Nhân chứng không báo tên
 * anchor ⟹ coi là lệch (fail-closed), không coi là khớp.
 * Chủ khoá chỉ tới được đây khi `allowKeyOwner` (bài kiểm) — khi đó không có anchor nào để so.
 */
export function assertOwnerDid(
  step: SponsorStep, owner: OwnerRef, witness: ResolvedOwnerWitness | undefined, didCommit: string,
  didStake: DidStakeDeployment | undefined,
): void {
  if (owner.type === "key") return;
  const name = witness?.anchorNftName;
  if (name === undefined || name !== didCommit) {
    throw new CodedApiError(422, "SPONSOR_OWNER_DID_MISMATCH",
      `${step}: anchor DID trong "owner_witness" không mang tên bằng did_commit ${didCommit.slice(0, 16)}… của ` +
      `hành trình — chủ này không phải DID đó.`,
      { step, did_commit: didCommit, ...(name === undefined ? { anchor_nft_name: null } : { anchor_nft_name: name }) });
  }
  // Tên anchor khớp CHƯA đủ: `anchor_ref` và CBOR `did_stake` đều do người gọi đưa (`owner.ts` chỉ so hash CBOR với
  // `owner.hash`). Một script tự chế (luôn đúng) + anchor của người khác qua được phép so tên, và chữ ký "chủ" khi
  // đó là chữ ký của chính kẻ gọi. Ràng buộc thật: `did_stake` CHƯA apply, apply `(anchor_nft_policy, tên anchor)`,
  // phải băm ra ĐÚNG `owner.hash` — cùng phép với `didOwner.ts` ▸ `didPaymentAddressFor`.
  const u = didStake?.unappliedScript;
  if (didStake === undefined || u === undefined) {
    throw new CodedApiError(501, "SPONSOR_OWNER_DID_UNVERIFIABLE",
      `${step}: bản deploy chưa khai script did_stake CHƯA apply ("did_stake.unapplied_script") — dịch vụ không ` +
      `đối chiếu được chủ script với DID, nên không dựng bước tài trợ cho chủ script.`,
      { step, missing: "did_stake.unapplied_script" });
  }
  const applied = validatorToScriptHash({
    type: "PlutusV3", script: applyParamsToScript(u.cbor, [didStake.anchorNftPolicy, name]),
  });
  if (applied !== owner.hash) {
    throw new CodedApiError(422, "SPONSOR_OWNER_DID_MISMATCH",
      `${step}: script chủ ${owner.hash.slice(0, 12)}… không phải did_stake của DID ${didCommit.slice(0, 16)}… ` +
      `(did_stake apply anchor đó băm ra ${applied.slice(0, 12)}…).`,
      { step, did_commit: didCommit, anchor_nft_name: name, owner_hash: owner.hash, did_stake_hash: applied });
  }
}

/** Epoch Prepaid chứa mốc `ms` (lưới `P`, `O` của mạng). */
function epochAt(ms: bigint, g: { P: bigint; O: bigint }): bigint {
  return ms < g.O ? 0n : (ms - g.O) / g.P;
}

// ── ghim của fund-vault (lỗ: thân bài quyết tiền bên tài trợ) ─────────────────────────────

/**
 * Quỹ + trần CARP, TRƯỚC khi giữ khoá. Thiếu khối ghim ⟹ 501 `CONFIG_MISSING`, không cho qua.
 * `fundUnit` vắng ⟹ bên gọi không chọn quỹ, dịch vụ tìm quỹ của DID trong chính tập ghim
 * (`sponsorFund.ts` ▸ `resolveSponsorFund`, sau khi đọc `did_commit` của thread) — chỉ còn trần CARP để kiểm ở đây.
 */
export function assertFundPinnedInputs(pins: SponsorPins | undefined, fundUnit: string | undefined, carpAmount: bigint): SponsorPins {
  if (pins === undefined) {
    throw new ConfigMissingError(
      `fund-vault chi CARP của bên tài trợ, mà bản deploy không ghim quỹ / địa chỉ / trần của bên tài trợ.`,
      { missing: ["paid_fund.sponsor"], route: "/tx/sponsor/fund-vault" });
  }
  // Chỉ chặn sớm khi có tập ghim; đường quét theo platform đối chiếu `fund_id` trong `resolveSponsorFund`.
  if (fundUnit !== undefined && pins.fundUnits !== undefined && !pins.fundUnits.includes(fundUnit)) {
    throw new CodedApiError(422, "SPONSOR_FUND_NOT_ALLOWED",
      `"fund_id" không thuộc tập quỹ bên tài trợ đã ghim ở cấu hình dịch vụ.`, { fund_unit: fundUnit });
  }
  if (carpAmount > pins.maxCarpAmount) {
    throw new CodedApiError(422, "SPONSOR_CARP_ABOVE_CAP",
      `"carp_amount" vượt trần một lượt fund-vault đã ghim.`, { max_carp_amount: pins.maxCarpAmount.toString() });
  }
  return pins;
}

/**
 * UTxO bên tài trợ: mỗi cái mang CARP, tất cả ở CHUNG MỘT địa chỉ khoá, và địa chỉ đó (nguyên văn, cả
 * phần stake) nằm trong tập đã ghim. Trả địa chỉ đó — nó là đích thối duy nhất.
 */
export function assertSponsorUtxosPinned(utxos: UTxO[], pins: SponsorPins, carpUnit: string): string {
  if (utxos.length === 0) throw shape(`"sponsor.utxo_refs" rỗng.`, { field: "sponsor.utxo_refs" });
  const addrs = [...new Set(utxos.map(u => u.address))];
  if (addrs.length !== 1) {
    throw new CodedApiError(422, "SPONSOR_UTXO_NOT_ALLOWED",
      `Các UTxO trong "sponsor.utxo_refs" nằm ở ${addrs.length} địa chỉ; fund-vault cần chúng chung MỘT địa chỉ bên tài trợ.`,
      { addresses: addrs.length });
  }
  const address = addrs[0]!;
  if (getAddressDetails(address).paymentCredential?.type !== "Key") {
    throw new CodedApiError(400, "SPONSOR_UTXO_NOT_KEY",
      `UTxO bên tài trợ không do khoá giữ — bên tài trợ phải ký được để chi nó.`, { utxo_ref: refStr(utxos[0]!) });
  }
  if (!pins.addresses.includes(address)) {
    throw new CodedApiError(422, "SPONSOR_UTXO_NOT_ALLOWED",
      `UTxO trong "sponsor.utxo_refs" không ở địa chỉ bên tài trợ đã ghim ở cấu hình dịch vụ.`,
      { utxo_ref: refStr(utxos[0]!) });
  }
  for (const u of utxos) {
    if ((u.assets[carpUnit] ?? 0n) <= 0n) {
      throw new CodedApiError(422, "SPONSOR_UTXO_NO_CARP",
        `UTxO bên tài trợ ${refStr(u)} không mang CARP — "sponsor.utxo_refs" chỉ nhận UTxO chứa CARP.`,
        { utxo_ref: refStr(u) });
    }
  }
  return address;
}

/**
 * #fund-sponsor: các UTxO CARP (đã qua `assertSponsorUtxosPinned`, chung `sponsorAddress`) phải do ĐÚNG khoá thanh
 * toán ghi ở `sponsorship.sponsor` của quỹ. Trả khoá đó — vai `sponsor` ở bảng `signers` lấy từ đây.
 * Lệch ⟹ 422 `SPONSOR_UTXO_NOT_FUND_SPONSOR`: dựng tiếp thì tx đòi chữ ký khoá trong datum mà bảng ký kê khoá
 * của input (tx chết sau khi bên kia đã ký), hoặc — ký đủ — CARP ví này vào quỹ còn thu hồi trả về ví kia.
 */
export function assertSponsorUtxosOfFundSponsor(sponsorAddress: string, fund: SponsorFundEntry): string {
  const keyOf = (a: string | undefined): string | null => {
    if (a === undefined) return null;
    try {
      const c = getAddressDetails(a).paymentCredential;
      return c?.type === "Key" ? c.hash : null;
    } catch { return null; }
  };
  const fundKey = keyOf(fund.sponsorAddress);
  if (fundKey === null || keyOf(sponsorAddress) !== fundKey) {
    throw new CodedApiError(422, "SPONSOR_UTXO_NOT_FUND_SPONSOR",
      `UTxO trong "sponsor.utxo_refs" không thuộc ví bên tài trợ của quỹ ${fund.fundId} (khoá thanh toán trong datum ` +
      `quỹ khác khoá của ${sponsorAddress}). Dùng UTxO CARP của đúng ví đó.`,
      { fund_id: fund.fundId, fund_sponsor_address: fund.sponsorAddress ?? null, sponsor_utxo_address: sponsorAddress });
  }
  return fundKey;
}

export interface FundPinnedOutputsExpect {
  pins: SponsorPins;
  carpUnit: string;
  fundScriptHash: string;
  fundAddress: string;
  /** UTxO quỹ đọc từ chuỗi (lượng CARP trước nạp). */
  fundIn: UTxO;
  /** UTxO bên tài trợ đọc từ chuỗi. */
  sponsorIn: UTxO[];
  /** Địa chỉ chung của `sponsorIn` (đã qua `assertSponsorUtxosPinned`). */
  sponsorAddress: string;
  carpAmount: bigint;
}

/**
 * Đọc lại output của fund-vault vừa dựng, so với GIÁ TRỊ ĐÃ GHIM + UTxO đọc từ chuỗi — không với thân bài:
 *   · ĐÚNG MỘT output mang tài sản dưới policy quỹ; nó ở địa chỉ quỹ, NFT của nó thuộc tập đã ghim, và
 *     CARP của nó tăng ĐÚNG `carp_amount` (≤ trần) so với UTxO quỹ vào;
 *   · ĐÚNG MỘT output ở địa chỉ bên tài trợ, giá trị TRỌN bằng `Σ sponsorIn − carp_amount` (ADA + mọi
 *     token, không chỉ CARP) — ví trả phí là địa chỉ khác nên không có phí nào để trừ;
 *   · không output nào khác mang CARP.
 * Lệch ⟹ 422 `SPONSOR_TX_MISMATCH`.
 */
export function assertFundPinnedOutputs(outs: SponsorTxOutput[], e: FundPinnedOutputsExpect): void {
  const bad = (reason: string, details: Record<string, unknown> = {}): never => { throw txMismatch("fund-vault", reason, details); };
  const fundOuts = outs.filter(o => Object.keys(o.assets).some(k => k !== "lovelace" && k.startsWith(e.fundScriptHash)));
  if (fundOuts.length !== 1) bad(`tx có ${fundOuts.length} output mang NFT quỹ, cần ĐÚNG 1.`);
  const fo = fundOuts[0]!;
  const fundNfts = Object.keys(fo.assets).filter(k => k !== "lovelace" && k.startsWith(e.fundScriptHash));
  if (fo.address !== e.fundAddress) bad(`output quỹ #${fo.index} không ở địa chỉ quỹ đã cấu hình.`, { index: fo.index });
  if (fundNfts.length !== 1 || (e.pins.fundUnits !== undefined && !e.pins.fundUnits.includes(fundNfts[0]!))
    || fo.assets[fundNfts[0]!] !== 1n
    || (e.fundIn.assets[fundNfts[0]!] ?? 0n) !== 1n) {
    // Vế cuối: NFT ra phải là NFT của chính UTxO quỹ đã chọn (quỹ của DID), không chỉ "một quỹ ghim nào đó".
    bad(`output quỹ #${fo.index} không mang đúng một NFT quỹ thuộc tập đã ghim.`, { index: fo.index });
  }
  const added = (fo.assets[e.carpUnit] ?? 0n) - (e.fundIn.assets[e.carpUnit] ?? 0n);
  if (added !== e.carpAmount || added <= 0n || added > e.pins.maxCarpAmount) {
    bad(`quỹ nhận ${added} CARP, cần đúng ${e.carpAmount} (trần ${e.pins.maxCarpAmount}).`, { index: fo.index });
  }

  const want: Assets = {};
  for (const u of e.sponsorIn) for (const [k, q] of Object.entries(u.assets)) want[k] = (want[k] ?? 0n) + q;
  want[e.carpUnit] = (want[e.carpUnit] ?? 0n) - e.carpAmount;
  if (want[e.carpUnit] === 0n) delete want[e.carpUnit];
  const changeOuts = outs.filter(o => o.address === e.sponsorAddress);
  if (changeOuts.length !== 1) bad(`tx có ${changeOuts.length} output về địa chỉ bên tài trợ, cần ĐÚNG 1.`);
  const co = changeOuts[0]!;
  const keys = new Set([...Object.keys(want), ...Object.keys(co.assets)]);
  for (const k of keys) {
    if ((co.assets[k] ?? 0n) !== (want[k] ?? 0n)) {
      bad(`phần thối bên tài trợ (#${co.index}) lệch giá trị vào − carp_amount ở tài sản ${k.slice(0, 20)}….`,
        { index: co.index, unit: k });
    }
  }
  for (const o of outs) {
    if (o.index === fo.index || o.index === co.index) continue;
    if ((o.assets[e.carpUnit] ?? 0n) !== 0n) bad(`output #${o.index} mang CARP — ngoài quỹ và phần thối bên tài trợ.`, { index: o.index });
  }
}

// ── đọc lại CBOR: đường `fee_payer` của hành trình tài trợ ──────────────────────

/**
 * Biên trên Σ min-UTxO của output script mà ví trả phí được ứng. Chỉ một chỗ đặt lovelace CAO hơn min-UTxO có chủ
 * đích: thread consume lúc đúc nhận sàn cố định 2 ADA (`ConsumeMAGIC/offchain/src/consume.ts` ▸
 * `assertEngageLovelace`, MINT-ENGAGE-004), trong khi min-UTxO của thread đo ≈1,2–1,56 ADA. Mọi output script mang
 * NFT + datum nội tuyến có min-UTxO > 1 ADA ⟹ phần vượt của thread < 1 ADA; mỗi tx tài trợ đúc nhiều nhất MỘT
 * thread (open-vault) ⟹ 1 ADA phủ trọn, và là phần ADA tối đa một lượt có thể rời ví trả phí ngoài min-UTxO.
 */
export const SPONSOR_FRONTING_SLACK_LOVELACE = 1_000_000n;

export interface SponsorFeePayerCheckContext extends FeeFlow {
  /** Lưới slot đọc `ttl` (`SponsorTxServiceDeps.slotNetwork`) — trường này chỉ dùng cho `checkValidTo`. */
  network: SlotNetwork;
  tipPosixMs: bigint;
  feePayer: FeePayerRequest;
  feePayerUtxo: UTxO;
  maxCollateralLovelace: bigint;
  /** Mọi input KHÁC UTxO trả phí, đọc từ chuỗi theo tham chiếu trong CBOR. */
  otherInputs: UTxO[];
  /** `coinsPerUtxoByte` của tham số giao thức — trần khoản ứng = Σ min-UTxO output script + `SPONSOR_FRONTING_SLACK_LOVELACE`. */
  coinsPerUtxoByte: bigint;
  /** Thưởng `did_stake` đã chốt trước khi dựng (`feePayer.ts` ▸ `planOwnerRewardReturn`). Có ⟹ output
   *  thưởng là output DUY NHẤT được nằm ngoài tập đóng ở vế (3), và không vào cân bằng vế (4). */
  ownerRewardReturn?: OwnerRewardReturn;
}

export interface SponsorFeePayerSummary {
  address: string;
  utxo: string;
  input_lovelace: string;
  fee_lovelace: string;
  change_lovelace: string;
  /** Min-ADA ví trả phí ứng cho output script của luồng (open-vault: két + thread). */
  fronted_lovelace: string;
  collateral_at_risk_lovelace: string;
  collateral_return_lovelace: string | null;
  valid_to_posix_ms: string;
  /** Có ⟺ chủ `did_stake` có thưởng > 0 đã chuyển về ví Phoenix của chủ — đọc lại TỪ CBOR. */
  owner_reward?: OwnerRewardSummary;
}

/**
 * Luật ví trả phí của `feePayer.ts` ▸ `checkFeePayerTx`, với MỘT vế nới và hai vế siết (khối đầu tệp):
 *   (1) input = UTxO trả phí + các UTxO ở `scriptAddresses ∪ passAddresses`, không gì khác — chủ két
 *       không góp UTxO nào, ví trả phí không góp UTxO thứ hai;
 *   (2) thế chấp: chỉ UTxO trả phí, có thể mất ≤ trần (`checkCollateral`, dùng chung);
 *   (3) output chỉ tới `fee_payer.address` (CHỈ ADA), `scriptAddresses`, `passAddresses`; cùng khoá
 *       ví trả phí mà khác địa chỉ ⟹ thối nhầm;
 *   (4) `passAddresses` nhận lại ĐÚNG lượng lovelace đã góp; ví trả phí góp = phí + thối + khoản ứng,
 *       với khoản ứng = Σ lovelace output script − Σ lovelace input script, ≥ 0;
 *   (5) hạn dùng ≤ 1 giờ (`checkValidTo`, dùng chung).
 * Có `ownerRewardReturn` ⟹ thêm vế thưởng dùng chung (`checkOwnerRewardReturn`): mục rút đúng R, ĐÚNG
 * MỘT output thuần ADA đúng R tới ví Phoenix của chủ; output đó ngoài tập đóng (3) và ngoài cân bằng (4)
 * — R vào từ mục rút, ra ở output đó, không qua ví trả phí.
 * Lệch ⟹ 422 `FEE_PAYER_TX_MISMATCH` (cùng mã với mọi đường dựng).
 */
export function checkSponsorFeePayerTx(txCbor: string, ctx: SponsorFeePayerCheckContext): SponsorFeePayerSummary {
  const fail = (m: string, d: Record<string, unknown> = {}) =>
    new CodedApiError(422, "FEE_PAYER_TX_MISMATCH", `giao dịch vừa dựng lệch luật ví trả phí: ${m}`, d);
  let body: CML.TransactionBody;
  try {
    body = CML.Transaction.from_cbor_hex(txCbor).body();
  } catch (e) {
    throw fail(`CBOR không giải mã được: ${(e as Error).message}`);
  }
  const keyOf = (a: string): string | null => {
    try {
      const c = getAddressDetails(a).paymentCredential;
      return c?.type === "Key" ? c.hash : null;
    } catch { return null; }
  };
  const feeKey = refStr(ctx.feePayer.utxoRef);
  const feeHash = keyOf(ctx.feePayer.address);
  if (feeHash === null) throw fail(`fee_payer.address không có phần thanh toán là khoá`);
  const scripts = new Set(ctx.scriptAddresses);
  const pass = new Set(ctx.passAddresses);

  // (1) input.
  const inputs = inputRefsOf(txCbor).map(refStr);
  if (!inputs.includes(feeKey)) throw fail(`UTxO trả phí ${feeKey} không phải input của giao dịch`);
  const resolved = new Map(ctx.otherInputs.map(u => [refStr(u), u]));
  let scriptIn = 0n;
  let passIn = 0n;
  for (const k of inputs) {
    if (k === feeKey) continue;
    const u = resolved.get(k);
    if (u === undefined) throw fail(`input ${k} không đối chiếu được với chuỗi`, { input: k });
    if (keyOf(u.address) === feeHash) {
      throw fail(`input ${k} cũng thuộc ví trả phí — bên trả phí chỉ cho tiêu ĐÚNG MỘT UTxO`, { input: k });
    }
    if (scripts.has(u.address)) scriptIn += u.assets.lovelace ?? 0n;
    else if (pass.has(u.address)) passIn += u.assets.lovelace ?? 0n;
    else throw fail(`input ${k} ở ${u.address} — ngoài UTxO trả phí và các UTxO của luồng (chủ két không góp UTxO cho phí)`, { input: k });
  }

  // (2) thế chấp.
  const { atRisk, collateralReturn } = checkCollateral(
    body, feeKey, ctx.feePayerUtxo, ctx.feePayer.address, ctx.maxCollateralLovelace, fail);

  // (3) output. Output thưởng did_stake (nếu có) đối chiếu riêng, rồi bỏ khỏi tập đóng và khỏi cân bằng.
  const rewardIndex = ctx.ownerRewardReturn === undefined
    ? undefined
    : checkOwnerRewardReturn(body, ctx.ownerRewardReturn, fail);
  const ol = body.outputs();
  let change = 0n;
  let scriptOut = 0n;
  let scriptMin = 0n;
  let passOut = 0n;
  for (let i = 0; i < ol.len(); i++) {
    if (i === rewardIndex) continue;
    const o = ol.get(i);
    const addr = o.address().to_bech32(undefined);
    const a = valueToAssets(o.amount());
    if (addr === ctx.feePayer.address) {
      if (Object.keys(a).some(u => u !== "lovelace" && a[u] !== 0n)) {
        throw fail(`output #${i} về ví trả phí mang token — tài sản của chủ két hay bên tài trợ không được thối sang đó`, { output_index: i });
      }
      change += a.lovelace ?? 0n;
    } else if (scripts.has(addr)) {
      // Trước phép "cùng khoá khác địa chỉ": địa chỉ của luồng do DỊCH VỤ ghim (claim: beneficiary là địa chỉ enterprise
      // của ví phí Feecover, cùng khoá với UTxO trả phí ở địa chỉ base). Ở các bước khác các địa chỉ này là script.
      scriptOut += a.lovelace ?? 0n;
      scriptMin += CML.min_ada_required(o, ctx.coinsPerUtxoByte);
    } else if (keyOf(addr) === feeHash) {
      throw fail(`output #${i} về ${addr}: cùng khoá với ví trả phí nhưng KHÔNG phải fee_payer.address`, { output_index: i });
    } else if (pass.has(addr)) {
      passOut += a.lovelace ?? 0n;
    } else {
      throw fail(`output #${i} tới ${addr} — ngoài ví trả phí và các địa chỉ của luồng`, { output_index: i });
    }
  }

  // (4) ADA.
  if (passOut !== passIn) {
    throw fail(`bên tài trợ góp ${passIn} lovelace nhưng nhận lại ${passOut} — ADA của ví trả phí không được chảy sang đó`);
  }
  const fronted = scriptOut - scriptIn;
  const fee = body.fee();
  const feeIn = ctx.feePayerUtxo.assets.lovelace ?? 0n;
  if (fronted < 0n || feeIn !== fee + change + fronted) {
    throw fail(`ví trả phí góp ${feeIn} lovelace nhưng phí ${fee} + thối ${change} + ứng min-ADA ${fronted} ` +
      `(Σ output script ${scriptOut} − Σ input script ${scriptIn}) không khớp — có lượng ADA đi chỗ khác hoặc từ chỗ khác tới`);
  }
  // Trần khoản ứng: chỉ min-UTxO của output script (+ biên). Không trần thì bất kỳ lovelace nào bộ dựng đặt vào
  // output script (vd. thread mà chủ đóng lại được) là ADA của ví trả phí chuyển sang tay chủ.
  const frontedCap = scriptMin + SPONSOR_FRONTING_SLACK_LOVELACE;
  if (fronted > frontedCap) {
    throw new CodedApiError(422, "FEE_PAYER_FRONTING_ABOVE_MAX",
      `Ví trả phí phải ứng ${fronted} lovelace cho output script, vượt Σ min-UTxO ${scriptMin} + biên ` +
      `${SPONSOR_FRONTING_SLACK_LOVELACE} — bên trả phí chỉ ứng min-ADA.`,
      { fronted_lovelace: raw(fronted), fronted_max_lovelace: raw(frontedCap), script_min_utxo_lovelace: raw(scriptMin) });
  }

  // (5) hạn dùng.
  const validTo = checkValidTo(body, ctx.network, ctx.tipPosixMs, fail);

  return {
    address: ctx.feePayer.address,
    utxo: feeKey,
    input_lovelace: raw(feeIn),
    fee_lovelace: raw(fee),
    change_lovelace: raw(change),
    fronted_lovelace: raw(fronted),
    collateral_at_risk_lovelace: raw(atRisk),
    collateral_return_lovelace: collateralReturn === null ? null : raw(collateralReturn),
    valid_to_posix_ms: raw(validTo),
    ...(ctx.ownerRewardReturn === undefined || rewardIndex === undefined
      ? {} : { owner_reward: ownerRewardSummaryOf(ctx.ownerRewardReturn, rewardIndex) }),
  };
}

function scriptsMismatch(reason: string, details: Record<string, unknown>): CodedApiError {
  return new CodedApiError(501, "SPONSOR_PREPAID_SCRIPTS_MISMATCH",
    `Bộ script Prepaid của dịch vụ lệch cấu hình: ${reason}`, details);
}

function txMismatch(step: SponsorStep, reason: string, details: Record<string, unknown>): CodedApiError {
  return new CodedApiError(422, "SPONSOR_TX_MISMATCH", `${step}: ${reason}`, { step, ...details });
}

function noWalletUtxo(address: string, qualifier: string): TxBuildRejectedError {
  return new TxBuildRejectedError(
    `Ví trả phí ${address.slice(0, 20)}… không có UTxO nào${qualifier === "" ? "" : ` ${qualifier}`} để trả phí và làm ` +
    `tài sản thế chấp.`, { change_address: address });
}

function scriptOfRef(u: UTxO | undefined, what: string): Script {
  if (u === undefined || u.scriptRef === undefined || u.scriptRef === null) {
    throw new ChainUnavailableError(`UTxO script tham chiếu của ${what} không mang scriptRef.`, { what });
  }
  return u.scriptRef;
}

/** Bech32 (đã kiểm ở cấu hình) → địa chỉ Plutus của datum quỹ. Địa chỉ con trỏ không có ở cấu hình ⟹ NÉM. */
function plutusAddressOf(bech32: string): PlutusAddress {
  const d = getAddressDetails(bech32);
  const cred = (c: { type: "Key" | "Script"; hash: string }) =>
    c.type === "Key" ? { VerificationKey: [c.hash] as [string] } : { Script: [c.hash] as [string] };
  if (d.paymentCredential === undefined) throw new Error(`[bất biến nội bộ] địa chỉ ${bech32} không có phần thanh toán.`);
  return {
    payment_credential: cred(d.paymentCredential),
    stake_credential: d.stakeCredential === undefined ? null : { Inline: [cred(d.stakeCredential)] },
  };
}

/**
 * Lúc khởi động (`server.ts`): địa chỉ enterprise của khoá platform có giữ UTxO không. Ba trạng thái: `null` = 0 UTxO;
 * chuỗi cảnh báo = có UTxO; chuỗi "KHÔNG ĐO ĐƯỢC" = đọc chuỗi hỏng. Không từ chối khởi động (lý do ở `server.ts`).
 */
export async function platformAddressFundedWarning(chain: ChainReader, network: Network, pkh: string): Promise<string | null> {
  const address = enterpriseAddressOf(network, pkh);
  let n: number;
  try {
    n = (await chain.utxosAt(address)).length;
  } catch (e) {
    return `[platform] ⚠ KHÔNG ĐO ĐƯỢC số UTxO ở địa chỉ enterprise của khoá platform ${address}: ` +
      `${e instanceof Error ? e.message : String(e)} — kiểm tay; khoá platform không được giữ UTxO.`;
  }
  if (n === 0) return null;
  return `[platform] ⚠ địa chỉ enterprise của khoá platform ${address} đang giữ ${n} UTxO. Khoá platform không phải ví: ` +
    `chuyển chúng đi. Dịch vụ không tiêu chúng (422 SPONSOR_FEE_WALLET_IS_PLATFORM; hàm ký từ chối input của khoá này), ` +
    `nhưng người giữ khoá thì tiêu được. Địa chỉ base mang cùng khoá không đo được từ đây.`;
}

function requiredSignersOf(txCbor: string): string[] {
  const rs = CML.Transaction.from_cbor_hex(txCbor).body().required_signers();
  const out: string[] = [];
  for (let i = 0; rs !== undefined && i < rs.len(); i++) out.push(rs.get(i).to_hex());
  return out;
}

/**
 * Vai ký theo thứ tự `planSponsorJourney`: fund-vault = ví trả phí · bên tài trợ (khoá trong datum quỹ) · chủ;
 * open-fund = ví trả phí · platform · chủ; open-vault chở genesis quỹ = ví trả phí · chủ · platform; còn lại = ví
 * trả phí · chủ. Vai platform luôn `how: "service"`: dịch vụ đã ký, witness nằm sẵn trong `tx_cbor`.
 */
function signersFor(step: SponsorStep, ctx: StepCtx, sponsorSigners: string[], platformSigners: string[]): SponsorSigner[] {
  const fee: SponsorSigner = ctx.feePayer === undefined
    ? { role: "fee-wallet", keyHashes: [ctx.feeKeyHash], how: `ví khoá ${ctx.feeAddress}: phí + thế chấp + tiền thừa` }
    : {
        role: "fee-wallet", keyHashes: [ctx.feeKeyHash],
        how: `fee_payer ${ctx.feeAddress}: chi đúng UTxO ${refStr(ctx.feePayer.req.utxoRef)} — phí + thế chấp` +
          `${step === "open-vault" ? ` + min-ADA két và thread${platformSigners.length > 0 ? " và quỹ" : ""}` : step === "open-fund" ? " + min-ADA quỹ" : ""}` +
          `; tiền thối ADA về lại địa chỉ đó`,
      };
  const platform: SponsorSigner = { role: "platform", keyHashes: platformSigners, how: "service" };
  const owner: SponsorSigner = ctx.owner.type === "key"
    ? { role: "owner", keyHashes: [ctx.owner.hash], how: `chữ ký khoá ${ctx.owner.hash}` }
    : {
        role: "owner", keyHashes: ctx.witness?.requiredSigners ?? [],
        how: `một mục rút Script(${ctx.owner.hash}) (did_stake: controller + thiết bị ký)`,
      };
  // Chủ KÝ open-fund (#161): vai platform do dịch vụ ký sẵn, chủ ký thêm như mọi bước khác.
  if (step === "open-fund") return [fee, platform, owner];
  if (step === "open-vault" && platformSigners.length > 0) return [fee, owner, platform];
  if (step !== "fund-vault") return [fee, owner];
  return [fee, { role: "sponsor", keyHashes: sponsorSigners, how: "chi các UTxO CARP đã đưa trong sponsor.utxo_refs" }, owner];
}

/**
 * Bộ định tuyến của `/tx/sponsor/*` (http.ts gọi sau khi đã kiểm thẻ bài + POST + thân JSON).
 * `plan` thuần, chạy cả khi dịch vụ tài trợ vắng; bốn bước còn lại cần `svc`.
 */
export async function sponsorRoute(
  path: string, body: Record<string, unknown>, svc: SponsorTxService | undefined,
): Promise<Record<string, unknown>> {
  if (path === "/tx/sponsor/plan") {
    const parsed = ownerReq(body);
    if (!isDidOwner(parsed.owner)) return sponsorPlanBody(body);
    if (svc === undefined) {
      throw new CodedApiError(501, "OWNER_SCRIPT_WITNESS_UNAVAILABLE",
        `Chủ "did" cần dịch vụ tài trợ để suy Script(did_stake) từ anchor; dịch vụ này chưa bật hành trình ` +
        `tài trợ. Gửi chủ script tường minh.`);
    }
    const r = await svc.resolveOwner(parsed);
    return sponsorPlanBody(body, { owner: r.owner, ...(r.ownerDid === undefined ? {} : { ownerDid: r.ownerDid }) });
  }
  const step = SPONSOR_STEP_OF_PATH[path];
  if (step === undefined) {
    throw new CodedApiError(404, "NOT_FOUND", `Không có đường "${path}".`,
      { known: ["/tx/sponsor/plan", ...Object.keys(SPONSOR_STEP_OF_PATH)] });
  }
  if (svc === undefined) {
    throw new CodedApiError(501, "SPONSOR_UNAVAILABLE",
      `Dịch vụ này chưa bật hành trình tài trợ (bản deploy không phục vụ két ${PREPAID_VAULT_TYPE}, hoặc thiếu ` +
      `blueprint PrepaidGen).`, { step });
  }
  switch (step) {
    case "open-vault": return toSponsorBody(await svc.openVault(parseSponsorRequest("open-vault", body)));
    case "bind-did": return toSponsorBody(await svc.bindDid(parseSponsorRequest("bind-did", body)));
    case "open-fund": return toSponsorBody(await svc.openFund(parseSponsorRequest("open-fund", body)));
    case "fund-vault": return toSponsorBody(await svc.fundVault(parseSponsorRequest("fund-vault", body)));
    case "draw-magic": return toSponsorBody(await svc.drawMagic(parseSponsorRequest("draw-magic", body)));
    case "first-consume": return toSponsorBody(await svc.firstConsume(parseSponsorRequest("first-consume", body)));
    case "claim": return toSponsorBody(await svc.claimFund(parseSponsorRequest("claim", body)));
  }
}
